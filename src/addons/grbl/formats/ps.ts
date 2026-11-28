/**
 * PostScript et EPS (CorelDraw, Inkscape, anciens Illustrator…) → formes.
 *
 * Petit interpréteur borné (nombre d'opérations, profondeur, taille de pile), sans accès aux fichiers ni au
 * système : pile, dictionnaires, procédures, boucles, arithmétique, et la partie graphique utile au laser
 * (tracés, arcs, rectangles, matrices, gsave / grestore, couleurs gris / RVB / CMJN / TSL, stroke, fill).
 * Textes et images ignorés (comptés). Les EPS à en-tête binaire DOS sont lus. Les fichiers Illustrator
 * anciens (avant la compatibilité PDF) sont lus par leurs opérateurs propres (m l c v y, f s b n, g k x Xa…).
 */
import { addArc, apply, cmyk, hex, IDENTITY, isFiniteMat, MAX_SHAPES, mul, PathBuilder, rotate, scale, Skips, translate, type Mat, type Shape } from "./geom";
import { isDict, isName, isOp, isProc, Lexer, latin1, type PsDict, type PsName, type PsProc, type PsValue } from "./pslex";

export type PsResult = { shapes: Shape[]; unitMm: number; page: { x: number; y: number; w: number; h: number } | null; skipped: Record<string, number>; issues: string[] };

const MAX_OPS = 30_000_000;
const MAX_STACK = 100_000;

/** Texte PostScript d'un EPS, avec ou sans en-tête binaire DOS (C5 D0 D3 C6). */
export function psText(bytes: Uint8Array): string {
  if (bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const off = dv.getUint32(4, true), len = dv.getUint32(8, true);
    return latin1(bytes.subarray(off, Math.min(bytes.length, off + len)));
  }
  return latin1(bytes);
}

