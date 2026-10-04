import { describe, expect, it } from "vitest";
import { compilePattern, SequencerCore } from "./core";

const core = (pattern: unknown, opts: Partial<{ bpm: number; swing: number; seed: number }> = {}) => {
  const { tracks, errors } = compilePattern(pattern);
  expect(errors).toEqual([]);
  const c = new SequencerCore(tracks, { bpm: 120, swing: 0, seed: 0, beats: 4, stepsPerBeat: 4, ...opts });
  c.start(1);
  return c;
};

const brief = (evs: ReturnType<SequencerCore["window"]>) =>
  evs.map(({ target, event: e }) => `${target}:${e.sample ?? e.note}@${+(e.when! - 1).toFixed(4)}`);

describe("compilePattern", () => {
  it("chaîne = ligne de notes ; objet = pads + notes + réglages", () => {
    const { tracks, errors } = compilePattern({
      lead: "c4 e4",
      drums: { kick: "x...", snare: "..x.", vel: 0.9 },
      bass: { notes: "0 2 4", scale: "a2:minor", gate: 0.5 },
    });
    expect(errors).toEqual([]);
    expect(tracks.map((t) => [t.target, t.lines.map((l) => l.key)])).toEqual([
      ["lead", ["notes"]],
      ["drums", ["kick", "snare"]],
      ["bass", ["notes"]],
    ]);
    expect(tracks[1].vel).toBe(0.9);
    expect(tracks[2].scale!.root).toBe(45);
  });

  it("erreurs lisibles", () => {
    expect(compilePattern("x..").errors[0]).toContain("objet");
    expect(compilePattern({ a: { notes: "[c4", scale: "h:minor" } }).errors.join()).toMatch(/scale.*invalide.*|"\]" manquant/);
    expect(compilePattern({ a: { kick: 3 } }).errors[0]).toContain("ligne texte attendue");
  });
});

describe("SequencerCore", () => {
  it("place les événements d'une mesure (120 bpm : mesure 2 s, pas 0.125 s)", () => {
    // une ligne = une mesure : "..x." (4 cases) frappe une fois, au 3e quart ;
    // "[..x.]*4" frappe à chaque temps
    const c = core({ drums: { kick: "x...x...x...x...", hat: "..x.", ride: "[..x.]*4" }, lead: "c4 [e4 g4]" });
    expect(brief(c.window(1, 3))).toEqual([
      "drums:kick@0", "lead:60@0",
      "drums:ride@0.25",
      "drums:kick@0.5",
      "drums:ride@0.75",
      "drums:kick@1", "drums:hat@1", "lead:64@1",
      "drums:ride@1.25",
      "drums:kick@1.5", "lead:67@1.5",
      "drums:ride@1.75",
    ]);
  });

  it("fenêtres successives : ni trou ni doublon", () => {
    const c = core({ d: { k: "x*16" } });
    const all: string[] = [];
    for (let t = 1; t < 5; t += 0.037) all.push(...brief(c.window(t, Math.min(t + 0.037, 5))));
    expect(all.length).toBe(32);
    expect(new Set(all).size).toBe(32);
  });

  it("durées, vélocité, accent, ids stables", () => {
    const c = core({ lead: { notes: "c4 - e4 g4", vel: 0.6, gate: 0.5 }, d: { k: "X..x" } });
    const evs = c.window(1, 3);
    const c4 = evs.find((e) => e.event.note === 60)!.event;
    expect(c4.durS).toBeCloseTo(0.5); // 2 cases de 0.5 s, gate 0.5
    expect(c4.vel).toBe(0.6);
    const kicks = evs.filter((e) => e.event.sample === "k").map((e) => e.event.vel);
    expect(kicks[0]).toBeGreaterThan(kicks[1]!);
    expect(c.window(1, 3).map((e) => e.event.id)).toEqual(evs.map((e) => e.event.id));
  });

  it("accords, degrés de gamme, transposition", () => {
    const c = core({ keys: "c4+e4+g4", bass: { notes: "0 1 2 -1", scale: "a2:minor-pentatonic", transpose: 12 } });
    const evs = c.window(1, 3);
    expect(evs.filter((e) => e.target === "keys").map((e) => e.event.note)).toEqual([60, 64, 67]);
    expect(evs.filter((e) => e.target === "bass").map((e) => e.event.note)).toEqual([57, 60, 62, 55]);
  });

  it("alternance d'une mesure à l'autre", () => {
    const c = core({ lead: "<c4 e4 g4>" });
    expect(c.window(1, 7).map((e) => e.event.note)).toEqual([60, 64, 67]);
  });

  it("swing : pas impairs retardés", () => {
    const c = core({ d: { k: "x*4" } }, { swing: 0.5 });
    // x*4 tombe sur les pas 0 4 8 12 (pairs) : pas de swing
    expect(brief(c.window(1, 3)).map((s) => s.split("@")[1])).toEqual(["0", "0.5", "1", "1.5"]);
    const c2 = core({ d: { k: "xxxx" } }, { swing: 0.5, bpm: 480 }); // 4 pas par mesure de 0.5 s → grille de 16 pas
    const t = c2.window(1, 1.5).map((e) => +(e.event.when! - 1).toFixed(5));
    expect(t).toEqual([0, 0.125, 0.25, 0.375]);
    const steps = c2.steps(1, 1.5).map((s) => +(s.when - 1).toFixed(5));
    // pas de 0.03125 s, swing 0.5 → pas impairs + 0.015625 s
    expect(steps.slice(0, 4)).toEqual([0, 0.04688, 0.0625, 0.10938]);
  });

  it("changement de tempo : la position est conservée", () => {
    const c = core({ d: { k: "x*16" } });
    expect(c.position(2)).toBeCloseTo(0.5);
    c.setBpm(60, 2);
    expect(c.position(2)).toBeCloseTo(0.5);
    expect(c.barDur).toBe(4);
  });

  it("pas de la grille : step, beat, bar, phase", () => {
    const c = core({});
    const s = c.steps(1, 3.01);
    expect(s.length).toBe(17);
    expect(s[5]).toMatchObject({ step: 5, beat: 1, bar: 0, phase: 5 / 16 });
    expect(s[16]).toMatchObject({ step: 0, bar: 1 });
  });

  it("graine : même graine, mêmes événements", () => {
    const mk = (seed: number) => core({ d: { k: "x?0.5*16" } }, { seed });
    const a = mk(42).window(1, 9).map((e) => e.event.id);
    expect(mk(42).window(1, 9).map((e) => e.event.id)).toEqual(a);
    expect(mk(7).window(1, 9).map((e) => e.event.id)).not.toEqual(a);
  });

  it("valeur invalide : ignorée et signalée", () => {
    const c = core({ lead: "c4 zz9" });
    expect(c.window(1, 3).length).toBe(1);
    expect([...c.invalid][0]).toContain('"zz9"');
  });
});
