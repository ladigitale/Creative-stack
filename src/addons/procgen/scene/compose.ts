/**
 * Composition d'une scène (CPU, pur, sans DOM) : recette + graine + paramètres → `SceneModel` prêt à rendre.
 *
 * Recette (JSON) : `params` (paramètres exposés), `size`, `ground`, `paths`, `layers` (générateur + placement),
 * `zones`, `actors`, `view`, `style`, `wind`, `windDir`, `meadows`, `meadowDetail`. Les nombres peuvent être des expressions `"= …"`. Chaque objet placé
 * reçoit un id stable `<couche>.<n>` ; les problèmes sont rassemblés dans `issues` (rendu partiel, jamais d'écran noir).
 *
 * Statiques uniques (bâtiments) : fusionnés par tuile spatiale ; objets répétés (arbres, rochers, objets) : instanciés ;
 * personnages : acteurs animés.
 */
import { type M4, type V3, DEG, clamp, m4Compose, m4Point, qAxis, qRot, sub } from "../core/math";
import { motionFor } from "../rig/motion";
import { resolveDeep, type Scope } from "../core/expr";
import { Rng } from "../core/rng";
import { type Issue, Issues, resolveParams, suggest } from "../core/schema";
import { Mesh } from "../geom/mesh";
import { GENERATORS, resolveGeneratorId } from "../gen/index";
import type { Asset, SoftPiece } from "../gen/types";
import { scalePiece } from "../gen/soft";
import { ACTIONS, type Action } from "../rig/locomotion";
import { NavGrid } from "./nav";
import { type Meadow, meadowBudget, meadowKeep, readMeadows, sowMeadows } from "./meadows";
import { type GroundSpec, type PathKind, type PathSpec, Terrain, distToPath, pointAt } from "./terrain";
import { type BodySpec, type PhysicsSpec, readBody, readPhysics } from "../../../shared/monde/physique";
import { cellCandidates, tileKey } from "../../../shared/monde/tiles";
import { readInfinite, worldRoads } from "./world-roads";

export type Placement =
  /** Point `at` : `y` (m au-dessus du sol) et `physics` (corps de cet objet) servent à la physique. */
  | { at: ([number, number] | { x: number; z: number; yaw?: number; y?: number; physics?: unknown })[] }
  | { grid: [number, number]; spacing: [number, number]; origin?: [number, number] }
  | { poisson: true | [number, number, number, number]; minDist?: number }
  | { along: string; side?: "both" | "left" | "right" | "center"; spacing?: number; offset?: number; jitter?: number; start?: number; end?: number }
  | { cluster: [number, number]; radius: number }
  | { ring: [number, number]; radius: number; jitter?: number }
  | { edges: "buildings" | "paths" | "all"; offset?: number }
  /** En travers d'une route ou d'une rivière (ponts) : `distance` = position le long du tracé (m, défaut : milieu), `spacing` entre plusieurs. */
  | { across: string; distance?: number; spacing?: number }
  /**
   * Semis sur une grille du monde à désordre : un candidat par cellule de `cell` m, gardé selon `density` (nombre ou
   * expression avec `x`, `z`, `h`), désordre `jitter` (0 à 1). Sans couture entre les tuiles d'un monde infini.
   */
  | { scatter: { cell?: number; density?: number | string; jitter?: number } };

export type LayerSpec = {
  id: string;
  gen: string;
  count?: number | string;
  params?: Record<string, unknown>;
  place?: Placement;
  scale?: number | string;
  yaw?: "path" | "random" | "center" | "away" | number | string;
  /** Écart minimal à respecter avec les autres objets (facteur d'emprise, défaut 1). */
  spacing?: number;
  /** Autorise sur la chaussée. */
  onPath?: boolean;
  /** Personnages : comportement par défaut. */
  behavior?: "idle" | "wander" | "patrol";
  action?: string;
  /** Ne bloque pas la navigation (herbe, fleurs). */
  walkable?: boolean;
  /** Flotte : posé sur l'eau (bateaux), interdit à terre. */
  onWater?: boolean;
  /** Particules attachées à chaque objet du calque (lues par scene/fx.ts, pas par la composition). */
  fx?: unknown;
  /** Animaux, personnages : cible de l'action de départ (`"bassin.0"`, `"abreuvoir.0.spot"`, `"bancs.1.sit.0"`) : posé à la place, tourné vers elle. */
  target?: string;
  /** Physique 3D : corps des objets de la couche (`{body: dynamic|static|kinematic, mass, friction, restitution…}`), `false` : aucun. */
  physics?: unknown;
};

export type ActorSpec = { gen?: string; params?: Record<string, unknown>; at?: [number, number]; facing?: number | string; behavior?: "idle" | "wander" | "patrol"; action?: string; speed?: number; target?: string };

export type ZoneSpec = { id: string; at?: [number, number] | string; r?: number; box?: [number, number, number, number] };

export type Recipe = {
  label?: string;
  params?: Record<string, { default: number | string | boolean; min?: number; max?: number; doc?: string; options?: string[] }>;
  size?: [number, number] | string[];
  ground?: Partial<Omit<GroundSpec, "size" | "seed">> | false;
  paths?: { id: string; points: [number, number][]; width?: number; kind?: PathKind; sidewalk?: number }[];
  layers?: LayerSpec[];
  zones?: ZoneSpec[];
  actors?: Record<string, ActorSpec>;
  view?: Record<string, unknown>;
  style?: unknown;
  wind?: number;
  /** Direction vers laquelle souffle le vent (°, 0 = vers +z, 90 = vers +x). */
  windDir?: number;
  /** Prairies : herbes hautes, blé, roseaux, fleurs, gazon en brins instanciés (voir `meadows.ts`). */
  meadows?: unknown;
  /** Densité des prairies : 0, 1, 2 ou `auto` (0 sur mobile, 1 sinon). */
  meadowDetail?: number | string;
  /** Physique 3D (Rapier, chargé à la demande) : `true` ou `{gravity, contactMin, hz, joints, paused, water, walls}`. */
  physics?: unknown;
  /** Particules (scene/fx.ts) : météo, effets de scène, systèmes libres. */
  weather?: unknown;
  fx?: unknown;
  particles?: unknown;
  /** Monde infini : `{tile, radius, follow, seed, roads, persist, budget, quality, step}` (voir infinite.ts). */
  infinite?: Record<string, unknown> | false;
};

export type ObjectInfo = {
  id: string;
  layer: string;
  generator: string;
  params: Record<string, unknown>;
  pos: V3;
  yaw: number;
  scale: number;
  footprint: { hx: number; hz: number; r: number };
  height: number;
  obj: number;
  mode: "static" | "instance" | "actor";
  anchors: Record<string, V3>;
  /** Ce que l'objet permet (s'asseoir, rouler, lancer…) et ses propriétés physiques, s'il les publie. */
  affords?: string[];
  physics?: Record<string, unknown>;
  /** Cap monde (radians) de chaque place `sit.N` : on s'y assied face à cette direction. */
  seatYaw?: Record<string, number>;
  /** Placement de la couche (`at`, `grid`, `poisson`, `along`…, `actor` pour `recipe.actors`) et rang dans la couche. */
  place?: string;
  index?: number;
  /** Options de la couche utiles au rangement (édition au doigt). */
  onWater?: boolean;
  onPath?: boolean;
  walkable?: boolean;
  /** Emprises qui gênent vraiment (tronçons de clôture, garde-corps d'un ouvrage) : `[x, z, hx, hz, yaw]` monde. */
  blockers?: [number, number, number, number, number][];
  /** Corps physique demandé (couche ou point `at`, ballons par défaut quand la scène a `physics`). */
  body?: BodySpec;
};

/** Tissus d'un objet de décor (drapeau, linge, rideau) : simulés par le rendu 3D, attachés au repère de l'objet. */
export type SoftItem = { obj: number; id: string; matrix: M4; pieces: SoftPiece[] };

export type InstanceGroup = { key: string; mesh: Mesh; matrices: M4[]; objs: number[]; flex: boolean };
export type ActorModel = {
  id: string; layer: string | null; asset: Asset; params: Record<string, unknown>; pos: V3; yaw: number; behavior: "idle" | "wander" | "patrol"; action: Action; speed: number; obj: number; seed: number;
  /** Départ à une cible (`target`) : hauteur de la cible au-dessus des pieds (boire, manger), assise occupée, point où se relever. */
  reachY?: number; seatY?: number; standAt?: [number, number];
};
/** Surface praticable d'un ouvrage (tablier, marches) : repère de l'objet, demi-largeur et profil [z, y] du dessus. */
export type Deck = { x: number; z: number; y: number; yaw: number; scale: number; hw: number; profile: [number, number][] };
export type Zone = { id: string; x: number; z: number; r: number; box: [number, number, number, number] | null };
export type PointLight = { pos: V3; kind: "fire" | "lamp"; radius: number };

