import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import { FakeAudioContext } from "../sound/fake-audio";
import "./master";
import type { SonicAudioMaster } from "./master";

afterEach(() => {
  document.body.innerHTML = "";
  AudioEngine.reset();
  AudioEngine.setContextFactory(null);
});

async function mount(html: string) {
  document.body.innerHTML = html;
  const el = document.querySelector("sonic-audio-master") as SonicAudioMaster;
  await el.updateComplete;
  return el;
}

describe("sonic-audio-master", () => {
  it("sans WebAudio : état unsupported publié dans <id>State", async () => {
    await mount(`<sonic-audio-master id="mst1"></sonic-audio-master>`);
    expect(get("mst1State")).toEqual({ status: "unsupported", error: expect.stringContaining("WebAudio"), ready: false, volume: 0.8, muted: false });
  });

  it("idle avant le geste, ready après ; volume et muet suivis (attributs et control)", async () => {
    AudioEngine.setContextFactory(() => new FakeAudioContext() as unknown as BaseAudioContext);
    const el = await mount(`<sonic-audio-master volume="0.5" control="mstC" out-data-provider="mstS"></sonic-audio-master>`);
    expect(get("mstS")).toMatchObject({ status: "idle", error: null, ready: false, volume: 0.5, muted: false });
    await AudioEngine.get().unlock();
    expect(get("mstS")).toMatchObject({ status: "ready", ready: true });
    set("mstC", { volume: 0.25, muted: true });
    expect(get("mstS")).toMatchObject({ volume: 0.25, muted: true });
    set("mstC", { volume: 7 });
    expect(get("mstS")).toMatchObject({ volume: 1 });
    el.muted = true;
    await el.updateComplete;
    el.muted = false;
    await el.updateComplete;
    expect(get("mstS")).toMatchObject({ muted: false });
  });
});
