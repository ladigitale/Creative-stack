import { describe, expect, it } from "vitest";
import { dataUrlBytes } from "./samples";

describe("dataUrlBytes", () => {
  it("décode une URL data: base64 sans fetch", () => {
    const b = dataUrlBytes("data:audio/wav;base64,UklGRg==");
    expect(b && Array.from(new Uint8Array(b))).toEqual([82, 73, 70, 70]);
  });
  it("décode une URL data: texte", () => {
    const b = dataUrlBytes("data:audio/x-test,a%20b");
    expect(b && Array.from(new Uint8Array(b))).toEqual([97, 32, 98]);
  });
  it("refuse le reste", () => {
    expect(dataUrlBytes("https://x/y.wav")).toBeNull();
    expect(dataUrlBytes("data:audio/wav;base64,%%%")).toBeNull();
  });
});
