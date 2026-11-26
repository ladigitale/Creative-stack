/**
 * Champ implicite du corps (cou → pieds) et garde-robe en couches sur les mêmes os.
 *
 * La tête et les mains ont leur propre maillage, plus fin (voir head.ts, hands.ts) : le corps s'arrête au poignet et
 * sous le menton, où ces pièces le recouvrent. Un vêtement est une couche plus large sur les mêmes os ; une surcouche
 * (gilet, veste, plastron, tablier) est plus large encore. Les motifs (rayures, carreaux) sont des fonctions scalaires
 * dont le signe choisit le rôle : la découpe des triangles en fait des bords nets.
 */
import { type V3, add, clamp, cross, dot, mix, norm, sub } from "../../core/math";
import { type Blend, Field, type FieldPrim } from "../../geom/implicit";
import { HUMANOID_BLENDS } from "../../rig/humanoid";
import { ROLE } from "../../style/roles";
import { type Kit, type Pattern, PrimSet, inflate } from "./kit";
import type { SoftPiece } from "../types";
import { capePiece, scarfPiece, skirtPiece, softCloth } from "./soft";

/** Pièce rigide posée sur la surface après polygonisation (bouton, boucle, poche). */
export type Decal = { at: V3; dir: V3; kind: "button" | "buckle" | "pocket" | "flap"; role: number; size: number; up?: V3 };

export type BodyField = {
  set: PrimSet;
  blends: Blend[];
  decals: Decal[];
  hipC: V3;
  chestC: V3;
  chestR: V3;
  backZ: number;
  /** Rôles couverts par un motif. */
  patterned: boolean;
  /** Pièces en tissu simulé (`soft`, `cape`). */
  soft: SoftPiece[];
};

