/**
 * Véhicules modernes et ferroviaires sur la grammaire de pièces (même modèle en 3D et en vectoriel) : voiture,
 * fourgonnette, bus, camion, tracteur, wagon, locomotive. Avant = +z, roues au sol en y = 0 (ou sur le rail avec
 * `onRails` : relevés de la hauteur du rail de `structure.rails`).
 */
import type { V3 } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, transformParts } from "./parts";
import { disc } from "./structure";

export const PART_VEHICLES = ["moderncar", "van", "bus", "truck", "tractor", "wagon", "locomotive"] as const;
/** Hauteur du dessus du rail de `structure.rails` (m). */
export const RAIL_TOP = 0.29;

const bx = (c: V3, h: V3, role: Role, rot?: V3, r?: number): Part => ({ t: "box", c, h, role, rot, r });
const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, r1, role });
/** Profil latéral convexe [z, y] extrudé sur la largeur (±hw). */
const side = (pts: [number, number][], hw: number, role: Role, x = 0): Part => ({ t: "plate", c: [x, 0, 0], pts: pts.map(([z, y]) => [-z, y] as [number, number]), d: hw, rot: [0, 90, 0], role });
/** Plaque face avant (+z) ou arrière (−z) : rectangle de demi-côtés hx, hy. */
const face = (c: V3, hx: number, hy: number, role: Role): Part => ({ t: "plate", c, pts: [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]], d: 0.008, role });

/** Décor plaqué sur les deux flancs (x = ±x) : rectangle z0…z1, y0…y1 (chaque flanc a son propre ordre de dessin). */
function band(P: PartList, x: number, z0: number, z1: number, y0: number, y1: number, role: Role) {
  for (const sx of [-1, 1]) P.push(side([[z0, y0], [z1, y0], [z1, y1], [z0, y1]], 0.004, role, sx * x));
}

/** Roue : pneu, jante, moyeu (disques d'axe x). */
function wheel(P: PartList, x: number, z: number, r: number, w: number, rim: Role = "metal") {
  const s = Math.sign(x) || 1;
  P.push(disc([x, r, z], r, w / 2, "ink", 18), disc([x + s * (w / 2 + 0.004), r, z], r * 0.58, 0.006, rim, 14), disc([x + s * (w / 2 + 0.012), r, z], r * 0.18, 0.006, "ink", 8));
}

function lights(P: PartList, hw: number, y: number, zf: number, zb: number, r = 0.09) {
  for (const sx of [-1, 1]) {
    P.push({ t: "plate", c: [sx * (hw - 0.22), y, zf + 0.01], pts: Array.from({ length: 10 }, (_, i) => [Math.cos((i / 10) * Math.PI * 2) * r * 1.3, Math.sin((i / 10) * Math.PI * 2) * r * 0.8] as [number, number]), d: 0.012, role: "lamp" });
    P.push(face([sx * (hw - 0.16), y, zb - 0.01], 0.1, 0.06, "red"));
  }
}

function moderncar(paint: Role, v: number): PartList {
  const P: PartList = [];
  const hw = 0.88;
  // caisse basse, habitacle vitré, toit, montants, pare-chocs, rétroviseurs
  P.push(side([[-2.05, 0.28], [2.0, 0.28], [2.08, 0.55], [1.95, 0.82], [0.9, 0.9], [-1.8, 0.92], [-2.08, 0.75]], hw, paint));
  const cab: [number, number][] = v % 2 ? [[-1.75, 0.9], [0.85, 0.9], [0.15, 1.38], [-1.45, 1.4]] : [[-1.55, 0.9], [0.85, 0.9], [0.2, 1.4], [-1.25, 1.42]];
  P.push(side(cab, hw - 0.06, "glass"));
  P.push(side([[cab[3][0] - 0.02, cab[3][1] - 0.02], [cab[2][0] + 0.02, cab[2][1] - 0.02], [cab[2][0] - 0.05, cab[2][1] + 0.04], [cab[3][0] + 0.05, cab[3][1] + 0.05]], hw - 0.04, paint));
  for (const sx of [-1, 1]) {
    const x = sx * (hw - 0.05);
    P.push(rod([x, 0.9, cab[1][0] - 0.02], [x, cab[2][1], cab[2][0]], 0.04, paint), rod([x, 0.9, -0.35], [x, 1.4, -0.4], 0.05, paint), rod([x, 0.9, cab[0][0] + 0.05], [x, cab[3][1], cab[3][0]], 0.06, paint));
    P.push(bx([sx * (hw + 0.08), 1.0, 0.75], [0.07, 0.05, 0.04], paint));

  }
  P.push(bx([0, 0.36, 2.04], [hw - 0.02, 0.1, 0.06], "ink", undefined, 0.04), bx([0, 0.36, -2.07], [hw - 0.02, 0.1, 0.05], "ink", undefined, 0.04));
  P.push(face([0, 0.62, 2.09], 0.38, 0.07, "ink"));
  band(P, hw + 0.004, -0.95, 0.85, 0.61, 0.63, "ink");
  lights(P, hw, 0.68, 2.03, -2.08);
  for (const z of [-1.3, 1.3]) for (const sx of [-1, 1]) wheel(P, sx * (hw - 0.04), z, 0.33, 0.22);
  return P;
}

