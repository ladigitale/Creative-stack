/**
 * `VectorView` : rendu « vrai 2D » en illustration vectorielle (Canvas 2D, `Path2D`) d'un `SceneModel`, avec la même
 * interface publique que `ProcgenView` (setModel, setStyle, setView, setAnim, setActors, select, pick, anchors, stats,
 * actorState, actorIds, resize, kick, setVisible, setHidden, interact, dispose, onEvent, onFrame).
 *
 * Rendu à la demande ; formes statiques générées une fois et mises en cache (chemins `Path2D` compris), formes
 * animées (personnages, feux) recalculées à chaque image. Pan / zoom nets à toute échelle (densité de pixels de
 * l'écran), parallaxe des plans au pan, sélection par `isPointInPath`, surlignage, ancres, événements de jeu.
 */
import { type V3, clamp, m4Point, sub } from "../core/math";
import type { SceneModel } from "../scene/compose";
import type { StyleTokens } from "../style/style";
import { ActorSim, type ActorIntent, type GameEvent } from "./actors";
import { Painter, strokeScale } from "./paint";
import type { VectorCamera } from "./project";
import { VectorScene, mergeSorted, now } from "./scene";
import { PATH_UNIT, type Shape, pathBounds } from "./shape";
import { fitFrame, renderSVG } from "./svg";
import { type Inks, type VectorStyle, makeInks, resolveVectorStyle } from "./vstyle";

export type VectorViewState = { camera: VectorCamera; zoom: number; cx: number | null; cy: number | null; cz: number | null; lift: number | null; actor: string | null; follow: boolean };

const CAM_MAP: Record<string, VectorCamera> = { side: "side", front: "side", follow: "side", oblique: "oblique", iso: "oblique", top: "oblique", perspective: "oblique" };
const round = (x: number) => Math.round(x * 100) / 100;
/** `#rrggbb` + opacité → `rgba(…)`. */
const hexA = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

