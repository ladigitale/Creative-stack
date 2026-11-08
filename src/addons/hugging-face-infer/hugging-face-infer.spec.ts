import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import SonicHuggingFaceInfer, { readHfParams } from "./hugging-face-infer";
import { configureHuggingFace, defineHuggingFaceModels } from "./hugging-face";
import type { HfEngine } from "./hf-engine";
import type { HfRunRequest } from "./hf-protocol";
import { clearResults } from "./hf-cache";

void SonicHuggingFaceInfer;

const models = defineHuggingFaceModels({
  mini: { task: "feature-extraction", repo: "Xenova/all-MiniLM-L6-v2", revision: "test", defaults: { pooling: "mean", normalize: true } },
  labels: { task: "zero-shot-classification", repo: "Xenova/mobilebert-uncased-mnli", revision: "test" },
});

function engine() {
  const runs: HfRunRequest[] = [];
  const e: HfEngine = {
    async configure() {},
    async inspect() { return { totalBytes: 1024, cached: true }; },
    async load() { return { backend: "wasm", loadMs: 1 }; },
    async run(request) {
      runs.push(request);
      if (request.alias === "labels") return request.inputs.map(() => ({ labels: ["a"], scores: [1] }));
      return request.inputs.map((t) => [String(t).length, 0]);
    },
    async clear() {},
    dispose() {},
  };
  return { e, runs };
}

const mount = (attrs: Record<string, string>): SonicHuggingFaceInfer => {
  const el = document.createElement("sonic-hugging-face-infer") as SonicHuggingFaceInfer;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
};
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
type Status = { state: string; status: string; model: { alias: string; task?: string }; error?: { code: string; message: string } };
const status = (path: string) => dp(path).get() as Status;

