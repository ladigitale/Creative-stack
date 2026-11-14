/**
 * Générateur `animal` : quadrupèdes et oiseaux d'**une seule peau continue**, skinnés sur un squelette animal
 * (`rig/quadruped.ts`), même pipeline que les personnages : primitives d'un champ implicite posées sur les os, union
 * douce entre os parent-enfant, polygonisation, poids automatiques filtrés par côté, yeux en gabarits avec morph de
 * clignement, animation procédurale (`rig/quadruped-motion.ts`).
 *
 * Rôles de couleur (surchargés par `colors` de l'asset) :
 * - `skin` : pelage ou plumage principal (laine du mouton) ;
 * - `hair` : secondaire (crinière, queue, ventre et plastron, face et pattes du mouton, barbiche, tête du colvert) ;
 * - `cloth3` : motif du pelage (taches, plaques pie, rayures) ;
 * - `leather` : sabots, truffe, groin, coussinets, chaussettes sombres ;
 * - `cloth1` : cornes et bois ;
 * - `cloth2` : rose (intérieur d'oreille, crête et barbillons) ;
 * - `accent` : bec et pattes des oiseaux ; `eye` / `eyeWhite` : yeux (couleurs du style).
 */
import { type Q, type V3, DEG, add, clamp, cross, len, lerp3, m4Compose, madd, mix, norm, qAxis, qFromTo, qId, scale, smoothstep, sub } from "../core/math";
import type { Rng } from "../core/rng";
import { Field, type Blend, type FieldPrim, polygonize, primDist } from "../geom/implicit";
import { Mesh } from "../geom/mesh";
import { fbm3, noise3 } from "../geom/noise";
import { ellipsoid, lathe, tube } from "../geom/prims";
import { ANIMAL_BLENDS, ANIMAL_PROPS, type AnimalSkeleton, type BirdProps, type QuadProps, SPECIES, type Species, buildAnimal } from "../rig/quadruped";
import { qFromBasis } from "../rig/skeleton";
import { computeWeights } from "../rig/weights";
import { ROLE, type Role } from "../style/roles";
import { type Anchor, type Asset, defineGenerator } from "./types";

const COATS = ["auto", "solid", "spotted", "pie", "striped"] as const;
const MOODS = ["calm", "alert", "happy", "tired", "grazing"] as const;

/** Palette d'une robe : principal, secondaire, motif, sombre (sabots/truffe) + marques. */
type Palette = { name: string; main: string; second: string; pattern: string; dark: string; belly?: boolean; points?: boolean; socks?: boolean; patterns: (typeof COATS)[number][] };

const P = (name: string, main: string, second: string, pattern: string, dark: string, patterns: Palette["patterns"], extra: Partial<Palette> = {}): Palette => ({ name, main, second, pattern, dark, patterns, ...extra });

/** Robes par espèce (le motif est tiré parmi `patterns` quand `coat` vaut `auto`). */
export const COAT_PALETTES: Record<Species, Palette[]> = {
  dog: [
    P("fauve", "#b58552", "#ecdcc0", "#5a3d27", "#2b2321", ["solid", "solid", "pie"], { belly: true }),
    P("noir-feu", "#2e2a28", "#b77a45", "#efe7da", "#1f1b1a", ["solid", "pie"], { belly: true }),
    P("dalmatien", "#ece6dc", "#ece6dc", "#2b2725", "#2b2725", ["spotted"]),
    P("chocolat", "#6b4128", "#d8c3a2", "#efe7da", "#2a201b", ["solid", "pie"]),
    P("doré", "#d2a15c", "#f0dcb2", "#a56e3a", "#3a2a22", ["solid"]),
  ],
  cat: [
    P("tigré", "#a47c55", "#e6d6bf", "#4d3828", "#3a2b26", ["striped"], { belly: true }),
    P("roux", "#d08a48", "#f1dcc0", "#9a5427", "#5b3a33", ["striped", "solid"], { belly: true }),
    P("smoking", "#2b2829", "#efe9e0", "#efe9e0", "#3a2f2f", ["pie", "solid"], { belly: true }),
    P("gris", "#8f8f92", "#d9d7d2", "#5a5a5e", "#4b4446", ["solid", "striped"]),
    P("écaille", "#e8dccb", "#e8dccb", "#c47a3e", "#4b3a36", ["pie"]),
  ],
  horse: [
    P("bai", "#8a5532", "#23201e", "#efe8dc", "#2a2421", ["solid", "solid", "pie"], { points: true }),
    P("alezan", "#b06a36", "#c9874f", "#efe8dc", "#3b2c25", ["solid", "pie"]),
    P("noir", "#2c2a2a", "#1d1b1b", "#efe8dc", "#1d1b1b", ["solid", "pie"]),
    P("gris", "#c9c7c2", "#e6e3dd", "#8d8b88", "#3a3634", ["solid", "spotted"]),
    P("palomino", "#d8b072", "#f3e8d0", "#efe8dc", "#4a382b", ["solid"]),
  ],
  cow: [
    P("prim'holstein", "#efebe4", "#3a3534", "#262322", "#3a3332", ["pie"]),
    P("montbéliarde", "#efe8dc", "#efe8dc", "#9b4a2b", "#4a3a33", ["pie"]),
    P("jersiaise", "#a7744a", "#6b4a35", "#efe8dc", "#2f2622", ["solid"]),
    P("charolaise", "#ece2cf", "#e3d6bf", "#c9b89d", "#b99680", ["solid"]),
    P("highland", "#a8582d", "#8e4823", "#efe8dc", "#3a2a22", ["solid"]),
  ],
  sheep: [
    P("blanc", "#ece4d2", "#e2d6c2", "#cdbfa8", "#3b3330", ["solid"]),
    P("suffolk", "#e9e0cc", "#2a2524", "#cdbfa8", "#2a2524", ["solid"]),
    P("noir", "#3c3634", "#2a2524", "#5a524e", "#1f1b1a", ["solid"]),
    P("bis", "#cdb796", "#7a6450", "#a8916f", "#3b3330", ["solid"]),
  ],
  pig: [
    P("rose", "#e7a99a", "#e7a99a", "#3a3233", "#c9837a", ["solid", "solid", "spotted"]),
    P("gascon", "#3a3436", "#3a3436", "#ecd8cf", "#2a2426", ["solid"]),
    P("pie", "#ecc3b6", "#ecc3b6", "#3b3335", "#c98a80", ["pie"]),
    P("roux", "#b0643d", "#b0643d", "#3b3335", "#5a3a2f", ["solid"]),
  ],
  fox: [
    P("roux", "#c4652c", "#efe6da", "#7a3a1a", "#2a2220", ["solid"], { belly: true, socks: true }),
    P("argenté", "#55524f", "#e7e2db", "#2e2b2a", "#1e1b1a", ["solid"], { belly: true, socks: true }),
    P("polaire", "#ece9e3", "#ffffff", "#c9c4bb", "#3a3434", ["solid"]),
  ],
  rabbit: [
    P("agouti", "#8f7357", "#e2d4bf", "#5f4a38", "#5a4440", ["solid"], { belly: true }),
    P("blanc", "#f1ede6", "#f1ede6", "#d9d2c6", "#c99a9a", ["solid"]),
    P("pie", "#efe9df", "#efe9df", "#3e3634", "#7a5a56", ["pie"]),
    P("gris", "#8e8d8f", "#d9d6d1", "#5d5c5f", "#4a4446", ["solid"], { belly: true }),
  ],
  deer: [
    P("fauve", "#a8703f", "#efe4d2", "#f1e8da", "#2a2220", ["solid", "solid", "spotted"], { belly: true }),
    P("gris-brun", "#7d634b", "#e2d5c0", "#efe6d6", "#2a2220", ["solid"], { belly: true }),
  ],
  goat: [
    P("blanche", "#efebe3", "#e2dacb", "#cbbfae", "#5a4c44", ["solid"]),
    P("chamoisée", "#9a6a3e", "#2b2523", "#2b2523", "#2b2523", ["solid", "pie"], { points: true }),
    P("noire", "#2f2b2a", "#3a3533", "#efe8dc", "#1f1b1a", ["solid", "pie"]),
    P("alpine", "#c6a57c", "#3a3230", "#efe8dc", "#2b2523", ["solid", "pie"]),
  ],
  bear: [
    P("brun", "#6e4a30", "#9a7552", "#4e3322", "#221c1a", ["solid"]),
    P("noir", "#2a2627", "#8f7457", "#1e1b1c", "#151213", ["solid"]),
    P("polaire", "#ece6d6", "#ece6d6", "#d9cfba", "#222", ["solid"]),
    P("grizzli", "#8a6644", "#b8946a", "#5a3e28", "#221c1a", ["solid"]),
  ],
  duck: [
    P("colvert", "#8d8277", "#2f6b4f", "#7a4a33", "#2b2b2b", ["solid"]),
    P("pékin", "#f3efe6", "#f3efe6", "#e2dccf", "#2b2b2b", ["solid"]),
    P("cane", "#9a7a58", "#7a5e44", "#5e4733", "#2b2b2b", ["solid", "spotted"]),
  ],
  pigeon: [
    P("biset", "#8e939c", "#767d8a", "#5d7f74", "#2f3136", ["solid"]),
    P("bleu", "#9aa2ae", "#808a99", "#6a6a8e", "#2f3136", ["solid"]),
    P("écaillé", "#a49e98", "#6e6a66", "#5d7f74", "#2f3136", ["solid", "spotted"]),
    P("blanc", "#efece6", "#e2ded6", "#d6d2ca", "#2f3136", ["solid"]),
  ],
  seagull: [
    P("goéland argenté", "#f4f3ef", "#a9b1ba", "#2a2a2c", "#2a2a2c", ["solid"]),
    P("goéland brun", "#f2f1ec", "#5d6168", "#2a2a2c", "#2a2a2c", ["solid"]),
    P("mouette", "#f6f5f1", "#c3cad2", "#3a3434", "#3a3434", ["solid"]),
  ],
  chicken: [
    P("rousse", "#a8562e", "#2a2a2a", "#d38a4a", "#3a2a22", ["solid"]),
    P("blanche", "#f2eee6", "#e8e2d6", "#d6cfc0", "#3a2a22", ["solid"]),
    P("noire", "#2a2a2e", "#1e2a2e", "#3e4a52", "#2a2a2a", ["solid"]),
    P("coucou", "#9a9690", "#3a3836", "#e8e4dc", "#3a2a22", ["spotted", "striped"]),
  ],
};

