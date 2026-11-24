/**
 * Modèles paramétriques pour la découpe et la gravure laser : chaque modèle produit un SVG en millimètres réels
 * (noir = gravure, bleu = marquage, rouge = découpe) et, pour la grille d'essais, ses propres réglages par
 * couleur. Fonctions pures, testées sans DOM.
 */
import type { LaserOp } from "./toolpath";
import { optimizeStrokes, type Polyline } from "./lineart";
import { clipToCircle, clipToRect, coral, fitLines, flowField, guilloche, harmonograph, maze, repeatTiles, REPEATS, rosette as rosetteLines, spirograph, TILE_SHAPES, tree, truchet, waves } from "./generative";

export const ENGRAVE = "#16130f";
export const MARK = "#2563eb";
export const CUT = "#e11d48";

type Pt = [number, number];
export type Pattern = { svg: string; widthMm: number; heightMm: number; ops?: LaserOp[]; notes: string[] };
/** `options` : paramètre à choix (valeur = index du libellé), à présenter en liste plutôt qu'en curseur. */
export type ParamSpec = { key: string; label: string; min: number; max: number; step: number; default: number; unit?: string; options?: string[] };
/** Familles du catalogue : objets découpés, motifs gravés, plaques, essais. */
export type PatternFamily = "objets" | "motifs" | "plaques" | "essais";
export type PatternDef = { id: string; label: string; description: string; family?: PatternFamily; params: ParamSpec[]; build: (p: Record<string, number>) => Pattern };
export const FAMILIES: { id: PatternFamily; label: string }[] = [
  { id: "motifs", label: "Motifs gravés" }, { id: "objets", label: "Objets découpés" }, { id: "plaques", label: "Plaques" }, { id: "essais", label: "Essais" },
];

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
/** Paramètre à choix : valeur = index dans `options`. */
const C = (key: string, label: string, options: readonly string[], def = 0): ParamSpec => ({ key, label, min: 0, max: options.length - 1, step: 1, default: def, options: [...options] });
const OUI_NON = ["Non", "Oui"];
const MOTIF = C("motif", "Motif", ["Aucun", "Cœur", "Étoile", "Fleur", "Rosace"], 1);

// ─── Motifs génératifs gravés au trait ───────────────────────────────────────────────────────────────────────
const CADRES = ["Aucun", "Rectangle découpé", "Disque découpé", "Rectangle marqué", "Disque marqué"];
const FORMAT = [P("largeur", "Largeur", 20, 400, 1, 100, "mm"), P("hauteur", "Hauteur", 20, 400, 1, 100, "mm"), C("cadre", "Cadre", CADRES, 0)];
const ECART = P("ecart", "Écart aux croisements", 0, 0.6, 0.05, 0.15, "mm");
const GRAINE = P("graine", "Variante", 1, 999, 1, 1);

/**
 * Tracés (repère quelconque) → modèle : cadrés dans largeur × hauteur (ou le disque), coupés au cadre,
 * optimisés pour un seul passage par point (`ecart`), gravés au trait ; cadre découpé ou marqué.
 */
function strokes(raw: Polyline[], p: Record<string, number>, o: { fit?: boolean; notes?: string[] } = {}): Pattern {
  const W = p.largeur, H = p.hauteur, cadre = p.cadre ?? 0;
  const round = cadre === 2 || cadre === 4;
  const D = Math.min(W, H);
  const margin = cadre ? Math.max(2, D * 0.04) : 0;
  let lines = o.fit === false ? raw : fitLines(raw, round ? D : W, round ? D : H, margin);
  if (round) lines = clipToCircle(lines, D / 2, D / 2, D / 2 - margin);
  else if (o.fit === false) lines = clipToRect(lines, margin, margin, W - margin, H - margin);
  const opt = optimizeStrokes(lines, { gap: p.ecart ?? 0.15, snap: 0.01 });
  // Un seul chemin à sous-chemins : des milliers de morceaux restent légers à lire.
  const d = opt.filter((l) => l.length >= 2).map((l) => poly(l, false)).join("");
  let body = d ? line(d, ENGRAVE) : "";
  const w = round ? D : W, h = round ? D : H;
  if (cadre === 1 || cadre === 3) body += line(`M0 0 H${f(w)} V${f(h)} H0 Z`, cadre === 1 ? CUT : MARK);
  if (round) body += circle(D / 2, D / 2, D / 2 - (cadre === 4 ? 0.5 : 0), cadre === 2 ? CUT : MARK);
  return { svg: svgDoc(w, h, body), widthMm: w, heightMm: h, notes: [`${opt.length} tracés gravés au trait.`, ...(o.notes ?? [])] };
}

