import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { configureMl, resetMlConfig, type ConsentStore } from "../../shared/ml/trust";
import { configureVision, resetVisionConfig, type MpEngine, type MpEngineOptions, type MpResult } from "./mp-engine";
import { SonicImageEmbedder, parseRegion } from "./image-embedder";

void SonicImageEmbedder;

function memoryConsent(): ConsentStore {
  const m = new Map<string, "accepted" | "declined">();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), clear: (k) => void m.delete(k) };
}

/** Source d'images canvas (640 × 480) ; `frameSeq` incrémenté pour fournir une nouvelle image. */
function mountSource(id = "cam") {
  const el = document.createElement("div") as unknown as HTMLElement & { getFrameCanvas: () => HTMLCanvasElement; frameSeq: number };
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 480;
  el.id = id;
  el.frameSeq = 1;
  el.getFrameCanvas = () => canvas;
  document.body.appendChild(el);
  return { el, canvas };
}

const MODEL = new Uint8Array([1, 2, 3]);
const flush = () => new Promise((r) => setTimeout(r, 0));
const emb = (v: number[], headIndex = 0): MpResult => ({ embeddings: [{ floatEmbedding: v, headIndex }] });

function fakeMp(result: () => MpResult) {
  const seen: MpEngineOptions[] = [];
  const frames: unknown[] = [];
  const close = vi.fn();
  const create = async (o: MpEngineOptions): Promise<MpEngine> => {
    seen.push(o);
    return { backend: "gpu", thread: "worker", detect: async (f) => (frames.push(f), result()), close };
  };
  return { create, seen, frames, close };
}

type El = SonicImageEmbedder;
async function mount(attrs: Record<string, string>) {
  const el = document.createElement("sonic-image-embedder") as El;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}
const out = (id: string) => dp(id).get() as Record<string, unknown> & { vector: number[]; box?: unknown };

/** Contexte 2D simulé : enregistre les `drawImage` du canvas de travail. */
const draws: unknown[][] = [];

beforeEach(() => {
  draws.length = 0;
  configureMl({ consent: memoryConsent() });
  configureVision({ fetchImpl: async () => new Response(MODEL.slice()) });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage: (...a: unknown[]) => void draws.push(a),
  })) as never);
});
afterEach(() => {
  document.body.innerHTML = "";
  resetMlConfig();
  resetVisionConfig();
  vi.restoreAllMocks();
});

describe("parseRegion", () => {
  it("x,y,w,h bornés à l'image ; invalide : null", () => {
    const r = parseRegion("0.1,0.2,0.3,0.4")!;
    expect([r.x, r.y]).toEqual([0.1, 0.2]);
    expect(r.w).toBeCloseTo(0.3, 6);
    expect(r.h).toBeCloseTo(0.4, 6);
    expect(parseRegion("0.8 0.5 0.5 0.8")).toEqual({ x: 0.8, y: 0.5, w: expect.closeTo(0.2, 6), h: expect.closeTo(0.5, 6) });
    expect(parseRegion("0.1,0.2,0,0.4")).toBeNull();
    expect(parseRegion("a,b,c,d")).toBeNull();
    expect(parseRegion("0.1,0.2,0.3")).toBeNull();
    expect(parseRegion("")).toBeNull();
    expect(parseRegion("1.2,0,0.3,0.3")).toBeNull();
  });
});