export const animalSchema = {
  species: { type: "enum", default: "dog", options: SPECIES, doc: "Espèce : dog, cat, horse, cow, sheep, pig, fox, rabbit, deer, goat, bear, duck, chicken, pigeon (pigeon biset), seagull (goéland, mouette)" },
  size: { type: "number", default: 1, min: 0.3, max: 2, doc: "Taille relative (1 = adulte typique ; < 0,7 : jeune, tête et pattes proportionnellement plus grandes)" },
  build: { type: "number", default: 0.5, min: 0, max: 1, doc: "Carrure : 0 élancé … 1 massif" },
  coat: { type: "enum", default: "auto", options: COATS, doc: "Motif du pelage : solid (uni), spotted (tacheté), pie (plaques), striped (rayé), auto (tiré par graine parmi ceux de l'espèce)" },
  palette: { type: "string", default: "auto", doc: "Robe nommée de l'espèce (ex. bai, alezan, prim'holstein, roux, colvert) ou auto (graine)" },
  variant: { type: "int", default: 0, min: -1, max: 3, doc: "Variante d'espèce (oreilles du chien, cornes, bois, crête…) ; -1 = tirée par graine" },
  mood: { type: "enum", default: "calm", options: MOODS, doc: "Attitude : calm, alert (tête haute, oreilles dressées), happy (queue), tired (tête basse), grazing (broute / picore)" },
  colors: { type: "object", default: {}, doc: "Surcharges de couleurs : {main, second, pattern, dark, horn} en #rrggbb" },
  detail: { type: "enum", default: "auto", options: ["auto", "high", "crowd"], doc: "Finesse du maillage : high, crowd (troupeau, ≈ 2× plus rapide), auto (high pour les acteurs, crowd en couche)" },
} as const;

type Params = { species: string; size: number; build: number; coat: string; palette: string; variant: number; mood: string; colors: Record<string, unknown>; detail: string };

const HEX = /^#[0-9a-f]{6}$/i;
type Built = { mesh: Mesh; skeleton: AnimalSkeleton; anchors: Record<string, Anchor>; footprint: Asset["footprint"]; height: number };
const cache = new Map<string, Built>();

export const animal = defineGenerator({
  id: "animal",
  label: "Animal",
  doc: "Quadrupèdes et oiseaux d'une seule peau, skinnés (quaternions duaux) : 15 espèces (dont pigeon et goéland posés), robes par graine (uni, tacheté, pie, rayé), cornes, bois, crinière, laine, yeux avec clignement. Animés par la scène (repos, marche, trot, galop, hochement des oiseaux).",
  tags: ["animal", "faune", "ferme", "troupeau", "chien", "cheval", "oiseau"],
  schema: animalSchema,
  build(p, ctx) {
    const pp = p as unknown as Params;
    const rng = ctx.rng;
    const species = ((SPECIES as readonly string[]).includes(pp.species) ? pp.species : "dog") as Species;
    const pals = COAT_PALETTES[species];
    const named = pals.find((x) => x.name === pp.palette);
    if (pp.palette !== "auto" && !named) ctx.issues.add({ path: `${ctx.path}.palette`, code: "unknown", message: `robe « ${pp.palette} » inconnue pour ${species}`, hint: pals.map((x) => x.name).join(", ") });
    const pal = named ?? rng.fork("palette").pick(pals);
    const coat = pp.coat !== "auto" ? pp.coat : rng.fork("coat").pick(pal.patterns);
    const variant = pp.variant < 0 ? rng.fork("variant").int(0, 3) : pp.variant;
    const oc = (k: string, d: string) => (typeof pp.colors[k] === "string" && HEX.test(pp.colors[k] as string) ? (pp.colors[k] as string) : d);
    const horn = species === "deer" ? "#8a7258" : species === "goat" ? "#8f8473" : "#d8ccb4";
    const colors: Partial<Record<Role, string>> = {
      skin: oc("main", pal.main),
      hair: oc("second", pal.second),
      cloth3: oc("pattern", pal.pattern),
      leather: oc("dark", pal.dark),
      cloth1: oc("horn", horn),
      cloth2: species === "chicken" ? "#c8352c" : "#d99a92",
      accent: species === "duck" ? "#e08a2c" : species === "pigeon" ? "#b35a5e" : species === "seagull" ? "#e8c43a" : "#e2b04a",
    };
    const seed = rng.key.split("/").slice(-1)[0];
    const key = JSON.stringify({ species, size: pp.size, build: pp.build, coat, pal: pal.name, variant, mood: pp.mood, detail: pp.detail, seed });
    let built = cache.get(key);
    if (!built) {
      built = buildAnimalMesh(species, { ...pp, variant }, coat, pal, rng.fork("var"));
      cache.set(key, built);
      if (cache.size > 64) cache.delete(cache.keys().next().value as string);
    }
    return { generator: "animal", mesh: built.mesh, skeleton: built.skeleton, anchors: built.anchors, footprint: built.footprint, height: built.height, colors, blink: true, extra: { species, coat, palette: pal.name, variant } };
  },
});

/* ====================================================================================================== */

type Ctx = {
  sk: AnimalSkeleton;
  /** Boîtes serrées des dalles (indice de primitive → boîte). */
  boxes: Map<number, { min: V3; max: V3 }>;
  /** Gabarits maillés (oreilles, cornes, crins, plumes) skinnés sur un ou plusieurs os. */
  tpls: { mesh: Mesh; bones: string[]; weights?: (v: number) => [string, number][] }[];
  tpl: (m: Mesh, bones: string[], weights?: (v: number) => [string, number][]) => void;
  prims: FieldPrim[];
  primBone: number[];
  push: (f: FieldPrim, bone: string) => number;
  at: (bone: string, t: number) => V3;
  cap: (bone: string, t0: number, t1: number, ra: number, rb: number, role: number, off?: V3) => number;
  ell: (bone: string, c: V3, r: V3, role: number, bump?: number) => number;
  slab: (bone: string, c: V3, e1: V3, e2: V3, outline: [number, number][], thick: number, role: number) => number;
};

function makeCtx(sk: AnimalSkeleton, W: number, minThick: number): Ctx {
  const prims: FieldPrim[] = [];
  const primBone: number[] = [];
  const B = (n: string) => sk.bones[sk.index[n]];
  const push = (f: FieldPrim, bone: string) => {
    prims.push(f);
    primBone.push(sk.index[bone] ?? 0);
    return prims.length - 1;
  };
  const at = (bone: string, t: number) => lerp3(B(bone).head, B(bone).tail, t);
  const boxes = new Map<number, { min: V3; max: V3 }>();
  const tpls: { mesh: Mesh; bones: string[]; weights?: (v: number) => [string, number][] }[] = [];
  return {
    sk, boxes, tpls, tpl: (m, bones, weights) => tpls.push({ mesh: m, bones: bones.filter((b) => sk.has(b)), weights }), prims, primBone, push, at,
    cap: (bone, t0, t1, ra, rb, role, off = [0, 0, 0]) => push({ kind: "capsule", a: add(at(bone, t0), off), b: add(at(bone, t1), off), ra, rb, role, tag: 0 }, bone),
    ell: (bone, c, r, role, bump = 0) => push({ kind: "ellipsoid", c, r, role, tag: 0, ...(bump ? { bump: { amp: bump, freq: 1 / (W * 0.045), seed: 7.3 } } : {}) }, bone),
    // dalle convexe mince (oreille, crinière, bec plat, plume) : contour 2D dans la base (e1, e2), épaisseur selon e1 × e2
    slab: (bone, c, e1, e2, outline, thick, role) => {
      const a = norm(e1);
      const b = norm(sub(e2, scale(a, a[0] * e2[0] + a[1] * e2[1] + a[2] * e2[2])));
      const th = Math.max(thick, minThick);
      // contour remis dans le sens trigonométrique
      let area = 0;
      for (let i = 0; i < outline.length; i++) {
        const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % outline.length];
        area += x0 * y1 - x1 * y0;
      }
      const pts = area < 0 ? [...outline].reverse() : outline;
      // une dalle longue est découpée en tronçons (bornes cubiques plus petites : polygonisation plus rapide)
      const xs = pts.map((q) => q[0]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const n = Math.max(1, Math.ceil((x1 - x0) / (W * 0.2)));
      const round = Math.min(th * 0.4, (x1 - x0) * 0.1);
      let last = -1;
      for (let k = 0; k < n; k++) {
        const lo = k === 0 ? -Infinity : x0 + ((x1 - x0) * k) / n - round * 1.5;
        const hi = k === n - 1 ? Infinity : x0 + ((x1 - x0) * (k + 1)) / n + round * 1.5;
        const piece = clipX(clipX(pts, lo, 1), hi, -1);
        if (piece.length < 3) continue;
        const cx = piece.reduce((s_, q) => s_ + q[0], 0) / piece.length, cy = piece.reduce((s_, q) => s_ + q[1], 0) / piece.length;
        const loc = piece.map(([x, y]) => [x - cx, y - cy] as [number, number]);
        last = pushSlab(bone, add(add(c, scale(a, cx)), scale(b, cy)), a, b, loc, th, round, role);
      }
      return last;
    },
  };
  function pushSlab(bone: string, c: V3, a: V3, b: V3, pts: [number, number][], th: number, round: number, role: number) {
    const nn = cross(a, b);
    const planes: [V3, number][] = [[nn, th / 2], [scale(nn, -1), th / 2]];
    let reach = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      const ex = x1 - x0, ey = y1 - y0;
      const l = Math.hypot(ex, ey);
      if (l < 1e-9) continue;
      const on: [number, number] = [ey / l, -ex / l];
      planes.push([norm(add(scale(a, on[0]), scale(b, on[1]))), on[0] * x0 + on[1] * y0]);
      reach = Math.max(reach, Math.hypot(x0, y0));
    }
    const idx = push({ kind: "planes", c, planes, round: Math.min(round, reach * 0.3), reach: reach + th, role, tag: 0 }, bone);
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts)
      for (const sg of [-1, 1]) {
        const q = add(add(add(c, scale(a, x)), scale(b, y)), scale(nn, (sg * th) / 2));
        for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], q[k] - th * 0.3)), (max[k] = Math.max(max[k], q[k] + th * 0.3));
      }
    boxes.set(idx, { min, max });
    return idx;
  }
}

