/**
 * Projections du mode vectoriel (monde 3D en mètres → plan du dessin, v vers le haut).
 *
 * - `side` (élévation) : u = x, v = y − lift·z. `lift` (0 … 0,4) relève légèrement les plans lointains, comme une
 *   élévation d'illustrateur où le sol se lit en bandes ; la profondeur sert à l'ordre de dessin et à l'atmosphère.
 * - `oblique` (cavalière) : u = x − k·cos(a)·z, v = y − k·sin(a)·z ; flancs droits et dessus visibles.
 * - `plongee` (vue d'en haut inclinée de `pitch` degrés, 90 = verticale) : u = x, v = cos(p)·y − sin(p)·z ; le
 *   dessus des têtes et des toits se lit, le plan du sol s'étale (jeux vus de dessus, plateaux).
 *
 * Les deux sont affines : une face plane dessinée dans son repère local se projette par une affine 2D, donc les
 * courbes de Bézier restent des Bézier. `viewDir` est la direction (vers l'observateur) qui s'écrase sur un point :
 * une face est visible si sa normale la regarde.
 */
import type { V3 } from "../core/math";
import { type Affine, type P2 } from "./shape";

export type VectorCamera = "side" | "oblique" | "plongee";

export class Projector {
  readonly camera: VectorCamera;
  readonly ax: number;
  readonly ay: number;
  /** Facteur de la hauteur dans v (1 sauf en plongée). */
  readonly cy: number;
  readonly dir: V3;
  zMin = -20;
  zMax = 20;

  constructor(camera: VectorCamera, opts: { lift?: number; k?: number; angle?: number; pitch?: number } = {}) {
    this.camera = camera;
    let cy = 1;
    if (camera === "side") {
      this.ax = 0;
      this.ay = opts.lift ?? 0.26;
    } else if (camera === "plongee") {
      const p = (Math.min(90, Math.max(20, opts.pitch ?? 60)) * Math.PI) / 180;
      this.ax = 0;
      this.ay = Math.sin(p);
      cy = Math.cos(p);
    } else {
      const k = opts.k ?? 0.5, a = ((opts.angle ?? 38) * Math.PI) / 180;
      this.ax = k * Math.cos(a);
      this.ay = k * Math.sin(a);
    }
    this.cy = cy;
    // direction écrasée sur un point (vers l'observateur) : noyau de la projection
    const d: V3 = [this.ax * cy, this.ay, cy];
    const l = Math.hypot(d[0], d[1], d[2]);
    this.dir = [d[0] / l, d[1] / l, d[2] / l];
  }

  p(x: number, y: number, z: number): P2 {
    return [x - this.ax * z, this.cy * y - this.ay * z];
  }
  pv(v: V3): P2 {
    return [v[0] - this.ax * v[2], this.cy * v[1] - this.ay * v[2]];
  }
  /** Projection d'un vecteur (sans origine). */
  vec(v: V3): P2 {
    return [v[0] - this.ax * v[2], this.cy * v[1] - this.ay * v[2]];
  }
  /** Profondeur vers l'observateur (plus grand = plus près). */
  depth(v: V3): number {
    return v[0] * this.dir[0] + v[1] * this.dir[1] + v[2] * this.dir[2];
  }
  /**
   * Clé d'ordre de dessin d'un objet posé au sol : la profondeur, mais avec l'abscisse presque neutralisée. En
   * cavalière, la profondeur dépend de x ; les bandes de sol (infinies en x) ont une clé prise en x = 0 : sans cela,
   * un objet loin à gauche passait derrière la bande de sol posée devant lui et se faisait couper.
   */
  key(v: V3): number {
    return (v[0] * 0.04) * this.dir[0] + v[1] * this.dir[1] + v[2] * this.dir[2];
  }
  /** Profondeur normalisée 0 (près) … 1 (loin) d'après z. */
  far(z: number): number {
    const t = (this.zMax - z) / Math.max(1e-6, this.zMax - this.zMin);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }
  /** Face visible ? (normale monde). */
  facing(n: V3): number {
    return n[0] * this.dir[0] + n[1] * this.dir[1] + n[2] * this.dir[2];
  }
  /** Affine d'une face plane : repère local (u, v) → plan du dessin. */
  face(origin: V3, uAxis: V3, vAxis: V3): Affine {
    const o = this.pv(origin), a = this.vec(uAxis), b = this.vec(vAxis);
    return [a[0], a[1], b[0], b[1], o[0], o[1]];
  }
  /** Point au sol (hauteur `h(x, z)`) sous un point du dessin : inverse approchée (quelques itérations). */
  ground(u: number, v: number, h: (x: number, z: number) => number): { x: number; z: number } {
    if (this.ay < 1e-4) return { x: u, z: 0 };
    let x = u, z = 0;
    for (let i = 0; i < 6; i++) {
      const y = h(x, z);
      z = (this.cy * y - v) / this.ay;
      x = u + this.ax * z;
    }
    return { x, z };
  }
}
