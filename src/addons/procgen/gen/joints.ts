/**
 * Parties mobiles d'un objet (couvercle, portière, volet, tiroir, vantail) : sous-groupes du modèle qui tournent autour
 * d'un pivot ou glissent le long d'un axe, sans recomposer. Le générateur décrit chaque partie **fermée** (valeur 0) ;
 * la valeur 1 est l'ouverture complète (`range[1]`, degrés pour une rotation, mètres pour une translation).
 *
 * Le maillage d'une partie reste séparé du corps (`Asset.body` + `Asset.joints[i].mesh`) : la composition le pose dans
 * sa propre instance (matrice = objet × partie), le rendu 3D ne réécrit que cette matrice quand l'état change. La même
 * description sert au vectoriel (`posedJointParts`) quand l'objet est sur la grammaire de pièces.
 *
 * Socle des lots suivants : une partie a un nom stable (`lid`, `door.fl`, `shutter.3`), des ancres propres
 * (`lid.top`, `door.fl.handle`) et une masse visuelle séparée ; les dégâts pourront l'arracher (cacher son instance,
 * lâcher un débris), les contenus pourront s'y attacher (ancre de partie) ou se cacher sous elle (partie fermée).
 */
import { type M4, type Q, type V3, DEG, clamp, m4Compose, m4Mul, m4Point, mix, norm, qAxis, qRot } from "../core/math";
import { Mesh } from "../geom/mesh";
import { type PartList, partsToMesh, transformParts } from "./parts";

export type JointKind = "rotation" | "translation";

/** Description d'une partie mobile (repère de l'objet). */
export type JointSpec = {
  name: string;
  /** Nom lisible, en français (« couvercle », « portière avant gauche »). */
  label: string;
  kind: JointKind;
  pivot: V3;
  axis: V3;
  /** Course [fermé, ouvert] : degrés (rotation) ou mètres (translation). */
  range: [number, number];
  /** Pièces de la partie fermée (grammaire de pièces : 3D et vectoriel). */
  parts?: PartList;
  /** Maillage de la partie fermée (générateurs à maillage, ex. bâtiment) ; sinon tiré de `parts`. */
  mesh?: Mesh;
  /** Ancres de la partie fermée (repère de l'objet), publiées `<nom>.<ancre>` (`lid.top`). */
  anchors?: Record<string, V3>;
  /** Valeur de départ (0…1) quand aucun état n'est donné (ex. `open` d'un contenant). */
  initial?: number;
  /** `false` : partie qui ne s'« ouvre » pas (roue : `open` ne la touche pas, `affords` n'y gagne pas `open`). */
  openable?: boolean;
  /**
   * Partie parente (`steer.fl` pour la roue `wheel.0.l`) : le mouvement de la partie se compose avec celui de sa
   * parente (matrice = objet × parente × partie, pivots en repère de l'objet fermé). Trois niveaux au plus.
   */
  parent?: string;
};

/** Partie mobile d'un asset composé : maillage fermé séparé. */
export type AssetJoint = Omit<JointSpec, "parts" | "mesh"> & { mesh: Mesh; initial: number };

/** Ce que publient `selection.parts` et `ids[].parts`. */
export type JointInfo = { name: string; label: string; kind: JointKind; pivot: V3; axis: V3; range: [number, number]; initial: number; anchors?: Record<string, V3>; openable?: boolean; parent?: string };

type ChainJoint = Pick<JointSpec, "name" | "kind" | "pivot" | "axis" | "range" | "parent">;

/**
 * Mouvement d'une partie et de ses parentes (repère de l'objet) : parente × … × partie, chaque valeur lue par
 * `value(nom)`. Sans parente, c'est `jointLocal`.
 */
export function jointChain(all: readonly ChainJoint[], j: ChainJoint, value: (name: string) => number): M4 {
  let M = jointLocal(j, value(j.name));
  let p = j.parent;
  for (let guard = 0; p && guard < 3; guard++) {
    const pj = all.find((x) => x.name === p);
    if (!pj || pj === j) break;
    M = m4Mul(jointLocal(pj, value(pj.name)), M);
    p = pj.parent;
  }
  return M;
}

export const MAX_JOINTS = 24;

