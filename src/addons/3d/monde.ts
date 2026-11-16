/**
 * Rendu three.js d'un `monde` (src/shared/monde) dans `sonic-3d`.
 *
 * - Instance nommée : un `Object3D` du nom de l'instance (pilotable par `nodes`, comme un nœud glTF), une
 *   articulation `<instance>_<pièce>` par pièce (hiérarchie du modèle), la forme en enfant. Les clips posent
 *   les articulations à chaque image (pilote partagé avec `sonic-2d`).
 * - Décor sans nom : `InstancedMesh` par pièce de modèle (un appel de dessin par pièce, quel que soit le nombre
 *   de copies), couleur par copie.
 * - Géométries et matières partagées (cache par forme / couleur) : dix joueurs = dix fois moins de mémoire.
 * - Modèles `gen` : construits par les générateurs procgen (chargés à la demande, une génération par tranche de
 *   ~12 ms pour garder la page fluide), dessinés avec le matériau procgen ; les clips du format posent le squelette
 *   (locomotion par distance parcourue + pistes d'os ajoutées).
 */
import * as THREE from "three";
import { geometryOf, type Geo } from "../../shared/monde/geometry";
import { m4, m4Compose, m4Mul } from "../../shared/monde/math";
import { partColor, partTex, type Conflict, type Model, type Monde, type Placement } from "../../shared/monde/format";
import { TEX_SIZE, texKey, texPixels, type TexSpec } from "../../shared/monde/textures";
import { MondeDriver, type InstanceState } from "../../shared/monde/driver";
import { STRIDE } from "../../shared/monde/pose";
import { measureGen, turnY } from "../../shared/monde/supports";
import type { Obb } from "../../shared/monde/collide";
import { placedInfo, type PlacedInfo } from "../../shared/monde/arrange";
import { edgeUnderRay } from "../../shared/monde/opening";
import { envelopeOf } from "../../shared/monde/walk";
import type { NodesSpec } from "./nodes";
import { aliasBone, genMotion } from "../../shared/monde/gen";
import type { GenActor, GenKit } from "../procgen/index";
import { loadProcgen, type ProcgenApi } from "../../shared/procgen-loader";

type ProcgenMod = ProcgenApi;

type Look = Monde["look"];

function makeBuffer(g: Geo): THREE.BufferGeometry {
  const b = new THREE.BufferGeometry();
  b.setAttribute("position", new THREE.BufferAttribute(g.pos, 3));
  b.setAttribute("normal", new THREE.BufferAttribute(g.nrm, 3));
  b.setAttribute("uv", new THREE.BufferAttribute(g.uv, 2));
  b.setIndex(new THREE.BufferAttribute(g.idx, 1));
  b.computeBoundingSphere();
  return b;
}

let toonRamp: THREE.DataTexture | null = null;
function ramp(): THREE.DataTexture {
  if (!toonRamp) {
    toonRamp = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
    toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
    toonRamp.needsUpdate = true;
  }
  return toonRamp;
}

/** Images du monde décodées, gardées d'un monde à l'autre (un monde relu ne recharge pas ses posters). */
const IMAGES = new Map<string, THREE.Texture>();

/** Matières partagées par (aspect, couleur, éclat, texture, instanciée). */
class Materials {
  private map = new Map<string, THREE.Material>();
  private texs = new Map<string, THREE.DataTexture>();
  constructor(private look: Look) {}
  /** Texture teintée (cache borné : au-delà, la version neutre, teintée par la couleur de la matière). */
  texture(t: TexSpec, base: string): THREE.DataTexture {
    let key = texKey(t, base);
    let tx = this.texs.get(key);
    if (!tx && this.texs.size >= 256) {
      base = "#ffffff";
      key = texKey(t, base);
      tx = this.texs.get(key);
    }
    if (!tx) {
      tx = new THREE.DataTexture(texPixels(t, base), TEX_SIZE, TEX_SIZE, THREE.RGBAFormat);
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      tx.magFilter = THREE.LinearFilter;
      tx.minFilter = THREE.LinearMipmapLinearFilter;
      tx.generateMipmaps = true;
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.repeat.set(t.scale, t.scale);
      tx.center.set(0.5, 0.5);
      tx.rotation = (t.angle * Math.PI) / 180;
      tx.userData.neutral = base === "#ffffff";
      tx.needsUpdate = true;
      this.texs.set(key, tx);
    }
    return tx;
  }
  /** Matière partagée du décor instancié : couleur portée par chaque copie, texture neutre. */
  get(color: string, glow: number, tex: TexSpec | null, instanced = false): THREE.Material {
    const key = `${color}|${glow}|${instanced}|${tex ? texKey(tex, "") + tex.scale + "/" + tex.angle : ""}`;
    let m = this.map.get(key);
    if (m) return m;
    m = this.create(color, glow, tex, instanced);
    this.map.set(key, m);
    return m;
  }

  /** Matière propre (instance nommée) : recolorée sur place quand ses rôles changent. */
  create(color: string, glow: number, tex: TexSpec | null, neutral = false): THREE.MeshStandardMaterial | THREE.MeshToonMaterial {
    const map = tex ? this.texture(tex, neutral ? "#ffffff" : color) : null;
    const c = new THREE.Color(neutral || map ? "#ffffff" : color);
    const em = glow > 0 ? new THREE.Color(color).multiplyScalar(glow) : new THREE.Color(0);
    const m = this.look === "toon"
      ? new THREE.MeshToonMaterial({ color: c, map, gradientMap: ramp(), emissive: em })
      : new THREE.MeshStandardMaterial({ color: c, map, roughness: this.look === "brillant" ? 0.28 : 0.72, metalness: 0, emissive: em });
    this.owned.add(m);
    return m;
  }

