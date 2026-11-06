import { arcPath, band, linePath, linear, makeFormatter, niceTicks, parseDate, ticksIn, timeTicks, type Formatter } from "./scales";
import { field, type PlotSpec } from "./spec";

export type Row = Record<string, unknown>;

export type Hit = {
  series: number;
  seriesName: string;
  /** Libellé de l'abscisse / de la catégorie. */
  label: string;
  value: number;
  valueLabel: string;
  /** Part en % (secteurs). */
  share?: number;
  row: Row | null;
  /** Point d'ancrage de l'infobulle (px dans le SVG). */
  x: number;
  y: number;
};

export type Mark =
  | { k: "path"; d: string; fill?: string; stroke?: string; sw?: number; op?: number; dash?: string; cls?: string }
  | { k: "rect"; x: number; y: number; w: number; h: number; fill: string; r?: number; hit?: number }
  | { k: "dot"; cx: number; cy: number; r: number; fill: string; hit?: number }
  | { k: "arc"; d: string; fill: string; hit: number }
  | { k: "text"; x: number; y: number; text: string; anchor?: "start" | "middle" | "end"; cls?: string; rotate?: number };

export type Axis = { ticks: { pos: number; label: string }[]; title?: string };
export type LegendItem = { name: string; color: string };

type Target =
  | { t: "rect"; x: number; y: number; w: number; h: number; hit: number }
  | { t: "dot"; cx: number; cy: number; r: number; hit: number; xOnly: boolean }
  | { t: "arc"; cx: number; cy: number; r0: number; r1: number; a0: number; a1: number; hit: number };

export type ChartModel = {
  width: number;
  height: number;
  inner: { x: number; y: number; w: number; h: number };
  xAxis: Axis | null;
  yAxis: Axis | null;
  /** Positions (px) des lignes de grille. */
  gridX: number[];
  gridY: number[];
  /** Marques sous les axes (barres, aires, secteurs…) puis au-dessus (lignes, points). */
  marks: Mark[];
  overlay: Mark[];
  legend: LegendItem[];
  /** Dégradé (heatmap) : bornes formatées. */
  scale: { min: string; max: string } | null;
  hits: Hit[];
  summary: string;
  empty: boolean;
  /** Élément le plus proche du pointeur (coordonnées du SVG). */
  pick(px: number, py: number): Hit | null;
};

const TOKENS = ["primary", "info", "success", "warning", "danger"];

export function seriesColor(i: number, custom?: string[]): string {
  const c = custom?.[i % (custom.length || 1)];
  if (c) return c.startsWith("#") ? c : c === "neutral" ? "var(--sc-base-500)" : `var(--sc-${c})`;
  const tok = TOKENS[i % TOKENS.length];
  const cycle = Math.floor(i / TOKENS.length);
  if (cycle === 0) return `var(--sc-${tok})`;
  return `color-mix(in oklab, var(--sc-${tok}) ${cycle === 1 ? 62 : 40}%, var(--sc-base-content))`;
}

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
};
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

type Pt = { xv: unknown; y: number; row: Row; size?: number };
type Ser = { name: string; pts: Pt[] };

function toRows(rows: unknown): Row[] {
  return Array.isArray(rows) ? rows.filter((r): r is Row => !!r && typeof r === "object") : [];
}

function extractSeries(spec: PlotSpec, rows: Row[]): Ser[] {
  const ys = spec.y ?? [];
  const yOf = (r: Row, f: string | undefined) => (spec.aggregate === "count" ? 1 : num(field(r, f)));
  const mk = (r: Row, f: string | undefined): Pt => ({ xv: field(r, spec.x), y: yOf(r, f), row: r, size: spec.size ? num(field(r, spec.size)) : undefined });
  let out: Ser[];
  if (ys.length > 1 || (ys.length === 1 && !spec.series)) {
    out = ys.map((f) => ({ name: f, pts: rows.map((r) => mk(r, f)) }));
  } else {
    const yf = ys[0] ?? spec.value;
    if (spec.series) {
      const groups = new Map<string, Pt[]>();
      for (const r of rows) {
        const k = text(field(r, spec.series)) || "—";
        let g = groups.get(k);
        if (!g) groups.set(k, (g = []));
        g.push(mk(r, yf));
      }
      out = [...groups].map(([name, pts]) => ({ name, pts }));
    } else out = [{ name: spec.aggregate === "count" ? "effectif" : (yf ?? "valeur"), pts: rows.map((r) => mk(r, yf)) }];
  }
  return spec.aggregate ? out.map((s) => ({ name: s.name, pts: aggregatePts(s.pts, spec.aggregate!) })) : out;
}

