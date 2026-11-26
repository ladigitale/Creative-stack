import { LitElement, css, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { isFrameSource } from "../../shared/mediaRef";
import { OneEuro } from "../../shared/ml/one-euro";
import { cosine, decodeReference, type DecodedReference } from "./core/reference";
import type { EngineResult } from "./core/engine";
import { EngineRunner } from "./runner";
import type { Pt } from "./core/homography";
import { rectify, type Rectified } from "./core/rectify";
import { steadyCorners, type Corners } from "./core/steady";
import { grabGray, resolveSource, upFromOrientation } from "./frame";
import { quatFromOrientation, rotateCorners, type Quat } from "./core/gyro";

export type AnchorStatus = "idle" | "searching" | "tracking" | "holding" | "error";

export type AnchorState = {
  status: AnchorStatus;
  error: string | null;
  /** La zone est visible (suivie, ou gardée quelques images après une perte). */
  found: boolean;
  /** Id de la référence trouvée (ou son index si elle n'a pas d'id). */
  refId: string | null;
  index: number;
  /** Coins de la zone (haut-gauche, haut-droit, bas-droit, bas-gauche) en 0..1 de l'image source. */
  corners: Pt[] | null;
  /** Taille de l'image source (pour caler un affichage au même cadrage). */
  width: number;
  height: number;
  matches: number;
  inliers: number;
  confidence: number;
  /** Rotation (degrés, sens horaire) de la zone par rapport à la prise de référence. */
  rotation: number | null;
  /** Durée de la dernière analyse (ms) et analyses par seconde. */
  ms: number;
  fps: number;
  references: number;
  /** Numéro (`frameSeq` de la source) de l'image analysée : `sonic-frame-sync sync="<id>"` montre cette image exacte. */
  frameSeq: number;
  /** Délai entre la prise de cette image et la publication (ms). */
  latencyMs: number;
  /** `detect` (appariement complet) ou `track` (suivi par flot optique, bien plus léger). */
  mode: "detect" | "track" | "none";
  /** Où tourne l'analyse : `worker` ou `main` (repli). */
  engine: "worker" | "main";
  /** Compteur : +1 chaque fois qu'une balise apparaît (aucune avant, ou une autre) ; `trigger` d'un son. */
  foundCount: number;
  /** Références essayées (après le filtre `within`). */
  candidates: number;
  /** Champs de l'entrée trouvée, sans sa référence (message, effet, auteur…). */
  item: Record<string, unknown> | null;
  /** Coins prédits par le gyroscope (zone perdue de vue, téléphone qui tourne), pas mesurés dans l'image. */
  gyro: boolean;
  /** Ressemblance globale (cosinus d'empreintes) de la meilleure candidate, si `embedding`. */
  similarity: number | null;
  /**
   * Dernière prise de vue (commande `capture`) : la zone suivie vue de face dans l'image en couleur, plus
   * `capture-pad` fois sa taille autour (JPEG data:), avec `refId` et `seq` ; `{error}` si la zone était perdue.
   */
  capture: (Rectified & { refId: string | null; seq: number; steady?: boolean }) | { error: string; seq: number } | null;
};

const IDLE: AnchorState = {
  status: "idle", error: null, found: false, refId: null, index: -1, corners: null, width: 0, height: 0,
  matches: 0, inliers: 0, confidence: 0, rotation: null, ms: 0, fps: 0, references: 0,
  candidates: 0, item: null, similarity: null, gyro: false, frameSeq: -1, latencyMs: 0, mode: "none", engine: "main", foundCount: 0, capture: null,
};

/**
 * Retrouve une zone photographiée (référence de `sonic-anchor-ref`) dans l'image d'une source en direct.
 *
 * - `source` : `#id` de `sonic-camera` (ou toute source d'images).
 * - `reference` (DP) : une référence, ou une liste ; chaque élément est une référence ou une entrée
 *   `{id, ref, …}` (sortie `save` de `sonic-anchor-ref`) dont les autres champs sont publiés dans `item` quand
 *   elle est trouvée. La dernière trouvée est essayée en premier, puis une autre à chaque analyse.
 * - `within` (DP) : restreint aux ids listés (`["a", "b"]`, `[{id}]`, ou l'état de `sonic-geolocation` dont
 *   `nearby` est lu) ; liste vide ou absente = toutes.
 * - `embedding` (DP de sortie d'un `sonic-image-embedder` sur la caméra) : les candidates sont essayées par
 *   ressemblance globale décroissante (les `top` premières plus souvent).
 * - `gravity` (DP) : état de `sonic-orientation` (capteurs actifs) ; écarte les solutions dont la rotation
 *   contredit l'inclinaison du téléphone (tolérance `gravity-tolerance` degrés, 0 = sans filtre).
 * - `active` ou `control` `{ start, stop, capture }` (capture : la zone suivie prise de face dans `capture`
 *   de l'état, avec `capture-pad` fois sa taille autour, `capture-size` px au plus) ; analyse au plus toutes les `interval` ms, image réduite à `max-size`.
 * - `smoothing` 0..0.9 lisse les coins ; `hold` garde la dernière position quelques analyses après une perte.
 * - Renfort gyroscope (avec `gravity`, capteurs de `sonic-orientation` actifs) : zone perdue de vue, sa position
 *   est prédite par la rotation du téléphone depuis le dernier repérage pendant `gyro-hold` ms (1500 ; 0 = sans),
 *   champ de vision horizontal de la caméra `fov` (63°). État `gyro: true` tant que les coins sont prédits. La prédiction
 *   utilise l'orientation au moment de la prise de chaque image analysée et porte son `frameSeq` (calée sur la vidéo
 *   de `sonic-frame-sync`).
 * - État `<id>State` (ou `out-data-provider`) : voir `AnchorState`. `debug` dessine la zone trouvée.
 * - Synchronisation image / contenu : l'état porte `frameSeq` et `latencyMs` de l'image analysée ; afficher la
 *   caméra à travers `sonic-frame-sync for="cam" sync="<id>State"` (puis un `sonic-shader channel0`) pour que le
 *   contenu projeté tombe exactement sur l'image où la zone a été trouvée.
 */
/** Surfaces de remplacement lues par entrée (`refs`), les plus récentes. */
export const MAX_EXTRA_REFS = 4;

@customElement("sonic-anchor")
export class SonicAnchor extends LitElement {
  static styles = css`
    :host { display: block; position: absolute; inset: 0; pointer-events: none; }
    :host(:not([debug])) { display: none; }
    svg { width: 100%; height: 100%; display: block; }
  `;

  @property({ type: String }) source = "";
  @property({ type: String }) reference = "";
  @property({ type: String }) gravity = "";
  @property({ type: Number, attribute: "gravity-tolerance" }) gravityTolerance = 45;
  @property({ type: Boolean }) active = false;
  @property({ type: String }) control = "";
  /** Prise de vue (`capture`) : marge autour de la zone, en fois sa taille de chaque côté (0..2). */
  @property({ type: Number, attribute: "capture-pad" }) capturePad = 1;
  /** Prise de vue : plus grand côté en px (256..2048). */
  @property({ type: Number, attribute: "capture-size" }) captureSize = 1440;
  /** Intervalle minimal entre deux analyses en recherche (ms) ; une zone suivie est analysée à chaque image. */
  @property({ type: Number }) interval = 90;
  /** Analyse sur le fil principal (sans worker). */
  @property({ type: Boolean, attribute: "no-worker" }) noWorker = false;
  @property({ type: Number, attribute: "max-size" }) maxSize = 480;
  @property({ type: Number, attribute: "max-points" }) maxPoints = 700;
  @property({ type: Number, attribute: "min-inliers" }) minInliers = 14;
  @property({ type: Number }) smoothing = 0.5;
  @property({ type: Number }) hold = 4;
  /** Renfort gyroscope : durée (ms) pendant laquelle la zone perdue est suivie par la rotation du téléphone (0 = sans). */
  @property({ type: Number, attribute: "gyro-hold" }) gyroHold = 1500;
  /** Champ de vision horizontal de la caméra (degrés), pour le renfort gyroscope. */
  @property({ type: Number }) fov = 63;
  @property({ type: String }) within = "";
  @property({ type: String }) embedding = "";
  /** Candidates les plus ressemblantes essayées en priorité (avec `embedding`). */
  @property({ type: Number }) top = 3;
  @property({ type: Boolean, reflect: true }) debug = false;
  @property({ type: String }) fit: "contain" | "cover" = "cover";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  @state() private view: AnchorState = { ...IDLE };

  stateValue: AnchorState = { ...IDLE };
  private refs: Array<{ id: string | null; ref: DecodedReference; meta: Record<string, unknown> | null }> = [];
  private onlyIds: Set<string> | null = null;
  private rawRefs: unknown[] = [];
  private vector: number[] | null = null;
  private up: Pt | null = null;
  /** Orientation courante du téléphone (renfort gyroscope), `null` sans capteurs. */
  private orient: Quat | null = null;
  /** Dernier repérage réussi : orientation, coins (0..1), instant, proportions de l'image. */
  private gyroRef: { q: Quat; corners: Pt[]; at: number; aspect: number } | null = null;
  /** Mesures récentes des capteurs, horodatées : l'orientation au moment où une image a été prise. */
  private orientHistory: { t: number; q: Quat }[] = [];
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubs: Array<() => void> = [];
  private startT = new CounterTrigger();
  private captureT = new CounterTrigger();
  private stopT = new CounterTrigger();
  private lastSeq = -1;
  private current = -1;
  private cursor = 0;
  private misses = 0;
  private smoothed: Pt[] | null = null;
  /**
   * Prise de vue en attente : chaque image analysée est gardée en couleur avec les coins mesurés DESSUS (sans
   * lissage) ; on prend la photo quand la zone ne bouge plus (3 mesures concordantes), sinon au bout de 1,5 s.
   */
  private pendingCapture: { seq: number; t0: number; shots: { frame: HTMLCanvasElement; corners: Corners; refId: string | null }[] } | null = null;
  /** Copie couleur de l'image en cours d'analyse (seulement pendant une prise de vue). */
  private analysedColor: HTMLCanvasElement | null = null;
  private filters: OneEuro[] = [];
  private foundCount = 0;
  private runner: EngineRunner | null = null;
  private times: number[] = [];

  connectedCallback(): void {
    super.connectedCallback();
    this.publish({ ...IDLE });
    if (this.active) this.start();
  }

  disconnectedCallback(): void {
    this.stop();
    this.runner?.dispose();
    this.runner = null;
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("reference") || c.has("gravity") || c.has("control") || c.has("within") || c.has("embedding")) this.listen();
    if (c.has("active")) { if (this.active) this.start(); else if (c.get("active") !== undefined) this.stop(); }
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.startT.reset(); this.stopT.reset(); this.captureT.reset();
    if (this.reference) this.unsubs.push(listenDp(this.reference, (v) => this.setReferences(plain(v))));
    if (this.gravity) this.unsubs.push(listenDp(this.gravity, (v) => {
      this.up = upFromOrientation(v);
      this.orient = quatFromOrientation(v);
      if (this.orient) {
        const t = performance.now();
        this.orientHistory.push({ t, q: this.orient });
        while (this.orientHistory.length > 2 && t - this.orientHistory[0].t > 2000) this.orientHistory.shift();
      }
    }));
    if (this.within) this.unsubs.push(listenDp(this.within, (v) => { this.onlyIds = idSet(plain(v)); }));
    if (this.embedding) this.unsubs.push(listenDp(this.embedding, (v) => {
      const vec = (v as { vector?: unknown } | null)?.vector;
      this.vector = Array.isArray(vec) && vec.length ? (plain(vec) as number[]) : null;
    }));
    if (this.control) this.unsubs.push(listenDp(this.control, (v) => {
      const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      if (this.startT.feed(o.start)) this.start();
      if (this.stopT.feed(o.stop)) this.stop();
      if (this.captureT.feed(o.capture)) this.capture();
    }));
  }

  /**
   * Prise de vue de la zone suivie, redressée de face (commande `capture` de `control`) : publiée dans
   * `capture` de l'état. Pour dessiner ensuite sur le mur tel qu'il est, calé sur la zone.
   */
  capture(): void {
    const seq = ((this.stateValue.capture?.seq) ?? 0) + 1;
    if (this.running) {
      // Photo calée sur l'image même où la zone a été mesurée, une fois la zone immobile (voir handle).
      this.pendingCapture = { seq, t0: performance.now(), shots: [] };
      return;
    }
    const s = this.stateValue;
    const el = resolveSource(this, this.source) as (Element & { getFrameCanvas?: () => HTMLCanvasElement | null }) | null;
    const frame = el?.getFrameCanvas?.() ?? null;
    const shot = s.found && s.corners && frame ? rectify(frame, s.corners, this.capturePad, Math.max(256, Math.min(2048, this.captureSize))) : null;
    this.publish({ ...this.stateValue, capture: shot ? { ...shot, refId: s.refId, seq } : { error: s.found ? "prise de vue impossible" : "vise le mur pour le prendre en photo", seq } });
  }

  /** Remplace les références (une ou une liste). */
  setReferences(v: unknown): void {
    const list = Array.isArray(v) ? v : v ? [v] : [];
    this.refs = [];
    this.rawRefs = [];
    list.forEach((r, i) => {
      const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      const wrapped = o.ref && typeof o.ref === "object";
      const d = decodeReference(wrapped ? o.ref : r);
      if (!d) return;
      const id = typeof o.id === "string" ? o.id : String(i);
      let meta: Record<string, unknown> | null = null;
      if (wrapped) {
        meta = { ...o };
        delete meta.ref;
      }
      this.refs.push({ id, ref: d, meta });
      this.rawRefs.push(wrapped ? o.ref : r);
      // Surfaces de remplacement (lieu repeint, affiche changée…) : `refs` de l'entrée, mêmes id et contenu.
      if (wrapped && Array.isArray(o.refs)) {
        for (const extra of o.refs.slice(-MAX_EXTRA_REFS)) {
          const e = decodeReference(extra);
          if (!e) continue;
          this.refs.push({ id, ref: e, meta });
          this.rawRefs.push(extra);
        }
      }
    });
    this.current = -1;
    this.cursor = 0;
    this.smoothed = null;
    this.engineRunner().setReferences(this.rawRefs);
    const bad = list.filter((r) => !decodeReference(r && typeof r === "object" && (r as Record<string, unknown>).ref && typeof (r as Record<string, unknown>).ref === "object" ? (r as Record<string, unknown>).ref : r)).length;
    this.publish({ ...this.stateValue, references: new Set(this.refs.map((r) => r.id)).size, error: bad ? `${bad} référence(s) illisible(s) ignorée(s)` : null });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.publish({ ...this.stateValue, status: "searching", error: null });
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.smoothed = null;
    this.runner?.reset();
    this.publish({ ...IDLE, references: new Set(this.refs.map((r) => r.id)).size });
  }

  private engineRunner(): EngineRunner {
    this.runner ??= new EngineRunner(!this.noWorker);
    return this.runner;
  }

  private loop = (): void => {
    if (!this.running) return;
    const t0 = performance.now();
    this.step().catch((e) => {
      this.publish({ ...this.stateValue, status: "error", error: e instanceof Error ? e.message : "échec de l'analyse" });
    }).finally(() => {
      if (!this.running) return;
      this.settleCapture();
      const spent = performance.now() - t0;
      // Zone suivie : à chaque nouvelle image (le suivi est léger). Recherche : au rythme de `interval`.
      const wait = this.current >= 0 ? 8 : Math.max(16, this.interval) - spent;
      this.timer = setTimeout(this.loop, Math.max(8, wait));
    });
  };

  /** Une analyse (public pour les tests) : saisie de l'image ici, calcul dans le worker. */
  async step(): Promise<void> {
    if (!this.refs.length) return;
    const el = resolveSource(this, this.source);
    if (!el || !isFrameSource(el)) return;
    if (el.frameSeq === this.lastSeq) return;
    const runner = this.engineRunner();
    if (runner.busy) return;
    const grabbedAt = performance.now();
    const grab = grabGray(el, this.maxSize);
    if (!grab) return;
    this.analysedColor = this.pendingCapture ? copyColor(el, Math.max(256, Math.min(2048, this.captureSize)) * (1 + 2 * Math.max(0, Math.min(2, Number(this.capturePad) || 0)))) : null;
    // Lu après la copie : getFrameCanvas() peut avoir avancé la source d'une image.
    const seq = el.frameSeq;
    this.lastSeq = seq;
    const { width, height } = grab.gray;
    const r = await runner.process(grab.gray, {
      order: this.order(), up: this.up, gravityTolerance: this.gravityTolerance,
      minInliers: this.minInliers, maxPoints: this.maxPoints,
    });
    if (!this.running) return;
    this.handle(r, seq, grabbedAt, width, height, runner.engine);
    this.settleCapture();
  }

  private handle(r: EngineResult, seq: number, grabbedAt: number, width: number, height: number, engine: "worker" | "main"): void {
    const now = performance.now();
    this.times.push(now);
    while (this.times.length > 1 && now - this.times[0] > 2000) this.times.shift();
    const fps = this.times.length > 1 ? Math.round(((this.times.length - 1) * 1000) / (now - this.times[0]) * 10) / 10 : 0;
    if (r.found && r.corners && r.index !== this.current) this.foundCount++;
    const base = {
      width, height, ms: Math.round(r.ms), fps, references: new Set(this.refs.map((r) => r.id)).size, error: null,
      candidates: new Set(this.pool().map((i) => this.refs[i].id)).size, similarity: this.bestSimilarity,
      frameSeq: seq, latencyMs: Math.round(now - grabbedAt), mode: r.mode, engine, foundCount: this.foundCount, capture: this.stateValue.capture,
    };
    if (r.found && r.corners) {
      this.misses = 0;
      const norm = r.corners.map((p) => ({ x: p.x / width, y: p.y / height }));
      if (this.pendingCapture && this.analysedColor) {
        this.pendingCapture.shots.push({ frame: this.analysedColor, corners: norm, refId: this.refs[r.index]?.id ?? null });
        if (this.pendingCapture.shots.length > 6) this.pendingCapture.shots.shift();
      }
      if (r.index !== this.current || !this.smoothed || jump(this.smoothed, norm) > 0.15 || this.smoothing <= 0) {
        this.filters = [];
        this.smoothed = norm;
      }
      // One Euro : presque immobile = très lissé, mouvement rapide = sans retard.
      if (this.smoothing > 0) {
        if (!this.filters.length) this.filters = Array.from({ length: 8 }, () => new OneEuro(Math.max(0.05, 2.5 * (1 - this.smoothing)), 30));
        this.smoothed = norm.map((p, k) => ({ x: this.filters[k * 2].filter(p.x, now), y: this.filters[k * 2 + 1].filter(p.y, now) }));
      }
      this.current = r.index;
      // orientation au moment de la prise de cette image (pas celle de maintenant : l'image affichée est en retard)
      const qShot = this.orientAt(grabbedAt);
      if (qShot) this.gyroRef = { q: qShot, corners: this.smoothed, at: grabbedAt, aspect: width / Math.max(1, height) };
      const entry = this.refs[r.index];
      this.publish({
        ...base, status: "tracking", gyro: false, found: true, refId: entry?.id ?? null, index: r.index, item: entry?.meta ?? null,
        corners: this.smoothed.map((p) => ({ x: r4(p.x), y: r4(p.y) })),
        matches: r.matches, inliers: r.inliers, confidence: r.confidence,
        rotation: r.rotation === null ? null : Math.round(r.rotation),
      });
      return;
    }
    this.misses++;
    const predicted = this.gyroPrediction(grabbedAt);
    if (predicted && this.current >= 0) {
      // Zone perdue de vue mais téléphone suivi : position prédite par sa rotation au moment de la prise de CETTE image,
      // publiée avec son numéro (sonic-frame-sync montre la même image : contenu et vidéo restent calés).
      this.publish({ ...this.stateValue, ...base, status: "holding", found: true, gyro: true, corners: predicted, matches: r.matches, inliers: r.inliers });
      return;
    }
    if (this.smoothed && this.misses <= Math.max(0, this.hold)) {
      // La position gardée appartient à l'image du dernier succès : on garde son numéro.
      this.publish({ ...this.stateValue, ...base, frameSeq: this.stateValue.frameSeq, latencyMs: this.stateValue.latencyMs, status: "holding", matches: r.matches, inliers: r.inliers });
      return;
    }
    this.current = -1;
    this.smoothed = null;
    this.filters = [];
    this.gyroRef = null;
    this.publish({ ...IDLE, ...base, status: "searching", matches: r.matches, inliers: r.inliers });
  }

  /** Orientation mesurée au plus près avant l'instant `t` (prise d'une image), `null` sans capteurs. */
  private orientAt(t: number): Quat | null {
    const h = this.orientHistory;
    if (!h.length) return null;
    let best = h[0];
    for (const s of h) {
      if (s.t <= t) best = s;
      else break;
    }
    return best.q;
  }

  /** Coins prédits pour l'image prise à l'instant `t`, par la rotation du téléphone depuis le dernier repérage. */
  private gyroPrediction(t: number): Pt[] | null {
    const ref = this.gyroRef;
    const q = this.orientAt(t);
    if (!ref || !q || !(this.gyroHold > 0) || t - ref.at > this.gyroHold) return null;
    const c = rotateCorners(ref.corners, ref.q, q, Number(this.fov) || 63, ref.aspect);
    // la zone sortie loin du cadre n'a plus de sens
    if (!c || c.some((p) => p.x < -1 || p.x > 2 || p.y < -1 || p.y > 2)) return null;
    return c.map((p) => ({ x: r4(p.x), y: r4(p.y) }));
  }

  /** Prise de vue en attente : photo dès que la zone est immobile, ou la dernière mesure au bout de 1,5 s. */
  private settleCapture(): void {
    const p = this.pendingCapture;
    if (!p) return;
    const shots = p.shots;
    // Une seule surface : les mesures d'une autre référence ne se mélangent pas.
    const same = shots.filter((s) => s.refId === shots[shots.length - 1]?.refId);
    const steady = steadyCorners(same.map((s) => s.corners));
    const late = performance.now() - p.t0 > 1500;
    if (!steady && !late) return;
    this.pendingCapture = null;
    this.analysedColor = null;
    const side = Math.max(256, Math.min(2048, this.captureSize));
    const last = same[same.length - 1];
    const shot = steady ? rectify(same[steady.index].frame, steady.corners, this.capturePad, side) : last ? rectify(last.frame, last.corners, this.capturePad, side) : null;
    this.publish({ ...this.stateValue, capture: shot ? { ...shot, refId: last?.refId ?? null, seq: p.seq, steady: !!steady } : { error: last ? "prise de vue impossible" : "vise le mur pour le prendre en photo", seq: p.seq } });
  }

  private bestSimilarity: number | null = null;

  /** Ids des références essayables (après `within`), dans l'ordre de la liste. */
  candidateIds(): Array<string | null> {
    return [...new Set(this.pool().map((i) => this.refs[i].id))];
  }

  /** Indices des références autorisées par `within`. */
  private pool(): number[] {
    const out: number[] = [];
    const only = this.onlyIds;
    // Une entrée sans position (prise sans GPS) n'est jamais écartée par le filtre de proximité.
    this.refs.forEach((r, i) => {
      const located = typeof r.meta?.lat === "number" || typeof r.ref.geo?.lat === "number";
      if (!only || !only.size || !located || (r.id !== null && only.has(r.id))) out.push(i);
    });
    return out;
  }

  /** Références à essayer à cette analyse : la courante, puis une candidate (par ressemblance si possible). */
  private order(): number[] {
    const pool = this.pool();
    if (!pool.length) return [];
    const out: number[] = [];
    if (this.current >= 0 && pool.includes(this.current)) out.push(this.current);
    let ranked = pool;
    this.bestSimilarity = null;
    if (this.vector) {
      const v = this.vector;
      const scored = pool.map((i) => ({ i, s: this.refs[i].ref.embedding ? cosine(v, this.refs[i].ref.embedding) : -2 }));
      scored.sort((a, b) => b.s - a.s);
      ranked = scored.map((x) => x.i);
      if (scored[0].s > -2) this.bestSimilarity = Math.round(scored[0].s * 1000) / 1000;
      // Les `top` plus ressemblantes deux fois sur trois, le reste à tour de rôle.
      const k = Math.max(1, Math.min(ranked.length, this.top));
      const c = this.cursor++;
      const pick = c % 3 !== 2 || ranked.length <= k ? ranked[(c >> 0) % k] : ranked[k + (c % (ranked.length - k))];
      if (!out.includes(pick)) out.push(pick);
      return out;
    }
    const pick = ranked[this.cursor++ % ranked.length];
    if (!out.includes(pick)) out.push(pick);
    return out;
  }

  private publish(s: AnchorState): void {
    this.stateValue = s;
    if (this.debug) this.view = s;
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, s);
    this.dispatchEvent(new CustomEvent("anchor-state", { detail: s, bubbles: true, composed: true }));
  }

  render() {
    const s = this.view;
    if (!this.debug || !s.corners || !s.width) return nothing;
    const pts = s.corners.map((p) => `${p.x * s.width},${p.y * s.height}`).join(" ");
    const sw = Math.max(1, s.width / 200);
    return svg`<svg viewBox="0 0 ${s.width} ${s.height}" preserveAspectRatio=${this.fit === "contain" ? "xMidYMid meet" : "xMidYMid slice"}>
      <polygon points=${pts} fill="none" stroke=${s.status === "tracking" ? "#3ddc97" : "#f5c400"} stroke-width=${sw * 2} stroke-linejoin="round"></polygon>
      <circle cx=${s.corners[0].x * s.width} cy=${s.corners[0].y * s.height} r=${sw * 4} fill="#3ddc97"></circle>
    </svg>`;
  }
}

/** Ids depuis `["a"]`, `[{id}]` ou un état `{nearby: [{id}]}` ; `null` = pas de filtre. */
function idSet(v: unknown): Set<string> | null {
  const list = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { nearby?: unknown }).nearby) ? (v as { nearby: unknown[] }).nearby : null;
  if (!list) return null;
  const out = new Set<string>();
  for (const x of list) {
    if (typeof x === "string") out.add(x);
    else if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") out.add((x as { id: string }).id);
  }
  return out;
}

function jump(a: Pt[], b: Pt[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  return m;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Copie couleur de l'image courante d'une source (côté long `maxSide` au plus), pour la prise de vue. */
function copyColor(el: Element, maxSide: number): HTMLCanvasElement | null {
  const src = (el as Element & { getFrameCanvas?: () => HTMLCanvasElement | null }).getFrameCanvas?.() ?? null;
  if (!src || !src.width || !src.height) return null;
  const k = Math.min(1, Math.min(4096, maxSide) / Math.max(src.width, src.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * k));
  c.height = Math.max(1, Math.round(src.height * k));
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
