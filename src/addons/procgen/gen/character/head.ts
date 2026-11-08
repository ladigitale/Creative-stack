/**
 * Tête : champ implicite propre, polygonisé plus finement que le corps (nez, oreilles, lèvres, barbe, mèches et bords
 * de chapeau lisibles). Le bas du cou y est un peu plus fin que celui du corps : la jonction se fait à l'intérieur.
 *
 * Les repères du visage (yeux, bouche, pointe du nez, oreilles) sont trouvés par **lancer de rayon** sur la peau : les
 * gabarits suivent la forme réelle de la tête (ronde, ovale, carrée, longue) au lieu d'un ellipsoïde théorique.
 */
import { type V3, add, dot, madd, mix, norm } from "../../core/math";
import { type Blend, Field, type FieldPrim } from "../../geom/implicit";
import type { Archetype } from "../../rig/humanoid";
import { ROLE } from "../../style/roles";
import { type Kit, type PrimIn, PrimSet, inflate } from "./kit";

export type HeadField = {
  set: PrimSet;
  blends: Blend[];
  headC: V3;
  headR: V3;
  /** Lignes du visage (y monde) et demi-écart des yeux. */
  eyeY: number;
  eyeX: number;
  eyeR: number;
  mouthY: number;
  mouthW: number;
  noseTipY: number;
  noseTip: V3;
  ears: V3[];
  /** Peau seule (yeux, sourcils, rides) et peau + pilosité (bouche) : champs de lancer de rayon. */
  skin: Field;
  faceSurf: Field;
  topY: number;
  /** Une barbe ou une moustache masque la bouche. */
  mouthHidden: boolean;
};

