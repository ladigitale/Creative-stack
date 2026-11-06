import { HUMAN_PRESET, boneSpecFromAttrs, type BoneAttrs } from "../../shared/skeleton-presets";
import { MAX_BONES, Rig, dir, wrap180, type BoneSpec, type BoneState } from "../../shared/skeleton";
import { parseBody, parseJoint, type BodySpec, type BodyState, type JointSpec } from "./core";

/**
 * Pantin articulé : un squelette (os rigides) devient des corps physiques reliés par des pivots à
 * limites d'angle. Le monde physique le fait tomber, rebondir, se faire tirer ; la pose des os qui en
 * résulte est publiée au format `nodes` de `sonic-skeleton` : mêmes rendus, mêmes sprites.
 */

export const RAGDOLL_GROUP = "ragdoll";

export type RagdollOptions = {
  /** Nom du pantin : préfixe des corps (`<nom>.<os>`). */
  name: string;
  /** Racine (px, repère du monde). */
  x: number;
  y: number;
  /** Échelle du squelette. */
  scale: number;
  /** Épaisseur des os (px) ; 0 : proportionnelle à la longueur. */
  thickness: number;
  density: number;
  friction: number;
  restitution: number;
  damping: number;
  angularDamping: number;
  /** Débattement (°) autorisé aux os dont `min` / `max` ne sont pas définis. */
  limit: number;
  /** Limbes entre eux : se cognent (par défaut non). */
  selfCollide: boolean;
  /** Angle initial de tout le pantin (°), autour de la racine. */
  angle: number;
};

export const RAGDOLL_DEFAULTS: Omit<RagdollOptions, "name"> = {
  x: 400,
  y: 100,
  scale: 1,
  thickness: 0,
  density: 1,
  friction: 0.4,
  restitution: 0.05,
  damping: 0.1,
  angularDamping: 0.6,
  limit: 120,
  selfCollide: false,
  angle: 0,
};

export type RagdollPlan = {
  name: string;
  rig: Rig;
  /** Échelle appliquée aux longueurs. */
  scale: number;
  bodies: BodySpec[];
  joints: JointSpec[];
  /** Os → nom du corps. */
  bodyOf: Map<string, string>;
  /** Pose de repos (angles absolus de référence pour `rz`). */
  rest: BoneState[];
  errors: string[];
};

const num = (v: unknown, d: number): number => {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** Options depuis des attributs SDUI (chaînes), bornées. */
export function parseRagdollOptions(attrs: Record<string, string>, fallbackName: string): RagdollOptions {
  const d = RAGDOLL_DEFAULTS;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    name: (attrs.name ?? "").trim() || fallbackName,
    x: num(attrs.x, d.x),
    y: num(attrs.y, d.y),
    scale: clamp(num(attrs.scale, d.scale), 0.05, 20),
    thickness: clamp(num(attrs.thickness, d.thickness), 0, 200),
    density: clamp(num(attrs.density, d.density), 0.01, 100),
    friction: clamp(num(attrs.friction, d.friction), 0, 2),
    restitution: clamp(num(attrs.restitution, d.restitution), 0, 1),
    damping: clamp(num(attrs.damping, d.damping), 0, 20),
    angularDamping: clamp(num(attrs["angular-damping"], d.angularDamping), 0, 20),
    limit: clamp(num(attrs.limit, d.limit), 1, 180),
    selfCollide: attrs["self-collide"] !== undefined && attrs["self-collide"] !== "false",
    angle: num(attrs.angle, d.angle),
  };
}

/** Os depuis le préréglage nommé, complétés / remplacés par `overrides` (même nom : attributs fusionnés). */
export function ragdollBones(preset: string, overrides: BoneAttrs[]): { bones: BoneSpec[]; errors: string[] } {
  const errors: string[] = [];
  let base: BoneAttrs[] = [];
  if (preset) {
    if (preset === "humain") base = HUMAN_PRESET.map((b) => ({ ...b }));
    else errors.push(`préréglage inconnu : ${preset}`);
  }
  const byName = new Map(base.map((b) => [b.name, b]));
  for (const o of overrides) {
    const n = (o.name ?? "").trim();
    if (!n) {
      errors.push("un os sans nom est ignoré");
      continue;
    }
    byName.set(n, { ...(byName.get(n) ?? {}), ...o });
  }
  const bones: BoneSpec[] = [];
  for (const attrs of byName.values()) {
    const s = boneSpecFromAttrs(attrs);
    if (s) bones.push(s);
  }
  return { bones, errors };
}

