import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { maskStats, maskToRgba } from "../../shared/ml/mask";
import type { HfLoadPolicy } from "./hf-config";
import type { HfSamDecodeResult } from "./hf-protocol";
import { getHuggingFaceRegistry, HfError, type HfModelState } from "./hf-registry";
import { applyGesture, fitSize, hasPrompt, parseBox, parsePoints, toPixels, type SamPrompts } from "./sam-prompts";

type FrameSourceLike = Element & {
  getFrameSource?: () => HTMLVideoElement | null;
  getFrameCanvas?: () => HTMLCanvasElement | null;
  frameSeq?: number;
};

export type SegmentAnythingState = {
  /** Phase du modèle (`idle`, `awaiting-consent`, `downloading`, `ready`, `error`…). */
  phase: HfModelState["phase"];
  progress: number;
  backend: string | null;
  /** Une image est encodée (les invites sont alors rapides). */
  encoded: boolean;
  busy: boolean;
  /** Invites courantes (0..1, repère écran). */
  points: SamPrompts["points"];
  box: SamPrompts["box"];
  present: 0 | 1;
  /** Score de qualité estimé par le modèle (0..1). */
  score: number;
  coverage: number;
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  encodeMs: number;
  decodeMs: number;
  error: { code: string; message: string } | null;
};

const NEUTRAL = { present: 0 as const, score: 0, coverage: 0, cx: 0.5, cy: 0.5, x0: 0, y0: 0, x1: 0, y1: 0 };
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Segmentation « Segment Anything » (SAM 2) sur une image (`sonic-still`, `<img>`, `<canvas>`, caméra, vidéo) :
 * l'image est encodée une fois, puis chaque invite (points sur l'objet / hors de l'objet, boîte) donne un masque en
 * quelques dizaines de millisecondes. Le masque est une source d'images (`sonic-mask-replace mask="#id"`,
 * `sonic-shader channel1="#id"`) ; statistiques et état en DataProvider. Le modèle passe par la configuration
 * Hugging Face (liste blanche, consentement, cache), entrée `engine: "sam"`.
 */
@customElement("sonic-segment-anything")
export class SonicSegmentAnything extends LitElement {
  /** Id de l'image source. */
  @property({ type: String, attribute: "for" }) for = "";
  /** Alias du modèle dans la configuration Hugging Face (`engine: "sam"`). */
  @property({ type: String }) model = "sam2-tiny";
  /** Id d'un élément dont les clics désignent l'objet : clic = nouvelle sélection, Maj+clic = ajouter, Alt+clic ou clic droit = exclure, glisser = boîte. */
  @property({ type: String, attribute: "click-on" }) clickOn = "";
  /** Chemin DataProvider des points (`[{x, y, label}]`, 0..1). */
  @property({ type: String, attribute: "points-from" }) pointsFrom = "";
  /** Chemin DataProvider d'une boîte (`{x0, y0, x1, y1}`, 0..1). */
  @property({ type: String, attribute: "box-from" }) boxFrom = "";
  /** Points fixés à la main : `"0.5,0.4,1; 0.2,0.2,0"`. */
  @property({ type: String }) points = "";
  /** `manual` (défaut) : l'image est encodée à la première invite et sur `encode()` ; `frames` : ré-encodée quand la source change (caméra, vidéo), au plus `fps` fois par seconde. */
  @property({ type: String }) refresh: "manual" | "frames" = "manual";
  @property({ type: Number }) fps = 2;
  /** `alpha` (blanc, objet opaque) ou `gray` (objet blanc sur noir). */
  @property({ type: String }) mode: "alpha" | "gray" = "alpha";
  @property({ type: Boolean }) invert = false;
  /** `auto` : miroir pour une caméra native (`<video>` non retournée) ; `true` / `false` forcent. */
  @property({ type: String }) mirror: "auto" | "true" | "false" = "auto";
  /** Politique de chargement : `first-use` (défaut, à la première invite), `auto`, `consent`, `manual`. */
  @property({ type: String }) load: HfLoadPolicy = "first-use";
  @property({ type: String, attribute: "consent-provider" }) consentProvider = "";
  @property({ type: Number, attribute: "max-side" }) maxSide = 1024;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private prompts: SamPrompts = { points: [], box: null };
  private state: SegmentAnythingState = { phase: "idle", progress: 0, backend: null, encoded: false, busy: false, points: [], box: null, ...NEUTRAL, encodeMs: 0, decodeMs: 0, error: null };
  private canvas: HTMLCanvasElement | null = null;
  private seq = 0;
  private encodedToken: unknown = undefined;
  private encodedSize = { width: 0, height: 0 };
  private encodedMirror = false;
  private running = false;
  private again = false;
  private needEncode = false;
  private unsubs: (() => void)[] = [];
  private clickEl: Element | null = null;
  private down: { x: number; y: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  /* --- contrat source d'images (sonic-shader, sonic-mask-replace) --- */
  getFrameCanvas(): HTMLCanvasElement | null { return this.seq > 0 ? this.canvas : null; }
  get frameSeq(): number { return this.seq; }

  connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "contents";
  }

