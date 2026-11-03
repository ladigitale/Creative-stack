import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { configureMl, resetMlConfig, type ConsentStore } from "../../shared/ml/trust";
import { configureVision, resetVisionConfig, type MpEngine, type MpEngineOptions, type MpResult } from "./mp-engine";
import { SonicFaceTracker } from "./face-tracker";
import { SonicPoseTracker } from "./pose-tracker";
import { fakePose, mpFaceResult } from "./test-bodies";

void SonicFaceTracker;
void SonicPoseTracker;

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
