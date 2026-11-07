/**
 * Outillage commun des modules du personnage : squelette, proportions, raccourcis de position sur les os et
 * accumulation de primitives (os porteur, drapé, motif, groupe de soudure).
 */
import { type V3, lerp3, mix } from "../../core/math";
import type { Rng } from "../../core/rng";
import type { Blend, FieldPrim } from "../../geom/implicit";
import type { Proportions } from "../../rig/humanoid";
import type { BoneDef, Skeleton } from "../../rig/skeleton";
import type { Look } from "./look";

export type Kit = {
  look: Look;
  P: Proportions;
  skel: Skeleton;
  H: number;
  /** Cellule de polygonisation du corps (m). */
  cell: number;
  /** Épaisseur d'un vêtement (m). */
  thick: number;
  /** Facteur de carrure. */
  bw: number;
  v: Rng;
  B: (name: string) => BoneDef;
  at: (bone: string, t: number) => V3;
  rad: (bone: string, t: number) => number;
};

export function makeKit(look: Look, P: Proportions, skel: Skeleton, cell: number, thick: number, v: Rng): Kit {
  const B = (n: string) => skel.bones[skel.index[n]];
  return {
    look, P, skel, H: P.H, cell, thick, bw: 0.82 + 0.4 * look.build, v, B,
    at: (bone, t) => lerp3(B(bone).head, B(bone).tail, t),
    rad: (bone, t) => mix(B(bone).radius[0], B(bone).radius[1], t),
  };
}

/** Motif d'un vêtement : fonction scalaire (signe = rôle) et rôle alternatif. */
export type Pattern = { fn: (p: V3) => number; alt: number };

/** Liste de primitives d'un champ, avec os porteur, groupe de soudure, drapé et motif. */
export class PrimSet {
  prims: FieldPrim[] = [];
  bone: number[] = [];
  group: string[] = [];
  drape: boolean[] = [];
  pattern: (Pattern | null)[] = [];
  /** Primitive entièrement recouverte par celle-ci (-1 sinon) : elle ne peut pas affleurer, on la retire du champ. */
  covers: number[] = [];
  extraBlends: Blend[] = [];
  constructor(private skel: Skeleton) {}
  add(f: FieldPrim, bone: string, group: string, opts: { drape?: boolean; pattern?: Pattern | null; covers?: number } = {}): number {
    this.prims.push(f);
    this.bone.push(this.skel.index[bone] ?? 0);
    this.group.push(group);
    this.drape.push(!!opts.drape);
    this.pattern.push(opts.pattern ?? null);
    this.covers.push(opts.covers ?? -1);
    return this.prims.length - 1;
  }
  /** Retire les primitives recouvertes (sans découpe chez la couvrante) ; rend la table ancien → nouvel indice. */
  dropCovered(): number[] {
    const dead = new Set<number>();
    this.covers.forEach((c, j) => c >= 0 && !this.prims[j].clip && dead.add(c));
    const map: number[] = [];
    const keep = (_: unknown, i: number) => !dead.has(i);
    this.prims.forEach((_, i) => (map[i] = dead.has(i) ? -1 : i - [...dead].filter((d) => d < i).length));
    this.prims = this.prims.filter(keep);
    this.bone = this.bone.filter(keep);
    this.group = this.group.filter(keep);
    this.drape = this.drape.filter(keep);
    this.pattern = this.pattern.filter(keep);
    this.covers = this.covers.filter(keep).map((c) => (c >= 0 ? map[c] : -1));
    return map;
  }
  /** Soudures douces entre toutes les primitives d'un même groupe et d'un même rôle. */
  groupBlends(k: (group: string) => number): Blend[] {
    const by = new Map<string, number[]>();
    this.prims.forEach((f, i) => {
      const key = `${this.group[i]}|${f.role}`;
      (by.get(key) ?? by.set(key, []).get(key)!).push(i);
    });
    const out: Blend[] = [...this.extraBlends];
    for (const [key, list] of by) {
      const kk = k(key.split("|")[0]);
      if (kk <= 0) continue;
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) out.push({ a: list[a], b: list[b], k: kk });
    }
    return out;
  }
}

/** Ellipsoïde ou capsule gonflé(e) de `extra` (couche de vêtement). */
export function inflate(f: FieldPrim, extra: number, role: number): FieldPrim {
  const g = f.clip ? { ...f, clip: f.clip.map((c) => ({ ...c, d: c.d + extra })) } : f;
  if (g.kind === "ellipsoid") return { ...g, r: [g.r[0] + extra, g.r[1] + extra, g.r[2] + extra], role };
  if (g.kind === "capsule") return { ...g, ra: g.ra + extra, rb: g.rb + extra, role };
  if (g.kind === "box") return { ...g, h: [g.h[0] + extra, g.h[1] + extra, g.h[2] + extra], round: g.round + extra, role };
  if (g.kind === "sphere") return { ...g, r: g.r + extra, role };
  return { ...g, role };
}

/** Primitive sans rôle ni étiquette (Omit distributif sur l'union). */
export type PrimIn = FieldPrim extends infer T ? (T extends unknown ? Omit<T, "role" | "tag"> : never) : never;
