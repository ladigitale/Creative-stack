import type { SynthDef } from "./types";

/**
 * Presets intégrés. Un agent peut les utiliser tels quels (`{ "preset": "coin" }`)
 * ou les surcharger (`{ "preset": "coin", "freq": 1320 }`).
 */
export const SFX_PRESETS: Record<string, SynthDef> = {
  /* Interface */
  click: { wave: "sine", freq: 1200, dur: 0.008, attack: 0.001, decay: 0.01, sustain: 0.5, release: 0.03, vol: 0.3 },
  hover: { wave: "sine", freq: 1800, dur: 0.005, attack: 0.001, decay: 0.005, sustain: 0.5, release: 0.02, vol: 0.1 },
  select: { wave: "square", freq: 660, arp: [0, 7], arpRate: 0.04, dur: 0.08, release: 0.04, vol: 0.18, filter: { type: "lowpass", freq: 3000 } },
  back: { wave: "square", freq: 660, slide: -5, dur: 0.07, release: 0.04, vol: 0.18, filter: { type: "lowpass", freq: 2500 } },
  toggle: { wave: "triangle", freq: 900, arp: [0, 5], arpRate: 0.03, dur: 0.06, release: 0.03, vol: 0.3 },
  error: { wave: "sawtooth", freq: 160, dur: 0.07, release: 0.03, repeat: 2, repeatGap: 0.09, vol: 0.28, filter: { type: "lowpass", freq: 1200 } },
  success: { wave: "square", freq: 523.25, arp: [0, 4, 7, 12], arpRate: 0.06, dur: 0.24, release: 0.1, vol: 0.2, filter: { type: "lowpass", freq: 4000 } },
  notify: { wave: "sine", freq: 880, arp: [0, 7, 12], arpRate: 0.07, dur: 0.21, release: 0.2, vol: 0.25 },
  type: { wave: "square", freq: 1400, dur: 0.004, attack: 0.001, release: 0.015, vol: 0.06, jitter: 2, filter: { type: "lowpass", freq: 3500 } },

  /* Jeu */
  coin: { wave: "square", freq: 987.77, arp: [0, 5], arpRate: 0.07, dur: 0.2, decay: 0.15, sustain: 0.3, release: 0.08, vol: 0.2 },
  pickup: { wave: "triangle", freq: 880, slide: 12, dur: 0.08, release: 0.05, vol: 0.35, jitter: 1 },
  jump: { wave: "square", freq: 300, slide: 12, slideTime: 0.12, dur: 0.12, release: 0.05, vol: 0.2, filter: { type: "lowpass", freq: 2500 } },
  land: { wave: "noise", dur: 0.04, release: 0.04, vol: 0.3, filter: { type: "lowpass", freq: 600 } },
  shoot: { wave: "square", freq: 900, slide: -18, dur: 0.1, release: 0.03, vol: 0.18, jitter: 1 },
  laser: { wave: "sawtooth", freq: 1400, slide: -24, dur: 0.15, release: 0.03, vol: 0.16, filter: { type: "lowpass", freq: 5000 } },
  hit: {
    wave: "noise", dur: 0.06, release: 0.04, vol: 0.35, filter: { type: "lowpass", freq: 1800 },
    layers: [{ wave: "square", freq: 160, slide: -12, dur: 0.08, release: 0.03, vol: 0.25 }],
  },
  hurt: { wave: "square", freq: 220, slide: -10, dur: 0.18, release: 0.05, vol: 0.22, vibrato: { rate: 30, depth: 30 } },
  explosion: { wave: "noise", dur: 0.35, decay: 0.3, sustain: 0.3, release: 0.4, vol: 0.5, filter: { type: "lowpass", freq: 1400, to: 90 } },
  powerup: { wave: "square", freq: 330, arp: [0, 4, 7, 12, 16, 19, 24], arpRate: 0.045, dur: 0.32, release: 0.08, vol: 0.18 },
  levelup: { wave: "triangle", freq: 523.25, arp: [0, 4, 7, 12, 7, 12, 16, 24], arpRate: 0.07, dur: 0.56, release: 0.25, vol: 0.32 },
  gameover: { wave: "triangle", freq: 392, arp: [0, -2, -4, -7], arpRate: 0.22, dur: 0.88, release: 0.4, vol: 0.35, vibrato: { rate: 6, depth: 4 } },
  whoosh: { wave: "noise", attack: 0.08, dur: 0.15, release: 0.12, vol: 0.3, filter: { type: "bandpass", freq: 400, q: 2, to: 2400 } },
  bounce: { wave: "sine", freq: 220, slide: 7, slideTime: 0.06, dur: 0.08, release: 0.05, vol: 0.4 },
  teleport: { wave: "sine", freq: 300, slide: 36, dur: 0.3, release: 0.1, vol: 0.25, vibrato: { rate: 25, depth: 40 } },
  alarm: { wave: "square", freq: 880, arp: [0, -5], arpRate: 0.15, dur: 0.6, release: 0.05, vol: 0.15 },
  step: { wave: "noise", dur: 0.02, release: 0.03, vol: 0.18, jitter: 3, filter: { type: "bandpass", freq: 900, q: 1.5 } },
};

