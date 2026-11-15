/**
 * Emprises et surfaces d'appui des modèles d'un « monde » : de quoi poser un objet sur un autre (`on`), l'empiler
 * (`stack`) et semer sans chevauchement (`spacing`, `avoid`).
 *
 * Tout est mesuré sur le maillage réel des pièces en pose de repos (pas d'approximation par forme), une fois par
 * modèle et à la demande : un monde qui n'utilise pas ces fonctions ne paie rien.
 */
import type { Model } from "./format";
import { geometryOf } from "./geometry";
import { m4, type M4 } from "./math";
import { forward, STRIDE } from "./pose";

export type Box3 = { min: [number, number, number]; max: [number, number, number] };
/** Face qui reçoit : dessus (`top`), face verticale tournée vers +z (`+z` : un mur vu de l'intérieur), dessous (`-y` : un plafond). */
export type Face = "top" | "+z" | "-y";
/** D'où `at` se compte : centre de la surface, origine du modèle, ou coin (x mini, bas). */
export type From = "centre" | "origine" | "coin";
/**
 * Surface d'appui, dans le repère du modèle au repos : boîte des pièces qui la portent. `y` = dessus, `y0` = dessous,
 * `z` = face avant (+z).
 */
export type Surface = { face: Face; from: From; y: number; y0: number; x0: number; x1: number; z0: number; z1: number; z: number };

type Measure = { bounds: Box3 | null; parts: (Box3 | null)[] };
const cache = new WeakMap<Model, Measure>();

function measure(model: Model): Measure {
  const hit = cache.get(model);
  if (hit) return hit;
  const n = model.parts.length;
  const offs = new Float32Array(n * STRIDE);
  for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
  const world = new Float32Array(n * 16);
  const root: M4 = m4();
  forward(model, offs, root, world, m4());
  const parts: (Box3 | null)[] = [];
  let bounds: Box3 | null = null;
  for (let i = 0; i < n; i++) {
    const p = model.parts[i];
    const g = p.hidden ? null : geometryOf(p, 0);
    if (!g) {
      parts.push(null);
      continue;
    }
    const w = world.subarray(i * 16, i * 16 + 16);
    const b: Box3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let k = 0; k < g.pos.length; k += 3) {
      const x = g.pos[k], y = g.pos[k + 1], z = g.pos[k + 2];
      const wx = w[0] * x + w[4] * y + w[8] * z + w[12];
      const wy = w[1] * x + w[5] * y + w[9] * z + w[13];
      const wz = w[2] * x + w[6] * y + w[10] * z + w[14];
      if (wx < b.min[0]) b.min[0] = wx;
      if (wy < b.min[1]) b.min[1] = wy;
      if (wz < b.min[2]) b.min[2] = wz;
      if (wx > b.max[0]) b.max[0] = wx;
      if (wy > b.max[1]) b.max[1] = wy;
      if (wz > b.max[2]) b.max[2] = wz;
    }
    parts.push(b);
    if (!bounds) bounds = { min: [...b.min], max: [...b.max] };
    else
      for (let a = 0; a < 3; a++) {
        bounds.min[a] = Math.min(bounds.min[a], b.min[a]);
        bounds.max[a] = Math.max(bounds.max[a], b.max[a]);
      }
  }
  const m: Measure = { bounds, parts };
  cache.set(model, m);
  return m;
}

/** Boîte englobante du modèle au repos (repère du modèle) ; `null` sans pièce dessinée (modèle `gen`, articulations). */
export function boundsOf(model: Model): Box3 | null {
  return measure(model).bounds;
}

/** Emprise par défaut d'un modèle sans maillage mesurable (modèle `gen` : origine aux pieds). */
export const DEFAULT_BOUNDS: Box3 = { min: [-0.25, 0, -0.25], max: [0.25, 1, 0.25] };

/**
 * Surface d'appui d'un modèle : pièce marquée `surface: "<nom>"`, sinon pièce de ce nom, sinon (`top`) le dessus de
 * tout le modèle. Plusieurs pièces du même nom de surface (miroir, répétition) sont réunies.
 */
