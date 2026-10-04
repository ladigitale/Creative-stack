import { describe, expect, it } from "vitest";
import { compileTextExtractor, normalizeInput, realign } from "./hf-input";

const text = { kind: "text" as const, maxItems: 100, maxChars: 50 };

describe("normalizeInput", () => {
  it("entrée absente ou vide → empty (rien à charger)", () => {
    for (const value of [undefined, null, "", "   ", [], {}]) {
      expect(normalizeInput(value, text).kind).toBe("empty");
    }
  });

  it("texte seul", () => {
    const r = normalizeInput("  un spectacle drôle  ", text);
    expect(r).toMatchObject({ kind: "ok", many: false, payloads: ["un spectacle drôle"] });
  });

  it("refuse les nombres et booléens (pas de coercition silencieuse)", () => {
    const r = normalizeInput(42, text);
    expect(r).toMatchObject({ kind: "invalid", code: "invalid-input" });
    if (r.kind === "invalid") expect(r.message).toContain("texte attendu, reçu number");
  });

  it("objet sans options.text → invalid avec un message explicite", () => {
    const r = normalizeInput({ label: "A" }, text);
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.message).toContain("options.text");
  });

  it("liste partiellement valide → positions conservées, sortie alignée", () => {
    const r = normalizeInput(["a", 3, "", "b"], text);
    expect(r).toMatchObject({
      kind: "ok",
      many: true,
      length: 4,
      payloads: ["a", "b"],
      positions: [0, 3],
      skipped: 2,
    });
    if (r.kind !== "ok") throw new Error();
    expect(realign(r, ["A", "B"])).toEqual(["A", null, null, "B"]);
  });

  it("liste entièrement invalide → invalid", () => {
    expect(normalizeInput([1, true], text).kind).toBe("invalid");
  });

  it("trop d'éléments → too-large", () => {
    const r = normalizeInput(["a", "b", "c"], { ...text, maxItems: 2 });
    expect(r).toMatchObject({ kind: "invalid", code: "too-large" });
  });

  it("texte trop long → tronqué et signalé", () => {
    const r = normalizeInput("x".repeat(80), text);
    if (r.kind !== "ok") throw new Error();
    expect((r.payloads[0] as string).length).toBe(50);
    expect(r.truncated).toBe(1);
    expect(r.warnings[0]).toContain("tronqué");
  });

  it("objets + chemins pointés (tableaux aplatis)", () => {
    const events = [
      {
        label: "Pierre et le Loup",
        edito: { sub_title: "Conte musical" },
        categories: [{ title: "Jeune public" }, { title: "Musique" }],
      },
      { label: "Sans catégorie", categories: [] },
      { nope: true },
    ];
    const r = normalizeInput(events, {
      ...text,
      maxChars: 500,
      text: "label + edito.sub_title + categories.title",
    });
    if (r.kind !== "ok") throw new Error(JSON.stringify(r));
    expect(r.payloads).toEqual([
      "Pierre et le Loup — Conte musical — Jeune public, Musique",
      "Sans catégorie",
    ]);
    expect(r.positions).toEqual([0, 1]);
    expect(r.skipped).toBe(1);
  });

  it("extracteur fonction (API TypeScript)", () => {
    const extract = compileTextExtractor((e: unknown) => (e as { t: string }).t.toUpperCase());
    expect(extract?.({ t: "abc" })).toBe("ABC");
  });

  it("images : URL ou Blob ; audio : Float32Array ou URL", () => {
    const image = { kind: "image" as const, maxItems: 10, maxChars: 10 };
    expect(normalizeInput("https://x/y.png", image).kind).toBe("ok");
    expect(normalizeInput(new Blob(["x"]), image).kind).toBe("ok");
    expect(normalizeInput(12, image).kind).toBe("invalid");
    const audio = { kind: "audio" as const, maxItems: 10, maxChars: 10 };
    expect(normalizeInput(new Float32Array([0.1, 0.2]), audio).kind).toBe("ok");
    expect(normalizeInput({ samples: [] }, audio).kind).toBe("invalid");
  });
});
