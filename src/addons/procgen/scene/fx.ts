/**
 * Particules d'une scène procgen (CPU, sans DOM) : météo, fumées de cheminée, feux de camp, embruns de cascade,
 * brume, poussière, effets attachés aux objets d'un calque et systèmes libres.
 *
 * Réutilise le moteur du format monde (shared/sim/particles : préréglages, lecture bornée, tampon circulaire des
 * naissances, mouvement en forme close) ; ce module ne fait que dire **où** naissent les grains : ancres des objets
 * composés (`chimney.N` d'un bâtiment, `light` d'un feu de camp, `fall` d'une cascade…), boîte qui suit la vue
 * (météo), boîte de la scène (brume) ou point. Les ancres sont relues à chaque image : un objet glissé garde sa fumée.
 *
 * Budget : un plafond de grains pour toute la scène (8000 en qualité haute, 4000 en `auto` sur mobile ou `low`,
 * 1500 en rendu vectoriel) ; au-delà, les débits et les tampons de chaque système sont réduits d'autant.
 */
import { Issues } from "../core/schema";
import { PARTICLE_LIMITS, PARTICLE_PRESETS, ParticleSystem, readFx, readParticles, type ParticleSpec, type V3 } from "../../../shared/sim/particles";
import type { ObjectInfo, SceneModel } from "./compose";

/** Noms anglais (recette procgen) → préréglages du format monde ; les noms français sont acceptés tels quels. */
export const FX_ALIASES: Record<string, string> = {
  fire: "feu", smoke: "fumee", embers: "braise", sparks: "etincelles", glow: "lueur", flash: "eclair", magic: "magie", steam: "vapeur", mist: "brume", fog: "brume",
  dust: "poussiere", splash: "eclaboussure", drops: "gouttes", bubbles: "bulles", rain: "pluie", snow: "neige", confetti: "confettis", debris: "debris", shards: "eclats", leaves: "feuilles",
  spray: "embruns", petals: "petales", motes: "poussieres",
};

/** Préréglages propres aux scènes (par-dessus ceux du format monde). */
const EXTRA: Record<string, Record<string, unknown>> = {
  embruns: { preset: "vapeur", rate: 16, life: [1, 2.2], speed: [0.5, 1.2], spread: 70, rise: 0.25, drag: 1.2, turbulence: 0.4, size: [0.18, 0.9], color: ["#ffffff", "#d8ecf6"], opacity: [0.5, 0], shape: "box", extent: [0.4, 0.05, 0.15] },
  petales: { preset: "feuilles", color: ["#fbcfe8", "#f9a8d4", "#fff1f2"], size: [0.06, 0.06], gravity: 0.35 },
  poussieres: { preset: "brume", rate: 10, life: [5, 9], speed: [0.05, 0.2], size: [0.035, 0.035], color: ["#fff4d6"], opacity: [0, 0.7], sprite: "disque", blend: "add", turbulence: 0.5, wind: 0.5, extent: [8, 1.2, 8], offset: [0, 1.4, 0] },
};

const WEATHER = ["rain", "snow", "leaves", "petals", "none"] as const;
type WeatherKind = (typeof WEATHER)[number];
const WEATHER_FR: Record<string, WeatherKind> = { pluie: "rain", neige: "snow", feuilles: "leaves", petales: "petals", aucune: "none" };
const WEATHER_PRESET: Record<Exclude<WeatherKind, "none">, string> = { rain: "pluie", snow: "neige", leaves: "feuilles", petals: "petales" };
/** Naissances par m² et par seconde à intensité 1. */
const WEATHER_DENSITY: Record<Exclude<WeatherKind, "none">, number> = { rain: 2.6, snow: 0.7, leaves: 0.05, petals: 0.06 };

export type FxQuality = "auto" | "low" | "high";

