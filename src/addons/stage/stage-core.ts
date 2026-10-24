/**
 * Application du format `nodes` partagé (src/shared/nodes.ts) à des éléments HTML / SVG.
 * Aucun élément n'est créé ni supprimé ici : c'est le rôle du SDUI (et de sonic-list / sonic-states / sonic-if).
 * Un élément qui apparaît reçoit aussitôt le dernier état de son nœud ; un élément qui disparaît est oublié.
 */
import {
  MAX_NODES_PER_MUTATION,
  easeCurve,
  isNum,
  patchOf,
  scaleXY,
  type NodeCurve,
  type NodePatch,
} from "../../shared/nodes";

export type StageLayout = "absolute" | "offset";

/** État affiché d'un nœud (seuls les champs déjà reçus sont présents). */
export type NodeState = {
  x?: number;
  y?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  opacity?: number;
  z?: number;
  visible?: boolean;
  color?: string;
};

type Channel = "x" | "y" | "rz" | "sx" | "sy" | "opacity";
const CHANNELS: Channel[] = ["x", "y", "rz", "sx", "sy", "opacity"];
const DEFAULTS: Record<Channel, number> = { x: 0, y: 0, rz: 0, sx: 1, sy: 1, opacity: 1 };

type Tween = { start: number; ms: number; curve: NodeCurve; from: Partial<Record<Channel, number>>; to: Partial<Record<Channel, number>> };

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const DEG = 180 / Math.PI;

function isSvgChild(el: Element): boolean {
  return typeof SVGElement !== "undefined" && el instanceof SVGElement && el.tagName.toLowerCase() !== "svg";
}

/** Écrit l'état d'un nœud sur un élément. Ne touche qu'aux propriétés que le nœud a reçues. */
export function writeElement(el: Element, st: NodeState, layout: StageLayout): void {
  const hasPos = st.x !== undefined || st.y !== undefined;
  const hasRot = st.rz !== undefined;
  const hasScale = st.sx !== undefined || st.sy !== undefined;
  if (isSvgChild(el)) {
    // SVG : unités du viewBox, le dessin est centré sur son origine (0, 0).
    const parts: string[] = [];
    if (hasPos) parts.push(`translate(${r3(st.x ?? 0)} ${r3(st.y ?? 0)})`);
    if (hasRot) parts.push(`rotate(${r3((st.rz ?? 0) * DEG)})`);
    if (hasScale) parts.push(`scale(${r3(st.sx ?? 1)} ${r3(st.sy ?? 1)})`);
    if (parts.length) el.setAttribute("transform", parts.join(" "));
    if (st.opacity !== undefined) el.setAttribute("opacity", String(r3(st.opacity)));
    if (st.visible !== undefined) el.setAttribute("visibility", st.visible ? "visible" : "hidden");
    if (st.color !== undefined) el.setAttribute("fill", st.color);
    return;
  }
  const style = (el as HTMLElement).style;
  if (!style) return;
  const parts: string[] = [];
  if (layout === "absolute") {
    // Le point (x, y) de la scène est le centre de l'élément (comme un corps physique).
    if (style.position !== "absolute") {
      style.position = "absolute";
      style.left = "0";
      style.top = "0";
    }
    parts.push(`translate(${r3(st.x ?? 0)}px, ${r3(st.y ?? 0)}px)`, "translate(-50%, -50%)");
  } else if (hasPos) {
    // Décalage depuis la place donnée par la mise en page (comme sonic-timeline).
    parts.push(`translate(${r3(st.x ?? 0)}px, ${r3(st.y ?? 0)}px)`);
  }
  if (hasRot) parts.push(`rotate(${r3(st.rz ?? 0)}rad)`);
  if (hasScale) parts.push(`scale(${r3(st.sx ?? 1)}, ${r3(st.sy ?? 1)})`);
  if (parts.length) style.transform = parts.join(" ");
  if (st.opacity !== undefined) style.opacity = String(r3(st.opacity));
  if (st.visible !== undefined) style.visibility = st.visible ? "" : "hidden";
  if (st.z !== undefined) style.zIndex = String(Math.round(st.z));
  if (st.color !== undefined) style.color = st.color;
}

/** Retire ce que writeElement a posé (`$reset`). */
export function clearElement(el: Element): void {
  if (isSvgChild(el)) {
    for (const a of ["transform", "opacity", "visibility", "fill"]) el.removeAttribute(a);
    return;
  }
  const style = (el as HTMLElement).style;
  if (!style) return;
  for (const p of ["transform", "opacity", "visibility", "z-index", "color", "position", "left", "top"]) style.removeProperty(p);
}

/** Cible d'un patch : canaux numériques interpolables et champs discrets. */
function targetsOf(p: NodePatch): { num: Partial<Record<Channel, number>>; discrete: NodeState } {
  const num: Partial<Record<Channel, number>> = {};
  if (isNum(p.x)) num.x = p.x;
  if (isNum(p.y)) num.y = p.y;
  if (isNum(p.rz)) num.rz = p.rz;
  const s = scaleXY(p.scale);
  if (s) [num.sx, num.sy] = s;
  if (isNum(p.opacity)) num.opacity = Math.max(0, Math.min(1, p.opacity));
  const discrete: NodeState = {};
  if (isNum(p.z)) discrete.z = p.z;
  if (typeof p.visible === "boolean") discrete.visible = p.visible;
  if (typeof p.color === "string") discrete.color = p.color;
  else if (isNum(p.color)) discrete.color = `#${(p.color & 0xffffff).toString(16).padStart(6, "0")}`;
  return { num, discrete };
}

