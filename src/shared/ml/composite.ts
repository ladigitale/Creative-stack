/**
 * Calculs purs du remplacement par masque : lecture des boîtes de `sonic-object-detector`, formes de masque en
 * pixels, recadrage « cover », échelles de flou et de pixellisation, couleur CSS sûre. Aucun accès au DOM.
 */

export type Box = { label: string; score: number; x: number; y: number; w: number; h: number; /** Identité (`sonic-object-detector track="true"`). */ id?: number };

export type Shape = { kind: "rect" | "ellipse"; x: number; y: number; w: number; h: number };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Boîtes (0..1, repère écran) de la sortie d'un `sonic-object-detector` (`objects[]`) ; entrées invalides ignorées. */
export function boxesOf(output: unknown): Box[] {
  const list = (output as { objects?: unknown } | null | undefined)?.objects;
  if (!Array.isArray(list)) return [];
  const out: Box[] = [];
  for (const o of list) {
    const b = o as Partial<Box> | null;
    if (!b || !finite(b.x) || !finite(b.y) || !finite(b.w) || !finite(b.h) || b.w <= 0 || b.h <= 0) continue;
    out.push({ label: String(b.label ?? ""), score: finite(b.score) ? b.score : 0, x: b.x, y: b.y, w: b.w, h: b.h, ...(finite(b.id) ? { id: b.id } : {}) });
  }
  return out;
}

/** Étiquette en clé (comme `labels.<clé>` du détecteur) : minuscules, séparateurs → `_`. */
export function labelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Boîtes retenues : étiquettes (liste séparée par des virgules, vide = toutes), score minimal, au plus `max` (les meilleures).
 * `id` (> 0) : seulement l'objet de cette identité (les boîtes sans `id` sont alors écartées).
 */
export function selectBoxes(boxes: Box[], labels: string, minScore: number, max: number, id = 0): Box[] {
  const wanted = labels
    .split(",")
    .map((s) => labelKey(s))
    .filter(Boolean);
  return boxes
    .filter((b) => b.score >= minScore && (wanted.length === 0 || wanted.includes(labelKey(b.label))) && (!(id > 0) || b.id === id))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, Math.floor(max)));
}

/** Formes en pixels pour une image `width × height`, agrandies de `pad` (part de la taille de la boîte, de chaque côté). */
export function shapesOf(boxes: Box[], width: number, height: number, kind: "rect" | "ellipse", pad: number): Shape[] {
  const p = Math.max(0, Math.min(1, pad));
  return boxes.map((b) => {
    const px = b.w * p;
    const py = b.h * p;
    const x0 = Math.max(0, b.x - px);
    const y0 = Math.max(0, b.y - py);
    const x1 = Math.min(1, b.x + b.w + px);
    const y1 = Math.min(1, b.y + b.h + py);
    return { kind, x: x0 * width, y: y0 * height, w: (x1 - x0) * width, h: (y1 - y0) * height };
  });
}

/** Zone 0..1 d'une boîte agrandie de `pad` (part de sa taille de chaque côté), bornée à l'image ; `mirror` : repère écran → image brute. */
export function cropBox(b: Box, pad: number, mirror: boolean): { x: number; y: number; w: number; h: number } {
  const p = Math.max(0, Math.min(1, pad));
  const x0 = clamp01(b.x - b.w * p);
  const y0 = clamp01(b.y - b.h * p);
  const x1 = clamp01(b.x + b.w + b.w * p);
  const y1 = clamp01(b.y + b.h + b.h * p);
  const w = x1 - x0;
  return { x: mirror ? 1 - x1 : x0, y: y0, w, h: y1 - y0 };
}

/** Zone de la source à dessiner pour remplir `dw × dh` sans déformer (recadrage centré). */
export function coverRect(sw: number, sh: number, dw: number, dh: number): { sx: number; sy: number; sw: number; sh: number } {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return { sx: 0, sy: 0, sw: Math.max(sw, 0), sh: Math.max(sh, 0) };
  const srcRatio = sw / sh;
  const dstRatio = dw / dh;
  if (srcRatio > dstRatio) {
    const w = sh * dstRatio;
    return { sx: (sw - w) / 2, sy: 0, sw: w, sh };
  }
  const h = sw / dstRatio;
  return { sx: 0, sy: (sh - h) / 2, sw, sh: h };
}

