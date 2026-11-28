/**
 * Projets LightBurn (.lbrn2 et .lbrn, XML) → formes et réglages.
 *
 * Lu : calques de coupe (`CutSetting` : mode Ligne / Remplissage / Ligne+remplissage, puissance max, vitesse
 * en mm/s, passes, écart des lignes) changés en `ops` de `sonic-gcode` par couleur de calque ; formes Rect
 * (coins arrondis), Ellipse, Path (lignes et Bézier), Polygon, Line, groupes, textes (par leur tracé de secours
 * quand il est enregistré), matrices `XForm`. Images et calques masqués ignorés. Unités : millimètres.
 */
import { addArc, apply, IDENTITY, MAX_SHAPES, mul, PathBuilder, Skips, type Mat, type Shape } from "./geom";
import type { LaserOp } from "../toolpath";

/** Palette des calques LightBurn (00 à 29). */
export const LIGHTBURN_COLORS = [
  "#000000", "#0000ff", "#ff0000", "#00e000", "#d0d000", "#ff8000", "#00e0e0", "#ff00ff", "#b4b4b4", "#0000a0",
  "#a00000", "#00a000", "#a0a000", "#c08000", "#00a0ff", "#a000a0", "#808080", "#7d87b9", "#bb7784", "#4a6fe3",
  "#d33f6a", "#8cd78c", "#f0b98d", "#f6c4e1", "#fa9ed4", "#500a78", "#b45a00", "#004754", "#86fa88", "#ffdb66",
];
export const lightburnColor = (i: number) => LIGHTBURN_COLORS[((i % 30) + 30) % 30];

export type LightburnLayer = { index: number; name: string; color: string; mode: string; power: number; speed: number; passes: number; interval: number | null; output: boolean };
export type LightburnResult = { shapes: Shape[]; unitMm: number; ops: LaserOp[]; layers: LightburnLayer[]; skipped: Record<string, number>; issues: string[] };

const val = (el: Element | null | undefined, name: string): string | null => {
  if (!el) return null;
  for (const c of Array.from(el.children)) if (c.tagName === name) return c.getAttribute("Value") ?? c.textContent;
  return el.getAttribute(name);
};
const numVal = (el: Element | null | undefined, name: string, d: number) => {
  const v = Number(val(el, name));
  return Number.isFinite(v) && val(el, name) !== null ? v : d;
};

function xform(el: Element): Mat {
  const x = Array.from(el.children).find((c) => c.tagName === "XForm");
  const n = (x?.textContent ?? "").trim().split(/\s+/).map(Number);
  return n.length === 6 && n.every(Number.isFinite) ? (n as Mat) : IDENTITY;
}

