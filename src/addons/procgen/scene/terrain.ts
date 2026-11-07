/**
 * Sol : champ de hauteur (fBm à domaine déformé, crêtes), routes et chemins **creusés dans le champ** (le terrain
 * s'aplanit sous la chaussée avec une transition), eau à niveau fixe, usure du sol près des routes et des murs.
 */
import { type V3, clamp, cross, mix, norm, smoothstep, sub } from "../core/math";
import { Mesh } from "../geom/mesh";
import { ridge2, warped2 } from "../geom/noise";
import { ROLE } from "../style/roles";

export type PathKind = "street" | "road" | "path" | "river" | "plaza";
export type PathSpec = { id: string; points: [number, number][]; width: number; kind: PathKind; sidewalk: number };
export type GroundSpec = {
  size: [number, number];
  relief: number;
  /** Échelle des reliefs (m) : grande = collines douces. */
  scale: number;
  mountains: number;
  water: number | null;
  surface: "grass" | "sand" | "snow" | "dirt" | "paved" | "seabed";
  seed: number;
  /** Côte : le sol plonge sous l'eau vers ce bord (`south` = +z, vers la caméra par défaut). */
  coast?: "north" | "south" | "east" | "west" | null;
  /** Position du trait de côte (−1 … 1 sur l'axe du bord) et profondeur atteinte. */
  coastAt?: number;
  coastDepth?: number;
};

const SURF: Record<GroundSpec["surface"], number> = { grass: ROLE.grass, sand: ROLE.path, snow: ROLE.snow, dirt: ROLE.ground, paved: ROLE.road, seabed: ROLE.ground };

function segDist(px: number, pz: number, a: [number, number], b: [number, number]): { d: number; t: number } {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1e-9;
  const t = clamp(((px - a[0]) * dx + (pz - a[1]) * dz) / l2, 0, 1);
  return { d: Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t)), t };
}

export function distToPath(path: PathSpec, x: number, z: number): { d: number; seg: number; t: number } {
  let best = { d: Infinity, seg: 0, t: 0 };
  for (let i = 0; i < path.points.length - 1; i++) {
    const r = segDist(x, z, path.points[i], path.points[i + 1]);
    if (r.d < best.d) best = { d: r.d, seg: i, t: r.t };
  }
  if (path.points.length === 1) best = { d: Math.hypot(x - path.points[0][0], z - path.points[0][1]), seg: 0, t: 0 };
  return best;
}

export class Terrain {
  readonly spec: GroundSpec;
  readonly paths: PathSpec[];
  private pathH: number[][];
  readonly res: [number, number];
  private heights: Float32Array;

  constructor(spec: GroundSpec, paths: PathSpec[]) {
    this.spec = spec;
    this.paths = paths;
    // hauteur de chaque route : terrain brut lissé le long du tracé
    this.pathH = paths.map((p) => {
      const raw = p.points.map(([x, z]) => this.raw(x, z));
      const sm = raw.map((_, i) => (raw[Math.max(0, i - 1)] + raw[i] * 2 + raw[Math.min(raw.length - 1, i + 1)]) / 4);
      if (p.kind === "river") return sm.map((h) => (spec.water ?? Math.min(...raw)) - 0.9);
      return sm;
    });
    const [w, d] = spec.size;
    const step = clamp(Math.max(w, d) / 150, 0.4, 2);
    this.res = [Math.max(8, Math.round(w / step)), Math.max(8, Math.round(d / step))];
    this.heights = new Float32Array((this.res[0] + 1) * (this.res[1] + 1));
    for (let j = 0; j <= this.res[1]; j++)
      for (let i = 0; i <= this.res[0]; i++) {
        const x = (i / this.res[0] - 0.5) * w, z = (j / this.res[1] - 0.5) * d;
        this.heights[j * (this.res[0] + 1) + i] = this.compute(x, z);
      }
  }

