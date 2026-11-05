/**
 * Segmentation multi-classes : noms des catégories des modèles connus, sélection d'une réunion de classes
 * (`classes="hair,clothes"` ou indices) et masque combiné. Pur : aucun accès au DOM.
 *
 * Les modèles multi-classes de MediaPipe sortent un masque de confiance par catégorie (même taille, 0..255) ; la
 * réunion garde, pixel par pixel, la plus forte confiance parmi les classes retenues.
 */

export type ClassMask = { width: number; height: number; data: ArrayLike<number> };

/** Catégories par alias de modèle (ordre = indice du masque). */
export const SEGMENT_LABELS: Record<string, string[]> = {
  "selfie-segmenter": ["background", "person"],
  "hair-segmenter": ["background", "hair"],
  "selfie-multiclass": ["background", "hair", "body-skin", "face-skin", "clothes", "others"],
  "deeplab-v3": [
    "background",
    "aeroplane",
    "bicycle",
    "bird",
    "boat",
    "bottle",
    "bus",
    "car",
    "cat",
    "chair",
    "cow",
    "dining-table",
    "dog",
    "horse",
    "motorbike",
    "person",
    "potted-plant",
    "sheep",
    "sofa",
    "train",
    "tv",
  ],
};

/** Liste de noms ou d'indices « a, b 3 » → éléments non vides. */
export function parseList(v: string): string[] {
  return (v ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Noms de classes d'un composant : `labels` explicite, sinon ceux de l'alias de modèle si leur nombre colle aux masques. */
export function labelsFor(explicit: string, modelAlias: string, maskCount: number): string[] {
  const own = parseList(explicit);
  if (own.length > 0) return own.length === maskCount ? own : [];
  const known = SEGMENT_LABELS[modelAlias.trim()];
  return known && known.length === maskCount ? known : [];
}

/**
 * Indices des classes demandées (noms, comparés sans casse ni tirets/underscores, ou indices). `unknown` : jetons non reconnus.
 * Liste vide : aucune sélection demandée.
 */
export function resolveClasses(spec: string, labels: string[], maskCount: number): { indices: number[]; unknown: string[] } {
  const key = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");
  const byName = new Map(labels.map((l, i) => [key(l), i]));
  const indices: number[] = [];
  const unknown: string[] = [];
  for (const tok of parseList(spec)) {
    const named = byName.get(key(tok));
    const n = /^\d+$/.test(tok) ? Number(tok) : -1;
    const i = named !== undefined ? named : n >= 0 && n < maskCount ? n : -1;
    if (i < 0) unknown.push(tok);
    else if (!indices.includes(i)) indices.push(i);
  }
  return { indices, unknown };
}

/** Tout sauf l'arrière-plan (le masque « background » ou, à défaut, l'indice 0). Vide pour un seul masque. */
export function foreground(labels: string[], maskCount: number): number[] {
  if (maskCount < 2) return [];
  const bg = Math.max(0, labels.findIndex((l) => l.toLowerCase() === "background"));
  return Array.from({ length: maskCount }, (_, i) => i).filter((i) => i !== bg);
}

/** Réunion des masques `indices` : maximum pixel par pixel. `null` si rien d'exploitable (indices vides, tailles incohérentes). */
export function combineMasks(masks: ClassMask[], indices: number[]): { width: number; height: number; data: Uint8ClampedArray } | null {
  const chosen = indices.map((i) => masks[i]).filter((m): m is ClassMask => !!m && m.width > 0 && m.height > 0);
  if (chosen.length === 0) return null;
  const { width, height } = chosen[0];
  const usable = chosen.filter((m) => m.width === width && m.height === height && m.data.length >= width * height);
  if (usable.length === 0) return null;
  const out = new Uint8ClampedArray(width * height);
  for (const m of usable) for (let p = 0; p < out.length; p++) if (m.data[p] > out[p]) out[p] = m.data[p];
  return { width, height, data: out };
}
