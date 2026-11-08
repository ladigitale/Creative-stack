/**
 * Rendu Pixi natif d'un `monde2d` (src/shared/monde2d) : formes vectorielles dessinées pour la 2D (aplats,
 * dégradés, motifs, relief, contours), calques à parallaxe, instances articulées et animées.
 *
 * Performance : chaque pièce de modèle est dessinée une fois par couleur (`GraphicsContext` partagé entre toutes
 * les instances) ; à chaque image, seules les affines des pièces animées changent. Le décor sans nom est dessiné une
 * fois, en un `Graphics` par copie. Rien ne bouge, rien n'est recalculé.
 *
 * Modèles `gen` : dessinés par procgen en illustration vectorielle (module chargé à la demande) sur un canvas par
 * instance, posé en sprite ; le personnage est redessiné à chaque image où il bouge (pose du moteur procgen + pistes
 * d'os des clips du format). Le cap vient de `rz` en vue de dessus (le dessin tourne, pas l'image) et de `flip` de profil.
 */
import { BufferImageSource, CanvasSource, Container, FillGradient, FillPattern, Graphics, GraphicsContext, Matrix, Sprite, Text, Texture } from "pixi.js";
import { shade } from "../../shared/monde/math";
import { TEX_SIZE, texKey, texPixels, type TexSpec } from "../../shared/monde/textures";
import { partColor2, partTex2, STRIDE2, type Model2, type Monde2d, type Part2, type Placement2 } from "../../shared/monde2d/format";
import { Monde2dDriver, type Inst2 } from "../../shared/monde2d/driver";
import { aliasBone, GEN_MOTION } from "../../shared/monde/gen";
import { samplePose } from "../../shared/monde/pose";
import type { GenSprite } from "../procgen/index";
import { loadProcgen, type ProcgenApi } from "../../shared/procgen-loader";

type ProcgenMod = ProcgenApi;
type GenView = { sprite: GenSprite | null; spr: Sprite | null; tex: Texture | null; bones: (string | null)[]; offs: Float32Array; last: [number, number] | null };

type PartView = { g: Graphics | Text; key: string };
type Built = { inst: Inst2; holder: Container; parts: (PartView | null)[]; shadow: Graphics | null; rolesRev: number; overRev: number; world: Float32Array; gen: GenView | null };

const MAX_CONTEXTS = 3000;
const RAD = Math.PI / 180;

const textures = new Map<string, Texture>();
const patterns = new Map<string, FillPattern>();
function patternOf(t: TexSpec, base: string): FillPattern {
  const key = `${texKey(t, base)}|${t.scale}|${t.angle}`;
  let pat = patterns.get(key);
  if (!pat) {
    let tx = textures.get(texKey(t, base));
    if (!tx) {
      const source = new BufferImageSource({ resource: texPixels(t, base), width: TEX_SIZE, height: TEX_SIZE });
      source.style.addressMode = "repeat";
      tx = new Texture({ source });
      // borne : on oublie les plus anciennes (les dessins qui les utilisent les gardent en vie)
      if (textures.size > 256) textures.clear();
      textures.set(texKey(t, base), tx);
    }
    // `scale` = motifs pour 100 px
    pat = new FillPattern({ texture: tx, repetition: "repeat", textureSpace: "global" });
    const k = 100 / (TEX_SIZE * t.scale);
    pat.setTransform(new Matrix().rotate(t.angle * RAD).scale(k, k));
    if (patterns.size > 256) patterns.clear();
    patterns.set(key, pat);
  }
  return pat;
}

function centroid(pts: number[]): [number, number, number] {
  let cx = 0, cy = 0, r = 0;
  const n = pts.length / 2;
  for (let i = 0; i < pts.length; i += 2) {
    cx += pts[i];
    cy += pts[i + 1];
  }
  cx /= n;
  cy /= n;
  for (let i = 0; i < pts.length; i += 2) r = Math.max(r, Math.hypot(pts[i] - cx, pts[i + 1] - cy));
  return [cx, cy, r];
}

function scaled(pts: number[], cx: number, cy: number, k: number, dx: number, dy: number): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = cx + (pts[i] - cx) * k + dx;
    out[i + 1] = cy + (pts[i + 1] - cy) * k + dy;
  }
  return out;
}

