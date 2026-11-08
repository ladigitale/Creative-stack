import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { configureMl, resetMlConfig, type ConsentStore } from "../../shared/ml/trust";
import { configureVision, resetVisionConfig, type HandEngine, type HandEngineOptions } from "./hand-engine";
import { SonicHandTracker } from "./hand-tracker";
import { SonicObjectDetector } from "./object-detector";
import { SonicClickSegmenter } from "./click-segmenter";
import { SonicImageEmbedder } from "./image-embedder";
import { ParamOverlay, readParams, FLAG, MIRROR } from "./live-params";
import type { MpEngine, MpEngineOptions } from "./mp-engine";
import { fakeHand } from "./test-hands";

void SonicHandTracker;
void SonicObjectDetector;
void SonicClickSegmenter;
void SonicImageEmbedder;

function memoryConsent(): ConsentStore {
  const m = new Map<string, "accepted" | "declined">();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), clear: (k) => void m.delete(k) };
}

function mountSource(id = "cam") {
  const el = document.createElement("div") as unknown as HTMLElement & { getFrameSource: () => unknown; getFrameCanvas: () => null; frameSeq: number; t: number };
  el.id = id;
  el.t = 1;
  const video = { readyState: 4, videoWidth: 640, get currentTime() { return el.t; } };
  el.getFrameSource = () => video;
  el.getFrameCanvas = () => null;
  el.frameSeq = 0;
  document.body.appendChild(el);
  return el;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await wait(10);
}