function van(paint: Role, v: number): PartList {
  const P: PartList = [];
  const hw = 0.98;
  P.push(side([[-2.4, 0.32], [2.3, 0.32], [2.4, 0.7], [2.25, 1.05], [1.4, 1.3], [-2.4, 1.3]], hw, paint));
  P.push(side([[-2.4, 1.28], [1.4, 1.28], [0.85, 2.0], [-2.4, 2.02]], hw, paint));
  // pare-brise, vitres de cabine, bandeau de vitres latérales (variante)
  P.push(side([[0.75, 1.32], [1.38, 1.32], [0.86, 1.95], [0.55, 1.95]], hw + 0.005, "glass"));
  if (v % 2) P.push(side([[-1.9, 1.45], [0.2, 1.45], [0.2, 1.85], [-1.9, 1.85]], hw + 0.005, "glass"));
  P.push({ t: "plate", c: [0, 1.62, 1.14], pts: [[-hw + 0.08, -0.3], [hw - 0.08, -0.3], [hw - 0.08, 0.3], [-hw + 0.08, 0.3]], d: 0.01, rot: [-50, 0, 0], role: "glass" });
  for (const sx of [-1, 1]) P.push(bx([sx * (hw + 0.002), 0.8, -0.6], [0.004, 0.45, 0.01], "ink"), bx([sx * (hw + 0.1), 1.35, 1.3], [0.08, 0.08, 0.04], "ink"));
  P.push(bx([0, 0.38, 2.38], [hw - 0.02, 0.1, 0.06], "ink", undefined, 0.04), bx([0, 0.38, -2.42], [hw - 0.02, 0.1, 0.05], "ink", undefined, 0.04));
  lights(P, hw, 0.8, 2.36, -2.42);
  for (const z of [-1.55, 1.5]) for (const sx of [-1, 1]) wheel(P, sx * (hw - 0.06), z, 0.35, 0.24);
  return P;
}

function bus(paint: Role, v: number): PartList {
  const P: PartList = [];
  const hw = 1.25, L = 5.4;
  P.push(bx([0, 1.75, 0], [hw, 1.35, L], paint, undefined, 0.06));
  // bandeau vitré, pare-brise, girouette, portes, toit
  band(P, hw + 0.006, -L + 0.4, L - 0.8, 1.57, 2.53, "glass");
  for (let k = 0; k < 8; k++) band(P, hw + 0.012, -L + 0.85 + k * 1.25, -L + 0.95 + k * 1.25, 1.55, 2.55, paint);
  P.push(face([0, 2.0, L + 0.005], hw - 0.1, 0.62, "glass"), face([0, 2.85, L + 0.012], hw - 0.3, 0.12, "lamp"));
  P.push(bx([hw + 0.008, 1.35, L - 1.0], [0.006, 0.95, 0.5], "glass"), bx([hw + 0.008, 1.35, 0.1], [0.006, 0.95, 0.5], "glass"));
  P.push(bx([0, 3.12, -0.6], [hw - 0.3, 0.06, 1.5], v % 2 ? "white" : "metal"));
  band(P, hw + 0.006, -L, L, 0.55, 0.69, v % 2 ? "white" : "ink");
  lights(P, hw, 0.75, L, -L);
  for (const z of [-L + 1.4, L - 1.6]) for (const sx of [-1, 1]) wheel(P, sx * (hw - 0.08), z, 0.5, 0.3);
  return P;
}

