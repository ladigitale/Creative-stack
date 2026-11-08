import { ensure } from "./ensure";
import type { LifeHost } from "./life";
import { life } from "./life";
import { parse } from "./parse";
import { playback } from "./playback";
import { postBind } from "./post-bind";
import { reload } from "./reload";
import { mondeBind } from "./monde-bind";

function hasAny(
  changed: Map<string | number | symbol, unknown>,
  keys: string[],
): boolean {
  return keys.some((k) => changed.has(k));
}

function applyCameraProps(
  host: LifeHost,
  changed: Map<string | number | symbol, unknown>,
) {
  if (!host.runtime) return;
  if (changed.has("camera")) {
    host.runtime.applyCameraMode(parse.cameraMode(host.camera));
  }
  if (changed.has("fov")) host.runtime.setFov(host.fov);
  if (changed.has("exposure")) host.runtime.setExposure(host.exposure);
  if (changed.has("dprMax")) {
    host.runtime.setDprMax(host.dprMax);
    ensure.syncSize(host as never);
  }
  if (changed.has("fit")) host.runtime.setFit(host.fit);
  if (
    hasAny(changed, [
      "minDistance",
      "maxDistance",
      "minPolar",
      "maxPolar",
      "camera",
    ])
  ) {
    reload.applyOrbitLimits(host as never);
  }
}

function bindProvidersIfNeeded(
  host: LifeHost,
  changed: Map<string | number | symbol, unknown>,
) {
  if (changed.has("aspectRatio")) life.applyAspectRatio(host);
  if (changed.has("dataProvider") || changed.has("outDataProvider")) {
    life.bindFormProvider(host);
    life.bindOutPublisher(host);
  }
}

function updated(
  host: LifeHost,
  changed: Map<string | number | symbol, unknown>,
) {
  bindProvidersIfNeeded(host, changed);
  if (!host.runtime) return;
  applyCameraProps(host, changed);
  if (changed.has("autoRotate") || changed.has("play")) {
    playback.syncAutoRotate(host as never);
  }
  if (
    changed.has("play") ||
    changed.has("playOnHover") ||
    changed.has("playOffscreen")
  ) {
    host.syncPlayback();
  }
  if (changed.has("playOffscreen") || changed.has("releaseOffscreen")) {
    ensure.syncVisibility(host as never);
  }
  if (changed.has("damping") && host.runtime) {
    host.runtime.setDamping(
      (host as unknown as { damping: number }).damping,
    );
  }
  if (changed.has("src") || changed.has("asset") || changed.has("glb")) void reload.run(host as never);
  if (changed.has("monde")) {
    const h = host as unknown as { formPublisher: { get?: () => Record<string, unknown> } | null };
    mondeBind.sync(host as never, (h.formPublisher?.get?.() ?? {}) as Record<string, unknown>);
  }
  if (postBind.propsChanged(changed)) {
    postBind.applyConfig(host as never);
  }
}

export const propUpdate = { updated } as const;
