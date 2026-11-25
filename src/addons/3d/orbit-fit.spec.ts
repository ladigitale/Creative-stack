import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { orbit } from "./orbit";
import { Sonic3dCameraMode } from "./constants";

function fitDistance(aspect: number, mode: Sonic3dCameraMode = Sonic3dCameraMode.Orbit) {
  const perspCam = new THREE.PerspectiveCamera(30, aspect, 0.1, 100);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const bbox = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 1, 2));
  const ctx = { bbox, target: new THREE.Vector3(), activeCam: mode === Sonic3dCameraMode.Ortho ? orthoCam : perspCam, controls: null, mode, fov: 30, perspCam, orthoCam };
  orbit.fitToContent(ctx);
  return { dist: ctx.activeCam.position.distanceTo(new THREE.Vector3(0, 0.5, 0)), orthoCam };
}

describe("cadrage automatique (fit) et rapport de l'écran", () => {
  it("paysage : le champ vertical décide, comme avant", () => {
    expect(fitDistance(16 / 9).dist).toBeCloseTo(fitDistance(1).dist, 6);
  });
  it("portrait : la caméra recule pour garder toute la largeur", () => {
    expect(fitDistance(0.5).dist).toBeCloseTo(fitDistance(1).dist * 2, 6);
  });
  it("ortho en portrait : le cadre garde la largeur du contenu", () => {
    const { orthoCam } = fitDistance(0.5, Sonic3dCameraMode.Ortho);
    const wide = fitDistance(1, Sonic3dCameraMode.Ortho).orthoCam;
    expect(orthoCam.right - orthoCam.left).toBeCloseTo(wide.right - wide.left, 6);
  });
});
