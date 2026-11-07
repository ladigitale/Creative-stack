/**
 * Projections du mode vectoriel (monde 3D en mètres → plan du dessin, v vers le haut).
 *
 * - `side` (élévation) : u = x, v = y − lift·z. `lift` (0 … 0,4) relève légèrement les plans lointains, comme une
 *   élévation d'illustrateur où le sol se lit en bandes ; la profondeur sert à l'ordre de dessin et à l'atmosphère.
 * - `oblique` (cavalière) : u = x − k·cos(a)·z, v = y − k·sin(a)·z ; flancs droits et dessus visibles.
 *
 * Les deux sont affines : une face plane dessinée dans son repère local se projette par une affine 2D, donc les
 * courbes de Bézier restent des Bézier. `viewDir` est la direction (vers l'observateur) qui s'écrase sur un point :
 * une face est visible si sa normale la regarde.
 */
import type { V3 } from "../core/math";
import { type Affine, type P2 } from "./shape";

export type VectorCamera = "side" | "oblique";

export class Projector {
  readonly camera: VectorCamera;
  readonly ax: number;
  readonly ay: number;
  readonly dir: V3;
  zMin = -20;
  zMax = 20;

  constructor(camera: VectorCamera, opts: { lift?: number; k?: number; angle?: number } = {}) {
    this.camera = camera;
    if (camera === "side") {
      this.ax = 0;
      this.ay = opts.lift ?? 0.26;
    } else {
      const k = opts.k ?? 0.5, a = ((opts.angle ?? 38) * Math.PI) / 180;
      this.ax = k * Math.cos(a);
      this.ay = k * Math.sin(a);
    }
    const l = Math.hypot(this.ax, this.ay, 1);
    this.dir = [this.ax / l, this.ay / l, 1 / l];
  }

  p(x: number, y: number, z: number): P2 {
    return [x - this.ax * z, y - this.ay * z];
  }
  pv(v: V3): P2 {
    return [v[0] - this.ax * v[2], v[1] - this.ay * v[2]];
  }
  /** Projection d'un vecteur (sans origine). */
  vec(v: V3): P2 {
    return [v[0] - this.ax * v[2], v[1] - this.ay * v[2]];
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
      z = (y - v) / this.ay;
      x = u + this.ax * z;
    }
    return { x, z };
  }
}
