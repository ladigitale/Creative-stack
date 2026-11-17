/**
 * Physique 3D du format monde (spécification, sans moteur) : corps rigides sur les placements nommés (`body`),
 * réglages du monde (`physics`) et liaisons. Le moteur (Rapier) est dans shared/sim/rigid.ts, chargé à la demande.
 */

export type V3 = [number, number, number];

export type BodyKind = "dynamic" | "static" | "kinematic";

/** Corps d'un placement. */
export type BodySpec = {
  kind: BodyKind;
  /** Masse totale (kg) ; 0 : déduite du volume et de `densite`. */
  mass: number;
  /** Densité (kg/m³) quand la masse n'est pas donnée. */
  density: number;
  friction: number;
  /** Rebond (0 à 1). */
  restitution: number;
  /** Amortissements (freinage dans l'air, rotation). */
  damping: number;
  angularDamping: number;
  /** Échelle de gravité (0 : flotte). */
  gravity: number;
  /** Détection continue (projectiles rapides). */
  ccd: boolean;
  /** Rotations bloquées par axe (un personnage reste debout : `["x", "z"]`). */
  lockRot: [boolean, boolean, boolean];
  /** Déplacements bloqués par axe (jeu de plateformes en tranche : `["z"]`). */
  lockPos: [boolean, boolean, boolean];
  /** Forme : `auto` (pièces : boîtes, sphères, cylindres), `boite` (englobante), `sphere`, `capsule`. */
  shape: "auto" | "boite" | "sphere" | "capsule";
  /** Vitesse de départ (m/s). */
  vel: V3;
  /** Le corps peut s'endormir au repos. */
  sleep: boolean;
};

export type JointKind = "hinge" | "ball" | "fixed" | "slider" | "spring" | "rope";

export type JointSpec = {
  /** Instance nommée (corps). */
  a: string;
  /** Autre instance ; vide : accroché au monde. */
  b: string;
  kind: JointKind;
  /** Point d'attache, repère du monde (mètres) ; défaut : position de `a`. */
  at: V3 | null;
  /** Axe (charnière, glissière), repère du monde. */
  axis: V3;
  /** Butées : degrés (charnière), mètres (glissière). */
  limits: [number, number] | null;
  /** Moteur : vitesse visée (°/s ou m/s) et force. */
  motor: { speed: number; force: number } | null;
  /** Ressort, corde : longueur au repos ; raideur, amortissement. */
  length: number;
  stiffness: number;
  damping: number;
  /** Les deux corps liés se heurtent-ils (défaut : non). */
  collide: boolean;
};

export type PhysicsSpec = {
  gravity: V3;
  /** Sol infini à y = 0 (défaut : oui). */
  ground: boolean;
  /** Impulsion minimale (N·s) pour signaler un choc (`contact`). */
  contactMin: number;
  /** Pas de simulation (s). */
  step: number;
  joints: JointSpec[];
  /** Corps de départ endormis jusqu'au premier choc ou ordre. */
  paused: boolean;
};

export const BODY_KINDS: Record<string, BodyKind> = {
  dynamic: "dynamic",
  dynamique: "dynamic",
  static: "static",
  statique: "static",
  fixe: "static",
  kinematic: "kinematic",
  cinematique: "kinematic",
  "cinématique": "kinematic",
};

const JOINTS: Record<string, JointKind> = {
  hinge: "hinge",
  charniere: "hinge",
  "charnière": "hinge",
  ball: "ball",
  rotule: "ball",
  fixed: "fixed",
  fixe: "fixed",
  soude: "fixed",
  slider: "slider",
  glissiere: "slider",
  "glissière": "slider",
  spring: "spring",
  ressort: "spring",
  rope: "rope",
  corde: "rope",
};

type Issue = { path: string; message: string };

const num = (x: unknown, d: number, lo = -Infinity, hi = Infinity) => (typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d);
const v3 = (x: unknown): V3 | null =>
  Array.isArray(x) && x.length >= 3 && x.slice(0, 3).every((v) => typeof v === "number" && Number.isFinite(v)) ? [x[0], x[1], x[2]] : null;
const axes = (x: unknown): [boolean, boolean, boolean] => {
  const l = Array.isArray(x) ? x.map((v) => String(v).toLowerCase().replace(/^r/, "")) : typeof x === "string" ? x.toLowerCase().replace(/r/g, "").split("") : [];
  return [l.includes("x"), l.includes("y"), l.includes("z")];
};

