/**
 * Prefabs paramétrés des formats « monde » et « monde2d ».
 *
 * Un modèle en pièces peut déclarer des paramètres (`params.<nom> = {default, min, max, step, options, unit, type}`),
 * les utiliser dans ses pièces par des expressions sûres (`"= longueur / 2"`), contenir d'autres modèles (`use`) et
 * offrir des emplacements à garnir (`slots`). Chaque placement fournit ses valeurs (`params`, `slots`).
 *
 * Ce fichier est une passe sur le JSON d'entrée, avant la lecture : chaque jeu de valeurs distinct devient un modèle
 * ordinaire `<nom>~<clé>` (une « variante »), aux pièces résolues en nombres. Le reste de la chaîne (lecture, rendu 3D,
 * rendu 2D, instanciation du décor) ne voit que des modèles ordinaires : une variante est construite une fois, quel que
 * soit le nombre de copies.
 *
 * Coût : un paramètre de couleur qui ne sert qu'à colorer des pièces (`"color": "= teinte"`) ne crée aucune variante,
 * il devient un rôle de couleur de la copie (`~teinte`). Tout autre paramètre crée une variante par valeur distincte ;
 * le nombre de variantes est plafonné, la plus proche est réutilisée au-delà.
 */
import { isExpr, resolveDeep, variablesOf, type Scope, type Value } from "../expr";
import { Rng, hash32 } from "../rng";

type Obj = Record<string, unknown>;
export type PrefabIssue = { path: string; message: string };

export type ParamType = "nombre" | "choix" | "couleur" | "matiere" | "bool" | "texte";
export const PARAM_TYPES: ParamType[] = ["nombre", "choix", "couleur", "matiere", "bool", "texte"];

export type ParamSpec = {
  type: ParamType;
  default: Value;
  min?: number;
  max?: number;
  step?: number;
  options?: Value[];
  /** Unité affichée (`cm`, `m`, `°`…) : indication pour les interfaces, sans effet sur le calcul. */
  unit?: string;
  doc?: string;
};

export type SlotSpec = { accepte: string; default: string };

/** Fiche publiée d'un prefab (sortie `mondeInfo.prefabs`) : de quoi bâtir un formulaire et un catalogue. */
export type PrefabInfo = {
  params: Record<string, ParamSpec>;
  famille: string;
  tags: string[];
  /** Pose prévue : `sol`, `mur`, `plafond`, `dessus` (vide : libre). */
  pose: string;
  /** Marge libre à garder autour de l'objet (unité du document). */
  degagement: number;
  slots: Record<string, SlotSpec>;
  /** Variantes construites pour ce monde. */
  variants: string[];
};

export type Matiere = { color?: string; tex?: unknown; glow?: number };

/** Ce qui distingue un format (3D en mètres, 2D en pixels) pour cette passe. */
export type PrefabFormat = {
  /** Facteur vers l'unité interne (1 : rien à convertir). */
  unit: number;
  /** Pièce écrite par l'auteur, longueurs multipliées par `u` (appelé seulement si `u` ≠ 1). */
  scalePart(part: Obj, u: number): Obj;
  /** Clip écrit par l'auteur, translations multipliées par `u`. */
  scaleClip(clip: Obj, u: number): Obj;
  /** Placement, longueurs multipliées par `u`. */
  scalePlace(place: Obj, u: number): Obj;
  /** Pièces d'un sous-modèle à préréglage (pour `use`) ; `null` : non pris en charge. */
  presetParts?(model: Obj, params: Obj, seed: string): { parts: Obj[]; roles?: Record<string, string> } | null;
  /** Vrai si le modèle vient d'un générateur (hors de cette passe). */
  isGen(model: Obj): boolean;
  matieres: Record<string, Matiere>;
  /** Copies d'un placement en grille ou en semis (même calcul que le lecteur). */
  copies(place: Obj): number;
};