/** Entrées lues dans la recette (et `weather` du DataProvider, prioritaire). */
export type FxInput = {
  weather?: unknown;
  fx?: unknown;
  particles?: unknown;
  wind?: unknown;
  windDir?: unknown;
  layers?: { id?: unknown; fx?: unknown }[];
  /** Effets liés aux états (`scene/states.ts` : états libres, `stateFx`), déjà rapportés aux objets. */
  states?: { id: string; raw: Record<string, unknown>; list: { id: string; anchor: string; dy: number }[]; weight: number }[];
};

type AnchorSrc = { id: string; anchor: string; dy: number };
type Source =
  | { kind: "anchors"; list: AnchorSrc[] }
  | { kind: "view" }
  | { kind: "area" }
  | { kind: "point"; at: V3; obj?: AnchorSrc };

export type FxSystem = { id: string; sys: ParticleSystem; src: Source; key: string; nSrc: number; acc: number; rr: number; /** Météo : surface (m²) pour laquelle le débit est donné. */ area: number };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const presetName = (p: unknown) => (typeof p === "string" ? FX_ALIASES[p] ?? p : "");

/** Réglages d'un effet : `"smoke"`, `0.5` (intensité), `true`, ou objet `{preset, intensity, …réglages}`. */
function effect(v: unknown, def: string): { raw: Record<string, unknown>; intensity: number } | null {
  if (v === undefined || v === false || v === null || v === 0) return null;
  if (v === true) return { raw: { preset: def }, intensity: 1 };
  if (fin(v)) return { raw: { preset: def }, intensity: clamp(v, 0, 3) };
  if (typeof v === "string") return { raw: { preset: presetName(v) || def }, intensity: 1 };
  if (!isObj(v)) return null;
  const { intensity, anchor, ...rest } = v;
  void anchor;
  return { raw: { ...rest, preset: presetName(rest.preset) || def }, intensity: fin(intensity) ? clamp(intensity, 0, 3) : 1 };
}

/** Développe les préréglages propres aux scènes en réglages du format monde. */
function expand(raw: Record<string, unknown>): Record<string, unknown> {
  const p = String(raw.preset ?? "");
  if (EXTRA[p]) {
    const { preset: _p, ...own } = raw;
    void _p;
    return { ...EXTRA[p], ...own };
  }
  return raw;
}

function lifeMax(raw: Record<string, unknown>): number {
  const pre = PARTICLE_PRESETS[String(raw.preset ?? "")];
  const l = raw.life ?? pre?.life ?? [1, 1.5];
  return Array.isArray(l) ? Number(l[1] ?? l[0]) || 1.5 : fin(l) ? l : 1.5;
}
function rateOf(raw: Record<string, unknown>): number {
  if (fin(raw.rate)) return raw.rate;
  return PARTICLE_PRESETS[String(raw.preset ?? "")]?.rate ?? 0;
}

/** Ancres d'un objet : nom exact, préfixe (`chimney` → `chimney.0`, `chimney.1`…), sinon `null`. */
export function anchorNames(o: ObjectInfo, name: string): string[] {
  if (o.anchors[name]) return [name];
  const pre = name.endsWith(".*") ? name.slice(0, -2) : name;
  return Object.keys(o.anchors).filter((k) => k.startsWith(pre + ".") && /^\d+$/.test(k.slice(pre.length + 1)));
}

/** Point d'une ancre (ou haut de l'objet pour `top` absent). */
export function anchorPoint(o: ObjectInfo, anchor: string): V3 {
  const a = o.anchors[anchor];
  if (a) return a;
  return [o.pos[0], o.pos[1] + o.height, o.pos[2]];
}

type Plan = { id: string; raw: Record<string, unknown>; src: Source; nSrc: number; weight: number };

