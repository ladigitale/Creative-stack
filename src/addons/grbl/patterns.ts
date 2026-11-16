/**
 * Modèles paramétriques pour la découpe et la gravure laser : chaque modèle produit un SVG en millimètres réels
 * (noir = gravure, bleu = marquage, rouge = découpe) et, pour la grille d'essais, ses propres réglages par
 * couleur. Fonctions pures, testées sans DOM.
 */
import type { LaserOp } from "./toolpath";

export const ENGRAVE = "#16130f";
export const MARK = "#2563eb";
export const CUT = "#e11d48";

type Pt = [number, number];
export type Pattern = { svg: string; widthMm: number; heightMm: number; ops?: LaserOp[]; notes: string[] };
export type ParamSpec = { key: string; label: string; min: number; max: number; step: number; default: number; unit?: string };
export type PatternDef = { id: string; label: string; description: string; params: ParamSpec[]; build: (p: Record<string, number>) => Pattern };

const f = (v: number): string => {
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

const svgDoc = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}mm" height="${f(h)}mm" viewBox="0 0 ${f(w)} ${f(h)}">${body}</svg>`;
const line = (d: string, color = CUT) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="0.2"/>`;
const fill = (d: string, rule: "nonzero" | "evenodd" = "nonzero") => `<path d="${d}" fill="${ENGRAVE}" fill-rule="${rule}"/>`;
const circle = (cx: number, cy: number, r: number, color = CUT) =>
  `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${color}" stroke-width="0.2"/>`;
const poly = (pts: Pt[], close = true) => "M" + pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L") + (close ? " Z" : "");

export function heartPath(cx: number, cy: number, s: number): string {
  return `M${f(cx)} ${f(cy + s * 0.55)} C${f(cx - s * 0.9)} ${f(cy - s * 0.05)} ${f(cx - s * 0.55)} ${f(cy - s * 0.75)} ${f(cx)} ${f(cy - s * 0.35)} ` +
    `C${f(cx + s * 0.55)} ${f(cy - s * 0.75)} ${f(cx + s * 0.9)} ${f(cy - s * 0.05)} ${f(cx)} ${f(cy + s * 0.55)} Z`;
}

export function starPath(cx: number, cy: number, r1: number, r2: number, n = 5, rot = -90): string {
  const pts: Pt[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = ((rot + (i * 180) / n) * Math.PI) / 180;
    const r = i % 2 === 0 ? r1 : r2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return poly(pts);
}

const ringPath = (cx: number, cy: number, r: number) =>
  `M${f(cx - r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)} A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)} Z`;

export function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = clamp(r, 0, Math.min(w, h) / 2);
  if (!rr) return `M${f(x)} ${f(y)} H${f(x + w)} V${f(y + h)} H${f(x)} Z`;
  return `M${f(x + rr)} ${f(y)} H${f(x + w - rr)} A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w)} ${f(y + rr)} V${f(y + h - rr)} A${f(rr)} ${f(rr)} 0 0 1 ${f(x + w - rr)} ${f(y + h)} ` +
    `H${f(x + rr)} A${f(rr)} ${f(rr)} 0 0 1 ${f(x)} ${f(y + h - rr)} V${f(y + rr)} A${f(rr)} ${f(rr)} 0 0 1 ${f(x + rr)} ${f(y)} Z`;
}

/** Motif décoratif gravé, centré, de taille `s` : 0 aucun, 1 cœur, 2 étoile, 3 fleur, 4 rosace. */
function motif(kind: number, cx: number, cy: number, s: number): string {
  switch (Math.round(kind)) {
    case 1: return fill(heartPath(cx, cy, s));
    case 2: return fill(starPath(cx, cy, s * 0.55, s * 0.23));
    case 3: return fill(flowerPath(cx, cy, s * 0.5, 6));
    case 4: return fill(rosette(cx, cy, s * 0.5));
    default: return "";
  }
}

function flowerPath(cx: number, cy: number, r: number, n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    const tip: Pt = [cx + ux * r, cy + uy * r];
    const w = r * 0.38;
    const m1: Pt = [cx + ux * r * 0.55 + px * w, cy + uy * r * 0.55 + py * w];
    const m2: Pt = [cx + ux * r * 0.55 - px * w, cy + uy * r * 0.55 - py * w];
    parts.push(`M${f(cx + ux * r * 0.18)} ${f(cy + uy * r * 0.18)} Q${f(m1[0])} ${f(m1[1])} ${f(tip[0])} ${f(tip[1])} Q${f(m2[0])} ${f(m2[1])} ${f(cx + ux * r * 0.18)} ${f(cy + uy * r * 0.18)} Z`);
  }
  parts.push(ringPath(cx, cy, r * 0.15));
  return parts.join(" ");
}

