import { describe, expect, it } from "vitest";
import { hfWorkerMain } from "./hf-worker-runtime";

/** `configure` du worker : choix du nombre de fils d'ONNX Runtime selon l'origine des binaires. */
async function configure(env: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib: any = { env: { backends: { onnx: { wasm: {} } } }, pipeline: async () => null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listener: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const replies: any[] = [];
  hfWorkerMain(lib, { postMessage: (m: unknown) => replies.push(m), addEventListener: (_: string, l: unknown) => (listener = l) } as never);
  listener({ data: { id: 1, type: "configure", env: { cacheKey: "k", ...env } } });
  for (let i = 0; i < 50 && !replies.length; i++) await new Promise((r) => setTimeout(r, 2));
  expect(replies[0]?.ok).toBe(true);
  return lib.env.backends.onnx.wasm;
}

describe("configure : fils ONNX Runtime", () => {
  it("binaires sur une autre origine : un seul fil (pas d'import blob: refusé par la CSP)", async () => {
    const w = await configure({ wasmPaths: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.0.0/dist/" });
    expect(w.numThreads).toBe(1);
    expect(w.wasmPaths.mjs).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/.*\.mjs$/);
  });
  it("binaires de la même origine : choix laissé à ONNX Runtime", async () => {
    const w = await configure({ wasmPaths: `${location.origin}/ort/` });
    expect(w.numThreads).toBeUndefined();
  });
  it("valeur explicite respectée", async () => {
    const w = await configure({ wasmPaths: "https://cdn.jsdelivr.net/x/", numThreads: 4 });
    expect(w.numThreads).toBe(4);
  });
  it("sans wasmPaths : rien d'imposé", async () => {
    const w = await configure({});
    expect(w.numThreads).toBeUndefined();
  });
});
