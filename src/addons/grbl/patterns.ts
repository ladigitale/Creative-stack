/**
 * Modèles paramétriques pour la découpe et la gravure laser : chaque modèle produit un SVG en millimètres réels
 * (noir = gravure, bleu = marquage, rouge = découpe) et, pour la grille d'essais, ses propres réglages par
 * couleur. Fonctions pures, testées sans DOM.
 */
import type { LaserOp } from "./toolpath";
import { optimizeStrokes, type Polyline } from "./lineart";
import { clipToCircle, clipToRect, coral, fitLines, flowField, guilloche, harmonograph, LEAF_FILLS, maze, repeatTiles, REPEATS, subdivide, SUBDIV_MODES, rosette as rosetteLines, spirograph, TILE_SHAPES, tree, truchet, waves } from "./generative";

export const ENGRAVE = "#16130f";
export const MARK = "#2563eb";
export const CUT = "#e11d48";

type Pt = [number, number];
export type Pattern = { svg: string; widthMm: number; heightMm: number; ops?: LaserOp[]; notes: string[];
  /** Conseils de montage et de finition : ordre d'assemblage, collage, serrage, ponçage, sens du fil, matière. */
  advice: string[] };
/** `options` : paramètre à choix (valeur = index du libellé), à présenter en liste plutôt qu'en curseur. */
export type ParamSpec = { key: string; label: string; min: number; max: number; step: number; default: number; unit?: string; options?: string[] };
/** Familles du catalogue : objets découpés, motifs gravés, plaques, essais. */
export type PatternFamily = "objets" | "assemblages" | "motifs" | "plaques" | "essais";
export type PatternDef = { id: string; label: string; description: string; family?: PatternFamily; params: ParamSpec[]; build: (p: Record<string, number>) => Pattern };
export const FAMILIES: { id: PatternFamily; label: string }[] = [
  { id: "motifs", label: "Motifs gravés" }, { id: "objets", label: "Objets découpés" }, { id: "assemblages", label: "Boîtes et assemblages" }, { id: "plaques", label: "Plaques" }, { id: "essais", label: "Essais" },
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
    advice: ADVICE.boite,
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
  return { svg: svgDoc(w, 2 * cy, body), widthMm: w, heightMm: 2 * cy, notes: [`Entraxe ${f((m * (n1 + n2)) / 2)} mm.`], advice: ADVICE.engrenages };
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
  return { svg: svgDoc(W, H, body), widthMm: W, heightMm: H, notes: [`${cols * rows} pièces.`], advice: ADVICE.puzzle };
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
  return { svg: svgDoc(s, s, mirrored), widthMm: s, heightMm: s, notes: ["Gravez profond (2 à 4 passes) sur caoutchouc laser ou bois dur."], advice: ADVICE.tampon };
}

// ─── Porte-clés, étiquette, pendentif, dessous de verre ───────────────────────────────────────────────────────────
function keychain(p: Record<string, number>): Pattern {
  const W = p.largeur, H = p.hauteur, r = p.rayon;
  let body = line(roundRect(0.5, 0.5, W - 1, H - 1, r)) + circle(Math.min(r, H / 2) + 2, H / 2, p.trou / 2);
  if (p.bordure >= 0.5) body += line(roundRect(2.5, 2.5, W - 5, H - 5, Math.max(0, r - 2)), MARK);
  const left = Math.min(r, H / 2) + 2 + p.trou / 2 + 3;
  body += motif(p.motif, (left + W) / 2, H / 2, Math.min(H * 0.7, W - left - 4));
  return { svg: svgDoc(W, H, body), widthMm: W, heightMm: H, notes: [], advice: ADVICE.porteCles };
}

function pendant(p: Record<string, number>): Pattern {
  const d = p.diametre, r = d / 2, c = r + 0.5;
  let body = circle(c, c, r) + circle(c, c - r + p.trou / 2 + 1.5, p.trou / 2);
  if (p.bordure >= 0.5) body += circle(c, c, r - 3, MARK);
  body += motif(p.motif, c, c + r * 0.06, d * 0.55);
  return { svg: svgDoc(d + 1, d + 1, body), widthMm: d + 1, heightMm: d + 1, notes: [], advice: ADVICE.pendentif };
}

function coaster(p: Record<string, number>): Pattern {
  const d = p.diametre, r = d / 2, c = r + 0.5;
  let body = circle(c, c, r);
  for (let i = 0; i < Math.round(p.anneaux); i++) body += circle(c, c, r - 4 - i * 1.5, MARK);
  body += motif(p.motif, c, c, d * 0.75);
  return { svg: svgDoc(d + 1, d + 1, body), widthMm: d + 1, heightMm: d + 1, notes: [], advice: ADVICE.dessous };
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
  return { svg: svgDoc(W, H, body), widthMm: W, heightMm: H, notes: [], advice: ADVICE.regle };
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
    advice: ADVICE.grille,
  };
}

