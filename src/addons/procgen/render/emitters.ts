/**
 * Émetteurs dans `ProcgenView` : simulation partagée (`shared/sim`, pool commun avec le format monde) contre la scène
 * procgen (emprises des objets, tronçons de clôture, acteurs, ballons, relief, tabliers, eau), et rendu instancié.
 *
 * Une `InstancedMesh` par image de chaque variante, de `max` copies : seules les copies qui montrent cette image sont
 * dessinées. Les matrices sont écrites directement dans les tampons d'instance à chaque image (aucune allocation).
 * Les copies ne portent pas d'ombre (la carte d'ombre n'est pas refaite pour elles) et ne se sélectionnent pas.
 */
import * as THREE from "three";
import { BoxGrid, GridPair, type Aabb } from "../../../shared/sim/grid";
import type { Emitter, Hit, SimWorld } from "../../../shared/sim/emitter";
import { EmitterPool, type EmitStats } from "../../../shared/sim/pool";
import type { ObjectInfo, SceneModel } from "../scene/compose";
import { groundHeight } from "../scene/compose";
import type { EmitLook, ProcgenEmitters } from "../scene/emitters";
import { type MaterialPair, type Shared, makeMaterials, toGeometry } from "./materials";
import { type StyleTokens, resolveColors } from "../style/style";
import { ROLES } from "../style/roles";

type Pose = { x: number; y: number; z: number; ry: number };

/** Étiquettes de famille (en français, pour les masques) ajoutées au générateur. */
const FAMILY: Record<string, string[]> = {
  building: ["batiment", "mur"], wall: ["mur", "cloture"], tree: ["arbre", "vegetation"], bush: ["vegetation"], plant: ["vegetation"], rock: ["rocher"],
  vehicle: ["vehicule"], structure: ["ouvrage"], ball: ["ballon"], prop: ["objet"], seat: ["objet"], container: ["objet"], tool: ["objet"], street: ["objet"], pet: ["objet"], emblem: ["objet"],
};
/** Couches qu'un projectile traverse (herbes, fleurs). */
const SOFT = new Set(["grass", "flowers"]);

type Drawn = { sim: Emitter; look: EmitLook; meshes: THREE.InstancedMesh[][]; mats: MaterialPair[] };

export function tagsOf(o: ObjectInfo): string[] {
  const kind = typeof o.params.kind === "string" ? o.params.kind : typeof o.params.species === "string" ? o.params.species : "";
  return [o.id, o.layer, o.generator, ...(kind ? [`${o.generator}.${kind}`] : []), ...(FAMILY[o.generator] ?? []), "decor"];
}

/** Boîtes fixes de la scène : emprise tournée de chaque objet (ou ses tronçons de clôture), du sol à son sommet. */
export function sceneBoxes(model: SceneModel): Aabb[] {
  return boxesOf(model.objects);
}

/** Boîtes d'une liste d'objets (scène, ou peuplement des tuiles du monde infini). */
export function boxesOf(objects: readonly ObjectInfo[], out: Aabb[] = []): Aabb[] {
  for (const o of objects) {
    // acteurs, ballons et corps physiques mobiles : boîtes mobiles, refaites à chaque pas (voir `ProcgenView.dynamicBoxes`)
    if (o.mode === "actor" || o.generator === "ball" || SOFT.has(o.generator) || o.walkable || (o.body && o.body.kind !== "static")) continue;
    const tags = tagsOf(o);
    const y0 = o.pos[1], y1 = o.pos[1] + Math.max(0.05, o.height);
    if (o.blockers?.length) {
      for (const [x, z, hx, hz, yaw] of o.blockers) {
        const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
        const ex = c * hx + s * hz, ez = s * hx + c * hz;
        out.push({ name: o.id, tags, lo: [x - ex, y0, z - ez], hi: [x + ex, y1, z + ez], obb: { cx: x, cz: z, hx, hz, yaw } });
      }
      // un ouvrage praticable (pont), une clôture : seuls ses tronçons, garde-corps et piles arrêtent un tir
      continue;
    }
    const c = Math.abs(Math.cos(o.yaw)), s = Math.abs(Math.sin(o.yaw));
    const ex = c * o.footprint.hx + s * o.footprint.hz, ez = s * o.footprint.hx + c * o.footprint.hz;
    out.push({ name: o.id, tags, lo: [o.pos[0] - ex, y0, o.pos[2] - ez], hi: [o.pos[0] + ex, y1, o.pos[2] + ez], obb: { cx: o.pos[0], cz: o.pos[2], hx: o.footprint.hx, hz: o.footprint.hz, yaw: o.yaw } });
  }
  return out;
}

