import * as THREE from "three";
import { TEX_SIZE, TexJob, texSizeFor, type TexSpec } from "../../shared/monde/textures";

/**
 * Texture adaptative : une texture procédurale commence petite (TEX_SIZE) et est recalculée plus finement quand
 * une pièce qui la porte est vue de près (au moins un texel par pixel), jusqu'à une taille plafond fixée par le
 * `detail` du monde. Le calcul est découpé en tranches de quelques ms hors du rendu ; la texture garde son objet
 * (les matières qui la partagent suivent sans rien reconstruire).
 */

export type AdaptTex = THREE.DataTexture & { userData: { tex?: TexSpec; base?: string; size?: number } };

const sphere = new THREE.Sphere();
const camPos = new THREE.Vector3();

export class TexAdapt {
  /** Taille plafond (128 à 1024). */
  max = 512;
  /** Redessiner après une mise à jour (le rendu ne tourne pas forcément en continu). */
  onUpdate: (() => void) | null = null;
  private lastScan = 0;
  private want = new Map<AdaptTex, number>();
  private job: { tx: AdaptTex; job: TexJob } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Inscrit une texture procédurale (à la création). */
  static tag(tx: THREE.DataTexture, tex: TexSpec, base: string) {
    const u = (tx as AdaptTex).userData;
    u.tex = tex;
    u.base = base;
    u.size = TEX_SIZE;
    tx.anisotropy = 8;
  }

  /**
   * Relevé des besoins, au plus 4 fois par seconde : pour chaque texture, la plus grande densité à l'écran parmi
   * les pièces qui la portent (distance à leur sphère englobante).
   */
  scan(root: THREE.Object3D, camera: THREE.Camera, viewportPx: number, now: number) {
    if (now - this.lastScan < 250) return;
    this.lastScan = now;
    camera.getWorldPosition(camPos);
    const persp = camera as THREE.PerspectiveCamera;
    const ortho = camera as THREE.OrthographicCamera;
    const k = persp.isPerspectiveCamera ? viewportPx / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) : 0;
    const orthoPx = ortho.isOrthographicCamera ? (viewportPx * ortho.zoom) / Math.max(1e-6, ortho.top - ortho.bottom) : 0;
    const near = persp.isPerspectiveCamera ? Math.max(0.05, persp.near) : 0.05;
    this.want.clear();
    root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat || Array.isArray(mat)) return;
      const tx = (mat.map ?? mat.bumpMap) as AdaptTex | null;
      if (!tx?.userData?.tex) return;
      let px = orthoPx;
      if (!px) {
        const inst = mesh as THREE.InstancedMesh;
        if (inst.isInstancedMesh) {
          if (!inst.boundingSphere) inst.computeBoundingSphere();
          sphere.copy(inst.boundingSphere!).applyMatrix4(mesh.matrixWorld);
        } else {
          if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
          sphere.copy(mesh.geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld);
        }
        const d = Math.max(near, camPos.distanceTo(sphere.center) - sphere.radius);
        px = k / d;
      }
      const size = texSizeFor(px, tx.userData.tex.scale || 1, this.max);
      if (size > (this.want.get(tx) ?? 0)) this.want.set(tx, size);
    });
    if (!this.job) this.next();
  }

  /** Prochaine texture à affiner (la plus en retard d'abord) ; jamais d'allègement, une texture vue reste nette. */
  private next() {
    let best: AdaptTex | null = null;
    let gap = 0;
    for (const [tx, size] of this.want) {
      const cur = tx.userData.size ?? TEX_SIZE;
      if (size > cur && size / cur > gap) {
        gap = size / cur;
        best = tx;
      }
    }
    if (!best) return;
    this.job = { tx: best, job: new TexJob(best.userData.tex!, best.userData.base!, this.want.get(best)!) };
    this.pump();
  }

  private pump = () => {
    this.timer = null;
    const j = this.job;
    if (!j) return;
    const px = j.job.step(6);
    if (!px) {
      this.timer = setTimeout(this.pump, 0);
      return;
    }
    const n = j.job.size;
    // nouvelle taille : la texture GPU est réallouée (un stockage immuable ne change pas de dimensions)
    j.tx.dispose();
    j.tx.image = { data: px as unknown as Uint8Array, width: n, height: n } as never;
    j.tx.userData.size = n;
    j.tx.needsUpdate = true;
    this.job = null;
    this.onUpdate?.();
    this.next();
  };

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.job = null;
    this.want.clear();
  }
}
