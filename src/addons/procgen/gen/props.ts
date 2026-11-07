/**
 * Objets de décor (`prop.*`) et blasons (`emblem`). Petits, nombreux, instanciés : chacun reste sobre en triangles.
 */
import { type V3, DEG, m4Compose, mix, qAxis, qEuler } from "../core/math";
import { Mesh } from "../geom/mesh";
import { box, cylinder, ellipsoid, extrude, lathe, ngon, tube } from "../geom/prims";
import { ROLE } from "../style/roles";
import { type Asset, defineGenerator } from "./types";

const put = (m: Mesh, part: Mesh, p: V3, rot?: [number, number, number]) => m.append(part, m4Compose(p, rot ? qEuler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG) : [0, 0, 0, 1]));
const asset = (generator: string, mesh: Mesh, hx: number, hz: number, h: number, anchors: Asset["anchors"] = {}): Asset => ({ generator, mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: h });

const PROPS = [
  "lamp", "bench", "crate", "barrel", "well", "campfire", "tent", "cart", "stall", "signpost", "lantern", "fence", "haystack", "bollard", "planter", "statue", "mailbox", "boat",
  // mobilier urbain
  "fountain", "kiosk", "busstop", "billboard", "pillar", "bin", "lamp2", "clock", "hydrant",
  // marché
  "awningstall", "baskets", "fruitcrates", "sacks",
  // jardin
  "wheelbarrow", "wateringcan", "beehive", "scarecrow", "birdhouse", "pergola", "greenhouse",
  // terrasse
  "table", "chair", "parasol", "hanginglantern", "garland",
  // signalétique, sol
  "hangingsign", "milestone", "puddle",
] as const;
export type PropKind = (typeof PROPS)[number];

