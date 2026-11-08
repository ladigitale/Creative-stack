/**
 * Format « monde2d » : un monde 2D complet, dessiné pour la 2D (formes vectorielles, dégradés, motifs, relief,
 * contours, calques à parallaxe), lu par `sonic-2d` (clé `monde2d` du DataProvider ou attribut `monde2d`).
 *
 * Même esprit que le format « monde » 3D (modèles articulés, clips, placement, instances pilotées par `nodes`),
 * mais en unités de la scène 2D (px, y vers le bas, rotations en degrés dans le JSON, radians dans `nodes`).
 * Lecture tolérante : jamais d'exception, problèmes listés dans `issues`.
 */
import { DEG, Rand, hash32 } from "../monde/math";
import { isColor, own, readMonde, type Model } from "../monde/format";
import { GEN_IDS, genVariants, isGenId, type GenRig } from "../monde/gen";
import { readTex, type TexSpec } from "../monde/textures";
import type { Clip, ClipIn, Issue, Track } from "../monde/format";
import { PRESETS2D, type Preset2dOut } from "./presets";

export type Shape2Kind = "rect" | "ellipse" | "circle" | "capsule" | "poly" | "blob" | "path" | "star" | "arc" | "trait" | "text";
export const SHAPES2: Shape2Kind[] = ["rect", "ellipse", "circle", "capsule", "poly", "blob", "path", "star", "arc", "trait", "text"];

export type Part2In = {
  name?: string;
  parent?: string;
  /** Articulation dans le repère du parent (px). */
  at?: number[];
  /** Rotation de repos (degrés, sens horaire à l'écran). */
  rot?: number;
  /** Centre de la forme depuis l'articulation (px). */
  off?: number[];
  scale?: number | number[];
  /** Ordre de dessin dans l'instance (négatif : derrière le parent ; défaut : ordre d'écriture). */
  z?: number;
  role?: string;
  color?: string;
  /** Dégradé `[clair, foncé]` (de haut en bas, tourné de `gradAngle` degrés). */
  grad?: string[];
  gradAngle?: number;
  tex?: unknown;
  /** Épaisseur du contour (px) ; `stroke` sa couleur (défaut : couleur assombrie). */
  line?: number;
  stroke?: string;
  /** `false` : tracé seul (moustaches, lignes de terrain). */
  fill?: boolean;
  /** Relief automatique (ombre et reflet internes) ; défaut : celui du monde. */
  relief?: boolean;
  glow?: number;
  opacity?: number;
  /**
   * Dédoublement : `x` (gauche / droite en face), `y` (vue de dessus, regard vers +x), `z` (profil : même place,
   * copie `R` derrière, décalée de `mirrorZ`, assombrie de `mirrorShade`, animée en opposition sans inversion).
   */
  mirror?: "x" | "y" | "z";
  /** Décalage d'ordre de la copie droite d'un miroir (côté éloigné d'un profil : -1). */
  mirrorZ?: number;
  /** Assombrissement de la copie droite (côté éloigné). */
  mirrorShade?: number;
  repeat?: { n?: number; at?: number[]; rot?: number };
  hidden?: boolean;
} & Partial<Record<Shape2Kind, unknown>>;

export type Track2In = Partial<Record<"r" | "x" | "y" | "s" | "sx" | "sy" | "o", number[]>> & { sync?: boolean; phase?: number };
export type Clip2In = Omit<ClipIn, "tracks"> & { tracks?: Record<string, Track2In> };

export type Model2In = {
  preset?: string;
  /** Générateur procgen (`character`, `animal.dog`, `tree`, `building`…) dessiné en illustration vectorielle. */
  gen?: string;
  /** Modèle gen : vue `profil` (défaut), `face`, `dessus` (verticale) ou `plongee` (vue d'en haut inclinée). */
  vue?: string;
  /** Modèle gen : hauteur à l'écran (px) d'un objet de la taille du générateur (personnage ≈ 1,7 m). */
  taille?: number;
  /** Modèle gen en plongée : inclinaison (degrés, 90 = verticale). */
  pitch?: number;
  seed?: string | number;
  params?: Record<string, unknown>;
  parts?: Part2In[];
  clips?: Record<string, Clip2In>;
  clip?: string;
};

export type Place2In = {
  model?: string;
  /** Modèle `gen` : retouche de ses `params` pour ce placement (ex. `{ animal: "fox" }`). */
  params?: Record<string, unknown>;
  /** Modèle `gen` : graine propre à ce placement. */
  genSeed?: string | number;
  name?: string;
  at?: number[];
  rot?: number;
  scale?: number | number[];
  /** Retourné horizontalement (regard vers la gauche). */
  flip?: boolean;
  roles?: Record<string, string>;
  clip?: string;
  layer?: string;
  z?: number;
  hidden?: boolean;
  grid?: number[];
  step?: number[];
  scatter?: number;
  area?: number[];
  jitter?: number;
  turn?: number;
  size?: number[];
  seed?: string | number;
};

export type Layer2In = { name?: string; parallax?: number; ysort?: boolean };

