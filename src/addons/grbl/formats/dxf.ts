/**
 * DXF (AutoCAD, LibreCAD, QCAD, Inkscape, Fusion, FreeCAD, SolidWorks…) en ASCII → formes.
 *
 * Lu : LINE, LWPOLYLINE et POLYLINE (renflements = arcs), CIRCLE, ARC, ELLIPSE, SPLINE (B-spline, rationnelle
 * comprise, ou points de passage), SOLID / TRACE / 3DFACE (contour), HATCH (contours polylignes, lignes, arcs et
 * ellipses, en surfaces), INSERT (blocs, échelle, rotation, réseaux), calques (couleur, calques éteints ou gelés
 * ignorés), couleurs ACI et vraies couleurs. Unités : `$INSUNITS` (millimètres si absent). Le blanc / noir
 * d'AutoCAD (couleur 7) devient du noir. Textes, cotes, images : ignorés (comptés).
 */
import { addArc, addBulge, apply, IDENTITY, MAX_SHAPES, mul, PathBuilder, rotate, scale, Skips, translate, type Mat, type Shape } from "./geom";

type Pair = [number, string];
type Entity = { type: string; pairs: Pair[] };

/** Unités `$INSUNITS` → millimètres. */
const UNITS: Record<number, number> = { 0: 1, 1: 25.4, 2: 304.8, 3: 1_609_344, 4: 1, 5: 10, 6: 1000, 7: 1_000_000, 8: 2.54e-5, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100 };

/** Palette AutoCAD (ACI) : 1..9 nommées, 10..249 teintes, 250..255 gris. */
export function aciColor(i: number): string {
  const base: Record<number, string> = { 1: "#ff0000", 2: "#ffff00", 3: "#00ff00", 4: "#00ffff", 5: "#0000ff", 6: "#ff00ff", 7: "#000000", 8: "#808080", 9: "#c0c0c0" };
  if (base[i]) return base[i];
  if (i >= 250 && i <= 255) {
    const g = [51, 80, 105, 130, 190, 255][i - 250];
    return i === 255 ? "#000000" : "#" + g.toString(16).padStart(2, "0").repeat(3);
  }
  if (i >= 10 && i <= 249) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const sub = (i - 10) % 10;
    const v = [1, 0.8, 0.6, 0.5, 0.3][sub >> 1];
    const s = sub % 2 ? 0.5 : 1;
    const c = v * s, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), mm = v - c;
    const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    const h = (n: number) => Math.round((n + mm) * 255).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  return "#000000";
}

function readPairs(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) {
      // Décalage (ligne vide en trop) : on se recale d'une ligne.
      i -= 1;
      continue;
    }
    out.push([code, lines[i + 1].trim()]);
  }
  return out;
}

const num = (e: Entity, code: number, dflt = 0): number => {
  for (const [c, v] of e.pairs) if (c === code) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : dflt;
  }
  return dflt;
};
const str = (e: Entity, code: number): string | null => {
  for (const [c, v] of e.pairs) if (c === code) return v;
  return null;
};
const all = (e: Entity, code: number): number[] => e.pairs.filter(([c]) => c === code).map(([, v]) => parseFloat(v));

type Layer = { color: string; hidden: boolean };
type Block = { bx: number; by: number; entities: Entity[] };

export type DxfResult = { shapes: Shape[]; unitMm: number; skipped: Record<string, number>; issues: string[]; layers: { name: string; color: string }[] };

