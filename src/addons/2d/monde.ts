/**
 * Rendu Pixi d'un `monde` (src/shared/monde) dans `sonic-2d` : la même scène que `sonic-3d`, vue par une caméra
 * orthographique (`view2d` : dessus, profil, face, isométrique). Chaque pièce d'une instance nommée est une
 * silhouette (enveloppe convexe de sa forme) posée à chaque image par l'affine exacte de sa matrice monde ; la
 * silhouette n'est redessinée que si la pièce tourne assez pour changer de profil. Les décors sans nom sont
 * dessinés une fois (un `Graphics` par copie, pièces triées par profondeur).
 */
import { BufferImageSource, ColorMatrixFilter, Container, FillPattern, Graphics, GraphicsContext, Matrix, NoiseFilter, Texture } from "pixi.js";
import type { Grade } from "../../shared/monde/ambiance";
import { geometryOf } from "../../shared/monde/geometry";
import { m4, m4Compose, type M4, type V3 } from "../../shared/monde/math";
import { isColor, partColor, partTex, type Conflict, type Finish, type Model, type Monde, type Part, type Placement } from "../../shared/monde/format";
import { placedInfo, type PlacedInfo } from "../../shared/monde/arrange";
import type { Obb } from "../../shared/monde/collide";
import { envelopeOf } from "../../shared/monde/walk";
import { MondeDriver, type InstanceState } from "../../shared/monde/driver";
import { forward, STRIDE } from "../../shared/monde/pose";
import { TEX_SIZE, texKey, texPixels, type TexSpec } from "../../shared/monde/textures";
import { affineOf, basisOf, bucketDir, bucketOf, depthOf, groundPoint, hull as hull2, localDir, projOf, samplePoints, silhouette, type Proj } from "../../shared/monde/view2d";
import { shade } from "../../shared/monde/math";
import { isNum, patchOf } from "../../shared/nodes";
import { composeYP, EmitterSet, type EmitStats } from "../../shared/sim/set";
import { ParticleSet } from "../../shared/sim/particle-set";
import { loadRapier, RigidWorld, type ContactEvent, type RigidPose, type RigidState } from "../../shared/sim/rigid";
import { syncInfiniSims } from "../../shared/sim/infini-shapes";
import { GameProbe, type QueryResult } from "../../shared/sim/queries";
import { biomeAt, TileManager, type Tile } from "../../shared/monde/infini";
import { accelOf, positionAt, rampAt, rgbOf, unpackRgb, type V3 as PV3 } from "../../shared/sim/particles";
import type { Emitter, Hit } from "../../shared/sim/emitter";
import { m4Mul } from "../../shared/monde/math";

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