export type Monde2dIn = {
  palette?: Record<string, string>;
  models?: Record<string, Model2In>;
  place?: Place2In[];
  layers?: Layer2In[];
  /** Fond : couleur ou dégradé `[haut, bas]`. */
  ciel?: string | string[];
  /** `plat` (défaut), `doux` (relief), `bd` (gros contour, relief), `encre` (contour noir, couleurs claires), `gouache` (relief, grain) ; ou un style vectoriel procgen (`flat`, `ligne-claire`, `gravure`, `affiche`, `papier-decoupe`), qui fixe aussi celui des modèles gen. */
  style?: string;
  /** Style vectoriel procgen des modèles gen (sinon déduit de `style`). */
  /** Style vectoriel des modèles `gen` : nom, ou réglages `{ vector, outline, tones, chroma… }`. */
  styleGen?: string | Record<string, unknown>;
  /** Cadence de redessin des modèles `gen` (défaut 24 images/s). */
  fpsGen?: number;
  /** Résolution des dessins `gen` (défaut 2 ; baisser pour alléger beaucoup d'acteurs). */
  resGen?: number;
  /** Importance des traits des modèles gen : 0 aucun, 1 style, jusqu'à 3. */
  traits?: number;
  outline?: number;
  relief?: boolean;
  textures?: Record<string, unknown>;
  texture?: unknown;
  /** Finesse des courbes : `low`, `mid`, `high`. */
  detail?: string;
};

/* ------------------------------------------------------------------ normalisé */

export type Shape2 = {
  kind: Shape2Kind;
  /** Contour aplati (repère de la pièce, `off` compris) : [x0, y0, x1, y1, …]. */
  pts: number[];
  closed: boolean;
  text?: string;
  size?: number;
};

export type Part2 = {
  name: string;
  parent: number;
  at: [number, number];
  rot: number;
  scale: [number, number];
  z: number;
  role: string;
  color: string;
  grad: [string, string] | null;
  gradAngle: number;
  tex: TexSpec | null;
  line: number;
  stroke: string;
  fill: boolean;
  relief: boolean | null;
  glow: number;
  opacity: number;
  shade: number;
  hidden: boolean;
  shape: Shape2 | null;
};

export type Model2 = {
  name: string;
  sig: string;
  parts: Part2[];
  clips: Map<string, Clip>;
  clip: string;
  roles: Record<string, string>;
  height: number;
  shadow: [number, number] | null;
  /** Modèle procgen (illustration vectorielle) ; ses os et clips sont ceux du format monde (`model3`). */
  gen: Gen2Spec | null;
  issues: Issue[];
};

export type Gen2Spec = {
  id: string;
  params: Record<string, unknown>;
  seed: string;
  rig: GenRig;
  view: "profil" | "face" | "dessus" | "plongee";
  /** Pixels par mètre. */
  pxPerM: number;
  pitch: number;
  /** Modèle du format monde (os = pièces, clips en pistes d'os) : pose partagée avec la 3D. */
  model3: Model;
};

export type Placement2 = {
  model: string;
  name: string;
  at: [number, number];
  rot: number;
  scale: [number, number];
  flip: boolean;
  roles: Record<string, string>;
  clip: string;
  layer: string;
  z: number;
  hidden: boolean;
  /** Rang d'écriture (ordre de dessin à `z` égal hors tri par y). */
  order: number;
};

export type Layer2 = { name: string; parallax: number; ysort: boolean };

export type Monde2d = {
  palette: Record<string, string>;
  models: Map<string, Model2>;
  place: Placement2[];
  layers: Layer2[];
  ciel: [string, string] | null;
  style: "plat" | "doux" | "bd" | "encre" | "gouache";
  /** Style vectoriel procgen des modèles gen. */
  styleGen: string | Record<string, unknown>;
  /** Clé de cache du style vectoriel (avec cadence et résolution). */
  styleKey: string;
  /** Cadence de redessin des modèles `gen` (images/s, 6 … 60). */
  fpsGen: number;
  /** Résolution des dessins `gen` (pixels par pixel d'écran, 0.5 … 3). */
  resGen: number;
  traits: number;
  outline: number;
  relief: boolean;
  textures: Record<string, TexSpec>;
  texture: TexSpec | null;
  detail: number;
  issues: Issue[];
};

/** Canaux des pistes 2D : r (degrés), x, y (px), s, sx, sy (facteurs), o (opacité, facteur). */
export const CH2 = ["r", "x", "y", "s", "sx", "sy", "o"] as const;
export const STRIDE2 = 7;
/** Canaux multiplicatifs (bits) : s, sx, sy, o. */
export const MULT2 = (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6);

export const LIMITS2 = {
  models: 64,
  partsPerModel: 120,
  points: 256,
  entries: 2000,
  placements: 3000,
  named: 300,
  parts: 30000,
  namedParts: 6000,
  clips: 32,
  keys: 32,
  layers: 12,
  text: 40,
} as const;

const DEFAULT_PALETTE: Record<string, string> = {
  peau: "#f2c29b",
  maillot: "#2563eb",
  short: "#1e293b",
  chaussette: "#f8fafc",
  chaussure: "#111827",
  cheveux: "#3b2416",
  oeil: "#ffffff",
  pupille: "#111827",
  accent: "#facc15",
  bois: "#8b5a2b",
  feuillage: "#3f9d4a",
  pierre: "#9ca3af",
  sol: "#6b8f4e",
  terre: "#8b6b47",
  eau: "#38bdf8",
  blanc: "#f8fafc",
  noir: "#0f172a",
  ligne: "#f8fafc",
};

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clampN = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const dim = (v: number) => clampN(Math.abs(v), 0.01, 20000);

function vec2(v: unknown, d: [number, number]): [number, number] {
  if (!Array.isArray(v)) return [...d];
  return [num(v[0], d[0]), num(v[1], d[1])];
}
function scale2(v: unknown): [number, number] {
  if (typeof v === "number" && Number.isFinite(v)) return [v, v];
  return vec2(v, [1, 1]);
}

/* ------------------------------------------------------------------ formes → contours */

const SEG = [14, 24, 40];

function ellipsePts(rx: number, ry: number, n: number, out: number[] = []): number[] {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(Math.cos(a) * rx, Math.sin(a) * ry);
  }
  return out;
}

