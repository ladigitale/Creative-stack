import { describe, expect, it } from "vitest";
import { withWebmDuration } from "./webm";

/** WebM minimal façon MediaRecorder : segment de taille inconnue, Info sans Duration, puis un Cluster. */
function sample(segmentKnown = false): Uint8Array {
  const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01];
  const info = [0x15, 0x49, 0xa9, 0x66, 0x84, 0x2a, 0xd7, 0xb1, 0x81 /* taille 1 */].slice(0, 5);
  const infoBody = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]; // TimecodeScale = 1 000 000
  info[4] = 0x80 | infoBody.length;
  const cluster = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0x00];
  const body = [...info, ...infoBody, ...cluster];
  const segSize = segmentKnown ? [0x40 | 0, body.length] : [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  return new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, ...segSize, ...body]);
}

function durationOf(b: Uint8Array): number | null {
  for (let i = 0; i < b.length - 11; i++) {
    if (b[i] === 0x44 && b[i + 1] === 0x89 && b[i + 2] === 0x88) return new DataView(b.buffer, b.byteOffset + i + 3, 8).getFloat64(0);
  }
  return null;
}

describe("withWebmDuration", () => {
  it("ajoute Duration dans Info (segment de taille inconnue)", () => {
    const src = sample();
    const out = withWebmDuration(src, 3250)!;
    expect(out.length).toBe(src.length + 11);
    expect(durationOf(out)).toBe(3250);
    // Taille d'Info mise à jour (7 + 11), cluster intact à la fin.
    const infoAt = out.indexOf(0x15);
    expect(out[infoAt + 4]).toBe(0x80 | 18);
    expect([...out.slice(-3)]).toEqual([0xe7, 0x81, 0x00]);
  });

  it("met à jour la taille d'un segment connu", () => {
    const src = sample(true);
    const out = withWebmDuration(src, 1000)!;
    const segAt = 9 + 4;
    expect(((out[segAt] & 0x3f) << 8) | out[segAt + 1]).toBe(((src[segAt] & 0x3f) << 8) + src[segAt + 1] + 11);
  });

  it("réécrit une durée existante, refuse ce qui n'est pas du WebM", () => {
    const once = withWebmDuration(sample(), 1000)!;
    const twice = withWebmDuration(once, 2000)!;
    expect(twice.length).toBe(once.length);
    expect(durationOf(twice)).toBe(2000);
    expect(withWebmDuration(new Uint8Array([0, 1, 2, 3]), 1000)).toBeNull();
    expect(withWebmDuration(sample(), 0)).toBeNull();
  });
});

import { extensionFor } from "./record";
describe("extensionFor", () => {
  it("déduit l'extension du format", () => {
    expect(["video/webm;codecs=vp9,opus", "audio/webm;codecs=opus", "video/mp4", "audio/mp4", "audio/ogg", "image/jpeg", "image/png", "audio/wav"].map(extensionFor))
      .toEqual(["webm", "webm", "mp4", "m4a", "ogg", "jpg", "png", "wav"]);
  });
});
