/**
 * Ouvrages (`structure`, raccourci `structure.<kind>`) : pont (en arc de pierre, plat en bois ou en poutres de métal),
 * ponton, quai, escalier, rampe, arche, portail, voie ferrée. Sur la grammaire de pièces : même modèle en 3D et en
 * vectoriel.
 *
 * Repère : le passage se fait selon z (entrées en −z et +z), la largeur est selon x, y = 0 au niveau des appuis
 * (les berges d'un pont, le pied d'un escalier). Les piles et culées descendent sous y = 0 (`depth`), dans le lit.
 *
 * Chaque ouvrage praticable publie `extra.walk` (tablier : demi-largeur et profil [z, y] du dessus) : la scène y fait
 * marcher les acteurs à la bonne hauteur et ouvre la navigation au-dessus de l'eau ; `extra.blockers` (boîtes locales
 * [cx, cz, hx, hz]) remplace l'emprise pour la navigation (garde-corps, piles d'une arche) ; `extra.rest` (points
 * [x, z]) dit où l'ouvrage s'appuie sur le sol (sa base y est posée au plus bas de ces points, pas au fond du lit).
 */
import { type Q, type V3, DEG, clamp, mix, smoothstep } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, partsBounds, partsToMesh, roleParam, transformParts } from "./parts";
import { type Anchor, defineGenerator } from "./types";

export const STRUCTURE_KINDS = ["bridge", "pontoon", "quay", "stairs", "ramp", "arch", "gate", "rails"] as const;
export const STRUCTURE_FORMS = ["auto", "arch", "flat", "truss", "round", "pointed", "torii", "iron", "wood"] as const;
export const STRUCTURE_MATERIALS = ["auto", "stone", "wood", "metal", "brick", "concrete"] as const;

type Mat = "stone" | "wood" | "metal" | "brick" | "concrete";
type O = {
  kind: string;
  form: string;
  mat: Mat;
  L: number;
  W: number;
  H: number;
  clearance: number;
  rails: boolean;
  steps: number;
  depth: number;
  open: number;
  main: Role;
  trim: Role;
  deck: Role;
};

export type Walk = { hw: number; profile: [number, number][] };
type Built = {
  parts: PartList;
  anchors: Record<string, V3>;
  affords: string[];
  walk?: Walk[];
  blockers?: [number, number, number, number][];
  rest?: [number, number][];
};

const bx = (c: V3, h: V3, role: Role, rot?: V3): Part => ({ t: "box", c, h, role, rot });
const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, r1, role });
const circle = (r: number, n = 18, a0 = 0): [number, number][] => Array.from({ length: n }, (_, i) => [Math.cos(a0 + (i / n) * Math.PI * 2) * r, Math.sin(a0 + (i / n) * Math.PI * 2) * r] as [number, number]);

/** Planche posée sous la ligne (z0, y0) → (z1, y1), centrée en x = cx, demi-largeur hx, épaisseur t. */
function slab(cx: number, hx: number, z0: number, y0: number, z1: number, y1: number, t: number, role: Role): Part {
  const dz = z1 - z0, dy = y1 - y0;
  const L = Math.hypot(dz, dy) || 1e-3;
  const a = Math.atan2(dy, dz);
  return { t: "box", c: [cx, (y0 + y1) / 2 - (t / 2) * Math.cos(a), (z0 + z1) / 2 + (t / 2) * Math.sin(a)], h: [hx, t / 2, L / 2 + 0.004], role, rot: [-a / DEG, 0, 0] };
}

/** Bande verticale dans le plan x = cx (épaisseur 2·d), entre le bas `b` et le haut `y`, de z0 à z1 (trapèze convexe). */
function strip(cx: number, d: number, z0: number, b0: number, y0: number, z1: number, b1: number, y1: number, role: Role): Part | null {
  if (y0 - b0 < 0.01 && y1 - b1 < 0.01) return null;
  // plaque x–y tournée de 90° autour de y : son x devient −z, sa normale devient +x
  return { t: "plate", c: [cx, 0, 0], pts: [[-z0, b0], [-z1, b1], [-z1, Math.max(y1, b1 + 0.005)], [-z0, Math.max(y0, b0 + 0.005)]], d, rot: [0, 90, 0], role };
}

/** Disque vertical (roue, plaque ronde) d'axe x, centré en `c`. */
export function disc(c: V3, r: number, d: number, role: Role, n = 16): Part {
  return { t: "plate", c, pts: circle(r, n), d, rot: [0, 90, 0], role };
}

/** Profil sous forme de fonction (interpolation linéaire). */
function sampler(profile: [number, number][]) {
  return (z: number) => {
    if (z <= profile[0][0]) return profile[0][1];
    for (let i = 0; i < profile.length - 1; i++) {
      const [za, ya] = profile[i], [zb, yb] = profile[i + 1];
      if (z <= zb) return mix(ya, yb, (z - za) / Math.max(1e-6, zb - za));
    }
    return profile[profile.length - 1][1];
  };
}

/** Garde-corps le long d'un profil, des deux côtés (x = ±x). */
function railings(P: PartList, x: number, prof: [number, number][], mat: Mat, role: Role, h = 1.0) {
  const z0 = prof[0][0], z1 = prof[prof.length - 1][0];
  const y = sampler(prof);
  const n = Math.max(2, Math.round((z1 - z0) / (mat === "metal" ? 1.2 : 1.6)) + 1);
  const zs = Array.from({ length: n }, (_, i) => mix(z0, z1, i / (n - 1)));
  for (const sx of [-1, 1]) {
    if (mat === "stone" || mat === "brick" || mat === "concrete") {
      // parapet plein (pierre, brique, béton) et sa tablette
      for (let i = 0; i < prof.length - 1; i++) {
        const [za, ya] = prof[i], [zb, yb] = prof[i + 1];
        P.push(slab(sx * x, 0.16, za, ya + h * 0.85, zb, yb + h * 0.85, h * 0.85, role));
        P.push(slab(sx * x, 0.2, za, ya + h * 0.95, zb, yb + h * 0.95, h * 0.1, "trim"));
      }
      continue;
    }
    for (const z of zs) P.push(rod([sx * x, y(z) - 0.02, z], [sx * x, y(z) + h, z], mat === "metal" ? 0.025 : 0.045, role));
    const top = zs.map((z) => [sx * x, y(z) + h, z] as V3);
    const mid = zs.map((z) => [sx * x, y(z) + h * 0.5, z] as V3);
    P.push({ t: "tube", pts: top, r: mat === "metal" ? 0.03 : 0.04, role }, { t: "tube", pts: mid, r: mat === "metal" ? 0.015 : 0.03, role });
  }
}

