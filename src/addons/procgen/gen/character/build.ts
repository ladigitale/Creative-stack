/**
 * Assemblage d'un personnage : corps (champ grossier), tête et mains (champs fins), gabarits du visage, pièces
 * rigides (boutons, boucle, poches), objet tenu ; poids de skinning, découpe des bords de couleur, ancres.
 */
import { type V3, DEG, dot, len, m4Compose, madd, mix, norm, qAxis, qFromTo, qId, qRot, smoothstep, sub, qFromAxes } from "../../core/math";
import type { Rng } from "../../core/rng";
import { Field, polygonize, primDist } from "../../geom/implicit";
import { Mesh } from "../../geom/mesh";
import { box, ellipsoid } from "../../geom/prims";
import { edgeZero, splitByLabel } from "../../geom/rolecut";
import { VertexIndex, mixWeights, weightsOf, writeWeights } from "../../geom/transfer";
import { type Archetype, type Age, buildHumanoid, proportions } from "../../rig/humanoid";
import { computeWeights } from "../../rig/weights";
import { type Skeleton, qFromBasis } from "../../rig/skeleton";
import { ROLE } from "../../style/roles";
import type { Anchor, Asset } from "../types";
import { type Decal, buildBodyField } from "./body";
import { buildFace } from "./face";
import { handFrame, handTemplate, placeHand } from "./hands";
import { buildHeadField } from "./head";
import { heldToolBasis } from "../tool";
import { buildItem } from "./items";
import { type Pattern, makeKit } from "./kit";
import type { Look } from "./look";

export type Built = { mesh: Mesh; skeleton: Skeleton; anchors: Record<string, Anchor>; footprint: Asset["footprint"]; height: number };

