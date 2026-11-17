/**
 * Pièces souples des générateurs procgen (capes, jupes, écharpes, chevelures en mèches, drapeaux, linge, rideaux) :
 * même moteur que le format monde (`shared/sim/soft.ts`, `shared/sim/hair.ts`, maillages `shared/sim/soft-mesh.ts`).
 *
 * Ici, rien ne dépend du rendu : création des simulations, drapé de repos calculé une fois (repli 3D au-delà du
 * plafond de tissus simulés) et forme figée en plaques pour l'illustration vectorielle.
 */
import { type V3, cross, dot, norm, qFromAxes, sub } from "../core/math";
import { Mesh } from "../geom/mesh";
import { HairSim } from "../../../shared/sim/hair";
import { SoftSim, type SoftSpec } from "../../../shared/sim/soft";
import { hairTopology, softTopology, writeHairPositions, writeSoftPositions } from "../../../shared/sim/soft-mesh";
import type { Part } from "./parts";
import { ROLES, type Role } from "../style/roles";
import type { SoftPiece } from "./types";

export type PieceSim = { kind: "cloth"; sim: SoftSim } | { kind: "hair"; sim: HairSim };

/** Vent nominal du drapé de repos (repère de l'objet : souffle vers +x). */
export const REST_WIND: V3 = [1.6, 0, 0];
const G: V3 = [0, -9.81, 0];
const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Tissus : souplesse (0 soie … 1 cuir), poids. */
export const FABRICS: Record<string, { stiffness: number; weight: number; damping: number; wind: number }> = {
  silk: { stiffness: 0.15, weight: 0.6, damping: 0.05, wind: 1.6 },
  cotton: { stiffness: 0.35, weight: 1, damping: 0.08, wind: 1.2 },
  canvas: { stiffness: 0.6, weight: 1.4, damping: 0.12, wind: 0.9 },
  wool: { stiffness: 0.45, weight: 1.6, damping: 0.12, wind: 0.8 },
};

/** Spécification d'un tissu d'après une matière (`FABRICS`). */
export function clothSpec(kind: SoftSpec["kind"], pin: SoftSpec["pin"], fabric: string, extra: Partial<SoftSpec> = {}): SoftSpec {
  const f = FABRICS[fabric] ?? FABRICS.cotton;
  return { kind, pin, stiffness: f.stiffness, weight: f.weight, damping: f.damping, wind: f.wind, collide: true, segments: 8, ...extra };
}

export function makePieceSim(p: SoftPiece): PieceSim | null {
  if (p.hair && p.head) return { kind: "hair", sim: new HairSim(p.hair, p.head.c, p.head.r) };
  if (p.cloth && p.box) return { kind: "cloth", sim: new SoftSim(p.cloth, p.box) };
  return null;
}

/** Points simulés (coût d'une pièce). */
export function pieceCost(s: PieceSim): number {
  return s.kind === "hair" ? s.sim.strands * s.sim.per : s.sim.n;
}

export function pieceTopology(s: PieceSim) {
  return s.kind === "hair" ? hairTopology(s.sim) : softTopology(s.sim);
}

/** Positions du maillage ; `head` : centre de la tête (monde) pour l'orientation des rubans. */
export function writePiece(s: PieceSim, p: SoftPiece, out: Float32Array, head?: V3) {
  if (s.kind === "hair") writeHairPositions(s.sim, head?.[0] ?? 0, head?.[1] ?? 0, head?.[2] ?? 0, out);
  else writeSoftPositions(s.sim, out, p.taper ?? 0);
}

/** Change d'échelle une pièce (instance agrandie) : boîte, crâne et sphères. */
export function scalePiece(p: SoftPiece, k: number): SoftPiece {
  if (k === 1) return p;
  const s = (v: V3): V3 => [v[0] * k, v[1] * k, v[2] * k];
  return {
    ...p,
    box: p.box && { c: s(p.box.c), h: s(p.box.h) },
    head: p.head && { c: s(p.head.c), r: p.head.r * k },
    hair: p.hair && { ...p.hair, length: p.hair.length * k, width: p.hair.width * k },
    colliders: p.colliders?.map((c) => ({ ...c, c: s(c.c), r: c.r * k })),
  };
}

/** Simulation posée dans son drapé de repos (repère de l'objet, vent nominal, `ticks` pas de 1/60 s). */
export function restSim(p: SoftPiece, ticks = 120, wind: V3 = REST_WIND): PieceSim | null {
  const s = makePieceSim(p);
  if (!s) return null;
  const sph = p.colliders?.length ? new Float32Array(p.colliders.flatMap((c) => [c.c[0], c.c[1], c.c[2], c.r])) : null;
  for (let i = 0; i < ticks; i += 3) {
    if (s.kind === "hair") s.sim.step(0.05, ID, G, wind, sph);
    else s.sim.step(0.05, ID, G, wind, sph);
  }
  return s;
}

