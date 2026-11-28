/**
 * PDF et Illustrator (.ai enregistré avec « compatibilité PDF », par défaut depuis Illustrator 9) → formes.
 *
 * Lecture sans exécution : objets trouvés par balayage (fichiers à xref cassée compris), flux d'objets
 * (PDF 1.5), filtres Flate (prédicteurs PNG), LZW, ASCIIHex, ASCII85, RunLength. Une page (`page`, 1 par défaut),
 * contenus et formulaires XObject imbriqués, matrices (`cm`), couleurs gris / RVB / CMJN / séparations,
 * tracés (m l c v y h re) peints en trait (S s), en surface (f F f* B b) ou les deux. Textes, images,
 * dégradés : ignorés (comptés). Les fichiers chiffrés sont refusés.
 */
import { cmyk, hex, IDENTITY, MAX_SHAPES, mul, PathBuilder, apply, Skips, isFiniteMat, type Mat, type Shape } from "./geom";
import { ascii85, bytesOf, inflate, isDict, isName, isOp, isRef, latin1, Lexer, nameOf, type PsDict, type PsRef, type PsValue } from "./pslex";

type PdfStream = { dict: PsDict; start: number; length: number | PsRef | null };
type PdfObj = { value: PsValue; stream: PdfStream | null };

export type PdfResult = { shapes: Shape[]; unitMm: number; page: { x: number; y: number; w: number; h: number } | null; pages: number; skipped: Record<string, number>; issues: string[] };

/** Lecteur de valeurs PDF (tableaux, dictionnaires, références `n g R`) au-dessus du lexique. */
class Parser {
  private back: (PsValue | undefined)[] = [];
  constructor(readonly lex: Lexer) {}
  next(): PsValue | undefined {
    return this.back.length ? this.back.pop() : this.lex.token();
  }
  unread(v: PsValue | undefined): void {
    this.back.push(v);
  }
  value(depth = 0): PsValue | undefined {
    const t = this.next();
    if (t === undefined || depth > 64) return undefined;
    if (typeof t === "number" && Number.isInteger(t) && t >= 0) {
      const g = this.next();
      if (typeof g === "number" && Number.isInteger(g)) {
        const r = this.next();
        if (isName(r) && !r.literal && r.name === "R") return { ref: t, gen: g };
        this.unread(r);
      }
      this.unread(g);
      return t;
    }
    if (isOp(t)) {
      if (t.op === "[") {
        const arr: PsValue[] = [];
        for (;;) {
          const v = this.next();
          if (v === undefined || (isOp(v) && v.op === "]")) break;
          this.unread(v);
          const item = this.value(depth + 1);
          if (item === undefined) break;
          arr.push(item);
        }
        return arr;
      }
      if (t.op === "<<") {
        const dict = new Map<string, PsValue>();
        for (;;) {
          const k = this.next();
          if (k === undefined || (isOp(k) && k.op === ">>")) break;
          const key = nameOf(k);
          const v = this.value(depth + 1);
          if (key !== null && v !== undefined) dict.set(key, v);
        }
        return { dict };
      }
    }
    return t;
  }
}

export class PdfFile {
  private objs = new Map<number, PdfObj>();
  private decoded = new Map<number, Uint8Array | null>();
  readonly text: string;

  private constructor(bytes: Uint8Array) {
    this.text = latin1(bytes);
  }

  static async open(bytes: Uint8Array): Promise<PdfFile> {
    const f = new PdfFile(bytes);
    f.scan();
    await f.loadObjectStreams();
    return f;
  }