  /** Recolore une matière propre (couleur, éclat, texture teintée). */
  recolor(m: THREE.MeshStandardMaterial | THREE.MeshToonMaterial, color: string, glow: number, tex: TexSpec | null) {
    if (tex) {
      m.map = this.texture(tex, color);
      m.color.set(m.map.userData.neutral ? color : "#ffffff");
    } else m.color.set(color);
    if (glow > 0) m.emissive.set(color).multiplyScalar(glow);
    m.needsUpdate = !!tex;
  }
  private owned = new Set<THREE.Material>();

  /** Images du monde (URL `data:`) chargées une fois ; `onLoad` : redessiner quand une image arrive. */
  private imageMats = new Map<string, THREE.Material>();
  onLoad: (() => void) | null = null;

  /**
   * Matière d'une image posée sur la face avant d'une pièce de `w` × `h` mètres (UV en mètres, centrés : l'image
   * couvre exactement la face). Blanche le temps du chargement.
   */
  image(url: string, w: number, h: number): THREE.Material {
    const key = `${w.toFixed(3)}|${h.toFixed(3)}|${url.length}|${url.slice(-48)}|${url}`;
    let m = this.imageMats.get(key);
    if (m) return m;
    let base = IMAGES.get(url);
    if (!base) {
      const onLoad = this.onLoad;
      base = new THREE.TextureLoader().load(url, () => onLoad?.());
      base.colorSpace = THREE.SRGBColorSpace;
      base.anisotropy = 4;
      IMAGES.set(url, base);
      // quelques images à la fois (posters) : les plus anciennes sont oubliées
      if (IMAGES.size > 24) {
        const [old, t] = IMAGES.entries().next().value as [string, THREE.Texture];
        IMAGES.delete(old);
        t.dispose();
      }
    }
    const t = base.clone();
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.set(1 / Math.max(1e-3, w), 1 / Math.max(1e-3, h));
    t.offset.set(0.5, 0.5);
    // la copie partage l'image : prête quand elle l'est
    t.needsUpdate = true;
    m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.85, metalness: 0 });
    this.imageMats.set(key, m);
    return m;
  }

  dispose() {
    for (const m of this.owned) m.dispose();
    this.owned.clear();
    for (const m of this.imageMats.values()) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
    this.imageMats.clear();
    for (const t of this.texs.values()) t.dispose();
    this.map.clear();
    this.texs.clear();
  }
}

type OwnMat = THREE.MeshStandardMaterial | THREE.MeshToonMaterial;

type Built = {
  inst: InstanceState;
  joints: THREE.Object3D[];
  meshes: (THREE.Mesh | null)[];
  /** Matières propres de l'instance, une par (rôle ou couleur fixe, éclat, texture). */
  mats: Map<string, { m: OwnMat; part: number }>;
  /** Clé de matière de chaque pièce. */
  matKey: string[];
  shadow: THREE.Mesh | null;
  rolesRev: number;
  /** Modèle procgen : acteur (null tant qu'il n'est pas généré) et os de chaque pièce. */
  gen: { actor: GenActor | null; bones: (string | null)[]; glow: number; glowColor: string; step: Map<string, [number, number, number]>; rootOff: [number, number, number] } | null;
};

const SHADOW_GEO = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
let shadowMat: THREE.MeshBasicMaterial | null = null;

/** Hauteur d'un objet saisi (mètres). */
const LIFT = 0.06;

export class Monde3d {
  readonly driver = new MondeDriver();
  readonly group = new THREE.Group();
  private mats: Materials = new Materials("doux");
  private built = new Map<string, Built>();
  private buffers = new Map<Geo, THREE.BufferGeometry>();
  private oldBuffers = new Map<Geo, THREE.BufferGeometry>();
  private bgSaved: { bg: THREE.Scene["background"]; fog: THREE.Scene["fog"] } | null = null;

  private bufferOf(g: Geo): THREE.BufferGeometry {
    let b = this.buffers.get(g);
    if (!b) {
      b = this.oldBuffers.get(g) ?? makeBuffer(g);
      this.oldBuffers.delete(g);
      this.buffers.set(g, b);
    }
    return b;
  }
  private statics: THREE.InstancedMesh[] = [];
  private monde: Monde | null = null;
  private tmp = m4();
  private tmp2 = m4();
  private pg: ProcgenMod | null = null;
  private kit: GenKit | null = null;
  private pgLoad: Promise<void> | null = null;
  private jobs: { token: number; run: () => void }[] = [];
  private jobTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private token = 0;
  private lastStep = 0;
  private genStatics: THREE.Group[] = [];
  /** Acteurs procgen gardés d'un monde au suivant (même instance, même modèle) : état d'animation et éclat conservés. */
  private spare = new Map<string, { sig: string; actor: GenActor; glow: number; glowColor: string }>();
  /** Appelé quand un élément généré à part (procgen) est prêt : un rendu suffit. */
  onAsync: (() => void) | null = null;
  /** Appelé quand un modèle procgen vient d'être mesuré : le monde est à relire (pose et collisions exactes). */
  onMeasured: (() => void) | null = null;
  /** Appelé après un rangement (`nodes.<instance>.move`) : résultat à publier. */
  onPlaced: ((p: PlacedInfo) => void) | null = null;
  /** Déplacement en jeu gêné par un obstacle (`collide`) : instance, point atteint, ce qui gêne. */
  onContact: ((c: { objectId: string; x: number; z: number; hits: string[]; blocked: boolean }) => void) | null = null;
  /** Conflits recalculés après un rangement (glisser, `nodes.<instance>.move`). */
  onConflicts: ((c: Conflict[]) => void) | null = null;
  /** Boîtes des objets en conflit (`collisions: "montrer"`). */
  private marks: THREE.LineSegments | null = null;
  private selection: THREE.LineSegments | null = null;
  private selName = "";
  /** Geste en cours sur un objet : soulevé à la prise, posé avec un rebond au lâcher (voir `grab` / `release`). */
  private fx: { name: string; phase: "up" | "down"; t0: number; from: number } | null = null;
  /** Fantôme rouge : la place visée ne va pas (aucune place libre près du point). */
  private ghost: THREE.Mesh | null = null;