/** Diviseur de résolution pour un flou : `amount` 0..1 → 2 (léger) à 32 (très flou). */
export function blurDivisor(amount: number): number {
  return 2 + Math.round(clamp01(amount) * 30);
}

/** Diviseur de résolution pour une pixellisation : `amount` 0..1 → 4 à 64 pixels. */
export function pixelDivisor(amount: number): number {
  return 4 + Math.round(clamp01(amount) * 60);
}

/** Diviseur de résolution du fondu des bords du masque : `feather` 0..1 → 1 (net) à 13. */
export function featherDivisor(feather: number): number {
  return 1 + Math.round(clamp01(feather) * 12);
}

/** Couleur CSS limitée aux formes simples (hexadécimal, rgb(a), hsl(a), nom) ; chaîne vide sinon. */
export function safeColor(value: string): string {
  const v = String(value ?? "").trim();
  if (v.length > 60) return "";
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^(rgb|hsl)a?\([0-9.,%\s/a-z-]+\)$/i.test(v) && !/[;{}<>"']/.test(v)) return v;
  if (/^[a-z]{3,20}$/i.test(v)) return v;
  return "";
}

/** Convertit en place un masque « niveaux de gris » (r = g = b = masque, alpha 255) en masque « alpha » (blanc, alpha = masque). */
export function grayToAlpha(data: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0; i + 3 < data.length; i += 4) {
    const v = data[i];
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = v;
  }
}

export type MaskTarget = "background" | "subject";
export type ReplaceEffect = "blur" | "pixelate" | "color" | "image" | "source" | "cutout";

export const EFFECTS: readonly ReplaceEffect[] = ["blur", "pixelate", "color", "image", "source", "cutout"];

export function effectOf(v: string): ReplaceEffect {
  return (EFFECTS as readonly string[]).includes(v) ? (v as ReplaceEffect) : "blur";
}

export type Bounds = { x0: number; y0: number; x1: number; y1: number };

/** Boîte englobante (0..1) des pixels RGBA dont l'alpha dépasse `threshold` (0..255) ; `null` s'il n'y en a aucun. */
export function alphaBounds(data: ArrayLike<number>, width: number, height: number, threshold = 32): Bounds | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || width === 0 || height === 0) return null;
  return { x0: x0 / width, y0: y0 / height, x1: (x1 + 1) / width, y1: (y1 + 1) / height };
}

/** Boîte agrandie de `pad` (part de sa taille, de chaque côté) et bornée à l'image. */
export function padBounds(b: Bounds, pad: number): Bounds {
  const px = (b.x1 - b.x0) * pad;
  const py = (b.y1 - b.y0) * pad;
  return { x0: clamp01(b.x0 - px), y0: clamp01(b.y0 - py), x1: clamp01(b.x1 + px), y1: clamp01(b.y1 + py) };
}

/** Lissage exponentiel d'une boîte (`keep` 0 = pas de lissage). */
export function mixBounds(prev: Bounds | null, next: Bounds, keep: number): Bounds {
  if (!prev || keep <= 0) return next;
  const k = Math.min(0.95, keep);
  const m = (a: number, b: number) => a * k + b * (1 - k);
  return { x0: m(prev.x0, next.x0), y0: m(prev.y0, next.y0), x1: m(prev.x1, next.x1), y1: m(prev.y1, next.y1) };
}

export type Placement = {
  /** Centre du sprite, 0..1 de la scène. */
  x: number;
  y: number;
  /** Hauteur du sprite en part de la hauteur de la scène. */
  scale: number;
  /** Degrés, sens horaire. */
  rotation: number;
};

/** Taille du sprite dessiné pour une scène `sceneW × sceneH` : hauteur = `scale` × hauteur de la scène, proportions conservées. */
export function spriteSize(spriteW: number, spriteH: number, sceneH: number, scale: number): { w: number; h: number } {
  if (spriteW <= 0 || spriteH <= 0) return { w: 0, h: 0 };
  const h = Math.max(0, scale) * sceneH;
  return { w: (h * spriteW) / spriteH, h };
}