/** Hachage d'identifiant de copie → phase (0..1) : les copies ne battent pas des ailes en même temps. */
const phaseOf = (id: number) => (((Math.imul(id, 0x9e3779b1) >>> 0) % 1000) / 1000);

export class ProcgenEmitterLayer extends EmitterPool {
  readonly group = new THREE.Group();
  private drawn: Drawn[] = [];
  private fixed = new BoxGrid(2);
  private dyn = new BoxGrid(2);
  private pair = new GridPair(this.dyn, this.fixed);
  private model: SceneModel | null = null;
  private needsBoxes = false;
  private bounds: [number, number, number, number, number] | null = null;
  private style: StyleTokens | null = null;
  /** Boîtes mobiles (acteurs, ballons), données par la vue à chaque pas. */
  dynamic: () => Aabb[] = () => [];
  /** Position d'une instance nommée (acteur, objet, ballon). */
  poseOf: (name: string) => Pose | null = () => null;
  /** Monde infini : sol, eau et peuplement des tuiles chargées (`null` : scène bornée). */
  private inf: { height(x: number, z: number): number; waterLevel: number | null; objects(): ObjectInfo[]; version: number } | null = null;
  private infVersion = -1;
  /** Clé des émetteurs montés (relecture sans changement : rien n'est refait). */
  key = "";
  /** Dernières touches (16 au plus) publiées dans l'état. */
  lastHits: (Hit & { t: number })[] = [];

  constructor(
    private shared: Shared,
    private staticMats: MaterialPair,
  ) {
    super();
    this.group.name = "procgen~emitters";
  }

  get count(): number {
    return this.sims.length;
  }

  /** Nouvelle scène : boîtes fixes, sol, bornes ; les copies en vol sont gardées. */
  setModel(model: SceneModel) {
    this.model = model;
    this.infVersion = -1;
    this.fixed.clear();
    for (const b of sceneBoxes(model)) this.fixed.add(b);
    const [w, d] = model.size;
    this.bounds = [-w / 2 - 12, -d / 2 - 12, w / 2 + 12, d / 2 + 12, model.bounds.min[1] - 20];
  }

  /**
   * Monde infini (`TileWorld`) : le sol et l'eau suivent le relief des tuiles, leur peuplement entre dans les boîtes
   * fixes (refaites seulement quand des tuiles arrivent ou partent) ; pas de bord de scène. `null` : scène bornée.
   */
  syncInfinite(w: { height(x: number, z: number): number; waterLevel: number | null; objects(): ObjectInfo[]; version: number } | null) {
    if (!w) {
      if (this.inf && this.model) {
        this.inf = null;
        this.setModel(this.model);
      }
      return;
    }
    this.inf = w;
    if (w.version === this.infVersion || !this.model) return;
    this.infVersion = w.version;
    this.fixed.clear();
    for (const b of boxesOf([...this.model.objects, ...w.objects()])) this.fixed.add(b);
  }

  world(): SimWorld {
    const m = this.model;
    const inf = this.inf;
    const level = inf ? inf.waterLevel : m?.terrain?.spec.water ?? null;
    const ground = inf ? (x: number, z: number) => inf.height(x, z) : (x: number, z: number) => (m ? groundHeight(m, x, z) : 0);
    return {
      boxes: this.pair,
      emitter: (id) => this.sim(id),
      ground,
      water: level === null || (!inf && !m?.terrain) ? undefined : (x, z) => (ground(x, z) < level ? level : null),
      pose: (name) => this.poseOf(name),
      bounds: inf ? null : this.bounds,
    };
  }

  /** Monte des émetteurs lus (`readProcgenEmitters`) ; ceux qui n'ont pas changé gardent leurs copies. */
  mount(built: ProcgenEmitters) {
    this.key = built.key;
    this.clearMeshes();
    this.mountSpecs(built.specs, () => this.world());
    this.needsBoxes = built.specs.some((e) => e.mask.length > 0 || (e.flock?.avoid.length ?? 0) > 0);
    const looks = new Map(built.looks.map((l) => [l.id, l]));
    for (const sim of this.sims) {
      const look = looks.get(sim.spec.id);
      if (!look) continue;
      const mats: MaterialPair[] = [];
      const meshes = look.variants.map((v) => {
        // couleurs propres au modèle (robe d'un animal) : matière à elle, sinon la matière commune de la scène
        let mat = this.staticMats;
        if (v.colors && Object.keys(v.colors).length) {
          mat = makeMaterials(this.shared, { value: new Float32Array(ROLES.length * 3) }, false);
          if (this.style) mat.uniforms.uRoles.value.set(resolveColors(this.style, v.colors).roles);
          mat.uniforms.colors = { value: v.colors };
          mats.push(mat);
        }
        return v.frames.map((f) => {
          const geo = toGeometry(f);
          geo.setAttribute("aInstObj", new THREE.InstancedBufferAttribute(new Float32Array(sim.spec.max), 1));
          const im = new THREE.InstancedMesh(geo, mat.color, sim.spec.max);
          im.name = `${sim.spec.id}~emit`;
          im.count = 0;
          im.frustumCulled = false;
          im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          this.group.add(im);
          return im;
        });
      });
      this.drawn.push({ sim, look, meshes, mats });
    }
  }

