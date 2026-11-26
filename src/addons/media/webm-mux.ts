/**
 * Petit muxer WebM (Matroska) pour une piste vidéo VP8 / VP9 et, au besoin, une piste audio Opus,
 * encodées par WebCodecs.
 *
 * Tout est assemblé en mémoire : les tailles (Segment, Clusters) sont connues à la fin, ce qui
 * évite les tailles « inconnues » et rend le fichier lisible et navigable partout.
 * Structure : EBML header, Segment { Info (TimecodeScale 1 ms, Duration), Tracks (vidéo = piste 1,
 * audio = piste 2), Clusters (Timecode + SimpleBlock vidéo et audio entrelacés par temps, nouveau
 * cluster à chaque image clé vidéo), Cues (images clés vidéo) }.
 */

export const EBML_ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const;

export type WebmCodec = "V_VP8" | "V_VP9";

/** Octets d'un identifiant EBML (le marqueur de longueur fait partie de l'id). */
export function idBytes(id: number): Uint8Array {
  const n = id >= 0x1000000 ? 4 : id >= 0x10000 ? 3 : id >= 0x100 ? 2 : 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(id / 2 ** (8 * (n - 1 - i))) & 0xff;
  return out;
}

/** Taille codée en VINT, sur la plus petite longueur possible (la valeur « tout à 1 » est réservée). */
export function vint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) throw new Error(`taille EBML invalide : ${value}`);
  let n = 1;
  while (n < 8 && value >= 2 ** (7 * n) - 1) n++;
  if (value >= 2 ** (7 * n) - 1) throw new Error(`taille EBML trop grande : ${value}`);
  const out = new Uint8Array(n);
  let v = value;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 1 << (8 - n);
  return out;
}

/** Entier non signé big-endian sur le moins d'octets possible (au moins un). */
export function uintBytes(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) throw new Error(`entier EBML invalide : ${value}`);
  let n = 1;
  while (n < 8 && value >= 2 ** (8 * n)) n++;
  const out = new Uint8Array(n);
  let v = value;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Élément EBML : id + taille + contenu. */
export function element(id: number, payload: Uint8Array | Uint8Array[]): Uint8Array {
  const body = Array.isArray(payload) ? concat(payload) : payload;
  return concat([idBytes(id), vint(body.length), body]);
}

export const uintEl = (id: number, v: number) => element(id, uintBytes(v));
export const strEl = (id: number, s: string) => element(id, new TextEncoder().encode(s));
export function floatEl(id: number, v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return element(id, b);
}

/** SimpleBlock : piste (VINT), temps relatif au cluster (int16), drapeaux (0x80 = image clé), données. */
export function simpleBlock(track: number, relMs: number, keyframe: boolean, data: Uint8Array): Uint8Array {
  if (relMs < -32768 || relMs > 32767) throw new Error(`temps relatif hors limites : ${relMs}`);
  const head = new Uint8Array(3);
  new DataView(head.buffer).setInt16(0, relMs);
  head[2] = keyframe ? 0x80 : 0;
  return element(EBML_ID.SimpleBlock, [vint(track), head, data]);
}

/** Pre-skip de libopus à 48 kHz (anticipation de l'encodeur), en échantillons. */
export const OPUS_PRE_SKIP = 312;
/** Pré-lecture conseillée pour Opus après un saut (80 ms), en ns. */
const OPUS_SEEK_PREROLL_NS = 80_000_000;

/**
 * En-tête d'identification Opus (RFC 7845 §5.1) : CodecPrivate de la piste A_OPUS.
 * Famille de correspondance 0 : 1 ou 2 canaux.
 */
export function opusHead(channels: number, inputRate: number, preSkip = OPUS_PRE_SKIP): Uint8Array {
  if (channels !== 1 && channels !== 2) throw new Error(`Opus : 1 ou 2 canaux attendus (reçu ${channels})`);
  const b = new Uint8Array(19);
  b.set(new TextEncoder().encode("OpusHead"), 0);
  const v = new DataView(b.buffer);
  v.setUint8(8, 1); // version
  v.setUint8(9, channels);
  v.setUint16(10, preSkip, true);
  v.setUint32(12, Math.round(inputRate), true);
  v.setInt16(16, 0, true); // gain de sortie
  v.setUint8(18, 0); // famille de correspondance
  return b;
}