async function mount<T extends HTMLElement>(tag: string, attrs: Record<string, string>): Promise<T> {
  const el = document.createElement(tag) as T & { updateComplete: Promise<boolean> };
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function handEngines() {
  const opts: HandEngineOptions[] = [];
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  configureVision({
    createEngine: async (o) => {
      opts.push(o);
      const close = vi.fn();
      closes.push(close);
      const engine: HandEngine = { backend: "cpu", thread: "main", detect: async () => [fakeHand(0.3, 0.5)], close };
      return engine;
    },
  });
  return { opts, closes };
}

const MODEL = new Uint8Array([1, 2, 3, 4]);
beforeEach(() => {
  configureMl({ consent: memoryConsent() });
  configureVision({ fetchImpl: async () => new Response(MODEL.slice()) });
});
afterEach(() => {
  document.body.innerHTML = "";
  resetMlConfig();
  resetVisionConfig();
});

describe("live-params", () => {
  it("valide et borne les valeurs, ignore les clés inconnues ou invalides", () => {
    const specs = {
      minScore: { kind: "number", min: 0, max: 1 } as const,
      maxHands: { kind: "number", min: 1, max: 2, int: true } as const,
      gestures: FLAG,
      mirror: MIRROR,
      categories: { kind: "string", max: 10 } as const,
    };
    expect(readParams(specs, { minScore: 3, maxHands: 1.6, gestures: false, mirror: true, categories: "cup", other: 1 })).toEqual({
      minScore: 1, maxHands: 2, gestures: "false", mirror: "true", categories: "cup",
    });
    expect(readParams(specs, { minScore: "x", maxHands: true, gestures: "peut-être", mirror: "auto", categories: "x".repeat(11) })).toEqual({ mirror: "auto" });
    expect(readParams(specs, null)).toEqual({});
    expect(readParams(specs, { gestures: 1 })).toEqual({ gestures: "true" });
  });

  it("recouvre une propriété puis rend la valeur d'attribut ; un attribut changé entre-temps devient la valeur de repli", () => {
    const host = { a: 1, b: "x" };
    const o = new ParamOverlay(host);
    o.set({ a: 5 });
    expect(host.a).toBe(5);
    host.a = 2; // attribut modifié pendant le recouvrement
    o.guard(new Map([["a", 5]]));
    expect(host.a).toBe(5);
    o.set({});
    expect(host.a).toBe(2);
    expect(o.keys()).toEqual([]);
  });
});

describe("SonicMlTracker : params et control", () => {
  it("params : réglages en direct, prioritaires sur les attributs, publiés dans le statut ; clé retirée → attribut", async () => {
    mountSource();
    handEngines();
    dp("hp1Params").set({ smooth: 0.1, holdMs: 400, fps: 12, mirror: false });
    const el = await mount<SonicHandTracker>("sonic-hand-tracker", { id: "hp1", for: "cam", load: "manual", smooth: "0.7", params: "hp1Params" });
    await flush();
    expect(el.smooth).toBe(0.1);
    expect(el.holdMs).toBe(400);
    expect(el.fps).toBe(12);
    expect(el.mirror).toBe("false");
    expect(el.getState().settings).toMatchObject({ smooth: 0.1, holdMs: 400, fps: 12, mirror: "false", minScore: 0.5, maxHands: 2, gestures: "true" });
    await flush();
    expect(dp("hp1State").get()).toMatchObject({ status: "idle", phase: "idle", active: true, settings: { smooth: 0.1 } });

    el.setAttribute("smooth", "0.9"); // l'attribut ne l'emporte pas sur params
    await el.updateComplete;
    expect(el.smooth).toBe(0.1);
    dp("hp1Params").set({ holdMs: 99999 }); // smooth retiré : retour à l'attribut ; holdMs borné
    await el.updateComplete;
    expect(el.smooth).toBe(0.9);
    expect(el.holdMs).toBe(10000);
    expect(el.fps).toBe(30);
  });

  it("params maxHands / minScore : moteur recréé une seule fois (regroupé) avec les nouveaux réglages", async () => {
    mountSource();
    const { opts, closes } = handEngines();
    const el = await mount<SonicHandTracker>("sonic-hand-tracker", { id: "hp2", for: "cam", load: "auto", params: "hp2Params" });
    await until(() => el.getState().phase === "ready");
    await wait(250);
    expect(opts).toHaveLength(1); // pas de rechargement parasite après le premier chargement
    dp("hp2Params").set({ maxHands: 1 });
    dp("hp2Params").set({ maxHands: 1, minScore: 0.8 });
    await el.updateComplete;
    expect(el.getState().phase).toBe("ready"); // l'ancien moteur tourne en attendant
    await until(() => opts.length === 2 && el.getState().phase === "ready");
    expect(opts).toHaveLength(2);
    expect(opts[1]).toMatchObject({ maxHands: 1, minScore: 0.8 });
    expect(closes[0]).toHaveBeenCalled();
  });

  it("control.active : pause et reprise de l'inférence ; control.load : chargement en load=manual", async () => {
    const src = mountSource();
    const { opts } = handEngines();
    dp("hp3Ctl").set({ load: 0 });
    const el = await mount<SonicHandTracker>("sonic-hand-tracker", { id: "hp3", for: "cam", load: "manual", control: "hp3Ctl" });
    await flush();
    expect(opts).toHaveLength(0);
    dp("hp3Ctl").set({ load: 1 });
    await until(() => el.getState().phase === "ready");
    expect(opts).toHaveLength(1);
    expect(el.getState().status).toBe("ready");

    dp("hp3Ctl").set({ load: 1, active: false });
    expect(el.getState().active).toBe(false);
    expect(await el.processFrame(100)).toBeNull();
    dp("hp3Ctl").set({ load: 1, active: true });
    src.t = 2;
    expect((await el.processFrame(200))?.count).toBe(1);
    await flush();
    expect(dp("hp3State").get()).toMatchObject({ active: true, status: "ready" });
  });

  it("control porte aussi des réglages, sous params", async () => {
    mountSource();
    handEngines();
    dp("hp4Ctl").set({ smooth: 0.2, fps: 10 });
    dp("hp4Params").set({ smooth: 0.6 });
    const el = await mount<SonicHandTracker>("sonic-hand-tracker", { id: "hp4", for: "cam", load: "manual", control: "hp4Ctl", params: "hp4Params" });
    await flush();
    expect(el.smooth).toBe(0.6);
    expect(el.fps).toBe(10);
  });

  it("statut standard : requesting pendant le consentement", async () => {
    mountSource();
    configureMl({ origins: ["https://models.example/"] });
    handEngines();
    const el = await mount<SonicHandTracker>("sonic-hand-tracker", { id: "hp5", for: "cam", load: "auto", model: "https://models.example/h.task" });
    await flush();
    expect(el.getState()).toMatchObject({ phase: "awaiting-consent", status: "requesting" });
    el.decline();
    expect(el.getState().status).toBe("denied");
  });

  it("clés propres aux sous-classes : détecteur, segmenteur par clic, embedder", async () => {
    mountSource();
    const seen: MpEngineOptions[] = [];
    configureVision({
      createMpEngine: async (o: MpEngineOptions): Promise<MpEngine> => {
        seen.push(o);
        return { backend: "cpu", thread: "main", detect: async () => ({}), close: vi.fn() };
      },
    });
    dp("odP").set({ categories: "cup", maxResults: 50, track: true, trackIou: 0.5 });
    const od = await mount<SonicObjectDetector>("sonic-object-detector", { id: "od", for: "cam", load: "auto", params: "odP" });
    await until(() => od.getState().phase === "ready");
    expect(seen[0].options).toMatchObject({ maxResults: 20, categoryAllowlist: ["cup"] });
    expect(od.track).toBe("true");
    expect(od.getState().settings).toMatchObject({ trackIou: 0.5, categories: "cup" });

    dp("csP").set({ live: false, threshold: 0.7, mode: "alpha", maskIndex: 1 });
    const cs = await mount<SonicClickSegmenter>("sonic-click-segmenter", { id: "cs", for: "cam", load: "manual", params: "csP" });
    await flush();
    expect(cs).toMatchObject({ live: "false", threshold: 0.7, mode: "alpha", maskIndex: "1" });

    dp("ieP").set({ cropMinScore: 0.8, cropLabels: "cup", region: "0,0,0.5,0.5", fps: 2 });
    const ie = await mount<SonicImageEmbedder>("sonic-image-embedder", { id: "ie", for: "cam", load: "manual", params: "ieP" });
    await flush();
    expect(ie).toMatchObject({ cropMinScore: 0.8, cropLabels: "cup", region: "0,0,0.5,0.5", fps: 2 });
    dp("ieP").set({});
    await ie.updateComplete;
    expect(ie.fps).toBe(5); // valeur par défaut propre au composant
  });
});
