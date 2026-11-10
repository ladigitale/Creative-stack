/**
 * Analyse Markdown (GFM) sans DOM : markdown-it en tokens, frontmatter, variables `{{nom}}`, découpage en
 * blocs de premier niveau pour le rendu incrémental, extraction de la sortie DataProvider (plan, code, liens…).
 * Aucune sortie HTML : le rendu se fait à partir des tokens (voir render.ts).
 */
import markdownIt, { type Env, type MarkdownIt, type Token } from "markdown-it";
import footnote from "markdown-it-footnote";

export type { Token };

export const FEATURES = ["gfm", "highlight", "math", "copy", "vars", "toc", "anchors"] as const;
export type Feature = (typeof FEATURES)[number];
export const DEFAULT_FEATURES: Feature[] = ["gfm", "copy", "anchors"];

/** `"gfm copy"` → features connues ; les inconnues sont listées dans `unknown`. */
export function parseFeatures(value: unknown): { features: Feature[]; unknown: string[] } {
  const words = String(value ?? "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const features: Feature[] = [];
  const unknown: string[] = [];
  for (const w of words) {
    if ((FEATURES as readonly string[]).includes(w)) { if (!features.includes(w as Feature)) features.push(w as Feature); }
    else unknown.push(w);
  }
  return { features, unknown };
}

// ─── URL ─────────────────────────────────────────────────────────────────────

/**
 * Lien : `https:`, `http:`, `mailto:`, ancre `#…` ou chemin relatif sans schéma ; image : `https:`, `blob:`,
 * `data:image/(png|jpeg|gif|webp|avif)` (pas de SVG en data:). Tout le reste → `null` (rendu en texte).
 */
export function safeUrl(raw: string, kind: "link" | "image"): string | null {
  const url = String(raw ?? "").trim();
  if (!url) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (kind === "image") {
    if (scheme === "https" || scheme === "blob") return url;
    if (scheme === "data") return /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(url) ? url : null;
    return null;
  }
  if (!scheme) return url.startsWith("//") ? null : url;
  return scheme === "https" || scheme === "http" || scheme === "mailto" ? url : null;
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────

export type Frontmatter = Record<string, unknown>;

function yamlScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner.replace(/''/g, "'");
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => yamlScalar(x)) : [];
  }
  return s.replace(/\s+#.*$/, "");
}

/**
 * YAML minimal (aucune exécution, ni ancre, ni tag) : `clé: valeur` (chaîne, nombre, booléen, null, liste `[a, b]`)
 * et listes en tirets sous une clé vide. Les lignes non reconnues sont ignorées. 100 clés au plus.
 */
export function parseFrontmatterYaml(src: string): Frontmatter {
  const out: Frontmatter = {};
  let listKey: string | null = null;
  for (const line of src.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = /^\s+-\s*(.*)$/.exec(line) ?? (listKey ? /^-\s*(.*)$/.exec(line) : null);
    if (item && listKey) {
      (out[listKey] as unknown[]).push(yamlScalar(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w.-]{0,63})\s*:(.*)$/.exec(line);
    if (!kv) { listKey = null; continue; }
    if (Object.keys(out).length >= 100) break;
    const [, key, rest] = kv;
    if (key === "__proto__" || key === "constructor" || key === "prototype") { listKey = null; continue; }
    if (rest.trim() === "") { out[key] = []; listKey = key; }
    else { out[key] = yamlScalar(rest); listKey = null; }
  }
  return out;
}

/** `---\n…\n---` en tête : frontmatter et corps (avec son décalage dans le texte d'origine). */
export function splitFrontmatter(text: string): { frontmatter: Frontmatter | null; body: string; offset: number } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { frontmatter: null, body: text, offset: 0 };
  return { frontmatter: parseFrontmatterYaml(m[1]), body: text.slice(m[0].length), offset: m[0].length };
}

// ─── Variables ───────────────────────────────────────────────────────────────

/** Remplace `\{{` avant l'analyse (markdown-it supprimerait la barre) ; restitué au rendu en `{{`. */
export const ESC_OPEN = "";
export const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]{0,63})\s*(?:\|([^{}\n]{0,500}))?\}\}/g;
export const MAX_VARS = 100;
export const MAX_VAR_VALUE = 10_000;

export type VarInfo = { name: string; default: string | null; value: string | null; filled: boolean };

