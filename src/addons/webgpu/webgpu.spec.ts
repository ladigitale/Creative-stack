import { expect, describe, it, vi, beforeAll } from "vitest";
import TestUtils from "@supersoniks/concorde/test-utils/TestUtils";
import { buildWgslSource, DEFAULT_MAIN_IMAGE } from "./wgsl-prelude";
import { channelTextureNeedsRecreate } from "./gpu-runtime";
import { channelFormValue } from "./helpers";
import "./webgpu";
import { SonicWebGpu } from "./webgpu";

describe("buildWgslSource", () => {
  it("injecte prelude + mainImage", () => {
    const src = buildWgslSource(
      "fn mainImage(uv: vec2f, fragCoord: vec2f) -> vec4f { _ = fragCoord; return iChannel0(uv); }",
    );
    expect(src).toContain("struct SonicUniforms");
    expect(src).toContain("fn iChannel0");
    expect(src).toContain("fn vs_main");
    expect(src).toContain("fn fs_main");
    expect(src).toContain("fn mainImage");
  });

  it("utilise le défaut si corps vide", () => {
    const src = buildWgslSource("");
    expect(src).toContain(DEFAULT_MAIN_IMAGE.slice(0, 20));
  });

  it("refuse un corps sans mainImage", () => {
    expect(() => buildWgslSource("fn other() -> vec4f { return vec4f(1.0); }")).toThrow(
      /mainImage/,
    );
  });
});

describe("channelTextureNeedsRecreate", () => {
  it("recrée si absent ou taille différente", () => {
    expect(channelTextureNeedsRecreate(null, 64, 64)).toBe(true);
    expect(channelTextureNeedsRecreate({ width: 32, height: 64 }, 64, 64)).toBe(
      true,
    );
    expect(channelTextureNeedsRecreate({ width: 64, height: 64 }, 64, 64)).toBe(
      false,
    );
  });
});

describe("channelFormValue", () => {
  it("accepte url / #id / { element }", () => {
    expect(channelFormValue("https://x/a.png")).toBe("https://x/a.png");
    expect(channelFormValue("#plateau")).toBe("#plateau");
    expect(channelFormValue({ element: "#plateau" })).toBe("#plateau");
    expect(channelFormValue({ element: "scene" })).toBe("#scene");
    expect(channelFormValue({ url: "https://x/a.png" })).toBe(
      "https://x/a.png",
    );
  });
});

describe("sonic-webgpu", () => {
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
    expect(customElements.get("sonic-webgpu")).toBe(SonicWebGpu);
  });

  it("applique param0…3 et canaux depuis dataProvider", async () => {
    const { PublisherManager } = await import(
      "@supersoniks/concorde/utils"
    );
    const id = "webgpu-form-test";
    const pub = PublisherManager.get(id);
    pub.set({
      param0: 0.11,
      param1: 0.22,
      channel0: { url: "https://example.test/a.png" },
      channel1: "https://example.test/b.png",
      channel2: { element: "#plateau" },
    });
    const el = TestUtils.bootstrap(
      `<sonic-webgpu dataProvider="${id}"></sonic-webgpu>`,
      true,
    )[0] as SonicWebGpu;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(el.param0).toBe(0.11);
    expect(el.param1).toBe(0.22);
    expect(el.channel0).toBe("https://example.test/a.png");
    expect(el.channel1).toBe("https://example.test/b.png");
    expect(el.channel2).toBe("#plateau");

    pub.param0.set(0.99);
    await new Promise((r) => setTimeout(r, 0));
    expect(el.param0).toBe(0.99);
  });

  it("lit targetX/targetY depuis dataProvider (tracking)", async () => {
    const { PublisherManager } = await import(
      "@supersoniks/concorde/utils"
    );
    const id = "webgpu-target-test";
    const pub = PublisherManager.get(id);
    pub.set({
      param0: 0.4,
      param1: 0.8,
      targetX: 0.25,
      targetY: 0.75,
    });
    const el = TestUtils.bootstrap(
      `<sonic-webgpu dataProvider="${id}" kernel="particles" mouse="false"></sonic-webgpu>`,
      true,
    )[0] as SonicWebGpu;
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    const data = pub.get() as { targetX?: number; targetY?: number };
    expect(data.targetX).toBe(0.25);
    expect(data.targetY).toBe(0.75);
    expect(el.param0).toBe(0.4);
    expect(el.param1).toBe(0.8);
  });

  it("émet error si aucun backend (sinon accepte canvas2d)", async () => {
    const onError = vi.fn();
    const el = TestUtils.bootstrap(
      `<sonic-webgpu style="width:64px;height:64px"></sonic-webgpu>`,
      true,
    )[0] as SonicWebGpu;
    el.addEventListener("error", onError);
    el.shader =
      "fn mainImage(uv: vec2f, fragCoord: vec2f) -> vec4f { _ = fragCoord; return vec4f(uv, 0.0, 1.0); }";
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 30));

    if (onError.mock.calls.length > 0) {
      expect(onError.mock.calls[0][0].detail.message).toMatch(
        /WebGPU|WebGL2|Canvas2D/i,
      );
    } else {
      // Environnement avec GPU : canvas monté
      expect(el.shadowRoot?.querySelector("canvas")).toBeTruthy();
      expect(["webgpu", "webgl2", "canvas2d"]).toContain(el.activeBackend);
    }
  });

  it("parseBackendPrefer", async () => {
    const { parseBackendPrefer } = await import("./types");
    expect(parseBackendPrefer("auto")).toBe("auto");
    expect(parseBackendPrefer("webgl2")).toBe("webgl2");
    expect(parseBackendPrefer("nope")).toBe("auto");
  });

  it("expose getFrameCanvas + frameSeq (SonicFrameSource)", () => {
    const el = TestUtils.bootstrap(
      `<sonic-webgpu></sonic-webgpu>`,
      true,
    )[0] as SonicWebGpu;
    expect(typeof el.getFrameCanvas).toBe("function");
    expect(typeof el.frameSeq).toBe("number");
  });
});
