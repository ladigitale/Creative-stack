/**
 * Lignes et vue sur grille : tracé de Bresenham, ligne de vue entre deux cases, champ de vision par shadowcasting
 * récursif (8 octants, symétrique à la case près, rayon circulaire).
 */
import { type Cell, type Grid, inside } from "./grid";

/** Cases du segment a → b (Bresenham), extrémités comprises. */
export function line(a: Cell, b: Cell, maxLen = 4096): Cell[] {
  let [x0, y0] = a;
  const [x1, y1] = b;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const out: Cell[] = [];
  for (let i = 0; i <= maxLen; i++) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

/**
 * Ligne de vue : aucune case intermédiaire ne bloque. `see` : bloquée par les cases opaques (on voit le mur visé) ;
 * `walk` : bloquée par les murs, arrivée comprise (lissage de chemin).
 */
export function sightClear(grid: Grid, a: Cell, b: Cell, mode: "see" | "walk" = "see"): boolean {
  const cells = line(a, b);
  const last = mode === "walk" ? cells.length : cells.length - 1;
  for (let i = 1; i < last; i++) {
    const [x, y] = cells[i];
    if (!inside(grid, x, y)) return false;
    const k = y * grid.w + x;
    if (mode === "see" ? grid.opaque[k] : grid.cost[k] === Infinity) return false;
  }
  if (mode === "walk" && grid.diag && !grid.cut) {
    // pas de passage en diagonale entre deux murs qui se touchent par un coin
    for (let i = 1; i < cells.length; i++) {
      const [x0, y0] = cells[i - 1], [x1, y1] = cells[i];
      if (x0 !== x1 && y0 !== y1 && (grid.cost[y0 * grid.w + x1] === Infinity || grid.cost[y1 * grid.w + x0] === Infinity)) return false;
    }
  }
  return true;
}

// octants : (xx, xy, yx, yy)
const OCT = [
  [1, 0, 0, 1], [0, 1, 1, 0], [0, -1, 1, 0], [-1, 0, 0, 1],
  [-1, 0, 0, -1], [0, -1, -1, 0], [0, 1, -1, 0], [1, 0, 0, -1],
];

/**
 * Champ de vision depuis `origin` dans un rayon (cases) : masque des cases vues (murs vus compris).
 * Shadowcasting récursif de Björn Bergström.
 */
export function fov(grid: Grid, origin: Cell, radius: number): Uint8Array {
  const seen = new Uint8Array(grid.w * grid.h);
  const [ox, oy] = origin;
  if (!inside(grid, ox, oy)) return seen;
  seen[oy * grid.w + ox] = 1;
  const r = Math.max(0, Math.min(512, radius));
  const r2 = (r + 0.5) * (r + 0.5);
  const opaqueAt = (x: number, y: number) => !inside(grid, x, y) || grid.opaque[y * grid.w + x] === 1;
  const cast = (row: number, start: number, end: number, xx: number, xy: number, yx: number, yy: number): void => {
    if (start < end) return;
    let newStart = 0;
    for (let j = row; j <= r; j++) {
      let blocked = false;
      for (let dx = -j, dy = -j; dx <= 0; dx++) {
        const lSlope = (dx - 0.5) / (dy + 0.5);
        const rSlope = (dx + 0.5) / (dy - 0.5);
        if (start < rSlope) continue;
        if (end > lSlope) break;
        const X = ox + dx * xx + dy * xy;
        const Y = oy + dx * yx + dy * yy;
        if (dx * dx + dy * dy <= r2 && inside(grid, X, Y)) seen[Y * grid.w + X] = 1;
        if (blocked) {
          if (opaqueAt(X, Y)) {
            newStart = rSlope;
          } else {
            blocked = false;
            start = newStart;
          }
        } else if (opaqueAt(X, Y) && j < r) {
          blocked = true;
          cast(j + 1, start, lSlope, xx, xy, yx, yy);
          newStart = rSlope;
        }
      }
      if (blocked) break;
    }
  };
  for (const [xx, xy, yx, yy] of OCT) cast(1, 1, 0, xx, xy, yx, yy);
  return seen;
}