/** Découpe d'un polygone convexe par la droite x = v (garde x ≥ v si s = 1, x ≤ v si s = -1). */
function clipX(pts: [number, number][], v: number, s: 1 | -1): [number, number][] {
  if (!Number.isFinite(v)) return pts;
  const out: [number, number][] = [];
  const inside = (q: [number, number]) => (q[0] - v) * s >= 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
    const i0 = inside(p0), i1 = inside(p1);
    if (i0) out.push(p0);
    if (i0 !== i1) {
      const t = (v - p0[0]) / (p1[0] - p0[0]);
      out.push([v, p0[1] + (p1[1] - p0[1]) * t]);
    }
  }
  return out;
}

/**
 * Champ aux bornes serrées : les dalles (`planes`) déclarent une boîte cubique de rayon `reach` ; on les remplace
 * par la boîte réelle de leur contour (moins de cellules évaluées, polygonisation ≈ 2× plus rapide).
 */
class TightField extends Field {
  private tight: { min: V3; max: V3 }[];
  private padded: Float64Array;
  private buf = new Float64Array(0);
  private far: number;
  constructor(prims: FieldPrim[], blends: Blend[], tightBoxes: Map<number, { min: V3; max: V3 }>, cell: number) {
    super(prims, blends);
    this.tight = prims.map((f, i) => tightBoxes.get(i) ?? boxOf(f));
    // boîtes élargies de la marge utile (3 cellules, rayon de soudure) : hors de sa boîte, une primitive est « loin »
    const kmax = new Float64Array(prims.length);
    for (const b of this.blends) (kmax[b.a] = Math.max(kmax[b.a], b.k)), (kmax[b.b] = Math.max(kmax[b.b], b.k));
    this.far = cell * 3;
    this.padded = new Float64Array(prims.length * 6);
    this.tight.forEach((b, i) => {
      const m = Math.max(this.far, kmax[i] * 1.2);
      for (let k = 0; k < 3; k++) (this.padded[i * 6 + k] = b.min[k] - m), (this.padded[i * 6 + 3 + k] = b.max[k] + m);
    });
  }
  /** Évaluation : une primitive dont la boîte élargie ne contient pas le point compte comme lointaine (pas de calcul). */
  override evalXYZ(px: number, py: number, pz: number, cand?: { prims: number[]; blends: Blend[] }, out?: Float64Array): { d: number; owner: number } {
    const c = cand ?? this.local([px, py, pz]);
    if (!out || out.length < this.prims.length) out = this.buf.length >= this.prims.length ? this.buf : (this.buf = new Float64Array(this.prims.length));
    const P = this.padded;
    const far = this.far;
    let d = far;
    let owner = -1;
    for (const i of c.prims) {
      const o = i * 6;
      if (px < P[o] || py < P[o + 1] || pz < P[o + 2] || px > P[o + 3] || py > P[o + 4] || pz > P[o + 5]) {
        out[i] = far * 4;
        continue;
      }
      const v = primDist(px, py, pz, this.prims[i]);
      out[i] = v;
      if (v < d || owner < 0) {
        if (v < d) d = v;
        owner = i;
      }
    }
    if (owner < 0) return { d: far, owner: -1 };
    for (const b of c.blends) {
      const da = out[b.a], db = out[b.b];
      if (Math.min(da, db) - b.k * 0.25 >= d) continue;
      const h = clamp(0.5 + (0.5 * (db - da)) / b.k, 0, 1);
      const sm = mix(db, da, h) - b.k * h * (1 - h);
      if (sm < d) d = sm;
    }
    return { d, owner };
  }
  override bounds() {
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const b of this.tight)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], b.min[k]);
        max[k] = Math.max(max[k], b.max[k]);
      }
    return { min, max };
  }
  override candidates(min: V3, max: V3, margin: number): number[] {
    const set = new Set<number>();
    // tri fin par la distance au centre du bloc : une primitive loin de la surface du bloc est écartée ; un bloc
    // entièrement à l'intérieur d'une primitive n'a besoin que d'elle (le signe y est négatif partout)
    const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
    const h = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
    for (let i = 0; i < this.tight.length; i++) {
      const b = this.tight[i];
      if (b.max[0] + margin < min[0] || b.min[0] - margin > max[0] || b.max[1] + margin < min[1] || b.min[1] - margin > max[1] || b.max[2] + margin < min[2] || b.min[2] - margin > max[2]) continue;
      const f = this.prims[i];
      const d = primDist(cx, cy, cz, f);
      const slack = (h + margin) * 1.35 + (f.bump ? Math.abs(f.bump.amp) : 0);
      if (d > slack) continue;
      if (d < -slack && !f.bump) return [i];
      set.add(i);
    }
    for (const bl of this.blends) {
      if (set.has(bl.a) && !set.has(bl.b)) set.add(bl.b);
      if (set.has(bl.b) && !set.has(bl.a)) set.add(bl.a);
    }
    return [...set];
  }
}

function boxOf(f: FieldPrim): { min: V3; max: V3 } {
  const pad = f.bump ? Math.abs(f.bump.amp) : 0;
  if (f.kind === "capsule" || f.kind === "cone") {
    const r = Math.max(f.ra, f.rb) + pad + (f.kind === "cone" ? f.round : 0);
    return { min: [Math.min(f.a[0], f.b[0]) - r, Math.min(f.a[1], f.b[1]) - r, Math.min(f.a[2], f.b[2]) - r], max: [Math.max(f.a[0], f.b[0]) + r, Math.max(f.a[1], f.b[1]) + r, Math.max(f.a[2], f.b[2]) + r] };
  }
  if (f.kind === "ellipsoid") return { min: sub(f.c, add(f.r, [pad, pad, pad])), max: add(f.c, add(f.r, [pad, pad, pad])) };
  if (f.kind === "box") return { min: sub(f.c, add(f.h, [pad, pad, pad])), max: add(f.c, add(f.h, [pad, pad, pad])) };
  if (f.kind === "planes") return { min: sub(f.c, [f.reach, f.reach, f.reach]), max: add(f.c, [f.reach, f.reach, f.reach]) };
  const r = (f as { r: number }).r + pad;
  return { min: sub(f.c, [r, r, r]), max: add(f.c, [r, r, r]) };
}

/** Profils de gabarits (rayon ≤ 0,5 × hauteur 0..1) : oreilles, mèches, plumes. */
const EAR_POINTY: [number, number][] = [[0, 0], [0.42, 0.02], [0.5, 0.22], [0.4, 0.55], [0.18, 0.86], [0.02, 1]];
const EAR_OVAL: [number, number][] = [[0, 0], [0.28, 0.04], [0.47, 0.3], [0.5, 0.55], [0.38, 0.84], [0.14, 0.98], [0, 1]];
const EAR_ROUND: [number, number][] = [[0, 0], [0.36, 0.06], [0.5, 0.42], [0.42, 0.82], [0.2, 0.98], [0, 1]];

/** Tour aplati : largeur `w` (x), hauteur `h` (y), épaisseur `d` (z). */
function shaped(profile: [number, number][], w: number, h: number, d: number, role: number, seg = 10): Mesh {
  const m = lathe(profile.map(([r, y]) => [r, y] as [number, number]), role, seg, true);
  return m.transform(m4Compose([0, 0, 0], qId(), [w, h, d]));
}

