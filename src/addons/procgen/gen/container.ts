/**
 * Contenants (`container`, raccourci `container.<kind>`) : caisse, coffre, carton, panier, seau, sac, jarre, amphore,
 * marmite, jerrican, caisse à outils, valise, palette, poubelle à roulettes, bidon à lait, glacière, sac de courses…
 * sur la grammaire de pièces (même modèle en 3D et en vectoriel). Ouverts ou fermés, remplis (`fill` : fruits, sable,
 * terre, eau, lait, bûches, outils, foin, fleurs, pièces d'or…).
 */
import { type Q, type V3, DEG, clamp, qAxis } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, partsBounds, partsToMesh, roleParam, transformParts } from "./parts";
import { toolParts } from "./tool";
import { type Anchor, defineGenerator } from "./types";

export const FILLS = ["none", "apples", "oranges", "potatoes", "sand", "soil", "grain", "water", "milk", "logs", "tools", "hay", "flowers", "gold"] as const;

/** Ouverture d'un contenant : ronde (rayon) ou rectangulaire (demi-côtés), à la hauteur `y`. */
type Opening = { y: number; r?: number; hx?: number; hz?: number };
/**
 * `parts` : corps ; `lid` : couvercle (dessiné avant le corps s'il est ouvert, donc derrière, après sinon) ; `grip` :
 * prise réelle (anse) ; `sit` : on peut s'asseoir dessus quand il est fermé ; `fills` : contenus permis.
 */
type Built = { parts: PartList; lid?: PartList; opening: Opening | null; affords: string[]; grip?: V3; sit?: boolean; fills?: readonly string[] };
type O = { main: Role; trim: Role; open: boolean };

const bx = (c: V3, h: V3, role: Role, rot?: V3): Part => ({ t: "box", c, h, role, rot });
/** Anneau (cerclage, rebord) : tube fermé horizontal. */
const ring = (r: number, y: number, w: number, role: Role): Part => ({ t: "tube", pts: Array.from({ length: 17 }, (_, i) => [Math.cos((i / 16) * Math.PI * 2) * r, y, Math.sin((i / 16) * Math.PI * 2) * r] as V3), r: w, role });
/** Pièces tournées autour d'une charnière horizontale (axe x) passant par `(y, z)`. */
const hinge = (parts: PartList, deg: number, y: number, z: number): PartList => transformParts(transformParts(parts, [0, 0, 0, 1], [0, -y, -z]), qAxis([1, 0, 0], deg * DEG), [0, y, z]);
const SOLIDS = ["none", "apples", "oranges", "potatoes", "logs", "tools", "flowers", "gold"] as const;
const LOOSE = ["none", "sand", "soil", "grain", "hay", "apples", "oranges", "potatoes", "gold"] as const;
const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, r1, role });
const arcPts = (r: number, y: number, a0: number, a1: number, n = 8, axis: "x" | "z" = "x"): V3[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return axis === "x" ? ([Math.cos(a) * r, y + Math.sin(a) * r, 0] as V3) : ([0, y + Math.sin(a) * r, Math.cos(a) * r] as V3);
  });

/** Boîte ouverte : fond et quatre parois d'épaisseur `t`. */
function openBox(P: PartList, hx: number, hy: number, hz: number, t: number, role: Role) {
  P.push(bx([0, t / 2, 0], [hx, t / 2, hz], role));
  P.push(bx([0, hy, hz - t / 2], [hx, hy, t / 2], role), bx([0, hy, -hz + t / 2], [hx, hy, t / 2], role));
  P.push(bx([hx - t / 2, hy, 0], [t / 2, hy, hz - t], role), bx([-hx + t / 2, hy, 0], [t / 2, hy, hz - t], role));
}

