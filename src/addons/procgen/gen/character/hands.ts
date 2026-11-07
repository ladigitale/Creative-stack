/**
 * Mains : paume, quatre doigts à trois phalanges et pouce, en champ implicite polygonisé finement dans un repère
 * normalisé (x = côté du pouce, y = direction des doigts, z = normale de la paume ; longueur de main = 1), puis posé au
 * poignet. Le gabarit ne dépend que de la pose et de quelques rapports : il est mis en cache et partagé par la foule.
 *
 * Poses : `relax` (doigts légèrement fléchis) et `grip` (doigts **enroulés** autour d'un manche : chaque phalange est
 * posée sur le cercle du manche par intersection de cercles, le pouce referme la prise par-dessus).
 */
import { type V3, add, cross, dot, len, madd, norm, scale, sub } from "../../core/math";
import { type Blend, Field, type FieldPrim, polygonize } from "../../geom/implicit";
import { Mesh } from "../../geom/mesh";
import type { PrimIn } from "./kit";

export type HandPose = "relax" | "grip";
export type HandTemplate = { mesh: Mesh; grip: V3 };

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
  const pwh = rw * 0.95 * chunky;
  const pth = rw * 0.5;
  // poignet : le long de l'avant-bras (le poignet peut être fléchi : main tendue vers l'avant pour tenir un manche droit)
  const wrist = P({ kind: "capsule", a: scale(wd, 0.24), b: [0, 0.04, 0], ra: rw * 0.96, rb: rw * 0.88 });
  const palm = P({ kind: "box", c: [0, 0.22, 0], h: [pwh * 0.92, 0.2, pth * 0.85], round: pth * 0.8 });
  blends.push({ a: wrist, b: palm, k: rw * 0.55 });
  const spacing = (2 * pwh * 0.92) / 4;
  const rf = spacing * 0.5 * 0.97;
  const fx = [0.75, 0.25, -0.25, -0.75].map((x) => x * pwh * 0.92);
  const fy = [0.41, 0.425, 0.41, 0.385];
  const fl = [0.47, 0.52, 0.49, 0.39].map((x) => x * (1 - rf * 0.6));
  const fr = [rf, rf, rf * 0.97, rf * 0.84];
  const seg = [0.45, 0.3, 0.25];
  const relaxCurl = [[10, 14, 8], [14, 18, 10], [18, 24, 12], [24, 30, 16]];
  const splay = [5, 1, -3, -8];
  // prise : cercle du manche dans le plan (y, z)
  const C: [number, number] = [0.37, pth + ro];
  const R = (r: number) => ro + r * 0.98;
  const chain = (pts: V3[], radii: number[], first: number) => {
    let prev = first;
    for (let i = 0; i < pts.length - 1; i++) {
      const id = P({ kind: "capsule", a: pts[i], b: pts[i + 1], ra: radii[i], rb: radii[i + 1] });
      blends.push({ a: prev, b: id, k: (radii[i] ?? rf) * (i === 0 ? 0.55 : 0.35) });
      prev = id;
    }
  };
  for (let f = 0; f < 4; f++) {
    const base: V3 = [fx[f], fy[f], pth * 0.12];
    const pts: V3[] = [base];
    const rr = [fr[f] * 1.02, fr[f], fr[f] * 0.94, fr[f] * 0.86];
    if (pose === "relax") {
      let dir = norm([Math.sin((splay[f] * Math.PI) / 180), Math.cos((splay[f] * Math.PI) / 180), 0]);
      let p = base;
      for (let s = 0; s < 3; s++) {
        dir = rotX(dir, (relaxCurl[f][s] * Math.PI) / 180);
        p = madd(p, dir, fl[f] * seg[s]);
        pts.push(p);
      }
    } else {
      let p2: [number, number] = [base[1], base[2]];
      let phi = Math.atan2(p2[1] - C[1], p2[0] - C[0]);
      for (let s = 0; s < 3; s++) {
        const q = wrap(p2, fl[f] * seg[s], C, R(rr[s + 1]), phi, 1);
        phi = q.phi;
        p2 = q.p;
        pts.push([fx[f] * (1 - 0.06 * (s + 1)), p2[0], p2[1]]);
      }
    }
    chain(pts, rr, palm);
  }
  // pouce : métacarpe (éminence thénar) + deux phalanges
  const cmc: V3 = [pwh * 0.7, 0.07, pth * 0.35];
  const rt = rf * 1.08;
  const met = pose === "relax" ? norm([0.6, 0.6, 0.5]) : norm([0.45, 0.45, 0.77]);
  const m1 = madd(cmc, met, 0.25);
  const tp: V3[] = [cmc, m1];
  if (pose === "relax") {
    const d1 = norm([0.32, 0.78, 0.55]), d2 = norm([0.18, 0.86, 0.48]);
    const m2 = madd(m1, d1, 0.17);
    tp.push(m2, madd(m2, d2, 0.15));
  } else {
    let p2: [number, number] = [m1[1], m1[2]];
    let phi = Math.atan2(p2[1] - C[1], p2[0] - C[0]);
    for (const l of [0.17, 0.15]) {
      const q = wrap(p2, l, C, R(rt), phi, -1);
      phi = q.phi;
      p2 = q.p;
      tp.push([m1[0] + (tp.length - 1) * rf * 0.15, p2[0], p2[1]]);
    }
  }
  chain(tp, [rt * 1.35, rt * 1.15, rt, rt * 0.9], palm);
  const field = new Field(prims, blends);
  const cell = rf * (fine ? 0.7 : 1.3);
  const { mesh } = polygonize(field, { cell, smooth: 2, ao: true, margin: cell * 2, aoSteps: 3 });
  const out = { mesh, grip: [0, C[0], C[1]] as V3 };
  cache.set(key, out);
  if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  return out;
}

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
export function placeHand(tpl: HandTemplate, origin: V3, t: V3, d: V3, n: V3, L: number): { mesh: Mesh; grip: V3 } {
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
  return { mesh: m, grip: tr(tpl.grip) };
}

/** Repère de la main au repos à partir de la direction des doigts et du côté (1 = gauche, -1 = droite). */
export function handFrame(d: V3, side: 1 | -1, thumbHint: V3): { t: V3; n: V3 } {
  const t = norm(sub(thumbHint, scale(d, dot(thumbHint, d))));
  // main gauche : t = n × d  ⇒  n = d × t ; main droite en miroir
  const n = side > 0 ? cross(d, t) : scale(cross(d, t), -1);
  return { t, n: norm(n) };
}


