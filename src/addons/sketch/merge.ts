import { boolean, simplifyLine, simplifyMulti } from "../vector/ops";
import { multiBBox, type BBox, type Multi, type Pt, type Ring } from "../vector/geometry";
import type { StrokeBrush } from "./model";

/**
 * Contours exacts des traits pleins (outils de l'addon `vector` : union par polygon-clipping, simplification),
 * matière première de la carte d'aplats et de la gomme.
 */

/**
 * Trait « plein » : disque net, sans pointe ni variation ni pression variable → son contour est exact et sa couleur
 * uniforme (l'opacité est permise : elle s'aplatit en couleur). Les autres traits restent en empreintes.
 */
export function isSolid(b: StrokeBrush, pts: number[]): boolean {
  if (b.tip || b.hardness < 0.999 || b.scatter > 0 || b.sizeJitter > 0 || b.roundness !== 1) return false;
  if (b.pressure) {
    let lo = 1, hi = 0;
    for (let i = 2; i < pts.length; i += 3) { lo = Math.min(lo, pts[i]); hi = Math.max(hi, pts[i]); }
    if (hi - lo > 0.02) return false;
  }
  return true;
}

/** Rayon effectif d'un trait plein (la pression, constante, réduit le diamètre comme `dabSize`). */
export function solidRadius(b: StrokeBrush, pts: number[]): number {
  const p = b.pressure && pts.length >= 3 ? pts[2] : 1;
  return (b.size * (b.pressure ? 0.2 + 0.8 * Math.max(0, Math.min(1, p)) : 1)) / 2;
}

/** Nombre de côtés d'un disque de rayon r pour une erreur de corde ≤ tol. */
export function discSides(r: number, tol: number): number {
  if (!(r > 0) || !(tol > 0) || tol >= r) return 12;
  return Math.max(12, Math.min(64, Math.ceil(Math.PI / Math.acos(1 - tol / r))));
}

/* Repère local : les coordonnées du monde peuvent valoir 1e-6 ou 1e6 ; le découpage travaille près de 1. */
type Frame = { ox: number; oy: number; k: number };
const toWorld = (f: Frame, m: Multi): Multi => m.map((p) => p.map((r) => r.map(([x, y]): Pt => [x * f.k + f.ox, y * f.k + f.oy])));

function disc(cx: number, cy: number, r: number, n: number): Ring {
  const out: Ring = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

function band(ax: number, ay: number, bx: number, by: number, r: number): Ring | null {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  if (len < 1e-12) return null;
  const nx = (-dy / len) * r, ny = (dx / len) * r;
  return [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
}

/** Union par fusions successives (paquets de 8) : évite les très grosses files d'événements. */
function unionAll(list: Multi[]): Multi {
  let cur = list.filter((m) => m.length);
  while (cur.length > 1) {
    const next: Multi[] = [];
    for (let i = 0; i < cur.length; i += 8) next.push(boolean("union", cur[i], ...cur.slice(i + 1, i + 8)));
    cur = next;
  }
  return cur[0] ?? [];
}

/** Aligne les sommets sur une grille : les prédicats du découpage voient des points identiques. */
const snap = (m: Multi, step: number): Multi => m.map((p) => p.map((r) => r.map(([x, y]): Pt => [Math.round(x / step) * step, Math.round(y / step) * step])));

/**
 * Contour d'un trait plein : union des bandes de chaque segment et des disques à chaque sommet,
 * calculée dans un repère local, simplifiée à `tol` (monde).
 */
export function strokeOutline(pts: number[], r: number, tol: number): Multi {
  if (pts.length < 3 || !(r > 0)) return [];
  const f: Frame = { ox: pts[0], oy: pts[1], k: r };
  // Le tracé est d'abord simplifié (RDP de l'addon vector) à la même tolérance que le contour.
  const line: Pt[] = [];
  for (let i = 0; i < pts.length; i += 3) line.push([(pts[i] - f.ox) / r, (pts[i + 1] - f.oy) / r]);
  const path = simplifyLine(line, (tol / r) * 0.5);
  const n = discSides(r, tol);
  const pieces: Multi[] = [];
  for (let i = 0; i < path.length; i++) {
    pieces.push([[disc(path[i][0], path[i][1], 1, n)]]);
    if (i + 1 < path.length) { const b = band(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1], 1); if (b) pieces.push([[b]]); }
  }
  let lastErr: unknown;
  for (const step of [1e-7, 1e-5, 1e-3]) {
    try {
      const local = simplifyMulti(unionAll(pieces.map((p) => snap(p, step))), (tol / r) * 0.5);
      return toWorld(f, local);
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error("contour impossible");
}

export const shapeVertices = (m: Multi): number => m.reduce((n, p) => n + p.reduce((k, r) => k + r.length, 0), 0);

export function shapeBBox(m: Multi): BBox {
  // multiBBox ne lit que les contours extérieurs : suffisant (les trous sont dedans).
  return multiBBox(m);
}

/** Point dans la forme (pair-impair sur tous les contours) ou à moins de `r` d'un bord. */
export function shapeHit(m: Multi, px: number, py: number, r: number): boolean {
  let inside = false;
  for (const p of m) for (const ring of p) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      if (r > 0) {
        const dx = xi - xj, dy = yi - yj, l2 = dx * dx + dy * dy;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - xj) * dx + (py - yj) * dy) / l2));
        if (Math.hypot(px - (xj + t * dx), py - (yj + t * dy)) <= r) return true;
      }
    }
  }
  return inside;
}
