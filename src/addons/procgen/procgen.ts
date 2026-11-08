/**
 * `sonic-procgen` : scène procédurale 3D (rendu 2D ou 3D selon la caméra et le style), pilotée par DataProvider.
 *
 * Lit `dataProvider` ; écrit dans `state-out` (défaut `<dataProvider>State`) pour qu'un `sonic-store` qui publie dans
 * son propre DataProvider n'efface jamais `selection` ni `status`. Envoie les événements de jeu au store `target`.
 * Aucun code n'est évalué : recettes et expressions sont analysées par procgen lui-même.
 */
import { PublisherManager } from "@supersoniks/concorde/utils";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch, listStoreIds } from "../interactive";
import { Issues } from "./core/schema";
import { type Recipe, type SceneModel, composeSceneAsync } from "./scene/compose";
import { SCENES } from "./scene/library";
import { resolveStyle } from "./style/style";
import { type ActorIntent, type GameEvent, ProcgenView } from "./render/view";
import { VECTOR_STYLES, VectorView, composeVector } from "./vector/index";

type AnyView = ProcgenView | VectorView;

/** Un style vectoriel (`ligne-claire`, `flat/nuit`, `{vector: …}`) impose le mode vectoriel. */
function isVectorStyle(s: unknown): boolean {
  if (typeof s === "string") return (VECTOR_STYLES as readonly string[]).includes(s.split("/")[0]);
  return !!s && typeof s === "object" && typeof (s as Record<string, unknown>).vector === "string";
}
import { suggest } from "./core/schema";

const tagName = "sonic-procgen";

type Publisher = {
  get(): unknown;
  onAssign(handler: (v: unknown) => void, directHandlerCall?: boolean): void;
  offAssign(handler: (v: unknown) => void): void;
  onInternalMutation(handler: VoidFunction): void;
  offInternalMutation(handler: VoidFunction): void;
};
type Json = Record<string, unknown>;

/** Au plus deux contextes WebGL procgen par document. */
let liveViews = 0;
const MAX_VIEWS = 2;

export class SonicProcgen extends HTMLElement {
  static get observedAttributes() {
    return ["dataprovider", "state-out", "scene", "seed", "scene-style", "camera", "interactive", "target", "render"];
  }
  private root: ShadowRoot;
  private canvas: HTMLCanvasElement;

  private view: AnyView | null = null;
  private mode: "3d" | "vector" = "3d";
  private triedMode: string | null = null;
  private inView = true;
  private stage: HTMLDivElement;
  private svgKey: unknown = undefined;
  private svgOut: string | null = null;
  private publisher: Publisher | null = null;
  private model: SceneModel | null = null;
  private sceneKey = "";
  private styleKey = "";
  private viewKey = "";
  private miscKey = "";
  private kickKey: string | null = null;
  private issues: unknown[] = [];
  private error = "";
  /** Erreur de rendu (contexte WebGL) : durable, indépendante de la composition. */
  private glError = "";
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private outTimer = 0;
  private lastOut = "";
  private pointer: { x: number; y: number; t: number; moved: number; button: number; id: number } | null = null;
  private pinch: { d: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private composeMs = 0;
  private composing = false;
  private progress = 0;
  private pending: { cancelled: boolean } | null = null;
  private anchorList: string[] = [];

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ":host{display:block;position:relative;min-height:120px;contain:content}.stage{position:absolute;inset:0}canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}:host([interactive=false]) canvas{touch-action:auto}";
    this.stage = document.createElement("div");
    this.stage.className = "stage";
    this.canvas = document.createElement("canvas");
    this.stage.append(this.canvas);
    this.root.append(style, this.stage);
  }

  get dataProvider(): string {
    return this.getAttribute("dataProvider") ?? this.getAttribute("dataprovider") ?? "";
  }
  get stateOut(): string {
    return this.getAttribute("state-out") || (this.dataProvider ? `${this.dataProvider}State` : "");
  }
  get target(): string {
    return this.getAttribute("target") ?? "";
  }
  get interactive(): boolean {
    return this.getAttribute("interactive") !== "false";
  }
  get actionPrefix(): string {
    return this.getAttribute("action-prefix") ?? "";
  }
  /** Vue de rendu (tests, atelier). */
  get procgenView(): AnyView | null {
    return this.view;
  }
  get sceneModel(): SceneModel | null {
    return this.model;
  }

