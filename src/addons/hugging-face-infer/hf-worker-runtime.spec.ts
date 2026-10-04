import { describe, expect, it } from "vitest";
import { buildHfWorkerSource, hfWorkerMain, type HfLibrary } from "./hf-worker-runtime";

class FakeTensor {
  constructor(
    private rows: number[][],
    public dims = [rows.length, rows[0]?.length ?? 0],
  ) {}
  tolist() {
    return this.rows;
  }
}

function harness(lib: HfLibrary) {
  const sent: unknown[] = [];
  let listener: (event: { data: unknown }) => void = () => {};
  hfWorkerMain(lib, {
    postMessage: (m) => sent.push(m),
    addEventListener: (_t, l) => (listener = l),
  });
  let id = 0;
  const request = async (body: Record<string, unknown>) => {
    const myId = ++id;
    listener({ data: { ...body, id: myId } });
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 1));
      const reply = sent.find((m) => (m as { id?: number }).id === myId);
      if (reply) return reply as { ok: boolean; result?: unknown; error?: { code: string } };
    }
    throw new Error("pas de réponse");
  };
  return { request, sent };
}

function fakeLib(): HfLibrary & { created: unknown[] } {
  const created: unknown[] = [];
  const lib = {
    created,
    env: { backends: { onnx: { wasm: {} } } } as HfLibrary["env"],
    async pipeline(task: string, model: string, options?: Record<string, unknown>) {
      created.push({ task, model, options });
      (options?.progress_callback as (i: unknown) => void)?.({
        status: "progress_total",
        loaded: 5,
        total: 10,
        progress: 50,
      });
      const pipe = async (input: unknown, a?: unknown, b?: unknown) => {
        if (task === "feature-extraction") {
          const texts = Array.isArray(input) ? input : [input];
          return new FakeTensor(texts.map((t) => [String(t).length, 1]));
        }
        if (task === "zero-shot-classification") {
          return { sequence: input, labels: a, scores: [0.9, 0.1], opts: b };
        }
        return { input };
      };
      return pipe;
    },
  };
  return lib;
}

describe("hfWorkerMain", () => {
  it("configure l'environnement de Transformers.js (cache, hôte, WASM)", async () => {
    const lib = fakeLib();
    const { request } = harness(lib);
    await request({
      type: "configure",
      env: { cacheKey: "concorde-hf-4.3.0", remoteHost: "https://cdn/models/", wasmPaths: "https://cdn/rt/" },
    });
    expect(lib.env).toMatchObject({
      allowLocalModels: false,
      useBrowserCache: true,
      useWasmCache: true,
      cacheKey: "concorde-hf-4.3.0",
      remoteHost: "https://cdn/models/",
    });
    expect(lib.env.backends?.onnx?.wasm?.wasmPaths).toEqual({
      mjs: "https://cdn/rt/ort-wasm-simd-threaded.asyncify.mjs",
      wasm: "https://cdn/rt/ort-wasm-simd-threaded.asyncify.wasm",
    });
  });

  it("repli WASM quand WebGPU manque, progression relayée", async () => {
    const lib = fakeLib();
    const { request, sent } = harness(lib);
    const model = { alias: "m", task: "feature-extraction", repo: "r", revision: "sha", options: { dtype: "q8" } };
    const reply = await request({ type: "load", model, devices: ["webgpu", "wasm"] });
    expect(reply).toMatchObject({ ok: true, result: { backend: "wasm" } });
    expect(lib.created[0]).toMatchObject({ options: { device: "wasm", revision: "sha", dtype: "q8" } });
    expect(sent).toContainEqual({
      type: "progress",
      alias: "m",
      progress: { loadedBytes: 5, totalBytes: 10, percent: 50 },
    });
  });

  it("aucun backend autorisé utilisable → unsupported", async () => {
    const { request } = harness(fakeLib());
    const model = { alias: "m", task: "feature-extraction", repo: "r", revision: "sha", options: {} };
    const reply = await request({ type: "load", model, devices: ["webgpu"] });
    expect(reply).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("run : lot d'embeddings sérialisé, argument positionnel replacé", async () => {
    const { request } = harness(fakeLib());
    const fe = { alias: "fe", task: "feature-extraction", repo: "r", revision: "s", options: {} };
    const zs = { alias: "zs", task: "zero-shot-classification", repo: "r", revision: "s", options: {} };
    await request({ type: "load", model: fe, devices: ["wasm"] });
    await request({ type: "load", model: zs, devices: ["wasm"] });
    const batch = await request({
      type: "run",
      request: { alias: "fe", inputs: ["ab", "abc"], call: { pooling: "mean" }, batch: true },
    });
    expect(batch.result).toEqual([
      [2, 1],
      [3, 1],
    ]);
    const single = await request({
      type: "run",
      request: { alias: "fe", inputs: ["abcd"], call: {}, batch: false },
    });
    expect(single.result).toEqual([[4, 1]]);
    const labels = await request({
      type: "run",
      request: {
        alias: "zs",
        inputs: ["drôle"],
        call: { candidate_labels: ["humour", "drame"], multi_label: true },
        positional: "candidate_labels",
        batch: false,
      },
    });
    expect(labels.result).toEqual([
      { sequence: "drôle", labels: ["humour", "drame"], scores: [0.9, 0.1], opts: { multi_label: true } },
    ]);
  });

  it("la source du worker blob est autonome et syntaxiquement valide", () => {
    const source = buildHfWorkerSource("https://cdn/hf/4.3.0/transformers.min.js");
    expect(source).toContain('await import("https://cdn/hf/4.3.0/transformers.min.js")');
    // Vérifie la syntaxe (module avec top-level await) sans l'exécuter.
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    expect(() => new AsyncFunction(source.replace(/\bself\b/g, "globalThis"))).not.toThrow();
  });
});
