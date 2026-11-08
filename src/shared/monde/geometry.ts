/**
 * Maillages des formes primitives du format « monde » (repère de la pièce, décalage `off` compris).
 * Tableaux plats sans dépendance : `sonic-3d` en fait des BufferGeometry, `sonic-2d` en tire des silhouettes.
 * Mis en cache par forme et finesse : dix joueurs identiques partagent les mêmes tableaux.
 */
import type { Part, Shape } from "./format";

/** `uv` en mètres (la texture se répète au mètre, voir textures.ts). */
export type Geo = { pos: Float32Array; nrm: Float32Array; uv: Float32Array; idx: Uint32Array };

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, w = 0): number {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.pos.push(x, y, z);
    this.uv.push(u, w);
    this.nrm.push(nx / l, ny / l, nz / l);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  done(off: [number, number, number]): Geo {
    const pos = new Float32Array(this.pos);
    if (off[0] || off[1] || off[2]) for (let i = 0; i < pos.length; i += 3) {
      pos[i] += off[0];
      pos[i + 1] += off[1];
      pos[i + 2] += off[2];
    }
    return { pos, nrm: new Float32Array(this.nrm), uv: new Float32Array(this.uv), idx: new Uint32Array(this.idx) };
  }
}

const SEG = [8, 14, 24];

/** Surface de révolution autour de y : profil [rayon, y] du bas vers le haut, normales lissées. */
function revolve(b: Builder, prof: [number, number][], seg: number, arc = Math.PI * 2, capBottom = false, capTop = false) {
  const n = prof.length;
  const closed = arc >= Math.PI * 2 - 1e-6;
  const cols = closed ? seg : seg + 1;
  const base = b.pos.length / 3;
  const rMax = Math.max(...prof.map((q) => q[0]));
  let arcLen = 0;
  for (let i = 0; i < n; i++) {
    const [r, y] = prof[i];
    if (i) arcLen += Math.hypot(r - prof[i - 1][0], y - prof[i - 1][1]);
    // normale du profil : perpendiculaire à la tangente (lissée sur les voisins)
    const a = prof[Math.max(0, i - 1)], c = prof[Math.min(n - 1, i + 1)];
    const tr = c[0] - a[0], ty = c[1] - a[1];
    const nr = ty, ny = -tr;
    for (let j = 0; j < cols; j++) {
      const t = (j / seg) * arc;
      const cs = Math.cos(t), sn = Math.sin(t);
      b.v(r * cs, y, r * sn, nr * cs, ny, nr * sn, t * rMax, arcLen);
    }
  }
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < seg; j++) {
      const j1 = closed ? (j + 1) % cols : j + 1;
      const a = base + i * cols + j, bb = base + i * cols + j1, c = base + (i + 1) * cols + j1, d = base + (i + 1) * cols + j;
      b.quad(a, d, c, bb);
    }
  const cap = (k: number, up: boolean) => {
    const [r, y] = prof[k];
    if (r < 1e-6) return;
    const ctr = b.v(0, y, 0, 0, up ? 1 : -1, 0);
    const ring: number[] = [];
    for (let j = 0; j < cols; j++) {
      const t = (j / seg) * arc;
      ring.push(b.v(r * Math.cos(t), y, r * Math.sin(t), 0, up ? 1 : -1, 0, r * Math.cos(t), r * Math.sin(t)));
    }
    for (let j = 0; j < seg; j++) {
      const j1 = closed ? (j + 1) % cols : j + 1;
      if (up) b.tri(ctr, ring[j1], ring[j]);
      else b.tri(ctr, ring[j], ring[j1]);
    }
  };
  if (capBottom) cap(0, false);
  if (capTop) cap(n - 1, true);
}

function sphere(b: Builder, rx: number, ry: number, rz: number, seg: number) {
  const rings = Math.max(4, Math.round(seg * 0.6));
  const base = b.pos.length / 3;
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    const sp = Math.sin(phi), cp = -Math.cos(phi);
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg) * Math.PI * 2;
      const x = sp * Math.cos(t), z = sp * Math.sin(t);
      b.v(x * rx, cp * ry, z * rz, x / rx, cp / ry, z / rz, t * Math.max(rx, rz), phi * ry);
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = base + i * (seg + 1) + j;
      const c = a + seg + 1;
      b.quad(a, c, c + 1, a + 1);
    }
}