/** Lecture des clés de recette : liste des systèmes à créer (sans tampon), problèmes signalés. */
export function planFx(input: FxInput, model: Pick<SceneModel, "objects" | "size">, issues: Issues): Plan[] {
  const plans: Plan[] = [];
  const objects = model.objects;
  const anchorsOf = (pred: (o: ObjectInfo) => boolean, anchor: string, dy = 0): AnchorSrc[] => {
    const out: AnchorSrc[] = [];
    for (const o of objects) if (pred(o)) for (const a of anchor === "top" && !o.anchors.top ? ["top"] : anchorNames(o, anchor)) out.push({ id: o.id, anchor: a, dy });
    return out;
  };
  // ---- météo
  let w = input.weather;
  if (typeof w === "string") w = { kind: w };
  if (w !== undefined && w !== null && w !== false) {
    if (!isObj(w)) issues.add({ path: "weather", code: "type", message: "chaîne (rain, snow, leaves, petals, none) ou {kind, intensity} attendue" });
    else {
      const k0 = String(w.kind ?? "rain");
      const kind = (WEATHER as readonly string[]).includes(k0) ? (k0 as WeatherKind) : WEATHER_FR[k0];
      if (!kind) issues.add({ path: "weather.kind", code: "unknown", message: `météo inconnue « ${k0} »`, hint: WEATHER.join(", ") });
      else if (kind !== "none") {
        const intensity = fin(w.intensity) ? clamp(w.intensity, 0, 1) : 0.5;
        if (intensity > 0) {
          const raw: Record<string, unknown> = { preset: WEATHER_PRESET[kind], ...(kind === "rain" ? { opacity: [0.8, 0.8], stretch: 0.08 } : {}) };
          for (const key of ["color", "size", "opacity", "speed", "life", "sprite", "wind"]) if (w[key] !== undefined) raw[key] = w[key];
          plans.push({ id: "weather", raw, src: { kind: "view" }, nSrc: 1, weight: intensity * WEATHER_DENSITY[kind] });
        }
      }
    }
  }
  const fx = input.fx;
  if (fx !== undefined && !isObj(fx)) issues.add({ path: "fx", code: "type", message: "objet {chimneys, campfires, cascades, mist, dust, quality} attendu" });
  const f = isObj(fx) ? fx : {};
  const known = new Set(["chimneys", "campfires", "cascades", "mist", "dust", "motes", "quality", "max"]);
  for (const k of Object.keys(f)) if (!known.has(k)) issues.add({ path: `fx.${k}`, code: "unknown", message: `effet de scène inconnu « ${k} »`, hint: [...known].join(", ") });
  // ---- cheminées
  const ch = effect(f.chimneys, "fumee");
  if (ch) {
    const layers = isObj(f.chimneys) && Array.isArray(f.chimneys.layers) ? new Set(f.chimneys.layers.map(String)) : null;
    const list = anchorsOf((o) => o.generator === "building" && (!layers || layers.has(o.layer)), "chimney", 0.05);
    if (list.length) plans.push({ id: "chimneys", raw: { rate: 5, life: [3, 5.5], speed: [0.35, 0.6], size: [0.3, 1.8], opacity: [0.75, 0], color: ["#55514d", "#b3aea8"], ...ch.raw }, src: { kind: "anchors", list }, nSrc: list.length, weight: ch.intensity });
    else issues.add({ path: "fx.chimneys", code: "info", message: "aucun bâtiment à cheminée dans la scène (paramètre `chimneys` des bâtiments)" });
  }
  // ---- feux de camp : flammes, braises, fumée ; étincelles sur ordre (`fx.campfires-sparks`)
  const cf = effect(f.campfires, "feu");
  if (cf) {
    const list = anchorsOf((o) => o.generator === "prop" && o.params.kind === "campfire", "light", -0.38);
    if (list.length) {
      const { preset: _p, ...tune } = cf.raw;
      void _p;
      plans.push({ id: "campfires-fire", raw: { preset: "feu", rate: 34, size: [0.4, 0.06], extent: [0.16, 0.05, 0.16], ...tune }, src: { kind: "anchors", list }, nSrc: list.length, weight: cf.intensity });
      plans.push({ id: "campfires-embers", raw: { preset: "braise", rate: 5, extent: [0.2, 0.05, 0.2], shape: "sphere" }, src: { kind: "anchors", list }, nSrc: list.length, weight: cf.intensity });
      plans.push({ id: "campfires-smoke", raw: { preset: "fumee", rate: 4, life: [2.5, 4], size: [0.25, 1.3], opacity: [0.28, 0], offset: [0, 0.45, 0], color: ["#4a4a4a", "#9a9a9a"] }, src: { kind: "anchors", list }, nSrc: list.length, weight: cf.intensity });
      plans.push({ id: "campfires-sparks", raw: { preset: "etincelles", rate: 0, burst: 24, speed: [1.5, 4], gravity: 3, max: 120 }, src: { kind: "anchors", list }, nSrc: list.length, weight: 0 });
    } else issues.add({ path: "fx.campfires", code: "info", message: "aucun feu de camp (prop.campfire) dans la scène" });
  }
  // ---- cascades : embruns et gouttes au pied des lames d'eau
  const ca = effect(f.cascades, "embruns");
  if (ca) {
    const list = anchorsOf((o) => o.generator === "water" && o.params.kind === "cascade", "fall");
    if (list.length) {
      plans.push({ id: "cascades", raw: ca.raw, src: { kind: "anchors", list }, nSrc: list.length, weight: ca.intensity });
      plans.push({ id: "cascades-drops", raw: { preset: "gouttes", rate: 14, speed: [0.8, 1.8], spread: 55, size: [0.035, 0.03], color: ["#e0f4ff"], extent: [0.35, 0.02, 0.1], shape: "box" }, src: { kind: "anchors", list }, nSrc: list.length, weight: ca.intensity });
    } else issues.add({ path: "fx.cascades", code: "info", message: "aucune cascade (water.cascade) dans la scène" });
  }
  // ---- brume au sol et poussière en suspension sur toute la scène
  const area = Math.max(1, model.size[0] * model.size[1]);
  const mi = effect(f.mist, "brume");
  if (mi) plans.push({ id: "mist", raw: { extent: [model.size[0] / 2, 0.3, model.size[1] / 2], offset: [0, 0.4, 0], size: [3, 6.5], opacity: [0.16, 0], ...mi.raw }, src: { kind: "area" }, nSrc: 1, weight: (mi.intensity * area) / 144 });
  const du = effect(f.dust ?? f.motes, "poussieres");
  if (du) plans.push({ id: "dust", raw: du.raw, src: { kind: "view" }, nSrc: 1, weight: du.intensity * 0.015 });
  // ---- effets attachés aux objets d'un calque
  (input.layers ?? []).forEach((L, li) => {
    if (L.fx === undefined) return;
    const lid = String(L.id ?? `layer${li}`);
    const list = Array.isArray(L.fx) ? L.fx.slice(0, 3) : [L.fx];
    list.forEach((e, k) => {
      const ef = effect(e, "fumee");
      const path = `layers[${li}].fx${Array.isArray(L.fx) ? `[${k}]` : ""}`;
      if (!ef) {
        issues.add({ path, code: "type", message: "nom d'effet (smoke, fire, embers, steam, spray, leaves…) ou {preset, anchor, …} attendu" });
        return;
      }
      const anchor = isObj(e) && typeof e.anchor === "string" ? e.anchor : ef.raw.preset === "fumee" ? "chimney" : "top";
      let srcs = anchorsOf((o) => o.layer === lid, anchor);
      // ancre absente : haut de l'objet (une fumée sans cheminée sort du toit)
      if (!srcs.length) srcs = anchorsOf((o) => o.layer === lid, "top");
      if (!srcs.length) return;
      const id = `${lid.replace(/[^\w-]/g, "_")}-fx${k ? k + 1 : ""}`.replace(/^([^A-Za-z])/, "L$1");
      // préréglages de météo posés sur un objet (feuilles d'un arbre) : boîte de la couronne, pas du ciel
      const weatherLike = ["feuilles", "petales", "neige", "pluie"].includes(String(ef.raw.preset));
      const raw = weatherLike ? { rate: 2.5, offset: [0, -1.2, 0], extent: [1.6, 0.8, 1.6], ...ef.raw } : ef.raw;
      plans.push({ id, raw, src: { kind: "anchors", list: srcs }, nSrc: srcs.length, weight: ef.intensity });
    });
  });
  // ---- effets liés aux états des objets (feu, vapeur d'une marmite ouverte…)
  for (const st of input.states ?? []) {
    const list = st.list.filter((a) => objects.some((o) => o.id === a.id));
    if (!list.length) continue;
    plans.push({ id: st.id, raw: { ...st.raw, preset: presetName(st.raw.preset) || st.raw.preset }, src: { kind: "anchors", list }, nSrc: list.length, weight: Math.max(0, Math.min(3, st.weight)) });
  }
  // ---- systèmes libres (mêmes réglages que `particles` du format monde) ; `at` : point ou "objet@ancre"
  if (input.particles !== undefined) {
    if (!isObj(input.particles)) issues.add({ path: "particles", code: "type", message: "objet {id: {preset, at, …}} attendu" });
    else
      for (const [id, v] of Object.entries(input.particles)) {
        if (!isObj(v)) continue;
        const { at, from, ...rest } = v;
        const ref = typeof at === "string" ? at : typeof from === "string" ? from : "";
        let src: Source = { kind: "point", at: Array.isArray(at) ? [Number(at[0]) || 0, Number(at[1]) || 0, Number(at[2]) || 0] : [0, 0, 0] };
        if (ref) {
          const [oid, an = "top"] = ref.split("@");
          const o = objects.find((ob) => ob.id === oid);
          if (!o) issues.add({ path: `particles.${id}.at`, code: "unknown", message: `objet « ${oid} » introuvable` });
          else src = { kind: "point", at: [0, 0, 0], obj: { id: oid, anchor: an, dy: 0 } };
        }
        plans.push({ id, raw: { ...rest, preset: presetName(rest.preset) || rest.preset }, src, nSrc: 1, weight: 1 });
      }
  }
  return plans;
}

