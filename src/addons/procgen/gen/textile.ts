/**
 * Textiles au vent (`textile`, raccourci `textile.<kind>`) : drapeau, bannière, fanion, manche à air, corde à linge,
 * rideau. Mât, potence, poteaux et tringle sur la grammaire de pièces ; le tissu est une pièce souple (`SoftPiece`)
 * simulée en 3D (vent de la recette, plafond de tissus simulés) et figée en vectoriel (drapé de repos en plaques).
 *
 * Repère : base au sol, avant = +z ; le tissu s'attache côté −x d'un mât (il flotte vers +x par vent nominal) ; le
 * rideau pend devant sa tringle (à poser dos au mur).
 */
import { type Q, type V3, clamp } from "../core/math";
import { ROLE, type Role } from "../style/roles";
import { type Part, type PartList, partsBounds, partsToMesh, roleParam } from "./parts";
import { FABRICS, clothSpec, frozenMesh, frozenPlates } from "./soft";
import { type Anchor, type SoftPiece, defineGenerator } from "./types";

export const TEXTILE_KINDS = ["flag", "banner", "pennant", "windsock", "laundry", "curtain"] as const;

const rod = (a: V3, b: V3, r: number, role: Role, r1?: number): Part => ({ t: "rod", a, b, r, r1, role });
const blob = (c: V3, r: V3, role: Role): Part => ({ t: "blob", c, r, role });
const bx = (c: V3, h: V3, role: Role): Part => ({ t: "box", c, h, role });

export type TextileModel = { parts: PartList; pieces: SoftPiece[]; scale: number; label: string };

const DEFAULT_ROLE: Record<string, Role> = { flag: "red", banner: "accent", pennant: "yellow", windsock: "orange", laundry: "cloth1", curtain: "cloth2" };

