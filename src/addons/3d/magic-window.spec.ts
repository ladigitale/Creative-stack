import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { deviceQuaternion, eyePosition, headingOf } from "./magic-window";

describe("fenêtre magique", () => {
  it("téléphone tenu droit (beta 90) : la caméra regarde à l'horizontale, vers -Z", () => {
    const q = deviceQuaternion(0, 90, 0, 0);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    expect(dir.x).toBeCloseTo(0);
    expect(dir.y).toBeCloseTo(0);
    expect(dir.z).toBeCloseTo(-1);
  });

  it("tourner le téléphone (alpha) tourne le cap d'autant", () => {
    const a = headingOf(deviceQuaternion(0, 90, 0, 0));
    const b = headingOf(deviceQuaternion(90, 90, 0, 0));
    expect(Math.abs(b - a)).toBeCloseTo(Math.PI / 2);
  });

  it("téléphone à plat (beta 0) : la caméra regarde le sol", () => {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(deviceQuaternion(0, 0, 0, 0));
    expect(dir.y).toBeCloseTo(-1);
  });

  it("œil au centre, hauteur bornée par la scène", () => {
    expect(eyePosition({ center: [2, 1.25, 1.5], min: [0, 0, 0], max: [4, 2.5, 3] })).toEqual([2, 1.6, 1.5]);
    expect(eyePosition({ center: [0, 0.5, 0], min: [0, 0, 0], max: [1, 1, 1] })[1]).toBeCloseTo(0.64);
    expect(eyePosition(null)).toEqual([0, 1.6, 0]);
  });
});