  private scan(): void {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    const s = this.text;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const num = Number(m[1]);
      const p = new Parser(new Lexer(s, m.index + m[0].length));
      const value = p.value();
      if (value === undefined) continue;
      let stream: PdfStream | null = null;
      const after = p.next();
      if (isName(after) && after.name === "stream" && isDict(value)) {
        let start = p.lex.pos;
        if (s[start] === "\r") start++;
        if (s[start] === "\n") start++;
        const len = value.dict.get("Length");
        stream = { dict: value, start, length: typeof len === "number" ? len : isRef(len) ? len : null };
        re.lastIndex = start;
      }
      this.objs.set(num, { value, stream });
    }
  }

  private async loadObjectStreams(): Promise<void> {
    for (const [num, o] of [...this.objs]) {
      if (!o.stream || nameOf(o.stream.dict.dict.get("Type")) !== "ObjStm") continue;
      const data = await this.streamData(num);
      if (!data) continue;
      const t = latin1(data);
      const n = Number(this.resolve(o.stream.dict.dict.get("N")) ?? 0);
      const first = Number(this.resolve(o.stream.dict.dict.get("First")) ?? 0);
      const head = new Lexer(t, 0, first);
      const pairs: [number, number][] = [];
      for (let k = 0; k < n; k++) {
        const a = head.token(), b = head.token();
        if (typeof a !== "number" || typeof b !== "number") break;
        pairs.push([a, b]);
      }
      for (const [objNum, off] of pairs) {
        if (this.objs.has(objNum)) continue;
        const v = new Parser(new Lexer(t, first + off)).value();
        if (v !== undefined) this.objs.set(objNum, { value: v, stream: null });
      }
    }
  }

  get encrypted(): boolean {
    return /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(this.text.slice(-4096)) || [...this.objs.values()].some((o) => isDict(o.value) && o.value.dict.has("Encrypt") && o.value.dict.has("Root"));
  }

  resolve(v: PsValue | undefined, depth = 0): PsValue | undefined {
    while (isRef(v) && depth++ < 32) v = this.objs.get(v.ref)?.value;
    return v;
  }
  dict(v: PsValue | undefined): Map<string, PsValue> | null {
    const r = this.resolve(v);
    return isDict(r) ? r.dict : null;
  }

  async streamData(num: number): Promise<Uint8Array | null> {
    if (this.decoded.has(num)) return this.decoded.get(num) ?? null;
    const o = this.objs.get(num);
    if (!o?.stream) return null;
    const s = this.text;
    let len = this.resolve(o.stream.length ?? undefined);
    let end = typeof len === "number" ? o.stream.start + len : -1;
    if (end < 0 || end > s.length || !/^\s*endstream/.test(s.slice(end, end + 32))) {
      const e = s.indexOf("endstream", o.stream.start);
      end = e < 0 ? s.length : e;
      while (end > o.stream.start && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
      len = end - o.stream.start;
    }
    let data: Uint8Array | null = bytesOf(s.slice(o.stream.start, end));
    const d = o.stream.dict.dict;
    const filters = ([] as PsValue[]).concat(this.resolve(d.get("Filter")) ?? []).map((f) => nameOf(this.resolve(f)));
    const parms = ([] as PsValue[]).concat(this.resolve(d.get("DecodeParms")) ?? []).map((p) => this.dict(p));
    for (let k = 0; k < filters.length && data; k++) data = await decodeFilter(filters[k], data, parms[k] ?? null, this);
    this.decoded.set(num, data);
    return data;
  }

  /** Objet (numéro) d'une valeur qui est une référence vers un flux. */
  streamNum(v: PsValue | undefined): number | null {
    return isRef(v) && this.objs.get(v.ref)?.stream ? v.ref : null;
  }

  pages(): Map<string, PsValue>[] {
    let root: Map<string, PsValue> | null = null;
    for (const o of this.objs.values()) {
      if (isDict(o.value) && nameOf(o.value.dict.get("Type")) === "Catalog") root = o.value.dict;
    }
    const out: Map<string, PsValue>[] = [];
    const seen = new Set<Map<string, PsValue>>();
    const walk = (node: Map<string, PsValue> | null, inherit: Map<string, PsValue>, depth: number) => {
      if (!node || seen.has(node) || depth > 32 || out.length > 5000) return;
      seen.add(node);
      const merged = new Map(inherit);
      for (const k of ["MediaBox", "CropBox", "Resources", "Rotate"]) if (node.has(k)) merged.set(k, node.get(k)!);
      const kids = this.resolve(node.get("Kids"));
      if (Array.isArray(kids)) for (const kid of kids) walk(this.dict(kid), merged, depth + 1);
      else if (nameOf(node.get("Type")) === "Page" || node.has("Contents")) {
        for (const [k, v] of merged) if (!node.has(k)) node.set(k, v);
        out.push(node);
      }
    };
    if (root) walk(this.dict(root.get("Pages")), new Map(), 0);
    if (!out.length) {
      // Arbre des pages introuvable : pages prises dans l'ordre du fichier.
      for (const o of this.objs.values()) if (isDict(o.value) && nameOf(o.value.dict.get("Type")) === "Page") out.push(o.value.dict);
    }
    return out;
  }
}

