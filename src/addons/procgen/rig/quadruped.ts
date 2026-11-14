/**
 * Squelettes animaux paramétriques : **quadrupède** (≤ 30 os) et **oiseau** simplifié (17 os), en pose de repos debout.
 *
 * Repère du modèle : x = gauche de l'animal, y = haut, z = avant ; sol en y = 0 ; le centre du tronc est à z ≈ 0.
 * Comme pour l'humanoïde, chaque os a une orientation identité au repos (rotations locales dans les axes du modèle).
 *
 * Os du quadrupède : root, pelvis, spine, chest, neck.1, neck.2, head, jaw (option), ear.l/.r (option), tail.1..3,
 * et 4 pattes de 4 os. Noms des pattes alignés sur l'humanoïde (le côté `.l` / `.r` sert au filtrage des poids) :
 * - avant : `upperarm` (humérus, épaule → coude), `forearm` (radius, coude → carpe), `hand` (métacarpe, carpe →
 *   boulet), `finger` (phalanges : sabot ou patte) ;
 * - arrière : `thigh` (fémur, hanche → grasset), `shin` (tibia, grasset → jarret), `foot` (métatarse, jarret →
 *   boulet), `toe` (phalanges).
 * Oiseau : root, pelvis, chest, neck.1, neck.2, head, tail.1, wing.l/.r, thigh/shin/foot/toe (.l/.r).
 *
 * Proportions par espèce exprimées en fraction de la hauteur au garrot `W` (oiseaux : hauteur du dos `H`).
 */
import { type V3, DEG, add, madd, mix, norm, sub } from "../core/math";
import { type BoneDef, Skeleton } from "./skeleton";

export const QUAD_SPECIES = ["dog", "cat", "horse", "cow", "sheep", "pig", "fox", "rabbit", "deer", "goat", "bear"] as const;
export const BIRD_SPECIES = ["duck", "chicken", "pigeon", "seagull"] as const;
export const SPECIES = [...QUAD_SPECIES, ...BIRD_SPECIES] as const;
export type Species = (typeof SPECIES)[number];

/** Proportions d'un quadrupède (longueurs en fraction de W, angles en degrés). */
export type QuadProps = {
  kind: "quad";
  /** Hauteur au garrot typique (m). */
  W: number;
  /** Distance hanche → épaule. */
  bodyLen: number;
  /** Hauteur du tronc (dos → ventre). */
  depth: number;
  /** Hauteur de la croupe (1 = dos horizontal). */
  croup: number;
  /** Demi-largeur du tronc en fraction de `depth`. */
  wid: number;
  neckLen: number;
  /** Angle du cou au-dessus de l'horizontale. */
  neckAng: number;
  headLen: number;
  /** Angle du chanfrein sous l'horizontale. */
  headAng: number;
  /** Hauteur du carpe et du boulet en fraction de la hauteur du coude. */
  carpus: number;
  fet: number;
  /** Hauteur du jarret. */
  hock: number;
  /** Inclinaison du métatarse et du métacarpe (vers l'avant, °) : ~0 ongulé, ~70 plantigrade. */
  hindMeta: number;
  frontMeta: number;
  /** Longueur des phalanges (sabot, patte). */
  toeLen: number;
  hoof: boolean;
  tailLen: number;
  /** Angle de la queue sous l'horizontale (négatif = relevée) et courbure par segment. */
  tailAng: number;
  tailCurl: number;
  earLen: number;
  /** Écart latéral et inclinaison arrière des oreilles (°) au repos. */
  earSpread: number;
  earTilt: number;
  jaw: boolean;
  /** Allures disponibles. */
  gallop: boolean;
  bound: boolean;
  /** Souplesse de la colonne (0 ongulé … 1 félin) : ondulation, flexion au galop. */
  spineFlex: number;
};

export type BirdProps = {
  kind: "bird";
  /** Hauteur du dos (m). */
  H: number;
  bodyY: number;
  bodyLen: number;
  bodyH: number;
  bodyW: number;
  /** Bascule du corps (°, avant relevé). */
  tilt: number;
  neckLen: number;
  neckAng: number;
  headR: number;
  beakLen: number;
  /** Hauteur de la cheville (tarse). */
  shank: number;
  toeLen: number;
  tailLen: number;
  tailAng: number;
  /** Dandinement (canard). */
  waddle: number;
  /** Hochement de tête (poule). */
  bob: number;
};

