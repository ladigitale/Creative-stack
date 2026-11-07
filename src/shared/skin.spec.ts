import { describe, expect, it } from "vitest";
import { buildSkin, distanceToSegment, skinVertices, MAX_GRID, type BoneFrame } from "./skin";

/** Os vertical (pointe vers le bas, angle 0) d'origine (x, y) et de longueur len. */
const down = (x: number, y: number, len: number, angle = 0): BoneFrame => {
  const r = (angle * Math.PI) / 180;
  return { x, y, x2: x - Math.sin(r) * len, y2: y + Math.cos(r) * len, angle };
};

const opts = (rest: BoneFrame[], o: Partial<Parameters<typeof buildSkin>[0]> = {}) => ({
  x: 0,
  y: 100,
  w: 100,
  h: 200,
  cols: 4,
  rows: 8,
  rest,
  falloff: 2,
  influences: 3,
  ...o,
});

describe("distanceToSegment", () => {
  it("mesure à l'intérieur, au-delà des extrémités et sur un segment nul", () => {
    expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
    expect(distanceToSegment(-4, 3, 0, 0, 10, 0)).toBeCloseTo(5);
    expect(distanceToSegment(13, 4, 0, 0, 10, 0)).toBeCloseTo(5);
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
  });
});

describe("buildSkin", () => {
  it("construit la grille, les uv et les triangles", () => {
    const skin = buildSkin(opts([down(0, 0, 200)]))!;
    expect(skin.count).toBe(5 * 9);
    expect(skin.indices.length).toBe(4 * 8 * 6);
    expect(Math.max(...skin.indices)).toBe(skin.count - 1);
    expect([skin.uvs[0], skin.uvs[1]]).toEqual([0, 0]);
    expect([skin.uvs[(skin.count - 1) * 2], skin.uvs[(skin.count - 1) * 2 + 1]]).toEqual([1, 1]);
    // coin haut-gauche : (x − w/2, y − h/2)
    expect([skin.restPositions[0], skin.restPositions[1]]).toEqual([-50, 0]);
  });

  it("sans os : null ; grille et influences bornées", () => {
    expect(buildSkin(opts([]))).toBeNull();
    const big = buildSkin(opts([down(0, 0, 100), down(0, 100, 100)], { cols: 500, rows: 1, influences: 99 }))!;
    expect(big.cols).toBe(MAX_GRID);
    expect(big.rows).toBe(2);
    expect(big.influences).toBe(2);
  });

  it("les poids de chaque sommet somment 1 et l'os le plus proche domine", () => {
    const rest = [down(0, 0, 100), down(0, 100, 100)];
    const skin = buildSkin(opts(rest, { influences: 2 }))!;
    for (let i = 0; i < skin.count; i++) {
      const a = skin.weight[i * 2];
      const b = skin.weight[i * 2 + 1];
      expect(a + b).toBeCloseTo(1);
      expect(a).toBeGreaterThanOrEqual(b);
    }
    // sommet tout en haut : l'os du haut (indice 0) est en tête
    expect(skin.bone[0]).toBe(0);
    // sommet tout en bas : l'os du bas (indice 1)
    const last = (skin.count - 1) * 2;
    expect(skin.bone[last]).toBe(1);
  });
});

