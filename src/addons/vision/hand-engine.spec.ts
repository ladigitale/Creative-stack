import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_SOURCE,
  configureVision,
  createMediaPipeEngine,
  createWorkerEngine,
  resetVisionConfig,
  type HandEngineOptions,
} from "./hand-engine";

const lm = Array.from({ length: 21 }, (_, i) => ({ x: i / 21, y: 0.5, z: 0.1 }));
const MP_RESULT = {
  landmarks: [lm],
  worldLandmarks: [lm],
  handedness: [[{ categoryName: "Right", score: 0.95 }]],
  gestures: [[{ categoryName: "Open_Palm", score: 0.9 }]],
};

const opts = (over: Partial<HandEngineOptions> = {}): HandEngineOptions => ({
  model: new Uint8Array([1, 2, 3]),
  gestures: true,
  maxHands: 2,
  minScore: 0.5,
  delegate: "auto",
  thread: "auto",
  ...over,
});

/** Worker factice : joue le protocole (`init` → `ready`, `detect` → `result`). */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  sent: Array<{ type: string; [k: string]: unknown }> = [];
  terminated = false;
  constructor(private behavior: { init?: "ok" | "error" | "silent"; detect?: "ok" | "error" | "silent" } = {}) {}
  postMessage(m: { type: string; id?: number }) {
    this.sent.push(m);
    const reply = (data: unknown) => queueMicrotask(() => this.onmessage?.({ data } as MessageEvent));
    if (m.type === "init") {
      const b = this.behavior.init ?? "ok";
      if (b === "ok") reply({ type: "ready", backend: "gpu" });
      if (b === "error") reply({ type: "error", message: "wasm introuvable" });
    } else if (m.type === "detect") {
      const b = this.behavior.detect ?? "ok";
      if (b === "ok") reply({ type: "result", id: m.id, result: MP_RESULT });
      if (b === "error") reply({ type: "error", id: m.id, message: "gpu perdu" });
    }
  }
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  resetVisionConfig();
  vi.unstubAllGlobals();
});

function stubBitmap() {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", async () => ({ close }));
}

describe("createWorkerEngine", () => {
  it("initialise, détecte hors du fil principal et convertit le résultat", async () => {
    stubBitmap();
    const w = new FakeWorker();
    configureVision({ createWorker: () => w as unknown as Worker });
    const engine = await createWorkerEngine(opts());
    expect(engine).toMatchObject({ thread: "worker", backend: "gpu" });
    const init = w.sent[0] as unknown as { type: string; model: Uint8Array; bundleUrl: string; gestures: boolean };
    expect(init.type).toBe("init");
    expect(init.model).toBeInstanceOf(Uint8Array);
    expect(init.bundleUrl).toContain("@mediapipe/tasks-vision@0.10.21");
    const hands = await engine.detect({} as CanvasImageSource, 10);
    expect(hands).toHaveLength(1);
    expect(hands[0]).toMatchObject({ label: "Right", gesture: "Open_Palm", score: 0.95 });
    expect(hands[0].landmarks).toHaveLength(21);
    engine.close();
    expect(w.terminated).toBe(true);
    await expect(engine.detect({} as CanvasImageSource, 20)).rejects.toThrow();
  });

  it("le buffer de l'appelant reste utilisable (repli possible)", async () => {
    const w = new FakeWorker();
    configureVision({ createWorker: () => w as unknown as Worker });
    const o = opts();
    await createWorkerEngine(o);
    expect(o.model.byteLength).toBe(3);
  });

  it("échec d'initialisation : rejet et worker terminé", async () => {
    const w = new FakeWorker({ init: "error" });
    configureVision({ createWorker: () => w as unknown as Worker });
    await expect(createWorkerEngine(opts())).rejects.toThrow("wasm introuvable");
    expect(w.terminated).toBe(true);
  });

  it("initialisation sans réponse : délai dépassé", async () => {
    const w = new FakeWorker({ init: "silent" });
    configureVision({ createWorker: () => w as unknown as Worker, initTimeoutMs: 20 });
    await expect(createWorkerEngine(opts())).rejects.toThrow("trop longue");
    expect(w.terminated).toBe(true);
  });

  it("erreur de détection propagée ; détection muette : délai dépassé", async () => {
    stubBitmap();
    const w = new FakeWorker({ detect: "error" });
    configureVision({ createWorker: () => w as unknown as Worker, detectTimeoutMs: 20 });
    const engine = await createWorkerEngine(opts());
    await expect(engine.detect({} as CanvasImageSource, 1)).rejects.toThrow("gpu perdu");
    const w2 = new FakeWorker({ detect: "silent" });
    configureVision({ createWorker: () => w2 as unknown as Worker });
    const engine2 = await createWorkerEngine(opts());
    await expect(engine2.detect({} as CanvasImageSource, 1)).rejects.toThrow("trop longue");
  });

  it("environnement sans Worker / OffscreenCanvas : erreur claire", async () => {
    await expect(createWorkerEngine(opts())).rejects.toThrow(/indisponible/);
  });
});