/** Vent des particules (m/s) : `wind` de la recette (force, 1 par défaut) et `windDir` (°, 0 = vers +z). */
export function ventOf(wind: unknown, dir: unknown): V3 {
  const k = fin(wind) ? clamp(wind, 0, 5) : 1;
  const a = ((fin(dir) ? dir : 67) * Math.PI) / 180;
  return [Math.sin(a) * k * 1.4, 0, Math.cos(a) * k * 1.4];
}

export type FxContext = {
  /** Point visé par la vue et demi-largeur visible (m) : la météo naît au-dessus. */
  target: V3;
  extent: number;
  hidden?: ReadonlySet<string>;
};

/**
 * Systèmes d'une scène. `configure` relit les clés (un système dont les réglages et les sources n'ont pas changé
 * garde son tampon : la fumée continue) ; `step` fait naître les grains ; le rendu dessine `systems`.
 */
export class SceneFx {
  systems: FxSystem[] = [];
  vent: V3 = [0, 0, 0];
  floorY = 0;
  now = 0;
  budget = 0;
  private model: SceneModel | null = null;
  private byObj = new Map<string, ObjectInfo>();
  private orders = new Map<string, number>();
  private size: [number, number] = [1, 1];

  get active(): boolean {
    for (const s of this.systems) if (s.sys.alive(this.now)) return true;
    return false;
  }

