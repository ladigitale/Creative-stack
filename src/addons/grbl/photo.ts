import { boxMean } from "../../shared/raster1bit";
import { num } from "./codec";

/**
 * Photo → traits pour le laser : hachures croisées, ondes, spirale, lignes de niveau, pointillisme. La
 * préparation de l'image (niveaux, contours, effets) se fait en amont par une source d'images (sonic-shader
 * et sa bibliothèque : niveaux, pile-effets, sobel…) ; les tramages balayés ligne à ligne sont ceux de
 * `shared/raster1bit`. Fonctions pures ; images en niveaux de gris `Float32Array` (0 noir, 255 blanc).
 */

/** Rendus tracés en traits (et non balayés ligne à ligne). */
export const LINE_STYLES = ["hatch", "waves", "spiral", "isolines", "stipple"] as const;
export type LineStyle = (typeof LINE_STYLES)[number];

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Traits ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** Trait à brûler : points en mm ; `s` = valeur S constante, ou une valeur par point (puissance variable). */
export type Burn = { pts: [number, number][]; s: number | number[] };

/** Image vue en mm : valeur 0..1 d'obscurité au point (x, y) mm, origine en bas à gauche. */
type Sampler = (x: number, y: number) => number;

function sampler(gray: Float32Array, w: number, h: number, widthMm: number, heightMm: number): Sampler {
  return (x, y) => {
    const px = Math.floor((x / widthMm) * w), py = Math.floor(((heightMm - y) / heightMm) * h);
    if (px < 0 || py < 0 || px >= w || py >= h) return 0;
    return 1 - gray[py * w + px] / 255;
  };
}

/** Hachures croisées : 4 couches de plus en plus sombres, chacune dans sa direction. */
function hatchBurns(dark: Sampler, W: number, H: number, spacing: number, s: number, step: number): Burn[] {
  const out: Burn[] = [];
  const layers: [number, number][] = [[45, 0.18], [-45, 0.4], [0, 0.62], [90, 0.82]];
  const diag = Math.hypot(W, H);
  for (const [deg, thr] of layers) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
    let flip = false;
    for (let off = -diag / 2; off <= diag / 2; off += spacing) {
      const cx = W / 2 + nx * off, cy = H / 2 + ny * off;
      const segs: [number, number][][] = [];
      let cur: [number, number][] | null = null;
      for (let t = -diag / 2; t <= diag / 2; t += step) {
        const x = cx + dx * t, y = cy + dy * t;
        const inside = x >= 0 && y >= 0 && x <= W && y <= H;
        if (inside && dark(x, y) >= thr) {
          if (!cur) segs.push((cur = [[x, y]]));
          else if (cur.length === 1) cur.push([x, y]);
          else cur[1] = [x, y];
        } else cur = null;
      }
      const kept = segs.filter((sg) => sg.length === 2);
      if (flip) kept.reverse().forEach((sg) => sg.reverse());
      for (const sg of kept) out.push({ pts: sg, s });
      if (kept.length) flip = !flip;
    }
  }
  return out;
}

/** Ondes : une ligne horizontale par rangée, dont l'amplitude suit l'obscurité. */
function waveBurns(dark: Sampler, W: number, H: number, spacing: number, s: number, step: number): Burn[] {
  const out: Burn[] = [];
  const amp = spacing * 0.46;
  const period = Math.max(spacing * 0.8, step * 4);
  let flip = false;
  for (let y = spacing / 2; y < H; y += spacing) {
    const pts: [number, number][] = [];
    let any = false;
    for (let x = 0; x <= W; x += step) {
      const d = dark(x, y);
      if (d > 0.04) any = true;
      pts.push([x, clamp(y + amp * d * Math.sin((2 * Math.PI * x) / period), 0, H)]);
    }
    if (!any) continue;
    out.push({ pts: flip ? pts.reverse() : pts, s });
    flip = !flip;
  }
  return out;
}

