import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import { listenDp } from "../../shared/audio/dp";
import { CounterTrigger, num } from "../../shared/media/control";
import {
  DEFAULT_FEATURES, MarkdownDoc, countWords, dedent, extract, extractVars, parseFeatures, protectEscapes, readVarValues,
  resolveVars, restoreEscapes, splitFrontmatter, type Block, type CodeEntry, type Feature, type Frontmatter, type LinkEntry,
  type TocEntry, type VarInfo,
} from "./parse";
import { renderTokens, type RenderCtx } from "./render";
import { KATEX_OPTIONS, ensureKatex, ensurePrismLanguage, katexReady } from "./engines";

export const MAX_LENGTH_DEFAULT = 200_000;
const MAX_LENGTH_CAP = 2_000_000;
const ACTIONS = ["copy", "copy-rendered", "scroll-to", "refresh"] as const;
type Action = (typeof ACTIONS)[number];

export type MarkdownSettings = {
  features: Feature[];
  linkTarget: "_blank" | "_self";
  headingOffset: number;
  streaming: boolean;
};

export type MarkdownState = {
  status: "idle" | "loading" | "streaming" | "ready" | "error";
  error: string | null;
  source: "source" | "src" | "text" | "slot";
  length: number;
  truncated: boolean;
  stats: { words: number; readingMinutes: number; blocks: number };
  frontmatter: Frontmatter | null;
  title: string | null;
  toc: TocEntry[];
  code: CodeEntry[];
  links: LinkEntry[];
  vars: VarInfo[];
  missingVars: string[];
  resolved: string;
  lastAction: { n: number; action: string; ok: boolean; error?: string } | null;
  settings: MarkdownSettings;
};

type LiveParams = { text?: string; features?: Feature[]; linkTarget?: "_blank" | "_self"; headingOffset?: number; streaming?: boolean };

/**
 * Lit le DP `params` : `{ text, features, linkTarget, headingOffset, streaming }`. Clé absente ou `null` : l'attribut
 * s'applique. `invalid` liste les clés présentes mais refusées.
 */
export function readMarkdownParams(v: unknown, maxLength = MAX_LENGTH_CAP): { settings: LiveParams; invalid: string[] } {
  const p = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const o: LiveParams = {};
  const invalid: string[] = [];
  const present = (k: string) => p[k] !== undefined && p[k] !== null;
  if (present("text")) {
    if ((typeof p.text === "string" || typeof p.text === "number") && String(p.text).length <= maxLength) o.text = String(p.text);
    else invalid.push("text");
  }
  if (present("features")) {
    const raw = Array.isArray(p.features) ? p.features.join(" ") : p.features;
    const { features, unknown } = parseFeatures(raw);
    if (typeof raw === "string" && !unknown.length) o.features = features;
    else invalid.push("features");
  }
  if (present("linkTarget")) {
    if (p.linkTarget === "_blank" || p.linkTarget === "_self") o.linkTarget = p.linkTarget;
    else invalid.push("linkTarget");
  }
  if (present("headingOffset")) {
    const n = typeof p.headingOffset === "boolean" ? undefined : num(p.headingOffset, 0, 5);
    if (n === undefined) invalid.push("headingOffset");
    else o.headingOffset = Math.round(n);
  }
  if (present("streaming")) {
    if (typeof p.streaming === "boolean") o.streaming = p.streaming;
    else invalid.push("streaming");
  }
  return { settings: o, invalid };
}

/** Valeur du DP `source` : chaîne, ou `{ text, done }`. */
export function readSource(v: unknown): { text: string; done: boolean | null } | null {
  if (typeof v === "string") return { text: v, done: null };
  if (typeof v === "number") return { text: String(v), done: null };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string" || typeof o.text === "number") return { text: String(o.text), done: typeof o.done === "boolean" ? o.done : null };
  }
  return null;
}

const raf = (cb: () => void): number =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number);
const caf = (id: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  clearTimeout(id);
};

/**
 * Rendu Markdown (GFM) en DOM natif, sans `innerHTML` : texte (`text`, contenu de l'élément, DP `source`, URL `src`),
 * rendu incrémental en flux (`streaming`), variables de prompt `{{nom}}`, copie, plan, coloration (Prism) et formules
 * (KaTeX) chargées à la demande. Sortie complète dans `out-data-provider`.
 */
