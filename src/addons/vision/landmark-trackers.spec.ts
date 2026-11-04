import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { configureMl, resetMlConfig, type ConsentStore } from "../../shared/ml/trust";
import { configureVision, resetVisionConfig, type MpEngine, type MpEngineOptions, type MpResult } from "./mp-engine";
import { SonicFaceTracker } from "./face-tracker";
import { SonicPoseTracker } from "./pose-tracker";
import { SonicObjectDetector } from "./object-detector";
import { SonicSegmenter } from "./segmenter";
import { fakePose, mpFaceResult } from "./test-bodies";

void SonicFaceTracker;
void SonicPoseTracker;
void SonicObjectDetector;
void SonicSegmenter;

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

const MODEL = new Uint8Array([1, 2, 3]);
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeMp(result: () => MpResult) {
  const seen: MpEngineOptions[] = [];
  const close = vi.fn();
  const create = async (o: MpEngineOptions): Promise<MpEngine> => {
    seen.push(o);
    return { backend: "gpu", thread: "worker", detect: async () => result(), close };
  };
  return { create, seen, close };
}

async function mount(tag: string, attrs: Record<string, string>) {
  const el = document.createElement(tag) as HTMLElement & { updateComplete: Promise<boolean>; getState(): { phase: string; model: { url: string } | null; thread: string | null; error: { code: string } | null }; processFrame(now: number): Promise<Record<string, unknown> | null> };
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

beforeEach(() => {
  configureMl({ consent: memoryConsent() });
  configureVision({ fetchImpl: async () => new Response(MODEL.slice()) });
});
afterEach(() => {
  document.body.innerHTML = "";
  resetMlConfig();
  resetVisionConfig();
});

describe("sonic-face-tracker", () => {
  it("modèle face-landmarker, blendshapes demandés, sortie publiée", async () => {
    mountSource();
    const mp = fakeMp(() => mpFaceResult({ jawOpen: 0.6, mouthSmileLeft: 0.2, mouthSmileRight: 0.4 }));
    configureVision({ createMpEngine: mp.create });
    const el = await mount("sonic-face-tracker", { id: "f1", for: "cam", load: "auto", mirror: "true", smooth: "0", map: "cut=500+mouthOpen*2000" });
    await flush();
    expect(el.getState()).toMatchObject({ phase: "ready", thread: "worker" });
    expect(el.getState().model?.url).toContain("face_landmarker");
    expect(mp.seen[0]).toMatchObject({ task: "face", options: { numFaces: 1, outputFaceBlendshapes: true } });
    expect(mp.seen[0].model).toEqual(MODEL);

    const out = await el.processFrame(1000);
    expect(out).toMatchObject({ present: 1, count: 1 });
    expect(dp("f1").get()).toMatchObject({ present: 1 });
    expect((dp("f1").get() as { mouthOpen: number }).mouthOpen).toBeCloseTo(0.6);
    expect((dp("f1").get() as { cut: number }).cut).toBeCloseTo(1700);
    expect((dp("f1").get() as { smile: number }).smile).toBeCloseTo(0.3);
  });

  it("publie l'identité de l'image analysée (frameSeq, frameTime, capturedAt, latencyMs)", async () => {
    const cam = mountSource();
    cam.frameSeq = 42;
    cam.t = 3.5;
    const mp = fakeMp(() => mpFaceResult({}));
    configureVision({ createMpEngine: mp.create });
    const el = await mount("sonic-face-tracker", { id: "f1m", for: "cam", load: "auto", mirror: "false" });
    await flush();
    const out = (await el.processFrame(1000)) as Record<string, number>;
    expect(out).toMatchObject({ frameSeq: 42, frameTime: 3.5, capturedAt: expect.any(Number) });
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(dp("f1m").get()).toMatchObject({ frameSeq: 42, frameTime: 3.5 });
  });

  it("max-faces borné à 2, landmarks à la demande", async () => {
    mountSource();
    const mp = fakeMp(() => mpFaceResult({}));
    configureVision({ createMpEngine: mp.create });
    const el = await mount("sonic-face-tracker", { id: "f2", for: "cam", load: "auto", "max-faces": "9", landmarks: "true", mirror: "false" });
    await flush();
    expect(mp.seen[0].options).toMatchObject({ numFaces: 2 });
    const out = await el.processFrame(10);
    expect((out as { faces: Array<{ landmarks?: unknown[] }> }).faces[0].landmarks).toHaveLength(478);
  });

  it("retrait : moteur fermé", async () => {
    mountSource();
    const mp = fakeMp(() => ({}));
    configureVision({ createMpEngine: mp.create });
    const el = await mount("sonic-face-tracker", { id: "f3", for: "cam", load: "auto" });
    await flush();
    el.remove();
    expect(mp.close).toHaveBeenCalled();
  });
});

describe("sonic-pose-tracker", () => {
  const poseResult = () => ({ landmarks: fakePose(0, 0).landmarks, worldLandmarks: undefined });

  it("modèle pose-landmarker léger par défaut, sortie nommée", async () => {
    mountSource();
    const mp = fakeMp(() => ({ landmarks: [poseResult().landmarks] }));
    configureVision({ createMpEngine: mp.create });
    const el = await mount("sonic-pose-tracker", { id: "p1", for: "cam", load: "auto", mirror: "true", smooth: "0", map: "pitch=raiseLeft*3600" });
    await flush();
    expect(el.getState().phase).toBe("ready");
    expect(el.getState().model?.url).toContain("pose_landmarker_lite");
    expect(mp.seen[0]).toMatchObject({ task: "pose", options: { numPoses: 1 } });
    const out = await el.processFrame(500);
    expect(out).toMatchObject({ present: 1, count: 1 });
    const d = dp("p1").get() as { raiseLeft: number; pitch: number; joints: { leftWrist: { x: number } } };
    expect(d.raiseLeft).toBeGreaterThan(0.9);
    expect(d.pitch).toBeCloseTo(d.raiseLeft * 3600);
    expect(d.joints.leftWrist.x).toBeCloseTo(0.8);
  });

  it("modèle full par alias, max-poses borné", async () => {
    mountSource();
    const mp = fakeMp(() => ({}));
    configureVision({ createMpEngine: mp.create });
    const el = await mount("sonic-pose-tracker", { id: "p2", for: "cam", load: "auto", model: "pose-landmarker-full", "max-poses": "9" });
    await flush();
    expect(el.getState().model?.url).toContain("pose_landmarker_full");
    expect(mp.seen[0].options).toMatchObject({ numPoses: 4 });
  });

  it("URL libre hors origines : refusée, comme pour les mains", async () => {
    mountSource();
    const create = vi.fn();
    configureVision({ createMpEngine: create });
    const el = await mount("sonic-pose-tracker", { id: "p3", for: "cam", load: "auto", model: "https://evil.example/p.task" });
    await flush();
    expect(el.getState()).toMatchObject({ phase: "error", error: { code: "origin-not-allowed" } });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("sonic-object-detector", () => {
  const detResult = () => ({
    size: { width: 640, height: 480 },
    detections: [{ boundingBox: { originX: 64, originY: 48, width: 128, height: 96 }, categories: [{ categoryName: "cup", score: 0.8 }] }],
  });

  it("modèle par défaut, options, sortie normalisée", async () => {
    mountSource();
    const mp = fakeMp(detResult);
    configureVision({ createMpEngine: mp.create });
    const el = await mount("sonic-object-detector", { id: "d1", for: "cam", load: "auto", mirror: "false", categories: "cup, person", "max-results": "3", "min-score": "0.4" });
    await flush();
    expect(el.getState().model?.url).toContain("efficientdet_lite0");
    expect(mp.seen[0]).toMatchObject({ task: "detect", options: { maxResults: 3, scoreThreshold: 0.4, categoryAllowlist: ["cup", "person"] } });
    const out = await el.processFrame(100);
    expect(out).toMatchObject({ present: 1, count: 1, label: "cup" });
    const d = dp("d1").get() as { x: number; w: number; labels: { cup: number } };
    expect(d.x).toBeCloseTo(0.1);
    expect(d.w).toBeCloseTo(0.2);
    expect(d.labels.cup).toBe(1);
  });

  it("sans catégories : pas de liste blanche", async () => {
    mountSource();
    const mp = fakeMp(() => ({ size: { width: 1, height: 1 } }));
    configureVision({ createMpEngine: mp.create });
    await mount("sonic-object-detector", { id: "d2", for: "cam", load: "auto" });
    await flush();
    expect("categoryAllowlist" in mp.seen[0].options).toBe(false);
  });
});

describe("sonic-segmenter", () => {
  const maskResult = () => ({
    masks: [
      { width: 4, height: 2, data: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]) }, // fond
      { width: 4, height: 2, data: new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 0, 0]) }, // personne
    ],
  });

  function stubCanvas() {
    const puts: Uint8ClampedArray[] = [];
    const ctx = {
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img: { data: Uint8ClampedArray }) => void puts.push(img.data.slice()),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    return puts;
  }

  it("masque exposé comme source d'images, statistiques publiées", async () => {
    mountSource();
    const puts = stubCanvas();
    const mp = fakeMp(maskResult);
    configureVision({ createMpEngine: mp.create });
    const el = (await mount("sonic-segmenter", { id: "s1", for: "cam", load: "auto", mirror: "false", smooth: "0" })) as unknown as SonicSegmenter & { processFrame(n: number): Promise<Record<string, unknown> | null> };
    await flush();
    expect(el.getState().model?.url).toContain("selfie_segmenter");
    expect(mp.seen[0]).toMatchObject({ task: "segment", options: { outputConfidenceMasks: true } });
    expect(el.getFrameCanvas()).toBeNull();
    expect(el.frameSeq).toBe(0);

    const out = await el.processFrame(100);
    expect(out).toMatchObject({ present: 1 });
    expect((out as { coverage: number }).coverage).toBeCloseTo(0.25); // dernier masque = personne
    expect((out as { cx: number }).cx).toBeCloseTo(0.75);
    expect(el.frameSeq).toBe(1);
    expect(el.getFrameCanvas()).not.toBeNull();
    expect(puts[0]).toHaveLength(32);
    expect(puts[0][8]).toBe(255); // gray : pixel 2 de la première ligne
    expect(puts[0][0]).toBe(0);
  });

  it("mode alpha, inversion, indice de masque explicite", async () => {
    mountSource();
    const puts = stubCanvas();
    configureVision({ createMpEngine: fakeMp(maskResult).create });
    const el = (await mount("sonic-segmenter", { id: "s2", for: "cam", load: "auto", mirror: "false", mode: "alpha", invert: "true", "mask-index": "0", smooth: "0" })) as unknown as { processFrame(n: number): Promise<Record<string, unknown> | null> };
    await flush();
    const out = await el.processFrame(100);
    expect((out as { coverage: number }).coverage).toBe(1); // masque 0 : tout couvert (les stats ne suivent pas l'inversion)
    expect([...puts[0].slice(0, 4)]).toEqual([255, 255, 255, 0]); // alpha = 255 - 255
  });

  it("personne absente : present 0 après le maintien", async () => {
    mountSource();
    stubCanvas();
    let empty = false;
    configureVision({
      createMpEngine: fakeMp(() => (empty ? { masks: [{ width: 2, height: 2, data: new Uint8ClampedArray(4) }] } : maskResult())).create,
    });
    const el = (await mount("sonic-segmenter", { id: "s3", for: "cam", load: "auto", mirror: "false", "hold-ms": "50", smooth: "0" })) as unknown as { processFrame(n: number): Promise<Record<string, unknown> | null> } & { frameSeq: number };
    await flush();
    await el.processFrame(0);
    empty = true;
    const src = document.getElementById("cam") as unknown as { t: number };
    src.t = 2;
    expect(((await el.processFrame(20)) as { present: number }).present).toBe(1);
    src.t = 3;
    expect(((await el.processFrame(500)) as { present: number }).present).toBe(0);
  });
});
