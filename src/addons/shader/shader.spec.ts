import { expect, describe, it, vi, afterEach, beforeAll } from "vitest";
import TestUtils from "@supersoniks/concorde/test-utils/TestUtils";
import {
  parseChannelSource,
  shouldUploadElementFrame,
} from "./gl-runtime";
import { buildFragmentSource } from "./shadertoy-prelude";
import "./shader";
import { SonicShader, channelFormValue } from "./shader";

describe("parseBufferFormat", () => {
  it("accepte rgba8 / rgba16f / rgba32f", async () => {
    const { parseBufferFormat } = await import("./types");
    expect(parseBufferFormat("rgba8")).toBe("rgba8");
    expect(parseBufferFormat("rgba16f")).toBe("rgba16f");
    expect(parseBufferFormat("half")).toBe("rgba16f");
    expect(parseBufferFormat("rgba32f")).toBe("rgba32f");
    expect(parseBufferFormat("float")).toBe("rgba32f");
    expect(parseBufferFormat("")).toBe("rgba8");
    expect(parseBufferFormat("nope")).toBe("rgba8");
  });
});

describe("resolveBufferGlFormat", () => {
  it("reste rgba8 sans extension float", async () => {
    const { resolveBufferGlFormat, resetBufferFormatWarnFlag } = await import(
      "./gl-runtime"
    );
    resetBufferFormatWarnFlag();
    const gl = {
      RGBA8: 0x8058,
      RGBA16F: 0x881a,
      RGBA32F: 0x8814,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      HALF_FLOAT: 0x140b,
      FLOAT: 0x1406,
      LINEAR: 0x2601,
      NEAREST: 0x2600,
      getExtension: () => null,
    } as unknown as WebGL2RenderingContext;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fmt = resolveBufferGlFormat(gl, "rgba16f");
    expect(fmt.active).toBe("rgba8");
    expect(fmt.float).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("accepte rgba16f avec EXT_color_buffer_float", async () => {
    const { resolveBufferGlFormat, resetBufferFormatWarnFlag } = await import(
      "./gl-runtime"
    );
    resetBufferFormatWarnFlag();
    const gl = {
      RGBA8: 0x8058,
      RGBA16F: 0x881a,
      RGBA32F: 0x8814,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      HALF_FLOAT: 0x140b,
      FLOAT: 0x1406,
      LINEAR: 0x2601,
      NEAREST: 0x2600,
      getExtension: (name: string) =>
        name === "EXT_color_buffer_float" ? {} : null,
    } as unknown as WebGL2RenderingContext;
    const fmt = resolveBufferGlFormat(gl, "rgba16f");
    expect(fmt.active).toBe("rgba16f");
    expect(fmt.float).toBe(true);
    expect(fmt.type).toBe(gl.HALF_FLOAT);
  });
});

describe("findPeaks float", () => {
  it("lit des scores Float32 déjà normalisés", async () => {
    const { findPeaks } = await import("./types");
    const w = 8;
    const h = 8;
    const data = new Float32Array(w * h * 4);
    data[(3 * w + 3) * 4] = 0.9;
    data[(3 * w + 4) * 4] = 0.4;
    const peaks = findPeaks(data, w, h, {
      threshold: 0.5,
      maxCount: 2,
      minDistance: 2,
    });
    expect(peaks.length).toBeGreaterThanOrEqual(1);
    expect(peaks[0].score).toBeCloseTo(0.9, 5);
  });
});

describe("parseChannelSource", () => {
  it("résout self / buffers / url / fallback", () => {
    expect(parseChannelSource("self", "")).toEqual({ kind: "self" });
    expect(parseChannelSource("buffer-a", "")).toEqual({
      kind: "buffer",
      buffer: "bufferA",
    });
    expect(parseChannelSource("B", "")).toEqual({
      kind: "buffer",
      buffer: "bufferB",
    });
    expect(parseChannelSource("/tex.png", "")).toEqual({
      kind: "url",
      url: "/tex.png",
    });
    expect(parseChannelSource("", "/fallback.png")).toEqual({
      kind: "url",
      url: "/fallback.png",
    });
    expect(parseChannelSource("none", "")).toEqual({ kind: "none" });
  });

  it("résout #id comme élément (pas URL)", () => {
    expect(parseChannelSource("#plateau", "")).toEqual({
      kind: "element",
      key: "#plateau",
    });
    expect(parseChannelSource("", "#scene")).toEqual({
      kind: "element",
      key: "#scene",
    });
  });
});

describe("channelFormValue", () => {
  it("passe { element } → #id", () => {
    expect(channelFormValue({ element: "#plateau" })).toBe("#plateau");
    expect(channelFormValue({ element: "plateau" })).toBe("#plateau");
    expect(channelFormValue({ url: "https://x/a.png" })).toBe(
      "https://x/a.png",
    );
    expect(channelFormValue({ blob: new Blob() })).toBeUndefined();
  });
});

describe("shouldUploadElementFrame", () => {
  it("canvas : upload chaque frame si taille ok", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    expect(shouldUploadElementFrame(canvas, 0).upload).toBe(true);
    expect(shouldUploadElementFrame(canvas, 3).upload).toBe(true);
  });

  it("FrameSource : skip si frameSeq inchangé, upload sinon", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const src = {
      frameSeq: 5,
      getFrameCanvas: () => canvas,
    };
    expect(shouldUploadElementFrame(src, 5).upload).toBe(false);
    const up = shouldUploadElementFrame(src, 4);
    expect(up.upload).toBe(true);
    expect(up.texSource).toBe(canvas);
  });

  it("source absente → pas d’upload (texture noire côté runtime)", () => {
    expect(shouldUploadElementFrame(null, 0).upload).toBe(false);
    expect(
      shouldUploadElementFrame(
        { frameSeq: 1, getFrameCanvas: () => null },
        0,
      ).upload,
    ).toBe(false);
  });

  it("image : upload au changement de src seulement", () => {
    const img = document.createElement("img");
    Object.defineProperty(img, "complete", { value: true });
    Object.defineProperty(img, "naturalWidth", { value: 8 });
    Object.defineProperty(img, "naturalHeight", { value: 8 });
    Object.defineProperty(img, "currentSrc", {
      value: "https://example.test/a.png",
    });
    const first = shouldUploadElementFrame(img, 0);
    expect(first.upload).toBe(true);
    expect(first.nextSrc).toBe("https://example.test/a.png");
    const again = shouldUploadElementFrame(
      img,
      1,
      "https://example.test/a.png",
    );
    expect(again.upload).toBe(false);
  });
});

