/**
 * Expressions sûres des recettes : `"= height * 0.11 + rand(0, 0.02)"`.
 *
 * Analyseur maison (aucun `eval`, aucun `new Function`) : nombres, chaînes entre guillemets simples, variables
 * (paramètres et variables de contexte), `+ - * / % ^`, comparaisons, `and or not`, `cond ? a : b`, appels de fonctions
 * de la liste blanche ci-dessous. Une expression invalide ne lève pas : elle vaut sa valeur de repli et une `issue`
 * est publiée.
 */
import type { Rng } from "./rng";
import { noise2 } from "../geom/noise";

export type Value = number | string | boolean;
export type Scope = { vars: Record<string, unknown>; rng: Rng };

type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "var"; name: string }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "tern"; c: Node; a: Node; b: Node }
  | { k: "call"; fn: string; args: Node[] };

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v) || 0);

export const FUNCTIONS: Record<string, { arity: [number, number]; doc: string; fn: (s: Scope, a: Value[]) => Value }> = {
  min: { arity: [1, 16], doc: "plus petit", fn: (_, a) => Math.min(...a.map(num)) },
  max: { arity: [1, 16], doc: "plus grand", fn: (_, a) => Math.max(...a.map(num)) },
  clamp: { arity: [3, 3], doc: "clamp(x, a, b)", fn: (_, [x, a, b]) => Math.min(num(b), Math.max(num(a), num(x))) },
  mix: { arity: [3, 3], doc: "mix(a, b, t)", fn: (_, [a, b, t]) => num(a) + (num(b) - num(a)) * num(t) },
  abs: { arity: [1, 1], doc: "valeur absolue", fn: (_, [x]) => Math.abs(num(x)) },
  floor: { arity: [1, 1], doc: "partie entière", fn: (_, [x]) => Math.floor(num(x)) },
  round: { arity: [1, 1], doc: "arrondi", fn: (_, [x]) => Math.round(num(x)) },
  sqrt: { arity: [1, 1], doc: "racine", fn: (_, [x]) => Math.sqrt(Math.max(0, num(x))) },
  pow: { arity: [2, 2], doc: "puissance", fn: (_, [x, y]) => Math.pow(num(x), num(y)) },
  sin: { arity: [1, 1], doc: "sinus (degrés)", fn: (_, [x]) => Math.sin((num(x) * Math.PI) / 180) },
  cos: { arity: [1, 1], doc: "cosinus (degrés)", fn: (_, [x]) => Math.cos((num(x) * Math.PI) / 180) },
  rand: { arity: [0, 2], doc: "rand() ∈ [0,1[, rand(a, b)", fn: (s, a) => (a.length === 2 ? s.rng.range(num(a[0]), num(a[1])) : a.length === 1 ? s.rng.range(0, num(a[0])) : s.rng.next()) },
  randint: { arity: [2, 2], doc: "entier dans [a, b]", fn: (s, [a, b]) => s.rng.int(num(a), num(b)) },
  pick: { arity: [1, 32], doc: "une des valeurs au hasard", fn: (s, a) => s.rng.pick(a) },
  chance: { arity: [1, 1], doc: "vrai avec la probabilité p", fn: (s, [p]) => s.rng.chance(num(p)) },
  noise: { arity: [2, 2], doc: "bruit lisse en (x, y), ∈ [-1, 1]", fn: (_, [x, y]) => noise2(num(x), num(y)) },
};

const RESERVED = new Set(["and", "or", "not", "true", "false", "pi"]);

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+)|('(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|==|!=|&&|\|\||[-+*/%^(),?:<>!]))/y;
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      i++;
      continue;
    }
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`caractère inattendu « ${src[i]} » en position ${i}`);
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
    i = re.lastIndex;
  }
  return out;
}

const PREC: Record<string, number> = { "||": 1, or: 1, "&&": 2, and: 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "^": 8 };

function parse(tokens: string[]): Node {
  let p = 0;
  const peek = () => tokens[p];
  const eat = (t?: string) => {
    const v = tokens[p++];
    if (t && v !== t) throw new Error(`« ${t} » attendu, « ${v ?? "fin"} » trouvé`);
    return v;
  };
  const primary = (): Node => {
    const t = eat();
    if (t === undefined) throw new Error("expression incomplète");
    if (t === "(") {
      const e = expr(0);
      eat(")");
      return e;
    }
    if (t === "-" || t === "!" || t === "not") return { k: "un", op: t === "-" ? "-" : "!", a: binary(7) };
    if (/^[\d.]/.test(t)) return { k: "num", v: Number(t) };
    if (t[0] === "'") return { k: "str", v: t.slice(1, -1).replace(/\\(.)/g, "$1") };
    if (t === "true" || t === "false") return { k: "num", v: t === "true" ? 1 : 0 };
    if (t === "pi") return { k: "num", v: Math.PI };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === "(") {
        eat("(");
        const args: Node[] = [];
        if (peek() !== ")") {
          for (;;) {
            args.push(expr(0));
            if (peek() === ",") eat(",");
            else break;
          }
        }
        eat(")");
        const f = FUNCTIONS[t];
        if (!f) throw new Error(`fonction inconnue « ${t} » (connues : ${Object.keys(FUNCTIONS).join(", ")})`);
        if (args.length < f.arity[0] || args.length > f.arity[1]) throw new Error(`${t} : ${args.length} argument(s), attendu ${f.arity[0]}–${f.arity[1]}`);
        return { k: "call", fn: t, args };
      }
      if (RESERVED.has(t)) throw new Error(`mot réservé « ${t} »`);
      return { k: "var", name: t };
    }
    throw new Error(`« ${t} » inattendu`);
  };
  const binary = (minPrec: number): Node => {
    let left = primary();
    for (;;) {
      const op = peek();
      const pr = op !== undefined ? PREC[op] : undefined;
      if (pr === undefined || pr < minPrec) break;
      eat();
      const right = binary(op === "^" ? pr : pr + 1);
      left = { k: "bin", op, a: left, b: right };
    }
    return left;
  };
  const expr = (minPrec: number): Node => {
    const c = binary(minPrec || 1);
    if (peek() === "?") {
      eat("?");
      const a = expr(0);
      eat(":");
      const b = expr(0);
      return { k: "tern", c, a, b };
    }
    return c;
  };
  const e = expr(0);
  if (p < tokens.length) throw new Error(`« ${tokens[p]} » inattendu`);
  return e;
}

