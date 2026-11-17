import { describe, expect, it } from "vitest";
import { Issues } from "../core/schema";
import { resolveStyle } from "../style/style";
import { MAX_POST, POST_FX, POST_FX_IDS, POST_PALETTES, POST_PRESETS, inkSeparation, invert, packFx, planPasses, postAnimated, resolvePost } from "./post";
import { FX_GLSL, HELPERS, passFragment } from "./postglsl";
import manifest from "../manifest.json";

const fnName = (id: string) => "fx_" + id.replace(/-/g, "_");
const noComments = (s: string) => s.replace(/\/\/.*$/gm, "");

describe("procgen : pile de post-traitement — validation", () => {
  it("le manifeste cite chaque effet et chaque préréglage", () => {
    const d = manifest.components[0].description;
    for (const k of [...POST_FX_IDS, ...Object.keys(POST_PRESETS)]) expect(d).toContain(k);
  });

  it("vide, absent, « none » : aucune passe", () => {
    for (const v of [undefined, null, false, "", "none", []]) expect(resolvePost(v)).toEqual([]);
    expect(resolveStyle("gouache").post).toEqual([]);
  });

  it("chaque effet a ses défauts, son code GLSL et des uniformes de la bonne taille", () => {
    for (const id of POST_FX_IDS) {
      const [f] = resolvePost([{ fx: id }]);
      expect(f.fx).toBe(id);
      expect(f.mix).toBe(1);
      const { F, M } = packFx(f);
      expect(F.length).toBe(POST_FX[id].slots * 4);
      expect(F.every(Number.isFinite)).toBe(true);
      expect(M.length).toBe(8);
      const src = FX_GLSL[id];
      expect(src, id).toBeTruthy();
      const aux = POST_FX[id].aux ? ", sampler2D A)" : ")";
      expect(src).toContain(`vec3 ${fnName(id)}(vec2 uv, vec3 `);
      expect(src).toContain(`vec4 P[${POST_FX[id].slots}]${aux}`);
      expect(src).not.toMatch(/iChannel|mainImage/);
    }
  });

  it("réglages bornés, inconnus et types signalés", () => {
    const is = new Issues();
    const [f] = resolvePost([{ fx: "kuwahara-aniso", radius: 99, sectors: 5, levels: 3.6, pattern: "bleu", couleur: 1, mix: 3 }], is);
    expect(f.params.radius).toBe(12);
    expect(f.params.levels).toBe(4);
    expect(f.params.pattern).toBe("bayer");
    expect(f.mix).toBe(1);
    const codes = is.list.map((i) => `${i.path}:${i.code}`);
    expect(codes).toContain("style.post.0.radius:clamped");
    expect(codes).toContain("style.post.0.pattern:unknown");
    expect(codes).toContain("style.post.0.couleur:unknown");
    expect(codes).toContain("style.post.0.mix:clamped");
    const is2 = new Issues();
    resolvePost([{ fx: "kuwahra" }, { fx: "bichromie", ink: "rouge", contrast: "fort" }], is2);
    expect(is2.list.find((i) => i.path === "style.post.0.fx")?.didYouMean).toBe("kuwahara");
    expect(is2.list.map((i) => i.path)).toEqual(expect.arrayContaining(["style.post.1.ink", "style.post.1.contrast"]));
  });

  it("couleurs : hexadécimal court, noms d'encres Riso, palettes nommées, bornes de longueur", () => {
    const is = new Issues();
    const [r, d, p] = resolvePost([{ fx: "riso", inks: ["rose", "#0af", "jaune", "vert"] }, { fx: "degrade", stops: "menthe" }, { fx: "palette", colors: ["#000"] }], is);
    expect(r.params.inks).toEqual(["#ff48b0", "#00aaff", "#ffe800"]);
    expect(d.params.stops).toEqual(POST_PALETTES.menthe);
    expect((p.params.colors as string[]).length).toBe(2);
    expect(is.list.map((i) => i.code)).toEqual(expect.arrayContaining(["limit"]));
  });

  it("masques : profondeur, plage, objets, ciel ; inconnus signalés", () => {
    const is = new Issues();
    const fs = resolvePost([{ fx: "grain", mask: "near" }, { fx: "grain", mask: "sky" }, { fx: "grain", mask: { from: 2, to: 0.5, soft: 0.3 } }, { fx: "grain", mask: { from: 1.5, invert: true } }, { fx: "grain", mask: "objets" }, { fx: "grain", mask: "dessus" }], is);
    expect(fs.map((f) => f.mask.mode)).toEqual([1, 5, 3, 2, 4, 0]);
    expect(fs[2].mask).toMatchObject({ a: 0.5, b: 2, soft: 0.3 });
    expect(fs[3].mask.invert).toBe(true);
    expect(is.list.some((i) => i.path === "style.post.5.mask" && i.code === "unknown")).toBe(true);
  });

  it("préréglages : par nom, en liste, avec surcharges ; tous valides et sous la limite", () => {
    for (const [name, pr] of Object.entries(POST_PRESETS)) {
      const is = new Issues();
      const fs = resolvePost(name, is);
      expect(is.list, name).toEqual([]);
      expect(fs.length).toBe(pr.fx.length);
      expect(fs.length).toBeLessThanOrEqual(MAX_POST);
    }
    const fs = resolvePost([{ preset: "riso", mix: 0.5, misregister: 4 }, "vignette"]);
    expect(fs.map((f) => f.fx)).toEqual(["couleur", "riso", "vignette"]);
    expect(fs[1].mix).toBe(0.5);
    expect(fs[1].params.misregister).toBe(4);
    const is = new Issues();
    resolvePost({ preset: "riso", inconnu: 1 }, is);
    expect(is.list[0].path).toBe("style.post.preset.inconnu");
    expect(resolvePost("ris", new Issues())).toEqual([]);
  });

  it(`au plus ${MAX_POST} effets (préréglages développés)`, () => {
    const is = new Issues();
    const fs = resolvePost(["argentique", "argentique"], is);
    expect(fs.length).toBe(MAX_POST);
    expect(is.list.some((i) => i.code === "limit")).toBe(true);
  });

  it("rétrocompatibilité : le jeton `pixel` reste celui du rendu basse résolution ; `pixel` est aussi un effet", () => {
    const s = resolveStyle({ pixel: 4 });
    expect(s.pixel).toBe(4);
    expect(s.post).toEqual([]);
    expect(resolveStyle("pixel").pixel).toBe(4);
    const s2 = resolveStyle({ preset: "pixel", post: [{ fx: "pixel", size: 6 }, "1bit"] });
    expect(s2.pixel).toBe(4);
    expect(s2.post.map((f) => f.fx)).toEqual(["pixel", "couleur", "1bit"]);
    const is = new Issues();
    resolveStyle({ post: "gameboy", postQuality: "ultra" }, is);
    expect(is.list.map((i) => i.path)).toEqual(["style.postQuality"]);
  });

  it("effets animés : rendu continu seulement s'il le faut", () => {
    expect(postAnimated(resolvePost("riso"))).toBe(false);
    expect(postAnimated(resolvePost([{ fx: "grain", animated: true }]))).toBe(true);
    expect(postAnimated(resolvePost([{ fx: "glitch", speed: 1 }]))).toBe(true);
  });
});