export const PREFAB_LIMITS = {
  /** Variantes par modèle ; au-delà, la variante la plus proche est réutilisée. */
  variantsPerModel: 32,
  variants: 512,
  depth: 4,
  uses: 64,
  /** Paliers d'un nombre tiré au hasard sans `step`. */
  levels: 16,
} as const;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isHex = (v: unknown): v is string => typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clean = (s: string) => s.replace(/[^\w-]/g, "");
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Vrai si la valeur contient une expression, à n'importe quelle profondeur. */
export function hasExpr(v: unknown): boolean {
  if (isExpr(v)) return true;
  if (Array.isArray(v)) return v.some(hasExpr);
  if (isObj(v)) return Object.values(v).some(hasExpr);
  return false;
}

function eachExpr(v: unknown, fn: (expr: string, key: string, depth: number) => void, key = "", depth = 0): void {
  if (isExpr(v)) fn(v, key, depth);
  else if (Array.isArray(v)) v.forEach((x) => eachExpr(x, fn, key, depth + 1));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) eachExpr(x, fn, k, depth + 1);
}

/** Lit la déclaration d'un paramètre : fiche `{default, …}` ou valeur nue (défaut implicite). */
export function readParamSpec(raw: unknown, path: string, issues: PrefabIssue[]): ParamSpec {
  const o: Obj = isObj(raw) && has(raw, "default") ? raw : { default: raw };
  const options = Array.isArray(o.options) ? o.options.filter((v): v is Value => typeof v === "number" || typeof v === "string" || typeof v === "boolean").slice(0, 64) : undefined;
  let def = o.default as Value;
  if (typeof def !== "number" && typeof def !== "string" && typeof def !== "boolean") {
    def = options?.length ? options[0] : 0;
    if (isObj(raw) && has(raw, "default")) issues.push({ path: `${path}.default`, message: "valeur par défaut attendue (nombre, texte ou booléen)" });
  }
  let type: ParamType;
  if (typeof o.type === "string" && (PARAM_TYPES as string[]).includes(o.type)) type = o.type as ParamType;
  else {
    if (o.type !== undefined) issues.push({ path: `${path}.type`, message: `type inconnu (${PARAM_TYPES.join(", ")})` });
    type = options?.length ? "choix" : typeof def === "number" ? "nombre" : typeof def === "boolean" ? "bool" : isHex(def) ? "couleur" : "texte";
  }
  const spec: ParamSpec = { type, default: def };
  if (fin(o.min)) spec.min = o.min;
  if (fin(o.max)) spec.max = o.max;
  if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) [spec.min, spec.max] = [spec.max, spec.min];
  if (fin(o.step) && o.step > 0) spec.step = o.step;
  if (options?.length) spec.options = options;
  if (typeof o.unit === "string") spec.unit = o.unit.slice(0, 12);
  if (typeof o.doc === "string") spec.doc = o.doc.slice(0, 200);
  return spec;
}

/** Ramène une valeur dans sa fiche ; `random` : valeur issue d'une expression (quantifiée si elle est continue). */
export function fitParam(spec: ParamSpec, v: unknown, random: boolean, path: string, issues: PrefabIssue[]): Value {
  switch (spec.type) {
    case "nombre": {
      if (!fin(v)) {
        if (v !== undefined) issues.push({ path, message: "nombre attendu : valeur par défaut gardée" });
        return spec.default;
      }
      let n = v;
      if (spec.min !== undefined && n < spec.min) n = spec.min;
      if (spec.max !== undefined && n > spec.max) n = spec.max;
      if (spec.step) {
        const o = spec.min ?? 0;
        n = o + Math.round((n - o) / spec.step) * spec.step;
        if (spec.max !== undefined && n > spec.max) n -= spec.step;
      } else if (random) {
        if (spec.min !== undefined && spec.max !== undefined && spec.max > spec.min) {
          const k = PREFAB_LIMITS.levels - 1;
          n = spec.min + (Math.round(((n - spec.min) / (spec.max - spec.min)) * k) / k) * (spec.max - spec.min);
        } else n = Math.round(n * 100) / 100;
      }
      return round4(n);
    }
    case "choix": {
      const opts = spec.options ?? [];
      if (opts.includes(v as Value)) return v as Value;
      // un nombre écrit en texte (ou l'inverse) reste un choix valable
      const alt = opts.find((x) => String(x) === String(v));
      if (alt !== undefined) return alt;
      if (v !== undefined) issues.push({ path, message: `choix inconnu « ${String(v)} » (${opts.join(", ")})` });
      return spec.default;
    }
    case "couleur":
      if (isHex(v)) return v.trim().toLowerCase();
      if (v !== undefined) issues.push({ path, message: "couleur #rrggbb attendue" });
      return spec.default;
    case "bool":
      return typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : spec.default;
    default:
      return typeof v === "string" ? v.slice(0, 80) : typeof v === "number" || typeof v === "boolean" ? String(v) : spec.default;
  }
}