/** Construit les corps et les pivots d'un pantin à partir de ses os. */
export function planRagdoll(specs: BoneSpec[], opts: RagdollOptions): RagdollPlan {
  const rig = new Rig(specs.slice(0, MAX_BONES), { scale: opts.scale });
  const errors = [...rig.errors];
  const rest = rig.solve({ x: 0, y: 0 });
  const root = { x: opts.x, y: opts.y };
  const turn = opts.angle;
  const states = rig.solve(root).map((s) => ({ ...s }));
  // Rotation initiale autour de la racine.
  if (turn) {
    const a = (turn * Math.PI) / 180, c = Math.cos(a), si = Math.sin(a);
    const rot = (x: number, y: number): [number, number] => [root.x + (x - root.x) * c - (y - root.y) * si, root.y + (x - root.x) * si + (y - root.y) * c];
    for (const s of states) {
      [s.x, s.y] = rot(s.x, s.y);
      [s.x2, s.y2] = rot(s.x2, s.y2);
      s.angle = wrap180(s.angle + turn);
    }
  }
  const bodies: BodySpec[] = [];
  const joints: JointSpec[] = [];
  const bodyOf = new Map<string, string>();
  const stateOf = new Map(states.map((s) => [s.name, s]));
  const group = opts.selfCollide ? "" : RAGDOLL_GROUP;
  for (const spec of rig.specs) {
    const st = stateOf.get(spec.name) as BoneState;
    const bodyName = `${opts.name}.${spec.name}`;
    bodyOf.set(spec.name, bodyName);
    const common = {
      name: bodyName,
      density: opts.density,
      friction: opts.friction,
      restitution: opts.restitution,
      damping: opts.damping,
      "angular-damping": opts.angularDamping,
      group,
      collides: opts.selfCollide ? "all" : "default",
      tags: `ragdoll ${opts.name} ${spec.name}`,
    };
    const raw: Record<string, unknown> =
      st.length < 1
        ? { ...common, shape: "circle", r: Math.max(4, 9 * opts.scale), x: st.x, y: st.y, angle: st.angle }
        : {
            ...common,
            shape: "box",
            w: opts.thickness > 0 ? opts.thickness : Math.max(8, Math.min(34, st.length * 0.3)),
            h: st.length,
            x: (st.x + st.x2) / 2,
            y: (st.y + st.y2) / 2,
            angle: st.angle,
          };
    const { spec: body, errors: e } = parseBody(raw, bodyName);
    errors.push(...e);
    bodies.push(body);
    if (spec.parent !== null) {
      const limited = spec.min > -180 || spec.max < 180;
      const { spec: joint, errors: je } = parseJoint(
        {
          type: "revolute",
          a: bodyOf.get(spec.parent),
          b: bodyName,
          at: `${st.x} ${st.y}`,
          lower: limited ? spec.min : -opts.limit,
          upper: limited ? spec.max : opts.limit,
        },
        joints.length,
      );
      errors.push(...je);
      if (joint) joints.push(joint);
    }
  }
  return { name: opts.name, rig, scale: opts.scale, bodies, joints, bodyOf, rest, errors };
}

/** Pose des os depuis l'état des corps (position du centre, angle en degrés, repère du monde). */
export function ragdollPose(plan: RagdollPlan, bodyState: (name: string) => BodyState | null): BoneState[] {
  const out: BoneState[] = [];
  const restAngle = new Map(plan.rest.map((s) => [s.name, s.angle]));
  for (const spec of plan.rig.specs) {
    const b = bodyState(plan.bodyOf.get(spec.name) as string);
    if (!b) continue;
    const length = spec.length * plan.scale;
    const d = dir(b.angle);
    const half = length / 2;
    const angle = wrap180(b.angle);
    out.push({
      name: spec.name,
      x: b.x - d.x * half,
      y: b.y - d.y * half,
      x2: b.x + d.x * half,
      y2: b.y + d.y * half,
      angle,
      rz: (wrap180(angle - (restAngle.get(spec.name) as number)) * Math.PI) / 180,
      length,
    });
  }
  return out;
}
