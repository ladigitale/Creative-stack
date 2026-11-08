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
  /** Roule en tournant (sphère ronde) ; les ovales et les ballons écrasés glissent sans culbuter. */
  roll: boolean;
};

export type BallActor = { id: string; pos: V3; vel: V3; r: number; h: number };
export type BallEvent = { type: "kick" | "hit" | "rest" | "enter" | "leave"; payload: Record<string, unknown> };

const G = 9.81;
export const MAX_SPEED = 40;
/** Déplacement maximal par sous-pas (m) : moins qu'une case de navigation, pour ne pas traverser un mur. */
const MAX_MOVE = 0.15;

export class BallWorld {
  readonly bodies: BallBody[] = [];
  readonly byId = new Map<string, BallBody>();
  readonly byObj = new Map<number, BallBody>();
  private half: [number, number];
  private touching = new Set<string>();
  private zones: Zone[];
  private inZone = new Map<string, Set<string>>();
  /** Ballons cachés (`hidden`) : hors simulation, sans événement. */
  hidden = new Set<string>();

  constructor(model: SceneModel) {
    this.half = [model.size[0] / 2, model.size[1] / 2];
    this.zones = model.zones ?? [];
    for (const o of model.objects) if (o.generator === "ball" && o.mode !== "actor") this.add(o);
    // zones où un ballon se trouve déjà au départ : pas d'`enter` au premier coup
    for (const b of this.bodies) this.inZone.set(b.id, new Set(this.zones.filter((zn) => this.inside(zn, b.pos)).map((zn) => zn.id)));
  }

  private inside(zn: Zone, p: V3) {
    return zn.box ? p[0] >= zn.box[0] && p[0] <= zn.box[2] && p[2] >= zn.box[1] && p[2] <= zn.box[3] : Math.hypot(p[0] - zn.x, p[2] - zn.z) <= zn.r;
  }

  get count() {
    return this.bodies.length;
  }

  get moving() {
    return this.bodies.some((b) => b.awake);
  }

  private add(o: ObjectInfo) {
    const ph = (o.physics ?? {}) as { shape?: string; radius?: number; restitution?: number; friction?: number; mass?: number };
    const c = o.anchors.center ?? [o.pos[0], o.pos[1] + o.height / 2, o.pos[2]];
    const r0 = Math.max(0.005, (ph.radius ?? o.height / 2 / o.scale) * o.scale);
    // hauteur du centre au-dessus du sol (ballon écrasé, ovale couché) : sinon il « sauterait » au réveil
    const hc = c[1] - o.pos[1];
    const r = hc > 0.003 && hc < r0 * 1.05 ? hc : r0;
    const roll = ph.shape !== "ellipsoid" && r > r0 * 0.97;
    const b: BallBody = { id: o.id, obj: o.obj, pos: [...c], vel: [0, 0, 0], spin: [0, 0, 0, 1], r, e: ph.restitution ?? 0.6, mu: ph.friction ?? 0.5, mass: (ph.mass ?? 0.4) * o.scale ** 3, c0: [...c], awake: false, grounded: true, roll };
    this.bodies.push(b);
    this.byId.set(o.id, b);
    this.byObj.set(o.obj, b);
  }