export type AnimalProps = QuadProps | BirdProps;

const Q = (o: Omit<QuadProps, "kind" | "jaw" | "bound"> & Partial<Pick<QuadProps, "jaw" | "bound">>): QuadProps => ({ kind: "quad", jaw: true, bound: false, ...o });

export const ANIMAL_PROPS: Record<Species, AnimalProps> = {
  dog: Q({ W: 0.55, bodyLen: 0.78, depth: 0.5, croup: 0.98, wid: 0.5, neckLen: 0.36, neckAng: 48, headLen: 0.4, headAng: 12, carpus: 0.33, fet: 0.07, hock: 0.3, hindMeta: 14, frontMeta: 8, toeLen: 0.12, hoof: false, tailLen: 0.55, tailAng: -25, tailCurl: -14, earLen: 0.19, earSpread: 18, earTilt: 8, gallop: true, spineFlex: 0.6 }),
  cat: Q({ W: 0.26, bodyLen: 0.85, depth: 0.56, croup: 1.03, wid: 0.5, neckLen: 0.26, neckAng: 40, headLen: 0.44, headAng: 4, carpus: 0.3, fet: 0.07, hock: 0.32, hindMeta: 16, frontMeta: 6, toeLen: 0.12, hoof: false, tailLen: 1.05, tailAng: -55, tailCurl: 22, earLen: 0.16, earSpread: 20, earTilt: -4, gallop: true, spineFlex: 1 }),
  horse: Q({ W: 1.6, bodyLen: 0.76, depth: 0.46, croup: 1.0, wid: 0.44, neckLen: 0.52, neckAng: 46, headLen: 0.44, headAng: 58, carpus: 0.5, fet: 0.11, hock: 0.36, hindMeta: 3, frontMeta: 2, toeLen: 0.07, hoof: true, tailLen: 0.26, tailAng: 35, tailCurl: 18, earLen: 0.12, earSpread: 10, earTilt: -5, gallop: true, spineFlex: 0.15 }),
  cow: Q({ W: 1.35, bodyLen: 0.92, depth: 0.58, croup: 1.03, wid: 0.55, neckLen: 0.34, neckAng: 10, headLen: 0.46, headAng: 38, carpus: 0.44, fet: 0.1, hock: 0.36, hindMeta: 4, frontMeta: 2, toeLen: 0.07, hoof: true, tailLen: 0.62, tailAng: 42, tailCurl: 20, earLen: 0.14, earSpread: 80, earTilt: 10, gallop: false, spineFlex: 0.1 }),
  sheep: Q({ W: 0.72, bodyLen: 0.8, depth: 0.58, croup: 1.0, wid: 0.72, neckLen: 0.3, neckAng: 35, headLen: 0.32, headAng: 40, carpus: 0.42, fet: 0.1, hock: 0.32, hindMeta: 5, frontMeta: 3, toeLen: 0.07, hoof: true, tailLen: 0.2, tailAng: 70, tailCurl: 5, earLen: 0.14, earSpread: 72, earTilt: 18, gallop: false, spineFlex: 0.2 }),
  pig: Q({ W: 0.72, bodyLen: 0.82, depth: 0.66, croup: 1.02, wid: 0.66, neckLen: 0.14, neckAng: 0, headLen: 0.46, headAng: 14, carpus: 0.42, fet: 0.12, hock: 0.3, hindMeta: 6, frontMeta: 4, toeLen: 0.07, hoof: true, tailLen: 0.18, tailAng: -10, tailCurl: 0, earLen: 0.28, earSpread: 30, earTilt: -30, gallop: false, spineFlex: 0.15 }),
  fox: Q({ W: 0.38, bodyLen: 0.92, depth: 0.4, croup: 0.98, wid: 0.45, neckLen: 0.34, neckAng: 36, headLen: 0.46, headAng: 10, carpus: 0.32, fet: 0.07, hock: 0.3, hindMeta: 16, frontMeta: 8, toeLen: 0.12, hoof: false, tailLen: 0.95, tailAng: 28, tailCurl: -5, earLen: 0.2, earSpread: 18, earTilt: 2, gallop: true, spineFlex: 0.7 }),
  rabbit: Q({ W: 0.2, bodyLen: 0.78, depth: 0.7, croup: 1.38, wid: 0.5, neckLen: 0.2, neckAng: 52, headLen: 0.5, headAng: 26, carpus: 0.3, fet: 0.08, hock: 0.08, hindMeta: 80, frontMeta: 10, toeLen: 0.22, hoof: false, tailLen: 0.18, tailAng: -20, tailCurl: 0, earLen: 0.72, earSpread: 10, earTilt: 22, gallop: false, bound: true, spineFlex: 0.8 }),
  deer: Q({ W: 1.0, bodyLen: 0.8, depth: 0.42, croup: 1.03, wid: 0.42, neckLen: 0.52, neckAng: 56, headLen: 0.38, headAng: 42, carpus: 0.5, fet: 0.1, hock: 0.4, hindMeta: 4, frontMeta: 2, toeLen: 0.06, hoof: true, tailLen: 0.16, tailAng: 30, tailCurl: 0, earLen: 0.2, earSpread: 50, earTilt: 5, gallop: true, spineFlex: 0.3 }),
  goat: Q({ W: 0.7, bodyLen: 0.82, depth: 0.48, croup: 1.04, wid: 0.5, neckLen: 0.38, neckAng: 52, headLen: 0.38, headAng: 46, carpus: 0.45, fet: 0.1, hock: 0.33, hindMeta: 5, frontMeta: 3, toeLen: 0.07, hoof: true, tailLen: 0.17, tailAng: -55, tailCurl: 0, earLen: 0.16, earSpread: 70, earTilt: 15, gallop: false, spineFlex: 0.25 }),
  bear: Q({ W: 1.0, bodyLen: 0.86, depth: 0.52, croup: 0.96, wid: 0.62, neckLen: 0.32, neckAng: 5, headLen: 0.34, headAng: 16, carpus: 0.3, fet: 0.06, hock: 0.24, hindMeta: 22, frontMeta: 10, toeLen: 0.16, hoof: false, tailLen: 0.1, tailAng: 40, tailCurl: 0, earLen: 0.12, earSpread: 25, earTilt: 0, gallop: true, spineFlex: 0.35 }),
  duck: { kind: "bird", H: 0.3, bodyY: 0.17, bodyLen: 0.38, bodyH: 0.17, bodyW: 0.16, tilt: -4, neckLen: 0.14, neckAng: 78, headR: 0.05, beakLen: 0.065, shank: 0.06, toeLen: 0.06, tailLen: 0.08, tailAng: -25, waddle: 1, bob: 0.25 },
  pigeon: { kind: "bird", H: 0.24, bodyY: 0.15, bodyLen: 0.22, bodyH: 0.13, bodyW: 0.11, tilt: 8, neckLen: 0.07, neckAng: 70, headR: 0.028, beakLen: 0.02, shank: 0.045, toeLen: 0.035, tailLen: 0.12, tailAng: -15, waddle: 0.15, bob: 1 },
  seagull: { kind: "bird", H: 0.34, bodyY: 0.2, bodyLen: 0.36, bodyH: 0.15, bodyW: 0.14, tilt: 4, neckLen: 0.1, neckAng: 72, headR: 0.042, beakLen: 0.055, shank: 0.085, toeLen: 0.05, tailLen: 0.12, tailAng: -10, waddle: 0.35, bob: 0.3 },
  chicken: { kind: "bird", H: 0.36, bodyY: 0.22, bodyLen: 0.3, bodyH: 0.21, bodyW: 0.17, tilt: 14, neckLen: 0.12, neckAng: 72, headR: 0.042, beakLen: 0.035, shank: 0.09, toeLen: 0.055, tailLen: 0.14, tailAng: -55, waddle: 0.3, bob: 1 },
};

