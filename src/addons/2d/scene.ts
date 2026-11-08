/**
 * Runtime Pixi de `sonic-2d` : calques, sprites (dessin + porteur de transformation), caméra,
 * rendu à la demande. Les décisions (format nodes, calques, toucher) sont dans ./model.ts et
 * src/shared/node-state.ts ; ici on ne fait qu'appliquer.
 */
// Sans ce module, Pixi compile ses shaders avec `new Function` : refusé par une CSP sans unsafe-eval (viewer Artefacts).
import "pixi.js/unsafe-eval";
import { Application, CanvasSource, Container, Graphics, Mesh, MeshGeometry, Sprite, Text, Texture, type ContainerChild } from "pixi.js";
import { isFrameSource } from "../../shared/mediaRef";
import { NodeStates } from "../../shared/node-state";
import { buildSkin, skinVertices, type BoneFrame, type Skin } from "../../shared/skin";
import {
  DEFAULT_LAYER,
  hitShape,
  pivotOffset,
  layerTransform,
  screenToLayer,
  visualKey,
  type Camera,
  type Layer,
  type SpriteSpec,
} from "./model";

type Entry = {
  spec: SpriteSpec;
  key: string;
  /** Porte la transformation (position, rotation, échelle, opacité) ; le dessin est son enfant. */
  holder: Container;
  art: ContainerChild | null;
  layer: string;
  /** Sprite image alimenté par une source d'images vivante (`source="#id"`). */
  live?: { sp: Sprite | Mesh; seq: number; canvas: HTMLCanvasElement | null; w: number; h: number };
  /** Sprite `mesh` : image déformée par les os (positions des sommets recalculées à chaque pose). */
  mesh?: { m: Mesh; geom: MeshGeometry; skin: Skin | null; frames: BoneFrame[]; names: string[]; sig: string; dbg?: Graphics };
};

const QUAD_UVS = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const QUAD_INDICES = new Uint32Array([0, 1, 2, 1, 3, 2]);
const quadPositions = (s: SpriteSpec): Float32Array => new Float32Array([-s.w / 2, -s.h / 2, s.w / 2, -s.h / 2, -s.w / 2, s.h / 2, s.w / 2, s.h / 2]);

/** Os publié par sonic-skeleton (`rest` / `bones`) : null si incomplet ou non fini. */
/** Teinte distincte par indice (os) : repérer quel os pèse sur un sommet. */
function hueColor(i: number, n: number): number {
  const h = (i / Math.max(1, n)) * 360;
  const k = (m: number) => (m + h / 30) % 12;
  const f = (m: number) => 0.5 - 0.5 * Math.max(-1, Math.min(k(m) - 3, 9 - k(m), 1));
  return (Math.round(255 * f(0)) << 16) | (Math.round(255 * f(8)) << 8) | Math.round(255 * f(4));
}

function boneFrame(v: unknown): BoneFrame | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const f = { x: Number(o.x), y: Number(o.y), x2: Number(o.x2), y2: Number(o.y2), angle: Number(o.angle) };
  if (!Object.values(f).every(Number.isFinite)) return null;
  const radius = Number(o.radius);
  return Number.isFinite(radius) && radius > 0 ? { ...f, radius } : f;
}

const RAD = Math.PI / 180;

export type SceneOptions = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  background: string;
  resolution: number;
  /** Police par défaut des sprites texte (celle de la page hôte). */
  font?: string;
  /** Demande un rendu (coalescé par l'élément). */
  invalidate: () => void;
  /** Résout l'id d'une source d'images dans la racine de l'élément (shadow DOM compris), puis le document. */
  lookup?: (id: string) => Element | null;
};

export class Scene2D {
  readonly app = new Application();
  readonly nodes: NodeStates;
  private entries = new Map<string, Entry>();
  private textResolution = 2;
  private layers = new Map<string, { layer: Layer; container: Container }>();
  private order: Layer[] = [];
  private camera: Camera;
  private ready = false;
  private destroyed = false;
  /** Squelette publié (`rest` : pose de repos, `bones` : pose courante) pour les sprites `mesh`. */
  private restRef: unknown = undefined;
  private restSig = "";
  private rest: Record<string, unknown> | null = null;
  private bones: Record<string, unknown> | null = null;
  private debug = "";
  width: number;
  height: number;