/** Spirale d'Archimède depuis le centre ; la puissance suit l'obscurité, les zones blanches sont sautées. */
function spiralBurns(dark: Sampler, W: number, H: number, spacing: number, s: number, step: number, minS: number): Burn[] {
  const cx = W / 2, cy = H / 2;
  const rMax = Math.hypot(W, H) / 2;
  const out: Burn[] = [];
  let pts: [number, number][] = [];
  let pw: number[] = [];
  const flush = () => {
    if (pts.length >= 2) out.push({ pts, s: pw });
    pts = [];
    pw = [];
  };
  let theta = 0;
  let total = 0;
  for (;;) {
    const r = (spacing * theta) / (2 * Math.PI);
    if (r > rMax || total > 400_000) break;
    const x = cx + r * Math.cos(theta), y = cy + r * Math.sin(theta);
    const inside = x >= 0 && y >= 0 && x <= W && y <= H;
    const d = inside ? dark(x, y) : 0;
    if (d < 0.03) flush();
    else {
      pts.push([x, y]);
      pw.push(Math.round(minS + (s - minS) * d));
      total++;
    }
    theta += step / Math.max(r, step);
  }
  flush();
  return out;
}

/** Lignes de niveau (carrés marchants) à `levels` paliers d'obscurité, segments recousus en traits. */
function isolineBurns(gray: Float32Array, w: number, h: number, W: number, H: number, levels: number, s: number): Burn[] {
  const g = boxMean(gray, w, h, 1);
  const out: Burn[] = [];
  const toMm = (x: number, y: number): [number, number] => [(x / (w - 1)) * W, H - (y / (h - 1)) * H];
  const n = clamp(Math.round(levels), 2, 16);
  for (let k = 1; k <= n; k++) {
    const iso = 255 * (1 - k / (n + 1));
    const segs: [[number, number], [number, number]][] = [];
    const interp = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): [number, number] => {
      const t = v1 === v0 ? 0.5 : (iso - v0) / (v1 - v0);
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    };
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const a = g[y * w + x], b = g[y * w + x + 1], c = g[(y + 1) * w + x + 1], d = g[(y + 1) * w + x];
        const idx = (a < iso ? 8 : 0) | (b < iso ? 4 : 0) | (c < iso ? 2 : 0) | (d < iso ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const top = () => interp(x, y, a, x + 1, y, b);
        const right = () => interp(x + 1, y, b, x + 1, y + 1, c);
        const bottom = () => interp(x, y + 1, d, x + 1, y + 1, c);
        const left = () => interp(x, y, a, x, y + 1, d);
        const add = (p: [number, number], q: [number, number]) => segs.push([p, q]);
        switch (idx) {
          case 1: case 14: add(left(), bottom()); break;
          case 2: case 13: add(bottom(), right()); break;
          case 3: case 12: add(left(), right()); break;
          case 4: case 11: add(top(), right()); break;
          case 6: case 9: add(top(), bottom()); break;
          case 7: case 8: add(left(), top()); break;
          case 5: add(left(), top()); add(bottom(), right()); break;
          case 10: add(top(), right()); add(left(), bottom()); break;
        }
      }
    }
    // Recoud les segments bout à bout (extrémités arrondies au millième de point).
    const k2 = (p: [number, number]) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
    const ends = new Map<string, number[]>();
    segs.forEach((sg, i) => {
      for (const p of sg) {
        const kk = k2(p);
        const list = ends.get(kk);
        if (list) list.push(i);
        else ends.set(kk, [i]);
      }
    });
    const used = new Uint8Array(segs.length);
    const nextFrom = (p: [number, number]): number => (ends.get(k2(p)) ?? []).find((j) => !used[j]) ?? -1;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const line: [number, number][] = [segs[i][0], segs[i][1]];
      for (let guard = 0; guard < 2; guard++) {
        for (;;) {
          const tail = line[line.length - 1];
          const j = nextFrom(tail);
          if (j < 0) break;
          used[j] = 1;
          line.push(k2(segs[j][0]) === k2(tail) ? segs[j][1] : segs[j][0]);
        }
        line.reverse();
      }
      if (line.length >= 3) out.push({ pts: line.map(([x, y]) => toMm(x, y)), s });
    }
  }
  return out;
}

