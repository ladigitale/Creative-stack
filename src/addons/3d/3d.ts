import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PublisherManager } from "@supersoniks/concorde/utils";
import { ensure } from "./ensure";
import { formBind, type FormOrbit } from "./form-bind";
import { life } from "./life";
import { outPublish } from "./out-publish";
import { postBind } from "./post-bind";
import { dispatch } from "../interactive";
import type { SceneHit } from "./pick";
import { playback } from "./playback";
import { pointer } from "./pointer";
import { Sonic3dProps } from "./props";
import type { SceneRuntime } from "./scene-runtime";
import { sonic3dStyles } from "./styles";
import { status, type Sonic3dStatus } from "./status";
import { propUpdate } from "./updated";
import { wire } from "./wire";

/**
 * Accès à la scène pour `sonic-xr` (WebXR) : renderer, scène, caméra, et la boucle de `sonic-3d`
 * suspendue pendant la session (`pause` / `resume`).
 */
export type Sonic3dXrHost = {
  renderer: import("three").WebGLRenderer;
  scene: import("three").Scene;
  camera: import("three").Camera;
  /** Suspend la boucle de la fenêtre et passe le runtime en rendu XR (sans post-effets ni étalonnage). */
  pause(): void;
  /** Rend la caméra, l'orbite, la taille et la boucle d'origine. */
  resume(): void;
  /** Une image XR (à appeler depuis `renderer.setAnimationLoop`). */
  render(): void;
  /** Boîte englobante du contenu, en coordonnées de la scène. */
  bounds(): { center: [number, number, number]; min: [number, number, number]; max: [number, number, number] } | null;
  /** Rayon en coordonnées monde : objet touché (mêmes filtres que le tap). */
  pickRay(origin: [number, number, number], dir: [number, number, number]): (SceneHit & { instance?: string; src?: number }) | null;
  /** Émet le tap de `sonic-3d` (`pick` + action vers `target`) pour un objet touché (coordonnées de la scène). */
  tap(hit: (SceneHit & { instance?: string; src?: number }) | null): void;
};

/** Frames sans mouvement avant `rest` / `moving=0`. */
const REST_STILL_FRAMES = 8;
/**
 * Viewer 3D Concorde (Three.js) — glTF/GLB, caméra orbit/perspective/ortho,
 * outputs dataProvider paresseux. Opt-in : `@supersoniks/concorde/3d`.
 */
@customElement("sonic-3d")
export class Sonic3d extends Sonic3dProps {
  static styles = sonic3dStyles;

  @state() errorMessage = "";
  /** État standard publié en sortie (`status` / `error`). */
  status: Sonic3dStatus = "idle";
  /** Vrai pendant l'écriture de `status` / `error` (DP partagé : pas de relecture form). */
  writingStatus = false;
  lastStatusSig = "";

  /** État runtime partagé avec les helpers (lu ici pour noUnusedLocals). */
  runtime: SceneRuntime | null = null;
  raf = 0;
  startTime = 0;
  frame = 0;
  hovering = false;
  pointerX = 0.5;
  pointerY = 0.5;
  lastHit: SceneHit | null = null;
  outEventListeners = 0;
  inView = true;
  ready = false;
  releasing = false;
  loadToken = 0;
  resizeObserver: ResizeObserver | null = null;
  intersectionObserver: IntersectionObserver | null = null;
  formPublisher: ReturnType<typeof PublisherManager.get> | null = null;
  outPublisher: ReturnType<typeof PublisherManager.get> | null = null;
  lastOutAt = 0;
  lastSnapshotAt = 0;
  snapshotBusy = false;
  frameUrls: string[] = [];
  snapshotSeq = 0;
  /** Contrat SonicFrameSource — incrémenté après chaque render. */
  frameSeq = 0;
  lastDrawAt = 0;
  lastFormOrbit: FormOrbit | null = null;
  /** Dernier `nodes` appliqué (idempotence). */
  lastNodesJson = "";
  /** Début du pointerdown courant (tap vs drag). */
  tapStart: { x: number; y: number; t: number } | null = null;
  /** Session WebXR en cours (`sonic-xr`) : boucle de la fenêtre suspendue. */
  xrPresenting = false;
  /** Consommateurs live (`registerFrameConsumer`). */
  private frameConsumers = new Set<object>();
  /** 1 si caméra en mouvement, 0 sinon (publié en out). */
  moving = 0;
  private stillFrames = 0;
  private lastMotionYaw = NaN;
  private lastMotionPitch = NaN;
  private lastMotionDist = NaN;

  get frameConsumerCount() {
    return this.frameConsumers.size;
  }

  onFormMutation = () => {
    if (this.writingStatus) return;
    const data = (this.formPublisher?.get() ?? {}) as Record<string, unknown>;
    formBind.formParams.applyFormParams(this as never, data);
  };