/** Dessin d'une pièce (repère de la pièce) selon le style du monde. */
function drawPart(ctx: GraphicsContext, m: Monde2d, p: Part2, color: string, gradients: FillGradient[]) {
  const s = p.shape!;
  const base = p.shade ? shade(color, p.shade) : color;
  const fillColor = p.glow > 0 ? shade(base, p.glow * 0.35) : m.style === "encre" ? shade(base, 0.25) : base;
  const lineW = p.line >= 0 ? p.line : p.glow > 0 ? 0 : m.outline;
  const strokeColor = p.stroke || (m.style === "encre" || m.style === "bd" ? "#111827" : shade(base, -0.55));
  if (!s.closed || !p.fill) {
    ctx.poly(s.pts, s.closed).stroke({ color: p.stroke || fillColor, width: Math.max(0.5, p.line >= 0 ? p.line : 2), cap: "round", join: "round" });
    return;
  }
  const relief = (p.relief ?? m.relief) && p.glow <= 0;
  const [cx, cy, r] = centroid(s.pts);
  if (relief) {
    // ombre propre : la forme pleine plus sombre, recouverte par la forme claire légèrement décalée vers la lumière
    ctx.poly(s.pts, true).fill({ color: shade(fillColor, -0.28) });
    const d = Math.min(r * 0.12, 6);
    ctx.poly(scaled(s.pts, cx, cy, 0.9, -d * 0.6, -d * 0.8), true);
  } else ctx.poly(s.pts, true);
  if (p.tex) ctx.fill({ fill: patternOf(p.tex, fillColor) });
  else if (p.grad) {
    const a = p.gradAngle * RAD;
    const g = new FillGradient({
      type: "linear",
      start: { x: 0.5 - Math.sin(a) * 0.5, y: 0.5 - Math.cos(a) * 0.5 },
      end: { x: 0.5 + Math.sin(a) * 0.5, y: 0.5 + Math.cos(a) * 0.5 },
      colorStops: [
        { offset: 0, color: p.shade ? shade(p.grad[0], p.shade) : p.grad[0] },
        { offset: 1, color: p.shade ? shade(p.grad[1], p.shade) : p.grad[1] },
      ],
      textureSpace: "local",
    });
    gradients.push(g);
    ctx.fill({ fill: g });
  } else ctx.fill({ color: fillColor, alpha: 1 });
  if (relief && r > 3) {
    const d = r * 0.18;
    ctx.poly(scaled(s.pts, cx, cy, 0.38, -d, -d * 1.2), true).fill({ color: shade(fillColor, 0.45), alpha: m.style === "gouache" ? 0.22 : 0.3 });
  }
  if (lineW > 0) ctx.poly(s.pts, true).stroke({ color: strokeColor, width: lineW, join: "round", alpha: m.style === "doux" ? 0.55 : 0.95 });
}

/** Matrice 2D (a, b, c, d, tx, ty) : produit o = A × B. */
function mul(o: Float32Array, oi: number, A: ArrayLike<number>, ai: number, B: ArrayLike<number>, bi: number) {
  const a = A[ai], b = A[ai + 1], c = A[ai + 2], d = A[ai + 3], tx = A[ai + 4], ty = A[ai + 5];
  const a2 = B[bi], b2 = B[bi + 1], c2 = B[bi + 2], d2 = B[bi + 3], tx2 = B[bi + 4], ty2 = B[bi + 5];
  o[oi] = a * a2 + c * b2;
  o[oi + 1] = b * a2 + d * b2;
  o[oi + 2] = a * c2 + c * d2;
  o[oi + 3] = b * c2 + d * d2;
  o[oi + 4] = a * tx2 + c * ty2 + tx;
  o[oi + 5] = b * tx2 + d * ty2 + ty;
}

const ID = new Float32Array([1, 0, 0, 1, 0, 0]);

