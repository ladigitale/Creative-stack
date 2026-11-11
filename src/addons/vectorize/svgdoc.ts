import {
  boolean,
  flatten,
  multiArea,
  multiBBox,
  parsePath,
  ringsToMulti,
  ringsToPath,
  signedArea,
  type Multi,
  type Poly,
  type Pt,
  type Ring,
} from "../vector";

/**
 * Lecture exacte d'un document SVG en couches remplies (`{color, opacity, d}`), dans l'ordre de dessin : le
 * même format que la vectorisation d'une image, lu par `sonic-sketch import-from`.
 *
 * Le document est analysé par `DOMParser` sans jamais être inséré dans la page : aucun script ne s'exécute,
 * aucune ressource n'est chargée. Pris en charge : `path`, `rect` (coins arrondis), `circle`, `ellipse`,
 * `polygon`, `polyline`, `line`, groupes, `use` interne, `transform`, `viewBox`, couleurs (nommées, hex,
 * rgb, hsl, `currentColor`), `fill` / `stroke` et leurs opacités, `fill-rule`, `opacity`, `display` /
 * `visibility`, styles en attribut, en `style=""` et en `<style>` (sélecteurs simples `.classe`, `#id`,
 * `balise`). Contours : changés en formes pleines (bouts et jointures arrondis). Dégradés : leur couleur
 * moyenne. Ignorés (comptés dans `skipped`) : textes, images, filtres, masques, découpes, motifs.
 */

export type SvgLayer = { color: string; opacity: number; d: string; area: number };
export type SvgImport = { width: number; height: number; paths: SvgLayer[]; skipped: Record<string, number>; truncated: boolean };

export const MAX_SVG_CHARS = 5_000_000;
export const MAX_SVG_ELEMENTS = 20_000;
const MAX_STROKE_SEGMENTS = 20_000;

type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: M, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Facteur d'échelle moyen d'une matrice (pour convertir une tolérance). */
const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

const nums = (s: string): number[] => (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number).filter(Number.isFinite);

export function parseTransform(s: string | null | undefined): M {
  let m: M = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const a = nums(r[2]);
    let t: M = I;
    switch (r[1]) {
      case "matrix": if (a.length >= 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]]; break;
      case "translate": t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case "scale": t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case "rotate": {
        const k = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(k), sn = Math.sin(k);
        const rot: M = [c, sn, -sn, c, 0, 0];
        t = a.length >= 3 ? mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]) : rot;
        break;
      }
      case "skewX": t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}

/* ------------------------------------------------------------ couleurs */

const BASIC: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000", purple: "#800080", fuchsia: "#ff00ff",
  lime: "#00ff00", olive: "#808000", navy: "#000080", teal: "#008080", aqua: "#00ffff", orange: "#ffa500",
};

let probe: CanvasRenderingContext2D | null | undefined;
/** Couleur CSS → `[#rrggbb, alpha]` ; null = aucune (`none`, invalide). Noms : par le canvas si disponible. */
export function parseCssColor(raw: string): [string, number] | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === "none" || s === "transparent") return null;
  const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return ["#" + h.slice(0, 6), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (v: string) => (v.endsWith("%") ? (parseFloat(v) * 255) / 100 : parseFloat(v));
    if (parts.length < 3) return null;
    const a = parts[3] !== undefined ? (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    const rgb = parts.slice(0, 3).map(ch);
    return rgb.every(Number.isFinite) ? [hex(rgb[0], rgb[1], rgb[2]), Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1] : null;
  }
  m = /^hsla?\(([^)]*)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((v) => parseFloat(v));
    if (p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) return null;
    const h = (((p[0] % 360) + 360) % 360) / 60, sat = p[1] / 100, l = p[2] / 100;
    const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs((h % 2) - 1)), o = l - c / 2;
    const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return [hex((r + o) * 255, (g + o) * 255, (b + o) * 255), p[3] !== undefined && Number.isFinite(p[3]) ? Math.max(0, Math.min(1, p[3])) : 1];
  }
  if (BASIC[s]) return [BASIC[s], 1];
  if (/^[a-z]+$/.test(s) && typeof document !== "undefined") {
    if (probe === undefined) {
      try { probe = document.createElement("canvas").getContext("2d"); } catch { probe = null; }
    }
    if (probe) {
      probe.fillStyle = "#010203";
      probe.fillStyle = s;
      const v = String(probe.fillStyle);
      if (v !== "#010203") return parseCssColor(v);
    }
  }
  return null;
}

