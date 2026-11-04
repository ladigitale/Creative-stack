import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import library from "./library/library.json";

type Entry = (typeof library)["entries"][number];

const source = (e: Entry) => readFileSync(`src/addons/shader/library/${e.file}`, "utf8");

describe("bibliothèque de shaders de base", () => {
  it("ids uniques, versions entières, fichiers présents avec mainImage", () => {
    const ids = library.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of library.entries) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(Number.isInteger(e.version) && e.version >= 1).toBe(true);
      expect(source(e)).toMatch(/void\s+mainImage\s*\(/);
    }
  });

  it("au plus 4 réglages uParam0..3, utilisés par le source, valeur par défaut dans l'intervalle", () => {
    for (const e of library.entries) {
      expect(e.params.length).toBeLessThanOrEqual(4);
      e.params.forEach((p, i) => {
        expect(p.name).toBe(`uParam${i}`);
        expect(source(e)).toContain(p.name);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
      });
      // Aucun réglage utilisé sans être déclaré.
      for (const m of source(e).matchAll(/uParam([0-3])/g)) expect(e.params.some((p) => p.name === `uParam${m[1]}`)).toBe(true);
    }
  });

  it("un shader qui lit iChannel0 le déclare dans `channels`", () => {
    for (const e of library.entries) if (/iChannel0/.test(source(e))) expect(e.channels.length).toBeGreaterThan(0);
  });

  it("contrôles statiques (pas de compilateur GLSL en test) : parenthèses équilibrées, pas de #version, smoothstep croissant, boucles à bornes constantes", () => {
    for (const e of library.entries) {
      const src = source(e).replace(/\/\/.*$/gm, "");
      for (const [open, close] of [["(", ")"], ["{", "}"], ["[", "]"]]) {
        expect(src.split(open).length, `${e.id} ${open}${close}`).toBe(src.split(close).length);
      }
      expect(src).not.toMatch(/#version/);
      for (const m of src.matchAll(/smoothstep\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,/g)) expect(Number(m[1]), `${e.id} smoothstep`).toBeLessThan(Number(m[2]));
      for (const m of src.matchAll(/for\s*\([^;]*;[^;]*<=?\s*([^;]+);/g)) expect(m[1].trim(), `${e.id} borne de boucle`).toMatch(/^-?\d+$/);
    }
  });
});