function build(kind: string, size: number, variant: number): Asset {
  const m = new Mesh();
  const W = ROLE.wood, M = ROLE.metal, S = ROLE.stone;
  switch (kind) {
    case "lamp": {
      put(m, cylinder(0.12, 0.09, 0.3, M, 10), [0, 0, 0]);
      put(m, cylinder(0.05, 0.04, 3.2, M, 8), [0, 0.3, 0]);
      put(m, tube([[0, 3.4, 0], [0.25, 3.6, 0], [0.55, 3.55, 0]], [0.035, 0.03, 0.03], M, 6), [0, 0, 0]);
      put(m, lathe([[0.02, 0], [0.16, -0.05], [0.2, -0.35], [0.1, -0.42], [0, -0.42]], ROLE.lamp, 8), [0.55, 3.55, 0]);
      put(m, lathe([[0.03, 0], [0.22, -0.04], [0.02, -0.12]], M, 8), [0.55, 3.62, 0]);
      return asset(kind, m, 0.2, 0.2, 3.7, { light: { pos: [0.55, 3.3, 0], rot: [0, 0, 0, 1], scale: 1 } });
    }
    case "bench":
      for (let i = 0; i < 3; i++) put(m, box(0.8, 0.025, 0.06, W, 0.01), [0, 0.45, -0.12 + i * 0.13]);
      for (let i = 0; i < 2; i++) put(m, box(0.8, 0.05, 0.02, W, 0.01), [0, 0.65 + i * 0.13, -0.24], [-12, 0, 0]);
      for (const x of [-0.7, 0.7]) {
        put(m, box(0.03, 0.22, 0.2, M, 0.01), [x, 0.22, 0]);
        put(m, box(0.03, 0.22, 0.02, M, 0.01), [x, 0.68, -0.25], [-12, 0, 0]);
      }
      return asset(kind, m, 0.85, 0.3, 0.9);
    case "crate": {
      const s = 0.45 * size;
      put(m, box(s, s, s, W, 0.02), [0, s, 0]);
      for (const y of [0.04, 2 * s - 0.04]) for (const z of [-1, 1]) put(m, box(s + 0.012, 0.035, 0.03, ROLE.trim, 0.01), [0, y, z * (s - 0.01)]);
      put(m, box(0.03, s * 1.3, s + 0.01, ROLE.trim, 0.005), [s * 0.0, s, 0], [0, 90, 45]);
      return asset(kind, m, s, s, 2 * s);
    }
    case "barrel": {
      const s = size;
      put(m, lathe([[0.26, 0], [0.31, 0.25], [0.33, 0.45], [0.31, 0.65], [0.26, 0.9]].map(([r, y]) => [r * s, y * s] as [number, number]), W, 14), [0, 0, 0]);
      for (const y of [0.12, 0.78]) put(m, lathe([[0.3 * s, 0], [0.305 * s, 0.05 * s]], M, 14, false), [0, y * s, 0]);
      return asset(kind, m, 0.33 * s, 0.33 * s, 0.9 * s);
    }
    case "well":
      put(m, lathe([[0.75, 0], [0.75, 0.75], [0.6, 0.75], [0.6, 0.1], [0, 0.1]], S, 16), [0, 0, 0]);
      put(m, cylinder(0.6, 0.6, 0.02, ROLE.water, 16), [0, 0.5, 0]);
      for (const x of [-0.65, 0.65]) put(m, box(0.06, 0.9, 0.06, W, 0.01), [x, 1.6, 0]);
      for (const sz of [1, -1]) put(m, box(0.95, 0.03, 0.55, ROLE.roof, 0.01), [0, 2.65, sz * 0.38], [sz * 35, 0, 0]);
      put(m, cylinder(0.06, 0.06, 1.2, W, 8), [-0.6, 1.6, 0], [0, 0, -90]);
      return asset(kind, m, 0.8, 0.8, 2.9);
    case "campfire":
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        put(m, ellipsoid(0.14, 0.09, 0.12, S, 6, 4), [Math.cos(a) * 0.48, 0.05, Math.sin(a) * 0.48]);
      }
      for (let i = 0; i < 4; i++) put(m, cylinder(0.05, 0.05, 0.7, ROLE.bark, 6), [0, 0.05, 0], [70, i * 45, 0]);
      for (let i = 0; i < 4; i++) {
        const f = ellipsoid(0.13 - i * 0.02, 0.32 - i * 0.04, 0.13 - i * 0.02, ROLE.fire, 8, 5);
        f.setFlex(0.4 + i * 0.15);
        put(m, f, [Math.cos(i * 2.1) * 0.06, 0.3 + i * 0.05, Math.sin(i * 2.1) * 0.06]);
      }
      return asset(kind, m, 0.6, 0.6, 0.8, { light: { pos: [0, 0.5, 0], rot: [0, 0, 0, 1], scale: 1 } });
    case "tent": {
      const t = extrude([[-1.3, 0], [1.3, 0], [0, 1.7]], 2.6, ROLE.cloth3, 0.02);
      put(m, t, [0, 0, -1.3]);
      put(m, extrude([[-0.45, 0], [0.45, 0], [0, 1.0]], 0.03, ROLE.ink), [0, 0, 1.31]);
      put(m, cylinder(0.03, 0.03, 1.9, W, 5), [0, 0, 1.4]);
      return asset(kind, m, 1.4, 1.5, 1.9);
    }
    case "cart":
      put(m, box(0.75, 0.2, 1.1, W, 0.02), [0, 0.8, 0]);
      for (const sx of [-1, 1]) {
        put(m, box(0.03, 0.25, 1.1, W, 0.01), [sx * 0.75, 1.1, 0]);
        const wheel = lathe([[0.5, -0.04], [0.5, 0.04]], W, 14, true);
        put(m, wheel, [sx * 0.85, 0.5, -0.3], [0, 0, 90]);
        put(m, cylinder(0.08, 0.08, 0.1, M, 8), [sx * 0.85, 0.5, -0.3], [0, 0, 90]);
      }
      put(m, cylinder(0.04, 0.04, 1.6, W, 6), [0.3, 0.8, 1.1], [80, 0, 0]);
      put(m, cylinder(0.04, 0.04, 1.6, W, 6), [-0.3, 0.8, 1.1], [80, 0, 0]);
      for (let i = 0; i < 4; i++) put(m, ellipsoid(0.18, 0.15, 0.18, i % 2 ? ROLE.flower : ROLE.leaf2, 7, 5), [mix(-0.4, 0.4, (i % 2)), 1.1, -0.5 + i * 0.3]);
      return asset(kind, m, 0.9, 1.4, 1.4);
    case "stall": {
      put(m, box(1.2, 0.45, 0.5, W, 0.02), [0, 0.45, 0]);
      for (const sx of [-1.15, 1.15]) for (const sz of [-0.45, 0.45]) put(m, cylinder(0.04, 0.04, 2.3, W, 6), [sx, 0, sz]);
      for (let i = 0; i < 6; i++) put(m, box(0.21, 0.02, 0.75, i % 2 ? ROLE.paper : ROLE.accent, 0.005), [-1.05 + i * 0.42, 2.25, 0.15], [-14, 0, 0]);
      for (let i = 0; i < 6; i++) put(m, ellipsoid(0.12, 0.1, 0.12, [ROLE.flower, ROLE.leaf2, ROLE.accent][i % 3], 7, 4), [-0.9 + i * 0.36, 0.98, 0.1]);
      return asset(kind, m, 1.25, 0.6, 2.4);
    }
    case "signpost":
      put(m, cylinder(0.06, 0.05, 2.4, W, 6), [0, 0, 0]);
      for (let i = 0; i < 2 + (variant % 2); i++) {
        const arrow = extrude([[-0.5, -0.12], [0.38, -0.12], [0.55, 0], [0.38, 0.12], [-0.5, 0.12]], 0.05, ROLE.paper, 0.01);
        put(m, arrow, [0.35, 2.05 - i * 0.35, -0.025], [0, (i * 70 + variant * 40) % 360, 0]);
      }
      return asset(kind, m, 0.6, 0.6, 2.4);
    case "lantern":
      put(m, cylinder(0.04, 0.04, 1.6, M, 6), [0, 0, 0]);
      put(m, lathe([[0.02, 0], [0.12, -0.02], [0.13, -0.28], [0.06, -0.33], [0, -0.33]], ROLE.lamp, 8), [0, 1.95, 0]);
      put(m, lathe([[0.02, 0], [0.16, -0.04], [0.02, -0.09]], M, 8), [0, 2.0, 0]);
      return asset(kind, m, 0.15, 0.15, 2.05, { light: { pos: [0, 1.8, 0], rot: [0, 0, 0, 1], scale: 1 } });
    case "fence":
      for (const x of [-1, 1]) put(m, box(0.05, 0.55, 0.05, W, 0.01), [x, 0.55, 0]);
      for (const y of [0.4, 0.85]) put(m, box(1, 0.04, 0.025, W, 0.01), [0, y, 0.03]);
      return asset(kind, m, 1, 0.08, 1.1);
    case "haystack":
      put(m, ellipsoid(0.9 * size, 0.8 * size, 0.9 * size, ROLE.path, 12, 8), [0, 0.5 * size, 0]);
      return asset(kind, m, 0.9 * size, 0.9 * size, 1.3 * size);
    case "bollard":
      put(m, lathe([[0.12, 0], [0.12, 0.7], [0.14, 0.72], [0.1, 0.82], [0, 0.85]], S, 10), [0, 0, 0]);
      return asset(kind, m, 0.14, 0.14, 0.85);
    case "planter":
      put(m, box(0.5, 0.25, 0.5, S, 0.03), [0, 0.25, 0]);
      put(m, box(0.45, 0.02, 0.45, ROLE.ground, 0), [0, 0.5, 0]);
      for (let i = 0; i < 5; i++) put(m, ellipsoid(0.2, 0.18, 0.2, i % 2 ? ROLE.leaf : ROLE.flower, 7, 4).setFlex(0.3), [Math.cos(i * 1.3) * 0.22, 0.62, Math.sin(i * 1.3) * 0.22]);
      return asset(kind, m, 0.5, 0.5, 0.85);
    case "statue":
      put(m, box(0.6, 0.5, 0.6, S, 0.03), [0, 0.5, 0]);
      put(m, box(0.7, 0.06, 0.7, ROLE.trim, 0.02), [0, 1.03, 0]);
      put(m, lathe([[0.3, 0], [0.22, 0.6], [0.3, 1.2], [0.16, 1.45], [0.18, 1.6], [0, 1.75]], ROLE.metal, 10), [0, 1.08, 0]);
      return asset(kind, m, 0.7, 0.7, 2.9);
    case "mailbox":
      put(m, cylinder(0.04, 0.04, 1.0, W, 6), [0, 0, 0]);
      put(m, box(0.16, 0.14, 0.25, ROLE.accent, 0.04), [0, 1.12, 0]);
      return asset(kind, m, 0.2, 0.25, 1.3);
    case "boat": {
      const hull = lathe([[0, 0], [0.5, 0.05], [0.75, 0.4], [0.8, 0.55]], W, 12, false);
      hull.mapPos((q) => [q[0] * 0.75, q[1], q[2] * 2.4]).computeNormals();
      put(m, hull, [0, 0, 0]);
      put(m, box(0.55, 0.03, 0.12, W, 0.01), [0, 0.38, 0.4]);
      put(m, box(0.55, 0.03, 0.12, W, 0.01), [0, 0.38, -0.6]);
      return asset(kind, m, 0.6, 1.9, 0.6);
    }
    /* ---------- mobilier urbain ---------- */
    case "fountain": {
      // vasque octogonale, pile centrale, coupe haute et jets d'eau
      const R = 1.6 * size;
      const basin = lathe([[R, 0], [R, 0.55], [R - 0.18, 0.55], [R - 0.18, 0.15], [0, 0.15]], S, 8, true);
      put(m, basin.facet(), [0, 0, 0], [0, 22.5, 0]);
      put(m, cylinder(R - 0.2, R - 0.2, 0.02, ROLE.water, 8), [0, 0.42, 0]);
      put(m, lathe([[0.3, 0], [0.22, 0.3], [0.16, 1.1], [0.26, 1.2]], S, 8), [0, 0.15, 0]);
      put(m, lathe([[0.1, 0], [0.75, 0.12], [0.8, 0.3], [0.65, 0.3], [0, 0.2]], ROLE.trim, 10), [0, 1.3, 0]);
      put(m, cylinder(0.62, 0.62, 0.02, ROLE.water, 10), [0, 1.55, 0]);
      put(m, lathe([[0.08, 0], [0.06, 0.4], [0.12, 0.5], [0, 0.65]], S, 6), [0, 1.55, 0]);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const jet = tube([[Math.cos(a) * 0.7, 1.55, Math.sin(a) * 0.7], [Math.cos(a) * 1.0, 1.2, Math.sin(a) * 1.0], [Math.cos(a) * 1.2, 0.5, Math.sin(a) * 1.2]], [0.03, 0.04, 0.05], ROLE.water, 4);
        jet.setFlex(0.2);
        put(m, jet, [0, 0, 0]);
      }
      put(m, tube([[0, 2.15, 0], [0, 2.5, 0], [0.02, 2.2, 0.01]], [0.04, 0.05, 0.06], ROLE.water, 5), [0, 0, 0]);
      return asset(kind, m, R, R, 2.6);
    }
    case "kiosk": {
      // kiosque à musique : socle octogonal, colonnettes de fonte, garde-corps, toit en pavillon à lanterneau
      const R = 3 * size;
      put(m, lathe([[R + 0.2, 0], [R + 0.2, 0.9], [R + 0.35, 0.95], [R + 0.35, 1.05], [0, 1.05]], S, 8).facet(), [0, 0, 0], [0, 22.5, 0]);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        put(m, cylinder(0.06, 0.06, 3, M, 6), [Math.cos(a) * R, 1.05, Math.sin(a) * R]);
        put(m, box(0.12, 0.5, 0.03, M), [Math.cos(a) * R * 0.97, 3.75, Math.sin(a) * R * 0.97], [0, (-a * 180) / Math.PI + 90, 0]);
        if (i !== 0) {
          const b = ((i + 0.5) / 8) * Math.PI * 2;
          const L = 2 * R * Math.sin(Math.PI / 8);
          put(m, box(L / 2, 0.025, 0.025, M), [Math.cos(b) * R * 0.92, 1.95, Math.sin(b) * R * 0.92], [0, (-b * 180) / Math.PI + 90, 0]);
          for (let k = -2; k <= 2; k++) put(m, box(0.012, 0.4, 0.012, M), [Math.cos(b) * R * 0.92 - Math.sin(b) * k * L * 0.18, 1.5, Math.sin(b) * R * 0.92 + Math.cos(b) * k * L * 0.18]);
        }
      }
      put(m, lathe([[R + 0.5, 0], [R * 0.75, 0.6], [0.6, 1.6], [0.6, 1.75], [0.7, 1.75], [0.5, 2.2], [0, 2.5]], ROLE.roof, 8).facet(), [0, 4.05, 0], [0, 22.5, 0]);
      for (let k = 0; k < 3; k++) put(m, box(0.25, 0.1, 0.5, S), [0, 0.15 + k * 0.3, R + 0.9 - k * 0.3]);
      return asset(kind, m, R + 0.5, R + 1.2, 6.6);
    }
    case "busstop": {
      // abribus : cadre métallique, parois vitrées, toit débordant, banc, affiche
      for (const x of [-1.3, 1.3]) for (const z of [-0.6, 0.5]) put(m, box(0.04, 1.25, 0.04, M), [x, 1.25, z]);
      put(m, box(1.45, 0.06, 0.8, M), [0, 2.52, 0], [-4, 0, 0]);
      put(m, box(1.3, 1.0, 0.015, ROLE.glass), [0, 1.3, -0.6]);
      put(m, box(0.015, 1.0, 0.5, ROLE.glass), [-1.3, 1.3, -0.05]);
      put(m, box(0.5, 0.75, 0.02, ROLE.paper), [-0.7, 1.35, -0.58]);
      put(m, box(0.42, 0.65, 0.025, variant % 2 ? ROLE.accent : ROLE.cloth1), [-0.7, 1.35, -0.57]);
      put(m, box(0.9, 0.03, 0.18, W), [0.25, 0.48, -0.4]);
      for (const x of [-0.5, 1.0]) put(m, box(0.025, 0.24, 0.025, M), [x, 0.24, -0.4]);
      put(m, cylinder(0.035, 0.035, 2.6, M, 5), [1.6, 0, 0.6]);
      put(m, extrude(ngon(14, 0.22), 0.03, ROLE.accent), [1.6, 2.4, 0.62]);
      return asset(kind, m, 1.6, 0.8, 2.7);
    }
    case "billboard": {
      // panneau d'affichage sur deux pieds, affiche et cadre
      put(m, box(1.25, 0.85, 0.04, ROLE.paper), [0, 1.65, 0]);
      put(m, box(1.15, 0.75, 0.01, [ROLE.accent, ROLE.water, ROLE.leaf2, ROLE.cloth1][variant % 4]), [0, 1.65, 0.045]);
      put(m, box(0.5, 0.2, 0.012, ROLE.paper), [-0.4, 1.95, 0.05]);
      put(m, box(1.3, 0.05, 0.08, M), [0, 2.52, 0]);
      put(m, box(1.3, 0.05, 0.08, M), [0, 0.78, 0]);
      for (const x of [-0.9, 0.9]) put(m, box(0.05, 0.85, 0.05, M), [x, 0.85, -0.06]);
      return asset(kind, m, 1.3, 0.2, 2.6);
    }
    case "pillar": {
      // colonne Morris : fût à affiches, corniche, dôme à lanterneau
      put(m, lathe([[0.62, 0], [0.62, 0.3], [0.55, 0.32], [0.55, 2.5], [0.66, 2.6], [0.66, 2.7], [0.5, 2.75], [0.35, 3.1], [0.14, 3.2], [0.14, 3.35], [0, 3.45]], M, 14), [0, 0, 0]);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + variant;
        put(m, box(0.28, 0.5, 0.01, [ROLE.paper, ROLE.accent, ROLE.cloth3, ROLE.water, ROLE.leaf2][(i + variant) % 5]), [Math.cos(a) * 0.56, 1.4 + (i % 2) * 0.35, Math.sin(a) * 0.56], [0, 90 - (a * 180) / Math.PI, 0]);
      }
      return asset(kind, m, 0.66, 0.66, 3.45);
    }
    case "bin": {
      put(m, lathe([[0.2, 0], [0.22, 0.7], [0.23, 0.72], [0, 0.72]], variant % 2 ? M : ROLE.leaf2, 10), [0, 0.1, 0]);
      put(m, cylinder(0.025, 0.025, 1.0, M, 5), [0, 0, -0.26]);
      put(m, box(0.04, 0.03, 0.04, M), [0, 0.6, -0.24]);
      return asset(kind, m, 0.25, 0.3, 1.0);
    }
    case "lamp2": {
      // réverbère double : fût cannelé à base moulurée, crosse en lyre, deux lanternes
      put(m, lathe([[0.2, 0], [0.2, 0.35], [0.14, 0.45], [0.09, 0.6], [0.07, 3.6], [0.1, 3.7], [0.06, 3.75]], M, 10), [0, 0, 0]);
      for (const sx of [-1, 1]) {
        put(m, tube([[0, 3.6, 0], [sx * 0.35, 3.95, 0], [sx * 0.7, 3.85, 0]], [0.035, 0.03, 0.03], M, 5), [0, 0, 0]);
        put(m, tube([[sx * 0.1, 3.4, 0], [sx * 0.45, 3.55, 0], [sx * 0.5, 3.8, 0]], [0.015, 0.015, 0.015], M, 4), [0, 0, 0]);
        put(m, lathe([[0.02, 0], [0.16, -0.04], [0.19, -0.32], [0.1, -0.4], [0, -0.42]], ROLE.lamp, 6), [sx * 0.7, 3.82, 0]);
        put(m, lathe([[0.03, 0], [0.22, -0.04], [0.02, -0.12]], M, 6), [sx * 0.7, 3.9, 0]);
      }
      put(m, ellipsoid(0.07, 0.1, 0.07, M, 6, 4), [0, 3.9, 0]);
      return asset(kind, m, 0.8, 0.2, 4.0, { light: { pos: [0, 3.5, 0], rot: [0, 0, 0, 1], scale: 1 } });
    }
    case "clock": {
      // horloge de rue : colonne, cadrans doubles, aiguilles
      put(m, lathe([[0.22, 0], [0.22, 0.3], [0.12, 0.45], [0.09, 2.7], [0.16, 2.8]], M, 10), [0, 0, 0]);
      put(m, cylinder(0.42, 0.42, 0.22, M, 16), [0, 3.2, -0.11], [90, 0, 0]);
      for (const sz of [1, -1]) {
        put(m, cylinder(0.36, 0.36, 0.01, ROLE.paper, 16), [0, 3.2, sz * 0.115], [90, 0, 0]);
        put(m, box(0.015, 0.15, 0.01, ROLE.ink), [0.04, 3.27, sz * 0.13], [0, 0, -30]);
        put(m, box(0.012, 0.24, 0.01, ROLE.ink), [-0.08, 3.15, sz * 0.13], [0, 0, -120]);
        for (let i = 0; i < 12; i++) put(m, box(0.012, 0.035, 0.008, ROLE.ink), [Math.sin((i * Math.PI) / 6) * 0.3, 3.2 + Math.cos((i * Math.PI) / 6) * 0.3, sz * 0.125], [0, 0, (-i * 180) / 6]);
      }
      put(m, ellipsoid(0.12, 0.14, 0.12, M, 6, 4), [0, 3.65, 0]);
      return asset(kind, m, 0.45, 0.25, 3.8);
    }
    case "hydrant": {
      // borne-fontaine de fonte : fût, chapeau, bec et bouton
      put(m, lathe([[0.18, 0], [0.18, 0.08], [0.13, 0.12], [0.12, 0.75], [0.15, 0.78], [0.15, 0.85], [0.08, 0.95], [0, 0.98]], variant % 2 ? ROLE.leaf2 : ROLE.accent, 10), [0, 0, 0]);
      put(m, cylinder(0.04, 0.035, 0.14, M, 6), [0, 0.55, 0.1], [90, 0, 0]);
      put(m, cylinder(0.03, 0.03, 0.1, M, 6), [0.1, 0.7, 0], [0, 0, -90]);
      return asset(kind, m, 0.2, 0.22, 1.0);
    }
    /* ---------- marché ---------- */
    case "awningstall": {
      // étal couvert d'une toile rayée en bâtière, tréteaux, cageots, balance
      const stripe = [ROLE.accent, ROLE.cloth1, ROLE.leaf2, ROLE.water][variant % 4];
      put(m, box(1.3, 0.04, 0.6, W), [0, 0.85, 0]);
      for (const sx of [-1, 1]) {
        put(m, box(0.04, 0.42, 0.55, W), [sx * 1.1, 0.42, 0]);
        for (const sz of [-1, 1]) put(m, cylinder(0.035, 0.035, 2.2, W, 5), [sx * 1.3, 0, sz * 0.62]);
      }
      put(m, box(1.32, 0.02, 0.02, W), [0, 2.2, 0]);
      for (let i = 0; i < 8; i++) for (const sz of [1, -1]) put(m, box(0.165, 0.012, 0.42, i % 2 ? ROLE.paper : stripe), [-1.155 + i * 0.33, 2.02, sz * 0.38], [sz * 28, 0, 0]);
      for (let i = 0; i < 8; i++) for (const sz of [1, -1]) put(m, box(0.165, 0.09, 0.008, i % 2 ? ROLE.paper : stripe), [-1.155 + i * 0.33, 1.73, sz * 0.75]);
      for (let i = 0; i < 4; i++) {
        put(m, box(0.26, 0.08, 0.2, W), [-0.9 + i * 0.6, 0.97, 0.25]);
        for (let k = 0; k < 4; k++) put(m, ellipsoid(0.07, 0.06, 0.07, [ROLE.flower, ROLE.leaf2, ROLE.accent, ROLE.paper][(i + variant) % 4], 5, 3), [-0.98 + i * 0.6 + (k % 2) * 0.15, 1.1, 0.18 + Math.floor(k / 2) * 0.13]);
      }
      put(m, cylinder(0.1, 0.1, 0.02, M, 8), [0.9, 0.9, -0.3]);
      put(m, box(0.02, 0.12, 0.02, M), [0.9, 1.0, -0.3]);
      return asset(kind, m, 1.35, 0.8, 2.3);
    }
    case "baskets": {
      // paniers d'osier (profil évasé, anse), garnis
      for (let i = 0; i < 3; i++) {
        const x = (i - 1) * 0.5, z = (i % 2) * 0.2;
        const r = 0.2 + (i % 2) * 0.05;
        put(m, lathe([[r * 0.7, 0], [r, 0.25], [r * 1.05, 0.28], [r * 0.98, 0.28], [r * 0.9, 0.04], [0, 0.04]], ROLE.path, 10, false), [x, 0, z]);
        put(m, cylinder(r * 0.95, r * 0.95, 0.02, [ROLE.flower, ROLE.leaf2, ROLE.accent][(i + variant) % 3], 8), [x, 0.22, z]);
        for (let k = 0; k < 3; k++) put(m, ellipsoid(0.06, 0.05, 0.06, [ROLE.flower, ROLE.leaf2, ROLE.accent][(i + variant) % 3], 5, 3), [x + Math.cos(k * 2.1) * r * 0.5, 0.27, z + Math.sin(k * 2.1) * r * 0.5]);
        if (i !== 1) put(m, lathe([[r * 0.85, -0.012], [r * 0.85, 0.012]], ROLE.path, 8, false), [x, 0.28, z], [90, 0, 0]);
      }
      return asset(kind, m, 0.8, 0.35, 0.5);
    }
    case "fruitcrates": {
      // cageots à claire-voie empilés, fruits
      const crate = (x: number, y: number, z: number, rot: number, role: number) => {
        for (const sz of [-1, 1]) for (const yy of [0.05, 0.17]) put(m, box(0.28, 0.035, 0.012, W), [x, y + yy, z + sz * 0.19], [0, rot, 0]);
        for (const sx of [-1, 1]) put(m, box(0.02, 0.12, 0.2, W), [x + Math.cos((rot * Math.PI) / 180) * sx * 0.27, y + 0.12, z - Math.sin((rot * Math.PI) / 180) * sx * 0.27], [0, rot, 0]);
        put(m, box(0.27, 0.01, 0.18, W), [x, y + 0.02, z], [0, rot, 0]);
        for (let k = 0; k < 6; k++) put(m, ellipsoid(0.065, 0.06, 0.065, role, 5, 3), [x + ((k % 3) - 1) * 0.16, y + 0.2, z + (Math.floor(k / 3) - 0.5) * 0.17]);
      };
      crate(0, 0, 0, 0, [ROLE.accent, ROLE.flower][variant % 2]);
      crate(0.62, 0, 0.05, 6, ROLE.leaf2);
      crate(0.3, 0.26, 0.0, -4, [ROLE.flower, ROLE.paper][variant % 2]);
      return asset(kind, m, 0.65, 0.3, 0.55);
    }
    case "sacks": {
      // sacs de jute affaissés, col noué
      for (let i = 0; i < 3 + (variant % 2); i++) {
        const x = (i - 1) * 0.42 + (i === 3 ? -0.2 : 0), z = i === 3 ? 0.35 : (i % 2) * 0.12, y = i === 3 ? 0.0 : 0;
        put(m, lathe([[0.2, 0], [0.26, 0.1], [0.24, 0.35], [0.12, 0.5], [0.06, 0.55], [0.09, 0.62], [0, 0.63]], ROLE.cloth3, 8), [x, y, z], [i === 3 ? 70 : 0, i * 40, 0]);
      }
      return asset(kind, m, 0.75, 0.45, 0.65);
    }
    /* ---------- jardin ---------- */
    case "wheelbarrow": {
      const bed = lathe([[0.3, 0], [0.42, 0.28], [0.44, 0.3]], variant % 2 ? M : W, 4, true);
      bed.mapPos((q) => [q[0] * 1.0, q[1], q[2] * 1.5]).computeNormals();
      put(m, bed.facet(), [0, 0.32, 0], [0, 45, 0]);
      put(m, cylinder(0.18, 0.18, 0.06, ROLE.ink, 10), [-0.03, 0.18, 0.5], [0, 0, 90]);
      for (const sx of [-1, 1]) put(m, box(0.015, 0.015, 0.2, M), [sx * 0.06, 0.25, 0.42], [-30, 0, 0]);
      for (const sx of [-1, 1]) {
        put(m, box(0.025, 0.025, 0.65, W), [sx * 0.24, 0.42, -0.35], [-12, 0, 0]);
        put(m, box(0.02, 0.17, 0.02, M), [sx * 0.2, 0.17, -0.25]);
      }
      put(m, ellipsoid(0.32, 0.1, 0.42, ROLE.ground, 6, 3), [0, 0.6, 0]);
      return asset(kind, m, 0.35, 0.85, 0.7);
    }
    case "wateringcan": {
      put(m, lathe([[0.12, 0], [0.13, 0.22], [0.1, 0.26], [0, 0.26]], variant % 2 ? M : ROLE.leaf2, 10), [0, 0, 0]);
      put(m, tube([[0.1, 0.05, 0], [0.25, 0.2, 0], [0.32, 0.32, 0]], [0.025, 0.02, 0.018], M, 5), [0, 0, 0]);
      put(m, cylinder(0.025, 0.04, 0.03, M, 6), [0.32, 0.32, 0], [0, 0, -50]);
      put(m, tube([[-0.11, 0.08, 0], [-0.17, 0.25, 0], [-0.05, 0.35, 0], [0.05, 0.26, 0]], [0.012, 0.012, 0.012, 0.012], M, 4), [0, 0, 0]);
      return asset(kind, m, 0.3, 0.15, 0.35);
    }
    case "beehive": {
      if (variant % 2) {
        // ruche en paille (skep) sur un billot
        put(m, cylinder(0.25, 0.25, 0.4, ROLE.bark, 8), [0, 0, 0]);
        const skep = lathe([[0.32, 0], [0.33, 0.15], [0.3, 0.32], [0.22, 0.48], [0.1, 0.56], [0, 0.58]], ROLE.path, 10);
        put(m, skep, [0, 0.4, 0]);
        for (let k = 0; k < 4; k++) put(m, lathe([[0.33 - k * 0.03, -0.012], [0.335 - k * 0.03, 0.012]], ROLE.path, 10, false), [0, 0.48 + k * 0.1, 0]);
        put(m, box(0.06, 0.03, 0.02, ROLE.ink), [0, 0.44, 0.31]);
        return asset(kind, m, 0.35, 0.35, 1.0);
      }
      // ruche Dadant : pieds, corps, hausses, toit, planche d'envol
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(m, box(0.03, 0.2, 0.03, W), [sx * 0.2, 0.2, sz * 0.2]);
      put(m, box(0.25, 0.18, 0.25, ROLE.paper), [0, 0.58, 0]);
      put(m, box(0.25, 0.1, 0.25, ROLE.cloth3), [0, 0.86, 0]);
      put(m, box(0.25, 0.1, 0.25, ROLE.paper), [0, 1.06, 0]);
      put(m, box(0.3, 0.04, 0.3, M), [0, 1.2, 0]);
      put(m, box(0.2, 0.01, 0.08, W), [0, 0.41, 0.3], [15, 0, 0]);
      put(m, box(0.1, 0.012, 0.01, ROLE.ink), [0, 0.43, 0.255]);
      return asset(kind, m, 0.3, 0.35, 1.25);
    }
    case "scarecrow": {
      // épouvantail : croix de bois, sac de tête, chapeau de paille, chemise, paille qui dépasse
      put(m, cylinder(0.04, 0.035, 1.9, W, 5), [0, 0, 0]);
      put(m, box(0.75, 0.03, 0.03, W), [0, 1.45, 0]);
      put(m, ellipsoid(0.16, 0.18, 0.15, ROLE.cloth3, 7, 5), [0, 1.85, 0]);
      put(m, lathe([[0.35, 0], [0.35, 0.02], [0.14, 0.04], [0.13, 0.16], [0, 0.18]], ROLE.path, 10), [0, 1.98, 0], [6, 0, -8]);
      put(m, lathe([[0.18, 0], [0.22, 0.45], [0.2, 0.55], [0.08, 0.6]], ROLE.cloth1, 8, false), [0, 0.9, 0]);
      for (const sx of [-1, 1]) {
        put(m, tube([[sx * 0.15, 1.45, 0], [sx * 0.7, 1.43, 0]], [0.08, 0.07], ROLE.cloth1, 6, false, true), [0, 0, 0]);
        for (let k = 0; k < 3; k++) put(m, cylinder(0.008, 0.008, 0.15, ROLE.path, 3), [sx * 0.74, 1.43, (k - 1) * 0.03], [0, 0, sx * (-70 - k * 15)]);
      }
      put(m, ellipsoid(0.025, 0.025, 0.02, ROLE.ink, 4, 3), [-0.06, 1.88, 0.14]);
      put(m, ellipsoid(0.025, 0.025, 0.02, ROLE.ink, 4, 3), [0.06, 1.88, 0.14]);
      return asset(kind, m, 0.8, 0.2, 2.2);
    }
    case "birdhouse": {
      put(m, cylinder(0.035, 0.035, 1.6, W, 5), [0, 0, 0]);
      put(m, box(0.13, 0.15, 0.13, variant % 2 ? ROLE.paper : W), [0, 1.75, 0]);
      for (const sx of [-1, 1]) put(m, box(0.12, 0.012, 0.17, ROLE.roof), [sx * 0.08, 1.96, 0], [0, 0, -sx * 38]);
      put(m, extrude([[-0.13, 0], [0.13, 0], [0, 0.11]], 0.26, variant % 2 ? ROLE.paper : W), [0, 1.9, -0.13]);
      put(m, cylinder(0.04, 0.04, 0.01, ROLE.ink, 8), [0, 1.8, 0.13], [90, 0, 0]);
      put(m, cylinder(0.008, 0.008, 0.08, W, 3), [0, 1.7, 0.13], [90, 0, 0]);
      return asset(kind, m, 0.2, 0.2, 2.05);
    }
    case "pergola": {
      // pergola : poteaux, longerons, chevrons, plante grimpante sur un côté
      const L = 3 * size, D = 2.4;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(m, box(0.07, 1.2, 0.07, W), [sx * L / 2, 1.2, sz * D / 2]);
      for (const sz of [-1, 1]) put(m, box(L / 2 + 0.25, 0.08, 0.05, W), [0, 2.4, sz * D / 2]);
      for (let i = 0; i <= 6; i++) put(m, box(0.035, 0.06, D / 2 + 0.25, W), [-L / 2 + (i * L) / 6, 2.52, 0]);
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        put(m, ellipsoid(0.28, 0.2, 0.25, i % 2 ? ROLE.leaf : ROLE.leaf2, 6, 3).setFlex(0.3), [mix(-L / 2, L / 2, t), 2.6, -D / 2 + 0.25 + (i % 3) * 0.3]);
        if (i % 3 === 0) put(m, ellipsoid(0.08, 0.06, 0.08, ROLE.flower, 5, 3), [mix(-L / 2, L / 2, t), 2.45, -D / 2 + 0.4]);
      }
      put(m, tube([[-L / 2, 0, -D / 2 + 0.1], [-L / 2 + 0.1, 1.2, -D / 2 + 0.15], [-L / 2, 2.4, -D / 2 + 0.1]], [0.04, 0.03, 0.025], ROLE.bark, 4), [0, 0, 0]);
      return asset(kind, m, L / 2 + 0.25, D / 2 + 0.2, 2.7);
    }
    case "greenhouse": {
      // serre : soubassement de brique, montants fins, vitrage, toit vitré à deux pans
      const L = 3.2 * size, D = 2.4, H = 1.8;
      put(m, box(L / 2, 0.25, D / 2, ROLE.roof), [0, 0.25, 0]);
      put(m, box(L / 2 - 0.03, H / 2 - 0.25, D / 2 - 0.03, ROLE.glass), [0, H / 2 + 0.25, 0]);
      const rise = 0.9;
      for (const sz of [1, -1]) put(m, box(L / 2, 0.015, Math.hypot(D / 2, rise) / 2, ROLE.glass), [0, H + rise / 2, (sz * D) / 4], [sz * Math.atan2(rise, D / 2) * (180 / Math.PI), 0, 0]);
      for (const sx of [-1, 1]) put(m, extrude([[-D / 2, 0], [D / 2, 0], [0, rise]], 0.02, ROLE.glass), [sx * L / 2 - (sx > 0 ? 0.02 : 0), H, 0], [0, 90, 0]);
      const n = 5;
      for (let i = 0; i <= n; i++) {
        const x = -L / 2 + (i * L) / n;
        for (const sz of [1, -1]) {
          put(m, box(0.025, H / 2 - 0.12, 0.025, ROLE.paper), [x, H / 2 + 0.38, sz * D / 2]);
          put(m, box(0.02, 0.02, Math.hypot(D / 2, rise) / 2, ROLE.paper), [x, H + rise / 2 + 0.02, (sz * D) / 4], [sz * Math.atan2(rise, D / 2) * (180 / Math.PI), 0, 0]);
        }
      }
      put(m, box(L / 2 + 0.05, 0.04, 0.04, ROLE.paper), [0, H + rise + 0.02, 0]);
      for (const sz of [1, -1]) put(m, box(L / 2, 0.03, 0.03, ROLE.paper), [0, H + 0.02, sz * D / 2]);
      put(m, box(0.4, 0.75, 0.02, ROLE.paper), [L / 2 + 0.01, 1.0, 0], [0, 90, 0]);
      for (let i = 0; i < 6; i++) put(m, ellipsoid(0.22, 0.25, 0.22, i % 2 ? ROLE.leaf : ROLE.leaf2, 6, 3), [-L / 2 + 0.4 + i * 0.48, 0.75, (i % 2 ? 1 : -1) * 0.6]);
      return asset(kind, m, L / 2 + 0.1, D / 2 + 0.1, H + rise + 0.1);
    }
    /* ---------- terrasse ---------- */
    case "table": {
      if (variant % 2) {
        // guéridon de bistrot : plateau rond, pied de fonte
        put(m, cylinder(0.32, 0.32, 0.03, variant % 4 === 1 ? ROLE.stone : M, 12), [0, 0.72, 0]);
        put(m, cylinder(0.03, 0.03, 0.7, M, 5), [0, 0.02, 0]);
        put(m, cylinder(0.2, 0.05, 0.08, M, 8), [0, 0, 0]);
        put(m, cylinder(0.03, 0.03, 0.08, ROLE.glass, 5), [0.1, 0.75, 0.05]);
        return asset(kind, m, 0.32, 0.32, 0.85);
      }
      put(m, box(0.6, 0.025, 0.4, W), [0, 0.74, 0]);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(m, box(0.025, 0.36, 0.025, W), [sx * 0.52, 0.36, sz * 0.32]);
      put(m, box(0.56, 0.02, 0.02, W), [0, 0.6, 0.32]);
      put(m, box(0.56, 0.02, 0.02, W), [0, 0.6, -0.32]);
      return asset(kind, m, 0.6, 0.4, 0.8);
    }
    case "chair": {
      const role = variant % 2 ? M : W;
      put(m, box(0.21, 0.02, 0.2, role), [0, 0.45, 0]);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(m, box(0.015, 0.225, 0.015, role), [sx * 0.18, 0.225, sz * 0.17]);
      for (const sx of [-1, 1]) put(m, box(0.015, 0.25, 0.015, role), [sx * 0.18, 0.7, -0.19], [-8, 0, 0]);
      for (const y of [0.62, 0.8]) put(m, box(0.19, 0.03, 0.012, role), [0, y, -0.2], [-8, 0, 0]);
      return asset(kind, m, 0.22, 0.22, 0.95);
    }
    case "parasol": {
      const c = [ROLE.accent, ROLE.paper, ROLE.cloth1, ROLE.leaf2][variant % 4];
      put(m, cylinder(0.025, 0.025, 2.3, W, 5), [0, 0, 0]);
      put(m, cylinder(0.25, 0.25, 0.06, ROLE.stone, 8), [0, 0, 0]);
      const canopy = lathe([[0, 0.35], [0.7, 0.18], [1.3, 0], [1.3, -0.03]], c, 8, false);
      // festons : rayures alternées par pan
      for (let i = 0; i < canopy.vertexCount; i++) {
        const q = canopy.getPos(i);
        const a = Math.atan2(q[2], q[0]);
        if (Math.floor(((a + Math.PI) / (Math.PI * 2)) * 8 + 0.5) % 2) canopy.role[i] = ROLE.paper;
      }
      put(m, canopy.facet(), [0, 2.0, 0]);
      for (let i = 0; i < 8; i++) {
        const a = ((i + 0.5) / 8) * Math.PI * 2;
        put(m, box(0.13, 0.06, 0.005, c), [Math.cos(a) * 1.25, 1.94, Math.sin(a) * 1.25], [0, 90 - (a * 180) / Math.PI, 0]);
      }
      return asset(kind, m, 1.3, 1.3, 2.4);
    }
    case "hanginglantern": {
      // lanterne suspendue à une potence murale (accrochée à un mur en −z)
      put(m, box(0.05, 0.1, 0.02, M), [0, 2.6, 0]);
      put(m, tube([[0, 2.65, 0], [0, 2.7, 0.3], [0, 2.62, 0.55]], [0.015, 0.015, 0.015], M, 4), [0, 0, 0]);
      put(m, tube([[0, 2.45, 0], [0, 2.55, 0.25], [0, 2.67, 0.4]], [0.01, 0.01, 0.01], M, 4), [0, 0, 0]);
      put(m, cylinder(0.005, 0.005, 0.12, M, 3), [0, 2.48, 0.55]);
      put(m, lathe([[0.03, 0], [0.12, -0.04], [0.02, -0.08]], M, 6), [0, 2.5, 0.55]);
      put(m, lathe([[0.06, 0], [0.09, -0.06], [0.09, -0.26], [0.05, -0.3], [0, -0.3]], ROLE.lamp, 6), [0, 2.44, 0.55]);
      return asset(kind, m, 0.15, 0.35, 2.7, { light: { pos: [0, 2.3, 0.55], rot: [0, 0, 0, 1], scale: 1 } });
    }
    case "garland": {
      // guirlande d'ampoules entre deux mâts, chaînette en chaînette (cosh)
      const L = 5 * size;
      for (const sx of [-1, 1]) put(m, cylinder(0.04, 0.035, 3, W, 5), [sx * L / 2, 0, 0]);
      const pts: V3[] = [];
      for (let i = 0; i <= 10; i++) {
        const x = -L / 2 + (i * L) / 10;
        pts.push([x, 2.9 - 0.45 * (1 - ((2 * x) / L) ** 2), 0]);
      }
      put(m, tube(pts, pts.map(() => 0.008), ROLE.ink, 3, false, false), [0, 0, 0]);
      for (let i = 1; i < 10; i++) put(m, ellipsoid(0.04, 0.055, 0.04, i % 3 === 0 ? ROLE.accent : ROLE.lamp, 5, 3).setFlex(0.3), [pts[i][0], pts[i][1] - 0.07, 0]);
      return asset(kind, m, L / 2, 0.1, 3.0, { light: { pos: [0, 2.5, 0], rot: [0, 0, 0, 1], scale: 1 } });
    }
    /* ---------- signalétique, sol ---------- */
    case "hangingsign": {
      // enseigne suspendue sur poteau, potence à volute de fer forgé
      put(m, cylinder(0.05, 0.045, 2.7, W, 6), [0, 0, 0]);
      put(m, box(0.025, 0.025, 0.55, M), [0, 2.55, 0.3]);
      put(m, tube([[0, 2.2, 0.02], [0, 2.35, 0.25], [0, 2.53, 0.42]], [0.012, 0.012, 0.012], M, 4), [0, 0, 0]);
      put(m, lathe([[0.08, -0.008], [0.08, 0.008]], M, 8, false), [0, 2.42, 0.18], [0, 0, 90]);
      const shape: [number, number][] = variant % 3 === 0 ? ngon(14, 0.26) : variant % 3 === 1 ? [[-0.25, 0.2], [0.25, 0.2], [0.25, -0.05], [0, -0.3], [-0.25, -0.05]] : [[-0.3, -0.18], [0.3, -0.18], [0.3, 0.18], [-0.3, 0.18]];
      put(m, extrude(shape, 0.04, [ROLE.accent, ROLE.wood, ROLE.leaf2, ROLE.paper][variant % 4], 0.01), [-0.02, 2.2, 0.55], [0, 90, 0]);
      put(m, extrude(ngon(10, 0.09), 0.012, ROLE.metal), [0.02, 2.2, 0.55], [0, 90, 0]);
      for (const dz of [0.4, 0.7]) put(m, box(0.006, 0.05, 0.006, M), [0, 2.5, dz]);
      return asset(kind, m, 0.2, 0.75, 2.75);
    }
    case "milestone": {
      // borne kilométrique : pierre arrondie à tête peinte
      put(m, box(0.2, 0.3, 0.12, S, 0.03), [0, 0.3, 0]);
      put(m, cylinder(0.2, 0.2, 0.24, ROLE.accent, 10), [0, 0.6, -0.12], [90, 0, 0]);
      put(m, box(0.12, 0.08, 0.005, ROLE.paper), [0, 0.38, 0.122]);
      return asset(kind, m, 0.22, 0.14, 0.8);
    }
    case "puddle": {
      // flaque : plan d'eau irrégulier à fleur de sol
      const pts: [number, number][] = Array.from({ length: 14 }, (_, i) => {
        const a = (i / 14) * Math.PI * 2;
        const r = (0.75 + 0.14 * Math.sin(a * 2 + variant) + 0.07 * Math.cos(a * 3 + variant * 2)) * size;
        return [Math.cos(a) * r * 1.3, Math.sin(a) * r * 0.9] as [number, number];
      });
      const e = extrude(pts, 0.01, ROLE.water);
      put(m, e, [0, 0.01, 0], [-90, 0, 0]);
      return asset(kind, m, 1.2 * size, 0.9 * size, 0.03);
    }
  }
  return asset(kind, box(0.3, 0.3, 0.3, ROLE.accent), 0.3, 0.3, 0.6);
}

