import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./index";
import { type SonicVideoExport, type VideoExportState } from "./index";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";
import { activeVirtualClock } from "../../shared/virtual-time";

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

/* ------------------------------------------------------------------ */
/* Mode offline : temps virtuel                                       */
/* ------------------------------------------------------------------ */

/** Vrai rAF simulé : un rafraîchissement par tâche, même horodatage pour tous les rappels. */
function installFakeRaf() {
  const pending = new Map<number, (t: number) => void>();
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    const t = performance.now();
    const batch = [...pending.values()];
    pending.clear();
    for (const cb of batch) cb(t);
  };
  const raf = (cb: (t: number) => void) => {
    pending.set(++seq, cb);
    timer ??= setTimeout(fire, 1);
    return seq;
  };
  const caf = (id: number) => void pending.delete(id);
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", caf);
  return { raf, caf };
}

/** Source animée à la manière de sonic-shader : boucle rAF, temps pris de performance.now() et du rAF. */
function mountAnimated(id: string) {
  const el = mountSource(id) as ReturnType<typeof mountSource> & { t: number; nowAtDraw: number; draws: number; stopped: boolean };
  el.t = NaN;
  el.draws = 0;
  el.stopped = false;
  const loop = (t: number) => {
    if (el.stopped) return;
    el.t = t;
    el.nowAtDraw = performance.now();
    el.draws++;
    el.frameSeq++;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return el;
}

/** Ce que l'export lit de la source à chaque capture. */
function spyCaptures(src: { t: number; nowAtDraw: number }) {
  const seen: { t: number; now: number }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }, "getContext").mockImplementation(() => ({
    fillRect() {},
    drawImage() {
      seen.push({ t: src.t, now: src.nowAtDraw });
    },
    fillStyle: "",
  }));
  return seen;
}

async function until(cond: () => boolean, max = 400) {
  for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
}

describe("sonic-video-export mode offline", () => {
  it("temps virtuel : chaque image à exactement n / fps, rendu lent ou pas ; fonctions restaurées", async () => {
    const real = installFakeRaf();
    const perfNow = performance.now;
    const dateNow = Date.now;
    const src = mountAnimated("anim");
    const seen = spyCaptures(src);
    const el = await mount({ id: "vo1", source: "#anim", mode: "offline", fps: "25", frames: "6" });
    expect(await el.start()).toBe(true);
    expect(activeVirtualClock()).not.toBeNull();
    expect(requestAnimationFrame).not.toBe(real.raf);
    await until(() => !!state("vo1State").file);
    const enc = FakeEncoder.last!;
    expect(enc.encoded.map((e) => e.timestamp)).toEqual([0, 1, 2, 3, 4, 5].map((i) => i * 40_000));
    expect(seen).toHaveLength(6);
    // Image n : la source a dessiné à origine + n × 40 ms, horloge et timestamp rAF d'accord.
    seen.forEach((s, i) => {
      expect(s.t - seen[0].t).toBeCloseTo(i * 40, 9);
      if (i > 0) expect(s.now).toBe(s.t);
    });
    expect(state("vo1State")).toMatchObject({ mode: "offline", frames: 6, seconds: 0.24, progress: 1, active: false, encoding: false, error: null });
    // Temps réel rendu à la page ; la boucle de la source continue au vrai rythme.
    expect(activeVirtualClock()).toBeNull();
    expect(requestAnimationFrame).toBe(real.raf);
    expect(cancelAnimationFrame).toBe(real.caf);
    expect(performance.now).toBe(perfNow);
    expect(Date.now).toBe(dateNow);
    const draws = src.draws;
    await until(() => src.draws > draws + 1);
    src.stopped = true;
  });

  it("une seule capture offline par page ; cancel et retrait du composant restaurent l'horloge", async () => {
    const real = installFakeRaf();
    const src = mountAnimated("a2");
    spyCaptures(src);
    const a = await mount({ id: "vo2", source: "#a2", mode: "offline" });
    const b = await mount({ id: "vo3", source: "#a2", mode: "offline" });
    expect(await a.start()).toBe(true);
    expect(await b.start()).toBe(false);
    expect(state("vo3State").error).toContain("déjà en cours");
    await until(() => state("vo2State").frames >= 3);
    expect(a.cancel()).toBe(true);
    expect(activeVirtualClock()).toBeNull();
    expect(requestAnimationFrame).toBe(real.raf);
    // Le second peut maintenant démarrer ; le retirer de la page restaure aussi.
    expect(await b.start()).toBe(true);
    expect(activeVirtualClock()).not.toBeNull();
    b.remove();
    expect(activeVirtualClock()).toBeNull();
    expect(requestAnimationFrame).toBe(real.raf);
    src.stopped = true;
  });

  it("erreur d'encodage en cours de capture : horloge restaurée, fichier gardé, erreur lisible", async () => {
    const real = installFakeRaf();
    const src = mountAnimated("a3");
    spyCaptures(src);
    let made = 0;
    class Breaking extends FakeFrame {
      constructor(s: unknown, init: { timestamp: number; duration?: number }) {
        if (++made > 3) throw new Error("plus de mémoire");
        super(s, init);
      }
    }
    vi.stubGlobal("VideoFrame", Breaking);
    const el = await mount({ id: "vo4", source: "#a3", mode: "offline", frames: "10" });
    await el.start();
    await until(() => !state("vo4State").encoding);
    expect(activeVirtualClock()).toBeNull();
    expect(requestAnimationFrame).toBe(real.raf);
    const s = state("vo4State");
    expect(s.error).toContain("image refusée");
    expect(s.frames).toBe(3);
    expect(s.file).not.toBeNull();
    src.stopped = true;
  });
});