/** Corps d'un placement : `"dynamique"` ou `{type, masse, friction, rebond, …}` ; null si absent. */
export function readBody(v: unknown, path: string, issues: Issue[]): BodySpec | null {
  if (v === undefined || v === null || v === false) return null;
  const o: Record<string, unknown> = typeof v === "string" ? { type: v } : v === true ? { type: "dynamic" } : v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const t = String(o.type ?? o.kind ?? "dynamic").toLowerCase();
  const kind = BODY_KINDS[t];
  if (!kind) {
    issues.push({ path, message: `corps « ${t} » inconnu (dynamique, statique, cinematique)` });
    return null;
  }
  const shapeIn = String(o.forme ?? o.shape ?? "auto").toLowerCase();
  const shape = shapeIn === "boite" || shapeIn === "box" ? "boite" : shapeIn === "sphere" || shapeIn === "ball" ? "sphere" : shapeIn === "capsule" ? "capsule" : "auto";
  return {
    kind,
    mass: num(o.masse ?? o.mass, 0, 0, 1e6),
    density: num(o.densite ?? o.density, 500, 1, 50000),
    friction: num(o.friction, 0.6, 0, 4),
    restitution: num(o.rebond ?? o.restitution, 0.1, 0, 1),
    damping: num(o.amorti ?? o.damping, 0.05, 0, 50),
    angularDamping: num(o.amortiRotation ?? o.angularDamping, 0.1, 0, 50),
    gravity: num(o.gravite ?? o.gravity, 1, -10, 10),
    ccd: o.ccd === true || o.rapide === true,
    lockRot: axes(o.bloqueRotation ?? o.lockRotation),
    lockPos: axes(o.bloquePosition ?? o.lockPosition),
    shape,
    vel: v3(o.vitesse ?? o.vel) ?? [0, 0, 0],
    sleep: o.sommeil !== false && o.sleep !== false,
  };
}

/** Réglages du monde : `true` ou `{gravite, sol, contactMin, liaisons}` ; null si absent. */
export function readPhysics(v: unknown, issues: Issue[]): PhysicsSpec | null {
  if (v === undefined || v === null || v === false) return null;
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const g = v3(o.gravite ?? o.gravity);
  const joints: JointSpec[] = [];
  const list = o.liaisons ?? o.joints;
  if (Array.isArray(list))
    list.slice(0, 200).forEach((raw, i) => {
      const path = `physics.joints.${i}`;
      const j = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      if (!j) return;
      const t = String(j.type ?? j.kind ?? "").toLowerCase();
      const kind = JOINTS[t];
      if (!kind) {
        issues.push({ path, message: `liaison « ${t} » inconnue (charniere, rotule, fixe, glissiere, ressort, corde)` });
        return;
      }
      const a = typeof j.a === "string" ? j.a : "";
      if (!a) {
        issues.push({ path, message: "liaison sans corps « a »" });
        return;
      }
      const lim = Array.isArray(j.butees ?? j.limits) ? ((j.butees ?? j.limits) as unknown[]) : null;
      const motor = j.moteur ?? j.motor;
      const mo = motor && typeof motor === "object" ? (motor as Record<string, unknown>) : null;
      const axis = v3(j.axe ?? j.axis) ?? [0, 1, 0];
      const l = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      joints.push({
        a,
        b: typeof j.b === "string" ? j.b : "",
        kind,
        at: v3(j.at),
        axis: [axis[0] / l, axis[1] / l, axis[2] / l],
        limits: lim && typeof lim[0] === "number" && typeof lim[1] === "number" ? [Math.min(lim[0], lim[1]), Math.max(lim[0], lim[1])] : null,
        motor: mo ? { speed: num(mo.vitesse ?? mo.speed, 0), force: num(mo.force, 50, 0, 1e7) } : null,
        length: num(j.longueur ?? j.length, -1, 0, 1000),
        stiffness: num(j.raideur ?? j.stiffness, 200, 0, 1e7),
        damping: num(j.amorti ?? j.damping, 5, 0, 1e6),
        collide: j.choc === true || j.collide === true,
      });
    });
  return {
    gravity: g ?? [0, -9.81, 0],
    ground: (o.sol ?? o.ground) !== false,
    contactMin: num(o.contactMin, 0.5, 0, 1e6),
    step: 1 / num(o.frequence ?? o.hz, 60, 20, 240),
    joints,
    paused: (o.pause ?? o.paused) === true,
  };
}