export function protectEscapes(src: string): string { return src.replace(/\\\{\{/g, ESC_OPEN + "{"); }
export function restoreEscapes(src: string): string { return src.split(ESC_OPEN + "{").join("{{").split(ESC_OPEN).join("{"); }

/** Valeurs de variables depuis un DP : objet plat, valeurs converties en chaîne et bornées. */
export function readVarValues(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined || typeof val === "object") continue;
    out[k] = String(val).slice(0, MAX_VAR_VALUE);
  }
  return out;
}

/** Variables du texte (déjà protégé), dans l'ordre d'apparition, au plus 100 distinctes. */
export function extractVars(protectedSrc: string, values: Record<string, string>): VarInfo[] {
  const seen = new Map<string, VarInfo>();
  for (const m of protectedSrc.matchAll(VAR_RE)) {
    const name = m[1];
    const def = m[2] !== undefined ? m[2].trim() : null;
    const prev = seen.get(name);
    if (prev) { if (prev.default === null && def !== null) prev.default = def; continue; }
    if (seen.size >= MAX_VARS) break;
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : null;
    seen.set(name, { name, default: def, value, filled: value !== null && value !== "" });
  }
  return [...seen.values()];
}

/** Valeur affichée/copiée d'une variable : valeur fournie, sinon défaut, sinon `null`. */
export function varValue(name: string, def: string | null, values: Record<string, string>): string | null {
  const v = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
  if (v !== undefined && v !== "") return v;
  return def;
}

/** Texte avec variables substituées (celles sans valeur ni défaut restent `{{nom}}`), échappements restitués. */
export function resolveVars(protectedSrc: string, values: Record<string, string>, enabled: boolean): string {
  if (!enabled) return restoreEscapes(protectedSrc);
  const out = protectedSrc.replace(VAR_RE, (all, name: string, def?: string) => {
    const v = varValue(name, def !== undefined ? def.trim() : null, values);
    return v === null ? `{{${name}}}` : v;
  });
  return restoreEscapes(out);
}

/** Découpe un texte en morceaux texte / variable (rendu des puces). */
export function splitVars(text: string): Array<string | { name: string; default: string | null }> {
  const parts: Array<string | { name: string; default: string | null }> = [];
  let last = 0;
  for (const m of text.matchAll(VAR_RE)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    parts.push({ name: m[1], default: m[2] !== undefined ? m[2].trim() : null });
    last = i + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ─── markdown-it ─────────────────────────────────────────────────────────────

type StateInline = { src: string; pos: number; posMax: number; push(type: string, tag: string, nesting: number): Token };
type StateBlock = {
  src: string; bMarks: number[]; eMarks: number[]; tShift: number[]; sCount: number[]; blkIndent: number; line: number;
  push(type: string, tag: string, nesting: number): Token;
};

/** `$…$` (pas d'espace intérieur aux bords, pas de chiffre juste après) et `$$…$$` en bloc. */
function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.after("escape", "math_inline", ((state: StateInline, silent: boolean) => {
    const { src, pos, posMax } = state;
    if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
    if (src.charCodeAt(pos + 1) === 0x24) return false;
    const first = src[pos + 1];
    if (!first || /\s/.test(first)) return false;
    let end = pos + 1;
    while (end <= posMax) {
      end = src.indexOf("$", end);
      if (end < 0 || end > posMax) return false;
      if (src[end - 1] === "\\") { end++; continue; }
      break;
    }
    if (end === pos + 1) return false;
    if (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] ?? "")) return false;
    if (!silent) {
      const t = state.push("math_inline", "math", 0);
      t.content = src.slice(pos + 1, end);
      t.markup = "$";
    }
    state.pos = end + 1;
    return true;
  }) as never);

  md.block.ruler.before("fence", "math_block", ((state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    if (state.src.slice(start, start + 2) !== "$$") return false;
    const firstRest = state.src.slice(start + 2, max);
    if (silent) return true;
    let content = "";
    let line = startLine;
    let closed = false;
    const oneLine = /^(.*)\$\$\s*$/.exec(firstRest);
    if (oneLine && firstRest.trim().length > 2) { content = oneLine[1]; closed = true; }
    else {
      content = firstRest;
      for (line = startLine + 1; line < endLine; line++) {
        const s = state.bMarks[line] + state.tShift[line];
        const e = state.eMarks[line];
        const txt = state.src.slice(s, e);
        if (state.sCount[line] < state.blkIndent && txt) break;
        const close = /^(.*)\$\$\s*$/.exec(txt);
        if (close) { content += (content ? "\n" : "") + close[1]; closed = true; break; }
        content += (content ? "\n" : "") + state.src.slice(state.bMarks[line], e);
      }
    }
    const next = closed ? line + 1 : line;
    state.line = next;
    const t = state.push("math_block", "math", 0);
    t.block = true;
    t.content = content.trim();
    t.map = [startLine, next];
    t.markup = "$$";
    t.meta = { closed };
    return true;
  }) as never, { alt: ["paragraph", "reference", "blockquote", "list"] });
}