// ─── Conseils de montage ──────────────────────────────────────────────────────────────────────────────────────────
const GLUE_WOOD = "Colle : vinylique (colle à bois blanche) au pinceau fin ou au cure-dent, en filet mince sur une seule face ; essuyez l'excédent aussitôt au chiffon humide (elle bloque la teinte et l'huile).";
const SAND = "Les bords découpés sont brunis par la fumée : un coup de ponçage au grain 180 puis 240, ou une gomme à mélamine humide, les éclaircit. Du papier de masquage (transfert) posé avant la découpe évite les auréoles.";
const THICK = "Mesurez l'épaisseur réelle au pied à coulisse à plusieurs endroits (un contreplaqué « 3 mm » fait 2,7 à 3,2 mm) et reportez-la dans « Épaisseur » avant de découper.";
const SLOT_FIT = "Ajustement des fentes : découpez d'abord une seule paire de pièces. Trop dur, augmentez « Trait » ou baissez « Serrage » ; trop lâche, l'inverse. Si vous compensez déjà le trait dans les calques (kerf), laissez « Trait » à 0.";
const FINISH = "Finition : huile dure ou cire après le ponçage ; vernis en bombe en couches fines pour le carton et le MDF (il boit beaucoup).";
const ADVICE = {
  boite: [THICK, "Ordre : posez le fond à plat, emboîtez les deux façades, puis les deux côtés ; le couvercle se pose sans colle.", GLUE_WOOD,
    "Serrage : ruban de masquage autour de la boîte ou serre-joints doux, 30 min ; vérifiez l'équerre en mesurant les deux diagonales du dessus (elles doivent être égales).", SAND,
    "Fil du bois : orientez le fil des grands panneaux dans la même direction, c'est plus joli et plus solide.", FINISH],
  engrenages: ["Aucune colle sur les dents. Montez les roues sur des axes lisses (tourillon, vis à épaulement, clou) au diamètre de l'axe, plaque de fond percée à l'entraxe indiqué.",
    "Laissez 0,2 à 0,3 mm de jeu entre les roues : l'entraxe est déjà majoré de 0,3 mm.", "Glissez une rondelle (ou un disque de 1 mm découpé) entre la roue et la plaque pour limiter le frottement.",
    "Lubrifiez à la cire de bougie ou au graphite, jamais à l'huile (le bois gonfle). Poncez légèrement les flancs si une dent accroche.", "Matière dure de préférence (contreplaqué bouleau, acrylique 3 mm et plus) : le MDF s'use vite."],
  puzzle: ["Pas de colle : les tenons tiennent par leur forme. Laissez la plaque en place jusqu'au refroidissement, puis poussez les pièces par-dessous.", SAND,
    "Gravez avant de découper (c'est l'ordre des calques) : la plaque ne bouge pas entre les deux.", "Une couche de vernis mat sur le dessus seulement, pour que les pièces glissent encore."],
  tampon: ["Matière : caoutchouc spécial laser (sans chlore) ou bois dur. Jamais de PVC, vinyle ni simili-cuir : la découpe dégage de l'acide chlorhydrique, toxique et corrosif pour la machine.",
    "Brossez le caoutchouc à l'eau savonneuse tiède après la gravure pour retirer la poudre.", "Collez le caoutchouc sur un bloc de bois ou d'acrylique avec de la colle contact (néoprène) ou de l'adhésif double face mousse, serré à la main 1 min.",
    "Le motif est en miroir : il s'imprime à l'endroit. Encrez au tampon encreur, pressez sans glisser."],
  porteCles: ["Poncez les arêtes et l'intérieur du trou (une lime ronde ou du papier roulé) avant d'enfiler l'anneau brisé.", "Contreplaqué 3 à 4 mm ou acrylique 3 mm pour la solidité ; un bois tendre de 2 mm casse au trou.", FINISH],
  pendentif: ["Passez un anneau de jonction (2 pinces plates : ouvrez-le de côté, jamais en l'écartant) dans la bélière, puis le cordon ou la chaîne.", "Poncez au grain 240 la tranche, surtout autour de la bélière.", "Finition : vernis ou huile, deux couches fines, séchage à plat sur une pointe."],
  dessous: ["Collez un disque de liège ou de feutrine dessous (colle contact ou vinylique en couche fine, sous presse avec un livre lourd 1 h) : il protège la table et ne glisse pas.",
    "Protégez le dessus contre l'eau : huile dure (type huile de lin cuite) en 2 couches, ou vernis polyuréthane. Le liège seul peut se découper à la même puissance que du carton."],
  regle: ["Gravez sur une matière stable (acrylique, contreplaqué bouleau) : le MDF gonfle à l'humidité.", "Vérifiez une graduation de 10 cm au réglet métallique avant de découper : un écart vient du réglage pas/mm de la machine, pas du modèle.", FINISH],
  grille: ["Gravez la grille sur une chute de la même matière, sur la même machine, au même focus : un réglage ne se transpose pas d'une matière à l'autre.",
    "Notez au crayon au dos la matière, la date et la lentille ; gardez la plaque comme nuancier.", "Choisissez la case la plus claire qui donne un contraste net : la gravure va plus vite et le bord brûle moins."],
  motif: ["Fixez la pièce bien à plat (pinces, aimants sur plateau acier, ruban de masquage) : un bois voilé est flou à la gravure.", "Refaites la mise au point sur la surface à graver.",
    "Du papier transfert ou de masquage sur le bois évite les auréoles de fumée ; retirez-le après la gravure.", "Nettoyez la suie à la gomme à mélamine humide, puis huile ou vernis pour faire ressortir le contraste."],
};

// ─── Pièces et rangement ──────────────────────────────────────────────────────────────────────────────────────────
type Piece = { w: number; h: number; draw: (x: number, y: number) => string };
/** Range les pièces par rangées, sans chevauchement, `gap` mm entre elles. */
function pack(pieces: Piece[], maxW = 380, gap = 4): { body: string; w: number; h: number } {
  const limit = Math.max(maxW, ...pieces.map((p) => p.w + 2));
  let x = 1, y = 1, rowH = 0, w = 0, body = "";
  for (const p of pieces) {
    if (x > 1 && x + p.w > limit) { x = 1; y += rowH + gap; rowH = 0; }
    body += p.draw(x, y);
    x += p.w + gap;
    rowH = Math.max(rowH, p.h);
    w = Math.max(w, x - gap + 1);
  }
  return { body, w, h: y + rowH + 1 };
}
const packed = (pieces: Piece[], notes: string[], advice: string[], maxW?: number): Pattern => {
  const { body, w, h } = pack(pieces, maxW);
  return { svg: svgDoc(w, h, body), widthMm: w, heightMm: h, notes, advice };
};

