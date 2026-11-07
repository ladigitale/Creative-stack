/**
 * Animaux vectoriels animés : le squelette posé par `animalPose` (mêmes allures que la 3D) est projeté.
 * Corps, cou, pattes et queue sont chacun **un seul trait continu à épaisseur variable** suivant la chaîne d'os
 * (aucune jointure possible) ; tête en masse lisse avec museau, œil, oreilles ; pattes éloignées plus sombres et
 * derrière. Couleurs : celles de l'asset (`skin` pelage, `hair` secondaire, `leather` sabots et nez, `accent` bec).
 */
import { type M4, type V3 } from "../../core/math";
import type { Skeleton } from "../../rig/skeleton";
import type { Projector } from "../project";
import { type P2, Pen, strokeVar } from "../shape";
import { Emitter, Frame } from "./kit";

export type AnimalInput = { sk: Skeleton; W: M4[]; pos: V3; yaw: number; params: Record<string, unknown>; blink: number };

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
  const stroke = (pts: V3[], hw: number[], fill: string, tone = 0, dz = 0) => em.add(strokeVar(new Pen(), pts.map(S), hw), fill, { tone, dz });

  // côté proche / éloigné d'après la profondeur des hanches
  const near = pr.depth(head("thigh.l")) >= pr.depth(head("thigh.r")) ? "l" : "r";
  const far = near === "l" ? "r" : "l";
  const leg = (s: string, front: boolean, tone: number, dz: number) => {
    const names = front ? [`upperarm.${s}`, `forearm.${s}`, `hand.${s}`, `finger.${s}`] : [`thigh.${s}`, `shin.${s}`, `foot.${s}`, `toe.${s}`];
    const ok = names.filter(has);
    if (ok.length < 2) return;
    const pts = chain(ok);
    const hw = [R(ok[0], 0) * 0.95, R(ok[0], 1), ...ok.slice(1).map((n) => R(n, 1) * 0.95)];
    stroke(pts, hw, "skin", tone, dz);
    // sabot / pied
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    stroke([prev, last], [R(ok[ok.length - 1], 1) * 1.05, R(ok[ok.length - 1], 1) * 1.1], bird ? "accent" : "leather", tone, dz + 1e-4);
  };
  // pattes éloignées d'abord
  if (!bird) leg(far, true, -1, -0.02);
  leg(far, false, -1, -0.02);
  // queue
  const tails = ["tail.1", "tail.2", "tail.3"].filter(has);
  if (tails.length) stroke(chain(tails), [R(tails[0], 0), ...tails.map((n) => R(n, 1) * 0.8)], bird ? "skin" : "hair", 0, -0.01);
  // corps : une seule masse le long du dos
  const bodyNames = ["pelvis", "spine", "chest"].filter(has);
  const body = chain(bodyNames);
  const bw = bodyNames.map((n) => R(n, 0));
  stroke(body, [bw[0] * 0.92, ...bw.map((r, i) => r * (i === bw.length - 1 ? 0.95 : 1.05))], "skin", 0, 0);
  // ventre plus clair (bande sous le corps)
  if (!bird) {
    const belly = body.map((p, i) => [p[0], p[1] - bw[Math.min(i, bw.length - 1)] * 0.55, p[2]] as V3);
    stroke(belly, belly.map((_, i) => bw[Math.min(i, bw.length - 1)] * 0.42), "hair", 0, 1e-4);
  }
  // aile (oiseaux)
  if (bird) for (const s of [far, near]) if (has(`wing.${s}`)) stroke(chain([`wing.${s}`]), [R(`wing.${s}`, 0) * 1.1, R(`wing.${s}`, 1) * 0.6], "hair", s === near ? 0 : -1, s === near ? 0.02 : -0.005);
  // cou et tête
  const neckNames = ["neck.1", "neck.2"].filter(has);
  if (neckNames.length) stroke(chain(neckNames), [R(neckNames[0], 0), ...neckNames.map((n) => R(n, 1))], "skin", 0, 0.01);
  if (has("head")) {
    const h0 = head("head"), h1 = tail("head");
    const hr = R("head", 0), mr = R("head", 1);
    const mid: V3 = [h0[0] + (h1[0] - h0[0]) * 0.45, h0[1] + (h1[1] - h0[1]) * 0.45, h0[2] + (h1[2] - h0[2]) * 0.45];
    stroke([h0, mid, h1], [hr * 1.05, hr * 0.85, mr * 0.9], "skin", 0, 0.015);
    // museau / bec
    const tip = h1;
    const snout: V3 = [h0[0] + (h1[0] - h0[0]) * 0.85, h0[1] + (h1[1] - h0[1]) * 0.85, h0[2] + (h1[2] - h0[2]) * 0.85];
    if (bird) stroke([snout, tip], [mr * 0.55, mr * 0.12], "accent", 0, 0.02);
    else em.add(strokeVar(new Pen(), [S(snout), S(tip)], [mr * 0.3, mr * 0.34]), "leather", { dz: 0.02 });
    // œil (fermé pendant le clignement)
    const eye: V3 = [h0[0] + (h1[0] - h0[0]) * 0.32, h0[1] + (h1[1] - h0[1]) * 0.32 + hr * 0.35, h0[2] + (h1[2] - h0[2]) * 0.32];
    const er = hr * 0.16;
    const e = S(eye);
    if (c.blink > 0.5) em.line(`M${e[0] - er},${e[1]} L${e[0] + er},${e[1]}`, "ink", er * 0.5, { dz: 0.03 });
    else em.add(strokeVar(new Pen(), [[e[0], e[1] - er * 0.6], [e[0], e[1] + er * 0.6]], [er, er]), "eye", { dz: 0.03, stroke: null });
    // oreilles
    for (const s of [far, near]) if (has(`ear.${s}`)) stroke(chain([`ear.${s}`]), [R(`ear.${s}`, 0) * 1.3, R(`ear.${s}`, 1) * 0.6], "skin", s === near ? 0 : -1, s === near ? 0.025 : 0.005);
  }
  // pattes proches par-dessus
  if (!bird) leg(near, true, 0, 0.03);
  leg(near, false, 0, 0.03);
}