export class VectorView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private model: SceneModel | null = null;
  private scene: VectorScene | null = null;
  private vs: VectorStyle = resolveVectorStyle("flat");
  private inks: Inks = makeInks(this.vs);
  private painter = new Painter(this.vs, this.inks);
  private sim = new ActorSim();
  private view: VectorViewState = { camera: "side", zoom: 1, cx: null, cy: null, cz: null, lift: null, actor: null, follow: false };
  private paths = new WeakMap<Shape, Path2D>();
  private lastShapes: Shape[] = [];
  private hiddenIds = new Set<string>();
  private selected = -1;
  private time = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private visible = true;
  private dirty = true;
  private disposed = false;
  private frameTimes: number[] = [];
  private genMs = 0;
  private drawMs = 0;
  private center: { cu: number; cv: number; s0: number; cu0: number } = { cu: 0, cv: 0, s0: 1, cu0: 0 };
  private patterns: Record<string, CanvasPattern | null> = {};
  private off: HTMLCanvasElement | null = null;
  dpr = 1;
  maxDpr = 2;
  play = true;
  speed = 1;
  fps = 0;
  onEvent: (e: GameEvent) => void = () => {};
  onFrame: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.min(this.maxDpr, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    this.sim.onEvent = (e) => this.onEvent(e);
  }

  /* ---------------- scène, style, vue ---------------- */

  setModel(model: SceneModel) {
    this.model = model;
    this.sim.setModel(model);
    this.sim.setHidden(this.hiddenIds);
    const v = (model.view ?? {}) as Record<string, unknown>;
    this.view = { camera: CAM_MAP[String(v.camera ?? "side")] ?? "side", zoom: Number(v.zoom ?? 1) || 1, cx: null, cy: null, cz: null, lift: null, actor: null, follow: v.camera === "follow" };
    this.rebuild();
  }

  private rebuild() {
    if (!this.model) return;
    this.scene = new VectorScene(this.model, { camera: this.view.camera, lift: this.view.lift ?? undefined }, { lightElevation: this.vs.tokens.lightElevation });
    this.paths = new WeakMap();
    this.dirty = true;
    this.kick();
  }

  /** Style : nom vectoriel (`ligne-claire`, `flat`, `gravure`, `affiche`, `papier-decoupe`), `"flat/nuit"`, objet `{vector, preset, …}` ou jetons 3D. */
  setStyle(s: StyleTokens | unknown) {
    const prevElev = this.vs.tokens.lightElevation;
    this.vs = resolveVectorStyle(s);
    this.inks = makeInks(this.vs);
    this.painter = new Painter(this.vs, this.inks);
    this.patterns = {};
    if (this.vs.tokens.lightElevation !== prevElev) this.rebuild();
    this.dirty = true;
    this.kick();
  }
  get style(): VectorStyle {
    return this.vs;
  }

  setView(v: unknown) {
    const o = (v ?? {}) as Record<string, unknown>;
    const prevCam = this.view.camera, prevLift = this.view.lift;
    if (typeof o.camera === "string") {
      this.view.camera = CAM_MAP[o.camera] ?? this.view.camera;
      this.view.follow = o.camera === "follow";
    }
    for (const k of ["zoom", "cx", "cy", "cz", "lift"] as const) if (o[k] !== undefined && Number.isFinite(Number(o[k]))) (this.view as Record<string, unknown>)[k] = Number(o[k]);
    this.view.zoom = clamp(this.view.zoom, 0.1, 40);
    if (typeof o.actor === "string") this.view.actor = o.actor;
    if (this.view.camera !== prevCam || this.view.lift !== prevLift) this.rebuild();
    this.dirty = true;
    this.kick();
  }
  getView() {
    return { ...this.view };
  }
  get cameraMode(): VectorCamera {
    return this.view.camera;
  }

  /** Pan / zoom (déplacement en pixels) ; « rotate » règle la hauteur de vue (relevé des plans). */
  interact(kind: "pan" | "rotate" | "zoom", dx: number, dy = 0) {
    if (!this.scene) return;
    this.layout();
    const s = this.center.s0 * this.view.zoom;
    if (kind === "zoom") this.view.zoom = clamp(this.view.zoom * Math.exp(-dx * 0.0015), 0.1, 40);
    else if (kind === "rotate") {
      this.view.lift = clamp((this.view.lift ?? this.scene.pr.ay) + dy * 0.002, 0, 0.45);
      this.rebuild();
    } else {
      const [cu, cv] = [this.center.cu - dx / s, this.center.cv + dy / s];
      const pr = this.scene.pr;
      // centre exprimé en monde (z = 0) pour que setView / getView restent cohérents
      this.view.cz = 0;
      this.view.cx = cu + pr.ax * 0;
      this.view.cy = cv;
    }
    this.dirty = true;
    this.kick();
  }

  setAnim(a: { play?: boolean; speed?: number; time?: number }) {
    if (a.play !== undefined) this.play = !!a.play;
    if (Number.isFinite(a.speed)) this.speed = clamp(Number(a.speed), 0, 4);
    if (Number.isFinite(a.time)) this.time = Number(a.time);
    this.dirty = true;
    this.kick();
  }

  setHidden(ids: string[]) {
    this.hiddenIds = new Set(ids);
    this.sim.setHidden(this.hiddenIds);
    this.dirty = true;
    this.kick();
  }

  select(objectId: string | null) {
    const o = objectId ? this.model?.objects.find((x) => x.id === objectId) : null;
    this.selected = o?.obj ?? -1;
    this.dirty = true;
    this.kick();
    return o ?? null;
  }

  setActors(intents: Record<string, ActorIntent>) {
    this.sim.setActors(intents);
    this.kick();
  }

  /* ---------------- cadrage ---------------- */

  private layout() {
    const sc = this.scene!;
    const w = this.canvas.clientWidth || this.canvas.width || 1, h = this.canvas.clientHeight || this.canvas.height || 1;
    const f = fitFrame(sc, w, h, 1);
    let cu = f.cu, cv = f.cv;
    const cu0 = cu;
    if (this.view.follow || this.view.actor) {
      const a = this.sim.actors.get(this.view.actor ?? [...this.sim.actors.keys()][0] ?? "");
      if (a && this.view.follow) {
        const p = sc.pr.p(a.pos[0], a.pos[1] + a.model.asset.height * 0.55, a.pos[2]);
        cu = p[0];
        cv = p[1];
      }
    }
    if (this.view.cx !== null || this.view.cy !== null || this.view.cz !== null) {
      const p = sc.pr.p(this.view.cx ?? 0, this.view.cy ?? f.cv, this.view.cz ?? 0);
      cu = p[0];
      cv = this.view.cy === null ? f.cv : p[1];
    }
    this.center = { cu, cv, s0: f.scale, cu0 };
  }

  /** Transformation monde → pixels de l'écran (CSS) d'un plan, parallaxe comprise. */
  private layerMatrix(layer: number): [number, number, number, number, number, number] {
    const w = this.canvas.clientWidth || this.canvas.width || 1, h = this.canvas.clientHeight || this.canvas.height || 1;
    const s = this.center.s0 * this.view.zoom;
    const pan = this.center.cu - this.center.cu0;
    const k = this.vs.parallax * (layer <= 1 ? 0.75 - layer * 0.25 : 0.1 * Math.max(0, 1 - (layer - 2) / 6));
    const cu = this.center.cu - pan * k;
    return [s, 0, 0, -s, w / 2 - cu * s, h / 2 + this.center.cv * s];
  }

  private worldToScreen(p: V3): { x: number; y: number } {
    const [u, v] = this.scene!.pr.pv(p);
    const m = this.layerMatrix(2 + Math.round((1 - this.scene!.pr.far(p[2])) * 6));
    return { x: m[0] * u + m[4], y: m[3] * v + m[5] };
  }

  /* ---------------- formes ---------------- */

  private shapes(): Shape[] {
    const sc = this.scene!;
    const t0 = now();
    const night = this.vs.tokens.night;
    const st = sc.staticShapes(night, this.hiddenIds.size ? new Set([...this.hiddenIds].filter((id) => !this.sim.actors.has(id))) : undefined);
    const dyn = sc.dynamicShapes(this.time, night, this.sim.poses());
    this.genMs = now() - t0;
    return mergeSorted(st.shapes, dyn);
  }

  private tplPaths = new Map<string, Path2D>();
  private path(s: Shape): Path2D {
    if (s.t) {
      let p = this.tplPaths.get(s.d);
      if (!p) {
        this.tplPaths.set(s.d, (p = new Path2D(s.d)));
        if (this.tplPaths.size > 4000) this.tplPaths.delete(this.tplPaths.keys().next().value as string);
      }
      return p;
    }
    let p = this.paths.get(s);
    if (!p) this.paths.set(s, (p = new Path2D(s.d)));
    return p;
  }
  private boundsCache = new WeakMap<Shape, [number, number, number, number]>();
  /** Rectangle englobant (unités du chemin). */
  private bounds(sh: Shape) {
    let b = this.boundsCache.get(sh);
    if (!b) {
      const m = pathBounds(sh.d);
      b = [m[0] * PATH_UNIT, m[1] * PATH_UNIT, m[2] * PATH_UNIT, m[3] * PATH_UNIT];
      this.boundsCache.set(sh, b);
    }
    return b;
  }
  /** Matrice (pixels de l'appareil) d'une forme : plan, parallaxe, gabarit. */
  private shapeMatrix(sh: Shape, M: [number, number, number, number, number, number]): [number, number, number, number, number, number] {
    const d = this.dpr, q = d / PATH_UNIT;
    if (!sh.t) return [M[0] * q, 0, 0, M[3] * q, M[4] * d, M[5] * d];
    const [k, u, v] = sh.t;
    return [M[0] * k * q, 0, 0, M[3] * k * q, (M[0] * u + M[4]) * d, (M[3] * v + M[5]) * d];
  }

  private pattern(kind: "h1" | "h2" | "dt"): CanvasPattern | null {
    if (kind in this.patterns) return this.patterns[kind];
    const d = this.dpr;
    const n = Math.max(4, Math.round(5 * d));
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const g = c.getContext("2d");
    if (!g) return (this.patterns[kind] = null);
    g.strokeStyle = this.inks.ink;
    g.fillStyle = this.inks.ink;
    g.lineWidth = Math.max(1, d * 0.9);
    if (kind === "dt") {
      g.beginPath();
      g.arc(n / 2, n / 2, n * 0.2, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      g.moveTo(0, n);
      g.lineTo(n, 0);
      g.moveTo(-n / 2, n / 2);
      g.lineTo(n / 2, -n / 2);
      g.moveTo(n / 2, n * 1.5);
      g.lineTo(n * 1.5, n / 2);
      if (kind === "h2") {
        g.moveTo(0, 0);
        g.lineTo(n, n);
        g.moveTo(-n / 2, n / 2);
        g.lineTo(n / 2, n * 1.5);
        g.moveTo(n / 2, -n / 2);
        g.lineTo(n * 1.5, n / 2);
      }
      g.stroke();
    }
    return (this.patterns[kind] = this.ctx!.createPattern(c, "repeat"));
  }

  /* ---------------- rendu ---------------- */

  render() {
    const ctx = this.ctx;
    if (!this.scene || !ctx) return;
    this.resize();
    this.layout();
    const t0 = now();
    const shapes = this.shapes();
    this.lastShapes = shapes;
    const d = this.dpr;
    const w = this.canvas.clientWidth || this.canvas.width, h = this.canvas.clientHeight || this.canvas.height;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    // ciel en dégradé (repère écran)
    const hz = this.worldToScreen([0, 0, -this.scene.model.size[1] / 2]).y;
    const g = ctx.createLinearGradient(0, Math.min(0, hz - h), 0, Math.max(hz, 1));
    g.addColorStop(0, this.inks.sky.top);
    g.addColorStop(1, this.inks.sky.horizon);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const s = this.center.s0 * this.view.zoom;
    const k = strokeScale(s);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const papercut = this.vs.papercut > 0;
    let target = ctx;
    let layer = -1;
    if (papercut) {
      if (!this.off) this.off = document.createElement("canvas");
      if (this.off.width !== this.canvas.width || this.off.height !== this.canvas.height) {
        this.off.width = this.canvas.width;
        this.off.height = this.canvas.height;
      }
      target = this.off.getContext("2d")!;
      target.lineJoin = "round";
      target.lineCap = "round";
    }
    const flush = () => {
      if (!papercut || !this.off) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.shadowColor = "rgba(20,15,10,0.38)";
      ctx.shadowBlur = this.vs.papercut * d;
      ctx.shadowOffsetY = this.vs.papercut * 0.3 * d;
      ctx.drawImage(this.off, 0, 0);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.clearRect(0, 0, this.off.width, this.off.height);
    };
    let curLayer = -99;
    let M: [number, number, number, number, number, number] = this.layerMatrix(0);
    for (const sh of shapes) {
      if (papercut && sh.layer > layer) {
        if (layer >= 0) flush();
        layer = sh.layer;
      }
      if (sh.layer !== curLayer) {
        curLayer = sh.layer;
        M = this.layerMatrix(sh.layer);
      }
      const SM = this.shapeMatrix(sh, M);
      target.setTransform(SM[0], 0, 0, SM[3], SM[4], SM[5]);
      const p = this.painter.paint(sh);
      const path = this.path(sh);
      target.globalAlpha = p.alpha;
      target.globalCompositeOperation = p.blend === "multiply" ? "multiply" : p.blend === "screen" ? "screen" : "source-over";
      if (p.fill && p.halo) {
        const b = this.bounds(sh);
        const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, r = Math.max(1, (b[2] - b[0]) / 2);
        const g2 = target.createRadialGradient(cx, cy, 0, cx, cy, r);
        g2.addColorStop(0, p.fill);
        g2.addColorStop(0.35, hexA(p.fill, 0.45));
        g2.addColorStop(1, hexA(p.fill, 0));
        target.fillStyle = g2;
        target.fill(path);
      } else if (p.fill) {
        target.fillStyle = p.fill;
        target.fill(path);
      }
      if (p.hatch || (p.dots && p.fill)) {
        const pat = this.pattern(p.hatch === 2 ? "h2" : p.hatch === 1 ? "h1" : "dt");
        if (pat) {
          const inv = new DOMMatrix(SM).inverse();
          pat.setTransform?.(inv);
          target.fillStyle = pat;
          target.globalAlpha = p.alpha * (p.hatch ? (p.fill ? 0.55 : 1) : 0.22 * this.vs.halftone);
          target.globalCompositeOperation = "multiply";
          target.fill(path);
          target.globalCompositeOperation = "source-over";
        }
      }
      if (p.stroke) {
        target.globalAlpha = p.alpha;
        target.strokeStyle = p.stroke;
        target.lineWidth = (p.strokePx * k * PATH_UNIT) / (s * (sh.t ? sh.t[0] : 1));
        target.stroke(path);
      }
    }
    if (papercut) flush();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    // surlignage de la sélection
    if (this.selected > 0) {
      for (const sh of shapes) {
        if (sh.objId !== this.selected || sh.kind === "shadow" || sh.kind === "line") continue;
        const M2 = this.shapeMatrix(sh, this.layerMatrix(sh.layer));
        ctx.setTransform(M2[0], 0, 0, M2[3], M2[4], M2[5]);
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = "#fff6d8";
        ctx.fill(this.path(sh));
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ffd25a";
        ctx.lineWidth = (2.2 * PATH_UNIT) / (s * (sh.t ? sh.t[0] : 1));
        ctx.stroke(this.path(sh));
      }
    }
    // grain de papier (gravure, papier découpé, affiche)
    if (this.vs.paper > 0) this.grain(ctx, w, h);
    this.drawMs = now() - t0;
  }

  private grainPat: CanvasPattern | null = null;
  private grain(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!this.grainPat) {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const g = c.getContext("2d");
      if (!g) return;
      const img = g.createImageData(128, 128);
      let seed = 1234567;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const v = 128 + ((seed >> 8) % 60) - 30;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      this.grainPat = ctx.createPattern(c, "repeat");
    }
    if (!this.grainPat) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 0.09 * this.vs.paper;
    ctx.globalCompositeOperation = "overlay";
    ctx.fillStyle = this.grainPat;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Export SVG de la vue courante (mêmes formes, même cadrage). */
  toSVG(): string {
    if (!this.scene) return "";
    this.layout();
    const w = this.canvas.clientWidth || this.canvas.width, h = this.canvas.clientHeight || this.canvas.height;
    return renderSVG(this.lastShapes.length ? this.lastShapes : this.shapes(), this.vs, this.inks, { width: w, height: h, scale: this.center.s0 * this.view.zoom, cu: this.center.cu, cv: this.center.cv });
  }

  /* ---------------- sélection ---------------- */

  pick(clientX: number, clientY: number): { objectId: string | null; generator: string | null; layer: string | null; x: number; y: number; z: number; actor: string | null; zone: string | null } | null {
    if (!this.model || !this.scene || !this.ctx) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = (clientX - r.left) * this.dpr, py = (clientY - r.top) * this.dpr;
    const ctx = this.ctx;
    let hitObj = 0;
    for (let i = this.lastShapes.length - 1; i >= 0; i--) {
      const sh = this.lastShapes[i];
      if (!sh.objId || sh.kind === "shadow" || sh.kind === "line") continue;
      const M = this.shapeMatrix(sh, this.layerMatrix(sh.layer));
      ctx.setTransform(M[0], 0, 0, M[3], M[4], M[5]);
      if (ctx.isPointInPath(this.path(sh), px, py)) {
        hitObj = sh.objId;
        break;
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const obj = hitObj ? this.model.objects.find((o) => o.obj === hitObj) ?? null : null;
    let x: number, y: number, z: number;
    const actor = obj?.mode === "actor" ? this.sim.actors.get(obj.id) : undefined;
    if (actor) [x, y, z] = actor.pos;
    else {
      const M = this.layerMatrix(2);
      const u = ((clientX - r.left) - M[4]) / M[0], v = ((clientY - r.top) - M[5]) / M[3];
      const T = this.model.terrain;
      const g = this.scene.pr.ground(u, v, (gx, gz) => (T ? T.height(clamp(gx, -this.model!.size[0] / 2, this.model!.size[0] / 2), clamp(gz, -this.model!.size[1] / 2, this.model!.size[1] / 2)) : 0));
      x = clamp(g.x, -this.model.size[0] / 2, this.model.size[0] / 2);
      z = clamp(g.z, -this.model.size[1] / 2, this.model.size[1] / 2);
      y = T ? T.height(x, z) : 0;
      if (obj && obj.mode !== "actor") [x, y, z] = [obj.pos[0], obj.pos[1], obj.pos[2]];
    }
    const zone = this.model.zones.find((zn) => (zn.box ? x >= zn.box[0] && x <= zn.box[2] && z >= zn.box[1] && z <= zn.box[3] : Math.hypot(x - zn.x, z - zn.z) <= zn.r));
    return { objectId: obj?.id ?? null, generator: obj?.generator ?? null, layer: obj?.layer ?? null, x: round(x), y: round(y), z: round(z), actor: actor ? obj!.id : null, zone: zone?.id ?? null };
  }

  /** Positions écran (px CSS) d'ancres `"hero@head.top"`, `"maisons.2@door"`. */
  anchors(list: string[]): Record<string, { x: number; y: number; visible: boolean }> {
    const out: Record<string, { x: number; y: number; visible: boolean }> = {};
    if (!this.scene) return out;
    this.layout();
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    for (const key of list.slice(0, 32)) {
      const [id, an = "head.top"] = key.split("@");
      let p: V3 | null = null;
      const a = this.sim.actors.get(id);
      if (a) {
        const anc = a.model.asset.anchors[an];
        const sk = a.model.asset.skeleton!;
        if (anc && a.W.length) {
          const bi = sk.index[anc.bone ?? "root"] ?? 0;
          const local = m4Point(a.W[bi], sub(anc.pos, sk.bones[bi].head));
          const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
          p = [a.pos[0] + local[0] * c + local[2] * s, a.pos[1] + local[1], a.pos[2] - local[0] * s + local[2] * c];
        } else p = [a.pos[0], a.pos[1] + a.model.asset.height, a.pos[2]];
      } else {
        const o = this.model?.objects.find((ob) => ob.id === id);
        if (o) p = o.anchors[an] ?? [o.pos[0], o.pos[1] + o.height, o.pos[2]];
      }
      if (!p) continue;
      const q = this.worldToScreen(p);
      out[key] = { x: round(q.x), y: round(q.y), visible: q.x >= -w * 0.05 && q.x <= w * 1.05 && q.y >= -h * 0.05 && q.y <= h * 1.05 };
    }
    return out;
  }

  /* ---------------- boucle ---------------- */

  setVisible(v: boolean) {
    this.visible = v;
    if (v) this.kick();
  }

  private get animated(): boolean {
    return !!this.model && this.play && (this.sim.actors.size > 0 || this.model.objects.some((o) => o.generator === "prop" && (this.scene?.params.get(o.obj)?.kind === "campfire")));
  }

  kick() {
    if (this.disposed || this.running || !this.visible || typeof requestAnimationFrame === "undefined") return;
    this.running = true;
    this.last = now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private loop = (t: number) => {
    if (this.disposed) return;
    const dt = Math.min(0.1, Math.max(0, (t - this.last) / 1000));
    this.last = t;
    const anim = this.animated;
    if (anim) {
      this.time += dt * this.speed;
      this.sim.update(dt * this.speed);
    }
    if (anim || this.dirty) {
      this.render();
      this.dirty = false;
      this.frameTimes.push(dt);
      if (this.frameTimes.length > 30) this.frameTimes.shift();
      const avg = this.frameTimes.reduce((s, x) => s + x, 0) / this.frameTimes.length;
      this.fps = avg > 0 ? Math.round(1 / avg) : 0;
      this.onFrame();
    }
    if ((anim || this.dirty) && this.visible) this.raf = requestAnimationFrame(this.loop);
    else this.running = false;
  };

  /** Avance la simulation sans écran (tests, captures) puis redessine. */
  step(seconds: number, fps = 30) {
    const n = Math.max(1, Math.round(seconds * fps));
    for (let i = 0; i < n; i++) {
      this.time += (1 / fps) * this.speed;
      this.sim.update((1 / fps) * this.speed);
    }
    this.dirty = true;
  }

  resize(force = false) {
    const w = Math.max(1, this.canvas.clientWidth | 0), h = Math.max(1, this.canvas.clientHeight | 0);
    const pw = Math.round(w * this.dpr), ph = Math.round(h * this.dpr);
    if (!force && this.canvas.width === pw && this.canvas.height === ph) return;
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.patterns = {};
    this.dirty = true;
  }

  stats() {
    return { drawCalls: this.lastShapes.length, triangles: 0, shapes: this.lastShapes.length, genMs: Math.round(this.genMs * 10) / 10, drawMs: Math.round(this.drawMs * 10) / 10, fps: this.fps, scale: this.dpr };
  }

  actorState(id: string) {
    return this.sim.state(id);
  }
  actorIds() {
    return [...this.sim.actors.keys()];
  }

  dispose() {
    this.disposed = true;
    if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(this.raf);
    this.model = null;
    this.scene = null;
    this.lastShapes = [];
  }
}

export type { ActorIntent, GameEvent };