type Seg = { len: number; n: number; out: number };
/** Bord fait de tronçons : créneaux sur une partie, lisse sur une autre. */
function segEdge(a: Pt, b: Pt, segs: Seg[], t: number): Pt[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const pts: Pt[] = [];
  let s = 0;
  for (const g of segs) {
    const p: Pt = [a[0] + ux * s, a[1] + uy * s], q: Pt = [a[0] + ux * (s + g.len), a[1] + uy * (s + g.len)];
    pts.push(...fingerEdge(p, q, g.out ? g.n : 1, g.out, t));
    s += g.len;
  }
  return pts;
}
const dedupe = (pts: Pt[]) => pts.filter((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1][0]) > 1e-6 || Math.abs(p[1] - pts[i - 1][1]) > 1e-6);
/** Panneau à encoches, bords décrits par tronçons (haut, droite, bas, gauche ; sens horaire). */
function segPanel(w: number, h: number, t: number, edges: [Seg[], Seg[], Seg[], Seg[]], extra?: (x: number, y: number) => string): Piece {
  return {
    w: w + 2 * t, h: h + 2 * t,
    draw: (x0, y0) => {
      const x = x0 + t, y = y0 + t;
      const c: Pt[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      const pts: Pt[] = [];
      for (let k = 0; k < 4; k++) pts.push(...segEdge(c[k], c[(k + 1) % 4], edges[k], t));
      return line(poly(dedupe(pts))) + (extra ? extra(x, y) : "");
    },
  };
}
/** Panneau à encoches simple : `tabs` (haut, droite, bas, gauche) = +1 dents, −1 creux, 0 lisse. */
const fingerPanel = (w: number, h: number, nw: number, nh: number, t: number, tabs: [number, number, number, number], extra?: (x: number, y: number) => string): Piece =>
  segPanel(w, h, t, [[{ len: w, n: nw, out: tabs[0] }], [{ len: h, n: nh, out: tabs[1] }], [{ len: w, n: nw, out: tabs[2] }], [{ len: h, n: nh, out: tabs[3] }]], extra);

/** Largeur dessinée d'une fente pour une matière d'épaisseur `t` : épaisseur − serrage − trait (0,3 mm au moins). */
export const slotWidth = (t: number, serrage: number, trait: number) => Math.max(0.3, t - serrage - trait);

/** Boîte ouverte à encoches (fond + 4 parois), dimensions intérieures du fond `W × D`, hauteur `H` (fond compris). */
function openBox(W: number, D: number, H: number, t: number, cr: number, lidMotif?: (x: number, y: number) => string): Piece[] {
  const nw = fingers(W, cr), nd = fingers(D, cr), nh = fingers(H, cr);
  return [
    fingerPanel(W, D, nw, nd, t, [1, 1, 1, 1], lidMotif),
    fingerPanel(W, H, nw, nh, t, [0, 1, -1, 1]), fingerPanel(W, H, nw, nh, t, [0, 1, -1, 1]),
    fingerPanel(D, H, nd, nh, t, [0, -1, -1, -1]), fingerPanel(D, H, nd, nh, t, [0, -1, -1, -1]),
  ];
}

// ─── Boîte à charnière vivante ────────────────────────────────────────────────────────────────────────────────────
/** Fentes de charnière vivante dans le rectangle (x, y, w, h) : rangées parallèles à l'axe de pliage, ponts alternés. */
export function flexCuts(x: number, y: number, w: number, h: number, step: number, bridge: number, cut: number): string {
  const segs: string[] = [];
  const P = cut + bridge;
  const rows = Math.max(1, Math.floor(h / step));
  for (let r = 0; r <= rows; r++) {
    const yy = y + (h * r) / rows;
    const off = r % 2 ? P / 2 : 0;
    for (let s = x - P + off + bridge; s < x + w; s += P) {
      const a = Math.max(s, x + bridge), b = Math.min(s + cut, x + w - bridge);
      if (b - a > 1) segs.push(`M${f(a)} ${f(yy)} H${f(b)}`);
    }
  }
  return segs.length ? line(segs.join(" ")) : "";
}

function hingeBox(p: Record<string, number>): Pattern {
  const W = p.largeur, D = p.profondeur, H = p.hauteur, t = p.epaisseur;
  const pieces = openBox(W, D, H, t, p.creneau);
  // Couvercle d'une pièce : dessus (couvre les parois), zone souple (90° autour de l'arête arrière), patte collée au dos.
  const LW = W + 2 * t, LD = D + 2 * t, flex = Math.max(10, Math.PI * 2 * t), band = Math.max(10, H * 0.6);
  const LH = LD + flex + band;
  pieces.push({
    w: LW, h: LH,
    draw: (x, y) => line(roundRect(x, y, LW, LH, 1)) + flexCuts(x, y + LD, LW, flex, p.pas, p.pont, Math.max(8, p.pont * 4)) +
      line(`M${f(x)} ${f(y + LD + flex)} H${f(x + 2)} M${f(x + LW - 2)} ${f(y + LD + flex)} H${f(x + LW)}`, MARK) + motif(p.motif, x + LW / 2, y + LD / 2, Math.min(LW, LD) * 0.45),
  });
  return packed(pieces,
    [`Couvercle d'une seule pièce : dessus ${f(LW)} × ${f(LD)} mm, charnière ${f(flex)} mm, patte ${f(band)} mm (repères bleus à la jonction).`, "Boîte ouverte : fond, deux façades, deux côtés."],
    [THICK, "Ordre : montez d'abord la boîte ouverte (fond, façades, côtés) et laissez sécher. " + GLUE_WOOD,
      "Charnière : le fil du bois doit être perpendiculaire aux fentes (il court dans le sens du pliage), sinon les ponts cassent. Pliez-la à la main plusieurs fois avant de coller, sans forcer à froid ; un peu de vapeur ou un chiffon humide l'assouplit.",
      "Collez la patte (sous les repères bleus) sur la face extérieure du dos : dessus posé à plat sur la boîte, patte rabattue, serrée par deux pinces 30 min. Aucune colle sur la zone souple.",
      "Fermeture : un petit aimant de 5 × 2 mm collé à la cyano dans l'angle du dessus et un autre dans la façade, ou un élastique.", SAND, "Pas de vernis épais sur la charnière : une cire seulement, elle doit rester souple."]);
}

// ─── Boîte à couvercle coulissant ─────────────────────────────────────────────────────────────────────────────────
function slideBox(p: Record<string, number>): Pattern {
  const W = p.largeur, D = p.profondeur, H = p.hauteur, t = p.epaisseur, cr = p.creneau, j = 0.3;
  const nw = fingers(W, cr), nd = fingers(D, cr), nh = fingers(H, cr), nf = fingers(H - t, cr);
  const lip = t + 4, railW = 6;
  const lidW = W - 2 * j, lidL = D + t;
  const pieces: Piece[] = [
    fingerPanel(W, D, nw, nd, t, [1, 1, 1, 1]),
    fingerPanel(W, H, nw, nh, t, [0, 1, -1, 1]),
    fingerPanel(W, H - t, nw, nf, t, [0, 1, -1, 1]),
  ];
  // Côtés : arrière à créneaux sur toute la hauteur, avant à créneaux sur la hauteur de la façade basse (H − t), lisse au-dessus.
  const side = segPanel(D, H, t, [[{ len: D, n: 1, out: 0 }], [{ len: H, n: nh, out: -1 }], [{ len: D, n: nd, out: -1 }], [{ len: H - t, n: nf, out: -1 }, { len: t, n: 1, out: 0 }]]);
  pieces.push(side, side);
  for (let i = 0; i < 2; i++) pieces.push({ w: D, h: railW, draw: (x, y) => line(roundRect(x, y, D, railW, 0)) });
  for (let i = 0; i < 2; i++) pieces.push({ w: D + 2 * t, h: lip, draw: (x, y) => line(roundRect(x, y, D + 2 * t, lip, 0)) });
  pieces.push({
    w: lidW, h: lidL,
    draw: (x, y) => line(roundRect(x, y, lidW, lidL, 0.5)) + fill(`M${f(x + lidW / 2 - 9)} ${f(y + lidL - 7)} a9 3.5 0 1 0 18 0 a9 3.5 0 1 0 -18 0 Z`) +
      motif(p.motif, x + lidW / 2, y + lidL * 0.45, Math.min(lidW, lidL) * 0.45),
  });
  return packed(pieces,
    [`Couvercle ${f(lidW)} × ${f(lidL)} mm, façade basse de ${f(H - t)} mm : le couvercle glisse par-dessus.`, "2 rails (sous le couvercle) et 2 rebords (au-dessus) à coller sur les côtés."],
    [THICK, "Ordre : fond, dos, façade basse, puis les deux côtés (identiques : retournez le second, la partie lisse en haut vers l'avant). " + GLUE_WOOD,
      "Rails : collez-les à l'intérieur des côtés, sous le couvercle, avec le couvercle en place comme gabarit et une feuille de papier dessus pour garder du jeu.",
      "Rebords : collez-les sur le chant supérieur des côtés, débordant de 4 mm vers l'intérieur au-dessus du couvercle ; retirez le couvercle avant la prise complète (15 min) pour qu'il ne reste pas collé.",
      "Si le couvercle frotte, poncez ses chants plutôt que les rails, puis cirez-les (bougie) : il glisse mieux.", SAND, FINISH]);
}

// ─── Boîte à couvercle emboîtant ──────────────────────────────────────────────────────────────────────────────────
function lidBox(p: Record<string, number>): Pattern {
  const W = p.largeur, D = p.profondeur, H = p.hauteur, t = p.epaisseur, j = Math.max(0.1, p.jeu);
  const pieces = openBox(W, D, H, t, p.creneau);
  const TW = W + 2 * t + 2 * p.debord, TD = D + 2 * t + 2 * p.debord;
  pieces.push({ w: TW, h: TD, draw: (x, y) => line(roundRect(x, y, TW, TD, p.debord ? 2 : 0.5)) + motif(p.motif, x + TW / 2, y + TD / 2, Math.min(TW, TD) * 0.45) });
  const iw = W - 2 * j, id = D - 2 * j;
  pieces.push({ w: iw, h: id, draw: (x, y) => line(roundRect(x, y, iw, id, 0.5)) });
  if (p.bouton) pieces.push({ w: 22, h: 22, draw: (x, y) => circle(x + 11, y + 11, 10) + circle(x + 11, y + 11, 7, MARK) });
  return packed(pieces, [`Dessus ${f(TW)} × ${f(TD)} mm, bouchon ${f(iw)} × ${f(id)} mm (jeu ${f(j)} mm par côté) qui entre dans la boîte.`],
    [THICK, "Ordre : boîte ouverte (fond, façades, côtés), puis le couvercle. " + GLUE_WOOD,
      "Couvercle : posez le bouchon dans la boîte, encollez son dessus, posez le dessus centré par-dessus et chargez-le d'un livre 30 min : le bouchon se cale tout seul au bon endroit.",
      "Bouton : collez-le au centre du dessus (vinylique, ou cyano pour l'acrylique).", "Si le couvercle force, poncez les chants du bouchon ; s'il flotte, baissez « Jeu » et redécoupez le bouchon, ou collez une bande de papier sur ses chants.", SAND, FINISH]);
}

// ─── Boîte à tiroir ───────────────────────────────────────────────────────────────────────────────────────────────
function drawerBox(p: Record<string, number>): Pattern {
  const W = p.largeur, D = p.profondeur, H = p.hauteur, t = p.epaisseur, cr = p.creneau, j = 0.5;
  const nw = fingers(W, cr), nd = fingers(D, cr), nh = fingers(H, cr);
  const flat = (len: number): Seg[] => [{ len, n: 1, out: 0 }];
  const fing = (len: number, n: number, out: number): Seg[] => [{ len, n, out }];
  // Caisson ouvert à l'avant : fond et dessus (avant lisse), dos, deux côtés (avant lisse).
  const plate = segPanel(W, D, t, [fing(W, nw, 1), fing(D, nd, 1), flat(W), fing(D, nd, 1)]);
  const back = fingerPanel(W, H, nw, nh, t, [-1, 1, -1, 1]);
  const side = segPanel(D, H, t, [fing(D, nd, -1), fing(H, nh, -1), fing(D, nd, -1), flat(H)]);
  // Tiroir : boîte ouverte dont l'extérieur fait W − 2j × D − j × H − 2j.
  const dw = W - 2 * j - 2 * t, dd = D - j - 2 * t, dh = H - 2 * j;
  const fw = W + 2 * t - 1, fh = H + 2 * t - 1;
  const front: Piece = {
    w: fw, h: fh,
    draw: (x, y) => line(roundRect(x, y, fw, fh, 1)) + (p.poignee ? line(roundRect(x + fw / 2 - 15, y + fh * 0.35 - 5, 30, 10, 5)) : circle(x + fw / 2, y + fh / 2, 2)),
  };
  return packed([plate, plate, back, side, side, ...openBox(dw, dd, dh, t, cr), front],
    [`Caisson intérieur ${f(W)} × ${f(D)} × ${f(H)} mm, tiroir extérieur ${f(dw + 2 * t)} × ${f(dd + 2 * t)} × ${f(dh)} mm.`,
      p.poignee ? "Façade du tiroir avec prise découpée." : "Façade du tiroir percée au centre pour un bouton à vis (Ø 4 mm)."],
    [THICK, "Caisson : fond, dos, deux côtés, puis le dessus ; l'avant reste ouvert. " + GLUE_WOOD,
      "Tiroir : fond, deux façades, deux côtés (comme une boîte ouverte), puis la façade décorative collée sur la face avant du tiroir.",
      "Pour placer la façade : glissez le tiroir dans le caisson, posez la façade avec deux cales de 0,5 mm (cartes) en bas et sur les côtés, encollez et serrez 30 min.",
      "Contrôlez l'équerre du caisson (diagonales égales) avant la prise, sinon le tiroir coince. S'il frotte, poncez ses chants et cirez-les.", SAND, FINISH]);
}

// ─── Boîte polygonale ─────────────────────────────────────────────────────────────────────────────────────────────
/** Rectangle centré en (cx, cy), long de `len` selon l'angle `a`, large de `wid`. */
function rectAt(cx: number, cy: number, len: number, wid: number, a: number): string {
  const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
  const pts: Pt[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, k]) => [cx + (ux * len * i) / 2 + (vx * wid * k) / 2, cy + (uy * len * i) / 2 + (vy * wid * k) / 2]);
  return poly(pts);
}
const ngon = (cx: number, cy: number, r: number, n: number, rot: number): Pt[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos(rot + (2 * Math.PI * i) / n), cy + r * Math.sin(rot + (2 * Math.PI * i) / n)] as Pt);

