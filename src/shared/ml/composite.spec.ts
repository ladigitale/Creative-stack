import { describe, expect, it } from "vitest";
import { alphaBounds, blurDivisor, boxesOf, coverRect, cropBox, effectOf, featherDivisor, grayToAlpha, labelKey, morphAlpha, mixBounds, padBounds, pixelDivisor, safeColor, selectBoxes, shapesOf, spriteSize } from "./composite";

const out = {
  objects: [
    { label: "cell phone", score: 0.9, x: 0.1, y: 0.2, w: 0.2, h: 0.3 },
    { label: "Person", score: 0.6, x: 0.5, y: 0.1, w: 0.4, h: 0.8 },
    { label: "cup", score: 0.3, x: 0, y: 0, w: 0.1, h: 0.1 },
    { label: "bad", score: 1, x: NaN, y: 0, w: 0.1, h: 0.1 },
    { label: "flat", score: 1, x: 0, y: 0, w: 0, h: 0.1 },
    null,
  ],
};

describe("boîtes", () => {
  it("boxesOf : ignore les entrées invalides", () => {
    expect(boxesOf(out).map((b) => b.label)).toEqual(["cell phone", "Person", "cup"]);
    expect(boxesOf(null)).toEqual([]);
    expect(boxesOf({ objects: "x" })).toEqual([]);
  });
  it("id : boxesOf le lit, selectBoxes ne garde que cet objet (0 : tous)", () => {
    const list = boxesOf({ objects: [{ label: "cup", score: 0.9, x: 0, y: 0, w: 0.2, h: 0.2, id: 7 }, { label: "cup", score: 0.8, x: 0.5, y: 0, w: 0.2, h: 0.2, id: 8 }, { label: "cup", score: 0.7, x: 0.1, y: 0.5, w: 0.2, h: 0.2 }] });
    expect(list.map((b) => b.id)).toEqual([7, 8, undefined]);
    expect(selectBoxes(list, "", 0, 10, 8).map((b) => b.id)).toEqual([8]);
    expect(selectBoxes(list, "", 0, 10, 0)).toHaveLength(3);
    expect(selectBoxes(list, "", 0, 10, 99)).toEqual([]);
  });

  it("selectBoxes : étiquettes, score minimal, maximum, meilleurs d'abord", () => {
    const all = boxesOf(out);
    expect(selectBoxes(all, "", 0, 10).map((b) => b.label)).toEqual(["cell phone", "Person", "cup"]);
    expect(selectBoxes(all, "cell_phone, person", 0, 10).map((b) => b.label)).toEqual(["cell phone", "Person"]);
    expect(selectBoxes(all, "", 0.5, 10)).toHaveLength(2);
    expect(selectBoxes(all, "", 0, 1).map((b) => b.label)).toEqual(["cell phone"]);
    expect(selectBoxes(all, "", 0, 0)).toEqual([]);
    expect(labelKey("Cell Phone")).toBe("cell_phone");
  });
  it("shapesOf : pixels, marge, bornée à l'image", () => {
    const [s] = shapesOf([{ label: "a", score: 1, x: 0.1, y: 0.2, w: 0.2, h: 0.3 }], 1000, 500, "ellipse", 0.5);
    expect(s.kind).toBe("ellipse");
    expect(s.x).toBeCloseTo(0, 5); // 0,1 - 0,1 = 0
    expect(s.w).toBeCloseTo(400, 5); // 0 → 0,4
    expect(s.y).toBeCloseTo(0.05 * 500, 5);
    const [edge] = shapesOf([{ label: "a", score: 1, x: 0.9, y: 0.9, w: 0.1, h: 0.1 }], 100, 100, "rect", 1);
    expect(edge.x + edge.w).toBeLessThanOrEqual(100);
    expect(edge.y + edge.h).toBeLessThanOrEqual(100);
  });
});

describe("recadrage et échelles", () => {
  it("coverRect : remplit sans déformer", () => {
    expect(coverRect(1600, 900, 100, 100)).toEqual({ sx: 350, sy: 0, sw: 900, sh: 900 });
    expect(coverRect(900, 1600, 100, 100)).toEqual({ sx: 0, sy: 350, sw: 900, sh: 900 });
    expect(coverRect(100, 100, 200, 100)).toEqual({ sx: 0, sy: 25, sw: 100, sh: 50 });
  });
  it("diviseurs bornés et croissants", () => {
    expect(blurDivisor(0)).toBe(2);
    expect(blurDivisor(1)).toBe(32);
    expect(blurDivisor(5)).toBe(32);
    expect(blurDivisor(-1)).toBe(2);
    expect(pixelDivisor(0)).toBe(4);
    expect(pixelDivisor(1)).toBe(64);
    expect(featherDivisor(0)).toBe(1);
    expect(featherDivisor(1)).toBe(13);
    expect(blurDivisor(0.2)).toBeLessThan(blurDivisor(0.6));
  });
  it("effectOf : inconnu → flou", () => {
    expect(effectOf("pixelate")).toBe("pixelate");
    expect(effectOf("nope")).toBe("blur");
  });
});