async function decodeFilter(name: string | null, data: Uint8Array, parms: Map<string, PsValue> | null, pdf: PdfFile): Promise<Uint8Array | null> {
  switch (name) {
    case "FlateDecode":
    case "Fl": {
      const raw = await inflate(data);
      return predict(raw, parms, pdf);
    }
    case "LZWDecode":
    case "LZW":
      return predict(lzw(data, Number(pdf.resolve(parms?.get("EarlyChange")) ?? 1) !== 0), parms, pdf);
    case "ASCIIHexDecode":
    case "AHx": {
      const h = latin1(data).replace(/[^0-9a-fA-F]/g, "");
      const out = new Uint8Array(Math.ceil(h.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2).padEnd(2, "0"), 16);
      return out;
    }
    case "ASCII85Decode":
    case "A85":
      return bytesOf(ascii85(latin1(data)));
    case "RunLengthDecode":
    case "RL": {
      const out: number[] = [];
      for (let i = 0; i < data.length;) {
        const n = data[i++];
        if (n === 128) break;
        if (n < 128) for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]);
        else {
          const b = data[i++];
          for (let k = 0; k < 257 - n; k++) out.push(b);
        }
      }
      return Uint8Array.from(out);
    }
    default:
      return null;
  }
}

/** Prédicteurs PNG (10 à 15) et TIFF (2) des flux Flate / LZW. */
function predict(data: Uint8Array, parms: Map<string, PsValue> | null, pdf: PdfFile): Uint8Array {
  const pred = Number(pdf.resolve(parms?.get("Predictor")) ?? 1);
  if (pred < 2) return data;
  const colors = Number(pdf.resolve(parms?.get("Colors")) ?? 1);
  const bpc = Number(pdf.resolve(parms?.get("BitsPerComponent")) ?? 8);
  const cols = Number(pdf.resolve(parms?.get("Columns")) ?? 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const row = Math.ceil((colors * bpc * cols) / 8);
  if (pred === 2) {
    const out = data.slice();
    for (let r = 0; r * row < out.length; r++) for (let i = bpp; i < row; i++) out[r * row + i] = (out[r * row + i] + out[r * row + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (row + 1));
  const out = new Uint8Array(rows * row);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (row + 1)];
    for (let i = 0; i < row; i++) {
      const raw = data[r * (row + 1) + 1 + i];
      const a = i >= bpp ? out[r * row + i - bpp] : 0;
      const b = r ? out[(r - 1) * row + i] : 0;
      const c = r && i >= bpp ? out[(r - 1) * row + i - bpp] : 0;
      let v = raw;
      if (type === 1) v = raw + a;
      else if (type === 2) v = raw + b;
      else if (type === 3) v = raw + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[r * row + i] = v & 255;
    }
  }
  return out;
}

/** LZW (PDF, TIFF) : codes de 9 à 12 bits, MSB d'abord. */
export function lzw(data: Uint8Array, early = true): Uint8Array {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []);
  };
  reset();
  let width = 9, bitPos = 0, prev: number[] | null = null;
  const total = data.length * 8;
  while (bitPos + width <= total) {
    let code = 0;
    for (let k = 0; k < width; k++) {
      const bit = (data[(bitPos + k) >> 3] >> (7 - ((bitPos + k) & 7))) & 1;
      code = (code << 1) | bit;
    }
    bitPos += width;
    if (code === 256) {
      reset();
      width = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const b of entry) out.push(b);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    const limit = dict.length + (early ? 1 : 0);
    if (limit >= 1 << width && width < 12) width++;
    if (out.length > 200_000_000) break;
  }
  return Uint8Array.from(out);
}

type Gs = { ctm: Mat; fill: string; stroke: string; fillSpace: string; strokeSpace: string };

const BLACK = "#000000";

/** Couleur d'un espace de couleur PDF à partir de ses composantes. */
function colorFrom(space: string, comps: number[]): string {
  if (space === "Separation") return hex(1 - (comps[0] ?? 1), 1 - (comps[0] ?? 1), 1 - (comps[0] ?? 1));
  if (comps.length === 1 || space === "DeviceGray" || space === "CalGray") return hex(comps[0], comps[0], comps[0]);
  if (comps.length === 3) return hex(comps[0], comps[1], comps[2]);
  if (comps.length === 4) return cmyk(comps[0], comps[1], comps[2], comps[3]);
  return BLACK;
}

