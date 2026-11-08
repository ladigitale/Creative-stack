/**
 * Mobilier urbain (`street`, raccourci `street.<kind>`) : lampadaire moderne, feu tricolore, panneaux de signalisation,
 * plaque de rue, cône, barrière de chantier, arceaux à vélos, bornes de tri, cabine téléphonique, table de pique-nique,
 * fontaine à boire, horodateur, armoire électrique, corbeille, plaque d'égout… sur la grammaire de pièces (même modèle
 * en 3D et en vectoriel). Complète `prop` (lampe ancienne, borne, abribus, banc, boîte aux lettres…).
 *
 * Avant = +z (face lisible des panneaux, ouverture de la cabine) ; un `yaw` oriente l'objet vers la rue.
 */
import { type Q, type V3, clamp } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, partsBounds, partsToMesh, roleParam, transformParts } from "./parts";
import { type Anchor, defineGenerator } from "./types";

type Built = { parts: PartList; affords: string[]; light?: V3; seats?: V3[] };
type O = { main: Role; trim: Role; sign: string; state: string; n: number };

const bx = (c: V3, h: V3, role: Role, rot?: V3): Part => ({ t: "box", c, h, role, rot });
const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, r1, role });
const poly = (n: number, r: number, a0 = 0): [number, number][] => Array.from({ length: n }, (_, i) => [Math.cos(a0 + (i / n) * Math.PI * 2) * r, Math.sin(a0 + (i / n) * Math.PI * 2) * r] as [number, number]);
const rect = (hx: number, hy: number, x = 0, y = 0): [number, number][] => [[x - hx, y - hy], [x + hx, y - hy], [x + hx, y + hy], [x - hx, y + hy]];
/** Plaque face +z au centre `c`, épaisseur 2·d ; `z` décale vers l'avant (couches d'un panneau). */
const plate = (c: V3, pts: [number, number][], role: Role, z = 0, d = 0.004): Part => ({ t: "plate", c: [c[0], c[1], c[2] + z], pts, d, role });

export const SIGNS = ["stop", "yield", "noentry", "limit", "parking", "crossing", "danger", "arrow", "oneway", "deadend"] as const;

/** Face d'un panneau (couches de plaques), centrée en `c`, taille ≈ 0,6 m. */
function signFace(sign: string, c: V3): PartList {
  const P: PartList = [];
  const L = (pts: [number, number][], role: Role, layer: number) => P.push(plate(c, pts, role, layer * 0.006));
  switch (sign) {
    case "stop":
      L(poly(8, 0.32, Math.PI / 8), "white", 0), L(poly(8, 0.3, Math.PI / 8), "red", 1), L(rect(0.2, 0.045), "white", 2);
      break;
    case "yield":
      L(poly(3, 0.38, -Math.PI / 2), "red", 0), L(poly(3, 0.26, -Math.PI / 2), "white", 1);
      break;
    case "noentry":
      L(poly(24, 0.3), "red", 0), L(rect(0.2, 0.05), "white", 1);
      break;
    case "limit":
      L(poly(24, 0.3), "red", 0), L(poly(24, 0.24), "white", 1), L(rect(0.025, 0.09, -0.06), "black", 2), L(rect(0.05, 0.09, 0.06), "black", 2), L(rect(0.03, 0.065, 0.06), "white", 3);
      break;
    case "parking":
      L(rect(0.3, 0.3), "blue", 0), L(rect(0.035, 0.18, -0.06), "white", 1), L(rect(0.08, 0.075, 0.02, 0.105), "white", 1), L(rect(0.04, 0.035, 0.0, 0.105), "blue", 2);
      break;
    case "crossing":
      L(rect(0.3, 0.3), "blue", 0), L(poly(3, 0.25, Math.PI / 2).map(([x, y]) => [x, y - 0.03] as [number, number]), "white", 1), L(rect(0.025, 0.07, 0, -0.04), "black", 2), L(poly(10, 0.03).map(([x, y]) => [x, y + 0.07] as [number, number]), "black", 2);
      break;
    case "danger":
      L(poly(3, 0.38, Math.PI / 2), "red", 0), L(poly(3, 0.27, Math.PI / 2), "white", 1), L(rect(0.022, 0.07, 0, 0.02), "black", 2), L(poly(10, 0.025).map(([x, y]) => [x, y - 0.1] as [number, number]), "black", 2);
      break;
    case "arrow":
      L(poly(24, 0.3), "blue", 0), L(rect(0.035, 0.11, 0, -0.06), "white", 1), L([[-0.12, 0.04], [0.12, 0.04], [0, 0.2]], "white", 1);
      break;
    case "oneway":
      L(rect(0.18, 0.3), "blue", 0), L(rect(0.035, 0.12, 0, -0.07), "white", 1), L([[-0.11, 0.05], [0.11, 0.05], [0, 0.22]], "white", 1);
      break;
    case "deadend":
      L(rect(0.3, 0.3), "blue", 0), L(rect(0.05, 0.2, 0, -0.04), "white", 1), L(rect(0.14, 0.04, 0, 0.17), "red", 1);
      break;
  }
  return P;
}

