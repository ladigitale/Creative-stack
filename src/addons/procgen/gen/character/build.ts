/**
 * Assemblage d'un personnage : corps (champ grossier), tête et mains (champs fins), gabarits du visage, pièces
 * rigides (boutons, boucle, poches), objet tenu ; poids de skinning, découpe des bords de couleur, ancres.
 */
import { type V3, DEG, dot, len, m4Compose, madd, mix, norm, qAxis, qFromTo, qId, qRot, smoothstep, sub, qFromAxes } from "../../core/math";
import type { Rng } from "../../core/rng";
import { Field, polygonize, primDist } from "../../geom/implicit";
import { Mesh } from "../../geom/mesh";
import { smoothScalar } from "../../geom/adjacency";
import { box, ellipsoid, tube } from "../../geom/prims";
import { edgeZero, splitByLabel } from "../../geom/rolecut";
import { VertexIndex, mixWeights, weightsOf, writeWeights } from "../../geom/transfer";
import { type Archetype, type Age, type Proportions, buildHumanoid, proportions } from "../../rig/humanoid";
import { type P2, balanceLines, layoutText } from "../../core/font";
import { type SurfacePoint, printFills, printMesh } from "../../geom/text";
import { computeWeights } from "../../rig/weights";
import { type Skeleton, qFromBasis } from "../../rig/skeleton";
import { ROLE } from "../../style/roles";
import type { Anchor, Asset, SoftPiece } from "../types";
import { type Decal, buildBodyField } from "./body";
import { buildFace } from "./face";
import { HAND_MORPHS, type HandMorph, handFrame, handTemplate, placeHand } from "./hands";
import { buildHeadField } from "./head";
import { heldToolBasis } from "../tool";
import { buildItem } from "./items";
import { type Pattern, makeKit } from "./kit";
import type { Look } from "./look";

export type Built = { mesh: Mesh; skeleton: Skeleton; anchors: Record<string, Anchor>; footprint: Asset["footprint"]; height: number; soft: SoftPiece[]; expr?: Asset["expr"] };

function lookProportions(look: Look) {
  return proportions({
    height: look.height, archetype: look.archetype as Archetype, age: look.age as Age, build: look.build, shape: look.shape, headSize: look.headSize, belly: look.belly,
    legs: look.body.legs, arms: look.body.arms, neck: look.body.neck, shoulders: look.body.shoulders, hips: look.body.hips, posture: look.body.posture, asym: look.body.asym,
  });
}

/** Squelette et taille seuls (rapide) : doublure d'un personnage pendant le repérage des constructions à lancer. */
export function characterSkeleton(look: Look) {
  const P = lookProportions(look);
  return { skel: buildHumanoid(P), H: P.H };
}

/** Proportions, squelette et kit de construction d'un personnage (partagé avec les tests de pose des accessoires). */
export function characterKit(look: Look, v: Rng) {
  const P = lookProportions(look);
  const skel = buildHumanoid(P);
  const H = P.H;
  const crowd = look.detail === "crowd";
  const cell = H * (look.archetype === "chibi" ? 0.0115 : 0.0125) * (crowd ? 1.4 : 1);
  // une couche de vêtement n'a pas besoin d'être plus épaisse qu'une cellule : le propriétaire est recalculé à la surface
  const thick = Math.max(cell * 0.55, H * 0.009);
  const k = makeKit(look, P, skel, cell, thick, v);
  return { P, skel, H, crowd, cell, thick, k };
}

