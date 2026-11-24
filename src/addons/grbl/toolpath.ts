import { offset, ringsToMulti, type Pt, type Ring } from "../vector";
import { islands, orderBlocks, orderPaths as order } from "./order";
import { parseSvgDocument, type SvgRawShape } from "../vectorize";
import { dither, type DitherMode } from "../../shared/raster1bit";
import { num } from "./codec";

/**
 * Du dessin au programme G-code : formes d'un SVG (traits suivis, surfaces hachurées) ou image (balayage ligne
 * à ligne). Fonctions pures, en millimètres, origine en bas à gauche (axe Y vers le fond de la machine).
 */

export type LaserMode = "auto" | "line" | "fill" | "skip";

export type LaserOp = {
  /** Couleur visée (`#rrggbb`) ; absente pour les réglages par défaut. */
  color?: string;
  /** `line` suit le trait ou le contour, `fill` hachure la surface, `auto` : trait pour un contour, hachures pour un remplissage. */
  mode: LaserMode;
  /** Puissance en % de la pleine puissance. */
  power: number;
  /** Vitesse en mm/min. */
  speed: number;
  passes: number;
  /** Écart entre deux lignes de hachure, en mm. */
  interval: number;
  /** Décalage du contour en mm (positif : vers l'extérieur) pour compenser la largeur du trait de coupe. */
  kerf: number;
};

export type ToolpathSettings = LaserOp & {
  tool: "laser" | "pen";
  /** Réglages par couleur, dans l'ordre d'exécution (la découpe en dernier). */
  ops: LaserOp[];
  /** Taille voulue en mm (0 : taille réelle du document) ; les proportions sont gardées. */
  widthMm: number;
  heightMm: number;
  /** Position du coin bas gauche, en mm. */
  xMm: number;
  yMm: number;
  /** `content` : cadre = emprise des formes ; `document` : cadre = page du SVG. */
  frame: "content" | "document";
  /** Valeur S de pleine puissance (`$30` de la machine). */
  maxS: number;
  /** Vitesse des déplacements faisceau éteint, pour l'estimation de durée. */
  travelSpeed: number;
  /** Le blanc ne brûle pas : formes blanches ignorées. */
  skipWhite: boolean;
  /** Retour à l'origine en fin de programme. */
  returnHome: boolean;
  /** Traceur : valeur S stylo baissé, et pause après chaque mouvement du stylo, en secondes. */
  penS: number;
  penDwellS: number;
};

export const TOOLPATH_DEFAULTS: ToolpathSettings = {
  tool: "laser", mode: "auto", power: 20, speed: 1500, passes: 1, interval: 0.1, kerf: 0, ops: [],
  widthMm: 0, heightMm: 0, xMm: 0, yMm: 0, frame: "content", maxS: 1000, travelSpeed: 3000, skipWhite: true, returnHome: true,
  penS: 1000, penDwellS: 0.15,
};

export const MAX_GCODE_LINES = 1_200_000;
const MAX_KERF_POINTS = 4000;

export type ToolPath = { pts: Pt[]; closed: boolean };
export type ToolPass = { op: LaserOp; kind: "line" | "fill"; paths: ToolPath[] };
/** Couleur rencontrée dans le dessin : nombre de formes remplies et de traits de cette couleur. */
export type FoundColor = { color: string; fill: number; stroke: number };

export type ToolpathResult = {
  lines: string[]; issues: string[]; error: string | null; sizeMm: { w: number; h: number } | null; skipped: Record<string, number>;
  /** Couleurs du dessin (blanc compris), des plus présentes aux moins présentes. */
  colors: FoundColor[];
};

