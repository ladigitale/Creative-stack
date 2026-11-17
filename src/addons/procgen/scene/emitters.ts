/**
 * Émetteurs de `sonic-procgen` (CPU, pur, sans DOM) : projectiles et nuées du format monde (`shared/sim`), dont
 * l'apparence vient des générateurs procgen (`animal.pigeon`, `ball.soccer`, `prop.crate`…) ou de formes légères
 * (`shape` : boule de feu, flèche, oiseau, papillon, abeille, poisson, rat…).
 *
 * Chaque variante est figée en quelques **images** (battement d'ailes, foulée, queue qui ondule) : le rendu choisit
 * l'image d'une copie selon le temps et sa phase, et dessine chaque image en une instanciation. Aucune animation par
 * copie côté CPU, aucun squelette au rendu : des centaines d'individus pour quelques appels de dessin.
 */
import { type Q, type V3, DEG, clamp, m4Compose, qAxis, qMul } from "../core/math";
import { Rng } from "../core/rng";
import { type Issue, Issues, resolveParams, suggest } from "../core/schema";
import { Mesh } from "../geom/mesh";
import { cylinder, ellipsoid, icosphere } from "../geom/prims";
import { GENERATORS, resolveGeneratorId } from "../gen/index";
import type { Asset } from "../gen/types";
import { motionFor } from "../rig/motion";
import { type Pose, dqSkinPoint, dualQuat } from "../rig/skeleton";
import { ROLE, type Role, roleIndex } from "../style/roles";
import { type EmitIssue, type EmitterSpec, EMIT_LIMITS, readEmitters } from "../../../shared/sim/emitter";

/** Formes légères (quelques dizaines de triangles), animées par images quand elles ont des ailes, une queue… */
export const SHAPES = ["sphere", "stone", "fireball", "arrow", "dart", "bird", "butterfly", "bee", "fish", "rat", "leaf"] as const;
export type Shape = (typeof SHAPES)[number];

/** Apparence montée d'un émetteur : images par variante (maillages au repos centrés selon le comportement). */
export type EmitLook = {
  id: string;
  /** `variants[v][f]` : image `f` de la variante `v`. */
  variants: { frames: Mesh[]; colors?: Partial<Record<Role, string>> }[];
  /** Cadence des images (cycles par seconde ; 0 : image fixe). */
  flap: number;
  /** Rotation propre des projectiles (rad/s autour de l'axe latéral : culbute d'une pierre, d'un ballon). */
  spin: number;
  /** Triangles d'une copie (première image). */
  triangles: number;
};

export type ProcgenEmitters = { specs: EmitterSpec[]; looks: EmitLook[]; issues: Issue[]; key: string };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Images par cycle (4 suffisent à l'œil à ces tailles ; 1 sans articulation). */
const FRAMES = 4;
/** Budget de triangles de toutes les copies d'un émetteur : au-delà, le modèle est allégé (regroupement de sommets). */
const EMIT_TRI_BUDGET = 80_000;
/** En dessous, un modèle n'est jamais allégé. */
const MIN_TRIS = 250;
/** Générateurs trop lourds pour des centaines de copies : refusés (bâtiments, ouvrages, murs). */
const REFUSED = new Set(["building", "structure", "wall", "water"]);

/** Cache des apparences construites (clé : générateur, paramètres, graine, comportement) : un émetteur relu ne recalcule rien. */
const cache = new Map<string, EmitLook["variants"][number]>();
const CACHE_MAX = 48;
function remember(k: string, v: EmitLook["variants"][number]) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(k, v);
}

/**
 * Fusion des émetteurs de la recette et de ceux du DataProvider (`emitters` : par id, champs remplacés ; `null`
 * retire l'émetteur de la recette).
 */
export function mergeEmitters(recipe: unknown, live: unknown): Json | undefined {
  if (recipe === undefined && live === undefined) return undefined;
  const out: Json = {};
  if (isObj(recipe)) for (const [k, v] of Object.entries(recipe)) out[k] = v;
  if (isObj(live))
    for (const [k, v] of Object.entries(live)) {
      if (v === null) delete out[k];
      else out[k] = isObj(out[k]) && isObj(v) ? { ...(out[k] as Json), ...v } : v;
    }
  return out;
}