function truck(paint: Role, v: number): PartList {
  const P: PartList = [];
  const hw = 1.2;
  // cabine avancée, châssis, caisse fermée (variante 0) ou plateau à ridelles
  P.push(bx([0, 1.75, 2.9], [hw, 1.0, 0.85], paint, undefined, 0.06));
  P.push(face([0, 2.15, 3.755], hw - 0.12, 0.42, "glass"), face([0, 1.1, 3.76], hw - 0.3, 0.18, "ink"));
  for (const sx of [-1, 1]) P.push(bx([sx * (hw + 0.006), 2.15, 3.1], [0.005, 0.38, 0.4], "glass"), bx([sx * (hw + 0.12), 2.1, 3.6], [0.03, 0.22, 0.06], "ink"));
  P.push(bx([0, 0.85, -0.5], [0.6, 0.12, 4.0], "ink"));
  if (v % 2 === 0) {
    P.push(bx([0, 2.1, -1.1], [hw + 0.05, 1.15, 2.85], v % 4 === 0 ? "white" : "paper", undefined, 0.03));
    P.push(face([0, 2.1, -3.96], hw, 1.1, "metal"), bx([0, 2.1, -3.97], [0.01, 1.05, 0.01], "ink"));
  } else {
    P.push(bx([0, 1.08, -1.1], [hw + 0.05, 0.08, 2.85], "wood"));
    for (const sx of [-1, 1]) P.push(bx([sx * (hw + 0.05), 1.42, -1.1], [0.04, 0.3, 2.85], paint));
    P.push(bx([0, 1.42, -3.93], [hw + 0.05, 0.3, 0.04], paint));
    for (let k = 0; k < 3; k++) P.push({ t: "blob", c: [-0.4 + k * 0.4, 1.45, -1.6 + k * 0.9], r: [0.45, 0.32, 0.6], role: k % 2 ? "path" : "ground" });
  }
  lights(P, hw, 0.95, 3.75, -3.97);
  for (const z of [-2.9, -1.8, 2.75]) for (const sx of [-1, 1]) wheel(P, sx * (hw - 0.12), z, 0.52, 0.32);
  return P;
}

function tractor(paint: Role): PartList {
  const P: PartList = [];
  // capot étroit, calandre, cabine à arceaux et toit, grandes roues arrière, échappement
  P.push(bx([0, 1.15, 0.85], [0.45, 0.42, 1.05], paint, undefined, 0.05));
  P.push(face([0, 1.15, 1.905], 0.36, 0.34, "ink"));
  for (let k = 0; k < 5; k++) P.push(bx([0, 0.92 + k * 0.11, 1.912], [0.34, 0.012, 0.005], "metal"));
  P.push(bx([0, 0.95, -0.55], [0.55, 0.35, 0.55], paint, undefined, 0.04));
  P.push(bx([0, 1.35, -0.75], [0.25, 0.06, 0.25], "ink"), bx([0, 1.65, -1.0], [0.25, 0.25, 0.04], "ink"));
  for (const sx of [-1, 1]) {
    P.push(rod([sx * 0.62, 1.3, 0.05], [sx * 0.62, 2.55, 0.05], 0.04, "ink"), rod([sx * 0.62, 1.3, -1.1], [sx * 0.62, 2.55, -1.1], 0.04, "ink"));
    P.push(bx([sx * 0.62, 1.95, -0.52], [0.008, 0.6, 0.55], "glass"));
    // garde-boue arrière
    P.push({ t: "tube", pts: [[sx * 0.98, 0.85, -1.6], [sx * 0.98, 1.6, -1.1], [sx * 0.98, 1.65, -0.45], [sx * 0.98, 1.2, 0.05]], r: 0.06, role: paint });
  }
  P.push(bx([0, 2.6, -0.52], [0.72, 0.06, 0.72], paint));
  P.push(face([0, 1.95, 0.06], 0.6, 0.6, "glass"));
  P.push(rod([0.3, 1.5, 1.4], [0.3, 2.5, 1.4], 0.05, "metal"), rod([0.3, 2.5, 1.4], [0.3, 2.62, 1.35], 0.06, "ink"));
  for (const sx of [-1, 1]) {
    wheel(P, sx * 0.85, -0.85, 0.78, 0.45, "yellow");
    wheel(P, sx * 0.62, 1.35, 0.45, 0.28, "yellow");
    P.push(bx([sx * 0.62, 1.28, 1.95], [0.06, 0.06, 0.03], "lamp"));
  }
  return P;
}

