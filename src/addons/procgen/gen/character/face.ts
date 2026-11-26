/**
 * Gabarits du visage posés sur la peau par lancer de rayon : yeux (formes, iris, pupille, reflet, ligne de cils,
 * paupière), sourcils, bouche, lunettes, rides, taches de rousseur. Tous suivent l'os de la tête ; les yeux portent le
 * morph de clignement.
 */
import { type Q, type V3, DEG, add, cross, m4Compose, madd, mix, norm, qAxis, qFromTo, qMul } from "../../core/math";
import type { Field } from "../../geom/implicit";
import { Mesh } from "../../geom/mesh";
import { ellipsoid, tube } from "../../geom/prims";
import type { Archetype } from "../../rig/humanoid";
import { ROLE } from "../../style/roles";
import type { HeadField } from "./head";
import type { Kit } from "./kit";

/** Canaux d'expression (morphs du visage) : une humeur par canal, puis bouche ouverte et regard. */
export const EXPR_CHANNELS = ["neutral", "happy", "sad", "angry", "surprised", "sleepy", "talk", "gazeX", "gazeY"] as const;
export type ExprChannel = (typeof EXPR_CHANNELS)[number];
/**
 * Morphs d'expression d'une plage contiguë de sommets du visage : `data[(c * count + i) * 3 + k]` = décalage (repère de
 * repos) du sommet `i` pour le canal `c`. Chaque canal est la différence avec le visage de base (humeur du `look`).
 */
export type FaceExpr = { count: number; channels: readonly ExprChannel[]; data: Float32Array };
export type FaceMeshes = { mesh: Mesh; morph: number[]; expr: FaceExpr | null };

/** Pose du visage : humeur, ouverture de bouche ajoutée (0 … 1), regard (-1 … 1 : gauche du personnage, haut). */
type FacePose = { mood: string; open: number; gx: number; gy: number };

/** Bouche par humeur : courbure (sourire > 0), ouverture, largeur relative. */
const MOUTH: Record<string, [number, number, number]> = { neutral: [0.12, 0, 1], happy: [1, 0.1, 1.1], sad: [-0.8, 0, 0.92], angry: [-0.45, 0.06, 0.95], surprised: [0, 0.85, 0.6], sleepy: [0, 0, 0.9] };
/** Paupière supérieure descendue par humeur (0 = rentrée sous l'arcade). */
const LID: Record<string, number> = { sleepy: 0.42, angry: 0.16, sad: 0.12 };
/** Occlusion des pièces de peau du visage (paupières) : celle de la peau de l'orbite, assombrie par le modelage. */
const LID_AO = 0.6;
/** Ouverture de bouche du canal `talk`. */
const TALK_OPEN = 0.55;

