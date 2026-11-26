import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { matchPhrase, normalizeSpeech, parsePhrases, pickVoice, recognitionError, restartDelay, splitSpeech, synthesisError, wordAt } from "./core";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";
import type { SonicSpeak, SpeakState } from "./speak";
import type { SonicListen, ListenState } from "./listen";

// ─── Doublures ─────────────────────────────────────────────────────────────────────────────────────────────────
type Restore = () => void;
let restores: Restore[] = [];
function stubGlobal(key: string, value: unknown): void {
  const g = globalThis as Record<string, unknown>;
  const had = key in g;
  const before = g[key];
  g[key] = value;
  restores.push(() => {
    if (had) g[key] = before;
    else delete g[key];
  });
}
const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
let uid = 0;

async function mount<T extends HTMLElement & { updateComplete: Promise<boolean> }>(tag: string, attrs: Record<string, string | boolean>): Promise<T> {
  const el = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function fakeStore(id: string): SonicActionMessage[] {
  const actions: SonicActionMessage[] = [];
  registerStore({ id, dispatch: (a) => actions.push(a), getState: () => null, reset: () => undefined });
  restores.push(() => unregisterStore(id));
  return actions;
}

class FakeUtterance {
  lang = "";
  voice: unknown = null;
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: ((e: unknown) => void) | null = null;
  onend: ((e: unknown) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onboundary: ((e: { charIndex?: number; charLength?: number; name?: string }) => void) | null = null;
  constructor(public text: string) {}
}

function fakeSynth(voices: Array<{ name: string; lang: string; localService?: boolean; default?: boolean }> = []) {
  const listeners: Array<() => void> = [];
  const s = {
    spoken: [] as FakeUtterance[],
    voices,
    paused: false,
    cancelled: 0,
    speak(u: FakeUtterance) {
      this.spoken.push(u);
    },
    cancel() {
      this.cancelled++;
      const last = this.spoken[this.spoken.length - 1];
      last?.onerror?.({ error: "interrupted" });
    },
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    getVoices() {
      return this.voices;
    },
    addEventListener(_t: string, h: () => void) {
      listeners.push(h);
    },
    removeEventListener() {},
    loadVoices(v: typeof voices) {
      this.voices = v;
      listeners.forEach((h) => h());
    },
  };
  stubGlobal("speechSynthesis", s);
  stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  return s;
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  started = 0;
  stopped = 0;
  aborted = 0;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
  }
  abort() {
    this.aborted++;
  }
  /** Simule un événement result : liste de [texte, final, confiance]. */
  result(items: Array<[string, boolean, number?]>, resultIndex = 0) {
    const results = items.map(([t, isFinal, c]) => Object.assign([{ transcript: t, confidence: c ?? 0.9 }], { isFinal }));
    this.onresult?.({ resultIndex, results });
  }
}
const lastRec = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];

beforeEach(() => {
  restores = [];
  FakeRecognition.instances = [];
});
afterEach(() => {
  document.body.innerHTML = "";
  for (const r of restores.reverse()) r();
  vi.useRealTimers();
});