describe("buildFragmentSource", () => {
  it("injecte common + mainImage wrapper", () => {
    const src = buildFragmentSource(
      "float k = 1.0;",
      "void mainImage(out vec4 o, in vec2 p){ o = vec4(k); }",
    );
    expect(src).toContain("#version 300 es");
    expect(src).toContain("float k = 1.0;");
    expect(src).toContain("mainImage(sonicFragColor");
    expect(src).toContain("uniform sampler2D iChannel0");
  });
});

describe("parseHoverParam", () => {
  it("accepte 0–3 / paramN / vide", async () => {
    const { parseHoverParam } = await import("./types");
    expect(parseHoverParam(0)).toBe(0);
    expect(parseHoverParam("param2")).toBe(2);
    expect(parseHoverParam("")).toBeNull();
    expect(parseHoverParam("nope")).toBeNull();
  });
});

describe("parseExtractPass", () => {
  it("résout image / buffers / none", async () => {
    const { parseExtractPass } = await import("./types");
    expect(parseExtractPass("image")).toBe("image");
    expect(parseExtractPass("buffer-a")).toBe("bufferA");
    expect(parseExtractPass("B")).toBe("bufferB");
    expect(parseExtractPass("none")).toBeNull();
    expect(parseExtractPass("")).toBeNull();
  });
});