export type SceneModel = {
  size: [number, number];
  bounds: { min: V3; max: V3 };
  terrain: Terrain | null;
  ground: Mesh | null;
  roads: Mesh | null;
  water: Mesh | null;
  tiles: Mesh[];
  instances: InstanceGroup[];
  actors: ActorModel[];
  objects: ObjectInfo[];
  zones: Zone[];
  lights: PointLight[];
  nav: NavGrid | null;
  /** Tabliers, marches, quais : les acteurs y marchent à leur hauteur (`groundHeight`). */
  decks: Deck[];
  issues: Issue[];
  view: Record<string, unknown>;
  style: unknown;
  wind: number;
  /** Direction du vent (radians, 0 = vers +z). */
  windDir: number;
  /** Prairies semées (rendu 3D seulement). */
  meadows: Meadow[];
  /** Physique 3D demandée (null : aucune, le moteur n'est pas chargé). */
  physics: PhysicsSpec | null;
  /** Réglages propres aux scènes : flottaison (`water`, défaut oui), bords de scène (`walls`, défaut oui). */
  physicsScene?: { water: boolean; walls: boolean };
  /** Tissus des objets (plafonnés à `MAX_SOFT_OBJECTS` ; au-delà, drapé figé fusionné au décor). */
  softs: SoftItem[];
  stats: { ms: number; triangles: number; objects: number; instances: number; actors: number };
};

/** Générateurs animés (acteurs skinnés, jamais mis en cache ni instanciés). */
const ACTOR_GENS = new Set(["character", "animal"]);
const INSTANCEABLE = new Set(["textile", "tree", "bush", "grass", "flowers", "rock", "prop", "emblem", "plant", "vehicle", "ball", "seat", "tool", "container", "street", "pet", "structure", "water"]);
/** Tailles fines (pas d'arrondi au quart de mètre). */
const FINE = new Set(["ball", "seat", "structure", "water"]);
/** Paramètre de taille converti en échelle d'instance, et sa valeur de référence. */
const SCALE_PARAM: Record<string, { name: string; ref: number }> = { tree: { name: "height", ref: 7 }, bush: { name: "size", ref: 1 }, grass: { name: "size", ref: 0.35 }, rock: { name: "size", ref: 1.5 }, flowers: { name: "size", ref: 1 }, emblem: { name: "size", ref: 1 }, plant: { name: "size", ref: 1 }, tool: { name: "scale", ref: 1 }, container: { name: "scale", ref: 1 }, street: { name: "scale", ref: 1 }, pet: { name: "scale", ref: 1 }, textile: { name: "scale", ref: 1 } };
/** Objets à tissus simulés au plus par scène (le rendu en anime encore moins à la fois, selon l'écran). */
export const MAX_SOFT_OBJECTS = 48;
const TILE = 24;
const MAX_ITEMS = 1500;

/** Retouches persistées d'une tuile de monde infini (`tiles."cx,cz"`). */
export type TileEdit = {
  remove?: string[];
  move?: Record<string, { x: number; z: number; yaw?: number }>;
  add?: { id?: string; layer?: string; gen: string; params?: Record<string, unknown>; x: number; z: number; yaw?: number; scale?: number }[];
  t?: number;
};

/** Tuile d'un monde infini : composée en repère local (centre en `origin`), posée dans le monde à la fin. */
export type TileInput = {
  cx: number;
  cz: number;
  size: number;
  /** Centre de la tuile (m, repère du monde). */
  origin: [number, number];
  /** Graine du monde (semis par cellule). */
  seed: string;
  /** Pas du maillage de sol (m). */
  step: number;
  /** Routes du monde qui touchent la tuile (repère du monde). */
  paths: PathSpec[];
  /** Assets partagés entre tuiles (mêmes paramètres = même maillage, instancié dans tout le monde). */
  assetCache?: Map<string, Asset>;
  /** Premier identifiant d'objet de la tuile (sélection, surlignage). */
  objBase: number;
  edits?: TileEdit;
};

export type ComposeInput = {
  recipe: Recipe;
  seed?: string | number;
  params?: Record<string, unknown>;
  edits?: Record<string, Record<string, unknown>>;
  /** Construction d'asset de remplacement (mode vectoriel : emprises et squelettes sans maillage) ; `null` = générateur réel. */
  /** Écran tactile ou petit : prairies moins denses en `meadowDetail: "auto"`. */
  mobile?: boolean;
  assetBuilder?: (generator: string, params: Record<string, unknown>, ctx: import("../gen/types").GenContext) => Asset | null;
  /** Monde infini : compose une tuile (sans acteurs ni zones). */
  tile?: TileInput;
};

/** Composition synchrone (tests, outils). */
export function composeScene(input: ComposeInput): SceneModel {
  const it = composeSteps(input);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/**
 * Composition par tranches : rend la main au navigateur dès que `budgetMs` est dépassé (la page reste fluide pendant
 * qu'une scène se construit). `onProgress(fait, total)` suit l'avancement. `signal` annule une composition dépassée.
 */
export async function composeSceneAsync(input: ComposeInput, opts: { budgetMs?: number; onProgress?: (done: number, total: number) => void; signal?: { cancelled: boolean } } = {}): Promise<SceneModel | null> {
  const it = composeSteps(input);
  const budget = opts.budgetMs ?? 12;
  let t = performance.now();
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    if (opts.signal?.cancelled) return null;
    if (r.value) opts.onProgress?.(r.value[0], r.value[1]);
    if (performance.now() - t > budget) {
      await new Promise((res) => setTimeout(res, 0));
      t = performance.now();
    }
  }
}

