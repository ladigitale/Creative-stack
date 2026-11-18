/**
 * Véhicules modernes et ferroviaires sur la grammaire de pièces (même modèle en 3D et en vectoriel) : voiture,
 * fourgonnette, bus, camion, tracteur, wagon, locomotive. Avant = +z, roues au sol en y = 0 (ou sur le rail avec
 * `onRails` : relevés de la hauteur du rail de `structure.rails`).
 */
import type { V3 } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, transformParts } from "./parts";
import { disc } from "./structure";
import { type JointSpec, hingeJoint, scaleJoint, slideJoint } from "./joints";

/**
 * Véhicule en construction : corps, parties mobiles (portières `door.fl` = côté conducteur, à gauche, x > 0 ;
 * `door.fr`, `door.rl`, `door.rr`, `trunk`, `hood`, `door.side`, `door.back.l|r`, `tailgate`), essieux `wheel.N`
 * (roues séparables, `openable: false`) et places (`seat.driver`, `seat.N`, `approach.door.*`).
 */
type VB = { P: PartList; J: JointSpec[]; anchors: Record<string, V3>; axle: number };
const vb = (): VB => ({ P: [], J: [], anchors: {}, axle: 0 });

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

/**
 * Essieu (deux roues symétriques) : partie `wheel.N` qui tourne autour de l'axe x (un tour = 0…1), jamais « ouverte ».
 * Essieu directeur (`steer`) : chaque roue est une partie à part, `wheel.N.l` / `wheel.N.r`, enfant de `steer.fl` /
 * `steer.fr` (rotation autour de y au centre de la roue, ±35°, 0,5 = tout droit) : la roue braque et tourne à la fois.
 */
function axle(B: VB, x: number, z: number, r: number, w: number, rim: Role = "metal", steer = false) {
  const n = B.axle++;
  const label = n === 0 ? "roues avant" : `roues (essieu ${n + 1})`;
  if (steer) {
    for (const sx of [1, -1]) {
      const s = sx > 0 ? "l" : "r";
      const parts: PartList = [];
      wheel(parts, sx * x, z, r, w, rim);
      const side_ = sx > 0 ? "gauche" : "droite";
      B.J.push({ name: `steer.f${s}`, label: `direction avant ${side_}`, kind: "rotation", pivot: [sx * x, r, z], axis: [0, 1, 0], range: [-35, 35], parts: [], initial: 0.5, openable: false });
      B.J.push(hingeJoint(`wheel.${n}.${s}`, `${label} (${side_})`, parts, [sx * x, r, z], [1, 0, 0], 360, { openable: false, parent: `steer.f${s}` }));
    }
    return;
  }
  const parts: PartList = [];
  for (const sx of [-1, 1]) wheel(parts, sx * x, z, r, w, rim);
  B.J.push(hingeJoint(`wheel.${n}`, label, parts, [0, r, z], [1, 0, 0], 360, { openable: false }));
}

/**
 * Portière latérale : panneau, vitre, poignée, articulée au bord avant (axe vertical) et ouverte vers l'extérieur
 * (70°) ; un panneau sombre sur la caisse, caché portière fermée, figure l'ouverture.
 */
function sideDoor(B: VB, name: string, label: string, sx: number, hw: number, z0: number, z1: number, y0: number, y1: number, paint: Role, win?: [number, number][]) {
  const x = sx * (hw + 0.012);
  const parts: PartList = [side([[z0, y0], [z1, y0], [z1, y1], [z0, y1]], 0.006, paint, x)];
  if (win) parts.push(side(win, 0.004, "glass", sx * (hw + 0.011)));
  const handle: V3 = [sx * (hw + 0.024), y1 - 0.1, z0 + 0.12];
  parts.push(bx(handle, [0.006, 0.012, 0.05], "ink"));
  B.P.push(side([[z0 + 0.015, y0 + 0.015], [z1 - 0.015, y0 + 0.015], [z1 - 0.015, y1], [z0 + 0.015, y1]], 0.002, "ink", sx * (hw + 0.004)));
  B.J.push(hingeJoint(name, label, parts, [x, 0, z1], [0, 1, 0], sx > 0 ? -70 : 70, { anchors: { handle } }));
  B.anchors[`approach.${name}`] = [sx * (hw + 0.7), 0, (z0 + z1) / 2 - 0.2];
}

