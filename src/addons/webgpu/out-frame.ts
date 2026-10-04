import { revokeMediaUrls } from "../../shared/mediaRef";
import { formBind, type FormBindHost } from "./form-bind";
import {
  FRAME_OUT_KEYS,
  OUT_META_KEYS,
  OUT_PARAM_KEYS,
} from "./helpers";
import type { SonicWebGpuOutput } from "./types";

type OutPublisherLike = {
  _proxies_?: Map<string, { hasListener?: () => boolean }>;
  get?: () => Record<string, unknown>;
  set?: (v: Record<string, unknown>) => void;
};

/** Host out/frame — étend FormBindHost pour `resolveFormProviderId`. */
export type OutFrameHost = FormBindHost & {
  outEventListeners: number;
  frameOut: boolean;
  lastOutAt: number;
  outInterval: number;
  runtime: {
    canvas: HTMLCanvasElement;
    backend?: string;
  } | null;
  frame: number;
  frameOutBusy: boolean;
  frameOutSeq: number;
  lastFrameUrl: string;
  dispatchEvent: (event: Event) => boolean;
};

function hasOutConsumer(host: OutFrameHost): boolean {
  if (host.outEventListeners > 0) return true;
  // Même contrat que sonic-3d : frame-out force la pub même sans listener proxy.
  if (host.frameOut && host.outPublisher) return true;
  const pub = host.outPublisher as OutPublisherLike | null;
  if (!pub?._proxies_) return false;
  for (const key of [...OUT_META_KEYS, ...FRAME_OUT_KEYS]) {
    const p = pub._proxies_.get(key);
    if (p?.hasListener?.()) return true;
  }
  return false;
}

function maybePublishOut(host: OutFrameHost & HTMLElement, now: number, time: number) {
  if (!hasOutConsumer(host)) return;
  if (now - host.lastOutAt < host.outInterval) return;
  host.lastOutAt = now;
  const payload: SonicWebGpuOutput = {
    time,
    frame: host.frame,
    mouseX: host.mouseVec[0],
    mouseY: host.mouseVec[1],
    hovering: host.hovering,
    param0: host.param0,
    param1: host.param1,
    param2: host.param2,
    param3: host.param3,
    backend: host.runtime?.backend as SonicWebGpuOutput["backend"],
  };
  host.dispatchEvent(
    new CustomEvent("out", {
      detail: payload,
      bubbles: true,
      composed: true,
    }),
  );
  const pub = host.outPublisher;
  if (pub) {
    const sharedForm =
      formBind.resolveFormProviderId(host) ===
      (host.outDataProvider?.trim() || formBind.resolveFormProviderId(host));
    const patch: Record<string, unknown> = {
      time: payload.time,
      frame: payload.frame,
      mouseX: payload.mouseX,
      mouseY: payload.mouseY,
      hovering: payload.hovering,
    };
    if (!sharedForm) {
      for (const k of OUT_PARAM_KEYS) patch[k] = payload[k];
    }
    pub.set(patch);
  }
  if (host.frameOut) void publishFrameSnapshot(host);
}

async function publishFrameSnapshot(host: OutFrameHost) {
  if (host.frameOutBusy || !host.runtime) return;
  const canvas = host.runtime.canvas;
  if (canvas.width < 1 || canvas.height < 1) return;
  host.frameOutBusy = true;
  const seq = ++host.frameOutSeq;
  const width = canvas.width;
  const height = canvas.height;
  try {
    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), "image/png");
      } catch {
        resolve(null);
      }
    });
    if (seq !== host.frameOutSeq) {
      return;
    }
    if (!blob || !host.outPublisher) return;
    const url = URL.createObjectURL(blob);
    revokeFrameUrl(host);
    host.lastFrameUrl = url;
    host.outPublisher.set({
      frameUrl: url,
      snapshot: {
        url,
        width,
        height,
        mime: "image/png",
      },
    });
  } finally {
    if (seq === host.frameOutSeq) host.frameOutBusy = false;
  }
}

function revokeFrameUrl(host: OutFrameHost) {
  if (!host.lastFrameUrl) return;
  revokeMediaUrls([host.lastFrameUrl]);
  host.lastFrameUrl = "";
}

export const outFrame = {
  hasOutConsumer,
  maybePublishOut,
  publishFrameSnapshot,
  revokeFrameUrl,
} as const;
