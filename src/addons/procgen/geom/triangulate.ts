/**
 * Triangulation de polygones à trous (glyphes de police) : chaque trou est relié au contour extérieur par un pont
 * (double arête), puis le polygone simple obtenu est découpé en oreilles. Contours extérieurs dans le sens
 * trigonométrique, trous dans l'autre (`orientRings` les range ainsi).
 */
export type P2 = [number, number];

export const ringArea = (r: P2[]) => {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

function inside(p: P2, r: P2[]): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/**
 * Contours d'un glyphe → groupes {extérieur, trous}. La convention de la police (sens des extérieurs) se lit sur le
 * plus grand contour ; un trou va au plus petit extérieur qui le contient. Des extérieurs qui se chevauchent restent
 * séparés (ils se recouvrent au rendu, même couleur).
 */
export function orientRings(rings: P2[][]): { outer: P2[]; holes: P2[][] }[] {
  const rs = rings.filter((r) => r.length >= 3).map((r) => ({ r, a: ringArea(r) }));
  if (!rs.length) return [];
  const sgn = Math.sign(rs.reduce((m, x) => (Math.abs(x.a) > Math.abs(m.a) ? x : m)).a) || 1;
  const outers = rs.filter((x) => Math.sign(x.a) === sgn).map((x) => ({ outer: x.a > 0 ? x.r : x.r.slice().reverse(), holes: [] as P2[][], area: Math.abs(x.a) }));
  for (const x of rs) {
    if (Math.sign(x.a) === sgn) continue;
    const hole = x.a < 0 ? x.r : x.r.slice().reverse();
    let best: (typeof outers)[number] | null = null;
    for (const o of outers) if (inside(hole[0], o.outer) && (!best || o.area < best.area)) best = o;
    // trou orphelin (contour mal orienté) : rendu plein
    if (best) best.holes.push(hole);
    else outers.push({ outer: hole.slice().reverse(), holes: [], area: Math.abs(x.a) });
  }
  return outers.map(({ outer, holes }) => ({ outer, holes }));
}

type Node = { i: number; x: number; y: number; prev: Node; next: Node };

function ring(pts: P2[], base: number, list: P2[]): Node | null {
  let last: Node | null = null;
  for (let k = 0; k < pts.length; k++) {
    const n = { i: base + k, x: pts[k][0], y: pts[k][1] } as Node;
    list.push(pts[k]);
    if (!last) (n.prev = n), (n.next = n);
    else {
      n.next = last.next;
      n.prev = last;
      last.next.prev = n;
      last.next = n;
    }
    last = n;
  }
  return last;
}
const cross = (a: Node, b: Node, c: Node) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function inTri(a: Node, b: Node, c: Node, p: Node) {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}
/** Dans le triangle, quel que soit son sens. */
function inTriAny(a: Node, b: Node, c: Node, p: Node) {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

/** Relie un trou (liste chaînée) au contour : pont du point le plus à gauche du trou vers un sommet visible. */
function bridge(hole: Node, outer: Node) {
  let m = hole, p = hole.next;
  while (p !== hole) {
    if (p.x < m.x || (p.x === m.x && p.y < m.y)) m = p;
    p = p.next;
  }
  // rayon vers −x : arête du contour la plus proche
  let best: Node | null = null, bx = -Infinity;
  p = outer;
  do {
    const q = p.next;
    if ((p.y <= m.y && q.y >= m.y) || (q.y <= m.y && p.y >= m.y)) {
      if (q.y !== p.y) {
        const x = p.x + ((m.y - p.y) * (q.x - p.x)) / (q.y - p.y);
        if (x <= m.x && x > bx) {
          bx = x;
          best = p.x > q.x ? p : q;
        }
      }
    }
    p = q;
  } while (p !== outer);
  if (!best) {
    // repli : le sommet du contour le plus proche
    let d = Infinity;
    p = outer;
    do {
      const dd = (p.x - m.x) ** 2 + (p.y - m.y) ** 2;
      if (dd < d) (d = dd), (best = p);
      p = p.next;
    } while (p !== outer);
  } else {
    // un sommet réflexe dans le triangle (m, point d'impact, best) masquerait le pont : prendre le plus aligné
    const I = { x: bx, y: m.y } as Node;
    let ang = Infinity;
    const b0 = best;
    p = outer;
    do {
      if (p !== b0 && p.x <= m.x && p.x >= bx && cross(p.prev, p, p.next) < 0 && inTriAny(m, I, b0, p)) {
        const t = Math.abs(m.y - p.y) / Math.max(1e-12, m.x - p.x);
        if (t < ang) (ang = t), (best = p);
      }
      p = p.next;
    } while (p !== outer);
  }
  // découpe : best → m (trou) → … → m' → best'
  const b = best!;
  const m2 = { ...m } as Node, b2 = { ...b } as Node;
  const bn = b.next, mp = m.prev;
  b.next = m;
  m.prev = b;
  m2.next = b2;
  b2.prev = m2;
  mp.next = m2;
  m2.prev = mp;
  b2.next = bn;
  bn.prev = b2;
}

/**
 * Triangles (indices dans `pts` rendu) d'un contour extérieur et de ses trous : découpe en oreilles, vérifiée par
 * l'aire ; un contour dégénéré (trou qui touche le bord, comme dans les polices pixel) passe par la découpe en
 * tranches, exacte dans tous les cas mais plus chargée en triangles.
 */
export function triangulateWithHoles(outer: P2[], holes: P2[][] = []): { pts: P2[]; tris: number[] } {
  const r = earClip(outer, holes);
  const want = ringArea(outer) + holes.reduce((s, h) => s + ringArea(h), 0);
  let got = 0;
  for (let t = 0; t < r.tris.length; t += 3) {
    const a = r.pts[r.tris[t]], b = r.pts[r.tris[t + 1]], c = r.pts[r.tris[t + 2]];
    got += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return Math.abs(got - want) <= Math.abs(want) * 1e-6 + 1e-9 ? r : slabs([outer, ...holes]);
}

/**
 * Découpe en tranches horizontales (une tranche entre deux ordonnées de sommets) : dans chaque tranche, les arêtes
 * qui la traversent sont triées et appariées selon la règle d'enroulement non nul ; chaque intervalle plein devient
 * un trapèze (deux triangles).
 */
export function slabs(rings: P2[][]): { pts: P2[]; tris: number[] } {
  const edges: [P2, P2][] = [];
  const ys = new Set<number>();
  for (const r of rings)
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      ys.add(a[1]);
      if (a[1] !== b[1]) edges.push([a, b]);
    }
  const Y = [...ys].sort((a, b) => a - b);
  const pts: P2[] = [], tris: number[] = [];
  const xAt = (e: [P2, P2], y: number) => e[0][0] + ((e[1][0] - e[0][0]) * (y - e[0][1])) / (e[1][1] - e[0][1]);
  for (let k = 0; k + 1 < Y.length; k++) {
    const y0 = Y[k], y1 = Y[k + 1], ym = (y0 + y1) / 2;
    const cut = edges.filter((e) => Math.min(e[0][1], e[1][1]) < ym && Math.max(e[0][1], e[1][1]) > ym).map((e) => ({ x: xAt(e, ym), x0: xAt(e, y0), x1: xAt(e, y1), w: e[1][1] > e[0][1] ? 1 : -1 }));
    cut.sort((a, b) => a.x - b.x);
    let wind = 0;
    let start: (typeof cut)[number] | null = null;
    for (const c of cut) {
      const before = wind;
      wind += c.w;
      if (before === 0 && wind !== 0) start = c;
      else if (before !== 0 && wind === 0 && start) {
        const b = pts.length;
        pts.push([start.x0, y0], [c.x0, y0], [c.x1, y1], [start.x1, y1]);
        tris.push(b, b + 1, b + 2, b, b + 2, b + 3);
        start = null;
      }
    }
  }
  return { pts, tris };
}

function earClip(outer: P2[], holes: P2[][]): { pts: P2[]; tris: number[] } {
  const pts: P2[] = [];
  const o = ring(outer, 0, pts);
  if (!o) return { pts, tris: [] };
  const hs = holes.map((h) => ring(h, pts.length, pts)!).filter(Boolean);
  // trous de gauche à droite
  const left = (h: Node) => {
    let x = h.x, p = h.next;
    while (p !== h) (x = Math.min(x, p.x)), (p = p.next);
    return x;
  };
  hs.sort((a, b) => left(a) - left(b));
  for (const h of hs) bridge(h, o);
  const tris: number[] = [];
  let ear: Node = o;
  let count = 1;
  for (let p = o.next; p !== o; p = p.next) count++;
  const same = (p: Node, q: Node) => p.x === q.x && p.y === q.y;
  let stall = 0;
  while (count > 3) {
    const a = ear.prev, b = ear, c = ear.next;
    const cr = cross(a, b, c);
    // sommet aligné ou répété (côtés droits d'une police pixel, ponts vers les trous) : retiré sans triangle
    if (cr === 0 || same(a, b) || same(b, c)) {
      a.next = c;
      c.prev = a;
      count--;
      ear = a;
      stall = 0;
      continue;
    }
    let ok = cr > 0;
    if (ok)
      for (let p = c.next; p !== a; p = p.next) {
        if (same(p, a) || same(p, b) || same(p, c)) continue;
        if (inTri(a, b, c, p)) {
          ok = false;
          break;
        }
      }
    // aucun coin coupable sur un tour complet (contour abîmé) : coupe forcée, pour finir quand même
    if (ok || stall > count) {
      if (cr > 0) tris.push(a.i, b.i, c.i);
      a.next = c;
      c.prev = a;
      count--;
      ear = c;
      stall = 0;
    } else {
      ear = c;
      stall++;
    }
  }
  if (count === 3 && cross(ear.prev, ear, ear.next) > 0) tris.push(ear.prev.i, ear.i, ear.next.i);
  return { pts, tris };
}
