import { num } from "../../shared/media/control";

/**
 * Réglages en direct par DataProvider (`params`, et pour certains composants `control`) pour les composants
 * de l'addon vision. Chaque clé est le nom de la propriété (camelCase) ; sa valeur est validée et bornée,
 * puis **posée sur la propriété** : le composant garde un seul chemin de lecture (`this.minScore`…) et ses
 * réactions existantes (rechargement, relance) s'appliquent. Priorité : attribut < `control` < `params`.
 * La valeur d'attribut est mémorisée : elle revient quand la clé disparaît du DataProvider, et un attribut
 * modifié pendant qu'une clé le recouvre devient la nouvelle valeur de repli sans écraser la clé.
 */
export type ParamSpec =
  | { kind: "number"; min: number; max: number; int?: boolean }
  /** Valeur parmi `values` ; un booléen devient `"true"` / `"false"` si ces valeurs sont admises. */
  | { kind: "enum"; values: readonly string[] }
  /** Texte libre (un nombre est converti) ; `pattern` le restreint ; `max` borne sa longueur. */
  | { kind: "string"; pattern?: RegExp; max?: number };

export type ParamSpecs = Record<string, ParamSpec>;

/** Propriété `"true" | "false"` (convention des composants vision). */
export const FLAG: ParamSpec = { kind: "enum", values: ["true", "false"] };
export const MIRROR: ParamSpec = { kind: "enum", values: ["auto", "true", "false"] };

/** Valeur validée d'une clé, `undefined` si absente ou invalide. */
export function readParam(spec: ParamSpec, v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  if (spec.kind === "number") {
    if (typeof v === "boolean") return undefined;
    const n = num(v, spec.min, spec.max);
    return n === undefined ? undefined : spec.int ? Math.round(n) : n;
  }
  if (spec.kind === "enum") {
    let s: string | undefined;
    if (typeof v === "boolean") s = v ? "true" : "false";
    else if (typeof v === "number" && spec.values.includes("true") && (v === 0 || v === 1)) s = v ? "true" : "false";
    else if (typeof v === "string" || typeof v === "number") s = String(v).trim();
    return s !== undefined && spec.values.includes(s) ? s : undefined;
  }
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v);
  if (spec.max !== undefined && s.length > spec.max) return undefined;
  if (spec.pattern && !spec.pattern.test(s.trim())) return undefined;
  return s;
}

/** Clés valides d'un objet de DataProvider (les autres sont ignorées). */
export function readParams(specs: ParamSpecs, v: unknown): Record<string, unknown> {
  const p = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specs)) {
    if (!Object.prototype.hasOwnProperty.call(p, key)) continue;
    const val = readParam(spec, p[key]);
    if (val !== undefined) out[key] = val;
  }
  return out;
}

/** Recouvrement des propriétés d'un élément par des réglages venus de DataProvider. */
export class ParamOverlay {
  private base = new Map<string, unknown>();
  private applied = new Map<string, unknown>();

  constructor(private readonly host: object) {}

  private get target(): Record<string, unknown> {
    return this.host as Record<string, unknown>;
  }

  /** Pose `values` (déjà validées) ; les clés absentes reprennent leur valeur d'attribut. */
  set(values: Record<string, unknown>): void {
    const t = this.target;
    for (const key of [...this.applied.keys()]) {
      if (key in values) continue;
      t[key] = this.base.get(key);
      this.base.delete(key);
      this.applied.delete(key);
    }
    for (const [key, val] of Object.entries(values)) {
      if (!this.base.has(key)) this.base.set(key, t[key]);
      this.applied.set(key, val);
      if (t[key] !== val) t[key] = val;
    }
  }

  /**
   * À appeler dans `willUpdate` : un attribut changé alors qu'une clé le recouvre devient la valeur de
   * repli, et la valeur du DataProvider est remise (elle reste prioritaire).
   */
  guard(changed: Map<PropertyKey, unknown>): void {
    const t = this.target;
    for (const [key, val] of this.applied) {
      if (changed.has(key) && t[key] !== val) {
        this.base.set(key, t[key]);
        t[key] = val;
      }
    }
  }

  /** Clés actuellement recouvertes. */
  keys(): string[] {
    return [...this.applied.keys()];
  }
}

/** Propriétés réellement modifiées pendant ce cycle (une valeur remise par `guard` n'en est pas une). */
export function realChanges(host: object, changed: Map<PropertyKey, unknown>): string[] {
  const t = host as Record<string, unknown>;
  return [...changed.keys()].map(String).filter((k) => changed.get(k) !== t[k]);
}

/** Valeurs courantes des clés de `specs` (pour l'état publié). */
export function snapshot(host: object, specs: ParamSpecs): Record<string, unknown> {
  const t = host as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(specs)) out[key] = t[key];
  return out;
}

/** `true`, `"true"`, `1` → vrai ; `false`, `"false"`, `0` → faux ; sinon `undefined`. */
export function flag(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "true" || v === "1") return true;
  if (v === 0 || v === "false" || v === "0") return false;
  return undefined;
}
