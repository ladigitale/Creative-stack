import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { configureMl, resetMlConfig, type ConsentStore } from "../../shared/ml/trust";
import { configureVision, resetVisionConfig, type MpEngine, type MpEngineOptions, type MpPointOfInterest, type MpResult } from "./mp-engine";
import { SonicClickSegmenter, parsePoint } from "./click-segmenter";
import { SEGMENT_LABELS, resolveClasses } from "../../shared/ml/segment-classes";
import { DEFAULT_POLICY } from "../../shared/ml/trust";
import couleurCheveux from "./examples/couleur-cheveux.sdui.json";
import clicObjet from "./examples/clic-objet.sdui.json";
import manifestJson from "./manifest.json";

void SonicClickSegmenter;

const consent = (): ConsentStore => {
  const m = new Map<string, "accepted" | "declined">();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), clear: (k) => void m.delete(k) };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

function mountSource() {
  const el = document.createElement("div") as unknown as HTMLElement & { getFrameSource: () => unknown; getFrameCanvas: () => null; frameSeq: number; t: number };
  el.id = "cam";
  el.t = 1;
  const video = { readyState: 4, videoWidth: 640, get currentTime() { return el.t; } };
  el.getFrameSource = () => video;
  el.getFrameCanvas = () => null;
  el.frameSeq = 0;
  document.body.appendChild(el);
  return el;
}

function stubCanvas() {
  const ctx = {
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => undefined,
    clearRect: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
  return ctx;
}

const MASK: MpResult = { masks: [{ width: 4, height: 2, data: new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255]) }] };

function fakeMp() {
  const calls: Array<MpPointOfInterest | undefined> = [];
  const seen: MpEngineOptions[] = [];
  const create = async (o: MpEngineOptions): Promise<MpEngine> => {
    seen.push(o);
    return { backend: "cpu", thread: "main", detect: async (_f, _t, point) => (calls.push(point), MASK), close: () => undefined };
  };
  return { create, calls, seen };
}

type El = SonicClickSegmenter & { processFrame(n: number): Promise<Record<string, unknown> | null> };
async function mount(attrs: Record<string, string>) {
  const el = document.createElement("sonic-click-segmenter") as El;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  await flush();
  return el;
}
const tick = (n: number) => ((document.getElementById("cam") as unknown as { t: number }).t = n);

beforeEach(() => {
  configureMl({ consent: consent() });
  configureVision({ fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])) });
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  resetMlConfig();
  resetVisionConfig();
});

describe("parsePoint", () => {
  it("chaîne, tableau, objet ; hors image ou invalide : null", () => {
    expect(parsePoint("0.25, 0.5")).toEqual({ x: 0.25, y: 0.5 });
    expect(parsePoint([0.1, 0.2])).toEqual({ x: 0.1, y: 0.2 });
    expect(parsePoint({ x: 1, y: 0 })).toEqual({ x: 1, y: 0 });
    for (const bad of ["", "0.5", "a,b", [2, 0.5], { x: -1, y: 0 }, null, undefined, 3]) expect(parsePoint(bad)).toBeNull();
  });
});

