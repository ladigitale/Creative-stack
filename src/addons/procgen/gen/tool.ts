/**
 * Outils à main (`tool`, raccourci `tool.<kind>`) : manche + tête + prise, à taille réelle, par la grammaire de pièces
 * (même modèle en 3D et en vectoriel). Posés au sol (`pose: lying`), appuyés (`leaning`) ou plantés (`upright`), ou
 * **tenus** par un personnage (`character.item: "tool.<kind>"`) avec l'action qui va avec (`hammer`, `sweep`, `dig`).
 *
 * Modèle de référence : manche selon +y depuis l'extrémité basse (y = 0), prise principale à `grip` (m), tête dans le
 * plan x–y (x = côté de la tête), épaisseur selon z.
 */
import { type Q, type V3, DEG, clamp, qAxis } from "../core/math";
import type { Role } from "../style/roles";
import { type Part, type PartList, partsBounds, partsToMesh, roleParam, transformParts } from "./parts";
import { type Anchor, defineGenerator } from "./types";

export type ToolDef = {
  label: string;
  /** Prise principale (hauteur sur le manche, m). */
  grip: number;
  /** Action d'usage pour un personnage qui le tient. */
  use: "hammer" | "sweep" | "dig" | "carry";
  affords: string[];
  parts: (o: { handle: Role; head: Role; accent: Role }) => PartList;
};

const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, r1, role });
const bx = (c: V3, h: V3, role: Role, rot?: V3): Part => ({ t: "box", c, h, role, rot });
const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 6): V3[] => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0] as V3; });