  /** Relief brut (sans routes). */
  raw(x: number, z: number): number {
    const s = this.spec;
    if (s.relief <= 0 && s.mountains <= 0) return 0;
    const f = 1 / Math.max(4, s.scale);
    const o = s.seed * 13.7;
    let h = s.relief * warped2(x * f + o, z * f - o, 0.9, 4);
    if (s.coast) {
      const u = s.coast === "south" ? z / (s.size[1] / 2) : s.coast === "north" ? -z / (s.size[1] / 2) : s.coast === "east" ? x / (s.size[0] / 2) : -x / (s.size[0] / 2);
      const at = s.coastAt ?? 0.2;
      const wob = warped2(x * f * 2 + o, z * f * 2, 0.5, 3) * 0.12;
      h = h * (1 - smoothstep(at - 0.3, at + 0.2, u + wob) * 0.7) - (s.coastDepth ?? 3) * smoothstep(at - 0.15, at + 0.35, u + wob);
    }
    if (s.mountains > 0) {
      const edge = smoothstep(0.15, 0.5, Math.max(Math.abs(x) / s.size[0], Math.abs(z) / s.size[1]));
      h += s.mountains * ridge2(x * f * 0.6 + o, z * f * 0.6, 5) ** 1.6 * mix(0.25, 1, edge) * 2.2;
    }
    return h;
  }

  private compute(x: number, z: number): number {
    let h = this.raw(x, z);
    for (let k = 0; k < this.paths.length; k++) {
      const p = this.paths[k];
      const r = distToPath(p, x, z);
      const ph = p.points.length > 1 ? mix(this.pathH[k][r.seg], this.pathH[k][r.seg + 1], r.t) : this.pathH[k][0];
      const half = p.width / 2 + (p.kind === "street" ? p.sidewalk : 0);
      const blend = p.kind === "river" ? p.width * 0.6 : p.kind === "path" ? 1.5 : 3;
      const k2 = smoothstep(half, half + blend, r.d);
      if (p.kind === "river") {
        const bed = mix(ph, h, smoothstep(p.width * 0.2, p.width / 2 + blend, r.d));
        h = Math.min(h, bed);
      } else h = mix(ph, h, k2);
    }
    return h;
  }

  /** Hauteur interpolée du sol. */
  height(x: number, z: number): number {
    const [w, d] = this.spec.size;
    const fx = clamp((x / w + 0.5) * this.res[0], 0, this.res[0] - 1e-6);
    const fz = clamp((z / d + 0.5) * this.res[1], 0, this.res[1] - 1e-6);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const W = this.res[0] + 1;
    const h00 = this.heights[j * W + i], h10 = this.heights[j * W + i + 1], h01 = this.heights[(j + 1) * W + i], h11 = this.heights[(j + 1) * W + i + 1];
    return mix(mix(h00, h10, tx), mix(h01, h11, tx), tz);
  }

  normal(x: number, z: number): V3 {
    const e = 0.5;
    return norm([this.height(x - e, z) - this.height(x + e, z), 2 * e, this.height(x, z - e) - this.height(x, z + e)]);
  }

  /** Distance au bord de la route la plus proche (négative sur la chaussée) et type de route. */
  pathInfo(x: number, z: number): { d: number; path: PathSpec | null } {
    let best: { d: number; path: PathSpec | null } = { d: Infinity, path: null };
    for (const p of this.paths) {
      const r = distToPath(p, x, z);
      const e = r.d - p.width / 2;
      if (e < best.d) best = { d: e, path: p };
    }
    return best;
  }

