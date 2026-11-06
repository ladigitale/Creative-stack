/**
 * Descripteur déclaratif d'un graphique : validé et normalisé (aucune fonction, aucun HTML).
 */

export const PLOT_TYPES = ["line", "area", "bar", "barh", "scatter", "pie", "donut", "histogram", "heatmap", "sparkline"] as const;
export type PlotType = (typeof PLOT_TYPES)[number];

export type PlotRule = { value: number; label?: string };

export type PlotSpec = {
  type: PlotType;
  /** Champ de l'axe des abscisses / des catégories (chemin pointé accepté). */
  x?: string;
  /** Champ(s) de valeur : plusieurs champs = plusieurs séries (format large). */
  y?: string[];
  /** Champ qui sépare les lignes en séries (format long). */
  series?: string;
  /** Champ de valeur des secteurs (pie/donut) ou des cellules (heatmap). */
  value?: string;
  /** Champ de taille des points (scatter). */
  size?: string;
  stack?: boolean;
  /** Regroupe les lignes de même abscisse (et même série) : somme, moyenne, compte, min, max. */
  aggregate?: "sum" | "mean" | "count" | "min" | "max";
  curve?: "linear" | "monotone" | "step";
  bins?: number;
  xType?: "linear" | "time" | "band";
  yMin?: number;
  yMax?: number;
  points?: boolean;
  grid?: boolean;
  legend?: boolean;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  /** Formats nommés : number, integer, compact, percent, currency:EUR, date, datetime, auto-date, none. */
  format?: { x?: string; y?: string; value?: string };
  rules?: PlotRule[];
  /** Couleurs des séries : `primary|info|success|warning|danger|neutral` ou `#rgb` / `#rrggbb`. */
  colors?: string[];
  height?: number;
  locale?: string;
};

const FORMAT_RE = /^(none|number|integer|compact|percent|date|datetime|auto-date|currency:[A-Za-z]{3})$/;
const COLOR_RE = /^(primary|info|success|warning|danger|neutral|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const str = (v: unknown, max = 120): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  // eslint-disable-next-line no-control-regex
  return s && s.length <= max && !/[\u0000-\u001f]/.test(s) ? s : undefined;
};
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Normalise un descripteur arbitraire ; `errors` liste ce qui a été refusé (le reste est conservé). */
export function normalizeSpec(input: unknown): { spec: PlotSpec; errors: string[] } {
  const errors: string[] = [];
  const o = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (input !== undefined && input !== null && o !== input) errors.push("le descripteur doit être un objet");
  let type: PlotType = "line";
  if (o.type !== undefined) {
    if ((PLOT_TYPES as readonly string[]).includes(o.type as string)) type = o.type as PlotType;
    else errors.push(`type inconnu : ${String(o.type).slice(0, 40)} (${PLOT_TYPES.join(", ")})`);
  }
  const spec: PlotSpec = { type };
  const x = str(o.x);
  if (x) spec.x = x;
  const ys = (Array.isArray(o.y) ? o.y : o.y !== undefined ? [o.y] : []).map((v) => str(v)).filter((v): v is string => !!v).slice(0, 12);
  if (ys.length) spec.y = ys;
  for (const k of ["series", "value", "size", "title", "xLabel", "yLabel"] as const) {
    const s = str(o[k], k === "title" ? 200 : 120);
    if (s) spec[k] = s;
  }
  for (const k of ["stack", "points", "grid", "legend"] as const) if (typeof o[k] === "boolean") spec[k] = o[k] as boolean;
  if (o.curve !== undefined) {
    if (o.curve === "linear" || o.curve === "monotone" || o.curve === "step") spec.curve = o.curve;
    else errors.push("curve : linear, monotone ou step");
  }
  if (o.aggregate !== undefined) {
    if (o.aggregate === "sum" || o.aggregate === "mean" || o.aggregate === "count" || o.aggregate === "min" || o.aggregate === "max") spec.aggregate = o.aggregate;
    else errors.push("aggregate : sum, mean, count, min ou max");
  }
  if (o.xType !== undefined) {
    if (o.xType === "linear" || o.xType === "time" || o.xType === "band") spec.xType = o.xType;
    else errors.push("xType : linear, time ou band");
  }
  const bins = num(o.bins);
  if (bins !== undefined) spec.bins = Math.min(60, Math.max(2, Math.round(bins)));
  for (const k of ["yMin", "yMax"] as const) {
    const n = num(o[k]);
    if (n !== undefined) spec[k] = n;
  }
  const h = num(o.height);
  if (h !== undefined) spec.height = Math.min(1200, Math.max(24, h));
  if (typeof o.locale === "string" && LOCALE_RE.test(o.locale)) spec.locale = o.locale;
  if (o.format && typeof o.format === "object") {
    const f: NonNullable<PlotSpec["format"]> = {};
    for (const k of ["x", "y", "value"] as const) {
      const v = (o.format as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (typeof v === "string" && FORMAT_RE.test(v)) f[k] = v;
      else errors.push(`format.${k} refusé (formats nommés uniquement, pas de fonction)`);
    }
    spec.format = f;
  }
  if (Array.isArray(o.rules)) {
    const rules: PlotRule[] = [];
    for (const r of o.rules.slice(0, 8)) {
      const value = r && typeof r === "object" ? num((r as Record<string, unknown>).value) : undefined;
      if (value === undefined) continue;
      const label = str((r as Record<string, unknown>).label, 60);
      rules.push(label ? { value, label } : { value });
    }
    spec.rules = rules;
  }
  if (Array.isArray(o.colors)) {
    spec.colors = o.colors.filter((c): c is string => typeof c === "string" && COLOR_RE.test(c)).slice(0, 24);
    if (spec.colors.length !== o.colors.length) errors.push("colors : jetons (primary, info…) ou #hex uniquement");
  }
  return { spec, errors };
}

/** Valeur d'un champ, chemin pointé accepté (`a.b`). */
export function field(row: unknown, path: string | undefined): unknown {
  if (!path || row === null || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  if (path in r) return r[path];
  let cur: unknown = row;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
