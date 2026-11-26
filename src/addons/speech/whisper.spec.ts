import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { configureHuggingFace, defineHuggingFaceModels, type HfEngine } from "../hugging-face-infer";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";
import { asrText, downmix, isWhisperNoise, resample, rms, SpeechSegmenter, whisperLanguage, whisperProblem, hfApiNow } from "./whisper";
import type { SonicListen } from "./listen";

const MB = 1024 * 1024;
const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
let uid = 0;

// ─── Signaux ───────────────────────────────────────────────────────────────────────────────────────────────────
const tone = (ms: number, rate: number, amp = 0.3, hz = 220) => {
  const n = Math.round((ms / 1000) * rate);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return a;
};
const hush = (ms: number, rate: number, amp = 0.001) => {
  const n = Math.round((ms / 1000) * rate);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * (i % 2 ? 1 : -1);
  return a;
};
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** Découpe en blocs de 4096 (taille du ScriptProcessor). */
const blocks = (a: Float32Array, size = 4096) => {
  const out: Float32Array[] = [];
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
  return out;
};

describe("signal", () => {
  it("rms et downmix", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
    expect(Array.from(downmix([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
  });

  it("rééchantillonnage 48 kHz, 44,1 kHz et 8 kHz → 16 kHz", () => {
    const one = resample(new Float32Array(48_000).fill(0.25), 48_000);
    expect(one.length).toBe(16_000);
    expect(one.every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
    expect(resample(new Float32Array(44_100), 44_100).length).toBe(16_000);
    // Une sinusoïde à 220 Hz reste une sinusoïde à 220 Hz (même énergie, même phase à peu près).
    const s = resample(tone(1000, 48_000, 0.5), 48_000);
    const ref = tone(1000, 16_000, 0.5);
    expect(rms(s)).toBeCloseTo(rms(ref), 2);
    let err = 0;
    for (let i = 0; i < ref.length; i++) err = Math.max(err, Math.abs(s[i] - ref[i]));
    expect(err).toBeLessThan(0.05);
    // Montée : interpolation linéaire.
    const up = resample(new Float32Array([0, 1, 0, 1]), 8_000);
    expect(up.length).toBe(8);
    expect(up[1]).toBeCloseTo(0.5);
    // Même fréquence : copie.
    const same = new Float32Array([0.1, 0.2]);
    const copy = resample(same, 16_000);
    expect(Array.from(copy)).toEqual(Array.from(same));
    expect(copy).not.toBe(same);
  });
});

describe("SpeechSegmenter (VAD)", () => {
  const rate = 48_000;

  it("silence seul : aucun segment ; parole puis silence : un segment avec un peu d'avant", () => {
    const vad = new SpeechSegmenter({ sampleRate: rate, silenceMs: 700 });
    for (const b of blocks(hush(2000, rate))) expect(vad.push(b)).toEqual([]);
    const segs: Float32Array[] = [];
    for (const b of blocks(join(tone(600, rate), hush(1000, rate)))) segs.push(...vad.push(b));
    expect(segs).toHaveLength(1);
    const ms = (segs[0].length / rate) * 1000;
    // 600 ms de parole + ~300 ms d'avant + 700 ms de silence de fin.
    expect(ms).toBeGreaterThan(1300);
    expect(ms).toBeLessThan(1800);
    expect(vad.inSpeech).toBe(false);
  });

  it("un silence plus court que silence-ms ne coupe pas la phrase", () => {
    const vad = new SpeechSegmenter({ sampleRate: rate, silenceMs: 700 });
    const segs: Float32Array[] = [];
    for (const b of blocks(join(tone(400, rate), hush(400, rate), tone(400, rate), hush(900, rate)))) segs.push(...vad.push(b));
    expect(segs).toHaveLength(1);
  });

  it("clic trop court ignoré, phrase longue coupée à 15 s, flush livre la phrase en cours", () => {
    const vad = new SpeechSegmenter({ sampleRate: 16_000 });
    expect(vad.push(join(tone(60, 16_000), hush(1000, 16_000)))).toEqual([]);
    const long = vad.push(tone(16_000, 16_000));
    expect(long).toHaveLength(1);
    expect(long[0].length).toBeLessThanOrEqual(15 * 16_000 + 16_000 * 0.03);
    expect(vad.inSpeech).toBe(true);
    const rest = vad.flush();
    expect(rest).not.toBeNull();
    expect(vad.flush()).toBeNull();
  });

  it("le seuil suit le bruit de fond", () => {
    const vad = new SpeechSegmenter({ sampleRate: 16_000, threshold: 0.01 });
    vad.push(hush(1000, 16_000, 0.008));
    expect(vad.level).toBeGreaterThan(0.02);
    // Un bruit stable ne déclenche pas de phrase.
    expect(vad.push(hush(3000, 16_000, 0.008))).toEqual([]);
  });
});

describe("Whisper : utilitaires", () => {
  it("langue, bruit, texte", () => {
    expect(whisperLanguage("fr-FR")).toBe("fr");
    expect(whisperLanguage("")).toBe("");
    expect(isWhisperNoise(" [Musique] ")).toBe(true);
    expect(isWhisperNoise("(applaudissements)")).toBe(true);
    expect(isWhisperNoise("...")).toBe(true);
    expect(isWhisperNoise("Sous-titres réalisés par la communauté d'Amara.org")).toBe(true);
    expect(isWhisperNoise("Bonjour")).toBe(false);
    expect(asrText({ text: " Bonjour. " })).toBe("Bonjour.");
    expect(asrText([{ text: "a" }, { text: "b" }])).toBe("a b");
  });
});

// ─── Flux complet (getUserMedia, AudioContext et moteur doublés) ─────────────────────────────────────────────
type Proc = { onaudioprocess: ((e: unknown) => void) | null; connect: () => void; disconnect: () => void };
class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  sampleRate = 48_000;
  destination = {};
  closed = false;
  proc: Proc | null = null;
  constructor() {
    FakeAudioContext.last = this;
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  createScriptProcessor() {
    this.proc = { onaudioprocess: null, connect() {}, disconnect() {} };
    return this.proc;
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  /** Envoie un signal au composant par blocs de 4096. */
  feed(signal: Float32Array) {
    for (const b of blocks(signal)) this.proc?.onaudioprocess?.({ inputBuffer: { numberOfChannels: 1, getChannelData: () => b } });
  }
}

function fakeMic() {
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { ...navigator, language: "fr-FR", mediaDevices: { getUserMedia, enumerateDevices: async () => [] } });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  return { track, getUserMedia };
}

function fakeEngine(opts: { totalBytes?: number; text?: string } = {}) {
  const calls = { load: 0, run: [] as { inputs: unknown[]; call: Record<string, unknown> }[] };
  const engine: HfEngine = {
    async configure() {},
    async inspect() {
      return { totalBytes: opts.totalBytes ?? 10 * MB, cached: false };
    },
    async load(_m, _d, onProgress) {
      calls.load++;
      onProgress({ loadedBytes: 5, totalBytes: 10, percent: 50 });
      return { backend: "wasm", loadMs: 1 };
    },
    async run(request) {
      calls.run.push({ inputs: request.inputs, call: request.call });
      return request.inputs.map(() => ({ text: opts.text ?? " Bonjour tout le monde." }));
    },
    async clear() {},
    dispose() {},
  };
  return { engine, calls };
}

const MODELS = defineHuggingFaceModels({
  "whisper-tiny": { task: "automatic-speech-recognition", repo: "onnx-community/whisper-tiny", revision: "test", sizeBytes: 41_000_000 },
  "whisper-en": { task: "automatic-speech-recognition", repo: "onnx-community/whisper-tiny.en", revision: "test" },
  labels: { task: "zero-shot-classification", repo: "Xenova/mobilebert-uncased-mnli", revision: "test" },
});

function setup(opts?: Parameters<typeof fakeEngine>[0]) {
  const fake = fakeEngine(opts);
  configureHuggingFace({ runtime: { source: "engine", engine: fake.engine, version: "test" }, models: MODELS, defaults: { consentAboveMB: 30 } });
  return fake;
}

function fakeStore(id: string): SonicActionMessage[] {
  const actions: SonicActionMessage[] = [];
  registerStore({ id, dispatch: (a) => actions.push(a), getState: () => null, reset: () => undefined });
  return actions;
}

async function mount(attrs: Record<string, string | boolean>): Promise<SonicListen> {
  const el = document.createElement("sonic-listen") as SonicListen;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  document.body.appendChild(el);
  await el.updateComplete;
  await wait(0);
  return el;
}

const speech = (rate = 48_000) => join(tone(800, rate), hush(1000, rate));

describe("sonic-listen engine=whisper", () => {
  const stores: string[] = [];
  beforeEach(() => {
    localStorage.clear();
    FakeAudioContext.last = null;
  });
  afterEach(() => {
    document.body.innerHTML = "";
    for (const s of stores.splice(0)) unregisterStore(s);
    vi.unstubAllGlobals();
  });

  it("l'addon hugging-face-infer expose son registre sans copie", () => {
    setup();
    expect(hfApiNow()?.getHuggingFaceRegistry()?.hasModel("whisper-tiny")).toBe(true);
    expect(whisperProblem(hfApiNow(), "labels")).toMatch(/pas un modèle de reconnaissance/);
    expect(whisperProblem(hfApiNow(), "inconnu")).toMatch(/absent/);
  });

  it("flux complet : micro, phrase détectée, 16 kHz, langue, listen:result et listen:match", async () => {
    const fake = setup();
    const mic = fakeMic();
    const id = `w${++uid}`;
    const actions = fakeStore(`${id}Store`);
    stores.push(`${id}Store`);
    const el = await mount({ id, engine: "whisper", lang: "fr-FR", interim: true, phrases: "bonjour", target: `${id}Store` });
    expect(el.getState()).toMatchObject({ engine: "whisper", supported: true, status: "idle", modelReady: false, modelSize: 41_000_000 });
    expect(await el.run("start")).toBe(true);
    expect(el.getState().active).toBe(true);
    await wait(10);
    expect(mic.getUserMedia).toHaveBeenCalledOnce();
    expect(el.getState()).toMatchObject({ status: "ready", listening: true, modelReady: true, loading: null });
    const ctx = FakeAudioContext.last!;
    ctx.feed(speech());
    await wait(10);
    expect(fake.calls.run).toHaveLength(1);
    const pcm = fake.calls.run[0].inputs[0] as Float32Array;
    expect(pcm).toBeInstanceOf(Float32Array);
    // ~800 ms + ~300 ms d'avant + 700 ms de silence, en 16 kHz.
    expect(pcm.length / 16_000).toBeGreaterThan(1.5);
    expect(pcm.length / 16_000).toBeLessThan(2.2);
    expect(fake.calls.run[0].call).toEqual({ task: "transcribe", language: "fr" });
    expect(el.getState()).toMatchObject({
      final: "Bonjour tout le monde.",
      transcript: "Bonjour tout le monde.",
      interim: "",
      match: { phrase: "bonjour", n: 1 },
      transcribing: false,
      // Hors mode continu : une phrase puis arrêt, comme le navigateur.
      active: false,
      listening: false,
      status: "ready",
    });
    expect(mic.track.stopped).toBe(true);
    expect(ctx.closed).toBe(true);
    expect(actions.map((a) => [a.type, a.payload])).toEqual([
      ["listen:result", { text: "…", confidence: 0, isFinal: false }],
      ["listen:match", { phrase: "bonjour", text: "Bonjour tout le monde." }],
      ["listen:result", { text: "Bonjour tout le monde.", confidence: 0, isFinal: true }],
    ]);
  });

  it("continu : plusieurs phrases cumulées ; stop livre la phrase en cours ; bruit [Musique] ignoré", async () => {
    const fake = setup();
    fakeMic();
    const el = await mount({ id: `w${++uid}`, engine: "whisper", continuous: true });
    await el.run("start");
    await wait(10);
    const ctx = FakeAudioContext.last!;
    ctx.feed(speech());
    await wait(10);
    ctx.feed(speech());
    await wait(10);
    expect(el.getState().transcript).toBe("Bonjour tout le monde. Bonjour tout le monde.");
    expect(el.getState()).toMatchObject({ active: true, listening: true });
    ctx.feed(tone(500, 48_000));
    await el.run("stop");
    await wait(10);
    expect(fake.calls.run).toHaveLength(3);
    expect(el.getState()).toMatchObject({ active: false, listening: false, status: "ready" });
    expect(ctx.closed).toBe(true);
  });

  it("consentement : modèle lourd en attente, accept charge et transcrit ; decline refuse", async () => {
    const fake = setup({ totalBytes: 41 * MB });
    fakeMic();
    const id = `w${++uid}`;
    set(`${id}Ctl`, { accept: 0 });
    const el = await mount({ id, engine: "whisper", control: `${id}Ctl` });
    await el.run("start");
    await wait(10);
    expect(el.getState()).toMatchObject({ modelPhase: "awaiting-consent", modelReady: false, listening: true });
    FakeAudioContext.last!.feed(speech());
    await wait(10);
    expect(fake.calls.run).toHaveLength(0);
    expect(el.getState().interim).toBe("…");
    set(`${id}Ctl`, { accept: 1 });
    await wait(20);
    expect(fake.calls.load).toBe(1);
    expect(el.getState()).toMatchObject({ modelReady: true, final: "Bonjour tout le monde." });

    localStorage.clear();
    setup({ totalBytes: 41 * MB });
    fakeMic();
    const el2 = await mount({ id: `w${++uid}`, engine: "whisper", "consent-provider": `${id}Consent` });
    await el2.run("start");
    await wait(10);
    set(`${id}Consent`, "declined");
    await wait(10);
    expect(el2.getState()).toMatchObject({ status: "denied", active: false, listening: false });
    expect(el2.getState().error).toMatch(/refusé/);
  });

  it("modèle anglais (.en) : pas de langue ; abort abandonne la phrase en attente", async () => {
    const fake = setup();
    fakeMic();
    const el = await mount({ id: `w${++uid}`, engine: "whisper", model: "whisper-en", continuous: true, lang: "fr-FR" });
    await el.run("start");
    await wait(10);
    FakeAudioContext.last!.feed(speech());
    await wait(10);
    expect(fake.calls.run[0].call).toEqual({});
    FakeAudioContext.last!.feed(speech());
    await el.run("abort");
    await wait(10);
    expect(el.getState()).toMatchObject({ active: false, listening: false, transcribing: false, interim: "" });
  });

  it("modèle hors liste : unsupported ; auto retombe sur le navigateur", async () => {
    setup();
    fakeMic();
    const el = await mount({ id: `w${++uid}`, engine: "whisper", model: "inconnu" });
    expect(el.getState()).toMatchObject({ engine: "whisper", status: "unsupported", supported: false });
    expect(el.getState().error).toMatch(/absent/);
    expect(await el.run("start")).toBe(false);

    class Rec {
      start() {}
      stop() {}
      abort() {}
    }
    vi.stubGlobal("SpeechRecognition", Rec);
    const auto = await mount({ id: `w${++uid}`, engine: "auto", model: "inconnu" });
    expect(auto.getState()).toMatchObject({ engine: "native", supported: true });
    const autoW = await mount({ id: `w${++uid}`, engine: "auto" });
    expect(autoW.getState()).toMatchObject({ engine: "whisper", supported: true });
  });
});
