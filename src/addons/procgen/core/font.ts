/**
 * Police à traits de procgen (dessin propre, aucune police tierce) : chaque glyphe est une liste de polylignes sur une
 * grille dont la hauteur de capitale vaut 6. Le texte est rendu en capitales (enseignes, maillots, panneaux) ; les
 * lettres accentuées sont décomposées (NFD) et reçoivent leur signe diacritique. La même mise en page sert la 3D
 * (rubans extrudés, motifs découpés dans les vêtements) et la 2D (traits vectoriels).
 */

export type P2 = [number, number];
type Glyph = { w: number; p: P2[][] };

const D = Math.PI / 180;
/** Arc d'ellipse de a0 à a1 (degrés, sens trigonométrique si a1 > a0), points espacés d'environ 20°. */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): P2[] {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 20));
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (a0 + ((a1 - a0) * i) / n) * D;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as P2;
  });
}
const loop = (cx: number, cy: number, rx: number, ry: number) => arc(cx, cy, rx, ry, 90, 450);
const dot = (x: number, y = 0.2): P2[] => [[x, y - 0.05], [x, y + 0.05]];

const G: Record<string, Glyph> = {
  A: { w: 4.2, p: [[[0, 0], [2.1, 6], [4.2, 0]], [[0.75, 2], [3.45, 2]]] },
  B: { w: 4, p: [[[0, 3.2], ...arc(2.4, 4.6, 1.4, 1.4, -90, 90), [0, 6], [0, 0], ...arc(2.4, 1.6, 1.6, 1.6, -90, 90), [0, 3.2]]] },
  C: { w: 4.2, p: [arc(2.3, 3, 2.3, 3, 42, 318)] },
  D: { w: 4.2, p: [[[0, 0], [0, 6], [1.6, 6], ...arc(1.6, 3, 2.6, 3, 90, -90).slice(1), [0, 0]]] },
  E: { w: 3.6, p: [[[3.6, 6], [0, 6], [0, 0], [3.6, 0]], [[0, 3.1], [3, 3.1]]] },
  F: { w: 3.5, p: [[[3.5, 6], [0, 6], [0, 0]], [[0, 3.1], [3, 3.1]]] },
  G: { w: 4.5, p: [[...arc(2.3, 3, 2.3, 3, 42, 360), [2.7, 3]]] },
  H: { w: 4, p: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3.1], [4, 3.1]]] },
  I: { w: 0, p: [[[0, 0], [0, 6]]] },
  J: { w: 3.2, p: [[[3.2, 6], ...arc(1.6, 1.7, 1.6, 1.7, 0, -180)]] },
  K: { w: 4, p: [[[0, 0], [0, 6]], [[3.9, 6], [0, 2.1]], [[1.35, 3.4], [4, 0]]] },
  L: { w: 3.4, p: [[[0, 6], [0, 0], [3.4, 0]]] },
  M: { w: 4.9, p: [[[0, 0], [0, 6], [2.45, 1.4], [4.9, 6], [4.9, 0]]] },
  N: { w: 4.1, p: [[[0, 0], [0, 6], [4.1, 0], [4.1, 6]]] },
  O: { w: 4.8, p: [loop(2.4, 3, 2.4, 3)] },
  P: { w: 3.9, p: [[[0, 0], [0, 6], [2.3, 6], ...arc(2.3, 4.4, 1.6, 1.6, 90, -90).slice(1), [0, 2.8]]] },
  Q: { w: 4.8, p: [loop(2.4, 3, 2.4, 3), [[2.9, 1.3], [4.9, -0.4]]] },
  R: { w: 4, p: [[[0, 0], [0, 6], [2.3, 6], ...arc(2.3, 4.4, 1.6, 1.6, 90, -90).slice(1), [0, 2.8]], [[2.1, 2.8], [4, 0]]] },
  S: { w: 4, p: [[...arc(2, 4.55, 1.85, 1.45, 25, 270), ...arc(2, 1.55, 2, 1.55, 90, -155).slice(1)]] },
  T: { w: 4.4, p: [[[0, 6], [4.4, 6]], [[2.2, 6], [2.2, 0]]] },
  U: { w: 4.1, p: [[[0, 6], ...arc(2.05, 2.05, 2.05, 2.05, 180, 360), [4.1, 6]]] },
  V: { w: 4.4, p: [[[0, 6], [2.2, 0], [4.4, 6]]] },
  W: { w: 6, p: [[[0, 6], [1.45, 0], [3, 4.5], [4.55, 0], [6, 6]]] },
  X: { w: 4.2, p: [[[0, 0], [4.2, 6]], [[0, 6], [4.2, 0]]] },
  Y: { w: 4.4, p: [[[0, 6], [2.2, 2.9], [4.4, 6]], [[2.2, 2.9], [2.2, 0]]] },
  Z: { w: 4, p: [[[0, 6], [4, 6], [0, 0], [4, 0]]] },
  "0": { w: 4, p: [loop(2, 3, 2, 3)] },
  "1": { w: 2.2, p: [[[0, 4.6], [2.2, 6], [2.2, 0]]] },
  "2": { w: 4, p: [[...arc(2, 4.1, 1.95, 1.9, 160, -38), [0, 0], [4, 0]]] },
  "3": { w: 4, p: [[...arc(2, 4.55, 1.85, 1.45, 150, -90), ...arc(2, 1.55, 2, 1.55, 90, -150).slice(1)]] },
  "4": { w: 4.2, p: [[[3.1, 0], [3.1, 6], [0, 1.7], [4.2, 1.7]]] },
  "5": { w: 4, p: [[[3.7, 6], [0.5, 6], [0.25, 3.3], ...arc(2, 1.95, 2, 1.95, 125, -150)]] },
  "6": { w: 4, p: [loop(2, 1.95, 2, 1.95), arc(4, 2, 4, 4, 180, 101)] },
  "7": { w: 4, p: [[[0, 6], [4, 6], [1.3, 0]]] },
  "8": { w: 4, p: [loop(2, 4.55, 1.7, 1.45), loop(2, 1.55, 2, 1.55)] },
  "9": { w: 4, p: [loop(2, 4.05, 2, 1.95), arc(0, 4, 4, 4, 0, -79)] },
  ".": { w: 0, p: [dot(0)] },
  ",": { w: 0.4, p: [[[0.4, 0.5], [0, -0.9]]] },
  ":": { w: 0, p: [dot(0), dot(0, 3.6)] },
  ";": { w: 0.4, p: [dot(0.4, 3.6), [[0.4, 0.5], [0, -0.9]]] },
  "-": { w: 2.4, p: [[[0, 2.8], [2.4, 2.8]]] },
  "'": { w: 0, p: [[[0, 6], [0, 4.4]]] },
  '"': { w: 1.2, p: [[[0, 6], [0, 4.4]], [[1.2, 6], [1.2, 4.4]]] },
  "!": { w: 0, p: [[[0, 6], [0, 1.9]], dot(0)] },
  "?": { w: 3.4, p: [[...arc(1.7, 4.3, 1.7, 1.7, 160, -55), [1.7, 2.2], [1.7, 1.8]], dot(1.7)] },
  "+": { w: 3.4, p: [[[0, 2.8], [3.4, 2.8]], [[1.7, 1.1], [1.7, 4.5]]] },
  "/": { w: 3, p: [[[0, -0.4], [3, 6.4]]] },
  "&": { w: 4.4, p: [[[4.4, 0], ...arc(1.75, 4.65, 1.25, 1.35, -40, 215), ...arc(1.9, 1.75, 1.9, 1.75, 125, 330).slice(1), [4.2, 2.8]]] },
  "#": { w: 4, p: [[[1.2, 0], [1.6, 6]], [[2.8, 0], [3.2, 6]], [[0, 2], [4, 2]], [[0, 4], [4, 4]]] },
  "°": { w: 1.8, p: [loop(0.9, 5.1, 0.9, 0.9)] },
  "€": { w: 4.4, p: [arc(2.6, 3, 2.3, 3, 45, 315), [[0, 3.6], [3, 3.6]], [[0, 2.4], [3, 2.4]]] },
  "(": { w: 0.61, p: [arc(3.4, 3, 3.4, 3.8, 145, 215)] },
  ")": { w: 0.61, p: [arc(-2.79, 3, 3.4, 3.8, 35, -35)] },
  "*": { w: 2.6, p: [[[1.3, 3.4], [1.3, 6]], [[0, 5.2], [2.6, 4.2]], [[0, 4.2], [2.6, 5.2]]] },
};

