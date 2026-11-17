/**
 * Émetteurs du monde dans `sonic-3d` : simulation partagée (shared/sim) et rendu instancié.
 *
 * Chaque variante du modèle émis a un `InstancedMesh` par pièce, de `max` copies ; seules les `count` premières
 * sont dessinées. Les matrices sont recomposées à chaque image depuis les tableaux de la simulation : aucune
 * allocation, un appel de dessin par pièce et par variante, quel que soit le nombre de copies.
 */
import * as THREE from "three";
import { m4, m4Mul } from "../../shared/monde/math";
import type { Model, Monde } from "../../shared/monde/format";
import type { MondeDriver } from "../../shared/monde/driver";
import type { Emitter } from "../../shared/sim/emitter";
import { composeYP, EmitterSet } from "../../shared/sim/set";

export type { EmitStats } from "../../shared/sim/set";

export type EmitPart = { geo: THREE.BufferGeometry; mat: THREE.Material; local: Float32Array; color: THREE.Color };

type Drawn = { sim: Emitter; variants: { parts: { im: THREE.InstancedMesh; local: Float32Array }[] }[] };

export class EmitterLayer extends EmitterSet {
  readonly group = new THREE.Group();
  private drawn: Drawn[] = [];
  private tmp = m4();
  private tmp2 = m4();
  private mat = new THREE.Matrix4();

  constructor() {
    super();
    this.group.name = "monde~emitters";
  }

  /** Monte les émetteurs ; `partsOf` rend les pièces dessinables d'un modèle (matière instanciée, repos, couleur). */
  mount(m: Monde, partsOf: (model: Model, roles: Record<string, string>) => EmitPart[], driver: MondeDriver) {
    this.clearMeshes();
    this.set(m, driver);
    this.drawn = this.sims.map((sim) => {
      const spec = sim.spec;
      const variants = spec.variants.map((v) => {
        const model = m.models.get(v.model)!;
        const parts = partsOf(model, v.roles).map((p) => {
          const im = new THREE.InstancedMesh(p.geo, p.mat, spec.max);
          im.name = `${spec.id}~emit`;
          im.count = 0;
          im.frustumCulled = false;
          im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          // couleur de la pièce, une fois pour toutes les copies (les variantes de couleur sont des variantes)
          for (let k = 0; k < spec.max; k++) im.setColorAt(k, p.color);
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          this.group.add(im);
          return { im, local: p.local };
        });
        return { parts };
      });
      return { sim, variants };
    });
    for (const d of this.drawn) this.draw(d);
  }

  /** Avance les simulations et recompose les matrices. */
  advance(dt: number, driver: MondeDriver): boolean {
    if (!this.drawn.length) return false;
    let changed = this.step(dt, driver);
    for (const d of this.drawn) changed = this.draw(d) || changed;
    return changed;
  }

  private draw(d: Drawn): boolean {
    const s = d.sim;
    const counts = d.variants.map(() => 0);
    for (let i = 0; i < s.n; i++) {
      const v = d.variants.length > 1 ? s.variant[i] % d.variants.length : 0;
      const slot = counts[v]++;
      const sc = s.size[i];
      composeYP(this.tmp, s.px[i], s.py[i], s.pz[i], s.heading(i), s.pitch(i), sc);
      for (const p of d.variants[v].parts) {
        m4Mul(this.tmp2, this.tmp, p.local);
        this.mat.fromArray(this.tmp2);
        p.im.setMatrixAt(slot, this.mat);
      }
    }
    let changed = false;
    d.variants.forEach((v, k) => {
      for (const p of v.parts) {
        if (p.im.count !== counts[k] || counts[k] > 0) changed = true;
        p.im.count = counts[k];
        if (counts[k] > 0) p.im.instanceMatrix.needsUpdate = true;
      }
    });
    return changed;
  }

  private clearMeshes() {
    for (const d of this.drawn) for (const v of d.variants) for (const p of v.parts) p.im.dispose();
    this.drawn = [];
    this.group.clear();
  }

  dispose() {
    this.clearMeshes();
    super.dispose();
  }
}