  constructor(private opts: SceneOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.camera = { x: opts.width / 2, y: opts.height / 2, zoom: 1 };
    this.nodes = new NodeStates({
      render: (name, st) => {
        const e = this.entries.get(name);
        if (!e) return;
        const h = e.holder;
        if (st.x !== undefined) h.x = st.x;
        if (st.y !== undefined) h.y = st.y;
        if (st.rz !== undefined) h.rotation = st.rz;
        if (st.sx !== undefined || st.sy !== undefined) h.scale.set(st.sx ?? 1, st.sy ?? 1);
        if (st.opacity !== undefined) h.alpha = st.opacity;
        if (st.visible !== undefined) h.visible = st.visible;
        if (st.z !== undefined) h.zIndex = st.z;
        if (st.color !== undefined && st.color !== e.spec.fill) this.redraw(e, st.color);
        this.sortIfY(e);
        opts.invalidate();
      },
      exists: (name) => this.entries.has(name),
      onReset: () => {
        for (const e of this.entries.values()) this.place(e);
        opts.invalidate();
      },
    });
  }

  async init(): Promise<void> {
    const o = this.opts;
    const bg = o.background.trim();
    await this.app.init({
      canvas: o.canvas,
      width: o.width,
      height: o.height,
      resolution: o.resolution,
      autoDensity: false,
      antialias: true,
      autoStart: false,
      sharedTicker: false,
      backgroundAlpha: bg && bg !== "transparent" ? 1 : 0,
      ...(bg && bg !== "transparent" ? { background: bg } : {}),
      preference: "webgl",
      // Le canvas doit rester lisible après le rendu : un `sonic-shader` peut le prendre comme texture.
      preserveDrawingBuffer: true,
    });
    if (this.destroyed) {
      this.app.destroy();
      return;
    }
    this.app.ticker.stop();
    this.ready = true;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Taille d'affichage (px CSS) : la scène logique est mise à l'échelle de la largeur. */
  resize(cssWidth: number, resolution: number): void {
    if (!this.ready) return;
    const k = cssWidth / this.width;
    const r = this.app.renderer;
    r.resolution = resolution;
    r.resize(Math.max(1, Math.round(cssWidth)), Math.max(1, Math.round(this.height * k)));
    this.app.stage.scale.set(k);
    // Les textes sont rastérisés à leur taille logique : agrandis par la mise à l'échelle de la
    // scène, ils devenaient flous. On les rastérise à la taille affichée (zoom caméra modéré compris).
    const textRes = Math.min(8, Math.max(1, resolution * k * 1.5));
    if (Math.abs(textRes - this.textResolution) > 0.01) {
      this.textResolution = textRes;
      for (const e of this.entries.values()) {
        if (e.art instanceof Text) e.art.resolution = textRes;
      }
    }
  }

  render(): void {
    if (this.ready && !this.destroyed) this.app.render();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.ready) this.app.destroy({ removeView: false }, { children: true, texture: true });
    this.ready = false;
    this.entries.clear();
    this.layers.clear();
  }

  /* ------------------------------------------------------------ calques et caméra */

  setLayers(layers: Layer[]): void {
    this.order = layers;
    const stage = this.app.stage;
    const keep = new Set(layers.map((l) => l.name));
    for (const [name, l] of this.layers) {
      if (keep.has(name)) continue;
      stage.removeChild(l.container);
      l.container.destroy({ children: false });
      this.layers.delete(name);
    }
    layers.forEach((layer, i) => {
      let l = this.layers.get(layer.name);
      if (!l) {
        l = { layer, container: new Container({ sortableChildren: true }) };
        l.container.label = `layer:${layer.name}`;
        this.layers.set(layer.name, l);
        stage.addChild(l.container);
      }
      l.layer = layer;
      l.container.zIndex = i;
    });
    stage.sortableChildren = true;
    // Sprites dont le calque a disparu : calque par défaut.
    for (const e of this.entries.values()) this.attach(e);
    for (const x of this.extras) this.layerOf(x.layer).container.addChild(x.c);
    this.applyCamera();
  }