  disconnectedCallback(): void {
    this.detach();
    this.generation++;
    super.disconnectedCallback();
  }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (!this.isConnected) return;
    if ([...c.keys()].some((k) => ["for", "model", "clickOn", "pointsFrom", "boxFrom", "points", "refresh", "fps", "consentProvider", "load"].includes(String(k))) || !this.unsubs.length) this.attach();
    if (c.has("mode") || c.has("invert")) this.redraw();
  }

  /* --- API --- */

  /** Remplace les invites (0..1, repère écran). */
  setPrompts(p: Partial<SamPrompts>): void {
    this.prompts = { points: parsePoints(p.points ?? []), box: parseBox(p.box ?? null) };
    this.onPrompts();
  }

  getPrompts(): SamPrompts { return { points: this.prompts.points.map((q) => ({ ...q })), box: this.prompts.box ? { ...this.prompts.box } : null }; }

  /** Efface les invites et le masque. */
  clear(): void {
    this.prompts = { points: [], box: null };
    this.onPrompts();
  }

  /** Ré-encode l'image source (après un changement d'image en mode `manual`). */
  encode(): void {
    this.needEncode = true;
    this.schedule();
  }

  accept(): void { getHuggingFaceRegistry()?.accept(this.model); }
  decline(): void { getHuggingFaceRegistry()?.decline(this.model); }
  getState(): SegmentAnythingState { return this.state; }

  /* --- câblage --- */

  private attach(): void {
    this.detach();
    const reg = getHuggingFaceRegistry();
    if (!reg) {
      this.patch({ phase: "unsupported", error: { code: "not-configured", message: "configureHuggingFace() n'a pas été appelé." } });
      return;
    }
    if (!reg.hasModel(this.model) || reg.model(this.model).engine !== "sam") {
      this.patch({ phase: "error", error: { code: "not-allowed", message: `Modèle « ${this.model} » absent de la configuration ou non SAM.` } });
      return;
    }
    this.unsubs.push(reg.subscribe(this.model, (s) => this.patch({ phase: s.phase, progress: s.progress?.percent ?? (s.phase === "ready" ? 100 : 0), backend: s.backend ?? null, error: s.error ? { code: s.error.code, message: s.error.message } : this.state.error?.code === "not-allowed" ? null : this.state.error })));
    if (this.consentProvider.trim()) {
      this.unsubs.push(listenDp(this.consentProvider.trim(), (v) => {
        if (v === true || v === "accepted" || v === "true") reg.accept(this.model);
        else if (v === "declined" || v === false) reg.decline(this.model);
      }));
    }
    const pf = this.pointsFrom.trim(), bf = this.boxFrom.trim();
    if (pf) this.unsubs.push(listenDp(pf, (v) => { this.prompts = { ...this.prompts, points: parsePoints(v) }; this.onPrompts(); }));
    if (bf) this.unsubs.push(listenDp(bf, (v) => { this.prompts = { ...this.prompts, box: parseBox(v) }; this.onPrompts(); }));
    if (!pf && !bf && this.points.trim()) { this.prompts = { points: parsePoints(this.points), box: null }; this.onPrompts(); }
    const id = this.clickOn.trim().replace(/^#/, "");
    const el = id ? this.lookup(id) : null;
    if (el) {
      el.addEventListener("pointerdown", this.onDown as EventListener);
      el.addEventListener("pointerup", this.onUp as EventListener);
      el.addEventListener("contextmenu", this.onContext);
      this.clickEl = el;
    }
    if (this.load === "auto") void this.ensureModel().catch(() => {});
    if (this.refresh === "frames") this.tick();
  }

  private detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.clickEl) {
      this.clickEl.removeEventListener("pointerdown", this.onDown as EventListener);
      this.clickEl.removeEventListener("pointerup", this.onUp as EventListener);
      this.clickEl.removeEventListener("contextmenu", this.onContext);
      this.clickEl = null;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private lookup(id: string): Element | null {
    const root = this.getRootNode() as Document | ShadowRoot;
    return root.getElementById?.(id) ?? document.getElementById(id);
  }

  private rel(e: PointerEvent): { x: number; y: number } | null {
    const r = this.clickEl?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }

  private onContext = (e: Event) => e.preventDefault();

  private onDown = (e: PointerEvent) => { this.down = this.rel(e); };

  private onUp = (e: PointerEvent) => {
    const start = this.down;
    this.down = null;
    const p = this.rel(e);
    if (!start || !p) return;
    if (Math.hypot(p.x - start.x, p.y - start.y) > 0.02) {
      this.prompts = applyGesture(this.prompts, { kind: "box", x0: start.x, y0: start.y, x1: p.x, y1: p.y });
    } else {
      this.prompts = applyGesture(this.prompts, { kind: "point", x: p.x, y: p.y, add: e.shiftKey, negative: e.altKey || e.button === 2 });
    }
    this.onPrompts();
  };

  private onPrompts(): void {
    this.patch({ points: this.prompts.points, box: this.prompts.box });
    if (!hasPrompt(this.prompts)) {
      this.clearMask();
      return;
    }
    this.schedule();
  }

  private tick = (): void => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.isConnected || this.refresh !== "frames") return;
      if (hasPrompt(this.prompts) && this.state.phase === "ready") {
        const f = this.grab();
        if (f && f.token !== this.encodedToken) { this.needEncode = true; this.schedule(); }
      }
      this.tick();
    }, 1000 / Math.max(0.1, Math.min(30, Number(this.fps) || 2)));
  };

  /* --- calcul --- */

  private async ensureModel(): Promise<void> {
    const reg = getHuggingFaceRegistry();
    if (!reg) throw new HfError("runtime", "Non configuré.");
    await reg.ensureLoaded(this.model, this.load === "manual" ? "manual" : this.load);
  }

  private schedule(): void {
    if (this.running) { this.again = true; return; }
    void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    const gen = this.generation;
    this.patch({ busy: true });
    try {
      do {
        this.again = false;
        if (!hasPrompt(this.prompts) && !this.needEncode) break;
        await this.ensureModel();
        if (gen !== this.generation) return;
        const reg = getHuggingFaceRegistry()!;
        const frame = this.grab();
        if (!frame) { this.patch({ error: { code: "no-image", message: "Image source introuvable ou pas encore prête." } }); break; }
        if (this.needEncode || frame.token !== this.encodedToken || !this.state.encoded) {
          const image = frame.read();
          if (!image) break;
          const r = await reg.samEncode(this.model, image, 60_000);
          if (gen !== this.generation) return;
          this.encodedToken = frame.token;
          this.encodedSize = { width: r.width, height: r.height };
          this.encodedMirror = frame.mirror;
          this.needEncode = false;
          this.patch({ encoded: true, encodeMs: r.encodeMs, error: null, ...(r.backend ? { backend: r.backend } : {}) });
        }
        if (!hasPrompt(this.prompts)) break;
        const px = toPixels(this.prompts, this.encodedSize.width, this.encodedSize.height, this.encodedMirror);
        const res = await reg.samDecode(this.model, px.points, px.box, 30_000);
        if (gen !== this.generation) return;
        if (!hasPrompt(this.prompts)) break;
        if (res) this.show(res);
      } while (this.again);
    } catch (err) {
      const code = err instanceof HfError ? err.code : "runtime";
      this.patch({ error: { code, message: err instanceof Error ? err.message : String(err) } });
    } finally {
      this.running = false;
      if (gen === this.generation) this.patch({ busy: false });
      if (this.again && gen === this.generation) { this.again = false; this.schedule(); }
    }
  }

  private last: HfSamDecodeResult | null = null;

  private show(res: HfSamDecodeResult): void {
    this.last = res;
    const data = new Uint8Array(res.mask.length);
    for (let i = 0; i < data.length; i++) data[i] = res.mask[i] ? 255 : 0;
    const st = maskStats(data, res.width, res.height, 128, this.encodedMirror);
    this.draw(data, res.width, res.height);
    this.patch({
      present: st.coverage > 0 ? 1 : 0, score: round3(res.score), coverage: round3(st.coverage), cx: round3(st.cx), cy: round3(st.cy),
      x0: round3(st.x0), y0: round3(st.y0), x1: round3(st.x1), y1: round3(st.y1), decodeMs: res.decodeMs, error: null,
      ...(res.backend ? { backend: res.backend } : {}),
    });
  }

  private redraw(): void {
    const res = this.last;
    if (!res || !hasPrompt(this.prompts)) return;
    const data = new Uint8Array(res.mask.length);
    for (let i = 0; i < data.length; i++) data[i] = res.mask[i] ? 255 : 0;
    this.draw(data, res.width, res.height);
  }

  private draw(data: Uint8Array, w: number, h: number): void {
    if (!this.canvas) this.canvas = document.createElement("canvas");
    const c = this.canvas;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    img.data.set(maskToRgba(data, w, h, this.mode === "gray" ? "gray" : "alpha", this.encodedMirror, this.invert));
    ctx.putImageData(img, 0, 0);
    this.seq++;
  }

  private clearMask(): void {
    this.last = null;
    const c = this.canvas, ctx = c?.getContext("2d");
    if (c && ctx) { ctx.clearRect(0, 0, c.width, c.height); this.seq++; }
    this.patch({ ...NEUTRAL });
  }

  /** Image courante de la source : jeton d'identité, miroir, et lecture RGBA réduite. */
  private grab(): { token: unknown; mirror: boolean; read: () => { width: number; height: number; data: Uint8ClampedArray } | null } | null {
    const id = this.for.trim().replace(/^#/, "");
    const src = id ? (this.lookup(id) as FrameSourceLike | null) : null;
    if (!src) return null;
    let image: CanvasImageSource | null = null;
    let w = 0, h = 0, token: unknown, native = false;
    const video = src.getFrameSource?.() ?? (src instanceof HTMLVideoElement ? src : null);
    const canvas = src.getFrameCanvas?.() ?? (src instanceof HTMLCanvasElement ? src : null);
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      image = video; w = video.videoWidth; h = video.videoHeight; native = !!src.getFrameSource || src instanceof HTMLVideoElement;
      token = typeof src.frameSeq === "number" ? `s${src.frameSeq}` : `t${video.currentTime}`;
    } else if (canvas && canvas.width > 0 && canvas.height > 0) {
      image = canvas; w = canvas.width; h = canvas.height;
      token = typeof src.frameSeq === "number" ? `s${src.frameSeq}` : canvas;
    } else if (src instanceof HTMLImageElement && src.complete && src.naturalWidth > 0) {
      image = src; w = src.naturalWidth; h = src.naturalHeight; token = `i${src.currentSrc || src.src}`;
    }
    if (!image) return null;
    const mirror = this.mirror === "true" || (this.mirror === "auto" && native && image instanceof HTMLVideoElement);
    const maxSide = Math.max(64, Math.min(2048, Number(this.maxSide) || 1024));
    return {
      token, mirror,
      read: () => {
        const size = fitSize(w, h, maxSide);
        const c = document.createElement("canvas");
        c.width = size.width; c.height = size.height;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        try {
          ctx.drawImage(image!, 0, 0, size.width, size.height);
          return { width: size.width, height: size.height, data: ctx.getImageData(0, 0, size.width, size.height).data };
        } catch {
          this.patch({ error: { code: "tainted", message: "Image d'une autre origine non lisible (CORS)." } });
          return null;
        }
      },
    };
  }

  private patch(p: Partial<SegmentAnythingState>): void {
    this.state = { ...this.state, ...p };
    if (this.outDataProvider) set(this.outDataProvider, this.state);
    this.dispatchEvent(new CustomEvent("segment-state", { detail: this.state, bubbles: true, composed: true }));
  }
}

export default SonicSegmentAnything;