/** Pointillisme : un point brûlé par cellule, d'autant plus probable que la zone est sombre. */
function stippleBurns(dark: Sampler, W: number, H: number, spacing: number, s: number, seed: number): Burn[] {
  const r = rng(seed);
  const out: Burn[] = [];
  const dot = Math.max(0.05, spacing * 0.15);
  let flip = false;
  for (let y = spacing / 2; y < H; y += spacing) {
    const row: Burn[] = [];
    for (let x = spacing / 2; x < W; x += spacing) {
      const jx = x + (r() - 0.5) * spacing * 0.8, jy = y + (r() - 0.5) * spacing * 0.8;
      if (r() < Math.pow(dark(jx, jy), 1.2)) row.push({ pts: [[jx, jy], [jx + dot, jy]], s });
    }
    if (flip) row.reverse();
    out.push(...row);
    flip = !flip;
  }
  return out;
}

export type PhotoTrace = {
  style: LineStyle;
  widthMm: number;
  heightMm: number;
  /** Écart entre traits (hachures, ondes, spirale, pointillisme), en mm. */
  spacing: number;
  /** Pas d'échantillonnage le long d'un trait, en mm. */
  step: number;
  /** S plein et S minimal (spirale). */
  s: number;
  minS: number;
  levels: number;
  seed: number;
};

/** Traits d'une photo préparée, en mm (origine en bas à gauche, avant décalage). */
export function photoBurns(gray: Float32Array, w: number, h: number, o: PhotoTrace): Burn[] {
  const dark = sampler(gray, w, h, o.widthMm, o.heightMm);
  const spacing = clamp(o.spacing, 0.1, 10);
  const step = clamp(o.step, 0.05, 2);
  switch (o.style) {
    case "hatch": return hatchBurns(dark, o.widthMm, o.heightMm, spacing, o.s, step);
    case "waves": return waveBurns(dark, o.widthMm, o.heightMm, spacing, o.s, step);
    case "spiral": return spiralBurns(dark, o.widthMm, o.heightMm, spacing, o.s, step, o.minS);
    case "isolines": return isolineBurns(gray, w, h, o.widthMm, o.heightMm, o.levels, o.s);
    case "stipple": return stippleBurns(dark, o.widthMm, o.heightMm, spacing, o.s, o.seed);
    default: return [];
  }
}

/** Traits → G-code (M4, mouvements absolus en mm). `null` au-delà de `maxLines`. */
export function burnsToGcode(burns: Burn[], o: { xMm: number; yMm: number; speed: number; returnHome: boolean; maxLines: number }): string[] | null {
  const out = ["G90", "G21", "M5", "M4S0"];
  const feed = `F${num(o.speed)}`;
  const X = (v: number) => num(v + o.xMm), Y = (v: number) => num(v + o.yMm);
  for (const b of burns) {
    if (b.pts.length < 2) continue;
    out.push(`G0X${X(b.pts[0][0])}Y${Y(b.pts[0][1])}`);
    let lastS = -1;
    for (let i = 1; i < b.pts.length; i++) {
      const sv = Array.isArray(b.s) ? b.s[i] : b.s;
      const p = b.pts[i];
      out.push(`G1X${X(p[0])}Y${Y(p[1])}${sv !== lastS ? `S${num(sv)}` : ""}${i === 1 ? feed : ""}`);
      lastS = sv;
    }
    if (out.length > o.maxLines) return null;
  }
  if (out.length <= 4) return [];
  out.push("M5");
  if (o.returnHome) out.push("G0X0Y0");
  return out;
}
