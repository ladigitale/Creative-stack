import type { Pt, Ring } from "./geometry";

/**
 * Lecture / écriture de chemins SVG (attribut `d`) : M L H V C S Q T A Z, absolus et relatifs.
 * Les arcs sont convertis en courbes cubiques. Limites de taille pour les documents non fiables.
 */

export type Seg =
  | { t: "M"; p: Pt }
  | { t: "L"; p: Pt }
  | { t: "C"; c1: Pt; c2: Pt; p: Pt }
  | { t: "Q"; c: Pt; p: Pt }
  | { t: "Z" };

export const MAX_PATH_CHARS = 400_000;
export const MAX_SEGMENTS = 100_000;

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

type Tok = string | number;

function tokenize(d: string): Tok[] | null {
  const out: Tok[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)/y;
  let i = 0;
  while (i < d.length) {
    re.lastIndex = i;
    const m = re.exec(d);
    if (!m) return null;
    i = re.lastIndex;
    if (m[1]) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
    if (out.length > MAX_SEGMENTS * 8) return null;
  }
  return out;
}

/** Arc SVG (paramétrage par extrémités) → courbes cubiques. */
function arcToCubics(p0: Pt, rx: number, ry: number, rot: number, large: boolean, sweep: boolean, p1: Pt): Seg[] {
  if (rx === 0 || ry === 0 || (p0[0] === p1[0] && p0[1] === p1[1])) return [{ t: "L", p: p1 }];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rot * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (k * rx * y1) / ry, cyp = (-k * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (p0[0] + p1[0]) / 2, cy = sin * cxp + cos * cyp + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dth = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  else if (sweep && dth < 0) dth += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
  const step = dth / n;
  const t = (4 / 3) * Math.tan(step / 4);
  const out: Seg[] = [];
  let a = th1;
  const pt = (th: number): Pt => [cx + rx * Math.cos(th) * cos - ry * Math.sin(th) * sin, cy + rx * Math.cos(th) * sin + ry * Math.sin(th) * cos];
  const dpt = (th: number): Pt => [-rx * Math.sin(th) * cos - ry * Math.cos(th) * sin, -rx * Math.sin(th) * sin + ry * Math.cos(th) * cos];
  for (let i = 0; i < n; i++) {
    const b = a + step;
    const pa = pt(a), pb = i === n - 1 ? p1 : pt(b), da = dpt(a), db = dpt(b);
    out.push({ t: "C", c1: [pa[0] + t * da[0], pa[1] + t * da[1]], c2: [pb[0] - t * db[0], pb[1] - t * db[1]], p: pb });
    a = b;
  }
  return out;
}

/** Lit un chemin ; `null` si la syntaxe est invalide ou trop volumineuse. */
export function parsePath(d: string): Seg[] | null {
  if (typeof d !== "string" || d.length > MAX_PATH_CHARS) return null;
  const toks = tokenize(d);
  if (!toks) return null;
  const segs: Seg[] = [];
  let i = 0;
  let cmd = "";
  let cur: Pt = [0, 0], start: Pt = [0, 0];
  let lastC: Pt | null = null, lastQ: Pt | null = null;
  const num = (): number => {
    const v = toks[i++];
    if (typeof v !== "number") throw new Error("nombre attendu");
    return v;
  };
  try {
    while (i < toks.length) {
      const tk = toks[i];
      if (typeof tk === "string") {
        cmd = tk;
        i++;
        if (cmd === "Z" || cmd === "z") {
          segs.push({ t: "Z" });
          cur = start;
          lastC = lastQ = null;
          continue;
        }
      } else if (!cmd || cmd === "Z" || cmd === "z") return null;
      const up = cmd.toUpperCase();
      const rel = cmd !== up;
      const need = ARGS[up];
      if (need === undefined) return null;
      const ox = rel ? cur[0] : 0, oy = rel ? cur[1] : 0;
      if (segs.length === 0 && up !== "M") return null;
      let nextC: Pt | null = null, nextQ: Pt | null = null;
      if (up === "M") {
        const p: Pt = [num() + ox, num() + oy];
        segs.push({ t: "M", p });
        cur = start = p;
        cmd = rel ? "l" : "L";
      } else if (up === "L") {
        const p: Pt = [num() + ox, num() + oy];
        segs.push({ t: "L", p });
        cur = p;
      } else if (up === "H") {
        const p: Pt = [num() + ox, cur[1]];
        segs.push({ t: "L", p });
        cur = p;
      } else if (up === "V") {
        const p: Pt = [cur[0], num() + oy];
        segs.push({ t: "L", p });
        cur = p;
      } else if (up === "C") {
        const c1: Pt = [num() + ox, num() + oy], c2: Pt = [num() + ox, num() + oy], p: Pt = [num() + ox, num() + oy];
        segs.push({ t: "C", c1, c2, p });
        cur = p;
        nextC = c2;
      } else if (up === "S") {
        const c1: Pt = lastC ? [2 * cur[0] - lastC[0], 2 * cur[1] - lastC[1]] : cur;
        const c2: Pt = [num() + ox, num() + oy], p: Pt = [num() + ox, num() + oy];
        segs.push({ t: "C", c1, c2, p });
        cur = p;
        nextC = c2;
      } else if (up === "Q") {
        const c: Pt = [num() + ox, num() + oy], p: Pt = [num() + ox, num() + oy];
        segs.push({ t: "Q", c, p });
        cur = p;
        nextQ = c;
      } else if (up === "T") {
        const c: Pt = lastQ ? [2 * cur[0] - lastQ[0], 2 * cur[1] - lastQ[1]] : cur;
        const p: Pt = [num() + ox, num() + oy];
        segs.push({ t: "Q", c, p });
        cur = p;
        nextQ = c;
      } else if (up === "A") {
        const rx = num(), ry = num(), rot = num(), large = num() !== 0, sweep = num() !== 0;
        const p: Pt = [num() + ox, num() + oy];
        segs.push(...arcToCubics(cur, rx, ry, rot, large, sweep, p));
        cur = p;
      }
      lastC = nextC;
      lastQ = nextQ;
      if (segs.length > MAX_SEGMENTS) return null;
    }
  } catch {
    return null;
  }
  return segs;
}

const f = (n: number) => String(+n.toFixed(3));
const pt = (p: Pt) => `${f(p[0])},${f(p[1])}`;

export function serializePath(segs: Seg[]): string {
  return segs
    .map((s) => (s.t === "Z" ? "Z" : s.t === "M" ? `M${pt(s.p)}` : s.t === "L" ? `L${pt(s.p)}` : s.t === "Q" ? `Q${pt(s.c)} ${pt(s.p)}` : `C${pt(s.c1)} ${pt(s.c2)} ${pt(s.p)}`))
    .join("");
}

const mid = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Aplati les courbes en segments (écart maximal ≈ `tol`) : un contour par sous-chemin, avec son état fermé. */
export function flatten(segs: Seg[], tol = 0.25): { ring: Ring; closed: boolean }[] {
  const out: { ring: Ring; closed: boolean }[] = [];
  let cur: Ring | null = null;
  let last: Pt = [0, 0], start: Pt = [0, 0];
  const push = () => {
    if (cur && cur.length) out.push({ ring: cur, closed: false });
    cur = null;
  };
  for (const s of segs) {
    if (s.t === "M") {
      push();
      cur = [s.p];
      last = start = s.p;
    } else if (s.t === "Z") {
      if (cur) {
        out.push({ ring: cur, closed: true });
        cur = null;
      }
      last = start;
    } else {
      if (!cur) cur = [last];
      if (s.t === "L") cur.push(s.p);
      else {
        const [p0, c1, c2, p1] = s.t === "Q" ? [last, mid(last, s.c, 2 / 3), mid(s.p, s.c, 2 / 3), s.p] : [last, s.c1, s.c2, s.p];
        // nombre de pas selon la « planéité » : distance des contrôles à la corde
        const dev = Math.max(Math.hypot(c1[0] - p0[0] - (p1[0] - p0[0]) / 3, c1[1] - p0[1] - (p1[1] - p0[1]) / 3), Math.hypot(c2[0] - p0[0] - (2 * (p1[0] - p0[0])) / 3, c2[1] - p0[1] - (2 * (p1[1] - p0[1])) / 3));
        const n = Math.min(64, Math.max(2, Math.ceil(Math.sqrt(dev / Math.max(tol, 1e-6)) * 1.6) + 1));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          cur.push([u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0], u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]]);
        }
      }
      last = s.p;
    }
  }
  push();
  return out;
}

/** Contours fermés → chemin (segments droits). */
export function ringsToPath(rings: Ring[]): string {
  return rings
    .filter((r) => r.length >= 2)
    .map((r) => `M${r.map(pt).join("L")}Z`)
    .join("");
}
