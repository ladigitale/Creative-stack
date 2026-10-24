import * as THREE from "three";

import {
  MAX_NODES_PER_MUTATION,
  easeCurve as ease,
  isNum,
  patchOf,
  type NodeCurve,
  type NodePatch,
  type NodesSpec,
} from "../../shared/nodes";

export { MAX_NODES_PER_MUTATION };
export type { NodeCurve, NodeEase, NodePatch, NodesSpec } from "../../shared/nodes";

type Channel = "px" | "py" | "pz" | "rx" | "ry" | "rz" | "sx" | "sy" | "sz" | "em" | "op";

type Tween = {
  node: THREE.Object3D;
  start: number;
  ms: number;
  curve: NodeCurve;
  from: Partial<Record<Channel, number>>;
  to: Partial<Record<Channel, number>>;
  lift: number;
};

type MatBase = {
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
};

type Baseline = {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
  visible: boolean;
};

type StdMat = THREE.MeshStandardMaterial;



function toColor(v: unknown): THREE.Color | null {
  if (typeof v !== "string" && !isNum(v)) return null;
  try {
    return new THREE.Color(v as THREE.ColorRepresentation);
  } catch {
    return null;
  }
}


/**
 * Surcharges de nœuds d'une scène glTF pilotées par données.
 * Sémantique « patch » ; matériaux clonés au premier override ;
 * interpolations avancées depuis la boucle de rendu (`step`), sans second RAF.
 */
export class NodeOverrides {
  private root: THREE.Object3D | null = null;
  private cache = new Map<string, THREE.Object3D | null>();
  private baselines = new Map<THREE.Object3D, Baseline>();
  private matBases = new Map<THREE.Material, MatBase>();
  private cloned = new Set<THREE.Material>();
  private ownMeshes = new WeakSet<THREE.Mesh>();
  private origMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private tweens = new Set<Tween>();
  /** Noms inconnus lors de la dernière application. */
  missing = 0;

  get active(): boolean {
    return this.tweens.size > 0;
  }

  /** Branche la scène chargée (purge tout l'état précédent). */
  attach(root: THREE.Object3D | null) {
    this.dispose();
    this.root = root;
  }

  /** Libère clones et caches (rechargement, dispose). */
  dispose() {
    this.tweens.clear();
    this.cache.clear();
    this.baselines.clear();
    this.matBases.clear();
    for (const m of this.cloned) m.dispose();
    this.cloned.clear();
    this.origMats.clear();
    this.ownMeshes = new WeakSet();
    this.root = null;
    this.missing = 0;
  }

  private find(name: string): THREE.Object3D | null {
    if (this.cache.has(name)) return this.cache.get(name) ?? null;
    const obj = this.root?.getObjectByName(name) ?? null;
    this.cache.set(name, obj);
    return obj;
  }

  private baseline(node: THREE.Object3D): Baseline {
    let b = this.baselines.get(node);
    if (!b) {
      b = {
        position: node.position.clone(),
        rotation: node.rotation.clone(),
        scale: node.scale.clone(),
        visible: node.visible,
      };
      this.baselines.set(node, b);
    }
    return b;
  }

