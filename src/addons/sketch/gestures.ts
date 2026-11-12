/**
 * Gestes de dessin rejoués par `sonic-sketch` (`gestures-from`) : une suite de traits, chacun avec ses réglages
 * de pinceau et ses points, joués par la même chaîne qu'une main au stylet (empreintes, pression, passes,
 * modes de fusion, aplatissement, gomme). Sert à un agent qui dessine, à une démonstration, à un tutoriel.
 *
 *   { "width": 400, "height": 500, "strokes": [
 *       { "color": "#f1d3b3", "size": 60, "hardness": 0.2, "opacity": 0.5, "blend": "multiply",
 *         "pts": [x, y, pression, x, y, pression, …] } ] }
 *
 * Coordonnées dans un cadre `width × height` placé au centre de la toile (90 % de sa place) ; `size` dans les
 * mêmes unités. Pression 0..1 (défaut 0.7). Comme un peintre garde son pinceau en main, chaque trait reprend
 * les réglages du précédent et ne donne que ceux qui changent (`reset: true` repart des réglages par défaut).
 * Les points sont reliés en courbe (Catmull-Rom) : quelques points de passage suffisent ; `curve: false` pour
 * des segments droits. Données seulement : aucun code, pointes en chemins SVG vérifiés.
 */

/** Réglages de pinceau acceptés par trait (les autres clés sont ignorées). */
export const GESTURE_BRUSH_KEYS = [
  "tool", "color", "size", "hardness", "opacity", "spacing", "smoothing", "pressure", "tip", "angle", "angleFollow",
  "angleJitter", "sizeJitter", "scatter", "roundness", "tremble", "blend", "simplify",
] as const;

/** Taille maximale d'un fichier de gestes (caractères JSON). */
export const MAX_GESTURE_FILE = 30_000_000;

/**
 * URL d'un fichier de gestes : chaîne ou `{url}` en `https:`, `blob:` ou `data:application/json` (ex. un asset
 * d'artefact, ou la sortie de `sonic-painterly`). `http:` seulement pour localhost. Sinon null.
 */
export function gesturesUrl(v: unknown): string | null {
  const u = typeof v === "string" ? v : v && typeof v === "object" && !Array.isArray(v) && typeof (v as { url?: unknown }).url === "string" && !Array.isArray((v as { strokes?: unknown }).strokes) ? (v as { url: string }).url : null;
  if (!u) return null;
  const t = u.trim();
  if (/^(https:|blob:)/i.test(t) || /^data:application\/json[;,]/i.test(t) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(t)) return t;
  return null;
}

export const MAX_GESTURE_STROKES = 20_000;
export const MAX_GESTURE_POINTS = 1_000_000;
const MAX_STROKE_POINTS = 20_000;
const MAX_FRAME = 100_000;

export type GestureStroke = { brush: Record<string, unknown>; pts: number[]; curve: boolean };
export type Gestures = { width: number; height: number; strokes: GestureStroke[]; truncated: boolean };

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Points d'un trait : `[x, y, p, …]` ou `[[x, y, p?], …]` → `[x, y, p, …]` (pression bornée, défaut 0.7). */
function readPoints(raw: unknown, budget: { n: number }): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  const push = (x: unknown, y: unknown, p: unknown) => {
    if (!fin(x) || !fin(y) || Math.abs(x) > MAX_FRAME || Math.abs(y) > MAX_FRAME) return;
    if (out.length / 3 >= MAX_STROKE_POINTS || budget.n <= 0) return;
    budget.n--;
    out.push(x, y, fin(p) ? Math.max(0, Math.min(1, p)) : 0.7);
  };
  if (raw.length && Array.isArray(raw[0])) {
    for (const q of raw) if (Array.isArray(q)) push(q[0], q[1], q[2]);
  } else {
    for (let i = 0; i + 2 < raw.length; i += 3) push(raw[i], raw[i + 1], raw[i + 2]);
  }
  return out;
}