beforeEach(async () => {
  localStorage.clear();
  await clearResults();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("readHfParams", () => {
  it("lit model et options (objet ou JSON), refuse les formes illisibles", () => {
    expect(readHfParams({ model: " mini ", options: { text: "label" } })).toEqual({ params: { model: "mini", options: { text: "label" } }, error: null });
    expect(readHfParams({ options: '{"call":{"top_k":2}}' })).toEqual({ params: { options: { call: { top_k: 2 } } }, error: null });
    expect(readHfParams({ options: null }).params).toEqual({ options: null });
    expect(readHfParams(null)).toEqual({ params: {}, error: null });
    expect(readHfParams({ model: 42 }).error).toMatch(/alias/);
    expect(readHfParams({ options: "{oups" }).error).toMatch(/JSON/);
    expect(readHfParams({ options: [1] }).error).toMatch(/objet/);
    expect(readHfParams({ options: { call: "x" } }).error).toMatch(/call/);
  });
});

describe("sonic-hugging-face-infer : erreurs de configuration dans statusProvider", () => {
  it("sans configureHuggingFace : état error publié", async () => {
    set("hfeIn0", "bonjour");
    mount({ model: "mini", inputProvider: "hfeIn0", outputProvider: "hfeOut0", statusProvider: "hfeSt0" });
    await wait();
    expect(status("hfeSt0")).toMatchObject({ state: "error", status: "error", model: { alias: "mini" }, error: { code: "config", message: expect.stringMatching(/configureHuggingFace/) } });
  });

  it("modèle manquant, hors liste blanche, entrée = sortie, params illisibles", async () => {
    const { e } = engine();
    configureHuggingFace({ runtime: { source: "engine", engine: e, version: "test" }, models, defaults: { debounceMs: 5 } });
    mount({ inputProvider: "hfeIn1", outputProvider: "hfeOut1", statusProvider: "hfeSt1" });
    await wait();
    expect(status("hfeSt1")).toMatchObject({ status: "error", error: { code: "config", message: expect.stringMatching(/modèle manquant/) } });

    mount({ model: "inconnu", inputProvider: "hfeIn2", outputProvider: "hfeOut2", statusProvider: "hfeSt2" });
    await wait();
    expect(status("hfeSt2")).toMatchObject({ state: "error", status: "error", error: { code: "not-allowed" } });

    mount({ model: "mini", inputProvider: "hfeIn3", outputProvider: "hfeIn3", statusProvider: "hfeSt3" });
    await wait();
    expect(status("hfeSt3")).toMatchObject({ status: "error", error: { code: "config", message: expect.stringMatching(/chevauche/) } });

    set("hfeP4", { model: "mini", options: "{oups" });
    mount({ params: "hfeP4", inputProvider: "hfeIn4", outputProvider: "hfeOut4", statusProvider: "hfeSt4" });
    await wait();
    expect(status("hfeSt4")).toMatchObject({ status: "error", error: { code: "config", message: expect.stringMatching(/JSON/) } });
  });

  it("options d'appel refusées : erreur visible dès le démarrage", async () => {
    const { e } = engine();
    configureHuggingFace({ runtime: { source: "engine", engine: e, version: "test" }, models, defaults: { debounceMs: 5 } });
    set("hfeP5", { model: "mini", options: { call: { inconnue: true } } });
    mount({ params: "hfeP5", inputProvider: "hfeIn5", outputProvider: "hfeOut5", statusProvider: "hfeSt5", trigger: "demand" });
    await wait();
    expect(status("hfeSt5")).toMatchObject({ state: "error", status: "error", error: { code: "invalid-input" } });
  });
});

describe("sonic-hugging-face-infer : params { model, options }", () => {
  it("params l'emporte sur les attributs et redémarre le contrôleur au changement", async () => {
    const { e, runs } = engine();
    configureHuggingFace({ runtime: { source: "engine", engine: e, version: "test" }, models, defaults: { debounceMs: 5 } });
    set("hfeIn6", "bonjour");
    set("hfeP6", {});
    const el = mount({ model: "mini", params: "hfeP6", inputProvider: "hfeIn6", outputProvider: "hfeOut6", statusProvider: "hfeSt6" });
    await vi.waitFor(() => expect(status("hfeSt6")).toMatchObject({ state: "done", status: "done", model: { alias: "mini" } }));
    expect(dp("hfeOut6").get()).toEqual([7, 0]);

    set("hfeP6", { model: "labels", options: { call: { candidate_labels: ["a", "b"] } } });
    await vi.waitFor(() => expect(status("hfeSt6")).toMatchObject({ state: "done", model: { alias: "labels", task: "zero-shot-classification" } }));
    expect(el.effective.model).toBe("labels");
    expect(runs.at(-1)).toMatchObject({ alias: "labels", call: { candidate_labels: ["a", "b"] } });

    // Même valeur republiée : pas de redémarrage.
    const restart = vi.spyOn(el as unknown as { restart: () => void }, "restart");
    set("hfeP6", { model: "labels", options: { call: { candidate_labels: ["a", "b"] } } });
    await wait(60);
    expect(restart).not.toHaveBeenCalled();
    restart.mockRestore();

    // Params vidé : retour aux attributs.
    set("hfeP6", {});
    await vi.waitFor(() => expect(status("hfeSt6")).toMatchObject({ state: "done", model: { alias: "mini" } }));
    el.remove();
  });

  it("une configuration corrigée par params efface l'erreur", async () => {
    const { e } = engine();
    configureHuggingFace({ runtime: { source: "engine", engine: e, version: "test" }, models, defaults: { debounceMs: 5 } });
    set("hfeIn7", "salut");
    set("hfeP7", { model: "inconnu" });
    mount({ params: "hfeP7", inputProvider: "hfeIn7", outputProvider: "hfeOut7", statusProvider: "hfeSt7" });
    await wait();
    expect(status("hfeSt7")).toMatchObject({ status: "error", error: { code: "not-allowed" } });
    set("hfeP7", { model: "mini" });
    await vi.waitFor(() => expect(status("hfeSt7")).toMatchObject({ state: "done", status: "done" }));
    expect(status("hfeSt7").error).toBeUndefined();
  });
});