export function* composeSteps(input: ComposeInput): Generator<[number, number] | undefined, SceneModel> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const issues = new Issues();
  const recipe = input.recipe ?? {};
  const seed = String(input.seed ?? 1);
  const root = new Rng(seed);
  // paramètres de scène
  const sceneVars: Record<string, unknown> = {};
  const given = input.params ?? {};
  for (const [k, spec] of Object.entries(recipe.params ?? {})) {
    let v = k in given ? given[k] : spec.default;
    if (typeof spec.default === "number") {
      v = Number(v);
      if (!Number.isFinite(v as number)) v = spec.default;
      const c = clamp(v as number, spec.min ?? -Infinity, spec.max ?? Infinity);
      if (c !== v) issues.add({ path: `params.${k}`, code: "clamped", message: "hors bornes", got: v, used: c });
      v = c;
    } else if (spec.options && !spec.options.includes(String(v))) {
      issues.add({ path: `params.${k}`, code: "unknown", message: `valeur « ${String(v)} » inconnue`, didYouMean: suggest(String(v), spec.options), hint: spec.options.join(", ") });
      v = spec.default;
    }
    sceneVars[k] = v;
  }
  for (const k of Object.keys(given)) if (!(k in sceneVars)) issues.add({ path: `params.${k}`, code: "unknown", message: `paramètre de scène inconnu « ${k} »`, didYouMean: suggest(k, Object.keys(recipe.params ?? {})) });
  const scope = (rng: Rng, extra: Record<string, unknown> = {}): Scope => ({ rng, vars: { ...sceneVars, ...extra } });
  const R = (v: unknown, path: string, rng: Rng, extra: Record<string, unknown> = {}, fallback: unknown = 0) => resolveDeep(v, scope(rng, extra), (p, m) => issues.add({ path: p || path, code: "expr", message: m }), path, fallback);
  const num = (v: unknown, path: string, rng: Rng, d: number, extra: Record<string, unknown> = {}) => {
    const n = Number(R(v ?? d, path, rng, extra, d));
    return Number.isFinite(n) ? n : d;
  };

  // physique : réglages de la scène ; une couche ou un point qui demande un corps l'active aussi
  const physIssues: { path: string; message: string }[] = [];
  const wantsPhysics = recipe.physics !== undefined && recipe.physics !== false && recipe.physics !== null;
  const layerPhysics = (recipe.layers ?? []).some((l) => l && ((l.physics !== undefined && l.physics !== false) || ("at" in (l.place ?? {}) && ((l.place as { at?: unknown[] }).at ?? []).some((a) => !!a && typeof a === "object" && !Array.isArray(a) && (a as { physics?: unknown }).physics))));
  // monde infini : pas de corps dans les tuiles (physique 3D des scènes finies seulement)
  const physics: PhysicsSpec | null = !input.tile && (wantsPhysics || layerPhysics) ? readPhysics(wantsPhysics ? recipe.physics : true, physIssues) : null;
  const physObj = recipe.physics && typeof recipe.physics === "object" ? (recipe.physics as Record<string, unknown>) : {};
  for (const x of physIssues) issues.add({ path: x.path, code: "unknown", message: x.message });
  const physicsScene = { water: (physObj.water ?? physObj.eau) !== false, walls: (physObj.walls ?? physObj.bords) !== false };
  let bodiesLeft = 200;
  /** Corps de l'objet en cours de placement (couche, point `at`), hauteur de départ au-dessus du sol. */
  let bodyNext: BodySpec | undefined;
  let liftNext = 0;
  const tile = input.tile ?? null;
  const [ox, oz] = tile ? tile.origin : [0, 0];
  const sizeR = recipe.size ?? [40, 30];
  const size: [number, number] = tile ? [tile.size, tile.size] : [clamp(num(sizeR[0], "size[0]", root, 40), 4, 400), clamp(num(sizeR[1], "size[1]", root, 30), 4, 400)];
  // routes
  const paths0: PathSpec[] = (recipe.paths ?? []).map((p, i) => ({
    id: p.id ?? `path${i}`,
    points: (R(p.points, `paths[${i}].points`, root) as [number, number][]).filter((q) => Array.isArray(q)).map((q) => [Number(q[0]) || 0, Number(q[1]) || 0] as [number, number]),
    width: num(p.width, `paths[${i}].width`, root, 4),
    kind: (["street", "road", "path", "river", "plaza"] as const).includes(p.kind as PathKind) ? (p.kind as PathKind) : "street",
    sidewalk: num(p.sidewalk, `paths[${i}].sidewalk`, root, p.kind === "street" || !p.kind ? 1.8 : 0),
  }));
  // recette infinie composée en scène finie (rendu vectoriel) : le réseau de routes du monde sur l'emprise
  if (!tile && recipe.infinite) {
    const inf = readInfinite(recipe.infinite, new Issues(), seed);
    if (inf) paths0.push(...worldRoads(inf, -size[0] / 2, -size[1] / 2, size[0] / 2, size[1] / 2));
  }
  // tuile : routes de la recette et du réseau du monde, ramenées au repère de la tuile
  const paths: PathSpec[] = tile ? [...paths0, ...tile.paths].map((p) => ({ ...p, points: p.points.map(([x, z]) => [x - ox, z - oz] as [number, number]) })) : paths0;
  // sol
  let terrain: Terrain | null = null;
  if (recipe.ground !== false) {
    const g = (recipe.ground ?? {}) as Record<string, unknown>;
    const water = g.water === undefined || g.water === null ? null : num(g.water, "ground.water", root, 0);
    const surf = String(g.surface ?? "grass");
    terrain = new Terrain(
      {
        size,
        relief: num(g.relief, "ground.relief", root, 0.6),
        scale: num(g.scale, "ground.scale", root, 18),
        mountains: num(g.mountains, "ground.mountains", root, 0),
        water,
        surface: (["grass", "sand", "snow", "dirt", "paved", "seabed"] as const).includes(surf as GroundSpec["surface"]) ? (surf as GroundSpec["surface"]) : "grass",
        seed: (root.fork("ground").next() * 1000) | 0,
        coast: !tile && (["north", "south", "east", "west"] as const).includes(g.coast as "north") ? (g.coast as GroundSpec["coast"]) : null,
        ...(tile ? { world: { origin: [ox, oz] as [number, number], step: tile.step } } : {}),
        coastAt: num(g.coastAt, "ground.coastAt", root, 0.2),
        coastDepth: num(g.coastDepth, "ground.coastDepth", root, 3),
      },
      paths,
    );
    if (tile) yield undefined;
  }
  const H = (x: number, z: number) => (terrain ? terrain.height(x, z) : 0);
  const waterLevel = terrain?.spec.water ?? null;

  const objects: ObjectInfo[] = [];
  const actors: ActorModel[] = [];
  const tiles = new Map<string, Mesh>();
  const softs: SoftItem[] = [];
  const groups = new Map<string, InstanceGroup>();
  const assetCache = tile?.assetCache ?? new Map<string, Asset>();
  const placedCircles: { x: number; z: number; r: number }[] = [];
  const nav = new NavGrid(size[0], size[1], 0.5);
  const decks: Deck[] = [];
  const structNav: { yaw: number; blk: [number, number, number, number][]; walks: { x: number; z: number; yaw: number; scale: number; hw: number; z0: number; z1: number }[] }[] = [];
  /** Départ d'un acteur à une cible (posé par `placeObject`). */
  let startAt: { pos: V3; yaw: number; reachY?: number; seatY?: number; standAt?: [number, number] } | null = null;
  const groundAt = (x: number, z: number) => deckHeight(decks, x, z, H(x, z));
  /**
   * Place de départ d'un acteur qui vise une ancre : assise (`.sit.N`), point d'eau ou de nourriture (`spot`, `spot.N` :
   * la bouche au-dessus de l'ancre), sinon l'ancre elle-même. `i` répartit une couche sur les places `spot.0…`.
   */
  const targetPlace = (target: string, asset: Asset, i: number, path: string, actionOf?: string): typeof startAt => {
    const o = objects.find((ob) => target === ob.id || target.startsWith(ob.id + "."));
    if (!o) {
      issues.add({ path, code: "unknown", message: `cible « ${target} » introuvable`, didYouMean: suggest(target, objects.map((ob) => ob.id)) });
      return null;
    }
    let an = target.slice(o.id.length + 1);
    if (!an) {
      const spots = Object.keys(o.anchors).filter((k) => /^spot\.\d+$/.test(k));
      an = spots.length ? spots[i % spots.length] : o.anchors.spot ? "spot" : Object.keys(o.anchors).find((k) => k.startsWith("sit.")) ?? "";
    }
    const p = o.anchors[an];
    if (!p) {
      issues.add({ path, code: "unknown", message: `ancre « ${an} » absente de ${o.id}`, didYouMean: suggest(an, Object.keys(o.anchors)), hint: Object.keys(o.anchors).join(", ") });
      return null;
    }
    const sm = /^sit\.(\d+)$/.exec(an);
    if (sm) {
      const ap = o.anchors[`approach.${sm[1]}`] ?? p;
      return { pos: [p[0], p[1], p[2]], yaw: o.seatYaw?.[an] ?? o.yaw, seatY: p[1] - o.pos[1], standAt: [ap[0], ap[2]] };
    }
    const spm = /^spot(?:\.(\d+))?$/.exec(an);
    const ap = spm ? o.anchors[spm[1] !== undefined ? `approach.${spm[1]}` : "approach"] : undefined;
    const from = ap ?? [o.pos[0], 0, o.pos[2]];
    let dx = p[0] - from[0], dz = p[2] - from[2];
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) [dx, dz] = [Math.sin(o.yaw), Math.cos(o.yaw)];
    else [dx, dz] = [dx / d, dz / d];
    const reach = actionOf === "sleep" ? 0 : reachOf(asset, actionOf ?? "drink", p[1] - groundAt(p[0] - dx * 0.5, p[2] - dz * 0.5));
    const x = spm ? p[0] - dx * reach : p[0], z = spm ? p[2] - dz * reach : p[2];
    const y = groundAt(x, z);
    return { pos: [x, y, z], yaw: Math.atan2(dx, dz), reachY: p[1] - y, standAt: ap ? [ap[0], ap[2]] : undefined };
  };
  let total = 0;

  const free = (x: number, z: number, r: number, onPath: boolean, spacing: number, onWater = false) => {
    // tuile : le centre est dans la tuile par construction ; l'emprise peut déborder sur la voisine
    if (!tile && (Math.abs(x) > size[0] / 2 - r * 0.3 || Math.abs(z) > size[1] / 2 - r * 0.3)) return false;
    for (const c of placedCircles) if (Math.hypot(c.x - x, c.z - z) < (c.r + r) * spacing * 0.92) return false;
    if (!onPath && terrain) {
      const pi = terrain.pathInfo(x, z);
      const extra = pi.path?.kind === "street" ? pi.path.sidewalk : 0;
      if (pi.path && pi.path.kind !== "path" && pi.d < r * 0.6 + extra) return false;
      if (pi.path && pi.path.kind === "path" && pi.d < r * 0.3) return false;
    }
    if (onWater) return waterLevel !== null && H(x, z) < waterLevel - 0.4;
    if (waterLevel !== null && H(x, z) < waterLevel + 0.05) return false;
    return true;
  };

  const buildAsset = (genId: string, params: Record<string, unknown>, path: string, rng: Rng): { asset: Asset; key: string; generator: string; resolved: Record<string, unknown>; extraScale: number; fresh: boolean } | null => {
    const { gen, preset } = resolveGeneratorId(genId);
    if (!gen) {
      issues.add({ path, code: "unknown", message: `générateur « ${genId} » inconnu`, didYouMean: suggest(genId, Object.keys(GENERATORS)), hint: Object.keys(GENERATORS).join(", ") });
      return null;
    }
    const resolved = resolveParams(gen.schema, { ...preset, ...params }, scope(rng), issues, `${path}.params`) as Record<string, unknown>;
    const vs = gen.schema.variant as { type: string; max?: number } | undefined;
    if (vs && resolved.variant === -1) resolved.variant = rng.int(0, vs.max ?? 3);
    // objets instanciables : la taille devient une échelle d'instance, les autres réels sont arrondis (peu de variantes)
    let extraScale = 1;
    if (INSTANCEABLE.has(gen.id)) {
      const sp = SCALE_PARAM[gen.id];
      if (sp && typeof resolved[sp.name] === "number") {
        extraScale = (resolved[sp.name] as number) / sp.ref;
        resolved[sp.name] = sp.ref;
      }
      // ballons et assises : tailles fines (une balle de golf fait 4,3 cm), pas d'arrondi
      if (!FINE.has(gen.id)) for (const [k, v] of Object.entries(resolved)) if (typeof v === "number" && k !== "variant" && gen.schema[k]?.type === "number") resolved[k] = Math.round(v * 4) / 4;
    }
    const key = `${gen.id}|${JSON.stringify(resolved)}`;
    let asset = ACTOR_GENS.has(gen.id) ? undefined : assetCache.get(key);
    const fresh = !asset;
    if (!asset) {
      try {
        asset = input.assetBuilder?.(gen.id, resolved, { rng, issues, path }) ?? gen.build(resolved as never, { rng, issues, path });
      } catch (e) {
        issues.add({ path, code: "info", message: `échec du générateur : ${(e as Error).message}` });
        return null;
      }
      if (!ACTOR_GENS.has(gen.id)) assetCache.set(key, asset);
    }
    return { asset, key, generator: gen.id, resolved, extraScale, fresh };
  };

  /**
   * Corps d'un objet : `physics` de la couche ou du point (`false` : aucun) ; avec la physique de scène, un ballon est
   * dynamique par défaut, avec sa masse, son rebond et son frottement publiés (`extra.physics`).
   */
  const bodyOf = (generator: string, asset: Asset, scale: number, spec: unknown, path: string): BodySpec | undefined => {
    if (spec === false || spec === null) return undefined;
    const ph = (asset.extra?.physics ?? {}) as { mass?: number; restitution?: number; friction?: number };
    if (spec === undefined && generator !== "ball") return undefined;
    const o: Record<string, unknown> = spec === undefined || spec === true ? {} : typeof spec === "string" ? { body: spec } : spec && typeof spec === "object" ? { ...(spec as Record<string, unknown>) } : {};
    if (generator === "ball") {
      // un ballon roule : freinage au roulement selon son frottement (Rapier ne freine pas une sphère qui roule)
      const pick = (...k: string[]) => k.some((x) => o[x] !== undefined);
      if (!pick("mass", "masse") && ph.mass) o.mass = ph.mass * scale ** 3;
      if (!pick("restitution", "rebond") && ph.restitution !== undefined) o.restitution = ph.restitution;
      if (!pick("friction") && ph.friction !== undefined) o.friction = Math.max(0.3, ph.friction);
      if (!pick("angularDamping", "amortiRotation")) o.angularDamping = 0.6 + (ph.friction ?? 0.5);
      if (!pick("damping", "amorti")) o.damping = 0.05;
      if (!pick("shape", "forme")) o.shape = "sphere";
    }
    const iss: { path: string; message: string }[] = [];
    const b = readBody(o, path, iss) ?? undefined;
    for (const x of iss) issues.add({ path: x.path, code: "unknown", message: x.message });
    return b;
  };

  const placeObject = (layer: LayerSpec | null, id: string, asset: Asset, key: string, generator: string, rawParams: Record<string, unknown>, x: number, z: number, yaw: number, scale: number, rng: Rng, behavior?: string, action?: string) => {
    const fp = asset.footprint;
    // posé sur le point le plus bas de l'emprise (pas d'objet flottant), légèrement enfoncé
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => [x + (a * fp.hx * c + b * fp.hz * s) * scale, z + (-a * fp.hx * s + b * fp.hz * c) * scale]);
    // ouvrages : posés au plus bas de leurs appuis (les berges d'un pont), pas au fond du lit
    const rest = Array.isArray(asset.extra?.rest) ? (asset.extra!.rest as [number, number][]) : null;
    let y = rest && rest.length ? Math.min(...rest.map(([lx, lz]) => H(x + (lx * c + lz * s) * scale, z + (-lx * s + lz * c) * scale))) - 0.02 : layer?.onWater && waterLevel !== null ? waterLevel - 0.15 : generator === "building" ? Math.min(H(x, z), ...corners.map(([cx, cz]) => H(cx, cz))) - 0.05 : H(x, z) - 0.02;
    const obj = (tile?.objBase ?? 0) + objects.length + 1;
    const body = bodyNext;
    bodyNext = undefined;
    // corps dynamique lâché d'en haut (`y` d'un point `at`)
    if (body && body.kind === "dynamic" && liftNext > 0) y += liftNext;
    liftNext = 0;
    const T = m4Compose([x, y, z], qAxis([0, 1, 0], yaw), scale);
    const anchors: Record<string, V3> = {};
    for (const [k, a] of Object.entries(asset.anchors)) anchors[k] = m4Point(T, a.pos);
    const isActor = ACTOR_GENS.has(generator);
    // un objet qui bouge par la physique est instancié (matrice réécrite à chaque pas, sans toucher aux tuiles)
    const mode: ObjectInfo["mode"] = isActor ? "actor" : INSTANCEABLE.has(generator) || (body && body.kind !== "static") ? "instance" : "static";
    const affords = Array.isArray(asset.extra?.affords) ? (asset.extra!.affords as string[]) : undefined;
    const physics = asset.extra?.physics && typeof asset.extra.physics === "object" ? (asset.extra.physics as Record<string, unknown>) : undefined;
    const seatYaw: Record<string, number> = {};
    for (const [k, a] of Object.entries(asset.anchors)) if (k.startsWith("sit.")) {
      const f = qRot(a.rot, [0, 0, 1]);
      seatYaw[k] = yaw + Math.atan2(f[0], f[2]);
    }
    objects.push({ id, layer: layer?.id ?? "actors", generator, params: rawParams, pos: [x, y, z], yaw, scale, ...(Object.keys(seatYaw).length ? { seatYaw } : {}), footprint: { hx: fp.hx * scale, hz: fp.hz * scale, r: fp.r * scale }, height: asset.height * scale, obj, mode, anchors, ...(affords ? { affords } : {}), ...(physics ? { physics } : {}), ...(body && !isActor ? { body } : {}) });
    const segs = asset.extra?.segments as [number, number, number, number, number][] | undefined;
    if (segs) {
      // clôtures le long d'un tracé : chaque tronçon bloque sa bande, de petits disques jalonnent le tracé
      const me = objects[objects.length - 1];
      me.blockers = [];
      for (const [ax, az, bx, bz, hw] of segs) {
        const [wx0, , wz0] = m4Point(T, [ax, 0, az]), [wx1, , wz1] = m4Point(T, [bx, 0, bz]);
        const L = Math.hypot(wx1 - wx0, wz1 - wz0);
        if (me.blockers.length < 400 && L > 1e-3) me.blockers.push([(wx0 + wx1) / 2, (wz0 + wz1) / 2, Math.max(0.05, hw * scale), L / 2, Math.atan2(wx1 - wx0, wz1 - wz0)]);
        if (!layer?.walkable) nav.blockBox((wx0 + wx1) / 2, (wz0 + wz1) / 2, L / 2, hw * scale, Math.atan2(wz0 - wz1, wx1 - wx0), 0.15);
        for (let s = 0; s <= L; s += 1) placedCircles.push({ x: wx0 + ((wx1 - wx0) * s) / Math.max(L, 1e-6), z: wz0 + ((wz1 - wz0) * s) / Math.max(L, 1e-6), r: Math.max(0.15, hw * scale) });
      }
    } else if (Array.isArray(asset.extra?.blockers)) {
      // ouvrages : seuls les garde-corps, piliers et piles bloquent ; le tablier est praticable (rouvert après l'eau)
      placedCircles.push({ x, z, r: Math.max(0.15, fp.r * 0.6 * scale) });
      const blk = (asset.extra!.blockers as [number, number, number, number][]).map(([bx, bz, bhx, bhz]) => [x + (bx * c + bz * s) * scale, z + (-bx * s + bz * c) * scale, bhx * scale, bhz * scale] as [number, number, number, number]);
      objects[objects.length - 1].blockers = blk.slice(0, 64).map(([bx, bz, bhx, bhz]) => [bx, bz, bhx, bhz, yaw]);
      const walks = (Array.isArray(asset.extra?.walk) ? (asset.extra!.walk as { hw: number; profile: [number, number][] }[]) : []).filter((w) => w.profile.length >= 2);
      for (const w of walks) decks.push({ x, z, y, yaw, scale, hw: w.hw, profile: w.profile });
      structNav.push({ yaw, blk: layer?.walkable ? [] : blk, walks: walks.length ? walks.map((w) => ({ x, z, yaw, scale, hw: w.hw, z0: w.profile[0][0], z1: w.profile[w.profile.length - 1][0] })) : [] });
      if (!layer?.walkable) for (const [bx, bz, bhx, bhz] of blk) nav.blockBox(bx, bz, bhx, bhz, yaw, 0.15);
    } else {
      placedCircles.push({ x, z, r: Math.max(0.15, (generator === "building" ? Math.max(fp.hx, fp.hz) : fp.r * 0.6) * scale) });
      // ballons et outils posés ne barrent pas le passage
      if (!layer?.walkable && generator !== "grass" && generator !== "flowers" && generator !== "ball" && generator !== "tool" && !((generator === "container" || generator === "pet") && (fp.r * scale < 0.3 || asset.height * scale < 0.3)) && !isActor) nav.blockBox(x, z, fp.hx * scale, fp.hz * scale, yaw, 0.25);
    }
    if (isActor) {
      const beh = (["idle", "wander", "patrol"] as const).includes(behavior as never) ? (behavior as ActorModel["behavior"]) : "idle";
      const act = (ACTIONS as readonly string[]).includes(action ?? "") ? (action as Action) : "idle";
      if (action && act !== action) issues.add({ path: `${id}.action`, code: "unknown", message: `action « ${action} » inconnue`, didYouMean: suggest(action, ACTIONS), hint: ACTIONS.join(", ") });
      const am: ActorModel = { id, layer: layer?.id ?? null, asset, params: rawParams, pos: [x, y, z], yaw, behavior: beh, action: act, speed: 0, obj, seed: rng.next() * 1000 };
      if (startAt) {
        am.pos = [startAt.pos[0], startAt.pos[1], startAt.pos[2]];
        am.yaw = startAt.yaw;
        if (startAt.reachY !== undefined) am.reachY = startAt.reachY;
        if (startAt.seatY !== undefined) am.seatY = startAt.seatY;
        if (startAt.standAt) am.standAt = startAt.standAt;
        if (am.behavior !== "idle") am.behavior = "idle";
        startAt = null;
      }
      actors.push(am);
      return;
    }
    total += asset.mesh.triangleCount;
    if (asset.soft?.length) {
      if (softs.length < MAX_SOFT_OBJECTS) softs.push({ obj, id, matrix: m4Compose([x, y, z], qAxis([0, 1, 0], yaw), 1), pieces: asset.soft.map((p) => scalePiece(p, scale)) });
      else if (asset.softFrozen?.vertexCount) {
        // plafond atteint : drapé de repos fusionné au décor de la tuile
        const tk = `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
        let t = tiles.get(tk);
        if (!t) tiles.set(tk, (t = new Mesh()));
        t.append(asset.softFrozen, T, { obj });
        total += asset.softFrozen.triangleCount;
      }
    }
    if (mode === "instance") {
      let g = groups.get(key);
      if (!g) {
        g = { key, mesh: asset.mesh, matrices: [], objs: [], flex: asset.mesh.flex.some((f) => f > 0) };
        groups.set(key, g);
      }
      g.matrices.push(T);
      g.objs.push(obj);
    } else {
      const tk = `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
      let t = tiles.get(tk);
      if (!t) tiles.set(tk, (t = new Mesh()));
      const v0 = t.vertexCount;
      t.append(asset.mesh, T, { obj });
      // drapé sur le relief (murs, clôtures le long d'un tracé)
      if (asset.extra?.drape && terrain) for (let i = v0; i < t.vertexCount; i++) t.pos[i * 3 + 1] += H(t.pos[i * 3], t.pos[i * 3 + 2]) - y - 0.03;
    }
  };

  // tuile : place libre au départ des acteurs (le semis ne pousse pas sur eux)
  if (tile)
    for (const a of Object.values(recipe.actors ?? {})) {
      const at = Array.isArray(a?.at) ? a.at : [0, 0];
      const x = Number(at[0]) - ox, z = Number(at[1]) - oz;
      if (Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) < size[0] && Math.abs(z) < size[1]) placedCircles.push({ x, z, r: 1.5 });
    }

  /* ---------- couches ---------- */
  const layerIds = new Set<string>();
  const layersIn = recipe.layers ?? [];
  const totalSteps = layersIn.length + Object.keys(recipe.actors ?? {}).length;
  for (const [li, layer] of layersIn.entries()) {
    yield [li, totalSteps];
    const lp = `layers[${li}]`;
    if (!layer || typeof layer !== "object" || !layer.gen) {
      issues.add({ path: lp, code: "missing", message: "couche sans « gen »" });
      continue;
    }
    const lid = layer.id || `layer${li}`;
    if (layerIds.has(lid)) issues.add({ path: `${lp}.id`, code: "info", message: `id de couche « ${lid} » en double` });
    layerIds.add(lid);
    const lrng = root.fork(lid);
    const place = layer.place ?? { poisson: true };
    // tuile : seuls les acteurs de `recipe.actors` s'animent (personnages et animaux des couches : pas de semis)
    if (tile && ACTOR_GENS.has(resolveGeneratorId(layer.gen).gen?.id ?? "")) {
      issues.add({ path: `${lp}.gen`, code: "info", message: "monde infini : personnages et animaux dans recipe.actors seulement (couche ignorée)" });
      continue;
    }
    const asked = Math.round(clamp(num(layer.count, `${lp}.count`, lrng, 1), 0, 400));
    let positions: Pos[];
    let count: number;
    if (tile) {
      positions = tilePlacements(place, lid, asked, lrng, tile, size, paths, objects, issues, lp, (v, x, z) => clamp(num(v, `${lp}.place.scatter.density`, lrng, 1, { x: x + ox, z: z + oz, h: H(x, z) }), 0, 1));
      // tuile : `count` borne la tuile (semis, fléchettes, bords) ; les placements ancrés au monde gardent ce qui y tombe
      count = layer.count === undefined || "at" in place || "grid" in place ? positions.length : Math.min(positions.length, asked);
      if ("poisson" in place || "edges" in place) count = asked;
    } else {
      positions = "scatter" in place ? scatterPositions(place.scatter, lid, String(seed), -size[0] / 2, -size[1] / 2, Math.max(size[0], size[1]), size, (v, x, z) => clamp(num(v, `${lp}.place.scatter.density`, lrng, 1, { x, z, h: H(x, z) }), 0, 1)) : placements(place, asked, lrng.fork("place"), size, paths, objects, issues, lp);
      count = "at" in place || "grid" in place || ("scatter" in place && layer.count === undefined) ? Math.min(positions.length, layer.count === undefined ? positions.length : asked) : asked;
    }
    const spacing = layer.spacing ?? 1;
    let n = 0;
    const tk = tile ? `${tile.cx}_${tile.cz}` : "";
    for (let i = 0; i < positions.length && n < count; i++) {
      if (objects.length >= MAX_ITEMS) {
        issues.add({ path: lp, code: "limit", message: `limite de ${MAX_ITEMS} objets atteinte` });
        break;
      }
      const pos = positions[i];
      // ids stables : rang dans `at` (comme une scène finie), sinon tuile et rang dans la tuile
      const id = pos.idx !== undefined ? `${lid}.${pos.idx}` : tile ? `${lid}.${tk}_${n}` : `${lid}.${n}`;
      const irng = pos.idx !== undefined ? lrng.fork(pos.idx) : tile ? lrng.fork(`${tk}_${n}`) : lrng.fork(n);
      // retouches persistées : objet retiré (le rang reste pris : les suivants gardent leur id), déplacé
      if (tile?.edits?.remove?.includes(id)) {
        n++;
        continue;
      }
      const moved = tile?.edits?.move?.[id];
      if (moved && Number.isFinite(moved.x) && Number.isFinite(moved.z)) {
        pos.x = moved.x - ox;
        pos.z = moved.z - oz;
        if (Number.isFinite(moved.yaw)) pos.yaw = (moved.yaw as number) * DEG;
      }
      const vars = { i: n, n: count, t: count > 1 ? n / (count - 1) : 0, x: pos.x, z: pos.z };
      const edits = input.edits?.[id] ?? input.edits?.[lid];
      const raw = { ...(R(layer.params ?? {}, `${lp}.params`, irng, vars, 0) as Record<string, unknown>), ...(edits ?? {}) };
      // en travers d'une rivière : portée ajustée à sa largeur (plus les berges) si la longueur n'est pas donnée
      if (pos.span && raw.length === undefined && resolveGeneratorId(layer.gen).gen?.schema.length) raw.length = Math.round(pos.span * 4) / 4;
      if (ACTOR_GENS.has(resolveGeneratorId(layer.gen).gen?.id ?? "") && (raw.detail === undefined || raw.detail === "auto")) raw.detail = "crowd";
      const built = buildAsset(layer.gen, raw, id, irng);
      if (!built) break;
      if (ACTOR_GENS.has(built.generator) || built.generator === "building" || (tile && built.fresh)) yield undefined;
      const scale = clamp(num(layer.scale, `${lp}.scale`, irng, 1, vars), 0.05, 20) * built.extraScale;
      const r = built.asset.footprint.r * scale;
      const along = "along" in place && place.side !== "center";
      if (along && pos.yaw !== undefined) {
        // le long d'une route : la façade touche le décalage demandé, le centre recule de la demi-profondeur
        const back = built.asset.footprint.hz * scale;
        pos.x -= Math.sin(pos.yaw) * back;
        pos.z -= Math.cos(pos.yaw) * back;
      }
      const across = "across" in place;
      const rr = Math.max(0.2, built.generator === "building" ? Math.min(built.asset.footprint.hx, built.asset.footprint.hz) * scale * 0.95 : r * 0.6);
      if (!("at" in place) && !across && !moved && !free(pos.x, pos.z, rr, !!layer.onPath || along || !!layer.onWater, spacing, !!layer.onWater)) continue;
      let yaw = pos.yaw ?? 0;
      // cap explicite d'un point `at` respecté ; sinon : bâtiments face au chemin, tracés sans rotation, le reste au hasard
      const yw = layer.yaw ?? (built.generator === "building" || across || ("at" in place && pos.yaw !== undefined) ? "path" : built.asset.extra?.segments || built.generator === "structure" || built.generator === "water" ? 0 : "random");
      if (yw === "random") yaw = irng.range(0, Math.PI * 2);
      else if (yw === "center") yaw = Math.atan2(-pos.x, -pos.z);
      else if (yw === "away") yaw = Math.atan2(pos.x, pos.z);
      else if (yw === "path") yaw = pos.yaw ?? facePath(pos.x, pos.z, paths);
      else yaw = num(yw, `${lp}.yaw`, irng, 0, vars) * DEG;
      if (layer.target && ACTOR_GENS.has(built.generator)) startAt = targetPlace(String(layer.target), built.asset, n, `${lp}.target`, layer.action);
      if (physics && !ACTOR_GENS.has(built.generator)) {
        bodyNext = bodyOf(built.generator, built.asset, scale, pos.physics !== undefined ? pos.physics : layer.physics, `${lp}.physics`);
        if (bodyNext && bodyNext.kind !== "static") {
          if (bodiesLeft <= 0) {
            if (bodiesLeft === 0) issues.add({ path: `${lp}.physics`, code: "limit", message: "200 corps physiques au plus : les suivants restent fixes" });
            bodiesLeft--;
            bodyNext = undefined;
          } else bodiesLeft--;
        }
        liftNext = bodyNext ? Math.max(0, Math.min(100, pos.y ?? 0)) : 0;
      }
      placeObject(layer, id, built.asset, built.key, built.generator, { ...(resolveGeneratorId(layer.gen).preset ?? {}), ...raw }, pos.x, pos.z, yaw, scale, irng, layer.behavior, layer.action);
      const placed = objects[objects.length - 1];
      if (placed?.id === id) Object.assign(placed, { place: placeKind(place), index: pos.idx ?? n, ...(layer.onWater ? { onWater: true } : {}), ...(layer.onPath ? { onPath: true } : {}), ...(layer.walkable ? { walkable: true } : {}) });
      n++;
    }
    if (n < count && !("at" in place) && !tile && count > 0) issues.add({ path: `${lp}.count`, code: "info", message: `${n} placés sur ${count} demandés (place libre insuffisante)`, got: count, used: n });
  }

  /* ---------- tuile : objets ajoutés par le joueur ---------- */
  if (tile) for (const [k, a] of (tile.edits?.add ?? []).slice(0, 200).entries()) {
    if (!a || typeof a.gen !== "string" || !Number.isFinite(a.x) || !Number.isFinite(a.z)) continue;
    const id = typeof a.id === "string" && a.id ? a.id : `ajout.${tile.cx}_${tile.cz}_${k}`;
    if (tile.edits?.remove?.includes(id)) continue;
    const arng = root.fork(`ajout/${id}`);
    const raw = (a.params && typeof a.params === "object" ? a.params : {}) as Record<string, unknown>;
    const built = buildAsset(a.gen, raw, `tiles.${tileKey(tile.cx, tile.cz)}.add[${k}]`, arng);
    if (!built || ACTOR_GENS.has(built.generator)) continue;
    const lid = typeof a.layer === "string" && a.layer ? a.layer : "ajouts";
    const scale = clamp(Number.isFinite(a.scale) ? Number(a.scale) : 1, 0.05, 20) * built.extraScale;
    placeObject({ id: lid, gen: a.gen }, id, built.asset, built.key, built.generator, { ...(resolveGeneratorId(a.gen).preset ?? {}), ...raw }, a.x - ox, a.z - oz, (Number(a.yaw) || 0) * DEG, scale, arng);
    const placed = objects[objects.length - 1];
    if (placed?.id === id) Object.assign(placed, { place: "add", index: k });
  }

  /* ---------- acteurs ---------- */
  if (!tile) for (const [aid, a] of Object.entries(recipe.actors ?? {})) {
    yield undefined;
    const arng = root.fork(`actor/${aid}`);
    const raw = { ...(R(a.params ?? {}, `actors.${aid}.params`, arng) as Record<string, unknown>), ...(input.edits?.[aid] ?? {}) };
    const built = buildAsset(a.gen ?? "character", raw, `actors.${aid}`, arng);
    if (!built) continue;
    const at = (R(a.at ?? [0, 0], `actors.${aid}.at`, arng) as number[]) ?? [0, 0];
    const facing = typeof a.facing === "number" ? a.facing * DEG : 0;
    if (a.target) startAt = targetPlace(String(a.target), built.asset, 0, `actors.${aid}.target`, a.action);
    placeObject(null, aid, built.asset, built.key, built.generator, raw, Number(at[0]) || 0, Number(at[1]) || 0, facing, 1, arng, a.behavior, a.action);
    const placedA = objects[objects.length - 1];
    if (placedA?.id === aid) placedA.place = "actor";
  }

  /* ---------- zones ---------- */
  const zones: Zone[] = [];
  for (const [zi, z] of (tile ? [] : recipe.zones ?? []).entries()) {
    if (z.box) {
      const [x0, z0, x1, z1] = z.box.map(Number);
      zones.push({ id: z.id ?? `zone${zi}`, x: (x0 + x1) / 2, z: (z0 + z1) / 2, r: 0, box: [Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)] });
      continue;
    }
    let x = 0, zz = 0;
    if (typeof z.at === "string") {
      const parts = z.at.split(".");
      const anchorName = parts.length > 2 ? parts.slice(2).join(".") : null;
      const o = objects.find((ob) => ob.id === parts.slice(0, 2).join(".")) ?? objects.find((ob) => ob.id === z.at);
      if (!o) {
        issues.add({ path: `zones[${zi}].at`, code: "unknown", message: `objet « ${z.at} » introuvable`, didYouMean: suggest(String(z.at), objects.map((ob) => ob.id)) });
        continue;
      }
      const p = anchorName && o.anchors[anchorName] ? o.anchors[anchorName] : o.pos;
      x = p[0];
      zz = p[2];
    } else if (Array.isArray(z.at)) [x, zz] = z.at.map(Number);
    zones.push({ id: z.id ?? `zone${zi}`, x, z: zz, r: Number(z.r ?? 1.5), box: null });
  }

  /* ---------- sol, eau, routes, AO entre objets ---------- */
  let ground: Mesh | null = null, roads: Mesh | null = null, water: Mesh | null = null;
  if (terrain) {
    // tuile : une étape par passe (le budget par image du monde infini reste tenu)
    if (tile) yield undefined;
    ground = terrain.mesh();
    if (tile) yield undefined;
    contactAO(ground, objects);
    roads = terrain.roadMeshes();
    if (tile) yield undefined;
    if (!roads.vertexCount) roads = null;
    water = terrain.waterMesh();
    // eau et pentes fortes : non navigables
    for (let j = 0; j < nav.nz; j++)
      for (let i = 0; i < nav.nx; i++) {
        const [x, z] = nav.center(i, j);
        if (waterLevel !== null && H(x, z) < waterLevel + 0.05) nav.blocked[j * nav.nx + i] = 1;
        else if (terrain.normal(x, z)[1] < 0.75) nav.blocked[j * nav.nx + i] = 1;
      }
  }
  // tabliers praticables (au-dessus de l'eau, sur les berges en pente), puis garde-corps et piles
  if (structNav.length) {
    for (const sn of structNav)
      for (const w of sn.walks) {
        const c = Math.cos(w.yaw), sn2 = Math.sin(w.yaw);
        const R = (Math.max(Math.abs(w.z0), Math.abs(w.z1)) + w.hw + 1) * w.scale;
        const [i0, j0] = nav.toCell(w.x - R, w.z - R), [i1, j1] = nav.toCell(w.x + R, w.z + R);
        for (let j = Math.max(0, j0); j <= Math.min(nav.nz - 1, j1); j++)
          for (let i = Math.max(0, i0); i <= Math.min(nav.nx - 1, i1); i++) {
            const [px, pz] = nav.center(i, j);
            const dx = (px - w.x) / w.scale, dz = (pz - w.z) / w.scale;
            const lx = dx * c - dz * sn2, lz = dx * sn2 + dz * c;
            if (Math.abs(lx) <= w.hw - 0.15 && lz >= Math.min(w.z0, w.z1) - 0.3 && lz <= Math.max(w.z0, w.z1) + 0.3) nav.blocked[j * nav.nx + i] = 0;
          }
      }
    for (const sn of structNav) for (const [bx, bz, bhx, bhz] of sn.blk) nav.blockBox(bx, bz, bhx, bhz, sn.yaw, 0.15);
  }
  if (ground) {
    total += ground.triangleCount + (roads?.triangleCount ?? 0);
  }

  /* ---------- prairies (brins instanciés, rendu 3D) ---------- */
  let meadows: Meadow[] = [];
  if (tile && recipe.meadows) issues.add({ path: "meadows", code: "info", message: "prairies : pas encore dans les tuiles du monde infini (ignorées)" });
  if (!tile && recipe.meadows !== undefined && recipe.meadows !== null && recipe.meadows !== false) {
    yield undefined;
    const mr = root.fork("meadows");
    const { fields, custom } = readMeadows(R(recipe.meadows, "meadows", mr, {}, []), size, zones, issues);
    if (input.assetBuilder) {
      if (fields.length) issues.add({ path: "meadows", code: "info", message: "prairies : rendu 3D seulement (ignorées en rendu vectoriel)" });
    } else if (fields.length) {
      const obstacles = objects
        .filter((o) => !o.walkable && o.mode !== "actor" && o.generator !== "grass" && o.generator !== "flowers")
        .flatMap((o) => {
          // clôtures, ouvrages : leurs tronçons ; arbres : le tronc seulement (la canopée n'empêche pas l'herbe)
          if (o.blockers?.length) return o.blockers.map(([x, z, hx, hz, yaw]) => ({ x, z, hx, hz, yaw }));
          const k = o.generator === "tree" ? Math.min(1, 0.5 / Math.max(0.01, o.footprint.r)) : 0.92;
          return [{ x: o.pos[0], z: o.pos[2], hx: o.footprint.hx * k, hz: o.footprint.hz * k, yaw: o.yaw }];
        });
      meadows = sowMeadows(fields, custom, meadowBudget(recipe.meadowDetail, !!input.mobile), terrain, meadowKeep(size, terrain, obstacles));
    }
  }

  // tuile : objets, ancres, obstacles, tabliers et instances posés dans le monde ; sol, routes et bâtiments fusionnés
  // restent en repère local (la vue les place), la grille de navigation est décalée
  if (tile) {
    const sh = (p: V3): V3 => [p[0] + ox, p[1], p[2] + oz];
    for (const o of objects) {
      o.pos = sh(o.pos);
      for (const k of Object.keys(o.anchors)) o.anchors[k] = sh(o.anchors[k]);
      if (o.blockers) o.blockers = o.blockers.map(([x, z, hx, hz, yw]) => [x + ox, z + oz, hx, hz, yw]);
    }
    for (const d of decks) {
      d.x += ox;
      d.z += oz;
    }
    for (const g of groups.values())
      for (const m of g.matrices) {
        m[12] += ox;
        m[14] += oz;
      }
    nav.shift(ox, oz);
  }
  const minY = terrain ? Math.min(...objects.map((o) => o.pos[1]), 0) - 1 : 0;
  const maxY = Math.max(2, ...objects.map((o) => o.pos[1] + o.height));
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    size,
    bounds: { min: [ox - size[0] / 2, minY, oz - size[1] / 2], max: [ox + size[0] / 2, maxY, oz + size[1] / 2] },
    terrain,
    ground,
    roads,
    water,
    tiles: [...tiles.values()],
    instances: [...groups.values()],
    actors,
    objects,
    zones,
    lights: objects.filter((o) => o.anchors.light).map((o) => ({ pos: o.anchors.light, kind: String(o.params.kind ?? "") === "campfire" || o.layer.includes("feu") ? "fire" : "lamp", radius: String(o.params.kind ?? "") === "campfire" ? 9 : Math.max(6, (o.anchors.light[1] - o.pos[1]) * 1.9) }) as PointLight),
    nav,
    decks,
    issues: issues.list,
    view: (recipe.view as Record<string, unknown>) ?? {},
    style: recipe.style,
    wind: recipe.wind ?? 1,
    windDir: (typeof recipe.windDir === "number" && Number.isFinite(recipe.windDir) ? recipe.windDir : 67) * DEG,
    meadows,
    physics,
    ...(physics ? { physicsScene } : {}),
    softs,
    stats: { ms: Math.round(t1 - t0), triangles: total, objects: objects.length, instances: [...groups.values()].reduce((s, g) => s + g.matrices.length, 0), actors: actors.length },
  };
}