/** Lit un jeu de gestes (valeur d'un DataProvider) ; `null` s'il n'y a rien de jouable. */
export function readGestures(v: unknown): Gestures | null {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.strokes)) return null;
  const width = fin(o.width) && o.width > 0 && o.width <= MAX_FRAME ? o.width : 0;
  const height = fin(o.height) && o.height > 0 && o.height <= MAX_FRAME ? o.height : 0;
  const budget = { n: MAX_GESTURE_POINTS };
  const strokes: GestureStroke[] = [];
  let truncated = o.strokes.length > MAX_GESTURE_STROKES;
  // Réglages en main : ceux du trait précédent, complétés ou changés par chaque trait.
  let held: Record<string, unknown> = {};
  for (const s of o.strokes.slice(0, MAX_GESTURE_STROKES)) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    const r = s as Record<string, unknown>;
    if (r.reset === true) held = {};
    const next = { ...held };
    for (const k of GESTURE_BRUSH_KEYS) if (r[k] !== undefined) next[k] = r[k];
    held = next;
    const pts = readPoints(r.pts, budget);
    if (!pts.length) continue;
    strokes.push({ brush: { ...held }, pts, curve: r.curve !== false });
  }
  if (budget.n <= 0) truncated = true;
  if (!strokes.length) return null;
  // Sans cadre : la boîte des points.
  let w = width, h = height;
  if (!(w > 0 && h > 0)) {
    let x1 = -Infinity, y1 = -Infinity;
    for (const s of strokes) for (let i = 0; i < s.pts.length; i += 3) { x1 = Math.max(x1, s.pts[i]); y1 = Math.max(y1, s.pts[i + 1]); }
    w = w || Math.max(1, x1);
    h = h || Math.max(1, y1);
  }
  return { width: w, height: h, strokes, truncated };
}

/** Empreinte stable d'un jeu de gestes (pour ne rejouer qu'un nouveau jeu). */
export function gesturesKey(v: unknown): string {
  try {
    const s = JSON.stringify(v) ?? "";
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return `${s.length}:${(h >>> 0).toString(36)}`;
  } catch {
    return "";
  }
}

/** Cadre `w × h` → écran (px de toile) : ajusté à 90 % de la toile `cw × ch`, centré. */
export function fitFrame(w: number, h: number, cw: number, ch: number): { k: number; ox: number; oy: number } {
  const k = Math.min((cw * 0.9) / w, (ch * 0.9) / h);
  return { k, ox: (cw - w * k) / 2, oy: (ch - h * k) / 2 };
}

/**
 * Points de passage → tracé dense (px d'écran) : courbe de Catmull-Rom (ou segments droits), un point tous les
 * `step` px environ, pression interpolée. `pts` et le résultat : `[x, y, p, …]`.
 */
export function densify(pts: number[], step: number, curve: boolean, max = 20_000): number[] {
  const n = pts.length / 3;
  if (n < 2) return pts.slice();
  const out: number[] = [pts[0], pts[1], pts[2]];
  const P = (i: number) => {
    const j = Math.max(0, Math.min(n - 1, i)) * 3;
    return [pts[j], pts[j + 1], pts[j + 2]];
  };
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(1, Math.min(200, Math.ceil(len / Math.max(0.5, step))));
    for (let s = 1; s <= k; s++) {
      if (out.length / 3 >= max) return out;
      const t = s / k;
      let x: number, y: number;
      if (curve && n > 2) {
        const t2 = t * t, t3 = t2 * t;
        const c = (a: number, b: number, d: number, e: number) => 0.5 * (2 * b + (-a + d) * t + (2 * a - 5 * b + 4 * d - e) * t2 + (-a + 3 * b - 3 * d + e) * t3);
        x = c(p0[0], p1[0], p2[0], p3[0]);
        y = c(p0[1], p1[1], p2[1], p3[1]);
      } else {
        x = p1[0] + (p2[0] - p1[0]) * t;
        y = p1[1] + (p2[1] - p1[1]) * t;
      }
      out.push(x, y, p1[2] + (p2[2] - p1[2]) * t);
    }
  }
  return out;
}
