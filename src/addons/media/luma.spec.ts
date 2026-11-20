import { afterEach, describe, expect, it } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./index";
import { LumaDetector, measureLuma, parseRegion, type LumaEdge, type LumaState, type SonicLuma } from "./index";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";

function rgba(w: number, h: number, paint: (x: number, y: number) => number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = paint(x, y);
    d.set([v, v, v, 255], (y * w + x) * 4);
  }
  return d;
}

/** Signal carré vu par une caméra à `fps` : chaque image intègre la lumière sur sa durée. */
function run(d: LumaDetector, light: (t: number) => boolean, from: number, to: number, fps = 30, lo = 0.05, hi = 0.9): LumaEdge[] {
  const out: LumaEdge[] = [];
  const step = 1000 / fps;
  for (let t = from; t <= to; t += step) {
    let lit = 0;
    for (let i = 0; i < 10; i++) if (light(t - step + ((i + 0.5) * step) / 10)) lit++;
    const e = d.feed(t, lo + (hi - lo) * (lit / 10));
    if (e) out.push(e);
  }
  return out;
}

describe("mesure", () => {
  it("moyenne, maximum et position du point le plus clair", () => {
    const m = measureLuma(rgba(8, 4, (x, y) => (x === 6 && y === 1 ? 255 : 51)), 8, 4);
    expect(m.peak).toBeCloseTo(1, 5);
    expect(m.level).toBeCloseTo((31 * 51 + 255) / 32 / 255, 5);
    expect(m.peakX).toBeCloseTo(6.5 / 8, 5);
    expect(m.peakY).toBeCloseTo(1.5 / 4, 5);
  });

  it("tampon vide : zéro, sans erreur", () => {
    expect(measureLuma(new Uint8ClampedArray(0), 0, 0)).toEqual({ level: 0, peak: 0, peakX: 0.5, peakY: 0.5 });
  });

  it("zone : bornée à l'image, entière si invalide", () => {
    expect(parseRegion("0.25,0.5,0.5,0.25")).toEqual({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 });
    expect(parseRegion("0.8,0.8,0.5,0.5").w).toBeCloseTo(0.2, 9);
    expect(parseRegion("n'importe quoi")).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(parseRegion("0,0,0,1")).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("détection des fronts", () => {
  it("signal carré : fronts alternés, durées proches de la réalité", () => {
    const d = new LumaDetector();
    // Allumé de 1000 à 1300, de 2000 à 2900.
    const edges = run(d, (t) => (t >= 1000 && t < 1300) || (t >= 2000 && t < 2900), 0, 4000);
    expect(edges.map((e) => e.on)).toEqual([true, false, true, false]);
    expect(edges[0].dur).toBe(0);
    expect(Math.abs(edges[0].t - 1000)).toBeLessThan(34);
    expect(Math.abs(edges[1].dur - 300)).toBeLessThan(34);
    expect(Math.abs(edges[2].dur - 700)).toBeLessThan(34);
    expect(Math.abs(edges[3].dur - 900)).toBeLessThan(34);
    expect(edges.map((e) => e.n)).toEqual([1, 2, 3, 4]);
    expect(d.on).toBe(false);
  });

  it("délai commande → lumière et durée commandée", () => {
    const d = new LumaDetector();
    run(d, () => false, 0, 500);
    d.mark(1000, true);
    d.mark(1600, false);
    // La lampe réagit 120 ms après l'ordre d'allumage, 60 ms après l'ordre d'extinction.
    const edges = run(d, (t) => t >= 1120 && t < 1660, 533, 2500);
    expect(edges.length).toBe(2);
    expect(Math.abs(edges[0].sinceMark! - 120)).toBeLessThan(34);
    expect(Math.abs(edges[1].sinceMark! - 60)).toBeLessThan(34);
    expect(edges[1].markGap).toBe(600);
    expect(edges[0].markGap).toBeNull();
  });

  it("une commande ne sert qu'à un front", () => {
    const d = new LumaDetector();
    run(d, () => false, 0, 500);
    d.mark(600, true);
    const edges = run(d, (t) => (t >= 700 && t < 1000) || t >= 1500, 533, 2000);
    expect(edges.map((e) => e.on)).toEqual([true, false, true]);
    expect(edges[0].sinceMark).not.toBeNull();
    expect(edges[1].sinceMark).toBeNull();
    expect(edges[2].sinceMark).toBeNull();
  });

  it("écart trop faible : pas de front", () => {
    const d = new LumaDetector();
    const edges = run(d, (t) => Math.floor(t / 300) % 2 === 0, 0, 3000, 30, 0.4, 0.43);
    expect(edges).toEqual([]);
    expect(d.signal).toBe(false);
  });

  it("dérive lente de l'exposition pendant l'allumage : pas de faux front", () => {
    const d = new LumaDetector();
    const edges: LumaEdge[] = [];
    for (let t = 0; t <= 3000; t += 33) {
      // Allumé à 1000 ; l'exposition automatique ramène ensuite l'image de 0,95 vers 0,6.
      const v = t < 1000 ? 0.05 : 0.6 + 0.35 * Math.exp(-(t - 1000) / 400);
      const e = d.feed(t, v);
      if (e) edges.push(e);
    }
    expect(edges.map((e) => e.on)).toEqual([true]);
  });

  it("seuil fixe", () => {
    const d = new LumaDetector({ threshold: 0.5 });
    const edges = run(d, (t) => t >= 500 && t < 800, 0, 1500, 30, 0.45, 0.56);
    expect(edges.map((e) => e.on)).toEqual([true, false]);
  });

  it("remise à zéro", () => {
    const d = new LumaDetector();
    run(d, (t) => t >= 500, 0, 1000);
    expect(d.on).toBe(true);
    d.reset();
    expect(d.on).toBe(false);
    expect(d.edges).toBe(0);
    expect(d.contrast).toBe(0);
  });
});

type FakeCam = HTMLElement & {
  frameSeq: number;
  getFrameCanvas: () => HTMLCanvasElement | null;
  addFrameListener?: (l: (i: { seq: number; time: number; captureTime: number | null }) => void) => () => void;
  emit: (time: number, captureTime: number | null) => void;
  removed: number;
};

function mountCam(id: string, timed = true): FakeCam {
  const el = document.createElement("div") as unknown as FakeCam;
  el.id = id;
  el.frameSeq = 0;
  el.removed = 0;
  el.getFrameCanvas = () => document.createElement("canvas");
  const listeners = new Set<(i: { seq: number; time: number; captureTime: number | null }) => void>();
  if (timed) {
    el.addFrameListener = (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
        el.removed++;
      };
    };
  }
  el.emit = (time, captureTime) => {
    el.frameSeq++;
    for (const l of listeners) l({ seq: el.frameSeq, time, captureTime });
  };
  document.body.appendChild(el);
  return el;
}

/** Monte une sonde dont les pixels viennent de `brightness.v` (0..255), image uniforme. */
async function mountLuma(attrs: Record<string, string>, brightness: { v: number }) {
  const el = document.createElement("sonic-luma") as SonicLuma;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  (el as unknown as { readPixels: () => unknown }).readPixels = () => ({ data: rgba(4, 2, () => brightness.v), width: 4, height: 2 });
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

const state = (name: string) => PublisherManager.get(name).get() as LumaState;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("sonic-luma", () => {
  it("publie niveaux et fronts, envoie une action par front, horodate à la capture", async () => {
    const received: SonicActionMessage[] = [];
    registerStore({ id: "lumaStore1", dispatch: (a) => received.push(a), getState: () => ({}), reset: () => {} });
    const cam = mountCam("cam1");
    const b = { v: 10 };
    const el = await mountLuma({ source: "#cam1", "out-data-provider": "luma1", target: "lumaStore1", interval: "16" }, b);
    const t0 = performance.now();
    const seen: LumaEdge[] = [];
    el.addEventListener("luma-edge", (e) => seen.push((e as CustomEvent<LumaEdge>).detail));
    for (let i = 0; i < 40; i++) {
      b.v = i >= 10 && i < 25 ? 230 : 10;
      cam.emit(t0 + i * 33 + 50, t0 + i * 33); // présentation 50 ms après la capture
    }
    const s = state("luma1");
    expect(s.status).toBe("ready");
    expect(s.clock).toBe("capture");
    expect(s.edges).toBe(2);
    expect(s.events.map((e) => e.on)).toEqual([true, false]);
    expect(s.on).toBe(false);
    expect(s.level).toBeCloseTo(10 / 255, 3);
    expect(Math.abs(s.events[1].dur - 15 * 33)).toBeLessThan(34);
    expect(Math.abs(s.events[0].t - (t0 + 10 * 33))).toBeLessThan(34);
    expect(s.fps).toBeGreaterThan(25);
    expect(seen.length).toBe(2);
    expect(received.map((a) => a.type)).toEqual(["edge", "edge"]);
    expect((received[1].payload as LumaEdge).on).toBe(false);
    unregisterStore("lumaStore1");
  });

  it("mark-from : délai entre la commande et la lumière", async () => {
    const cam = mountCam("cam2");
    const b = { v: 10 };
    PublisherManager.get("torch2").set({ torch: false });
    await mountLuma({ source: "#cam2", "out-data-provider": "luma2", "mark-from": "torch2.torch" }, b);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) cam.emit(t0 - 200 + i * 33, null);
    PublisherManager.get("torch2").set({ torch: true }); // ordre donné « maintenant »
    const order = performance.now();
    for (let i = 0; i < 4; i++) cam.emit(order + i * 33, null); // encore sombre jusqu'à +99 ms
    b.v = 240;
    cam.emit(order + 132, null);
    const s = state("luma2");
    expect(s.clock).toBe("frame");
    expect(s.last?.on).toBe(true);
    expect(s.last!.sinceMark!).toBeGreaterThan(95);
    expect(s.last!.sinceMark!).toBeLessThanOrEqual(133);
  });

  it("source sans écouteur d'images : relevé par tick()", async () => {
    const cam = mountCam("cam3", false);
    const b = { v: 10 };
    const el = await mountLuma({ source: "#cam3", "out-data-provider": "luma3" }, b);
    for (let i = 0; i < 20; i++) {
      b.v = i >= 8 ? 200 : 10;
      cam.frameSeq++;
      el.tick(1000 + i * 40);
      el.tick(1000 + i * 40 + 5); // même image : ignorée
    }
    const s = state("luma3");
    expect(s.clock).toBe("poll");
    expect(s.edges).toBe(1);
    expect(s.on).toBe(true);
  });

  it("réglages en direct (params) et remise à zéro (control)", async () => {
    const cam = mountCam("cam4");
    const b = { v: 10 };
    PublisherManager.get("lumaParams4").set({ active: false });
    PublisherManager.get("lumaCtl4").set({ reset: 0 });
    const el = await mountLuma({ source: "#cam4", "out-data-provider": "luma4", params: "lumaParams4", control: "lumaCtl4" }, b);
    cam.emit(1000, null);
    expect(state("luma4").status).toBe("idle");
    expect(state("luma4").active).toBe(false);
    PublisherManager.get("lumaParams4").set({ active: true, threshold: 0.5, measure: "peak" });
    expect(el.settings()).toMatchObject({ active: true, threshold: 0.5, measure: "peak" });
    for (let i = 0; i < 10; i++) {
      b.v = i >= 5 ? 250 : 10;
      cam.emit(2000 + i * 33, null);
    }
    expect(state("luma4").edges).toBe(1);
    PublisherManager.get("lumaCtl4").set({ reset: 1 });
    expect(state("luma4").edges).toBe(0);
    expect(state("luma4").events).toEqual([]);
  });

  it("source introuvable : erreur ; retirée du document : écouteur rendu", async () => {
    const b = { v: 10 };
    await mountLuma({ source: "#absente", "out-data-provider": "luma5" }, b);
    expect(state("luma5").status).toBe("error");
    const cam = mountCam("cam6");
    const el = await mountLuma({ source: "#cam6", "out-data-provider": "luma6" }, b);
    el.remove();
    expect(cam.removed).toBe(1);
  });
});
