/**
 * Sol, routes, eau et ciel vectoriels.
 *
 * Sol : **bandes de relief** — tranches du champ de hauteur à profondeur croissante, dessinées du fond vers l'avant ;
 * chaque bande a son profil, un filet de crête éclairé, un ton selon la pente et sa perspective atmosphérique.
 * Routes, trottoirs, chemins et places : quadrilatères du plan du sol projetés, rangés dans la bande qui les recouvre
 * (pas de chevauchement faux), bordures, marquage, pavés, cailloux. Eau : nappes par bande, reflets, écume de berge.
 * Ciel : soleil à halo ou lune et étoiles, cumulus festonnés à base plate, collines ou silhouette de ville au loin.
 */
import { Rng } from "../../core/rng";
import { clamp } from "../../core/math";
import type { SceneModel } from "../../scene/compose";
import type { PathSpec } from "../../scene/terrain";
import { resample } from "../../scene/terrain";
import type { Projector } from "../project";
import { type P2, Pen, type Shape, scallop } from "../shape";
import { faceTone } from "./kit";
import type { DrawEnv } from "./types";

export type Band = { z: number; key: number; index: number };

/** Profondeurs des bandes de sol (du fond vers l'avant) et leurs clés d'ordre. */
export function bandsOf(model: SceneModel, pr: Projector): Band[] {
  const D = model.size[1];
  const dz = clamp(D / 18, 1.1, 4);
  const out: Band[] = [];
  let i = 0;
  for (let z = -D / 2; z <= D / 2 + 1e-6; z += dz, i++) out.push({ z, key: pr.depth([0, 0, z]) - 1e-3, index: i });
  return out;
}

const SURF: Record<string, string> = { grass: "grass", sand: "path", snow: "snow", dirt: "ground", paved: "road", seabed: "ground" };