export function buildCharacter(look: Look, v: Rng): Built {
  const P = proportions({
    height: look.height, archetype: look.archetype as Archetype, age: look.age as Age, build: look.build, shape: look.shape, headSize: look.headSize, belly: look.belly,
    legs: look.body.legs, arms: look.body.arms, neck: look.body.neck, shoulders: look.body.shoulders, hips: look.body.hips, posture: look.body.posture, asym: look.body.asym,
  });
  const skel = buildHumanoid(P);
  const H = P.H;
  const crowd = look.detail === "crowd";
  const cell = H * (look.archetype === "chibi" ? 0.0115 : 0.0125) * (crowd ? 1.4 : 1);
  // une couche de vêtement n'a pas besoin d'être plus épaisse qu'une cellule : le propriétaire est recalculé à la surface
  const thick = Math.max(cell * 0.55, H * 0.009);
  const k = makeKit(look, P, skel, cell, thick, v);
  const bi = (n: string) => skel.index[n];

  /* ---------- corps ---------- */
  const bf = buildBodyField(k);
  const prims = bf.set.prims;
  const field = new Field(prims, bf.blends);
  const { mesh, owner } = polygonize(field, { cell, smooth: 3, ao: true, exactOwner: true, aoSteps: 3 });
  const boneOwner = Int32Array.from(owner, (o) => (o >= 0 ? bf.set.bone[o] : 0));
  const thighY = k.B("shin.l").head[1];
  computeWeights(mesh, boneOwner, skel, {
    passes: 9,
    side: (vi) => {
      const x = mesh.pos[vi * 3];
      return x > H * 0.008 ? "l" : x < -H * 0.008 ? "r" : "";
    },
    sharp: { "toe.l": 0.4, "toe.r": 0.4 },
    override: (vi) => {
      const o = owner[vi];
      if (o < 0 || !bf.set.drape[o]) return null;
      const pt = mesh.getPos(vi);
      const a = smoothstep(P.crotchY + H * 0.02, thighY, pt[1]);
      const sx = pt[0] >= 0 ? "l" : "r";
      const sideW = smoothstep(0, P.hipHalf * 0.9, Math.abs(pt[0]));
      const legW = a * 0.6 * (0.4 + 0.6 * sideW);
      return { pelvis: 1 - legW, [`thigh.${sx}`]: legW };
    },
  });
  cutRoles(mesh, owner, field, bf.set.pattern, cell);

  /* ---------- tête ---------- */
  const hf = buildHeadField(k);
  const hField = new Field(hf.set.prims, hf.blends);
  const headCell = P.headH / (crowd ? 14 : 26);
  const hp = polygonize(hField, { cell: headCell, smooth: 2, ao: true, exactOwner: true, aoSteps: 3 });
  const head = hp.mesh;
  // poids : tête rigide au-dessus du menton, poids de la peau la plus proche (cou, buste) en dessous
  const trunk = new Set(["neck", "chest", "spine", "clavicle.l", "clavicle.r"].map(bi));
  const bodyIdx = new VertexIndex(mesh, cell * 2, (vv) => mesh.pos[vv * 3 + 1] > P.crotchY && trunk.has(dominant(mesh, vv)));
  head.skin = new Array(head.vertexCount * 4).fill(0);
  head.weight = new Array(head.vertexCount * 4).fill(0);
  const headW = new Map([[bi("head"), 1]]);
  const lo = P.chinY - P.headH * 0.14, hi = P.chinY + P.headH * 0.16;
  for (let vv = 0; vv < head.vertexCount; vv++) {
    const p = head.getPos(vv);
    const kh = smoothstep(lo, hi, p[1]);
    let w = headW;
    if (kh < 1) {
      const nb = bodyIdx.nearest(p, 12);
      w = nb >= 0 ? mixWeights(weightsOf(mesh, nb), headW, kh) : headW;
    }
    writeWeights(head.skin, head.weight, vv, w);
  }
  // pommettes : mélange vers le rôle des lèvres (rôle 31), sur tous les sommets de la tête (le second rôle doit être constant)
  const blushK = { none: 0, light: 0.55, strong: 0.85 }[look.blush] ?? 0;
  head.blend = new Array(head.vertexCount).fill(ROLE.sky);
  if (blushK > 0) {
    const cheeks: V3[] = [1, -1].map((sx) => {
      const p = hf.skin.raycast([sx * (hf.eyeX + hf.eyeR * 0.3), hf.noseTipY - P.headH * 0.01, hf.headC[2] + P.headD], [0, 0, -1], P.headD * 2) ?? [sx * hf.eyeX, hf.noseTipY, hf.headC[2] + P.headD * 0.4];
      return p;
    });
    const sig = P.headW * 0.12;
    for (let vv = 0; vv < head.vertexCount; vv++) {
      if (head.role[vv] !== ROLE.skin) continue;
      const p = head.getPos(vv);
      let part = 0;
      for (const c of cheeks) part = Math.max(part, Math.exp(-(dist2(p, c) / (sig * sig))));
      head.blend[vv] = ROLE.sky + Math.min(0.92, part * blushK);
    }
  }
  cutRoles(head, hp.owner, hField, null, headCell);

  /* ---------- visage ---------- */
  const face = buildFace(k, hf, crowd);
  skinRigid(face.mesh, bi("head"));
  face.mesh.morph = face.morph;

  /* ---------- mains ---------- */
  const item = buildItem(look.item, H);
  const hands: Mesh[] = [];
  const grips: Record<string, V3> = {};
  const frames: Record<string, V3> = {};
  for (const s of ["l", "r"] as const) {
    const side = s === "l" ? 1 : -1;
    const hb = k.B(`hand.${s}`);
    const d = norm(sub(hb.tail, hb.head));
    const L = len(sub(hb.tail, hb.head));
    const holding = s === "r" && !!item;
    // Prise : le bras pend le long du corps à l'animation (A-pose ramenée de 36°) ; pour tenir un manche droit, la main
    // est tendue vers l'avant (poignet fléchi), le manche vertical dans le poing.
    const ad = (v: V3): V3 => {
      const c = Math.cos(side * 36 * DEG), sn = Math.sin(side * 36 * DEG);
      return [v[0] * c - v[1] * sn, v[0] * sn + v[1] * c, v[2]];
    };
    let fd = d;
    let thumbHint: V3 = [side * 0.15, 0.1, 1];
    if (holding) {
      thumbHint = ad([0, 1, 0]);
      fd = norm(ad([0, -0.35, 1]));
    }
    const { t, n } = handFrame(fd, side as 1 | -1, thumbHint);
    const fdn = norm(sub(fd, scale3(t, dot(fd, t))));
    const wristDir: V3 = [dot(scale3(d, -1), t), dot(scale3(d, -1), fdn), dot(scale3(d, -1), n)].map((x) => Math.round(x * 10) / 10) as V3;
    const rw = (k.rad(`forearm.${s}`, 1) * mix(0.95, 1.1, look.build)) / L;
    const ro = holding ? Math.min(0.22, Math.max(0.07, item!.handle / L)) : 0.1;
    const chunky = look.archetype === "chibi" ? 1.1 : look.archetype === "cartoon" ? 1.05 : 1;
    const tpl = handTemplate(holding ? "grip" : "relax", round2(rw), round2(ro), look.gloves === "gloves" ? ROLE.leather : ROLE.skin, !crowd, chunky, wristDir);
    const placed = placeHand(tpl, hb.head, t, fdn, n, L);
    const hm = placed.mesh;
    hm.skin = new Array(hm.vertexCount * 4).fill(0);
    hm.weight = new Array(hm.vertexCount * 4).fill(0);
    for (let vv = 0; vv < hm.vertexCount; vv++) {
      const y = dot(sub(hm.getPos(vv), hb.head), d) / L;
      const wh = smoothstep(-0.16, 0.1, y);
      writeWeights(hm.skin, hm.weight, vv, new Map([[bi(`forearm.${s}`), 1 - wh], [bi(`hand.${s}`), wh]]));
    }
    hands.push(hm);
    grips[s] = placed.grip;
    frames[s] = t;
  }

  /* ---------- pièces rigides posées sur la peau ---------- */
  const decalMesh = new Mesh();
  const allIdx = new VertexIndex(mesh, cell * 2);
  for (const dc of bf.decals) {
    const m = buildDecal(dc, field, H);
    if (!m) continue;
    const nb = allIdx.nearest(m.anchor, 10);
    const w = nb >= 0 ? weightsOf(mesh, nb) : new Map([[bi("chest"), 1]]);
    m.mesh.skin = new Array(m.mesh.vertexCount * 4).fill(0);
    m.mesh.weight = new Array(m.mesh.vertexCount * 4).fill(0);
    for (let vv = 0; vv < m.mesh.vertexCount; vv++) writeWeights(m.mesh.skin, m.mesh.weight, vv, w);
    decalMesh.append(m.mesh);
  }

  /* ---------- objet tenu ---------- */
  if (item) {
    // outils : manche dans l'axe de la main, tête vers l'avant ou en travers (même repère qu'en vectoriel)
    const q = item.head ? qFromAxes(...heldToolBasis(frames.r, [0, 0, 1], item.head)) : qFromTo([0, 1, 0], frames.r);
    item.mesh.transform(m4Compose(grips.r, q));
    skinRigid(item.mesh, bi("hand.r"));
  }

  /* ---------- assemblage ---------- */
  mesh.append(head);
  mesh.append(face.mesh);
  for (const h of hands) mesh.append(h);
  if (decalMesh.vertexCount) mesh.append(decalMesh);
  if (item) mesh.append(item.mesh);

  /* ---------- ancres ---------- */
  const hand = k.B("hand.r");
  const chestC = bf.chestC, chestR = bf.chestR;
  const anchors: Record<string, Anchor> = {
    "head.top": { bone: "head", pos: [0, hf.topY, hf.headC[2]], rot: qId(), scale: P.headW },
    "head.center": { bone: "head", pos: hf.headC, rot: qId(), scale: P.headW },
    "hand.r.grip": { bone: "hand.r", pos: grips.r, rot: qFromTo([0, 1, 0], frames.r), scale: hand.radius[0] * 2 },
    "hand.l.grip": { bone: "hand.l", pos: grips.l, rot: qFromTo([0, 1, 0], frames.l), scale: hand.radius[0] * 2 },
    back: { bone: "chest", pos: [0, chestC[1], bf.backZ], rot: qAxis([0, 1, 0], Math.PI), scale: chestR[0] },
    "chest.front": { bone: "chest", pos: [0, chestC[1], chestC[2] + chestR[2] + thick], rot: qId(), scale: chestR[0] },
    "hip.l": { bone: "pelvis", pos: [P.hipHalf * 1.3, P.hipY, 0], rot: qId(), scale: P.hipHalf },
    "hip.r": { bone: "pelvis", pos: [-P.hipHalf * 1.3, P.hipY, 0], rot: qId(), scale: P.hipHalf },
    feet: { bone: "root", pos: [0, 0, 0], rot: qId(), scale: P.shoulderHalf },
  };
  const bb = mesh.bounds();
  const hx = Math.max(P.shoulderHalf * 1.2, P.hipHalf * 1.4);
  return { mesh, skeleton: skel, anchors, footprint: { hx, hz: H * 0.09, r: Math.max(hx, H * 0.12) }, height: bb.max[1] };
}

