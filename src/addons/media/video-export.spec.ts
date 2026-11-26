import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./index";
import { type SonicVideoExport, type VideoExportState } from "./index";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";

type Encoded = { key: boolean; timestamp: number };

/** VideoEncoder doublé : chaque image devient un bloc de 4 octets, rendu au tour suivant. */
class FakeEncoder {
  static supported = new Set(["vp09.00.10.08", "vp8"]);
  static last: FakeEncoder | null = null;
  config: Record<string, unknown> | null = null;
  encoded: Encoded[] = [];
  closed = false;
  encodeQueueSize = 0;
  private pending: Promise<void>[] = [];
  constructor(private init: { output: (c: unknown) => void; error: (e: unknown) => void }) {
    FakeEncoder.last = this;
  }
  static async isConfigSupported(c: { codec: string }) {
    return { supported: FakeEncoder.supported.has(c.codec) };
  }
  configure(c: Record<string, unknown>) {
    this.config = c;
  }
  encode(frame: { timestamp: number }, opts?: { keyFrame?: boolean }) {
    const key = !!opts?.keyFrame;
    const timestamp = frame.timestamp;
    this.encoded.push({ key, timestamp });
    this.pending.push(
      Promise.resolve().then(() => {
        if (this.closed) return;
        this.init.output({ type: key ? "key" : "delta", timestamp, byteLength: 4, copyTo: (d: Uint8Array) => d.set([1, 2, 3, 4]) });
      }),
    );
  }
  async flush() {
    await Promise.all(this.pending);
  }
  close() {
    this.closed = true;
  }
}

class FakeFrame {
  closed = false;
  constructor(public src: unknown, public init: { timestamp: number; duration?: number }) {}
  get timestamp() {
    return this.init.timestamp;
  }
  close() {
    this.closed = true;
  }
}

const blobs = new Map<string, Blob>();
let urlSeq = 0;
const state = (name: string) => PublisherManager.get(name).get() as VideoExportState;

function mountSource(id: string, w = 321, h = 181) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const el = document.createElement("div") as HTMLDivElement & { frameSeq: number; getFrameCanvas(): HTMLCanvasElement; consumers: Set<object> };
  el.id = id;
  el.frameSeq = 0;
  el.consumers = new Set();
  el.getFrameCanvas = () => canvas;
  Object.assign(el, {
    registerFrameConsumer: (t: object) => el.consumers.add(t),
    unregisterFrameConsumer: (t: object) => el.consumers.delete(t),
  });
  document.body.appendChild(el);
  return el;
}

