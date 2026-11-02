import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { configureMl, getConsentStore, resetMlConfig, type ConsentStore } from "../../shared/ml/trust";
import { configureVision, handsFromMediaPipe, resetVisionConfig, type HandEngine, type HandEngineOptions } from "./hand-engine";
import { SonicHandTracker } from "./hand-tracker";
import { fakeHand } from "./test-hands";
import type { RawHand } from "../../shared/ml/hands";

void SonicHandTracker;

function memoryConsent(): ConsentStore {
  const m = new Map<string, "accepted" | "declined">();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), clear: (k) => void m.delete(k) };
}

/** Source d'images factice : expose le contrat SonicFrameSource avec un <video> natif simulé. */
function mountSource(id = "cam") {
  const el = document.createElement("div") as unknown as HTMLElement & {
    getFrameSource: () => unknown;
    getFrameCanvas: () => null;
    frameSeq: number;
    t: number;
  };
  el.id = id;
  el.t = 1;
  const video = { readyState: 4, videoWidth: 640, get currentTime() { return el.t; } };
  el.getFrameSource = () => video;
  el.getFrameCanvas = () => null;
  el.frameSeq = 0;
  document.body.appendChild(el);
  return el;
}

function fakeEngine(hands: () => RawHand[]) {
  const calls: number[] = [];
  const engine: HandEngine = {
    backend: "cpu",
    thread: "main",
    detect: async (_f, ts) => {
      calls.push(ts);
      return hands();
    },
    close: vi.fn(),
  };
  return { engine, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** Attend (≤ 1 s) qu'une condition soit vraie : le hachage WebCrypto est asynchrone. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

async function mountTracker(attrs: Record<string, string>) {
  const el = document.createElement("sonic-hand-tracker") as SonicHandTracker;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
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

describe("sonic-hand-tracker", () => {
  it("charge le moteur (alias de confiance), traite les images et publie la sortie", async () => {
    const src = mountSource();
    let opts: HandEngineOptions | undefined;
    const { engine, calls } = fakeEngine(() => [fakeHand(0.25, 0.4), fakeHand(0.75, 0.6)]);
    configureVision({ createEngine: async (o) => ((opts = o), engine) });
    const el = await mountTracker({ id: "h1", for: "cam", load: "auto", smooth: "0", mirror: "false", map: "cents=right.x*3600" });
    await flush();
    expect(el.getState().phase).toBe("ready");
    expect(el.getState().backend).toBe("cpu");
    expect(opts).toMatchObject({ gestures: true, maxHands: 2 });
    expect(opts?.model).toEqual(MODEL);
    expect(el.getState().model?.url).toContain("gesture_recognizer");
    expect(el.getState().thread).toBe("main");

    const out = await el.processFrame(1000);
    expect(out?.count).toBe(2);
    expect(calls).toEqual([1000]);
    expect(dp("h1").get()).toMatchObject({ count: 2 });
    expect((dp("h1").get() as { cents: number }).cents).toBeCloseTo(out!.right.x * 3600, 3);

    // même image : rien à faire
    expect(await el.processFrame(1033)).toBeNull();
    // nouvelle image : horodatage strictement croissant
    src.t = 2;
    await el.processFrame(1000);
    expect(calls[1]).toBeGreaterThan(calls[0]);
  });

  it("gestures=false : modèle hand-landmarker", async () => {
    mountSource();
    let opts: HandEngineOptions | undefined;
    configureVision({ createEngine: async (o) => ((opts = o), fakeEngine(() => []).engine) });
    const el2 = await mountTracker({ id: "h2", for: "cam", load: "auto", gestures: "false" });
    await flush();
    expect(opts?.gestures).toBe(false);
    expect(el2.getState().model?.url).toContain("hand_landmarker");
  });

  it("URL hors origines approuvées : erreur, moteur jamais créé", async () => {
    mountSource();
    const create = vi.fn();
    configureVision({ createEngine: create });
    const el = await mountTracker({ id: "h3", for: "cam", load: "auto", model: "https://evil.example/m.task" });
    await flush();
    expect(el.getState()).toMatchObject({ phase: "error", error: { code: "origin-not-allowed" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("URL d'une origine approuvée : attend le consentement, puis charge", async () => {
    mountSource();
    configureMl({ origins: ["https://models.example/"] });
    const create = vi.fn(async () => fakeEngine(() => []).engine);
    configureVision({ createEngine: create });
    const el = await mountTracker({ id: "h4", for: "cam", load: "auto", model: "https://models.example/h.task" });
    await flush();
    expect(el.getState().phase).toBe("awaiting-consent");
    expect(el.getState().consent).toMatchObject({ origin: "https://models.example" });
    expect(create).not.toHaveBeenCalled();
    el.accept();
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(el.getState().phase).toBe("ready");
    expect(getConsentStore().get("origin:https://models.example")).toBe("accepted");
  });

  it("consentement refusé via consentProvider : phase declined, pas de chargement", async () => {
    mountSource();
    configureMl({ origins: ["https://models.example/"] });
    const create = vi.fn();
    configureVision({ createEngine: create });
    dp("consentX").set({ v: "" });
    const el = await mountTracker({
      id: "h5",
      for: "cam",
      load: "auto",
      model: "https://models.example/h.task",
      consentProvider: "consentX.v",
    });
    await flush();
    expect(el.getState().phase).toBe("awaiting-consent");
    dp("consentX.v").set("declined");
    await flush();
    expect(el.getState().phase).toBe("declined");
    expect(create).not.toHaveBeenCalled();
  });

  it("échec de chargement : phase error avec message", async () => {
    mountSource();
    configureVision({ createEngine: async () => Promise.reject(new Error("réseau")) });
    const el = await mountTracker({ id: "h6", for: "cam", load: "auto" });
    await flush();
    expect(el.getState()).toMatchObject({ phase: "error", error: { code: "load-failed", message: "réseau" } });
  });

  it("moteur inconnu sans fabrique : unsupported", async () => {
    mountSource();
    const el = await mountTracker({ id: "h7", for: "cam", load: "auto", engine: "tfjs" });
    await flush();
    expect(el.getState().phase).toBe("unsupported");
  });

  it("map invalide signalée dans le statut", async () => {
    mountSource();
    const el = await mountTracker({ id: "h8", for: "cam", load: "manual", map: "a=1+" });
    expect(el.getState().error?.code).toBe("invalid-map");
  });

  it("retrait de l'élément : moteur fermé", async () => {
    mountSource();
    const { engine } = fakeEngine(() => []);
    configureVision({ createEngine: async () => engine });
    const el = await mountTracker({ id: "h9", for: "cam", load: "auto" });
    await flush();
    el.remove();
    expect(engine.close).toHaveBeenCalled();
  });
});


describe("téléchargement et détection asynchrone", () => {
  it("empreinte sha256 fausse : erreur hash-mismatch, moteur jamais créé", async () => {
    mountSource();
    const create = vi.fn();
    configureVision({ createEngine: create });
    const el = await mountTracker({ id: "h10", for: "cam", load: "auto", "model-sha256": "0".repeat(64) });
    await until(() => el.getState().phase === "error");
    expect(el.getState()).toMatchObject({ phase: "error", error: { code: "hash-mismatch" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("modèle trop gros : erreur too-large", async () => {
    mountSource();
    configureMl({ maxBytes: 2 });
    configureVision({ createEngine: vi.fn() });
    const el = await mountTracker({ id: "h11", for: "cam", load: "auto" });
    await flush();
    expect(el.getState()).toMatchObject({ phase: "error", error: { code: "too-large" } });
  });

  it("une seule détection à la fois : les images reçues pendant l'attente sont ignorées", async () => {
    const src = mountSource();
    let release: (h: RawHand[]) => void = () => {};
    const detect = vi.fn(() => new Promise<RawHand[]>((r) => (release = r)));
    configureVision({ createEngine: async () => ({ backend: "cpu", thread: "main", detect, close: vi.fn() }) });
    const el = await mountTracker({ id: "h12", for: "cam", load: "auto", mirror: "false" });
    await flush();
    const first = el.processFrame(100);
    src.t = 2;
    expect(await el.processFrame(133)).toBeNull();
    expect(detect).toHaveBeenCalledTimes(1);
    release([fakeHand(0.7, 0.5)]);
    expect((await first)?.count).toBe(1);
  });

  it("détection qui échoue : phase error, moteur fermé", async () => {
    mountSource();
    const close = vi.fn();
    configureVision({
      createEngine: async () => ({ backend: "cpu", thread: "main", detect: async () => Promise.reject(new Error("boum")), close }),
    });
    const el = await mountTracker({ id: "h13", for: "cam", load: "auto" });
    await flush();
    expect(await el.processFrame(10)).toBeNull();
    expect(el.getState()).toMatchObject({ phase: "error", error: { code: "detect-failed", message: "boum" } });
    expect(close).toHaveBeenCalled();
  });
});

describe("handsFromMediaPipe", () => {
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: i / 21, y: 0.5, z: 0 }));
  it("convertit, filtre par score, ignore le geste None", () => {
    const hands = handsFromMediaPipe(
      {
        landmarks: [lm, lm],
        worldLandmarks: [lm, lm],
        handednesses: [[{ categoryName: "Right", score: 0.9 }], [{ categoryName: "Left", score: 0.2 }]],
        gestures: [[{ categoryName: "None", score: 0.5 }], [{ categoryName: "Victory", score: 0.9 }]],
      },
      0.5,
    );
    expect(hands).toHaveLength(1);
    expect(hands[0]).toMatchObject({ label: "Right", score: 0.9 });
    expect(hands[0].gesture).toBeUndefined();
    expect(hands[0].landmarks).toHaveLength(21);
  });
  it("ignore les mains incomplètes", () => {
    expect(handsFromMediaPipe({ landmarks: [lm.slice(0, 5)] }, 0)).toEqual([]);
  });
});
