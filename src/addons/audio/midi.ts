import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { AudioEngine, resolveAudioElement } from "../../shared/audio/engine";
import { isInstrument, type SonicInstrument, type SonicNoteEvent } from "../../shared/audio/contracts";
import { listenDp, plain } from "../../shared/audio/dp";
import { toMidi } from "../../shared/audio/notes";
import { onFirstGesture, type CaptureStatus } from "../../shared/media/capture";
import { bool, CounterTrigger, num } from "../../shared/media/control";
import { ClockFollower, encode, matchPorts, NoteTracker, noteName, parseMidi, type ClockState, type MidiMessage } from "./midi/core";

const tagName = "sonic-midi";

type PortInfo = { id: string; name: string; manufacturer: string; state: string };
type HeldInfo = { note: number; name: string; ch: number; vel: number; bend: number; pressure: number; timbre: number };
type LastInfo = { kind: string; ch?: number; note?: number; name?: string; vel?: number; cc?: number; value?: number; program?: number };

export type MidiState = {
  status: CaptureStatus;
  error: string | null;
  active: boolean;
  inputs: PortInfo[];
  outputs: PortInfo[];
  /** Noms des ports écoutés / utilisés en sortie. */
  input: string[];
  output: string[];
  /** Notes tenues, avec leurs expressions (bend en demi-tons, pression et timbre 0..1). */
  held: HeldInfo[];
  /** Dernier message reçu (hors horloge). */
  last: LastInfo | null;
  /** Compteurs (utilisables comme `trigger`) : notes reçues, messages envoyés. */
  notes: number;
  sent: number;
  /** Dernière valeur 0..1 de chaque contrôleur reçu, par numéro. */
  cc: Record<string, number>;
  /** Dernier pitch bend (-1..1) et dernière pression de canal (0..1). */
  bend: number;
  pressure: number;
  program: number | null;
  /** Horloge entrante : { running, bpm, ticks, beat }. */
  clock: ClockState;
};

export type MidiClockEvent = { type: "start" | "continue" | "stop" | "beat"; perf: number; ticks: number; bpm: number };

type Transport = { playing: boolean; bpm: number; t0: number };
type TransportSource = Element & { getTransport(): Transport | null };
type StoreLike = { dispatchAction(action: { type: string; payload?: unknown }): void };

type WebMidiInput = { id: string; name?: string | null; manufacturer?: string | null; state?: string; onmidimessage: ((e: { data: Uint8Array; timeStamp: number }) => void) | null };
type WebMidiOutput = { id: string; name?: string | null; manufacturer?: string | null; state?: string; send(data: number[], timestamp?: number): void };
type WebMidiAccess = {
  inputs: { values(): IterableIterator<WebMidiInput> };
  outputs: { values(): IterableIterator<WebMidiOutput> };
  onstatechange: (() => void) | null;
};

const CLOCK_TICK_MS = 20;
const CLOCK_HORIZON_S = 0.12;

/**
 * Web MIDI : claviers, contrôleurs, MPE (LinnStrument, Seaboard…) en entrée,
 * notes / CC / horloge vers des appareils en sortie.
 *
 * Entrée : `target="#synth"` joue les notes sur des instruments (avec expressions par note),
 * `store="id"` reçoit `{ type: "midi", payload }`, l'état `<id>State` décrit tout.
 * Sortie : c'est aussi un instrument (`sonic-sequencer pattern='{"midi": …}'`, `events`),
 * `cc-out` (DP de valeurs 0..1), `clock-out="#seq"` (horloge 24 ppq calée sur le séquenceur).
 * L'accès MIDI n'est demandé que sur geste (`sonic-media-start for="midi"`, `autostart`,
 * `active`, DP `control`). Jamais de SysEx.
 */
@customElement(tagName)
export class SonicMidi extends LitElement implements SonicInstrument {
  static styles = css`
    :host {
      display: none;
    }
  `;

  @property({ type: Boolean })
  active = false;

  @property({ type: Boolean })
  autostart = false;

  /** Ports d'entrée : `all` (défaut), `none`, `first`, ou morceau de nom (« linnstrument »). */
  @property({ type: String })
  input = "all";

  /** Port de sortie : vide = aucun, `first`, `all`, ou morceau de nom (« digitone »). */
  @property({ type: String })
  output = "";

  /** Canal écouté : `all` (défaut) ou 1..16. */
  @property({ type: String })
  channel = "all";

  /** Canal de sortie par défaut (1..16) ; un événement peut porter `ch`. */
  @property({ type: Number, attribute: "out-channel" })
  outChannel = 1;

