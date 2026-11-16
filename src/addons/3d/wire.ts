import { frameCapture } from "./frame-capture";
import { life, type LifeHost } from "./life";
import { playback } from "./playback";
import { viewProvider } from "./view-provider";

type WireHost = LifeHost & {
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerDown: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
  onDblClick: () => void;
  onWheel: (e: WheelEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onPointerLeave: () => void;
  onPointerEnter: () => void;
  loadToken: number;
  ready: boolean;
  releasing: boolean;
  runtime: { dispose: (lose: boolean) => void } | null;
  outPublisher: unknown;
  snapshotBusy: boolean;
  lastSnapshotAt: number;
  frameUrls: string[];
  snapshotSeq: number;
  snapshotInterval: number;
  frameOut: boolean;
};

function connect(host: WireHost) {
  host.addEventListener("pointermove", host.onPointerMove as EventListener);
  // en capture : le glisser d'un objet passe avant l'orbite de la caméra (qui écoute le canvas)
  host.addEventListener("pointerdown", host.onPointerDown as EventListener, true);
  host.addEventListener("pointerup", host.onPointerUp as EventListener);
  host.addEventListener("dblclick", host.onDblClick);
  host.addEventListener("pointerleave", host.onPointerLeave);
  host.addEventListener("pointerenter", host.onPointerEnter);
  host.addEventListener("wheel", host.onWheel as EventListener, { passive: false });
  host.addEventListener("keydown", host.onKeyDown as EventListener);
  life.bindFormProvider(host);
  viewProvider.bind(host as never);
  life.bindOutPublisher(host);
}

function disconnect(host: WireHost) {
  host.removeEventListener("pointermove", host.onPointerMove as EventListener);
  host.removeEventListener("pointerdown", host.onPointerDown as EventListener, true);
  host.removeEventListener("pointerup", host.onPointerUp as EventListener);
  host.removeEventListener("dblclick", host.onDblClick);
  host.removeEventListener("pointerleave", host.onPointerLeave);
  host.removeEventListener("pointerenter", host.onPointerEnter);
  host.removeEventListener("wheel", host.onWheel as EventListener);
  host.removeEventListener("keydown", host.onKeyDown as EventListener);
  life.unbindFormProvider(host);
  viewProvider.unbind(host as never);
  playback.stopLoop(host as never);
  host.resizeObserver?.disconnect();
  host.intersectionObserver?.disconnect();
  host.loadToken++;
  host.ready = false;
  host.releasing = true;
  frameCapture.revokeAll(host as never);
  host.runtime?.dispose(true);
  host.runtime = null;
  host.outPublisher = null;
  host.releasing = false;
}

/** Pointer + DP wire on connect/disconnect. */
export const wire = { connect, disconnect } as const;
