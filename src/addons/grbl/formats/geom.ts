/**
 * Géométrie commune des importeurs : chemins (déplacement, ligne, cubique, fermeture), matrices affines 2D,
 * arcs en cubiques, et écriture d'un SVG en millimètres réels lu ensuite par `sonic-gcode` (`svg-from`).
 *
 * Les formats de CAO et d'impression (DXF, HPGL, PDF, PostScript, LightBurn) ont l'axe Y vers le haut :
 * le constructeur le retourne à l'écriture (`yUp`).
 */

/** Matrice affine [a, b, c, d, e, f] : x' = a x + c y + e, y' = b x + d y + f (convention PDF / SVG). */
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export const rotate = (deg: number): Mat => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, 0, 0];
};
export const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const isFiniteMat = (m: Mat) => m.every(Number.isFinite);

export type Seg = { t: "M" | "L"; x: number; y: number } | { t: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number } | { t: "Z" };

/** Chemin en construction, en coordonnées finales (matrice déjà appliquée). */
export class PathBuilder {
  segs: Seg[] = [];
  private cx = 0;
  private cy = 0;
  private sx = 0;
  private sy = 0;
  private open = false;

  get current(): [number, number] | null {
    return this.open || this.segs.length ? [this.cx, this.cy] : null;
  }
  moveTo(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const last = this.segs[this.segs.length - 1];
    if (last && last.t === "M") this.segs.pop();
    this.segs.push({ t: "M", x, y });
    this.cx = this.sx = x;
    this.cy = this.sy = y;
    this.open = true;
  }
  lineTo(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!this.open) return this.moveTo(x, y);
    this.segs.push({ t: "L", x, y });
    this.cx = x;
    this.cy = y;
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    if (![x1, y1, x2, y2, x, y].every(Number.isFinite)) return;
    if (!this.open) this.moveTo(this.cx, this.cy);
    this.segs.push({ t: "C", x1, y1, x2, y2, x, y });
    this.cx = x;
    this.cy = y;
  }
  close(): void {
    if (!this.open) return;
    const last = this.segs[this.segs.length - 1];
    if (last && last.t !== "Z" && last.t !== "M") this.segs.push({ t: "Z" });
    this.cx = this.sx;
    this.cy = this.sy;
  }
  get empty(): boolean {
    return !this.segs.some((s) => s.t === "L" || s.t === "C");
  }
  clear(): void {
    this.segs = [];
    this.open = false;
  }
  take(): Seg[] {
    const s = this.segs;
    this.segs = [];
    this.open = false;
    return s;
  }
}

/**
 * Arc de cercle (ou d'ellipse) en cubiques, dans le repère local puis transformé par `m`.
 * Angles en radians, `a1` vers `a2` (sens trigonométrique si `a2 > a1`).
 */
export function arcSegs(cx: number, cy: number, rx: number, ry: number, a1: number, a2: number, m: Mat = IDENTITY, rot = 0): { start: [number, number]; curves: [number, number, number, number, number, number][] } {
  const total = a2 - a1;
  const n = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2) - 1e-9));
  const step = total / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const pt = (a: number, dx = 0, dy = 0): [number, number] => {
    const lx = rx * Math.cos(a) + dx, ly = ry * Math.sin(a) + dy;
    return apply(m, cx + lx * cr - ly * sr, cy + lx * sr + ly * cr);
  };
  const curves: [number, number, number, number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const s = a1 + i * step, e = s + step;
    const p1 = pt(s, -k * rx * Math.sin(s), k * ry * Math.cos(s));
    const p2 = pt(e, k * rx * Math.sin(e), -k * ry * Math.cos(e));
    const p3 = pt(e);
    curves.push([p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]]);
  }
  return { start: pt(a1), curves };
}

/** Ajoute un arc au chemin (ligne jusqu'à son départ si un point courant existe, sinon déplacement). */
export function addArc(p: PathBuilder, cx: number, cy: number, rx: number, ry: number, a1: number, a2: number, m: Mat = IDENTITY, rot = 0, move = false): void {
  const { start, curves } = arcSegs(cx, cy, rx, ry, a1, a2, m, rot);
  if (move || !p.current) p.moveTo(start[0], start[1]);
  else p.lineTo(start[0], start[1]);
  for (const c of curves) p.curveTo(...c);
}