describe("sonic-image-embedder", () => {
  it("modèle image-embedder, tâche embed, vecteur unitaire publié, cadence 5 par défaut", async () => {
    mountSource();
    const mp = fakeMp(() => emb([3, 4]));
    configureVision({ createMpEngine: mp.create });
    const el = await mount({ id: "e1", for: "cam", load: "auto", smooth: "0" });
    await flush();
    expect(el.fps).toBe(5);
    expect(el.getState().model?.url).toContain("image_embedder");
    expect(mp.seen[0]).toMatchObject({ task: "embed", options: { l2Normalize: false, quantize: false } });
    const o = await el.processFrame(1000);
    expect(o).toMatchObject({ present: 1, dim: 2, vector: [0.6, 0.8], norm: 5, similarity: 0 });
    expect(out("e1")).toMatchObject({ present: 1, dim: 2 });
    expect(out("e1").frameSeq).toBe(1);
  });

  it("reference : similarité cosinus (tableau ou sortie d'un autre embedder), mise à jour à chaud", async () => {
    const { el: cam } = mountSource();
    const mp = fakeMp(() => emb([1, 0]));
    configureVision({ createMpEngine: mp.create });
    set("ref1", [1, 0]);
    const el = await mount({ id: "e2", for: "cam", load: "auto", smooth: "0", reference: "ref1" });
    await flush();
    expect((await el.processFrame(100))!.similarity).toBe(1);
    set("ref1", { vector: [0, 1], present: 1 });
    cam.frameSeq++;
    expect((await el.processFrame(300))!.similarity).toBe(0);
    set("ref1", [-1, 0]);
    cam.frameSeq++;
    expect((await el.processFrame(500))!.similarity).toBe(-1);
    set("ref1", "pas un vecteur");
    cam.frameSeq++;
    expect((await el.processFrame(700))!.similarity).toBe(0);
  });

  it("lissage : le vecteur mélange l'image précédente ; plus d'embedding : maintenu puis absent", async () => {
    const { el: cam } = mountSource();
    let next: MpResult = emb([1, 0]);
    configureVision({ createMpEngine: fakeMp(() => next).create });
    const el = await mount({ id: "e3", for: "cam", load: "auto", smooth: "0.5", "hold-ms": "300" });
    await flush();
    await el.processFrame(0);
    next = emb([0, 1]);
    cam.frameSeq++;
    const mixed = (await el.processFrame(200))!.vector;
    expect(mixed[0]).toBeGreaterThan(0.3);
    expect(mixed[1]).toBeGreaterThan(0.3);
    expect(Math.hypot(...mixed)).toBeCloseTo(1, 3);
    next = {};
    cam.frameSeq++;
    expect((await el.processFrame(400))!.present).toBe(1); // maintenu (hold-ms)
    cam.frameSeq++;
    expect(await el.processFrame(900)).toMatchObject({ present: 0, dim: 0, vector: [] });
  });

  it("head : lit la tête demandée ; `map` : clés dérivées", async () => {
    mountSource();
    configureVision({
      createMpEngine: fakeMp(() => ({ embeddings: [{ floatEmbedding: [1, 0], headIndex: 0 }, { floatEmbedding: [0, 1], headIndex: 1 }] })).create,
    });
    const el = await mount({ id: "e4", for: "cam", load: "auto", smooth: "0", head: "1", map: "pct=similarity*100" });
    await flush();
    const o = (await el.processFrame(10))!;
    expect(o.vector).toEqual([0, 1]);
    expect(o).toHaveProperty("pct", 0);
  });

  it("crop : sans boîte rien n'est analysé ; avec une boîte, seule cette zone est envoyée au modèle", async () => {
    const { el: cam, canvas } = mountSource();
    const mp = fakeMp(() => emb([1, 0]));
    configureVision({ createMpEngine: mp.create });
    const el = await mount({ id: "e5", for: "cam", load: "auto", smooth: "0", crop: "dets5", "crop-labels": "cup", "crop-pad": "0" });
    await flush();
    expect(await el.processFrame(0)).toMatchObject({ present: 0 });
    expect(mp.frames).toHaveLength(0);

    set("dets5", { objects: [{ label: "person", score: 0.9, x: 0, y: 0, w: 1, h: 1 }, { label: "cup", score: 0.8, x: 0.25, y: 0.5, w: 0.25, h: 0.25 }] });
    cam.frameSeq++;
    const o = (await el.processFrame(100))!;
    expect(o.present).toBe(1);
    expect(mp.frames).toHaveLength(1);
    const sent = mp.frames[0] as HTMLCanvasElement;
    expect(sent).not.toBe(canvas);
    expect([sent.width, sent.height]).toEqual([160, 120]);
    expect(draws.at(-1)).toEqual([canvas, 160, 240, 160, 120, 0, 0, 160, 120]);

    // étiquette absente : plus rien
    set("dets5", { objects: [{ label: "person", score: 0.9, x: 0, y: 0, w: 1, h: 1 }] });
    cam.frameSeq++;
    await el.processFrame(200);
    expect(mp.frames).toHaveLength(1);
  });

  it("crop en miroir : la boîte (repère écran) est retournée vers l'image brute ; zone minuscule ignorée", async () => {
    const { el: cam, canvas } = mountSource();
    const mp = fakeMp(() => emb([1, 0]));
    configureVision({ createMpEngine: mp.create });
    set("dets6", { objects: [{ label: "cup", score: 0.8, x: 0.1, y: 0.5, w: 0.25, h: 0.25 }] });
    const el = await mount({ id: "e6", for: "cam", load: "auto", smooth: "0", crop: "dets6", "crop-pad": "0", mirror: "true" });
    await flush();
    await el.processFrame(0);
    expect(draws.at(-1)).toEqual([canvas, 416, 240, 160, 120, 0, 0, 160, 120]); // x : 1 − (0,1 + 0,25) = 0,65
    set("dets6", { objects: [{ label: "cup", score: 0.8, x: 0.5, y: 0.5, w: 0.005, h: 0.005 }] });
    cam.frameSeq++;
    expect((await el.processFrame(100))!.present).toBe(1); // maintenu un instant, mais rien n'est envoyé
    expect(mp.frames).toHaveLength(1);
  });

  it("region : zone fixe ; invalide : rien n'est analysé ; sans crop ni region : image entière", async () => {
    const { el: cam, canvas } = mountSource();
    const mp = fakeMp(() => emb([1, 0]));
    configureVision({ createMpEngine: mp.create });
    const el = await mount({ id: "e7", for: "cam", load: "auto", smooth: "0", region: "0.5,0,0.5,0.5" });
    await flush();
    await el.processFrame(0);
    expect(draws.at(-1)).toEqual([canvas, 320, 0, 320, 240, 0, 0, 320, 240]);
    el.setAttribute("region", "n'importe quoi");
    await el.updateComplete;
    cam.frameSeq++;
    await el.processFrame(100);
    expect(mp.frames).toHaveLength(1);
    el.removeAttribute("region");
    await el.updateComplete;
    cam.frameSeq++;
    await el.processFrame(200);
    expect(mp.frames.at(-1)).toBe(canvas);
  });

  it("retrait : moteur fermé", async () => {
    mountSource();
    const mp = fakeMp(() => emb([1]));
    configureVision({ createMpEngine: mp.create });
    const el = await mount({ id: "e8", for: "cam", load: "auto" });
    await flush();
    el.remove();
    expect(mp.close).toHaveBeenCalled();
  });
});