/* ---------- pont ---------- */

function bridge(o: O): Built {
  const { L, W, mat } = o;
  const hw = W / 2;
  const form = o.form === "auto" || !["arch", "flat", "truss"].includes(o.form) ? (mat === "stone" || mat === "brick" ? "arch" : mat === "metal" ? "truss" : "flat") : o.form;
  const t = form === "arch" ? 0.35 : 0.3;
  const top = o.clearance + t;
  const N = clamp(Math.round(L / 0.8), 10, 28);
  // profil du dessus du tablier : dos d'âne (arc) ou plat avec rampes d'accès
  const ramp = clamp(top / 0.16, 0.6, L * 0.35);
  const yOf = (z: number) => (form === "arch" ? top * (0.5 + 0.5 * Math.cos((Math.PI * 2 * z) / L)) : top * smoothstep(0, ramp, L / 2 - Math.abs(z)));
  const P: PartList = [];
  // arches : une seule jusqu'à 16 m, puis plusieurs travées séparées par des piles
  const spans = form === "arch" ? Math.max(1, Math.ceil(L / 16)) : 1;
  const La = (L * 0.8) / spans;
  const s = (La / 2) * 0.84;
  const centers = Array.from({ length: spans }, (_, k) => -L * 0.4 + La * (k + 0.5));
  const spring = -0.9;
  const intrados = (z: number) => {
    for (const c of centers) {
      const u = (z - c) / s;
      if (Math.abs(u) < 1) {
        const crown = Math.min(o.clearance, yOf(c) - t - 0.25);
        return Math.min(yOf(z) - t - 0.08, spring + (crown - spring) * Math.sqrt(1 - u * u));
      }
    }
    return null;
  };
  // découpe en z : régulière, plus les naissances des arches (bandes convexes)
  const zs = new Set<number>(Array.from({ length: N + 1 }, (_, i) => Math.round(mix(-L / 2, L / 2, i / N) * 1000) / 1000));
  if (form === "arch") for (const c of centers) for (const e of [-s, s]) zs.add(Math.round((c + e) * 1000) / 1000);
  const Z = [...zs].sort((a, b) => a - b);
  const prof: [number, number][] = Z.map((z) => [z, yOf(z)]);
  const deckRole = o.deck;
  for (let i = 0; i < Z.length - 1; i++) {
    const [z0, z1] = [Z[i], Z[i + 1]];
    P.push(slab(0, hw, z0, yOf(z0), z1, yOf(z1), form === "arch" ? 0.12 : 0.08, deckRole));
  }
  if (form === "arch") {
    // tympans (murs latéraux) au-dessus de la voûte, culées et piles pleines ailleurs
    for (const sx of [-1, 1])
      for (let i = 0; i < Z.length - 1; i++) {
        const [z0, z1] = [Z[i], Z[i + 1]];
        const mz = (z0 + z1) / 2;
        const inArch = intrados(mz) !== null;
        const b0 = inArch ? (intrados(z0 + 1e-4) ?? spring) : -o.depth, b1 = inArch ? (intrados(z1 - 1e-4) ?? spring) : -o.depth;
        const st = strip(sx * (hw - 0.12), 0.12, z0, b0, yOf(z0) - 0.12, z1, b1, yOf(z1) - 0.12, o.main);
        if (st) P.push(st);
      }
    // voûte (douelle) et bandeau de l'arc sur les deux faces
    for (const c of centers) {
      const n = 12;
      const pts: [number, number][] = Array.from({ length: n + 1 }, (_, k) => {
        const z = c - s + (2 * s * k) / n;
        return [z, intrados(Math.max(c - s + 1e-4, Math.min(c + s - 1e-4, z))) ?? spring];
      });
      for (let k = 0; k < n; k++) P.push(slab(0, hw - 0.2, pts[k][0], pts[k][1] + 0.16, pts[k + 1][0], pts[k + 1][1] + 0.16, 0.16, o.main));
      for (const sx of [-1, 1]) P.push({ t: "tube", pts: pts.map(([z, y]) => [sx * (hw + 0.005), y + 0.12, z] as V3), r: 0.13, role: "trim" });
      // avant-becs des piles (entre deux arches)
    }
    for (let k = 0; k < spans - 1; k++) {
      const z = (centers[k] + centers[k + 1]) / 2;
      P.push(bx([0, -o.depth / 2 + 0.1, z], [hw + 0.25, o.depth / 2 + 0.3, 0.35], o.main));
    }
  } else {
    // longerons sous le tablier, piles en paires de poteaux, contreventement
    for (const sx of [-1, 1])
      for (let i = 0; i < Z.length - 1; i++) {
        const [z0, z1] = [Z[i], Z[i + 1]];
        P.push(slab(sx * (hw - 0.2), 0.09, z0, yOf(z0) - 0.08, z1, yOf(z1) - 0.08, form === "truss" ? 0.4 : 0.26, mat === "metal" ? "metal" : o.main));
      }
    const piers = Math.max(1, Math.round(L / 4.5));
    for (let k = 1; k < piers; k++) {
      const z = -L / 2 + (L * k) / piers;
      const y = yOf(z) - 0.3;
      if (y < -0.2 && form !== "truss") continue;
      if (form === "truss" && k % 2 === 0 && piers > 2) continue;
      for (const sx of [-1, 1]) P.push(rod([sx * (hw - 0.2), -o.depth, z], [sx * (hw - 0.2), y, z], mat === "metal" ? 0.12 : 0.14, mat === "metal" ? "stone" : o.main));
      P.push(slab(0, hw - 0.1, z - 0.12, y + 0.02, z + 0.12, y + 0.02, 0.18, mat === "metal" ? "metal" : o.main));
    }
    // culées
    for (const e of [-1, 1]) P.push(bx([0, -0.4, e * (L / 2 - 0.4)], [hw + 0.15, 0.45, 0.45], "stone"));
  }
  if (o.rails) {
    if (form === "truss") {
      // poutres latérales en treillis (Warren) : membrure haute, diagonales
      const h = 1.3;
      const n = Math.max(4, Math.round(L / 1.6));
      for (const sx of [-1, 1]) {
        const x = sx * (hw - 0.05);
        const pts = Array.from({ length: n + 1 }, (_, i) => mix(-L / 2 + 0.6, L / 2 - 0.6, i / n));
        P.push({ t: "tube", pts: pts.map((z) => [x, yOf(z) + h, z] as V3), r: 0.06, role: o.trim });
        for (let i = 0; i < n; i++) {
          const za = pts[i], zb = pts[i + 1];
          P.push(i % 2 ? rod([x, yOf(za) + h, za], [x, yOf(zb), zb], 0.035, o.trim) : rod([x, yOf(za), za], [x, yOf(zb) + h, zb], 0.035, o.trim));
          P.push(rod([x, yOf(za), za], [x, yOf(za) + h, za], 0.03, o.trim));
        }
        P.push(rod([x, yOf(pts[n]), pts[n]], [x, yOf(pts[n]) + h, pts[n]], 0.03, o.trim));
      }
    } else railings(P, hw - 0.1, prof, mat, form === "arch" ? o.main : o.trim, 1.0);
    // piliers d'extrémité
    if (form === "arch" || mat === "stone" || mat === "brick") for (const e of [-1, 1]) for (const sx of [-1, 1]) P.push(bx([sx * (hw - 0.1), 0.55, e * (L / 2 - 0.2)], [0.22, 0.6, 0.22], o.main), bx([sx * (hw - 0.1), 1.2, e * (L / 2 - 0.2)], [0.26, 0.06, 0.26], "trim"));
  }
  const yc = yOf(0);
  const rw = o.rails ? 0.3 : 0.05;
  return {
    parts: P,
    anchors: { deck: [0, yc, 0], "entry.0": [0, 0, -L / 2], "entry.1": [0, 0, L / 2], "approach.0": [0, 0, -L / 2 - 0.8], "approach.1": [0, 0, L / 2 + 0.8], under: [0, 0, 0] },
    affords: ["walk", "cross", "pass-under"],
    walk: [{ hw: hw - rw, profile: prof }],
    blockers: o.rails ? [-1, 1].map((sx) => [sx * (hw - 0.1), 0, 0.2, L / 2] as [number, number, number, number]) : [],
    rest: [[0, -L / 2], [0, L / 2]],
  };
}