function wagon(paint: Role, v: number): PartList {
  const P: PartList = [];
  const hw = 1.45, L = 5.6;
  const y0 = 1.1;
  if (v % 2 === 0) {
    // voiture de voyageurs : caisse, rangée de fenêtres, toit bombé, soufflets
    P.push(bx([0, y0 + 1.2, 0], [hw, 1.2, L], paint, undefined, 0.05));
    band(P, hw + 0.006, -L + 0.6, L - 0.6, y0 + 1.13, y0 + 1.97, "glass");
    for (let k = 0; k <= 8; k++) {
      const z = -L + 0.6 + (k * (2 * L - 1.2)) / 8;
      band(P, hw + 0.012, z - 0.12, z + 0.12, y0 + 1.1, y0 + 2.0, paint);
    }
    P.push(side([[-L, y0 + 2.38], [L, y0 + 2.38], [L - 0.2, y0 + 2.62], [-L + 0.2, y0 + 2.62]], hw - 0.05, "metal"));
    band(P, hw + 0.006, -L, L, y0 + 0.56, y0 + 0.68, v % 4 === 0 ? "yellow" : "white");
    for (const e of [-1, 1]) P.push(bx([0, y0 + 1.1, e * (L + 0.18)], [0.9, 1.0, 0.18], "ink"));
  } else {
    // wagon de marchandises : caisse à planches, portes coulissantes, toit
    P.push(bx([0, y0 + 1.3, 0], [hw, 1.3, L], paint, undefined, 0.03));
    for (let k = 0; k < 14; k++) band(P, hw + 0.006, -L + 0.38 + k * 0.83, -L + 0.42 + k * 0.83, y0 + 0.05, y0 + 2.55, "ink");
    for (const sx of [-1, 1]) P.push(bx([sx * (hw + 0.02), y0 + 1.25, 0], [0.012, 1.1, 0.9], paint), bx([sx * (hw + 0.035), y0 + 1.25, 0], [0.006, 1.05, 0.02], "ink"));
    P.push(bx([0, y0 + 2.65, 0], [hw + 0.05, 0.06, L + 0.05], "metal"));
  }
  // châssis, tampons, bogies à deux essieux
  P.push(bx([0, y0 - 0.05, 0], [hw - 0.2, 0.1, L + 0.1], "ink"));
  for (const e of [-1, 1]) for (const sx of [-1, 1]) P.push(rod([sx * 0.8, y0 - 0.1, e * (L + 0.1)], [sx * 0.8, y0 - 0.1, e * (L + 0.45)], 0.06, "metal"), disc([sx * 0.8, y0 - 0.1, e * (L + 0.46)], 0.17, 0.02, "metal"));
  for (const zc of [-L + 1.4, L - 1.4]) {
    P.push(bx([0, 0.6, zc], [0.95, 0.12, 1.25], "ink"));
    for (const dz of [-0.85, 0.85]) for (const sx of [-1, 1]) wheel(P, sx * 0.72, zc + dz, 0.46, 0.14, "ink");
  }
  return P;
}

