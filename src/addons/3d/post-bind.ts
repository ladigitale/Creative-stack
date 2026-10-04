/**
 * Construit la config PostFx depuis les props Lit / form DP.
 */
import { lookupLiveElement } from "../../shared/mediaRef";
import {
  clampPostScale,
  parsePostChannelSource,
  type PostChannels,
  type PostPassId,
  type PostSources,
} from "./post-channels";
import type { PostFxConfig } from "./post-fx";
import type { SceneRuntime } from "./runtime";

export type PostBindHost = {
  postImage: string;
  postBufferA: string;
  postBufferB: string;
  postBufferC: string;
  postBufferD: string;
  postCommon: string;
  postImageCh0: string;
  postImageCh1: string;
  postImageCh2: string;
  postImageCh3: string;
  postBufferACh0: string;
  postBufferACh1: string;
  postBufferACh2: string;
  postBufferACh3: string;
  postBufferBCh0: string;
  postBufferBCh1: string;
  postBufferBCh2: string;
  postBufferBCh3: string;
  postBufferCCh0: string;
  postBufferCCh1: string;
  postBufferCCh2: string;
  postBufferCCh3: string;
  postBufferDCh0: string;
  postBufferDCh1: string;
  postBufferDCh2: string;
  postBufferDCh3: string;
  postScale: number;
  param0: number;
  param1: number;
  param2: number;
  param3: number;
  runtime: SceneRuntime | null;
  errorMessage: string;
  getRootNode: () => Node;
  dispatchEvent: (event: Event) => boolean;
};

const POST_PROP_KEYS = [
  "postImage",
  "postBufferA",
  "postBufferB",
  "postBufferC",
  "postBufferD",
  "postCommon",
  "postImageCh0",
  "postImageCh1",
  "postImageCh2",
  "postImageCh3",
  "postBufferACh0",
  "postBufferACh1",
  "postBufferACh2",
  "postBufferACh3",
  "postBufferBCh0",
  "postBufferBCh1",
  "postBufferBCh2",
  "postBufferBCh3",
  "postBufferCCh0",
  "postBufferCCh1",
  "postBufferCCh2",
  "postBufferCCh3",
  "postBufferDCh0",
  "postBufferDCh1",
  "postBufferDCh2",
  "postBufferDCh3",
  "postScale",
] as const;

function buildChannels(host: PostBindHost, pass: PostPassId): PostChannels {
  const fallbacks = ["", "", "", ""];
  // image defaults ch0=scene via parse empty+slot0
  let overrides: string[] = ["", "", "", ""];
  if (pass === "image") {
    overrides = [
      host.postImageCh0,
      host.postImageCh1,
      host.postImageCh2,
      host.postImageCh3,
    ];
  } else if (pass === "bufferA") {
    overrides = [
      host.postBufferACh0,
      host.postBufferACh1,
      host.postBufferACh2,
      host.postBufferACh3,
    ];
  } else if (pass === "bufferB") {
    overrides = [
      host.postBufferBCh0,
      host.postBufferBCh1,
      host.postBufferBCh2,
      host.postBufferBCh3,
    ];
  } else if (pass === "bufferC") {
    overrides = [
      host.postBufferCCh0,
      host.postBufferCCh1,
      host.postBufferCCh2,
      host.postBufferCCh3,
    ];
  } else {
    overrides = [
      host.postBufferDCh0,
      host.postBufferDCh1,
      host.postBufferDCh2,
      host.postBufferDCh3,
    ];
  }
  return [0, 1, 2, 3].map((i) =>
    parsePostChannelSource(
      overrides[i],
      fallbacks[i],
      i as 0 | 1 | 2 | 3,
    ),
  ) as PostChannels;
}

function buildConfig(host: PostBindHost): PostFxConfig | null {
  if (!host.postImage.trim()) return null;
  const sources: PostSources = {
    common: host.postCommon,
    image: host.postImage,
    bufferA: host.postBufferA,
    bufferB: host.postBufferB,
    bufferC: host.postBufferC,
    bufferD: host.postBufferD,
  };
  const channels = new Map<PostPassId, PostChannels>();
  for (const pass of [
    "bufferA",
    "bufferB",
    "bufferC",
    "bufferD",
    "image",
  ] as PostPassId[]) {
    channels.set(pass, buildChannels(host, pass));
  }
  return {
    sources,
    channels,
    scale: clampPostScale(host.postScale),
  };
}

function lookupElement(host: PostBindHost, key: string): Element | null {
  if (!key.startsWith("#")) return null;
  const live = lookupLiveElement(key);
  if (live) return live;
  const id = key.slice(1);
  if (!id || id.startsWith("__sonic_frame_")) return null;
  const root = host.getRootNode();
  if (root instanceof Document || root instanceof ShadowRoot) {
    const el = root.getElementById(id);
    if (el) return el;
  }
  return typeof document !== "undefined" ? document.getElementById(id) : null;
}

function applyConfig(host: PostBindHost) {
  if (!host.runtime) return;
  host.runtime.setPostElementResolver((key) => lookupElement(host, key));
  try {
    host.runtime.setPostConfig(buildConfig(host));
    if (host.errorMessage.startsWith("Post FX")) host.errorMessage = "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    host.errorMessage = `Post FX: ${message}`;
    const pass =
      err && typeof err === "object" && "pass" in err
        ? String((err as { pass: string }).pass)
        : "image";
    const infoLog =
      err && typeof err === "object" && "infoLog" in err
        ? String((err as { infoLog: string }).infoLog)
        : "";
    host.dispatchEvent(
      new CustomEvent("error", {
        detail: { message, pass, infoLog },
        bubbles: true,
        composed: true,
      }),
    );
    try {
      host.runtime.setPostConfig(null);
    } catch {
      /* ignore */
    }
  }
}

function syncFrame(
  host: PostBindHost,
  time: number,
  timeDelta: number,
  frame: number,
  mouse: [number, number, number, number] = [0, 0, 0, 0],
) {
  host.runtime?.setPostFrame({
    time,
    timeDelta,
    frame,
    mouse,
    params: [host.param0, host.param1, host.param2, host.param3],
  });
}

function propsChanged(
  changed: Map<string | number | symbol, unknown>,
): boolean {
  return POST_PROP_KEYS.some((k) => changed.has(k));
}

/** Applique param0…3 + post* depuis un DP form. */
function applyFormPost(host: PostBindHost, data: Record<string, unknown>) {
  let touched = false;
  for (const k of ["param0", "param1", "param2", "param3"] as const) {
    if (k in data && typeof data[k] === "number") {
      host[k] = data[k] as number;
      touched = true;
    } else if (k in data && typeof data[k] === "string") {
      const n = Number(data[k]);
      if (Number.isFinite(n)) {
        host[k] = n;
        touched = true;
      }
    }
  }
  for (const k of POST_PROP_KEYS) {
    if (!(k in data)) continue;
    const v = data[k];
    if (k === "postScale" && (typeof v === "number" || typeof v === "string")) {
      host.postScale = clampPostScale(Number(v));
      touched = true;
    } else if (typeof v === "string") {
      (host as unknown as Record<string, string>)[k] = v;
      touched = true;
    }
  }
  if (touched) applyConfig(host);
}

export const postBind = {
  applyConfig,
  syncFrame,
  propsChanged,
  applyFormPost,
  POST_PROP_KEYS,
} as const;