/** Signes diacritiques (combinants NFD), dessinés autour du centre `c` d'un glyphe de largeur `w`. */
const MARKS: Record<string, (c: number, w: number) => P2[][]> = {
  "́": (c) => [[[c - 0.5, 6.9], [c + 0.6, 8]]],
  "̀": (c) => [[[c + 0.5, 6.9], [c - 0.6, 8]]],
  "̂": (c) => [[[c - 1, 6.9], [c, 7.9], [c + 1, 6.9]]],
  "̈": (c) => [dot(c - 0.9, 7.4), dot(c + 0.9, 7.4)],
  "̃": (c) => [[[c - 1.1, 7], [c - 0.4, 7.7], [c + 0.4, 7.1], [c + 1.1, 7.8]]],
  "̧": (c) => [[[c, 0], [c, -0.6], [c + 0.6, -1], [c - 0.3, -1.6]]],
  "̊": (c) => [loop(c, 7.6, 0.6, 0.6)],
};
const LIGATURES: Record<string, string> = { Œ: "OE", Æ: "AE", ß: "SS", "’": "'", "‘": "'", "«": '"', "»": '"', "–": "-", "—": "-", "…": "..." };

/** Glyphes disponibles (hors lettres accentuées, obtenues par décomposition). */
export const FONT_CHARS = Object.keys(G).join("");

