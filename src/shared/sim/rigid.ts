/**
 * Physique 3D du format monde avec Rapier (WASM embarqué, chargé à la demande) : commun aux rendus 2D et 3D.
 *
 * - Instances nommées avec `corps` : corps rigides (dynamique, statique, cinématique) ; formes tirées des pièces
 *   (boîtes, sphères, cylindres) ou du `collider` écrit.
 * - Instances nommées sans corps : obstacles cinématiques qui suivent leur position (un personnage piloté par
 *   `nodes` pousse les caisses).
 * - Décor sans nom (murs, sols, meubles) : obstacles fixes ; sol infini à y = 0 sauf `sol: false`.
 * - Ordres `forces.<instance>` (vitesse, force, impulsion, téléportation), chocs (`contact`) et repos (`rest`).
 *
 * Le moteur écrit la pose des corps dans `inst.t` (x y z rx ry rz, ordre XYZ) ; les rendus la recopient.
 *
 * `RigidCore` : le moteur sans le format monde (corps nommés, formes, liaisons, ordres, chocs, repos), partagé avec
 * la physique des scènes `sonic-procgen` (scene/rigid.ts) ; `RigidWorld` l'adapte au format monde.
 */
import type * as RapierNS from "@dimforge/rapier3d-compat";
import type { Model, Monde } from "../monde/format";
import { partBoxesOf, placeBoxes, type Obb } from "../monde/collide";
import type { BodySpec, V3 } from "../monde/physique";
import type { MondeDriver } from "../monde/driver";
import { heightAt, type TileManager } from "../monde/infini";
import { nearTiles, tileShapes } from "./infini-shapes";
import { type BodyPose, eulerFromQuat, KINEMATIC, type Quat, quatFromAxes, quatFromEuler, type R, RigidCore, type ShapeDesc } from "./rigid-core";

export * from "./rigid-core";

/* --------------------------------------------------------------- formes */

/**
 * Formes d'un corps dans son repère (pied de l'instance, échelle comprise) : collider écrit (sphères et capsules
 * gardées rondes), sinon une forme par pièce (sphère, cylindre, capsule ou boîte), 24 au plus (au-delà : englobante).
 */
export function bodyShapes(model: Model, scale: V3, spec: BodySpec): ShapeDesc[] {
  const boxes: { box: Obb; kind: string }[] =
    model.collider === "none"
      ? []
      : model.collider
        ? model.collider.map((b) => ({ box: b, kind: b.round ?? "box" }))
        : model.gen
          ? placeBoxes(model, [0, 0, 0], [0, 0, 0], [1, 1, 1]).map((b) => ({ box: b, kind: "box" }))
          : partBoxesOf(model).map(({ box, part }) => ({ box, kind: model.parts[part].shape?.kind ?? "box" }));
  const scaled = boxes.map(({ box, kind }) => ({
    kind,
    box: {
      c: [box.c[0] * scale[0], box.c[1] * scale[1], box.c[2] * scale[2]] as V3,
      ax: box.ax,
      h: box.h.map((h, i) => h * Math.hypot(box.ax[i][0] * scale[0], box.ax[i][1] * scale[1], box.ax[i][2] * scale[2])) as V3,
    },
  }));
  if (!scaled.length) return [];
  const englobe = (): ShapeDesc => {
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const { box } of scaled)
      for (let a = 0; a < 3; a++) {
        const e = Math.abs(box.ax[0][a]) * box.h[0] + Math.abs(box.ax[1][a]) * box.h[1] + Math.abs(box.ax[2][a]) * box.h[2];
        lo[a] = Math.min(lo[a], box.c[a] - e);
        hi[a] = Math.max(hi[a], box.c[a] + e);
      }
    return { kind: "box", c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], q: { x: 0, y: 0, z: 0, w: 1 }, h: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
  };
  if (spec.shape === "boite" || scaled.length > 24) return [englobe()];
  if (spec.shape === "sphere" || spec.shape === "capsule" || spec.shape === "cylindre") {
    const b = englobe();
    return [{ ...b, kind: spec.shape === "sphere" ? "ball" : spec.shape === "cylindre" ? "cyl" : "capsule" }];
  }
  return scaled
    .filter(({ box }) => box.h[0] + box.h[1] + box.h[2] > 1e-4)
    .map(({ box, kind }) => {
      const q = quatFromAxes(box.ax);
      const h = box.h.map((x) => Math.max(0.005, x)) as V3;
      const k = kind === "sphere" ? "ball" : kind === "cylinder" || kind === "cone" ? "cyl" : kind === "capsule" ? "capsule" : "box";
      return { kind: k, c: box.c, q, h } as ShapeDesc;
    });
}

/* --------------------------------------------------------------- format monde */

