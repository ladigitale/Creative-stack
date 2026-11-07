/**
 * Véhicules (`vehicle.*`) : carrosse, vélo, voiture ancienne, barque, voilier, montgolfière, charrette à bras.
 * Instanciables et sobres (≈ 300–1 200 triangles). Avant = +z, base au sol (ou à la ligne de flottaison) en y = 0.
 * `paint` choisit le rôle de la caisse ; `auto` le tire de la variante (deux voitures voisines diffèrent).
 */
import { type V3, DEG, m4Compose, mix, qEuler } from "../core/math";
import { Mesh } from "../geom/mesh";
import { box, cylinder, ellipsoid, extrude, lathe, tube } from "../geom/prims";
import { ROLE } from "../style/roles";
import { type Asset, defineGenerator } from "./types";

const KINDS = ["carriage", "bicycle", "car", "rowboat", "sailboat", "balloon", "handcart"] as const;
const PAINTS = ["auto", "accent", "cloth1", "cloth2", "leaf2", "water", "wood", "paper", "ink"] as const;

const put = (m: Mesh, part: Mesh, p: V3, rot?: [number, number, number]) => m.append(part, m4Compose(p, rot ? qEuler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG) : [0, 0, 0, 1]));

/** Roue à rayons, axe selon x : jante, moyeu, rayons diamétraux. */
function spokeWheel(r: number, spokes: number, role: number, tire = ROLE.ink): Mesh {
  const m = new Mesh();
  m.append(lathe([[r, -0.025], [r, 0.025], [r * 0.9, 0.025], [r * 0.9, -0.025], [r, -0.025]], tire, 16, false), m4Compose([0, 0, 0], qEuler(0, 0, Math.PI / 2)));
  m.append(cylinder(r * 0.13, r * 0.13, 0.12, role, 6), m4Compose([-0.06, 0, 0], qEuler(0, 0, -Math.PI / 2)));
  for (let k = 0; k < spokes / 2; k++) m.append(box(0.01, r * 0.9, 0.01, role), m4Compose([0, 0, 0], qEuler(((2 * k) / spokes) * Math.PI, 0, 0)));
  return m;
}

