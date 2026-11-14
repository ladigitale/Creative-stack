/**
 * Animaux vectoriels animés : le squelette posé par `animalPose` (mêmes allures que la 3D) est projeté.
 * Pattes, cou et queue sont chacun **un seul trait continu à épaisseur variable** suivant la chaîne d'os (aucune
 * jointure possible) ; tronc en masse lisse (enveloppe des sections le long du dos), ventre plus clair ; tête avec
 * museau, naseau, œil à reflet, oreilles. Pattes éloignées plus sombres et derrière.
 *
 * Par espèce : laine bosselée du mouton (face et pattes sombres), crinière et queue de crins du cheval, cornes de la
 * vache et de la chèvre, bois du cerf, groin et queue en tire-bouchon du cochon, longues oreilles du lapin, queue
 * touffue à pointe blanche du renard, oreilles rondes de l'ours, crête et barbillons de la poule, bec plat du canard.
 * Robes : unie, tachetée, à plaques, rayée (`coat`). Couleurs de l'asset (`skin` pelage, `hair` secondaire,
 * `cloth3` motif, `leather` sabots et nez, `cloth1` cornes, `cloth2` crête, `accent` bec).
 */
import { type M4, type V3 } from "../../core/math";
import type { Skeleton } from "../../rig/skeleton";
import type { Projector } from "../project";
import { type P2, Pen, hull, strokeVar } from "../shape";
import { Emitter, Frame } from "./kit";

export type AnimalInput = { sk: Skeleton; W: M4[]; pos: V3; yaw: number; params: Record<string, unknown>; blink: number };