function boundingBox(text: string): { x: number; y: number; w: number; h: number } | null {
  const m = /%%HiResBoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(text) ?? /%%BoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(text);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

export function isLegacyIllustrator(text: string): boolean {
  return /%%Creator:\s*Adobe Illustrator/i.test(text.slice(0, 4000)) && /%%EndSetup/.test(text) && /%AI\d/.test(text);
}

export function readPostScript(bytes: Uint8Array): PsResult {
  const text = psText(bytes);
  const page = boundingBox(text);
  if (isLegacyIllustrator(text)) return { ...readLegacyAi(text), page };
  const interp = new Interp(text);
  try {
    interp.run();
  } catch (e) {
    if (!(e instanceof Quit)) interp.issues.push(e instanceof Error ? `lecture arrêtée : ${e.message}` : "lecture arrêtée");
  }
  if (interp.unknown.size) interp.issues.push(`opérateurs ignorés : ${[...interp.unknown].slice(0, 12).join(", ")}`);
  return { shapes: interp.shapes, unitMm: 25.4 / 72, page, skipped: interp.skips.counts, issues: interp.issues };
}

class Quit extends Error {}
class Exit extends Error {}
class Stop extends Error {}

type Builtin = { builtin: (it: Interp) => void; name: string };
const isBuiltin = (v: unknown): v is Builtin => !!v && typeof v === "object" && "builtin" in (v as object);
type Val = PsValue | Builtin | { mark: true };
const MARK = { mark: true } as const;
const isMark = (v: unknown) => v === MARK;
const lastMark = (a: Val[]) => {
  for (let k = a.length - 1; k >= 0; k--) if (a[k] === MARK) return k;
  return -1;
};

type Gs = { ctm: Mat; color: string; space: string };

class Interp {
  stack: Val[] = [];
  dicts: Map<string, Val>[];
  shapes: Shape[] = [];
  skips = new Skips();
  issues: string[] = [];
  unknown = new Set<string>();
  private gs: Gs = { ctm: IDENTITY, color: "#000000", space: "DeviceGray" };
  private gstack: Gs[] = [];
  private path = new PathBuilder();
  private ops = 0;
  private depth = 0;
  private lex: Lexer;

  constructor(readonly src: string) {
    this.lex = new Lexer(src);
    const sys = new Map<string, Val>();
    for (const [k, fn] of Object.entries(BUILTINS)) sys.set(k, { builtin: fn, name: k });
    this.dicts = [sys, new Map(), new Map()];
  }

  // ---- pile
  push(v: Val): void {
    if (this.stack.length >= MAX_STACK) throw new Error("pile pleine");
    this.stack.push(v);
  }
  pop(): Val {
    if (!this.stack.length) throw new Error("pile vide");
    return this.stack.pop()!;
  }
  num(): number {
    const v = this.pop();
    if (typeof v !== "number") throw new Error("nombre attendu");
    return v;
  }
  nums(n: number): number[] {
    const out = new Array<number>(n);
    for (let k = n - 1; k >= 0; k--) out[k] = this.num();
    return out;
  }
  bool(): boolean {
    const v = this.pop();
    if (typeof v !== "boolean") throw new Error("booléen attendu");
    return v;
  }
  proc(): PsProc {
    const v = this.pop();
    if (!isProc(v)) throw new Error("procédure attendue");
    return v;
  }
  lookup(name: string): Val | undefined {
    for (let k = this.dicts.length - 1; k >= 0; k--) {
      const d = this.dicts[k];
      if (d.has(name)) return d.get(name);
    }
    return undefined;
  }

  // ---- lecture : les procédures sont assemblées à la lecture
  private read(lex: Lexer): PsValue | undefined {
    const t = lex.token();
    if (isOp(t) && t.op === "{") {
      const body: PsValue[] = [];
      for (;;) {
        const v = this.read(lex);
        if (v === undefined || (isOp(v) && v.op === "}")) break;
        body.push(v);
      }
      return { proc: body };
    }
    return t;
  }

  run(): void {
    for (;;) {
      const t = this.read(this.lex);
      if (t === undefined) break;
      this.execToken(t, true);
    }
  }

  /** `direct` : jeton lu dans le fichier (une procédure y est empilée, pas exécutée). */
  execToken(t: Val, direct: boolean): void {
    if (++this.ops > MAX_OPS) throw new Error("programme trop long");
    if (isName(t)) {
      if (t.literal) return this.push(t);
      return this.execName(t.name);
    }
    if (isOp(t)) {
      switch (t.op) {
        case "[": case "<<": return this.push(MARK);
        case "]": return this.endArray();
        case ">>": return this.endDict();
        default: return;
      }
    }
    if (isProc(t) && !direct) return this.execProc(t);
    this.push(t);
  }

  execName(name: string): void {
    const v = this.lookup(name);
    if (v === undefined) {
      this.unknown.add(name);
      return;
    }
    this.execValue(v);
  }

  execValue(v: Val): void {
    if (isBuiltin(v)) return v.builtin(this);
    if (isProc(v)) return this.execProc(v);
    if (isName(v) && !v.literal) return this.execName(v.name);
    this.push(v);
  }

  execProc(p: PsProc): void {
    if (++this.depth > 200) throw new Error("récursion trop profonde");
    try {
      for (const t of p.proc) {
        if (isProc(t)) this.push(t);
        else this.execToken(t, false);
      }
    } finally {
      this.depth--;
    }
  }

  private endArray(): void {
    const k = lastMark(this.stack);
    if (k < 0) throw new Error("] sans [");
    const items = this.stack.splice(k + 1) as PsValue[];
    this.stack.pop();
    this.push(items);
  }
  private endDict(): void {
    const k = lastMark(this.stack);
    if (k < 0) throw new Error(">> sans <<");
    const items = this.stack.splice(k + 1);
    this.stack.pop();
    const dict = new Map<string, PsValue>();
    for (let i = 0; i + 1 < items.length; i += 2) dict.set(keyOf(items[i]), items[i + 1] as PsValue);
    this.push({ dict });
  }

  // ---- graphisme
  get ctm(): Mat {
    return this.gs.ctm;
  }
  set ctm(m: Mat) {
    if (isFiniteMat(m)) this.gs.ctm = m;
  }
  pt(x: number, y: number): [number, number] {
    return apply(this.gs.ctm, x, y);
  }
  /** Point courant dans le repère utilisateur. */
  userCurrent(): [number, number] | null {
    const c = this.path.current;
    if (!c) return null;
    const m = this.gs.ctm;
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return null;
    const x = c[0] - m[4], y = c[1] - m[5];
    return [(m[3] * x - m[2] * y) / det, (-m[1] * x + m[0] * y) / det];
  }
  moveTo(x: number, y: number) { this.path.moveTo(...this.pt(x, y)); }
  lineTo(x: number, y: number) { this.path.lineTo(...this.pt(x, y)); }
  curveTo(a: number[]) { this.path.curveTo(...this.pt(a[0], a[1]), ...this.pt(a[2], a[3]), ...this.pt(a[4], a[5])); }
  arc(cx: number, cy: number, r: number, a1: number, a2: number, ccw: boolean) {
    let s = (a1 * Math.PI) / 180, e = (a2 * Math.PI) / 180;
    if (ccw) while (e < s) e += 2 * Math.PI;
    else while (e > s) e -= 2 * Math.PI;
    addArc(this.path, cx, cy, r, r, s, e, this.gs.ctm);
  }
  closePath() { this.path.close(); }
  newPath() { this.path = new PathBuilder(); }
  paint(fill: boolean, evenOdd = false) {
    if (!this.path.empty && this.shapes.length <= MAX_SHAPES) this.shapes.push(fill ? { segs: this.path.take(), fill: this.gs.color, evenOdd } : { segs: this.path.take(), stroke: this.gs.color });
    this.newPath();
  }
  rect(x: number, y: number, w: number, h: number) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }
  setColor(c: string, space?: string) {
    this.gs.color = c;
    if (space) this.gs.space = space;
  }
  get space() { return this.gs.space; }
  gsave() { this.gstack.push({ ...this.gs }); if (this.gstack.length > 1000) throw new Error("gsave trop imbriqués"); }
  grestore() { this.gs = this.gstack.pop() ?? this.gs; }
  pathBox(): number[] {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of this.path.segs) if (s.t !== "Z") { x1 = Math.min(x1, s.x); y1 = Math.min(y1, s.y); x2 = Math.max(x2, s.x); y2 = Math.max(y2, s.y); }
    return Number.isFinite(x1) ? [x1, y1, x2, y2] : [0, 0, 0, 0];
  }
  /** `eexec` (fontes chiffrées) : on saute jusqu'au `cleartomark`. */
  skipEexec() {
    const k = this.src.indexOf("cleartomark", this.lex.pos);
    this.lex.pos = k < 0 ? this.src.length : k + "cleartomark".length;
    this.skips.add("fonte");
  }
  /** Données d'image en ligne après `image` : sautées jusqu'à la prochaine ligne qui n'est pas hexadécimale. */
  skipInlineData() {
    const re = /[^0-9A-Fa-f\s>~]/g;
    re.lastIndex = this.lex.pos;
    const m = re.exec(this.src);
    if (m && m.index - this.lex.pos > 64) {
      const nl = this.src.lastIndexOf("\n", m.index);
      this.lex.pos = nl > this.lex.pos ? nl : m.index;
    }
  }
}