/* ---------- ponton, quai ---------- */

function pontoon(o: O): Built {
  const { L, W } = o;
  const hw = W / 2, h = o.H;
  const P: PartList = [];
  // tablier de planches (bandes transversales visibles en vectoriel), solives, pieux
  const n = Math.max(4, Math.round(L / 0.5));
  for (let i = 0; i < n; i++) {
    const z0 = -L / 2 + (L * i) / n, z1 = -L / 2 + (L * (i + 1)) / n;
    P.push(bx([0, h - 0.03, (z0 + z1) / 2], [hw, 0.03, (z1 - z0) / 2 - 0.012], i % 3 === 1 ? o.trim : o.main));
  }
  for (const sx of [-1, 1]) {
    P.push(bx([sx * (hw - 0.1), h - 0.14, 0], [0.07, 0.08, L / 2], o.main));
    const m = Math.max(2, Math.round(L / 2) + 1);
    for (let k = 0; k < m; k++) {
      const z = mix(-L / 2 + 0.2, L / 2 - 0.15, k / (m - 1));
      P.push(rod([sx * (hw - 0.05), -o.depth, z], [sx * (hw - 0.05), h + (k === m - 1 ? 0.35 : 0.02), z], 0.1, o.main));
    }
  }
  // échelle au bout, taquets d'amarrage
  P.push(rod([-0.25, -1.2, L / 2 + 0.06], [-0.25, h + 0.6, L / 2 + 0.06], 0.025, "metal"), rod([0.25, -1.2, L / 2 + 0.06], [0.25, h + 0.6, L / 2 + 0.06], 0.025, "metal"));
  for (let k = 0; k < 5; k++) P.push(rod([-0.25, -1.0 + k * 0.32, L / 2 + 0.06], [0.25, -1.0 + k * 0.32, L / 2 + 0.06], 0.02, "metal"));
  for (const sx of [-1, 1]) P.push({ t: "lathe", c: [sx * (hw - 0.25), h, L / 2 - 1.2], profile: [[0.08, 0], [0.06, 0.12], [0.09, 0.16], [0, 0.18]], role: "metal" });
  const prof: [number, number][] = [[-L / 2 - 0.4, 0], [-L / 2 + 0.6, h], [L / 2, h]];
  if (o.rails) railings(P, hw - 0.05, [[-L / 2 + 0.6, h], [L / 2 - 0.1, h]], "wood", o.main, 0.95);
  return {
    parts: P,
    anchors: { deck: [0, h, 0], end: [0, h, L / 2 - 0.5], spot: [0, h, L / 2 - 0.45], "entry.0": [0, 0, -L / 2], "approach.0": [0, 0, -L / 2 - 0.8], "moor.0": [hw + 0.6, 0, L / 2 - 1.2], "moor.1": [-hw - 0.6, 0, L / 2 - 1.2] },
    affords: ["walk", "moor", "fish", "dive"],
    walk: [{ hw: hw - (o.rails ? 0.25 : 0.1), profile: prof }],
    blockers: o.rails ? [-1, 1].map((sx) => [sx * (hw - 0.05), 0.6, 0.15, L / 2 - 0.6] as [number, number, number, number]) : [],
    rest: [[0, -L / 2]],
  };
}

