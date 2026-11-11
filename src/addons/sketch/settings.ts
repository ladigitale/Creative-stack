/**
 * Réglages d'autres DataProviders gardés par le carnet de `sonic-sketch` :
 * - `settings-from` : réglages du dessin (fond, palette, guides, effets…), enregistrés avec chaque dessin et
 *   remis en place à son ouverture ;
 * - `prefs-from` : préférences de l'utilisateur (pinceau, outil…), gardées d'une session à l'autre.
 *
 * Syntaxe : une liste séparée par des espaces de `store` (tout l'état) ou `store.clé1,clé2` (ces clés
 * seulement — pour ne pas garder l'état d'interface d'un store, comme une modale ouverte).
 */

export type SettingsRef = { dp: string; keys: string[] | null };
export type SettingsSnapshot = Record<string, Record<string, unknown>>;

const NAME = /^[A-Za-z_][\w:-]{0,63}$/;
const KEY = /^[A-Za-z_$][\w$-]{0,63}$/;
export const MAX_SETTINGS_REFS = 16;
/** Taille maximale d'un instantané sérialisé (caractères). */
export const MAX_SETTINGS_CHARS = 64 * 1024;

export function parseSettingsRefs(raw: unknown): SettingsRef[] {
  if (typeof raw !== "string") return [];
  const out: SettingsRef[] = [];
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const dot = token.indexOf(".");
    const dp = dot < 0 ? token : token.slice(0, dot);
    const keysPart = dot < 0 ? "" : token.slice(dot + 1);
    if (!NAME.test(dp)) continue;
    const keys = keysPart ? keysPart.split(",").filter((k) => KEY.test(k)) : null;
    if (keys && !keys.length) continue;
    const prev = out.find((r) => r.dp === dp);
    if (prev) {
      prev.keys = prev.keys && keys ? [...new Set([...prev.keys, ...keys])] : null;
      continue;
    }
    out.push({ dp, keys });
    if (out.length >= MAX_SETTINGS_REFS) break;
  }
  return out;
}

/** Valeur JSON simple (objets, tableaux, chaînes, nombres finis, booléens, null), profondeur bornée. */
function clean(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (depth > 8 || typeof v !== "object") return undefined;
  if (Array.isArray(v)) return v.slice(0, 256).map((x) => clean(x, depth + 1)).filter((x) => x !== undefined);
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 256)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    const c = clean(x, depth + 1);
    if (c !== undefined) o[k] = c;
  }
  return o;
}

/** Instantané des réglages : pour chaque store, ses clés retenues (ou tout son état s'il est un objet). */
export function snapshotSettings(refs: SettingsRef[], values: Record<string, unknown>): SettingsSnapshot {
  const out: SettingsSnapshot = {};
  for (const r of refs) {
    const v = values[r.dp];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const src = v as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    // `lastError` : publié par sonic-store à côté de l'état, ce n'est pas un réglage.
    for (const k of r.keys ?? Object.keys(src).filter((k) => k !== "lastError")) if (k in src) picked[k] = src[k];
    const c = clean(picked) as Record<string, unknown>;
    if (Object.keys(c).length) out[r.dp] = c;
  }
  return out;
}

/** Relit un instantané enregistré : seuls les stores et clés de `refs`, valeurs JSON simples, taille bornée. */
export function readSettings(raw: unknown, refs: SettingsRef[]): SettingsSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  try {
    if (JSON.stringify(raw).length > MAX_SETTINGS_CHARS) return {};
  } catch {
    return {};
  }
  return snapshotSettings(refs, raw as Record<string, unknown>);
}

/** Instantané sérialisé de façon stable (clés triées), pour comparer « enregistré » et « actuel ». */
export function settingsKey(s: SettingsSnapshot): string {
  const sort = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
      : Array.isArray(v) ? v.map(sort) : v;
  try {
    return JSON.stringify(sort(s));
  } catch {
    return "";
  }
}
