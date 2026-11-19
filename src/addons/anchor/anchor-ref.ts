import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { dispatch } from "../interactive";
import { extractFeatures, type Features } from "./core/features";
import { orderQuad, referenceFromFeatures, zoneMask, type AnchorReference } from "./core/reference";
import type { Pt } from "./core/homography";
import { grabGray, resolveSource, upFromOrientation } from "./frame";

export type AnchorRefState = {
  status: "idle" | "ready" | "error";
  error: string | null;
  /** Référence prête à enregistrer (données d'artefact) et à donner à `sonic-anchor`. */
  reference: AnchorReference | null;
  zone: Pt[];
  /** Points de la zone : sous ~60, la surface est trop unie pour être retrouvée de façon fiable. */
  points: number;
  quality: "none" | "weak" | "ok" | "good";
  /** Vignette JPEG (data URL) de la photo, pour une liste de lieux. */
  thumb: string | null;
  captures: number;
  /** Balises envoyées au store `target` et id de la dernière. */
  saved: number;
  lastSaved: string | null;
};

/** Entrée envoyée au store `target` (action `save`) : de quoi lister, localiser et retrouver la balise. */
export type SavedAnchor = {
  id: string;
  createdAt: string;
  lat?: number;
  lon?: number;
  accuracy?: number;
  points: number;
  ref: AnchorReference;
  [k: string]: unknown;
};

const DEFAULT_ZONE: Pt[] = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];

const quality = (n: number): AnchorRefState["quality"] => (n <= 0 ? "none" : n < 60 ? "weak" : n < 160 ? "ok" : "good");

/**
 * Photographie un lieu et délimite la zone à ancrer (4 coins à déplacer au doigt).
 *
 * - `source` : `#id` de `sonic-camera` ; commande `control.capture` (compteur) ou `for` (clic) : fige l'image.
 * - Les coins se déplacent au doigt ; `zone` (DP facultatif) reçoit et peut imposer la zone.
 * - `gravity` (DP d'état de `sonic-orientation`) : enregistre la direction du haut au moment de la prise.
 * - `geo` (DP d'état de `sonic-geolocation`) : enregistre la position (lat, lon, précision).
 * - `ref-id` : id donné à la référence. `margin` : contexte gardé autour de la zone (fraction, 0.2).
 * - État `<id>State` (ou `out-data-provider`) : `{ status, error, reference, zone, points, quality, thumb, captures }`.
 * - `control.reset` : zone par défaut ; `control.clear` : oublie la photo.
 */
@customElement("sonic-anchor-ref")
export class SonicAnchorRef extends LitElement {
  static styles = css`
    :host { display: block; position: relative; user-select: none; -webkit-user-select: none; }
    .frame { position: relative; width: 100%; line-height: 0; }
    canvas { width: 100%; height: auto; display: block; border-radius: inherit; }
    svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
    .handle { cursor: grab; touch-action: none; }
    .empty { line-height: normal; padding: 2rem 1rem; text-align: center; opacity: .7; }
  `;

