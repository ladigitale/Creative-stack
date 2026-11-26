import { describe, expect, it } from "vitest";
import { readGrid } from "./grid";
import { contours, inPolygon } from "./contours";
import { SmoothWalls } from "./walls";
import { Rng } from "./rng";

const ROWS = [
  "##########",
  "#....#...#",
  "#....#...#",
  "#........#",
  "###..#####",
  "#....#...#",
  "#..##....#",
  "#........#",
  "##########",
];

describe("SmoothWalls", () => {
  const g = readGrid(ROWS, { walls: "#" });
  const free = (k: number) => g.cost[k] !== Infinity;

  for (const smooth of [0, 2]) {
    it(`côté libre identique aux contours dessinés (smooth ${smooth})`, () => {
      const walls = new SmoothWalls(g, free, { smooth, scale: 32 });
      const loops = contours(g, free, { smooth, scale: 32 });
      const rng = new Rng(7);
      let near = 0;
      for (let n = 0; n < 4000; n++) {
        const p: [number, number] = [rng.next() * 320, rng.next() * 288];
        const hit = walls.query(p[0], p[1]);
        let inside = false;
        for (const c of loops) if (inPolygon(p, c.points)) inside = !inside;
        if (hit) {
          near++;
          if (hit.dist > 0.01) expect(hit.free).toBe(inside);
        } else {
          // loin des parois : la case tranche
          expect(free(Math.floor(p[1] / 32) * g.w + Math.floor(p[0] / 32))).toBe(inside);
        }
      }
      expect(near).toBeGreaterThan(500);
    });
  }

  it("un coin de salle arrondi est un mur, alors que la case est libre", () => {
    const walls = new SmoothWalls(g, free, { smooth: 2, scale: 32 });
    // coin haut gauche de la salle : case (1,1) libre, point tout près du coin des murs
    const hit = walls.query(33, 33)!;
    expect(free(1 * g.w + 1)).toBe(true);
    expect(hit.free).toBe(false);
    // la normale ramène vers l'intérieur de la salle (bas droite)
    expect(hit.nx).toBeGreaterThan(0);
    expect(hit.ny).toBeGreaterThan(0);
  });

  it("au milieu d'une salle : rien à moins d'une case", () => {
    const walls = new SmoothWalls(g, free, { smooth: 2, scale: 32 });
    expect(walls.query(7 * 32 + 16, 2 * 32 + 16)).not.toBeNull(); // couloir étroit : parois proches
    const big = readGrid(["#######", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#######"], { walls: "#" });
    const w2 = new SmoothWalls(big, (k) => big.cost[k] !== Infinity, { smooth: 2, scale: 32 });
    expect(w2.query(3.5 * 32, 3.5 * 32)).toBeNull();
  });
});