/** Copie dessinée d'un émetteur : une silhouette par pièce, contextes partagés avec les instances. */
type EmitView = { c: Container; parts: (Graphics | null)[]; buckets: number[]; variant: number };
type EmitDraw = { sim: Emitter; variants: { model: Model; roles: Record<string, string>; rest: Float32Array }[]; pool: EmitView[] };

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
function drawPart(g: Graphics | GraphicsContext, hull: number[], color: string, tex: TexSpec | null, glow: number, outline: number, unitPx: number, flat = false, f: Finish | null = null) {
  g.clear();
  if (hull.length < 6) return;
  // fini : opacité (verre, matière fumée), reflet plus franc pour le métal, le vernis et le verre, aucun pour le mat
  const alpha = f ? Math.min(f.opacity, 1 - f.glass * 0.6) : 1;
  g.poly(hull, true);
  if (tex) g.fill({ fill: patternOf(tex, color), alpha });
  else g.fill({ color, alpha });
  if (f && glow <= 0 && !flat && (f.metal > 0.3 || f.glass > 0 || f.clear > 0.3 || (f.rough >= 0 && f.rough < 0.3))) {
    let cx = 0, cy = 0, minY = Infinity, maxY = -Infinity;
    const n = hull.length / 2;
    for (let i = 0; i < hull.length; i += 2) {
      cx += hull[i];
      cy += hull[i + 1];
      minY = Math.min(minY, hull[i + 1]);
      maxY = Math.max(maxY, hull[i + 1]);
    }
    cx /= n;
    cy /= n;
    // métal : bord assombri, puis éclat clair resserré vers le haut ; verre : trait de lumière
    if (f.metal > 0.3) g.poly(hull, true).fill({ color: shade(color, -0.35), alpha: 0.35 * f.metal });
    const k = f.glass > 0 ? 0.35 : 0.45;
    const inner: number[] = [];
    for (let i = 0; i < hull.length; i += 2) inner.push(cx + (hull[i] - cx) * k, cy + (hull[i + 1] - cy) * k - (maxY - minY) * 0.18);
    g.poly(inner, true).fill({ color: shade(color, 0.75), alpha: f.glass > 0 ? 0.55 : 0.4 + 0.3 * (1 - Math.max(0, f.rough)) });
  } else if (glow <= 0 && !flat && !(f && f.rough > 0.8)) {
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

  /** Émetteurs (projectiles, nuées) : simulation partagée avec `sonic-3d`. */
  readonly emitters = new EmitterSet();
  /** Particules : un dessin par système, refait à chaque image (mouvement en forme close). */
  readonly particles = new ParticleSet();
  private particleViews: Graphics[] = [];
  private emitDraw: EmitDraw[] = [];
  private emitWorld = new Float32Array(16);
  private lastStep = 0;
  private lastStats = 0;
  /** Monde infini : tuiles chargées autour de l'instance suivie (sol coloré par biome, peuplement en silhouettes). */
  readonly infini = new TileManager();
  private tileViews = new Map<string, { c: Container; items: EmitView[] }>();
  private restOf = new Map<string, Float32Array>();
  private lastInfiniState = 0;
  onInfiniState: ((s: ReturnType<TileManager["state"]>) => void) | null = null;
  /** Requêtes (rayon, sphère, boîte) et capteurs. */
  readonly probe = new GameProbe();
  onQueries: ((r: Record<string, QueryResult>) => void) | null = null;
  onSensor: ((e: { type: "enter" | "leave"; sensor: string; instance: string; tags: string[] }) => void) | null = null;
  /** Physique 3D (Rapier), même simulation qu'en 3D, vue en projection. */
  rigid: RigidWorld | null = null;
  private rigidTok = 0;
  private lastPhysState = 0;
  private pendingForces: unknown = null;
  /** Premier état de `forces` reçu depuis la (re)construction : ses compteurs sont mémorisés, pas joués. */
  private firstForces: unknown = null;
  onContacts: ((c: ContactEvent[]) => void) | null = null;
  onRest: ((bodies: Record<string, RigidPose>) => void) | null = null;
  onPhysics: ((s: RigidState | { status: "loading" | "error"; error?: string }) => void) | null = null;
  /** Touches regroupées par image, copies expirées, état 10 fois par seconde. */
  onHits: ((hits: Hit[]) => void) | null = null;
  onExpire: ((e: { emitter: string; count: number }) => void) | null = null;
  onEmitStats: ((s: EmitStats) => void) | null = null;

  /** Résultat d'un rangement (`nodes.<instance>.move`, fin d'un glisser). */
  onPlaced: ((p: PlacedInfo) => void) | null = null;
  /** Conflits recalculés après un rangement. */
  onConflicts: ((c: Conflict[]) => void) | null = null;
  private marks: Graphics | null = null;
  private selection: Graphics | null = null;
  private selName = "";

  constructor(private invalidate: () => void) {
    this.container.sortableChildren = true;
    this.container.label = "monde";
    this.emitters.onHits = (h) => {
      this.rigid?.hits(h, (id) => this.emitters.sims.find((e) => e.spec.id === id)?.spec.push ?? 0);
      for (const hit of h) {
        const b = this.emitters.sims.find((e) => e.spec.id === hit.emitter)?.spec.burst;
        if (b) this.particles.impact(b, hit);
      }
      this.onHits?.(h);
    };
    this.particles.poseOf = (name) => {
      const inst = this.driver.instances.get(name);
      return inst && inst.visible ? { x: inst.t.x, y: inst.t.y, z: inst.t.z, ry: inst.t.ry } : null;
    };
    this.emitters.onExpire = (e) => this.onExpire?.(e);
  }

  /** Ordres `emit.<id>` du DataProvider. */
  applyEmit(spec: unknown): boolean {
    if (!this.monde) return false;
    const r = this.emitters.applyOrders(spec, this.driver);
    if (r) this.invalidate();
    return r;
  }

  get emitting(): boolean {
    return this.emitters.active || this.particles.active;
  }

  /**
   * Étalonnage en 2D : couleurs (saturation, contraste, luminosité, noir et blanc, sépia, teinte), silhouettes en
   * aplat sombre sur le ciel, grain. Pixels, contours, halo et vignette sont réservés à la 3D.
   */
  private applyGrade(g: Grade | null) {
    if (!g) {
      this.container.filters = [];
      return;
    }
    const cm = new ColorMatrixFilter();
    if (g.silhouette > 0.5) {
      cm.matrix = [0, 0, 0, 0, 0.03, 0, 0, 0, 0, 0.03, 0, 0, 0, 0, 0.035, 0, 0, 0, 1, 0];
    } else {
      // desaturate remplace la matrice : en premier, les réglages suivants se multiplient
      if (g.bw > 0.5) cm.desaturate();
      else if (g.saturation !== 1) cm.saturate(g.saturation - 1, true);
      if (g.sepia > 0.3) cm.sepia(true);
      if (g.contrast !== 1) cm.contrast(g.contrast - 1, true);
      if (g.brightness !== 1) cm.brightness(g.brightness, true);
      if (g.tint) cm.tint(parseInt(g.tint.slice(1), 16), true);
    }
    const filters: (ColorMatrixFilter | NoiseFilter)[] = [cm];
    if (g.grain > 0) filters.push(new NoiseFilter({ noise: Math.min(0.5, g.grain * 0.6) }));
    this.container.filters = filters;
  }

  /** Ordres `forces.<instance>` (physique). */
  applyForces(spec: unknown): boolean {
    this.pendingForces = spec;
    if (!this.rigid) {
      // moteur encore en chargement : le premier état sert de référence, les ordres suivants seront joués
      this.firstForces ??= spec;
      return false;
    }
    this.rigid.applyOrders(spec);
    this.invalidate();
    return true;
  }

  private mountRigid(m: Monde) {
    this.rigid?.dispose();
    this.rigid = null;
    const tok = ++this.rigidTok;
    if (!m.physics) return;
    // état des ordres connu à la (re)construction : référence des compteurs
    this.firstForces = this.pendingForces;
    this.onPhysics?.({ status: "loading" });
    loadRapier().then(
      (R) => {
        if (tok !== this.rigidTok || this.monde !== m) return;
        try {
          this.rigid = new RigidWorld(R, m, this.driver);
          // référence (premier état reçu ou état courant), puis ordres arrivés pendant le chargement
          const first = this.firstForces ?? this.pendingForces;
          if (first) this.rigid.applyOrders(first);
          if (this.pendingForces && this.pendingForces !== first) this.rigid.applyOrders(this.pendingForces);
          this.firstForces = null;
          this.invalidate();
        } catch (e) {
          this.onPhysics?.({ status: "error", error: e instanceof Error ? e.message : String(e) });
        }
      },
      (e) => this.onPhysics?.({ status: "error", error: `moteur : ${e instanceof Error ? e.message : String(e)}` }),
    );
  }

  /** Retouches du monde infini (`tiles."cx,cz"`). */
  applyTiles(v: unknown): void {
    this.infini.setEdits(v);
    this.invalidate();
  }

  private rest(model: Model): Float32Array {
    let r = this.restOf.get(model.name);
    if (!r) {
      const offs = new Float32Array(model.parts.length * STRIDE);
      for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
      r = new Float32Array(model.parts.length * 16);
      forward(model, offs, m4(), r, m4());
      this.restOf.set(model.name, r);
    }
    return r;
  }

  /** Tuiles chargées ↔ dessins : sol (carrés colorés par biome) et objets, créés à l'arrivée, détruits au départ. */
  private syncTiles(m: Monde) {
    const s = m.infini!;
    for (const [k, v] of this.tileViews)
      if (!this.infini.tiles.has(k)) {
        for (const it of v.items) {
          for (const g of it.parts) if (g) g.context = new GraphicsContext();
          it.c.destroy({ children: true });
        }
        v.c.destroy({ children: true });
        this.tileViews.delete(k);
      }
    const { unit, origin } = m.view2d;
    const pr = this.proj;
    const P = (x: number, y: number, z: number): [number, number] => [origin[0] + (pr.px[0] * x + pr.px[1] * y + pr.px[2] * z) * unit, origin[1] + (pr.py[0] * x + pr.py[1] * y + pr.py[2] * z) * unit];
    for (const t of this.infini.tiles.values()) {
      if (this.tileViews.has(t.key)) continue;
      const c = new Container();
      c.label = `infini~${t.key}`;
      const ground = new Graphics();
      const N = 6, T = s.tile, x0 = t.cx * T, z0 = t.cz * T;
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          const xa = x0 + (i / N) * T, xb = x0 + ((i + 1) / N) * T, za = z0 + (j / N) * T, zb = z0 + ((j + 1) / N) * T;
          const col = biomeAt(s, (xa + xb) / 2, (za + zb) / 2).color;
          const pts = [P(xa, 0, za), P(xb, 0, za), P(xb, 0, zb), P(xa, 0, zb)].flat();
          ground.poly(pts, true).fill({ color: col });
        }
      // le sol de la tuile reste sous tout ; ses objets sont triés par profondeur avec le reste du monde
      const items: EmitView[] = [];
      for (const it of t.items) {
        const model = m.models.get(it.model);
        if (!model) continue;
        const v = new Container();
        this.container.addChild(v);
        const view: EmitView = { c: v, parts: model.parts.map((p) => (p.shape && !p.hidden ? v.addChild(new Graphics()) : null)), buckets: model.parts.map(() => -1), variant: 0 };
        composeYP(this.root, it.x, it.y, it.z, it.ry, 0, it.s);
        this.poseRigid(view, model, {}, this.rest(model), m, it.s);
        items.push(view);
      }
      c.addChild(ground);
      c.zIndex = -1e9;
      this.container.addChild(c);
      this.tileViews.set(t.key, { c, items });
    }
  }

  /** Requêtes `queries.<id>` du DataProvider. */
  applyQueries(spec: unknown): boolean {
    if (!this.monde) return false;
    const r = this.probe.apply(spec, this.driver);
    if (r) this.onQueries?.(r);
    return !!r;
  }

  /** Ordres `fx.<id>` du DataProvider (salves de particules). */
  applyParticles(spec: unknown): boolean {
    if (!this.monde) return false;
    const r = this.particles.applyOrders(spec);
    if (r) this.invalidate();
    return r;
  }

  private mountParticles(m: Monde) {
    this.particles.set(m);
    this.particles.trailed = new Set(m.emitters.map((e) => e.trail).filter((t) => t));
    this.particleViews = this.particles.systems.map((sys) => {
      const g = new Graphics();
      g.label = `${sys.spec.id}~particles`;
      if (sys.spec.blend === "add") g.blendMode = "add";
      this.container.addChild(g);
      return g;
    });
  }

  /** Grains vivants projetés par la vue : disques, éclats, traits ; taille et couleur selon l'âge. */
  private drawParticles(m: Monde) {
    const { unit, origin } = m.view2d;
    const pr = this.proj;
    const pos: PV3 = [0, 0, 0], prev: PV3 = [0, 0, 0];
    const col = [0, 0, 0], tint = [0, 0, 0];
    this.particles.systems.forEach((sys, si) => {
      const g = this.particleViews[si];
      if (!g) return;
      g.clear();
      const s = sys.spec;
      const acc = accelOf(s, this.particles.vent);
      const ramp = s.color.map(rgbOf);
      const now = this.particles.now;
      let dsum = 0, dn = 0;
      for (let i = 0; i < s.max; i++) {
        const t = now - sys.born[i];
        const life = sys.life[i];
        if (t < 0 || t > life) continue;
        const k = t / life;
        positionAt(sys, i, t, acc, pos);
        const sx = origin[0] + (pr.px[0] * pos[0] + pr.px[1] * pos[1] + pr.px[2] * pos[2]) * unit;
        const sy = origin[1] + (pr.py[0] * pos[0] + pr.py[1] * pos[1] + pr.py[2] * pos[2]) * unit;
        const r = Math.max(0.5, ((s.size[0] + (s.size[1] - s.size[0]) * k) * sys.scale[i] * unit) / 2);
        rampAt(ramp, k, col);
        if (sys.tint[i] > 0) {
          unpackRgb(sys.tint[i], tint);
          for (let c = 0; c < 3; c++) col[c] = col[c] * 0.25 + tint[c] * 0.75;
        }
        const color = ((col[0] * 255) << 16) | ((col[1] * 255) << 8) | (col[2] * 255);
        const alpha = Math.max(0, Math.min(1, s.opacity[0] + (s.opacity[1] - s.opacity[0]) * k));
        if (alpha < 0.01) continue;
        if (s.sprite === "trait" || s.stretch > 0) {
          positionAt(sys, i, Math.max(0, t - 0.03 - s.stretch), acc, prev);
          const px = origin[0] + (pr.px[0] * prev[0] + pr.px[1] * prev[1] + pr.px[2] * prev[2]) * unit;
          const py = origin[1] + (pr.py[0] * prev[0] + pr.py[1] * prev[1] + pr.py[2] * prev[2]) * unit;
          g.moveTo(px, py).lineTo(sx, sy).stroke({ color, alpha, width: Math.max(1, r), cap: "round" });
        } else if (s.sprite === "eclat") {
          const a = s.spin * t * 6.283 + sys.seed[i] * 6.283;
          const c = Math.cos(a) * r, d = Math.sin(a) * r;
          g.poly([sx + c, sy + d, sx - d * 0.6, sy + c * 0.6, sx - c, sy - d, sx + d * 0.6, sy - c * 0.6], true).fill({ color, alpha });
        } else g.circle(sx, sy, r).fill({ color, alpha: s.sprite === "volute" ? alpha * 0.8 : alpha });
        dsum += depthOf(pr, pos[0], pos[1], pos[2]);
        dn++;
      }
      // un seul dessin par système : placé à la profondeur moyenne de ses grains (devant pour la lumière)
      g.zIndex = dn ? zOf(dsum / dn) + (s.blend === "add" ? 2000 : 0) : 0;
    });
  }

  private mountEmitters(m: Monde) {
    this.emitters.set(m, this.driver);
    this.emitDraw = this.emitters.sims.map((sim) => ({
      sim,
      variants: sim.spec.variants.map((v) => {
        const model = m.models.get(v.model)!;
        const offs = new Float32Array(model.parts.length * STRIDE);
        for (let i = 6; i < offs.length; i += STRIDE) offs[i] = 1;
        const rest = new Float32Array(model.parts.length * 16);
        forward(model, offs, m4(), rest, m4());
        return { model, roles: v.roles, rest };
      }),
      pool: [],
    }));
  }

  /** Silhouettes des copies : une par pièce, posée par l'affine de sa matrice monde (comme une instance nommée). */
  private drawEmitters(m: Monde) {
    const { unit, origin } = m.view2d;
    for (const d of this.emitDraw) {
      const s = d.sim;
      for (let i = 0; i < s.n; i++) {
        const vi = d.variants.length > 1 ? s.variant[i] % d.variants.length : 0;
        const v = d.variants[vi];
        let view = d.pool[i];
        if (!view || view.variant !== vi) {
          if (view) view.c.destroy({ children: true });
          const c = new Container();
          c.label = `${s.spec.id}~emit`;
          this.container.addChild(c);
          view = { c, parts: v.model.parts.map((p) => (p.shape && !p.hidden ? c.addChild(new Graphics()) : null)), buckets: v.model.parts.map(() => -1), variant: vi };
          d.pool[i] = view;
        }
        view.c.visible = true;
        composeYP(this.root, s.px[i], s.py[i], s.pz[i], s.heading(i), s.pitch(i), s.size[i]);
        this.poseRigid(view, v.model, v.roles, v.rest, m, s.size[i] || 1);
      }
      for (let i = s.n; i < d.pool.length; i++) d.pool[i].c.visible = false;
    }
  }

  /**
   * Pose une copie rigide (émise ou peuplant le monde infini) : `this.root` est sa matrice ; une silhouette par pièce,
   * dessins partagés par modèle, pièce, direction et couleur.
   */
  private poseRigid(view: EmitView, model: Model, roles: Record<string, string>, rest: Float32Array, m: Monde, size: number) {
    const { unit, origin } = m.view2d;
    let zmax = -Infinity;
    model.parts.forEach((p, k) => {
      const g = view.parts[k];
      if (!g) return;
      const w = this.emitWorld;
      m4Mul(w, this.root, rest.subarray(k * 16, k * 16 + 16));
      localDir(w, this.proj.dir, this.dir);
      const bucket = bucketOf(this.dir);
      const color = partColor(model, p, roles, m.palette);
      const [u, vv] = basisOf(bucketDir(bucket));
      if (bucket !== view.buckets[k]) {
        view.buckets[k] = bucket;
        let byBucket = this.hulls.get(p);
        if (!byBucket) this.hulls.set(p, (byBucket = new Map()));
        let hull = byBucket.get(bucket);
        if (!hull) {
          const pts = this.pointsOf(p, m.detail);
          if (!pts) return;
          hull = silhouette(pts, u, vv);
          byBucket.set(bucket, hull);
        }
        const key = `${model.name}#${k}|${bucket}|${color}`;
        let ctx = this.contexts.get(key);
        if (!ctx) {
          ctx = new GraphicsContext();
          drawPart(ctx, hull, color, partTex(m, p), p.glow, m.outline, unit * size, p.shape?.kind === "plane", p.finish);
          this.contexts.set(key, ctx);
        }
        g.context = ctx;
      }
      affineOf(w, u, vv, this.proj, unit, origin[0], origin[1], this.aff);
      g.setFromMatrix(this.mat.set(this.aff[0], this.aff[1], this.aff[2], this.aff[3], this.aff[4], this.aff[5]));
      const z = depthOf(this.proj, w[12], w[13], w[14]);
      zmax = Math.max(zmax, z);
    });
    view.c.zIndex = zOf(zmax);
  }

  get issues() {
    return this.monde?.issues ?? [];
  }

  set(m: Monde, now: number) {
    this.clear();
    this.monde = m;
    this.proj = projOf(m.view2d.view);
    this.driver.setMonde(m, now);
    this.mountRigid(m);
    this.applyGrade(m.grade);
    this.buildStatics(m);
    for (const inst of this.driver.instances.values()) this.buildInstance(m, inst);
    this.mountEmitters(m);
    this.mountParticles(m);
    this.probe.set(m);
    this.infini.set(m.infini);
    this.step(now, true);
    this.drawMarks(m.marks);
    this.drawSelection();
    this.invalidate();
  }

  /** Instance sélectionnée (contour bleu ; vide : aucune). */
  select(name: string): void {
    this.selName = name;
    this.drawSelection();
  }

  /** Haut de la sélection dans le canvas (pixels de la scène), `null` sans sélection. */
  selectionTop(): { x: number; y: number } | null {
    if (!this.selection) return null;
    const b = this.selection.getBounds();
    return { x: b.x + b.width / 2, y: b.y };
  }

  private drawSelection(): void {
    if (this.selection) {
      this.selection.destroy();
      this.selection = null;
    }
    const body = this.selName && this.monde ? this.driver.bodies().find((b) => b.name === this.selName) : undefined;
    if (!body) return;
    const e = envelopeOf(body);
    this.selection = this.outline([{ ...e, h: [e.h[0] + 0.02, e.h[1] + 0.02, e.h[2] + 0.02] }], "#2f7bf6", 2.5, 1e9 + 1);
  }

  /** Contours rouges (projetés) des boîtes en conflit, par-dessus la scène. */
  private drawMarks(boxes: Obb[]) {
    if (this.marks) {
      this.marks.destroy();
      this.marks = null;
    this.selection = null;
    }
    this.marks = this.outline(boxes, "#ff2d2d", 1.5, 1e9);
  }

  /** Contours projetés de boîtes orientées, ajoutés à la scène (null : rien à dessiner). */
  private outline(boxes: Obb[], color: string, width: number, z: number): Graphics | null {
    const m = this.monde;
    if (!m || !boxes.length) return null;
    const g = new Graphics();
    g.zIndex = z;
    const { unit, origin } = m.view2d;
    const P = this.proj;
    for (const b of boxes) {
      const pts: number[] = [];
      for (let i = 0; i < 8; i++) {
        const s = [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1];
        const c = [0, 1, 2].map((a) => b.c[a] + s[0] * b.ax[0][a] * b.h[0] + s[1] * b.ax[1][a] * b.h[1] + s[2] * b.ax[2][a] * b.h[2]);
        pts.push(origin[0] + (P.px[0] * c[0] + P.px[1] * c[1] + P.px[2] * c[2]) * unit, origin[1] + (P.py[0] * c[0] + P.py[1] * c[1] + P.py[2] * c[2]) * unit);
      }
      const h = hull2(pts);
      if (h.length >= 6) g.poly(h, true).stroke({ color, width, alpha: 0.9 });
    }
    this.container.addChild(g);
    return g;
  }

  /** Instance déplaçable sous un point du calque (vide : aucune) ; `names` : regex des noms permis. */
  grab(x: number, y: number, names: string): string {
    let re: RegExp | null = null;
    try {
      re = names && names !== ".*" ? new RegExp(names) : null;
    } catch {
      return "";
    }
    const hit = this.pick(x, y, (n) => this.driver.movable(n) && (!re || re.test(n)));
    return hit?.instance ?? "";
  }

  /** Glisser : range l'instance au point du sol visé sous (x, y) du calque, à sa hauteur ; `ry` : cap voulu. */
  dragTo(name: string, x: number, y: number, now: number, ry?: number): PlacedInfo | null {
    const m = this.monde;
    const inst = this.driver.instances.get(name);
    if (!m || !inst) return null;
    const [gx, gz] = groundPoint(this.proj, m.view2d.unit, m.view2d.origin[0], m.view2d.origin[1], x, y, inst.t.y, [inst.t.x, inst.t.z]);
    const res = this.driver.arrangeTo(name, gx, gz, now, 0, "inOut", ry === undefined ? {} : { ry });
    if (!res) return null;
    this.refreshConflicts(true);
    this.invalidate();
    return placedInfo(name, res, this.driver.bodies(), m.unit);
  }

  /** Fin d'un glisser : résultat et conflits publiés. */
  dropped(name: string): void {
    const inst = this.driver.instances.get(name);
    if (inst?.placed && this.monde) this.onPlaced?.(placedInfo(name, inst.placed, this.driver.bodies(), this.monde.unit));
    this.refreshConflicts();
  }

  /** Conflits sur les positions courantes ; `live` (pendant un glisser) : arêtes seulement. */
  refreshConflicts(live = false): void {
    this.drawSelection();
    const r = this.driver.collisions();
    if (!r) return;
    this.drawMarks(r.marks);
    if (!live) this.onConflicts?.(r.conflicts);
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
    if (m.shadows && !inst.placement.noShadow) {
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
        if (backFacing(p, this.dir)) continue;
        const [u, v] = basisOf(this.dir);
        const hull = silhouette(pts, u, v);
        affineOf(wi, u, v, this.proj, unit, origin[0], origin[1], this.aff);
        const color = partColor(model, p, pl.roles, m.palette);
        const sub = new Graphics();
        drawPart(sub, hull, color, partTex(m, p), p.glow, m.outline, Math.hypot(this.aff[0], this.aff[1]) || 1, p.shape?.kind === "plane", p.finish);
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

  /** Déplacement en jeu gêné par un obstacle (`collide`). */
  onContact: ((c: { objectId: string; x: number; z: number; hits: string[]; blocked: boolean }) => void) | null = null;

  /** Patch `{x, z, collide}` ramené au point atteint sans traverser d'obstacle (walk.ts) ; sinon tel quel. */
  guard(name: string, p: unknown): unknown {
    const g = this.driver.guard(name, p);
    if (!g) return p;
    if (g.walked.hits.length) this.onContact?.({ objectId: name, ...g.walked });
    return g.patch;
  }

  /** Patch d'une instance (transformations comprises) ou d'une pièce `<instance>_<pièce>`. */
  apply(name: string, p: unknown, now: number, animate: boolean): boolean {
    const r = this.driver.apply(name, p, now, animate, true);
    if (r) {
      // rangement demandé par `move` : résultat publié, conflits recalculés
      if (p && typeof p === "object" && Array.isArray((p as { move?: unknown }).move)) {
        const inst = this.driver.instances.get(name);
        if (inst?.placed && this.monde) this.onPlaced?.(placedInfo(name, inst.placed, this.driver.bodies(), this.monde.unit));
        this.refreshConflicts();
      }
      return r.pose || r.roles || r.transform;
    }
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
    let busy = this.driver.step(now);
    const { unit, origin } = m.view2d;
    const dt = this.lastStep ? Math.min(0.1, Math.max(0, (now - this.lastStep) / 1000)) : 0;
    if (m.infini) {
      const s = m.infini;
      const f = s.follow ? this.driver.instances.get(s.follow) : null;
      if (this.infini.update(f ? f.t.x : s.center[0], f ? f.t.z : s.center[1])) this.syncTiles(m);
      syncInfiniSims(m, this.infini, { probe: this.probe, emitters: this.emitters, rigid: this.rigid });
      if (this.onInfiniState && now - this.lastInfiniState > 250) {
        this.lastInfiniState = now;
        this.onInfiniState(this.infini.state());
      }
    }
    if (this.rigid) {
      const w = this.rigid;
      const moved = w.step(dt);
      if (moved.length || w.active) busy = true;
      if (w.contacts.length) {
        this.onContacts?.(w.contacts);
        w.contacts = [];
      }
      if (w.rested) {
        this.onRest?.(w.rested);
        w.rested = null;
      }
      if (this.onPhysics && (moved.length || !this.lastPhysState) && now - this.lastPhysState >= 100) {
        this.lastPhysState = now;
        this.onPhysics(w.state());
      }
    }
    if (this.probe.busy) {
      const r = this.probe.step(this.driver);
      if (r.results) this.onQueries?.(r.results);
      for (const e of r.events) this.onSensor?.(e);
      busy = true;
    }
    if (this.particleViews.length) {
      for (const sim of this.emitters.sims) if (sim.spec.trail) this.particles.trail(sim.spec.trail, sim, dt);
      this.particles.step(dt);
      this.drawParticles(m);
      if (this.particles.active) busy = true;
    }
    if (this.emitDraw.length) {
      this.emitters.step(dt, this.driver);
      this.drawEmitters(m);
      if (this.emitters.active) busy = true;
      if (this.onEmitStats && now - this.lastStats >= 100) {
        this.lastStats = now;
        this.onEmitStats(this.emitters.stats(this.driver));
      }
    }
    this.lastStep = now;
    // trop de dessins en cache : on repart de zéro, en redessinant toutes les pièces dans cette image
    if (this.contexts.size > MAX_CONTEXTS) {
      for (const b of this.built.values()) for (const pv of b.parts) if (pv) {
        pv.bucket = -1;
        pv.g.context = EMPTY;
      }
      for (const d of this.emitDraw)
        for (const v of d.pool) {
          v.buckets.fill(-1);
          for (const g of v.parts) if (g) g.context = EMPTY;
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
        // face seule (plafond vu de dessous) tournée vers l'autre côté : pas dessinée
        if (backFacing(p, this.dir)) {
          pv.g.visible = false;
          continue;
        }
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
            drawPart(ctx, hull, color, partTex(m, p), p.glow, m.outline, unit * sc, p.shape?.kind === "plane", p.finish);
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
  pick(x: number, y: number, accept?: (instance: string) => boolean): { instance: string; part: string } | null {
    let best: { instance: string; part: string; z: number } | null = null;
    for (const b of this.built.values()) {
      if (!b.inst.visible || (accept && !accept(b.inst.name))) continue;
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
    this.rigidTok++;
    this.rigid?.dispose();
    this.rigid = null;
    // contexte jetable (le partagé et EMPTY ne doivent pas être détruits avec la pièce)
    for (const b of this.built.values()) for (const pv of b.parts) if (pv) pv.g.context = new GraphicsContext();
    for (const d of this.emitDraw) for (const v of d.pool) for (const g of v.parts) if (g) g.context = new GraphicsContext();
    for (const t of this.tileViews.values()) for (const v of t.items) for (const g of v.parts) if (g) g.context = new GraphicsContext();
    // pièces d'instances : contexte partagé détaché ci-dessus ; décor et ombres : leurs propres dessins
    for (const c of this.container.removeChildren()) c.destroy({ children: true, context: true });
    this.clearContexts();
    this.built.clear();
    this.partIndex.clear();
    this.statics = [];
    this.marks = null;
    this.emitDraw = [];
    this.particleViews = [];
    this.tileViews.clear();
    this.restOf.clear();
  }

  destroy() {
    this.clear();
    this.emitters.dispose();
    this.particles.dispose();
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

/** Extrusion réduite à une face (`face` avant / arrière) vue de dos : `dir` est la direction de vue dans le repère de la pièce. */
function backFacing(p: { shape?: { kind: string; a: number[] } | null }, dir: ArrayLike<number>): boolean {
  const f = p.shape?.kind === "extrude" ? (p.shape.a[1] ?? 0) : 0;
  return f !== 0 && f * dir[2] > 0;
}
