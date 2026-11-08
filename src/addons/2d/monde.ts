/**
 * Rendu Pixi d'un `monde` (src/shared/monde) dans `sonic-2d` : la même scène que `sonic-3d`, vue par une caméra
 * orthographique (`view2d` : dessus, profil, face, isométrique). Chaque pièce d'une instance nommée est une
 * silhouette (enveloppe convexe de sa forme) posée à chaque image par l'affine exacte de sa matrice monde ; la
 * silhouette n'est redessinée que si la pièce tourne assez pour changer de profil. Les décors sans nom sont
 * dessinés une fois (un `Graphics` par copie, pièces triées par profondeur).
 */
import { BufferImageSource, Container, FillPattern, Graphics, GraphicsContext, Matrix, Texture } from "pixi.js";
import { geometryOf } from "../../shared/monde/geometry";
import { m4, m4Compose, type M4, type V3 } from "../../shared/monde/math";
import { isColor, partColor, partTex, type Model, type Monde, type Part, type Placement } from "../../shared/monde/format";
import { MondeDriver, type InstanceState } from "../../shared/monde/driver";
import { forward, STRIDE } from "../../shared/monde/pose";
import { TEX_SIZE, texKey, texPixels, type TexSpec } from "../../shared/monde/textures";
import { affineOf, basisOf, bucketDir, bucketOf, depthOf, localDir, projOf, samplePoints, silhouette, type Proj } from "../../shared/monde/view2d";
import { shade } from "../../shared/monde/math";
import { isNum, patchOf } from "../../shared/nodes";

type PartView = {
  g: Graphics;
  bucket: number;
  u: V3;
  v: V3;
  hull: number[];
  color: string;
  /** Surcharges de la pièce (`nodes.<instance>_<pièce>`). */
  over: { visible?: boolean; color?: string; opacity?: number };
};

type Built = { inst: InstanceState; parts: (PartView | null)[]; shadow: Graphics | null; shadowSig: string; rolesRev: number; world: Float32Array; radius: number };

const textures = new Map<string, Texture>();
const patterns = new Map<string, FillPattern>();
function patternOf(t: TexSpec, base: string): FillPattern {
  const key = `${texKey(t, base)}|${t.scale}|${t.angle}`;
  let pat = patterns.get(key);
  if (!pat) {
    pat = new FillPattern({ texture: textureOf(t, base), repetition: "repeat", textureSpace: "global" });
    const k = 1 / (TEX_SIZE * t.scale);
    pat.setTransform(new Matrix().rotate((t.angle * Math.PI) / 180).scale(k, k));
    if (patterns.size > 256) patterns.clear();
    patterns.set(key, pat);
  }
  return pat;
}
function textureOf(t: TexSpec, base: string): Texture {
  const key = texKey(t, base);
  let tx = textures.get(key);
  if (!tx) {
    const source = new BufferImageSource({ resource: texPixels(t, base), width: TEX_SIZE, height: TEX_SIZE });
    source.style.addressMode = "repeat";
    tx = new Texture({ source });
    if (textures.size > 256) textures.clear();
    textures.set(key, tx);
  }
  return tx;
}

/** Remplit un polygone (coordonnées en mètres) : couleur ou motif, reflet intérieur, contour. */
function drawPart(g: Graphics | GraphicsContext, hull: number[], color: string, tex: TexSpec | null, glow: number, outline: number, unitPx: number, flat = false) {
  g.clear();
  if (hull.length < 6) return;
  g.poly(hull, true);
  if (tex) g.fill({ fill: patternOf(tex, color) });
  else g.fill({ color });
  // reflet : la même silhouette resserrée, plus claire (volume sans direction de lumière)
  if (glow <= 0 && !flat) {
    let cx = 0, cy = 0;
    const n = hull.length / 2;
    for (let i = 0; i < hull.length; i += 2) {
      cx += hull[i];
      cy += hull[i + 1];
    }
    cx /= n;
    cy /= n;
    const inner: number[] = [];
    for (let i = 0; i < hull.length; i += 2) inner.push(cx + (hull[i] - cx) * 0.58, cy + (hull[i + 1] - cy) * 0.58);
    g.poly(inner, true).fill({ color: shade(color, 0.35), alpha: 0.28 });
  }
  if (outline > 0 && glow < 0.5) g.poly(hull, true).stroke({ color: shade(color, -0.55), width: outline / unitPx, alpha: 0.9, join: "round" });
}