export async function readPdf(bytes: Uint8Array, pageNumber = 1): Promise<PdfResult> {
  const pdf = await PdfFile.open(bytes);
  const skips = new Skips();
  const issues: string[] = [];
  if (pdf.encrypted) throw new Error("PDF protégé (chiffré) : l'enregistrer sans protection");
  const pages = pdf.pages();
  if (!pages.length) throw new Error("aucune page trouvée dans ce PDF");
  const index = Math.min(Math.max(1, Math.round(pageNumber)), pages.length) - 1;
  if (pages.length > 1) issues.push(`page ${index + 1} sur ${pages.length}`);
  const page = pages[index];
  const boxV = pdf.resolve(page.get("CropBox")) ?? pdf.resolve(page.get("MediaBox"));
  const box = Array.isArray(boxV) ? boxV.map((v) => Number(pdf.resolve(v))) : [0, 0, 612, 792];
  const [bx1, by1, bx2, by2] = box;
  const pageBox = { x: Math.min(bx1, bx2), y: Math.min(by1, by2), w: Math.abs(bx2 - bx1), h: Math.abs(by2 - by1) };
  if (Number(pdf.resolve(page.get("Rotate")) ?? 0) % 360) issues.push("rotation de page ignorée");

  const shapes: Shape[] = [];
  const contentsV = pdf.resolve(page.get("Contents"));
  const parts: number[] = [];
  for (const c of Array.isArray(contentsV) ? contentsV : [page.get("Contents")]) {
    const n = pdf.streamNum(c as PsValue);
    if (n !== null) parts.push(n);
  }
  let content = "";
  for (const n of parts) {
    const d = await pdf.streamData(n);
    if (d) content += latin1(d) + "\n";
    else skips.add("flux illisible");
  }
  await runContent(pdf, content, pdf.dict(page.get("Resources")), { ctm: IDENTITY, fill: BLACK, stroke: BLACK, fillSpace: "DeviceGray", strokeSpace: "DeviceGray" }, shapes, skips, 0);
  if (shapes.length > MAX_SHAPES) issues.push(`dessin tronqué à ${MAX_SHAPES} formes`);
  return { shapes, unitMm: 25.4 / 72, page: pageBox, pages: pages.length, skipped: skips.counts, issues };
}