/** Portes arrière à deux battants (face −z), articulées sur les côtés, ouvertes à 100°. */
function backDoors(B: VB, hw: number, zb: number, y0: number, y1: number, role: Role, glass = false) {
  const yc = (y0 + y1) / 2, hy = (y1 - y0) / 2;
  B.P.push(face([0, yc, zb + 0.006], hw - 0.04, hy - 0.02, "ink"));
  for (const sx of [1, -1]) {
    const parts: PartList = [face([sx * (hw / 2), yc, zb - 0.004], hw / 2 - 0.012, hy, role)];
    if (glass) parts.push(face([sx * (hw / 2), y1 - 0.32, zb - 0.014], hw / 2 - 0.12, 0.18, "glass"));
    parts.push(bx([sx * 0.06, yc, zb - 0.02], [0.012, 0.06, 0.008], "ink"));
    B.J.push(hingeJoint(sx > 0 ? "door.back.l" : "door.back.r", sx > 0 ? "porte arrière gauche" : "porte arrière droite", parts, [sx * hw, 0, zb - 0.004], [0, 1, 0], sx > 0 ? -100 : 100));
  }
  B.anchors["approach.door.back"] = [0, 0, zb - 0.9];
}

function lights(P: PartList, hw: number, y: number, zf: number, zb: number, r = 0.09) {
  for (const sx of [-1, 1]) {
    P.push({ t: "plate", c: [sx * (hw - 0.22), y, zf + 0.01], pts: Array.from({ length: 10 }, (_, i) => [Math.cos((i / 10) * Math.PI * 2) * r * 1.3, Math.sin((i / 10) * Math.PI * 2) * r * 0.8] as [number, number]), d: 0.012, role: "lamp" });
    P.push(face([sx * (hw - 0.16), y, zb - 0.01], 0.1, 0.06, "red"));
  }
}

function moderncar(B: VB, paint: Role, v: number) {
  const P = B.P;
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
  // portières (gauche = côté conducteur, x > 0), coffre (hayon), capot
  for (const sx of [1, -1]) {
    const s = sx > 0 ? "l" : "r", side_ = sx > 0 ? "gauche" : "droite";
    sideDoor(B, `door.f${s}`, `portière avant ${side_}${sx > 0 ? " (conducteur)" : ""}`, sx, hw, -0.33, 0.85, 0.34, 0.9, paint, [[-0.33, 0.92], [0.8, 0.92], [0.22, 1.33], [-0.33, 1.36]]);
    sideDoor(B, `door.r${s}`, `portière arrière ${side_}`, sx, hw, -0.95, -0.37, 0.34, 0.9, paint, [[-0.95, 0.92], [-0.37, 0.92], [-0.37, 1.36], [-0.95, 1.38]]);
  }
  const cr = cab[0][0];
  B.J.push(hingeJoint("trunk", "coffre", [bx([0, 0.93, (cr - 1.95) / 2], [hw - 0.1, 0.012, (cr + 1.95) / 2], paint), bx([0, 0.8, -2.05], [hw - 0.14, 0.09, 0.012], paint, [-35, 0, 0])], [0, 0.94, cr], [1, 0, 0], 70, { anchors: { handle: [0, 0.75, -2.08] } }));
  B.J.push(hingeJoint("hood", "capot", [bx([0, 0.88, 1.42], [hw - 0.1, 0.012, 0.5], paint, [4.5, 0, 0])], [0, 0.9, 0.9], [1, 0, 0], -55));
  B.anchors["approach.trunk"] = [0, 0, -2.8];
  band(P, hw + 0.004, -0.95, 0.85, 0.61, 0.63, "ink");
  lights(P, hw, 0.68, 2.03, -2.08);
  [1.3, -1.3].forEach((z, i) => axle(B, hw - 0.04, z, 0.33, 0.22, "metal", i === 0));
  Object.assign(B.anchors, { "seat.driver": [0.38, 0.6, 0.0], "seat.0": [-0.38, 0.6, 0.0], "seat.1": [0.38, 0.6, -0.8], "seat.2": [-0.38, 0.6, -0.8] });
}

function van(B: VB, paint: Role, v: number) {
  const P = B.P;
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
  // portières de cabine, porte latérale coulissante (côté droit, x < 0), portes arrière à deux battants
  for (const sx of [1, -1]) sideDoor(B, sx > 0 ? "door.fl" : "door.fr", sx > 0 ? "portière gauche (conducteur)" : "portière droite", sx, hw, 0.45, 1.12, 0.45, 1.3, paint, [[0.5, 1.32], [1.12, 1.32], [0.86, 1.93], [0.5, 1.93]]);
  const slide: PartList = [side([[-0.9, 0.45], [0.35, 0.45], [0.35, 1.9], [-0.9, 1.9]], 0.006, paint, -(hw + 0.02)), bx([-(hw + 0.032), 1.1, 0.22], [0.006, 0.015, 0.06], "ink")];
  if (v % 2) slide.push(side([[-0.85, 1.45], [0.3, 1.45], [0.3, 1.85], [-0.85, 1.85]], 0.004, "glass", -(hw + 0.028)));
  P.push(side([[-0.88, 0.47], [0.33, 0.47], [0.33, 1.88], [-0.88, 1.88]], 0.002, "ink", -(hw + 0.006)));
  B.J.push(slideJoint("door.side", "porte latérale coulissante", slide, [0, 0, -1], 1.0, { anchors: { handle: [-(hw + 0.032), 1.1, 0.22] } }));
  B.anchors["approach.door.side"] = [-(hw + 0.8), 0, -0.3];
  backDoors(B, hw, -2.4, 0.5, 1.98, paint, true);
  [1.5, -1.55].forEach((z, i) => axle(B, hw - 0.06, z, 0.35, 0.24, "metal", i === 0));
  Object.assign(B.anchors, { "seat.driver": [0.45, 0.9, 0.85], "seat.0": [-0.45, 0.9, 0.85] });
}