  constructor() {
    this.group.name = "monde";
  }

  get issues() {
    return this.monde?.issues ?? [];
  }

  get instanceNames(): string[] {
    return [...this.built.keys()];
  }

  /** (Re)construit la scène ; les instances inchangées gardent leur état de pilotage. */
  set(m: Monde, now: number) {
    this.clear(true);
    this.token++;
    this.monde = m;
    if (this.kit) {
      this.kit.setStyle(m.style, m.look, m.traits);
      this.kit.setFog(m.brume);
    }
    this.mats.dispose();
    this.mats = new Materials(m.look);
    this.mats.onLoad = () => this.onAsync?.();
    // les géométries encore utilisées sont reprises, les autres libérées après reconstruction
    this.oldBuffers = this.buffers;
    this.buffers = new Map();
    this.driver.setMonde(m, now);
    for (const inst of this.driver.instances.values()) this.buildInstance(m, inst);
    this.buildStatics(m);
    for (const s of this.spare.values()) s.actor.dispose();
    this.spare.clear();
    for (const b of this.oldBuffers.values()) b.dispose();
    this.oldBuffers.clear();
    this.drawMarks(m.marks);
    this.drawSelection();
  }

  /** Arêtes rouges des boîtes en conflit, toujours visibles (dessinées par-dessus la scène). */
  private drawMarks(boxes: Obb[]) {
    this.marks = this.outline(this.marks, boxes, 0xff2d2d, 10);
  }

