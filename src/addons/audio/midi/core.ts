/**
 * MIDI pur : décodage / encodage des messages, suivi d'horloge, état MPE.
 * Sans Web MIDI ni DOM (testable seul).
 */

export type MidiMessage =
  | { kind: "noteOn"; ch: number; note: number; vel: number }
  | { kind: "noteOff"; ch: number; note: number; vel: number }
  | { kind: "polyPressure"; ch: number; note: number; value: number }
  | { kind: "cc"; ch: number; cc: number; value: number }
  | { kind: "program"; ch: number; program: number }
  | { kind: "pressure"; ch: number; value: number }
  /** bend : -1..1 (14 bits). */
  | { kind: "bend"; ch: number; value: number }
  | { kind: "clock" }
  | { kind: "start" }
  | { kind: "continue" }
  | { kind: "stop" }
  /** Song Position Pointer : en doubles-croches (6 ticks d'horloge). */
  | { kind: "spp"; sixteenths: number };

/** Décode un message (statut courant non géré : Web MIDI livre des messages complets). Canaux 1..16, valeurs 0..1. */
export function parseMidi(data: ArrayLike<number>): MidiMessage | null {
  const status = data[0];
  if (status === undefined) return null;
  switch (status) {
    case 0xf8:
      return { kind: "clock" };
    case 0xfa:
      return { kind: "start" };
    case 0xfb:
      return { kind: "continue" };
    case 0xfc:
      return { kind: "stop" };
    case 0xf2:
      return data.length >= 3 ? { kind: "spp", sixteenths: (data[1] & 0x7f) | ((data[2] & 0x7f) << 7) } : null;
  }
  if (status < 0x80 || status >= 0xf0) return null;
  const type = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  const d1 = (data[1] ?? 0) & 0x7f;
  const d2 = (data[2] ?? 0) & 0x7f;
  switch (type) {
    case 0x90:
      // note on vélocité 0 = note off
      return d2 === 0 ? { kind: "noteOff", ch, note: d1, vel: 0 } : { kind: "noteOn", ch, note: d1, vel: d2 / 127 };
    case 0x80:
      return { kind: "noteOff", ch, note: d1, vel: d2 / 127 };
    case 0xa0:
      return { kind: "polyPressure", ch, note: d1, value: d2 / 127 };
    case 0xb0:
      return { kind: "cc", ch, cc: d1, value: d2 / 127 };
    case 0xc0:
      return { kind: "program", ch, program: d1 };
    case 0xd0:
      return { kind: "pressure", ch, value: d1 / 127 };
    case 0xe0: {
      const v14 = d1 | (d2 << 7);
      return { kind: "bend", ch, value: v14 === 8192 ? 0 : Math.max(-1, (v14 - 8192) / (v14 > 8192 ? 8191 : 8192)) };
    }
  }
  return null;
}

const ch0 = (ch: number) => (Math.min(16, Math.max(1, Math.round(ch))) - 1) & 0x0f;
const b7 = (v: number) => Math.min(127, Math.max(0, Math.round(v))) & 0x7f;

export const encode = {
  noteOn: (ch: number, note: number, vel01: number) => [0x90 | ch0(ch), b7(note), Math.max(1, b7(vel01 * 127))],
  noteOff: (ch: number, note: number) => [0x80 | ch0(ch), b7(note), 0],
  cc: (ch: number, cc: number, value01: number) => [0xb0 | ch0(ch), b7(cc), b7(value01 * 127)],
  program: (ch: number, program: number) => [0xc0 | ch0(ch), b7(program)],
  /** -1..1 */
  bend: (ch: number, value: number) => {
    const v = Math.min(16383, Math.max(0, Math.round(8192 + Math.max(-1, Math.min(1, value)) * (value >= 0 ? 8191 : 8192))));
    return [0xe0 | ch0(ch), v & 0x7f, (v >> 7) & 0x7f];
  },
  pressure: (ch: number, value01: number) => [0xd0 | ch0(ch), b7(value01 * 127)],
  clock: () => [0xf8],
  start: () => [0xfa],
  continue: () => [0xfb],
  stop: () => [0xfc],
  allNotesOff: (ch: number) => [0xb0 | ch0(ch), 123, 0],
};

/* ------------------------------------------------------------------ */
/* Horloge entrante (24 ticks par noire)                                */
/* ------------------------------------------------------------------ */

export type ClockState = {
  running: boolean;
  /** Tempo mesuré (0 tant qu'il n'y a pas assez de ticks). */
  bpm: number;
  /** Ticks depuis Start (ou depuis la position SPP). */
  ticks: number;
  /** Noires écoulées (entier). */
  beat: number;
};

export class ClockFollower {
  running = false;
  ticks = 0;
  bpm = 0;
  private times: number[] = [];

  /** Message d'horloge reçu à `t` (ms). Renvoie l'événement de transport utile, s'il y en a un. */
  feed(m: MidiMessage, t: number): "start" | "continue" | "stop" | "beat" | null {
    switch (m.kind) {
      case "start":
        this.running = true;
        this.ticks = 0;
        return "start";
      case "continue":
        this.running = true;
        return "continue";
      case "stop":
        this.running = false;
        return "stop";
      case "spp":
        this.ticks = m.sixteenths * 6;
        return null;
      case "clock": {
        this.times.push(t);
        if (this.times.length > 25) this.times.shift();
        if (this.times.length >= 7) {
          const n = this.times.length - 1;
          const avg = (this.times[n] - this.times[0]) / n;
          if (avg > 0) {
            const bpm = 60000 / (avg * 24);
            // lissé, arrondi au dixième : un tempo stable ne bouge pas
            this.bpm = this.bpm ? Math.round((this.bpm * 0.6 + bpm * 0.4) * 10) / 10 : Math.round(bpm * 10) / 10;
          }
        }
        if (!this.running) return null;
        this.ticks++;
        return this.ticks % 24 === 0 ? "beat" : null;
      }
    }
    return null;
  }

