/**
 * `sonic-procgen` : scène procédurale 3D (rendu 2D ou 3D selon la caméra et le style), pilotée par DataProvider.
 *
 * Lit `dataProvider` ; écrit dans `state-out` (défaut `<dataProvider>State`) pour qu'un `sonic-store` qui publie dans
 * son propre DataProvider n'efface jamais `selection` ni `status`. Envoie les événements de jeu au store `target`.
 * Aucun code n'est évalué : recettes et expressions sont analysées par procgen lui-même.
 */
import { applyGestures, gestureMode, wheelToPage } from "../../shared/gestures";
import { PublisherManager } from "@supersoniks/concorde/utils";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { dispatch, listStoreIds } from "../interactive";
import { Issues } from "./core/schema";
import { type Recipe, type SceneModel, composeSceneAsync, groundHeight } from "./scene/compose";
import { SCENES } from "./scene/library";
import { mergeEmitters, readProcgenEmitters } from "./scene/emitters";
import { resolveStyle } from "./style/style";
import { ambianceFx } from "./style/ambiance";
import { readProcgenPhoto, type ProcgenPhotoState } from "./render/photo";
import { type ActorIntent, type GameEvent, ProcgenView } from "./render/view";
import { type ViewSync, syncView } from "./render/steady";
import { VECTOR_STYLES, VectorView, composeVector } from "./vector/index";
import { fxInputOf, stripFx } from "./scene/fx";
import { type ResolvedStates, resolveStates, statesInputOf, stripStates } from "./scene/states";

type AnyView = ProcgenView | VectorView;

/** Un style vectoriel (`ligne-claire`, `flat/nuit`, `{vector: …}`) impose le mode vectoriel. */
function isVectorStyle(s: unknown): boolean {
  if (typeof s === "string") return (VECTOR_STYLES as readonly string[]).includes(s.split("/")[0]);
  return !!s && typeof s === "object" && typeof (s as Record<string, unknown>).vector === "string";
}
import { suggest } from "./core/schema";
import { composeScene } from "./scene/compose";
import { type Arranged, type Mover, type PlaceCtx, arrangeAt, moverFor, moverOf, placeCtx } from "./edit/arrange";
import { Gesture, type GestureCmd } from "./edit/gesture";
import { listenTurn, wrapAngle } from "../../shared/monde/turn-keys";
import { MainThreadRunner, type InfiniteSpec, type TileEdits, type TileRunner, TileWorld, readInfinite, readTileEdits, recordMove } from "./scene/infinite";
import { tileKey, tileOf } from "../../shared/monde/tiles";

/**
 * Fabrique de compositeur de tuiles hors fil principal (worker fourni par l'application : voir `tile-worker.ts`).
 * Sans fabrique, ou si le worker échoue, les tuiles se composent sur le fil principal par tranches.
 */
let tileRunnerFactory: (() => TileRunner | null) | null = null;
export function setProcgenTileRunner(f: (() => TileRunner | null) | null) {
  tileRunnerFactory = f;
}

const nextFrame = (f: () => void): number => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : (setTimeout(f, 16) as unknown as number));
const cancelFrame = (h: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(h) : clearTimeout(h));
const R2 = (v: number) => Math.round(v * 100) / 100;
const DEGS = 180 / Math.PI;

/** `name` passe la regex `re` (regex invalide : égalité stricte). */
function matches(re: string, name: string): boolean {
  try {
    return new RegExp(re).test(name);
  } catch {
    return re === name;
  }
}

const tagName = "sonic-procgen";

