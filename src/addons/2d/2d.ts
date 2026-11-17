import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { HTML, PublisherManager } from "@supersoniks/concorde/utils";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { Monde2d } from "./monde";
import { Monde2dRenderer } from "./monde2d";
import { monde2dSummary, readMonde2d, type Monde2d as Monde2dData } from "../../shared/monde2d/format";
import type { Layer } from "./model";
import { hash32 } from "../../shared/monde/math";
import { mondeSummary, readMonde, type Conflict, type Monde } from "../../shared/monde/format";
import type { PlacedInfo } from "../../shared/monde/arrange";
import { listenTurn, wrapAngle } from "../../shared/monde/turn-keys";
import { TAP_MAX_MOVE_PX, TAP_MAX_MS, easeCurve, isNum, namesRegex, type NodeCurve } from "../../shared/nodes";
import { MAX_SPRITES, defaultCamera, parseLayers, parseSprite, readCamera, type Camera, type SpriteSpec } from "./model";
import { Scene2D } from "./scene";
import "./elements";

const tagName = "sonic-2d";

type Publisher = {
  get(): unknown;
  onAssign(handler: (v: unknown) => void, directHandlerCall?: boolean): void;
  offAssign(handler: (v: unknown) => void): void;
  onInternalMutation(handler: VoidFunction): void;
  offInternalMutation(handler: VoidFunction): void;
};

type CamTween = { from: Camera; to: Camera; start: number; ms: number; curve: NodeCurve };

function reducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Scène 2D / 2.5D rendue par PixiJS (WebGL), pilotée par données comme `sonic-3d` :
 * - sprites : enfants `sonic-sprite` et/ou liste en DataProvider (`sprites="jeu.decor"`) ;
 * - mouvement : clé `nodes` du DataProvider (format partagé, src/shared/nodes.ts) ;
 * - caméra : clé `camera` {x, y, zoom, ease} ; calques à parallaxe (`layers`) ;
 * - taps : `{type: "pick", payload: {objectId, x, y}}` vers `target`.
 * Rendu à la demande : aucune boucle quand rien ne bouge.
 */