/** Pre-skip lu dans un OpusHead (octets 10-11, petit-boutiste), ou null si ce n'en est pas un. */
export function opusPreSkip(head: Uint8Array): number | null {
  if (head.length < 19 || new TextDecoder().decode(head.subarray(0, 8)) !== "OpusHead") return null;
  return head[10] | (head[11] << 8);
}

export type WebmAudioOptions = {
  /** 1 ou 2. */
  channels: number;
  /** Fréquence d'entrée de l'encodeur (écrite dans l'OpusHead construit ; la piste annonce 48 kHz). */
  inputRate: number;
  /** OpusHead fourni par l'encodeur (`decoderConfig.description`) ; sinon construit. */
  codecPrivate?: Uint8Array;
};

export type WebmOptions = {
  codec: WebmCodec;
  width: number;
  height: number;
  /** Plafond de taille du fichier en octets (dépassement : `add` lève une erreur). */
  maxBytes?: number;
  /** Durée d'une image en ms (DefaultDuration), quand la cadence est fixe. */
  frameMs?: number;
  /** Piste audio Opus (écrite seulement si des blocs audio ont été ajoutés). */
  audio?: WebmAudioOptions;
  app?: string;
};

type Block = { track: 1 | 2; t: number; key: boolean; data: Uint8Array; seq: number };
type Cluster = { time: number; blocks: Uint8Array[]; cue: boolean };

/** Taille max d'un cluster en temps : le temps relatif d'un bloc tient sur un int16. */
const CLUSTER_MAX_MS = 30000;

export class WebmMuxer {
  private blocks: Block[] = [];
  private bytes = 0;
  private lastMs = 0;
  /** Images vidéo ajoutées. */
  frames = 0;
  /** Paquets audio ajoutés. */
  audioPackets = 0;

  constructor(readonly opts: WebmOptions) {}

  /** Octets des blocs déjà ajoutés (approximation de la taille du fichier). */
  get size(): number {
    return this.bytes;
  }

  /** Ajoute une image vidéo encodée (temps en ms depuis le début). */
  add(data: Uint8Array, timeMs: number, keyframe: boolean): void {
    if (!this.frames && !keyframe) throw new Error("la première image doit être une image clé");
    const t = Math.max(0, Math.round(timeMs));
    this.push({ track: 1, t, key: keyframe, data, seq: this.blocks.length });
    this.lastMs = Math.max(this.lastMs, t);
    this.frames++;
  }

  /** Ajoute un paquet Opus (temps en ms depuis le début ; chaque paquet est indépendant). */
  addAudio(data: Uint8Array, timeMs: number): void {
    if (!this.opts.audio) throw new Error("aucune piste audio déclarée");
    const t = Math.max(0, Math.round(timeMs));
    this.push({ track: 2, t, key: true, data, seq: this.blocks.length });
    this.audioPackets++;
  }

  /** OpusHead donné par l'encodeur après coup (premier paquet). */
  setAudioCodecPrivate(head: Uint8Array): void {
    if (this.opts.audio) this.opts.audio.codecPrivate = head;
  }

  private push(b: Block): void {
    // Taille exacte du SimpleBlock : id (1) + taille (VINT) + piste (1) + temps (2) + drapeaux (1) + données.
    const body = 4 + b.data.length;
    const len = 1 + vint(body).length + body;
    const max = this.opts.maxBytes ?? Infinity;
    if (this.bytes + len > max) throw new Error(`taille maximale atteinte (${Math.round(max / 1e6)} Mo)`);
    this.blocks.push(b);
    this.bytes += len;
  }

  /** Blocs triés par temps, répartis en clusters (nouveau cluster à chaque image clé vidéo, ou après 30 s). */
  private clusters(): Cluster[] {
    const sorted = [...this.blocks].sort((a, b) => a.t - b.t || a.seq - b.seq);
    const out: Cluster[] = [];
    let c: Cluster | null = null;
    for (const b of sorted) {
      const videoKey = b.track === 1 && b.key;
      if (!c || videoKey || b.t - c.time > CLUSTER_MAX_MS) {
        // Un cluster qui commence par une image clé vidéo est un point d'entrée (Cues).
        c = { time: b.t, blocks: [], cue: videoKey };
        out.push(c);
      }
      c.blocks.push(simpleBlock(b.track, b.t - c.time, b.key, b.data));
    }
    return out;
  }