  private extras: { c: Container; layer: string }[] = [];

  /** Ajoute un conteneur géré ailleurs (rendu d'un `monde`) dans un calque ; suit les changements de calques. */
  attachExtra(c: Container, layer: string): void {
    const i = this.extras.findIndex((x) => x.c === c);
    if (i >= 0) this.extras.splice(i, 1);
    this.extras.push({ c, layer });
    if (this.ready) this.layerOf(layer).container.addChild(c);
    this.opts.invalidate();
  }

  /** Coordonnées dans un calque d'un point écran (unités de la scène). */
  layerPoint(layer: string, sx: number, sy: number): [number, number] {
    const l = this.layerOf(layer);
    return screenToLayer(sx, sy, l.layer.parallax, this.camera, this.width, this.height);
  }

  setCamera(cam: Camera): void {
    this.camera = cam;
    this.applyCamera();
  }

  private applyCamera(): void {
    for (const { layer, container } of this.layers.values()) {
      const t = layerTransform(layer.parallax, this.camera, this.width, this.height);
      container.position.set(t.x, t.y);
      container.scale.set(t.scale);
    }
    this.opts.invalidate();
  }

  private layerOf(name: string): { layer: Layer; container: Container } {
    return this.layers.get(name) ?? this.layers.get(DEFAULT_LAYER) ?? this.layers.get(this.order[this.order.length - 1]?.name ?? "")!;
  }

  /* ------------------------------------------------------------ sprites */

