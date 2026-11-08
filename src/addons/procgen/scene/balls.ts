/**
 * Ballons dynamiques (partagé par le rendu 3D et le rendu vectoriel) : chaque objet `ball` devient un corps
 * sphérique — gravité, rebond selon sa restitution, roulement sans glisser (rotation du motif), résistance au
 * roulement selon son frottement, rebond sur les obstacles de la grille de navigation et sur les bords de la scène,
 * chocs entre ballons, poussée par les acteurs (dribble). Un coup (`kick`) lui donne une vitesse.
 *
 * Coût : quelques opérations par ballon et par sous-pas ; les ballons au repos dorment.
 */
import { type M4, type Q, type V3, m4Compose, m4Mul, qAxis, qMul, qNorm } from "../core/math";
import type { ObjectInfo, SceneModel, Zone } from "./compose";

export type BallBody = {
  id: string;
  obj: number;
  /** Centre (monde). */
  pos: V3;
  vel: V3;
  /** Rotation accumulée (monde), appliquée autour du centre. */
  spin: Q;
  r: number;
  e: number;
  mu: number;
  mass: number;
  /** Centre et cap de départ (pour recomposer la matrice d'instance). */
  c0: V3;
  awake: boolean;
  grounded: boolean;
};

export type BallActor = { id: string; pos: V3; vel: V3; r: number; h: number };
export type BallEvent = { type: "kick" | "hit" | "rest" | "enter" | "leave"; payload: Record<string, unknown> };

const G = 9.81;

export class BallWorld {
  readonly bodies: BallBody[] = [];
  readonly byId = new Map<string, BallBody>();
  readonly byObj = new Map<number, BallBody>();
  private half: [number, number];
  private touching = new Set<string>();
  private zones: Zone[];
  private inZone = new Map<string, Set<string>>();

  constructor(model: SceneModel) {
    this.half = [model.size[0] / 2, model.size[1] / 2];
    this.zones = model.zones ?? [];
    for (const o of model.objects) if (o.generator === "ball" && o.mode !== "actor") this.add(o);
  }

  get count() {
    return this.bodies.length;
  }

  get moving() {
    return this.bodies.some((b) => b.awake);
  }

  private add(o: ObjectInfo) {
    const ph = (o.physics ?? {}) as { radius?: number; restitution?: number; friction?: number; mass?: number };
    const c = o.anchors.center ?? [o.pos[0], o.pos[1] + o.height / 2, o.pos[2]];
    const r = Math.max(0.005, (ph.radius ?? o.height / 2 / o.scale) * o.scale);
    const b: BallBody = { id: o.id, obj: o.obj, pos: [...c], vel: [0, 0, 0], spin: [0, 0, 0, 1], r, e: ph.restitution ?? 0.6, mu: ph.friction ?? 0.5, mass: (ph.mass ?? 0.4) * o.scale ** 3, c0: [...c], awake: false, grounded: true };
    this.bodies.push(b);
    this.byId.set(o.id, b);
    this.byObj.set(o.obj, b);
  }

  /** Coup : vitesse ajoutée (m/s). */
  kick(id: string, v: V3): boolean {
    const b = this.byId.get(id);
    if (!b) return false;
    const cap = 40;
    for (let i = 0; i < 3; i++) b.vel[i] = Math.max(-cap, Math.min(cap, b.vel[i] + (Number.isFinite(v[i]) ? v[i] : 0)));
    b.awake = true;
    return true;
  }