const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function drawAnimal(pr: Projector, em: Emitter, c: AnimalInput) {
  const { sk, W } = c;
  const fr = new Frame(c.pos, c.yaw, 1);
  const has = (n: string) => n in sk.index;
  const head = (n: string): V3 => {
    const i = sk.index[n];
    return fr.w(W[i][12], W[i][13], W[i][14]);
  };
  const tail = (n: string): V3 => {
    const t = sk.tailOf(W, n);
    return fr.w(t[0], t[1], t[2]);
  };
  const R = (n: string, k: 0 | 1) => sk.bones[sk.index[n]].radius[k];
  const S = (v: V3): P2 => pr.pv(v);
  const chain = (names: string[]) => [head(names[0]), ...names.map(tail)];
  const bird = !has("upperarm.l");
  const species = String(c.params.species ?? (bird ? "chicken" : "dog"));
  const coat = String(c.params.coat ?? "solid");
  const stroke = (pts: V3[], hw: number[], fill: string, tone = 0, o: { stroke?: null } = {}) => em.add(strokeVar(new Pen(), pts.map(S), hw), fill, { tone, ...o });
  const woolly = species === "sheep";
  const heavy = species === "cow" || species === "pig" || species === "bear" || woolly;
  const legFill = woolly ? "leather" : "skin";

  const near = pr.depth(head("thigh.l")) >= pr.depth(head("thigh.r")) ? "l" : "r";
  const far = near === "l" ? "r" : "l";
  const leg = (s: string, front: boolean, tone: number) => {
    const names = front ? [`upperarm.${s}`, `forearm.${s}`, `hand.${s}`, `finger.${s}`] : [`thigh.${s}`, `shin.${s}`, `foot.${s}`, `toe.${s}`];
    const ok = names.filter(has);
    if (ok.length < 2) return;
    const pts = chain(ok);
    const k = woolly ? 0.85 : heavy ? 1.25 : 1.1;
    const hw = [R(ok[0], 0) * 1.15 * k, R(ok[0], 1) * k, ...ok.slice(1).map((n) => R(n, 1) * k)];
    stroke(pts, hw, bird ? "accent" : legFill, tone);
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    if (!bird) stroke([lerp3(prev, last, 0.2), last], [R(ok[ok.length - 1], 1) * 1.2, R(ok[ok.length - 1], 1) * 1.25], "leather", tone);
    else {
      // doigts de l'oiseau
      const t = S(last);
      const s2 = R(ok[ok.length - 1], 1) * 4;
      em.line(new Pen().M(t[0], t[1]).L(t[0] + s2, t[1] - s2 * 0.1).M(t[0], t[1]).L(t[0] - s2 * 0.6, t[1] - s2 * 0.1), "accent", 1.2, { tone });
    }
  };
  // tronc : sections le long du dos
  const bodyNames = ["pelvis", "spine", "chest"].filter(has);
  const bpts = chain(bodyNames);
  const brad = [R(bodyNames[0], 0), ...bodyNames.map((n) => R(n, 1))];
  const bodyOutline = (inflate = 1): P2[] => {
    const pts: P2[] = [];
    bpts.forEach((p, i) => {
      const r = brad[i] * inflate * (heavy ? 1.12 : 1.02);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const q = S(p);
        pts.push([q[0] + Math.cos(a) * r, q[1] + Math.sin(a) * r * (i === 0 ? 0.95 : 1)]);
      }
    });
    return hull(pts);
  };

  // pattes éloignées
  if (!bird) leg(far, true, -1);
  leg(far, false, -1);
  // queue (derrière le tronc)
  const tails = ["tail.1", "tail.2", "tail.3"].filter(has);
  if (tails.length) {
    const tp = chain(tails);
    if (species === "horse" || species === "cow") {
      const end = tp[tp.length - 1];
      const drop: V3 = [end[0], Math.max(0.3, end[1] - (species === "horse" ? 0.7 : 0.25)), end[2]];
      stroke([tp[0], ...tp.slice(1), drop], [R(tails[0], 0), ...tails.map(() => R(tails[0], 1) * (species === "horse" ? 1.6 : 0.6)), species === "horse" ? R(tails[0], 0) * 1.1 : R(tails[0], 0) * 1.6], species === "horse" ? "hair" : "skin", 0);
      if (species === "horse") {
        const d = S(drop), e = S(end);
        em.line(new Pen().M(e[0], e[1]).Q(d[0] - 0.05, (e[1] + d[1]) / 2, d[0], d[1]).M(e[0], e[1]).Q(d[0] + 0.05, (e[1] + d[1]) / 2, d[0] + 0.04, d[1]), "hair", 0.6, { tone: -1 });
      }
    } else if (species === "fox" || species === "cat" || species === "dog") {
      const bushy = species === "fox";
      stroke(tp, [R(tails[0], 0) * (bushy ? 1.4 : 1), ...tails.map((n, i) => R(n, 1) * (bushy ? 2.6 - i * 0.3 : 0.9))], "skin", 0);
      if (bushy) stroke([lerp3(tp[tp.length - 2], tp[tp.length - 1], 0.4), tp[tp.length - 1]], [R(tails[0], 0) * 1.6, R(tails[0], 0) * 0.9], "paper", 0, { stroke: null });
    } else if (species === "pig") {
      const t0 = S(tp[0]), r = R(tails[0], 0) * 1.3;
      em.line(new Pen().M(t0[0], t0[1]).Q(t0[0] - r * 2, t0[1] + r * 1.5, t0[0] - r * 1.2, t0[1] + r * 2.4).Q(t0[0] - r * 0.4, t0[1] + r * 1.6, t0[0] - r * 1.5, t0[1] + r * 1.1), "skin", 1.6, { tone: -1 });
    } else if (species === "rabbit" || species === "sheep" || species === "deer" || species === "goat") {
      const q = S(tp[1] ?? tp[0]);
      const r = R(tails[0], 0) * 2.2;
      em.add(new Pen().ellipse(q[0], q[1], r, r), species === "rabbit" || species === "deer" ? "paper" : woolly ? "skin" : "skin", { tone: 0 });
    } else stroke(tp, [R(tails[0], 0), ...tails.map((n) => R(n, 1) * 0.8)], bird ? "skin" : "hair", 0);
  }
  // tronc, ventre, robe
  const body = bodyOutline();
  if (woolly) {
    em.add(bumpy(bodyOutline(1.18), brad[0] * 0.22), "skin", { tone: 0 });
    const curls = new Pen();
    const c0 = S(bpts[0]), c1 = S(bpts[bpts.length - 1]);
    for (let k = 0; k < 14; k++) {
      const t = (k % 7) / 6, y = (k < 7 ? 0.35 : -0.2) * brad[1];
      const q: P2 = [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t + y];
      curls.M(q[0] - brad[1] * 0.12, q[1]).Q(q[0], q[1] + brad[1] * 0.15, q[0] + brad[1] * 0.12, q[1]);
    }
    em.line(curls, "skin", 0.6, { tone: -1 });
  } else {
    em.add(new Pen().smooth(body, true), "skin", { tone: 0 });
    if (!bird) {
      const belly = bpts.map((p, i) => [p[0], p[1] - brad[i] * 0.5, p[2]] as V3);
      em.add(strokeVar(new Pen(), belly.map(S), belly.map((_, i) => brad[i] * 0.42)), "skin", { tone: 1, stroke: null, alpha: 0.7 });
    }
    // robe
    const m0 = S(bpts[0]), m1 = S(bpts[bpts.length - 1]);
    const pat = new Pen();
    const r0 = brad[1] ?? brad[0];
    const seed = (c.pos[0] * 7.3 + c.pos[2] * 3.1) % 1;
    if (coat === "spotted") for (let k = 0; k < 9; k++) {
      const t = ((k * 0.618 + seed) % 1), y = Math.sin(k * 2.1) * r0 * 0.5;
      pat.ellipse(m0[0] + (m1[0] - m0[0]) * t, m0[1] + (m1[1] - m0[1]) * t + y, r0 * 0.14, r0 * 0.11);
    } else if (coat === "pie") for (let k = 0; k < 3; k++) {
      const t = 0.15 + k * 0.33 + seed * 0.1;
      const q: P2 = [m0[0] + (m1[0] - m0[0]) * t, m0[1] + (m1[1] - m0[1]) * t + r0 * (k % 2 ? 0.25 : -0.05)];
      blobInto(pat, q[0], q[1], r0 * 0.42, r0 * 0.36, k * 3.3 + seed);
    } else if (coat === "striped") for (let k = 0; k < 7; k++) {
      const t = 0.1 + k * 0.13;
      const q: P2 = [m0[0] + (m1[0] - m0[0]) * t, m0[1] + (m1[1] - m0[1]) * t];
      pat.M(q[0] - r0 * 0.08, q[1] + r0 * 0.85).Q(q[0] + r0 * 0.1, q[1], q[0] - r0 * 0.05, q[1] - r0 * 0.3).L(q[0] + r0 * 0.05, q[1] - r0 * 0.3).Q(q[0] + r0 * 0.2, q[1], q[0] + r0 * 0.06, q[1] + r0 * 0.85).Z();
    }
    if (!pat.empty) em.add(pat, "cloth3", { tone: 0, stroke: null });
    if (species === "cow" && has("thigh.l")) {
      const ud = S(lerp3(head("thigh.l"), head("thigh.r"), 0.5));
      em.add(new Pen().ellipse(ud[0] + (m1[0] > m0[0] ? 1 : -1) * r0 * 0.4, ud[1] - r0 * 0.75, r0 * 0.22, r0 * 0.16), "cloth2", { tone: 0, width: 0.4 });
    }
  }
  if (bird) for (const s of [far, near]) if (has(`wing.${s}`)) {
    const wp = chain([`wing.${s}`]);
    em.add(strokeVar(new Pen(), wp.map(S), [R(`wing.${s}`, 0) * 1.25, R(`wing.${s}`, 1) * 0.5]), "hair", { tone: s === near ? 0 : -1 });
    if (s === near) {
      const f = new Pen();
      const a = S(wp[0]), b = S(wp[1]);
      for (const t of [0.4, 0.6, 0.8]) f.M(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + R(`wing.${s}`, 0) * 0.6).L(a[0] + (b[0] - a[0]) * (t + 0.15), a[1] + (b[1] - a[1]) * (t + 0.15) - R(`wing.${s}`, 0) * 0.3);
      em.line(f, "hair", 0.5, { tone: -1 });
    }
  }
  // cou, crinière
  const neckNames = ["neck.1", "neck.2"].filter(has);
  if (neckNames.length) {
    const np = chain(neckNames);
    stroke(np, [R(neckNames[0], 0) * (heavy ? 1.3 : 1.15), ...neckNames.map((n) => R(n, 1) * 1.15)], woolly ? "skin" : "skin", 0);
    if (species === "horse") {
      const top = np.map((p, i) => [p[0], p[1] + R(neckNames[Math.min(i, neckNames.length - 1)], 0) * 0.9, p[2]] as V3);
      const mane = new Pen();
      const pts = top.map(S);
      mane.M(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        for (let k = 1; k <= 4; k++) {
          const t = k / 4;
          mane.L(a[0] + (b[0] - a[0]) * (t - 0.12) - 0.05, a[1] + (b[1] - a[1]) * (t - 0.12) + 0.12).L(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        }
      }
      for (let i = pts.length - 1; i >= 0; i--) mane.L(pts[i][0] - 0.04, pts[i][1] - 0.1);
      em.add(mane.Z(), "hair", { tone: -1, width: 0.5 });
    }
  }
  if (has("head")) {
    const h0 = head("head"), h1 = tail("head");
    const hr = R("head", 0), mr = R("head", 1);
    const mid = lerp3(h0, h1, 0.45);
    if (bird) {
      em.add(new Pen().ellipse(S(lerp3(h0, h1, 0.3))[0], S(lerp3(h0, h1, 0.3))[1], hr * 1.05, hr * 1.0), "skin", { tone: 0 });
      const b0 = S(lerp3(h0, h1, 0.62)), b1 = S(h1);
      const dir = Math.sign(b1[0] - b0[0]) || 1;
      if (species === "duck") em.add(new Pen().M(b0[0], b0[1] + hr * 0.25).Q(b1[0] + dir * hr * 0.2, b1[1] + hr * 0.15, b1[0], b1[1] - hr * 0.1).Q(b0[0] + dir * hr * 0.3, b0[1] - hr * 0.4, b0[0], b0[1] - hr * 0.25).Z(), "accent", { width: 0.5 });
      else {
        em.add(new Pen().M(b0[0], b0[1] + hr * 0.25).L(b1[0], b1[1]).L(b0[0], b0[1] - hr * 0.2).Z(), "accent", { width: 0.5 });
        // crête et barbillons (poule)
        const top = S(lerp3(h0, h1, 0.3));
        if (species === "chicken") {
        const comb = new Pen().M(top[0] - dir * hr * 0.6, top[1] + hr * 0.7);
        for (let k = 0; k < 4; k++) comb.Q(top[0] - dir * hr * (0.45 - k * 0.3), top[1] + hr * 1.5, top[0] - dir * hr * (0.3 - k * 0.3), top[1] + hr * 0.8);
        comb.L(top[0] + dir * hr * 0.6, top[1] + hr * 0.6).Z();
        em.add(comb, "cloth2", { width: 0.45 });
        em.add(new Pen().ellipse(b0[0] - dir * hr * 0.1, b0[1] - hr * 0.55, hr * 0.18, hr * 0.3), "cloth2", { width: 0.4 });
        }
      }
    } else {
      stroke([h0, mid, h1], [hr * 1.15, hr * 0.92, mr * 1.05], woolly ? "leather" : "skin", 0);
      // museau / groin / naseau
      const snout = lerp3(h0, h1, 0.88);
      const t = S(h1), sn = S(snout);
      const dir = Math.sign(t[0] - sn[0]) || 1;
      if (species === "pig") em.add(new Pen().ellipse(t[0], t[1], mr * 0.45, mr * 0.75), "cloth2", { tone: 0, width: 0.5 });
      else em.add(new Pen().ellipse(t[0] - dir * mr * 0.25, t[1] + mr * 0.25, mr * 0.32, mr * 0.24), "leather", { stroke: null });
      em.line(new Pen().M(t[0] - dir * mr * 0.2, t[1] - mr * 0.45).Q(t[0] - dir * mr * 0.7, t[1] - mr * 0.6, t[0] - dir * mr * 1.2, t[1] - mr * 0.45), "leather", 0.6);
      // cornes, bois
      const poll = S(lerp3(h0, h1, 0.12));
      const hornS = hr * (species === "cow" ? 1.3 : 1.6);
      if (species === "cow") em.add(strokeVar(new Pen(), [[poll[0], poll[1] + hr * 0.6], [poll[0] - dir * hornS * 0.3, poll[1] + hr * 1.2], [poll[0] + dir * hornS * 0.25, poll[1] + hr * 1.7]], [hr * 0.16, hr * 0.12, hr * 0.03]), "cloth1", { width: 0.5 });
      if (species === "goat") em.add(strokeVar(new Pen(), [[poll[0], poll[1] + hr * 0.7], [poll[0] - dir * hornS * 0.35, poll[1] + hr * 1.6], [poll[0] - dir * hornS * 0.75, poll[1] + hr * 1.3]], [hr * 0.17, hr * 0.12, hr * 0.03]), "cloth1", { width: 0.5 });
      if (species === "goat") em.add(strokeVar(new Pen(), [t, [t[0] - dir * mr * 0.4, t[1] - mr * 1.4]], [mr * 0.3, mr * 0.08]), "hair", { tone: 0, stroke: null });
      if (species === "deer" && String(c.params.variant ?? 0) !== "1") {
        const ant = new Pen();
        const b: P2 = [poll[0], poll[1] + hr * 0.7];
        const pts: P2[] = [b, [b[0] - dir * hr * 0.6, b[1] + hr * 1.6], [b[0] - dir * hr * 0.4, b[1] + hr * 3.0]];
        strokeVar(ant, pts, [hr * 0.12, hr * 0.09, hr * 0.03]);
        for (const tt of [0.35, 0.65, 0.95]) {
          const q: P2 = [pts[0][0] + (pts[2][0] - pts[0][0]) * tt - dir * hr * 0.3 * Math.sin(tt * 3), pts[0][1] + (pts[2][1] - pts[0][1]) * tt];
          strokeVar(ant, [q, [q[0] + dir * hr * 0.7, q[1] + hr * 0.6]], [hr * 0.06, hr * 0.02]);
        }
        em.add(ant, "cloth1", { width: 0.45 });
      }
      // œil à reflet ou paupière
      const eye = lerp3(h0, h1, 0.32);
      const e = S(eye);
      const ey: P2 = [e[0], e[1] + hr * 0.35];
      const er = hr * 0.17;
      if (c.blink > 0.5) em.line(new Pen().M(ey[0] - er, ey[1]).Q(ey[0], ey[1] - er * 0.6, ey[0] + er, ey[1]), "ink", 0.9);
      else {
        em.add(new Pen().ellipse(ey[0], ey[1], er, er * 1.1), "eye", { stroke: null });
        em.add(new Pen().ellipse(ey[0] + dir * er * 0.3, ey[1] + er * 0.35, er * 0.32, er * 0.32), "paper", { tone: 1, stroke: null });
      }
    }
    // oreilles
    for (const s of [far, near]) if (has(`ear.${s}`)) {
      const ep = chain([`ear.${s}`]);
      const w = R(`ear.${s}`, 0) * (species === "rabbit" ? 1.6 : species === "bear" ? 2.2 : 1.5);
      if (species === "bear") {
        const q = S(ep[1]);
        em.add(new Pen().ellipse(q[0], q[1], w, w), "skin", { tone: s === near ? 0 : -1 });
      } else {
        em.add(strokeVar(new Pen(), ep.map(S), [w, w * (species === "rabbit" ? 0.7 : 0.25)]), species === "sheep" ? "leather" : "skin", { tone: s === near ? 0 : -1 });
        if (s === near && (species === "rabbit" || species === "fox" || species === "cat")) em.add(strokeVar(new Pen(), [S(lerp3(ep[0], ep[1], 0.2)), S(lerp3(ep[0], ep[1], 0.85))], [w * 0.45, w * 0.15]), species === "fox" ? "ink" : "cloth2", { stroke: null, alpha: 0.8 });
      }
    }
  }
  // pattes proches par-dessus
  if (!bird) leg(near, true, 0);
  leg(near, false, 0);
}

function blobInto(pen: Pen, cx: number, cy: number, rx: number, ry: number, seed: number) {
  const pts: P2[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx * (1 + 0.25 * Math.sin(seed + i * 2.3)), cy + Math.sin(a) * ry * (1 + 0.25 * Math.sin(seed * 1.7 + i))]);
  }
  pen.smooth(pts, true);
}

/** Contour bosselé (laine). */
function bumpy(pts: P2[], amp: number): Pen {
  const pen = new Pen();
  if (pts.length < 3) return pen;
  let L = 0;
  for (let i = 0; i < pts.length; i++) L += Math.hypot(pts[(i + 1) % pts.length][0] - pts[i][0], pts[(i + 1) % pts.length][1] - pts[i][1]);
  const n = Math.max(10, Math.round(L / (amp * 2)));
  const per: P2[] = [];
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
    const dx = m[0] - cx, dy = m[1] - cy, l = Math.hypot(dx, dy) || 1;
    pen.Q(m[0] + (dx / l) * amp * 1.6, m[1] + (dy / l) * amp * 1.6, b[0], b[1]);
  }
  return pen.Z();
}
