/** Invites de `sonic-segment-anything` : lecture, réduction des clics, conversion en px. Fonctions pures. */
import type { HfSamBox, HfSamPoint } from "./hf-protocol";

export const MAX_POINTS = 16;

/** Point d'invite en coordonnées d'écran 0..1 ; `label` 1 = sur l'objet, 0 = hors de l'objet. */
export type SamPoint = { x: number; y: number; label: 0 | 1 };
export type SamBox = { x0: number; y0: number; x1: number; y1: number };
export type SamPrompts = { points: SamPoint[]; box: SamBox | null };

const in01 = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;

function onePoint(v: unknown): SamPoint | null {
  let x: number, y: number, label: unknown = 1;
  if (typeof v === "string") {
    const p = v.trim().split(/[\s,]+/);
    if (p.length < 2) return null;
    x = Number(p[0]);
    y = Number(p[1]);
    if (p.length > 2) label = Number(p[2]);
  } else if (Array.isArray(v)) {
    x = Number(v[0]);
    y = Number(v[1]);
    if (v.length > 2) label = Number(v[2]);
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    x = Number(o.x);
    y = Number(o.y);
    if ("label" in o) label = o.label;
    else if ("positive" in o) label = o.positive === false ? 0 : 1;
  } else return null;
  if (!in01(x) || !in01(y)) return null;
  const l = label === 0 || label === "0" || label === false || label === "negative" ? 0 : 1;
  return { x, y, label: l };
}

/** Liste de points depuis un tableau (`[{x, y, label}]`, `[[x, y, label]]`), une chaîne `"x,y,1; x,y,0"` ou un point seul. */
export function parsePoints(v: unknown): SamPoint[] {
  if (v === null || v === undefined || v === "") return [];
  let list: unknown[];
  if (typeof v === "string") list = v.split(";").filter((s) => s.trim());
  else if (Array.isArray(v) && v.length && (typeof v[0] === "number" || typeof v[0] === "string") && !String(v[0]).includes(",")) list = [v];
  else if (Array.isArray(v)) list = v;
  else list = [v];
  const out: SamPoint[] = [];
  for (const item of list) {
    const p = onePoint(item);
    if (p) out.push(p);
    if (out.length >= MAX_POINTS) break;
  }
  return out;
}

/** Boîte depuis `{x0, y0, x1, y1}`, `{x, y, w, h}`, `[x0, y0, x1, y1]` ou `"x0,y0,x1,y1"` ; remise dans l'ordre ; `null` si vide ou invalide. */
export function parseBox(v: unknown): SamBox | null {
  let a: number[];
  if (typeof v === "string") a = v.trim().split(/[\s,]+/).map(Number);
  else if (Array.isArray(v)) a = v.map(Number);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("w" in o || "h" in o) {
      const x = Number(o.x), y = Number(o.y);
      a = [x, y, x + Number(o.w), y + Number(o.h)];
    } else a = [Number(o.x0), Number(o.y0), Number(o.x1), Number(o.y1)];
  } else return null;
  if (a.length < 4 || !a.slice(0, 4).every(in01)) return null;
  const box = { x0: Math.min(a[0], a[2]), y0: Math.min(a[1], a[3]), x1: Math.max(a[0], a[2]), y1: Math.max(a[1], a[3]) };
  if (box.x1 - box.x0 < 0.002 || box.y1 - box.y0 < 0.002) return null;
  return box;
}

export type Gesture =
  | { kind: "point"; x: number; y: number; add: boolean; negative: boolean }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number };

/**
 * Applique un geste : clic simple = nouvelle sélection sur ce point ; `add` (Maj) ajoute un point sur l'objet ;
 * `negative` (Alt, clic droit) ajoute un point hors de l'objet ; un glissé trace une boîte (et efface les points).
 */
export function applyGesture(prev: SamPrompts, g: Gesture): SamPrompts {
  if (g.kind === "box") {
    const box = parseBox([g.x0, g.y0, g.x1, g.y1]);
    return box ? { points: [], box } : prev;
  }
  const p = onePoint({ x: g.x, y: g.y, label: g.negative ? 0 : 1 });
  if (!p) return prev;
  if (!g.add && !g.negative) return { points: [p], box: null };
  if (prev.points.length >= MAX_POINTS) return prev;
  return { points: [...prev.points, p], box: prev.box };
}

/** Invites écran (0..1) → px de l'image encodée (`width`×`height`), en tenant compte d'une image vue en miroir. */
export function toPixels(prompts: SamPrompts, width: number, height: number, mirror: boolean): { points: HfSamPoint[]; box: HfSamBox | null } {
  const fx = (x: number) => (mirror ? 1 - x : x) * width;
  const points = prompts.points.map((p) => ({ x: fx(p.x), y: p.y * height, label: p.label }));
  const b = prompts.box;
  const box = b ? { x0: Math.min(fx(b.x0), fx(b.x1)), y0: b.y0 * height, x1: Math.max(fx(b.x0), fx(b.x1)), y1: b.y1 * height } : null;
  return { points, box };
}

export function hasPrompt(p: SamPrompts): boolean {
  return p.points.some((q) => q.label === 1) || !!p.box;
}

/** Taille d'encodage : le côté le plus long ramené à `maxSide` (jamais agrandi). */
export function fitSize(w: number, h: number, maxSide: number): { width: number; height: number } {
  const s = Math.min(1, maxSide / Math.max(1, w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}