  connectedCallback() {
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => {
        this.view?.resize();
        this.view?.kick();
      });
      this.ro.observe(this);
    }
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver((es) => {
        this.inView = es.some((e) => e.isIntersecting);
        this.view?.setVisible(this.inView);
      });
      this.io.observe(this);
    }
    this.stage.addEventListener("pointerdown", this.onDown);
    this.stage.addEventListener("pointermove", this.onMove);
    this.stage.addEventListener("pointerup", this.onUp);
    this.stage.addEventListener("pointercancel", this.onUp);
    this.stage.addEventListener("wheel", this.onWheel, { passive: false });
    this.stage.addEventListener("contextmenu", this.onContext);
    this.bind();
  }

  disconnectedCallback() {
    this.unbind();
    this.ro?.disconnect();
    this.io?.disconnect();
    this.stage.removeEventListener("pointerdown", this.onDown);
    this.stage.removeEventListener("pointermove", this.onMove);
    this.stage.removeEventListener("pointerup", this.onUp);
    this.stage.removeEventListener("pointercancel", this.onUp);
    this.stage.removeEventListener("wheel", this.onWheel);
    this.stage.removeEventListener("contextmenu", this.onContext);
    this.dropView();
    clearTimeout(this.outTimer);
  }

  /** Libère la vue courante (et son contexte WebGL). */
  private dropView() {
    if (!this.view) return;
    this.view.dispose();
    if (this.mode === "3d") liveViews--;
    this.view = null;
  }

  /**
   * Vue du mode demandé : `3d` (three.js, WebGL2) ou `vector` (Canvas 2D, illustration vectorielle). Chaque mode a son
   * propre canevas (un canevas WebGL ne peut pas devenir 2D).
   */
  private ensureView(mode: "3d" | "vector"): AnyView | null {
    if (this.view && this.mode === mode) return this.view;
    this.dropView();
    this.mode = mode;
    this.glError = "";
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    this.canvas.replaceWith(canvas);
    this.canvas = canvas;
    try {
      if (mode === "vector") this.view = new VectorView(canvas);
      else if (liveViews >= MAX_VIEWS) this.glError = `au plus ${MAX_VIEWS} scènes procgen 3D par document`;
      else {
        this.view = new ProcgenView(canvas);
        liveViews++;
      }
    } catch (e) {
      this.glError = mode === "vector" ? `Canvas 2D indisponible : ${(e as Error).message}` : `WebGL2 indisponible : ${(e as Error).message}`;
    }
    const v = this.view;
    if (!v) return null;
    v.onEvent = (e) => this.emit(e);
    v.onFrame = () => this.queueOut();
    v.maxDpr = Math.min(mode === "vector" ? 3 : 2, window.devicePixelRatio || 1);
    v.dpr = mode === "vector" ? v.maxDpr : Math.min(1.5, v.maxDpr);
    try {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) v.play = false;
    } catch {
      /* rien */
    }
    v.setVisible(this.inView);
    return v;
  }

  attributeChangedCallback() {
    if (this.isConnected) this.bind();
  }

  private bind() {
    this.unbind();
    const id = this.dataProvider;
    if (id) {
      this.publisher = PublisherManager.get(id) as unknown as Publisher;
      this.publisher.onAssign(this.onData);
      this.publisher.onInternalMutation(this.onData);
    }
    this.onData();
  }
  private unbind() {
    if (!this.publisher) return;
    this.publisher.offAssign(this.onData);
    this.publisher.offInternalMutation(this.onData);
    this.publisher = null;
  }

  private data(): Json {
    const d = this.publisher?.get();
    return d && typeof d === "object" ? (d as Json) : {};
  }

  private onData = () => {
    const d = this.data();
    // scène : composition seulement si la recette, la graine, les paramètres ou les éditions changent
    const sceneName = String(d.scene ?? this.getAttribute("scene") ?? "village");
    const recipe = (d.recipe && typeof d.recipe === "object" ? d.recipe : null) as Recipe | null;
    const seed = d.seed ?? this.getAttribute("seed") ?? 1;
    const params = (d.params && typeof d.params === "object" ? d.params : {}) as Json;
    const edits = normEdits(d.edit);
    const styleIn0 = d.style ?? this.getAttribute("scene-style");
    const renderIn = String(d.render ?? this.getAttribute("render") ?? "");
    const mode: "3d" | "vector" = renderIn === "vector" || (renderIn !== "3d" && isVectorStyle(styleIn0 ?? (recipe ?? SCENES[sceneName])?.style)) ? "vector" : "3d";
    // une seule tentative par mode : sans WebGL, on compose quand même et on publie l'erreur, sans boucler
    if (mode !== this.mode || (!this.view && this.triedMode !== mode)) {
      const changed = mode !== this.mode && !!this.model;
      this.triedMode = mode;
      this.ensureView(mode);
      if (changed) this.sceneKey = "";
    }
    const key = JSON.stringify([mode, recipe ?? sceneName, seed, params, edits]);
    const issues = new Issues();
    if (key !== this.sceneKey) {
      this.sceneKey = key;
      let r: Recipe | undefined = recipe ?? SCENES[sceneName];
      if (!r) {
        issues.add({ path: "scene", code: "unknown", message: `scène « ${sceneName} » inconnue`, didYouMean: suggest(sceneName, Object.keys(SCENES)), hint: Object.keys(SCENES).join(", ") });
        r = SCENES.village;
      }
      if (this.pending) this.pending.cancelled = true;
      if (mode === "vector") {
        // composition vectorielle : sans maillage, rapide, synchrone
        const t0 = performance.now();
        try {
          this.model = composeVector({ recipe: r, seed: seed as string, params, edits });
          this.composeMs = Math.round(performance.now() - t0);
          this.issues = [...issues.list, ...this.model.issues];
          this.error = "";
          this.composing = false;
          this.view?.setModel(this.model);
          this.styleKey = this.viewKey = this.miscKey = "";
        } catch (e) {
          this.fail(`composition : ${(e as Error).message}`);
        }
      } else {
      // composition par tranches : la page reste fluide ; une composition dépassée est annulée
      const signal = { cancelled: false };
      this.pending = signal;
      const t0 = performance.now();
      this.composing = true;
      this.queueOut(true);
      composeSceneAsync({ recipe: r, seed: seed as string, params, edits }, { signal, onProgress: (done, total) => ((this.progress = total ? done / total : 0), this.queueOut()) })
        .then((model) => {
          if (!model || signal.cancelled) return;
          this.pending = null;
          this.composing = false;
          this.model = model;
          this.composeMs = Math.round(performance.now() - t0);
          this.issues = [...issues.list, ...model.issues];
          this.error = "";
          this.view?.setModel(model);
          this.styleKey = "";
          this.viewKey = "";
          this.miscKey = "";
          this.onData();
        })
        .catch((e) => {
          this.composing = false;
          this.fail(`composition : ${(e as Error).message}`);
        });
      }
    }
    if (!this.model || !this.view) {
      this.queueOut();
      return;
    }
    const styleIn = d.style ?? this.getAttribute("scene-style") ?? this.model.style ?? "gouache";
    const sk = JSON.stringify(styleIn);
    if (sk !== this.styleKey) {
      this.styleKey = sk;
      const si = new Issues();
      if (this.view instanceof VectorView) this.view.setStyle(styleIn);
      else this.view.setStyle(resolveStyle(styleIn, si));
      this.issues = [...this.issues.filter((i) => !String((i as { path: string }).path).startsWith("style")), ...si.list];
    }
    const vIn = { ...(this.model.view ?? {}), ...(this.getAttribute("camera") ? { camera: this.getAttribute("camera") } : {}), ...((d.view as Json) ?? {}) };
    const vk = JSON.stringify(vIn);
    if (vk !== this.viewKey) {
      this.viewKey = vk;
      this.view.setView(vIn);
    }
    const mk = JSON.stringify([d.anim, d.actors, d.select, d.hidden, d.anchors]);
    if (mk !== this.miscKey) {
      this.miscKey = mk;
      if (d.anim && typeof d.anim === "object") this.view.setAnim(d.anim as Json);
      if (d.actors && typeof d.actors === "object") this.view.setActors(d.actors as Record<string, ActorIntent>);
      if (d.select !== undefined) this.writeSelection(this.view.select(d.select ? String(d.select) : null)?.id ?? null);
      this.view.setHidden(Array.isArray(d.hidden) ? d.hidden.map(String) : []);
      this.anchorList = Array.isArray(d.anchors) ? d.anchors.map(String) : [];
    }
    // coups donnés aux ballons sans acteur : joués quand la valeur de `kick` change (pas au chargement, pas à la recomposition)
    const kk = JSON.stringify(d.kick ?? null);
    if (this.kickKey === null) this.kickKey = kk;
    else if (kk !== this.kickKey && this.model) {
      this.kickKey = kk;
      const kicks = Array.isArray(d.kick) ? d.kick : d.kick && typeof d.kick === "object" ? [d.kick] : [];
      for (const k of kicks.slice(0, 16) as Json[]) {
        if (!k || typeof k !== "object" || typeof k.ball !== "string") continue;
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        let v: [number, number, number] = [n(k.vx), n(k.vy), n(k.vz)];
        if (k.power !== undefined) {
          const a = (n(k.dir) * Math.PI) / 180, pw = n(k.power);
          v = [Math.sin(a) * pw, pw * (k.loft === undefined ? 0.15 : n(k.loft)), Math.cos(a) * pw];
        }
        if (!this.view.kickBall(k.ball, v)) { if (!this.issues.some((x) => (x as { path?: string; got?: unknown }).path === "kick.ball" && (x as { got?: unknown }).got === k.ball)) this.issues = [...this.issues, { path: "kick.ball", code: "unknown", message: `ballon inconnu : ${k.ball}`, got: k.ball }]; }
      }
    }
    // export SVG à la demande (mode vectoriel) : changer `exportSvg` (compteur) publie `svg` dans state-out
    if (d.exportSvg !== undefined && d.exportSvg !== this.svgKey) {
      this.svgKey = d.exportSvg;
      this.svgOut = this.view instanceof VectorView ? this.view.toSVG() : null;
      if (!(this.view instanceof VectorView)) this.issues = [...this.issues, { path: "exportSvg", code: "info", message: "export SVG disponible en mode vectoriel seulement (render: vector ou style vectoriel)" }];
      this.queueOut(true);
    }
    this.queueOut();
  };

  private fail(msg: string) {
    this.error = msg;
    this.queueOut(true);
  }

  /* ---------------- sorties ---------------- */

  private queueOut(now = false) {
    if (this.outTimer && !now) return;
    clearTimeout(this.outTimer);
    this.outTimer = window.setTimeout(() => {
      this.outTimer = 0;
      this.writeOut();
    }, now ? 0 : 200);
  }

  private writeOut() {
    const out = this.stateOut;
    if (!out) return;
    const st = this.view?.stats();
    const m = this.model;
    const status = {
      mode: this.mode,
      phase: this.error || this.glError ? "error" : this.composing ? "composing" : m ? "ready" : "idle",
      progress: this.composing ? Math.round(this.progress * 100) / 100 : 1,
      error: this.glError || this.error || null,
      ms: this.composeMs,
      objects: m?.stats.objects ?? 0,
      actors: m?.stats.actors ?? 0,
      triangles: st?.triangles ?? m?.stats.triangles ?? 0,
      drawCalls: st?.drawCalls ?? 0,
      fps: st?.fps ?? 0,
      scale: st?.scale ?? 1,
      issues: this.issues.slice(0, 40),
    };
    const actors: Record<string, unknown> = {};
    for (const id of this.view?.actorIds() ?? []) actors[id] = this.view!.actorState(id);
    const anchors = this.view && this.anchorList.length ? this.view.anchors(this.anchorList) : {};
    const nodes: Record<string, unknown> = {};
    for (const [k, a] of Object.entries(anchors)) nodes[k] = { x: a.x, y: a.y, hidden: !a.visible };
    const prev = (PublisherManager.get(out) as unknown as Publisher).get() as Json | null;
    const next = {
      ...(prev && typeof prev === "object" ? prev : {}),
      status,
      view: this.view?.getView() ?? null,
      actors,
      anchors,
      nodes,
      svg: this.svgOut,
      balls: this.view?.ballState() ?? {},
      ids: m ? m.objects.map((o) => ({ id: o.id, generator: o.generator, layer: o.layer, ...(o.affords ? { affords: o.affords } : {}) })).slice(0, 400) : [],
    };
    const sig = JSON.stringify(next);
    if (sig !== this.lastOut) {
      this.lastOut = sig;
      set(out, next);
    }
  }

  private writeSelection(id: string | null) {
    const out = this.stateOut;
    const o = id ? this.model?.objects.find((x) => x.id === id) : null;
    if (out) {
      const prev = (PublisherManager.get(out) as unknown as Publisher).get() as Json | null;
      set(out, { ...(prev && typeof prev === "object" ? prev : {}), selection: o ? { id: o.id, generator: o.generator, layer: o.layer, params: o.params, x: o.pos[0], y: o.pos[1], z: o.pos[2], ...(o.affords ? { affords: o.affords } : {}), ...(o.physics ? { physics: o.physics } : {}), ...(Object.keys(o.anchors).some((k) => k.startsWith("sit.")) ? { seats: Object.keys(o.anchors).filter((k) => k.startsWith("sit.")) } : {}) } : null });
    }
    return o;
  }

  private emit(e: GameEvent) {
    const type = `${this.actionPrefix}${e.type}`;
    if (this.target) {
      // stores du registre `interactive` (creative-stack), sinon `dispatchAction` (sonic-store de Concorde)
      if (listStoreIds().includes(this.target)) dispatch(this.target, { type, payload: e.payload });
      else {
        const root = this.getRootNode() as Document | ShadowRoot;
        const el = (root.getElementById?.(this.target) ?? document.getElementById(this.target)) as (Element & { dispatchAction?: (a: unknown) => void }) | null;
        el?.dispatchAction?.({ type, payload: e.payload });
      }
    }
    this.dispatchEvent(new CustomEvent(`procgen-${e.type}`, { detail: e.payload, bubbles: true, composed: true }));
    // positions des ballons republiées quand un coup part ou qu'un ballon s'arrête
    if (e.type === "kick" || e.type === "rest") this.queueOut();
  }

  /* ---------------- interactions ---------------- */

  private onContext = (ev: Event) => {
    if (this.interactive) ev.preventDefault();
  };
  private onDown = (ev: PointerEvent) => {
    if (!this.interactive || !this.view) return;
    this.canvas.setPointerCapture?.(ev.pointerId);
    this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    }
    this.pointer = { x: ev.clientX, y: ev.clientY, t: performance.now(), moved: 0, button: ev.button, id: ev.pointerId };
  };
  private onMove = (ev: PointerEvent) => {
    if (!this.pointer || !this.view) return;
    const prev = this.touches.get(ev.pointerId);
    this.touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (this.touches.size === 2 && this.pinch) {
      const [a, b] = [...this.touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.view.interact("zoom", (this.pinch.d - d) * 3);
      this.pinch.d = d;
      this.pointer.moved += 10;
      return;
    }
    if (!prev || ev.pointerId !== this.pointer.id) return;
    const dx = ev.clientX - prev.x, dy = ev.clientY - prev.y;
    this.pointer.moved += Math.abs(dx) + Math.abs(dy);
    if (this.pointer.moved < 4) return;
    const mode = this.view.cameraMode;
    const rotate = (mode === "perspective" || mode === "follow" || (mode === "iso" && ev.shiftKey)) && this.pointer.button === 0 && !ev.shiftKey === (mode !== "iso");
    this.view.interact(rotate ? "rotate" : "pan", dx, dy);
    this.queueOut();
  };
  private onUp = (ev: PointerEvent) => {
    this.touches.delete(ev.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    const p = this.pointer;
    if (!p || ev.pointerId !== p.id) return;
    this.pointer = null;
    if (p.moved < 6 && performance.now() - p.t < 450 && this.view) {
      const hit = this.view.pick(ev.clientX, ev.clientY);
      if (!hit) return;
      this.emit({ type: "pick", payload: hit });
      const id = hit.objectId;
      this.view.select(id);
      const o = this.writeSelection(id);
      this.emit({ type: "select", payload: { objectId: id, generator: o?.generator ?? null, layer: o?.layer ?? null, params: o?.params ?? null } });
    }
  };
  private onWheel = (ev: WheelEvent) => {
    if (!this.interactive || !this.view) return;
    ev.preventDefault();
    this.view.interact("zoom", ev.deltaY);
    this.queueOut();
  };
}

function normEdits(e: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!e || typeof e !== "object") return undefined;
  if (Array.isArray(e)) {
    const o: Record<string, Record<string, unknown>> = {};
    for (const x of e) if (x && typeof x === "object" && (x as Json).id) o[String((x as Json).id)] = { ...(o[String((x as Json).id)] ?? {}), ...(((x as Json).params as Json) ?? {}) };
    return o;
  }
  const x = e as Json;
  if (typeof x.id === "string" || typeof x.layer === "string") return { [String(x.id ?? x.layer)]: (x.params as Json) ?? {} };
  return x as Record<string, Record<string, unknown>>;
}

if (!customElements.get(tagName)) customElements.define(tagName, SonicProcgen);