const KINDS: Record<string, { label: string; build: (o: O) => Built }> = {
  crate: {
    label: "Caisse en bois",
    build: (o) => {
      const P: PartList = [];
      const h = 0.2;
      openBox(P, 0.3, h, 0.22, 0.02, o.main);
      for (const y of [0.08, 0.32]) for (const sz of [-1, 1]) P.push(bx([0, y, sz * 0.225], [0.31, 0.035, 0.008], o.trim));
      const lid = o.open ? [] : [bx([0, 0.41, 0], [0.31, 0.012, 0.23], o.main)];
      return { parts: P, lid, opening: o.open ? { y: 0.38, hx: 0.27, hz: 0.19 } : null, affords: ["carry", "open", "fill", "sit", "stack"], sit: true };
    },
  },
  chest: {
    label: "Coffre",
    build: (o) => {
      const P: PartList = [];
      openBox(P, 0.38, 0.17, 0.24, 0.025, o.main);
      for (const x of [-0.3, 0.3]) P.push(bx([x, 0.17, 0], [0.02, 0.172, 0.245], o.trim));
      P.push(bx([0, 0.26, 0.246], [0.035, 0.04, 0.008], o.trim));
      // couvercle bombé : charnière à l'arrière (z = −0,24, y = 0,34)
      const lid: PartList = [bx([0, 0.04, 0.24], [0.385, 0.04, 0.245], o.main), { t: "blob", c: [0, 0.07, 0.24], r: [0.385, 0.07, 0.24], role: o.main }, bx([0.3, 0.06, 0.24], [0.02, 0.06, 0.25], o.trim), bx([-0.3, 0.06, 0.24], [0.02, 0.06, 0.25], o.trim)];
      const q: Q = o.open ? qAxis([1, 0, 0], -105 * DEG) : [0, 0, 0, 1];
      return { parts: P, lid: transformParts(lid, q, [0, 0.34, -0.24]), opening: o.open ? { y: 0.32, hx: 0.34, hz: 0.2 } : null, affords: ["open", "fill", "sit", "push"], sit: true };
    },
  },
  cardboard: {
    label: "Carton",
    build: (o) => {
      const P: PartList = [];
      openBox(P, 0.22, 0.17, 0.17, 0.006, o.main);
      const lid: PartList = [];
      if (o.open) {
        // rabats articulés sur l'arête du bord, ouverts vers l'extérieur et relevés de 35°
        const up = 35 * DEG;
        lid.push(...transformParts([bx([0, 0, 0.085], [0.22, 0.003, 0.085], o.main)], qAxis([1, 0, 0], -up), [0, 0.34, 0.17]));
        lid.push(...transformParts([bx([0, 0, -0.085], [0.22, 0.003, 0.085], o.main)], qAxis([1, 0, 0], up), [0, 0.34, -0.17]));
        lid.push(...transformParts([bx([0.085, 0, 0], [0.085, 0.003, 0.17], o.main)], qAxis([0, 0, 1], up), [0.22, 0.34, 0]));
        lid.push(...transformParts([bx([-0.085, 0, 0], [0.085, 0.003, 0.17], o.main)], qAxis([0, 0, 1], -up), [-0.22, 0.34, 0]));
      } else lid.push(bx([0, 0.343, 0], [0.222, 0.004, 0.172], o.main), bx([0, 0.348, 0], [0.04, 0.002, 0.173], o.trim));
      return { parts: P, lid, opening: o.open ? { y: 0.32, hx: 0.2, hz: 0.15 } : null, affords: ["carry", "open", "fill", "stack"], fills: SOLIDS };
    },
  },
  basket: {
    label: "Panier",
    build: (o) => ({
      parts: [
        { t: "lathe", c: [0, 0, 0], profile: [[0.13, 0], [0.16, 0.02], [0.2, 0.15], [0.21, 0.17], [0.19, 0.17], [0.18, 0.16], [0.0, 0.02]], role: o.main },
        { t: "tube", pts: arcPts(0.19, 0.17, 0.05, Math.PI - 0.05, 10), r: 0.012, role: o.main },
        ring(0.205, 0.165, 0.009, o.trim),
      ],
      opening: { y: 0.15, r: 0.17 },
      affords: ["carry", "fill", "hold"],
      grip: [0, 0.36, 0],
      fills: SOLIDS,
    }),
  },
  bucket: {
    label: "Seau",
    build: (o) => ({
      parts: [
        { t: "lathe", c: [0, 0, 0], profile: [[0.1, 0], [0.11, 0.005], [0.14, 0.27], [0.148, 0.28], [0.137, 0.28], [0.128, 0.26], [0.0, 0.01]], role: o.main },
        { t: "tube", pts: arcPts(0.145, 0.25, 0.1, Math.PI - 0.1, 10), r: 0.004, role: "metal" },
      ],
      opening: { y: 0.24, r: 0.13 },
      affords: ["carry", "fill", "pour", "hold"],
      grip: [0, 0.39, 0],
    }),
  },
  sack: {
    label: "Sac de jute",
    build: (o) => ({
      parts: o.open
        ? [{ t: "lathe", c: [0, 0, 0], profile: [[0.15, 0], [0.2, 0.06], [0.21, 0.25], [0.19, 0.4], [0.21, 0.44], [0.17, 0.45], [0.15, 0.4], [0.0, 0.3]], role: o.main }]
        : [{ t: "blob", c: [0, 0.24, 0], r: [0.21, 0.24, 0.17], role: o.main }, { t: "blob", c: [0, 0.5, 0], r: [0.06, 0.06, 0.05], role: o.main }, rod([-0.055, 0.465, 0], [0.055, 0.465, 0], 0.012, o.trim)],
      opening: o.open ? { y: 0.4, r: 0.16 } : null,
      affords: o.open ? ["carry", "fill"] : ["carry", "fill", "sit"],
      sit: !o.open,
      fills: LOOSE,
    }),
  },
  jar: {
    label: "Jarre",
    build: (o) => ({
      parts: [{ t: "lathe", c: [0, 0, 0], profile: [[0.12, 0], [0.2, 0.12], [0.24, 0.3], [0.2, 0.52], [0.12, 0.6], [0.13, 0.64], [0.1, 0.65], [0.09, 0.6], [0, 0.5]], role: o.main }, ring(0.236, 0.4, 0.008, o.trim)],
      opening: { y: 0.6, r: 0.08 },
      affords: ["fill", "pour"],
      fills: ["none", "water", "milk", "grain", "flowers", "gold"],
    }),
  },
  amphora: {
    label: "Amphore",
    build: (o) => ({
      parts: [
        { t: "lathe", c: [0, 0, 0], profile: [[0.0, 0], [0.03, 0.02], [0.12, 0.2], [0.17, 0.42], [0.15, 0.56], [0.07, 0.66], [0.06, 0.8], [0.08, 0.82], [0.055, 0.83], [0.045, 0.78], [0, 0.7]], role: o.main },
        { t: "tube", pts: [[0.065, 0.76, 0], [0.16, 0.72, 0], [0.15, 0.6, 0], [0.12, 0.55, 0]], r: 0.016, role: o.main },
        { t: "tube", pts: [[-0.065, 0.76, 0], [-0.16, 0.72, 0], [-0.15, 0.6, 0], [-0.12, 0.55, 0]], r: 0.016, role: o.main },
      ],
      opening: { y: 0.8, r: 0.045 },
      affords: ["fill", "pour", "carry"],
      fills: ["none", "water", "milk", "grain", "flowers"],
    }),
  },
  pot: {
    label: "Marmite",
    build: (o) => ({
      parts: [
        { t: "lathe", c: [0, 0, 0], profile: [[0.16, 0], [0.19, 0.02], [0.2, 0.18], [0.205, 0.2], [0.19, 0.2], [0.18, 0.19], [0, 0.02]], role: o.main },
        rod([0.2, 0.16, 0], [0.26, 0.16, 0], 0.012, o.trim),
        rod([-0.2, 0.16, 0], [-0.26, 0.16, 0], 0.012, o.trim),
      ],
      lid: o.open ? [] : [{ t: "lathe", c: [0, 0.2, 0], profile: [[0.2, 0], [0.16, 0.04], [0.03, 0.05], [0.03, 0.08], [0, 0.08]], role: o.main }],
      opening: o.open ? { y: 0.17, r: 0.18 } : null,
      affords: ["fill", "cook", "carry"],
    }),
  },
  jerrycan: {
    label: "Jerrican",
    build: (o) => ({
      parts: [bx([0, 0.22, 0], [0.17, 0.22, 0.08], o.main), { t: "tube", pts: [[-0.12, 0.44, 0], [-0.1, 0.5, 0], [0.04, 0.5, 0], [0.06, 0.44, 0]], r: 0.014, role: o.main }, rod([0.12, 0.43, 0], [0.15, 0.5, 0], 0.022, o.trim)],
      opening: null,
      affords: ["carry", "pour"],
    }),
  },
  toolbox: {
    label: "Caisse à outils",
    build: (o) => {
      const P: PartList = [];
      openBox(P, 0.24, 0.08, 0.11, 0.01, o.main);
      // couvercle articulé à l'arête arrière (y 0,16, z −0,11)
      const lid0: PartList = [bx([0, 0.175, 0], [0.24, 0.015, 0.11], o.main), { t: "tube", pts: [[-0.08, 0.19, 0], [-0.07, 0.24, 0], [0.07, 0.24, 0], [0.08, 0.19, 0]], r: 0.01, role: o.trim }];
      const lid = o.open ? hinge(lid0, -110, 0.16, -0.11) : lid0;
      return { parts: P, lid, opening: o.open ? { y: 0.15, hx: 0.22, hz: 0.09 } : null, affords: ["carry", "open", "fill"], grip: [0, 0.24, 0], fills: ["none", "tools", "gold"] };
    },
  },
  suitcase: {
    label: "Valise",
    build: (o) => ({
      parts: [bx([0, 0.3, 0], [0.24, 0.3, 0.1], o.main), bx([0, 0.3, 0], [0.245, 0.29, 0.102], o.trim), { t: "tube", pts: [[-0.06, 0.6, 0], [-0.05, 0.65, 0], [0.05, 0.65, 0], [0.06, 0.6, 0]], r: 0.012, role: "black" }, ...[-0.2, 0.2].map((x) => rod([x, 0.0, -0.06], [x, 0.03, -0.06], 0.02, "black"))],
      opening: null,
      affords: ["carry", "pull", "open"],
    }),
  },
  bag: {
    label: "Sac de courses",
    build: (o) => ({
      parts: [...(() => { const B: PartList = []; openBox(B, 0.16, 0.17, 0.08, 0.004, o.main); return B; })(), { t: "tube", pts: [[-0.08, 0.33, 0], [-0.05, 0.43, 0], [0.05, 0.43, 0], [0.08, 0.33, 0]], r: 0.006, role: o.trim }],
      opening: { y: 0.3, hx: 0.14, hz: 0.06 },
      affords: ["carry", "fill", "hold"],
      grip: [0, 0.43, 0],
      fills: SOLIDS,
    }),
  },
  pallet: {
    label: "Palette",
    build: (o) => {
      const P: PartList = [];
      for (let i = 0; i < 7; i++) P.push(bx([-0.54 + i * 0.18, 0.135, 0], [0.05, 0.011, 0.4], o.main));
      for (const z of [-0.36, 0, 0.36]) {
        P.push(bx([0, 0.1, z], [0.6, 0.011, 0.05], o.main));
        for (const x of [-0.52, 0, 0.52]) P.push(bx([x, 0.045, z], [0.05, 0.045, 0.05], o.trim));
      }
      for (const x of [-0.48, 0, 0.48]) P.push(bx([x, 0.011, 0], [0.05, 0.011, 0.4], o.main));
      return { parts: P, opening: { y: 0.15, hx: 0.55, hz: 0.38 }, affords: ["stack", "carry", "sit"], sit: true, fills: ["none", "logs"] };
    },
  },
  wheeliebin: {
    label: "Poubelle à roulettes",
    build: (o) => ({
      parts: [
        ...(() => { const B: PartList = []; openBox(B, 0.28, 0.47, 0.3, 0.02, o.main); return B; })(),
        rod([-0.3, 0.1, -0.3], [0.3, 0.1, -0.3], 0.1, "black"),
        rod([-0.24, 0.92, -0.33], [0.24, 0.92, -0.33], 0.02, o.trim),
      ],
      // couvercle articulé sur l'arête arrière (y 0,94, z −0,3)
      lid: hinge([bx([0, 0.955, 0.02], [0.3, 0.02, 0.33], o.trim)], o.open ? -105 : 0, 0.94, -0.31),
      opening: o.open ? { y: 0.88, hx: 0.25, hz: 0.27 } : null,
      affords: ["push", "pull", "open", "fill"],
      grip: [0, 0.92, -0.33],
    }),
  },
  milkcan: {
    label: "Bidon à lait",
    build: (o) => ({
      parts: [{ t: "lathe", c: [0, 0, 0], profile: [[0.17, 0], [0.18, 0.02], [0.18, 0.4], [0.12, 0.5], [0.1, 0.58], [0.12, 0.6], [0.1, 0.62], [0.09, 0.56], [0, 0.45]], role: o.main }, ...[-1, 1].map((s) => ({ t: "tube", pts: [[s * 0.13, 0.48, 0], [s * 0.2, 0.5, 0], [s * 0.2, 0.44, 0], [s * 0.16, 0.42, 0]], r: 0.01, role: o.main }) as Part), ring(0.183, 0.21, 0.008, o.trim)],
      lid: o.open ? [] : [{ t: "lathe", c: [0, 0.6, 0], profile: [[0.11, 0], [0.11, 0.04], [0.04, 0.06], [0.04, 0.09], [0, 0.09]], role: o.main }],
      opening: o.open ? { y: 0.56, r: 0.08 } : null,
      fills: ["none", "milk", "water"],
      affords: ["carry", "fill", "pour"],
    }),
  },
  cooler: {
    label: "Glacière",
    build: (o) => {
      const P: PartList = [];
      openBox(P, 0.27, 0.15, 0.17, 0.025, o.main);
      P.push({ t: "tube", pts: [[-0.29, 0.22, 0], [-0.31, 0.38, 0], [0.31, 0.38, 0], [0.29, 0.22, 0]], r: 0.01, role: o.trim });
      const lid = hinge([bx([0, 0.32, 0], [0.28, 0.025, 0.18], o.trim)], o.open ? -100 : 0, 0.3, -0.18);
      return { parts: P, lid, opening: o.open ? { y: 0.27, hx: 0.24, hz: 0.14 } : null, affords: ["carry", "open", "fill", "sit"], grip: [0, 0.38, 0], sit: true };
    },
  },
};

