import { frameCapture } from "./frame-capture";
import { life, type LifeHost } from "./life";
import { playback } from "./playback";

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
  onDblClick: () => void;
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
  host.addEventListener("pointerdown", host.onPointerDown as EventListener);
  host.addEventListener("dblclick", host.onDblClick);
  host.addEventListener("pointerleave", host.onPointerLeave);
  host.addEventListener("pointerenter", host.onPointerEnter);
  life.bindFormProvider(host);
  life.bindOutPublisher(host);
}

function disconnect(host: WireHost) {
  host.removeEventListener("pointermove", host.onPointerMove as EventListener);
  host.removeEventListener("pointerdown", host.onPointerDown as EventListener);
  host.removeEventListener("dblclick", host.onDblClick);
  host.removeEventListener("pointerleave", host.onPointerLeave);
  host.removeEventListener("pointerenter", host.onPointerEnter);
  life.unbindFormProvider(host);
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
