import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { DataProviderKey } from "@supersoniks/concorde/core/utils/dataProviderKey";
import { deriveStateKey } from "@supersoniks/concorde/core/utils/derive";
import { dp, set } from "@supersoniks/concorde/utils";
import {
  configureHuggingFace,
  defineHuggingFaceModels,
  type HfInferStatus,
} from "./hugging-face";
import type { HfEngine } from "./hf-engine";
import type { HfModelRef, HfRunRequest } from "./hf-protocol";
import { clearResults } from "./hf-cache";

const MB = 1024 * 1024;

/** Moteur factice : « embedding » = [longueur, nombre de voyelles]. */
function fakeEngine(opts: { totalBytes?: number; cached?: boolean; runDelay?: number } = {}) {
  const calls = { inspect: 0, load: [] as string[][], run: [] as HfRunRequest[] };
  const engine: HfEngine = {
    async configure() {},
    async inspect(_model: HfModelRef) {
      calls.inspect++;
      return { totalBytes: opts.totalBytes ?? 10 * MB, cached: opts.cached ?? false };
    },
    async load(_model, devices, onProgress) {
      calls.load.push([...devices]);
      onProgress({ loadedBytes: 5, totalBytes: 10, percent: 50 });
      if (!devices.includes("wasm")) {
        const { HfEngineError } = await import("./hf-engine");
        throw new HfEngineError("unsupported", "webgpu indisponible");
      }
      return { backend: "wasm", loadMs: 12 };
    },
    async run(request) {
      calls.run.push(request);
      if (opts.runDelay) await new Promise((r) => setTimeout(r, opts.runDelay));
      return request.inputs.map((t) => {
        const s = String(t);
        return [s.length, (s.match(/[aeiouy]/g) ?? []).length];
      });
    },
    async clear() {},
    dispose() {},
  };
  return { engine, calls };
}

const models = defineHuggingFaceModels({
  mini: {
    task: "feature-extraction",
    repo: "Xenova/all-MiniLM-L6-v2",
    revision: "test",
    defaults: { pooling: "mean", normalize: true },
  },
  labels: {
    task: "zero-shot-classification",
    repo: "Xenova/mobilebert-uncased-mnli",
    revision: "test",
  },
});

function setup(engineOpts?: Parameters<typeof fakeEngine>[0], defaults = {}) {
  const fake = fakeEngine(engineOpts);
  const hf = configureHuggingFace({
    runtime: { source: "engine", engine: fake.engine, version: "test" },
    models,
    defaults: { debounceMs: 5, ...defaults },
  });
  return { hf, ...fake };
}

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const keys = () => {
  n++;
  return {
    input: new DataProviderKey<string | string[] | null>(`hf-in-${n}`),
    events: new DataProviderKey<{ label: string }[]>(`hf-events-${n}`),
    output: new DataProviderKey<number[] | null>(`hf-out-${n}`),
    many: new DataProviderKey<(number[] | null)[] | null>(`hf-many-${n}`),
    status: new DataProviderKey<HfInferStatus | null>(`hf-status-${n}`),
    trigger: new DataProviderKey<{ at: number }>(`hf-trigger-${n}`),
    consent: new DataProviderKey<{ ok: boolean }>(`hf-consent-${n}`),
  };
};

beforeEach(async () => {
  localStorage.clear();
  await clearResults();
});
afterEach(() => vi.useRealTimers());

