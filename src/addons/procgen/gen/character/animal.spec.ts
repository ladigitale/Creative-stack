import { describe, expect, it } from "vitest";
import { ACTIONS } from "../../rig/locomotion";
import { GEN_ACTIONS } from "../../../../shared/monde/gen";
import { ANIMAL_NAMES, ANIMAL_SPECS, mergeSpec, resolveAnimal } from "./animal";

describe("fiches animal", () => {
  it("22 espèces livrées, toutes complètes", () => {
    expect(ANIMAL_NAMES.length).toBeGreaterThanOrEqual(22);
    for (const n of ANIMAL_NAMES) {
      const s = ANIMAL_SPECS[n];
      expect(s.colors.fur.length, n).toBeGreaterThan(0);
      expect(typeof s.ears.size, n).toBe("number");
    }
    expect(ANIMAL_SPECS.pig.nose).toBe("disc");
    expect(ANIMAL_SPECS.elephant.snout.l).toBeGreaterThan(1.2);
  });
  it("fusion tolérante : valeurs inconnues ignorées, nombres bornés, couleurs vérifiées", () => {
    const s = mergeSpec(ANIMAL_SPECS.cat, { ears: { shape: "wings", size: 99 }, horns: "antlers", tail: { length: -3 }, colors: { fur: ["#112233", "rouge"], beak: "javascript:" }, nose: "disc" });
    expect(s.ears.shape).toBe("pointed");
    expect(s.ears.size).toBe(3);
    expect(s.horns).toBe("antlers");
    expect(s.tail.length).toBe(0);
    expect(s.colors.fur).toEqual(["#112233"]);
    expect(s.colors.beak).toBe(ANIMAL_SPECS.cat.colors.beak);
    expect(s.nose).toBe("disc");
    expect(mergeSpec(ANIMAL_SPECS.cat, "n'importe quoi")).toEqual(ANIMAL_SPECS.cat);
  });
  it("résolution : humain sans fiche, espèce retouchée, espèce inventée", () => {
    expect(resolveAnimal("none", {})).toBeNull();
    expect(resolveAnimal("fox", { tail: { shape: "pom" } })!.tail.shape).toBe("pom");
    expect(resolveAnimal("none", { ears: { shape: "long" } })!.ears.shape).toBe("long");
  });
  it("actions du format monde alignées sur le moteur", () => {
    expect([...GEN_ACTIONS]).toEqual([...ACTIONS]);
  });
});