  /** Grains au plus (somme des tampons). */
  get grains(): number {
    return this.systems.reduce((s, x) => s + x.sys.spec.max, 0);
  }

  /** Relit les clés ; vrai si la liste des systèmes a changé (le rendu refait ses maillages). */
  configure(input: FxInput, model: SceneModel, opts: { quality?: unknown; mobile?: boolean; vector?: boolean }, issues: Issues): boolean {
    this.model = model;
    this.size = model.size;
    this.byObj = new Map(model.objects.map((o) => [o.id, o]));
    this.vent = ventOf(input.wind, input.windDir);
    const water = model.terrain?.spec.water;
    this.floorY = model.terrain ? Math.max(model.bounds.min[1] + 0.9, typeof water === "number" ? water : -Infinity) : 0;
    const fxIn = isObj(input.fx) ? input.fx : {};
    const q0 = String(fxIn.quality ?? opts.quality ?? "auto");
    const q: FxQuality = q0 === "low" || q0 === "high" ? q0 : "auto";
    let budget = opts.vector ? 1500 : q === "high" ? 8000 : q === "low" || opts.mobile ? 4000 : 8000;
    if (fin(fxIn.max)) budget = clamp(Math.round(fxIn.max), 0, PARTICLE_LIMITS.total);
    this.budget = budget;
    const plans = planFx(input, model, issues).slice(0, PARTICLE_LIMITS.systems);
    // débit total voulu par système, puis tampon = débit × durée de vie ; réduit pour tenir dans le budget
    const area = this.viewArea();
    const want = plans.map((p) => {
      const raw = expand(p.raw);
      const rate = p.src.kind === "view" ? p.weight * area : p.src.kind === "area" ? rateOf(raw) * p.weight : rateOf(raw) * p.weight;
      const perSrc = rate;
      const total = perSrc * (p.src.kind === "anchors" ? p.nSrc : 1);
      const burst = fin(raw.burst) ? raw.burst : PARTICLE_PRESETS[String(raw.preset ?? "")]?.burst ?? 0;
      const max = fin(raw.max) && !(p.src.kind === "view") ? raw.max : Math.max(burst ? burst * 2 : 0, Math.ceil(total * lifeMax(raw) * 1.15) + 4);
      return { p, raw, rate: perSrc, max };
    });
    const sum = want.reduce((s, w) => s + w.max, 0);
    const k = sum > budget ? budget / sum : 1;
    const raws: Record<string, unknown> = {};
    for (const w of want) {
      const max = Math.max(1, Math.floor(w.max * k));
      raws[w.p.id] = { ...w.raw, max: Math.min(max, PARTICLE_LIMITS.maxPerSystem), rate: w.rate * k };
    }
    const iss: { path: string; message: string }[] = [];
    const specs = readParticles(raws, 1, iss);
    for (const i of iss) issues.add({ path: i.path.startsWith("particles.") ? i.path : `fx.${i.path}`, code: "clamped", message: i.message });
    if (k < 1) issues.add({ path: "fx", code: "limit", message: `particules réduites à ${Math.round(k * 100)} % (budget de ${budget} grains${opts.mobile ? ", mobile" : ""})` });
    const old = new Map(this.systems.map((s) => [s.id, s]));
    const next: FxSystem[] = [];
    let changed = specs.length !== this.systems.length;
    specs.forEach((spec) => {
      const w = want.find((x) => x.p.id === spec.id)!;
      // naissances continues : le débit lu (par source) est appliqué par `step`, pas par le système
      const key = JSON.stringify([spec, w.p.src]);
      const o = old.get(spec.id);
      if (o && o.key === key && o.sys.spec.max === spec.max) {
        o.src = w.p.src;
        next.push(o);
        return;
      }
      changed = true;
      next.push({ id: spec.id, sys: new ParticleSystem(spec), src: w.p.src, key, nSrc: w.p.nSrc, acc: 0, rr: 0, area });
    });
    if (!changed) changed = next.some((s, i) => s !== this.systems[i]);
    this.systems = next;
    for (const id of [...this.orders.keys()]) if (!next.some((s) => s.id === id)) this.orders.delete(id);
    return changed;
  }