export function readDxf(text: string): DxfResult {
  if (/^AutoCAD Binary DXF/.test(text)) throw new Error("DXF binaire non pris en charge : l'enregistrer en DXF ASCII");
  const pairs = readPairs(text);
  const skips = new Skips();
  const issues: string[] = [];
  const layers = new Map<string, Layer>();
  const blocks = new Map<string, Block>();
  const entities: Entity[] = [];
  let insunits = 4;
  let section = "";
  let i = 0;
  // Découpe en sections, puis en entités (un code 0 ouvre une entité).
  const takeEntity = (): Entity => {
    const type = pairs[i][1];
    const e: Entity = { type, pairs: [] };
    i++;
    while (i < pairs.length && pairs[i][0] !== 0) e.pairs.push(pairs[i++]);
    return e;
  };
  let currentBlock: { name: string; block: Block } | null = null;
  let polyline: { head: Entity; vertices: Entity[] } | null = null;
  const pushEntity = (e: Entity) => {
    if (currentBlock) currentBlock.block.entities.push(e);
    else if (section === "ENTITIES") entities.push(e);
  };
  while (i < pairs.length) {
    const [code, value] = pairs[i];
    if (code !== 0) {
      if (section === "HEADER" && code === 9 && value === "$INSUNITS") {
        const next = pairs[i + 1];
        if (next && next[0] === 70) insunits = parseInt(next[1], 10);
      }
      i++;
      continue;
    }
    if (value === "SECTION") {
      const name = pairs[i + 1];
      section = name && name[0] === 2 ? name[1] : "";
      i += 2;
      continue;
    }
    if (value === "ENDSEC") {
      section = "";
      i++;
      continue;
    }
    if (value === "EOF") break;
    const e = takeEntity();
    if (section === "TABLES" && e.type === "LAYER") {
      const name = str(e, 2) ?? "0";
      const aci = num(e, 62, 7);
      const rgb = str(e, 420);
      const flags = num(e, 70, 0);
      layers.set(name, { color: rgb ? "#" + (parseInt(rgb, 10) & 0xffffff).toString(16).padStart(6, "0") : aciColor(Math.abs(aci)), hidden: aci < 0 || (flags & 1) === 1 || str(e, 290) === "0" });
      continue;
    }
    if (section === "BLOCKS") {
      if (e.type === "BLOCK") {
        currentBlock = { name: str(e, 2) ?? "", block: { bx: num(e, 10), by: num(e, 20), entities: [] } };
        continue;
      }
      if (e.type === "ENDBLK") {
        if (currentBlock) blocks.set(currentBlock.name, currentBlock.block);
        currentBlock = null;
        continue;
      }
    }
    if (section !== "ENTITIES" && section !== "BLOCKS") continue;
    if (e.type === "POLYLINE") {
      polyline = { head: e, vertices: [] };
      continue;
    }
    if (e.type === "VERTEX" && polyline) {
      polyline.vertices.push(e);
      continue;
    }
    if (e.type === "SEQEND" && polyline) {
      // POLYLINE reconstituée : les sommets suivent l'en-tête.
      pushEntity({ type: "POLYLINE", pairs: [...polyline.head.pairs, [-1, "VERTICES"]], vertices: polyline.vertices } as Entity & { vertices: Entity[] });
      polyline = null;
      continue;
    }
    pushEntity(e);
  }
  if (!UNITS[insunits]) issues.push(`unité $INSUNITS ${insunits} inconnue : millimètres supposés`);
  const unitMm = UNITS[insunits] ?? 1;
  if (insunits === 0) issues.push("unités non précisées dans le DXF : millimètres supposés");

  const shapes: Shape[] = [];
  const layerOf = (e: Entity) => layers.get(str(e, 8) ?? "0");
  const colorOf = (e: Entity, byBlock: string): string => {
    const rgb = str(e, 420);
    if (rgb) {
      const c = "#" + (parseInt(rgb, 10) & 0xffffff).toString(16).padStart(6, "0");
      return c === "#ffffff" ? "#000000" : c;
    }
    const aci = num(e, 62, 256);
    if (aci === 0) return byBlock;
    if (aci === 256) return layerOf(e)?.color ?? "#000000";
    return aciColor(Math.abs(aci));
  };

  const emit = (e: Entity, m: Mat, byBlock: string, depth: number): void => {
    if (shapes.length > MAX_SHAPES) return;
    if (num(e, 67, 0) === 1) return skips.add("espace papier");
    if (layerOf(e)?.hidden) return skips.add("calque éteint");
    const color = colorOf(e, byBlock);
    const stroke = (p: PathBuilder) => {
      if (!p.empty) shapes.push({ segs: p.take(), stroke: color });
    };
    const P = (x: number, y: number) => apply(m, x, y);
    // Extrusion opposée (0,0,-1) : dessin vu de dessous, miroir en X.
    const mm = num(e, 230, 1) < 0 ? mul(scale(-1, 1), m) : m;
    switch (e.type) {
      case "LINE": {
        const p = new PathBuilder();
        p.moveTo(...apply(mm, num(e, 10), num(e, 20)));
        p.lineTo(...apply(mm, num(e, 11), num(e, 21)));
        return stroke(p);
      }
      case "LWPOLYLINE": {
        const xs = all(e, 10), ys = all(e, 20);
        // Les renflements (42) suivent leur sommet : on les rattache dans l'ordre.
        const bulges: number[] = new Array(xs.length).fill(0);
        let v = -1;
        for (const [c, val] of e.pairs) {
          if (c === 10) v++;
          else if (c === 42 && v >= 0) bulges[v] = parseFloat(val) || 0;
        }
        return stroke(polyPath(xs, ys, bulges, (num(e, 70) & 1) === 1, mm));
      }
      case "POLYLINE": {
        const flags = num(e, 70);
        if (flags & (16 | 64)) return skips.add("maillage 3D");
        const vs = (e as Entity & { vertices: Entity[] }).vertices ?? [];
        const pts = vs.filter((v) => !(num(v, 70) & 16));
        return stroke(polyPath(pts.map((v) => num(v, 10)), pts.map((v) => num(v, 20)), pts.map((v) => num(v, 42)), (flags & 1) === 1, mm));
      }
      case "CIRCLE": {
        const p = new PathBuilder();
        const r = num(e, 40);
        if (!(r > 0)) return;
        addArc(p, num(e, 10), num(e, 20), r, r, 0, 2 * Math.PI, mm, 0, true);
        p.close();
        return stroke(p);
      }
      case "ARC": {
        const p = new PathBuilder();
        const r = num(e, 40);
        let a1 = (num(e, 50) * Math.PI) / 180, a2 = (num(e, 51) * Math.PI) / 180;
        if (a2 <= a1) a2 += 2 * Math.PI;
        if (!(r > 0)) return;
        addArc(p, num(e, 10), num(e, 20), r, r, a1, a2, mm, 0, true);
        return stroke(p);
      }
      case "ELLIPSE": {
        const mx = num(e, 11), my = num(e, 21);
        const rx = Math.hypot(mx, my), ry = rx * num(e, 40, 1);
        if (!(rx > 0)) return;
        let a1 = num(e, 41, 0), a2 = num(e, 42, 2 * Math.PI);
        if (a2 <= a1) a2 += 2 * Math.PI;
        const p = new PathBuilder();
        addArc(p, num(e, 10), num(e, 20), rx, ry, a1, a2, mm, Math.atan2(my, mx), true);
        if (Math.abs(a2 - a1 - 2 * Math.PI) < 1e-6) p.close();
        return stroke(p);
      }
      case "SPLINE": {
        const pts = splinePoints(e);
        if (pts.length < 2) return skips.add("spline vide");
        const p = new PathBuilder();
        p.moveTo(...apply(mm, pts[0][0], pts[0][1]));
        for (let k = 1; k < pts.length; k++) p.lineTo(...apply(mm, pts[k][0], pts[k][1]));
        if (num(e, 70) & 1) p.close();
        return stroke(p);
      }
      case "SOLID":
      case "TRACE":
      case "3DFACE": {
        const corners: [number, number][] = [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)], [num(e, 12), num(e, 22)], [num(e, 13, NaN), num(e, 23, NaN)]];
        // SOLID / TRACE : 3e et 4e sommets croisés.
        const order = e.type === "3DFACE" ? [0, 1, 2, 3] : [0, 1, 3, 2];
        const p = new PathBuilder();
        let first = true;
        for (const k of order) {
          const c = corners[k];
          if (!Number.isFinite(c[0])) continue;
          if (first) p.moveTo(...P(c[0], c[1]));
          else p.lineTo(...P(c[0], c[1]));
          first = false;
        }
        p.close();
        if (p.empty) return;
        shapes.push(e.type === "3DFACE" ? { segs: p.take(), stroke: color } : { segs: p.take(), fill: color });
        return;
      }
      case "HATCH": {
        const p = hatchPath(e, mm, skips);
        if (!p.empty) shapes.push({ segs: p.take(), fill: color, evenOdd: true });
        return;
      }
      case "INSERT": {
        const block = blocks.get(str(e, 2) ?? "");
        if (!block) return skips.add("bloc introuvable");
        if (depth > 12) return skips.add("blocs trop imbriqués");
        const sx = num(e, 41, 1), sy = num(e, 42, 1);
        const rot = num(e, 50, 0);
        const cols = Math.max(1, Math.min(200, num(e, 70, 1))), rows = Math.max(1, Math.min(200, num(e, 71, 1)));
        const dc = num(e, 44, 0), dr = num(e, 45, 0);
        const blockColor = colorOf(e, byBlock);
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const local = mul(mul(mul(translate(-block.bx, -block.by), scale(sx, sy)), mul(translate(c * dc, r * dr), rotate(rot))), translate(num(e, 10), num(e, 20)));
          const mm2 = mul(local, mm);
          for (const child of block.entities) emit(child, mm2, blockColor, depth + 1);
        }
        return;
      }
      case "TEXT":
      case "MTEXT":
      case "ATTRIB":
      case "ATTDEF":
        return skips.add("texte");
      case "DIMENSION":
      case "LEADER":
      case "MLEADER":
        return skips.add("cote");
      case "IMAGE":
      case "WIPEOUT":
        return skips.add("image");
      case "POINT":
        return skips.add("point");
      case "VIEWPORT":
        return;
      default:
        return skips.add(e.type.toLowerCase());
    }
  };
  for (const e of entities) emit(e, IDENTITY, "#000000", 0);
  if (shapes.length > MAX_SHAPES) issues.push(`dessin tronqué à ${MAX_SHAPES} formes`);
  return { shapes, unitMm, skipped: skips.counts, issues, layers: [...layers].filter(([, l]) => !l.hidden).map(([name, l]) => ({ name, color: l.color })) };
}