export function surfaceOf(model: Model, name: string): Surface | null {
  const m = measure(model);
  let box: Box3 | null = null;
  const add = (b: Box3 | null) => {
    if (!b) return;
    if (!box) box = { min: [...b.min], max: [...b.max] };
    else
      for (let a = 0; a < 3; a++) {
        box.min[a] = Math.min(box.min[a], b.min[a]);
        box.max[a] = Math.max(box.max[a], b.max[a]);
      }
  };
  let face: Face = "top", from: From = "centre";
  model.parts.forEach((p, i) => {
    if (p.surface !== name || !m.parts[i]) return;
    add(m.parts[i]);
    face = p.face;
    from = p.from;
  });
  if (!box) model.parts.forEach((p, i) => p.name === name && add(m.parts[i]));
  if (!box && name === "top") add(m.bounds);
  const b = box as Box3 | null;
  return b ? { face, from, y: b.max[1], y0: b.min[1], x0: b.min[0], x1: b.max[0], z0: b.min[2], z1: b.max[2], z: b.max[2] } : null;
}

/**
 * Position d'un objet posé sur une surface, dans le repère du modèle d'appui (unités de ce modèle).
 * `b`, `sc` : emprise et échelle de l'objet ; `k` : échelle (uniforme) de l'appui ; `at` : deux nombres (dessus et
 * dessous : x, z ; face verticale : distance le long de la face, hauteur de la base) ; `level` : rang dans une pile.
 * `u`, `v`, `r` : centre et rayon de l'emprise sur la surface (pour éviter les chevauchements).
 */
export function localOn(s: Surface, b: Box3, sc: readonly number[], k: number, at: readonly number[], level = 0) {
  const hx = (Math.max(Math.abs(b.min[0]), Math.abs(b.max[0])) * Math.abs(sc[0])) / k;
  const hz = (Math.max(Math.abs(b.min[2]), Math.abs(b.max[2])) * Math.abs(sc[2])) / k;
  const h = ((b.max[1] - b.min[1]) * Math.abs(sc[1])) / k;
  const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
  let fits = true, clamped = false;
  const fit = (want: number, lo: number, hi: number, mid: number): number => {
    if (lo > hi + 1e-6) {
      fits = false;
      return mid;
    }
    const got = Math.max(lo, Math.min(hi, want));
    if (Math.abs(got - want) > 1e-6) clamped = true;
    return got;
  };
  if (s.face === "+z") {
    const ox = s.from === "coin" ? s.x0 : s.from === "centre" ? cx : 0;
    const oy = s.from === "coin" ? s.y0 : s.from === "centre" ? (s.y0 + s.y) / 2 : 0;
    const x = fit(ox + at[0], s.x0 + hx, s.x1 - hx, cx);
    // hauteur de la base de l'objet, gardé entre le bas et le haut de la face
    const base = fit(oy + at[1], s.y0, s.y - h, s.y0);
    const local: [number, number, number] = [x, base - (b.min[1] * sc[1]) / k, s.z - (b.min[2] * sc[2]) / k];
    return { local, u: x, v: base + h / 2, r: hx, fits, clamped };
  }
  const r = Math.max(hx, hz);
  const ox = s.from === "coin" ? s.x0 : s.from === "centre" ? cx : 0;
  const oz = s.from === "coin" ? s.z0 : s.from === "centre" ? cz : 0;
  const x = fit(ox + at[0], s.x0 + r, s.x1 - r, cx);
  const z = fit(oz + at[1], s.z0 + r, s.z1 - r, cz);
  const y = s.face === "-y" ? s.y0 - (b.max[1] * sc[1]) / k : s.y + (-b.min[1] * sc[1]) / k + level * h;
  const local: [number, number, number] = [x, y, z];
  return { local, u: x, v: z, r, fits, clamped };
}

/** Vrai si le point (x, z) est dans le polygone `pts` ([[x, z], …]). */
export function inPolygon(x: number, z: number, pts: readonly (readonly number[])[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Noms des surfaces adressables d'un modèle (pour les messages et la sortie). */
export function surfaceNames(model: Model): string[] {
  const out = new Set<string>(["top"]);
  for (const p of model.parts) if (p.surface) out.add(p.surface);
  return [...out];
}

/** Rotation autour de y (même convention que `m4Compose`) d'un point local (x, z). */
export function turnY(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}