function quay(o: O): Built {
  // quai : longueur selon x, profondeur W selon z, front vers +z (l'eau) qui descend à −depth
  const { L, W } = o;
  const h = o.H;
  const P: PartList = [];
  P.push(bx([0, (h - o.depth) / 2, 0], [L / 2, (h + o.depth) / 2, W / 2], o.main));
  P.push(bx([0, h + 0.03, 0], [L / 2, 0.03, W / 2 - 0.2], o.deck));
  P.push(bx([0, h + 0.06, W / 2 - 0.2], [L / 2 + 0.02, 0.08, 0.22], "trim"));
  // assises de pierre (lignes) sur le parement
  for (let y = h - 0.4; y > -o.depth + 0.2; y -= 0.45) P.push(bx([0, y, W / 2 + 0.005], [L / 2, 0.015, 0.01], "trim"));
  const nb = Math.max(1, Math.round(L / 5));
  for (let k = 0; k < nb; k++) {
    const x = -L / 2 + (L * (k + 0.5)) / nb;
    P.push({ t: "lathe", c: [x, h + 0.12, W / 2 - 0.45], profile: [[0.16, 0], [0.13, 0.3], [0.17, 0.38], [0.12, 0.44], [0, 0.46]], role: "metal" });
  }
  // échelle scellée dans le parement
  const lx = L / 2 - 1.2;
  for (const dx of [-0.22, 0.22]) P.push(rod([lx + dx, -1.4, W / 2 + 0.05], [lx + dx, h + 0.45, W / 2 + 0.05], 0.022, "metal"));
  for (let k = 0; k < 6; k++) P.push(rod([lx - 0.22, -1.2 + k * 0.3, W / 2 + 0.05], [lx + 0.22, -1.2 + k * 0.3, W / 2 + 0.05], 0.018, "metal"));
  if (o.rails) for (const sx of [-1, 1]) P.push(rod([sx * L * 0.25, h, W / 2 - 0.15], [sx * L * 0.25, h + 0.9, W / 2 - 0.15], 0.03, "metal"));
  const anchors: Record<string, V3> = { deck: [0, h, 0], edge: [0, h, W / 2 - 0.3], spot: [0, h, W / 2 - 0.35], "entry.0": [0, 0, -W / 2], "approach.0": [0, h, -W / 2 + 0.4] };
  for (let k = 0; k < nb; k++) anchors[`moor.${k}`] = [-L / 2 + (L * (k + 0.5)) / nb, 0, W / 2 + 1.0];
  return { parts: P, anchors, affords: ["walk", "moor", "fish"], walk: [{ hw: L / 2 - 0.1, profile: [[-W / 2, h], [W / 2 - 0.35, h]] }], blockers: [], rest: [[-L / 2, -W / 2], [L / 2, -W / 2]] };
}

/* ---------- escalier, rampe ---------- */

function stairs(o: O, ramp: boolean): Built {
  const { W, mat } = o;
  const hw = W / 2, H = o.H;
  const n = ramp ? 0 : o.steps > 0 ? o.steps : clamp(Math.round(H / 0.17), 1, 40);
  const tread = 0.3;
  const run = ramp ? Math.max(H / 0.12, o.L - 1) : n * tread;
  const land = ramp ? 1.2 : clamp(o.L - run, 0.6, 6);
  const D = run + land;
  const zb = D / 2, zt = D / 2 - run;
  const P: PartList = [];
  const solid = mat !== "wood" && mat !== "metal";
  if (ramp) {
    if (solid) {
      // dalle pleine : bandes latérales en trapèze, surface inclinée, palier
      for (const sx of [-1, 1]) {
        const st = strip(sx * (hw - 0.1), 0.1, -D / 2, 0, H, zt, 0, H, o.main);
        if (st) P.push(st);
        const st2 = strip(sx * (hw - 0.1), 0.1, zt, 0, H, zb, 0, 0.02, o.main);
        if (st2) P.push(st2);
      }
      P.push(bx([0, H / 2, -D / 2 + 0.1], [hw, H / 2, 0.1], o.main));
    } else {
      for (const sx of [-1, 1]) for (const z of [zt + 0.1, -D / 2 + 0.1, (zt + zb) / 2]) {
        const y = z <= zt ? H : H * ((zb - z) / run);
        if (y > 0.05) P.push(rod([sx * (hw - 0.1), 0, z], [sx * (hw - 0.1), y - 0.06, z], 0.06, o.main));
      }
    }
    P.push(slab(0, hw, zb, 0.04, zt, H, 0.08, o.deck), slab(0, hw, zt, H, -D / 2, H, 0.08, o.deck));
  } else if (solid) {
    // marches empilées (chacune pleine jusqu'au palier)
    for (let i = 0; i < n; i++) {
      const y0 = (i * H) / n, y1 = ((i + 1) * H) / n;
      const zf = zb - i * tread;
      P.push(bx([0, (y0 + y1) / 2, (zf - D / 2) / 2], [hw, (y1 - y0) / 2, (zf + D / 2) / 2], i % 2 ? o.main : o.deck));
      // nez de marche
      P.push(bx([0, y1 - 0.015, zf - 0.02], [hw + 0.01, 0.015, 0.025], "trim"));
    }
  } else {
    // limons inclinés, marches en planches, palier sur poteaux
    for (const sx of [-1, 1]) {
      P.push(slab(sx * (hw - 0.04), 0.04, zb, 0.05, zt, H + 0.02, 0.25, o.main));
      for (const z of [zt + 0.05, -D / 2 + 0.08]) P.push(rod([sx * (hw - 0.08), 0, z], [sx * (hw - 0.08), H - 0.05, z], 0.06, o.main));
    }
    for (let i = 0; i < n; i++) {
      const y1 = ((i + 1) * H) / n;
      const zf = zb - i * tread;
      P.push(bx([0, y1 - 0.025, zf - tread / 2], [hw - 0.08, 0.025, tread / 2 - 0.01], o.deck));
    }
    P.push(bx([0, H - 0.03, (zt - D / 2) / 2], [hw, 0.03, (zt + D / 2) / 2], o.deck));
  }
  // garde-corps : main courante le long de la volée et du palier
  if (o.rails) {
    const rp: [number, number][] = [[-D / 2 + 0.05, H], [zt, H], [zb - 0.05, 0]];
    for (const sx of [-1, 1]) {
      const x = sx * (hw - 0.06);
      for (const [z, y] of rp) P.push(rod([x, y, z], [x, y + 0.95, z], 0.025, o.trim));
      P.push({ t: "tube", pts: rp.map(([z, y]) => [x, y + 0.95, z] as V3), r: 0.03, role: o.trim });
      if (mat === "wood") P.push({ t: "tube", pts: rp.map(([z, y]) => [x, y + 0.48, z] as V3), r: 0.022, role: o.trim });
    }
  }
  const walkProf: [number, number][] = [[-D / 2, H], [zt, H], [zb, 0.02], [zb + 0.3, 0]];
  return {
    parts: P,
    anchors: { bottom: [0, 0, zb], top: [0, H, (zt - D / 2) / 2], deck: [0, H, (zt - D / 2) / 2], "entry.0": [0, 0, zb], "entry.1": [0, H, -D / 2], "approach.0": [0, 0, zb + 0.6] },
    affords: ["walk", "climb", ramp ? "roll" : "sit"],
    walk: [{ hw: hw - (o.rails ? 0.15 : 0.02), profile: walkProf }],
    blockers: o.rails ? [-1, 1].map((sx) => [sx * (hw - 0.06), 0, 0.12, D / 2] as [number, number, number, number]) : [],
    rest: [[0, zb], [0, -D / 2]],
  };
}