function polyBox(p: Record<string, number>): Pattern {
  const n = Math.round(p.cotes), t = p.epaisseur, H = p.hauteur, side = p.cote;
  const sw = slotWidth(t, p.serrage, p.trait);
  const ri = side / (2 * Math.tan(Math.PI / n)); // apothème au milieu des parois
  const sIn = 2 * (ri - t / 2) * Math.tan(Math.PI / n); // longueur d'une paroi (se touchent par l'intérieur)
  const tab = Math.max(4, sIn / 4);
  const margin = Math.max(3, t);
  const rPlate = (ri + t / 2 + margin) / Math.cos(Math.PI / n);
  const closed = p.couvercle === 2;
  const plate = (mortises: boolean, withMotif: boolean): Piece => ({
    w: 2 * rPlate, h: 2 * rPlate,
    draw: (x, y) => {
      const cx = x + rPlate, cy = y + rPlate;
      let s = line(poly(ngon(cx, cy, rPlate, n, Math.PI / n)));
      if (mortises) for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n, nx = Math.cos(a), ny = Math.sin(a), tx = -ny, ty = nx;
        for (const k of [-1, 1]) s += line(rectAt(cx + nx * ri + (tx * k * sIn) / 4, cy + ny * ri + (ty * k * sIn) / 4, tab + 0.2, sw, a + Math.PI / 2));
      }
      if (withMotif) s += motif(p.motif, cx, cy, ri * 1.1);
      return s;
    },
  });
  const wall: Piece = {
    w: sIn, h: H + 2 * t,
    draw: (x, y) => {
      const yt = y + t, yb = y + t + H;
      const pts: Pt[] = [[x, yt]];
      for (const c of [sIn / 4, (3 * sIn) / 4]) {
        if (closed) pts.push([x + c - tab / 2, yt], [x + c - tab / 2, yt - t], [x + c + tab / 2, yt - t], [x + c + tab / 2, yt]);
      }
      pts.push([x + sIn, yt], [x + sIn, yb]);
      for (const c of [(3 * sIn) / 4, sIn / 4]) pts.push([x + c + tab / 2, yb], [x + c + tab / 2, yb + t], [x + c - tab / 2, yb + t], [x + c - tab / 2, yb]);
      pts.push([x, yb]);
      return line(poly(pts));
    },
  };
  const pieces: Piece[] = [plate(true, false), ...Array.from({ length: n }, () => wall)];
  if (closed) pieces.push(plate(true, true));
  else if (p.couvercle === 1) {
    pieces.push(plate(false, true));
    const rPlug = (ri - t / 2 - 0.3) / Math.cos(Math.PI / n);
    pieces.push({ w: 2 * rPlug, h: 2 * rPlug, draw: (x, y) => line(poly(ngon(x + rPlug, y + rPlug, rPlug, n, Math.PI / n))) });
  }
  return packed(pieces,
    [`${n} parois de ${f(sIn)} × ${f(H)} mm à tenons, fond${closed ? " et dessus" : ""} à mortaises (${f(sw)} mm de large).`, p.couvercle === 1 ? "Couvercle : dessus + bouchon à coller dessous." : ""].filter(Boolean),
    [THICK, SLOT_FIT, "Ordre : enfoncez les tenons de toutes les parois dans le fond, puis vérifiez que les parois se touchent par l'intérieur aux angles.",
      "Collage : une goutte de vinylique dans chaque mortaise et un filet dans les angles intérieurs (le petit V extérieur se remplit de pâte à bois si besoin). Cyanoacrylate pour l'acrylique.",
      p.couvercle === 1 ? "Couvercle : bouchon posé dans la boîte, dessus encollé et centré par-dessus, un poids 30 min." : closed ? "Dessus : enfoncez-le sur les tenons du haut avant que la colle des parois ne prenne, tout se cale ensemble." : "Boîte ouverte : poncez le chant supérieur des parois pour l'égaliser.",
      "Serrage : un élastique large ou du ruban de masquage autour des parois.", SAND, FINISH]);
}

