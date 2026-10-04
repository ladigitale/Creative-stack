import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PublisherManager } from "@supersoniks/concorde/utils";
import { ensure } from "./ensure";
import { formBind, type FormOrbit } from "./form-bind";
import { life } from "./life";
import { outPublish } from "./out-publish";
import { postBind } from "./post-bind";
import type { SceneHit } from "./pick";
import { playback } from "./playback";
import { pointer } from "./pointer";
import { Sonic3dProps } from "./props";
import type { SceneRuntime } from "./scene-runtime";
import { sonic3dStyles } from "./styles";
import { propUpdate } from "./updated";
import { wire } from "./wire";

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
  bindOutPublisher = () => life.bindOutPublisher(this as never);

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

  /** Contrat SonicFrameSource — canvas Three (preserveDrawingBuffer). */
  getFrameCanvas(): HTMLCanvasElement | null {
    if (!this.runtime || !this.ready) return null;
    return this.runtime.renderer.domElement;
  }

  onPointerMove = (e: PointerEvent) => pointer.onMove(this as never, e);
  onPointerDown = (e: PointerEvent) => pointer.onDown(this as never, e);
  onDblClick = () => pointer.onDblClick(this as never);
  onPointerEnter = () => pointer.onEnter(this as never);
  onPointerLeave = () => pointer.onLeave(this as never);

  render() {
    return html`
      <canvas part="canvas"></canvas>
      ${this.errorMessage
        ? html`<div class="err" part="error">${this.errorMessage}</div>`
        : null}
    `;
  }
}

export { Sonic3dCameraMode } from "./constants";
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
