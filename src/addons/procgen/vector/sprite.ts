/**
 * Dessin vectoriel procgen d'**un seul** objet, hors scène, sur un canvas : modèles `gen` du format `monde2d`
 * (`sonic-2d`). Mêmes dessinateurs et même peinture que `VectorView` (traits continus à épaisseur variable sur le
 * squelette posé, aplats, encre, hachures, trame), vus de profil, de face ou en plongée (vue de dessus inclinée).
 *
 * - Personnages et animaux : squelette posé par le moteur procgen (foulée intégrée par la distance parcourue, actions)
 *   plus rotations d'os ajoutées par les clips du format, redessinés à chaque image où la pose change.
 * - Décor (arbre, bâtiment, objet…) : dessiné une fois.
 *
 * Le canvas a une taille fixe (emprise projetée de l'objet) ; `anchor` donne, en pixels du canvas, le point au sol sous
 * l'origine de l'objet : le rendu 2D y accroche le sprite.
 */
import { type Q, type V3, qEuler, qMul } from "../core/math";
import { Rng } from "../core/rng";
import { Issues, resolveParams } from "../core/schema";
import { resolveGeneratorId } from "../gen/index";
import type { Asset } from "../gen/types";
import { ACTIONS, type Action, type MotionState } from "../rig/locomotion";
import { type Motion, motionFor } from "../rig/motion";
import { AnimalSkeleton } from "../rig/quadruped";
import type { M4 } from "../core/math";
import { ROLES } from "../style/roles";
import { genRole } from "../../../shared/monde/gen";
import { buildPlan } from "./buildplan";
import { vectorAsset } from "./compose";
import { drawAnimal } from "./draw/animal";
import { drawCharacter } from "./draw/character";
import { Emitter, Frame, Kit, lightDir } from "./draw/kit";
import { drawGeneric } from "./draw/props";
import type { DrawEnv } from "./draw/types";
import { Painter, strokeScale } from "./paint";
import { Projector } from "./project";
import { DRAWERS } from "./scene";
import { PATH_UNIT, type Shape } from "./shape";
import { type VectorStyle, makeInks, resolveVectorStyle } from "./vstyle";

export type SpriteView = "profil" | "face" | "dessus" | "plongee";

export type SpriteOpts = {
  view: SpriteView;
  /** Pixels par mètre du dessin (avant `resolution`). */
  pxPerM: number;
  /** Suréchantillonnage du canvas (netteté sous zoom). */
  resolution: number;
  /** Style vectoriel procgen (`flat`, `ligne-claire`, `gravure`, `affiche`, `papier-decoupe`) ou jetons. */
  style: unknown;
  /** Inclinaison de la plongée (degrés, 90 = verticale) : `dessus` = 90, `plongee` = 55 par défaut. */
  pitch?: number;
  /** Images de dessin par seconde des personnages (défaut 24 : « en deux », comme un dessin animé). */
  fps?: number;
};

export type SpriteDrive = {
  /** Vitesse imposée par le clip (m/s) quand l'objet ne se déplace pas. */
  clipSpeed: number;
  action: string;
  /** Distance parcourue au sol depuis l'image précédente (m). */
  moved: number;
  /** Cap (radians, rotation autour de la verticale ; 0 = face à l'observateur en profil). */
  yaw: number;
  bones: Map<string, [number, number, number]>;
  rootOff: [number, number, number];
};

const ACTION_SET = new Set<string>(ACTIONS);
const HEX = /^#[0-9a-f]{6}$/i;

type Ctx2 = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

export class GenSprite {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly issues: { path: string; message: string }[] = [];
  /** Point d'accroche (origine de l'objet au sol), en pixels du canvas. */
  readonly anchor: [number, number];
  readonly asset: Asset | null;
  readonly animated: boolean;
  readonly generator: string;
  private ctx: Ctx2 | null;
  private pr: Projector;
  private vs: VectorStyle;
  private painter: Painter;
  private params: Record<string, unknown> = {};
  private colors: Record<string, string> | undefined;
  private paths = new Map<string, Path2D>();
  private u0 = 0;
  private v1 = 0;
  private s = 1;
  private mo: Motion | null = null;
  private phase = Math.random();
  private speed = 0;
  private time = 0;
  private action: Action = "idle";
  private actionTime = 0;
  private actionWeight = 0;
  private blinkT = 1 + Math.random() * 3;
  private seed: number;
  private staticDone = false;
  private L: V3;
  private acc = 1;

