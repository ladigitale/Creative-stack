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

export type FaceMeshes = { mesh: Mesh; morph: number[] };

export function buildFace(k: Kit, hf: HeadField, crowd = false): FaceMeshes {
  // finesse des gabarits : la foule se contente de moins de facettes
  const q = crowd ? 0.62 : 1;
  const sg = (n: number) => Math.max(5, Math.round(n * q));
  const { look, P, v } = k;
  const arch = look.archetype as Archetype;
  const toon = arch === "chibi" || arch === "cartoon";
  const face = new Mesh();
  const morph: number[] = [];
  const hh = P.headH, hw = P.headW;
  const { headC, eyeR, eyeX, eyeY } = hf;
  const add_ = (m: Mesh, blinkY: number | null) => {
    const base = face.vertexCount;
    face.append(m);
    for (let i = base; i < face.vertexCount; i++) morph.push(0, blinkY === null ? 0 : (blinkY - face.pos[i * 3 + 1]) * 0.92, 0);
  };
  const hit = (f: Field, x: number, y: number): { p: V3; n: V3 } => {
    const p = f.raycast([x, y, headC[2] + P.headD * 1.6], [0, 0, -1], P.headD * 2.4, hh * 0.0005) ?? [x, y, headC[2] + P.headD * 0.45];
    return { p, n: f.gradient(p, hh * 0.004) };
  };
  const onSkin = (x: number, y: number, lift: number) => {
    const s = hit(hf.skin, x, y);
    return madd(s.p, s.n, lift);
  };
  const mood = look.mood;
  const sleepyMood = mood === "sleepy";
  const shape = look.eyes;
  // dimensions de l'œil : largeur, hauteur, inclinaison (coin externe relevé)
  const dims = ({ round: [1, 0.86, 0], almond: [1.12, 0.6, 9], narrow: [1.06, 0.42, 4], sleepy: [1.02, 0.78, -3], big: [1.28, 1.18, 0] } as Record<string, number[]>)[shape] ?? [1, 0.8, 0];
  const asym = v.range(-0.012, 0.012) * hh;

  /* ---------- yeux ---------- */
  const eyeCenters: V3[] = [];
  for (const sx of [1, -1]) {
    const s = hit(hf.skin, sx * eyeX, eyeY + asym * sx);
    const look3 = norm([s.n[0] * 0.12 - sx * 0.04, s.n[1] * 0.15, 1]);
    const tilt = dims[2] * DEG * sx;
    const q: Q = qMul(qFromTo([0, 0, 1], look3), qAxis([0, 0, 1], tilt));
    const ew = eyeR * dims[0], eh = eyeR * dims[1] * (sleepyMood ? 0.6 : 1);
    const ctr = madd(s.p, s.n, -eyeR * (toon ? 0.12 : 0.32));
    eyeCenters.push(ctr);
    const T = (m: Mesh, off: V3 = [0, 0, 0]) => m.transform(m4Compose(add(ctr, rot(q, off)), q));
    if (toon) {
      // œil « cartoon » : iris coloré plein, pupille, reflet, ligne de cils
      add_(T(ellipsoid(ew * 0.74, eh, eyeR * 0.3, ROLE.eye, sg(16), sg(9))), ctr[1]);
      add_(T(ellipsoid(ew * 0.38, eh * 0.52, eyeR * 0.2, ROLE.ink, sg(12), sg(6)), [0, -eh * 0.08, eyeR * 0.14]), ctr[1]);
      add_(T(ellipsoid(eyeR * 0.2, eyeR * 0.2, eyeR * 0.12, ROLE.eyeWhite, sg(8), sg(5)), [-sx * ew * 0.25, eh * 0.38, eyeR * 0.24]), ctr[1]);
    } else {
      add_(T(ellipsoid(ew, eh, eyeR * 0.42, ROLE.eyeWhite, sg(16), sg(9))), ctr[1]);
      const ri = Math.min(ew * 0.56, eh * 0.9);
      add_(T(ellipsoid(ri, ri, eyeR * 0.3, ROLE.eye, sg(14), sg(7)), [0, -eh * 0.04, eyeR * 0.2]), ctr[1]);
      add_(T(ellipsoid(ri * 0.45, ri * 0.45, eyeR * 0.22, ROLE.ink, sg(10), sg(5)), [0, -eh * 0.04, eyeR * 0.31]), ctr[1]);
      add_(T(ellipsoid(eyeR * 0.13, eyeR * 0.13, eyeR * 0.08, ROLE.eyeWhite, sg(6), sg(4)), [-sx * ri * 0.4, ri * 0.4 - eh * 0.04, eyeR * 0.4]), ctr[1]);
    }
    // paupière supérieure lourde (mi-clos) : coque de peau
    const lidDrop = shape === "sleepy" || sleepyMood ? 0.42 : 0;
    if (lidDrop > 0) add_(T(ellipsoid(ew * 1.08, eh * 0.75, eyeR * 0.5, ROLE.skin, sg(14), sg(8)), [0, eh * (1.1 - lidDrop * 1.4), eyeR * 0.05]), ctr[1]);
    // ligne de cils : arc le long du bord supérieur, plus épais vers l'extérieur
    if (!(arch === "chibi" && shape === "round")) {
      const pts: V3[] = [], rr: number[] = [];
      const top = lidDrop > 0 ? eh * (1.1 - lidDrop * 1.4 - 0.62) : eh * 0.92;
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        const a = Math.PI * (1 - t);
        const x = Math.cos(a) * ew * 1.02 * sx;
        const y = Math.sin(a) * (lidDrop > 0 ? eh * 0.12 : top) + (lidDrop > 0 ? top : 0) - (1 - Math.sin(a)) * eh * 0.08;
        pts.push(add(ctr, rot(q, [x, y, eyeR * (toon ? 0.2 : 0.3) * Math.sin(a) + eyeR * 0.08])));
        rr.push(eyeR * (toon ? 0.07 : 0.06) * (0.5 + 0.9 * (sx > 0 ? t : 1 - t) ** 1.2));
      }
      add_(tube(pts, rr, ROLE.ink, crowd ? 4 : 5, true, true), ctr[1]);
    }
  }

  /* ---------- sourcils ---------- */
  const brow = look.brows;
  if (brow !== "none") {
    const spec = ({ thin: [0.07, 0.3, 1.0], straight: [0.12, 0.05, 1.0], arched: [0.1, 0.55, 1.05], thick: [0.17, 0.15, 1.05], bushy: [0.22, 0.2, 1.15] } as Record<string, number[]>)[brow] ?? [0.12, 0.2, 1];
    const browIn = ({ angry: -0.55, sad: 0.6, surprised: 0.45, happy: 0.15, neutral: 0, sleepy: -0.1 } as Record<string, number>)[mood] ?? 0;
    for (const sx of [1, -1]) {
      const pts: V3[] = [], radii: number[] = [];
      const N = 8;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const bx = sx * (eyeX + eyeR * mix(-1.0, 1.1, t) * spec[2]);
        const peak = brow === "arched" ? Math.sin(Math.min(1, t / 0.65) * Math.PI * 0.5) * (t > 0.65 ? 1 - (t - 0.65) * 1.6 : 1) : Math.sin(t * Math.PI);
        const by = eyeY + eyeR * (1.5 * Math.max(0.8, dims[1]) + (1 - t) * browIn * 0.7 + peak * spec[1] * 0.6);
        const r = eyeR * spec[0] * (0.55 + 0.45 * Math.sin(Math.min(1, t * 1.15) * Math.PI) ** 0.5) * (brow === "bushy" ? 0.85 + 0.3 * Math.abs(Math.sin(i * 2.7)) : 1);
        pts.push(onSkin(bx, by, r * 0.35));
        radii.push(r);
      }
      if (sx < 0) pts.reverse(), radii.reverse();
      add_(tube(pts, radii, ROLE.hair, crowd ? 4 : 6, true, true), null);
    }
  }

  /* ---------- bouche ---------- */
  if (!hf.mouthHidden || mood === "surprised") {
    const surf = hf.faceSurf;
    const mw = hf.mouthW * (mood === "happy" ? 1.12 : 1);
    if (mood === "surprised") {
      const m = hit(surf, 0, hf.mouthY);
      add_(ellipsoid(eyeR * 0.35, eyeR * 0.45, eyeR * 0.15, ROLE.mouth, sg(10), sg(6)).transform(m4Compose(m.p, qFromTo([0, 0, 1], m.n))), null);
    } else {
      const curve = ({ happy: 1, neutral: 0.12, sad: -0.8, angry: -0.45, sleepy: 0 } as Record<string, number>)[mood] ?? 0;
      const pts: V3[] = [], radii: number[] = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const x = mix(-mw, mw, t);
        const y = hf.mouthY + curve * eyeR * 0.45 * (2 * (t - 0.5)) ** 2 - curve * eyeR * 0.18;
        const s = hit(surf, x, y);
        pts.push(madd(s.p, s.n, eyeR * 0.02));
        radii.push(eyeR * 0.075 * (0.45 + 0.55 * Math.sin(t * Math.PI)) + eyeR * 0.015);
      }
      add_(tube(pts, radii, ROLE.mouth, crowd ? 4 : 5, true, true), null);
    }
  }

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
      add_(tube(pts, radii, ROLE.bark, crowd ? 4 : 4, true, true), null);
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
      add_(ellipsoid(r, r, r * 0.25, ROLE.bark, sg(6), sg(3)).transform(m4Compose(s.p, qFromTo([0, 0, 1], s.n))), null);
    }
  }
  while (morph.length < face.vertexCount * 3) morph.push(0);
  morph.length = face.vertexCount * 3;
  return { mesh: face, morph };
}

/** Rotation d'un vecteur par un quaternion. */
function rot(q: Q, v: V3): V3 {
  const u: V3 = [q[0], q[1], q[2]];
  const t = cross(u, v).map((x) => x * 2) as V3;
  return add(add(v, t.map((x) => x * q[3]) as V3), cross(u, t));
}

const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
