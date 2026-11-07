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
    return ["dataprovider", "state-out", "scene", "seed", "scene-style", "camera", "interactive", "target"];
  }
  private root: ShadowRoot;
  private canvas: HTMLCanvasElement;
  private view: ProcgenView | null = null;
  private publisher: Publisher | null = null;
  private model: SceneModel | null = null;
  private sceneKey = "";
  private styleKey = "";
  private viewKey = "";
  private miscKey = "";
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
    style.textContent = ":host{display:block;position:relative;min-height:120px;contain:content}canvas{display:block;width:100%;height:100%;touch-action:none;outline:none}:host([interactive=false]) canvas{touch-action:auto}";
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.root.append(style, this.canvas);
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
  get procgenView(): ProcgenView | null {
    return this.view;
  }
  get sceneModel(): SceneModel | null {
    return this.model;
  }

  connectedCallback() {
    if (!this.view) {
      if (liveViews >= MAX_VIEWS) {
        this.glError = `au plus ${MAX_VIEWS} scènes procgen par document`;
      } else {
        try {
          this.view = new ProcgenView(this.canvas);
          liveViews++;
        } catch (e) {
          this.glError = `WebGL2 indisponible : ${(e as Error).message}`;
        }
      }
    }
    if (this.view) {
      this.view.onEvent = (e) => this.emit(e);
      this.view.onFrame = () => this.queueOut();
      if (typeof ResizeObserver !== "undefined") {
        this.ro = new ResizeObserver(() => {
          this.view?.resize();
          this.view?.kick();
        });
        this.ro.observe(this);
      }
      if (typeof IntersectionObserver !== "undefined") {
        this.io = new IntersectionObserver((es) => this.view?.setVisible(es.some((e) => e.isIntersecting)));
        this.io.observe(this);
      }
      this.view.maxDpr = Math.min(2, window.devicePixelRatio || 1);
      this.view.dpr = Math.min(1.5, this.view.maxDpr);
      try {
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) this.view.play = false;
      } catch {
        /* rien */
      }
    }
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", this.onContext);
    this.bind();
  }

  disconnectedCallback() {
    this.unbind();
    this.ro?.disconnect();
    this.io?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("contextmenu", this.onContext);
    if (this.view) {
      this.view.dispose();
      this.view = null;
      liveViews--;
    }
    clearTimeout(this.outTimer);
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
    const key = JSON.stringify([recipe ?? sceneName, seed, params, edits]);
    const issues = new Issues();
    if (key !== this.sceneKey) {
      this.sceneKey = key;
      let r: Recipe | undefined = recipe ?? SCENES[sceneName];
      if (!r) {
        issues.add({ path: "scene", code: "unknown", message: `scène « ${sceneName} » inconnue`, didYouMean: suggest(sceneName, Object.keys(SCENES)), hint: Object.keys(SCENES).join(", ") });
        r = SCENES.village;
      }
      // composition par tranches : la page reste fluide ; une composition dépassée est annulée
      if (this.pending) this.pending.cancelled = true;
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
    if (!this.model || !this.view) {
      this.queueOut();
      return;
    }
    const styleIn = d.style ?? this.getAttribute("scene-style") ?? this.model.style ?? "gouache";
    const sk = JSON.stringify(styleIn);
    if (sk !== this.styleKey) {
      this.styleKey = sk;
      const si = new Issues();
      this.view.setStyle(resolveStyle(styleIn, si));
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
      ids: m ? m.objects.map((o) => ({ id: o.id, generator: o.generator, layer: o.layer })).slice(0, 400) : [],
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
      set(out, { ...(prev && typeof prev === "object" ? prev : {}), selection: o ? { id: o.id, generator: o.generator, layer: o.layer, params: o.params, x: o.pos[0], y: o.pos[1], z: o.pos[2] } : null });
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