  setStyle(s: StyleTokens) {
    this.style = s;
    for (const d of this.drawn) for (const m of d.mats) m.uniforms.uRoles.value.set(resolveColors(s, m.uniforms.colors.value as Record<string, string>).roles);
  }

  orders(spec: unknown): boolean {
    return this.ordersWith(spec, () => this.world());
  }

  /** Avance les simulations et recompose les matrices ; vrai si quelque chose a bougé. */
  advance(dt: number, time: number): boolean {
    if (!this.sims.length || !this.model) return false;
    if (this.needsBoxes) {
      this.dyn.clear();
      for (const b of this.dynamic()) this.dyn.add(b);
    }
    let changed = this.stepWith(dt, this.world());
    for (const d of this.drawn) changed = this.draw(d, time) || changed;
    return changed;
  }

  private draw(d: Drawn, time: number): boolean {
    const s = d.sim;
    const nv = d.meshes.length, nf = d.meshes[0]?.length ?? 0;
    if (!nf) return false;
    const counts = d.meshes.map((v) => v.map(() => 0));
    const arrs = d.meshes.map((v) => v.map((im) => im.instanceMatrix.array as Float32Array));
    const flap = d.look.flap, spin = d.look.spin;
    for (let i = 0; i < s.n; i++) {
      const v = nv > 1 ? s.variant[i] % nv : 0;
      // image : temps × cadence + phase propre à la copie ; une copie fichée (stick) ou posée reste immobile
      const ph = Math.floor((time * flap + phaseOf(s.ids[i])) * nf) % nf;
      const f = nf > 1 && s.state[i] === 0 && ph >= 0 ? ph : 0;
      const slot = counts[v][f]++;
      const pitch = s.pitch(i) + (spin && s.state[i] === 0 ? s.age[i] * spin : 0);
      composeAt(arrs[v][f], slot * 16, s.px[i], s.py[i], s.pz[i], s.heading(i), pitch, s.size[i]);
    }
    let changed = false;
    for (let v = 0; v < nv; v++)
      for (let f = 0; f < nf; f++) {
        const im = d.meshes[v][f], c = counts[v][f];
        if (im.count !== c || c > 0) changed = true;
        im.count = c;
        if (c > 0) im.instanceMatrix.needsUpdate = true;
      }
    return changed;
  }

  stats(): EmitStats {
    return this.statsWith((n) => this.poseOf(n));
  }

  /** Triangles dessinés par les copies (coût publié). */
  triangles(): number {
    let t = 0;
    for (const d of this.drawn) t += d.sim.n * d.look.triangles;
    return t;
  }

  private clearMeshes() {
    for (const d of this.drawn) {
      for (const v of d.meshes) for (const im of v) {
        im.geometry.dispose();
        im.dispose();
      }
      for (const m of d.mats) {
        m.color.dispose();
        m.depth.dispose();
      }
    }
    this.drawn = [];
    this.group.clear();
  }

  dispose() {
    this.clearMeshes();
    super.dispose();
  }
}

/** Cap autour de y puis tangage (le nez suit la trajectoire), échelle uniforme, écrits dans `o` à partir de `k`. */
function composeAt(o: Float32Array, k: number, x: number, y: number, z: number, yaw: number, pitch: number, s: number) {
  const ch = Math.cos(yaw), sh = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  o[k] = ch * s;
  o[k + 1] = 0;
  o[k + 2] = -sh * s;
  o[k + 3] = 0;
  o[k + 4] = sh * sp * s;
  o[k + 5] = cp * s;
  o[k + 6] = ch * sp * s;
  o[k + 7] = 0;
  o[k + 8] = sh * cp * s;
  o[k + 9] = -sp * s;
  o[k + 10] = ch * cp * s;
  o[k + 11] = 0;
  o[k + 12] = x;
  o[k + 13] = y;
  o[k + 14] = z;
  o[k + 15] = 1;
}