/** Couleurs d'un dessin, avec le nombre de surfaces et de traits de chacune. */
export function colorsOf(doc: SvgShapes, max = 32): FoundColor[] {
  const map = new Map<string, FoundColor>();
  const at = (c: string) => map.get(c) ?? (map.set(c, { color: c, fill: 0, stroke: 0 }), map.get(c) as FoundColor);
  for (const sh of doc.shapes) {
    if (sh.fill) at(sh.fill).fill++;
    if (sh.stroke) at(sh.stroke).stroke++;
  }
  return [...map.values()].sort((a, b) => b.fill + b.stroke - (a.fill + a.stroke)).slice(0, max);
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** `#F00`, `#ff0000`, `FF0000` → `#ff0000` ; `null` si ce n'est pas une couleur hexadécimale. */
export function hexColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return "#" + (h.length === 3 ? h.split("").map((c) => c + c).join("") : h);
}

/** Réglages d'une opération, bornés. Les champs absents viennent de `base`. */
export function cleanOp(raw: Record<string, unknown>, base: LaserOp): LaserOp {
  const n = (k: keyof LaserOp, min: number, max: number): number => {
    const v = raw[k];
    return v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v)) ? clamp(Number(v), min, max) : (base[k] as number);
  };
  const mode = ["auto", "line", "fill", "skip"].includes(raw.mode as string) ? (raw.mode as LaserMode) : base.mode;
  const op: LaserOp = { mode, power: n("power", 0, 100), speed: n("speed", 10, 20000), passes: Math.round(n("passes", 1, 50)), interval: n("interval", 0.03, 10), kerf: n("kerf", -5, 5) };
  const color = hexColor(raw.color);
  if (color) op.color = color;
  return op;
}

// ─── Lecture du SVG ──────────────────────────────────────────────────────────────────────────────────────────────
export type SvgShapes = { shapes: SvgRawShape[]; width: number; height: number; unitMm: number; skipped: Record<string, number> };

/** Formes d'un document SVG, et le nombre de millimètres par unité du document. */
export function readSvgShapes(text: string): SvgShapes {
  const shapes: SvgRawShape[] = [];
  const doc = parseSvgDocument(text, { raw: (s) => shapes.push(s), precision: 8000 });
  // Taille réelle : `width` avec unité rapportée au viewBox ; à défaut, 96 unités par pouce.
  const w = doc.physical?.widthMm, h = doc.physical?.heightMm;
  const unitMm = w && doc.width > 0 ? w / doc.width : h && doc.height > 0 ? h / doc.height : 25.4 / 96;
  return { shapes, width: doc.width, height: doc.height, unitMm, skipped: doc.skipped };
}

// ─── Hachures ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Remplit des contours (règle pair-impair) de segments horizontaux espacés de `interval`, en serpentin. */
export function hatch(rings: Ring[], interval: number): [Pt, Pt][] {
  let minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const out: [Pt, Pt][] = [];
  if (!Number.isFinite(minY) || interval <= 0) return out;
  let flip = false;
  for (let y = minY + interval / 2; y < maxY; y += interval) {
    const xs: number[] = [];
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    const row: [Pt, Pt][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 0.01) row.push([[xs[i], y], [xs[i + 1], y]]);
    if (!row.length) continue;
    if (flip) for (let i = row.length - 1; i >= 0; i--) out.push([row[i][1], row[i][0]]);
    else out.push(...row);
    flip = !flip;
  }
  return out;
}

// ─── Ordre des parcours ──────────────────────────────────────────────────────────────────────────────────────────
/** Intérieurs d'abord, puis au plus proche (voir `order.ts`). */
export function orderPaths(paths: ToolPath[], from: Pt = [0, 0]): ToolPath[] {
  return order(paths, from);
}

// ─── Du SVG aux passes ───────────────────────────────────────────────────────────────────────────────────────────
function opFor(color: string, s: ToolpathSettings): LaserOp {
  return s.ops.find((o) => o.color === color) ?? { mode: s.mode, power: s.power, speed: s.speed, passes: s.passes, interval: s.interval, kerf: s.kerf };
}

