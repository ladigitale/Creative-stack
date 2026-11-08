/**
 * Grammaire de pièces : un objet décrit **une seule fois** comme une liste de pièces simples (planche, barre, tube
 * courbe, tour, coussin), en coordonnées locales (mètres, y vers le haut, base au sol, avant = +z). La même liste
 * donne le maillage 3D (`partsToMesh`) et l'illustration vectorielle (`vector/draw/parts.ts`) : un nouvel objet n'a
 * pas besoin de deux dessinateurs, et un agent peut composer un objet inédit en données (`gen: "assembly"`).
 */
import { type Q, type V3, DEG, len, m4Compose, qEuler, qFromTo, qMul, qRot, sub } from "../core/math";
import { Mesh } from "../geom/mesh";
import { box, cylinder, ellipsoid, lathe, tube } from "../geom/prims";
import { ROLE, type Role, roleIndex } from "../style/roles";

export type Part =
  /** Planche, pavé : centre, demi-côtés, rotation (degrés, x puis y puis z), arrondi des arêtes. */
  | { t: "box"; c: V3; h: V3; rot?: V3; /** Orientation directe (interne : prioritaire sur `rot`). */ q?: Q; r?: number; role: Role }
  /** Barre droite (pied, barreau, montant) de `a` à `b`, rayon `r` (et `r1` au bout : pied fuselé). */
  | { t: "rod"; a: V3; b: V3; r: number; r1?: number; role: Role }
  /** Tube courbe (accoudoir, patin de bascule, cadre de chaise pliante) le long de points, rayon constant. */
  | { t: "tube"; pts: V3[]; r: number; role: Role }
  /** Corps de révolution vertical posé en `c` : profil [rayon, hauteur] du bas vers le haut. */
  | { t: "lathe"; c: V3; profile: [number, number][]; role: Role }
  /** Coussin, pouf, assise rembourrée : ellipsoïde de centre `c` et demi-axes `r`. */
  | { t: "blob"; c: V3; r: V3; role: Role };

export type PartList = Part[];

const R = (role: Role) => ROLE[role] ?? ROLE.wood;

/** Orientation d'une planche. */
export function boxQ(p: { rot?: V3; q?: Q }): Q {
  return p.q ?? (p.rot ? qEuler(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG) : [0, 0, 0, 1]);
}

/**
 * Pièces tournées (`q`) puis échelonnées (`k`) puis déplacées (`t`). Les tours (`lathe`) restent verticaux : seul
 * leur centre suit (n'en mettre que dans des objets qui ne basculent pas) ; les coussins gardent des demi-axes alignés
 * (enveloppe des axes tournés).
 */
export function transformParts(parts: PartList, q: Q, t: V3 = [0, 0, 0], k = 1): PartList {
  const P = (v: V3): V3 => {
    const r = qRot(q, v);
    return [r[0] * k + t[0], r[1] * k + t[1], r[2] * k + t[2]];
  };
  return parts.map((p): Part => {
    switch (p.t) {
      case "box":
        return { ...p, c: P(p.c), h: [p.h[0] * k, p.h[1] * k, p.h[2] * k], q: qMul(q, boxQ(p)), rot: undefined, r: p.r === undefined ? undefined : p.r * k };
      case "rod":
        return { ...p, a: P(p.a), b: P(p.b), r: p.r * k, r1: p.r1 === undefined ? undefined : p.r1 * k };
      case "tube":
        return { ...p, pts: p.pts.map(P), r: p.r * k };
      case "lathe":
        return { ...p, c: P(p.c), profile: p.profile.map(([r, y]) => [r * k, y * k] as [number, number]) };
      case "blob": {
        const ax = [qRot(q, [1, 0, 0]), qRot(q, [0, 1, 0]), qRot(q, [0, 0, 1])];
        const r: V3 = [0, 1, 2].map((i) => k * Math.hypot(ax[0][i] * p.r[0], ax[1][i] * p.r[1], ax[2][i] * p.r[2])) as V3;
        return { ...p, c: P(p.c), r };
      }
    }
  });
}

/** Maillage 3D d'une liste de pièces (sobre en triangles : objets nombreux, instanciés). */
export function partsToMesh(parts: PartList, detail = 1): Mesh {
  const m = new Mesh();
  const seg = (base: number) => Math.max(5, Math.round(base * detail));
  for (const p of parts) {
    switch (p.t) {
      case "box": {
        const q = boxQ(p);
        m.append(box(p.h[0], p.h[1], p.h[2], R(p.role), p.r ?? Math.min(0.012, Math.min(p.h[0], p.h[1], p.h[2]) * 0.4)), m4Compose(p.c, q));
        break;
      }
      case "rod": {
        const d = sub(p.b, p.a);
        const L = len(d);
        if (L < 1e-4) break;
        m.append(cylinder(p.r, p.r1 ?? p.r, L, R(p.role), seg(p.r > 0.04 ? 10 : 7)), m4Compose(p.a, qFromTo([0, 1, 0], [d[0] / L, d[1] / L, d[2] / L])));
        break;
      }
      case "tube":
        if (p.pts.length >= 2) m.append(tube(p.pts, p.pts.map(() => p.r), R(p.role), seg(7), true, true));
        break;
      case "lathe":
        m.append(lathe(p.profile, R(p.role), seg(14)), m4Compose(p.c));
        break;
      case "blob":
        m.append(ellipsoid(p.r[0], p.r[1], p.r[2], R(p.role), seg(12), Math.max(4, Math.round(7 * detail))), m4Compose(p.c));
        break;
    }
  }
  return m;
}