/** Rotation ou translation de la partie à la valeur `v` (0…1), autour de son pivot, en repère de l'objet. */
export function jointLocal(j: Pick<JointSpec, "kind" | "pivot" | "axis" | "range">, v: number): M4 {
  const t = mix(j.range[0], j.range[1], clamp(v, 0, 1));
  if (j.kind === "translation") {
    const a = norm(j.axis);
    return m4Compose([a[0] * t, a[1] * t, a[2] * t]);
  }
  const q = qAxis(norm(j.axis), t * DEG);
  // T(pivot) · R · T(−pivot) = translation (pivot − R·pivot) puis R
  const rp = qRot(q, j.pivot);
  return m4Compose([j.pivot[0] - rp[0], j.pivot[1] - rp[1], j.pivot[2] - rp[2]], q);
}

/** Matrice monde de la partie : matrice de l'objet × mouvement de la partie. */
export function jointWorld(obj: M4, j: Pick<JointSpec, "kind" | "pivot" | "axis" | "range">, v: number): M4 {
  return m4Mul(obj, jointLocal(j, v));
}

/** Point de la partie (repère de l'objet, partie fermée) à la valeur `v`. */
export function jointPoint(j: Pick<JointSpec, "kind" | "pivot" | "axis" | "range">, v: number, p: V3): V3 {
  return m4Point(jointLocal(j, v), p);
}

/** Pièces de la partie posées à la valeur `v` (dessin vectoriel figé). */
export function posedJointParts(j: JointSpec, v: number): PartList {
  const parts = j.parts ?? [];
  if (!parts.length) return parts;
  const t = mix(j.range[0], j.range[1], clamp(v, 0, 1));
  if (Math.abs(t) < 1e-9) return parts;
  if (j.kind === "translation") {
    const a = norm(j.axis);
    return transformParts(parts, [0, 0, 0, 1], [a[0] * t, a[1] * t, a[2] * t]);
  }
  const q: Q = qAxis(norm(j.axis), t * DEG);
  return transformParts(transformParts(parts, [0, 0, 0, 1], [-j.pivot[0], -j.pivot[1], -j.pivot[2]]), q, j.pivot);
}

/** Partie mise à l'échelle `s` (pivot, pièces, ancres, course d'une translation). */
export function scaleJoint(j: JointSpec, s: number): JointSpec {
  if (s === 1) return j;
  const S = (v: V3): V3 => [v[0] * s, v[1] * s, v[2] * s];
  return {
    ...j,
    pivot: S(j.pivot),
    range: j.kind === "translation" ? [j.range[0] * s, j.range[1] * s] : j.range,
    ...(j.parts ? { parts: transformParts(j.parts, [0, 0, 0, 1], [0, 0, 0], s) } : {}),
    ...(j.anchors ? { anchors: Object.fromEntries(Object.entries(j.anchors).map(([k, v]) => [k, S(v)])) } : {}),
  };
}

/** Raccourci : charnière (rotation) de pièces fermées. */
export function hingeJoint(name: string, label: string, parts: PartList, pivot: V3, axis: V3, deg: number, more: Partial<JointSpec> = {}): JointSpec {
  return { name, label, kind: "rotation", pivot, axis, range: [0, deg], parts, ...more };
}

/** Raccourci : glissière (translation) de pièces fermées. */
export function slideJoint(name: string, label: string, parts: PartList, axis: V3, meters: number, more: Partial<JointSpec> = {}): JointSpec {
  return { name, label, kind: "translation", pivot: [0, 0, 0], axis, range: [0, meters], parts, ...more };
}

/** Pièces de toutes les parties posées selon `states` (vectoriel). */
export function posedAll(joints: JointSpec[], states?: Record<string, number> | null): PartList {
  return joints.flatMap((j) => {
    let parts = posedJointParts(j, jointValue(j, states));
    // parentes : la pièce posée suit le mouvement de chacune (roue braquée)
    let p = j.parent;
    for (let guard = 0; p && guard < 3 && parts.length; guard++) {
      const pj = joints.find((x) => x.name === p);
      if (!pj || pj === j) break;
      parts = moveParts(parts, pj, jointValue(pj, states));
      p = pj.parent;
    }
    return parts;
  });
}

/** Pièces déjà posées déplacées par le mouvement d'une partie (sa parente). */
function moveParts(parts: PartList, j: Pick<JointSpec, "kind" | "pivot" | "axis" | "range">, v: number): PartList {
  const t = mix(j.range[0], j.range[1], clamp(v, 0, 1));
  if (Math.abs(t) < 1e-9) return parts;
  if (j.kind === "translation") {
    const a = norm(j.axis);
    return transformParts(parts, [0, 0, 0, 1], [a[0] * t, a[1] * t, a[2] * t]);
  }
  const q: Q = qAxis(norm(j.axis), t * DEG);
  return transformParts(transformParts(parts, [0, 0, 0, 1], [-j.pivot[0], -j.pivot[1], -j.pivot[2]]), q, j.pivot);
}