export function readLightburn(text: string): LightburnResult {
  if (typeof DOMParser === "undefined") throw new Error("lecture XML indisponible");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const root = doc.documentElement;
  if (!root || root.tagName !== "LightBurnProject" || doc.getElementsByTagName("parsererror").length) throw new Error("projet LightBurn illisible");
  const skips = new Skips();
  const issues: string[] = [];
  const layers: LightburnLayer[] = [];
  for (const cs of Array.from(root.children).filter((c) => c.tagName === "CutSetting" || c.tagName === "CutSetting_Img")) {
    const index = numVal(cs, "index", 0);
    const type = cs.getAttribute("type") ?? "Cut";
    const mode = cs.tagName === "CutSetting_Img" || type === "Image" ? "image" : type === "Scan" ? "fill" : type === "Scan+Cut" ? "both" : type === "Offset" ? "fill" : "line";
    layers.push({
      index, name: val(cs, "name") ?? `C${String(index).padStart(2, "0")}`, color: lightburnColor(index), mode,
      power: numVal(cs, "maxPower", 20), speed: numVal(cs, "speed", 100) * 60, passes: Math.max(1, numVal(cs, "numPasses", 1)),
      interval: val(cs, "interval") !== null ? numVal(cs, "interval", 0.1) : null, output: val(cs, "output") !== "0",
    });
  }
  const byIndex = new Map(layers.map((l) => [l.index, l]));
  const shapes: Shape[] = [];
  const emit = (el: Element, parent: Mat, depth: number) => {
    if (depth > 32 || shapes.length > MAX_SHAPES) return;
    const type = el.getAttribute("Type") ?? "";
    const m = mul(xform(el), parent);
    const cut = Number(el.getAttribute("CutIndex") ?? 0);
    const layer = byIndex.get(cut);
    if (el.getAttribute("Hidden") === "1") return skips.add("forme masquée");
    if (layer && !layer.output) return skips.add("calque sans sortie");
    const color = lightburnColor(cut);
    const closedFill = layer?.mode === "fill" || layer?.mode === "both";
    const push = (p: PathBuilder, closed: boolean) => {
      if (p.empty) return;
      shapes.push(closed && closedFill ? { segs: p.take(), fill: color, stroke: layer?.mode === "both" ? color : null, evenOdd: true } : { segs: p.take(), stroke: color });
    };
    switch (type) {
      case "Group": {
        const kids = Array.from(el.children).find((c) => c.tagName === "Children");
        for (const k of Array.from(kids?.children ?? [])) if (k.tagName === "Shape") emit(k, m, depth + 1);
        return;
      }
      case "Rect": {
        const w = Number(el.getAttribute("W") ?? 0), h = Number(el.getAttribute("H") ?? 0), r = Math.min(Number(el.getAttribute("Cr") ?? 0), w / 2, h / 2);
        const p = new PathBuilder();
        const P = (x: number, y: number) => apply(m, x, y);
        const x0 = -w / 2, y0 = -h / 2;
        if (r > 0) {
          p.moveTo(...P(x0 + r, y0));
          p.lineTo(...P(x0 + w - r, y0));
          addArc(p, x0 + w - r, y0 + r, r, r, -Math.PI / 2, 0, m);
          p.lineTo(...P(x0 + w, y0 + h - r));
          addArc(p, x0 + w - r, y0 + h - r, r, r, 0, Math.PI / 2, m);
          p.lineTo(...P(x0 + r, y0 + h));
          addArc(p, x0 + r, y0 + h - r, r, r, Math.PI / 2, Math.PI, m);
          p.lineTo(...P(x0, y0 + r));
          addArc(p, x0 + r, y0 + r, r, r, Math.PI, 1.5 * Math.PI, m);
        } else {
          p.moveTo(...P(x0, y0));
          p.lineTo(...P(x0 + w, y0));
          p.lineTo(...P(x0 + w, y0 + h));
          p.lineTo(...P(x0, y0 + h));
        }
        p.close();
        return push(p, true);
      }
      case "Ellipse": {
        const rx = Number(el.getAttribute("Rx") ?? 0), ry = Number(el.getAttribute("Ry") ?? rx);
        if (!(rx > 0)) return;
        const p = new PathBuilder();
        addArc(p, 0, 0, rx, ry, 0, 2 * Math.PI, m, 0, true);
        p.close();
        return push(p, true);
      }
      case "Polygon": {
        const n = Math.max(3, Number(el.getAttribute("N") ?? 6)), r = Number(el.getAttribute("Ry") ?? el.getAttribute("R") ?? 10);
        const p = new PathBuilder();
        for (let k = 0; k < n; k++) {
          const a = Math.PI / 2 + (2 * Math.PI * k) / n;
          const q = apply(m, r * Math.cos(a), r * Math.sin(a));
          if (k) p.lineTo(...q);
          else p.moveTo(...q);
        }
        p.close();
        return push(p, true);
      }
      case "Path":
      case "Line":
        return pathShape(el, m, push, skips);
      case "Text": {
        const backup = Array.from(el.children).find((c) => c.tagName === "BackupPath");
        if (backup) return pathShape(backup, mul(xform(backup), m), push, skips);
        return skips.add("texte (sans tracé enregistré)");
      }
      case "Bitmap":
        return skips.add("image");
      default:
        return skips.add(type ? type.toLowerCase() : "forme inconnue");
    }
  };
  for (const s of Array.from(root.children)) if (s.tagName === "Shape") emit(s, IDENTITY, 0);
  if (!layers.length) issues.push("aucun calque de coupe : réglages à choisir par couleur");
  const used = new Set(shapes.flatMap((s) => [s.fill, s.stroke]).filter(Boolean));
  const ops: LaserOp[] = layers
    .filter((l) => used.has(l.color) && l.mode !== "image")
    .map((l) => ({ color: l.color, mode: l.mode as LaserOp["mode"], power: Math.round(l.power * 10) / 10, speed: Math.round(l.speed), passes: l.passes, interval: l.interval ?? 0.1, kerf: 0 }));
  // Découpe en dernier, comme dans LightBurn quand l'ordre est réglé « intérieur d'abord ».
  ops.sort((a, b) => Number(a.mode === "line") - Number(b.mode === "line"));
  return { shapes, unitMm: 1, ops, layers, skipped: skips.counts, issues };
}

