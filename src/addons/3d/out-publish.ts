import {
  DEFAULT_OUT_INTERVAL_MS,
  FORM_INPUT_ONLY_KEYS,
  MIN_OUT_INTERVAL_MS,
  OUT_CONSUMER_KEYS,
} from "./constants";
import { frameCapture } from "./frame-capture";
import type { SceneHit } from "./pick";
import { publisherFieldHasListener } from "./publisher-listen";
import type { SceneRuntime } from "./runtime";
import type { Sonic3dOutput } from "./types";

type OutPublisherLike = {
  _proxies_?: Map<string, { hasListener?: () => boolean }>;
  get?: () => Record<string, unknown>;
};

export type OutPublishHost = {
  outPublisher: OutPublisherLike | null;
  outEventListeners: number;
  outInterval: number;
  snapshotInterval: number;
  frameOut: boolean;
  lastOutAt: number;
  lastSnapshotAt: number;
  snapshotBusy: boolean;
  frameUrls: string[];
  snapshotSeq: number;
  runtime: SceneRuntime | null;
  frame: number;
  hovering: boolean;
  pointerX: number;
  pointerY: number;
  lastHit: SceneHit | null;
  fov: number;
  moving: number;
  formPublisher: OutPublisherLike | null;
  bindOutPublisher: () => void;
  dispatchEvent: (event: Event) => boolean;
};

function hasOutConsumers(host: OutPublishHost): boolean {
  if (host.outEventListeners > 0) return true;
  if (host.frameOut && host.outPublisher) return true;
  if (!host.outPublisher) return false;
  for (const key of OUT_CONSUMER_KEYS) {
    if (publisherFieldHasListener(host.outPublisher, key)) return true;
  }
  return false;
}

/**
 * Si form et out partagent le DP : ne pas réécrire les entrées pures
 * (fov, exposure, autoRotate…). yaw/distance restent publiables.
 */
function shouldSkipFormControlOutWrite(
  host: OutPublishHost,
  key: string,
): boolean {
  if (!(FORM_INPUT_ONLY_KEYS as readonly string[]).includes(key)) return false;
  if (!host.formPublisher || host.formPublisher !== host.outPublisher) {
    return false;
  }
  return true;
}

function buildOutput(host: OutPublishHost, time: number): Sonic3dOutput {
  const base =
    host.runtime?.snapshot({
      time,
      frame: host.frame,
      hovering: host.hovering ? 1 : 0,
      pointerX: host.pointerX,
      pointerY: host.pointerY,
      hit: host.lastHit,
    }) ?? {
      time,
      frame: host.frame,
      ready: 0,
      loading: 0,
      hovering: host.hovering ? 1 : 0,
      pointerX: host.pointerX,
      pointerY: host.pointerY,
      camX: 0,
      camY: 0,
      camZ: 0,
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      fov: host.fov,
      zoom: 1,
      distance: 0,
      yaw: 0,
      pitch: 0,
    };
  return { ...base, moving: host.moving };
}

function writePayload(host: OutPublishHost, payload: Sonic3dOutput) {
  const pub = host.outPublisher;
  if (!pub) return;
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (shouldSkipFormControlOutWrite(host, key)) continue;
    // frameUrl / snapshot : écrits async par frameCapture
    if ((frameCapture.FRAME_KEYS as readonly string[]).includes(key)) continue;
    try {
      (pub as Record<string, { set: (v: unknown) => void }>)[key].set(value);
    } catch {
      /* leaf manquant */
    }
  }
}

function maybePublish(host: OutPublishHost, now: number, time: number) {
  if (!host.outPublisher) host.bindOutPublisher();
  if (!hasOutConsumers(host) || !host.runtime) return;
  const interval = Math.max(
    MIN_OUT_INTERVAL_MS,
    host.outInterval || DEFAULT_OUT_INTERVAL_MS,
  );
  if (now - host.lastOutAt >= interval) {
    host.lastOutAt = now;
    const payload = buildOutput(host, time);
    writePayload(host, payload);
    const outEventInit: CustomEventInit = {
      detail: payload,
      bubbles: true,
      composed: true,
    };
    host.dispatchEvent(new CustomEvent("out", outEventInit));
  }
  frameCapture.maybeCapture(host, now);
}

export const outPublish = {
  hasOutConsumers,
  maybePublish,
  buildOutput,
  shouldSkipFormControlOutWrite,
} as const;