  /** Maillage du sol : rôle de surface, mélange vers la terre battue (usure) par sommet. */
  mesh(): Mesh {
    const m = new Mesh();
    const [w, d] = this.spec.size;
    const [nx, nz] = this.res;
    const base = SURF[this.spec.surface];
    const blend: number[] = [];
    for (let j = 0; j <= nz; j++)
      for (let i = 0; i <= nx; i++) {
        const x = (i / nx - 0.5) * w, z = (j / nz - 0.5) * d;
        const y = this.heights[j * (nx + 1) + i];
        const n = this.normal(x, z);
        // pentes (roche) et berges (sable) : mélangées dans le shader, en continu
        const role = base;
        const pi = this.pathInfo(x, z);
        let wear = 0;
        if (pi.path && pi.path.kind !== "river") wear = 1 - smoothstep(-0.3, pi.path.kind === "path" ? 1.2 : 2.2, pi.d);
        if (pi.path && pi.path.kind === "path" && pi.d < 0) wear = 1;
        // bruit de bordure (chemin irrégulier)
        wear = clamp(wear + (warped2(x * 0.35, z * 0.35, 0.6, 3) * 0.35) * wear * (1 - wear) * 4, 0, 0.995);
        m.vertex([x, y, z], n, role, 1);
        blend.push(ROLE.path + wear);
      }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        m.quad(a, a + nx + 1, a + nx + 2, a + 1);
      }
    // socle : flancs descendus sous le relief (lecture « diorama » en vue iso, pas de bord flottant)
    const bottom = Math.min(...this.heights) - Math.max(1.5, Math.max(w, d) * 0.03);
    const edge = (idx: number[], out: [number, number]) => {
      const base0 = m.vertexCount;
      for (const k of idx) {
        const p = m.getPos(k);
        m.vertex(p, [out[0], 0, out[1]], ROLE.ground, 0.85);
        m.vertex([p[0], bottom, p[2]], [out[0], 0, out[1]], ROLE.ground, 0.55);
        blend.push(0, 0);
      }
      for (let k = 0; k < idx.length - 1; k++) {
        const a = base0 + k * 2;
        m.quad(a, a + 1, a + 3, a + 2);
      }
    };
    const W = nx + 1;
    edge(Array.from({ length: W }, (_, i) => i), [0, -1]);
    edge(Array.from({ length: W }, (_, i) => nz * W + i), [0, 1]);
    edge(Array.from({ length: nz + 1 }, (_, j) => j * W), [-1, 0]);
    edge(Array.from({ length: nz + 1 }, (_, j) => j * W + nx), [1, 0]);
    m.blend = blend;
    return m;
  }

  /** Chaussées, trottoirs et bordures (rues), revêtements (routes). */
  roadMeshes(): Mesh {
    const out = new Mesh();
    for (const p of this.paths) {
      if (p.kind === "path" || p.kind === "river" || p.points.length < 2) continue;
      const strip = (offA: number, offB: number, lift: number, role: number, sideWalls: boolean) => {
        const pts = resample(p.points, 1);
        const m = new Mesh();
        const n = pts.length;
        for (let k = 0; k < n; k++) {
          const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
          const t = norm([b[0] - a[0], 0, b[1] - a[1]]);
          const side = cross([0, 1, 0], t);
          const P = (o: number, up: number): V3 => {
            const x = pts[k][0] + side[0] * o, z = pts[k][1] + side[2] * o;
            return [x, this.height(x, z) + lift + up, z];
          };
          m.vertex(P(offA, 0), [0, 1, 0], role, 1);
          m.vertex(P(offB, 0), [0, 1, 0], role, 1);
          if (sideWalls) {
            m.vertex(P(offA, -lift - 0.03), [0, 0, 0], role, 0.6);
            m.vertex(P(offA, 0), [0, 0, 0], role, 1);
            m.vertex(P(offB, -lift - 0.03), [0, 0, 0], role, 0.6);
            m.vertex(P(offB, 0), [0, 0, 0], role, 1);
          }
        }
        const stride = sideWalls ? 6 : 2;
        for (let k = 0; k < n - 1; k++) {
          const a = k * stride, b = (k + 1) * stride;
          m.quad(a, a + 1, b + 1, b);
          if (sideWalls) {
            m.quad(a + 2, a + 3, b + 3, b + 2);
            m.quad(a + 4, b + 4, b + 5, a + 5);
          }
        }
        m.computeNormals();
        // les flancs gardent une normale latérale
        out.append(m);
      };
      const hw = p.width / 2;
      const roadRole = p.kind === "plaza" ? ROLE.stone : ROLE.road;
      strip(hw, -hw, 0.03, roadRole, false);
      if (p.kind === "street" || p.kind === "plaza") out.append(this.pavers(p));
      if (p.kind === "street" && p.sidewalk > 0) {
        strip(hw + p.sidewalk, hw, 0.16, ROLE.stone, true);
        strip(-hw, -hw - p.sidewalk, 0.16, ROLE.stone, true);
        strip(hw + 0.16, hw, 0.17, ROLE.trim, true);
        strip(-hw, -hw - 0.16, 0.17, ROLE.trim, true);
      }
    }
    return out;
  }

  /**
   * Pavage : rangs de pavés en quinconce (rue) ou dalles en damier décalé (place), légèrement bombés et irréguliers.
   * Chaque pierre = dessus + deux chants (6 triangles) : le joint se lit par l'ombre et le contour, pas par la texture.
   */
  pavers(p: PathSpec): Mesh {
    const m = new Mesh();
    const plaza = p.kind === "plaza";
    const hw = p.width / 2 - 0.05;
    const rowStep = plaza ? 1.1 : 0.5;
    const pts = resample(p.points, rowStep);
    let seed = 48271 + Math.round(Math.abs(p.points[0][0] * 131 + p.points[0][1] * 17));
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const t: [number, number] = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      const n: [number, number] = [-t[1], t[0]];
      // largeur d'une pierre ; décalage d'un demi-pavé un rang sur deux
      const pw = plaza ? 1.1 : 0.62;
      const off = k % 2 ? pw / 2 : 0;
      for (let o = -hw - off; o < hw; o += pw) {
        const o0 = Math.max(-hw, o + 0.03), o1 = Math.min(hw, o + pw - 0.03);
        if (o1 - o0 < 0.12) continue;
        const s0 = 0.03, s1 = Math.min(L, rowStep) - 0.03;
        const lift = 0.045 + rnd() * (plaza ? 0.02 : 0.025);
        const role = plaza ? (rnd() < 0.12 ? ROLE.road : ROLE.stone) : rnd() < 0.12 ? ROLE.stone : ROLE.road;
        const P = (u: number, v: number, up: number): V3 => {
          const x = a[0] + t[0] * u + n[0] * v, z = a[1] + t[1] * u + n[1] * v;
          return [x, this.height(x, z) + up, z];
        };
        const base = m.vertexCount;
        const c = [P(s0, o0, lift), P(s1, o0, lift), P(s1, o1, lift), P(s0, o1, lift)];
        for (const q of c) m.vertex(q, [0, 1, 0], role, 1);
        m.quad(base, base + 3, base + 2, base + 1);
        // chants avant et arrière (dans le sens de la marche)
        for (const [i0, i1, u] of [[0, 3, s0], [1, 2, s1]] as const) {
          const bb = m.vertexCount;
          const nn: V3 = u === s0 ? [-t[0], 0, -t[1]] : [t[0], 0, t[1]];
          m.vertex(c[i0], nn, role, 1);
          m.vertex(c[i1], nn, role, 1);
          m.vertex(P(u, i1 === 3 ? o1 : o1, 0.02), nn, role, 0.5);
          m.vertex(P(u, o0, 0.02), nn, role, 0.5);
          if (u === s0) m.quad(bb, bb + 3, bb + 2, bb + 1);
          else m.quad(bb, bb + 1, bb + 2, bb + 3);
        }
      }
    }
    return m;
  }

  /** Plan d'eau : profondeur (0..1) dans l'AO, utilisée par le shader (couleur, écume). */
  waterMesh(): Mesh | null {
    const wl = this.spec.water;
    if (wl === null) return null;
    const [w, d] = this.spec.size;
    const n = 60;
    const m = new Mesh();
    let any = false;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const x = (i / n - 0.5) * w, z = (j / n - 0.5) * d;
        const depth = wl - this.height(x, z);
        if (depth > 0) any = true;
        m.vertex([x, wl, z], [0, 1, 0], ROLE.water, clamp(depth / 2.5, 0, 1));
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        m.quad(a, a + n + 1, a + n + 2, a + 1);
      }
    // flancs du diorama côté eau
    const bottom = Math.min(...this.heights) - Math.max(1.5, Math.max(w, d) * 0.03);
    const side = (pts: [number, number][], nrm: V3) => {
      const b0 = m.vertexCount;
      for (const [x, z] of pts) {
        const top = Math.max(wl, this.height(x, z));
        m.vertex([x, top, z], nrm, ROLE.water, 0.9);
        m.vertex([x, bottom, z], nrm, ROLE.water, 1);
      }
      for (let k = 0; k < pts.length - 1; k++) m.quad(b0 + k * 2, b0 + k * 2 + 1, b0 + k * 2 + 3, b0 + k * 2 + 2);
    };
    const S = 80;
    const xs = Array.from({ length: S + 1 }, (_, i) => (i / S - 0.5) * w * 0.999);
    const zs = Array.from({ length: S + 1 }, (_, i) => (i / S - 0.5) * d * 0.999);
    side(xs.map((x) => [x, d / 2 * 0.999] as [number, number]), [0, 0, 1]);
    side(xs.map((x) => [x, -d / 2 * 0.999] as [number, number]), [0, 0, -1]);
    side(zs.map((z) => [w / 2 * 0.999, z] as [number, number]), [1, 0, 0]);
    side(zs.map((z) => [-w / 2 * 0.999, z] as [number, number]), [-1, 0, 0]);
    return any ? m : null;
  }
}

/** Rééchantillonne une polyligne à pas régulier. */
export function resample(points: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Point et direction à l'abscisse curviligne `s` d'une polyligne. */
export function pointAt(points: [number, number][], s: number): { p: [number, number]; dir: [number, number]; length: number } {
  let acc = 0;
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + L >= s || i === points.length - 2) {
      const t = L > 0 ? clamp((s - acc) / L, 0, 1) : 0;
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir: L > 0 ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [1, 0], length: total };
    }
    acc += L;
  }
  return { p: points[0], dir: [1, 0], length: total };
}
