import { readFileSync } from "node:fs";
import jsonata from "jsonata/jsonata.js";
import { describe, expect, it } from "vitest";
import { registerAlgoHelpers } from "./jsonata";
import { readGrid } from "./grid";
import { astarCells, coreOf, gridPath } from "./path";
import { Rng } from "./rng";
import { NavGrid } from "../../addons/procgen/scene/nav";

async function run(expr: string, input: unknown = {}) {
  const e = (jsonata as unknown as (s: string) => import("jsonata").Expression)(expr);
  registerAlgoHelpers(e);
  return e.evaluate(input);
}

const MAP = [
  "##########",
  "#@...#...#",
  "#.##.#.#.#",
  "#..#...#X#",
  "##########",
];

describe("grille", () => {
  it("lit lignes et matrices, avec coûts et murs", () => {
    const g = readGrid(MAP);
    expect([g.w, g.h]).toEqual([10, 5]);
    expect(g.cost[0]).toBe(Infinity);
    const m = readGrid([[0, 1], [0, 0]]);
    expect(m.cost[1]).toBe(Infinity);
    const c = readGrid([".~"], { costs: { "~": 3 } });
    expect(c.cost[1]).toBe(3);
    expect(() => readGrid(Array(300).fill(".".repeat(300)))).toThrow(/trop grande/);
  });

  it("$gridGet / $gridSet / $gridFind", async () => {
    expect(await run(`$gridGet(g, [1, 1])`, { g: MAP })).toBe("@");
    const r = (await run(`$gridSet(g, [[2, 1], [3, 1]], "o")`, { g: MAP })) as string[];
    expect(r[1]).toBe("#@oo.#...#");
    expect(r[0]).toBe(MAP[0]);
    expect(await run(`$gridFind(g, "X")`, { g: MAP })).toEqual([[8, 3]]);
  });
});

describe("chemins", () => {
  it("A* trouve le plus court chemin, 4 voisins", async () => {
    const r = (await run(`$gridPath(g, [1, 1], [8, 3])`, { g: MAP })) as { found: boolean; path: number[][]; cost: number };
    expect(r.found).toBe(true);
    expect(r.path[0]).toEqual([1, 1]);
    expect(r.path[r.path.length - 1]).toEqual([8, 3]);
    expect(r.cost).toBe(r.path.length - 1);
    expect(r.cost).toBe(13);
  });

  it("A* respecte les coûts et choisit la cible la plus proche", () => {
    const g = readGrid(["S~~~G", ".....",], { costs: { "~": 10 } });
    const r = gridPath(g, [0, 0], [[4, 0]]);
    expect(r.cost).toBe(6); // contourne l'eau par la ligne du bas
    const multi = gridPath(readGrid(["A....B..S"]), [8, 0], [[0, 0], [5, 0]]);
    expect(multi.cells.length - 1).toBe(3);
  });

  it("8 voisins sans couper les coins, lissage", async () => {
    const g = ["....", ".#..", "...."];
    const r = (await run(`$gridPath(g, [0, 0], [2, 2], {"diag": true})`, { g })) as { cost: number; path: number[][] };
    expect(r.path.some(([x, y]) => x === 1 && y === 1)).toBe(false);
    const open = (await run(`$gridPath(g, [0, 0], [3, 0], {"smooth": true})`, { g })) as { path: number[][] };
    expect(open.path).toEqual([[0, 0], [3, 0]]);
  });

  it("introuvable → found false", async () => {
    const r = (await run(`$gridPath(g, [0, 0], [2, 0])`, { g: [".#."] })) as { found: boolean; path: unknown[] };
    expect(r.found).toBe(false);
    expect(r.path).toEqual([]);
  });

  it("carte de distances, pas suivant, portée", async () => {
    const d = (await run(`$gridDistance(g, [[0, 0]])`, { g: ["...", ".#.", "..."] })) as number[][];
    expect(d[2][2]).toBe(4);
    expect(d[1][1]).toBe(-1);
    expect(await run(`$gridNext(g, [2, 2], [[0, 0]])`, { g: ["...", ".#.", "..."] })).toEqual(expect.arrayContaining([expect.any(Number)]));
    const next = (await run(`$gridNext(g, [4, 0], [0, 0])`, { g: ["....."] })) as number[];
    expect(next).toEqual([3, 0]);
    const flee = (await run(`$gridNext(g, [2, 0], [0, 0], {"flee": true})`, { g: ["....."] })) as number[];
    expect(flee).toEqual([3, 0]);
    const reach = (await run(`$gridReach(g, [0, 0], 2)`, { g: ["....."] })) as unknown[];
    expect(reach.length).toBe(3);
  });

  it("NavGrid de procgen passe par le même A*", () => {
    const n = new NavGrid(10, 10, 1);
    for (let j = 0; j < 8; j++) n.blocked[j * n.nx + 5] = 1;
    const p = n.path([-4, -4], [4, -4]);
    expect(p).not.toBeNull();
    expect(p![0]).toEqual([-4, -4]);
    expect(p![p!.length - 1]).toEqual([4, -4]);
  });

  it("tient le budget d'un réducteur sur 256 × 256", () => {
    const rows: string[] = [];
    for (let y = 0; y < 256; y++) {
      let s = "";
      for (let x = 0; x < 256; x++) s += x % 8 === 4 && y % 64 !== (x % 16 === 4 ? 2 : 60) ? "#" : ".";
      rows.push(s);
    }
    const g = readGrid(rows, { diag: true });
    gridPath(g, [0, 0], [[255, 255]]);
    const t0 = performance.now();
    const r = astarCells(coreOf(g), [0], [255 * 256 + 255]);
    const ms = performance.now() - t0;
    expect(r.found).toBe(true);
    expect(ms).toBeLessThan(50);
  });
});

