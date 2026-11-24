/**
 * Motifs génératifs pour la gravure au trait : arbres, corail, spirographe, guilloché, rosace, Truchet,
 * labyrinthe, champ de flux, harmonographe, ondes, motif répété. Chaque générateur rend des polylignes (mm,
 * y vers le bas, comme le SVG) ; `fitLines` les cadre, `optimizeStrokes` (lineart.ts) évite les doubles passages.
 * Fonctions pures, reproductibles par graine.
 */
import { rng } from "./photo";
import type { P2, Polyline } from "./lineart";

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Bruit de gradient 2D (valeurs ≈ −1…1), reproductible par graine. */
export function noise2(seed: number): (x: number, y: number) => number {
  const r = rng(seed * 7919 + 13);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h: number, x: number, y: number) => {
    const a = (h / 256) * TAU;
    return Math.cos(a) * x + Math.sin(a) * y;
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const X = Math.floor(x), Y = Math.floor(y);
    const fx = x - X, fy = y - Y;
    const xi = X & 255, yi = Y & 255;
    const g00 = grad(perm[xi + perm[yi]], fx, fy), g10 = grad(perm[xi + 1 + perm[yi]], fx - 1, fy);
    const g01 = grad(perm[xi + perm[yi + 1]], fx, fy - 1), g11 = grad(perm[xi + 1 + perm[yi + 1]], fx - 1, fy - 1);
    const u = fade(fx), v = fade(fy);
    return (g00 * (1 - u) + g10 * u) * (1 - v) + (g01 * (1 - u) + g11 * u) * v;
  };
}

/** Cadre des tracés dans `w × h` (marge comprise), proportions gardées, centrés. */
export function fitLines(lines: Polyline[], w: number, h: number, margin = 0): Polyline[] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (const [x, y] of l) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!(x1 >= x0)) return [];
  const bw = Math.max(x1 - x0, 1e-9), bh = Math.max(y1 - y0, 1e-9);
  const k = Math.min((w - 2 * margin) / bw, (h - 2 * margin) / bh);
  const ox = (w - bw * k) / 2 - x0 * k, oy = (h - bh * k) / 2 - y0 * k;
  return lines.map((l) => l.map(([x, y]) => [x * k + ox, y * k + oy] as P2));
}

