import { describe, expect, it } from "vitest";
import { compilePatch, type PatchNode } from "./compile";

const n = (tag: string, attrs: Record<string, string> = {}, children?: PatchNode[]): PatchNode => ({ tag, attrs, children });
const voice = (...children: PatchNode[]) => n("sonic-voice", {}, children);

describe("compilePatch", () => {
  it("phase 6 : synchro, AudioWorklet, samples de grain", () => {
    const p = compilePatch([
      voice(n("sonic-osc", { name: "m" }), n("sonic-osc", { name: "s", sync: "m" }), n("sonic-mixer", { in: "m s" }), n("sonic-ladder", { res: "0.9" })),
      n("sonic-fold", { amount: "3" }),
    ]);
    expect(p.errors).toEqual([]);
    expect(p.needsWorklet).toBe(true);
    const g = compilePatch([voice(n("sonic-grain", { sample: "takes.voix" }), n("sonic-noise"), n("sonic-resonator", { in: "noise2", partials: "1 2.76" }), n("sonic-mixer"))]);
    expect(g.errors).toEqual([]);
    expect(g.needsWorklet).toBe(false);
    expect(g.samples).toEqual(["takes.voix"]);
    const bad = [
      [[voice(n("sonic-osc", { name: "s", sync: "s" }))], "lui-même"],
      [[voice(n("sonic-osc", { name: "s", sync: "zz" }))], "n'est pas un sonic-osc"],
      [[voice(n("sonic-osc", { name: "m" })), n("sonic-lfo", { name: "l" }), voice(n("sonic-osc", { name: "s", sync: "m" }))], "même portée"],
      [[voice(n("sonic-grain"))], "sample requis"],
    ] as const;
    for (const [nodes, msg] of bad) expect(compilePatch(nodes as unknown as PatchNode[]).errors.join(" | "), msg).toContain(msg);
  });

  it("sonic-audio-input : patch d'effets sans voix, entrée chaînée", () => {
    const p = compilePatch([
      n("sonic-audio-input", { name: "voix", source: "#mic" }),
      n("sonic-filter", { name: "f", type: "bandpass", "freq-hz": "1200" }),
      n("sonic-delay", { name: "d", time: "1/8" }),
    ]);
    expect(p.errors).toEqual([]);
    expect(p.voices).toEqual([]);
    const byName = Object.fromEntries(p.global.map((m) => [m.name, m]));
    expect(byName.voix.params.source).toBe("#mic");
    expect(byName.f.inputs).toEqual(["voix"]);
    expect(p.out).toBe("d");
    const mix = compilePatch([voice(n("sonic-osc")), n("sonic-audio-input", { name: "i" }), n("sonic-mixer", { name: "m" })]);
    expect(mix.errors).toEqual([]);
    expect(mix.global.find((m) => m.name === "m")!.inputs).toEqual(["voices", "i"]);
  });

  it("patch soustractif : câblage explicite, modulations, sortie", () => {
    const p = compilePatch([
      voice(
        n("sonic-osc", { name: "o1", wave: "sawtooth", detune: "-7" }),
        n("sonic-osc", { name: "o2", wave: "square", octave: "-1" }),
        n("sonic-mixer", { name: "mix", in: "o1 o2", levels: "0.6 0.5" }),
        n("sonic-env", { name: "fenv", a: "0.01", d: "0.3", s: "0.2", r: "0.4" }),
        n("sonic-filter", { name: "flt", in: "mix", "freq-hz": "600", q: "6" }),
        n("sonic-env", { name: "aenv" }),
        n("sonic-vca", { name: "amp", in: "flt", gain: "aenv" }),
        n("sonic-mod", { from: "fenv", to: "flt.freq-hz", amount: "3000" }),
        n("sonic-mod", { from: "voice.vel", to: "flt.freq-hz", amount: "1500" }),
      ),
      n("sonic-lfo", { name: "lfo1", "rate-hz": "0.3" }),
      n("sonic-mod", { from: "lfo1", to: "o1.detune", amount: "12" }),
      n("sonic-delay", { name: "dly", time: "3/16", feedback: "0.4" }),
      n("sonic-reverb", { name: "rev", in: "dly" }),
    ]);
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.voice.map((m) => m.name)).toEqual(["o1", "o2", "mix", "fenv", "flt", "aenv", "amp"]);
    expect(p.global.map((m) => m.name)).toEqual(["lfo1", "dly", "rev"]);
    expect(p.voiceOut).toBe("amp");
    expect(p.out).toBe("rev");
    expect(p.global.find((m) => m.name === "dly")!.inputs).toEqual(["voices"]);
    expect(p.voice.find((m) => m.name === "mix")!.levels).toEqual([0.6, 0.5]);
    expect(p.voice.find((m) => m.name === "o1")!.params["freq-hz"]).toBe("voice.pitch");
    expect(p.voice.find((m) => m.name === "amp")!.params.gain).toBe(0); // piloté par aenv
    expect(p.global.find((m) => m.name === "dly")!.params.time).toBe("3/16");
    expect(p.mods).toEqual([
      { from: "aenv", module: "amp", param: "gain", amount: 1, exp: false },
      { from: "fenv", module: "flt", param: "freq-hz", amount: 3000, exp: false },
      { from: "voice.vel", module: "flt", param: "freq-hz", amount: 1500, exp: false },
      { from: "lfo1", module: "o1", param: "detune", amount: 12, exp: false },
    ]);
  });

  it("chaîne implicite et mixer qui prend les sources en attente", () => {
    const p = compilePatch([
      voice(
        n("sonic-osc", { name: "a" }),
        n("sonic-noise", { name: "b" }),
        n("sonic-mixer", { name: "m" }),
        n("sonic-filter", { name: "f" }),
        n("sonic-vca", { name: "v" }),
      ),
      n("sonic-delay", { name: "d" }),
      n("sonic-pan", { name: "p" }),
    ]);
    expect(p.errors).toEqual([]);
    const byName = Object.fromEntries([...p.voice, ...p.global].map((m) => [m.name, m.inputs]));
    expect(byName).toMatchObject({ m: ["a", "b"], f: ["m"], v: ["f"], d: ["voices"], p: ["d"] });
    expect(p.voiceOut).toBe("v");
    expect(p.out).toBe("p");
  });

  it("noms automatiques et sortie 'voices' sans chaîne globale", () => {
    const p = compilePatch([voice(n("sonic-osc"), n("sonic-filter"))]);
    expect(p.errors).toEqual([]);
    expect(p.voice.map((m) => m.name)).toEqual(["osc1", "filter2"]);
    expect(p.voice[1].inputs).toEqual(["osc1"]);
    expect(p.out).toBe("voices");
  });

  it("FM : sucre fm= et modulation exponentielle", () => {
    const p = compilePatch([
      voice(
        n("sonic-osc", { name: "mod", wave: "sine", semi: "19" }),
        n("sonic-osc", { name: "car", wave: "sine", fm: "mod", "fm-amount": "400" }),
        n("sonic-env", { name: "e" }),
        n("sonic-mod", { from: "e", to: "car.freq-hz", amount: "12", curve: "exp" }),
        n("sonic-vca", { in: "car", gain: "e" }),
      ),
    ]);
    expect(p.errors).toEqual([]);
    expect(p.mods).toEqual(
      expect.arrayContaining([
        { from: "mod", module: "car", param: "freq-hz", amount: 400, exp: false },
        { from: "e", module: "car", param: "detune", amount: 1200, exp: true },
      ]),
    );
  });

  it("paramètres pilotés : source DP, expose, bornes", () => {
    const p = compilePatch([
      voice(n("sonic-osc"), n("sonic-filter", { name: "f" })),
      n("sonic-param", { to: "f.freq-hz", source: "game.cutoff", "ramp-s": "0.05", min: "100", max: "8000" }),
      n("sonic-param", { to: "f.q", expose: "reso", value: "4" }),
    ]);
    expect(p.errors).toEqual([]);
    expect(p.params).toEqual([
      { module: "f", param: "freq-hz", source: "game.cutoff", expose: null, value: null, rampS: 0.05, min: 100, max: 8000 },
      { module: "f", param: "q", source: null, expose: "reso", value: 4, rampS: 0.02, min: null, max: null },
    ]);
  });

  it("bornes et valeurs invalides : avertissements, le patch joue", () => {
    const p = compilePatch([voice(n("sonic-osc", { wave: "kazoo", detune: "99999", level: "1..5", couleur: "rouge" }))]);
    expect(p.errors).toEqual([]);
    expect(p.voice[0].params).toMatchObject({ wave: "sawtooth", detune: 4800, level: 1 });
    expect(p.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"kazoo" inconnu'),
        expect.stringContaining('"1..5" invalide'),
        expect.stringContaining('attribut "couleur" inconnu'),
      ]),
    );
  });

  it("erreurs : structure, noms, cibles, portées", () => {
    const cases: [PatchNode[], string][] = [
      [[n("sonic-osc")], "doit contenir un sonic-voice"],
      [[voice(n("sonic-osc")), voice(n("sonic-osc"))], "chacun doit avoir un sample ou une note"],
      [[n("sonic-voice", { sample: "a" }, [n("sonic-osc", { name: "x" }), n("sonic-env", { name: "e" })]), n("sonic-voice", { sample: "b" }, [n("sonic-osc", { name: "y" }), n("sonic-mod", { from: "e", to: "y.detune" })])], "deux sonic-voice différents"],
      [[n("sonic-voice", { note: "H9" }, [n("sonic-osc")])], 'note "H9" invalide'],
      [[voice(n("sonic-osc", { name: "a" }), n("sonic-osc", { name: "a" }))], 'nom "a" déjà utilisé'],
      [[voice(n("sonic-osc", { name: "voices" }))], "nom réservé"],
      [[voice(n("sonic-audio-input"), n("sonic-osc"))], "se place hors de sonic-voice"],
      [[voice(n("sonic-kazoo"))], "balise sonic-kazoo inconnue"],
      [[voice(n("sonic-osc"), n("sonic-filter", { in: "nope" }))], 'module "nope" inconnu'],
      [[voice(n("sonic-osc", { name: "o" }), n("sonic-mod", { from: "x", to: "o.detune" }))], 'source "x" inconnue'],
      [[voice(n("sonic-osc", { name: "o" }), n("sonic-mod", { from: "voice.vel", to: "o.wave" }))], "n'est pas modulable"],
      [[voice(n("sonic-osc", { name: "o" }), n("sonic-mod", { from: "voice.vel", to: "o.zzz" }))], 'pas de paramètre "zzz"'],
      [[voice(n("sonic-osc", { name: "o" }), n("sonic-env", { name: "e" })), n("sonic-filter", { name: "g" }), n("sonic-mod", { from: "e", to: "g.freq-hz" })], "ne peut pas moduler un module global"],
      [[voice(n("sonic-osc")), n("sonic-filter", { name: "g" }), n("sonic-mod", { from: "voice.vel", to: "g.q" })], "n'existe que pour un module de sonic-voice"],
      [[voice(n("sonic-osc", { name: "o" })), n("sonic-filter", { in: "o" })], "hors voix, utiliser \"voices\""],
      [[voice(n("sonic-env"))], "aucun module audio"],
      [[voice(n("sonic-osc", { level: "fort" }))], 'source "fort" inconnue'],
      [[voice(n("sonic-osc", { name: "o" }), n("sonic-mod", { from: "voice.vel", to: "o.detune", curve: "exp" }))], 'curve="exp" seulement'],
    ];
    for (const [nodes, msg] of cases) {
      const p = compilePatch(nodes);
      expect(p.errors.join(" | "), msg).toContain(msg);
    }
  });

  it("plusieurs sonic-voice : kit déclenché par nom ou note", () => {
    const p = compilePatch([
      n("sonic-voice", { sample: "kick" }, [n("sonic-osc", { name: "k", "freq-hz": "60" }), n("sonic-vca", { name: "kv" })]),
      n("sonic-voice", { sample: "hat", note: "F#2" }, [n("sonic-noise", { name: "h" }), n("sonic-filter", { name: "hf", type: "highpass" })]),
      n("sonic-voice", {}, [n("sonic-osc", { name: "def" })]),
    ]);
    expect(p.errors).toEqual([]);
    expect(p.voices.map((v) => [v.sample, v.note, v.out, v.modules.map((m) => m.name)])).toEqual([
      ["kick", null, "kv", ["k", "kv"]],
      ["hat", 42, "hf", ["h", "hf"]],
      [null, null, "def", ["def"]],
    ]);
    expect(p.voices[1].modules[1].inputs).toEqual(["h"]);
  });

  it("boucle audio : refusée sans délai, acceptée à travers un sonic-delay", () => {
    const bad = compilePatch([voice(n("sonic-osc")), n("sonic-filter", { name: "a", in: "voices b" }), n("sonic-shaper", { name: "b", in: "a" })]);
    expect(bad.errors.join()).toContain("boucle audio sans sonic-delay");
    const ok = compilePatch([voice(n("sonic-osc")), n("sonic-filter", { name: "a", in: "voices d" }), n("sonic-delay", { name: "d", in: "a" })]);
    expect(ok.errors).toEqual([]);
  });
});