  /** MPE en entrée : un canal par note (zone basse, canal maître 1, ou `mpe-master="16"`). */
  @property({ type: Boolean })
  mpe = false;

  @property({ type: Number, attribute: "mpe-master" })
  mpeMaster = 1;

  /** Amplitude du pitch bend en demi-tons (défaut : 48 en MPE, 2 sinon). */
  @property({ type: Number, attribute: "bend-range" })
  bendRange = 0;

  @property({ type: Number })
  transpose = 0;

  /** Instruments qui jouent les notes reçues : `#synth #drums`. */
  @property({ type: String })
  target = "";

  /** Store qui reçoit chaque message : `{ type: action-type, payload }`. */
  @property({ type: String })
  store = "";

  @property({ type: String, attribute: "action-type" })
  actionType = "midi";

  /** Sortie : DP d'événements + DP déclencheur (comme sonic-patch). */
  @property({ type: String })
  events = "";

  @property({ type: String })
  trigger = "";

  /** Sortie : DP `{ "74": 0.5, "1": 0 }` → contrôleurs envoyés à chaque changement. */
  @property({ type: String, attribute: "cc-out" })
  ccOut = "";

  /** Sortie : horloge MIDI calée sur un `sonic-sequencer` (`#seq`) : start / stop / 24 ticks par noire. */
  @property({ type: String, attribute: "clock-out" })
  clockOut = "";

  /** Décalage des messages envoyés (ms) : compenser la latence d'un appareil. */
  @property({ type: Number, attribute: "offset-ms" })
  offsetMs = 0;

  @property({ type: Object, attribute: "notes-map" })
  notesMap: Record<string, string | number> | null = null;

  @property({ type: Number, attribute: "dur-s" })
  durS = 0.25;

  /** Publications par seconde pour les valeurs continues (CC, expressions). */
  @property({ type: Number })
  rate = 30;

  /** DP de pilotage : `{ active, input, output, channel, outChannel, program, panic: compteur }`. */
  @property({ type: String })
  control = "";

  @property({ type: String, attribute: "out-data-provider" })
  outDataProvider = "";

