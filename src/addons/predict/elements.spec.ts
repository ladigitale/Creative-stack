import { afterEach, describe, expect, it } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { SonicTrain } from "./train-element";
import { SonicPredict } from "./predict";
import { rng } from "../paint/brush";

void SonicTrain; void SonicPredict;

const mount = <T extends HTMLElement>(tag: string, attrs: Record<string, string>): T => {
  const el = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await tick(15); };
const get = (path: string) => JSON.parse(JSON.stringify(dp(path).get() ?? null));

function csv(n = 150): string {
  const r = rng(3);
  const lines = ["surface;pieces;ville;prix"];
  for (let i = 0; i < n; i++) {
    const s = 20 + Math.floor(r() * 100), p = 1 + Math.floor(r() * 5), v = r() < 0.5 ? "Tours" : "Paris";
    lines.push(`${s};${p};${v};${Math.round(s * 2000 + p * 5000 + (v === "Paris" ? 100000 : 0))}`.replace(".", ","));
  }
  return lines.join("\n");
}

afterEach(() => { document.body.innerHTML = ""; });

describe("sonic-train / sonic-predict", () => {
  it("lit un CSV, propose la dernière colonne comme cible et détecte la tâche", async () => {
    const el = mount<SonicTrain>("sonic-train", { "data-provider": "t1d", "out-data-provider": "t1s" });
    await tick();
    set("t1d", csv());
    await tick();
    const s = get("t1s");
    expect(s).toMatchObject({ status: "ready", rows: 150, target: "prix", task: "regression" });
    expect(s.columns).toEqual(["surface", "pieces", "ville", "prix"]);
    el.remove();
  });

  it("entraîne sur commande, publie courbe, métriques et modèle, puis predict l'utilise", async () => {
    mount<SonicTrain>("sonic-train", { "data-provider": "t2d", control: "t2c", "model-data-provider": "t2m", "out-data-provider": "t2s", kind: "linear", epochs: "200", "learning-rate": "0.05" });
    mount<SonicPredict>("sonic-predict", { "model-from": "t2m", "input-from": "t2in", "out-data-provider": "t2p" });
    await tick();
    set("t2d", csv());
    set("t2c", { train: 0 });
    await tick();
    expect(get("t2s").status).toBe("ready");
    set("t2c", { train: 1 });
    await until(() => get("t2s")?.status === "done");
    const s = get("t2s");
    expect(s.status).toBe("done");
    expect(s.curve).toHaveLength(200);
    expect(s.metrics.r2).toBeGreaterThan(0.95);
    expect(s.importance[0].name).toBe("surface");
    expect(s.model.format).toBe("sonic-model/1");
    await tick();
    expect(get("t2p")).toMatchObject({ status: "ready", task: "regression", target: "prix" });
    set("t2in", { surface: 50, pieces: 3, ville: "Paris" });
    await tick();
    const pred = get("t2p").prediction;
    expect(Math.abs(pred.value - (50 * 2000 + 3 * 5000 + 100000))).toBeLessThan(15000);
    set("t2in", [{ surface: 30, pieces: 1, ville: "Tours" }, { surface: 90, pieces: 4, ville: "Tours" }]);
    await tick();
    const p = get("t2p").predictions;
    expect(p).toHaveLength(2);
    expect(p[1].value).toBeGreaterThan(p[0].value);
  });

  it("classification : confusion à plat pour une carte de chaleur", async () => {
    mount<SonicTrain>("sonic-train", { "data-provider": "t3d", "out-data-provider": "t3s", target: "classe", epochs: "80", "auto-train": "" });
    await tick();
    const r = rng(2);
    set("t3d", Array.from({ length: 200 }, () => { const x = r() * 10; return { x, classe: x > 5 ? "haut" : "bas" }; }));
    await until(() => get("t3s")?.status === "done");
    const s = get("t3s");
    expect(s.task).toBe("classification");
    expect(s.metrics.accuracy).toBeGreaterThan(0.9);
    expect(s.confusion).toHaveLength(4);
    expect(s.confusion.reduce((a: number, c: { n: number }) => a + c.n, 0)).toBe(s.metrics.n);
  });

  it("signale les erreurs sans planter", async () => {
    mount<SonicTrain>("sonic-train", { "data-provider": "t4d", control: "t4c", "out-data-provider": "t4s" });
    mount<SonicPredict>("sonic-predict", { "model-from": "t4m", "out-data-provider": "t4p" });
    await tick();
    set("t4d", 42);
    await tick();
    expect(get("t4s")).toMatchObject({ status: "error" });
    set("t4d", [{ a: 1, b: 2 }]);
    set("t4c", { train: 0 });
    set("t4c", { train: 1 });
    await tick();
    expect(get("t4s").status).toBe("error");
    expect(get("t4s").error).toMatch(/10 lignes/);
    set("t4m", { format: "inconnu" });
    await tick();
    expect(get("t4p")).toMatchObject({ status: "error", error: "format de modèle inconnu" });
  });

  it("des données republiées pendant l'entraînement le relancent au lieu de le bloquer", async () => {
    mount<SonicTrain>("sonic-train", { "data-provider": "t6d", "out-data-provider": "t6s", epochs: "60", "auto-train": "", "hidden-units": "32" });
    await tick();
    const text = csv(400);
    set("t6d", text);
    await tick(5);
    expect(get("t6s").status).toBe("training");
    set("t6d", text + "\n");
    await until(() => get("t6s")?.status === "done");
    expect(get("t6s").status).toBe("done");
    expect(get("t6s").curve).toHaveLength(60);
  });

  it("arrêter garde le modèle à l'époque atteinte", async () => {
    mount<SonicTrain>("sonic-train", { "data-provider": "t5d", control: "t5c", "out-data-provider": "t5s", epochs: "2000", "hidden-units": "64" });
    await tick();
    set("t5d", csv(600));
    set("t5c", { train: 0, stop: 0 });
    await tick();
    set("t5c", { train: 1, stop: 0 });
    await until(() => get("t5s")?.epoch > 3);
    expect(get("t5s").status).toBe("training");
    set("t5c", { train: 1, stop: 1 });
    await tick(50);
    const s = get("t5s");
    expect(s.status).toBe("done");
    expect(s.epoch).toBeGreaterThan(0);
    expect(s.epoch).toBeLessThan(2000);
    expect(s.model).not.toBeNull();
  });
});