@customElement("sonic-markdown")
export class SonicMarkdown extends LitElement {
  /** Markdown à rendre ; vide : le texte contenu dans l'élément. */
  @property({ type: String }) text = "";
  /** Chemin DataProvider d'une chaîne Markdown, ou de `{ text, done }`. */
  @property({ type: String }) source = "";
  /** URL `https:` d'un fichier Markdown. */
  @property({ type: String }) src = "";
  /** Relecture de `src` toutes les `refresh` secondes (0 : jamais, minimum 10). */
  @property({ type: Number }) refresh = 0;
  /** Le texte grandit par la fin : rendu incrémental. */
  @property({ type: Boolean }) streaming = false;
  /** `gfm highlight math copy vars toc anchors` (défaut `gfm copy anchors`). */
  @property({ type: String }) features = DEFAULT_FEATURES.join(" ");
  /** Chemin DataProvider des valeurs de variables `{ nom: valeur }`. */
  @property({ type: String }) vars = "";
  @property({ type: String, attribute: "link-target" }) linkTarget = "_blank";
  @property({ type: Number, attribute: "heading-offset" }) headingOffset = 0;
  @property({ type: Number, attribute: "max-length" }) maxLength = MAX_LENGTH_DEFAULT;
  /** DP `{ n, action, id? }` : la hausse de `n` lance `action` (`copy`, `copy-rendered`, `scroll-to`, `refresh`). */
  @property({ type: String }) control = "";
  /** DP de réglages en direct : `{ text, features, linkTarget, headingOffset, streaming }`. */
  @property({ type: String }) params = "";
  @property({ type: String, attribute: "out-data-provider" }) outDataProvider = "";

  @state() private announce = "";

  private doc = new MarkdownDoc();
  private blocks: Block[] = [];
  private slotText = "";
  private dpText: { text: string; done: boolean | null } | null = null;
  private remoteText: string | null = null;
  private remoteLoading = false;
  private remoteError: string | null = null;
  private values: Record<string, string> = {};
  private live: LiveParams = {};
  private liveInvalid: string[] = [];
  private unsubs: Array<() => void> = [];
  private trigger = new CounterTrigger();
  private lastAction: MarkdownState["lastAction"] = null;
  private frame = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private fetchSeq = 0;
  private lastPublish = 0;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;
  private cache = new Map<string, unknown[]>();
  private cacheVersion = "";
  private engineVersion = 0;
  private pendingLangs = new Set<string>();
  private mathDone = new WeakMap<Element, string>();
  private stateCache: MarkdownState | null = null;
  private body = "";
  private protectedBody = "";
  private frontmatter: Frontmatter | null = null;
  private truncated = false;
  private extracted: ReturnType<typeof extract> = { toc: [], code: [], links: [], h1: null };
  private listenKey: string | null = null;
  private remoteKey: string | null = null;

