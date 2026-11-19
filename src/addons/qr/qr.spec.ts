import { describe, expect, it } from "vitest";
import { encode } from "uqr";
import { MAX_QR_TEXT, qrMatrix, qrPath, safeHref, sanitizeEcc } from "./core";

describe("qrMatrix", () => {
  it("vide → null, trop long → erreur", () => {
    expect(qrMatrix("")).toBeNull();
    expect(() => qrMatrix("x".repeat(MAX_QR_TEXT + 1))).toThrow(/trop long/);
  });
  it("taille selon la version, motifs de position aux trois coins", () => {
    const m = qrMatrix("https://artifacts.tadaaa.space/regie?run=0190&wt=abc", "M")!;
    expect(m.size).toBe(17 + 4 * m.version);
    for (const [x, y] of [[0, 0], [m.size - 7, 0], [0, m.size - 7]]) {
      // Carré de 7 modules : bord noir, anneau blanc, cœur noir 3×3.
      expect(m.modules[y][x]).toBe(true);
      expect(m.modules[y + 1][x + 1]).toBe(false);
      expect(m.modules[y + 3][x + 3]).toBe(true);
    }
  });
  it("UTF-8 : un texte accentué passe en octets", () => {
    const m = qrMatrix("Régie en direct ✨", "L")!;
    const ref = encode(Array.from(new TextEncoder().encode("Régie en direct ✨")), { ecc: "L", border: 0 });
    expect(m.modules).toEqual(ref.data);
  });
  it("ecc plus haut = code plus dense", () => {
    const t = "https://artifacts.tadaaa.space/x?run=01a1f263-0704-75ef-98e6-54b204e04797";
    expect(qrMatrix(t, "H")!.version).toBeGreaterThanOrEqual(qrMatrix(t, "L")!.version);
  });
});

describe("qrPath", () => {
  it("un rectangle par suite de modules noirs, décalé de la marge", () => {
    const m = { size: 3, version: 1, modules: [[true, true, false], [false, false, false], [true, false, true]] };
    expect(qrPath(m, 2)).toBe("M2 2h2v1h-2zM2 4h1v1h-1zM4 4h1v1h-1z");
  });
  it("couvre exactement les modules noirs", () => {
    const m = qrMatrix("bonjour")!;
    const dark = m.modules.flat().filter(Boolean).length;
    const area = [...qrPath(m, 0).matchAll(/h(\d+)v1/g)].reduce((s, x) => s + Number(x[1]), 0);
    expect(area).toBe(dark);
  });
});

describe("garde-fous", () => {
  it("lien seulement en http(s)", () => {
    expect(safeHref("https://a.b/c")).toBe("https://a.b/c");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("ABC-123")).toBeNull();
  });
  it("ecc", () => {
    expect(sanitizeEcc("h")).toBe("H");
    expect(sanitizeEcc("z")).toBe("M");
    expect(sanitizeEcc(undefined, "Q")).toBe("Q");
  });
});