export const TOOLS: Record<string, ToolDef> = {
  hammer: { label: "Marteau", grip: 0.07, use: "hammer", affords: ["hold", "hit", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.31, 0], 0.014, o.handle, 0.012), bx([0.015, 0.31, 0], [0.055, 0.016, 0.016], o.head), { t: "tube", pts: [[-0.04, 0.31, 0], [-0.07, 0.3, 0], [-0.09, 0.275, 0]], r: 0.007, role: o.head }] },
  mallet: { label: "Maillet", grip: 0.08, use: "hammer", affords: ["hold", "hit", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.3, 0], 0.013, o.handle), rod([-0.07, 0.32, 0], [0.07, 0.32, 0], 0.042, o.head)] },
  sledgehammer: { label: "Masse", grip: 0.12, use: "hammer", affords: ["hold", "hit", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.86, 0], 0.017, o.handle, 0.015), bx([0, 0.88, 0], [0.09, 0.034, 0.034], o.head)] },
  axe: { label: "Hache", grip: 0.1, use: "hammer", affords: ["hold", "chop", "carry"], parts: (o) => [{ t: "tube", pts: [[0, 0, 0], [0.012, 0.25, 0], [0, 0.5, 0], [-0.008, 0.7, 0]], r: 0.016, role: o.handle }, bx([0.05, 0.66, 0], [0.05, 0.05, 0.008], o.head), bx([0.1, 0.66, 0], [0.008, 0.075, 0.004], o.head)] },
  pickaxe: { label: "Pioche", grip: 0.12, use: "dig", affords: ["hold", "dig", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.88, 0], 0.018, o.handle), { t: "tube", pts: arc(0, 0.62, 0.3, Math.PI * 0.18, Math.PI * 0.82, 8).map(([x, y, z]) => [x, y, z] as V3), r: 0.018, role: o.head }, bx([0, 0.9, 0], [0.03, 0.035, 0.028], o.head)] },
  shovel: { label: "Pelle", grip: 0.75, use: "dig", affords: ["hold", "dig", "carry"], parts: (o) => [bx([0, 0.14, 0.015], [0.115, 0.14, 0.006], o.head, [-12, 0, 0]), rod([0, 0.26, 0], [0, 1.08, 0], 0.017, o.handle), bx([0, 1.1, 0], [0.065, 0.016, 0.016], o.handle)] },
  spade: { label: "Bêche", grip: 0.8, use: "dig", affords: ["hold", "dig", "carry"], parts: (o) => [bx([0, 0.15, 0], [0.095, 0.15, 0.005], o.head), bx([0, 0.31, 0], [0.1, 0.012, 0.012], o.head), rod([0, 0.3, 0], [0, 1.0, 0], 0.017, o.handle), { t: "tube", pts: [[-0.06, 1.0, 0], [-0.05, 1.07, 0], [0.05, 1.07, 0], [0.06, 1.0, 0]], r: 0.013, role: o.handle }] },
  rake: { label: "Râteau", grip: 0.9, use: "sweep", affords: ["hold", "rake", "carry"], parts: (o) => [rod([0, 0.07, 0], [0, 1.55, 0], 0.014, o.handle), bx([0, 0.07, 0], [0.2, 0.012, 0.016], o.head), ...Array.from({ length: 12 }, (_, i) => rod([-0.19 + (i * 0.38) / 11, 0.065, 0], [-0.19 + (i * 0.38) / 11, 0.0, 0.02], 0.004, o.head))] },
  leafrake: { label: "Balai à feuilles", grip: 0.95, use: "sweep", affords: ["hold", "rake", "carry"], parts: (o) => [rod([0, 0.32, 0], [0, 1.6, 0], 0.014, o.handle), ...Array.from({ length: 11 }, (_, i) => { const a = Math.PI * (0.22 + (0.56 * i) / 10); return rod([0, 0.32, 0], [Math.cos(a) * 0.32, 0.32 - Math.sin(a) * 0.32, 0.02], 0.004, o.accent); })] },
  hoe: { label: "Binette", grip: 0.85, use: "dig", affords: ["hold", "dig", "carry"], parts: (o) => [rod([0, 0.05, 0], [0, 1.4, 0], 0.015, o.handle), bx([0, 0.05, 0.06], [0.08, 0.05, 0.004], o.head, [-70, 0, 0])] },
  pitchfork: { label: "Fourche", grip: 0.8, use: "dig", affords: ["hold", "dig", "carry"], parts: (o) => [rod([0, 0.3, 0], [0, 1.45, 0], 0.015, o.handle), { t: "tube", pts: [[-0.08, 0.06, 0], [-0.08, 0.26, 0], [0.08, 0.26, 0], [0.08, 0.06, 0]], r: 0.006, role: o.head }, rod([0, 0.3, 0], [0, 0.06, 0], 0.006, o.head)] },
  broom: { label: "Balai", grip: 0.85, use: "sweep", affords: ["hold", "sweep", "carry"], parts: (o) => [rod([0, 0.08, 0], [0, 1.35, 0], 0.013, o.handle), bx([0, 0.1, 0], [0.16, 0.025, 0.03], o.handle), bx([0, 0.04, 0], [0.155, 0.04, 0.026], o.accent)] },
  besom: { label: "Balai de brindilles", grip: 0.75, use: "sweep", affords: ["hold", "sweep", "carry", "fly"], parts: (o) => [rod([0, 0.4, 0], [0, 1.3, 0], 0.016, o.handle), { t: "blob", c: [0, 0.2, 0], r: [0.12, 0.24, 0.12], role: "path" }, rod([-0.03, 0.4, 0], [0.03, 0.4, 0], 0.03, o.accent)] },
  mop: { label: "Serpillière", grip: 0.85, use: "sweep", affords: ["hold", "sweep", "carry"], parts: (o) => [rod([0, 0.12, 0], [0, 1.3, 0], 0.013, o.handle), { t: "blob", c: [0, 0.08, 0], r: [0.12, 0.08, 0.12], role: o.accent }] },
  scythe: { label: "Faux", grip: 0.9, use: "sweep", affords: ["hold", "mow", "carry"], parts: (o) => [{ t: "tube", pts: [[0, 0, 0], [0.04, 0.5, 0], [0.02, 1.0, 0], [-0.02, 1.45, 0]], r: 0.016, role: o.handle }, rod([0.04, 0.95, 0], [0.18, 0.98, 0], 0.012, o.handle), { t: "tube", pts: arc(-0.3, 0.2, 0.36, -0.05, Math.PI * 0.45, 8).map(([x, y]) => [x + 0.06, y - 0.2, 0] as V3), r: 0.008, role: o.head }] },
  saw: { label: "Scie", grip: 0.05, use: "sweep", affords: ["hold", "saw", "carry"], parts: (o) => [bx([0, 0.05, 0], [0.025, 0.06, 0.014], o.handle), { t: "box", c: [0.015, 0.36, 0], h: [0.05, 0.26, 0.002], role: o.head, rot: [0, 0, -3] }] },
  trowel: { label: "Truelle", grip: 0.05, use: "dig", affords: ["hold", "dig", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.11, 0], 0.013, o.handle, 0.011), rod([0, 0.11, 0], [0, 0.14, 0.02], 0.004, o.head), bx([0, 0.22, 0.025], [0.05, 0.08, 0.003], o.head)] },
  wrench: { label: "Clé", grip: 0.05, use: "hammer", affords: ["hold", "carry"], parts: (o) => [bx([0, 0.1, 0], [0.012, 0.1, 0.005], o.head), { t: "tube", pts: arc(0, 0.235, 0.028, -Math.PI * 0.25, Math.PI * 1.25, 8), r: 0.008, role: o.head }] },
  screwdriver: { label: "Tournevis", grip: 0.05, use: "hammer", affords: ["hold", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.1, 0], 0.014, o.accent, 0.012), rod([0, 0.1, 0], [0, 0.21, 0], 0.0035, o.head)] },
  paintbrush: { label: "Pinceau", grip: 0.06, use: "sweep", affords: ["hold", "paint", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.16, 0], 0.008, o.handle, 0.011), bx([0, 0.18, 0], [0.025, 0.02, 0.008], "metal"), bx([0, 0.22, 0], [0.024, 0.025, 0.006], o.accent)] },
  paintroller: { label: "Rouleau à peindre", grip: 0.06, use: "sweep", affords: ["hold", "paint", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.13, 0], 0.013, o.accent), { t: "tube", pts: [[0, 0.13, 0], [0, 0.22, 0], [0.04, 0.26, 0], [0.04, 0.3, 0]], r: 0.004, role: "metal" }, rod([-0.07, 0.3, 0], [0.11, 0.3, 0], 0.025, "white")] },
  crowbar: { label: "Pied-de-biche", grip: 0.15, use: "dig", affords: ["hold", "pry", "carry"], parts: (o) => [{ t: "tube", pts: [[0.03, -0.01, 0], [0, 0.03, 0], [0, 0.55, 0], ...arc(0.03, 0.55, 0.03, Math.PI, Math.PI * 0.25, 4)], r: 0.009, role: o.accent }] },
  fishingrod: { label: "Canne à pêche", grip: 0.25, use: "carry", affords: ["hold", "fish", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.4, 0], 0.016, "cloth2", 0.012), rod([0, 0.4, 0], [0, 2.3, 0], 0.008, o.handle, 0.002), rod([0, 0.3, 0], [0.04, 0.3, 0], 0.022, o.head)] },
  machete: { label: "Machette", grip: 0.05, use: "hammer", affords: ["hold", "chop", "carry"], parts: (o) => [rod([0, 0, 0], [0, 0.12, 0], 0.013, o.accent), { t: "box", c: [0.01, 0.34, 0], h: [0.022, 0.22, 0.002], role: o.head, rot: [0, 0, -4] }] },
};

