import { describe, expect, it } from "vitest";
import { AMBIANCES } from "../../../shared/monde/ambiance";
import { Issues } from "../core/schema";
import { MAX_POST } from "../render/post";
import { ambianceFx, ambianceStyle, ambianceTokens, skyTopFrom } from "./ambiance";
import { DEFAULT_STYLE, resolveColors, resolveStyle } from "./style";

const fxs = (s: { post: { fx: string }[] }) => s.post.map((f) => f.fx);

describe("ambiances (procgen)", () => {
  it("chaque ambiance du format monde se résout sans erreur, pile bornée, sans grain animé", () => {
    for (const name of Object.keys(AMBIANCES)) {
      const issues = new Issues();
      const s = resolveStyle({ ambiance: name }, issues);
      expect(issues.list, name).toEqual([]);
      expect(s.ambiance).toBe(name);
      expect(s.post.length, name).toBeLessThanOrEqual(MAX_POST);
      // rendu à la demande : le grain de l'ambiance est figé dans la pile
      expect(s.grain, name).toBe(0);
    }
  });

  it("une ambiance règle lumière, ciel, brume, palette, finis et étalonnage d'un mot", () => {
    const s = resolveStyle({ ambiance: "cyber" });
    expect(s.skyHorizon).toBe("#07060f");
    expect(s.sunColor).toBe("#ff5fd0");
    expect(s.lightElevation).toBe(25);
    expect(s.fog).toBeCloseTo(0.1 + 0.35 * 2.1, 5);
    expect(s.roles.road ?? s.roles.ground).toBeTruthy();
    expect(s.finishes.metal?.metal).toBe(1); // chrome
    expect(s.finishes.wall?.clear).toBe(1); // laque, fini par défaut des pièces fabriquées
    expect(fxs(s)).toEqual(["couleur", "bloom", "neon", "aberration", "crt", "grain"]);
    expect(s.meteo).toEqual(["pluie"]);
    const c = resolveColors(s);
    // ciel d'horizon presque noir
    expect(Math.max(...c.skyHorizon)).toBeLessThan(0.01);
  });

  it("peinture, silhouettes, pixels, sépia : effets propres", () => {
    expect(fxs(resolveStyle({ ambiance: "tableau" }))[0]).toBe("kuwahara-aniso");
    expect(fxs(resolveStyle({ ambiance: "silhouette" }))).toContain("silhouette");
    const v = resolveStyle({ ambiance: "voxel" });
    expect(v.pixel).toBe(4);
    expect(fxs(v)).toContain("niveaux");
    expect(fxs(resolveStyle({ ambiance: "western" }))).toContain("sepia");
    // contour sombre : contours du style (encre), pas de néon
    const bd = resolveStyle({ ambiance: "cartoon" });
    expect(fxs(bd)).not.toContain("neon");
    expect(bd.outlineStrength).toBeCloseTo(0.9, 5);
    expect(bd.roles.ink).toBe("#1c1c28");
  });

  it("alias, objet {base, …}, météo réglable", () => {
    expect(resolveStyle({ ambiance: "cyberpunk" }).ambiance).toBe("cyber");
    const s = resolveStyle({ ambiance: { base: "realiste", ciel: "#ffcc88", lumiere: { hauteur: 10 }, meteo: "neige" } });
    expect(s.skyHorizon).toBe("#ffcc88");
    expect(s.lightElevation).toBe(10);
    expect(s.meteo).toEqual(["neige"]);
    expect(resolveStyle({ ambiance: { base: "cyber", meteo: false } }).meteo).toEqual([]);
  });

  it("ce qui est écrit l'emporte ; la pile écrite suit l'étalonnage", () => {
    const s = resolveStyle({ ambiance: "noir", lightIntensity: 0.5, post: [{ fx: "vignette" }] });
    expect(s.lightIntensity).toBe(0.5);
    expect(fxs(s).at(-1)).toBe("vignette");
    expect(fxs(s)[0]).toBe("couleur");
    // préréglage écrit par-dessus l'ambiance
    const p = resolveStyle({ ambiance: "realiste", preset: "nuit" });
    expect(p.night).toBe(1);
    expect(p.skyHorizon).toBe("#c9d6df");
  });

  it("ambiance inconnue : signalée, style normal", () => {
    const issues = new Issues();
    const s = resolveStyle({ ambiance: "steampunk", preset: "doux" }, issues);
    expect(issues.list.some((i) => i.path === "style.ambiance")).toBe(true);
    expect(s.ambiance).toBe("");
    expect(s.shading).toBe("soft");
  });

  it("sans ambiance : rien ne change (rétrocompatibilité)", () => {
    const s = resolveStyle("gouache");
    expect(s.skyHorizon).toBe("");
    expect(s.meteo).toEqual([]);
    expect(s.environment).toBe(DEFAULT_STYLE.environment);
    expect(resolveColors(s).skyTop).toEqual(resolveColors(resolveStyle({})).skyTop);
  });

  it("jetons purs : ciel dérivé, intensité ramenée", () => {
    expect(skyTopFrom("#c9d6df")).toMatch(/^#[0-9a-f]{6}$/);
    const t = ambianceTokens(ambianceStyle("noir", () => {}) ? { ...AMBIANCES.noir, name: "noir" } : ({} as never));
    expect(t.lightIntensity).toBeCloseTo(3 / 1.6, 3);
    expect(ambianceStyle("", () => {})).toBeNull();
  });

  it("météo d'ambiance : posée seulement là où la scène n'écrit rien", () => {
    expect(ambianceFx(["pluie"], {})).toEqual({ weather: "pluie" });
    expect(ambianceFx(["pluie"], { weather: "snow" })).toEqual({});
    expect(ambianceFx(["brume"], {})).toEqual({ mist: 1 });
    expect(ambianceFx(["brume"], { mist: 0 })).toEqual({});
    expect(ambianceFx([], {})).toEqual({});
  });
});
