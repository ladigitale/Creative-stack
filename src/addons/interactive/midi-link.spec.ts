import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
// Intégration : sonic-trigger (emit) → DataProviders → sonic-midi → faux port MIDI de sortie.
import { AudioEngine, SonicMidi } from "../audio/index";
import { SonicTrigger } from "./trigger";
import { SonicMotion } from "./motion";

void SonicMidi;
void SonicTrigger;
void SonicMotion;

let sent: number[][];

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  const out = { id: "o1", name: "Faux port", manufacturer: "Test", state: "connected", send: (d: number[]) => void sent.push([...d]) };
  const access = { inputs: new Map(), outputs: new Map([["o1", out]]), onstatechange: null };
  (navigator as unknown as Record<string, unknown>).requestMIDIAccess = () => Promise.resolve(access);
});
afterEach(() => {
  document.body.innerHTML = "";
  delete (navigator as unknown as Record<string, unknown>).requestMIDIAccess;
  AudioEngine.reset();
  vi.useRealTimers();
});

async function mountAll(trigAttrs: Record<string, string>) {
  const midi = document.createElement("sonic-midi") as SonicMidi;
  midi.setAttribute("events", "lk-ev");
  midi.setAttribute("trigger", "lk-go");
  midi.setAttribute("output", "all");
  midi.setAttribute("active", "");
  document.body.appendChild(midi);
  await midi.updateComplete;
  await vi.advanceTimersByTimeAsync(10);
  const trig = document.createElement("sonic-trigger") as SonicTrigger;
  for (const [k, v] of Object.entries({ "emit-provider": "lk-ev", "emit-trigger": "lk-go", "cooldown-ms": "0", ...trigAttrs })) trig.setAttribute(k, v);
  document.body.appendChild(trig);
  await trig.updateComplete;
  return { midi, trig };
}

describe("sonic-trigger → sonic-midi (faux port de sortie)", () => {
  it("la première note n'est pas avalée : noteOn puis noteOff aux bons octets", async () => {
    await mountAll({ source: "lk1", key: "on", emit: "noteOn", note: "64", "vel-min": "0.5" });
    set("lk1", { on: true });
    await vi.advanceTimersByTimeAsync(5);
    expect(sent).toEqual([[0x90, 64, Math.round(0.5 * 127)]]);
    set("lk1", { on: false });
    await vi.advanceTimersByTimeAsync(5);
    expect(sent.at(-1)).toEqual([0x80, 64, 0]);
  });

  it("geste → MIDI : la vitesse de la main donne la vélocité, la position la hauteur", async () => {
    const motion = document.createElement("sonic-motion") as SonicMotion;
    for (const [k, v] of Object.entries({ source: "lk2hand", keys: "x", "smooth-ms": "0", "speed-max": "2", "peak-ms": "300", "out-data-provider": "lk2speed" })) motion.setAttribute(k, v);
    document.body.appendChild(motion);
    await motion.updateComplete;
    await mountAll({ source: "lk2speed", key: "speed", gt: "0.5", emit: "note", "note-key": "value", "note-range": "60,72", "vel-source": "lk2speed", "vel-key": "peakVel", "vel-min": "0.1", "dur-s": "0.1" });
    set("lk2hand", { x: 0.0 });
    await vi.advanceTimersByTimeAsync(50);
    set("lk2hand", { x: 0.5 }); // 10 u/s : très rapide, vel = 1
    await vi.advanceTimersByTimeAsync(5);
    const on = sent.find((m) => m[0] === 0x90);
    expect(on).toBeDefined();
    expect(on![2]).toBe(127);
  });
});