function facePath(x: number, z: number, paths: PathSpec[]): number {
  let best: { d: number; px: number; pz: number } | null = null;
  for (const p of paths) {
    if (p.kind === "river") continue;
    const r = distToPath(p, x, z);
    if (!best || r.d < best.d) {
      const a = p.points[r.seg], b = p.points[Math.min(p.points.length - 1, r.seg + 1)];
      best = { d: r.d, px: a[0] + (b[0] - a[0]) * r.t, pz: a[1] + (b[1] - a[1]) * r.t };
    }
  }
  return best ? Math.atan2(best.px - x, best.pz - z) : 0;
}

type Pos = { x: number; z: number; yaw?: number; /** Largeur franchie (placement `across`). */ span?: number; /** Hauteur au-dessus du sol (m) et corps d'un point `at`. */ y?: number; physics?: unknown; /** Rang du point dans `at` (monde infini). */ idx?: number };

/** Semis `scatter` dans le carré (x0, z0, côté) du monde, gardé dans `size` (scène finie) ; positions du monde. */
function scatterPositions(sc: { cell?: number; density?: number | string; jitter?: number }, lid: string, seed: string, x0: number, z0: number, side: number, size: [number, number] | null, density: (v: number | string, x: number, z: number) => number): Pos[] {
  const out: Pos[] = [];
  const cell = clamp(Number(sc?.cell) || 4, 0.3, 200);
  const jitter = clamp(Number.isFinite(Number(sc?.jitter)) ? Number(sc.jitter) : 0.8, 0, 1);
  const d = sc?.density ?? 0.6;
  for (const c of cellCandidates(seed, lid, cell, jitter, x0, z0, side)) {
    if (size && (Math.abs(c.x) > size[0] / 2 || Math.abs(c.z) > size[1] / 2)) continue;
    const p = typeof d === "number" ? clamp(d, 0, 1) : density(d, c.x, c.z);
    if (c.rng.next() < p) out.push({ x: c.x, z: c.z });
    if (out.length > 2000) break;
  }
  return out;
}