export function planVector(doc: SvgShapes, s: ToolpathSettings): { passes: ToolPass[]; issues: string[]; sizeMm: { w: number; h: number } | null } {
  const issues: string[] = [];
  type Item = { op: LaserOp; kind: "line" | "fill"; lines: { ring: Ring; closed: boolean }[]; key: string };
  const items: Item[] = [];
  const white = (c: string): boolean => s.skipWhite && c === "#ffffff";
  for (const shape of doc.shapes) {
    if (shape.stroke && !white(shape.stroke)) {
      const op = opFor(shape.stroke, s);
      if (op.mode !== "skip") items.push({ op, kind: "line", lines: shape.lines, key: `line${shape.stroke}` });
    }
    if (shape.fill && !white(shape.fill)) {
      const op = opFor(shape.fill, s);
      if (op.mode === "line") items.push({ op, kind: "line", lines: shape.lines.map((l) => ({ ring: l.ring, closed: true })), key: `line${shape.fill}` });
      else if (op.mode !== "skip") items.push({ op, kind: "fill", lines: shape.lines, key: `fill${shape.fill}` });
    }
  }
  if (!items.length) return { passes: [], issues, sizeMm: null };

  // Cadre : emprise des formes retenues, ou page du document.
  let fx = 0, fy = 0, fw = doc.width, fh = doc.height;
  if (s.frame === "content" || !(fw > 0 && fh > 0)) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) for (const l of it.lines) for (const p of l.ring) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    fx = x0; fy = y0; fw = Math.max(x1 - x0, 1e-9); fh = Math.max(y1 - y0, 1e-9);
  }
  let k = doc.unitMm;
  if (s.widthMm > 0 && s.heightMm > 0) k = Math.min(s.widthMm / fw, s.heightMm / fh);
  else if (s.widthMm > 0) k = s.widthMm / fw;
  else if (s.heightMm > 0) k = s.heightMm / fh;
  const map = (p: Pt): Pt => [(p[0] - fx) * k + s.xMm, (fh - (p[1] - fy)) * k + s.yMm];

  const groups = new Map<string, ToolPass>();
  const fillBlocks = new Map<ToolPass, ToolPath[][]>();
  let kerfSkipped = false;
  for (const it of items) {
    let pass = groups.get(it.key);
    if (!pass) groups.set(it.key, (pass = { op: it.op, kind: it.kind, paths: [] }));
    let blocks = fillBlocks.get(pass);
    if (!blocks) fillBlocks.set(pass, (blocks = []));
    const lines = it.lines.map((l) => ({ ring: l.ring.map(map), closed: l.closed })).filter((l) => l.ring.length >= 2);
    if (it.kind === "fill") {
      // Une île (forme et ses trous) à la fois, en serpentin : la tête ne traverse pas tout le dessin à chaque ligne.
      for (const island of islands(lines.map((l) => l.ring).filter((r) => r.length >= 3))) {
        const segs = hatch(island, it.op.interval).map(([a, b]) => ({ pts: [a, b], closed: false }));
        if (segs.length) blocks.push(segs);
      }
      continue;
    }
    const closedRings = lines.filter((l) => l.closed && l.ring.length >= 3);
    const points = closedRings.reduce((n, l) => n + l.ring.length, 0);
    if (it.op.kerf !== 0 && closedRings.length) {
      if (points > MAX_KERF_POINTS) kerfSkipped = true;
      else {
        // Compensation du trait : contours fermés décalés ; les traits ouverts restent tels quels.
        for (const poly of offset(ringsToMulti(closedRings.map((l) => l.ring)), it.op.kerf)) for (const ring of poly) if (ring.length >= 3) pass.paths.push({ pts: ring, closed: true });
        for (const l of lines) if (!(l.closed && l.ring.length >= 3)) pass.paths.push({ pts: l.ring, closed: false });
        continue;
      }
    }
    for (const l of lines) pass.paths.push({ pts: l.ring, closed: l.closed && l.ring.length >= 3 });
  }
  if (kerfSkipped) issues.push("compensation du trait (kerf) ignorée : forme trop détaillée");

  // Ordre : hachures d'abord, puis traits ; à l'intérieur, les couleurs sans réglage propre puis l'ordre de `ops`.
  const rank = (p: ToolPass): number => {
    const at = p.op.color ? s.ops.findIndex((o) => o.color === p.op.color) : -1;
    return (p.kind === "fill" ? 0 : 1000) + at + 1;
  };
  // Ordre dans chaque passe, la tête partant de là où la passe précédente l'a laissée.
  const passes = [...groups.values()];
  let at: Pt = [0, 0];
  const ordered = passes.sort((a, b) => rank(a) - rank(b)).map((p) => {
    p.paths = p.kind === "fill" ? orderBlocks(fillBlocks.get(p) ?? [], at) : orderPaths(p.paths, at);
    const last = p.paths[p.paths.length - 1];
    if (last) at = last.closed ? last.pts[0] : last.pts[last.pts.length - 1];
    return p;
  }).filter((p) => p.paths.length);
  return { passes: ordered, issues, sizeMm: { w: Math.round(fw * k * 100) / 100, h: Math.round(fh * k * 100) / 100 } };
}

