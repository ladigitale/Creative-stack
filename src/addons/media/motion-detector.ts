import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
import { lumaOf, motion, readZones, updateZone, type Zone, type ZoneState, zoneLevel } from "../../shared/media/cv";
import { FrameSampler, type Pixels } from "../../shared/media/sampler";

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface MotionDetectorState {
  status: "idle" | "ready" | "error";
  error: string | null;
  level: number;
  x: number | null;
  y: number | null;
  box: [number, number, number, number] | null;
  zones: Record<string, { level: number; active: boolean; count: number }>;
  fps: number;
}

/**
 * Détection de mouvement sans modèle : différence entre deux images successives d'une source (`source="#cam"`),
 * réduite à une petite grille. Publie le niveau de mouvement, son centre et sa boîte, et l'état de zones
 * (`zones` : boutons à agiter devant la caméra) ; une zone qui s'allume envoie une action au store `target`.
 * Est elle-même une source d'images (masque blanc du mouvement) pour `sonic-shader channel0="#id"`.
 */
@customElement("sonic-motion-detector")
export class SonicMotionDetector extends LitElement {
  @property({ type: String }) source = "";
  /** Colonnes de la grille d'analyse (64 ; 16 à 320). */
  @property({ type: Number }) resolution = 64;
  /** Écart de luminance (0..1) à partir duquel un pixel bouge. */
  @property({ type: Number }) threshold = 0.08;
  /** Analyse au plus toutes les `interval` ms. */
  @property({ type: Number }) interval = 50;
  /** Zones `[{name, x, y, w, h}]` ou `{nom: [x, y, w, h]}` en fractions de l'image : JSON ou chemin DataProvider. */
  @property({ type: String }) zones = "";
  /** Part de la zone qui doit bouger pour l'allumer (0..1). */
  @property({ type: Number, attribute: "zone-level" }) zoneLevel = 0.06;
  /** Durée minimale d'allumage (ms). */
  @property({ type: Number, attribute: "hold-ms" }) holdMs = 300;
  /** Image retournée (caméra frontale affichée en miroir) : x et zones lus comme à l'écran. */
  @property({ type: Boolean }) mirror = false;
  /** Réglages en direct `{threshold, zoneLevel, active}`. */
  @property({ type: String }) params = "";
  @property({ type: String }) target = "";
  @property({ type: String }) action = "motion:zone";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  frameSeq = 0;
  private sampler = new FrameSampler(this, (px, t) => this.analyse(px, t), () => this.missing());
  private prev: Float32Array | null = null;
  private zoneList: Zone[] = [];
  private zoneStates = new Map<string, ZoneState>();
  private live: { threshold?: number; zoneLevel?: number; active?: boolean } = {};
  private unsubs: (() => void)[] = [];
  private state: MotionDetectorState = { status: "idle", error: null, level: 0, x: null, y: null, box: null, zones: {}, fps: 0 };
  private maskCanvas: HTMLCanvasElement | null = null;
  private lastT = 0;

  createRenderRoot(): HTMLElement | ShadowRoot {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "none";
    this.listen();
    this.sampler.start();
  }

  disconnectedCallback(): void {
    this.sampler.stop();
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    this.sampler.source = this.source;
    this.sampler.interval = Math.max(16, Number(this.interval) || 50);
    this.sampler.cols = Math.max(16, Math.min(320, Number(this.resolution) || 64));
    if (c.has("zones") || c.has("params")) this.listen();
    if (c.has("resolution") || c.has("source")) this.prev = null;
  }

  /** Contrat source d'images : masque du dernier mouvement (blanc = bouge). */
  getFrameCanvas(): HTMLCanvasElement | null {
    return this.maskCanvas;
  }

  getState(): MotionDetectorState {
    return this.state;
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    const z = this.zones.trim();
    if (z.startsWith("[") || z.startsWith("{")) this.setZones(readZones(z));
    else if (z) this.unsubs.push(listenDp(z, (v) => this.setZones(readZones(v))));
    else this.setZones([]);
    if (this.params) this.unsubs.push(listenDp(this.params, (v) => (this.live = v && typeof v === "object" ? (v as typeof this.live) : {})));
  }

  private setZones(list: Zone[]): void {
    this.zoneList = list;
    const next = new Map<string, ZoneState>();
    for (const z of list) next.set(z.name, this.zoneStates.get(z.name) ?? { level: 0, active: false, count: 0, since: 0 });
    this.zoneStates = next;
  }

  private missing(): void {
    if (this.source && this.state.status !== "error") this.publish({ ...this.state, status: "error", error: "source introuvable" });
  }

  /** Analyse d'une image réduite (appelée par l'échantillonneur ; publique pour les tests). */
  analyse(px: Pixels, t: number): void {
    if (this.live.active === false) return;
    const cur = lumaOf(px.data, px.width, px.height);
    const prev = this.prev && this.prev.length === cur.length ? this.prev : null;
    this.prev = cur;
    if (!prev) return;
    const th = Number(this.live.threshold ?? this.threshold);
    const m = motion(prev, cur, px.width, px.height, Number.isFinite(th) ? th : 0.08);
    const on = Number(this.live.zoneLevel ?? this.zoneLevel) || 0.06;
    const zones: MotionDetectorState["zones"] = {};
    for (const z of this.zoneList) {
      const s = this.zoneStates.get(z.name)!;
      if (updateZone(s, zoneLevel(m.mask, px.width, px.height, z, this.mirror), t, on, Number(this.holdMs) || 0)) {
        if (this.target) dispatch(this.target, { type: this.action || "motion:zone", payload: { zone: z.name, level: r3(s.level), count: s.count } });
        this.dispatchEvent(new CustomEvent("zone", { detail: { zone: z.name, level: s.level }, bubbles: true, composed: true }));
      }
      zones[z.name] = { level: r3(s.level), active: s.active, count: s.count };
    }
    const fx = (v: number) => (this.mirror ? 1 - v : v);
    const box = m.box ? ([fx(this.mirror ? m.box[2] : m.box[0]), m.box[1], fx(this.mirror ? m.box[0] : m.box[2]), m.box[3]].map(r3) as MotionDetectorState["box"]) : null;
    const dt = this.lastT ? t - this.lastT : 0;
    this.lastT = t;
    this.drawMask(m.mask, px.width, px.height);
    this.publish({
      status: "ready",
      error: null,
      level: r3(m.level),
      x: m.x === null ? null : r3(fx(m.x)),
      y: m.y === null ? null : r3(m.y),
      box,
      zones,
      fps: dt > 0 ? Math.round((this.state.fps ? this.state.fps * 0.9 + 100 / dt : 1000 / dt) * 10) / 10 : this.state.fps,
    });
  }

  private drawMask(mask: Uint8Array, w: number, h: number): void {
    const c = (this.maskCanvas ??= document.createElement("canvas"));
    c.width = w;
    c.height = h;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = c.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    for (let k = 0; k < w * h; k++) {
      const v = mask[k] * 255;
      const i = k * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.frameSeq++;
  }

  private publish(s: MotionDetectorState): void {
    this.state = s;
    if (this.outDataProvider) set(this.outDataProvider, s);
  }
}