/**
 * Placements d'une couche dans une tuile (repère local) : semis par cellule du monde, points `at` qui tombent dans la
 * tuile (avec leur rang), placements ancrés au monde (grille, grappe, anneau, le long d'une route) gardés s'ils y
 * tombent, fléchettes et bords tirés dans la tuile.
 */
function tilePlacements(place: Placement, lid: string, count: number, lrng: Rng, tile: TileInput, size: [number, number], paths: PathSpec[], objects: ObjectInfo[], issues: Issues, lp: string, density: (v: number | string, x: number, z: number) => number): Pos[] {
  const [ox, oz] = tile.origin;
  const h = tile.size / 2;
  const inside = (p: Pos) => p.x >= -h && p.x < h && p.z >= -h && p.z < h;
  if ("scatter" in place) {
    return scatterPositions(place.scatter, lid, tile.seed, ox - h, oz - h, tile.size, null, (v, x, z) => density(v, x - ox, z - oz)).map((p) => ({ x: p.x - ox, z: p.z - oz }));
  }
  if ("at" in place) {
    const out: Pos[] = [];
    (place.at ?? []).forEach((a, idx) => {
      let p: Pos | null = null;
      if (Array.isArray(a)) p = { x: (Number(a[0]) || 0) - ox, z: (Number(a[1]) || 0) - oz, idx };
      else if (a && typeof a === "object") p = { x: (Number(a.x) || 0) - ox, z: (Number(a.z) || 0) - oz, yaw: a.yaw !== undefined ? Number(a.yaw) * DEG : undefined, idx };
      if (p && inside(p)) out.push(p);
    });
    return out;
  }
  const rng = lrng.fork(`place/${tile.cx}_${tile.cz}`);
  let local: Placement = place;
  if ("grid" in place) local = { ...place, origin: [(place.origin?.[0] ?? 0) - ox, (place.origin?.[1] ?? 0) - oz] };
  else if ("cluster" in place) local = { ...place, cluster: [place.cluster[0] - ox, place.cluster[1] - oz] };
  else if ("ring" in place) local = { ...place, ring: [place.ring[0] - ox, place.ring[1] - oz] };
  else if ("poisson" in place && Array.isArray(place.poisson)) local = { ...place, poisson: [place.poisson[0] - ox, place.poisson[1] - oz, place.poisson[2] - ox, place.poisson[3] - oz] };
  // le long d'un réseau du monde (`along: "routes"`) : chaque tronçon `routes.<…>` qui touche la tuile
  if ("along" in place && !paths.some((p) => p.id === place.along)) {
    const net = paths.filter((p) => p.id.startsWith(place.along + "."));
    if (net.length) return net.flatMap((p) => placements({ ...place, along: p.id }, count, lrng.fork(`place/${p.id}`), size, [p], objects, issues, lp)).filter(inside);
  }
  // ancrés au monde : même tirage dans toutes les tuiles (rng de la couche), puis filtre
  const anchored = "grid" in place || "cluster" in place || "ring" in place || "along" in place || "across" in place;
  return placements(local, count, anchored ? lrng.fork("place") : rng, size, paths, objects, issues, lp).filter(inside);
}