export const prop = defineGenerator({
  id: "prop",
  label: "Objet de décor",
  doc: `Objet de décor instanciable : ${PROPS.join(", ")}.`,
  tags: ["décor", "rue", "village", "mobilier"],
  schema: {
    kind: { type: "enum", default: "crate", options: PROPS, doc: "Objet" },
    size: { type: "number", default: 1, min: 0.3, max: 4, doc: "Échelle (caisse, tonneau, meule)" },
    variant: { type: "int", default: 0, min: 0, max: 7, doc: "Variante" },
  },
  build(p) {
    return build(p.kind, p.size, p.variant);
  },
});

/* ---------- blasons ---------- */

const SHIELDS: Record<string, [number, number][]> = {
  heater: [[-0.5, 0.6], [0.5, 0.6], [0.5, 0.05], [0.38, -0.32], [0, -0.6], [-0.38, -0.32], [-0.5, 0.05]],
  round: ngon(24, 0.55, Math.PI / 2),
  kite: [[0, 0.62], [0.42, 0.35], [0.36, -0.1], [0, -0.68], [-0.36, -0.1], [-0.42, 0.35]],
  banner: [[-0.4, 0.65], [0.4, 0.65], [0.4, -0.6], [0, -0.38], [-0.4, -0.6]],
  square: [[-0.5, 0.55], [0.5, 0.55], [0.5, -0.55], [-0.5, -0.55]],
};

