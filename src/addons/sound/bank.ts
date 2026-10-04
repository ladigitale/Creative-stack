/**
 * Normalisation et validation d'une banque son. Pur (sans DOM ni WebAudio) :
 * utilisable côté serveur pour valider ce qu'un agent a écrit.
 */
import { ALL_PRESETS, INSTRUMENT_PRESETS } from "./presets";
import type {
  FilterType,
  NoteEvent,
  ResolvedBank,
  ResolvedPattern,
  ResolvedSfx,
  ResolvedSong,
  ResolvedSynth,
  SoundBank,
  SynthDef,
  Wave,
} from "./types";

export const LIMITS = {
  sfx: 200,
  songs: 50,
  patternsPerSong: 64,
  instrumentsPerSong: 16,
  stepsPerPattern: 256,
  sequence: 512,
  layers: 4,
  arp: 32,
};

const WAVES: Wave[] = ["sine", "square", "triangle", "sawtooth", "noise"];
const FILTERS: FilterType[] = ["lowpass", "highpass", "bandpass", "notch"];
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

const NOTE_OFFSETS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** `C4` → 60, `C#4` → 61, `Eb3` → 51. null si invalide. */
export function noteToMidi(note: string): number | null {
  const m = /^([A-Ga-g])(#|b)?(-?\d)$/.exec(note);
  if (!m) return null;
  let midi = (Number(m[3]) + 1) * 12 + NOTE_OFFSETS[m[1].toLowerCase()];
  if (m[2] === "#") midi += 1;
  if (m[2] === "b") midi -= 1;
  return midi >= 0 && midi <= 127 ? midi : null;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/* ------------------------------------------------------------------ */

type Ctx = { errors: string[] };

function num(
  ctx: Ctx,
  where: string,
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    ctx.errors.push(`${where} : nombre attendu, reçu ${JSON.stringify(value)}`);
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

const DEFAULTS = {
  wave: "square" as Wave,
  freq: 440,
  transpose: 0,
  slide: 0,
  dur: 0.15,
  attack: 0.005,
  decay: 0.05,
  sustain: 0.8,
  release: 0.05,
  vol: 0.3,
  arpRate: 0.05,
  repeat: 1,
  repeatGap: 0.05,
  jitter: 0,
  pan: 0,
};

function mergePreset(ctx: Ctx, where: string, def: SynthDef): SynthDef {
  if (!def.preset) return def;
  const base = ALL_PRESETS[def.preset];
  if (!base) {
    ctx.errors.push(`${where} : preset inconnu "${def.preset}"`);
    return def;
  }
  const { preset: _p, ...rest } = def;
  return {
    ...base,
    ...rest,
    filter: rest.filter ? { ...(base.filter ?? {}), ...rest.filter } as SynthDef["filter"] : base.filter,
  };
}

export function resolveSynth(
  ctx: Ctx,
  where: string,
  raw: unknown,
  depth = 0,
): ResolvedSynth | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    ctx.errors.push(`${where} : objet attendu`);
    return null;
  }
  const def = mergePreset(ctx, where, raw as SynthDef);
  let wave = DEFAULTS.wave;
  if (def.wave !== undefined) {
    if (WAVES.includes(def.wave)) wave = def.wave;
    else ctx.errors.push(`${where}.wave : "${def.wave}" inconnu (${WAVES.join(", ")})`);
  }
  let arp: number[] | null = null;
  if (def.arp !== undefined) {
    if (Array.isArray(def.arp) && def.arp.length) {
      arp = def.arp.slice(0, LIMITS.arp).map((v, i) => num(ctx, `${where}.arp[${i}]`, v, 0, -48, 48));
    } else ctx.errors.push(`${where}.arp : tableau de demi-tons attendu`);
  }
  let vibrato: ResolvedSynth["vibrato"] = null;
  if (def.vibrato) {
    vibrato = {
      rate: num(ctx, `${where}.vibrato.rate`, def.vibrato.rate, 5, 0, 100),
      depth: num(ctx, `${where}.vibrato.depth`, def.vibrato.depth, 5, 0, 2000),
    };
  }
  let filter: ResolvedSynth["filter"] = null;
  if (def.filter) {
    const type = def.filter.type ?? "lowpass";
    if (!FILTERS.includes(type)) ctx.errors.push(`${where}.filter.type : "${type}" inconnu`);
    filter = {
      type: FILTERS.includes(type) ? type : "lowpass",
      freq: num(ctx, `${where}.filter.freq`, def.filter.freq, 2000, 20, 20000),
      q: num(ctx, `${where}.filter.q`, def.filter.q, 1, 0.0001, 30),
      to: def.filter.to === undefined ? null : num(ctx, `${where}.filter.to`, def.filter.to, 2000, 20, 20000),
    };
  }
  const layers: ResolvedSynth[] = [];
  if (def.layers !== undefined) {
    if (depth >= 1) ctx.errors.push(`${where}.layers : couches imbriquées non supportées`);
    else if (!Array.isArray(def.layers)) ctx.errors.push(`${where}.layers : tableau attendu`);
    else {
      if (def.layers.length > LIMITS.layers)
        ctx.errors.push(`${where}.layers : ${LIMITS.layers} couches maximum`);
      def.layers.slice(0, LIMITS.layers).forEach((l, i) => {
        const r = resolveSynth(ctx, `${where}.layers[${i}]`, l, depth + 1);
        if (r) layers.push(r);
      });
    }
  }
  return {
    wave,
    freq: num(ctx, `${where}.freq`, def.freq, DEFAULTS.freq, 20, 20000),
    transpose: num(ctx, `${where}.transpose`, def.transpose, 0, -48, 48),
    slide: num(ctx, `${where}.slide`, def.slide, 0, -96, 96),
    slideTime: def.slideTime === undefined ? null : num(ctx, `${where}.slideTime`, def.slideTime, 0.1, 0.001, 10),
    dur: num(ctx, `${where}.dur`, def.dur, DEFAULTS.dur, 0, 10),
    attack: num(ctx, `${where}.attack`, def.attack, DEFAULTS.attack, 0, 10),
    decay: num(ctx, `${where}.decay`, def.decay, DEFAULTS.decay, 0, 10),
    sustain: num(ctx, `${where}.sustain`, def.sustain, DEFAULTS.sustain, 0, 1),
    release: num(ctx, `${where}.release`, def.release, DEFAULTS.release, 0, 10),
    vol: num(ctx, `${where}.vol`, def.vol, DEFAULTS.vol, 0, 1),
    arp,
    arpRate: num(ctx, `${where}.arpRate`, def.arpRate, DEFAULTS.arpRate, 0.01, 2),
    vibrato,
    filter,
    repeat: Math.round(num(ctx, `${where}.repeat`, def.repeat, 1, 1, 16)),
    repeatGap: num(ctx, `${where}.repeatGap`, def.repeatGap, DEFAULTS.repeatGap, 0, 2),
    jitter: num(ctx, `${where}.jitter`, def.jitter, 0, 0, 24),
    pan: num(ctx, `${where}.pan`, def.pan, 0, -1, 1),
    layers,
  };
}

/* ------------------------------------------------------------------ */

function tokens(track: string): string[] {
  return track.split(/[\s|]+/).filter(Boolean);
}

export function parsePattern(
  ctx: Ctx,
  where: string,
  name: string,
  tracks: Record<string, string>,
  instruments: Record<string, ResolvedSynth>,
): ResolvedPattern {
  const parsed: Record<string, string[]> = {};
  let length = 1;
  for (const [inst, track] of Object.entries(tracks ?? {})) {
    if (!instruments[inst]) {
      ctx.errors.push(`${where}.${inst} : instrument non déclaré`);
      continue;
    }
    if (typeof track !== "string") {
      ctx.errors.push(`${where}.${inst} : piste texte attendue`);
      continue;
    }
    const t = tokens(track);
    if (t.length > LIMITS.stepsPerPattern) {
      ctx.errors.push(`${where}.${inst} : ${LIMITS.stepsPerPattern} pas maximum`);
    }
    parsed[inst] = t.slice(0, LIMITS.stepsPerPattern);
    length = Math.max(length, parsed[inst].length);
  }
  const events: NoteEvent[][] = Array.from({ length }, () => []);
  for (const [inst, raw] of Object.entries(parsed)) {
    if (!raw.length) continue;
    if (length % raw.length !== 0) {
      ctx.errors.push(
        `${where}.${inst} : ${raw.length} pas ne divise pas la longueur du motif (${length}), piste complétée par des silences`,
      );
    }
    // Une piste plus courte se répète si elle divise la longueur, sinon on complète.
    const full =
      length % raw.length === 0
        ? Array.from({ length }, (_, i) => raw[i % raw.length])
        : [...raw, ...Array(length - raw.length).fill(".")];
    for (let i = 0; i < length; i++) {
      const tok = full[i];
      if (tok === "." || tok === "-") continue;
      let hold = 1;
      while (i + hold < length && full[i + hold] === "-") hold++;
      if (tok === "x" || tok === "X") {
        events[i].push({ instrument: inst, midi: null, length: hold, accent: tok === "X" });
        continue;
      }
      const accent = tok.endsWith("!");
      const body = accent ? tok.slice(0, -1) : tok;
      const midi: number[] = [];
      for (const n of body.split("+")) {
        const m = noteToMidi(n);
        if (m === null) ctx.errors.push(`${where}.${inst} pas ${i + 1} : "${n}" n'est pas une note (ex. C4, F#3, Bb2, x, ., -)`);
        else midi.push(m);
      }
      if (midi.length) events[i].push({ instrument: inst, midi, length: hold, accent });
    }
  }
  return { name, length, events };
}

function resolveSong(ctx: Ctx, where: string, raw: unknown): ResolvedSong | null {
  if (!raw || typeof raw !== "object") {
    ctx.errors.push(`${where} : objet attendu`);
    return null;
  }
  const s = raw as Record<string, any>;
  const instruments: Record<string, ResolvedSynth> = {};
  const instEntries = Object.entries((s.instruments ?? {}) as Record<string, unknown>);
  if (!instEntries.length) ctx.errors.push(`${where}.instruments : au moins un instrument requis`);
  for (const [name, def] of instEntries.slice(0, LIMITS.instrumentsPerSong)) {
    // Raccourci : `"kick": "kick"` = preset du même nom.
    const value = typeof def === "string" ? { preset: def } : def;
    const implicit =
      value && typeof value === "object" && !("preset" in value) && !("wave" in value) && INSTRUMENT_PRESETS[name]
        ? { preset: name, ...(value as object) }
        : value;
    const r = resolveSynth(ctx, `${where}.instruments.${name}`, implicit);
    if (r) instruments[name] = r;
  }
  if (instEntries.length > LIMITS.instrumentsPerSong)
    ctx.errors.push(`${where}.instruments : ${LIMITS.instrumentsPerSong} maximum`);

  const patterns: Record<string, ResolvedPattern> = {};
  const patEntries = Object.entries((s.patterns ?? {}) as Record<string, Record<string, string>>);
  if (!patEntries.length) ctx.errors.push(`${where}.patterns : au moins un motif requis`);
  for (const [name, tracks] of patEntries.slice(0, LIMITS.patternsPerSong)) {
    patterns[name] = parsePattern(ctx, `${where}.patterns.${name}`, name, tracks, instruments);
  }
  let sequence: string[] = Array.isArray(s.sequence) ? s.sequence.map(String) : Object.keys(patterns);
  const unknown = sequence.filter((p) => !patterns[p]);
  if (unknown.length) ctx.errors.push(`${where}.sequence : motifs inconnus ${[...new Set(unknown)].join(", ")}`);
  sequence = sequence.filter((p) => patterns[p]).slice(0, LIMITS.sequence);
  if (!sequence.length) return null;
  return {
    bpm: num(ctx, `${where}.bpm`, s.bpm, 120, 20, 400),
    steps: Math.round(num(ctx, `${where}.steps`, s.steps, 4, 1, 12)),
    beats: Math.round(num(ctx, `${where}.beats`, s.beats, 4, 1, 16)),
    vol: num(ctx, `${where}.vol`, s.vol, 0.8, 0, 1),
    loop: s.loop !== false,
    loopFrom: Math.round(num(ctx, `${where}.loopFrom`, s.loopFrom, 0, 0, sequence.length - 1)),
    swing: num(ctx, `${where}.swing`, s.swing, 0, 0, 0.5),
    instruments,
    patterns,
    sequence,
  };
}

/**
 * Valide et normalise une banque. Tolérant : les entrées fautives sont ignorées
 * et décrites dans `errors` (messages destinés à l'agent qui a écrit la banque).
 */
export function validateSoundBank(input: unknown): { bank: ResolvedBank; errors: string[] } {
  const ctx: Ctx = { errors: [] };
  const bank: ResolvedBank = { sfx: {}, songs: {} };
  if (input === null || input === undefined) return { bank, errors: [] };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { bank, errors: ["banque : objet { sfx, songs } attendu"] };
  }
  const raw = input as SoundBank & Record<string, unknown>;
  for (const k of Object.keys(raw)) {
    if (k !== "sfx" && k !== "songs") ctx.errors.push(`banque : clé "${k}" ignorée (attendu : sfx, songs)`);
  }
  const sfx = Object.entries(raw.sfx ?? {});
  if (sfx.length > LIMITS.sfx) ctx.errors.push(`sfx : ${LIMITS.sfx} maximum`);
  for (const [name, def] of sfx.slice(0, LIMITS.sfx)) {
    if (!NAME_RE.test(name)) {
      ctx.errors.push(`sfx.${name} : nom invalide (lettres, chiffres, _ et -, 40 max)`);
      continue;
    }
    const value = typeof def === "string" ? { preset: def } : def;
    const r = resolveSynth(ctx, `sfx.${name}`, value);
    if (!r) continue;
    const d = value as { bus?: string; cooldown?: unknown };
    if (d.bus !== undefined && d.bus !== "sfx" && d.bus !== "ui")
      ctx.errors.push(`sfx.${name}.bus : "sfx" ou "ui" attendu`);
    const sfxEntry: ResolvedSfx = {
      ...r,
      bus: d.bus === "ui" ? "ui" : "sfx",
      cooldown: num(ctx, `sfx.${name}.cooldown`, d.cooldown, 30, 0, 10000),
    };
    bank.sfx[name] = sfxEntry;
  }
  const songs = Object.entries(raw.songs ?? {});
  if (songs.length > LIMITS.songs) ctx.errors.push(`songs : ${LIMITS.songs} maximum`);
  for (const [name, def] of songs.slice(0, LIMITS.songs)) {
    if (!NAME_RE.test(name)) {
      ctx.errors.push(`songs.${name} : nom invalide (lettres, chiffres, _ et -, 40 max)`);
      continue;
    }
    if (bank.sfx[name]) ctx.errors.push(`songs.${name} : même nom qu'un sfx, le sfx est prioritaire pour "play"`);
    const r = resolveSong(ctx, `songs.${name}`, def);
    if (r) bank.songs[name] = r;
  }
  return { bank, errors: ctx.errors };
}

/** Durée d'une passe de séquence en secondes. */
export function songDuration(song: ResolvedSong): number {
  const stepDur = 60 / song.bpm / song.steps;
  return song.sequence.reduce((acc, p) => acc + song.patterns[p].length * stepDur, 0);
}

/** Banque par défaut : les presets de bruitage, prêts à l'emploi sans rien déclarer. */
export function presetSfxNames(): string[] {
  return Object.keys(ALL_PRESETS).filter((k) => !(k in INSTRUMENT_PRESETS));
}