/** Méta-données d'animation attachées au squelette. */
export type AnimalMeta = {
  species: Species;
  props: AnimalProps;
  /** Échelle appliquée aux proportions (taille × hauteur typique). */
  W: number;
  /** Centre du tronc au repos (pivot du tangage). */
  center: V3;
};

/** Squelette animal : un `Skeleton` portant ses proportions (lu par `rig/quadruped-motion.ts`). */
export class AnimalSkeleton extends Skeleton {
  constructor(defs: BoneDef[], readonly meta: AnimalMeta) {
    super(defs);
  }
}

export type BuildOptions = {
  /** Facteur de taille (1 = adulte typique). */
  size: number;
  /** Carrure 0 fin … 1 massif (élargit le tronc, raccourcit un peu les pattes). */
  build: number;
  /** Variantes : longueur du cou et de la tête (micro-variations par graine). */
  neck?: number;
  head?: number;
  leg?: number;
};

const dirYZ = (angDownDeg: number, back = false): V3 => {
  const a = angDownDeg * DEG;
  return [0, -Math.sin(a), back ? -Math.cos(a) : Math.cos(a)];
};

/** Construit le squelette d'une espèce. */
export function buildAnimal(species: Species, o: BuildOptions): AnimalSkeleton {
  const pr = ANIMAL_PROPS[species];
  return pr.kind === "bird" ? buildBird(species, pr, o) : buildQuad(species, pr, o);
}

