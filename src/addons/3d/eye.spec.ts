import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { EyeNav, insideRoom } from "./eye";
import { parse } from "./parse";
import { Sonic3dCameraMode } from "./constants";

const room = [[0, 0], [3.5, 0], [3.5, 3], [0, 3]];

describe("vue à hauteur d'yeux", () => {
  it("camera=\"yeux\" (ou eye) est un mode reconnu", () => {
    expect(parse.cameraMode("yeux")).toBe(Sonic3dCameraMode.Eye);
    expect(parse.cameraMode("eye")).toBe(Sonic3dCameraMode.Eye);
  });

  it("les pas restent dans la pièce, à 30 cm des murs", () => {
    expect(insideRoom(room, 1, 1)).toEqual([1, 1]);
    const [x, z] = insideRoom(room, 5, -2);
    expect(x).toBeCloseTo(3.2);
    expect(z).toBeCloseTo(0.3);
  });

  it("entre dans la pièce à hauteur d'yeux, puis glisse vers le point visé", () => {
    const cam = new THREE.PerspectiveCamera();
    const ctx = { activeCam: cam, controls: null, contour: room, center: new THREE.Vector3() };
    const eye = new EyeNav();
    eye.height = 1.1;
    eye.enter(ctx);
    expect(cam.position.y).toBeCloseTo(1.1);
    expect(insideRoom(room, cam.position.x, cam.position.z)).toEqual([cam.position.x, cam.position.z]);
    eye.goTo(ctx, 10, 10, 0);
    expect(eye.moving).toBe(true);
    eye.tick(ctx, 5000);
    expect(eye.moving).toBe(false);
    expect(cam.position.x).toBeCloseTo(3.2);
    expect(cam.position.z).toBeCloseTo(2.7);
  });
});