describe("createMediaPipeEngine : repli", () => {
  it("thread=worker : pas de repli", async () => {
    const w = new FakeWorker({ init: "error" });
    configureVision({ createWorker: () => w as unknown as Worker });
    await expect(createMediaPipeEngine(opts({ thread: "worker" }))).rejects.toThrow("wasm introuvable");
  });

  it("thread=auto : repli sur le fil principal quand le worker échoue", async () => {
    const w = new FakeWorker({ init: "error" });
    const moduleSrc =
      "export const FilesetResolver={forVisionTasks:async()=>({})};" +
      "const T={createFromOptions:async()=>({detectForVideo:()=>({landmarks:[]}),close(){}})};" +
      "export const HandLandmarker=T;export const GestureRecognizer=T;";
    configureVision({
      createWorker: () => w as unknown as Worker,
      mediapipeBundleUrl: `data:text/javascript,${encodeURIComponent(moduleSrc)}`,
    });
    const engine = await createMediaPipeEngine(opts());
    expect(engine.thread).toBe("main");
    expect(w.terminated).toBe(true);
    expect(await engine.detect({} as CanvasImageSource, 1)).toEqual([]);
  });
});

describe("WORKER_SOURCE (script du worker)", () => {
  /** Exécute le script avec un faux `self` et un faux `import()` (le test seul remplace `import(`). */
  function boot(mpModule: unknown) {
    const posted: unknown[] = [];
    const self: { onmessage?: (e: { data: unknown }) => Promise<void>; postMessage: (m: unknown) => void } = {
      postMessage: (m) => void posted.push(m),
    };
    const importHook = vi.fn(async () => mpModule);
    new Function("self", "importHook", WORKER_SOURCE.replace("import(", "importHook("))(self, importHook);
    return { self, posted, importHook };
  }

  const task = () => ({ detectForVideo: vi.fn(() => ({ ...MP_RESULT, close: () => {} })), close: vi.fn() });

  it("init : charge le bundle, crée la tâche avec le buffer, répond ready", async () => {
    const t = task();
    const create = vi.fn(async (_fileset: unknown, _options: unknown) => t);
    const mp = {
      FilesetResolver: { forVisionTasks: vi.fn(async () => ({})) },
      GestureRecognizer: { createFromOptions: create },
      HandLandmarker: { createFromOptions: vi.fn() },
    };
    const { self, posted, importHook } = boot(mp);
    await self.onmessage!({ data: { type: "init", bundleUrl: "https://x/b.mjs", wasmUrl: "https://x/wasm", model: new Uint8Array([9]), gestures: true, maxHands: 2, minScore: 0.5, delegate: "gpu" } });
    expect(importHook).toHaveBeenCalledWith("https://x/b.mjs");
    expect(create.mock.calls[0][1]).toMatchObject({ runningMode: "VIDEO", numHands: 2, baseOptions: { delegate: "GPU" } });
    expect(posted).toEqual([{ type: "ready", backend: "gpu" }]);
  });

  it("GPU refusé en delegate=auto : repli CPU ; en delegate=gpu : erreur", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("no gl")).mockResolvedValueOnce(task());
    const mp = { FilesetResolver: { forVisionTasks: async () => ({}) }, GestureRecognizer: { createFromOptions: create }, HandLandmarker: { createFromOptions: create } };
    const a = boot(mp);
    await a.self.onmessage!({ data: { type: "init", bundleUrl: "u", wasmUrl: "w", model: new Uint8Array(1), gestures: true, maxHands: 1, minScore: 0.5, delegate: "auto" } });
    expect(a.posted).toEqual([{ type: "ready", backend: "cpu" }]);

    const create2 = vi.fn().mockRejectedValue(new Error("no gl"));
    const b = boot({ ...mp, GestureRecognizer: { createFromOptions: create2 } });
    await b.self.onmessage!({ data: { type: "init", bundleUrl: "u", wasmUrl: "w", model: new Uint8Array(1), gestures: true, maxHands: 1, minScore: 0.5, delegate: "gpu" } });
    expect(b.posted).toEqual([{ type: "error", id: undefined, message: "no gl" }]);
  });

  it("detect : renvoie un résultat simple (clonable) et ferme l'image", async () => {
    const t = task();
    const mp = { FilesetResolver: { forVisionTasks: async () => ({}) }, HandLandmarker: { createFromOptions: async () => t }, GestureRecognizer: { createFromOptions: async () => t } };
    const { self, posted } = boot(mp);
    await self.onmessage!({ data: { type: "init", bundleUrl: "u", wasmUrl: "w", model: new Uint8Array(1), gestures: false, maxHands: 2, minScore: 0.5, delegate: "cpu" } });
    const bitmap = { close: vi.fn() };
    await self.onmessage!({ data: { type: "detect", id: 7, ts: 100, bitmap } });
    expect(t.detectForVideo).toHaveBeenCalledWith(bitmap, 100);
    expect(bitmap.close).toHaveBeenCalled();
    const res = posted[1] as { type: string; id: number; result: { landmarks: unknown[][] } };
    expect(res).toMatchObject({ type: "result", id: 7 });
    expect(JSON.parse(JSON.stringify(res.result)).landmarks[0]).toHaveLength(21);
    expect(typeof (res.result as Record<string, unknown>).close).toBe("undefined");
  });

  it("detect avant init : erreur rapportée avec l'id, image fermée", async () => {
    const { self, posted } = boot({});
    const bitmap = { close: vi.fn() };
    await self.onmessage!({ data: { type: "detect", id: 3, ts: 1, bitmap } });
    expect(posted[0]).toMatchObject({ type: "error", id: 3 });
    expect(bitmap.close).toHaveBeenCalled();
  });
});
