import { describe, expect, it } from "vitest";
import { ClockFollower, encode, matchPorts, NoteTracker, noteName, parseMidi } from "./core";

describe("parseMidi / encode", () => {
  it("décode notes, CC, bend, pression, programme, horloge", () => {
    expect(parseMidi([0x91, 60, 127])).toEqual({ kind: "noteOn", ch: 2, note: 60, vel: 1 });
    expect(parseMidi([0x90, 60, 0])).toEqual({ kind: "noteOff", ch: 1, note: 60, vel: 0 });
    expect(parseMidi([0x8f, 61, 64])).toMatchObject({ kind: "noteOff", ch: 16, note: 61 });
    expect(parseMidi([0xb0, 74, 127])).toEqual({ kind: "cc", ch: 1, cc: 74, value: 1 });
    expect(parseMidi([0xe0, 0, 64])).toEqual({ kind: "bend", ch: 1, value: 0 });
    expect(parseMidi([0xe0, 127, 127])!).toMatchObject({ value: 1 });
    expect(parseMidi([0xe0, 0, 0])!).toMatchObject({ value: -1 });
    expect(parseMidi([0xd3, 64])).toMatchObject({ kind: "pressure", ch: 4 });
    expect(parseMidi([0xa0, 60, 127])).toMatchObject({ kind: "polyPressure", note: 60, value: 1 });
    expect(parseMidi([0xc0, 5])).toEqual({ kind: "program", ch: 1, program: 5 });
    expect(parseMidi([0xf8])).toEqual({ kind: "clock" });
    expect(parseMidi([0xf2, 4, 1])).toEqual({ kind: "spp", sixteenths: 132 });
    expect(parseMidi([0xf0, 1, 2])).toBeNull();
    expect(parseMidi([0x40])).toBeNull();
  });

  it("encode puis décode à l'identique", () => {
    expect(parseMidi(encode.noteOn(10, 36, 0.5))).toMatchObject({ kind: "noteOn", ch: 10, note: 36 });
    expect(encode.noteOn(1, 60, 0)[2]).toBe(1); // vélocité 0 = note off : on garde 1
    for (const v of [-1, -0.5, 0, 0.25, 1]) expect((parseMidi(encode.bend(3, v)) as { value: number }).value).toBeCloseTo(v, 3);
    expect(encode.cc(17, 200, 2)).toEqual([0xbf, 127, 127]);
  });
});

describe("ClockFollower", () => {
  it("mesure le tempo, compte les temps, suit start / stop / SPP", () => {
    const c = new ClockFollower();
    const tick = 1000 / 48; // 120 bpm : 48 ticks/s
    expect(c.feed({ kind: "start" }, 0)).toBe("start");
    const beats: number[] = [];
    for (let i = 1; i <= 48; i++) if (c.feed({ kind: "clock" }, i * tick) === "beat") beats.push(i);
    expect(beats).toEqual([24, 48]);
    expect(c.bpm).toBeCloseTo(120, 0);
    expect(c.getState()).toMatchObject({ running: true, beat: 2, ticks: 48 });
    expect(c.feed({ kind: "stop" }, 1100)).toBe("stop");
    c.feed({ kind: "spp", sixteenths: 8 }, 1200);
    expect(c.feed({ kind: "continue" }, 1300)).toBe("continue");
    expect(c.ticks).toBe(48);
    expect(c.idle(5000)).toBe(true);
    expect(c.bpm).toBe(0);
  });
});

describe("NoteTracker", () => {
  it("hors MPE : bend et pression de canal s'appliquent à toutes les notes du canal", () => {
    const t = new NoteTracker({ mpe: false, bendRange: 2, masterBendRange: 2, masterCh: 1 });
    t.noteOn(1, 60, 0.8);
    t.noteOn(1, 64, 0.8);
    t.noteOn(2, 67, 0.8);
    const ch = t.expression({ kind: "bend", ch: 1, value: 0.5 });
    expect(ch.map((c) => [c.note, c.bend])).toEqual([[60, 1], [64, 1]]);
    expect(t.noteOff(1, 60)?.note).toBe(60);
    expect(t.held.map((h) => h.note)).toEqual([64, 67]);
  });

  it("MPE : une note par canal, bend ±48, canal maître pour tout le monde, valeurs avant le noteOn", () => {
    const t = new NoteTracker({ mpe: true, bendRange: 48, masterBendRange: 2, masterCh: 1 });
    t.expression({ kind: "bend", ch: 2, value: 0.25 }); // envoyé avant la note (MPE)
    t.expression({ kind: "cc", ch: 2, cc: 74, value: 0.9 });
    const a = t.noteOn(2, 60, 0.7);
    expect(a).toMatchObject({ bend: 12, timbre: 0.9 });
    t.noteOn(3, 64, 0.7);
    expect(t.expression({ kind: "pressure", ch: 3, value: 0.6 })).toEqual([{ note: 64, ch: 3, pressure: 0.6 }]);
    const all = t.expression({ kind: "bend", ch: 1, value: 1 });
    expect(all.map((c) => [c.note, c.bend])).toEqual([[60, 14], [64, 2]]);
    expect(t.clear().length).toBe(2);
  });
});

describe("divers", () => {
  it("noms de notes et choix des ports", () => {
    expect([noteName(60), noteName(61), noteName(21)]).toEqual(["C4", "C#4", "A0"]);
    const ports = [
      { id: "a", name: "LinnStrument MIDI", manufacturer: "Roger Linn" },
      { id: "b", name: "Digitone II", manufacturer: "Elektron" },
    ];
    expect(matchPorts(ports, "").length).toBe(2);
    expect(matchPorts(ports, "none")).toEqual([]);
    expect(matchPorts(ports, "elektron").map((p) => p.id)).toEqual(["b"]);
    expect(matchPorts(ports, "LINN").map((p) => p.id)).toEqual(["a"]);
    expect(matchPorts(ports, "first").map((p) => p.id)).toEqual(["a"]);
  });
});