function roundRect(w: number, h: number, r: number, seg: number): number[] {
  const hw = w / 2, hh = h / 2;
  r = Math.min(r, hw, hh);
  if (r <= 0.01) return [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
  const k = Math.max(2, Math.round(seg / 4));
  const out: number[] = [];
  const corners: [number, number, number][] = [[hw - r, -hh + r, -Math.PI / 2], [hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2], [-hw + r, -hh + r, Math.PI]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= k; i++) {
    const a = a0 + (i / k) * (Math.PI / 2);
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

/** Courbe fermée lisse passant par les points (Catmull-Rom). */
function blob(pts: number[][], seg: number, closed = true): number[] {
  const n = pts.length;
  const out: number[] = [];
  const k = Math.max(2, Math.round(seg / 6));
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], p1 = pts[i], p2 = pts[closed ? (i + 1) % n : i + 1], p3 = pts[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push(f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]));
    }
  }
  if (!closed) out.push(pts[n - 1][0], pts[n - 1][1]);
  return out;
}

/** Chemin SVG restreint (M L H V Q C Z, absolus et relatifs) aplati en points ; aucun autre code n'est évalué. */
export function flattenPath(d: string, seg: number): { pts: number[]; closed: boolean } | null {
  const tokens = d.match(/[MLHVQCZmlhvqcz]|-?\d*\.?\d+(?:e-?\d+)?/g);
  if (!tokens || tokens.length > 2000) return null;
  const out: number[] = [];
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0, closed = false;
  const n = () => Number(tokens[i++]);
  const k = Math.max(3, Math.round(seg / 3));
  while (i < tokens.length) {
    const i0 = i;
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "Z") {
      closed = true;
      x = sx;
      y = sy;
      // des nombres après Z : lignes implicites (jamais de boucle sans avancer)
      cmd = rel ? "l" : "L";
      if (i === i0) i++;
      continue;
    }
    if (i >= tokens.length || /[A-Za-z]/.test(tokens[i])) {
      if (i === i0) i++;
      continue;
    }
    if (C === "M" || C === "L") {
      const nx = n() + (rel ? x : 0), ny = n() + (rel ? y : 0);
      x = nx;
      y = ny;
      if (C === "M") {
        sx = x;
        sy = y;
        cmd = rel ? "l" : "L";
      }
      out.push(x, y);
    } else if (C === "H") {
      x = n() + (rel ? x : 0);
      out.push(x, y);
    } else if (C === "V") {
      y = n() + (rel ? y : 0);
      out.push(x, y);
    } else if (C === "Q") {
      const cx = n() + (rel ? x : 0), cy = n() + (rel ? y : 0), ex = n() + (rel ? x : 0), ey = n() + (rel ? y : 0);
      for (let j = 1; j <= k; j++) {
        const t = j / k, u = 1 - t;
        out.push(u * u * x + 2 * u * t * cx + t * t * ex, u * u * y + 2 * u * t * cy + t * t * ey);
      }
      x = ex;
      y = ey;
    } else if (C === "C") {
      const c1x = n() + (rel ? x : 0), c1y = n() + (rel ? y : 0), c2x = n() + (rel ? x : 0), c2y = n() + (rel ? y : 0), ex = n() + (rel ? x : 0), ey = n() + (rel ? y : 0);
      for (let j = 1; j <= k; j++) {
        const t = j / k, u = 1 - t;
        out.push(u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex, u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey);
      }
      x = ex;
      y = ey;
    } else i++;
    if (i === i0) i++;
    if (out.length / 2 > LIMITS2.points) break;
    if (!out.every(Number.isFinite)) return null;
  }
  return out.length >= 4 ? { pts: out, closed } : null;
}