describe("couleur et masque", () => {
  it("safeColor : formes simples seulement", () => {
    expect(safeColor("#0f0")).toBe("#0f0");
    expect(safeColor("#102030cc")).toBe("#102030cc");
    expect(safeColor("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
    expect(safeColor("hsla(120 50% 50% / .5)")).toBe("hsla(120 50% 50% / .5)");
    expect(safeColor("teal")).toBe("teal");
    expect(safeColor("url(http://x)")).toBe("");
    expect(safeColor("red; background:url(x)")).toBe("");
    expect(safeColor("rgb(1,2,3)};alert(1)")).toBe("");
    expect(safeColor("")).toBe("");
  });
  it("grayToAlpha : alpha = niveau de gris, couleur blanche", () => {
    const d = new Uint8ClampedArray([10, 10, 10, 255, 200, 200, 200, 255]);
    grayToAlpha(d);
    expect(Array.from(d)).toEqual([255, 255, 255, 10, 255, 255, 255, 200]);
  });
});

describe("boîtes de pixels et sprites", () => {
  it("alphaBounds : boîte des pixels au-dessus du seuil", () => {
    const w = 4;
    const h = 3;
    const d = new Uint8ClampedArray(w * h * 4);
    d[(1 * w + 1) * 4 + 3] = 255;
    d[(2 * w + 2) * 4 + 3] = 200;
    d[(0 * w + 3) * 4 + 3] = 10; // sous le seuil
    expect(alphaBounds(d, w, h)).toEqual({ x0: 0.25, y0: 1 / 3, x1: 0.75, y1: 1 });
    expect(alphaBounds(new Uint8ClampedArray(w * h * 4), w, h)).toBeNull();
    expect(alphaBounds([], 0, 0)).toBeNull();
  });
  it("padBounds : marge bornée ; mixBounds : lissage", () => {
    const b = padBounds({ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.8 }, 0.5);
    expect(b.x0).toBeCloseTo(0.3, 5);
    expect(b.y1).toBeCloseTo(1, 5);
    expect(padBounds({ x0: 0, y0: 0, x1: 1, y1: 1 }, 1)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
    const next = { x0: 0.5, y0: 0.5, x1: 0.9, y1: 0.9 };
    expect(mixBounds(null, next, 0.5)).toBe(next);
    expect(mixBounds({ x0: 0, y0: 0, x1: 1, y1: 1 }, next, 0).x0).toBe(0.5);
    expect(mixBounds({ x0: 0, y0: 0, x1: 1, y1: 1 }, next, 0.5).x0).toBeCloseTo(0.25, 5);
  });
  it("spriteSize : hauteur = scale × scène, proportions conservées", () => {
    expect(spriteSize(100, 200, 480, 0.5)).toEqual({ w: 120, h: 240 });
    expect(spriteSize(0, 200, 480, 0.5)).toEqual({ w: 0, h: 0 });
    expect(spriteSize(100, 200, 480, -1).h).toBe(0);
  });
});

describe("cropBox", () => {
  const box = { label: "a", score: 1, x: 0.2, y: 0.3, w: 0.2, h: 0.4 };
  it("marge, bornes et retournement du repère écran", () => {
    const plain = cropBox(box, 0.5, false);
    expect(plain.x).toBeCloseTo(0.1, 5);
    expect(plain.w).toBeCloseTo(0.4, 5);
    expect(plain.y).toBeCloseTo(0.1, 5);
    expect(plain.h).toBeCloseTo(0.8, 5);
    const flipped = cropBox(box, 0.5, true);
    expect(flipped.x).toBeCloseTo(1 - 0.5, 5); // 1 - (0,1 + 0,4)
    expect(flipped.w).toBeCloseTo(0.4, 5);
    const edge = cropBox({ ...box, x: 0.9, w: 0.2 }, 1, false);
    expect(edge.x + edge.w).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("morphAlpha", () => {
  const W = 12;
  const H = 8;
  const mask = (on: (x: number, y: number) => boolean) => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[(y * W + x) * 4 + 3] = on(x, y) ? 255 : 0;
    return d;
  };
  const alpha = (d: Uint8ClampedArray, x: number, y: number) => d[(y * W + x) * 4 + 3];

  it("dilate : la zone gagne r pixels de chaque côté", () => {
    const d = mask((x, y) => x >= 5 && x <= 6 && y >= 3 && y <= 4);
    morphAlpha(d, W, H, 2);
    expect(alpha(d, 3, 3)).toBe(255);
    expect(alpha(d, 8, 4)).toBe(255);
    expect(alpha(d, 2, 3)).toBe(0);
    expect(alpha(d, 5, 1)).toBe(255);
    expect(alpha(d, 5, 0)).toBe(0);
  });

  it("erode : la zone perd r pixels, un trait plus fin disparaît", () => {
    const d = mask((x) => x >= 2 && x <= 9);
    morphAlpha(d, W, H, -2);
    expect(alpha(d, 3, 4)).toBe(0);
    expect(alpha(d, 4, 4)).toBe(255);
    expect(alpha(d, 7, 4)).toBe(255);
    expect(alpha(d, 8, 4)).toBe(0);
    const thin = mask((x) => x === 5);
    morphAlpha(thin, W, H, -1);
    expect(alpha(thin, 5, 4)).toBe(0);
  });

  it("le bord de l'image est prolongé : une zone qui touche le bas ou un côté n'est pas rongée par là", () => {
    const d = mask((x, y) => x >= 4 && x <= 8 && y >= 3);
    morphAlpha(d, W, H, -2);
    expect(alpha(d, 6, H - 1)).toBe(255);
    expect(alpha(d, 6, 4)).toBe(0); // le haut est rogné
    const side = mask((x) => x <= 5);
    morphAlpha(side, W, H, -2);
    expect(alpha(side, 0, 4)).toBe(255);
    expect(alpha(side, 4, 4)).toBe(0);
  });

  it("r = 0 ne change rien ; seul l'alpha est touché", () => {
    const d = mask((x) => x === 3);
    d[(4 * W + 3) * 4] = 77;
    const before = Array.from(d);
    morphAlpha(d, W, H, 0);
    expect(Array.from(d)).toEqual(before);
    morphAlpha(d, W, H, 1);
    expect(d[(4 * W + 3) * 4]).toBe(77);
  });
});