type Vert = { x: number; y: number; c0?: [number, number]; c1?: [number, number] };

/** `VertList` (lbrn2 : `V x y c0x… c0y… c1x… c1y…`) ou éléments `<V>` (lbrn), `PrimList` ou éléments `<P>`. */
function pathShape(el: Element, m: Mat, push: (p: PathBuilder, closed: boolean) => void, skips: Skips): void {
  const verts: Vert[] = [];
  const vl = Array.from(el.children).find((c) => c.tagName === "VertList");
  if (vl) {
    const re = /V\s*([-\d.eE+]+)\s+([-\d.eE+]+)((?:c[01][xy][-\d.eE+]+)*)/g;
    let mt: RegExpExecArray | null;
    while ((mt = re.exec(vl.textContent ?? ""))) {
      const v: Vert = { x: Number(mt[1]), y: Number(mt[2]) };
      const ctl = mt[3];
      const g = (k: string) => {
        const r = new RegExp(k + "([-\\d.eE+]+)").exec(ctl);
        return r ? Number(r[1]) : null;
      };
      const c0x = g("c0x"), c0y = g("c0y"), c1x = g("c1x"), c1y = g("c1y");
      if (c0x !== null && c0y !== null) v.c0 = [c0x, c0y];
      if (c1x !== null && c1y !== null) v.c1 = [c1x, c1y];
      verts.push(v);
    }
  } else {
    for (const c of Array.from(el.children)) if (c.tagName === "V") {
      const a = (k: string) => (c.hasAttribute(k) ? Number(c.getAttribute(k)) : null);
      const v: Vert = { x: a("vx") ?? 0, y: a("vy") ?? 0 };
      if (a("c0x") !== null) v.c0 = [a("c0x")!, a("c0y") ?? 0];
      if (a("c1x") !== null) v.c1 = [a("c1x")!, a("c1y") ?? 0];
      verts.push(v);
    }
  }
  if (verts.length < 2) return skips.add("tracé vide");
  type Prim = { t: "L" | "B"; a: number; b: number };
  const prims: Prim[] = [];
  const pl = Array.from(el.children).find((c) => c.tagName === "PrimList");
  const txt = (pl?.textContent ?? "").trim();
  if (/^Line(Closed|Open)?$/i.test(txt) || (!pl && !Array.from(el.children).some((c) => c.tagName === "P"))) {
    const closed = /Closed/i.test(txt) || (!txt && el.getAttribute("Type") !== "Line");
    for (let k = 0; k < verts.length - 1; k++) prims.push({ t: "L", a: k, b: k + 1 });
    if (closed) prims.push({ t: "L", a: verts.length - 1, b: 0 });
  } else if (pl) {
    const re = /([LB])\s*(\d+)\s+(\d+)/g;
    let mt: RegExpExecArray | null;
    while ((mt = re.exec(txt))) prims.push({ t: mt[1] as "L" | "B", a: Number(mt[2]), b: Number(mt[3]) });
  } else {
    for (const c of Array.from(el.children)) if (c.tagName === "P") prims.push({ t: c.getAttribute("T") === "B" ? "B" : "L", a: Number(c.getAttribute("p0")), b: Number(c.getAttribute("p1")) });
  }
  const p = new PathBuilder();
  let last = -1, first = -1;
  let allClosed = true;
  const P = (x: number, y: number) => apply(m, x, y);
  const flushSub = () => {
    if (first >= 0 && last === first) p.close();
    else if (first >= 0) allClosed = false;
  };
  for (const pr of prims) {
    const a = verts[pr.a], b = verts[pr.b];
    if (!a || !b) continue;
    if (pr.a !== last) {
      flushSub();
      p.moveTo(...P(a.x, a.y));
      first = pr.a;
    }
    if (pr.t === "B") {
      const c0 = a.c0 ?? [a.x, a.y], c1 = b.c1 ?? [b.x, b.y];
      p.curveTo(...P(c0[0], c0[1]), ...P(c1[0], c1[1]), ...P(b.x, b.y));
    } else p.lineTo(...P(b.x, b.y));
    last = pr.b;
  }
  flushSub();
  push(p, allClosed);
}
