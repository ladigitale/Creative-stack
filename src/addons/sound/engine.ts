/**
 * Moteur son : contexte audio, bus, bruitages, musique, état.
 * Piloté par un objet SoundControl (réconciliation), publie un SoundState.
 */
import { AudioEngine } from "../../shared/audio/engine";
import { midiToFreq, presetSfxNames, validateSoundBank } from "./bank";
import { SFX_PRESETS } from "./presets";
import { SongPlayer, type SongPosition } from "./sequencer";
import { playSynth } from "./synth";
import type {
  ResolvedBank,
  ResolvedSfx,
  ResolvedSong,
  SoundControl,
  SoundState,
} from "./types";

const LOOKAHEAD = 0.12;
const TICK_MS = 25;
const DEFAULT_FADE = 0.6;
const BUSES = ["master", "music", "sfx", "ui"] as const;
type Bus = (typeof BUSES)[number];

type Playing = { id: string; player: SongPlayer; gain: GainNode; stopAt: number | null };

const presetCache: Record<string, ResolvedSfx> = (() => {
  const { bank } = validateSoundBank({
    sfx: Object.fromEntries(presetSfxNames().map((n) => [n, { preset: n, bus: uiPreset(n) ? "ui" : "sfx" }])),
  });
  return bank.sfx;
})();

function uiPreset(name: string): boolean {
  return ["click", "hover", "select", "back", "toggle", "error", "success", "notify", "type"].includes(name);
}

function idleMusic(): SoundState["music"] {
  return { id: null, playing: false, ended: false, bpm: 0, bar: 0, beat: 0, step: 0, pattern: null, loops: 0 };
}

export type EngineOptions = {
  id: string;
  maxVoices?: number;
  onState?: (state: SoundState) => void;
};

export class SoundEngine {
  readonly id: string;
  maxVoices: number;
  private onState?: (s: SoundState) => void;
  private unsubscribeEngine: () => void;

  private ac: BaseAudioContext | null = null;
  private bus: Partial<Record<Bus, GainNode>> = {};
  private bank: ResolvedBank = { sfx: {}, songs: {} };
  private bankErrors: string[] = [];
  private controlErrors = new Set<string>();

  private control: Required<Pick<SoundControl, "fade" | "paused" | "muted">> & {
    music: string | null;
    volume: Record<Bus, number>;
  } = {
    music: null,
    fade: DEFAULT_FADE,
    paused: false,
    muted: false,
    volume: { master: 0.8, music: 0.7, sfx: 1, ui: 0.8 },
  };
  private counters = new Map<string, number>();
  private lastPlayed = new Map<string, number>();

