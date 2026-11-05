import { describe, expect, it } from "vitest";
import { NO_RULE, TriggerMachine, matchesRule, readPath } from "./trigger-core";

const rule = (r: Partial<typeof NO_RULE>) => ({ ...NO_RULE, ...r });

describe("readPath", () => {
  it("chemin pointé, tableaux par indice, valeur entière si vide", () => {
    const v = { labels: { person: 2 }, faces: [{ blend: { jawOpen: 0.4 } }] };
    expect(readPath(v, "labels.person")).toBe(2);
    expect(readPath(v, "faces.0.blend.jawOpen")).toBe(0.4);
    expect(readPath(v, "")).toBe(v);
    expect(readPath(v, "labels.cup")).toBeUndefined();
    expect(readPath(null, "a")).toBeUndefined();
    expect(readPath(v, "labels.person.x")).toBeUndefined();
  });

  it("refuse les chemins qui sortent des données", () => {
    expect(readPath({}, "__proto__")).toBeUndefined();
    expect(readPath({ a: 1 }, "constructor")).toBeUndefined();
    expect(readPath({}, "a.constructor.name")).toBeUndefined();
  });
});

describe("matchesRule", () => {
  it("sans opérateur : valeur vraie", () => {
    expect(matchesRule(true, NO_RULE)).toBe(true);
    expect(matchesRule(false, NO_RULE)).toBe(false);
    expect(matchesRule("false", NO_RULE)).toBe(false);
    expect(matchesRule("0", NO_RULE)).toBe(false);
    expect(matchesRule(0, NO_RULE)).toBe(false);
    expect(matchesRule(3, NO_RULE)).toBe(true);
    expect(matchesRule(undefined, NO_RULE)).toBe(false);
  });

  it("égalité et différence", () => {
    expect(matchesRule("Victory", rule({ equals: "Victory" }))).toBe(true);
    expect(matchesRule("None", rule({ equals: "Victory" }))).toBe(false);
    expect(matchesRule("None", rule({ not: "None" }))).toBe(false);
    expect(matchesRule("Open_Palm", rule({ not: "None" }))).toBe(true);
    expect(matchesRule(undefined, rule({ not: "None" }))).toBe(false); // pas de valeur : pas de déclenchement
  });

  it("seuils numériques, valeurs non numériques refusées", () => {
    expect(matchesRule(-20, rule({ gt: "-30" }))).toBe(true);
    expect(matchesRule(-40, rule({ gt: "-30" }))).toBe(false);
    expect(matchesRule(1, rule({ gte: "1" }))).toBe(true);
    expect(matchesRule(1, rule({ lt: "1" }))).toBe(false);
    expect(matchesRule(1, rule({ lte: "1" }))).toBe(true);
    expect(matchesRule(undefined, rule({ lt: "5" }))).toBe(false);
    expect(matchesRule("", rule({ lt: "5" }))).toBe(false);
    expect(matchesRule("abc", rule({ gt: "1" }))).toBe(false);
    expect(matchesRule(5, rule({ gt: "x" }))).toBe(false);
  });

  it("plusieurs opérateurs : tous doivent être vrais (fenêtre)", () => {
    const r = rule({ gt: "0.2", lt: "0.8" });
    expect(matchesRule(0.5, r)).toBe(true);
    expect(matchesRule(0.9, r)).toBe(false);
    expect(matchesRule(0.1, r)).toBe(false);
  });
});

describe("TriggerMachine", () => {
  const edge = (holdMs = 0, cooldownMs = 0) => new TriggerMachine({ holdMs, cooldownMs, mode: "edge" });

  it("un seul déclenchement par franchissement, puis réarmement", () => {
    const m = edge();
    expect(m.step(0, true)).toEqual(["fire"]);
    expect(m.step(100, true)).toEqual([]);
    expect(m.step(200, true)).toEqual([]);
    expect(m.step(300, false)).toEqual(["end"]);
    expect(m.step(400, true)).toEqual(["fire"]);
    expect(m.count).toBe(2);
  });

  it("maintien : pas de déclenchement si la condition retombe avant", () => {
    const m = edge(500);
    expect(m.step(0, true)).toEqual([]);
    expect(m.step(300, true)).toEqual([]);
    expect(m.step(350, false)).toEqual([]);
    expect(m.step(400, true)).toEqual([]);
    expect(m.step(899, true)).toEqual([]);
    expect(m.step(900, true)).toEqual(["fire"]);
    expect(m.count).toBe(1);
  });

  it("repos : un franchissement trop proche est différé, pas perdu", () => {
    const m = edge(0, 1000);
    expect(m.step(0, true)).toEqual(["fire"]);
    expect(m.step(100, false)).toEqual(["end"]);
    expect(m.step(200, true)).toEqual([]);
    expect(m.step(900, true)).toEqual([]);
    expect(m.step(1000, true)).toEqual(["fire"]);
  });

  it("repeat : répète à chaque repos tant que la condition tient", () => {
    const m = new TriggerMachine({ holdMs: 0, cooldownMs: 500, mode: "repeat" });
    expect(m.step(0, true)).toEqual(["fire"]);
    expect(m.step(400, true)).toEqual([]);
    expect(m.step(500, true)).toEqual(["fire"]);
    expect(m.step(1000, true)).toEqual(["fire"]);
    expect(m.count).toBe(3);
  });

  it("« end » seulement après un déclenchement", () => {
    const m = edge(500);
    expect(m.step(0, true)).toEqual([]);
    expect(m.step(100, false)).toEqual([]);
  });

  it("état exposé et remise à zéro", () => {
    const m = edge();
    m.step(0, true);
    expect(m).toMatchObject({ active: true, armed: false, count: 1 });
    m.reset();
    expect(m).toMatchObject({ active: false, armed: true, count: 0 });
    expect(m.step(10, true)).toEqual(["fire"]);
  });
});
