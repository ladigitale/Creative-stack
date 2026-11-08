/**
 * Objets pour animaux (`pet`, raccourci `pet.<kind>`) : niche, gamelle, abreuvoir, mangeoire à oiseaux, cage, clapier,
 * poulailler, arbre à chat, griffoir, aquarium, bain d'oiseaux, râtelier à foin, litière, porte-selle… sur la grammaire
 * de pièces (même modèle en 3D et en vectoriel). `for` règle la taille sur l'animal (chien, chat, cheval, poule,
 * lapin, oiseau) ; chaque objet publie une ancre `spot` (où l'animal mange, boit, dort, se perche) et ses affordances.
 */
import { type Q, type V3, clamp } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, partsBounds, partsToMesh, roleParam, transformParts } from "./parts";
import { type Anchor, defineGenerator } from "./types";

type Built = { parts: PartList; spot: V3; affords: string[] };
type O = { main: Role; trim: Role; s: number };

const bx = (c: V3, h: V3, role: Role, rot?: V3): Part => ({ t: "box", c, h, role, rot });
const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, r1, role });
const circle = (r: number, n = 20): [number, number][] => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r] as [number, number]);
/** Pignon pentagonal (maison) de demi-largeur `w`, mur `h`, faîte `r`, plan x–y. */
const gable = (w: number, h: number, r: number): [number, number][] => [[-w, 0], [w, 0], [w, h], [0, h + r], [-w, h]];
/** Toit à deux pans au-dessus d'un mur à la hauteur `h`, faîte `r`, profondeur 2·`d`. */
function roof(P: PartList, w: number, h: number, r: number, d: number, role: Role, over = 0.05) {
  // même pente que le pignon ; pan prolongé de `over` au-delà du mur, posé sur l'arête (demi-épaisseur vers l'extérieur)
  const a = Math.atan2(r, w), L = (w + over) / Math.cos(a), t = 0.012;
  for (const s of [-1, 1]) {
    const cx = (s * (w + over)) / 2, cy = h + r - (r * (w + over)) / (2 * w);
    P.push(bx([cx + s * Math.sin(a) * t, cy + Math.cos(a) * t, 0], [L / 2, t, d + over], role, [0, 0, (-s * a * 180) / Math.PI]));
  }
}

/** Dimension de référence (m) de l'animal visé, pour mettre les objets à sa taille. */
export const ANIMAL_SIZE: Record<string, number> = { dog: 1, cat: 0.55, horse: 2.6, chicken: 0.5, rabbit: 0.45, bird: 0.25 };

