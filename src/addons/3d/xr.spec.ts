import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";
import "./xr";
import "./3d";
import { framePosition, parseFeatures, parseVec3, placePosition, type SonicXr, type XrState, arScaleFor, hideProjectionLayers } from "./xr";
import type { Sonic3d, Sonic3dXrHost } from "./3d";

const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const domError = (name: string) => Object.assign(new Error(name), { name });

/* ─── Faux WebXR ─────────────────────────────────────────────────────────────────────────────────── */

class FakeSession extends EventTarget {
  ended = false;
  inputSources = [{ handedness: "right", targetRayMode: "tracked-pointer", targetRaySpace: { ray: true } }];
  refs: string[] = [];
  floor = true;
  hitCancel = vi.fn();
  async requestReferenceSpace(type: string) {
    this.refs.push(type);
    if (type === "local-floor" && !this.floor) throw domError("NotSupportedError");
    return { type };
  }
  async requestHitTestSource() {
    return { cancel: this.hitCancel };
  }
  async end() {
    this.ended = true;
    this.dispatchEvent(new Event("end"));
  }
}

function fakeXr(opts: { vr?: boolean; ar?: boolean; fail?: string } = {}) {
  const sessions: FakeSession[] = [];
  const requests: { mode: string; init: Record<string, unknown> }[] = [];
  const xr = {
    isSessionSupported: vi.fn(async (m: string) => (m === "immersive-vr" ? !!opts.vr : !!opts.ar)),
    requestSession: vi.fn((mode: string, init: Record<string, unknown>) => {
      requests.push({ mode, init });
      if (opts.fail) return Promise.reject(domError(opts.fail));
      const s = new FakeSession();
      sessions.push(s);
      return Promise.resolve(s);
    }),
  };
  Object.defineProperty(navigator, "xr", { configurable: true, value: xr });
  return { xr, sessions, requests };
}

/** Hôte simulé (pas de WebGL dans jsdom) : vraie scène three, renderer factice. */
function fakeHost() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x223344);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  box.name = "cube";
  scene.add(box);
  let loop: ((t: number, f?: unknown) => void) | null = null;
  let clearAlpha = 1;
  const renderer = {
    domElement: document.createElement("canvas"),
    xr: {
      enabled: false,
      refType: "",
      setReferenceSpaceType(t: string) {
        this.refType = t;
      },
      setSession: vi.fn(async () => {}),
      getReferenceSpace: () => ({ ref: true }),
    },
    setAnimationLoop: vi.fn((fn: typeof loop) => {
      loop = fn;
    }),
    getClearAlpha: () => clearAlpha,
    setClearAlpha: (a: number) => {
      clearAlpha = a;
    },
  };
  const calls = { pause: 0, resume: 0, render: 0, taps: [] as unknown[] };
  const host: Sonic3dXrHost = {
    renderer: renderer as never,
    scene,
    camera: new THREE.PerspectiveCamera(),
    pause: () => void calls.pause++,
    resume: () => void calls.resume++,
    render: () => void calls.render++,
    bounds: () => ({ center: [0, 0.5, 0], min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }),
    pickRay: (o, d) => {
      const rc = new THREE.Raycaster(new THREE.Vector3(...o), new THREE.Vector3(...d).normalize());
      scene.updateMatrixWorld(true);
      const h = rc.intersectObject(box)[0];
      return h ? { objectId: "cube", x: h.point.x, y: h.point.y, z: h.point.z } : null;
    },
    tap: (hit) => void calls.taps.push(hit),
  };
  return { host, scene, renderer, calls, frame: (f?: unknown) => loop?.(0, f), loopSet: () => !!loop, clearAlpha: () => clearAlpha };
}

async function mount(html: string, host: Sonic3dXrHost | null): Promise<SonicXr> {
  const scene = document.createElement("div");
  scene.id = "scene";
  (scene as unknown as { getXrHost: () => Sonic3dXrHost | null }).getXrHost = () => host;
  document.body.appendChild(scene);
  document.body.insertAdjacentHTML("beforeend", html);
  const el = document.querySelector("sonic-xr") as SonicXr;
  await el.updateComplete;
  await wait();
  return el;
}

const state = (id = "xr") => get(`${id}State`) as XrState;

afterEach(() => {
  document.body.innerHTML = "";
  delete (navigator as { xr?: unknown }).xr;
});