// ─── Formes géométriques ──────────────────────────────────────────────────────────────────────────────────────────
function shapes(p: Record<string, number>): Pattern {
  const kind = Math.round(p.forme), n = Math.round(p.cotes), k = Math.round(p.nombre), R = p.taille / 2, c = R + 0.5;
  let body = "";
  let made = 0;
  // Torsion : un contour tourné doit tenir dans le cercle inscrit du précédent (sinon ils se croisent) ; pas sur l'étoile.
  const twist = kind === 0 ? p.torsion : 0;
  let r = R, last = R;
  for (let i = 0; i < k; i++) {
    if (i) r = twist && kind === 0 ? Math.min(r - p.pas, r * Math.cos(Math.PI / n) - 0.5) : r - p.pas;
    if (r < 2) break;
    const rot = -Math.PI / 2 + (i * twist * Math.PI) / 180;
    if (kind === 0) body += line(poly(ngon(c, c, r, n, rot)));
    else if (kind === 1) body += line(starPath(c, c, r, r * p.creux, n, (rot * 180) / Math.PI));
    else body += circle(c, c, r);
    made++;
    last = r;
  }
  // Le trou doit tenir dans le plus petit contour (son cercle inscrit pour un polygone ou une étoile).
  const inner = kind === 2 ? last : kind === 0 ? last * Math.cos(Math.PI / n) : last * p.creux * Math.cos(Math.PI / n);
  if (p.trou > 0 && p.trou / 2 < inner - 1) body += circle(c, c, p.trou / 2);
  const label = ["polygone", "étoile", "cercle"][kind];
  return {
    svg: svgDoc(2 * c, 2 * c, body), widthMm: 2 * c, heightMm: 2 * c,
    notes: [`${made} ${label}${made > 1 ? "s emboîtés (couronnes)" : ""}, pas de ${f(p.pas)} mm.`, ...(p.torsion && kind !== 0 ? ["La torsion ne s'applique qu'aux polygones."] : [])],
    advice: ["Les contours intérieurs sont découpés d'abord : la plaque ne bouge pas. Récupérez les couronnes une par une, de l'intérieur vers l'extérieur.",
      "Empilage en relief (mandala, carte de géographie) : collez les couronnes de la plus grande à la plus petite, en décalant d'un pas de rotation si « Torsion » est réglée, à la vinylique en points (pas de filet : elle ressort).",
      "Mobile ou guirlande : percez avec « Trou » et enfilez un fil de nylon ; décoration de fenêtre : acrylique transparent ou coloré, sans colle.", SAND, FINISH],
  };
}

// ─── Formes 3D à fentes croisées ──────────────────────────────────────────────────────────────────────────────────
/** Points d'intersection (y) du contour avec la verticale x. */
function crossY(pts: Pt[], x: number): { y: number; i: number }[] {
  const out: { y: number; i: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if ((a[0] - x) * (b[0] - x) < 0 || (a[0] === x && b[0] !== x)) {
      const u = (x - a[0]) / (b[0] - a[0]);
      out.push({ y: a[1] + u * (b[1] - a[1]), i });
    }
  }
  return out;
}
/**
 * Contour avec une fente verticale centrée en `x`, large de `w`, ouverte par le haut (`fromTop`) ou par le bas,
 * jusqu'à `yEnd`. Remplace la portion de contour entre les deux bords de la fente.
 */
export function notch(pts: Pt[], x: number, w: number, yEnd: number, fromTop: boolean): Pt[] {
  const pick = (xx: number) => {
    const c = crossY(pts, xx);
    return c.reduce((best, v) => ((fromTop ? v.y < best.y : v.y > best.y) ? v : best), c[0]);
  };
  const L = pick(x - w / 2), R = pick(x + w / 2);
  if (!L || !R) return pts;
  const n = pts.length;
  const pt = (o: { y: number }, xx: number): Pt => [xx, o.y];
  // Parcours de L vers R : on garde la portion qui ne passe pas entre les deux bords de la fente.
  const walk = (from: number, to: number) => { const r: Pt[] = []; for (let k = (from + 1) % n; ; k = (k + 1) % n) { r.push(pts[k]); if (k === to) break; } return r; };
  const inBand = (seq: Pt[]) => seq.every(([px]) => px > x - w / 2 && px < x + w / 2);
  const along = (o: { i: number }, xx: number) => (xx - pts[o.i][0]) / (pts[(o.i + 1) % n][0] - pts[o.i][0]);
  const slot: Pt[] = [];
  // Portion gardée : celle qui sort de la bande de la fente (l'autre, entre les deux bords, tombe).
  const keepRL = L.i === R.i ? along(R, x + w / 2) > along(L, x - w / 2) : !inBand(walk(R.i, L.i));
  if (keepRL) slot.push(pt(R, x + w / 2), ...walk(R.i, L.i), pt(L, x - w / 2), [x - w / 2, yEnd], [x + w / 2, yEnd]);
  else slot.push(pt(L, x - w / 2), ...walk(L.i, R.i), pt(R, x + w / 2), [x + w / 2, yEnd], [x - w / 2, yEnd]);
  return dedupe(slot);
}

function silhouette(kind: number, w: number, h: number): Pt[] {
  const cx = w / 2;
  if (kind === 0) {
    // Sapin : trois étages et un tronc.
    const tr = w * 0.12, th = h * 0.14, top = 0, hb = h - th;
    // Étages : (bas de l'étage en fraction de hauteur, demi-largeur en fraction de largeur).
    const tiers: [number, number][] = [[0.38, 0.24], [0.68, 0.36], [1, 0.5]];
    const left: Pt[] = [[cx, top]];
    tiers.forEach(([b, half], i) => {
      left.push([cx - w * half, top + hb * b]);
      if (i < tiers.length - 1) left.push([cx - w * half * 0.45, top + hb * b]);
    });
    const L = [...left, [cx - tr, hb] as Pt, [cx - tr, h] as Pt];
    const Rr = L.slice(1).reverse().map(([x, y]) => [w - x, y] as Pt);
    return [...L, ...Rr];
  }
  if (kind === 1) {
    const r = Math.min(w, h) / 2, pts: Pt[] = [];
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.42 : r; pts.push([cx + rr * Math.cos(a), h / 2 + rr * Math.sin(a)]); }
    return pts;
  }
  if (kind === 2) return ngon(cx, h / 2, Math.min(w, h) / 2, 48, -Math.PI / 2);
  // Cœur : courbe échantillonnée.
  const pts: Pt[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    const x = 16 * Math.sin(a) ** 3, y = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
    pts.push([cx + (x / 34) * w, h * 0.42 + (y / 32) * h]);
  }
  return pts;
}