function buildQuad(species: Species, p: QuadProps, o: BuildOptions): AnimalSkeleton {
  const W = p.W * o.size;
  const legK = (o.leg ?? 1) * mix(1.03, 0.95, o.build);
  const L = p.bodyLen * W;
  const D = p.depth * W * mix(0.95, 1.08, o.build);
  const zS = L / 2, zH = -L / 2;
  // ligne de dos : croupe en arrière, garrot en avant (les pattes plus courtes abaissent le corps)
  const lower = W * (1 - legK) * 0.6;
  const topAt = (z: number) => mix(p.croup * W, W, (z - zH) / (zS - zH)) - lower;
  const yc = (z: number) => topAt(z) - D * 0.5;
  const half = p.wid * D * mix(0.92, 1.12, o.build);
  const bones: BoneDef[] = [];
  const add_ = (b: Omit<BoneDef, "deform"> & { deform?: boolean }) => bones.push({ deform: true, ...b });
  add_({ name: "root", parent: null, head: [0, 0, 0], tail: [0, W * 0.1, 0], radius: [0, 0], deform: false });
  // tronc : bassin (croupe) → rein → poitrine (garrot, base du cou)
  const pel0: V3 = [0, yc(zH) + D * 0.05, zH - D * 0.28];
  const pel1: V3 = [0, yc(zH + L * 0.3), zH + L * 0.3];
  const spi1: V3 = [0, yc(zH + L * 0.66), zH + L * 0.66];
  const neck0: V3 = [0, topAt(zS) - D * 0.3, zS + D * 0.12];
  add_({ name: "pelvis", parent: "root", head: pel0, tail: pel1, radius: [D * 0.5, D * 0.5] });
  add_({ name: "spine", parent: "pelvis", head: pel1, tail: spi1, radius: [D * 0.5, D * 0.5] });
  add_({ name: "chest", parent: "spine", head: spi1, tail: neck0, radius: [D * 0.5, D * 0.45] });
  // cou et tête
  const nl = p.neckLen * W * (o.neck ?? 1);
  const na = p.neckAng * DEG;
  const nd: V3 = [0, Math.sin(na), Math.cos(na)];
  const neck1 = madd(neck0, nd, nl * 0.5);
  const poll = madd(neck0, nd, nl);
  add_({ name: "neck.1", parent: "chest", head: neck0, tail: neck1, radius: [D * 0.3, D * 0.24] });
  add_({ name: "neck.2", parent: "neck.1", head: neck1, tail: poll, radius: [D * 0.24, D * 0.18] });
  const hl = p.headLen * W * (o.head ?? 1);
  const hd = dirYZ(p.headAng);
  const nose = madd(poll, hd, hl);
  add_({ name: "head", parent: "neck.2", head: poll, tail: nose, radius: [hl * 0.3, hl * 0.18] });
  const up = norm([0, hd[2], -hd[1]]);
  if (p.jaw) add_({ name: "jaw", parent: "head", head: madd(madd(poll, hd, hl * 0.3), up, -hl * 0.2), tail: madd(madd(poll, hd, hl * 0.92), up, -hl * 0.14), radius: [hl * 0.1, hl * 0.06] });
  if (p.earLen > 0)
    for (const [s, sx] of [["l", 1], ["r", -1]] as const) {
      const base = add(madd(poll, up, hl * 0.12), [sx * hl * 0.16, 0, 0]);
      const sp = p.earSpread * DEG, tl = p.earTilt * DEG;
      const dir = norm([sx * Math.sin(sp), Math.cos(sp) * Math.cos(tl), -Math.cos(sp) * Math.sin(tl)]);
      add_({ name: `ear.${s}`, parent: "head", head: base, tail: madd(base, dir, p.earLen * W * (o.head ?? 1)), radius: [hl * 0.06, hl * 0.03] });
    }
  // queue : trois segments, courbure progressive
  let tp: V3 = [0, topAt(zH) - D * 0.16, zH - D * 0.42];
  let ta = p.tailAng;
  const tseg = (p.tailLen * W) / 3;
  for (let i = 1; i <= 3; i++) {
    const d = dirYZ(ta, true);
    const nt = madd(tp, d, tseg);
    add_({ name: `tail.${i}`, parent: i === 1 ? "pelvis" : `tail.${i - 1}`, head: tp, tail: nt, radius: [D * 0.08, D * 0.06] });
    tp = nt;
    ta += p.tailCurl;
  }
  // pattes
  const elbowY = Math.max(W * 0.18, topAt(zS) - D * 1.0);
  const carpY = elbowY * p.carpus * legK, fetY = Math.max(W * 0.03, elbowY * p.fet);
  const toeY = W * 0.012;
  const hipY = topAt(zH) - D * 0.42;
  const hockY = Math.max(fetY + W * 0.02, W * p.hock * legK);
  for (const [s, sx] of [["l", 1], ["r", -1]] as const) {
    // avant
    const xF = sx * half * 0.62;
    const S: V3 = [xF, topAt(zS) - D * 0.56, zS + D * 0.02];
    const E: V3 = [xF, elbowY, zS - D * 0.26];
    const C: V3 = [xF, carpY, E[2] + D * 0.03];
    const fm = p.frontMeta * DEG;
    const F: V3 = [xF, fetY, C[2] + Math.tan(fm) * (carpY - fetY)];
    const T: V3 = p.hoof ? [xF, toeY, F[2] + p.toeLen * W * 0.7] : [xF, toeY, F[2] + p.toeLen * W];
    add_({ name: `upperarm.${s}`, parent: "chest", head: S, tail: E, radius: [D * 0.16, D * 0.11] });
    add_({ name: `forearm.${s}`, parent: `upperarm.${s}`, head: E, tail: C, radius: [D * 0.1, D * 0.07] });
    add_({ name: `hand.${s}`, parent: `forearm.${s}`, head: C, tail: F, radius: [D * 0.06, D * 0.06] });
    add_({ name: `finger.${s}`, parent: `hand.${s}`, head: F, tail: T, radius: [D * 0.06, D * 0.06] });
    // arrière
    const xH = sx * half * 0.6;
    const Hp: V3 = [xH, hipY, zH + D * 0.02];
    const hm = p.hindMeta * DEG;
    const Hk: V3 = [xH, hockY, zH - D * 0.2 - Math.sin(hm) * (hockY - fetY) * 0.3];
    const K: V3 = [xH, mix(hockY, hipY, 0.5), zH + D * 0.12];
    const metaLen = (hockY - fetY) / Math.max(0.2, Math.cos(hm));
    const HF: V3 = [xH, fetY, Hk[2] + Math.sin(hm) * metaLen];
    const HT: V3 = p.hoof ? [xH, toeY, HF[2] + p.toeLen * W * 0.7] : [xH, toeY, HF[2] + p.toeLen * W];
    add_({ name: `thigh.${s}`, parent: "pelvis", head: Hp, tail: K, radius: [D * 0.2, D * 0.13] });
    add_({ name: `shin.${s}`, parent: `thigh.${s}`, head: K, tail: Hk, radius: [D * 0.12, D * 0.07] });
    add_({ name: `foot.${s}`, parent: `shin.${s}`, head: Hk, tail: HF, radius: [D * 0.06, D * 0.06] });
    add_({ name: `toe.${s}`, parent: `foot.${s}`, head: HF, tail: HT, radius: [D * 0.06, D * 0.06] });
  }
  return new AnimalSkeleton(bones, { species, props: p, W, center: [0, yc(0), 0] });
}

