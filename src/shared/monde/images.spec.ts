import { describe, expect, it } from "vitest";
import { readMonde } from "./format";

// 1 × 1 px PNG
const PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("images du monde et posters", () => {
  const m = readMonde({
    unite: "cm",
    espace: { contour: [[0, 0], [300, 0], [300, 300], [0, 300]], hauteur: 250 },
    images: { poster1: PX, mauvais: "https://exemple.org/a.png" },
    place: [
      { model: "poster", name: "poster1", against: "mur0", at: 150, params: { image: "poster1", baguette: "bois" } },
      { model: "tapis", name: "tapis1", on: "plancher", at: [150, 150], params: { motif: "pois", teinte2: "#e07a5f", echelle: 10, angle: 45 } },
    ],
  });

  it("garde les images data: et refuse les URL réseau", () => {
    expect(Object.keys(m.images)).toEqual(["poster1"]);
    expect(m.issues.some((i) => i.path === "images.mauvais")).toBe(true);
  });

  it("le poster porte l'image sur sa face, le tapis son motif à deux couleurs", () => {
    const pl = m.place.find((p) => p.name === "poster1")!;
    const affiche = m.models.get(pl.model)!.parts.find((p) => p.name === "affiche")!;
    expect(affiche.image).toBe("poster1");
    expect(m.models.get(pl.model)!.parts.some((p) => p.name === "baguette")).toBe(true);
    const tp = m.place.find((p) => p.name === "tapis1")!;
    const tex = m.models.get(tp.model)!.parts.find((p) => p.name === "tapis")!.tex!;
    expect(tex).toMatchObject({ kind: "pois", color2: "#e07a5f", scale: 10, angle: 45 });
  });
});
