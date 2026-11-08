import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import "./patch";
import { readPatchControl, type SonicPatch } from "./patch";

afterEach(() => {
  document.body.innerHTML = "";
  AudioEngine.reset();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sonic-patch (sans WebAudio)", () => {
  it("compile ses enfants et publie l'état", async () => {
    document.body.innerHTML = `
      <sonic-patch id="p1">
        <sonic-voice><sonic-osc name="o"></sonic-osc><sonic-vca gain="e"></sonic-vca><sonic-env name="e"></sonic-env></sonic-voice>
      </sonic-patch>`;
    const el = document.querySelector("sonic-patch") as SonicPatch;
    await el.updateComplete;
    await tick();
    expect(el.compiledPatch?.errors).toEqual([]);
    expect(el.getState()).toMatchObject({ status: "unsupported", voices: 0, played: 0 });
  });

  it("recompile quand un module change, signale les erreurs", async () => {
    document.body.innerHTML = `<sonic-patch id="p2"><sonic-voice><sonic-osc name="o"></sonic-osc></sonic-voice></sonic-patch>`;
    const el = document.querySelector("sonic-patch") as SonicPatch;
    await el.updateComplete;
    el.querySelector("sonic-osc")!.setAttribute("fm", "absent");
    await tick();
    expect(el.compiledPatch?.errors.join()).toContain('source "absent" inconnue');
  });

  it("preset inconnu : erreur lisible", async () => {
    document.body.innerHTML = `<sonic-patch id="p3" preset="synth/kazoo"></sonic-patch>`;
    const el = document.querySelector("sonic-patch") as SonicPatch;
    await el.updateComplete;
    await tick();
    expect(el.getState().errors[0]).toContain('preset "synth/kazoo" inconnu');
  });

  it("trigger : la valeur vide initiale n'est pas une référence", async () => {
    document.body.innerHTML = `<sonic-patch id="p4" preset="synth/chip" events="seqT.notes" trigger="seqT.tick"></sonic-patch>`;
    const el = document.querySelector("sonic-patch") as SonicPatch;
    await el.updateComplete;
    const calls: unknown[] = [];
    el.schedule = (events) => void calls.push(events);
    set("seqT", { notes: [{ note: "C4" }], tick: 0 });
    set("seqT", { notes: [{ note: "C4" }], tick: 1 });
    set("seqT", { notes: [{ note: "C4" }], tick: 1 });
    set("seqT", { notes: [{ note: "D4" }], tick: 2 });
    expect(calls).toEqual([[{ note: "C4" }], [{ note: "D4" }]]);
  });

  it("état : error = première erreur de compilation (ou WebAudio absent)", async () => {
    document.body.innerHTML = `<sonic-patch id="p5" preset="synth/kazoo"></sonic-patch>`;
    const el = document.querySelector("sonic-patch") as SonicPatch;
    await el.updateComplete;
    await tick();
    expect(el.getState().error).toBe(el.getState().errors[0]);
    el.preset = "synth/chip";
    await el.updateComplete;
    await tick();
    expect(el.getState()).toMatchObject({ errors: [], preset: "synth/chip" });
    // sans WebAudio : erreur lisible même sans erreur de compilation
    expect(el.getState().error).toContain("WebAudio");
  });
});

describe("sonic-patch : DP control", () => {
  it("readPatchControl : clés reconnues, bornes, params numériques seulement", () => {
    expect(readPatchControl({ preset: " synth/pad ", gain: 9, bpm: "90", params: { cutoff: 900, q: "2", x: "abc", y: null }, autre: 1 })).toEqual({
      preset: "synth/pad", gain: 4, bpm: 90, params: { cutoff: 900, q: 2 },
    });
    expect(readPatchControl({ preset: "", gain: "", bpm: "vite" })).toEqual({});
    expect(readPatchControl([1, 2])).toEqual({});
  });

  it("preset, gain, bpm, params pilotés par control, prioritaires sur les attributs, et publiés", async () => {
    document.body.innerHTML = `<sonic-patch id="pc" preset="synth/lead" gain="0.5" bpm="100" control="pcC" out-data-provider="pcS"></sonic-patch>`;
    const el = document.querySelector("sonic-patch") as SonicPatch;
    el.params = { cutoff: 500, res: 0.2 };
    await el.updateComplete;
    await tick();
    expect(get("pcS")).toMatchObject({ preset: "synth/lead", gain: 0.5, bpm: 100, params: { cutoff: 500, res: 0.2 } });

    set("pcC", { preset: "synth/kazoo" });
    await tick();
    await tick();
    expect(get("pcS")).toMatchObject({ preset: "synth/kazoo", error: expect.stringContaining('preset "synth/kazoo" inconnu') });

    set("pcC", { preset: "drums/kit", gain: 0.9, bpm: 140, params: { cutoff: 1200 } });
    await tick();
    await tick();
    expect(el.compiledPatch?.errors).toEqual([]);
    expect(get("pcS")).toMatchObject({ preset: "drums/kit", gain: 0.9, bpm: 140, params: { cutoff: 1200, res: 0.2 } });

    // control vidé : les attributs reprennent la main
    set("pcC", {});
    await tick();
    await tick();
    expect(get("pcS")).toMatchObject({ preset: "synth/lead", gain: 0.5, bpm: 100, params: { cutoff: 500, res: 0.2 } });
  });

  it("gain par control : appliqué en direct, sans recompiler", async () => {
    document.body.innerHTML = `<sonic-patch id="pg" preset="synth/lead" control="pgC"></sonic-patch>`;
    const el = document.querySelector("sonic-patch") as SonicPatch;
    await el.updateComplete;
    await tick();
    const compiled = el.compiledPatch;
    const ramps: number[] = [];
    const gain = { cancelScheduledValues() {}, setTargetAtTime: (v: number) => void ramps.push(v) };
    Object.defineProperty(AudioEngine.get(), "ac", { value: { currentTime: 0 }, configurable: true, writable: true });
    (el as unknown as { runtime: unknown }).runtime = { output: { gain }, dispose() {}, setParam() {}, voiceCount: 0 };
    set("pgC", { gain: 0.9 });
    await tick();
    expect(ramps).toEqual([0.9]);
    expect(el.compiledPatch).toBe(compiled);
    (el as unknown as { runtime: unknown }).runtime = null;
  });
});
