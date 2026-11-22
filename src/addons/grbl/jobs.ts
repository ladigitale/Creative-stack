/**
 * Variantes d'un programme préparé (`prepareJob`) : essai à vide, reprise à une ligne, cadrage.
 * Fonctions pures, sans machine : `sonic-grbl` les applique avant l'envoi.
 */
import { num } from "./codec";

const WORD = /([A-Z])([+-]?(?:\d+\.?\d*|\.\d+))/g;
const MAX_FEED = 6000;

/**
 * Essai à vide : mêmes mouvements, faisceau toujours coupé (M3 / M4 → M5, mots S retirés).
 * `speed` multiplie les vitesses d'avance (1 à 4, plafonnées à 6000 mm/min) pour un essai plus court.
 */
export function dryRunLines(lines: string[], speed = 1): string[] {
  const k = Math.min(4, Math.max(1, Number(speed) || 1));
  const out: string[] = ["M5"];
  for (const line of lines) {
    let l = line.replace(/M0*[34](?!\d)/g, "M5").replace(/S[+-]?(?:\d+\.?\d*|\.\d+)/g, "");
    if (k !== 1) l = l.replace(/F([+-]?(?:\d+\.?\d*|\.\d+))/g, (_, v: string) => `F${num(Math.min(MAX_FEED, Number(v) * k))}`);
    l = l.trim();
    if (l) out.push(l);
  }
  return out;
}

/** État modal atteint juste avant la ligne `index` (0 = début). */
export type ModalState = { abs: boolean; inches: boolean; motion: number; feed: number; s: number; laser: "M3" | "M4" | "M5"; x: number; y: number };

export function modalAt(lines: string[], index: number): ModalState {
  const st: ModalState = { abs: true, inches: false, motion: 0, feed: 0, s: 0, laser: "M5", x: 0, y: 0 };
  const end = Math.max(0, Math.min(lines.length, Math.floor(index)));
  for (let i = 0; i < end; i++) {
    let nx: number | null = null, ny: number | null = null;
    WORD.lastIndex = 0;
    for (let m = WORD.exec(lines[i]); m; m = WORD.exec(lines[i])) {
      const v = Number(m[2]);
      switch (m[1]) {
        case "G":
          if (v >= 0 && v <= 3) st.motion = v;
          else if (v === 90) st.abs = true;
          else if (v === 91) st.abs = false;
          else if (v === 20) st.inches = true;
          else if (v === 21) st.inches = false;
          break;
        case "M":
          if (v === 3) st.laser = "M3";
          else if (v === 4) st.laser = "M4";
          else if (v === 5) st.laser = "M5";
          break;
        case "X": nx = v; break;
        case "Y": ny = v; break;
        case "F": st.feed = v; break;
        case "S": st.s = v; break;
      }
    }
    if (nx !== null) st.x = st.abs ? nx : st.x + nx;
    if (ny !== null) st.y = st.abs ? ny : st.y + ny;
  }
  return st;
}

export type ResumePlan = { lines: string[]; preamble: number; error: string | null };

/**
 * Reprise à la ligne `from` (index dans le programme préparé) : déplacement faisceau coupé jusqu'au point
 * atteint avant cette ligne, puis rétablissement de l'état modal (vitesse, puissance, M4, mode de mouvement)
 * et suite du programme. `preamble` = nombre de lignes ajoutées devant.
 */
export function resumeLines(lines: string[], from: number): ResumePlan {
  const start = Math.floor(Number(from));
  if (!Number.isFinite(start) || start <= 0) return { lines: lines.slice(), preamble: 0, error: null };
  if (start >= lines.length) return { lines: [], preamble: 0, error: `reprise impossible : ligne ${start} au-delà de la fin (${lines.length} lignes)` };
  const st = modalAt(lines, start);
  if (!st.abs) return { lines: [], preamble: 0, error: "reprise impossible : programme en coordonnées relatives (G91)" };
  const pre = [st.inches ? "G20" : "G21", "G90", "M5", `G0X${num(st.x)}Y${num(st.y)}`];
  if (st.feed > 0) pre.push(`F${num(st.feed)}`);
  pre.push(`S${num(st.s)}`);
  if (st.laser !== "M5") pre.push(st.laser);
  pre.push(`G${st.motion}`);
  return { lines: [...pre, ...lines.slice(start)], preamble: pre.length, error: null };
}