export const TOOL_KINDS = Object.keys(TOOLS);

/** Pièces de référence d'un outil (manche selon y, bas à y = 0). */
export function toolParts(kind: string, p: Record<string, unknown> = {}): { def: ToolDef; parts: PartList } {
  const def = TOOLS[kind] ?? TOOLS.hammer;
  const head = roleParam(p.color2, "metal"), handle = roleParam(p.color, "wood"), accent = roleParam(p.color3, kind === "broom" ? "path" : kind === "mop" ? "white" : kind === "fishingrod" ? "black" : kind === "leafrake" ? "metal" : kind === "besom" ? "leather" : "red");
  return { def, parts: def.parts({ handle, head, accent }) };
}

export type ToolPose = "lying" | "leaning" | "upright";

/** Outil posé : pièces dans le repère de l'objet (au sol), et position de la prise. */
export function placedTool(kind: string, p: Record<string, unknown>): { parts: PartList; grip: V3; def: ToolDef } {
  const { def, parts } = toolParts(kind, p);
  const s = clamp(Number(p.scale ?? 1) || 1, 0.2, 5);
  const pose = String(p.pose ?? "lying") as ToolPose;
  let q: Q;
  if (pose === "upright") q = [0, 0, 0, 1];
  else if (pose === "leaning") q = qAxis([1, 0, 0], -16 * DEG);
  else q = qAxis([1, 0, 0], Math.PI / 2); // couché : manche selon z, tête à plat au sol
  // centré sur le milieu du manche, posé au sol
  let out = transformParts(parts, q, [0, 0, 0], s);
  const b2 = partsBounds(out);
  const t: V3 = [-(b2.min[0] + b2.max[0]) / 2, -b2.min[1], pose === "lying" ? -(b2.min[2] + b2.max[2]) / 2 : 0];
  out = transformParts(out, [0, 0, 0, 1], t);
  const g = transformParts([{ t: "rod", a: [0, def.grip, 0], b: [0, def.grip + 0.01, 0], r: 0.01, role: "wood" }], q, [0, 0, 0], s);
  const ga = (g[0] as { a: V3 }).a;
  return { parts: out, grip: [ga[0] + t[0], ga[1] + t[1], ga[2] + t[2]], def };
}