/**
 * Distance (selon l'avant) du pied de l'acteur à sa bouche quand il boit ou mange à une cible de hauteur `reachY` :
 * calculée sur la pose elle-même (cou baissé), pour poser la bouche au-dessus de l'eau ou de la gamelle.
 */
export function reachOf(asset: Pick<Asset, "anchors" | "generator" | "skeleton">, action: string = "drink", reachY?: number): number {
  const anc = asset.anchors.mouth ?? asset.anchors["head.center"];
  const sk = asset.skeleton;
  if (!anc || !sk) return asset.generator === "character" ? 0.32 : 0.3;
  try {
    const st = { speed: 0, phase: 0, time: 0, action: action as Action, actionTime: 0.5, actionWeight: 1, mood: "neutral", turn: 0, seed: 0, reachY };
    const { pose } = motionFor(asset).pose(st);
    const W = sk.world(pose);
    const bi = sk.index[anc.bone ?? "root"] ?? 0;
    const p = m4Point(W[bi], sub(anc.pos, sk.bones[bi].head));
    return clamp(p[2] + (asset.anchors.mouth ? 0.02 : 0.15), 0.05, 3);
  } catch {
    return 0.3;
  }
}

/** Hauteur du sol praticable : terrain, ou tablier / marche d'un ouvrage au-dessus. */
export function deckHeight(decks: Deck[], x: number, z: number, ground: number): number {
  let h = ground;
  for (const d of decks) {
    const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
    const dx = (x - d.x) / d.scale, dz = (z - d.z) / d.scale;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const pr = d.profile;
    if (Math.abs(lx) > d.hw + 0.25 || lz < pr[0][0] - 0.05 || lz > pr[pr.length - 1][0] + 0.05) continue;
    let y = pr[pr.length - 1][1];
    for (let i = 0; i < pr.length - 1; i++)
      if (lz <= pr[i + 1][0]) {
        const t = (lz - pr[i][0]) / Math.max(1e-6, pr[i + 1][0] - pr[i][0]);
        y = pr[i][1] + (pr[i + 1][1] - pr[i][1]) * clamp(t, 0, 1);
        break;
      }
    h = Math.max(h, d.y + y * d.scale);
  }
  return h;
}