  private current: Playing | null = null;
  private fading: Playing[] = [];
  private jingles: Playing[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private voices = 0;
  private unlocked = false;
  private destroyed = false;
  private publishQueued = false;
  private musicState: SoundState["music"] = idleMusic();
  private lastSfx: SoundState["lastSfx"] = null;
  private lastUi: SoundState["lastUi"] = null;
  private played: Record<string, number> = {};

  constructor(opts: EngineOptions) {
    this.id = opts.id;
    this.maxVoices = opts.maxVoices ?? 32;
    this.onState = opts.onState;
    // Contexte, déverrouillage, master et mise en veille : AudioEngine partagé.
    this.unsubscribeEngine = AudioEngine.get().onChange(() => this.syncEngine());
    this.syncEngine();
    this.publish();
  }

  get supported(): boolean {
    return AudioEngine.get().supported;
  }

  get context(): BaseAudioContext | null {
    return this.ac;
  }

  /* ---------------------------------------------------------------- */
  /* Banque                                                           */
  /* ---------------------------------------------------------------- */

  setBank(raw: unknown): void {
    const { bank, errors } = validateSoundBank(raw);
    this.bank = bank;
    this.bankErrors = errors;
    // Un morceau courant qui a changé redémarre avec sa nouvelle définition.
    if (this.current && this.bank.songs[this.current.id] !== this.current.player.song) {
      const id = this.current.id;
      this.stopMusic(0.05);
      this.startMusic(id);
    } else if (this.control.music && !this.current) {
      this.startMusic(this.control.music);
    }
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* Pilotage                                                         */
  /* ---------------------------------------------------------------- */

  applyControl(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const c = raw as SoundControl;
    this.controlErrors.clear();

    if (typeof c.fade === "number" && Number.isFinite(c.fade)) {
      this.control.fade = Math.min(10, Math.max(0, c.fade));
    }
    if (c.volume && typeof c.volume === "object") {
      for (const b of BUSES) {
        const v = Number(c.volume[b]);
        if (c.volume[b] !== undefined && Number.isFinite(v)) {
          this.control.volume[b] = Math.min(1, Math.max(0, v));
        }
      }
    }
    if (typeof c.muted === "boolean") this.control.muted = c.muted;
    this.applyVolumes();

    if (typeof c.paused === "boolean" && c.paused !== this.control.paused) {
      this.control.paused = c.paused;
      if (c.paused) this.pauseMusic();
      else this.resumeMusic();
    }

    if ("music" in c) {
      const next = c.music ? String(c.music) : null;
      if (next && !this.bank.songs[next]) this.controlErrors.add(`music : morceau inconnu "${next}"`);
      if (next !== this.control.music) {
        this.control.music = next;
        this.stopMusic(this.control.fade);
        if (next && this.bank.songs[next]) this.startMusic(next);
      }
    }

    if (c.play && typeof c.play === "object") {
      const seen = new Set<string>();
      for (const [name, trig] of Object.entries(c.play)) {
        seen.add(name);
        const n = typeof trig === "number" ? trig : Number((trig as { n?: unknown })?.n);
        if (!Number.isFinite(n)) {
          this.controlErrors.add(`play.${name} : compteur numérique attendu`);
          continue;
        }
        const prev = this.counters.get(name);
        this.counters.set(name, n);
        if (prev === undefined || n <= prev) continue;
        const opts: { pitch?: unknown; vol?: unknown } = typeof trig === "object" && trig ? trig : {};
        this.play(name, { pitch: Number(opts.pitch) || 0, vol: opts.vol === undefined ? 1 : Number(opts.vol) });
      }
      for (const name of [...this.counters.keys()]) if (!seen.has(name)) this.counters.delete(name);
    }
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* Bruitages                                                        */
  /* ---------------------------------------------------------------- */

  /** Joue un bruitage, un jingle (morceau joué une fois) ou un preset intégré. */
  play(name: string, opts: { pitch?: number; vol?: number } = {}): boolean {
    const sfx = this.bank.sfx[name] ?? (this.bank.songs[name] ? null : presetCache[name]);
    const song = sfx ? null : this.bank.songs[name];
    if (!sfx && !song) {
      this.controlErrors.add(`play : son inconnu "${name}"`);
      this.publish();
      return false;
    }
    if (!this.ac || !this.unlocked || this.control.muted) return false;
    const now = performance.now();
    if (sfx) {
      const last = this.lastPlayed.get(name) ?? -Infinity;
      if (now - last < sfx.cooldown) return false;
      if (this.voices >= this.maxVoices) return false;
      this.lastPlayed.set(name, now);
      playSynth(this.ac, this.bus[sfx.bus]!, sfx, {
        time: this.ac.currentTime + 0.005,
        pitch: opts.pitch ?? 0,
        gain: opts.vol ?? 1,
        onStarted: () => this.voices++,
        onEnded: () => this.voiceEnded(),
      });
    } else if (song) {
      this.jingles.push(this.makePlaying(name, { ...song, loop: false }, this.bus.sfx!, opts.vol ?? 1, opts.pitch ?? 0));
      this.ensureTimer();
    }
    const mark = { id: name, at: Math.round(now) };
    if (sfx?.bus === "ui") this.lastUi = mark;
    else this.lastSfx = mark;
    this.played[name] = (this.played[name] ?? 0) + 1;
    this.publish();
    return true;
  }

  private voiceEnded(): void {
    this.voices = Math.max(0, this.voices - 1);
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* Musique                                                          */
  /* ---------------------------------------------------------------- */

  private makePlaying(id: string, song: ResolvedSong, dest: AudioNode, vol = 1, pitch = 0, fadeIn = 0): Playing {
    const ac = this.ac!;
    const gain = ac.createGain();
    const target = song.vol * vol;
    gain.gain.setValueAtTime(fadeIn > 0 ? 0 : target, ac.currentTime);
    if (fadeIn > 0) gain.gain.linearRampToValueAtTime(target, ac.currentTime + fadeIn);
    gain.connect(dest);
    const isMusic = dest === this.bus.music;
    const playing: Playing = { id, gain, stopAt: null, player: null as unknown as SongPlayer };
    playing.player = new SongPlayer(song, {
      note: (ev, time, hold) => {
        const inst = song.instruments[ev.instrument];
        if (!inst || this.voices >= this.maxVoices * 2) return;
        const freqs = ev.midi ? ev.midi.map((m) => midiToFreq(m + pitch)) : [null];
        for (const freq of freqs) {
          playSynth(ac, gain, inst, {
            time,
            freq,
            hold: hold < 0 ? null : hold,
            gain: ev.accent ? 1.2 : 1,
            pitch: ev.midi ? 0 : pitch,
            onStarted: () => this.voices++,
            onEnded: () => this.voiceEnded(),
          });
        }
      },
      beat: isMusic ? (pos, time) => this.atAudioTime(time, () => this.onBeat(playing, pos)) : undefined,
      end: (time) => {
        playing.stopAt = time + 2;
        if (isMusic) this.atAudioTime(time, () => this.onMusicEnd(playing));
      },
    });
    playing.player.start(ac.currentTime + 0.06);
    return playing;
  }

  private startMusic(id: string): void {
    const song = this.bank.songs[id];
    if (!song) return;
    this.musicState = {
      id, playing: false, ended: false, bpm: song.bpm, bar: 0, beat: 0, step: 0, pattern: song.sequence[0], loops: 0,
    };
    if (!this.ac || !this.unlocked) {
      this.publish();
      return; // démarrera au déverrouillage
    }
    const hadPrevious = this.fading.length > 0;
    this.current = this.makePlaying(id, song, this.bus.music!, 1, 0, hadPrevious ? this.control.fade : 0.02);
    this.musicState.playing = !this.control.paused;
    if (this.control.paused) this.current.player.pause();
    this.ensureTimer();
    this.publish();
  }

  private stopMusic(fade: number): void {
    const cur = this.current;
    this.current = null;
    if (!cur) {
      if (!this.control.music) this.musicState = idleMusic();
      return;
    }
    const ac = this.ac!;
    const t = ac.currentTime;
    cur.gain.gain.cancelScheduledValues(t);
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
    cur.gain.gain.linearRampToValueAtTime(0, t + Math.max(fade, 0.02));
    cur.stopAt = t + Math.max(fade, 0.02);
    this.fading.push(cur);
    this.musicState = idleMusic();
  }

  private pauseMusic(): void {
    const ac = this.ac;
    if (this.bus.music && ac) {
      this.bus.music.gain.cancelScheduledValues(ac.currentTime);
      this.bus.music.gain.setTargetAtTime(0, ac.currentTime, 0.02);
    }
    this.current?.player.pause();
    this.musicState = { ...this.musicState, playing: false };
  }

  private resumeMusic(): void {
    const ac = this.ac;
    if (!ac || !this.current) {
      this.applyVolumes();
      return;
    }
    this.current.player.resume(ac.currentTime + 0.05);
    this.musicState = { ...this.musicState, playing: !this.current.player.ended };
    this.applyVolumes();
    this.ensureTimer();
  }

  private onBeat(p: Playing, pos: SongPosition): void {
    if (p !== this.current) return;
    this.musicState = {
      ...this.musicState,
      playing: true,
      bar: pos.bar,
      beat: pos.beat,
      step: pos.step,
      pattern: pos.pattern,
      loops: pos.loops,
    };
    this.publish();
  }

  private onMusicEnd(p: Playing): void {
    if (p !== this.current) return;
    this.musicState = { ...this.musicState, playing: false, ended: true };
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* Horloge                                                          */
  /* ---------------------------------------------------------------- */

  private ensureTimer(): void {
    if (this.timer || this.destroyed) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private tick(): void {
    const ac = this.ac;
    if (!ac) return;
    const horizon = ac.currentTime + LOOKAHEAD;
    const now = ac.currentTime;
    this.current?.player.schedule(horizon);
    const keep = (p: Playing) => {
      if (p.stopAt !== null && now >= p.stopAt) {
        p.player.pause();
        try {
          p.gain.disconnect();
        } catch {
          /* ok */
        }
        return false;
      }
      if (p.stopAt === null || now < p.stopAt) p.player.schedule(Math.min(horizon, p.stopAt ?? horizon));
      return true;
    };
    this.fading = this.fading.filter(keep);
    this.jingles = this.jingles.filter(keep);
    if (!this.current && !this.fading.length && !this.jingles.length && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private atAudioTime(time: number, fn: () => void): void {
    const ac = this.ac;
    const delay = ac ? Math.max(0, (time - ac.currentTime) * 1000) : 0;
    setTimeout(() => {
      if (!this.destroyed) fn();
    }, delay);
  }

  /* ---------------------------------------------------------------- */
  /* Contexte, déverrouillage, volumes                                */
  /* ---------------------------------------------------------------- */

  /** Déverrouille l'AudioEngine partagé. À appeler depuis un geste utilisateur. */
  unlock(): Promise<void> {
    return AudioEngine.get().unlock();
  }

  private syncEngine(): void {
    if (this.destroyed) return;
    const engine = AudioEngine.get();
    if (engine.context && engine.master && !this.ac) {
      this.ac = engine.context;
      this.buildGraph(engine.master);
    }
    if (engine.ready && this.ac && !this.unlocked) {
      this.unlocked = true;
      if (this.control.music && !this.current) this.startMusic(this.control.music);
      this.publish();
    }
  }

  private buildGraph(output: AudioNode): void {
    const ac = this.ac!;
    const master = ac.createGain();
    master.connect(output);
    this.bus.master = master;
    for (const b of ["music", "sfx", "ui"] as const) {
      const g = ac.createGain();
      g.connect(master);
      this.bus[b] = g;
    }
    this.applyVolumes(true);
  }

  private applyVolumes(immediate = false): void {
    const ac = this.ac;
    if (!ac) return;
    const v = this.control.volume;
    const target: Record<Bus, number> = {
      master: this.control.muted ? 0 : v.master,
      music: this.control.paused ? 0 : v.music,
      sfx: v.sfx,
      ui: v.ui,
    };
    for (const b of BUSES) {
      const g = this.bus[b]?.gain;
      if (!g) continue;
      if (immediate) g.setValueAtTime(target[b], ac.currentTime);
      else g.setTargetAtTime(target[b], ac.currentTime, 0.03);
    }
  }

  /* ---------------------------------------------------------------- */
  /* État                                                             */
  /* ---------------------------------------------------------------- */

  getState(): SoundState {
    const sounds = [...new Set([...Object.keys(this.bank.sfx), ...presetSfxNames()])];
    return {
      supported: this.supported,
      unlocked: this.unlocked,
      muted: this.control.muted,
      paused: this.control.paused,
      volume: { ...this.control.volume },
      music: { ...this.musicState },
      lastSfx: this.lastSfx,
      lastUi: this.lastUi,
      played: { ...this.played },
      voices: this.voices,
      sounds,
      songs: Object.keys(this.bank.songs),
      errors: [...this.bankErrors, ...this.controlErrors],
    };
  }

  private publish(): void {
    if (!this.onState || this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      if (!this.destroyed) this.onState?.(this.getState());
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeEngine();
    // Le contexte appartient à l'AudioEngine : on se débranche seulement.
    try {
      this.bus.master?.disconnect();
    } catch {
      /* déjà débranché */
    }
    this.ac = null;
  }
}

export const SFX_PRESET_NAMES = Object.keys(SFX_PRESETS);
