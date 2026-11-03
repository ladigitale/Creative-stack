import { describe, expect, it } from "vitest";
import { assignPath, compileMap, evalMap } from "./map-expr";

const data = { right: { x: 0.5, y: 0.2, present: 1 }, left: { present: 0, y: 0.25 }, n: 4 };
const run = (src: string) => evalMap(compileMap(src), data);

describe("compileMap / evalMap", () => {
  it("arithmétique et chemins", () => {
    expect(run("cents=right.x*3600")).toEqual({ cents: 1800 });
    expect(run("a=1+2*3; b=(1+2)*3; c=-n+10; d=n%3")).toEqual({ a: 7, b: 9, c: 6, d: 1 });
  });
  it("ternaire et logique", () => {
    expect(run("g=left.present ? 1-left.y : 0")).toEqual({ g: 0 });
    expect(run("g=right.present ? 1-right.y : 0")).toEqual({ g: 0.8 });
    expect(run("a=right.present && right.x>0.4; b=left.present || right.x<0.1; c=!left.present")).toEqual({ a: 1, b: 0, c: 1 });
  });
  it("fonctions", () => {
    expect(run("a=clamp(right.x*4,0,1); b=mix(10,20,0.5); c=min(1,2,3); d=log2(8); e=abs(-2)")).toEqual({
      a: 1,
      b: 15,
      c: 1,
      d: 3,
      e: 2,
    });
  });
  it("chemin ou division absents → 0, jamais NaN", () => {
    expect(run("a=nope.x+1; b=1/0; c=right.nada")).toEqual({ a: 1, b: 0, c: 0 });
  });
  it("clés pointées", () => {
    expect(run("play.cents=right.x")).toEqual({ "play.cents": 0.5 });
  });
  it("erreurs de syntaxe signalées, pas d'exception", () => {
    for (const bad of ["a=", "a=1+", "x", "a=foo(1)", "1a=2", "a=1 2", "a=(1", "a=1 ? 2", "a=1 $ 2"]) {
      const c = compileMap(bad);
      expect(c.ok, bad).toBe(false);
      expect(evalMap(c, data)).toEqual({});
    }
  });
  it("clés dangereuses refusées (pas de pollution de prototype)", () => {
    for (const bad of ["__proto__.x=1", "a.constructor.b=1", "prototype=2"]) expect(compileMap(bad).ok, bad).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it("pas d'évaluation de code : identifiants globaux inertes", () => {
    expect(run("a=constructor.name+1; b=window.x; c=__proto__.x")).toEqual({ a: 1, b: 0, c: 0 });
  });
});

describe("assignPath", () => {
  it("crée les niveaux manquants, ignore les clés dangereuses", () => {
    const o: Record<string, unknown> = {};
    assignPath(o, "a.b.c", 1);
    expect(o).toEqual({ a: { b: { c: 1 } } });
    assignPath(o, "__proto__.x", 2);
    assignPath(o, "a.constructor.y", 3);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(o).toEqual({ a: { b: { c: 1 } } });
  });
});