  connectedCallback() {
    super.connectedCallback();
    // Lectures groupées : champs mutés via helpers (noUnusedLocals).
    void [
      this.pointerX,
      this.pointerY,
      this.lastHit,
      this.inView,
      this.releasing,
      this.loadToken,
      this.resizeObserver,
      this.intersectionObserver,
      this.formPublisher,
      this.outPublisher,
      this.lastOutAt,
      this.lastSnapshotAt,
      this.snapshotBusy,
      this.frameUrls,
      this.snapshotSeq,
      this.lastFormOrbit,
      this.syncAutoRotate,
      this.syncPlayback,
      this.bindOutPublisher,
      this.onPointerMove,
      this.onPointerDown,
      this.onPointerUp,
      this.tapStart,
      this.lastNodesJson,
      this.onDblClick,
      this.onPointerEnter,
      this.onPointerLeave,
      this.onFormMutation,
      this.errorMessage,
    ];
    wire.connect(this as never);
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "out" && listener) this.outEventListeners++;
    super.addEventListener(type, listener as never, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (type === "out" && listener) {
      this.outEventListeners = Math.max(0, this.outEventListeners - 1);
    }
    super.removeEventListener(type, listener as never, options);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    wire.disconnect(this as never);
  }

  protected firstUpdated() {
    life.firstUpdated(this as never);
  }

  protected updated(changed: Map<string | number | symbol, unknown>) {
    propUpdate.updated(this as never, changed);
  }

