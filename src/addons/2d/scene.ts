/**
 * Runtime Pixi de `sonic-2d` : calques, sprites (dessin + porteur de transformation), caméra,
 * rendu à la demande. Les décisions (format nodes, calques, toucher) sont dans ./model.ts et
 * src/shared/node-state.ts ; ici on ne fait qu'appliquer.
 */
// Sans ce module, Pixi compile ses shaders avec `new Function` : refusé par une CSP sans unsafe-eval (viewer Artefacts).
import "pixi.js/unsafe-eval";
import { Application, Container, Graphics, Sprite, Text, Texture, type ContainerChild } from "pixi.js";
import { NodeStates } from "../../shared/node-state";
import {
  DEFAULT_LAYER,
  hitShape,
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
};

const RAD = Math.PI / 180;

export type SceneOptions = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  background: string;
  resolution: number;
  /** Demande un rendu (coalescé par l'élément). */
  invalidate: () => void;
};

export class Scene2D {
  readonly app = new Application();
  readonly nodes: NodeStates;
  private entries = new Map<string, Entry>();
  private layers = new Map<string, { layer: Layer; container: Container }>();
  private order: Layer[] = [];
  private camera: Camera;
  private ready = false;
  private destroyed = false;
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
    this.applyCamera();
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

  private redraw(e: Entry, color?: string): void {
    const s = e.spec;
    const fill = color ?? s.fill;
    if (e.art) {
      e.holder.removeChild(e.art);
      e.art.destroy();
      e.art = null;
    }
    let art: ContainerChild;
    if (s.shape === "text") {
      const t = new Text({ text: s.text, style: { fill: fill || "#ffffff", fontSize: s.fontSize, fontFamily: s.font, align: "center" } });
      t.anchor.set(0.5);
      art = t;
    } else if (s.shape === "image") {
      const sp = new Sprite(Texture.EMPTY);
      sp.anchor.set(0.5);
      sp.width = s.w;
      sp.height = s.h;
      if (s.src) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        img.onload = () => {
          if (sp.destroyed) return;
          sp.texture = Texture.from(img);
          sp.width = s.w;
          sp.height = s.h;
          this.opts.invalidate();
        };
        img.src = s.src;
      }
      art = sp;
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
    this.opts.invalidate();
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