  private audioEntry(): Uint8Array | null {
    const a = this.opts.audio;
    if (!a || !this.audioPackets) return null;
    const head = a.codecPrivate?.length ? a.codecPrivate : opusHead(a.channels, a.inputRate);
    const given = opusPreSkip(head);
    const preSkip = given ?? OPUS_PRE_SKIP;
    const channels = given !== null ? head[9] : a.channels;
    return element(EBML_ID.TrackEntry, [
      uintEl(EBML_ID.TrackNumber, 2),
      uintEl(EBML_ID.TrackUID, 2),
      uintEl(EBML_ID.TrackType, 2),
      uintEl(EBML_ID.FlagLacing, 0),
      strEl(EBML_ID.CodecID, "A_OPUS"),
      element(EBML_ID.CodecPrivate, head),
      uintEl(EBML_ID.CodecDelay, Math.round((preSkip / 48000) * 1e9)),
      uintEl(EBML_ID.SeekPreRoll, OPUS_SEEK_PREROLL_NS),
      // Opus se décode toujours à 48 kHz : c'est la fréquence annoncée par la piste.
      element(EBML_ID.Audio, [floatEl(EBML_ID.SamplingFrequency, 48000), uintEl(EBML_ID.Channels, channels)]),
    ]);
  }

  /** Fichier en morceaux (pour un Blob sans recopie). `durationMs` par défaut : dernière image + une image. */
  finishParts(durationMs?: number): Uint8Array[] {
    const o = this.opts;
    const app = o.app ?? "creative-stack";
    const header = element(EBML_ID.EBML, [
      uintEl(EBML_ID.EBMLVersion, 1),
      uintEl(EBML_ID.EBMLReadVersion, 1),
      uintEl(EBML_ID.EBMLMaxIDLength, 4),
      uintEl(EBML_ID.EBMLMaxSizeLength, 8),
      strEl(EBML_ID.DocType, "webm"),
      uintEl(EBML_ID.DocTypeVersion, 4),
      uintEl(EBML_ID.DocTypeReadVersion, 2),
    ]);
    const duration = durationMs ?? this.lastMs + (o.frameMs ?? 0);
    const info = element(EBML_ID.Info, [
      uintEl(EBML_ID.TimecodeScale, 1_000_000),
      floatEl(EBML_ID.Duration, duration),
      strEl(EBML_ID.MuxingApp, app),
      strEl(EBML_ID.WritingApp, app),
    ]);
    const entry: Uint8Array[] = [
      uintEl(EBML_ID.TrackNumber, 1),
      uintEl(EBML_ID.TrackUID, 1),
      uintEl(EBML_ID.TrackType, 1),
      uintEl(EBML_ID.FlagLacing, 0),
      strEl(EBML_ID.CodecID, o.codec),
    ];
    if (o.frameMs && o.frameMs > 0) entry.push(uintEl(EBML_ID.DefaultDuration, Math.round(o.frameMs * 1e6)));
    entry.push(element(EBML_ID.Video, [uintEl(EBML_ID.PixelWidth, o.width), uintEl(EBML_ID.PixelHeight, o.height)]));
    const entries = [element(EBML_ID.TrackEntry, entry)];
    const audio = this.audioEntry();
    if (audio) entries.push(audio);
    const tracks = element(EBML_ID.Tracks, entries);

    // Positions des clusters relatives au début des données du Segment (pour les Cues).
    const body: Uint8Array[] = [info, tracks];
    let pos = info.length + tracks.length;
    const cues: Uint8Array[] = [];
    for (const c of this.clusters()) {
      const cluster = element(EBML_ID.Cluster, [uintEl(EBML_ID.Timecode, c.time), ...c.blocks]);
      if (c.cue) {
        cues.push(
          element(EBML_ID.CuePoint, [
            uintEl(EBML_ID.CueTime, c.time),
            element(EBML_ID.CueTrackPositions, [uintEl(EBML_ID.CueTrack, 1), uintEl(EBML_ID.CueClusterPosition, pos)]),
          ]),
        );
      }
      body.push(cluster);
      pos += cluster.length;
    }
    if (cues.length) body.push(element(EBML_ID.Cues, cues));
    let segLen = 0;
    for (const p of body) segLen += p.length;
    return [header, idBytes(EBML_ID.Segment), vint(segLen), ...body];
  }

  finish(durationMs?: number): Uint8Array {
    return concat(this.finishParts(durationMs));
  }
}
