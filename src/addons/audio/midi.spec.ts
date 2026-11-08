import { afterEach, describe, expect, it } from "vitest";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
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

  it("in-map : note jouée, harmonie, note ignorée ; noteOff et expressions suivent la note retenue", async () => {
    const { set } = await import("@supersoniks/concorde/core/utils/PublisherProxy");
    const got: SonicNoteEvent[] = [];
    customElements.define("fake-instr2", class extends HTMLElement {
      schedule(ev: SonicNoteEvent[]) { got.push(...ev); }
      allNotesOff() {}
    });
    const map: unknown[] = Array.from({ length: 128 }, (_, i) => i);
    map[60] = 62; // aimantée
    map[64] = [64, 67]; // + harmonie
    map[40] = -1; // zone d'accords : ignorée
    set("mapDp", { m: map });
    document.body.innerHTML = `<sonic-midi id="m4" target="#fx2" mpe in-map="mapDp.m"></sonic-midi><fake-instr2 id="fx2"></fake-instr2>`;
    const el = document.querySelector("sonic-midi") as SonicMidi;
    await el.updateComplete;
    el.onMessage([0x92, 60, 100]);
    el.onMessage([0x93, 64, 100]);
    el.onMessage([0x94, 40, 100]);
    el.onMessage([0x95, 50, 100]); // identité
    // la carte change pendant que les notes sont tenues
    set("mapDp", { m: [] });
    el.onMessage([0xd3, 90]); // pression canal 4 → les deux notes jouées
    el.onMessage([0x82, 60, 0]);
    el.onMessage([0x83, 64, 0]);
    el.onMessage([0x84, 40, 0]);
    await tick();
    const seq = got.map((e) => [e.type, e.note]);
    expect(seq.filter(([t]) => t === "noteOn")).toEqual([["noteOn", 62], ["noteOn", 64], ["noteOn", 67], ["noteOn", 50]]);
    expect(seq.filter(([t]) => t === "expr")).toEqual([["expr", 64], ["expr", 67]]);
    expect(seq.filter(([t]) => t === "noteOff")).toEqual([["noteOff", 62], ["noteOff", 64], ["noteOff", 67]]);
  });
});

describe("sonic-midi : réglages par control", () => {
  it("transpose, bendRange, offsetMs, durS dans control, bornés et publiés ; clé retirée : retour à l'attribut", async () => {
    const got: SonicNoteEvent[] = [];
    customElements.define("fake-instr3", class extends HTMLElement {
      schedule(ev: SonicNoteEvent[]) { got.push(...ev); }
      allNotesOff() {}
    });
    document.body.innerHTML = `<sonic-midi id="mc1" target="#fx3" transpose="12" control="mcC"></sonic-midi><fake-instr3 id="fx3"></fake-instr3>`;
    const el = document.querySelector("sonic-midi") as SonicMidi;
    await el.updateComplete;
    await tick();
    expect(get("mc1State")).toMatchObject({ settings: { transpose: 12, bendRange: 0, offsetMs: 0, durS: 0.25 } });
    set("mcC", { transpose: -100, bendRange: 24, offsetMs: 5000, durS: 0 });
    await tick();
    expect(get("mc1State")).toMatchObject({ settings: { transpose: -48, bendRange: 24, offsetMs: 1000, durS: 0.01 } });
    el.onMessage([0x90, 60, 100]);
    el.onMessage([0x80, 60, 0]);
    expect(got.map((e) => [e.type, e.note])).toEqual([["noteOn", 12], ["noteOff", 12]]);
    // pitch bend reçu converti avec la nouvelle amplitude (24 demi-tons)
    el.onMessage([0x90, 60, 100]);
    el.onMessage([0xe0, 0x7f, 0x7f]);
    const expr = got.filter((e) => e.type === "expr").pop();
    expect(expr?.bend).toBeCloseTo(24, 0);
    el.onMessage([0x80, 60, 0]);
    set("mcC", {});
    await tick();
    expect(get("mc1State")).toMatchObject({ settings: { transpose: 12, bendRange: 0, offsetMs: 0, durS: 0.25 } });
    got.length = 0;
    el.onMessage([0x90, 60, 100]);
    expect(got[0]).toMatchObject({ type: "noteOn", note: 72 });
  });
});
