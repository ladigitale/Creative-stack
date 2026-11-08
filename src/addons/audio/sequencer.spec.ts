import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import "./sequencer";
import type { SonicSequencer } from "./sequencer";

afterEach(() => {
  document.body.innerHTML = "";
  AudioEngine.reset();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sonic-sequencer : métrique et graine", () => {
  it("publie seed, beats, stepsPerBeat ; beats / stepsPerBeat dans control, bornés ; clé retirée : retour à l'attribut", async () => {
    document.body.innerHTML = `<sonic-sequencer id="sq1" seed="7" beats="3" steps-per-beat="2" control="sqC"></sonic-sequencer>`;
    const el = document.querySelector("sonic-sequencer") as SonicSequencer;
    await el.updateComplete;
    await tick();
    expect(get("sq1State")).toMatchObject({ seed: 7, beats: 3, stepsPerBeat: 2 });
    set("sqC", { beats: 40, stepsPerBeat: 3, seed: 12 });
    await tick();
    expect(get("sq1State")).toMatchObject({ seed: 12, beats: 16, stepsPerBeat: 3 });
    expect(el.getTransport()?.beats).toBe(16);
    set("sqC", { stepsPerBeat: "x" });
    await tick();
    expect(get("sq1State")).toMatchObject({ beats: 3, stepsPerBeat: 2, seed: 12 });
    el.beats = 5;
    await el.updateComplete;
    await tick();
    expect(get("sq1State")).toMatchObject({ beats: 5 });
  });
});