function readShape2(p: Part2In, seg: number, path: string, issues: Issue[]): Shape2 | null {
  const kinds = SHAPES2.filter((k) => p[k] !== undefined);
  if (!kinds.length) return null;
  if (kinds.length > 1) issues.push({ path, message: `une seule forme par pièce (${kinds.join(", ")}) : ${kinds[0]} retenue` });
  const kind = kinds[0];
  const raw = p[kind];
  const nums = (v: unknown) => (Array.isArray(v) ? v : typeof v === "number" ? [v] : []).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const pairs = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .filter((q): q is number[] => Array.isArray(q) && q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]))
      .slice(0, LIMITS2.points);
  let pts: number[] = [];
  let closed = true;
  switch (kind) {
    case "rect": {
      const a = nums(raw);
      pts = roundRect(dim(num(a[0], 20)), dim(num(a[1], num(a[0], 20))), Math.max(0, num(a[2], 0)), seg);
      break;
    }
    case "circle": {
      const a = nums(raw);
      const r = dim(num(a[0], 10));
      pts = ellipsePts(r, r, seg);
      break;
    }
    case "ellipse": {
      const a = nums(raw);
      pts = ellipsePts(dim(num(a[0], 10)), dim(num(a[1], num(a[0], 10))), seg);
      break;
    }
    case "capsule": {
      const a = nums(raw);
      const r = dim(num(a[0], 5)), l = Math.max(0, num(a[1], 20));
      pts = roundRect(r * 2, l + r * 2, r, seg * 2);
      break;
    }
    case "star": {
      const a = nums(raw);
      const n = clampN(Math.round(num(a[0], 5)), 3, 32), r1 = dim(num(a[1], 10)), r2 = dim(num(a[2], r1 * 0.45));
      for (let i = 0; i < n * 2; i++) {
        const ang = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? r2 : r1;
        pts.push(Math.cos(ang) * r, Math.sin(ang) * r);
      }
      break;
    }
    case "arc": {
      // bande d'arc : [rayon, début°, fin°, épaisseur]
      const a = nums(raw);
      const r = dim(num(a[0], 20)), a0 = num(a[1], 0) * DEG, a1 = num(a[2], 180) * DEG, w = dim(num(a[3], 4));
      const k = Math.max(4, Math.round((seg * Math.abs(a1 - a0)) / (Math.PI * 2)));
      for (let i = 0; i <= k; i++) {
        const t = a0 + ((a1 - a0) * i) / k;
        pts.push(Math.cos(t) * (r + w / 2), Math.sin(t) * (r + w / 2));
      }
      for (let i = k; i >= 0; i--) {
        const t = a0 + ((a1 - a0) * i) / k;
        pts.push(Math.cos(t) * (r - w / 2), Math.sin(t) * (r - w / 2));
      }
      break;
    }
    case "poly": {
      const q = pairs(raw);
      if (q.length < 3) {
        issues.push({ path, message: "poly : au moins 3 points [x, y]" });
        return null;
      }
      pts = q.flatMap((v) => [v[0], v[1]]);
      break;
    }
    case "blob": {
      const q = pairs(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { pts?: unknown }).pts : raw);
      if (q.length < 3) {
        issues.push({ path, message: "blob : au moins 3 points [x, y]" });
        return null;
      }
      pts = blob(q, seg);
      break;
    }
    case "trait": {
      const o = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { pts: raw }) as { pts?: unknown; smooth?: unknown };
      const q = pairs(o.pts);
      if (q.length < 2) {
        issues.push({ path, message: "trait : au moins 2 points [x, y]" });
        return null;
      }
      pts = o.smooth ? blob(q, seg, false) : q.flatMap((v) => [v[0], v[1]]);
      closed = false;
      break;
    }
    case "path": {
      const r = typeof raw === "string" ? flattenPath(raw, seg) : null;
      if (!r) {
        issues.push({ path, message: "path : chemin SVG invalide (commandes M L H V Q C Z)" });
        return null;
      }
      pts = r.pts;
      closed = r.closed;
      break;
    }
    case "text": {
      const o = (typeof raw === "string" ? { text: raw } : raw && typeof raw === "object" ? raw : {}) as { text?: unknown; size?: unknown };
      const text = String(o.text ?? "").slice(0, LIMITS2.text);
      const size = clampN(num(o.size, 16), 4, 400);
      const off = vec2(p.off, [0, 0]);
      const w = text.length * size * 0.3;
      return { kind, pts: [off[0] - w, off[1] - size / 2, off[0] + w, off[1] - size / 2, off[0] + w, off[1] + size / 2, off[0] - w, off[1] + size / 2], closed: true, text, size };
    }
  }
  if (pts.length / 2 > LIMITS2.points) pts = pts.slice(0, LIMITS2.points * 2);
  const off = vec2(p.off, [0, 0]);
  if (off[0] || off[1]) for (let i = 0; i < pts.length; i += 2) {
    pts[i] += off[0];
    pts[i + 1] += off[1];
  }
  return { kind, pts, closed };
}

/* ------------------------------------------------------------------ modèles */

