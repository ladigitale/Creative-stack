/**
 * Cœur sans DOM de `sonic-hand-tracker` : miroir, rôles gauche/droite, lissage One Euro, maintien
 * (`hold-ms`), clés de sortie plates et attribut `map`. Testé seul, avec des mains synthétiques.
 */
import { assignRoles, metricsOf, mirrorPoints, type HandMetrics, type Point, type RawHand, type Role, type RoleMemory } from "../../shared/ml/hands";
import { evalMap, type CompiledMap } from "../../shared/ml/map-expr";
import { OneEuro, oneEuroFor } from "../../shared/ml/one-euro";

export type RoleOutput = HandMetrics & {
  present: 0 | 1;
  gesture: string;
  gestureScore: number;
};

export type HandOutput = {
  role: Role;
  score: number;
  label?: string;
  gesture?: string;
  landmarks: Point[];
  world?: Point[];
};

export type HandsOutput = {
  count: number;
  left: RoleOutput;
  right: RoleOutput;
  hands: HandOutput[];
  [derived: string]: unknown;
};

export type CoreOptions = {
  /** 0..1 ; 0 = pas de lissage. */
  smooth: number;
  /** Durée pendant laquelle une main perdue garde sa dernière valeur avec `present: 1`. */
  holdMs: number;
  /** Retourne x (1 - x) : repère écran miroir. */
  mirror: boolean;
  map?: CompiledMap | null;
};

const METRIC_KEYS = ["x", "y", "z", "tipX", "tipY", "pinch", "openness", "roll"] as const;

const EMPTY: RoleOutput = {
  present: 0,
  x: 0.5,
  y: 0.5,
  z: 0,
  tipX: 0.5,
  tipY: 0.5,
  pinch: 0,
  openness: 0,
  roll: 0.5,
  gesture: "",
  gestureScore: 0,
};

type RoleState = {
  last: RoleOutput;
  lastSeen: number;
  filters: Partial<Record<(typeof METRIC_KEYS)[number], OneEuro>>;
};

export class HandTrackerCore {
  private opts: CoreOptions;
  private roles: Record<Role, RoleState> = { left: this.blank(), right: this.blank() };
  private memory: RoleMemory = {};

  constructor(opts: CoreOptions) {
    this.opts = { ...opts };
  }

  configure(opts: Partial<CoreOptions>): void {
    const smoothChanged = opts.smooth !== undefined && opts.smooth !== this.opts.smooth;
    this.opts = { ...this.opts, ...opts };
    if (smoothChanged) for (const r of ["left", "right"] as Role[]) this.roles[r].filters = {};
  }

  reset(): void {
    this.roles = { left: this.blank(), right: this.blank() };
    this.memory = {};
  }

  private blank(): RoleState {
    return { last: { ...EMPTY }, lastSeen: -Infinity, filters: {} };
  }

  private smoothed(state: RoleState, key: (typeof METRIC_KEYS)[number], value: number, now: number): number {
    if (this.opts.smooth <= 0) return value;
    let f = state.filters[key];
    if (!f) {
      f = oneEuroFor(this.opts.smooth) ?? undefined;
      if (!f) return value;
      state.filters[key] = f;
    }
    return f.filter(value, now);
  }

  update(raw: RawHand[], now: number): HandsOutput {
    const hands = raw.map((h) => {
      const landmarks = this.opts.mirror ? mirrorPoints(h.landmarks) : h.landmarks;
      const world = h.world && this.opts.mirror ? h.world.map((p) => ({ x: -p.x, y: p.y, z: p.z })) : h.world;
      return { raw: h, landmarks, world, m: metricsOf(landmarks) };
    });
    const roles = assignRoles(
      hands.map((h) => ({ x: h.m.x, y: h.m.y, label: h.raw.label })),
      this.memory,
    );

    const seen = new Set<Role>();
    const handOut: HandOutput[] = [];
    hands.forEach((h, i) => {
      const role = roles[i];
      if (seen.has(role)) return; // ne devrait pas arriver ; garde la première
      seen.add(role);
      const st = this.roles[role];
      const out: RoleOutput = { ...EMPTY, present: 1, gesture: h.raw.gesture ?? "", gestureScore: h.raw.gestureScore ?? 0 };
      for (const k of METRIC_KEYS) out[k] = this.smoothed(st, k, h.m[k], now);
      st.last = out;
      st.lastSeen = now;
      this.memory[role] = { x: h.m.x, y: h.m.y };
      handOut.push({
        role,
        score: h.raw.score,
        label: h.raw.label,
        gesture: h.raw.gesture,
        landmarks: h.landmarks,
        world: h.world,
      });
    });

    for (const role of ["left", "right"] as Role[]) {
      if (seen.has(role)) continue;
      const st = this.roles[role];
      if (now - st.lastSeen <= this.opts.holdMs && st.last.present === 1) continue; // maintenu tel quel
      if (st.last.present === 1) {
        st.last = { ...st.last, present: 0 };
        st.filters = {};
        delete this.memory[role];
      }
    }

    const output: HandsOutput = {
      count: raw.length,
      left: { ...this.roles.left.last },
      right: { ...this.roles.right.last },
      hands: handOut,
    };
    if (this.opts.map && this.opts.map.ok) {
      for (const [key, value] of Object.entries(evalMap(this.opts.map, output))) setPath(output, key, value);
    }
    return output;
  }
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    if (next === null || typeof next !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}
