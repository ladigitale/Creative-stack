/**
 * Bibliothèque de patches : `sonic-patch preset="synth/lead"`.
 * Chaque patch est un arbre de modules comme ceux qu'on écrit à la main ;
 * les paramètres `expose` se règlent avec l'attribut `params` du patch.
 */
import type { PatchNode } from "./compile";

const n = (tag: string, attrs: Record<string, string | number> = {}, children?: PatchNode[]): PatchNode => ({
  tag: `sonic-${tag}`,
  attrs: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)])),
  children,
});
const voice = (attrs: Record<string, string | number>, ...children: PatchNode[]) => n("voice", attrs, children);
const expose = (to: string, name: string, value: number) => n("param", { to, expose: name, value });

/** Voix de batterie réutilisées par les patches seuls et par le kit. */
const kick = (key: Record<string, string> = {}, p = "k") =>
  voice(
    key,
    n("osc", { name: `${p}o`, wave: "sine", "freq-hz": 46 }),
    n("env", { name: `${p}p`, a: 0, d: 0.09, s: 0, r: 0.05 }),
    n("mod", { from: `${p}p`, to: `${p}o.freq-hz`, amount: 26, curve: "exp" }),
    n("shaper", { name: `${p}s`, curve: "soft", drive: 1.8 }),
    n("env", { name: `${p}a`, a: 0.001, d: 0.42, s: 0, r: 0.06 }),
    n("vca", { name: `${p}v`, gain: `${p}a` }),
  );
const snare = (key: Record<string, string> = {}, p = "s") =>
  voice(
    key,
    n("noise", { name: `${p}n`, color: "white" }),
    n("filter", { name: `${p}f`, type: "highpass", "freq-hz": 1400, q: 0.7 }),
    n("env", { name: `${p}ne`, a: 0.001, d: 0.16, s: 0, r: 0.05 }),
    n("vca", { name: `${p}nv`, gain: `${p}ne` }),
    n("osc", { name: `${p}o`, wave: "triangle", "freq-hz": 185 }),
    n("env", { name: `${p}te`, a: 0.001, d: 0.07, s: 0, r: 0.03 }),
    n("mod", { from: `${p}te`, to: `${p}o.freq-hz`, amount: 5, curve: "exp" }),
    n("vca", { name: `${p}tv`, in: `${p}o`, gain: `${p}te` }),
    n("mixer", { name: `${p}m`, in: `${p}nv ${p}tv`, levels: "0.7 0.6" }),
  );
const hat = (key: Record<string, string> = {}, p = "h", decay = 0.045) =>
  voice(
    key,
    n("noise", { name: `${p}n`, color: "white" }),
    n("filter", { name: `${p}f`, type: "highpass", "freq-hz": 7500, q: 0.8 }),
    n("env", { name: `${p}e`, a: 0.001, d: decay, s: 0, r: 0.03 }),
    n("vca", { name: `${p}v`, gain: 0 }),
    n("mod", { from: `${p}e`, to: `${p}v.gain`, amount: 0.6 }),
  );
const clap = (key: Record<string, string> = {}, p = "c") =>
  voice(
    key,
    n("noise", { name: `${p}n`, color: "pink" }),
    n("filter", { name: `${p}f`, type: "bandpass", "freq-hz": 1200, q: 1.2 }),
    n("env", { name: `${p}e`, a: 0.001, d: 0.12, s: 0, r: 0.08 }),
    n("vca", { name: `${p}v`, gain: `${p}e` }),
  );