export class Monde2d {
  readonly driver = new MondeDriver();
  readonly container = new Container();
  private monde: Monde | null = null;
  private proj: Proj = projOf("top");
  private built = new Map<string, Built>();
  private partIndex = new Map<string, { b: Built; i: number }>();
  private statics: Container[] = [];
  private points = new WeakMap<Part, Float32Array>();
  /** Silhouettes par pièce et case de direction ; dessins partagés entre instances d'un même modèle. */
  private hulls = new WeakMap<Part, Map<number, number[]>>();
  private contexts = new Map<string, GraphicsContext>();
  private root: M4 = m4();
  private tmp: M4 = m4();
  private dir: V3 = [0, 0, 0];
  private aff: number[] = [0, 0, 0, 0, 0, 0];
  private mat = new Matrix();

  constructor(private invalidate: () => void) {
    this.container.sortableChildren = true;
    this.container.label = "monde";
  }

  get issues() {
    return this.monde?.issues ?? [];
  }

  set(m: Monde, now: number) {
    this.clear();
    this.monde = m;
    this.proj = projOf(m.view2d.view);
    this.driver.setMonde(m, now);
    this.buildStatics(m);
    for (const inst of this.driver.instances.values()) this.buildInstance(m, inst);
    this.step(now, true);
    this.invalidate();
  }

  private pointsOf(p: Part, detail: number): Float32Array | null {
    let pts = this.points.get(p);
    if (!pts) {
      const g = geometryOf(p, detail);
      if (!g) return null;
      pts = samplePoints(g.pos, detail === 2 ? 160 : 96);
      this.points.set(p, pts);
    }
    return pts;
  }

  private buildInstance(m: Monde, inst: InstanceState) {
    const model = inst.model;
    let shadow: Graphics | null = null;
    if (m.shadows) {
      shadow = new Graphics();
      shadow.label = `${inst.name}~ombre`;
      this.container.addChild(shadow);
    }
    const parts = model.parts.map((p, i) => {
      if (!p.shape) return null;
      const g = new Graphics();
      g.label = `${inst.name}_${p.name}`;
      this.container.addChild(g);
      const pv: PartView = { g, bucket: -1, u: [1, 0, 0], v: [0, 1, 0], hull: [], color: "", over: {} };
      return pv;
    });
    const b: Built = { inst, parts, shadow, shadowSig: "", rolesRev: -1, world: new Float32Array(model.parts.length * 16), radius: radiusOf(model) };
    this.built.set(inst.name, b);
    model.parts.forEach((p, i) => this.partIndex.set(`${inst.name}_${p.name}`, { b, i }));
  }

  private buildStatics(m: Monde) {
    const offsByModel = new Map<string, Float32Array>();
    const world = new Map<string, Float32Array>();
    const { unit, origin } = m.view2d;
    for (const pl of m.place) {
      if (pl.name || pl.hidden) continue;
      const model = m.models.get(pl.model)!;
      let offs = offsByModel.get(model.name);
      if (!offs) {
        offs = new Float32Array(model.parts.length * STRIDE);
        for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
        offsByModel.set(model.name, offs);
      }
      let w = world.get(model.name);
      if (!w) {
        w = new Float32Array(model.parts.length * 16);
        world.set(model.name, w);
      }
      placementMatrix(pl, this.root);
      forward(model, offs, this.root, w, this.tmp);
      const g = new Container();
      g.label = `${model.name}~decor`;
      // pièces de la copie, de la plus lointaine à la plus proche
      const order = model.parts
        .map((p, i) => ({ p, i, d: depthOf(this.proj, w![i * 16 + 12], w![i * 16 + 13], w![i * 16 + 14]) }))
        .filter((o) => o.p.shape && !o.p.hidden)
        .sort((a, b) => a.d - b.d);
      let dmax = -Infinity;
      for (const { p, i, d } of order) {
        const wi = w.subarray(i * 16, i * 16 + 16);
        const pts = this.pointsOf(p, m.detail);
        if (!pts) continue;
        localDir(wi, this.proj.dir, this.dir);
        const [u, v] = basisOf(this.dir);
        const hull = silhouette(pts, u, v);
        affineOf(wi, u, v, this.proj, unit, origin[0], origin[1], this.aff);
        const color = partColor(model, p, pl.roles, m.palette);
        const sub = new Graphics();
        drawPart(sub, hull, color, partTex(m, p), p.glow, m.outline, Math.hypot(this.aff[0], this.aff[1]) || 1, p.shape?.kind === "plane");
        sub.setFromMatrix(this.mat.set(this.aff[0], this.aff[1], this.aff[2], this.aff[3], this.aff[4], this.aff[5]));
        g.addChild(sub);
        dmax = Math.max(dmax, d);
      }
      // un sol (plan) reste dessous de tout ce qui est posé dessus
      g.zIndex = order.every((o) => o.p.shape?.kind === "plane") ? zOf(dmax) - 1e6 : zOf(dmax);
      this.container.addChild(g);
      this.statics.push(g);
    }
  }

