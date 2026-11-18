/**
 * États des objets (CPU, pur) : valeur 0…1 de chaque partie mobile (`lid`, `door.fl`…) et états « libres » sans
 * partie (`burning`, `lit`, `boiling`, `smoking`) qui pilotent des particules et une lumière.
 *
 * Sources, de la plus faible à la plus forte : `layers[i].states` (`{"<rang>" | "*": {…}}`), `actors.<id>.states`,
 * puis la clé `states` du DataProvider (`{"<objectId>": {…}}`, fusionnée par objet). Rien de tout cela ne recompose la
 * scène : ces clés sont retirées de la clé de composition (`stripStates`), le rendu anime les parties.
 *
 * Particules liées à un état : `layers[i].stateFx` ou `fx` dans l'état d'un objet, `{"lid>0.3": "steam"}` ; les
 * états libres ont leurs effets par défaut (`FREE_STATES`). Les systèmes passent par `scene/fx.ts` (aucun moteur à part).
 */
import { type Issues, suggest } from "../core/schema";
import type { V3 } from "../core/math";
import type { ObjectInfo, PointLight } from "./compose";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Effet d'un état libre : préréglage de `scene/fx.ts`, ancre (première trouvée), réglages. */
type FreeFx = { preset: string; anchors: string[]; dy?: number; tune?: Record<string, unknown> };
export type FreeState = { label: string; aliases: string[]; fx: FreeFx[]; light?: PointLight["kind"]; doc: string };

/**
 * États libres reconnus par défaut. Les objets à ancre `light` (lanterne, feu de camp, lampadaire), `chimney.N`
 * (bâtiment), `inside` (contenant) gardent leurs points naturels ; sinon le haut de l'objet.
 */
export const FREE_STATES: Record<string, FreeState> = {
  burning: {
    label: "en feu",
    aliases: ["brule", "brûle", "feu", "fire", "enfeu"],
    fx: [
      { preset: "feu", anchors: ["top"], dy: -0.05, tune: { rate: 30, size: [0.5, 0.08], extent: [0.3, 0.1, 0.3] } },
      { preset: "fumee", anchors: ["top"], dy: 0.3, tune: { rate: 5, life: [2.5, 4.5], size: [0.4, 1.8], opacity: [0.45, 0], color: ["#333333", "#8a8a8a"] } },
      { preset: "braise", anchors: ["top"], tune: { rate: 4 } },
    ],
    light: "fire",
    doc: "flammes, fumée noire et braises sur le haut de l'objet, lueur de feu",
  },
  lit: {
    label: "allumé",
    aliases: ["allume", "allumé", "on", "light"],
    fx: [{ preset: "feu", anchors: ["light", "top"], dy: -0.06, tune: { rate: 14, size: [0.16, 0.03], extent: [0.04, 0.02, 0.04], life: [0.3, 0.6] } }],
    light: "fire",
    doc: "petite flamme à l'ancre `light` (lanterne, feu de camp, lampe) ou en haut, et sa lumière",
  },
  boiling: {
    label: "qui bout",
    aliases: ["bout", "bouillant", "boil"],
    fx: [
      { preset: "vapeur", anchors: ["inside", "top"], dy: 0.05, tune: { rate: 8, size: [0.12, 0.6], life: [1.2, 2.2] } },
      { preset: "bulles", anchors: ["inside", "top"], dy: 0.02, tune: { rate: 10, size: [0.025, 0.02], life: [0.3, 0.6], speed: [0.1, 0.3], extent: [0.1, 0.01, 0.1] } },
    ],
    doc: "vapeur et bulles à l'ancre `inside` (marmite, seau, bidon) ou en haut",
  },
  smoking: {
    label: "qui fume",
    aliases: ["fume", "fumant", "smoke"],
    fx: [{ preset: "fumee", anchors: ["chimney", "light", "top"], dy: 0.05, tune: { rate: 4, life: [3, 5], size: [0.25, 1.4], opacity: [0.5, 0], color: ["#55514d", "#b3aea8"] } }],
    doc: "fumée grise aux cheminées (`chimney.N`), à l'ancre `light` ou en haut",
  },
};

const FREE_ALIAS: Record<string, string> = {};
for (const [k, s] of Object.entries(FREE_STATES)) {
  FREE_ALIAS[k] = k;
  for (const a of s.aliases) FREE_ALIAS[a] = k;
}
/** Nom canonique d'un état libre (`brule` → `burning`), sinon `null`. */
export const freeStateName = (k: string): string | null => FREE_ALIAS[k] ?? null;