export function buildFace(k: Kit, hf: HeadField, crowd = false): FaceMeshes {
  const { look, v } = k;
  const asym = v.range(-0.012, 0.012) * k.P.headH;
  const base = buildDynamic(k, hf, crowd, asym, { mood: look.mood, open: 0, gx: 0, gy: 0 });
  const face = base.mesh;
  const morph = base.morph;
  const count = face.vertexCount;
  // morphs : même topologie pour toutes les poses (vérifiée), différence avec la base
  let expr: FaceExpr | null = null;
  const poses: FacePose[] = EXPR_CHANNELS.map((c) =>
    c === "talk" ? { mood: look.mood, open: TALK_OPEN, gx: 0, gy: 0 } : c === "gazeX" ? { mood: look.mood, open: 0, gx: 1, gy: 0 } : c === "gazeY" ? { mood: look.mood, open: 0, gx: 0, gy: 1 } : { mood: c, open: 0, gx: 0, gy: 0 },
  );
  const data = new Float32Array(EXPR_CHANNELS.length * count * 3);
  let ok = true;
  poses.forEach((p, c) => {
    if (!ok || (p.mood === look.mood && !p.open && !p.gx && !p.gy)) return;
    const m = buildDynamic(k, hf, crowd, asym, p).mesh;
    if (m.vertexCount !== count) return void (ok = false);
    const o = c * count * 3;
    for (let i = 0; i < count * 3; i++) data[o + i] = m.pos[i] - face.pos[i];
  });
  if (ok) expr = { count, channels: EXPR_CHANNELS, data };
  const { P } = k;
  const hh = P.headH, hw = P.headW;
  const { eyeR, eyeX, eyeY } = hf;
  const arch = look.archetype as Archetype;
  const toon = arch === "chibi" || arch === "cartoon";
  const sg = (n: number) => Math.max(5, Math.round(n * (crowd ? 0.62 : 1)));
  const eyeCenters = base.eyeCenters;
  const hit = (f: Field, x: number, y: number) => faceHit(k, hf, f, x, y);
  const onSkin = (x: number, y: number, lift: number) => {
    const s = hit(hf.skin, x, y);
    return madd(s.p, s.n, lift);
  };
  const add_ = (m: Mesh) => {
    face.append(m);
    while (morph.length < face.vertexCount * 3) morph.push(0);
  };

  /* ---------- lunettes ---------- */
  if (look.glasses !== "none") {
    const role = look.glasses === "square" ? ROLE.ink : ROLE.metal;
    const rr = hh * (look.glasses === "square" ? 0.011 : 0.0075);
    const lens = eyeR * (look.glasses === "half" ? 1.25 : 1.4);
    const rings: V3[][] = [];
    for (let e = 0; e < 2; e++) {
      const sx = e === 0 ? 1 : -1;
      const c = add(eyeCenters[e], [0, look.glasses === "half" ? -eyeR * 0.35 : 0, eyeR * 1.15]);
      const pts: V3[] = [];
      const N = 20;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        let x = Math.cos(a), y = Math.sin(a) * 0.82;
        if (look.glasses === "square") {
          const p = 4;
          const ca = Math.cos(a), sa = Math.sin(a);
          const r = 1 / Math.pow(Math.abs(ca) ** p + Math.abs(sa) ** p, 1 / p);
          (x = ca * r * 1.02), (y = sa * r * 0.72);
        }
        if (look.glasses === "half") y = Math.min(y, 0.1) * 1.1;
        pts.push(add(c, [x * lens * sx, y * lens, -Math.abs(x) * eyeR * 0.15]));
      }
      rings.push(pts);
      face.append(tube(pts, pts.map(() => rr), role, crowd ? 4 : 5, false, false));
      // branche jusqu'à l'oreille
      const ear = hf.ears[e];
      const p0 = add(c, [sx * lens * 1.0, look.glasses === "half" ? 0 : lens * 0.05, -eyeR * 0.15]);
      face.append(tube([p0, add(p0, [sx * eyeR * 0.3, 0, -eyeR * 0.6]), add(ear, [sx * hw * 0.03, P.headH * 0.06, P.headD * 0.04])], [rr, rr, rr * 0.9], role, crowd ? 4 : 4, true, true));
    }
    // pont
    const a = add(rings[0][10], [0, 0, 0]), b = add(rings[1][10], [0, 0, 0]);
    const mid = add(mix3(a, b, 0.5), [0, eyeR * 0.15, eyeR * 0.1]);
    face.append(tube([a, mid, b], [rr, rr, rr], role, crowd ? 4 : 4, true, true));
    while (morph.length < face.vertexCount * 3) morph.push(0);
  }

  /* ---------- rides ---------- */
  const wr = look.wrinkles;
  if (wr !== "none" && arch !== "chibi") {
    const deep = wr === "strong";
    const r = hh * (deep ? 0.0065 : 0.005) * (toon ? 1.3 : 1);
    const line = (pts2: [number, number][], rad = r) => {
      const pts = pts2.map(([x, y]) => onSkin(x, y, -rad * 0.25));
      const radii = pts.map((_, i) => rad * (0.35 + 0.65 * Math.sin(((i + 0.5) / pts.length) * Math.PI)));
      add_(tube(pts, radii, ROLE.bark, crowd ? 4 : 4, true, true));
    };
    // front
    for (let j = 0; j < (deep ? 3 : 2); j++) {
      const y = eyeY + eyeR * 2.25 + hh * (0.045 + j * 0.035);
      line(Array.from({ length: 7 }, (_, i) => [mix(-hw * 0.22, hw * 0.22, i / 6) * (1 - j * 0.1), y + Math.sin((i / 6) * Math.PI) * hh * 0.01] as [number, number]));
    }
    for (const sx of [1, -1]) {
      // pattes d'oie
      for (let j = 0; j < (deep ? 3 : 2); j++) {
        const a = (j - 1) * 0.35;
        const x0 = sx * (eyeX + eyeR * 1.25), y0 = eyeY;
        line([0, 1, 2, 3].map((i) => [x0 + sx * Math.cos(a) * eyeR * 0.22 * i, y0 + Math.sin(a) * eyeR * 0.22 * i] as [number, number]), r * 0.8);
      }
      // sillon nasogénien
      const nx = hf.noseTip[0] + sx * hw * 0.09, ny = hf.noseTipY - hh * 0.01;
      line([0, 1, 2, 3, 4].map((i) => [nx + sx * hw * (0.012 * i + 0.002 * i * i), ny - (hf.noseTipY - hf.mouthY + hh * 0.02) * (i / 4)] as [number, number]), r * 1.1);
      // cerne
      if (deep) line([0, 1, 2, 3, 4].map((i) => [sx * (eyeX + eyeR * mix(-0.7, 0.7, i / 4)), eyeY - eyeR * 1.05 - Math.sin((i / 4) * Math.PI) * eyeR * 0.2] as [number, number]), r * 0.8);
    }
  }

  /* ---------- taches de rousseur ---------- */
  if (look.freckles !== "none") {
    const n = look.freckles === "strong" ? 34 : 16;
    const fr = v.fork("freckles");
    for (let i = 0; i < n; i++) {
      const sx = i % 2 ? 1 : -1;
      const nose = fr.chance(0.22);
      const x = nose ? fr.range(-0.06, 0.06) * hw : sx * (eyeX + fr.range(-0.6, 0.9) * eyeR);
      const y = nose ? eyeY - fr.range(0.6, 1.4) * eyeR : eyeY - eyeR * fr.range(1.2, 2.6);
      const s = hit(hf.skin, x, y);
      const r = hh * fr.range(0.004, 0.008);
      add_(ellipsoid(r, r, r * 0.25, ROLE.bark, sg(6), sg(3)).transform(m4Compose(s.p, qFromTo([0, 0, 1], s.n))));
    }
  }
  while (morph.length < face.vertexCount * 3) morph.push(0);
  morph.length = face.vertexCount * 3;
  return { mesh: face, morph, expr };
}

