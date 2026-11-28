/**
 * Lave sur la grammaire de pièces (même modèle en 3D et en vectoriel) : lac de lave (croûte sombre en plaques qui
 * dérivent, fissures incandescentes : nappe du rôle `fire`, animée par le shader), coulée (langue de lave entre deux
 * bourrelets de roche refroidie), volcan (cône de scories, cratère, lac de lave au sommet, coulées sur le flanc).
 */
import { type Q, type V3, clamp, mix } from "../core/math";
import { type Part, type PartList, partsBounds, partsToMesh, roleParam } from "./parts";
import { type Anchor, defineGenerator } from "./types";

export const LAVA_KINDS = ["pool", "flow", "volcano"] as const;

const hash = (s: number, k: number) => ((Math.sin(s * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
const flat = (y: number, pts: [number, number][], d: number, role: Part["role"]): Part => ({ t: "plate", c: [0, y - d, 0], pts: pts.map(([x, z]) => [x, -z] as [number, number]), d, rot: [-90, 0, 0], role });
const ellipse = (rx: number, rz: number, n: number, seed: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.08 * Math.sin(a * 3 + seed) + 0.05 * Math.sin(a * 5 + seed * 2);
    return [Math.cos(a) * rx * k, Math.sin(a) * rz * k] as [number, number];
  });

type Built = { parts: PartList; anchors: Record<string, V3>; label: string };

export function lavaModel(p: Record<string, unknown>): Built & { kind: string } {
  const kind = (LAVA_KINDS as readonly string[]).includes(String(p.kind)) ? String(p.kind) : "pool";
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  const L = clamp(num(p.length, kind === "volcano" ? 14 : kind === "flow" ? 10 : 5), 1, 60);
  const W = clamp(num(p.width, kind === "flow" ? 2.4 : L * 0.8), 0.8, 60);
  const H = clamp(num(p.height, kind === "volcano" ? L * 0.45 : 0.3), 0.1, 40);
  const rock = roleParam(p.color, "stone");
  const lava = roleParam(p.color2, "fire");
  const seed = Number(p.variant ?? 0) * 1.7 + 0.3;
  const P: PartList = [];
  if (kind === "pool") {
    // cuvette de roche refroidie, nappe incandescente, quelques blocs de croûte qui flottent
    P.push(flat(0.12, ellipse(L / 2, W / 2, 28, seed), 0.03, lava));
    const n = Math.max(10, Math.round(((L + W) * Math.PI) / 1.1));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 0.35 + hash(seed, i) * 0.35;
      P.push({ t: "blob", c: [Math.cos(a) * L * 0.52, r * 0.45, Math.sin(a) * W * 0.52], r: [r * 1.4, r * 0.75, r * 1.2], role: rock });
    }
    for (let i = 0; i < 5; i++) P.push({ t: "blob", c: [(hash(seed, i + 30) - 0.5) * L * 0.5, 0.13, (hash(seed, i + 40) - 0.5) * W * 0.5], r: [0.35, 0.05, 0.28], role: rock });
    return { kind, parts: P, anchors: { center: [0, 0.15, 0], top: [0, 0.4, 0] }, label: "Lac de lave" };
  }
  if (kind === "flow") {
    // langue de lave selon z, qui s'élargit vers l'aval ; bourrelets de scories de chaque côté
    const segs = Math.max(4, Math.round(L / 1.5));
    for (let k = 0; k < segs; k++) {
      const t = k / (segs - 1);
      const z = (t - 0.5) * L;
      const w = (W / 2) * mix(0.7, 1.15, t) * (1 + 0.12 * Math.sin(k * 1.7 + seed));
      P.push(flat(0.1, ellipse(w, (L / segs) * 0.75, 14, seed + k).map(([x, zz]) => [x, zz + z] as [number, number]), 0.03, lava));
      for (const sx of [-1, 1]) P.push({ t: "blob", c: [sx * (w + 0.2), 0.22, z], r: [0.45, 0.3, (L / segs) * 0.7], role: rock });
    }
    P.push({ t: "blob", c: [0, 0.18, L / 2 + 0.3], r: [W * 0.6, 0.25, 0.6], role: rock });
    return { kind, parts: P, anchors: { center: [0, 0.12, 0], top: [0, 0.4, -L / 2], end: [0, 0.2, L / 2] }, label: "Coulée de lave" };
  }
  // volcan : cône de scories à pente concave, cratère, lac de lave au sommet, deux coulées sur le flanc avant
  const R = L / 2, rc = R * 0.22;
  P.push({ t: "lathe", c: [0, 0, 0], profile: [[R, 0], [R * 0.72, H * 0.22], [R * 0.48, H * 0.55], [rc * 1.25, H * 0.96], [rc, H], [rc * 0.85, H * 0.93], [rc * 0.6, H * 0.86]], role: rock });
  P.push(flat(H * 0.88, ellipse(rc * 0.78, rc * 0.78, 16, seed), 0.02, lava));
  for (const [i, ang] of [[0, 0.25], [1, -0.4]] as const) {
    // coulée : bande sur le flanc, du cratère vers le pied
    const s = Math.sin(ang), c = Math.cos(ang);
    const steps = 6;
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps, t1 = (k + 1) / steps;
      const r0 = mix(rc * 1.05, R * 0.95, t0), r1 = mix(rc * 1.05, R * 0.95, t1);
      const y0 = mix(H * 0.96, 0.05, Math.pow(t0, 0.75)), y1 = mix(H * 0.96, 0.05, Math.pow(t1, 0.75));
      const w = mix(0.25, 0.7, t1) * (1 + 0.2 * Math.sin(k + i * 3));
      const a: V3 = [s * r0, y0 + 0.06, c * r0], b: V3 = [s * r1, y1 + 0.06, c * r1];
      P.push({ t: "rod", a, b, r: w * 0.5, r1: w * 0.55, role: lava });
    }
  }
  return { kind, parts: P, anchors: { center: [0, H * 0.9, 0], top: [0, H, 0], vent: [0, H * 0.9, 0], crater: [0, H * 0.88, 0] }, label: "Volcan" };
}