function build(kind: string, size: number, variant: number, paintName: string): Asset {
  const m = new Mesh();
  const autoPaint = [ROLE.accent, ROLE.leaf2, ROLE.water, ROLE.cloth2, ROLE.cloth1, ROLE.ink, ROLE.paper, ROLE.wood][variant % 8];
  const P = paintName === "auto" ? autoPaint : ((ROLE as Record<string, number>)[paintName] ?? ROLE.accent);
  const W = ROLE.wood, M = ROLE.metal;
  const asset = (hx: number, hz: number, h: number, anchors: Asset["anchors"] = {}): Asset => ({ generator: "vehicle", mesh: m, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: h, extra: { kind } });
  switch (kind) {
    case "carriage": {
      // carrosse : caisse galbée suspendue, portières vitrées, impériale, siège du cocher, grandes roues à rayons
      const body = lathe([[0.55, 0], [0.7, 0.35], [0.72, 0.8], [0.62, 1.15], [0, 1.2]], P, 4, true);
      body.mapPos((q) => [q[0] * 0.95, q[1], q[2] * 1.35]).computeNormals();
      put(m, body.facet(), [0, 0.75, -0.2], [0, 45, 0]);
      put(m, box(0.66, 0.06, 0.9, ROLE.ink), [0, 1.97, -0.2], [0, 0, 0]);
      put(m, box(0.55, 0.05, 0.75, M), [0, 2.05, -0.2]);
      for (const sx of [-1, 1]) {
        put(m, box(0.01, 0.25, 0.28, ROLE.glass), [sx * 0.7, 1.6, -0.2]);
        put(m, box(0.012, 0.3, 0.33, ROLE.metal), [sx * 0.695, 1.6, -0.2]);
        put(m, box(0.01, 0.025, 0.3, ROLE.accent === P ? ROLE.paper : ROLE.accent), [sx * 0.705, 1.2, -0.2]);
        put(m, spokeWheel(0.6, 12, W), [sx * 0.85, 0.6, -0.85]);
        put(m, spokeWheel(0.42, 10, W), [sx * 0.85, 0.42, 0.9]);
        // ressorts en C et brancards
        put(m, tube([[sx * 0.55, 0.85, -0.9], [sx * 0.6, 1.15, -0.95], [sx * 0.55, 1.0, -0.65]], [0.03, 0.03, 0.03], M, 4), [0, 0, 0]);
        put(m, box(0.03, 0.03, 1.1, W), [sx * 0.4, 0.75, 1.9], [-3, 0, 0]);
      }
      put(m, box(0.5, 0.04, 1.0, W), [0, 0.75, 0.2]);
      put(m, box(0.5, 0.04, 0.25, P), [0, 1.35, 0.9]);
      put(m, box(0.5, 0.25, 0.03, P), [0, 1.55, 0.68]);
      put(m, cylinder(0.04, 0.04, 0.12, ROLE.lamp, 6), [0.55, 1.45, 0.75]);
      put(m, cylinder(0.04, 0.04, 0.12, ROLE.lamp, 6), [-0.55, 1.45, 0.75]);
      return asset(1.0, 2.5, 2.1);
    }
    case "bicycle": {
      // bicyclette : deux roues, cadre en losange, guidon, selle, panier
      const fr = [ROLE.accent, ROLE.leaf2, ROLE.ink, ROLE.water][variant % 4];
      for (const z of [-0.52, 0.52]) put(m, spokeWheel(0.34, 12, M), [0, 0.34, z]);
      const bb: V3 = [0, 0.32, -0.05], seat: V3 = [0, 0.82, -0.22], head: V3 = [0, 0.8, 0.38];
      for (const [a, b] of [[bb, seat], [bb, head], [seat, head], [bb, [0, 0.34, -0.52]], [seat, [0, 0.34, -0.52]], [head, [0, 0.34, 0.52]]] as [V3, V3][])
        put(m, tube([a, b], [0.018, 0.018], fr, 4, false, false), [0, 0, 0]);
      put(m, box(0.06, 0.025, 0.12, ROLE.leather), [0, 0.86, -0.24]);
      put(m, tube([[-0.25, 0.92, 0.32], [0, 0.88, 0.4], [0.25, 0.92, 0.32]], [0.012, 0.012, 0.012], M, 4), [0, 0, 0]);
      put(m, tube([head, [0, 0.9, 0.36]], [0.015, 0.015], M, 4), [0, 0, 0]);
      if (variant % 2) put(m, lathe([[0.1, 0], [0.13, 0.18], [0.12, 0.18], [0.09, 0.02], [0, 0.02]], ROLE.path, 8, false), [0, 0.8, 0.52]);
      return asset(0.3, 0.9, 1.0);
    }
    case "car": {
      // voiture ancienne : capot long à calandre, ailes galbées, habitacle, roues à rayons, phares ronds
      put(m, box(0.55, 0.22, 1.7, P), [0, 0.62, 0]);
      put(m, box(0.42, 0.18, 0.62, P), [0, 0.82, 0.95]);
      put(m, box(0.3, 0.25, 0.04, M), [0, 0.8, 1.6]);
      for (let i = 0; i < 6; i++) put(m, box(0.008, 0.21, 0.015, ROLE.ink), [-0.25 + i * 0.1, 0.8, 1.63]);
      // habitacle : montants, pare-brise, capote
      put(m, box(0.5, 0.012, 0.25, ROLE.glass), [0, 1.12, 0.33], [70, 0, 0]);
      const hood = lathe([[0.62, 0], [0.6, 0.25], [0.45, 0.42], [0, 0.45]], variant % 2 ? ROLE.ink : ROLE.cloth3, 4, true);
      hood.mapPos((q) => [q[0] * 0.85, q[1], q[2] * 1.05]).computeNormals();
      put(m, hood.facet(), [0, 0.85, -0.45], [0, 45, 0]);
      put(m, box(0.5, 0.1, 0.25, ROLE.leather), [0, 0.92, -0.05]);
      for (const sx of [-1, 1]) {
        // ailes avant et arrière, marchepied
        const wing = tube([[sx * 0.62, 0.55, 1.45], [sx * 0.66, 0.78, 1.15], [sx * 0.66, 0.78, 0.75], [sx * 0.62, 0.45, 0.45]], [0.13, 0.15, 0.15, 0.1], P, 6);
        put(m, wing, [0, 0, 0]);
        put(m, tube([[sx * 0.62, 0.45, -0.75], [sx * 0.66, 0.78, -1.0], [sx * 0.66, 0.78, -1.35], [sx * 0.62, 0.5, -1.6]], [0.1, 0.15, 0.15, 0.12], P, 6), [0, 0, 0]);
        put(m, box(0.12, 0.02, 0.6, ROLE.ink), [sx * 0.66, 0.42, -0.15]);
        put(m, spokeWheel(0.34, 12, ROLE.paper), [sx * 0.66, 0.34, 1.05]);
        put(m, spokeWheel(0.34, 12, ROLE.paper), [sx * 0.66, 0.34, -1.15]);
        put(m, lathe([[0, 0.06], [0.1, 0.03], [0.1, -0.06]], M, 8), [sx * 0.42, 0.98, 1.55], [90, 0, 0]);
        put(m, cylinder(0.08, 0.08, 0.01, ROLE.lamp, 8), [sx * 0.42, 0.98, 1.62], [90, 0, 0]);
      }
      put(m, tube([[0, 1.0, 0.3], [0.08, 1.04, 0.15]], [0.015, 0.015], ROLE.ink, 4), [0, 0, 0]);
      put(m, cylinder(0.12, 0.12, 0.015, ROLE.ink, 10), [0.08, 1.05, 0.15], [60, 0, 0]);
      put(m, box(0.4, 0.06, 0.06, M), [0, 0.45, 1.72]);
      put(m, box(0.35, 0.18, 0.2, ROLE.leather), [0, 0.88, -1.8]);
      return asset(0.82, 1.9, 1.4);
    }
    case "rowboat": {
      // barque : coque en bordages (lignes), bancs, avirons, flotte (y = 0,15 = flottaison)
      const hull = lathe([[0, 0], [0.42, 0.04], [0.62, 0.3], [0.68, 0.5]], P === ROLE.ink ? W : P, 12, false);
      hull.mapPos((q) => [q[0] * 0.8, q[1], q[2] * 2.3 * (q[2] > 0 ? 1.08 : 0.95)]);
      hull.mapPos((q) => [q[0], q[1] + (q[2] / 1.6) ** 2 * 0.15, q[2]]).computeNormals();
      put(m, hull, [0, 0, 0]);
      for (let k = 1; k < 3; k++) {
        const r = mix(0.42, 0.66, k / 3);
        const strake = lathe([[r + 0.012, 0], [r + 0.012, 0.02]], W, 12, false);
        strake.mapPos((q) => [q[0] * 0.8, q[1] + 0.04 + (k / 3) * 0.42 + (q[2] * 2.3 / 1.6) ** 2 * 0.15, q[2] * 2.3]);
        put(m, strake, [0, 0, 0]);
      }
      put(m, box(0.5, 0.03, 0.11, W), [0, 0.36, 0.35]);
      put(m, box(0.47, 0.03, 0.11, W), [0, 0.36, -0.55]);
      for (const sx of [-1, 1]) {
        put(m, tube([[sx * 0.45, 0.48, 0.1], [sx * 1.1, 0.2, -0.3], [sx * 1.4, 0.05, -0.45]], [0.02, 0.02, 0.02], W, 4), [0, 0, 0]);
        put(m, box(0.06, 0.012, 0.16, W), [sx * 1.45, 0.05, -0.48], [0, sx * 25, 0]);
      }
      return asset(0.8, 1.7, 0.7);
    }
    case "sailboat": {
      // voilier : coque à quille, pont, rouf, mât, bôme, grand-voile et foc triangulaires
      const hull = lathe([[0, -0.2], [0.55, -0.05], [0.85, 0.3], [0.9, 0.55]], P === ROLE.ink || P === ROLE.wood ? ROLE.paper : P, 12, false);
      hull.mapPos((q) => [q[0] * 0.9, q[1], q[2] * 2.8 * (q[2] > 0 ? 1.15 : 0.9)]);
      hull.mapPos((q) => [q[0], q[1] + Math.max(0, q[2] / 2.5) ** 2 * 0.25, q[2]]).computeNormals();
      put(m, hull, [0, 0, 0]);
      put(m, box(0.7, 0.025, 1.9, W), [0, 0.5, -0.2]);
      put(m, box(0.4, 0.18, 0.6, ROLE.paper), [0, 0.68, -0.2]);
      for (const sx of [-1, 1]) put(m, box(0.005, 0.06, 0.15, ROLE.glass), [sx * 0.405, 0.7, -0.2]);
      put(m, cylinder(0.04, 0.03, 5.5, W, 6), [0, 0.5, 0.35]);
      put(m, box(0.03, 0.03, 1.3, W), [0, 1.2, -0.3]);
      const sail = (pts: [number, number][], x: number, role: number) => put(m, extrude(pts, 0.02, role), [x, 0, 0], [0, 90, 0]);
      sail([[0.3, 1.25], [-0.9, 1.25], [0.3, 5.7]], 0, ROLE.paper);
      sail([[0.45, 0.6], [2.3, 0.65], [0.45, 5.4]], 0.02, variant % 2 ? ROLE.paper : ROLE.cloth3);
      put(m, tube([[0, 5.9, 0.35], [0, 0.55, 2.4]], [0.006, 0.006], ROLE.ink, 3, false, false), [0, 0, 0]);
      put(m, extrude([[0, 0], [0.4, -0.1], [0, -0.22]], 0.01, ROLE.accent), [0, 5.95, 0.35], [0, 90, 0]);
      put(m, box(0.03, 0.4, 0.25, W), [0, -0.1, -2.3]);
      return asset(0.9, 2.6, 6.0);
    }
    case "balloon": {
      // montgolfière : enveloppe à fuseaux alternés, suspentes, nacelle d'osier, brûleur (lampe)
      const R = 3 * size;
      const env = lathe([[0.55, 0], [1.4, 0.9], [2.6, 2.4], [3.0, 3.6], [2.7, 4.8], [1.8, 5.6], [0, 6.0]].map(([r, y]) => [(r / 3) * R, (y / 3) * R] as [number, number]), P, 16);
      const c2 = P === ROLE.paper ? ROLE.accent : ROLE.paper;
      for (let i = 0; i < env.vertexCount; i++) {
        const q = env.getPos(i);
        const a = Math.atan2(q[2], q[0]);
        if (Math.floor(((a + Math.PI) / (Math.PI * 2)) * 16 + 0.001) % 2) env.role[i] = c2;
      }
      put(m, env.facet(), [0, 2.6, 0]);
      put(m, lathe([[0.42, 0], [0.45, 0.7], [0.47, 0.72], [0, 0.72]], ROLE.path, 8), [0, 0, 0]);
      put(m, lathe([[0.48, -0.03], [0.48, 0.03]], ROLE.leather, 8, false), [0, 0.72, 0]);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        put(m, tube([[Math.cos(a) * 0.42, 0.72, Math.sin(a) * 0.42], [Math.cos(a) * 0.55 * (R / 3), 2.6, Math.sin(a) * 0.55 * (R / 3)]], [0.008, 0.008], ROLE.ink, 3, false, false), [0, 0, 0]);
      }
      put(m, cylinder(0.12, 0.12, 0.2, M, 6), [0, 1.6, 0]);
      put(m, ellipsoid(0.1, 0.18, 0.1, ROLE.fire, 6, 4), [0, 1.95, 0]);
      return asset(R * 0.4, R * 0.4, 2.6 + 2 * R, { light: { pos: [0, 2.0, 0], rot: [0, 0, 0, 1], scale: 1 } });
    }
    case "handcart": {
      // charrette à bras : plateau à ridelles, deux roues, brancards
      put(m, box(0.55, 0.03, 0.75, W), [0, 0.55, 0]);
      for (const sx of [-1, 1]) {
        for (const y of [0.68, 0.8]) put(m, box(0.015, 0.03, 0.75, W), [sx * 0.55, y, 0]);
        for (const z of [-0.6, 0, 0.6]) put(m, box(0.02, 0.15, 0.02, W), [sx * 0.55, 0.68, z]);
        put(m, spokeWheel(0.45, 8, W, W), [sx * 0.66, 0.45, -0.1]);
        put(m, box(0.025, 0.025, 0.7, W), [sx * 0.42, 0.62, 1.2], [8, 0, 0]);
      }
      put(m, box(0.42, 0.015, 0.015, W), [0, 0.53, 1.85]);
      for (let k = 0; k < 4; k++) put(m, lathe([[0.18, 0], [0.22, 0.28], [0.17, 0.33], [0, 0.34]], ROLE.cloth3, 7), [(k % 2 ? 0.2 : -0.2), 0.58, -0.4 + Math.floor(k / 2) * 0.5]);
      return asset(0.75, 1.9, 1.0);
    }
  }
  return asset(0.3, 0.3, 0.3);
}

export const vehicle = defineGenerator({
  id: "vehicle",
  label: "Véhicule",
  doc: "Véhicule instanciable : carriage (carrosse), bicycle (vélo), car (voiture ancienne), rowboat (barque), sailboat (voilier), balloon (montgolfière), handcart (charrette à bras). Barque et voilier : couche `onWater`. Couleur de caisse : paint (auto = selon la variante).",
  tags: ["véhicule", "transport", "rue", "port", "décor"],
  schema: {
    kind: { type: "enum", default: "car", options: KINDS, doc: "Véhicule" },
    paint: { type: "enum", default: "auto", options: PAINTS, doc: "Rôle de couleur de la caisse" },
    size: { type: "number", default: 1, min: 0.5, max: 3, doc: "Échelle (montgolfière : taille de l'enveloppe)" },
    variant: { type: "int", default: -1, min: -1, max: 7, doc: "Variante (couleur, accessoires)" },
  },
  build(p, ctx) {
    const variant = p.variant >= 0 ? p.variant : ctx.rng.int(0, 7);
    return build(p.kind, p.size, variant, p.paint);
  },
});