/** Boîte englobante d'une liste de pièces (emprise, hauteur). */
export function partsBounds(parts: PartList): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  const grow = (q: V3, r = 0) => {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], q[i] - r);
      max[i] = Math.max(max[i], q[i] + r);
    }
  };
  for (const p of parts) {
    if (p.t === "box") {
      const q = p.q || p.rot ? boxQ(p) : null;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const d: V3 = [sx * p.h[0], sy * p.h[1], sz * p.h[2]];
        const r = q ? qRot(q, d) : d;
        grow([p.c[0] + r[0], p.c[1] + r[1], p.c[2] + r[2]]);
      }
    } else if (p.t === "rod") grow(p.a, p.r), grow(p.b, p.r1 ?? p.r);
    else if (p.t === "tube") for (const q of p.pts) grow(q, p.r);
    else if (p.t === "lathe") for (const [r, y] of p.profile) grow([p.c[0], p.c[1] + y, p.c[2]], 0), grow([p.c[0] + r, p.c[1] + y, p.c[2] + r]), grow([p.c[0] - r, p.c[1] + y, p.c[2] - r]);
    else grow([p.c[0] - p.r[0], p.c[1] - p.r[1], p.c[2] - p.r[2]]), grow([p.c[0] + p.r[0], p.c[1] + p.r[1], p.c[2] + p.r[2]]);
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/* ---------- lecture d'une liste de pièces écrite par un agent (générateur `assembly`) ---------- */

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const v3 = (v: unknown, d: V3): V3 => (Array.isArray(v) && v.length >= 3 ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : d);
const clampLen = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/**
 * Valide et borne une liste de pièces venue d'une recette (aucune évaluation de code : uniquement des nombres, des
 * types connus et des noms de rôles). Rend la liste nettoyée et les messages pour `status.issues`.
 */
export function readParts(raw: unknown, maxParts = 80): { parts: PartList; problems: string[] } {
  const parts: PartList = [];
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { parts, problems: raw === undefined ? [] : ["parts doit être une liste"] };
  const S = 6; // demi-taille maximale (m)
  const c3 = (v: unknown, d: V3): V3 => v3(v, d).map((x) => clampLen(x, -S, S)) as V3;
  const role = (v: unknown, i: number): Role => {
    const name = typeof v === "string" ? v : "wood";
    if (!(name in ROLE)) problems.push(`parts[${i}].role : rôle inconnu « ${name} »`);
    return (name in ROLE ? name : "wood") as Role;
  };
  raw.slice(0, maxParts).forEach((q, i) => {
    if (!q || typeof q !== "object") return problems.push(`parts[${i}] ignorée`);
    const o = q as Record<string, unknown>;
    const r = (v: unknown, d: number) => clampLen(num(v, d), 0.003, 2);
    switch (o.t) {
      case "box":
        parts.push({ t: "box", c: c3(o.c, [0, 0.5, 0]), h: v3(o.h, [0.25, 0.25, 0.25]).map((x) => clampLen(Math.abs(x), 0.003, S)) as V3, rot: o.rot ? v3(o.rot, [0, 0, 0]) : undefined, role: role(o.role, i) });
        break;
      case "rod":
        parts.push({ t: "rod", a: c3(o.a, [0, 0, 0]), b: c3(o.b, [0, 1, 0]), r: r(o.r, 0.03), r1: o.r1 === undefined ? undefined : r(o.r1, 0.03), role: role(o.role, i) });
        break;
      case "tube": {
        const pts = Array.isArray(o.pts) ? (o.pts as unknown[]).slice(0, 24).map((p) => c3(p, [0, 0, 0])) : [];
        if (pts.length >= 2) parts.push({ t: "tube", pts, r: r(o.r, 0.02), role: role(o.role, i) });
        else problems.push(`parts[${i}].pts : au moins deux points`);
        break;
      }
      case "lathe": {
        const prof = Array.isArray(o.profile) ? (o.profile as unknown[]).slice(0, 24).map((p) => (Array.isArray(p) ? [clampLen(num(p[0], 0.1), 0, S), clampLen(num(p[1], 0), 0, 2 * S)] : [0.1, 0]) as [number, number]) : [];
        if (prof.length >= 2) parts.push({ t: "lathe", c: c3(o.c, [0, 0, 0]), profile: prof, role: role(o.role, i) });
        else problems.push(`parts[${i}].profile : au moins deux points [rayon, hauteur]`);
        break;
      }
      case "blob":
        parts.push({ t: "blob", c: c3(o.c, [0, 0.3, 0]), r: v3(o.r, [0.2, 0.1, 0.2]).map((x) => clampLen(Math.abs(x), 0.005, S)) as V3, role: role(o.role, i) });
        break;
      default:
        problems.push(`parts[${i}].t : type inconnu « ${String(o.t)} » (box, rod, tube, lathe, blob)`);
    }
  });
  if (Array.isArray(raw) && raw.length > maxParts) problems.push(`parts : ${raw.length} pièces, ${maxParts} gardées`);
  return { parts, problems };
}

/** Rôle de couleur d'un paramètre : nom de rôle connu, sinon le rôle par défaut. */
export function roleParam(v: unknown, fallback: Role): Role {
  return typeof v === "string" && v in ROLE ? (v as Role) : fallback;
}

export { roleIndex };
