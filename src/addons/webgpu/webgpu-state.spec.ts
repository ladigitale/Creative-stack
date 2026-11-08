import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import TestUtils from "@supersoniks/concorde/test-utils/TestUtils";
import { PublisherManager } from "@supersoniks/concorde/utils";
import { buildWgslSource, wgslUserLine } from "./wgsl-prelude";
import { describeWebGpuError, readWebGpuParams, MAX_WGSL_CHARS } from "./state";
import { outFrame } from "./out-frame";
import { pointer } from "./pointer";
import { WebGpuCompileError } from "./types";
import "./webgpu";
import type { SonicWebGpu } from "./webgpu";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("wgslUserLine", () => {
  it("ramène une ligne de la source assemblée au corps de l'utilisateur", () => {
    const body = "\n\nfn mainImage(uv: vec2f, fragCoord: vec2f) -> vec4f {\n  return MARK;\n}";
    const full = buildWgslSource(body);
    const fullLine = full.slice(0, full.indexOf("MARK")).split("\n").length;
    // Deux lignes vides en tête (retirées par trim) : MARK est en ligne 4 du corps fourni.
    expect(wgslUserLine(fullLine, body)).toBe(4);
    expect(wgslUserLine(3, body)).toBeNull(); // prélude
    expect(wgslUserLine(0, body)).toBeNull(); // inconnue
  });
});

describe("readWebGpuParams / describeWebGpuError", () => {
  it("borne et refuse l'invalide", () => {
    const { live, invalid } = readWebGpuParams({
      play: "false",
      mouse: 1,
      backend: "WEBGL2",
      dprMax: 0,
      shader: "x".repeat(MAX_WGSL_CHARS + 1),
    });
    expect(live).toEqual({ play: false, mouse: true, backend: "webgl2", dprMax: 0.25 });
    expect(invalid).toEqual(["shader"]);
    expect(readWebGpuParams({ backend: "vulkan", play: "oui" }).invalid).toEqual(["play", "backend"]);
    expect(readWebGpuParams({ shader: " " })).toEqual({ live: {}, invalid: [] });
  });

  it("message lisible avec ligne, détail conservé", () => {
    const e = new WebGpuCompileError("WGSL compile error", "unresolved identifier 'foo'", [
      { line: 3, column: 10, message: "unresolved identifier 'foo'" },
      { line: null, column: null, message: "autre" },
    ]);
    const d = describeWebGpuError(e);
    expect(d.error).toBe("WGSL : ligne 3:10 : unresolved identifier 'foo'");
    expect(d.errors).toHaveLength(2);
    expect(describeWebGpuError(new WebGpuCompileError("WGSL invalide : définir mainImage")).error).toBe(
      "WGSL invalide : définir mainImage",
    );
    expect(describeWebGpuError(new Error("boom"))).toEqual({
      error: "boom",
      errors: [{ line: null, column: null, message: "boom" }],
    });
  });
});

type FakeRuntime = {
  backend: string;
  canvas: HTMLCanvasElement;
  setShader: ReturnType<typeof vi.fn>;
  setChannel: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  draw: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getTextureSize: () => null;
};

function fakeRuntime(): FakeRuntime {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  return {
    backend: "canvas2d",
    canvas,
    setShader: vi.fn(async () => {}),
    setChannel: vi.fn(async () => {}),
    resize: vi.fn(),
    draw: vi.fn(),
    dispose: vi.fn(),
    getTextureSize: () => null,
  };
}

type Internal = {
  runtime: FakeRuntime | null;
  boot: Promise<void> | null;
  rebuild: () => Promise<void>;
  shouldPlay: () => boolean;
  restartRuntime: () => void;
  effDprMax: number;
  mouseVec: [number, number, number, number];
};