function readModel2(name: string, src: Model2In, palette: Record<string, string>, ownPal: Record<string, string>, seg: number, issues: Issue[]): Model2 {
  const path = `models.${name}`;
  if (src.gen !== undefined) {
    if (isGenId(src.gen)) return readGenModel2(name, src, issues);
    issues.push({ path: `${path}.gen`, message: `générateur inconnu « ${String(src.gen)} » (${GEN_IDS.join(", ")})` });
  }
  let preset: Preset2dOut | null = null;
  if (typeof src.preset === "string") {
    const gen = own(PRESETS2D, src.preset);
    if (!gen) issues.push({ path: `${path}.preset`, message: `préréglage inconnu « ${src.preset} » (${Object.keys(PRESETS2D).join(", ")})` });
    else preset = gen.build(new Rand(`${src.seed ?? name}`), src.params && typeof src.params === "object" ? src.params : {});
  }
  const inParts: Part2In[] = [...(preset?.parts ?? [])];
  for (const p of Array.isArray(src.parts) ? src.parts : []) {
    if (!p || typeof p !== "object") continue;
    const i = typeof p.name === "string" ? inParts.findIndex((q) => q.name === p.name) : -1;
    if (i >= 0) {
      const base = { ...inParts[i] };
      if (SHAPES2.some((k) => p[k] !== undefined)) for (const k of SHAPES2) delete base[k];
      inParts[i] = { ...base, ...p };
    } else inParts.push(p);
  }

  const parts: Part2[] = [];
  const index = new Map<string, number>();
  const mirrors = new Map<string, [string, string]>();
  const mirrorKind = new Map<string, "x" | "y" | "z">();
  const mirrorParams = new Map<string, { mz: number; ms: number }>();
  const repeats = new Map<string, string[]>();
  const parentOf = new Map<Part2, string>();

  const add = (p: Part2, parentName: string, path2: string) => {
    if (parts.length >= LIMITS2.partsPerModel) {
      issues.push({ path: path2, message: `plus de ${LIMITS2.partsPerModel} pièces : ignorée` });
      return;
    }
    if (index.has(p.name)) {
      issues.push({ path: path2, message: `nom de pièce en double « ${p.name} »` });
      return;
    }
    index.set(p.name, parts.length);
    parts.push(p);
    parentOf.set(p, parentName);
  };

  inParts.forEach((p, i) => {
    const path2 = `${path}.parts.${i}`;
    const base = typeof p.name === "string" && p.name ? p.name.replace(/[^\w-]/g, "") : `piece${i}`;
    const parentName = typeof p.parent === "string" ? p.parent : "";
    const grad = Array.isArray(p.grad) && p.grad.length >= 2 && isColor(p.grad[0]) && isColor(p.grad[1]) ? ([p.grad[0], p.grad[1]] as [string, string]) : null;
    const make = (nm: string, at: [number, number], rot: number, z: number, shade: number, shape: Shape2 | null): Part2 => ({
      name: nm,
      parent: -1,
      at,
      rot,
      scale: scale2(p.scale),
      z,
      role: typeof p.role === "string" ? p.role : "",
      color: isColor(p.color) ? p.color : "",
      grad,
      gradAngle: num(p.gradAngle, 0),
      tex: readTex(p.tex, (message) => issues.push({ path: `${path2}.tex`, message })),
      line: clampN(num(p.line, -1), -1, 40),
      stroke: isColor(p.stroke) ? p.stroke : "",
      fill: p.fill !== false,
      relief: typeof p.relief === "boolean" ? p.relief : null,
      glow: clampN(num(p.glow, 0), 0, 1),
      opacity: clampN(num(p.opacity, 1), 0, 1),
      shade,
      hidden: p.hidden === true,
      shape,
    });
    const shape = readShape2(p, seg, path2, issues);
    const at = vec2(p.at, [0, 0]);
    const rot = num(p.rot, 0) * DEG;
    const z = num(p.z, i * 0.001);
    const inherited = parentName !== "" && mirrors.has(parentName) && !index.has(parentName) ? mirrorKind.get(parentName)! : null;
    const kind = p.mirror === "x" || p.mirror === "y" || p.mirror === "z" ? p.mirror : inherited;
    if (kind) {
      // un enfant de pièce dédoublée reprend le décalage d'ordre et l'ombre de son parent (côté éloigné)
      const pp = inherited ? mirrorParams.get(parentName)! : null;
      const mz = num(p.mirrorZ, pp ? pp.mz : kind === "z" ? -1 : 0), ms = clampN(num(p.mirrorShade, pp ? pp.ms : kind === "z" ? -0.18 : 0), -1, 1);
      const ax = kind === "x" ? 0 : 1;
      const flipShape = shape && kind !== "z" ? { ...shape, pts: shape.pts.map((v, k) => (k % 2 === ax ? -v : v)) } : shape;
      const atR: [number, number] = kind === "x" ? [-at[0], at[1]] : kind === "y" ? [at[0], -at[1]] : [at[0], at[1]];
      add(make(`${base}L`, at, rot, z, 0, shape), parentName, path2);
      add(make(`${base}R`, atR, kind === "z" ? rot : -rot, z + mz, ms, flipShape), parentName, path2);
      mirrors.set(base, [`${base}L`, `${base}R`]);
      mirrorKind.set(base, kind);
      mirrorParams.set(base, { mz, ms });
    } else if (p.repeat && typeof p.repeat === "object") {
      const n = clampN(Math.round(num(p.repeat.n, 2)), 1, 64);
      const dAt = vec2(p.repeat.at, [0, 0]);
      const dRot = num(p.repeat.rot, 0) * DEG;
      const names: string[] = [];
      for (let k = 0; k < n; k++) {
        names.push(`${base}${k}`);
        add(make(`${base}${k}`, [at[0] + dAt[0] * k, at[1] + dAt[1] * k], rot + dRot * k, z + k * 0.0001, 0, shape), parentName, path2);
      }
      repeats.set(base, names);
    } else add(make(base, at, rot, z, 0, shape), parentName, path2);
  });

  for (const part of parts) {
    const parentName = parentOf.get(part)!;
    if (!parentName) continue;
    let pi = index.get(parentName);
    if (pi === undefined && mirrors.has(parentName)) pi = index.get(mirrors.get(parentName)![part.name.endsWith("R") ? 1 : 0]);
    if (pi === undefined || pi === index.get(part.name)) {
      issues.push({ path: `${path}.parts.${part.name}`, message: `parent inconnu « ${parentName} »` });
      continue;
    }
    part.parent = pi;
  }
  // parents avant enfants (cycles cassés)
  const order: number[] = [];
  const state = new Uint8Array(parts.length);
  const visit = (i: number) => {
    if (state[i] === 2) return;
    if (state[i] === 1) {
      parts[i].parent = -1;
      issues.push({ path: `${path}.parts.${parts[i].name}`, message: "cycle de parents : pièce détachée" });
      return;
    }
    state[i] = 1;
    if (parts[i].parent >= 0) visit(parts[i].parent);
    state[i] = 2;
    order.push(i);
  };
  parts.forEach((_, i) => visit(i));
  const remap = new Map<number, number>();
  order.forEach((old, i) => remap.set(old, i));
  const sorted = order.map((old) => ({ ...parts[old], parent: parts[old].parent >= 0 ? remap.get(parts[old].parent)! : -1 }));
  const idx = new Map(sorted.map((p, i) => [p.name, i]));

  // clips
  const clips = new Map<string, Clip>();
  const ownClips = src.clips && typeof src.clips === "object" ? src.clips : {};
  const clipSrc: Record<string, Clip2In> = { ...(preset?.clips ?? {}), ...ownClips };
  let nClips = 0;
  for (const [cname, c] of Object.entries(clipSrc)) {
    if (!c || typeof c !== "object") continue;
    if (++nClips > LIMITS2.clips) break;
    const tracks: Track[] = [];
    for (const [pname, t0] of Object.entries((c.tracks ?? {}) as Record<string, Track2In>)) {
      if (!t0 || typeof t0 !== "object") continue;
      const ph = num(t0.phase, 0);
      const targets: { i: number; phase: number; flip: boolean; flipY?: boolean }[] = [];
      if (idx.has(pname)) targets.push({ i: idx.get(pname)!, phase: ph, flip: false });
      else if (mirrors.has(pname)) {
        const [l, r] = mirrors.get(pname)!;
        const mk = mirrorKind.get(pname)!;
        targets.push({ i: idx.get(l)!, phase: ph, flip: false }, { i: idx.get(r)!, phase: ph + (t0.sync ? 0 : 0.5), flip: mk !== "z" });
        if (mk === "y") targets[targets.length - 1].flipY = true;
      } else if (repeats.has(pname)) {
        const names = repeats.get(pname)!;
        names.forEach((nm, k) => targets.push({ i: idx.get(nm)!, phase: ph + (t0.sync ? 0 : k / names.length), flip: false }));
      } else {
        if (Object.prototype.hasOwnProperty.call(ownClips, cname)) issues.push({ path: `${path}.clips.${cname}.tracks.${pname}`, message: "pièce inconnue" });
        continue;
      }
      CH2.forEach((ch, ci) => {
        const raw: unknown = t0[ch];
        if (!Array.isArray(raw)) return;
        const keys = raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).slice(0, LIMITS2.keys);
        if (!keys.length) return;
        const k = ci === 0 ? keys.map((v) => v * DEG) : keys;
        // côté R : rotation inversée, et la translation perpendiculaire à l'axe du miroir (x en face, y vu de dessus)
        for (const tg of targets) {
          if (tg.i === undefined) continue;
          const inv = tg.flip && (ci === 0 || (ci === 1 && !tg.flipY) || (ci === 2 && tg.flipY));
          tracks.push({ part: tg.i, ch: ci, keys: inv ? k.map((v) => -v) : k, phase: tg.phase });
        }
      });
    }
    clips.set(cname, { name: cname, ms: clampN(num(c.ms, 800), 30, 60000), loop: c.loop !== false, then: typeof c.then === "string" ? c.then : "", smooth: c.ease !== "linear", tracks, action: "", move: null });
  }

  const roles: Record<string, string> = {};
  for (const p of sorted)
    if (p.role && !Object.prototype.hasOwnProperty.call(roles, p.role)) {
      const pr = own(preset?.roles, p.role);
      roles[p.role] = own(ownPal, p.role) ?? (isColor(pr) ? pr : undefined) ?? own(palette, p.role) ?? "#94a3b8";
    }
  const clip = typeof src.clip === "string" ? src.clip : preset?.clip ?? (clips.has("idle") ? "idle" : "");
  return { name, sig: "", parts: sorted, clips, clip, roles, height: preset?.height ?? 0, shadow: preset?.shadow ?? null, gen: null, issues: [] };
}