  /** Patch d'une instance (transformations comprises) ou d'une pièce `<instance>_<pièce>`. */
  apply(name: string, p: unknown, now: number, animate: boolean): boolean {
    const r = this.driver.apply(name, p, now, animate, true);
    if (r) return r.pose || r.roles || r.transform;
    const hit = this.partIndex.get(name);
    if (!hit) return false;
    const patch = patchOf(p);
    const pv = hit.b.parts[hit.i];
    if (!patch || !pv) return false;
    if (typeof patch.visible === "boolean") pv.over.visible = patch.visible;
    if (isColor(patch.color)) pv.over.color = patch.color;
    if (isNum(patch.opacity)) pv.over.opacity = Math.max(0, Math.min(1, patch.opacity));
    pv.bucket = -1;
    hit.b.inst.poseDirty = true;
    return true;
  }

  get instanceCount(): number {
    return this.built.size;
  }

  has(name: string): boolean {
    return this.built.has(name) || this.partIndex.has(name);
  }

  /** Avance clips et tweens, place les pièces ; true tant que quelque chose bouge. */
  step(now: number, force = false): boolean {
    const m = this.monde;
    if (!m) return false;
    const busy = this.driver.step(now);
    const { unit, origin } = m.view2d;
    // trop de dessins en cache : on repart de zéro, en redessinant toutes les pièces dans cette image
    if (this.contexts.size > MAX_CONTEXTS) {
      for (const b of this.built.values()) for (const pv of b.parts) if (pv) {
        pv.bucket = -1;
        pv.g.context = EMPTY;
      }
      this.clearContexts();
      force = true;
    }
    for (const b of this.built.values()) {
      const inst = b.inst;
      const colors = b.rolesRev !== inst.rolesRev;
      if (!force && !colors && !inst.poseChanged && !inst.transformDirty) continue;
      inst.poseChanged = false;
      inst.transformDirty = false;
      b.rolesRev = inst.rolesRev;
      const t = inst.t;
      m4Compose(this.root, t.x, t.y + inst.liftY, t.z, t.rx, t.ry, t.rz, t.sx, t.sy, t.sz);
      forward(inst.model, inst.offs, this.root, b.world, this.tmp);
      const parts = inst.model.parts;
      for (let i = 0; i < parts.length; i++) {
        const pv = b.parts[i];
        if (!pv) continue;
        const p = parts[i];
        const w = b.world.subarray(i * 16, i * 16 + 16);
        const visible = inst.visible && !p.hidden && pv.over.visible !== false && !ancestorHidden(parts, i, b);
        pv.g.visible = visible;
        if (!visible) continue;
        localDir(w, this.proj.dir, this.dir);
        const bucket = bucketOf(this.dir);
        const color = pv.over.color ?? partColor(inst.model, p, inst.roles, m.palette);
        if (bucket !== pv.bucket || color !== pv.color) {
          pv.bucket = bucket;
          pv.color = color;
          [pv.u, pv.v] = basisOf(bucketDir(bucket));
          let byBucket = this.hulls.get(p);
          if (!byBucket) this.hulls.set(p, (byBucket = new Map()));
          let hull = byBucket.get(bucket);
          if (!hull) {
            const pts = this.pointsOf(p, m.detail);
            if (!pts) continue;
            hull = silhouette(pts, pv.u, pv.v);
            byBucket.set(bucket, hull);
          }
          pv.hull = hull;
          const key = `${inst.model.name}#${i}|${bucket}|${color}`;
          let ctx = this.contexts.get(key);
          if (!ctx) {
            ctx = new GraphicsContext();
            // épaisseur du contour : px de la vue, rapportée à l'échelle de la pièce (unité × échelle)
            const sc = Math.cbrt(Math.abs(w[0] * (w[5] * w[10] - w[6] * w[9]) - w[4] * (w[1] * w[10] - w[2] * w[9]) + w[8] * (w[1] * w[6] - w[2] * w[5]))) || 1;
            drawPart(ctx, hull, color, partTex(m, p), p.glow, m.outline, unit * sc, p.shape?.kind === "plane");
            this.contexts.set(key, ctx);
          }
          pv.g.context = ctx;
        }
        affineOf(w, pv.u, pv.v, this.proj, unit, origin[0], origin[1], this.aff);
        pv.g.setFromMatrix(this.mat.set(this.aff[0], this.aff[1], this.aff[2], this.aff[3], this.aff[4], this.aff[5]));
        pv.g.alpha = (pv.over.opacity ?? 1) * t.opacity;
        pv.g.zIndex = zOf(depthOf(this.proj, w[12], w[13], w[14]) + i * 1e-5);
      }
      const shadowSig = `${t.x}|${t.z}|${t.sx}|${t.sz}|${inst.liftY}|${t.opacity}|${inst.visible}`;
      if (b.shadow && shadowSig !== b.shadowSig) {
        b.shadowSig = shadowSig;
        const sh = b.shadow;
        sh.visible = inst.visible;
        if (inst.visible) {
          // ellipse au sol (y = 0) : projection d'un disque
          const r = b.radius * Math.max(t.sx, t.sz);
          sh.clear();
          const pts: number[] = [];
          for (let k = 0; k < 20; k++) {
            const a = (k / 20) * Math.PI * 2;
            const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
            pts.push(origin[0] + (this.proj.px[0] * x + this.proj.px[2] * z) * unit, origin[1] + (this.proj.py[0] * x + this.proj.py[2] * z) * unit);
          }
          sh.poly(pts, true).fill({ color: "#000000", alpha: Math.max(0.08, 0.26 - inst.liftY * 0.2) * t.opacity });
          sh.zIndex = zOf(depthOf(this.proj, t.x, 0, t.z)) - 5000;
        }
      }
    }
    this.invalidate();
    return busy;
  }