describe("findPeaks", () => {
  it("trouve un max local et respecte NMS / maxCount", async () => {
    const { findPeaks } = await import("./types");
    const w = 8;
    const h = 8;
    const data = new Uint8Array(w * h * 4);
    // Peak fort au centre
    const set = (x: number, y: number, v: number) => {
      const i = (y * w + x) * 4;
      data[i] = v;
    };
    set(3, 3, 255);
    set(3, 4, 200);
    set(6, 6, 240);
    const peaks = findPeaks(data, w, h, {
      threshold: 0.5,
      maxCount: 2,
      minDistance: 3,
    });
    expect(peaks.length).toBeGreaterThanOrEqual(1);
    expect(peaks[0].score).toBeCloseTo(1, 2);
    expect(peaks.length).toBeLessThanOrEqual(2);
  });

  it("ignore sous le seuil", async () => {
    const { findPeaks } = await import("./types");
    const w = 4;
    const h = 4;
    const data = new Uint8Array(w * h * 4);
    data[ (2 * w + 2) * 4 ] = 40; // ~0.16
    expect(
      findPeaks(data, w, h, { threshold: 0.5, maxCount: 4, minDistance: 1 }),
    ).toEqual([]);
  });
});

describe("roiToPixels", () => {
  it("clamp un point + patch", async () => {
    const { roiToPixels } = await import("./types");
    const r = roiToPixels({ x: 0.5, y: 0.5, patch: 16 }, 100, 80, 16, 128);
    expect(r).not.toBeNull();
    expect(r!.w).toBe(16);
    expect(r!.h).toBe(16);
    expect(r!.x).toBeGreaterThanOrEqual(0);
    expect(r!.y).toBeGreaterThanOrEqual(0);
    expect(r!.x + r!.w).toBeLessThanOrEqual(100);
    expect(r!.y + r!.h).toBeLessThanOrEqual(80);
  });

  it("clamp un rectangle normalisé hors bornes", async () => {
    const { roiToPixels } = await import("./types");
    const r = roiToPixels(
      { x: -0.1, y: -0.1, w: 0.5, h: 0.5 },
      64,
      64,
      16,
      128,
    );
    expect(r).not.toBeNull();
    expect(r!.x).toBe(0);
    expect(r!.y).toBe(0);
    expect(r!.w).toBeGreaterThan(0);
    expect(r!.h).toBeGreaterThan(0);
  });

  it("refuse un ROI vide après clamp", async () => {
    const { roiToPixels } = await import("./types");
    expect(
      roiToPixels({ x: 2, y: 2, w: 0.1, h: 0.1 }, 10, 10, 16, 128),
    ).toBeNull();
  });
});

describe("meanRgba", () => {
  it("moyenne un buffer RGBA", async () => {
    const { meanRgba } = await import("./types");
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
    const m = meanRgba(data);
    expect(m.r).toBeCloseTo(0.5, 2);
    expect(m.g).toBeCloseTo(0.5, 2);
    expect(m.b).toBeCloseTo(0, 2);
  });
});

describe("release-offscreen auto / self", () => {
  it("parseReleaseOffscreen", async () => {
    const { parseReleaseOffscreen } = await import("./types");
    expect(parseReleaseOffscreen(null)).toBe("auto");
    expect(parseReleaseOffscreen("auto")).toBe("auto");
    expect(parseReleaseOffscreen("")).toBe(true);
    expect(parseReleaseOffscreen("true")).toBe(true);
    expect(parseReleaseOffscreen("false")).toBe(false);
  });

  it("shouldReleaseWhenOffscreen", async () => {
    const { shouldReleaseWhenOffscreen } = await import("./types");
    expect(shouldReleaseWhenOffscreen("auto", true)).toBe(false);
    expect(shouldReleaseWhenOffscreen("auto", false)).toBe(true);
    expect(shouldReleaseWhenOffscreen(true, true)).toBe(true);
    expect(shouldReleaseWhenOffscreen(false, false)).toBe(false);
  });

  it("channelsUseSelf détecte self", async () => {
    const { channelsUseSelf } = await import("./types");
    expect(
      channelsUseSelf([
        [{ kind: "url", url: "/a.png" }, { kind: "none" }, { kind: "none" }, { kind: "none" }],
      ]),
    ).toBe(false);
    expect(
      channelsUseSelf([
        [{ kind: "self" }, { kind: "none" }, { kind: "none" }, { kind: "none" }],
      ]),
    ).toBe(true);
  });
});