function box(b: Builder, w: number, h: number, d: number, round: number, seg: number) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const r = Math.min(round, hx, hy, hz);
  const n = r > 0 ? Math.max(2, Math.round(seg / 3)) : 1;
  const ix = hx - r, iy = hy - r, iz = hz - r;
  // six faces subdivisées, sommets « gonflés » vers les arêtes arrondies
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [nn, u, v] of faces) {
    const base = b.pos.length / 3;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++) {
        const s = (i / n) * 2 - 1, t = (j / n) * 2 - 1;
        const tu = s * Math.abs(u[0] * hx + u[1] * hy + u[2] * hz), tv = t * Math.abs(v[0] * hx + v[1] * hy + v[2] * hz);
        const px = (nn[0] + u[0] * s + v[0] * t) * hx;
        const py = (nn[1] + u[1] * s + v[1] * t) * hy;
        const pz = (nn[2] + u[2] * s + v[2] * t) * hz;
        if (r > 0) {
          const cx = Math.max(-ix, Math.min(ix, px)), cy = Math.max(-iy, Math.min(iy, py)), cz = Math.max(-iz, Math.min(iz, pz));
          let dx = px - cx, dy = py - cy, dz = pz - cz;
          const l = Math.hypot(dx, dy, dz) || 1;
          dx /= l;
          dy /= l;
          dz /= l;
          b.v(cx + dx * r, cy + dy * r, cz + dz * r, dx, dy, dz, tu, tv);
        } else b.v(px, py, pz, nn[0], nn[1], nn[2], tu, tv);
      }
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const a = base + i * (n + 1) + j;
        b.quad(a, a + n + 1, a + n + 2, a + 1);
      }
  }
}

function capsule(b: Builder, r: number, len: number, seg: number) {
  const k = Math.max(3, Math.round(seg / 3));
  const prof: [number, number][] = [];
  for (let i = 0; i <= k; i++) {
    const a = -Math.PI / 2 + (i / k) * (Math.PI / 2);
    prof.push([Math.cos(a) * r, -len / 2 + Math.sin(a) * r]);
  }
  for (let i = 0; i <= k; i++) {
    const a = (i / k) * (Math.PI / 2);
    prof.push([Math.cos(a) * r, len / 2 + Math.sin(a) * r]);
  }
  prof[0][0] = 0;
  prof[prof.length - 1][0] = 0;
  revolve(b, prof, seg);
}

function torus(b: Builder, R: number, r: number, arcDeg: number, seg: number) {
  const arc = (arcDeg * Math.PI) / 180;
  const n = Math.max(6, Math.round(seg * 1.5));
  const m = Math.max(5, Math.round(seg * 0.6));
  const base = b.pos.length / 3;
  const closed = arcDeg >= 360;
  const cols = closed ? n : n + 1;
  for (let i = 0; i < cols; i++) {
    const t = (i / n) * arc;
    const ct = Math.cos(t), st = Math.sin(t);
    for (let j = 0; j <= m; j++) {
      const p = (j / m) * Math.PI * 2;
      const cp = Math.cos(p), sp = Math.sin(p);
      b.v((R + r * cp) * ct, r * sp, (R + r * cp) * st, cp * ct, sp, cp * st, t * R, p * r);
    }
  }
  for (let i = 0; i < n; i++) {
    const i1 = closed ? (i + 1) % cols : i + 1;
    for (let j = 0; j < m; j++) {
      const a = base + i * (m + 1) + j, c = base + i1 * (m + 1) + j;
      b.quad(a, a + 1, c + 1, c);
    }
  }
}