function bus(B: VB, paint: Role, v: number) {
  const P = B.P;
  const hw = 1.25, L = 5.4;
  P.push(bx([0, 1.75, 0], [hw, 1.35, L], paint, undefined, 0.06));
  // bandeau vitré, pare-brise, girouette, portes, toit
  band(P, hw + 0.006, -L + 0.4, L - 0.8, 1.57, 2.53, "glass");
  for (let k = 0; k < 8; k++) band(P, hw + 0.012, -L + 0.85 + k * 1.25, -L + 0.95 + k * 1.25, 1.55, 2.55, paint);
  P.push(face([0, 2.0, L + 0.005], hw - 0.1, 0.62, "glass"), face([0, 2.85, L + 0.012], hw - 0.3, 0.12, "lamp"));
  // portes vitrées côté trottoir (droite, x < 0), coulissantes vers l'arrière le long de la caisse
  for (const [i, zc] of [L - 1.0, 0.1].entries()) {
    P.push(bx([-(hw + 0.004), 1.35, zc], [0.003, 0.93, 0.48], "ink"));
    B.J.push(slideJoint(`door.${i}`, i === 0 ? "porte avant" : "porte du milieu", [bx([-(hw + 0.012), 1.35, zc], [0.006, 0.95, 0.5], "glass"), bx([-(hw + 0.016), 1.35, zc], [0.004, 0.95, 0.02], "metal")], [0, 0, -1], 0.98));
    B.anchors[`approach.door.${i}`] = [-(hw + 0.8), 0, zc];
  }
  P.push(bx([0, 3.12, -0.6], [hw - 0.3, 0.06, 1.5], v % 2 ? "white" : "metal"));
  band(P, hw + 0.006, -L, L, 0.55, 0.69, v % 2 ? "white" : "ink");
  lights(P, hw, 0.75, L, -L);
  [L - 1.6, -L + 1.4].forEach((z, i) => axle(B, hw - 0.08, z, 0.5, 0.3, "metal", i === 0));
  B.anchors["seat.driver"] = [0.7, 1.25, L - 0.9];
  [-2.5, -0.8, 1.2, 2.8].forEach((z, i) => (B.anchors[`seat.${i}`] = [i % 2 ? -0.6 : 0.6, 1.25, z]));
}

function truck(B: VB, paint: Role, v: number) {
  const P = B.P;
  const hw = 1.2;
  // cabine avancée, châssis, caisse fermée (variante 0) ou plateau à ridelles
  P.push(bx([0, 1.75, 2.9], [hw, 1.0, 0.85], paint, undefined, 0.06));
  P.push(face([0, 2.15, 3.755], hw - 0.12, 0.42, "glass"), face([0, 1.1, 3.76], hw - 0.3, 0.18, "ink"));
  for (const sx of [-1, 1]) P.push(bx([sx * (hw + 0.12), 2.1, 3.6], [0.03, 0.22, 0.06], "ink"));
  for (const sx of [1, -1]) sideDoor(B, sx > 0 ? "door.fl" : "door.fr", sx > 0 ? "portière gauche (conducteur)" : "portière droite", sx, hw, 2.45, 3.55, 1.1, 2.6, paint, [[2.7, 1.78], [3.5, 1.78], [3.5, 2.52], [2.7, 2.52]]);
  P.push(bx([0, 0.85, -0.5], [0.6, 0.12, 4.0], "ink"));
  if (v % 2 === 0) {
    P.push(bx([0, 2.1, -1.1], [hw + 0.05, 1.15, 2.85], v % 4 === 0 ? "white" : "paper", undefined, 0.03));
    backDoors(B, hw, -3.96, 1.0, 3.2, "metal");
  } else {
    P.push(bx([0, 1.08, -1.1], [hw + 0.05, 0.08, 2.85], "wood"));
    for (const sx of [-1, 1]) P.push(bx([sx * (hw + 0.05), 1.42, -1.1], [0.04, 0.3, 2.85], paint));
    B.J.push(hingeJoint("tailgate", "ridelle arrière", [bx([0, 1.42, -3.93], [hw + 0.05, 0.3, 0.04], paint)], [0, 1.12, -3.93], [1, 0, 0], -90));
    B.anchors["approach.tailgate"] = [0, 0, -4.8];
    for (let k = 0; k < 3; k++) P.push({ t: "blob", c: [-0.4 + k * 0.4, 1.45, -1.6 + k * 0.9], r: [0.45, 0.32, 0.6], role: k % 2 ? "path" : "ground" });
  }
  lights(P, hw, 0.95, 3.75, -3.97);
  [2.75, -1.8, -2.9].forEach((z, i) => axle(B, hw - 0.12, z, 0.52, 0.32, "metal", i === 0));
  Object.assign(B.anchors, { "seat.driver": [0.6, 1.95, 3.0], "seat.0": [-0.6, 1.95, 3.0] });
}

