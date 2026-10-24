import { LitElement, css, html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { HTML, PublisherManager } from "@supersoniks/concorde/utils";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch } from "../interactive";
import { TAP_MAX_MOVE_PX, TAP_MAX_MS, namesRegex } from "../../shared/nodes";
import { StageNodes, type StageLayout } from "./stage-core";

const tagName = "sonic-stage";

type Publisher = {
  get(): unknown;
  onAssign(handler: (v: unknown) => void, directHandlerCall?: boolean): void;
  offAssign(handler: (v: unknown) => void): void;
  onInternalMutation(handler: VoidFunction): void;
  offInternalMutation(handler: VoidFunction): void;
};

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function reducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Scène 2D en DOM : place ses éléments (HTML, SVG) d'après la clé `nodes` de son DataProvider,
 * au format `nodes` partagé avec `sonic-3d` (src/shared/nodes.ts).
 *
 * Rôles : le SDUI crée les éléments (et sonic-list / sonic-states / sonic-if les font apparaître ou
 * disparaître), un producteur écrit `nodes` (sonic-physics, sonic-store, sonic-timeline, sonic-p2p),
 * sonic-stage ne fait que les placer, et envoie les taps (coordonnées de scène) à un sonic-store.
 */
@customElement(tagName)
export class SonicStage extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
    }
    :host([data-scaled]) {
      overflow: hidden;
      aspect-ratio: var(--sonic-stage-ar);
    }
    .layer {
      position: relative;
    }
    :host([data-scaled]) .layer {
      position: absolute;
      left: 0;
      top: 0;
      width: var(--sonic-stage-w);
      height: var(--sonic-stage-h);
      transform-origin: 0 0;
      transform: scale(var(--sonic-stage-k, 1));
    }
  `;

  /** DataProvider lu (clé `nodes`) ; sinon celui d'un ancêtre, comme les autres composants Concorde. */
  @property({ type: String }) dataProvider = "";
  /** Taille logique de la scène (unités de `nodes`) ; avec les deux, la scène est mise à l'échelle de sa largeur. */
  @property({ type: Number }) width = 0;
  @property({ type: Number }) height = 0;
  /** `absolute` (défaut avec width/height) : (x, y) = centre de l'élément dans la scène. `offset` : décalage depuis sa place. */
  @property({ type: String }) layout: StageLayout | "" = "";
  /** Id du sonic-store qui reçoit les taps. */
  @property({ type: String }) target = "";
  @property({ type: String, attribute: "pick-action-type" }) pickActionType = "";
  /** Regex sur le nom du nœud tapé (`id` ou `data-node-id`) ; les autres taps sont ignorés. */
  @property({ type: String, attribute: "pick-names" }) pickNames = "";
  /** Envoie aussi les taps hors nœud : `{objectId: null, x, y}`. */
  @property({ type: Boolean, attribute: "pick-empty" }) pickEmpty = false;
  /** DataProvider où publier `{ count, missing }`. */
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private nodes = new StageNodes({ resolve: (n) => this.resolve(n) });
  private cache = new Map<string, Element[]>();
  private publisher: Publisher | null = null;
  private observer: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private refreshQueued = false;
  private raf = 0;
  private tap: { x: number; y: number; t: number } | null = null;
  private lastOut = "";

  /** Facteur d'échelle courant (largeur affichée / largeur logique). */
  get scaleFactor(): number {
    if (!(this.width > 0 && this.height > 0)) return 1;
    const w = this.clientWidth || this.width;
    return w / this.width;
  }

  /** État courant d'un nœud (tests, atelier). */
  nodeState(name: string) {
    return this.nodes.state(name);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("pointerdown", this.onDown);
    this.addEventListener("pointerup", this.onUp);
    if (typeof MutationObserver !== "undefined") {
      this.observer = new MutationObserver(() => this.queueRefresh());
      this.observer.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ["id", "data-node-id"] });
    }
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.syncScale());
      this.resizeObserver.observe(this);
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    this.bind();
  }

  disconnectedCallback(): void {
    this.unbind();
    this.removeEventListener("pointerdown", this.onDown);
    this.removeEventListener("pointerup", this.onUp);
    this.observer?.disconnect();
    this.observer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("width") || changed.has("height") || changed.has("layout")) {
      const scaled = this.width > 0 && this.height > 0;
      this.toggleAttribute("data-scaled", scaled);
      this.style.setProperty("--sonic-stage-w", `${this.width}px`);
      this.style.setProperty("--sonic-stage-h", `${this.height}px`);
      this.style.setProperty("--sonic-stage-ar", `${this.width} / ${this.height}`);
      this.nodes.layout = this.layout === "offset" || this.layout === "absolute" ? this.layout : scaled ? "absolute" : "offset";
      this.syncScale();
      this.nodes.renderAll();
    }
    if (changed.has("dataProvider") && this.isConnected) this.bind();
  }

  render() {
    return html`<div class="layer" part="layer"><slot></slot></div>`;
  }

  /* ------------------------------------------------------------ données */

  private onData = () => {
    const data = this.publisher?.get() as Record<string, unknown> | null | undefined;
    const spec = data && typeof data === "object" ? data.nodes : undefined;
    if (spec === undefined) return;
    const animate = !reducedMotion() && document.visibilityState !== "hidden";
    this.nodes.apply(spec, performance.now(), animate);
    this.loop();
    this.publishOut();
  };

  private bind(): void {
    this.unbind();
    const id = this.dataProvider.trim() || HTML.getAncestorAttributeValue(this.parentElement, "dataProvider") || "";
    if (!id) return;
    const pub = PublisherManager.get(id) as unknown as Publisher;
    this.publisher = pub;
    // Un producteur peut tout réassigner (physique, store) ou patcher un chemin (`scene.nodes.titre.x`).
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

  private publishOut(): void {
    const out = this.outDataProvider.trim();
    if (!out) return;
    const next = { count: this.nodes.names.length, missing: this.nodes.missing };
    const sig = JSON.stringify(next);
    if (sig === this.lastOut) return;
    this.lastOut = sig;
    set(out, next);
  }

  /* ------------------------------------------------------------ rendu */

  private loop(): void {
    if (this.raf || !this.nodes.active) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.nodes.step(now)) this.raf = requestAnimationFrame(this.frame);
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") this.nodes.finish();
  };

  private syncScale(): void {
    this.style.setProperty("--sonic-stage-k", String(this.scaleFactor));
  }

  /** Éléments d'un nœud : descendants de la scène par `data-node-id` ou `id`. */
  private resolve(name: string): Element[] {
    const hit = this.cache.get(name);
    if (hit) return hit;
    let els: Element[] = [];
    try {
      els = [...this.querySelectorAll(`[data-node-id="${esc(name)}"], [id="${esc(name)}"]`)];
    } catch {
      els = [];
    }
    this.cache.set(name, els);
    return els;
  }

  /** Arbre modifié (SDUI, sonic-list, sonic-states…) : les nouveaux éléments reçoivent l'état de leur nœud. */
  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      this.cache.clear();
      this.nodes.prune();
      this.nodes.renderAll();
    });
  }

  /* ------------------------------------------------------------ taps */

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.tap = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onUp = (e: PointerEvent) => {
    const start = this.tap;
    this.tap = null;
    if (!start || e.button !== 0 || !this.target) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= TAP_MAX_MOVE_PX) return;
    if (performance.now() - start.t >= TAP_MAX_MS) return;
    const rect = this.getBoundingClientRect();
    const k = this.scaleFactor || 1;
    const x = Math.round(((e.clientX - rect.left) / k) * 100) / 100;
    const y = Math.round(((e.clientY - rect.top) / k) * 100) / 100;
    const name = this.pickedName(e);
    const type = this.pickActionType || "pick";
    if (name) dispatch(this.target, { type, payload: { objectId: name, x, y } });
    else if (this.pickEmpty) dispatch(this.target, { type, payload: { objectId: null, x, y } });
  };

  /** Premier ancêtre nommé de la cible du tap (dans la scène) qui passe `pick-names`. */
  private pickedName(e: Event): string | null {
    const re = namesRegex(this.pickNames);
    for (const n of e.composedPath()) {
      if (n === this) break;
      if (!(n instanceof Element)) continue;
      const name = n.getAttribute("data-node-id") || n.id;
      if (name && (!re || re.test(name))) return name;
    }
    return null;
  }
}

export default SonicStage;