  static styles = css`
    :host {
      display: block;
      color: var(--sc-base-content, #1f2937);
      font-family: var(--sc-font-family-base, system-ui, sans-serif);
      line-height: 1.6;
      max-width: var(--sc-markdown-measure, 72ch);
      overflow-wrap: anywhere;
    }
    :host([hidden]) { display: none; }
    .root > :first-child { margin-top: 0; }
    .root > :last-child { margin-bottom: 0; }
    h1, h2, h3, h4, h5, h6 {
      font-family: var(--sc-font-family-headings, inherit);
      line-height: 1.25;
      margin: 1.6em 0 0.6em;
      scroll-margin-top: 1rem;
    }
    h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h4 { font-size: 1.05em; }
    h5, h6 { font-size: 1em; }
    .anchor { margin-left: 0.4em; color: var(--sc-base-400, #9ca3af); text-decoration: none; opacity: 0; transition: opacity 0.15s; }
    .anchor::before { content: "#"; }
    h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor, h5:hover .anchor, h6:hover .anchor, .anchor:focus { opacity: 1; }
    p, ul, ol, blockquote, .table, .code, .math-block { margin: 0 0 1em; }
    a { color: var(--sc-primary, #2563eb); }
    ul, ol { padding-left: 1.5em; }
    li + li { margin-top: 0.25em; }
    li.task { list-style: none; }
    li.task label { display: inline-flex; gap: 0.5em; align-items: baseline; margin-left: -1.4em; }
    blockquote {
      padding: 0.25em 1em;
      border-left: 3px solid var(--sc-base-300, #d1d5db);
      color: color-mix(in oklab, var(--sc-base-content, #1f2937) 75%, transparent);
    }
    hr { border: 0; border-top: 1px solid var(--sc-base-300, #d1d5db); margin: 2em 0; }
    img { max-width: 100%; height: auto; border-radius: var(--sc-rounded-sm, 4px); }
    code, pre {
      font-family: var(--sc-font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
      font-size: 0.9em;
    }
    :not(pre) > code {
      padding: 0.1em 0.35em;
      border-radius: var(--sc-rounded-sm, 4px);
      background: color-mix(in oklab, var(--sc-base-content, #1f2937) 8%, transparent);
    }
    .code {
      border-radius: var(--sc-rounded-lg, 8px);
      background: color-mix(in oklab, var(--sc-base-content, #1f2937) 5%, var(--sc-base, #fff));
      border: 1px solid color-mix(in oklab, var(--sc-base-content, #1f2937) 10%, transparent);
      overflow: hidden;
    }
    .code-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.25em 0.5em 0.25em 0.9em;
      font-size: 0.8em;
      color: var(--sc-base-500, #6b7280);
      border-bottom: 1px solid color-mix(in oklab, var(--sc-base-content, #1f2937) 8%, transparent);
    }
    pre { margin: 0; padding: 0.9em; overflow-x: auto; line-height: 1.5; tab-size: 2; }
    .copy {
      font: inherit; cursor: pointer; border: 0; background: transparent; color: inherit;
      padding: 0.25em 0.5em; border-radius: var(--sc-rounded-sm, 4px);
    }
    .copy:hover, .copy:focus-visible { background: color-mix(in oklab, var(--sc-base-content, #1f2937) 10%, transparent); color: var(--sc-base-content, #1f2937); }
    .copy .l-done, .copy[data-copied] .l-copy { display: none; }
    .copy[data-copied] .l-done { display: inline; color: var(--sc-primary, #2563eb); }
    .table { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
    th, td { padding: 0.45em 0.75em; border-bottom: 1px solid color-mix(in oklab, var(--sc-base-content, #1f2937) 12%, transparent); text-align: left; vertical-align: top; }
    th { font-weight: 600; border-bottom-width: 2px; }
    .var {
      padding: 0 0.3em; border-radius: var(--sc-rounded-sm, 4px);
      background: color-mix(in oklab, var(--sc-primary, #2563eb) 14%, transparent);
      color: var(--sc-base-content, #1f2937);
    }
    .var.missing {
      background: transparent;
      outline: 1px dashed color-mix(in oklab, var(--sc-primary, #2563eb) 60%, transparent);
      color: var(--sc-primary, #2563eb);
    }
    .var.missing::before { content: "{{"; opacity: 0.5; }
    .var.missing::after { content: "}}"; opacity: 0.5; }
    .toc { margin: 0 0 1.5em; padding: 0.75em 1em; border-radius: var(--sc-rounded-lg, 8px); background: color-mix(in oklab, var(--sc-base-content, #1f2937) 4%, transparent); font-size: 0.9em; }
    .toc + * { margin-top: 0; }
    .toc ul { list-style: none; margin: 0; padding: 0; }
    .toc a { text-decoration: none; }
    .math-block { overflow-x: auto; text-align: center; }
    .footnotes { font-size: 0.875em; color: color-mix(in oklab, var(--sc-base-content, #1f2937) 80%, transparent); }
    .footnote-ref a, .footnote-backref { text-decoration: none; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    /* Coloration (classes Prism) aux couleurs du thème */
    .token.comment, .token.prolog, .token.doctype, .token.cdata { color: var(--sc-base-500, #6b7280); font-style: italic; }
    .token.punctuation { color: color-mix(in oklab, var(--sc-base-content, #1f2937) 70%, transparent); }
    .token.keyword, .token.atrule, .token.important, .token.rule { color: var(--sc-primary, #2563eb); }
    .token.string, .token.char, .token.attr-value, .token.regex, .token.inserted { color: var(--sc-success, #15803d); }
    .token.number, .token.boolean, .token.constant, .token.symbol { color: var(--sc-warning, #b45309); }
    .token.function, .token.class-name, .token.builtin { color: var(--sc-info, #0e7490); }
    .token.tag, .token.selector, .token.deleted { color: var(--sc-danger, #b91c1c); }
    .token.attr-name, .token.property, .token.variable { color: color-mix(in oklab, var(--sc-primary, #2563eb) 60%, var(--sc-base-content, #1f2937)); }
    .token.operator, .token.entity, .token.url { color: inherit; }
    .token.bold { font-weight: 600; } .token.italic { font-style: italic; }
    @media (prefers-reduced-motion: reduce) { .anchor { transition: none; } }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    if (!this.slotText) this.slotText = dedent(this.textContent ?? "");
    this.listenAll();
    this.syncRemote();
    this.schedule();
  }

  disconnectedCallback(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.listenKey = null;
    this.remoteKey = null;
    this.stopRefresh();
    if (this.frame) caf(this.frame);
    this.frame = 0;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    super.disconnectedCallback();
  }

  protected updated(c: PropertyValues): void {
    if (!this.isConnected) return;
    if (this.listenKeyNow() !== this.listenKey) this.listenAll();
    if (this.remoteKeyNow() !== this.remoteKey) this.syncRemote();
    const keys = ["text", "streaming", "features", "linkTarget", "headingOffset", "maxLength", "id"];
    if (keys.some((k) => c.has(k))) this.schedule();
  }

  private listenKeyNow(): string { return [this.source, this.vars, this.control, this.params].map((x) => x.trim()).join("\u0001"); }
  private remoteKeyNow(): string { return `${this.src.trim()}\u0001${this.refresh}`; }

  // ─── Réglages ──────────────────────────────────────────────────────────────

  settings(): MarkdownSettings {
    const attr = parseFeatures(this.features);
    const lt = this.live.linkTarget ?? this.linkTarget;
    const ho = this.live.headingOffset ?? Number(this.headingOffset);
    return {
      features: this.live.features ?? (attr.features.length || !this.features.trim() ? attr.features : DEFAULT_FEATURES),
      linkTarget: lt === "_self" ? "_self" : "_blank",
      headingOffset: Number.isFinite(ho) ? Math.max(0, Math.min(5, Math.round(ho))) : 0,
      streaming: this.live.streaming ?? this.streaming,
    };
  }

  private configError(): string | null {
    if (this.liveInvalid.length) return `params : valeur refusée pour ${this.liveInvalid.join(", ")}`;
    const unknown = this.live.features ? [] : parseFeatures(this.features).unknown;
    if (unknown.length) return `features inconnues : ${unknown.join(", ")}`;
    if (this.live.linkTarget === undefined && this.linkTarget !== "_blank" && this.linkTarget !== "_self") return `link-target "${this.linkTarget}" (_blank | _self)`;
    return null;
  }

  private maxLen(): number {
    const n = Number(this.maxLength);
    return Number.isFinite(n) && n > 0 ? Math.min(MAX_LENGTH_CAP, Math.round(n)) : MAX_LENGTH_DEFAULT;
  }

  private sourceKind(): MarkdownState["source"] {
    if (this.live.text !== undefined) return "text";
    if (this.source.trim()) return "source";
    if (this.src.trim()) return "src";
    if (this.text) return "text";
    return "slot";
  }

  private rawText(): string {
    if (this.live.text !== undefined) return this.live.text;
    switch (this.sourceKind()) {
      case "source": return this.dpText?.text ?? "";
      case "src": return this.remoteText ?? "";
      case "text": return this.text;
      default: return this.slotText;
    }
  }

  /** Flux en cours : `streaming` actif et `done` pas encore reçu. */
  private isStreaming(): boolean {
    if (!this.settings().streaming) return false;
    return !(this.sourceKind() === "source" && this.dpText?.done === true);
  }

  // ─── DataProviders ─────────────────────────────────────────────────────────

  private listenAll(): void {
    this.listenKey = this.listenKeyNow();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.trigger.reset();
    this.live = {};
    this.liveInvalid = [];
    this.dpText = null;
    this.values = {};
    const source = this.source.trim();
    if (source) this.unsubs.push(listenDp(source, (v) => {
      const next = readSource(v);
      const wasDone = this.dpText?.done === true;
      this.dpText = next;
      if (next && next.done === false && wasDone) this.doc.reset();
      this.schedule();
    }));
    const vars = this.vars.trim();
    if (vars) this.unsubs.push(listenDp(vars, (v) => { this.values = readVarValues(v); this.invalidate(); this.schedule(); }));
    const params = this.params.trim();
    if (params) this.unsubs.push(listenDp(params, (v) => {
      const { settings, invalid } = readMarkdownParams(v, this.maxLen());
      this.live = settings;
      this.liveInvalid = invalid;
      this.invalidate();
      this.schedule();
    }));
    const control = this.control.trim();
    if (control) this.unsubs.push(listenDp(control, (v) => {
      if (!this.trigger.feed(v)) return;
      const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      void this.runAction(String(o.action ?? "copy"), o, Number(o.n));
    }));
  }

  // ─── Source distante ───────────────────────────────────────────────────────

  private stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private syncRemote(): void {
    this.remoteKey = this.remoteKeyNow();
    this.stopRefresh();
    const url = this.src.trim();
    if (!url) { this.remoteText = null; this.remoteError = null; return; }
    void this.fetchRemote();
    const every = Number(this.refresh);
    if (Number.isFinite(every) && every > 0) this.refreshTimer = setInterval(() => void this.fetchRemote(), Math.max(10, every) * 1000);
  }

  private async fetchRemote(): Promise<void> {
    const url = this.src.trim();
    const seq = ++this.fetchSeq;
    if (!/^https:\/\//i.test(url)) {
      this.remoteError = "src : seules les URL https: sont acceptées";
      this.schedule();
      return;
    }
    this.remoteLoading = true;
    this.schedule();
    try {
      const res = await fetch(url, { credentials: "omit", redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt = await res.text();
      if (seq !== this.fetchSeq) return;
      this.remoteText = txt;
      this.remoteError = null;
    } catch (e) {
      if (seq !== this.fetchSeq) return;
      this.remoteError = `src : ${(e as Error).message || "échec du chargement"}`;
    } finally {
      if (seq === this.fetchSeq) {
        this.remoteLoading = false;
        this.schedule();
      }
    }
  }

  // ─── Analyse et rendu ──────────────────────────────────────────────────────

  /** Regroupe les mises à jour : une analyse par frame au plus. */
  private schedule(): void {
    if (this.frame) return;
    this.frame = raf(() => {
      this.frame = 0;
      this.process();
    });
  }

  /** Analyse immédiate (tests, actions). */
  flush(): void {
    if (this.frame) caf(this.frame);
    this.frame = 0;
    this.process();
  }

  private invalidate(): void {
    this.cache.clear();
  }

  private process(): void {
    const s = this.settings();
    let raw = this.rawText();
    const max = this.maxLen();
    this.truncated = raw.length > max;
    if (this.truncated) raw = raw.slice(0, max);
    const fm = splitFrontmatter(raw);
    this.frontmatter = fm.frontmatter;
    this.body = fm.body;
    this.protectedBody = protectEscapes(fm.body);
    const streaming = this.isStreaming();
    this.blocks = this.doc.update(this.protectedBody, s.features, streaming);
    const prefix = this.id ? this.id.replace(/[^\w-]/g, "") : "";
    this.extracted = extract(this.blocks, prefix, s.headingOffset);
    this.stateCache = null;
    this.requestUpdate();
    this.publish(streaming);
  }

  private ctxKey(s: MarkdownSettings): string {
    return [s.features.join(","), s.linkTarget, s.headingOffset, this.id, this.engineVersion].join("|");
  }

  private ctx(s: MarkdownSettings): RenderCtx {
    return {
      headingOffset: s.headingOffset,
      linkTarget: s.linkTarget,
      idPrefix: this.id ? this.id.replace(/[^\w-]/g, "") : "",
      copy: s.features.includes("copy"),
      vars: s.features.includes("vars"),
      highlight: s.features.includes("highlight"),
      math: s.features.includes("math"),
      anchors: s.features.includes("anchors"),
      values: this.values,
      onCopy: (text, button) => void this.copyText(text, button),
      requestLanguage: (lang) => this.loadLanguage(lang),
      mathRef: (expr, display) => (el?: Element) => this.renderMath(el, expr, display),
    };
  }

  private loadLanguage(lang: string): void {
    if (this.pendingLangs.has(lang)) return;
    this.pendingLangs.add(lang);
    ensurePrismLanguage(lang).then(
      () => { this.engineVersion++; this.invalidate(); this.requestUpdate(); },
      () => { /* langage indisponible : le bloc reste non coloré */ },
    );
  }

  private renderMath(el: Element | undefined, expr: string, display: boolean): void {
    if (!(el instanceof HTMLElement)) return;
    const key = `${display ? "D" : "I"}${expr}`;
    if (this.mathDone.get(el) === key) return;
    const k = katexReady();
    if (k) {
      try {
        k.render(expr, el, { ...KATEX_OPTIONS, displayMode: display });
        el.removeAttribute("data-pending");
      } catch {
        el.textContent = expr;
      }
      this.mathDone.set(el, key);
      return;
    }
    el.textContent = display ? expr : `$${expr}$`;
    el.setAttribute("data-pending", "");
    ensureKatex().then(
      () => { this.engineVersion++; this.invalidate(); this.requestUpdate(); },
      () => { /* formule laissée en texte */ },
    );
  }

  protected render(): unknown {
    const s = this.settings();
    const key = this.ctxKey(s) + "|" + JSON.stringify(this.values);
    if (key !== this.cacheVersion) { this.cache.clear(); this.cacheVersion = key; }
    const ctx = this.ctx(s);
    const hotKey = this.blocks.length ? this.blocks[this.blocks.length - 1].key : "";
    const streaming = this.isStreaming();
    const keep = new Set<string>();
    const out = repeat(this.blocks, (b) => b.key, (b) => {
      keep.add(b.key);
      // Le bloc chaud (dernier, en flux) est toujours re-rendu ; les autres sont mis en cache.
      if (streaming && b.key === hotKey) return renderTokens(b.tokens, ctx);
      let r = this.cache.get(b.key);
      if (!r) { r = renderTokens(b.tokens, ctx); this.cache.set(b.key, r); }
      return r;
    });
    if (this.cache.size > this.blocks.length * 2 + 50) for (const k of [...this.cache.keys()]) if (!keep.has(k) && !this.blocks.some((b) => b.key === k)) this.cache.delete(k);
    const toc = s.features.includes("toc") && this.extracted.toc.length > 1 ? this.renderToc() : nothing;
    return html`<div class="root" part="root" aria-busy=${streaming ? "true" : "false"} @click=${this.onClick}>${toc}${out}</div>
      <div class="sr-only" aria-live="polite">${this.announce || nothing}</div>`;
  }

  private renderToc(): unknown {
    const toc = this.extracted.toc;
    const min = Math.min(...toc.map((t) => t.level));
    return html`<nav class="toc" part="toc" aria-label="Sommaire"><ul>${toc.map((t) => html`<li style="margin-left:${(t.level - min) * 1}em"><a href="#${t.id}">${t.text}</a></li>`)}</ul></nav>`;
  }

  /** Ancres internes : le document vit dans un shadow root, la navigation `#id` est faite à la main. */
  private onClick = (e: Event): void => {
    const a = (e.composedPath() as Element[]).find((n) => n instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
    const href = a?.getAttribute("href") ?? "";
    if (!href.startsWith("#") || href.length < 2) return;
    e.preventDefault();
    this.scrollToId(decodeURIComponent(href.slice(1)));
  };

  private findId(id: string): HTMLElement | null {
    const root = this.renderRoot as ShadowRoot | HTMLElement;
    const prefix = this.id ? this.id.replace(/[^\w-]/g, "") + "-" : "";
    const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
    return root.querySelector<HTMLElement>(`#${esc(id)}`) ?? (prefix ? root.querySelector<HTMLElement>(`#${esc(prefix + id)}`) : null);
  }

  private scrollToId(id: string): boolean {
    const el = this.findId(id);
    if (!el) return false;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
    return true;
  }

  private async writeClipboard(text: string): Promise<void> {
    if (!navigator.clipboard?.writeText) throw new Error("presse-papiers indisponible");
    await navigator.clipboard.writeText(text);
  }

  private async copyText(text: string, button?: HTMLElement): Promise<boolean> {
    try {
      await this.writeClipboard(text);
      if (button) {
        button.setAttribute("data-copied", "");
        setTimeout(() => button.removeAttribute("data-copied"), 1500);
      }
      this.announce = "Copié dans le presse-papiers";
      setTimeout(() => { this.announce = ""; }, 1500);
      return true;
    } catch {
      this.announce = "Copie impossible";
      return false;
    }
  }

  private async runAction(action: string, o: Record<string, unknown>, n: number): Promise<void> {
    if (!(ACTIONS as readonly string[]).includes(action)) {
      this.lastAction = { n, action, ok: false, error: `action inconnue (${ACTIONS.join(" | ")})` };
      this.stateCache = null;
      this.publish(false, true);
      return;
    }
    this.flush();
    await this.updateComplete;
    let ok = false;
    let error: string | undefined;
    try {
      switch (action as Action) {
        case "copy":
          ok = await this.copyText(this.getState().resolved);
          break;
        case "copy-rendered": {
          const root = (this.renderRoot as ShadowRoot).querySelector(".root") as HTMLElement | null;
          ok = await this.copyText((root?.innerText || root?.textContent || "").trim());
          break;
        }
        case "scroll-to":
          ok = this.scrollToId(String(o.id ?? ""));
          if (!ok) error = `id introuvable : ${String(o.id ?? "")}`;
          break;
        case "refresh":
          if (this.src.trim()) { await this.fetchRemote(); ok = !this.remoteError; error = this.remoteError ?? undefined; }
          else { this.doc.reset(); this.invalidate(); this.flush(); ok = true; }
          break;
      }
    } catch (e) {
      error = (e as Error).message;
    }
    if (!ok && !error && (action === "copy" || action === "copy-rendered")) error = "presse-papiers indisponible ou refusé";
    this.lastAction = { n, action, ok, ...(error ? { error } : {}) };
    this.stateCache = null;
    this.publish(false, true);
  }

  // ─── Sortie ────────────────────────────────────────────────────────────────

  getState(): MarkdownState {
    if (this.stateCache) return this.stateCache;
    const s = this.settings();
    const varsOn = s.features.includes("vars");
    const vars = varsOn ? extractVars(this.protectedBody, this.values) : [];
    const kind = this.sourceKind();
    const raw = this.rawText();
    const err = this.configError() ?? (kind === "src" ? this.remoteError : null);
    let status: MarkdownState["status"];
    if (err) status = "error";
    else if (kind === "src" && this.remoteLoading && this.remoteText === null) status = "loading";
    else if (!raw.trim()) status = "idle";
    else status = this.isStreaming() ? "streaming" : "ready";
    const words = countWords(restoreEscapes(this.body));
    const fmTitle = this.frontmatter && typeof this.frontmatter.title === "string" ? this.frontmatter.title : null;
    this.stateCache = {
      status,
      error: err,
      source: kind,
      length: raw.length,
      truncated: this.truncated,
      stats: { words, readingMinutes: words ? Math.max(1, Math.ceil(words / 230)) : 0, blocks: this.blocks.length },
      frontmatter: this.frontmatter,
      title: fmTitle ?? this.extracted.h1,
      toc: this.extracted.toc,
      code: this.extracted.code,
      links: this.extracted.links,
      vars,
      missingVars: vars.filter((v) => !v.filled && v.default === null).map((v) => v.name),
      resolved: resolveVars(this.protectedBody, this.values, varsOn),
      lastAction: this.lastAction,
      settings: s,
    };
    return this.stateCache;
  }

  /** Publie l'état ; en flux, au plus toutes les 100 ms (la dernière valeur est toujours publiée). */
  private publish(streaming: boolean, force = false): void {
    if (!this.outDataProvider) return;
    const now = Date.now();
    const send = () => {
      this.publishTimer = null;
      this.lastPublish = Date.now();
      set(this.outDataProvider, this.getState());
    };
    if (force || !streaming || now - this.lastPublish >= 100) {
      if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = null; }
      send();
      return;
    }
    if (!this.publishTimer) this.publishTimer = setTimeout(send, 100 - (now - this.lastPublish));
  }
}