function aggregatePts(pts: Pt[], how: NonNullable<PlotSpec["aggregate"]>): Pt[] {
  const groups = new Map<string, Pt[]>();
  for (const p of pts) {
    const k = text(p.xv);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(p);
  }
  return [...groups.values()].map((g) => {
    const v = g.map((p) => p.y).filter(Number.isFinite);
    const y = !v.length ? NaN : how === "count" ? v.length : how === "mean" ? v.reduce((a, b) => a + b, 0) / v.length : how === "min" ? Math.min(...v) : how === "max" ? Math.max(...v) : v.reduce((a, b) => a + b, 0);
    return { ...g[0], y };
  });
}

type XKind = "linear" | "time" | "band";

function detectX(spec: PlotSpec, sers: Ser[]): XKind {
  if (spec.xType) return spec.xType;
  if (spec.type === "bar" || spec.type === "barh") return "band";
  const xs = sers.flatMap((s) => s.pts.map((p) => p.xv)).filter((v) => v !== null && v !== undefined && v !== "");
  if (!xs.length) return "band";
  if (xs.every((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))))) return "linear";
  if (xs.every((v) => Number.isFinite(parseDate(v)))) return "time";
  return "band";
}

const xNum = (kind: XKind, v: unknown): number => (kind === "time" ? (typeof v === "number" ? v : parseDate(v)) : num(v));

