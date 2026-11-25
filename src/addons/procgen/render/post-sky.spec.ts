import { describe, expect, it } from "vitest";
import { POST_FRAGMENT } from "./shaders";

describe("image de base : scène composée sur le ciel", () => {
  it("chaque pixel est mélangé au ciel selon sa couverture (pas de liseré noir aux bords anticrénelés)", () => {
    // la cible est effacée en noir transparent : un bord à moitié couvert vaut la moitié de sa couleur, alpha 0,5
    expect(POST_FRAGMENT).toMatch(/vec3 col = sky \* \(1\.0 - clamp\(c\.a, 0\.0, 1\.0\)\) \+ c\.rgb;/);
    expect(POST_FRAGMENT).not.toMatch(/else col = c\.rgb;/);
  });
});
