/**
 * Herbes hautes, champs de blé, roseaux, prairies fleuries : des brins instanciés semés sur une zone du monde.
 * Lecture et semis ici (communs, testables) ; le rendu 3D (vent et ploiement dans le shader) est dans
 * addons/3d/herbes3d.ts.
 */
import { Rand } from "./math";

export type HerbeKind = "herbe" | "ble" | "roseau" | "fleurs" | "gazon";

export type HerbeField = {
  kind: HerbeKind;
  /** Zone : rectangle [x0, z0, x1, z1] ou polygone [[x, z]…] (mètres). */
  rect: [number, number, number, number];
  poly: [number, number][] | null;
  /** Brins par m². */
  density: number;
  /** Hauteur des brins (m), mini et maxi. */
  height: [number, number];
  /** Couleurs au pied et à la pointe ; `fleur` : couleurs des fleurs (fleurs). */
  base: string;
  tip: string;
  flowers: string[];
  /** Largeur des brins (m). */
  width: number;
  /** Souplesse au vent (0 à 2) ; les brins se couchent au passage des instances nommées (`plie`). */
  sway: number;
  bend: boolean;
  /** Laisse le sol libre sous le décor posé (maisons, murs). */
  clear: boolean;
  seed: number;
};

export const HERBE_KINDS: Record<HerbeKind, Omit<HerbeField, "kind" | "rect" | "poly" | "seed" | "bend" | "clear">> = {
  herbe: { density: 220, height: [0.35, 0.8], base: "#3d5f2a", tip: "#a4c25e", flowers: [], width: 0.035, sway: 1 },
  ble: { density: 260, height: [0.8, 1.15], base: "#8f7e3e", tip: "#e8cc72", flowers: [], width: 0.02, sway: 0.7 },
  roseau: { density: 90, height: [1.4, 2.3], base: "#4f6230", tip: "#c4b878", flowers: [], width: 0.03, sway: 0.6 },
  fleurs: { density: 180, height: [0.25, 0.6], base: "#3f6a2c", tip: "#8fbf55", flowers: ["#f2d64b", "#e86a6a", "#f4f1ea", "#9b7fe0"], width: 0.03, sway: 1.1 },
  gazon: { density: 600, height: [0.06, 0.14], base: "#3f6f2e", tip: "#86b950", flowers: [], width: 0.025, sway: 0.4 },
};

const ALIAS: Record<string, HerbeKind> = { grass: "herbe", herbes: "herbe", wheat: "ble", "blé": "ble", champ: "ble", reeds: "roseau", roseaux: "roseau", flowers: "fleurs", prairie: "fleurs", lawn: "gazon", pelouse: "gazon" };

/** Brins au plus pour tout le monde, selon `detail` (0, 1, 2). */
export const HERBE_BUDGET = [20000, 60000, 160000];

const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d);