const mdCache = new Map<string, MarkdownIt>();

/** Instance markdown-it pour un jeu de features (HTML brut désactivé : rendu comme texte). */
export function getMd(features: readonly Feature[]): MarkdownIt {
  const gfm = features.includes("gfm");
  const math = features.includes("math");
  const key = `${gfm}|${math}`;
  let md = mdCache.get(key);
  if (md) return md;
  md = markdownIt("default", { html: false, linkify: gfm, typographer: false, breaks: false });
  if (!gfm) md.disable(["table", "strikethrough"]);
  if (gfm) md.use(footnote);
  if (math) md.use(mathPlugin);
  // markdown-it valide les URL pour son propre rendu HTML ; ici on garde tout et on filtre au rendu (safeUrl).
  md.validateLink = () => true;
  mdCache.set(key, md);
  return md;
}

// ─── Blocs ───────────────────────────────────────────────────────────────────

export type Block = {
  /** Clé stable pour `repeat()` : décalage + empreinte du source du bloc. */
  key: string;
  /** Décalage du bloc dans le corps. */
  start: number;
  tokens: Token[];
};

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function lineOffsets(src: string): number[] {
  const out = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

/** Regroupe des tokens à plat en blocs de premier niveau, avec leur décalage dans `src` (+ `base`). */
export function groupBlocks(tokens: Token[], src: string, base: number): Block[] {
  const lines = lineOffsets(src);
  const raw: Array<{ tokens: Token[]; line: number | null }> = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (depth === 0) cur = [];
    cur.push(t);
    depth += t.nesting;
    if (depth === 0) raw.push({ tokens: cur, line: cur[0].map ? cur[0].map[0] : null });
  }
  if (depth !== 0 && cur.length) raw.push({ tokens: cur, line: cur[0].map ? cur[0].map[0] : null });
  return raw.map((r, i) => {
    const start = r.line !== null ? (lines[r.line] ?? src.length) : src.length;
    const nextLine = raw.slice(i + 1).find((x) => x.line !== null)?.line;
    const end = nextLine !== undefined && nextLine !== null ? (lines[nextLine] ?? src.length) : src.length;
    const sig = r.line !== null ? src.slice(start, end) : r.tokens.map((t) => t.type + t.content).join("|");
    return { key: `${base + start}:${hash(sig)}${r.line === null ? `:${i}` : ""}`, start: base + start, tokens: r.tokens };
  });
}

type Refs = NonNullable<Env["references"]>;

/**
 * Document analysé, avec rendu incrémental : en flux, seul le dernier bloc de premier niveau (zone chaude) est
 * ré-analysé ; les blocs précédents, déjà suivis d'un autre bloc, ne peuvent plus changer et gardent leurs tokens.
 */
export class MarkdownDoc {
  private src = "";
  private key = "";
  private stable: Block[] = [];
  private hot: Block[] = [];
  private hotStart = 0;
  private refs: Refs = {};
  private incr = false;
  /** Nombre d'analyses complètes (tests). */
  fullParses = 0;
  /** Nombre d'analyses de la seule zone chaude (tests). */
  partialParses = 0;

  get blocks(): Block[] { return this.hot.length ? this.stable.concat(this.hot) : this.stable; }

  /** Met à jour le document ; `incremental` : le texte ne fait que grandir (flux non terminé). */
  update(body: string, features: readonly Feature[], incremental: boolean): Block[] {
    const key = `${features.includes("gfm")}|${features.includes("math")}`;
    if (body === this.src && key === this.key && incremental === this.incr) return this.blocks;
    const md = getMd(features);
    const canExtend = incremental && this.incr && key === this.key && this.src && body.startsWith(this.src) && body.length >= this.hotStart;
    if (!canExtend) {
      this.key = key;
      this.src = body;
      this.fullParses++;
      this.incr = incremental;
      if (!incremental) {
        const env: Env = {};
        const all = groupBlocks(md.parse(body, env), body, 0);
        this.stable = all;
        this.hot = [];
        this.hotStart = body.length;
        this.refs = { ...(env.references ?? {}) };
        return this.stable;
      }
      this.stable = [];
      this.refs = {};
      this.hotStart = 0;
    }
    this.src = body;
    if (canExtend) this.partialParses++;
    const chunk = body.slice(this.hotStart);
    const env: Env = { references: { ...this.refs } };
    let tokens = md.parse(chunk, env);
    const fb = tokens.findIndex((t) => t.type === "footnote_block_open");
    if (fb >= 0) tokens = tokens.slice(0, fb);
    const groups = groupBlocks(tokens, chunk, this.hotStart);
    this.refs = { ...this.refs, ...(env.references ?? {}) };
    if (groups.length > 1) {
      const last = groups[groups.length - 1];
      this.stable = this.stable.concat(groups.slice(0, -1));
      this.hot = [last];
      this.hotStart = last.start;
    } else {
      this.hot = groups;
    }
    return this.blocks;
  }

