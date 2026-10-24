import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { HTML, PublisherManager } from "@supersoniks/concorde/utils";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { listenDp } from "../../shared/audio/dp";
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
    this.scene?.destroy();
    this.scene = null;
    super.disconnectedCallback();
  }

  render() {
    return html`<canvas part="canvas"></canvas>${this.status === "error" ? html`<div class="msg">${this.error}</div>` : null}`;
  }

  protected firstUpdated(): void {
    this.canvas = this.renderRoot.querySelector("canvas");
    this.addEventListener("pointerdown", this.onDown);
    this.addEventListener("pointerup", this.onUp);
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
    if (changed.has("dataProvider")) this.bind();
    if (changed.has("sprites") || changed.has("camera")) this.listen();
  }

  /* ------------------------------------------------------------ construction */

  private async build(): Promise<void> {
    if (!this.canvas) return;
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
      invalidate: () => this.invalidate(),
    });
    this.scene = scene;
    this.status = "loading";
    this.publishOut();
    try {
      await scene.init();
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
    if (data.nodes !== undefined) scene.nodes.apply(data.nodes, now, animate);
    if (data.camera !== undefined && !this.camera.trim()) this.applyCameraSpec(data.camera, now, animate);
    this.publishOut();
    this.invalidate();
  };

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
    if (this.dirty || scene.nodes.active || this.camTween) this.raf = requestAnimationFrame(this.frame);
  };

  private drawFrame(scene: Scene2D, now: number): void {
    let busy = scene.nodes.step(now);
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
    if (this.dirty || busy) {
      this.dirty = false;
      scene.render();
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
    };
    const sig = JSON.stringify(next);
    if (sig === this.lastOut) return;
    this.lastOut = sig;
    set(out, next);
  }

  /* ------------------------------------------------------------ taps */

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.tap = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onUp = (e: PointerEvent) => {
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
    const hit = scene.pick(sx, sy, (n) => !re || re.test(n));
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const type = this.pickActionType || "pick";
    if (hit) dispatch(this.target, { type, payload: { objectId: hit.name, x: r2(hit.x), y: r2(hit.y) } });
    else if (this.pickEmpty) {
      const [x, y] = scene.worldPoint(sx, sy);
      dispatch(this.target, { type, payload: { objectId: null, x: r2(x), y: r2(y) } });
    }
  };
}

export default Sonic2d;
