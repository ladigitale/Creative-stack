/**
 * Grilles hexagonales en coordonnées axiales `[q, r]` (Red Blob Games) : distance, voisins, anneaux, zones, lignes,
 * conversions vers et depuis les pixels (`pointy` : pointe en haut, `flat` : côté en haut).
 */
export type Hex = [number, number];

export const HEX_DIRS: Hex[] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

export function hexDistance(a: Hex, b: Hex): number {
  const dq = a[0] - b[0], dr = a[1] - b[1];
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hexNeighbors(h: Hex): Hex[] {
  return HEX_DIRS.map(([dq, dr]) => [h[0] + dq, h[1] + dr]);
}

export function hexRound(q: number, r: number): Hex {
  const s = -q - r;
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq + 0, rr + 0];
}

export function hexRing(c: Hex, radius: number): Hex[] {
  const n = Math.max(0, Math.min(200, Math.floor(radius)));
  if (n === 0) return [[c[0], c[1]]];
  const out: Hex[] = [];
  let h: Hex = [c[0] + HEX_DIRS[4][0] * n, c[1] + HEX_DIRS[4][1] * n];
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < n; j++) {
      out.push(h);
      h = [h[0] + HEX_DIRS[i][0], h[1] + HEX_DIRS[i][1]];
    }
  return out;
}

/** Toutes les cases à distance ≤ `radius`, centre compris (spirale). */
export function hexRange(c: Hex, radius: number): Hex[] {
  const n = Math.max(0, Math.min(200, Math.floor(radius)));
  const out: Hex[] = [];
  for (let k = 0; k <= n; k++) out.push(...hexRing(c, k));
  return out;
}

export function hexLine(a: Hex, b: Hex): Hex[] {
  const n = hexDistance(a, b);
  const out: Hex[] = [];
  // léger décalage pour ne pas tomber pile sur une arête
  const aq = a[0] + 1e-6, ar = a[1] + 1e-6, bq = b[0] + 1e-6, br = b[1] + 1e-6;
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    out.push(hexRound(aq + (bq - aq) * t, ar + (br - ar) * t));
  }
  return out;
}

export function hexToPixel(h: Hex, size: number, orient: "pointy" | "flat" = "pointy"): [number, number] {
  const [q, r] = h;
  return orient === "flat"
    ? [size * 1.5 * q, size * Math.sqrt(3) * (r + q / 2)]
    : [size * Math.sqrt(3) * (q + r / 2), size * 1.5 * r];
}

export function hexFromPixel(p: [number, number], size: number, orient: "pointy" | "flat" = "pointy"): Hex {
  const [x, y] = p;
  return orient === "flat"
    ? hexRound((2 / 3) * x / size, (-x / 3 + (Math.sqrt(3) / 3) * y) / size)
    : hexRound(((Math.sqrt(3) / 3) * x - y / 3) / size, ((2 / 3) * y) / size);
}