/**
 * Lecture des émetteurs (`recipe.emitters` fusionné avec `emitters` du DataProvider) et construction de leur
 * apparence. `quality` (0 à 1, 0,5 sur mobile) réduit `max`, `spawn.count` et `rate` (sauf `mobile` propre à
 * l'émetteur).
 */
export function readProcgenEmitters(src: unknown, opts: { seed?: string | number; quality?: number } = {}): ProcgenEmitters {
  const issues = new Issues();
  const q = clamp(opts.quality ?? 1, 0.05, 1);
  if (src === undefined || src === null) return { specs: [], looks: [], issues: [], key: "" };
  if (!isObj(src)) {
    issues.add({ path: "emitters", code: "type", message: "objet {id: {gen | shape, …}} attendu" });
    return { specs: [], looks: [], issues: issues.list, key: "" };
  }
  const prepared: Json = {};
  const meta = new Map<string, { lod: number; gen: string; shape: Shape | ""; params: Json; variants: number; flap: number | null; spin: number; size: number | null; color: string; color2: string }>();
  for (const [id, raw] of Object.entries(src)) {
    const path = `emitters.${id}`;
    if (!isObj(raw)) {
      issues.add({ path, code: "type", message: "objet {gen | shape, …} attendu" });
      continue;
    }
    const shapeIn = typeof raw.shape === "string" ? raw.shape : "";
    const genIn = typeof raw.gen === "string" ? raw.gen : typeof raw.model === "string" ? raw.model : "";
    let shape: Shape | "" = "";
    let gen = "";
    if (shapeIn) {
      if ((SHAPES as readonly string[]).includes(shapeIn)) shape = shapeIn as Shape;
      else issues.add({ path: `${path}.shape`, code: "unknown", message: `forme « ${shapeIn} » inconnue`, didYouMean: suggest(shapeIn, SHAPES), hint: SHAPES.join(", ") });
    }
    if (!shape && genIn) {
      const g = resolveGeneratorId(genIn).gen;
      if ((SHAPES as readonly string[]).includes(genIn)) shape = genIn as Shape;
      else if (!g) issues.add({ path: `${path}.gen`, code: "unknown", message: `générateur « ${genIn} » inconnu`, didYouMean: suggest(genIn, [...Object.keys(GENERATORS), ...SHAPES]), hint: `${Object.keys(GENERATORS).join(", ")} ; formes : ${SHAPES.join(", ")}` });
      else if (REFUSED.has(g.id)) issues.add({ path: `${path}.gen`, code: "limit", message: `« ${g.id} » est trop lourd pour un émetteur (bâtiments, ouvrages, murs, points d'eau)` });
      else gen = genIn;
    }
    if (!shape && !gen) {
      if (!shapeIn && !genIn) issues.add({ path, code: "missing", message: "gen (générateur procgen, ex. animal.pigeon) ou shape (forme légère) attendu", hint: SHAPES.join(", ") });
      continue;
    }
    // réduction mobile : moins de copies, même comportement
    const k = fin(raw.mobile) ? clamp(raw.mobile, 0.05, 1) : q;
    const r: Json = { ...raw, model: shape || gen };
    if (k < 1) {
      if (fin(raw.max)) r.max = Math.max(1, Math.ceil(raw.max * k));
      else r.max = Math.max(1, Math.ceil((isObj(raw.flock) || raw.behavior === "flock" ? 100 : 64) * k));
      if (isObj(raw.spawn) && fin(raw.spawn.count)) r.spawn = { ...raw.spawn, count: Math.ceil(raw.spawn.count * k) };
      if (fin(raw.rate)) r.rate = raw.rate * k;
    }
    prepared[id] = r;
    meta.set(id, {
      gen,
      shape,
      params: isObj(raw.params) ? raw.params : {},
      variants: fin(raw.variants) ? clamp(Math.round(raw.variants), 1, EMIT_LIMITS.variants) : 1,
      lod: raw.lod === false || raw.lod === "off" ? 0 : fin(raw.lod) ? clamp(Math.round(raw.lod), MIN_TRIS, 20000) : -1,
      flap: fin(raw.flap) ? clamp(raw.flap, 0, 30) : null,
      spin: fin(raw.spin) ? clamp(raw.spin, -2000, 2000) * DEG : 0,
      size: fin(raw.size) ? clamp(raw.size, 0.01, 10) : null,
      color: typeof raw.color === "string" ? raw.color : "",
      color2: typeof raw.color2 === "string" ? raw.color2 : "",
    });
  }
  const emIssues: EmitIssue[] = [];
  const specs = readEmitters(prepared, 1, emIssues);
  for (const e of emIssues) issues.add({ path: e.path, code: "info", message: e.message });
  const seed = String(opts.seed ?? 1);
  const looks: EmitLook[] = [];
  const kept: EmitterSpec[] = [];
  for (const spec of specs) {
    const m = meta.get(spec.id)!;
    const flying = spec.behavior === "ballistic" || !!spec.flock?.altitude || !spec.ground;
    const variants: EmitLook["variants"] = [];
    for (let v = 0; v < m.variants; v++) {
      // allègement : budget de triangles partagé par les copies (`lod` : triangles visés par copie, `false` : aucun)
      const target = m.shape || m.lod === 0 ? 0 : m.lod > 0 ? m.lod : Math.max(MIN_TRIS, Math.floor((EMIT_TRI_BUDGET * q) / spec.max));
      const key = JSON.stringify([m.gen, m.shape, m.params, m.size, m.color, m.color2, seed, spec.id, v, spec.behavior, flying, target]);
      let built: EmitLook["variants"][number] | null | undefined = cache.get(key);
      if (!built) {
        const rng = new Rng(`${seed}/emit/${spec.id}/${v}`);
        built = m.shape ? shapeLook(m.shape, m.size, m.color, m.color2, rng) : genLook(m.gen, m.params, rng, issues, `emitters.${spec.id}`, v, m.variants, flying, spec);
        if (!built) break;
        if (spec.behavior === "ballistic" && !m.shape) built = { ...built, frames: built.frames.map((f) => centered(f)) };
        if (target && built.frames[0].triangleCount > target) built = { ...built, frames: built.frames.map((f) => lighten(f, target)) };
        remember(key, built);
      }
      variants.push(built);
    }
    if (!variants.length) continue;
    // une variante par apparence : la simulation tire la variante de chaque copie
    spec.variants = variants.map((_, v) => ({ model: `${spec.model}#${v}`, roles: {} }));
    const frames = variants[0].frames.length;
    const defFlap = m.shape ? SHAPE_FLAP[m.shape] : spec.flock?.altitude || spec.behavior === "ballistic" ? 5 : 2.2;
    looks.push({ id: spec.id, variants, flap: frames > 1 ? (m.flap ?? defFlap) : 0, spin: m.spin, triangles: variants[0].frames[0].triangleCount });
    kept.push(spec);
  }
  return { specs: kept, looks, issues: issues.list, key: JSON.stringify(prepared) };
}

