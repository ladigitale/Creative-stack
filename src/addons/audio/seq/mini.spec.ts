import { describe, expect, it } from "vitest";
import { degreeToMidi, euclid, eventsForCycle, parseLine, parseScale, queryCycle } from "./mini";

/** Rend les événements d'un cycle sous forme compacte : "valeur@début" (début en 16es). */
function render(src: string, cycle = 0, seed = 0): string {
  const { ast, errors } = parseLine(src);
  if (errors.length) return "ERR " + errors.join(" | ");
  return eventsForCycle(ast, cycle, seed)
    .map((e) => `${e.value}@${+(e.start * 16).toFixed(3)}`)
    .join(" ");
}

function durations(src: string, cycle = 0): string {
  const { ast } = parseLine(src);
  return queryCycle(ast, cycle)
    .sort((a, b) => a.start - b.start)
    .map((e) => `${e.value}:${+((e.end - e.start) * 16).toFixed(3)}`)
    .join(" ");
}

describe("mini-notation : cas", () => {
  const cases: [string, string, number?][] = [
    // grilles
    ["x...x...x...x...", "x@0 x@4 x@8 x@12"],
    ["x.x.", "x@0 x@8"],
    ["X..x", "X@0 x@12"],
    ["....", ""],
    ["x-..", "x@0"],
    ["~x~x", "x@4 x@12"],
    ["[..x.]*4", "x@2 x@6 x@10 x@14"],
    ["x.. <x. ..>", "x@0 x@8", 0],
    ["c4 [x.x.]", "c4@0 x@8 x@12"],
    // séquences
    ["c4 e4 g4 b4", "c4@0 e4@4 g4@8 b4@12"],
    ["c4", "c4@0"],
    ["c4 e4", "c4@0 e4@8"],
    ["c4 ~ e4 ~", "c4@0 e4@8"],
    ["c4 . e4 .", "c4@0 e4@8"],
    ["  c4   e4  ", "c4@0 e4@8"],
    ["c4 | e4", "c4@0 e4@8"],
    // sous-division
    ["c4 [e4 g4]", "c4@0 e4@8 g4@12"],
    ["[c4 e4] [g4 b4 d5 f5]", "c4@0 e4@4 g4@8 b4@10 d5@12 f5@14"],
    ["[[c4 e4] g4] b4", "c4@0 e4@2 g4@4 b4@8"],
    ["[~ x] x", "x@4 x@8"],
    // tenues
    ["c4 - e4 g4", "c4@0 e4@8 g4@12"],
    ["c4 _ _ e4", "c4@0 e4@12"],
    // répétition, duplication, poids
    ["x*4", "x@0 x@4 x@8 x@12"],
    ["x*2 e4", "x@0 x@4 e4@8"],
    ["c4!3 e4", "c4@0 c4@4 c4@8 e4@12"],
    ["c4! e4", "c4@0 c4@5.333 e4@10.667"],
    ["c4@3 e4", "c4@0 e4@12"],
    ["[c4 e4]*2", "c4@0 e4@4 c4@8 e4@12"],
    // alternance
    ["<c4 e4 g4>", "c4@0", 0],
    ["<c4 e4 g4>", "e4@0", 1],
    ["<c4 e4 g4>", "g4@0", 2],
    ["<c4 e4 g4>", "c4@0", 3],
    ["x <e4 g4>", "x@0 g4@8", 1],
    ["<c4 [e4 g4]>", "e4@0 g4@8", 1],
    // euclide
    ["x(3,8)", "x@0 x@6 x@12"],
    ["x(4,16)", "x@0 x@4 x@8 x@12"],
    ["x(3,8,2)", "x@2 x@8 x@12"],
    ["x(0,8)", ""],
    ["c4(2,4) e4", "c4@0 c4@4 e4@8"],
    // superposition
    ["[c4, e4, g4]", "c4@0 e4@0 g4@0"],
    ["c4 e4, x*2", "c4@0 x@0 e4@8 x@8"],
    ["c4+e4+g4 b4", "c4+e4+g4@0 b4@8"],
    // degrés et nombres
    ["0 2 4 7", "0@0 2@4 4@8 7@12"],
    ["-1 0", "-1@0 0@8"],
    // probabilités (graine 0) : déterministes
    ["x?1 x?0", "x@0"],
  ];
  for (const [src, expected, cycle] of cases) {
    it(`"${src}"${cycle ? ` (cycle ${cycle})` : ""}`, () => {
      expect(render(src, cycle ?? 0)).toBe(expected);
    });
  }
});

describe("mini-notation : durées", () => {
  it("tenues et poids allongent les événements", () => {
    expect(durations("c4 - e4 g4")).toBe("c4:8 e4:4 g4:4");
    expect(durations("x--.")).toBe("x:12");
    expect(durations("c4@3 e4")).toBe("c4:12 e4:4");
  });
});

describe("mini-notation : erreurs", () => {
  const bad: [string, string][] = [
    ["[c4 e4", '"]" manquant'],
    ["c4 e4]", '"]" sans ouverture'],
    ["<c4", '">" manquant'],
    ["x(3)", "euclide"],
    ["x(9,8)", "0 ≤ k ≤ n"],
    ["x*0", '"*" : nombre ≥ 1'],
    ["x@0", '"@" : poids > 0'],
    ["c4 $ e4", 'caractère "$" inattendu'],
    ["x(3,8", '")" manquant'],
  ];
  for (const [src, msg] of bad) {
    it(`"${src}" → ${msg}`, () => {
      expect(parseLine(src).errors.join(" | ")).toContain(msg);
    });
  }
  it("ligne trop longue tronquée et signalée", () => {
    expect(parseLine("x ".repeat(3000)).errors.join()).toContain("trop longue");
  });
});

describe("probabilités : même graine, même musique", () => {
  it("déterministe et dépendant de la graine", () => {
    const line = "x?0.5*16";
    const a = [0, 1, 2, 3].map((c) => render(line, c, 42));
    const b = [0, 1, 2, 3].map((c) => render(line, c, 42));
    const other = [0, 1, 2, 3].map((c) => render(line, c, 7));
    expect(a).toEqual(b);
    expect(a).not.toEqual(other);
    const count = a.join(" ").split("x@").length - 1;
    expect(count).toBeGreaterThan(16);
    expect(count).toBeLessThan(48);
  });
});

describe("euclide et gammes", () => {
  it("bjorklund", () => {
    const s = (k: number, n: number, r = 0) => euclid(k, n, r).map((b) => (b ? "x" : ".")).join("");
    expect(s(3, 8)).toBe("x..x..x.");
    expect(s(5, 8)).toBe("x.xx.xx.");
    expect(s(2, 5)).toBe("x.x..");
    expect(s(3, 8, 1)).toBe("..x..x.x");
  });

  it("gammes et degrés", () => {
    const am = parseScale("a:minor-pentatonic")!;
    expect(am.root).toBe(69);
    expect([0, 1, 2, 3, 4, 5, -1].map((d) => degreeToMidi(d, am))).toEqual([69, 72, 74, 76, 79, 81, 67]);
    expect(parseScale("c3:major")!.root).toBe(48);
    expect(parseScale("eb:dorian", 2)!.root).toBe(39);
    expect(parseScale("h:major")).toBeNull();
    expect(parseScale("c:kazoo")).toBeNull();
  });
});