/** Affines (repère de l'instance) de toutes les pièces : 6 nombres par pièce. */
const LOC = new Float32Array(6);
function forward2(model: Model2, offs: Float32Array | null, out: Float32Array) {
  const loc = LOC;
  const parts = model.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const o = i * STRIDE2;
    const r = p.rot + (offs ? offs[o] : 0);
    const s = offs ? offs[o + 3] : 1;
    const sx = p.scale[0] * s * (offs ? offs[o + 4] : 1), sy = p.scale[1] * s * (offs ? offs[o + 5] : 1);
    const cs = Math.cos(r), sn = Math.sin(r);
    loc[0] = cs * sx;
    loc[1] = sn * sx;
    loc[2] = -sn * sy;
    loc[3] = cs * sy;
    loc[4] = p.at[0] + (offs ? offs[o + 1] : 0);
    loc[5] = p.at[1] + (offs ? offs[o + 2] : 0);
    mul(out, i * 6, p.parent >= 0 ? out : ID, p.parent >= 0 ? p.parent * 6 : 0, loc, 0);
  }
}

export class Monde2dRenderer {
  readonly driver = new Monde2dDriver();
  /** Conteneurs par calque (rattachés à la scène par le composant). */
  readonly layers = new Map<string, Container>();
  readonly sky = new Container();
  private monde: Monde2d | null = null;
  private built = new Map<string, Built>();
  private contexts = new Map<string, GraphicsContext>();
  /** Dessins partagés : nombre de Graphics qui les affichent, dégradés à libérer avec eux. */
  private refs = new Map<GraphicsContext, number>();
  private grads = new Map<GraphicsContext, FillGradient[]>();
  private nextRecycle = MAX_CONTEXTS;
  private skyGrad: FillGradient | null = null;
  private ysort = new Map<string, boolean>();
  private mat = new Matrix();
  private pg: ProcgenMod | null = null;
  private pgLoad: Promise<void> | null = null;
  private jobs: { token: number; run: () => void }[] = [];
  private jobTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private token = 0;
  private lastStep = 0;
  private genTex: Texture[] = [];

  constructor(
    private invalidate: () => void,
    private attach: (c: Container, layer: string) => void,
    private size: () => [number, number],
  ) {
    this.sky.label = "monde2d:ciel";
  }

  get instanceCount(): number {
    return this.built.size;
  }

  get issues() {
    return this.monde?.issues ?? [];
  }

  has(name: string): boolean {
    return this.driver.has(name);
  }

  private layer(name: string): Container {
    let c = this.layers.get(name);
    if (!c) {
      c = new Container({ sortableChildren: true });
      c.label = `monde2d:${name}`;
      this.layers.set(name, c);
      this.attach(c, name);
    }
    return c;
  }

  private context(key: string, m: Monde2d, p: Part2, color: string): GraphicsContext {
    let ctx = this.contexts.get(key);
    if (!ctx) {
      if (this.contexts.size > this.nextRecycle) this.recycle();
      ctx = new GraphicsContext();
      const gradients: FillGradient[] = [];
      drawPart(ctx, m, p, color, gradients);
      if (gradients.length) this.grads.set(ctx, gradients);
      this.contexts.set(key, ctx);
      this.refs.set(ctx, 0);
    }
    return ctx;
  }

  /** Pose un dessin partagé sur un Graphics (compte des références). */
  private use(g: Graphics, ctx: GraphicsContext) {
    const old = g.context;
    if (old === ctx) return;
    if (this.refs.has(old)) this.refs.set(old, this.refs.get(old)! - 1);
    this.refs.set(ctx, (this.refs.get(ctx) ?? 0) + 1);
    g.context = ctx;
  }

  private release(c: GraphicsContext) {
    this.refs.delete(c);
    for (const g of this.grads.get(c) ?? []) g.destroy();
    this.grads.delete(c);
    c.destroy();
  }

  /** Trop de dessins en cache : seuls ceux qu'aucune pièce n'affiche sont libérés. */
  private recycle() {
    for (const [k, c] of this.contexts) if (!this.refs.get(c)) {
      this.contexts.delete(k);
      this.release(c);
    }
    this.nextRecycle = Math.max(MAX_CONTEXTS, this.contexts.size * 2);
  }

  set(m: Monde2d, now: number) {
    this.clearScene();
    this.token++;
    this.monde = m;
    this.ysort = new Map(m.layers.map((l) => [l.name, l.ysort]));
    this.drawSky(m);
    this.driver.setMonde(m, now);
    for (const pl of m.place) if (!pl.name && !pl.hidden) this.buildStatic(m, pl);
    for (const inst of this.driver.instances.values()) this.buildInstance(m, inst);
    this.step(now, true);
    this.invalidate();
  }

