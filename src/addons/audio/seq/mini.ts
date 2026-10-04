/**
 * Mini-notation musicale (sous-ensemble réécrit, inspiré de TidalCycles / Strudel).
 * Une ligne décrit UN cycle (une mesure) ; ses éléments se partagent le temps.
 *
 *   "x...x...x..x...."    grille : un caractère par pas (x frappe, X accent, . silence)
 *   "c4 e4 g4 b4"         4 notes réparties sur le cycle
 *   "c4 [e4 g4] ~ b4"     [ ] sous-division, ~ (ou .) silence
 *   "c4 - e4 _"           - ou _ : prolonge l'élément précédent
 *   "<c4 e4 g4>"          alternance : un élément par cycle
 *   "c4*2 e4!3 g4@2"      *n répète dans la case, !n duplique en n cases, @n poids
 *   "x?0.3"               probabilité (défaut 0.5), tirage déterministe à graine
 *   "x(3,8,2)"            rythme euclidien k frappes sur n pas, rotation r
 *   "[c4, e4, g4]"        , superpose (accord) ; "c4+e4+g4" aussi
 *   "0 2 4 7"             degrés de gamme (avec `scale`) ou notes MIDI
 *
 * Pur : aucun accès audio ni DOM.
 */

export type MiniNode =
  | { kind: "seq"; items: { node: MiniNode; weight: number }[] }
  | { kind: "stack"; items: MiniNode[] }
  | { kind: "alt"; items: MiniNode[] }
  | { kind: "atom"; value: string }
  | { kind: "rest" }
  | { kind: "repeat"; node: MiniNode; times: number }
  | { kind: "prob"; node: MiniNode; p: number }
  | { kind: "euclid"; node: MiniNode; k: number; n: number; r: number };

export type MiniEvent = {
  /** Début et fin dans le cycle, 0..1. */
  start: number;
  end: number;
  value: string;
  /** Probabilité de jeu (1 = toujours). */
  p: number;
};

export type ParsedLine = { ast: MiniNode; errors: string[] };

const MAX_LEN = 4096;
const MAX_REPEAT = 64;

/* ------------------------------------------------------------------ */
/* Lexique                                                             */
/* ------------------------------------------------------------------ */

type Tok = { t: string; v?: string; pos: number };