/* ---------- arche, portail ---------- */

function arch(o: O): Built {
  const { W, H, mat } = o;
  const hw = W / 2;
  const form = ["round", "pointed", "torii"].includes(o.form) ? o.form : mat === "wood" ? "torii" : "round";
  const P: PartList = [];
  const d = 0.3;
  if (form === "torii") {
    // torii : deux poteaux légèrement inclinés, linteau (nuki), grand linteau courbe (kasagi) aux bouts relevés
    const r = 0.16;
    for (const sx of [-1, 1]) {
      P.push(rod([sx * (hw + r), 0, 0], [sx * (hw + r - 0.08), H + 0.35, 0], r, o.main, r * 0.85));
      P.push({ t: "lathe", c: [sx * (hw + r), 0, 0], profile: [[r * 1.35, 0], [r * 1.35, 0.35], [r * 1.1, 0.38], [0, 0.38]], role: "ink" });
    }
    P.push(bx([0, H - 0.1, 0], [hw + 0.55, 0.1, 0.09], o.main));
    P.push(bx([0, H + 0.38, 0], [hw + 0.4, 0.09, 0.14], o.main));
    const k = 8, span = hw + 1.0;
    const pts = Array.from({ length: k + 1 }, (_, i) => {
      const x = mix(-span, span, i / k);
      return [x, H + 0.6 + 0.22 * (x / span) ** 4] as [number, number];
    });
    for (let i = 0; i < k; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const a = Math.atan2(y1 - y0, x1 - x0);
      P.push(bx([(x0 + x1) / 2, (y0 + y1) / 2, 0], [Math.hypot(x1 - x0, y1 - y0) / 2 + 0.01, 0.12, 0.2], "ink", [0, 0, a / DEG]));
      P.push(bx([(x0 + x1) / 2, (y0 + y1) / 2 - 0.15, 0], [Math.hypot(x1 - x0, y1 - y0) / 2 + 0.01, 0.06, 0.17], o.main, [0, 0, a / DEG]));
    }
    P.push(bx([0, H + 0.2, 0.1], [0.18, 0.22, 0.02], "ink"));
    return {
      parts: P,
      anchors: { top: [0, H + 0.8, 0], pass: [0, 0, 0], "entry.0": [0, 0, -0.8], "entry.1": [0, 0, 0.8] },
      affords: ["pass"],
      blockers: [-1, 1].map((sx) => [sx * (hw + 0.16), 0, 0.25, 0.25] as [number, number, number, number]),
    };
  }
  // piédroits, impostes, arc clavé (voussoirs), corniche
  const pw = 0.45;
  const spring = form === "round" ? H - hw : H - hw * Math.sqrt(3) * 0.95;
  const sp = Math.max(0.6, spring);
  for (const sx of [-1, 1]) {
    P.push(bx([sx * (hw + pw / 2), sp / 2, 0], [pw / 2, sp / 2, d], o.main));
    P.push(bx([sx * (hw + pw / 2), sp + 0.06, 0], [pw / 2 + 0.05, 0.06, d + 0.04], "trim"));
    P.push(bx([sx * (hw + pw / 2), 0.15, 0], [pw / 2 + 0.06, 0.15, d + 0.05], "trim"));
  }
  const ring: { c: [number, number]; a: number; r: number }[] = [];
  const n = 13;
  if (form === "round") for (let i = 0; i < n; i++) ring.push({ c: [0, sp + 0.12], a: Math.PI - ((i + 0.5) / n) * Math.PI, r: hw + 0.22 });
  else {
    // ogive équilatérale : deux arcs de rayon W centrés sur les naissances opposées
    const R = W + 0.22;
    const a1 = Math.acos((hw) / R);
    const m = Math.ceil(n / 2);
    for (let i = 0; i < m; i++) {
      const a = Math.PI - ((i + 0.5) / m) * (a1 - 0.02);
      ring.push({ c: [hw, sp + 0.12], a, r: R });
      ring.push({ c: [-hw, sp + 0.12], a: Math.PI - a, r: R });
    }
  }
  const seg = form === "round" ? ((hw + 0.22) * Math.PI) / n / 2 : (((W + 0.22) * (Math.PI / 3)) / Math.ceil(n / 2)) / 2;
  const cy = sp + 0.12;
  // extrados (dos de l'arc) : demi-cercle, ou deux arcs de l'ogive
  const Ro = form === "round" ? hw + 0.44 : W + 0.44;
  const ext = (x: number) => {
    if (form === "round") return Math.abs(x) < Ro ? cy + Math.sqrt(Ro * Ro - x * x) : cy;
    const dx = Math.abs(x) + hw;
    return dx < Ro ? cy + Math.sqrt(Math.max(0, Ro * Ro - dx * dx)) : cy;
  };
  const topY = Math.max(ext(0), cy) + 0.05;
  for (const v of ring) {
    const x = v.c[0] + v.r * Math.cos(v.a), y = v.c[1] + v.r * Math.sin(v.a);
    P.push(bx([x, y, 0], [0.22, seg + 0.005, d], v === ring[Math.floor(ring.length / 2)] && form === "round" ? "trim" : o.main, [0, 0, v.a / DEG]));
  }
  if (form === "round") P.push(bx([0, cy + hw + 0.22, 0], [0.16, 0.28, d + 0.04], "trim"));
  // écoinçons : bandes verticales entre l'extrados et le haut du portail (un peu en retrait de l'arc)
  const X = hw + pw;
  const k = 10;
  for (const sx of [-1, 1])
    for (let i = 0; i < k; i++) {
      const xa = sx * (X * i) / k, xb = sx * (X * (i + 1)) / k;
      const ya = Math.min(topY, ext(xa)) - 0.03, yb = Math.min(topY, ext(xb)) - 0.03;
      if (topY - ya < 0.02 && topY - yb < 0.02) continue;
      P.push({ t: "plate", c: [0, 0, 0], pts: [[xa, ya], [xb, yb], [xb, topY], [xa, topY]], d: d - 0.03, role: o.main });
    }
  // corniche et couronnement
  P.push(bx([0, topY + 0.1, 0], [hw + pw + 0.1, 0.1, d + 0.06], "trim"), bx([0, topY + 0.32, 0], [hw + pw - 0.05, 0.12, d - 0.04], o.main));
  for (const sx of [-1, 1]) P.push(bx([sx * (hw + pw / 2), (sp + topY) / 2 + 0.06, 0], [pw / 2, (topY - sp) / 2, d], o.main));
  return {
    parts: P,
    anchors: { top: [0, topY + 0.44, 0], pass: [0, 0, 0], "entry.0": [0, 0, -0.9], "entry.1": [0, 0, 0.9] },
    affords: ["pass"],
    blockers: [-1, 1].map((sx) => [sx * (hw + pw / 2), 0, pw / 2 + 0.06, d + 0.05] as [number, number, number, number]),
  };
}