// ─── Fonctions pures ───────────────────────────────────────────────────────────────────────────────────────────
describe("core speech", () => {
  it("splitSpeech : phrases, positions d'origine, longues phrases recoupées", () => {
    const text = "Bonjour. Comment ça va ? Très bien !";
    const chunks = splitSpeech(text);
    expect(chunks.map((c) => c.text)).toEqual(["Bonjour.", "Comment ça va ?", "Très bien !"]);
    for (const c of chunks) expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);
    const long = Array.from({ length: 60 }, (_, i) => `mot${i}`).join(" ") + ", fin";
    const parts = splitSpeech(long, 80);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(80);
      expect(long.slice(p.offset, p.offset + p.text.length)).toBe(p.text);
    }
    expect(splitSpeech("   ")).toEqual([]);
  });

  it("wordAt : mot autour d'une position, sans ponctuation", () => {
    expect(wordAt("Bonjour, le monde", 0)).toBe("Bonjour");
    expect(wordAt("Bonjour, le monde", 9)).toBe("le");
    expect(wordAt("Bonjour, le monde", 12, 5)).toBe("monde");
    expect(wordAt("abc", 10)).toBe("");
  });

  it("pickVoice : nom partiel, langue, voix par défaut", () => {
    const voices = [
      { name: "Google US English", lang: "en-US" },
      { name: "Thomas", lang: "fr-FR", localService: true },
      { name: "Amélie", lang: "fr_CA", localService: true, default: false },
      { name: "Google français", lang: "fr-FR", localService: false, default: true },
    ];
    expect(pickVoice(voices, "amélie", "")?.name).toBe("Amélie");
    expect(pickVoice(voices, "google", "fr-FR")?.name).toBe("Google français");
    expect(pickVoice(voices, "google", "")?.name).toBe("Google US English");
    expect(pickVoice(voices, "", "fr-FR")?.name).toBe("Google français");
    expect(pickVoice(voices, "", "fr")?.name).toBe("Google français");
    expect(pickVoice(voices, "", "")).toBeNull();
    expect(pickVoice([], "x", "fr")).toBeNull();
  });

  it("matchPhrase : mots entiers, sans accents ni casse, le plus long d'abord", () => {
    expect(normalizeSpeech("Précédent !")).toBe("precedent");
    const phrases = parsePhrases("suivant, précédent, page suivante");
    expect(phrases).toEqual(["suivant", "précédent", "page suivante"]);
    expect(matchPhrase("Bon, PRECEDENT s'il te plaît", phrases)).toBe("précédent");
    expect(matchPhrase("la page suivante", phrases)).toBe("page suivante");
    expect(matchPhrase("poursuivant", phrases)).toBeNull();
    expect(parsePhrases(["a", " a ", "b", 3])).toEqual(["a", "b", "3"]);
  });

  it("erreurs traduites", () => {
    expect(recognitionError("not-allowed")).toMatchObject({ status: "denied", fatal: true });
    expect(recognitionError("no-speech")).toMatchObject({ fatal: false });
    expect(recognitionError("network").error).toMatch(/serveurs/);
    expect(recognitionError("audio-capture")).toMatchObject({ fatal: true });
    expect(synthesisError("interrupted")).toBeNull();
    expect(synthesisError("not-allowed")?.status).toBe("denied");
    expect(restartDelay(0)).toBe(250);
    expect(restartDelay(3)).toBe(2000);
    expect(restartDelay(20)).toBe(8000);
  });
});