describe("vue et remplissage", () => {
  it("Bresenham et ligne de vue", async () => {
    expect(await run(`$gridLine([0, 0], [3, 1])`)).toEqual([[0, 0], [1, 0], [2, 1], [3, 1]]);
    expect(await run(`$gridSight(g, [0, 0], [4, 0])`, { g: ["..#.."] })).toBe(false);
    expect(await run(`$gridSight(g, [0, 0], [2, 0])`, { g: ["..#.."] })).toBe(true);
  });

  it("champ de vision : le mur cache ce qui est derrière", async () => {
    const g = [".......", "...#...", ".......", "...@...", "......."];
    const cells = (await run(`$gridFov(g, [3, 3], 5)`, { g })) as number[][];
    const has = (x: number, y: number) => cells.some((c) => c[0] === x && c[1] === y);
    expect(has(3, 1)).toBe(true);
    expect(has(3, 0)).toBe(false);
    expect(has(0, 3)).toBe(true);
    const mask = (await run(`$gridFov(g, [3, 3], 5, {"as": "mask", "into": ["1......"]})`, { g })) as string[];
    expect(mask[0][0]).toBe("1");
    expect(mask[0][3]).toBe("0");
  });

  it("flood fill, remplissage, régions", async () => {
    const g = ["aab", "abb", "ccb"];
    expect(((await run(`$gridFlood(g, [0, 0])`, { g })) as unknown[]).length).toBe(3);
    expect(await run(`$gridFill(g, [2, 0], "x")`, { g })).toEqual(["aax", "axx", "ccx"]);
    const regs = (await run(`$gridRegions(g)`, { g })) as { value: string; size: number }[];
    expect(regs.map((r) => [r.value, r.size])).toEqual([["b", 4], ["a", 3], ["c", 2]]);
    const walk = (await run(`$gridFlood(g, [0, 0], {"match": "walkable", "walls": "c"})`, { g })) as unknown[];
    expect(walk.length).toBe(7);
  });

  it("alignements, chute, automate", async () => {
    const m = (await run(`$gridMatches(g, 3)`, { g: ["rrrg", "gbgg", "gbbb"] })) as { value: string; dir: string }[];
    expect(m.map((x) => x.value + x.dir).sort()).toEqual(["bh", "rh"]);
    expect(await run(`$gridFall(g, ".")`, { g: ["a.", ".b", ".."] })).toEqual(["..", "..", "ab"]);
    expect(await run(`$gridFall(g, ".")`, { g: ["a", "#", "."] })).toEqual(["a", "#", "."]);
    const blinker = [".....", "..#..", "..#..", "..#..", "....."];
    expect(await run(`$gridLife(g)`, { g: blinker })).toEqual([".....", ".....", ".###.", ".....", "....."]);
  });
});