export type StageNodesOptions = {
  /** Éléments d'un nœud (recherche dans la scène, mise en cache par l'appelant). */
  resolve: (name: string) => Element[];
  layout?: StageLayout;
};

/**
 * État des nœuds d'une scène 2D : patchs reçus, interpolations, rendu.
 * `apply` puis `step(now)` tant que `active` (une boucle rAF côté élément, arrêtée sinon).
 */
export class StageNodes {
  private states = new Map<string, NodeState>();
  private sigs = new Map<string, string>();
  private tweens = new Map<string, Tween>();
  private touched = new Set<Element>();
  layout: StageLayout;
  /** Noms sans élément lors de la dernière application. */
  missing = 0;

  constructor(private opts: StageNodesOptions) {
    this.layout = opts.layout ?? "absolute";
  }

  get active(): boolean {
    return this.tweens.size > 0;
  }

  get names(): string[] {
    return [...this.states.keys()];
  }

  state(name: string): NodeState | undefined {
    return this.states.get(name);
  }

  /** Applique un objet `nodes`. `animate=false` ignore `ease` (mouvement réduit, onglet caché). */
  apply(spec: unknown, now: number, animate = true): void {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return;
    const rec = spec as Record<string, unknown>;
    if (rec.$reset === true) this.reset();
    this.missing = 0;
    let count = 0;
    for (const [name, raw] of Object.entries(rec)) {
      if (name === "$reset") continue;
      const p = patchOf(raw);
      if (!p) continue;
      if (++count > MAX_NODES_PER_MUTATION) break;
      // Republier la même valeur ne fait rien (une source à 30 Hz republie tous les nœuds).
      const sig = JSON.stringify(p);
      if (this.sigs.get(name) === sig) {
        if (!this.opts.resolve(name).length) this.missing++;
        continue;
      }
      this.sigs.set(name, sig);
      this.applyOne(name, p, now, animate);
      if (!this.opts.resolve(name).length) this.missing++;
    }
  }

  private applyOne(name: string, p: NodePatch, now: number, animate: boolean): void {
    const st = this.states.get(name) ?? {};
    this.states.set(name, st);
    const { num, discrete } = targetsOf(p);
    Object.assign(st, discrete);
    const ms = animate && isNum(p.ease?.ms) ? Math.max(0, p.ease!.ms!) : 0;
    const prev = this.tweens.get(name);
    if (ms > 0 && Object.keys(num).length) {
      const from: Partial<Record<Channel, number>> = {};
      for (const c of Object.keys(num) as Channel[]) from[c] = st[c] ?? DEFAULTS[c];
      // Une interpolation en cours garde ses autres canaux jusqu'à leur cible.
      const to = { ...(prev?.to ?? {}), ...num };
      for (const c of Object.keys(prev?.to ?? {}) as Channel[]) if (!(c in num)) from[c] = st[c] ?? DEFAULTS[c];
      this.tweens.set(name, { start: now, ms, curve: p.ease?.curve ?? "linear", from, to });
    } else {
      if (prev) {
        for (const c of Object.keys(num) as Channel[]) delete prev.to[c];
        if (!Object.keys(prev.to).length) this.tweens.delete(name);
      }
      Object.assign(st, num);
    }
    this.render(name);
  }

  /** Avance les interpolations. Retourne true s'il en reste. */
  step(now: number): boolean {
    for (const [name, tw] of this.tweens) {
      const st = this.states.get(name);
      if (!st) {
        this.tweens.delete(name);
        continue;
      }
      const k = tw.ms > 0 ? Math.min(1, Math.max(0, (now - tw.start) / tw.ms)) : 1;
      const e = easeCurve(tw.curve, k);
      for (const c of CHANNELS) {
        const to = tw.to[c];
        if (to === undefined) continue;
        const from = tw.from[c] ?? to;
        st[c] = from + (to - from) * e;
      }
      if (k >= 1) this.tweens.delete(name);
      this.render(name);
    }
    return this.active;
  }

  /** Fin immédiate des interpolations (onglet caché, mouvement réduit). */
  finish(): void {
    for (const [name, tw] of this.tweens) {
      const st = this.states.get(name);
      if (st) Object.assign(st, tw.to);
    }
    this.tweens.clear();
    for (const name of this.states.keys()) this.render(name);
  }

  /** Réapplique tous les nœuds (éléments apparus, changement de mise en page). */
  renderAll(): void {
    for (const name of this.states.keys()) this.render(name);
  }

  /** Oublie les éléments retirés du document (liste, états, rendu SDUI refait). */
  prune(): void {
    for (const el of this.touched) if (!el.isConnected) this.touched.delete(el);
  }

  /** Oublie tout et retire les styles posés. */
  reset(): void {
    for (const el of this.touched) clearElement(el);
    this.touched.clear();
    this.states.clear();
    this.sigs.clear();
    this.tweens.clear();
  }

  private render(name: string): void {
    const st = this.states.get(name);
    if (!st) return;
    for (const el of this.opts.resolve(name)) {
      writeElement(el, st, this.layout);
      this.touched.add(el);
    }
  }
}
