import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublisherManager } from "@supersoniks/concorde/utils";
import "./index";
import {
  LumaDetector,
  MorseDecoder,
  morseDecode,
  morseEncode,
  morseNormalize,
  morseTimeline,
  type LumaEdge,
  type MorseState,
  type SonicMorse,
} from "./index";
import { registerStore, unregisterStore, type SonicActionMessage } from "../interactive/registry";

describe("code morse", () => {
  it("normalise : majuscules, accents retirés, caractères inconnus ôtés", () => {
    expect(morseNormalize("  Ça va, l’été ?  ")).toBe("CA VA, L'ETE ?");
    expect(morseNormalize("a  b\n€c")).toBe("A BC");
    expect(morseNormalize("€€")).toBe("");
  });

  it("encode et décode", () => {
    expect(morseEncode("SOS")).toBe("... --- ...");
    expect(morseEncode("a b")).toBe(".- / -...");
    expect(morseDecode("... --- ... / .-")).toBe("SOS A");
    expect(morseDecode("......")).toBe("?");
    expect(morseDecode(morseEncode("Salut, ça va ? 73"))).toBe("SALUT, CA VA ? 73");
  });

  it("chronologie : point 1, trait 3, lettre 3, mot 7", () => {
    const steps = morseTimeline("ET A", 100);
    expect(steps.map((s) => `${s.on ? "1" : "0"}${s.ms}`)).toEqual(["1100", "0300", "1300", "0700", "1100", "0100", "1300", "0300"]);
    expect(steps.map((s) => s.chars)).toEqual([1, 1, 3, 3, 3, 3, 4, 4]);
    expect(morseTimeline("", 100)).toEqual([]);
  });

  it("signal de début : un éclat plus long qu'un trait avant le message", () => {
    const steps = morseTimeline("E", 100, 0, 5);
    expect(steps.map((s) => `${s.on ? "1" : "0"}${s.ms}`)).toEqual(["1500", "0300", "1100", "0300"]);
    expect(steps.map((s) => s.chars)).toEqual([0, 0, 1, 1]);
    expect(morseTimeline("€", 100, 0, 5)).toEqual([]);
  });

  it("trim : éclats raccourcis, silences allongés d'autant, durée totale inchangée", () => {
    const plain = morseTimeline("SOS", 300);
    const trimmed = morseTimeline("SOS", 300, 40);
    expect(trimmed[0]).toMatchObject({ on: true, ms: 260 });
    expect(trimmed[1]).toMatchObject({ on: false, ms: 340 });
    expect(trimmed.reduce((a, s) => a + s.ms, 0)).toBe(plain.reduce((a, s) => a + s.ms, 0));
  });
});

/** Rejoue une chronologie dans un décodeur, avec un éclat allongé de `stretch` ms (lampe réelle). */
function decodeTimeline(d: MorseDecoder, text: string, unit: number, stretch = 0): string {
  const steps = morseTimeline(text, unit);
  steps.forEach((s, i) => {
    if (s.on) d.light(s.ms + stretch);
    else if (i < steps.length - 1) d.silence(s.ms - stretch);
  });
  d.silence(unit * 12);
  return d.text.trim();
}

describe("décodeur", () => {
  it("décode un message aux durées exactes", () => {
    expect(decodeTimeline(new MorseDecoder({ unit: 300 }), "Salut ca va", 300)).toBe("SALUT CA VA");
  });

  it("tolère des éclats allongés de 50 ms (torche de téléphone)", () => {
    expect(decodeTimeline(new MorseDecoder({ unit: 300 }), "MORSE 2026", 300, 50)).toBe("MORSE 2026");
  });

  it("silence idempotent : l'horloge peut le signaler plusieurs fois", () => {
    const d = new MorseDecoder({ unit: 100 });
    d.light(100);
    d.silence(250);
    d.silence(600);
    d.silence(900);
    expect(d.text).toBe("E ");
    d.light(300);
    d.silence(300);
    expect(d.text).toBe("E T");
  });

  it("auto-unit : s'accorde à un émetteur plus lent que prévu", () => {
    const fixed = decodeTimeline(new MorseDecoder({ unit: 150 }), "PARIS", 400);
    expect(fixed).not.toBe("PARIS");
    const auto = new MorseDecoder({ unit: 150, autoUnit: true });
    decodeTimeline(auto, "A", 400);
    auto.text = "";
    expect(decodeTimeline(auto, "PARIS", 400)).toBe("PARIS");
    expect(Math.abs(auto.unit - 400)).toBeLessThan(20);
  });
});

