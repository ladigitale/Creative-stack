/**
 * Pièces souples du personnage (`soft`, `cape`) : cape, jupes et pans de robe, pan d'écharpe en tissu simulé, cheveux
 * longs et queues de cheval en mèches. Repère de repos du personnage (avant = +z) ; chaque pièce est portée par un os
 * et repoussée par des sphères posées sur les os du corps (torse, épaules, bassin, jambes).
 */
import { type V3, add, mix } from "../../core/math";
import { ROLE } from "../../style/roles";
import type { HairSpec } from "../../../../shared/sim/hair";
import { clothSpec } from "../soft";
import type { SoftPiece } from "../types";
import type { Kit } from "./kit";

type Col = NonNullable<SoftPiece["colliders"]>[number];

export const softCloth = (k: Kit) => k.look.soft === "cloth" || k.look.soft === "all";
export const softHair = (k: Kit) => k.look.soft === "hair" || k.look.soft === "all";

/** Sphères du corps : torse (deux de front, une basse), épaules, bassin, jambes. */
export function bodyColliders(k: Kit, parts: ("torso" | "arms" | "hips" | "legs" | "neck")[]): Col[] {
  const { P, H, bw, at, rad, look, thick } = k;
  const out: Col[] = [];
  const torsoD = P.torsoD;
  const chestC = add(at("chest", 0.45), [0, 0, H * 0.004]);
  const cx = P.shoulderHalf * 0.88 * mix(0.95, 1.08, look.build);
  const cz = H * 0.068 * torsoD * bw + thick;
  if (parts.includes("torso")) {
    // vêtements épais (manteau, robe, armure) : sphères gonflées d'autant
    const extra = thick * (look.over !== "none" ? 2.5 : look.top === "coat" || look.top === "robe" ? 1.8 : 1);
    for (const sx of [1, -1]) out.push({ bone: "chest", c: [sx * cx * 0.45, chestC[1], chestC[2]], r: cz + extra });
    for (const dy of [-0.05, 0.04]) out.push({ bone: "chest", c: [0, chestC[1] + H * dy, chestC[2]], r: cz + extra });
    out.push({ bone: "spine", c: at("spine", 0.5), r: Math.max(rad("spine", 0.5) * bw, cz * 0.95) + extra });
  }
  if (parts.includes("neck")) out.push({ bone: "neck", c: at("neck", 0.4), r: rad("neck", 0.4) * bw * 1.2 + thick });
  if (parts.includes("arms")) for (const s of ["l", "r"]) out.push({ bone: `upperarm.${s}`, c: at(`upperarm.${s}`, 0.15), r: rad(`upperarm.${s}`, 0.15) * bw + thick * 1.6 });
  if (parts.includes("hips")) {
    const hz = H * 0.072 * torsoD * bw + thick;
    for (const sx of [1, -1]) out.push({ bone: "pelvis", c: [sx * P.hipHalf * 0.55, P.hipY, -H * 0.008], r: hz });
  }
  if (parts.includes("legs"))
    for (const s of ["l", "r"]) {
      for (const t of [0.25, 0.7]) out.push({ bone: `thigh.${s}`, c: at(`thigh.${s}`, t), r: rad(`thigh.${s}`, t) * bw + thick * 1.5 });
      for (const t of [0.3, 0.75]) out.push({ bone: `shin.${s}`, c: at(`shin.${s}`, t), r: rad(`shin.${s}`, t) * 1.04 + thick * 1.5 });
    }
  return out;
}

/** Cape : nappe attachée aux épaules (os `chest`), dans le dos. */
export function capePiece(k: Kit, length: "short" | "long", backZ: number): SoftPiece {
  const { P, H } = k;
  const top = P.shoulderY + H * 0.005;
  const bot = length === "long" ? P.ankleY + H * 0.07 : P.crotchY - H * 0.1;
  const hx = P.shoulderHalf * 1.18;
  return {
    label: "cape",
    bone: "chest",
    role: ROLE.cloth3,
    // cintrée : les bords avancent vers les épaules, le milieu reste dans le dos
    cloth: clothSpec("tissu", "haut", "wool", { segments: length === "long" ? 12 : 9, stiffness: 0.4, curl: P.shoulderHalf * 0.7, pleats: P.shoulderHalf * 0.07 }),
    box: { c: [0, (top + bot) / 2, backZ - H * 0.02], h: [hx, (top - bot) / 2, 0.003] },
    colliders: bodyColliders(k, length === "long" ? ["torso", "arms", "hips", "legs"] : ["torso", "arms", "hips"]),
  };
}

/**
 * Jupe, robe, pan de manteau : tube évasé attaché au bassin, sous un empiècement rigide (rendu par le champ du
 * corps). `y0` haut du tube, `hem` ourlet, `r0` rayon en haut, `r1` à l'ourlet.
 */
export function skirtPiece(k: Kit, y0: number, z0: number, hem: number, r0: number, r1: number, role: number): SoftPiece {
  const { H } = k;
  const len = y0 - hem;
  return {
    label: "jupe",
    bone: "pelvis",
    role,
    cloth: clothSpec("jupe", "haut", "cotton", { segments: len > H * 0.3 ? 9 : 6, stiffness: 0.32, flare: Math.max(0.6, r1 / Math.max(1e-3, r0)) }),
    box: { c: [0, (y0 + hem) / 2, z0], h: [r0, len / 2, r0] },
    colliders: bodyColliders(k, ["hips", "legs"]),
  };
}

/** Pan d'écharpe : bande pendue devant la poitrine depuis le cou. */
export function scarfPiece(k: Kit, a: V3, endY: number, frontZ: number): SoftPiece {
  const { H } = k;
  const len = a[1] - endY;
  return {
    label: "écharpe",
    bone: "chest",
    role: ROLE.cloth3,
    cloth: clothSpec("tissu", "haut", "wool", { segments: 7, stiffness: 0.5 }),
    box: { c: [a[0], (a[1] + endY) / 2, frontZ], h: [H * 0.022, len / 2, 0.003] },
    colliders: bodyColliders(k, ["torso"]),
  };
}

/** Chevelure en mèches (os `head`) : `longs` (cheveux longs) ou `queue` (queue de cheval). */
export function hairPiece(k: Kit, cut: "longs" | "queue", head: V3, r: number, length: number, hw: number): SoftPiece {
  const crowd = k.look.detail === "crowd";
  const spec: HairSpec = {
    count: cut === "queue" ? (crowd ? 22 : 34) : crowd ? 48 : 80,
    length,
    spread: cut === "queue" ? 0.2 : 0.3,
    wave: k.look.hair === "wavy" ? 0.35 : 0.12,
    stiffness: cut === "queue" ? 0.45 : 0.32,
    width: hw * (cut === "queue" ? 0.12 : 0.17),
    color: "",
    cut,
    wind: 1,
  };
  return { label: cut === "queue" ? "queue de cheval" : "cheveux", bone: "head", role: ROLE.hair, hair: spec, head: { c: head, r }, colliders: bodyColliders(k, ["torso", "neck", "arms"]) };
}
