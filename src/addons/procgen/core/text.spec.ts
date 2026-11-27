import { describe, expect, it } from "vitest";
import { balanceLines, layoutText, normalizeText, StrokeField } from "./font";
import { propText, shopName, signText, streetName, townName } from "./names";
import { Rng } from "./rng";
import { strokeMesh, strokeOutlines, textMesh } from "../geom/text";
import { composeScene } from "../scene/compose";
import { ROLE } from "../style/roles";
import { windingAgreement } from "../geom/geom.spec";
import { composeVector } from "../vector/compose";
import { VectorScene } from "../vector/scene";

describe("police et mise en page", () => {
  it("capitales, accents conservés, caractères inconnus retirés", () => {
    expect(normalizeText("Café du Port")).toBe("CAFÉ DU PORT");
    expect(normalizeText("Œuvre ça ? «oui»")).toBe("OEUVRE ÇA ? \"OUI\"");
    expect(normalizeText("a~b{c}")).toBe("ABC");
  });

  it("centré, une capitale de haut, plusieurs lignes", () => {
    const one = layoutText("HELLO");
    const xs = one.polys.flat().map((p) => p[0]), ys = one.polys.flat().map((p) => p[1]);
    expect(Math.abs(Math.min(...xs) + one.width / 2)).toBeLessThan(0.01);
    expect(Math.abs(Math.max(...xs) - one.width / 2)).toBeLessThan(0.01);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(1, 6);
    const two = layoutText("AB\nCD", { leading: 1.5 });
    expect(two.lines).toBe(2);
    expect(two.height).toBeCloseTo(2.5, 6);
    // l'accent passe au-dessus de la capitale
    expect(Math.max(...layoutText("É").polys.flat().map((p) => p[1]))).toBeGreaterThan(1.1);
  });

  it("texte trop allongé coupé en deux au blanc central, mots courts jamais seuls", () => {
    expect(balanceLines("CAFÉ DU PORT", 2)).toBe("CAFÉ DU\nPORT");
    expect(balanceLines("BONJOUR !", 1)).toBe("BONJOUR !");
    expect(balanceLines("ABC", 0.5)).toBe("ABC");
  });

  it("distance au tracé : nulle sur le trait, sortie rapide loin du texte", () => {
    const f = new StrokeField(layoutText("L").polys);
    expect(f.distance(f.min[0], 0.5)).toBeLessThan(1e-9);
    expect(f.distance(50, 50, 0.2)).toBe(0.2);
  });
});

describe("texte en relief", () => {
  it("rubans fermés, bien orientés, à la taille demandée", () => {
    const t = textMesh("AÉ08", { height: 0.5, role: ROLE.ink });
    expect(t.mesh.triangleCount).toBeGreaterThan(100);
    expect(windingAgreement(t.mesh)).toBeGreaterThan(0.98);
    const b = t.mesh.bounds();
    expect(b.max[1] - b.min[1]).toBeLessThan(t.height * 1.5);
    expect(b.max[0] - b.min[0]).toBeCloseTo(t.width, 1);
  });

  it("se réduit pour tenir dans la largeur et la hauteur données", () => {
    const t = textMesh("BOULANGERIE MARTIN", { height: 1, maxWidth: 2, maxHeight: 0.5, role: ROLE.ink });
    const b = t.mesh.bounds();
    expect(b.max[0] - b.min[0]).toBeLessThanOrEqual(2.001);
    expect(t.cap).toBeLessThan(0.2);
  });

  it("lettres plates : face avant seule, un tiers des triangles", () => {
    const polys = layoutText("MAISON").polys;
    const full = strokeMesh(polys, 0.1, 0.05, 1, false);
    const flat = strokeMesh(polys, 0.1, 0.05, 1, false, true);
    expect(flat.triangleCount).toBeLessThan(full.triangleCount / 2.5);
    for (let i = 0; i < flat.vertexCount; i++) expect(flat.nrm[i * 3 + 2]).toBe(1);
  });

  it("contours vectoriels : un anneau plein par trait, un trou dans le O", () => {
    const area = (r: [number, number][]) => r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2;
    const o = strokeOutlines(layoutText("O").polys, 0.08);
    expect(o).toHaveLength(2);
    expect(area(o[0])).toBeGreaterThan(0);
    expect(area(o[1])).toBeLessThan(0);
    for (const r of strokeOutlines(layoutText("TX").polys, 0.08)) expect(area(r)).toBeGreaterThan(0);
  });
});

