/**
 * Squelette 3D : os nommés (tête = articulation, queue = extrémité, positions de repos en coordonnées du modèle),
 * pose = rotations locales par rapport au repos + translation de la racine.
 *
 * Convention : au repos, chaque os a une orientation **identité** dans le monde du modèle. Une rotation locale
 * s'exprime donc dans les axes du modèle au repos (x = gauche du personnage, y = haut, z = avant) : fléchir un coude,
 * c'est tourner l'avant-bras autour de x. La matrice de skinning d'un os vaut `W_os · T(-tête_repos)`.
 *
 * Contraintes en swing-twist : un cône autour de l'axe de l'os (`swing`, en degrés) et une plage de torsion (`twist`).
 */
import { type M4, type Q, type V3, DEG, clamp, dot, m4Compose, m4Mul, m4Point, m4Quat, norm, qAxis, qConj, qId, qMul, qNorm, qRot, scale, sub, len } from "../core/math";

export type BoneDef = {
  name: string;
  parent: string | null;
  head: V3;
  tail: V3;
  /** Rayon de la capsule d'appartenance aux deux bouts (poids, sélection, collisions). */
  radius: [number, number];
  /** Os déformant (reçoit des sommets) ; faux pour la racine, les cibles, les prises. */
  deform: boolean;
  /** Demi-angle du cône de swing autorisé (°) ; absent = libre. */
  swing?: number;
  /** Torsion autorisée autour de l'axe de l'os (°) [min, max]. */
  twist?: [number, number];
};

export type Pose = {
  /** Rotation locale par os (par rapport au repos) ; absente = repos. */
  rot: Record<string, Q>;
  /** Translation de la racine (monde du modèle). */
  root: V3;
  /** Orientation de la racine (lacet du personnage). */
  rootRot?: Q;
};

export class Skeleton {
  readonly bones: BoneDef[];
  readonly index: Record<string, number> = {};
  readonly parentIdx: number[];
  readonly children: number[][];
  readonly axis: V3[];
  readonly length: number[];

  constructor(defs: BoneDef[]) {
    // ordre topologique
    const byName = new Map(defs.map((d) => [d.name, d]));
    const out: BoneDef[] = [];
    const done = new Set<string>();
    const visit = (d: BoneDef, depth = 0) => {
      if (done.has(d.name) || depth > 64) return;
      if (d.parent && byName.has(d.parent)) visit(byName.get(d.parent)!, depth + 1);
      done.add(d.name);
      out.push(d);
    };
    defs.forEach((d) => visit(d));
    this.bones = out;
    out.forEach((b, i) => (this.index[b.name] = i));
    this.parentIdx = out.map((b) => (b.parent && b.parent in this.index ? this.index[b.parent] : -1));
    this.children = out.map(() => []);
    this.parentIdx.forEach((p, i) => p >= 0 && this.children[p].push(i));
    this.axis = out.map((b) => norm(sub(b.tail, b.head)));
    this.length = out.map((b) => len(sub(b.tail, b.head)));
  }

  get count() {
    return this.bones.length;
  }
  has(name: string) {
    return name in this.index;
  }
  bone(name: string): BoneDef | undefined {
    return this.bones[this.index[name]];
  }

  /** Matrices monde (modèle) de chaque os pour une pose. */
  world(pose: Pose): M4[] {
    const W: M4[] = new Array(this.count);
    const rq: Q[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const b = this.bones[i];
      const local = this.limit(i, pose.rot[b.name] ?? qId());
      const p = this.parentIdx[i];
      if (p < 0) {
        const rr = pose.rootRot ? qMul(pose.rootRot, local) : local;
        const headW = m4Point(m4Compose(pose.root, pose.rootRot ?? qId()), b.head);
        W[i] = m4Compose(headW, rr);
        rq[i] = rr;
      } else {
        const off = sub(b.head, this.bones[p].head);
        const headW = m4Point(W[p], off);
        rq[i] = qNorm(qMul(rq[p], local));
        W[i] = m4Compose(headW, rq[i]);
      }
    }
    return W;
  }

  /** Matrices de skinning (monde de la pose · inverse du repos). */
  skinMatrices(world: M4[]): M4[] {
    return world.map((w, i) => m4Mul(w, m4Compose(scale(this.bones[i].head, -1))));
  }

  /** Rotations monde (quaternions) issues des matrices monde. */
  worldQuats(world: M4[]): Q[] {
    return world.map(m4Quat);
  }