describe("procgen : pile de post-traitement — séparation d'encres", () => {
  it("inverse de Gauss–Jordan", () => {
    const m = [[2, 1, 0], [1, 3, 1], [0, 1, 4]];
    const inv = invert(m);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(m[i].reduce((s, v, k) => s + v * inv[k][j], 0)).toBeCloseTo(i === j ? 1 : 0, 9);
  });

  it("une couleur faite des encres est retrouvée (projection sur les absorbances)", () => {
    const { rows, absorb } = inkSeparation(["#e63946", "#2a9d8f", "#264653"], "#ffffff");
    const k = [0.3, 0.6, 0.2];
    const A = [0, 1, 2].map((c) => k.reduce((s, kk, i) => s + kk * absorb[i][c], 0));
    const back = rows.map((r) => r[0] * A[0] + r[1] * A[1] + r[2] * A[2]);
    back.forEach((v, i) => expect(v).toBeCloseTo(k[i], 2));
    // deux encres : troisième plaque nulle
    const two = inkSeparation(["#ff48b0", "#0078bf"], "#f7f2e8");
    expect(two.rows[2]).toEqual([0, 0, 0]);
    expect(two.rows[0].every(Number.isFinite)).toBe(true);
  });
});

describe("procgen : pile de post-traitement — passes et shaders", () => {
  it("effets ponctuels fusionnés derrière un effet de voisinage ; passes annexes en tête", () => {
    const fs = resolvePost(["couleur", { fx: "bichromie" }, { fx: "kuwahara-aniso" }, "grain", "vignette", "bloom", { fx: "cyanotype" }]);
    const plan = planPasses(fs, false);
    expect(plan.map((p) => p.stages.map((s) => s.fx))).toEqual([["couleur", "bichromie"], ["kuwahara-aniso", "grain", "vignette"], ["bloom", "cyanotype"]]);
    expect(plan[1].aux).toEqual({ kind: "tensor", index: 2 });
    expect(plan[2].aux?.kind).toBe("blur");
    expect(plan.every((p) => p.scale === 1)).toBe(true);
    expect(planPasses(fs, true)[1].scale).toBe(0.5);
    expect(new Set(plan.map((p) => p.key)).size).toBe(3);
  });

  it("budget d'uniformes : six palettes de 16 couleurs ne tiennent pas dans une passe", () => {
    const plan = planPasses(resolvePost(["couleur", ...Array.from({ length: 6 }, () => ({ fx: "palette" }))]), false);
    expect(plan.length).toBeGreaterThan(1);
    for (const p of plan) expect(p.stages.reduce((s, st) => s + POST_FX[st.fx].slots + 2, 0)).toBeLessThanOrEqual(180);
  });

  it("le fragment d'une passe déclare ses uniformes, inclut ses fonctions et rien d'autre", () => {
    const plan = planPasses(resolvePost(["kuwahara-aniso", "grain", "neon"]), false);
    const fs = passFragment(plan[0]);
    expect(fs).toContain("uniform vec4 uF0[2];");
    expect(fs).toContain("uniform vec4 uF1[1];");
    expect(fs).toContain("uniform sampler2D tAux;");
    expect(fs).toContain("fx_kuwahara_aniso(uv, c, uF0, tAux)");
    expect(fs).toContain("fx_grain(uv, c, uF1)");
    expect(fs).toContain("vec3 kaTap(");
    expect(fs).not.toContain("fx_neon");
    expect(fs).not.toContain("geoEdge");
    const fs2 = passFragment(plan[1]);
    expect(fs2).toContain("vec2 geoEdge(");
    expect(fs2).not.toContain("tAux");
    // syntaxe : accolades et parenthèses équilibrées, pas de code dynamique
    for (const src of [fs, fs2, HELPERS].map(noComments)) {
      expect(src.split("{").length).toBe(src.split("}").length);
      expect(src.split("(").length).toBe(src.split(")").length);
    }
    for (const p of planPasses(resolvePost(POST_FX_IDS.slice(0, 8)), false)) {
      const s = noComments(passFragment(p));
      expect(s.split("{").length).toBe(s.split("}").length);
    }
  });

  it("toutes les fonctions GLSL : accolades équilibrées, une seule définition par nom", () => {
    for (const [id, s0] of Object.entries(FX_GLSL)) {
      const src = noComments(s0);
      expect(src.split("{").length, id).toBe(src.split("}").length);
      expect(src.split("(").length, id).toBe(src.split(")").length);
      expect(src.match(new RegExp(`vec3 ${fnName(id)}\\(`, "g"))?.length, id).toBe(1);
    }
  });
});