describe("génération", () => {
  it("labyrinthes parfaits et reproductibles", async () => {
    for (const algo of ["backtracker", "prim", "kruskal", "wilson"]) {
      const a = (await run(`$genMaze(8, 6, 42, {"algo": "${algo}"})`)) as string[];
      const b = (await run(`$genMaze(8, 6, 42, {"algo": "${algo}"})`)) as string[];
      expect(a).toEqual(b);
      expect([a[0].length, a.length]).toEqual([17, 13]);
      // parfait : toutes les cellules reliées, arbre (sol = 2n − 1 cases)
      const floor = a.join("").split("").filter((c) => c === ".").length;
      expect(floor).toBe(2 * 48 - 1);
      const regs = (await run(`$gridRegions(g, {"values": "."})`, { g: a })) as unknown[];
      expect(regs.length).toBe(1);
    }
  });

  it("caverne d'un seul tenant, donjon relié", async () => {
    const c = (await run(`$genCave(48, 32, 7)`)) as string[];
    expect(((await run(`$gridRegions(g, {"values": "."})`, { g: c })) as unknown[]).length).toBe(1);
    const d = (await run(`$genDungeon(60, 40, 3)`)) as { rows: string[]; rooms: { center: number[] }[] };
    expect(d.rooms.length).toBeGreaterThan(3);
    expect(((await run(`$gridRegions(g, {"values": "."})`, { g: d.rows })) as unknown[]).length).toBe(1);
  });

  it("semis de Poisson espacé", async () => {
    const pts = (await run(`$genPoisson(50, 50, 5, 1)`)) as number[][];
    expect(pts.length).toBeGreaterThan(40);
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])).toBeGreaterThanOrEqual(4.99);
  });

  it("carte de bruit à niveaux", async () => {
    const rows = (await run(`$genNoise(20, 10, {"seed": 4, "levels": [[-0.1, "~"], [0.2, "."], [9, "^"]]})`)) as string[];
    expect(rows.length).toBe(10);
    expect(rows.join("")).toMatch(/^[~.^]+$/);
  });
});

describe("hasard à graine", () => {
  it("suite reproductible et bien répartie", () => {
    const a = new Rng(123), b = new Rng(123);
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      const v = a.next();
      if (i < 1000) expect(v).toBe(b.next());
      sum += v;
    }
    expect(sum / 100_000).toBeCloseTo(0.5, 2);
  });

  it("$shuffled, $pick, $bag, $roll", async () => {
    const s = (await run(`$shuffled([1,2,3,4,5], 9)`)) as { value: number[]; seed: number };
    expect([...s.value].sort()).toEqual([1, 2, 3, 4, 5]);
    const p = (await run(`$pick([{"n":"a","w":0},{"n":"b","w":5}], 1, "w")`)) as { value: { n: string } };
    expect(p.value.n).toBe("b");
    let bagState: unknown = [];
    let seed = 5;
    const out: string[] = [];
    for (let i = 0; i < 6; i++) {
      const b = (await run(`$bag(rest, ["I","O","T"], seed)`, { rest: bagState, seed })) as { value: string; bag: unknown; seed: number };
      out.push(b.value);
      bagState = b.bag;
      seed = b.seed;
    }
    expect([...out.slice(0, 3)].sort()).toEqual(["I", "O", "T"]);
    expect([...out.slice(3)].sort()).toEqual(["I", "O", "T"]);
    const d = (await run(`$roll("4d6kh3+2", 11)`)) as { value: number; min: number; max: number; rolls: { kept: number[] }[] };
    expect(d.rolls[0].kept.length).toBe(3);
    expect(d.value).toBeGreaterThanOrEqual(5);
    expect(d.value).toBeLessThanOrEqual(20);
    expect([d.min, d.max]).toEqual([5, 20]);
    await expect(run(`$roll("2d6+abc", 1)`)).rejects.toThrow(/notation/);
  });
});

