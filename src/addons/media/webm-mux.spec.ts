import { describe, expect, it } from "vitest";
import { EBML_ID, WebmMuxer, element, floatEl, idBytes, opusHead, opusPreSkip, simpleBlock, strEl, uintBytes, uintEl, vint } from "./webm-mux";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

/** Lecteur EBML minimal pour vérifier la structure produite. */
type Node = { id: number; start: number; dataStart: number; size: number; children?: Node[] };

function readVint(b: Uint8Array, o: number, keepMarker: boolean): { value: number; len: number } {
  const first = b[o];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  let value = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + b[o + i];
  return { value, len };
}

const MASTERS = new Set<number>([
  EBML_ID.EBML, EBML_ID.Segment, EBML_ID.Info, EBML_ID.Tracks, EBML_ID.TrackEntry, EBML_ID.Video, EBML_ID.Audio,
  EBML_ID.Cluster, EBML_ID.Cues, EBML_ID.CuePoint, EBML_ID.CueTrackPositions,
]);

function parse(b: Uint8Array, from = 0, to = b.length): Node[] {
  const out: Node[] = [];
  let o = from;
  while (o < to) {
    const id = readVint(b, o, true);
    const size = readVint(b, o + id.len, false);
    const dataStart = o + id.len + size.len;
    const n: Node = { id: id.value, start: o, dataStart, size: size.value };
    if (MASTERS.has(id.value)) n.children = parse(b, dataStart, dataStart + size.value);
    out.push(n);
    o = dataStart + size.value;
  }
  expect(o).toBe(to);
  return out;
}

const uint = (b: Uint8Array, n: Node) => [...b.subarray(n.dataStart, n.dataStart + n.size)].reduce((a, x) => a * 256 + x, 0);
const str = (b: Uint8Array, n: Node) => new TextDecoder().decode(b.subarray(n.dataStart, n.dataStart + n.size));
const find = (nodes: Node[] | undefined, id: number) => nodes?.find((n) => n.id === id);
const all = (nodes: Node[] | undefined, id: number) => nodes?.filter((n) => n.id === id) ?? [];

describe("EBML de base", () => {
  it("tailles VINT : plus petite longueur, valeur tout à 1 évitée", () => {
    expect(hex(vint(0))).toBe("80");
    expect(hex(vint(1))).toBe("81");
    expect(hex(vint(126))).toBe("fe");
    expect(hex(vint(127))).toBe("40 7f"); // 0xff réservé (taille inconnue)
    expect(hex(vint(300))).toBe("41 2c");
    expect(hex(vint(16382))).toBe("7f fe");
    expect(hex(vint(16383))).toBe("20 3f ff");
    expect(hex(vint(2 ** 21 - 2))).toBe("3f ff fe");
    expect(hex(vint(2 ** 28))).toBe("08 10 00 00 00");
    expect(() => vint(-1)).toThrow();
  });

  it("identifiants sur 1 à 4 octets", () => {
    expect(hex(idBytes(EBML_ID.SimpleBlock))).toBe("a3");
    expect(hex(idBytes(EBML_ID.DocType))).toBe("42 82");
    expect(hex(idBytes(EBML_ID.TimecodeScale))).toBe("2a d7 b1");
    expect(hex(idBytes(EBML_ID.Segment))).toBe("18 53 80 67");
    expect(hex(idBytes(EBML_ID.EBML))).toBe("1a 45 df a3");
  });

  it("entiers, chaînes, flottants", () => {
    expect(hex(uintBytes(0))).toBe("00");
    expect(hex(uintBytes(255))).toBe("ff");
    expect(hex(uintBytes(256))).toBe("01 00");
    expect(hex(uintEl(EBML_ID.TimecodeScale, 1_000_000))).toBe("2a d7 b1 83 0f 42 40");
    expect(hex(strEl(EBML_ID.DocType, "webm"))).toBe("42 82 84 77 65 62 6d");
    expect(hex(floatEl(EBML_ID.Duration, 1))).toBe("44 89 88 3f f0 00 00 00 00 00 00");
    expect(hex(element(EBML_ID.Video, [uintEl(EBML_ID.PixelWidth, 2)]))).toBe("e0 83 b0 81 02");
  });

  it("SimpleBlock : piste, temps relatif signé, drapeau image clé", () => {
    expect(hex(simpleBlock(1, 0, true, new Uint8Array([9, 8])))).toBe("a3 86 81 00 00 80 09 08");
    expect(hex(simpleBlock(1, 33, false, new Uint8Array([7])))).toBe("a3 85 81 00 21 00 07");
    expect(hex(simpleBlock(1, -2, false, new Uint8Array(0)))).toBe("a3 84 81 ff fe 00");
    expect(() => simpleBlock(1, 40000, false, new Uint8Array(0))).toThrow();
  });
});