describe("détection par sauts (exposition automatique)", () => {
  /**
   * Caméra à exposition automatique : le gain ramène l'image vers une luminosité cible en ~300 ms.
   * Une lampe allumée longtemps finit donc presque aussi sombre qu'éteinte : un seuil se trompe.
   */
  function camera(light: (t: number) => boolean, d: LumaDetector, to: number, fps = 20): LumaEdge[] {
    const out: LumaEdge[] = [];
    const step = 1000 / fps;
    let gain = 1;
    for (let t = 0; t <= to; t += step) {
      const scene = 0.15 + (light(t - step / 2) ? 1.2 : 0);
      const v = Math.min(1, scene * gain);
      gain += (0.25 / scene - gain) * (1 - Math.exp(-step / 300));
      const e = d.feed(t, v);
      if (e) out.push(e);
    }
    return out;
  }
  const dashes = (t: number) => (t >= 1000 && t < 1900) || (t >= 2200 && t < 3100) || (t >= 3400 && t < 3700);

  it("un seuil se trompe sur la durée des traits : l'image s'assombrit pendant l'éclat", () => {
    const edges = camera(dashes, new LumaDetector({ detect: "level" }), 5000);
    const first = edges.find((e) => !e.on);
    expect(Math.abs(first!.dur - 900)).toBeGreaterThan(200);
  });

  it("les sauts donnent les bons fronts et les bonnes durées", () => {
    const edges = camera(dashes, new LumaDetector({ detect: "jump" }), 5000);
    expect(edges.map((e) => e.on)).toEqual([true, false, true, false, true, false]);
    const lights = edges.filter((e) => !e.on).map((e) => e.dur);
    expect(Math.abs(lights[0] - 900)).toBeLessThan(60);
    expect(Math.abs(lights[1] - 900)).toBeLessThan(60);
    expect(Math.abs(lights[2] - 300)).toBeLessThan(60);
  });

  it("éclat plus court que la fenêtre de saut", () => {
    const edges = camera((t) => t >= 1000 && t < 1080, new LumaDetector({ detect: "jump" }), 2000, 30);
    expect(edges.map((e) => e.on)).toEqual([true, false]);
  });

  it("caméra lente (8 images/s) : la fenêtre garde au moins la mesure précédente", () => {
    const edges = camera((t) => t >= 1000 && t < 1900, new LumaDetector({ detect: "jump" }), 3000, 8);
    expect(edges.map((e) => e.on)).toEqual([true, false]);
  });

  it("max-on-ms : extinction d'office si le front d'extinction est manqué", () => {
    const d = new LumaDetector({ detect: "jump", maxOnMs: 1000 });
    const edges: LumaEdge[] = [];
    for (let t = 0; t <= 3000; t += 50) {
      // Allumage net à 500, puis extinction très progressive que les sauts ne voient pas.
      const v = t < 500 ? 0.1 : Math.max(0.1, 0.9 - (t - 500) / 4000);
      const e = d.feed(t, v);
      if (e) edges.push(e);
    }
    expect(edges.map((e) => e.on)).toEqual([true, false]);
    expect(edges[1].t - edges[0].t).toBeGreaterThan(1000);
  });

  it("message entier vu par cette caméra puis décodé", () => {
    const steps = morseTimeline("SOS TADAAA", 300);
    const starts: Array<[number, number]> = [];
    let t = 1000;
    for (const s of steps) {
      if (s.on) starts.push([t, t + s.ms]);
      t += s.ms;
    }
    const edges = camera((x) => starts.some(([a, b]) => x >= a && x < b), new LumaDetector({ detect: "jump" }), t + 500);
    const dec = new MorseDecoder({ unit: 300 });
    for (const e of edges) {
      if (e.on) dec.silence(e.dur);
      else dec.light(e.dur);
    }
    dec.silence(3600);
    expect(dec.text.trim()).toBe("SOS TADAAA");
  });
});