const MOTIFS: PatternDef[] = [
  { id: "arbre", family: "motifs", label: "Arbre", description: "Branches récursives et courbes ; chaque jonction n'est brûlée qu'une fois.",
    params: [...FORMAT, P("profondeur", "Profondeur", 1, 12, 1, 8), P("branches", "Branches", 1, 5, 1, 2), P("angle", "Ouverture", 5, 90, 1, 24, "°"),
      P("rapport", "Raccourcissement", 0.5, 0.92, 0.01, 0.74), P("courbure", "Courbure", 0, 100, 1, 30), P("gravite", "Gravité", -100, 100, 1, 0),
      P("alea", "Irrégularité", 0, 100, 1, 25), P("evase", "Évasement", 0, 100, 1, 0), GRAINE, ECART],
    build: (p) => strokes(tree({ depth: p.profondeur, branches: p.branches, angle: p.angle, ratio: p.rapport, bend: p.courbure, gravity: p.gravite, jitter: p.alea, spread: p.evase, taper: 0, seed: p.graine }), p) },
  { id: "corail", family: "motifs", label: "Corail", description: "Croissance vers des points attracteurs (colonisation de l'espace) : corail, racines, lichen.",
    params: [...FORMAT, C("forme", "Forme", ["Disque", "Buisson", "Carré"], 0), P("points", "Densité", 100, 2000, 50, 600), P("pas", "Pas de croissance", 0.5, 5, 0.1, 1.6),
      P("portee", "Portée", 5, 60, 1, 20), P("germes", "Germes", 1, 12, 1, 1), GRAINE, ECART],
    build: (p) => strokes(coral({ attractors: p.points, step: p.pas, kill: p.pas * 1.6, reach: p.portee, seeds: p.germes, seed: p.graine, shape: p.forme }), p) },
  { id: "spirographe", family: "motifs", label: "Spirographe", description: "Roue qui tourne dans (ou autour d') un anneau, en couches décalées.",
    params: [...FORMAT, P("anneau", "Dents de l'anneau", 20, 150, 1, 105), P("roue", "Dents de la roue", 5, 120, 1, 38), P("crayon", "Position du crayon", 0.1, 1.5, 0.05, 0.8),
      C("dehors", "Roue", ["Dedans", "Dehors"], 0), P("couches", "Couches", 1, 12, 1, 1), P("decalage", "Décalage des couches", 0, 360, 1, 30, "°"), ECART],
    build: (p) => strokes(spirograph({ ring: p.anneau, wheel: p.roue, pen: p.crayon, layers: p.couches, outside: p.dehors, turnLayers: p.decalage * p.couches }), p) },
  { id: "guilloche", family: "motifs", label: "Guilloché", description: "Anneaux ondulés déphasés, comme un cadran de montre ou un billet.",
    params: [...FORMAT, P("anneaux", "Anneaux", 2, 80, 1, 24), P("ondes", "Ondulations", 2, 60, 1, 18), P("amplitude", "Amplitude", 0, 30, 0.5, 6),
      P("phase", "Déphasage", 0, 90, 1, 12, "°"), P("centre", "Centre vide", 0, 80, 1, 15, "%"), P("torsion", "Torsion", 0, 12, 1, 1), ECART],
    build: (p) => strokes(guilloche({ rings: p.anneaux, waves: p.ondes, amp: p.amplitude, phase: p.phase, inner: p.centre, twist: p.torsion }), p) },
  { id: "rosace", family: "motifs", label: "Rosace", description: "Pétales en couches alternées.",
    params: [...FORMAT, P("petales", "Pétales", 3, 48, 1, 12), P("couches", "Couches", 1, 10, 1, 3), P("largeur_p", "Largeur des pétales", 20, 200, 5, 90, "%"),
      P("alterne", "Alternance", 0, 100, 5, 50, "%"), P("coeur", "Cœur", 0, 60, 1, 12, "%"), C("bombe", "Pétales", ["Pointus", "Bombés"], 0), ECART],
    build: (p) => strokes(rosetteLines({ petals: p.petales, layers: p.couches, width: p.largeur_p, offset: p.alterne, inner: p.coeur, heart: p.bombe }), p) },
  { id: "truchet", family: "motifs", label: "Truchet", description: "Tuiles tournées au hasard qui forment des chemins continus.",
    params: [...FORMAT, P("colonnes", "Colonnes", 2, 60, 1, 12), P("lignes", "Lignes", 2, 60, 1, 12), C("style", "Tuiles", ["Arcs", "Diagonales", "Traits"], 0), GRAINE, ECART],
    build: (p) => strokes(truchet({ cols: p.colonnes, rows: p.lignes, style: p.style, seed: p.graine }), p) },
  { id: "labyrinthe", family: "motifs", label: "Labyrinthe", description: "Labyrinthe parfait (un seul chemin), entrée en haut à gauche, sortie en bas à droite.",
    params: [...FORMAT, P("colonnes", "Colonnes", 3, 80, 1, 16), P("lignes", "Lignes", 3, 80, 1, 16), GRAINE, ECART],
    build: (p) => strokes(maze({ cols: p.colonnes, rows: p.lignes, seed: p.graine }), p) },
  { id: "flux", family: "motifs", label: "Champ de flux", description: "Lignes qui suivent un courant, régulièrement espacées : elles ne se croisent jamais.",
    params: [...FORMAT, P("espacement", "Espacement", 0.5, 10, 0.1, 2, "mm"), P("echelle", "Taille des tourbillons", 5, 200, 1, 40, "mm"),
      P("tourbillon", "Spirale", -100, 100, 1, 0), P("longueur", "Longueur max.", 5, 600, 5, 200, "mm"), GRAINE, ECART],
    build: (p) => {
      const w = p.cadre === 2 || p.cadre === 4 ? Math.min(p.largeur, p.hauteur) : p.largeur, h = p.cadre === 2 || p.cadre === 4 ? Math.min(p.largeur, p.hauteur) : p.hauteur;
      return strokes(flowField({ w, h, sep: p.espacement, scale: p.echelle, swirl: p.tourbillon, maxLen: p.longueur, seed: p.graine }), p, { fit: false });
    } },
  { id: "harmonographe", family: "motifs", label: "Harmonographe", description: "Tracé de deux pendules amortis ; beaucoup de croisements, interrompus pour ne pas brûler.",
    params: [...FORMAT, P("f1", "Fréquence 1", 1, 8, 0.01, 2), P("f2", "Fréquence 2", 1, 8, 0.01, 3.01), P("f3", "Fréquence 3", 1, 8, 0.01, 3), P("f4", "Fréquence 4", 1, 8, 0.01, 2.005),
      P("amorti", "Amortissement", 0, 100, 1, 20), P("phase", "Déphasage", 0, 360, 1, 90, "°"), P("duree", "Durée", 10, 150, 1, 60), GRAINE, { ...ECART, default: 0.1 }],
    build: (p) => strokes(harmonograph({ f1: p.f1, f2: p.f2, f3: p.f3, f4: p.f4, damping: p.amorti, phase: p.phase, length: p.duree, seed: p.graine }), p) },
  { id: "ondes", family: "motifs", label: "Ondes", description: "Lignes empilées en relief, faces cachées : aucune ne croise celle de devant.",
    params: [...FORMAT, P("lignes", "Lignes", 5, 200, 1, 60), P("amplitude", "Hauteur des vagues", 1, 100, 1, 18, "mm"), P("echelle", "Largeur des vagues", 2, 100, 1, 12, "mm"),
      P("pic", "Relief central", 0, 100, 1, 60, "%"), GRAINE, ECART],
    build: (p) => strokes(waves({ w: p.largeur, h: p.hauteur, lines: p.lignes, amp: p.amplitude, scale: p.echelle, peak: p.pic, seed: p.graine }), p, { fit: false }) },
  { id: "repetition", family: "motifs", label: "Motif répété", description: "Une tuile (forme de base, imbriquée) répétée en grille, quinconce, hexagones, rosace, miroir ou anneaux.",
    params: [...FORMAT, C("forme", "Tuile", TILE_SHAPES, 2), P("cotes", "Côtés / branches", 3, 16, 1, 6), P("creux", "Creux", 0.1, 1, 0.05, 0.45),
      P("imbrication", "Contours imbriqués", 1, 8, 1, 1), P("taille", "Taille de la tuile", 2, 100, 0.5, 12, "mm"), C("repetition", "Répétition", REPEATS, 0),
      P("ecartX", "Écart horizontal", -50, 50, 0.5, 2, "mm"), P("ecartY", "Écart vertical", -50, 50, 0.5, 2, "mm"), P("nombre", "Copies (rosace)", 3, 72, 1, 12),
      P("anneaux", "Anneaux", 1, 12, 1, 4), P("rotation", "Rotation", 0, 360, 1, 0, "°"), P("pasRotation", "Rotation progressive", -45, 45, 0.5, 0, "°"),
      P("pasEchelle", "Échelle progressive", -10, 10, 0.5, 0, "%"), ECART],
    build: (p) => {
      const round = p.cadre === 2 || p.cadre === 4;
      const w = round ? Math.min(p.largeur, p.hauteur) : p.largeur, h = round ? Math.min(p.largeur, p.hauteur) : p.hauteur;
      return strokes(repeatTiles({ shape: p.forme, sides: p.cotes, inner: p.creux, size: p.taille, repeat: p.repetition, count: p.nombre, rings: p.anneaux, gapX: p.ecartX, gapY: p.ecartY,
        rotate: p.rotation, rotStep: p.pasRotation, scaleStep: p.pasEchelle, nested: p.imbrication, w, h }), p, { fit: false });
    } },
];