const KINDS: Record<string, { label: string; main: Role; trim: Role; build: (o: O) => Built }> = {
  streetlight: {
    label: "Lampadaire",
    main: "metal",
    trim: "lamp",
    build: (o) => ({
      parts: [
        { t: "lathe", c: [0, 0, 0], profile: [[0.14, 0], [0.12, 0.3], [0.07, 0.4], [0.06, 5.2]], role: o.main },
        { t: "tube", pts: [[0, 5.2, 0], [0, 5.6, 0.15], [0, 5.75, 0.5], [0, 5.72, 1.0]], r: 0.05, role: o.main },
        bx([0, 5.68, 1.15], [0.14, 0.05, 0.26], o.main),
        bx([0, 5.62, 1.15], [0.11, 0.012, 0.21], o.trim),
      ],
      light: [0, 5.55, 1.15],
      affords: ["light", "lean"],
    }),
  },
  trafficlight: {
    label: "Feu tricolore",
    main: "black",
    trim: "metal",
    build: (o) => {
      const lit = (c: string, role: Role): Role => (o.state === c ? role : "ink");
      const P: PartList = [rod([0, 0, 0], [0, 2.9, 0], 0.055, o.trim), bx([0, 2.95, 0.08], [0.15, 0.42, 0.11], o.main)];
      ([[3.22, "red", "red"], [2.95, "orange", "orange"], [2.68, "green", "green"]] as [number, string, Role][]).forEach(([y, c, role]) => {
        P.push({ t: "plate", c: [0, y, 0.193], pts: poly(16, 0.09), d: 0.006, role: lit(c, role) });
        P.push({ t: "plate", c: [0, y + 0.08, 0.24], pts: [[-0.11, 0], [0.11, 0], [0.09, 0.012], [-0.09, 0.012]], d: 0.05, role: o.main });
      });
      return { parts: P, affords: ["signal"] };
    },
  },
  roadsign: {
    label: "Panneau de signalisation",
    main: "metal",
    trim: "metal",
    build: (o) => ({ parts: [rod([0, 0, -0.03], [0, 2.3, -0.03], 0.03, o.main), ...signFace(o.sign, [0, 2.3, 0])], affords: ["read"] }),
  },
  streetsign: {
    label: "Plaque de rue",
    main: "metal",
    trim: "blue",
    build: (o) => ({
      parts: [rod([0, 0, -0.03], [0, 2.6, -0.03], 0.03, o.main), plate([0, 2.45, 0], rect(0.36, 0.11), "white"), plate([0, 2.45, 0.006], rect(0.34, 0.09), o.trim), plate([0, 2.45, 0.012], rect(0.25, 0.012), "white")],
      affords: ["read"],
    }),
  },
  trafficcone: {
    label: "Cône de chantier",
    main: "orange",
    trim: "white",
    build: (o) => ({
      parts: [bx([0, 0.015, 0], [0.18, 0.015, 0.18], o.main), { t: "lathe", c: [0, 0.03, 0], profile: [[0.14, 0], [0.11, 0.2], [0.09, 0.3], [0.06, 0.45], [0.025, 0.5], [0, 0.5]], role: o.main }, { t: "lathe", c: [0, 0.25, 0], profile: [[0.106, 0], [0.093, 0.1]], role: o.trim }],
      affords: ["carry", "block"],
    }),
  },
  barrier: {
    label: "Barrière de chantier",
    main: "red",
    trim: "white",
    build: (o) => {
      const P: PartList = [];
      for (let i = 0; i < 6; i++) P.push(bx([-0.625 + i * 0.25, 0.85, 0], [0.125, 0.09, 0.012], i % 2 ? o.trim : o.main));
      for (const x of [-0.7, 0.7]) P.push(rod([x, 0, 0.25], [x, 0.95, 0], 0.022, "metal"), rod([x, 0, -0.25], [x, 0.95, 0], 0.022, "metal"));
      return { parts: P, affords: ["block"] };
    },
  },
  bikerack: {
    label: "Arceaux à vélos",
    main: "metal",
    trim: "metal",
    build: (o) => ({
      parts: Array.from({ length: o.n }, (_, i) => {
        const x = (i - (o.n - 1) / 2) * 0.7;
        return { t: "tube", pts: [[x, 0, -0.3], [x, 0.7, -0.3], [x, 0.82, -0.2], [x, 0.85, 0], [x, 0.82, 0.2], [x, 0.7, 0.3], [x, 0, 0.3]], r: 0.03, role: o.main } as Part;
      }),
      affords: ["lock"],
    }),
  },
  recycling: {
    label: "Bornes de tri",
    main: "green",
    trim: "black",
    build: (o) => {
      const P: PartList = [];
      (["green", "yellow", "blue"] as Role[]).forEach((role, i) => {
        const x = (i - 1) * 0.95;
        P.push(bx([x, 0.75, 0], [0.42, 0.75, 0.42], i === 0 ? o.main : role), bx([x, 1.52, 0], [0.44, 0.03, 0.44], i === 0 ? o.main : role), { t: "plate", c: [x, 1.15, 0.425], pts: poly(14, 0.1), d: 0.004, role: o.trim });
      });
      return { parts: P, affords: ["throw"] };
    },
  },
  phonebooth: {
    label: "Cabine téléphonique",
    main: "red",
    trim: "glass",
    build: (o) => {
      const P: PartList = [bx([0, 0.04, 0], [0.5, 0.04, 0.5], o.main), bx([0, 2.35, 0], [0.52, 0.08, 0.52], o.main), bx([0, 2.48, 0], [0.42, 0.05, 0.42], o.main)];
      for (const x of [-0.47, 0.47]) for (const z of [-0.47, 0.47]) P.push(bx([x, 1.2, z], [0.035, 1.12, 0.035], o.main));
      P.push(bx([0, 1.25, -0.48], [0.44, 0.9, 0.01], o.trim), bx([0.48, 1.25, 0], [0.01, 0.9, 0.44], o.trim), bx([-0.48, 1.25, 0], [0.01, 0.9, 0.44], o.trim));
      P.push(bx([0, 1.3, -0.44], [0.14, 0.2, 0.05], "black"), bx([0, 2.27, 0.53], [0.3, 0.05, 0.01], "white"));
      return { parts: P, affords: ["enter", "call"] };
    },
  },
  picnictable: {
    label: "Table de pique-nique",
    main: "wood",
    trim: "wood",
    build: (o) => {
      const P: PartList = [];
      for (let i = 0; i < 4; i++) P.push(bx([0, 0.74, -0.27 + i * 0.18], [0.9, 0.018, 0.08], o.main));
      for (const z of [-0.62, 0.62]) for (let i = 0; i < 2; i++) P.push(bx([0, 0.44, z + (i - 0.5) * 0.15], [0.9, 0.016, 0.07], o.main));
      for (const x of [-0.65, 0.65]) {
        P.push(bx([x, 0.42, 0], [0.03, 0.03, 0.75], o.trim));
        for (const s of [-1, 1]) P.push({ t: "box", c: [x, 0.36, s * 0.22], h: [0.03, 0.4, 0.035], role: o.trim, rot: [s * 28, 0, 0] });
      }
      const seats: V3[] = [-0.45, 0.45].flatMap((x) => [[x, 0.46, 0.62], [x, 0.46, -0.62]] as V3[]);
      return { parts: P, affords: ["sit", "eat"], seats };
    },
  },
  drinkingfountain: {
    label: "Fontaine à boire",
    main: "metal",
    trim: "metal",
    build: (o) => ({
      parts: [{ t: "lathe", c: [0, 0, 0], profile: [[0.16, 0], [0.12, 0.05], [0.09, 0.15], [0.08, 0.85], [0.1, 0.9], [0.2, 0.92], [0.21, 0.97], [0.16, 0.98], [0, 0.95]], role: o.main }, rod([0, 0.98, -0.1], [0, 1.1, -0.04], 0.015, o.trim)],
      affords: ["drink"],
    }),
  },
  parkingmeter: {
    label: "Horodateur",
    main: "metal",
    trim: "blue",
    build: (o) => ({ parts: [bx([0, 0.7, 0], [0.18, 0.7, 0.13], o.main), bx([0, 1.25, 0.132], [0.12, 0.12, 0.004], "glass"), bx([0, 1.48, 0], [0.2, 0.06, 0.15], o.trim), bx([0, 0.9, 0.132], [0.05, 0.02, 0.006], "black")], affords: ["pay"] }),
  },
  electricbox: {
    label: "Armoire électrique",
    main: "stone",
    trim: "black",
    build: (o) => ({ parts: [bx([0, 0.65, 0], [0.5, 0.65, 0.18], o.main), bx([0, 1.32, 0], [0.53, 0.03, 0.21], o.main), bx([-0.25, 0.7, 0.182], [0.23, 0.5, 0.004], o.main), bx([0.25, 0.7, 0.182], [0.23, 0.5, 0.004], o.main), bx([0.02, 0.75, 0.19], [0.01, 0.05, 0.008], o.trim), plate([0.25, 1.05, 0.19], poly(3, 0.06, Math.PI / 2), "yellow")], affords: [] }),
  },
  litterbin: {
    label: "Corbeille sur poteau",
    main: "green",
    trim: "metal",
    build: (o) => ({ parts: [rod([0, 0, -0.22], [0, 1.05, -0.22], 0.03, o.trim), { t: "lathe", c: [0, 0.45, 0], profile: [[0.17, 0], [0.2, 0.5], [0.21, 0.52], [0.0, 0.03]], role: o.main }, { t: "lathe", c: [0, 0.94, 0], profile: [[0.2, 0], [0.21, 0.03]], role: "white" }], affords: ["throw"] }),
  },
  manhole: {
    label: "Plaque d'égout",
    main: "metal",
    trim: "ink",
    build: (o) => ({ parts: [{ t: "lathe", c: [0, 0, 0], profile: [[0.36, 0], [0.36, 0.012], [0.33, 0.016], [0, 0.016]], role: o.trim }, { t: "lathe", c: [0, 0.004, 0], profile: [[0.32, 0], [0.32, 0.014], [0, 0.016]], role: o.main }], affords: ["open"] }),
  },
  hydrantpost: {
    label: "Poteau d'incendie",
    main: "red",
    trim: "metal",
    build: (o) => ({ parts: [{ t: "lathe", c: [0, 0, 0], profile: [[0.14, 0], [0.13, 0.05], [0.1, 0.08], [0.1, 0.8], [0.12, 0.84], [0.12, 0.9], [0.06, 1.0], [0, 1.02]], role: o.main }, rod([0.08, 0.6, 0], [0.18, 0.6, 0], 0.04, o.trim), rod([-0.08, 0.6, 0], [-0.18, 0.6, 0], 0.04, o.trim), rod([0, 0.55, 0.08], [0, 0.55, 0.19], 0.05, o.trim)], affords: [] }),
  },
};