const GEN_VIEWS = ["profil", "face", "dessus", "plongee"] as const;

/** Modèle gen : os et clips lus par le format monde (3D), vue et échelle propres à la 2D. */
function readGenModel2(name: string, src: Model2In, issues: Issue[]): Model2 {
  const path = `models.${name}`;
  const params = src.params && typeof src.params === "object" && !Array.isArray(src.params) ? { ...src.params } : {};
  const m3 = readMonde({ models: { [name]: { gen: src.gen, params, seed: src.seed ?? name, clips: src.clips as never, clip: src.clip } } });
  for (const i of m3.issues) issues.push({ path: i.path, message: i.message });
  const model3 = m3.models.get(name)!;
  if (src.parts !== undefined) issues.push({ path: `${path}.parts`, message: "ignorées : un modèle gen n'a que ses os" });
  const view = (GEN_VIEWS as readonly string[]).includes(String(src.vue)) ? (src.vue as Gen2Spec["view"]) : "profil";
  if (src.vue !== undefined && view !== src.vue) issues.push({ path: `${path}.vue`, message: `vue inconnue (${GEN_VIEWS.join(", ")})` });
  const fam = String(src.gen).split(".")[0];
  // hauteur de référence du générateur (m) : la taille en px donne l'échelle
  const ref = fam === "character" ? 1.7 : fam === "animal" ? 0.8 : fam === "tree" ? 6 : fam === "building" ? 7 : 1;
  const taille = clampN(num(src.taille, fam === "character" ? 64 : 64), 4, 2000);
  // les clips du format monde, sans pistes 2D : le pilote 2D les reconnaît (noms, durées, enchaînements)
  const clips = new Map<string, Clip>();
  for (const [k, c] of model3.clips) clips.set(k, { ...c, tracks: [] });
  return {
    name,
    sig: "",
    parts: [],
    clips,
    clip: model3.clip,
    roles: { ...model3.roles },
    height: 0,
    shadow: null,
    gen: { id: String(src.gen), params, seed: `${src.seed ?? name}`, rig: model3.gen!.rig, view, pxPerM: taille / ref, pitch: clampN(num(src.pitch, view === "dessus" ? 90 : 55), 20, 90), model3 },
    issues: [],
  };
}

/* ------------------------------------------------------------------ placement */

