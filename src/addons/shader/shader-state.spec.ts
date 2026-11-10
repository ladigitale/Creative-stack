import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import TestUtils from "@supersoniks/concorde/test-utils/TestUtils";
import { PublisherManager } from "@supersoniks/concorde/utils";
import { ShaderToyRuntime } from "./gl-runtime";
import { buildFragmentSource } from "./shadertoy-prelude";
import { describeShaderError, mapGlslLine, parseGlslInfoLog } from "./errors";
import { readShaderParams, MAX_SOURCE_CHARS } from "./state";
import { ShaderCompileError, type ShaderSources } from "./types";
import "./shader";
import type { SonicShader } from "./shader";

/** Ligne (1-based) de la première occurrence de `marker` dans `src`. */
function lineOf(src: string, marker: string): number {
  return src.slice(0, src.indexOf(marker)).split("\n").length;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("erreurs GLSL : lignes ramenées à la source de l'utilisateur", () => {
  const common = "float helper(float x) {\n  return x * MARK_COMMON;\n}";
  const image = "void mainImage(out vec4 c, in vec2 p) {\n  float a = 1.0;\n  c = vec4(MARK_IMAGE);\n}";
  const full = buildFragmentSource(common, image);

  it("mapGlslLine : passe, common et prélude", () => {
    expect(mapGlslLine(lineOf(full, "MARK_IMAGE"), "image", common)).toEqual({ pass: "image", line: 3 });
    expect(mapGlslLine(lineOf(full, "MARK_COMMON"), "bufferA", common)).toEqual({ pass: "common", line: 2 });
    expect(mapGlslLine(2, "image", common).pass).toBe("prelude");
    // Sans common
    const bare = buildFragmentSource("", image);
    expect(mapGlslLine(lineOf(bare, "MARK_IMAGE"), "image", "")).toEqual({ pass: "image", line: 3 });
  });

  it("parseGlslInfoLog : format ANGLE, bruit filtré, avertissements ignorés", () => {
    const n = lineOf(full, "MARK_IMAGE");
    const log = [
      `WARNING: 0:${n}: 'x' : something`,
      `ERROR: 0:${n}: 'MARK_IMAGE' : undeclared identifier`,
      `ERROR: 0:${n}: '' : compilation terminated`,
      "ERROR: 2 compilation errors.  No code generated.",
    ].join("\n");
    expect(parseGlslInfoLog(log, "image", common)).toEqual([
      { pass: "image", line: 3, column: null, message: "'MARK_IMAGE' : undeclared identifier" },
    ]);
  });

  it("parseGlslInfoLog : format Mesa avec colonne", () => {
    const n = lineOf(full, "MARK_COMMON");
    const out = parseGlslInfoLog(`0:${n}(14): error: \`MARK_COMMON' undeclared`, "bufferB", common);
    expect(out).toEqual([{ pass: "common", line: 2, column: 14, message: "`MARK_COMMON' undeclared" }]);
  });

  it("describeShaderError : toutes les passes fautives, message lisible", () => {
    const fullA = buildFragmentSource("", "void mainImage(out vec4 c, in vec2 p){\n  c = BAD_A;\n}");
    const err = new ShaderCompileError("Compile error (bufferA): …", "bufferA", "");
    err.passErrors = [
      { pass: "bufferA", kind: "compile", message: "Compile error (bufferA)", infoLog: `ERROR: 0:${lineOf(fullA, "BAD_A")}: 'BAD_A' : undeclared identifier` },
      { pass: "image", kind: "link", message: "Link error (image)", infoLog: "varying mismatch" },
    ];
    const d = describeShaderError(err, "");
    expect(d.error).toBe("buffer A, ligne 2 : 'BAD_A' : undeclared identifier");
    expect(d.errors).toHaveLength(2);
    expect(d.errors[1]).toMatchObject({ pass: "image", line: null });
    expect(d.errors[1].message).toMatch(/liens/);
  });

  it("describeShaderError : erreur hors compilation", () => {
    const d = describeShaderError(new Error("WebGL2 not available"), "");
    expect(d).toEqual({
      error: "WebGL2 not available",
      errors: [{ pass: "runtime", line: null, column: null, message: "WebGL2 not available" }],
    });
  });
});

describe("ShaderToyRuntime.setSources : erreurs de toutes les passes", () => {
  it("compile chaque passe, lève l'erreur de la première avec passErrors", () => {
    const gl = {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      isContextLost: () => false,
      createShader: () => ({ src: "" }),
      shaderSource: (sh: { src: string }, src: string) => { sh.src = src; },
      compileShader: () => {},
      getShaderParameter: (sh: { src: string }) => !/BAD_/.test(sh.src),
      getShaderInfoLog: (sh: { src: string }) => {
        const m = /BAD_\w+/.exec(sh.src)?.[0] ?? "";
        return `ERROR: 0:${lineOf(sh.src, m)}: '${m}' : undeclared identifier\n`;
      },
      deleteShader: () => {},
      createProgram: () => ({}),
      attachShader: () => {},
      linkProgram: () => {},
      getProgramParameter: () => true,
      deleteProgram: () => {},
      getUniformLocation: () => null,
    };
    const fake = {
      gl,
      programs: new Map(),
      buffers: new Map(),
      activePasses: [] as string[],
      width: 0,
      height: 0,
      disposePrograms: () => {},
    };
    const sources: ShaderSources = {
      common: "",
      image: "void mainImage(out vec4 c, in vec2 p){\n\n  c = BAD_IMG;\n}",
      bufferA: "void mainImage(out vec4 c, in vec2 p){\n  c = BAD_A;\n}",
      bufferB: "void mainImage(out vec4 c, in vec2 p){ c = vec4(1.0); }",
      bufferC: "",
      bufferD: "",
    };
    let caught: unknown;
    try {
      ShaderToyRuntime.prototype.setSources.call(fake as never, sources, new Map());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ShaderCompileError);
    const err = caught as ShaderCompileError;
    // Première passe fautive dans l'ordre de rendu : message et pass inchangés.
    expect(err.pass).toBe("bufferA");
    expect(err.message).toMatch(/^Compile error \(bufferA\)/);
    expect(err.passErrors?.map((p) => p.pass)).toEqual(["bufferA", "image"]);
    expect(fake.activePasses).toEqual(["bufferB"]);
    const d = describeShaderError(err, "");
    expect(d.errors.map((e) => [e.pass, e.line])).toEqual([["bufferA", 2], ["image", 3]]);
  });
});

describe("readShaderParams", () => {
  it("borne, accepte les booléens tolérants, refuse l'invalide", () => {
    const { live, invalid } = readShaderParams({
      play: 0,
      playOnHover: "true",
      mouse: "peut-être",
      mouseMode: "target",
      mouseSpeed: 500,
      hoverSpeed: -3,
      dprMax: 9,
      bufferFormat: "half",
      image: "void mainImage(out vec4 c, in vec2 p){ c = vec4(1.0); }",
      bufferA: 42,
      common: "x".repeat(MAX_SOURCE_CHARS + 1),
    });
    expect(live).toMatchObject({
      play: false,
      playOnHover: true,
      mouseMode: "target",
      mouseSpeed: 100,
      hoverSpeed: 0,
      dprMax: 4,
      bufferFormat: "rgba16f",
    });
    expect(live.image).toMatch(/mainImage/);
    expect(live.mouse).toBeUndefined();
    expect(invalid.sort()).toEqual(["bufferA", "common", "mouse"]);
    expect(readShaderParams({ mouseMode: "zigzag", bufferFormat: "nope" }).invalid).toEqual(["mouseMode", "bufferFormat"]);
    expect(readShaderParams(null)).toEqual({ live: {}, invalid: [] });
    // image vide : ignorée (l'attribut reste) ; buffer vide : retire la passe
    expect(readShaderParams({ image: "  ", bufferA: "" })).toEqual({ live: { bufferA: "" }, invalid: [] });
  });
});

type FakeRuntime = {
  isLost: boolean;
  size: { width: number; height: number };
  setBufferFormat: (f: string) => string;
  ensureTextures: ReturnType<typeof vi.fn>;
  ensureElementTexture: ReturnType<typeof vi.fn>;
  setSources: ReturnType<typeof vi.fn>;
  setPassChannels: ReturnType<typeof vi.fn>;
  getActivePasses: () => string[];
  getTextureSize: () => null;
  resize: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setVideosPlaying: ReturnType<typeof vi.fn>;
};

function fakeRuntime(): FakeRuntime {
  return {
    isLost: false,
    size: { width: 32, height: 32 },
    setBufferFormat: (f: string) => f,
    ensureTextures: vi.fn(async () => {}),
    ensureElementTexture: vi.fn(),
    setSources: vi.fn(),
    setPassChannels: vi.fn(),
    getActivePasses: () => ["image"],
    getTextureSize: () => null,
    resize: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
    setVideosPlaying: vi.fn(),
  };
}

type Internal = {
  runtime: FakeRuntime | null;
  rebuild: () => Promise<void>;
  shouldAnimate: () => boolean;
  effDprMax: number;
  inView: boolean;
};

const OK_IMAGE = "void mainImage(out vec4 c, in vec2 p){ c = vec4(1.0); }";

describe("sonic-shader : état publié et pilotage par params", () => {
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
  });

  function mount(attrs: string): { el: SonicShader; internal: Internal; rt: FakeRuntime } {
    const el = TestUtils.bootstrap(`<sonic-shader style="width:32px;height:32px" ${attrs}></sonic-shader>`, true)[0] as SonicShader;
    const internal = el as unknown as Internal;
    const rt = fakeRuntime();
    return { el, internal, rt };
  }

  it("control : écouté avant que le runtime existe, premier `save: 1` (clé absente au départ) → save()", async () => {
    const ctl = "shader-state-ctl";
    PublisherManager.get(ctl).set({ n: 0 });
    const { el } = mount(`control="${ctl}"`);
    await el.updateComplete;
    const calls: number[] = [];
    (el as unknown as { save: () => Promise<null> }).save = async () => { calls.push(1); return null; };
    PublisherManager.get(ctl).set({ n: 0, save: 1 });
    await Promise.resolve();
    expect(calls.length).toBe(1);
    PublisherManager.get(ctl).set({ n: 1, save: 1 });
    await Promise.resolve();
    expect(calls.length).toBe(1);
    PublisherManager.get(ctl).set({ n: 1, save: 2 });
    await Promise.resolve();
    expect(calls.length).toBe(2);
  });

  it("publie idle, compiling puis ready dans le DP de sortie (sans écraser le reste)", async () => {
    const out = "shader-state-out";
    PublisherManager.get(out).set({ keep: 1 });
    const { el, internal, rt } = mount(`out-data-provider="${out}"`);
    await el.updateComplete;
    expect(PublisherManager.get(out).get()).toMatchObject({ keep: 1, status: "idle", error: null, errors: [] });

    const seen: string[] = [];
    el.addEventListener("shader-state", (e) => seen.push((e as CustomEvent).detail.status));
    el.image = OK_IMAGE;
    await el.updateComplete;
    internal.runtime = rt;
    await internal.rebuild();
    expect(seen).toContain("compiling");
    expect(el.stateValue).toMatchObject({ status: "ready", error: null, passes: ["image"] });
    expect(PublisherManager.get(out).get()).toMatchObject({ keep: 1, status: "ready", passes: ["image"] });
  });

  it("erreur de compilation : status error, error lisible, errors[] et event error conservé", async () => {
    const out = "shader-state-err";
    const { el, internal, rt } = mount(`out-data-provider="${out}"`);
    el.image = "void mainImage(out vec4 c, in vec2 p){\n  c = OUPS;\n}";
    await el.updateComplete;
    const full = buildFragmentSource("", el.image);
    rt.setSources.mockImplementation(() => {
      throw new ShaderCompileError(
        "Compile error (image): …",
        "image",
        `ERROR: 0:${lineOf(full, "OUPS")}: 'OUPS' : undeclared identifier`,
      );
    });
    const onError = vi.fn();
    el.addEventListener("error", onError);
    internal.runtime = rt;
    await internal.rebuild();
    const st = PublisherManager.get(out).get() as Record<string, unknown>;
    expect(st.status).toBe("error");
    expect(st.error).toBe("image, ligne 2 : 'OUPS' : undeclared identifier");
    expect(st.errors).toEqual([{ pass: "image", line: 2, column: null, message: "'OUPS' : undeclared identifier" }]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].detail).toMatchObject({ pass: "image", message: "Compile error (image): …" });
    // L'erreur reste aussi à l'écran (comportement historique)
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".err")?.textContent).toMatch(/Compile error/);

    // Correction → ready, erreurs effacées
    rt.setSources.mockImplementation(() => {});
    await internal.rebuild();
    expect(PublisherManager.get(out).get()).toMatchObject({ status: "ready", error: null, errors: [] });
  });

  it("dataProvider partagé (form + out) : état publié, param0…3 intacts", async () => {
    const id = "shader-state-shared";
    PublisherManager.get(id).set({ param0: 0.42 });
    const { el } = mount(`dataProvider="${id}"`);
    await el.updateComplete;
    await tick();
    expect(PublisherManager.get(id).get()).toMatchObject({ param0: 0.42, status: "idle" });
    expect(el.param0).toBe(0.42);
  });

  it("params : play / playOnHover / mouse / mouseMode / dprMax en direct, prioritaires sur les attributs", async () => {
    const params = "shader-live-params";
    PublisherManager.get(params).set({});
    const { el, internal, rt } = mount(`params="${params}" dpr-max="1.5"`);
    el.image = OK_IMAGE;
    await el.updateComplete;
    internal.runtime = rt;
    await internal.rebuild();
    internal.inView = true;
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) expect(internal.shouldAnimate()).toBe(true);
    expect(internal.effDprMax).toBe(1.5);

    PublisherManager.get(params).set({ play: false, dprMax: 1, mouse: false, mouseMode: "target" });
    await tick();
    expect(internal.shouldAnimate()).toBe(false);
    expect(el.stateValue.playing).toBe(false);
    expect(internal.effDprMax).toBe(1);
    expect(el.play).toBe(true); // l'attribut n'est pas réécrit
    expect(el.hasAttribute("play")).toBe(true);
    const lastResize = rt.resize.mock.calls.at(-1);
    expect(lastResize).toBeTruthy();

    // Clé retirée → l'attribut reprend la main
    PublisherManager.get(params).set({ dprMax: 1 });
    await tick();
    if (!reduced) expect(internal.shouldAnimate()).toBe(true);
    el.remove();
  });

  it("params : nouvelle source image → recompilation regroupée", async () => {
    const params = "shader-live-src";
    PublisherManager.get(params).set({});
    const { el, internal, rt } = mount(`params="${params}"`);
    el.image = OK_IMAGE;
    await el.updateComplete;
    internal.runtime = rt;
    await internal.rebuild();
    rt.setSources.mockClear();

    const src2 = "void mainImage(out vec4 c, in vec2 p){ c = vec4(0.5); }";
    PublisherManager.get(params).set({ image: "void mainImage(out vec4 c, in vec2 p){ c = vec4(0.4); }" });
    PublisherManager.get(params).set({ image: src2 });
    await tick(200);
    expect(rt.setSources).toHaveBeenCalledOnce();
    expect(rt.setSources.mock.calls[0][0].image).toBe(src2);
    expect(el.image).toBe(OK_IMAGE); // la propriété n'est pas réécrite

    // Même source : pas de recompilation
    rt.setSources.mockClear();
    PublisherManager.get(params).set({ image: src2, play: true });
    await tick(200);
    expect(rt.setSources).not.toHaveBeenCalled();
    el.remove();
  });
});