export class RigidWorld extends RigidCore {
  constructor(R: R, private monde: Monde, private driver: MondeDriver) {
    super(R, monde.physics!);
    const spec = monde.physics!;
    // monde infini avec relief : le sol vient des tuiles proches (voir syncInfini)
    if (spec.ground && !monde.infini?.relief) this.addPlaneGround(0);
    // décor sans nom : obstacles fixes (boîtes de rangement, ou formes rondes écrites)
    for (const pl of monde.place) {
      if (pl.name || pl.hidden || pl.sensor) continue;
      const model = monde.models.get(pl.model);
      if (!model) continue;
      const boxes = placeBoxes(model, pl.at, pl.rot, pl.scale);
      if (!boxes.length) continue;
      this.addFixed(boxes.slice(0, 24).map((b) => ({ kind: b.round === "sphere" ? "ball" : "box", c: b.c, q: quatFromAxes(b.ax), h: b.h })));
    }
    for (const inst of driver.instances.values()) this.addInstance(inst.name);
    for (const j of spec.joints) this.addJoint(j);
    if (spec.paused) for (const b of this.bodies.values()) if (b.spec?.kind === "dynamic") b.body.sleep();
  }

  private addInstance(name: string) {
    const inst = this.driver.instances.get(name);
    if (!inst || inst.placement.sensor || inst.placement.hidden) return;
    const spec = inst.placement.body ?? null;
    const t = inst.t;
    const shapes = bodyShapes(inst.model, [t.sx, t.sy, t.sz], spec ?? KINEMATIC);
    const tags = [...(inst.placement.tags ?? []), inst.placement.model.split("~")[0]];
    this.addBody(name, spec, { x: t.x, y: t.y, z: t.z, q: quatFromEuler(t.rx, t.ry, t.rz) }, shapes, tags);
  }

  protected readPose(name: string): BodyPose | null {
    const t = this.driver.instances.get(name)?.t;
    return t ? { x: t.x, y: t.y, z: t.z, q: quatFromEuler(t.rx, t.ry, t.rz) } : null;
  }

  protected writePose(name: string, p: { x: number; y: number; z: number }, q: Quat) {
    const inst = this.driver.instances.get(name);
    if (!inst) return;
    const [rx, ry, rz] = eulerFromQuat(q);
    Object.assign(inst.t, { x: p.x, y: p.y, z: p.z, rx, ry, rz });
    inst.transformDirty = true;
  }

  private infiniTiles = new Map<string, RapierNS.RigidBody>();
  private infiniHandles = new Map<string, number[]>();

  /**
   * Monde infini : relief (champ de hauteurs de 16 × 16 mailles par tuile) et peuplement (obstacles fixes) des
   * tuiles à au plus une tuile du centre ; les tuiles qui s'éloignent sont retirées. À appeler à chaque image.
   */
  syncInfini(mgr: TileManager) {
    const s = mgr.spec;
    if (!s) return;
    const R = this.R;
    const near = nearTiles(mgr, 1);
    const keep = new Set(near.map((t) => t.key));
    for (const [k, b] of this.infiniTiles)
      if (!keep.has(k) || mgr.tiles.get(k) !== (b.userData as { tile?: unknown } | undefined)?.tile) {
        this.world.removeRigidBody(b);
        this.infiniTiles.delete(k);
        for (const h of this.infiniHandles.get(k) ?? []) {
          this.byCollider.delete(h);
          this.labelOf.delete(h);
        }
        this.infiniHandles.delete(k);
      }
    for (const t of near) {
      if (this.infiniTiles.has(t.key)) continue;
      const T = s.tile;
      const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation((t.cx + 0.5) * T, 0, (t.cz + 0.5) * T));
      body.userData = { tile: t };
      const handles: number[] = [];
      this.infiniHandles.set(t.key, handles);
      if (s.relief) {
        const N = 16;
        const h = new Float32Array((N + 1) * (N + 1));
        // colonne j le long de x, ligne i le long de z (ordre colonne)
        for (let j = 0; j <= N; j++)
          for (let i = 0; i <= N; i++) h[j * (N + 1) + i] = heightAt(s, t.cx * T + (j / N) * T, t.cz * T + (i / N) * T);
        const c = this.world.createCollider(R.ColliderDesc.heightfield(N, N, h, { x: T, y: 1, z: T }).setFriction(0.8), body);
        this.byCollider.set(c.handle, null);
        handles.push(c.handle);
      }
      for (const sh of tileShapes(this.monde, t)) {
        for (const box of sh.boxes.slice(0, 4)) {
          const d = this.colliderDesc({ kind: box.round === "sphere" ? "ball" : "box", c: [box.c[0] - (t.cx + 0.5) * T, box.c[1], box.c[2] - (t.cz + 0.5) * T], q: quatFromAxes(box.ax), h: box.h });
          const c = this.world.createCollider(d.setFriction(0.7), body);
          this.byCollider.set(c.handle, null);
          this.labelOf.set(c.handle, { name: sh.name, tags: sh.tags });
          handles.push(c.handle);
        }
      }
      this.infiniTiles.set(t.key, body);
    }
  }

}