  @property({ type: String }) source = "";
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "for" }) targets = "";
  @property({ type: String }) zone = "";
  @property({ type: String }) gravity = "";
  @property({ type: String }) geo = "";
  @property({ type: String, attribute: "ref-id" }) refId = "";
  @property({ type: Number }) margin = 0.2;
  @property({ type: Number, attribute: "max-size" }) maxSize = 640;
  @property({ type: Number, attribute: "max-points" }) maxPoints = 1200;
  @property({ type: Boolean, attribute: "show-points" }) showPoints = true;
  /** Store (id) qui reçoit la balise enregistrée : `{type: action, payload: SavedAnchor}`. */
  @property({ type: String }) target = "";
  @property({ type: String }) action = "save";
  /** Ids des boutons dont le clic enregistre la balise courante. */
  @property({ type: String, attribute: "save-for" }) saveFor = "";
  /** DP dont les clés sont ajoutées à l'entrée enregistrée (message, effet, auteur…). */
  @property({ type: String }) extra = "";
  /** DP de sortie d'un `sonic-image-embedder` sur la même caméra : son vecteur est gardé dans la référence. */
  @property({ type: String }) embedding = "";
  @property({ type: String, attribute: "empty-text" }) emptyText = "Cadre la surface puis prends la photo";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  @state() private quad: Pt[] = DEFAULT_ZONE;
  @state() private size = { w: 0, h: 0 };
  @query("canvas") private canvas!: HTMLCanvasElement;
  @query("svg") private svgEl!: SVGSVGElement;

  stateValue: AnchorRefState = { status: "idle", error: null, reference: null, zone: DEFAULT_ZONE, points: 0, quality: "none", thumb: null, captures: 0, saved: 0, lastSaved: null };
  private features: Features | null = null;
  private photo: HTMLCanvasElement | null = null;
  private up: Pt | null = null;
  private upAtCapture: Pt | null = null;
  private geoNow: Record<string, unknown> | null = null;
  private geoAtCapture: AnchorReference["geo"] | undefined;
  private unsubs: Array<() => void> = [];
  private triggers = { capture: new CounterTrigger(), reset: new CounterTrigger(), clear: new CounterTrigger(), save: new CounterTrigger() };
  private extraNow: Record<string, unknown> = {};
  private vectorNow: number[] | null = null;
  private vectorAtCapture: number[] | null = null;
  private drag: { k: number; id: number } | null = null;
  private lastZoneJson = "";
  private photoDirty = false;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocClick, true);
    this.publish();
  }

  disconnectedCallback(): void {
    document.removeEventListener("click", this.onDocClick, true);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control") || c.has("zone") || c.has("gravity") || c.has("geo") || c.has("extra") || c.has("embedding")) this.listen();
    if (this.photoDirty && this.photo && this.canvas) {
      this.photoDirty = false;
      this.canvas.width = this.photo.width;
      this.canvas.height = this.photo.height;
      this.canvas.getContext("2d")?.drawImage(this.photo, 0, 0);
    }
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    Object.values(this.triggers).forEach((t) => t.reset());
    if (this.control) this.unsubs.push(listenDp(this.control, (v) => {
      const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      if (this.triggers.capture.feed(o.capture)) this.capture();
      if (this.triggers.reset.feed(o.reset)) this.setZone(DEFAULT_ZONE);
      if (this.triggers.clear.feed(o.clear)) this.clear();
      if (this.triggers.save.feed(o.save)) this.save();
    }));
    if (this.extra) this.unsubs.push(listenDp(this.extra, (v) => {
      const o = plain<Record<string, unknown>>(v);
      this.extraNow = o && typeof o === "object" && !Array.isArray(o) ? o : {};
    }));
    if (this.embedding) this.unsubs.push(listenDp(this.embedding, (v) => {
      const vec = (v as { vector?: unknown } | null)?.vector;
      this.vectorNow = Array.isArray(vec) && vec.length && vec.every((x) => typeof x === "number") ? (plain(vec) as number[]) : null;
    }));
    if (this.zone) this.unsubs.push(listenDp(this.zone, (v) => {
      const z = plain<Pt[]>(v);
      if (!Array.isArray(z) || z.length !== 4 || JSON.stringify(z) === this.lastZoneJson) return;
      if (z.every((p) => Number.isFinite(+p?.x) && Number.isFinite(+p?.y))) this.setZone(z, false);
    }));
    if (this.gravity) this.unsubs.push(listenDp(this.gravity, (v) => { this.up = upFromOrientation(v); }));
    if (this.geo) this.unsubs.push(listenDp(this.geo, (v) => { this.geoNow = plain(v); }));
  }

  private onDocClick = (e: Event): void => {
    const hit = (list: string) => {
      const ids = list.split(/\s+/).map((s) => s.replace(/^#/, "")).filter(Boolean);
      return ids.length > 0 && e.composedPath().some((n) => n instanceof Element && !!n.id && ids.includes(n.id));
    };
    if (hit(this.targets)) this.capture();
    if (hit(this.saveFor)) this.save();
  };

  /** Envoie la balise courante au store `target`. Faux si rien à enregistrer. */
  save(): boolean {
    const ref = this.stateValue.reference;
    if (!ref || !this.target) {
      this.stateValue = { ...this.stateValue, error: !ref ? "rien à enregistrer : prends d'abord une photo" : "aucun store cible (target)" };
      this.publish(false);
      return false;
    }
    const id = `b-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const entry: SavedAnchor = { ...this.extraNow, id, createdAt: new Date().toISOString(), points: ref.n, ref: { ...ref, id } };
    if (ref.geo) {
      entry.lat = ref.geo.lat;
      entry.lon = ref.geo.lon;
      if (ref.geo.accuracy !== undefined) entry.accuracy = ref.geo.accuracy;
    }
    dispatch(this.target, { type: this.action || "save", payload: entry });
    this.stateValue = { ...this.stateValue, error: null, saved: this.stateValue.saved + 1, lastSaved: id };
    this.publish(false);
    return true;
  }

  /** Fige l'image courante de la source et extrait ses points. */
  capture(): boolean {
    const grab = grabGray(resolveSource(this, this.source), this.maxSize);
    if (!grab) {
      this.stateValue = { ...this.stateValue, status: "error", error: "caméra pas prête : démarre-la puis réessaie" };
      this.publish();
      return false;
    }
    const photo = document.createElement("canvas");
    photo.width = grab.canvas.width;
    photo.height = grab.canvas.height;
    photo.getContext("2d")?.drawImage(grab.canvas, 0, 0);
    this.photo = photo;
    this.photoDirty = true;
    this.features = extractFeatures(grab.gray, { maxPoints: this.maxPoints });
    this.upAtCapture = this.up;
    this.vectorAtCapture = this.vectorNow;
    const g = this.geoNow;
    const lat = Number(g?.lat), lon = Number(g?.lon);
    this.geoAtCapture = Number.isFinite(lat) && Number.isFinite(lon) && g?.lat !== null
      ? { lat, lon, ...(Number.isFinite(Number(g?.accuracy)) ? { accuracy: Number(g?.accuracy) } : {}) }
      : undefined;
    let thumb: string | null = null;
    try {
      const t = document.createElement("canvas");
      const s = Math.min(1, 320 / Math.max(photo.width, photo.height));
      t.width = Math.round(photo.width * s); t.height = Math.round(photo.height * s);
      t.getContext("2d")?.drawImage(photo, 0, 0, t.width, t.height);
      thumb = t.toDataURL("image/jpeg", 0.72);
    } catch { thumb = null; }
    this.stateValue = { ...this.stateValue, thumb, captures: this.stateValue.captures + 1 };
    this.size = { w: photo.width, h: photo.height };
    this.rebuild();
    return true;
  }

  clear(): void {
    this.photo = null;
    this.features = null;
    this.size = { w: 0, h: 0 };
    this.stateValue = { ...this.stateValue, status: "idle", error: null, reference: null, points: 0, quality: "none", thumb: null };
    this.publish();
  }

  setZone(z: Pt[], publishZone = true): void {
    this.quad = orderQuad(z.map((p) => ({ x: clamp01(+p.x), y: clamp01(+p.y) })));
    this.rebuild(publishZone);
  }

  private rebuild(publishZone = true): void {
    const f = this.features;
    if (!f) {
      this.stateValue = { ...this.stateValue, zone: this.quad };
      this.publish(publishZone);
      return;
    }
    const ref = referenceFromFeatures(f, this.quad, { margin: this.margin, up: this.upAtCapture, id: this.refId || undefined });
    if (this.geoAtCapture) ref.geo = this.geoAtCapture;
    if (this.vectorAtCapture) ref.embedding = this.vectorAtCapture.map((x) => Math.round(x * 1000) / 1000);
    ref.createdAt = new Date().toISOString();
    this.stateValue = {
      ...this.stateValue, status: "ready", error: ref.n < 30 ? "surface trop unie : choisis une zone plus texturée" : null,
      reference: ref, zone: ref.zone, points: ref.n, quality: quality(ref.n),
    };
    this.publish(publishZone);
  }

  private publish(publishZone = true): void {
    const s = this.stateValue;
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, s);
    if (publishZone && this.zone) {
      this.lastZoneJson = JSON.stringify(s.zone);
      set(this.zone, s.zone);
    }
    this.dispatchEvent(new CustomEvent("anchor-ref-state", { detail: s, bubbles: true, composed: true }));
    this.requestUpdate();
  }

  private toLocal(e: PointerEvent): Pt | null {
    const r = this.svgEl?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return null;
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }

  private onDown(e: PointerEvent, k: number): void {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    this.drag = { k, id: e.pointerId };
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const p = this.toLocal(e);
    if (!p) return;
    const q = this.quad.slice();
    q[this.drag.k] = p;
    this.quad = q;
  }

  private onUp(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = null;
    this.setZone(this.quad);
  }

  render() {
    const { w, h } = this.size;
    if (!w || !h) return html`<div class="empty" part="empty">${this.emptyText}</div>`;
    const q = this.quad.map((p) => ({ x: p.x * w, y: p.y * h }));
    const r = Math.max(w, h) / 28;
    const sw = Math.max(w, h) / 300;
    const f = this.features;
    let dots: unknown = nothing;
    if (this.showPoints && f) {
      const inside = zoneMask(this.quad, f.width, f.height, this.margin);
      const parts = [];
      for (let i = 0; i < f.n; i++) {
        if (!inside(f.x[i], f.y[i])) continue;
        parts.push(svg`<circle cx=${(f.x[i] / f.width) * w} cy=${(f.y[i] / f.height) * h} r=${sw * 1.6} fill="#f5c400" opacity=".85"></circle>`);
      }
      dots = parts;
    }
    return html`<div class="frame" part="frame">
      <canvas part="photo"></canvas>
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"
        @pointermove=${(e: PointerEvent) => this.onMove(e)} @pointerup=${(e: PointerEvent) => this.onUp(e)} @pointercancel=${(e: PointerEvent) => this.onUp(e)}>
        <path d=${`M0 0H${w}V${h}H0Z M${q.map((p) => `${p.x} ${p.y}`).join("L")}Z`} fill="rgba(0,0,0,.45)" fill-rule="evenodd"></path>
        ${dots}
        <polygon points=${q.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#fff" stroke-width=${sw * 2} stroke-linejoin="round"></polygon>
        ${q.map((p, k) => svg`<g class="handle" @pointerdown=${(e: PointerEvent) => this.onDown(e, k)}>
          <circle cx=${p.x} cy=${p.y} r=${r * 1.6} fill="transparent"></circle>
          <circle cx=${p.x} cy=${p.y} r=${r * 0.55} fill="#fff" stroke="#111" stroke-width=${sw}></circle>
        </g>`)}
      </svg>
    </div>`;
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