type Template = {
  name: string;
  raw: Obj;
  specs: Record<string, ParamSpec>;
  /** Paramètres de couleur sans effet sur la forme : rôle de couleur de la copie. */
  free: Set<string>;
  slots: Record<string, { accepte: string; default: string; raw: Obj }>;
  info: PrefabInfo;
  variants: Map<string, Record<string, Value>>;
  preset: boolean;
};

type SlotChoice = { model: string; params: Obj } | null;

/**
 * Remplace les prefabs et leurs placements par des modèles ordinaires. Ne lève jamais : tout problème va dans `issues`.
 * Un monde sans prefab (ni unité, ni paramètre déclaré, ni `use`, ni expression) est rendu tel quel.
 */
export function expandPrefabs<T extends { models?: unknown; place?: unknown }>(src: T, issues: PrefabIssue[], fmt: PrefabFormat): { src: T; prefabs: Record<string, PrefabInfo> } {
  const models = isObj(src.models) ? (src.models as Record<string, unknown>) : null;
  const prefabs: Record<string, PrefabInfo> = {};
  if (!models) return { src, prefabs };
  const u = fmt.unit;
  const place = Array.isArray(src.place) ? (src.place as unknown[]) : [];

  const modelOf = (name: string): Obj | null => (has(models, name) && isObj(models[name]) ? (models[name] as Obj) : null);
  const featured = (m: Obj) =>
    (isObj(m.params) && Object.values(m.params).some((v) => isObj(v) && has(v, "default"))) ||
    Array.isArray(m.use) ||
    isObj(m.slots) ||
    typeof m.famille === "string" ||
    hasExpr(m.parts) ||
    hasExpr(m.clips) ||
    (Array.isArray(m.parts) && m.parts.some((p) => isObj(p) && p.matiere !== undefined));

  // Modèles à traiter : ceux qui portent une fonction de prefab, ceux qu'un placement paramètre, tous si l'unité change.
  const todo = new Set<string>();
  for (const [name, m] of Object.entries(models)) if (isObj(m) && !fmt.isGen(m) && (u !== 1 || featured(m))) todo.add(name);
  for (const p of place) {
    if (!isObj(p) || typeof p.model !== "string") continue;
    const m = modelOf(p.model);
    if (m && !fmt.isGen(m) && (isObj(p.params) || isObj(p.slots))) todo.add(p.model);
  }
  if (!todo.size && u === 1) return { src, prefabs };

  const templates = new Map<string, Template>();
  const template = (name: string): Template | null => {
    const got = templates.get(name);
    if (got) return got;
    const raw = modelOf(name);
    if (!raw || fmt.isGen(raw)) return null;
    const path = `models.${name}`;
    const specs: Record<string, ParamSpec> = {};
    if (isObj(raw.params)) for (const [k, v] of Object.entries(raw.params).slice(0, 48)) specs[k] = readParamSpec(v, `${path}.params.${k}`, issues);
    const slots: Template["slots"] = {};
    if (isObj(raw.slots))
      for (const [k, v] of Object.entries(raw.slots).slice(0, 16)) {
        if (!isObj(v)) continue;
        slots[clean(k)] = { accepte: typeof v.accepte === "string" ? v.accepte : "", default: typeof v.default === "string" ? v.default : "", raw: v };
      }
    // Paramètre de couleur « gratuit » : toutes ses lectures sont exactement `"color": "= nom"` sur une pièce.
    const uses = new Map<string, { color: number; other: number }>();
    const note = (expr: string, asColor: boolean) => {
      const body = expr.trimStart().slice(1).trim();
      for (const v of variablesOf(expr)) {
        const e = uses.get(v) ?? { color: 0, other: 0 };
        if (asColor && body === v) e.color++;
        else e.other++;
        uses.set(v, e);
      }
    };
    for (const p of Array.isArray(raw.parts) ? raw.parts : []) {
      if (!isObj(p)) continue;
      for (const [k, v] of Object.entries(p)) {
        if (k === "color" && isExpr(v)) note(v, true);
        else eachExpr(v, (e) => note(e, false));
      }
    }
    for (const k of ["use", "slots", "clips"]) eachExpr(raw[k], (e) => note(e, false));
    const free = new Set<string>();
    for (const [k, s] of Object.entries(specs)) {
      const e = uses.get(k);
      if (s.type === "couleur" && e && e.color > 0 && e.other === 0) free.add(k);
    }
    const info: PrefabInfo = {
      params: specs,
      famille: typeof raw.famille === "string" ? raw.famille.slice(0, 40) : "",
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string").slice(0, 16) : [],
      pose: typeof raw.pose === "string" ? raw.pose.slice(0, 20) : "",
      degagement: fin(raw.degagement) ? Math.max(0, raw.degagement) : 0,
      slots: Object.fromEntries(Object.entries(slots).map(([k, s]) => [k, { accepte: s.accepte, default: s.default }])),
      variants: [],
    };
    const t: Template = { name, raw, specs, free, slots, info, variants: new Map(), preset: typeof raw.preset === "string" };
    templates.set(name, t);
    return t;
  };

  /** Valeurs d'un jeu de paramètres donné à un prefab (expressions évaluées dans `scope`). */
  const valuesOf = (t: Template, given: unknown, scope: Scope, path: string): Record<string, Value> => {
    const g = isObj(given) ? given : {};
    const err = (p: string, m: string) => issues.push({ path: p || path, message: m });
    const out: Record<string, Value> = {};
    for (const [k, spec] of Object.entries(t.specs)) {
      const raw = has(g, k) ? g[k] : undefined;
      const random = isExpr(raw);
      const v = random ? resolveDeep(raw, scope, err, `${path}.${k}`, undefined) : raw;
      out[k] = fitParam(spec, v, random, `${path}.${k}`, issues);
    }
    for (const [k, raw] of Object.entries(g)) {
      if (has(t.specs, k)) continue;
      if (!t.preset) {
        issues.push({ path: `${path}.${k}`, message: `paramètre inconnu (${Object.keys(t.specs).join(", ") || "aucun paramètre déclaré"})` });
        continue;
      }
      // argument libre d'un préréglage
      const v = resolveDeep(raw, scope, err, `${path}.${k}`, undefined);
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
    }
    return out;
  };

  const slotsOf = (t: Template, given: unknown, path: string): Record<string, SlotChoice> => {
    const g = isObj(given) ? given : {};
    const out: Record<string, SlotChoice> = {};
    for (const k of Object.keys(g)) if (!has(t.slots, clean(k))) issues.push({ path: `${path}.${k}`, message: `emplacement inconnu (${Object.keys(t.slots).join(", ") || "aucun"})` });
    for (const [k, s] of Object.entries(t.slots)) {
      const c = has(g, k) ? g[k] : undefined;
      let choice: SlotChoice = s.default ? { model: s.default, params: {} } : null;
      if (c === null || c === false || c === "") choice = null;
      else if (typeof c === "string") choice = { model: c, params: {} };
      else if (isObj(c) && typeof c.model === "string") choice = { model: c.model, params: isObj(c.params) ? c.params : {} };
      else if (isObj(c) && choice) choice = { model: choice.model, params: isObj(c.params) ? c.params : {} };
      if (choice) {
        const m = modelOf(choice.model);
        const fam = m && typeof m.famille === "string" ? m.famille : "";
        if (!m) {
          issues.push({ path: `${path}.${k}`, message: `modèle inconnu « ${choice.model} »` });
          choice = s.default && s.default !== choice.model ? { model: s.default, params: {} } : null;
        } else if (s.accepte && fam !== s.accepte) {
          issues.push({ path: `${path}.${k}`, message: `emplacement réservé à la famille « ${s.accepte} » (« ${choice.model} » : ${fam || "sans famille"})` });
          choice = s.default && s.default !== choice.model ? { model: s.default, params: {} } : null;
        }
      }
      out[k] = choice;
    }
    return out;
  };

  /**
   * Pièces d'un prefab pour un jeu de valeurs, dans l'unité interne. `inline` : sous-modèle déplié dans un autre
   * (ses couleurs sont écrites en dur, il n'a pas de rôles de copie).
   */
  const build = (t: Template, values: Record<string, Value>, slots: Record<string, SlotChoice>, seed: string, inline: boolean, stack: string[], path: string): Obj[] => {
    const rng = new Rng(seed);
    const scope: Scope = { vars: { ...values }, rng };
    const err = (p: string, m: string) => issues.push({ path: p || path, message: m });
    const out: Obj[] = [];
    const rawParts = Array.isArray(t.raw.parts) ? t.raw.parts : [];
    rawParts.forEach((rp, i) => {
      if (!isObj(rp)) return;
      const src0: Obj = { ...rp };
      if (!inline && isExpr(src0.color)) {
        const v = src0.color.trimStart().slice(1).trim();
        if (t.free.has(v)) {
          delete src0.color;
          src0.role = `~${v}`;
        }
      }
      let part = resolveDeep(src0, scope, err, `${path}.parts.${i}`, 0) as Obj;
      if (part.matiere !== undefined) {
        const key = String(part.matiere);
        const m = has(fmt.matieres as Obj, key) ? fmt.matieres[key] : null;
        if (!m) issues.push({ path: `${path}.parts.${i}.matiere`, message: `matière inconnue « ${key} » (${Object.keys(fmt.matieres).join(", ")})` });
        else {
          if (m.color && part.color === undefined) part.color = m.color;
          if (m.tex !== undefined && part.tex === undefined) part.tex = m.tex;
          if (m.glow !== undefined && part.glow === undefined) part.glow = m.glow;
        }
        part = { ...part };
        delete part.matiere;
      }
      out.push(u !== 1 ? fmt.scalePart(part, u) : part);
    });

    // Sous-modèles : `use` écrits, puis emplacements garnis
    type Use = { raw: Obj; path: string; choice?: SlotChoice };
    const uses: Use[] = [];
    (Array.isArray(t.raw.use) ? t.raw.use : []).slice(0, PREFAB_LIMITS.uses).forEach((x, i) => isObj(x) && uses.push({ raw: x, path: `${path}.use.${i}` }));
    for (const [k, s] of Object.entries(t.slots)) if (slots[k]) uses.push({ raw: { ...s.raw, name: k }, path: `${path}.slots.${k}`, choice: slots[k] });
    const taken = new Set<string>();
    let total = 0;
    for (const use of uses) {
      const mname = use.choice ? use.choice.model : typeof use.raw.model === "string" ? use.raw.model : "";
      const sub = template(mname);
      if (!sub) {
        const m = modelOf(mname);
        issues.push({ path: use.path, message: m ? `« ${mname} » vient d'un générateur : il ne peut pas être déplié dans un autre modèle (placez-le à part)` : `modèle inconnu « ${mname} »` });
        continue;
      }
      if (stack.includes(mname) || mname === t.name) {
        issues.push({ path: use.path, message: `cycle : « ${mname} » se contient lui-même` });
        continue;
      }
      if (stack.length + 1 >= PREFAB_LIMITS.depth) {
        issues.push({ path: use.path, message: `plus de ${PREFAB_LIMITS.depth} niveaux de modèles imbriqués` });
        continue;
      }
      const nRaw = use.raw.repeat === undefined ? 1 : resolveDeep(use.raw.repeat, scope, err, `${use.path}.repeat`, 1);
      const n = Math.max(0, Math.min(PREFAB_LIMITS.uses, Math.round(fin(nRaw) ? nRaw : 1)));
      const baseName = clean(typeof use.raw.name === "string" && use.raw.name ? use.raw.name : mname) || "piece";
      for (let k = 0; k < n; k++) {
        if (++total > PREFAB_LIMITS.uses) {
          issues.push({ path: use.path, message: `plus de ${PREFAB_LIMITS.uses} sous-modèles : suite ignorée` });
          break;
        }
        const sc: Scope = { vars: { ...values, i: k, n }, rng: rng.fork(`${baseName}/${k}`) };
        let nm = n > 1 ? `${baseName}${k}` : baseName;
        while (taken.has(nm)) nm += "_";
        taken.add(nm);
        const joint: Obj = { name: nm };
        for (const key of ["at", "rot", "scale", "parent"]) if (use.raw[key] !== undefined) joint[key] = resolveDeep(use.raw[key], sc, err, `${use.path}.${key}`, 0);
        out.push(u !== 1 ? fmt.scalePart(joint, u) : joint);
        const given = use.choice ? use.choice.params : use.raw.params;
        const subValues = valuesOf(sub, given, sc, `${use.path}.params`);
        const subSlots = slotsOf(sub, use.raw.slots, `${use.path}.slots`);
        const subSeed = `${seed}/${nm}`;
        let parts = build(sub, subValues, subSlots, subSeed, true, [...stack, t.name], `models.${mname}`);
        if (sub.preset) {
          const pre = fmt.presetParts?.(sub.raw, subValues, `${sub.raw.seed ?? mname}`) ?? null;
          if (!pre) issues.push({ path: use.path, message: `« ${mname} » repose sur un préréglage : non déplié ici` });
          else {
            // même règle que le lecteur : une pièce écrite du même nom remplace celle du préréglage
            const merged: Obj[] = pre.parts.map((p) => {
              const role = typeof p.role === "string" ? p.role : "";
              return p.color === undefined && role && pre.roles && isHex(pre.roles[role]) ? { ...p, color: pre.roles[role] } : { ...p };
            });
            for (const p of parts) {
              const j = typeof p.name === "string" ? merged.findIndex((q) => q.name === p.name) : -1;
              if (j >= 0) merged[j] = { ...merged[j], ...p };
              else merged.push(p);
            }
            parts = merged;
          }
        }
        parts.forEach((p, j) => {
          const pn = clean(typeof p.name === "string" && p.name ? p.name : `piece${j}`);
          out.push({ ...p, name: `${nm}_${pn}`, parent: typeof p.parent === "string" && p.parent ? `${nm}_${clean(p.parent)}` : nm });
        });
      }
    }
    return out;
  };

  const outModels: Record<string, unknown> = { ...models };
  for (const name of todo) delete outModels[name];
  let nVariants = 0;
  let capped = false;

  const distance = (t: Template, a: Record<string, Value>, b: Record<string, Value>) => {
    let d = 0;
    for (const [k, s] of Object.entries(t.specs)) {
      if (t.free.has(k)) continue;
      const x = a[k], y = b[k];
      if (typeof x === "number" && typeof y === "number") d += Math.abs(x - y) / (s.max !== undefined && s.min !== undefined && s.max > s.min ? s.max - s.min : Math.max(1, Math.abs(x), Math.abs(y)));
      else if (x !== y) d += 1;
    }
    return d;
  };

  /** Variante d'un prefab pour des valeurs : son nom de modèle et les rôles de couleur de la copie. */
  const variant = (t: Template, values: Record<string, Value>, slots: Record<string, SlotChoice>, path: string): { model: string; roles: Record<string, string> } => {
    const roles: Record<string, string> = {};
    const shaped: [string, Value][] = [];
    for (const k of Object.keys(values).sort()) {
      if (t.free.has(k)) roles[`~${k}`] = String(values[k]);
      else shaped.push([k, values[k]]);
    }
    const key = JSON.stringify([shaped, slots]);
    const vname = `${t.name}~${hash32(key).toString(36)}`;
    if (!t.variants.has(vname)) {
      if (t.variants.size >= PREFAB_LIMITS.variantsPerModel || nVariants >= PREFAB_LIMITS.variants) {
        if (!capped) issues.push({ path, message: `plus de ${PREFAB_LIMITS.variantsPerModel} variantes de « ${t.name} » (ou ${PREFAB_LIMITS.variants} au total) : la plus proche est réutilisée ; donnez un step ou des options aux paramètres` });
        capped = true;
        let best = "";
        let bd = Infinity;
        for (const [n, v] of t.variants) {
          const d = distance(t, values, v);
          if (d < bd) [best, bd] = [n, d];
        }
        if (best) return { model: best, roles };
      }
      nVariants++;
      t.variants.set(vname, values);
      t.info.variants.push(vname);
      const { params: _p, use: _u, slots: _s, parts: _parts, clips, famille: _f, tags: _t, pose: _po, degagement: _d, ...rest } = t.raw;
      const parts = build(t, values, slots, `${t.raw.seed ?? t.name}/${vname}`, false, [], `models.${t.name}`);
      const model: Obj = { ...rest, parts };
      if (t.preset) {
        model.params = values;
        if (rest.seed === undefined) model.seed = t.name;
      }
      if (isObj(clips)) {
        const scope: Scope = { vars: { ...values }, rng: new Rng(`${t.name}/clips`) };
        const res = resolveDeep(clips, scope, (p, m) => issues.push({ path: p || `models.${t.name}.clips`, message: m }), `models.${t.name}.clips`, 0) as Obj;
        model.clips = u !== 1 ? Object.fromEntries(Object.entries(res).map(([k, c]) => [k, isObj(c) ? fmt.scaleClip(c, u) : c])) : res;
      }
      outModels[vname] = model;
    }
    return { model: vname, roles };
  };

  const outPlace = place.map((raw, i) => {
    if (!isObj(raw)) return raw;
    let p: Obj = u !== 1 ? fmt.scalePlace(raw, u) : raw;
    const name = typeof p.model === "string" ? p.model : "";
    if (!todo.has(name)) return p;
    const t = template(name);
    if (!t) return p;
    const path = `place.${i}`;
    const { params, slots: slotsIn, ...rest } = p;
    p = rest;
    const slots = slotsOf(t, slotsIn, `${path}.slots`);
    const ownRoles = isObj(p.roles) ? p.roles : {};
    const n = fmt.copies(p);
    const seedRng = new Rng(`${p.seed ?? i}/${name}/params`);
    if (n > 1 && hasExpr(params)) {
      const copies: { model: string; roles: Record<string, string> }[] = [];
      for (let k = 0; k < n; k++) {
        const v = variant(t, valuesOf(t, params, { vars: { i: k, n }, rng: seedRng.fork(k) }, `${path}.params`), slots, path);
        copies.push(v);
      }
      // même problème répété pour chaque copie : une seule fois suffit
      dedupe(issues);
      return { ...p, model: copies[0]?.model ?? name, copies };
    }
    const v = variant(t, valuesOf(t, params, { vars: { i: 0, n: 1 }, rng: seedRng.fork(0) }, `${path}.params`), slots, path);
    return { ...p, model: v.model, roles: { ...v.roles, ...ownRoles } };
  });

  // Fiche de chaque prefab déclaré, placé ou non
  for (const [name, m] of Object.entries(models)) {
    if (!isObj(m) || fmt.isGen(m) || !featured(m)) continue;
    const t = template(name);
    if (t) prefabs[name] = t.info;
  }
  for (const name of todo) if (!has(prefabs, name) && templates.get(name)?.info.variants.length && Object.keys(templates.get(name)!.specs).length) prefabs[name] = templates.get(name)!.info;
  return { src: { ...src, models: outModels, place: outPlace }, prefabs };
}

function dedupe(issues: PrefabIssue[]): void {
  const seen = new Set<string>();
  let w = 0;
  for (const it of issues) {
    const k = `${it.path}\u0000${it.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    issues[w++] = it;
  }
  issues.length = w;
}
