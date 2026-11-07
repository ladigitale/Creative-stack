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

const PROPS = ["lamp", "bench", "crate", "barrel", "well", "campfire", "tent", "cart", "stall", "signpost", "lantern", "fence", "haystack", "bollard", "planter", "statue", "mailbox", "boat"] as const;
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
