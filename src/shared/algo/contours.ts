/**
 * Contours d'une grille : les bords des régions « dedans » (valeurs choisies) en boucles fermées, orientées et
 * emboîtées, simplifiées (points alignés retirés) puis lissées par l'algorithme de Chaikin. Pour dessiner des parois
 * organiques (polygones `sonic-2d`), un brouillard à partir d'un masque exploré, un tracé vectoriel.
 *
 * Chaque boucle porte `depth` (0 = la plus extérieure) et `hole` : dessiner dans l'ordre de `depth` en alternant les
 * couleurs (dedans, dehors, dedans…) donne la bonne image sans gestion de trous par le rendu.
 */
import type { Grid } from "./grid";

export interface Contour {
  points: [number, number][];
  /** Boucle qui borde un trou (région « dehors » enclavée). */
  hole: boolean;
  /** Profondeur d'emboîtement (0 = extérieure). */
  depth: number;
  /** Aire (unités du monde²). */
  area: number;
}

export interface ContourOptions {
  /** Hors de la grille compte comme « dedans » (`fill`, parois fermées) ou « dehors » (`empty`, défaut). */
  border?: "fill" | "empty";
  /** Passes de Chaikin (0 à 4, défaut 2). */
  smooth?: number;
  /** Taille d'une case en unités du monde (défaut 1) et décalage. */
  scale?: number;
  offset?: [number, number];
  /** Boucles d'aire inférieure ignorées (en cases², défaut 0). */
  minArea?: number;
  /** 2000 boucles au plus. */
  max?: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100 + 0;

export function contours(grid: Grid, inside: (k: number) => boolean, o: ContourOptions = {}): Contour[] {
  const W = grid.w, H = grid.h;
  const fillBorder = o.border === "fill";
  const isIn = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? fillBorder : inside(y * W + x));
  // Arêtes orientées : la région « dedans » à gauche en parcourant (repère y vers le bas : sens horaire à l'écran).
  // Sommets numérotés sur la grille des coins (W + 3) × (H + 3), décalée de 1 pour couvrir le bord.
  const CW = W + 3;
  const vid = (x: number, y: number) => (y + 1) * CW + (x + 1);
  const next = new Map<number, number[]>();
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const a = vid(ax, ay);
    let l = next.get(a);
    if (!l) next.set(a, (l = []));
    l.push(vid(bx, by));
  };
  // Les cases au bord sont examinées jusqu'à -1 et W (hors grille) pour fermer les régions qui touchent le bord.
  const x0 = fillBorder ? -1 : 0, x1 = fillBorder ? W : W - 1, y0 = fillBorder ? -1 : 0, y1 = fillBorder ? H : H - 1;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (!isIn(x, y)) continue;
      // haut, droite, bas, gauche : arête quand le voisin est « dehors » (et dans le cadre examiné)
      const out = (nx: number, ny: number) => nx < x0 || ny < y0 || nx > x1 || ny > y1 ? !fillBorder : !isIn(nx, ny);
      if (out(x, y - 1)) add(x + 1, y, x, y);
      if (out(x + 1, y)) add(x + 1, y + 1, x + 1, y);
      if (out(x, y + 1)) add(x, y + 1, x + 1, y + 1);
      if (out(x - 1, y)) add(x, y, x, y + 1);
    }
  const vx = (v: number) => (v % CW) - 1, vy = (v: number) => Math.floor(v / CW) - 1;
  const loops: [number, number][][] = [];
  const max = Math.max(1, Math.min(2000, o.max ?? 2000));
  for (const [start, outs] of next) {
    while (outs.length && loops.length < max) {
      const loop: [number, number][] = [];
      let prev = start;
      let cur = outs.pop()!;
      loop.push([vx(start), vy(start)]);
      let guard = 0;
      while (cur !== start && guard++ < 4 * (W + 3) * (H + 3)) {
        loop.push([vx(cur), vy(cur)]);
        const cand = next.get(cur);
        if (!cand || !cand.length) break;
        let pick = 0;
        if (cand.length > 1) {
          // point selle : tourner à droite (garde les cases « dedans » reliées par 4-voisinage)
          const dx = vx(cur) - vx(prev), dy = vy(cur) - vy(prev);
          let best = -Infinity;
          cand.forEach((c, i) => {
            const ex = vx(c) - vx(cur), ey = vy(c) - vy(cur);
            const turn = dx * ey - dy * ex; // > 0 : à droite (y vers le bas)
            if (turn > best) {
              best = turn;
              pick = i;
            }
          });
        }
        prev = cur;
        cur = cand.splice(pick, 1)[0];
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }
  const scale = o.scale ?? 1;
  const [ox, oy] = o.offset ?? [0, 0];
  const minArea = o.minArea ?? 0;
  const passes = Math.max(0, Math.min(4, Math.floor(o.smooth ?? 2)));
  const out: Contour[] = [];
  for (const raw of loops) {
    // milieux des arêtes unitaires (marching squares) : un escalier de cases devient une vraie diagonale
    const mids: [number, number][] = raw.map((a, i) => {
      const b = raw[(i + 1) % raw.length];
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    });
    const pts = dropCollinear(mids);
    if (pts.length < 3) continue;
    const a = signedArea(pts);
    if (Math.abs(a) < minArea) continue;
    let sm = pts;
    for (let i = 0; i < passes; i++) sm = chaikin(sm);
    out.push({ points: sm.map(([x, y]) => [r2(x * scale + ox), r2(y * scale + oy)]), hole: a < 0, depth: 0, area: r2(Math.abs(a) * scale * scale) });
  }
  // profondeur : nombre de boucles qui contiennent un point de celle-ci (premier sommet avant lissage ≈ sur la boucle :
  // on prend le milieu d'une arête légèrement décalé vers l'intérieur de sa région)
  for (const c of out) {
    const p = c.points[0];
    let d = 0;
    for (const other of out) if (other !== c && other.area > c.area && inPolygon(p, other.points)) d++;
    c.depth = d;
  }
  return out.sort((p, q) => p.depth - q.depth || q.area - p.area);
}

function dropCollinear(pts: [number, number][]): [number, number][] {
  const n = pts.length;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}

function chaikin(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  return out;
}

/** Aire signée (repère y vers le bas : positive pour une boucle extérieure parcourue dedans à gauche). */
function signedArea(pts: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return -s / 2;
}

export function inPolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