export const STREET_KINDS = Object.keys(KINDS);

export type StreetModel = { parts: PartList; affords: string[]; light?: V3; seats?: V3[]; label: string; scale: number };

export function streetModel(p: Record<string, unknown>): StreetModel {
  const kind = KINDS[String(p.kind)] ? String(p.kind) : "streetlight";
  const k = KINDS[kind];
  const o: O = {
    main: roleParam(p.color, k.main),
    trim: roleParam(p.color2, k.trim),
    sign: (SIGNS as readonly string[]).includes(String(p.sign)) ? String(p.sign) : "stop",
    state: String(p.state ?? "red"),
    n: clamp(Math.round(Number(p.count ?? 3)) || 3, 1, 8),
  };
  const b = k.build(o);
  const s = clamp(Number(p.scale ?? 1) || 1, 0.2, 5);
  const S = (v: V3): V3 => [v[0] * s, v[1] * s, v[2] * s];
  return { parts: s === 1 ? b.parts : transformParts(b.parts, [0, 0, 0, 1], [0, 0, 0], s), affords: b.affords, light: b.light && S(b.light), seats: b.seats?.map(S), label: k.label, scale: s };
}

export const street = defineGenerator({
  id: "street",
  label: "Mobilier urbain",
  doc:
    "Mobilier urbain à taille réelle (streetlight, trafficlight, roadsign, streetsign, trafficcone, barrier, bikerack, recycling, phonebooth, picnictable, drinkingfountain, parkingmeter, electricbox, litterbin, manhole, hydrantpost), face lisible vers +z. `sign` choisit le panneau (stop, yield, noentry, limit, parking, crossing, danger, arrow, oneway, deadend), `state` la couleur du feu (red, orange, green, off), `count` le nombre d'arceaux. Le lampadaire éclaire la nuit (ancre light) ; la table de pique-nique a 4 places (sit.N). Complète prop (lamp, bollard, busstop, bench, mailbox…).",
  tags: ["rue", "ville", "signalisation", "chantier", "parc", "objet du quotidien"],
  schema: {
    kind: { type: "enum", default: "streetlight", options: STREET_KINDS, doc: "Objet" },
    sign: { type: "enum", default: "stop", options: SIGNS, doc: "Panneau (roadsign)" },
    state: { type: "enum", default: "red", options: ["red", "orange", "green", "off"], doc: "Feu allumé (trafficlight)" },
    count: { type: "int", default: 3, min: 1, max: 8, doc: "Arceaux (bikerack)" },
    scale: { type: "number", default: 1, min: 0.2, max: 5, doc: "Échelle (1 = taille réelle)" },
    color: { type: "string", default: "auto", doc: "Rôle principal" },
    color2: { type: "string", default: "auto", doc: "Rôle secondaire" },
  },
  build(p) {
    const m = streetModel(p);
    const mesh = partsToMesh(m.parts, 0.85);
    const bb = partsBounds(m.parts);
    const hx = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), 0.05);
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]), 0.05);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = { top: { pos: [0, bb.max[1], 0], rot, scale: m.scale } };
    if (m.light) anchors.light = { pos: m.light, rot, scale: m.scale };
    m.seats?.forEach((q, i) => {
      // assis face à la table : le banc avant (z > 0) regarde vers −z
      anchors[`sit.${i}`] = { pos: q, rot: q[2] > 0 ? [0, 1, 0, 0] : rot, scale: m.scale };
      anchors[`approach.${i}`] = { pos: [q[0], 0, q[2] + Math.sign(q[2]) * 0.45 * m.scale], rot, scale: m.scale };
    });
    return { generator: "street", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: bb.max[1], extra: { affords: m.affords, label: m.label } };
  },
});
