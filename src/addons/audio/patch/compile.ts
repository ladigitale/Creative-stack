/**
 * Compilateur de patch : arbre de modules (issu du DOM ou d'un preset) →
 * description de voix et de chaîne globale. Pur, sans WebAudio ni DOM.
 *
 * Erreurs : le patch est muet (graphe invalide). Avertissements : le patch
 * joue, l'attribut fautif est ignoré.
 */
import { MODULES, STRUCTURE_TAGS, VOICE_SOURCES, WORKLET_TYPES, type ModuleKind, type ParamSpec } from "./modules";
import { toMidi } from "../../../shared/audio/notes";

export type PatchNode = {
  tag: string;
  attrs: Record<string, string>;
  children?: PatchNode[];
};

export type Scope = "voice" | "global";

export type CompiledModule = {
  name: string;
  type: string;
  kind: ModuleKind;
  scope: Scope;
  /** Index du sonic-voice (-1 hors voix). */
  voice: number;
  /** Entrées audio : noms de modules, ou `voices` (somme des voix) pour la chaîne globale. */
  inputs: string[];
  /** Niveaux d'entrée (mixer). */
  levels: number[];
  /** Valeurs statiques résolues (défauts compris). `voice.pitch` reste une chaîne. */
  params: Record<string, number | string | number[]>;
};

export type CompiledMod = {
  /** Nom du câble (`sonic-mod name`) : sa profondeur est alors pilotable (`sonic-param to="nom.amount"`). */
  name?: string;
  /** Nom de module, ou `voice.pitch|gate|vel|note|rand`. */
  from: string;
  module: string;
  param: string;
  amount: number;
  /** Modulation exponentielle : appliquée au `detune` (amount en demi-tons). */
  exp: boolean;
};

export type CompiledParam = {
  /** Nom du module, ou du `sonic-mod` nommé quand `param` vaut "amount". */
  module: string;
  param: string;
  /** Chemin DataProvider (notation pointée). */
  source: string | null;
  /** Nom exposé (attribut `params` du patch). */
  expose: string | null;
  value: number | null;
  rampS: number;
  min: number | null;
  max: number | null;
};

/** Un sonic-voice : graphe joué par note, éventuellement réservé à un nom ou une note. */
export type CompiledVoice = {
  /** Déclenché par `sample` (nom de pad) ; null = toutes. */
  sample: string | null;
  /** Déclenché par cette note MIDI ; null = toutes. */
  note: number | null;
  modules: CompiledModule[];
  out: string | null;
};

export type CompiledPatch = {
  voices: CompiledVoice[];
  /** Tous les modules de voix (toutes voix confondues). */
  voice: CompiledModule[];
  global: CompiledModule[];
  voiceOut: string | null;
  out: string;
  mods: CompiledMod[];
  params: CompiledParam[];
  /** Le patch utilise un processeur AudioWorklet (ladder, fold, karplus, osc sync). */
  needsWorklet: boolean;
  /** Samples demandés par des sonic-grain (URL ou chemin DP). */
  samples: string[];
  errors: string[];
  warnings: string[];
};

const COMMON_ATTRS = new Set(["name", "in", "class", "style", "id", "slot", "hidden"]);
const RESERVED = new Set(["voices", "master", "voice"]);

/** Modules dont le freq-hz accepte `curve="exp"` (modulation du detune, en cents). */
function isExpTarget(type: string): boolean {
  return type === "sonic-filter" || !!MODULES[type]?.params.detune?.audio;
}
function EXP_TYPES(): string[] {
  return Object.keys(MODULES).filter((t) => !!MODULES[t].params["freq-hz"]?.audio && isExpTarget(t));
}

function short(tag: string): string {
  return tag.replace(/^sonic-/, "");
}

function isRef(value: string): boolean {
  return /^[A-Za-z_][\w-]*(\.[a-z]+)?$/.test(value) && !/^-?\d/.test(value);
}