function rosette(cx: number, cy: number, r: number): string {
  const parts: string[] = [];
  const rings: [number, number, number, number][] = [[8, 0.15, 0.55, 0.14], [16, 0.6, 0.98, 0.09]];
  rings.forEach(([n, r0, r1, wd], k) => {
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n + (k ? Math.PI / n : 0);
      const ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
      const p0: Pt = [cx + ux * r0 * r, cy + uy * r0 * r], p1: Pt = [cx + ux * r1 * r, cy + uy * r1 * r];
      const mid = ((r0 + r1) / 2) * r;
      parts.push(`M${f(p0[0])} ${f(p0[1])} Q${f(cx + ux * mid + px * wd * r)} ${f(cy + uy * mid + py * wd * r)} ${f(p1[0])} ${f(p1[1])} ` +
        `Q${f(cx + ux * mid - px * wd * r)} ${f(cy + uy * mid - py * wd * r)} ${f(p0[0])} ${f(p0[1])} Z`);
    }
  });
  parts.push(ringPath(cx, cy, r * 0.1));
  return parts.join(" ");
}

// ─── Boîte à encoches ─────────────────────────────────────────────────────────────────────────────────────────────
/** Bord à créneaux de a vers b : `n` segments (impair), les segments impairs sortent (`out` = +1) ou rentrent (−1). */
function fingerEdge(a: Pt, b: Pt, n: number, out: number, t: number): Pt[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const nx = uy * out, ny = -ux * out;
  const seg = L / n;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p: Pt = [a[0] + ux * seg * i, a[1] + uy * seg * i];
    const q: Pt = [a[0] + ux * seg * (i + 1), a[1] + uy * seg * (i + 1)];
    if (i % 2 === 1 && out !== 0) pts.push(p, [p[0] + nx * t, p[1] + ny * t], [q[0] + nx * t, q[1] + ny * t], q);
    else pts.push(p, q);
  }
  return pts;
}