/** Place un gabarit modélisé le long de +y (épaisseur selon z) : base, direction, face. */
function place(m: Mesh, base: V3, yDir: V3, zDir: V3): Mesh {
  const y = norm(yDir);
  let z = sub(zDir, scale(y, y[0] * zDir[0] + y[1] * zDir[1] + y[2] * zDir[2]));
  if (len(z) < 1e-6) z = Math.abs(y[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  return m.transform(m4Compose(base, qFromBasis([0, 1, 0], [0, 0, 1], y, norm(z))));
}

function buildAnimalMesh(species: Species, p: Params, coat: string, pal: Palette, v: Rng): Built {
  const young = clamp((0.75 - p.size) / 0.45, 0, 1);
  const sk = buildAnimal(species, { size: p.size, build: p.build, neck: v.vary(1, 0.04), head: v.vary(1, 0.03) * (1 + young * 0.3), leg: v.vary(1, 0.02) * (1 + young * 0.06) });
  const props = sk.meta.props;
  const W = sk.meta.W;
  const crowd = p.detail === "crowd";
  const cellK = props.kind === "bird" ? 0.024 : ({ horse: 0.02, cow: 0.021, deer: 0.019, bear: 0.022, sheep: 0.027, pig: 0.024, goat: 0.021, dog: 0.021, fox: 0.02, cat: 0.024, rabbit: 0.03 }[species as string] ?? 0.022);
  const cell = W * cellK * (crowd ? 1.85 : 1);
  // dalles (oreilles, crinière, plumes) : au moins deux cellules d'épaisseur, sinon la grille les rate
  const c = makeCtx(sk, W, cell * 2.1);
  const r = props.kind === "bird" ? birdBody(c, species, props, p, W) : quadBody(c, species, props, p, W, pal);
  const eyes = r.eyes;
  const anchors = r.anchors;

  /* ---------- soudures ---------- */
  const { prims, primBone } = c;
  const blends: Blend[] = [];
  const family = (n: string) => n.replace(/\.(l|r)$/, "");
  const sideOf = (n: string) => (n.endsWith(".l") ? "l" : n.endsWith(".r") ? "r" : "");
  const byFam = new Map<string, number[]>();
  prims.forEach((_, i) => {
    const f = family(sk.bones[primBone[i]].name);
    (byFam.get(f) ?? byFam.set(f, []).get(f)!).push(i);
  });
  for (const [ga, gb, k] of ANIMAL_BLENDS)
    for (const i of byFam.get(ga) ?? [])
      for (const j of byFam.get(gb) ?? []) {
        const si = sideOf(sk.bones[primBone[i]].name), sj = sideOf(sk.bones[primBone[j]].name);
        if (si && sj && si !== sj) continue;
        if (prims[i].role !== prims[j].role) continue;
        blends.push({ a: i, b: j, k: k * W });
      }
  const byBone = new Map<number, number[]>();
  prims.forEach((_, i) => (byBone.get(primBone[i]) ?? byBone.set(primBone[i], []).get(primBone[i])!).push(i));
  for (const list of byBone.values())
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) if (prims[list[x]].role === prims[list[y]].role && prims[list[x]].kind !== "planes") blends.push({ a: list[x], b: list[y], k: W * 0.03 });

  const field = new TightField(prims, blends, c.boxes, cell);
  const { mesh, owner } = polygonize(field, { cell, smooth: crowd ? 2 : 3, ao: true });

  /* ---------- robe : marques et motifs (rôle par sommet, sur le pelage principal) ---------- */
  const boneOf = (vi: number) => (owner[vi] >= 0 ? sk.bones[primBone[owner[vi]]].name : "root");
  paintCoat(mesh, boneOf, species, coat, pal, W, sk, v.range(0, 50));

  /* ---------- poids ---------- */
  const boneOwner = Int32Array.from(owner, (o) => (o >= 0 ? primBone[o] : 0));
  computeWeights(mesh, boneOwner, sk, {
    passes: crowd ? 7 : 10,
    // la couture centrale est rattachée à un côté : aucun sommet ne reçoit à la fois une patte gauche et une droite
    side: (vi) => (mesh.pos[vi * 3] >= 0 ? "l" : "r"),
    sharp: { "finger.l": 0.4, "finger.r": 0.4, "toe.l": 0.4, "toe.r": 0.4, "ear.l": 0.5, "ear.r": 0.5, head: 0.7, jaw: 0.5 },
  });

  /* ---------- gabarits : poids par proximité des os listés ---------- */
  for (const t of c.tpls) {
    const m = t.mesh;
    const idx = t.bones.map((n) => sk.index[n]);
    m.skin = new Array(m.vertexCount * 4).fill(0);
    m.weight = new Array(m.vertexCount * 4).fill(0);
    for (let vi = 0; vi < m.vertexCount; vi++) {
      if (t.weights) {
        t.weights(vi).slice(0, 4).forEach(([bn, w], j) => {
          m.skin![vi * 4 + j] = sk.index[bn];
          m.weight![vi * 4 + j] = w;
        });
        continue;
      }
      const q = m.getPos(vi);
      const ds = idx.map((bi) => segDist(q, sk.bones[bi].head, sk.bones[bi].tail));
      const order = ds.map((d, k) => [d, k] as [number, number]).sort((x, y) => x[0] - y[0]).slice(0, 2);
      const w = order.map(([d]) => 1 / Math.pow(d + W * 0.02, 3));
      const tw = w.reduce((s_, x) => s_ + x, 0);
      order.forEach(([, k], j) => {
        m.skin![vi * 4 + j] = idx[k];
        m.weight![vi * 4 + j] = w[j] / tw;
      });
    }
    mesh.append(m);
  }

  /* ---------- yeux : gabarits sur la surface, morph de clignement ---------- */
  const headIdx = sk.index.head;
  const face = new Mesh();
  const morph: number[] = [];
  for (const e of eyes) {
    const hit = surfacePoint(field, e.from, e.dir, W);
    if (!hit) continue;
    const n = field.gradient(hit, cell * 0.3);
    const q: Q = qFromTo([0, 0, 1], n);
    const ctr = madd(hit, n, -e.r * 0.25);
    const sleepy = p.mood === "tired" ? 0.6 : 1;
    const eyeM = ellipsoid(e.r, e.r * 0.86 * sleepy, e.r * 0.55, ROLE.eye, 12, 8).transform(m4Compose(ctr, q));
    const up: V3 = [0, 1, 0];
    const hl = ellipsoid(e.r * 0.24, e.r * 0.24, e.r * 0.14, ROLE.eyeWhite, 6, 4).transform(m4Compose(madd(madd(ctr, n, e.r * 0.42), norm(add(up, scale(norm(cross(n, up)), 0.4))), e.r * 0.35), q));
    for (const m of [eyeM, hl]) {
      const base = face.vertexCount;
      face.append(m);
      for (let i = base; i < face.vertexCount; i++) morph.push(0, (ctr[1] - face.pos[i * 3 + 1]) * 0.9, 0);
    }
  }
  face.skin = new Array(face.vertexCount * 4).fill(0).map((_, k) => (k % 4 === 0 ? headIdx : 0));
  face.weight = new Array(face.vertexCount * 4).fill(0).map((_, k) => (k % 4 === 0 ? 1 : 0));
  face.morph = morph;
  mesh.append(face);

  /* ---------- ancres, emprise ---------- */
  const bb = mesh.bounds();
  const A: Record<string, Anchor> = {
    "head.top": { bone: "head", pos: anchors.headTop, rot: qId(), scale: W * 0.15 },
    back: { bone: props.kind === "bird" ? "pelvis" : "spine", pos: anchors.back, rot: qId(), scale: W * 0.25 },
    mouth: { bone: sk.has("jaw") ? "jaw" : "head", pos: anchors.mouth, rot: qId(), scale: W * 0.06 },
    feet: { bone: "root", pos: [0, 0, 0], rot: qId(), scale: Math.max(bb.max[0], -bb.min[0]) },
  };
  const hx = Math.max(bb.max[0], -bb.min[0]);
  const hz = Math.max(bb.max[2], -bb.min[2]);
  return { mesh, skeleton: sk, anchors: A, footprint: { hx, hz: hz * 0.85, r: Math.max(hx, hz * 0.8) }, height: bb.max[1] };
}

function segDist(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const t = clamp(((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / Math.max(1e-12, ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]), 0, 1);
  return len(sub(p, madd(a, ab, t)));
}

/** Point de surface du champ en marchant de `from` le long de `dir` (vers l'intérieur). */
function surfacePoint(field: Field, from: V3, dir: V3, W: number): V3 | null {
  const d = norm(dir);
  let t0 = 0;
  let f0 = field.distance(from);
  if (f0 < 0) return null;
  const step = W * 0.004;
  for (let t = step; t < W * 0.6; t += step) {
    const pt = madd(from, d, t);
    const f = field.distance(pt);
    if (f < 0) {
      let a = t0, b = t;
      for (let k = 0; k < 20; k++) {
        const m = (a + b) / 2;
        if (field.distance(madd(from, d, m)) < 0) b = m;
        else a = m;
      }
      return madd(from, d, (a + b) / 2);
    }
    t0 = t;
    f0 = f;
  }
  return null;
}

/* ====================================================================================================== */
/* Quadrupèdes                                                                                             */

type HeadSpec = {
  /** Crâne : demi-largeur, demi-hauteur, demi-longueur (× longueur de tête), recul du centre. */
  cr: [number, number, number];
  cz: number;
  /** Museau : rayons base / bout (× lt), décalage vertical, empilement (museau plus haut que large). */
  m0: number;
  m1: number;
  my: number;
  tall: number;
  /** Mâchoire (rayon × lt). */
  jaw: number;
  /** Bout du nez : rôle sombre (truffe), groin, mufle. */
  nose: "pad" | "snout" | "muzzle" | "none";
  /** Yeux : avance sur la tête (× lt), écart latéral (direction), rayon (× lt). */
  eye: [number, number, number];
};

const HEADS: Record<string, HeadSpec> = {
  dog: { cr: [0.32, 0.3, 0.3], cz: 0.22, m0: 0.19, m1: 0.14, my: -0.08, tall: 0.25, jaw: 0.08, nose: "pad", eye: [0.38, 0.62, 0.055] },
  cat: { cr: [0.4, 0.36, 0.36], cz: 0.3, m0: 0.15, m1: 0.12, my: -0.12, tall: 0.1, jaw: 0.07, nose: "pad", eye: [0.48, 0.5, 0.075] },
  fox: { cr: [0.27, 0.25, 0.28], cz: 0.2, m0: 0.12, m1: 0.06, my: -0.06, tall: 0.1, jaw: 0.06, nose: "pad", eye: [0.36, 0.55, 0.055] },
  horse: { cr: [0.2, 0.2, 0.22], cz: 0.16, m0: 0.15, m1: 0.12, my: -0.04, tall: 0.5, jaw: 0.1, nose: "muzzle", eye: [0.24, 0.85, 0.045] },
  cow: { cr: [0.3, 0.26, 0.26], cz: 0.2, m0: 0.2, m1: 0.18, my: -0.03, tall: 0.35, jaw: 0.1, nose: "muzzle", eye: [0.26, 0.85, 0.05] },
  sheep: { cr: [0.24, 0.24, 0.26], cz: 0.22, m0: 0.15, m1: 0.11, my: -0.05, tall: 0.35, jaw: 0.08, nose: "muzzle", eye: [0.32, 0.8, 0.055] },
  goat: { cr: [0.22, 0.22, 0.25], cz: 0.2, m0: 0.13, m1: 0.1, my: -0.04, tall: 0.35, jaw: 0.08, nose: "muzzle", eye: [0.3, 0.82, 0.055] },
  deer: { cr: [0.24, 0.23, 0.25], cz: 0.2, m0: 0.13, m1: 0.08, my: -0.04, tall: 0.3, jaw: 0.07, nose: "pad", eye: [0.32, 0.82, 0.06] },
  pig: { cr: [0.46, 0.42, 0.4], cz: 0.3, m0: 0.3, m1: 0.2, my: -0.06, tall: 0.0, jaw: 0.12, nose: "snout", eye: [0.42, 0.6, 0.04] },
  bear: { cr: [0.5, 0.44, 0.42], cz: 0.3, m0: 0.24, m1: 0.17, my: -0.1, tall: 0.15, jaw: 0.11, nose: "pad", eye: [0.42, 0.5, 0.045] },
  rabbit: { cr: [0.32, 0.32, 0.34], cz: 0.32, m0: 0.2, m1: 0.15, my: -0.1, tall: 0.1, jaw: 0.08, nose: "pad", eye: [0.45, 0.85, 0.08] },
};

function quadBody(c: Ctx, species: Species, P_: QuadProps, p: Params, W: number, pal: Palette) {
  const { sk, cap, ell, slab, at } = c;
  const S = ROLE.skin, HR = ROLE.hair, LE = ROLE.leather, HO = ROLE.cloth1, PK = ROLE.cloth2;
  const B = (n: string) => sk.bones[sk.index[n]];
  const D = P_.depth * W * mix(0.95, 1.08, p.build);
  const half = P_.wid * D * mix(0.92, 1.12, p.build);
  const bw = mix(0.9, 1.15, p.build);
  const sheep = species === "sheep";
  const wool = sheep ? W * 0.025 : 0;
  const coatR = S;

  /* ---------- tronc ---------- */
  const pel = B("pelvis"), spi = B("spine"), che = B("chest");
  const yBelly = () => spi.head[1] - D * 0.12;
  const K = {
    hind: { dog: 0.9, cat: 0.95, fox: 0.9, horse: 1.05, cow: 1.02, sheep: 1.05, pig: 1.02, deer: 0.95, goat: 0.95, bear: 0.95, rabbit: 1.25 }[species as string] ?? 1,
    chest: { dog: 1.08, cat: 0.95, fox: 0.95, horse: 1.05, cow: 1.0, sheep: 1.05, pig: 1.0, deer: 1.0, goat: 0.95, bear: 1.12, rabbit: 0.85 }[species as string] ?? 1,
    belly: { dog: 0.78, cat: 0.85, fox: 0.8, horse: 0.95, cow: 1.1, sheep: 1.05, pig: 1.05, deer: 0.85, goat: 1.0, bear: 0.9, rabbit: 1.0 }[species as string] ?? 1,
  };
  // croupe
  ell("pelvis", add(lerp3(pel.head, pel.tail, 0.4), [0, D * 0.0, 0]), [half * K.hind * bw, D * 0.5 * K.hind, D * 0.66 * K.hind], coatR, wool);
  // ventre (abaissé : ligne de dessous) et rein
  // (le ventre ne touche ni le coude ni le grasset : ces os ne partagent pas de poids avec le rein)
  ell("spine", add(lerp3(spi.head, spi.tail, 0.5), [0, -D * 0.04 * K.belly, 0]), [half * 1.02 * K.belly * bw, D * 0.5 * Math.max(0.85, K.belly), (spi.tail[2] - spi.head[2]) * 0.62 + D * 0.05], coatR, wool);
  // poitrine et garrot
  ell("chest", add(lerp3(che.head, che.tail, 0.4), [0, -D * 0.03, -D * 0.1]), [half * 0.97 * K.chest * bw, D * 0.5 * K.chest, D * 0.62], coatR, wool);
  // ligne de dos continue (rein) et, pour les espèces lourdes, ventre plein entre coude et grasset
  c.push({ kind: "capsule", a: add(lerp3(pel.head, pel.tail, 0.9), [0, D * 0.12, 0]), b: add(lerp3(che.head, che.tail, 0.3), [0, D * 0.1, 0]), ra: Math.min(half * K.hind, D * 0.38) * bw, rb: Math.min(half * K.chest, D * 0.38) * bw, role: coatR, tag: 0, ...(wool ? { bump: { amp: wool, freq: 1 / (W * 0.045), seed: 6 } } : {}) }, "spine");
  if (K.belly >= 1) {
    const zE = B("forearm.l").head[2] - D * 0.22, zK = B("shin.l").head[2] + D * 0.22;
    const rB = half * 0.7 * bw;
    const yb = Math.max(yBelly(), B("forearm.l").head[1] + rB * 0.95);
    if (zE - rB > zK + rB) c.push({ kind: "capsule", a: [0, yb, zK + rB], b: [0, yb, zE - rB], ra: rB, rb: rB, role: coatR, tag: 0, ...(wool ? { bump: { amp: wool, freq: 1 / (W * 0.045), seed: 7 } } : {}) }, "spine");
  }
  // pointe de l'épaule et poitrail (sans dépasser l'avant-bras)
  for (const sx of [1, -1]) c.push({ kind: "ellipsoid", c: add(che.tail, [sx * half * 0.45, -D * 0.42, -D * 0.12]), r: [half * 0.45, D * 0.24, D * 0.2], role: coatR, tag: 0 }, "chest");
  if (species === "bear") c.push({ kind: "ellipsoid", c: add(che.tail, [0, D * 0.1, -D * 0.42]), r: [half * 0.75, D * 0.36, D * 0.5], role: S, tag: 0 }, "chest"); // bosse
  if (species === "horse" || species === "deer") // garrot marqué
    c.push({ kind: "capsule", a: add(che.tail, [0, D * 0.05, -D * 0.55]), b: add(che.tail, [0, D * 0.08, -D * 0.05]), ra: half * 0.45, rb: half * 0.45, role: S, tag: 0 }, "chest");

  /* ---------- cou ---------- */
  const neckR0 = { dog: 0.32, cat: 0.3, fox: 0.28, horse: 0.36, cow: 0.42, sheep: 0.4, pig: 0.5, deer: 0.26, goat: 0.28, bear: 0.46, rabbit: 0.35 }[species as string] ?? 0.32;
  const neckR1 = { dog: 0.22, cat: 0.22, fox: 0.19, horse: 0.2, cow: 0.3, sheep: 0.24, pig: 0.42, deer: 0.17, goat: 0.18, bear: 0.36, rabbit: 0.25 }[species as string] ?? 0.22;
  const r0 = D * neckR0 * bw, r1 = D * neckR1 * bw;
  const nTall = species === "horse" ? 0.35 : species === "cow" ? 0.25 : 0.1;
  for (const k of [-1, 1]) {
    const off: V3 = [0, k * r0 * nTall * 0.5, k * -r0 * nTall * 0.3];
    c.push({ kind: "capsule", a: add(at("neck.1", -0.15), off), b: add(at("neck.1", 1), off), ra: r0 * (1 - nTall * 0.3), rb: mix(r0, r1, 0.5) * (1 - nTall * 0.3), role: coatR, tag: 0, ...(wool ? { bump: { amp: wool, freq: 1 / (W * 0.045), seed: 5.2 } } : {}) }, "neck.1");
    c.push({ kind: "capsule", a: add(at("neck.2", 0), off), b: add(at("neck.2", 1.05), off), ra: mix(r0, r1, 0.5) * (1 - nTall * 0.3), rb: r1 * (1 - nTall * 0.3), role: S, tag: 0 }, "neck.2");
  }
  if (species === "cow") c.push({ kind: "capsule", a: at("neck.1", 0.1), b: add(at("neck.2", 0.6), [0, -r1 * 0.9, 0]), ra: r0 * 0.6, rb: r1 * 0.45, role: S, tag: 0 }, "neck.1"); // fanon

  /* ---------- tête ---------- */
  const hs = HEADS[species];
  const hd = B("head");
  const hl = len(sub(hd.tail, hd.head));
  const f = norm(sub(hd.tail, hd.head));
  const upv = norm([0, f[2], -f[1]]);
  const hp = (lx: number, ly: number, lz: number): V3 => add(madd(madd(hd.head, upv, ly * hl), f, lz * hl), [lx * hl, 0, 0]);
  const crC = hp(0, 0.02, hs.cz);
  ell("head", crC, [hs.cr[0] * hl * bw, hs.cr[1] * hl, hs.cr[2] * hl], S);
  // museau (empilé si plus haut que large), bout du nez
  const mzA = hp(0, hs.my * 0.5, hs.cz + 0.12), mzB = hp(0, hs.my, 1 - hs.m1);
  for (const k of hs.tall > 0 ? [-1, 1] : [0]) {
    const o = scale(upv, k * hs.tall * hs.m0 * hl * 0.5);
    c.push({ kind: "capsule", a: add(mzA, o), b: add(mzB, scale(o, 0.8)), ra: hs.m0 * hl * (1 - hs.tall * 0.3), rb: hs.m1 * hl * (1 - hs.tall * 0.3), role: S, tag: 0 }, "head");
  }
  // joues (herbivores) / mâchoire
  if (species === "horse" || species === "cow" || species === "deer" || species === "goat" || species === "sheep")
    for (const sx of [1, -1]) ell("head", hp(sx * hs.cr[0] * 0.45, -0.18, hs.cz + 0.02), [hs.cr[0] * 0.55 * hl, hs.cr[1] * 0.7 * hl, hs.cr[2] * 0.75 * hl], S);
  if (sk.has("jaw")) {
    c.cap("jaw", 0, 1, hs.jaw * hl * 1.15, hs.jaw * hl * 0.85, S);
  }
  const tip = hp(0, hs.my, 1 - hs.m1 * 0.6);
  if (hs.nose === "pad") {
    const nr = hs.m1 * hl * (species === "cat" || species === "rabbit" ? 0.45 : 0.62);
    c.push({ kind: "ellipsoid", c: madd(madd(tip, f, hs.m1 * hl * 0.55), upv, hs.m1 * hl * 0.35), r: [nr * 1.1, nr * 0.75, nr * 0.75], role: species === "rabbit" || species === "cat" ? PK : LE, tag: 0 }, "head");
  } else if (species === "pig") {
    c.push({ kind: "capsule", a: madd(tip, f, hs.m1 * hl * 0.2), b: madd(tip, f, hs.m1 * hl * 0.85), ra: hs.m1 * hl * 0.95, rb: hs.m1 * hl * 0.95, role: LE, tag: 0 }, "head");
  } else if (hs.nose === "muzzle") {
    const mr = hs.m1 * hl;
    c.push({ kind: "ellipsoid", c: madd(madd(tip, f, mr * 0.45), upv, -mr * 0.05), r: [mr * 1.0, mr * 0.85, mr * 0.85], role: species === "cow" || species === "horse" ? LE : S, tag: 0 }, "head");
  }
  // oreilles : gabarits minces (la grille du champ est trop grossière pour une oreille fine)
  for (const s of ["l", "r"] as const) {
    if (!sk.has(`ear.${s}`)) continue;
    const eb = B(`ear.${s}`);
    const el = len(sub(eb.tail, eb.head));
    let ed = norm(sub(eb.tail, eb.head));
    const sx = s === "l" ? 1 : -1;
    let type: "pointy" | "oval" | "round" = "pointy";
    let wE = 0.6, dE = 0.2, inner = PK;
    let face = norm(sub(f, scale(ed, f[0] * ed[0] + f[1] * ed[1] + f[2] * ed[2])));
    const flop = (species === "dog" && (p.variant % 4 === 1 || p.variant % 4 === 2)) || (species === "pig" && p.variant % 2 === 0);
    switch (species) {
      case "dog": wE = flop ? 0.62 : 0.62; type = flop ? "oval" : "pointy"; inner = flop ? S : PK; break;
      case "cat": wE = 0.85; break;
      case "fox": wE = 0.72; break;
      case "horse": wE = 0.5; dE = 0.3; inner = S; break;
      case "deer": type = "oval"; wE = 0.6; break;
      case "cow": case "sheep": case "goat": type = "oval"; wE = 0.5; inner = species === "sheep" ? HR : PK; break;
      case "pig": wE = 0.75; type = "pointy"; inner = PK; break;
      case "bear": type = "round"; wE = 0.95; dE = 0.45; inner = S; break;
      case "rabbit": type = "oval"; wE = 0.4; dE = 0.14; break;
    }
    // base posée sur la surface du crâne (ellipsoïde) dans la direction de l'oreille, légèrement enfoncée
    const cr: V3 = [hs.cr[0] * hl * bw, hs.cr[1] * hl, hs.cr[2] * hl];
    const toward = sub(madd(eb.head, ed, el * 0.25), crC);
    const kk = 1 / Math.hypot(toward[0] / cr[0], toward[1] / cr[1], toward[2] / cr[2]);
    let base = madd(add(crC, scale(toward, kk)), ed, -el * 0.12);
    if (flop) {
      // oreille tombante : part du haut du crâne, pend sur la joue
      if (species === "pig") {
        // oreilles de cochon rabattues vers l'avant, sur les yeux
        ed = norm([sx * 0.6, 0.15, 0.8]);
        face = norm([0, 1, 0.3]);
      } else {
        ed = norm([sx * 0.32, -1, 0.12]);
        face = [sx, 0, 0];
        base = add(eb.head, [sx * hl * 0.02, el * 0.05, 0]);
      }
    }
    const prof = type === "pointy" ? EAR_POINTY : type === "oval" ? EAR_OVAL : EAR_ROUND;
    const ear = shaped(prof, el * wE, el * (type === "round" ? 0.8 : 1), el * wE * dE, sheep ? HR : S);
    c.tpl(place(ear, base, ed, face), [`ear.${s}`]);
    if (inner !== S && (!flop || species === "pig")) {
      const inn = shaped(prof, el * wE * 0.62, el * 0.82, el * wE * dE * 0.6, inner);
      c.tpl(place(inn, madd(madd(base, face, el * wE * dE * 0.3), ed, el * 0.08), ed, face), [`ear.${s}`]);
    }
  }
  // cornes et bois (tubes effilés)
  const horn = (pts: V3[], r0_: number, r1_: number) => {
    const radii = pts.map((_, i) => mix(r0_, r1_, Math.pow(i / (pts.length - 1), 0.8)));
    c.tpl(tube(pts, radii, HO, 9, false, true), ["head"]);
  };
  const crownP = (sx: number) => hp(sx * hs.cr[0] * 0.55, hs.cr[1] * 0.7, hs.cz - 0.02);
  if (species === "cow" && p.variant % 4 !== 3)
    for (const sx of [1, -1]) {
      const b0 = crownP(sx);
      const pts: V3[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        pts.push(add(b0, [sx * hl * (0.02 + 0.3 * t), hl * (0.24 * t * t - 0.02 * t), hl * 0.06 * Math.sin(t * Math.PI)]));
      }
      horn(pts, hl * 0.055, hl * 0.012);
    }
  if (species === "goat" && p.variant % 4 !== 3)
    for (const sx of [1, -1]) {
      const b0 = crownP(sx * 0.6);
      const pts: V3[] = [];
      for (let i = 0; i <= 7; i++) {
        const a = (i / 7) * 100 * DEG;
        pts.push(add(b0, [sx * hl * 0.08 * (i / 7), Math.sin(a) * hl * 0.42, -(1 - Math.cos(a)) * hl * 0.42]));
      }
      horn(pts, hl * 0.055, hl * 0.01);
    }
  if (species === "sheep" && p.variant % 4 === 1)
    for (const sx of [1, -1]) {
      const b0 = crownP(sx * 0.8);
      const pts: V3[] = [];
      for (let i = 0; i <= 14; i++) {
        const a = (i / 14) * 1.75 * Math.PI;
        const r = hl * 0.3 * (1 - i / 22);
        pts.push(add(b0, [sx * (hl * 0.04 + i * hl * 0.011), r * Math.sin(a), -r * (1 - Math.cos(a)) + hl * 0.02]));
      }
      horn(pts, hl * 0.085, hl * 0.03);
    }
  if (species === "deer" && p.variant % 2 === 0)
    for (const sx of [1, -1]) {
      // bois : merrain vers le haut, l'extérieur et l'arrière, andouillers vers l'avant et le haut
      const b0 = crownP(sx * 0.7);
      const beam: V3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        beam.push(add(b0, [sx * hl * (0.04 + 0.42 * Math.sin(t * 1.3)), hl * 1.15 * t, -hl * 0.35 * Math.sin(t * 2.0) + hl * 0.25 * t * t]));
      }
      horn(beam, hl * 0.045, hl * 0.016);
      for (const [ti, ln, up] of [[1, 0.36, 0.3], [4, 0.42, 0.75], [6, 0.34, 0.9]] as const) {
        const bp = beam[ti];
        const tipP = add(bp, [sx * hl * 0.03, ln * hl * up, ln * hl * Math.sqrt(1 - up * up) + ln * hl * 0.2]);
        horn([bp, lerp3(bp, tipP, 0.5), tipP], hl * 0.03, hl * 0.01);
      }
    }
  // crinière en mèches, toupet, barbiche
  if (species === "horse") {
    const n0 = at("neck.1", 0.0), n2 = at("neck.2", 1.0);
    const nd = norm(sub(n2, n0));
    const nup = norm([0, nd[2], -nd[1]]);
    const Ln = len(sub(n2, n0));
    const rTop0 = r0 * (1 - nTall * 0.3) + r0 * nTall * 0.5, rTop1 = r1 * (1 - nTall * 0.3) + r0 * nTall * 0.5;
    const tufts = 9;
    const mh = W * (p.variant % 2 ? 0.085 : 0.11);
    for (let i = 0; i < tufts; i++) {
      const t = (i + 0.3) / tufts;
      const bpt = madd(madd(n0, nd, Ln * t), nup, mix(rTop0, rTop1, t) * 0.8);
      // mèches inclinées vers l'arrière et tombant légèrement sur le côté
      const dir = norm(add(add(scale(nup, 1), scale(nd, -0.55)), [(i % 2 ? 1 : -1) * 0.12, 0, 0]));
      const tuft = shaped(EAR_POINTY, Ln * 0.26, mh * mix(1.1, 0.7, t), W * 0.035, HR, 8);
      c.tpl(place(tuft, bpt, dir, [1, 0, 0]), t < 0.5 ? ["neck.1", "neck.2"] : ["neck.2", "head"]);
    }
    // toupet
    const fl = shaped(EAR_POINTY, hl * 0.2, hl * 0.26, W * 0.025, HR, 8);
    c.tpl(place(fl, hp(0, hs.cr[1] * 0.85, hs.cz - 0.02), norm(add(f, scale(upv, 0.12))), upv), ["head"]);
  }
  if (species === "goat" && p.variant % 2 === 0) {
    const bd = shaped(EAR_POINTY, hl * 0.16, hl * 0.32, hl * 0.12, HR, 8);
    c.tpl(place(bd, add(at("jaw", 0.75), [0, -hl * 0.02, 0]), norm([0, -1, -0.25]), [1, 0, 0]), ["jaw"]);
  }
  if (species === "sheep") {
    // toupet laineux sur le front
    c.push({ kind: "ellipsoid", c: hp(0, hs.cr[1] * 0.75, hs.cz - 0.02), r: [hs.cr[0] * hl * 1.0, hs.cr[1] * hl * 0.55, hs.cr[2] * hl * 0.8], role: S, tag: 0, bump: { amp: wool * 0.8, freq: 1 / (W * 0.035), seed: 2 } }, "head");
  }
  if (species === "bear" || species === "dog") {
    // arcade sourcilière légère (regard moins enfantin)
    for (const sx of [1, -1]) c.push({ kind: "ellipsoid", c: hp(sx * hs.cr[0] * 0.42, hs.cr[1] * 0.45, hs.cz + hs.cr[2] * 0.62), r: [hs.cr[0] * hl * 0.32, hs.cr[1] * hl * 0.22, hs.cr[2] * hl * 0.3], role: S, tag: 0 }, "head");
  }

  /* ---------- pattes ---------- */
  const legT = { dog: 1.35, cat: 1.4, fox: 0.95, horse: 1.0, cow: 1.15, sheep: 1.0, pig: 1.7, deer: 0.85, goat: 1.0, bear: 1.9, rabbit: 1.1 }[species as string] ?? 1;
  const lr = (k: number) => W * k * legT * mix(0.9, 1.12, p.build);
  for (const s of ["l", "r"] as const) {
    const sx = s === "l" ? 1 : -1;
    // avant : épaule, avant-bras musclé, canon fin, boulet, sabot ou patte
    const ua = B(`upperarm.${s}`);
    // omoplate portée par la poitrine ; l'humérus ne remonte pas jusqu'au garrot (sinon il touche le cou)
    c.push({ kind: "ellipsoid", c: add(ua.head, [0, D * 0.1, -D * 0.06]), r: [half * 0.42 * K.chest, D * 0.3, D * 0.26], role: coatR, tag: 0, ...(wool ? { bump: { amp: wool, freq: 1 / (W * 0.045), seed: 8 } } : {}) }, "chest");
    c.push({ kind: "capsule", a: lerp3(ua.head, ua.tail, 0.12), b: ua.tail, ra: D * 0.19 * K.chest, rb: lr(0.05), role: coatR, tag: 0, ...(wool ? { bump: { amp: wool, freq: 1 / (W * 0.045), seed: 9 } } : {}) }, `upperarm.${s}`);
    c.cap(`forearm.${s}`, 0, 1, lr(0.06), lr(0.032), sheep ? HR : S);
    if (P_.hoof) c.push({ kind: "ellipsoid", c: B(`forearm.${s}`).tail, r: [lr(0.036), lr(0.04), lr(0.038)], role: sheep ? HR : S, tag: 0 }, `hand.${s}`);
    c.cap(`hand.${s}`, 0, 1, lr(0.028), lr(0.026), sheep ? HR : S);
    // arrière : cuisse et fesse, jambe (gigot), canon, sabot ou patte
    const th = B(`thigh.${s}`);
    c.push({ kind: "capsule", a: add(th.head, [0, D * 0.1, -D * 0.14]), b: add(th.tail, [0, D * 0.02, -D * 0.04]), ra: D * 0.3 * K.hind, rb: lr(0.075), role: coatR, tag: 0, ...(wool ? { bump: { amp: wool, freq: 1 / (W * 0.045), seed: 11 } } : {}) }, `thigh.${s}`);
    // hanche : masse de la cuisse entre la pointe de la fesse et le grasset
    c.push({ kind: "ellipsoid", c: add(lerp3(th.head, th.tail, 0.5), [0, 0, -D * 0.1]), r: [half * 0.5 * K.hind * bw, D * 0.38 * K.hind, D * 0.34 * K.hind], role: coatR, tag: 0, ...(wool ? { bump: { amp: wool, freq: 1 / (W * 0.045), seed: 12 } } : {}) }, `thigh.${s}`);
    c.cap(`shin.${s}`, 0, 1, lr(0.07), lr(0.032), sheep ? HR : S);
    c.cap(`foot.${s}`, 0, 1, lr(0.028), lr(0.026), sheep ? HR : S);
    for (const [bn, prev] of [[`finger.${s}`, `hand.${s}`], [`toe.${s}`, `foot.${s}`]] as const) {
      const b = B(bn);
      const dir = norm(sub(b.tail, b.head));
      if (P_.hoof) {
        // boulet, paturon, sabot (cône tronqué)
        c.push({ kind: "ellipsoid", c: b.head, r: [lr(0.034), lr(0.036), lr(0.036)], role: sheep ? HR : S, tag: 0 }, prev);
        const hr = lr(species === "horse" ? 0.04 : 0.034);
        const hb: V3 = [b.head[0], 0.0, b.head[2] + (b.tail[2] - b.head[2]) * 0.55];
        c.push({ kind: "capsule", a: b.head, b: add(hb, [0, hr * 1.4, 0]), ra: lr(0.027), rb: hr * 0.85, role: sheep ? HR : S, tag: 0 }, bn);
        c.push({ kind: "cone", a: add(hb, [0, hr * 1.25, -hr * 0.12]), b: add(hb, [0, W * 0.002, hr * 0.12]), ra: hr * 0.82, rb: hr * 1.05, round: hr * 0.12, role: LE, tag: 0 }, bn);
      } else {
        // patte : coussinet ovale posé au sol
        const pr = lr(species === "bear" ? 0.05 : 0.038);
        c.push({ kind: "capsule", a: add(b.head, [0, pr * 0.2, -pr * 0.2]), b: add(b.tail, [0, pr * 0.5, -pr * 0.6]), ra: pr * 1.0, rb: pr * 0.85, role: S, tag: 0 }, bn);
      }
    }
  }

  /* ---------- queue ---------- */
  const tR = { dog: 0.05, cat: 0.035, fox: 0.1, horse: 0.07, cow: 0.03, sheep: 0.09, pig: 0.022, deer: 0.06, goat: 0.05, bear: 0.07, rabbit: 0.1 }[species as string] ?? 0.05;
  const tr = W * tR;
  if (species === "fox") {
    c.cap("tail.1", 0, 1, tr * 0.5, tr * 1.0, S);
    c.cap("tail.2", 0, 1, tr * 1.0, tr * 1.15, S);
    c.cap("tail.3", 0, 1, tr * 1.15, tr * 0.35, HR);
  } else if (species === "rabbit" || species === "sheep") {
    c.push({ kind: "ellipsoid", c: at("tail.1", 0.7), r: [tr, tr, tr], role: species === "rabbit" ? HR : S, tag: 0, ...(wool ? { bump: { amp: wool, freq: 1 / (W * 0.045), seed: 13 } } : {}) }, "tail.1");
  } else if (species === "pig") {
    // queue en tire-bouchon sur le premier segment
    const t0 = B("tail.1");
    const td = norm(sub(t0.tail, t0.head));
    const pts: V3[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI * 3;
      const rr = W * 0.035;
      pts.push(add(madd(t0.head, td, (i / 10) * W * 0.06), [Math.sin(a) * rr, (1 - Math.cos(a)) * rr * 0.7 - (i / 10) * W * 0.05, 0]));
    }
    for (let i = 0; i < pts.length - 1; i++) c.push({ kind: "capsule", a: pts[i], b: pts[i + 1], ra: tr, rb: tr * 0.9, role: S, tag: 0 }, i < 5 ? "tail.1" : "tail.2");
  } else if (species === "horse") {
    c.cap("tail.1", 0, 1, tr * 1.1, tr * 0.8, S);
    c.cap("tail.2", 0, 1, tr * 0.8, tr * 0.6, S);
    // crins : tube épais qui suit le tronçon puis tombe jusqu'au jarret
    const t1 = B("tail.1"), t2 = B("tail.2");
    const hk = B("foot.l").head[1];
    const pts: V3[] = [t1.head, t1.tail, t2.tail];
    const start = t2.tail;
    for (let i = 1; i <= 5; i++) {
      const t = i / 5;
      pts.push(add(start, [0, -(start[1] - hk * 0.95) * t, -D * (0.12 * t + 0.1 * Math.sin(t * Math.PI))]));
    }
    const radii = pts.map((_, i) => W * [0.03, 0.045, 0.055, 0.062, 0.064, 0.06, 0.05, 0.03][i]);
    // poids par anneau : tronçon sur tail.1, crins sur tail.2 (rigides : pas d'étirement)
    const seg = 10;
    c.tpl(tube(pts, radii, HR, seg, true, true), ["tail.1", "tail.2"], (vi) => {
      const ring = Math.min(pts.length - 1, Math.floor(vi / (seg + 1)));
      const k = clamp((ring - 1) / 1.5, 0, 1);
      return k <= 0 ? [["tail.1", 1]] : k >= 1 ? [["tail.2", 1]] : [["tail.2", k], ["tail.1", 1 - k]];
    });
  } else if (species === "cow") {
    c.cap("tail.1", 0, 1, tr * 1.4, tr, S);
    c.cap("tail.2", 0, 1, tr, tr * 0.8, S);
    c.cap("tail.3", 0, 0.8, tr * 0.8, tr * 0.8, S);
    c.push({ kind: "capsule", a: at("tail.3", 0.7), b: at("tail.3", 1.25), ra: tr * 1.8, rb: tr * 1.2, role: HR, tag: 0, bump: { amp: tr * 0.4, freq: 1 / (tr * 1.5), seed: 4 } }, "tail.3");
  } else if (species === "deer" || species === "goat" || species === "bear") {
    c.cap("tail.1", 0, 1, tr, tr * 0.8, S);
    c.cap("tail.2", 0, 0.8, tr * 0.8, tr * 0.5, S);
  } else {
    c.cap("tail.1", 0, 1, tr * 1.1, tr * 0.9, S);
    c.cap("tail.2", 0, 1, tr * 0.9, tr * 0.75, S);
    c.cap("tail.3", 0, 1, tr * 0.75, tr * 0.4, S);
  }
  if (species === "cow") {
    // mamelle discrète
    c.push({ kind: "ellipsoid", c: [0, at("pelvis", 0.9)[1] - D * 0.48, at("pelvis", 0.9)[2] + D * 0.05], r: [D * 0.16, D * 0.1, D * 0.17], role: PK, tag: 0 }, "pelvis");
  }

  /* ---------- yeux et ancres ---------- */
  const eyes: { dir: V3; from: V3; r: number }[] = [];
  for (const sx of [1, -1]) {
    const lat = hs.eye[1];
    const ec = hp(0, hs.cr[1] * 0.25, hs.eye[0]);
    const dir = norm(add(scale(upv, 0.25), [sx * lat, 0, 0]));
    const dir2 = norm(add(dir, scale(f, 1 - lat)));
    eyes.push({ from: madd(ec, dir2, hl), dir: scale(dir2, -1), r: hs.eye[2] * hl });
  }
  const headTop = hp(0, hs.cr[1] * 1.05, hs.cz);
  return { eyes, anchors: { headTop, back: [0, at("spine", 1)[1] + D * 0.5, at("spine", 1)[2]] as V3, mouth: madd(tip, f, hs.m1 * hl) } };
}

/* ====================================================================================================== */
/* Oiseaux                                                                                                 */

function birdBody(c: Ctx, species: Species, P_: BirdProps, p: Params, W: number) {
  const { sk, cap, ell, slab, at } = c;
  const S = ROLE.skin, HR = ROLE.hair, AC = ROLE.accent, PK = ROLE.cloth2, C3 = ROLE.cloth3;
  const B = (n: string) => sk.bones[sk.index[n]];
  const k = p.size;
  const bl = P_.bodyLen * k, bh = P_.bodyH * k * mix(0.95, 1.08, p.build), bw = P_.bodyW * k * mix(0.92, 1.12, p.build);
  const duck = species === "duck";
  const cc = sk.meta.center;
  const t = P_.tilt * DEG;
  const f: V3 = [0, Math.sin(t), Math.cos(t)];
  const u: V3 = [0, Math.cos(t), -Math.sin(t)];
  const bp = (lx: number, ly: number, lz: number): V3 => add(madd(madd(cc, u, ly), f, lz), [lx, 0, 0]);
  // corps : poitrine bombée, dos, croupion relevé
  c.push({ kind: "capsule", a: bp(0, 0, -bl * 0.22), b: bp(0, -bh * 0.02, bl * 0.02), ra: bh * 0.47, rb: bh * 0.5, role: S, tag: 0 }, "pelvis");
  // poitrine portée par le bassin (corps d'oiseau rigide : pas de pli entre poitrine et cuisses)
  ell("pelvis", bp(0, -bh * 0.02, bl * 0.18), [bw * 0.5, bh * 0.5, bl * 0.3], duck ? C3 : S);
  if (duck) ell("pelvis", bp(0, -bh * 0.1, -bl * 0.05), [bw * 0.52, bh * 0.42, bl * 0.42], S);
  // ailes repliées
  for (const s of ["l", "r"] as const) {
    const wb = B(`wing.${s}`);
    const sx = s === "l" ? 1 : -1;
    const wd = norm(sub(wb.tail, wb.head));
    const L = len(sub(wb.tail, wb.head));
    c.slab(`wing.${s}`, lerp3(wb.head, wb.tail, 0.45), wd, [0, 1, 0], [[-L * 0.5, -bh * 0.18], [L * 0.2, -bh * 0.22], [L * 0.62, -bh * 0.02], [L * 0.3, bh * 0.2], [-L * 0.45, bh * 0.22]], bw * 0.16, species === "pigeon" || species === "seagull" ? HR : S);
    // pointes des ailes croisées sur la queue (goéland : noires)
    if (species === "seagull") c.slab(`wing.${s}`, lerp3(wb.head, wb.tail, 1.0), wd, [0, 1, 0], [[-L * 0.2, -bh * 0.08], [L * 0.45, -bh * 0.02], [L * 0.1, bh * 0.1]], bw * 0.1, C3);
  }
  // queue
  const tb = B("tail.1");
  const td = norm(sub(tb.tail, tb.head));
  const tl = len(sub(tb.tail, tb.head));
  if (species === "chicken") {
    // faucilles : dalles en éventail, relevées
    for (const [a, l, x] of [[-0.5, 0.9, 0.3], [-0.15, 1.15, -0.25], [0.2, 1.2, 0.2], [0.5, 1.0, -0.2], [0.85, 0.85, 0]] as const) {
      const d = norm(add(td, [x * 0.15, a * 0.7, -a * 0.6]));
      const fe = shaped(EAR_POINTY, bh * 0.38, tl * 1.6 * l, bw * 0.12, HR, 8);
      c.tpl(place(fe, madd(tb.head, td, -tl * 0.2), d, [1, 0, 0]), ["tail.1"]);
    }
  } else {
    const fe = shaped(EAR_POINTY, bw * 0.7, tl * 1.5, bh * 0.14, S, 10);
    c.tpl(place(fe, madd(tb.head, td, -tl * 0.3), td, [0, 1, 0]), ["tail.1"]);
  }
  // cou et tête
  const nr = bh * (duck ? 0.2 : 0.22);
  // cou irisé du pigeon (rôle motif), vert du colvert (rôle secondaire)
  const neckRole = duck ? HR : species === "pigeon" ? C3 : S;
  c.cap("neck.1", -0.2, 1, nr * 1.25, nr, neckRole);
  c.cap("neck.2", 0.3, 1.1, nr, nr * 0.85, neckRole);
  const hb = B("head");
  const hr = P_.headR * k;
  const hc = add(hb.head, [0, hr * 0.45, hr * 0.35]);
  ell("head", hc, [hr * 0.85, hr * 0.95, hr * 1.05], duck ? HR : S);
  if (duck) {
    // collier blanc du colvert (rôle motif clair) et bec plat
    c.cap("neck.1", 0.0, 0.25, nr * 1.08, nr * 1.05, ROLE.eyeWhite);
    const bk = add(hc, [0, -hr * 0.2, hr * 0.7]);
    const bill = shaped(EAR_OVAL, hr * 0.85, P_.beakLen * k * 1.25, hr * 0.32, AC, 10);
    c.tpl(place(bill, bk, norm([0, -0.3, 1]), [0, 1, 0.3]), ["head"]);
  } else {
    const bk = add(hc, [0, -hr * 0.12, hr * 0.9]);
    c.push({ kind: "cone", a: bk, b: add(bk, [0, -P_.beakLen * k * 0.35, P_.beakLen * k]), ra: hr * 0.3, rb: hr * 0.04, round: hr * 0.04, role: AC, tag: 0 }, "head");
    // crête et barbillons (poule seulement)
    const big = p.variant % 2 === 0 ? 1 : 0.6;
    if (species === "chicken") for (let i = 0; i < 4; i++) {
      const tz = mix(0.55, -0.55, i / 3);
      const comb = shaped(EAR_OVAL, hr * 0.42, hr * mix(0.55, 0.85, Math.sin(((i + 0.5) / 4) * Math.PI)) * big, hr * 0.2, PK, 8);
      c.tpl(place(comb, add(hc, [0, hr * 0.7, hr * tz]), norm([0, 1, tz * 0.6]), [1, 0, 0]), ["head"]);
    }
    if (species === "chicken") for (const sx of [1, -1]) {
      const wat = shaped(EAR_OVAL, hr * 0.38, hr * 0.62 * big, hr * 0.16, PK, 8);
      c.tpl(place(wat, add(hc, [sx * hr * 0.12, -hr * 0.55, hr * 0.62]), [0, -1, 0.15], [sx, 0, 0]), ["head"]);
    }
  }
  // pattes : pilon (plumes), tarse et doigts (bec)
  for (const s of ["l", "r"] as const) {
    c.cap(`thigh.${s}`, 0.2, 1, bh * 0.2, bh * 0.16, S);
    c.cap(`shin.${s}`, 0, duck ? 0.6 : 0.45, bh * 0.15, bh * 0.08, S);
    c.cap(`shin.${s}`, duck ? 0.55 : 0.45, 1, bh * 0.05, bh * 0.04, AC);
    c.cap(`foot.${s}`, 0, 1, W * 0.016, W * 0.015, AC);
    const tb2 = B(`toe.${s}`);
    const tlen = len(sub(tb2.tail, tb2.head));
    if (duck) c.tpl(place(shaped(EAR_ROUND, tlen * 1.1, tlen * 1.3, W * 0.02, AC, 8), add(tb2.head, [0, W * 0.012, -tlen * 0.15]), [0, 0, 1], [0, 1, 0]), [`toe.${s}`]);
    else
      for (const a of [-0.5, 0, 0.5]) {
        const d = norm([Math.sin(a), 0, Math.cos(a)]);
        c.push({ kind: "capsule", a: add(tb2.head, [0, W * 0.012, 0]), b: add(madd(tb2.head, d, tlen), [0, W * 0.01, 0]), ra: W * 0.013, rb: W * 0.01, role: AC, tag: 0 }, `toe.${s}`);
      }
  }
  const eyes: { dir: V3; from: V3; r: number }[] = [];
  for (const sx of [1, -1]) {
    const ec = add(hc, [0, hr * 0.2, hr * 0.25]);
    const dir = norm([sx, 0.15, 0.25]);
    eyes.push({ from: madd(ec, dir, hr * 3), dir: scale(dir, -1), r: hr * (duck ? 0.2 : 0.22) });
  }
  return { eyes, anchors: { headTop: add(hc, [0, hr * 1.4, 0]), back: bp(0, bh * 0.5, 0), mouth: add(hc, [0, -hr * 0.2, hr * 0.9 + P_.beakLen * k]) } };
}

/* ====================================================================================================== */
/* Robe                                                                                                    */

function paintCoat(mesh: Mesh, boneOf: (v: number) => string, species: Species, coat: string, pal: Palette, W: number, sk: AnimalSkeleton, seed: number) {
  const S = ROLE.skin, HR = ROLE.hair, C3 = ROLE.cloth3, LE = ROLE.leather;
  const bird = sk.meta.props.kind === "bird";
  const center = sk.meta.center;
  const chestY = center[1];
  const footY = (sk.bone("foot.l")?.head[1] ?? 0) + W * 0.02;
  const carpY = (sk.bone("hand.l")?.head[1] ?? 0) + W * 0.04;
  for (let v = 0; v < mesh.vertexCount; v++) {
    if (mesh.role[v] !== S) continue;
    const p = mesh.getPos(v);
    const n = mesh.getNrm(v);
    const bn = boneOf(v);
    const isLeg = /^(upperarm|forearm|hand|finger|thigh|shin|foot|toe)\./.test(bn);
    const lower = /^(hand|finger|foot|toe)\./.test(bn) || (/^(forearm|shin)\./.test(bn) && p[1] < Math.max(footY, carpY));
    let role = S;
    // marques : ventre et plastron clairs, extrémités
    if (pal.belly && !bird) {
      const under = -n[1] > 0.35 && p[1] < chestY && (bn === "spine" || bn === "chest" || bn === "pelvis" || bn.startsWith("neck"));
      const throat = (bn.startsWith("neck") || bn === "jaw" || bn === "chest") && n[2] > 0.2 && n[1] < 0.3 && p[2] > center[2] + W * 0.25;
      const muzzleUnder = (bn === "jaw" || bn === "head") && n[1] < -0.2;
      if (under || throat || muzzleUnder) role = HR;
    }
    if (pal.points && lower) role = HR;
    if (pal.socks && /^(hand|finger|foot|toe)\./.test(bn)) role = LE;
    if (species === "fox" && /^ear\./.test(bn) && n[2] < 0) role = LE;
    if (species === "deer" && bn.startsWith("tail") && n[1] < 0.2) role = HR;
    if (species === "bear" && (bn === "head") && p[2] > (sk.bone("head")!.head[2] + (sk.bone("head")!.tail[2] - sk.bone("head")!.head[2]) * 0.55)) role = HR;
    if (species === "goat" && pal.points && bn.startsWith("head") && n[1] > 0.3) role = HR;
    if (species === "duck" && pal.name === "colvert" && bn.startsWith("tail")) role = LE;
    // motifs
    const fr = 1 / W;
    if (coat === "spotted") {
      const sc = species === "deer" ? 9 : species === "pig" ? 3.5 : species === "horse" ? 7 : bird ? 22 : 8;
      const nz = noise3(p[0] * fr * sc + seed, p[1] * fr * sc, p[2] * fr * sc);
      const ok = species === "deer" ? n[1] > 0.1 && !isLeg && p[1] > chestY : species === "horse" ? p[2] < 0 : true;
      if (ok && nz > (species === "pig" ? 0.32 : 0.38)) role = C3;
    } else if (coat === "pie") {
      const nz = fbm3(p[0] * fr * 2.2 + seed, p[1] * fr * 2.2, p[2] * fr * 2.2, 3);
      const t = species === "cow" ? 0.02 : species === "dog" || species === "cat" ? 0.12 : 0.18;
      // la tête et le bas des pattes restent souvent clairs ou sombres de façon franche
      if (nz > t && !(lower && species !== "cow")) role = C3;
      if (species === "cat" && pal.name === "smoking" && (p[1] < chestY - W * 0.05 || lower) && !bn.startsWith("tail")) role = C3;
    } else if (coat === "striped") {
      const along = isLeg ? p[1] * 1.4 : bn.startsWith("tail") ? p[2] - p[1] : p[2];
      const warp = noise3(p[0] * fr * 3 + seed, p[1] * fr * 3, p[2] * fr * 3) * 0.6;
      const band = Math.sin((along * fr * (bird ? 30 : 13) + warp) * Math.PI * 2);
      const upness = n[1] * 0.5 + 0.5;
      if (band > 0.55 - upness * 0.6 && role === S) role = C3;
    }
    mesh.role[v] = role;
  }
}

export const _test = { buildAnimalMesh };
export { ANIMAL_PROPS };