function lex(src: string, errors: string[]): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c) || c === "|") {
      toks.push({ t: "ws", pos: i });
      while (i < src.length && (/\s/.test(src[i]) || src[i] === "|")) i++;
      continue;
    }
    if ("[]<>,()*!@?".includes(c)) {
      toks.push({ t: c, pos: i });
      i++;
      continue;
    }
    if (c === "~") {
      toks.push({ t: "rest", pos: i });
      i++;
      continue;
    }
    const m = /^[A-Za-z0-9#_.+\-:]+/.exec(src.slice(i));
    if (m) {
      toks.push({ t: "word", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    errors.push(`caractère "${c}" inattendu (position ${i + 1})`);
    i++;
  }
  return toks;
}

/* ------------------------------------------------------------------ */
/* Syntaxe                                                             */
/* ------------------------------------------------------------------ */

class Parser {
  private i = 0;
  constructor(private toks: Tok[], private errors: string[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  private skipWs(): void {
    while (this.peek()?.t === "ws") this.i++;
  }

  parseStack(close?: string): MiniNode {
    const seqs: MiniNode[] = [this.parseSeq(close)];
    while (this.peek()?.t === ",") {
      this.i++;
      seqs.push(this.parseSeq(close));
    }
    return seqs.length === 1 ? seqs[0] : { kind: "stack", items: seqs };
  }

  private parseSeq(close?: string): MiniNode {
    const items: { node: MiniNode; weight: number }[] = [];
    for (;;) {
      this.skipWs();
      const tok = this.peek();
      if (!tok || tok.t === "," || (close && tok.t === close)) break;
      if (tok.t === "]" || tok.t === ">" || tok.t === ")") {
        this.errors.push(`"${tok.t}" sans ouverture (position ${tok.pos + 1})`);
        this.i++;
        continue;
      }
      // Tenue : - ou _ isolés prolongent l'élément précédent.
      if (tok.t === "word" && (tok.v === "-" || tok.v === "_")) {
        this.i++;
        if (items.length) items[items.length - 1].weight += 1;
        else items.push({ node: { kind: "rest" }, weight: 1 });
        continue;
      }
      const term = this.parseTerm();
      if (!term) continue;
      for (let k = 0; k < term.copies; k++) items.push({ node: term.node, weight: term.weight });
    }
    return { kind: "seq", items };
  }

  private parseTerm(): { node: MiniNode; weight: number; copies: number } | null {
    const tok = this.peek()!;
    let node: MiniNode;
    if (tok.t === "[") {
      this.i++;
      node = this.parseStack("]");
      this.expect("]");
    } else if (tok.t === "<") {
      this.i++;
      const inner = this.parseStack(">");
      this.expect(">");
      node = { kind: "alt", items: inner.kind === "seq" ? inner.items.map((x) => x.node) : [inner] };
    } else if (tok.t === "rest") {
      this.i++;
      node = { kind: "rest" };
    } else if (tok.t === "word") {
      this.i++;
      node = tok.v === "." ? { kind: "rest" } : isGrid(tok.v!) ? gridNode(tok.v!) : { kind: "atom", value: tok.v! };
    } else {
      this.errors.push(`"${tok.t}" inattendu (position ${tok.pos + 1})`);
      this.i++;
      return null;
    }
    let weight = 1;
    let copies = 1;
    for (;;) {
      const m = this.peek();
      if (!m) break;
      if (m.t === "(") {
        this.i++;
        const args = this.readArgs();
        if (args.length < 2 || args.length > 3 || args.some((a) => !Number.isInteger(a))) {
          this.errors.push(`euclide : (k,n) ou (k,n,r) entiers attendus (position ${m.pos + 1})`);
        } else {
          const [k, n, r = 0] = args;
          if (n < 1 || n > MAX_REPEAT || k < 0 || k > n) this.errors.push(`euclide (${k},${n}) : 0 ≤ k ≤ n ≤ ${MAX_REPEAT}`);
          else node = { kind: "euclid", node, k, n, r };
        }
        continue;
      }
      if (m.t === "*" || m.t === "!" || m.t === "@" || m.t === "?") {
        this.i++;
        const numTok = this.peek();
        const hasNum = numTok?.t === "word" && /^\d+(\.\d+)?$/.test(numTok.v!);
        const num = hasNum ? Number(numTok!.v) : null;
        if (hasNum) this.i++;
        if (m.t === "*") {
          if (num === null || num < 1) this.errors.push(`"*" : nombre ≥ 1 attendu (position ${m.pos + 1})`);
          else node = { kind: "repeat", node, times: Math.min(MAX_REPEAT, Math.round(num)) };
        } else if (m.t === "!") {
          copies = Math.min(MAX_REPEAT, Math.max(1, Math.round(num ?? 2)));
        } else if (m.t === "@") {
          if (num === null || num <= 0) this.errors.push(`"@" : poids > 0 attendu (position ${m.pos + 1})`);
          else weight = num;
        } else {
          const p = num ?? 0.5;
          if (p < 0 || p > 1) this.errors.push(`"?" : probabilité entre 0 et 1 (position ${m.pos + 1})`);
          else node = { kind: "prob", node, p };
        }
        continue;
      }
      break;
    }
    return { node, weight, copies };
  }

  private readArgs(): number[] {
    const out: number[] = [];
    for (;;) {
      this.skipWs();
      const t = this.peek();
      if (!t) {
        this.errors.push(`")" manquant`);
        return out;
      }
      this.i++;
      if (t.t === ")") return out;
      if (t.t === ",") continue;
      if (t.t === "word" && /^-?\d+$/.test(t.v!)) out.push(Number(t.v));
      else out.push(NaN);
    }
  }

  private expect(t: string): void {
    this.skipWs();
    if (this.peek()?.t === t) this.i++;
    else this.errors.push(`"${t}" manquant`);
  }

  get rest(): Tok[] {
    return this.toks.slice(this.i);
  }
}

const GRID_RE = /^[xX.\-~_]{2,}$/;

function isGrid(word: string): boolean {
  return GRID_RE.test(word) && /[xX.~]/.test(word) && !/^[-_]+$/.test(word);
}

/** `x..X-.` → une case par caractère ; - et _ prolongent la case précédente. */
function gridNode(word: string): MiniNode {
  const items: { node: MiniNode; weight: number }[] = [];
  for (const c of word) {
    if ((c === "-" || c === "_") && items.length) items[items.length - 1].weight += 1;
    else items.push({ node: c === "x" || c === "X" ? { kind: "atom", value: c } : { kind: "rest" }, weight: 1 });
  }
  return { kind: "seq", items };
}

/** Analyse une ligne. Une grille sans espace (`x..x`) donne un pas par caractère. */
export function parseLine(src: string): ParsedLine {
  const errors: string[] = [];
  const text = String(src ?? "").slice(0, MAX_LEN);
  if (String(src ?? "").length > MAX_LEN) errors.push(`ligne trop longue (max ${MAX_LEN})`);
  const trimmed = text.trim();
  if (isGrid(trimmed)) return { ast: gridNode(trimmed), errors };
  const parser = new Parser(lex(text, errors), errors);
  const ast = parser.parseStack();
  const rest = parser.rest.filter((t) => t.t !== "ws");
  if (rest.length) errors.push(`"${rest[0].t === "word" ? rest[0].v : rest[0].t}" inattendu (position ${rest[0].pos + 1})`);
  return { ast, errors };
}

/* ------------------------------------------------------------------ */
/* Requête                                                             */
/* ------------------------------------------------------------------ */

/** Bjorklund : k frappes réparties sur n pas ; rotation r vers la gauche (comme Tidal). */
export function euclid(k: number, n: number, r = 0): boolean[] {
  if (n <= 0) return [];
  let pattern: number[];
  if (k <= 0) pattern = Array(n).fill(0);
  else if (k >= n) pattern = Array(n).fill(1);
  else {
    let a: number[][] = Array.from({ length: k }, () => [1]);
    let b: number[][] = Array.from({ length: n - k }, () => [0]);
    while (b.length > 1) {
      const m = Math.min(a.length, b.length);
      const merged = a.slice(0, m).map((x, i) => [...x, ...b[i]]);
      const rest = a.length > m ? a.slice(m) : b.slice(m);
      a = merged;
      b = rest;
    }
    pattern = [...a.flat(), ...b.flat()];
  }
  const rot = ((r % n) + n) % n;
  const rotated = rot ? [...pattern.slice(rot), ...pattern.slice(0, rot)] : pattern;
  return rotated.map((v) => v === 1);
}

/** Événements d'un cycle (probabilités non tirées). */
export function queryCycle(node: MiniNode, cycle: number, start = 0, end = 1, p = 1, out: MiniEvent[] = []): MiniEvent[] {
  const len = end - start;
  switch (node.kind) {
    case "rest":
      return out;
    case "atom":
      out.push({ start, end, value: node.value, p });
      return out;
    case "seq": {
      const total = node.items.reduce((a, b) => a + b.weight, 0);
      if (!total) return out;
      let acc = 0;
      for (const { node: child, weight } of node.items) {
        const s = start + (acc / total) * len;
        acc += weight;
        queryCycle(child, cycle, s, start + (acc / total) * len, p, out);
      }
      return out;
    }
    case "stack":
      for (const child of node.items) queryCycle(child, cycle, start, end, p, out);
      return out;
    case "alt":
      if (node.items.length) queryCycle(node.items[((cycle % node.items.length) + node.items.length) % node.items.length], cycle, start, end, p, out);
      return out;
    case "repeat":
      for (let i = 0; i < node.times; i++) {
        queryCycle(node.node, cycle * node.times + i, start + (i / node.times) * len, start + ((i + 1) / node.times) * len, p, out);
      }
      return out;
    case "prob":
      return queryCycle(node.node, cycle, start, end, p * node.p, out);
    case "euclid": {
      const hits = euclid(node.k, node.n, node.r);
      hits.forEach((hit, i) => {
        if (hit) queryCycle(node.node, cycle, start + (i / node.n) * len, start + ((i + 1) / node.n) * len, p, out);
      });
      return out;
    }
  }
}

/** PRNG déterministe (mulberry32) dérivé de (graine, cycle, index). */
export function chance(seed: number, cycle: number, index: number): number {
  let t = (seed ^ Math.imul(cycle + 0x9e37, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35)) >>> 0;
  t = (t + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Événements joués d'un cycle : probabilités tirées avec la graine. Triés par début. */
export function eventsForCycle(node: MiniNode, cycle: number, seed = 0): MiniEvent[] {
  const all = queryCycle(node, cycle).sort((a, b) => a.start - b.start);
  return all.filter((e, i) => e.p >= 1 || chance(seed, cycle, i) < e.p);
}

/* ------------------------------------------------------------------ */
/* Gammes                                                              */
/* ------------------------------------------------------------------ */

export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  "harmonic-minor": [0, 2, 3, 5, 7, 8, 11],
  "melodic-minor": [0, 2, 3, 5, 7, 9, 11],
  "major-pentatonic": [0, 2, 4, 7, 9],
  "minor-pentatonic": [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  "whole-tone": [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** `a:minor-pentatonic`, `c#3:dorian` → { root (MIDI), steps } ; null si invalide. */
export function parseScale(spec: string, octave = 4): { root: number; steps: number[] } | null {
  const m = /^([a-gA-G])(#|b)?(-?\d)?:([a-z-]+)$/.exec(spec.trim());
  if (!m || !SCALES[m[4]]) return null;
  const oct = m[3] !== undefined ? Number(m[3]) : octave;
  const root = (oct + 1) * 12 + PITCH[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return { root, steps: SCALES[m[4]] };
}

export function degreeToMidi(degree: number, scale: { root: number; steps: number[] }): number {
  const n = scale.steps.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return scale.root + scale.steps[idx] + 12 * oct;
}
