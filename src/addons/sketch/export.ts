import { tipGeometry, tipTransform } from "../paint/tip";
import { fitCurve, intersects, type BBox, type Multi } from "../vector";

/**
 * Polygones exacts, coordonnées en double précision (pas d'ajustement de courbes ni d'arrondi : le détail
 * tracé à un zoom extrême doit survivre à l'export).
 */
const fx = (n: number) => String(+n.toPrecision(15));
const multiPath = (m: Multi): string =>
  m.flat().filter((r) => r.length >= 3).map((r) => "M" + r.map(([x, y]) => fx(x) + "," + fx(y)).join("L") + "Z").join("");
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
  /** Marge autour de la zone, en fraction de son grand côté. Défaut 0.02 (aucune pour une zone de vue). */
  margin?: number;
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
  const m = Math.max(area.w, area.h) * Math.max(0, opts.margin ?? 0.02);
  const vb = { x: area.x - m, y: area.y - m, w: Math.max(area.w + 2 * m, 1e-9), h: Math.max(area.h + 2 * m, 1e-9) };
  const defs: string[] = [];
  const tipIds = new Map<string, string>();
  const gradIds = new Map<string, string>();
  const body: string[] = [];
  let count = 0;

  let masks = 0;
  for (const st of strokes) {
    // Culling : hors de la zone exportée, le trait ne produit rien.
    if (opts.area && !intersects(st.bbox, opts.area)) continue;
    if (st.mask) {
      // Gomme : tout ce qui est dessous passe dans un groupe masqué (trou net, traits non aplatis compris).
      const d = multiPath(st.mask);
      if (!d || !body.length) continue;
      const id = `m${++masks}`;
      const fo = st.brush.opacity < 0.999 ? ` fill-opacity="${f(st.brush.opacity)}"` : "";
      defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${f(vb.x)}" y="${f(vb.y)}" width="${f(vb.w)}" height="${f(vb.h)}"><rect x="${f(vb.x)}" y="${f(vb.y)}" width="${f(vb.w)}" height="${f(vb.h)}" fill="#fff"/><path d="${d}" fill="#000"${fo} fill-rule="evenodd"/></mask>`);
      body.splice(0, body.length, `<g mask="url(#${id})">${body.join("")}</g>`);
      continue;
    }
    const b = st.brush;
    const op = b.opacity < 0.999 ? ` opacity="${f(b.opacity)}"` : "";
    if (st.erase) {
      // Gomme en empreintes : ses empreintes, en noir, forment un masque sur tout ce qui est dessous.
      const at = body.length;
      emit(st, { ...b, color: "#000000" }, op);
      const inner = body.splice(at).join("");
      if (!inner || !body.length) continue;
      const id = `m${++masks}`;
      defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" x="${f(vb.x)}" y="${f(vb.y)}" width="${f(vb.w)}" height="${f(vb.h)}"><rect x="${f(vb.x)}" y="${f(vb.y)}" width="${f(vb.w)}" height="${f(vb.h)}" fill="#fff"/>${inner}</mask>`);
      body.splice(0, body.length, `<g mask="url(#${id})">${body.join("")}</g>`);
      continue;
    }
    const at = body.length;
    emit(st, b, op);
    // Mode de fusion : le trait entier (ses empreintes réunies) fusionne avec ce qui est dessous.
    if (b.blend && b.blend !== "normal" && body.length > at) {
      body.splice(at, body.length - at, `<g style="mix-blend-mode:${b.blend}">${body.slice(at).join("")}</g>`);
    }
  }

  function emit(st: Stroke, b: Stroke["brush"], op: string): void {
    if (st.flat) {
      // Carte d'aplats : un chemin par couleur (régions disjointes).
      for (const r of st.flat) {
        const d = multiPath(r.shape);
        if (!d) continue;
        const rgb = r.color.slice(0, 7);
        const fo = r.rgba[3] < 0.999 ? ` fill-opacity="${f(r.rgba[3])}"` : "";
        const mix = r.blend ? ` style="mix-blend-mode:${r.blend}"` : "";
        // Région opaque : un trait fin de même couleur (épaisseur fixe à l'écran) scelle les bords communs.
        const seal = !fo && !mix ? ` stroke="${rgb}" stroke-width="0.75" stroke-linejoin="round" vector-effect="non-scaling-stroke"` : "";
        body.push(`<path d="${d}" fill="${rgb}"${fo} fill-rule="evenodd"${seal}${mix}/>`);
      }
      return;
    }
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
      return;
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
      return;
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

  joinPaths(body);
  const bg = opts.background && opts.background !== "transparent" ? `<rect x="${f(vb.x)}" y="${f(vb.y)}" width="${f(vb.w)}" height="${f(vb.h)}" fill="${esc(opts.background)}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vb.x)} ${f(vb.y)} ${f(vb.w)} ${f(vb.h)}">${defs.length ? `<defs>${defs.join("")}</defs>` : ""}${bg}${body.join("")}</svg>`;
}

const PLAIN_PATH = /^<path d="([^"]+)" (fill="none" stroke="[^"]*" stroke-width="[^"]*" stroke-linecap="round" stroke-linejoin="round")\/>$/;

/** Jointure : les tracés nets consécutifs de même style deviennent un seul `<path>` à plusieurs sous-tracés. */
export function joinPaths(body: string[]): void {
  let w = 0;
  let prev: { d: string; attrs: string } | null = null;
  const flush = () => { if (prev) body[w++] = `<path d="${prev.d}" ${prev.attrs}/>`; prev = null; };
  const items = body.slice();
  for (const it of items) {
    const m = PLAIN_PATH.exec(it);
    if (m && prev && prev.attrs === m[2]) { prev.d += m[1]; continue; }
    flush();
    if (m) prev = { d: m[1], attrs: m[2] };
    else body[w++] = it;
  }
  flush();
  body.length = w;
}