  /** Surface couverte par la météo (m²) : la scène, bornée. */
  private viewArea(): number {
    const e = this.weatherExtent(Math.max(this.size[0], this.size[1]) / 2);
    return 4 * e[0] * e[1];
  }
  private weatherExtent(viewHalf: number): [number, number] {
    const h = clamp(viewHalf, 6, 40);
    return [Math.min(h, this.size[0] / 2 + 4), Math.min(h, this.size[1] / 2 + 4)];
  }

  /** Position courante d'un acteur (pieds) : ses effets le suivent ; posée par le rendu. */
  actorPos: ((id: string) => V3 | null) | null = null;

  private anchorAt(a: AnchorSrc, hidden?: ReadonlySet<string>): V3 | null {
    const o = this.byObj.get(a.id);
    if (!o || hidden?.has(o.id)) return null;
    if (o.mode === "actor" && this.actorPos) {
      const p = this.actorPos(o.id);
      if (p) return [p[0], p[1] + (a.anchor === "top" ? o.height * 0.9 : o.height * 0.5) + a.dy, p[2]];
    }
    const p = anchorPoint(o, a.anchor);
    return [p[0], p[1] + a.dy, p[2]];
  }

  /** Points de naissance d'un système à cet instant. */
  sources(s: FxSystem, ctx: FxContext): V3[] {
    const src = s.src;
    if (src.kind === "anchors") {
      const out: V3[] = [];
      for (const a of src.list) {
        const p = this.anchorAt(a, ctx.hidden);
        if (p) out.push(p);
      }
      return out;
    }
    if (src.kind === "point") {
      if (src.obj) {
        const p = this.anchorAt(src.obj, ctx.hidden);
        return p ? [p] : [];
      }
      return [src.at];
    }
    if (src.kind === "area") return [[0, this.floorY > -50 ? Math.max(0, this.floorY) : 0, 0]];
    // météo : au-dessus du point visé, boîte bornée à la scène
    const [ex, ez] = this.weatherExtent(ctx.extent);
    const cx = clamp(ctx.target[0], -this.size[0] / 2 + ex - 4, this.size[0] / 2 - ex + 4);
    const cz = clamp(ctx.target[2], -this.size[1] / 2 + ez - 4, this.size[1] / 2 - ez + 4);
    return [[cx, Math.max(0, ctx.target[1]), cz]];
  }