  private clearSky() {
    this.sky.removeChildren().forEach((c) => c.destroy({ context: true }));
    this.skyGrad?.destroy();
    this.skyGrad = null;
  }

  private drawSky(m: Monde2d) {
    this.clearSky();
    if (!m.ciel) return;
    const [w, h] = this.size();
    const g = new Graphics();
    this.skyGrad = new FillGradient({ type: "linear", start: { x: 0, y: 0.33 }, end: { x: 0, y: 0.66 }, colorStops: [{ offset: 0, color: m.ciel[0] }, { offset: 1, color: m.ciel[1] }], textureSpace: "local" });
    g.rect(-w * 2, -h * 2, w * 5, h * 5).fill({ fill: this.skyGrad });
    this.sky.addChild(g);
    this.invalidate();
  }

  /** Ordre de dessin : par y sur un calque trié (`ysort`), sinon par `z` puis rang d'écriture du placement. */
  private zOf(_m: Monde2d, layer: string, y: number, z: number, order: number): number {
    return this.ysort.get(layer) ? y * 10 + z : z * 1e5 + order;
  }

  /** Exécute `fn` avec le module procgen (chargé à la demande), par tranches pour garder la page fluide. */
  private withProcgen(fn: (pg: ProcgenMod) => void) {
    this.jobs.push({ token: this.token, run: () => fn(this.pg!) });
    if (this.pg) return this.schedule();
    this.pgLoad ??= loadProcgen().then(
      (mod) => {
        this.pg = mod;
        this.schedule();
      },
      (err) => {
        this.monde?.issues.push({ path: "", message: `procgen indisponible : ${err instanceof Error ? err.message : String(err)}` });
        this.jobs = [];
      },
    );
  }

