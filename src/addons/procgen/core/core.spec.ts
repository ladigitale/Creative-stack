import { describe, expect, it } from "vitest";
import { evaluate, isExpr, resolveDeep } from "./expr";
import { Rng } from "./rng";
import { Issues, resolveParams } from "./schema";

const scope = (vars: Record<string, unknown> = {}, seed = "1") => ({ vars, rng: new Rng(seed) });

describe("rng", () => {
  it("même graine → même suite ; sous-graines indépendantes de l'ordre de tirage", () => {
    const a = new Rng(7), b = new Rng(7);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
    const r1 = new Rng("s");
    r1.next();
    r1.next();
    expect(r1.fork("maison").fork(3).next()).toBe(new Rng("s").fork("maison").fork(3).next());
  });
  it("répartition grossièrement uniforme", () => {
    const r = new Rng(1);
    let s = 0;
    for (let i = 0; i < 10000; i++) s += r.next();
    expect(Math.abs(s / 10000 - 0.5)).toBeLessThan(0.02);
  });
});

describe("expressions sûres", () => {
  it("arithmétique, priorités, ternaire, fonctions, chaînes", () => {
    expect(evaluate("= 2 + 3 * 4 ^ 2", scope())).toBe(50);
    expect(evaluate("= h * 0.5 > 1 ? 'grand' : 'petit'", scope({ h: 3 }))).toBe("grand");
    expect(evaluate("= clamp(x, 0, 1) + max(1, 2, 3)", scope({ x: 9 }))).toBe(4);
    expect(evaluate("= -(2 - 5)", scope())).toBe(3);
    expect(evaluate("= a.b + 1", scope({ a: { b: 2 } }))).toBe(3);
  });
  it("aléa déterministe par graine", () => {
    expect(evaluate("= rand(0, 10)", scope({}, "x"))).toBe(evaluate("= rand(0, 10)", scope({}, "x")));
    expect(["a", "b"]).toContain(evaluate("= pick('a', 'b')", scope()));
  });
  it("aucun accès au JavaScript : identifiants inconnus et syntaxe hostile refusés", () => {
    expect(() => evaluate("= constructor", scope())).toThrow(/inconnue/);
    expect(() => evaluate("= toString", scope())).toThrow(/inconnue/);
    expect(() => evaluate("= a.__proto__", scope({ a: {} }))).toThrow(/inconnue/);
    expect(() => evaluate("= alert(1)", scope())).toThrow(/fonction inconnue/);
    expect(() => evaluate("= x[0]", scope({ x: [1] }))).toThrow();
    expect(() => evaluate("= `x`", scope())).toThrow();
  });
  it("resolveDeep : erreurs signalées avec leur chemin, valeur de repli", () => {
    const errs: string[] = [];
    const out = resolveDeep({ a: "= 1 +", b: ["= 2 * 2"] }, scope(), (p) => errs.push(p), "", -1) as { a: number; b: number[] };
    expect(out).toEqual({ a: -1, b: [4] });
    expect(errs).toEqual(["a"]);
    expect(isExpr("= 1")).toBe(true);
    expect(isExpr("1")).toBe(false);
  });
});

describe("paramètres typés", () => {
  const schema = {
    floors: { type: "int", default: 2, min: 1, max: 6, doc: "" },
    style: { type: "enum", default: "bourg", options: ["bourg", "vapeur"], doc: "" },
    lean: { type: "number", default: 0, doc: "" },
  } as const;
  it("défauts, bornes, énumérations, expressions ; problèmes structurés avec suggestion", () => {
    const issues = new Issues();
    const p = resolveParams(schema, { floors: 12, style: "vapuer", laen: 3, lean: "= floors / 4" }, scope(), issues);
    expect(p.floors).toBe(6);
    expect(p.style).toBe("bourg");
    expect(p.lean).toBe(1.5);
    const byCode = Object.fromEntries(issues.list.map((i) => [i.path, i]));
    expect(byCode["params.floors"]).toMatchObject({ code: "clamped", got: 12, used: 6 });
    expect(byCode["params.style"]).toMatchObject({ code: "unknown", didYouMean: "vapeur" });
    expect(byCode["params.laen"]).toMatchObject({ code: "unknown", didYouMean: "lean" });
  });
});