export const PATTERNS: PatternDef[] = [
  { id: "grille", family: "essais", label: "Grille d'essais", description: "Puissance × vitesse, une case par réglage : à graver avant toute nouvelle matière.", build: testGrid,
    params: [P("puissances", "Puissances", 2, 8, 1, 5), P("pmin", "Puissance min.", 5, 100, 5, 20, "%"), P("pmax", "Puissance max.", 5, 100, 5, 100, "%"),
      P("vitesses", "Vitesses", 2, 8, 1, 4), P("vmin", "Vitesse min.", 100, 6000, 100, 600, "mm/min"), P("vmax", "Vitesse max.", 100, 6000, 100, 3000, "mm/min"),
      P("case", "Case", 4, 20, 1, 8, "mm"), C("decoupe", "Découper le cadre", OUI_NON, 0)] },
  { id: "boite", family: "objets", label: "Boîte à encoches", description: "Six panneaux qui s'emboîtent, couvercle gravé.", build: box,
    params: [P("largeur", "Largeur", 20, 300, 5, 60, "mm"), P("profondeur", "Profondeur", 20, 300, 5, 40, "mm"), P("hauteur", "Hauteur", 10, 200, 5, 30, "mm"),
      P("epaisseur", "Épaisseur", 1, 10, 0.1, 3, "mm"), P("creneau", "Créneau", 3, 30, 1, 8, "mm"), C("couvercle", "Couvercle", OUI_NON, 1), MOTIF] },
  { id: "engrenages", family: "objets", label: "Engrenages", description: "Deux roues dentées qui engrènent, avec axe et évidements.", build: gears,
    params: [P("dents1", "Dents (grande)", 8, 80, 1, 24), P("dents2", "Dents (petite, 0 = aucune)", 0, 60, 1, 12), P("module", "Module", 1, 5, 0.5, 2, "mm"),
      P("axe", "Axe", 1, 20, 0.5, 5, "mm"), P("rayons", "Rayons (0 = plein)", 0, 8, 1, 5)] },
  { id: "puzzle", family: "objets", label: "Puzzle", description: "Pièces à tenons, motif gravé à travers les pièces.", build: jigsaw,
    params: [P("colonnes", "Colonnes", 2, 12, 1, 4), P("lignes", "Lignes", 2, 12, 1, 3), P("piece", "Pièce", 10, 50, 1, 20, "mm"), P("coins", "Coins arrondis", 0, 10, 1, 2, "mm"),
      P("graine", "Variante", 1, 99, 1, 1), MOTIF] },
  { id: "tampon", family: "objets", label: "Tampon", description: "Fond creusé, motif en relief et en miroir.", build: stamp,
    params: [P("taille", "Taille", 15, 100, 1, 40, "mm"), C("forme", "Forme", ["Étoile", "Cœur", "Fleur"], 0), P("branches", "Branches de l'étoile", 4, 12, 1, 6),
      C("anneau", "Anneau", OUI_NON, 1), C("miroir", "Miroir", OUI_NON, 1)] },
  { id: "porte-cles", family: "objets", label: "Porte-clés", description: "Plaque arrondie, trou, bordure marquée, motif gravé.", build: keychain,
    params: [P("largeur", "Largeur", 20, 120, 1, 60, "mm"), P("hauteur", "Hauteur", 10, 60, 1, 26, "mm"), P("rayon", "Rayon des coins", 0, 20, 1, 6, "mm"),
      P("trou", "Trou", 2, 10, 0.5, 5, "mm"), C("bordure", "Bordure", OUI_NON, 1), { ...MOTIF, default: 2 }] },
  { id: "pendentif", family: "objets", label: "Pendentif", description: "Disque, bélière, anneau marqué, motif gravé.", build: pendant,
    params: [P("diametre", "Diamètre", 15, 100, 1, 38, "mm"), P("trou", "Bélière", 1, 8, 0.5, 2.8, "mm"), C("bordure", "Anneau", OUI_NON, 1), MOTIF] },
  { id: "dessous", family: "objets", label: "Dessous de verre", description: "Disque découpé, anneaux marqués, rosace gravée.", build: coaster,
    params: [P("diametre", "Diamètre", 50, 150, 1, 90, "mm"), P("anneaux", "Anneaux", 0, 4, 1, 2), { ...MOTIF, default: 4 }] },
  { id: "regle", family: "objets", label: "Règle", description: "Graduations au millimètre marquées, repères gravés, contour découpé.", build: ruler,
    params: [P("longueur", "Longueur", 5, 40, 1, 15, "cm"), P("largeur", "Largeur", 15, 50, 1, 25, "mm")] },
  ...MOTIFS,
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