  /** Sources décalées de `offset` (repère de la scène). */
  private points(s: FxSystem, ctx: FxContext): V3[] {
    const [ox, oy, oz] = s.sys.spec.offset;
    const pts = this.sources(s, ctx);
    return ox || oy || oz ? pts.map((p) => [p[0] + ox, p[1] + oy, p[2] + oz] as V3) : pts;
  }

  /** Systèmes servant de traînée à un émetteur (`trail`) : pas de naissance continue à leur propre source. */
  trailed = new Set<string>();

  /** Traînée : chaque copie d'un émetteur sème `rate` grains par seconde (30 sans débit) là où elle passe. */
  trail(id: string, em: { n: number; px: Float32Array; py: Float32Array; pz: Float32Array; vx: Float32Array; vy: Float32Array; vz: Float32Array; heading(i: number): number }, dt: number) {
    const s = this.systems.find((x) => x.id === id);
    if (!s || !em.n) return;
    const per = (s.sys.spec.rate > 0 ? s.sys.spec.rate : 30) * dt;
    for (let i = 0; i < em.n; i++) {
      let k = Math.floor(per);
      if (Math.random() < per - k) k++;
      if (k > 0) s.sys.spawn(k, this.now, [em.px[i], em.py[i], em.pz[i]], em.heading(i), 1, 0, [em.vx[i] * 0.2, em.vy[i] * 0.2, em.vz[i] * 0.2]);
    }
  }

  /** Salve d'un système au point d'impact d'un projectile (`burst` de l'émetteur). */
  impact(id: string, at: V3): boolean {
    const s = this.systems.find((x) => x.id === id);
    if (!s) return false;
    s.sys.burstAt(this.now, at);
    return true;
  }