export const CONTAINER_KINDS = Object.keys(KINDS);

const DEFAULT_ROLES: Record<string, [Role, Role]> = {
  crate: ["wood", "wood"], chest: ["wood", "metal"], cardboard: ["path", "paper"], basket: ["path", "wood"], bucket: ["metal", "metal"],
  sack: ["path", "leather"], jar: ["roof", "trim"], amphora: ["roof", "roof"], pot: ["black", "black"], jerrycan: ["red", "black"],
  toolbox: ["red", "black"], suitcase: ["leather", "leather"], bag: ["paper", "paper"], pallet: ["wood", "wood"], wheeliebin: ["green", "green"],
  milkcan: ["metal", "metal"], cooler: ["blue", "white"],
};

/* ---------- contenu ---------- */

/** Hachage déterministe 0..1 (placement des fruits, des bûches). */
const h01 = (i: number, k: number) => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Pièces du contenu posé dans l'ouverture. */
export function fillParts(fill: string, op: Opening): PartList {
  const P: PartList = [];
  const round = op.r !== undefined;
  const ax = round ? op.r! : op.hx!, az = round ? op.r! : op.hz!;
  const inside = (x: number, z: number) => (round ? Math.hypot(x, z) <= op.r! : Math.abs(x) <= op.hx! && Math.abs(z) <= op.hz!);
  const surface = (role: Role, dome: number) => {
    if (round) P.push({ t: "lathe", c: [0, op.y - 0.04, 0], profile: [[ax * 0.98, 0], [ax * 0.98, 0.03], [ax * 0.7, 0.03 + dome * 0.6], [0, 0.03 + dome]], role });
    else P.push({ t: "blob", c: [0, op.y - 0.01, 0], r: [ax * 0.98, 0.02 + dome, az * 0.98], role }, { t: "box", c: [0, op.y - 0.03, 0], h: [ax * 0.98, 0.02, az * 0.98], role });
  };
  /** Fruits, pièces : grille centrée sur l'ouverture, pas élargi pour tenir dans le plafond `cap`. */
  const balls = (role: Role, r: number, cap = 40, coin = false) => {
    const area = round ? Math.PI * ax * ax : 4 * ax * az;
    const step = Math.max(r * 2.05, Math.sqrt(area / cap));
    const nx = Math.max(1, Math.floor((2 * ax - 2 * r) / step) + 1), nz = Math.max(1, Math.floor((2 * az - 2 * r) / step) + 1);
    let n = 0;
    for (let i = 0; i < nx; i++)
      for (let k = 0; k < nz; k++) {
        const x = (i - (nx - 1) / 2) * step, z = (k - (nz - 1) / 2) * step;
        if (!inside(x, z) || n >= cap) continue;
        const j = n++;
        const c: V3 = [x + (h01(j, 1) - 0.5) * r * 0.4, op.y + r * (coin ? 0.2 : 0.3 + h01(j, 2) * 0.5), z + (h01(j, 3) - 0.5) * r * 0.4];
        if (coin) P.push({ t: "rod", a: c, b: [c[0], c[1] + r * 0.25, c[2]], r, role });
        else P.push({ t: "blob", c, r: [r, r * 0.95, r], role });
      }
  };
  switch (fill) {
    case "apples": balls("red", 0.038); break;
    case "oranges": balls("orange", 0.04); break;
    case "potatoes": balls("leather", 0.035); break;
    case "sand": surface("path", 0.05); break;
    case "soil": surface("ground", 0.04); break;
    case "grain": surface("yellow", 0.05); break;
    case "hay": surface("yellow", 0.09); break;
    case "water": surface("water", 0); break;
    case "milk": surface("white", 0); break;
    case "gold": surface("yellow", 0.03); balls("yellow", 0.022, 24, true); break;
    case "flowers": {
      let n = 0;
      for (let i = 0; i < 9; i++) {
        const x = (h01(i, 5) - 0.5) * ax * 1.4, z = (h01(i, 6) - 0.5) * az * 1.4;
        if (!inside(x, z)) continue;
        const top: V3 = [x * 1.4, op.y + 0.16 + h01(i, 7) * 0.08, z * 1.4];
        P.push({ t: "rod", a: [x, op.y - 0.05, z], b: top, r: 0.004, role: "leaf" }, { t: "blob", c: top, r: [0.03, 0.02, 0.03], role: n++ % 2 ? "flower" : "yellow" });
      }
      surface("ground", 0.02);
      break;
    }
    case "logs": {
      const r = 0.045;
      const len = Math.max(ax, az) * 2 * 0.95;
      const alongX = ax >= az;
      const span = alongX ? az : ax;
      for (let row = 0; row < 2; row++)
        for (let s = -span + r; s <= span - r + 1e-6; s += r * 2.1) {
          const y = op.y + r + row * r * 1.8;
          // ouverture ronde : bûche à la longueur de la corde
          const half = round ? Math.sqrt(Math.max(0, op.r! * op.r! - s * s)) * 0.95 : len / 2;
          if (half < r * 2) continue;
          const a: V3 = alongX ? [-half, y, s] : [s, y, -half], b: V3 = alongX ? [half, y, s] : [s, y, half];
          P.push({ t: "rod", a, b, r, role: "bark" });
        }
      break;
    }
    case "tools": {
      // outils couchés à plat, manche selon x, réduits si l'ouverture est petite
      const kinds = ["hammer", "screwdriver", "wrench", "saw"] as const;
      for (const [i, k] of kinds.entries()) {
        const { parts } = toolParts(k);
        const len = partsBounds(parts).max[1];
        const sc = Math.min(1, (ax * 1.8) / len);
        const flat = transformParts(parts, qAxis([0, 0, 1], -Math.PI / 2 + (h01(i, 9) - 0.5) * 0.3), [0, 0, 0], sc);
        const b = partsBounds(flat);
        const z = -az * 0.7 + (i * az * 1.4) / (kinds.length - 1);
        P.push(...transformParts(flat, [0, 0, 0, 1], [-(b.min[0] + b.max[0]) / 2, op.y - 0.04 - b.min[1] + i * 0.012, z]));
      }
      break;
    }
  }
  return P;
}

