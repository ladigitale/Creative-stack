import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import { FakeAudioContext } from "../sound/fake-audio";
import "./sampler";
import "./load";
import { readSamplerControl, type SonicSampler } from "./sampler";
import type { SonicAudioLoad } from "./load";

afterEach(() => {
  document.body.innerHTML = "";
  AudioEngine.reset();
  AudioEngine.setContextFactory(null);
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("readSamplerControl", () => {
  it("borne le volume, filtre les groupes d'étouffement, ignore le reste", () => {
    expect(readSamplerControl({ gain: 9, choke: [["hat", "openhat"], ["seul"], "x", [1, 2]], chromatic: " pad ", autre: 1 })).toEqual({
      gain: 4,
      choke: [["hat", "openhat"], ["1", "2"]],
      chromatic: "pad",
    });
    expect(readSamplerControl({ gain: "abc" })).toEqual({});
    expect(readSamplerControl(null)).toEqual({});
  });
});

describe("sonic-sampler : état et DP control", () => {
  it("sans WebAudio : unsupported avec error", async () => {
    document.body.innerHTML = `<sonic-sampler id="smp0"></sonic-sampler>`;
    await (document.querySelector("sonic-sampler") as SonicSampler).updateComplete;
    await tick();
    expect(get("smp0State")).toMatchObject({ status: "unsupported", error: expect.stringContaining("WebAudio"), errors: [] });
  });

  it("erreur de sample : status error, error = première erreur, errors conservé", async () => {
    AudioEngine.setContextFactory(() => new FakeAudioContext() as unknown as BaseAudioContext);
    document.body.innerHTML = `<sonic-sampler id="smp1" samples='{"kick": {}}'></sonic-sampler>`;
    await (document.querySelector("sonic-sampler") as SonicSampler).updateComplete;
    await tick();
    expect(get("smp1State")).toMatchObject({ status: "error", error: "kick : url ou ref requis", errors: ["kick : url ou ref requis"] });
  });

  it("gain, choke, chromatic pilotés par control, prioritaires ; clé retirée : retour à l'attribut", async () => {
    let ac: FakeAudioContext | null = null;
    AudioEngine.setContextFactory(() => (ac = new FakeAudioContext()) as unknown as BaseAudioContext);
    await AudioEngine.get().unlock();
    document.body.innerHTML = `<sonic-sampler id="smp2" gain="0.5" chromatic="lead" control="smpC" choke='[["hat","openhat"]]'></sonic-sampler>`;
    const el = document.querySelector("sonic-sampler") as SonicSampler;
    await el.updateComplete;
    await tick();
    expect(get("smp2State")).toMatchObject({ status: "ready", error: null, gain: 0.5, chromatic: "lead", choke: [["hat", "openhat"]] });
    const out = el.getAudioOutput() as unknown as { gain: { value: number } };
    expect(out.gain.value).toBe(0.5);
    set("smpC", { gain: 7, chromatic: "pad", choke: [["a", "b", "c"]] });
    await tick();
    expect(get("smp2State")).toMatchObject({ gain: 4, chromatic: "pad", choke: [["a", "b", "c"]] });
    expect(out.gain.value).toBe(4);
    set("smpC", { chromatic: "pad" });
    await tick();
    expect(get("smp2State")).toMatchObject({ gain: 0.5, chromatic: "pad", choke: [["hat", "openhat"]] });
    expect(out.gain.value).toBe(0.5);
    // attribut modifié pendant un recouvrement : le recouvrement reste prioritaire
    el.chromatic = "bass";
    await el.updateComplete;
    await tick();
    expect(get("smp2State")).toMatchObject({ chromatic: "pad" });
    set("smpC", {});
    await tick();
    expect(get("smp2State")).toMatchObject({ chromatic: "bass" });
    expect(ac).not.toBeNull();
  });
});

describe("sonic-audio-load : error dans l'état", () => {
  it("sans WebAudio puis sans renderCapacity : unsupported avec une raison lisible", async () => {
    document.body.innerHTML = `<sonic-audio-load id="ld1"></sonic-audio-load>`;
    await (document.querySelector("sonic-audio-load") as SonicAudioLoad).updateComplete;
    expect(get("ld1State")).toMatchObject({ status: "unsupported", error: expect.stringContaining("WebAudio") });
    document.body.innerHTML = "";
    AudioEngine.reset();
    AudioEngine.setContextFactory(() => new FakeAudioContext() as unknown as BaseAudioContext);
    await AudioEngine.get().unlock();
    document.body.innerHTML = `<sonic-audio-load id="ld2"></sonic-audio-load>`;
    await (document.querySelector("sonic-audio-load") as SonicAudioLoad).updateComplete;
    expect(get("ld2State")).toMatchObject({ status: "unsupported", error: expect.stringContaining("renderCapacity") });
  });

  it("mesure qui démarre : ready, error null ; démarrage impossible : status error", async () => {
    const listeners: ((e: Event) => void)[] = [];
    let fail = false;
    AudioEngine.setContextFactory(() =>
      Object.assign(new FakeAudioContext(), {
        renderCapacity: {
          addEventListener: (_t: string, cb: (e: Event) => void) => listeners.push(cb),
          removeEventListener: () => {},
          start: () => {
            if (fail) throw new Error("refusé");
          },
          stop: () => {},
        },
      }) as unknown as BaseAudioContext,
    );
    await AudioEngine.get().unlock();
    document.body.innerHTML = `<sonic-audio-load id="ld3"></sonic-audio-load>`;
    await (document.querySelector("sonic-audio-load") as SonicAudioLoad).updateComplete;
    listeners[0](Object.assign(new Event("update"), { averageLoad: 0.25, peakLoad: 0.5, underrunRatio: 0 }));
    expect(get("ld3State")).toMatchObject({ status: "ready", error: null, average: 0.25, updates: 1 });
    document.body.innerHTML = "";
    fail = true;
    document.body.innerHTML = `<sonic-audio-load id="ld4"></sonic-audio-load>`;
    await (document.querySelector("sonic-audio-load") as SonicAudioLoad).updateComplete;
    expect(get("ld4State")).toMatchObject({ status: "error", error: "refusé" });
  });
});