function buildBird(species: Species, p: BirdProps, o: BuildOptions): AnimalSkeleton {
  const k = o.size;
  const H = p.H * k;
  const bl = p.bodyLen * k, bh = p.bodyH * k * mix(0.95, 1.08, o.build), bw = p.bodyW * k * mix(0.92, 1.12, o.build);
  const c: V3 = [0, p.bodyY * k, 0];
  const t = p.tilt * DEG;
  const f: V3 = [0, Math.sin(t), Math.cos(t)];
  const u: V3 = [0, Math.cos(t), -Math.sin(t)];
  const bones: BoneDef[] = [];
  const add_ = (b: Omit<BoneDef, "deform"> & { deform?: boolean }) => bones.push({ deform: true, ...b });
  add_({ name: "root", parent: null, head: [0, 0, 0], tail: [0, H * 0.1, 0], radius: [0, 0], deform: false });
  const back = madd(c, f, -bl * 0.32);
  const front = madd(madd(c, f, bl * 0.3), u, bh * 0.12);
  add_({ name: "pelvis", parent: "root", head: back, tail: c, radius: [bh * 0.5, bh * 0.5] });
  add_({ name: "chest", parent: "pelvis", head: c, tail: front, radius: [bh * 0.5, bh * 0.45] });
  const na = p.neckAng * DEG;
  const nd: V3 = [0, Math.sin(na), Math.cos(na)];
  const nl = p.neckLen * k * (o.neck ?? 1);
  const n1 = madd(front, nd, nl * 0.5), poll = madd(front, nd, nl);
  add_({ name: "neck.1", parent: "chest", head: front, tail: n1, radius: [bh * 0.22, bh * 0.18] });
  add_({ name: "neck.2", parent: "neck.1", head: n1, tail: poll, radius: [bh * 0.18, bh * 0.15] });
  const hr = p.headR * k * (o.head ?? 1);
  add_({ name: "head", parent: "neck.2", head: poll, tail: add(poll, [0, hr * 0.2, hr * 1.2 + p.beakLen * k]), radius: [hr, hr * 0.5] });
  const tb = madd(madd(c, f, -bl * 0.45), u, bh * 0.15);
  add_({ name: "tail.1", parent: "pelvis", head: tb, tail: madd(tb, dirYZ(p.tailAng, true), p.tailLen * k), radius: [bh * 0.15, bh * 0.1] });
  for (const [s, sx] of [["l", 1], ["r", -1]] as const) {
    const w0 = add(madd(madd(c, f, bl * 0.2), u, bh * 0.18), [sx * bw * 0.82, 0, 0]);
    const w1 = add(madd(madd(c, f, -bl * 0.42), u, bh * 0.2), [sx * bw * 0.7, 0, 0]);
    add_({ name: `wing.${s}`, parent: "chest", head: w0, tail: w1, radius: [bh * 0.2, bh * 0.1] });
    const x = sx * bw * 0.42;
    const hip: V3 = [x, c[1] - bh * 0.05, c[2] - bl * 0.02];
    const knee: V3 = [x, c[1] - bh * 0.38, c[2] + bl * 0.12];
    const ankle: V3 = [x, p.shank * k, c[2] - bl * 0.08];
    const ball: V3 = [x, H * 0.025, c[2] + bl * 0.0];
    add_({ name: `thigh.${s}`, parent: "pelvis", head: hip, tail: knee, radius: [bh * 0.2, bh * 0.15] });
    add_({ name: `shin.${s}`, parent: `thigh.${s}`, head: knee, tail: ankle, radius: [bh * 0.12, bh * 0.06] });
    add_({ name: `foot.${s}`, parent: `shin.${s}`, head: ankle, tail: ball, radius: [bh * 0.04, bh * 0.04] });
    add_({ name: `toe.${s}`, parent: `foot.${s}`, head: ball, tail: [x, H * 0.01, ball[2] + p.toeLen * k], radius: [bh * 0.04, bh * 0.03] });
  }
  return new AnimalSkeleton(bones, { species, props: p, W: H, center: c });
}

/** Paires parent-enfant soudées en union douce (rayon × W). */
export const ANIMAL_BLENDS: [string, string, number][] = [
  ["pelvis", "spine", 0.08],
  ["spine", "chest", 0.08],
  ["pelvis", "chest", 0.06],
  ["chest", "neck.1", 0.06],
  ["neck.1", "neck.2", 0.04],
  ["neck.2", "head", 0.035],
  ["head", "jaw", 0.02],
  ["head", "ear", 0.012],
  ["pelvis", "tail.1", 0.03],
  ["tail.1", "tail.2", 0.02],
  ["tail.2", "tail.3", 0.02],
  ["chest", "upperarm", 0.07],
  ["upperarm", "forearm", 0.035],
  ["forearm", "hand", 0.02],
  ["hand", "finger", 0.012],
  ["pelvis", "thigh", 0.08],
  ["thigh", "shin", 0.035],
  ["shin", "foot", 0.02],
  ["foot", "toe", 0.012],
  ["chest", "wing", 0.03],
];