  /** Instance (et pièce) sous un point de la scène (coordonnées du calque) ; la plus proche d'abord. */
  pick(x: number, y: number): { instance: string; part: string } | null {
    let best: { instance: string; part: string; z: number } | null = null;
    for (const b of this.built.values()) {
      if (!b.inst.visible) continue;
      b.parts.forEach((pv, i) => {
        if (!pv || !pv.g.visible || pv.hull.length < 6) return;
        const lt = pv.g.localTransform;
        const det = lt.a * lt.d - lt.b * lt.c;
        if (!det) return;
        const dx = x - lt.tx, dy = y - lt.ty;
        const s = (lt.d * dx - lt.c * dy) / det, t = (-lt.b * dx + lt.a * dy) / det;
        if (inPoly(pv.hull, s, t) && (!best || pv.g.zIndex > best.z)) best = { instance: b.inst.name, part: b.inst.model.parts[i].name, z: pv.g.zIndex };
      });
    }
    return best ? { instance: (best as { instance: string }).instance, part: (best as { part: string }).part } : null;
  }

  private clearContexts() {
    for (const c of this.contexts.values()) c.destroy();
    this.contexts.clear();
  }

  clear() {
    // contexte jetable (le partagé et EMPTY ne doivent pas être détruits avec la pièce)
    for (const b of this.built.values()) for (const pv of b.parts) if (pv) pv.g.context = new GraphicsContext();
    // pièces d'instances : contexte partagé détaché ci-dessus ; décor et ombres : leurs propres dessins
    for (const c of this.container.removeChildren()) c.destroy({ children: true, context: true });
    this.clearContexts();
    this.built.clear();
    this.partIndex.clear();
    this.statics = [];
  }

  destroy() {
    this.clear();
    this.container.destroy();
  }
}

function ancestorHidden(parts: Part[], i: number, b: Built): boolean {
  let p = parts[i].parent;
  while (p >= 0) {
    if (parts[p].hidden || b.parts[p]?.over.visible === false) return true;
    p = parts[p].parent;
  }
  return false;
}

const zOf = (d: number) => Math.round(d * 1000);
const MAX_CONTEXTS = 4000;
/** Contexte vide partagé (jamais détruit) : posé avant de libérer les dessins en cache. */
const EMPTY = new GraphicsContext();

function inPoly(h: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = h.length - 2; i < h.length; j = i, i += 2) {
    const xi = h[i], yi = h[i + 1], xj = h[j], yj = h[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function placementMatrix(pl: Placement, out: M4): M4 {
  return m4Compose(out, pl.at[0], pl.at[1], pl.at[2], pl.rot[0], pl.rot[1], pl.rot[2], pl.scale[0], pl.scale[1], pl.scale[2]);
}

function radiusOf(model: Model): number {
  const offs = new Float32Array(model.parts.length * STRIDE);
  for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
  const w = new Float32Array(model.parts.length * 16);
  forward(model, offs, m4(), w, m4());
  let r = 0.15;
  model.parts.forEach((p, i) => {
    if (!p.shape) return;
    r = Math.max(r, Math.min(3, Math.hypot(w[i * 16 + 12], w[i * 16 + 14]) + Math.min(p.shape.a[0] ?? 0.1, 1) * 0.6));
  });
  return r * 0.85;
}
