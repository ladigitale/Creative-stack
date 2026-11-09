import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dp } from "@supersoniks/concorde/utils";
import { configureHuggingFace, defineHuggingFaceModels } from "./hugging-face";
import type { HfEngine } from "./hf-engine";
import type { HfSamBox, HfSamImage, HfSamPoint } from "./hf-protocol";
import { applyGesture, fitSize, hasPrompt, parseBox, parsePoints, toPixels } from "./sam-prompts";
import { SonicSegmentAnything } from "./segment-anything";

void SonicSegmentAnything;

describe("invites SAM", () => {
  it("points : formes acceptées, bornes, étiquettes", () => {
    expect(parsePoints("0.5,0.4; 0.1,0.2,0")).toEqual([{ x: 0.5, y: 0.4, label: 1 }, { x: 0.1, y: 0.2, label: 0 }]);
    expect(parsePoints([{ x: 0.2, y: 0.3, label: 0 }, [0.4, 0.5], { x: 2, y: 0 }])).toEqual([{ x: 0.2, y: 0.3, label: 0 }, { x: 0.4, y: 0.5, label: 1 }]);
    expect(parsePoints([0.3, 0.6])).toEqual([{ x: 0.3, y: 0.6, label: 1 }]);
    expect(parsePoints({ x: 0.1, y: 0.1, positive: false })).toEqual([{ x: 0.1, y: 0.1, label: 0 }]);
    expect(parsePoints(null)).toEqual([]);
    expect(parsePoints(Array.from({ length: 40 }, () => [0.5, 0.5])).length).toBe(16);
  });
  it("boîte : ordre, formes, vide", () => {
    expect(parseBox([0.8, 0.9, 0.2, 0.1])).toEqual({ x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9 });
    expect(parseBox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ x0: 0.1, y0: 0.2, x1: 0.4, y1: expect.closeTo(0.6, 6) });
    expect(parseBox("0.1,0.1,0.1,0.5")).toBeNull();
    expect(parseBox({ x0: -1, y0: 0, x1: 1, y1: 1 })).toBeNull();
  });
  it("gestes : nouvelle sélection, ajout, exclusion, boîte", () => {
    let p = applyGesture({ points: [], box: null }, { kind: "point", x: 0.5, y: 0.5, add: false, negative: false });
    expect(p.points).toHaveLength(1);
    p = applyGesture(p, { kind: "point", x: 0.6, y: 0.5, add: true, negative: false });
    p = applyGesture(p, { kind: "point", x: 0.1, y: 0.1, add: false, negative: true });
    expect(p.points.map((q) => q.label)).toEqual([1, 1, 0]);
    p = applyGesture(p, { kind: "point", x: 0.3, y: 0.3, add: false, negative: false });
    expect(p.points).toEqual([{ x: 0.3, y: 0.3, label: 1 }]);
    p = applyGesture(p, { kind: "box", x0: 0.6, y0: 0.6, x1: 0.2, y1: 0.2 });
    expect(p).toEqual({ points: [], box: { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.6 } });
  });
  it("conversion en px et miroir", () => {
    const r = toPixels({ points: [{ x: 0.25, y: 0.5, label: 1 }], box: { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.4 } }, 200, 100, true);
    expect(r.points[0]).toEqual({ x: 150, y: 50, label: 1 });
    expect(r.box!.x0).toBeCloseTo(140);
    expect(r.box!.x1).toBeCloseTo(180);
    expect(r.box!.y1).toBeCloseTo(40);
  });
  it("invite utile et taille d'encodage", () => {
    expect(hasPrompt({ points: [{ x: 0, y: 0, label: 0 }], box: null })).toBe(false);
    expect(fitSize(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 });
    expect(fitSize(300, 200, 1024)).toEqual({ width: 300, height: 200 });
  });
});

/* --- composant, moteur simulé --- */

