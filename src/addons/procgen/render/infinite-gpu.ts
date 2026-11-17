/**
 * Monde infini côté carte graphique : chaque tuile chargée monte son sol, ses routes, son eau et ses bâtiments
 * fusionnés (maillages en repère local, posés à l'origine de la tuile) ; les objets répétés de **toutes** les tuiles
 * partagent un `InstancedMesh` par asset (un appel de dessin par asset, quel que soit le nombre de tuiles), recomposé
 * seulement quand l'ensemble des tuiles change. Une tuile au plus est montée par image (pas d'à-coup d'envoi).
 */
import * as THREE from "three";
import { Mesh } from "../geom/mesh";
import { ROLE } from "../style/roles";
import type { MaterialPair } from "./materials";
import { toGeometry } from "./materials";
import type { TileRec } from "../scene/infinite";

/** Petits objets : dessinés seulement sur les tuiles voisines du point suivi (invisibles plus loin, sous le brouillard). */
const NEAR_ONLY = new Set(["grass", "flowers", "plant", "tool", "ball", "container", "pet"]);
/** En qualité basse, aussi les buissons. */
const NEAR_ONLY_LOW = new Set(["bush"]);

type Inst = { im: THREE.InstancedMesh; geo: THREE.BufferGeometry; cap: number; objs: number[]; flex: boolean };

export class InfiniteGpu {
  readonly group = new THREE.Group();
  private tiles = new Map<string, { rec: TileRec; meshes: THREE.Mesh[] }>();
  private geos = new Map<string, { geo: THREE.BufferGeometry; mesh: Mesh }>();
  private inst = new Map<string, Inst>();
  private tmp = new THREE.Matrix4();
  /** Objets instanciés : maillage → ids d'objets (sélection). */
  readonly instanceObjs = new Map<THREE.InstancedMesh, number[]>();
  flex = false;

  constructor(private mats: MaterialPair, private onPickables: (add: THREE.Object3D[], remove: THREE.Object3D[]) => void) {
    this.group.name = "procgen~infini";
  }

  get size() {
    return this.tiles.size;
  }
  has(key: string) {
    return this.tiles.has(key);
  }
  /** Tuile montée (ou `null`). */
  rec(key: string): TileRec | null {
    return this.tiles.get(key)?.rec ?? null;
  }

  /** Monte une tuile (remplace celle de même clé). */
  mount(rec: TileRec) {
    this.unmount(rec.key);
    const meshes: THREE.Mesh[] = [];
    const add = (m: Mesh | null) => {
      if (!m || !m.vertexCount) return;
      const mesh = new THREE.Mesh(toGeometry(m), this.mats.color);
      mesh.userData.depth = this.mats.depth;
      mesh.userData.infini = rec.key;
      mesh.position.set(rec.origin[0], 0, rec.origin[1]);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      meshes.push(mesh);
    };
    add(rec.model.ground);
    add(rec.model.roads);
    add(rec.model.water);
    for (const t of rec.model.tiles) add(t);
    this.tiles.set(rec.key, { rec, meshes });
    this.onPickables(meshes, []);
  }