/* ------------------------------------------------------------------ */
/* Son en mode live                                                   */
/* ------------------------------------------------------------------ */

type FakeAudioData = { timestamp: number; duration: number; sampleRate: number; numberOfChannels: number; numberOfFrames: number; closed: boolean; close(): void };

class FakeAudioEncoder {
  static supported = true;
  static last: FakeAudioEncoder | null = null;
  config: Record<string, unknown> | null = null;
  encoded: number[] = [];
  closed = false;
  encodeQueueSize = 0;
  private pending: Promise<void>[] = [];
  constructor(private init: { output: (c: unknown, m?: unknown) => void; error: (e: unknown) => void }) {
    FakeAudioEncoder.last = this;
  }
  static async isConfigSupported(c: { codec: string }) {
    return { supported: FakeAudioEncoder.supported && c.codec === "opus" };
  }
  configure(c: Record<string, unknown>) {
    this.config = c;
  }
  encode(d: FakeAudioData) {
    const first = this.encoded.length === 0;
    const timestamp = d.timestamp;
    this.encoded.push(timestamp);
    this.pending.push(
      Promise.resolve().then(() => {
        if (this.closed) return;
        const meta = first ? { decoderConfig: { description: new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 1, 0x80, 0xbb, 0, 0, 0, 0, 0]) } } : undefined;
        this.init.output({ type: "key", timestamp, byteLength: 3, copyTo: (x: Uint8Array) => x.set([0xa, 0xb, 0xc]) }, meta);
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

/** MediaStreamTrackProcessor doublé : on pousse les AudioData à la main. */
class FakeProcessor {
  static last: FakeProcessor | null = null;
  push!: (d: FakeAudioData) => void;
  cancelled = false;
  readable: { getReader(): { read(): Promise<{ done: boolean; value?: FakeAudioData }>; cancel(): Promise<void> } };
  constructor(public init: { track: unknown }) {
    FakeProcessor.last = this;
    const queue: FakeAudioData[] = [];
    let wake: (() => void) | null = null;
    this.push = (d) => {
      queue.push(d);
      wake?.();
    };
    this.readable = {
      getReader: () => ({
        read: async () => {
          while (!queue.length && !this.cancelled) await new Promise<void>((r) => (wake = r));
          return this.cancelled ? { done: true } : { done: false, value: queue.shift()! };
        },
        cancel: async () => {
          this.cancelled = true;
          wake?.();
        },
      }),
    };
  }
}

function audioData(timestampUs: number, frames = 960): FakeAudioData {
  return { timestamp: timestampUs, duration: (frames / 48000) * 1e6, sampleRate: 48000, numberOfChannels: 2, numberOfFrames: frames, closed: false, close() { this.closed = true; } };
}

function mountAudioSource(id: string) {
  const track = { stopped: false, stop() { this.stopped = true; } };
  const dest = { channelCount: 0, stream: { getAudioTracks: () => [track] } };
  const ctx = { sampleRate: 48000, createMediaStreamDestination: () => dest };
  const node = { context: ctx, connected: [] as unknown[], connect(d: unknown) { this.connected.push(d); }, disconnect(d: unknown) { this.connected = this.connected.filter((x) => x !== d); } };
  const el = document.createElement("div") as HTMLDivElement & { getAudioOutput(): unknown };
  el.id = id;
  el.getAudioOutput = () => node;
  document.body.appendChild(el);
  return { node, track, dest };
}

describe("sonic-video-export son (mode live)", () => {
  beforeEach(() => {
    FakeAudioEncoder.supported = true;
    vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
    vi.stubGlobal("MediaStreamTrackProcessor", FakeProcessor);
  });

  it("piste Opus : AudioData encodées, recalées sur le temps de la vidéo, piste A_OPUS dans le fichier", async () => {
    const src = mountSource("scene");
    const snd = mountAudioSource("synth");
    const el = await mount({ id: "va1", source: "#scene", mode: "live", "audio-source": "#synth" });
    expect(await el.start()).toBe(true);
    expect(state("va1State")).toMatchObject({ audio: true, warning: null });
    expect(snd.node.connected).toEqual([snd.dest]);
    expect(snd.dest.channelCount).toBe(2);
    const t0 = performance.now();
    src.frameSeq++;
    el.step(t0 + 1);
    // Horloge des AudioData quelconque (ici 5 s) : recalée au premier paquet.
    const p = FakeProcessor.last!;
    const packets = [audioData(5_000_000), audioData(5_020_000), audioData(5_040_000)];
    for (const d of packets) p.push(d);
    await flush();
    const aenc = FakeAudioEncoder.last!;
    expect(aenc.config).toMatchObject({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
    expect(aenc.encoded).toEqual([5_000_000, 5_020_000, 5_040_000]);
    expect(packets.every((d) => d.closed)).toBe(true);
    src.frameSeq++;
    el.step(t0 + 40);
    await el.stop();
    expect(p.cancelled).toBe(true);
    expect(snd.track.stopped).toBe(true);
    expect(snd.node.connected).toEqual([]);
    const s = state("va1State");
    expect(s).toMatchObject({ audio: true, warning: null, frames: 2 });
    const bytes = await bytesOf(blobs.get(s.file!.url)!);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.includes("A_OPUS")).toBe(true);
    expect(text.includes("OpusHead")).toBe(true);
    // Trois SimpleBlocks audio (piste 2, image clé) dont les écarts gardent 20 ms (temps absolu =
    // Timecode du cluster + temps relatif ; un premier cluster peut ne contenir que du son).
    const audioBlocks: number[] = [];
    let clusterMs = 0;
    for (let i = 0; i + 7 < bytes.length; i++) {
      if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) {
        // Cluster : taille sur 1 à 8 octets, puis Timecode (e7, taille 8n, valeur).
        let j = i + 4;
        let len = 1;
        while (!(bytes[j] & (0x80 >> (len - 1)))) len++;
        j += len;
        expect(bytes[j]).toBe(0xe7);
        const n = bytes[j + 1] & 0x7f;
        clusterMs = 0;
        for (let k = 0; k < n; k++) clusterMs = clusterMs * 256 + bytes[j + 2 + k];
      }
      if (bytes[i] === 0xa3 && bytes[i + 1] === 0x87 && bytes[i + 2] === 0x82 && bytes[i + 5] === 0x80 && bytes[i + 6] === 0x0a) {
        audioBlocks.push(clusterMs + ((bytes[i + 3] << 8) | bytes[i + 4]));
      }
    }
    expect(audioBlocks).toHaveLength(3);
    expect(audioBlocks[1] - audioBlocks[0]).toBe(20);
    expect(audioBlocks[2] - audioBlocks[1]).toBe(20);
  });

  it("replis : pas d'Opus → vidéo sans son avec warning ; son ignoré hors mode live ; none par défaut", async () => {
    const src = mountSource("scene2");
    mountAudioSource("synth2");
    FakeAudioEncoder.supported = false;
    const a = await mount({ id: "va2", source: "#scene2", mode: "live", "audio-source": "#synth2" });
    expect(await a.start()).toBe(true);
    expect(state("va2State")).toMatchObject({ audio: false });
    expect(state("va2State").warning).toContain("Opus");
    src.frameSeq++;
    a.step(performance.now());
    await a.stop();
    expect(state("va2State").file).not.toBeNull();

    FakeAudioEncoder.supported = true;
    const b = await mount({ id: "va3", source: "#scene2", "audio-source": "#synth2" });
    await b.start();
    expect(state("va3State").warning).toContain("seulement en mode live");
    b.cancel();

    vi.stubGlobal("AudioEncoder", undefined);
    const c = await mount({ id: "va4", source: "#scene2", mode: "live", "audio-source": "#synth2" });
    await c.start();
    expect(state("va4State").warning).toContain("AudioEncoder");
    c.cancel();

    const d = await mount({ id: "va5", source: "#scene2", mode: "live" });
    await d.start();
    expect(state("va5State")).toMatchObject({ audio: false, warning: null });
    d.cancel();
  });
});
