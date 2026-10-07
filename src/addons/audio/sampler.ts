import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine, AudioRoute, resolveAudioElement } from "../../shared/audio/engine";
import { isAudioSink, type SonicInstrument, type SonicNoteEvent } from "../../shared/audio/contracts";
import { toMidi } from "../../shared/audio/notes";
import { listenDp, plain } from "../../shared/audio/dp";
import { safeMediaUrl } from "../../shared/media/urls";

const tagName = "sonic-sampler";
const MAX_VOICES = 32;

export type SampleSpec = {
  url?: string;
  /** DataProvider contenant un SonicMediaRef ({ url } / { blob }) — ex. un enregistrement. */
  ref?: string;
  gain?: number;
  pan?: number;
  /** Transposition en demi-tons. */
  pitch?: number;
  /** Note de référence pour jouer le sample chromatiquement. */
  root?: string | number;
  start?: number;
  end?: number;
  loop?: boolean;
  reverse?: boolean;
  /** Respecte la durée de la note (sinon : joué en entier). */
  gate?: boolean;
};

export type SamplerState = {
  status: "idle" | "loading" | "ready" | "error" | "unsupported";
  loaded: number;
  total: number;
  samples: string[];
  /** Samples `ref` encore sans enregistrement. */
  empty: string[];
  voices: number;
  played: number;
  errors: string[];
};

/** `empty` : sample `ref` dont le DataProvider est encore vide (pad pas encore enregistré). */
type Loaded = { spec: SampleSpec; buffer: AudioBuffer | null; reversed: AudioBuffer | null; error: string | null; empty: boolean };
type Voice = { sample: string; src: AudioBufferSourceNode; gain: GainNode; end: number };

/* ------------------------------------------------------------------ */
/* Chargement partagé (cache par URL, décodage hors contexte)          */
/* ------------------------------------------------------------------ */

const decodeCache = new Map<string, Promise<AudioBuffer>>();
let decoder: BaseAudioContext | null = null;

function decodingContext(): BaseAudioContext | null {
  const ctx = AudioEngine.get().context;
  if (ctx) return ctx;
  if (decoder) return decoder;
  const Offline = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  decoder = Offline ? new Offline(1, 1, 44100) : null;
  return decoder;
}

/** URL autorisée : https, blob:, data:audio/…, ou relative (même origine). */
export function safeSampleUrl(url: string): boolean {
  return safeMediaUrl(url, "audio");
}

export function loadSample(url: string): Promise<AudioBuffer> {
  let p = decodeCache.get(url);
  if (!p) {
    p = (async () => {
      const ctx = decodingContext();
      if (!ctx) throw new Error("WebAudio indisponible");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      return await ctx.decodeAudioData(data);
    })();
    decodeCache.set(url, p);
    p.catch(() => decodeCache.delete(url));
  }
  return p;
}

function reverseBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
  }
  return out;
}

/**
 * Sampler : joue des samples (URL, ou SonicMediaRef lu dans un DataProvider)
 * par nom (`{ sample: "kick" }`) ou chromatiquement (`{ note: "C4" }`).
 */
@customElement(tagName)
export class SonicSampler extends LitElement implements SonicInstrument {
  static styles = css`
    :host {
      display: none;
    }
  `;

  /** { nom: "url" | { url | ref, gain, pan, pitch, root, start, end, loop, reverse, gate } }. */
  @property({ type: Object })
  samples: Record<string, string | SampleSpec> | null = null;

  /** DataProvider : samples supplémentaires (même format), fusionnés. */
  @property({ type: String, attribute: "samples-provider" })
  samplesProvider = "";

  /** Groupes d'étouffement : [["hat","openhat"]] — jouer l'un coupe les autres. */
  @property({ type: Array })
  choke: string[][] | null = null;

  /** Notes → samples ({"36":"kick","C2":"kick"}). */
  @property({ type: Object, attribute: "notes-map" })
  notesMap: Record<string, string> | null = null;

  /** Sample joué chromatiquement pour les événements `note` (défaut : le premier qui a `root`). */
  @property({ type: String })
  chromatic = "";

  @property({ type: Number })
  gain = 0.8;

  @property({ type: String })
  output = "master";

