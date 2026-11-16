/**
 * Vue à hauteur d'yeux (`camera="yeux"`) : on se tient dans la pièce, un glisser fait regarder autour (OrbitControls
 * autour d'un point tout proche devant soi), un tap sur le sol y conduit, la molette ou les flèches avancent et
 * reculent. Les pas restent dans le contour de l'espace (à `MARGE` des murs).
 */
import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { inPolygon } from "../../shared/monde/supports";

/** Distance caméra → point regardé (m) : assez petite pour que tourner autour revienne à regarder autour. */
export const EYE_RADIUS = 0.02;
/** Champ de vision à hauteur d'yeux (degrés) : plus large qu'en maquette, la pièce entoure. */
export const EYE_FOV = 68;
const MARGE = 0.3;
const PAS = 0.35;

export type EyeCtx = {
  /** Entrée de la pièce (porte), mètres : on s'y place, tourné vers l'intérieur. */
  entry?: { x: number; z: number; nx: number; nz: number } | null;
  activeCam: THREE.Camera;
  controls: OrbitControls | null;
  /** Contour de la pièce (mètres), `null` : pas de limite. */
  contour: number[][] | null;
  /** Centre de repli sans contour. */
  center: THREE.Vector3;
};

type Glide = { from: THREE.Vector3; to: THREE.Vector3; start: number; ms: number };

/** Point (x, z) ramené à `MARGE` dans le contour (convexe ; un bon rapprochement sinon). */
export function insideRoom(contour: number[][] | null, x: number, z: number, marge = MARGE): [number, number] {
  if (!contour || contour.length < 3) return [x, z];
  const n = contour.length;
  if (!inPolygon(x, z, contour)) {
    let best: [number, number] = [x, z], bd = Infinity;
    for (let i = 0; i < n; i++) {
      const a = contour[i], b = contour[(i + 1) % n];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
      const q: [number, number] = [a[0] + dx * t, a[1] + dz * t];
      const d = Math.hypot(q[0] - x, q[1] - z);
      if (d < bd) [bd, best] = [d, q];
    }
    [x, z] = best;
  }
  for (let pass = 0; pass < 3; pass++)
    for (let i = 0; i < n; i++) {
      const a = contour[i], b = contour[(i + 1) % n];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-9) continue;
      const t = ((x - a[0]) * (b[0] - a[0]) + (z - a[1]) * (b[1] - a[1])) / (L * L);
      if (t < -0.1 || t > 1.1) continue;
      let nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
      if (!inPolygon((a[0] + b[0]) / 2 + nx * 1e-3, (a[1] + b[1]) / 2 + nz * 1e-3, contour)) [nx, nz] = [-nx, -nz];
      const d = (x - a[0]) * nx + (z - a[1]) * nz;
      if (d < marge) {
        x += nx * (marge - d);
        z += nz * (marge - d);
      }
    }
  return [x, z];
}

export class EyeNav {
  height = 1.25;
  private glide: Glide | null = null;

  /** Se place au milieu de la pièce, à hauteur d'yeux, tourné vers le mur le plus lointain. */
  enter(ctx: EyeCtx) {
    const cam = ctx.activeCam;
    let cx = ctx.center.x, cz = ctx.center.z;
    let dir = new THREE.Vector3(0, 0, -1);
    const c = ctx.contour;
    if (ctx.entry) {
      // sur le seuil de la porte, un pas dans la pièce, face à elle
      dir = new THREE.Vector3(ctx.entry.nx, 0, ctx.entry.nz).normalize();
      [cx, cz] = insideRoom(c, ctx.entry.x + dir.x * 0.7, ctx.entry.z + dir.z * 0.7, 0.45);
    } else if (c && c.length >= 3) {
      cx = c.reduce((s, p) => s + p[0], 0) / c.length;
      cz = c.reduce((s, p) => s + p[1], 0) / c.length;
      let far = -1;
      for (let i = 0; i < c.length; i++) {
        const a = c[i], b = c[(i + 1) % c.length];
        const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz;
        const d = Math.hypot(mx, mz);
        if (d > far) [far, dir] = [d, new THREE.Vector3(mx, 0, mz).normalize()];
      }
      // un pas en arrière du centre : on voit davantage de la pièce
      [cx, cz] = insideRoom(c, cx - dir.x * 0.6, cz - dir.z * 0.6);
    }
    cam.position.set(cx, this.height, cz);
    const target = cam.position.clone().addScaledVector(dir, EYE_RADIUS);
    target.y -= EYE_RADIUS * 0.15;
    if (ctx.controls) {
      ctx.controls.target.copy(target);
      ctx.controls.update();
    } else cam.lookAt(target);
    this.glide = null;
  }

  /** Va (en glissant) au point du sol (x, z), ramené dans la pièce. */
  goTo(ctx: EyeCtx, x: number, z: number, now = performance.now()) {
    const [qx, qz] = insideRoom(ctx.contour, x, z);
    const from = ctx.activeCam.position.clone();
    const to = new THREE.Vector3(qx, this.height, qz);
    this.glide = { from, to, start: now, ms: Math.min(1100, 300 + from.distanceTo(to) * 260) };
  }

  /** Avance (`n` > 0) ou recule de `n` pas dans la direction du regard. */
  step(ctx: EyeCtx, n: number, now = performance.now()) {
    const look = new THREE.Vector3();
    ctx.activeCam.getWorldDirection(look);
    look.y = 0;
    if (look.lengthSq() < 1e-6) return;
    look.normalize().multiplyScalar(PAS * n);
    const base = this.glide ? this.glide.to : ctx.activeCam.position;
    this.goTo(ctx, base.x + look.x, base.z + look.z, now);
  }

  /** Tourne le regard de `rad` (positif : vers la gauche). */
  turn(ctx: EyeCtx, rad: number) {
    const c = ctx.controls;
    if (!c) return;
    const off = c.target.clone().sub(ctx.activeCam.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), rad);
    c.target.copy(ctx.activeCam.position).add(off);
    c.update();
  }

  /** Avance le glissement en cours ; vrai si la caméra a bougé. */
  tick(ctx: EyeCtx, now: number): boolean {
    const g = this.glide;
    if (!g) return false;
    const u = Math.min(1, (now - g.start) / g.ms);
    const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    const p = g.from.clone().lerp(g.to, e);
    const d = p.sub(ctx.activeCam.position);
    ctx.activeCam.position.add(d);
    ctx.controls?.target.add(d);
    if (u >= 1) this.glide = null;
    return true;
  }

  get moving(): boolean {
    return !!this.glide;
  }
}