// ─── sonic-speak ───────────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-speak", () => {
  it("non supporté sans speechSynthesis", async () => {
    stubGlobal("speechSynthesis", undefined);
    const id = `v${++uid}`;
    const el = await mount<SonicSpeak>("sonic-speak", { id, text: "salut" });
    expect(el.getState()).toMatchObject({ status: "unsupported", supported: false });
    expect(await el.run("say")).toBe(false);
  });

  it("voix chargées en différé, choix par langue, lecture par morceaux et actions", async () => {
    const s = fakeSynth([]);
    const actions = fakeStore(`store${++uid}`);
    const id = `v${++uid}`;
    const el = await mount<SonicSpeak>("sonic-speak", { id, lang: "fr-FR", rate: "1.5", target: `store${uid - 1}`, text: "Première phrase. Deuxième phrase." });
    expect(el.getState().status).toBe("idle");
    s.loadVoices([{ name: "Thomas", lang: "fr-FR", localService: true }]);
    expect((get(`${id}State`) as SpeakState).voices).toEqual([{ name: "Thomas", lang: "fr-FR", local: true }]);
    expect(el.getState().status).toBe("ready");

    expect(await el.run("say")).toBe(true);
    expect(s.spoken).toHaveLength(1);
    const u1 = s.spoken[0];
    expect(u1.text).toBe("Première phrase.");
    expect(u1.lang).toBe("fr-FR");
    expect(u1.rate).toBe(1.5);
    expect((u1.voice as { name: string }).name).toBe("Thomas");
    expect(el.getState()).toMatchObject({ speaking: true, pending: true, spoken: "Première phrase. Deuxième phrase.", voice: "Thomas" });
    u1.onstart?.({});
    expect(actions.map((a) => a.type)).toEqual(["speak:start"]);
    u1.onend?.({});
    expect(s.spoken).toHaveLength(2);
    const u2 = s.spoken[1];
    u2.onstart?.({});
    u2.onboundary?.({ name: "word", charIndex: 0 });
    expect(el.getState()).toMatchObject({ charIndex: 17, word: "Deuxième" });
    u2.onend?.({});
    expect(el.getState()).toMatchObject({ speaking: false, active: false, charIndex: -1 });
    expect(actions.map((a) => a.type)).toEqual(["speak:start", "speak:end"]);
    expect(actions[1].payload).toMatchObject({ complete: true, interrupted: false });
  });

  it("params prioritaires, say {text}, stop interrompt, erreur not-allowed", async () => {
    const s = fakeSynth([{ name: "Amélie", lang: "fr-CA" }, { name: "Daniel", lang: "en-GB" }]);
    const id = `v${++uid}`;
    const p = `${id}Params`;
    set(p, { voice: "dan", rate: 3 });
    const actions = fakeStore(`${id}Store`);
    const el = await mount<SonicSpeak>("sonic-speak", { id, voice: "amélie", rate: "1", params: p, target: `${id}Store` });
    expect(el.getState().settings).toMatchObject({ voice: "dan", rate: 3 });
    await el.run("say", { text: "Hello there" });
    expect((s.spoken[0].voice as { name: string }).name).toBe("Daniel");
    expect(s.spoken[0].rate).toBe(3);
    await el.run("stop");
    expect(el.getState().speaking).toBe(false);
    expect(actions.at(-1)).toMatchObject({ type: "speak:end", payload: { interrupted: true, complete: false } });
    // L'erreur « interrupted » du cancel est ignorée ; une vraie erreur est publiée.
    await el.run("say", { text: "encore" });
    s.spoken.at(-1)!.onerror?.({ error: "not-allowed" });
    expect(el.getState()).toMatchObject({ status: "denied", speaking: false });
    expect(el.getState().error).toMatch(/geste/);
    expect(await el.run("say")).toBe(false); // rien à dire
  });

  it("pause / resume, control par compteurs, for dans le clic", async () => {
    const s = fakeSynth();
    const id = `v${++uid}`;
    const ctl = `${id}Ctl`;
    set(ctl, { say: 0, pause: 0, resume: 0 });
    const el = await mount<SonicSpeak>("sonic-speak", { id, text: "Bonjour", control: ctl, for: `${id}Btn` });
    set(ctl, { say: 1, pause: 0, resume: 0 });
    await wait();
    expect(s.spoken).toHaveLength(1);
    set(ctl, { say: 1, pause: 1, resume: 0 });
    await wait();
    expect(s.paused).toBe(true);
    expect(el.getState().paused).toBe(true);
    set(ctl, { say: 1, pause: 1, resume: 1 });
    await wait();
    expect(s.paused).toBe(false);
    set(ctl, { say: { n: 2, text: "Autre texte" }, pause: 1, resume: 1 });
    await wait();
    expect(s.spoken.at(-1)!.text).toBe("Autre texte");
    const btn = document.createElement("button");
    btn.id = `${id}Btn`;
    document.body.appendChild(btn);
    btn.click();
    await wait();
    expect(s.spoken.at(-1)!.text).toBe("Bonjour");
  });

  it("text-from + auto : parle aux nouvelles valeurs, pas à la valeur initiale", async () => {
    const s = fakeSynth();
    const id = `v${++uid}`;
    const src = `${id}Src`;
    set(src, { msg: "déjà là" });
    const el = await mount<SonicSpeak>("sonic-speak", { id, "text-from": `${src}.msg`, auto: true });
    await wait();
    expect(s.spoken).toHaveLength(0);
    expect(el.currentText()).toBe("déjà là");
    set(`${src}.msg`, "Nouveau message");
    await wait();
    expect(s.spoken.map((u) => u.text)).toEqual(["Nouveau message"]);
  });
});

