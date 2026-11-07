/**
 * Découpe des triangles aux frontières de rôles de couleur.
 *
 * Le rendu lit le rôle d'un triangle sur un seul sommet (`flat`) : un triangle dont les sommets n'ont pas le même rôle
 * donne une frontière en escalier. On découpe donc chaque triangle mixte le long de la vraie frontière (iso-ligne où
 * les deux primitives concurrentes sont à égale distance, ou zéro d'une fonction de motif), en insérant des sommets
 * **dupliqués par rôle** (même position, normale, poids : aucune fissure au skinning) ; chaque triangle obtenu n'a plus
 * qu'un rôle et la frontière suit une ligne lisse.
 */
import { type V3, len, norm } from "../core/math";
import type { Mesh } from "./mesh";

export type CutSpec = {
  /** Étiquette de chaque sommet (deux étiquettes différentes = frontière). */
  label: ArrayLike<number>;
  /** Rôle de couleur d'une étiquette. */
  roleOf: (label: number) => number;
  /** Position de la frontière sur l'arête a → b (t ∈ ]0, 1[), étiquettes différentes aux deux bouts. */
  edgeT: (a: number, b: number) => number;
  /** Recalage d'un nouveau sommet (projection sur la surface) : position et normale, ou null pour garder l'interpolation. */
  place?: (p: V3, n: V3) => { p: V3; n: V3 } | null;
};

/**
 * Découpe en place ; rend l'étiquette de chaque sommet (anciens et nouveaux) et son **origine** : le sommet d'avant la
 * découpe dont il porte l'étiquette (pour retrouver sa primitive, son motif).
 */
export function splitByLabel(mesh: Mesh, spec: CutSpec, origin0?: number[]): { labels: number[]; origin: number[] } {
  const labels: number[] = Array.from(spec.label);
  const nV0 = mesh.vertexCount;
  const origin: number[] = origin0 ? origin0.slice() : Array.from({ length: nV0 }, (_, i) => i);
  for (let v = 0; v < nV0; v++) mesh.role[v] = spec.roleOf(labels[v]);
  const edgeBase = new Map<number, number>();
  const dup = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  /** Sommet de coupe de l'arête (a, b), dans la version de l'étiquette `lab`. */
  const cutVertex = (a: number, b: number, lab: number): number => {
    const k = key(a, b);
    let base = edgeBase.get(k);
    if (base === undefined) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      let t = spec.edgeT(lo, hi);
      if (!Number.isFinite(t)) t = 0.5;
      t = Math.min(0.98, Math.max(0.02, t));
      base = lerpVertex(mesh, lo, hi, t);
      placeVertex(mesh, base, spec.place);
      edgeBase.set(k, base);
      labels[base] = lab;
      origin[base] = origin[labels[a] === lab ? a : b];
      edgeSrc.set(base, [a, b]);
      mesh.role[base] = spec.roleOf(lab);
      dup.set(`${base}:${lab}`, base);
      return base;
    }
    return labelled(base, lab);
  };
  const edgeSrc = new Map<number, number[]>();
  const labelled = (base: number, lab: number): number => {
    const dk = `${base}:${lab}`;
    let v = dup.get(dk);
    if (v === undefined) {
      v = cloneVertex(mesh, base);
      const src = edgeSrc.get(base) ?? [base];
      origin[v] = origin[src.find((x) => labels[x] === lab) ?? src[0]];
      labels[v] = lab;
      mesh.role[v] = spec.roleOf(lab);
      dup.set(dk, v);
    }
    return v;
  };
  const idx = mesh.idx;
  const out: number[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const la = labels[a], lb = labels[b], lc = labels[c];
    if (la === lb && lb === lc) {
      out.push(a, b, c);
      continue;
    }
    if (la !== lb && lb !== lc && la !== lc) {
      // trois étiquettes : un quadrilatère par coin autour d'un point central
      const ab = [cutVertex(a, b, la), cutVertex(a, b, lb)];
      const bc = [cutVertex(b, c, lb), cutVertex(b, c, lc)];
      const ca = [cutVertex(c, a, lc), cutVertex(c, a, la)];
      const m = averageVertex(mesh, [ab[0], bc[0], ca[0]]);
      placeVertex(mesh, m, spec.place);
      labels[m] = la;
      origin[m] = origin[a];
      mesh.role[m] = spec.roleOf(la);
      const mb = cloneVertex(mesh, m), mc = cloneVertex(mesh, m);
      labels[mb] = lb;
      origin[mb] = origin[b];
      mesh.role[mb] = spec.roleOf(lb);
      labels[mc] = lc;
      origin[mc] = origin[c];
      mesh.role[mc] = spec.roleOf(lc);
      out.push(a, ab[0], m, a, m, ca[1]);
      out.push(b, bc[0], mb, b, mb, ab[1]);
      out.push(c, ca[0], mc, c, mc, bc[1]);
      continue;
    }
    // deux étiquettes : on tourne pour que le sommet isolé soit le premier (ordre cyclique conservé)
    let p = a, q = b, r = c;
    if (lb !== la && lb !== lc) (p = b), (q = c), (r = a);
    else if (lc !== la && lc !== lb) (p = c), (q = a), (r = b);
    const lp = labels[p], lq = labels[q];
    const pq1 = cutVertex(p, q, lp), pq2 = cutVertex(p, q, lq);
    const pr1 = cutVertex(p, r, lp), pr2 = cutVertex(r, p, lq);
    out.push(p, pq1, pr1);
    out.push(pq2, q, r, pq2, r, pr2);
  }
  mesh.idx = out;
  return { labels, origin };
}