/**
 * Outil tenu par un personnage de taille `H` : manche selon y, **prise à l'origine** (le personnage referme la main
 * dessus). Échelle réelle ramenée à la taille du personnage (1,7 m = 1).
 */
export function heldToolParts(kind: string, H: number): { parts: PartList; handle: number } | null {
  if (!TOOLS[kind]) return null;
  const { def, parts } = toolParts(kind);
  const k = H / 1.7;
  const out = transformParts(parts, [0, 0, 0, 1], [0, -def.grip * k, 0], k);
  const handleR = parts.find((q) => q.t === "rod" || q.t === "tube") as { r: number } | undefined;
  return { parts: out, handle: (handleR?.r ?? 0.013) * k };
}

export const tool = defineGenerator({
  id: "tool",
  label: "Outil à main",
  doc:
    "Outils à taille réelle (hammer, mallet, sledgehammer, axe, pickaxe, shovel, spade, rake, leafrake, hoe, pitchfork, broom, besom, mop, scythe, saw, trowel, wrench, screwdriver, paintbrush, paintroller, crowbar, fishingrod, machete) : posés (`pose`: lying au sol, leaning appuyé, upright planté). Un personnage peut en tenir un : `character.item: \"tool.rake\"` ; action d'usage `hammer`, `sweep` ou `dig` (voir `extra.use`). `color` = rôle du manche, `color2` = tête, `color3` = détail. Ancre grip.",
  tags: ["outil", "jardin", "atelier", "chantier", "ferme", "objet du quotidien"],
  schema: {
    kind: { type: "enum", default: "hammer", options: TOOL_KINDS, doc: "Outil" },
    pose: { type: "enum", default: "lying", options: ["lying", "leaning", "upright"], doc: "Posé au sol, appuyé, planté" },
    scale: { type: "number", default: 1, min: 0.2, max: 5, doc: "Échelle (1 = taille réelle)" },
    color: { type: "string", default: "auto", doc: "Rôle du manche" },
    color2: { type: "string", default: "auto", doc: "Rôle de la tête" },
    color3: { type: "string", default: "auto", doc: "Rôle du détail (poignée, poils, fil)" },
  },
  build(p) {
    const kind = String(p.kind);
    const { parts, grip, def } = placedTool(kind, p);
    const mesh = partsToMesh(parts, 0.8);
    const bb = partsBounds(parts);
    const hx = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), 0.01);
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]), 0.01);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = { grip: { pos: grip, rot, scale: 0.05 }, top: { pos: [0, bb.max[1], 0], rot, scale: 0.05 } };
    return { generator: "tool", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: Math.max(0.01, bb.max[1]), extra: { affords: def.affords, use: def.use, label: def.label } };
  },
});