describe("WebmMuxer", () => {
  function build(codec: "V_VP9" | "V_VP8" = "V_VP9") {
    const m = new WebmMuxer({ codec, width: 320, height: 180, frameMs: 1000 / 30 });
    m.add(new Uint8Array([1, 1, 1]), 0, true);
    m.add(new Uint8Array([2]), 33.3, false);
    m.add(new Uint8Array([3]), 66.7, false);
    m.add(new Uint8Array([4, 4]), 2000, true);
    m.add(new Uint8Array([5]), 2033.3, false);
    return m;
  }

  it("en-tête EBML, Segment de taille exacte, Info, Tracks", () => {
    const b = build().finish(2066.7);
    const top = parse(b);
    expect(top.map((n) => n.id)).toEqual([EBML_ID.EBML, EBML_ID.Segment]);
    const head = top[0].children!;
    expect(str(b, find(head, EBML_ID.DocType)!)).toBe("webm");
    expect(uint(b, find(head, EBML_ID.EBMLMaxSizeLength)!)).toBe(8);
    const seg = top[1];
    expect(seg.dataStart + seg.size).toBe(b.length);
    const info = find(seg.children, EBML_ID.Info)!;
    expect(uint(b, find(info.children, EBML_ID.TimecodeScale)!)).toBe(1_000_000);
    const dur = find(info.children, EBML_ID.Duration)!;
    expect(new DataView(b.buffer, b.byteOffset + dur.dataStart, 8).getFloat64(0)).toBeCloseTo(2066.7, 6);
    const entry = find(find(seg.children, EBML_ID.Tracks)!.children, EBML_ID.TrackEntry)!;
    expect(str(b, find(entry.children, EBML_ID.CodecID)!)).toBe("V_VP9");
    expect(uint(b, find(entry.children, EBML_ID.TrackType)!)).toBe(1);
    expect(uint(b, find(entry.children, EBML_ID.DefaultDuration)!)).toBe(33333333);
    const video = find(entry.children, EBML_ID.Video)!;
    expect(uint(b, find(video.children, EBML_ID.PixelWidth)!)).toBe(320);
    expect(uint(b, find(video.children, EBML_ID.PixelHeight)!)).toBe(180);
  });

  it("un cluster par image clé, blocs relatifs, Cues vers les clusters", () => {
    const b = build("V_VP8").finish();
    const seg = parse(b)[1];
    const clusters = all(seg.children, EBML_ID.Cluster);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => uint(b, find(c.children, EBML_ID.Timecode)!))).toEqual([0, 2000]);
    const blocks = all(clusters[0].children, EBML_ID.SimpleBlock);
    expect(blocks.map((n) => hex(b.subarray(n.dataStart, n.dataStart + 4)))).toEqual([
      "81 00 00 80", "81 00 21 00", "81 00 43 00",
    ]);
    expect(hex(b.subarray(blocks[0].dataStart + 4, blocks[0].dataStart + blocks[0].size))).toBe("01 01 01");
    const second = all(clusters[1].children, EBML_ID.SimpleBlock);
    expect(hex(b.subarray(second[1].dataStart, second[1].dataStart + 4))).toBe("81 00 21 00");
    const points = all(find(seg.children, EBML_ID.Cues)!.children, EBML_ID.CuePoint);
    expect(points).toHaveLength(2);
    points.forEach((p, i) => {
      const pos = find(p.children, EBML_ID.CueTrackPositions)!;
      const rel = uint(b, find(pos.children, EBML_ID.CueClusterPosition)!);
      expect(seg.dataStart + rel).toBe(clusters[i].start);
      expect(uint(b, find(p.children, EBML_ID.CueTime)!)).toBe([0, 2000][i]);
    });
  });

  it("durée par défaut : dernière image + une image ; morceaux = fichier entier", () => {
    const m = build();
    const parts = m.finishParts();
    const total = parts.reduce((a, p) => a + p.length, 0);
    const b = m.finish();
    expect(total).toBe(b.length);
    const info = find(parse(b)[1].children, EBML_ID.Info)!;
    const dur = find(info.children, EBML_ID.Duration)!;
    expect(new DataView(b.buffer, b.byteOffset + dur.dataStart, 8).getFloat64(0)).toBeCloseTo(2033 + 1000 / 30, 6);
  });

  it("nouveau cluster au-delà de 30 s sans image clé ; première image clé exigée ; plafond de taille", () => {
    const m = new WebmMuxer({ codec: "V_VP9", width: 2, height: 2 });
    expect(() => m.add(new Uint8Array([1]), 0, false)).toThrow(/image clé/);
    m.add(new Uint8Array([1]), 0, true);
    m.add(new Uint8Array([1]), 31000, false);
    expect(all(parse(m.finish())[1].children, EBML_ID.Cluster)).toHaveLength(2);
    const small = new WebmMuxer({ codec: "V_VP9", width: 2, height: 2, maxBytes: 20 });
    small.add(new Uint8Array(8), 0, true);
    expect(() => small.add(new Uint8Array(8), 33, false)).toThrow(/taille maximale/);
    expect(small.frames).toBe(1);
  });
});

