import { describe, expect, it } from "vitest";
import { compactStroke, curvePath, fitCurvePoints, makeBrush, strokeBBox, strokePath, type Stroke } from "./model";
import { readStrokes, writeStrokes } from "./store";
import { BRUSH_DEFAULTS } from "../paint/brush";
import { MIN_STAMP_PX, drawStroke, strokeStamps, type Surface } from "./render";

/** Tracé brut d'un arc de cercle (rayon 100) échantillonné comme à la souris, avec un peu de tremblement. */
function arc(n = 400, noise = 0.05, pressure = (t: number) => 0.4 + 0.5 * Math.sin(t * Math.PI)) {
  const out: number[] = [];
  let s = 1;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), a = t * Math.PI * 1.2;
    out.push(100 * Math.cos(a) + r() * noise, 100 * Math.sin(a) + r() * noise, Math.min(1, Math.max(0, pressure(t) + r() * 0.03)));
  }
  return out;
}

/** Distance max des points bruts au tracé (ligne brisée dense). */
function maxDev(raw: number[], path: number[]): number {
  let worst = 0;
  for (let i = 0; i < raw.length; i += 3) {
    let d = Infinity;
    for (let j = 0; j + 5 < path.length; j += 3) {
      const ax = path[j], ay = path[j + 1], bx = path[j + 3], by = path[j + 4];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((raw[i] - ax) * dx + (raw[i + 1] - ay) * dy) / l2)) : 0;
      d = Math.min(d, Math.hypot(raw[i] - (ax + t * dx), raw[i + 1] - (ay + t * dy)));
    }
    worst = Math.max(worst, d);
  }
  return worst;
}

describe("traits en courbe (points de passage)", () => {
  it("bien moins de points qu'une ligne brisée de même précision, tracé dans la tolérance", () => {
    const raw = arc();
    const tol = 0.35;
    const line = compactStroke(raw, tol, 0.04);
    const fit = fitCurvePoints(raw, tol, 0.06);
    expect(fit.length).toBeLessThan(line.length / 2.5);
    const path = curvePath(fit, 0.5);
    expect(maxDev(raw, path)).toBeLessThan(tol * 1.3);
    // passe par ses points de passage, extrémités comprises
    expect(path.slice(0, 2)).toEqual(fit.slice(0, 2));
    expect(path.slice(-3, -1)).toEqual(fit.slice(-3, -1));
  });

  it("le tremblement de la pression ne garde pas de points ; la pression suit quand même", () => {
    const raw = arc(400, 0.02);
    const withP = fitCurvePoints(raw, 0.35, 0.06);
    const without = fitCurvePoints(raw, 0.35);
    expect(withP.length).toBeLessThan(without.length * 2);
    const path = curvePath(withP, 0.5);
    const mid = path[Math.floor(path.length / 6) * 3 + 2];
    expect(mid).toBeGreaterThan(0.75);
  });

  it("tracé du trait, enregistrement et relecture", () => {
    const b = makeBrush({ ...BRUSH_DEFAULTS, hardness: 0.5 }, 8);
    const pts = fitCurvePoints(arc(), 0.35, 0.06);
    const s: Stroke = { id: 1, brush: b, pts, seed: 3, curve: true, bbox: strokeBBox(pts, 4) };
    const path = strokePath(s);
    expect(path.length).toBeGreaterThan(pts.length * 3);
    // échantillonnage fin : au plus ~1/6 du diamètre entre deux points
    for (let i = 3; i < path.length; i += 3) expect(Math.hypot(path[i] - path[i - 3], path[i + 1] - path[i - 2])).toBeLessThan(b.size / 5);
    const back = readStrokes(writeStrokes([s]))!;
    expect(back[0].curve).toBe(true);
    expect(back[0].pts).toEqual(pts);
    expect(strokeStamps(back[0]).length).toBe(strokeStamps(s).length);
    // une ligne brisée reste une ligne brisée
    const plain = readStrokes(writeStrokes([{ ...s, curve: undefined }]))!;
    expect(plain[0].curve).toBeUndefined();
    expect(strokePath(plain[0])).toBe(plain[0].pts);
  });
});

describe("rendu au dézoom (niveau de détail)", () => {
  /** Contexte factice : compte les empreintes posées et leur opacité. */
  function surface(zoom: number) {
    const calls: number[] = [];
    let alpha = 1;
    const ctx = {
      save() {}, restore() {}, translate() {}, rotate() {}, fill() {}, setTransform() {}, getTransform() { return {}; },
      set globalAlpha(v: number) { alpha = v; }, get globalAlpha() { return alpha; },
      globalCompositeOperation: "source-over", fillStyle: "#000",
      drawImage() { calls.push(alpha); },
      canvas: {},
    } as unknown as CanvasRenderingContext2D;
    const s: Surface = { ctx, w: 4000, h: 4000, view: { x: 0, y: 0, zoom, rotation: 0 } };
    return { s, calls };
  }
  const b = makeBrush({ ...BRUSH_DEFAULTS, hardness: 0.6, pressure: false }, 10);
  const line = { id: 1, brush: b, pts: [-500, 0, 1, 500, 0, 1], seed: 1, bbox: strokeBBox([-500, 0, 1, 500, 0, 1], 5) } as Stroke;

  it("à l'échelle 1 : toutes les empreintes", () => {
    const { s, calls } = surface(1);
    drawStroke(s, line);
    expect(calls.length).toBe(strokeStamps(line).length);
  });

  it("dézoomé : au plus une empreinte par demi-pixel, plus aucune ignorée, opacité selon la surface", () => {
    const { s, calls } = surface(0.05);
    drawStroke(s, line);
    const all = strokeStamps(line).length;
    // 1000 de long à 0,05 = 50 px à l'écran : environ 100 empreintes au lieu de toutes
    expect(calls.length).toBeLessThan(all / 3);
    expect(calls.length).toBeGreaterThan(50);
    // empreinte de 0,5 px : posée à MIN_STAMP_PX, opacité réduite (surface), jamais nulle
    expect(Math.max(...calls)).toBeLessThan(1);
    expect(Math.min(...calls)).toBeGreaterThan(0);
    expect(MIN_STAMP_PX).toBe(1);
  });
});