describe("skinVertices", () => {
  const rest = [down(0, 0, 100), down(0, 100, 100, 0)];

  it("pose de repos : les sommets ne bougent pas", () => {
    const skin = buildSkin(opts(rest))!;
    const out = new Float32Array(skin.count * 2);
    skinVertices(skin, rest, rest, out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(skin.restPositions[i], 3);
  });

  it("translation rigide d'un os unique : tous les sommets suivent", () => {
    const one = [down(0, 0, 200)];
    const skin = buildSkin(opts(one))!;
    const out = new Float32Array(skin.count * 2);
    skinVertices(skin, one, [down(30, -10, 200)], out);
    for (let i = 0; i < skin.count; i++) {
      expect(out[i * 2]).toBeCloseTo(skin.restPositions[i * 2] + 30, 3);
      expect(out[i * 2 + 1]).toBeCloseTo(skin.restPositions[i * 2 + 1] - 10, 3);
    }
  });

  it("rotation d'un os unique de 90° (sens horaire à l'écran) autour de son origine", () => {
    const one = [down(0, 0, 200)];
    const skin = buildSkin(opts(one, { x: 0, y: 100, w: 100, h: 200, cols: 2, rows: 2 }))!;
    const out = new Float32Array(skin.count * 2);
    skinVertices(skin, one, [down(0, 0, 200, 90)], out);
    // le sommet (0, 200) (bas, milieu) du repos arrive en (−200, 0) : l'os qui pointait vers le bas pointe vers la gauche
    const i = 2 * 3 + 1;
    expect(skin.restPositions[i * 2]).toBeCloseTo(0);
    expect(skin.restPositions[i * 2 + 1]).toBeCloseTo(200);
    expect(out[i * 2]).toBeCloseTo(-200, 3);
    expect(out[i * 2 + 1]).toBeCloseTo(0, 3);
  });

  it("un coude plié : l'extrémité suit l'avant-bras, le haut reste, la jonction se lisse", () => {
    const skin = buildSkin(opts(rest, { cols: 2, rows: 8, influences: 2, falloff: 2 }))!;
    const bent = [down(0, 0, 100), down(0, 100, 100, 90)];
    const out = new Float32Array(skin.count * 2);
    skinVertices(skin, rest, bent, out);
    const at = (r: number) => {
      const i = r * 3 + 1; // colonne centrale
      return { rest: [skin.restPositions[i * 2], skin.restPositions[i * 2 + 1]], now: [out[i * 2], out[i * 2 + 1]] };
    };
    const top = at(0);
    expect(top.now[0]).toBeCloseTo(top.rest[0], 0);
    expect(top.now[1]).toBeCloseTo(top.rest[1], 0);
    // bas : l'extrémité du second os pointe maintenant vers la gauche (x ≈ −100), y ≈ 100
    const bottom = at(8);
    expect(bottom.now[0]).toBeLessThan(-80);
    expect(bottom.now[1]).toBeLessThan(130);
    // les positions restent finies
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });

  it("un os absent de la pose courante garde sa pose de repos", () => {
    const skin = buildSkin(opts(rest))!;
    const out = new Float32Array(skin.count * 2);
    skinVertices(skin, rest, [], out);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(skin.restPositions[i], 3);
  });
});

describe("buildSkin : os à capsules (radius)", () => {
  // Tronc large (axe vertical x=100, rayon 40) et bras mince (axe vertical x=150, rayon 8), côte à côte.
  const torso: BoneFrame = { ...down(100, 0, 200), radius: 40 };
  const arm: BoneFrame = { ...down(150, 20, 150), radius: 8 };
  const opts = { x: 100, y: 100, w: 200, h: 200, cols: 20, rows: 20, falloff: 4, influences: 2 };

  it("un sommet à l'intérieur du tronc lui appartient presque entièrement, même près du bras", () => {
    const skin = buildSkin({ ...opts, rest: [torso, arm] })!;
    // sommet le plus proche de (128, 100) : à 28 de l'axe du tronc (dedans), 22 de l'axe du bras mais 14 de sa surface
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < skin.count; i++) {
      const d = Math.hypot(skin.restPositions[i * 2] - 128, skin.restPositions[i * 2 + 1] - 100);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const k = skin.influences;
    const wTorso = [...Array(k).keys()].filter((j) => skin.bone[best * k + j] === 0).reduce((a, j) => a + skin.weight[best * k + j], 0);
    expect(wTorso).toBeGreaterThan(0.8);
  });

  it("sans radius, la distance à l'axe donne ici l'avantage au bras (comportement historique inchangé)", () => {
    const skin = buildSkin({ ...opts, rest: [{ ...torso, radius: undefined }, { ...arm, radius: undefined }] })!;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < skin.count; i++) {
      const d = Math.hypot(skin.restPositions[i * 2] - 128, skin.restPositions[i * 2 + 1] - 100);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const k = skin.influences;
    const wTorso = [...Array(k).keys()].filter((j) => skin.bone[best * k + j] === 0).reduce((a, j) => a + skin.weight[best * k + j], 0);
    expect(wTorso).toBeLessThan(0.5);
  });

  it("les poids somment à 1 et la pose de repos reproduit les positions de repos", () => {
    const rest = [torso, arm];
    const skin = buildSkin({ ...opts, rest })!;
    for (let i = 0; i < skin.count; i++) {
      let sum = 0;
      for (let j = 0; j < skin.influences; j++) sum += skin.weight[i * skin.influences + j];
      expect(sum).toBeCloseTo(1, 5);
    }
    const out = new Float32Array(skin.count * 2);
    skinVertices(skin, rest, rest, out);
    for (let i = 0; i < skin.count * 2; i++) expect(out[i]).toBeCloseTo(skin.restPositions[i], 3);
  });
});