/* ------------------------------------------------------------------ générateurs procgen */

function genLook(genId: string, params: Json, rng: Rng, issues: Issues, path: string, v: number, n: number, flying: boolean, spec: EmitterSpec): EmitLook["variants"][number] | null {
  const { gen, preset } = resolveGeneratorId(genId);
  if (!gen) return null;
  const given: Json = { ...preset, ...params };
  // maillage de foule : des centaines de copies
  if ((gen.id === "animal" || gen.id === "character") && given.detail === undefined) given.detail = "crowd";
  const resolved = resolveParams(gen.schema, given, { rng, vars: { i: v, n } }, issues, `${path}.params`) as Json;
  const vs = gen.schema.variant as { max?: number } | undefined;
  if (vs && resolved.variant === -1) resolved.variant = rng.int(0, vs.max ?? 3);
  let asset: Asset;
  try {
    asset = gen.build(resolved as never, { rng, issues, path });
  } catch (e) {
    issues.add({ path, code: "info", message: `échec du générateur : ${(e as Error).message}` });
    return null;
  }
  if (!asset.mesh.vertexCount) return null;
  if (!asset.skeleton) return { frames: [asset.mesh], colors: asset.colors };
  return { frames: bakeFrames(asset, flying, spec), colors: asset.colors };
}