@customElement(tagName)
export class Sonic2d extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      aspect-ratio: var(--sonic-2d-ar, 16 / 9);
      overflow: hidden;
      touch-action: manipulation;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    .anchor {
      position: absolute;
      left: 0;
      top: 0;
      z-index: 2;
      width: 0;
      height: 0;
      pointer-events: none;
    }
    .anchor[hidden] {
      display: none;
    }
    .bubble {
      position: absolute;
      left: 0;
      bottom: 10px;
      transform: translateX(-50%);
      pointer-events: auto;
      white-space: nowrap;
    }
    .msg {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      font: 0.9rem system-ui, sans-serif;
      opacity: 0.7;
    }
  `;

  @property({ type: String }) dataProvider = "";
  @property({ type: Number }) width = 800;
  @property({ type: Number }) height = 450;
  @property({ type: String }) background = "";
  /** Calques du fond vers l'avant : `"ciel:0 decor:0.4 monde:1:y hud:0"` (nom:parallaxe[:y]). */
  @property({ type: String }) layers = "";
  /** Chemin DataProvider de la caméra {x, y, zoom, ease} (défaut : clé `camera` du dataProvider). */
  @property({ type: String }) camera = "";
  /** Chemin DataProvider d'une liste de sprites (mêmes clés que sonic-sprite). */
  @property({ type: String }) sprites = "";
  @property({ type: String }) target = "";
  @property({ type: String, attribute: "pick-action-type" }) pickActionType = "";
  @property({ type: String, attribute: "pick-names" }) pickNames = "";
  @property({ type: Boolean, attribute: "pick-empty" }) pickEmpty = false;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  @property({ type: Number, attribute: "max-dpr" }) maxDpr = 2;
  /** Contrôle visuel des maillages : `bones` (os de repos et courants), `mesh` (quadrillage déformé, sommets colorés par l'os dominant), `all`. */
  @property({ type: String }) debug = "";
  /** Monde décrit en primitives (JSON, voir monde.md) ; aussi clé `monde` du dataProvider. */
  @property({ type: String }) monde = "";
  /** Calque du monde (défaut : `monde`, sinon le calque de premier plan). */
  @property({ type: String, attribute: "monde-layer" }) mondeLayer = "";

  /** Monde 2D natif (formes vectorielles, calques) ; aussi clé `monde2d` du dataProvider. */
  @property({ type: String }) monde2d = "";
  /**
   * Glisser les instances d'un `monde` : regex des noms déplaçables (`".*"` : toutes). L'objet suit le pointeur, rangé
   * à chaque instant (appui, aimantation, collisions) ; R / Maj+R, Q / E ou la molette le tournent pendant le geste.
   * Au lâcher, `target` reçoit `{type: "place", payload}` et la sortie publie `placed`.
   */
  @property({ type: String }) drag = "";
  /**
   * Avec `drag` : seule l'instance sélectionnée se déplace (clé `selection` du DataProvider, contour bleu) ; un tap
   * sélectionne (action `pick` avec `instance`).
   */
  @property({ type: Boolean, attribute: "drag-selected" }) dragSelected = false;
  /** Avec `drag` : l'objet garde son cap (pas de rotation automatique dos au mur) ; R, Q / E ou la molette le tournent. */
  @property({ type: Boolean, attribute: "keep-heading" }) keepHeading = false;
  private selectedName = "";

  private m2: Monde2dRenderer | null = null;
  private m2Ref: unknown = undefined;
  private m2Sig = "";
  private m2Parsed: Monde2dData | null = null;
  private mondeR: Monde2d | null = null;
  private mondeRef: unknown = undefined;
  private mondeSig = "";
  private mondeParsed: Monde | null = null;
  private mondePatch = new Map<string, string>();
  /** Glisser en cours : instance, dernier point (px de la scène), cap voulu (après une rotation), dernier résultat. */
  private dragging: { name: string; id: number; sx: number; sy: number; ry: number | undefined; last: PlacedInfo | null; stop: () => void } | null = null;
  private placedOut: PlacedInfo | null = null;
  private contactOut: Record<string, unknown> | null = null;
  /** Émetteurs : dernières touches, état publié, derniers ordres `emit` appliqués. */
  private hitsOut: Record<string, unknown> | null = null;
  private emitOut: Record<string, unknown> | null = null;
  private lastEmitJson = "";
  private lastFxJson = "";
  private lastQueriesJson = "";
  private queriesOut: Record<string, unknown> | null = null;
  private infiniOut: Record<string, unknown> | null = null;
  /** Conflits recalculés depuis la lecture du monde (après un rangement). */
  private liveConflicts: Conflict[] | null = null;

  private scene: Scene2D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private publisher: Publisher | null = null;
  private unsubs: Array<() => void> = [];
  private observer: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private childOwned = new Set<string>();
  private listOwned = new Set<string>();
  private listSpecs: SpriteSpec[] = [];
  private childErrors: string[] = [];
  private listErrors: string[] = [];
  private layerErrors: string[] = [];
  private status: "loading" | "ready" | "error" = "loading";
  private error = "";
  private raf = 0;
  private dirty = false;
  private camTween: CamTween | null = null;
  private cam: Camera = defaultCamera(800, 450);
  private camSig = "";
  private tap: { x: number; y: number; t: number } | null = null;
  private lastOut = "";
  private resyncQueued = false;

  /** Pour les tests et l'atelier. */
  get runtime(): Scene2D | null {
    return this.scene;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.observer = new MutationObserver(() => this.queueResync());
    this.observer.observe(this, { childList: true, subtree: true, attributes: true });
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  disconnectedCallback(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.unbind();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.mondeR?.destroy();
    this.mondeR = null;
    this.m2?.destroy();
    this.m2 = null;
    this.scene?.destroy();
    this.scene = null;
    super.disconnectedCallback();
  }

  render() {
    return html`<canvas part="canvas"></canvas><div class="anchor" part="selection-anchor" data-overlay hidden><div class="bubble"><slot name="selection"></slot></div></div>${this.status === "error" ? html`<div class="msg">${this.error}</div>` : null}`;
  }

  /** Bulle de la sélection : le slot `selection` suit l'objet sélectionné (comme sonic-3d). */
  private placeAnchor(): void {
    const el = this.renderRoot.querySelector<HTMLElement>(".anchor");
    const top = this.mondeR?.selectionTop() ?? null;
    if (!el) return;
    if (!top || !this.canvas) {
      el.hidden = true;
      return;
    }
    // pixels de la scène → pixels CSS de l'élément (le canvas peut être réduit par la mise en page)
    const k = this.canvas.clientWidth / (this.width || 1);
    el.hidden = false;
    el.style.transform = `translate(${Math.round(top.x * k + this.canvas.offsetLeft)}px, ${Math.round(top.y * k + this.canvas.offsetTop)}px)`;
  }

  /** Contrat `SonicFrameSource` : `sonic-shader channel0="#id"` lit la scène (sprites, calques, caméra) comme texture. Incrémenté après chaque rendu. */
  frameSeq = 0;
  getFrameCanvas(): HTMLCanvasElement | null {
    return this.scene?.isReady ? this.canvas : null;
  }

  protected firstUpdated(): void {
    this.canvas = this.renderRoot.querySelector("canvas");
    this.addEventListener("pointerdown", this.onDown);
    this.addEventListener("pointerup", this.onUp);
    this.addEventListener("pointermove", this.onMove);
    this.resizeObserver = new ResizeObserver(() => this.syncSize());
    this.resizeObserver.observe(this);
    void this.build();
  }

  protected updated(changed: PropertyValues): void {
    this.style.setProperty("--sonic-2d-ar", `${this.width} / ${this.height}`);
    if (!this.scene) return;
    if ((changed.has("width") || changed.has("height") || changed.has("background")) && changed.get("width") !== undefined) {
      void this.build();
      return;
    }
    if (changed.has("layers")) this.applyLayers();
    if (changed.has("debug")) this.scene.setDebug(this.debug);
    if (changed.has("dataProvider")) this.bind();
    if (changed.has("sprites") || changed.has("camera")) this.listen();
    if (changed.has("monde")) this.syncMonde((this.publisher?.get() as Record<string, unknown> | null)?.monde);
    if (changed.has("mondeLayer") && this.mondeR) this.scene.attachExtra(this.mondeR.container, this.mondeLayer || "monde");
    if (changed.has("monde2d")) this.syncMonde2d((this.publisher?.get() as Record<string, unknown> | null)?.monde2d);
  }

  /* ------------------------------------------------------------ construction */

  private async build(): Promise<void> {
    if (!this.canvas) return;
    this.mondeR?.destroy();
    this.mondeR = null;
    this.m2?.destroy();
    this.m2 = null;
    this.scene?.destroy();
    // Un canvas WebGL ne se réutilise pas d'un contexte à l'autre : on le remplace.
    const fresh = document.createElement("canvas");
    fresh.setAttribute("part", "canvas");
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    this.childOwned = new Set();
    this.listOwned = new Set();
    const scene = new Scene2D({
      canvas: fresh,
      width: Math.max(10, this.width),
      height: Math.max(10, this.height),
      background: this.background,
      resolution: this.dpr(),
      // Police du conteneur : l'hôte impose system-ui à ses propres libellés.
      font: this.parentElement ? getComputedStyle(this.parentElement).fontFamily || undefined : undefined,
      invalidate: () => this.invalidate(),
      lookup: (id) => {
        const root = this.getRootNode();
        const inRoot = root instanceof Document || root instanceof ShadowRoot ? root.getElementById(id) : null;
        return inRoot ?? document.getElementById(id);
      },
    });
    this.scene = scene;
    this.status = "loading";
    this.publishOut();
    try {
      await scene.init();
      // pixi impose `touch-action: none` au canvas : la scène 2D ne fait que des taps, on laisse l'hôte décider
      // (manipulation par défaut : la page défile ; `style="touch-action:none"` sur sonic-2d pour un jeu).
      fresh.style.touchAction = "inherit";
    } catch (err) {
      if (this.scene !== scene) return;
      this.status = "error";
      this.error = `Rendu 2D indisponible (WebGL) : ${err instanceof Error ? err.message : String(err)}`;
      this.scene = null;
      this.requestUpdate();
      this.publishOut();
      return;
    }
    if (this.scene !== scene) return;
    this.cam = defaultCamera(this.width, this.height);
    this.camSig = "";
    this.applyLayers();
    scene.setDebug(this.debug);
    this.m2 = new Monde2dRenderer(
      () => this.invalidate(),
      (c, layer) => scene.attachExtra(c, layer),
      () => [this.width, this.height],
    );
    this.m2Ref = undefined;
    this.m2Sig = "";
    this.syncMonde2d((this.publisher?.get() as Record<string, unknown> | null)?.monde2d);
    this.mondeR = new Monde2d(() => this.invalidate());
    this.mondeR.onPlaced = (info) => {
      this.placedOut = info;
      this.publishOut();
    };
    this.mondeR.onContact = (c) => {
      this.contactOut = { ...c, t: Date.now() };
      this.publishOut();
    };
    this.mondeR.onHits = (hits) => {
      const payload = { hits: hits.slice(0, 64), t: Date.now() };
      if (this.target) { const target = this.target; setTimeout(() => dispatch(target, { type: "hit", payload }), 0); }
      this.dispatchEvent(new CustomEvent("monde-hit", { detail: payload, bubbles: true, composed: true }));
      this.hitsOut = payload;
      this.publishOut();
    };
    this.mondeR.onExpire = (e) => {
      if (this.target) { const target = this.target; setTimeout(() => dispatch(target, { type: "expire", payload: e }), 0); }
    };
    this.mondeR.onInfiniState = (st) => {
      this.infiniOut = st;
      this.publishOut();
    };
    this.mondeR.infini.onEnter = (e) => {
      if (this.target) { const target = this.target; setTimeout(() => dispatch(target, { type: "tileEnter", payload: e }), 0); }
    };
    this.mondeR.onQueries = (r) => {
      this.queriesOut = { ...(this.queriesOut ?? {}), ...r };
      this.publishOut();
    };
    this.mondeR.onSensor = (e) => {
      const { type, ...payload } = e;
      if (this.target) { const target = this.target; setTimeout(() => dispatch(target, { type, payload }), 0); }
      this.dispatchEvent(new CustomEvent(`monde-${type}`, { detail: payload, bubbles: true, composed: true }));
    };
    this.mondeR.onEmitStats = (st) => {
      this.emitOut = st;
      this.publishOut();
    };
    this.mondeR.onConflicts = (c) => {
      this.liveConflicts = c;
      this.publishOut();
    };
    scene.attachExtra(this.mondeR.container, this.mondeLayer || "monde");
    this.mondeRef = undefined;
    this.mondeSig = "";
    this.mondePatch.clear();
    this.syncMonde((this.publisher?.get() as Record<string, unknown> | null)?.monde);
    this.syncSize();
    this.resync();
    this.listen();
    this.bind();
    this.status = "ready";
    this.publishOut();
    this.invalidate();
  }

  private dpr(): number {
    return Math.max(1, Math.min(this.maxDpr || 2, window.devicePixelRatio || 1));
  }

  private syncSize(): void {
    if (!this.scene?.isReady) return;
    const w = this.clientWidth || this.width;
    this.scene.resize(w, this.dpr());
    this.invalidate();
  }

  private applyLayers(): void {
    if (!this.scene) return;
    const { layers, errors } = parseLayers(this.layers);
    this.layerErrors = errors;
    this.scene.setLayers(layers);
  }

  /* ------------------------------------------------------------ sprites */

  private queueResync(): void {
    if (this.resyncQueued) return;
    this.resyncQueued = true;
    queueMicrotask(() => {
      this.resyncQueued = false;
      this.resync();
    });
  }

  /** Sprites déclarés en enfants `sonic-sprite`. */
  private resync(): void {
    const scene = this.scene;
    if (!scene?.isReady) return;
    const errors: string[] = [];
    const specs: SpriteSpec[] = [];
    const names = new Set<string>();
    let i = 0;
    for (const el of this.querySelectorAll("sonic-sprite")) {
      const attrs = Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
      const { spec, errors: e } = parseSprite(attrs, `sprite${++i}`);
      errors.push(...e);
      if (names.has(spec.name)) errors.push(`sprite "${spec.name}" déclaré deux fois`);
      names.add(spec.name);
      specs.push(spec);
    }
    this.childErrors = errors;
    this.childOwned = scene.syncSet(this.childOwned, specs);
    this.publishOut();
  }

  /** Liste de sprites en DataProvider (ajouts et retraits suivis). */
  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    const camPath = this.camera.trim();
    if (camPath) {
      this.unsubs.push(
        listenDp(camPath, (v) => {
          const animate = !reducedMotion() && document.visibilityState !== "hidden";
          this.applyCameraSpec(v, performance.now(), animate);
          this.invalidate();
        }),
      );
      try {
        const cur = (PublisherManager.get(camPath) as unknown as Publisher).get();
        if (cur && typeof cur === "object" && Object.keys(cur).length) this.applyCameraSpec(JSON.parse(JSON.stringify(cur)), performance.now(), false);
      } catch {
        /* pas encore de valeur */
      }
    }
    const path = this.sprites.trim();
    if (!path) {
      if (this.scene && this.listOwned.size) this.listOwned = this.scene.syncSet(this.listOwned, []);
      return;
    }
    this.unsubs.push(
      listenDp(path, (v) => {
        const list = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as object) : [];
        const errors: string[] = [];
        const specs: SpriteSpec[] = [];
        if (list.length > MAX_SPRITES) errors.push(`sprites : ${list.length} éléments, ${MAX_SPRITES} au plus`);
        list.slice(0, MAX_SPRITES).forEach((raw, k) => {
          if (!raw || typeof raw !== "object") return;
          const { spec, errors: e } = parseSprite(raw as Record<string, unknown>, `item${k}`);
          errors.push(...e);
          if (this.childOwned.has(spec.name)) errors.push(`"${spec.name}" existe déjà (enfant sonic-sprite)`);
          else specs.push(spec);
        });
        this.listSpecs = specs;
        this.listErrors = errors;
        if (this.scene?.isReady) this.listOwned = this.scene.syncSet(this.listOwned, specs);
        this.publishOut();
      }),
    );
  }

  /* ------------------------------------------------------------ nodes + caméra */

  private onData = () => {
    const scene = this.scene;
    if (!scene?.isReady) return;
    const data = this.publisher?.get() as Record<string, unknown> | null | undefined;
    if (!data || typeof data !== "object") return;
    const animate = !reducedMotion() && document.visibilityState !== "hidden";
    const now = performance.now();
    if (data.monde !== undefined) this.syncMonde(data.monde);
    this.syncSelection(data.selection);
    if (data.monde2d !== undefined) this.syncMonde2d(data.monde2d);
    if (data.nodes !== undefined) {
      let nodes: unknown = data.nodes;
      if (this.m2?.instanceCount) nodes = this.routeNodes2(nodes, now, animate);
      if (this.mondeR?.instanceCount) nodes = this.routeNodes(nodes, now, animate);
      scene.nodes.apply(nodes, now, animate);
    }
    if (data.emit !== undefined && this.mondeR) {
      // ordres d'émetteurs : salve à chaque hausse de `n` (voir shared/sim/set.ts)
      let json = "";
      try {
        json = JSON.stringify(data.emit);
      } catch {
        /* ignoré */
      }
      if (json && json !== this.lastEmitJson) {
        this.lastEmitJson = json;
        if (this.mondeR.applyEmit(JSON.parse(json))) this.mondeBusy = true;
      }
    }
    if (data.tiles !== undefined && this.mondeR) this.mondeR.applyTiles(JSON.parse(JSON.stringify(data.tiles)));
    if (data.queries !== undefined && this.mondeR) {
      let json = "";
      try {
        json = JSON.stringify(data.queries);
      } catch {
        /* ignoré */
      }
      if (json && json !== this.lastQueriesJson) {
        this.lastQueriesJson = json;
        this.mondeR.applyQueries(JSON.parse(json));
        this.mondeBusy = true;
      }
    }
    if (data.fx !== undefined && this.mondeR) {
      // salves de particules : une à chaque hausse de `n` (voir shared/sim/particle-set.ts)
      let json = "";
      try {
        json = JSON.stringify(data.fx);
      } catch {
        /* ignoré */
      }
      if (json && json !== this.lastFxJson) {
        this.lastFxJson = json;
        if (this.mondeR.applyParticles(JSON.parse(json))) this.mondeBusy = true;
      }
    }
    if (data.rest !== undefined || data.bones !== undefined) scene.setSkeleton(data.rest, data.bones);
    if (data.camera !== undefined && !this.camera.trim()) this.applyCameraSpec(data.camera, now, animate);
    this.publishOut();
    this.invalidate();
  };

  /** Monde : lecture (attribut ou DP), reconstruction si le JSON a changé (modèles inchangés réutilisés). */
  /** Clé `selection` : instance sélectionnée (contour ; seule déplaçable avec `drag-selected`). */
  private syncSelection(raw: unknown): void {
    const v = raw != null && typeof raw === "object" ? (raw as { valueOf: () => unknown }).valueOf() : raw;
    const name = typeof v === "string" ? v : "";
    if (name === this.selectedName) return;
    this.selectedName = name;
    this.mondeR?.select(name);
    this.invalidate();
  }

  private syncMonde(dp: unknown): void {
    const r = this.mondeR;
    if (!r) return;
    let src: unknown = dp;
    let bad = false;
    if (!src && this.monde.trim()) {
      try {
        src = JSON.parse(this.monde);
      } catch {
        src = { invalide: this.monde.length };
        bad = true;
      }
    }
    // pas de court-circuit sur la référence : une écriture imbriquée modifie l'objet en place
    this.mondeRef = src;
    const sig = src ? String(hash32(JSON.stringify(src))) : "";
    if (sig === this.mondeSig) return;
    this.mondeSig = sig;
    this.mondePatch.clear();
    if (!src) {
      this.mondeParsed = null;
      r.clear();
      return;
    }
    this.mondeParsed = readMonde(src, this.mondeParsed);
    this.liveConflicts = null;
    if (bad) this.mondeParsed.issues.push({ path: "", message: "attribut monde : JSON invalide" });
    try {
      r.set(this.mondeParsed, performance.now());
    } catch (err) {
      // un monde ne doit jamais bloquer le composant (sprites, nodes, taps continuent)
      this.mondeParsed.issues.push({ path: "", message: `rendu 2D : ${err instanceof Error ? err.message : String(err)}` });
      r.clear();
    }
    this.publishOut();
    // les nodes déjà publiés valent aussi pour les instances neuves
    const data = this.publisher?.get() as Record<string, unknown> | null | undefined;
    if (data?.nodes && typeof data.nodes === "object") this.routeNodes(data.nodes, performance.now(), false);
  }

  /** Monde 2D natif : lecture, calques (si l'attribut `layers` est vide), reconstruction si le JSON a changé. */
  private syncMonde2d(dp: unknown): void {
    const r = this.m2;
    const scene = this.scene;
    if (!r || !scene) return;
    let src: unknown = dp;
    let bad = false;
    if (!src && this.monde2d.trim()) {
      try {
        src = JSON.parse(this.monde2d);
      } catch {
        src = { invalide: this.monde2d.length };
        bad = true;
      }
    }
    if (src === this.m2Ref) return;
    this.m2Ref = src;
    const sig = src ? String(hash32(JSON.stringify(src))) : "";
    if (sig === this.m2Sig) return;
    this.m2Sig = sig;
    this.m2Patch.clear();
    if (!src) {
      this.m2Parsed = null;
      this.m2Info = null;
      r.clear();
      if (!this.layers.trim()) this.applyLayers();
      this.publishOut();
      return;
    }
    const m = readMonde2d(src, this.m2Parsed);
    this.m2Parsed = m;
    this.m2Info = null;
    if (bad) m.issues.push({ path: "", message: "attribut monde2d : JSON invalide" });
    if (!this.layers.trim()) {
      if (!m.layers.length) this.applyLayers();
    }
    if (m.layers.length && !this.layers.trim()) {
      const layers: Layer[] = m.layers.map((l) => ({ name: l.name, parallax: Math.max(0, l.parallax), sortY: l.ysort }));
      scene.setLayers(layers);
    }
    r.sky.zIndex = -1e9;
    scene.attachExtra(r.sky, m.layers[0]?.name ?? "monde");
    try {
      r.set(m, performance.now());
    } catch (err) {
      m.issues.push({ path: "", message: `rendu monde2d : ${err instanceof Error ? err.message : String(err)}` });
      r.clear();
      this.m2Info = null;
    }
    this.publishOut();
    const data = this.publisher?.get() as Record<string, unknown> | null | undefined;
    if (data?.nodes && typeof data.nodes === "object") this.routeNodes2(data.nodes, performance.now(), false);
  }

  private m2Patch = new Map<string, string>();
  private m2Info: ReturnType<typeof monde2dSummary> | null = null;

  private routeNodes2(nodes: unknown, now: number, animate: boolean): unknown {
    const r = this.m2;
    if (!r || !nodes || typeof nodes !== "object") return nodes;
    const rest: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(nodes as Record<string, unknown>)) {
      if (!r.has(name)) {
        rest[name] = p;
        continue;
      }
      const sig = JSON.stringify(p);
      if (this.m2Patch.get(name) === sig) continue;
      this.m2Patch.set(name, sig);
      r.apply(name, p, now, animate);
    }
    return rest;
  }

  /** Envoie au monde les patchs de ses instances et pièces (une seule fois par valeur) ; renvoie le reste. */
  private routeNodes(nodes: unknown, now: number, animate: boolean): unknown {
    const r = this.mondeR;
    if (!r || !nodes || typeof nodes !== "object") return nodes;
    const rest: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(nodes as Record<string, unknown>)) {
      if (!r.has(name)) {
        rest[name] = p;
        continue;
      }
      const sig = JSON.stringify(p);
      if (this.mondePatch.get(name) === sig) continue;
      this.mondePatch.set(name, sig);
      // `collide` : ramené au point atteint sans traverser d'obstacle
      r.apply(name, r.guard(name, p), now, animate);
    }
    return rest;
  }

  private applyCameraSpec(v: unknown, now: number, animate: boolean): void {
    const sig = JSON.stringify(v);
    if (sig === this.camSig) return;
    this.camSig = sig;
    const to = readCamera(v, this.cam);
    const ease = (v as { ease?: { ms?: number; curve?: NodeCurve } } | null)?.ease;
    if (animate && ease && isNum(ease.ms) && ease.ms > 0) {
      this.camTween = { from: { ...this.cam }, to, start: now, ms: ease.ms, curve: ease.curve ?? "linear" };
    } else {
      this.camTween = null;
      this.cam = to;
      this.scene?.setCamera(to);
    }
  }

  private bind(): void {
    this.unbind();
    const id = this.dataProvider.trim() || HTML.getAncestorAttributeValue(this.parentElement, "dataProvider") || "";
    if (!id) return;
    const pub = PublisherManager.get(id) as unknown as Publisher;
    this.publisher = pub;
    pub.onAssign(this.onData, false);
    pub.onInternalMutation(this.onData);
    this.onData();
  }

  private unbind(): void {
    if (!this.publisher) return;
    this.publisher.offAssign(this.onData);
    this.publisher.offInternalMutation(this.onData);
    this.publisher = null;
  }

  /* ------------------------------------------------------------ rendu à la demande */

  private invalidate(): void {
    this.dirty = true;
    // Pendant une image, la fin de `frame` décide de la suivante (sinon les boucles se multiplient).
    if (!this.raf && !this.inFrame) this.raf = requestAnimationFrame(this.frame);
  }

  private inFrame = false;

  private frame = (now: number) => {
    this.raf = 0;
    const scene = this.scene;
    if (!scene?.isReady) return;
    this.inFrame = true;
    try {
      this.drawFrame(scene, now);
    } finally {
      this.inFrame = false;
    }
    // Une source d'images vivante (sprite `source`) demande une image par rafraîchissement ; sinon : rendu à la demande.
    if (this.dirty || scene.nodes.active || this.camTween || scene.hasLive || this.mondeBusy) this.raf = requestAnimationFrame(this.frame);
  };

  private mondeBusy = false;

  private drawFrame(scene: Scene2D, now: number): void {
    let busy = scene.nodes.step(now);
    if (this.mondeR || this.m2) {
      const a = this.mondeR ? this.mondeR.step(now) : false;
      const b = this.m2 ? this.m2.step(now) : false;
      this.mondeBusy = a || b;
      busy = busy || this.mondeBusy;
    }
    if (this.camTween) {
      const t = this.camTween;
      const k = Math.min(1, Math.max(0, (now - t.start) / t.ms));
      const e = easeCurve(t.curve, k);
      this.cam = {
        x: t.from.x + (t.to.x - t.from.x) * e,
        y: t.from.y + (t.to.y - t.from.y) * e,
        zoom: t.from.zoom + (t.to.zoom - t.from.zoom) * e,
      };
      scene.setCamera(this.cam);
      if (k >= 1) this.camTween = null;
      else busy = true;
    }
    if (scene.hasLive && scene.refreshLive()) this.dirty = true;
    if (this.dirty || busy) {
      this.dirty = false;
      scene.render();
      this.placeAnchor();
      this.frameSeq++;
    }
  }

  private onVisibility = () => {
    if (document.visibilityState !== "hidden" || !this.scene) return;
    this.scene.nodes.finish();
    if (this.camTween) {
      this.cam = this.camTween.to;
      this.scene.setCamera(this.cam);
      this.camTween = null;
    }
  };

  /* ------------------------------------------------------------ sortie */

  private publishOut(): void {
    const out = this.outDataProvider.trim();
    if (!out) return;
    const scene = this.scene;
    const next = {
      status: this.status,
      error: this.error,
      count: scene?.count ?? 0,
      missing: scene?.nodes.missing ?? 0,
      errors: [...this.layerErrors, ...this.childErrors, ...this.listErrors],
      ...(this.mondeParsed ? { mondeInfo: this.mondeInfo(this.mondeParsed) } : {}),
      ...(this.placedOut ? { placed: this.placedOut } : {}),
      ...(this.contactOut ? { contact: this.contactOut } : {}),
      ...(this.hitsOut ? { hits: this.hitsOut } : {}),
      ...(this.emitOut ? { emitters: this.emitOut } : {}),
      ...(this.queriesOut ? { queries: this.queriesOut } : {}),
      ...(this.infiniOut ? { infini: this.infiniOut } : {}),
      ...(this.m2Parsed ? { monde2dInfo: this.m2Info ?? (this.m2Info = monde2dSummary(this.m2Parsed)) } : {}),
    };
    const sig = JSON.stringify(next);
    if (sig === this.lastOut) return;
    this.lastOut = sig;
    set(out, next);
  }

  /** Résumé du monde ; conflits recalculés après un rangement s'il y en a eu un. */
  private mondeInfo(m: Monde): Record<string, unknown> {
    const sum = mondeSummary(m) as Record<string, unknown>;
    if (this.liveConflicts) {
      delete sum.conflicts;
      if (this.liveConflicts.length) sum.conflicts = this.liveConflicts.slice(0, 50);
    }
    return sum;
  }

  /* ------------------------------------------------------------ taps */

  /** Point du pointeur en px de la scène. */
  private scenePoint(e: PointerEvent): [number, number] {
    const rect = this.getBoundingClientRect();
    const k = rect.width / this.width || 1;
    return [(e.clientX - rect.left) / k, (e.clientY - rect.top) / k];
  }

  private onDown = (e: PointerEvent) => {
    // la bulle de sélection (slot `selection`) n'est pas la scène
    if (e.composedPath().some((n) => n instanceof HTMLElement && n.hasAttribute("data-overlay"))) {
      this.tap = null;
      return;
    }
    if (e.button !== 0) return;
    this.tap = { x: e.clientX, y: e.clientY, t: performance.now() };
    const r = this.mondeR, scene = this.scene;
    if (!this.drag || !r?.instanceCount || !scene?.isReady || this.dragging) return;
    const [sx, sy] = this.scenePoint(e);
    const [lx, ly] = scene.layerPoint(this.mondeLayer || "monde", sx, sy);
    let name = r.grab(lx, ly, this.drag);
    // drag-selected : l'objet sous le doigt doit être le sélectionné
    if (this.dragSelected && (!this.selectedName || name !== this.selectedName)) name = "";
    if (!name) return;
    const state = { name, id: e.pointerId, sx, sy, ry: (this.keepHeading ? r.driver.instances.get(name)?.t.ry : undefined) as number | undefined, last: null as PlacedInfo | null, stop: () => {} };
    state.stop = listenTurn(this, (d) => {
      const t = this.mondeR?.driver.instances.get(name)?.t;
      state.ry = wrapAngle((state.ry ?? t?.ry ?? 0) + d);
      this.moveDrag();
    });
    this.dragging = state;
    try {
      this.setPointerCapture(e.pointerId);
    } catch {
      /* pointeur déjà relâché */
    }
  };

  private onMove = (e: PointerEvent) => {
    const d = this.dragging;
    if (!d || e.pointerId !== d.id) return;
    // un tap qui tremble n'est pas un glisser : l'objet ne part qu'au-delà de quelques pixels
    if (!d.last && this.tap && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) < 4) return;
    [d.sx, d.sy] = this.scenePoint(e);
    this.moveDrag();
  };

  private moveDrag(): void {
    const d = this.dragging, r = this.mondeR, scene = this.scene;
    if (!d || !r || !scene) return;
    const [lx, ly] = scene.layerPoint(this.mondeLayer || "monde", d.sx, d.sy);
    const res = r.dragTo(d.name, lx, ly, performance.now(), d.ry);
    if (res) d.last = res;
    this.invalidate();
  }

  private onUp = (e: PointerEvent) => {
    if (!this.dragging && e.composedPath().some((n) => n instanceof HTMLElement && n.hasAttribute("data-overlay"))) return;
    const drag = this.dragging;
    if (drag && e.pointerId === drag.id) {
      this.dragging = null;
      drag.stop();
      try {
        this.releasePointerCapture(drag.id);
      } catch {
        /* rien à relâcher */
      }
      // un vrai glisser se conclut par l'action « place » ; un simple tap reste un tap
      if (drag.last && this.mondeR) {
        this.mondeR.dropped(drag.name);
        const payload = this.placedOut ?? drag.last;
        if (this.target) dispatch(this.target, { type: "place", payload });
        this.dispatchEvent(new CustomEvent("place", { detail: payload, bubbles: true, composed: true }));
        this.tap = null;
        return;
      }
    }
    const start = this.tap;
    this.tap = null;
    const scene = this.scene;
    if (!start || e.button !== 0 || !this.target || !scene?.isReady) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= TAP_MAX_MOVE_PX) return;
    if (performance.now() - start.t >= TAP_MAX_MS) return;
    const rect = this.getBoundingClientRect();
    const k = rect.width / this.width || 1;
    const sx = (e.clientX - rect.left) / k;
    const sy = (e.clientY - rect.top) / k;
    const re = namesRegex(this.pickNames);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const type = this.pickActionType || "pick";
    if (this.m2?.instanceCount && this.m2Parsed) {
      const layerNames = this.m2Parsed.layers.length ? this.m2Parsed.layers.map((l) => l.name).reverse() : ["monde"];
      for (const ln of layerNames) {
        const [lx, ly] = scene.layerPoint(ln, sx, sy);
        const mh = this.m2.pick(ln, lx, ly);
        if (mh && (!re || re.test(mh.instance))) {
          dispatch(this.target, { type, payload: { objectId: mh.instance, part: mh.part, x: r2(lx), y: r2(ly) } });
          return;
        }
      }
    }
    if (this.mondeR?.instanceCount) {
      const [lx, ly] = scene.layerPoint(this.mondeLayer || "monde", sx, sy);
      const drv = this.mondeR.driver;
      // un objet déplaçable d'abord (une porte est dessinée dans l'épaisseur de son mur, sous lui)
      const mh = this.mondeR.pick(lx, ly, (n) => drv.movable(n) && (!re || re.test(n))) ?? this.mondeR.pick(lx, ly);
      if (mh && (!re || re.test(mh.instance))) {
        // objet déplaçable du monde : `instance` et rang de son entrée (comme en 3D)
        const world = drv.movable(mh.instance) ? { instance: mh.instance, src: drv.instances.get(mh.instance)?.placement.src ?? -1 } : {};
        dispatch(this.target, { type, payload: { objectId: mh.instance, part: mh.part, x: r2(lx), y: r2(ly), ...world } });
        return;
      }
    }
    const hit = scene.pick(sx, sy, (n) => !re || re.test(n));
    if (hit) dispatch(this.target, { type, payload: { objectId: hit.name, x: r2(hit.x), y: r2(hit.y) } });
    else if (this.pickEmpty) {
      const [x, y] = scene.worldPoint(sx, sy);
      dispatch(this.target, { type, payload: { objectId: null, x: r2(x), y: r2(y) } });
    }
  };
}

export default Sonic2d;