function tractor(B: VB, paint: Role) {
  const P = B.P;
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
  axle(B, 0.62, 1.35, 0.45, 0.28, "yellow", true);
  axle(B, 0.85, -0.85, 0.78, 0.45, "yellow");
  for (const sx of [-1, 1]) P.push(bx([sx * 0.62, 1.28, 1.95], [0.06, 0.06, 0.03], "lamp"));
  B.anchors["seat.driver"] = [0, 1.45, -0.7];
}

function wagon(B: VB, paint: Role, v: number) {
  const P = B.P;
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
}

function locomotive(B: VB, paint: Role) {
  const P = B.P;
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
  B.anchors["seat.driver"] = [0.5, 1.9, -1.6];
}

export function vehicleParts(kind: string, paint: Role, variant: number): VB {
  const B = vb();
  switch (kind) {
    case "moderncar":
      moderncar(B, paint, variant);
      break;
    case "van":
      van(B, paint, variant);
      break;
    case "bus":
      bus(B, paint, variant);
      break;
    case "truck":
      truck(B, paint, variant);
      break;
    case "tractor":
      tractor(B, paint);
      break;
    case "wagon":
      wagon(B, paint, variant);
      break;
    case "locomotive":
      locomotive(B, paint);
      break;
  }
  return B;
}

export type VehiclePartsModel = { parts: PartList; joints: JointSpec[]; anchors: Record<string, V3> };

/** Rôle de caisse automatique des véhicules modernes : couleurs franches selon la variante. */
export const MODERN_PAINTS: Role[] = ["red", "blue", "white", "yellow", "green", "black", "accent", "cloth2"];

/** Pièces d'un véhicule à pièces, caisse et relevage résolus (lu par le générateur et par le dessin vectoriel). */
export function vehiclePartsModel(p: Record<string, unknown>): VehiclePartsModel {
  const kind = String(p.kind);
  const variant = Math.max(0, Math.round(Number(p.variant ?? 0)) || 0);
  const paintName = String(p.paint ?? "auto");
  const auto = kind === "tractor" ? (["green", "red", "blue", "yellow"] as Role[])[variant % 4] : kind === "locomotive" ? (["accent", "green", "red", "blue"] as Role[])[variant % 4] : MODERN_PAINTS[variant % MODERN_PAINTS.length];
  const paint = paintName === "auto" ? auto : (paintName as Role);
  const B = vehicleParts(kind, paint, variant);
  const lift = p.onRails && (kind === "wagon" || kind === "locomotive") ? RAIL_TOP : 0;
  const s = Math.max(0.5, Math.min(3, Number(p.size ?? 1) || 1));
  if (!lift && s === 1) return { parts: B.P, joints: B.J, anchors: B.anchors };
  const T = (v: V3): V3 => [v[0] * s, v[1] * s + lift, v[2] * s];
  const lifted = (j: JointSpec): JointSpec => (lift ? { ...j, pivot: [j.pivot[0], j.pivot[1] + lift, j.pivot[2]], parts: j.parts && transformParts(j.parts, [0, 0, 0, 1], [0, lift, 0]), anchors: j.anchors && Object.fromEntries(Object.entries(j.anchors).map(([k, v]) => [k, [v[0], v[1] + lift, v[2]] as V3])) } : j);
  return { parts: transformParts(B.P, [0, 0, 0, 1], [0, lift, 0], s), joints: B.J.map((j) => lifted(scaleJoint(j, s))), anchors: Object.fromEntries(Object.entries(B.anchors).map(([k, v]) => [k, T(v)])) };
}