function locomotive(paint: Role): PartList {
  const P: PartList = [];
  const L = 5;
  // locomotive à vapeur : chaudière, cheminée, dôme, cabine, abri, chasse-pierres, roues motrices et bielle
  P.push(rod([0, 2.0, -0.8], [0, 2.0, L - 0.4], 0.78, "ink"));
  for (const z of [0.3, 1.6, 2.9, 4.2]) P.push(rod([0, 2.0, z - 0.04], [0, 2.0, z + 0.04], 0.8, "metal"));
  P.push(disc([0, 2.0, L - 0.36], 0.79, 0.03, "ink", 20));
  P.push({ t: "plate", c: [0, 2.0, L - 0.33], pts: Array.from({ length: 16 }, (_, i) => [Math.cos((i / 16) * Math.PI * 2) * 0.5, Math.sin((i / 16) * Math.PI * 2) * 0.5] as [number, number]), d: 0.02, role: "metal" });
  P.push({ t: "lathe", c: [0, 2.6, L - 1.0], profile: [[0.24, 0], [0.2, 0.5], [0.34, 0.85], [0.34, 0.95], [0.2, 0.95]], role: "ink" });
  P.push({ t: "lathe", c: [0, 2.65, 1.9], profile: [[0.32, 0], [0.3, 0.25], [0.18, 0.42], [0, 0.45]], role: paint });
  P.push(bx([0, 2.3, -1.6], [1.25, 1.2, 0.9], paint, undefined, 0.04), bx([0, 3.55, -1.6], [1.4, 0.07, 1.05], "ink"));
  for (const sx of [-1, 1]) P.push(bx([sx * 1.26, 2.7, -1.6], [0.006, 0.4, 0.45], "glass"));
  P.push(bx([0, 1.08, 1.4], [1.25, 0.1, L - 1.0], "ink"));
  P.push({ t: "plate", c: [0, 0.55, L + 0.15], pts: [[-1.1, 0.45], [1.1, 0.45], [0.5, -0.35], [-0.5, -0.35]], d: 0.25, rot: [-25, 0, 0], role: "red" });
  P.push({ t: "plate", c: [0, 2.9, L - 0.3], pts: Array.from({ length: 10 }, (_, i) => [Math.cos((i / 10) * Math.PI * 2) * 0.16, Math.sin((i / 10) * Math.PI * 2) * 0.16] as [number, number]), d: 0.06, role: "lamp" });
  for (const sx of [-1, 1]) {
    for (const z of [-0.6, 0.95, 2.5]) wheel(P, sx * 0.85, z, 0.72, 0.14, "red");
    wheel(P, sx * 0.8, 4.0, 0.42, 0.14, "red");
    P.push(rod([sx * 1.01, 0.72, -0.6], [sx * 1.01, 0.72, 2.5], 0.035, "metal"));
    P.push(rod([sx * 0.95, 1.05, 3.8], [sx * 0.95, 1.05, 4.6], 0.22, "ink"));
  }
  return P;
}

export function vehicleParts(kind: string, paint: Role, variant: number): PartList {
  switch (kind) {
    case "moderncar":
      return moderncar(paint, variant);
    case "van":
      return van(paint, variant);
    case "bus":
      return bus(paint, variant);
    case "truck":
      return truck(paint, variant);
    case "tractor":
      return tractor(paint);
    case "wagon":
      return wagon(paint, variant);
    case "locomotive":
      return locomotive(paint);
  }
  return [];
}

/** Rôle de caisse automatique des véhicules modernes : couleurs franches selon la variante. */
export const MODERN_PAINTS: Role[] = ["red", "blue", "white", "yellow", "green", "black", "accent", "cloth2"];

/** Pièces d'un véhicule à pièces, caisse et relevage résolus (lu par le générateur et par le dessin vectoriel). */
export function vehiclePartsModel(p: Record<string, unknown>): PartList {
  const kind = String(p.kind);
  const variant = Math.max(0, Math.round(Number(p.variant ?? 0)) || 0);
  const paintName = String(p.paint ?? "auto");
  const auto = kind === "tractor" ? (["green", "red", "blue", "yellow"] as Role[])[variant % 4] : kind === "locomotive" ? (["accent", "green", "red", "blue"] as Role[])[variant % 4] : MODERN_PAINTS[variant % MODERN_PAINTS.length];
  const paint = paintName === "auto" ? auto : (paintName as Role);
  const parts = vehicleParts(kind, paint, variant);
  const lift = p.onRails && (kind === "wagon" || kind === "locomotive") ? RAIL_TOP : 0;
  const s = Math.max(0.5, Math.min(3, Number(p.size ?? 1) || 1));
  return lift || s !== 1 ? transformParts(parts, [0, 0, 0, 1], [0, lift, 0], s) : parts;
}