export function buildCharacter(look: Look, v: Rng): Built {
  const { P, skel, H, crowd, cell, thick, k } = characterKit(look, v);
  const bi = (n: string) => skel.index[n];

  /* ---------- corps ---------- */
  const bf = buildBodyField(k);
  const prims = bf.set.prims;
  const field = new Field(prims, bf.blends);
  const { mesh, owner } = polygonize(field, { cell, smooth: 3, ao: true, exactOwner: true, aoSteps: 3 });
  const boneOwner = Int32Array.from(owner, (o) => (o >= 0 ? bf.set.bone[o] : 0));
  // un pan de vêtement accroché au bas du dos (manteau, veste) suit, au-dessus, l'os qui est vraiment là : le haut du
  // dos et les omoplates bougent avec la poitrine, pas avec les lombaires (sinon la peau s'étire bras levés)
  {
    const iSpine = skel.index.spine, iChest = skel.index.chest, iPelvis = skel.index.pelvis;
    const chest = k.B("chest"), spine = k.B("spine");
    const yChest = chest.head[1] + (chest.tail[1] - chest.head[1]) * 0.2, ySpine = spine.head[1] + (spine.tail[1] - spine.head[1]) * 0.3;
    for (let vi = 0; vi < boneOwner.length; vi++) {
      const y = mesh.pos[vi * 3 + 1];
      if (boneOwner[vi] === iSpine && y > yChest) boneOwner[vi] = iChest;
      else if (boneOwner[vi] === iPelvis && y > ySpine) boneOwner[vi] = y > yChest ? iChest : iSpine;
    }
  }
  const thighY = k.B("shin.l").head[1];
  computeWeights(mesh, boneOwner, skel, {
    passes: 9,
    side: (vi) => {
      const x = mesh.pos[vi * 3];
      return x > H * 0.008 ? "l" : x < -H * 0.008 ? "r" : "";
    },
    sharp: { "toe.l": 0.4, "toe.r": 0.4 },
    // le bassin ne tire pas la poitrine ni les épaules (voisinage à deux niveaux depuis le buste) : sinon la peau
    // d'épaule, à moitié liée au bassin, s'étire dès que le bras se lève ou que le dos tourne
    exclude: (vi, b) => b === bi("pelvis") && mesh.pos[vi * 3 + 1] > k.B("chest").head[1],
    override: (vi) => {
      const o = owner[vi];
      if (o < 0 || !bf.set.drape[o]) return null;
      const pt = mesh.getPos(vi);
      // pan drapé : seul le bas (sous la taille) suit bassin et cuisses ; le haut garde les poids du buste et des
      // bras (sinon les épaules d'un manteau restaient collées au bassin et se déchiraient quand on bouge)
      if (pt[1] > P.hipY + H * 0.04) return null;
      // pan drapé (robe, jupe, tablier, manteau) : sous l'entrejambe il suit les jambes comme le tissu posé dessus —
      // la cuisse jusqu'au genou, puis le tibia ; entre les jambes il est partagé entre les deux cuisses (le tissu se
      // tend de l'une à l'autre) au lieu de rester accroché au bassin, que la cuisse traverserait assise ou en foulée
      const a = smoothstep(P.crotchY + H * 0.02, thighY, pt[1]);
      // le haut du pan (sur la cuisse) la suit franchement ; plus bas le tissu retombe : sous le genou la part des
      // jambes diminue jusqu'à l'ourlet (sinon une robe longue pivote en bloc et fait une cloche ou une boule)
      const below = smoothstep(thighY, thighY - H * 0.25, pt[1]);
      const legShare = a * (0.85 - 0.35 * below);
      // une seule jambe par sommet (pas de sommet partagé entre les deux cuisses) : part forte sur les côtés, là où
      // la cuisse traverserait le tissu, faible au milieu pour que le devant ne se déchire pas entre les jambes
      const sideW = smoothstep(0, P.hipHalf * 0.9, Math.abs(pt[0]));
      const ls = legShare * (0.3 + 0.7 * sideW);
      return { pelvis: 1 - ls, [`thigh.${pt[0] >= 0 ? "l" : "r"}`]: ls };
    },
  });
  cutRoles(mesh, owner, field, bf.set.pattern, cell);

  /* ---------- tête ---------- */
  const hf = buildHeadField(k);
  const hField = new Field(hf.set.prims, hf.blends);
  // tête plus fine que le corps : mâchoire, nez, lèvres et oreilles sans facettes ni bosses en gros plan
  const headCell = P.headH / (crowd ? 14 : 42);
  // lissage plus poussé que le corps : les raccords entre volumes du visage (joues, mâchoire, menton) se fondent
  const hp = polygonize(hField, { cell: headCell, smooth: crowd ? 3 : 10, ao: true, exactOwner: true, aoSteps: 3 });
  const head = hp.mesh;
  // occlusion de la tête : celle du lancer de rayons est bruitée à cette finesse (voiles clairs et sombres sur le
  // front et les joues) ; on n'en garde que les variations larges (orbites, sous le nez, sous le menton)
  if (head.ao && !crowd) smoothScalar(head, head.ao, 12);
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
  // modelé du visage : creux des orbites, dessous du nez, sillon sous la lèvre, creux sous les pommettes, tempes
  // assombris dans l'occlusion des sommets ; une carnation un peu plus chaude sur les joues, le nez et les oreilles.
  // C'est cette répartition des valeurs qui fait lire un visage de loin, bien avant les petits reliefs
  const arch = look.archetype;
  const sculptK = (({ realistic: 1, heroic: 1, stylized: 0.75, cartoon: 0.45, chibi: 0.25 }) as Record<string, number>)[arch] ?? 0.6;
  if (head.ao && !look.animalSpec) {
    const { eyeX, eyeY, eyeR, noseTip, mouthY, headC } = hf;
    const hh = P.headH, hw = P.headW;
    const zf = headC[2] + P.headD * 0.2;
    const g = (p: V3, c: V3, r: V3) => Math.exp(-(((p[0] - c[0]) / r[0]) ** 2 + ((p[1] - c[1]) / r[1]) ** 2 + ((p[2] - c[2]) / r[2]) ** 2));
    const zones: [V3, V3, number][] = [];
    for (const sx of [1, -1]) {
      zones.push([[sx * (eyeX - eyeR * 0.45), eyeY + eyeR * 0.55, zf], [eyeR * 1.15, eyeR * 0.9, P.headD * 0.5], 0.24]); // orbite, côté nez
      zones.push([[sx * (eyeX + eyeR * 1.3), eyeY - eyeR * 2.6, zf], [eyeR * 1.6, eyeR * 1.3, P.headD * 0.5], 0.05]); // creux sous la pommette
      zones.push([[sx * hw * 0.46, eyeY + eyeR * 1.2, headC[2]], [hw * 0.07, hh * 0.08, P.headD * 0.3], 0.08]); // tempe
      zones.push([[sx * hw * 0.09, noseTip[1] - hh * 0.005, zf], [hw * 0.045, hh * 0.03, P.headD * 0.4], 0.08]); // narine
    }
    zones.push([[0, noseTip[1] - hh * 0.035, zf], [hw * 0.07, hh * 0.022, P.headD * 0.5], 0.07]); // sous le nez
    zones.push([[0, mouthY - hh * 0.06, zf], [hw * 0.12, hh * 0.022, P.headD * 0.5], 0.06]); // sillon mentonnier
    for (let vv = 0; vv < head.vertexCount; vv++) {
      if (head.role[vv] !== ROLE.skin) continue;
      const p = head.getPos(vv);
      let d = 0;
      for (const [c, r, k] of zones) d += k * g(p, c, r);
      head.ao[vv] *= 1 - Math.min(0.45, d * 1.4 * sculptK);
    }
  }
  if (arch !== "chibi" && !look.animalSpec) {
    // carnation : sang plus visible sur les joues, le bout du nez et les oreilles (mélange léger vers le rôle des lèvres)
    const warm: [V3, number, number][] = [
      ...[1, -1].map((sx) => [[sx * (hf.eyeX + hf.eyeR * 0.2), hf.noseTipY + P.headH * 0.005, hf.headC[2] + P.headD * 0.35] as V3, P.headW * 0.13, 0.2] as [V3, number, number]),
      [hf.noseTip, P.headW * 0.06, 0.18],
      ...hf.ears.map((e) => [e, P.headW * 0.1, 0.22] as [V3, number, number]),
    ];
    for (let vv = 0; vv < head.vertexCount; vv++) {
      if (head.role[vv] !== ROLE.skin) continue;
      const p = head.getPos(vv);
      let part = head.blend[vv] - ROLE.sky;
      for (const [c, s, k] of warm) part = Math.max(part, k * sculptK * Math.exp(-dist2(p, c) / (s * s)));
      head.blend[vv] = ROLE.sky + Math.min(0.92, part);
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
  const handMorphs: (Record<HandMorph, Float32Array> | null)[] = [];
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
    handMorphs.push(placed.morphs ?? null);
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

  /* ---------- texte imprimé sur le haut (devant, nom et numéro au dos) ---------- */
  const printed = printTop(look, bf, field, H, cell, P);
  if (printed.vertexCount) {
    printed.skin = new Array(printed.vertexCount * 4).fill(0);
    printed.weight = new Array(printed.vertexCount * 4).fill(0);
    for (let vv = 0; vv < printed.vertexCount; vv++) {
      const nb = allIdx.nearest(printed.getPos(vv), 10);
      writeWeights(printed.skin, printed.weight, vv, nb >= 0 ? weightsOf(mesh, nb) : new Map([[bi("chest"), 1]]));
    }
    decalMesh.append(printed);
  }

  /* ---------- collier ---------- */
  if ((look.jewelry === "necklace" || look.jewelry === "all") && look.collar !== "turtle" && !crowd) {
    const neck = buildNecklace(k, field, H, cell, v.fork("collier"));
    if (neck.vertexCount) {
      neck.skin = new Array(neck.vertexCount * 4).fill(0);
      neck.weight = new Array(neck.vertexCount * 4).fill(0);
      for (let vv = 0; vv < neck.vertexCount; vv++) {
        const nb = allIdx.nearest(neck.getPos(vv), 10);
        writeWeights(neck.skin, neck.weight, vv, nb >= 0 ? weightsOf(mesh, nb) : new Map([[bi("chest"), 1]]));
      }
      decalMesh.append(neck);
    }
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
  const faceBase = mesh.vertexCount;
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
  return { mesh, skeleton: skel, anchors, footprint: { hx, hz: H * 0.09, r: Math.max(hx, H * 0.12) }, height: bb.max[1], soft: [...bf.soft, ...hf.soft], ...(face.expr ? { expr: joinExpr(face.expr, faceBase, face.mesh.vertexCount, hands, handMorphs) } : {}) };
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

/**
 * Lettres imprimées sur le torse : texte du devant (et petit numéro), nom et grand numéro au dos. Chaque point du plan
 * du texte est projeté sur le vêtement par un rayon horizontal (de face pour le devant, de dos pour le dos), puis
 * décollé d'un cheveu ; le devant se lit de face, le dos de dos.
 */
function printTop(look: Look, bf: ReturnType<typeof buildBodyField>, field: Field, H: number, cell: number, P: Proportions): Mesh {
  const out = new Mesh();
  if (!look.printFront && !look.printName && !look.printNumber) return out;
  const { chestC, chestR } = bf;
  const lift = H * 0.001;
  const role = ROLE.yellow;
  const zFar = chestR[2] * 3 + H * 0.2;
  const surf = (side: 1 | -1) => (q: P2): SurfacePoint => {
    const x = side * q[0];
    // marche prudente puis dichotomie sur le passage du zéro (la distance du champ n'est qu'approchée : un pas plein
    // peut s'enfoncer de plusieurs centimètres)
    const z0 = chestC[2] + side * zFar;
    const d = (t: number) => field.distance([x, q[1], z0 - side * t]);
    let t0 = 0, t = 0, dt = d(0);
    while (dt > H * 0.0004 && t < zFar * 2) {
      t0 = t;
      t += Math.max(dt * 0.5, H * 0.0004);
      dt = d(t);
    }
    if (t >= zFar * 2) return null;
    let a = t0, b = t;
    for (let i = 0; i < 14; i++) {
      const mid = (a + b) / 2;
      if (d(mid) > 0) a = mid;
      else b = mid;
    }
    const p: V3 = [x, q[1], z0 - side * a];
    const n = field.gradient(p, H * 0.004);
    if (n[2] * side < 0.25) return null;
    return { p: madd(p, n, lift), n };
  };
  const put = (text0: string, side: 1 | -1, cx: number, cy: number, cap: number, maxW: number, maxH: number, weight: number) => {
    const font = look.printFont;
    const text = balanceLines(text0, maxW / Math.max(1e-6, maxH), weight, font);
    const lay = layoutText(text, { weight, leading: 1.35, font });
    let c = cap;
    if ((lay.width + weight * 2) * c > maxW) c = maxW / (lay.width + weight * 2);
    if ((lay.height + weight * 2) * c > maxH) c = maxH / (lay.height + weight * 2);
    const oy = (lay.height - 1) / 2 - 0.5;
    const tr = (l: P2[][]) => l.map((pl) => pl.map(([x, y]) => [cx + x * c, cy + (y + oy) * c] as P2));
    const seg = Math.max(cell * 0.7, H * 0.006);
    out.append(printMesh(tr(lay.polys), weight * c, surf(side), role, seg));
    if (lay.icons.length) out.append(printMesh(tr(lay.icons), lay.iconHW * c, surf(side), role, seg));
    if (lay.fills.length) out.append(printFills(tr(lay.fills), surf(side), role, seg));
    return c * (lay.height + weight * 2);
  };
  const maxW = Math.max(chestR[0] * 1.35, P.shoulderHalf * 1.25);
  const top = P.shoulderY - H * 0.035;
  const waist = P.hipY + H * 0.05;
  const coveredFront = look.over === "apron" || look.over === "armor";
  if (!coveredFront) {
    const hasNum = !!look.printNumber;
    if (look.printFront) {
      const cy = hasNum ? chestC[1] + chestR[1] * 0.22 : chestC[1] - chestR[1] * 0.05;
      put(look.printFront, 1, 0, cy, H * 0.042, maxW, hasNum ? chestR[1] * 0.55 : chestR[1] * 1.1, 0.13);
      if (hasNum) put(look.printNumber!, 1, 0, chestC[1] - chestR[1] * 0.38, H * 0.04, maxW * 0.5, chestR[1] * 0.45, 0.14);
    } else if (hasNum) put(look.printNumber!, 1, chestR[0] * 0.32, chestC[1] + chestR[1] * 0.05, H * 0.038, maxW * 0.4, chestR[1] * 0.4, 0.14);
  }
  // dos : nom sous le col, grand numéro dessous
  let y = top;
  if (look.printName) {
    const cap = H * 0.03;
    const h = put(look.printName, -1, 0, y - cap * 0.6, cap, maxW * 0.95, H * 0.04, 0.13);
    y -= h + H * 0.018;
  }
  if (look.printNumber) {
    const avail = Math.max(H * 0.05, y - waist);
    const cap = Math.min(H * 0.115, avail * 0.82);
    put(look.printNumber, -1, 0, y - cap * 0.55, cap, maxW * 0.9, avail, 0.13);
  }
  return out;
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

/**
 * Morphs du visage et des mains sur une seule plage (visage, puis main gauche, puis main droite, contigus dans le
 * maillage) : canaux du visage, puis `fist.l`, `open.l`, `point.l`, `fist.r`, `open.r`, `point.r` (nuls pour une main
 * qui tient un objet : sa prise reste fermée).
 */
function joinExpr(face: NonNullable<Asset["expr"]> | { count: number; channels: readonly string[]; data: Float32Array }, base: number, faceVerts: number, hands: Mesh[], morphs: (Record<HandMorph, Float32Array> | null)[]): NonNullable<Asset["expr"]> {
  const sides = ["l", "r"];
  const channels = [...face.channels, ...sides.flatMap((s) => HAND_MORPHS.map((m) => `${m}.${s}`))];
  const count = faceVerts + hands.reduce((n, h) => n + h.vertexCount, 0);
  const data = new Float32Array(channels.length * count * 3);
  face.channels.forEach((_, c) => data.set(face.data.subarray(c * face.count * 3, (c + 1) * face.count * 3), c * count * 3));
  let off = faceVerts;
  hands.forEach((h, k) => {
    const m = morphs[k];
    if (m)
      HAND_MORPHS.forEach((name, j) => {
        const c = face.channels.length + k * HAND_MORPHS.length + j;
        data.set(m[name], (c * count + off) * 3);
      });
    off += h.vertexCount;
  });
  return { base, count, channels, data };
}

/**
 * Collier : chaîne qui épouse la base du cou (lancers de rayon vers l'axe du cou, sur la peau ou le col), plus basse
 * devant, avec un pendentif ; en métal.
 */
function buildNecklace(k: ReturnType<typeof characterKit>["k"], field: Field, H: number, cell: number, r: Rng): Mesh {
  const out = new Mesh();
  // encolure ouverte (débardeur, robe, torse nu) : chaîne longue à pendentif ; haut fermé : collier court au-dessus du
  // col (une chaîne longue passerait sous le tissu, seul le pendentif dépasserait)
  const open = k.look.top === "tank" || k.look.top === "dress" || k.look.top === "none";
  const base = k.at("neck", open ? 0.42 : 0.62);
  const nr = k.rad("neck", 0);
  const R = nr * 2.6;
  const drop = H * (open ? r.range(0.05, 0.075) : r.range(0.008, 0.014));
  const th = H * 0.0022;
  const pts: V3[] = [];
  const N = 28;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const dir: V3 = [Math.sin(a), 0, Math.cos(a)];
    // haut sur la nuque, descend en douceur jusqu'au creux de la poitrine devant (jamais sur l'épaule)
    const y = base[1] - drop * ((1 + Math.cos(a)) / 2) ** 2.2;
    const o: V3 = [base[0] + dir[0] * R, y, base[2] + dir[2] * R];
    const hitP = field.raycast(o, [-dir[0], 0, -dir[2]], R, H * 0.0005);
    if (!hitP) return out;
    // posée sur le tissu : le maillage polygonisé (puis lissé) s'écarte du champ jusqu'à une demi-cellule
    pts.push(madd(hitP, dir, th * 1.6 + cell * (open ? 0.45 : 0.12)));
  }
  // tracé lissé (une chaîne tombe en courbe ; les lancers de rayon sautent d'une surface à l'autre)
  for (let it = 0; it < 4; it++) {
    const prev = pts.map((p) => [...p] as V3);
    for (let i = 1; i < pts.length - 1; i++) for (let c = 0; c < 3; c++) pts[i][c] = (prev[i - 1][c] + prev[i][c] * 2 + prev[i + 1][c]) / 4;
  }
  out.append(tube(pts, pts.map(() => th), ROLE.orange, 5, false, false));
  if (!open) return out;
  // pendentif : goutte au point le plus bas
  const front = pts[0];
  const pend = ellipsoid(H * 0.0045, H * 0.007, H * 0.0025, ROLE.orange, 10, 6);
  pend.transform(m4Compose([front[0], front[1] - H * 0.007, front[2] + th], qId()));
  out.append(pend);
  return out;
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