/** Garde les parties des tracés à l'intérieur d'un disque (centre, rayon). */
export function clipToCircle(lines: Polyline[], cx: number, cy: number, r: number): Polyline[] {
  const inside = (p: P2) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 <= r * r;
  const out: Polyline[] = [];
  for (const l of lines) {
    let cur: Polyline = [];
    for (let i = 0; i < l.length; i++) {
      const p = l[i];
      if (inside(p)) {
        if (!cur.length && i > 0) cur.push(edgePoint(l[i - 1], p, cx, cy, r));
        cur.push(p);
      } else if (cur.length) {
        cur.push(edgePoint(p, l[i - 1], cx, cy, r));
        if (cur.length >= 2) out.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 2) out.push(cur);
  }
  return out;
}

/** Garde les parties des tracés dans un rectangle. */
export function clipToRect(lines: Polyline[], x0: number, y0: number, x1: number, y1: number): Polyline[] {
  const inside = (p: P2) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const cross = (o: P2, i: P2): P2 => {
    // Dichotomie : assez précis pour la gravure, sans cas particuliers.
    let a = o, b = i;
    for (let k = 0; k < 24; k++) {
      const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (inside(m)) b = m;
      else a = m;
    }
    return b;
  };
  const out: Polyline[] = [];
  for (const l of lines) {
    let cur: Polyline = [];
    for (let i = 0; i < l.length; i++) {
      const p = l[i];
      if (inside(p)) {
        if (!cur.length && i > 0) cur.push(cross(l[i - 1], p));
        cur.push(p);
      } else if (cur.length) {
        cur.push(cross(p, l[i - 1]));
        if (cur.length >= 2) out.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 2) out.push(cur);
  }
  return out;
}

function edgePoint(out: P2, inn: P2, cx: number, cy: number, r: number): P2 {
  // Intersection du segment [inn, out] avec le cercle.
  const dx = out[0] - inn[0], dy = out[1] - inn[1];
  const fx = inn[0] - cx, fy = inn[1] - cy;
  const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
  const t = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a || 1);
  return [inn[0] + dx * clamp(t, 0, 1), inn[1] + dy * clamp(t, 0, 1)];
}

// ─── Arbre (branches récursives, courbes) ────────────────────────────────────────────────────────────────────
export type TreeOpts = { depth: number; branches: number; angle: number; spread: number; ratio: number; bend: number; gravity: number; jitter: number; seed: number; taper: number };

export function tree(o: TreeOpts): Polyline[] {
  const r = rng(o.seed);
  const out: Polyline[] = [];
  const maxSegs = 60_000;
  let count = 0;
  const grow = (x: number, y: number, dir: number, len: number, level: number) => {
    if (level > o.depth || count > maxSegs) return;
    // Branche courbe : la direction tourne doucement (courbure + gravité), échantillonnée.
    // Courbure totale de la branche (jusqu'à ~70°) et gravité (les branches fines plient davantage).
    const steps = Math.max(2, Math.round(4 + len / 2));
    const bend = ((r() * 2 - 1) * (o.bend / 100) * 1.2) / steps;
    const sag = ((o.gravity / 100) * 1.1 * (level + 1)) / Math.max(1, o.depth + 1) / steps;
    const pts: Polyline = [[x, y]];
    let a = dir, px = x, py = y;
    for (let s = 1; s <= steps; s++) {
      a += bend + sag * Math.cos(a);
      px += (Math.cos(a) * len) / steps;
      py += (Math.sin(a) * len) / steps;
      pts.push([px, py]);
    }
    out.push(pts);
    count += steps;
    const n = level === 0 ? Math.max(1, o.branches) : o.branches;
    for (let k = 0; k < n; k++) {
      const base = n === 1 ? 0 : (k / (n - 1) - 0.5) * 2 * o.angle * (1 + o.spread * 0.01 * (n - 2) * 0.5);
      const j = (r() * 2 - 1) * o.jitter * 0.01 * o.angle;
      const na = a + ((base + j) * Math.PI) / 180;
      const nl = len * o.ratio * (1 - o.jitter * 0.002 * r());
      grow(px, py, na, nl * (1 - o.taper * 0.003 * Math.abs(base) / Math.max(o.angle, 1)), level + 1);
    }
  };
  grow(0, 0, -Math.PI / 2, 30, 0);
  return out;
}

// ─── Corail (colonisation de l'espace) ───────────────────────────────────────────────────────────────────────
export function coral(o: { attractors: number; step: number; kill: number; reach: number; seeds: number; seed: number; shape: number }): Polyline[] {
  const r = rng(o.seed);
  const pts: P2[] = [];
  for (let i = 0; i < o.attractors; i++) {
    const a = r() * TAU, d = Math.sqrt(r());
    // 0 disque, 1 couronne (vers le haut), 2 carré
    if (o.shape === 2) pts.push([r() * 100 - 50, r() * 100 - 50]);
    else if (o.shape === 1) pts.push([Math.cos(a) * 50 * d, -Math.abs(Math.sin(a)) * 50 * d - 5]);
    else pts.push([Math.cos(a) * 50 * d, Math.sin(a) * 50 * d]);
  }
  type N = { x: number; y: number; parent: number };
  const nodes: N[] = [];
  for (let k = 0; k < Math.max(1, o.seeds); k++) {
    const a = (k / Math.max(1, o.seeds)) * TAU;
    nodes.push(o.shape === 1 ? { x: (k - (o.seeds - 1) / 2) * (80 / Math.max(1, o.seeds)), y: 0, parent: -1 } : o.seeds === 1 ? { x: 0, y: 0, parent: -1 } : { x: Math.cos(a) * 45, y: Math.sin(a) * 45, parent: -1 });
  }
  const alive = pts.map(() => true);
  for (let iter = 0; iter < 400 && nodes.length < 6000; iter++) {
    const pull = new Map<number, [number, number, number]>();
    let any = false;
    for (let i = 0; i < pts.length; i++) {
      if (!alive[i]) continue;
      let best = -1, bd = o.reach * o.reach;
      for (let n = 0; n < nodes.length; n++) {
        const dx = pts[i][0] - nodes[n].x, dy = pts[i][1] - nodes[n].y, d = dx * dx + dy * dy;
        if (d < o.kill * o.kill) { alive[i] = false; best = -1; break; }
        if (d < bd) { bd = d; best = n; }
      }
      if (best < 0) continue;
      any = true;
      const d = Math.sqrt(bd) || 1;
      const v = pull.get(best) ?? [0, 0, 0];
      v[0] += (pts[i][0] - nodes[best].x) / d;
      v[1] += (pts[i][1] - nodes[best].y) / d;
      v[2]++;
      pull.set(best, v);
    }
    if (!any) break;
    for (const [n, [vx, vy]] of pull) {
      const L = Math.hypot(vx, vy) || 1;
      nodes.push({ x: nodes[n].x + (vx / L) * o.step, y: nodes[n].y + (vy / L) * o.step, parent: n });
    }
  }
  return nodes.filter((n) => n.parent >= 0).map((n) => [[nodes[n.parent].x, nodes[n.parent].y], [n.x, n.y]] as Polyline);
}

// ─── Spirographe (hypotrochoïde / épitrochoïde) ──────────────────────────────────────────────────────────────
export function spirograph(o: { ring: number; wheel: number; pen: number; layers: number; outside: number; turnLayers: number }): Polyline[] {
  const R = o.ring, rr = Math.min(o.wheel, R - 1), d = o.pen * rr;
  const g = gcd(R, rr);
  const turns = rr / g;
  const steps = Math.min(40_000, Math.round(turns * 360));
  const out: Polyline[] = [];
  for (let L = 0; L < Math.max(1, o.layers); L++) {
    const rot = (L * o.turnLayers * Math.PI) / 180 / Math.max(1, o.layers);
    const pts: Polyline = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * TAU * turns;
      let x: number, y: number;
      if (o.outside) {
        x = (R + rr) * Math.cos(t) - d * Math.cos(((R + rr) / rr) * t);
        y = (R + rr) * Math.sin(t) - d * Math.sin(((R + rr) / rr) * t);
      } else {
        x = (R - rr) * Math.cos(t) + d * Math.cos(((R - rr) / rr) * t);
        y = (R - rr) * Math.sin(t) - d * Math.sin(((R - rr) / rr) * t);
      }
      pts.push([x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)]);
    }
    out.push(pts);
  }
  return out;
}