/* ------------------------------------------------------------ styles */

type Style = Record<string, string>;
const INHERITED = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-opacity", "stroke-width", "color", "visibility"];
const PROPS = new Set([...INHERITED, "opacity", "display"]);

function parseDecls(s: string | null): Style {
  const out: Style = {};
  if (!s) return out;
  for (const decl of s.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase(), v = decl.slice(i + 1).replace(/!important/i, "").trim();
    if (PROPS.has(k) && v) out[k] = v;
  }
  return out;
}

type Rule = { sel: string; style: Style };
/** Règles `<style>` simples : `.classe`, `#id`, `balise`, `balise.classe` (les autres sélecteurs sont ignorés). */
function parseSheet(css: string): Rule[] {
  const rules: Rule[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@[^{]+\{([^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) && rules.length < 2000) {
    const style = parseDecls(m[2]);
    if (!Object.keys(style).length) continue;
    for (const sel of m[1].split(",").map((x) => x.trim())) if (/^[a-z]*(?:[.#][\w-]+)*$/i.test(sel) && sel) rules.push({ sel, style });
  }
  return rules;
}

function matches(el: Element, sel: string): boolean {
  const tag = /^[a-z]+/i.exec(sel)?.[0];
  if (tag && el.localName.toLowerCase() !== tag.toLowerCase()) return false;
  const classes = (el.getAttribute("class") ?? "").split(/\s+/);
  for (const part of sel.match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === "." && !classes.includes(part.slice(1))) return false;
    if (part[0] === "#" && el.getAttribute("id") !== part.slice(1)) return false;
  }
  return true;
}

/* ------------------------------------------------------------ géométrie des éléments */

const attr = (el: Element, k: string, d = 0): number => {
  const v = parseFloat(el.getAttribute(k) ?? "");
  return Number.isFinite(v) ? v : d;
};

/** Chemin SVG (`d`) d'un élément de forme, dans son repère. */
function shapePath(el: Element): { d: string; closed: boolean } | null {
  const n = (v: number) => +v.toFixed(6);
  switch (el.localName) {
    case "path": return { d: el.getAttribute("d") ?? "", closed: true };
    case "rect": {
      const x = attr(el, "x"), y = attr(el, "y"), w = attr(el, "width"), h = attr(el, "height");
      if (!(w > 0 && h > 0)) return null;
      let rx = el.hasAttribute("rx") ? attr(el, "rx") : NaN, ry = el.hasAttribute("ry") ? attr(el, "ry") : NaN;
      if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
      if (!Number.isFinite(ry)) ry = rx;
      rx = Math.min(Math.max(0, rx), w / 2); ry = Math.min(Math.max(0, ry), h / 2);
      if (!rx || !ry) return { d: `M${n(x)},${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`, closed: true };
      return { d: `M${n(x + rx)},${n(y)}H${n(x + w - rx)}A${n(rx)},${n(ry)} 0 0 1 ${n(x + w)},${n(y + ry)}V${n(y + h - ry)}A${n(rx)},${n(ry)} 0 0 1 ${n(x + w - rx)},${n(y + h)}H${n(x + rx)}A${n(rx)},${n(ry)} 0 0 1 ${n(x)},${n(y + h - ry)}V${n(y + ry)}A${n(rx)},${n(ry)} 0 0 1 ${n(x + rx)},${n(y)}Z`, closed: true };
    }
    case "circle":
    case "ellipse": {
      const cx = attr(el, "cx"), cy = attr(el, "cy");
      const rx = el.localName === "circle" ? attr(el, "r") : attr(el, "rx"), ry = el.localName === "circle" ? rx : attr(el, "ry");
      if (!(rx > 0 && ry > 0)) return null;
      return { d: `M${n(cx - rx)},${n(cy)}A${n(rx)},${n(ry)} 0 1 0 ${n(cx + rx)},${n(cy)}A${n(rx)},${n(ry)} 0 1 0 ${n(cx - rx)},${n(cy)}Z`, closed: true };
    }
    case "polygon":
    case "polyline": {
      const p = nums(el.getAttribute("points") ?? "");
      if (p.length < 4) return null;
      const pts: string[] = [];
      for (let i = 0; i + 1 < p.length; i += 2) pts.push(`${p[i]},${p[i + 1]}`);
      return { d: "M" + pts.join("L") + (el.localName === "polygon" ? "Z" : ""), closed: el.localName === "polygon" };
    }
    case "line":
      return { d: `M${attr(el, "x1")},${attr(el, "y1")}L${attr(el, "x2")},${attr(el, "y2")}`, closed: false };
  }
  return null;
}

/** Remplissage d'un ensemble de contours selon la règle : `evenodd` = ou exclusif des contours ; `nonzero` = union des contours de même sens, moins les autres. */
function fillShape(rings: Ring[], rule: string): Multi {
  const rs = rings.filter((r) => r.length >= 3);
  if (!rs.length) return [];
  if (rs.length === 1) return ringsToMulti(rs);
  try {
    if (rule === "evenodd") return boolean("xor", [[rs[0]]], ...rs.slice(1).map((r): Multi => [[r]]));
    const main = rs.reduce((a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a));
    const sign = Math.sign(signedArea(main));
    const pos = rs.filter((r) => Math.sign(signedArea(r)) === sign).map((r): Poly => [r]);
    const neg = rs.filter((r) => Math.sign(signedArea(r)) !== sign).map((r): Poly => [r]);
    const plus = pos.length > 1 ? boolean("union", [pos[0]], ...pos.slice(1).map((p) => [p])) : [pos[0]];
    return neg.length ? boolean("difference", plus, ...neg.map((p) => [p])) : plus;
  } catch {
    return ringsToMulti(rs);
  }
}

/** Contour d'épaisseur `w` (bouts et jointures arrondis) : union de bandes et de disques. */
function strokeShape(lines: { ring: Ring; closed: boolean }[], w: number, tol: number, budget: { n: number }): Multi {
  const r = w / 2;
  const sides = Math.max(8, Math.min(48, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - Math.min(tol, r) / r)))));
  const disc = (c: Pt): Poly => [Array.from({ length: sides }, (_, i): Pt => [c[0] + Math.cos((i / sides) * Math.PI * 2) * r, c[1] + Math.sin((i / sides) * Math.PI * 2) * r])];
  const pieces: Multi = [];
  for (const { ring, closed } of lines) {
    const pts = closed ? [...ring, ring[0]] : ring;
    for (let i = 0; i < pts.length; i++) {
      if (--budget.n < 0) break;
      pieces.push(disc(pts[i]));
      if (i + 1 < pts.length) {
        const [a, b] = [pts[i], pts[i + 1]];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-9) continue;
        const nx = (-(b[1] - a[1]) / len) * r, ny = ((b[0] - a[0]) / len) * r;
        pieces.push([[[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]]]);
      }
    }
  }
  if (!pieces.length) return [];
  return boolean("union", [pieces[0]], ...pieces.slice(1).map((p) => [p]));
}

/* ------------------------------------------------------------ lecture */

export type ParseSvgOptions = {
  /** Tolérance d'aplatissement des courbes, en unités du `viewBox` (défaut : 1/500 de son grand côté). */
  tol?: number;
  /** Analyseur XML (tests) ; défaut `DOMParser`. */
  parse?: (text: string) => Document;
};

export function parseSvgDocument(text: string, opts: ParseSvgOptions = {}): SvgImport {
  const skipped: Record<string, number> = {};
  const skip = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  if (typeof text !== "string" || !text.trim()) throw new Error("SVG vide");
  if (text.length > MAX_SVG_CHARS) throw new Error("SVG trop volumineux");
  const doc = opts.parse ? opts.parse(text) : new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("SVG illisible");

  // Repère : viewBox, sinon width / height ; à défaut, la boîte du contenu (calculée à la fin).
  const vb = nums(root.getAttribute("viewBox") ?? "");
  const vbox = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : null;
  const sizeW = attr(root, "width", NaN), sizeH = attr(root, "height", NaN);
  const base: M = vbox ? [1, 0, 0, 1, -vbox.x, -vbox.y] : I;
  const span = vbox ? Math.max(vbox.w, vbox.h) : Math.max(sizeW || 0, sizeH || 0) || 1000;
  const tol = opts.tol && opts.tol > 0 ? opts.tol : span / 500;

  const byId = new Map<string, Element>();
  const rules: Rule[] = [];
  let count = 0;
  for (const el of Array.from(root.getElementsByTagName("*"))) {
    if (++count > MAX_SVG_ELEMENTS) break;
    const id = el.getAttribute("id");
    if (id) byId.set(id, el);
    if (el.localName === "style") rules.push(...parseSheet(el.textContent ?? ""));
  }

  /** Couleur moyenne d'un dégradé (`url(#id)`), suivi de `href`. */
  const gradient = (ref: string): [string, number] | null => {
    let el = byId.get(ref);
    for (let guard = 0; el && guard < 8; guard++) {
      const stops = Array.from(el.children).filter((c) => c.localName === "stop");
      if (stops.length) {
        let r = 0, g = 0, b = 0, a = 0;
        for (const s of stops) {
          const st = { ...parseDecls(s.getAttribute("style")) };
          const c = parseCssColor(st["stop-color"] ?? s.getAttribute("stop-color") ?? "#000");
          const o = parseFloat(st["stop-opacity"] ?? s.getAttribute("stop-opacity") ?? "1");
          if (!c) continue;
          const w = (Number.isFinite(o) ? o : 1) * c[1];
          r += parseInt(c[0].slice(1, 3), 16) * w; g += parseInt(c[0].slice(3, 5), 16) * w; b += parseInt(c[0].slice(5, 7), 16) * w; a += w;
        }
        if (!(a > 0)) return null;
        const hx = (v: number) => Math.round(v / a).toString(16).padStart(2, "0");
        return ["#" + hx(r) + hx(g) + hx(b), Math.min(1, a / stops.length)];
      }
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      el = href.startsWith("#") ? byId.get(href.slice(1)) : undefined;
    }
    return null;
  };

  const paint = (v: string | undefined, st: Style): [string, number] | null => {
    if (!v) return null;
    const s = v.trim();
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(s);
    if (url) {
      const g = gradient(url[1]);
      if (g) return g;
      const fallback = s.slice(url[0].length).trim();
      return fallback ? paint(fallback, st) : null;
    }
    if (s.toLowerCase() === "currentcolor") return parseCssColor(st.color ?? "#000000");
    return parseCssColor(s);
  };

  const layers: { color: string; opacity: number; shape: Multi }[] = [];
  const budget = { n: MAX_STROKE_SEGMENTS };
  let visited = 0;
  let truncated = false;

  const IGNORED = new Set(["defs", "clipPath", "mask", "symbol", "marker", "pattern", "linearGradient", "radialGradient", "style", "title", "desc", "metadata", "script", "filter"]);
  const NOTED = new Set(["text", "image", "foreignObject", "textPath"]);

  const walk = (el: Element, parent: Style, m: M, alpha: number, depth: number, useDepth: number): void => {
    if (++visited > MAX_SVG_ELEMENTS) { truncated = true; return; }
    if (depth > 64) return;
    const tag = el.localName;
    if (IGNORED.has(tag)) return;
    if (NOTED.has(tag)) { skip(tag); return; }
    // Style : hérité, puis attributs de présentation, puis feuille de style, puis `style=""`.
    const own: Style = {};
    for (const k of PROPS) { const v = el.getAttribute(k); if (v !== null) own[k] = v.trim(); }
    for (const r of rules) if (matches(el, r.sel)) Object.assign(own, r.style);
    Object.assign(own, parseDecls(el.getAttribute("style")));
    if (own.display === "none") return;
    if (el.hasAttribute("filter") || el.hasAttribute("mask") || el.hasAttribute("clip-path")) {
      if (el.hasAttribute("filter")) skip("filter");
      if (el.hasAttribute("mask")) skip("mask");
      if (el.hasAttribute("clip-path")) skip("clip-path");
    }
    const st: Style = {};
    for (const k of INHERITED) if (parent[k] !== undefined) st[k] = parent[k];
    Object.assign(st, own);
    const op = parseFloat(own.opacity ?? "1");
    const a = alpha * (Number.isFinite(op) ? Math.max(0, Math.min(1, op)) : 1);
    let mm = mul(m, parseTransform(el.getAttribute("transform")));

    if (tag === "svg" || tag === "g" || tag === "a" || tag === "switch") {
      if (tag === "svg" && depth > 0) mm = mul(mm, [1, 0, 0, 1, attr(el, "x"), attr(el, "y")]);
      for (const c of Array.from(el.children)) walk(c, st, mm, a, depth + 1, useDepth);
      return;
    }
    if (tag === "use") {
      const href = el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "";
      const target = href.startsWith("#") ? byId.get(href.slice(1)) : undefined;
      if (!target || useDepth > 8) { skip("use"); return; }
      mm = mul(mm, [1, 0, 0, 1, attr(el, "x"), attr(el, "y")]);
      if (target.localName === "symbol") for (const c of Array.from(target.children)) walk(c, st, mm, a, depth + 1, useDepth + 1);
      else walk(target, st, mm, a, depth + 1, useDepth + 1);
      return;
    }
    const geo = shapePath(el);
    if (!geo) { if (!["svg", "g"].includes(tag) && el.namespaceURI === "http://www.w3.org/2000/svg" && !["stop"].includes(tag)) skip(tag); return; }
    if (st.visibility === "hidden" || st.visibility === "collapse") return;
    const segs = parsePath(geo.d);
    if (!segs || !segs.length) return;
    const k = scaleOf(mm);
    const flat = flatten(segs, tol / k);
    const lines = flat.map(({ ring, closed }) => ({ ring: ring.map((p) => apply(mm, p)), closed }));

    // Remplissage (défaut : noir), sauf pour une ligne.
    const fill = tag === "line" ? null : paint(st.fill ?? "#000000", st);
    if (fill) {
      const fo = parseFloat(st["fill-opacity"] ?? "1");
      const opacity = a * fill[1] * (Number.isFinite(fo) ? Math.max(0, Math.min(1, fo)) : 1);
      const shape = fillShape(lines.map((l) => l.ring), (st["fill-rule"] ?? "nonzero").toLowerCase());
      if (shape.length && opacity > 0) layers.push({ color: fill[0], opacity, shape });
    }
    // Contour, changé en forme pleine.
    const stroke = paint(st.stroke, st);
    const sw = parseFloat(st["stroke-width"] ?? "1") * k;
    if (stroke && sw > 0) {
      const so = parseFloat(st["stroke-opacity"] ?? "1");
      const opacity = a * stroke[1] * (Number.isFinite(so) ? Math.max(0, Math.min(1, so)) : 1);
      try {
        const shape = strokeShape(lines.map((l) => ({ ring: l.ring, closed: l.closed && geo.closed })), sw, tol, budget);
        if (shape.length && opacity > 0) layers.push({ color: stroke[0], opacity, shape });
      } catch {
        skip("stroke");
      }
      if (budget.n < 0) truncated = true;
    }
  };

  for (const c of Array.from(root.children)) walk(c, {}, base, 1, 1, 0);
  if (!layers.length) return { width: vbox?.w ?? (sizeW || 0), height: vbox?.h ?? (sizeH || 0), paths: [], skipped, truncated };

  let width = vbox?.w ?? sizeW, height = vbox?.h ?? sizeH;
  let shift: Pt = [0, 0];
  if (!(width > 0 && height > 0)) {
    // Ni viewBox ni taille : le cadre est la boîte du contenu.
    const all = layers.map((l) => multiBBox(l.shape));
    const x0 = Math.min(...all.map((b) => b.x)), y0 = Math.min(...all.map((b) => b.y));
    width = Math.max(...all.map((b) => b.x + b.w)) - x0;
    height = Math.max(...all.map((b) => b.y + b.h)) - y0;
    shift = [-x0, -y0];
  }
  const moved = (m: Multi): Multi => (shift[0] || shift[1] ? m.map((p) => p.map((r) => r.map(([x, y]): Pt => [x + shift[0], y + shift[1]]))) : m);
  const paths = layers.map((l) => {
    const shape = moved(l.shape);
    return { color: l.color, opacity: Math.round(l.opacity * 1000) / 1000, d: ringsToPath(shape.flat()), area: Math.round(multiArea(shape) * 100) / 100 };
  }).filter((p) => p.d);
  return { width, height, paths, skipped, truncated };
}