function crossShape(p: Record<string, number>): Pattern {
  const kind = Math.round(p.forme), H = p.hauteur, W = kind === 0 ? H * 0.75 : H, t = p.epaisseur;
  const sw = slotWidth(t, p.serrage, p.trait);
  const base = silhouette(kind, W, H);
  const ys = crossY(base, W / 2).map((c) => c.y);
  const yTop = Math.min(...ys), yBot = Math.max(...ys), mid = (yTop + yBot) / 2;
  const a = notch(base, W / 2, sw, mid + 0.2, true), b = notch(base, W / 2, sw, mid - 0.2, false);
  // Trou d'attache sur l'axe, près du haut, dans la pièce à fente basse (elle garde son sommet).
  const piece = (pts: Pt[], withHole: boolean): Piece => ({
    w: W, h: H,
    draw: (x, y) => line(poly(pts.map(([px, py]) => [px + x, py + y] as Pt))) + (withHole && p.attache ? circle(x + W / 2, y + yTop + (kind === 0 || kind === 1 ? 7 : 4), 1) : ""),
  });
  return packed([piece(a, false), piece(b, true)],
    [`Deux pièces : fente du haut et fente du bas de ${f(sw)} mm, chacune sur la moitié de la hauteur (${f((yBot - yTop) / 2)} mm).`],
    [THICK, SLOT_FIT, "Assemblage : glissez la pièce à fente basse par-dessus la pièce à fente haute, à angle droit, jusqu'à ce que les bords du haut et du bas affleurent.",
      "Pas de colle si l'emboîtement est serré (on peut la ranger à plat) ; sinon une goutte de vinylique au fond de chaque fente.", "Décoration suspendue : nouez un fil dans le petit trou, près de la pointe.", SAND, FINISH]);
}

// ─── Polyèdres : faces et connecteurs à fentes ────────────────────────────────────────────────────────────────────
const SOLIDS: { label: string; faces: number; sides: number; edges: number; dihedral: number }[] = [
  { label: "Tétraèdre", faces: 4, sides: 3, edges: 6, dihedral: Math.acos(1 / 3) },
  { label: "Cube", faces: 6, sides: 4, edges: 12, dihedral: Math.PI / 2 },
  { label: "Octaèdre", faces: 8, sides: 3, edges: 12, dihedral: Math.acos(-1 / 3) },
  { label: "Dodécaèdre", faces: 12, sides: 5, edges: 30, dihedral: Math.acos(-1 / Math.sqrt(5)) },
  { label: "Icosaèdre", faces: 20, sides: 3, edges: 30, dihedral: Math.acos(-Math.sqrt(5) / 3) },
];
/** Géométrie des connecteurs : demi-largeur `h`, recul des faces `s0`, profondeur des fentes `d`. */
export function polyhedronJoint(t: number, dihedral: number): { h: number; s0: number; d: number; len: number } {
  const h = (t + 5) / 2, half = dihedral / 2;
  const s0 = (h + t) / Math.tan(half) + 0.5;
  const d = Math.max(4, 1.5 * t);
  return { h, s0, d, len: s0 + 2 * d };
}
/** Connecteur en V : deux bras à l'angle dièdre, une fente en bout de chaque bras. */
function connectorPts(t: number, sw: number, dihedral: number): Pt[] {
  const { h, d, len: L } = polyhedronJoint(t, dihedral);
  const s = Math.sin(dihedral / 2), c = Math.cos(dihedral / 2);
  const u1: Pt = [-s, c], u2: Pt = [s, c], n1: Pt = [-c, -s], n2: Pt = [c, -s];
  const at = (u: Pt, a: number, n: Pt, b: number): Pt => [u[0] * a + n[0] * b, u[1] * a + n[1] * b];
  return [
    [0, -h / s],
    at(u1, L, n1, h), at(u1, L, n1, sw / 2), at(u1, L - d, n1, sw / 2), at(u1, L - d, n1, -sw / 2), at(u1, L, n1, -sw / 2), at(u1, L, n1, -h),
    [0, h / s],
    at(u2, L, n2, -h), at(u2, L, n2, -sw / 2), at(u2, L - d, n2, -sw / 2), at(u2, L - d, n2, sw / 2), at(u2, L, n2, sw / 2), at(u2, L, n2, h),
  ];
}
/** Polygone régulier convexe avec une fente au milieu de chaque côté, perpendiculaire au côté. */
function slottedPolygon(cx: number, cy: number, n: number, apothem: number, sw: number, depth: number): Pt[] {
  const R = apothem / Math.cos(Math.PI / n);
  const v = ngon(cx, cy, R, n, -Math.PI / 2 + Math.PI / n);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = v[i], b = v[(i + 1) % n];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
    const ix = (cx - mx) / apothem, iy = (cy - my) / apothem;
    out.push(a, [mx - (ux * sw) / 2, my - (uy * sw) / 2], [mx - (ux * sw) / 2 + ix * depth, my - (uy * sw) / 2 + iy * depth],
      [mx + (ux * sw) / 2 + ix * depth, my + (uy * sw) / 2 + iy * depth], [mx + (ux * sw) / 2, my + (uy * sw) / 2]);
  }
  return out;
}

