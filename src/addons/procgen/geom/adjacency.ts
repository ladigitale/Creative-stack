/**
 * Voisinage des sommets en tableaux compacts (CSR) : `nbr[off[v] .. off[v + 1]]` sont les voisins de `v`.
 * Bien plus léger que des ensembles par sommet (lissage, diffusion des poids sur des maillages de plusieurs milliers
 * de sommets).
 */
import type { Mesh } from "./mesh";

export type Adjacency = { off: Int32Array; nbr: Int32Array };

export function adjacencyCSR(mesh: Mesh): Adjacency {
  const n = mesh.vertexCount;
  const idx = mesh.idx;
  // chaque triangle donne 2 voisins à chacun de ses sommets (doublons retirés ensuite)
  const deg = new Int32Array(n + 1);
  for (let t = 0; t < idx.length; t++) deg[idx[t]] += 2;
  const start = new Int32Array(n + 1);
  for (let v = 0; v < n; v++) start[v + 1] = start[v] + deg[v];
  const raw = new Int32Array(start[n]);
  const fill = start.slice(0, n);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    raw[fill[a]++] = b;
    raw[fill[a]++] = c;
    raw[fill[b]++] = a;
    raw[fill[b]++] = c;
    raw[fill[c]++] = a;
    raw[fill[c]++] = b;
  }
  // dédoublonnage par sommet (listes courtes : tri par insertion)
  const off = new Int32Array(n + 1);
  const nbr = new Int32Array(start[n]);
  let w = 0;
  for (let v = 0; v < n; v++) {
    off[v] = w;
    const s = start[v], e = fill[v];
    for (let i = s + 1; i < e; i++) {
      const x = raw[i];
      let j = i - 1;
      while (j >= s && raw[j] > x) (raw[j + 1] = raw[j]), j--;
      raw[j + 1] = x;
    }
    for (let i = s; i < e; i++) if (i === s || raw[i] !== raw[i - 1]) nbr[w++] = raw[i];
  }
  off[n] = w;
  return { off, nbr: nbr.subarray(0, w) };
}