export function drawGround(model: SceneModel, env: DrawEnv, bands: Band[], seed: string) {
  const { pr, out } = env;
  const T = model.terrain;
  const W = model.size[0];
  const surf = SURF[T?.spec.surface ?? "grass"] ?? "grass";
  const H = env.ground;
  const ext = W * 0.8;
  const nx = 90;
  const xs: number[] = [];
  for (let i = 0; i <= nx; i++) xs.push(-W / 2 - ext + ((W + 2 * ext) * i) / nx);
  const rng = new Rng(`${seed}/vground`);
  const water = env.waterLevel;
  const layerOf = (z: number) => 2 + Math.round((1 - pr.far(z)) * 6);
  // quadrilatères de routes rangés par bande
  const quads = pathQuads(model, pr, bands, H);
  for (let k = 0; k < bands.length; k++) {
    const b = bands[k];
    const depth = pr.far(b.z);
    const layer = layerOf(b.z);
    const prof: P2[] = xs.map((x) => pr.p(x, H(x, b.z), b.z));
    // ton de la bande d'après la pente moyenne face à la lumière
    let acc = 0;
    if (T) for (let i = 0; i < 8; i++) acc += faceTone(T.normal(-W / 2 + (W * (i + 0.5)) / 8, b.z), env.L);
    const tone = Math.round(acc / 8) + (k % 2 ? 0 : 0);
    const bottom = Math.min(...prof.map((p) => p[1])) - 60;
    const pen = new Pen().M(prof[0][0], bottom);
    for (const p of prof) pen.L(p[0], p[1]);
    pen.L(prof[prof.length - 1][0], bottom).Z();
    const base: Shape = { d: pen.d, fill: surf, z: b.key, layer, objId: 0, depth };
    if (tone) base.tone = tone;
    out.push(base);
    // crête éclairée (filet) et texture de surface
    const rim = new Pen();
    rim.M(prof[0][0], prof[0][1]);
    for (const p of prof) rim.L(p[0], p[1]);
    for (let i = prof.length - 1; i >= 0; i--) rim.L(prof[i][0], prof[i][1] - 0.12);
    rim.Z();
    out.push({ d: rim.d, fill: surf, tone: tone + 1, z: b.key + 1e-6, layer, objId: 0, depth });
    // trait de crête (un sur deux, ton sombre de la surface) : lecture du relief sans effet de papier réglé
    if (k % 2 === 0 || Math.abs(prof[0][1] - prof[prof.length >> 1][1]) > 0.3) {
      const crest = new Pen();
      prof.forEach((p, i) => (i ? crest.L(p[0], p[1]) : crest.M(p[0], p[1])));
      out.push({ d: crest.d, fill: "none", stroke: surf, tone: tone - 1, width: 0.7, kind: "line", z: b.key + 1.5e-6, layer, objId: 0, depth, alpha: 0.8 });
    }
    const tex = new Pen();
    const nTex = surf === "grass" ? 34 : surf === "road" ? 0 : 18;
    const nextZ = bands[k + 1]?.z ?? b.z + 2;
    for (let i = 0; i < nTex; i++) {
      const x = rng.range(-W / 2, W / 2), z = b.z + rng.range(0.1, 0.9) * (nextZ - b.z);
      const [u, v] = pr.p(x, H(x, z), z);
      if (surf === "grass") tex.M(u - 0.08, v).L(u - 0.03, v + 0.12).M(u, v).L(u + 0.02, v + 0.16).M(u + 0.07, v).L(u + 0.1, v + 0.1);
      else tex.M(u - 0.1, v).L(u + 0.1, v);
    }
    if (!tex.empty) out.push({ d: tex.d, fill: "none", stroke: surf === "grass" ? "leaf2" : surf, width: 0.5, kind: "line", tone: surf === "grass" ? -1 : -1, z: b.key + 2e-6, layer, objId: 0, depth, alpha: 0.7 });
    // eau : nappe de la bande
    if (water !== null) {
      const segs: [number, number][] = [];
      let start = -1;
      xs.forEach((x, i) => {
        const under = H(x, b.z) < water;
        if (under && start < 0) start = i;
        if ((!under || i === xs.length - 1) && start >= 0) {
          segs.push([start, under ? i : i - 1]);
          start = -1;
        }
      });
      for (const [i0, i1] of segs) {
        const x0 = xs[Math.max(0, i0 - 1)], x1 = xs[Math.min(xs.length - 1, i1 + 1)];
        const wp = new Pen();
        const a = pr.p(x0, water, b.z), c = pr.p(x1, water, b.z);
        wp.M(a[0], a[1]).L(c[0], c[1]).L(c[0], bottom).L(a[0], bottom).Z();
        out.push({ d: wp.d, fill: "water", z: b.key + 3e-6, layer, objId: 0, depth });
        // reflets : traits clairs horizontaux, écume aux berges
        const rp = new Pen();
        const nz = nextZ;
        for (let r = 0; r < Math.max(2, (x1 - x0) / 3); r++) {
          const x = rng.range(x0, x1), z = b.z + rng.range(0.2, 0.9) * (nz - b.z);
          const [u, v] = pr.p(x, water, z);
          const l = rng.range(0.4, 1.6);
          rp.M(u - l, v).Q(u, v + 0.05, u + l, v);
        }
        out.push({ d: rp.d, fill: "none", stroke: "water", tone: 2, width: 0.8, kind: "line", z: b.key + 4e-6, layer, objId: 0, depth, alpha: 0.8 });
        if (i0 > 0 || i1 < xs.length - 1) {
          const fp = new Pen();
          for (const xe of [i0 > 0 ? xs[i0] : null, i1 < xs.length - 1 ? xs[i1] : null]) {
            if (xe === null) continue;
            const [u, v] = pr.p(xe, water, b.z);
            fp.M(u - 0.8, v - 0.02).Q(u, v + 0.08, u + 0.8, v - 0.02);
          }
          if (!fp.empty) out.push({ d: fp.d, fill: "none", stroke: "paper", width: 1, kind: "line", z: b.key + 5e-6, layer, objId: 0, depth, alpha: 0.75 });
        }
      }
    }
    // routes de cette bande
    for (const q of quads.get(k) ?? []) out.push({ ...q, z: b.key + 6e-6 + (q.z ?? 0), layer, depth });
  }
}