describe("sonic-click-segmenter", () => {
  it("tâche interactive, modèle par défaut ; sans point : aucun appel au modèle", async () => {
    mountSource();
    stubCanvas();
    const mp = fakeMp();
    configureVision({ createMpEngine: mp.create });
    const el = await mount({ id: "c1", for: "cam", load: "auto", mirror: "false", smooth: "0" });
    expect(mp.seen[0]).toMatchObject({ task: "interactive" });
    expect(el.getState().model?.url).toContain("interactive_segmenter");
    expect(await el.processFrame(100)).toMatchObject({ present: 0, point: null });
    expect(mp.calls).toHaveLength(0);
  });

  it("point : masque de l'objet, point transmis au modèle et publié", async () => {
    mountSource();
    stubCanvas();
    const mp = fakeMp();
    configureVision({ createMpEngine: mp.create });
    const el = await mount({ id: "c2", for: "cam", load: "auto", mirror: "false", smooth: "0", point: "0.7,0.3" });
    const out = (await el.processFrame(100)) as unknown as { present: number; coverage: number; point: { x: number; y: number } };
    expect(mp.calls[0]).toEqual({ x: 0.7, y: 0.3 });
    expect(out).toMatchObject({ present: 1, point: { x: 0.7, y: 0.3 } });
    expect(out.coverage).toBeCloseTo(0.5);
    expect(el.frameSeq).toBe(1);
  });

  it("miroir : un point d'écran devient le point de l'image brute", async () => {
    mountSource();
    stubCanvas();
    const mp = fakeMp();
    configureVision({ createMpEngine: mp.create });
    const el = await mount({ id: "c3", for: "cam", load: "auto", mirror: "true", smooth: "0", point: "0.8,0.5" });
    await el.processFrame(100);
    expect(mp.calls[0]?.x).toBeCloseTo(0.2);
    expect(mp.calls[0]?.y).toBe(0.5);
  });

  it("clic sur un élément : point relatif à sa boîte ; effacer le point vide le masque", async () => {
    mountSource();
    const ctx = stubCanvas();
    const mp = fakeMp();
    configureVision({ createMpEngine: mp.create });
    const view = document.createElement("div");
    view.id = "vue";
    view.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 100, right: 300, bottom: 150, x: 100, y: 50, toJSON: () => ({}) });
    document.body.appendChild(view);
    const el = await mount({ id: "c4", for: "cam", load: "auto", mirror: "false", smooth: "0", "click-on": "#vue" });
    view.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 250, clientY: 100 }));
    expect(el.getPoint()).toEqual({ x: 0.75, y: 0.5 });
    await el.processFrame(100);
    expect(mp.calls[0]).toEqual({ x: 0.75, y: 0.5 });
    const seq = el.frameSeq;
    tick(2);
    el.setPoint(null);
    expect(ctx.clearRect).toHaveBeenCalled();
    expect(el.frameSeq).toBe(seq + 1);
    expect(await el.processFrame(200)).toMatchObject({ present: 0, point: null });
  });

  it("point-from : suit un DataProvider ; live=false : une seule segmentation par point", async () => {
    mountSource();
    stubCanvas();
    const mp = fakeMp();
    configureVision({ createMpEngine: mp.create });
    set("clicPoint", { x: 0.4, y: 0.6 });
    const el = await mount({ id: "c5", for: "cam", load: "auto", mirror: "false", smooth: "0", "point-from": "clicPoint", live: "false" });
    await el.processFrame(100);
    tick(2);
    await el.processFrame(200);
    expect(mp.calls).toHaveLength(1);
    set("clicPoint", { x: 0.5, y: 0.5 });
    tick(3);
    await el.processFrame(300);
    expect(mp.calls).toEqual([{ x: 0.4, y: 0.6 }, { x: 0.5, y: 0.5 }]);
  });
});

describe("modèles et exemples", () => {
  it("alias de segmentation, classes des exemples valides", () => {
    for (const a of ["selfie-multiclass", "hair-segmenter", "deeplab-v3", "interactive-segmenter"]) expect(DEFAULT_POLICY.aliases[a], a).toMatch(/^https:\/\/storage\.googleapis\.com\//);
    expect(resolveClasses("hair, clothes", SEGMENT_LABELS["selfie-multiclass"], 6).unknown).toEqual([]);
  });

  type N = { tagName: string; attributes?: Record<string, string>; nodes?: N[] };
  const flat = (doc: unknown) => {
    const all: N[] = [];
    const walk = (x: { nodes?: N[] }) => (x.nodes ?? []).forEach((c) => (all.push(c), walk(c)));
    walk(doc as { nodes?: N[] });
    return all;
  };

  it.each([
    ["couleur-cheveux", couleurCheveux, "sonic-segmenter"],
    ["clic-objet", clicObjet, "sonic-click-segmenter"],
  ])("%s : segmenteur, synchro et remplacement bien reliés", (_n, doc, tag) => {
    const all = flat(doc);
    const seg = all.find((n) => n.tagName === tag)!.attributes!;
    const sync = all.find((n) => n.tagName === "sonic-frame-sync")!.attributes!;
    const replace = all.find((n) => n.tagName === "sonic-mask-replace")!.attributes!;
    expect(sync.sync).toBe(seg.id);
    expect(replace.mask).toBe(seg.id);
    expect(replace.source).toBe(sync.id);
    if (seg["click-on"]) expect(all.some((n) => `#${n.attributes?.id}` === seg["click-on"])).toBe(true);
    for (const v of all.filter((n) => n.tagName === "sonic-value")) expect(v.attributes!.dataProvider).toBe(seg.id);
  });

  it("le manifeste liste les exemples et le composant", () => {
    const m = manifestJson as unknown as { examples: string[]; components: Array<{ name: string; props: Record<string, unknown> }> };
    expect(m.examples).toEqual(expect.arrayContaining(["examples/couleur-cheveux.sdui.json", "examples/clic-objet.sdui.json"]));
    expect(Object.keys(m.components.find((c) => c.name === "sonic-click-segmenter")!.props)).toEqual(expect.arrayContaining(["point", "point-from", "click-on", "live"]));
    expect(Object.keys(m.components.find((c) => c.name === "sonic-segmenter")!.props)).toEqual(expect.arrayContaining(["classes", "labels", "class-stats"]));
  });
});
