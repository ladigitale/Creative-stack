/**
 * Personnages vectoriels animés : le squelette posé par `humanoidPose` (même locomotion, actions et humeur que la 3D)
 * est projeté ; l'angle de vue (profil, trois-quarts, face, dos) découle du cap et de la projection, sans cas
 * particulier.
 *
 * - Bras et jambes : **un seul trait continu à épaisseur variable** (épaule → coude → poignet → main ; hanche → genou
 *   → cheville) : aucune jointure possible. Manches, jambes de pantalon, bottes : traits superposés sur la même
 *   polyligne, donc ils suivent le membre.
 * - Torse et bassin : sections elliptiques 3D (largeur × épaisseur) dont on projette les extrêmes ; contour en Bézier.
 * - Tête : ellipsoïdes crâne + mâchoire projetés ; yeux, sourcils, nez, bouche et oreilles sont des points de la
 *   surface (visibles si leur normale regarde l'observateur), expressions selon `mood`, clignement.
 * - Cheveux : calotte = ellipsoïde gonflé coupé par un plan de racine (enveloppe projetée), masse arrière, frange,
 *   queue, chignon, crête, boucles ; chapeaux par anneaux 3D projetés (bords, calottes, cônes).
 * - Membres éloignés plus sombres et derrière ; ordre de dessin par profondeur des parties.
 */
import { type M4, type V3, add, clamp, cross, dot, m4Dir, madd, norm, scale, sub } from "../../core/math";
import { ARCHETYPES } from "../../rig/humanoid";
import type { Skeleton } from "../../rig/skeleton";
import type { Projector } from "../project";
import { type P2, Pen, type Shape, hull, lerp2, strokeVar } from "../shape";
import { Emitter, Frame } from "./kit";
import { drawPartsOn } from "./parts";
import { heldToolParts } from "../../gen/tool";

export type CharacterInput = {
  sk: Skeleton;
  /** Matrices monde des os (repère du modèle, sans cap ni position). */
  W: M4[];
  pos: V3;
  yaw: number;
  params: Record<string, unknown>;
  blink: number;
  time: number;
  speed: number;
};