describe("interpolation, états, hexagones, graphes", () => {
  it("interpolation", async () => {
    expect(await run(`$lerp(0, 10, 0.25)`)).toBe(2.5);
    expect(await run(`$ease("outQuad", 0.5)`)).toBe(0.75);
    expect(await run(`$angleDelta(350, 10)`)).toBe(20);
    const d = (await run(`$damp(0, 10, 0, 0.3, 1/60)`)) as { value: number; velocity: number };
    expect(d.value).toBeGreaterThan(0);
    expect(d.value).toBeLessThan(10);
  });

  it("machine à états", async () => {
    const m = { initial: "idle", states: { idle: { on: { see: "chase" } }, chase: { on: { hit: [{ target: "flee", when: { hp: { lt: 3 } } }, { target: "fight" }] } }, "*": { on: { die: "dead" } } } };
    expect(await run(`$fsm(m, "", "see")`, { m })).toBe("chase");
    expect(await run(`$fsm(m, "chase", "hit", {"hp": 2})`, { m })).toBe("flee");
    expect(await run(`$fsm(m, "chase", "hit", {"hp": 9})`, { m })).toBe("fight");
    expect(await run(`$fsm(m, "idle", "die")`, { m })).toBe("dead");
    expect(await run(`$fsm(m, "idle", "nope")`, { m })).toBe("idle");
  });

  it("hexagones", async () => {
    expect(await run(`$hexDistance([0, 0], [2, -1])`)).toBe(2);
    expect(((await run(`$hexRing([0, 0], 2)`)) as unknown[]).length).toBe(12);
    expect(((await run(`$hexRange([0, 0], 2)`)) as unknown[]).length).toBe(19);
    expect(((await run(`$hexLine([0, 0], [3, -1])`)) as unknown[]).length).toBe(4);
    expect(await run(`$hexFromPixel($hexToPixel([2, -1], 10), 10)`)).toEqual([2, -1]);
  });

  it("graphes", async () => {
    const g = { edges: [["a", "b", 1], ["b", "c", 1], ["a", "c", 5]] };
    expect(await run(`$graphPath(g, "a", "c")`, { g })).toEqual({ found: true, path: ["a", "b", "c"], cost: 2 });
    expect(await run(`$graphReach(g, "a", 1)`, { g })).toEqual({ a: 0, b: 1 });
    expect(await run(`$topoSort({"forge": ["mine", "feu"], "feu": ["bois"]})`)).toEqual(["mine", "bois", "feu", "forge"]);
    await expect(run(`$topoSort({"a": ["b"], "b": ["a"]})`)).rejects.toThrow(/cycle/);
  });
});