export type StatesInput = {
  layers: { id: string; states?: unknown; stateFx?: unknown }[];
  actors: Record<string, unknown>;
  dp?: unknown;
  speed?: unknown;
};

/** Clés de recette et du DataProvider lues par les états (retirées de la clé de composition). */
export function statesInputOf(recipe: Record<string, unknown> | null | undefined, dpStates?: unknown, dpSpeed?: unknown): StatesInput {
  const r = recipe ?? {};
  const layers = Array.isArray(r.layers) ? (r.layers as unknown[]) : [];
  const actors: Record<string, unknown> = {};
  if (isObj(r.actors)) for (const [id, a] of Object.entries(r.actors)) if (isObj(a) && a.states !== undefined) actors[id] = a.states;
  return {
    layers: layers.map((l, i) => (isObj(l) ? { id: String(l.id || `layer${i}`), states: l.states, stateFx: l.stateFx } : { id: `layer${i}` })),
    actors,
    dp: dpStates,
    speed: dpSpeed ?? r.stateSpeed,
  };
}

/** Recette sans les clés d'état (clé de composition : changer un état ne recompose pas). */
export function stripStates<T>(recipe: T): T {
  if (!isObj(recipe)) return recipe;
  const rest: Record<string, unknown> = { ...(recipe as Record<string, unknown>) };
  delete rest.stateSpeed;
  if (Array.isArray(rest.layers))
    rest.layers = (rest.layers as unknown[]).map((l) => {
      if (!isObj(l) || !("states" in l || "stateFx" in l)) return l;
      const o = { ...l };
      delete o.states;
      delete o.stateFx;
      return o;
    });
  if (isObj(rest.actors)) {
    const a: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(rest.actors)) {
      if (isObj(v) && "states" in v) {
        const o = { ...v };
        delete o.states;
        a[id] = o;
      } else a[id] = v;
    }
    rest.actors = a;
  }
  return rest as T;
}

/** Condition d'effet : `lid>0.3`, `door.fl>=0.5`, `burning` (= `> 0`). */
type Cond = { name: string; op: ">" | ">=" | "<" | "<="; t: number };
export function readCond(s: string): Cond | null {
  const m = /^\s*([A-Za-z][\w.-]*)\s*(?:(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?))?\s*$/.exec(s);
  if (!m) return null;
  return { name: m[1], op: (m[2] as Cond["op"]) ?? ">", t: m[3] !== undefined ? Number(m[3]) : 0 };
}
const holds = (c: Cond, v: number) => (c.op === ">" ? v > c.t : c.op === ">=" ? v >= c.t : c.op === "<" ? v < c.t : v <= c.t);

/** Effet lié à un état, prêt pour `scene/fx.ts` : un système par effet, sources = ancres des objets concernés. */
export type StateFxPlan = { id: string; raw: Record<string, unknown>; list: { id: string; anchor: string; dy: number }[]; weight: number };

export type ResolvedStates = {
  /** Valeurs demandées par objet (parties par nom exact, états libres par nom canonique). */
  values: Record<string, Record<string, number>>;
  /** Durée d'une course complète (s). */
  speed: number;
  fx: StateFxPlan[];
  lights: PointLight[];
};

/** Parties visées par une clé : nom exact, préfixe (`door` → `door.fl`, `door.fr`…), `open` (couvercle, sinon tout ce qui s'ouvre). */
export function partsForKey(o: Pick<ObjectInfo, "joints">, key: string): string[] {
  const J = o.joints ?? [];
  if (!J.length) return [];
  if (key === "open") {
    const lid = J.filter((j) => j.openable !== false && (j.name === "lid" || j.name.startsWith("lid.")));
    return (lid.length ? lid : J.filter((j) => j.openable !== false)).map((j) => j.name);
  }
  if (J.some((j) => j.name === key)) return [key];
  return J.filter((j) => j.name.startsWith(key + ".")).map((j) => j.name);
}

/** Valeur courante d'une partie ou d'un état libre (demandée, sinon valeur de départ, sinon 0). */
export function stateValue(o: Pick<ObjectInfo, "joints">, vals: Record<string, number> | undefined, name: string): number {
  if (vals && typeof vals[name] === "number") return vals[name];
  const j = o.joints?.find((x) => x.name === name);
  if (j) return j.initial;
  // préfixe : la plus ouverte des parties (`door` > 0.3 dès qu'une portière l'est)
  const ps = partsForKey(o, name);
  if (ps.length) return Math.max(...ps.map((n) => stateValue(o, vals, n)));
  return 0;
}

