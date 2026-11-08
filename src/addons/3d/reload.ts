import { PublisherManager } from "@supersoniks/concorde/utils";
import { asset } from "./asset";
import type { FormOrbit } from "./form-params";
import { frameSource } from "./frame-source";
import { postBind } from "./post-bind";
import { playback } from "./playback";
import type { SceneRuntime } from "./runtime";
import type { Sonic3dAsset } from "./types";
import { readMonde, type Monde } from "../../shared/monde/format";

function degToRad(deg: number): number {
  return ((Number.isFinite(deg) ? deg : 0) * Math.PI) / 180;
}

export type ReloadHost = {
  runtime: SceneRuntime | null;
  loadToken: number;
  errorMessage: string;
  ready: boolean;
  startTime: number;
  frame: number;
  frameSeq: number;
  lastFormOrbit: FormOrbit | null;
  formPublisher: ReturnType<typeof PublisherManager.get> | null;
  outPublisher: ReturnType<typeof PublisherManager.get> | null;
  asset: Sonic3dAsset | null;
  src: string;
  glb: string;
  maxGlbBytes: number;
  lastNodesJson: string;
  minDistance: number;
  maxDistance: number;
  minPolar: number;
  maxPolar: number;
  onFormMutation: () => void;
  syncPlayback: () => void;
  bindOutPublisher: () => void;
  dispatchEvent: (event: Event) => boolean;
};

async function run(host: ReloadHost) {
  if (!host.runtime) return;
  const token = ++host.loadToken;
  host.errorMessage = "";
  host.lastNodesJson = "";
  try {
    const mh = host as unknown as { mondeParsed?: Monde | null; monde?: string; formPublisher: { get?: () => Record<string, unknown> } | null };
    if (!mh.mondeParsed) {
      const data = (mh.formPublisher?.get?.() ?? {}) as Record<string, unknown>;
      let src: unknown = data.monde;
      if (!src && mh.monde?.trim()) {
        try {
          src = JSON.parse(mh.monde);
        } catch {
          src = null;
        }
      }
      if (src) mh.mondeParsed = readMonde(src);
    }
    host.runtime.stageMonde(mh.mondeParsed ?? null);
    await host.runtime.load(asset.resolve(host, host.formPublisher));
    if (token !== host.loadToken) return;
    host.ready = true;
    host.startTime = performance.now();
    host.frame = 0;
    host.lastFormOrbit = null;
    host.onFormMutation();
    playback.syncAutoRotate(host as never);
    host.runtime.render();
    host.frameSeq++;
    host.syncPlayback();
    postBind.applyConfig(host as never);
    frameSource.maybePublish(host as never);
    host.dispatchEvent(
      new CustomEvent("ready", {
        detail: { ready: true },
        bubbles: true,
        composed: true,
      }),
    );
  } catch (err) {
    if (token !== host.loadToken) return;
    host.ready = !!host.runtime?.ready;
    emitError(host, err);
    host.syncPlayback();
  }
}

function applyOrbitLimits(host: ReloadHost) {
  host.runtime?.setOrbitLimits({
    minDistance: host.minDistance,
    maxDistance: host.maxDistance,
    minPolar: degToRad(host.minPolar),
    maxPolar: degToRad(host.maxPolar),
  });
}

function emitError(host: ReloadHost, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  host.errorMessage = message;
  host.dispatchEvent(
    new CustomEvent("error", {
      detail: { message },
      bubbles: true,
      composed: true,
    }),
  );
}

export const reload = {
  run,
  applyOrbitLimits,
  emitError,
  degToRad,
} as const;