function polyhedron(p: Record<string, number>): Pattern {
  const S = SOLIDS[Math.round(p.solide)], t = p.epaisseur, sw = slotWidth(t, p.serrage, p.trait);
  const J = polyhedronJoint(t, S.dihedral);
  const tanN = Math.tan(Math.PI / S.sides);
  // Arête minimale : la face réelle (reculée de s0) doit garder au moins 2 bras de connecteur de côté.
  const aMin = 2 * tanN * (J.s0 + J.d + 4) + 0.01;
  const minSide = 2 * J.h + 6;
  const a = Math.max(p.arete, aMin, (minSide / (2 * tanN) + J.s0) * 2 * tanN);
  const apo = a / (2 * tanN) - J.s0;
  const R = apo / Math.cos(Math.PI / S.sides);
  const conn = connectorPts(t, sw, S.dihedral);
  const xs = conn.map((q) => q[0]), ys = conn.map((q) => q[1]);
  const cx0 = Math.min(...xs), cy0 = Math.min(...ys), cw = Math.max(...xs) - cx0, ch = Math.max(...ys) - cy0;
  const face: Piece = {
    w: 2 * R, h: 2 * R,
    draw: (x, y) => {
      const cx = x + R, cy = y + R;
      let s = line(poly(slottedPolygon(cx, cy, S.sides, apo, sw, J.d)));
      const inner = apo - J.d - Math.max(4, t * 1.5);
      if (p.ajours === 1 && inner > 3) s += circle(cx, cy, inner);
      else if (p.ajours === 2 && inner > 3) s += line(poly(ngon(cx, cy, inner / Math.cos(Math.PI / S.sides), S.sides, -Math.PI / 2 + Math.PI / S.sides)));
      else if (p.ajours === 3 && inner > 6) s += line(starPath(cx, cy, inner, inner * 0.5, S.sides, -90));
      return s;
    },
  };
  const connector: Piece = { w: cw, h: ch, draw: (x, y) => line(poly(conn.map(([px, py]) => [px - cx0 + x, py - cy0 + y] as Pt))) };
  const pieces = [...Array.from({ length: S.faces }, () => face), ...Array.from({ length: S.edges }, () => connector)];
  return packed(pieces,
    [`${S.label} : ${S.faces} faces et ${S.edges} connecteurs (angle ${f((S.dihedral * 180) / Math.PI)}°), arête ${f(a)} mm${a > p.arete + 0.01 ? " (agrandie au minimum possible pour cette épaisseur)" : ""}.`,
      `Fentes de ${f(sw)} mm, profondeur ${f(J.d)} mm.`],
    [THICK, SLOT_FIT, "Tous les connecteurs sont identiques : chaque bras reçoit une face par sa fente, les deux fentes se croisent à mi-profondeur.",
      "Ordre : montez d'abord une face et tous ses connecteurs, puis ajoutez les faces voisines une à une en faisant le tour ; la dernière face se glisse en écartant doucement les voisines.",
      "Aucune colle si c'est serré : le solide se démonte. Pour un objet définitif, une goutte de cyanoacrylate (acrylique, carton) ou de vinylique (bois) à chaque croisement, une fois tout monté.",
      "Carton gris de 1,5 à 2 mm ou contreplaqué 3 mm : léger et facile. Les ajours en font une lanterne (LED uniquement, jamais d'ampoule à filament).", SAND],
    p.arete > 150 ? 400 : 380);
}

// ─── Abat-jour en modules à fentes ────────────────────────────────────────────────────────────────────────────────
function lampshade(p: Record<string, number>): Pattern {
  const N = Math.round(p.modules), D = p.diametre, H = p.hauteur, t = p.epaisseur, e = p.depasse;
  const theta = (2 * Math.PI) / N;
  // Deux modules voisins se croisent à 360/N degrés : la fente doit laisser passer l'épaisseur vue en biais.
  const sw = Math.max(0.3, t / Math.sin(theta) - p.serrage - p.trait);
  const chord = D * Math.sin(Math.PI / N), Lm = chord + 2 * e;
  const depth = H / 2;
  const module: Piece = {
    w: Lm, h: H,
    draw: (x, y) => {
      const xa = x + e, xb = x + Lm - e;
      const pts: Pt[] = [[x, y], [xa - sw / 2, y], [xa - sw / 2, y + depth], [xa + sw / 2, y + depth], [xa + sw / 2, y], [x + Lm, y], [x + Lm, y + H],
        [xb + sw / 2, y + H], [xb + sw / 2, y + H - depth], [xb - sw / 2, y + H - depth], [xb - sw / 2, y + H], [x, y + H]];
      let s = line(poly(pts));
      const x0 = xa + sw / 2 + 4, x1 = xb - sw / 2 - 4, y0 = y + 6, y1 = y + H - 6;
      const zw = x1 - x0, zh = y1 - y0;
      if (p.ajours && zw > 6 && zh > 10) {
        const k = Math.max(1, Math.round(zh / Math.max(8, zw)));
        for (let i = 0; i < k; i++) {
          const cy = y0 + (zh * (i + 0.5)) / k, cx = (x0 + x1) / 2, r = Math.min(zw, zh / k) / 2 - 1.5;
          if (r < 2) continue;
          if (p.ajours === 1) s += circle(cx, cy, r);
          else if (p.ajours === 2) s += line(poly([[cx, cy - r], [cx + r * 0.7, cy], [cx, cy + r], [cx - r * 0.7, cy]]));
          else s += line(roundRect(cx - r * 0.35, cy - r, r * 0.7, 2 * r, r * 0.35));
        }
      }
      return s;
    },
  };
  return packed(Array.from({ length: N }, () => module),
    [`${N} modules identiques de ${f(Lm)} × ${f(H)} mm ; anneau de Ø ${f(D)} mm aux croisements.`, `Fentes de ${f(sw)} mm (élargies pour le croisement à ${f(360 / N)}°), profondeur ${f(depth)} mm : la moitié du module.`],
    [THICK, SLOT_FIT, "Assemblage : chaque module a une fente en haut à gauche et une en bas à droite. Engagez la fente basse d'un module dans la fente haute du suivant, toujours dans le même sens, jusqu'à fermer l'anneau ; le dernier croisement se fait en écartant légèrement l'anneau.",
      "Pas de colle si l'emboîtement tient : l'abat-jour se range à plat. Pour le figer, une goutte de cyanoacrylate (ou de vinylique sur le bois) à chaque croisement, par l'intérieur.",
      "Suspension : un kit de suspension avec anneau porte-abat-jour (ou trois fils de nylon noués dans des trous percés en haut des modules), la douille centrée.",
      "Sécurité : LED uniquement (moins de 10 W, elle chauffe peu), au moins 5 cm entre l'ampoule et les modules ; jamais d'ampoule à filament ni halogène dans du bois, du carton ou du papier.",
      "Matière : contreplaqué peuplier 3 mm, carton ou polypropylène translucide 0,8 mm (diffuse bien la lumière, découpe sans brûler).", SAND]);
}

const P = (key: string, label: string, min: number, max: number, step: number, def: number, unit?: string): ParamSpec => ({ key, label, min, max, step, default: def, unit });
/** Paramètre à choix : valeur = index dans `options`. */
const C = (key: string, label: string, options: readonly string[], def = 0): ParamSpec => ({ key, label, min: 0, max: options.length - 1, step: 1, default: def, options: [...options] });
const OUI_NON = ["Non", "Oui"];
const MOTIF = C("motif", "Motif", ["Aucun", "Cœur", "Étoile", "Fleur", "Rosace"], 1);