describe("utilitaires", () => {
  it("lit les vecteurs et les fonctionnalités", () => {
    expect(parseVec3("0 1 -2")).toEqual([0, 1, -2]);
    expect(parseVec3("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseVec3("1 2")).toBeNull();
    expect(parseVec3("a b c")).toBeNull();
    expect(parseFeatures("hit-test hand-tracking anchors hit-test")).toEqual(["hit-test", "hand-tracking"]);
  });

  it("place le centre devant les yeux, ou le bas sur un point", () => {
    const b = { center: [0, 0.5, 0] as [number, number, number], min: [-0.5, 0, -0.5] as [number, number, number], max: [0.5, 1, 0.5] as [number, number, number] };
    const p = framePosition(b, 1, "local-floor", [0, 0, 0]);
    expect(p[1] + 0.5).toBeCloseTo(1.4);
    expect(p[2]).toBeLessThan(-1);
    expect(framePosition(b, 1, "local", [0, 0, 0])[1]).toBeCloseTo(-0.5);
    expect(framePosition(b, 1, "local", [1, 0, 0])[0]).toBeCloseTo(1);
    expect(placePosition(b, 2, [1, 0, -1])).toEqual([1, 0, -1]);
  });
});

describe("sonic-xr", () => {
  it("sans navigator.xr : supported false, fenêtre magique toujours possible", async () => {
    await mount(`<sonic-xr id="xr" target="scene"></sonic-xr>`, null);
    expect(state().supported).toBe(false);
    expect(state().status).toBe("idle");
    expect(state().modes.magic).toBe(true);
  });

  it("sans navigator.xr et fallback=none : unsupported", async () => {
    await mount(`<sonic-xr id="xr" target="scene" fallback="none"></sonic-xr>`, null);
    expect(state().status).toBe("unsupported");
    expect(state().supported).toBe(false);
  });

  it("sans casque, le clic ouvre la fenêtre magique ; glisser tourne la vue ; Échap la referme", async () => {
    const h = fakeHost();
    await mount(`<sonic-xr id="xr" target="scene" for="btn"></sonic-xr><button id="btn"></button>`, h.host);
    const cam = h.host.camera;
    const before = cam.quaternion.clone();
    (document.getElementById("btn") as HTMLButtonElement).click();
    await wait();
    expect(state().magic).toBe(true);
    expect(state().active).toBe(true);
    expect(h.calls.pause).toBe(1);
    // caméra au centre de la scène, à hauteur des yeux bornée par la hauteur (1 m → 0,64 m)
    expect(cam.position.x).toBeCloseTo(0);
    expect(cam.position.y).toBeCloseTo(0.64);
    const canvas = h.renderer.domElement;
    const ptr = (type: string, x = 0, y = 0) => canvas.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, clientX: x, clientY: y }));
    ptr("pointerdown", 100, 100);
    ptr("pointermove", 300, 100);
    ptr("pointerup");
    await new Promise((r) => setTimeout(r, 40));
    expect(h.calls.render).toBeGreaterThan(0);
    expect(cam.quaternion.angleTo(before)).toBeGreaterThan(0.1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(state().magic).toBe(false);
    expect(h.calls.resume).toBe(1);
  });

  it("data-xr-mode choisit le mode du bouton cliqué (VR même si l'AR existe)", async () => {
    const x = fakeXr({ vr: true, ar: true });
    const h = fakeHost();
    await mount(`<sonic-xr id="xr" target="scene" for="vr ar"></sonic-xr><button id="vr" data-xr-mode="vr"></button><button id="ar" data-xr-mode="ar"></button>`, h.host);
    (document.getElementById("vr") as HTMLButtonElement).click();
    await wait();
    expect(x.requests[0]?.mode).toBe("immersive-vr");
  });

  it("interroge isSessionSupported au montage", async () => {
    fakeXr({ vr: true, ar: false });
    await mount(`<sonic-xr id="xr" target="scene"></sonic-xr>`, null);
    expect(state().supported).toBe(true);
    expect(state().modes).toEqual({ vr: true, ar: false, magic: true });
    expect(state().status).toBe("idle");
  });

  it("scène introuvable : erreur lisible", async () => {
    fakeXr({ vr: true });
    const el = await mount(`<sonic-xr id="xr" target="scene"></sonic-xr>`, null);
    expect(await el.run("enter")).toBe(false);
    expect(state().error).toMatch(/introuvable/);
  });

  it("entre en VR, rend par setAnimationLoop, sort et restaure", async () => {
    const { requests, sessions } = fakeXr({ vr: true });
    const h = fakeHost();
    const el = await mount(`<sonic-xr id="xr" target="scene" features="hand-tracking hit-test"></sonic-xr>`, h.host);
    expect(await el.run("enter")).toBe(true);
    expect(requests[0].mode).toBe("immersive-vr");
    // hit-test ne s'applique qu'en AR
    expect(requests[0].init.optionalFeatures).toEqual(["local-floor", "hand-tracking"]);
    expect(h.renderer.xr.enabled).toBe(true);
    expect(h.renderer.xr.refType).toBe("local-floor");
    expect(h.calls.pause).toBe(1);
    expect(h.loopSet()).toBe(true);
    h.frame();
    expect(h.calls.render).toBe(1);
    // centre de la scène (0,0.5,0) devant les yeux
    expect(h.scene.position.y + 0.5).toBeCloseTo(1.4);
    expect(h.scene.position.z).toBeLessThan(-1);
    const s = state();
    expect(s).toMatchObject({ status: "ready", active: true, presenting: true, mode: "vr", reference: "local-floor" });
    expect(s.inputs).toEqual([{ handedness: "right", mode: "tracked-pointer", hand: false }]);
    expect(h.scene.background).not.toBeNull();

    expect(await el.run("exit")).toBe(true);
    expect(sessions[0].ended).toBe(true);
    expect(h.calls.resume).toBe(1);
    expect(h.renderer.xr.enabled).toBe(false);
    expect(h.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(h.scene.position.toArray()).toEqual([0, 0, 0]);
    expect(state()).toMatchObject({ status: "idle", active: false, presenting: false, mode: null });
  });

  it("local-floor refusé : repli local", async () => {
    const { sessions, xr } = fakeXr({ vr: true });
    xr.requestSession.mockImplementationOnce(() => {
      const s = new FakeSession();
      s.floor = false;
      sessions.push(s);
      return Promise.resolve(s);
    });
    const h = fakeHost();
    const el = await mount(`<sonic-xr id="xr" target="scene"></sonic-xr>`, h.host);
    await el.run("enter");
    expect(h.renderer.xr.refType).toBe("local");
    expect(state().reference).toBe("local");
  });

  it("AR : fond transparent, hit-test, réticule et place", async () => {
    const { requests } = fakeXr({ vr: true, ar: true });
    const h = fakeHost();
    const el = await mount(`<sonic-xr id="xr" target="scene" mode="auto" features="hit-test" reticle></sonic-xr>`, h.host);
    await el.run("enter");
    expect(requests[0].mode).toBe("immersive-ar");
    expect(h.scene.background).toBeNull();
    expect(h.clearAlpha()).toBe(0);
    const pose = { transform: { position: { x: 0.5, y: 0, z: -1 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } };
    h.frame({ getHitTestResults: () => [{ getPose: () => pose }], getPose: () => null });
    await wait(50);
    expect(state().hit).toEqual({ x: 0.5, y: 0, z: -1 });
    expect(h.scene.getObjectByName("sonic-xr-reticle")?.visible).toBe(true);
    expect(await el.run("place")).toBe(true);
    // bas du centre (0,0,0) posé sur le point visé
    expect(h.scene.position.toArray()).toEqual([0.5, 0, -1]);
    await el.run("exit");
    expect(h.scene.background).not.toBeNull();
    expect(h.clearAlpha()).toBe(1);
    expect(h.scene.getObjectByName("sonic-xr-reticle")).toBeUndefined();
  });

  it("dom-overlay : root transmis, touchers de l'interface écartés", async () => {
    const { requests } = fakeXr({ ar: true });
    const h = fakeHost();
    const el = await mount(`<div id="hud"></div><sonic-xr id="xr" target="scene" mode="ar" features="dom-overlay" overlay="hud"></sonic-xr>`, h.host);
    await el.run("enter");
    const hud = document.getElementById("hud")!;
    expect(requests[0].init.domOverlay).toEqual({ root: hud });
    expect((requests[0].init.optionalFeatures as string[]).includes("dom-overlay")).toBe(true);
    const ev = new Event("beforexrselect", { cancelable: true });
    hud.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("select d'une manette : tap de la scène et action xr:select", async () => {
    const { sessions } = fakeXr({ vr: true });
    const h = fakeHost();
    const actions: SonicActionMessage[] = [];
    registerStore({ id: "jeu", dispatch: (a) => actions.push(a), getState: () => ({}), reset: () => {} });
    const el = await mount(`<sonic-xr id="xr" target="scene" store="jeu" reference="local"></sonic-xr>`, h.host);
    await el.run("enter");
    // place la scène à l'origine pour viser le cube depuis z = 3
    h.scene.position.set(0, 0, 0);
    const pose = { transform: { position: { x: 0, y: 0.5, z: 3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } } };
    const ev = Object.assign(new Event("select"), { inputSource: sessions[0].inputSources[0], frame: { getPose: () => pose } });
    sessions[0].dispatchEvent(ev);
    expect(h.calls.taps[0]).toMatchObject({ objectId: "cube", z: 0.5 });
    expect(actions[0]).toMatchObject({ type: "xr:select", payload: { objectId: "cube", point: [0, 0.5, 0.5], hand: "right", mode: "vr" } });
    unregisterStore("jeu");
  });

  it("session refusée : denied", async () => {
    fakeXr({ vr: true, fail: "NotAllowedError" });
    const h = fakeHost();
    const el = await mount(`<sonic-xr id="xr" target="scene"></sonic-xr>`, h.host);
    expect(await el.run("enter")).toBe(false);
    expect(state().status).toBe("denied");
    expect(h.calls.pause).toBe(0);
  });

  it("for : la session est demandée dans le clic", async () => {
    const { xr } = fakeXr({ vr: true });
    const h = fakeHost();
    await mount(`<button id="vr"></button><sonic-xr id="xr" target="scene" for="vr"></sonic-xr>`, h.host);
    document.getElementById("vr")!.click();
    // appel synchrone : avant toute attente
    expect(xr.requestSession).toHaveBeenCalledTimes(1);
  });
});

describe("Sonic3d.getXrHost", () => {
  beforeAll(() => {
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as never;
    }
    if (typeof globalThis.IntersectionObserver === "undefined") {
      globalThis.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      } as never;
    }
  });
  let el: Sonic3d;
  beforeEach(async () => {
    el = document.createElement("sonic-3d") as Sonic3d;
    document.body.appendChild(el);
    await el.updateComplete;
  });

  it("null tant que la scène n'est pas prête", () => {
    el.runtime = null;
    expect(el.getXrHost()).toBeNull();
  });

  it("suspend la boucle, rend en XR, émet le tap de sonic-3d", () => {
    const rt = {
      renderer: {},
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      xrBegin: vi.fn(),
      xrEnd: vi.fn(),
      renderXr: vi.fn(),
      render: vi.fn(),
      bounds: () => null,
      pickRay: vi.fn(() => null),
      setAutoRotate: vi.fn(),
      snapshot: vi.fn(),
    };
    el.runtime = rt as never;
    el.ready = true;
    el.raf = 0;
    const h = el.getXrHost()!;
    h.pause();
    expect(el.xrPresenting).toBe(true);
    expect(rt.xrBegin).toHaveBeenCalled();
    h.render();
    expect(rt.renderXr).toHaveBeenCalledTimes(1);
    const actions: SonicActionMessage[] = [];
    registerStore({ id: "g", dispatch: (a) => actions.push(a), getState: () => ({}), reset: () => {} });
    el.pick = true;
    el.target = "g";
    h.tap({ objectId: "m_1", x: 1, y: 2, z: 3, instance: "chaise", src: 0 });
    expect(actions[0]).toMatchObject({ type: "pick", payload: { objectId: "m_1", x: 1, y: 2, z: 3, instance: "chaise", src: 0 } });
    unregisterStore("g");
    h.resume();
    expect(el.xrPresenting).toBe(false);
    expect(rt.xrEnd).toHaveBeenCalled();
    // runtime factice : rien à libérer au démontage
    el.runtime = null;
    el.ready = false;
  });
});

describe("AR en maquette", () => {
  it("arScaleFor : auto ramène l'emprise au sol à 60 cm, jamais agrandie ; un nombre est imposé", () => {
    const room = { min: [0, 0, 0] as [number, number, number], max: [4.4, 2.5, 3.3] as [number, number, number] };
    expect(arScaleFor(room, "auto")).toBeCloseTo(0.6 / 4.4);
    expect(arScaleFor({ min: [0, 0, 0], max: [0.2, 0.2, 0.2] }, "auto")).toBe(1);
    expect(arScaleFor(room, "0.05")).toBe(0.05);
  });
});

describe("couche WebXR en AR", () => {
  it("hideProjectionLayers masque createProjectionLayer puis le remet", () => {
    class FakeBinding {
      createProjectionLayer() {
        return 1;
      }
    }
    (globalThis as Record<string, unknown>).XRWebGLBinding = FakeBinding;
    try {
      const restore = hideProjectionLayers();
      expect("createProjectionLayer" in FakeBinding.prototype).toBe(false);
      restore();
      expect(new FakeBinding().createProjectionLayer()).toBe(1);
      restore();
      expect("createProjectionLayer" in FakeBinding.prototype).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).XRWebGLBinding;
    }
  });
});