/**
 * Points où le faisceau brûle (extrémités des segments allumés), au plus `max` (échantillonnés).
 * `drawn` : tous les mouvements de travail (G1–G3), faisceau allumé ou non (traceur à stylo, programme sans M3/M4).
 */
export function burnPoints(lines: string[], max = 20000, drawn = false): [number, number][] {
  const pts: [number, number][] = [];
  let x = 0, y = 0, abs = true, motion = 0, s = 0, on = false;
  for (const line of lines) {
    let nx: number | null = null, ny: number | null = null;
    WORD.lastIndex = 0;
    for (let m = WORD.exec(line); m; m = WORD.exec(line)) {
      const v = Number(m[2]);
      if (m[1] === "G") { if (v >= 0 && v <= 3) motion = v; else if (v === 90) abs = true; else if (v === 91) abs = false; }
      else if (m[1] === "M") { if (v === 3 || v === 4) on = true; else if (v === 5) on = false; }
      else if (m[1] === "S") s = v;
      else if (m[1] === "X") nx = v;
      else if (m[1] === "Y") ny = v;
    }
    if (nx === null && ny === null) continue;
    const tx = nx === null ? x : abs ? nx : x + nx;
    const ty = ny === null ? y : abs ? ny : y + ny;
    if (motion !== 0 && (drawn || (on && s > 0))) {
      pts.push([x, y], [tx, ty]);
    }
    x = tx;
    y = ty;
  }
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out: [number, number][] = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * step)]);
  return out;
}

/** Enveloppe convexe (monotone chain), sens trigonométrique, sans point répété. */
export function convexHull(points: [number, number][]): [number, number][] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Parcours de cadrage : rectangle de l'emprise (`box`) ou contour réel du dessin (`hull`, enveloppe convexe des
 * points brûlés), `loops` tours. Faisceau coupé sauf `sValue` > 0 (pointeur à très faible puissance).
 */
export function frameLines(lines: string[], opts: { shape?: "box" | "hull"; feed: number; sValue: number; loops?: number }): string[] | null {
  let pts = burnPoints(lines);
  if (!pts.length) pts = burnPoints(lines, 20000, true);
  if (!pts.length) return null;
  let ring: [number, number][];
  if (opts.shape === "hull") {
    ring = convexHull(pts);
    if (ring.length < 3) return null;
  } else {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    ring = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
  }
  const loops = Math.min(5, Math.max(1, Math.floor(Number(opts.loops) || 1)));
  const out = ["G90", "G21", "M5", `G0X${num(ring[0][0])}Y${num(ring[0][1])}`, opts.sValue > 0 ? `M4S${num(opts.sValue)}` : "M5", `G1F${num(opts.feed)}`];
  for (let l = 0; l < loops; l++) for (let i = 1; i <= ring.length; i++) {
    const [x, y] = ring[i % ring.length];
    out.push(`G1X${num(x)}Y${num(y)}`);
  }
  return out;
}

/**
 * Ligne de reprise conseillée après un arrêt : GRBL acquitte une ligne dès qu'elle entre dans son planificateur
 * (jusqu'à une quinzaine de mouvements d'avance), on recule donc d'autant pour ne pas laisser de trou.
 */
export const PLANNER_LOOKBACK = 16;
export function resumeHint(ackedLine: number): number {
  return Math.max(0, Math.floor(ackedLine) - PLANNER_LOOKBACK);
}
