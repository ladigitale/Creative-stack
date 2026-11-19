import { encode } from "uqr";

/** Niveau de correction d'erreur : L 7 %, M 15 %, Q 25 %, H 30 % de modules récupérables. */
export type QrEcc = "L" | "M" | "Q" | "H";

/** Au-delà, le code devient trop dense pour être lu à l'écran par un téléphone. */
export const MAX_QR_TEXT = 1200;

export type QrMatrix = { size: number; version: number; modules: boolean[][] };

export function sanitizeEcc(v: unknown, fallback: QrEcc = "M"): QrEcc {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s === "L" || s === "M" || s === "Q" || s === "H" ? s : fallback;
}

/**
 * Matrice d'un QR code (modules noirs = true), sans marge : la marge (zone de silence) est ajoutée
 * au dessin. `null` si le texte est vide ; erreur si trop long.
 */
export function qrMatrix(text: string, ecc: QrEcc = "M"): QrMatrix | null {
  if (!text) return null;
  if (text.length > MAX_QR_TEXT) throw new Error(`texte trop long pour un QR code lisible (${MAX_QR_TEXT} caractères au plus)`);
  // Encodé en UTF-8 (accents, émojis) : uqr ne prend que du Latin-1 en chaîne.
  const bytes = Array.from(new TextEncoder().encode(text));
  const ascii = bytes.every((b) => b < 128);
  const r = encode(ascii ? text : bytes, { ecc, border: 0 });
  return { size: r.size, version: r.version, modules: r.data };
}

/**
 * Chemin SVG des modules noirs, coordonnées en modules décalées de `margin` : une suite de
 * rectangles fusionnés par ligne (`M x y h n v1 h -n z`), un seul élément `<path>` à dessiner.
 */
export function qrPath(m: QrMatrix, margin = 2): string {
  let d = "";
  for (let y = 0; y < m.size; y++) {
    const row = m.modules[y];
    let x = 0;
    while (x < m.size) {
      if (!row[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < m.size && row[x + w]) w++;
      d += `M${x + margin} ${y + margin}h${w}v1h-${w}z`;
      x += w;
    }
  }
  return d;
}

/** Lien cliquable seulement pour http(s) (jamais javascript:, data:…). */
export function safeHref(text: string): string | null {
  try {
    const u = new URL(text);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
