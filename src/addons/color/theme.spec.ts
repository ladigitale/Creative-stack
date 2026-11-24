import { describe, expect, it } from "vitest";
import { isSafeVar } from "../interactive";
import { contrastRatio, deriveTheme, sanitizeMode, THEME_RULES } from "./theme";

const SAMPLE_BASES = ["#000000", "#ffffff", "#808080", "#150a2e", "#fff7ee", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#c2410c", "#0f766e", "#1e3a8a", "#fde68a", "#e0f2fe", "#7f1d1d", "#fafafa", "#101010"];

describe("deriveTheme : lisibilité garantie, quel que soit le fond choisi", () => {
  for (const mode of ["dark", "light"] as const) {
    for (const rule of THEME_RULES) {
      it(`${mode} / ${rule} : contrastes sur ${SAMPLE_BASES.length} fonds`, () => {
        for (const b of SAMPLE_BASES) {
          const t = deriveTheme({ base: b, mode, rule });
          const v = t.vars;
          expect(t.mode, b).toBe(mode);
          expect(contrastRatio(v["--sc-base-content"], v["--sc-base"]), `texte ${b}`).toBeGreaterThanOrEqual(7);
          expect(contrastRatio(v["--sc-primary"], v["--sc-base"]), `accent ${b}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(v["--sc-secondary"], v["--sc-base"]), `accent 2 ${b}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(v["--sc-primary-content"], v["--sc-primary"]), `texte d'accent ${b}`).toBeGreaterThanOrEqual(4.5);
          for (const s of ["info", "success", "warning", "danger"]) {
            expect(contrastRatio(v[`--sc-${s}`], v["--sc-base"]), `${s} ${b}`).toBeGreaterThanOrEqual(3);
            expect(contrastRatio(v[`--sc-${s}-content`], v[`--sc-${s}`]), `texte ${s} ${b}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });
    }
  }

  it("le fond est ramené dans la plage du mode (un fond blanc en sombre reste sombre)", () => {
    const d = deriveTheme({ base: "#ffffff", mode: "dark" });
    const l = deriveTheme({ base: "#000000", mode: "light" });
    expect(contrastRatio(d.base, "#000000")).toBeLessThan(2);
    expect(contrastRatio(l.base, "#ffffff")).toBeLessThan(1.3);
  });

  it("garde la teinte choisie et ne sature pas le fond", () => {
    const t = deriveTheme({ base: "#ff0000", mode: "dark" });
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(t.base.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    expect(r).toBeLessThan(110);
  });

  it("mode déduit de la clarté du fond, fonds par défaut sans base", () => {
    expect(deriveTheme({ base: "#fff7ee" }).mode).toBe("light");
    expect(deriveTheme({ base: "#150a2e" }).mode).toBe("dark");
    expect(deriveTheme({ mode: "clair" }).mode).toBe("light");
    expect(deriveTheme({ base: "n'importe quoi", mode: "sombre" }).mode).toBe("dark");
    expect(sanitizeMode("Sombre")).toBe("dark");
    expect(sanitizeMode("x")).toBeUndefined();
  });

  it("échelle du fond vers le texte, sortie stable", () => {
    const t = deriveTheme({ base: "#150a2e", mode: "dark" });
    const lum = (k: string) => contrastRatio(t.vars[k], t.vars["--sc-base"]);
    const steps = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"].map((n) => lum(`--sc-base-${n}`));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(JSON.stringify(deriveTheme({ base: "#150a2e", mode: "dark" }))).toBe(JSON.stringify(t));
  });

  it("toutes les variables sont acceptées par sonic-css-vars", () => {
    for (const mode of ["dark", "light"] as const) {
      for (const [k, v] of Object.entries(deriveTheme({ base: "#0f766e", mode }).vars)) expect(isSafeVar(k, v), `${k}: ${v}`).toBe(true);
    }
  });
});
