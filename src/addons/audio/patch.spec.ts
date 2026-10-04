import { afterEach, describe, expect, it } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import "./patch";
import type { SonicPatch } from "./patch";

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
});