  syncAutoRotate = () => playback.syncAutoRotate(this as never);
  syncPlayback = () => playback.syncPlayback(this as never, this.loop);
  bindOutPublisher = () => {
    const prev = this.outPublisher;
    life.bindOutPublisher(this as never);
    // nouveau DP de sortie : il reçoit l'état courant
    if (this.outPublisher && this.outPublisher !== prev && this.status !== "idle") {
      this.lastStatusSig = "";
      status.set(this as never, this.status);
    }
  };

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.drawFrame(performance.now());
    if (this.playOnHover && !this.hovering && !this.autoRotate) {
      playback.stopLoop(this as never);
    }
  };

  private drawFrame(now: number) {
    if (!this.runtime || !this.ready) return;
    this.frame++;
    const time = (now - this.startTime) / 1000;
    const timeDelta = Math.max(0, (now - this.lastDrawAt) / 1000);
    this.lastDrawAt = now;
    postBind.syncFrame(this as never, time, timeDelta, this.frame);
    this.runtime.render();
    this.placeAnchor();
    this.frameSeq++;
    this.trackMotion(time);
    outPublish.maybePublish(this as never, now, time);
  }

  /**
   * Enregistre un consommateur live (`sonic-shader` / `sonic-webgpu` via `#id`).
   * Garde le RAF hors viewport tant qu’il reste au moins un token.
   */
  registerFrameConsumer(token: object = {}) {
    this.frameConsumers.add(token);
    ensure.syncVisibility(this as never);
  }

  unregisterFrameConsumer(token: object = {}) {
    this.frameConsumers.delete(token);
    ensure.syncVisibility(this as never);
  }

  /**
   * Coupe `autoRotate` + inertie OrbitControls.
   * Émet `rest` si la caméra était en mouvement.
   */
  stopMotion() {
    this.autoRotate = false;
    this.runtime?.stopMotion();
    this.stillFrames = REST_STILL_FRAMES;
    if (this.moving !== 0) {
      this.moving = 0;
      this.dispatchEvent(
        new CustomEvent("rest", {
          detail: { moving: 0 },
          bubbles: true,
          composed: true,
        }),
      );
    }
    this.syncPlayback();
  }

  private trackMotion(time: number) {
    if (!this.runtime) return;
    const snap = this.runtime.snapshot({
      time,
      frame: this.frame,
      hovering: this.hovering ? 1 : 0,
      pointerX: this.pointerX,
      pointerY: this.pointerY,
      hit: this.lastHit,
    });
    const eps = 1e-5;
    const still =
      Number.isFinite(this.lastMotionYaw) &&
      Math.abs(snap.yaw - this.lastMotionYaw) < eps &&
      Math.abs(snap.pitch - this.lastMotionPitch) < eps &&
      Math.abs(snap.distance - this.lastMotionDist) < eps &&
      !this.autoRotate;
    this.lastMotionYaw = snap.yaw;
    this.lastMotionPitch = snap.pitch;
    this.lastMotionDist = snap.distance;
    if (still) {
      this.stillFrames++;
      if (this.stillFrames >= REST_STILL_FRAMES && this.moving !== 0) {
        this.moving = 0;
        this.dispatchEvent(
          new CustomEvent("rest", {
            detail: { moving: 0, yaw: snap.yaw, pitch: snap.pitch },
            bubbles: true,
            composed: true,
          }),
        );
      }
    } else {
      this.stillFrames = 0;
      this.moving = 1;
    }
  }

  /**
   * Hôte WebXR pour `sonic-xr` ; `null` tant que la scène n'est pas prête.
   * Pendant la session, la boucle de la fenêtre est suspendue (le RAF ne tourne pas dans un casque) ;
   * `render()` dessine une image sans post-effets ni étalonnage.
   */
  getXrHost(): Sonic3dXrHost | null {
    const rt = this.runtime;
    if (!rt || !this.ready) return null;
    return {
      renderer: rt.renderer,
      scene: rt.scene,
      camera: rt.camera,
      pause: () => {
        this.xrPresenting = true;
        playback.stopLoop(this as never);
        rt.xrBegin();
      },
      resume: () => {
        if (!this.xrPresenting) return;
        this.xrPresenting = false;
        rt.xrEnd();
        this.syncPlayback();
      },
      render: () => {
        if (!this.xrPresenting || this.runtime !== rt) return;
        this.frame++;
        rt.renderXr();
        this.frameSeq++;
        outPublish.maybePublish(this as never, performance.now(), (performance.now() - this.startTime) / 1000);
      },
      bounds: () => rt.bounds(),
      pickRay: (o, d) => rt.pickRay(o, d, this.pickNames),
      tap: (hit) => {
        if (hit) {
          this.lastHit = hit;
          this.dispatchEvent(new CustomEvent("pick", { detail: hit, bubbles: true, composed: true }));
        }
        if (!this.pick || !this.target) return;
        const type = this.pickActionType || "pick";
        if (hit) {
          const { objectId, x, y, z, instance, src } = hit;
          dispatch(this.target, { type, payload: { objectId, x, y, z, ...(instance ? { instance, src } : {}) } });
        } else if (this.pickEmpty) {
          dispatch(this.target, { type, payload: { objectId: null } });
        }
      },
    };
  }

  /** Contrat SonicFrameSource — canvas Three (preserveDrawingBuffer). */
  getFrameCanvas(): HTMLCanvasElement | null {
    if (!this.runtime || !this.ready) return null;
    return this.runtime.renderer.domElement;
  }

  onPointerMove = (e: PointerEvent) => pointer.onMove(this as never, e);
  onPointerDown = (e: PointerEvent) => pointer.onDown(this as never, e);
  onPointerUp = (e: PointerEvent) => pointer.onUp(this as never, e);
  onDblClick = () => pointer.onDblClick(this as never);
  onWheel = (e: WheelEvent) => pointer.onWheel(this as never, e);
  onKeyDown = (e: KeyboardEvent) => pointer.onKeyDown(this as never, e);
  onPointerEnter = () => pointer.onEnter(this as never);
  onPointerLeave = () => pointer.onLeave(this as never);

  /** Bulle de la sélection : le slot `selection` suit l'objet sélectionné à l'écran. */
  private anchorEl: HTMLElement | null = null;
  private anchorSig = "";
  private placeAnchor() {
    const el = (this.anchorEl ??= this.renderRoot.querySelector<HTMLElement>(".anchor"));
    if (!el || !this.runtime) return;
    const s = this.runtime.selectionScreen();
    // la bulle reste dans le cadre (objet au bord de l'écran ou en partie dehors)
    if (s) {
      const w = this.clientWidth, h = this.clientHeight;
      s.x = Math.max(Math.min(110, w / 2), Math.min(w - Math.min(110, w / 2), s.x));
      s.y = Math.max(60, Math.min(h - 20, s.y));
    }
    const sig = s ? `${Math.round(s.x)},${Math.round(s.y)}` : "";
    if (sig === this.anchorSig) return;
    this.anchorSig = sig;
    if (!s) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
  }

  render() {
    return html`
      <canvas part="canvas"></canvas>
      <div class="anchor" part="selection-anchor" data-overlay hidden><div class="bubble"><slot name="selection"></slot></div></div>
      ${this.errorMessage
        ? html`<div class="err" part="error">${this.errorMessage}</div>`
        : null}
    `;
  }
}

export { Sonic3dCameraMode } from "./constants";
export type { Sonic3dStatus } from "./status";
export type {
  Sonic3dAsset,
  Sonic3dConfig,
  Sonic3dOutput,
} from "./types";
export type { SonicMediaRef, SonicFrameSource, SonicFrameConsumerHost } from "../../shared/mediaRef";
export {
  toMediaUrl,
  cloneMediaRef,
  isFrameSource,
  isFrameConsumerHost,
  FrameConsumerRegistry,
} from "../../shared/mediaRef";
export { wantsOffscreenPlay } from "./playback";
export { frameCapture } from "./frame-capture";
export { frameSource } from "./frame-source";

declare global {
  interface HTMLElementTagNameMap {
    "sonic-3d": Sonic3d;
  }
}
