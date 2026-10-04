import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Sonic3dCameraMode } from "./constants";
import type { SceneHit } from "./pick";
import type { Sonic3dOutput } from "./types";

export type SnapshotCtx = {
  activeCam: THREE.Camera;
  controls: OrbitControls | null;
  target: THREE.Vector3;
  mode: Sonic3dCameraMode;
  perspCam: THREE.PerspectiveCamera;
  orthoCam: THREE.OrthographicCamera;
  bbox: THREE.Box3;
  ready: boolean;
  loading: boolean;
};

function build(
  ctx: SnapshotCtx,
  base: {
    time: number;
    frame: number;
    hovering: number;
    pointerX: number;
    pointerY: number;
    hit?: SceneHit | null;
  },
): Sonic3dOutput {
  const cam = ctx.activeCam.position;
  const t = ctx.controls?.target ?? ctx.target;
  const offset = new THREE.Vector3().subVectors(cam, t);
  const distance = offset.length();
  const yaw = Math.atan2(offset.x, offset.z);
  const pitch = Math.atan2(offset.y, Math.hypot(offset.x, offset.z));
  const out: Sonic3dOutput = {
    time: base.time,
    frame: base.frame,
    ready: ctx.ready ? 1 : 0,
    loading: ctx.loading ? 1 : 0,
    hovering: base.hovering,
    pointerX: base.pointerX,
    pointerY: base.pointerY,
    camX: cam.x,
    camY: cam.y,
    camZ: cam.z,
    targetX: t.x,
    targetY: t.y,
    targetZ: t.z,
    fov: ctx.mode === Sonic3dCameraMode.Ortho ? 0 : ctx.perspCam.fov,
    zoom: ctx.mode === Sonic3dCameraMode.Ortho ? ctx.orthoCam.zoom : 1,
    distance,
    yaw,
    pitch,
  };
  if (!ctx.bbox.isEmpty()) {
    out.bboxMinX = ctx.bbox.min.x;
    out.bboxMinY = ctx.bbox.min.y;
    out.bboxMinZ = ctx.bbox.min.z;
    out.bboxMaxX = ctx.bbox.max.x;
    out.bboxMaxY = ctx.bbox.max.y;
    out.bboxMaxZ = ctx.bbox.max.z;
  }
  if (base.hit) {
    out.hitX = base.hit.x;
    out.hitY = base.hit.y;
    out.hitZ = base.hit.z;
    out.hitObjectId = base.hit.objectId;
  }
  return out;
}

export const snapshot = { build } as const;