describe("sonic-webgpu : état publié et pilotage par params", () => {
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

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function mount(attrs: string) {
    const el = TestUtils.bootstrap(`<sonic-webgpu style="width:64px;height:64px" ${attrs}></sonic-webgpu>`, true)[0] as SonicWebGpu;
    return { el, internal: el as unknown as Internal };
  }

  it("aucun backend : status error, error, backendLog (event error conservé)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = "webgpu-state-boot";
    PublisherManager.get(out).set({ keep: true });
    const onError = vi.fn();
    const { el } = mount(`out-data-provider="${out}"`);
    el.addEventListener("error", onError);
    expect(PublisherManager.get(out).get()).toMatchObject({ keep: true, status: expect.any(String) });
    await el.updateComplete;
    await tick(40);
    const st = PublisherManager.get(out).get() as Record<string, unknown>;
    if (el.activeBackend) {
      // Environnement avec un backend : prêt
      expect(st.activeBackend).toBe(el.activeBackend);
      return;
    }
    expect(st.status).toBe("error");
    expect(String(st.error)).toMatch(/WebGL2|WebGPU|Canvas2D/);
    expect(st.activeBackend).toBeNull();
    expect((st.backendLog as string[]).length).toBeGreaterThan(0);
    expect(st.keep).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it("compilation WGSL : compiling → error (ligne) → ready", async () => {
    const out = "webgpu-state-compile";
    const { el, internal } = mount(`out-data-provider="${out}"`);
    await el.updateComplete;
    await tick(40);
    const rt = fakeRuntime();
    rt.setShader.mockImplementationOnce(async () => {
      throw new WebGpuCompileError("WGSL compile error", "unresolved identifier 'foo'", [
        { line: 2, column: 5, message: "unresolved identifier 'foo'" },
      ]);
    });
    internal.runtime = rt;
    const seen: string[] = [];
    el.addEventListener("webgpu-state", (e) => seen.push((e as CustomEvent).detail.status));
    const onError = vi.fn();
    el.addEventListener("error", onError);
    await internal.rebuild();
    expect(seen).toEqual(["compiling", "error"]);
    expect(PublisherManager.get(out).get()).toMatchObject({
      status: "error",
      error: "WGSL : ligne 2:5 : unresolved identifier 'foo'",
      errors: [{ line: 2, column: 5, message: "unresolved identifier 'foo'" }],
    });
    expect(onError.mock.calls[0][0].detail.message).toMatch(/WGSL compile error/);

    await internal.rebuild();
    expect(PublisherManager.get(out).get()).toMatchObject({ status: "ready", error: null, errors: [] });
  });

  it("les publications par frame gardent les clés d'état", async () => {
    const out = "webgpu-state-frame";
    const { el, internal } = mount(`out-data-provider="${out}"`);
    await el.updateComplete;
    await tick(40);
    internal.runtime = fakeRuntime();
    await internal.rebuild();
    el.addEventListener("out", () => {});
    (el as unknown as { lastOutAt: number }).lastOutAt = -1e9;
    outFrame.maybePublishOut(el as never, performance.now(), 1);
    expect(PublisherManager.get(out).get()).toMatchObject({ status: "ready", time: 1 });
  });

  it("DP partagé avec un formulaire : les publications par frame n'effacent pas ses champs", async () => {
    const shared = "webgpu-shared-form";
    PublisherManager.get(shared).set({ param0: 0.4, titre: "réglages", choix: [1, 2] });
    const { el, internal } = mount(`dataProvider="${shared}"`);
    await el.updateComplete;
    await tick(40);
    internal.runtime = fakeRuntime();
    await internal.rebuild();
    el.addEventListener("out", () => {});
    for (let i = 0; i < 3; i++) {
      (el as unknown as { lastOutAt: number }).lastOutAt = -1e9;
      outFrame.maybePublishOut(el as never, performance.now(), i + 1);
    }
    expect(PublisherManager.get(shared).get()).toMatchObject({
      param0: 0.4, titre: "réglages", choix: [1, 2], status: "ready", time: 3,
    });
  });

  it("instantané (frameUrl) : n'efface pas les autres clés de la sortie", () => {
    const out = "webgpu-snapshot-keys";
    PublisherManager.get(out).set({ keep: 1, time: 2 });
    outFrame.writeKeys(PublisherManager.get(out), { frameUrl: "blob:x", snapshot: { url: "blob:x", width: 1, height: 1, mime: "image/png" } });
    expect(PublisherManager.get(out).get()).toMatchObject({ keep: 1, time: 2, frameUrl: "blob:x" });
  });

  it("params : play, mouse, dprMax en direct (attributs non réécrits)", async () => {
    const params = "webgpu-live-params";
    PublisherManager.get(params).set({});
    const { el, internal } = mount(`params="${params}" dpr-max="1.5"`);
    await el.updateComplete;
    await tick(40);
    internal.runtime = fakeRuntime();
    await internal.rebuild();
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) expect(internal.shouldPlay()).toBe(true);
    expect(internal.effDprMax).toBe(1.5);

    PublisherManager.get(params).set({ play: false, mouse: false, dprMax: 1 });
    await tick();
    expect(internal.shouldPlay()).toBe(false);
    expect(el.stateValue.playing).toBe(false);
    expect(el.mouseActive).toBe(false);
    expect(el.mouse).toBe(true);
    expect(internal.effDprMax).toBe(1);
    internal.mouseVec[0] = 7;
    pointer.onMove(el as never, { clientX: 30, clientY: 30 } as PointerEvent);
    expect(internal.mouseVec[0]).toBe(7); // pointeur ignoré

    PublisherManager.get(params).set({});
    await tick();
    expect(el.mouseActive).toBe(true);
    if (!reduced) expect(internal.shouldPlay()).toBe(true);
  });

  it("params : backend redémarre, shader recompile (regroupés)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const params = "webgpu-live-backend";
    PublisherManager.get(params).set({});
    const { el, internal } = mount(`params="${params}"`);
    await el.updateComplete;
    await tick(40);
    const rt = fakeRuntime();
    internal.runtime = rt;
    await internal.rebuild();
    const restart = vi.spyOn(internal, "restartRuntime").mockImplementation(() => {});

    const wgsl = "fn mainImage(uv: vec2f, fragCoord: vec2f) -> vec4f { _ = fragCoord; return vec4f(uv, 0.0, 1.0); }";
    rt.setShader.mockClear();
    PublisherManager.get(params).set({ shader: wgsl.replace("0.0", "0.5") });
    PublisherManager.get(params).set({ shader: wgsl });
    await tick(220);
    expect(restart).not.toHaveBeenCalled();
    expect(rt.setShader).toHaveBeenCalledOnce();
    expect(rt.setShader).toHaveBeenCalledWith(wgsl);
    expect(el.shader).toBe("");

    PublisherManager.get(params).set({ shader: wgsl, backend: "webgl2" });
    PublisherManager.get(params).set({ shader: wgsl, backend: "webgpu" });
    await tick(220);
    expect(restart).toHaveBeenCalledOnce();
    expect(el.backendPrefer).toBe("auto");
  });
});