/** Nouveau sommet interpolé entre a et b (toutes les données : poids, AO, morph, mélange). */
export function lerpVertex(m: Mesh, a: number, b: number, t: number): number {
  return mixVertex(m, [a, b], [1 - t, t]);
}

function averageVertex(m: Mesh, ids: number[]): number {
  return mixVertex(m, ids, ids.map(() => 1 / ids.length));
}

function mixVertex(m: Mesh, ids: number[], ws: number[]): number {
  const p: V3 = [0, 0, 0], n: V3 = [0, 0, 0];
  let ao = 0, flex = 0;
  ids.forEach((i, k) => {
    for (let c = 0; c < 3; c++) {
      p[c] += m.pos[i * 3 + c] * ws[k];
      n[c] += m.nrm[i * 3 + c] * ws[k];
    }
    ao += m.ao[i] * ws[k];
    flex += m.flex[i] * ws[k];
  });
  const v = m.vertex(p, len(n) > 1e-9 ? norm(n) : [0, 1, 0], m.role[ids[0]], ao, flex);
  m.obj[v] = m.obj[ids[0]];
  if (m.skin && m.weight) {
    const acc = new Map<number, number>();
    ids.forEach((i, k) => {
      for (let j = 0; j < 4; j++) {
        const w = m.weight![i * 4 + j] * ws[k];
        if (w > 0) acc.set(m.skin![i * 4 + j], (acc.get(m.skin![i * 4 + j]) ?? 0) + w);
      }
    });
    const pairs = [...acc].sort((x, y) => y[1] - x[1]).slice(0, 4);
    const tot = pairs.reduce((s, x) => s + x[1], 0) || 1;
    for (let j = 0; j < 4; j++) {
      m.skin.push(pairs[j]?.[0] ?? 0);
      m.weight.push(pairs[j] ? pairs[j][1] / tot : j === 0 && !pairs.length ? 1 : 0);
    }
  }
  if (m.morph) for (let c = 0; c < 3; c++) m.morph.push(ids.reduce((s, i, k) => s + m.morph![i * 3 + c] * ws[k], 0));
  if (m.blend) m.blend.push(ids.reduce((s, i, k) => s + m.blend![i] * ws[k], 0));
  return v;
}

function cloneVertex(m: Mesh, i: number): number {
  return mixVertex(m, [i], [1]);
}

function placeVertex(m: Mesh, v: number, place: CutSpec["place"]) {
  if (!place) return;
  const r = place(m.getPos(v), m.getNrm(v));
  if (!r) return;
  m.setPos(v, r.p);
  m.setNrm(v, r.n);
}

/** Zéro d'une fonction scalaire sur une arête par fausse position (deux itérations). */
export function edgeZero(f: (t: number) => number, fa: number, fb: number): number {
  let lo = 0, hi = 1, flo = fa, fhi = fb;
  if (flo === fhi) return 0.5;
  for (let it = 0; it < 2; it++) {
    const t = lo + ((hi - lo) * flo) / (flo - fhi);
    if (!(t > lo && t < hi)) break;
    const ft = f(t);
    if (ft === 0) return t;
    if (ft < 0 === flo < 0) (lo = t), (flo = ft);
    else (hi = t), (fhi = ft);
  }
  return lo + ((hi - lo) * flo) / (flo - fhi);
}