async function runContent(pdf: PdfFile, content: string, res: Map<string, PsValue> | null, start: Gs, shapes: Shape[], skips: Skips, depth: number): Promise<void> {
  const lex = new Lexer(content);
  const stack: PsValue[] = [];
  const gstack: Gs[] = [];
  let gs: Gs = { ...start };
  let path = new PathBuilder();
  let inText = false;
  let ops = 0;
  const nums = (n: number) => stack.splice(-n).map((v) => Number(v));
  const pt = (x: number, y: number) => apply(gs.ctm, x, y);
  const paint = (fill: boolean, stroke: boolean, evenOdd = false, close = false) => {
    if (close) path.close();
    if (!path.empty && shapes.length <= MAX_SHAPES && (fill || stroke)) shapes.push({ segs: path.take(), fill: fill ? gs.fill : null, stroke: stroke ? gs.stroke : null, evenOdd });
    path = new PathBuilder();
  };
  const spaceName = (v: PsValue | undefined): string => {
    const n = nameOf(v);
    if (n && /^Device|^Cal|^Lab$|^Pattern$/.test(n)) return n;
    const cs = n ? pdf.resolve(pdf.dict(res?.get("ColorSpace"))?.get(n)) : pdf.resolve(v);
    if (Array.isArray(cs)) {
      const kind = nameOf(pdf.resolve(cs[0]));
      if (kind === "ICCBased") {
        const nC = Number(pdf.resolve(pdf.dict(cs[1])?.get("N")) ?? 3);
        return nC === 1 ? "DeviceGray" : nC === 4 ? "DeviceCMYK" : "DeviceRGB";
      }
      if (kind) return kind;
    }
    return nameOf(cs) ?? "DeviceRGB";
  };
  for (;;) {
    const t = lex.token();
    if (t === undefined) break;
    if (++ops > 20_000_000) break;
    if (!isName(t) || t.literal) {
      if (isOp(t) && (t.op === "[" || t.op === "<<")) {
        // Tableaux et dictionnaires d'opérandes (TJ, d, BDC…) : assemblés puis empilés.
        const p = new Parser(lex);
        p.unread(t);
        const v = p.value();
        if (v !== undefined) stack.push(v);
        continue;
      }
      stack.push(t);
      if (stack.length > 4096) stack.splice(0, 2048);
      continue;
    }
    const op = t.name;
    if (inText && op !== "ET") {
      stack.length = 0;
      continue;
    }
    switch (op) {
      case "q":
        gstack.push({ ...gs });
        break;
      case "Q":
        gs = gstack.pop() ?? gs;
        break;
      case "cm": {
        const m = nums(6) as Mat;
        if (isFiniteMat(m)) gs.ctm = mul(m, gs.ctm);
        break;
      }
      case "m": {
        const [x, y] = nums(2);
        path.moveTo(...pt(x, y));
        break;
      }
      case "l": {
        const [x, y] = nums(2);
        path.lineTo(...pt(x, y));
        break;
      }
      case "c": {
        const [x1, y1, x2, y2, x, y] = nums(6);
        path.curveTo(...pt(x1, y1), ...pt(x2, y2), ...pt(x, y));
        break;
      }
      case "v": {
        const [x2, y2, x, y] = nums(4);
        const cur = path.current ?? pt(x2, y2);
        path.curveTo(cur[0], cur[1], ...pt(x2, y2), ...pt(x, y));
        break;
      }
      case "y": {
        const [x1, y1, x, y] = nums(4);
        const end = pt(x, y);
        path.curveTo(...pt(x1, y1), end[0], end[1], end[0], end[1]);
        break;
      }
      case "h":
        path.close();
        break;
      case "re": {
        const [x, y, w, h] = nums(4);
        path.moveTo(...pt(x, y));
        path.lineTo(...pt(x + w, y));
        path.lineTo(...pt(x + w, y + h));
        path.lineTo(...pt(x, y + h));
        path.close();
        break;
      }
      case "S": paint(false, true); break;
      case "s": paint(false, true, false, true); break;
      case "f": case "F": paint(true, false); break;
      case "f*": paint(true, false, true); break;
      case "B": paint(true, true); break;
      case "B*": paint(true, true, true); break;
      case "b": paint(true, true, false, true); break;
      case "b*": paint(true, true, true, true); break;
      case "n": path = new PathBuilder(); break;
      case "W": case "W*": break;
      case "g": gs.fill = colorFrom("DeviceGray", nums(1)); gs.fillSpace = "DeviceGray"; break;
      case "G": gs.stroke = colorFrom("DeviceGray", nums(1)); gs.strokeSpace = "DeviceGray"; break;
      case "rg": gs.fill = colorFrom("DeviceRGB", nums(3)); gs.fillSpace = "DeviceRGB"; break;
      case "RG": gs.stroke = colorFrom("DeviceRGB", nums(3)); gs.strokeSpace = "DeviceRGB"; break;
      case "k": gs.fill = colorFrom("DeviceCMYK", nums(4)); gs.fillSpace = "DeviceCMYK"; break;
      case "K": gs.stroke = colorFrom("DeviceCMYK", nums(4)); gs.strokeSpace = "DeviceCMYK"; break;
      case "cs": gs.fillSpace = spaceName(stack.pop()); gs.fill = gs.fillSpace === "DeviceCMYK" ? cmyk(0, 0, 0, 1) : BLACK; break;
      case "CS": gs.strokeSpace = spaceName(stack.pop()); gs.stroke = BLACK; break;
      case "sc": case "scn": case "SC": case "SCN": {
        const comps = stack.filter((v) => typeof v === "number") as number[];
        const fillOp = op === "sc" || op === "scn";
        const space = fillOp ? gs.fillSpace : gs.strokeSpace;
        const c = space === "Pattern" || space === "DeviceN" || space === "Indexed" ? BLACK : colorFrom(space, comps);
        if (fillOp) gs.fill = c;
        else gs.stroke = c;
        break;
      }
      case "BT":
        inText = true;
        skips.add("texte");
        break;
      case "ET":
        inText = false;
        break;
      case "BI": {
        const m = /\sEI(?=[\s]|$)/g;
        m.lastIndex = lex.pos;
        const found = m.exec(content);
        lex.pos = found ? found.index + found[0].length : content.length;
        skips.add("image");
        break;
      }
      case "Do": {
        const name = nameOf(stack.pop());
        const xref = name ? pdf.dict(res?.get("XObject"))?.get(name) : undefined;
        const xo = pdf.dict(xref);
        const num = pdf.streamNum(xref);
        const subtype = nameOf(xo?.get("Subtype"));
        if (subtype === "Image") skips.add("image");
        else if (subtype === "Form" && num !== null && depth < 12) {
          const data = await pdf.streamData(num);
          if (data) {
            const mv = pdf.resolve(xo?.get("Matrix"));
            const fm = Array.isArray(mv) && mv.length === 6 ? (mv.map((v) => Number(pdf.resolve(v))) as Mat) : IDENTITY;
            await runContent(pdf, latin1(data), pdf.dict(xo?.get("Resources")) ?? res, { ...gs, ctm: mul(fm, gs.ctm) }, shapes, skips, depth + 1);
          }
        } else if (subtype === "PS") skips.add("PostScript incrusté");
        break;
      }
      case "sh":
        skips.add("dégradé");
        break;
      case "EI":
      case "ID":
        break;
      default:
        break;
    }
    stack.length = 0;
  }
}