  /** Ajoute / met à jour / retire les sprites d'un propriétaire (enfants ou liste). */
  syncSet(owned: Set<string>, specs: SpriteSpec[]): Set<string> {
    const next = new Set<string>();
    for (const s of specs) {
      this.upsert(s);
      next.add(s.name);
    }
    for (const n of owned) if (!next.has(n)) this.remove(n);
    this.nodes.renderAll(); // un sprite apparu reçoit l'état de son nœud
    this.opts.invalidate();
    return next;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  get count(): number {
    return this.entries.size;
  }

  private upsert(spec: SpriteSpec): void {
    const key = visualKey(spec);
    const e = this.entries.get(spec.name);
    if (!e) {
      const holder = new Container();
      holder.label = spec.name;
      const entry: Entry = { spec, key, holder, art: null, layer: "" };
      this.entries.set(spec.name, entry);
      this.redraw(entry);
      this.place(entry);
      this.attach(entry);
      return;
    }
    const layerChanged = e.spec.layer !== spec.layer;
    e.spec = spec;
    if (e.key !== key) {
      e.key = key;
      this.redraw(e, this.nodes.state(spec.name)?.color);
      if (this.nodes.state(spec.name)?.visible === undefined) e.holder.visible = !spec.hidden;
      if (this.nodes.state(spec.name)?.opacity === undefined) e.holder.alpha = spec.opacity;
      e.holder.blendMode = spec.blend;
      if (this.nodes.state(spec.name)?.z === undefined) e.holder.zIndex = spec.z;
    }
    if (layerChanged) this.attach(e);
  }

  private remove(name: string): void {
    const e = this.entries.get(name);
    if (!e) return;
    e.holder.parent?.removeChild(e.holder);
    e.holder.destroy({ children: true });
    this.entries.delete(name);
  }

  /** Position de départ de la description (la position vivante vient ensuite de `nodes`). */
  private place(e: Entry): void {
    const s = e.spec;
    e.holder.position.set(s.x, s.y);
    e.holder.rotation = s.angle * RAD;
    e.holder.scale.set(1);
    e.holder.alpha = s.opacity;
    e.holder.blendMode = s.blend;
    e.holder.visible = !s.hidden;
    e.holder.zIndex = s.z;
    this.sortIfY(e);
  }

  private attach(e: Entry): void {
    const target = this.layerOf(e.spec.layer);
    if (!target) return;
    e.layer = target.layer.name;
    if (e.holder.parent !== target.container) target.container.addChild(e.holder);
    this.sortIfY(e);
  }

  private sortIfY(e: Entry): void {
    const l = this.layers.get(e.layer);
    if (l?.layer.sortY) e.holder.zIndex = e.holder.y + (this.nodes.state(e.spec.name)?.z ?? e.spec.z) * 1e4;
  }

  /** Sprites alimentés par une source d'images : vrai tant qu'il en existe (la scène doit alors redessiner). */
  get hasLive(): boolean {
    for (const e of this.entries.values()) if (e.live) return true;
    return false;
  }

  /**
   * Met à jour les textures des sprites `source` quand leur source a produit une nouvelle image.
   * Vrai si au moins une a changé (la scène doit être redessinée).
   */
  refreshLive(): boolean {
    let changed = false;
    for (const e of this.entries.values()) {
      const live = e.live;
      if (!live || live.sp.destroyed) continue;
      const id = e.spec.source.slice(1);
      const el = this.opts.lookup?.(id) ?? document.getElementById(id);
      if (!isFrameSource(el) || el.frameSeq === live.seq) continue;
      live.seq = el.frameSeq;
      const canvas = el.getFrameCanvas();
      if (!canvas || canvas.width < 1 || canvas.height < 1) continue;
      if (live.canvas !== canvas || live.w !== canvas.width || live.h !== canvas.height) {
        const old = live.sp.texture;
        live.sp.texture = new Texture({ source: new CanvasSource({ resource: canvas, width: canvas.width, height: canvas.height, resolution: 1 }) });
        if (old !== Texture.EMPTY) old.destroy(true);
        live.canvas = canvas;
        live.w = canvas.width;
        live.h = canvas.height;
      } else live.sp.texture.source.update();
      // l'image tient dans la boîte w × h du sprite, proportions conservées
      if (live.sp instanceof Sprite) {
        const k = Math.min(e.spec.w / canvas.width, e.spec.h / canvas.height);
        live.sp.width = canvas.width * k;
        live.sp.height = canvas.height * k;
      }
      this.applyPivot(e);
      changed = true;
    }
    return changed;
  }

  private redraw(e: Entry, color?: string): void {
    const s = e.spec;
    const fill = color ?? s.fill;
    e.live = undefined;
    e.mesh = undefined;
    if (e.art) {
      e.holder.removeChild(e.art);
      e.art.destroy();
      e.art = null;
    }
    let art: ContainerChild;
    if (s.shape === "text") {
      const t = new Text({
        text: s.text,
        resolution: this.textResolution,
        style: { fill: fill || "#ffffff", fontSize: s.fontSize, fontFamily: s.font || this.opts.font || "system-ui, sans-serif", align: "center" },
      });
      t.anchor.set(0.5);
      art = t;
    } else if (s.shape === "image") {
      const sp = new Sprite(Texture.EMPTY);
      sp.anchor.set(0.5);
      sp.width = s.w;
      sp.height = s.h;
      if (s.source && !s.src) e.live = { sp, seq: -1, canvas: null, w: 0, h: 0 };
      if (s.src) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        img.onload = () => {
          if (sp.destroyed) return;
          sp.texture = Texture.from(img);
          sp.width = s.w;
          sp.height = s.h;
          this.applyPivot(e);
          this.opts.invalidate();
        };
        img.src = s.src;
      }
      art = sp;
    } else if (s.shape === "mesh") {
      const geom = new MeshGeometry({ positions: quadPositions(s), uvs: QUAD_UVS, indices: QUAD_INDICES });
      const m = new Mesh({ geometry: geom, texture: Texture.EMPTY });
      e.mesh = { m, geom, skin: null, frames: [], names: [], sig: "" };
      if (s.source && !s.src) e.live = { sp: m, seq: -1, canvas: null, w: 0, h: 0 };
      if (s.src) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        img.onload = () => {
          if (m.destroyed) return;
          m.texture = Texture.from(img);
          this.opts.invalidate();
        };
        img.src = s.src;
      }
      art = m;
    } else {
      const g = new Graphics();
      if (s.shape === "circle") g.circle(0, 0, s.r);
      else if (s.shape === "polygon") g.poly(s.points.flat(), true);
      else if (s.radius > 0) g.roundRect(-s.w / 2, -s.h / 2, s.w, s.h, s.radius);
      else g.rect(-s.w / 2, -s.h / 2, s.w, s.h);
      if (fill) g.fill({ color: fill });
      if (s.stroke && s.line > 0) g.stroke({ color: s.stroke, width: s.line });
      if (!fill && !(s.stroke && s.line > 0)) g.fill({ color: "#94a3b8" });
      art = g;
    }
    e.art = art;
    e.holder.addChild(art);
    this.applyPivot(e);
    this.skinMesh(e);
    this.opts.invalidate();
  }

  /* ------------------------------------------------------------ maillage déformable */

  /** Reçoit le squelette publié par `sonic-skeleton` ; les maillages se redéforment. */
  setSkeleton(rest: unknown, bones: unknown): void {
    const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
    if (rest !== this.restRef) {
      this.restRef = rest;
      this.rest = obj(rest);
      this.restSig = this.rest ? JSON.stringify(this.rest) : "";
    }
    this.bones = obj(bones);
    for (const e of this.entries.values()) this.skinMesh(e);
  }

  /** (Re)construit la grille et les poids si le repos ou le sprite a changé, puis place les sommets pour la pose courante. */
  private skinMesh(e: Entry): void {
    const mesh = e.mesh;
    if (!mesh) return;
    const s = e.spec;
    const restBones = this.rest;
    const names = restBones ? (s.skinBones.length ? s.skinBones : Object.keys(restBones)).filter((n) => boneFrame(restBones[n])) : [];
    const sig = `${this.restSig}|${names.join(",")}|${s.x},${s.y}`;
    if (mesh.sig !== sig) {
      mesh.sig = sig;
      const frames = names.map((n) => boneFrame(restBones?.[n])!);
      const skin = frames.length ? buildSkin({ x: s.x, y: s.y, w: s.w, h: s.h, cols: s.cols, rows: s.rows, rest: frames, falloff: s.falloff, influences: s.influences }) : null;
      mesh.skin = skin;
      mesh.frames = frames;
      mesh.names = names;
      if (skin) {
        mesh.geom.indices = skin.indices;
        mesh.geom.uvs = skin.uvs;
        mesh.geom.positions = new Float32Array(skin.count * 2);
      } else {
        mesh.geom.indices = QUAD_INDICES;
        mesh.geom.uvs = QUAD_UVS;
        mesh.geom.positions = quadPositions(s);
      }
    }
    const skin = mesh.skin;
    if (!skin) return;
    // un os absent de la pose courante garde son repos (skinVertices)
    const current = mesh.names.map((n) => boneFrame(this.bones?.[n])) as BoneFrame[];
    const pos = mesh.geom.positions;
    skinVertices(skin, mesh.frames, current, pos);
    // les sommets sont dans le repère du porteur, dont l'origine est la position de départ du sprite
    for (let i = 0; i < skin.count; i++) {
      pos[i * 2] -= s.x;
      pos[i * 2 + 1] -= s.y;
    }
    mesh.geom.buffers[0].update();
    this.drawDebug(e);
    this.opts.invalidate();
  }

  /** Mode de contrôle visuel : `""` (rien), `bones`, `mesh` ou `all`. */
  setDebug(mode: string): void {
    this.debug = mode.trim();
    for (const e of this.entries.values()) this.skinMesh(e);
  }

  /**
   * Contrôle visuel d'un maillage, dans le repère du sprite (il suit donc le même calque et la même caméra) :
   * os de repos (gris) et os courants (jaune), quadrillage déformé, sommets colorés par l'os qui pèse le plus.
   */
  private drawDebug(e: Entry): void {
    const mesh = e.mesh;
    if (!mesh) return;
    const mode = this.debug;
    const bonesOn = mode === "bones" || mode === "all" || mode === "true";
    const meshOn = mode === "mesh" || mode === "all" || mode === "true";
    if (!bonesOn && !meshOn) {
      if (mesh.dbg) {
        mesh.dbg.destroy();
        mesh.dbg = undefined;
      }
      return;
    }
    const skin = mesh.skin;
    if (!skin) return;
    if (!mesh.dbg) {
      mesh.dbg = new Graphics();
      e.holder.addChild(mesh.dbg);
    }
    const g = mesh.dbg;
    g.clear();
    const ox = e.spec.x;
    const oy = e.spec.y;
    const pos = mesh.geom.positions;
    if (meshOn) {
      const cols = skin.cols + 1;
      for (let r = 0; r <= skin.rows; r++) {
        for (let c = 0; c <= skin.cols; c++) {
          const i = r * cols + c;
          if (c < skin.cols) g.moveTo(pos[i * 2], pos[i * 2 + 1]).lineTo(pos[(i + 1) * 2], pos[(i + 1) * 2 + 1]);
          if (r < skin.rows) g.moveTo(pos[i * 2], pos[i * 2 + 1]).lineTo(pos[(i + cols) * 2], pos[(i + cols) * 2 + 1]);
        }
      }
      g.stroke({ color: 0xffffff, width: 0.6, alpha: 0.35 });
      for (let i = 0; i < skin.count; i++) {
        const b = skin.bone[i * skin.influences];
        g.circle(pos[i * 2], pos[i * 2 + 1], 1.8).fill({ color: hueColor(b, mesh.names.length) });
      }
    }
    if (bonesOn) {
      for (const f of mesh.frames) g.moveTo(f.x - ox, f.y - oy).lineTo(f.x2 - ox, f.y2 - oy);
      g.stroke({ color: 0x94a3b8, width: 2, alpha: 0.8 });
      mesh.names.forEach((n, k) => {
        const f = boneFrame(this.bones?.[n]);
        if (!f) return;
        g.moveTo(f.x - ox, f.y - oy).lineTo(f.x2 - ox, f.y2 - oy).stroke({ color: hueColor(k, mesh.names.length), width: 3 });
        g.circle(f.x - ox, f.y - oy, 4).fill({ color: 0xfacc15 });
      });
    }
  }

  /** Place le dessin pour que le pivot du sprite soit sur la position du nœud (la rotation se fait autour de lui). */
  private applyPivot(e: Entry): void {
    const art = e.art;
    if (!art) return;
    const s = e.spec;
    const [w, h] = s.shape === "text" || s.shape === "image" || s.shape === "mesh" ? [art.width, art.height] : s.shape === "circle" ? [2 * s.r, 2 * s.r] : [s.w, s.h];
    const [ox, oy] = pivotOffset(s, w, h);
    art.position.set(ox, oy);
  }

  /* ------------------------------------------------------------ toucher */

  /** Sprite touché au point (unités de scène), du calque avant au calque arrière, du plus haut au plus bas. */
  pick(sx: number, sy: number, accept: (name: string) => boolean): { name: string; x: number; y: number } | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const layer = this.order[i];
      const l = this.layers.get(layer.name);
      if (!l) continue;
      const [lx, ly] = screenToLayer(sx, sy, layer.parallax, this.camera, this.width, this.height);
      const kids = [...l.container.children].sort((a, b) => b.zIndex - a.zIndex);
      for (const holder of kids) {
        const e = this.entries.get(holder.label);
        if (!e || !holder.visible || holder.alpha <= 0 || !accept(e.spec.name)) continue;
        const local = holder.toLocal({ x: lx, y: ly }, l.container);
        const size: [number, number] | undefined = e.art && e.spec.shape === "text" ? [e.art.width, e.art.height] : undefined;
        if (hitShape(e.spec, local.x, local.y, size)) return { name: e.spec.name, x: lx, y: ly };
      }
    }
    return null;
  }

  /** Point de l'écran dans le calque du monde (parallaxe 1, ou le premier calque). */
  worldPoint(sx: number, sy: number): [number, number] {
    const world = this.order.find((l) => l.name === DEFAULT_LAYER) ?? this.order.find((l) => l.parallax === 1) ?? this.order[0];
    return screenToLayer(sx, sy, world?.parallax ?? 1, this.camera, this.width, this.height);
  }
}
