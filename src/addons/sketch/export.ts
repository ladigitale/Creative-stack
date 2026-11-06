import { tipGeometry, tipTransform } from "../paint/tip";
import { fitCurve } from "../vector/ops";
import type { BBox } from "../vector/geometry";
import { contentBBox, type Stroke } from "./model";
import { strokeStamps } from "./render";

export const MAX_SVG_STAMPS = 100_000;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const f = (n: number) => String(Number(n.toPrecision(8)));

export type SvgOptions = {
  /** Zone exportée (monde). Défaut : tout le contenu. */
  area?: BBox | null;
  /** Fond (couleur CSS) ou vide pour transparent. */
  background?: string;
  maxStamps?: number;
};

/** Trait « plein » : disque net, opaque, sans variation → un seul tracé lissé au lieu d'une empreinte par pas. */
function isPlainLine(s: Stroke): boolean {
  const b = s.brush;
  if (b.tip || b.hardness < 0.999 || b.opacity < 0.999 || b.scatter > 0 || b.sizeJitter > 0 || b.roundness !== 1) return false;
  if (b.pressure) {
    let lo = 1, hi = 0;
    for (let i = 2; i < s.pts.length; i += 3) { lo = Math.min(lo, s.pts[i]); hi = Math.max(hi, s.pts[i]); }
    if (hi - lo > 0.02) return false;
  }
  return true;
}

/**
 * Document SVG d'un dessin. Traits nets → tracés de courbes ; pointes personnalisées → `<use>` d'un seul
 * `<path>` partagé ; disques doux → cercles à dégradé partagé. Lève une erreur au-delà de `maxStamps`.
 */
export function exportSvg(strokes: Stroke[], opts: SvgOptions = {}): string {
  const max = opts.maxStamps ?? MAX_SVG_STAMPS;
  const area = opts.area ?? contentBBox(strokes) ?? { x: 0, y: 0, w: 1, h: 1 };
  const m = Math.max(area.w, area.h) * 0.02;
  const vb = { x: area.x - m, y: area.y - m, w: Math.max(area.w + 2 * m, 1e-9), h: Math.max(area.h + 2 * m, 1e-9) };
  const defs: string[] = [];
  const tipIds = new Map<string, string>();
  const gradIds = new Map<string, string>();
  const body: string[] = [];
  let count = 0;

  for (const st of strokes) {
    const b = st.brush;
    const op = b.opacity < 0.999 ? ` opacity="${f(b.opacity)}"` : "";
    if (isPlainLine(st)) {
      const pts: [number, number][] = [];
      for (let i = 0; i < st.pts.length; i += 3) pts.push([st.pts[i], st.pts[i + 1]]);
      const first = pts[0];
      if (pts.length === 1 || pts.every((p) => p[0] === first[0] && p[1] === first[1])) {
        body.push(`<circle cx="${f(first[0])}" cy="${f(first[1])}" r="${f(b.size / 2)}" fill="${esc(b.color)}"/>`);
      } else {
        const d = fitCurve(pts, b.size * 0.04);
        if (d) body.push(`<path d="${d}" fill="none" stroke="${esc(b.color)}" stroke-width="${f(b.size)}" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
      continue;
    }
    const stamps = strokeStamps(st);
    count += stamps.length;
    if (count > max) throw new Error(`export SVG : trop d'empreintes (> ${max})`);
    const geo = b.tip ? tipGeometry(b.tip) : null;
    if (geo) {
      let id = tipIds.get(b.tip);
      if (!id) {
        id = `t${tipIds.size + 1}`;
        tipIds.set(b.tip, id);
        defs.push(`<path id="${id}" d="${esc(b.tip)}"/>`);
      }
      const parts = [`<g fill="${esc(b.color)}">`];
      for (const s of stamps) parts.push(`<use href="#${id}" transform="${tipTransform(geo, s.x, s.y, s.size, s.rot, s.squash)}"${op}/>`);
      parts.push("</g>");
      body.push(parts.join(""));
      continue;
    }
    let fill = esc(b.color);
    if (b.hardness < 0.999) {
      const key = `${b.color}|${b.hardness.toFixed(3)}`;
      let id = gradIds.get(key);
      if (!id) {
        id = `g${gradIds.size + 1}`;
        gradIds.set(key, id);
        defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="${esc(b.color)}"/><stop offset="${f(b.hardness)}" stop-color="${esc(b.color)}"/><stop offset="1" stop-color="${esc(b.color)}" stop-opacity="0"/></radialGradient>`);
      }
      fill = `url(#${id})`;
    }
    const parts = [`<g fill="${fill}">`];
    for (const s of stamps) {
      const r = s.size / 2;
      if (s.squash === 1) parts.push(`<circle cx="${f(s.x)}" cy="${f(s.y)}" r="${f(r)}"${op}/>`);
      else parts.push(`<ellipse cx="${f(s.x)}" cy="${f(s.y)}" rx="${f(r * s.squash)}" ry="${f(r)}" transform="rotate(${f((s.rot * 180) / Math.PI)} ${f(s.x)} ${f(s.y)})"${op}/>`);
    }
    parts.push("</g>");
    body.push(parts.join(""));
  }

  const bg = opts.background && opts.background !== "transparent" ? `<rect x="${f(vb.x)}" y="${f(vb.y)}" width="${f(vb.w)}" height="${f(vb.h)}" fill="${esc(opts.background)}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vb.x)} ${f(vb.y)} ${f(vb.w)} ${f(vb.h)}">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${bg}${body.join("")}</svg>`;
}