describe("bibliothèque de patches", () => {
  it("tous les presets compilent sans erreur ni avertissement", async () => {
    const { PATCH_LIBRARY } = await import("./library");
    for (const [name, { nodes }] of Object.entries(PATCH_LIBRARY)) {
      const p = compilePatch(nodes);
      expect(p.errors, name).toEqual([]);
      expect(p.warnings, name).toEqual([]);
    }
  });

  it("drums/kit : un sonic-voice par pad, nommé et noté General MIDI", async () => {
    const { PATCH_LIBRARY } = await import("./library");
    const p = compilePatch(PATCH_LIBRARY["drums/kit"].nodes);
    expect(p.voices.map((v) => [v.sample, v.note])).toEqual([
      ["kick", 36],
      ["snare", 38],
      ["clap", 39],
      ["hat", 42],
      ["openhat", 46],
    ]);
  });

  it("curve=\"exp\" : vers freq-hz de tout module qui a aussi un detune (ladder compris)", () => {
    const ok = compilePatch([
      voice(n("sonic-osc", { name: "o" }), n("sonic-ladder", { name: "f", in: "o" }), n("sonic-lfo", { name: "l" }), n("sonic-mod", { from: "l", to: "f.freq-hz", amount: "12", curve: "exp" })),
    ]);
    expect(ok.errors).toEqual([]);
    expect(ok.mods[0]).toMatchObject({ module: "f", param: "detune", amount: 1200, exp: true });
    const filt = compilePatch([voice(n("sonic-osc", { name: "o" }), n("sonic-filter", { name: "f" }), n("sonic-env", { name: "e" }), n("sonic-mod", { from: "e", to: "f.freq-hz", amount: "12", curve: "exp" }))]);
    expect(filt.errors).toEqual([]);
    const bad = compilePatch([voice(n("sonic-lfo", { name: "l" }), n("sonic-pan", { name: "p" }), n("sonic-mod", { from: "l", to: "p.pan", amount: "1", curve: "exp" }))]);
    expect(bad.errors.join(" ")).toContain('curve="exp" seulement vers freq-hz de');
  });

  it("sonic-mod nommé : sa profondeur se pilote par sonic-param to=\"nom.amount\"", () => {
    const base = (...extra: PatchNode[]) => [
      voice(n("sonic-osc", { name: "o" }), n("sonic-ladder", { name: "f", in: "o" }), n("sonic-lfo", { name: "l" }),
        n("sonic-mod", { name: "vib", from: "l", to: "o.detune", amount: "0" }), n("sonic-mod", { name: "wah", from: "l", to: "f.freq-hz", amount: "2", curve: "exp" })),
      ...extra,
    ];
    const ok = compilePatch(base(n("sonic-param", { to: "vib.amount", source: "x.v", min: "0", max: "100" }), n("sonic-param", { to: "wah.amount", value: "6" })));
    expect(ok.errors).toEqual([]);
    expect(ok.mods.map((m) => [m.name, m.amount, m.exp])).toEqual([["vib", 0, false], ["wah", 200, true]]);
    expect(ok.params.map((p) => [p.module, p.param, p.source, p.value, p.min, p.max])).toEqual([["vib", "amount", "x.v", null, 0, 100], ["wah", "amount", null, 6, null, null]]);

    const msg = (nodes: PatchNode[]) => compilePatch(nodes).errors.join(" | ");
    expect(msg(base(n("sonic-param", { to: "vib.depth", value: "1" })))).toContain('n\'a que le paramètre "amount"');
    expect(msg(base(n("sonic-param", { to: "vibrato.amount", value: "1" })))).toContain('module "vibrato" inconnu');
    expect(msg([voice(n("sonic-osc", { name: "o" }), n("sonic-lfo", { name: "l" }), n("sonic-mod", { name: "o", from: "l", to: "o.detune" }))])).toContain("déjà utilisé");
    expect(msg([voice(n("sonic-osc", { name: "o" }), n("sonic-lfo", { name: "l" }), n("sonic-mod", { name: "a", from: "l", to: "o.detune" }), n("sonic-mod", { name: "a", from: "l", to: "o.detune" }))])).toContain("déjà utilisé");
  });
});
