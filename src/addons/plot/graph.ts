import { LitElement, css, html, nothing, svg, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp, plain } from "../../shared/audio/dp";
import { applyGestures, gestureMode, wheelToPage } from "../../shared/gestures";
import { dispatch } from "../interactive";
import { seriesColor } from "./layout";
import { ForceSim, normalizeGraph, sanitizeLayout, staticLayout, type GraphData, type GraphNodeIn, type LayoutKind } from "./force";

const tagName = "sonic-graph";

/** Positions publiées au plus (`publish-positions`). */
export const MAX_PUBLISHED_POSITIONS = 500;

export type GraphState = {
  /** `idle` (aucun nœud), `ready` (graphe dessiné), `error` (données en partie refusées, voir `error`). */
  status: "idle" | "ready" | "error";
  error: string | null;
  nodes: number;
  links: number;
  layout: LayoutKind;
  /** Température de la simulation (0 = posé). */
  alpha: number;
  settled: boolean;
  /** Nœud survolé, nœud choisi par tap (id), ou null. */
  hover: string | null;
  selected: string | null;
  /** `{id: [x, y]}` (coordonnées du graphe), seulement avec `publish-positions`. */
  positions?: Record<string, [number, number]>;
};

type Selection = { nodes: Set<string>; links: Set<string> };
const EMPTY_SEL: Selection = { nodes: new Set(), links: new Set() };
const linkKey = (a: string, b: string) => `${a}\u0000${b}`;

/**
 * Sélection lue dans un DataProvider : id, liste d'ids, `{id}`, `{ids: […]}`, ou résultat de `$graphPath`
 * (`{found, path: […]}`) : les nœuds du chemin et les liens entre nœuds consécutifs sont surlignés.
 */
export function readSelection(v: unknown): Selection {
  if (v === null || v === undefined || v === "") return EMPTY_SEL;
  const nodes = new Set<string>();
  const links = new Set<string>();
  const ids = (list: unknown[]) => list.filter((x) => x !== null && x !== undefined && typeof x !== "object").map(String);
  if (typeof v === "string" || typeof v === "number") nodes.add(String(v));
  else if (Array.isArray(v)) for (const id of ids(v)) nodes.add(id);
  else if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.path)) {
      const p = ids(o.path);
      p.forEach((id, i) => {
        nodes.add(id);
        if (i) {
          links.add(linkKey(p[i - 1], id));
          links.add(linkKey(id, p[i - 1]));
        }
      });
    }
    if (Array.isArray(o.ids)) for (const id of ids(o.ids)) nodes.add(id);
    if (o.id !== undefined && o.id !== null && typeof o.id !== "object") nodes.add(String(o.id));
  }
  return { nodes, links };
}

const numAttr = (v: number, fallback: number) => (Number.isFinite(v) && v !== 0 ? v : fallback);

/**
 * Graphe nœuds / liens en SVG, aux couleurs des design tokens Concorde (`--sc-*`), alimenté par DataProvider.
 *
 * Données (`data-provider`, relu en direct) : `{nodes: [{id, label?, group?, size?, x?, y?, fixed?}],
 * links: [{source, target, weight?, label?, directed?}]}`, ou la forme de `$graphPath` (`{edges: [[a, b, w]]}`,
 * liste d'adjacence). Placement `layout` : `force` (forces écrites à la main, Barnes-Hut au-delà de 300 nœuds,
 * graine `seed`), `circle`, `grid`, `tree` (couches depuis `root`). Un changement de données garde la position
 * des nœuds déjà présents.
 *
 * Interaction : glisser un nœud (figé pendant le glisser, et après avec `pin`), molette / pincement = zoom,
 * glisser le fond = déplacer la vue, double-clic sur le fond = recadrer ; tap sur un nœud → action `graph:select`
 * `{id, node}` vers le store `target` ; survol = voisins mis en avant. `selection` (chemin DP) surligne des nœuds
 * ou un chemin de `$graphPath`.
 */