const own = (o: unknown, k: string) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

/** Lecture de variable : propriétés **propres** seulement (jamais la chaîne de prototypes : pas de `constructor`). */
function lookup(vars: Record<string, unknown>, name: string): unknown {
  if (own(vars, name)) return vars[name];
  let cur: unknown = vars;
  for (const part of name.split(".")) {
    if (own(cur, part) && !["__proto__", "prototype", "constructor"].includes(part)) cur = (cur as Record<string, unknown>)[part];
    else throw new Error(`variable inconnue « ${name} » (connues : ${Object.keys(vars).slice(0, 20).join(", ")})`);
  }
  return cur;
}

function evalNode(n: Node, s: Scope): Value {
  switch (n.k) {
    case "num":
    case "str":
      return n.v;
    case "var": {
      const v = lookup(s.vars, n.name);
      return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : num(v);
    }
    case "un": {
      const a = evalNode(n.a, s);
      return n.op === "-" ? -num(a) : !num(a);
    }
    case "tern":
      return num(evalNode(n.c, s)) ? evalNode(n.a, s) : evalNode(n.b, s);
    case "call":
      return FUNCTIONS[n.fn].fn(s, n.args.map((a) => evalNode(a, s)));
    case "bin": {
      if (n.op === "&&" || n.op === "and") return !!num(evalNode(n.a, s)) && !!num(evalNode(n.b, s));
      if (n.op === "||" || n.op === "or") return !!num(evalNode(n.a, s)) || !!num(evalNode(n.b, s));
      const a = evalNode(n.a, s);
      const b = evalNode(n.b, s);
      switch (n.op) {
        case "+":
          return typeof a === "string" || typeof b === "string" ? `${a}${b}` : num(a) + num(b);
        case "-": return num(a) - num(b);
        case "*": return num(a) * num(b);
        case "/": return num(b) === 0 ? 0 : num(a) / num(b);
        case "%": return num(b) === 0 ? 0 : num(a) % num(b);
        case "^": return Math.pow(num(a), num(b));
        case "==": return a === b || (typeof a !== "string" && typeof b !== "string" && num(a) === num(b));
        case "!=": return !(a === b || (typeof a !== "string" && typeof b !== "string" && num(a) === num(b)));
        case "<": return num(a) < num(b);
        case ">": return num(a) > num(b);
        case "<=": return num(a) <= num(b);
        case ">=": return num(a) >= num(b);
      }
    }
  }
  return 0;
}

const cache = new Map<string, Node | Error>();

/** Compile (avec cache) une expression ; lève une `Error` lisible si elle est invalide. */
export function compile(src: string): Node {
  let c = cache.get(src);
  if (!c) {
    try {
      c = parse(tokenize(src));
    } catch (e) {
      c = e instanceof Error ? e : new Error(String(e));
    }
    if (cache.size > 4000) cache.clear();
    cache.set(src, c);
  }
  if (c instanceof Error) throw c;
  return c;
}

/** Vrai si la valeur est une expression (`"= …"`). */
export const isExpr = (v: unknown): v is string => typeof v === "string" && v.trimStart().startsWith("=");

/** Évalue une expression (avec ou sans le `=` initial). */
export function evaluate(src: string, scope: Scope): Value {
  const body = src.trimStart().startsWith("=") ? src.trimStart().slice(1) : src;
  return evalNode(compile(body), scope);
}

/**
 * Résout récursivement une valeur de recette : les chaînes `"= …"` sont évaluées, les tableaux et objets parcourus.
 * Les erreurs remontent via `onError` (le chemin est fourni) et la valeur devient `fallback`.
 */
export function resolveDeep(v: unknown, scope: Scope, onError: (path: string, msg: string) => void, path = "", fallback: unknown = 0): unknown {
  if (isExpr(v)) {
    try {
      return evaluate(v, scope);
    } catch (e) {
      onError(path, (e as Error).message);
      return fallback;
    }
  }
  if (Array.isArray(v)) return v.map((x, i) => resolveDeep(x, scope, onError, `${path}[${i}]`, fallback));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = resolveDeep(x, scope, onError, path ? `${path}.${k}` : k, fallback);
    return o;
  }
  return v;
}