/** Hauteur où marche un acteur dans une scène composée. */
export function groundHeight(model: Pick<SceneModel, "terrain" | "decks">, x: number, z: number, fallback = 0): number {
  const g = model.terrain ? model.terrain.height(x, z) : fallback;
  return model.decks?.length ? deckHeight(model.decks, x, z, g) : g;
}

/** Nom du mode de placement d'une couche (`at`, `grid`, `poisson`…). */
export function placeKind(place: Placement): string {
  for (const k of ["at", "grid", "poisson", "along", "cluster", "ring", "edges", "across", "scatter"]) if (k in place) return k;
  return "poisson";
}

function placements(place: Placement, count: number, rng: Rng, size: [number, number], paths: PathSpec[], objects: ObjectInfo[], issues: Issues, lp: string): Pos[] {
  const out: Pos[] = [];
  const W = size[0] / 2, D = size[1] / 2;
  if ("at" in place) {
    for (const a of place.at ?? []) {
      if (Array.isArray(a)) out.push({ x: Number(a[0]) || 0, z: Number(a[1]) || 0 });
      else if (a && typeof a === "object") out.push({ x: Number(a.x) || 0, z: Number(a.z) || 0, yaw: a.yaw !== undefined ? Number(a.yaw) * DEG : undefined, ...(Number.isFinite(Number(a.y)) && a.y !== undefined ? { y: Number(a.y) } : {}), ...(a.physics !== undefined ? { physics: a.physics } : {}) });
    }
    return out;
  }
  if ("grid" in place) {
    const [nx, nz] = place.grid;
    const [sx, sz] = place.spacing ?? [3, 3];
    const [ox, oz] = place.origin ?? [0, 0];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) out.push({ x: ox + (i - (nx - 1) / 2) * sx, z: oz + (j - (nz - 1) / 2) * sz });
    return out;
  }
  if ("along" in place) {
    const path = paths.find((p) => p.id === place.along);
    // réseau de routes du monde (`along: "routes"`) : chaque tronçon `routes.<…>`
    const net = path ? [] : paths.filter((p) => p.id.startsWith(place.along + "."));
    if (net.length) return net.flatMap((p) => placements({ ...place, along: p.id }, count, rng.fork(`along/${p.id}`), size, [p], objects, issues, lp));
    if (!path) {
      issues.add({ path: `${lp}.place.along`, code: "unknown", message: `route « ${place.along} » inconnue`, didYouMean: suggest(place.along, paths.map((p) => p.id)) });
      return out;
    }
    const L = pointAt(path.points, 0).length;
    const spacing = place.spacing ?? 6;
    const sides = place.side === "left" ? [1] : place.side === "right" ? [-1] : place.side === "center" ? [0] : [1, -1];
    const s0 = (place.start ?? 0) + spacing / 2, s1 = L - (place.end ?? 0);
    for (const side of sides)
      for (let s = s0 + (side < 0 ? spacing * 0.37 : 0); s <= s1; s += spacing) {
        const pt = pointAt(path.points, s + (place.jitter ? rng.range(-1, 1) * place.jitter : 0));
        const nx = -pt.dir[1] * side, nz = pt.dir[0] * side;
        const off = path.width / 2 + (path.kind === "street" ? path.sidewalk : 0) + (place.offset ?? 0.5);
        const x = pt.p[0] + nx * off, z = pt.p[1] + nz * off;
        out.push({ x, z, yaw: side === 0 ? Math.atan2(pt.dir[0], pt.dir[1]) : Math.atan2(-nx, -nz) });
      }
    return out;
  }
  if ("across" in place) {
    const path = paths.find((p) => p.id === place.across);
    if (!path) {
      issues.add({ path: `${lp}.place.across`, code: "unknown", message: `route ou rivière « ${place.across} » inconnue`, didYouMean: suggest(place.across, paths.map((p) => p.id)) });
      return out;
    }
    const L = pointAt(path.points, 0).length;
    // rivière : le lit remonte jusqu'à ≈ 1,1 fois la largeur de chaque côté ; route : chaussée, trottoirs et un mètre
    const span = path.kind === "river" ? path.width * 2.2 + 1 : path.width + (path.kind === "street" ? 2 * path.sidewalk : 0) + 2;
    const sp = place.spacing ?? L / Math.max(1, count);
    const first = place.distance ?? (count > 1 ? (L - sp * (count - 1)) / 2 : L / 2);
    for (let k = 0; k < Math.max(1, count); k++) {
      const pt = pointAt(path.points, clamp(first + k * sp, 0, L));
      // l'ouvrage passe selon son z : perpendiculaire au tracé
      out.push({ x: pt.p[0], z: pt.p[1], yaw: Math.atan2(-pt.dir[1], pt.dir[0]), span });
    }
    return out;
  }
  if ("cluster" in place || "ring" in place) {
    const c = "cluster" in place ? place.cluster : place.ring;
    const r = place.radius ?? 5;
    const n = Math.max(count * 3, 8);
    for (let i = 0; i < n; i++) {
      if ("ring" in place) {
        if (i >= count * 2) break;
        const j = place.jitter ?? 0;
        const a = (i / count) * Math.PI * 2 + (j ? rng.range(-0.3, 0.3) * j : 0);
        const rr = r + (j ? rng.range(-1, 1) * j * 2 : 0);
        out.push({ x: c[0] + Math.cos(a) * rr, z: c[1] + Math.sin(a) * rr });
      } else {
        const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * r;
        out.push({ x: c[0] + Math.cos(a) * d, z: c[1] + Math.sin(a) * d });
      }
    }
    return out;
  }
  if ("edges" in place) {
    const off = place.offset ?? 0.15;
    const n = count * 3;
    const blds = objects.filter((o) => o.generator === "building");
    for (let i = 0; i < n; i++) {
      const usePaths = place.edges === "paths" || (place.edges === "all" && rng.chance(0.5)) || !blds.length;
      if (usePaths && paths.length) {
        const p = rng.pick(paths.filter((q) => q.kind !== "river")) ?? paths[0];
        const L = pointAt(p.points, 0).length;
        const pt = pointAt(p.points, rng.range(0, L));
        const side = rng.chance(0.5) ? 1 : -1;
        const d = p.width / 2 + (p.kind === "street" ? p.sidewalk : 0) + off + rng.range(0, 0.4);
        out.push({ x: pt.p[0] - pt.dir[1] * side * d, z: pt.p[1] + pt.dir[0] * side * d });
      } else if (blds.length) {
        const b = rng.pick(blds);
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        const u = rng.range(-1, 1), side = rng.int(0, 3);
        const lx = side < 2 ? u * b.footprint.hx : (side === 2 ? 1 : -1) * (b.footprint.hx + off);
        const lz = side < 2 ? (side === 0 ? 1 : -1) * (b.footprint.hz - 0.1 + off) : u * b.footprint.hz;
        // lacet sortant du mur (lierre, plantes grimpantes : `yaw: "path"`)
        out.push({ x: b.pos[0] + lx * c + lz * s, z: b.pos[2] - lx * s + lz * c, yaw: b.yaw + [0, Math.PI, Math.PI / 2, -Math.PI / 2][side] });
      }
    }
    return out;
  }
  // poisson (fléchettes)
  const box = Array.isArray((place as { poisson: unknown }).poisson) ? ((place as { poisson: [number, number, number, number] }).poisson) : [-W, -D, W, D];
  const minD = (place as { minDist?: number }).minDist ?? 1;
  const n = Math.max(count * 8, 20);
  for (let i = 0; i < n && out.length < count * 4; i++) {
    const x = rng.range(box[0], box[2]), z = rng.range(box[1], box[3]);
    if (out.every((q) => Math.hypot(q.x - x, q.z - z) >= minD)) out.push({ x, z });
  }
  return out;
}