  /** Pas d'horloge depuis un moment : tempo inconnu. */
  idle(now: number, ms = 1500): boolean {
    const last = this.times[this.times.length - 1];
    if (last !== undefined && now - last > ms) {
      this.times = [];
      this.bpm = 0;
      return true;
    }
    return false;
  }

  getState(): ClockState {
    return { running: this.running, bpm: this.bpm, ticks: this.ticks, beat: Math.floor(this.ticks / 24) };
  }
}

/* ------------------------------------------------------------------ */
/* Notes tenues et expressions (MPE ou canal entier)                    */
/* ------------------------------------------------------------------ */

export type HeldNote = { note: number; ch: number; vel: number; bend: number; pressure: number; timbre: number };

export type ExpressionChange = { note: number; ch: number; bend?: number; pressure?: number; timbre?: number };

/**
 * Suivi des notes tenues. En MPE, chaque note a son canal : bend / pression /
 * CC74 du canal ne touchent qu'elle ; le canal maître (1 ou 16) touche tout.
 * Hors MPE, ces messages s'appliquent à toutes les notes du canal.
 */
export class NoteTracker {
  held: HeldNote[] = [];
  /** Valeurs par canal, conservées pour la prochaine note (MPE : envoyées juste avant le noteOn). */
  private chan = new Map<number, { bend: number; pressure: number; timbre: number }>();

  constructor(
    public opts: { mpe: boolean; bendRange: number; masterBendRange: number; masterCh: number },
  ) {}

  private channel(ch: number) {
    let c = this.chan.get(ch);
    if (!c) this.chan.set(ch, (c = { bend: 0, pressure: 0, timbre: 0.5 }));
    return c;
  }

  private isMaster(ch: number): boolean {
    return this.opts.mpe && ch === this.opts.masterCh;
  }

  noteOn(ch: number, note: number, vel: number): HeldNote {
    this.held = this.held.filter((h) => !(h.note === note && h.ch === ch));
    const c = this.channel(ch);
    const master = this.opts.mpe ? this.channel(this.opts.masterCh) : null;
    const h: HeldNote = {
      note,
      ch,
      vel,
      bend: c.bend * this.opts.bendRange + (master && !this.isMaster(ch) ? master.bend * this.opts.masterBendRange : 0),
      pressure: c.pressure,
      timbre: c.timbre,
    };
    this.held.push(h);
    if (this.held.length > 64) this.held.shift();
    return h;
  }

  noteOff(ch: number, note: number): HeldNote | null {
    const i = this.held.findIndex((h) => h.note === note && h.ch === ch);
    if (i < 0) return null;
    return this.held.splice(i, 1)[0];
  }

  /** Message d'expression → changements par note tenue concernée. */
  expression(m: MidiMessage): ExpressionChange[] {
    if (m.kind === "polyPressure") {
      const h = this.held.find((x) => x.note === m.note && x.ch === m.ch);
      if (!h) return [];
      h.pressure = m.value;
      return [{ note: h.note, ch: h.ch, pressure: m.value }];
    }
    if (m.kind !== "bend" && m.kind !== "pressure" && !(m.kind === "cc" && m.cc === 74)) return [];
    const c = this.channel(m.ch);
    const field = m.kind === "bend" ? "bend" : m.kind === "pressure" ? "pressure" : "timbre";
    c[field] = m.value;
    const master = this.isMaster(m.ch);
    const targets = this.opts.mpe && !master ? this.held.filter((h) => h.ch === m.ch) : master ? this.held : this.held.filter((h) => h.ch === m.ch);
    const out: ExpressionChange[] = [];
    for (const h of targets) {
      if (field === "bend") {
        const own = this.opts.mpe && !this.isMaster(h.ch) ? this.channel(h.ch).bend * this.opts.bendRange : 0;
        const global = this.opts.mpe ? this.channel(this.opts.masterCh).bend * this.opts.masterBendRange : c.bend * this.opts.bendRange;
        h.bend = this.opts.mpe ? own + global : global;
        out.push({ note: h.note, ch: h.ch, bend: h.bend });
      } else {
        h[field] = m.value;
        out.push({ note: h.note, ch: h.ch, [field]: m.value });
      }
    }
    return out;
  }

  /** Canal (1..16) : reset des notes (all notes off). */
  clear(ch?: number): HeldNote[] {
    const gone = ch === undefined ? this.held : this.held.filter((h) => h.ch === ch);
    this.held = ch === undefined ? [] : this.held.filter((h) => h.ch !== ch);
    return gone;
  }
}

export function noteName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Choisit les ports qui correspondent : "all", "none", "" (= tous en entrée), ou morceau de nom / id (insensible à la casse). */
export function matchPorts<T extends { id: string; name?: string | null; manufacturer?: string | null }>(ports: T[], want: string): T[] {
  const w = (want ?? "").trim().toLowerCase();
  if (w === "none") return [];
  if (w === "" || w === "all") return ports;
  if (w === "first") return ports.slice(0, 1);
  return ports.filter((p) => p.id.toLowerCase() === w || `${p.manufacturer ?? ""} ${p.name ?? ""}`.toLowerCase().includes(w));
}
