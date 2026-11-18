/**
 * Assemblage libre (`assembly`) : un objet inédit décrit **en données** par l'agent, sans attendre qu'un générateur
 * existe : liste de pièces (planche, barre, tube courbe, tour, coussin) en mètres, rôles de couleur, ancres et
 * affordances. Rendu identique en 3D et en vectoriel. Aucune évaluation de code : nombres, types et rôles connus.
 */
import type { Q, V3 } from "../core/math";
import { type PartList, partsBounds, partsToMesh, readParts } from "./parts";
import { type Anchor, defineGenerator } from "./types";
import { type JointSpec, MAX_JOINTS, buildJoints, jointPoint, readJointDecl } from "./joints";

/**
 * Pièces d'un assemblage : corps, et parties mobiles déclarées pièce par pièce (`part: {name, pivot, axis, range,
 * kind}` ; les pièces d'un même nom forment une partie, la première déclaration fait foi). Lu aussi par le vectoriel.
 */
export function assemblyModel(raw: unknown): { parts: PartList; joints: JointSpec[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(raw)) {
    const r = readParts(raw);
    return { parts: r.parts, joints: [], problems: r.problems };
  }
  const body: unknown[] = [];
  const groups = new Map<string, { spec: Omit<JointSpec, "parts">; raw: unknown[] }>();
  raw.slice(0, 80).forEach((q, i) => {
    const decl = q && typeof q === "object" ? (q as Record<string, unknown>).part : undefined;
    if (decl === undefined) return body.push(q);
    const { spec, problem } = readJointDecl(decl);
    if (!spec) {
      problems.push(`parts[${i}].${problem}`);
      return body.push(q);
    }
    let g = groups.get(spec.name);
    if (!g) {
      if (groups.size >= MAX_JOINTS) {
        problems.push(`parts[${i}].part : ${MAX_JOINTS} parties mobiles au plus (pièce fixe)`);
        return body.push(q);
      }
      groups.set(spec.name, (g = { spec, raw: [] }));
    }
    g.raw.push(q);
  });
  if (raw.length > 80) problems.push(`parts : ${raw.length} pièces, 80 gardées`);
  const b = readParts(body);
  problems.push(...b.problems);
  const joints: JointSpec[] = [];
  for (const g of groups.values()) {
    const r = readParts(g.raw);
    problems.push(...r.problems.map((m) => `${g.spec.name} : ${m}`));
    if (r.parts.length) joints.push({ ...g.spec, parts: r.parts });
  }
  return { parts: b.parts, joints, problems };
}

export const assembly = defineGenerator({
  id: "assembly",
  label: "Assemblage de pièces (objet sur mesure)",
  doc:
    "Objet composé par l'agent : `parts` = liste de pièces en mètres (y vers le haut, base au sol, avant = +z). Types : {t:'box', c:[x,y,z], h:[demi-côtés], rot?:[°x,°y,°z], role}, {t:'rod', a, b, r, r1?, role} (barre, pied), {t:'tube', pts:[[x,y,z]…], r, role} (barre courbe), {t:'lathe', c, profile:[[rayon, hauteur]…], role} (vase, seau, poteau tourné), {t:'blob', c, r:[rx,ry,rz], role} (coussin, sac, galet), {t:'plate', c, pts:[[x,y]…] convexe, d, rot?, role} (panneau, pignon, pointe de flèche ; une forme concave = plusieurs plaques). 80 pièces au plus. Partie mobile : une pièce peut porter `part: {name, pivot:[x,y,z], axis:[x,y,z], range:[fermé, ouvert], kind: 'rotation' (degrés) | 'translation' (m), label?, initial?}` ; les pièces d'un même `name` bougent ensemble (couvercle, porte, tiroir), réglées par la clé `states` (0 fermé, 1 ouvert). `anchors` : {nom: [x,y,z]} (ex. sit.0, grip, top) ; `affords` : ['sit', 'push', 'carry'…]. Exemples : brouette, seau, pelle, établi, niche, mangeoire, panneau, jouet.",
  tags: ["sur mesure", "objet", "outil", "objet du quotidien", "pièces", "assemblage"],
  schema: {
    parts: { type: "list", default: [], max: 80, doc: "Pièces de l'objet" },
    anchors: { type: "object", default: {}, doc: "Ancres nommées {nom: [x, y, z]}" },
    affords: { type: "list", default: [], max: 16, doc: "Affordances (sit, lie, push, pull, carry, hold, climb, open…)" },
    label: { type: "string", default: "", doc: "Nom lisible de l'objet" },
  },
  build(p, ctx) {
    const { parts, joints, problems } = assemblyModel(p.parts);
    for (const m of problems) ctx.issues.add({ path: `${ctx.path}.parts`, code: "type", message: m });
    if (!parts.length && !joints.length) {
      ctx.issues.add({ path: `${ctx.path}.parts`, code: "missing", message: "aucune pièce : une caisse la remplace", hint: "parts: [{t:'box', c:[0,0.25,0], h:[0.25,0.25,0.25], role:'wood'}]" });
      parts.push({ t: "box", c: [0, 0.25, 0], h: [0.25, 0.25, 0.25], role: "wood" });
    }
    const J = buildJoints(partsToMesh(parts), joints, 1);
    const bb = partsBounds([...parts, ...joints.flatMap((j) => j.parts ?? [])]);
    const hx = Math.max(Math.abs(bb.min[0]), Math.abs(bb.max[0]), 0.02);
    const hz = Math.max(Math.abs(bb.min[2]), Math.abs(bb.max[2]), 0.02);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = { top: { pos: [0, bb.max[1], 0], rot, scale: 1 } };
    for (const [k, v] of Object.entries(p.anchors ?? {}).slice(0, 24)) {
      if (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === "number" && Number.isFinite(x))) anchors[k.slice(0, 40)] = { pos: [v[0], v[1], v[2]].map((x) => Math.max(-6, Math.min(12, x))) as V3, rot, scale: 1 };
      else ctx.issues.add({ path: `${ctx.path}.anchors.${k}`, code: "type", message: "ancre attendue [x, y, z]" });
    }
    for (const k of Object.keys(anchors)) {
      const m = /^sit\.(\d+)$/.exec(k);
      if (m && !anchors[`approach.${m[1]}`]) anchors[`approach.${m[1]}`] = { pos: [anchors[k].pos[0], 0, hz + 0.35], rot, scale: 1 };
    }
    const affords = (p.affords as unknown[]).filter((a): a is string => typeof a === "string").map((a) => a.slice(0, 24));
    for (const j of joints) for (const [k, v] of Object.entries(j.anchors ?? {})) anchors[`${j.name}.${k}`] = { pos: jointPoint(j, j.initial ?? 0, v), rot, scale: 1 };
    return { generator: "assembly", mesh: J.mesh, ...(J.joints.length ? { body: J.body, joints: J.joints } : {}), anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: Math.max(0.02, bb.max[1]), extra: { affords, label: p.label, parts: parts.length } };
  },
});
