import { afterEach, describe, expect, it, vi } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import "./mic";
import { readMicControl, type SonicMic } from "./mic";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  AudioEngine.reset();
});

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

function fakeMic() {
  const stops: number[] = [];
  const getUserMedia = vi.fn((_c: MediaStreamConstraints) => {
    const n = getUserMedia.mock.calls.length;
    const track = { stop: () => stops.push(n), addEventListener: () => {}, getSettings: () => ({ deviceId: "m1" }) };
    return Promise.resolve({ getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream);
  });
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia, enumerateDevices: async () => [] } });
  const audio = (i: number) => getUserMedia.mock.calls[i][0].audio as Record<string, unknown>;
  return { getUserMedia, stops, audio };
}

describe("readMicControl", () => {
  it("booléens, gain et cadence bornés ; clés invalides ignorées", () => {
    expect(readMicControl({ echoCancellation: true, noiseSuppression: "oui", autoGain: false, rate: 500, gain: -1, deviceId: "x" })).toEqual({
      echoCancellation: true,
      autoGain: false,
      rate: 60,
      gain: 0,
      deviceId: "x",
    });
  });
});

describe("sonic-mic : réglages par control", () => {
  it("traitements du flux dans control : réouverture propre, une seule par écriture ; clé retirée : retour à l'attribut", async () => {
    const { getUserMedia, stops, audio } = fakeMic();
    document.body.innerHTML = `<sonic-mic id="mic1" control="micC" noise-suppression></sonic-mic>`;
    const el = document.querySelector("sonic-mic") as SonicMic;
    await el.updateComplete;
    set("micC", { active: true });
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audio(0)).toMatchObject({ echoCancellation: false, noiseSuppression: true, autoGainControl: false });
    expect(get("mic1State")).toMatchObject({ status: "ready", active: true, settings: { echoCancellation: false, noiseSuppression: true } });

    set("micC", { active: true, echoCancellation: true, autoGain: true, noiseSuppression: false });
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(stops).toEqual([1]);
    expect(audio(1)).toMatchObject({ echoCancellation: true, noiseSuppression: false, autoGainControl: true });
    expect(get("mic1State")).toMatchObject({ status: "ready", active: true, settings: { echoCancellation: true, noiseSuppression: false, autoGain: true } });

    // gain et cadence : en direct, sans rouvrir le micro
    set("micC", { active: true, echoCancellation: true, autoGain: true, noiseSuppression: false, gain: 2, rate: 5 });
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(get("mic1State")).toMatchObject({ settings: { gain: 2, rate: 5 } });

    set("micC", { active: true });
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(audio(2)).toMatchObject({ echoCancellation: false, noiseSuppression: true, autoGainControl: false });
    expect(get("mic1State")).toMatchObject({ settings: { gain: 1, rate: 15, noiseSuppression: true } });
  });

  it("micro inactif : les réglages sont seulement mémorisés ; attribut modifié : réouverture si actif", async () => {
    const { getUserMedia, audio } = fakeMic();
    document.body.innerHTML = `<sonic-mic id="mic2" control="micC2"></sonic-mic>`;
    const el = document.querySelector("sonic-mic") as SonicMic;
    await el.updateComplete;
    set("micC2", { echoCancellation: true });
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(get("mic2State")).toMatchObject({ status: "idle", settings: { echoCancellation: true } });
    el.start();
    await settle();
    expect(audio(0)).toMatchObject({ echoCancellation: true });
    el.autoGain = true;
    await el.updateComplete;
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(audio(1)).toMatchObject({ echoCancellation: true, autoGainControl: true });
  });
});