function gate(o: O): Built {
  const { W, H, mat } = o;
  const hw = W / 2;
  const iron = o.form === "iron" || (o.form !== "wood" && mat !== "wood");
  const P: PartList = [];
  const pw = 0.4;
  // piliers maçonnés et leurs chapeaux
  for (const sx of [-1, 1]) {
    P.push(bx([sx * (hw + pw / 2), (H + 0.3) / 2, 0], [pw / 2, (H + 0.3) / 2, pw / 2], o.main));
    P.push(bx([sx * (hw + pw / 2), H + 0.36, 0], [pw / 2 + 0.05, 0.06, pw / 2 + 0.05], "trim"));
    P.push({ t: "blob", c: [sx * (hw + pw / 2), H + 0.55, 0], r: [0.14, 0.14, 0.14], role: "trim" });
  }
  // vantaux : construits fermés, charnière à l'origine, puis tournés vers l'intérieur (−z)
  const lw = hw - 0.02;
  for (const sx of [-1, 1]) {
    const L: PartList = [];
    const x = (u: number) => -sx * u; // de la charnière vers le centre
    const hTop = (u: number) => H - 0.1 + (iron ? 0.25 * Math.sin((u / lw) * Math.PI * 0.5) : 0);
    if (iron) {
      L.push(rod([x(0.03), 0.1, 0], [x(0.03), hTop(0.03), 0], 0.03, o.trim), rod([x(lw), 0.1, 0], [x(lw), hTop(lw), 0], 0.03, o.trim));
      L.push(rod([x(0), 0.12, 0], [x(lw), 0.12, 0], 0.025, o.trim), rod([x(0), H * 0.45, 0], [x(lw), H * 0.45, 0], 0.02, o.trim));
      const bars = Math.max(4, Math.round(lw / 0.12));
      const top: V3[] = [];
      for (let i = 0; i <= bars; i++) {
        const u = (lw * i) / bars;
        top.push([x(u), hTop(u), 0]);
        if (i > 0 && i < bars) {
          L.push(rod([x(u), 0.12, 0], [x(u), hTop(u) + 0.08, 0], 0.012, o.trim));
          L.push({ t: "plate", c: [x(u), hTop(u) + 0.12, 0], pts: [[-0.03, -0.04], [0.03, -0.04], [0, 0.05]], d: 0.01, role: o.trim });
        }
      }
      L.push({ t: "tube", pts: top, r: 0.025, role: o.trim });
    } else {
      const planks = Math.max(3, Math.round(lw / 0.16));
      for (let i = 0; i < planks; i++) {
        const u = (lw * (i + 0.5)) / planks;
        L.push(bx([x(u), (H - 0.1) / 2 + 0.06, 0], [lw / planks / 2 - 0.008, (H - 0.1) / 2 - 0.04 + (i % 2) * 0.03, 0.025], o.trim));
      }
      for (const y of [0.35, H - 0.4]) L.push(bx([x(lw / 2), y, -0.04], [lw / 2, 0.06, 0.02], o.trim));
      // écharpe en diagonale
      const a = Math.atan2(H - 0.75, lw - 0.1);
      L.push(bx([x(lw / 2), H / 2 - 0.02, -0.04], [Math.hypot(lw - 0.1, H - 0.75) / 2, 0.05, 0.02], o.trim, [0, 0, sx * a / DEG]));
    }
    const ang = o.open * 80 * DEG * sx;
    P.push(...transformParts(L, [0, Math.sin(-ang / 2), 0, Math.cos(-ang / 2)] as Q, [sx * hw, 0, 0]));
  }
  const blockers: [number, number, number, number][] = [-1, 1].map((sx) => [sx * (hw + pw / 2), 0, pw / 2 + 0.05, pw / 2 + 0.05]);
  if (o.open < 0.5) blockers.push([0, 0, hw, 0.1]);
  return { parts: P, anchors: { top: [0, H + 0.7, 0], pass: [0, 0, 0], "entry.0": [0, 0, -0.9], "entry.1": [0, 0, 0.9] }, affords: o.open >= 0.5 ? ["pass", "close"] : ["open"], blockers };
}

