/**
 * Composition d'une scène (CPU, pur, sans DOM) : recette + graine + paramètres → `SceneModel` prêt à rendre.
 *
 * Recette (JSON) : `params` (paramètres exposés), `size`, `ground`, `paths`, `layers` (générateur + placement),
 * `zones`, `actors`, `view`, `style`, `wind`. Les nombres peuvent être des expressions `"= …"`. Chaque objet placé
 * reçoit un id stable `<couche>.<n>` ; les problèmes sont rassemblés dans `issues` (rendu partiel, jamais d'écran noir).
 *
 * Statiques uniques (bâtiments) : fusionnés par tuile spatiale ; objets répétés (arbres, rochers, objets) : instanciés ;
 * personnages : acteurs animés.
 */
import { type M4, type V3, DEG, clamp, m4Compose, m4Point, qAxis } from "../core/math";
import { resolveDeep, type Scope } from "../core/expr";
import { Rng } from "../core/rng";
import { type Issue, Issues, resolveParams, suggest } from "../core/schema";
import { Mesh } from "../geom/mesh";
import { GENERATORS, resolveGeneratorId } from "../gen/index";
import type { Asset } from "../gen/types";
import { ACTIONS, type Action } from "../rig/locomotion";
import { NavGrid } from "./nav";
import { type GroundSpec, type PathKind, type PathSpec, Terrain, distToPath, pointAt } from "./terrain";

export type Placement =
  | { at: ([number, number] | { x: number; z: number; yaw?: number })[] }
  | { grid: [number, number]; spacing: [number, number]; origin?: [number, number] }
  | { poisson: true | [number, number, number, number]; minDist?: number }
  | { along: string; side?: "both" | "left" | "right" | "center"; spacing?: number; offset?: number; jitter?: number; start?: number; end?: number }
  | { cluster: [number, number]; radius: number }
  | { ring: [number, number]; radius: number; jitter?: number }
  | { edges: "buildings" | "paths" | "all"; offset?: number };

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
};

export type ActorSpec = { gen?: string; params?: Record<string, unknown>; at?: [number, number]; facing?: number | string; behavior?: "idle" | "wander" | "patrol"; action?: string; speed?: number };

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
};

export type InstanceGroup = { key: string; mesh: Mesh; matrices: M4[]; objs: number[]; flex: boolean };
export type ActorModel = { id: string; layer: string | null; asset: Asset; params: Record<string, unknown>; pos: V3; yaw: number; behavior: "idle" | "wander" | "patrol"; action: Action; speed: number; obj: number; seed: number };
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
  issues: Issue[];
  view: Record<string, unknown>;
  style: unknown;
  wind: number;
  stats: { ms: number; triangles: number; objects: number; instances: number; actors: number };
};

/** Générateurs animés (acteurs skinnés, jamais mis en cache ni instanciés). */
const ACTOR_GENS = new Set(["character", "animal"]);
const INSTANCEABLE = new Set(["tree", "bush", "grass", "flowers", "rock", "prop", "emblem"]);
/** Paramètre de taille converti en échelle d'instance, et sa valeur de référence. */
const SCALE_PARAM: Record<string, { name: string; ref: number }> = { tree: { name: "height", ref: 7 }, bush: { name: "size", ref: 1 }, grass: { name: "size", ref: 0.35 }, rock: { name: "size", ref: 1.5 }, flowers: { name: "size", ref: 1 }, emblem: { name: "size", ref: 1 } };
const TILE = 24;
const MAX_ITEMS = 1500;