function readPlace2(list: unknown, models: Map<string, Model2>, layers: Layer2[], issues: Issue[]): Placement2[] {
  const out: Placement2[] = [];
  const names = new Set<string>();
  let named = 0, budget: number = LIMITS2.parts, namedParts = 0;
  const all = Array.isArray(list) ? list : [];
  if (all.length > LIMITS2.entries) issues.push({ path: "place", message: `plus de ${LIMITS2.entries} entrées : la suite est ignorée` });
  const defLayer = layers.find((l) => l.parallax === 1)?.name ?? layers[layers.length - 1]?.name ?? "monde";
  all.slice(0, LIMITS2.entries).forEach((raw, i) => {
    const p = (raw && typeof raw === "object" ? raw : {}) as Place2In;
    const path = `place.${i}`;
    const model = typeof p.model === "string" ? p.model : "";
    const md = models.get(model);
    if (!md) {
      issues.push({ path, message: `modèle inconnu « ${model} »` });
      return;
    }
    const shaped = md.parts.filter((q) => q.shape).length || 1;
    const roles: Record<string, string> = {};
    if (p.roles && typeof p.roles === "object") for (const [k, v] of Object.entries(p.roles)) if (isColor(v)) roles[k] = v;
    const layer = typeof p.layer === "string" && layers.some((l) => l.name === p.layer) ? p.layer : defLayer;
    if (typeof p.layer === "string" && layer !== p.layer) issues.push({ path: `${path}.layer`, message: `calque inconnu « ${p.layer} »` });
    const base: Placement2 = {
      model,
      name: "",
      at: vec2(p.at, [0, 0]),
      rot: num(p.rot, 0) * DEG,
      scale: scale2(p.scale),
      flip: p.flip === true,
      roles,
      clip: typeof p.clip === "string" ? p.clip : "",
      layer,
      z: num(p.z, 0),
      hidden: p.hidden === true,
      order: i,
    };
    const full = () => out.length >= LIMITS2.placements || budget < shaped;
    const push = (pl: Placement2) => {
      if (full()) return;
      if (pl.name) {
        if (namedParts + shaped > LIMITS2.namedParts) {
          issues.push({ path, message: `plus de ${LIMITS2.namedParts} pièces animées : instance ignorée` });
          return;
        }
        namedParts += shaped;
      }
      budget -= shaped;
      out.push(pl);
    };
    const rnd = new Rand(`${p.seed ?? i}/${model}`);
    const jitter = Math.max(0, num(p.jitter, 0));
    const turn = Math.abs(num(p.turn, 0)) * DEG;
    const size = Array.isArray(p.size) ? [num(p.size[0], 1), num(p.size[1], num(p.size[0], 1))] : null;
    const vary = (pl: Placement2, step: number): Placement2 => {
      const s = size ? rnd.range(size[0], size[1]) : 1;
      return {
        ...pl,
        at: [pl.at[0] + rnd.range(-1, 1) * jitter * step, pl.at[1] + rnd.range(-1, 1) * jitter * step],
        rot: pl.rot + rnd.range(-1, 1) * turn,
        scale: [pl.scale[0] * s, pl.scale[1] * s],
        flip: size || jitter ? rnd.chance(0.5) !== pl.flip : pl.flip,
      };
    };
    if (Array.isArray(p.grid)) {
      const nx = clampN(Math.round(num(p.grid[0], 1)), 1, 500), ny = clampN(Math.round(num(p.grid[1], 1)), 1, 500);
      const st = vec2(p.step, [40, 40]);
      for (let a = 0; a < nx && !full(); a++) for (let b = 0; b < ny && !full(); b++) push(vary({ ...base, at: [base.at[0] + a * st[0], base.at[1] + b * st[1]] }, Math.min(Math.abs(st[0]) || 40, Math.abs(st[1]) || 40)));
      return;
    }
    if (typeof p.scatter === "number") {
      const n = clampN(Math.round(p.scatter), 0, LIMITS2.placements);
      const ar = Array.isArray(p.area) ? p.area.map((v) => num(v, 0)) : [0, 0, 400, 400];
      for (let k = 0; k < n && !full(); k++) push(vary({ ...base, at: [rnd.range(ar[0], ar[2]), rnd.range(ar[1], ar[3])] }, 0));
      return;
    }
    const name = typeof p.name === "string" ? p.name.replace(/[^\w-]/g, "") : "";
    if (name) {
      if (names.has(name)) {
        issues.push({ path, message: `nom d'instance en double « ${name} »` });
        return;
      }
      if (++named > LIMITS2.named) {
        issues.push({ path, message: `plus de ${LIMITS2.named} instances nommées` });
        return;
      }
      names.add(name);
    }
    push({ ...base, name });
  });
  if (out.length >= LIMITS2.placements || budget <= 0) issues.push({ path: "place", message: `budget atteint (${LIMITS2.placements} copies, ${LIMITS2.parts} pièces)` });
  return out;
}

/* ------------------------------------------------------------------ monde */

const STYLES = ["plat", "doux", "bd", "encre", "gouache"] as const;

export function readMonde2d(input: unknown, previous?: Monde2d | null): Monde2d {
  try {
    return readUnsafe(input, previous);
  } catch (err) {
    const m = readUnsafe({}, null);
    m.issues.push({ path: "", message: `monde2d illisible : ${err instanceof Error ? err.message : String(err)}` });
    return m;
  }
}