function gcd(a: number, b: number): number {
  a = Math.round(Math.abs(a));
  b = Math.round(Math.abs(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

// ─── Guilloché (anneaux ondulés décalés) ─────────────────────────────────────────────────────────────────────
export function guilloche(o: { rings: number; waves: number; amp: number; phase: number; inner: number; twist: number }): Polyline[] {
  const out: Polyline[] = [];
  const steps = Math.max(180, o.waves * 24);
  for (let k = 0; k < o.rings; k++) {
    const base = o.inner + ((100 - o.inner) * (k + 0.5)) / o.rings;
    const ph = (k * o.phase * Math.PI) / 180;
    const pts: Polyline = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * TAU;
      const rad = base + o.amp * Math.sin(o.waves * t + ph) + o.amp * 0.35 * Math.sin((o.waves * 2 + o.twist) * t - ph);
      pts.push([rad * Math.cos(t), rad * Math.sin(t)]);
    }
    out.push(pts);
  }
  return out;
}

// ─── Rosace (pétales en couches) ─────────────────────────────────────────────────────────────────────────────
export function rosette(o: { petals: number; layers: number; width: number; offset: number; inner: number; heart: number }): Polyline[] {
  const out: Polyline[] = [];
  const petal = (a: number, r0: number, r1: number, w: number): Polyline => {
    const pts: Polyline = [];
    const n = 28;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const rad = r0 + (r1 - r0) * t;
      const half = Math.sin(Math.PI * t) ** (o.heart ? 0.6 : 1) * w;
      pts.push([rad, half]);
    }
    for (let i = n - 1; i >= 1; i--) {
      const t = i / n;
      const rad = r0 + (r1 - r0) * t;
      const half = Math.sin(Math.PI * t) ** (o.heart ? 0.6 : 1) * w;
      pts.push([rad, -half]);
    }
    pts.push(pts[0]);
    return pts.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] as P2);
  };
  for (let L = 0; L < o.layers; L++) {
    const r0 = o.inner + ((100 - o.inner) * L) / o.layers * 0.8;
    const r1 = o.inner + ((100 - o.inner) * (L + 1)) / o.layers;
    const w = ((r1 * Math.PI) / o.petals) * (o.width / 100);
    const shift = L % 2 ? (o.offset / 100) * (Math.PI / o.petals) * 2 : 0;
    for (let k = 0; k < o.petals; k++) out.push(petal((k / o.petals) * TAU + shift, r0 * 0.9, r1, w));
  }
  const c: Polyline = [];
  for (let i = 0; i <= 72; i++) c.push([Math.cos((i / 72) * TAU) * o.inner * 0.9, Math.sin((i / 72) * TAU) * o.inner * 0.9]);
  if (o.inner > 2) out.push(c);
  return out;
}