describe("piste audio Opus", () => {
  const OPUS_HEAD_2CH = "4f 70 75 73 48 65 61 64 01 02 38 01 80 bb 00 00 00 00 00";

  it("OpusHead (RFC 7845) : magique, version, canaux, pre-skip et fréquence petit-boutistes", () => {
    expect(hex(opusHead(2, 48000))).toBe(OPUS_HEAD_2CH);
    expect(hex(opusHead(1, 44100, 3840))).toBe("4f 70 75 73 48 65 61 64 01 01 00 0f 44 ac 00 00 00 00 00");
    expect(opusPreSkip(opusHead(1, 44100, 3840))).toBe(3840);
    expect(opusPreSkip(new Uint8Array(19))).toBeNull();
    expect(() => opusHead(6, 48000)).toThrow(/canaux/);
  });

  it("TrackEntry A_OPUS octet par octet (OpusHead construit)", () => {
    const m = new WebmMuxer({ codec: "V_VP9", width: 320, height: 180, audio: { channels: 2, inputRate: 48000 } });
    m.add(new Uint8Array([1]), 0, true);
    m.addAudio(new Uint8Array([0xaa]), 0);
    const b = m.finish();
    const entries = all(find(parse(b)[1].children, EBML_ID.Tracks)!.children, EBML_ID.TrackEntry);
    expect(entries).toHaveLength(2);
    const a = entries[1];
    expect(hex(b.subarray(a.start, a.dataStart + a.size))).toBe(
      [
        "ae c7",
        "d7 81 02", // TrackNumber 2
        "73 c5 81 02", // TrackUID 2
        "83 81 02", // TrackType audio
        "9c 81 00", // FlagLacing 0
        "86 86 41 5f 4f 50 55 53", // CodecID A_OPUS
        `63 a2 93 ${OPUS_HEAD_2CH}`, // CodecPrivate
        "56 aa 83 63 2e a0", // CodecDelay 312 / 48000 s = 6 500 000 ns
        "56 bb 84 04 c4 b4 00", // SeekPreRoll 80 ms
        "e1 8d b5 88 40 e7 70 00 00 00 00 00 9f 81 02", // Audio { SamplingFrequency 48000, Channels 2 }
      ].join(" "),
    );
  });

  it("OpusHead de l'encodeur repris tel quel : canaux et CodecDelay lus dedans", () => {
    const m = new WebmMuxer({ codec: "V_VP8", width: 2, height: 2, audio: { channels: 2, inputRate: 48000 } });
    m.setAudioCodecPrivate(opusHead(1, 44100, 3840));
    m.add(new Uint8Array([1]), 0, true);
    m.addAudio(new Uint8Array([2]), 0);
    const b = m.finish();
    const a = all(find(parse(b)[1].children, EBML_ID.Tracks)!.children, EBML_ID.TrackEntry)[1];
    const priv = find(a.children, EBML_ID.CodecPrivate)!;
    expect(hex(b.subarray(priv.dataStart, priv.dataStart + priv.size))).toBe(hex(opusHead(1, 44100, 3840)));
    expect(uint(b, find(a.children, EBML_ID.CodecDelay)!)).toBe(80_000_000);
    const audio = find(a.children, EBML_ID.Audio)!;
    expect(uint(b, find(audio.children, EBML_ID.Channels)!)).toBe(1);
  });

  it("blocs audio et vidéo entrelacés par temps dans les clusters, Cues sur la vidéo seulement", () => {
    const m = new WebmMuxer({ codec: "V_VP9", width: 320, height: 180, frameMs: 1000 / 30, audio: { channels: 2, inputRate: 48000 } });
    // Ordre d'arrivée des deux encodeurs : différent de l'ordre des temps.
    m.add(new Uint8Array([0x10]), 0, true);
    m.add(new Uint8Array([0x11]), 33.3, false);
    m.addAudio(new Uint8Array([0xa0]), 10);
    m.addAudio(new Uint8Array([0xa1]), 30);
    m.add(new Uint8Array([0x12]), 66.7, false);
    m.addAudio(new Uint8Array([0xa2]), 50);
    m.add(new Uint8Array([0x20]), 2000, true);
    m.addAudio(new Uint8Array([0xa3]), 2010);
    m.addAudio(new Uint8Array([0xa4]), 1990);
    expect(m.frames).toBe(4);
    expect(m.audioPackets).toBe(5);
    const b = m.finish();
    const seg = parse(b)[1];
    const clusters = all(seg.children, EBML_ID.Cluster);
    expect(clusters.map((c) => uint(b, find(c.children, EBML_ID.Timecode)!))).toEqual([0, 2000]);
    const blocks = (c: Node) => all(c.children, EBML_ID.SimpleBlock).map((n) => hex(b.subarray(n.dataStart, n.dataStart + n.size)));
    expect(blocks(clusters[0])).toEqual([
      "81 00 00 80 10", // vidéo 0 ms, image clé
      "82 00 0a 80 a0", // audio 10 ms (paquets Opus : toujours « clé »)
      "82 00 1e 80 a1", // audio 30 ms
      "81 00 21 00 11", // vidéo 33 ms
      "82 00 32 80 a2", // audio 50 ms
      "81 00 43 00 12", // vidéo 67 ms
      "82 07 c6 80 a4", // audio 1990 ms : avant l'image clé suivante
    ]);
    expect(blocks(clusters[1])).toEqual(["81 00 00 80 20", "82 00 0a 80 a3"]);
    const points = all(find(seg.children, EBML_ID.Cues)!.children, EBML_ID.CuePoint);
    expect(points.map((p) => uint(b, find(p.children, EBML_ID.CueTime)!))).toEqual([0, 2000]);
    expect(points.map((p) => uint(b, find(find(p.children, EBML_ID.CueTrackPositions)!.children, EBML_ID.CueTrack)!))).toEqual([1, 1]);
  });

  it("piste audio absente sans paquet ; addAudio sans piste déclarée ; plafond compté avec l'audio", () => {
    const m = new WebmMuxer({ codec: "V_VP9", width: 2, height: 2, audio: { channels: 2, inputRate: 48000 } });
    m.add(new Uint8Array([1]), 0, true);
    expect(all(find(parse(m.finish())[1].children, EBML_ID.Tracks)!.children, EBML_ID.TrackEntry)).toHaveLength(1);
    const v = new WebmMuxer({ codec: "V_VP9", width: 2, height: 2 });
    expect(() => v.addAudio(new Uint8Array([1]), 0)).toThrow(/audio/);
    const small = new WebmMuxer({ codec: "V_VP9", width: 2, height: 2, maxBytes: 20, audio: { channels: 2, inputRate: 48000 } });
    small.add(new Uint8Array(8), 0, true); // 14 octets
    expect(small.size).toBe(14);
    expect(() => small.addAudio(new Uint8Array(8), 5)).toThrow(/taille maximale/);
    expect(small.audioPackets).toBe(0);
  });
});
