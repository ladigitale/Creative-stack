/**
 * Mini-langage d'expressions pour l'attribut `map` des trackers :
 *   map="cents=right.x*3600; gain=left.present ? 1-left.y : 0"
 * Sans `eval` ni `new Function` (CSP stricte) : analyseur récursif descendant → arbre → évaluation.
 * Nombres, chemins pointés dans les données (`right.x`), + - * / %, comparaisons, && || !, ?:, parenthèses,
 * fonctions min max abs clamp mix pow sqrt floor round log2 sign. Valeur manquante = 0, booléen = 1 / 0.
 */

type Node =
  | { t: "num"; v: number }
  | { t: "path"; v: string[] }
  | { t: "un"; op: "-" | "!"; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "cond"; c: Node; a: Node; b: Node }
  | { t: "call"; fn: string; args: Node[] };

export type MapAssign = { key: string; node: Node };
export type CompiledMap = { ok: true; assigns: MapAssign[] } | { ok: false; error: string };

const FUNCS: Record<string, (...a: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  pow: Math.pow,
  sqrt: Math.sqrt,
  floor: Math.floor,
  round: Math.round,
  log2: Math.log2,
  sign: Math.sign,
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  mix: (a, b, t) => a + (b - a) * t,
};

type Tok = { k: "num" | "id" | "op" | "end"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(&&|\|\||==|!=|<=|>=|[-+*/%<>!?:(),]))/giy;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new Error(`caractère inattendu « ${src.slice(pos).trim()[0]} »`);
    }
    pos = re.lastIndex;
    if (m[1] !== undefined) out.push({ k: "num", v: m[1] });
    else if (m[2] !== undefined) out.push({ k: "id", v: m[2] });
    else out.push({ k: "op", v: m[3] });
  }
  out.push({ k: "end", v: "" });
  return out;
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  private peek() {
    return this.toks[this.i];
  }
  private eat(v?: string): Tok {
    const t = this.toks[this.i];
    if (v !== undefined && t.v !== v) throw new Error(`« ${v} » attendu`);
    this.i++;
    return t;
  }
  private isOp(v: string) {
    const t = this.peek();
    return t.k === "op" && t.v === v;
  }

  parseAll(): Node {
    const n = this.ternary();
    if (this.peek().k !== "end") throw new Error(`« ${this.peek().v} » inattendu`);
    return n;
  }

  private ternary(): Node {
    const c = this.or();
    if (this.isOp("?")) {
      this.eat("?");
      const a = this.ternary();
      this.eat(":");
      const b = this.ternary();
      return { t: "cond", c, a, b };
    }
    return c;
  }
  private binLevel(next: () => Node, ops: string[]): Node {
    let a = next();
    while (this.peek().k === "op" && ops.includes(this.peek().v)) {
      const op = this.eat().v;
      a = { t: "bin", op, a, b: next() };
    }
    return a;
  }
  private or = () => this.binLevel(() => this.and(), ["||"]);
  private and = () => this.binLevel(() => this.eq(), ["&&"]);
  private eq = () => this.binLevel(() => this.cmp(), ["==", "!="]);
  private cmp = () => this.binLevel(() => this.add(), ["<", ">", "<=", ">="]);
  private add = () => this.binLevel(() => this.mul(), ["+", "-"]);
  private mul = () => this.binLevel(() => this.unary(), ["*", "/", "%"]);

  private unary(): Node {
    if (this.isOp("-") || this.isOp("!")) {
      const op = this.eat().v as "-" | "!";
      return { t: "un", op, a: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.eat();
    if (t.k === "num") return { t: "num", v: Number(t.v) };
    if (t.k === "id") {
      if (this.isOp("(")) {
        if (!(t.v in FUNCS)) throw new Error(`fonction inconnue « ${t.v} »`);
        this.eat("(");
        const args: Node[] = [];
        if (!this.isOp(")")) {
          args.push(this.ternary());
          while (this.isOp(",")) {
            this.eat(",");
            args.push(this.ternary());
          }
        }
        this.eat(")");
        return { t: "call", fn: t.v, args };
      }
      return { t: "path", v: t.v.split(".") };
    }
    if (t.k === "op" && t.v === "(") {
      const n = this.ternary();
      this.eat(")");
      return n;
    }
    throw new Error(`« ${t.v || "fin"} » inattendu`);
  }
}

/** Compile `a=expr; b=expr`. Les clés sont des identifiants simples ou pointés. */
export function compileMap(src: string): CompiledMap {
  const assigns: MapAssign[] = [];
  try {
    for (const part of src.split(";")) {
      const s = part.trim();
      if (!s) continue;
      const eq = s.indexOf("=");
      if (eq <= 0 || s[eq + 1] === "=") throw new Error(`affectation attendue (clé=expression) dans « ${s} »`);
      const key = s.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(key)) throw new Error(`clé invalide « ${key} »`);
      if (key.split(".").some((seg) => seg === "__proto__" || seg === "constructor" || seg === "prototype"))
        throw new Error(`clé interdite « ${key} »`);
      assigns.push({ key, node: new Parser(tokenize(s.slice(eq + 1))).parseAll() });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, assigns };
}

function lookup(data: unknown, path: string[]): number {
  let cur: unknown = data;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return 0;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (typeof cur === "number") return Number.isFinite(cur) ? cur : 0;
  if (typeof cur === "boolean") return cur ? 1 : 0;
  return 0;
}

function run(n: Node, data: unknown): number {
  switch (n.t) {
    case "num":
      return n.v;
    case "path":
      return lookup(data, n.v);
    case "un":
      return n.op === "-" ? -run(n.a, data) : run(n.a, data) ? 0 : 1;
    case "cond":
      return run(n.c, data) ? run(n.a, data) : run(n.b, data);
    case "call":
      return FUNCS[n.fn](...n.args.map((a) => run(a, data)));
    case "bin": {
      if (n.op === "&&") return run(n.a, data) && run(n.b, data) ? 1 : 0;
      if (n.op === "||") return run(n.a, data) || run(n.b, data) ? 1 : 0;
      const a = run(n.a, data);
      const b = run(n.b, data);
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? 0 : a / b;
        case "%": return b === 0 ? 0 : a % b;
        case "<": return a < b ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
        case "==": return a === b ? 1 : 0;
        case "!=": return a !== b ? 1 : 0;
      }
      return 0;
    }
  }
}

/** Évalue toutes les affectations : { clé: nombre } (valeurs non finies → 0). */
export function evalMap(compiled: CompiledMap, data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!compiled.ok) return out;
  for (const a of compiled.assigns) {
    const v = run(a.node, data);
    out[a.key] = Number.isFinite(v) ? v : 0;
  }
  return out;
}