export const lava = defineGenerator({
  id: "lava",
  label: "Lave (lac, coulée, volcan)",
  doc:
    "Lave sur la grammaire de pièces (même modèle en 3D et en vectoriel) : pool (lac de lave dans une cuvette de roche refroidie, croûte en plaques qui dérivent et fissures incandescentes, animées), flow (coulée selon z qui s'élargit vers l'aval, bourrelets de scories), volcano (cône de scories, cratère et lac de lave au sommet, coulées sur le flanc). `length` × `width` (m), `height` (volcan). Ancres : center, top, vent / crater (volcan : fumée et braises par `layers[].fx` `{preset: \"smoke\", anchor: \"vent\"}`), end (bout de la coulée). La lave ne se traverse pas.",
  tags: ["nature", "volcan", "lave", "feu", "danger"],
  schema: {
    kind: { type: "enum", default: "pool", options: LAVA_KINDS, doc: "Forme" },
    length: { type: "number", default: 0, min: 0, max: 60, unit: "m", doc: "Longueur (diamètre du volcan) ; 0 = défaut" },
    width: { type: "number", default: 0, min: 0, max: 60, unit: "m", doc: "Largeur ; 0 = défaut" },
    height: { type: "number", default: 0, min: 0, max: 40, unit: "m", doc: "Hauteur du volcan ; 0 = défaut" },
    variant: { type: "int", default: 0, min: 0, max: 7, doc: "Variante (contours)" },
    color: { type: "string", default: "auto", doc: "Rôle de la roche" },
    color2: { type: "string", default: "auto", doc: "Rôle de la lave (fire : incandescente)" },
  },
  build(p) {
    const m = lavaModel(p);
    const mesh = partsToMesh(m.parts, 0.85);
    const bb = partsBounds(m.parts);
    const hx = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), 0.2);
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]), 0.2);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = {};
    for (const [k, v] of Object.entries(m.anchors)) anchors[k] = { pos: v, rot, scale: 1 };
    return { generator: "lava", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: Math.max(0.1, bb.max[1]), extra: { label: m.label, kind: m.kind, affords: ["look"] } };
  },
});
