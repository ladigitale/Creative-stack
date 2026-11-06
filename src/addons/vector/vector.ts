import { LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger } from "../../shared/media/control";
import { multiArea, multiBBox, type BBox, type Multi } from "./geometry";
import { boolean, fitMulti, offset, pathToMulti, roundedPath, simplifyMulti } from "./ops";
import { clipToView } from "./cull";
import { ringsToPath } from "./svgpath";
import { ShapeLibrary } from "./library";

export const VECTOR_OPS = ["union", "intersect", "difference", "xor", "offset", "simplify", "round", "fit", "clip"] as const;
export type VectorOp = (typeof VECTOR_OPS)[number];

export type VectorResult = { d: string; polygons: number; bbox: BBox; area: number; error: string | null };

const EMPTY: VectorResult = { d: "", polygons: 0, bbox: { x: 0, y: 0, w: 0, h: 0 }, area: 0, error: null };

/** Extrait un chemin `d` d'une valeur de DataProvider : chaîne, `{ d }` ou `{ shape: { d } }`. */
function dOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.d === "string") return o.d;
    if (o.shape && typeof (o.shape as Record<string, unknown>).d === "string") return (o.shape as { d: string }).d;
  }
  return "";
}

const multiToD = (m: Multi): string => ringsToPath(m.flatMap((poly) => poly));

/** Opération pure : `a` et `b` sont des chemins SVG. */
export function runVectorOp(op: string, a: string, b: string, o: { delta?: number; tolerance?: number; radius?: number; segments?: number; view?: BBox | null } = {}): VectorResult {
  if (!(VECTOR_OPS as readonly string[]).includes(op)) return { ...EMPTY, error: `opération inconnue : ${op}` };
  const A = pathToMulti(a);
  if (!A) return { ...EMPTY, error: "chemin a illisible" };
  const needB = op === "union" || op === "intersect" || op === "difference" || op === "xor";
  const B = b ? pathToMulti(b) : [];
  if (b && !B) return { ...EMPTY, error: "chemin b illisible" };
  let out: Multi;
  try {
    switch (op) {
      case "union": case "intersect": case "difference": case "xor":
        out = boolean(op, A, ...(needB && B ? [B] : []));
        break;
      case "offset": out = offset(A, o.delta ?? 1, o.segments ?? 8); break;
      case "simplify": out = simplifyMulti(A, o.tolerance ?? 1); break;
      case "clip": out = o.view ? clipToView(A, o.view) : A; break;
      case "round": {
        const d = A.flatMap((poly) => poly).map((r) => roundedPath(r, o.radius ?? 4)).join(" ");
        const m = pathToMulti(d) ?? [];
        return { d, polygons: m.length, bbox: multiBBox(m), area: multiArea(m), error: null };
      }
      case "fit": {
        const d = fitMulti(A, o.tolerance ?? 1);
        const m = pathToMulti(d) ?? [];
        return { d, polygons: m.length, bbox: multiBBox(m), area: multiArea(m), error: null };
      }
      default: out = A;
    }
  } catch (e) {
    return { ...EMPTY, error: e instanceof Error ? e.message : "échec de l'opération" };
  }
  return { d: multiToD(out), polygons: out.length, bbox: multiBBox(out), area: multiArea(out), error: null };
}

/**
 * Opération vectorielle sur chemins SVG : `union`, `intersect`, `difference`, `xor` (a ∘ b),
 * `offset` (décalage), `simplify`, `round` (coins arrondis), `fit` (courbes de Bézier), `clip` (découpe à `view`).
 * Entrées `a` / `b` : chemin DP (`{ d }` ou chaîne) ou attributs `a-d` / `b-d`. Résultat → `out-data-provider`.
 */
