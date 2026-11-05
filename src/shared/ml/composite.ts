/**
 * Calculs purs du remplacement par masque : lecture des boîtes de `sonic-object-detector`, formes de masque en
 * pixels, recadrage « cover », échelles de flou et de pixellisation, couleur CSS sûre. Aucun accès au DOM.
 */

export type Box = { label: string; score: number; x: number; y: number; w: number; h: number };

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
    out.push({ label: String(b.label ?? ""), score: finite(b.score) ? b.score : 0, x: b.x, y: b.y, w: b.w, h: b.h });
  }
  return out;
}

/** Étiquette en clé (comme `labels.<clé>` du détecteur) : minuscules, séparateurs → `_`. */
export function labelKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Boîtes retenues : étiquettes (liste séparée par des virgules, vide = toutes), score minimal, au plus `max` (les meilleures). */
export function selectBoxes(boxes: Box[], labels: string, minScore: number, max: number): Box[] {
  const wanted = labels
    .split(",")
    .map((s) => labelKey(s))
    .filter(Boolean);
  return boxes
    .filter((b) => b.score >= minScore && (wanted.length === 0 || wanted.includes(labelKey(b.label))))
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