// ─── Truchet ─────────────────────────────────────────────────────────────────────────────────────────────────
export function truchet(o: { cols: number; rows: number; style: number; seed: number }): Polyline[] {
  const r = rng(o.seed);
  const out: Polyline[] = [];
  const arc = (cx: number, cy: number, a0: number): Polyline => {
    const pts: Polyline = [];
    for (let i = 0; i <= 12; i++) {
      const a = a0 + (i / 12) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * 0.5, cy + Math.sin(a) * 0.5]);
    }
    return pts;
  };
  for (let j = 0; j < o.rows; j++) for (let i = 0; i < o.cols; i++) {
    const flip = r() < 0.5;
    if (o.style === 0) {
      if (flip) { out.push(arc(i, j, 0)); out.push(arc(i + 1, j + 1, Math.PI)); }
      else { out.push(arc(i + 1, j, Math.PI / 2)); out.push(arc(i, j + 1, -Math.PI / 2)); }
    } else if (o.style === 1) {
      out.push(flip ? [[i, j], [i + 1, j + 1]] : [[i + 1, j], [i, j + 1]]);
    } else {
      // Traits médians (croix ou demi-croix), qui se raccordent d'une tuile à l'autre.
      if (flip) out.push([[i + 0.5, j], [i + 0.5, j + 1]]);
      else out.push([[i, j + 0.5], [i + 1, j + 0.5]]);
    }
  }
  return out;
}

// ─── Labyrinthe (parcours en profondeur) ─────────────────────────────────────────────────────────────────────
export function maze(o: { cols: number; rows: number; seed: number }): Polyline[] {
  const r = rng(o.seed);
  const C = o.cols, R = o.rows;
  const seen = new Uint8Array(C * R);
  // Murs : droite et bas de chaque case.
  const right = new Uint8Array(C * R).fill(1), down = new Uint8Array(C * R).fill(1);
  const stack = [0];
  seen[0] = 1;
  while (stack.length) {
    const c = stack[stack.length - 1];
    const x = c % C, y = Math.floor(c / C);
    const nb: [number, number][] = [];
    if (x > 0 && !seen[c - 1]) nb.push([c - 1, 0]);
    if (x < C - 1 && !seen[c + 1]) nb.push([c + 1, 1]);
    if (y > 0 && !seen[c - C]) nb.push([c - C, 2]);
    if (y < R - 1 && !seen[c + C]) nb.push([c + C, 3]);
    if (!nb.length) { stack.pop(); continue; }
    const [n, d] = nb[Math.floor(r() * nb.length)];
    if (d === 0) right[n] = 0;
    else if (d === 1) right[c] = 0;
    else if (d === 2) down[n] = 0;
    else down[c] = 0;
    seen[n] = 1;
    stack.push(n);
  }
  const out: Polyline[] = [];
  // Bord (entrée en haut à gauche, sortie en bas à droite).
  out.push([[1, 0], [C, 0], [C, R - 1]]);
  out.push([[C - 1, R], [0, R], [0, 1]]);
  for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
    const c = y * C + x;
    if (x < C - 1 && right[c]) out.push([[x + 1, y], [x + 1, y + 1]]);
    if (y < R - 1 && down[c]) out.push([[x, y + 1], [x + 1, y + 1]]);
  }
  return out;
}