  private access: WebMidiAccess | null = null;
  private ins: WebMidiInput[] = [];
  private outs: WebMidiOutput[] = [];
  private requesting = false;
  private token = 0;
  private wantActive = false;
  private overrides: { input?: string; output?: string; channel?: string; outChannel?: number } = {};
  private tracker = new NoteTracker({ mpe: false, bendRange: 2, masterBendRange: 2, masterCh: 1 });
  private clockIn = new ClockFollower();
  private clockListeners = new Set<(e: MidiClockEvent) => void>();
  private state: MidiState = {
    status: "idle", error: null, active: false, inputs: [], outputs: [], input: [], output: [], held: [], last: null,
    notes: 0, sent: 0, cc: {}, bend: 0, pressure: 0, program: null, clock: { running: false, bpm: 0, ticks: 0, beat: 0 },
  };
  private unsubs: (() => void)[] = [];
  private outUnsubs: (() => void)[] = [];
  private cancelGesture: (() => void) | null = null;
  private panic = new CounterTrigger();
  private lastProgram: number | undefined;
  private lastCc: Record<string, number> = {};
  private latestEvents: SonicNoteEvent[] = [];
  private lastEventsJson = "";
  private lastTrigger: string | undefined;
  private seen: string[] = [];
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private clockSent: { playing: boolean; tick: number; t0: number } = { playing: false, tick: -1, t0: 0 };
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.idleTimer = setInterval(() => {
      if (this.clockIn.idle(performance.now())) this.publish();
    }, 500);
    this.publish();
  }

  disconnectedCallback(): void {
    this.cancelGesture?.();
    this.cancelGesture = null;
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const u of [...this.unsubs, ...this.outUnsubs]) u();
    this.unsubs = [];
    this.outUnsubs = [];
    this.close("idle");
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("mpe") || changed.has("bendRange") || changed.has("mpeMaster")) {
      this.tracker.opts = {
        mpe: this.mpe,
        bendRange: this.bendRange > 0 ? this.bendRange : this.mpe ? 48 : 2,
        masterBendRange: 2,
        masterCh: this.mpeMaster === 16 ? 16 : 1,
      };
    }
    if (changed.has("active")) this.setActive(this.active);
    if (changed.has("autostart")) {
      this.cancelGesture?.();
      this.cancelGesture = this.autostart ? onFirstGesture(() => this.start()) : null;
    }
    if (changed.has("input") || changed.has("output")) this.bindPorts();
    if (changed.has("control")) this.listenControl();
    if (changed.has("events") || changed.has("trigger") || changed.has("ccOut")) this.listenOut();
    if (changed.has("clockOut")) this.setupClockOut();
  }

  /* ---------------------------------------------------------------- */
  /* API                                                               */
  /* ---------------------------------------------------------------- */

  start(): void {
    this.setActive(true);
  }

  stop(): void {
    this.setActive(false);
  }

  getState(): MidiState {
    return JSON.parse(JSON.stringify(this.state)) as MidiState;
  }

  /** Horloge entrante (sonic-sequencer sync="#midi"). */
  onClock(cb: (e: MidiClockEvent) => void): () => void {
    this.clockListeners.add(cb);
    return () => this.clockListeners.delete(cb);
  }

  /** Envoie un message brut (statut + données) aux ports de sortie. */
  send(data: number[], perf?: number): boolean {
    if (!this.outs.length) return false;
    const at = perf !== undefined ? perf + this.offsetMs : undefined;
    for (const o of this.outs) {
      try {
        if (at !== undefined && at > performance.now()) o.send(data, at);
        else o.send(data);
      } catch {
        /* port fermé entre-temps */
      }
    }
    this.state.sent++;
    this.publishSoon();
    return true;
  }

  /* SonicInstrument : notes vers les appareils. */
  schedule(events: SonicNoteEvent[]): void {
    if (!Array.isArray(events) || !this.outs.length) return;
    const engine = AudioEngine.get();
    const ac = engine.context;
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.id !== undefined) {
        const id = String(ev.id);
        if (this.seen.includes(id)) continue;
        this.seen.push(id);
        if (this.seen.length > 512) this.seen.shift();
      }
      const perfOf = (t: number | undefined) =>
        typeof t === "number" && Number.isFinite(t) && ac ? (engine.perfAtCtxTime(t) ?? undefined) : undefined;
      const at = perfOf(ev.when);
      if (at !== undefined && at < performance.now() - 50) continue;
      const ch = num(ev.ch, 1, 16) ?? this.outChannelValue();
      const type = ev.type ?? "note";
      if (type === "cc") {
        const cc = num(ev.cc, 0, 127);
        const v = num(ev.value, 0, 1);
        if (cc !== undefined && v !== undefined) this.send(encode.cc(ch, cc, v), at);
        continue;
      }
      if (type === "param") continue;
      const midi = this.noteOf(ev);
      if (type === "expr") {
        if (typeof ev.bend === "number") this.send(encode.bend(ch, ev.bend / (this.bendRange > 0 ? this.bendRange : 2)), at);
        if (typeof ev.pressure === "number") this.send(encode.pressure(ch, ev.pressure), at);
        if (typeof ev.timbre === "number") this.send(encode.cc(ch, 74, ev.timbre), at);
        continue;
      }
      if (midi === null) continue;
      if (type === "noteOff") {
        this.send(encode.noteOff(ch, midi), at);
        continue;
      }
      const vel = typeof ev.vel === "number" ? ev.vel : 0.8;
      this.send(encode.noteOn(ch, midi, vel), at);
      if (type === "note") {
        const dur = typeof ev.durS === "number" && ev.durS > 0 ? ev.durS : this.durS;
        const end = typeof ev.when === "number" && ac ? perfOf(ev.when + dur) : performance.now() + dur * 1000;
        this.send(encode.noteOff(ch, midi), end ?? performance.now() + dur * 1000);
      }
    }
  }

  allNotesOff(): void {
    for (let ch = 1; ch <= 16; ch++) this.send(encode.allNotesOff(ch));
  }

  /* ---------------------------------------------------------------- */
  /* Accès                                                             */
  /* ---------------------------------------------------------------- */

  private setActive(on: boolean): void {
    this.wantActive = on;
    if (on && !this.access && !this.requesting) void this.open();
    if (!on && (this.access || this.requesting)) this.close("idle");
  }

  private async open(): Promise<void> {
    const nav = navigator as unknown as { requestMIDIAccess?: (o: { sysex: boolean }) => Promise<WebMidiAccess> };
    if (typeof nav.requestMIDIAccess !== "function") {
      this.patch({ status: "unsupported", error: "MIDI non disponible dans ce navigateur (Chrome, Edge, Firefox)" });
      return;
    }
    const token = ++this.token;
    this.requesting = true;
    this.patch({ status: "requesting", error: null });
    try {
      const access = await nav.requestMIDIAccess({ sysex: false });
      if (token !== this.token || !this.wantActive) return;
      this.access = access;
      access.onstatechange = () => this.bindPorts();
      this.bindPorts();
      this.patch({ status: "ready", active: true, error: null });
    } catch (e) {
      if (token !== this.token) return;
      const name = (e as { name?: string })?.name;
      const denied = name === "NotAllowedError" || name === "SecurityError";
      this.patch({ status: denied ? "denied" : "error", active: false, error: denied ? "accès MIDI refusé" : `MIDI indisponible (${String((e as Error)?.message ?? e)})` });
    } finally {
      if (token === this.token) this.requesting = false;
    }
  }

  private close(status: CaptureStatus, error: string | null = null): void {
    this.token++;
    this.requesting = false;
    for (const i of this.ins) i.onmidimessage = null;
    if (this.access) this.access.onstatechange = null;
    if (this.outs.length) this.allNotesOff();
    this.access = null;
    this.ins = [];
    this.outs = [];
    this.releaseHeld();
    this.patch({ status, error, active: false, inputs: [], outputs: [], input: [], output: [] });
  }

  private bindPorts(): void {
    if (!this.access) return;
    for (const i of this.ins) i.onmidimessage = null;
    const allIn = [...this.access.inputs.values()].filter((p) => p.state !== "disconnected");
    const allOut = [...this.access.outputs.values()].filter((p) => p.state !== "disconnected");
    this.ins = matchPorts(allIn, this.overrides.input ?? this.input);
    this.outs = matchPorts(allOut, (this.overrides.output ?? this.output) || "none");
    for (const i of this.ins) i.onmidimessage = (e) => this.onMessage(e.data, e.timeStamp);
    const info = (p: WebMidiInput | WebMidiOutput): PortInfo => ({ id: p.id, name: p.name ?? "", manufacturer: p.manufacturer ?? "", state: p.state ?? "" });
    this.patch({
      inputs: allIn.map(info),
      outputs: allOut.map(info),
      input: this.ins.map((p) => p.name ?? p.id),
      output: this.outs.map((p) => p.name ?? p.id),
    });
  }

  /* ---------------------------------------------------------------- */
  /* Entrée                                                            */
  /* ---------------------------------------------------------------- */

  private channelAccepted(ch: number): boolean {
    const want = String(this.overrides.channel ?? this.channel ?? "all").trim();
    if (!want || want === "all") return true;
    return want.split(/[\s,]+/).map(Number).includes(ch);
  }

  /** Point d'entrée des messages (public pour les tests et les ponts). */
  onMessage(data: ArrayLike<number>, perf = performance.now()): void {
    const m = parseMidi(data);
    if (!m) return;
    if (m.kind === "clock" || m.kind === "start" || m.kind === "continue" || m.kind === "stop" || m.kind === "spp") {
      this.onClockMessage(m, perf);
      return;
    }
    // en MPE, toute la zone est écoutée (un canal par note) ; sinon filtre `channel`
    if (!this.mpe && !this.channelAccepted(m.ch)) return;
    const tr = Math.round(this.transpose) || 0;
    switch (m.kind) {
      case "noteOn": {
        const h = this.tracker.noteOn(m.ch, m.note, m.vel);
        const note = clampNote(m.note + tr);
        this.toTargets([{ type: "noteOn", note, vel: m.vel, ch: m.ch, bend: h.bend, pressure: h.pressure, timbre: h.timbre }]);
        this.state.notes++;
        this.setLast({ kind: "noteOn", ch: m.ch, note, name: noteName(note), vel: round(m.vel) });
        this.publish();
        return;
      }
      case "noteOff": {
        this.tracker.noteOff(m.ch, m.note);
        const note = clampNote(m.note + tr);
        this.toTargets([{ type: "noteOff", note, ch: m.ch }]);
        this.setLast({ kind: "noteOff", ch: m.ch, note, name: noteName(note) });
        this.publish();
        return;
      }
      case "cc": {
        if (m.cc === 123 || m.cc === 120) {
          const gone = this.tracker.clear(m.ch);
          this.toTargets(gone.map((h) => ({ type: "noteOff" as const, note: clampNote(h.note + tr), ch: h.ch })));
        }
        if (!this.mpe || m.cc !== 74) this.state.cc[String(m.cc)] = round(m.value);
        this.expression(m, tr);
        this.setLast({ kind: "cc", ch: m.ch, cc: m.cc, value: round(m.value) });
        this.publishSoon();
        return;
      }
      case "bend":
        this.state.bend = round(m.value);
        this.expression(m, tr);
        this.publishSoon();
        return;
      case "pressure":
        this.state.pressure = round(m.value);
        this.expression(m, tr);
        this.publishSoon();
        return;
      case "polyPressure":
        this.expression(m, tr);
        this.publishSoon();
        return;
      case "program":
        this.state.program = m.program;
        this.setLast({ kind: "program", ch: m.ch, program: m.program });
        this.publish();
        return;
    }
  }

  private expression(m: MidiMessage, tr: number): void {
    const changes = this.tracker.expression(m);
    if (!changes.length) return;
    this.toTargets(changes.map((c) => ({ type: "expr" as const, note: clampNote(c.note + tr), ch: c.ch, bend: c.bend, pressure: c.pressure, timbre: c.timbre })));
  }

  private setLast(last: LastInfo): void {
    this.state.last = last;
    if (this.store) {
      const store = resolveAudioElement(this, `#${this.store.replace(/^#/, "")}`) as (Element & StoreLike) | null;
      if (store && typeof store.dispatchAction === "function") store.dispatchAction({ type: this.actionType || "midi", payload: { ...last } });
    }
  }

  private toTargets(events: SonicNoteEvent[]): void {
    if (!events.length || !this.target) return;
    for (const ref of this.target.split(/\s+/).filter(Boolean)) {
      const el = resolveAudioElement(this, ref.startsWith("#") ? ref : `#${ref}`);
      if (el && el !== (this as unknown as Element) && isInstrument(el)) el.schedule(events.map((e) => ({ ...e })));
    }
  }

  private releaseHeld(): void {
    const gone = this.tracker.clear();
    const tr = Math.round(this.transpose) || 0;
    this.toTargets(gone.map((h) => ({ type: "noteOff" as const, note: clampNote(h.note + tr), ch: h.ch })));
  }

  private onClockMessage(m: MidiMessage, perf: number): void {
    const ev = this.clockIn.feed(m, perf);
    const prevBeat = this.state.clock.beat;
    this.state.clock = this.clockIn.getState();
    if (ev) {
      const e: MidiClockEvent = { type: ev, perf, ticks: this.clockIn.ticks, bpm: this.clockIn.bpm };
      for (const cb of this.clockListeners) cb(e);
      if (ev !== "beat") this.setLast({ kind: ev });
      if (this.store && ev === "beat") {
        const store = resolveAudioElement(this, `#${this.store.replace(/^#/, "")}`) as (Element & StoreLike) | null;
        store?.dispatchAction?.({ type: this.actionType || "midi", payload: { kind: "beat", beat: this.state.clock.beat, bpm: this.clockIn.bpm } });
      }
    }
    if (ev || this.state.clock.beat !== prevBeat) this.publishSoon();
  }

  /* ---------------------------------------------------------------- */
  /* Pilotage                                                          */
  /* ---------------------------------------------------------------- */

  private listenControl(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.panic.reset();
    if (!this.control) return;
    this.unsubs.push(
      listenDp(this.control, (v) => {
        if (!v || typeof v !== "object") return;
        const c = v as Record<string, unknown>;
        let rebind = false;
        for (const k of ["input", "output", "channel"] as const) {
          if (typeof c[k] === "string" || typeof c[k] === "number") {
            const val = String(c[k]);
            if (this.overrides[k] !== val) {
              this.overrides[k] = val;
              rebind = true;
            }
          }
        }
        const oc = num(c.outChannel, 1, 16);
        if (oc !== undefined) this.overrides.outChannel = Math.round(oc);
        if (rebind) this.bindPorts();
        const a = bool(c.active);
        if (a !== undefined) this.setActive(a);
        if (this.panic.feed(c.panic)) {
          this.allNotesOff();
          this.releaseHeld();
        }
        const prog = num(c.program, 0, 127);
        if (prog !== undefined && Math.round(prog) !== this.lastProgram) {
          const first = this.lastProgram === undefined;
          this.lastProgram = Math.round(prog);
          if (!first) this.send(encode.program(this.outChannelValue(), this.lastProgram));
        }
      }),
    );
  }

  private outChannelValue(): number {
    return Math.round(this.overrides.outChannel ?? this.outChannel) || 1;
  }

  private listenOut(): void {
    for (const u of this.outUnsubs) u();
    this.outUnsubs = [];
    this.lastEventsJson = "";
    this.lastTrigger = undefined;
    if (this.events) {
      this.outUnsubs.push(
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
      this.outUnsubs.push(
        listenDp(this.trigger, (v) => {
          if (v === null || v === undefined) return;
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
    if (this.ccOut) {
      let first = true;
      this.outUnsubs.push(
        listenDp(this.ccOut, (v) => {
          const values = plain<Record<string, unknown>>(v);
          if (!values || typeof values !== "object") return;
          for (const [k, raw] of Object.entries(values)) {
            const cc = num(k, 0, 127);
            const val = num(raw, 0, 1);
            if (cc === undefined || val === undefined) continue;
            const q = Math.round(val * 127);
            if (this.lastCc[k] === q) continue;
            this.lastCc[k] = q;
            // valeurs initiales mémorisées sans être envoyées
            if (!first) this.send(encode.cc(this.outChannelValue(), cc, val));
          }
          first = false;
        }),
      );
    }
  }

  private noteOf(ev: SonicNoteEvent): number | null {
    if (ev.note !== undefined) return toMidi(ev.note);
    if (ev.sample !== undefined && this.notesMap?.[ev.sample] !== undefined) return toMidi(this.notesMap[ev.sample]);
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Horloge sortante                                                  */
  /* ---------------------------------------------------------------- */

  private setupClockOut(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.clockSent = { playing: false, tick: -1, t0: 0 };
    if (!this.clockOut) return;
    this.clockTimer = setInterval(() => this.clockTick(), CLOCK_TICK_MS);
  }

  private clockTick(): void {
    if (!this.outs.length) return;
    const engine = AudioEngine.get();
    const ac = engine.context;
    const src = resolveAudioElement(this, this.clockOut.startsWith("#") ? this.clockOut : `#${this.clockOut}`) as TransportSource | null;
    const tr = src && typeof src.getTransport === "function" ? src.getTransport() : null;
    if (!ac || !tr) return;
    if (!tr.playing) {
      if (this.clockSent.playing) {
        this.send(encode.stop());
        this.clockSent = { playing: false, tick: -1, t0: 0 };
      }
      return;
    }
    const tickDur = 60 / tr.bpm / 24;
    if (!this.clockSent.playing) {
      // départ : Start juste avant le premier tick (le tick suivant un Start est le temps 1)
      const firstTick = Math.max(0, Math.ceil((ac.currentTime - tr.t0) / tickDur - 1e-9));
      const at = engine.perfAtCtxTime(tr.t0 + firstTick * tickDur);
      this.send(firstTick === 0 ? encode.start() : encode.continue(), at !== null ? at - 1 : undefined);
      this.clockSent = { playing: true, tick: firstTick - 1, t0: tr.t0 };
    }
    this.clockSent.t0 = tr.t0;
    const horizon = ac.currentTime + CLOCK_HORIZON_S;
    // tempo changeant : t0 est ré-ancré par le séquenceur, la position reste continue
    for (let k = this.clockSent.tick + 1, n = 0; n < 96; k++, n++) {
      const when = tr.t0 + k * tickDur;
      if (when >= horizon) break;
      if (when < ac.currentTime - 0.05) {
        this.clockSent.tick = k;
        continue;
      }
      const at = engine.perfAtCtxTime(when);
      this.send(encode.clock(), at ?? undefined);
      this.clockSent.tick = k;
    }
  }

  /* ---------------------------------------------------------------- */
  /* État                                                              */
  /* ---------------------------------------------------------------- */

  private patch(p: Partial<MidiState>): void {
    this.state = { ...this.state, ...p };
    this.publish();
  }

  private publishQueued = false;
  private publish(): void {
    this.state.held = this.tracker.held.map((h) => {
      const note = clampNote(h.note + (Math.round(this.transpose) || 0));
      return { note, name: noteName(note), ch: h.ch, vel: round(h.vel), bend: round(h.bend), pressure: round(h.pressure), timbre: round(h.timbre) };
    });
    const out = (this.outDataProvider || (this.id ? `${this.id}State` : "")).trim();
    if (!out || this.publishQueued) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      set(out, this.getState());
    });
  }

  private soonTimer: ReturnType<typeof setTimeout> | null = null;
  /** Valeurs continues : au plus `rate` publications par seconde. */
  private publishSoon(): void {
    if (this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      this.publish();
    }, 1000 / Math.max(1, Math.min(120, this.rate)));
  }

  render() {
    return html``;
  }
}

function clampNote(n: number): number {
  return Math.min(127, Math.max(0, n));
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export default SonicMidi;