/**
 * Bords de couleur nets : 1) frontière entre primitives de rôles différents (iso-ligne d'égale distance) ; 2) motifs
 * (zéro de la fonction de motif de la primitive). Les nouveaux sommets sont recalés sur la surface.
 */
function cutRoles(mesh: Mesh, owner: Int32Array, field: Field, patterns: (Pattern | null)[] | null, cell: number) {
  const prims = field.prims;
  const roleOfOwner = (o: number) => (o >= 0 ? prims[o].role : ROLE.skin);
  // recalage le long de la normale interpolée (une seule évaluation du champ)
  const place = (p: V3, n: V3) => ({ p: madd(p, n, -field.distance(p)), n });
  const isoT = (oa: number, ob: number, a: number, b: number) => {
    const pa = mesh.getPos(a), pb = mesh.getPos(b);
    const f = (t: number) => {
      const x = lerp(pa, pb, t);
      return primDist(x[0], x[1], x[2], prims[oa]) - primDist(x[0], x[1], x[2], prims[ob]);
    };
    return edgeZero(f, f(0), f(1));
  };
  const n0 = mesh.vertexCount;
  const own = Array.from({ length: n0 }, (_, i) => owner[i]);
  const r1 = splitByLabel(mesh, {
    label: own.map(roleOfOwner),
    roleOf: (l) => l,
    edgeT: (a, b) => {
      const oa = own[a] ?? -1, ob = own[b] ?? -1;
      if (oa < 0 || ob < 0 || oa === ob) return 0.5;
      return isoT(oa, ob, a, b);
    },
    place,
  });
  if (!patterns || !patterns.some((x) => x)) return;
  // passe 2 : motifs (étiquette = rôle de base ou alternatif selon le signe)
  const ownerOf = (v: number) => own[r1.origin[v]] ?? -1;
  const lab2 = Array.from({ length: mesh.vertexCount }, (_, v) => {
    const o = ownerOf(v);
    const pat = o >= 0 ? patterns[o] : null;
    if (!pat || mesh.role[v] !== prims[o].role) return mesh.role[v];
    return pat.fn(mesh.getPos(v)) > 0 ? pat.alt + 64 : mesh.role[v];
  });
  const origin2 = r1.origin;
  splitByLabel(
    mesh,
    {
      label: lab2,
      roleOf: (l) => (l >= 64 ? l - 64 : l),
      edgeT: (a, b) => {
        const oa = ownerOf(a), ob = ownerOf(b);
        const pa = oa >= 0 ? patterns[oa] : null, pb = ob >= 0 ? patterns[ob] : null;
        if (pa && pa === pb) {
          const A = mesh.getPos(a), B = mesh.getPos(b);
          const f = (t: number) => pa.fn(lerp(A, B, t));
          return edgeZero(f, f(0), f(1));
        }
        if (oa >= 0 && ob >= 0 && oa !== ob) return isoT(oa, ob, a, b);
        return 0.5;
      },
      place,
    },
    origin2,
  );
}