/** Point de la peau visé de face (lancer de rayon) et sa normale. */
function faceHit(k: Kit, hf: HeadField, f: Field, x: number, y: number): { p: V3; n: V3 } {
  const { P } = k;
  const p = f.raycast([x, y, hf.headC[2] + P.headD * 1.6], [0, 0, -1], P.headD * 2.4, P.headH * 0.0005) ?? [x, y, hf.headC[2] + P.headD * 0.45];
  return { p, n: f.gradient(p, P.headH * 0.004) };
}

/**
 * Parties mobiles du visage pour une pose : yeux (iris et pupille déplacés par le regard), paupière supérieure,
 * ligne de cils, sourcils, bouche (lèvres haute et basse, intérieur, langue). Le nombre de sommets ne dépend jamais
 * de la pose : les pièces absentes d'une humeur sont rentrées sous la peau ou réduites, pas retirées.
 */
function buildDynamic(k: Kit, hf: HeadField, crowd: boolean, asym: number, pose: FacePose): { mesh: Mesh; morph: number[]; eyeCenters: V3[] } {
  const q = crowd ? 0.62 : 1;
  const sg = (n: number) => Math.max(5, Math.round(n * q));
  const { look, P } = k;
  const arch = look.archetype as Archetype;
  const toon = arch === "chibi" || arch === "cartoon";
  const face = new Mesh();
  const morph: number[] = [];
  const hh = P.headH;
  const { eyeR, eyeX, eyeY } = hf;
  const add_ = (m: Mesh, blinkY: number | null) => {
    const base = face.vertexCount;
    face.append(m);
    for (let i = base; i < face.vertexCount; i++) morph.push(0, blinkY === null ? 0 : (blinkY - face.pos[i * 3 + 1]) * 0.92, 0);
  };
  const hit = (f: Field, x: number, y: number) => faceHit(k, hf, f, x, y);
  const onSkin = (x: number, y: number, lift: number) => {
    const s = hit(hf.skin, x, y);
    return madd(s.p, s.n, lift);
  };
  const mood = pose.mood;
  const sleepyMood = mood === "sleepy";
  const shape = look.eyes;
  // dimensions de l'œil : largeur, hauteur, inclinaison (coin externe relevé)
  const dims = ({ round: [1, 0.86, 0], almond: [1.12, 0.6, 9], narrow: [1.06, 0.42, 4], sleepy: [1.02, 0.78, -3], big: [1.28, 1.18, 0] } as Record<string, number[]>)[shape] ?? [1, 0.8, 0];
  const wide = mood === "surprised" ? 1.12 : 1;

  /* ---------- yeux ---------- */
  const eyeCenters: V3[] = [];
  for (const sx of [1, -1]) {
    const s = hit(hf.skin, sx * eyeX, eyeY + asym * sx);
    const look3 = norm([s.n[0] * 0.12 - sx * 0.04, s.n[1] * 0.15, 1]);
    const tilt = dims[2] * DEG * sx;
    const qe: Q = qMul(qFromTo([0, 0, 1], look3), qAxis([0, 0, 1], tilt));
    // réaliste : œil en amande moins ouvert, paupière qui couvre le haut de l'iris, cils fins
    const real = arch === "realistic";
    const ew = eyeR * dims[0], eh = eyeR * dims[1] * (sleepyMood ? 0.6 : wide) * (real ? 0.94 : 1);
    const ctr = madd(s.p, s.n, -eyeR * (toon ? 0.12 : 0.32));
    eyeCenters.push(ctr);
    const T = (m: Mesh, off: V3 = [0, 0, 0]) => m.transform(m4Compose(add(ctr, rot(qe, off)), qe));
    // regard : iris et pupille glissent sur le globe (le reflet reste en place)
    const G = (off: V3, rx: number, ry: number, depth: number): V3 => {
      const dx = pose.gx * rx, dy = pose.gy * ry;
      return [off[0] + dx, off[1] + dy, off[2] - (dx * dx + dy * dy) / (2 * depth)];
    };
    if (toon) {
      // œil « cartoon » : iris coloré plein, pupille, reflet, ligne de cils
      add_(T(ellipsoid(ew * 0.74, eh, eyeR * 0.3, ROLE.eye, sg(16), sg(9))), ctr[1]);
      add_(T(ellipsoid(ew * 0.38, eh * 0.52, eyeR * 0.2, ROLE.ink, sg(12), sg(6)), G([0, -eh * 0.08, eyeR * 0.14], ew * 0.3, eh * 0.38, eyeR * 2)), ctr[1]);
      add_(T(ellipsoid(eyeR * 0.2, eyeR * 0.2, eyeR * 0.12, ROLE.eyeWhite, sg(8), sg(5)), [ew * 0.25, eh * 0.38, eyeR * 0.24]), ctr[1]);
    } else {
      add_(T(ellipsoid(ew, eh, eyeR * 0.42, ROLE.eyeWhite, sg(16), sg(9))), ctr[1]);
      const ri = Math.min(ew * 0.6, eh * 0.9);
      const gx = (ew - ri) * 0.62, gy = Math.max(0, eh - ri) * 0.6 + eh * 0.12;
      add_(T(ellipsoid(ri, ri, eyeR * 0.3, ROLE.eye, sg(14), sg(7)), G([0, -eh * 0.04, eyeR * 0.2], gx, gy, eyeR * 0.9)), ctr[1]);
      add_(T(ellipsoid(ri * 0.45, ri * 0.45, eyeR * 0.22, ROLE.ink, sg(10), sg(5)), G([0, -eh * 0.04, eyeR * 0.31], gx, gy, eyeR * 0.9)), ctr[1]);
      add_(T(ellipsoid(eyeR * 0.13, eyeR * 0.13, eyeR * 0.08, ROLE.eyeWhite, sg(6), sg(4)), [ri * 0.38, ri * 0.4 - eh * 0.04, eyeR * 0.4]), ctr[1]);
    }
    // paupière supérieure (coque de peau) : descendue (yeux mi-clos) ou rentrée sous l'arcade, toujours présente
    const lidDrop = shape === "sleepy" || sleepyMood ? 0.42 : Math.max(LID[mood] ?? 0, real ? 0.1 : 0);
    const lid = ellipsoid(ew * 1.08, eh * 0.75, eyeR * 0.5, ROLE.skin, sg(14), sg(8));
    // peau du visage (tête) : son occlusion est assombrie autour de l'œil ; la paupière prend la même valeur
    lid.ao = lid.ao.map((a) => a * LID_AO);
    if (lidDrop > 0) add_(T(lid, [0, eh * (1.1 - lidDrop * 1.4), eyeR * 0.05]), ctr[1]);
    else {
      // rentrée : aplatie et enfoncée derrière l'arcade (rien ne dépasse de la peau)
      lid.transform(m4Compose([0, 0, 0], [0, 0, 0, 1], [0.85, 0.6, 0.4]));
      add_(T(lid, [0, eh * 0.95, -eyeR * (toon ? 0.62 : 0.5)]), ctr[1]);
    }
    // ligne de cils : arc le long du bord supérieur, plus épais vers l'extérieur
    if (!(arch === "chibi" && shape === "round")) {
      const pts: V3[] = [], rr: number[] = [];
      const top = lidDrop > 0 ? eh * (1.1 - lidDrop * 1.4 - 0.62) : eh * 0.92;
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const a = Math.PI * (1 - t);
        const x = Math.cos(a) * ew * 1.02 * sx;
        const y = Math.sin(a) * (lidDrop > 0 ? eh * 0.12 : top) + (lidDrop > 0 ? top : 0) - (1 - Math.sin(a)) * eh * 0.08;
        pts.push(add(ctr, rot(qe, [x, y, eyeR * (toon ? 0.2 : 0.3) * Math.sin(a) + eyeR * 0.08])));
        rr.push(eyeR * (toon ? 0.07 : real ? 0.05 : 0.06) * (0.5 + 0.9 * (sx > 0 ? t : 1 - t) ** 1.2));
      }
      add_(tube(pts, rr, ROLE.ink, crowd ? 4 : 5, true, true), ctr[1]);
    }
    if (!toon && !crowd) {
      // pli de la paupière supérieure (au-dessus de l'œil ouvert) et bord de la paupière inférieure : ce sont eux qui
      // posent le regard d'un visage réaliste ; tracés fins, de teinte peau sombre
      const crease: V3[] = [], cr: number[] = [], lower: V3[] = [], lr: number[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8, a = Math.PI * (1 - t), x = Math.cos(a) * ew * sx;
        crease.push(add(ctr, rot(qe, [x * 1.04, eh * 1.28 + Math.sin(a) * eh * 0.22 - (lidDrop > 0 ? eh * lidDrop * 0.3 : 0), eyeR * 0.22 + Math.sin(a) * eyeR * 0.12])));
        cr.push(eyeR * 0.028 * Math.sin(Math.min(1, t * 1.3) * Math.PI) ** 0.6 + eyeR * 0.004);
        lower.push(add(ctr, rot(qe, [x * 0.98, -eh * 0.98 - Math.sin(a) * eh * 0.12, eyeR * 0.3 + Math.sin(a) * eyeR * 0.08])));
        lr.push(eyeR * 0.035 * Math.sin(t * Math.PI) ** 0.5 + eyeR * 0.004);
      }
      add_(tube(crease, cr, ROLE.mouth, 4, true, true), ctr[1]);
      const lw = tube(lower, lr, ROLE.skin, 4, true, true);
      lw.ao = lw.ao.map((a) => a * LID_AO);
      add_(lw, null);
    }
  }

  /* ---------- sourcils ---------- */
  const brow = look.brows;
  if (brow !== "none") {
    const spec = ({ thin: [0.09, 0.3, 1.0], straight: [0.14, 0.05, 1.0], arched: [0.12, 0.55, 1.05], thick: [0.19, 0.15, 1.05], bushy: [0.24, 0.2, 1.15] } as Record<string, number[]>)[brow] ?? [0.12, 0.2, 1];
    const browIn = ({ angry: -0.55, sad: 0.6, surprised: 0.45, happy: 0.15, neutral: 0, sleepy: -0.1 } as Record<string, number>)[mood] ?? 0;
    const raise = ({ surprised: 0.3, happy: 0.06, sleepy: -0.1, angry: -0.08 } as Record<string, number>)[mood] ?? 0;
    for (const sx of [1, -1]) {
      const pts: V3[] = [], radii: number[] = [];
      const N = 8;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const bx = sx * (eyeX + eyeR * mix(-1.0, 1.1, t) * spec[2]);
        const peak = brow === "arched" ? Math.sin(Math.min(1, t / 0.65) * Math.PI * 0.5) * (t > 0.65 ? 1 - (t - 0.65) * 1.6 : 1) : Math.sin(t * Math.PI);
        const by = eyeY + eyeR * (1.5 * Math.max(0.8, dims[1]) + raise + (1 - t) * browIn * 0.7 + peak * spec[1] * 0.6);
        const r = eyeR * spec[0] * (arch === "realistic" ? 0.9 : 1) * (0.55 + 0.45 * Math.sin(Math.min(1, t * 1.15) * Math.PI) ** 0.5) * (brow === "bushy" ? 0.85 + 0.3 * Math.abs(Math.sin(i * 2.7)) : 1);
        pts.push(onSkin(bx, by, r * 0.35));
        radii.push(r);
      }
      if (sx < 0) pts.reverse(), radii.reverse();
      add_(tube(pts, radii, ROLE.hair, crowd ? 4 : 6, true, true), null);
    }
  }

  /* ---------- bouche ---------- */
  {
    const surf = hf.faceSurf;
    const [curve, open0, wk] = MOUTH[mood] ?? MOUTH.neutral;
    const open = Math.min(1.2, open0 + pose.open);
    // place entre le nez et le menton : sourire et ouverture n'atteignent jamais le nez
    const gap = Math.max(eyeR * 0.3, hf.noseTipY - hf.mouthY);
    const amp = Math.min(eyeR * 0.45, gap * 0.42);
    const oh = Math.min(eyeR * 0.6, gap * 0.75);
    const mw = hf.mouthW * wk * (1 - 0.18 * open);
    // barbe épaisse ou moustache tombante : lèvres fines, la bouche n'apparaît qu'ouverte
    const lipK = hf.mouthHidden ? 0.35 : 1;
    const N = 10;
    const curveY = (t: number) => hf.mouthY + curve * amp * (2 * (t - 0.5)) ** 2 - curve * amp * 0.4;
    const lip = (dir: 1 | -1, rk: number) => {
      const pts: V3[] = [], radii: number[] = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const x = mix(-mw, mw, t);
        const sw = Math.sin(t * Math.PI) ** 0.7;
        const y = curveY(t) + (dir > 0 ? open * oh * 0.32 : -open * oh * 0.68) * sw;
        const s = hit(surf, x, y);
        pts.push(madd(s.p, s.n, eyeR * 0.02));
        radii.push((eyeR * 0.075 * (0.45 + 0.55 * Math.sin(t * Math.PI)) + eyeR * 0.015) * rk * lipK * (arch === "realistic" ? 0.72 : arch === "heroic" ? 0.85 : 1));
      }
      add_(tube(pts, radii, ROLE.mouth, crowd ? 4 : 5, true, true), null);
    };
    lip(1, 1);
    lip(-1, 0.85);
    // intérieur sombre et langue : aplatis derrière les lèvres quand la bouche est fermée
    const cy = curveY(0.5) + open * oh * (0.32 - 0.68) * 0.5;
    const m = hit(surf, 0, cy);
    const qm = qFromTo([0, 0, 1], m.n);
    const ih = eyeR * 0.012 + open * oh * 0.46;
    // bouche fermée : l'intérieur et la langue rentrent entièrement sous la peau (sinon tache sombre sous les lèvres)
    const o1 = Math.min(1, open);
    add_(ellipsoid(mw * 0.82, ih, eyeR * 0.12, ROLE.ink, sg(12), sg(6)).transform(m4Compose(madd(m.p, m.n, -eyeR * (0.16 - 0.11 * o1)), qm)), null);
    add_(ellipsoid(mw * 0.48, eyeR * 0.01 + open * oh * 0.2, eyeR * 0.1, ROLE.mouth, sg(10), sg(5)).transform(m4Compose(madd(add(m.p, [0, -ih * 0.55, 0]), m.n, -eyeR * (0.15 - 0.12 * o1)), qm)), null);
  }
  morph.length = face.vertexCount * 3;
  return { mesh: face, morph, eyeCenters };
}


/** Rotation d'un vecteur par un quaternion. */
function rot(q: Q, v: V3): V3 {
  const u: V3 = [q[0], q[1], q[2]];
  const t = cross(u, v).map((x) => x * 2) as V3;
  return add(add(v, t.map((x) => x * q[3]) as V3), cross(u, t));
}

const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