const calls = { load: 0, loaded: [] as string[], disposed: [] as string[], encode: [] as HfSamImage[], encodedBy: [] as string[], decode: [] as { points: HfSamPoint[]; box: HfSamBox | null }[] };
const engine: HfEngine = {
  async configure() {},
  async inspect() { return { totalBytes: 10 * 1024 * 1024, cached: false }; },
  async load() { throw new Error("pas de pipeline"); },
  async run() { return []; },
  async clear() {},
  dispose() {},
  async samLoad(m, _d, onProgress) { calls.load++; calls.loaded.push(m.alias); onProgress({ loadedBytes: 1, totalBytes: 2, percent: 50 }); return { backend: "wasm", loadMs: 3 }; },
  async samEncode(a, image) { calls.encode.push(image); calls.encodedBy.push(a); return { width: image.width, height: image.height, encodeMs: 7 }; },
  async samDispose(a) { calls.disposed.push(a); },
  async samDecode(_a, points, box) {
    calls.decode.push({ points, box });
    const w = calls.encode[calls.encode.length - 1].width, h = calls.encode[calls.encode.length - 1].height;
    const mask = new Uint8Array(w * h);
    // moitié gauche
    for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) mask[y * w + x] = 255;
    return { width: w, height: h, mask, score: 0.91, scores: [0.5, 0.91, 0.2], index: 1, decodeMs: 2 };
  },
};

const models = defineHuggingFaceModels({
  "sam2-tiny": { task: "image-segmentation", engine: "sam", repo: "onnx-community/sam2.1-hiera-tiny-ONNX", revision: "test", sizeBytes: 40_000_000 },
  "sam2-small": { task: "image-segmentation", engine: "sam", repo: "onnx-community/sam2.1-hiera-small-ONNX", revision: "test", sizeBytes: 70_000_000 },
  depth: { task: "depth-estimation", repo: "Xenova/depth-anything-small-hf", revision: "test" },
});