  /**
   * Avance la simulation de `dt` secondes. `height(x, z)` : sol ; `free(x, z)` : case franchissable ; `actors` :
   * personnages et animaux (position au sol, vitesse, rayon, hauteur).
   */
  step(dt: number, height: (x: number, z: number) => number, free: (x: number, z: number) => boolean, actors: BallActor[] = [], onEvent?: (e: BallEvent) => void) {
    if (!this.bodies.length || dt <= 0) return;
    // contacts acteurs : réveillent les ballons touchés
    for (const b of this.bodies) {
      for (const a of actors) {
        const dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2];
        const d = Math.hypot(dx, dz), min = b.r + a.r;
        const key = `${a.id}|${b.id}`;
        if (d < min && b.pos[1] - b.r < a.pos[1] + a.h) {
          const nx = d > 1e-5 ? dx / d : 1, nz = d > 1e-5 ? dz / d : 0;
          // sortie du contact et poussée : la vitesse de l'acteur vers le ballon, un peu amplifiée (petit coup de pied)
          b.pos[0] = a.pos[0] + nx * min;
          b.pos[2] = a.pos[2] + nz * min;
          const push = Math.max(0, a.vel[0] * nx + a.vel[2] * nz);
          const vn = b.vel[0] * nx + b.vel[2] * nz;
          const want = push * 1.35 + 0.15;
          if (vn < want) {
            b.vel[0] += (want - vn) * nx;
            b.vel[2] += (want - vn) * nz;
          }
          b.awake = true;
          if (!this.touching.has(key)) {
            this.touching.add(key);
            onEvent?.({ type: "hit", payload: { ball: b.id, actor: a.id } });
          }
        } else this.touching.delete(key);
      }
    }
    const n = Math.min(8, Math.max(1, Math.ceil(dt / (1 / 120))));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      for (const b of this.bodies) if (b.awake) this.integrate(b, h, height, free);
      this.collide();
    }
    for (const b of this.bodies) {
      if (!b.awake) continue;
      // zones (buts, cibles) : entrée et sortie d'un ballon
      if (this.zones.length) {
        const cur = this.inZone.get(b.id) ?? new Set<string>();
        for (const zn of this.zones) {
          const inside = zn.box ? b.pos[0] >= zn.box[0] && b.pos[0] <= zn.box[2] && b.pos[2] >= zn.box[1] && b.pos[2] <= zn.box[3] : Math.hypot(b.pos[0] - zn.x, b.pos[2] - zn.z) <= zn.r;
          if (inside && !cur.has(zn.id)) {
            cur.add(zn.id);
            onEvent?.({ type: "enter", payload: { zone: zn.id, ball: b.id, actor: null } });
          } else if (!inside && cur.has(zn.id)) {
            cur.delete(zn.id);
            onEvent?.({ type: "leave", payload: { zone: zn.id, ball: b.id, actor: null } });
          }
        }
        this.inZone.set(b.id, cur);
      }
      if (b.grounded && Math.hypot(b.vel[0], b.vel[1], b.vel[2]) < 0.03) {
        b.vel = [0, 0, 0];
        b.awake = false;
        const r3 = (x: number) => Math.round(x * 100) / 100;
        onEvent?.({ type: "rest", payload: { ball: b.id, x: r3(b.pos[0]), z: r3(b.pos[2]) } });
      }
    }
  }

  private integrate(b: BallBody, h: number, height: (x: number, z: number) => number, free: (x: number, z: number) => boolean) {
    b.vel[1] -= G * h;
    // résistance de l'air (faible) et au roulement (au sol)
    const sp = Math.hypot(b.vel[0], b.vel[2]);
    const drag = 0.02 * sp * h;
    let dec = drag;
    if (b.grounded) dec += G * (0.05 + 0.15 * b.mu) * h;
    if (sp > 1e-6) {
      const k = Math.max(0, sp - dec) / sp;
      b.vel[0] *= k;
      b.vel[2] *= k;
    }
    const px = b.pos[0], pz = b.pos[2];
    let nx = px + b.vel[0] * h, nz = pz + b.vel[2] * h;
    // obstacles (bâtiments, murs, troncs) : rebond sur l'axe bloqué
    if (!free(nx, nz)) {
      if (free(nx, pz)) {
        nz = pz;
        b.vel[2] = -b.vel[2] * b.e;
      } else if (free(px, nz)) {
        nx = px;
        b.vel[0] = -b.vel[0] * b.e;
      } else {
        nx = px;
        nz = pz;
        b.vel[0] = -b.vel[0] * b.e;
        b.vel[2] = -b.vel[2] * b.e;
      }
    }
    // bords de la scène
    for (const [i, lim] of [[0, this.half[0]], [2, this.half[1]]] as const) {
      const v = i === 0 ? nx : nz;
      if (Math.abs(v) > lim - b.r) {
        const c = Math.sign(v) * (lim - b.r);
        if (i === 0) nx = c;
        else nz = c;
        b.vel[i] = -b.vel[i] * b.e;
      }
    }
    b.pos[0] = nx;
    b.pos[2] = nz;
    b.pos[1] += b.vel[1] * h;
    const gy = height(nx, nz) + b.r;
    b.grounded = false;
    if (b.pos[1] <= gy) {
      b.pos[1] = gy;
      if (b.vel[1] < -0.6) b.vel[1] = -b.vel[1] * b.e;
      else {
        b.vel[1] = 0;
        b.grounded = true;
      }
    }
    // roulement : ω = (haut × v) / r
    const vx = b.vel[0], vz = b.vel[2];
    const v = Math.hypot(vx, vz);
    if (v > 1e-4) b.spin = qNorm(qMul(qAxis([vz / v, 0, -vx / v], (v / b.r) * h), b.spin));
  }

  private collide() {
    const B = this.bodies;
    for (let i = 0; i < B.length; i++)
      for (let j = i + 1; j < B.length; j++) {
        const a = B[i], b = B[j];
        if (!a.awake && !b.awake) continue;
        const d: V3 = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
        const l = Math.hypot(d[0], d[1], d[2]), min = a.r + b.r;
        if (l >= min || l < 1e-6) continue;
        const n: V3 = [d[0] / l, d[1] / l, d[2] / l];
        const ia = 1 / a.mass, ib = 1 / b.mass;
        const over = (min - l) / (ia + ib);
        for (let k = 0; k < 3; k++) {
          a.pos[k] -= n[k] * over * ia;
          b.pos[k] += n[k] * over * ib;
        }
        const rv = (b.vel[0] - a.vel[0]) * n[0] + (b.vel[1] - a.vel[1]) * n[1] + (b.vel[2] - a.vel[2]) * n[2];
        if (rv >= 0) continue;
        const jimp = (-(1 + Math.min(a.e, b.e)) * rv) / (ia + ib);
        for (let k = 0; k < 3; k++) {
          a.vel[k] -= jimp * ia * n[k];
          b.vel[k] += jimp * ib * n[k];
        }
        a.awake = b.awake = true;
      }
  }

  /** Matrice d'instance courante à partir de la matrice de départ `m0` (rotation autour du centre, déplacement). */
  matrix(b: BallBody, m0: M4): M4 {
    const back = m4Compose([-b.c0[0], -b.c0[1], -b.c0[2]]);
    return m4Mul(m4Compose(b.pos, b.spin), m4Mul(back, m0));
  }

  /** État publié : positions arrondies et mouvement. */
  snapshot(): Record<string, { x: number; y: number; z: number; moving: boolean }> {
    const out: Record<string, { x: number; y: number; z: number; moving: boolean }> = {};
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    for (const b of this.bodies.slice(0, 200)) out[b.id] = { x: r3(b.pos[0]), y: r3(b.pos[1]), z: r3(b.pos[2]), moving: b.awake };
    return out;
  }
}
