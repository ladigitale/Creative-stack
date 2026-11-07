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
  for (let v = 0; v < nV; v++) {
    const o = owner[v];
    if (o >= 0 && o < nB) W[v * nB + o] = 1;
    else W[v * nB] = 1;
  }
  const adj = mesh.adjacency();
  const passesFor = (b: number) => Math.round(passes * (opts.sharp?.[skel.bones[b].name] ?? 1));
  const maxPass = passes;
  let next = new Float32Array(nV * nB);
  for (let it = 0; it < maxPass; it++) {
    for (let v = 0; v < nV; v++) {
      const o = owner[v] >= 0 ? owner[v] : 0;
      const al = allowedFor(v, o);
      const nb = adj[v];
      const active = it < passesFor(o);
      for (let b = 0; b < nB; b++) next[v * nB + b] = 0;
      if (!active || !nb.length) {
        for (const b of al) next[v * nB + b] = W[v * nB + b];
        continue;
      }
      let total = 0;
      for (const b of al) {
        let s = W[v * nB + b];
        for (const u of nb) s += W[u * nB + b];
        const val = s / (nb.length + 1);
        next[v * nB + b] = val;
        total += val;
      }
      if (total > 0) for (const b of al) next[v * nB + b] /= total;
      else next[v * nB + o] = 1;
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
      for (let b = 0; b < nB; b++) {
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