/** Images d'un modèle articulé : battement d'ailes (oiseau en vol), sinon foulée de marche. */
function bakeFrames(asset: Asset, flying: boolean, spec: EmitterSpec): Mesh[] {
  const sk = asset.skeleton!;
  const mo = motionFor(asset);
  const wings = sk.has("wing.l") && sk.has("wing.r");
  const out: Mesh[] = [];
  const speed = spec.flock ? (spec.flock.speed[0] + spec.flock.speed[1]) / 2 : 1;
  for (let f = 0; f < FRAMES; f++) {
    const t = f / FRAMES;
    const fly = flying && wings;
    const st = { speed: fly ? 0 : Math.max(0.6, speed), phase: t, time: t, action: "idle" as const, actionTime: 0, actionWeight: 0, mood: "calm", turn: 0, seed: 1 };
    const pose = mo.pose(st as never, [0, 0, 0], 0).pose as Pose;
    if (fly) {
      // ailes déployées puis battues (repère du modèle : x = gauche, z = avant), pattes repliées sous le corps
      const a = Math.sin(t * Math.PI * 2) * 50 * DEG;
      for (const [s, sg] of [["l", 1], ["r", -1]] as const) {
        const spread: Q = qAxis([0, 0, 1], sg * (a - 10 * DEG));
        const open: Q = qAxis([0, 1, 0], -sg * 80 * DEG);
        pose.rot[`wing.${s}`] = qMul(spread, open);
        for (const b of [`thigh.${s}`, `shin.${s}`]) if (sk.has(b)) pose.rot[b] = qAxis([1, 0, 0], (b.startsWith("thigh") ? 50 : -60) * DEG);
      }
    }
    out.push(skinned(asset.mesh, sk, pose, fly ? -asset.height * 0.5 : 0));
  }
  return out;
}