const KINDS: Record<string, { label: string; for: string; main: Role; trim: Role; build: (o: O) => Built }> = {
  kennel: {
    label: "Niche",
    for: "dog",
    main: "wood",
    trim: "roof",
    build: (o) => {
      // à la taille du chien du générateur `animal` (≈ 0,74 m de haut, 1,2 m de long)
      const w = 0.42, h = 0.66, r = 0.3, d = 0.65;
      const P: PartList = [{ t: "plate", c: [0, 0, d], pts: gable(w, h, r), d: 0.012, role: o.main }, { t: "plate", c: [0, 0, -d], pts: gable(w, h, r), d: 0.012, role: o.main }];
      P.push(bx([w, h / 2, 0], [0.012, h / 2, d], o.main), bx([-w, h / 2, 0], [0.012, h / 2, d], o.main), bx([0, 0.02, 0], [w, 0.02, d], o.main));
      // entrée en arche sombre sur la façade
      P.push({ t: "plate", c: [0, 0, d + 0.014], pts: [[-0.18, 0.04], [0.18, 0.04], [0.18, 0.46], [0.12, 0.56], [0, 0.6], [-0.12, 0.56], [-0.18, 0.46]], d: 0.002, role: "ink" });
      roof(P, w, h, r, d, o.trim);
      return { parts: P, spot: [0, 0.05, 0], affords: ["shelter", "sleep"] };
    },
  },
  bowl: {
    label: "Gamelle",
    for: "dog",
    main: "red",
    trim: "leather",
    build: (o) => ({ parts: [{ t: "lathe", c: [0, 0, 0], profile: [[0.1, 0], [0.12, 0.01], [0.13, 0.06], [0.12, 0.065], [0.1, 0.03], [0, 0.03]], role: o.main }, { t: "lathe", c: [0, 0.03, 0], profile: [[0.1, 0], [0.1, 0.012], [0, 0.015]], role: o.trim }], spot: [0, 0, 0.3], affords: ["eat", "drink"] }),
  },
  trough: {
    label: "Abreuvoir",
    for: "horse",
    main: "stone",
    trim: "water",
    build: (o) => {
      const P: PartList = [bx([0, 0.04, 0], [0.8, 0.04, 0.3], o.main)];
      for (const s of [-1, 1]) P.push(bx([0, 0.3, s * 0.27], [0.8, 0.26, 0.03], o.main), bx([s * 0.77, 0.3, 0], [0.03, 0.26, 0.27], o.main));
      P.push(bx([0, 0.45, 0], [0.74, 0.01, 0.24], o.trim));
      return { parts: P, spot: [0, 0.5, 0.45], affords: ["drink"] };
    },
  },
  birdfeeder: {
    label: "Mangeoire à oiseaux",
    for: "bird",
    main: "wood",
    trim: "roof",
    build: (o) => {
      const P: PartList = [rod([0, 0, 0], [0, 1.4, 0], 0.03, o.main), bx([0, 1.42, 0], [0.18, 0.012, 0.18], o.main)];
      for (const [x, z] of [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]]) P.push(rod([x, 1.43, z], [x, 1.63, z], 0.01, o.main));
      P.push({ t: "blob", c: [0, 1.45, 0], r: [0.12, 0.02, 0.12], role: "yellow" });
      roof(P, 0.17, 1.63, 0.1, 0.18, o.trim, 0.05);
      return { parts: P, spot: [0.18, 1.45, 0], affords: ["eat", "perch"] };
    },
  },
  birdcage: {
    label: "Cage à oiseaux",
    for: "bird",
    main: "metal",
    trim: "wood",
    build: (o) => {
      const P: PartList = [{ t: "lathe", c: [0, 0, 0], profile: [[0.2, 0], [0.21, 0.02], [0.2, 0.05], [0, 0.05]], role: o.trim }];
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        P.push({ t: "tube", pts: [[Math.cos(a) * 0.19, 0.05, Math.sin(a) * 0.19], [Math.cos(a) * 0.19, 0.4, Math.sin(a) * 0.19], [Math.cos(a) * 0.12, 0.52, Math.sin(a) * 0.12], [0, 0.56, 0]], r: 0.003, role: o.main });
      }
      P.push({ t: "tube", pts: [[0, 0.56, 0], [0.04, 0.6, 0], [0, 0.65, 0], [-0.04, 0.6, 0], [0, 0.56, 0]], r: 0.005, role: o.main }, rod([-0.15, 0.2, 0], [0.15, 0.2, 0], 0.006, o.trim));
      return { parts: P, spot: [0, 0.21, 0], affords: ["perch", "shelter"] };
    },
  },
  hutch: {
    label: "Clapier",
    for: "rabbit",
    main: "wood",
    trim: "roof",
    build: (o) => {
      const P: PartList = [];
      for (const [x, z] of [[-0.55, -0.3], [0.55, -0.3], [-0.55, 0.3], [0.55, 0.3]]) P.push(bx([x, 0.2, z], [0.03, 0.2, 0.03], o.main));
      P.push(bx([0, 0.42, 0], [0.6, 0.02, 0.35], o.main), bx([0, 0.7, -0.33], [0.6, 0.28, 0.02], o.main), bx([-0.58, 0.7, 0], [0.02, 0.28, 0.35], o.main), bx([0.58, 0.7, 0], [0.02, 0.28, 0.35], o.main));
      P.push(bx([0.3, 0.7, 0.34], [0.28, 0.27, 0.01], o.main));
      // grillage : barreaux fins sur la moitié gauche de la façade
      for (let i = 0; i < 8; i++) P.push(rod([-0.56 + i * 0.075, 0.44, 0.34], [-0.56 + i * 0.075, 0.97, 0.34], 0.003, "metal"));
      P.push(bx([0, 0.74, -0.33], [0.6, 0.32, 0.02], o.main));
      P.push({ t: "box", c: [0, 1.02, 0.02], h: [0.66, 0.02, 0.42], role: o.trim, rot: [6, 0, 0] });
      return { parts: P, spot: [-0.3, 0.45, 0], affords: ["shelter", "sleep", "eat"] };
    },
  },
  henhouse: {
    label: "Poulailler",
    for: "chicken",
    main: "wood",
    trim: "roof",
    build: (o) => {
      const w = 0.6, h = 0.9, r = 0.4, d = 0.5;
      const P: PartList = [];
      for (const [x, z] of [[-w, -d], [w, -d], [-w, d], [w, d]]) P.push(bx([x, 0.15, z], [0.04, 0.15, 0.04], o.main));
      const base = 0.3;
      P.push({ t: "plate", c: [0, base, d], pts: gable(w, h, r), d: 0.015, role: o.main }, { t: "plate", c: [0, base, -d], pts: gable(w, h, r), d: 0.015, role: o.main });
      P.push(bx([w, base + h / 2, 0], [0.015, h / 2, d], o.main), bx([-w, base + h / 2, 0], [0.015, h / 2, d], o.main), bx([0, base + 0.015, 0], [w, 0.015, d], o.main));
      P.push({ t: "plate", c: [0.25, base, d + 0.017], pts: [[-0.16, 0.02], [0.16, 0.02], [0.16, 0.44], [-0.16, 0.44]], d: 0.002, role: "ink" });
      // rampe d'accès
      P.push({ t: "box", c: [0.25, base / 2 + 0.02, d + 0.35], h: [0.12, 0.01, 0.38], role: o.main, rot: [25, 0, 0] });
      // rampe : haute contre la trappe, au sol au bout ; tasseaux sur la planche
      for (let i = 0; i < 5; i++) P.push(bx([0.25, 0.065 + i * 0.065, d + 0.62 - i * 0.14], [0.12, 0.008, 0.012], o.main, [25, 0, 0]));
      const P2: PartList = [];
      roof(P2, w, h, r, d, o.trim, 0.08);
      P.push(...transformParts(P2, [0, 0, 0, 1], [0, base, 0]));
      return { parts: P, spot: [0, base + 0.03, 0], affords: ["shelter", "sleep", "lay"] };
    },
  },
  cattree: {
    label: "Arbre à chat",
    for: "cat",
    main: "path",
    trim: "cloth1",
    build: (o) => ({
      parts: [
        bx([0, 0.03, 0], [0.3, 0.03, 0.3], o.trim),
        rod([-0.12, 0.06, -0.08], [-0.12, 1.2, -0.08], 0.06, o.main),
        rod([0.16, 0.06, 0.1], [0.16, 0.75, 0.1], 0.055, o.main),
        { t: "lathe", c: [0.16, 0.75, 0.1], profile: [[0.2, 0], [0.2, 0.04], [0, 0.04]], role: o.trim },
        { t: "lathe", c: [-0.12, 1.2, -0.08], profile: [[0.24, 0], [0.24, 0.05], [0.2, 0.1], [0.16, 0.1], [0, 0.06]], role: o.trim },
        bx([-0.05, 0.42, 0.12], [0.18, 0.02, 0.14], o.trim),
        { t: "blob", c: [0.14, 0.45, 0.2], r: [0.035, 0.035, 0.035], role: "red" },
        rod([0.14, 0.42, 0.2], [0.14, 0.49, 0.2], 0.003, "ink"),
      ],
      spot: [-0.12, 1.3, -0.08],
      affords: ["climb", "perch", "scratch", "sleep"],
    }),
  },
  scratchingpost: {
    label: "Griffoir",
    for: "cat",
    main: "path",
    trim: "cloth2",
    build: (o) => ({ parts: [bx([0, 0.025, 0], [0.2, 0.025, 0.2], o.trim), rod([0, 0.05, 0], [0, 0.65, 0], 0.05, o.main), bx([0, 0.67, 0], [0.13, 0.02, 0.13], o.trim)], spot: [0, 0.05, 0.25], affords: ["scratch"] }),
  },
  aquarium: {
    label: "Aquarium",
    for: "cat",
    main: "water",
    trim: "black",
    build: (o) => ({
      parts: [
        bx([0, 0.35, 0], [0.5, 0.35, 0.22], o.trim),
        bx([0, 0.92, 0], [0.48, 0.22, 0.2], "water"),
        ...[-0.49, 0.49].flatMap((x) => [-0.21, 0.21].map((z) => rod([x, 0.7, z], [x, 1.15, z], 0.01, o.trim))),
        bx([0, 1.17, 0], [0.51, 0.015, 0.23], o.trim),
        bx([0, 0.72, 0.1], [0.47, 0.03, 0.1], "path"),
        // poissons contre la vitre (l'eau est opaque en 3D)
        { t: "blob", c: [-0.2, 0.88, 0.205], r: [0.045, 0.022, 0.006], role: "orange" },
        { t: "blob", c: [0.15, 1.0, 0.205], r: [0.035, 0.018, 0.006], role: "yellow" },
        rod([0.3, 0.75, 0], [0.32, 1.0, 0.02], 0.01, "leaf"),
      ],
      spot: [0, 1.185, 0],
      affords: ["watch", "perch"],
    }),
  },
  birdbath: {
    label: "Bain d'oiseaux",
    for: "bird",
    main: "stone",
    trim: "water",
    build: (o) => ({ parts: [{ t: "lathe", c: [0, 0, 0], profile: [[0.18, 0], [0.16, 0.05], [0.07, 0.1], [0.06, 0.65], [0.1, 0.7], [0.3, 0.76], [0.31, 0.8], [0.27, 0.8], [0.0, 0.74]], role: o.main }, { t: "lathe", c: [0, 0.75, 0], profile: [[0.26, 0], [0, 0.01]], role: o.trim }], spot: [0.28, 0.8, 0], affords: ["drink", "bathe", "perch"] }),
  },
  hayrack: {
    label: "Râtelier à foin",
    for: "horse",
    main: "wood",
    trim: "yellow",
    build: (o) => {
      const P: PartList = [];
      for (const x of [-0.7, 0.7]) P.push(rod([x, 0, -0.2], [x, 1.5, -0.2], 0.05, o.main));
      P.push(bx([0, 1.0, -0.2], [0.72, 0.03, 0.03], o.main), bx([0, 1.45, 0.05], [0.72, 0.03, 0.03], o.main));
      for (let i = 0; i < 12; i++) P.push(rod([-0.66 + i * 0.12, 1.0, -0.2], [-0.66 + i * 0.12, 1.45, 0.05], 0.012, o.main));
      P.push({ t: "blob", c: [0, 1.25, -0.1], r: [0.62, 0.18, 0.14], role: o.trim });
      return { parts: P, spot: [0, 1.2, 0.5], affords: ["eat"] };
    },
  },
  litterbox: {
    label: "Litière",
    for: "cat",
    main: "blue",
    trim: "path",
    build: (o) => {
      const P: PartList = [bx([0, 0.01, 0], [0.25, 0.01, 0.2], o.main)];
      for (const s of [-1, 1]) P.push(bx([0, 0.07, s * 0.19], [0.25, 0.07, 0.01], o.main), bx([s * 0.24, 0.07, 0], [0.01, 0.07, 0.19], o.main));
      P.push(bx([0, 0.08, 0], [0.23, 0.015, 0.18], o.trim));
      return { parts: P, spot: [0, 0.1, 0], affords: ["use"] };
    },
  },
  saddlerack: {
    label: "Porte-selle",
    for: "horse",
    main: "wood",
    trim: "leather",
    build: (o) => ({
      parts: [
        bx([0, 0.02, 0], [0.25, 0.02, 0.3], o.main),
        rod([0, 0.04, -0.2], [0, 1.0, -0.2], 0.03, o.main),
        rod([0, 1.0, -0.25], [0, 1.0, 0.25], 0.06, o.main),
        { t: "blob", c: [0, 1.06, 0], r: [0.24, 0.07, 0.3], role: o.trim },
        bx([0, 0.88, 0], [0.26, 0.14, 0.18], o.trim),
        rod([0.25, 0.9, 0], [0.27, 0.55, 0], 0.01, o.trim),
        rod([-0.25, 0.9, 0], [-0.27, 0.55, 0], 0.01, o.trim),
      ],
      spot: [0, 0, 0.5],
      affords: ["saddle"],
    }),
  },
};