function polyPath(xs: number[], ys: number[], bulges: number[], closed: boolean, m: Mat): PathBuilder {
  const p = new PathBuilder();
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return p;
  p.moveTo(...apply(m, xs[0], ys[0]));
  const last = closed ? n : n - 1;
  for (let k = 0; k < last; k++) {
    const j = (k + 1) % n;
    addBulge(p, xs[k], ys[k], xs[j], ys[j], bulges[k] || 0, m);
  }
  if (closed) p.close();
  return p;
}

/** Points d'une B-spline DXF (de Boor), ou ses points de passage si elle n'a pas de points de contrôle. */
export function splinePoints(e: Entity): [number, number][] {
  const deg = Math.max(1, num(e, 71, 3));
  const knots = all(e, 40);
  const weights = all(e, 41);
  const cx = all(e, 10), cy = all(e, 20);
  const ctrl: [number, number][] = cx.map((x, k) => [x, cy[k] ?? 0]);
  if (ctrl.length < 2) {
    const fx = all(e, 11), fy = all(e, 21);
    return fx.map((x, k) => [x, fy[k] ?? 0]);
  }
  let kv = knots;
  if (kv.length !== ctrl.length + deg + 1) {
    // Vecteur nodal absent ou incohérent : uniforme bloqué aux extrémités.
    kv = [];
    for (let k = 0; k <= deg; k++) kv.push(0);
    for (let k = 1; k < ctrl.length - deg; k++) kv.push(k);
    for (let k = 0; k <= deg; k++) kv.push(Math.max(1, ctrl.length - deg));
  }
  const w = weights.length === ctrl.length ? weights : ctrl.map(() => 1);
  const t0 = kv[deg], t1 = kv[kv.length - deg - 1];
  const steps = Math.min(4000, Math.max(16, ctrl.length * 12));
  const out: [number, number][] = [];
  for (let s = 0; s <= steps; s++) {
    const t = s === steps ? t1 - 1e-9 * (t1 - t0) : t0 + ((t1 - t0) * s) / steps;
    let span = deg;
    while (span < ctrl.length - 1 && kv[span + 1] <= t) span++;
    const d: [number, number, number][] = [];
    for (let j = 0; j <= deg; j++) {
      const c = ctrl[span - deg + j], wj = w[span - deg + j] || 1;
      d.push([c[0] * wj, c[1] * wj, wj]);
    }
    for (let r = 1; r <= deg; r++) {
      for (let j = deg; j >= r; j--) {
        const i = span - deg + j;
        const den = kv[i + deg - r + 1] - kv[i];
        const a = den ? (t - kv[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    const [x, y, ww] = d[deg];
    if (ww) out.push([x / ww, y / ww]);
  }
  return out;
}

/** Contours d'un HATCH : polylignes (renflements) et bords lignes / arcs / ellipses ; splines ignorées. */
function hatchPath(e: Entity, m: Mat, skips: Skips): PathBuilder {
  const p = new PathBuilder();
  const ps = e.pairs;
  let k = ps.findIndex(([c]) => c === 91);
  if (k < 0) return p;
  const loops = parseInt(ps[k][1], 10) || 0;
  k++;
  const at = (code: number): number => {
    while (k < ps.length && ps[k][0] !== code) k++;
    return k < ps.length ? parseFloat(ps[k++][1]) : 0;
  };
  for (let l = 0; l < loops && k < ps.length; l++) {
    const type = at(92);
    if (type & 2) {
      const hasBulge = at(72);
      at(73);
      const n = at(93);
      const xs: number[] = [], ys: number[] = [], bs: number[] = [];
      for (let v = 0; v < n; v++) {
        xs.push(at(10));
        ys.push(at(20));
        bs.push(hasBulge ? at(42) : 0);
      }
      const sub = polyPath(xs, ys, bs, true, m);
      p.segs.push(...sub.segs);
    } else {
      const n = at(93);
      const sub = new PathBuilder();
      for (let s = 0; s < n; s++) {
        const et = at(72);
        if (et === 1) {
          const a = apply(m, at(10), at(20)), b = apply(m, at(11), at(21));
          if (!sub.current) sub.moveTo(a[0], a[1]);
          else sub.lineTo(a[0], a[1]);
          sub.lineTo(b[0], b[1]);
        } else if (et === 2 || et === 3) {
          const cx = at(10), cy = at(20);
          let rx: number, ry: number, rot = 0;
          if (et === 2) rx = ry = at(40);
          else {
            const mx = at(11), my = at(21);
            rx = Math.hypot(mx, my);
            ry = rx * at(40);
            rot = Math.atan2(my, mx);
          }
          const a1 = (at(50) * Math.PI) / 180, a2 = (at(51) * Math.PI) / 180;
          const ccw = at(73);
          // Arc horaire : les angles sont enregistrés en miroir.
          const s = ccw ? a1 : -a1;
          let e2 = ccw ? a2 : -a2;
          if (ccw) while (e2 <= s) e2 += 2 * Math.PI;
          else while (e2 >= s) e2 -= 2 * Math.PI;
          addArc(sub, cx, cy, rx, ry, s, e2, m, rot);
        } else {
          skips.add("bord de hachure en spline");
          // On saute ce bord : la suite du contour se raccorde en ligne droite.
        }
      }
      sub.close();
      p.segs.push(...sub.segs);
    }
    // Objets sources liés au contour (97 + 330) : ignorés.
  }
  return p;
}