// ─── Champ de flux (lignes régulièrement espacées, sans croisement) ──────────────────────────────────────────
export function flowField(o: { w: number; h: number; sep: number; scale: number; swirl: number; maxLen: number; seed: number }): Polyline[] {
  const nz = noise2(o.seed);
  const angle = (x: number, y: number) => nz(x / o.scale, y / o.scale) * Math.PI * (1 + o.swirl / 50) + (o.swirl / 100) * Math.atan2(y - o.h / 2, x - o.w / 2);
  const cell = o.sep / 2;
  const gw = Math.ceil(o.w / cell) + 1, gh = Math.ceil(o.h / cell) + 1;
  const grid: P2[][] = Array.from({ length: gw * gh }, () => []);
  const free = (p: P2, d: number) => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const x = gx + i, y = gy + j;
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      for (const q of grid[y * gw + x]) if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < d * d) return false;
    }
    return true;
  };
  const add = (p: P2) => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    if (gx >= 0 && gy >= 0 && gx < gw && gy < gh) grid[gy * gw + gx].push(p);
  };
  const inside = (p: P2) => p[0] >= 0 && p[1] >= 0 && p[0] <= o.w && p[1] <= o.h;
  const step = Math.max(0.2, o.sep / 4);
  const trace = (seed: P2): Polyline | null => {
    if (!inside(seed) || !free(seed, o.sep)) return null;
    const half = (sign: number): P2[] => {
      const pts: P2[] = [];
      let p = seed;
      for (let k = 0; k < (o.maxLen / step) / 2; k++) {
        const a = angle(p[0], p[1]);
        const q: P2 = [p[0] + Math.cos(a) * step * sign, p[1] + Math.sin(a) * step * sign];
        if (!inside(q) || !free(q, o.sep * 0.5)) break;
        pts.push(q);
        p = q;
      }
      return pts;
    };
    const line = [...half(-1).reverse(), seed, ...half(1)];
    if (line.length < 4) return null;
    for (const p of line) add(p);
    return line;
  };
  const out: Polyline[] = [];
  const queue: P2[] = [];
  const first = trace([o.w / 2, o.h / 2]);
  if (first) { out.push(first); queue.push(...first); }
  // Graines à côté des lignes déjà tracées (méthode de Jobard et Lefer).
  while (queue.length && out.length < 4000) {
    const p = queue.shift()!;
    const a = angle(p[0], p[1]) + Math.PI / 2;
    for (const s of [1, -1]) {
      const l = trace([p[0] + Math.cos(a) * o.sep * s, p[1] + Math.sin(a) * o.sep * s]);
      if (l) { out.push(l); for (let i = 0; i < l.length; i += 2) queue.push(l[i]); }
    }
  }
  // Zones restées vides : graines en grille.
  for (let y = o.sep / 2; y < o.h; y += o.sep * 2) for (let x = o.sep / 2; x < o.w; x += o.sep * 2) {
    const l = trace([x, y]);
    if (l) out.push(l);
  }
  return out;
}