  private schedule() {
    if (this.jobTimer || !this.jobs.length || !this.pg) return;
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
      if (ran) this.invalidate();
      this.schedule();
    }, 0);
  }

  private makeGenSprite(pg: ProcgenMod, m: Monde2d, model: Model2, roles: Record<string, string> | undefined): { sprite: GenSprite; spr: Sprite; tex: Texture } {
    const g = model.gen!;
    const sprite = new pg.GenSprite({ id: g.id, params: g.params, seed: g.seed }, { view: g.view, pxPerM: g.pxPerM, resolution: 2, style: m.styleGen, pitch: g.pitch });
    for (const i of sprite.issues.slice(0, 8)) {
      const path = `models.${model.name}.${i.path}`;
      if (!m.issues.some((x) => x.path === path && x.message === i.message)) m.issues.push({ path, message: i.message });
    }
    sprite.setRoles(roles);
    sprite.draw(0, null);
    const tex = new Texture({ source: new CanvasSource({ resource: sprite.canvas as HTMLCanvasElement, autoGenerateMipmaps: false }) });
    this.genTex.push(tex);
    const spr = new Sprite(tex);
    spr.anchor.set(sprite.anchor[0] / Math.max(1, sprite.canvas.width), sprite.anchor[1] / Math.max(1, sprite.canvas.height));
    spr.scale.set(1 / 2);
    return { sprite, spr, tex };
  }

  private buildStatic(m: Monde2d, pl: Placement2) {
    const model = m.models.get(pl.model)!;
    if (model.gen) {
      const holder = new Container();
      holder.label = `${model.name}~decor`;
      holder.position.set(pl.at[0], pl.at[1]);
      holder.rotation = model.gen.view === "profil" || model.gen.view === "face" ? pl.rot : 0;
      holder.scale.set(pl.scale[0] * (pl.flip ? -1 : 1), pl.scale[1]);
      holder.zIndex = this.zOf(m, pl.layer, pl.at[1], pl.z, pl.order);
      this.layer(pl.layer).addChild(holder);
      this.withProcgen((pg) => {
        if (holder.destroyed) return;
        const { spr } = this.makeGenSprite(pg, m, model, pl.roles);
        holder.addChild(spr);
      });
      return;
    }
    const world = new Float32Array(model.parts.length * 6);
    forward2(model, null, world);
    const g = new Container();
    g.label = `${model.name}~decor`;
    const order = model.parts.map((p, i) => ({ p, i })).filter((o) => o.p.shape && !o.p.hidden).sort((a, b) => a.p.z - b.p.z);
    for (const { p, i } of order) {
      const color = partColor2(model, p, pl.roles, m.palette);
      const sub = this.partView(m, model, p, i, color, partTex2(m, p));
      sub.g.setFromMatrix(this.mat.set(world[i * 6], world[i * 6 + 1], world[i * 6 + 2], world[i * 6 + 3], world[i * 6 + 4], world[i * 6 + 5]));
      sub.g.alpha = p.opacity;
      g.addChild(sub.g);
    }
    g.position.set(pl.at[0], pl.at[1]);
    g.rotation = pl.rot;
    g.scale.set(pl.scale[0] * (pl.flip ? -1 : 1), pl.scale[1]);
    g.zIndex = this.zOf(m, pl.layer, pl.at[1], pl.z, pl.order);
    this.layer(pl.layer).addChild(g);
  }

  private partView(m: Monde2d, model: Model2, p: Part2, i: number, color: string, tex: TexSpec | null): PartView {
    if (p.shape!.kind === "text") {
      const t = new Text({ text: p.shape!.text ?? "", style: { fill: color, fontSize: p.shape!.size ?? 16, fontWeight: "900", fontFamily: "system-ui, sans-serif", stroke: { color: shade(color, -0.7), width: Math.max(1, (p.shape!.size ?? 16) * 0.12) } } });
      t.anchor.set(0.5);
      const [cx, cy] = centroid(p.shape!.pts);
      t.pivot.set(-cx, -cy);
      return { g: t, key: "" };
    }
    const key = `${model.name}#${i}|${color}|${tex ? texKey(tex, "") : ""}`;
    const g = new Graphics();
    this.use(g, this.context(key, m, { ...p, tex }, color));
    return { g, key };
  }

  private buildInstance(m: Monde2d, inst: Inst2) {
    const holder = new Container({ sortableChildren: true });
    holder.label = inst.name;
    const model = inst.model;
    if (model.gen) {
      const g = model.gen;
      const gv: GenView = { sprite: null, spr: null, tex: null, bones: g.model3.parts.map((p) => aliasBone(p.name)), offs: new Float32Array(g.model3.parts.length * 7), last: null };
      this.layer(inst.placement.layer).addChild(holder);
      const b: Built = { inst, holder, parts: [], shadow: null, rolesRev: inst.rolesRev, overRev: inst.overRev, world: new Float32Array(0), gen: gv };
      this.built.set(inst.name, b);
      this.withProcgen((pg) => {
        if (this.built.get(inst.name) !== b) return;
        const r = this.makeGenSprite(pg, m, model, inst.roles);
        gv.sprite = r.sprite;
        gv.spr = r.spr;
        gv.tex = r.tex;
        b.rolesRev = inst.rolesRev;
        holder.addChild(r.spr);
      });
      return;
    }
    const parts: (PartView | null)[] = model.parts.map((p, i) => {
      if (!p.shape) return null;
      const pv = this.partView(m, model, p, i, partColor2(model, p, inst.roles, m.palette), partTex2(m, p));
      pv.g.zIndex = p.z;
      holder.addChild(pv.g);
      return pv;
    });
    let shadow: Graphics | null = null;
    const h = model.height;
    if (h > 0) {
      // ombre au sol (ellipse) sous l'instance, dessinée une fois
      shadow = new Graphics();
      const [rx, ry] = model.shadow ?? [h * 0.32, h * 0.09];
      shadow.ellipse(model.shadow ? h * 0.03 : 0, 0, rx, ry).fill({ color: "#000000", alpha: 0.22 });
      shadow.zIndex = -1000;
      holder.addChild(shadow);
    }
    this.layer(inst.placement.layer).addChild(holder);
    this.built.set(inst.name, { inst, holder, parts, shadow, rolesRev: -1, overRev: -1, world: new Float32Array(model.parts.length * 6), gen: null });
  }

  apply(name: string, p: unknown, now: number, animate: boolean): boolean {
    return this.driver.apply(name, p, now, animate);
  }

  step(now: number, force = false): boolean {
    const m = this.monde;
    if (!m) return false;
    let busy = this.driver.step(now);
    let drew = false;
    const dt = this.lastStep ? Math.min(0.1, Math.max(0, (now - this.lastStep) / 1000)) : 0;
    this.lastStep = now;
    for (const b of this.built.values()) {
      const inst = b.inst;
      if (b.gen) {
        const r = this.stepGen(m, b, now, dt, force);
        drew = r.drew || drew;
        busy = r.busy || busy;
        continue;
      }
      const recolor = b.rolesRev !== inst.rolesRev || b.overRev !== inst.overRev;
      if (!force && !recolor && !inst.poseChanged && !inst.transformDirty) continue;
      drew = true;
      const model = inst.model;
      if (recolor) {
        b.rolesRev = inst.rolesRev;
        b.overRev = inst.overRev;
        model.parts.forEach((p, i) => {
          const pv = b.parts[i];
          if (!pv) return;
          const o = inst.over.get(i);
          const color = o?.color ?? partColor2(model, p, inst.roles, m.palette);
          if (pv.g instanceof Text) pv.g.style.fill = color;
          else {
            const tex = partTex2(m, p);
            const key = `${model.name}#${i}|${color}|${tex ? texKey(tex, "") : ""}`;
            if (key !== pv.key) {
              pv.key = key;
              this.use(pv.g, this.context(key, m, { ...p, tex }, color));
            }
          }
          pv.g.visible = !p.hidden && o?.visible !== false;
        });
      }
      if (inst.poseChanged || force || recolor) {
        inst.poseChanged = false;
        forward2(model, inst.offs, b.world);
        const w = b.world;
        for (let i = 0; i < model.parts.length; i++) {
          const pv = b.parts[i];
          if (!pv) continue;
          pv.g.setFromMatrix(this.mat.set(w[i * 6], w[i * 6 + 1], w[i * 6 + 2], w[i * 6 + 3], w[i * 6 + 4], w[i * 6 + 5]));
          pv.g.alpha = model.parts[i].opacity * inst.offs[i * STRIDE2 + 6] * (inst.over.get(i)?.opacity ?? 1);
        }
      }
      if (inst.transformDirty || force) {
        inst.transformDirty = false;
        const t = inst.t, hld = b.holder;
        hld.position.set(t.x, t.y - inst.liftY);
        hld.rotation = t.rz;
        hld.scale.set(t.sx * (inst.flip ? -1 : 1), t.sy);
        hld.alpha = t.opacity;
        hld.visible = inst.visible;
        hld.zIndex = this.zOf(m, inst.placement.layer, t.y, inst.z, inst.placement.order);
        if (b.shadow) {
          // l'ombre reste au sol pendant un saut (`lift`)
          b.shadow.position.set(0, inst.liftY / Math.max(0.01, Math.abs(t.sy)));
          b.shadow.alpha = Math.max(0.3, 1 - inst.liftY / 120);
        }
      }
    }
    if (drew) this.invalidate();
    return busy;
  }

  /** Acteur procgen : cap, foulée, clip → pose ; redessin du canvas si la pose a changé. */
  private stepGen(m: Monde2d, b: Built, now: number, dt: number, force: boolean): { drew: boolean; busy: boolean } {
    const inst = b.inst, gv = b.gen!, g = inst.model.gen!;
    const t = inst.t, hld = b.holder;
    let drew = false;
    const top = g.view === "dessus" || g.view === "plongee";
    if (inst.transformDirty || force) {
      inst.transformDirty = false;
      hld.position.set(t.x, t.y - inst.liftY);
      hld.rotation = top ? 0 : t.rz;
      hld.scale.set(t.sx, t.sy);
      hld.alpha = t.opacity;
      hld.visible = inst.visible;
      hld.zIndex = this.zOf(m, inst.placement.layer, t.y, inst.z, inst.placement.order);
      drew = true;
    }
    const sp = gv.sprite;
    if (!sp || !hld.visible) return { drew, busy: false };
    if (b.rolesRev !== inst.rolesRev) {
      b.rolesRev = inst.rolesRev;
      sp.setRoles(inst.roles);
      if (sp.draw(0, null)) gv.tex!.source.update();
      drew = true;
    }
    if (!sp.animated) return { drew, busy: false };
    const moved = gv.last ? Math.hypot(t.x - gv.last[0], t.y - gv.last[1]) / g.pxPerM : 0;
    gv.last = [t.x, t.y];
    samplePose(g.model3, inst.clip, now, gv.offs);
    const bones = new Map<string, [number, number, number]>();
    let rootOff: [number, number, number] = [0, 0, 0];
    const o = gv.offs;
    gv.bones.forEach((bone, i) => {
      if (!bone) return;
      const k = i * 7;
      if (o[k] || o[k + 1] || o[k + 2]) bones.set(bone, [o[k], o[k + 1], o[k + 2]]);
      if (bone === "root") rootOff = [o[k + 3], o[k + 4], o[k + 5]];
    });
    const clip = inst.clip.clip;
    const mo = Object.prototype.hasOwnProperty.call(GEN_MOTION, clip) ? GEN_MOTION[clip] : undefined;
    // cap : de dessus, `rz` (regard +x à 0, y vers le bas) ; de profil, `flip` ; de face, face à l'écran
    const yaw = top ? Math.PI / 2 - t.rz : g.view === "face" ? 0 : inst.flip ? -Math.PI / 2 : Math.PI / 2;
    if (sp.draw(dt, { clipSpeed: (mo?.speed ?? 0) * (inst.clip.speed || 1), action: mo?.action ?? "idle", moved, yaw, bones, rootOff })) {
      gv.tex!.source.update();
      drew = true;
    }
    return { drew, busy: true };
  }

  /** Instance (et pièce) sous un point du calque `layer`. */
  pick(layer: string, x: number, y: number): { instance: string; part: string } | null {
    let best: { instance: string; part: string; z: number } | null = null;
    for (const b of this.built.values()) {
      if (!b.holder.visible || b.inst.placement.layer !== layer) continue;
      if (b.gen) {
        const spr = b.gen.spr;
        if (spr && spr.containsPoint(spr.toLocal({ x, y }, b.holder.parent ?? undefined))) {
          const z = b.holder.zIndex * 1000 + 500;
          if (!best || z > best.z) best = { instance: b.inst.name, part: "", z };
        }
        continue;
      }
      const local = b.holder.toLocal({ x, y }, b.holder.parent ?? undefined);
      b.parts.forEach((pv, i) => {
        if (!pv || !pv.g.visible) return;
        const p = b.inst.model.parts[i];
        const lp = pv.g.toLocal(local, b.holder);
        // texte : centré sur son ancre, les points de la forme sont décalés de son centre
        if (pv.g instanceof Text) {
          const [cx, cy] = centroid(p.shape!.pts);
          lp.x += cx;
          lp.y += cy;
        }
        if (p.shape && p.shape.closed && inPoly(p.shape.pts, lp.x, lp.y)) {
          const z = b.holder.zIndex * 1000 + pv.g.zIndex;
          if (!best || z > best.z) best = { instance: b.inst.name, part: p.name, z };
        }
      });
    }
    const r = best as { instance: string; part: string } | null;
    return r ? { instance: r.instance, part: r.part } : null;
  }

  /** Vide la scène et libère le monde (plus rien ne s'anime). */
  clear() {
    this.clearScene();
    this.clearSky();
    this.driver.clear();
    this.monde = null;
  }

  /** Retire tout ce qui est dessiné ; l'état des instances (pilote) est gardé pour la reconstruction. */
  private clearScene() {
    // les dessins partagés sont détachés (contexte jetable) avant la destruction des pièces, puis libérés à part
    const detach = (c: { children: unknown[] }) => {
      for (const g of c.children) {
        if (g instanceof Graphics && this.refs.has(g.context)) g.context = new GraphicsContext();
        else if (g instanceof Container) detach(g);
      }
    };
    for (const c of this.layers.values()) {
      detach(c);
      for (const ch of c.removeChildren()) ch.destroy({ children: true, context: true });
    }
    this.built.clear();
    for (const t of this.genTex) t.destroy(true);
    this.genTex = [];
    for (const c of this.refs.keys()) this.release(c);
    this.contexts.clear();
    this.nextRecycle = MAX_CONTEXTS;
  }

  destroy() {
    this.clear();
    this.sky.destroy({ children: true });
    for (const c of this.layers.values()) c.destroy();
    this.layers.clear();
  }
}

function inPoly(h: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = h.length - 2; i < h.length; j = i, i += 2) {
    const xi = h[i], yi = h[i + 1], xj = h[j], yj = h[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