/** Texte ramené à ce que la police sait tracer : capitales, ligatures décomposées, caractères inconnus retirés. */
export function normalizeText(s: string): string {
  let o = "";
  for (const ch of String(s ?? "").toUpperCase()) o += LIGATURES[ch] ?? ch;
  return [...o.normalize("NFD")].filter((c) => c === " " || c === "\n" || G[c] || MARKS[c]).join("").normalize("NFC");
}

export type TextLayout = {
  /** Polylignes, hauteur de capitale 1, centrées horizontalement ; la ligne du haut a sa ligne de base en y = 0. */
  polys: P2[][];
  /** Largeur de la plus longue ligne (hauteur de capitale = 1). */
  width: number;
  /** Hauteur totale des lignes (capitales seules). */
  height: number;
  lines: number;
};

export type LayoutOptions = {
  /** Interlettrage en hauteurs de capitale (défaut 0,22 + graisse). */
  tracking?: number;
  /** Graisse : demi-épaisseur du trait en hauteurs de capitale (sert à l'interlettrage). */
  weight?: number;
  /** Interligne (défaut 1,5). */
  leading?: number;
  /** Alignement des lignes. */
  align?: "center" | "left" | "right";
};

/**
 * Mise en page : glyphes enchaînés, lignes séparées par `\n`. Les coordonnées sont en hauteurs de capitale (1 = une
 * capitale). Tout le texte tient dans x ∈ [−width/2, width/2], y ∈ [−height + 1, 1] (ligne de base du bas en
 * y = −(lines − 1)·leading).
 */
