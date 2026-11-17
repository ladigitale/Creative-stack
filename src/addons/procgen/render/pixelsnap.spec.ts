import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { DEFAULT_VIEW, type OrthoFrame, applyView } from "./camera";
import { GRID_WRAP, SNAP_MARGIN, gridOffset, marginTransform, snapApplicable, snapAxis } from "./pixelsnap";
import { resolveStyle } from "../style/style";

describe("procgen : pixels accrochés au monde", () => {
  it("arrondi à la grille : reste dans ]-0,5 ; 0,5], position arrondie multiple du texel", () => {
    for (const ts of [0.05, 0.13, 1, 2.5]) {
      for (const a of [-7.31, -0.02, 0, 0.049, 3.3333, 101.7]) {
        const { snapped, rem } = snapAxis(a, ts);
        expect(Math.abs(rem)).toBeLessThanOrEqual(0.5 + 1e-9);
        expect(snapped / ts).toBeCloseTo(Math.round(snapped / ts), 9);
        expect(snapped + rem * ts).toBeCloseTo(a, 9);
      }
    }
  });

  it("les texels restent fixes par rapport au monde : un point du monde tombe toujours au même endroit d'un texel", () => {
    const ts = 0.137;
    const w = 3.0571; // point du monde (le long d'un axe de la vue)
    const phase = (a: number) => {
      const { snapped } = snapAxis(a, ts);
      const x = (w - snapped) / ts; // position dans la cible rendue (texels)
      return x - Math.floor(x);
    };
    const p0 = phase(0);
    for (let a = -2; a < 2; a += 0.0173) expect(phase(a)).toBeCloseTo(p0, 6);
  });

  it("lecture décalée du reste : l'image affichée suit la position réelle", () => {
    const rw = 240, rh = 135, m = SNAP_MARGIN, ts = 0.1;
    for (const a of [0, 0.013, 0.049, 0.051, 1.234]) {
      const { snapped, rem } = snapAxis(a, ts);
      const [sx, , ox] = marginTransform(rw, rh, m, rem, 0);
      // un point du monde vu à l'écran (caméra réelle) en `u` doit être lu dans la cible (caméra arrondie) au même point du monde
      const w = 2.2;
      const u = ((w - a) / ts + rw / 2) / rw;
      const uT = u * sx + ox;
      const wBack = (uT * (rw + 2 * m) - (rw + 2 * m) / 2) * ts + snapped;
      expect(wBack).toBeCloseTo(w, 9);
    }
    expect(marginTransform(100, 50, 0, 0, 0)).toEqual([1, 1, 0, 0]);
  });

  it("caméra orthographique : position arrondie le long des axes de la vue, cadrage agrandi de la marge ; perspective exclue", () => {
    const o = new THREE.OrthographicCamera(), p = new THREE.PerspectiveCamera();
    const fr: OrthoFrame = { a: 0, b: 0, half: 0, rx: 0, ry: 0 };
    const v = { ...DEFAULT_VIEW, cx: 1.2345, cz: -0.777 };
    applyView(v, 16 / 9, 20, o, p, undefined, { rw: 320, rh: 180, m: 2 }, fr);
    const R = new THREE.Vector3().setFromMatrixColumn(o.matrixWorld, 0), U = new THREE.Vector3().setFromMatrixColumn(o.matrixWorld, 1);
    const tsy = (2 * fr.half) / 180;
    expect((o.position.dot(U) / tsy) % 1).toBeCloseTo(Math.round((o.position.dot(U) / tsy) % 1), 6);
    expect((o.top - o.bottom) / tsy).toBeCloseTo(184, 6);
    expect(o.position.dot(R) + fr.rx * ((2 * fr.half * 16) / 9 / 320)).toBeCloseTo(fr.a, 9);
    expect(snapApplicable("iso", true)).toBe(true);
    expect(snapApplicable("oblique", true)).toBe(true);
    expect(snapApplicable("perspective", true)).toBe(false);
    expect(snapApplicable("follow", true)).toBe(false);
    expect(snapApplicable("iso", false)).toBe(false);
  });

  it("origine des grilles : px CSS de la position caméra, repliée sans perdre la précision", () => {
    expect(gridOffset(1, 2, 10)).toEqual([10, 20]);
    const [gx] = gridOffset(-0.5, 0, 10);
    expect(gx).toBeCloseTo(GRID_WRAP - 5, 9);
    expect(gridOffset(GRID_WRAP / 10 + 0.3, 0, 10)[0]).toBeCloseTo(3, 6);
  });

  it("jeton : `pixel: {size, snap}` et `pixelSnap`", () => {
    expect(resolveStyle({ pixel: { size: 5, snap: false } })).toMatchObject({ pixel: 5, pixelSnap: false });
    expect(resolveStyle({ pixel: 3 })).toMatchObject({ pixel: 3, pixelSnap: true });
    expect(resolveStyle({ pixelSnap: false }).pixelSnap).toBe(false);
  });
});
