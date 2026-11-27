import { beforeAll, describe, expect, it } from "vitest";
import { FONT_IDS, OutlineFont, getFont, getIcon, iconNames, loadTextAssets, textAssetsOf } from "./index";
import { layoutText } from "../core/font";
import { orientRings, slabs, triangulateWithHoles } from "../geom/triangulate";
import { textMesh } from "../geom/text";
import { windingAgreement } from "../geom/geom.spec";
import { composeScene } from "../scene/compose";
import { ROLE } from "../style/roles";

const ALL = FONT_IDS.filter((f) => f !== "procgen");

beforeAll(async () => {
  await loadTextAssets(ALL, true);
}, 60000);

describe("polices et icônes", () => {
  it("toutes chargées, latin accentué complet", () => {
    for (const id of ALL) {
      const f = getFont(id)!;
      expect(f, id).toBeInstanceOf(OutlineFont);
      for (const ch of "AZaz09éèàçÉÀœ€«»’") expect(f.has(ch), `${id} ${ch}`).toBe(true);
      // hauteur de capitale = 1 : le H monte à 1
      const h = f.glyph("H")!;
      expect(Math.max(...h.rings.flat().map((p) => p[1]))).toBeCloseTo(1, 1);
    }
    expect(iconNames().length).toBeGreaterThan(200);
    expect(getIcon("croissant")!.lines.length).toBeGreaterThan(2);
    expect(getIcon("inconnue")).toBeNull();
  });

  it("chaque glyphe se triangule sans perte : aire des triangles = aire du contour moins les trous", () => {
    const bad: string[] = [];
    for (const id of ALL) {
      const f = getFont(id)!;
      for (const ch of Object.keys(f.data.glyphs)) {
        const g = f.glyph(ch)!;
        if (!g.rings.length) continue;
        let want = 0, got = 0;
        for (const { outer, holes } of orientRings(g.rings)) {
          // référence exacte : découpe en tranches (règle non nulle), qui gère aussi les contours qui se chevauchent
          const ref = slabs([outer, ...holes]);
          for (let t = 0; t < ref.tris.length; t += 3) {
            const [a, b, c] = [ref.pts[ref.tris[t]], ref.pts[ref.tris[t + 1]], ref.pts[ref.tris[t + 2]]];
            want += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
          }
          const { pts, tris } = triangulateWithHoles(outer, holes);
          for (let t = 0; t < tris.length; t += 3) {
            const [a, b, c] = [pts[tris[t]], pts[tris[t + 1]], pts[tris[t + 2]]];
            got += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
          }
        }
        if (Math.abs(got - want) > Math.max(0.004, Math.abs(want) * 0.02)) bad.push(`${id}:${ch}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("mise en page : crénage, casse gardée, icônes dans le texte, repli sur la police à traits", () => {
    const av = layoutText("AV", { font: "slab" }).width, a = layoutText("A", { font: "slab" }).width, v = layoutText("V", { font: "slab" }).width;
    expect(av).toBeLessThan(a + v);
    const t = layoutText("Café {coffee} 2", { font: "inter" });
    expect(t.fills.length).toBeGreaterThan(5);
    expect(t.icons.length).toBeGreaterThan(2);
    expect(t.iconHW).toBeGreaterThan(0.03);
    expect(t.polys).toHaveLength(0);
    const fallback = layoutText("Café", { font: "inexistante" });
    expect(fallback.fills).toHaveLength(0);
    expect(fallback.polys.length).toBeGreaterThan(3);
  });

  it("relief : rubans et lettres pleines bien orientés, à la taille demandée", () => {
    for (const font of ["lobster", "fraktur", "pixel", "bebas"]) {
      const m = textMesh("Bonjour {star}", { height: 0.5, maxWidth: 3, role: ROLE.ink, font });
      // police pixel : découpe en tranches, sommets en T (moins d'arêtes partagées pour la mesure)
      expect(windingAgreement(m.mesh), font).toBeGreaterThan(font === "pixel" ? 0.95 : 0.97);
      const b = m.mesh.bounds();
      expect(b.max[0] - b.min[0]).toBeLessThanOrEqual(3.001);
    }
  });

  it("préchargement : ce qu'une recette peut écrire", () => {
    const r = textAssetsOf({ layers: [{ gen: "building", params: { style: "= pick('chateau', 'neon')" } }, { gen: "prop.townsign" }], actors: { a: { params: { shirtText: "Allez {trophy}" } } } });
    expect(r.fonts).toEqual(expect.arrayContaining(["fraktur", "pacifico", "inter", "bangers"]));
    expect(r.icons).toBe(true);
    expect(textAssetsOf({ layers: [{ gen: "tree" }] })).toEqual({ fonts: [], icons: false });
    expect(textAssetsOf({ layers: [{ gen: "prop.billboard", params: { font: "rye" } }] }).fonts).toContain("rye");
  });

  it("scène : enseigne dans la police demandée, maillot imprimé avec icône", { timeout: 60000 }, () => {
    const count = (role: number, meshes: { role: ArrayLike<number>; vertexCount: number }[]) => meshes.reduce((s, m) => s + Array.from(m.role).filter((r) => r === role).length, 0);
    const mk = (font: string) => composeScene({ recipe: { size: [16, 12], layers: [{ id: "b", gen: "building", place: { at: [[0, 0]] }, params: { style: "boutique", floors: 2, sign: "Le Bon Coin", font } }] }, seed: 3 });
    const a = mk("lobster"), b = mk("procgen");
    const verts = (m: ReturnType<typeof mk>) => [...m.instances.map((g) => g.mesh), ...m.tiles].reduce((s, me) => s + me.vertexCount, 0);
    expect(verts(a)).not.toBe(verts(b));
    const c = composeScene({ recipe: { size: [6, 6], actors: { j: { params: { archetype: "realistic", top: "tee", shirtText: "I {heart} NY", shirtFont: "bangers" }, at: [0, 0] } } }, seed: 2 });
    expect(count(ROLE.yellow, [c.actors[0].asset.mesh])).toBeGreaterThan(100);
    expect((c.actors[0].asset.extra as { look: { printFont: string } }).look.printFont).toBe("bangers");
  });
});
