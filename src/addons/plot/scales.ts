/**
 * Échelles, graduations et formats des graphiques. Fonctions pures, sans DOM.
 */

export type Linear = ((v: number) => number) & { domain: [number, number]; range: [number, number] };

export function linear(domain: [number, number], range: [number, number]): Linear {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const f = ((v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))) as Linear;
  f.domain = domain;
  f.range = range;
  return f;
}

/** Pas « rond » (1, 2, 5 × 10ⁿ) pour couvrir `span` en ~`count` graduations. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1;
  const raw = span / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const e = raw / pow;
  return (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * pow;
}

/** Domaine élargi à des bornes rondes + graduations. */
export function niceTicks(min: number, max: number, count = 5): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { domain: [0, 1], ticks: [0, 0.5, 1] };
  if (min === max) {
    const d = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= d;
    max += d;
  }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo, i = 0; v <= hi + step * 1e-9 && i < 200; v = lo + ++i * step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks };
}

/** Graduations dans un domaine fixe (sans l'élargir). */
export function ticksIn(min: number, max: number, count = 5): number[] {
  const step = niceStep(max - min, count);
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step, i = 0; v <= max + step * 1e-9 && i < 200; v = Math.ceil(min / step - 1e-9) * step + ++i * step) out.push(+v.toPrecision(12));
  return out;
}

export type Band = {
  (key: string): number;
  keys: string[];
  bandwidth: number;
  step: number;
  /** Centre de la bande. */
  center(key: string): number;
};

export function band(keys: string[], range: [number, number], padding = 0.2): Band {
  const n = keys.length;
  const [r0, r1] = range;
  const step = n ? (r1 - r0) / Math.max(1, n - padding + padding * 2) : 0;
  const bw = step * (1 - padding);
  const start = r0 + step * padding;
  const index = new Map(keys.map((k, i) => [k, i]));
  const f = ((k: string) => start + (index.get(k) ?? 0) * step) as Band;
  f.keys = keys;
  f.bandwidth = bw;
  f.step = step;
  f.center = (k: string) => f(k) + bw / 2;
  return f;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVALS = [SECOND, 5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY];

/** Graduations de dates (ms UTC) alignées sur le calendrier : jours/semaines, mois, trimestres, années. */
export function timeTicks(min: number, max: number, count = 6): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const target = span / Math.max(1, count);
  if (target <= 14 * DAY) {
    const step = INTERVALS.find((s) => s >= target) ?? 14 * DAY;
    const out: number[] = [];
    for (let t = Math.ceil(min / step) * step; t <= max; t += step) out.push(t);
    return out;
  }
  const monthsStep = target <= 45 * DAY ? 1 : target <= 100 * DAY ? 3 : target <= 200 * DAY ? 6 : 12;
  const yearStep = Math.max(1, Math.round(target / (365 * DAY)));
  const out: number[] = [];
  const d0 = new Date(min);
  if (monthsStep < 12) {
    let y = d0.getUTCFullYear();
    let m = Math.floor(d0.getUTCMonth() / monthsStep) * monthsStep;
    for (let i = 0; i < 500; i++) {
      const t = Date.UTC(y, m, 1);
      if (t > max) break;
      if (t >= min) out.push(t);
      m += monthsStep;
      if (m >= 12) {
        m -= 12;
        y++;
      }
    }
  } else {
    for (let y = Math.ceil(d0.getUTCFullYear() / yearStep) * yearStep, i = 0; i < 500; y += yearStep, i++) {
      const t = Date.UTC(y, 0, 1);
      if (t > max) break;
      if (t >= min) out.push(t);
    }
  }
  return out;
}

export type Formatter = (v: unknown) => string;

/**
 * Formats nommés (aucune fonction fournie par le document) :
 * `number`, `integer`, `compact`, `percent` (0..1), `currency:EUR`, `date`, `datetime`, `auto-date`, `none`.
 * `auto-date` adapte le format à l'écart entre graduations (`spanMs`).
 */