export type ComposeInput = {
  recipe: Recipe;
  seed?: string | number;
  params?: Record<string, unknown>;
  edits?: Record<string, Record<string, unknown>>;
  /** Construction d'asset de remplacement (mode vectoriel : emprises et squelettes sans maillage) ; `null` = générateur réel. */
  assetBuilder?: (generator: string, params: Record<string, unknown>, ctx: import("../gen/types").GenContext) => Asset | null;
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

function* composeSteps(input: ComposeInput): Generator<[number, number] | undefined, SceneModel> {
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

  const sizeR = recipe.size ?? [40, 30];
  const size: [number, number] = [clamp(num(sizeR[0], "size[0]", root, 40), 4, 400), clamp(num(sizeR[1], "size[1]", root, 30), 4, 400)];
  // routes
  const paths: PathSpec[] = (recipe.paths ?? []).map((p, i) => ({
    id: p.id ?? `path${i}`,
    points: (R(p.points, `paths[${i}].points`, root) as [number, number][]).filter((q) => Array.isArray(q)).map((q) => [Number(q[0]) || 0, Number(q[1]) || 0] as [number, number]),
    width: num(p.width, `paths[${i}].width`, root, 4),
    kind: (["street", "road", "path", "river", "plaza"] as const).includes(p.kind as PathKind) ? (p.kind as PathKind) : "street",
    sidewalk: num(p.sidewalk, `paths[${i}].sidewalk`, root, p.kind === "street" || !p.kind ? 1.8 : 0),
  }));
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
        coast: (["north", "south", "east", "west"] as const).includes(g.coast as "north") ? (g.coast as GroundSpec["coast"]) : null,
        coastAt: num(g.coastAt, "ground.coastAt", root, 0.2),
        coastDepth: num(g.coastDepth, "ground.coastDepth", root, 3),
      },
      paths,
    );
  }
  const H = (x: number, z: number) => (terrain ? terrain.height(x, z) : 0);
  const waterLevel = terrain?.spec.water ?? null;

  const objects: ObjectInfo[] = [];
  const actors: ActorModel[] = [];
  const tiles = new Map<string, Mesh>();
  const groups = new Map<string, InstanceGroup>();
  const assetCache = new Map<string, Asset>();
  const placedCircles: { x: number; z: number; r: number }[] = [];
  const nav = new NavGrid(size[0], size[1], 0.5);
  let total = 0;

  const free = (x: number, z: number, r: number, onPath: boolean, spacing: number, onWater = false) => {
    if (Math.abs(x) > size[0] / 2 - r * 0.3 || Math.abs(z) > size[1] / 2 - r * 0.3) return false;
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

  const buildAsset = (genId: string, params: Record<string, unknown>, path: string, rng: Rng): { asset: Asset; key: string; generator: string; resolved: Record<string, unknown>; extraScale: number } | null => {
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
      for (const [k, v] of Object.entries(resolved)) if (typeof v === "number" && k !== "variant" && gen.schema[k]?.type === "number") resolved[k] = Math.round(v * 4) / 4;
    }
    const key = `${gen.id}|${JSON.stringify(resolved)}`;
    let asset = ACTOR_GENS.has(gen.id) ? undefined : assetCache.get(key);
    if (!asset) {
      try {
        asset = input.assetBuilder?.(gen.id, resolved, { rng, issues, path }) ?? gen.build(resolved as never, { rng, issues, path });
      } catch (e) {
        issues.add({ path, code: "info", message: `échec du générateur : ${(e as Error).message}` });
        return null;
      }
      if (!ACTOR_GENS.has(gen.id)) assetCache.set(key, asset);
    }
    return { asset, key, generator: gen.id, resolved, extraScale };
  };

  const placeObject = (layer: LayerSpec | null, id: string, asset: Asset, key: string, generator: string, rawParams: Record<string, unknown>, x: number, z: number, yaw: number, scale: number, rng: Rng, behavior?: string, action?: string) => {
    const fp = asset.footprint;
    // posé sur le point le plus bas de l'emprise (pas d'objet flottant), légèrement enfoncé
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => [x + (a * fp.hx * c + b * fp.hz * s) * scale, z + (-a * fp.hx * s + b * fp.hz * c) * scale]);
    const y = layer?.onWater && waterLevel !== null ? waterLevel - 0.15 : generator === "building" ? Math.min(H(x, z), ...corners.map(([cx, cz]) => H(cx, cz))) - 0.05 : H(x, z) - 0.02;
    const obj = objects.length + 1;
    const T = m4Compose([x, y, z], qAxis([0, 1, 0], yaw), scale);
    const anchors: Record<string, V3> = {};
    for (const [k, a] of Object.entries(asset.anchors)) anchors[k] = m4Point(T, a.pos);
    const isActor = ACTOR_GENS.has(generator);
    const mode: ObjectInfo["mode"] = isActor ? "actor" : INSTANCEABLE.has(generator) ? "instance" : "static";
    objects.push({ id, layer: layer?.id ?? "actors", generator, params: rawParams, pos: [x, y, z], yaw, scale, footprint: { hx: fp.hx * scale, hz: fp.hz * scale, r: fp.r * scale }, height: asset.height * scale, obj, mode, anchors });
    placedCircles.push({ x, z, r: Math.max(0.15, (generator === "building" ? Math.max(fp.hx, fp.hz) : fp.r * 0.6) * scale) });
    if (!layer?.walkable && generator !== "grass" && generator !== "flowers" && !isActor) nav.blockBox(x, z, fp.hx * scale, fp.hz * scale, yaw, 0.25);
    if (isActor) {
      const beh = (["idle", "wander", "patrol"] as const).includes(behavior as never) ? (behavior as ActorModel["behavior"]) : "idle";
      const act = (ACTIONS as readonly string[]).includes(action ?? "") ? (action as Action) : "idle";
      if (action && act !== action) issues.add({ path: `${id}.action`, code: "unknown", message: `action « ${action} » inconnue`, didYouMean: suggest(action, ACTIONS), hint: ACTIONS.join(", ") });
      actors.push({ id, layer: layer?.id ?? null, asset, params: rawParams, pos: [x, y, z], yaw, behavior: beh, action: act, speed: 0, obj, seed: rng.next() * 1000 });
      return;
    }
    total += asset.mesh.triangleCount;
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
      t.append(asset.mesh, T, { obj });
    }
  };

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
    const asked = Math.round(clamp(num(layer.count, `${lp}.count`, lrng, 1), 0, 400));
    const positions = placements(place, asked, lrng.fork("place"), size, paths, objects, issues, lp);
    const count = "at" in place || "grid" in place ? Math.min(positions.length, layer.count === undefined ? positions.length : asked) : asked;
    const spacing = layer.spacing ?? 1;
    let n = 0;
    for (let i = 0; i < positions.length && n < count; i++) {
      if (objects.length >= MAX_ITEMS) {
        issues.add({ path: lp, code: "limit", message: `limite de ${MAX_ITEMS} objets atteinte` });
        break;
      }
      const pos = positions[i];
      const id = `${lid}.${n}`;
      const irng = lrng.fork(n);
      const vars = { i: n, n: count, t: count > 1 ? n / (count - 1) : 0, x: pos.x, z: pos.z };
      const edits = input.edits?.[id] ?? input.edits?.[lid];
      const raw = { ...(R(layer.params ?? {}, `${lp}.params`, irng, vars, 0) as Record<string, unknown>), ...(edits ?? {}) };
      if (ACTOR_GENS.has(resolveGeneratorId(layer.gen).gen?.id ?? "") && (raw.detail === undefined || raw.detail === "auto")) raw.detail = "crowd";
      const built = buildAsset(layer.gen, raw, id, irng);
      if (!built) break;
      if (ACTOR_GENS.has(built.generator) || built.generator === "building") yield undefined;
      const scale = clamp(num(layer.scale, `${lp}.scale`, irng, 1, vars), 0.05, 20) * built.extraScale;
      const r = built.asset.footprint.r * scale;
      const along = "along" in place && place.side !== "center";
      if (along && pos.yaw !== undefined) {
        // le long d'une route : la façade touche le décalage demandé, le centre recule de la demi-profondeur
        const back = built.asset.footprint.hz * scale;
        pos.x -= Math.sin(pos.yaw) * back;
        pos.z -= Math.cos(pos.yaw) * back;
      }
      const rr = Math.max(0.2, built.generator === "building" ? Math.min(built.asset.footprint.hx, built.asset.footprint.hz) * scale * 0.95 : r * 0.6);
      if (!("at" in place) && !free(pos.x, pos.z, rr, !!layer.onPath || along || !!layer.onWater, spacing, !!layer.onWater)) continue;
      let yaw = pos.yaw ?? 0;
      const yw = layer.yaw ?? (built.generator === "building" ? "path" : "random");
      if (yw === "random") yaw = irng.range(0, Math.PI * 2);
      else if (yw === "center") yaw = Math.atan2(-pos.x, -pos.z);
      else if (yw === "away") yaw = Math.atan2(pos.x, pos.z);
      else if (yw === "path") yaw = pos.yaw ?? facePath(pos.x, pos.z, paths);
      else yaw = num(yw, `${lp}.yaw`, irng, 0, vars) * DEG;
      placeObject(layer, id, built.asset, built.key, built.generator, raw, pos.x, pos.z, yaw, scale, irng, layer.behavior, layer.action);
      n++;
    }
    if (n < count && !("at" in place) && count > 0) issues.add({ path: `${lp}.count`, code: "info", message: `${n} placés sur ${count} demandés (place libre insuffisante)`, got: count, used: n });
  }

  /* ---------- acteurs ---------- */
  for (const [aid, a] of Object.entries(recipe.actors ?? {})) {
    yield undefined;
    const arng = root.fork(`actor/${aid}`);
    const raw = { ...(R(a.params ?? {}, `actors.${aid}.params`, arng) as Record<string, unknown>), ...(input.edits?.[aid] ?? {}) };
    const built = buildAsset(a.gen ?? "character", raw, `actors.${aid}`, arng);
    if (!built) continue;
    const at = (R(a.at ?? [0, 0], `actors.${aid}.at`, arng) as number[]) ?? [0, 0];
    const facing = typeof a.facing === "number" ? a.facing * DEG : 0;
    placeObject(null, aid, built.asset, built.key, built.generator, raw, Number(at[0]) || 0, Number(at[1]) || 0, facing, 1, arng, a.behavior, a.action);
  }

  /* ---------- zones ---------- */
  const zones: Zone[] = [];
  for (const [zi, z] of (recipe.zones ?? []).entries()) {
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
    ground = terrain.mesh();
    contactAO(ground, objects);
    roads = terrain.roadMeshes();
    if (!roads.vertexCount) roads = null;
    water = terrain.waterMesh();
    // eau et pentes fortes : non navigables
    for (let j = 0; j < nav.nz; j++)
      for (let i = 0; i < nav.nx; i++) {
        const [x, z] = nav.center(i, j);
        if (waterLevel !== null && H(x, z) < waterLevel + 0.05) nav.blocked[j * nav.nx + i] = 1;
        else if (terrain.normal(x, z)[1] < 0.75) nav.blocked[j * nav.nx + i] = 1;
      }
    total += ground.triangleCount + (roads?.triangleCount ?? 0);
  }

  const minY = terrain ? Math.min(...objects.map((o) => o.pos[1]), 0) - 1 : 0;
  const maxY = Math.max(2, ...objects.map((o) => o.pos[1] + o.height));
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    size,
    bounds: { min: [-size[0] / 2, minY, -size[1] / 2], max: [size[0] / 2, maxY, size[1] / 2] },
    terrain,
    ground,
    roads,
    water,
    tiles: [...tiles.values()],
    instances: [...groups.values()],
    actors,
    objects,
    zones,
    lights: objects.filter((o) => o.anchors.light).map((o) => ({ pos: o.anchors.light, kind: String(o.params.kind ?? "") === "campfire" || o.layer.includes("feu") ? "fire" : "lamp", radius: String(o.params.kind ?? "") === "campfire" ? 9 : 6 }) as PointLight),
    nav,
    issues: issues.list,
    view: (recipe.view as Record<string, unknown>) ?? {},
    style: recipe.style,
    wind: recipe.wind ?? 1,
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

type Pos = { x: number; z: number; yaw?: number };

function placements(place: Placement, count: number, rng: Rng, size: [number, number], paths: PathSpec[], objects: ObjectInfo[], issues: Issues, lp: string): Pos[] {
  const out: Pos[] = [];
  const W = size[0] / 2, D = size[1] / 2;
  if ("at" in place) {
    for (const a of place.at ?? []) {
      if (Array.isArray(a)) out.push({ x: Number(a[0]) || 0, z: Number(a[1]) || 0 });
      else if (a && typeof a === "object") out.push({ x: Number(a.x) || 0, z: Number(a.z) || 0, yaw: a.yaw !== undefined ? Number(a.yaw) * DEG : undefined });
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
        out.push({ x: b.pos[0] + lx * c + lz * s, z: b.pos[2] - lx * s + lz * c });
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