  /** Position monde de la tête / de la queue d'un os. */
  headOf(world: M4[], name: string): V3 {
    const i = this.index[name];
    return [world[i][12], world[i][13], world[i][14]];
  }
  tailOf(world: M4[], name: string): V3 {
    const i = this.index[name];
    return m4Point(world[i], sub(this.bones[i].tail, this.bones[i].head));
  }

  /** Applique les contraintes swing-twist à une rotation locale. */
  limit(i: number, q: Q): Q {
    const b = this.bones[i];
    if (b.swing === undefined && !b.twist) return q;
    const ax = this.axis[i];
    // décomposition swing-twist autour de l'axe de l'os
    const pr = dot([q[0], q[1], q[2]], ax);
    let twist: Q = qNorm([ax[0] * pr, ax[1] * pr, ax[2] * pr, q[3]]);
    if (twist[3] < 0) twist = [-twist[0], -twist[1], -twist[2], -twist[3]];
    let swing = qMul(q, qConj(twist));
    if (b.twist) {
      const ang = 2 * Math.atan2(dot([twist[0], twist[1], twist[2]], ax), twist[3]) / DEG;
      const c = clamp(ang, b.twist[0], b.twist[1]);
      if (c !== ang) twist = qAxis(ax, c * DEG);
    }
    if (b.swing !== undefined) {
      const w = clamp(swing[3], -1, 1);
      const ang = (2 * Math.acos(Math.abs(w))) / DEG;
      if (ang > b.swing) {
        const axis: V3 = [swing[0], swing[1], swing[2]];
        swing = qAxis(len(axis) > 1e-9 ? axis : [1, 0, 0], Math.sign(w || 1) * b.swing * DEG);
      }
    }
    return qNorm(qMul(swing, twist));
  }

  /** Rotation monde → rotation locale de l'os `i`, connaissant la rotation monde du parent. */
  static toLocal(parentWorld: Q, world: Q): Q {
    return qNorm(qMul(qConj(parentWorld), world));
  }
}

/** Quaternion dual (partie réelle, partie duale) d'une matrice rigide : skinning sans perte de volume. */
export function dualQuat(m: M4): [Q, Q] {
  const r = m4Quat(m);
  const t: V3 = [m[12], m[13], m[14]];
  // d = 0.5 · (t, 0) · r
  const d = qMul([t[0], t[1], t[2], 0], r);
  return [r, [d[0] * 0.5, d[1] * 0.5, d[2] * 0.5, d[3] * 0.5]];
}

/** Applique un mélange de quaternions duaux à un point (référence CPU du shader, utilisée par les tests). */
export function dqSkinPoint(p: V3, dqs: [Q, Q][], idx: number[], w: number[]): V3 {
  let r: Q = [0, 0, 0, 0];
  let d: Q = [0, 0, 0, 0];
  const r0 = dqs[idx[0]][0];
  for (let k = 0; k < idx.length; k++) {
    if (!w[k]) continue;
    const [qr, qd] = dqs[idx[k]];
    const s = (qr[0] * r0[0] + qr[1] * r0[1] + qr[2] * r0[2] + qr[3] * r0[3]) < 0 ? -w[k] : w[k];
    for (let c = 0; c < 4; c++) {
      r[c] += qr[c] * s;
      d[c] += qd[c] * s;
    }
  }
  const l = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
  r = [r[0] / l, r[1] / l, r[2] / l, r[3] / l];
  d = [d[0] / l, d[1] / l, d[2] / l, d[3] / l];
  const rp = qRot(r, p);
  // translation = 2 · d · conj(r)
  const t = qMul(d, qConj(r));
  return [rp[0] + 2 * t[0], rp[1] + 2 * t[1], rp[2] + 2 * t[2]];
}

/** Rotation qui envoie la base (a0, f0) sur (a1, f1) : aligne un os sur une direction en fixant son roulis. */
export function qFromBasis(a0: V3, f0: V3, a1: V3, f1: V3): Q {
  const basis = (a: V3, f: V3): [V3, V3, V3] => {
    const x = norm(a);
    const y = norm(sub(f, scale(x, dot(f, x))));
    const z: V3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    return [x, y, z];
  };
  const [x0, y0, z0] = basis(a0, f0);
  const [x1, y1, z1] = basis(a1, f1);
  // R = B1 · B0^T, en matrice colonne-major
  const m = new Float64Array(16);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) m[c * 4 + r] = x1[r] * x0[c] + y1[r] * y0[c] + z1[r] * z0[c];
  m[15] = 1;
  return m4Quat(m);
}

export { qRot };