  /** Arêtes de boîtes orientées, par-dessus la scène, insensibles au pointeur (remplace `prev`). */
  private outline(prev: THREE.LineSegments | null, boxes: Obb[], color: number, order: number): THREE.LineSegments | null {
    if (prev) {
      this.group.remove(prev);
      prev.geometry.dispose();
      (prev.material as THREE.Material).dispose();
    }
    if (!boxes.length) return null;
    const pos: number[] = [];
    const EDGES = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    for (const b of boxes) {
      const corner = (i: number) => {
        const s = [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1];
        return [0, 1, 2].map((a) => b.c[a] + s[0] * b.ax[0][a] * b.h[0] + s[1] * b.ax[1][a] * b.h[1] + s[2] * b.ax[2][a] * b.h[2]);
      };
      for (const e of EDGES) pos.push(...corner(e));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    line.name = "";
    line.renderOrder = order;
    // repère visuel seulement : ni pick ni glisser
    line.raycast = () => {};
    this.group.add(line);
    return line;
  }

  /** Instance sélectionnée (contour bleu ; vide : aucune), voir l'attribut `drag-selected`. */
  select(name: string): void {
    this.selName = name;
    this.drawSelection();
  }

  /** Prise d'un objet : il se soulève un peu (son ombre se détache du sol). */
  grab(name: string, now = performance.now()): void {
    this.fx = { name, phase: "up", t0: now, from: this.driver.instances.get(name)?.liftY ?? 0 };
  }

  /** Lâcher : l'objet se pose avec un petit rebond ; le fantôme rouge disparaît. */
  release(name: string, now = performance.now()): void {
    this.fx = { name, phase: "down", t0: now, from: this.driver.instances.get(name)?.liftY ?? 0 };
    this.showGhost(null);
  }

  /** Hauteur de l'objet saisi à l'instant `now` (mètres) ; `null` : plus d'effet. */
  private fxLift(now: number): number | null {
    const f = this.fx;
    if (!f) return null;
    const t = now - f.t0;
    if (f.phase === "up") return f.from + (LIFT - f.from) * Math.min(1, t / 140) * (2 - Math.min(1, t / 140));
    const u = t / 320;
    if (u >= 1) {
      this.fx = null;
      return 0;
    }
    // descente, puis un rebond d'un centimètre
    return u < 0.45 ? f.from * Math.pow(1 - u / 0.45, 2) : 0.012 * Math.sin(Math.PI * ((u - 0.45) / 0.55));
  }

  /** Applique la hauteur du geste à l'objet saisi ; vrai si elle a changé. */
  private applyFx(now: number): boolean {
    const f = this.fx;
    if (!f) return false;
    const inst = this.driver.instances.get(f.name);
    const lift = this.fxLift(now);
    if (!inst || inst.carry || lift === null) return false;
    if (inst.liftY === lift) return false;
    inst.liftY = lift;
    inst.driven = true;
    return true;
  }

  /** Fantôme rouge sur l'enveloppe de l'objet (`null` : retiré). */
  private showGhost(name: string | null): void {
    const body = name && this.monde ? this.driver.bodies().find((b) => b.name === name) : undefined;
    if (!body) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    if (!this.ghost) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false });
      this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      this.ghost.renderOrder = 12;
      this.ghost.raycast = () => {};
      this.group.add(this.ghost);
    }
    const e = envelopeOf(body);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...e.ax[0]), new THREE.Vector3(...e.ax[1]), new THREE.Vector3(...e.ax[2]));
    this.ghost.quaternion.setFromRotationMatrix(m);
    const inst = this.driver.instances.get(name!);
    this.ghost.position.set(e.c[0], e.c[1] + (inst && !inst.carry ? inst.liftY : 0), e.c[2]);
    this.ghost.scale.set(e.h[0] * 2 + 0.01, e.h[1] * 2 + 0.01, e.h[2] * 2 + 0.01);
    this.ghost.visible = true;
  }

  /** Point au-dessus de l'objet sélectionné (milieu du haut de son enveloppe, mètres), `null` sans sélection. */
  selectionPoint(): [number, number, number] | null {
    const name = this.selName;
    const body = name && this.monde ? this.driver.bodies().find((b) => b.name === name) : undefined;
    if (!body) return null;
    const e = envelopeOf(body);
    const up = Math.abs(e.ax[0][1]) * e.h[0] + Math.abs(e.ax[1][1]) * e.h[1] + Math.abs(e.ax[2][1]) * e.h[2];
    const inst = this.driver.instances.get(name);
    return [e.c[0], e.c[1] + up + (inst && !inst.carry ? inst.liftY : 0), e.c[2]];
  }

  private drawSelection(): void {
    const name = this.selName;
    const body = name && this.monde ? this.driver.bodies().find((b) => b.name === name) : undefined;
    if (body) {
      const e = envelopeOf(body);
      // un peu plus large que l'objet : le contour ne se confond pas avec ses arêtes
      this.selection = this.outline(this.selection, [{ ...e, h: [e.h[0] + 0.02, e.h[1] + 0.02, e.h[2] + 0.02] }], 0x2f7bf6, 11);
    } else this.selection = this.outline(this.selection, [], 0, 0);
  }

  /** Ciel et brume du monde ; ceux de la scène sont rendus quand le monde n'en donne plus. */
  applySky(scene: THREE.Scene, m: Monde | null) {
    if (m?.ciel) {
      this.bgSaved ??= { bg: scene.background, fog: scene.fog };
      scene.background = new THREE.Color(m.ciel);
      scene.fog = m.brume > 0 ? new THREE.FogExp2(m.ciel, m.brume * 0.08) : null;
    } else if (this.bgSaved) {
      scene.background = this.bgSaved.bg;
      scene.fog = this.bgSaved.fog;
      this.bgSaved = null;
    }
  }

  private buildInstance(m: Monde, inst: InstanceState) {
    const pl = inst.placement;
    const root = new THREE.Object3D();
    root.name = inst.name;
    root.position.set(pl.at[0], pl.at[1], pl.at[2]);
    root.rotation.set(pl.rot[0], pl.rot[1], pl.rot[2]);
    root.scale.set(pl.scale[0], pl.scale[1], pl.scale[2]);
    root.visible = !pl.hidden;
    const model = inst.model;
    const joints: THREE.Object3D[] = [];
    const meshes: (THREE.Mesh | null)[] = [];
    const mats = new Map<string, { m: OwnMat; part: number }>();
    const matKey: string[] = [];
    if (model.gen) {
      this.buildGenInstance(m, inst, root);
      return;
    }
    model.parts.forEach((p, i) => {
      const j = new THREE.Object3D();
      j.name = `${inst.name}_${p.name}`;
      j.position.set(p.at[0], p.at[1], p.at[2]);
      j.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
      j.scale.set(p.scale[0], p.scale[1], p.scale[2]);
      j.visible = !p.hidden;
      (p.parent >= 0 ? joints[p.parent] : root).add(j);
      joints.push(j);
      const g = geometryOf(p, m.detail);
      const tex = partTex(m, p);
      const key = `${p.color || "@" + p.role}|${p.glow}|${tex ? texKey(tex, "") + tex.scale + "/" + tex.angle : ""}`;
      matKey.push(key);
      const img = p.image && Object.prototype.hasOwnProperty.call(m.images, p.image) ? m.images[p.image] : "";
      if (g && img) {
        // image du monde : matière à part (pas recolorée par les rôles)
        const mesh = new THREE.Mesh(this.bufferOf(g), this.mats.image(img, p.shape?.a[0] ?? 1, p.shape?.a[1] ?? 1));
        j.add(mesh);
        meshes.push(mesh);
      } else if (g) {
        let e = mats.get(key);
        if (!e) mats.set(key, (e = { m: this.mats.create(partColor(model, p, inst.roles, m.palette), p.glow, tex), part: i }));
        const mesh = new THREE.Mesh(this.bufferOf(g), e.m);
        // sans nom : un tap remonte à l'articulation `<instance>_<pièce>` ou à l'instance (pick-names)
        j.add(mesh);
        meshes.push(mesh);
      } else meshes.push(null);
    });
    let shadow: THREE.Mesh | null = null;
    if (m.shadows && !inst.placement.noShadow) {
      shadowMat ??= new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
      shadow = new THREE.Mesh(SHADOW_GEO, shadowMat);
      shadow.name = "";
      shadow.renderOrder = -1;
      const r = radiusOf(model) * Math.max(pl.scale[0], pl.scale[2]);
      shadow.scale.set(r, 1, r);
      // au pied de l'instance dès sa création (sinon à l'origine jusqu'à son premier mouvement)
      shadow.position.set(pl.at[0], 0.005, pl.at[2]);
      shadow.visible = root.visible;
      this.group.add(shadow);
    }
    this.group.add(root);
    this.built.set(inst.name, { inst, joints, meshes, mats, matKey, shadow, rolesRev: inst.rolesRev, gen: null });
  }

  private makeShadow(m: Monde, r: number): THREE.Mesh | null {
    if (!m.shadows) return null;
    shadowMat ??= new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });
    const shadow = new THREE.Mesh(SHADOW_GEO, shadowMat);
    shadow.name = "";
    shadow.renderOrder = -1;
    shadow.scale.set(r, 1, r);
    this.group.add(shadow);
    return shadow;
  }

  /** Instance procgen : nœud et articulations nommés tout de suite (pilotables), maillage dès qu'il est généré. */
  private buildGenInstance(m: Monde, inst: InstanceState, root: THREE.Object3D) {
    const model = inst.model;
    const pl = inst.placement;
    const joints = model.parts.map((p) => {
      const j = new THREE.Object3D();
      j.name = `${inst.name}_${p.name}`;
      root.add(j);
      return j;
    });
    const shadow = this.makeShadow(m, 0.35 * Math.max(pl.scale[0], pl.scale[2]));
    // placée tout de suite sous l'instance (sinon elle reste à l'origine jusqu'au premier pas d'animation)
    shadow?.position.set(pl.at[0], 0.005, pl.at[2]);
    this.group.add(root);
    const kept = this.spare.get(inst.name);
    const b: Built = { inst, joints, meshes: [], mats: new Map(), matKey: [], shadow, rolesRev: inst.rolesRev, gen: { actor: null, bones: model.parts.map((p) => aliasBone(p.name)), glow: kept?.glow ?? 0, glowColor: kept?.glowColor ?? "", step: new Map(), rootOff: [0, 0, 0] } };
    this.built.set(inst.name, b);
    const spec = model.gen!;
    const attach = (actor: GenActor) => {
      actor.setRoles(inst.roles);
      actor.setGlow(b.gen!.glow, b.gen!.glowColor);
      root.add(actor.object);
      b.gen!.actor = actor;
      b.rolesRev = inst.rolesRev;
      if (b.shadow) {
        const fp = actor.asset.footprint;
        const r = Math.max(0.2, Math.min(fp.hx, fp.hz) * 1.15) * Math.max(pl.scale[0], pl.scale[2]);
        b.shadow.scale.set(r, 1, r);
      }
    };
    // même instance, même modèle : l'acteur (pose, foulée, action en cours) passe au nouveau monde sans clignoter
    if (kept && kept.sig === model.sig) {
      this.spare.delete(inst.name);
      attach(kept.actor);
      return;
    }
    const make = (kit: GenKit) => {
      if (this.built.get(inst.name) !== b) return;
      const res = kit.build(spec, spec.rig !== "none");
      this.reportGen(m, model.name, res.issues);
      if (res.asset && measureGen(spec, res.asset.mesh.pos)) this.onMeasured?.();
      if (!res.asset || this.built.get(inst.name) !== b) return;
      attach(new this.pg!.GenActor(kit, res.asset, inst.roles, `${spec.seed}/${inst.name}`));
    };
    // asset déjà généré : tout de suite ; sinon en tâche découpée
    if (this.kit && this.kit.cached(spec, spec.rig !== "none")) make(this.kit);
    else this.withKit(make);
  }

  private reportGen(m: Monde, model: string, issues: { path: string; message: string }[]) {
    if (m !== this.monde) return;
    for (const i of issues.slice(0, 8)) {
      const path = `models.${model}.${i.path}`;
      if (!m.issues.some((x) => x.path === path && x.message === i.message)) m.issues.push({ path, message: i.message });
    }
  }

  /** Exécute `fn` avec le kit procgen (chargé à la demande), en tâche découpée pour ne pas figer la page. */
  private withKit(fn: (kit: GenKit) => void) {
    const token = this.token;
    this.jobs.push({ token, run: () => fn(this.kit!) });
    if (this.kit) return this.schedule();
    this.pgLoad ??= loadProcgen().then(
      (mod) => {
        this.pg = mod;
        this.kit = new mod.GenKit(this.monde?.style, this.monde?.look ?? "doux");
        if (this.monde) {
          this.kit.setStyle(this.monde.style, this.monde.look, this.monde.traits);
          this.kit.setFog(this.monde.brume);
        }
        this.schedule();
      },
      (err) => {
        // nouvel essai au prochain monde (bundle procgen chargé entre-temps)
        this.pgLoad = null;
        this.jobs = [];
        this.monde?.issues.push({ path: "", message: `procgen indisponible : ${err instanceof Error ? err.message : String(err)}` });
        this.onAsync?.();
      },
    );
  }

  private schedule() {
    if (this.jobTimer || !this.jobs.length || !this.kit) return;
    this.jobTimer = setTimeout(() => {
      this.jobTimer = 0;
      const t0 = performance.now();
      let ran = 0;
      while (this.jobs.length && (ran === 0 || performance.now() - t0 < 12)) {
        const j = this.jobs.shift()!;
        if (j.token !== this.token) continue;
        try {
          j.run();
        } catch (err) {
          this.monde?.issues.push({ path: "", message: `procgen : ${err instanceof Error ? err.message : String(err)}` });
        }
        ran++;
      }
      if (ran) this.onAsync?.();
      this.schedule();
    }, 0);
  }

  private buildStatics(m: Monde) {
    const byModel = new Map<string, Placement[]>();
    for (const pl of m.place) {
      if (pl.name || pl.hidden) continue;
      const list = byModel.get(pl.model) ?? [];
      list.push(pl);
      byModel.set(pl.model, list);
    }
    const mat = this.tmp;
    for (const [name, list] of byModel) {
      const model = m.models.get(name)!;
      if (model.gen) {
        const spec = model.gen;
        // un groupe instancié par jeu de couleurs (`roles` du placement)
        const byRoles = new Map<string, Placement[]>();
        for (const pl of list) {
          const k = JSON.stringify(pl.roles);
          byRoles.set(k, [...(byRoles.get(k) ?? []), pl]);
        }
        for (const group of byRoles.values()) {
          const mats = group.map((pl) => {
            const out = new Float32Array(16);
            m4Compose(out, pl.at[0], pl.at[1], pl.at[2], pl.rot[0], pl.rot[1], pl.rot[2], pl.scale[0], pl.scale[1], pl.scale[2]);
            return out;
          });
          const make = (kit: GenKit) => {
            const res = kit.build(spec, false);
            this.reportGen(m, name, res.issues);
            if (res.asset && measureGen(spec, res.asset.mesh.pos)) this.onMeasured?.();
            if (!res.asset || m !== this.monde) return;
            const g = kit.instanced(res.asset, mats, `${name}~decor`, group[0].roles);
            this.group.add(g);
            this.genStatics.push(g);
          };
          if (this.kit && this.kit.cached(spec, false)) make(this.kit);
          else this.withKit(make);
        }
        continue;
      }
      // matrices de repos des pièces (repère du modèle)
      const offs = new Float32Array(model.parts.length * STRIDE);
      for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
      const world = restWorld(model, offs);
      model.parts.forEach((p, i) => {
        const g = geometryOf(p, m.detail);
        if (!g || p.hidden) return;
        const im = new THREE.InstancedMesh(this.bufferOf(g), this.mats.get(partColor(model, p, undefined, m.palette), p.glow, partTex(m, p), true), list.length);
        im.name = `${name}~decor~${p.name}`;
        const color = new THREE.Color();
        const pm = new THREE.Matrix4();
        list.forEach((pl, k) => {
          m4Compose(mat, pl.at[0], pl.at[1], pl.at[2], pl.rot[0], pl.rot[1], pl.rot[2], pl.scale[0], pl.scale[1], pl.scale[2]);
          m4Mul(this.tmp2, mat, world.subarray(i * 16, i * 16 + 16));
          pm.fromArray(this.tmp2);
          im.setMatrixAt(k, pm);
          color.set(partColor(model, p, pl.roles, m.palette));
          if (p.glow > 0) color.multiplyScalar(1 + p.glow * 0.5);
          im.setColorAt(k, color);
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        this.group.add(im);
        this.statics.push(im);
      });
    }
  }

  /**
   * Patchs `nodes` d'instances : clip et couleurs ici ; position / orientation laissées à `NodeOverrides`
   * (l'instance est un nœud nommé comme un autre).
   */
  /**
   * Patchs `{x, z, collide}` ramenés au point atteint sans traverser d'obstacle (walk.ts), avant toute application
   * (le monde et les surcharges de nœuds reçoivent la même valeur). Rend `spec` tel quel s'il n'y a rien à corriger.
   */
  guardNodes(spec: NodesSpec): NodesSpec {
    let out: Record<string, unknown> | null = null;
    let synced = false;
    for (const [name, p] of Object.entries(spec)) {
      const c = p && typeof p === "object" ? (p as { collide?: unknown }).collide : undefined;
      if (c === undefined || c === false || !this.driver.instances.has(name)) continue;
      if (!synced) {
        for (const n of this.built.keys()) this.syncT(n);
        synced = true;
      }
      const g = this.driver.guard(name, p);
      if (!g) continue;
      out ??= { ...(spec as Record<string, unknown>) };
      out[name] = g.patch;
      if (g.walked.hits.length) this.onContact?.({ objectId: name, ...g.walked });
    }
    return (out ?? spec) as NodesSpec;
  }

  applyNodes(spec: NodesSpec, now: number): boolean {
    let any = false;
    let moved = false;
    for (const [name, p] of Object.entries(spec)) {
      if (name === "$reset") continue;
      if (this.kit !== null || this.pgLoad) this.genPartPatch(name, p);
      // pose sur un appui : le pilote part de la position réellement affichée (l'instance est un nœud de la scène)
      const on = p && typeof p === "object" ? (p as { on?: unknown }).on : undefined;
      const move = p && typeof p === "object" && Array.isArray((p as { move?: unknown }).move);
      if (move) {
        // le rangement regarde toute la scène : positions affichées de toutes les instances
        for (const n of this.built.keys()) this.syncT(n);
      } else if (typeof on === "string") {
        this.syncT(name);
        this.syncT(on.split("@")[0]);
      } else if (this.driver.instances.get(name)?.carry) this.syncT(this.driver.instances.get(name)!.carry!.support);
      const r = this.driver.apply(name, p, now, true, false);
      if (r && (r.pose || r.roles || r.transform)) any = true;
      const inst = move ? this.driver.instances.get(name) : undefined;
      if (inst?.placed && this.monde) {
        this.onPlaced?.(placedInfo(name, inst.placed, this.driver.bodies(), this.monde.unit));
        moved = true;
      }
    }
    if (moved) this.refreshConflicts();
    return any;
  }

  /** Instance nommée et visible à laquelle appartient un objet de la scène (vide : décor ou hors monde). */
  instanceOfObject(obj: THREE.Object3D): string {
    for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
      if (!o.visible) return "";
      const root: THREE.Object3D | null | undefined = o.name ? this.built.get(o.name)?.joints[0]?.parent : null;
      if (root === o) return this.driver.movable(o.name) ? o.name : "";
    }
    return "";
  }

  /** Glisser : range l'instance au point visé, tout de suite (voir arrange.ts). */
  dragTo(name: string, x: number, z: number, now: number, ry?: number, bord?: number): PlacedInfo | null {
    if (!this.monde) return null;
    for (const n of this.built.keys()) if (n !== name) this.syncT(n);
    const res = this.driver.arrangeTo(name, x, z, now, 0, "inOut", { ...(ry === undefined ? {} : { ry }), ...(bord === undefined ? {} : { bord }) });
    if (!res) return null;
    // le pilote repose l'objet : il reste soulevé tant qu'on le tient
    this.applyFx(now);
    const inst = this.driver.instances.get(name);
    if (inst && this.fx?.name === name && !inst.carry) inst.liftY = this.fxLift(now) ?? 0;
    this.showGhost(res.valid ? null : name);
    this.follow();
    this.refreshConflicts(true);
    return placedInfo(name, res, this.driver.bodies(), this.monde.unit);
  }

  /** Ouverture qui glisse le long des murs : mur visé par le rayon (mètres), `null` si aucun. */
  openingRay(name: string, o: [number, number, number], d: [number, number, number]): { x: number; z: number; bord: number } | null {
    return this.monde && this.driver.isOpening(name) ? edgeUnderRay(this.monde.edges, o, d) : null;
  }

  /** Fin d'un glisser : le résultat est publié (comme pour `nodes.<instance>.move`) et les conflits aussi. */
  dropped(name: string): void {
    const inst = this.driver.instances.get(name);
    if (inst?.placed && this.monde) this.onPlaced?.(placedInfo(name, inst.placed, this.driver.bodies(), this.monde.unit));
    this.refreshConflicts();
  }

  /** Conflits sur les positions courantes : arêtes rouges redessinées ; `live` (pendant un glisser) : sans publication. */
  refreshConflicts(live = false): void {
    for (const n of this.built.keys()) this.syncT(n);
    this.drawSelection();
    const r = this.driver.collisions();
    if (!r) return;
    this.drawMarks(r.marks);
    if (!live) this.onConflicts?.(r.conflicts);
  }

  /** Rang de l'entrée de `place` écrite d'une instance (-1 : inconnu). */
  srcOf(name: string): number {
    return this.driver.instances.get(name)?.placement.src ?? -1;
  }

  /** Cap affiché d'une instance (radians). */
  headingOf(name: string): number {
    return this.built.get(name)?.joints[0]?.parent?.rotation.y ?? this.driver.instances.get(name)?.t.ry ?? 0;
  }

  /** Hauteur affichée d'une instance (plan dans lequel on la fait glisser). */
  heightOf(name: string): number {
    return this.built.get(name)?.joints[0]?.parent?.position.y ?? 0;
  }

  /** Reporte dans le pilote la position affichée d'une instance (déplacée par `NodeOverrides`). */
  private syncT(name: string): void {
    const inst = this.driver.instances.get(name);
    const root = this.built.get(name)?.joints[0]?.parent;
    if (!inst || !root) return;
    // la hauteur d'un geste (objet soulevé) n'est qu'affichée : la pose garde l'objet au sol
    const lift = inst.driven && !inst.carry ? inst.liftY : 0;
    Object.assign(inst.t, { x: root.position.x, y: root.position.y - lift, z: root.position.z, ry: root.rotation.y, sx: root.scale.x, sy: root.scale.y, sz: root.scale.z });
  }

  /**
   * Les instances posées suivent leur appui : position, cap et échelle uniforme du nœud d'appui tel qu'affiché.
   * Appelé aussi après l'avance des surcharges `nodes`, pour suivre un appui en mouvement sans image de retard.
   */
  follow(): boolean {
    let moved = false;
    // instances rangées par le pilote (move, glisser) : sa position fait foi jusqu'à la prochaine position donnée par nodes
    for (const b of this.built.values()) {
      const inst = b.inst;
      if (!inst.driven || inst.carry) continue;
      const root = b.joints[0]?.parent;
      if (!root) continue;
      const y = inst.t.y + inst.liftY;
      if (root.position.x !== inst.t.x || root.position.y !== y || root.position.z !== inst.t.z || root.rotation.y !== inst.t.ry) {
        root.position.set(inst.t.x, y, inst.t.z);
        root.rotation.y = inst.t.ry;
        moved = true;
      }
    }
    for (const inst of this.driver.carriedInstances) {
      const c = inst.carry;
      const root = this.built.get(inst.name)?.joints[0]?.parent;
      const sup = c ? this.built.get(c.support)?.joints[0]?.parent : null;
      if (!c || !root || !sup) continue;
      const k = sup.scale.x || 1;
      const [dx, dz] = turnY(c.local[0] * k, c.local[2] * k, sup.rotation.y);
      const lift = c.move && c.move.lift ? c.move.lift * 4 * this.moveU(c, this.lastStep) * (1 - this.moveU(c, this.lastStep)) : 0;
      const x = sup.position.x + dx, y = sup.position.y + c.local[1] * k + lift, z = sup.position.z + dz, ry = sup.rotation.y + c.yaw;
      if (root.position.x !== x || root.position.y !== y || root.position.z !== z || root.rotation.y !== ry) {
        root.position.set(x, y, z);
        root.rotation.y = ry;
        moved = true;
      }
    }
    return moved;
  }

  private moveU(c: NonNullable<InstanceState["carry"]>, now: number): number {
    return c.move ? Math.max(0, Math.min(1, (now - c.move.start) / c.move.ms)) : 1;
  }

  /** `nodes.<instance>_<pièce>` d'un acteur procgen : `emissive` / `emissiveColor` deviennent un éclat de l'acteur. */
  private genPartPatch(name: string, p: unknown) {
    if (!p || typeof p !== "object") return;
    const o = p as Record<string, unknown>;
    if (o.emissive === undefined && o.emissiveColor === undefined) return;
    // préfixe le plus long d'abord : « p_0_tete » vise l'instance « p_0 », pas « p »
    for (let i = name.lastIndexOf("_"); i > 0; i = name.lastIndexOf("_", i - 1)) {
      const b = this.built.get(name.slice(0, i));
      if (!b?.gen) continue;
      if (typeof o.emissive === "number" && Number.isFinite(o.emissive)) b.gen.glow = o.emissive;
      if (typeof o.emissiveColor === "string") b.gen.glowColor = o.emissiveColor;
      b.gen.actor?.setGlow(b.gen.glow, b.gen.glowColor);
      return;
    }
  }

  /** Avance les clips et reporte poses, couleurs et ombres ; true si l'image doit être redessinée. */
  step(now: number): boolean {
    if (!this.monde) return false;
    const busy = this.driver.step(now);
    let changed = busy;
    if (this.applyFx(now)) changed = true;
    const dt = this.lastStep ? Math.min(0.1, Math.max(0, (now - this.lastStep) / 1000)) : 0;
    this.lastStep = now;
    if (this.follow()) changed = true;
    this.kit?.tick(now / 1000);
    for (const b of this.built.values()) {
      const inst = b.inst;
      if (b.gen) {
        changed = this.stepGen(b, dt) || changed;
        continue;
      }
      if (inst.poseChanged) {
        inst.poseChanged = false;
        changed = true;
        const parts = inst.model.parts;
        const o = inst.offs;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i], j = b.joints[i], k = i * STRIDE;
          j.position.set(p.at[0] + o[k + 3], p.at[1] + o[k + 4], p.at[2] + o[k + 5]);
          j.rotation.set(p.rot[0] + o[k], p.rot[1] + o[k + 1], p.rot[2] + o[k + 2]);
          const s = o[k + 6];
          j.scale.set(p.scale[0] * s, p.scale[1] * s, p.scale[2] * s);
        }
      }
      if (b.rolesRev !== inst.rolesRev) {
        b.rolesRev = inst.rolesRev;
        changed = true;
        // recoloration sur place : les surcharges `nodes` (matières clonées) restent intactes
        for (const { m, part } of b.mats.values()) {
          const p = inst.model.parts[part];
          this.mats.recolor(m, partColor(inst.model, p, inst.roles, this.monde!.palette), p.glow, partTex(this.monde!, p));
        }
      }
      if (b.shadow) {
        const root = b.joints[0]?.parent;
        if (root) {
          b.shadow.position.set(root.position.x, 0.005, root.position.z);
          b.shadow.visible = root.visible;
        }
      }
    }
    return changed;
  }

  /** Acteur procgen : clip → locomotion / action du moteur + pistes d'os ; rôles ; ombre. */
  private stepGen(b: Built, dt: number): boolean {
    const g = b.gen!;
    const inst = b.inst;
    const root = b.joints[0]?.parent ?? null;
    if (b.shadow && root) {
      b.shadow.position.set(root.position.x, 0.005, root.position.z);
      b.shadow.visible = root.visible && !!g.actor;
    }
    const actor = g.actor;
    if (!actor || !root) return false;
    if (b.rolesRev !== inst.rolesRev) {
      b.rolesRev = inst.rolesRev;
      actor.setRoles(inst.roles);
    }
    if (!actor.asset.skeleton) return false;
    inst.poseChanged = false;
    const clip = inst.clip.clip;
    const mo = genMotion(clip, inst.model.clips.get(clip));
    const bones = g.step;
    bones.clear();
    const o = inst.offs;
    const ro = g.rootOff;
    ro[0] = ro[1] = ro[2] = 0;
    for (let i = 0; i < g.bones.length; i++) {
      const bone = g.bones[i];
      if (!bone) continue;
      const k = i * STRIDE;
      if (o[k] || o[k + 1] || o[k + 2]) bones.set(bone, [o[k], o[k + 1], o[k + 2]]);
      if (bone === "root") {
        ro[0] = o[k + 3];
        ro[1] = o[k + 4];
        ro[2] = o[k + 5];
      }
    }
    // clip en pause (`clipSpeed: 0`) ou figé (`clipT`) : le moteur procgen s'arrête aussi
    const speed = inst.clip.speed ?? 1;
    const frozen = speed === 0 || inst.clip.fixed !== null;
    actor.update(frozen ? 0 : dt * speed, root, { clip, clipSpeed: mo.speed * speed, action: mo.action || undefined, bones, rootOff: ro }, Math.max(1e-3, Math.abs(root.scale.x)));
    return root.visible;
  }

  /** Vide la scène ; `keep` : les acteurs procgen sont mis de côté pour le monde suivant (`set`). */
  clear(keep = false) {
    for (const s of this.spare.values()) s.actor.dispose();
    this.spare.clear();
    for (const b of this.built.values()) {
      b.shadow?.removeFromParent();
      const a = b.gen?.actor;
      if (!a) continue;
      if (keep) {
        a.object.removeFromParent();
        this.spare.set(b.inst.name, { sig: b.inst.model.sig, actor: a, glow: b.gen!.glow, glowColor: b.gen!.glowColor });
      } else a.dispose();
    }
    for (const g of this.genStatics) {
      g.removeFromParent();
      const mats = g.userData.genMats as { color: THREE.Material; outline: THREE.Material } | undefined;
      mats?.color.dispose();
      mats?.outline.dispose();
      g.traverse((o) => (o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).geometry.dispose());
      const a = g.userData.genAsset;
      if (a) this.kit?.release(a);
    }
    this.genStatics = [];
    for (const im of this.statics) im.dispose();
    this.statics = [];
    this.built.clear();
    this.group.clear();
  }

  dispose() {
    this.clear();
    this.token++;
    this.jobs = [];
    if (this.jobTimer) clearTimeout(this.jobTimer);
    this.jobTimer = 0;
    this.mats.dispose();
    this.kit?.dispose();
  }
}

