import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { trace, type RGBA } from "./trace";
import { VECTORIZE_WORKER_SOURCE } from "./worker-source";
import { SupersededError, TraceRunner } from "./worker-client";

function image(w: number, h: number): RGBA {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = x > 10 && x < 30 && y > 8 && y < 24;
    data.set(inside ? [200, 30, 30, 255] : [250, 250, 250, 255], i);
  }
  return { width: w, height: h, data };
}

/** Installe un faux Worker et des URL blob: le temps d'un test. */
function withFakeWorker() {
  const g = globalThis as unknown as { Worker?: unknown };
  const prev = { worker: g.Worker, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  g.Worker = FakeWorker;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  return () => {
    g.Worker = prev.worker;
    URL.createObjectURL = prev.create;
    URL.revokeObjectURL = prev.revoke;
  };
}

/** Faux Worker : exécute le script généré dans une portée isolée, de façon asynchrone. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  private scope: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
  constructor() {
    this.scope = { onmessage: null, postMessage: (m) => setTimeout(() => !this.terminated && this.onmessage?.({ data: m } as MessageEvent)) };
    new Function("self", VECTORIZE_WORKER_SOURCE)(this.scope);
  }
  postMessage(m: unknown) { setTimeout(() => !this.terminated && this.scope.onmessage?.({ data: m })); }
  terminate() { this.terminated = true; }
}

describe("vectorize : Web Worker", () => {
  it("le script du worker est à jour avec trace.ts", () => {
    const script = resolve(process.cwd(), "scripts/build-vectorize-worker.mjs");
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("le script généré donne le même résultat que le tracé direct", async () => {
    const restore = withFakeWorker();
    try {
      const runner = new TraceRunner(true);
      const img = image(40, 32);
      const r = await runner.run(img, { colors: 2, curves: true });
      expect(runner.engine).toBe("worker");
      expect(r).toEqual(trace(img, { colors: 2, curves: true }));
      runner.dispose();
    } finally {
      restore();
    }
  });

  it("une nouvelle demande remplace la précédente", async () => {
    const restore = withFakeWorker();
    try {
      const runner = new TraceRunner(true);
      const first = runner.run(image(40, 32), { colors: 2 });
      const second = runner.run(image(40, 32), { colors: 3 });
      await expect(first).rejects.toBeInstanceOf(SupersededError);
      await expect(second).resolves.toMatchObject({ width: 40 });
      runner.dispose();
    } finally {
      restore();
    }
  });

  it("sans Worker, repli sur le fil principal", async () => {
    const runner = new TraceRunner(true);
    const r = await runner.run(image(40, 32), { colors: 2 });
    expect(runner.engine).toBe("main");
    expect(r.layers.length).toBeGreaterThan(0);
  });
});
