/**
 * Mains : paume, quatre doigts à trois phalanges et pouce, en champ implicite polygonisé finement dans un repère
 * normalisé (x = côté du pouce, y = direction des doigts, z = normale de la paume ; longueur de main = 1), puis posé au
 * poignet. Le gabarit ne dépend que de la pose et de quelques rapports : il est mis en cache et partagé par la foule.
 *
 * Poses : `relax` (doigts légèrement fléchis) et `grip` (doigts **enroulés** autour d'un manche : chaque phalange est
 * posée sur le cercle du manche par intersection de cercles, le pouce referme la prise par-dessus).
 */
import { type V3, add, cross, dot, len, madd, norm, qFromTo, qRot, scale, sub } from "../../core/math";
import { type Blend, Field, type FieldPrim, polygonize } from "../../geom/implicit";
import { Mesh } from "../../geom/mesh";
import type { PrimIn } from "./kit";

export type HandPose = "relax" | "grip";
/** Poses jouées en morph sur la main relâchée (même maillage, sommets déplacés avec leur phalange). */
export const HAND_MORPHS = ["fist", "open", "point"] as const;
export type HandMorph = (typeof HAND_MORPHS)[number];
/** `morphs` : décalages par pose dans le repère normalisé de la main (main relâchée seulement). */
export type HandTemplate = { mesh: Mesh; grip: V3; morphs?: Record<HandMorph, Float32Array> };

/** Flexion (°) des trois phalanges de chaque doigt (index → auriculaire) et écart des doigts, par pose. */
type FingerPose = { curl: number[][]; splay: number; thumb: [V3, V3, V3] };
// pouce au repos : le long de l'index, un peu en avant de la paume (pas écarté à l'horizontale)
const RELAX: FingerPose = { curl: [[10, 14, 8], [14, 18, 10], [18, 24, 12], [24, 30, 16]], splay: 1.3, thumb: [[0.42, 0.72, 0.55], [0.2, 0.84, 0.5], [0.08, 0.9, 0.42]] };
const FIST_CURL = [78, 96, 66];
const FIST_THUMB: [V3, V3, V3] = [[0.35, 0.45, 0.82], [-0.5, 0.38, 0.78], [-0.88, 0.05, 0.47]];
const POSES: Record<HandMorph, FingerPose> = {
  fist: { curl: [FIST_CURL, FIST_CURL, FIST_CURL, FIST_CURL], splay: 0.3, thumb: FIST_THUMB },
  open: { curl: [[0, 2, 1], [0, 2, 1], [0, 3, 1], [2, 4, 2]], splay: 2.4, thumb: [[0.7, 0.55, 0.35], [0.62, 0.7, 0.25], [0.5, 0.82, 0.2]] },
  point: { curl: [[2, 4, 2], FIST_CURL, FIST_CURL, FIST_CURL], splay: 0.4, thumb: FIST_THUMB },
};

const cache = new Map<string, HandTemplate>();