type QuadShape = Omit<Shape, "layer" | "depth">;

/** Quadrilatères de voirie (chaussée, trottoirs, bordures, marquage, cailloux) rangés par bande. */
function pathQuads(model: SceneModel, pr: Projector, bands: Band[], H: (x: number, z: number) => number): Map<number, QuadShape[]> {
  const res = new Map<number, Map<string, { pen: Pen; fill: string; tone: number; order: number; line?: boolean; width?: number; alpha?: number }>>();
  const bandFor = (zNear: number) => {
    let j = 0;
    for (let i = 0; i < bands.length; i++) if (bands[i].z < zNear) j = i;
    return j;
  };
  const get = (k: number, key: string, fill: string, tone: number, order: number, line = false, width?: number, alpha?: number) => {
    let m = res.get(k);
    if (!m) res.set(k, (m = new Map()));
    let e = m.get(key);
    if (!e) m.set(key, (e = { pen: new Pen(), fill, tone, order, line, width, alpha }));
    return e.pen;
  };
  const quad = (key: string, fill: string, tone: number, order: number, a: [number, number], b: [number, number], c: [number, number], d: [number, number], lift = 0.03) => {
    const zs = [a[1], b[1], c[1], d[1]];
    const k = bandFor(Math.max(...zs));
    const P = (q: [number, number]) => pr.p(q[0], H(q[0], q[1]) + lift, q[1]);
    get(k, key, fill, tone, order).poly([P(a), P(b), P(c), P(d)]);
  };
  const rng = new Rng("vpaths");
  for (const path of model.terrain?.paths ?? []) {
    const pts = resample(path.points, 0.9);
    if (pts.length < 2) continue;
    const off = (i: number, d: number): [number, number] => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      return [pts[i][0] - (dz / l) * d, pts[i][1] + (dx / l) * d];
    };
    const w2 = path.width / 2;
    const strips = stripsOf(path);
    for (let i = 0; i < pts.length - 1; i++) {
      for (const s of strips) {
        const wob = (j: number) => (s.wobble ? Math.sin(j * 1.7 + s.a * 3) * 0.12 + Math.sin(j * 0.53 + s.b) * 0.08 : 0);
        quad(s.key, s.fill, s.tone, s.order, off(i, s.a + wob(i)), off(i, s.b - wob(i + 7)), off(i + 1, s.b - wob(i + 8)), off(i + 1, s.a + wob(i + 1)), s.lift);
      }
      if (path.kind === "street" && i % 3 === 0) quad("dash", "paper", 0, 5, off(i, -0.07), off(i, 0.07), off(i + 1, 0.07), off(i + 1, -0.07), 0.04);
      if (path.kind === "path" && rng.chance(0.5)) {
        const t = rng.range(-w2 * 0.8, w2 * 0.8);
        const [x, z] = off(i, t);
        const [u, v] = pr.p(x, H(x, z) + 0.04, z);
        const k = bandFor(z);
        const r = rng.range(0.05, 0.14);
        get(k, "pebble", "stone", 0, 6).ellipse(u, v, r * 1.4, r * 0.7);
      }
      if (path.kind === "plaza" && i % 1 === 0) {
        const a = off(i, -w2), b = off(i, w2);
        const k = bandFor(Math.max(a[1], b[1]));
        const pa = pr.p(a[0], H(a[0], a[1]) + 0.04, a[1]), pb = pr.p(b[0], H(b[0], b[1]) + 0.04, b[1]);
        const e = get(k, "joint", "stone", -1, 7, true, 0.4);
        e.M(pa[0], pa[1]).L(pb[0], pb[1]);
      }
    }
  }
  const out = new Map<number, QuadShape[]>();
  for (const [k, m] of res) {
    const list = [...m.values()].sort((a, b) => a.order - b.order).map((e): QuadShape => (e.line ? { d: e.pen.d, fill: "none", stroke: e.fill, width: e.width ?? 0.5, kind: "line", tone: e.tone, z: e.order * 1e-7, objId: 0 } : { d: e.pen.d, fill: e.fill, tone: e.tone || undefined, z: e.order * 1e-7, objId: 0, ...(e.alpha ? { alpha: e.alpha } : {}) }));
    out.set(k, list);
  }
  return out;
}