@customElement("sonic-vector-op")
export class SonicVectorOp extends LitElement {
  @property({ type: String }) op = "union";
  @property({ type: String }) a = "";
  @property({ type: String }) b = "";
  @property({ type: String, attribute: "a-d" }) aD = "";
  @property({ type: String, attribute: "b-d" }) bD = "";
  @property({ type: Number }) delta = 1;
  @property({ type: Number }) tolerance = 1;
  @property({ type: Number }) radius = 4;
  @property({ type: Number }) segments = 8;
  /** Chemin DP d'un rectangle `{ x, y, w, h }` (opération `clip`). */
  @property({ type: String }) view = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  private av: unknown = "";
  private bv: unknown = "";
  private vv: BBox | null = null;
  private unsubs: (() => void)[] = [];

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void { super.connectedCallback(); this.style.display = "none"; this.listen(); }
  disconnectedCallback(): void { this.drop(); super.disconnectedCallback(); }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("a") || c.has("b") || c.has("view")) this.listen();
    else this.compute();
  }

  private drop(): void { for (const u of this.unsubs) u(); this.unsubs = []; }

  private listen(): void {
    this.drop();
    if (this.a) this.unsubs.push(listenDp(this.a, (v) => { this.av = v; this.compute(); }));
    if (this.b) this.unsubs.push(listenDp(this.b, (v) => { this.bv = v; this.compute(); }));
    if (this.view) this.unsubs.push(listenDp(this.view, (v) => {
      const o = v as Record<string, unknown> | null;
      const n = (k: string) => Number(o?.[k]);
      this.vv = o && [n("x"), n("y"), n("w"), n("h")].every(Number.isFinite) ? { x: n("x"), y: n("y"), w: n("w"), h: n("h") } : null;
      this.compute();
    }));
    this.compute();
  }

  compute(): void {
    const a = this.aD || dOf(this.av);
    const b = this.bD || dOf(this.bv);
    const res = a ? runVectorOp(this.op, a, b, { delta: this.delta, tolerance: this.tolerance, radius: this.radius, segments: this.segments, view: this.vv }) : { ...EMPTY };
    this.result = res;
    if (this.outDataProvider) set(this.outDataProvider, res);
    this.dispatchEvent(new CustomEvent("vector-result", { detail: res, bubbles: true, composed: true }));
  }

  result: VectorResult = { ...EMPTY };
}

/**
 * Bibliothèque de formes vectorielles (chemins SVG nommés, étiquetés), pilotée par `control` :
 * `{ n, add: { id?, name, d, tags }, remove: id, clear: true, rename: { id, name }, load: [...] }` —
 * la commande n'est exécutée que si `n` augmente. État publié dans `out-data-provider`.
 */
@customElement("sonic-vector-library")
export class SonicVectorLibrary extends LitElement {
  @property({ type: String }) control = "";
  @property({ type: String }) filter = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  readonly library = new ShapeLibrary();
  private trigger = new CounterTrigger();
  private unsub: (() => void) | null = null;
  private lastError: string | null = null;

  createRenderRoot(): HTMLElement | ShadowRoot { return this; }

  connectedCallback(): void { super.connectedCallback(); this.style.display = "none"; this.listen(); this.publish(); }
  disconnectedCallback(): void { this.unsub?.(); this.unsub = null; super.disconnectedCallback(); }

  protected updated(c: Map<string | number | symbol, unknown>): void {
    if (c.has("control")) this.listen();
    if (c.has("filter") || c.has("outDataProvider")) this.publish();
  }

  private listen(): void {
    this.unsub?.();
    this.unsub = null;
    this.trigger.reset();
    if (this.control) this.unsub = listenDp(this.control, (v) => this.command(v));
  }

  command(v: unknown): void {
    if (!v || typeof v !== "object" || !this.trigger.feed(v)) return;
    const c = v as Record<string, unknown>;
    this.lastError = null;
    if (c.clear === true) this.library.clear();
    if (Array.isArray(c.load)) this.library.load(c.load);
    if (typeof c.remove === "string") this.library.remove(c.remove);
    if (c.rename && typeof c.rename === "object") {
      const r = c.rename as { id?: unknown; name?: unknown };
      if (typeof r.id === "string" && typeof r.name === "string") this.library.rename(r.id, r.name);
    }
    if (c.add !== undefined) {
      const res = this.library.add(c.add);
      if (res.error) this.lastError = res.error;
    }
    this.publish();
  }

  private publish(): void {
    const [tag, query] = this.filter.includes(":") ? [this.filter.split(":")[0], this.filter.split(":").slice(1).join(":")] : ["", this.filter];
    const shapes = this.library.list({ tag: tag || undefined, query: query || undefined });
    const state = { shapes, count: this.library.size, error: this.lastError };
    if (this.outDataProvider) set(this.outDataProvider, state);
    this.dispatchEvent(new CustomEvent("vector-library", { detail: state, bubbles: true, composed: true }));
  }
}