export function buildChart(specIn: PlotSpec, rowsIn: unknown, width: number, heightIn: number): ChartModel {
  const spec = specIn;
  const rows = toRows(rowsIn);
  const locale = spec.locale ?? "fr";
  const W = Math.max(40, Math.round(width));
  const H = Math.max(24, Math.round(heightIn));
  const model: ChartModel = {
    width: W, height: H, inner: { x: 0, y: 0, w: W, h: H }, xAxis: null, yAxis: null, gridX: [], gridY: [], marks: [], overlay: [], legend: [], scale: null, hits: [], summary: "", empty: false, pick: () => null,
  };
  const targets: Target[] = [];
  const fmtVal = makeFormatter(spec.format?.value ?? spec.format?.y, locale);
  const addHit = (h: Hit) => model.hits.push(h) - 1;
  const finish = (): ChartModel => {
    model.pick = (px, py) => pickHit(model, targets, px, py);
    return model;
  };

  if (!rows.length) {
    model.empty = true;
    model.summary = "Graphique sans données";
    return finish();
  }

  if (spec.type === "pie" || spec.type === "donut") {
    buildPie(spec, rows, model, addHit, targets, fmtVal, locale);
    return finish();
  }
  if (spec.type === "heatmap") {
    buildHeat(spec, rows, model, addHit, targets, fmtVal, locale);
    return finish();
  }
  if (spec.type === "histogram") {
    buildHistogram(spec, rows, model, addHit, targets, locale);
    return finish();
  }

  const sers = extractSeries(spec, rows);
  const kind = detectX(spec, sers);
  const horizontal = spec.type === "barh";
  const isBar = spec.type === "bar" || horizontal;
  const spark = spec.type === "sparkline";
  const colors = sers.map((_, i) => seriesColor(i, spec.colors));
  if (sers.length > 1 && spec.legend !== false && !spark) model.legend = sers.map((s, i) => ({ name: s.name, color: colors[i] }));
  const total = sers.reduce((n, s) => n + s.pts.length, 0);
  model.summary = `${spec.title ? spec.title + " : " : ""}${spec.type}, ${sers.length} série${sers.length > 1 ? "s" : ""}, ${total} points`;

  /* ---- clés de l'axe des catégories / abscisses ---- */
  const keys: string[] = [];
  const seen = new Set<string>();
  if (kind === "band") for (const s of sers) for (const p of s.pts) { const k = text(p.xv); if (!seen.has(k)) { seen.add(k); keys.push(k); } }

  /* ---- domaine des valeurs ---- */
  const stacked = !!spec.stack && (isBar || spec.type === "area") && sers.length > 1;
  const cat = (p: Pt) => (kind === "band" ? text(p.xv) : String(xNum(kind, p.xv)));
  let vmin = Infinity;
  let vmax = -Infinity;
  const cum = new Map<string, { pos: number; neg: number }>();
  const base = new Map<string, number[]>(); // pile : base de chaque point (par série)
  if (stacked) {
    sers.forEach((s, si) => {
      const arr: number[] = [];
      for (const p of s.pts) {
        const k = cat(p);
        const c = cum.get(k) ?? { pos: 0, neg: 0 };
        const y = Number.isFinite(p.y) ? p.y : 0;
        arr.push(y >= 0 ? c.pos : c.neg);
        if (y >= 0) c.pos += y;
        else c.neg += y;
        cum.set(k, c);
        vmax = Math.max(vmax, c.pos);
        vmin = Math.min(vmin, c.neg);
      }
      base.set(String(si), arr);
    });
  } else {
    for (const s of sers) for (const p of s.pts) if (Number.isFinite(p.y)) { vmin = Math.min(vmin, p.y); vmax = Math.max(vmax, p.y); }
  }
  if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
  const zeroBased = isBar || spec.type === "area";
  if (zeroBased) { vmin = Math.min(vmin, 0); vmax = Math.max(vmax, 0); }
  if (spec.yMin !== undefined) vmin = spec.yMin;
  if (spec.yMax !== undefined) vmax = spec.yMax;
  const vt = niceTicks(vmin, vmax, Math.max(2, Math.round((horizontal ? W : H) / 55)));
  const vdom: [number, number] = [spec.yMin ?? vt.domain[0], spec.yMax ?? vt.domain[1]];
  const vticks = vt.ticks.filter((t) => t >= vdom[0] - 1e-9 && t <= vdom[1] + 1e-9);
  const fy = makeFormatter(spec.format?.y, locale);

  /* ---- marges ---- */
  const labelPx = (labels: string[]) => Math.max(0, ...labels.map((l) => l.length)) * 6.3 + 10;
  let mL = 8, mR = 8, mT = 8, mB = 8;
  if (!spark) {
    if (horizontal) {
      mL = Math.min(W * 0.4, labelPx(keys)) + (spec.yLabel ? 0 : 0);
      mB = 24 + (spec.yLabel ? 16 : 0);
    } else {
      mL = labelPx(vticks.map((t) => fy(t))) + (spec.yLabel ? 16 : 0);
      mB = 24 + (spec.xLabel ? 16 : 0);
    }
    if (horizontal && spec.xLabel) mL += 16;
    mR = 12;
  } else { mL = mR = 3; mT = mB = 4; }
  const ix = mL, iy = mT, iw = Math.max(10, W - mL - mR), ih = Math.max(10, H - mT - mB);
  model.inner = { x: ix, y: iy, w: iw, h: ih };

  /* ---- échelles ---- */
  const vRange: [number, number] = horizontal ? [ix, ix + iw] : [iy + ih, iy];
  const vs = linear(vdom, vRange);
  const cRange: [number, number] = horizontal ? [iy, iy + ih] : [ix, ix + iw];
  let xFmt: Formatter = makeFormatter(spec.format?.x, locale);
  let cScale: ((p: Pt) => number) | null = null;
  let bandS: ReturnType<typeof band> | null = null;
  let catTicks: { pos: number; label: string }[] = [];
  if (kind === "band") {
    bandS = band(keys, cRange, isBar ? 0.25 : 0);
    const b = bandS;
    cScale = (p) => (isBar ? b.center(text(p.xv)) : keys.length <= 1 ? (cRange[0] + cRange[1]) / 2 : cRange[0] + (keys.indexOf(text(p.xv)) / (keys.length - 1)) * (cRange[1] - cRange[0]));
    const posOf = (k: string) => (isBar ? b.center(k) : keys.length <= 1 ? (cRange[0] + cRange[1]) / 2 : cRange[0] + (keys.indexOf(k) / (keys.length - 1)) * (cRange[1] - cRange[0]));
    const maxChars = horizontal ? 99 : Math.max(0, ...keys.map((k) => k.length));
    const fit = horizontal ? Math.max(1, Math.floor(ih / 16)) : Math.max(1, Math.floor(iw / (maxChars * 6.3 + 12)));
    const step = Math.ceil(keys.length / fit);
    catTicks = keys.map((k, i) => ({ k, i })).filter(({ i }) => i % step === 0).map(({ k }) => ({ pos: posOf(k), label: xFmt(k) }));
  } else {
    const xs = sers.flatMap((s) => s.pts.map((p) => xNum(kind, p.xv))).filter(Number.isFinite);
    let lo = Math.min(...xs), hi = Math.max(...xs);
    if (!xs.length) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    let ticks: number[];
    let dom: [number, number];
    if (kind === "time") {
      dom = [lo, hi];
      ticks = timeTicks(lo, hi, Math.max(2, Math.round(iw / 90)));
      xFmt = makeFormatter(spec.format?.x ?? "auto-date", locale, ticks.length > 1 ? ticks[1] - ticks[0] : hi - lo);
    } else {
      const nt = niceTicks(lo, hi, Math.max(2, Math.round(iw / 70)));
      dom = spec.type === "scatter" ? nt.domain : [lo, hi];
      ticks = ticksIn(dom[0], dom[1], Math.max(2, Math.round(iw / 70)));
    }
    const xs2 = linear(dom, cRange);
    cScale = (p) => xs2(xNum(kind, p.xv));
    catTicks = ticks.map((t) => ({ pos: xs2(t), label: xFmt(t) }));
    model.gridX = catTicks.map((t) => t.pos);
  }

  /* ---- axes et grilles ---- */
  const vAxis: Axis = { ticks: vticks.map((t) => ({ pos: vs(t), label: fy(t) })), title: horizontal ? spec.xLabel : spec.yLabel };
  const cAxis: Axis = { ticks: catTicks, title: horizontal ? spec.yLabel : spec.xLabel };
  if (!spark) {
    if (horizontal) { model.xAxis = vAxis; model.yAxis = cAxis; model.gridX = spec.grid === false ? [] : vAxis.ticks.map((t) => t.pos); model.gridY = []; }
    else { model.xAxis = cAxis; model.yAxis = vAxis; model.gridY = spec.grid === false ? [] : vAxis.ticks.map((t) => t.pos); if (spec.grid !== true) model.gridX = []; }
  }
  const coord = (c: number, v: number): [number, number] => (horizontal ? [v, c] : [c, v]);
  const zeroV = vs(Math.min(Math.max(0, vdom[0]), vdom[1]));

  /* ---- marques ---- */
  const sorted = (s: Ser) => (kind === "band" ? s.pts : [...s.pts].sort((a, b) => xNum(kind, a.xv) - xNum(kind, b.xv)));
  if (isBar) {
    const S = sers.length;
    const bw = bandS!.bandwidth;
    sers.forEach((s, si) => {
      s.pts.forEach((p, pi) => {
        if (!Number.isFinite(p.y)) return;
        const k = text(p.xv);
        const c0 = bandS!(k);
        const b0 = stacked ? (base.get(String(si))![pi] ?? 0) : 0;
        const a = vs(stacked ? b0 : 0), b = vs(stacked ? b0 + p.y : p.y);
        const sub = stacked ? bw : bw / S;
        const cc = stacked ? c0 : c0 + si * sub;
        const w = Math.max(1, sub - (stacked || S === 1 ? 0 : 2));
        const lo = Math.min(a, b), len = Math.max(1, Math.abs(a - b));
        const rect = horizontal ? { x: lo, y: cc, w: len, h: w } : { x: cc, y: lo, w, h: len };
        const hit = addHit({ series: si, seriesName: s.name, label: xFmt(k), value: p.y, valueLabel: fy(p.y), row: p.row, x: horizontal ? lo + len : cc + w / 2, y: horizontal ? cc + w / 2 : lo });
        model.marks.push({ k: "rect", ...rect, fill: colors[si], r: 2, hit });
        targets.push({ t: "rect", ...rect, hit });
      });
    });
    void zeroV;
  } else if (spec.type === "scatter") {
    const sizes = sers.flatMap((s) => s.pts.map((p) => p.size)).filter((v): v is number => Number.isFinite(v as number));
    const smin = Math.min(...sizes), smax = Math.max(...sizes);
    sers.forEach((s, si) => {
      for (const p of s.pts) {
        if (!Number.isFinite(p.y)) continue;
        const cx = cScale!(p);
        if (!Number.isFinite(cx)) continue;
        const cy = vs(p.y);
        const r = spec.size && Number.isFinite(p.size) && smax > smin ? 3 + Math.sqrt((p.size! - smin) / (smax - smin)) * 9 : 4;
        const hit = addHit({ series: si, seriesName: s.name, label: xFmt(kind === "band" ? text(p.xv) : xNum(kind, p.xv)), value: p.y, valueLabel: fy(p.y), row: p.row, x: cx, y: cy });
        model.overlay.push({ k: "dot", cx, cy, r, fill: colors[si], hit });
        targets.push({ t: "dot", cx, cy, r, hit, xOnly: false });
      }
    });
  } else {
    const areaBase = vs(Math.min(Math.max(0, vdom[0]), vdom[1]));
    const unionBase = new Map<number, number>();
    sers.forEach((s, si) => {
      const pts = sorted(s);
      const segs: [number, number, Pt, number][][] = [[]];
      pts.forEach((p, pi) => {
        if (!Number.isFinite(p.y)) { if (segs[segs.length - 1].length) segs.push([]); return; }
        const c = cScale!(p);
        const b = stacked ? (base.get(String(si))![s.pts.indexOf(p)] ?? 0) : 0;
        const yv = stacked ? b + p.y : p.y;
        segs[segs.length - 1].push([c, vs(yv), p, vs(b)]);
        void pi;
      });
      for (const seg of segs) {
        if (!seg.length) continue;
        const pts2 = seg.map((q): [number, number] => coord(q[0], q[1]));
        const line = linePath(pts2, spec.curve);
        if (spec.type === "area") {
          const bottom = stacked ? [...seg].reverse().map((q): [number, number] => coord(q[0], q[3])) : [coord(seg[seg.length - 1][0], areaBase), coord(seg[0][0], areaBase)];
          model.marks.push({ k: "path", d: `${line}L${bottom.map((q) => q.join(",")).join("L")}Z`, fill: colors[si], op: 0.28 });
        }
        model.overlay.push({ k: "path", d: line, stroke: colors[si], sw: spark ? 1.5 : 2 });
        if (spec.points === true || (spark && seg.length) ) {
          const showAll = spec.points === true;
          for (const q of showAll ? seg : [seg[seg.length - 1]]) model.overlay.push({ k: "dot", cx: coord(q[0], q[1])[0], cy: coord(q[0], q[1])[1], r: 3, fill: colors[si] });
        }
        for (const q of seg) {
          const p = q[2];
          const label = xFmt(kind === "band" ? text(p.xv) : xNum(kind, p.xv));
          const hit = addHit({ series: si, seriesName: s.name, label, value: p.y, valueLabel: fy(p.y), row: p.row, x: q[0], y: q[1] });
          targets.push({ t: "dot", cx: q[0], cy: q[1], r: 3, hit, xOnly: true });
        }
      }
    });
    void unionBase;
  }

  /* ---- lignes de référence ---- */
  for (const r of spec.rules ?? []) {
    if (r.value < vdom[0] || r.value > vdom[1]) continue;
    const p = vs(r.value);
    const d = horizontal ? `M${p},${iy}V${iy + ih}` : `M${ix},${p}H${ix + iw}`;
    model.overlay.push({ k: "path", d, stroke: "var(--sc-base-content)", sw: 1, dash: "4 3", op: 0.55 });
    if (r.label) model.overlay.push(horizontal ? { k: "text", x: p + 3, y: iy + 10, text: r.label, anchor: "start", cls: "rule" } : { k: "text", x: ix + iw - 2, y: p - 4, text: r.label, anchor: "end", cls: "rule" });
  }
  return finish();
}

