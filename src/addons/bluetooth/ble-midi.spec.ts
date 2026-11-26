import { afterEach, describe, expect, it } from "vitest";
import { get } from "@supersoniks/concorde/core/utils/PublisherProxy";
import "./index";
import { BleMidiDecoder, encodeBleMidi, expandUuid, splitMidi, trackNotes, type BleMidiEvent } from "./index";
import type { SonicBluetooth } from "./bluetooth";
import { registerStore, unregisterStore } from "../interactive/registry";

type Restore = () => void;
const restores: Restore[] = [];
function stub(obj: object, key: string, value: unknown): void {
  const before = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (before) Object.defineProperty(obj, key, before);
    else delete (obj as Record<string, unknown>)[key];
  });
}
afterEach(() => {
  document.body.innerHTML = "";
  while (restores.length) restores.pop()!();
});

describe("décodage BLE-MIDI", () => {
  it("un message : en-tête, horodatage sur 13 bits, note on", () => {
    const d = new BleMidiDecoder();
    const [e] = d.events([0x81, 0x85, 0x90, 60, 127]);
    expect(e).toMatchObject({ type: "noteon", channel: 1, note: 60, name: "C4", velocity: 1, data: [0x90, 60, 127], t: (1 << 7) | 5 });
  });

  it("plusieurs messages par paquet, chacun avec son horodatage", () => {
    const d = new BleMidiDecoder();
    const events = d.events([0x80, 0x81, 0x91, 64, 100, 0x82, 0xb1, 7, 127, 0x83, 0xe1, 0x00, 0x40, 0x84, 0xc2, 5]);
    expect(events.map((e) => e.type)).toEqual(["noteon", "cc", "pitchbend", "program"]);
    expect(events[1]).toMatchObject({ channel: 2, cc: 7, value: 1, t: 2 });
    expect(events[2].value).toBe(0);
    expect(events[3]).toMatchObject({ channel: 3, program: 5 });
  });

  it("statut courant : sans horodatage, avec nouvel horodatage, et d'un paquet à l'autre", () => {
    const d = new BleMidiDecoder();
    // Note on puis deux notes sans statut (même instant), puis une avec un nouvel horodatage.
    const a = d.events([0x80, 0x81, 0x90, 60, 100, 62, 100, 0x85, 64, 0]);
    expect(a.map((e) => [e.type, e.note, e.t])).toEqual([["noteon", 60, 1], ["noteon", 62, 1], ["noteoff", 64, 5]]);
    // Paquet suivant : le statut courant reste celui du canal.
    const b = d.events([0x80, 0x86, 65, 90]);
    expect(b[0]).toMatchObject({ type: "noteon", note: 65, t: 6 });
    // Un message système commun annule le statut courant.
    expect(d.events([0x80, 0x87, 0xf3, 2, 0x88, 66, 1])).toEqual([]);
  });

  it("aftertouch polyphonique et de canal, note off explicite", () => {
    const d = new BleMidiDecoder();
    const [poly, chan, off] = d.events([0x80, 0x80, 0xa0, 60, 127, 0x80, 0xd3, 64, 0x80, 0x80, 60, 0]);
    expect(poly).toMatchObject({ type: "aftertouch", note: 60, value: 1 });
    expect(chan).toMatchObject({ type: "aftertouch", channel: 4, value: 0.504 });
    expect(chan.note).toBeUndefined();
    expect(off).toMatchObject({ type: "noteoff", note: 60, velocity: 0 });
  });

  it("SysEx sur deux paquets, temps réel intercalé ; horloge non exposée", () => {
    const d = new BleMidiDecoder();
    expect(d.events([0x80, 0x81, 0xf0, 0x7e, 0x00, 0x81, 0xf8, 0x01])).toEqual([]);
    const [e] = d.events([0x80, 0x02, 0x03, 0x82, 0xf7]);
    expect(e).toMatchObject({ type: "sysex", data: [0xf0, 0x7e, 0x00, 0x01, 0x02, 0x03, 0xf7], t: 2 });
    expect(d.feed([0x80, 0x81, 0xf8, 0x81, 0xfa]).map((m) => m.data)).toEqual([[0xf8], [0xfa]]);
    expect(d.events([0x80, 0x81, 0xfa])[0].type).toBe("start");
  });

  it("paquets invalides ou tronqués : ignorés sans lever", () => {
    const d = new BleMidiDecoder();
    expect(d.events([0x40, 0x80, 0x90, 60, 1])).toEqual([]);
    expect(d.events([0x80])).toEqual([]);
    expect(d.events([0x80, 0x80, 0x90, 60])).toEqual([]);
    expect(d.events([0x80, 0x80, 0x90, 61, 1])[0].note).toBe(61);
  });

  it("notes tenues : on, off, all notes off", () => {
    const d = new BleMidiDecoder();
    let held = d.events([0x80, 0x80, 0x90, 60, 100, 64, 100, 0x80, 0x91, 67, 100]).reduce(trackNotes, []);
    expect(held.map((h) => [h.note, h.channel])).toEqual([[60, 1], [64, 1], [67, 2]]);
    held = d.events([0x80, 0x80, 0x80, 60, 0]).reduce(trackNotes, held);
    held = d.events([0x80, 0x80, 0xb1, 123, 0]).reduce(trackNotes, held);
    expect(held.map((h) => h.note)).toEqual([64]);
  });
});

