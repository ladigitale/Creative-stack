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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type QrImageOptions = {
  margin?: number;
  color?: string;
  background?: string;
  /** Texte à côté du code (lignes séparées par « \n »), pour une étiquette. */
  caption?: string;
  /** `right` (étiquette en longueur, 2,5:1) ou `below`. */
  position?: "right" | "below";
  /** Côté du code en pixels dans l'image. */
  px?: number;
};

/**
 * Image SVG autonome (code + légende facultative) : à imprimer (`sonic-still` → `sonic-label-printer`),
 * télécharger ou partager. Couleurs nettoyées (pas d'injection dans le SVG), texte échappé.
 */
export function qrImage(m: QrMatrix, o: QrImageOptions = {}): { svg: string; width: number; height: number } {
  const margin = Math.max(0, Math.min(8, Math.round(o.margin ?? 2)));
  const total = m.size + margin * 2;
  const px = Math.max(48, Math.min(2048, Math.round(o.px ?? 240)));
  const unit = px / total;
  const color = safeColor(o.color, "#000000"), bg = safeColor(o.background, "#ffffff");
  const lines = (o.caption ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 4);
  const pos = o.position === "below" ? "below" : "right";
  let width = px, height = px, text = "";
  if (lines.length) {
    if (pos === "right") {
      width = Math.round(px * 2.5);
      const fs = Math.round(Math.min(px / (lines.length * 1.25 + 0.5), (width - px) / Math.max(...lines.map((l) => l.length * 0.56), 1)));
      const y0 = (px - lines.length * fs * 1.2) / 2 + fs;
      text = lines.map((l, i) => `<text x="${px + fs * 0.4}" y="${(y0 + i * fs * 1.2).toFixed(1)}" font-size="${fs}">${esc(l)}</text>`).join("");
    } else {
      const fs = Math.round(Math.min(px / 7, px / Math.max(...lines.map((l) => l.length * 0.56), 1)));
      height = Math.round(px + lines.length * fs * 1.25 + fs * 0.4);
      text = lines.map((l, i) => `<text x="${px / 2}" y="${(px + fs * 1.1 + i * fs * 1.25).toFixed(1)}" font-size="${fs}" text-anchor="middle">${esc(l)}</text>`).join("");
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="${bg}"/>`
    + `<g transform="scale(${unit.toFixed(5)})" shape-rendering="crispEdges"><path d="${qrPath(m, margin)}" fill="${color}"/></g>`
    + (text ? `<g fill="${color}" font-family="Helvetica, Arial, sans-serif" font-weight="700">${text}</g>` : "")
    + `</svg>`;
  return { svg, width, height };
}

/** Couleur CSS simple (#hex, nom, rgb/hsl) ; sinon le repli. */
export function safeColor(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  return /^(#[0-9a-f]{3,8}|[a-z]{3,20}|(rgb|hsl)a?\([0-9.,%\s]+\))$/i.test(s) ? s : fallback;
}

/** data: URL d'un SVG (base64, UTF-8). */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}