/** Maillage figé des pièces (drapé de repos), dans le repère de l'objet. */
export function frozenMesh(pieces: SoftPiece[]): Mesh {
  const out = new Mesh();
  for (const p of pieces) {
    const s = restSim(p);
    if (!s) continue;
    const topo = pieceTopology(s);
    const pos = new Float32Array(topo.verts * 3);
    writePiece(s, p, pos, p.head?.c);
    const m = new Mesh();
    for (let i = 0; i < topo.verts; i++) m.vertex([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], [0, 1, 0], p.role);
    for (let i = 0; i < topo.idx.length; i += 3) m.tri(topo.idx[i], topo.idx[i + 1], topo.idx[i + 2]);
    m.computeNormals();
    out.append(m);
  }
  return out;
}

const plateCache = new Map<string, Part[]>();

/**
 * Forme figée en plaques (illustration vectorielle) : le drapé de repos découpé en bandes le long du tissu, chaque
 * bande étant une plaque plane convexe. Les chevelures n'en donnent pas (dessinées par le personnage).
 */
export function frozenPlates(pieces: SoftPiece[], bands = 4): Part[] {
  const key = JSON.stringify(pieces) + bands;
  const hit = plateCache.get(key);
  if (hit) return hit;
  const parts: Part[] = [];
  for (const p of pieces) {
    const s = restSim(p);
    if (!s || s.kind !== "cloth") continue;
    const sim = s.sim;
    const pos = new Float32Array(sim.n * 3);
    writeSoftPositions(sim, pos, p.taper ?? 0);
    const P = (r: number, c: number): V3 => {
      const i = (r * sim.cols + c) * 3;
      return [pos[i], pos[i + 1], pos[i + 2]];
    };
    const role = (ROLES[p.role] ?? "cloth1") as Role;
    const rows = sim.rows, cols = sim.cols;
    const nb = Math.max(1, Math.min(bands, rows - 1));
    if (sim.spec.kind === "jupe") {
      // jupe : quartiers (bandes autour de l'anneau) du haut au bas
      const q = Math.max(4, Math.min(8, cols / 2));
      for (let k = 0; k < q; k++) {
        const c0 = Math.round((k * cols) / q), c1 = Math.round(((k + 1) * cols) / q) % cols;
        const pts = [P(0, c0), P(0, c1), P(rows - 1, c1), P(rows - 1, c0), P(Math.floor(rows / 2), c0), P(Math.floor(rows / 2), c1)];
        const pl = plateOf(pts, role);
        if (pl) parts.push(pl);
      }
      continue;
    }
    if (sim.spec.kind !== "tissu") continue;
    for (let b = 0; b < nb; b++) {
      const r0 = Math.round((b * (rows - 1)) / nb), r1 = Math.round(((b + 1) * (rows - 1)) / nb);
      const pts: V3[] = [];
      for (let c = 0; c < cols; c++) pts.push(P(r0, c), P(r1, c));
      const pl = plateOf(pts, role);
      if (pl) parts.push(pl);
    }
  }
  if (plateCache.size > 64) plateCache.delete(plateCache.keys().next().value as string);
  plateCache.set(key, parts);
  return parts;
}

/** Plaque plane qui approche un nuage de points presque plan (plan moyen, enveloppe convexe des projections). */
function plateOf(pts: V3[], role: Role): Part | null {
  const c: V3 = [0, 0, 0];
  for (const p of pts) (c[0] += p[0] / pts.length), (c[1] += p[1] / pts.length), (c[2] += p[2] / pts.length);
  // normale : somme des produits vectoriels autour du centre (Newell simplifié)
  let n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = sub(pts[i], c), b = sub(pts[(i + 1) % pts.length], c);
    const x = cross(a, b);
    const s = dot(x, n) < 0 ? -1 : 1;
    n = [n[0] + x[0] * s, n[1] + x[1] * s, n[2] + x[2] * s];
  }
  if (Math.hypot(n[0], n[1], n[2]) < 1e-9) return null;
  n = norm(n);
  const u = norm(Math.abs(n[1]) < 0.9 ? cross([0, 1, 0], n) : cross([1, 0, 0], n));
  const v = cross(n, u);
  const p2 = pts.map((p) => [dot(sub(p, c), u), dot(sub(p, c), v)] as [number, number]);
  const hull = hull2(p2);
  if (hull.length < 3) return null;
  // repère de la plaque : x = u, y = v, z = n (quaternion depuis la base)
  return { t: "plate", c, pts: hull, d: 0.004, q: qFromAxes(u, v, n), role };
}

function hull2(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.slice().reverse()) {
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}
