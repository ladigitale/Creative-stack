/** Calcul pur du texte cinétique : découpe, avancement décalé par unité, style par effet. */

export type Split = "chars" | "words" | "lines";
export type Effect = "rise" | "fade" | "blur" | "wipe" | "scale" | "slide";
export type Ease = "linear" | "out" | "inout";

export const MAX_UNITS = 2000;
export const EFFECTS: readonly Effect[] = ["rise", "fade", "blur", "wipe", "scale", "slide"];

export type Piece = { text: string; unit: boolean };

/** Découpe en morceaux : les espaces restent du texte brut (jamais animés), le reste est une unité. */
export function splitPieces(text: string, mode: Split): Piece[] {
  const out: Piece[] = [];
  if (mode === "chars") {
    for (const ch of Array.from(text)) out.push({ text: ch, unit: !/\s/.test(ch) });
  } else {
    for (const part of text.split(/(\s+)/)) if (part !== "") out.push({ text: part, unit: !/^\s+$/.test(part) });
  }
  let n = 0;
  return out.map((p) => (p.unit && ++n > MAX_UNITS ? { text: p.text, unit: false } : p));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function ease(t: number, e: Ease): number {
  const x = clamp01(t);
  if (e === "out") return 1 - Math.pow(1 - x, 3);
  if (e === "inout") return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  return x;
}

/**
 * Avancement local d'une unité parmi `n` : `spread` (0..1) est la part de la course consacrée au décalage entre
 * la première et la dernière unité. 0 : toutes ensemble ; 1 : chacune après la précédente.
 */
export function unitProgress(index: number, n: number, progress: number, spread: number): number {
  const p = clamp01(progress);
  if (n <= 1) return p;
  const s = clamp01(spread);
  const dur = 1 - s;
  const start = (index / (n - 1)) * s;
  if (dur <= 0.0001) return p >= start ? 1 : 0;
  return clamp01((p - start) / dur);
}

export type UnitStyle = { outerClip: boolean; opacity: number; transform: string; filter: string; clipPath: string };

const r = (v: number) => Math.round(v * 1000) / 1000;

/** Style d'une unité à l'avancement local `t` (0 caché, 1 au repos). */
export function effectStyle(effect: Effect, t: number, distance: number): UnitStyle {
  const x = clamp01(t);
  const rest = { outerClip: false, opacity: 1, transform: "", filter: "", clipPath: "" };
  switch (effect) {
    case "rise": return { ...rest, outerClip: true, transform: x >= 1 ? "" : `translateY(${r((1 - x) * 110)}%)` };
    case "fade": return { ...rest, opacity: r(x) };
    case "blur": return { ...rest, opacity: r(x), filter: x >= 1 ? "" : `blur(${r((1 - x) * 10)}px)` };
    case "wipe": return { ...rest, clipPath: x >= 1 ? "" : `inset(0 ${r((1 - x) * 100)}% 0 0)` };
    case "scale": return { ...rest, opacity: r(x), transform: x >= 1 ? "" : `scale(${r(0.6 + 0.4 * x)})` };
    case "slide": return { ...rest, opacity: r(x), transform: x >= 1 ? "" : `translateX(${r((1 - x) * distance)}px)` };
  }
}

/** Regroupe des positions verticales en indices de ligne (une nouvelle ligne quand la position change de plus de `tol`). */
export function lineIndices(tops: readonly number[], tol = 2): number[] {
  const out: number[] = [];
  let line = -1;
  let last = -Infinity;
  for (const t of tops) {
    if (Math.abs(t - last) > tol) { line++; last = t; }
    out.push(Math.max(0, line));
  }
  return out;
}
