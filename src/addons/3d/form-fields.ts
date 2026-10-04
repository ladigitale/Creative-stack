import { parse } from "./parse";
import { playback } from "./playback";
import { reload } from "./reload";
import type { FormBindHost } from "./form-params";

/** Applique les scalaires / flags form → propriétés host. */
function applyScalars(host: FormBindHost, data: Record<string, unknown>) {
  if ("fov" in data) host.fov = parse.toNum(data.fov, host.fov);
  if ("exposure" in data) {
    host.exposure = parse.toNum(data.exposure, host.exposure);
  }
  if ("minDistance" in data) {
    host.minDistance = parse.toNum(data.minDistance, host.minDistance);
  }
  if ("maxDistance" in data) {
    host.maxDistance = parse.toNum(data.maxDistance, host.maxDistance);
  }
  if ("minPolar" in data) {
    host.minPolar = parse.toNum(data.minPolar, host.minPolar);
  }
  if ("maxPolar" in data) {
    host.maxPolar = parse.toNum(data.maxPolar, host.maxPolar);
  }
  if ("autoRotate" in data) {
    host.autoRotate = parse.isFormFlagOn(data.autoRotate);
  }
  if ("camera" in data && typeof data.camera === "string") {
    host.camera = parse.cameraMode(data.camera);
  }
}

/** Asset / src → host ; retourne true si reload requis. */
function applyAsset(
  host: FormBindHost,
  data: Record<string, unknown>,
): boolean {
  let reload = false;
  if ("asset" in data) {
    const a = parse.asset(data.asset);
    if (a) {
      host.asset = a;
      reload = true;
    }
  }
  if ("src" in data && typeof data.src === "string" && !("asset" in data)) {
    if (host.src !== data.src) {
      host.src = data.src;
      reload = true;
    }
  }
  return reload;
}

function orbitLimitsTouched(data: Record<string, unknown>): boolean {
  return (
    "minDistance" in data ||
    "maxDistance" in data ||
    "minPolar" in data ||
    "maxPolar" in data ||
    "camera" in data
  );
}

/** Pousse les champs déjà appliqués vers le runtime live. */
function pushToRuntime(host: FormBindHost, data: Record<string, unknown>) {
  if (!host.runtime) return;
  if ("exposure" in data) host.runtime.setExposure(host.exposure);
  if ("fov" in data) host.runtime.setFov(host.fov);
  if ("camera" in data) {
    host.runtime.applyCameraMode(parse.cameraMode(host.camera));
  }
  if (orbitLimitsTouched(data)) reload.applyOrbitLimits(host as never);
  if ("autoRotate" in data) playback.syncAutoRotate(host as never);
}

export const formFields = {
  applyScalars,
  applyAsset,
  pushToRuntime,
} as const;
