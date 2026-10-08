import { afterEach, describe, expect, it } from "vitest";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine } from "../../shared/audio/engine";
import "./midi";
import type { SonicMidi } from "./midi";
import type { SonicNoteEvent } from "../../shared/audio/contracts";

afterEach(() => {
  document.body.innerHTML = "";
  delete (navigator as unknown as Record<string, unknown>).requestMIDIAccess;
  AudioEngine.reset();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("sonic-midi (sans Web MIDI)", () => {
  it("rien au chargement, « unsupported » sans Web MIDI", async () => {
    document.body.innerHTML = `<sonic-midi id="m1"></sonic-midi>`;
    const el = document.querySelector("sonic-midi") as SonicMidi;
    await el.updateComplete;
    expect(el.getState().status).toBe("idle");
    el.start();
    await tick();
    expect(el.getState().status).toBe("unsupported");
  });

  it("refus d'accès lisible", async () => {
    (navigator as unknown as Record<string, unknown>).requestMIDIAccess = () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    document.body.innerHTML = `<sonic-midi id="m2" active></sonic-midi>`;
    const el = document.querySelector("sonic-midi") as SonicMidi;
    await el.updateComplete;
    await tick();
    await tick();
    expect(el.getState()).toMatchObject({ status: "denied", error: "accès MIDI refusé" });
  });

  it("notes reçues : instruments ciblés, état, filtre de canal, transposition", async () => {
    const got: SonicNoteEvent[] = [];
    customElements.define("fake-instr", class extends HTMLElement {
      schedule(ev: SonicNoteEvent[]) { got.push(...ev); }
      allNotesOff() {}
    });
    document.body.innerHTML = `<sonic-midi id="m3" target="#fx" channel="2" transpose="12"></sonic-midi><fake-instr id="fx"></fake-instr>`;
    const el = document.querySelector("sonic-midi") as SonicMidi;
    await el.updateComplete;
    el.onMessage([0x90, 60, 127]); // canal 1 : ignoré
    el.onMessage([0x91, 60, 127]);
    el.onMessage([0xb1, 1, 64]);
    el.onMessage([0x81, 60, 0]);
    await tick();
    expect(got.map((e) => [e.type, e.note])).toEqual([["noteOn", 72], ["noteOff", 72]]);
    const st = get("m3State") as ReturnType<SonicMidi["getState"]>;
    expect(st).toMatchObject({ notes: 1, cc: { "1": 0.504 }, last: { kind: "noteOff", name: "C5" } });
  });
});