const keyOf = (v: Val): string => (isName(v) ? v.name : typeof v === "string" ? v : String(v));
const isDictVal = (v: Val): v is PsDict => isDict(v);

const hsb = (h: number, s: number, b: number) => {
  const i = Math.floor(h * 6), f = h * 6 - i, p = b * (1 - s), q = b * (1 - f * s), t = b * (1 - (1 - f) * s);
  const [r, g, bl] = [[b, t, p], [q, b, p], [p, b, t], [p, q, b], [t, p, b], [b, p, q]][((i % 6) + 6) % 6];
  return hex(r, g, bl);
};

const popN = (n: number) => (it: Interp) => { for (let k = 0; k < n; k++) it.pop(); };
const show = (n: number) => (it: Interp) => { popN(n)(it); it.skips.add("texte"); };

const BUILTINS: Record<string, (it: Interp) => void> = {
  // pile
  pop: (it) => { it.pop(); },
  exch: (it) => { const b = it.pop(), a = it.pop(); it.push(b); it.push(a); },
  dup: (it) => { const a = it.pop(); it.push(a); it.push(a); },
  copy: (it) => {
    const n = it.pop();
    if (typeof n !== "number") { it.push(n); return; }
    const items = it.stack.slice(it.stack.length - n);
    for (const v of items) it.push(v);
  },
  index: (it) => { const n = it.num(); const v = it.stack[it.stack.length - 1 - n]; if (v === undefined) throw new Error("index hors pile"); it.push(v); },
  roll: (it) => {
    const j = it.num(), n = it.num();
    if (n <= 0) return;
    if (n > it.stack.length) throw new Error("roll hors pile");
    const part = it.stack.splice(it.stack.length - n);
    const s = ((j % n) + n) % n;
    it.stack.push(...part.slice(n - s), ...part.slice(0, n - s));
  },
  clear: (it) => { it.stack.length = 0; },
  count: (it) => it.push(it.stack.length),
  mark: (it) => it.push(MARK),
  cleartomark: (it) => { const k = lastMark(it.stack); it.stack.length = Math.max(0, k); },
  counttomark: (it) => { const k = lastMark(it.stack); it.push(k < 0 ? 0 : it.stack.length - 1 - k); },
  // arithmétique
  add: (it) => { const b = it.num(), a = it.num(); it.push(a + b); },
  sub: (it) => { const b = it.num(), a = it.num(); it.push(a - b); },
  mul: (it) => { const b = it.num(), a = it.num(); it.push(a * b); },
  div: (it) => { const b = it.num(), a = it.num(); it.push(b ? a / b : 0); },
  idiv: (it) => { const b = it.num(), a = it.num(); it.push(b ? Math.trunc(a / b) : 0); },
  mod: (it) => { const b = it.num(), a = it.num(); it.push(b ? a % b : 0); },
  neg: (it) => it.push(-it.num()),
  abs: (it) => it.push(Math.abs(it.num())),
  sqrt: (it) => it.push(Math.sqrt(Math.max(0, it.num()))),
  sin: (it) => it.push(Math.sin((it.num() * Math.PI) / 180)),
  cos: (it) => it.push(Math.cos((it.num() * Math.PI) / 180)),
  atan: (it) => { const d = it.num(), n = it.num(); let a = (Math.atan2(n, d) * 180) / Math.PI; if (a < 0) a += 360; it.push(a); },
  exp: (it) => { const e = it.num(), b = it.num(); it.push(Math.pow(b, e)); },
  ln: (it) => it.push(Math.log(it.num())),
  log: (it) => it.push(Math.log10(it.num())),
  round: (it) => it.push(Math.round(it.num())),
  floor: (it) => it.push(Math.floor(it.num())),
  ceiling: (it) => it.push(Math.ceil(it.num())),
  truncate: (it) => it.push(Math.trunc(it.num())),
  cvi: (it) => { const v = it.pop(); it.push(Math.trunc(Number(v)) || 0); },
  cvr: (it) => { const v = it.pop(); it.push(Number(v) || 0); },
  rand: (it) => it.push(Math.floor(Math.random() * 2147483647)),
  srand: popN(1),
  // comparaisons
  eq: (it) => { const b = it.pop(), a = it.pop(); it.push(keyOf(a) === keyOf(b) && typeof a === typeof b || a === b); },
  ne: (it) => { const b = it.pop(), a = it.pop(); it.push(!(keyOf(a) === keyOf(b) && typeof a === typeof b || a === b)); },
  gt: (it) => { const b = it.pop(), a = it.pop(); it.push((a as number) > (b as number)); },
  ge: (it) => { const b = it.pop(), a = it.pop(); it.push((a as number) >= (b as number)); },
  lt: (it) => { const b = it.pop(), a = it.pop(); it.push((a as number) < (b as number)); },
  le: (it) => { const b = it.pop(), a = it.pop(); it.push((a as number) <= (b as number)); },
  and: (it) => { const b = it.pop(), a = it.pop(); it.push(typeof a === "boolean" ? a && !!b : (Number(a) & Number(b))); },
  or: (it) => { const b = it.pop(), a = it.pop(); it.push(typeof a === "boolean" ? a || !!b : (Number(a) | Number(b))); },
  xor: (it) => { const b = it.pop(), a = it.pop(); it.push(typeof a === "boolean" ? a !== !!b : (Number(a) ^ Number(b))); },
  not: (it) => { const a = it.pop(); it.push(typeof a === "boolean" ? !a : ~Number(a)); },
  true: (it) => it.push(true),
  false: (it) => it.push(false),
  null: (it) => it.push(null),
  // contrôle
  if: (it) => { const p = it.proc(); if (it.bool()) it.execProc(p); },
  ifelse: (it) => { const b = it.proc(), a = it.proc(); it.execProc(it.bool() ? a : b); },
  exec: (it) => it.execValue(it.pop()),
  repeat: (it) => {
    const p = it.proc(), n = it.num();
    try { for (let k = 0; k < n; k++) it.execProc(p); } catch (e) { if (!(e instanceof Exit)) throw e; }
  },
  for: (it) => {
    const p = it.proc(), lim = it.num(), inc = it.num(), init = it.num();
    if (!inc) return;
    try {
      for (let v = init, k = 0; inc > 0 ? v <= lim + 1e-9 : v >= lim - 1e-9; v += inc, k++) {
        if (k > 1_000_000) throw new Error("boucle trop longue");
        it.push(v);
        it.execProc(p);
      }
    } catch (e) { if (!(e instanceof Exit)) throw e; }
  },
  loop: (it) => {
    const p = it.proc();
    try { for (let k = 0; k < 1_000_000; k++) it.execProc(p); } catch (e) { if (!(e instanceof Exit)) throw e; }
  },
  forall: (it) => {
    const p = it.proc(), v = it.pop();
    try {
      if (Array.isArray(v)) for (const x of v) { it.push(x); it.execProc(p); }
      else if (isProc(v)) for (const x of v.proc) { it.push(x); it.execProc(p); }
      else if (isDictVal(v)) for (const [k, x] of v.dict) { it.push({ name: k, literal: true }); it.push(x); it.execProc(p); }
      else if (typeof v === "string") for (const ch of v) { it.push(ch.charCodeAt(0)); it.execProc(p); }
    } catch (e) { if (!(e instanceof Exit)) throw e; }
  },
  exit: () => { throw new Exit(); },
  stop: () => { throw new Stop(); },
  stopped: (it) => {
    const v = it.pop();
    try { it.execValue(v); it.push(false); } catch (e) { if (e instanceof Stop || (e instanceof Error && !(e instanceof Exit) && !(e instanceof Quit))) it.push(true); else throw e; }
  },
  quit: () => { throw new Quit(); },
  // dictionnaires
  dict: (it) => { it.num(); it.push({ dict: new Map() }); },
  begin: (it) => { const d = it.pop(); if (!isDictVal(d)) throw new Error("dictionnaire attendu"); it.dicts.push(d.dict as Map<string, Val>); if (it.dicts.length > 200) throw new Error("trop de dictionnaires"); },
  end: (it) => { if (it.dicts.length > 3) it.dicts.pop(); },
  def: (it) => { const v = it.pop(), k = it.pop(); it.dicts[it.dicts.length - 1].set(keyOf(k), v); },
  store: (it) => {
    const v = it.pop(), k = keyOf(it.pop());
    for (let i = it.dicts.length - 1; i >= 0; i--) if (it.dicts[i].has(k)) { it.dicts[i].set(k, v); return; }
    it.dicts[it.dicts.length - 1].set(k, v);
  },
  load: (it) => { const k = keyOf(it.pop()); const v = it.lookup(k); if (v === undefined) it.unknown.add(k); else it.push(v); },
  where: (it) => {
    const k = keyOf(it.pop());
    for (let i = it.dicts.length - 1; i >= 0; i--) if (it.dicts[i].has(k)) { it.push({ dict: it.dicts[i] as Map<string, PsValue> }); it.push(true); return; }
    it.push(false);
  },
  known: (it) => { const k = keyOf(it.pop()), d = it.pop(); it.push(isDictVal(d) && d.dict.has(k)); },
  undef: (it) => { const k = keyOf(it.pop()), d = it.pop(); if (isDictVal(d)) d.dict.delete(k); },
  currentdict: (it) => it.push({ dict: it.dicts[it.dicts.length - 1] as Map<string, PsValue> }),
  userdict: (it) => it.push({ dict: it.dicts[1] as Map<string, PsValue> }),
  globaldict: (it) => it.push({ dict: it.dicts[2] as Map<string, PsValue> }),
  systemdict: (it) => it.push({ dict: it.dicts[0] as Map<string, PsValue> }),
  statusdict: (it) => it.push({ dict: new Map() }),
  errordict: (it) => it.push({ dict: new Map() }),
  countdictstack: (it) => it.push(it.dicts.length),
  get: (it) => {
    const k = it.pop(), c = it.pop();
    if (Array.isArray(c)) it.push(c[Number(k)] ?? null);
    else if (isProc(c)) it.push(c.proc[Number(k)] ?? null);
    else if (isDictVal(c)) { const v = c.dict.get(keyOf(k)); if (v === undefined) it.unknown.add(keyOf(k)); else it.push(v); }
    else if (typeof c === "string") it.push(c.charCodeAt(Number(k)) || 0);
    else it.push(null);
  },
  put: (it) => {
    const v = it.pop(), k = it.pop(), c = it.pop();
    if (Array.isArray(c) && Number(k) >= 0 && Number(k) < c.length) c[Number(k)] = v as PsValue;
    else if (isDictVal(c)) c.dict.set(keyOf(k), v as PsValue);
  },
  length: (it) => { const c = it.pop(); it.push(Array.isArray(c) || typeof c === "string" ? c.length : isProc(c) ? c.proc.length : isDictVal(c) ? c.dict.size : 0); },
  maxlength: (it) => { it.pop(); it.push(1000); },
  array: (it) => { const n = Math.min(it.num(), 100_000); it.push(new Array<PsValue>(Math.max(0, n)).fill(null)); },
  aload: (it) => { const a = it.pop(); const items = Array.isArray(a) ? a : isProc(a) ? a.proc : []; for (const v of items) it.push(v); it.push(a); },
  astore: (it) => { const a = it.pop(); if (!Array.isArray(a)) return; for (let k = a.length - 1; k >= 0; k--) a[k] = it.pop() as PsValue; it.push(a); },
  getinterval: (it) => { const n = it.num(), i = it.num(), c = it.pop(); it.push(Array.isArray(c) || typeof c === "string" ? (c.slice(i, i + n) as PsValue) : isProc(c) ? { proc: c.proc.slice(i, i + n) } : null); },
  putinterval: popN(3),
  string: (it) => { const n = Math.min(it.num(), 65_535); it.push("\0".repeat(Math.max(0, n))); },
  cvx: (it) => { const v = it.pop(); it.push(Array.isArray(v) ? { proc: v } : isName(v) ? { name: v.name, literal: false } : v); },
  cvlit: (it) => { const v = it.pop(); it.push(isProc(v) ? v.proc : isName(v) ? { name: v.name, literal: true } : v); },
  xcheck: (it) => { const v = it.pop(); it.push(isProc(v) || (isName(v) && !v.literal) || isBuiltin(v)); },
  cvn: (it) => it.push({ name: keyOf(it.pop()), literal: true }),
  cvs: (it) => { it.pop(); const v = it.pop(); it.push(keyOf(v)); },
  type: (it) => {
    const v = it.pop();
    const t = typeof v === "number" ? (Number.isInteger(v) ? "integertype" : "realtype") : typeof v === "boolean" ? "booleantype" : typeof v === "string" ? "stringtype" : Array.isArray(v) || isProc(v) ? "arraytype" : isDictVal(v) ? "dicttype" : isName(v) ? "nametype" : isBuiltin(v) ? "operatortype" : isMark(v) ? "marktype" : "nulltype";
    it.push({ name: t, literal: false });
  },
  bind: () => {},
  readonly: () => {},
  executeonly: () => {},
  noaccess: () => {},
  version: (it) => it.push("3010"),
  languagelevel: (it) => it.push(3),
  product: (it) => it.push("creative-stack"),
  revision: (it) => it.push(1),
  vmstatus: (it) => { it.push(0); it.push(0); it.push(10_000_000); },
  realtime: (it) => it.push(0),
  usertime: (it) => it.push(0),
  save: (it) => { it.gsave(); it.push({ dict: new Map() }); },
  restore: (it) => { it.pop(); it.grestore(); },
  setglobal: popN(1),
  currentglobal: (it) => it.push(false),
  setpacking: popN(1),
  currentpacking: (it) => it.push(false),
  setpagedevice: popN(1),
  setuserparams: popN(1),
  print: popN(1),
  "=": popN(1),
  "==": popN(1),
  pstack: () => {},
  flush: () => {},
  // fichiers : aucun accès, lectures vides
  currentfile: (it) => it.push(null),
  readhexstring: (it) => { it.pop(); it.pop(); it.push(""); it.push(false); },
  readstring: (it) => { it.pop(); it.pop(); it.push(""); it.push(false); },
  readline: (it) => { it.pop(); it.pop(); it.push(""); it.push(false); },
  closefile: popN(1),
  flushfile: popN(1),
  filter: (it) => { it.pop(); it.pop(); it.push(null); },
  eexec: (it) => { it.pop(); it.skipEexec(); },
  run: (it) => { it.pop(); it.skips.add("fichier externe"); },
  file: (it) => { it.pop(); it.pop(); it.push(null); },
  // graphisme
  gsave: (it) => it.gsave(),
  grestore: (it) => it.grestore(),
  grestoreall: (it) => it.grestore(),
  initgraphics: (it) => { it.ctm = IDENTITY; },
  newpath: (it) => it.newPath(),
  moveto: (it) => { const [x, y] = it.nums(2); it.moveTo(x, y); },
  lineto: (it) => { const [x, y] = it.nums(2); it.lineTo(x, y); },
  rmoveto: (it) => { const [dx, dy] = it.nums(2); const c = it.userCurrent() ?? [0, 0]; it.moveTo(c[0] + dx, c[1] + dy); },
  rlineto: (it) => { const [dx, dy] = it.nums(2); const c = it.userCurrent() ?? [0, 0]; it.lineTo(c[0] + dx, c[1] + dy); },
  curveto: (it) => it.curveTo(it.nums(6)),
  rcurveto: (it) => { const a = it.nums(6); const c = it.userCurrent() ?? [0, 0]; it.curveTo(a.map((v, k) => v + c[k % 2])); },
  closepath: (it) => it.closePath(),
  arc: (it) => { const [x, y, r, a1, a2] = it.nums(5); it.arc(x, y, r, a1, a2, true); },
  arcn: (it) => { const [x, y, r, a1, a2] = it.nums(5); it.arc(x, y, r, a1, a2, false); },
  arct: (it) => { const [x1, y1, x2, y2] = it.nums(5); it.lineTo(x1, y1); it.lineTo(x2, y2); },
  arcto: (it) => { const [x1, y1, x2, y2] = it.nums(5); it.lineTo(x1, y1); for (const v of [x1, y1, x2, y2]) it.push(v); },
  currentpoint: (it) => { const c = it.userCurrent() ?? [0, 0]; it.push(c[0]); it.push(c[1]); },
  rectfill: (it) => { const [x, y, w, h] = it.nums(4); it.newPath(); it.rect(x, y, w, h); it.paint(true); },
  rectstroke: (it) => { const v = it.pop(); if (Array.isArray(v)) return; it.push(v); const [x, y, w, h] = it.nums(4); it.newPath(); it.rect(x, y, w, h); it.paint(false); },
  rectclip: popN(4),
  stroke: (it) => it.paint(false),
  fill: (it) => it.paint(true),
  eofill: (it) => it.paint(true, true),
  clip: () => {},
  eoclip: () => {},
  initclip: () => {},
  clippath: (it) => it.newPath(),
  flattenpath: () => {},
  reversepath: () => {},
  strokepath: () => {},
  pathbbox: (it) => { for (const v of it.pathBox()) it.push(v); },
  translate: (it) => { const v = it.pop(); if (Array.isArray(v)) { it.pop(); it.pop(); it.push(v); return; } it.push(v); const [x, y] = it.nums(2); it.ctm = mul(translate(x, y), it.ctm); },
  scale: (it) => { const v = it.pop(); if (Array.isArray(v)) { it.pop(); it.pop(); it.push(v); return; } it.push(v); const [x, y] = it.nums(2); it.ctm = mul(scale(x, y), it.ctm); },
  rotate: (it) => { const v = it.pop(); if (Array.isArray(v)) { it.pop(); it.push(v); return; } it.push(v); it.ctm = mul(rotate(it.num()), it.ctm); },
  concat: (it) => { const m = it.pop(); if (Array.isArray(m) && m.length === 6) it.ctm = mul(m.map(Number) as Mat, it.ctm); },
  matrix: (it) => it.push([...IDENTITY]),
  identmatrix: (it) => { it.pop(); it.push([...IDENTITY]); },
  currentmatrix: (it) => { it.pop(); it.push([...it.ctm]); },
  defaultmatrix: (it) => { it.pop(); it.push([...IDENTITY]); },
  setmatrix: (it) => { const m = it.pop(); if (Array.isArray(m) && m.length === 6) it.ctm = m.map(Number) as Mat; },
  concatmatrix: (it) => { const c = it.pop(), b = it.pop(), a = it.pop(); if (Array.isArray(a) && Array.isArray(b)) it.push(mul(a.map(Number) as Mat, b.map(Number) as Mat)); else it.push(c); },
  transform: (it) => { const v = it.pop(); if (!Array.isArray(v)) it.push(v); const [x, y] = it.nums(2); const p = it.pt(x, y); it.push(p[0]); it.push(p[1]); },
  itransform: (it) => { const v = it.pop(); if (!Array.isArray(v)) it.push(v); },
  dtransform: (it) => { const v = it.pop(); if (!Array.isArray(v)) it.push(v); },
  idtransform: (it) => { const v = it.pop(); if (!Array.isArray(v)) it.push(v); },
  setlinewidth: popN(1),
  setlinecap: popN(1),
  setlinejoin: popN(1),
  setmiterlimit: popN(1),
  setdash: popN(2),
  setflat: popN(1),
  setstrokeadjust: popN(1),
  setoverprint: popN(1),
  setsmoothness: popN(1),
  setscreen: popN(3),
  settransfer: popN(1),
  setblackgeneration: popN(1),
  setundercolorremoval: popN(1),
  sethalftone: popN(1),
  setcolorrendering: popN(1),
  currentlinewidth: (it) => it.push(1),
  currentflat: (it) => it.push(1),
  setgray: (it) => { const g = it.num(); it.setColor(hex(g, g, g), "DeviceGray"); },
  setrgbcolor: (it) => { const [r, g, b] = it.nums(3); it.setColor(hex(r, g, b), "DeviceRGB"); },
  sethsbcolor: (it) => { const [h, s, b] = it.nums(3); it.setColor(hsb(h, s, b), "DeviceRGB"); },
  setcmykcolor: (it) => { const [c, m, y, k] = it.nums(4); it.setColor(cmyk(c, m, y, k), "DeviceCMYK"); },
  setcolorspace: (it) => {
    const v = it.pop();
    const n = isName(v) ? v.name : Array.isArray(v) && isName(v[0]) ? v[0].name : "DeviceRGB";
    it.setColor("#000000", n);
  },
  setcolor: (it) => {
    const comps: number[] = [];
    while (it.stack.length && typeof it.stack[it.stack.length - 1] === "number") comps.unshift(it.num());
    const sp = it.space;
    const c = sp === "Separation" ? hex(1 - (comps[0] ?? 1), 1 - (comps[0] ?? 1), 1 - (comps[0] ?? 1)) : comps.length === 1 ? hex(comps[0], comps[0], comps[0]) : comps.length === 3 ? hex(comps[0], comps[1], comps[2]) : comps.length === 4 ? cmyk(comps[0], comps[1], comps[2], comps[3]) : "#000000";
    it.setColor(c);
  },
  setpattern: (it) => { it.pop(); it.setColor("#000000"); },
  currentgray: (it) => it.push(0),
  currentrgbcolor: (it) => { it.push(0); it.push(0); it.push(0); },
  currentcmykcolor: (it) => { it.push(0); it.push(0); it.push(0); it.push(1); },
  shfill: (it) => { it.pop(); it.skips.add("dégradé"); },
  showpage: () => {},
  copypage: () => {},
  erasepage: () => {},
  // textes et fontes
  findfont: (it) => { it.pop(); it.push({ dict: new Map([["FontMatrix", [0.001, 0, 0, 0.001, 0, 0]]]) }); },
  scalefont: (it) => { it.pop(); },
  makefont: (it) => { it.pop(); },
  setfont: popN(1),
  selectfont: popN(2),
  currentfont: (it) => it.push({ dict: new Map() }),
  definefont: (it) => { const d = it.pop(); it.pop(); it.push(d); },
  undefinefont: popN(1),
  findresource: (it) => { it.pop(); it.pop(); it.push({ dict: new Map() }); },
  defineresource: (it) => { const v = it.pop(); it.pop(); it.pop(); it.push(v); },
  resourcestatus: (it) => { it.pop(); it.pop(); it.push(false); },
  show: show(1),
  ashow: show(3),
  widthshow: show(4),
  awidthshow: show(6),
  kshow: show(2),
  xshow: show(2),
  yshow: show(2),
  xyshow: show(2),
  glyphshow: show(1),
  cshow: show(2),
  charpath: show(2),
  stringwidth: (it) => { it.pop(); it.push(0); it.push(0); },
  // images : opérandes retirés, données en ligne sautées
  image: (it) => {
    const v = it.pop();
    if (!isDictVal(v)) for (let k = 0; k < 4; k++) it.pop();
    it.skips.add("image");
    it.skipInlineData();
  },
  imagemask: (it) => {
    const v = it.pop();
    if (!isDictVal(v)) for (let k = 0; k < 4; k++) it.pop();
    it.skips.add("image");
    it.skipInlineData();
  },
  colorimage: (it) => {
    const ncomp = it.num(), multi = it.bool();
    for (let k = 0; k < (multi ? ncomp : 1) + 4; k++) it.pop();
    it.skips.add("image");
    it.skipInlineData();
  },
};