/** Découpe d'un polygone par un demi-plan `a·x + b·y + c >= 0` (Sutherland–Hodgman). */
function clipHalf(poly: [number, number][], a: number, b: number, c: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const fp = a * p[0] + b * p[1] + c, fq = a * q[0] + b * q[1] + c;
    if (fp >= 0) out.push(p);
    if (fp >= 0 !== fq >= 0) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

const CHARGES = ["none", "star", "circle", "cross", "chevron", "tower", "tree", "crescent"] as const;

export const emblem = defineGenerator({
  id: "emblem",
  label: "Blason, insigne",
  doc: "Écu en relief (heater, round, kite, banner, square) : partition, bordure, meuble. Se pose sur un mur ou se présente de face (vue `front`).",
  tags: ["héraldique", "signalétique", "insigne", "logo"],
  schema: {
    shape: { type: "enum", default: "heater", options: Object.keys(SHIELDS), doc: "Forme de l'écu" },
    division: { type: "enum", default: "per-pale", options: ["plain", "per-pale", "per-fess", "per-bend", "quarterly", "chief"], doc: "Partition" },
    charge: { type: "enum", default: "star", options: CHARGES, doc: "Meuble central" },
    field: { type: "string", default: "accent", doc: "Rôle de la couleur principale" },
    tincture: { type: "string", default: "paper", doc: "Rôle de la seconde couleur" },
    metal: { type: "string", default: "metal", doc: "Rôle de la bordure et du meuble" },
    size: { type: "number", default: 1, min: 0.2, max: 6, unit: "m", doc: "Hauteur" },
  },
  build(p) {
    const roleOf = (r: string) => (ROLE as Record<string, number>)[r] ?? ROLE.accent;
    const shape = SHIELDS[p.shape];
    const m = new Mesh();
    const F = roleOf(p.field), T = roleOf(p.tincture), MT = roleOf(p.metal);
    m.append(extrude(shape, 0.06, MT, 0.02));
    const inner = shape.map(([x, y]) => [x * 0.88, y * 0.88 - 0.005] as [number, number]);
    const parts: [[number, number][], number][] = [];
    switch (p.division) {
      case "per-pale":
        parts.push([clipHalf(inner, -1, 0, 0), F], [clipHalf(inner, 1, 0, 0), T]);
        break;
      case "per-fess":
        parts.push([clipHalf(inner, 0, 1, 0), F], [clipHalf(inner, 0, -1, 0), T]);
        break;
      case "per-bend":
        parts.push([clipHalf(inner, -1, 1, 0), F], [clipHalf(inner, 1, -1, 0), T]);
        break;
      case "quarterly":
        for (const [sx, sy, r] of [[-1, 1, F], [1, 1, T], [-1, -1, T], [1, -1, F]] as const) parts.push([clipHalf(clipHalf(inner, sx, 0, 0), 0, sy, 0), r]);
        break;
      case "chief":
        parts.push([clipHalf(inner, 0, -1, 0.3), F], [clipHalf(inner, 0, 1, -0.3), T]);
        break;
      default:
        parts.push([inner, F]);
    }
    for (const [poly, r] of parts) if (poly.length >= 3) m.append(extrude(poly, 0.02, r, 0.004), m4Compose([0, 0, 0.06]));
    const charge = (): [number, number][] | null => {
      switch (p.charge) {
        case "star":
          return ngon(10, 0.24, Math.PI / 2).map((q, i) => (i % 2 ? [q[0] * 0.42, q[1] * 0.42] : q) as [number, number]);
        case "circle":
          return ngon(20, 0.18);
        case "cross":
          return [[-0.06, 0.28], [0.06, 0.28], [0.06, 0.06], [0.24, 0.06], [0.24, -0.06], [0.06, -0.06], [0.06, -0.3], [-0.06, -0.3], [-0.06, -0.06], [-0.24, -0.06], [-0.24, 0.06], [-0.06, 0.06]];
        case "chevron":
          return [[-0.34, -0.12], [0, 0.2], [0.34, -0.12], [0.34, -0.26], [0, 0.06], [-0.34, -0.26]];
        case "tower":
          return [[-0.16, -0.26], [0.16, -0.26], [0.16, 0.12], [0.2, 0.12], [0.2, 0.26], [0.1, 0.26], [0.1, 0.18], [0.03, 0.18], [0.03, 0.26], [-0.03, 0.26], [-0.03, 0.18], [-0.1, 0.18], [-0.1, 0.26], [-0.2, 0.26], [-0.2, 0.12], [-0.16, 0.12]];
        case "tree":
          return [[-0.03, -0.28], [0.03, -0.28], [0.03, -0.12], [0.2, -0.12], [0.08, 0.02], [0.15, 0.02], [0.05, 0.14], [0.1, 0.14], [0, 0.28], [-0.1, 0.14], [-0.05, 0.14], [-0.15, 0.02], [-0.08, 0.02], [-0.2, -0.12], [-0.03, -0.12]];
        case "crescent": {
          const a = ngon(20, 0.2).map(([x, y]) => [x, y] as [number, number]);
          return a.map(([x, y]) => [x - (x > 0 ? 0 : 0) , y] as [number, number]).map(([x, y]) => [x * (x > 0.05 ? 0.35 : 1), y] as [number, number]);
        }
      }
      return null;
    };
    const c = charge();
    if (c) m.append(extrude(c, 0.035, MT, 0.01), m4Compose([0, 0.02, 0.07]));
    const s = p.size;
    m.transform(m4Compose([0, s * 0.62, 0], qAxis([0, 1, 0], 0), s));
    return { generator: "emblem", mesh: m, anchors: {}, footprint: { hx: s * 0.55, hz: 0.1, r: s * 0.6 }, height: s * 1.25 };
  },
});
