import { expect, describe, it, afterEach, beforeAll } from "vitest";
import TestUtils from "@supersoniks/concorde/test-utils/TestUtils";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Sonic3dCameraMode } from "./constants";
import { orbit } from "./orbit";
import { parse } from "./parse";
import "./3d";
import { Sonic3d } from "./3d";

describe("parseCameraMode", () => {
  it("accepte orbit / perspective / ortho", () => {
    expect(parse.cameraMode("orbit")).toBe(Sonic3dCameraMode.Orbit);
    expect(parse.cameraMode("PERSPECTIVE")).toBe(Sonic3dCameraMode.Perspective);
    expect(parse.cameraMode("ortho")).toBe(Sonic3dCameraMode.Ortho);
    expect(parse.cameraMode("nope")).toBe(Sonic3dCameraMode.Orbit);
    expect(parse.cameraMode("")).toBe(Sonic3dCameraMode.Orbit);
  });
});

describe("guessKind / parseAsset", () => {
  it("détecte l’extension", () => {
    expect(parse.guessKind("/a/model.glb")).toBe("glb");
    expect(parse.guessKind("https://x/y.gltf?v=1")).toBe("gltf");
    expect(parse.guessKind("/mesh.obj")).toBe("obj");
    expect(parse.guessKind("/x.bin")).toBe("url");
  });

  it("parse string et objet", () => {
    expect(parse.asset("/m.glb")).toEqual({ kind: "glb", url: "/m.glb" });
    expect(parse.asset({ url: "/a.gltf", kind: "gltf" })).toEqual({
      kind: "gltf",
      url: "/a.gltf",
    });
    expect(parse.asset(null)).toBeNull();
    expect(parse.asset({})).toBeNull();
  });

  it("accepte un Blob", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], {
      type: "model/gltf-binary",
    });
    const a = parse.asset({ blob, kind: "glb" });
    expect(a?.blob).toBe(blob);
    expect(a?.kind).toBe("glb");
  });
});

describe("toNum / isFormFlagOn", () => {
  it("coerce nombre / string", () => {
    expect(parse.toNum(3, 0)).toBe(3);
    expect(parse.toNum("2.5", 0)).toBe(2.5);
    expect(parse.toNum("x", 7)).toBe(7);
  });

  it("flag form checkbox unique", () => {
    expect(parse.isFormFlagOn("true")).toBe(true);
    expect(parse.isFormFlagOn(null)).toBe(false);
    expect(parse.isFormFlagOn("false")).toBe(false);
    expect(parse.isFormFlagOn(1)).toBe(true);
    expect(parse.isFormFlagOn("on")).toBe(true);
  });
});

describe("Sonic3d", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  beforeAll(() => {
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as typeof ResizeObserver;
    }
    if (typeof globalThis.IntersectionObserver === "undefined") {
      globalThis.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
        root = null;
        rootMargin = "";
        thresholds = [];
      } as typeof IntersectionObserver;
    }
  });

  it("enregistre le custom element", () => {
    expect(customElements.get("sonic-3d")).toBe(Sonic3d);
  });

  it("monte sans src (cube démo) et expose les attributs", async () => {
    const el = TestUtils.bootstrap(
      `<sonic-3d camera="perspective" fov="50" aspect-ratio="1"></sonic-3d>`,
    )[0] as Sonic3d;
    expect(el.camera).toBe(Sonic3dCameraMode.Perspective);
    expect(el.fov).toBe(50);
    expect(el.tagName.toLowerCase()).toBe("sonic-3d");
    await el.updateComplete;
  });

  it("reste stable sans WebGL (jsdom)", async () => {
    const el = TestUtils.bootstrap(
      `<sonic-3d style="width:64px;height:64px"></sonic-3d>`,
    )[0] as Sonic3d;
    await new Promise((r) => setTimeout(r, 50));
    await el.updateComplete;
    expect(el).toBeInstanceOf(Sonic3d);
  });
});

describe("orbit.wheelAffectsZoom", () => {
  const mockControls = (opts: {
    distance: number;
    minDistance?: number;
    maxDistance?: number;
    orthographic?: boolean;
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
  }) =>
    ({
      minDistance: opts.minDistance ?? 1,
      maxDistance: opts.maxDistance ?? 10,
      minZoom: opts.minZoom ?? 0,
      maxZoom: opts.maxZoom ?? Infinity,
      getDistance: () => opts.distance,
      object: opts.orthographic
        ? { isOrthographicCamera: true, zoom: opts.zoom ?? 1 }
        : { isPerspectiveCamera: true },
    }) as unknown as OrbitControls;

  it("perspective : bloque aux bornes dans le sens demandé", () => {
    const atMin = mockControls({ distance: 1, minDistance: 1, maxDistance: 10 });
    expect(orbit.wheelAffectsZoom(atMin, -1)).toBe(false);
    expect(orbit.wheelAffectsZoom(atMin, 1)).toBe(true);

    const atMax = mockControls({
      distance: 10,
      minDistance: 1,
      maxDistance: 10,
    });
    expect(orbit.wheelAffectsZoom(atMax, 1)).toBe(false);
    expect(orbit.wheelAffectsZoom(atMax, -1)).toBe(true);
  });

  it("perspective : maxDistance infini laisse zoom out", () => {
    const c = mockControls({
      distance: 1000,
      minDistance: 1,
      maxDistance: Infinity,
    });
    expect(orbit.wheelAffectsZoom(c, 1)).toBe(true);
  });

  it("ortho : bornes minZoom / maxZoom", () => {
    const atMaxZoom = mockControls({
      distance: 5,
      orthographic: true,
      zoom: 4,
      maxZoom: 4,
      minZoom: 0.5,
    });
    expect(orbit.wheelAffectsZoom(atMaxZoom, -1)).toBe(false);
    expect(orbit.wheelAffectsZoom(atMaxZoom, 1)).toBe(true);
  });
});

describe("wantsOffscreenPlay / frame consumers", () => {
  it("playOffscreen ou consumers → true", async () => {
    const { wantsOffscreenPlay } = await import("./playback");
    expect(wantsOffscreenPlay({ playOffscreen: false, frameConsumerCount: 0 })).toBe(
      false,
    );
    expect(wantsOffscreenPlay({ playOffscreen: true, frameConsumerCount: 0 })).toBe(
      true,
    );
    expect(wantsOffscreenPlay({ playOffscreen: false, frameConsumerCount: 1 })).toBe(
      true,
    );
  });

  it("registerFrameConsumer incrémente le compteur", async () => {
    const el = TestUtils.bootstrap(
      `<sonic-3d style="width:64px;height:64px"></sonic-3d>`,
      true,
    )[0] as Sonic3d;
    await el.updateComplete;
    expect(el.frameConsumerCount).toBe(0);
    const token = {};
    el.registerFrameConsumer(token);
    expect(el.frameConsumerCount).toBe(1);
    expect(el.playOffscreen).toBe(false);
    el.unregisterFrameConsumer(token);
    expect(el.frameConsumerCount).toBe(0);
  });

  it("stopMotion coupe autoRotate", async () => {
    const el = TestUtils.bootstrap(
      `<sonic-3d auto-rotate style="width:64px;height:64px"></sonic-3d>`,
      true,
    )[0] as Sonic3d;
    await el.updateComplete;
    expect(el.autoRotate).toBe(true);
    el.stopMotion();
    expect(el.autoRotate).toBe(false);
    expect(el.moving).toBe(0);
  });
});