function readUnsafe(input: unknown, previous?: Monde2d | null): Monde2d {
  const issues: Issue[] = [];
  const src = genVariants((input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Monde2dIn, issues);
  const palette: Record<string, string> = { ...DEFAULT_PALETTE };
  const ownPal: Record<string, string> = {};
  if (src.palette && typeof src.palette === "object")
    for (const [k, v] of Object.entries(src.palette)) {
      if (isColor(v)) palette[k] = ownPal[k] = v;
      else issues.push({ path: `palette.${k}`, message: "couleur #rrggbb attendue" });
    }
  const detail = src.detail === "low" ? 0 : src.detail === "high" ? 2 : 1;
  const seg = SEG[detail];
  const models = new Map<string, Model2>();
  const entries = Object.entries(src.models && typeof src.models === "object" ? src.models : {});
  if (entries.length > LIMITS2.models) issues.push({ path: "models", message: `plus de ${LIMITS2.models} modèles` });
  const palSig = hash32(JSON.stringify(src.palette ?? {}));
  for (const [name, m] of entries.slice(0, LIMITS2.models)) {
    if (!m || typeof m !== "object") continue;
    const sig = `${hash32(JSON.stringify(m))}/${palSig}/${detail}`;
    const prev = previous?.models.get(name);
    if (prev && prev.sig === sig) {
      models.set(name, prev);
      issues.push(...prev.issues);
      continue;
    }
    const own0 = issues.length;
    const model = readModel2(name, m, palette, ownPal, seg, issues);
    model.sig = sig;
    model.issues = issues.slice(own0);
    models.set(name, model);
  }
  const layers: Layer2[] = [];
  for (const l of (Array.isArray(src.layers) ? src.layers : []).slice(0, LIMITS2.layers)) {
    if (!l || typeof l !== "object" || typeof l.name !== "string" || !/^[\w-]+$/.test(l.name)) continue;
    layers.push({ name: l.name, parallax: clampN(num(l.parallax, 1), -2, 4), ysort: l.ysort === true });
  }
  const textures: Record<string, TexSpec> = {};
  if (src.textures && typeof src.textures === "object")
    for (const [k, t] of Object.entries(src.textures)) {
      const r = readTex(t, (message) => issues.push({ path: `textures.${k}`, message }));
      if (r) textures[k] = r;
    }
  const ciel = Array.isArray(src.ciel) && isColor(src.ciel[0]) && isColor(src.ciel[1]) ? ([src.ciel[0], src.ciel[1]] as [string, string]) : isColor(src.ciel) ? ([src.ciel, src.ciel] as [string, string]) : null;
  const VEC: Record<string, Monde2d["style"]> = { flat: "plat", "ligne-claire": "bd", gravure: "encre", affiche: "gouache", "papier-decoupe": "doux" };
  const GEN_OF: Record<string, string> = { plat: "flat", doux: "flat", bd: "ligne-claire", encre: "gravure", gouache: "affiche" };
  const vecStyle = Object.prototype.hasOwnProperty.call(VEC, String(src.style)) ? String(src.style) : "";
  const style = vecStyle ? VEC[vecStyle] : (STYLES as readonly string[]).includes(String(src.style)) ? (src.style as Monde2d["style"]) : "plat";
  const sg = src.styleGen as unknown;
  let styleGen: Monde2d["styleGen"] = typeof sg === "string" && Object.prototype.hasOwnProperty.call(VEC, sg) ? sg : vecStyle || GEN_OF[style];
  if (sg && typeof sg === "object" && !Array.isArray(sg)) {
    // réglages fins : { vector, outline, tones, shadows, hatch, halftone, posterize, papercut, paper, wash, chroma, contrast, … }
    const json = JSON.stringify(sg);
    if (json.length > 4000) issues.push({ path: "styleGen", message: "réglages trop volumineux (4000 caractères max)" });
    else {
      const o = JSON.parse(json) as Record<string, unknown>;
      if (typeof o.vector !== "string" || !Object.prototype.hasOwnProperty.call(VEC, o.vector)) {
        if (o.vector !== undefined) issues.push({ path: "styleGen.vector", message: `style vectoriel inconnu (${Object.keys(VEC).join(", ")})` });
        o.vector = styleGen;
      }
      styleGen = o;
    }
  } else if (sg !== undefined && styleGen !== sg) issues.push({ path: "styleGen", message: `style vectoriel inconnu (${Object.keys(VEC).join(", ")})` });
  return {
    styleGen,
    styleKey: `${typeof styleGen === "string" ? styleGen : JSON.stringify(styleGen)}|${clampN(num(src.fpsGen, 24), 6, 60)}|${clampN(num(src.resGen, 2), 0.5, 3)}`,
    fpsGen: clampN(num(src.fpsGen, 24), 6, 60),
    resGen: clampN(num(src.resGen, 2), 0.5, 3),
    traits: clampN(num(src.traits, 1), 0, 3),
    palette,
    models,
    place: readPlace2(src.place, models, layers, issues),
    layers,
    ciel,
    style,
    outline: clampN(num(src.outline, style === "bd" ? 3 : style === "encre" ? 2 : style === "plat" ? 1.5 : 1), 0, 12),
    relief: typeof src.relief === "boolean" ? src.relief : style !== "plat" && style !== "encre",
    textures,
    texture: readTex(src.texture ?? (style === "gouache" ? "grain" : undefined), (message) => issues.push({ path: "texture", message })),
    detail,
    issues,
  };
}

export function partColor2(model: Model2, part: Part2, roles: Record<string, string> | undefined, palette: Record<string, string>): string {
  if (part.color) return part.color;
  if (part.role) {
    const r = own(roles, part.role);
    return (isColor(r) ? r : undefined) ?? own(model.roles, part.role) ?? own(palette, part.role) ?? "#94a3b8";
  }
  return "#94a3b8";
}

export function partTex2(m: Monde2d, part: Part2): TexSpec | null {
  if (part.glow > 0 || !part.fill) return part.tex;
  return part.tex ?? (part.role ? own(m.textures, part.role) : undefined) ?? m.texture;
}

export function monde2dSummary(m: Monde2d) {
  const models: Record<string, { parts: string[]; clips: string[]; roles: Record<string, string>; clip: string }> = {};
  for (const [k, md] of m.models) models[k] = { parts: md.parts.map((p) => p.name), clips: [...md.clips.keys()], roles: md.roles, clip: md.clip };
  return {
    models,
    instances: m.place.filter((p) => p.name).map((p) => ({ name: p.name, model: p.model, layer: p.layer })),
    decor: m.place.filter((p) => !p.name).length,
    layers: m.layers.map((l) => l.name),
    issues: m.issues.slice(0, 50),
  };
}