describe("recettes de algo.md", () => {
  const doc = readFileSync("src/addons/interactive/algo.md", "utf8");

  it("déplacement, poursuite et brouillard", async () => {
    const store = JSON.parse(/```json\n(\{\n  "tag": "sonic-store"[\s\S]*?)\n```/.exec(doc)![1]);
    const { initial, reducer } = store.attributes;
    const e = (jsonata as unknown as (s: string) => import("jsonata").Expression)(reducer);
    registerAlgoHelpers(e);
    const next = (await e.evaluate({}, { state: initial, action: { type: "move", payload: { dx: 1, dy: 0 } } })) as { map: string[]; explored: string[] };
    expect(next.map[1]).toBe("#.@..#...#");
    expect(next.map.join("").split("M").length).toBe(2);
    expect(next.map[3][8]).toBe(".");
    expect(next.explored[1][2]).toBe("1");
    const wall = (await e.evaluate({}, { state: initial, action: { type: "move", payload: { dx: 0, dy: -1 } } })) as unknown;
    expect(wall).toEqual(initial);
  });

  it("match-3", async () => {
    const expr = /Match-3 resolution step:\n\n```jsonata\n([\s\S]*?)\n```/.exec(doc)![1];
    const e = (jsonata as unknown as (s: string) => import("jsonata").Expression)(expr);
    registerAlgoHelpers(e);
    const out = (await e.evaluate({}, { state: { board: ["abc", "aaa", "bcb"], score: 0 } })) as { board: string[]; score: number };
    expect(out.board).toEqual(["...", "abc", "bcb"]);
    expect(out.score).toBe(3);
  });

  it("butin et niveau", async () => {
    const loot = /Loot with a kept seed:\n\n```jsonata\n([\s\S]*?)\n```/.exec(doc)![1];
    const e = (jsonata as unknown as (s: string) => import("jsonata").Expression)(loot);
    registerAlgoHelpers(e);
    const out = (await e.evaluate({}, { state: { seed: 3, loot: [{ name: "or", w: 1 }, { name: "rien", w: 0 }], got: [] }, action: { type: "open" } })) as { got: string[]; seed: number };
    expect(out.got).toEqual(["or"]);
    expect(out.seed).not.toBe(3);
    const lvl = /New maze level on demand:\n\n```jsonata\n([\s\S]*?)\n```/.exec(doc)![1];
    const e2 = (jsonata as unknown as (s: string) => import("jsonata").Expression)(lvl);
    registerAlgoHelpers(e2);
    const l = (await e2.evaluate({}, { state: { level: 1 }, action: { type: "next" } })) as { level: number; map: string[] };
    expect([l.level, l.map.length]).toEqual([2, 17]);
  });
});

