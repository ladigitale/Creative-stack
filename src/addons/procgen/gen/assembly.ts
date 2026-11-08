/**
 * Assemblage libre (`assembly`) : un objet inédit décrit **en données** par l'agent, sans attendre qu'un générateur
 * existe : liste de pièces (planche, barre, tube courbe, tour, coussin) en mètres, rôles de couleur, ancres et
 * affordances. Rendu identique en 3D et en vectoriel. Aucune évaluation de code : nombres, types et rôles connus.
 */
import type { Q, V3 } from "../core/math";
import { partsBounds, partsToMesh, readParts } from "./parts";
import { type Anchor, defineGenerator } from "./types";

export const assembly = defineGenerator({
  id: "assembly",
  label: "Assemblage de pièces (objet sur mesure)",
  doc:
    "Objet composé par l'agent : `parts` = liste de pièces en mètres (y vers le haut, base au sol, avant = +z). Types : {t:'box', c:[x,y,z], h:[demi-côtés], rot?:[°x,°y,°z], role}, {t:'rod', a, b, r, r1?, role} (barre, pied), {t:'tube', pts:[[x,y,z]…], r, role} (barre courbe), {t:'lathe', c, profile:[[rayon, hauteur]…], role} (vase, seau, poteau tourné), {t:'blob', c, r:[rx,ry,rz], role} (coussin, sac, galet), {t:'plate', c, pts:[[x,y]…] convexe, d, rot?, role} (panneau, pignon, pointe de flèche ; une forme concave = plusieurs plaques). 80 pièces au plus. `anchors` : {nom: [x,y,z]} (ex. sit.0, grip, top) ; `affords` : ['sit', 'push', 'carry'…]. Exemples : brouette, seau, pelle, établi, niche, mangeoire, panneau, jouet.",
  tags: ["sur mesure", "objet", "outil", "objet du quotidien", "pièces", "assemblage"],
  schema: {
    parts: { type: "list", default: [], max: 80, doc: "Pièces de l'objet" },
    anchors: { type: "object", default: {}, doc: "Ancres nommées {nom: [x, y, z]}" },
    affords: { type: "list", default: [], max: 16, doc: "Affordances (sit, lie, push, pull, carry, hold, climb, open…)" },
    label: { type: "string", default: "", doc: "Nom lisible de l'objet" },
  },
  build(p, ctx) {
    const { parts, problems } = readParts(p.parts);
    for (const m of problems) ctx.issues.add({ path: `${ctx.path}.parts`, code: "type", message: m });
    if (!parts.length) {
      ctx.issues.add({ path: `${ctx.path}.parts`, code: "missing", message: "aucune pièce : une caisse la remplace", hint: "parts: [{t:'box', c:[0,0.25,0], h:[0.25,0.25,0.25], role:'wood'}]" });
      parts.push({ t: "box", c: [0, 0.25, 0], h: [0.25, 0.25, 0.25], role: "wood" });
    }
    const mesh = partsToMesh(parts);
    const bb = partsBounds(parts);
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
    return { generator: "assembly", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: Math.max(0.02, bb.max[1]), extra: { affords, label: p.label, parts: parts.length } };
  },
});