// ─── Boîtes, assemblages et formes : définitions ─────────────────────────────────────────────────────────────
const EP = P("epaisseur", "Épaisseur", 1, 10, 0.1, 3, "mm");
const CRENEAU = P("creneau", "Créneau", 3, 30, 1, 8, "mm");
const SERRAGE = P("serrage", "Serrage", 0, 0.5, 0.01, 0.05, "mm");
const TRAIT = P("trait", "Trait (largeur de coupe)", 0, 0.4, 0.01, 0.1, "mm");
const DIMS = (w: number, d: number, h: number) => [P("largeur", "Largeur", 20, 300, 5, w, "mm"), P("profondeur", "Profondeur", 20, 300, 5, d, "mm"), P("hauteur", "Hauteur", 10, 200, 5, h, "mm")];
const ASSEMBLAGES: PatternDef[] = [
  { id: "boite-charniere", family: "assemblages", label: "Boîte à charnière", description: "Boîte à encoches dont le couvercle d'une pièce se plie grâce à une charnière vivante (fentes souples).", build: hingeBox,
    params: [...DIMS(80, 50, 40), EP, CRENEAU, P("pas", "Écart des fentes", 0.8, 4, 0.1, 1.5, "mm"), P("pont", "Ponts", 1.5, 8, 0.5, 3, "mm"), MOTIF] },
  { id: "boite-coulissante", family: "assemblages", label: "Boîte à couvercle coulissant", description: "Boîte à encoches, couvercle qui glisse entre rails et rebords, encoche pour le pouce.", build: slideBox,
    params: [...DIMS(70, 100, 40), EP, CRENEAU, MOTIF] },
  { id: "boite-couvercle", family: "assemblages", label: "Boîte à couvercle emboîtant", description: "Boîte à encoches et couvercle à bouchon qui s'emboîte, bouton en option.", build: lidBox,
    params: [...DIMS(70, 70, 40), EP, CRENEAU, P("jeu", "Jeu du bouchon", 0.1, 1, 0.05, 0.25, "mm"), P("debord", "Débord du dessus", 0, 10, 0.5, 2, "mm"), C("bouton", "Bouton", OUI_NON, 1), MOTIF] },
  { id: "boite-tiroir", family: "assemblages", label: "Boîte à tiroir", description: "Caisson à encoches ouvert à l'avant et son tiroir, façade avec prise.", build: drawerBox,
    params: [...DIMS(90, 100, 45), EP, CRENEAU, C("poignee", "Prise", ["Trou de bouton", "Prise découpée"], 1)] },
  { id: "boite-polygone", family: "assemblages", label: "Boîte polygonale", description: "Boîte hexagonale (ou de 5 à 12 côtés) : parois à tenons dans un fond à mortaises, couvercle à bouchon.", build: polyBox,
    params: [P("cotes", "Côtés", 5, 12, 1, 6), P("cote", "Longueur d'un côté", 15, 150, 1, 40, "mm"), P("hauteur", "Hauteur", 10, 200, 1, 40, "mm"), EP, SERRAGE, TRAIT,
      C("couvercle", "Couvercle", ["Aucun", "Bouchon", "Fermée (collée)"], 1), MOTIF] },
  { id: "croisillon", family: "assemblages", label: "Forme 3D à fentes croisées", description: "Deux silhouettes (sapin, étoile, boule, cœur) qui s'emboîtent à angle droit par des fentes à mi-hauteur.", build: crossShape,
    params: [C("forme", "Forme", ["Sapin", "Étoile", "Boule", "Cœur"], 0), P("hauteur", "Hauteur", 30, 300, 1, 100, "mm"), EP, SERRAGE, TRAIT, C("attache", "Trou d'attache", OUI_NON, 1)] },
  { id: "polyedre", family: "assemblages", label: "Polyèdre à connecteurs", description: "Solide de Platon (tétraèdre, cube, octaèdre, dodécaèdre, icosaèdre) : faces à fentes tenues par des connecteurs en V, ajours en option (lanterne).", build: polyhedron,
    params: [C("solide", "Solide", SOLIDS.map((s) => s.label), 1), P("arete", "Arête", 30, 250, 1, 80, "mm"), EP, SERRAGE, TRAIT, C("ajours", "Ajours", ["Aucun", "Rond", "Polygone", "Étoile"], 0)] },
  { id: "abat-jour", family: "assemblages", label: "Abat-jour en modules", description: "Modules identiques qui s'accrochent les uns aux autres par des fentes croisées pour former un anneau d'abat-jour ajouré.", build: lampshade,
    params: [P("modules", "Modules", 6, 24, 1, 12), P("diametre", "Diamètre", 80, 500, 5, 200, "mm"), P("hauteur", "Hauteur", 40, 300, 5, 120, "mm"), P("depasse", "Dépassement aux croisements", 5, 40, 1, 12, "mm"),
      EP, SERRAGE, TRAIT, C("ajours", "Ajours", ["Aucun", "Ronds", "Losanges", "Fentes"], 1)] },
  { id: "formes", family: "objets", label: "Formes géométriques", description: "Polygones réguliers, étoiles ou cercles, seuls ou en couronnes emboîtées à empiler, torsion et trou en option.", build: shapes,
    params: [C("forme", "Forme", ["Polygone", "Étoile", "Cercle"], 0), P("cotes", "Côtés / branches", 3, 16, 1, 6), P("taille", "Taille", 10, 400, 1, 100, "mm"), P("nombre", "Couronnes", 1, 30, 1, 1),
      P("pas", "Largeur des couronnes", 1, 50, 0.5, 8, "mm"), P("torsion", "Torsion par couronne (polygone)", -30, 30, 0.5, 0, "°"), P("creux", "Creux de l'étoile", 0.2, 0.9, 0.05, 0.45), P("trou", "Trou central", 0, 50, 0.5, 0, "mm")] },
];

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
  return { svg: svgDoc(w, h, body), widthMm: w, heightMm: h, notes: [`${opt.length} tracés gravés au trait.`, ...(o.notes ?? [])], advice: ADVICE.motif };
}

/** Zone utile (mm) d'un motif selon son cadre : la marge laissée au cadre, et le format carré d'un disque. */
function zone(p: Record<string, number>): { w: number; h: number; m: number } {
  const round = p.cadre === 2 || p.cadre === 4;
  const D = Math.min(p.largeur, p.hauteur);
  const m = p.cadre ? Math.max(2, D * 0.04) : 0;
  return { w: (round ? D : p.largeur) - 2 * m, h: (round ? D : p.hauteur) - 2 * m, m };
}
const shift = (lines: Polyline[], m: number): Polyline[] => (m ? lines.map((l) => l.map(([x, y]) => [x + m, y + m] as [number, number])) : lines);

const MOTIFS: PatternDef[] = [
  { id: "subdivision", family: "motifs", label: "Subdivision", description: "L'espace découpé récursivement en sous-espaces enfants : coupes, quadtree, triangles, polygones, cercles dans les cercles ; feuilles remplies.",
    params: [...FORMAT, C("mode", "Découpage", SUBDIV_MODES, 0), P("profondeur", "Profondeur max.", 1, 12, 1, 6), P("minimum", "Profondeur min.", 0, 12, 1, 2),
      P("chance", "Chance de se diviser", 0, 100, 1, 70, "%"), P("irregularite", "Irrégularité des coupes", 0, 100, 1, 60, "%"), P("enfants", "Enfants (cercles, triangles)", 2, 12, 1, 4),
      P("retrait", "Marge entre enfants", 0, 10, 0.1, 0, "mm"), C("remplissage", "Remplissage des feuilles", LEAF_FILLS, 0), P("pas", "Pas du remplissage", 0.3, 10, 0.1, 1.5, "mm"), GRAINE, ECART],
    build: (p) => {
      const z = zone(p);
      return strokes(shift(subdivide({ mode: p.mode, depth: p.profondeur, minDepth: Math.min(p.minimum, p.profondeur), chance: p.chance, ratio: p.irregularite, inset: p.retrait,
        leaf: p.remplissage, leafStep: p.pas, children: p.enfants, w: z.w, h: z.h, seed: p.graine }), z.m), p, { fit: false });
    } },
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
  { id: "boite", family: "assemblages", label: "Boîte à encoches", description: "Six panneaux qui s'emboîtent, couvercle gravé.", build: box,
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
  ...ASSEMBLAGES,
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