/** Bouton, boucle, poche : posés sur la surface du champ, orientés selon la normale. */
function buildDecal(dc: Decal, field: Field, H: number): { mesh: Mesh; anchor: V3 } | null {
  const start = madd(dc.at, dc.dir, H * 0.1);
  const p = field.raycast(start, [-dc.dir[0], -dc.dir[1], -dc.dir[2]], H * 0.25, H * 0.0004);
  if (!p) return null;
  const n = field.gradient(p, H * 0.004);
  const q = qFromBasis([0, 0, 1], [0, 1, 0], n, dc.up ?? [0, 1, 0]);
  const m = new Mesh();
  const s = dc.size;
  switch (dc.kind) {
    case "button":
      m.append(ellipsoid(s, s, s * 0.45, dc.role, 8, 4), m4Compose(madd(p, n, s * 0.1), q));
      break;
    case "buckle":
      m.append(box(s, s * 0.8, s * 0.3, dc.role, s * 0.15), m4Compose(madd(p, n, s * 0.1), q));
      m.append(box(s * 0.62, s * 0.45, s * 0.3, ROLE.leather, s * 0.1), m4Compose(madd(p, n, s * 0.22), q));
      break;
    case "pocket":
      m.append(box(s * 0.5, s * 0.55, H * 0.004, dc.role, H * 0.002), m4Compose(madd(madd(p, n, H * 0.002), qRot(q, [0, 1, 0]), -s * 0.15), q));
      m.append(box(s * 0.54, s * 0.16, H * 0.006, dc.role, H * 0.003), m4Compose(madd(madd(p, n, H * 0.005), qRot(q, [0, 1, 0]), s * 0.32), q));
      break;
    case "flap":
      m.append(box(s * 0.55, s * 0.15, H * 0.005, dc.role, H * 0.002), m4Compose(madd(p, n, H * 0.003), q));
      break;
  }
  return { mesh: m, anchor: p };
}

function skinRigid(m: Mesh, bone: number) {
  m.skin = new Array(m.vertexCount * 4).fill(0).map((_, i) => (i % 4 === 0 ? bone : 0));
  m.weight = new Array(m.vertexCount * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0));
}

function dominant(m: Mesh, v: number): number {
  let best = 0, bw = -1;
  for (let j = 0; j < 4; j++)
    if (m.weight![v * 4 + j] > bw) {
      bw = m.weight![v * 4 + j];
      best = m.skin![v * 4 + j];
    }
  return best;
}

const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const dist2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const round2 = (x: number) => Math.round(x * 20) / 20;
const scale3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