  unmount(key: string) {
    const t = this.tiles.get(key);
    if (!t) return;
    for (const m of t.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.onPickables([], t.meshes);
    this.tiles.delete(key);
  }

  /**
   * Recompose les instances partagées de toutes les tuiles montées, les plus proches de la tuile (ccx, ccz) d'abord :
   * les petits objets (herbes, fleurs…) ne sont dessinés que sur les tuiles voisines (anneau 1).
   */
  rebuildInstances(ccx = 0, ccz = 0, low = false) {
    const byKey = new Map<string, { mesh: Mesh; mats: Float64Array[]; objs: number[]; flex: boolean; near: number }>();
    const recs = [...this.tiles.values()].map((t) => t.rec).map((rec) => ({ rec, ring: Math.max(Math.abs(rec.cx - ccx), Math.abs(rec.cz - ccz)) })).sort((a, b) => a.ring - b.ring);
    for (const { rec, ring } of recs)
      for (const g of rec.model.instances) {
        let e = byKey.get(g.key);
        if (!e) byKey.set(g.key, (e = { mesh: g.mesh, mats: [], objs: [], flex: g.flex, near: 0 }));
        for (const m of g.matrices) e.mats.push(m as unknown as Float64Array);
        e.objs.push(...g.objs);
        if (ring <= 1) e.near = e.mats.length;
      }
    // assets disparus : vidés (gardés pour un retour proche) ; au-delà de 160 assets, libérés
    for (const [k, it] of this.inst)
      if (!byKey.has(k)) {
        it.im.count = 0;
        it.objs = [];
        this.instanceObjs.set(it.im, it.objs);
        if (this.inst.size > 160) {
          it.im.removeFromParent();
          it.im.dispose();
          this.onPickables([], [it.im]);
          this.instanceObjs.delete(it.im);
          this.inst.delete(k);
          this.geos.get(k)?.geo.dispose();
          this.geos.delete(k);
        }
      }
    let flex = false;
    for (const [k, e] of byKey) {
      flex ||= e.flex;
      let it = this.inst.get(k);
      const n = e.mats.length;
      if (!it || it.cap < n) {
        const cap = Math.max(16, 1 << Math.ceil(Math.log2(n * 1.25 + 1)));
        let g = this.geos.get(k);
        if (!g) this.geos.set(k, (g = { geo: toGeometry(e.mesh), mesh: e.mesh }));
        if (it) {
          it.im.removeFromParent();
          it.im.dispose();
          this.onPickables([], [it.im]);
          this.instanceObjs.delete(it.im);
        }
        g.geo.setAttribute("aInstObj", new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
        const im = new THREE.InstancedMesh(g.geo, this.mats.color, cap);
        im.userData.depth = this.mats.depth;
        im.name = `infini~${k.slice(0, 40)}`;
        im.frustumCulled = false;
        this.group.add(im);
        this.onPickables([im], []);
        it = { im, geo: g.geo, cap, objs: [], flex: e.flex };
        this.inst.set(k, it);
      }
      const attr = it.geo.getAttribute("aInstObj") as THREE.InstancedBufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < n; i++) {
        it.im.setMatrixAt(i, this.tmp.fromArray(e.mats[i] as unknown as number[]));
        arr[i] = e.objs[i];
      }
      attr.needsUpdate = true;
      const gen = k.slice(0, k.indexOf("|"));
      it.im.count = NEAR_ONLY.has(gen) || (low && NEAR_ONLY_LOW.has(gen)) ? e.near : n;
      it.im.instanceMatrix.needsUpdate = true;
      it.objs = e.objs;
      this.instanceObjs.set(it.im, e.objs);
    }
    this.flex = flex;
  }

  private far: THREE.Mesh | null = null;
  private hcache = new Map<string, number>();
  private farKey = "";

  /**
   * Sol lointain : grille grossière (4 cellules par tuile) au relief brut, de `reach` tuiles autour de la tuile
   * (ccx, ccz), trouée sous les tuiles montées. Le brouillard l'efface au loin : jamais de bord du monde ni de trou
   * pendant qu'une tuile se compose. Refait quand la tuile du centre ou l'ensemble monté change.
   */
  farGround(height: (x: number, z: number) => number, tile: number, ccx: number, ccz: number, reach: number, surface: number = ROLE.grass) {
    const key = `${ccx},${ccz},${reach},${[...this.tiles.keys()].sort().join(";")}`;
    if (key === this.farKey) return;
    this.farKey = key;
    const S = 4, c = tile / S;
    const n = (2 * reach + 1) * S;
    const x0 = (ccx - reach) * tile, z0 = (ccz - reach) * tile;
    const m = new Mesh();
    const W = n + 1;
    const h = new Float32Array(W * W);
    // hauteurs mises en cache par point de la grille du monde : seule la bande nouvelle se calcule quand on avance
    if (this.hcache.size > 60000) this.hcache.clear();
    const gi0 = (ccx - reach) * S, gj0 = (ccz - reach) * S;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const k = `${gi0 + i},${gj0 + j}`;
        let v = this.hcache.get(k);
        if (v === undefined) this.hcache.set(k, (v = height(x0 + i * c, z0 + j * c)));
        h[j * W + i] = v;
      }
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const gx = (h[j * W + Math.max(0, i - 1)] - h[j * W + Math.min(n, i + 1)]) / (2 * c), gz = (h[Math.max(0, j - 1) * W + i] - h[Math.min(n, j + 1) * W + i]) / (2 * c);
        const l = Math.hypot(gx, 1, gz);
        m.vertex([x0 + i * c, h[j * W + i] - 0.05, z0 + j * c], [gx / l, 1 / l, gz / l], surface, 0.95);
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const tx = ccx - reach + Math.floor(i / S), tz = ccz - reach + Math.floor(j / S);
        if (this.tiles.has(`${tx},${tz}`)) continue;
        const a = j * W + i;
        m.quad(a, a + W, a + W + 1, a + 1);
      }
    if (this.far) {
      this.far.removeFromParent();
      this.far.geometry.dispose();
      this.onPickables([], [this.far]);
    }
    const mesh = new THREE.Mesh(toGeometry(m), this.mats.color);
    mesh.userData.depth = this.mats.depth;
    mesh.matrixAutoUpdate = false;
    mesh.name = "infini~lointain";
    this.group.add(mesh);
    this.onPickables([mesh], []);
    this.far = mesh;
  }

  /** Triangles et appels de dessin du monde infini (mesure). */
  stats() {
    let tris = 0, calls = 0;
    for (const t of this.tiles.values()) for (const m of t.meshes) ((tris += (m.geometry.index?.count ?? 0) / 3), calls++);
    for (const it of this.inst.values()) if (it.im.count) ((tris += ((it.geo.index?.count ?? 0) / 3) * it.im.count), calls++);
    return { tris: Math.round(tris), calls };
  }

  dispose() {
    if (this.far) {
      this.far.removeFromParent();
      this.far.geometry.dispose();
      this.far = null;
    }
    for (const k of [...this.tiles.keys()]) this.unmount(k);
    for (const it of this.inst.values()) {
      it.im.removeFromParent();
      it.im.dispose();
      this.onPickables([], [it.im]);
    }
    this.inst.clear();
    this.instanceObjs.clear();
    for (const g of this.geos.values()) g.geo.dispose();
    this.geos.clear();
    this.group.removeFromParent();
  }
}