export const PET_KINDS = Object.keys(KINDS);

export type PetModel = { parts: PartList; spot: V3; affords: string[]; label: string; scale: number; for: string };

export function petModel(p: Record<string, unknown>): PetModel {
  const kind = KINDS[String(p.kind)] ? String(p.kind) : "kennel";
  const k = KINDS[kind];
  const forWhom = String(p.for ?? "auto") === "auto" ? k.for : String(p.for);
  // taille : rapport entre l'animal demandé et celui de référence de l'objet, puis échelle libre
  const s = clamp(((ANIMAL_SIZE[forWhom] ?? ANIMAL_SIZE[k.for]) / ANIMAL_SIZE[k.for]) * (clamp(Number(p.scale ?? 1) || 1, 0.2, 5)), 0.15, 5);
  const o: O = { main: roleParam(p.color, k.main), trim: roleParam(p.color2, k.trim), s };
  const b = k.build(o);
  return { parts: s === 1 ? b.parts : transformParts(b.parts, [0, 0, 0, 1], [0, 0, 0], s), spot: [b.spot[0] * s, b.spot[1] * s, b.spot[2] * s], affords: b.affords, label: k.label, scale: s, for: forWhom };
}

export const pet = defineGenerator({
  id: "pet",
  label: "Objet pour animaux",
  doc:
    "Objets pour animaux (kennel, bowl, trough, birdfeeder, birdcage, hutch, henhouse, cattree, scratchingpost, aquarium, birdbath, hayrack, litterbox, saddlerack) sur la grammaire de pièces. `for` (auto, dog, cat, horse, chicken, rabbit, bird : tailles de référence, bird ≈ petit oiseau) met l'objet à la taille de l'animal (une niche pour cheval est 2,6 fois plus grande ; échelle totale bornée à ×5 hors scène). Ancre `spot` : position de l'animal quand il mange, boit, dort ou se perche (pas celle de sa bouche) ; `approach` : où il arrive (devant l'entrée) — `target: <id>.spot` y mène ; `extra.affords` (shelter, sleep, eat, drink, perch, climb, scratch, lay…).",
  tags: ["animal", "ferme", "jardin", "maison", "écurie", "objet du quotidien"],
  schema: {
    kind: { type: "enum", default: "kennel", options: PET_KINDS, doc: "Objet" },
    for: { type: "enum", default: "auto", options: ["auto", ...Object.keys(ANIMAL_SIZE)], doc: "Animal visé (taille)" },
    scale: { type: "number", default: 1, min: 0.2, max: 5, doc: "Échelle supplémentaire" },
    color: { type: "string", default: "auto", doc: "Rôle principal" },
    color2: { type: "string", default: "auto", doc: "Rôle secondaire (toit, coussin, eau…)" },
  },
  build(p) {
    const m = petModel(p);
    const mesh = partsToMesh(m.parts, 0.85);
    const bb = partsBounds(m.parts);
    const hx = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), 0.03);
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]), 0.03);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = { top: { pos: [0, bb.max[1], 0], rot, scale: m.scale }, spot: { pos: m.spot, rot, scale: m.scale }, approach: { pos: [m.spot[0], 0, Math.max(m.spot[2], hz + 0.3 * m.scale)], rot, scale: m.scale } };
    return { generator: "pet", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: bb.max[1], extra: { affords: m.affords, label: m.label, for: m.for } };
  },
});