export type ContainerModel = {
  /** Corps, couvercle, contenu (déjà à l'échelle). */
  body: PartList;
  lid: PartList;
  fill: PartList;
  /** Couvercle ouvert : derrière le corps (dessiné avant lui). */
  lidBehind: boolean;
  affords: string[];
  label: string;
  opening: Opening | null;
  grip?: V3;
  sit: boolean;
  scale: number;
  /** Contenu refusé (non permis pour ce contenant). */
  rejected?: string;
};

export function containerModel(p: Record<string, unknown>): ContainerModel {
  const kind = KINDS[String(p.kind)] ? String(p.kind) : "crate";
  const d = DEFAULT_ROLES[kind];
  const o: O = { main: roleParam(p.color, d[0]), trim: roleParam(p.color2, d[1]), open: p.open === undefined ? true : Boolean(p.open) };
  const b = KINDS[kind].build(o);
  let fill = String(p.fill ?? "none");
  let rejected: string | undefined;
  if (b.fills && !b.fills.includes(fill)) {
    rejected = fill;
    fill = "none";
  }
  const s = clamp(Number(p.scale ?? 1) || 1, 0.2, 5);
  const sc = (l: PartList) => (s === 1 ? l : transformParts(l, [0, 0, 0, 1], [0, 0, 0], s));
  const fillP = b.opening && fill !== "none" ? fillParts(fill, b.opening) : [];
  const S = (v?: V3): V3 | undefined => v && [v[0] * s, v[1] * s, v[2] * s];
  return { body: sc(b.parts), lid: sc(b.lid ?? []), fill: sc(fillP), lidBehind: o.open, affords: b.affords, label: KINDS[kind].label, opening: b.opening, grip: S(b.grip), sit: !!b.sit && fill === "none" && (!o.open || kind === "pallet"), scale: s, rejected };
}