/* ------------------------------------------------------------------ */

function buildPie(spec: PlotSpec, rows: Row[], model: ChartModel, addHit: (h: Hit) => number, targets: Target[], fmt: Formatter, locale: string): void {
  const vf = spec.value ?? spec.y?.[0];
  const groups = new Map<string, { v: number; row: Row }>();
  for (const r of rows) {
    const v = num(field(r, vf));
    if (!Number.isFinite(v) || v <= 0) continue;
    const k = text(field(r, spec.x)) || "—";
    const g = groups.get(k);
    if (g) g.v += v;
    else groups.set(k, { v, row: r });
  }
  const total = [...groups.values()].reduce((n, g) => n + g.v, 0);
  model.summary = `${spec.title ? spec.title + " : " : ""}${spec.type}, ${groups.size} secteurs`;
  if (!(total > 0)) { model.empty = true; return; }
  const { width: W, height: H } = model;
  const cx = W / 2, cy = H / 2, R = Math.max(10, Math.min(W, H) / 2 - 4);
  const r0 = spec.type === "donut" ? R * 0.6 : 0;
  const pct = makeFormatter("percent", locale);
  let a = 0;
  [...groups].forEach(([name, g], i) => {
    const sweep = (g.v / total) * Math.PI * 2;
    const color = seriesColor(i, spec.colors);
    model.legend.push({ name, color });
    const mid = a + sweep / 2;
    const hit = addHit({ series: i, seriesName: name, label: name, value: g.v, valueLabel: fmt(g.v), share: g.v / total, row: g.row, x: cx + ((R + r0) / 2) * Math.sin(mid), y: cy - ((R + r0) / 2) * Math.cos(mid) });
    model.marks.push({ k: "arc", d: arcPath(cx, cy, r0, R, a, a + sweep), fill: color, hit });
    targets.push({ t: "arc", cx, cy, r0, r1: R, a0: a, a1: a + sweep, hit });
    if (sweep > 0.35 && R > 60) model.overlay.push({ k: "text", x: cx + ((R + r0) / 2) * Math.sin(mid), y: cy - ((R + r0) / 2) * Math.cos(mid) + 4, text: pct(g.v / total), anchor: "middle", cls: "slice" });
    a += sweep;
  });
  if (spec.type === "donut") model.overlay.push({ k: "text", x: cx, y: cy + 5, text: fmt(total), anchor: "middle", cls: "total" });
}