export function buildHeadField(k: Kit): HeadField {
  const { look, P, H, v } = k;
  const arch = look.archetype as Archetype;
  const set = new PrimSet(k.skel);
  const S = ROLE.skin, HR = ROLE.hair;
  const hh = P.headH, hw = P.headW, hd = P.headD;
  const neckTop = k.B("head").head;
  const headC: V3 = [0, P.chinY + hh * 0.5, P.headD * 0.02 + neckTop[2] + hd * 0.05];
  const headR: V3 = [hw * 0.5, hh * 0.5, hd * 0.5];
  const chibi = arch === "chibi", toon = arch === "chibi" || arch === "cartoon";
  const shape = look.headShape;
  const sk = (g: string, f: PrimIn, role = S) => set.add({ ...f, role, tag: 0 } as FieldPrim, "head", g);
  /** Personnage animal : ni nez, ni oreilles, ni lèvres humains ; museau et oreilles de l'espèce. */
  const an = look.animal !== "none" ? look.animal : "";

  /* ---------- crâne et visage ---------- */
  const tall = shape === "long" ? 1.06 : shape === "round" ? 0.96 : 1;
  const cc: V3 = add(headC, [0, hh * 0.06, -hd * 0.04]);
  const cr: V3 = chibi ? [hw * 0.52, hh * 0.48, hd * 0.5] : [hw * (shape === "round" ? 0.51 : shape === "long" ? 0.47 : 0.495), hh * 0.44 * tall, hd * 0.5];
  sk("skull", { kind: "ellipsoid", c: cc, r: cr });
  let face: FieldPrim | null = null;
  const fy = chibi ? 0.6 : 1;
  switch (shape) {
    case "round":
      face = { kind: "ellipsoid", c: add(headC, [0, -hh * 0.12 * fy, hd * 0.06]), r: [hw * 0.47, hh * 0.33, hd * 0.42], role: S, tag: 0 };
      break;
    case "square":
      face = { kind: "box", c: add(headC, [0, -hh * 0.19 * fy, hd * 0.05]), h: [hw * (chibi ? 0.46 : 0.43), hh * 0.27, hd * 0.4], round: hw * (chibi ? 0.25 : 0.17), role: S, tag: 0 };
      break;
    case "long":
      face = { kind: "ellipsoid", c: add(headC, [0, -hh * 0.22 * fy, hd * 0.07]), r: [hw * 0.38, hh * 0.37, hd * 0.39], role: S, tag: 0 };
      break;
    default:
      face = { kind: "ellipsoid", c: add(headC, [0, -hh * 0.17 * fy, hd * 0.07]), r: [hw * 0.41, hh * 0.34, hd * 0.4], role: S, tag: 0 };
  }
  const faceIdx = set.add(face, "head", "skull");
  const chinPt: V3 = add(headC, [0, -hh * (shape === "long" ? 0.43 : shape === "round" ? 0.38 : 0.41) * (chibi ? 0.85 : 1), hd * 0.3]);
  if (!chibi) {
    const cw = shape === "square" ? 0.17 : shape === "round" ? 0.13 : 0.12;
    sk("skull", { kind: "ellipsoid", c: chinPt, r: [hw * cw, hh * 0.075, hd * 0.12] });
    for (const sx of [1, -1]) sk("skull", { kind: "ellipsoid", c: add(headC, [sx * hw * 0.27, -hh * 0.07, hd * 0.24]), r: [hw * 0.13, hh * 0.085, hd * 0.13] });
    sk("skull", { kind: "ellipsoid", c: add(headC, [0, hh * 0.11, hd * (arch === "heroic" ? 0.37 : 0.35)]), r: [hw * 0.33, hh * (arch === "heroic" ? 0.07 : 0.06), hd * 0.1] });
  }
  // moignon de cou, plus fin que le cou du corps (qui l'enveloppe en bas)
  sk("skull", { kind: "capsule", a: k.at("neck", 0.3), b: add(k.at("neck", 1), [0, hh * 0.1, 0]), ra: k.rad("neck", 0.3) * 0.94, rb: k.rad("neck", 1) * 0.96 });
  const base = new Field(set.prims.slice(), set.groupBlends(() => hw * 0.14));
  const hit = (f: Field, x: number, y: number, z0 = headC[2] + hd * 1.6): { p: V3; n: V3 } => {
    const p = f.raycast([x, y, z0], [0, 0, -1], hd * 2.4, hh * 0.0005) ?? [x, y, headC[2] + hd * 0.4];
    return { p, n: f.gradient(p, hh * 0.004) };
  };

  /* ---------- repères ---------- */
  const eyeR = hw * { chibi: 0.12, cartoon: 0.105, stylized: 0.088, heroic: 0.074 }[arch];
  const eyeX = hw * { chibi: 0.24, cartoon: 0.21, stylized: 0.19, heroic: 0.18 }[arch] * (shape === "round" ? 1.04 : shape === "long" ? 0.96 : 1);
  const eyeY = headC[1] + headR[1] * { chibi: -0.12, cartoon: -0.05, stylized: 0.0, heroic: 0.02 }[arch];
  const mouthY = headC[1] + headR[1] * { chibi: -0.42, cartoon: -0.45, stylized: -0.5, heroic: -0.52 }[arch] * (shape === "long" ? 1.08 : 1);
  const noseTipY = mix(eyeY, mouthY, chibi ? 0.55 : 0.62);
  const mouthW = hw * (chibi ? 0.11 : 0.15);

  /* ---------- nez ---------- */
  const nose = look.nose;
  const nr = hw * (chibi ? 0.05 : toon ? 0.08 : 0.075);
  const root = hit(base, 0, eyeY - hh * 0.02);
  let tipY = noseTipY, proj = 0.55, tipR: V3 = [nr * 0.8, nr * 0.8, nr * 0.8];
  if (nose === "long") (tipY -= hh * 0.025), (proj = 0.85), (tipR = [nr * 0.75, nr * 0.95, nr * 0.8]);
  if (nose === "aquiline") (tipY -= hh * 0.02), (proj = 0.7), (tipR = [nr * 0.7, nr * 0.9, nr * 0.75]);
  if (nose === "wide") (proj = 0.45), (tipR = [nr * 1.15, nr * 0.85, nr * 0.85]);
  if (nose === "upturned") (tipY += hh * 0.012), (proj = 0.5), (tipR = [nr * 0.7, nr * 0.7, nr * 0.72]);
  if (nose === "button") (proj = 0.45), (tipR = [nr * 0.8, nr * 0.8, nr * 0.8]);
  const tipS = hit(base, 0, tipY);
  const noseTip = add(tipS.p, [0, nose === "upturned" ? nr * 0.15 : nose === "aquiline" ? -nr * 0.2 : 0, nr * proj]);
  if (!an) sk("nose", { kind: "ellipsoid", c: noseTip, r: tipR });
  if (!chibi && !an) {
    const bridgeA = madd(root.p, root.n, -nr * 0.15);
    if (nose === "aquiline") {
      const mid = add(mix3(bridgeA, noseTip, 0.45), [0, 0, nr * 0.75]);
      sk("nose", { kind: "capsule", a: bridgeA, b: mid, ra: nr * 0.32, rb: nr * 0.45 });
      sk("nose", { kind: "capsule", a: mid, b: noseTip, ra: nr * 0.45, rb: nr * 0.55 });
    } else sk("nose", { kind: "capsule", a: bridgeA, b: add(noseTip, [0, nr * 0.2, -nr * 0.15]), ra: nr * (nose === "button" || nose === "upturned" ? 0.24 : 0.32), rb: nr * 0.5 });
    // ailes du nez
    const wing = nose === "wide" ? 1.25 : 0.95;
    for (const sx of [1, -1]) sk("nose", { kind: "ellipsoid", c: add(noseTip, [sx * nr * 0.72 * wing, -nr * 0.28, -nr * 0.42]), r: [nr * 0.42 * wing, nr * 0.38, nr * 0.42] });
  }
  set.extraBlends.push(...set.prims.map((_, i) => i).filter((i) => set.group[i] === "nose").map((i) => ({ a: i, b: faceIdx, k: nr * 0.9 })));

  /* ---------- oreilles ---------- */
  const ears: V3[] = [];
  const earY = mix(eyeY, noseTipY, 0.55);
  const er = hh * (chibi ? 0.13 : 0.11) * ({ small: 0.82, round: 1, large: 1.22, pointed: 1 } as Record<string, number>)[look.ears];
  for (const sx of [1, -1]) {
    const e = base.raycast([sx * hw * 1.2, earY, cc[2] - hd * 0.02], [-sx, 0, 0], hw * 1.2, hh * 0.0005) ?? [sx * cr[0], earY, cc[2]];
    ears.push(e);
    const g = `ear.${sx}`;
    if (an) continue;
    const i0 = set.add({ kind: "ellipsoid", c: add(e, [sx * er * 0.24, 0, -er * 0.12]), r: [er * 0.3, er, er * 0.62], role: S, tag: 0 }, "head", g);
    if (look.ears === "pointed") set.add({ kind: "capsule", a: add(e, [sx * er * 0.15, er * 0.45, -er * 0.25]), b: add(e, [sx * er * 0.5, er * 1.75, -er * 0.75]), ra: er * 0.32, rb: er * 0.04, role: S, tag: 0 }, "head", g);
    // conque : un relief intérieur
    set.add({ kind: "ellipsoid", c: add(e, [sx * er * 0.3, -er * 0.05, -er * 0.02]), r: [er * 0.12, er * 0.62, er * 0.32], role: S, tag: 0 }, "head", g);
    set.extraBlends.push({ a: i0, b: 0, k: er * 0.25 });
  }

  /* ---------- lèvres ---------- */
  const mouthS = hit(base, 0, mouthY);
  const lh = look.lips === "full" ? hh * 0.03 : look.lips === "medium" ? hh * 0.021 : 0;
  const LIP = ROLE.sky;
  if (lh > 0 && !chibi && !an) {
    const n = mouthS.n;
    set.add({ kind: "ellipsoid", c: madd(add(mouthS.p, [0, lh * 0.55, 0]), n, -lh * 0.32), r: [mouthW * 0.95, lh * 0.55, lh * 0.75], role: LIP, tag: 0 }, "head", "lips");
    set.add({ kind: "ellipsoid", c: madd(add(mouthS.p, [0, -lh * 0.75, 0]), n, -lh * 0.28), r: [mouthW * 0.8, lh * 0.72, lh * 0.8], role: LIP, tag: 0 }, "head", "lips");
  }
  if (an) {
    const MZ = an === "dog" || an === "bear" ? ROLE.paper : an === "pig" || an === "dino" ? S : ROLE.white;
    const eh = hh * (chibi ? 0.22 : 0.2);
    const topY = cc[1] + cr[1] * 0.74;
    for (const sx of [1, -1]) {
      const g = `ear.${sx}`;
      const b0: V3 = [sx * cr[0] * 0.56, topY, cc[2] - cr[2] * 0.06];
      if (an === "cat" || an === "fox" || an === "owl") {
        const L = an === "fox" ? 2.3 : an === "owl" ? 1.25 : 1.65;
        const tip = add(b0, [sx * eh * (an === "owl" ? 0.55 : 0.32), eh * L, -eh * 0.12]);
        sk(g, { kind: "capsule", a: b0, b: tip, ra: eh * (an === "owl" ? 0.36 : 0.6), rb: eh * 0.05 });
        if (an !== "owl") sk(g, { kind: "capsule", a: add(b0, [0, eh * 0.2, eh * 0.3]), b: add(tip, [0, -eh * 0.3, eh * 0.12]), ra: eh * 0.32, rb: eh * 0.03 }, an === "fox" ? ROLE.white : ROLE.sky);
      } else if (an === "dog") {
        sk(g, { kind: "ellipsoid", c: [sx * cr[0] * 1.0, cc[1] + cr[1] * 0.12, cc[2] - cr[2] * 0.08], r: [eh * 0.34, eh * 1.35, eh * 0.78] }, HR);
      } else if (an === "bear" || an === "mouse") {
        const R = an === "mouse" ? 1.15 : 0.68;
        const c = add(b0, [sx * eh * 0.25, eh * R * 0.5, 0]);
        sk(g, { kind: "ellipsoid", c, r: [eh * R, eh * R, eh * 0.34] });
        sk(g, { kind: "ellipsoid", c: add(c, [0, 0, eh * 0.16]), r: [eh * R * 0.62, eh * R * 0.62, eh * 0.2] }, an === "mouse" ? ROLE.sky : MZ);
      } else if (an === "rabbit") {
        const tip = add(b0, [sx * eh * 0.45, eh * 3.1, -eh * 0.35]);
        sk(g, { kind: "capsule", a: b0, b: tip, ra: eh * 0.42, rb: eh * 0.3 });
        sk(g, { kind: "capsule", a: add(b0, [0, eh * 0.4, eh * 0.22]), b: add(tip, [0, -eh * 0.35, eh * 0.2]), ra: eh * 0.22, rb: eh * 0.15 }, ROLE.sky);
      } else if (an === "pig") {
        sk(g, { kind: "capsule", a: b0, b: add(b0, [sx * eh * 0.7, eh * 0.55, eh * 0.55]), ra: eh * 0.45, rb: eh * 0.08 });
      }
    }
    // museau (et truffe), bec ou gros yeux
    const SN: Record<string, [number, number, number]> = { cat: [0.2, 0.12, 0.14], fox: [0.16, 0.12, 0.34], dog: [0.24, 0.16, 0.28], bear: [0.24, 0.16, 0.22], rabbit: [0.18, 0.12, 0.12], mouse: [0.14, 0.11, 0.3], pig: [0.2, 0.15, 0.17], dino: [0.36, 0.22, 0.42] };
    const ms = hit(base, 0, mix(noseTipY, mouthY, 0.4));
    const sn = SN[an];
    if (sn) {
      const c = add(ms.p, [0, 0, hd * sn[2] * 0.5]);
      const si = sk("snout", { kind: "ellipsoid", c, r: [hw * sn[0], hh * sn[1], hd * sn[2]] }, MZ);
      set.extraBlends.push({ a: si, b: faceIdx, k: hw * 0.08 });
      if (an === "pig") sk("snout", { kind: "ellipsoid", c: add(c, [0, 0, hd * sn[2] * 0.95]), r: [hw * 0.12, hh * 0.085, hd * 0.05] }, ROLE.sky);
      else if (an !== "dino") sk("snout", { kind: "ellipsoid", c: add(c, [0, hh * sn[1] * 0.55, hd * sn[2] * 0.82]), r: [hw * 0.075, hh * 0.05, hd * 0.055] }, ROLE.black);
    } else if (an === "owl") {
      sk("snout", { kind: "capsule", a: add(ms.p, [0, hh * 0.05, 0]), b: add(ms.p, [0, -hh * 0.08, hd * 0.14]), ra: hw * 0.075, rb: hw * 0.012 }, ROLE.orange);
      for (const sx of [1, -1]) sk("snout", { kind: "ellipsoid", c: add(hit(base, sx * eyeX, eyeY).p, [0, 0, -hd * 0.06]), r: [eyeR * 1.7, eyeR * 1.7, hd * 0.08] }, ROLE.white);
    } else if (an === "frog") {
      for (const sx of [1, -1]) sk("snout", { kind: "ellipsoid", c: [sx * eyeX * 1.1, eyeY + hh * 0.1, cc[2] + cr[2] * 0.35], r: [eyeR * 1.6, eyeR * 1.5, eyeR * 1.5] });
    }
    if (an === "dino") for (let i = 0; i < 4; i++) {
      const a: V3 = [0, cc[1] + cr[1] * (0.9 - i * 0.35), cc[2] - cr[2] * (0.3 + i * 0.25)];
      sk("snout", { kind: "capsule", a, b: add(a, [0, hh * 0.09, -hh * 0.05]), ra: hh * 0.05, rb: hh * 0.01 }, ROLE.cloth3);
    }
  }
  const skin = new Field(set.prims.slice(), [...set.groupBlends(groupK(hw, nr, er)), ...set.extraBlends]);

  /* ---------- barbe, moustache ---------- */
  const beard = look.beard;
  const mouthHidden = beard === "full" || beard === "long" || look.mustache === "walrus";
  const hairPrim = (g: string, f: PrimIn, role = HR) => set.add({ ...f, role, tag: 0 } as FieldPrim, "head", g);
  const earZ = ears[0][2];
  if (beard !== "none" && !chibi) {
    const bt = { stubble: 0.006, short: 0.02, full: 0.036, long: 0.036, goatee: 0.02, chinstrap: 0.015 }[beard] ?? 0.02;
    const role = beard === "stubble" ? ROLE.bark : HR;
    const bump = beard === "full" || beard === "long" ? { amp: hh * 0.004, freq: 1 / (hw * 0.12), seed: v.range(0, 99) } : undefined;
    if (beard === "goatee") {
      const cs = hit(base, 0, chinPt[1] - hh * 0.02);
      hairPrim("beard", { kind: "ellipsoid", c: madd(cs.p, cs.n, -hh * 0.022), r: [hw * 0.075, hh * 0.065, hd * 0.05] }, role);
      hairPrim("beard", { kind: "ellipsoid", c: madd(add(mouthS.p, [0, -lh - hh * 0.04, 0]), mouthS.n, -hh * 0.012), r: [hw * 0.045, hh * 0.04, hd * 0.045] }, role);
    } else {
      const topN = norm([0, 1, beard === "chinstrap" ? 0.9 : 0.55]);
      const topP: V3 = beard === "chinstrap" ? [0, mouthY - hh * 0.08, mouthS.p[2]] : [0, mouthY + hh * (beard === "stubble" ? 0.03 : -0.005), mouthS.p[2]];
      const clip = [{ n: topN, d: dot(topN, topP), k: hh * 0.01 }, { n: [0, 0, -1] as V3, d: -(earZ + hd * 0.02) }];
      hairPrim("beard", { ...inflate(face, hh * bt, role), c: add((face as { c: V3 }).c, [0, -hh * 0.015, hd * 0.01]), clip, bump } as FieldPrim, role);
      hairPrim("beard", { kind: "ellipsoid", c: chinPt, r: [hw * 0.15 + hh * bt, hh * 0.085 + hh * bt, hd * 0.13 + hh * bt], clip, bump }, role);
      if (beard === "full" || beard === "long") hairPrim("beard", { kind: "ellipsoid", c: add(chinPt, [0, -hh * 0.07, hd * 0.0]), r: [hw * 0.24, hh * 0.11, hd * 0.17], bump }, role);
      if (beard === "long") hairPrim("beard", { kind: "capsule", a: add(chinPt, [0, -hh * 0.08, 0]), b: add(chinPt, [0, -hh * (0.75 + v.range(0, 0.25)), hd * 0.06]), ra: hw * 0.24, rb: hw * 0.07, bump }, role);
    }
  }
  const mus = look.mustache;
  if (mus !== "none" && !chibi) {
    const spec = { thin: [0.012, 1.0, 0.02], pencil: [0.007, 0.9, 0.0], walrus: [0.03, 1.2, 0.07], handlebar: [0.015, 1.05, -0.02] }[mus] ?? [0.012, 1, 0.02];
    const r0 = hh * spec[0], w = mouthW * spec[1];
    const pts: V3[] = [];
    const N = 7;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * 2 - 1;
      const y = mouthY + lh * 1.1 + hh * 0.032 - hh * spec[2] * t * t + (mus === "walrus" ? -hh * 0.01 : 0);
      const s = hit(skin, t * w, y);
      pts.push(madd(s.p, s.n, r0 * 0.55));
    }
    for (let i = 0; i < N; i++) {
      const prof = (t: number) => r0 * (mus === "pencil" ? 1 : 0.55 + 0.45 * Math.cos((t * 2 - 1) * Math.PI * 0.5));
      hairPrim("beard", { kind: "capsule", a: pts[i], b: pts[i + 1], ra: prof(i / N), rb: prof((i + 1) / N) });
    }
    if (mus === "handlebar")
      for (const [i, sx] of [[0, -1], [N, 1]] as const) hairPrim("beard", { kind: "capsule", a: pts[i], b: add(pts[i], [sx * w * 0.35, hh * 0.06, -hd * 0.02]), ra: r0 * 0.5, rb: r0 * 0.25 });
  }
  const faceSurf = new Field(set.prims.slice(), [...set.groupBlends(groupK(hw, nr, er)), ...set.extraBlends]);

  /* ---------- cheveux ---------- */
  const hair = look.hair;
  const yF = eyeY + hh * (chibi ? 0.2 : 0.22);
  const Fz = cc[2] + cr[2];
  const earTop = earY + er * 0.55;
  const front = (a = 0.7, y = yF, z = Fz) => {
    const n = norm([0, -a, 1]);
    return { n, d: dot(n, [0, y, z]) };
  };
  const nape = (b = 0.85, y = earTop - hh * 0.03) => {
    const n = norm([0, -1, b]);
    return { n, d: dot(n, [0, y, cc[2] + cr[2] * 0.15]) };
  };
  const bumpH = (amp: number, f = 0.16) => ({ amp: hw * amp, freq: 1 / (hw * f), seed: v.range(0, 99) });
  const shell = (t: number, clip: FieldPrim["clip"], bump?: FieldPrim["bump"]) => hairPrim("hair", { kind: "ellipsoid", c: add(cc, [0, hh * 0.015, -hd * 0.02]), r: [cr[0] + hw * t, cr[1] + hw * t * 1.15, cr[2] + hw * t], clip, bump });
  let hairT = 0;
  if (hair !== "none") {
    const T = { shaved: 0.012, crop: 0.028, short: 0.06, sidepart: 0.065, bob: 0.06, wavy: 0.06, long: 0.06, ponytail: 0.045, lowtail: 0.045, bun: 0.045, topknot: 0.045, pigtails: 0.05, braids: 0.045, curly: 0.08, afro: 0.06, mohawk: 0.012 }[hair] ?? 0.05;
    hairT = hw * T;
    const curlB = hair === "curly" ? bumpH(0.035, 0.12) : hair === "wavy" ? bumpH(0.018, 0.2) : undefined;
    shell(T, [front(0.7), nape()], curlB);
    const side = v.chance(0.5) ? 1 : -1;
    if (hair === "short" || hair === "curly" || hair === "wavy") hairPrim("hair", { kind: "ellipsoid", c: [hw * v.range(-0.06, 0.06), yF + hh * 0.09, Fz - hd * 0.17], r: [hw * 0.36, hh * 0.09, hd * 0.2], bump: curlB });
    if (hair === "sidepart") {
      hairPrim("hair", { kind: "capsule", a: [-side * hw * 0.28, yF + hh * 0.17, Fz - hd * 0.18], b: [side * hw * 0.3, yF + hh * 0.06, Fz - hd * 0.1], ra: hh * 0.1, rb: hh * 0.075 });
      hairPrim("hair", { kind: "ellipsoid", c: [side * hw * 0.22, yF + hh * 0.03, Fz - hd * 0.16], r: [hw * 0.2, hh * 0.1, hd * 0.2] });
    }
    if (hair === "bob" || hair === "wavy") {
      const low = hair === "bob" ? P.chinY + hh * 0.12 : P.chinY - hh * 0.12;
      // masse tombante : encadre le visage sans l'avaler (coupée devant au niveau des pommettes)
      hairPrim("hair", { kind: "ellipsoid", c: add(cc, [0, -hh * 0.16, -hd * 0.1]), r: [hw * 0.6, hh * (hair === "bob" ? 0.5 : 0.62), hd * 0.55], clip: [front(0.35, yF - hh * 0.05, cc[2] + cr[2] * (hair === "bob" ? 0.55 : 0.4)), { n: [0, -1, 0], d: -low, k: hh * 0.02 }], bump: curlB });
    }
    if (hair === "long") {
      hairPrim("hair", { kind: "ellipsoid", c: add(cc, [0, -hh * 0.16, -hd * 0.12]), r: [hw * 0.57, hh * 0.56, hd * 0.52], clip: [front(0.35, yF - hh * 0.05, cc[2] + cr[2] * 0.35)] });
      hairPrim("hair", { kind: "capsule", a: add(cc, [0, -hh * 0.3, -hd * 0.26]), b: add(k.at("chest", 0.3), [0, 0, -P.headD * 0.62]), ra: hw * 0.4, rb: hw * 0.36, clip: [{ n: [0, 0, 1], d: cc[2] - hd * 0.12 }] });
      for (const sx of [1, -1]) hairPrim("hair", { kind: "capsule", a: add(cc, [sx * hw * 0.42, -hh * 0.2, -hd * 0.02]), b: add(k.at("clavicle." + (sx > 0 ? "l" : "r"), 0.35), [0, hh * 0.05, -hd * 0.08]), ra: hw * 0.12, rb: hw * 0.1 });
    }
    if (hair === "ponytail" || hair === "lowtail") {
      const y0 = hair === "ponytail" ? cc[1] + cr[1] * 0.25 : earY - hh * 0.05;
      const a: V3 = [0, y0, cc[2] - cr[2] - hairT * 0.6];
      hairPrim("hair", { kind: "ellipsoid", c: a, r: [hw * 0.09, hw * 0.09, hw * 0.07] }, ROLE.cloth3);
      hairPrim("hair", { kind: "capsule", a: add(a, [0, -hh * 0.02, -hw * 0.06]), b: add(a, [0, -hh * (hair === "ponytail" ? 0.85 : 0.95), -hw * 0.12]), ra: hw * 0.13, rb: hw * 0.05, bump: bumpH(0.012) });
    }
    if (hair === "bun") hairPrim("hair", { kind: "ellipsoid", c: add(cc, [0, cr[1] * 0.55, -cr[2] * 0.85]), r: [hw * 0.21, hw * 0.2, hw * 0.2], bump: bumpH(0.01, 0.08) });
    if (hair === "topknot") {
      hairPrim("hair", { kind: "ellipsoid", c: add(cc, [0, cr[1] + hairT + hw * 0.12, -cr[2] * 0.15]), r: [hw * 0.18, hw * 0.16, hw * 0.18], bump: bumpH(0.01, 0.08) });
      hairPrim("hair", { kind: "ellipsoid", c: add(cc, [0, cr[1] + hairT - hw * 0.0, -cr[2] * 0.15]), r: [hw * 0.09, hw * 0.05, hw * 0.09] }, ROLE.cloth3);
    }
    if (hair === "pigtails" || hair === "braids") {
      for (const sx of [1, -1]) {
        const a: V3 = add(cc, [sx * (cr[0] + hairT * 0.4), hair === "pigtails" ? cr[1] * 0.1 : -cr[1] * 0.25, -cr[2] * 0.35]);
        hairPrim("hair", { kind: "ellipsoid", c: a, r: [hw * 0.08, hw * 0.08, hw * 0.08] }, ROLE.cloth3);
        if (hair === "pigtails") hairPrim("hair", { kind: "capsule", a: add(a, [sx * hw * 0.06, -hw * 0.04, -hw * 0.02]), b: add(a, [sx * hw * 0.24, -hh * 0.55, -hw * 0.05]), ra: hw * 0.13, rb: hw * 0.05, bump: bumpH(0.015) });
        else {
          // tresse : chapelet d'ellipsoïdes décalés vers l'avant de l'épaule
          const end: V3 = add(k.at(`clavicle.${sx > 0 ? "l" : "r"}`, 0.45), [0, -hh * 0.55, hd * 0.42]);
          const n = 9;
          const start = add(a, [0, -hw * 0.05, 0]);
          const seg = len3(sub3(end, start)) / n;
          for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n;
            const c = add(mix3(start, end, t), [sx * hw * 0.03 * (i % 2 ? 1 : -1), 0, 0]);
            hairPrim("braid", { kind: "ellipsoid", c, r: [hw * 0.085 * (1 - t * 0.3), seg * 0.8, hw * 0.075 * (1 - t * 0.3)] });
          }
          hairPrim("hair", { kind: "ellipsoid", c: add(end, [0, -hh * 0.02, 0]), r: [hw * 0.05, hw * 0.05, hw * 0.05] }, ROLE.cloth3);
        }
      }
    }
    if (hair === "curly") hairPrim("hair", { kind: "ellipsoid", c: add(cc, [0, hh * 0.06, -hd * 0.06]), r: [cr[0] * 1.16, cr[1] * 1.04, cr[2] * 1.12], clip: [front(0.55, yF + hh * 0.02), nape(0.7)], bump: bumpH(0.045, 0.11) });
    if (hair === "afro") {
      const ar = hw * 0.78;
      hairPrim("hair", { kind: "ellipsoid", c: add(cc, [0, hh * 0.1, -hd * 0.08]), r: [ar, ar * 0.92, ar * 0.9], clip: [front(0.45, yF + hh * 0.02, Fz - hd * 0.04), nape(0.4, earY - hh * 0.04)], bump: bumpH(0.03, 0.12) });
      hairT = ar - cr[1] + hh * 0.1;
    }
    if (hair === "mohawk") hairPrim("hair", { kind: "box", c: add(cc, [0, cr[1] * 0.9, -hd * 0.08]), h: [hw * 0.07, hh * 0.18, hd * 0.46], round: hw * 0.05 });
  }

  /* ---------- couvre-chefs ---------- */
  const A = ROLE.accent, INK = ROLE.ink, MT = ROLE.metal, STRAW = ROLE.leaf2;
  const hat = look.hat;
  const seatY = yF + hh * 0.08;
  const topY0 = cc[1] + cr[1] + Math.min(hairT, hw * 0.08);
  const hatP = (f: PrimIn, role: number, g = "hat") => set.add({ ...f, role, tag: 0 } as FieldPrim, "head", g);
  const crown = (scale: number, y: number, role: number, bump?: FieldPrim["bump"]) => hatP({ kind: "ellipsoid", c: add(cc, [0, hh * 0.02, -hd * 0.02]), r: [cr[0] * scale + Math.min(hairT, hw * 0.08), cr[1] * scale + Math.min(hairT, hw * 0.08), cr[2] * scale + Math.min(hairT, hw * 0.08)], clip: [{ n: [0, -1, 0], d: -y }], bump }, role);
  let topY = topY0 + hh * 0.02;
  const ringR = (y: number, extra: number): [number, number] => {
    const t = Math.max(0, 1 - ((y - cc[1]) / cr[1]) ** 2);
    return [cr[0] * Math.sqrt(t) + extra + Math.min(hairT, hw * 0.08), cr[2] * Math.sqrt(t) + extra + Math.min(hairT, hw * 0.08)];
  };
  switch (hat) {
    case "cap": {
      crown(1.08, seatY, A);
      hatP({ kind: "ellipsoid", c: [0, seatY + hh * 0.025, cc[2] + cr[2] * 0.95], r: [hw * 0.4, hh * 0.022, hd * 0.34], clip: [{ n: [0, 0, -1], d: -(cc[2] + cr[2] * 0.45) }] }, A);
      hatP({ kind: "sphere", c: [0, topY0 + hh * 0.06, cc[2]], r: hw * 0.05 }, A);
      topY = topY0 + hh * 0.08;
      break;
    }
    case "beret":
      hatP({ kind: "ellipsoid", c: [hw * 0.1, topY0 - hh * 0.05, cc[2] - hd * 0.04], r: [hw * 0.64, hh * 0.13, hd * 0.6] }, A);
      hatP({ kind: "capsule", a: [hw * 0.1, topY0 + hh * 0.06, cc[2] - hd * 0.04], b: [hw * 0.11, topY0 + hh * 0.12, cc[2] - hd * 0.05], ra: hw * 0.025, rb: hw * 0.015 }, A);
      topY = topY0 + hh * 0.1;
      break;
    case "tophat": {
      const [rx] = ringR(seatY, 0);
      hatP({ kind: "ellipsoid", c: [0, seatY + hh * 0.03, cc[2]], r: [hw * 0.8, hh * 0.028, hd * 0.78] }, INK);
      hatP({ kind: "cone", a: [0, seatY + hh * 0.02, cc[2]], b: [0, seatY + hh * 0.8, cc[2]], ra: rx * 1.04, rb: rx * 1.12, round: hw * 0.03 }, INK);
      hatP({ kind: "cone", a: [0, seatY + hh * 0.05, cc[2]], b: [0, seatY + hh * 0.16, cc[2]], ra: rx * 1.07, rb: rx * 1.08, round: hw * 0.01 }, A, "band");
      topY = seatY + hh * 0.8;
      break;
    }
    case "wizard": {
      const [rx] = ringR(seatY, 0);
      hatP({ kind: "ellipsoid", c: [0, seatY + hh * 0.02, cc[2]], r: [hw * 0.98, hh * 0.032, hd * 0.98] }, A);
      const mid: V3 = [-hw * 0.04, seatY + hh * 0.75, cc[2] - hd * 0.05];
      hatP({ kind: "cone", a: [0, seatY + hh * 0.02, cc[2]], b: mid, ra: rx * 1.1, rb: hw * 0.2, round: hw * 0.02 }, A);
      hatP({ kind: "capsule", a: mid, b: add(mid, [-hw * 0.32, hh * 0.45, -hd * 0.25]), ra: hw * 0.2, rb: hw * 0.025 }, A);
      hatP({ kind: "cone", a: [0, seatY + hh * 0.04, cc[2]], b: [0, seatY + hh * 0.14, cc[2]], ra: rx * 1.14, rb: rx * 1.08, round: hw * 0.01 }, ROLE.cloth3, "band");
      topY = seatY + hh * 1.2;
      break;
    }
    case "straw": {
      const [rx] = ringR(seatY, 0);
      hatP({ kind: "ellipsoid", c: [0, seatY + hh * 0.02, cc[2]], r: [hw * 1.15, hh * 0.032, hd * 1.15], bump: { amp: hh * 0.006, freq: 1 / (hw * 0.12), seed: v.range(0, 99) } }, STRAW);
      hatP({ kind: "ellipsoid", c: [0, seatY + hh * 0.16, cc[2]], r: [rx * 1.06, hh * 0.24, rx * 1.06 * (cr[2] / cr[0])], clip: [{ n: [0, -1, 0], d: -seatY }] }, STRAW);
      hatP({ kind: "cone", a: [0, seatY + hh * 0.03, cc[2]], b: [0, seatY + hh * 0.1, cc[2]], ra: rx * 1.1, rb: rx * 1.07, round: hw * 0.01 }, A, "band");
      topY = seatY + hh * 0.4;
      break;
    }
    case "helmet": {
      crown(1.13, eyeY + hh * 0.13, MT);
      const [rx, rz] = ringR(eyeY + hh * 0.14, hw * 0.07);
      hatP({ kind: "ellipsoid", c: [0, eyeY + hh * 0.15, cc[2]], r: [rx * 1.04, hh * 0.035, rz * 1.04] }, MT, "rim");
      hatP({ kind: "capsule", a: [0, eyeY + hh * 0.16, cc[2] + rz * 1.02], b: [0, noseTipY + hh * 0.02, Fz + hd * 0.17], ra: hw * 0.035, rb: hw * 0.03 }, MT, "rim");
      hatP({ kind: "capsule", a: [0, topY0 + hh * 0.02, cc[2] + cr[2] * 0.6], b: [0, topY0 + hh * 0.04, cc[2] - cr[2] * 0.7], ra: hw * 0.03, rb: hw * 0.03 }, MT, "rim");
      topY = topY0 + hh * 0.1;
      break;
    }
    case "crown": {
      const [rx, rz] = ringR(seatY + hh * 0.05, hw * 0.03);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const b: V3 = [Math.cos(a) * rx, seatY + hh * 0.08, cc[2] + Math.sin(a) * rz];
        hatP({ kind: "capsule", a: b, b: add(b, [Math.cos(a) * hw * 0.03, hh * 0.18, Math.sin(a) * hd * 0.03]), ra: hw * 0.06, rb: hw * 0.02 }, MT);
      }
      hatP({ kind: "cone", a: [0, seatY + hh * 0.02, cc[2]], b: [0, seatY + hh * 0.12, cc[2]], ra: rx, rb: rx * 1.04, round: hw * 0.015 }, MT);
      topY = seatY + hh * 0.32;
      break;
    }
    case "beanie": {
      // bord du bonnet : bas sur la nuque et les oreilles, au-dessus des sourcils devant
      const yb = earTop + hh * 0.02;
      const edge = nape(0.55, yb);
      const ext = Math.min(hairT, hw * 0.08) + hw * 0.07;
      hatP({ kind: "ellipsoid", c: add(cc, [0, hh * 0.04, -hd * 0.02]), r: [cr[0] + ext, cr[1] + ext * 1.25, cr[2] + ext], clip: [edge], bump: { amp: hh * 0.004, freq: 1 / (hw * 0.06), seed: 3 } }, A);
      hatP({ kind: "ellipsoid", c: add(cc, [0, hh * 0.02, -hd * 0.02]), r: [cr[0] + ext * 1.35, cr[1] + ext * 1.2, cr[2] + ext * 1.35], clip: [edge, { n: scale3(edge.n, -1), d: -edge.d + hh * 0.075 }] }, A, "band");
      if (v.chance(0.5)) hatP({ kind: "sphere", c: [0, topY0 + hh * 0.1, cc[2] - hd * 0.03], r: hw * 0.12, bump: { amp: hw * 0.012, freq: 1 / (hw * 0.04), seed: 5 } }, ROLE.cloth3);
      topY = topY0 + hh * 0.18;
      break;
    }
    case "bandana": {
      hatP({ kind: "ellipsoid", c: add(cc, [0, hh * 0.02, -hd * 0.02]), r: [cr[0] + hairT * 0.5 + hw * 0.025, cr[1] + hairT * 0.5 + hw * 0.025, cr[2] + hairT * 0.5 + hw * 0.025], clip: [front(0.5, yF + hh * 0.06, Fz + hw * 0.03), nape(0.6, earTop + hh * 0.02)] }, A);
      const knot: V3 = [0, earTop + hh * 0.04, cc[2] - cr[2] - hairT * 0.5];
      hatP({ kind: "ellipsoid", c: knot, r: [hw * 0.08, hw * 0.07, hw * 0.06] }, A);
      for (const sx of [1, -1]) hatP({ kind: "capsule", a: knot, b: add(knot, [sx * hw * 0.1, -hh * 0.2, -hw * 0.05]), ra: hw * 0.06, rb: hw * 0.025 }, A);
      topY = topY0 + hh * 0.04;
      break;
    }
    case "turban": {
      for (let i = 0; i < 3; i++) {
        const [rx, rz] = ringR(seatY + hh * 0.08 * i, hw * (0.1 - i * 0.012));
        hatP({ kind: "ellipsoid", c: [hw * 0.02 * (i % 2 ? 1 : -1), seatY + hh * (0.06 + 0.11 * i), cc[2] - hd * 0.02], r: [rx, hh * 0.1, rz], bump: { amp: hh * 0.006, freq: 1 / (hw * 0.1), seed: i } }, A);
      }
      hatP({ kind: "ellipsoid", c: [0, seatY + hh * 0.3, cc[2] - hd * 0.03], r: [cr[0] * 0.95, hh * 0.18, cr[2] * 0.95] }, A);
      hatP({ kind: "sphere", c: [0, seatY + hh * 0.15, Fz + hw * 0.05], r: hw * 0.06 }, ROLE.cloth3, "jewel");
      topY = seatY + hh * 0.5;
      break;
    }
    case "cowboy": {
      const LE = ROLE.leather;
      hatP({ kind: "ellipsoid", c: [0, seatY + hh * 0.02, cc[2]], r: [hw * 1.12, hh * 0.026, hd * 0.98] }, LE);
      for (const sx of [1, -1]) hatP({ kind: "ellipsoid", c: [sx * hw * 0.92, seatY + hh * 0.08, cc[2]], r: [hw * 0.22, hh * 0.07, hd * 0.75] }, LE);
      const [rx, rz] = ringR(seatY, 0);
      hatP({ kind: "box", c: [0, seatY + hh * 0.22, cc[2]], h: [rx * 1.02, hh * 0.21, rz * 1.02], round: hw * 0.16 }, LE);
      hatP({ kind: "cone", a: [0, seatY + hh * 0.03, cc[2]], b: [0, seatY + hh * 0.1, cc[2]], ra: rx * 1.06, rb: rx * 1.04, round: hw * 0.01 }, A, "band");
      topY = seatY + hh * 0.45;
      break;
    }
    case "flowers": {
      const y = seatY + hh * 0.03;
      const [rx, rz] = ringR(y, hw * 0.03);
      const n = 11;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.2;
        const c: V3 = [Math.cos(a) * rx, y + hh * 0.02 * Math.sin(i * 2.3), cc[2] + Math.sin(a) * rz];
        if (i % 3 === 2) hatP({ kind: "ellipsoid", c, r: [hw * 0.07, hw * 0.03, hw * 0.05] }, ROLE.leaf, "leaves");
        else {
          hatP({ kind: "ellipsoid", c, r: [hw * 0.065, hw * 0.045, hw * 0.065], bump: { amp: hw * 0.012, freq: 1 / (hw * 0.025), seed: i } }, ROLE.flower, `fl${i}`);
          hatP({ kind: "sphere", c: add(c, [Math.cos(a) * hw * 0.04, hw * 0.02, Math.sin(a) * hw * 0.04]), r: hw * 0.022 }, ROLE.lamp, `fc${i}`);
        }
      }
      topY = topY0 + hh * 0.04;
      break;
    }
    case "tricorn": {
      crown(1.09, seatY, INK);
      const y = seatY + hh * 0.1;
      const pts: V3[] = [0, 1, 2].map((i) => {
        const a = Math.PI / 2 + (i * Math.PI * 2) / 3;
        return [Math.cos(a) * hw * 0.78, y + hh * 0.04, cc[2] + Math.sin(a) * hd * 0.82] as V3;
      });
      for (let i = 0; i < 3; i++) hatP({ kind: "capsule", a: pts[i], b: pts[(i + 1) % 3], ra: hh * 0.06, rb: hh * 0.06 }, INK, "brim");
      hatP({ kind: "ellipsoid", c: [0, seatY + hh * 0.03, cc[2]], r: [hw * 0.62, hh * 0.03, hd * 0.62] }, INK, "brim");
      topY = topY0 + hh * 0.06;
      break;
    }
    case "toque": {
      const [rx, rz] = ringR(seatY, hw * 0.02);
      hatP({ kind: "cone", a: [0, seatY - hh * 0.01, cc[2]], b: [0, seatY + hh * 0.26, cc[2]], ra: rx, rb: rx * 1.04, round: hw * 0.02 }, ROLE.paper);
      hatP({ kind: "ellipsoid", c: [0, seatY + hh * 0.5, cc[2] - hd * 0.02], r: [rx * 1.35, hh * 0.32, rz * 1.35], bump: { amp: hw * 0.03, freq: 1 / (hw * 0.18), seed: 2 } }, ROLE.paper);
      topY = seatY + hh * 0.8;
      break;
    }
    case "hood": {
      const ext = Math.max(hairT, hw * 0.04) + hw * 0.08;
      const opening = (() => {
        const n = norm([0, -0.25, 1]);
        return { n, d: dot(n, [0, eyeY, cc[2] + cr[2] * 0.6]), k: hw * 0.02 };
      })();
      hatP({ kind: "ellipsoid", c: add(cc, [0, hh * 0.02, -hd * 0.06]), r: [cr[0] + ext, cr[1] + ext * 1.2, cr[2] + ext * 1.05], clip: [opening] }, A);
      hatP({ kind: "capsule", a: add(cc, [0, -hh * 0.1, -cr[2] * 0.6]), b: add(k.at("chest", 0.55), [0, 0, -P.headD * 0.55]), ra: hw * 0.42, rb: hw * 0.28, clip: [opening] }, A);
      const nb = k.at("neck", 0.1);
      hatP({ kind: "ellipsoid", c: add(nb, [0, H * 0.005, -H * 0.006]), r: [P.shoulderHalf * 0.72, H * 0.045, k.rad("neck", 0) * 2.3 + k.thick], clip: [{ n: [0, 1, 0], d: nb[1] + H * 0.035 }] }, A);
      topY = topY0 + ext;
      break;
    }
  }
  const blends = [...set.groupBlends(groupK(hw, nr, er)), ...set.extraBlends];
  return { set, blends, headC, headR, eyeY, eyeX, eyeR, mouthY, mouthW, noseTipY, noseTip, ears, skin, faceSurf, topY, mouthHidden };
}

const groupK = (hw: number, nr: number, er: number) => (g: string) =>
  g === "skull" ? hw * 0.14 : g === "nose" ? nr * 0.5 : g === "snout" ? hw * 0.04 : g.startsWith("ear") ? er * 0.15 : g === "lips" ? hw * 0.02 : g === "beard" ? hw * 0.05 : g === "hair" ? hw * 0.06 : g === "braid" ? hw * 0.02 : g === "hat" ? hw * 0.03 : g === "brim" ? hw * 0.02 : 0;

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