/** Assombrit le sol au pied des objets (AO entre objets, d'après les emprises). */
function contactAO(ground: Mesh, objects: ObjectInfo[]) {
  const CELL = 4;
  const buckets = new Map<string, ObjectInfo[]>();
  for (const o of objects) {
    if (o.generator === "grass" || o.generator === "flowers" || o.mode === "actor") continue;
    const R = Math.max(o.footprint.hx, o.footprint.hz) + 2;
    for (let i = Math.floor((o.pos[0] - R) / CELL); i <= Math.floor((o.pos[0] + R) / CELL); i++)
      for (let j = Math.floor((o.pos[2] - R) / CELL); j <= Math.floor((o.pos[2] + R) / CELL); j++) {
        const k = `${i},${j}`;
        (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(o);
      }
  }
  for (let v = 0; v < ground.vertexCount; v++) {
    const x = ground.pos[v * 3], z = ground.pos[v * 3 + 2];
    const list = buckets.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) continue;
    let occ = 0;
    for (const o of list) {
      const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
      const dx = x - o.pos[0], dz = z - o.pos[2];
      const lx = Math.abs(dx * c - dz * s) - o.footprint.hx, lz = Math.abs(dx * s + dz * c) - o.footprint.hz;
      const d = Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) + Math.min(Math.max(lx, lz), 0);
      const reach = clamp(o.height * 0.35, 0.3, 2.2);
      occ = Math.max(occ, Math.exp(-Math.max(0, d) / (reach * 0.5)) * (d < 0 ? 0.9 : 0.6));
    }
    ground.ao[v] *= 1 - occ * 0.6;
  }
}