  /** Coup : vitesse ajoutée (m/s), norme bornée à 40 m/s. */
  kick(id: string, v: V3): boolean {
    const b = this.byId.get(id);
    if (!b || this.hidden.has(id)) return false;
    for (let i = 0; i < 3; i++) b.vel[i] += Number.isFinite(v[i]) ? Math.max(-1e3, Math.min(1e3, v[i])) : 0;
    const s = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
    if (s > MAX_SPEED) for (let i = 0; i < 3; i++) b.vel[i] *= MAX_SPEED / s;
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
      if (this.hidden.has(b.id)) continue;
      for (const a of actors) {
        const dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2];
        const d = Math.hypot(dx, dz), min = b.r + a.r;
        const key = `${a.id}|${b.id}`;
        if (d < min && b.pos[1] - b.r < a.pos[1] + a.h) {
          const nx = d > 1e-5 ? dx / d : 1, nz = d > 1e-5 ? dz / d : 0;
          // sortie du contact et poussée : la vitesse de l'acteur vers le ballon, un peu amplifiée (petit coup de pied)
          this.moveTo(b, a.pos[0] + nx * min, a.pos[2] + nz * min, free);
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
        } else if (d > min + 0.03) this.touching.delete(key);
      }
    }
    let vmax = 0;
    for (const b of this.bodies) if (b.awake) vmax = Math.max(vmax, Math.hypot(b.vel[0], b.vel[1], b.vel[2]));
    const n = Math.min(64, Math.max(1, Math.ceil(dt / (1 / 120)), Math.ceil((vmax * dt) / MAX_MOVE)));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      for (const b of this.bodies) if (b.awake && !this.hidden.has(b.id)) this.integrate(b, h, height, free);
      this.collide(free);
    }
    for (const b of this.bodies) {
      if (!b.awake || this.hidden.has(b.id)) continue;
      // zones (buts, cibles) : entrée et sortie d'un ballon
      if (this.zones.length) {
        const cur = this.inZone.get(b.id) ?? new Set<string>();
        for (const zn of this.zones) {
          const inside = this.inside(zn, b.pos);
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
    // obstacles (bâtiments, murs, troncs) : rebond sur l'axe bloqué ; un ballon déjà dans une case bloquée
    // (posé sur un meuble, poussé dedans) peut en sortir
    if (free(px, pz) && !free(nx, nz)) {
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
        if (Math.sign(v) * b.vel[i] > 0) b.vel[i] = -b.vel[i] * b.e;
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
    if (b.roll && v > 1e-4) b.spin = qNorm(qMul(qAxis([vz / v, 0, -vx / v], (v / b.r) * h), b.spin));
  }

  /** Déplacement imposé (poussée, séparation) : refusé s'il entre dans un obstacle ou sort de la scène. */
  private moveTo(b: BallBody, x: number, z: number, free: (x: number, z: number) => boolean) {
    if (Math.abs(x) > this.half[0] - b.r || Math.abs(z) > this.half[1] - b.r) return;
    if (free(b.pos[0], b.pos[2]) && !free(x, z)) return;
    b.pos[0] = x;
    b.pos[2] = z;
  }

  private collide(free: (x: number, z: number) => boolean) {
    const B = this.bodies;
    for (let i = 0; i < B.length; i++)
      for (let j = i + 1; j < B.length; j++) {
        const a = B[i], b = B[j];
        if (!a.awake && !b.awake) continue;
        if (this.hidden.has(a.id) || this.hidden.has(b.id)) continue;
        const d: V3 = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
        const l = Math.hypot(d[0], d[1], d[2]), min = a.r + b.r;
        if (l >= min) continue;
        const n: V3 = l > 1e-6 ? [d[0] / l, d[1] / l, d[2] / l] : [1, 0, 0];
        const rv = (b.vel[0] - a.vel[0]) * n[0] + (b.vel[1] - a.vel[1]) * n[1] + (b.vel[2] - a.vel[2]) * n[2];
        // ballon posé sur un autre (contact vertical lent) : choc mou
        const resting = Math.abs(n[1]) > 0.7 && -rv < 0.6;
        // le ballon du dessous, au sol ou endormi, porte celui du dessus comme le ferait le sol
        const lower = n[1] > 0 ? a : b;
        const pinned = resting && (lower.grounded || !lower.awake);
        const ia = pinned && lower === a ? 0 : 1 / a.mass, ib = pinned && lower === b ? 0 : 1 / b.mass;
        if (ia + ib === 0) continue;
        const over = (min - l) / (ia + ib);
        this.moveTo(a, a.pos[0] - n[0] * over * ia, a.pos[2] - n[2] * over * ia, free);
        this.moveTo(b, b.pos[0] + n[0] * over * ib, b.pos[2] + n[2] * over * ib, free);
        a.pos[1] -= n[1] * over * ia;
        b.pos[1] += n[1] * over * ib;
        if (resting) {
          if (n[1] > 0) b.grounded = true;
          else a.grounded = true;
        }
        if (rv >= 0) continue;
        const jimp = (-(1 + (resting ? 0 : Math.min(a.e, b.e))) * rv) / (ia + ib);
        for (let k = 0; k < 3; k++) {
          a.vel[k] -= jimp * ia * n[k];
          b.vel[k] += jimp * ib * n[k];
        }
        if (!resting) a.awake = b.awake = true;
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
    for (const b of this.bodies.slice(0, 200)) if (!this.hidden.has(b.id)) out[b.id] = { x: r3(b.pos[0]), y: r3(b.pos[1]), z: r3(b.pos[2]), moving: b.awake };
    return out;
  }
}