function buildHeat(spec: PlotSpec, rows: Row[], model: ChartModel, addHit: (h: Hit) => number, targets: Target[], fmt: Formatter, locale: string): void {
  const yf = spec.y?.[0];
  const vf = spec.value;
  const xk: string[] = [], yk: string[] = [];
  const cells: { x: string; y: string; v: number; row: Row }[] = [];
  for (const r of rows) {
    const x = text(field(r, spec.x)), y = text(field(r, yf)), v = num(field(r, vf));
    if (!Number.isFinite(v)) continue;
    if (!xk.includes(x)) xk.push(x);
    if (!yk.includes(y)) yk.push(y);
    cells.push({ x, y, v, row: r });
  }
  model.summary = `${spec.title ? spec.title + " : " : ""}carte de chaleur, ${xk.length} × ${yk.length}`;
  if (!cells.length) { model.empty = true; return; }
  const fx = makeFormatter(spec.format?.x, locale);
  const lw = Math.min(model.width * 0.3, Math.max(0, ...yk.map((k) => k.length)) * 6.3 + 10);
  const ix = lw, iy = 6, iw = Math.max(10, model.width - lw - 8), ih = Math.max(10, model.height - 6 - 24);
  model.inner = { x: ix, y: iy, w: iw, h: ih };
  const bx = band(xk, [ix, ix + iw], 0.06), by = band(yk, [iy, iy + ih], 0.06);
  const vs = cells.map((c) => c.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  model.scale = { min: fmt(lo), max: fmt(hi) };
  for (const c of cells) {
    const t = hi === lo ? 1 : (c.v - lo) / (hi - lo);
    const rect = { x: bx(c.x), y: by(c.y), w: bx.bandwidth, h: by.bandwidth };
    const hit = addHit({ series: 0, seriesName: `${c.y}`, label: fx(c.x), value: c.v, valueLabel: fmt(c.v), row: c.row, x: rect.x + rect.w / 2, y: rect.y });
    model.marks.push({ k: "rect", ...rect, fill: `color-mix(in oklab, var(--sc-primary) ${Math.round(8 + t * 92)}%, var(--sc-base-100))`, r: 2, hit });
    targets.push({ t: "rect", ...rect, hit });
  }
  const fitX = Math.max(1, Math.floor(iw / (Math.max(0, ...xk.map((k) => k.length)) * 6.3 + 12)));
  const stepX = Math.ceil(xk.length / fitX), stepY = Math.ceil(yk.length / Math.max(1, Math.floor(ih / 16)));
  model.xAxis = { ticks: xk.filter((_, i) => i % stepX === 0).map((k) => ({ pos: bx.center(k), label: fx(k) })), title: spec.xLabel };
  model.yAxis = { ticks: yk.filter((_, i) => i % stepY === 0).map((k) => ({ pos: by.center(k), label: k })), title: spec.yLabel };
}

function buildHistogram(spec: PlotSpec, rows: Row[], model: ChartModel, addHit: (h: Hit) => number, targets: Target[], locale: string): void {
  const vals = rows.map((r) => num(field(r, spec.x))).filter(Number.isFinite);
  model.summary = `${spec.title ? spec.title + " : " : ""}histogramme, ${vals.length} valeurs`;
  if (!vals.length) { model.empty = true; return; }
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const n = spec.bins ?? Math.min(40, Math.max(3, Math.ceil(Math.log2(vals.length) + 1)));
  const nt = niceTicks(lo, hi === lo ? lo + 1 : hi, n);
  const [d0, d1] = nt.domain;
  const step = (d1 - d0) / n;
  const counts = new Array<number>(n).fill(0);
  for (const v of vals) counts[Math.min(n - 1, Math.max(0, Math.floor((v - d0) / step)))]++;
  const ct = niceTicks(0, Math.max(...counts), 4);
  const fx = makeFormatter(spec.format?.x, locale), fy = makeFormatter(spec.format?.y ?? "integer", locale);
  const labelPx = Math.max(...ct.ticks.map((t) => fy(t).length)) * 6.3 + 10 + (spec.yLabel ? 16 : 0);
  const ix = labelPx, iy = 8, iw = Math.max(10, model.width - ix - 12), ih = Math.max(10, model.height - 8 - 24 - (spec.xLabel ? 16 : 0));
  model.inner = { x: ix, y: iy, w: iw, h: ih };
  const xs = linear([d0, d1], [ix, ix + iw]), ys = linear(ct.domain, [iy + ih, iy]);
  const color = seriesColor(0, spec.colors);
  counts.forEach((c, i) => {
    const x0 = xs(d0 + i * step), x1 = xs(d0 + (i + 1) * step);
    const rect = { x: x0 + 0.5, y: ys(c), w: Math.max(1, x1 - x0 - 1), h: Math.max(0, iy + ih - ys(c)) };
    const hit = addHit({ series: 0, seriesName: spec.x ?? "valeur", label: `${fx(d0 + i * step)} – ${fx(d0 + (i + 1) * step)}`, value: c, valueLabel: fy(c), row: null, x: rect.x + rect.w / 2, y: rect.y });
    model.marks.push({ k: "rect", ...rect, fill: color, r: 1, hit });
    targets.push({ t: "rect", ...rect, hit });
  });
  model.xAxis = { ticks: nt.ticks.map((t) => ({ pos: xs(t), label: fx(t) })), title: spec.xLabel };
  model.yAxis = { ticks: ct.ticks.map((t) => ({ pos: ys(t), label: fy(t) })), title: spec.yLabel ?? "effectif" };
  model.gridY = spec.grid === false ? [] : model.yAxis.ticks.map((t) => t.pos);
}

function pickHit(model: ChartModel, targets: Target[], px: number, py: number): Hit | null {
  for (const t of targets) if (t.t === "rect" && px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h) return model.hits[t.hit];
  for (const t of targets) {
    if (t.t !== "arc") continue;
    const dx = px - t.cx, dy = py - t.cy, r = Math.hypot(dx, dy);
    if (r < t.r0 || r > t.r1) continue;
    let ang = Math.atan2(dx, -dy);
    if (ang < 0) ang += Math.PI * 2;
    if (ang >= t.a0 && ang <= t.a1) return model.hits[t.hit];
  }
  let best: Hit | null = null, bd = Infinity;
  const xOnly = targets.filter((t): t is Extract<Target, { t: "dot" }> => t.t === "dot" && t.xOnly);
  if (xOnly.length) {
    let dxMin = Infinity;
    for (const t of xOnly) dxMin = Math.min(dxMin, Math.abs(t.cx - px));
    if (dxMin <= 40) for (const t of xOnly) if (Math.abs(t.cx - px) <= dxMin + 0.5) { const d = Math.abs(t.cy - py); if (d < bd) { bd = d; best = model.hits[t.hit]; } }
    if (best) return best;
  }
  for (const t of targets) if (t.t === "dot" && !t.xOnly) { const d = Math.hypot(t.cx - px, t.cy - py); if (d <= t.r + 14 && d < bd) { bd = d; best = model.hits[t.hit]; } }
  return best;
}
