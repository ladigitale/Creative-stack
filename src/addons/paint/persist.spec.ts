import { describe, expect, it } from "vitest";
import { persistKey, validRecord } from "./persist";

describe("sonic-paint : enregistrement local", () => {
  it("n'accepte que des clés simples", () => {
    expect(persistKey("etiquette-picto")).toBe("etiquette-picto");
    expect(persistKey("  a.b_c-1 ")).toBe("a.b_c-1");
    expect(persistKey("")).toBe("");
    expect(persistKey("a/b")).toBe("");
    expect(persistKey("x".repeat(65))).toBe("");
    expect(persistKey(12)).toBe("");
  });

  it("vérifie un enregistrement relu avant de le peindre", () => {
    const blob = new Blob(["x"], { type: "image/png" });
    expect(validRecord({ key: "a", blob, width: 76, height: 76, updated: 1 })).toBe(true);
    expect(validRecord({ key: "a", blob: new Blob([]), width: 76, height: 76 })).toBe(false);
    expect(validRecord({ key: "a", blob: "data", width: 76, height: 76 })).toBe(false);
    expect(validRecord({ key: "a", blob, width: 0, height: 76 })).toBe(false);
    expect(validRecord(null)).toBe(false);
  });
});
