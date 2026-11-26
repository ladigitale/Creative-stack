import { describe, expect, it } from "vitest";
import { orientationQuat, quatFromOrientation, rotateCorners } from "./gyro";

const center = [{ x: 0.5, y: 0.5 }];
// téléphone tenu droit, écran vers soi (beta 90) : la caméra arrière regarde à l'horizontale
const upright = (alpha: number, beta = 90, gamma = 0) => orientationQuat(alpha, beta, gamma);

describe("renfort gyroscope", () => {
  it("sans rotation, les coins ne bougent pas", () => {
    const c = [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }, { x: 0.8, y: 0.7 }, { x: 0.2, y: 0.7 }];
    const r = rotateCorners(c, upright(30), upright(30), 63, 4 / 3)!;
    r.forEach((p, i) => {
      expect(p.x).toBeCloseTo(c[i].x);
      expect(p.y).toBeCloseTo(c[i].y);
    });
  });

  it("tourner le téléphone vers la gauche (alpha +) décale la scène vers la droite de l'image", () => {
    const r = rotateCorners(center, upright(0), upright(10), 63, 4 / 3)!;
    expect(r[0].x).toBeGreaterThan(0.6);
    expect(r[0].y).toBeCloseTo(0.5);
  });

  it("10° de rotation ≈ la part attendue du champ de vision", () => {
    const fov = 60;
    const r = rotateCorners(center, upright(0), upright(10), fov, 1)!;
    const expected = 0.5 + Math.tan((10 * Math.PI) / 180) / (2 * Math.tan((fov / 2) * Math.PI / 180));
    expect(r[0].x).toBeCloseTo(expected, 3);
  });

  it("lever le téléphone (beta +) fait descendre la scène dans l'image", () => {
    const r = rotateCorners(center, upright(0, 90), upright(0, 100), 63, 4 / 3)!;
    expect(r[0].y).toBeGreaterThan(0.6);
    expect(r[0].x).toBeCloseTo(0.5);
  });

  it("demi-tour : la zone passe derrière la caméra", () => {
    expect(rotateCorners(center, upright(0), upright(180), 63, 4 / 3)).toBeNull();
  });

  it("sans capteurs (null ou zéros exacts) : pas d'orientation", () => {
    expect(quatFromOrientation({ alpha: null, beta: null, gamma: null })).toBeNull();
    expect(quatFromOrientation({ alpha: 0, beta: 0, gamma: 0 })).toBeNull();
    expect(quatFromOrientation({ alpha: 12, beta: 80, gamma: 3 })).not.toBeNull();
  });
});