describe("encodage BLE-MIDI", () => {
  it("messages découpés, SysEx et octets mal formés refusés", () => {
    expect(splitMidi([0x90, 60, 100, 0xb0, 7, 64, 0xf8])).toEqual([[0x90, 60, 100], [0xb0, 7, 64], [0xf8]]);
    expect(splitMidi([0xf0, 1, 0xf7])).toBeNull();
    expect(splitMidi([60, 100])).toBeNull();
    expect(splitMidi([0x90, 60])).toBeNull();
    expect(splitMidi([0x90, 60, 200])).toBeNull();
  });

  it("horodatage devant chaque message, paquets de 20 octets sans couper un message, relu par le décodeur", () => {
    const [p] = encodeBleMidi([[0x90, 60, 100]], (3 << 7) | 9);
    expect(Array.from(p)).toEqual([0x83, 0x89, 0x90, 60, 100]);
    const many = Array.from({ length: 10 }, (_, i) => [0x90, 60 + i, 100]);
    const packets = encodeBleMidi(many, 0);
    expect(packets.every((x) => x.length <= 20)).toBe(true);
    expect(packets.map((x) => x.length)).toEqual([17, 17, 9]);
    const d = new BleMidiDecoder();
    expect(packets.flatMap((x) => d.events(x)).map((e) => e.note)).toEqual(many.map((m) => m[1]));
  });
});

// ─── Transport en profil midi ────────────────────────────────────────────────────────────────────────────────────
const MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
const MIDI_CHAR = "7772e5db-3868-4112-a1a9-f2669d106bf3";

class FakeChar extends EventTarget {
  value: DataView | null = null;
  written: Uint8Array[] = [];
  properties = { writeWithoutResponse: true, notify: true, read: true };
  uuid = MIDI_CHAR;
  async readValue(): Promise<DataView> {
    return new DataView(new ArrayBuffer(0));
  }
  async writeValueWithoutResponse(data: Uint8Array): Promise<void> {
    this.written.push(Uint8Array.from(data));
  }
  async startNotifications(): Promise<void> {}
  async stopNotifications(): Promise<void> {}
  notify(bytes: number[]): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

function midiDevice() {
  const ch = new FakeChar();
  const device = Object.assign(new EventTarget(), {
    id: "midi-1",
    name: "Clavier BLE",
    gatt: {
      connected: false,
      async connect() {
        this.connected = true;
        return this;
      },
      disconnect() {
        this.connected = false;
      },
      async getPrimaryService(uuid: string) {
        if (uuid !== MIDI_SERVICE) throw Object.assign(new Error("NotFoundError"), { name: "NotFoundError" });
        return { uuid, getCharacteristics: async () => [ch], getCharacteristic: async () => ch };
      },
    },
  });
  return { device, ch };
}

describe("sonic-bluetooth profile=\"midi\"", () => {
  it("notifications décodées dans midi.last / midi.notes, action midi:message vers target, envoi par midiSend", async () => {
    expect(expandUuid("03B80E5A-EDE8-4B33-A751-6CE34EC4C700")).toBe(MIDI_SERVICE);
    const { device, ch } = midiDevice();
    stub(navigator, "bluetooth", { requestDevice: async () => device });
    const actions: { type: string; payload?: unknown }[] = [];
    registerStore({ id: "jeu", dispatch: (a) => actions.push(a), getState: () => null, reset: () => undefined });
    try {
      document.body.insertAdjacentHTML("beforeend", `<sonic-bluetooth id="kb" profile="midi" target="jeu" rate="60"></sonic-bluetooth>`);
      const el = document.querySelector("#kb") as SonicBluetooth;
      await el.updateComplete;
      expect(await el.connect()).toBe(true);
      expect(el.getState()).toMatchObject({ profile: "midi", midi: { last: null, notes: [], n: 0, sent: 0 } });

      ch.notify([0x80, 0x81, 0x90, 60, 100, 64, 100]);
      ch.notify([0x80, 0x82, 0x80, 60, 0]);
      const s = el.getState();
      expect(s.midi?.n).toBe(3);
      expect(s.midi?.last).toMatchObject({ type: "noteoff", note: 60 });
      expect(s.midi?.notes.map((n) => n.note)).toEqual([64]);
      expect(actions.map((a) => [a.type, (a.payload as BleMidiEvent).type])).toEqual([
        ["midi:message", "noteon"], ["midi:message", "noteon"], ["midi:message", "noteoff"],
      ]);

      expect(await el.run("midiSend", { bytes: [0x90, 60, 100, 0x80, 60, 0] })).toBe(true);
      expect(ch.written.length).toBe(1);
      expect(Array.from(ch.written[0]).filter((_, i) => i !== 0 && i !== 1 && i !== 5)).toEqual([0x90, 60, 100, 0x80, 60, 0]);
      expect(el.getState().midi?.sent).toBe(2);
      expect(await el.run("midiSend", { hex: "F0 7E 00 F7" })).toBe(false);
      expect(el.getState().error).toMatch(/SysEx refusé/);
      await new Promise((r) => setTimeout(r, 40));
      expect((get("kbState") as { midi?: { n: number } }).midi?.n).toBe(3);
    } finally {
      unregisterStore("jeu");
    }
  });

  it("hors profil midi : pas d'état midi, midiSend refusé", async () => {
    document.body.insertAdjacentHTML("beforeend", `<sonic-bluetooth id="kb2" profile="uart-nus"></sonic-bluetooth>`);
    const el = document.querySelector("#kb2") as SonicBluetooth;
    await el.updateComplete;
    expect(el.getState().midi).toBeNull();
    expect(await el.run("midiSend", { bytes: [0x90, 60, 100] })).toBe(false);
  });
});