export function textileModel(p: Record<string, unknown>): TextileModel {
  const kind = (TEXTILE_KINDS as readonly string[]).includes(String(p.kind)) ? String(p.kind) : "flag";
  const s = clamp(Number(p.scale ?? 1) || 1, 0.2, 5);
  const fabric = FABRICS[String(p.fabric)] ? String(p.fabric) : kind === "windsock" || kind === "banner" ? "canvas" : kind === "curtain" ? "cotton" : "cotton";
  const cloth: Role = roleParam(p.color, DEFAULT_ROLE[kind]);
  const frame: Role = roleParam(p.color2, kind === "laundry" || kind === "curtain" ? "wood" : "metal");
  const L = clamp(Number(p.length ?? 0) || 0, 0, 12);
  const n = clamp(Math.round(Number(p.count ?? 4)) || 4, 1, 8);
  const P: PartList = [];
  const pieces: SoftPiece[] = [];
  const R = (r: Role) => ROLE[r];
  const piece = (label: string, role: Role, spec: SoftPiece["cloth"], c: V3, h: V3, extra: Partial<SoftPiece> = {}) => pieces.push({ label, role: R(role), cloth: spec, box: { c, h }, ...extra });
  let label = "drapeau";
  switch (kind) {
    case "flag": {
      const H = 4.2;
      P.push(rod([0, 0, 0], [0, H, 0], 0.045, frame, 0.03), blob([0, H + 0.04, 0], [0.06, 0.06, 0.06], "yellow"), bx([0, 0.04, 0], [0.16, 0.04, 0.16], "stone"));
      piece("drapeau", cloth, clothSpec("tissu", "gauche", fabric, { collide: false, segments: 10 }), [0.04 + 0.75, H - 0.5, 0], [0.75, 0.48, 0.004]);
      break;
    }
    case "banner": {
      const H = 3.6;
      P.push(rod([0, 0, 0], [0, H, 0], 0.04, frame, 0.03), rod([0, H - 0.15, 0], [0.8, H - 0.15, 0], 0.018, frame), blob([0.82, H - 0.15, 0], [0.03, 0.03, 0.03], frame), bx([0, 0.04, 0], [0.15, 0.04, 0.15], "stone"));
      piece("bannière", cloth, clothSpec("tissu", "haut", fabric, { collide: false, segments: 10 }), [0.44, H - 0.17 - 0.8, 0], [0.3, 0.8, 0.004]);
      label = "bannière";
      break;
    }
    case "pennant": {
      const H = 2.8;
      P.push(rod([0, 0, 0], [0, H, 0], 0.03, frame, 0.02), blob([0, H + 0.03, 0], [0.04, 0.04, 0.04], frame));
      piece("fanion", cloth, clothSpec("tissu", "gauche", fabric, { collide: false, segments: 9 }), [0.03 + 0.55, H - 0.3, 0], [0.55, 0.24, 0.004], { taper: 1 });
      label = "fanion";
      break;
    }
    case "windsock": {
      const H = 4;
      P.push(rod([0, 0, 0], [0, H, 0], 0.04, frame, 0.03), rod([0, H - 0.1, 0], [0.12, H - 0.1, 0], 0.015, frame), bx([0, 0.04, 0], [0.15, 0.04, 0.15], "stone"));
      // anneau de bouche tenu par la potence ; corps en tube qui se resserre
      piece("manche à air", cloth, clothSpec("jupe", "gauche", fabric, { collide: false, segments: 8, flare: 0.45, stiffness: 0.55, wind: 2.4, weight: 0.8 }), [0.14 + 0.55, H - 0.1, 0], [0.55, 0.15, 0.15]);
      label = "manche à air";
      break;
    }
    case "laundry": {
      const span = L || 3.2;
      const top = 1.85, sag = 0.08 + span * 0.02;
      for (const x of [-span / 2, span / 2]) P.push(rod([x, 0, 0], [x, top + 0.15, 0], 0.035, frame, 0.03), rod([x, top + 0.1, -0.2], [x, top + 0.1, 0.2], 0.02, frame));
      const yAt = (x: number) => top - sag * (1 - ((2 * x) / span) ** 2);
      const pts: V3[] = [];
      for (let i = 0; i <= 10; i++) {
        const x = -span / 2 + (span * i) / 10;
        pts.push([x, yAt(x), 0]);
      }
      P.push({ t: "tube", pts, r: 0.006, role: "paper" });
      // pièces : chemise, serviette, drap, chaussette… réparties le long de la corde
      const sizes: [number, number][] = [[0.28, 0.32], [0.3, 0.45], [0.06, 0.16], [0.45, 0.55], [0.22, 0.28], [0.08, 0.17], [0.34, 0.4], [0.25, 0.3]];
      const roles: Role[] = [cloth, "white", "cloth2", "cloth3", "blue", "white", "yellow", "cloth1"];
      const slot = (span - 0.3) / n;
      for (let i = 0; i < n; i++) {
        const [hw0, hh] = sizes[i % sizes.length];
        const hw = Math.min(hw0, slot * 0.45);
        const x = -span / 2 + 0.15 + slot * (i + 0.5);
        const y = yAt(x) - 0.01;
        piece("linge", roles[i % roles.length], clothSpec("tissu", "haut", fabric, { collide: false, segments: 7 }), [x, y - hh, 0], [hw, hh, 0.004]);
        // pinces
        for (const dx of [-hw * 0.8, hw * 0.8]) P.push(bx([x + dx, y + 0.005, 0], [0.008, 0.025, 0.01], "wood"));
      }
      label = "linge";
      break;
    }
    case "curtain": {
      const W = L || 1.6, H = 2.3, z = 0.09;
      P.push(rod([-W / 2 - 0.1, H, z], [W / 2 + 0.1, H, z], 0.016, frame), blob([-W / 2 - 0.12, H, z], [0.03, 0.03, 0.03], frame), blob([W / 2 + 0.12, H, z], [0.03, 0.03, 0.03], frame));
      for (const sx of [-1, 1]) P.push(rod([sx * (W / 2 + 0.02), H, 0], [sx * (W / 2 + 0.02), H, z], 0.01, frame));
      // deux pans froncés, tirés de chaque côté
      const pw = W * 0.21;
      for (const sx of [-1, 1]) piece("rideau", cloth, clothSpec("tissu", "haut", fabric, { collide: false, segments: 8, wind: 0.35, damping: 0.18, pleats: 0.035 }), [sx * (W / 2 - pw - 0.02), H - 0.02 - (H - 0.2) / 2, z + 0.03], [pw, (H - 0.2) / 2, 0.004]);
      label = "rideau";
      break;
    }
  }
  if (s !== 1) {
    const S = (v: V3): V3 => [v[0] * s, v[1] * s, v[2] * s];
    const P2: PartList = P.map((q) => {
      switch (q.t) {
        case "rod":
          return { ...q, a: S(q.a), b: S(q.b), r: q.r * s, r1: q.r1 && q.r1 * s };
        case "tube":
          return { ...q, pts: q.pts.map(S), r: q.r * s };
        case "blob":
          return { ...q, c: S(q.c), r: S(q.r) };
        case "box":
          return { ...q, c: S(q.c), h: S(q.h) };
        default:
          return q;
      }
    });
    return { parts: P2, pieces: pieces.map((q) => ({ ...q, box: q.box && { c: S(q.box.c), h: S(q.box.h) } })), scale: s, label };
  }
  return { parts: P, pieces, scale: s, label };
}