export function readHerbes(v: unknown, issues: { path: string; message: string }[]): HerbeField[] {
  if (v === undefined || v === null || v === false) return [];
  const list = Array.isArray(v) ? v : [v];
  const out: HerbeField[] = [];
  list.slice(0, 16).forEach((raw, i) => {
    const path = `herbes.${i}`;
    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!o) return;
    const t = String(o.type ?? o.kind ?? "herbe").toLowerCase();
    const kind = (HERBE_KINDS as Record<string, unknown>)[t] ? (t as HerbeKind) : ALIAS[t];
    if (!kind) {
      issues.push({ path, message: `herbe « ${t} » inconnue (${Object.keys(HERBE_KINDS).join(", ")})` });
      return;
    }
    const d = HERBE_KINDS[kind];
    const z = o.zone;
    let rect: [number, number, number, number] | null = null;
    let poly: [number, number][] | null = null;
    if (Array.isArray(z) && z.length === 4 && z.every((x) => typeof x === "number" && Number.isFinite(x))) {
      const [a, b, c, e] = z as number[];
      rect = [Math.min(a, c), Math.min(b, e), Math.max(a, c), Math.max(b, e)];
    } else if (Array.isArray(z) && z.length >= 3 && z.every((p) => Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number")) {
      poly = (z as number[][]).slice(0, 64).map((p) => [p[0], p[1]]);
      rect = [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1])), Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))];
    }
    if (!rect || rect[2] - rect[0] <= 0 || rect[3] - rect[1] <= 0) {
      issues.push({ path: `${path}.zone`, message: "zone attendue : [x0, z0, x1, z1] ou [[x, z], …] (mètres)" });
      return;
    }
    const h = Array.isArray(o.hauteur) && o.hauteur.length >= 2 ? [num(o.hauteur[0], d.height[0], 0.02, 6), num(o.hauteur[1], d.height[1], 0.02, 6)] : typeof o.hauteur === "number" ? [num(o.hauteur, 0.5, 0.02, 6) * 0.8, num(o.hauteur, 0.5, 0.02, 6) * 1.1] : d.height;
    out.push({
      kind,
      rect,
      poly,
      density: num(o.densite ?? o.density, d.density, 1, 3000),
      height: [Math.min(h[0], h[1]), Math.max(h[0], h[1])],
      base: isColor(o.pied ?? o.base) ? ((o.pied ?? o.base) as string) : d.base,
      tip: isColor(o.pointe ?? o.tip) ? ((o.pointe ?? o.tip) as string) : d.tip,
      flowers: Array.isArray(o.fleurs) ? (o.fleurs as unknown[]).filter(isColor).slice(0, 8) : d.flowers,
      width: num(o.largeur ?? o.width, d.width, 0.005, 0.3),
      sway: num(o.souplesse ?? o.sway, d.sway, 0, 2),
      bend: o.plie !== false && o.bend !== false,
      clear: o.degage !== false && o.clear !== false,
      seed: typeof o.graine === "number" ? o.graine : i * 7919 + 13,
    });
  });
  return out;
}

function inPoly(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Emprise au sol d'un obstacle (boîte alignée), pour laisser le sol libre dessous. */
export type Foot = { lo: [number, number]; hi: [number, number] };

/**
 * Semis d'un champ : `x z angle hauteur teinte phase` par brin (6 nombres). `share` = part du budget accordée au
 * champ ; la densité baisse uniformément si le champ dépasse sa part.
 */
export function sowField(f: HerbeField, share: number, feet: Foot[] = []): Float32Array {
  const [x0, z0, x1, z1] = f.rect;
  const area = (x1 - x0) * (z1 - z0);
  const want = Math.min(share, Math.round(area * f.density));
  const out = new Float32Array(want * 6);
  const r = new Rand(f.seed);
  // semis à désordre sur une grille (pas de trous ni de touffes)
  const cell = Math.sqrt(area / Math.max(1, want));
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  let n = 0;
  for (let j = 0; j < nz && n < want; j++)
    for (let i = 0; i < nx && n < want; i++) {
      const x = x0 + (i + r.next()) * cell, z = z0 + (j + r.next()) * cell;
      if (x > x1 || z > z1) continue;
      if (f.poly && !inPoly(x, z, f.poly)) continue;
      if (f.clear && feet.some((b) => x > b.lo[0] && x < b.hi[0] && z > b.lo[1] && z < b.hi[1])) continue;
      // les touffes : hauteur corrélée par un bruit doux (vagues de hauteur dans le champ)
      const wave = 0.5 + 0.5 * Math.sin(x * 0.7 + f.seed) * Math.cos(z * 0.55 - f.seed * 0.3);
      const k = n * 6;
      out[k] = x;
      out[k + 1] = z;
      out[k + 2] = r.next() * Math.PI * 2;
      out[k + 3] = f.height[0] + (f.height[1] - f.height[0]) * (0.35 * wave + 0.65 * r.next());
      out[k + 4] = r.next();
      out[k + 5] = r.next() * Math.PI * 2;
      n++;
    }
  return out.subarray(0, n * 6);
}

/** Part du budget de chaque champ, au prorata de son nombre de brins voulu. */
export function shares(fields: HerbeField[], budget: number): number[] {
  const want = fields.map((f) => (f.rect[2] - f.rect[0]) * (f.rect[3] - f.rect[1]) * f.density);
  const total = want.reduce((a, b) => a + b, 0);
  const k = total > budget ? budget / total : 1;
  return want.map((w) => Math.floor(w * k));
}