/* ---------- voie ferrée ---------- */

function rails(o: O): Built {
  const { L } = o;
  const P: PartList = [];
  const g = 1.435 / 2;
  // tronçons d'un mètre environ (ballast, rails) : le tri du dessin vectoriel reste juste sur une longue voie
  const n = Math.max(2, Math.round(L / 0.6));
  for (let i = 0; i < n; i++) {
    const z0 = -L / 2 + (L * i) / n, z1 = -L / 2 + (L * (i + 1)) / n, zc = (z0 + z1) / 2, hz = (z1 - z0) / 2;
    P.push({ t: "plate", c: [0, 0.12, zc], pts: [[-g - 0.9, -hz], [g + 0.9, -hz], [g + 0.9, hz], [-g - 0.9, hz]], d: 0.06, rot: [-90, 0, 0], role: "stone" });
    P.push(bx([0, 0.15, zc], [g + 0.45, 0.04, 0.11], o.main));
    for (const sx of [-1, 1]) P.push(bx([sx * g, 0.24, zc], [0.035, 0.05, hz + 0.002], "metal"));
  }
  return { parts: P, anchors: { track: [0, 0.29, 0], "end.0": [0, 0.29, -L / 2], "end.1": [0, 0.29, L / 2] }, affords: ["walk"], blockers: [] };
}

/* ---------- modèle ---------- */

const DEFAULTS: Record<string, { L: number; W: number; H: number; mat: Mat; label: string; main: Partial<Record<Mat, Role>>; trim: Role; deck: Partial<Record<Mat, Role>> }> = {
  bridge: { L: 10, W: 3, H: 1.6, mat: "stone", label: "Pont", main: { stone: "stone", brick: "roof", wood: "wood", metal: "metal", concrete: "wall" }, trim: "metal", deck: { stone: "path", brick: "path", wood: "wood", metal: "wood", concrete: "road" } },
  pontoon: { L: 6, W: 1.8, H: 0.4, mat: "wood", label: "Ponton", main: { wood: "wood" }, trim: "bark", deck: { wood: "wood" } },
  quay: { L: 12, W: 4, H: 0.5, mat: "stone", label: "Quai", main: { stone: "stone", brick: "roof", concrete: "wall" }, trim: "trim", deck: { stone: "stone", brick: "path", concrete: "road" } },
  stairs: { L: 0, W: 1.6, H: 1.5, mat: "stone", label: "Escalier", main: { stone: "stone", brick: "roof", wood: "wood", metal: "metal", concrete: "wall" }, trim: "metal", deck: { stone: "stone", brick: "trim", wood: "wood", metal: "metal", concrete: "wall" } },
  ramp: { L: 8, W: 1.6, H: 0.8, mat: "concrete", label: "Rampe", main: { stone: "stone", wood: "wood", metal: "metal", concrete: "wall", brick: "roof" }, trim: "metal", deck: { stone: "path", wood: "wood", metal: "metal", concrete: "road", brick: "path" } },
  arch: { L: 0, W: 2.4, H: 3, mat: "stone", label: "Arche", main: { stone: "stone", brick: "roof", wood: "red", concrete: "wall", metal: "metal" }, trim: "trim", deck: {} },
  gate: { L: 0, W: 3, H: 1.8, mat: "stone", label: "Portail", main: { stone: "stone", brick: "roof", concrete: "wall", wood: "stone", metal: "stone" }, trim: "ink", deck: {} },
  rails: { L: 12, W: 3, H: 0, mat: "wood", label: "Voie ferrée", main: { wood: "wood", concrete: "wall", stone: "wood", metal: "wood", brick: "wood" }, trim: "metal", deck: {} },
};

export type StructureModel = Built & { label: string; kind: string; scale: number };

export function structureModel(p: Record<string, unknown>): StructureModel {
  const kind = (STRUCTURE_KINDS as readonly string[]).includes(String(p.kind)) ? String(p.kind) : "bridge";
  const D = DEFAULTS[kind];
  const matIn = String(p.material ?? "auto");
  const mat = (matIn !== "auto" && (STRUCTURE_MATERIALS as readonly string[]).includes(matIn) ? matIn : kind === "arch" && p.form === "torii" ? "wood" : D.mat) as Mat;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  const o: O = {
    kind,
    form: String(p.form ?? "auto"),
    mat,
    L: clamp(num(p.length, D.L || 4), 1, 60),
    W: clamp(num(p.width, D.W), 0.6, 30),
    H: clamp(num(p.height, D.H || 1), 0.05, 20),
    clearance: clamp(typeof p.clearance === "number" && Number.isFinite(p.clearance) ? p.clearance : kind === "bridge" ? (mat === "stone" || mat === "brick" ? 1.8 : 0.6) : 0.5, 0, 12),
    rails: p.rails === true || p.rails === "yes" ? true : p.rails === false || p.rails === "no" ? false : kind !== "pontoon" && kind !== "quay",
    steps: Math.max(0, Math.round(Number(p.steps ?? 0)) || 0),
    depth: clamp(num(p.depth, 1.2), 0.2, 20),
    open: clamp(Number(p.open ?? 0) || 0, 0, 1),
    main: roleParam(p.color, D.main[mat] ?? Object.values(D.main)[0] ?? "stone"),
    trim: roleParam(p.color2, D.trim),
    deck: roleParam(p.color3, D.deck[mat] ?? Object.values(D.deck)[0] ?? "wood"),
  };
  const b =
    kind === "bridge" ? bridge(o) : kind === "pontoon" ? pontoon(o) : kind === "quay" ? quay(o) : kind === "stairs" ? stairs(o, false) : kind === "ramp" ? stairs(o, true) : kind === "arch" ? arch(o) : kind === "gate" ? gate(o) : rails(o);
  const s = clamp(Number(p.scale ?? 1) || 1, 0.2, 5);
  if (s === 1) return { ...b, label: D.label, kind, scale: 1 };
  const S = (v: V3): V3 => [v[0] * s, v[1] * s, v[2] * s];
  return {
    parts: transformParts(b.parts, [0, 0, 0, 1], [0, 0, 0], s),
    anchors: Object.fromEntries(Object.entries(b.anchors).map(([k, v]) => [k, S(v)])),
    affords: b.affords,
    walk: b.walk?.map((w) => ({ hw: w.hw * s, profile: w.profile.map(([z, y]) => [z * s, y * s] as [number, number]) })),
    blockers: b.blockers?.map(([x, z, hx, hz]) => [x * s, z * s, hx * s, hz * s] as [number, number, number, number]),
    rest: b.rest?.map(([x, z]) => [x * s, z * s] as [number, number]),
    label: D.label,
    kind,
    scale: s,
  };
}