/** Triangulation d'un polygone simple (oreilles), sens quelconque. */
function earcut(poly: number[][]): number[] {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % n];
    area += x0 * y1 - x1 * y0;
  }
  const idx = [...Array(n).keys()];
  if (area < 0) idx.reverse();
  const out: number[] = [];
  const inside = (p: number[], a: number[], b: number[], c: number[]) => {
    const s = (u: number[], v: number[], w: number[]) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
    return s(a, b, p) >= 0 && s(b, c, p) >= 0 && s(c, a, p) >= 0;
  };
  let guard = n * n + 10;
  while (idx.length > 3 && guard-- > 0) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = poly[idx[(i - 1 + idx.length) % idx.length]], bb = poly[idx[i]], c = poly[idx[(i + 1) % idx.length]];
      if ((bb[0] - a[0]) * (c[1] - a[1]) - (bb[1] - a[1]) * (c[0] - a[0]) <= 0) continue;
      let ok = true;
      for (const j of idx) {
        const q = poly[j];
        if (q === a || q === bb || q === c) continue;
        if (inside(q, a, bb, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(idx[(i - 1 + idx.length) % idx.length], idx[i], idx[(i + 1) % idx.length]);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

function extrude(b: Builder, pts: number[][], depth: number) {
  const tris = earcut(pts);
  const h = depth / 2;
  for (const z of [h, -h]) {
    const base = b.pos.length / 3;
    for (const [x, y] of pts) b.v(x, y, z, 0, 0, z > 0 ? 1 : -1, x, y);
    for (let i = 0; i < tris.length; i += 3) {
      if (z > 0) b.tri(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
      else b.tri(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
    }
  }
  // flancs : orientation déduite de la triangulation (sens du polygone)
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    area += x0 * y1 - x1 * y0;
  }
  const sgn = area >= 0 ? 1 : -1;
  let run = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const nx = (y1 - y0) * sgn, ny = -(x1 - x0) * sgn;
    const el = Math.hypot(x1 - x0, y1 - y0);
    const a = b.v(x0, y0, h, nx, ny, 0, run, h), bb = b.v(x1, y1, h, nx, ny, 0, run + el, h), c = b.v(x1, y1, -h, nx, ny, 0, run + el, -h), d = b.v(x0, y0, -h, nx, ny, 0, run, -h);
    run += el;
    if (sgn > 0) b.quad(a, d, c, bb);
    else b.quad(a, bb, c, d);
  }
}

function tube(b: Builder, pts: number[][], r0: number, r1: number, seg: number) {
  const n = pts.length;
  const m = Math.max(5, Math.round(seg * 0.6));
  const base = b.pos.length / 3;
  let px = [1, 0, 0];
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (i) run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)];
    let t = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    t = t.map((v) => v / tl);
    // repère transporté : on retire de l'ancienne normale sa composante tangente
    const d = px[0] * t[0] + px[1] * t[1] + px[2] * t[2];
    let nn = [px[0] - t[0] * d, px[1] - t[1] * d, px[2] - t[2] * d];
    let nl = Math.hypot(nn[0], nn[1], nn[2]);
    if (nl < 1e-4) {
      nn = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const d2 = nn[0] * t[0] + nn[1] * t[1] + nn[2] * t[2];
      nn = [nn[0] - t[0] * d2, nn[1] - t[1] * d2, nn[2] - t[2] * d2];
      nl = Math.hypot(nn[0], nn[1], nn[2]);
    }
    nn = nn.map((v) => v / nl);
    px = nn;
    const bn = [t[1] * nn[2] - t[2] * nn[1], t[2] * nn[0] - t[0] * nn[2], t[0] * nn[1] - t[1] * nn[0]];
    const r = r0 + (r1 - r0) * (i / (n - 1));
    for (let j = 0; j <= m; j++) {
      const ang = (j / m) * Math.PI * 2;
      const cx = Math.cos(ang), sx = Math.sin(ang);
      const nx = nn[0] * cx + bn[0] * sx, ny = nn[1] * cx + bn[1] * sx, nz = nn[2] * cx + bn[2] * sx;
      b.v(pts[i][0] + nx * r, pts[i][1] + ny * r, pts[i][2] + nz * r, nx, ny, nz, run, ang * r);
    }
  }
  for (let i = 0; i < n - 1; i++)
    for (let j = 0; j < m; j++) {
      const a = base + i * (m + 1) + j, c = a + m + 1;
      b.quad(a, a + 1, c + 1, c);
    }
  // bouchons
  for (const [k, sgn] of [[0, -1], [n - 1, 1]] as const) {
    const ring = base + k * (m + 1);
    const p = pts[k];
    const q = pts[k === 0 ? 1 : n - 2];
    const dir = [(p[0] - q[0]) * 1, (p[1] - q[1]) * 1, (p[2] - q[2]) * 1];
    const ctr = b.v(p[0], p[1], p[2], dir[0], dir[1], dir[2]);
    for (let j = 0; j < m; j++) {
      if (sgn > 0) b.tri(ctr, ring + j, ring + j + 1);
      else b.tri(ctr, ring + j + 1, ring + j);
    }
  }
}

const cache = new Map<string, Geo>();

/** Maillage d'une forme (null si la pièce n'en a pas : articulation pure). */
export function geometryOf(part: Part, detail: number): Geo | null {
  const s = part.shape;
  if (!s) return null;
  const key = `${detail}|${s.kind}|${s.a.join(",")}|${JSON.stringify(s.pts)}|${part.off.join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const g = build(s, SEG[detail] ?? 14).done(part.off);
  if (cache.size > 512) cache.clear();
  cache.set(key, g);
  return g;
}

function build(s: Shape, seg: number): Builder {
  const b = new Builder();
  const a = s.a;
  switch (s.kind) {
    case "box":
      box(b, a[0], a[1], a[2], a[3], seg);
      break;
    case "sphere":
      sphere(b, a[0], a[1], a[2], seg);
      break;
    case "capsule":
      capsule(b, a[0], a[1], seg);
      break;
    case "cylinder":
      revolve(b, [[a[0], -a[1] / 2], [a[2], a[1] / 2]], seg, Math.PI * 2, true, true);
      // normales de flanc franches pour un cylindre (le lissage du profil à 2 points est déjà exact)
      break;
    case "torus":
      torus(b, a[0], a[1], a[2], seg);
      break;
    case "lathe":
      revolve(b, s.pts as [number, number][], seg, Math.PI * 2, true, true);
      break;
    case "extrude":
      extrude(b, s.pts, a[0]);
      break;
    case "tube":
      tube(b, s.pts, a[0], a[1], seg);
      break;
    case "plane": {
      const hx = a[0] / 2, hz = a[1] / 2;
      const i0 = b.v(-hx, 0, -hz, 0, 1, 0, -hx, -hz), i1 = b.v(hx, 0, -hz, 0, 1, 0, hx, -hz), i2 = b.v(hx, 0, hz, 0, 1, 0, hx, hz), i3 = b.v(-hx, 0, hz, 0, 1, 0, -hx, hz);
      b.quad(i0, i3, i2, i1);
      break;
    }
  }
  return b;
}