describe("SonicShader", () => {
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
    expect(customElements.get("sonic-shader")).toBe(SonicShader);
  });

  it("applique param0…3 depuis dataProvider", async () => {
    const { PublisherManager } = await import(
      "@supersoniks/concorde/utils"
    );
    const id = "shader-form-test";
    const pub = PublisherManager.get(id);
    pub.set({
      param0: 0.11,
      param1: 0.22,
      param2: 0.33,
      param3: 0.44,
    });
    const el = TestUtils.bootstrap(
      `<sonic-shader dataProvider="${id}"></sonic-shader>`,
      true,
    )[0] as SonicShader;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(el.param0).toBe(0.11);
    expect(el.param1).toBe(0.22);
    expect(el.param2).toBe(0.33);
    expect(el.param3).toBe(0.44);

    // Nested field update (comme sonic-audio-input) doit remonter via onInternalMutation
    pub.param0.set(0.99);
    await new Promise((r) => setTimeout(r, 0));
    expect(el.param0).toBe(0.99);
  });

  it("applique les canaux depuis dataProvider (url | MediaRef | element)", async () => {
    const { PublisherManager } = await import(
      "@supersoniks/concorde/utils"
    );
    const id = "shader-channel-dp";
    const pub = PublisherManager.get(id);
    pub.set({
      bufferACh0: { url: "https://example.test/depth.png" },
      imageCh0: "buffer-a",
      imageCh1: "https://example.test/color.jpg",
      channel0: { element: "#plateau" },
      param0: 0.5,
    });
    const el = TestUtils.bootstrap(
      `<sonic-shader dataProvider="${id}"></sonic-shader>`,
      true,
    )[0] as SonicShader;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(el.bufferACh0).toBe("https://example.test/depth.png");
    expect(el.imageCh0).toBe("buffer-a");
    expect(el.imageCh1).toBe("https://example.test/color.jpg");
    expect(el.channel0).toBe("#plateau");
    expect(el.param0).toBe(0.5);
  });

  it("ne réécrit pas param0…3 sur un dataProvider partagé form+out", async () => {
    const { PublisherManager } = await import(
      "@supersoniks/concorde/utils"
    );
    const id = "shader-form-no-writeback";
    const pub = PublisherManager.get(id);
    pub.set({ param0: 0.42, param1: 0.7, frame: 0 });
    const el = TestUtils.bootstrap(
      `<sonic-shader dataProvider="${id}"></sonic-shader>`,
      true,
    )[0] as SonicShader;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    // sonic-audio-input écoute param0 ; un lecteur frame active vraiment l’out
    const onParam = () => {};
    pub.param0.onAssign(onParam);
    pub.frame.onAssign(() => {});

    // Props GPU locales à 0 ≠ valeurs form — ne doivent pas écraser le DP
    el.param0 = 0;
    el.param1 = 0;
    const internal = el as unknown as {
      lastOutAt: number;
      maybePublishOut: (now: number, time: number) => void;
    };
    internal.lastOutAt = 0;
    internal.maybePublishOut(performance.now(), 1);

    expect(pub.param0.get()).toBe(0.42);
    expect(pub.param1.get()).toBe(0.7);
    pub.param0.offAssign(onParam);
  });

  it("émet error si WebGL2 est indisponible", async () => {
    const onError = vi.fn();
    const el = TestUtils.bootstrap(
      `<sonic-shader style="width:64px;height:64px"></sonic-shader>`,
      true,
    )[0] as SonicShader;
    el.addEventListener("error", onError);
    el.image =
      "void mainImage(out vec4 fragColor, in vec2 fragCoord){ fragColor=vec4(1.0); }";
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    // jsdom / happy-dom: pas de WebGL2 → error au firstUpdated
    if (onError.mock.calls.length > 0) {
      expect(onError.mock.calls[0][0].detail.message).toMatch(/WebGL2/i);
    } else {
      // Environnement avec WebGL2 : l’élément monte sans error
      expect(el.shadowRoot?.querySelector("canvas")).toBeTruthy();
    }
  });

  it("changement de canal → rebindChannels, pas rebuild", async () => {
    const el = TestUtils.bootstrap(
      `<sonic-shader style="width:32px;height:32px"></sonic-shader>`,
      true,
    )[0] as SonicShader;
    el.image =
      "void mainImage(out vec4 fragColor, in vec2 fragCoord){ fragColor=vec4(1.0); }";
    await el.updateComplete;

    const rt = {
      isLost: false,
      setPassChannels: vi.fn(),
      ensureTextures: vi.fn(async () => {}),
      ensureElementTexture: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      setVideosPlaying: vi.fn(),
    };
    const internal = el as unknown as {
      runtime: typeof rt;
      ready: boolean;
      rebuild: () => Promise<void>;
      rebindChannels: () => Promise<void>;
      drawFrame: (now: number) => void;
    };
    internal.runtime = rt;
    internal.ready = true;
    vi.spyOn(internal, "drawFrame").mockImplementation(() => {});

    const rebuildSpy = vi.spyOn(internal, "rebuild");
    const rebindSpy = vi.spyOn(internal, "rebindChannels");
    rebuildSpy.mockClear();
    rebindSpy.mockClear();
    rt.setPassChannels.mockClear();

    el.bufferACh1 = "#autre";
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(rebindSpy).toHaveBeenCalled();
    expect(rt.setPassChannels).toHaveBeenCalled();
  });

  it("release-offscreen=auto : conserve le runtime si self hors écran", async () => {
    const el = TestUtils.bootstrap(
      `<sonic-shader release-offscreen="auto" style="width:32px;height:32px"></sonic-shader>`,
      true,
    )[0] as SonicShader;
    await el.updateComplete;
    expect(el.releaseOffscreen).toBe("auto");

    const dispose = vi.fn();
    const rt = {
      isLost: false,
      dispose,
      setVideosPlaying: vi.fn(),
      setPassChannels: vi.fn(),
      ensureTextures: vi.fn(async () => {}),
      ensureElementTexture: vi.fn(),
      resize: vi.fn(),
    };
    const internal = el as unknown as {
      runtime: typeof rt | null;
      ready: boolean;
      inView: boolean;
      syncVisibility: () => void;
      drawFrame: (now: number) => void;
    };
    internal.runtime = rt;
    internal.ready = true;
    internal.inView = true;
    vi.spyOn(internal, "drawFrame").mockImplementation(() => {});

    el.bufferACh0 = "self";
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    internal.inView = false;
    internal.syncVisibility();
    expect(dispose).not.toHaveBeenCalled();
    expect(internal.runtime).toBe(rt);
  });

  it("release-offscreen=auto : libère hors écran sans self", async () => {
    const el = TestUtils.bootstrap(
      `<sonic-shader release-offscreen="auto" style="width:32px;height:32px"></sonic-shader>`,
      true,
    )[0] as SonicShader;
    await el.updateComplete;
    const dispose = vi.fn();
    const rt = {
      isLost: false,
      dispose,
      setVideosPlaying: vi.fn(),
    };
    const internal = el as unknown as {
      runtime: typeof rt | null;
      ready: boolean;
      inView: boolean;
      syncVisibility: () => void;
      drawFrame: (now: number) => void;
    };
    internal.runtime = rt;
    internal.ready = true;
    internal.inView = false;
    vi.spyOn(internal, "drawFrame").mockImplementation(() => {});
    internal.syncVisibility();
    expect(dispose).toHaveBeenCalledWith(false);
    expect(internal.runtime).toBeNull();
  });

  it("release-offscreen=true : libère même avec self", async () => {
    const el = TestUtils.bootstrap(
      `<sonic-shader release-offscreen style="width:32px;height:32px"></sonic-shader>`,
      true,
    )[0] as SonicShader;
    await el.updateComplete;
    expect(el.releaseOffscreen).toBe(true);

    const dispose = vi.fn();
    const rt = {
      isLost: false,
      dispose,
      setVideosPlaying: vi.fn(),
      setPassChannels: vi.fn(),
      ensureTextures: vi.fn(async () => {}),
      ensureElementTexture: vi.fn(),
      resize: vi.fn(),
    };
    const internal = el as unknown as {
      runtime: typeof rt | null;
      ready: boolean;
      inView: boolean;
      syncVisibility: () => void;
      drawFrame: (now: number) => void;
    };
    internal.runtime = rt;
    internal.ready = true;
    internal.inView = true;
    vi.spyOn(internal, "drawFrame").mockImplementation(() => {});

    el.bufferACh0 = "self";
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    internal.inView = false;
    internal.syncVisibility();
    expect(dispose).toHaveBeenCalledWith(false);
    expect(internal.runtime).toBeNull();
  });
});