  private meshesOf(node: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    node.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
    });
    return out;
  }

  /** Clone les matériaux d'un mesh (une fois) et retourne ses matériaux propres. */
  private ownMaterials(mesh: THREE.Mesh): StdMat[] {
    if (!this.ownMeshes.has(mesh)) {
      this.origMats.set(mesh, mesh.material);
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const clones = list.map((m) => {
        const c = m.clone();
        this.cloned.add(c);
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? clones : clones[0];
      this.ownMeshes.add(mesh);
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return mats.filter((m) => "emissive" in m) as StdMat[];
  }

  private matBase(m: StdMat): MatBase {
    let b = this.matBases.get(m);
    if (!b) {
      b = {
        color: m.color.clone(),
        emissive: m.emissive.clone(),
        emissiveIntensity: m.emissiveIntensity,
        opacity: m.opacity,
        transparent: m.transparent,
      };
      this.matBases.set(m, b);
    }
    return b;
  }

  private applyMaterial(node: THREE.Object3D, p: NodePatch, interp: Tween | null) {
    const color = p.color !== undefined ? toColor(p.color) : null;
    const emColor = p.emissiveColor !== undefined ? toColor(p.emissiveColor) : null;
    const wantsMat =
      color || emColor || isNum(p.emissive) || isNum(p.opacity);
    if (!wantsMat) return;
    for (const mesh of this.meshesOf(node)) {
      for (const m of this.ownMaterials(mesh)) {
        this.matBase(m);
        if (color) m.color.copy(color);
        if (emColor) m.emissive.copy(emColor);
        if (isNum(p.emissive)) {
          if (!emColor && m.emissive.getHex() === 0) m.emissive.set(0xffffff);
          if (!interp?.to.em) m.emissiveIntensity = p.emissive;
        }
        if (isNum(p.opacity) && !interp?.to.op) {
          m.opacity = p.opacity;
          m.transparent = p.opacity < 1 || this.matBase(m).transparent;
        }
        m.needsUpdate = true;
      }
    }
  }

  private currentEmissive(node: THREE.Object3D): number {
    for (const mesh of this.meshesOf(node)) {
      const m = this.ownMaterials(mesh)[0];
      if (m) return m.emissiveIntensity;
    }
    return 0;
  }

  private currentOpacity(node: THREE.Object3D): number {
    for (const mesh of this.meshesOf(node)) {
      const m = this.ownMaterials(mesh)[0];
      if (m) return m.opacity;
    }
    return 1;
  }

  private read(node: THREE.Object3D, ch: Channel): number {
    switch (ch) {
      case "px": return node.position.x;
      case "py": return node.position.y;
      case "pz": return node.position.z;
      case "rx": return node.rotation.x;
      case "ry": return node.rotation.y;
      case "rz": return node.rotation.z;
      case "sx": return node.scale.x;
      case "sy": return node.scale.y;
      case "sz": return node.scale.z;
      case "em": return this.currentEmissive(node);
      case "op": return this.currentOpacity(node);
    }
  }

  private write(node: THREE.Object3D, ch: Channel, v: number) {
    switch (ch) {
      case "px": node.position.x = v; break;
      case "py": node.position.y = v; break;
      case "pz": node.position.z = v; break;
      case "rx": node.rotation.x = v; break;
      case "ry": node.rotation.y = v; break;
      case "rz": node.rotation.z = v; break;
      case "sx": node.scale.x = v; break;
      case "sy": node.scale.y = v; break;
      case "sz": node.scale.z = v; break;
      case "em":
        for (const mesh of this.meshesOf(node)) {
          for (const m of this.ownMaterials(mesh)) m.emissiveIntensity = v;
        }
        break;
      case "op":
        for (const mesh of this.meshesOf(node)) {
          for (const m of this.ownMaterials(mesh)) {
            m.opacity = v;
            m.transparent = v < 1 || this.matBase(m).transparent;
          }
        }
        break;
    }
  }

  private targets(p: NodePatch): Partial<Record<Channel, number>> {
    const t: Partial<Record<Channel, number>> = {};
    if (isNum(p.x)) t.px = p.x;
    if (isNum(p.y)) t.py = p.y;
    if (isNum(p.z)) t.pz = p.z;
    if (isNum(p.rx)) t.rx = p.rx;
    if (isNum(p.ry)) t.ry = p.ry;
    if (isNum(p.rz)) t.rz = p.rz;
    if (isNum(p.scale)) {
      t.sx = t.sy = t.sz = p.scale;
    } else if (Array.isArray(p.scale) && p.scale.length === 3) {
      const [a, b, c] = p.scale;
      if (isNum(a) && isNum(b) && isNum(c)) {
        t.sx = a;
        t.sy = b;
        t.sz = c;
      }
    }
    if (isNum(p.emissive)) t.em = p.emissive;
    if (isNum(p.opacity)) t.op = p.opacity;
    return t;
  }

  /** Remet tous les nœuds touchés dans l'état du fichier. */
  reset() {
    this.tweens.clear();
    for (const [node, b] of this.baselines) {
      node.position.copy(b.position);
      node.rotation.copy(b.rotation);
      node.scale.copy(b.scale);
      node.visible = b.visible;
    }
    for (const [mesh, orig] of this.origMats) mesh.material = orig;
    for (const m of this.cloned) m.dispose();
    this.cloned.clear();
    this.origMats.clear();
    this.matBases.clear();
    this.ownMeshes = new WeakSet();
  }

  /**
   * Applique un objet `nodes`. Retourne true si au moins un nœud a changé.
   * `animate=false` ignore `ease` / `lift` (boucle de rendu arrêtée).
   */
  apply(spec: NodesSpec, now: number, animate = true): boolean {
    if (!this.root || !spec || typeof spec !== "object") return false;
    let changed = false;
    if (spec.$reset === true) {
      this.reset();
      changed = true;
    }
    this.missing = 0;
    let count = 0;
    for (const [name, raw] of Object.entries(spec)) {
      if (name === "$reset") continue;
      const p = patchOf(raw);
      if (!p) continue;
      if (++count > MAX_NODES_PER_MUTATION) break;
      const node = this.find(name);
      if (!node) {
        this.missing++;
        continue;
      }
      changed = this.applyOne(node, p, now, animate) || changed;
    }
    return changed;
  }

  private applyOne(node: THREE.Object3D, p: NodePatch, now: number, animate: boolean): boolean {
    this.baseline(node);
    const to = this.targets(p);
    const ms = animate && isNum(p.ease?.ms) ? Math.max(0, p.ease!.ms!) : 0;
    const curve: NodeCurve = p.ease?.curve ?? "linear";
    const lift = ms > 0 && isNum(p.lift) ? p.lift : 0;
    // `lift` seul : arc en y autour de la position courante.
    if (lift && to.py === undefined) to.py = node.position.y;

    if (typeof p.visible === "boolean") node.visible = p.visible;

    const chans = Object.keys(to) as Channel[];
    // Un nouvel override d'un canal annule son interpolation en cours
    // (le nouveau tween repart de la valeur courante).
    for (const tw of this.tweens) {
      if (tw.node !== node) continue;
      for (const ch of chans) {
        delete tw.to[ch];
        delete tw.from[ch];
      }
      if (!Object.keys(tw.to).length) this.tweens.delete(tw);
    }

    if (ms > 0 && chans.length) {
      const from: Partial<Record<Channel, number>> = {};
      for (const ch of chans) from[ch] = this.read(node, ch);
      const tw: Tween = { node, start: now, ms, curve, from, to, lift };
      this.tweens.add(tw);
      this.applyMaterial(node, p, tw);
    } else {
      for (const ch of chans) this.write(node, ch, to[ch]!);
      this.applyMaterial(node, p, null);
    }
    return true;
  }

  /** Avance les interpolations ; retourne true si quelque chose a bougé. */
  step(now: number): boolean {
    if (!this.tweens.size) return false;
    for (const tw of [...this.tweens]) {
      const node = tw.node;
      const raw = tw.ms > 0 ? Math.min(1, Math.max(0, (now - tw.start) / tw.ms)) : 1;
      const k = ease(tw.curve, raw);
      for (const ch of Object.keys(tw.to) as Channel[]) {
        const a = tw.from[ch] ?? 0;
        const b = tw.to[ch]!;
        let v = a + (b - a) * k;
        if (ch === "py" && tw.lift) v += tw.lift * 4 * raw * (1 - raw);
        this.write(node, ch, v);
      }
      if (raw >= 1) this.tweens.delete(tw);
    }
    return true;
  }
}