  constructor(spec: { id: string; params: Record<string, unknown>; seed: string }, private opts: SpriteOpts) {
    const issues = new Issues();
    const { gen, preset } = resolveGeneratorId(spec.id);
    this.generator = gen?.id ?? "";
    this.seed = [...spec.seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 997, 7);
    const view = opts.view;
    this.pr = view === "dessus" || view === "plongee" ? new Projector("plongee", { pitch: opts.pitch ?? (view === "dessus" ? 90 : 55) }) : new Projector("side", { lift: view === "face" ? 0.08 : 0 });
    this.vs = resolveVectorStyle(opts.style ?? "flat");
    this.painter = new Painter(this.vs, makeInks(this.vs));
    this.L = lightDir(this.vs.tokens.lightElevation);
    let asset: Asset | null = null;
    if (!gen) this.issues.push({ path: "gen", message: `générateur « ${spec.id} » inconnu` });
    else {
      const rng = new Rng(spec.seed);
      const resolved = resolveParams(gen.schema, { ...preset, ...spec.params }, { rng, vars: {} }, issues, "params") as Record<string, unknown>;
      const vsch = gen.schema.variant as { max?: number } | undefined;
      if (vsch && resolved.variant === -1) resolved.variant = rng.int(0, vsch.max ?? 3);
      try {
        asset = vectorAsset(gen.id, resolved, { rng, issues, path: "params" });
      } catch (e) {
        this.issues.push({ path: "gen", message: `échec du générateur : ${(e as Error).message}` });
      }
      const look = (asset?.extra as { look?: Record<string, unknown> } | undefined)?.look;
      this.params = look ? { ...resolved, ...look } : gen.id === "animal" ? { ...resolved, ...(asset?.extra as Record<string, unknown> | undefined) } : resolved;
    }
    this.issues.push(...issues.list.map((i) => ({ path: i.path, message: i.message + (i.hint ? ` (${i.hint})` : "") })));
    this.asset = asset;
    this.animated = !!asset?.skeleton;
    if (asset?.skeleton) this.mo = motionFor(asset);
    this.colors = asset?.colors as Record<string, string> | undefined;
    // emprise projetée (boîte englobante généreuse : membres tendus, chapeau, ombre)
    const H = Math.max(0.3, asset?.height ?? 1);
    const R = Math.max(asset?.footprint.r ?? 0.5, this.animated ? H * 0.75 : 0.3) * 1.25;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const x of [-R, R]) for (const y of [-0.05, H * 1.15]) for (const z of [-R, R]) {
      const [u, v] = this.pr.p(x, y, z);
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    this.s = opts.pxPerM * opts.resolution;
    const w = Math.max(2, Math.min(2048, Math.ceil((u1 - u0) * this.s)));
    const h = Math.max(2, Math.min(2048, Math.ceil((v1 - v0) * this.s)));
    this.u0 = u0;
    this.v1 = v1;
    this.canvas = makeCanvas(w, h);
    this.ctx = (this.canvas.getContext("2d") as Ctx2 | null) ?? null;
    this.anchor = [-u0 * this.s, v1 * this.s];
  }

  /** Couleurs du format (`maillot`, `peau`, `toit`…) ou procgen (`cloth1`, `roof`…) par-dessus celles du générateur. */
  setRoles(roles: Record<string, string> | undefined) {
    const out: Record<string, string> = { ...(this.asset?.colors as Record<string, string> | undefined) };
    if (roles)
      for (const [k, v] of Object.entries(roles)) {
        const r = genRole(k, ROLES);
        if (r && HEX.test(v)) out[r] = v;
      }
    this.colors = out;
    this.staticDone = false;
  }