/** Instruments pour les morceaux (percussions et mélodiques). */
export const INSTRUMENT_PRESETS: Record<string, SynthDef> = {
  /* Percussions (pistes en `x` / `X`) */
  kick: { wave: "sine", freq: 150, slide: -30, slideTime: 0.12, dur: 0.12, attack: 0.001, decay: 0.1, sustain: 0, release: 0.05, vol: 0.7 },
  snare: {
    wave: "noise", dur: 0.1, attack: 0.001, decay: 0.08, sustain: 0.2, release: 0.06, vol: 0.4, filter: { type: "highpass", freq: 1000 },
    layers: [{ wave: "triangle", freq: 190, slide: -5, dur: 0.05, attack: 0.001, release: 0.03, vol: 0.35 }],
  },
  hat: { wave: "noise", dur: 0.02, attack: 0.001, release: 0.02, vol: 0.16, filter: { type: "highpass", freq: 7000 } },
  openhat: { wave: "noise", dur: 0.15, attack: 0.001, decay: 0.1, sustain: 0.4, release: 0.1, vol: 0.14, filter: { type: "highpass", freq: 6000 } },
  clap: { wave: "noise", dur: 0.02, attack: 0.001, release: 0.05, repeat: 3, repeatGap: 0.012, vol: 0.35, filter: { type: "bandpass", freq: 1500, q: 1 } },
  tom: { wave: "sine", freq: 180, slide: -8, dur: 0.15, attack: 0.001, decay: 0.12, sustain: 0.2, release: 0.08, vol: 0.6 },
  shaker: { wave: "noise", attack: 0.01, dur: 0.03, release: 0.03, vol: 0.1, filter: { type: "bandpass", freq: 5000, q: 2 } },

  /* Mélodiques (pistes en notes) */
  lead: { wave: "square", attack: 0.005, decay: 0.1, sustain: 0.6, release: 0.08, vol: 0.18, filter: { type: "lowpass", freq: 3200 } },
  chip: { wave: "square", attack: 0.002, decay: 0.05, sustain: 0.7, release: 0.03, vol: 0.15 },
  bass: { wave: "sawtooth", attack: 0.005, decay: 0.1, sustain: 0.7, release: 0.05, vol: 0.25, filter: { type: "lowpass", freq: 700, q: 2 } },
  sub: { wave: "triangle", attack: 0.005, decay: 0.05, sustain: 0.9, release: 0.05, vol: 0.45 },
  pad: { wave: "sawtooth", attack: 0.3, decay: 0.3, sustain: 0.8, release: 0.6, vol: 0.08, filter: { type: "lowpass", freq: 1400 }, vibrato: { rate: 4, depth: 3 } },
  pluck: { wave: "triangle", attack: 0.002, decay: 0.2, sustain: 0, release: 0.1, vol: 0.35 },
  bell: {
    wave: "sine", attack: 0.002, decay: 0.6, sustain: 0, release: 0.4, vol: 0.25,
    layers: [{ wave: "sine", transpose: 19, attack: 0.002, decay: 0.3, sustain: 0, release: 0.2, vol: 0.08 }],
  },
  organ: {
    wave: "sine", attack: 0.01, sustain: 1, release: 0.06, vol: 0.2,
    layers: [{ wave: "sine", transpose: 12, attack: 0.01, sustain: 1, release: 0.06, vol: 0.1 }],
  },
  flute: { wave: "triangle", attack: 0.06, decay: 0.1, sustain: 0.8, release: 0.12, vol: 0.28, vibrato: { rate: 5, depth: 6 } },
  strings: { wave: "sawtooth", attack: 0.15, decay: 0.2, sustain: 0.85, release: 0.3, vol: 0.1, filter: { type: "lowpass", freq: 2200 }, vibrato: { rate: 5, depth: 4 } },
};

export const ALL_PRESETS: Record<string, SynthDef> = { ...SFX_PRESETS, ...INSTRUMENT_PRESETS };
