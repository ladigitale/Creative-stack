/**
 * Lexique commun à PDF et PostScript : nombres, noms, chaînes, chaînes hexadécimales, tableaux, dictionnaires,
 * procédures, opérateurs. Lit des octets (Latin-1) sans jamais évaluer de code.
 */

export type PsName = { name: string; literal: boolean };
export type PsRef = { ref: number; gen: number };
export type PsValue = number | boolean | null | string | PsName | PsRef | PsValue[] | PsDict | PsProc | PsOp;
export type PsDict = { dict: Map<string, PsValue> };
export type PsProc = { proc: PsValue[] };
export type PsOp = { op: string };

export const isName = (v: unknown): v is PsName => !!v && typeof v === "object" && "name" in (v as object);
export const isRef = (v: unknown): v is PsRef => !!v && typeof v === "object" && "ref" in (v as object);
export const isDict = (v: unknown): v is PsDict => !!v && typeof v === "object" && "dict" in (v as object);
export const isProc = (v: unknown): v is PsProc => !!v && typeof v === "object" && "proc" in (v as object);
export const isOp = (v: unknown): v is PsOp => !!v && typeof v === "object" && "op" in (v as object);
export const nameOf = (v: unknown): string | null => (isName(v) ? v.name : null);

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

/** Lecteur de jetons sur un texte Latin-1 (un caractère = un octet). */
export class Lexer {
  pos: number;
  constructor(readonly s: string, start = 0, readonly end = s.length) {
    this.pos = start;
  }

  skipWs(): void {
    const s = this.s;
    while (this.pos < this.end) {
      const c = s.charCodeAt(this.pos);
      if (WS.has(c)) this.pos++;
      else if (c === 37) {
        while (this.pos < this.end && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++;
      } else break;
    }
  }

  /** Jeton suivant (structures `[`, `<<`, `{` renvoyées comme opérateurs à assembler par l'appelant), `undefined` en fin. */
  token(): PsValue | undefined {
    this.skipWs();
    const s = this.s;
    if (this.pos >= this.end) return undefined;
    const c = s[this.pos];
    if (c === "(") return this.literalString();
    if (c === "<") {
      if (s[this.pos + 1] === "<") {
        this.pos += 2;
        return { op: "<<" };
      }
      if (s[this.pos + 1] === "~") return this.ascii85String();
      return this.hexString();
    }
    if (c === ">" && s[this.pos + 1] === ">") {
      this.pos += 2;
      return { op: ">>" };
    }
    if (c === "[" || c === "]" || c === "{" || c === "}") {
      this.pos++;
      return { op: c };
    }
    if (c === "/") {
      this.pos++;
      // `//nom` (PostScript : nom immédiatement évalué) traité comme un nom littéral.
      if (s[this.pos] === "/") this.pos++;
      return { name: this.regular(), literal: true };
    }
    const word = this.regular();
    if (!word) {
      this.pos++;
      return { op: c };
    }
    const n = Number(word);
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word) && Number.isFinite(n)) return n;
    if (/^\d+#[0-9a-zA-Z]+$/.test(word)) {
      const [b, v] = word.split("#");
      const r = parseInt(v, Number(b));
      if (Number.isFinite(r)) return r;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { name: word.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), literal: false };
  }

  private regular(): string {
    const s = this.s;
    const start = this.pos;
    while (this.pos < this.end) {
      const c = s.charCodeAt(this.pos);
      if (WS.has(c) || DELIM.has(c)) break;
      this.pos++;
    }
    return s.slice(start, this.pos);
  }

  private literalString(): string {
    const s = this.s;
    this.pos++;
    let depth = 1;
    let out = "";
    while (this.pos < this.end) {
      const c = s[this.pos++];
      if (c === "\\") {
        const d = s[this.pos++];
        const esc: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
        if (d in esc) out += esc[d];
        else if (/[0-7]/.test(d)) {
          let o = d;
          while (o.length < 3 && /[0-7]/.test(s[this.pos])) o += s[this.pos++];
          out += String.fromCharCode(parseInt(o, 8) & 255);
        } else if (d === "\r") {
          if (s[this.pos] === "\n") this.pos++;
        } else if (d !== "\n") out += d;
      } else if (c === "(") {
        depth++;
        out += c;
      } else if (c === ")") {
        if (--depth === 0) break;
        out += c;
      } else out += c;
    }
    return out;
  }

  private hexString(): string {
    const s = this.s;
    this.pos++;
    const close = s.indexOf(">", this.pos);
    const body = s.slice(this.pos, close < 0 ? this.end : close).replace(/[^0-9a-fA-F]/g, "");
    this.pos = close < 0 ? this.end : close + 1;
    let out = "";
    for (let i = 0; i < body.length; i += 2) out += String.fromCharCode(parseInt((body[i] + (body[i + 1] ?? "0")), 16));
    return out;
  }

  private ascii85String(): string {
    const close = this.s.indexOf("~>", this.pos);
    const body = this.s.slice(this.pos + 2, close < 0 ? this.end : close);
    this.pos = close < 0 ? this.end : close + 2;
    return ascii85(body);
  }
}

/** Décodage ASCII85 (Adobe), texte Latin-1. */
export function ascii85(body: string): string {
  const src = body.replace(/\s+/g, "").replace(/^<~/, "").replace(/~>$/, "");
  let out = "";
  let group: number[] = [];
  const emit = (g: number[], n: number) => {
    let v = 0;
    for (const d of g) v = v * 85 + d;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let k = 0; k < n; k++) out += String.fromCharCode(bytes[k]);
  };
  for (const ch of src) {
    if (ch === "z" && !group.length) {
      out += "\0\0\0\0";
      continue;
    }
    const d = ch.charCodeAt(0) - 33;
    if (d < 0 || d > 84) continue;
    group.push(d);
    if (group.length === 5) {
      emit(group, 4);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length - 1;
    while (group.length < 5) group.push(84);
    emit(group, n);
  }
  return out;
}

/** Octets → texte Latin-1 (par blocs, pour les gros fichiers). */
export function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return s;
}

export function bytesOf(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

/** Inflate zlib (ou brut si l'en-tête manque) par DecompressionStream. */
export async function inflate(data: Uint8Array, format: "deflate" | "deflate-raw" | "gzip" = "deflate"): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("décompression indisponible dans ce navigateur");
  const run = async (fmt: "deflate" | "deflate-raw" | "gzip") => {
    const ds = new DecompressionStream(fmt);
    const writer = ds.writable.getWriter();
    writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    // Les flux tronqués lèvent en fin de lecture : on garde ce qui a été décompressé.
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > 200_000_000) throw new Error("flux décompressé trop gros");
      }
    } catch (e) {
      if (!total) throw e;
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  try {
    return await run(format);
  } catch (e) {
    if (format === "deflate") return run("deflate-raw");
    throw e;
  }
}