// ─── Écriture du G-code ──────────────────────────────────────────────────────────────────────────────────────────
const xy = (p: Pt): string => `X${num(p[0])}Y${num(p[1])}`;

export function emitPasses(passes: ToolPass[], s: ToolpathSettings): string[] | null {
  const pen = s.tool === "pen";
  const out: string[] = ["G90", "G21", "M5"];
  if (!pen) out.push("M4S0");
  const dwell = `G4P${num(clamp(s.penDwellS, 0, 5))}`;
  for (const pass of passes) {
    // Commentaire lu par l'aperçu (couleur de l'opération) ; retiré avant l'envoi à la machine.
    if (pass.op.color) out.push(`;op ${pass.op.color}`);
    const power = `S${num(Math.round((clamp(pass.op.power, 0, 100) / 100) * s.maxS))}`;
    const feed = `F${num(pass.op.speed)}`;
    const trace = (path: ToolPath): void => {
      out.push(`G0${xy(path.pts[0])}`);
      if (pen) out.push(`M3S${num(s.penS)}`, dwell);
      const pts = path.closed ? [...path.pts.slice(1), path.pts[0]] : path.pts.slice(1);
      for (let i = 0; i < pts.length; i++) out.push(i === 0 ? `G1${xy(pts[i])}${pen ? "" : power}${feed}` : `G1${xy(pts[i])}`);
      if (pen) out.push("M5", dwell);
    };
    if (pass.kind === "line") {
      // Contours : toutes les passes d'un tracé à la suite, sans trajet entre elles (un trait ouvert repart dans
      // l'autre sens) ; le G0 de reprise est sur place.
      for (const path of pass.paths) {
        if (path.pts.length < 2) continue;
        for (let rep = 0; rep < pass.op.passes; rep++) trace(path.closed || rep % 2 === 0 ? path : { pts: [...path.pts].reverse(), closed: false });
        if (out.length > MAX_GCODE_LINES) return null;
      }
      continue;
    }
    for (let rep = 0; rep < pass.op.passes; rep++) {
      for (const path of pass.paths) {
        if (path.pts.length < 2) continue;
        trace(path);
        if (out.length > MAX_GCODE_LINES) return null;
      }
    }
  }
  out.push("M5");
  if (s.returnHome) out.push("G0X0Y0");
  return out;
}