describe("sonic-train : réglages par DataProvider", () => {
  it("lit les clés camelCase ou en tirets, bornées", async () => {
    const { readTrainSettings } = await import("./train-element");
    expect(readTrainSettings({ target: " prix ", features: "surface, pieces", task: "regression", kind: "linear", "hidden-units": 999, epochs: 0, "learning-rate": 5, testSplit: 0.9, seed: 4.6 }))
      .toEqual({ target: "prix", features: ["surface", "pieces"], task: "regression", kind: "linear", hiddenUnits: 128, epochs: 1, learningRate: 1, testSplit: 0.5, seed: 5 });
    expect(readTrainSettings({ task: "nope", kind: "cnn", epochs: "x", features: ["a", 3, null] })).toEqual({ features: ["a", "3"] });
    expect(readTrainSettings(null)).toEqual({});
  });

  it("params l'emporte sur control et sur les attributs, lus au lancement ; réglages publiés", async () => {
    const el = mount<SonicTrain>("sonic-train", { "data-provider": "t7d", control: "t7c", params: "t7p", "out-data-provider": "t7s", epochs: "500", kind: "mlp", "test-split": "0.3" });
    await tick();
    set("t7d", csv());
    set("t7c", { train: 0, epochs: 400, seed: 9 });
    await tick();
    expect(get("t7s").settings).toMatchObject({ epochs: 400, kind: "mlp", testSplit: 0.3, seed: 9, target: "", features: [] });
    set("t7p", { kind: "linear", epochs: 30, learningRate: 0.05, features: ["surface", "pieces"], target: "prix" });
    await tick();
    expect(get("t7s")).toMatchObject({ status: "ready", target: "prix", settings: { kind: "linear", epochs: 30, seed: 9, features: ["surface", "pieces"] } });
    set("t7c", { train: 1, epochs: 400, seed: 9 });
    await until(() => get("t7s")?.status === "done");
    const s = get("t7s");
    expect(s.epochs).toBe(30);
    expect(s.curve).toHaveLength(30);
    expect(s.features).toEqual(["surface", "pieces"]);
    expect(s.settings).toMatchObject({ kind: "linear", epochs: 30, learningRate: 0.05, testSplit: 0.3, seed: 9 });
    // Un changement après coup ne relance rien et garde le résultat.
    set("t7p", { kind: "linear", epochs: 60 });
    await tick(60);
    expect(get("t7s")).toMatchObject({ status: "done", epochs: 30, settings: { epochs: 30 } });
    expect(el.settings().epochs).toBe(60);
    set("t7c", { train: 2 });
    await until(() => get("t7s")?.status === "done" && get("t7s").epochs === 60);
    expect(get("t7s").curve).toHaveLength(60);
    expect(get("t7s").settings).toMatchObject({ epochs: 60, features: [] });
  });

  it("une cible inconnue dans params retombe sur la dernière colonne", async () => {
    mount<SonicTrain>("sonic-train", { "data-provider": "t8d", params: "t8p", "out-data-provider": "t8s" });
    await tick();
    set("t8d", csv());
    set("t8p", { target: "surface" });
    await tick();
    expect(get("t8s")).toMatchObject({ target: "surface", task: "regression", settings: { target: "surface" } });
    set("t8p", { target: "inexistante" });
    await tick();
    expect(get("t8s").target).toBe("prix");
  });
});
