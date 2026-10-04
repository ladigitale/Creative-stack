import { describe, expect, it } from "vitest";
import {
  clampPostScale,
  parsePostChannelSource,
} from "./post-channels";

describe("parsePostChannelSource", () => {
  it("défaut ch0 = scene", () => {
    expect(parsePostChannelSource("", "", 0)).toEqual({ kind: "scene" });
    expect(parsePostChannelSource("", "", 1)).toEqual({ kind: "none" });
  });

  it("depth / buffers / url / #id", () => {
    expect(parsePostChannelSource("depth", "", 0)).toEqual({ kind: "depth" });
    expect(parsePostChannelSource("buffer-a", "", 0)).toEqual({
      kind: "buffer",
      buffer: "bufferA",
    });
    expect(parsePostChannelSource("/tex.png", "", 0)).toEqual({
      kind: "url",
      url: "/tex.png",
    });
    expect(parsePostChannelSource("#ref", "", 0)).toEqual({
      kind: "element",
      key: "#ref",
    });
  });
});

describe("clampPostScale", () => {
  it("borne 0.25–1", () => {
    expect(clampPostScale(2)).toBe(1);
    expect(clampPostScale(0.1)).toBe(0.25);
    expect(clampPostScale(0.5)).toBe(0.5);
  });
});
