/**
 * État des nœuds d'une scène (format `nodes`, voir ./nodes.ts) : patchs reçus, interpolations `ease`,
 * republication identique ignorée, `$reset`. Le rendu est délégué (`render`) : éléments DOM pour
 * `sonic-stage`, objets d'affichage pour `sonic-2d`.
 */
import {
  MAX_NODES_PER_MUTATION,
  easeCurve,
  isNum,
  patchOf,
  scaleXY,
  type NodeCurve,
  type NodePatch,
} from "./nodes";

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

/** Cible d'un patch : canaux numériques interpolables et champs discrets. */
export function targetsOf(p: NodePatch): { num: Partial<Record<Channel, number>>; discrete: NodeState } {
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

export type NodeStatesOptions = {
  /** Dessine l'état d'un nœud (tous ses éléments ou objets). */
  render: (name: string, state: NodeState) => void;
  /** Le nœud a-t-il au moins un élément / objet (compte `missing`) ? */
  exists: (name: string) => boolean;
  /** `$reset` : retirer ce que le rendu a posé. */
  onReset?: () => void;
};

export class NodeStates {
  private states = new Map<string, NodeState>();
  private sigs = new Map<string, string>();
  private tweens = new Map<string, Tween>();
  /** Noms sans élément lors de la dernière application. */
  missing = 0;

  constructor(private opts: NodeStatesOptions) {}

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
      if (this.sigs.get(name) !== sig) {
        this.sigs.set(name, sig);
        this.applyOne(name, p, now, animate);
      }
      if (!this.opts.exists(name)) this.missing++;
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

  /** Oublie tout ; le rendu retire ce qu'il a posé. */
  reset(): void {
    this.opts.onReset?.();
    this.states.clear();
    this.sigs.clear();
    this.tweens.clear();
  }

  private render(name: string): void {
    const st = this.states.get(name);
    if (st) this.opts.render(name, st);
  }
}
