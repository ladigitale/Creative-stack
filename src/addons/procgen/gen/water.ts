/**
 * Points d'eau (`water`, raccourci `water.<kind>`) : mare naturelle, bassin maçonné (rond ou rectangulaire), piscine,
 * cascade sur rochers avec sa vasque. Sur la grammaire de pièces : même modèle en 3D et en vectoriel.
 *
 * L'eau est une surface posée **au-dessus** du sol de la scène (le terrain n'est pas creusé) : une piscine affleure,
 * un bassin a une margelle haute. Ancres `spot.N` (bord de l'eau, à son niveau : là où l'on boit) et `approach.N`
 * (au sol, devant la margelle) : `{target: "bassin.0.spot.1", action: "drink"}` y mène un chien ou un cheval.
 */
import { type Q, type V3, clamp, mix } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, hull2, partsBounds, partsToMesh, roleParam, transformParts } from "./parts";
import { type Anchor, defineGenerator } from "./types";

export const WATER_KINDS = ["pond", "basin", "pool", "cascade"] as const;

type O = { kind: string; shape: "round" | "rect"; L: number; W: number; level: number; rimH: number; rim: number; H: number; main: Role; trim: Role; water: Role; seed: number };
type Built = { parts: PartList; spots: { spot: V3; approach: V3 }[]; center: V3; affords: string[] };

const bx = (c: V3, h: V3, role: Role, rot?: V3): Part => ({ t: "box", c, h, role, rot });
/** Plaque horizontale (nappe d'eau, dalle) : polygone convexe [x, z] à la hauteur y, épaisseur 2·d. */
const flat = (y: number, pts: [number, number][], d: number, role: Role): Part => ({ t: "plate", c: [0, y - d, 0], pts: pts.map(([x, z]) => [x, -z] as [number, number]), d, rot: [-90, 0, 0], role });
const ellipse = (rx: number, rz: number, n = 24, wob?: (a: number) => number): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const k = wob ? wob(a) : 1;
    return [Math.cos(a) * rx * k, Math.sin(a) * rz * k] as [number, number];
  });