describe("lot 2 : WFC, Voronoï, Delaunay, plateaux", () => {
  it("WFC n'emploie que des voisinages vus dans l'exemple", async () => {
    const sample = ["~~~~~~", "~...~~", "~.^^.~", "~.^^.~", "~....~", "~~~~~~"];
    const out = (await run(`$genWfc(s, 30, 20, 4)`, { s: sample })) as string[];
    expect([out[0].length, out.length]).toEqual([30, 20]);
    const pairs = new Set<string>();
    const add = (rows: string[]) => rows.forEach((r, y) => [...r].forEach((c, x) => {
      if (x + 1 < r.length) pairs.add("h" + c + r[x + 1]);
      if (y + 1 < rows.length) pairs.add("v" + c + rows[y + 1][x]);
    }));
    add(sample);
    const seen = new Set(pairs);
    pairs.clear();
    add(out);
    for (const p of pairs) expect(seen.has(p)).toBe(true);
    expect(await run(`$genWfc(s, 30, 20, 4)`, { s: sample })).toEqual(out);
    const fixed = (await run(`$genWfc(s, 6, 4, 1, {"fixed": ["?????^"]})`, { s: sample })) as string[];
    expect(fixed[0][5]).toBe("^");
    await expect(run(`$genWfc(s, 6, 4, 1, {"fixed": ["Z"]})`, { s: sample })).rejects.toThrow(/imposées/);
  });

  it("Voronoï relaxé : autant de régions que de sites", async () => {
    const v = (await run(`$genVoronoi(40, 30, 2, {"count": 6, "relax": 2, "values": "abcdef"})`)) as { rows: string[]; sites: number[][] };
    expect(v.sites.length).toBe(6);
    const chars = new Set(v.rows.join(""));
    expect(chars.size).toBe(6);
  });

  it("Delaunay et arbre couvrant minimal", async () => {
    const pts = [[0, 0], [10, 0], [0, 10], [10, 10], [5, 5]];
    const d = (await run(`$delaunay(p)`, { p: pts })) as { triangles: number[][]; edges: number[][] };
    expect(d.triangles.length).toBe(4);
    expect(d.edges.length).toBe(8);
    const m = (await run(`$mst(p)`, { p: pts })) as number[][];
    expect(m.length).toBe(4);
    expect(m.every((e) => e.includes(4))).toBe(true);
    expect(((await run(`$mst([[0,0],[2,0],[1,0]])`)) as number[][]).length).toBe(2);
  });

  it("morpion : vainqueur, coups, minimax parfait", async () => {
    expect(await run(`$boardWinner(["xxx", "oo.", "..."])`)).toMatchObject({ winner: "x", line: [[0, 0], [1, 0], [2, 0]], draw: false });
    expect(await run(`$boardWinner(["xox", "xoo", "oxx"])`)).toMatchObject({ winner: null, draw: true });
    // gagner tout de suite
    expect(((await run(`$boardBest(["xx.", "oo.", "..."], "x")`)) as { move: number[] }).move).toEqual([2, 0]);
    // parer
    expect(((await run(`$boardBest(["x..", "oo.", "x.."], "x")`)) as { move: number[] }).move).toEqual([2, 1]);
    // partie complète minimax contre minimax : nulle
    let b: unknown = ["...", "...", "..."];
    let p = "x";
    for (let i = 0; i < 9; i++) {
      const best = (await run(`$boardBest(b, p)`, { b, p })) as { move: number[] } | undefined;
      if (!best) break;
      b = await run(`$boardPlay(b, m, p)`, { b, m: best.move, p });
      p = p === "x" ? "o" : "x";
    }
    expect(await run(`$boardWinner(b)`, { b })).toMatchObject({ winner: null, draw: true });
  });

  it("puissance 4 avec gravité : coup en colonne, parade, MCTS", async () => {
    const empty = Array(6).fill(".......");
    const b1 = (await run(`$boardPlay(b, 3, "x", {"gravity": true})`, { b: empty })) as string[];
    expect(b1[5]).toBe("...x...");
    const b = [".......", ".......", ".......", ".......", ".......", "xxx.oo."];
    expect(((await run(`$boardBest(b, "o", {"gravity": true})`, { b })) as { column: number }).column).toBe(3);
    expect(((await run(`$boardBest(b, "o", {"gravity": true, "algo": "mcts", "seed": 3})`, { b })) as { column: number }).column).toBe(3);
    const t = ["..x....", "..o....", "..x....", "..o.o..", "..xxo..", ".oxxoxo"];
    const r = (await run(`$boardBest(b, "x", {"gravity": true, "ms": 50})`, { b: t })) as { depth: number; nodes: number };
    expect(r.depth).toBeGreaterThan(3);
  });
});

describe("recette plateau de algo.md", () => {
  it("le joueur joue une colonne, l'ordinateur répond, un coup interdit ne change rien", async () => {
    const doc = readFileSync("src/addons/interactive/algo.md", "utf8");
    const expr = /Computer turn in a reducer:\n\n```jsonata\n([\s\S]*?)\n```/.exec(doc)![1];
    const e = (jsonata as unknown as (s: string) => import("jsonata").Expression)(expr);
    registerAlgoHelpers(e);
    const board = Array(6).fill(".......");
    const s1 = (await e.evaluate({}, { state: { board, level: 4 }, action: { type: "play", payload: { column: 3 } } })) as { board: string[] };
    expect(s1.board.join("").split("x").length - 1).toBe(1);
    expect(s1.board.join("").split("o").length - 1).toBe(1);
    const full = ["x......", "o......", "x......", "o......", "x......", "o......"];
    const s2 = (await e.evaluate({}, { state: { board: full, level: 4 }, action: { type: "play", payload: { column: 0 } } })) as { board: string[] };
    expect(s2.board).toEqual(full);
  });
});
