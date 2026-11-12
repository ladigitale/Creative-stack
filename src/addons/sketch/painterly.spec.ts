import { describe, expect, it } from "vitest";
import { paintImage } from "./painterly";
import { imageUrlOf, readPainterlyOptions } from "./painterly-element";
import { gesturesUrl, readGestures } from "./gestures";

/** Image de test : moitié gauche bleue, moitié droite orange, un disque blanc au centre. */
function image(w = 120, h = 90) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const disc = Math.hypot(x - w / 2, y - h / 2) < 15;
    const c = disc ? [255, 255, 255] : x < w / 2 ? [30, 60, 200] : [240, 140, 30];
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe("paintImage (peinture d'une image en gestes)", () => {
  it("peint du gros au fin, reproduit l'image et produit un jeu de gestes lisible", () => {
    const r = paintImage(image(), { maxSide: 120, seed: 3, preview: true });
    expect(r.width).toBe(1000);
    expect(r.height).toBe(750);
    expect(r.layers.length).toBe(6);
    expect(r.layers[0].radius).toBeGreaterThan(r.layers[r.layers.length - 1].radius);
    expect(r.error).toBeLessThan(0.08);
    const g = readGestures({ width: r.width, height: r.height, strokes: r.strokes })!;
    expect(g.strokes.length).toBe(r.strokes.length);
    // Premier trait : réglages communs (pinceau rond, pression), puis chaque trait ne donne que ce qui change.
    expect(r.strokes[0]).toMatchObject({ reset: true, tool: "paint", pressure: true });
    const colors = new Set(g.strokes.map((s) => s.brush.color));
    expect([...colors].some((c) => /^#[0-3][0-9a-f]{3}[b-f][0-9a-f]$/i.test(String(c)))).toBe(true); // un bleu
    expect([...colors].some((c) => /^#e|^#f/i.test(String(c)))).toBe(true); // orange ou blanc
    // Aperçu de la toile simulée : le centre est clair.
    const p = r.preview!;
    const mid = ((p.height >> 1) * p.width + (p.width >> 1)) * 4;
    expect(p.data[mid]).toBeGreaterThan(200);
  });

  it("même graine : même résultat ; plafond de traits respecté", () => {
    const a = paintImage(image(), { maxSide: 80, seed: 9 });
    const b = paintImage(image(), { maxSide: 80, seed: 9 });
    expect(JSON.stringify(a.strokes)).toBe(JSON.stringify(b.strokes));
    expect(paintImage(image(), { maxSide: 80, maxStrokes: 40 }).strokes.length).toBeLessThanOrEqual(40);
  });
});

describe("sources d'images et de gestes", () => {
  it("URL acceptées", () => {
    expect(imageUrlOf("https://a.b/c.png")).toBe("https://a.b/c.png");
    expect(imageUrlOf({ url: "blob:x" })).toBe("blob:x");
    expect(imageUrlOf("data:image/png;base64,AA")).toBeTruthy();
    expect(imageUrlOf("javascript:alert(1)")).toBeNull();
    expect(imageUrlOf("http://evil.example/a.png")).toBeNull();
    expect(gesturesUrl({ url: "https://a.b/g.json" })).toBe("https://a.b/g.json");
    expect(gesturesUrl({ url: "https://a.b/g.json", strokes: [] })).toBeNull(); // un jeu en données n'est pas une URL
    expect(gesturesUrl("data:application/json,{}")).toBeTruthy();
    expect(gesturesUrl("ftp://x")).toBeNull();
  });

  it("réglages du peintre bornés aux clés connues", () => {
    expect(readPainterlyOptions({ detail: "0.8", maxSide: 400, background: "#112233", evil: 1, seed: "x" })).toEqual({ detail: 0.8, maxSide: 400, background: "#112233" });
  });
});
