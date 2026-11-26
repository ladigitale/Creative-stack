/**
 * MIDI sur Bluetooth LE (spécification « MIDI over Bluetooth Low Energy » de la MIDI Association) : codec pur,
 * sans DOM ni Bluetooth.
 *
 * Paquet : un octet d'en-tête (`10hh hhhh` : 6 bits hauts de l'horodatage en ms), puis des messages MIDI,
 * chacun précédé d'un octet d'horodatage (`1lll llll` : 7 bits bas). Un message peut omettre son statut
 * (statut courant), avec ou sans nouvel horodatage. Un SysEx peut s'étendre sur plusieurs paquets ; son `F7`
 * final est précédé d'un horodatage. Service `03B80E5A-EDE8-4B33-A751-6CE34EC4C700`, caractéristique
 * `7772E5DB-3868-4112-A1A9-F2669D106BF3` (écriture sans réponse et notification).
 *
 * Forme des événements alignée sur `sonic-midi` (addon audio) : canal 1..16, vélocité et valeur 0..1,
 * pitch bend -1..1, nom de note. Écrit d'après la spécification, non testé sur matériel.
 */

export type BleMidiType = "noteon" | "noteoff" | "cc" | "pitchbend" | "program" | "aftertouch" | "sysex" | "start" | "continue" | "stop";

export type BleMidiEvent = {
  type: BleMidiType;
  /** Canal 1..16 (absent pour SysEx et transport). */
  channel?: number;
  note?: number;
  /** Nom de la note (`C4`, `F#3`). */
  name?: string;
  /** Vélocité 0..1 (note on / off). */
  velocity?: number;
  /** cc et aftertouch : 0..1 ; pitchbend : -1..1. */
  value?: number;
  /** Numéro de contrôleur (cc). */
  cc?: number;
  /** Numéro de programme (program). */
  program?: number;
  /** Octets MIDI du message (SysEx compris, `F0 … F7`). */
  data: number[];
  /** Horodatage de l'appareil en ms (13 bits, revient à 0 toutes les 8,192 s). */
  t: number;
};

/** Taille maximale d'un SysEx reçu (au-delà, il est abandonné). */
export const MAX_SYSEX = 1024;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (n: number): string => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