const SPEED_DEFAULT = 0.6;

/** Lit toutes les sources d'états et les rapporte aux objets composés ; problèmes dans `issues`. */
export function resolveStates(input: StatesInput, objects: ObjectInfo[], issues: Issues): ResolvedStates {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const values: Record<string, Record<string, number>> = {};
  const objFx: { o: ObjectInfo; rules: unknown; path: string }[] = [];
  const keysOf = (o: ObjectInfo) => [...new Set([...(o.joints ?? []).flatMap((j) => [j.name, ...j.name.split(".").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("."))]), ...(o.joints?.length ? ["open"] : []), ...Object.keys(FREE_STATES)])];

  /** Applique une table `{clé: valeur}` à un objet. */
  const applyTo = (o: ObjectInfo, raw: unknown, path: string) => {
    if (!isObj(raw)) {
      issues.add({ path, code: "type", message: "objet {partie: 0…1 ou booléen} attendu", hint: keysOf(o).join(", ") });
      return;
    }
    const vals = (values[o.id] ??= {});
    for (const [k, v0] of Object.entries(raw)) {
      const p = `${path}.${k}`;
      if (k === "fx") {
        objFx.push({ o, rules: v0, path: p });
        continue;
      }
      let v: number;
      if (typeof v0 === "boolean") v = v0 ? 1 : 0;
      else if (typeof v0 === "number" && Number.isFinite(v0)) {
        v = clamp01(v0);
        if (v !== v0) issues.add({ path: p, code: "clamped", message: "état ramené entre 0 (fermé) et 1 (ouvert)", got: v0, used: v });
      } else {
        issues.add({ path: p, code: "type", message: "état attendu : nombre de 0 à 1 ou booléen", got: v0 as never });
        continue;
      }
      const free = freeStateName(k);
      if (free) {
        vals[free] = v;
        continue;
      }
      const parts = partsForKey(o, k);
      if (!parts.length) {
        const known = keysOf(o);
        issues.add({ path: p, code: "unknown", message: o.joints?.length ? `partie « ${k} » inconnue sur ${o.id}` : `${o.id} (${o.generator}) n'a pas de partie mobile : états libres seulement`, didYouMean: suggest(k, known), hint: known.join(", ") });
        continue;
      }
      for (const n of parts) vals[n] = v;
    }
  };

  input.layers.forEach((L, li) => {
    if (L.states === undefined) return;
    const path = `layers[${li}].states`;
    if (!isObj(L.states)) return issues.add({ path, code: "type", message: "objet {\"<rang>\" | \"*\": {partie: valeur}} attendu" });
    const mine = objects.filter((o) => o.layer === L.id);
    for (const [k, raw] of Object.entries(L.states)) {
      if (k === "*") {
        for (const o of mine) applyTo(o, raw, `${path}.*`);
        continue;
      }
      const o = byId.get(`${L.id}.${k}`);
      if (!o) {
        issues.add({ path: `${path}.${k}`, code: "unknown", message: `aucun objet de rang « ${k} » dans le calque ${L.id}`, didYouMean: suggest(k, mine.map((x) => String(x.index ?? x.id.slice(L.id.length + 1)))), hint: "rang (0, 1, 2…) ou \"*\"" });
        continue;
      }
      applyTo(o, raw, `${path}.${k}`);
    }
  });
  for (const [id, raw] of Object.entries(input.actors)) {
    const o = byId.get(id);
    if (o) applyTo(o, raw, `actors.${id}.states`);
  }
  if (input.dp !== undefined && input.dp !== null) {
    if (!isObj(input.dp)) issues.add({ path: "states", code: "type", message: "objet {\"<objectId>\": {partie: valeur}} attendu" });
    else
      for (const [id, raw] of Object.entries(input.dp)) {
        const o = byId.get(id);
        if (!o) {
          issues.add({ path: `states.${id}`, code: "unknown", message: `objet « ${id} » introuvable`, didYouMean: suggest(id, objects.map((x) => x.id)) });
          continue;
        }
        applyTo(o, raw, `states.${id}`);
      }
  }

  /* ---------- effets : états libres, règles de calque et d'objet ---------- */
  const groups = new Map<string, StateFxPlan>();
  const push = (key: string, raw: Record<string, unknown>, o: ObjectInfo, anchor: string, dy: number, weight: number) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { id: `state-${key}`.replace(/[^\w-]/g, "_").slice(0, 60), raw, list: [], weight }));
    g.weight = Math.max(g.weight, weight);
    if (g.list.length < 64) g.list.push({ id: o.id, anchor, dy });
  };
  /** Première ancre présente (préfixe `chimney` → toutes les `chimney.N`). */
  const anchorsFor = (o: ObjectInfo, names: string[]): string[] => {
    for (const n of names) {
      if (o.anchors[n]) return [n];
      const pre = Object.keys(o.anchors).filter((k) => k.startsWith(n + ".") && /^\d+$/.test(k.slice(n.length + 1)));
      if (pre.length) return pre;
    }
    return ["top"];
  };
  const lights: PointLight[] = [];
  for (const o of objects) {
    const vals = values[o.id];
    if (!vals) continue;
    for (const [name, st] of Object.entries(FREE_STATES)) {
      const v = vals[name];
      if (!v) continue;
      const big = o.height > 2.5;
      for (const f of st.fx) {
        const tune = big && name === "burning" ? { ...f.tune, extent: [Math.min(4, o.footprint.hx * 0.7), 0.2, Math.min(4, o.footprint.hz * 0.7)], size: f.preset === "feu" ? [1.4, 0.2] : f.tune?.size, rate: (Number(f.tune?.rate) || 10) * 3 } : f.tune;
        for (const a of anchorsFor(o, f.anchors)) push(`${name}-${f.preset}${big ? "-l" : ""}`, { preset: f.preset, ...tune }, o, a, f.dy ?? 0, v);
      }
      if (st.light) {
        const a = anchorsFor(o, ["light", "top"])[0];
        const p: V3 = o.anchors[a] ?? [o.pos[0], o.pos[1] + o.height, o.pos[2]];
        lights.push({ pos: [p[0], p[1] + 0.1, p[2]], kind: st.light, radius: name === "burning" ? Math.max(6, o.height * 3) : 5 });
      }
    }
  }
  const rule = (o: ObjectInfo, rules: unknown, path: string) => {
    if (!isObj(rules)) return issues.add({ path, code: "type", message: "objet {\"<partie|état>[>seuil]\": \"<effet>\"} attendu (ex. {\"lid>0.3\": \"steam\"})" });
    for (const [cs, eff] of Object.entries(rules)) {
      const c = readCond(cs);
      const p = `${path}.${cs}`;
      if (!c) {
        issues.add({ path: p, code: "type", message: "condition attendue : nom, ou nom>seuil (>, >=, <, <=)", hint: "lid>0.3, burning, door.fl>=0.5" });
        continue;
      }
      const free = freeStateName(c.name);
      const name = free ?? c.name;
      if (!free && !partsForKey(o, c.name).length) {
        const known = keysOf(o).filter((k) => k !== "open");
        issues.add({ path: p, code: "unknown", message: `partie ou état « ${c.name} » inconnu sur ${o.id}`, didYouMean: suggest(c.name, known), hint: known.join(", ") });
        continue;
      }
      const preset = typeof eff === "string" ? eff : isObj(eff) && typeof eff.preset === "string" ? eff.preset : "";
      if (!preset) {
        issues.add({ path: p, code: "type", message: "effet attendu : nom (steam, smoke, fire, bubbles…) ou {preset, anchor, …}" });
        continue;
      }
      const v = free ? values[o.id]?.[free] ?? 0 : stateValue(o, values[o.id], c.name);
      if (!holds(c, v)) continue;
      const { preset: _p, anchor, intensity, ...tune } = isObj(eff) ? eff : ({} as Record<string, unknown>);
      void _p;
      const an = typeof anchor === "string" ? [anchor] : [`${name}.top`, "inside", "top"];
      for (const a of anchorsFor(o, an)) push(`${cs}-${preset}-${JSON.stringify(tune)}`, { preset, ...tune }, o, a, 0, typeof intensity === "number" ? intensity : 1);
    }
  };
  input.layers.forEach((L, li) => {
    if (L.stateFx === undefined) return;
    for (const o of objects) if (o.layer === L.id) rule(o, L.stateFx, `layers[${li}].stateFx`);
  });
  for (const f of objFx) rule(f.o, f.rules, f.path);

  const sp = typeof input.speed === "number" && Number.isFinite(input.speed) ? input.speed : SPEED_DEFAULT;
  if (input.speed !== undefined && sp !== input.speed) issues.add({ path: "stateSpeed", code: "type", message: "durée en secondes attendue (0 = immédiat)", got: input.speed as never, used: SPEED_DEFAULT });
  return { values, speed: Math.max(0, Math.min(10, sp)), fx: [...groups.values()].slice(0, 24), lights: lights.slice(0, 12) };
}
