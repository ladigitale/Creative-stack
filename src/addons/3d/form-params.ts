import { ORBIT_CHANGE_EPSILON } from "./constants";
import { formFields } from "./form-fields";
import { parse } from "./parse";
import { playback } from "./playback";
import { postBind } from "./post-bind";
import { reload } from "./reload";
import type { SceneRuntime } from "./runtime";
import type { Sonic3dAsset, Sonic3dCameraMode } from "./types";

export type FormOrbit = { yaw: number; pitch: number; distance: number };

/** Host minimal pour appliquer les champs form → viewer. */
export type FormBindHost = {
  fov: number;
  exposure: number;
  minDistance: number;
  maxDistance: number;
  minPolar: number;
  maxPolar: number;
  autoRotate: boolean;
  camera: Sonic3dCameraMode;
  asset: Sonic3dAsset | null;
  src: string;
  runtime: SceneRuntime | null;
  frame: number;
  hovering: boolean;
  pointerX: number;
  pointerY: number;
  lastFormOrbit: FormOrbit | null;
};

function orbitChanged(prev: FormOrbit | null, next: FormOrbit): boolean {
  if (!prev) return true;
  return (
    Math.abs(prev.yaw - next.yaw) > ORBIT_CHANGE_EPSILON ||
    Math.abs(prev.pitch - next.pitch) > ORBIT_CHANGE_EPSILON ||
    Math.abs(prev.distance - next.distance) > ORBIT_CHANGE_EPSILON
  );
}

/**
 * Orbit depuis le form : uniquement si yaw/pitch/distance ont changé
 * (sinon chaque mutation télémétrie / checkbox réapplique et combat autoRotate).
 */
function readOrbit(
  host: FormBindHost,
  data: Record<string, unknown>,
): FormOrbit {
  const cur = host.runtime!.snapshot({
    time: 0,
    frame: host.frame,
    hovering: host.hovering ? 1 : 0,
    pointerX: host.pointerX,
    pointerY: host.pointerY,
  });
  return {
    yaw: "yaw" in data ? parse.toNum(data.yaw, cur.yaw) : cur.yaw,
    pitch: "pitch" in data ? parse.toNum(data.pitch, cur.pitch) : cur.pitch,
    distance:
      "distance" in data
        ? parse.toNum(data.distance, cur.distance)
        : cur.distance,
  };
}

function applyFormOrbit(host: FormBindHost, data: Record<string, unknown>) {
  if (!host.runtime) return;
  if (!("distance" in data || "yaw" in data || "pitch" in data)) return;
  const next = readOrbit(host, data);
  const prev = host.lastFormOrbit;
  if (!orbitChanged(prev, next)) return;
  host.lastFormOrbit = next;
  if (host.autoRotate && prev) {
    host.autoRotate = false;
    playback.syncAutoRotate(host as never);
  }
  host.runtime.setOrbitSpherical(next.yaw, next.pitch, next.distance);
  host.runtime.render();
}

/**
 * Auto-bind form → viewer : champs `FORM_CONTROL_KEYS` sur le DP / form ancêtre.
 */
function applyFormParams(host: FormBindHost, data: Record<string, unknown>) {
  formFields.applyScalars(host, data);
  const needReload = formFields.applyAsset(host, data);

  if (!host.runtime) {
    if (needReload) void reload.run(host as never);
    return;
  }

  formFields.pushToRuntime(host, data);
  applyFormOrbit(host, data);
  postBind.applyFormPost(host as never, data);
  if (needReload) void reload.run(host as never);
}

export const formParams = { applyFormParams, applyFormOrbit } as const;