export function buildBodyField(k: Kit): BodyField {
  const { look, P, H, thick, bw, at, rad, B, v } = k;
  const set = new PrimSet(k.skel);
  /** Silhouette habillée déjà posée (buste, bassin, vêtements ; sans bras, sacs ni ceinture) : pour poser un accessoire dessus. */
  const outerField = () => {
    const skip = new Set(["upperarm", "forearm", "hand", "bag", "belt", "tail"]);
    // rien de ce qui suit les bras (manches de veste, gants…) : la silhouette du buste seule
    const armBone = (i: number) => /arm|hand|clavicle/.test(k.skel.bones[set.bone[i]]?.name ?? "");
    return new Field(set.prims.filter((_, i) => !skip.has(set.group[i]) && !armBone(i)));
  };
  /**
   * Ellipse horizontale ajustée à la silhouette habillée à la hauteur de `c` : demi-largeur, demi-profondeur et centre en z
   * (ventre devant, dos plat), puis agrandie juste assez pour contenir les diagonales.
   */
  const fitWaist = (c: V3, rx0: number, rz0: number): { rx: number; rz: number; cz: number } => {
    const f = outerField();
    const hits: [number, number][] = [];
    for (let i = 0; i < 32; i++) {
      const t = (i / 32) * Math.PI * 2;
      const d: V3 = [Math.sin(t), 0, Math.cos(t)];
      // rayons partis d'un peu au-delà de l'estimation : on ne va pas chercher ce qui pend loin du buste
      const R0 = Math.max(rx0, rz0) * 1.7;
      const hit = f.raycast(add(c, d.map((x) => x * R0) as V3), d.map((x) => -x) as V3, R0, H * 0.0005);
      if (hit) hits.push([hit[0] - c[0], hit[2] - c[2]]);
    }
    if (hits.length < 8) return { rx: rx0, rz: rz0, cz: c[2] };
    const xs = hits.map((h) => Math.abs(h[0])), zs = hits.map((h) => h[1]);
    const zmax = Math.max(...zs), zmin = Math.min(...zs);
    let rx = Math.max(...xs), rz = (zmax - zmin) / 2;
    const oz = (zmax + zmin) / 2;
    let sc = 1;
    for (const [x, z] of hits) sc = Math.max(sc, Math.hypot(x / rx, (z - oz) / rz));
    rx *= sc;
    rz *= sc;
    return { rx, rz, cz: c[2] + oz };
  };
  const S = ROLE.skin;
  const C1 = ROLE.cloth1, C2 = ROLE.cloth2, C3 = ROLE.cloth3, LE = ROLE.leather, MT = ROLE.metal;
  const groups: Record<string, number[]> = {};
  const put = (group: string, f: FieldPrim, bone: string, opts: { drape?: boolean; pattern?: Pattern | null; covers?: number } = {}) => {
    const i = set.add(f, bone, group, opts);
    (groups[group] ??= []).push(i);
    return i;
  };
  const cap = (bone: string, t0: number, t1: number, extra: number, role: number, mul = 1): FieldPrim => ({ kind: "capsule", a: at(bone, t0), b: at(bone, t1), ra: rad(bone, t0) * mul + extra, rb: rad(bone, t1) * mul + extra, role, tag: 0 });
  // jupe, pan de manteau : cône arrondi prolongé sous l'ourlet puis coupé net (ourlet droit, pas de « sac »)
  const skirt = (topY: number, topZ: number, hemY: number, ra: number, rb: number, role: number, extra: Partial<FieldPrim> = {}): FieldPrim => {
    const over = rb * 0.9;
    const b: V3 = [0, hemY - over, -H * 0.014];
    const t = (hemY - topY) / (b[1] - topY);
    return { kind: "capsule", a: [0, topY, topZ], b, ra, rb: ra + (rb - ra) / Math.max(0.3, t), role, tag: 0, ...extra, clip: [...((extra as { clip?: FieldPrim["clip"] }).clip ?? []), { n: [0, -1, 0], d: -hemY }] } as FieldPrim;
  };
  const soft: SoftPiece[] = [];
  const clothSoft = softCloth(k);
  /**
   * Jupe souple : empiècement rigide de la taille aux hanches (champ du corps), tube simulé dessous (bassin). Rend la
   * primitive rigide à poser à la place de `skirt(…)`.
   */
  /** Volumes des jupes et robes (sphères sur le bassin) : une cape tombe par-dessus au lieu de les traverser. */
  const skirtCols: NonNullable<SoftPiece["colliders"]> = [];
  const noteSkirt = (topY: number, topZ: number, hemY: number, ra: number, rb: number) => {
    for (const t of [0.12, 0.45, 0.8]) {
      const r = mix(ra, rb, t) * 1.04 + thick;
      skirtCols.push({ bone: "pelvis", c: [0, mix(topY, hemY, t) + r * 0.3, topZ], r });
    }
  };
  const withSkirts = (p: SoftPiece): SoftPiece => (skirtCols.length ? { ...p, colliders: [...(p.colliders ?? []), ...skirtCols] } : p);
  const drapeSkirt = (topY: number, topZ: number, hemY: number, ra: number, rb: number, role: number): FieldPrim => {
    const yokeY = topY - Math.min(H * 0.085, (topY - hemY) * 0.3);
    const t = (topY - yokeY) / Math.max(1e-3, topY - hemY);
    const ry = ra + (rb - ra) * t;
    // haut du tube glissé sous l'empiècement (pas de jour à la couture)
    soft.push(skirtPiece(k, yokeY + H * 0.012, topZ, hemY, ry * 0.97, rb, role));
    return skirt(topY, topZ, yokeY, ra, ry, role);
  };
  // trapèze → épaule : fin côté cou (le cou reste dégagé), plein à l'épaule
  const clav = (s: string, extra: number): FieldPrim => ({ kind: "capsule", a: add(at(`clavicle.${s}`, 0.42), [0, -H * 0.006, 0]), b: at(`clavicle.${s}`, 1), ra: rad(`clavicle.${s}`, 0.4) * 0.62 * bw + extra, rb: rad(`clavicle.${s}`, 1) * bw + extra, role: S, tag: 0 });

  /* ---------- peau ---------- */
  const hipC: V3 = [0, P.hipY + H * 0.01, -H * 0.008];
  const torsoD = P.torsoD;
  put("pelvis", { kind: "ellipsoid", c: hipC, r: [P.hipHalf * 1.32 * bw, H * 0.068, H * 0.072 * torsoD * bw], role: S, tag: 0 }, "pelvis");
  put("spine", cap("spine", 0, 1, 0, S, bw), "spine");
  /* ---------- queue (personnage animal, fiche animal.ts) ---------- */
  const tl = look.animalSpec?.tail;
  if (tl && tl.shape !== "none" && tl.length > 0) {
    const L = tl.length;
    const b0: V3 = [0, P.hipY - H * 0.005, hipC[2] - H * 0.072 * torsoD * bw * 0.85];
    const TIP = ROLE.paper, MANE = ROLE.hair;
    const chain = (pts: V3[], rs: number[], role = S) => {
      for (let i = 0; i + 1 < pts.length; i++) put("tail", { kind: "capsule", a: pts[i], b: pts[i + 1], ra: rs[i], rb: rs[i + 1], role, tag: 0 }, "pelvis");
    };
    const o = (x: number, y: number, z: number): V3 => [b0[0] + x * H * L, b0[1] + y * H * L, b0[2] - z * H * L];
    const ball = (c: V3, r: number, role: number) => put("tail", { kind: "ellipsoid", c, r: [r, r, r * 1.2], role, tag: 0 }, "pelvis");
    switch (tl.shape) {
      case "curve":
        chain([o(0, 0, 0), o(0, -0.05, 0.1), o(0, 0.04, 0.2), o(0, 0.17, 0.24), o(0, 0.25, 0.21)], [0.02, 0.019, 0.018, 0.017, 0.015].map((r) => r * H));
        if (tl.tip) ball(o(0, 0.25, 0.21), H * 0.019, TIP);
        break;
      case "bushy":
        chain([o(0, 0, 0), o(0, -0.06, 0.12), o(0, -0.04, 0.26)], [0.03, 0.055, 0.05].map((r) => r * H));
        ball(o(0, -0.02, 0.33), H * 0.042, tl.tip ? TIP : S);
        break;
      case "wag":
        chain([o(0, 0, 0), o(0, 0.06, 0.09), o(0, 0.15, 0.13)], [0.02, 0.018, 0.012].map((r) => r * H));
        break;
      case "stub":
        ball(o(0, 0.01, 0.02), H * 0.034, S);
        break;
      case "pom":
        ball(o(0, 0.01, 0.025), H * 0.043, tl.tip ? TIP : ROLE.white);
        break;
      case "long":
        chain([o(0, 0, 0), o(0, -0.08, 0.12), o(0, -0.1, 0.3), o(0.03, -0.05, 0.42)], [0.012, 0.01, 0.008, 0.005].map((r) => r * H));
        break;
      case "curl":
        chain([o(0, 0, 0), o(0.02, 0.03, 0.04), o(-0.01, 0.05, 0.06), o(0.0, 0.03, 0.08)], [0.011, 0.01, 0.009, 0.008].map((r) => r * H));
        break;
      case "fan":
        put("tail", { kind: "ellipsoid", c: o(0, -0.06, 0.04), r: [H * 0.06 * L, H * 0.07 * L, H * 0.018], role: S, tag: 0 }, "pelvis");
        break;
      case "thick":
        chain([o(0, 0.02, 0), o(0, -0.12, 0.14), o(0, -0.24, 0.32), o(0, -0.3, 0.52)], [0.06, 0.05, 0.03, 0.012].map((r) => r * H));
        break;
      case "tuft":
        chain([o(0, 0, 0), o(0, -0.1, 0.12), o(0, -0.22, 0.24)], [0.012, 0.01, 0.009].map((r) => r * H));
        ball(o(0, -0.25, 0.26), H * 0.03, MANE);
        break;
    }
  }
  if (look.belly > 0.05) put("spine", { kind: "ellipsoid", c: add(at("spine", 0.35), [0, 0, H * 0.025 * look.belly]), r: [H * (0.075 + 0.03 * look.belly) * bw, H * 0.075, H * (0.06 + 0.045 * look.belly) * bw], role: S, tag: 0 }, "spine");
  const chestC = add(at("chest", 0.45), [0, 0, H * 0.004]);
  const chestR: V3 = [P.shoulderHalf * 0.88 * mix(0.95, 1.08, look.build), H * 0.1, H * 0.068 * torsoD * bw];
  // haut du torse aplani sous les épaules : le cou reste dégagé
  put("chest", { kind: "ellipsoid", c: chestC, r: chestR, role: S, tag: 0, clip: [{ n: [0, 1, 0], d: P.shoulderY + H * 0.004, k: H * 0.02 }] }, "chest");
  // poitrine : deux volumes doux sur le haut du torse (ou pectoraux marqués pour les carrures massives)
  const bust = look.body.bust;
  if (bust > 0.08) {
    for (const sx of [1, -1]) {
      const r = H * (0.03 + 0.022 * bust) * bw;
      put("chest", { kind: "ellipsoid", c: add(chestC, [sx * chestR[0] * 0.42, -chestR[1] * 0.28, chestR[2] * 0.62 - r * 0.15]), r: [r * 1.05, r * 0.92, r * 0.85], role: S, tag: 0 }, "chest");
    }
  } else if (look.build > 0.65 && look.figure === "masculine") {
    for (const sx of [1, -1]) put("chest", { kind: "ellipsoid", c: add(chestC, [sx * chestR[0] * 0.4, chestR[1] * 0.05, chestR[2] * 0.55]), r: [chestR[0] * 0.42, chestR[1] * 0.38, chestR[2] * 0.45], role: S, tag: 0 }, "chest");
  }
  // cou : effilé vers le haut, son extrémité est recouverte par le maillage de la tête
  put("neck", { kind: "capsule", a: at("neck", -0.1), b: at("neck", 0.82), ra: rad("neck", 0) * 1.02, rb: rad("neck", 1) * 0.86, role: S, tag: 0 }, "neck");
  for (const s of ["l", "r"]) {
    put("clavicle", clav(s, 0), `clavicle.${s}`);
    put("upperarm", cap(`upperarm.${s}`, 0, 1, 0, S, bw), `upperarm.${s}`);
    put("forearm", cap(`forearm.${s}`, 0, 1, 0, S, mix(0.95, 1.1, look.build)), `forearm.${s}`);
    put("thigh", cap(`thigh.${s}`, 0, 1, 0, S, bw), `thigh.${s}`);
    put("shin", cap(`shin.${s}`, 0, 1, 0, S, mix(0.95, 1.08, look.build)), `shin.${s}`);
    const fb = B(`foot.${s}`);
    const fr = fb.radius[0];
    put("foot", { kind: "capsule", a: add(fb.head, [0, -fr * 0.2, -fr * 0.6]), b: add(fb.tail, [0, fr * 0.05, 0]), ra: fr * 0.95, rb: fr * 0.9, role: S, tag: 0 }, `foot.${s}`);
    put("toe", cap(`toe.${s}`, 0, 1, 0, S), `toe.${s}`);
  }
  const torsoIdx = [...groups.chest, ...groups.spine];
  const pelvisIdx = groups.pelvis[0];
  const neckR = rad("neck", 0);

  /* ---------- motifs ---------- */
  // période d'au moins 3 cellules : la découpe suit une frontière par arête, pas de crénelage
  const per = Math.max(H * (look.pattern === "checks" ? 0.05 : 0.04), k.cell * (look.pattern === "checks" ? 3.6 : 3));
  const torsoAxisZ = chestC[2];
  const around = (p: V3) => Math.atan2(p[0], p[2] - torsoAxisZ);
  const nAround = Math.max(8, Math.round((2 * Math.PI * chestR[0]) / (per * 1.1)));
  const torsoPat = (): Pattern | null => {
    switch (look.pattern) {
      case "stripes":
        return { fn: (p) => Math.sin((2 * Math.PI * p[1]) / per), alt: C3 };
      case "vstripes":
        return { fn: (p) => Math.sin(nAround * around(p)), alt: C3 };
      case "checks":
        return { fn: (p) => Math.sin((2 * Math.PI * p[1]) / per) * Math.sin(nAround * 0.75 * around(p)), alt: C3 };
    }
    return null;
  };
  const limbPat = (bone: string): Pattern | null => {
    if (look.pattern !== "stripes" && look.pattern !== "checks") return null;
    const b = B(bone);
    const ax = norm(sub(b.tail, b.head));
    const u = norm(cross(ax, [0, 0, 1]));
    const w = cross(ax, u);
    const nA = Math.max(6, Math.round((2 * Math.PI * b.radius[0]) / per));
    if (look.pattern === "stripes") return { fn: (p) => Math.sin((2 * Math.PI * dot(sub(p, b.head), ax)) / per), alt: C3 };
    return { fn: (p) => {
      const q = sub(p, b.head);
      return Math.sin((2 * Math.PI * dot(q, ax)) / per) * Math.sin(nA * 0.75 * Math.atan2(dot(q, u), dot(q, w)));
    }, alt: C3 };
  };

  /* ---------- haut ---------- */
  const top = look.top;
  const knee = B("shin.l").head[1];
  const decals: Decal[] = [];
  const frontZ = (y: number) => chestC[2] + chestR[2] * Math.sqrt(Math.max(0.2, 1 - ((y - chestC[1]) / chestR[1]) ** 2)) + thick;
  if (top !== "none") {
    const pat = torsoPat();
    for (const i of torsoIdx) put("chest", inflate(set.prims[i], thick, C1), k.skel.bones[set.bone[i]].name, { pattern: pat, covers: i });
    const longTop = top === "coat" || top === "robe" || top === "tunic" || top === "dress";
    if (!longTop) put("pelvis", { kind: "ellipsoid", c: add(hipC, [0, H * 0.035, 0]), r: [P.hipHalf * 1.3 * bw + thick * 1.15, H * 0.045, H * 0.07 * torsoD * bw + thick * 1.15], role: C1, tag: 0 }, "pelvis", { pattern: pat });
    const sleeve = ({ tee: [0.55, 0], long: [1, 0.93], tank: [0, 0], sweater: [1, 0.95], shirt: [1, 0.92], tunic: [1, 0.88], coat: [1, 0.9], robe: [1, 0.95], dress: [0.32, 0] } as Record<string, number[]>)[top] ?? [0, 0];
    const wide = top === "robe" ? 1.15 : 1;
    for (const s of ["l", "r"]) {
      if (top !== "tank") put("clavicle", { ...clav(s, thick), role: C1 }, `clavicle.${s}`, { pattern: pat, covers: groups.clavicle[s === "l" ? 0 : 1] });
      if (sleeve[0] > 0) put("upperarm", cap(`upperarm.${s}`, 0, sleeve[0], thick * (top === "dress" ? 1.4 : 1), C1, bw * wide), `upperarm.${s}`, { pattern: limbPat(`upperarm.${s}`), covers: sleeve[0] >= 1 ? groups.upperarm[s === "l" ? 0 : 1] : -1 });
      if (sleeve[1] > 0) {
        put("forearm", cap(`forearm.${s}`, 0, top === "robe" ? 0.8 : sleeve[1], thick * (top === "robe" ? 1.5 : 1), C1, top === "robe" ? 1.15 : 1), `forearm.${s}`, { pattern: limbPat(`forearm.${s}`) });
        // poignet : revers un peu plus épais (rôle détail pour les manteaux)
        if (top !== "robe") put("forearm", cap(`forearm.${s}`, sleeve[1] - 0.13, sleeve[1], thick * 1.3, top === "coat" ? C3 : C1, 1), `forearm.${s}`);
      }
    }
    if (top === "coat" || top === "robe" || top === "tunic") {
      // pans tombants (poids mêlés bassin + cuisses)
      const bottomY = top === "robe" ? P.ankleY + H * 0.03 : top === "coat" ? knee - H * 0.01 : P.crotchY - H * 0.07;
      const flare = top === "robe" ? 2.05 : top === "coat" ? 1.75 : 1.55;
      const mk = clothSoft && top !== "tunic" ? drapeSkirt : skirt;
      noteSkirt(P.hipY + H * 0.03, -H * 0.005, bottomY, P.hipHalf * 1.32 * bw + thick, P.hipHalf * flare * bw + thick);
      put("pelvis", mk(P.hipY + H * 0.03, -H * 0.005, bottomY, P.hipHalf * 1.32 * bw + thick, P.hipHalf * flare * bw + thick, C1), "pelvis", { drape: true, pattern: top === "tunic" ? pat : null });
    }
    if (top === "dress") {
      const waist = at("spine", 0.2);
      noteSkirt(waist[1], waist[2], P.ankleY, rad("spine", 0.2) * bw + thick * 1.2, P.hipHalf * 1.95 * bw + thick);
      put("pelvis", (clothSoft ? drapeSkirt : skirt)(waist[1], waist[2], P.ankleY + H * (0.05 + v.range(0, 0.12)), rad("spine", 0.2) * bw + thick * 1.2, P.hipHalf * 1.95 * bw + thick, C1), "pelvis", { drape: true, pattern: look.pattern === "stripes" || look.pattern === "checks" ? pat : null });
    }
    if (top === "shirt" || top === "coat" || top === "robe") {
      // patte de boutonnage (une ligne de boutons)
      if ((look.details === "buttons" || look.details === "full") && look.over === "none") {
        const y0 = chestC[1] + chestR[1] * 0.5, y1 = top === "coat" ? knee + H * 0.06 : hipC[1] + H * 0.05;
        const n = Math.max(3, Math.round((y0 - y1) / (H * 0.045)));
        for (let i = 0; i <= n; i++) {
          const y = mix(y0, y1, i / n);
          decals.push({ at: [0, y, frontZ(y)], dir: [0, 0, 1], kind: "button", role: top === "coat" ? MT : C3, size: H * 0.0065 });
        }
      }
    }
  }

  /* ---------- col ---------- */
  const neckBase = at("neck", 0.08);
  switch (look.collar) {
    case "round":
      put("neck", { kind: "ellipsoid", c: add(neckBase, [0, -H * 0.004, H * 0.002]), r: [neckR * 1.35 + thick, H * 0.011, neckR * 1.3 + thick], role: C1, tag: 0 }, "neck");
      break;
    case "turtle":
      put("neck", cap("neck", -0.1, 0.5, thick * 0.9, C1), "neck");
      break;
    case "shirt":
      for (const sx of [1, -1]) {
        // revers pointu : deux capsules (bord du cou → pointe sur la poitrine)
        const a0: V3 = add(neckBase, [sx * neckR * 1.05, H * 0.012, -neckR * 0.2]);
        const a1: V3 = add(neckBase, [sx * neckR * 0.95, H * 0.004, neckR * 1.05]);
        const tip: V3 = add(neckBase, [sx * neckR * 0.45, -H * 0.038, neckR * 1.3 + thick]);
        put("neck", { kind: "capsule", a: a0, b: a1, ra: thick * 0.6 + H * 0.004, rb: thick * 0.6 + H * 0.004, role: C3, tag: 0 }, "neck");
        put("chest", { kind: "capsule", a: a1, b: tip, ra: thick * 0.6 + H * 0.004, rb: H * 0.003 + thick * 0.4, role: C3, tag: 0 }, "chest");
      }
      put("neck", { kind: "capsule", a: add(neckBase, [neckR * 1.05, H * 0.012, -neckR * 0.2]), b: add(neckBase, [-neckR * 1.05, H * 0.012, -neckR * 0.2]), ra: thick * 0.6 + H * 0.005, rb: thick * 0.6 + H * 0.005, role: C3, tag: 0 }, "neck");
      break;
  }

  /* ---------- surcouches ---------- */
  const over = look.over;
  const tk2 = thick * 1.9;
  const zc = chestC[2] - chestR[2] * 0.15;
  const openFront = (role: number, extra: number, gap: number, slope: number) => {
    // deux pans avant ouverts en V + un dos
    for (const i of torsoIdx) {
      const f = inflate(set.prims[i], extra, role);
      const bone = k.skel.bones[set.bone[i]].name;
      const y0 = chestC[1] - chestR[1] * 0.2;
      for (const sx of [1, -1]) {
        const n = norm([-sx, slope, 0]);
        put("over", { ...f, clip: [{ n, d: dot(n, [sx * gap, y0, 0]) }, { n: [0, 0, -1], d: -zc }] }, bone);
      }
      put("over", { ...f, clip: [{ n: [0, 0, 1], d: zc + H * 0.004 }] }, bone);
    }
  };
  if (over === "vest" || over === "jacket") {
    // le gilet ne reprend pas la couleur des rayures du haut
    const role = over === "vest" ? (look.role === "worker" || look.pattern !== "plain" ? LE : C3) : C2;
    if (over === "vest") openFront(role, tk2, H * 0.012, 0.55);
    else openFront(role, tk2, H * 0.03, 0.3);
    for (const s of ["l", "r"]) put("over", { ...clav(s, tk2), role }, `clavicle.${s}`);
    if (over === "jacket") {
      for (const s of ["l", "r"]) {
        put("over", cap(`upperarm.${s}`, 0, 1, tk2, role, bw), `upperarm.${s}`);
        put("over", cap(`forearm.${s}`, 0, 0.86, tk2, role, 1), `forearm.${s}`);
        put("over", cap(`forearm.${s}`, 0.74, 0.86, tk2 * 1.3, role, 1), `forearm.${s}`);
      }
      for (const sx of [1, -1]) {
        const n = norm([-sx, 0, 0.2]);
        put("pelvis", skirt(P.hipY + H * 0.04, -H * 0.005, P.crotchY - H * 0.01, P.hipHalf * 1.32 * bw + tk2, P.hipHalf * 1.42 * bw + tk2, role, { clip: [{ n, d: dot(n, [sx * H * 0.02, 0, chestC[2]]) }, { n: [0, 0, -1], d: -zc }] }), "pelvis", { drape: true });
      }
      put("pelvis", skirt(P.hipY + H * 0.04, -H * 0.005, P.crotchY - H * 0.01, P.hipHalf * 1.32 * bw + tk2, P.hipHalf * 1.42 * bw + tk2, role, { clip: [{ n: [0, 0, 1], d: zc + H * 0.004 }] }), "pelvis", { drape: true });
    }
    if (look.details !== "none" && look.details !== "pockets") {
      const n = 3 + (over === "vest" ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const y = mix(chestC[1] - chestR[1] * 0.25, hipC[1] + H * 0.07, i / (n - 1));
        decals.push({ at: [H * 0.02, y, frontZ(y) + tk2 - thick], dir: [0, 0, 1], kind: "button", role: over === "vest" ? MT : C3, size: H * 0.0068 });
      }
    }
  }
  if (over === "armor") {
    const y0 = at("spine", 0.15)[1];
    for (const i of torsoIdx) put("over", { ...inflate(set.prims[i], thick * 2.4, MT), clip: [{ n: [0, -1, 0], d: -y0, k: H * 0.01 }] }, k.skel.bones[set.bone[i]].name);
    for (const s of ["l", "r"]) {
      const sx = s === "l" ? 1 : -1;
      const sh = at(`upperarm.${s}`, 0.08);
      const r = rad(`upperarm.${s}`, 0) * bw;
      put("pauldron", { kind: "ellipsoid", c: add(sh, [sx * r * 0.2, r * 0.35, 0]), r: [r * 1.55 + thick, r * 1.05 + thick, r * 1.45 + thick], role: MT, tag: 0, clip: [{ n: [0, -1, 0], d: -(sh[1] - r * 0.35) }] }, `upperarm.${s}`);
    }
    // jupe de plates : bande sous le plastron
    put("pelvis", skirt(y0, -H * 0.005, P.hipY - H * 0.06, rad("spine", 0.15) * bw + thick * 2, P.hipHalf * 1.36 * bw + thick * 1.7, LE), "pelvis", { drape: true });
  }

  /* ---------- bas ---------- */
  const bottom = look.bottom;
  const covered = top === "robe" || top === "dress";
  if (!covered) {
    put("pelvis", inflate(set.prims[pelvisIdx], thick * 0.6, C2), "pelvis", { covers: pelvisIdx });
    for (const s of ["l", "r"]) {
      if (bottom === "trousers" || bottom === "overalls") {
        put("thigh", cap(`thigh.${s}`, 0, 1, thick * 0.6, C2, bw), `thigh.${s}`, { covers: groups.thigh[s === "l" ? 0 : 1] });
        put("shin", cap(`shin.${s}`, 0, 0.92, thick * 0.6, C2, 1.04), `shin.${s}`);
      } else if (bottom === "shorts") put("thigh", cap(`thigh.${s}`, 0, 0.62, thick * 0.7, C2, bw * 1.08), `thigh.${s}`);
    }
    if (bottom === "skirt" || bottom === "longskirt") {
      const endY = bottom === "longskirt" ? P.ankleY + H * 0.05 : knee + H * 0.03;
      noteSkirt(P.hipY + H * 0.02, -H * 0.006, endY, P.hipHalf * 1.3 * bw + thick * 0.7, P.hipHalf * (bottom === "longskirt" ? 1.85 : 1.65) * bw + thick);
      put("pelvis", (clothSoft ? drapeSkirt : skirt)(P.hipY + H * 0.02, -H * 0.006, endY, P.hipHalf * 1.3 * bw + thick * 0.7, P.hipHalf * (bottom === "longskirt" ? 1.85 : 1.65) * bw + thick, C2), "pelvis", { drape: true });
    }
    if (bottom === "overalls") {
      // bavette + bretelles
      const by0 = hipC[1] + H * 0.04, by1 = chestC[1] - chestR[1] * 0.1;
      const bz = frontZ((by0 + by1) / 2) + thick * 0.4;
      put("spine", { kind: "box", c: [0, (by0 + by1) / 2, bz - H * 0.012], h: [chestR[0] * 0.48, (by1 - by0) / 2, H * 0.016], round: H * 0.01, role: C2, tag: 0 }, "spine");
      for (const sx of [1, -1]) {
        const a: V3 = [sx * chestR[0] * 0.38, by1, bz - H * 0.006];
        const b: V3 = add(at(`clavicle.${sx > 0 ? "l" : "r"}`, 0.55), [0, rad(`clavicle.${sx > 0 ? "l" : "r"}`, 0.55) * bw + thick * 1.3, 0]);
        const c: V3 = [sx * chestR[0] * 0.3, chestC[1] - chestR[1] * 0.3, chestC[2] - chestR[2] - thick * 1.3];
        put("chest", { kind: "capsule", a, b, ra: H * 0.007 + thick * 0.5, rb: H * 0.007 + thick * 0.5, role: C2, tag: 0 }, "chest");
        put("chest", { kind: "capsule", a: b, b: c, ra: H * 0.007 + thick * 0.5, rb: H * 0.007 + thick * 0.5, role: C2, tag: 0 }, "chest");
        decals.push({ at: [sx * chestR[0] * 0.38, by1 - H * 0.012, bz + H * 0.01], dir: [0, 0, 1], kind: "button", role: MT, size: H * 0.008 });
      }
    }
  }

  /* ---------- tablier ---------- */
  if (over === "apron") {
    const role = ROLE.paper;
    const waist = at("spine", 0.3);
    const by1 = chestC[1] + chestR[1] * 0.15;
    const bz = frontZ(by1 - H * 0.04);
    put("over", { kind: "box", c: [0, (by1 + waist[1]) / 2, bz - H * 0.006], h: [chestR[0] * 0.5, (by1 - waist[1]) / 2, H * 0.014], round: H * 0.008, role, tag: 0 }, "chest");
    {
      const yTop = waist[1] + H * 0.05, yBot = knee - H * 0.03;
      // devant le plus en avant parmi bassin, cuisses, ventre (le tablier ne doit jamais être traversé)
      const bellyZ = look.belly > 0.05 ? at("spine", 0.35)[2] + H * 0.025 * look.belly + H * (0.06 + 0.045 * look.belly) * bw : 0;
      const zf = Math.max(hipC[2] + H * 0.072 * torsoD * bw, B("thigh.l").head[2] + rad("thigh.l", 0) * bw, at("spine", 0.3)[2] + rad("spine", 0.3) * bw, bellyZ) + thick * 2.6;
      const rz = H * 0.07;
      // panneau bombé coupé net en haut et en bas
      put("over", { kind: "ellipsoid", c: [0, (yTop + yBot) / 2, zf - rz], r: [P.hipHalf * 1.45 * bw + thick, (yTop - yBot) * 0.72, rz + H * 0.008], role, tag: 0, clip: [{ n: [0, 0, -1], d: -(zf - rz * 0.55) }, { n: [0, 1, 0], d: yTop + H * 0.01 }, { n: [0, -1, 0], d: -yBot }] }, "pelvis", { drape: true });
    }
    for (const sx of [1, -1]) {
      const a: V3 = [sx * chestR[0] * 0.42, by1, bz - H * 0.004];
      const b: V3 = add(neckBase, [sx * neckR * 1.4, H * 0.004, -neckR * 0.6]);
      put("over", { kind: "capsule", a, b, ra: H * 0.005 + thick * 0.4, rb: H * 0.005 + thick * 0.4, role, tag: 0 }, "chest");
    }
    // cordon de taille
    put("over", { kind: "ellipsoid", c: waist, r: [rad("spine", 0.3) * bw + thick * 2.1, H * 0.008, rad("spine", 0.3) * bw * 0.95 + thick * 2.1], role, tag: 0 }, "spine");
    if (look.details !== "none") decals.push({ at: [chestR[0] * 0.3, hipC[1] - H * 0.02, frontZ(hipC[1]) + H * 0.04], dir: [0, 0, 1], kind: "pocket", role, size: H * 0.045 });
  }

  /* ---------- ceinture ---------- */
  const waistY = top === "coat" || top === "robe" || top === "tunic" || top === "dress" ? at("spine", 0.25) : add(hipC, [0, H * 0.045, 0]);
  if (look.belt !== "none" && !(over === "apron" && look.belt === "belt")) {
    const r0 = (top === "coat" || top === "robe" || top === "tunic" || top === "dress" ? rad("spine", 0.25) * bw : P.hipHalf * 1.3 * bw) + thick * (over === "armor" ? 2.6 : 1.7);
    const rz = (top === "coat" || top === "robe" || top === "tunic" || top === "dress" ? rad("spine", 0.25) * bw * 0.95 : H * 0.07 * torsoD * bw) + thick * (over === "armor" ? 2.6 : 1.7);
    const sash = look.belt === "sash";
    // posée sur la surface réelle du vêtement à cette hauteur (manteau, robe, carrure forte : plus de ceinture qui traverse)
    const fit = fitWaist(waistY, r0, rz);
    const r0b = fit.rx + H * 0.006, rzb = fit.rz + H * 0.006;
    const wc: V3 = [waistY[0], waistY[1], fit.cz];
    put("belt", { kind: "ellipsoid", c: wc, r: [r0b, H * (sash ? 0.02 : 0.013), rzb], role: sash ? C3 : LE, tag: 0 }, top === "coat" || top === "robe" || top === "tunic" || top === "dress" ? "spine" : "pelvis");
    if (sash) {
      put("belt", { kind: "ellipsoid", c: add(wc, [r0b * 0.75, -H * 0.004, rzb * 0.6]), r: [H * 0.02, H * 0.018, H * 0.016], role: C3, tag: 0 }, "pelvis");
      put("belt", { kind: "capsule", a: add(wc, [r0b * 0.78, -H * 0.01, rzb * 0.62]), b: add(wc, [r0b * 0.92, -H * 0.11, rzb * 0.5]), ra: H * 0.012, rb: H * 0.009, role: C3, tag: 0 }, "pelvis", { drape: true });
    } else decals.push({ at: [0, wc[1], wc[2] + rzb + H * 0.02], dir: [0, 0, 1], kind: "buckle", role: MT, size: H * 0.017 });
  }
  if (look.details === "pockets" || look.details === "full") {
    const shirtish = top === "shirt" || over === "jacket" || top === "coat";
    if (shirtish && (look.over === "none" || look.over === "jacket")) decals.push({ at: [chestR[0] * 0.45, chestC[1] + chestR[1] * 0.05, frontZ(chestC[1]) + (over === "jacket" ? tk2 : 0) + H * 0.02], dir: [0, 0, 1], kind: "pocket", role: over === "jacket" ? C2 : C1, size: H * 0.035 });
    if (!covered && (bottom === "trousers" || bottom === "overalls" || bottom === "shorts") && over !== "apron" && top !== "coat" && top !== "tunic")
      for (const sx of [1, -1]) decals.push({ at: [sx * P.hipHalf * 1.25 * bw, P.hipY - H * 0.035, H * 0.08], dir: norm([sx * 0.6, 0, 1]), kind: "flap", role: LE, size: H * 0.03 });
  }

  /* ---------- gants ---------- */
  if (look.gloves === "gloves")
    for (const s of ["l", "r"]) put("forearm", cap(`forearm.${s}`, 0.74, 1.0, thick * (top === "robe" ? 0.8 : 1.15), LE, 1.04), `forearm.${s}`);

  /* ---------- chaussures ---------- */
  for (const s of ["l", "r"]) {
    if (look.shoes === "barefoot") continue;
    const ex = look.shoes === "sandals" ? thick * 0.25 : thick * 0.8;
    const fi = groups.foot[s === "l" ? 0 : 1];
    put("foot", inflate(set.prims[fi], ex, LE), `foot.${s}`, { covers: fi });
    put("toe", inflate(set.prims[groups.toe[s === "l" ? 0 : 1]], ex, LE), `toe.${s}`, { covers: groups.toe[s === "l" ? 0 : 1] });
    if (look.shoes === "boots") put("shin", cap(`shin.${s}`, 0.5, 1, thick * 1.25, LE, 1.05), `shin.${s}`);
    if (look.shoes === "tallboots") {
      put("shin", cap(`shin.${s}`, 0.06, 1, thick * 1.3, LE, 1.05), `shin.${s}`);
      put("shin", cap(`shin.${s}`, 0.04, 0.15, thick * 1.85, LE, 1.08), `shin.${s}`);
    }
    if (look.shoes === "shoes") put("shin", cap(`shin.${s}`, 0.9, 1, ex, LE), `shin.${s}`);
  }

  /* ---------- sacs ---------- */
  const backZ = chestC[2] - chestR[2] - thick * (over === "armor" ? 2.4 : over !== "none" ? 1.9 : 1);
  switch (look.bag) {
    case "backpack":
      put("bag", { kind: "box", c: [0, chestC[1] - H * 0.02, backZ - H * 0.05], h: [chestR[0] * 0.62, H * 0.1, H * 0.05], round: H * 0.025, role: C3, tag: 0 }, "chest");
      put("bag", { kind: "box", c: [0, chestC[1] + H * 0.05, backZ - H * 0.065], h: [chestR[0] * 0.64, H * 0.035, H * 0.05], round: H * 0.02, role: LE, tag: 0 }, "chest");
      for (const sx of [1, -1]) put("bag", { kind: "capsule", a: [sx * chestR[0] * 0.4, chestC[1] + H * 0.07, backZ - H * 0.01], b: add(at(`clavicle.${sx > 0 ? "l" : "r"}`, 0.5), [0, rad("clavicle.l", 0.5) * bw + thick * 1.4, H * 0.01]), ra: H * 0.008, rb: H * 0.008, role: LE, tag: 0 }, "chest");
      break;
    case "satchel":
    {
      // bandoulière en travers : épaule gauche → hanche droite, posée sur la poitrine et sur le dos (rayons vers le buste
      // habillé), jamais à travers le corps
      const a = add(at("clavicle.l", 0.7), [0, thick + rad("clavicle.l", 0.7) * bw * 0.8, 0]);
      const b: V3 = [-P.hipHalf * 1.2, P.hipY + H * 0.02, 0];
      const ra = thick * 1.05 + H * 0.006;
      const f = outerField();
      for (const sz of [1, -1]) {
        const pts: V3[] = [a];
        // dernier point sur la face avant / arrière de la hanche (pas sur le flanc, où pend le bras)
        for (const t of [0.25, 0.5, 0.75, 0.92]) {
          const m: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0];
          const hit = f.raycast([m[0], m[1], sz * H * 0.5], [0, 0, -sz], H * 0.5, H * 0.0005);
          pts.push(hit ? [hit[0], hit[1], hit[2] + sz * ra * 1.1] : [m[0], m[1], sz * (chestR[2] + thick * 2)]);
        }
        for (let i = 0; i + 1 < pts.length; i++) put("bag", { kind: "capsule", a: pts[i], b: pts[i + 1], ra, rb: ra, role: LE, tag: 0 }, i < 2 ? "chest" : "pelvis");
      }
    }
      // sacoche sur l'avant de la hanche (le bras qui pend ne la traverse pas), plaquée ensuite contre le vêtement
      put("bag", { kind: "box", c: [-P.hipHalf * 1.15 * bw - H * 0.02, P.hipY - H * 0.01, H * 0.04], h: [H * 0.025, H * 0.05, H * 0.065], round: H * 0.015, role: LE, tag: 0 }, "pelvis");
      break;
    case "pouch":
      put("bag", { kind: "box", c: [P.hipHalf * 1.15 * bw + thick + H * 0.016, P.hipY - H * 0.005, H * 0.04], h: [H * 0.02, H * 0.032, H * 0.035], round: H * 0.014, role: LE, tag: 0 }, "pelvis");
      break;
    case "cape": {
      const top0 = P.shoulderY + H * 0.01;
      if (look.cape === "none" && clothSoft) {
        soft.push(withSkirts(capePiece(k, "short", backZ)));
        put("bag", { kind: "ellipsoid", c: add(neckBase, [0, -H * 0.008, 0]), r: [neckR * 1.6 + thick * 1.6, H * 0.016, neckR * 1.5 + thick * 1.6], role: C3, tag: 0 }, "neck");
        break;
      }
      if (look.cape !== "none") break;
      put("bag", { kind: "capsule", a: [0, top0 - H * 0.02, backZ - H * 0.005], b: [0, P.crotchY - H * 0.1, backZ - H * 0.06], ra: P.shoulderHalf * 0.95, rb: P.shoulderHalf * 1.25, role: C3, tag: 0, clip: [{ n: [0, 0, 1], d: backZ + H * 0.012 }] }, "chest");
      put("bag", { kind: "ellipsoid", c: add(neckBase, [0, -H * 0.008, 0]), r: [neckR * 1.6 + thick * 1.6, H * 0.016, neckR * 1.5 + thick * 1.6], role: C3, tag: 0 }, "neck");
      break;
    }
    case "scarf":
      put("bag", { kind: "ellipsoid", c: at("neck", 0.15), r: [neckR * 1.9, H * 0.024, neckR * 1.9], role: C3, tag: 0 }, "neck");
      if (clothSoft) {
        const a = add(at("neck", 0), [P.headW * 0.12, 0, neckR * 1.6]);
        soft.push(scarfPiece(k, a, at("chest", 0.3)[1] - H * 0.05, chestC[2] + chestR[2] + thick * 2.5));
        break;
      }
      put("bag", { kind: "capsule", a: add(at("neck", 0), [P.headW * 0.12, 0, neckR * 1.6]), b: add(at("chest", 0.3), [P.headW * 0.2, 0, chestR[2] + thick * 2.2]), ra: H * 0.02, rb: H * 0.02, role: C3, tag: 0 }, "chest", { pattern: look.pattern === "stripes" ? { fn: (p) => Math.sin((2 * Math.PI * p[1]) / (per * 0.8)), alt: C1 } : null });
      break;
  }

  /* ---------- cape (paramètre `cape`) ---------- */
  if (look.cape === "short" || look.cape === "long") {
    soft.push(withSkirts(capePiece(k, look.cape, backZ)));
    put("bag", { kind: "ellipsoid", c: add(neckBase, [0, -H * 0.008, 0]), r: [neckR * 1.6 + thick * 1.6, H * 0.016, neckR * 1.5 + thick * 1.6], role: C3, tag: 0 }, "neck");
  }

  /* ---------- accessoires hors du corps ---------- */
  settleAccessories(set, outerField(), (y) => {
    const u = clamp((y - hipC[1]) / Math.max(1e-6, chestC[1] - hipC[1]), 0, 1);
    return hipC[2] + (chestC[2] - hipC[2]) * u;
  }, H);

  /* ---------- soudures ---------- */
  set.dropCovered();
  const blends: Blend[] = [];
  const family = (n: string) => n.replace(/\.(l|r)$/, "");
  const sideOf = (n: string) => (n.endsWith(".l") ? "l" : n.endsWith(".r") ? "r" : "");
  const bones = k.skel.bones;
  const byFam = new Map<string, number[]>();
  set.prims.forEach((_, i) => {
    const f = family(bones[set.bone[i]].name);
    (byFam.get(f) ?? byFam.set(f, []).get(f)!).push(i);
  });
  for (const [ga, gb, kk] of HUMANOID_BLENDS)
    for (const i of byFam.get(ga) ?? [])
      for (const j of byFam.get(gb) ?? []) {
        const si = sideOf(bones[set.bone[i]].name), sj = sideOf(bones[set.bone[j]].name);
        if (si && sj && si !== sj) continue;
        if (set.prims[i].role !== set.prims[j].role) continue;
        if (set.group[i] === "over" || set.group[j] === "over" || set.group[i] === "bag" || set.group[j] === "bag" || set.group[i] === "belt" || set.group[j] === "belt") continue;
        blends.push({ a: i, b: j, k: kk * H });
      }
  // primitives d'un même os et d'un même rôle : soudure douce (sauf pans découpés : bords nets)
  const byBone = new Map<number, number[]>();
  set.prims.forEach((_, i) => (byBone.get(set.bone[i]) ?? byBone.set(set.bone[i], []).get(set.bone[i])!).push(i));
  for (const list of byBone.values())
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const a = list[x], b = list[y];
        if (set.prims[a].role !== set.prims[b].role || set.group[a] === "over" || set.group[b] === "over" || set.group[a] === "belt" || set.group[b] === "belt") continue;
        blends.push({ a, b, k: H * 0.01 });
      }
  return { set, blends, decals, hipC, chestC, chestR, backZ, patterned: look.pattern !== "plain", soft };
}