export function layoutText(text: string, o: LayoutOptions = {}): TextLayout {
  const wgt = o.weight ?? 0.09;
  const track = (o.tracking ?? 0.22 + wgt * 2) * 6;
  const leading = o.leading ?? 1.5;
  const lines = normalizeText(text).split("\n");
  const polys: P2[][] = [];
  let width = 0;
  const laid = lines.map((line) => {
    const out: P2[][] = [];
    let x = 0;
    let first = true;
    let lastGlyph: { x: number; w: number } | null = null;
    for (const ch of [...line.normalize("NFD")]) {
      if (ch === " ") {
        x += 2.4 + track * 0.5;
        continue;
      }
      const mark = MARKS[ch];
      if (mark) {
        const prev: { x: number; w: number } | null = lastGlyph;
        if (prev) for (const pl of mark(prev.x + prev.w / 2, prev.w)) out.push(pl);
        continue;
      }
      const g = G[ch];
      if (!g) continue;
      if (!first) x += track;
      first = false;
      for (const pl of g.p) out.push(pl.map(([a, b]) => [a + x, b] as P2));
      lastGlyph = { x, w: g.w };
      x += g.w;
    }
    width = Math.max(width, x);
    return { out, w: x };
  });
  const align = o.align ?? "center";
  laid.forEach(({ out, w }, li) => {
    const dx = align === "left" ? -width / 2 : align === "right" ? width / 2 - w : -w / 2;
    const dy = -li * leading * 6;
    for (const pl of out) polys.push(pl.map(([a, b]) => [(a + dx) / 6, (b + dy) / 6] as P2));
  });
  return { polys, width: width / 6, height: 1 + (lines.length - 1) * leading, lines: lines.length };
}

/** Distance d'un point au tracé (segments), sans la demi-épaisseur. Boîte englobante pour sortir vite. */
export class StrokeField {
  private seg: Float64Array;
  readonly min: P2 = [Infinity, Infinity];
  readonly max: P2 = [-Infinity, -Infinity];
  constructor(polys: P2[][]) {
    const s: number[] = [];
    for (const pl of polys)
      for (let i = 0; i + 1 < pl.length; i++) {
        s.push(pl[i][0], pl[i][1], pl[i + 1][0], pl[i + 1][1]);
        for (const q of [pl[i], pl[i + 1]]) {
          this.min[0] = Math.min(this.min[0], q[0]);
          this.min[1] = Math.min(this.min[1], q[1]);
          this.max[0] = Math.max(this.max[0], q[0]);
          this.max[1] = Math.max(this.max[1], q[1]);
        }
      }
    this.seg = Float64Array.from(s);
  }
  distance(x: number, y: number, cutoff = Infinity): number {
    if (x < this.min[0] - cutoff || x > this.max[0] + cutoff || y < this.min[1] - cutoff || y > this.max[1] + cutoff) return cutoff;
    const s = this.seg;
    let best = Infinity;
    for (let i = 0; i < s.length; i += 4) {
      const ax = s[i], ay = s[i + 1], bx = s[i + 2] - ax, by = s[i + 3] - ay;
      const px = x - ax, py = y - ay;
      const ll = bx * bx + by * by;
      const t = ll > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / ll)) : 0;
      const dx = px - bx * t, dy = py - by * t;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
}

/**
 * Texte d'une seule ligne trop allongé pour sa zone (largeur / hauteur `aspect`) : coupé en deux au blanc le plus
 * central, ce qui permet des lettres plus grandes. Les mots très courts ne restent pas seuls sur une ligne.
 */
export function balanceLines(text: string, aspect: number, weight = 0.1): string {
  if (text.includes("\n") || !text.includes(" ")) return text;
  const lay = layoutText(text, { weight });
  if (lay.width / Math.max(1e-6, aspect) <= 1.6) return text;
  const mid = text.length / 2;
  let best = -1;
  for (let i = 2; i < text.length - 3; i++) if (text[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best > 0 ? text.slice(0, best) + "\n" + text.slice(best + 1) : text;
}
