import * as THREE from "three";
import { isHandheld } from "../../shared/three/pathtrace";
import { sceneSignature } from "./photo";

/**
 * Ombres portées par la lumière principale (carte d'ombre PCF adoucie). La carte n'est redessinée que quand le contenu
 * ou la direction de la lumière change (tourner autour de la pièce ne coûte rien de plus), et son cadre suit le contenu.
 */
export class CastShadows {
  private on = false;
  private sig = NaN;
  private readonly box = new THREE.Box3();
  private readonly sphere = new THREE.Sphere();
  private readonly dir = new THREE.Vector3();

  constructor(
    private renderer: THREE.WebGLRenderer,
    private key: THREE.DirectionalLight | undefined,
  ) {}

  get enabled() {
    return this.on;
  }

  set(on: boolean) {
    const k = this.key;
    if (!k || on === this.on) return;
    this.on = on;
    const sm = this.renderer.shadowMap;
    sm.enabled = on;
    sm.type = THREE.PCFShadowMap;
    sm.autoUpdate = false;
    k.castShadow = on;
    if (on) {
      const size = isHandheld() ? 1024 : 2048;
      k.shadow.mapSize.set(size, size);
      k.shadow.radius = 3;
      k.shadow.bias = -0.0004;
      k.shadow.map?.dispose();
      k.shadow.map = null;
    }
    this.sig = NaN;
  }

  /** Avant un rendu : recadre la lumière sur `content` et redessine la carte si quelque chose a changé. */
  update(content: THREE.Object3D) {
    const k = this.key;
    if (!this.on || !k) return;
    this.dir.copy(k.position).sub(k.target.position);
    if (this.dir.lengthSq() < 1e-8) this.dir.set(0.5, 1, 0.3);
    this.dir.normalize();
    const sig = (sceneSignature(content as THREE.Scene) + this.dir.x * 7.1 + this.dir.y * 13.3 + this.dir.z * 17.9) % 1e12;
    if (sig === this.sig) return;
    this.sig = sig;
    this.box.setFromObject(content, false);
    if (this.box.isEmpty()) return;
    this.box.getBoundingSphere(this.sphere);
    const r = Math.max(0.5, this.sphere.radius);
    const c = this.sphere.center;
    k.target.position.copy(c);
    k.target.updateMatrixWorld();
    k.position.copy(c).addScaledVector(this.dir, r * 2 + 1);
    k.updateMatrixWorld();
    const cam = k.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.05;
    cam.far = r * 4 + 2;
    cam.updateProjectionMatrix();
    // décalage le long de la normale : un texel et demi, contre l'acné sans décoller l'ombre du pied
    k.shadow.normalBias = ((2 * r) / k.shadow.mapSize.x) * 1.5;
    this.renderer.shadowMap.needsUpdate = true;
  }
}