describe("noms générés", () => {
  it("déterministes par graine, variés d'une graine à l'autre", () => {
    expect(townName(new Rng("a"))).toBe(townName(new Rng("a")));
    const towns = new Set(Array.from({ length: 40 }, (_, i) => townName(new Rng(`t${i}`))));
    expect(towns.size).toBeGreaterThan(30);
    expect(shopName("cafe", new Rng("x"))).toBe(shopName("cafe", new Rng("x")));
    expect(streetName(new Rng("r")).length).toBeGreaterThan(5);
    for (const t of towns) expect(normalizeText(t).length).toBe(t.length);
  });

  it("auto, none, texte libre", () => {
    const r = new Rng("p");
    expect(propText("townsign", "none", r)).toBe("");
    expect(propText("townsign", "Brest", r)).toBe("Brest");
    expect(propText("townsign", "auto", r)).toBe(townName(r.fork("ville")));
    expect(propText("signpost", undefined, r, 1).split("|")).toHaveLength(3);
    expect(signText({ sign: "Le\\nBon Coin" }, r)).toBe("Le\nBon Coin");
    expect(signText({ sign: "auto", trade: "poste" }, r)).toMatch(/Poste/);
  });
});

describe("texte dans les scènes", () => {
  const count = (m: { role: ArrayLike<number>; vertexCount: number }, role: number) => {
    let n = 0;
    for (let i = 0; i < m.vertexCount; i++) if (m.role[i] === role) n++;
    return n;
  };

  it("enseigne d'une boutique, rien si sign: none", () => {
    const mk = (sign: string) => composeScene({ recipe: { size: [16, 12], layers: [{ id: "b", gen: "building", place: { at: [[0, 0]] }, params: { style: "boutique", floors: 2, bays: 3, sign, trade: "cafe" } }] }, seed: 3 });
    const withSign = mk("Café de la Gare");
    const none = mk("none");
    const all = (m: ReturnType<typeof mk>) => [...m.instances.map((g) => g.mesh), ...m.tiles];
    const ink = (m: ReturnType<typeof mk>) => [ROLE.ink, ROLE.accent, ROLE.metal, ROLE.trim, ROLE.lamp].reduce((s, r) => s + all(m).reduce((t, me) => t + count(me, r), 0), 0);
    expect(ink(withSign) - ink(none)).toBeGreaterThan(400);
  });

  it("maillot : nom et numéro au dos, imprimés sur le tissu (rien ne flotte ni ne s'enfonce)", { timeout: 60000 }, () => {
    const m = composeScene({ recipe: { size: [6, 6], actors: { j: { params: { archetype: "realistic", top: "tee", pattern: "plain", shirtName: "Bernard", shirtNumber: "10", colors: { top: "#c23b33" } }, at: [0, 0] } } }, seed: 2 });
    const mesh = m.actors[0].asset.mesh;
    let back = 0, front = 0;
    const body: number[] = [];
    for (let i = 0; i < mesh.vertexCount; i++) {
      if (mesh.role[i] !== ROLE.yellow) {
        if (mesh.role[i] === ROLE.cloth1) body.push(i);
        continue;
      }
      if (mesh.pos[i * 3 + 2] < 0) back++;
      else front++;
    }
    expect(back).toBeGreaterThan(200);
    expect(front).toBeGreaterThan(30);
    // chaque lettre est à moins d'1,5 cm du tissu le plus proche
    for (let i = 0; i < mesh.vertexCount; i += 7) {
      if (mesh.role[i] !== ROLE.yellow) continue;
      let best = Infinity;
      for (const j of body) best = Math.min(best, Math.hypot(mesh.pos[i * 3] - mesh.pos[j * 3], mesh.pos[i * 3 + 1] - mesh.pos[j * 3 + 1], mesh.pos[i * 3 + 2] - mesh.pos[j * 3 + 2]));
      expect(best).toBeLessThan(0.015);
    }
    // texte lisible : couleur d'impression contrastée avec un haut rouge
    expect(m.actors[0].asset.colors!.yellow).toBe("#f3efe4");
    // les lettres suivent le buste (poids du tissu voisin)
    expect(mesh.skin).toBeTruthy();
  });

  it("vectoriel : panneau d'entrée de ville tracé avec son nom", () => {
    const model = composeVector({ recipe: { size: [8, 6], layers: [{ id: "p", gen: "prop.townsign", place: { at: [{ x: 0, z: 0, yaw: 0 }] }, params: { text: "Lunel" } }] }, seed: 1 });
    const scene = new VectorScene(model, { camera: "side" });
    const shapes = scene.staticShapes(0).shapes;
    const named = shapes.filter((s) => s.fill === "black");
    expect(named.length).toBe(1);
    // L, U, N, E, L : au moins cinq anneaux pleins dans le chemin
    expect((named[0].d.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});
