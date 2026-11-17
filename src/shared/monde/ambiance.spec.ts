import { describe, expect, it } from "vitest";
import { readMonde } from "./format";
import { AMBIANCES, readAmbiance } from "./ambiance";

const caisse = { parts: [{ name: "c", box: [1, 1, 1], color: "#888888" }] };

describe("ambiances", () => {
  it("une ambiance règle rendu, ciel, lumière et étalonnage", () => {
    const m = readMonde({ ambiance: "noir", models: { caisse }, place: [{ model: "caisse" }] });
    expect(m.ambiance).toBe("noir");
    expect(m.ciel).toBe(AMBIANCES.noir.ciel);
    expect(m.grade?.bw).toBe(1);
    expect(m.lumiere?.intensite).toBe(3);
    expect(m.issues).toEqual([]);
  });
  it("ce que le monde écrit l'emporte ; etalonnage et lumiere complètent", () => {
    const m = readMonde({ ambiance: "cartoon", ciel: "#000000", look: "doux", etalonnage: { grain: 0.5, contraste: 2 }, lumiere: { intensite: 4 }, palette: { sol: "#123456" } });
    expect(m.ciel).toBe("#000000");
    expect(m.look).toBe("doux");
    expect(m.grade?.grain).toBe(0.5);
    expect(m.grade?.contrast).toBe(2);
    expect(m.grade?.saturation).toBe(AMBIANCES.cartoon.grade.saturation);
    expect(m.lumiere?.intensite).toBe(4);
    expect(m.palette.sol).toBe("#123456");
    expect(m.palette.maillot).toBe(AMBIANCES.cartoon.palette!.maillot);
  });
  it("fini par défaut sur les pièces sans fini, alias et erreurs", () => {
    const m = readMonde({ ambiance: "jouet", models: { caisse, verre: { parts: [{ name: "v", box: [1, 1, 1], finish: "verre" }] } } });
    expect(m.models.get("caisse")!.parts[0].finish?.rough).toBeLessThan(0.5);
    expect(m.models.get("verre")!.parts[0].finish?.glass).toBeGreaterThan(0.5);
    expect(readAmbiance("cyberpunk", () => {})?.name).toBe("cyber");
    const issues: string[] = [];
    expect(readAmbiance("inconnue", (s) => issues.push(s))).toBeNull();
    expect(issues[0]).toMatch(/inconnue/);
    const perso = readAmbiance({ base: "silhouette", etalonnage: { vignette: 0.1 } }, () => {})!;
    expect(perso.grade.vignette).toBe(0.1);
    expect(perso.grade.silhouette).toBe(1);
  });
  it("sans ambiance ni réglage : aucun étalonnage, lumière de la scène", () => {
    const m = readMonde({});
    expect(m.grade).toBeNull();
    expect(m.lumiere).toBeNull();
    expect(m.ambiance).toBe("");
    expect(readMonde({ etalonnage: { pixel: 4 } }).grade?.pixel).toBe(4);
    expect(readMonde({ etalonnage: { peinture: 6, tramage: true } }).grade).toMatchObject({ paint: 6, dither: 0.6 });
    expect(readMonde({ ambiance: "peinture" }).ambiance).toBe("tableau");
  });
  it("arrondi par défaut des boîtes sans arrondi écrit, facettes", () => {
    const models = { a: { parts: [{ name: "x", box: [1, 1, 1] }, { name: "y", box: [1, 1, 1, 0] }, { name: "z", box: [0.03, 1, 1] }] } };
    const m = readMonde({ ambiance: "jouet", models });
    const parts = m.models.get("a")!.parts;
    expect(parts[0].shape!.a[3]).toBeCloseTo(AMBIANCES.jouet.arrondi!, 5);
    expect(parts[1].shape!.a[3]).toBe(0);
    expect(parts[2].shape!.a[3]).toBeCloseTo(0.01, 5);
    expect(readMonde({ models }).models.get("a")!.parts[0].shape!.a[3]).toBe(0);
    expect(readMonde({ arrondi: 0.1, models }).models.get("a")!.parts[0].shape!.a[3]).toBeCloseTo(0.1, 5);
    expect(readMonde({ ambiance: "retro" }).facettes).toBe(true);
    expect(readMonde({ ambiance: "retro", facettes: false }).facettes).toBe(false);
  });
});