function stripsOf(p: PathSpec): { key: string; fill: string; tone: number; order: number; a: number; b: number; lift: number; wobble?: boolean }[] {
  const w2 = p.width / 2;
  switch (p.kind) {
    case "street":
      return [
        { key: "walkL", fill: "trim", tone: 0, order: 1, a: w2, b: w2 + p.sidewalk + 0.05, lift: 0.12 },
        { key: "walkR", fill: "trim", tone: 0, order: 1, a: -w2 - p.sidewalk - 0.05, b: -w2, lift: 0.12 },
        { key: "road", fill: "road", tone: 0, order: 2, a: -w2 - 0.02, b: w2 + 0.02, lift: 0.02 },
        { key: "curbL", fill: "stone", tone: 1, order: 3, a: w2 - 0.02, b: w2 + 0.16, lift: 0.13 },
        { key: "curbR", fill: "stone", tone: -1, order: 3, a: -w2 - 0.16, b: -w2 + 0.02, lift: 0.13 },
        { key: "gutter", fill: "road", tone: -1, order: 4, a: -w2, b: -w2 + 0.3, lift: 0.025 },
      ];
    case "road":
      return [
        { key: "verge", fill: "path", tone: -1, order: 1, a: -w2 - 0.5, b: w2 + 0.5, lift: 0.02, wobble: true },
        { key: "road", fill: "road", tone: 0, order: 2, a: -w2, b: w2, lift: 0.03 },
        { key: "edge", fill: "paper", tone: 0, order: 3, a: w2 - 0.25, b: w2 - 0.15, lift: 0.035 },
      ];
    case "plaza":
      return [{ key: "plaza", fill: "stone", tone: 1, order: 1, a: -w2, b: w2, lift: 0.03 }];
    case "river":
      return [{ key: "river", fill: "water", tone: 0, order: 1, a: -w2, b: w2, lift: -0.3 }];
    default:
      return [
        { key: "pathEdge", fill: "path", tone: -1, order: 1, a: -w2 - 0.25, b: w2 + 0.25, lift: 0.02, wobble: true },
        { key: "path", fill: "path", tone: 0, order: 2, a: -w2 * 0.75, b: w2 * 0.75, lift: 0.03, wobble: true },
        { key: "rut", fill: "path", tone: 1, order: 3, a: -w2 * 0.15, b: w2 * 0.15, lift: 0.035, wobble: true },
      ];
  }
}