const state = (name: string) => PublisherManager.get(name).get() as MorseState;

async function mount(attrs: Record<string, string>) {
  const el = document.createElement("sonic-morse") as SonicMorse;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("sonic-morse", () => {
  let received: SonicActionMessage[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    received = [];
    registerStore({ id: "morseStore", dispatch: (a) => received.push(a), getState: () => ({}), reset: () => {} });
  });
  afterEach(() => {
    document.body.innerHTML = "";
    unregisterStore("morseStore");
    vi.useRealTimers();
  });

  it("émet le texte sur le booléen commandé, sans dérive, puis prévient le store", async () => {
    PublisherManager.get("lampe1").set({ torch: false, zoom: 2 });
    PublisherManager.get("chat1").set({ outgoing: "", txN: 0 });
    const log: Array<[number, boolean]> = [];
    let last = false;
    PublisherManager.get("lampe1").onAssign((v: { torch?: boolean }) => {
      if (Boolean(v?.torch) !== last) {
        last = Boolean(v?.torch);
        log.push([Math.round(performance.now()), last]);
      }
    });
    await mount({ unit: "100", "start-units": "0", drive: "lampe1.torch", "text-from": "chat1.outgoing", "send-from": "chat1.txN", target: "morseStore", "out-data-provider": "morse1" });
    const t0 = performance.now();
    PublisherManager.get("chat1").set({ outgoing: "en", txN: 1 });
    expect(state("morse1").status).toBe("sending");
    expect(state("morse1").tx).toMatchObject({ text: "EN", signs: ". -.", total: 2, done: "", rest: "EN", percent: 0 });
    await vi.advanceTimersByTimeAsync(150); // le point de E vient de finir
    expect(state("morse1").tx).toMatchObject({ done: "E", rest: "N", chars: 1, percent: 50 });
    await vi.advanceTimersByTimeAsync(2000);
    // E = point ; N = trait point. 100 | 300 | 300 | 100 | 100
    expect(log.map(([t, on]) => [t - t0, on])).toEqual([[0, true], [100, false], [400, true], [700, false], [800, true], [900, false]]);
    expect(state("morse1").status).toBe("idle");
    expect(state("morse1")).toMatchObject({ lastSent: "EN", sent: 1, on: false });
    expect(state("morse1").tx).toMatchObject({ done: "EN", rest: "", percent: 100 });
    expect((PublisherManager.get("lampe1").get() as { zoom: number }).zoom).toBe(2);
    expect(received).toMatchObject([{ type: "morse:sent", payload: { text: "EN" } }]);
  });

  it("signal de début émis par défaut : éclat de 5 unités, silence de 3, puis le message", async () => {
    PublisherManager.get("lampe7").set({ torch: false });
    const log: Array<[number, boolean]> = [];
    let last = false;
    PublisherManager.get("lampe7").onAssign((v: { torch?: boolean }) => {
      if (Boolean(v?.torch) !== last) {
        last = Boolean(v?.torch);
        log.push([Math.round(performance.now()), last]);
      }
    });
    const el = await mount({ unit: "100", drive: "lampe7.torch", "out-data-provider": "morse7" });
    const t0 = performance.now();
    el.send("E");
    await vi.advanceTimersByTimeAsync(2000);
    expect(log.map(([t, on]) => [t - t0, on])).toEqual([[0, true], [500, false], [800, true], [900, false]]);
  });

  it("enchaîne les messages en file et s'arrête sur cancel", async () => {
    PublisherManager.get("lampe2").set({ torch: false });
    PublisherManager.get("ctl2").set({ cancel: 0 });
    const el = await mount({ unit: "100", "start-units": "0", drive: "lampe2.torch", control: "ctl2", target: "morseStore", "out-data-provider": "morse2" });
    el.send("E");
    el.send("T");
    el.send("€");
    expect(state("morse2").tx.queue).toBe(1);
    await vi.advanceTimersByTimeAsync(450);
    expect(state("morse2").tx.text).toBe("T");
    expect((PublisherManager.get("lampe2").get() as { torch: boolean }).torch).toBe(true);
    PublisherManager.get("ctl2").set({ cancel: 1 });
    expect(state("morse2").status).toBe("idle");
    expect((PublisherManager.get("lampe2").get() as { torch: boolean }).torch).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(received.map((a) => a.type)).toEqual(["morse:sent"]);
  });

  /** Publie les fronts d'un message comme le ferait une sonic-luma, à l'heure. `start` : unités du signal de début. */
  const edges: Record<string, LumaEdge[]> = {};
  async function play(dpName: string, text: string, unit: number, start = 5) {
    const events = (edges[dpName] ??= []);
    let n = events.length ? events[events.length - 1].n : 0;
    let prev = performance.now();
    for (const s of morseTimeline(text, unit, 0, start)) {
      if (s.on) {
        events.push({ n: ++n, on: true, t: performance.now(), dur: performance.now() - prev, level: 1, sinceMark: null, markGap: null });
        prev = performance.now();
        PublisherManager.get(dpName).set({ events: events.slice(-32) });
        await vi.advanceTimersByTimeAsync(s.ms);
        events.push({ n: ++n, on: false, t: performance.now(), dur: s.ms, level: 0, sinceMark: null, markGap: null });
        prev = performance.now();
        PublisherManager.get(dpName).set({ events: events.slice(-32) });
      } else {
        await vi.advanceTimersByTimeAsync(s.ms);
      }
    }
  }

  it("décode un message annoncé par le signal de début, le clôt après le silence", async () => {
    PublisherManager.get("sonde3").set({ events: [] });
    await mount({ unit: "100", source: "sonde3", target: "morseStore", "out-data-provider": "morse3", "end-units": "12" });
    await vi.advanceTimersByTimeAsync(50);
    expect(state("morse3").status).toBe("idle");
    await play("sonde3", "OK GO", 100);
    expect(state("morse3").rx.text).toBe("OK GO");
    expect(state("morse3").status).toBe("receiving");
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(state("morse3")).toMatchObject({ status: "idle", lastReceived: "OK GO", received: 1, dropped: 0 });
    expect(state("morse3").rx.text).toBe("");
    expect(received).toMatchObject([{ type: "morse:message", payload: { text: "OK GO", unit: 100 } }]);
  });

  it("réception annoncée dès le signal de début, avant la première lettre", async () => {
    PublisherManager.get("sonde8").set({ events: [] });
    await mount({ unit: "100", source: "sonde8", "out-data-provider": "morse8" });
    await vi.advanceTimersByTimeAsync(50);
    const all: LumaEdge[] = (edges["sonde8"] = []);
    const t = performance.now();
    all.push({ n: 1, on: true, t, dur: 0, level: 1, sinceMark: null, markGap: null });
    PublisherManager.get("sonde8").set({ events: [...all] });
    await vi.advanceTimersByTimeAsync(500);
    all.push({ n: 2, on: false, t: performance.now(), dur: 500, level: 0, sinceMark: null, markGap: null });
    PublisherManager.get("sonde8").set({ events: [...all] });
    expect(state("morse8").status).toBe("receiving");
    expect(state("morse8").rx.text).toBe("");
  });

  it("sans signal de début, une lumière n'est pas un message", async () => {
    PublisherManager.get("sonde9").set({ events: [] });
    await mount({ unit: "100", source: "sonde9", target: "morseStore", "out-data-provider": "morse9" });
    await vi.advanceTimersByTimeAsync(50);
    await play("sonde9", "SOS SOS", 100, 0);
    expect(state("morse9").status).toBe("idle");
    await vi.advanceTimersByTimeAsync(3000);
    expect(received).toEqual([]);
    expect(state("morse9")).toMatchObject({ received: 0, dropped: 0 });
  });

  it("une lettre seule est écartée, avec ou sans signal de début", async () => {
    PublisherManager.get("sonde10").set({ events: [] });
    await mount({ unit: "100", source: "sonde10", target: "morseStore", "out-data-provider": "morse10" });
    await vi.advanceTimersByTimeAsync(50);
    await play("sonde10", "T", 100);
    await vi.advanceTimersByTimeAsync(3000);
    expect(received).toEqual([]);
    expect(state("morse10")).toMatchObject({ received: 0, dropped: 1, status: "idle" });
    await play("sonde10", "TA", 100);
    await vi.advanceTimersByTimeAsync(3000);
    expect(received).toMatchObject([{ type: "morse:message", payload: { text: "TA" } }]);

    PublisherManager.get("sonde11").set({ events: [] });
    await mount({ unit: "100", "start-units": "0", source: "sonde11", target: "morseStore", "out-data-provider": "morse11" });
    await vi.advanceTimersByTimeAsync(50);
    await play("sonde11", "E", 100, 0);
    expect(state("morse11").status).toBe("idle"); // une lettre : pas encore une réception
    await vi.advanceTimersByTimeAsync(3000);
    expect(state("morse11")).toMatchObject({ received: 0, dropped: 1 });
  });

  it("ne se reçoit pas lui-même : sourd pendant l'émission, la garde, et à la fin d'un éclat commencé avant", async () => {
    PublisherManager.get("sonde4").set({ events: [] });
    const el = await mount({ unit: "100", source: "sonde4", target: "morseStore", "out-data-provider": "morse4", "guard-ms": "500" });
    await vi.advanceTimersByTimeAsync(50);
    el.send("TT");
    await play("sonde4", "TT", 100); // sa propre lampe, vue par sa caméra, pendant l'émission
    expect(state("morse4").rx.text).toBe("");
    // Fin de son dernier éclat vue en retard, garde passée : un allumage pendant la garde,
    // l'extinction après. Ce n'est pas un signal de début.
    const all = edges["sonde4"];
    let n = all[all.length - 1].n;
    all.push({ n: ++n, on: true, t: performance.now(), dur: 100, level: 1, sinceMark: null, markGap: null });
    PublisherManager.get("sonde4").set({ events: all.slice(-32) });
    await vi.advanceTimersByTimeAsync(700);
    all.push({ n: ++n, on: false, t: performance.now(), dur: 700, level: 0, sinceMark: null, markGap: null });
    PublisherManager.get("sonde4").set({ events: all.slice(-32) });
    expect(state("morse4").status).toBe("idle");
    await vi.advanceTimersByTimeAsync(3000);
    expect(received.map((a) => a.type)).toEqual(["morse:sent"]);
    // Puis un vrai message de l'autre appareil.
    await play("sonde4", "OK", 100);
    await vi.advanceTimersByTimeAsync(3000);
    expect(received).toMatchObject([{ type: "morse:sent" }, { type: "morse:message", payload: { text: "OK" } }]);
  });

  it("les fronts d'avant le branchement ne comptent pas", async () => {
    const t = performance.now();
    PublisherManager.get("sonde12").set({ events: [
      { n: 1, on: true, t: t - 900, dur: 0, level: 1, sinceMark: null, markGap: null },
      { n: 2, on: false, t: t - 400, dur: 500, level: 0, sinceMark: null, markGap: null },
    ] });
    await mount({ unit: "100", source: "sonde12", "out-data-provider": "morse12" });
    await vi.advanceTimersByTimeAsync(100);
    expect(state("morse12").status).toBe("idle");
  });

  it("réglages en direct", async () => {
    PublisherManager.get("params5").set({ unit: 250, autoUnit: true, endUnits: 20, minChars: 3, startUnits: 2 });
    const el = await mount({ unit: "100", params: "params5", "out-data-provider": "morse5" });
    expect(el.settings()).toMatchObject({ unit: 250, autoUnit: true, endUnits: 20, minChars: 3, startUnits: 4, guardMs: 1500 });
    expect(state("morse5").rx.unit).toBe(250);
  });
});