export function makeFormatter(spec: string | undefined, locale = "fr", spanMs = 0): Formatter {
  const s = (spec ?? "").trim();
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  try {
    if (s === "none") return str;
    if (s === "integer") {
      const f = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
      return (v) => (Number.isFinite(Number(v)) ? f.format(Number(v)) : str(v));
    }
    if (s === "compact") {
      const f = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
      return (v) => (Number.isFinite(Number(v)) ? f.format(Number(v)) : str(v));
    }
    if (s === "percent") {
      const f = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
      return (v) => (Number.isFinite(Number(v)) ? f.format(Number(v)) : str(v));
    }
    if (/^currency:[A-Za-z]{3}$/.test(s)) {
      const f = new Intl.NumberFormat(locale, { style: "currency", currency: s.slice(9).toUpperCase(), maximumFractionDigits: 2 });
      return (v) => (Number.isFinite(Number(v)) ? f.format(Number(v)) : str(v));
    }
    if (s === "date" || s === "datetime" || s === "auto-date") {
      const opts: Intl.DateTimeFormatOptions =
        s === "datetime" ? { dateStyle: "medium", timeStyle: "short" } : s === "date" ? { dateStyle: "medium" } : spanMs >= 300 * DAY ? { year: "numeric" } : spanMs >= 25 * DAY ? { month: "short", year: "numeric" } : spanMs >= DAY ? { day: "numeric", month: "short" } : spanMs >= MINUTE ? { hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" };
      const f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" });
      return (v) => {
        const t = typeof v === "number" ? v : Date.parse(String(v));
        return Number.isFinite(t) ? f.format(t) : str(v);
      };
    }
    const f = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
    return (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) ? f.format(Number(v)) : str(v));
  } catch {
    return str;
  }
}

/** Date ISO (aaaa-mm[-jj][Thh:mm…]) → ms UTC, sinon NaN. */
export function parseDate(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v !== "string" || !/^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v.trim())) return NaN;
  const s = v.trim();
  return Date.parse(/^\d{4}-\d{2}$/.test(s) ? `${s}-01` : s);
}

/** Chemin d'une série : droites, escalier, ou courbe monotone (pas de dépassement entre points). */
export function linePath(pts: [number, number][], curve: "linear" | "monotone" | "step" = "linear"): string {
  if (!pts.length) return "";
  const f = (n: number) => +n.toFixed(2);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  if (pts.length === 1) return d;
  if (curve === "step") {
    for (let i = 1; i < pts.length; i++) d += `H${f(pts[i][0])}V${f(pts[i][1])}`;
    return d;
  }
  if (curve === "linear" || pts.length === 2) {
    for (let i = 1; i < pts.length; i++) d += `L${f(pts[i][0])},${f(pts[i][1])}`;
    return d;
  }
  const n = pts.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push(dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      t[i] = (3 * a * m[i]) / h;
      t[i + 1] = (3 * b * m[i]) / h;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(pts[i][0] + h)},${f(pts[i][1] + t[i] * h)},${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - t[i + 1] * h)},${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
  }
  return d;
}

/** Secteur d'anneau (angles en radians, 0 = midi, sens horaire). */
export function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const f = (n: number) => +n.toFixed(2);
  const full = a1 - a0 >= Math.PI * 2 - 1e-6;
  if (full) a1 = a0 + Math.PI * 2 - 1e-4;
  const p = (r: number, a: number) => `${f(cx + r * Math.sin(a))},${f(cy - r * Math.cos(a))}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  if (r0 <= 0.01) return `M${cx},${cy}L${p(r1, a0)}A${f(r1)},${f(r1)} 0 ${large} 1 ${p(r1, a1)}Z`;
  return `M${p(r1, a0)}A${f(r1)},${f(r1)} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${f(r0)},${f(r0)} 0 ${large} 0 ${p(r0, a0)}Z`;
}