/** Illustrator ancien (1.1 à 8, sans compatibilité PDF) : corps entre `%%EndSetup` et `%%PageTrailer`. */
function readLegacyAi(text: string): { shapes: Shape[]; unitMm: number; skipped: Record<string, number>; issues: string[] } {
  const skips = new Skips();
  const issues: string[] = [];
  const shapes: Shape[] = [];
  const start = text.indexOf("%%EndSetup");
  let end = text.indexOf("%%PageTrailer", start);
  if (end < 0) end = text.indexOf("%%Trailer", start);
  const lex = new Lexer(text, start, end < 0 ? text.length : end);
  let stack: PsValue[] = [];
  let fill = "#000000", stroke = "#000000";
  let path = new PathBuilder();
  let compound: Shape | null = null;
  let ops = 0;
  const n = (k: number) => stack.splice(-k).map(Number);
  const paint = (f: boolean, s: boolean, close: boolean) => {
    if (close) path.close();
    if (path.empty) { path = new PathBuilder(); return; }
    if (compound) {
      compound.segs.push(...path.take());
      if (f) compound.fill = fill;
      if (s) compound.stroke = stroke;
    } else if ((f || s) && shapes.length <= MAX_SHAPES) shapes.push({ segs: path.take(), fill: f ? fill : null, stroke: s ? stroke : null, evenOdd: true });
    path = new PathBuilder();
  };
  for (;;) {
    const t = lex.token();
    if (t === undefined || ++ops > MAX_OPS) break;
    if (!isName(t) || t.literal) {
      if (isOp(t) && t.op === "[") stack.push([]);
      else if (!isOp(t)) stack.push(t);
      continue;
    }
    switch (t.name) {
      case "m": { const [x, y] = n(2); path.moveTo(x, y); break; }
      case "l": case "L": { const [x, y] = n(2); path.lineTo(x, y); break; }
      case "c": case "C": { const [a, b, c, d, e, f] = n(6); path.curveTo(a, b, c, d, e, f); break; }
      case "v": case "V": { const [c, d, e, f] = n(4); const cur = path.current ?? [c, d]; path.curveTo(cur[0], cur[1], c, d, e, f); break; }
      case "y": case "Y": { const [a, b, e, f] = n(4); path.curveTo(a, b, e, f, e, f); break; }
      case "h": case "H": path.close(); break;
      case "N": paint(false, false, false); break;
      case "n": paint(false, false, true); break;
      case "F": paint(true, false, false); break;
      case "f": paint(true, false, true); break;
      case "S": paint(false, true, false); break;
      case "s": paint(false, true, true); break;
      case "B": paint(true, true, false); break;
      case "b": paint(true, true, true); break;
      case "*u": compound = { segs: [], fill: null, stroke: null, evenOdd: true }; break;
      case "*U":
        if (compound && compound.segs.length && (compound.fill || compound.stroke)) shapes.push(compound);
        compound = null;
        break;
      case "g": { const [g] = n(1); fill = hex(g, g, g); break; }
      case "G": { const [g] = n(1); stroke = hex(g, g, g); break; }
      case "k": { const [c, m, y, k] = n(4); fill = cmyk(c, m, y, k); break; }
      case "K": { const [c, m, y, k] = n(4); stroke = cmyk(c, m, y, k); break; }
      case "Xa": { const [r, g, b] = n(3); fill = hex(r, g, b); break; }
      case "XA": { const [r, g, b] = n(3); stroke = hex(r, g, b); break; }
      case "x": case "X": {
        // c m y k (nom) teinte x
        const nums = stack.filter((v) => typeof v === "number") as number[];
        const [c, m, y, k, tint] = nums.slice(-5);
        const col = cmyk((c ?? 0) * (1 - (tint ?? 0)), (m ?? 0) * (1 - (tint ?? 0)), (y ?? 0) * (1 - (tint ?? 0)), (k ?? 1) * (1 - (tint ?? 0)));
        if (t.name === "x") fill = col; else stroke = col;
        break;
      }
      case "To": case "TO": case "Tx": case "Tj": case "TX":
        skips.add("texte");
        break;
      case "XI": case "XG":
        skips.add("image");
        break;
      default:
        break;
    }
    stack = [];
  }
  return { shapes, unitMm: 25.4 / 72, skipped: skips.counts, issues };
}

export type { PsName };