/** Nombre d'octets de données après un statut (canal ou système commun). `-1` : statut sans longueur fixe. */
function dataLength(status: number): number {
  if (status < 0xf0) {
    const t = status & 0xf0;
    return t === 0xc0 || t === 0xd0 ? 1 : 2;
  }
  if (status === 0xf1 || status === 0xf3) return 1;
  if (status === 0xf2) return 2;
  if (status === 0xf6) return 0;
  return -1;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Message MIDI complet → événement (`null` pour ce qui n'est pas exposé : horloge, active sensing, système commun). */
export function midiEvent(data: number[], t: number): BleMidiEvent | null {
  const s = data[0];
  if (s === 0xf0) return { type: "sysex", data, t };
  if (s === 0xfa) return { type: "start", data, t };
  if (s === 0xfb) return { type: "continue", data, t };
  if (s === 0xfc) return { type: "stop", data, t };
  if (s === undefined || s < 0x80 || s >= 0xf0) return null;
  const channel = (s & 0x0f) + 1;
  const d1 = (data[1] ?? 0) & 0x7f;
  const d2 = (data[2] ?? 0) & 0x7f;
  switch (s & 0xf0) {
    case 0x90:
      // Note on de vélocité 0 = note off.
      return { type: d2 ? "noteon" : "noteoff", channel, note: d1, name: noteName(d1), velocity: r3(d2 / 127), data, t };
    case 0x80:
      return { type: "noteoff", channel, note: d1, name: noteName(d1), velocity: r3(d2 / 127), data, t };
    case 0xa0:
      return { type: "aftertouch", channel, note: d1, name: noteName(d1), value: r3(d2 / 127), data, t };
    case 0xb0:
      return { type: "cc", channel, cc: d1, value: r3(d2 / 127), data, t };
    case 0xc0:
      return { type: "program", channel, program: d1, data, t };
    case 0xd0:
      return { type: "aftertouch", channel, value: r3(d1 / 127), data, t };
    default: {
      const v14 = d1 | (d2 << 7);
      return { type: "pitchbend", channel, value: v14 === 8192 ? 0 : r3(Math.max(-1, (v14 - 8192) / (v14 > 8192 ? 8191 : 8192))), data, t };
    }
  }
}

/**
 * Décodeur à état : statut courant et SysEx en cours sont gardés d'un paquet à l'autre.
 * `feed` rend les messages MIDI complets (octets) avec leur horodatage ; `events` les rend en événements.
 */
export class BleMidiDecoder {
  private running = 0;
  private sysex: number[] | null = null;
  private lastLow = 0;

  reset(): void {
    this.running = 0;
    this.sysex = null;
  }

  feed(packet: ArrayLike<number>): { data: number[]; t: number }[] {
    const out: { data: number[]; t: number }[] = [];
    const n = packet.length;
    // En-tête obligatoire : bit 7 à 1, bit 6 à 0.
    if (n < 2 || (packet[0] & 0xc0) !== 0x80) return out;
    const high = packet[0] & 0x3f;
    let t = (high << 7) | this.lastLow;
    let i = 1;

    const skip = (): void => {
      while (i < n && !(packet[i] & 0x80)) i++;
    };
    const readData = (status: number): boolean => {
      const len = dataLength(status);
      if (len < 0) return false;
      const msg = [status];
      for (let k = 0; k < len; k++) {
        if (i >= n || packet[i] & 0x80) return false; // message tronqué : abandonné
        msg.push(packet[i++]);
      }
      out.push({ data: msg, t });
      return true;
    };
    const readSysex = (): void => {
      while (i < n && !(packet[i] & 0x80)) {
        const b = packet[i++];
        if (this.sysex) {
          if (this.sysex.length >= MAX_SYSEX) this.sysex = null;
          else this.sysex.push(b);
        }
      }
    };

    // Paquet de suite d'un SysEx : les données viennent directement après l'en-tête.
    if (this.sysex && !(packet[1] & 0x80)) readSysex();

    while (i < n) {
      const b = packet[i];
      if (b & 0x80) {
        // Octet d'horodatage.
        this.lastLow = b & 0x7f;
        t = (high << 7) | this.lastLow;
        i++;
        if (i >= n) break;
        const s = packet[i];
        if (!(s & 0x80)) {
          // Statut courant avec nouvel horodatage.
          if (this.sysex) {
            readSysex();
            continue;
          }
          if (!this.running || !readData(this.running)) skip();
          continue;
        }
        i++;
        if (s >= 0xf8) {
          // Temps réel : peut s'intercaler partout, ne touche ni au statut courant ni au SysEx.
          out.push({ data: [s], t });
          continue;
        }
        if (s === 0xf7) {
          if (this.sysex) out.push({ data: [...this.sysex, 0xf7], t });
          this.sysex = null;
          continue;
        }
        // Tout autre statut interrompt un SysEx inachevé.
        this.sysex = null;
        if (s === 0xf0) {
          this.running = 0;
          this.sysex = [0xf0];
          readSysex();
          continue;
        }
        // Les messages système communs annulent le statut courant ; ceux de canal le deviennent.
        this.running = s < 0xf0 ? s : 0;
        if (!readData(s)) skip();
      } else {
        // Octets de données sans horodatage : statut courant, même instant.
        if (this.sysex) {
          readSysex();
          continue;
        }
        if (!this.running || !readData(this.running)) skip();
      }
    }
    return out;
  }

  events(packet: ArrayLike<number>): BleMidiEvent[] {
    const out: BleMidiEvent[] = [];
    for (const m of this.feed(packet)) {
      const e = midiEvent(m.data, m.t);
      if (e) out.push(e);
    }
    return out;
  }
}

/**
 * Découpe une suite d'octets MIDI en messages complets. Refuse (`null`) ce qui n'est pas bien formé, et le
 * SysEx : un document ne doit pas pouvoir envoyer de messages constructeur (mise à jour, effacement…).
 */
export function splitMidi(bytes: ArrayLike<number>): number[][] | null {
  const out: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    const s = bytes[i];
    if (!Number.isInteger(s) || s < 0x80 || s > 0xff) return null;
    if (s === 0xf0 || s === 0xf7) return null;
    if (s >= 0xf8) {
      out.push([s]);
      i++;
      continue;
    }
    const len = dataLength(s);
    if (len < 0) return null;
    const msg = [s];
    for (let k = 0; k < len; k++) {
      const d = bytes[i + 1 + k];
      if (!Number.isInteger(d) || d < 0 || d > 0x7f) return null;
      msg.push(d);
    }
    out.push(msg);
    i += 1 + len;
  }
  return out.length ? out : null;
}

/**
 * Messages MIDI → paquets BLE-MIDI d'au plus `maxLen` octets (20 = MTU par défaut de 23 moins 3), un
 * horodatage devant chaque message, statut toujours écrit (pas de statut courant en sortie : plus simple à lire
 * pour les appareils). Un message n'est jamais coupé entre deux paquets.
 */
export function encodeBleMidi(messages: number[][], timeMs: number, maxLen = 20): Uint8Array[] {
  const ts = Math.max(0, Math.floor(timeMs)) & 0x1fff;
  const header = 0x80 | ((ts >> 7) & 0x3f);
  const stamp = 0x80 | (ts & 0x7f);
  const packets: Uint8Array[] = [];
  let current: number[] = [header];
  for (const m of messages) {
    if (current.length > 1 && current.length + 1 + m.length > maxLen) {
      packets.push(Uint8Array.from(current));
      current = [header];
    }
    current.push(stamp, ...m);
  }
  if (current.length > 1) packets.push(Uint8Array.from(current));
  return packets;
}

export type HeldMidiNote = { note: number; name: string; channel: number; velocity: number };

/** Notes tenues (64 au plus) d'après les événements reçus ; CC 120 et 123 vident le canal. */
export function trackNotes(held: HeldMidiNote[], e: BleMidiEvent): HeldMidiNote[] {
  if (e.type === "noteon" && e.note !== undefined && e.channel !== undefined) {
    const next = held.filter((h) => !(h.note === e.note && h.channel === e.channel));
    next.push({ note: e.note, name: e.name ?? noteName(e.note), channel: e.channel, velocity: e.velocity ?? 0 });
    return next.length > 64 ? next.slice(next.length - 64) : next;
  }
  if (e.type === "noteoff") return held.filter((h) => !(h.note === e.note && h.channel === e.channel));
  if (e.type === "cc" && (e.cc === 120 || e.cc === 123)) return held.filter((h) => h.channel !== e.channel);
  return held;
}