/** Maillage figé dans une pose (skinning dual-quaternion sur le CPU, une fois) ; `dy` décale verticalement. */
function skinned(m: Mesh, sk: NonNullable<Asset["skeleton"]>, pose: Pose, dy = 0): Mesh {
  const dq = sk.skinMatrices(sk.world(pose)).map(dualQuat);
  const out = m.clone();
  out.skin = null;
  out.weight = null;
  out.morph = null;
  for (let v = 0; v < m.vertexCount; v++) {
    const idx = m.skin!.slice(v * 4, v * 4 + 4), w = m.weight!.slice(v * 4, v * 4 + 4);
    const p = m.getPos(v), n = m.getNrm(v);
    const q = dqSkinPoint(p, dq, idx, w);
    const qn = dqSkinPoint([p[0] + n[0], p[1] + n[1], p[2] + n[2]], dq, idx, w);
    out.setPos(v, [q[0], q[1] + dy, q[2]]);
    const nx = qn[0] - q[0], ny = qn[1] - q[1], nz = qn[2] - q[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    out.setNrm(v, [nx / l, ny / l, nz / l]);
  }
  return out;
}

/**
 * Allège un maillage par regroupement de sommets sur une grille (même rôle de couleur seulement) : la grille grossit
 * jusqu'à passer sous `target` triangles. Silhouette et couleurs gardées ; détails fins (doigts, yeux) fondus.
 */
export function lighten(m: Mesh, target: number): Mesh {
  const b = m.bounds();
  const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  let out = m;
  for (let div = 48; div >= 6 && out.triangleCount > target; div = Math.floor(div * 0.75)) out = cluster(m, ext / div);
  return out;
}

function cluster(m: Mesh, cell: number): Mesh {
  const out = new Mesh();
  const map = new Map<string, number>();
  const acc: number[] = [], cnt: number[] = [];
  const remap = new Int32Array(m.vertexCount);
  for (let v = 0; v < m.vertexCount; v++) {
    const x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2];
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)},${m.role[v]}`;
    let id = map.get(k);
    if (id === undefined) {
      id = out.vertex([0, 0, 0], [0, 1, 0], m.role[v], m.ao[v], m.flex[v]);
      map.set(k, id);
      acc.push(0, 0, 0);
      cnt.push(0);
    }
    acc[id * 3] += x;
    acc[id * 3 + 1] += y;
    acc[id * 3 + 2] += z;
    cnt[id]++;
    remap[v] = id;
  }
  for (let i = 0; i < cnt.length; i++) out.setPos(i, [acc[i * 3] / cnt[i], acc[i * 3 + 1] / cnt[i], acc[i * 3 + 2] / cnt[i]]);
  const seen = new Set<string>();
  for (let t = 0; t < m.idx.length; t += 3) {
    const a = remap[m.idx[t]], c = remap[m.idx[t + 1]], d = remap[m.idx[t + 2]];
    if (a === c || c === d || a === d) continue;
    const k = [a, c, d].sort((x, y) => x - y).join(",");
    if (seen.has(k)) continue;
    seen.add(k);
    out.tri(a, c, d);
  }
  return out.computeNormals();
}

/** Recentre un modèle posé au sol sur son milieu (un projectile vole par son centre). */
function centered(m: Mesh): Mesh {
  const b = m.bounds();
  const cy = (b.min[1] + b.max[1]) / 2;
  return m.clone().mapPos((p) => [p[0], p[1] - cy, p[2]]);
}

/* ------------------------------------------------------------------ formes légères */

const SHAPE_SIZE: Record<Shape, number> = { sphere: 0.3, stone: 0.15, fireball: 0.45, arrow: 0.8, dart: 0.3, bird: 0.35, butterfly: 0.1, bee: 0.03, fish: 0.3, rat: 0.25, leaf: 0.08 };
const SHAPE_FLAP: Record<Shape, number> = { sphere: 0, stone: 0, fireball: 9, arrow: 0, dart: 0, bird: 4, butterfly: 7, bee: 18, fish: 2.5, rat: 5, leaf: 1.2 };
const SHAPE_ROLES: Record<Shape, [Role, Role]> = {
  sphere: ["red", "white"], stone: ["stone", "stone"], fireball: ["fire", "lamp"], arrow: ["wood", "cloth1"], dart: ["metal", "red"],
  bird: ["ink", "white"], butterfly: ["orange", "ink"], bee: ["yellow", "ink"], fish: ["metal", "orange"], rat: ["stone", "skin"], leaf: ["leaf", "leaf2"],
};

/** Plaque fine (aile, nageoire, empenne) : éventail de points dans le plan donné par `xf`. */
function plate(pts: V3[], role: number, xf: (p: V3) => V3): Mesh {
  const m = new Mesh();
  const P = pts.map(xf);
  const a = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]], b = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
  const n: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  const idx = P.map((p) => m.vertex(p, [n[0] / l, n[1] / l, n[2] / l], role));
  for (let i = 1; i + 1 < idx.length; i++) m.tri(idx[0], idx[i], idx[i + 1]);
  return m;
}

/** Rotation d'un point autour de l'axe z (avant) puis translation. */
const rotZ = (a: number, o: V3 = [0, 0, 0]) => (p: V3): V3 => [p[0] * Math.cos(a) - p[1] * Math.sin(a) + o[0], p[0] * Math.sin(a) + p[1] * Math.cos(a) + o[1], p[2] + o[2]];
const rotY = (a: number, o: V3 = [0, 0, 0]) => (p: V3): V3 => [p[0] * Math.cos(a) + p[2] * Math.sin(a) + o[0], p[1] + o[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a) + o[2]];
/** Pièce couchée le long de +z (les cylindres de procgen montent selon y). */
const alongZ = (m: Mesh, z = 0) => m.transform(m4Compose([0, 0, z], qAxis([1, 0, 0], Math.PI / 2)));

function shapeLook(shape: Shape, size: number | null, color: string, color2: string, rng: Rng): EmitLook["variants"][number] {
  const [d1, d2] = SHAPE_ROLES[shape];
  const r1 = color ? roleIndex(color, d1) : ROLE[d1], r2 = color2 ? roleIndex(color2, d2) : ROLE[d2];
  const k = (size ?? SHAPE_SIZE[shape]) / SHAPE_SIZE[shape];
  const n = SHAPE_FLAP[shape] > 0 ? FRAMES : 1;
  const frames: Mesh[] = [];
  for (let f = 0; f < n; f++) {
    const t = f / n, s = Math.sin(t * Math.PI * 2);
    const m = buildShape(shape, t, s, r1, r2, rng.fork(f));
    m.transform(m4Compose([0, 0, 0], [0, 0, 0, 1], k));
    frames.push(m);
  }
  return { frames };
}

function buildShape(shape: Shape, t: number, s: number, r1: number, r2: number, rng: Rng): Mesh {
  const m = new Mesh();
  switch (shape) {
    case "sphere":
      return icosphere(2, r1).transform(m4Compose([0, 0, 0], [0, 0, 0, 1], 0.15));
    case "stone": {
      const st = icosphere(1, r1);
      const j = [rng.range(0.8, 1.2), rng.range(0.6, 0.9), rng.range(0.9, 1.3)];
      return st.mapPos((p) => [p[0] * 0.075 * j[0] * rng.range(0.9, 1.1), p[1] * 0.075 * j[1], p[2] * 0.075 * j[2]]).facet();
    }
    case "fireball": {
      // cœur (flamme) et enveloppe étirée vers l'arrière qui palpite
      m.append(icosphere(1, r1).transform(m4Compose([0, 0, 0], [0, 0, 0, 1], 0.14)));
      const e = 1 + 0.15 * s;
      m.append(ellipsoid(0.11 * e, 0.11 * e, 0.24 * (1.1 - 0.1 * s), r2, 8, 6).transform(m4Compose([0, 0, -0.12], [0, 0, 0, 1], 1)));
      return m;
    }
    case "arrow":
    case "dart": {
      const L = shape === "arrow" ? 0.8 : 0.3;
      m.append(alongZ(cylinder(0.007 * (L / 0.8) + 0.003, 0.007 * (L / 0.8) + 0.003, L * 0.85, r1, 6), -L / 2));
      m.append(alongZ(cylinder(0.018 * (L / 0.8) + 0.004, 0, L * 0.15, shape === "arrow" ? ROLE.metal : r1, 6), L / 2 - L * 0.15));
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3;
        m.append(plate([[0, 0, -L / 2], [0, 0, -L / 2 + L * 0.18], [0.035 * (L / 0.8) + 0.01, 0, -L / 2 + 0.01]], r2, rotZ(a)));
      }
      // centre de gravité vers la pointe : fichée (`stick`), seule la pointe entre dans la cible
      return m.mapPos((p) => [p[0], p[1], p[2] - L * 0.42]);
    }
    case "bird": {
      m.append(ellipsoid(0.045, 0.04, 0.12, r1, 8, 6));
      m.append(ellipsoid(0.032, 0.03, 0.035, r1, 6, 5).transform(m4Compose([0, 0.02, 0.12], [0, 0, 0, 1], 1)));
      m.append(alongZ(cylinder(0.01, 0, 0.03, ROLE.orange, 5), 0.15));
      m.append(plate([[0, 0, -0.08], [0.04, 0, -0.17], [-0.04, 0, -0.17]], r1, (p) => p));
      const a = s * 45 * DEG;
      for (const sg of [1, -1]) {
        const tip = 0.1 + 0.06 * Math.cos(t * Math.PI * 2);
        m.append(plate([[0, 0, 0.05], [sg * 0.12, 0, 0.03], [sg * (0.12 + tip), 0, -0.04], [sg * 0.1, 0, -0.07], [0, 0, -0.05]], r2, rotZ(sg * a, [sg * 0.03, 0.02, 0])));
      }
      return m;
    }
    case "butterfly": {
      m.append(ellipsoid(0.006, 0.006, 0.03, ROLE.ink, 5, 4));
      const a = (s * 0.5 + 0.5) * 75 * DEG;
      for (const sg of [1, -1]) {
        m.append(plate([[0, 0, 0.01], [sg * 0.05, 0, 0.045], [sg * 0.06, 0, 0.0], [sg * 0.01, 0, -0.005]], r1, rotZ(sg * a)));
        m.append(plate([[0, 0, -0.002], [sg * 0.035, 0, -0.005], [sg * 0.03, 0, -0.035], [0, 0, -0.02]], r2, rotZ(sg * a * 0.9)));
      }
      return m;
    }
    case "bee": {
      m.append(ellipsoid(0.007, 0.007, 0.013, r1, 6, 5));
      m.append(ellipsoid(0.0072, 0.0072, 0.003, r2, 6, 3).transform(m4Compose([0, 0, -0.004], [0, 0, 0, 1], 1)));
      m.append(ellipsoid(0.0055, 0.0055, 0.006, r2, 5, 4).transform(m4Compose([0, 0.001, 0.014], [0, 0, 0, 1], 1)));
      const a = s * 40 * DEG + 20 * DEG;
      for (const sg of [1, -1]) m.append(plate([[0, 0.005, 0.003], [sg * 0.016, 0.005, -0.002], [sg * 0.012, 0.005, -0.01]], ROLE.glass, rotZ(sg * a)));
      return m;
    }
    case "fish": {
      // corps qui ondule : la queue balaie de part et d'autre
      const body = ellipsoid(0.03, 0.055, 0.13, r1, 10, 6);
      const w = s * 0.35;
      body.mapPos((p) => (p[2] < 0 ? [p[0] + Math.sin(w) * p[2] * p[2] * 4, p[1], p[2]] : p));
      m.append(body);
      const tail = rotY(w * 1.6, [Math.sin(w) * 0.06, 0, -0.12]);
      m.append(plate([[0, 0, 0], [0, 0.05, -0.07], [0, -0.05, -0.07]], r2, tail));
      m.append(plate([[0, 0.05, 0.03], [0, 0.085, -0.02], [0, 0.05, -0.05]], r2, (p) => p));
      return m;
    }
    case "rat": {
      m.append(ellipsoid(0.04, 0.035, 0.08, r1, 8, 6).transform(m4Compose([0, 0.04, 0], [0, 0, 0, 1], 1)));
      m.append(ellipsoid(0.025, 0.022, 0.04, r1, 6, 5).transform(m4Compose([0, 0.045, 0.09], [0, 0, 0, 1], 1)));
      for (const sg of [1, -1]) m.append(ellipsoid(0.012, 0.014, 0.004, r2, 5, 4).transform(m4Compose([sg * 0.018, 0.07, 0.08], [0, 0, 0, 1], 1)));
      // pattes qui trottinent, queue qui ondule
      for (const [sg, fz] of [[1, 0.05], [-1, 0.05], [1, -0.04], [-1, -0.04]] as const) {
        const ph = s * (fz > 0 ? sg : -sg) * 0.02;
        m.append(ellipsoid(0.008, 0.02, 0.008, r2, 4, 3).transform(m4Compose([sg * 0.025, 0.012, fz + ph], [0, 0, 0, 1], 1)));
      }
      const pts: V3[] = [];
      for (let i = 0; i <= 6; i++) pts.push([Math.sin(i * 0.9 + t * Math.PI * 2) * 0.015 * (i / 6), 0.035 - i * 0.004, -0.07 - i * 0.025]);
      for (let i = 0; i < 6; i++) {
        const a = pts[i], b = pts[i + 1];
        m.append(plate([[a[0] - 0.003, a[1], a[2]], [a[0] + 0.003, a[1], a[2]], [b[0] + 0.002, b[1], b[2]], [b[0] - 0.002, b[1], b[2]]], r2, (p) => p));
      }
      return m;
    }
    case "leaf": {
      const a = s * 25 * DEG;
      return plate([[0, 0, 0.04], [0.025, 0, 0.01], [0.02, 0, -0.025], [0, 0, -0.04], [-0.02, 0, -0.025], [-0.025, 0, 0.01]], r1, rotZ(a)).append(plate([[0, 0.001, 0.04], [0.003, 0.001, -0.04], [-0.003, 0.001, -0.04]], r2, rotZ(a)));
    }
  }
  return m;
}

export { FRAMES as EMIT_FRAMES };