/** Points du cœur d'une primitive (75 % de sa taille) : ce qui ne doit jamais se trouver dans le corps. */
export function corePoints(f: FieldPrim): V3[] {
  const out: V3[] = [];
  const k = 0.75;
  if (f.kind === "box" || f.kind === "ellipsoid") {
    const c = f.c, h = f.kind === "box" ? f.h : f.r;
    for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
      if (f.kind === "ellipsoid" && Math.abs(x) + Math.abs(y) + Math.abs(z) > 1) continue;
      out.push([c[0] + x * h[0] * k, c[1] + y * h[1] * k, c[2] + z * h[2] * k]);
    }
  } else if (f.kind === "capsule") for (const t of [0, 0.5, 1]) out.push([f.a[0] + (f.b[0] - f.a[0]) * t, f.a[1] + (f.b[1] - f.a[1]) * t, f.a[2] + (f.b[2] - f.a[2]) * t]);
  else if (f.kind === "sphere") out.push(f.c);
  return out;
}

/**
 * Règle générale des accessoires (sacs, sacoches, bourse, bretelles, nœud et pan de ceinture) : leur cœur reste hors
 * de la silhouette habillée. Une pièce décentrée est repoussée en s'éloignant de l'axe du buste ; une sangle (capsule)
 * voit chaque bout reposé sur la surface. Les anneaux centrés (ceinture, col, écharpe) entourent le corps : ignorés.
 */
