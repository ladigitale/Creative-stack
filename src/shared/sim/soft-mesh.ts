/**
 * Maillages des pièces souples et des chevelures, sans moteur de rendu : topologie (indices, uv) et écriture des
 * positions depuis la simulation. Communs à `sonic-3d` (format monde) et à `sonic-procgen`.
 *
 * - tissu : grille rangées × colonnes ; `taper` (0 à 1) resserre les colonnes vers le bout libre (fanion) ;
 * - jupe : tube fermé (anneaux) ;
 * - chaîne : tube de `RING` côtés autour de la ligne, effilé vers le bout libre ;
 * - chevelure : rubans (deux sommets par point de mèche), tournés face au centre de la tête.
 */
import type { HairSim } from "./hair";
import type { SoftSim } from "./soft";

export const RING = 6;

export type Topology = { verts: number; uv: number[]; idx: number[] };

export function softTopology(sim: SoftSim): Topology {
  const uv: number[] = [], idx: number[] = [];
  const { cols, rows } = sim;
  if (sim.spec.kind === "jupe") {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        uv.push(c / cols, 1 - r / (rows - 1));
        if (r + 1 < rows) {
          const a = r * cols + c, b = r * cols + ((c + 1) % cols);
          idx.push(a, a + cols, b, b, a + cols, b + cols);
        }
      }
    return { verts: sim.n, uv, idx };
  }
  if (sim.spec.kind === "tissu") {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        uv.push(c / (cols - 1), 1 - r / (rows - 1));
        if (r + 1 < rows && c + 1 < cols) {
          const a = r * cols + c;
          idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
        }
      }
    return { verts: sim.n, uv, idx };
  }
  const n = sim.n;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < RING; k++) {
      uv.push(k / RING, i / (n - 1));
      if (i + 1 < n) {
        const a = i * RING + k, b = i * RING + ((k + 1) % RING);
        idx.push(a, a + RING, b, b, a + RING, b + RING);
      }
    }
  return { verts: n * RING, uv, idx };
}

/** Positions du maillage d'une pièce souple (repère du monde de la simulation). */
export function writeSoftPositions(sim: SoftSim, out: Float32Array, taper = 0) {
  const p = sim.pos;
  if (sim.spec.kind !== "chaine") {
    if (!(taper > 0) || sim.spec.kind !== "tissu") {
      out.set(p);
      return;
    }
    // fanion : chaque rangée se resserre vers son milieu, jusqu'à une pointe au bout libre
    const { cols, rows } = sim;
    for (let r = 0; r < rows; r++) {
      const k = Math.min(1, taper) * (r / Math.max(1, rows - 1));
      const a = r * cols, b = r * cols + cols - 1;
      const mx = (p[a * 3] + p[b * 3]) / 2, my = (p[a * 3 + 1] + p[b * 3 + 1]) / 2, mz = (p[a * 3 + 2] + p[b * 3 + 2]) / 2;
      for (let c = 0; c < cols; c++) {
        const o = (r * cols + c) * 3;
        out[o] = p[o] + (mx - p[o]) * k;
        out[o + 1] = p[o + 1] + (my - p[o + 1]) * k;
        out[o + 2] = p[o + 2] + (mz - p[o + 2]) * k;
      }
    }
    return;
  }
  // tube : un anneau autour de chaque point, orienté selon la chaîne (repère transporté)
  const n = sim.n;
  let ux = 1, uy = 0, uz = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    let tx = p[b * 3] - p[a * 3], ty = p[b * 3 + 1] - p[a * 3 + 1], tz = p[b * 3 + 2] - p[a * 3 + 2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // u ⟂ t (Gram-Schmidt sur le précédent), w = t × u
    const d = ux * tx + uy * ty + uz * tz;
    ux -= d * tx;
    uy -= d * ty;
    uz -= d * tz;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-4) {
      ux = Math.abs(tx) < 0.9 ? 1 : 0;
      uy = Math.abs(tx) < 0.9 ? 0 : 1;
      uz = 0;
      const d2 = ux * tx + uy * ty;
      ux -= d2 * tx;
      uy -= d2 * ty;
      uz -= d2 * tz;
      ul = Math.hypot(ux, uy, uz) || 1;
    }
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const wx = ty * uz - tz * uy, wy = tz * ux - tx * uz, wz = tx * uy - ty * ux;
    // effilé vers le bout libre
    const r = sim.radius * (1 - 0.6 * (i / Math.max(1, n - 1)));
    for (let q = 0; q < RING; q++) {
      const ang = (q / RING) * Math.PI * 2, c = Math.cos(ang) * r, s = Math.sin(ang) * r;
      const o = (i * RING + q) * 3;
      out[o] = p[i * 3] + ux * c + wx * s;
      out[o + 1] = p[i * 3 + 1] + uy * c + wy * s;
      out[o + 2] = p[i * 3 + 2] + uz * c + wz * s;
    }
  }
}

export function hairTopology(sim: HairSim): Topology {
  const per = sim.per, n = sim.strands;
  const uv: number[] = [], idx: number[] = [];
  for (let s = 0; s < n; s++)
    for (let k = 0; k < per; k++) {
      uv.push(0, k / (per - 1), 1, k / (per - 1));
      if (k + 1 < per) {
        const a = (s * per + k) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  return { verts: n * per * 2, uv, idx };
}

/** Rubans d'une chevelure ; (hx, hy, hz) : centre de la tête dans le repère du monde (côté des rubans). */
export function writeHairPositions(sim: HairSim, hx: number, hy: number, hz: number, out: Float32Array) {
  const p = sim.pos, per = sim.per, w0 = sim.spec.width;
  for (let s = 0; s < sim.strands; s++)
    for (let k = 0; k < per; k++) {
      const i = s * per + k;
      const a = s * per + Math.max(0, k - 1), b = s * per + Math.min(per - 1, k + 1);
      const tx = p[b * 3] - p[a * 3], ty = p[b * 3 + 1] - p[a * 3 + 1], tz = p[b * 3 + 2] - p[a * 3 + 2];
      const rx = p[i * 3] - hx, ry = p[i * 3 + 1] - hy, rz = p[i * 3 + 2] - hz;
      let sx = ty * rz - tz * ry, sy = tz * rx - tx * rz, sz = tx * ry - ty * rx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const w = (w0 / 2) * (1 - 0.45 * (k / (per - 1)));
      const wav = sim.waveAt(s, k);
      sx = (sx / sl) * w;
      sy = (sy / sl) * w;
      sz = (sz / sl) * w;
      const o = i * 6;
      const cx = p[i * 3] + (sx / Math.max(w, 1e-6)) * wav, cy = p[i * 3 + 1] + (sy / Math.max(w, 1e-6)) * wav, cz = p[i * 3 + 2] + (sz / Math.max(w, 1e-6)) * wav;
      out[o] = cx - sx;
      out[o + 1] = cy - sy;
      out[o + 2] = cz - sz;
      out[o + 3] = cx + sx;
      out[o + 4] = cy + sy;
      out[o + 5] = cz + sz;
    }
}
