import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { type ColorBlob, colorBlobs, parseHex, sampleColor, toHex } from "../../shared/media/cv";
import { FrameSampler, type Pixels } from "../../shared/media/sampler";

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface ColorTrackState {
  status: "idle" | "ready" | "error";
  error: string | null;
  color: string;
  present: boolean;
  x: number | null;
  y: number | null;
  area: number;
  box: [number, number, number, number] | null;
  blobs: ColorBlob[];
}

/**
 * Suivi d'objet par sa couleur, sans modèle : balle, gant, bouchon, carton de couleur vive devant la caméra.
 * Pixels proches de `color` (OKLab, `tolerance`), regroupés en taches ; publie la plus grande (centre, aire, boîte)
 * et les suivantes. `control.pick = [x, y]` (fractions de l'image, compteur `n`) prend la couleur sous ce point.
 */
@customElement("sonic-color-tracker")
export class SonicColorTracker extends LitElement {
  @property({ type: String }) source = "";
  /** Couleur suivie `#rrggbb`. */
  @property({ type: String }) color = "#e11d48";
  /** Écart de couleur accepté (OKLab ; 0,05 strict, 0,15 défaut, 0,3 large). */
  @property({ type: Number }) tolerance = 0.15;
  /** Aire minimale d'une tache (part de l'image). */
  @property({ type: Number, attribute: "min-area" }) minArea = 0.002;
  @property({ type: Number }) resolution = 96;
  @property({ type: Number }) interval = 50;
  @property({ type: Boolean }) mirror = false;
  /** Réglages en direct `{color, tolerance, minArea, active}`. */
  @property({ type: String }) params = "";
  /** Commandes `{pick: [x, y], n}` : prendre la couleur sous le point. */
  @property({ type: String }) control = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private sampler = new FrameSampler(this, (px) => this.analyse(px), () => this.missing());
  private live: { color?: string; tolerance?: number; minArea?: number; active?: boolean } = {};
  private picked: string | null = null;
  private pending: [number, number] | null = null;
  private pickTrigger = new CounterTrigger();
  private unsubs: (() => void)[] = [];
  private state: ColorTrackState = { status: "idle", error: null, color: "", present: false, x: null, y: null, area: 0, box: null, blobs: [] };

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
    this.sampler.cols = Math.max(16, Math.min(320, Number(this.resolution) || 96));
    if (c.has("params") || c.has("control")) this.listen();
    if (c.has("color")) this.picked = null;
  }

  getState(): ColorTrackState {
    return this.state;
  }

  private listen(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    this.pickTrigger.reset();
    if (this.params) this.unsubs.push(listenDp(this.params, (v) => (this.live = v && typeof v === "object" ? (v as typeof this.live) : {})));
    if (this.control)
      this.unsubs.push(
        listenDp(this.control, (v) => {
          const o = (v ?? {}) as { pick?: unknown; n?: unknown };
          if (!this.pickTrigger.feed(o.n) || !Array.isArray(o.pick)) return;
          const x = Number(o.pick[0]), y = Number(o.pick[1]);
          if (Number.isFinite(x) && Number.isFinite(y)) this.pending = [x, y];
        }),
      );
  }

  private missing(): void {
    if (this.source && this.state.status !== "error") this.publish({ ...this.state, status: "error", error: "source introuvable" });
  }

  /** Couleur suivie : prise au point (pick), sinon réglage en direct, sinon attribut. */
  currentColor(): string {
    return this.picked ?? (parseHex(this.live.color) ? String(this.live.color) : this.color);
  }

  analyse(px: Pixels): void {
    if (this.live.active === false) return;
    const mx = (v: number) => (this.mirror ? 1 - v : v);
    if (this.pending) {
      const [r, g, b] = sampleColor(px.data, px.width, px.height, mx(this.pending[0]), this.pending[1], 1);
      this.picked = toHex(r, g, b);
      this.pending = null;
    }
    const color = this.currentColor();
    const rgb = parseHex(color);
    if (!rgb) {
      this.publish({ ...this.state, status: "error", error: `couleur invalide : ${color}` });
      return;
    }
    const tol = Number(this.live.tolerance ?? this.tolerance);
    const minArea = Number(this.live.minArea ?? this.minArea);
    const blobs = colorBlobs(px.data, px.width, px.height, rgb, Number.isFinite(tol) ? tol : 0.15, Number.isFinite(minArea) ? minArea : 0.002).map((b) => ({
      x: r3(mx(b.x)),
      y: r3(b.y),
      area: r3(b.area),
      box: (this.mirror ? [1 - b.box[2], b.box[1], 1 - b.box[0], b.box[3]] : b.box).map(r3) as ColorBlob["box"],
    }));
    const top = blobs[0];
    this.publish({ status: "ready", error: null, color, present: !!top, x: top?.x ?? null, y: top?.y ?? null, area: top?.area ?? 0, box: top?.box ?? null, blobs });
  }

  private publish(s: ColorTrackState): void {
    this.state = s;
    if (this.outDataProvider) set(this.outDataProvider, s);
  }
}
