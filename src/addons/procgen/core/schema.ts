/**
 * Paramètres typés des générateurs et problèmes signalés à l'agent.
 *
 * Chaque générateur déclare un schéma ; `resolveParams` évalue les expressions, applique les défauts, ramène dans les
 * bornes et signale tout écart par une `Issue` structurée (chemin, code, valeur reçue, valeur utilisée, suggestion).
 */
import { resolveDeep, type Scope } from "./expr";

export type ParamSpec =
  | { type: "number"; default: number; min?: number; max?: number; unit?: string; doc: string }
  | { type: "int"; default: number; min?: number; max?: number; doc: string }
  | { type: "bool"; default: boolean; doc: string }
  | { type: "enum"; default: string; options: readonly string[]; doc: string }
  | { type: "color"; default: string; doc: string }
  | { type: "string"; default: string; doc: string }
  | { type: "points"; default: [number, number][]; doc: string }
  | { type: "object"; default: Record<string, unknown>; doc: string }
  /** Liste libre (pièces d'un assemblage, affordances) : validée par le générateur lui-même. */
  | { type: "list"; default: unknown[]; max?: number; doc: string };

export type Schema = Record<string, ParamSpec>;

export type Issue = {
  path: string;
  code: "unknown" | "clamped" | "type" | "expr" | "missing" | "limit" | "info";
  message: string;
  got?: unknown;
  used?: unknown;
  hint?: string;
  didYouMean?: string;
};

export class Issues {
  readonly list: Issue[] = [];
  private seen = new Set<string>();
  add(i: Issue) {
    const k = `${i.path}|${i.code}|${i.message}`;
    if (this.seen.has(k) || this.list.length >= 200) return;
    this.seen.add(k);
    this.list.push(i);
  }
}

/** Distance de Levenshtein (suggestions « vouliez-vous dire »). */
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function suggest(name: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bd = Infinity;
  for (const k of known) {
    const v = lev(name.toLowerCase(), k.toLowerCase());
    if (v < bd) {
      bd = v;
      best = k;
    }
  }
  return best !== undefined && bd <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

export type Resolved<S extends Schema> = {
  [K in keyof S]: S[K] extends { type: "number" | "int" } ? number : S[K] extends { type: "bool" } ? boolean : S[K] extends { type: "points" } ? [number, number][] : S[K] extends { type: "object" } ? Record<string, unknown> : S[K] extends { type: "list" } ? unknown[] : string;
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function resolveParams<S extends Schema>(schema: S, input: Record<string, unknown> | undefined, scope: Scope, issues: Issues, path = "params"): Resolved<S> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const known = Object.keys(schema);
  for (const k of Object.keys(raw)) {
    if (!(k in schema)) issues.add({ path: `${path}.${k}`, code: "unknown", message: `paramètre inconnu « ${k} »`, didYouMean: suggest(k, known), hint: `connus : ${known.join(", ")}` });
  }
  const out: Record<string, unknown> = {};
  const localScope: Scope = { rng: scope.rng, vars: { ...scope.vars } };
  for (const [k, spec] of Object.entries(schema)) {
    const p = `${path}.${k}`;
    let v = k in raw ? resolveDeep(raw[k], localScope, (pp, msg) => issues.add({ path: pp || p, code: "expr", message: msg }), p, spec.default) : spec.default;
    switch (spec.type) {
      case "number":
      case "int": {
        let n = typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : Number(v);
        if (!Number.isFinite(n)) {
          issues.add({ path: p, code: "type", message: `nombre attendu`, got: v, used: spec.default });
          n = spec.default;
        }
        if (spec.type === "int") n = Math.round(n);
        const lo = spec.min ?? -Infinity;
        const hi = spec.max ?? Infinity;
        if (n < lo || n > hi) {
          const c = Math.min(hi, Math.max(lo, n));
          issues.add({ path: p, code: "clamped", message: `hors bornes`, got: n, used: c, hint: `${spec.min ?? "−∞"} … ${spec.max ?? "+∞"}` });
          n = c;
        }
        v = n;
        break;
      }
      case "bool":
        v = typeof v === "boolean" ? v : v === "true" || v === 1 || v === "1";
        break;
      case "enum": {
        const s = String(v);
        if (!spec.options.includes(s)) {
          issues.add({ path: p, code: "unknown", message: `valeur « ${s} » inconnue`, got: s, used: spec.default, didYouMean: suggest(s, spec.options), hint: spec.options.join(", ") });
          v = spec.default;
        } else v = s;
        break;
      }
      case "color": {
        const s = String(v);
        v = HEX.test(s) || /^[a-z][a-z0-9]*$/i.test(s) ? s : spec.default;
        if (v !== s) issues.add({ path: p, code: "type", message: `couleur attendue (#rrggbb ou nom de rôle)`, got: s, used: v });
        break;
      }
      case "points":
        v = Array.isArray(v) ? v.filter((x) => Array.isArray(x) && x.length >= 2).map((x) => [Number(x[0]) || 0, Number(x[1]) || 0]).slice(0, 256) : spec.default;
        break;
      case "object":
        v = v && typeof v === "object" && !Array.isArray(v) ? v : spec.default;
        break;
      case "list":
        if (v !== undefined && !Array.isArray(v)) issues.add({ path: p, code: "type", message: `liste attendue`, got: typeof v, used: "[]" });
        v = Array.isArray(v) ? v.slice(0, spec.max ?? 256) : spec.default;
        // taille totale bornée (listes imbriquées : points, profils) : elle entre dans les clés de cache et la sélection
        if (Array.isArray(v) && JSON.stringify(v).length > 60000) {
          const l = (v as unknown[]).slice();
          while (l.length && JSON.stringify(l).length > 60000) l.pop();
          issues.add({ path: p, code: "limit", message: `liste trop volumineuse : ${l.length} éléments gardés` });
          v = l;
        }
        break;
      default:
        v = String(v).slice(0, 200);
    }
    out[k] = v;
    localScope.vars[k] = v;
  }
  return out as Resolved<S>;
}

/** Description lisible d'un schéma (catalogue, doc générée). */
export function describeSchema(schema: Schema): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).map(([k, s]) => [k, { ...s, ...(s.type === "enum" ? { options: [...s.options] } : {}) }]),
  );
}
