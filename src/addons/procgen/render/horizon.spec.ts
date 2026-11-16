import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { DEFAULT_VIEW, type CameraMode, applyView } from "./camera";
import { horizonDirection, horizonScreenY } from "./horizon";

function horizonFor(camera: CameraMode, yaw: number, pitch = 25): number {
  const ortho = new THREE.OrthographicCamera();
  const persp = new THREE.PerspectiveCamera();
  const v = { ...DEFAULT_VIEW, camera, yaw, pitch, cx: 3, cz: -2 };
  const cam = applyView(v, 16 / 9, 20, ortho, persp);
  cam.updateMatrixWorld();
  return horizonScreenY(cam, new THREE.Vector3(v.cx, v.cy, v.cz), 20);
}

describe("procgen : horizon du ciel calé sur le monde", () => {
  for (const mode of ["perspective", "iso", "front", "top"] as CameraMode[]) {
    it(`${mode} : même horizon pour yaw 0, 90, 180, 270`, () => {
      const ys = [0, 90, 180, 270, 37].map((yaw) => horizonFor(mode, yaw));
      for (const y of ys) {
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeCloseTo(ys[0], 4);
      }
    });
  }

  it("perspective : l'horizon monte quand la caméra regarde plus bas", () => {
    expect(horizonFor("perspective", 0, 45)).toBeGreaterThan(horizonFor("perspective", 0, 10));
  });

  it("caméra verticale : direction tirée du vecteur up, jamais NaN", () => {
    const [x, z] = horizonDirection({ x: 0, z: 0 }, { x: 0, z: -1 });
    expect([x, z]).toEqual([0, -1]);
    const [a, b] = horizonDirection({ x: 0, z: 0 }, { x: 0, z: 0 });
    expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
    const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    cam.position.set(0, 50, 0);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    expect(Number.isFinite(horizonScreenY(cam, new THREE.Vector3(), 10))).toBe(true);
  });
});