export const structure = defineGenerator({
  id: "structure",
  label: "Ouvrage (pont, ponton, quai, escalier, rampe, arche, portail, voie ferrée)",
  doc:
    "Ouvrages praticables sur la grammaire de pièces (même modèle en 3D et en vectoriel) : bridge (pont : `form` arch = arc de pierre en dos d'âne, plusieurs arches au-delà de 16 m ; flat = tablier plat sur pieux avec rampes ; truss = poutres de métal en treillis), pontoon (ponton de planches sur pieux, échelle, taquets), quay (quai maçonné, front vers +z, bittes d'amarrage), stairs (escalier et palier : `height`, `steps`), ramp (rampe et palier), arch (arche : `form` round, pointed, torii), gate (portail à deux vantaux : `form` iron ou wood, `open` 0…1), rails (voie ferrée : ballast, traverses, rails). Passage selon z (entrées −z et +z), largeur selon x ; y = 0 au niveau des appuis. Pont : `length` (portée, m), `width`, `clearance` (hauteur libre au milieu au-dessus des berges : ≥ 2,5 m laisse passer une barque ou un voilier démâté) ; placé `{across: \"<rivière>\"}`, il enjambe la route ou la rivière (longueur ajustée à sa largeur si `length` n'est pas donné). `rails` (garde-corps). Les acteurs marchent sur le tablier, les marches et le palier à leur hauteur (la navigation passe au-dessus de l'eau) ; les garde-corps et piliers bloquent. Ancres : deck, top, entry.0 / entry.1, approach.0 / approach.1 (devant les entrées), under (sous le pont), pass (arche, portail), bottom / top (escalier), end, spot (bout du ponton, bord du quai : pêcher, boire), moor.N (amarrage), track, end.0 / end.1 (voie ferrée). `extra.affords` : walk, cross, pass-under, moor, fish, climb, pass, open…",
  tags: ["ouvrage", "pont", "rivière", "port", "quai", "escalier", "jardin", "ville", "architecture"],
  schema: {
    kind: { type: "enum", default: "bridge", options: STRUCTURE_KINDS, doc: "Ouvrage" },
    form: { type: "enum", default: "auto", options: STRUCTURE_FORMS, doc: "Forme : pont arch|flat|truss, arche round|pointed|torii, portail iron|wood (auto selon le matériau)" },
    material: { type: "enum", default: "auto", options: STRUCTURE_MATERIALS, doc: "Matériau (auto selon l'ouvrage)" },
    length: { type: "number", default: 0, min: 0, max: 60, unit: "m", doc: "Longueur selon z (pont : portée ; ponton ; quai : selon x ; rampe : longueur totale ; escalier : volée + palier) ; 0 = défaut" },
    width: { type: "number", default: 0, min: 0, max: 30, unit: "m", doc: "Largeur (passage, arche, portail ; quai : profondeur) ; 0 = défaut" },
    height: { type: "number", default: 0, min: 0, max: 20, unit: "m", doc: "Hauteur : escalier, rampe (dénivelé), arche, portail (ouverture), ponton et quai (tablier au-dessus des appuis) ; 0 = défaut" },
    clearance: { type: "number", default: -1, min: -1, max: 12, unit: "m", doc: "Pont : hauteur libre sous le tablier au milieu (−1 = défaut : 1,8 m en pierre, 0,6 m sinon)" },
    steps: { type: "int", default: 0, min: 0, max: 40, doc: "Escalier : nombre de marches (0 = hauteur / 0,17 m)" },
    rails: { type: "enum", default: "auto", options: ["auto", "yes", "no"], doc: "Garde-corps, main courante (auto : oui, sauf ponton et quai)" },
    open: { type: "number", default: 0, min: 0, max: 1, doc: "Portail : ouverture des vantaux (0 fermé, 1 grand ouvert)" },
    depth: { type: "number", default: 1.2, min: 0.2, max: 20, unit: "m", doc: "Profondeur des piles, pieux et parements sous les appuis" },
    scale: { type: "number", default: 1, min: 0.2, max: 5, doc: "Échelle" },
    color: { type: "string", default: "auto", doc: "Rôle principal (maçonnerie, bois)" },
    color2: { type: "string", default: "auto", doc: "Rôle secondaire (garde-corps, ferronnerie)" },
    color3: { type: "string", default: "auto", doc: "Rôle du tablier, des marches" },
  },
  build(p) {
    const m = structureModel({ ...p, clearance: p.clearance < 0 ? undefined : p.clearance });
    const mesh = partsToMesh(m.parts, 0.85);
    const bb = partsBounds(m.parts);
    // voie ferrée : emprise réduite aux rails (un train posé dessus passe devant elle dans le dessin vectoriel)
    const hx = m.kind === "rails" ? 0.6 * m.scale : Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), 0.1);
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]), 0.1);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = { top: { pos: [0, bb.max[1], 0], rot, scale: m.scale } };
    for (const [k, v] of Object.entries(m.anchors)) anchors[k] = { pos: v, rot, scale: m.scale };
    return {
      generator: "structure",
      mesh,
      anchors,
      footprint: { hx, hz, r: Math.hypot(hx, hz) },
      height: Math.max(0.05, bb.max[1]),
      extra: { affords: m.affords, label: m.label, kind: m.kind, walk: m.walk ?? [], blockers: m.blockers ?? null, rest: m.rest ?? null },
    };
  },
});
