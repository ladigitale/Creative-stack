/**
 * Version simplifiée d'un maillage pour la vue de loin : regroupement des sommets sur une grille (vertex clustering).
 * Les sommets d'une même case et d'un même rôle fusionnent (position moyenne) : les limites de couleur restent nettes,
 * les triangles qui s'écrasent disparaissent. Rapide (linéaire), sans trous visibles à distance.
 */
import { Mesh } from "./mesh";

/** `cell` : côté de la case (m) ; une case par dixième de l'objet donne ~10 à 25 % des triangles. */
export function simplifyMesh(m: Mesh, cell: number): Mesh {
  const out = new Mesh();
  const n = m.vertexCount;
  if (!n || cell <= 0) return out;
  const inv = 1 / cell;
  const key = new Map<string, number>();
  const map = new Int32Array(n);
  const acc: number[] = [];
  const cnt: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2];
    const k = `${Math.floor(x * inv)},${Math.floor(y * inv)},${Math.floor(z * inv)},${m.role[i]},${m.flex[i] > 0 ? 1 : m.flex[i] < 0 ? 2 : 0}`;
    let v = key.get(k);
    if (v === undefined) {
      v = out.vertex([x, y, z], [m.nrm[i * 3], m.nrm[i * 3 + 1], m.nrm[i * 3 + 2]], m.role[i], m.ao[i], m.flex[i]);
      out.obj[v] = m.obj[i];
      key.set(k, v);
      acc.push(x, y, z, m.nrm[i * 3], m.nrm[i * 3 + 1], m.nrm[i * 3 + 2], m.ao[i]);
      cnt.push(1);
    } else {
      const a = v * 7;
      acc[a] += x;
      acc[a + 1] += y;
      acc[a + 2] += z;
      acc[a + 3] += m.nrm[i * 3];
      acc[a + 4] += m.nrm[i * 3 + 1];
      acc[a + 5] += m.nrm[i * 3 + 2];
      acc[a + 6] += m.ao[i];
      cnt[v]++;
    }
    map[i] = v;
  }
  for (let v = 0; v < out.vertexCount; v++) {
    const a = v * 7, c = cnt[v];
    out.pos[v * 3] = acc[a] / c;
    out.pos[v * 3 + 1] = acc[a + 1] / c;
    out.pos[v * 3 + 2] = acc[a + 2] / c;
    const nx = acc[a + 3], ny = acc[a + 4], nz = acc[a + 5], l = Math.hypot(nx, ny, nz);
    // normales opposées qui s'annulent (plaque fine) : on garde celle du premier sommet
    if (l > 1e-3 * c) ((out.nrm[v * 3] = nx / l), (out.nrm[v * 3 + 1] = ny / l), (out.nrm[v * 3 + 2] = nz / l));
    out.ao[v] = acc[a + 6] / c;
  }
  const seen = new Set<string>();
  for (let t = 0; t < m.idx.length; t += 3) {
    const a = map[m.idx[t]], b = map[m.idx[t + 1]], c = map[m.idx[t + 2]];
    if (a === b || b === c || a === c) continue;
    const k = a < b ? (b < c ? `${a},${b},${c}` : a < c ? `${a},${c},${b}` : `${c},${a},${b}`) : a < c ? `${b},${a},${c}` : b < c ? `${b},${c},${a}` : `${c},${b},${a}`;
    // même triangle dans les deux sens (deux faces d'une plaque) : gardé une fois par sens
    const ks = `${k}|${(b - a) * (c - a) > 0 ? 1 : 0}`;
    if (seen.has(ks)) continue;
    seen.add(ks);
    out.tri(a, b, c);
  }
  if (m.blend) out.blend = Array.from({ length: out.vertexCount }, () => 0);
  return out;
}