const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function drawCharacter(pr: Projector, em: Emitter, c: CharacterInput, shadows?: Shape[], ground?: (x: number, z: number) => number) {
  const { sk, W, params: p } = c;
  const fr = new Frame(c.pos, c.yaw, 1);
  const J = (name: string): V3 => {
    const i = sk.index[name];
    return fr.w(W[i][12], W[i][13], W[i][14]);
  };
  const T = (name: string): V3 => {
    const h = sk.tailOf(W, name);
    return fr.w(h[0], h[1], h[2]);
  };
  const D = (name: string, v: V3): V3 => {
    const d = m4Dir(W[sk.index[name]], v);
    return norm(fr.dir(d[0], d[1], d[2]));
  };
  const S = (v: V3): P2 => pr.pv(v);
  const depth = (v: V3) => pr.depth(v);
  const vdir = pr.dir;

  const H = sk.bone("head")!.tail[1];
  const arch = ARCHETYPES[(p.archetype as keyof typeof ARCHETYPES) ?? "stylized"] ?? ARCHETYPES.stylized;
  const girth = 0.88 + 0.32 * Number(p.build ?? 0.45);
  const R = (name: string, k: 0 | 1) => sk.bone(name)!.radius[k] * girth * 1.12;
  const headB = sk.bone("head")!;
  const headH = (H - headB.head[1]) / 0.88;
  const headW = headB.radius[0] * 2;
  const headD = headW * (arch.headD / arch.headW);
  const shoulderHalf = Math.abs(sk.bone("upperarm.l")!.head[0]);
  const hipHalf = Math.abs(sk.bone("thigh.l")!.head[0]) / 0.8;
  const mood = String(p.mood ?? "neutral");
  // valeurs résolues par `gen/character/look.ts` : les nouvelles se dessinent sur une base proche + détails
  const top0 = String(p.top ?? "tee"), bottom0 = String(p.bottom ?? "trousers"), shoes = String(p.shoes ?? "shoes");
  const top = top0 === "shirt" || top0 === "tunic" ? "long" : top0 === "dress" ? "robe" : top0;
  const bottom = bottom0 === "overalls" ? "trousers" : bottom0;
  const over = String(p.over ?? "none"), collar = String(p.collar ?? "none"), belt = String(p.belt ?? "none"), details = String(p.details ?? "none");
  const gloves = String(p.gloves ?? "none") === "gloves", pattern = String(p.pattern ?? "plain");
  const hair0 = String(p.hat) !== "none" && p.hair === "mohawk" ? "short" : String(p.hair ?? "short");
  const HAIR_BASE: Record<string, string> = { shaved: "crop", sidepart: "short", wavy: "long", lowtail: "ponytail", topknot: "bun", pigtails: "short", braids: "short", afro: "curly" };
  const hair = HAIR_BASE[hair0] ?? hair0;
  const headShapeK = String(p.headShape ?? "oval");
  const hat = String(p.hat ?? "none"), bag = String(p.bag ?? "none"), item = String(p.item ?? "none");
  const archName = String(p.archetype ?? "stylized");
  const toony = archName === "chibi" || archName === "cartoon";

  // repères du corps
  const fwd = D("chest", [0, 0, 1]), up = D("chest", [0, 1, 0]), lft = D("chest", [1, 0, 0]);
  const hUp = D("head", [0, 1, 0]), hFwd = D("head", [0, 0, 1]), hLft = D("head", [1, 0, 0]);
  const facing = dot(fwd, vdir);

  const chestH = J("chest"), chestT = T("chest"), spineH = J("spine"), spineT = T("spine"), pelvisH = J("pelvis");
  const chestR = sk.bone("chest")!.radius[0] * girth * arch.torsoD;
  const pelvisR = sk.bone("pelvis")!.radius[1] * girth;
  const belly = Number(p.belly ?? 0.15);

  /* ---------------- membres ---------------- */
  type Limb = { pts: V3[]; hw: number[]; key: number; far: boolean; side: "l" | "r" };
  const arms: Limb[] = (["l", "r"] as const).map((s) => {
    const sh0 = J(`upperarm.${s}`), el = J(`forearm.${s}`), wr = J(`hand.${s}`), tip = T(`hand.${s}`);
    // racine du bras légèrement rentrée dans le torse (deltoïde fondu dans l'épaule)
    const sh = madd(lerp3(sh0, J("chest"), 0.0), lerp3(sh0, el, 0.12).map((v, i) => v - sh0[i]) as V3, 1);
    const hm = lerp3(wr, tip, 0.45);
    const k = (depth(el) + depth(wr)) / 2;
    return { pts: [sh, el, wr, hm, tip], hw: [R(`upperarm.${s}`, 0) * 1.05, R(`upperarm.${s}`, 1), R(`forearm.${s}`, 1), R(`hand.${s}`, 0) * 1.2, R(`hand.${s}`, 1) * 0.95], key: k, far: k < depth(chestH) - shoulderHalf * 0.35, side: s };
  });
  const legs: Limb[] = (["l", "r"] as const).map((s) => {
    const hp = J(`thigh.${s}`), kn = J(`shin.${s}`), an = J(`foot.${s}`);
    const k = depth(kn);
    return { pts: [hp, kn, an], hw: [R(`thigh.${s}`, 0) * 1.05, R(`thigh.${s}`, 1), R(`shin.${s}`, 1) * 1.05], key: k, far: k < depth(pelvisH) - hipHalf * 0.4, side: s };
  });

  const parts: { key: number; draw: () => void }[] = [];
  const P2s = (pts: V3[]) => pts.map(S);

  // pieds / chaussures
  const foot = (s: "l" | "r", far: boolean) => {
    const an = J(`foot.${s}`), ball = J(`toe.${s}`), toe = T(`toe.${s}`);
    const fd = norm(sub(toe, an));
    const fl = Math.hypot(...sub(toe, an));
    const heel = madd(an, fd, -fl * 0.22);
    const r = R(`foot.${s}`, 0);
    const pts = [madd(heel, [0, 1, 0], r * 0.35), lerp3(an, ball, 0.35), ball, madd(toe, [0, 1, 0], r * 0.05)];
    const fill = shoes === "barefoot" || shoes === "sandals" ? "skin" : "leather";
    const pen = strokeVar(new Pen(), P2s(pts), [r * 0.72, r * 0.95, r * 0.9, r * 0.6]);
    em.add(pen, fill, { tone: far ? -1 : 0 });
    if (shoes === "sandals") {
      const st = new Pen();
      for (const t of [0.35, 0.7]) {
        const q = S(lerp3(pts[0], pts[3], t));
        st.M(q[0] - r * 0.6, q[1] + r * 0.7).L(q[0] + r * 0.6, q[1] + r * 0.7);
      }
      em.line(st, "leather", 1.2, { tone: -1 });
    } else if (fill === "leather") {
      // semelle
      const sole = strokeVar(new Pen(), P2s([madd(heel, [0, 1, 0], -r * 0.25), lerp3(an, ball, 0.5).map((v, i) => (i === 1 ? v - r * 0.72 : v)) as V3, madd(toe, [0, 1, 0], -r * 0.42)]), [r * 0.22, r * 0.22, r * 0.18]);
      em.add(sole, "leather", { tone: -1, stroke: null, alpha: 0.8 });
    }
  };

  const legDraw = (l: Limb) => () => {
    const s = l.side;
    const tone = l.far ? -1 : 0;
    const pts = P2s(l.pts);
    const skinLeg = bottom !== "trousers" || shoes === "boots";
    foot(s, l.far);
    // la jambe : un seul trait
    em.add(strokeVar(new Pen(), pts, l.hw), bottom === "trousers" ? "cloth2" : "skin", { tone });
    if (bottom === "trousers") {
      // revers au bas du pantalon
      const an = l.pts[2];
      const q = S(an), q2 = S(lerp3(l.pts[1], an, 0.9));
      em.add(strokeVar(new Pen(), [q2, q], [l.hw[2] * 1.12, l.hw[2] * 1.12], { capStart: false }), "cloth2", { tone: tone - 1, stroke: null });
    } else if (bottom === "shorts") {
      const sub2 = [pts[0], lerp2(pts[0], pts[1], 0.55)];
      em.add(strokeVar(new Pen(), sub2, [l.hw[0] * 1.15, lerpN(l.hw[0], l.hw[1], 0.55) * 1.2]), "cloth2", { tone });
    }
    if (shoes === "boots" || shoes === "tallboots") {
      const b = [lerp2(pts[1], pts[2], shoes === "tallboots" ? -0.08 : 0.45), pts[2]];
      em.add(strokeVar(new Pen(), b, [lerpN(l.hw[1], l.hw[2], 0.45) * 1.18, l.hw[2] * 1.2]), "leather", { tone });
      em.add(strokeVar(new Pen(), [b[0], lerp2(b[0], b[1], 0.15)], [l.hw[1] * 1.22, l.hw[1] * 1.2], { capEnd: false }), "leather", { tone: tone - 1, stroke: null });
    }
    void skinLeg;
  };

  const handItemKey = arms[1].key;
  const armDraw = (a: Limb) => () => {
    const tone = a.far ? -1 : 0;
    if (a.side === "r" && item !== "none") drawItem(a.far);
    const pts = P2s(a.pts);
    em.add(strokeVar(new Pen(), pts, a.hw), "skin", { tone });
    const sleeve = top0 === "dress" ? 0.45 : top === "tee" ? 0.5 : top === "long" || top === "sweater" || top === "coat" ? 1.9 : top === "robe" ? 1.95 : 0;
    if (sleeve > 0) {
      // manche : sous-polyligne épaule → coude (→ avant-bras)
      const sp: P2[] = [pts[0]];
      const sw: number[] = [a.hw[0] * 1.18];
      if (sleeve <= 1) {
        sp.push(lerp2(pts[0], pts[1], sleeve));
        sw.push(lerpN(a.hw[0], a.hw[1], sleeve) * 1.28);
      } else {
        sp.push(pts[1], lerp2(pts[1], pts[2], sleeve - 1));
        const wide = top === "robe" ? 1.9 : top === "coat" ? 1.35 : top0 === "shirt" ? 1.32 : 1.25;
        sw.push(a.hw[1] * 1.25, lerpN(a.hw[1], a.hw[2], sleeve - 1) * wide);
      }
      const cloth = "cloth1";
      em.add(strokeVar(new Pen(), sp, sw, { capEnd: top === "tee" || top0 === "dress" }), cloth, { tone });
      if (pattern === "stripes" && sleeve > 1) {
        const st = new Pen();
        for (let k = 1; k < 6; k++) {
          const q = k < 3 ? lerp2(sp[0], sp[1], k / 3) : lerp2(sp[1], sp[2], (k - 3) / 3);
          const dx = sp[2][0] - sp[0][0], dy = sp[2][1] - sp[0][1], l = Math.hypot(dx, dy) || 1, w = a.hw[1] * 1.2;
          st.M(q[0] - (dy / l) * w, q[1] + (dx / l) * w).L(q[0] + (dy / l) * w, q[1] - (dx / l) * w);
        }
        em.line(st, "cloth3", 1.2, { tone });
      }
      if (top === "sweater" || top === "coat") {
        const e = sp[sp.length - 1], e2 = lerp2(sp[sp.length - 2], e, 0.85);
        em.add(strokeVar(new Pen(), [e2, e], [sw[sw.length - 1], sw[sw.length - 1]], { capStart: false, capEnd: false }), top === "coat" ? "cloth3" : cloth, { tone: tone - 1, stroke: null });
      }
    }
    // veste, armure : manche ou spalière par-dessus
    if (over === "jacket") em.add(strokeVar(new Pen(), [pts[0], pts[1], lerp2(pts[1], pts[2], 0.88)], [a.hw[0] * 1.3, a.hw[1] * 1.32, lerpN(a.hw[1], a.hw[2], 0.88) * 1.4]), "cloth3", { tone });
    if (over === "armor") {
      em.add(strokeVar(new Pen(), [pts[0], lerp2(pts[0], pts[1], 0.45)], [a.hw[0] * 1.55, a.hw[0] * 1.3]), "metal", { tone });
      em.add(strokeVar(new Pen(), [lerp2(pts[1], pts[2], 0.25), lerp2(pts[1], pts[2], 0.85)], [a.hw[1] * 1.3, a.hw[2] * 1.35], { capStart: false, capEnd: false }), "metal", { tone: tone - 1 });
    }
    if (gloves) em.add(strokeVar(new Pen(), [lerp2(pts[1], pts[2], 0.8), pts[2], pts[3], pts[4]], [a.hw[2] * 1.15, a.hw[2] * 1.1, a.hw[3] * 1.05, a.hw[4]]), "leather", { tone });
  };

  /* ---------------- torse ---------------- */
  const shC = lerp3(J("upperarm.l"), J("upperarm.r"), 0.5);
  const hipC = lerp3(J("thigh.l"), J("thigh.r"), 0.5);
  const axis2 = norm2(sub2(S(shC), S(hipC)));
  const n2: P2 = [-axis2[1], axis2[0]];
  const section = (center: V3, w: number, d: number, dFront = d): [P2, P2] => {
    const c2 = S(center);
    const a = pr.vec(scale(lft, w)), b = pr.vec(scale(fwd, (d + dFront) / 2));
    const off = pr.vec(scale(fwd, (dFront - d) / 2));
    const an = a[0] * n2[0] + a[1] * n2[1], bn = b[0] * n2[0] + b[1] * n2[1];
    const t = Math.atan2(bn, an);
    const e: P2 = [a[0] * Math.cos(t) + b[0] * Math.sin(t), a[1] * Math.cos(t) + b[1] * Math.sin(t)];
    return [[c2[0] + off[0] + e[0], c2[1] + off[1] + e[1]], [c2[0] + off[0] - e[0], c2[1] + off[1] - e[1]]];
  };
  type Lv = { c: V3; w: number; d: number; df?: number };
  const lvShoulderTop: Lv = { c: madd(chestT, up, H * 0.012), w: shoulderHalf * 0.55, d: chestR * 0.6 };
  const lvShoulder: Lv = { c: madd(shC, up, -H * 0.012), w: shoulderHalf + R("upperarm.l", 0) * 0.2, d: chestR * 0.85 };
  const lvChest: Lv = { c: lerp3(chestH, chestT, 0.4), w: shoulderHalf * 0.93, d: chestR * 0.95, df: chestR * 1.05 };
  const lvWaist: Lv = { c: lerp3(spineH, spineT, 0.45), w: lerpN(hipHalf * 1.05, shoulderHalf * 0.78, 0.5), d: chestR * 0.8, df: chestR * (0.8 + belly * 0.9) };
  const lvHip: Lv = { c: madd(pelvisH, up, H * 0.015), w: hipHalf * 1.28, d: pelvisR * 0.95, df: pelvisR * (0.95 + belly * 0.3) };
  const lvCrotch: Lv = { c: madd(pelvisH, up, -H * 0.055), w: hipHalf * 1.02, d: pelvisR * 0.8 };
  const outline = (lv: Lv[], bottomCurve: boolean): Pen => {
    const L: P2[] = [], Rr: P2[] = [];
    for (const l of lv) {
      const [a, b] = section(l.c, l.w, l.d, l.df ?? l.d);
      L.push(a);
      Rr.push(b);
    }
    // contour : côté gauche du bas vers le haut, sommet, côté droit vers le bas
    const loop = [...L.slice().reverse(), ...Rr];
    const pen = new Pen();
    if (bottomCurve) pen.smooth(loop, true);
    else pen.smooth(loop, true);
    return pen;
  };

  const torsoDraw = () => {
    // neck
    const nk0 = J("neck"), nk1 = T("neck");
    em.add(strokeVar(new Pen(), [S(nk0), S(nk1)], [R("neck", 0) * 1.25, R("neck", 1) * 1.2]), "skin", { tone: 0 });
    if (top === "none" || top === "tank") em.add(outline([lvShoulderTop, lvShoulder, lvChest, lvWaist, lvHip], false), "skin", {});
    const topLv = top === "tank" ? [{ ...lvShoulderTop, w: lvShoulderTop.w * 0.9 }, { ...lvShoulder, w: shoulderHalf * 0.75 }, lvChest, lvWaist, lvHip] : [lvShoulderTop, lvShoulder, lvChest, lvWaist, { ...lvHip, w: lvHip.w * 1.04, d: lvHip.d * 1.05 }];
    if (top !== "none" && top !== "robe") {
      const pen = outline(topLv, false);
      em.add(pen, "cloth1", {});
      // ourlet / bord-côte
      const [a, b] = section(lvHip.c, lvHip.w * 1.04, lvHip.d * 1.05, lvHip.df ?? lvHip.d);
      const [a2, b2] = section(lerp3(lvHip.c, lvWaist.c, 0.22), lvHip.w * 1.02, lvHip.d, lvHip.df ?? lvHip.d);
      if (Math.abs(facing) > 0.5) em.add(new Pen().poly([a, b, b2, a2]), "cloth1", { tone: -1, stroke: null, alpha: top === "sweater" ? 1 : 0.5 });
      // ombre latérale (côté opposé à la lumière) : demi-contour intérieur
      const [s1] = section(lvChest.c, lvChest.w * 0.98, lvChest.d);
      const [s2] = section(lvWaist.c, lvWaist.w * 0.98, lvWaist.d);
      const [i1] = section(lvChest.c, lvChest.w * 0.62, lvChest.d * 0.62);
      const [i2] = section(lvWaist.c, lvWaist.w * 0.62, lvWaist.d * 0.62);
      em.add(new Pen().smooth([s1, s2, i2, i1], true), "cloth1", { tone: -1, stroke: null, alpha: 0.65 });
      // encolure
      if (facing > 0.15 && top !== "coat") {
        const nc = S(madd(chestT, fwd, chestR * 0.5));
        const r = R("neck", 0) * 1.5;
        em.add(new Pen().M(nc[0] - r, nc[1] + r * 0.5).Q(nc[0], nc[1] - r * (top === "tank" ? 2.4 : 1.2), nc[0] + r, nc[1] + r * 0.5).Z(), "skin", { tone: -1, width: 0.6 });
      }
      if (top === "coat" || top0 === "tunic") {
        // pans du manteau, boutonnage, revers
        const pts: P2[] = [...section(lvHip.c, lvHip.w * 1.06, lvHip.d * 1.1, lvHip.df ?? lvHip.d)];
        for (const s2 of ["l", "r"]) {
          const q = S(lerp3(J(`thigh.${s2}`), J(`shin.${s2}`), 0.6));
          const r = R(`thigh.${s2}`, 1) * 1.8;
          for (let i = 0; i < 8; i++) pts.push([q[0] + Math.cos((i / 8) * Math.PI * 2) * r, q[1] + Math.sin((i / 8) * Math.PI * 2) * r * 0.35]);
        }
        const ch = hull(pts);
        em.add(new Pen().smooth(ch, true), "cloth1", { tone: 0 });
        const hm = ch.reduce((m, q) => (q[1] < m[1] ? q : m), ch[0]);
        const pts2 = [pts[0], hm, hm, pts[1]];
        if (facing > 0.2 && top === "coat") {
          const c0 = S(madd(chestT, fwd, chestR)), c1 = S(madd(lvHip.c, fwd, lvHip.d));
          const bm: P2 = [c1[0], pts2[1][1]];
          em.line(new Pen().M(c0[0], c0[1]).L(c1[0], c1[1]).L(bm[0], bm[1]), "cloth1", 0.7, { tone: -2 });
          const bt = new Pen();
          for (let i = 0; i < 3; i++) {
            const q = lerp2(c0, c1, 0.25 + i * 0.25);
            bt.ellipse(q[0] + headW * 0.04, q[1], headW * 0.03, headW * 0.03);
          }
          em.add(bt, "cloth3", { stroke: null });
          const lap = new Pen().M(c0[0] - headW * 0.25, c0[1] + headW * 0.08).L(c0[0], c0[1] - headW * 0.45).L(c0[0] + headW * 0.25, c0[1] + headW * 0.08).L(c0[0] + headW * 0.12, c0[1] + headW * 0.1).L(c0[0], c0[1] - headW * 0.2).L(c0[0] - headW * 0.12, c0[1] + headW * 0.1).Z();
          em.add(lap, "cloth3", { tone: 0, width: 0.6 });
        }
      }
    }
    if (top === "robe") {
      // robe longue évasée jusqu'aux chevilles, ceinture de corde
      const pts: P2[] = [];
      for (const lv of [lvShoulderTop, lvShoulder, lvChest, lvWaist, lvHip]) pts.push(...section(lv.c, lv.w * 1.03, lv.d * 1.03, lv.df ?? lv.d));
      for (const s2 of ["l", "r"]) {
        const q = S(lerp3(J(`shin.${s2}`), J(`foot.${s2}`), 0.85));
        const r = R(`thigh.${s2}`, 1) * 2.4;
        for (let i = 0; i < 8; i++) pts.push([q[0] + Math.cos((i / 8) * Math.PI * 2) * r, q[1] + Math.sin((i / 8) * Math.PI * 2) * r * 0.3]);
      }
      // robe : torse modelé + jupe évasée (enveloppe des hanches et des chevilles)
      const skirtPts = pts.slice(6);
      em.add(new Pen().smooth(hull(skirtPts), true), "cloth1", {});
      em.add(outline([lvShoulderTop, lvShoulder, lvChest, lvWaist, lvHip], false), "cloth1", {});
      const knee = { c: lerp3(J("shin.l"), J("shin.r"), 0.5), w: hipHalf * 1.55, d: pelvisR * 1.3 };
      const hemLv = { c: lerp3(J("foot.l"), J("foot.r"), 0.5), w: hipHalf * 1.9, d: pelvisR * 1.6 };
      const [a, b] = section(lvWaist.c, lvWaist.w * 1.04, lvWaist.d * 1.05, lvWaist.df);
      em.add(strokeVar(new Pen(), [a, b], [H * 0.012, H * 0.012]), "cloth3", { tone: 0, width: 0.5 });
      const folds = new Pen();
      for (const t of [0.3, 0.55, 0.75]) {
        const [ka] = section(knee.c, knee.w * (t * 2 - 1), knee.d);
        const [ha] = section(hemLv.c, hemLv.w * (t * 2 - 1) * 1.1, hemLv.d);
        folds.M(ka[0], ka[1]).L(ha[0], ha[1]);
      }
      em.line(folds, "cloth1", 0.5, { tone: -2 });
    }
  };

  const lowerDraw = () => {
    if (top === "robe") return;
    const fill = bottom === "trousers" || bottom === "shorts" ? "cloth2" : "cloth2";
    em.add(outline([lvWaist, lvHip, lvCrotch], false), fill, { tone: 0 });
    if (bottom === "skirt" || bottom === "longskirt") {
      const longk = bottom === "longskirt";
      const pts: P2[] = [];
      for (const lv of [lvWaist, lvHip]) pts.push(...section(lv.c, lv.w * 1.04, lv.d * 1.05, lv.df ?? lv.d));
      for (const s2 of ["l", "r"]) {
        const k = longk ? lerp3(J(`shin.${s2}`), J(`foot.${s2}`), 0.8) : lerp3(J(`thigh.${s2}`), J(`shin.${s2}`), 0.85);
        const r = R(`thigh.${s2}`, 1) * (longk ? 2.2 : 1.9);
        const q = S(k);
        for (let i = 0; i < 8; i++) pts.push([q[0] + Math.cos((i / 8) * Math.PI * 2) * r, q[1] + Math.sin((i / 8) * Math.PI * 2) * r * 0.4]);
      }
      const h = hull(pts);
      em.add(new Pen().smooth(h, true), "cloth2", { tone: 0 });
      const lowest = h.reduce((m, q) => (q[1] < m[1] ? q : m), h[0]);
      const pl = new Pen();
      const top2 = S(lvHip.c);
      for (const t of [-0.3, 0.3]) pl.M(top2[0] + t * hipHalf, top2[1]).L(lowest[0] + t * hipHalf * 2.2, lowest[1] + H * 0.02);
      em.line(pl, "cloth2", 0.5, { tone: -2 });
    }
    // ceinture
    const [a, b] = section(lvWaist.c, lvWaist.w * 1.02, lvWaist.d * 1.02, lvWaist.df);
    if (top === "none" || top === "tank") em.add(strokeVar(new Pen(), [a, b], [H * 0.011, H * 0.011], { capStart: false, capEnd: false }), "leather", { stroke: null });
  };

  /* ---------------- tête ---------------- */
  const neckTop = J("head");
  const hc = madd(madd(neckTop, hUp, headH * 0.4), hFwd, headD * 0.04);
  const hsx = headShapeK === "round" ? 1.06 : headShapeK === "square" ? 1.04 : headShapeK === "long" ? 0.94 : 1;
  const hsy = headShapeK === "round" ? 0.96 : headShapeK === "long" ? 1.1 : 1;
  const rx = (headW / 2) * hsx, ry = headH * 0.52 * hsy, rz = headD / 2;
  const onHead = (lon: number, lat: number, k = 1, c0 = hc, r: [number, number, number] = [rx, ry, rz]): V3 => {
    const cl = Math.cos(lat);
    return add(c0, add(add(scale(hLft, r[0] * Math.sin(lon) * cl * k), scale(hUp, r[1] * Math.sin(lat) * k)), scale(hFwd, r[2] * Math.cos(lon) * cl * k)));
  };
  const nrm = (lon: number, lat: number): V3 => norm(add(add(scale(hLft, Math.sin(lon) * Math.cos(lat)), scale(hUp, Math.sin(lat))), scale(hFwd, Math.cos(lon) * Math.cos(lat))));
  const vis = (lon: number, lat: number) => dot(nrm(lon, lat), vdir);
  const faceVis = dot(hFwd, vdir);
  const eyeR = headW * (archName === "chibi" ? 0.13 : archName === "cartoon" ? 0.105 : archName === "stylized" ? 0.08 : 0.068);

  /** Repère unitaire de la tête : u = (gauche, haut, avant) sur la sphère unité ↔ point de l'ellipsoïde gonflé `k`. */
  const U = (u: V3, k: number, c0 = hc): V3 => add(c0, add(add(scale(hLft, u[0] * rx * k), scale(hUp, u[1] * ry * k)), scale(hFwd, u[2] * rz * k)));
  // direction de visibilité dans l'espace unité (normale · vue ∝ u · M⁻¹v)
  const wU = norm([dot(vdir, hLft) / rx, dot(vdir, hUp) / ry, dot(vdir, hFwd) / rz]);
  const basis = (n: V3): [V3, V3] => {
    const e1 = norm(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]));
    return [e1, cross(n, e1)];
  };
  /** Enveloppe projetée d'une calotte (ellipsoïde gonflé `k` ∩ u·n ≥ thr), points supplémentaires compris. */
  const capHull = (k: number, nU: V3, thr: number, c0 = hc, extra: V3[] = []): P2[] => {
    const n = norm(nU);
    const [e1, e2] = basis(n);
    const pts: V3[] = [...extra];
    for (const t of [thr, (thr + 1) / 2]) {
      const s = Math.sqrt(Math.max(0, 1 - t * t));
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        pts.push(U(add(scale(n, t), add(scale(e1, Math.cos(a) * s), scale(e2, Math.sin(a) * s))), k, c0));
      }
    }
    pts.push(U(n, k, c0));
    return hull(pts.map(S));
  };
  /**
   * Partie **visible** d'une calotte : bornée par l'arc de silhouette (dans la calotte) et l'arc de racine (côté vu).
   * C'est elle qui passe devant le visage ; l'enveloppe complète se dessine derrière la tête.
   */
  const capFront = (k: number, nU: V3, thr: number): P2[] => {
    const n = norm(nU);
    const [e1, e2] = basis(n);
    const [a1, a2] = basis(wU);
    const N = 36;
    const s = Math.sqrt(Math.max(0, 1 - thr * thr));
    const hl: { u: V3; ok: boolean }[] = [], sl: { u: V3; ok: boolean }[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const uh = add(scale(n, thr), add(scale(e1, Math.cos(a) * s), scale(e2, Math.sin(a) * s)));
      hl.push({ u: uh, ok: dot(uh, wU) >= 0 });
      const us = add(scale(a1, Math.cos(a)), scale(a2, Math.sin(a)));
      sl.push({ u: us, ok: dot(us, n) >= thr });
    }
    const run = (l: { u: V3; ok: boolean }[]) => {
      const st = l.findIndex((q, i) => q.ok && !l[(i - 1 + N) % N].ok);
      if (st < 0) return l.every((q) => q.ok) ? l.map((q) => q.u) : [];
      const out: V3[] = [];
      for (let i = 0; i < N && l[(st + i) % N].ok; i++) out.push(l[(st + i) % N].u);
      return out;
    };
    const hr = run(hl), sr = run(sl);
    if (hr.length === N) return hr.map((u) => S(U(u, k)));
    if (!hr.length) return sr.length === N ? sr.map((u) => S(U(u, k))) : [];
    if (!sr.length) return hr.map((u) => S(U(u, k)));
    const end = sr[sr.length - 1];
    const d0 = Math.hypot(...sub(hr[0], end)), d1 = Math.hypot(...sub(hr[hr.length - 1], end));
    const h2 = d0 <= d1 ? hr : hr.slice().reverse();
    return [...sr, ...h2].map((u) => S(U(u, k)));
  };

  const headShape = () => {
    const pts: V3[] = [];
    for (let i = 0; i < 14; i++)
      for (const lat of [-1.1, -0.45, 0.2, 0.9]) pts.push(onHead((i / 14) * Math.PI * 2, lat));
    pts.push(onHead(0, Math.PI / 2));
    const jc = madd(madd(hc, hUp, -headH * 0.2), hFwd, headD * 0.07);
    const jawK = headShapeK === "square" ? 1.12 : headShapeK === "round" ? 1.05 : 1;
    for (let i = 0; i < 10; i++) for (const lat of [-1.1, -0.4]) pts.push(onHead((i / 12) * Math.PI * 2, lat, 1, jc, [rx * 0.8, ry * 0.62, rz * 0.86]));
    return new Pen().smooth(hull(pts.map(S)), true);
  };

  const ear = (s: number) => {
    const lon = s * 1.5;
    const v = vis(lon, -0.05);
    if (v < -0.4) return;
    const q = S(onHead(lon, -0.08, 0.98));
    const earK = p.ears === "large" ? 1.3 : p.ears === "small" ? 0.8 : 1;
    const w = eyeR * (0.5 + 0.4 * Math.abs(v)) * earK, h = headH * 0.13 * earK;
    if (p.ears === "pointed") {
      em.add(new Pen().M(q[0] - w * 0.8, q[1] - h * 0.7).Q(q[0] - w, q[1] + h * 0.4, q[0] - s * w * 0.3, q[1] + h * 1.6).Q(q[0] + w * 0.9, q[1] + h * 0.3, q[0] + w * 0.6, q[1] - h * 0.7).Z(), "skin", { tone: 0, width: 0.7 });
      return;
    }
    em.add(new Pen().ellipse(q[0], q[1], w, h), "skin", { tone: 0, width: 0.7 });
    em.line(new Pen().M(q[0] - w * 0.3 * s, q[1] + h * 0.5).Q(q[0] + w * 0.4 * s, q[1], q[0] - w * 0.2 * s, q[1] - h * 0.45), "skin", 0.5, { tone: -2 });
  };

  const face = () => {
    if (faceVis < -0.3) return;
    const blink = c.blink > 0.5;
    // joues
    if (toony && (mood === "happy" || mood === "surprised") && faceVis > 0.1)
      for (const s of [-1, 1]) {
        const v = vis(s * 0.62, -0.32);
        if (v < 0.1) continue;
        const q = S(onHead(s * 0.62, -0.32));
        em.add(new Pen().ellipse(q[0], q[1], eyeR * 0.8 * v, eyeR * 0.45), "accent", { stroke: null, alpha: 0.3 });
      }
    // yeux
    const gaze = pr.vec(hFwd)[0];
    for (const s of [-1, 1]) {
      const lon = s * (toony ? 0.42 : 0.46), lat = toony ? -0.08 : -0.02;
      const v = vis(lon, lat);
      if (v < 0.05) continue;
      const q = S(onHead(lon, lat));
      const f = clamp(v * 1.15, 0.3, 1);
      const ek = p.eyes === "big" ? 1.3 : p.eyes === "narrow" ? 1.05 : 1;
      const eyK = p.eyes === "narrow" ? 0.55 : p.eyes === "almond" ? 0.78 : p.eyes === "sleepy" ? 0.7 : 1;
      const ex = eyeR * f * ek, ey = eyeR * (mood === "surprised" ? 1.12 : 0.85) * (toony ? 1.1 : 0.82) * ek * eyK;
      if (blink || mood === "sleepy") {
        const lid = new Pen();
        strokeVar(lid, [[q[0] - ex, q[1]], [q[0], q[1] - ey * (mood === "sleepy" ? 0.15 : 0.35)], [q[0] + ex, q[1]]], [eyeR * 0.06, eyeR * 0.14, eyeR * 0.06]);
        if (mood === "sleepy" && !blink) {
          em.add(new Pen().ellipse(q[0], q[1] - ey * 0.25, ex * 0.9, ey * 0.55), "eyeWhite", { stroke: null });
          em.add(new Pen().ellipse(q[0] + gaze * ex * 0.2, q[1] - ey * 0.3, ex * 0.5, ey * 0.45), "eye", { stroke: null });
          em.add(new Pen().M(q[0] - ex * 1.05, q[1]).L(q[0] + ex * 1.05, q[1]).L(q[0] + ex * 1.05, q[1] + ey).L(q[0] - ex * 1.05, q[1] + ey).Z(), "skin", { tone: -1, stroke: null });
        }
        em.add(lid, "ink", { stroke: null });
        continue;
      }
      em.add(new Pen().ellipse(q[0], q[1], ex, ey), "eyeWhite", { stroke: null });
      const ir = (mood === "surprised" ? 0.48 : toony ? 0.66 : 0.62);
      const ix = q[0] + gaze * ex * 0.3, iy = q[1] - ey * 0.04;
      em.add(new Pen().ellipse(ix, iy, ex * ir, ey * ir * 1.05), "eye", { stroke: null });
      em.add(new Pen().ellipse(ix - ex * 0.22, iy + ey * 0.28, ex * 0.2, ey * 0.2), "eyeWhite", { tone: 1, stroke: null });
      // paupière supérieure (trait de cils), plissée selon l'humeur
      const tilt = mood === "angry" ? -0.3 : mood === "sad" ? 0.3 : 0;
      const inner = -s * (gaze >= 0 ? 1 : 1);
      const lidPts: P2[] = [[q[0] - ex * 1.1, q[1] + ey * 0.25 + tilt * ey * inner], [q[0], q[1] + ey * 1.02], [q[0] + ex * 1.1, q[1] + ey * 0.25 - tilt * ey * inner]];
      em.add(strokeVar(new Pen(), lidPts, [eyeR * 0.05, eyeR * 0.15, eyeR * 0.07]), "ink", { stroke: null });
      if (mood === "happy") em.add(new Pen().M(q[0] - ex * 1.1, q[1] - ey * 1.1).Q(q[0], q[1] - ey * 0.15, q[0] + ex * 1.1, q[1] - ey * 1.1).Z(), "skin", { stroke: null });
    }
    // sourcils
    for (const s of [-1, 1]) {
      const raise = mood === "surprised" ? 0.09 : mood === "happy" ? 0.03 : 0;
      const innerDy = mood === "angry" ? -0.07 : mood === "sad" ? 0.08 : 0;
      const outerDy = mood === "sad" ? -0.04 : mood === "angry" ? 0.03 : 0;
      const latB = toony ? 0.2 : 0.22;
      const a = onHead(s * 0.16, latB + raise + innerDy), m = onHead(s * 0.4, latB + raise + 0.035), b = onHead(s * 0.64, latB + raise + outerDy - 0.02);
      if (vis(s * 0.4, latB) < 0.02) continue;
      if (p.brows === "none") continue;
      const bw = p.brows === "thin" ? 0.5 : p.brows === "thick" ? 1.45 : p.brows === "bushy" ? 1.9 : 1;
      const mm = p.brows === "arched" ? madd(m, hUp, ry * 0.035) : m;
      em.add(strokeVar(new Pen(), [S(a), S(mm), S(b)], [eyeR * 0.2 * bw, eyeR * 0.17 * bw, eyeR * 0.06 * bw]), "hair", { tone: -1, stroke: null });
    }
    // nez
    if (faceVis > -0.2) {
      const base = onHead(0, -0.2), br = onHead(0, 0.02);
      const nk = p.nose === "long" || p.nose === "aquiline" ? 1.45 : p.nose === "button" ? 0.7 : 1;
      const tip = madd(madd(base, hFwd, rz * (toony ? 0.12 : 0.2) * nk), hUp, -ry * (p.nose === "upturned" ? -0.03 : p.nose === "long" ? 0.06 : 0.02));
      const under = onHead(0, -0.3);
      const t = S(tip), b0 = S(br), u = S(under);
      const w = eyeR * 0.45 * (1 - Math.abs(faceVis) * 0.5) * (p.nose === "wide" ? 1.5 : 1);
      const side = pr.vec(hFwd)[0] >= 0 ? 1 : -1;
      const pen = new Pen().M(b0[0], b0[1]).Q(t[0] - side * w * 0.2, t[1] + w, t[0], t[1]).Q(t[0] - side * w * 0.6, t[1] - w * 0.8, u[0], u[1]).Q(u[0] - side * w, u[1] + w * 0.5, b0[0] - side * w * 0.6, b0[1]).Z();
      em.add(pen, "skin", { tone: Math.abs(faceVis) > 0.85 ? -1 : 0, width: 0.5 });
      if (faceVis > 0.5) em.add(new Pen().ellipse(u[0] + side * w * 0.2, u[1] + w * 0.15, w * 0.45, w * 0.22), "skin", { tone: -2, stroke: null, alpha: 0.7 });
    }
    // bouche
    const mv = vis(0, -0.46);
    if (mv > -0.15) {
      const mw = toony ? 0.26 : 0.22;
      const curve = mood === "happy" ? 0.09 : mood === "sad" ? -0.07 : mood === "angry" ? -0.03 : mood === "neutral" ? 0.015 : 0;
      const lat0 = toony ? -0.48 : -0.46;
      const pts: P2[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6, x = (t - 0.5) * 2;
        pts.push(S(onHead(x * mw, lat0 + curve * (x * x) - curve * 0.3, 1.0)));
      }
      if (mood === "surprised") {
        const q = S(onHead(0, lat0 - 0.02));
        em.add(new Pen().ellipse(q[0], q[1], eyeR * 0.45 * Math.max(0.3, mv), eyeR * 0.6), "mouth", { tone: -1, width: 0.5 });
      } else if (mood === "happy" && toony) {
        const low: P2[] = [];
        for (let i = 6; i >= 0; i--) {
          const t = i / 6, x = (t - 0.5) * 2;
          low.push(S(onHead(x * mw * 0.9, lat0 - 0.13 * (1 - x * x) + 0.02, 1.0)));
        }
        em.add(new Pen().smooth(pts, false, true).raw("").smooth([pts[pts.length - 1], ...low], false, false).Z(), "mouth", { tone: -1, width: 0.5 });
        const tongue = S(onHead(0, lat0 - 0.08));
        em.add(new Pen().ellipse(tongue[0], tongue[1], eyeR * 0.35 * Math.max(0.3, mv), eyeR * 0.18), "accent", { stroke: null, alpha: 0.8 });
      } else {
        const lk = p.lips === "full" ? 1.6 : p.lips === "thin" ? 0.65 : 1;
        if (p.lips === "full" && mv > 0.2) {
          const low = pts.map(([x, y], i): P2 => [x, y - eyeR * 0.22 * Math.sin((i / 6) * Math.PI)]);
          em.add(new Pen().smooth([...pts, ...low.reverse()], true), "sky", { tone: 0, stroke: null });
        }
        em.add(strokeVar(new Pen(), pts, [eyeR * 0.03, eyeR * 0.1 * lk, eyeR * 0.12 * lk, eyeR * 0.12 * lk, eyeR * 0.12 * lk, eyeR * 0.1 * lk, eyeR * 0.03]), "mouth", { tone: -1, stroke: null });
      }
    }
    faceExtras();
  };

  /** Pilosité, lunettes, taches de rousseur, pommettes, rides. */
  const faceExtras = () => {
    if (faceVis < -0.35) return;
    const lvl = (v: unknown) => (v === "strong" ? 1 : v === "light" ? 0.5 : 0);
    // pommettes et rousseurs
    const bl = lvl(p.blush), fr = lvl(p.freckles);
    for (const sd of [-1, 1]) {
      const v = vis(sd * 0.6, -0.28);
      if (v < 0.1) continue;
      const q = S(onHead(sd * 0.6, -0.28));
      if (bl) em.add(new Pen().ellipse(q[0], q[1], eyeR * 0.85 * v, eyeR * 0.45), "sky", { stroke: null, alpha: 0.25 + bl * 0.25 });
      if (fr) {
        const d = new Pen();
        for (let k = 0; k < 4 + fr * 6; k++) d.ellipse(q[0] + Math.sin(k * 2.3) * eyeR * 0.8 * v, q[1] + Math.cos(k * 1.7) * eyeR * 0.4 + eyeR * 0.25, eyeR * 0.06, eyeR * 0.06);
        em.add(d, "bark", { stroke: null, alpha: 0.75 });
      }
    }
    // rides
    const wr = lvl(p.wrinkles) || (p.age === "elder" ? 0.5 : 0);
    if (wr) {
      const w = new Pen();
      for (const sd of [-1, 1]) {
        if (vis(sd * 0.7, -0.05) < 0.1) continue;
        for (let k = 0; k < 2; k++) {
          const a = S(onHead(sd * 0.68, -0.02 + k * 0.08)), b = S(onHead(sd * 0.8, -0.05 + k * 0.1));
          w.M(a[0], a[1]).L(b[0], b[1]);
        }
        const n0 = S(onHead(sd * 0.2, -0.28)), n1 = S(onHead(sd * 0.32, -0.46));
        w.M(n0[0], n0[1]).Q((n0[0] + n1[0]) / 2 + sd * eyeR * 0.15, (n0[1] + n1[1]) / 2, n1[0], n1[1]);
      }
      if (vis(0, 0.4) > 0.2) for (let k = 0; k < 2; k++) {
        const a = S(onHead(-0.3, 0.38 + k * 0.08)), b = S(onHead(0.3, 0.38 + k * 0.08)), c2 = S(onHead(0, 0.36 + k * 0.08));
        w.M(a[0], a[1]).Q(c2[0], c2[1], b[0], b[1]);
      }
      em.line(w, "bark", 0.5 + wr * 0.4, { alpha: 0.7 });
    }
    // barbe : calotte inférieure de l'ellipsoïde (partie visible), longue ou en collier
    const beard = String(p.beard ?? "none");
    if (beard !== "none") {
      const spec: Record<string, [V3, number, number]> = { stubble: [[0, -1, 0.3], 0.42, 1.01], short: [[0, -1, 0.3], 0.55, 1.05], full: [[0, -1, 0.3], 0.45, 1.08], long: [[0, -1, 0.3], 0.47, 1.08], goatee: [[0, -0.6, 0.8], 0.86, 1.06], chinstrap: [[0, -1, 0.3], 0.62, 1.04] };
      const [n, thr, k] = spec[beard] ?? spec.short;
      let pts = capFront(k, n, thr);
      if (beard === "long") {
        const chin = madd(onHead(0, -1.05, 1.05), hUp, -ry * 0.9);
        pts = hull([...pts, S(madd(chin, hLft, rx * 0.25)), S(madd(chin, hLft, -rx * 0.25)), S(chin)]);
      }
      if (pts.length > 2) em.add(beard === "full" || beard === "long" ? bumpy(pts, rx * 0.05) : new Pen().smooth(pts, true), beard === "stubble" ? "bark" : "hair", { tone: beard === "stubble" ? 0 : -1, stroke: beard === "stubble" ? null : undefined, alpha: beard === "stubble" ? 0.55 : 1 });
      if (beard !== "stubble" && beard !== "goatee" && mood !== "surprised") {
        // bouche dégagée dans la barbe
        const mq = S(onHead(0, -0.5));
        em.add(new Pen().ellipse(mq[0], mq[1], eyeR * 0.5 * Math.max(0.3, faceVis), eyeR * 0.14), "mouth", { tone: -1, stroke: null });
      }
    }
    const mus = String(p.mustache ?? "none");
    if (mus !== "none" && vis(0, -0.36) > -0.1) {
      const L = S(onHead(-0.3, -0.38, 1.03)), M = S(onHead(0, -0.33, 1.05)), R2 = S(onHead(0.3, -0.38, 1.03));
      const w = mus === "pencil" ? 0.05 : mus === "thin" ? 0.09 : mus === "walrus" ? 0.28 : 0.14;
      if (mus === "handlebar") {
        const l2 = S(onHead(-0.42, -0.28, 1.03)), r3 = S(onHead(0.42, -0.28, 1.03));
        em.add(strokeVar(new Pen(), [l2, L, M, R2, r3], [eyeR * 0.03, eyeR * 0.12, eyeR * 0.14, eyeR * 0.12, eyeR * 0.03]), "hair", { tone: -1, stroke: null });
      } else {
        const Ld = mus === "walrus" ? S(onHead(-0.34, -0.5, 1.03)) : L, Rd = mus === "walrus" ? S(onHead(0.34, -0.5, 1.03)) : R2;
        em.add(strokeVar(new Pen(), [Ld, M, Rd], [eyeR * w * 0.4, eyeR * w, eyeR * w * 0.4]), "hair", { tone: -1, stroke: null });
      }
    }
    // lunettes
    const gl = String(p.glasses ?? "none");
    if (gl !== "none") {
      const fr2 = new Pen();
      const centers: P2[] = [];
      for (const sd of [-1, 1]) {
        const lon = sd * (toony ? 0.42 : 0.46);
        const v = vis(lon, -0.02);
        if (v < 0.02) continue;
        const q = S(onHead(lon, -0.02, 1.08));
        centers.push(q);
        const rxe = eyeR * 1.35 * Math.max(0.35, v), rye = eyeR * 1.15;
        if (gl === "round") fr2.ellipse(q[0], q[1], rxe, rye);
        else if (gl === "square") fr2.rrect(q[0] - rxe, q[1] - rye * 0.85, rxe * 2, rye * 1.7, eyeR * 0.25);
        else fr2.M(q[0] - rxe, q[1]).Q(q[0], q[1] - rye * 1.1, q[0] + rxe, q[1]);
      }
      if (centers.length === 2) fr2.M(centers[0][0] + eyeR * 1.2, centers[0][1] + eyeR * 0.2).Q((centers[0][0] + centers[1][0]) / 2, centers[0][1] + eyeR * 0.5, centers[1][0] - eyeR * 1.2, centers[1][1] + eyeR * 0.2);
      const tmp = S(onHead(faceVis >= 0 && pr.vec(hFwd)[0] < 0 ? 1.4 : -1.4, 0.0, 1.02));
      if (centers.length && Math.abs(faceVis) < 0.85) fr2.M(centers[0][0], centers[0][1]).L(tmp[0], tmp[1]);
      em.line(fr2, "ink", 1.1);
    }
  };

  // cheveux
  const hairN: V3 = norm([0, 0.75, -0.66]);
  const hairBack = (): { key: number; draw: () => void } | null => {
    if (!["bob", "long", "curly", "ponytail", "bun"].includes(hair)) return null;
    const key = depth(madd(hc, hFwd, -rz * 0.8));
    return {
      key,
      draw: () => {
        if (hair === "ponytail") {
          const b0 = madd(madd(hc, hFwd, -rz * 0.95), hUp, ry * (hair0 === "lowtail" ? -0.45 : 0.25));
          const sway = Math.sin(c.time * 3.2 + c.speed) * 0.04 * H * (0.3 + c.speed * 0.3);
          const b1 = madd(madd(b0, hFwd, -rz * 0.45), hUp, -ry * 0.55);
          const b2 = add(madd(madd(b0, hFwd, -rz * 0.35 - c.speed * 0.03), hUp, -ry * 1.5), scale(fwd, -sway));
          em.add(strokeVar(new Pen(), [S(b0), S(b1), S(b2)], [rx * 0.24, rx * 0.26, rx * 0.06]), "hair", { tone: 0 });
          return;
        }
        if (hair === "bun") {
          const b = S(hair0 === "topknot" ? madd(hc, hUp, ry * 1.12) : madd(madd(hc, hFwd, -rz * 0.8), hUp, ry * 0.72));
          em.add(new Pen().ellipse(b[0], b[1], rx * 0.38, rx * 0.36), "hair", { tone: 0 });
          return;
        }
        const extra: V3[] = [];
        const low = hair === "long" ? 2.5 : 1.0;
        for (const s of [-1, 1]) {
          extra.push(madd(madd(madd(hc, hUp, -ry * low), hLft, s * rx * (hair === "long" ? 1.15 : 1.08)), hFwd, -rz * 0.15));
          extra.push(madd(madd(madd(hc, hUp, -ry * low * 0.9), hLft, s * rx * 0.7), hFwd, -rz * 0.7));
        }
        const pts = capHull(hair0 === "afro" ? 1.45 : hair === "curly" ? 1.2 : 1.1, [0, 0, -1], -0.25, hc, extra);
        const pen = hair === "curly" || hair0 === "wavy" ? bumpy(pts, rx * (hair0 === "afro" ? 0.18 : hair0 === "wavy" ? 0.07 : 0.12)) : new Pen().smooth(pts, true);
        em.add(pen, "hair", { tone: -1 });
        if (hair === "long") {
          const sl = new Pen();
          for (const s of [-0.6, 0, 0.6]) {
            const a = S(madd(madd(hc, hLft, s * rx), hFwd, -rz)), b = S(madd(madd(madd(hc, hUp, -ry * 2.3), hLft, s * rx * 1.05), hFwd, -rz * 0.3));
            sl.M(a[0], a[1]).Q(b[0] + rx * 0.1, (a[1] + b[1]) / 2, b[0], b[1]);
          }
          em.line(sl, "hair", 0.5, { tone: -2 });
        }
      },
    };
  };

  const hairK = hair0 === "afro" ? 1.42 : hair0 === "shaved" ? 1.01 : hair === "crop" || hair === "mohawk" ? 1.035 : hair === "curly" ? 1.16 : 1.09;
  const hairThr = hair === "crop" ? 0.16 : hair === "mohawk" ? 0.3 : hair === "curly" ? -0.02 : 0.04;
  /** Calotte complète derrière la tête (volume des cheveux autour du crâne). */
  const hairBehind = () => {
    if (hair === "none") return;
    const pts = capHull(hairK, hairN, hairThr);
    em.add(hair === "curly" ? bumpy(pts, rx * 0.1) : new Pen().smooth(pts, true), "hair", { tone: -1 });
  };
  const hairCap = () => {
    if (hair === "none") return;
    const k = hairK;
    const thr = hairThr;
    const pts = capFront(k, hairN, thr);
    if (pts.length > 2) em.add(hair === "curly" ? bumpy(pts, rx * (hair0 === "afro" ? 0.16 : 0.08)) : new Pen().smooth(pts, true), "hair", { tone: 0, alpha: hair0 === "shaved" ? 0.55 : 1 });
    if (hair0 === "sidepart" && faceVis > -0.2) {
      const a = S(onHead(0.35, 0.55, k)), b = S(onHead(0.25, 1.2, k));
      em.line(new Pen().M(a[0], a[1]).L(b[0], b[1]), "hair", 0.9, { tone: -2 });
    }
    // reflet
    const sh: V3[] = [];
    for (let i = 0; i <= 4; i++) sh.push(onHead(-0.9 + i * 0.35, 0.95 - Math.abs(i - 2) * 0.05, k * 0.98));
    const sp = sh.map(S);
    if (dot(hUp, vdir) > -0.5) em.add(strokeVar(new Pen(), sp, [rx * 0.02, rx * 0.07, rx * 0.09, rx * 0.07, rx * 0.02]), "hair", { tone: 1, stroke: null, alpha: 0.75 });
    // frange (visible de face et de trois-quarts)
    if ((hair === "bob" || hair === "long" || hair === "short" || hair === "curly") && faceVis > -0.1) {
      const fr2 = new Pen();
      const n = hair === "short" ? 4 : 6;
      for (let i = 0; i < n; i++) {
        const lon = -0.75 + (i / (n - 1)) * 1.5;
        const a = onHead(lon - 0.12, 0.5, k), b = onHead(lon + 0.12, 0.5, k), t = onHead(lon + 0.05, hair === "short" ? 0.36 : 0.22, 1.02);
        if (vis(lon, 0.4) < 0) continue;
        const A = S(a), B = S(b), Tt = S(t);
        fr2.M(A[0], A[1]).Q(Tt[0] - rx * 0.05, (A[1] + Tt[1]) / 2, Tt[0], Tt[1]).Q(B[0], (B[1] + Tt[1]) / 2, B[0], B[1]).Z();
      }
      if (!fr2.empty) em.add(fr2, "hair", { tone: 0, stroke: null });
    }
    if (hair === "mohawk") {
      const crest = new Pen();
      const base: P2[] = [], tips: P2[] = [];
      for (let i = 0; i <= 8; i++) {
        const lat = 0.55 + (i / 8) * 1.9;
        base.push(S(add(hc, add(scale(hUp, ry * Math.sin(lat)), scale(hFwd, rz * Math.cos(lat))))));
        tips.push(S(add(hc, add(scale(hUp, ry * Math.sin(lat) * 1.45), scale(hFwd, rz * Math.cos(lat) * 1.45)))));
      }
      crest.M(base[0][0], base[0][1]);
      for (let i = 0; i <= 8; i++) crest.L(tips[i][0], tips[i][1]).L(lerp2(base[i], base[Math.min(8, i + 1)], 0.5)[0], lerp2(base[i], base[Math.min(8, i + 1)], 0.5)[1]);
      crest.L(base[8][0], base[8][1]).Z();
      em.add(crest, "hair", { tone: 0, width: 0.6 });
    }
  };

  const ring = (center: V3, ax1: V3, ax2: V3, r1: number, r2: number, n = 24): V3[] => {
    const out: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(add(center, add(scale(ax1, Math.cos(a) * r1), scale(ax2, Math.sin(a) * r2))));
    }
    return out;
  };
  const hullPen = (pts: V3[]) => new Pen().smooth(hull(pts.map(S)), true);

  /** Partie arrière des calottes de chapeau (dessinée avant la tête). */
  const hatBehind = () => {
    const fill = hat === "straw" ? "path" : hat === "helmet" ? "metal" : "accent";
    if (hat === "cap") em.add(new Pen().smooth(capHull(1.13, [0, 1, 0], 0.22), true), fill, { tone: -1 });
    if (hat === "straw") em.add(new Pen().smooth(capHull(1.12, [0, 1, 0], 0.28), true), fill, { tone: -1 });
    if (hat === "helmet") em.add(new Pen().smooth(capHull(1.18, [0, 0.95, -0.3], 0.12), true), fill, { tone: -1 });
    if (hat === "hood") em.add(new Pen().smooth(capHull(1.32, [0, 0.4, -0.92], -0.5, hc, [madd(madd(hc, hUp, -ry * 1.3), hLft, rx * 1.1), madd(madd(hc, hUp, -ry * 1.3), hLft, -rx * 1.1)]), true), "cloth3", { tone: -1 });
    if (hat === "beanie" || hat === "bandana" || hat === "turban" || hat === "toque") em.add(new Pen().smooth(capHull(hat === "turban" ? 1.28 : 1.1, [0, 1, 0], 0.2), true), hat === "toque" ? "paper" : "accent", { tone: -1 });
  };
  const hatDraw = () => {
    if (hat === "none") return;
    const hatFill = hat === "tophat" ? "#2b2a33" : hat === "straw" ? "path" : hat === "helmet" ? "metal" : hat === "crown" ? "#d3a443" : hat === "wizard" ? "#4a4f8f" : "accent";
    const y0 = madd(hc, hUp, ry * (hat === "straw" ? 0.3 : hat === "wizard" ? 0.4 : 0.5));
    const brim = (r: number, lift = 0) => ring(madd(y0, hUp, lift), hLft, hFwd, rx * r, rz * r);
    switch (hat) {
      case "cap": {
        em.add(new Pen().smooth(capFront(1.13, [0, 1, 0], 0.22), true), hatFill, { tone: 0 });
        const vis0: V3[] = [];
        for (let i = 0; i <= 8; i++) {
          const lon = -1.1 + (i / 8) * 2.2;
          vis0.push(onHead(lon, 0.22, 1.12));
        }
        const outer = vis0.map((q) => madd(madd(q, hFwd, rz * 0.65), hUp, -ry * 0.05)).reverse();
        em.add(new Pen().smooth([...vis0, ...outer].map(S), true), hatFill, { tone: -1 });
        const b = S(onHead(0, Math.PI / 2, 1.13));
        em.add(new Pen().ellipse(b[0], b[1], rx * 0.08, rx * 0.06), hatFill, { tone: 1 });
        break;
      }
      case "beret": {
        const tilt = norm(add(hUp, scale(hLft, 0.25)));
        const e1 = norm(cross(tilt, hFwd)), e2 = cross(e1, tilt);
        em.add(hullPen(ring(madd(madd(hc, tilt, ry * 0.62), hFwd, -rz * 0.08), e1, e2, rx * 1.32, rz * 1.26)), hatFill, { tone: 0 });
        const st = S(madd(hc, tilt, ry * 1.02));
        em.add(strokeVar(new Pen(), [st, [st[0] + rx * 0.05, st[1] + rx * 0.15]], [rx * 0.05, rx * 0.03]), hatFill, { stroke: null });
        break;
      }
      case "tophat": {
        em.add(hullPen(brim(1.6, 0)), hatFill, { tone: 0 });
        const ch = ry * 1.45;
        const crown = [...ring(madd(y0, hUp, 0.01), hLft, hFwd, rx * 0.92, rz * 0.92), ...ring(madd(y0, hUp, ch), hLft, hFwd, rx * 1.0, rz * 1.0)];
        em.add(hullPen(crown), hatFill, { tone: 0 });
        em.add(hullPen([...ring(madd(y0, hUp, 0.01), hLft, hFwd, rx * 0.93, rz * 0.93), ...ring(madd(y0, hUp, ch * 0.22), hLft, hFwd, rx * 0.95, rz * 0.95)]), "accent", { tone: 0, width: 0.6 });
        if (pr.ay > 0) em.add(hullPen(ring(madd(y0, hUp, ch), hLft, hFwd, rx * 1.0, rz * 1.0)), hatFill, { tone: 1, width: 0.6 });
        break;
      }
      case "wizard": {
        em.add(hullPen(brim(1.85, 0)), hatFill, { tone: -1 });
        const midC = madd(madd(y0, hUp, ry * 1.2), hFwd, -rz * 0.25);
        const tip = madd(madd(y0, hUp, ry * 2.5), hFwd, -rz * 0.95);
        em.add(hullPen([...ring(y0, hLft, hFwd, rx * 1.02, rz * 1.02), ...ring(midC, hLft, hFwd, rx * 0.5, rz * 0.5)]), hatFill, { tone: 0 });
        em.add(hullPen([...ring(midC, hLft, hFwd, rx * 0.5, rz * 0.5), tip]), hatFill, { tone: 0 });
        const s0 = S(madd(madd(y0, hUp, ry * 0.8), hFwd, rz * 0.6));
        em.add(new Pen().poly(starPts(s0, rx * 0.16)), "lamp", { stroke: null });
        break;
      }
      case "straw": {
        const b = brim(2.15, -ry * 0.03);
        em.add(hullPen(b), hatFill, { tone: 0 });
        em.line(hullPen(brim(1.6, -ry * 0.02)), hatFill, 0.4, { tone: -1 });
        em.add(new Pen().smooth(capFront(1.12, [0, 1, 0], 0.28), true), hatFill, { tone: 0 });
        em.add(hullPen([...ring(madd(y0, hUp, 0), hLft, hFwd, rx * 1.0, rz * 1.0), ...ring(madd(y0, hUp, ry * 0.18), hLft, hFwd, rx * 0.97, rz * 0.97)]), "accent", { tone: 0, width: 0.5 });
        break;
      }
      case "helmet": {
        em.add(new Pen().smooth(capFront(1.18, [0, 0.95, -0.3], 0.12), true), hatFill, { tone: 0 });
        em.add(hullPen(ring(madd(hc, hUp, ry * 0.3), hLft, hFwd, rx * 1.2, rz * 1.2)), hatFill, { tone: -1, width: 0.6 });
        em.add(strokeVar(new Pen(), [S(onHead(-0.8, 0.8, 1.15)), S(onHead(-0.3, 1.1, 1.17)), S(onHead(0.3, 1.2, 1.17))], [rx * 0.02, rx * 0.06, rx * 0.02]), "paper", { stroke: null, alpha: 0.7 });
        break;
      }
      case "beanie": {
        em.add(new Pen().smooth(capFront(1.13, [0, 0.95, -0.25], 0.18), true), hatFill, { tone: 0 });
        em.add(hullPen([...ring(madd(hc, hUp, ry * 0.2), hLft, hFwd, rx * 1.12, rz * 1.12), ...ring(madd(hc, hUp, ry * 0.42), hLft, hFwd, rx * 1.1, rz * 1.1)]), hatFill, { tone: -1, width: 0.5 });
        const pp = S(madd(hc, hUp, ry * 1.18));
        em.add(bumpyCircle(pp, rx * 0.2), "paper", { tone: 0, width: 0.4 });
        break;
      }
      case "bandana": {
        em.add(new Pen().smooth(capFront(1.07, [0, 0.9, -0.42], 0.3), true), hatFill, { tone: 0 });
        const kn = S(madd(madd(hc, hFwd, -rz * 1.05), hUp, ry * 0.1));
        em.add(new Pen().M(kn[0], kn[1]).L(kn[0] - rx * 0.5, kn[1] - ry * 0.5).L(kn[0] - rx * 0.2, kn[1] - ry * 0.6).Z().M(kn[0], kn[1]).L(kn[0] + rx * 0.1, kn[1] - ry * 0.7).L(kn[0] + rx * 0.35, kn[1] - ry * 0.55).Z(), hatFill, { tone: -1, width: 0.45 });
        const dots = new Pen();
        for (let k = 0; k < 6; k++) {
          const q = S(onHead(-0.8 + k * 0.32, 0.75 + (k % 2) * 0.15, 1.08));
          if (vis(-0.8 + k * 0.32, 0.8) > 0) dots.ellipse(q[0], q[1], rx * 0.04, rx * 0.04);
        }
        em.add(dots, "paper", { stroke: null });
        break;
      }
      case "turban": {
        const pts = capHull(1.28, [0, 1, 0], 0.15);
        em.add(bumpy(pts, rx * 0.06), hatFill, { tone: 0 });
        const folds = new Pen();
        for (let k = 0; k < 3; k++) {
          const a = S(onHead(-1.0, 0.4 + k * 0.25, 1.26)), b = S(onHead(1.0, 0.55 + k * 0.2, 1.26)), m2 = S(onHead(0, 0.6 + k * 0.25, 1.3));
          folds.M(a[0], a[1]).Q(m2[0], m2[1], b[0], b[1]);
        }
        em.line(folds, hatFill, 0.7, { tone: -2 });
        if (faceVis > 0) {
          const j = S(onHead(0, 0.5, 1.3));
          em.add(new Pen().ellipse(j[0], j[1], rx * 0.1, rx * 0.12), "accent", { tone: 1, width: 0.4 });
        }
        break;
      }
      case "cowboy": {
        const br = ring(madd(hc, hUp, ry * 0.42), hLft, hFwd, rx * 2.0, rz * 1.8, 28).map((q, i) => madd(q, hUp, Math.abs(Math.cos((i / 28) * Math.PI * 2)) * ry * 0.3));
        em.add(hullPen(br), hatFill, { tone: -1 });
        const crown = [...ring(madd(hc, hUp, ry * 0.45), hLft, hFwd, rx * 0.95, rz * 0.95), ...ring(madd(hc, hUp, ry * 1.25), hLft, hFwd, rx * 0.82, rz * 0.82)];
        em.add(hullPen(crown), hatFill, { tone: 0 });
        const dent = S(madd(hc, hUp, ry * 1.25));
        em.line(new Pen().M(dent[0] - rx * 0.5, dent[1]).Q(dent[0], dent[1] - ry * 0.2, dent[0] + rx * 0.5, dent[1]), hatFill, 0.8, { tone: -2 });
        em.add(hullPen([...ring(madd(hc, hUp, ry * 0.46), hLft, hFwd, rx * 0.96, rz * 0.96), ...ring(madd(hc, hUp, ry * 0.62), hLft, hFwd, rx * 0.94, rz * 0.94)]), "leather", { width: 0.4 });
        break;
      }
      case "flowers": {
        const wr = new Pen(), ct = new Pen(), lv = new Pen();
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          const d = add(scale(hLft, Math.sin(a)), scale(hFwd, Math.cos(a)));
          if (dot(d, vdir) < -0.3) continue;
          const q = S(add(madd(hc, hUp, ry * 0.5), add(scale(hLft, Math.sin(a) * rx * 1.02), scale(hFwd, Math.cos(a) * rz * 1.02))));
          if (i % 2) lv.ellipse(q[0], q[1], rx * 0.1, rx * 0.06);
          else {
            for (let k = 0; k < 5; k++) wr.ellipse(q[0] + Math.cos((k / 5) * 6.28) * rx * 0.07, q[1] + Math.sin((k / 5) * 6.28) * rx * 0.07, rx * 0.06, rx * 0.06);
            ct.ellipse(q[0], q[1], rx * 0.04, rx * 0.04);
          }
        }
        em.add(lv, "leaf", { stroke: null });
        em.add(wr, "flower", { tone: 0, width: 0.3 });
        em.add(ct, "lamp", { stroke: null });
        break;
      }
      case "tricorn": {
        const pts: V3[] = [];
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          pts.push(add(madd(hc, hUp, ry * 0.75), add(scale(hLft, Math.sin(a) * rx * 1.8), scale(hFwd, Math.cos(a) * rz * 1.8))));
        }
        em.add(new Pen().smooth(hull([...pts, ...ring(madd(hc, hUp, ry * 0.45), hLft, hFwd, rx * 1.1, rz * 1.1)].map(S)), true), hatFill, { tone: -1 });
        em.add(new Pen().smooth(capFront(1.1, [0, 1, 0], 0.4), true), hatFill, { tone: 0 });
        em.line(new Pen().poly(pts.map(S)), "paper", 0.9, { alpha: 0.8 });
        break;
      }
      case "toque": {
        em.add(hullPen([...ring(madd(hc, hUp, ry * 0.45), hLft, hFwd, rx * 1.02, rz * 1.02), ...ring(madd(hc, hUp, ry * 0.9), hLft, hFwd, rx * 1.02, rz * 1.02)]), "paper", { tone: -1, width: 0.5 });
        const pts: P2[] = [];
        for (let i = 0; i < 20; i++) {
          const a = (i / 20) * Math.PI * 2;
          pts.push(S(add(madd(hc, hUp, ry * (1.35 + Math.sin(a) * 0.45)), scale(hLft, Math.cos(a) * rx * 1.25))));
        }
        em.add(bumpy(hull(pts), rx * 0.1), "paper", { tone: 0 });
        break;
      }
      case "hood": {
        const pts = capFront(1.3, [0, 0.55, -0.83], -0.35);
        if (pts.length > 2) em.add(new Pen().smooth(pts, true), "cloth3", { tone: 0 });
        if (faceVis > 0.2) {
          const rim: P2[] = [];
          for (let i = 0; i <= 10; i++) rim.push(S(onHead(-1.15 + (i / 10) * 2.3, 0.6 * Math.sin((i / 10) * Math.PI) - 0.3, 1.18)));
          em.line(new Pen().smooth(rim, false), "cloth3", 1.6, { tone: -1 });
        }
        break;
      }
      case "crown": {
        const base = madd(hc, hUp, ry * 0.6);
        const r0 = ring(base, hLft, hFwd, rx * 0.98, rz * 0.98, 20);
        const band = [...r0, ...ring(madd(base, hUp, ry * 0.25), hLft, hFwd, rx * 1.0, rz * 1.0, 20)];
        const spikes = new Pen();
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          const d = add(scale(hLft, Math.sin(a)), scale(hFwd, Math.cos(a)));
          if (dot(d, vdir) < -0.2) continue;
          const b0 = add(madd(base, hUp, ry * 0.2), add(scale(hLft, Math.sin(a - 0.25) * rx), scale(hFwd, Math.cos(a - 0.25) * rz)));
          const b1 = add(madd(base, hUp, ry * 0.2), add(scale(hLft, Math.sin(a + 0.25) * rx), scale(hFwd, Math.cos(a + 0.25) * rz)));
          const tp = add(madd(base, hUp, ry * 0.62), add(scale(hLft, Math.sin(a) * rx * 1.02), scale(hFwd, Math.cos(a) * rz * 1.02)));
          spikes.poly([S(b0), S(tp), S(b1)]);
        }
        em.add(spikes, hatFill, { tone: 0, width: 0.6 });
        em.add(hullPen(band), hatFill, { tone: 0, width: 0.6 });
        const j = S(madd(madd(base, hUp, ry * 0.12), hFwd, rz));
        if (faceVis > 0) em.add(new Pen().ellipse(j[0], j[1], rx * 0.08, rx * 0.08), "accent", { tone: 1, stroke: null });
        break;
      }
    }
  };

  /* ---------------- vêtements : motifs, gilet, veste, tablier, armure, salopette, col, ceinture, détails ---------------- */
  const outfitExtras = () => {
    const front = facing > 0.25;
    if (pattern !== "plain" && top !== "none") {
      const pen = new Pen();
      if (pattern === "stripes" || pattern === "checks")
        for (let t = 0.1; t < 1; t += 0.15) {
          const [a, b] = section(lerp3(lvShoulder.c, lvHip.c, t), lerpN(lvShoulder.w, lvHip.w, t) * 0.96, lerpN(lvShoulder.d, lvHip.d, t));
          pen.M(a[0], a[1]).L(b[0], b[1]);
        }
      if (pattern === "vstripes" || pattern === "checks") {
        const [a1, b1] = section(lvShoulder.c, lvShoulder.w * 0.9, lvShoulder.d), [a2, b2] = section(lvHip.c, lvHip.w, lvHip.d);
        for (let t = 0.12; t < 0.9; t += 0.152) {
          const u = lerp2(a1, b1, t), v = lerp2(a2, b2, t);
          pen.M(u[0], u[1]).L(v[0], v[1]);
        }
      }
      em.line(pen, "cloth3", pattern === "checks" ? 0.9 : 1.3, { alpha: 0.85 });
    }
    if (over === "vest" || over === "jacket" || over === "armor") {
      const role = over === "armor" ? "metal" : "cloth3";
      const lv = [{ ...lvShoulderTop, w: lvShoulderTop.w * 1.05 }, { ...lvShoulder, w: lvShoulder.w * (over === "vest" ? 0.86 : 1.06), d: lvShoulder.d * 1.08 }, { ...lvChest, w: lvChest.w * 1.05, d: lvChest.d * 1.08 }, { ...lvWaist, w: lvWaist.w * 1.06, d: lvWaist.d * 1.08 }, { ...lvHip, w: lvHip.w * (over === "jacket" ? 1.12 : 1.04), d: lvHip.d * 1.1 }];
      em.add(outline(lv, false), role, {});
      if (front && over !== "armor") {
        // ouverture en V : le haut reparaît
        const c0 = S(madd(chestT, fwd, chestR)), c1 = S(madd(lvWaist.c, fwd, lvWaist.df ?? lvWaist.d)), c2 = S(madd(lvHip.c, fwd, lvHip.d));
        const w = headW * 0.32;
        em.add(new Pen().poly([[c0[0] - w, c0[1]], [c0[0] + w, c0[1]], [c1[0] + w * 0.15, c1[1]], [c2[0], c2[1]], [c1[0] - w * 0.15, c1[1]]]), "cloth1", { tone: 0, width: 0.5 });
        const bt = new Pen();
        for (let i = 0; i < 3; i++) {
          const q = lerp2(c1, c0, 0.15 + i * 0.25);
          bt.ellipse(q[0] + w * 0.35, q[1], headW * 0.03, headW * 0.03);
        }
        em.add(bt, "metal", { stroke: null });
      }
      if (over === "armor") {
        const c0 = S(madd(chestT, fwd, chestR)), c2 = S(madd(lvHip.c, fwd, lvHip.d));
        em.line(new Pen().M(c0[0], c0[1]).L(c2[0], c2[1]), "metal", 1, { tone: 1 });
        const pl = new Pen();
        for (const t of [0.55, 0.75, 0.92]) {
          const [a, b] = section(lerp3(lvShoulder.c, lvHip.c, t), lerpN(lvShoulder.w, lvHip.w, t) * 1.05, lerpN(lvShoulder.d, lvHip.d, t) * 1.08);
          pl.M(a[0], a[1]).L(b[0], b[1]);
        }
        em.line(pl, "metal", 0.8, { tone: -1 });
        const [h1] = section(lvChest.c, lvChest.w * 0.6, lvChest.d * 0.6);
        em.add(new Pen().ellipse(h1[0], h1[1], headW * 0.12, headW * 0.25), "paper", { tone: 1, stroke: null, alpha: 0.35 });
      }
    }
    if (bottom0 === "overalls" && facing > -0.3) {
      const [a, b] = section(lvChest.c, lvChest.w * 0.55, lvChest.d * 1.05, (lvChest.df ?? lvChest.d) * 1.05);
      const [c2, d2] = section(lvWaist.c, lvWaist.w * 0.62, lvWaist.d * 1.05, (lvWaist.df ?? lvWaist.d) * 1.05);
      em.add(new Pen().poly([a, b, d2, c2]), "cloth2", { tone: 0, width: 0.6 });
      const st = new Pen();
      for (const [q, s2] of [[a, "l"], [b, "r"]] as const) {
        const sh = S(madd(J(`upperarm.${s2}`), up, H * 0.005));
        st.M(q[0], q[1]).L(sh[0], sh[1]);
      }
      em.line(st, "cloth2", 2.2, { tone: -1 });
      em.add(new Pen().ellipse(a[0], a[1], headW * 0.04, headW * 0.04).ellipse(b[0], b[1], headW * 0.04, headW * 0.04), "metal", { stroke: null });
      if (front) em.add(new Pen().rrect(lerp2(a, b, 0.3)[0], lerp2(a, d2, 0.4)[1], Math.abs(b[0] - a[0]) * 0.4, Math.abs(a[1] - d2[1]) * 0.35, headW * 0.03), "cloth2", { tone: -1, width: 0.4 });
    }
    if (over === "apron" && facing > -0.4) {
      const pts: P2[] = [...section(lvChest.c, lvChest.w * 0.55, lvChest.d * 1.12, (lvChest.df ?? lvChest.d) * 1.12)];
      for (const s2 of ["l", "r"]) {
        const q = S(madd(lerp3(J(`thigh.${s2}`), J(`shin.${s2}`), 0.85), fwd, R(`thigh.${s2}`, 1) * 1.2));
        pts.push([q[0] - headW * 0.25, q[1]], [q[0] + headW * 0.25, q[1]]);
      }
      const h = hull(pts);
      em.add(new Pen().smooth(h, true), "paper", { tone: 0 });
      const [w1, w2] = section(lvWaist.c, lvWaist.w * 1.04, lvWaist.d * 1.12, (lvWaist.df ?? lvWaist.d) * 1.12);
      em.add(strokeVar(new Pen(), [w1, w2], [H * 0.008, H * 0.008], { capStart: false, capEnd: false }), "paper", { tone: -1, stroke: null });
      if (front) {
        const pk = lerp2(w1, w2, 0.5);
        em.add(new Pen().rrect(pk[0] - headW * 0.3, pk[1] - headW * 0.55, headW * 0.6, headW * 0.35, headW * 0.05), "paper", { tone: -1, width: 0.4 });
      }
    }
    // col
    if (front && collar !== "none" && top !== "none") {
      const nc = S(madd(chestT, fwd, chestR * 0.6));
      const r = R("neck", 0) * 1.6;
      if (collar === "shirt") em.add(new Pen().M(nc[0], nc[1] - r * 0.6).L(nc[0] - r * 1.4, nc[1] + r * 0.2).L(nc[0] - r * 0.6, nc[1] + r * 0.9).Z().M(nc[0], nc[1] - r * 0.6).L(nc[0] + r * 1.4, nc[1] + r * 0.2).L(nc[0] + r * 0.6, nc[1] + r * 0.9).Z(), "paper", { tone: 0, width: 0.5 });
      else if (collar === "round") em.add(new Pen().M(nc[0] - r * 1.1, nc[1] + r * 0.6).Q(nc[0], nc[1] - r * 0.8, nc[0] + r * 1.1, nc[1] + r * 0.6).L(nc[0] + r * 0.9, nc[1] + r * 0.75).Q(nc[0], nc[1] - r * 0.5, nc[0] - r * 0.9, nc[1] + r * 0.75).Z(), "cloth3", { tone: 0, width: 0.45 });
    }
    if (collar === "turtle" && top !== "none") em.add(strokeVar(new Pen(), [S(J("neck")), S(lerp3(J("neck"), T("neck"), 0.65))], [R("neck", 0) * 1.55, R("neck", 1) * 1.45]), "cloth1", { tone: -1 });
    // ceinture, écharpe de taille
    if (belt !== "none") {
      const [a, b] = section(lvWaist.c, lvWaist.w * 1.06, lvWaist.d * 1.12, (lvWaist.df ?? lvWaist.d) * 1.12);
      em.add(strokeVar(new Pen(), [a, b], [H * (belt === "sash" ? 0.02 : 0.012), H * (belt === "sash" ? 0.02 : 0.012)], { capStart: false, capEnd: false }), belt === "sash" ? "accent" : "leather", { tone: 0, width: 0.4 });
      const mid = S(madd(lvWaist.c, fwd, (lvWaist.df ?? lvWaist.d) * 1.12));
      if (belt === "belt" && front) em.add(new Pen().rrect(mid[0] - H * 0.014, mid[1] - H * 0.012, H * 0.028, H * 0.024, H * 0.004), "metal", { tone: 1, width: 0.4 });
      if (belt === "sash") em.add(strokeVar(new Pen(), [mid, [mid[0] + H * 0.02, mid[1] - H * 0.08], [mid[0] + H * 0.01, mid[1] - H * 0.16]], [H * 0.014, H * 0.012, H * 0.008]), "accent", { tone: -1 });
    }
    // boutons, poches
    if (front && top !== "none" && (details === "buttons" || details === "full") && over === "none") {
      const c0 = S(madd(chestT, fwd, chestR * 0.95)), c1 = S(madd(lvWaist.c, fwd, (lvWaist.df ?? lvWaist.d) * 0.98));
      const bt = new Pen();
      for (let i = 0; i < 4; i++) {
        const q = lerp2(c0, c1, 0.15 + i * 0.25);
        bt.ellipse(q[0], q[1], headW * 0.028, headW * 0.028);
      }
      em.add(bt, "cloth3", { stroke: null });
      em.line(new Pen().M(c0[0], c0[1]).L(c1[0], c1[1]), "cloth1", 0.5, { tone: -2 });
    }
    if (front && top !== "none" && (details === "pockets" || details === "full")) {
      const pk = new Pen();
      for (const sd of [-1, 1]) {
        const [q] = section(lvChest.c, lvChest.w * 0.45 * sd, lvChest.d);
        pk.rrect(q[0] - headW * 0.18, q[1] - headW * 0.25, headW * 0.36, headW * 0.28, headW * 0.03);
      }
      em.add(pk, over === "none" ? "cloth1" : "cloth3", { tone: -1, width: 0.4 });
    }
  };

  /* ---------------- sac, cape, écharpe ---------------- */
  const chestC = lerp3(chestH, chestT, 0.4);
  const bagPart = (): { key: number; draw: () => void } | null => {
    if (bag === "backpack") {
      const c0 = madd(madd(chestC, fwd, -chestR * 1.05 - H * 0.04), up, -H * 0.02);
      return {
        key: depth(c0),
        draw: () => {
          obox(c0, scale(lft, shoulderHalf * 0.72), scale(up, H * 0.13), scale(fwd, H * 0.045), "cloth3");
          const fl = madd(c0, up, H * 0.07);
          if (facing < 0.3) obox(madd(fl, fwd, -H * 0.02), scale(lft, shoulderHalf * 0.74), scale(up, H * 0.06), scale(fwd, H * 0.03), "leather");
        },
      };
    }
    if (bag === "cape") {
      const back = madd(chestC, fwd, -chestR * 1.1);
      return {
        key: depth(back) - 0.01,
        draw: () => {
          const kneeY = J("shin.l")[1];
          const flow = -0.06 * H - c.speed * 0.09 * H;
          const tl = madd(madd(J("upperarm.l"), fwd, -chestR * 0.6), up, H * 0.01), tr = madd(madd(J("upperarm.r"), fwd, -chestR * 0.6), up, H * 0.01);
          const bl = madd(madd([tl[0], kneeY, tl[2]] as V3, lft, shoulderHalf * 0.45), fwd, flow), br = madd(madd([tr[0], kneeY, tr[2]] as V3, lft, -shoulderHalf * 0.45), fwd, flow);
          const bm = madd(lerp3(bl, br, 0.5), up, -H * 0.03);
          const pen = new Pen().M(...S(tl)).Q(...S(lerp3(tl, bl, 0.5)), ...S(bl)).Q(...S(lerp3(bl, bm, 0.5)), ...S(bm)).Q(...S(lerp3(bm, br, 0.5)), ...S(br)).Q(...S(lerp3(br, tr, 0.5)), ...S(tr)).Z();
          em.add(pen, "accent", { tone: facing > 0 ? -1 : 0 });
          const fd = new Pen();
          for (const t of [0.3, 0.55, 0.8]) {
            const a = S(lerp3(tl, tr, t)), b = S(lerp3(bl, br, t));
            fd.M(a[0], a[1]).Q(b[0] + (t - 0.5) * H * 0.04, (a[1] + b[1]) / 2, b[0], b[1]);
          }
          em.line(fd, "accent", 0.5, { tone: -2 });
        },
      };
    }
    return null;
  };
  const bagFront = () => {
    if (bag === "backpack" && facing > 0.35) {
      const st = new Pen();
      for (const s of ["l", "r"]) {
        const sh = J(`upperarm.${s}`);
        const a = S(madd(lerp3(sh, chestT, 0.35), up, H * 0.012)), b = S(madd(madd(lerp3(J(`thigh.${s}`), sh, 0.62), fwd, chestR * 0.7), lft, 0));
        strokeVar(st, [a, lerp2(a, b, 0.5), b], [H * 0.008, H * 0.008, H * 0.007]);
      }
      em.add(st, "leather", { tone: 0, stroke: null });
    }
    if (bag === "pouch") {
      const hp = madd(madd(J("thigh.r"), lft, -hipHalf * 0.5), up, H * 0.02);
      const q = S(hp);
      em.add(new Pen().M(q[0] - H * 0.025, q[1]).Q(q[0] - H * 0.03, q[1] - H * 0.06, q[0], q[1] - H * 0.065).Q(q[0] + H * 0.03, q[1] - H * 0.06, q[0] + H * 0.025, q[1]).Z(), "leather", { tone: 0, width: 0.45 });
      em.line(new Pen().M(q[0] - H * 0.02, q[1] - H * 0.005).L(q[0] + H * 0.02, q[1] - H * 0.005), "leather", 0.6, { tone: -2 });
    }
    if (bag === "satchel") {
      const a = S(madd(J("upperarm.l"), up, H * 0.01)), hp = madd(madd(J("thigh.r"), lft, -hipHalf * 0.55), up, H * 0.03);
      const b = S(hp);
      em.add(strokeVar(new Pen(), [a, lerp2(a, b, 0.5), b], [H * 0.007, H * 0.007, H * 0.007]), "leather", { tone: -1, stroke: null });
      obox(madd(hp, up, -H * 0.03), scale(fwd, H * 0.06), scale(up, H * 0.05), scale(lft, H * 0.02), "leather");
    }
    if (bag === "scarf") {
      const nk = lerp3(J("neck"), T("neck"), 0.3);
      em.add(hullPen(ring(nk, lft, fwd, R("neck", 0) * 2.1, R("neck", 0) * 2.0, 12).concat(ring(madd(nk, up, H * 0.03), lft, fwd, R("neck", 0) * 1.9, R("neck", 0) * 1.8, 12))), "accent", { tone: 0 });
      const t0 = madd(madd(nk, fwd, R("neck", 0) * 1.6), lft, R("neck", 0) * 0.8);
      const t1 = madd(madd(madd(t0, up, -H * 0.12), fwd, H * 0.01 - c.speed * 0.02), lft, H * 0.01);
      em.add(strokeVar(new Pen(), [S(t0), S(lerp3(t0, t1, 0.5)), S(t1)], [H * 0.022, H * 0.02, H * 0.022], { capEnd: false }), "accent", { tone: -1 });
    }
  };
  /** Boîte orientée (centre, demi-axes monde) : faces visibles. */
  const obox = (c0: V3, a: V3, b: V3, d: V3, fill: string) => {
    const corner = (i: number, j: number, k: number) => add(c0, add(add(scale(a, i), scale(b, j)), scale(d, k)));
    const faces: [V3, [number, number, number][]][] = [
      [norm(d), [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
      [scale(norm(d), -1), [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
      [norm(a), [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
      [scale(norm(a), -1), [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
      [norm(b), [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
    ];
    for (const [n, q] of faces) {
      if (dot(n, vdir) <= 0.01) continue;
      const pts = q.map(([i, j, k]) => S(corner(i, j, k)));
      em.add(new Pen().smooth(pts, true), fill, { tone: n[1] > 0.5 ? 1 : dot(n, [-0.6, 0.7, 0.3]) > 0.2 ? 0 : -1, width: 0.7 });
    }
  };

  /* ---------------- objet tenu ---------------- */
  function drawItem(far: boolean) {
    const hd = J("hand.r"), tip = T("hand.r");
    const grip = lerp3(hd, tip, 0.45);
    const hu = D("hand.r", [0, 1, 0]);
    const iu = item === "sword" || item === "book" ? hu : norm(add(scale(hu, 0.35), [0, 0.65, 0]));
    const side = norm(cross(iu, vdir));
    const tone = far ? -1 : 0;
    const g = S(grip);
    if (item.startsWith("tool.")) {
      // outil : mêmes pièces que le générateur `tool`, dans le repère de la prise (côté, manche, avant)
      const t = heldToolParts(item.slice(5), H);
      if (!t) return;
      const fwd = norm(cross(side, iu));
      const W = (x: number, y: number, z: number): V3 => add(add(madd(grip, side, x), scale(iu, y)), scale(fwd, z));
      const wn = (n: V3): V3 => norm(add(add(scale(side, n[0]), scale(iu, n[1])), scale(fwd, n[2])));
      drawPartsOn({ P: (x, y, z) => S(W(x, y, z)), vis: (n) => dot(wn(n), vdir), tone: (n) => (wn(n)[1] > 0.5 ? 1 : dot(wn(n), [-0.6, 0.7, 0.3]) > 0.1 ? 0 : -1), depth: (v) => dot(W(v[0], v[1], v[2]), vdir), k: 1, em, lightSide: -1, toneBias: tone }, t.parts, { width: 0.45 });
      return;
    }
    switch (item) {
      case "staff": {
        const a = S(madd(grip, iu, -H * 0.42)), b = S(madd(grip, iu, H * 0.52)), k = S(madd(madd(grip, iu, H * 0.58), side, H * 0.03));
        em.add(strokeVar(new Pen(), [a, g, b, k], [H * 0.011, H * 0.012, H * 0.013, H * 0.008]), "wood", { tone });
        break;
      }
      case "sword": {
        const g0 = S(madd(grip, iu, -H * 0.05)), g1 = S(madd(grip, iu, H * 0.05)), b1 = S(madd(grip, iu, H * 0.48));
        em.add(strokeVar(new Pen(), [g1, lerp2(g1, b1, 0.5), b1], [H * 0.012, H * 0.011, H * 0.002], { capEnd: false }), "metal", { tone: tone + 1 });
        em.line(new Pen().M(...lerp2(g1, b1, 0.05)).L(...lerp2(g1, b1, 0.85)), "metal", 0.5, { tone: -1 });
        const c0 = S(madd(madd(grip, iu, H * 0.05), side, -H * 0.05)), c1 = S(madd(madd(grip, iu, H * 0.05), side, H * 0.05));
        em.add(strokeVar(new Pen(), [c0, c1], [H * 0.008, H * 0.008]), "#c9a042", { tone });
        em.add(strokeVar(new Pen(), [g0, g1], [H * 0.008, H * 0.008]), "leather", { tone });
        em.add(new Pen().ellipse(g0[0], g0[1], H * 0.01, H * 0.01), "#c9a042", { tone });
        break;
      }
      case "lantern": {
        const top0 = madd(grip, [0, 1, 0], -H * 0.02), body = madd(grip, [0, 1, 0], -H * 0.11);
        const a = S(top0), b = S(body);
        em.line(new Pen().M(a[0], a[1]).L(b[0], b[1] + H * 0.04), "metal", 0.8);
        const w = H * 0.035, h = H * 0.06;
        em.add(new Pen().ellipse(b[0], b[1], H * 0.25, H * 0.25), "lamp", { kind: "halo", stroke: null, alpha: 0.6 });
        em.add(new Pen().M(b[0] - w, b[1] + h * 0.5).L(b[0] + w, b[1] + h * 0.5).L(b[0] + w * 0.8, b[1] - h * 0.5).L(b[0] - w * 0.8, b[1] - h * 0.5).Z(), "lamp", { kind: "glow", width: 0.6 });
        em.add(new Pen().M(b[0] - w * 1.2, b[1] + h * 0.5).Q(b[0], b[1] + h * 1.1, b[0] + w * 1.2, b[1] + h * 0.5).Z(), "metal", { width: 0.5 });
        break;
      }
      case "book": {
        const c0 = madd(grip, fwd, H * 0.01);
        const a = scale(side, H * 0.045), b = scale(iu, H * 0.06);
        const q = [add(c0, add(scale(a, -1), scale(b, -1))), add(c0, add(a, scale(b, -1))), add(c0, add(a, b)), add(c0, add(scale(a, -1), b))].map(S);
        em.add(new Pen().poly(q), "accent", { tone });
        em.add(new Pen().poly([q[1], q[2], lerp2(q[2], q[3], 0.12), lerp2(q[1], q[0], 0.12)]), "paper", { tone, stroke: null });
        break;
      }
      case "umbrella": {
        // parapluie fermé : fuseau de toile roulée, embout, poignée en crosse
        const tip0 = madd(grip, iu, -H * 0.06), top0 = madd(grip, iu, H * 0.5);
        const a0 = S(tip0), a1 = S(madd(grip, iu, H * 0.12)), a2 = S(madd(grip, iu, H * 0.36)), a3 = S(top0);
        em.add(strokeVar(new Pen(), [a1, lerp2(a1, a2, 0.5), a2, a3], [H * 0.006, H * 0.026, H * 0.022, H * 0.004]), "accent", { tone });
        em.line(new Pen().M(...lerp2(a1, a2, 0.15)).L(...lerp2(a2, a3, 0.6)), "accent", 0.5, { tone: -2 });
        em.add(strokeVar(new Pen(), [a0, a1], [H * 0.005, H * 0.005]), "metal", { tone });
        const hk = S(madd(madd(grip, iu, -H * 0.1), side, H * 0.035));
        em.line(new Pen().M(a0[0], a0[1]).Q(a0[0], hk[1] - H * 0.03, hk[0], hk[1]), "leather", 1.6);
        break;
      }
      case "torch": {
        const t0 = madd(grip, iu, H * 0.2);
        em.add(strokeVar(new Pen(), [S(madd(grip, iu, -H * 0.06)), S(t0)], [H * 0.008, H * 0.012]), "wood", { tone });
        const f = S(t0), fl = Math.sin(c.time * 11) * H * 0.008;
        em.add(new Pen().ellipse(f[0], f[1] + H * 0.03, H * 0.3, H * 0.3), "fire", { kind: "halo", stroke: null, alpha: 0.6 });
        em.add(new Pen().M(f[0] - H * 0.025, f[1]).Q(f[0] - H * 0.03, f[1] + H * 0.05, f[0] + fl, f[1] + H * 0.1).Q(f[0] + H * 0.03, f[1] + H * 0.05, f[0] + H * 0.025, f[1]).Z(), "fire", { kind: "glow", stroke: null });
        em.add(new Pen().M(f[0] - H * 0.012, f[1]).Q(f[0], f[1] + H * 0.05, f[0] + H * 0.012, f[1]).Z(), "lamp", { kind: "glow", stroke: null });
        break;
      }
      case "flower": {
        const t0 = madd(grip, iu, H * 0.13);
        em.add(strokeVar(new Pen(), [g, S(t0)], [H * 0.003, H * 0.003]), "leaf", { stroke: null });
        const f = S(t0);
        const pet = new Pen();
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          pet.ellipse(f[0] + Math.cos(a) * H * 0.012, f[1] + Math.sin(a) * H * 0.012, H * 0.011, H * 0.011);
        }
        em.add(pet, "flower", { width: 0.4 });
        em.add(new Pen().ellipse(f[0], f[1], H * 0.006, H * 0.006), "lamp", { stroke: null });
        break;
      }
      case "spear":
      case "pitchfork": {
        const a = S(madd(grip, iu, -H * 0.55)), b = S(madd(grip, iu, H * 0.7));
        em.add(strokeVar(new Pen(), [a, g, b], [H * 0.009, H * 0.01, H * 0.009]), "wood", { tone });
        const tip = madd(grip, iu, H * 0.7), sd = side;
        if (item === "spear") {
          const t1 = S(madd(tip, iu, H * 0.14));
          em.add(new Pen().M(b[0], b[1]).L(...S(madd(madd(tip, iu, H * 0.04), sd, H * 0.025))).L(t1[0], t1[1]).L(...S(madd(madd(tip, iu, H * 0.04), sd, -H * 0.025))).Z(), "metal", { tone: tone + 1, width: 0.45 });
        } else {
          const bar = new Pen();
          const l = S(madd(tip, sd, -H * 0.05)), r = S(madd(tip, sd, H * 0.05));
          bar.M(l[0], l[1]).L(r[0], r[1]);
          for (const k of [-0.05, 0, 0.05]) {
            const s0 = S(madd(tip, sd, H * k)), s1 = S(madd(madd(tip, sd, H * k * 1.1), iu, H * 0.13));
            bar.M(s0[0], s0[1]).L(s1[0], s1[1]);
          }
          em.line(bar, "metal", 1.4, { tone });
        }
        break;
      }
      case "hammer": {
        const a = S(madd(grip, iu, -H * 0.05)), b = S(madd(grip, iu, H * 0.22));
        em.add(strokeVar(new Pen(), [a, b], [H * 0.009, H * 0.008]), "wood", { tone });
        const h0 = S(madd(madd(grip, iu, H * 0.22), side, -H * 0.05)), h1 = S(madd(madd(grip, iu, H * 0.22), side, H * 0.06));
        em.add(strokeVar(new Pen(), [h0, h1], [H * 0.022, H * 0.02], { capStart: false, capEnd: false }), "metal", { tone, width: 0.5 });
        break;
      }
      case "wand": {
        const b = S(madd(grip, iu, H * 0.2));
        em.add(strokeVar(new Pen(), [g, b], [H * 0.005, H * 0.003]), "bark", { tone });
        em.add(new Pen().ellipse(b[0], b[1], H * 0.05, H * 0.05), "lamp", { kind: "halo", stroke: null, alpha: 0.7 });
        em.add(new Pen().poly(starPts(b, H * 0.022)), "lamp", { kind: "glow", stroke: null });
        break;
      }
      case "mug": {
        const w = H * 0.026, h = H * 0.05;
        const q = S(madd(grip, fwd, H * 0.02));
        em.add(new Pen().M(q[0] + w, q[1] + h * 0.2).Q(q[0] + w * 2, q[1] + h * 0.1, q[0] + w, q[1] - h * 0.5), "none", { stroke: "paper", width: 1.6, kind: "line" });
        em.add(new Pen().rrect(q[0] - w, q[1] - h * 0.6, w * 2, h * 1.1, w * 0.3), "paper", { tone });
        em.add(new Pen().ellipse(q[0], q[1] + h * 0.5, w, w * 0.3), "wood", { tone: -1, width: 0.4 });
        break;
      }
    }
  }

  /* ---------------- assemblage ---------------- */
  const chestKey = depth(chestC);
  const legKeys = legs.map((l) => l.key);
  const minLeg = Math.min(...legKeys);
  legs.slice().sort((a, b) => a.key - b.key).forEach((l, i) => parts.push({ key: minLeg - 1 + i * 1e-3, draw: legDraw(l) }));
  parts.push({ key: minLeg - 0.5, draw: lowerDraw });
  parts.push({ key: chestKey, draw: () => { torsoDraw(); outfitExtras(); bagFront(); } });
  for (const a of arms) parts.push({ key: a.far ? chestKey - 0.2 - (a.side === "r" ? 0 : 1e-3) : chestKey + 0.1 + (a.key - chestKey) * 0.01, draw: armDraw(a) });
  const bp = bagPart();
  if (bp) parts.push({ key: bp.key < chestKey ? Math.min(bp.key, minLeg - 2) : chestKey + 0.05, draw: bp.draw });
  const headKey = chestKey + 0.5;
  const hb = hairBack();
  if (hair0 === "pigtails" || hair0 === "braids") {
    for (const sd of [-1, 1]) {
      const base = madd(madd(hc, hLft, sd * rx * 0.95), hUp, hair0 === "pigtails" ? ry * 0.1 : -ry * 0.2);
      const k0 = depth(base);
      parts.push({
        key: k0 < depth(hc) ? headKey - 0.02 : headKey + 0.03,
        draw: () => {
          const sway = Math.sin(c.time * 3 + sd) * 0.02 * H;
          if (hair0 === "pigtails") {
            const m1 = madd(madd(base, hLft, sd * rx * 0.45), hUp, -ry * 0.4), e = add(madd(madd(base, hLft, sd * rx * 0.5), hUp, -ry * 1.3), scale(fwd, sway));
            em.add(strokeVar(new Pen(), [S(base), S(m1), S(e)], [rx * 0.22, rx * 0.26, rx * 0.08]), "hair", { tone: 0 });
            em.add(new Pen().ellipse(S(base)[0], S(base)[1], rx * 0.12, rx * 0.12), "accent", { width: 0.4 });
          } else {
            const e = add(madd(madd(base, hFwd, rz * 0.4), hUp, -ry * 2.2), scale(lft, sd * shoulderHalf * 0.3));
            const pts2: P2[] = [];
            for (let i = 0; i <= 6; i++) pts2.push(S(lerp3(base, e, i / 6)));
            em.add(strokeVar(new Pen(), pts2, pts2.map((_, i) => rx * (0.16 - i * 0.012))), "hair", { tone: 0 });
            const br = new Pen();
            for (let i = 1; i < 6; i++) {
              const q = pts2[i];
              br.M(q[0] - rx * 0.1, q[1] + rx * 0.05).Q(q[0], q[1] - rx * 0.06, q[0] + rx * 0.1, q[1] + rx * 0.05);
            }
            em.line(br, "hair", 0.6, { tone: -2 });
            const tie = pts2[6];
            em.add(new Pen().ellipse(tie[0], tie[1], rx * 0.07, rx * 0.06), "accent", { stroke: null });
          }
        },
      });
    }
  }
  if (hb) parts.push({ key: hb.key < depth(hc) ? (hair === "long" ? minLeg - 1.5 : headKey - 0.01) : headKey + 0.01, draw: hb.draw });
  const earBehind = (s: number) => vis(s * 1.5, -0.05) < 0.05;
  parts.push({
    key: headKey,
    draw: () => {
      hairBehind();
      hatBehind();
      for (const s of [-1, 1]) if (earBehind(s)) ear(s);
      em.add(headShape(), "skin", { tone: 0 });
      // ombre portée sous le menton (cou)
      for (const s of [-1, 1]) if (!earBehind(s)) ear(s);
      face();
    },
  });
  parts.push({ key: headKey + 0.02, draw: () => { hairCap(); hatDraw(); } });
  void handItemKey;
  parts.sort((a, b) => a.key - b.key);
  // ombre de contact au sol
  if (shadows && ground) {
    const g0 = ground(c.pos[0], c.pos[2]) + 0.02;
    const r = shoulderHalf * 1.5;
    const sx = c.pos[0] + 0.25 * H * 0.3, sz = c.pos[2] - 0.1 * H * 0.3;
    const pts: P2[] = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      pts.push(pr.p(c.pos[0] + Math.cos(a) * r, g0, c.pos[2] + Math.sin(a) * r * 0.8));
      pts.push(pr.p(sx + Math.cos(a) * r * 0.9, g0, sz + Math.sin(a) * r * 0.7));
    }
    shadows.push({ d: new Pen().smooth(hull(pts), true).d, fill: "shadow", kind: "shadow", z: em.z0 - 0.5, layer: em.layer, objId: 0, depth: em.depth });
  }
  for (const part of parts) part.draw();
}

function bumpyCircle(c: P2, r: number): Pen {
  const pts: P2[] = [];
  for (let i = 0; i < 10; i++) pts.push([c[0] + Math.cos((i / 10) * Math.PI * 2) * r, c[1] + Math.sin((i / 10) * Math.PI * 2) * r]);
  return bumpy(pts, r * 0.25);
}

function starPts(c: P2, r: number): P2[] {
  return Array.from({ length: 10 }, (_, i) => {
    const a = Math.PI / 2 + (i * Math.PI) / 5, k = i % 2 ? r * 0.42 : r;
    return [c[0] + Math.cos(a) * k, c[1] + Math.sin(a) * k] as P2;
  });
}

/** Contour bosselé (boucles) autour d'une enveloppe. */
function bumpy(pts: P2[], amp: number): Pen {
  const pen = new Pen();
  if (pts.length < 3) return pen;
  // rééchantillonnage régulier du contour
  const per: P2[] = [];
  let L = 0;
  for (let i = 0; i < pts.length; i++) L += Math.hypot(pts[(i + 1) % pts.length][0] - pts[i][0], pts[(i + 1) % pts.length][1] - pts[i][1]);
  const n = Math.max(8, Math.round(L / (amp * 2.2)));
  let seg = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * L;
    while (seg < pts.length) {
      const a = pts[seg], b = pts[(seg + 1) % pts.length];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + l >= target) {
        const t = l ? (target - acc) / l : 0;
        per.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        break;
      }
      acc += l;
      seg++;
    }
  }
  const cx = per.reduce((s, q) => s + q[0], 0) / per.length, cy = per.reduce((s, q) => s + q[1], 0) / per.length;
  pen.M(per[0][0], per[0][1]);
  for (let i = 0; i < per.length; i++) {
    const a = per[i], b = per[(i + 1) % per.length];
    const m: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d = norm2([m[0] - cx, m[1] - cy]);
    pen.Q(m[0] + d[0] * amp * 1.6, m[1] + d[1] * amp * 1.6, b[0], b[1]);
  }
  return pen.Z();
}

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const dot2 = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
function norm2(v: P2): P2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}