/** Parties mobiles et états libres publiés (`selection`, `ids`) : `parts: [{name, label, kind, range, value}]`, `states`. */
function partsOut(o: SceneModel["objects"][number]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.joints?.length) out.parts = o.joints.map((j) => ({ name: j.name, label: j.label, kind: j.kind, range: j.range, value: R2(o.states?.[j.name] ?? j.initial) }));
  const free = o.states ? Object.entries(o.states).filter(([k]) => !o.joints?.some((j) => j.name === k)) : [];
  if (free.length) out.states = Object.fromEntries(free.map(([k, v]) => [k, R2(v)]));
  return out;
}

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
    return ["dataprovider", "state-out", "scene", "seed", "scene-style", "camera", "interactive", "target", "render", "gestures", "drag", "drag-selected", "keep-heading", "ambiance", "photo"];
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
  private fxKey = "";
  private fxModel: unknown = null;
  /** États des objets lus (recette ⊕ `states`) : relus quand les clés ou le modèle changent. */
  private statesKey = "";
  private statesModel: unknown = null;
  private resolved: ResolvedStates | null = null;
  /** Dernière entrée de vue appliquée : la vue de l'utilisateur survit aux recompositions. */
  private viewSync: ViewSync = { key: "", modelKey: "" };
  private miscKey = "";
  private kickKey: string | null = null;
  private forcesKey = "";
  private queriesKey = "";
  /** Émetteurs lus (recette ⊕ `emitters` du DataProvider, graine, qualité) : relus seulement quand la clé change. */
  private emitKey = "";
  private emitIssues: unknown[] = [];
  private issues: unknown[] = [];
  private error = "";
  /** Erreur de rendu (contexte WebGL) : durable, indépendante de la composition. */
  private glError = "";
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private outTimer = 0;
  private lastOut = "";
  private gesture = new Gesture();
  /** Objet sélectionné (tap ou clé `select`). */
  private selectedId: string | null = null;
  /** Objet sous le doigt au début du geste (saisi au-delà de 4 px) ou refusé. */
  private grab: { id: string; ok: boolean } | null = null;
  private dragging: {
    id: string; mover: Mover; ctx: PlaceCtx; off: [number, number]; planeY: number; lift: number; from: [number, number];
    last: Arranged | null; px: number; py: number; raf: number; stopTurn: () => void; outT: number;
    /** Corps dynamique : suit le doigt sans rangement, retombe au lâcher. */
    body?: boolean;
  } | null = null;
  private pointerType = "mouse";
  private placeKey = "";
  private freeOut: unknown = null;
  private measures = new Map<string, { generator: string; hx: number; hz: number }>();
  private idsCache: { model: SceneModel | null; v: number; list: unknown[] } = { model: null, v: -1, list: [] };
  private idsVersion = 0;
  private composeMs = 0;
  private composing = false;
  private progress = 0;
  private pending: { cancelled: boolean } | null = null;
  /** Modèle composé arrivé pendant un glisser : adopté au lâcher (la scène ne change pas sous le doigt). */
  private deferred: (() => void) | null = null;
  /** Poses posées au doigt (id → pose, instant) : rejouées sur un modèle dont la composition a commencé avant la pose. */
  private moved = new Map<string, { x: number; y: number; z: number; yaw: number; t: number }>();
  private anchorList: string[] = [];
  /** Rendu soigné : réglages appliqués, état publié (`state-out.photo`). */
  private photoKey = "";
  private photoOut: ProcgenPhotoState | null = null;
  private ambianceOut: { name: string; meteo: string[] } | null = null;
  /** Monde infini : spécification, retouches persistées (copie interne, reprise du DataProvider `tiles`). */
  private infSpec: InfiniteSpec | null = null;
  private tileEdits: TileEdits = {};
  private tilesKey = "";

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
  /** Motif (regex) des ids ou calques déplaçables au doigt ; vide : aucun. */
  get dragPattern(): string {
    return this.getAttribute("drag") ?? "";
  }
  get dragSelected(): boolean {
    const v = this.getAttribute("drag-selected");
    return v !== null && v !== "false";
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
      // le redimensionnement est appliqué par la vue au début de son prochain rendu (pas d'image vide)
      this.ro = new ResizeObserver(() => {
        this.syncGestures();
        this.view?.resize();
      });
      this.ro.observe(this);
    }
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver((es) => {
        this.inView = es.some((e) => e.isIntersecting);
        this.syncGestures();
        this.view?.setVisible(this.inView);
      });
      this.io.observe(this);
    }
    this.stage.addEventListener("pointerdown", this.onDown);
    this.stage.addEventListener("pointermove", this.onMove);
    this.stage.addEventListener("pointerup", this.onUp);
    this.stage.addEventListener("pointercancel", this.onCancel);
    this.stage.addEventListener("wheel", this.onWheel, { passive: false });
    this.stage.addEventListener("contextmenu", this.onContext);
    this.stage.addEventListener("dblclick", this.onDblClick);
    this.bind();
  }

  disconnectedCallback() {
    this.unbind();
    this.ro?.disconnect();
    this.io?.disconnect();
    this.stage.removeEventListener("pointerdown", this.onDown);
    this.stage.removeEventListener("pointermove", this.onMove);
    this.stage.removeEventListener("pointerup", this.onUp);
    this.stage.removeEventListener("pointercancel", this.onCancel);
    this.stage.removeEventListener("wheel", this.onWheel);
    this.stage.removeEventListener("contextmenu", this.onContext);
    this.stage.removeEventListener("dblclick", this.onDblClick);
    this.endDrag(false);
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
    this.syncGestures();
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
    // nouvelle vue : style, vue et réglages seront appliqués au prochain modèle
    this.styleKey = this.miscKey = this.emitKey = "";
    this.viewSync = { key: "", modelKey: "" };
    if (!v) return null;
    v.onEvent = (e: GameEvent) => this.emit(e);
    v.onFrame = () => this.queueOut();
    if (v instanceof ProcgenView) {
      this.photoKey = "";
      v.onPhoto = (st) => {
        this.photoOut = st;
        // fin du calcul publiée tout de suite ; pendant, au rythme habituel
        this.queueOut(st.etat !== "calcul");
      };
    }
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
    this.syncGestures();
  }

  /** Mode coopératif (attribut `gestures`, voir shared/gestures.ts) : la page garde défilement vertical et molette. */
  private coop = false;
  private syncGestures() {
    if (!this.interactive) {
      this.coop = false;
      this.style.touchAction = "";
      if (this.canvas) this.canvas.style.touchAction = "auto";
      return;
    }
    this.coop = applyGestures(this, [this.canvas], gestureMode(this.getAttribute("gestures")));
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
    // `render: "photo"` : rendu 3D, rendu soigné qui fige l'animation dès que la vue est immobile
    const mode: "3d" | "vector" = renderIn === "photo" ? "3d" : renderIn === "vector" || (renderIn !== "3d" && isVectorStyle(styleIn0 ?? (recipe ?? SCENES[sceneName])?.style)) ? "vector" : "3d";
    // une seule tentative par mode : sans WebGL, on compose quand même et on publie l'erreur, sans boucler
    if (mode !== this.mode || (!this.view && this.triedMode !== mode)) {
      const changed = mode !== this.mode && !!this.model;
      this.triedMode = mode;
      this.ensureView(mode);
      if (changed) this.sceneKey = "";
    }
    // météo, effets et particules ne recomposent pas la scène (relus à part, voir plus bas)
    // états des objets (parties mobiles, états libres) non plus : la vue les anime sans recomposer
    const key = JSON.stringify([mode, recipe ? stripStates(stripFx(recipe)) : sceneName, seed, params, edits]);
    const issues = new Issues();
    if (key !== this.sceneKey) {
      this.sceneKey = key;
      let r: Recipe | undefined = recipe ?? SCENES[sceneName];
      if (!r) {
        issues.add({ path: "scene", code: "unknown", message: `scène « ${sceneName} » inconnue`, didYouMean: suggest(sceneName, Object.keys(SCENES)), hint: Object.keys(SCENES).join(", ") });
        r = SCENES.village;
      }
      if (this.pending) this.pending.cancelled = true;
      // monde infini (rendu 3D) : la scène composée ne garde que les acteurs et les zones ; sol, routes et couches
      // viennent des tuiles composées autour du point suivi
      const inf = readInfinite(r.infinite, issues, String(seed));
      if (inf && mode === "vector") issues.add({ path: "infinite", code: "info", message: "monde infini en rendu 3D seulement : scène finie en rendu vectoriel" });
      this.infSpec = mode === "3d" ? inf : null;
      const full = r;
      if (this.infSpec) {
        if (r.physics) issues.add({ path: "physics", code: "info", message: "monde infini : physique 3D des scènes finies seulement (ignorée)" });
        r = { ...r, ground: false, layers: [], paths: [], size: [20, 20], physics: undefined };
      }
      if (mode === "vector") {
        // composition vectorielle : sans maillage, rapide, synchrone
        const t0 = performance.now();
        try {
          this.model = composeVector({ recipe: r, seed: seed as string, params, edits });
          this.composeMs = Math.round(performance.now() - t0);
          this.issues = [...issues.list, ...this.model.issues, ...this.emitIssues];
          this.error = "";
          this.composing = false;
          this.view?.setModel(this.model);
          // vue conservée : seule une entrée de vue modifiée la ré-applique (voir syncView)
          this.styleKey = this.miscKey = "";
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
      composeSceneAsync({ recipe: r, seed: seed as string, params, edits, mobile: isMobile() }, { signal, onProgress: (done, total) => ((this.progress = total ? done / total : 0), this.queueOut()) })
        .then((model) => {
          if (!model || signal.cancelled) return;
          const adopt = () => {
            if (signal.cancelled) return;
            this.pending = null;
            this.composing = false;
            this.model = model;
            this.composeMs = Math.round(performance.now() - t0);
            this.issues = [...issues.list, ...model.issues, ...this.emitIssues];
            this.error = "";
            this.view?.setModel(model);
            if (this.view instanceof ProcgenView) {
              const spec = this.infSpec;
              let world: TileWorld | null = null;
              if (spec) {
                let runner: TileRunner | null = null;
                try {
                  runner = tileRunnerFactory?.() ?? null;
                } catch {
                  runner = null;
                }
                const mobile = typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
                world = new TileWorld(spec, full, String(seed), params, runner ?? new MainThreadRunner(), { low: mobile });
                world.setEdits(this.tileEdits);
              }
              this.view.onTiles = () => {
                this.idsVersion++;
                if (this.selectedId) this.view?.select(this.selectedId);
                this.queueOut();
              };
              this.view.setInfinite(world, spec?.follow ?? "camera");
            }
            this.replayMoves(t0);
            if (this.selectedId) this.view?.select(this.selectedId);
            this.styleKey = "";
            this.miscKey = "";
            this.onData();
          };
          // pendant un glisser, l'ancien modèle reste affiché jusqu'au lâcher
          if (this.dragging) this.deferred = adopt;
          else adopt();
        })
        .catch((e) => {
          this.composing = false;
          this.fail(`composition : ${(e as Error).message}`);
        });
      }
    }
    // retouches du monde infini : le DataProvider (`tiles`) fait foi quand il change
    const tk = JSON.stringify(d.tiles ?? null);
    if (tk !== this.tilesKey) {
      this.tilesKey = tk;
      this.tileEdits = readTileEdits(d.tiles);
      if (this.view instanceof ProcgenView) this.view.infinite?.setEdits(this.tileEdits);
    }
    if (!this.model || !this.view) {
      this.queueOut();
      return;
    }
    let styleIn = d.style ?? this.getAttribute("scene-style") ?? this.model.style ?? "gouache";
    // ambiance (DataProvider, attribut, ou recette) : remplace le style de la recette ; un style écrit la complète
    const ambIn = d.ambiance ?? this.getAttribute("ambiance") ?? ((recipe ?? SCENES[sceneName]) as { ambiance?: unknown } | undefined)?.ambiance;
    if (ambIn !== undefined && ambIn !== null && ambIn !== "") {
      const own = d.style ?? this.getAttribute("scene-style");
      styleIn = own && typeof own === "object" ? { ...(own as Json), ambiance: ambIn } : own ? { preset: own, ambiance: ambIn } : { ambiance: ambIn };
    }
    const sk = JSON.stringify(styleIn);
    if (sk !== this.styleKey) {
      this.styleKey = sk;
      const si = new Issues();
      if (this.view instanceof VectorView) {
        this.view.setStyle(styleIn);
        // la pile `post` est propre au rendu 3D (passes GPU) : ignorée en vectoriel, signalée
        if (styleIn && typeof styleIn === "object" && (styleIn as Json).post !== undefined && (styleIn as Json).post !== null && !(Array.isArray((styleIn as Json).post) && !((styleIn as Json).post as unknown[]).length))
          si.add({ path: "style.post", code: "info", message: "post-traitement ignoré en rendu vectoriel (render: vector) : effets GPU du rendu 3D seulement" });
      } else {
        const st = resolveStyle(styleIn, si);
        this.view.setStyle(st);
        this.ambianceOut = st.ambiance ? { name: st.ambiance, meteo: st.meteo } : null;
      }
      this.issues = [...this.issues.filter((i) => !String((i as { path: string }).path).startsWith("style")), ...si.list];
    }
    // particules : météo, fumées, feux, embruns (clés de recette ; `weather` du DataProvider prioritaire)
    const fxIn = fxInputOf((recipe ?? SCENES[sceneName] ?? null) as Record<string, unknown> | null, d.weather);
    // météo d'une ambiance : seulement là où la recette et le DataProvider n'écrivent rien (voir style/ambiance.ts)
    if (this.ambianceOut?.meteo.length) {
      const fx0 = fxIn.fx && typeof fxIn.fx === "object" ? (fxIn.fx as Json) : undefined;
      const add = ambianceFx(this.ambianceOut.meteo, { weather: fxIn.weather, mist: fx0?.mist });
      if (add.weather) fxIn.weather = add.weather;
      if (add.mist) fxIn.fx = { ...(fx0 ?? {}), mist: add.mist };
    }
    // états : recette (`layers[i].states`, `actors.<id>.states`, `stateFx`) puis clé `states` (fusionnée par objet)
    const stIn = statesInputOf((recipe ?? SCENES[sceneName] ?? null) as Record<string, unknown> | null, d.states, d.stateSpeed);
    const stk = JSON.stringify(stIn);
    if (stk !== this.statesKey || this.statesModel !== this.model) {
      this.statesKey = stk;
      this.statesModel = this.model;
      const si = new Issues();
      this.resolved = resolveStates(stIn, this.model.objects, si);
      this.view.setStates(this.resolved.values, this.resolved.speed, this.resolved.lights);
      const stPath = /^(states|stateSpeed)(\.|$)|^layers\[\d+\]\.(states|stateFx)|^actors\.[^.]+\.states/;
      this.issues = [...this.issues.filter((i) => !stPath.test(String((i as { path: string }).path))), ...si.list];
      this.idsVersion++;
    }
    if (this.resolved?.fx.length) fxIn.states = this.resolved.fx;
    const fk = JSON.stringify(fxIn);
    if (fk !== this.fxKey || this.fxModel !== this.model) {
      this.fxKey = fk;
      this.fxModel = this.model;
      this.view.setFx(fxIn);
      const fxPath = /^(weather|fx|particles)(\.|$)|^layers\[\d+\]\.fx/;
      this.issues = [...this.issues.filter((i) => !fxPath.test(String((i as { path: string }).path))), ...this.view.fxIssues];
    }
    if (d.fx !== undefined) this.view.fxOrders(d.fx);
    // rendu soigné : clé `photo` (ou attribut) ; `render: "photo"` l'impose et fige l'animation à l'arrêt
    if (this.view instanceof ProcgenView) {
      const photoIn = d.photo ?? (this.hasAttribute("photo") ? (this.getAttribute("photo") === "false" ? false : true) : undefined);
      const pk = JSON.stringify([photoIn ?? null, renderIn === "photo"]);
      if (pk !== this.photoKey) {
        this.photoKey = pk;
        const pi = new Issues();
        this.view.setPhoto(readProcgenPhoto(photoIn, renderIn === "photo", (path, message) => pi.add({ path, code: "unknown", message })));
        this.issues = [...this.issues.filter((i) => !String((i as { path: string }).path).startsWith("photo")), ...pi.list];
      }
    }
    const vs = syncView(this.viewSync, this.model.view, this.getAttribute("camera"), d.view);
    this.viewSync = vs.next;
    if (vs.apply) this.view.setView(vs.apply, vs.reset);
    const mk = JSON.stringify([d.anim, d.actors, d.select, d.hidden, d.anchors]);
    if (mk !== this.miscKey) {
      this.miscKey = mk;
      if (d.anim && typeof d.anim === "object") this.view.setAnim(d.anim as Json);
      if (d.actors && typeof d.actors === "object") this.view.setActors(d.actors as Record<string, ActorIntent>);
      if (d.select !== undefined) this.writeSelection((this.selectedId = this.view.select(d.select ? String(d.select) : null)?.id ?? null));
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
    // physique : ordres `forces` (compteurs) et requêtes `queries` (rayon, sphère, boîte)
    if (this.view instanceof ProcgenView) {
      const fk = JSON.stringify(d.forces ?? null);
      if (fk !== this.forcesKey) {
        this.forcesKey = fk;
        if (d.forces && typeof d.forces === "object") this.view.applyForces(d.forces);
      }
      const qk = JSON.stringify(d.queries ?? null);
      if (qk !== this.queriesKey) {
        this.queriesKey = qk;
        this.view.applyQueries(d.queries);
      }
    } else if (this.model?.physics && !this.issues.some((x) => (x as { path?: string }).path === "physics")) {
      this.issues = [...this.issues, { path: "physics", code: "info", message: "physique 3D en rendu 3D seulement : en rendu vectoriel, les ballons gardent leur simulation simple" }];
    }
    // émetteurs : recette ⊕ `emitters` du DataProvider ; les copies en vol survivent aux relectures
    this.syncEmitters(d, recipe ?? SCENES[sceneName] ?? null, seed);
    // place libre demandée (nouvel objet) : calculée une fois par valeur de `placeRequest`
    if (d.placeRequest && typeof d.placeRequest === "object" && !this.composing) {
      const pk = JSON.stringify(d.placeRequest);
      if (pk !== this.placeKey) {
        this.placeKey = pk;
        this.answerPlace(d.placeRequest as Json);
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

  private syncEmitters(d: Json, recipe: Recipe | null, seed: unknown) {
    const merged = mergeEmitters((recipe as { emitters?: unknown } | null)?.emitters, d.emitters);
    const mobile = this.view instanceof ProcgenView && this.view.isMobile;
    const ek = JSON.stringify([merged ?? null, seed, mobile, this.mode]);
    if (ek !== this.emitKey) {
      this.emitKey = ek;
      const prev = this.emitIssues;
      if (this.view instanceof ProcgenView) {
        const built = readProcgenEmitters(merged, { seed: seed as string, quality: mobile ? 0.5 : 1 });
        this.view.setEmitters(built);
        this.emitIssues = built.issues;
      } else this.emitIssues = merged && Object.keys(merged).length ? [{ path: "emitters", code: "info", message: "émetteurs dessinés en rendu 3D seulement (render: vector les ignore)" }] : [];
      this.issues = [...this.issues.filter((i) => !prev.includes(i)), ...this.emitIssues];
    }
    if (this.view instanceof ProcgenView && d.emit !== undefined) this.view.emitOrders(d.emit);
  }

  private fail(msg: string) {
    this.error = msg;
    this.queueOut(true);
  }

  /* ---------------- sorties ---------------- */

  private queueOut(now = false) {
    if (this.outTimer && !now) return;
    clearTimeout(this.outTimer);
    // pendant un geste (glisser, vue) : 15 fois par seconde, pour que la bulle d'actions suive ; sinon 5
    this.outTimer = window.setTimeout(() => {
      this.outTimer = 0;
      this.writeOut();
    }, now ? 0 : this.gesture.active || this.dragging ? 66 : 200);
  }

  /** Liste légère des objets (id, calque, position, cap, emprise), recalculée seulement quand la scène change. */
  private idsList(): unknown[] {
    const m = this.model;
    const ver = this.idsVersion + (this.view instanceof ProcgenView ? this.view.physVersion * 1e6 : 0);
    if (this.idsCache.model === m && this.idsCache.v === ver) return this.idsCache.list;
    const list = m
      ? m.objects.slice(0, 400).map((o) => ({ id: o.id, generator: o.generator, layer: o.layer, x: R2(o.pos[0]), z: R2(o.pos[2]), yaw: Math.round(o.yaw * DEGS), w: R2(o.footprint.hx * 2), d: R2(o.footprint.hz * 2), ...(o.place ? { place: o.place } : {}), ...(o.affords ? { affords: o.affords } : {}), ...partsOut(o) }))
      : [];
    this.idsCache = { model: m, v: ver, list };
    return list;
  }

  /**
   * L'objet se glisse-t-il au doigt (motif `drag`, rendu 3D) ? Tout objet de couche (point `at` réécrit, calque
   * réparti : `layers[i].moves[index]`), tout acteur de `recipe.actors` ; pas les ballons (corps de jeu).
   */
  private movable(o: { id: string; layer: string; place?: string; generator: string }): boolean {
    const re = this.dragPattern;
    if (!re || !(matches(re, o.id) || matches(re, o.layer))) return false;
    // corps dynamique (moteur chargé) : se saisit quel que soit son placement, ballons compris
    if (this.isBody(o.id)) return true;
    // monde infini : tout objet d'une tuile se glisse (la pose est persistée par tuile : `tiles`)
    return !!o.place && o.generator !== "ball";
  }

  private isBody(id: string): boolean {
    return this.view instanceof ProcgenView && !!this.view.rigid?.isDynamic(id);
  }

  private selectionOut(id: string | null) {
    const o = id ? this.model?.objects.find((x) => x.id === id) : null;
    if (!o) return null;
    return { id: o.id, generator: o.generator, layer: o.layer, params: o.params, x: R2(o.pos[0]), y: R2(o.pos[1]), z: R2(o.pos[2]), yaw: Math.round(o.yaw * DEGS), w: R2(o.footprint.hx * 2), d: R2(o.footprint.hz * 2), h: R2(o.height), ...(o.place ? { place: o.place, index: o.index ?? 0 } : {}), movable: this.mode === "3d" && this.movable(o), ...(o.affords ? { affords: o.affords } : {}), ...partsOut(o), ...(o.physics ? { physics: o.physics } : {}), ...(Object.keys(o.anchors).some((k) => k.startsWith("sit.")) ? { seats: Object.keys(o.anchors).filter((k) => k.startsWith("sit.")) } : {}) };
  }

  /** Problèmes de la scène et des tuiles du monde infini (préfixés `infinite.tile.`). */
  private allIssues(): unknown[] {
    const w = this.view instanceof ProcgenView ? this.view.infinite : null;
    return w?.issues.length ? [...this.issues, ...w.issues.map((i) => ({ ...i, path: `infinite.tile.${i.path}` }))] : this.issues;
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
      objects: this.infSpec && m ? m.objects.length : m?.stats.objects ?? 0,
      actors: m?.stats.actors ?? 0,
      ...(m?.meadows?.length ? { blades: m.meadows.reduce((n, f) => n + f.blades.length / 6, 0) } : {}),
      triangles: st?.triangles ?? m?.stats.triangles ?? 0,
      drawCalls: st?.drawCalls ?? 0,
      fps: st?.fps ?? 0,
      scale: st?.scale ?? 1,
      ...(st && "postPasses" in st ? { postPasses: st.postPasses } : {}),
      ...(st && "soft" in st && st.soft ? { soft: st.soft } : {}),
      ...(this.view?.fx.systems.length ? { fx: this.view.fx.summary() } : {}),
      ...(st && "photoMs" in st ? { photoMs: st.photoMs } : {}),
      issues: (st && "postError" in st && st.postError ? [{ path: "style.post", code: "info", message: `post-traitement désactivé : shader refusé par le pilote (${String(st.postError).slice(0, 160)})` }, ...this.allIssues()] : this.allIssues()).slice(0, 40),
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
      ...(this.view instanceof ProcgenView && this.model?.physics ? { physics: this.view.physOut, queries: this.view.queryOut } : {}),
      ...(this.view instanceof ProcgenView ? this.view.emitState() : {}),
      ids: this.idsList(),
      ...(this.selectedId ? { selection: this.selectionOut(this.selectedId) } : {}),
      drag: this.dragging?.last ? { objectId: this.dragging.id, x: this.dragging.last.x, y: this.dragging.last.y, z: this.dragging.last.z, yaw: Math.round(this.dragging.last.yaw * DEGS), valid: this.dragging.last.valid } : null,
      free: this.freeOut,
      photo: this.photoOut,
      ambiance: this.ambianceOut,
      ...(this.infSpec && this.view instanceof ProcgenView ? { infinite: this.view.infiniteState(), tiles: this.tileEdits } : {}),
    };
    const sig = JSON.stringify(next);
    if (sig !== this.lastOut) {
      this.lastOut = sig;
      set(out, next);
    }
  }

  private writeSelection(id: string | null) {
    const out = this.stateOut;
    const o = id ? this.model?.objects.find((x) => x.id === id) ?? null : null;
    if (out) {
      const prev = (PublisherManager.get(out) as unknown as Publisher).get() as Json | null;
      set(out, { ...(prev && typeof prev === "object" ? prev : {}), selection: o ? this.selectionOut(o.id) : null });
    }
    return o;
  }

  private emit(e: GameEvent) {
    // fin d'animation d'une partie : `ids` et `selection` republiés avec la nouvelle valeur
    if (e.type === "state") {
      this.idsVersion++;
      this.queueOut();
    }
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
    if (e.type === "kick" || e.type === "rest" || e.type === "settle" || e.type === "drop" || e.type === "impact") this.queueOut();
  }

  /* ---------------- interactions ---------------- */

  private onContext = (ev: Event) => {
    if (this.interactive) ev.preventDefault();
  };

  /** Au début d'un appui : l'objet sous le doigt se saisira-t-il (au-delà de 4 px) ? */
  private canDrag(clientX: number, clientY: number): "drag" | "refuse" | null {
    this.grab = null;
    const v = this.view;
    // pendant une recomposition, le modèle affiché (l'ancien) reste saisissable : le geste ne part pas en orbite
    if (!this.dragPattern || !(v instanceof ProcgenView) || !this.model) return null;
    if (this.dragSelected && !this.selectedId) return null;
    // l'objet doit être le premier sous le doigt (pas un autre devant lui)
    const id = v.pick(clientX, clientY)?.objectId ?? null;
    if (!id || (this.dragSelected && id !== this.selectedId)) return null;
    const o = this.model.objects.find((x) => x.id === id);
    if (!o || !(matches(this.dragPattern, o.id) || matches(this.dragPattern, o.layer))) return null;
    const ok = this.movable(o);
    this.grab = { id, ok };
    return ok ? "drag" : "refuse";
  }

  private onDown = (ev: PointerEvent) => {
    if (!this.interactive || !this.view) return;
    // premier geste : le rendu soigné rend la main tout de suite
    if (this.view instanceof ProcgenView) this.view.touch();
    this.pointerType = ev.pointerType || "mouse";
    try {
      this.canvas.setPointerCapture?.(ev.pointerId);
    } catch {
      /* pointeur déjà relâché */
    }
    this.run(this.gesture.down(ev.pointerId, ev.clientX, ev.clientY, ev.button, performance.now(), () => this.canDrag(ev.clientX, ev.clientY)), ev);
  };
  private onMove = (ev: PointerEvent) => {
    if (!this.view || !this.gesture.active) return;
    this.run(this.gesture.move(ev.pointerId, ev.clientX, ev.clientY, ev.shiftKey), ev);
  };
  private onUp = (ev: PointerEvent) => {
    this.run(this.gesture.up(ev.pointerId, ev.clientX, ev.clientY, performance.now()), ev);
  };
  private onCancel = (ev: PointerEvent) => {
    // geste repris par le navigateur (défilement) : ni tap ni pose
    this.run(this.gesture.cancel(ev.pointerId), ev);
  };

  private run(cmds: GestureCmd[], ev: PointerEvent) {
    const v = this.view;
    if (!v) return;
    for (const c of cmds) {
      switch (c.kind) {
        case "orbit": {
          const mode = v.cameraMode;
          const rotate = (mode === "perspective" || mode === "follow" || (mode === "iso" && c.shift)) && c.button === 0 && !c.shift === (mode !== "iso");
          v.interact(rotate ? "rotate" : "pan", c.dx, c.dy);
          break;
        }
        case "pan":
          v.interact("pan", c.dx, c.dy);
          break;
        case "zoom":
          v.interact("zoom", c.amount);
          break;
        case "dragStart":
          if (this.grab?.ok) this.startDrag(this.grab.id, c.x, c.y);
          break;
        case "drag":
          if (this.dragging) {
            this.dragging.px = c.x;
            this.dragging.py = c.y;
            if (!this.dragging.raf) this.dragging.raf = nextFrame(() => this.dragFrame());
          }
          break;
        case "dragEnd":
          this.endDrag(true);
          break;
        case "dragCancel":
          this.endDrag(false);
          break;
        case "refused": {
          const o = this.grab ? this.model?.objects.find((x) => x.id === this.grab!.id) : null;
          if (o) this.emit({ type: "dragRefused", payload: { objectId: o.id, layer: o.layer, index: o.index ?? 0, place: o.place ?? null, reason: "placement" } });
          break;
        }
        case "tap":
          this.tap(c.x, c.y);
          break;
      }
    }
    if (cmds.length) this.queueOut();
    void ev;
  }

  private tap(clientX: number, clientY: number) {
    const v = this.view;
    if (!v) return;
    const hit = v.pick(clientX, clientY);
    if (!hit) return;
    this.emit({ type: "pick", payload: hit });
    const id = hit.objectId;
    v.select(id);
    this.selectedId = id;
    const o = this.writeSelection(id);
    this.emit({ type: "select", payload: { objectId: id, instance: id, generator: o?.generator ?? null, layer: o?.layer ?? null, params: o?.params ?? null, index: o?.index ?? null, place: o?.place ?? null, x: o ? R2(o.pos[0]) : null, z: o ? R2(o.pos[2]) : null, yaw: o ? Math.round(o.yaw * DEGS) : null, movable: !!o && this.mode === "3d" && this.movable(o) } });
  }

  private startDrag(id: string, clientX: number, clientY: number) {
    const v = this.view;
    const m = this.model;
    if (!(v instanceof ProcgenView) || !m) return;
    const o = m.objects.find((x) => x.id === id);
    if (!o || !v.dragBegin(id)) return;
    const gp = v.groundPoint(clientX, clientY, o.pos[1]);
    const mover = moverOf(o);
    const body = this.isBody(id);
    // les corps dynamiques ne gênent pas un rangement : ils sont poussés
    const skip = new Set([id, ...(v.rigid?.dynamicIds ?? [])]);
    const st = {
      body, id, mover, ctx: placeCtx(m, skip), off: (gp ? [o.pos[0] - gp[0], o.pos[2] - gp[1]] : [0, 0]) as [number, number], planeY: o.pos[1],
      lift: Math.min(0.3, Math.max(0.06, o.height * 0.03)), from: [o.pos[0], o.pos[2]] as [number, number], last: null as Arranged | null, px: clientX, py: clientY, raf: 0, stopTurn: () => {}, outT: 0,
    };
    this.dragging = st;
    // R (quart de tour), Q / E, molette (15°) : seule rotation possible, jamais automatique
    st.stopTurn = listenTurn(this, (d) => {
      st.mover = { ...st.mover, yaw: wrapAngle(st.mover.yaw + d) };
      this.dragFrame();
    });
    this.emit({ type: "dragstart", payload: { objectId: id, instance: id, layer: o.layer, index: o.index ?? 0, x: R2(o.pos[0]), z: R2(o.pos[2]) } });
  }

  /** Une pose par image au plus : rangement, puis l'objet suit (soulevé, rouge sans place libre). */
  private dragFrame() {
    const st = this.dragging;
    const v = this.view;
    if (!st || !(v instanceof ProcgenView)) return;
    if (st.raf) cancelFrame(st.raf);
    st.raf = 0;
    const gp = v.groundPoint(st.px, st.py, st.planeY);
    if (!gp) return;
    if (st.body) {
      // corps saisi : soulevé au-dessus du sol sous le doigt, sans rangement (la physique écarte ce qu'il touche)
      const x = gp[0] + st.off[0], z = gp[1] + st.off[1];
      const y = groundHeight(this.model!, x, z, st.planeY) + 0.25;
      st.last = { x: R2(x), y: R2(y), z: R2(z), yaw: st.mover.yaw, valid: true, hits: [], snaps: [] } as unknown as Arranged;
      v.dragTo(x, y, z, st.mover.yaw);
      this.queueOut();
      return;
    }
    const res = arrangeAt(st.ctx, st.mover, gp[0] + st.off[0], gp[1] + st.off[1]);
    st.last = res;
    v.dragTo(res.x, res.y + st.lift, res.z, res.yaw, !res.valid);
    this.queueOut();
  }

  /** Lâcher : une seule action `place` (pose valide) ; sinon retour à la place de départ et `dragRefused`. */
  private endDrag(commit: boolean) {
    const st = this.dragging;
    if (!st) return;
    if (st.raf && commit) this.dragFrame();
    if (st.raf) cancelFrame(st.raf);
    st.stopTurn();
    this.dragging = null;
    const v = this.view;
    const res = st.last;
    const ok = commit && !!res && res.valid;
    if (st.body) {
      // corps lâché : il reprend la physique ; la pose finale arrive par `rest` / `settle` et `state-out.physics`
      if (v instanceof ProcgenView) v.dragEnd(null);
      if (res) this.emit({ type: "drop", payload: { objectId: st.id, x: res.x, y: res.y, z: res.z } });
      this.idsVersion++;
      if (this.selectedId) this.writeSelection(this.selectedId);
      const adopt0 = this.deferred;
      this.deferred = null;
      adopt0?.();
      this.queueOut(true);
      return;
    }
    if (v instanceof ProcgenView) v.dragEnd(ok ? { x: res!.x, y: res!.y, z: res!.z, yaw: res!.yaw } : null);
    this.idsVersion++;
    const o = this.model?.objects.find((x) => x.id === st.id);
    if (ok && o) this.moved.set(st.id, { x: res!.x, y: res!.y, z: res!.z, yaw: res!.yaw, t: performance.now() });
    if (ok && o) {
      // monde infini : pose persistée dans la tuile (copie interne, et `tiles` prêt à recopier par le store)
      let inf: Json = {};
      const spec = this.infSpec;
      if (spec && o.place !== "actor" && v instanceof ProcgenView) {
        const w = v.infinite;
        const r = recordMove(this.tileEdits, spec, o, st.from, { x: res!.x, z: res!.z, yaw: res!.yaw * DEGS }, w ? w.center : st.from);
        this.tileEdits = r.tiles;
        w?.setEdits(r.tiles);
        const [cx, cz] = tileOf(spec.tile, res!.x, res!.z);
        inf = { tile: tileKey(cx, cz), tiles: r.tiles, persist: { count: r.count, total: spec.persist, dropped: r.dropped } };
      }
      this.emit({ type: "place", payload: { objectId: st.id, instance: st.id, layer: o.layer, index: o.index ?? 0, place: o.place ?? null, x: res!.x, y: res!.y, z: res!.z, yaw: Math.round(res!.yaw * DEGS * 10) / 10, ry: Math.round(res!.yaw * 1e4) / 1e4, valid: true, snaps: res!.snaps, from: { x: R2(st.from[0]), z: R2(st.from[1]) }, ...inf } });
    } else if (commit && res && o) {
      this.emit({ type: "dragRefused", payload: { objectId: st.id, layer: o.layer, index: o.index ?? 0, place: o.place ?? null, reason: "occupied", hits: res.hits } });
    }
    if (this.selectedId) this.writeSelection(this.selectedId);
    const adopt = this.deferred;
    this.deferred = null;
    adopt?.();
    this.queueOut(true);
  }

  /**
   * Poses faites au doigt après le début de la composition du modèle `since` : rejouées sur ce modèle (il ne les
   * connaît pas encore) ; une pose antérieure est oubliée (la recette du store l'a reprise, ou l'a refusée).
   */
  private replayMoves(since: number) {
    const v = this.view;
    for (const [id, mv] of this.moved) {
      if (mv.t <= since) {
        this.moved.delete(id);
        continue;
      }
      const o = this.model?.objects.find((x) => x.id === id);
      if (!o || !(v instanceof ProcgenView)) continue;
      if (Math.hypot(o.pos[0] - mv.x, o.pos[2] - mv.z) < 0.005 && Math.abs(o.yaw - mv.yaw) < 1e-3) continue;
      if (!v.dragBegin(id)) continue;
      v.dragTo(mv.x, mv.y, mv.z, mv.yaw, false);
      v.dragEnd({ x: mv.x, y: mv.y, z: mv.z, yaw: mv.yaw });
    }
  }

  /**
   * Place libre pour un nouvel objet (`placeRequest` du DataProvider) : `{id, gen, params, at: [x, z], size: [w, d],
   * yaw (°), onWater, ignore}` → `state-out.free` et action `placeFree` `{id, x, y, z, yaw, valid, hits, snaps}`.
   */
  private answerPlace(req: Json) {
    const m = this.model;
    if (!m) return;
    const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
    let fp: { generator: string; hx: number; hz: number } | null = null;
    const size = Array.isArray(req.size) ? req.size : null;
    const gen = typeof req.gen === "string" ? req.gen : "";
    if (size) fp = { generator: gen.split(".")[0] || "prop", hx: Math.max(0.05, num(size[0], 1) / 2), hz: Math.max(0.05, num(size[1], num(size[0], 1)) / 2) };
    else if (gen) {
      const key = JSON.stringify([gen, req.params ?? {}]);
      fp = this.measures.get(key) ?? null;
      if (!fp) {
        try {
          // emprise mesurée sur une scène d'un seul objet (mêmes règles d'échelle que la composition)
          const one = composeScene({ recipe: { size: [400, 400], ground: false, layers: [{ id: "m", gen, params: (req.params as Json) ?? {}, place: { at: [[0, 0]] } }] }, seed: 1 });
          const o = one.objects[0];
          if (o) {
            fp = { generator: o.generator, hx: o.footprint.hx, hz: o.footprint.hz };
            if (this.measures.size > 32) this.measures.clear();
            this.measures.set(key, fp);
          }
        } catch {
          fp = null;
        }
      }
    }
    if (!fp) fp = { generator: "prop", hx: 0.5, hz: 0.5 };
    const vw = this.view?.getView() as { cx?: number | null; cz?: number | null } | undefined;
    const at = Array.isArray(req.at) ? req.at : [vw?.cx ?? 0, vw?.cz ?? 0];
    const yaw = num(req.yaw, 0) / DEGS;
    // `ignore` : ids ou calques à ne pas compter (le nouvel objet déjà ajouté à la scène, par exemple)
    const ign = (Array.isArray(req.ignore) ? req.ignore : req.ignore !== undefined ? [req.ignore] : []).map(String);
    const skip = new Set(m.objects.filter((o) => ign.includes(o.id) || ign.includes(o.layer)).map((o) => o.id));
    const res = arrangeAt(placeCtx(m, skip), moverFor("_new", fp.generator, fp.hx, fp.hz, yaw, { onWater: !!req.onWater, onPath: !!req.onPath }), num(at[0], 0), num(at[1], 0));
    this.freeOut = { id: req.id ?? null, x: res.x, y: res.y, z: res.z, yaw: Math.round(res.yaw * DEGS * 10) / 10, valid: res.valid, hits: res.hits, snaps: res.snaps, ...(this.infSpec ? { tile: tileKey(...tileOf(this.infSpec.tile, res.x, res.z)) } : {}) };
    this.emit({ type: "placeFree", payload: this.freeOut as Json });
    this.queueOut(true);
  }

  private onDblClick = () => {
    // double-clic (souris) : recentrer sur la vue de la scène ; un double tap au doigt reste deux taps
    if (!this.interactive || !this.view || !this.model || this.pointerType === "touch") return;
    this.view.setView(this.model.view ?? {}, true);
    this.queueOut();
  };

  private onWheel = (ev: WheelEvent) => {
    if (!this.interactive || !this.view || wheelToPage(this.coop, ev)) return;
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

/** Écran tactile ou petit (prairies moins denses en `meadowDetail: "auto"`). */
function isMobile(): boolean {
  return typeof window !== "undefined" && !!(window.matchMedia?.("(pointer: coarse)").matches || Math.min(window.screen?.width ?? 2000, window.screen?.height ?? 2000) < 700);
}