// ─── Harmonographe (pendules amortis) ────────────────────────────────────────────────────────────────────────
export function harmonograph(o: { f1: number; f2: number; f3: number; f4: number; damping: number; phase: number; length: number; seed: number }): Polyline[] {
  const r = rng(o.seed);
  const p = [r() * TAU, r() * TAU + (o.phase * Math.PI) / 180, r() * TAU, r() * TAU];
  const pts: Polyline = [];
  const n = Math.min(20_000, Math.round(o.length * 120));
  const d = o.damping * 0.0004;
  for (let i = 0; i < n; i++) {
    const t = i * 0.02;
    const e = Math.exp(-d * t);
    pts.push([
      (Math.sin(o.f1 * t + p[0]) + Math.sin(o.f2 * t + p[1])) * e * 50,
      (Math.sin(o.f3 * t + p[2]) + Math.sin(o.f4 * t + p[3])) * e * 50,
    ]);
  }
  return [pts];
}

// ─── Ondes (lignes empilées, faces cachées : aucune ne croise celle de devant) ───────────────────────────────
export function waves(o: { w: number; h: number; lines: number; amp: number; scale: number; peak: number; seed: number }): Polyline[] {
  const nz = noise2(o.seed);
  const out: Polyline[] = [];
  const cols = 240;
  const horizon = new Float32Array(cols + 1).fill(Infinity);
  // De l'avant (bas) vers l'arrière : chaque ligne n'est tracée qu'au-dessus de l'horizon des précédentes.
  for (let k = o.lines - 1; k >= 0; k--) {
    const base = (o.h * (k + 1)) / (o.lines + 1);
    let cur: Polyline = [];
    for (let i = 0; i <= cols; i++) {
      const x = (o.w * i) / cols;
      const mid = 1 - Math.min(1, Math.abs(x - o.w / 2) / (o.w * 0.35));
      const bump = (nz(x / o.scale, k * 0.35) * 0.5 + 0.5) * (0.25 + (o.peak / 100) * mid * mid * 2);
      const y = base - bump * o.amp;
      if (y < horizon[i]) {
        cur.push([x, y]);
        horizon[i] = y;
      } else if (cur.length) {
        if (cur.length >= 2) out.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 2) out.push(cur);
  }
  return out;
}

// ─── Motif répété ────────────────────────────────────────────────────────────────────────────────────────────
export const TILE_SHAPES = ["Cercle", "Polygone", "Étoile", "Pétale", "Goutte", "Cœur", "Croix", "Vague"] as const;
export const REPEATS = ["Grille", "Quinconce", "Hexagones", "Rotation (rosace)", "Miroir", "Anneaux"] as const;

/** Tuile de base, centrée en 0, rayon ≈ 1. */
export function tileShape(kind: number, sides: number, inner: number): Polyline[] {
  const ring = (f: (t: number) => P2, n = 96): Polyline => Array.from({ length: n + 1 }, (_, i) => f((i / n) * TAU));
  switch (kind) {
    case 0: return [ring((t) => [Math.cos(t), Math.sin(t)])];
    case 1: return [ring((t) => { const k = Math.round((t / TAU) * sides) % sides; const a = (k / sides) * TAU - Math.PI / 2; return [Math.cos(a), Math.sin(a)]; }, sides)];
    case 2: {
      const pts: Polyline = [];
      for (let i = 0; i <= sides * 2; i++) {
        const a = (i / (sides * 2)) * TAU - Math.PI / 2, rr = i % 2 ? inner : 1;
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
      return [pts];
    }
    case 3: return [ring((t) => { const s = Math.sin(t / 2); return [Math.cos(t) * 0.5 * (1 + inner) + 0.0, Math.sin(t) * s * s * 0.9]; })];
    case 4: return [ring((t) => [Math.sin(t) * (1 - Math.cos(t)) * 0.5 * (0.6 + inner), -Math.cos(t)])];
    case 5: return [ring((t) => [Math.pow(Math.sin(t), 3), -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16])];
    case 6: return [[[-1, 0], [1, 0]], [[0, -1], [0, 1]]];
    default: return [Array.from({ length: 49 }, (_, i) => [-1 + (i / 48) * 2, Math.sin((i / 48) * TAU * Math.max(1, sides / 2)) * inner * 0.8] as P2)];
  }
}

export type RepeatOpts = {
  shape: number; sides: number; inner: number; size: number; repeat: number; count: number; rings: number;
  gapX: number; gapY: number; rotate: number; rotStep: number; scaleStep: number; nested: number; w: number; h: number;
};

/** Répète la tuile. `size` en mm (diamètre), écarts en mm, rotations en degrés, `scaleStep` en % par pas. */
export function repeatTiles(o: RepeatOpts): Polyline[] {
  const base: Polyline[] = [];
  for (let k = 0; k < Math.max(1, o.nested); k++) {
    const s = 1 - k / Math.max(1, o.nested);
    for (const l of tileShape(o.shape, o.sides, o.inner)) base.push(l.map(([x, y]) => [x * s, y * s] as P2));
  }
  const out: Polyline[] = [];
  const put = (cx: number, cy: number, scale: number, rotDeg: number, mirror = false) => {
    const a = (rotDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), r = (o.size / 2) * scale;
    for (const l of base) out.push(l.map(([x, y]) => { const mx = mirror ? -x : x; return [cx + (mx * c - y * s) * r, cy + (mx * s + y * c) * r] as P2; }));
  };
  const stepX = o.size + o.gapX, stepY = o.size + o.gapY;
  const cols = Math.max(1, Math.floor((o.w + o.gapX) / stepX)), rows = Math.max(1, Math.floor((o.h + o.gapY) / stepY));
  const sc = (i: number) => Math.max(0.05, 1 + (o.scaleStep / 100) * i);
  switch (o.repeat) {
    case 0: case 1: case 4:
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const shift = o.repeat === 1 && j % 2 ? stepX / 2 : 0;
        if (o.repeat === 1 && j % 2 && i === cols - 1) continue;
        const ox = (o.w - (cols - 1) * stepX) / 2, oy = (o.h - (rows - 1) * stepY) / 2;
        const mirror = o.repeat === 4 && (i + j) % 2 === 1;
        put(ox + i * stepX + shift, oy + j * stepY, sc(i + j), o.rotate + o.rotStep * (i + j), mirror);
      }
      break;
    case 2: {
      const hx = stepX, hy = stepY * Math.sqrt(3) / 2;
      const hc = Math.max(1, Math.floor(o.w / hx)), hr = Math.max(1, Math.floor(o.h / hy));
      for (let j = 0; j < hr; j++) for (let i = 0; i < hc - (j % 2); i++)
        put((o.w - (hc - 1) * hx) / 2 + i * hx + (j % 2 ? hx / 2 : 0), (o.h - (hr - 1) * hy) / 2 + j * hy, sc(i + j), o.rotate + o.rotStep * (i + j));
      break;
    }
    case 3: {
      const R = Math.min(o.w, o.h) / 2 - o.size / 2;
      for (let k = 0; k < o.count; k++) {
        const a = (k / o.count) * 360;
        const rad = (a * Math.PI) / 180;
        put(o.w / 2 + Math.cos(rad) * R * 0.6, o.h / 2 + Math.sin(rad) * R * 0.6, sc(k), a + o.rotate + o.rotStep * k);
      }
      break;
    }
    default: {
      const R = Math.min(o.w, o.h) / 2 - o.size / 2;
      for (let ring = 0; ring < Math.max(1, o.rings); ring++) {
        const rr = o.rings === 1 ? R : (R * (ring + 1)) / o.rings;
        const n = Math.max(3, Math.round((TAU * rr) / stepX));
        for (let k = 0; k < n; k++) {
          const a = (k / n) * 360 + (ring % 2 ? 180 / n : 0);
          const rad = (a * Math.PI) / 180;
          put(o.w / 2 + Math.cos(rad) * rr, o.h / 2 + Math.sin(rad) * rr, sc(ring), a + o.rotate + o.rotStep * ring);
        }
      }
    }
  }
  return out;
}