export const PATCH_LIBRARY: Record<string, { description: string; nodes: PatchNode[] }> = {
  "synth/lead": {
    description: "Lead soustractif 2 scies désaccordées, filtre à enveloppe, délai. params : cutoff, reso",
    nodes: [
      voice(
        {},
        n("osc", { name: "o1", wave: "sawtooth", detune: -6 }),
        n("osc", { name: "o2", wave: "sawtooth", detune: 6 }),
        n("mixer", { name: "mix", levels: "0.5 0.5" }),
        n("filter", { name: "flt", type: "lowpass", "freq-hz": 900, q: 4 }),
        n("env", { name: "fenv", a: 0.005, d: 0.25, s: 0.3, r: 0.25 }),
        n("env", { name: "aenv", a: 0.005, d: 0.1, s: 0.7, r: 0.2 }),
        n("vca", { name: "amp", in: "flt", gain: "aenv" }),
        n("mod", { from: "fenv", to: "flt.freq-hz", amount: 2500 }),
        n("mod", { from: "voice.vel", to: "flt.freq-hz", amount: 800 }),
      ),
      n("delay", { name: "dly", time: "3/16", feedback: 0.3, mix: 0.18 }),
      expose("flt.freq-hz", "cutoff", 900),
      expose("flt.q", "reso", 4),
    ],
  },
  "synth/bass": {
    description: "Basse scie + sous-oscillateur carré, filtre résonant. params : cutoff, reso",
    nodes: [
      voice(
        {},
        n("osc", { name: "o1", wave: "sawtooth" }),
        n("osc", { name: "sub", wave: "square", octave: -1 }),
        n("mixer", { name: "mix", levels: "0.7 0.45" }),
        n("filter", { name: "flt", type: "lowpass", "freq-hz": 280, q: 6 }),
        n("env", { name: "fenv", a: 0.002, d: 0.18, s: 0.1, r: 0.1 }),
        n("env", { name: "aenv", a: 0.003, d: 0.2, s: 0.8, r: 0.08 }),
        n("vca", { name: "amp", in: "flt", gain: "aenv" }),
        n("mod", { from: "fenv", to: "flt.freq-hz", amount: 1800 }),
      ),
      expose("flt.freq-hz", "cutoff", 280),
      expose("flt.q", "reso", 6),
    ],
  },
  "synth/pad": {
    description: "Nappe lente, scies désaccordées, LFO, chorus et réverb. params : cutoff, attack",
    nodes: [
      voice(
        {},
        n("osc", { name: "o1", wave: "sawtooth", detune: -12 }),
        n("osc", { name: "o2", wave: "sawtooth", detune: 12 }),
        n("osc", { name: "o3", wave: "triangle", octave: 1 }),
        n("mixer", { name: "mix", levels: "0.4 0.4 0.25" }),
        n("filter", { name: "flt", type: "lowpass", "freq-hz": 1400, q: 1 }),
        n("env", { name: "aenv", a: 0.6, d: 0.5, s: 0.8, r: 1.2 }),
        n("vca", { name: "amp", gain: "aenv" }),
      ),
      n("lfo", { name: "lfo", wave: "sine", "rate-hz": 0.2 }),
      n("mod", { from: "lfo", to: "o1.detune", amount: 8 }),
      n("mod", { from: "lfo", to: "flt.freq-hz", amount: 300 }),
      n("chorus", { name: "ch", "rate-hz": 0.6, depth: 4, mix: 0.5 }),
      n("reverb", { name: "rev", "size-s": 3, damp: 0.5, mix: 0.35 }),
      expose("flt.freq-hz", "cutoff", 1400),
      expose("aenv.a", "attack", 0.6),
    ],
  },
  "synth/pluck": {
    description: "Corde pincée : triangle + scie, filtre qui se referme vite, petite réverb. params : cutoff, decay",
    nodes: [
      voice(
        {},
        n("osc", { name: "o1", wave: "triangle" }),
        n("osc", { name: "o2", wave: "sawtooth", octave: 1, level: 0.3 }),
        n("mixer", { name: "mix" }),
        n("filter", { name: "flt", type: "lowpass", "freq-hz": 1200, q: 2 }),
        n("env", { name: "fenv", a: 0.001, d: 0.15, s: 0, r: 0.1 }),
        n("env", { name: "aenv", a: 0.002, d: 0.35, s: 0, r: 0.2 }),
        n("vca", { name: "amp", in: "flt", gain: "aenv" }),
        n("mod", { from: "fenv", to: "flt.freq-hz", amount: 3000 }),
      ),
      n("reverb", { name: "rev", "size-s": 1.4, damp: 0.6, mix: 0.2 }),
      expose("flt.freq-hz", "cutoff", 1200),
      expose("aenv.d", "decay", 0.35),
    ],
  },
  "synth/fm-bell": {
    description: "Cloche FM 2 opérateurs (rapport non entier), index qui décroît. params : level",
    nodes: [
      voice(
        {},
        n("env", { name: "menv", a: 0.001, d: 1.2, s: 0, r: 0.6 }),
        n("osc", { name: "mod", wave: "sine", semi: 19, detune: 14, level: "menv" }),
        n("osc", { name: "car", wave: "sine", fm: "mod", "fm-amount": 700 }),
        n("env", { name: "aenv", a: 0.002, d: 1.8, s: 0, r: 1 }),
        n("vca", { name: "amp", in: "car", gain: "aenv" }),
      ),
      n("reverb", { name: "rev", "size-s": 2.5, damp: 0.3, mix: 0.3 }),
      expose("car.level", "level", 1),
    ],
  },
  "synth/chip": {
    description: "Son chiptune : impulsion 25 %, enveloppe sèche. params : pw (aux notes suivantes)",
    nodes: [
      voice(
        {},
        n("osc", { name: "o1", wave: "pulse", pw: 0.25, level: 0.7 }),
        n("env", { name: "aenv", a: 0.001, d: 0.06, s: 0.7, r: 0.04 }),
        n("vca", { name: "amp", gain: "aenv" }),
      ),
      expose("o1.pw", "pw", 0.25),
    ],
  },
  "drums/kick": { description: "Grosse caisse de synthèse (sinus + enveloppe de hauteur)", nodes: [kick()] },
  "drums/snare": { description: "Caisse claire de synthèse (bruit + ton)", nodes: [snare()] },
  "drums/hat": { description: "Charleston fermé (bruit filtré)", nodes: [hat()] },
  "drums/kit": {
    description: "Kit complet : kick (C2), snare (D2), clap (D#2), hat (F#2), openhat (A#2). Événements { sample: \"kick\" } ou notes General MIDI",
    nodes: [
      kick({ sample: "kick", note: "C2" }, "k"),
      snare({ sample: "snare", note: "D2" }, "s"),
      clap({ sample: "clap", note: "D#2" }, "c"),
      hat({ sample: "hat", note: "F#2" }, "h"),
      hat({ sample: "openhat", note: "A#2" }, "oh", 0.3),
      n("comp", { name: "glue", "threshold-db": -10, ratio: 3, attack: 0.003, release: 0.1 }),
    ],
  },
};

export const PATCH_PRESETS = Object.keys(PATCH_LIBRARY);