const origGetContext = HTMLCanvasElement.prototype.getContext;
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("sonic-segment-anything", () => {
  beforeEach(() => {
    localStorage.clear();
    calls.load = 0; calls.loaded = []; calls.disposed = []; calls.encode = []; calls.encodedBy = []; calls.decode = [];
    (HTMLCanvasElement.prototype as any).getContext = function () {
      const c = this as HTMLCanvasElement;
      return {
        drawImage() {}, clearRect() {}, putImageData() {},
        getImageData: () => ({ data: new Uint8ClampedArray(c.width * c.height * 4) }),
        createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      };
    };
    configureHuggingFace({ runtime: { source: "engine", engine, version: "t" }, models });
    document.body.innerHTML = `<canvas id="src" width="2000" height="1000"></canvas><div id="zone"></div>`;
    const zone = document.getElementById("zone")!;
    zone.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
  });
  afterEach(() => { HTMLCanvasElement.prototype.getContext = origGetContext; document.body.innerHTML = ""; });

  const mk = async (attrs: Record<string, string>) => {
    const el = document.createElement("sonic-segment-anything") as SonicSegmentAnything;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    await el.updateComplete;
    return el;
  };

  it("point → chargement, encodage réduit à 1600 px (max-side), masque et statistiques", async () => {
    const el = await mk({ for: "src", points: "0.25,0.5", "out-data-provider": "sam-a" });
    await wait(60);
    expect(calls.load).toBe(1);
    expect(calls.encode).toHaveLength(1);
    expect([calls.encode[0].width, calls.encode[0].height]).toEqual([1600, 800]);
    expect(calls.decode[0].points).toEqual([{ x: 400, y: 400, label: 1 }]);
    const s = dp("sam-a").get() as any;
    expect(s.phase).toBe("ready");
    expect(s.present).toBe(1);
    expect(s.score).toBe(0.91);
    expect(s.coverage).toBeCloseTo(0.5, 2);
    expect(s.x1).toBeCloseTo(0.5, 2);
    expect(el.getFrameCanvas()).not.toBeNull();
    expect(el.frameSeq).toBe(1);
  });

  it("nouvelles invites : pas de ré-encodage de la même image", async () => {
    const el = await mk({ for: "src", "points-from": "sam-pts" });
    dp("sam-pts").set([{ x: 0.5, y: 0.5 }]);
    await wait(50);
    dp("sam-pts").set([{ x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9, label: 0 }]);
    await wait(50);
    expect(calls.encode).toHaveLength(1);
    expect(calls.decode.length).toBeGreaterThanOrEqual(2);
    expect(calls.decode[calls.decode.length - 1].points.map((p) => p.label)).toEqual([1, 0]);
    el.encode();
    await wait(50);
    expect(calls.encode).toHaveLength(2);
  });

  it("clics : point, Maj+clic, Alt+clic, glissé = boîte ; effacement", async () => {
    const el = await mk({ for: "src", "click-on": "zone", "out-data-provider": "sam-c" });
    const zone = document.getElementById("zone")!;
    const click = (x: number, y: number, init: MouseEventInit = {}, x2 = x, y2 = y) => {
      zone.dispatchEvent(new MouseEvent("pointerdown", { clientX: x, clientY: y, bubbles: true, ...init }));
      zone.dispatchEvent(new MouseEvent("pointerup", { clientX: x2, clientY: y2, bubbles: true, ...init }));
    };
    click(50, 50);
    click(100, 50, { shiftKey: true });
    click(10, 10, { altKey: true });
    await wait(60);
    expect(el.getPrompts().points.map((p) => p.label)).toEqual([1, 1, 0]);
    click(20, 20, {}, 120, 80);
    await wait(60);
    expect(el.getPrompts()).toEqual({ points: [], box: { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.8 } });
    expect(calls.decode[calls.decode.length - 1].box).toEqual({ x0: 160, y0: 160, x1: 960, y1: 640 });
    el.clear();
    await wait(20);
    const s = dp("sam-c").get() as any;
    expect(s.present).toBe(0);
    expect(s.points).toEqual([]);
  });

  it("modèle hors liste ou non SAM : erreur publiée, rien chargé", async () => {
    await mk({ for: "src", model: "depth", points: "0.5,0.5", "out-data-provider": "sam-e" });
    await wait(30);
    expect((dp("sam-e").get() as any).error.code).toBe("not-allowed");
    expect(calls.load).toBe(0);
  });

  it("source absente : erreur no-image", async () => {
    await mk({ for: "absent", points: "0.5,0.5", "out-data-provider": "sam-n" });
    await wait(40);
    expect((dp("sam-n").get() as any).error.code).toBe("no-image");
  });

  it("changement de modèle par DataProvider : ancien libéré, image réencodée par le nouveau", async () => {
    dp("sam-q").set({ model: "sam2-tiny" });
    const el = await mk({ for: "src", "model-from": "sam-q.model", points: "0.5,0.5", "out-data-provider": "sam-m" });
    await wait(60);
    expect(calls.loaded).toEqual(["sam2-tiny"]);
    dp("sam-q").set({ model: "sam2-small" });
    await wait(120);
    expect(el.model).toBe("sam2-small");
    expect(calls.disposed).toEqual(["sam2-tiny"]);
    expect(calls.loaded).toEqual(["sam2-tiny", "sam2-small"]);
    expect(calls.encodedBy).toEqual(["sam2-tiny", "sam2-small"]);
    expect((dp("sam-m").get() as any).present).toBe(1);
  });

  it("consentement par modèle : l'accord donné à un modèle ne vaut pas pour un autre", async () => {
    dp("sam-c2").set({ model: "sam2-tiny", ok: "sam2-tiny" });
    const el = await mk({ for: "src", load: "consent", "model-from": "sam-c2.model", "consent-provider": "sam-c2.ok", points: "0.5,0.5", "out-data-provider": "sam-cs" });
    await wait(80);
    expect(calls.loaded).toEqual(["sam2-tiny"]);
    dp("sam-c2").set({ model: "sam2-small", ok: "sam2-tiny" });
    await wait(120);
    expect((dp("sam-cs").get() as any).phase).toBe("awaiting-consent");
    expect(calls.loaded).toEqual(["sam2-tiny"]);
    dp("sam-c2").set({ model: "sam2-small", ok: "sam2-small" });
    await wait(120);
    expect(calls.loaded).toEqual(["sam2-tiny", "sam2-small"]);
    expect((dp("sam-cs").get() as any).present).toBe(1);
    void el;
  });
});
