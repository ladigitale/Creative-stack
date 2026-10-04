import { describe, expect, it } from "vitest";
import { validateSoundBank } from "./bank";
import { SongPlayer, type SongPosition } from "./sequencer";

function songOf(def: Record<string, unknown>) {
  const { bank, errors } = validateSoundBank({ songs: { s: def } });
  expect(errors).toEqual([]);
  return bank.songs.s;
}

describe("SongPlayer", () => {
  const base = {
    bpm: 120,
    instruments: { lead: "lead", kick: "kick" },
    patterns: {
      I: { lead: "C4 . . ." },
      A: { lead: "E4 - . .", kick: "x . x ." },
    },
    sequence: ["I", "A"],
  };

  it("programme les notes aux bons instants avec la bonne tenue", () => {
    const notes: [string, number, number][] = [];
    const p = new SongPlayer(songOf({ ...base, loop: false }), {
      note: (ev, t, hold) => notes.push([ev.instrument, +t.toFixed(3), +hold.toFixed(3)]),
    });
    p.start(1);
    p.schedule(100);
    // pas = 60/120/4 = 0.125 s
    expect(notes).toEqual([
      ["lead", 1, 0.115],
      ["lead", 1.5, 0.23], // E4 tenu 2 pas
      ["kick", 1.5, -1], // frappe isolée : durée de l'instrument
      ["kick", 1.75, -1],
    ]);
    expect(p.ended).toBe(true);
  });

  it("ne programme que jusqu'à l'horizon", () => {
    let count = 0;
    const p = new SongPlayer(songOf(base), { note: () => count++ });
    p.start(0);
    p.schedule(0.3); // pas 0, 1, 2
    expect(count).toBe(1);
    p.schedule(0.6); // pas 3, 4
    expect(count).toBe(3);
  });

  it("boucle depuis loopFrom et compte les tours", () => {
    const beats: SongPosition[] = [];
    const p = new SongPlayer(songOf({ ...base, loopFrom: 1 }), {
      note: () => {},
      beat: (pos) => beats.push(pos),
    });
    p.start(0);
    p.schedule(0.5 * 4 - 0.01); // 4 temps = I, A, A, A
    expect(beats.map((b) => b.pattern)).toEqual(["I", "A", "A", "A"]);
    expect(beats.map((b) => b.loops)).toEqual([0, 0, 1, 2]);
    expect(beats.map((b) => b.beat)).toEqual([0, 1, 2, 3]);
  });

  it("fin d'un morceau non bouclé", () => {
    let endAt = -1;
    const p = new SongPlayer(songOf({ ...base, loop: false }), { note: () => {}, end: (t) => (endAt = t) });
    p.start(0);
    p.schedule(10);
    expect(endAt).toBeCloseTo(1);
    expect(p.isRunning).toBe(false);
  });

  it("swing : pas impairs retardés", () => {
    const times: number[] = [];
    const p = new SongPlayer(
      songOf({ bpm: 120, swing: 0.5, instruments: { kick: "kick" }, patterns: { A: { kick: "x x x x" } }, loop: false }),
      { note: (_e, t) => times.push(+t.toFixed(4)) },
    );
    p.start(0);
    p.schedule(10);
    expect(times).toEqual([0, 0.1875, 0.25, 0.4375]);
  });

  it("pause / reprise", () => {
    let count = 0;
    const p = new SongPlayer(songOf(base), { note: () => count++ });
    p.start(0);
    p.schedule(0.1);
    p.pause();
    p.schedule(5);
    expect(count).toBe(1);
    p.resume(5);
    p.schedule(5.4);
    // reprise à 5 s : pas 1-3 de I (vides) puis A pas 0 à 5.375 s (E4 + kick)
    expect(count).toBe(3);
  });
});