/** Toutes les pièces (corps, couvercle, contenu). */
export const containerParts = (m: ContainerModel): PartList => [...m.body, ...m.lid, ...m.fill];

export const container = defineGenerator({
  id: "container",
  label: "Contenant : caisse, panier, seau, sac…",
  doc:
    "Contenants à taille réelle (crate, chest, cardboard, basket, bucket, sack, jar, amphora, pot, jerrycan, toolbox, suitcase, bag, pallet, wheeliebin, milkcan, cooler) sur la grammaire de pièces. `open` ouvre le couvercle (coffre, caisse, caisse à outils, poubelle, glacière, carton, marmite, bidon, sac ; sans effet sur panier, seau, jarre…), `fill` le remplit — contenus permis selon le contenant, sinon laissé vide avec une issue — (apples, oranges, potatoes, sand, soil, grain, water, milk, logs, tools, hay, flowers, gold). `color`/`color2` = rôles du corps et des ferrures. Ancres top, grip (anse), inside, sit.0 (fermé, ou palette vide) ; `extra.affords` (carry, open, fill, pour, sit, stack, push…).",
  tags: ["contenant", "rangement", "marché", "ferme", "cuisine", "objet du quotidien"],
  schema: {
    kind: { type: "enum", default: "crate", options: CONTAINER_KINDS, doc: "Contenant" },
    open: { type: "bool", default: true, doc: "Ouvert (couvercle levé, sac ouvert)" },
    fill: { type: "enum", default: "none", options: FILLS, doc: "Contenu" },
    scale: { type: "number", default: 1, min: 0.2, max: 5, doc: "Échelle (1 = taille réelle)" },
    color: { type: "string", default: "auto", doc: "Rôle du corps" },
    color2: { type: "string", default: "auto", doc: "Rôle des ferrures, anses, couvercle" },
  },
  build(p, ctx) {
    const m = containerModel(p);
    if (m.rejected) ctx.issues.add({ path: `${ctx.path}.fill`, code: "type", message: `contenu « ${m.rejected} » impossible dans ce contenant : laissé vide` });
    // le contenu (nombreux petits morceaux) en détail réduit
    const mesh = partsToMesh([...m.body, ...m.lid], 0.85).append(partsToMesh(m.fill, 0.45));
    const bb = partsBounds([...m.body, ...m.lid, ...m.fill]);
    // emprise et ancres sur le corps fermé : ni le couvercle levé ni le contenu
    const body = partsBounds(m.body);
    const hx = Math.max(Math.abs(body.min[0]), Math.abs(body.max[0]), 0.02);
    const hz = Math.max(Math.abs(body.min[2]), Math.abs(body.max[2]), 0.02);
    const rot: Q = [0, 0, 0, 1];
    const topY = m.lidBehind ? body.max[1] : partsBounds([...m.body, ...m.lid]).max[1];
    const anchors: Record<string, Anchor> = { top: { pos: [0, topY, 0], rot, scale: m.scale }, grip: { pos: m.grip ?? [0, topY, 0], rot, scale: m.scale } };
    if (m.opening) anchors.inside = { pos: [0, m.opening.y * m.scale, 0], rot, scale: m.scale };
    if (m.sit) {
      anchors["sit.0"] = { pos: [0, topY, 0], rot, scale: m.scale };
      anchors["approach.0"] = { pos: [0, 0, hz + 0.35], rot, scale: m.scale };
    }
    return { generator: "container", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: bb.max[1], extra: { affords: m.affords, label: m.label, fill: m.rejected ? "none" : p.fill } };
  },
});