export function compilePatch(children: PatchNode[], opts: { out?: string } = {}): CompiledPatch {
  const errors: string[] = [];
  const warnings: string[] = [];
  const modules = new Map<string, CompiledModule>();
  const mods: CompiledMod[] = [];
  const params: CompiledParam[] = [];
  const pendingMods: { node: PatchNode; scope: Scope; where: string }[] = [];
  const pendingParams: { node: PatchNode; where: string }[] = [];
  const pendingRefs: { module: CompiledModule; param: string; ref: string; where: string }[] = [];

  const voiceNodes = children.filter((c) => c.tag === "sonic-voice");
  const hasInput = children.some((c) => c.tag === "sonic-audio-input");
  if (voiceNodes.length === 0 && !hasInput) {
    errors.push("un patch doit contenir un sonic-voice (les modules joués à chaque note) ou un sonic-audio-input (traitement d'une entrée)");
  }
  const voiceKeys = voiceNodes.map((v, i) => {
    const sample = (v.attrs.sample ?? "").trim() || null;
    const rawNote = (v.attrs.note ?? "").trim();
    const note = rawNote ? toMidi(rawNote) : null;
    if (rawNote && note === null) errors.push(`sonic-voice#${i + 1} : note "${rawNote}" invalide`);
    return { sample, note };
  });
  if (voiceNodes.length > 1 && voiceKeys.filter((k) => k.sample === null && k.note === null).length > 1) {
    errors.push("plusieurs sonic-voice : chacun doit avoir un sample ou une note (un seul peut rester générique)");
  }

  const lists: Record<Scope, CompiledModule[]> = { voice: [], global: [] };
  let currentVoice = -1;
  let counter = 0;

  const addModule = (node: PatchNode, scope: Scope, index: number): void => {
    const spec = MODULES[node.tag];
    const where = `${scope === "voice" ? "sonic-voice > " : ""}${node.tag}#${index + 1}`;
    const name = (node.attrs.name ?? "").trim() || `${short(node.tag)}${++counter}`;
    if (RESERVED.has(name) || name.startsWith("voice.")) {
      errors.push(`${where} : nom réservé "${name}"`);
      return;
    }
    if (modules.has(name)) {
      errors.push(`${where} : nom "${name}" déjà utilisé`);
      return;
    }
    if (node.tag === "sonic-audio-input" && scope === "voice") {
      errors.push(`${where} : sonic-audio-input se place hors de sonic-voice (entrée globale du patch)`);
      return;
    }
    const mod: CompiledModule = { name, type: node.tag, kind: spec.kind, scope, voice: scope === "voice" ? currentVoice : -1, inputs: [], levels: [], params: {} };
    for (const [p, ps] of Object.entries(spec.params)) {
      mod.params[p] = ps.list ? [] : ps.default;
    }
    for (const [attr, raw] of Object.entries(node.attrs)) {
      if (COMMON_ATTRS.has(attr)) continue;
      const ps = spec.params[attr];
      if (!ps) {
        warnings.push(`${name} : attribut "${attr}" inconnu pour ${node.tag} (ignoré)`);
        continue;
      }
      const value = parseParam(ps, String(raw), `${name}.${attr}`, warnings);
      if (value === undefined) {
        // Référence vers une source de modulation (gain="aenv", freq-hz="voice.pitch")
        const ref = String(raw).trim();
        if (ps.audio && isRef(ref)) {
          if (attr === "freq-hz" && ref === "voice.pitch") mod.params[attr] = "voice.pitch";
          else pendingRefs.push({ module: mod, param: attr, ref, where: `${name}.${attr}` });
        } else {
          warnings.push(`${name}.${attr} : valeur "${raw}" invalide (ignorée)`);
        }
        continue;
      }
      mod.params[attr] = value;
    }
    if (node.tag === "sonic-mixer") mod.levels = (mod.params.levels as number[]) ?? [];
    if (node.attrs.in !== undefined && spec.kind === "source") {
      warnings.push(`${name} : un ${node.tag} n'a pas d'entrée, "in" ignoré`);
    }
    modules.set(name, mod);
    lists[scope].push(mod);
    if (node.tag === "sonic-osc" && node.attrs.fm) {
      pendingMods.push({
        node: { tag: "sonic-mod", attrs: { from: node.attrs.fm, to: `${name}.freq-hz`, amount: String(mod.params["fm-amount"]) } },
        scope,
        where: `${name}.fm`,
      });
    }
  };

  const walk = (nodes: PatchNode[], scope: Scope) => {
    nodes.forEach((node, i) => {
      if (node.tag === "sonic-voice") {
        if (scope === "voice") errors.push("sonic-voice imbriqué");
        return;
      }
      if (node.tag === "sonic-mod") pendingMods.push({ node, scope, where: `sonic-mod#${i + 1}` });
      else if (node.tag === "sonic-param") pendingParams.push({ node, where: `sonic-param#${i + 1}` });
      else if (MODULES[node.tag]) addModule(node, scope, i);
      else errors.push(`balise ${node.tag} inconnue dans un patch (modules : ${Object.keys(MODULES).concat(STRUCTURE_TAGS).join(", ")})`);
    });
  };
  voiceNodes.forEach((v, i) => {
    currentVoice = i;
    walk(v.children ?? [], "voice");
  });
  currentVoice = -1;
  walk(children.filter((c) => c.tag !== "sonic-voice"), "global");

  // Entrées audio : `in` explicite ou chaîne implicite.
  const wire = (scope: Scope, nodes: PatchNode[], voiceIndex = -1) => {
    let prev: string | null = scope === "global" ? "voices" : null;
    let pending: string[] = scope === "global" ? ["voices"] : [];
    const scoped = lists[scope].filter((m) => m.voice === voiceIndex);
    const byName = new Map(scoped.map((m) => [m.name, m]));
    for (const node of nodes) {
      if (!MODULES[node.tag]) continue;
      const name = (node.attrs.name ?? "").trim();
      const mod = name ? byName.get(name) : scoped.find((m) => m.type === node.tag && !m.inputs.length && !(m as { _wired?: boolean })._wired);
      if (!mod) continue;
      (mod as { _wired?: boolean })._wired = true;
      if (mod.kind === "source") {
        prev = mod.name;
        pending.push(mod.name);
        continue;
      }
      if (mod.kind === "control") continue;
      const explicit = (node.attrs.in ?? "").trim();
      if (explicit) {
        for (const ref of explicit.split(/\s+/)) {
          if (ref === "voices") {
            if (scope === "voice") errors.push(`${mod.name}.in : "voices" n'existe qu'hors de sonic-voice`);
            else mod.inputs.push("voices");
            continue;
          }
          const src = modules.get(ref);
          if (!src) {
            errors.push(`${mod.name}.in : module "${ref}" inconnu`);
            continue;
          }
          if (scope === "voice" && src.scope === "global") {
            errors.push(`${mod.name}.in : un module de voix ne peut pas recevoir l'audio global "${ref}" (utiliser sonic-mod)`);
            continue;
          }
          if (scope === "voice" && src.voice !== voiceIndex) {
            errors.push(`${mod.name}.in : "${ref}" appartient à un autre sonic-voice`);
            continue;
          }
          if (scope === "global" && src.scope === "voice") {
            errors.push(`${mod.name}.in : "${ref}" est dans sonic-voice ; hors voix, utiliser "voices"`);
            continue;
          }
          mod.inputs.push(ref);
        }
        pending = pending.filter((p) => !mod.inputs.includes(p));
      } else if (mod.type === "sonic-mixer") {
        mod.inputs = [...pending];
        pending = [];
      } else if (prev) {
        mod.inputs = [prev];
        pending = pending.filter((p) => p !== prev);
      } else {
        errors.push(`${mod.name} : aucune entrée (ajouter "in" ou placer une source avant)`);
      }
      prev = mod.name;
      pending.push(mod.name);
    }
    for (const m of lists[scope]) delete (m as { _wired?: boolean })._wired;
  };
  voiceNodes.forEach((v, i) => wire("voice", v.children ?? [], i));
  wire("global", children.filter((c) => c.tag !== "sonic-voice"));

  // Sorties.
  const audioOf = (scope: Scope) => lists[scope].filter((m) => m.kind !== "control");
  const voices: CompiledVoice[] = voiceNodes.map((v, i) => {
    const own = lists.voice.filter((m) => m.voice === i);
    let out: string | null = null;
    const explicit = (v.attrs.out ?? "").trim();
    if (explicit) {
      const m = modules.get(explicit);
      if (!m || m.voice !== i) errors.push(`sonic-voice.out : module "${explicit}" absent de ce sonic-voice`);
      else out = explicit;
    } else {
      out = own.filter((m) => m.kind !== "control").slice(-1)[0]?.name ?? null;
      if (!out) errors.push("sonic-voice : aucun module audio (ajouter au moins un sonic-osc ou sonic-noise)");
    }
    return { ...voiceKeys[i], modules: own, out };
  });
  const voiceOut = voices[0]?.out ?? null;
  let out = "voices";
  if (opts.out) {
    const m = modules.get(opts.out);
    if (opts.out !== "voices" && (!m || m.scope !== "global")) errors.push(`out : module global "${opts.out}" inconnu`);
    else out = opts.out;
  } else {
    out = audioOf("global").slice(-1)[0]?.name ?? "voices";
  }

  // Synchro dure : maître = autre sonic-osc de la même portée.
  for (const m of modules.values()) {
    if (m.type !== "sonic-osc" || !m.params.sync) continue;
    const ref = String(m.params.sync).trim();
    const master = modules.get(ref);
    if (!master || master.type !== "sonic-osc") errors.push(`${m.name}.sync : "${ref}" n'est pas un sonic-osc du patch`);
    else if (master === m) errors.push(`${m.name}.sync : un oscillateur ne peut pas se synchroniser sur lui-même`);
    else if (master.scope !== m.scope || master.voice !== m.voice) errors.push(`${m.name}.sync : "${ref}" doit être dans la même portée (même sonic-voice)`);
  }
  const all = [...modules.values()];
  const needsWorklet = all.some((m) => WORKLET_TYPES.includes(m.type) || (m.type === "sonic-osc" && !!m.params.sync));
  const samples = [...new Set(all.filter((m) => m.type === "sonic-grain").map((m) => String(m.params.sample ?? "").trim()))];
  for (const m of all) if (m.type === "sonic-grain" && !String(m.params.sample ?? "").trim()) errors.push(`${m.name} : sample requis (URL ou chemin DP d'une prise)`);

  // Modulations.
  const checkTarget = (to: string, where: string, needAudio: boolean): { module: CompiledModule; param: string } | null => {
    const dot = to.lastIndexOf(".");
    if (dot <= 0) {
      errors.push(`${where} : cible "${to}" attendue au format module.paramètre`);
      return null;
    }
    const module = modules.get(to.slice(0, dot));
    const param = to.slice(dot + 1);
    if (!module) {
      errors.push(`${where} : module "${to.slice(0, dot)}" inconnu`);
      return null;
    }
    const ps = MODULES[module.type].params[param];
    if (!ps) {
      errors.push(`${where} : ${module.type} n'a pas de paramètre "${param}"`);
      return null;
    }
    if (needAudio && !ps.audio) {
      errors.push(`${where} : ${module.name}.${param} n'est pas modulable (modulables : ${Object.entries(MODULES[module.type].params).filter(([, p]) => p.audio).map(([k]) => k).join(", ") || "aucun"})`);
      return null;
    }
    return { module, param };
  };
  const addMod = (from: string, to: string, amount: number, exp: boolean, where: string, name: string | null = null) => {
    const target = checkTarget(to, where, true);
    if (!target) return;
    if (from.startsWith("voice.")) {
      if (!VOICE_SOURCES.includes(from)) {
        errors.push(`${where} : source "${from}" inconnue (${VOICE_SOURCES.join(", ")})`);
        return;
      }
      if (target.module.scope !== "voice") {
        errors.push(`${where} : "${from}" n'existe que pour un module de sonic-voice`);
        return;
      }
    } else {
      const src = modules.get(from);
      if (!src) {
        errors.push(`${where} : source "${from}" inconnue`);
        return;
      }
      if (src.scope === "voice" && target.module.scope === "voice" && src.voice !== target.module.voice) {
        errors.push(`${where} : "${from}" et ${target.module.name} sont dans deux sonic-voice différents`);
        return;
      }
      if (src.scope === "voice" && target.module.scope === "global") {
        errors.push(`${where} : un module de voix ("${from}") ne peut pas moduler un module global`);
        return;
      }
    }
    // exp : appliqué au `detune` (cents) du module : sonic-filter (detune natif, non déclaré dans MODULES)
    // et tout module dont freq-hz ET detune sont modulables (osc, ladder, karplus, resonator).
    if (exp && !(target.param === "freq-hz" && isExpTarget(target.module.type))) {
      errors.push(`${where} : curve="exp" seulement vers freq-hz de ${EXP_TYPES().join(", ")}`);
      return;
    }
    mods.push({ ...(name ? { name } : {}), from, module: target.module.name, param: exp ? "detune" : target.param, amount, exp });
  };
  const modNames = new Set<string>();
  for (const { module, param, ref, where } of pendingRefs) {
    module.params[param] = 0;
    addMod(ref, `${module.name}.${param}`, 1, false, where);
  }
  for (const { node, where } of pendingMods) {
    const from = (node.attrs.from ?? "").trim();
    const to = (node.attrs.to ?? "").trim();
    const amount = Number(node.attrs.amount ?? 1);
    if (!from || !to) {
      errors.push(`${where} : "from" et "to" requis`);
      continue;
    }
    if (!Number.isFinite(amount)) {
      errors.push(`${where} : amount numérique attendu`);
      continue;
    }
    const exp = (node.attrs.curve ?? "").trim() === "exp";
    const modName = (node.attrs.name ?? "").trim() || null;
    if (modName) {
      if (RESERVED.has(modName) || modName.startsWith("voice.") || modName.includes(".")) {
        errors.push(`${where} : nom de câble invalide "${modName}"`);
        continue;
      }
      if (modules.has(modName) || modNames.has(modName)) {
        errors.push(`${where} : nom "${modName}" déjà utilisé (module ou autre sonic-mod)`);
        continue;
      }
      modNames.add(modName);
    }
    // en exp, amount en demi-tons appliqué au detune (cents)
    addMod(from, to, exp ? amount * 100 : amount, exp, where, modName);
  }

  // Paramètres pilotés.
  for (const { node, where } of pendingParams) {
    const to = (node.attrs.to ?? "").trim();
    // Profondeur d'un câble nommé : `sonic-param to="nom.amount"`.
    const dot = to.lastIndexOf(".");
    const modTarget = dot > 0 && modNames.has(to.slice(0, dot)) ? to.slice(0, dot) : null;
    if (modTarget !== null && to.slice(dot + 1) !== "amount") {
      errors.push(`${where} : un sonic-mod n'a que le paramètre "amount" (${to})`);
      continue;
    }
    const target = modTarget !== null ? { module: { name: modTarget }, param: "amount" } : checkTarget(to, where, false);
    if (!target) continue;
    const n = (v: string | undefined) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    const source = (node.attrs.source ?? "").trim() || null;
    const expose = (node.attrs.expose ?? "").trim() || null;
    if (!source && !expose && n(node.attrs.value) === null) {
      warnings.push(`${where} : ni source, ni expose, ni value : sans effet`);
    }
    params.push({
      module: target.module.name,
      param: target.param,
      source,
      expose,
      value: n(node.attrs.value),
      rampS: Math.max(0, n(node.attrs["ramp-s"]) ?? 0.02),
      min: n(node.attrs.min),
      max: n(node.attrs.max),
    });
  }

  // Rétroactions : tout cycle audio doit passer par un sonic-delay.
  for (const scope of ["voice", "global"] as const) {
    const graph = new Map(lists[scope].filter((m) => m.type !== "sonic-delay").map((m) => [m.name, m.inputs.filter((i) => i !== "voices")]));
    const state = new Map<string, number>();
    const visit = (n: string, path: string[]): boolean => {
      if (!graph.has(n)) return false;
      if (state.get(n) === 1) {
        errors.push(`boucle audio sans sonic-delay : ${[...path.slice(path.indexOf(n)), n].join(" → ")}`);
        return true;
      }
      if (state.get(n) === 2) return false;
      state.set(n, 1);
      for (const i of graph.get(n)!) if (visit(i, [...path, n])) return true;
      state.set(n, 2);
      return false;
    };
    for (const n of graph.keys()) if (visit(n, [])) break;
  }

  return { voices, voice: lists.voice, global: lists.global, voiceOut, out, mods, params, needsWorklet, samples: samples.filter(Boolean), errors, warnings };
}

function parseParam(ps: ParamSpec, raw: string, where: string, warnings: string[]): number | string | number[] | undefined {
  const value = raw.trim();
  if (ps.values) {
    if (ps.values.includes(value)) return value;
    warnings.push(`${where} : "${value}" inconnu (${ps.values.join(", ")})`);
    return ps.default;
  }
  if (ps.list) {
    const items = value.split(/[\s,]+/).filter(Boolean).map(Number);
    if (items.some((x) => !Number.isFinite(x))) return undefined;
    return items.slice(0, 64);
  }
  if (typeof ps.default === "string" && !ps.audio && !ps.tempo) return value; // fm, sync
  if (ps.tempo && /^\d+\/\d+$/.test(value)) return value;
  if (value === "" || !Number.isFinite(Number(value))) return undefined;
  let n = Number(value);
  if (ps.min !== undefined && n < ps.min) n = ps.min;
  if (ps.max !== undefined && n > ps.max) n = ps.max;
  return n;
}

/** Convertit un élément DOM (et ses enfants) en arbre de patch. */
export function domToPatchNodes(parent: Element): PatchNode[] {
  return [...parent.children].map((el) => ({
    tag: el.tagName.toLowerCase(),
    attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
    children: domToPatchNodes(el),
  }));
}
