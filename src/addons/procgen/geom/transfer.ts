/**
 * Recherche du sommet le plus proche (grille de hachage) et transfert de poids de skinning : une pièce rattachée à un
 * maillage (tête fine, cheveux longs, boutons, boucle) hérite des poids du point le plus proche de la peau, donc elle
 * plie exactement avec elle.
 */
import type { V3 } from "../core/math";
import type { Mesh } from "./mesh";

export class VertexIndex {
  private cells = new Map<number, number[]>();
  private h: number;
  constructor(private mesh: Mesh, cell: number, filter?: (v: number) => boolean) {
    this.h = cell;
    for (let v = 0; v < mesh.vertexCount; v++) {
      if (filter && !filter(v)) continue;
      const k = this.key(Math.floor(mesh.pos[v * 3] / cell), Math.floor(mesh.pos[v * 3 + 1] / cell), Math.floor(mesh.pos[v * 3 + 2] / cell));
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(v);
    }
  }
  private key(i: number, j: number, k: number) {
    return (i + 1024) * 4194304 + (j + 1024) * 2048 + (k + 1024);
  }
  /** Sommet le plus proche (recherche par anneaux croissants), -1 si rien dans `maxRings` anneaux. */
  nearest(p: V3, maxRings = 8): number {
    const h = this.h;
    const ci = Math.floor(p[0] / h), cj = Math.floor(p[1] / h), ck = Math.floor(p[2] / h);
    let best = -1, bd = Infinity;
    const m = this.mesh.pos;
    for (let r = 0; r <= maxRings; r++) {
      for (let i = ci - r; i <= ci + r; i++)
        for (let j = cj - r; j <= cj + r; j++)
          for (let k = ck - r; k <= ck + r; k++) {
            if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue;
            const list = this.cells.get(this.key(i, j, k));
            if (!list) continue;
            for (const v of list) {
              const dx = m[v * 3] - p[0], dy = m[v * 3 + 1] - p[1], dz = m[v * 3 + 2] - p[2];
              const d = dx * dx + dy * dy + dz * dz;
              if (d < bd) (bd = d), (best = v);
            }
          }
      // un candidat trouvé à l'anneau r est sûr dès que l'anneau suivant ne peut plus faire mieux
      if (best >= 0 && Math.sqrt(bd) <= r * h) break;
    }
    return best;
  }
}

/** Poids (os → poids) d'un sommet. */
export function weightsOf(m: Mesh, v: number): Map<number, number> {
  const out = new Map<number, number>();
  if (!m.skin || !m.weight) return out;
  for (let j = 0; j < 4; j++) if (m.weight[v * 4 + j] > 0) out.set(m.skin[v * 4 + j], (out.get(m.skin[v * 4 + j]) ?? 0) + m.weight[v * 4 + j]);
  return out;
}

/** Écrit 4 influences normalisées (les plus fortes) dans `skin` / `weight` à l'emplacement du sommet `v`. */
export function writeWeights(skin: number[], weight: number[], v: number, w: Map<number, number>) {
  const pairs = [...w].filter((x) => x[1] > 1e-5).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const t = pairs.reduce((s, x) => s + x[1], 0) || 1;
  for (let j = 0; j < 4; j++) {
    skin[v * 4 + j] = pairs[j]?.[0] ?? 0;
    weight[v * 4 + j] = pairs[j] ? pairs[j][1] / t : j === 0 && !pairs.length ? 1 : 0;
  }
}

/** Mélange de deux jeux de poids : (1 − k) · a + k · b. */
export function mixWeights(a: Map<number, number>, b: Map<number, number>, k: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const [bone, w] of a) out.set(bone, (out.get(bone) ?? 0) + w * (1 - k));
  for (const [bone, w] of b) out.set(bone, (out.get(bone) ?? 0) + w * k);
  return out;
}