/** Arc défini par un renflement (« bulge » DXF) entre deux points : tan(angle/4). */
export function addBulge(p: PathBuilder, x0: number, y0: number, x1: number, y1: number, bulge: number, m: Mat): void {
  if (!bulge || Math.abs(bulge) < 1e-9) {
    const q = apply(m, x1, y1);
    p.lineTo(q[0], q[1]);
    return;
  }
  const theta = 4 * Math.atan(bulge);
  const dx = x1 - x0, dy = y1 - y0;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return;
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const sgn = (bulge > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const cx = mx - (sgn * h * dy) / chord, cy = my + (sgn * h * dx) / chord;
  const a1 = Math.atan2(y0 - cy, x0 - cx);
  const a2 = a1 + theta;
  const { curves } = arcSegs(cx, cy, r, r, a1, a2, m);
  for (const c of curves) p.curveTo(...c);
}

export type Shape = { segs: Seg[]; stroke?: string | null; fill?: string | null; evenOdd?: boolean };

/** Couleur RVB 0..1 → `#rrggbb`. */
export function hex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
export const cmyk = (c: number, m: number, y: number, k: number) => hex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

const fmt = (v: number): string => {
  const s = (Math.round(v * 1000) / 1000).toString();
  return s === "-0" ? "0" : s;
};

/** Plus de formes que ça : le dessin est trop lourd pour être préparé dans le navigateur. */
export const MAX_SHAPES = 200_000;
/** Taille au-delà de laquelle le SVG produit ne passerait plus par `svg-from` (texte). */
export const MAX_SVG_OUT = 4_000_000;

export type SvgOut = { svg: string; widthMm: number; heightMm: number; shapes: number; colors: string[] };

/**
 * Écrit les formes (coordonnées en unités du fichier × `unitMm`) en SVG millimétré.
 * `yUp` : l'axe Y du fichier monte (retourné à l'écriture). `page` : cadre du document (sinon l'emprise).
 */
export function writeSvg(shapes: Shape[], opts: { unitMm: number; yUp: boolean; page?: { x: number; y: number; w: number; h: number } | null }): SvgOut | null {
  const k = opts.unitMm;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const kept = shapes.filter((s) => s.segs.some((g) => g.t === "L" || g.t === "C") && (s.stroke || s.fill));
  if (!kept.length) return null;
  for (const s of kept) for (const g of s.segs) if (g.t !== "Z") see(g.x, g.y);
  // Cubiques : leurs points de contrôle restent dans l'emprise d'une marge raisonnable ; seuls les extrémités comptent.
  let box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  // Cadre de page (PDF, EPS) : gardé s'il contient le dessin (placement d'origine, `frame="document"`).
  const pg = opts.page;
  if (pg && pg.w > 0 && pg.h > 0) {
    const tol = Math.max(pg.w, pg.h) * 0.01;
    if (minX >= pg.x - tol && minY >= pg.y - tol && maxX <= pg.x + pg.w + tol && maxY <= pg.y + pg.h + tol) box = pg;
  }
  const ty = (y: number) => (opts.yUp ? box.y + box.h - y : y - box.y);
  const tx = (x: number) => x - box.x;
  const colors = new Set<string>();
  const parts: string[] = [];
  for (const s of kept) {
    let d = "";
    for (const g of s.segs) {
      if (g.t === "Z") d += "Z";
      else if (g.t === "C") d += `C${fmt(tx(g.x1) * k)} ${fmt(ty(g.y1) * k)} ${fmt(tx(g.x2) * k)} ${fmt(ty(g.y2) * k)} ${fmt(tx(g.x) * k)} ${fmt(ty(g.y) * k)}`;
      else d += `${g.t}${fmt(tx(g.x) * k)} ${fmt(ty(g.y) * k)}`;
    }
    const fill = s.fill ?? "none";
    const stroke = s.stroke ?? "none";
    if (s.fill) colors.add(s.fill);
    if (s.stroke) colors.add(s.stroke);
    parts.push(`<path d="${d}" fill="${fill}"${s.fill && s.evenOdd ? ' fill-rule="evenodd"' : ""} stroke="${stroke}"${s.stroke ? ' stroke-width="0.1"' : ""}/>`);
  }
  const w = Math.max(box.w * k, 0.001), h = Math.max(box.h * k, 0.001);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w)}mm" height="${fmt(h)}mm" viewBox="0 0 ${fmt(w)} ${fmt(h)}">${parts.join("")}</svg>`;
  return { svg, widthMm: Math.round(w * 100) / 100, heightMm: Math.round(h * 100) / 100, shapes: kept.length, colors: [...colors] };
}

/** Compte d'éléments ignorés, par nature. */
export class Skips {
  readonly counts: Record<string, number> = {};
  add(kind: string, n = 1): void {
    this.counts[kind] = (this.counts[kind] ?? 0) + n;
  }
}