/** Gabarit de main normalisé. `rw` = rayon du poignet / longueur de main ; `ro` = rayon du manche / longueur. */
export function handTemplate(pose: HandPose, rw: number, ro: number, role: number, fine: boolean, chunky: number, wristDir: V3 = [0, -1, 0]): HandTemplate {
  const wd = norm(wristDir);
  const key = `${pose}|${rw.toFixed(2)}|${ro.toFixed(2)}|${role}|${fine}|${chunky.toFixed(2)}|${wd.map((x) => x.toFixed(1)).join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const prims: FieldPrim[] = [];
  const blends: Blend[] = [];
  const P = (f: PrimIn) => (prims.push({ ...f, role, tag: 0 } as FieldPrim), prims.length - 1);
  // paume : demi-largeur ≈ 0,23 longueur de main (une main réelle), jamais plus étroite que le poignet
  const pwh = Math.max(rw * 0.95, 0.23) * chunky;
  const pth = rw * 0.5;
  // poignet : le long de l'avant-bras (le poignet peut être fléchi : main tendue vers l'avant pour tenir un manche droit)
  const wrist = P({ kind: "capsule", a: scale(wd, 0.24), b: [0, 0.04, 0], ra: rw * 0.9, rb: rw * 0.85 });
  const palm = P({ kind: "box", c: [0, 0.22, 0], h: [pwh * 0.92, 0.2, pth * 0.85], round: pth * 0.8 });
  blends.push({ a: wrist, b: palm, k: rw * 0.55 });
  const spacing = (2 * pwh * 0.92) / 4;
  // doigts un peu plus fins que leur écartement : séparés au maillage (sinon soudés, puis étirés en palmure)
  const rf = spacing * 0.5 * 0.8;
  const fx = [0.75, 0.25, -0.25, -0.75].map((x) => x * pwh * 0.92);
  const fy = [0.41, 0.425, 0.41, 0.385];
  const fl = [0.47, 0.52, 0.49, 0.39].map((x) => x * (1 - rf * 0.6));
  const fr = [rf, rf, rf * 0.97, rf * 0.84];
  const seg = [0.45, 0.3, 0.25];
  const splay = [5, 1, -3, -8];
  /** Articulations d'un doigt pour une pose (base, puis bout de chaque phalange). */
  const fingerPts = (f: number, fp: FingerPose): V3[] => {
    const pts: V3[] = [[fx[f], fy[f], pth * 0.12]];
    const sp = (splay[f] * fp.splay * Math.PI) / 180;
    let dir = norm([Math.sin(sp), Math.cos(sp), 0]);
    let p = pts[0];
    for (let s = 0; s < 3; s++) {
      dir = rotX(dir, (fp.curl[f][s] * Math.PI) / 180);
      p = madd(p, dir, fl[f] * seg[s]);
      pts.push(p);
    }
    return pts;
  };
  /** Pouce : métacarpe (éminence thénar) + deux phalanges. */
  const cmc: V3 = [pwh * 0.7, 0.07, pth * 0.35];
  const thumbPts = (fp: FingerPose): V3[] => {
    const m1 = madd(cmc, norm(fp.thumb[0]), 0.25);
    const m2 = madd(m1, norm(fp.thumb[1]), 0.17);
    return [cmc, m1, m2, madd(m2, norm(fp.thumb[2]), 0.15)];
  };
  // phalanges posées : primitive → (chaîne, rang) pour les morphs
  const segOf = new Map<number, { c: number; s: number }>();
  // prise : cercle du manche dans le plan (y, z)
  const C: [number, number] = [0.37, pth + ro];
  const R = (r: number) => ro + r * 0.98;
  const chain = (pts: V3[], radii: number[], first: number, c = -1) => {
    let prev = first;
    for (let i = 0; i < pts.length - 1; i++) {
      const id = P({ kind: "capsule", a: pts[i], b: pts[i + 1], ra: radii[i], rb: radii[i + 1] });
      if (c >= 0) segOf.set(id, { c, s: i });
      blends.push({ a: prev, b: id, k: (radii[i] ?? rf) * (i === 0 ? 0.55 : 0.35) });
      prev = id;
    }
  };
  for (let f = 0; f < 4; f++) {
    const base: V3 = [fx[f], fy[f], pth * 0.12];
    let pts: V3[] = [base];
    const rr = [fr[f] * 1.02, fr[f], fr[f] * 0.94, fr[f] * 0.86];
    if (pose === "relax") pts = fingerPts(f, RELAX);
    else {
      let p2: [number, number] = [base[1], base[2]];
      let phi = Math.atan2(p2[1] - C[1], p2[0] - C[0]);
      for (let s = 0; s < 3; s++) {
        const q = wrap(p2, fl[f] * seg[s], C, R(rr[s + 1]), phi, 1);
        phi = q.phi;
        p2 = q.p;
        pts.push([fx[f] * (1 - 0.06 * (s + 1)), p2[0], p2[1]]);
      }
    }
    chain(pts, rr, palm, f);
  }
  const rt = rf * 1.08;
  const m1 = madd(cmc, norm([0.45, 0.45, 0.77]), 0.25);
  let tp: V3[] = [cmc, m1];
  if (pose === "relax") tp = thumbPts(RELAX);
  else {
    let p2: [number, number] = [m1[1], m1[2]];
    let phi = Math.atan2(p2[1] - C[1], p2[0] - C[0]);
    for (const l of [0.17, 0.15]) {
      const q = wrap(p2, l, C, R(rt), phi, -1);
      phi = q.phi;
      p2 = q.p;
      tp.push([m1[0] + (tp.length - 1) * rf * 0.15, p2[0], p2[1]]);
    }
  }
  chain(tp, [rt * 1.35, rt * 1.15, rt, rt * 0.9], palm, 4);
  const field = new Field(prims, blends);
  const cell = rf * (fine ? 0.5 : 1.3);
  const { mesh, owner } = polygonize(field, { cell, smooth: 2, ao: true, margin: cell * 2, aoSteps: 3, exactOwner: pose === "relax" });
  const out: HandTemplate = { mesh, grip: [0, C[0], C[1]] as V3 };
  if (pose === "relax") {
    const rest = [0, 1, 2, 3].map((f) => fingerPts(f, RELAX)).concat([thumbPts(RELAX)]);
    out.morphs = Object.fromEntries(
      HAND_MORPHS.map((name) => {
        const tgt = [0, 1, 2, 3].map((f) => fingerPts(f, POSES[name])).concat([thumbPts(POSES[name])]);
        return [name, poseDeltas(mesh, owner, segOf, rest, tgt)];
      }),
    ) as Record<HandMorph, Float32Array>;
  }
  cache.set(key, out);
  if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  return out;
}

/**
 * Décalages d'une pose : chaque sommet suit sa phalange (rotation de son axe repos → pose, autour de l'articulation de
 * départ replacée), fondu avec la phalange voisine près des articulations ; paume et poignet ne bougent pas.
 */
function poseDeltas(mesh: Mesh, owner: Int32Array, segOf: Map<number, { c: number; s: number }>, rest: V3[][], tgt: V3[][]): Float32Array {
  const out = new Float32Array(mesh.vertexCount * 3);
  const move = (c: number, s: number, v: V3): V3 => {
    if (s < 0) return v;
    const a = rest[c][s], b = rest[c][s + 1], a2 = tgt[c][s], b2 = tgt[c][s + 1];
    return add(a2, qRot(qFromTo(norm(sub(b, a)), norm(sub(b2, a2))), sub(v, a)));
  };
  const mix3 = (p: V3, q: V3, w: number): V3 => [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w, p[2] + (q[2] - p[2]) * w];
  for (let i = 0; i < mesh.vertexCount; i++) {
    const sg = segOf.get(owner[i]);
    if (!sg) continue;
    const v = mesh.getPos(i);
    const { c, s } = sg;
    const a = rest[c][s], b = rest[c][s + 1];
    const ab = sub(b, a);
    const t = Math.min(1, Math.max(0, dot(sub(v, a), ab) / Math.max(1e-9, dot(ab, ab))));
    const own = move(c, s, v);
    let p = own;
    // première phalange : fondue avec la paume ; base du pouce (éminence) encore plus ancrée, sinon elle se retourne
    if (s === 0) p = mix3(v, own, smooth01(t / (c === 4 ? 0.7 : 0.35)) * (c === 4 ? 0.7 : 1));
    else if (t < 0.25) p = mix3(move(c, s - 1, v), own, 0.5 + 2 * t);
    if (s < 2 && t > 0.75) p = mix3(p, move(c, s + 1, v), (t - 0.75) * 2);
    out[i * 3] = p[0] - v[0];
    out[i * 3 + 1] = p[1] - v[1];
    out[i * 3 + 2] = p[2] - v[2];
  }
  return out;
}

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Point suivant d'une phalange posée sur le cercle (C, R) : intersection de cercles, dans le sens d'enroulement. */
function wrap(p: [number, number], l: number, C: [number, number], R: number, phi: number, sense: 1 | -1): { p: [number, number]; phi: number } {
  const dx = C[0] - p[0], dy = C[1] - p[1];
  const d = Math.hypot(dx, dy);
  if (d > R + l || d < Math.abs(R - l) || d < 1e-9) {
    // hors d'atteinte : on avance vers le manche
    const q: [number, number] = [p[0] + (dx / d) * l, p[1] + (dy / d) * l];
    return { p: q, phi: Math.atan2(q[1] - C[1], q[0] - C[0]) };
  }
  const a = (l * l - R * R + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l * l - a * a));
  const mx = p[0] + (a * dx) / d, my = p[1] + (a * dy) / d;
  const c1: [number, number] = [mx + (h * dy) / d, my - (h * dx) / d];
  const c2: [number, number] = [mx - (h * dy) / d, my + (h * dx) / d];
  const ang = (q: [number, number]) => {
    let a2 = Math.atan2(q[1] - C[1], q[0] - C[0]);
    while (a2 - phi < -Math.PI) a2 += 2 * Math.PI;
    while (a2 - phi > Math.PI) a2 -= 2 * Math.PI;
    return a2;
  };
  const a1 = ang(c1), a2 = ang(c2);
  return sense > 0 ? (a1 > a2 ? { p: c1, phi: a1 } : { p: c2, phi: a2 }) : a1 < a2 ? { p: c1, phi: a1 } : { p: c2, phi: a2 };
}

function rotX(v: V3, a: number): V3 {
  // rotation autour de x qui amène y vers z (flexion vers la paume)
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

/**
 * Pose un gabarit au poignet : repère (t = côté pouce, d = doigts, n = paume), échelle `L`. Rend la main en coordonnées
 * du modèle et la position de la prise. Un repère indirect (main gauche/droite en miroir) inverse l'ordre des triangles.
 */
export function placeHand(tpl: HandTemplate, origin: V3, t: V3, d: V3, n: V3, L: number): { mesh: Mesh; grip: V3; morphs?: Record<HandMorph, Float32Array> } {
  const src = tpl.mesh;
  const m = new Mesh();
  const tr = (p: V3): V3 => add(origin, add(add(scale(t, p[0] * L), scale(d, p[1] * L)), scale(n, p[2] * L)));
  for (let i = 0; i < src.vertexCount; i++) {
    const p = src.getPos(i), q = src.getNrm(i);
    const nn = add(add(scale(t, q[0]), scale(d, q[1])), scale(n, q[2]));
    const v = m.vertex(tr(p), len(nn) > 1e-9 ? norm(nn) : [0, 1, 0], src.role[i], src.ao[i]);
    m.obj[v] = 0;
  }
  const flip = dot(t, cross(d, n)) < 0;
  for (let k = 0; k < src.idx.length; k += 3) {
    const a = src.idx[k], b = src.idx[k + 1], c = src.idx[k + 2];
    if (flip) m.tri(a, c, b);
    else m.tri(a, b, c);
  }
  // morphs : vecteurs, sans translation
  const morphs = tpl.morphs
    ? (Object.fromEntries(
        HAND_MORPHS.map((k) => {
          const src2 = tpl.morphs![k], o = new Float32Array(src2.length);
          for (let i = 0; i < src2.length; i += 3) {
            const q = add(add(scale(t, src2[i] * L), scale(d, src2[i + 1] * L)), scale(n, src2[i + 2] * L));
            (o[i] = q[0]), (o[i + 1] = q[1]), (o[i + 2] = q[2]);
          }
          return [k, o];
        }),
      ) as Record<HandMorph, Float32Array>)
    : undefined;
  return { mesh: m, grip: tr(tpl.grip), ...(morphs ? { morphs } : {}) };
}

/** Repère de la main au repos à partir de la direction des doigts et du côté (1 = gauche, -1 = droite). */
export function handFrame(d: V3, side: 1 | -1, thumbHint: V3): { t: V3; n: V3 } {
  const t = norm(sub(thumbHint, scale(d, dot(thumbHint, d))));
  // main gauche : t = n × d  ⇒  n = d × t ; main droite en miroir
  const n = side > 0 ? cross(d, t) : scale(cross(d, t), -1);
  return { t, n: norm(n) };
}