@customElement(tagName)
export class SonicGraph extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      font-family: var(--sc-font-family-base, system-ui, sans-serif);
      color: var(--sc-base-content, currentColor);
      font-size: 12px;
      user-select: none;
      -webkit-user-select: none;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      margin: 0 0 6px;
      padding: 0;
      list-style: none;
    }
    .legend li {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .legend i {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }
    svg {
      display: block;
      width: 100%;
      overflow: hidden;
      outline: none;
      cursor: grab;
    }
    svg.panning {
      cursor: grabbing;
    }
    svg:focus-visible {
      outline: 2px solid var(--sc-primary, currentColor);
      outline-offset: 2px;
    }
    .link {
      stroke: var(--sc-base-400, #bbb);
      stroke-linecap: round;
      fill: none;
    }
    .arrow {
      fill: var(--sc-base-400, #bbb);
    }
    .link.hl {
      stroke: var(--sc-primary, currentColor);
    }
    .arrow.hl {
      fill: var(--sc-primary, currentColor);
    }
    .node {
      stroke: var(--sc-base, #fff);
      stroke-width: 1.5;
      cursor: pointer;
    }
    .node.sel {
      stroke: var(--sc-base-content, currentColor);
      stroke-width: 3;
    }
    .node.pinned {
      stroke-dasharray: 2 2;
    }
    .dim {
      opacity: 0.18;
    }
    text {
      fill: var(--sc-base-content, currentColor);
      font-size: 11px;
      pointer-events: none;
      paint-order: stroke;
      stroke: var(--sc-base, #fff);
      stroke-width: 3px;
      stroke-linejoin: round;
    }
    text.link-label {
      font-size: 10px;
      opacity: 0.75;
    }
    text.strong {
      font-weight: 600;
    }
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.6;
    }
  `;

  /** DP du graphe (relu en direct). */
  @property({ type: String, attribute: "data-provider" }) dataProvider = "";
  /** Graphe passé directement (prioritaire sur `data-provider`). */
  @property({ type: Object }) data: unknown = null;
  /** `force` (défaut), `circle`, `grid`, `tree`. */
  @property({ type: String }) layout = "force";
  /** Graine du placement initial (même graine = même dessin). */
  @property({ type: String }) seed = "1";
  /** Racine de `layout="tree"` (id du nœud). */
  @property({ type: String }) root = "";
  /** Répulsion entre nœuds (négative, défaut -60). */
  @property({ type: Number }) charge = 0;
  /** Longueur de repos des liens (défaut 40). */
  @property({ type: Number, attribute: "link-distance" }) linkDistance = 0;
  /** Attraction vers le centre, 0..1 (défaut 0.06). */
  @property({ type: Number }) gravity = -1;
  /** Hauteur en px (défaut 360). */
  @property({ type: Number }) height = 0;
  /** Tous les liens orientés (flèches), en plus de `directed` par lien. */
  @property({ type: Boolean }) directed = false;
  /** Un nœud glissé reste figé où on le lâche. */
  @property({ type: Boolean }) pin = false;
  /** `auto` (étiquettes jusqu'à 100 nœuds, sinon au survol), `always`, `none`. */
  @property({ type: String }) labels = "auto";
  /** Store qui reçoit l'action du tap sur un nœud. */
  @property({ type: String }) target = "";
  /** Type de l'action (défaut `graph:select`). */
  @property({ type: String }) action = "";
  /** Chemin DP de la sélection à surligner (id, liste d'ids, `{path}` de `$graphPath`). */
  @property({ type: String }) selection = "";
  /** Publie `positions` dans l'état (500 nœuds au plus). */
  @property({ type: Boolean, attribute: "publish-positions" }) publishPositions = false;
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";
  /** `auto`, `capture`, `cooperative` (voir les scènes 3D). */
  @property({ type: String }) gestures = "auto";

  @state() private width = 0;
  @state() private raw: unknown = null;
  @state() private sel: Selection = EMPTY_SEL;
  @state() private hoverId: string | null = null;
  @state() private frame = 0;

  /** Dernier état publié (lecture directe). */
  stateValue: GraphState = { status: "idle", error: null, nodes: 0, links: 0, layout: "force", alpha: 0, settled: true, hover: null, selected: null };

  private graph: GraphData = { nodes: [], links: [], errors: [] };
  private nodeIn = new Map<string, GraphNodeIn>();
  private sim: ForceSim | null = null;
  private simKey = "";
  private dataKey = "";
  private activeLayout: LayoutKind = "force";
  private pinned = new Set<string>();
  private selectedId: string | null = null;
  private view = { k: 1, tx: 0, ty: 0 };
  private userView = false;
  private raf = 0;
  private lastPublish = 0;
  private lastPublishedKey = "";
  private ro: ResizeObserver | null = null;
  private unsubs: (() => void)[] = [];
  private coop = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { id: number; node: number; sx: number; sy: number; moved: boolean } | null = null;
  private pan: { id: number; sx: number; sy: number; tx: number; ty: number } | null = null;
  private pinch: { d: number; k: number; cx: number; cy: number; tx: number; ty: number } | null = null;
  private groups = new Map<string, number>();
  private maxWeight = 1;
  private weightsVary = false;

  connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver === "function") {
      this.ro = new ResizeObserver((entries) => {
        const w = Math.round(entries[0]?.contentRect.width ?? 0);
        if (w && w !== this.width) this.width = w;
      });
      this.ro.observe(this);
    }
    this.width = Math.round(this.getBoundingClientRect().width) || this.width || 600;
  }

  disconnectedCallback(): void {
    this.ro?.disconnect();
    this.ro = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.stop();
    super.disconnectedCallback();
  }

  protected willUpdate(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("dataProvider") || changed.has("selection")) this.listen();
    if (changed.has("data") || changed.has("raw") || changed.has("directed")) this.loadGraph();
    else if (["layout", "seed", "root", "charge", "linkDistance", "gravity"].some((k) => changed.has(k))) this.loadGraph(true);
  }

  private listen(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.dataProvider) this.unsubs.push(listenDp(this.dataProvider, (v) => (this.raw = v)));
    if (this.selection) this.unsubs.push(listenDp(this.selection, (v) => (this.sel = readSelection(v))));
    else this.sel = EMPTY_SEL;
  }

  private height_(): number {
    return this.height > 0 ? this.height : 360;
  }

  /** (Re)lit les données ; `reset` repart d'une simulation neuve (graine, réglages ou placement changés). */
  private loadGraph(reset = false): void {
    const g = normalizeGraph(plain(this.data ?? this.raw));
    if (this.directed) for (const l of g.links) l.directed = true;
    // Données republiées à l'identique (un store republie tout son état à chaque action) : rien à relancer.
    const dataKey = JSON.stringify(g);
    if (!reset && this.sim && dataKey === this.dataKey && this.layoutKey() === this.simKey) return;
    this.dataKey = dataKey;
    this.graph = g;
    this.nodeIn = new Map(g.nodes.map((n) => [n.id, n]));
    this.groups = new Map();
    for (const n of g.nodes) if (n.group !== undefined && !this.groups.has(n.group)) this.groups.set(n.group, this.groups.size);
    const ws = g.links.map((l) => Math.abs(l.weight ?? 1));
    this.maxWeight = Math.max(1e-9, ...ws, 0);
    this.weightsVary = ws.some((w) => w !== ws[0]);
    const layout = sanitizeLayout(this.layout);
    const key = this.layoutKey();
    if (reset || key !== this.simKey || !this.sim) {
      this.sim = new ForceSim({
        seed: this.seed || 1,
        charge: numAttr(this.charge, -60),
        linkDistance: numAttr(this.linkDistance, 40),
        gravity: this.gravity >= 0 ? this.gravity : 0.06,
      });
      this.simKey = key;
      this.userView = false;
      this.pinned.clear();
    }
    this.activeLayout = layout;
    const sim = this.sim;
    const kept = sim.setGraph(g);
    for (const n of sim.nodes) {
      const d = this.nodeIn.get(n.id)!;
      if (d.fixed && d.x !== undefined && d.y !== undefined) continue;
      if (!this.pinned.has(n.id)) n.fx = n.fy = null;
    }
    for (const id of [...this.pinned]) if (!this.nodeIn.has(id)) this.pinned.delete(id);
    if (this.hoverId && !this.nodeIn.has(this.hoverId)) this.hoverId = null;
    if (layout === "force") {
      sim.alpha = 0;
      sim.reheat(kept ? 0.5 : 1);
      if (!kept) this.warm(30);
      this.start();
    } else {
      const pos = staticLayout(layout, g, { root: this.root || undefined, spacing: numAttr(this.linkDistance, 50) });
      for (const n of sim.nodes) {
        const p = pos.get(n.id)!;
        const keep = n.fx !== null && n.fy !== null;
        n.x = keep ? n.fx! : p[0];
        n.y = keep ? n.fy! : p[1];
        n.vx = n.vy = 0;
      }
      sim.alpha = 0;
      this.stop();
    }
    this.frame++;
  }

  private layoutKey(): string {
    return `${sanitizeLayout(this.layout)}|${this.seed}|${this.charge}|${this.linkDistance}|${this.gravity}|${this.root}`;
  }

  /** Avance la simulation sans dessiner pendant au plus `ms` (le premier dessin est déjà presque posé). */
  private warm(ms: number): void {
    const sim = this.sim;
    if (!sim) return;
    const t0 = performance.now();
    while (!sim.settled && performance.now() - t0 < ms) sim.tick(5);
  }

  /** Avance la simulation jusqu'au repos (ou `maxTicks` pas) : utile aux tests et aux captures. */
  settle(maxTicks = 1000): void {
    const sim = this.sim;
    if (!sim || this.activeLayout !== "force") return;
    for (let i = 0; i < maxTicks && !sim.settled; i++) sim.tick();
    this.frame++;
  }

  /** Positions courantes `{id: [x, y]}` (coordonnées du graphe). */
  positions(limit = Infinity): Record<string, [number, number]> {
    const out: Record<string, [number, number]> = {};
    let i = 0;
    for (const n of this.sim?.nodes ?? []) {
      if (i++ >= limit) break;
      out[n.id] = [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10];
    }
    return out;
  }

  private start(): void {
    if (this.raf || !this.isConnected) return;
    const step = () => {
      this.raf = 0;
      const sim = this.sim;
      if (!sim || this.activeLayout !== "force" || sim.settled) {
        this.frame++;
        return;
      }
      sim.tick(sim.nodes.length > 1000 ? 1 : 2);
      this.frame++;
      this.raf = schedule(step);
    };
    this.raf = schedule(step);
  }

  private stop(): void {
    if (this.raf) cancel(this.raf);
    this.raf = 0;
  }

  /* ———————— vue ———————— */

  private fit(): void {
    const nodes = this.sim?.nodes ?? [];
    const W = this.width || 600, H = this.height_();
    if (!nodes.length) {
      this.view = { k: 1, tx: W / 2, ty: H / 2 };
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x - n.r);
      y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r);
      y1 = Math.max(y1, n.y + n.r);
    }
    const pad = 24;
    const k = Math.min(2, (W - pad * 2) / Math.max(x1 - x0, 1), (H - pad * 2) / Math.max(y1 - y0, 1));
    this.view = { k, tx: W / 2 - ((x0 + x1) / 2) * k, ty: H / 2 - ((y0 + y1) / 2) * k };
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.renderRoot.querySelector("svg")?.getBoundingClientRect();
    return r ? [e.clientX - r.left, e.clientY - r.top] : [e.clientX, e.clientY];
  }

  private toWorld(px: number, py: number): [number, number] {
    const { k, tx, ty } = this.view;
    return [(px - tx) / k, (py - ty) / k];
  }

  private zoomAt(px: number, py: number, k: number): void {
    const v = this.view;
    const nk = Math.min(8, Math.max(0.05, k));
    const [wx, wy] = this.toWorld(px, py);
    this.view = { k: nk, tx: px - wx * nk, ty: py - wy * nk };
    this.userView = true;
    if (v.k !== nk) this.frame++;
  }

  private nodeAt(e: Event): number {
    const t = e.target as Element | null;
    const v = t?.getAttribute?.("data-i");
    return v === null || v === undefined ? -1 : Number(v);
  }

  private onDown = (e: PointerEvent) => {
    const svgEl = e.currentTarget as SVGSVGElement;
    const [px, py] = this.local(e);
    this.pointers.set(e.pointerId, { x: px, y: py });
    try {
      svgEl.setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom, pointeur déjà relâché */
    }
    if (this.pointers.size === 2) {
      // Deuxième doigt : pincement (annule glisser / déplacement).
      this.releaseDrag(false);
      this.pan = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: this.view.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, tx: this.view.tx, ty: this.view.ty };
      return;
    }
    if (this.pointers.size > 2) return;
    const i = this.nodeAt(e);
    const sim = this.sim;
    if (i >= 0 && sim?.nodes[i]) {
      const n = sim.nodes[i];
      this.drag = { id: e.pointerId, node: i, sx: px, sy: py, moved: false };
      n.fx = n.x;
      n.fy = n.y;
      this.hoverId = n.id;
    } else {
      this.pan = { id: e.pointerId, sx: px, sy: py, tx: this.view.tx, ty: this.view.ty };
    }
  };

  private onMove = (e: PointerEvent) => {
    const [px, py] = this.local(e);
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = px;
      p.y = py;
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const c = this.pinch;
      const k = Math.min(8, Math.max(0.05, (c.k * d) / c.d));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // Point du graphe sous le centre initial, gardé sous le centre courant.
      const wx = (c.cx - c.tx) / c.k, wy = (c.cy - c.ty) / c.k;
      this.view = { k, tx: mx - wx * k, ty: my - wy * k };
      this.userView = true;
      this.frame++;
      return;
    }
    const dr = this.drag;
    if (dr && dr.id === e.pointerId) {
      if (!dr.moved && Math.hypot(px - dr.sx, py - dr.sy) < 4) return;
      dr.moved = true;
      const n = this.sim?.nodes[dr.node];
      if (!n) return;
      const [wx, wy] = this.toWorld(px, py);
      n.fx = n.x = wx;
      n.fy = n.y = wy;
      if (this.activeLayout === "force" && this.sim) {
        this.sim.alphaTarget = 0.3;
        this.sim.reheat(0.3);
        this.start();
      }
      this.userView = true;
      this.frame++;
      return;
    }
    const pn = this.pan;
    if (pn && pn.id === e.pointerId) {
      this.view = { ...this.view, tx: pn.tx + px - pn.sx, ty: pn.ty + py - pn.sy };
      if (Math.hypot(px - pn.sx, py - pn.sy) > 2) this.userView = true;
      this.frame++;
      return;
    }
    if (!this.pointers.size) {
      const i = this.nodeAt(e);
      const id = i >= 0 ? (this.sim?.nodes[i]?.id ?? null) : null;
      if (id !== this.hoverId) this.hoverId = id;
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    const dr = this.drag;
    if (dr && dr.id === e.pointerId) {
      if (!dr.moved && e.type === "pointerup") this.tap(dr.node);
      this.releaseDrag(dr.moved);
    }
    if (this.pan?.id === e.pointerId) this.pan = null;
    if (e.pointerType !== "mouse") this.hoverId = null;
  };

  private releaseDrag(moved: boolean): void {
    const dr = this.drag;
    this.drag = null;
    if (!dr) return;
    const n = this.sim?.nodes[dr.node];
    if (!n) return;
    const d = this.nodeIn.get(n.id);
    const fixedByData = !!(d?.fixed && d.x !== undefined && d.y !== undefined);
    if (moved && this.pin) this.pinned.add(n.id);
    if (!fixedByData && !this.pinned.has(n.id)) n.fx = n.fy = null;
    if (this.sim) this.sim.alphaTarget = 0;
    this.frame++;
  }

  private tap(i: number): void {
    const n = this.sim?.nodes[i];
    if (!n) return;
    this.selectedId = n.id;
    if (this.target) dispatch(this.target, { type: this.action || "graph:select", payload: { id: n.id, node: { ...this.nodeIn.get(n.id) } } });
    this.frame++;
  }

  private onWheel = (e: WheelEvent) => {
    if (wheelToPage(this.coop, e)) return;
    e.preventDefault();
    const [px, py] = this.local(e);
    const f = Math.exp(-Math.max(-50, Math.min(50, e.deltaY * (e.deltaMode === 1 ? 16 : 1))) * 0.002);
    this.zoomAt(px, py, this.view.k * f);
  };

  private onDbl = (e: MouseEvent) => {
    if (this.nodeAt(e) >= 0) return;
    this.userView = false;
    this.frame++;
  };

  /* ———————— état ———————— */

  private publish(force = false): void {
    const sim = this.sim;
    const g = this.graph;
    const error = g.errors.length ? g.errors.join(" ; ") : null;
    const s: GraphState = {
      status: error ? "error" : g.nodes.length ? "ready" : "idle",
      error,
      nodes: g.nodes.length,
      links: g.links.length,
      layout: this.activeLayout,
      alpha: Math.round((sim?.alpha ?? 0) * 1000) / 1000,
      settled: this.activeLayout !== "force" || !sim || sim.settled,
      hover: this.hoverId,
      selected: this.selectedId,
    };
    if (this.publishPositions) s.positions = this.positions(MAX_PUBLISHED_POSITIONS);
    const key = `${s.status}|${s.error}|${s.nodes}|${s.links}|${s.layout}|${s.settled}|${s.hover}|${s.selected}`;
    const now = performance.now();
    // Pendant la simulation : au plus 4 fois par seconde ; tout de suite si autre chose change.
    if (!force && key === this.lastPublishedKey && (s.settled || now - this.lastPublish < 250)) return;
    this.lastPublishedKey = key;
    this.lastPublish = now;
    this.stateValue = s;
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (out) set(out, s);
  }

  protected firstUpdated(): void {
    this.coop = applyGestures(this, [this.renderRoot.querySelector("svg") as unknown as HTMLElement | null], gestureMode(this.gestures));
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("gestures")) this.coop = applyGestures(this, [this.renderRoot.querySelector("svg") as unknown as HTMLElement | null], gestureMode(this.gestures));
    this.publish(changed.has("outDataProvider") || changed.has("publishPositions"));
  }

  /* ———————— rendu ———————— */

  private color(group: string | undefined): string {
    return seriesColor(group === undefined ? 0 : (this.groups.get(group) ?? 0));
  }

  render() {
    const H = this.height_();
    const W = this.width || 600;
    const sim = this.sim;
    const nodes = sim?.nodes ?? [];
    if (!nodes.length) return html`<div class="empty" style="height:${H}px" part="empty">Aucun nœud</div>`;
    if (!this.userView) this.fit();
    const { k, tx, ty } = this.view;
    const sx = (x: number) => x * k + tx;
    const sy = (y: number) => y * k + ty;
    const g = this.graph;
    const idx = (id: string) => sim!.indexOf(id);

    // Mise en avant : nœud survolé + voisins.
    const focus = this.hoverId;
    let near: Set<string> | null = null;
    if (focus) {
      near = new Set([focus]);
      for (const l of g.links) {
        if (l.source === focus) near.add(l.target);
        if (l.target === focus) near.add(l.source);
      }
    }
    const sel = this.sel;
    const showAll = this.labels === "always" || (this.labels !== "none" && nodes.length <= 100);
    const showLinkLabels = this.labels !== "none" && (this.labels === "always" || g.links.length <= 60);

    const linkMarks: TemplateResult[] = [];
    const linkTexts: TemplateResult[] = [];
    for (const l of g.links) {
      const si = idx(l.source), ti = idx(l.target);
      if (si === undefined || ti === undefined) continue;
      const a = nodes[si], b = nodes[ti];
      const x1 = sx(a.x), y1 = sy(a.y), x2 = sx(b.x), y2 = sy(b.y);
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const ux = dx / len, uy = dy / len;
      const hl = sel.links.has(linkKey(l.source, l.target));
      const touch = near ? near.has(l.source) && near.has(l.target) && (l.source === focus || l.target === focus) : true;
      const cls = `${hl ? "hl" : ""} ${touch ? "" : "dim"}`;
      const w = this.weightsVary ? 1 + 3 * Math.sqrt(Math.abs(l.weight ?? 1) / this.maxWeight) : 1.5;
      const rs = a.r * k, rt = b.r * k;
      const ax = x1 + ux * rs, ay = y1 + uy * rs;
      let ex = x2 - ux * rt, ey = y2 - uy * rt;
      if (l.directed) {
        const ah = 6 + w * 1.5, aw = 3 + w;
        const tipX = ex, tipY = ey;
        ex = tipX - ux * ah;
        ey = tipY - uy * ah;
        linkMarks.push(svg`<line class="link ${cls}" x1=${ax} y1=${ay} x2=${ex} y2=${ey} stroke-width=${w} />`);
        linkMarks.push(svg`<path class="arrow ${cls}" d=${`M${tipX},${tipY}L${ex - uy * aw},${ey + ux * aw}L${ex + uy * aw},${ey - ux * aw}Z`} />`);
      } else linkMarks.push(svg`<line class="link ${cls}" x1=${ax} y1=${ay} x2=${ex} y2=${ey} stroke-width=${w} />`);
      if (l.label && (showLinkLabels || (focus && touch && near))) {
        linkTexts.push(svg`<text class="link-label ${touch ? "" : "dim"}" x=${(x1 + x2) / 2} y=${(y1 + y2) / 2 - 3} text-anchor="middle">${l.label}</text>`);
      }
    }

    const nodeMarks: TemplateResult[] = [];
    const nodeTexts: TemplateResult[] = [];
    nodes.forEach((n, i) => {
      const d = this.nodeIn.get(n.id);
      const x = sx(n.x), y = sy(n.y), r = Math.max(1.5, n.r * k);
      const selected = sel.nodes.has(n.id);
      const dim = near ? !near.has(n.id) : false;
      const pinned = this.pinned.has(n.id);
      nodeMarks.push(
        svg`<circle class="node ${selected ? "sel" : ""} ${pinned ? "pinned" : ""} ${dim ? "dim" : ""}" data-i=${i} cx=${x} cy=${y} r=${r} fill=${this.color(d?.group)}><title>${d?.label ?? n.id}</title></circle>`,
      );
      if (showAll || selected || (near && near.has(n.id))) {
        nodeTexts.push(svg`<text class="${selected || n.id === focus ? "strong" : ""} ${dim ? "dim" : ""}" x=${x} y=${y + r + 12} text-anchor="middle">${d?.label ?? n.id}</text>`);
      }
    });

    const legend = this.groups.size > 1 ? [...this.groups.entries()] : [];
    const summary = `Graphe, ${g.nodes.length} nœud${g.nodes.length > 1 ? "s" : ""}, ${g.links.length} lien${g.links.length > 1 ? "s" : ""}`;
    return html`
      ${legend.length ? html`<ul class="legend" part="legend">${legend.map(([name, i]) => html`<li><i style="background:${seriesColor(i)}"></i>${name}</li>`)}</ul>` : nothing}
      <svg
        class=${this.pan && this.userView ? "panning" : ""}
        viewBox="0 0 ${W} ${H}"
        height=${H}
        role="img"
        aria-label=${summary}
        tabindex="0"
        @pointerdown=${this.onDown}
        @pointermove=${this.onMove}
        @pointerup=${this.onUp}
        @pointercancel=${this.onUp}
        @pointerleave=${() => {
          if (!this.pointers.size) this.hoverId = null;
        }}
        @wheel=${this.onWheel}
        @dblclick=${this.onDbl}
      >
        <g part="links">${linkMarks}</g>
        <g part="nodes">${nodeMarks}</g>
        <g part="labels">${linkTexts}${nodeTexts}</g>
      </svg>
    `;
  }
}

const schedule = (f: () => void): number => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : (setTimeout(f, 16) as unknown as number));
const cancel = (h: number): void => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(h) : clearTimeout(h));

export default SonicGraph;