/** SVG (texte) → programme. Ne lève pas : `error` renseignée si le document est illisible ou vide. */
export function svgToGcode(text: string, s: ToolpathSettings): ToolpathResult {
  let doc: SvgShapes;
  try {
    doc = readSvgShapes(text);
  } catch (e) {
    return { lines: [], issues: [], error: e instanceof Error ? e.message : "SVG illisible", sizeMm: null, skipped: {}, colors: [] };
  }
  const colors = colorsOf(doc);
  const plan = planVector(doc, s);
  if (!plan.passes.length) {
    const error = colors.some((c) => c.color !== "#ffffff") ? "aucune couleur du dessin n'est attribuée à une opération" : "aucune forme à tracer dans ce dessin";
    return { lines: [], issues: plan.issues, error, sizeMm: null, skipped: doc.skipped, colors };
  }
  const lines = emitPasses(plan.passes, s);
  if (!lines) return { lines: [], issues: plan.issues, error: `programme trop long (${MAX_GCODE_LINES} lignes au plus) : augmenter interval ou simplifier le dessin`, sizeMm: plan.sizeMm, skipped: doc.skipped, colors };
  return { lines, issues: plan.issues, error: null, sizeMm: plan.sizeMm, skipped: doc.skipped, colors };
}

// ─── Image : balayage ────────────────────────────────────────────────────────────────────────────────────────────
export type RasterSettings = {
  /** Largeur gravée en mm ; la hauteur suit les proportions de l'image. */
  widthMm: number;
  xMm: number;
  yMm: number;
  /** `gray` : puissance proportionnelle au gris ; sinon tramage 1 bit (`DITHER_MODES` de shared/raster1bit). */
  dither: DitherMode | "gray";
  threshold: number;
  power: number;
  /** Puissance du gris le plus clair gravé, en % (mode `gray`). */
  minPower: number;
  speed: number;
  maxS: number;
  returnHome: boolean;
};

/**
 * Image en niveaux de gris (`cols × rows`, 255 = blanc) → programme de balayage en serpentin : un point de
 * l'image par pas de `widthMm / cols`, lignes blanches sautées, blancs en bout de ligne non parcourus.
 */
export function rasterToGcode(gray: Float32Array, cols: number, rows: number, s: RasterSettings): string[] | null {
  const px = s.widthMm / cols;
  const full = Math.round((clamp(s.power, 0, 100) / 100) * s.maxS);
  const low = Math.round((clamp(s.minPower, 0, s.power) / 100) * s.maxS);
  const levels = new Uint16Array(cols * rows);
  if (s.dither === "gray") {
    for (let i = 0; i < levels.length; i++) {
      const g = gray[i];
      // 32 niveaux : des plages assez longues pour ne pas saturer la machine de petits segments.
      levels[i] = g >= 250 ? 0 : Math.round(low + ((full - low) * Math.round((1 - g / 255) * 31)) / 31);
    }
  } else {
    const bits = dither(gray, cols, rows, s.dither, s.threshold).bits;
    for (let i = 0; i < levels.length; i++) levels[i] = bits[i] ? full : 0;
  }
  const out: string[] = ["G90", "G21", "M5", "M4S0"];
  const feed = `F${num(s.speed)}`;
  const xAt = (c: number): string => num(s.xMm + c * px);
  let flip = false;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let first = -1, last = -1;
    for (let c = 0; c < cols; c++) if (levels[base + c]) { if (first < 0) first = c; last = c; }
    if (first < 0) continue;
    const y = num(s.yMm + (rows - 1 - r + 0.5) * px);
    let started = false;
    const run = (to: number, level: number): void => {
      out.push(`G1X${xAt(to)}S${level}${started ? "" : feed}`);
      started = true;
    };
    if (!flip) {
      out.push(`G0X${xAt(first)}Y${y}`);
      let c = first;
      while (c <= last) {
        const level = levels[base + c];
        let e = c + 1;
        while (e <= last && levels[base + e] === level) e++;
        run(e, level);
        c = e;
      }
    } else {
      out.push(`G0X${xAt(last + 1)}Y${y}`);
      let c = last;
      while (c >= first) {
        const level = levels[base + c];
        let e = c - 1;
        while (e >= first && levels[base + e] === level) e--;
        run(e + 1, level);
        c = e;
      }
    }
    flip = !flip;
    if (out.length > MAX_GCODE_LINES) return null;
  }
  if (out.length <= 4) return [];
  out.push("M5");
  if (s.returnHome) out.push("G0X0Y0");
  return out;
}