export function settleAccessories(set: PrimSet, body: Field, axisZ: (y: number) => number, H: number) {
  const margin = H * 0.002;
  set.prims.forEach((f0, i) => {
    let f = f0;
    if (set.group[i] !== "bag" && set.group[i] !== "belt") return;
    if (f.kind === "capsule") {
      // sangle : bouts puis milieu reposés sur le vêtement (le long de la normale), jamais dans le corps
      const r = Math.max(f.ra, f.rb) * 0.6;
      for (let it = 0; it < 6; it++) {
        let moved = false;
        for (const t of [0, 1, 0.5]) {
          const p: V3 = [f.a[0] + (f.b[0] - f.a[0]) * t, f.a[1] + (f.b[1] - f.a[1]) * t, f.a[2] + (f.b[2] - f.a[2]) * t];
          const d = body.eval(p).d;
          if (d >= r - margin) continue;
          const n = body.gradient(p, H * 0.004);
          const step = r - d + margin;
          // un bout bouge seul ; le milieu entraîne les deux bouts
          for (const [q, wq] of [[f.a, 1 - t], [f.b, t]] as const) {
            const w = t === 0.5 ? 1 : wq;
            q[0] += n[0] * step * w;
            q[1] += n[1] * step * w;
            q[2] += n[2] * step * w;
          }
          moved = true;
        }
        if (!moved) break;
      }
      return;
    }
    if (f.kind !== "box" && f.kind !== "ellipsoid") return;
    // copie : le centre peut être partagé avec une autre pièce
    const c: V3 = [...f.c];
    set.prims[i] = { ...f, c };
    f = set.prims[i];
    const dx = c[0], dz = c[2] - axisZ(c[1]);
    const L = Math.hypot(dx, dz);
    if (L < H * 0.02) {
      // anneau centré (ceinture, col d'écharpe ou de cape) : élargi jusqu'à ce que son pourtour passe sur le vêtement
      if (f.kind !== "ellipsoid") return;
      for (let it = 0; it < 6; it++) {
        let pen = 0;
        for (let a = 0; a < 16; a++) {
          const t = (a / 16) * Math.PI * 2;
          pen = Math.max(pen, -body.eval([c[0] + Math.sin(t) * f.r[0] * 0.97, c[1], c[2] + Math.cos(t) * f.r[2] * 0.97]).d);
        }
        if (pen <= margin) break;
        const r: V3 = f.r;
        set.prims[i] = f = { ...f, r: [r[0] + pen + margin, r[1], r[2] + pen + margin] };
      }
      return;
    }
    const dir: V3 = [dx / L, 0, dz / L];
    for (let it = 0; it < 6; it++) {
      let pen = 0;
      for (const p of corePoints(f)) pen = Math.max(pen, -body.eval(p).d);
      if (pen <= margin) break;
      c[0] += dir[0] * (pen + margin);
      c[2] += dir[2] * (pen + margin);
    }
  });
}