  /** Redessine ; renvoie true si le canvas a changé. `dt` en secondes. */
  draw(dt: number, d: SpriteDrive | null): boolean {
    if (!this.ctx || !this.asset) return false;
    if (!this.animated) {
      if (this.staticDone) return false;
      this.staticDone = true;
      this.paint(this.staticShapes());
      return true;
    }
    this.time += dt;
    const mo = this.mo!;
    const real = dt > 0 && d ? Math.min(d.moved, 2) / dt : 0;
    const want = Math.max(real, d?.clipSpeed ?? 0);
    this.speed += (want - this.speed) * (1 - Math.exp(-dt * 8));
    const step = Math.max(this.speed, 0.2) * dt;
    this.phase += step / (2 * mo.stepLength(Math.max(this.speed, 0.2)));
    const act = (d && ACTION_SET.has(d.action) ? d.action : "idle") as Action;
    if (act !== this.action) {
      this.action = act;
      this.actionTime = 0;
    }
    this.actionTime += dt;
    this.actionWeight += ((act === "idle" ? 0 : 1) - this.actionWeight) * (1 - Math.exp(-dt * 6));
    this.blinkT -= dt;
    let blink = 0;
    if (this.blinkT < 0.14) blink = Math.sin(Math.min(1, Math.max(0, 1 - this.blinkT / 0.14)) * Math.PI);
    if (this.blinkT <= 0) this.blinkT = 2 + ((this.seed * 17.1 + this.time) % 4);
    // l'état avance à chaque image ; le dessin, lui, est cadencé (coût du tracé maîtrisé)
    this.acc += dt;
    if (dt > 0 && this.acc < 1 / Math.max(6, Math.min(60, this.opts.fps ?? 24))) return false;
    this.acc = 0;
    const sk = this.asset.skeleton!;
    const st: MotionState = { speed: this.speed, phase: this.phase, time: this.time + this.seed, action: this.action, actionTime: this.actionTime, actionWeight: this.actionWeight, mood: String(this.params.mood ?? "neutral"), turn: 0, seed: this.seed, seatY: 0 };
    const { pose } = mo.pose(st);
    if (d) {
      for (const [bone, r] of d.bones) {
        if (!sk.has(bone)) continue;
        if (bone === "root") {
          const add = qEuler(r[0], r[1], r[2]);
          pose.rootRot = pose.rootRot ? qMul(pose.rootRot, add) : add;
          continue;
        }
        pose.rot[bone] = qMul(pose.rot[bone] ?? ([0, 0, 0, 1] as Q), qEuler(r[0], r[1], r[2]));
      }
      const o = d.rootOff;
      if (o[0] || o[1] || o[2]) pose.root = [pose.root[0] + o[0], pose.root[1] + o[1], pose.root[2] + o[2]];
    }
    const W: M4[] = sk.world(pose);
    const out: Shape[] = [], shadows: Shape[] = [];
    const em = new Emitter(out, 0, 5, 1, 0, "ink", this.colors);
    const yaw = d?.yaw ?? 0;
    try {
      if (sk instanceof AnimalSkeleton) drawAnimal(this.pr, em, { sk, W, pos: [0, 0, 0], yaw, params: this.params, blink });
      else drawCharacter(this.pr, em, { sk, W, pos: [0, 0, 0], yaw, params: this.params, blink, time: this.time, speed: this.speed }, shadows, () => 0);
    } catch {
      return false;
    }
    for (const s of shadows) s.z = -1;
    const all = [...shadows, ...out].sort((a, b) => a.z - b.z);
    this.paint(all);
    return true;
  }

  private staticShapes(): Shape[] {
    const out: Shape[] = [], shadows: Shape[] = [];
    const env: DrawEnv = { pr: this.pr, L: this.L, out, shadows, ground: () => 0, time: 0, night: this.vs.tokens.night, waterLevel: null };
    const em = new Emitter(out, 0, 5, 1, 0, "ink", this.colors);
    const kit = new Kit(this.pr, new Frame([0, 0, 0], 0, 1), em, this.L);
    const a = this.asset!;
    const obj = { id: "gen", layer: "gen", generator: this.generator, params: this.params, pos: [0, 0, 0] as V3, yaw: 0, scale: 1, footprint: a.footprint, height: a.height, obj: 1, mode: "static" as const, anchors: {} };
    const rng = new Rng(`gen/${this.seed}`);
    const ctx = { obj, env, rng, mirror: false, plan: this.generator === "building" ? buildPlan(this.params, new Rng(`plan/${this.seed}`)) : undefined };
    try {
      (DRAWERS[this.generator] ?? drawGeneric)(kit, this.params, ctx);
    } catch {
      out.length = 0;
      shadows.length = 0;
      drawGeneric(kit, this.params, ctx);
    }
    for (const s of shadows) s.z = -1;
    return [...shadows, ...out].sort((x, y) => x.z - y.z);
  }

  private path(d: string): Path2D {
    let p = this.paths.get(d);
    if (!p) {
      p = new Path2D(d);
      if (this.paths.size > 4000) this.paths.clear();
      this.paths.set(d, p);
    }
    return p;
  }

  private paint(shapes: Shape[]) {
    const g = this.ctx!;
    const c = this.canvas;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, c.width, c.height);
    g.lineJoin = "round";
    g.lineCap = "round";
    const s = this.s;
    const k = strokeScale(this.opts.pxPerM);
    const q = s / PATH_UNIT;
    for (const sh of shapes) {
      const p = this.painter.paint(sh);
      const t = sh.t;
      const kk = t ? t[0] : 1;
      // (u, v) mètres, v vers le haut → pixels du canvas, y vers le bas
      g.setTransform(q * kk, 0, 0, -q * kk, ((t ? t[1] : 0) - this.u0) * s, (this.v1 - (t ? t[2] : 0)) * s);
      const path = this.path(sh.d);
      g.globalAlpha = p.alpha;
      g.globalCompositeOperation = p.blend === "multiply" ? "multiply" : p.blend === "screen" ? "screen" : "source-over";
      if (p.fill) {
        g.fillStyle = p.fill;
        g.fill(path);
      }
      if (p.hatch && p.fill) {
        g.globalAlpha = p.alpha * 0.25;
        g.globalCompositeOperation = "multiply";
        g.fillStyle = this.painter.inks.ink;
        g.fill(path);
        g.globalCompositeOperation = "source-over";
      }
      if (p.stroke) {
        g.globalAlpha = p.alpha;
        g.strokeStyle = p.stroke;
        g.lineWidth = (p.strokePx * k * this.opts.resolution * PATH_UNIT) / (s * kk);
        g.stroke(path);
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }
}