export const textile = defineGenerator({
  id: "textile",
  label: "Textiles au vent",
  doc:
    "Tissus simulés qui flottent au vent de la recette (`wind`, `windDir`) : flag (drapeau sur mât), banner (bannière pendue à une potence), pennant (fanion triangulaire), windsock (manche à air), laundry (corde à linge entre deux poteaux, `count` pièces, `length` portée), curtain (rideau à deux pans sur tringle, `length` largeur ; à poser dos au mur). `fabric` : silk (léger, flotte), cotton, canvas (raide), wool (lourd). `color` = rôle du tissu, `color2` = mât ou poteaux. 3D : tissu simulé (figé en drapé de repos au-delà du plafond de tissus, au loin ou hors écran) ; vectoriel : forme figée. Ancre top.",
  tags: ["drapeau", "fanion", "linge", "rideau", "vent", "tissu", "fête"],
  schema: {
    kind: { type: "enum", default: "flag", options: TEXTILE_KINDS, doc: "Objet" },
    fabric: { type: "enum", default: "auto", options: ["auto", "silk", "cotton", "canvas", "wool"], doc: "Matière : souplesse et poids du tissu" },
    count: { type: "int", default: 4, min: 1, max: 8, doc: "Pièces de linge (laundry)" },
    length: { type: "number", default: 0, min: 0, max: 12, unit: "m", doc: "Portée de la corde (laundry, 3,2 m) ou largeur du rideau (curtain, 1,6 m) ; 0 = défaut" },
    scale: { type: "number", default: 1, min: 0.2, max: 5, doc: "Échelle (1 = taille réelle)" },
    color: { type: "string", default: "auto", doc: "Rôle du tissu (red, blue, accent, cloth1…)" },
    color2: { type: "string", default: "auto", doc: "Rôle du mât, des poteaux ou de la tringle" },
  },
  build(p) {
    const m = textileModel(p);
    const mesh = partsToMesh(m.parts, 0.85);
    const bb = partsBounds(m.parts);
    const low = m.parts.filter((q) => partsBounds([q]).min[1] < 1);
    const lb = partsBounds(low.length ? low : m.parts);
    const hx = Math.max(Math.abs(lb.min[0]), Math.abs(lb.max[0]), 0.1);
    const hz = Math.max(Math.abs(lb.min[2]), Math.abs(lb.max[2]), 0.1);
    const rot: Q = [0, 0, 0, 1];
    const anchors: Record<string, Anchor> = { top: { pos: [0, bb.max[1], 0], rot, scale: m.scale } };
    return { generator: "textile", mesh, anchors, footprint: { hx, hz, r: Math.hypot(hx, hz) }, height: bb.max[1], soft: m.pieces, softFrozen: frozenMesh(m.pieces), extra: { label: m.label, affords: ["look"] } };
  },
});

/** Pièces figées du textile (vectoriel). */
export function textileFrozenParts(p: Record<string, unknown>): PartList {
  const m = textileModel(p);
  return [...m.parts, ...frozenPlates(m.pieces)];
}
