import { describe, expect, it } from "vitest";
import { midiToFreq, noteToMidi, songDuration, validateSoundBank } from "./bank";
import { INSTRUMENT_PRESETS, SFX_PRESETS } from "./presets";
import example from "./examples/neon-run.bank.json";

describe("notes", () => {
  it("noteToMidi", () => {
    expect(noteToMidi("C4")).toBe(60);
    expect(noteToMidi("A4")).toBe(69);
    expect(noteToMidi("C#4")).toBe(61);
    expect(noteToMidi("Eb3")).toBe(51);
    expect(noteToMidi("c-1")).toBe(0);
    expect(noteToMidi("H4")).toBeNull();
    expect(noteToMidi("C")).toBeNull();
  });

  it("midiToFreq", () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(57)).toBeCloseTo(220);
  });
});

describe("validateSoundBank", () => {
  it("tous les presets sont valides", () => {
    const sfx = Object.fromEntries(
      [...Object.keys(SFX_PRESETS), ...Object.keys(INSTRUMENT_PRESETS)].map((k) => [k, k]),
    );
    const { errors, bank } = validateSoundBank({ sfx });
    expect(errors).toEqual([]);
    expect(Object.keys(bank.sfx)).toHaveLength(Object.keys(sfx).length);
  });

  it("la banque d'exemple est valide", () => {
    const { errors, bank } = validateSoundBank(example);
    expect(errors).toEqual([]);
    expect(Object.keys(bank.songs)).toEqual(["theme", "boss", "win", "lose"]);
    expect(bank.songs.win.loop).toBe(false);
    expect(bank.songs.theme.loopFrom).toBe(1);
  });

  it("preset surchargé, filtre fusionné", () => {
    const { bank } = validateSoundBank({
      sfx: { c: { preset: "jump", freq: 500, filter: { freq: 900 } } },
    });
    expect(bank.sfx.c.freq).toBe(500);
    expect(bank.sfx.c.slide).toBe(12);
    expect(bank.sfx.c.filter).toEqual({ type: "lowpass", freq: 900, q: 1, to: null });
  });

  it("borne les valeurs et signale les erreurs sans bloquer le reste", () => {
    const { bank, errors } = validateSoundBank({
      sfx: {
        ok: { wave: "sine", vol: 4 },
        bad: { wave: "kazoo", freq: "fort" },
        "nom invalide": "coin",
        p: { preset: "inexistant" },
      },
      extra: true,
    });
    expect(bank.sfx.ok.vol).toBe(1);
    expect(bank.sfx.bad.wave).toBe("square");
    expect(bank.sfx["nom invalide"]).toBeUndefined();
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("bad.wave"),
        expect.stringContaining("bad.freq"),
        expect.stringContaining("nom invalide"),
        expect.stringContaining('preset inconnu "inexistant"'),
        expect.stringContaining('clé "extra"'),
      ]),
    );
  });

  it("instrument nommé comme un preset : preset implicite", () => {
    const { bank, errors } = validateSoundBank({
      songs: { s: { instruments: { kick: {}, bass: { vol: 0.1 } }, patterns: { A: { kick: "x", bass: "C2" } } } },
    });
    expect(errors).toEqual([]);
    expect(bank.songs.s.instruments.kick.slide).toBe(-30);
    expect(bank.songs.s.instruments.bass.wave).toBe("sawtooth");
    expect(bank.songs.s.instruments.bass.vol).toBe(0.1);
  });
});

describe("motifs", () => {
  const song = (tracks: Record<string, string>) =>
    validateSoundBank({
      songs: {
        s: { bpm: 120, instruments: { lead: "lead", kick: "kick", hat: "hat" }, patterns: { A: tracks } },
      },
    });

  it("notes, tenues, accords, accents, frappes", () => {
    const { bank, errors } = song({ lead: "C4 - - . E4+G4 - A4! .", kick: "x . X ." });
    expect(errors).toEqual([]);
    const p = bank.songs.s.patterns.A;
    expect(p.length).toBe(8);
    expect(p.events[0]).toEqual(
      expect.arrayContaining([
        { instrument: "lead", midi: [60], length: 3, accent: false },
        { instrument: "kick", midi: null, length: 1, accent: false },
      ]),
    );
    expect(p.events[4][0]).toEqual({ instrument: "lead", midi: [64, 67], length: 2, accent: false });
    expect(p.events[6][0]).toEqual({ instrument: "lead", midi: [69], length: 1, accent: true });
    expect(p.events[6][1]).toEqual({ instrument: "kick", midi: null, length: 1, accent: true });
  });

  it("une piste courte se répète, `|` est ignoré", () => {
    const { bank, errors } = song({ lead: "C4 . . . | . . . .", hat: ". x" });
    expect(errors).toEqual([]);
    const hats = bank.songs.s.patterns.A.events.map((e) => e.some((x) => x.instrument === "hat"));
    expect(hats).toEqual([false, true, false, true, false, true, false, true]);
  });

  it("piste qui ne divise pas la longueur : complétée et signalée", () => {
    const { errors } = song({ lead: "C4 . . . . . . .", hat: "x . x" });
    expect(errors[0]).toContain("ne divise pas");
  });

  it("erreurs : note invalide, instrument inconnu, séquence inconnue", () => {
    const { errors, bank } = validateSoundBank({
      songs: {
        s: {
          instruments: { lead: "lead" },
          patterns: { A: { lead: "C4 Z9", drums: "x" } },
          sequence: ["A", "B"],
        },
      },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"Z9" n\'est pas une note'),
        expect.stringContaining("drums : instrument non déclaré"),
        expect.stringContaining("motifs inconnus B"),
      ]),
    );
    expect(bank.songs.s.sequence).toEqual(["A"]);
  });

  it("durée", () => {
    const { bank } = song({ lead: Array(16).fill("C4").join(" ") });
    // 16 doubles croches à 120 bpm = 2 s
    expect(songDuration(bank.songs.s)).toBeCloseTo(2);
  });
});