function restWorld(model: Model, offs: Float32Array): Float32Array {
  const world = new Float32Array(model.parts.length * 16);
  const tmp = m4();
  const id = m4();
  model.parts.forEach((p, i) => {
    const o = i * STRIDE;
    m4Compose(tmp, p.at[0] + offs[o + 3], p.at[1] + offs[o + 4], p.at[2] + offs[o + 5], p.rot[0], p.rot[1], p.rot[2], p.scale[0], p.scale[1], p.scale[2]);
    m4Mul(world.subarray(i * 16, i * 16 + 16), p.parent >= 0 ? world.subarray(p.parent * 16, p.parent * 16 + 16) : id, tmp);
  });
  return world;
}

/** Rayon au sol approximatif d'un modèle (pour l'ombre). */
export function radiusOf(model: Model): number {
  let r = 0.15;
  const offs = new Float32Array(model.parts.length * STRIDE);
  for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
  const w = restWorld(model, offs);
  model.parts.forEach((p, i) => {
    if (!p.shape) return;
    const x = w[i * 16 + 12], z = w[i * 16 + 14];
    const s = p.shape.a[0] ?? 0.1;
    r = Math.max(r, Math.min(3, Math.hypot(x, z) + Math.min(s, 1) * 0.6));
  });
  return r * 0.85;
}