/** Valeur d'une partie dans une table d'états (nom exact ; défaut : valeur de départ). */
export function jointValue(j: Pick<JointSpec, "name" | "initial">, states?: Record<string, number> | null): number {
  const v = states?.[j.name];
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, 0, 1) : clamp(j.initial ?? 0, 0, 1);
}

/**
 * Maillages d'un objet à parties : corps seul, parties fermées séparées, et maillage complet posé aux valeurs de départ
 * (pour ce qui lit encore `Asset.mesh` d'un bloc : projectiles, export).
 */
export function buildJoints(body: Mesh, specs: JointSpec[], detail = 0.85): { mesh: Mesh; body: Mesh; joints: AssetJoint[] } {
  const joints: AssetJoint[] = specs.slice(0, MAX_JOINTS).map((s) => {
    const { parts, mesh, ...rest } = s;
    return { ...rest, mesh: mesh ?? partsToMesh(parts ?? [], detail), initial: clamp(s.initial ?? 0, 0, 1) };
  });
  const full = new Mesh().append(body);
  for (const j of joints) full.append(j.mesh, jointChain(joints, j, (n) => joints.find((x) => x.name === n)?.initial ?? 0));
  return { mesh: full, body, joints };
}

/** Publication légère d'une partie (sans maillage). */
export function jointInfo(j: AssetJoint, scale = 1): JointInfo {
  const S = (v: V3): V3 => [v[0] * scale, v[1] * scale, v[2] * scale];
  return {
    name: j.name,
    label: j.label,
    kind: j.kind,
    pivot: S(j.pivot),
    axis: j.axis,
    range: j.kind === "translation" ? [j.range[0] * scale, j.range[1] * scale] : j.range,
    initial: j.initial,
    ...(j.openable === false ? { openable: false } : {}),
    ...(j.parent ? { parent: j.parent } : {}),
    ...(j.anchors ? { anchors: Object.fromEntries(Object.entries(j.anchors).map(([k, v]) => [k, S(v)])) } : {}),
  };
}

/* ---------- lecture d'une partie écrite par un agent (pièce d'`assembly`) ---------- */

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: V3): V3 => (Array.isArray(v) && v.length >= 3 ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : d);

/**
 * `part: {name, pivot, axis, range, kind, label}` d'une pièce d'assemblage. Les pièces qui partagent un nom forment
 * une seule partie (le premier pivot, axe et course font foi). Rend la description sans pièces, ou un message.
 */
export function readJointDecl(raw: unknown): { spec: Omit<JointSpec, "parts"> | null; problem?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { spec: null, problem: "part attend {name, pivot, axis, range, kind}" };
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 32) : "";
  if (!name || !/^[A-Za-z][\w.-]*$/.test(name)) return { spec: null, problem: "part.name : nom attendu (lettres, chiffres, point : lid, door.l)" };
  const k = String(o.kind ?? "rotation");
  const kind: JointKind | null = k === "rotation" || k === "rotate" || k === "hinge" ? "rotation" : k === "translation" || k === "slide" || k === "slider" ? "translation" : null;
  if (!kind) return { spec: null, problem: `part.kind : « ${k} » inconnu (rotation ou translation)` };
  const axis = vec(o.axis, kind === "rotation" ? [1, 0, 0] : [0, 0, 1]);
  if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-6) return { spec: null, problem: "part.axis : axe nul" };
  const lim = kind === "rotation" ? 180 : 3;
  const r = Array.isArray(o.range) ? o.range : [0, kind === "rotation" ? 90 : 0.3];
  const range: [number, number] = [clamp(num(r[0], 0), -lim, lim), clamp(num(r[1], kind === "rotation" ? 90 : 0.3), -lim, lim)];
  const pivot = vec(o.pivot, [0, 0, 0]).map((x) => clamp(x, -6, 12)) as V3;
  return { spec: { name, label: typeof o.label === "string" && o.label ? o.label.slice(0, 40) : name, kind, pivot, axis: norm(axis), range, initial: clamp(num(o.initial, 0), 0, 1) } };
}
