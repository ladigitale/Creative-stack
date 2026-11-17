/**
 * Particules du monde dans `sonic-3d` : un appel de dessin par système (quads instanciés face caméra, voir
 * shared/sim/particles-gl.ts, partagé avec `sonic-procgen`).
 */
import * as THREE from "three";
import type { Monde } from "../../shared/monde/format";
import { ParticleSet } from "../../shared/sim/particle-set";
import { createParticleMesh, disposeParticleMesh, particleQuad, uploadParticles, type ParticleMesh } from "../../shared/sim/particles-gl";

type Drawn = ParticleMesh;

export class ParticleLayer extends ParticleSet {
  readonly group = new THREE.Group();
  private drawn: Drawn[] = [];
  private lightPool: THREE.PointLight[] = [];
  private quad: THREE.BufferGeometry;

  constructor() {
    super();
    this.group.name = "monde~particles";
    this.quad = particleQuad();
  }

  mount(m: Monde) {
    this.clearMeshes();
    this.set(m);
    const hard = m.look === "toon" ? 1 : 0;
    this.drawn = this.systems.map((sys) => {
      const d = createParticleMesh(sys, this.quad, { hard: hard > 0, vent: this.vent });
      d.mat.uniforms.uNow.value = this.now;
      this.group.add(d.mesh);
      return d;
    });
    if (this.systems.some((sys) => sys.spec.light))
      for (let i = 0; i < 4; i++) {
        const pl = new THREE.PointLight(0xffffff, 0, 6, 2);
        this.lightPool.push(pl);
        this.group.add(pl);
      }
  }

  /** Avance l'horloge, envoie les naissances, place les lumières ; vrai si quelque chose bouge. */
  advance(dt: number): boolean {
    if (!this.drawn.length) return false;
    this.step(dt);
    for (const d of this.drawn) {
      uploadParticles(d);
      d.mat.uniforms.uNow.value = this.now;
    }
    this.placeLights();
    return this.active;
  }

  /**
   * Lumières des systèmes : un jeu fixe de 4 lumières ponctuelles créé une fois (allumer ou éteindre une lumière
   * changerait le nombre de lumières de la scène et ferait recompiler tous les matériaux) ; éteinte = intensité 0.
   */
  private placeLights() {
    if (!this.lightPool.length) return;
    const ls = this.lights();
    this.lightPool.forEach((pl, i) => {
      const l = ls[i];
      if (!l) {
        pl.intensity = 0;
        return;
      }
      pl.color.set(l.color);
      pl.intensity = l.intensity;
      pl.distance = l.radius;
      pl.position.set(l.at[0], l.at[1], l.at[2]);
    });
  }

  private clearMeshes() {
    for (const d of this.drawn) disposeParticleMesh(d);
    this.drawn = [];
    this.group.clear();
    this.lightPool = [];
  }

  dispose() {
    this.clearMeshes();
    this.quad.dispose();
    super.dispose();
  }
}
