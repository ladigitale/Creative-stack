/**
 * Poids de skinning automatiques.
 *
 * 1. Départ : chaque sommet appartient à 100 % à l'os de la primitive qui le domine (segmentation exacte issue de la
 *    polygonisation) ;
 * 2. Diffusion **sur la topologie du maillage** (pas en distance euclidienne : les deux jambes, voisines dans l'espace,
 *    ne communiquent pas), chaque sommet n'acceptant que les poids de son os, de son parent et de ses enfants ;
 * 3. Les 4 plus forts sont gardés et normalisés.
 *
 * Le nombre de passes règle la largeur de la zone de pliure (≈ racine du nombre de passes × arête moyenne).
 */
import { adjacencyCSR } from "../geom/adjacency";
import type { Mesh } from "../geom/mesh";
import type { Skeleton } from "./skeleton";

export type WeightOptions = {
  /** Passes de diffusion (défaut 10). */
  passes?: number;
  /** Os dont la diffusion est plus étroite (articulations nettes) : nom → facteur de passes (0..1). */
  sharp?: Record<string, number>;
  /** Mélange forcé pour certains sommets : (indice de sommet) → poids à combiner (jupe, manteau). */
  override?: (v: number) => Record<string, number> | null;
  /** Côté d'un sommet (`l`, `r` ou `""` au centre) : un sommet d'un côté n'accepte pas les os `.l` / `.r` de l'autre. */
  side?: (v: number) => "l" | "r" | "";
};

export function computeWeights(mesh: Mesh, owner: ArrayLike<number>, skel: Skeleton, opts: WeightOptions = {}): void {
  const nV = mesh.vertexCount;
  const nB = skel.count;
  const passes = opts.passes ?? 10;
  // os autorisés par sommet : os dominant + parent + enfants (les os non déformants sont sautés)
  const deformParent = (i: number): number => {
    let p = skel.parentIdx[i];
    while (p >= 0 && !skel.bones[p].deform) p = skel.parentIdx[p];
    return p;
  };
  // voisinage à deux niveaux (aisselle : bras ↔ torse via la clavicule ; aine : cuisse ↔ bassin)
  const allowed: number[][] = [];
  const deformKids = (b: number) => skel.children[b].filter((c) => skel.bones[c].deform);
  for (let b = 0; b < nB; b++) {
    const s = new Set<number>([b]);
    const p = deformParent(b);
    if (p >= 0) {
      s.add(p);
      const gp = deformParent(p);
      if (gp >= 0) s.add(gp);
    }
    for (const c of deformKids(b)) {
      s.add(c);
      for (const g of deformKids(c)) s.add(g);
    }
    allowed.push([...s]);
  }
  const sideName = (b: number) => (skel.bones[b].name.endsWith(".l") ? "l" : skel.bones[b].name.endsWith(".r") ? "r" : "");
  const allowedFor = (v: number, o: number): number[] => {
    const sd = opts.side?.(v) ?? "";
    if (!sd) return allowed[o];
    return allowed[o].filter((b) => {
      const bs = sideName(b);
      return !bs || bs === sd;
    });
  };
  let W = new Float32Array(nV * nB);
  // os autorisés par sommet, calculés une fois (et non à chaque passe)
  const allowedV: number[][] = new Array(nV);
  const ownerV = new Int32Array(nV);
  for (let v = 0; v < nV; v++) {
    const o = owner[v];
    ownerV[v] = o >= 0 && o < nB ? o : 0;
    allowedV[v] = allowedFor(v, ownerV[v]);
    if (o >= 0 && o < nB) W[v * nB + o] = 1;
    else W[v * nB] = 1;
  }
  const { off, nbr } = adjacencyCSR(mesh);
  const passesFor = (b: number) => Math.round(passes * (opts.sharp?.[skel.bones[b].name] ?? 1));
  const passesB = Array.from({ length: nB }, (_, b) => passesFor(b));
  const maxPass = passes;
  // seules les entrées autorisées d'un sommet sont jamais écrites : pas besoin de remettre à zéro le reste
  let next = new Float32Array(nV * nB);
  for (let it = 0; it < maxPass; it++) {
    for (let v = 0; v < nV; v++) {
      const o = ownerV[v];
      const al = allowedV[v];
      const n0 = off[v], n1 = off[v + 1];
      const base = v * nB;
      if (it >= passesB[o] || n1 === n0) {
        for (const b of al) next[base + b] = W[base + b];
        continue;
      }
      let total = 0;
      const k = 1 / (n1 - n0 + 1);
      for (const b of al) {
        let s = W[base + b];
        for (let q = n0; q < n1; q++) s += W[nbr[q] * nB + b];
        const val = s * k;
        next[base + b] = val;
        total += val;
      }
      if (total > 0) {
        const it2 = 1 / total;
        for (const b of al) next[base + b] *= it2;
      } else next[base + o] = 1;
    }
    [W, next] = [next, W];
  }
  const skin: number[] = new Array(nV * 4).fill(0);
  const weight: number[] = new Array(nV * 4).fill(0);
  for (let v = 0; v < nV; v++) {
    let pairs: [number, number][] = [];
    const ov = opts.override?.(v);
    if (ov) {
      for (const [name, w] of Object.entries(ov)) if (skel.has(name) && w > 0) pairs.push([skel.index[name], w]);
    } else {
      for (const b of allowedV[v]) {
        const w = W[v * nB + b];
        if (w > 1e-4) pairs.push([b, w]);
      }
    }
    pairs.sort((a, b) => b[1] - a[1]);
    pairs = pairs.slice(0, 4);
    const t = pairs.reduce((s, p) => s + p[1], 0) || 1;
    pairs.forEach(([b, w], k) => {
      skin[v * 4 + k] = b;
      weight[v * 4 + k] = w / t;
    });
    if (!pairs.length) weight[v * 4] = 1;
  }
  mesh.skin = skin;
  mesh.weight = weight;
}

/** Os dominant d'un sommet après calcul des poids. */
export function dominantBone(mesh: Mesh, v: number): number {
  if (!mesh.skin || !mesh.weight) return 0;
  let best = 0, bw = -1;
  for (let k = 0; k < 4; k++)
    if (mesh.weight[v * 4 + k] > bw) {
      bw = mesh.weight[v * 4 + k];
      best = mesh.skin[v * 4 + k];
    }
  return best;
}