const hash = (s: number, k: number) => ((Math.sin(s * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;

/** Quatre points de boisson autour d'une nappe elliptique (avant +z, droite, arrière, gauche). */
function ringSpots(rx: number, rz: number, wy: number, out: number): Built["spots"] {
  return [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ].map(([x, z]) => ({ spot: [x * rx * 0.96, wy, z * rz * 0.96] as V3, approach: [x * (rx + out), 0, z * (rz + out)] as V3 }));
}

function pond(o: O): Built {
  const rx = o.L / 2, rz = o.W / 2;
  const wy = Math.max(0.03, o.rimH - o.level);
  const wob = (a: number) => 1 + 0.06 * Math.sin(a * 3 + o.seed) + 0.04 * Math.sin(a * 5 + o.seed * 2);
  const P: PartList = [];
  // berge de terre, nappe, pierres et galets en couronne
  P.push(flat(0.02, hull2(ellipse(rx + 0.35, rz + 0.35, 24, wob)), 0.01, "path"));
  P.push(flat(wy, hull2(ellipse(rx, rz, 28, wob)), 0.015, o.water));
  const n = Math.max(8, Math.round(((rx + rz) * Math.PI) / 0.7));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + hash(o.seed, i) * 0.3;
    if (hash(o.seed, i + 50) < 0.25) continue;
    const s = mix(0.12, 0.28, hash(o.seed, i + 100));
    const k = wob(a);
    P.push({ t: "blob", c: [Math.cos(a) * (rx * k + s * 0.3), s * 0.35, Math.sin(a) * (rz * k + s * 0.3)], r: [s, s * 0.6, s * 0.85], role: hash(o.seed, i + 7) < 0.3 ? "leaf2" : o.main });
  }
  return { parts: P, spots: ringSpots(rx, rz, wy, 0.5), center: [0, wy, 0], affords: ["drink", "fish", "bathe"] };
}

function basin(o: O): Built {
  const P: PartList = [];
  const h = o.rimH, t = o.rim;
  const wy = Math.max(0.05, h - o.level);
  if (o.shape === "round") {
    const R = o.L / 2;
    // mur en couronne de pierres (segments : l'eau se voit entre le bord proche et le bord lointain), margelle, eau
    const n = clamp(Math.round((R * Math.PI * 2) / 0.45), 12, 40);
    const half = (Math.PI * (R - t / 2)) / n + 0.01;
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const yaw = (-a * 180) / Math.PI + 90;
      P.push(bx([c * (R - t / 2), (h - 0.06) / 2, sn * (R - t / 2)], [t / 2, (h - 0.06) / 2, half], o.main, [0, yaw - 90, 0]));
      P.push(bx([c * (R - t / 2 + 0.02), h - 0.03, sn * (R - t / 2 + 0.02)], [t / 2 + 0.05, 0.03, half + 0.012], o.trim, [0, yaw - 90, 0]));
    }
    P.push(flat(wy, ellipse(R - t + 0.02, R - t + 0.02, n), 0.02, o.water));
    return { parts: P, spots: ringSpots(R - t, R - t, wy, t + 0.45), center: [0, wy, 0], affords: ["drink", "bathe"] };
  }
  const hx = o.L / 2, hz = o.W / 2;
  for (const s of [-1, 1]) {
    P.push(bx([0, h / 2, s * (hz - t / 2)], [hx, h / 2, t / 2], o.main), bx([s * (hx - t / 2), h / 2, 0], [t / 2, h / 2, hz - t], o.main));
    P.push(bx([0, h + 0.03, s * (hz - t / 2)], [hx + 0.04, 0.03, t / 2 + 0.04], o.trim), bx([s * (hx - t / 2), h + 0.03, 0], [t / 2 + 0.04, 0.03, hz - t], o.trim));
  }
  P.push(bx([0, wy - 0.02, 0], [hx - t, 0.02, hz - t], o.water));
  return { parts: P, spots: ringSpots(hx - t, hz - t, wy, t + 0.45), center: [0, wy, 0], affords: ["drink", "bathe"] };
}

function pool(o: O): Built {
  const P: PartList = [];
  const hx = o.L / 2, hz = o.W / 2, t = o.rim, h = o.rimH;
  const wy = Math.max(0.03, h - o.level);
  // margelle en dalles (bandes alternées), frise de carreaux sous la margelle, eau, échelle
  const n = Math.max(2, Math.round((2 * hx) / 0.6));
  for (const s of [-1, 1]) {
    for (let i = 0; i < n; i++) P.push(bx([-hx + ((i + 0.5) * 2 * hx) / n, h / 2, s * (hz + t / 2)], [hx / n - 0.008, h / 2, t / 2], i % 2 ? o.main : o.trim));
    P.push(bx([s * (hx + t / 2), h / 2, 0], [t / 2, h / 2, hz + t], o.main));
    P.push(bx([0, wy + 0.025, s * (hz - 0.01)], [hx, 0.03, 0.012], "blue"), bx([s * (hx - 0.01), wy + 0.025, 0], [0.012, 0.03, hz], "blue"));
  }
  P.push(bx([0, wy - 0.02, 0], [hx, 0.02, hz], o.water));
  for (const dx of [-0.22, 0.22]) P.push({ t: "tube", pts: [[hx - 0.9 + dx, wy - 0.2, hz - 0.12], [hx - 0.9 + dx, h + 0.55, hz - 0.12], [hx - 0.9 + dx, h + 0.7, hz + 0.1], [hx - 0.9 + dx, h, hz + 0.28]], r: 0.02, role: "metal" });
  return { parts: P, spots: ringSpots(hx, hz, wy, t + 0.4), center: [0, wy, 0], affords: ["swim", "bathe", "dive", "drink"] };
}

function cascade(o: O): Built {
  // cascade : vasque au pied (+z), amas de rochers en gradins derrière (−z), lames d'eau entre les gradins, écume
  const P: PartList = [];
  const R = o.L / 2;
  const H = o.H;
  const base = pond({ ...o, L: o.L, W: o.W * 0.8, rimH: 0.1, level: 0.04 });
  P.push(...base.parts);
  const tiers = clamp(Math.round(H / 0.6), 1, 5);
  const back = -o.W * 0.4 - 0.4;
  let lipY = 0.05, lipZ = -o.W * 0.32;
  for (let k = 0; k < tiers; k++) {
    const y = ((k + 1) * H) / tiers;
    const z = back - k * 0.55;
    const w = R * mix(0.75, 0.45, k / Math.max(1, tiers - 1));
    // rochers du gradin (masse de gauche, de droite, seuil)
    for (const sx of [-1, 1]) P.push({ t: "blob", c: [sx * w * 0.75, y * 0.55, z], r: [w * 0.55, y * 0.62, 0.7], role: o.main });
    P.push({ t: "blob", c: [0, y - 0.2, z - 0.2], r: [w * 0.5, 0.32, 0.6], role: o.main });
    // petite vasque du gradin, lame d'eau qui tombe sur le gradin inférieur, écume au pied
    const ww = Math.max(0.25, w * 0.32);
    P.push(flat(y + 0.1, ellipse(ww * 1.2, 0.35, 12).map(([x, zz]) => [x, zz + z - 0.15] as [number, number]), 0.01, o.water));
    P.push({ t: "plate", c: [0, 0, z + 0.32], pts: [[-ww, lipY], [ww, lipY], [ww * 0.92, y + 0.1], [-ww * 0.92, y + 0.1]], d: 0.025, rot: [-8, 0, 0], role: o.water });
    for (let i = -1; i <= 1; i++) P.push({ t: "blob", c: [i * ww * 0.6, lipY + 0.04, lipZ + 0.1], r: [ww * 0.45, 0.07, 0.16], role: "white" });
    lipY = y + 0.1;
    lipZ = z + 0.2;
  }
  return { parts: P, spots: base.spots.filter((_, i) => i !== 2), center: [0, 0.06, 0], affords: ["drink", "bathe", "fish"] };
}

export type WaterModel = Built & { label: string; kind: string; scale: number };

const LABELS: Record<string, string> = { pond: "Mare", basin: "Bassin", pool: "Piscine", cascade: "Cascade" };

export function waterModel(p: Record<string, unknown>): WaterModel {
  const kind = (WATER_KINDS as readonly string[]).includes(String(p.kind)) ? String(p.kind) : "pond";
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  const shapeIn = String(p.shape ?? "auto");
  const shape = shapeIn === "round" || shapeIn === "rect" ? shapeIn : kind === "pool" ? "rect" : "round";
  const dL = kind === "pool" ? 8 : kind === "basin" ? 2.4 : kind === "cascade" ? 3 : 4;
  const dW = kind === "pool" ? 4 : kind === "basin" ? (shape === "round" ? dL : 1.6) : kind === "cascade" ? 2.4 : 3;
  const rimH = kind === "basin" ? 0.45 : kind === "pool" ? 0.14 : 0.08;
  const L = clamp(num(p.length, dL), 0.6, 40);
  const o: O = {
    kind,
    shape,
    L,
    W: shape === "round" && kind === "basin" ? L : clamp(num(p.width, dW), 0.6, 40),
    level: clamp(typeof p.level === "number" && p.level >= 0 ? p.level : kind === "basin" ? 0.12 : kind === "pool" ? 0.08 : 0.04, 0, 2),
    rimH: clamp(typeof p.rimHeight === "number" && p.rimHeight > 0 ? p.rimHeight : rimH, 0.05, 1.5),
    rim: clamp(typeof p.rim === "number" && p.rim > 0 ? p.rim : kind === "pool" ? 0.35 : 0.25, 0.08, 1.2),
    H: clamp(num(p.height, 1.6), 0.4, 6),
    main: roleParam(p.color, kind === "pool" ? "paper" : "stone"),
    trim: roleParam(p.color2, kind === "pool" ? "white" : "trim"),
    water: roleParam(p.color3, "water"),
    seed: Number(p.variant ?? 0) * 1.7 + 0.3,
  };
  const b = kind === "pond" ? pond(o) : kind === "basin" ? basin(o) : kind === "pool" ? pool(o) : cascade(o);
  const s = clamp(Number(p.scale ?? 1) || 1, 0.2, 5);
  if (s === 1) return { ...b, label: LABELS[kind], kind, scale: 1 };
  const S = (v: V3): V3 => [v[0] * s, v[1] * s, v[2] * s];
  return { parts: transformParts(b.parts, [0, 0, 0, 1], [0, 0, 0], s), spots: b.spots.map((q) => ({ spot: S(q.spot), approach: S(q.approach) })), center: S(b.center), affords: b.affords, label: LABELS[kind], kind, scale: s };
}

export const water = defineGenerator({
  id: "water",
  label: "Point d'eau (mare, bassin, piscine, cascade)",
  doc:
    "Points d'eau sur la grammaire de pièces (même modèle en 3D et en vectoriel) : pond (mare naturelle, berge et pierres), basin (bassin maçonné à margelle, `shape` round ou rect), pool (piscine affleurante, margelle de dalles, frise, échelle), cascade (rochers en gradins, lames d'eau, écume, vasque au pied). `length` × `width` (m), `level` (eau sous le haut de la margelle, m), `rimHeight` (hauteur de la margelle), `rim` (largeur de la margelle), `height` (cascade). L'eau est posée sur le sol (le terrain n'est pas creusé). Ancres `spot.0`…`spot.3` (bord de l'eau, à son niveau : avant, droite, arrière, gauche ; `spot` = `spot.0`) et `approach.N` (au sol devant) : `{target: \"<id>.spot.1\", action: \"drink\"}` y fait boire un animal ou un personnage ; `center`. `extra.affords` : drink, bathe, swim, fish, dive.",
  tags: ["eau", "jardin", "parc", "ferme", "animal", "piscine", "fontaine", "nature"],
  schema: {
    kind: { type: "enum", default: "pond", options: WATER_KINDS, doc: "Point d'eau" },
    shape: { type: "enum", default: "auto", options: ["auto", "round", "rect"], doc: "Forme du bassin (auto : piscine rectangulaire, le reste rond)" },
    length: { type: "number", default: 0, min: 0, max: 40, unit: "m", doc: "Longueur selon x (diamètre d'un bassin rond) ; 0 = défaut" },
    width: { type: "number", default: 0, min: 0, max: 40, unit: "m", doc: "Largeur selon z ; 0 = défaut" },
    level: { type: "number", default: -1, min: -1, max: 2, unit: "m", doc: "Niveau de l'eau sous le haut de la margelle (−1 = défaut)" },
    rimHeight: { type: "number", default: 0, min: 0, max: 1.5, unit: "m", doc: "Hauteur de la margelle au-dessus du sol (0 = défaut : bassin 0,45, piscine 0,14)" },
    rim: { type: "number", default: 0, min: 0, max: 1.2, unit: "m", doc: "Largeur de la margelle (0 = défaut)" },
    height: { type: "number", default: 1.6, min: 0.4, max: 6, unit: "m", doc: "Hauteur de la cascade" },
    variant: { type: "int", default: -1, min: -1, max: 7, doc: "Variante (contour de la mare, pierres)" },
    scale: { type: "number", default: 1, min: 0.2, max: 5, doc: "Échelle" },
    color: { type: "string", default: "auto", doc: "Rôle de la maçonnerie, des rochers" },
    color2: { type: "string", default: "auto", doc: "Rôle de la margelle" },
    color3: { type: "string", default: "auto", doc: "Rôle de l'eau" },
  },
  build(p) {
    const m = waterModel(p);
    const mesh = partsToMesh(m.parts, 0.85);
    const bb = partsBounds(m.parts);
    const hx = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), 0.1);
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]), 0.1);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = { top: { pos: [0, bb.max[1], 0], rot, scale: m.scale }, center: { pos: m.center, rot, scale: m.scale } };
    m.spots.forEach((q, i) => {
      anchors[`spot.${i}`] = { pos: q.spot, rot, scale: m.scale };
      anchors[`approach.${i}`] = { pos: q.approach, rot, scale: m.scale };
    });
    if (m.spots.length) {
      anchors.spot = anchors["spot.0"];
      anchors.approach = anchors["approach.0"];
    }
    return { generator: "water", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: Math.max(0.05, bb.max[1]), extra: { affords: m.affords, label: m.label, kind: m.kind } };
  },
});