/** Éléments du ciel et du lointain (plans 0 et 1) : soleil ou lune, nuages, collines ou ville. */
export function drawSky(model: SceneModel, env: DrawEnv, seed: string, night: number) {
  const { pr, out } = env;
  const W = model.size[0], D = model.size[1];
  const rng = new Rng(`${seed}/vsky`);
  const zFar = -D / 2;
  const hor = pr.p(0, 0, zFar)[1];
  const span = W * 1.6;
  const f = Math.max(0.25, Math.min(2, W / 60));
  // astre
  const sx = -W * 0.3, sy = hor + W * 0.2;
  if (night > 0.5) {
    out.push({ d: new Pen().ellipse(sx, sy, 4 * f, 4 * f).d, fill: "sun", z: -1e6, layer: 0, objId: 0, alpha: 0.35, kind: "halo" });
    const r = 1.4 * f;
    out.push({ d: new Pen().M(sx, sy + r).C(sx - r * 1.35, sy + r, sx - r * 1.35, sy - r, sx, sy - r).C(sx - r * 0.65, sy - r * 0.6, sx - r * 0.65, sy + r * 0.6, sx, sy + r).Z().d, fill: "sun", tone: 1, z: -1e6 + 1, layer: 0, objId: 0, kind: "glow" });
    const st = new Pen();
    for (let i = 0; i < 70; i++) {
      const x = rng.range(-span / 2, span / 2), y = hor + rng.range(2, W * 0.45);
      const r = rng.range(0.04, 0.12) * f;
      st.M(x, y + r * 2).L(x + r * 0.5, y + r * 0.5).L(x + r * 2, y).L(x + r * 0.5, y - r * 0.5).L(x, y - r * 2).L(x - r * 0.5, y - r * 0.5).L(x - r * 2, y).L(x - r * 0.5, y + r * 0.5).Z();
    }
    out.push({ d: st.d, fill: "sun", z: -1e6 + 2, layer: 0, objId: 0, kind: "glow", alpha: 0.85 });
  } else {
    out.push({ d: new Pen().ellipse(sx, sy, 7 * f, 7 * f).d, fill: "sun", z: -1e6, layer: 0, objId: 0, alpha: 0.7, kind: "halo" });
    out.push({ d: new Pen().ellipse(sx, sy, 1.8 * f, 1.8 * f).d, fill: "sun", tone: 1, z: -1e6 + 1, layer: 0, objId: 0 });
  }
  // nuages : cumulus festonnés, base plate, deux tons
  const nC = night > 0.5 ? 3 : 5;
  for (let i = 0; i < nC; i++) {
    const cx = -span / 2 + ((i + rng.range(0.2, 0.8)) / nC) * span, cy = hor + rng.range(W * 0.08, W * 0.3);
    const w = rng.range(4, 9) * f;
    const back = new Pen(), front = new Pen();
    for (let k = 0; k < 4; k++) {
      const x = cx + (k - 1.5) * w * 0.32, r = w * rng.range(0.22, 0.32) * (k === 1 || k === 2 ? 1.25 : 1);
      scallop(back, x, cy + r * 0.25, r, r * 0.7, i * 9 + k, 7, r * 0.12, 0.8);
      scallop(front, x - w * 0.04, cy + r * 0.38, r * 0.82, r * 0.52, i * 9 + k + 4, 6, r * 0.1, 0.8);
    }
    out.push({ d: back.d, fill: "paper", tone: -1, z: -1e6 + 10 + i, layer: 0, objId: 0, depth: 0.6, alpha: night > 0.5 ? 0.35 : 0.95 });
    out.push({ d: front.d, fill: "paper", tone: 1, z: -1e6 + 10.5 + i, layer: 0, objId: 0, depth: 0.4, alpha: night > 0.5 ? 0.3 : 1 });
  }
  // lointain : deux plans de collines ou silhouette de ville
  if (!model.terrain) return;
  const city = model.terrain.spec.surface === "paved";
  for (const [li, dz, amp] of [[0, 10, 1], [1, 4, 0.6]] as const) {
    const z = zFar - dz;
    const pen = new Pen();
    const n = 60;
    const base = pr.p(0, 0, z)[1];
    const pts: P2[] = [];
    if (city) {
      let x = -span / 2 - 10;
      pts.push([x, base - 30]);
      while (x < span / 2 + 10) {
        const w = rng.range(2.5, 6) * f, h = (rng.range(3, 9) * amp + (li === 0 ? 2.5 : 0)) * f;
        pts.push([x, base + h], [x + w, base + h]);
        if (rng.chance(0.25)) pts.push([x + w * 0.4, base + h], [x + w * 0.45, base + h + 3], [x + w * 0.5, base + h]);
        x += w;
      }
      pts.push([x, base - 30]);
      pen.poly(pts);
    } else {
      pen.M(-span / 2 - 10, base - 30);
      for (let i = 0; i <= n; i++) {
        const x = -span / 2 - 10 + ((span + 20) * i) / n;
        const h = (Math.sin((x / f) * 0.045 * (li + 1) + rng.next() * 0.2 + li * 2) * 0.5 + 0.5) * (1 + W * 0.06) * amp + (Math.sin(x * 0.17 / f + li) * 1.2 + 1.5) * f;
        pen.L(x, base + h);
      }
      pen.L(span / 2 + 10, base - 30).Z();
    }
    out.push({ d: pen.d, fill: city ? "wall" : li === 0 ? "leaf" : "grass", tone: -1, z: -1e5 + li, layer: 1, objId: 0, depth: li === 0 ? 1 : 0.85 });
  }
}