async function mount(attrs: Record<string, string>): Promise<SonicVideoExport> {
  const el = document.createElement("sonic-video-export") as SonicVideoExport;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** Blob de jsdom sans arrayBuffer() : lecture par FileReader. */
function bytesOf(b: Blob): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.readAsArrayBuffer(b);
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.stubGlobal("VideoEncoder", FakeEncoder);
  vi.stubGlobal("VideoFrame", FakeFrame);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  FakeEncoder.supported = new Set(["vp09.00.10.08", "vp8"]);
  vi.spyOn(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }, "getContext").mockImplementation(
    () => ({ fillRect() {}, drawImage() {}, fillStyle: "" }),
  );
  URL.createObjectURL = (b: Blob) => {
    const u = `blob:test/${++urlSeq}`;
    blobs.set(u, b);
    return u;
  };
  URL.revokeObjectURL = (u: string) => {
    blobs.delete(u);
  };
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sonic-video-export", () => {
  it("mode frames : horodatage fixe, images clés, arrêt après duration, fichier WebM et action", async () => {
    const received: SonicActionMessage[] = [];
    registerStore({ id: "veStore", dispatch: (a) => received.push(a), getState: () => ({}), reset: () => {} });
    const src = mountSource("fond");
    const el = await mount({ id: "ve1", source: "#fond", fps: "10", duration: "1", "keyframe-every": "0.5", target: "veStore", filename: "mon film" });
    expect(state("ve1State")).toMatchObject({ status: "idle", supported: true, allowed: true, active: false });
    expect(await el.start()).toBe(true);
    const enc = FakeEncoder.last!;
    expect(enc.config).toMatchObject({ codec: "vp09.00.10.08", width: 320, height: 180, framerate: 10 });
    expect(src.consumers.size).toBe(1);
    // Rendu lent (une image toutes les 500 ms) : l'horodatage reste n / fps.
    let now = performance.now();
    for (let i = 0; i < 10; i++) {
      src.frameSeq++;
      now += 500;
      expect(el.step(now)).toBe(true);
    }
    expect(el.step(now + 1000)).toBe(false); // déjà fini
    expect(enc.encoded.map((e) => e.timestamp)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => i * 100_000));
    expect(enc.encoded.map((e) => e.key)).toEqual([true, false, false, false, false, true, false, false, false, false]);
    await flush();
    await flush();
    const s = state("ve1State");
    expect(s).toMatchObject({ status: "ready", active: false, encoding: false, frames: 10, seconds: 1, progress: 1, codec: "vp09.00.10.08", width: 320, height: 180 });
    expect(s.file).toMatchObject({ name: "mon-film.webm", type: "video/webm", mime: "video/webm" });
    expect(s.file!.url).toMatch(/^blob:/);
    expect(src.consumers.size).toBe(0);
    const bytes = await bytesOf(blobs.get(s.file!.url)!);
    expect(s.file!.size).toBe(bytes.length);
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(new TextDecoder().decode(bytes).includes("V_VP9")).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "video:done", payload: { frames: 10, seconds: 1, codec: "vp09.00.10.08" } });
    unregisterStore("veStore");
  });

  it("mode frames : jamais plus vite que fps quand le rendu est rapide", async () => {
    const src = mountSource("rapide");
    const el = await mount({ id: "ve2", source: "#rapide", fps: "10" });
    await el.start();
    const t0 = performance.now();
    let sent = 0;
    for (let i = 1; i <= 60; i++) {
      src.frameSeq++;
      if (el.step(t0 + i * 16)) sent++; // ~1 s à 60 Hz
    }
    expect(sent).toBeGreaterThanOrEqual(9);
    expect(sent).toBeLessThanOrEqual(11);
    expect(state("ve2State").progress).toBeNull();
  });

  it("mode live : horodatage réel, repli VP8, stop par control, ancienne URL révoquée", async () => {
    FakeEncoder.supported = new Set(["vp8"]);
    PublisherManager.get("veCtl").set({ start: 0, stop: 0 });
    const src = mountSource("cam");
    const el = await mount({ id: "ve3", source: "#cam", mode: "live", control: "veCtl", width: "64", height: "37" });
    PublisherManager.get("veCtl").set({ start: 1, stop: 0 });
    await flush();
    await flush();
    const enc = FakeEncoder.last!;
    expect(enc.config).toMatchObject({ codec: "vp8", width: 64, height: 36 });
    const t0 = performance.now();
    for (const dt of [5, 40, 47, 120]) {
      src.frameSeq++;
      el.step(t0 + dt);
    }
    const ts = enc.encoded.map((e) => e.timestamp / 1000);
    expect(ts[1] - ts[0]).toBeGreaterThan(30);
    expect(ts[2] - ts[1]).toBeLessThan(10);
    expect(el.step(t0 + 130)).toBe(false); // pas de nouvelle image
    PublisherManager.get("veCtl").set({ start: 1, stop: 1 });
    await flush();
    await flush();
    await flush();
    const first = state("ve3State").file!.url;
    expect(state("ve3State")).toMatchObject({ codec: "vp8", frames: 4, mode: "live" });
    expect(new TextDecoder().decode(await bytesOf(blobs.get(first)!)).includes("V_VP8")).toBe(true);
    // Deuxième prise : la première URL est libérée.
    await el.start();
    src.frameSeq++;
    el.step(performance.now());
    await el.stop();
    expect(blobs.has(first)).toBe(false);
    expect(state("ve3State").file!.url).not.toBe(first);
  });

  it("cancel : rien de publié, fichier précédent gardé", async () => {
    const src = mountSource("c");
    const el = await mount({ id: "ve4", source: "#c" });
    await el.start();
    src.frameSeq++;
    el.step(performance.now());
    expect(el.cancel()).toBe(true);
    await flush();
    expect(state("ve4State")).toMatchObject({ active: false, encoding: false, file: null, frames: 0 });
    expect(FakeEncoder.last!.closed).toBe(true);
  });

  it("erreurs lisibles : source absente, WebCodecs absent, plafond de taille", async () => {
    const el = await mount({ id: "ve5", source: "#rien" });
    expect(await el.start()).toBe(false);
    expect(state("ve5State").error).toContain("introuvable");

    const src = mountSource("gros");
    const big = await mount({ id: "ve6", source: "#gros", "max-mb": "1" });
    await big.start();
    // Plafond de 1 Mo : un faux encodeur qui rend des blocs de 400 ko.
    const enc = FakeEncoder.last! as unknown as { init: { output: (c: unknown) => void } };
    const out = enc.init.output;
    enc.init.output = (c) => out({ ...(c as object), byteLength: 400_000, copyTo: () => undefined });
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) {
      src.frameSeq++;
      big.step(t0 + i * 40);
      await flush();
    }
    await flush();
    await flush();
    const s = state("ve6State");
    expect(s.error).toContain("taille maximale");
    expect(s.file).not.toBeNull();
    expect(s.active).toBe(false);

    vi.stubGlobal("VideoEncoder", undefined);
    const none = await mount({ id: "ve7", source: "#gros" });
    expect(state("ve7State")).toMatchObject({ status: "unsupported", supported: false });
    expect(await none.start()).toBe(false);
  });
});