describe("createHuggingFace().infer", () => {
  it("entrée vide : sortie = emptyValue, état empty, aucun chargement", async () => {
    const { hf, calls } = setup();
    const k = keys();
    set(k.input, "");
    const h = hf.infer({ model: "mini", input: k.input, output: k.output, status: k.status });
    await wait();
    expect(dp(k.output).get()).toBeNull();
    expect(dp(k.status).get()?.state).toBe("empty");
    expect(dp(deriveStateKey(k.output)).get().status).toBe("empty");
    expect(calls.load).toHaveLength(0);
    h.stop();
  });

  it("first-use : charge au premier texte valide, publie sortie et statut", async () => {
    const { hf, calls } = setup();
    const k = keys();
    set(k.input, "un spectacle drôle");
    const h = hf.infer({ model: "mini", input: k.input, output: k.output, status: k.status });
    await wait(60);
    expect(dp(k.output).get()).toEqual([18, 5]);
    const status = dp(k.status).get();
    expect(status).toMatchObject({
      state: "done",
      backend: "wasm",
      size: { totalBytes: 10 * MB },
      model: { alias: "mini", task: "feature-extraction" },
    });
    expect(calls.run[0]).toMatchObject({ batch: true, call: { pooling: "mean", normalize: true } });
    expect(dp(deriveStateKey(k.output)).get().status).toBe("ready");
    h.stop();
  });

  it("recalcule à la mutation, et sert le cache pour une entrée déjà vue", async () => {
    const { hf, calls } = setup();
    const k = keys();
    set(k.input, "alpha");
    const h = hf.infer({ model: "mini", input: k.input, output: k.output, status: k.status });
    await wait(60);
    set(k.input, "beta");
    await wait(60);
    expect(dp(k.output).get()).toEqual([4, 2]);
    set(k.input, "alpha");
    await wait(60);
    expect(dp(k.output).get()).toEqual([5, 2]);
    expect(calls.run).toHaveLength(2);
    expect(dp(k.status).get()?.fromResultsCache).toBe(true);
    h.stop();
  });

  it("liste d'objets + text : sortie alignée, éléments ignorés comptés", async () => {
    const { hf } = setup();
    const k = keys();
    set(k.events, [{ label: "aa" }, { label: "" }, { label: "bbb" }]);
    const h = hf.infer({
      model: "mini",
      input: k.events,
      text: (e) => e.label,
      output: k.many,
      status: k.status,
    });
    await wait(60);
    expect(dp(k.many).get()).toEqual([[2, 2], null, [3, 0]]);
    expect(dp(k.status).get()?.skipped).toBe(1);
    h.stop();
  });

  it("entrée invalide : invalid-input, sortie conservée (onInvalid=keep)", async () => {
    const { hf } = setup();
    const k = keys();
    set(k.input, "ok");
    const h = hf.infer({ model: "mini", input: k.input, output: k.output, status: k.status });
    await wait(60);
    set(k.input as never, 12 as never);
    await wait(60);
    expect(dp(k.status).get()).toMatchObject({
      state: "invalid-input",
      error: { code: "invalid-input" },
    });
    expect(dp(k.output).get()).toEqual([2, 1]);
    h.stop();
  });

  it("gros modèle : bascule en consentement, puis charge après accord via consentProvider", async () => {
    const { hf, calls } = setup(
      { totalBytes: 120 * MB },
      { consentAboveMB: 30, allowWasmUpToMB: 1000 },
    );
    const k = keys();
    set(k.consent, { ok: false });
    set(k.input, "texte");
    const h = hf.infer({
      model: "mini",
      input: k.input,
      output: k.output,
      status: k.status,
      consentProvider: k.consent.ok,
    });
    await wait(60);
    expect(dp(k.status).get()?.state).toBe("awaiting-consent");
    expect(dp(k.status).get()?.size?.totalBytes).toBe(120 * MB);
    expect(calls.load).toHaveLength(0);
    dp(k.consent).ok.set(true);
    await wait(60);
    expect(dp(k.status).get()?.state).toBe("done");
    expect(localStorage.getItem("concorde-hf-consent:mini@test")).toBe("accepted");
    h.stop();
  });

  it("refus : état declined, la page continue sans modèle", async () => {
    const { hf, calls } = setup({}, { load: "consent" });
    const k = keys();
    set(k.input, "texte");
    const h = hf.infer({ model: "mini", input: k.input, output: k.output, status: k.status });
    await wait(60);
    h.decline();
    await wait(30);
    expect(dp(k.status).get()?.state).toBe("declined");
    expect(dp(k.output).get()).toBeNull();
    expect(calls.load).toHaveLength(0);
    h.stop();
  });

  it("modèle en cache : pas de demande de consentement", async () => {
    const { hf } = setup(
      { totalBytes: 500 * MB, cached: true },
      { load: "consent", allowWasmUpToMB: 1000 },
    );
    const k = keys();
    set(k.input, "texte");
    const h = hf.infer({ model: "mini", input: k.input, output: k.output, status: k.status });
    await wait(60);
    expect(dp(k.status).get()?.state).toBe("done");
    h.stop();
  });

  it("manual : attend load(), puis calcule", async () => {
    const { hf, calls } = setup();
    const k = keys();
    set(k.input, "texte");
    const h = hf.infer({
      model: "mini",
      load: "manual",
      input: k.input,
      output: k.output,
      status: k.status,
    });
    await wait(60);
    expect(calls.load).toHaveLength(0);
    expect(calls.run).toHaveLength(0);
    await h.load();
    await wait(60);
    expect(dp(k.output).get()).toEqual([5, 2]);
    h.stop();
  });

  it("demand : ne calcule qu'au déclenchement", async () => {
    const { hf, calls } = setup();
    const k = keys();
    set(k.trigger, { at: 0 });
    set(k.input, "texte");
    const h = hf.infer({
      model: "mini",
      trigger: "demand",
      triggerProvider: k.trigger,
      input: k.input,
      output: k.output,
      status: k.status,
    });
    await wait(60);
    expect(calls.run).toHaveLength(0);
    set(k.trigger, { at: 1 });
    await wait(60);
    expect(calls.run).toHaveLength(1);
    await h.run();
    expect(dp(k.output).get()).toEqual([5, 2]);
    h.stop();
  });

  it("repli WASM interdit au-delà du plafond : unsupported sans WebGPU", async () => {
    const { hf, calls } = setup(
      { totalBytes: 80 * MB },
      { allowWasmUpToMB: 50, consentAboveMB: 1000 },
    );
    const k = keys();
    set(k.input, "texte");
    const h = hf.infer({ model: "mini", input: k.input, output: k.output, status: k.status });
    await wait(60);
    expect(calls.load[0]).toEqual(["webgpu"]);
    expect(dp(k.status).get()?.state).toBe("unsupported");
    h.stop();
  });

  it("argument positionnel requis (candidate_labels)", async () => {
    const { hf } = setup();
    const k = keys();
    set(k.input, "texte");
    const out = new DataProviderKey<unknown>(`hf-zs-${n}`);
    const h = hf.infer({ model: "labels", input: k.input, output: out as never, status: k.status });
    await wait(60);
    expect(dp(k.status).get()).toMatchObject({
      state: "invalid-input",
      error: { message: expect.stringContaining("candidate_labels") },
    });
    h.stop();
  });

  it("délai de garde : erreur timeout", async () => {
    const { hf } = setup({ runDelay: 200 });
    const k = keys();
    set(k.input, "texte");
    const h = hf.infer({
      model: "mini",
      input: k.input,
      output: k.output,
      status: k.status,
      timeoutMs: 20,
    });
    await wait(120);
    expect(dp(k.status).get()).toMatchObject({ state: "error", error: { code: "timeout" } });
    h.stop();
  });

  it("alias hors liste blanche : erreur explicite", () => {
    const { hf } = setup();
    const k = keys();
    expect(() =>
      // @ts-expect-error alias inconnu
      hf.infer({ model: "gpt", input: k.input, output: k.output }),
    ).toThrow(/hors liste blanche.*mini, labels/);
  });

  it("run() : calcul ponctuel typé (adaptateur pour derive)", async () => {
    const { hf } = setup();
    const vectors = await hf.run("mini", ["a", "bb"]);
    expect(vectors).toEqual([
      [1, 1],
      [2, 0],
    ]);
    expectTypeOf(vectors).toEqualTypeOf<(number[] | null)[] | null>();
    const one = await hf.run("mini", "abc");
    expectTypeOf(one).toEqualTypeOf<number[] | null>();
    const tokens = await hf.run("mini", "abc", { pooling: "none" });
    expectTypeOf(tokens).toEqualTypeOf<number[][] | null>();
  });

  it("typage : la sortie doit correspondre à la tâche et à l'entrée", () => {
    const { hf } = setup();
    const k = keys();
    const wrong = new DataProviderKey<string>("hf-wrong");
    // @ts-expect-error une liste d'entrée produit une liste alignée, pas un vecteur
    hf.infer({ model: "mini", input: k.events, text: "label", output: k.output }).stop();
    // @ts-expect-error feature-extraction ne produit pas du texte
    hf.infer({ model: "mini", input: k.input, output: wrong }).stop();
    // @ts-expect-error option d'une autre tâche
    hf.infer({ model: "mini", input: k.input, output: k.output, call: { top_k: 2 } }).stop();
  });
});