  /** Avance l'horloge et fait naître les grains continus. */
  step(dt: number, ctx: FxContext) {
    this.now += dt;
    for (const s of this.systems) {
      const spec = s.sys.spec;
      if (spec.rate <= 0 || this.trailed.has(s.id)) continue;
      const pts = this.points(s, ctx);
      if (!pts.length) continue;
      let rate = spec.rate * pts.length;
      if (s.src.kind === "view") {
        // densité constante (grains par m²) : débit proportionnel à la surface couverte, borné par le tampon
        const [ex, ez] = this.weatherExtent(ctx.extent);
        spec.extent = [ex, spec.extent[1], ez];
        rate = Math.min(spec.rate * ((4 * ex * ez) / Math.max(1, s.area)), (spec.max / Math.max(0.1, spec.life[1])) * 0.95);
      }
      s.acc += dt * rate;
      let n = Math.floor(s.acc);
      if (n <= 0) continue;
      s.acc -= n;
      n = Math.min(n, spec.max);
      // réparti tour à tour entre les sources (cheminées, feux)
      while (n > 0) {
        const per = Math.max(1, Math.ceil(n / pts.length));
        const p = pts[s.rr++ % pts.length];
        const c = Math.min(per, n);
        s.sys.spawn(c, this.now, p);
        n -= c;
      }
    }
  }

  /** Ordres `fx.<id>` du DataProvider : une salve à chaque hausse de `n` (la première lecture mémorise le compteur). */
  applyOrders(spec: unknown, ctx: FxContext): boolean {
    if (!isObj(spec)) return false;
    let any = false;
    for (const [id, raw] of Object.entries(spec)) {
      const s = this.systems.find((x) => x.id === id);
      if (!s || !isObj(raw)) continue;
      const n = fin(raw.n) ? raw.n : 0;
      const prev = this.orders.get(id);
      this.orders.set(id, n);
      if (prev === undefined || n <= prev) continue;
      const o = readFx(raw, 1);
      const pts = o.at ? [o.at] : this.points(s, ctx).slice(0, 8);
      for (let k = 0; k < Math.min(8, n - prev); k++) for (const p of pts) s.sys.burstAt(this.now, p, o);
      any = true;
    }
    return any;
  }

  /** Résumé publié dans `status.fx`. */
  summary() {
    return this.systems.length ? { systems: this.systems.map((s) => ({ id: s.id, preset: s.sys.spec.preset, sources: s.src.kind === "anchors" ? s.src.list.length : 1, max: s.sys.spec.max })), grains: this.grains, budget: this.budget } : null;
  }

  clear() {
    this.systems = [];
    this.orders.clear();
    this.model = null;
  }
}

/** Clés de recette lues par les particules (retirées de la clé de composition : les changer ne recompose pas). */
export function fxInputOf(recipe: Record<string, unknown> | null | undefined, dpWeather?: unknown): FxInput {
  const r = recipe ?? {};
  const layers = Array.isArray(r.layers) ? (r.layers as { id?: unknown; fx?: unknown }[]) : [];
  return { weather: dpWeather !== undefined ? dpWeather : r.weather, fx: r.fx, particles: r.particles, wind: r.wind, windDir: r.windDir, layers: layers.map((l) => ({ id: l?.id, fx: l?.fx })) };
}

/** Recette sans les clés de particules (pour la clé de composition ; `windDir` reste : les prairies le lisent). */
export function stripFx<T>(recipe: T): T {
  if (!isObj(recipe)) return recipe;
  const rest: Record<string, unknown> = { ...(recipe as Record<string, unknown>) };
  for (const k of ["weather", "fx", "particles"]) delete rest[k];
  if (Array.isArray(rest.layers))
    rest.layers = (rest.layers as unknown[]).map((l) => {
      if (!isObj(l) || !("fx" in l)) return l;
      const o = { ...l };
      delete o.fx;
      return o;
    });
  return rest as T;
}

export type { ParticleSpec };