/** Panneau rectangulaire à encoches ; `tabs` = (haut, droite, bas, gauche) : +1 dents, −1 creux, 0 lisse. */
function panel(x: number, y: number, w: number, h: number, nw: number, nh: number, t: number, tabs: [number, number, number, number]): string {
  const c: Pt[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const counts = [nw, nh, nw, nh];
  const pts: Pt[] = [];
  for (let k = 0; k < 4; k++) pts.push(...fingerEdge(c[k], c[(k + 1) % 4], counts[k], tabs[k], t));
  const clean = pts.filter((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) > 1e-6 || Math.abs(p[1] - pts[i - 1][1]) > 1e-6);
  return line(poly(clean));
}

/** Nombre impair de créneaux d'environ `size` mm sur une longueur (3 au moins). */
const fingers = (len: number, size: number) => {
  const n = Math.max(3, Math.round(len / Math.max(size, 2)));
  return n % 2 ? n : n + 1;
};

function box(p: Record<string, number>): Pattern {
  const W = p.largeur, D = p.profondeur, H = p.hauteur, t = p.epaisseur, gap = 5;
  const nw = fingers(W, p.creneau), nd = fingers(D, p.creneau), nh = fingers(H, p.creneau);
  const lid = p.couvercle >= 0.5;
  let body = "";
  const x0 = t + 1;
  let y = t + 1;
  body += panel(x0, y, W, D, nw, nd, t, [1, 1, 1, 1]);
  if (lid) {
    body += panel(x0 + W + 2 * t + gap, y, W, D, nw, nd, t, [1, 1, 1, 1]);
    body += motif(p.motif, x0 + W + 2 * t + gap + W / 2, y + D / 2, Math.min(W, D) * 0.45);
  }
  y += D + 2 * t + gap;
  // Façades : creux en bas (et en haut avec couvercle), dents sur les côtés.
  const top = lid ? -1 : 0;
  body += panel(x0, y, W, H, nw, nh, t, [top, 1, -1, 1]);
  body += panel(x0 + W + 2 * t + gap, y, W, H, nw, nh, t, [top, 1, -1, 1]);
  y += H + 2 * t + gap;
  body += panel(x0, y, D, H, nd, nh, t, [top, -1, -1, -1]);
  body += panel(x0 + D + 2 * t + gap, y, D, H, nd, nh, t, [top, -1, -1, -1]);
  const width = Math.max(2 * (W + 2 * t) + gap, 2 * (D + 2 * t) + gap) + 2;
  return {
    svg: svgDoc(width, y + H + t + 1, body), widthMm: width, heightMm: y + H + t + 1,
    notes: [`Pour du ${f(t)} mm : mesurez l'épaisseur réelle (contreplaqué « 3 mm » = 2,7 à 3,2 mm) et ajustez avant de découper.`, "Compensez la largeur du trait (onglet Calques) pour un emboîtement serré."],
  };
}

// ─── Engrenages ───────────────────────────────────────────────────────────────────────────────────────────────────
function gearPath(cx: number, cy: number, n: number, m: number): string {
  const rp = (m * n) / 2, ra = rp + m, rd = rp - 1.25 * m;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n, da = (2 * Math.PI) / n;
    for (const [fr, r] of [[0, rd], [0.12, rd], [0.24, ra], [0.38, ra], [0.5, rd], [1, rd]] as [number, number][]) {
      const a = a0 + da * fr;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return poly(pts);
}

function gears(p: Record<string, number>): Pattern {
  const m = p.module, n1 = Math.round(p.dents1), n2 = Math.round(p.dents2);
  const r1 = (m * n1) / 2 + m, r2 = (m * n2) / 2 + m;
  const cx1 = r1 + 2, cy = Math.max(r1, r2) + 2;
  const cx2 = cx1 + (m * (n1 + n2)) / 2 + 0.3;
  let body = line(gearPath(cx1, cy, n1, m)) + circle(cx1, cy, p.axe / 2);
  if (n2 >= 6) body += line(gearPath(cx2, cy, n2, m)) + circle(cx2, cy, p.axe / 2);
  if (p.rayons >= 3 && n1 >= 16) {
    // Évidements entre les rayons de la grande roue.
    const k = Math.round(p.rayons), rIn = p.axe / 2 + 3, rOut = (m * n1) / 2 - 2.2 * m;
    for (let i = 0; i < k; i++) {
      const a0 = (2 * Math.PI * i) / k + 0.22, a1 = (2 * Math.PI * (i + 1)) / k - 0.22;
      if (rOut - rIn < 3 || a1 <= a0) break;
      const P = (r: number, a: number) => `${f(cx1 + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`;
      body += line(`M${P(rIn, a0)} L${P(rOut, a0)} A${f(rOut)} ${f(rOut)} 0 0 1 ${P(rOut, a1)} L${P(rIn, a1)} A${f(rIn)} ${f(rIn)} 0 0 0 ${P(rIn, a0)} Z`);
    }
  }
  const w = (n2 >= 6 ? cx2 + r2 : cx1 + r1) + 2;
  return { svg: svgDoc(w, 2 * cy, body), widthMm: w, heightMm: 2 * cy, notes: [`Entraxe ${f((m * (n1 + n2)) / 2)} mm.`] };
}

// ─── Puzzle ───────────────────────────────────────────────────────────────────────────────────────────────────────
function jigsaw(p: Record<string, number>): Pattern {
  const cols = Math.round(p.colonnes), rows = Math.round(p.lignes), s = p.piece;
  const W = cols * s, H = rows * s;
  let seed = Math.round(p.graine) * 7919 + 13;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tab = (a: Pt, b: Pt, sign: number) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, nx = -uy * sign, ny = ux * sign;
    const j = (rnd() - 0.5) * 0.08;
    const P = (u: number, v: number) => `${f(a[0] + ux * (u + j) * L + nx * v * L)} ${f(a[1] + uy * (u + j) * L + ny * v * L)}`;
    return `M${f(a[0])} ${f(a[1])} L${P(0.36, 0)} C${P(0.42, 0)} ${P(0.38, 0.12)} ${P(0.36, 0.16)} C${P(0.33, 0.24)} ${P(0.42, 0.3)} ${P(0.5, 0.3)} ` +
      `C${P(0.58, 0.3)} ${P(0.67, 0.24)} ${P(0.64, 0.16)} C${P(0.62, 0.12)} ${P(0.58, 0)} ${P(0.64, 0)} L${f(b[0])} ${f(b[1])}`;
  };
  let body = line(roundRect(0.5, 0.5, W - 1, H - 1, p.coins));
  for (let r = 1; r < rows; r++) for (let c = 0; c < cols; c++) body += line(tab([c * s, r * s], [(c + 1) * s, r * s], rnd() > 0.5 ? 1 : -1));
  for (let c = 1; c < cols; c++) for (let r = 0; r < rows; r++) body += line(tab([c * s, r * s], [c * s, (r + 1) * s], rnd() > 0.5 ? 1 : -1));
  body += motif(p.motif, W / 2, H / 2, Math.min(W, H) * 0.6);
  return { svg: svgDoc(W, H, body), widthMm: W, heightMm: H, notes: [`${cols * rows} pièces.`] };
}

// ─── Tampon ───────────────────────────────────────────────────────────────────────────────────────────────────────
function stamp(p: Record<string, number>): Pattern {
  const s = p.taille, m = 2;
  const cx = s / 2, cy = s / 2;
  const shape = Math.round(p.forme);
  const inner = shape === 1 ? heartPath(cx, cy + s * 0.03, s * 0.62) : shape === 2 ? flowerPath(cx, cy, s * 0.36, 6) : starPath(cx, cy, s * 0.33, s * 0.14, Math.round(p.branches));
  const ring = p.anneau >= 0.5 ? ` ${ringPath(cx, cy, s * 0.44)} ${ringPath(cx, cy, s * 0.4)}` : "";
  // Le fond est creusé, le motif reste en relief ; en miroir pour qu'il s'imprime à l'endroit.
  const bg = `M${m} ${m} H${f(s - m)} V${f(s - m)} H${m} Z ${inner}${ring}`;
  const body = fill(bg, "evenodd") + line(roundRect(0.5, 0.5, s - 1, s - 1, 2));
  const mirrored = p.miroir >= 0.5 ? `<g transform="translate(${f(s)} 0) scale(-1 1)">${body}</g>` : body;
  return { svg: svgDoc(s, s, mirrored), widthMm: s, heightMm: s, notes: ["Gravez profond (2 à 4 passes) sur caoutchouc laser ou bois dur."] };
}

// ─── Porte-clés, étiquette, pendentif, dessous de verre ───────────────────────────────────────────────────────────
function keychain(p: Record<string, number>): Pattern {
  const W = p.largeur, H = p.hauteur, r = p.rayon;
  let body = line(roundRect(0.5, 0.5, W - 1, H - 1, r)) + circle(Math.min(r, H / 2) + 2, H / 2, p.trou / 2);
  if (p.bordure >= 0.5) body += line(roundRect(2.5, 2.5, W - 5, H - 5, Math.max(0, r - 2)), MARK);
  const left = Math.min(r, H / 2) + 2 + p.trou / 2 + 3;
  body += motif(p.motif, (left + W) / 2, H / 2, Math.min(H * 0.7, W - left - 4));
  return { svg: svgDoc(W, H, body), widthMm: W, heightMm: H, notes: [] };
}

function pendant(p: Record<string, number>): Pattern {
  const d = p.diametre, r = d / 2, c = r + 0.5;
  let body = circle(c, c, r) + circle(c, c - r + p.trou / 2 + 1.5, p.trou / 2);
  if (p.bordure >= 0.5) body += circle(c, c, r - 3, MARK);
  body += motif(p.motif, c, c + r * 0.06, d * 0.55);
  return { svg: svgDoc(d + 1, d + 1, body), widthMm: d + 1, heightMm: d + 1, notes: [] };
}

function coaster(p: Record<string, number>): Pattern {
  const d = p.diametre, r = d / 2, c = r + 0.5;
  let body = circle(c, c, r);
  for (let i = 0; i < Math.round(p.anneaux); i++) body += circle(c, c, r - 4 - i * 1.5, MARK);
  body += motif(p.motif, c, c, d * 0.75);
  return { svg: svgDoc(d + 1, d + 1, body), widthMm: d + 1, heightMm: d + 1, notes: [] };
}

// ─── Règle ────────────────────────────────────────────────────────────────────────────────────────────────────────
function ruler(p: Record<string, number>): Pattern {
  const L = Math.round(p.longueur), W = L * 10 + 10, H = p.largeur;
  const marks: string[] = [];
  for (let i = 0; i <= L * 10; i++) {
    const h = i % 10 === 0 ? H * 0.34 : i % 5 === 0 ? H * 0.24 : H * 0.14;
    marks.push(`M${f(5 + i)} 1.6 V${f(1.6 + h)}`);
  }
  // Repères gravés : un point plein tous les centimètres, un plus gros tous les 5 cm.
  const dots: string[] = [];
  for (let cm = 1; cm < L; cm++) {
    const r = cm % 5 === 0 ? 0.9 : 0.5;
    dots.push(ringPath(5 + cm * 10, H * 0.62, r));
  }
  const body = line(roundRect(0.5, 0.5, W - 1, H - 1, 2)) + `<path d="${marks.join(" ")}" fill="none" stroke="${MARK}" stroke-width="0.2"/>` + fill(dots.join(" "));
  return { svg: svgDoc(W, H, body), widthMm: W, heightMm: H, notes: [] };
}

// ─── Grille d'essais ──────────────────────────────────────────────────────────────────────────────────────────────
export function gridColor(i: number, j: number): string {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${h(40 + i * 37)}${h(30 + j * 41)}${h(210 - i * 23)}`;
}

function testGrid(p: Record<string, number>): Pattern {
  const nP = Math.round(p.puissances), nV = Math.round(p.vitesses), s = p.case, gap = 2, m = 3;
  const powers = Array.from({ length: nP }, (_, i) => Math.round(p.pmin + ((p.pmax - p.pmin) * i) / Math.max(1, nP - 1)));
  const speeds = Array.from({ length: nV }, (_, j) => Math.round(p.vmax - ((p.vmax - p.vmin) * j) / Math.max(1, nV - 1)));
  const ops: LaserOp[] = [];
  let body = "";
  powers.forEach((pw, i) => speeds.forEach((v, j) => {
    const col = gridColor(i, j);
    body += `<rect x="${f(m + j * (s + gap))}" y="${f(m + i * (s + gap))}" width="${f(s)}" height="${f(s)}" fill="${col}"/>`;
    ops.push({ color: col, mode: "fill", power: pw, speed: v, passes: 1, interval: 0.1, kerf: 0 });
  }));
  const W = 2 * m + nV * (s + gap) - gap, H = 2 * m + nP * (s + gap) - gap;
  if (p.decoupe >= 0.5) {
    body += line(`M0.5 0.5 H${f(W - 0.5)} V${f(H - 0.5)} H0.5 Z`);
    ops.push({ color: CUT, mode: "line", power: 100, speed: 250, passes: 3, interval: 0.1, kerf: 0 });
  }
  return {
    svg: svgDoc(W, H, body), widthMm: W, heightMm: H, ops,
    notes: [`Lignes : puissance ${powers.join(" / ")} %. Colonnes : vitesse ${speeds.join(" / ")} mm/min.`, "Les réglages des cases priment sur ceux des calques."],
  };
}

const P = (key: string, label: string, min: number, max: number, step: number, def: number, unit?: string): ParamSpec => ({ key, label, min, max, step, default: def, unit });
const MOTIF = P("motif", "Motif (0 aucun, 1 cœur, 2 étoile, 3 fleur, 4 rosace)", 0, 4, 1, 1);

export const PATTERNS: PatternDef[] = [
  { id: "grille", label: "Grille d'essais", description: "Puissance × vitesse, une case par réglage : à graver avant toute nouvelle matière.", build: testGrid,
    params: [P("puissances", "Puissances", 2, 8, 1, 5), P("pmin", "Puissance min.", 5, 100, 5, 20, "%"), P("pmax", "Puissance max.", 5, 100, 5, 100, "%"),
      P("vitesses", "Vitesses", 2, 8, 1, 4), P("vmin", "Vitesse min.", 100, 6000, 100, 600, "mm/min"), P("vmax", "Vitesse max.", 100, 6000, 100, 3000, "mm/min"),
      P("case", "Case", 4, 20, 1, 8, "mm"), P("decoupe", "Découper le cadre (0/1)", 0, 1, 1, 0)] },
  { id: "boite", label: "Boîte à encoches", description: "Six panneaux qui s'emboîtent, couvercle gravé.", build: box,
    params: [P("largeur", "Largeur", 20, 300, 5, 60, "mm"), P("profondeur", "Profondeur", 20, 300, 5, 40, "mm"), P("hauteur", "Hauteur", 10, 200, 5, 30, "mm"),
      P("epaisseur", "Épaisseur", 1, 10, 0.1, 3, "mm"), P("creneau", "Créneau", 3, 30, 1, 8, "mm"), P("couvercle", "Couvercle (0/1)", 0, 1, 1, 1), MOTIF] },
  { id: "engrenages", label: "Engrenages", description: "Deux roues dentées qui engrènent, avec axe et évidements.", build: gears,
    params: [P("dents1", "Dents (grande)", 8, 80, 1, 24), P("dents2", "Dents (petite, 0 = aucune)", 0, 60, 1, 12), P("module", "Module", 1, 5, 0.5, 2, "mm"),
      P("axe", "Axe", 1, 20, 0.5, 5, "mm"), P("rayons", "Rayons (0 = plein)", 0, 8, 1, 5)] },
  { id: "puzzle", label: "Puzzle", description: "Pièces à tenons, motif gravé à travers les pièces.", build: jigsaw,
    params: [P("colonnes", "Colonnes", 2, 12, 1, 4), P("lignes", "Lignes", 2, 12, 1, 3), P("piece", "Pièce", 10, 50, 1, 20, "mm"), P("coins", "Coins arrondis", 0, 10, 1, 2, "mm"),
      P("graine", "Variante", 1, 99, 1, 1), MOTIF] },
  { id: "tampon", label: "Tampon", description: "Fond creusé, motif en relief et en miroir.", build: stamp,
    params: [P("taille", "Taille", 15, 100, 1, 40, "mm"), P("forme", "Forme (0 étoile, 1 cœur, 2 fleur)", 0, 2, 1, 0), P("branches", "Branches de l'étoile", 4, 12, 1, 6),
      P("anneau", "Anneau (0/1)", 0, 1, 1, 1), P("miroir", "Miroir (0/1)", 0, 1, 1, 1)] },
  { id: "porte-cles", label: "Porte-clés", description: "Plaque arrondie, trou, bordure marquée, motif gravé.", build: keychain,
    params: [P("largeur", "Largeur", 20, 120, 1, 60, "mm"), P("hauteur", "Hauteur", 10, 60, 1, 26, "mm"), P("rayon", "Rayon des coins", 0, 20, 1, 6, "mm"),
      P("trou", "Trou", 2, 10, 0.5, 5, "mm"), P("bordure", "Bordure (0/1)", 0, 1, 1, 1), { ...MOTIF, default: 2 }] },
  { id: "pendentif", label: "Pendentif", description: "Disque, bélière, anneau marqué, motif gravé.", build: pendant,
    params: [P("diametre", "Diamètre", 15, 100, 1, 38, "mm"), P("trou", "Bélière", 1, 8, 0.5, 2.8, "mm"), P("bordure", "Anneau (0/1)", 0, 1, 1, 1), MOTIF] },
  { id: "dessous", label: "Dessous de verre", description: "Disque découpé, anneaux marqués, rosace gravée.", build: coaster,
    params: [P("diametre", "Diamètre", 50, 150, 1, 90, "mm"), P("anneaux", "Anneaux", 0, 4, 1, 2), { ...MOTIF, default: 4 }] },
  { id: "regle", label: "Règle", description: "Graduations au millimètre marquées, repères gravés, contour découpé.", build: ruler,
    params: [P("longueur", "Longueur", 5, 40, 1, 15, "cm"), P("largeur", "Largeur", 15, 50, 1, 25, "mm")] },
];

export function getPattern(id: string): PatternDef | null {
  return PATTERNS.find((p) => p.id === id) ?? null;
}

/** Paramètres bornés : valeurs données, sinon défauts ; arrondis au pas. */
export function patternParams(def: PatternDef, raw: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of def.params) {
    const v = raw ? Number(raw[spec.key]) : NaN;
    const x = Number.isFinite(v) && raw?.[spec.key] !== "" && raw?.[spec.key] !== null ? v : spec.default;
    out[spec.key] = clamp(Math.round(x / spec.step) * spec.step, spec.min, spec.max);
  }
  return out;
}