  @property({ type: String })
  events = "";

  @property({ type: String })
  trigger = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private loaded = new Map<string, Loaded>();
  private provided: Record<string, string | SampleSpec> = {};
  private voices: Voice[] = [];
  private outGain: GainNode | null = null;
  private route: AudioRoute | null = null;
  private played = 0;
  private errors: string[] = [];
  private seen: string[] = [];
  private unsubs: (() => void)[] = [];
  private refUnsubs: (() => void)[] = [];
  private providerUnsub: (() => void) | null = null;
  private unsubscribeEngine: (() => void) | null = null;
  private lastEventsJson = "";
  private latestEvents: SonicNoteEvent[] = [];
  private lastTrigger: string | undefined;
  private loadToken = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeEngine = AudioEngine.get().onChange(() => this.ensureOutput());
  }

  disconnectedCallback(): void {
    this.unsubscribeEngine?.();
    for (const u of [...this.unsubs, ...this.refUnsubs]) u();
    this.providerUnsub?.();
    this.providerUnsub = null;
    this.unsubs = [];
    this.refUnsubs = [];
    this.allNotesOff();
    try {
      this.outGain?.disconnect();
    } catch {
      /* ok */
    }
    this.outGain = null;
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("samples")) this.reload();
    if (changed.has("samplesProvider")) {
      this.providerUnsub?.();
      this.providerUnsub = this.samplesProvider
        ? listenDp(this.samplesProvider, (v) => {
            this.provided = v && typeof v === "object" ? (v as Record<string, string | SampleSpec>) : {};
            this.reload();
          })
        : null;
    }
    if (changed.has("gain") && this.outGain) this.outGain.gain.value = Math.max(0, this.gain);
    if (changed.has("output")) this.reconnect();
    if (changed.has("events") || changed.has("trigger")) this.listenEvents();
    this.ensureOutput();
  }

  /* ---------------------------------------------------------------- */
  /* Samples                                                           */
  /* ---------------------------------------------------------------- */

  private specs(): Record<string, SampleSpec> {
    const merged = { ...(plain<Record<string, string | SampleSpec>>(this.samples) ?? {}), ...this.provided };
    const out: Record<string, SampleSpec> = {};
    for (const [name, v] of Object.entries(merged)) out[name] = typeof v === "string" ? { url: v } : { ...(v ?? {}) };
    return out;
  }

  private reload(): void {
    const token = ++this.loadToken;
    for (const u of this.refUnsubs) u();
    this.refUnsubs = [];
    this.errors = [];
    const next = new Map<string, Loaded>();
    for (const [name, spec] of Object.entries(this.specs())) {
      const entry: Loaded = { spec, buffer: null, reversed: null, error: null, empty: !!spec.ref };
      next.set(name, entry);
      const load = (url: string) => {
        entry.empty = false;
        if (!safeSampleUrl(url)) {
          entry.error = `${name} : URL refusée (https, blob:, data:audio ou relative)`;
          this.publish();
          return;
        }
        entry.error = null;
        loadSample(url)
          .then((buf) => {
            if (token !== this.loadToken) return;
            entry.buffer = buf;
            entry.reversed = null;
            this.publish();
          })
          .catch((e: unknown) => {
            if (token !== this.loadToken) return;
            entry.error = `${name} : chargement impossible (${e instanceof Error ? e.message : String(e)})`;
            this.publish();
          });
      };
      if (spec.ref) {
        this.refUnsubs.push(
          listenDp(spec.ref, (v) => {
            const ref = v as { url?: unknown } | null;
            if (ref && typeof ref.url === "string") load(ref.url);
          }),
        );
      } else if (spec.url) load(spec.url);
      else entry.error = `${name} : url ou ref requis`;
    }
    this.loaded = next;
    this.publish();
  }

  /* ---------------------------------------------------------------- */
  /* Sortie                                                            */
  /* ---------------------------------------------------------------- */

  private ensureOutput(): void {
    const engine = AudioEngine.get();
    if (this.outGain || !engine.context || !engine.master) return;
    this.outGain = engine.context.createGain();
    this.outGain.gain.value = Math.max(0, this.gain);
    this.reconnect();
    this.publish();
  }

  private reconnect(): void {
    const engine = AudioEngine.get();
    if (!this.outGain || !engine.master) return;
    this.route ??= new AudioRoute(this.outGain);
    const out = (this.output || "master").trim();
    if (out === "none") this.route.to(null);
    else if (out === "master") this.route.to(engine.master);
    else {
      const el = resolveAudioElement(this, out);
      const input = isAudioSink(el) ? el.getAudioInput() : null;
      this.route.to(input ?? engine.master);
    }
  }

  getAudioOutput(): AudioNode | null {
    return this.outGain;
  }

  /* ---------------------------------------------------------------- */
  /* SonicInstrument                                                   */
  /* ---------------------------------------------------------------- */

  schedule(events: SonicNoteEvent[]): void {
    const ac = AudioEngine.get().context;
    if (!ac || !this.outGain || !Array.isArray(events)) return;
    const now = ac.currentTime;
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.id !== undefined) {
        const id = String(ev.id);
        if (this.seen.includes(id)) continue;
        this.seen.push(id);
        if (this.seen.length > 512) this.seen.shift();
      }
      const when = typeof ev.when === "number" && Number.isFinite(ev.when) ? ev.when : now + 0.005;
      if (when < now - 0.05) continue;
      const t = Math.max(when, now);
      if (ev.type === "noteOff") {
        const name = this.resolveName(ev);
        for (const v of this.voices) if (v.sample === name) this.fade(v, t, 0.02);
        continue;
      }
      if (ev.type === "param") continue;
      const name = this.resolveName(ev);
      if (!name) {
        this.error(`aucun sample pour ${ev.sample !== undefined ? `"${ev.sample}"` : `la note ${String(ev.note)}`}`);
        continue;
      }
      this.play(name, ev, t, ac);
    }
  }

  private resolveName(ev: SonicNoteEvent): string | null {
    if (ev.sample !== undefined) return this.loaded.has(String(ev.sample)) ? String(ev.sample) : null;
    if (ev.note === undefined) return this.loaded.keys().next().value ?? null;
    const midi = toMidi(ev.note);
    if (this.notesMap) {
      for (const [k, name] of Object.entries(this.notesMap)) if (toMidi(k) === midi && this.loaded.has(name)) return name;
    }
    if (this.chromatic && this.loaded.has(this.chromatic)) return this.chromatic;
    for (const [name, l] of this.loaded) if (l.spec.root !== undefined) return name;
    return null;
  }

  private play(name: string, ev: SonicNoteEvent, t: number, ac: BaseAudioContext): void {
    const entry = this.loaded.get(name)!;
    if (!entry.buffer) return; // pas encore chargé
    const spec = entry.spec;
    if (spec.reverse && !entry.reversed) entry.reversed = reverseBuffer(ac, entry.buffer);
    const buffer = spec.reverse ? entry.reversed! : entry.buffer;

    // Étouffement
    for (const group of this.choke ?? []) {
      if (!group.includes(name)) continue;
      for (const v of this.voices) if (v.sample !== name && group.includes(v.sample)) this.fade(v, t, 0.008);
    }
    if (this.voices.length >= MAX_VOICES) this.fade(this.voices[0], t, 0.005);

    const src = ac.createBufferSource();
    src.buffer = buffer;
    let semis = Number(spec.pitch) || 0;
    const root = spec.root !== undefined ? toMidi(spec.root) : null;
    if (ev.sample === undefined && ev.note !== undefined && root !== null) {
      const midi = toMidi(ev.note);
      if (midi !== null) semis += midi - root;
    }
    src.playbackRate.value = Math.pow(2, semis / 12);
    const g = ac.createGain();
    const vel = typeof ev.vel === "number" ? Math.min(1, Math.max(0, ev.vel)) : 0.8;
    const level = (spec.gain ?? 1) * (0.25 + 0.75 * vel);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.002);
    let tail: AudioNode = g;
    src.connect(g);
    if (spec.pan && typeof (ac as AudioContext).createStereoPanner === "function") {
      const p = ac.createStereoPanner();
      p.pan.value = Math.min(1, Math.max(-1, spec.pan));
      g.connect(p);
      tail = p;
    }
    tail.connect(this.outGain!);

    const dur = buffer.duration;
    const start = Math.min(dur, Math.max(0, Number(spec.start) || 0));
    const end = spec.end !== undefined ? Math.min(dur, Math.max(start, Number(spec.end))) : dur;
    const rate = src.playbackRate.value;
    let stopAt: number;
    if (spec.loop) {
      src.loop = true;
      src.loopStart = start;
      src.loopEnd = end;
      src.start(t, start);
      stopAt = t + (typeof ev.durS === "number" && ev.durS > 0 ? ev.durS : (end - start) / rate);
    } else {
      src.start(t, start, end - start);
      stopAt = t + (end - start) / rate;
      if (spec.gate && typeof ev.durS === "number" && ev.durS > 0) stopAt = Math.min(stopAt, t + ev.durS);
    }
    const voice: Voice = { sample: name, src, gain: g, end: stopAt };
    this.voices.push(voice);
    g.gain.setValueAtTime(level, Math.max(t + 0.002, stopAt - 0.01));
    g.gain.linearRampToValueAtTime(0, stopAt);
    src.stop(stopAt + 0.01);
    src.onended = () => {
      try {
        tail.disconnect();
        g.disconnect();
      } catch {
        /* ok */
      }
      this.voices = this.voices.filter((v) => v !== voice);
      this.publish();
    };
    this.played++;
    this.publish();
  }

  private fade(v: Voice, t: number, s: number): void {
    if (v.end <= t) return;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + s);
    v.end = t + s;
    try {
      v.src.stop(t + s + 0.005);
    } catch {
      /* déjà arrêtée */
    }
  }

  allNotesOff(): void {
    const ac = AudioEngine.get().context;
    if (!ac) return;
    for (const v of this.voices) this.fade(v, ac.currentTime, 0.01);
  }

  /* ---------------------------------------------------------------- */
  /* Événements par DataProvider (même logique que sonic-patch)        */
  /* ---------------------------------------------------------------- */

  private listenEvents(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.lastEventsJson = "";
    this.lastTrigger = undefined;
    if (this.events) {
      this.unsubs.push(
        listenDp(this.events, (v) => {
          const list = Array.isArray(v) ? (v as SonicNoteEvent[]) : [];
          this.latestEvents = list;
          if (this.trigger) return;
          const json = JSON.stringify(list);
          if (json === this.lastEventsJson) return;
          this.lastEventsJson = json;
          this.schedule(list);
        }),
      );
    }
    if (this.trigger) {
      this.unsubs.push(
        listenDp(this.trigger, (v) => {
          if (v === null || v === undefined || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length)) return;
          const key = JSON.stringify(v);
          if (this.lastTrigger === undefined) {
            this.lastTrigger = key;
            return;
          }
          if (key === this.lastTrigger) return;
          this.lastTrigger = key;
          this.schedule(this.latestEvents);
        }),
      );
    }
  }

  /* ---------------------------------------------------------------- */

  private error(msg: string): void {
    if (this.errors.includes(msg)) return;
    this.errors.push(msg);
    console.warn(`[sonic-sampler${this.id ? "#" + this.id : ""}] ${msg}`);
    this.publish();
  }

  getState(): SamplerState {
    const entries = [...this.loaded.values()];
    const loaded = entries.filter((e) => e.buffer).length;
    const loadErrors = entries.map((e) => e.error).filter((e): e is string => !!e);
    const supported = AudioEngine.get().supported;
    const pending = entries.filter((e) => !e.buffer && !e.error && !e.empty).length;
    return {
      status: !supported
        ? "unsupported"
        : loadErrors.length && loaded === 0 && !pending
          ? "error"
          : pending
            ? "loading"
            : this.outGain
              ? "ready"
              : "idle",
      loaded,
      total: entries.length,
      samples: [...this.loaded.keys()],
      empty: [...this.loaded].filter(([, e]) => e.empty).map(([n]) => n),
      voices: this.voices.length,
      played: this.played,
      errors: [...loadErrors, ...this.errors],
    };
  }

  private publishQueued = false;
  private publish(): void {
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out || this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      set(out, this.getState());
    });
  }

  render() {
    return html``;
  }
}

export default SonicSampler;