// ─── sonic-listen ──────────────────────────────────────────────────────────────────────────────────────────────
describe("sonic-listen", () => {
  it("non supporté sans SpeechRecognition (Firefox)", async () => {
    stubGlobal("SpeechRecognition", undefined);
    stubGlobal("webkitSpeechRecognition", undefined);
    const el = await mount<SonicListen>("sonic-listen", { id: `l${++uid}` });
    expect(el.getState()).toMatchObject({ status: "unsupported", supported: false });
    expect(el.getState().error).toMatch(/Firefox/);
    expect(await el.run("start")).toBe(false);
  });

  it("dictée : réglages, résultats provisoires puis définitifs, cumul, actions", async () => {
    stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const id = `l${++uid}`;
    const actions = fakeStore(`${id}Store`);
    const el = await mount<SonicListen>("sonic-listen", { id, lang: "fr-FR", interim: true, "max-alternatives": "2", target: `${id}Store` });
    expect(await el.run("start")).toBe(true);
    const r = lastRec();
    expect(r).toMatchObject({ lang: "fr-FR", interimResults: true, maxAlternatives: 2, continuous: false, started: 1 });
    expect(el.getState()).toMatchObject({ status: "requesting", active: true });
    r.onstart?.();
    expect(el.getState()).toMatchObject({ status: "ready", listening: true });
    r.result([["bonjour tout", false]]);
    await wait(50);
    expect((get(`${id}State`) as ListenState).interim).toBe("bonjour tout");
    r.result([["Bonjour tout le monde", true, 0.8]]);
    expect(el.getState()).toMatchObject({ final: "Bonjour tout le monde", transcript: "Bonjour tout le monde", confidence: 0.8 });
    r.result([["Bonjour tout le monde", true, 0.8], ["Deuxième", true, 0.7]], 1);
    expect(el.getState().transcript).toBe("Bonjour tout le monde Deuxième");
    expect(actions.filter((a) => a.type === "listen:result").map((a) => a.payload)).toEqual([
      { text: "bonjour tout", confidence: 0, isFinal: false },
      { text: "Bonjour tout le monde", confidence: 0.8, isFinal: true },
      { text: "Deuxième", confidence: 0.7, isFinal: true },
    ]);
    await el.run("stop");
    expect(r.stopped).toBe(1);
    r.onend?.();
    expect(el.getState()).toMatchObject({ active: false, listening: false, status: "ready" });
    await el.run("clear");
    expect(el.getState().transcript).toBe("");
  });

  it("mots-clés : un match par phrase dite, compteur n", async () => {
    stubGlobal("SpeechRecognition", FakeRecognition);
    const id = `l${++uid}`;
    const actions = fakeStore(`${id}Store`);
    const el = await mount<SonicListen>("sonic-listen", { id, phrases: "suivant, précédent", target: `${id}Store` });
    await el.run("start");
    const r = lastRec();
    expect(r.interimResults).toBe(true); // provisoire demandé pour réagir vite
    r.onstart?.();
    r.result([["précé", false]]);
    r.result([["Precedent", false]]);
    r.result([["Précédent !", true]]);
    expect(actions.filter((a) => a.type === "listen:match")).toHaveLength(1);
    expect(el.getState().match).toEqual({ phrase: "précédent", text: "Precedent", n: 1 });
    r.result([["Précédent !", true], ["suivant", true]], 1);
    expect(el.getState().match).toMatchObject({ phrase: "suivant", n: 2 });
    // interim non demandé : rien de provisoire publié
    expect(el.getState().interim).toBe("");
    expect(actions.filter((a) => a.type === "listen:result" && !(a.payload as { isFinal: boolean }).isFinal)).toHaveLength(0);
  });

  it("erreur not-allowed : refus, pas de relance", async () => {
    stubGlobal("SpeechRecognition", FakeRecognition);
    const el = await mount<SonicListen>("sonic-listen", { id: `l${++uid}`, continuous: true });
    await el.run("start");
    const r = lastRec();
    r.onerror?.({ error: "not-allowed" });
    r.onend?.();
    await wait(400);
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(el.getState()).toMatchObject({ status: "denied", active: false });
    expect(el.getState().error).toMatch(/micro refusé/);
  });

  it("continu : relance après coupure, backoff, abandon après coupures rapides", async () => {
    stubGlobal("SpeechRecognition", FakeRecognition);
    const el = await mount<SonicListen>("sonic-listen", { id: `l${++uid}`, continuous: true });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    await el.run("start");
    // Session longue : relance immédiate.
    lastRec().onstart?.();
    vi.advanceTimersByTime(5000);
    lastRec().onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(el.getState()).toMatchObject({ restarts: 1, active: true });
    // Coupures rapides : délais croissants puis abandon.
    let delays = 0;
    for (let i = 0; i < 10 && el.getState().active; i++) {
      const before = FakeRecognition.instances.length;
      lastRec().onstart?.();
      lastRec().onerror?.({ error: "network" });
      lastRec().onend?.();
      await vi.advanceTimersByTimeAsync(8000);
      if (FakeRecognition.instances.length > before) delays++;
    }
    expect(delays).toBe(6);
    expect(el.getState()).toMatchObject({ active: false, status: "error" });
    expect(el.getState().error).toMatch(/coupée sans cesse/);
  });

  it("toggle par for, abort, params prioritaires", async () => {
    stubGlobal("SpeechRecognition", FakeRecognition);
    const id = `l${++uid}`;
    set(`${id}P`, { lang: "en-US", continuous: true, phrases: ["go"] });
    const el = await mount<SonicListen>("sonic-listen", { id, lang: "fr-FR", params: `${id}P`, for: `${id}Btn` });
    expect(el.getState().settings).toMatchObject({ lang: "en-US", continuous: true, phrases: ["go"] });
    const btn = document.createElement("button");
    btn.id = `${id}Btn`;
    document.body.appendChild(btn);
    btn.click();
    await wait();
    expect(lastRec()).toMatchObject({ lang: "en-US", continuous: true, started: 1 });
    await el.run("abort");
    expect(lastRec().aborted).toBe(1);
    expect(el.getState().active).toBe(false);
    lastRec().onend?.(); // fin tardive d'une session abandonnée : ignorée
    expect(FakeRecognition.instances).toHaveLength(1);
  });
});