  reset(): void {
    this.src = "";
    this.key = "";
    this.stable = [];
    this.hot = [];
    this.hotStart = 0;
    this.refs = {};
    this.incr = false;
  }
}

// ─── Extraction (sortie DataProvider) ────────────────────────────────────────

export type TocEntry = { level: number; text: string; id: string };
export type CodeEntry = { index: number; lang: string | null; info: string; text: string; lines: number };
export type LinkEntry = { text: string; href: string; external: boolean };

/** Identifiant ASCII minuscule d'un titre. */
export function slugify(text: string): string {
  const s = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "").trim().replace(/[\s-]+/g, "-").replace(/^-|-$/g, "");
  return s || "section";
}

/** Texte brut d'un token `inline` (variables restituées telles quelles). */
export function inlineText(t: Token | undefined): string {
  if (!t) return "";
  if (!t.children) return restoreEscapes(t.content);
  let s = "";
  for (const c of t.children) {
    if (c.type === "text" || c.type === "code_inline" || c.type === "text_special" || c.type === "math_inline") s += c.content;
    else if (c.type === "softbreak" || c.type === "hardbreak") s += " ";
    else if (c.type === "image") s += inlineText(c);
  }
  return restoreEscapes(s);
}

export type Extract = { toc: TocEntry[]; code: CodeEntry[]; links: LinkEntry[]; h1: string | null };

/**
 * Parcourt les blocs : ids de titres (dédupliqués `-2`, `-3`, préfixés par `prefix`), stockés dans
 * `token.meta.slug` pour le rendu ; plan, blocs de code et liens.
 */
export function extract(blocks: Block[], prefix: string, offset: number): Extract {
  const used = new Map<string, number>();
  const toc: TocEntry[] = [];
  const code: CodeEntry[] = [];
  const links: LinkEntry[] = [];
  let h1: string | null = null;
  for (const b of blocks) {
    const ts = b.tokens;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (t.type === "heading_open") {
        const text = inlineText(ts[i + 1]);
        const base = (prefix ? `${prefix}-` : "") + slugify(text);
        const n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        const id = n === 1 ? base : `${base}-${n}`;
        t.meta = { ...(t.meta ?? {}), slug: id };
        const level = Math.min(6, Number(t.tag.slice(1)) + offset);
        if (h1 === null && t.tag === "h1") h1 = text;
        toc.push({ level, text, id });
      } else if (t.type === "fence" || t.type === "code_block") {
        const info = restoreEscapes(t.info ?? "").trim();
        const text = restoreEscapes(t.content.replace(/\n$/, ""));
        code.push({ index: code.length, lang: info.split(/\s+/)[0] || null, info, text, lines: text ? text.split("\n").length : 0 });
      } else if (t.type === "inline" && t.children) {
        const cs = t.children;
        for (let j = 0; j < cs.length; j++) {
          if (cs[j].type !== "link_open") continue;
          const href = safeUrl(String(cs[j].attrGet("href") ?? ""), "link");
          let text = "";
          for (let k = j + 1; k < cs.length && cs[k].type !== "link_close"; k++) if (cs[k].type === "text" || cs[k].type === "code_inline") text += cs[k].content;
          if (href) links.push({ text: restoreEscapes(text), href, external: /^(https?|mailto):/i.test(href) });
        }
      }
    }
  }
  return { toc, code, links, h1 };
}

/** Nombre de mots (lettres/chiffres) d'un texte. */
export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

/** Retire l'indentation commune (contenu écrit dans l'élément HTML). */
export function dedent(text: string): string {
  const lines = text.replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(ind) && ind > 0 ? lines.map((l) => l.slice(ind)).join("\n") : lines.join("\n");
}
