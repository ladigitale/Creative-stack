/**
 * Rendu des tokens markdown-it en templates Lit. Aucune chaîne HTML n'est injectée : le texte passe toujours par
 * l'interpolation Lit (échappée), les URL par `safeUrl`, et un token inconnu est rendu comme texte.
 */
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { ESC_OPEN, VAR_RE, inlineText, restoreEscapes, resolveVars, safeUrl, splitVars, varValue, type Token } from "./parse";
import { prismLanguage, prismTokenize, type PrismToken } from "./engines";

export type RenderCtx = {
  headingOffset: number;
  linkTarget: "_blank" | "_self";
  /** Préfixe des ids (titres, notes) : id de l'élément ou vide. */
  idPrefix: string;
  copy: boolean;
  vars: boolean;
  highlight: boolean;
  math: boolean;
  anchors: boolean;
  values: Record<string, string>;
  /** Copie d'un bloc de code (texte résolu) ; `button` reçoit `data-copied`. */
  onCopy(text: string, button: HTMLElement): void;
  /** Demande le chargement d'une grammaire Prism. */
  requestLanguage(lang: string): void;
  /** Rappel `ref` qui rend une formule dans l'élément (KaTeX, ou texte brut en attendant). */
  mathRef(expr: string, display: boolean): (el?: Element) => void;
};

type Node = { t: Token; kids: Node[] };

/** Tokens à plat → arbre (ouvrant/fermant regroupés). */
export function toTree(tokens: Token[]): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  for (const t of tokens) {
    const top = stack[stack.length - 1];
    if (t.nesting === 1) {
      const n: Node = { t, kids: [] };
      top.push(n);
      stack.push(n.kids);
    } else if (t.nesting === -1) {
      if (stack.length > 1) stack.pop();
    } else top.push({ t, kids: [] });
  }
  return root;
}

const TASK_RE = /^\[([ xX])\][ \t]/;

function clampLevel(tag: string, offset: number): number {
  return Math.max(1, Math.min(6, Number(tag.slice(1)) + offset));
}

function heading(level: number, id: string, content: unknown, ctx: RenderCtx): TemplateResult {
  const a = ctx.anchors && id ? html`<a class="anchor" href="#${id}" aria-label="Lien vers cette section"></a>` : nothing;
  switch (level) {
    case 1: return html`<h1 id=${id} part="heading h1">${content}${a}</h1>`;
    case 2: return html`<h2 id=${id} part="heading h2">${content}${a}</h2>`;
    case 3: return html`<h3 id=${id} part="heading h3">${content}${a}</h3>`;
    case 4: return html`<h4 id=${id} part="heading h4">${content}${a}</h4>`;
    case 5: return html`<h5 id=${id} part="heading h5">${content}${a}</h5>`;
    default: return html`<h6 id=${id} part="heading h6">${content}${a}</h6>`;
  }
}

function align(t: Token): string | typeof nothing {
  const m = /text-align:\s*(left|right|center)/.exec(String(t.attrGet("style") ?? ""));
  return m ? `text-align:${m[1]}` : nothing;
}

/** Texte avec puces de variables (si activées) et échappements `\{{` restitués. */
export function textWithVars(text: string, ctx: RenderCtx): unknown {
  if (!ctx.vars || !text.includes("{{")) return restoreEscapes(text);
  return splitVars(text).map((p) => {
    if (typeof p === "string") return restoreEscapes(p);
    const v = varValue(p.name, p.default, ctx.values);
    return v === null
      ? html`<span class="var missing" part="var" data-var=${p.name} title="Variable ${p.name} sans valeur">${p.name}</span>`
      : html`<span class="var" part="var" data-var=${p.name} title="Variable ${p.name}">${v}</span>`;
  });
}

function footnoteId(ctx: RenderCtx, meta: { id: number; subId?: number }, kind: "fn" | "fnref"): string {
  const base = `${ctx.idPrefix ? `${ctx.idPrefix}-` : ""}${kind}${meta.id + 1}`;
  return meta.subId ? `${base}-${meta.subId}` : base;
}

function renderInline(nodes: Node[], ctx: RenderCtx): unknown[] {
  return nodes.map((n) => inlineNode(n, ctx));
}

function inlineNode(n: Node, ctx: RenderCtx): unknown {
  const t = n.t;
  const kids = () => renderInline(n.kids, ctx);
  switch (t.type) {
    case "text":
      return textWithVars(t.content, ctx);
    case "text_special":
      return t.content === ESC_OPEN ? "{" : restoreEscapes(t.content);
    case "softbreak":
      return "\n";
    case "hardbreak":
      return html`<br />`;
    case "code_inline":
      return html`<code part="code-inline">${textWithVars(t.content, ctx)}</code>`;
    case "em_open":
      return html`<em>${kids()}</em>`;
    case "strong_open":
      return html`<strong>${kids()}</strong>`;
    case "s_open":
      return html`<s>${kids()}</s>`;
    case "link_open": {
      const href = safeUrl(String(t.attrGet("href") ?? ""), "link");
      if (!href) return kids();
      const title = t.attrGet("title");
      const external = /^(https?|mailto):/i.test(href);
      return external
        ? html`<a href=${href} title=${title ?? nothing} target=${ctx.linkTarget} rel="noopener noreferrer">${kids()}</a>`
        : html`<a href=${href} title=${title ?? nothing}>${kids()}</a>`;
    }
    case "image": {
      const alt = inlineText(t);
      const src = safeUrl(String(t.attrGet("src") ?? ""), "image");
      if (!src) return alt ? `[${alt}]` : nothing;
      const title = t.attrGet("title");
      return html`<img src=${src} alt=${alt} title=${title ?? nothing} loading="lazy" decoding="async" referrerpolicy="no-referrer" part="image" />`;
    }
    case "math_inline":
      return ctx.math ? html`<span class="math" part="math" ${ref(ctx.mathRef(t.content, false))}></span>` : `$${t.content}$`;
    case "footnote_ref": {
      const meta = t.meta as { id: number; subId: number };
      return html`<sup class="footnote-ref"><a href="#${footnoteId(ctx, { id: meta.id }, "fn")}" id=${footnoteId(ctx, meta, "fnref")}>[${meta.id + 1}]</a></sup>`;
    }
    default:
      return n.kids.length ? kids() : t.content ? restoreEscapes(t.content) : nothing;
  }
}

function renderPrism(stream: PrismToken["content"]): unknown {
  if (typeof stream === "string") return stream;
  if (Array.isArray(stream)) return stream.map((s) => renderPrism(s));
  const alias = stream.alias ? (Array.isArray(stream.alias) ? stream.alias : [stream.alias]) : [];
  const cls = ["token", stream.type, ...alias].map((c) => c.replace(/[^\w-]/g, "")).join(" ");
  return html`<span class=${cls}>${renderPrism(stream.content)}</span>`;
}

function codeBlock(t: Token, ctx: RenderCtx): TemplateResult {
  const info = restoreEscapes(t.info ?? "").trim();
  const lang = info.split(/\s+/)[0] || "";
  const code = t.content.replace(/\n$/, "");
  const hasVars = ctx.vars && new RegExp(VAR_RE.source).test(code);
  let body: unknown = restoreEscapes(code);
  if (hasVars) body = textWithVars(code, ctx);
  else if (ctx.highlight && lang) {
    const grammar = prismLanguage(lang);
    if (grammar) {
      const tokens = prismTokenize(restoreEscapes(code), grammar);
      if (tokens) body = renderPrism(tokens);
      else ctx.requestLanguage(grammar);
    }
  }
  const langClass = lang ? `language-${lang.replace(/[^\w+-]/g, "")}` : "";
  const copy = ctx.copy
    ? html`<button type="button" class="copy" part="copy-button" aria-label="Copier le code"
        @click=${(e: Event) => ctx.onCopy(resolveVars(code, ctx.values, ctx.vars), e.currentTarget as HTMLElement)}>
        <span class="l-copy">Copier</span><span class="l-done">Copié</span></button>`
    : nothing;
  return html`<div class="code" part="code">${lang || ctx.copy ? html`<div class="code-head"><span class="lang">${lang}</span>${copy}</div>` : nothing}<pre><code class=${langClass}>${body}</code></pre></div>`;
}

function listItem(n: Node, ctx: RenderCtx): TemplateResult {
  const first = n.kids[0];
  const inline = first?.t.type === "paragraph_open" ? first.kids[0] : undefined;
  const firstText = inline?.t.type === "inline" ? inline.t.children?.[0] : undefined;
  const m = firstText && firstText.type === "text" ? TASK_RE.exec(firstText.content) : null;
  if (!m || !inline || !firstText) return html`<li>${renderBlocks(n.kids, ctx)}</li>`;
  const checked = m[1] !== " ";
  const rest = renderBlocks(n.kids.slice(1), ctx);
  const children = inline.t.children ?? [];
  const stripped = [{ ...firstText, content: firstText.content.slice(m[0].length) } as Token, ...children.slice(1)];
  const label = renderInline(toTree(stripped), ctx);
  return html`<li class="task"><label><input type="checkbox" disabled .checked=${checked} /> <span>${label}</span></label>${rest}</li>`;
}

function blockNode(n: Node, ctx: RenderCtx): unknown {
  const t = n.t;
  const kids = () => renderBlocks(n.kids, ctx);
  switch (t.type) {
    case "paragraph_open":
      return t.hidden ? kids() : html`<p>${kids()}</p>`;
    case "inline":
      return renderInline(toTree(t.children ?? []), ctx);
    case "heading_open":
      return heading(clampLevel(t.tag, ctx.headingOffset), String((t.meta as { slug?: string } | null)?.slug ?? ""), kids(), ctx);
    case "blockquote_open":
      return html`<blockquote part="blockquote">${kids()}</blockquote>`;
    case "bullet_list_open":
      return html`<ul class=${n.kids.some((k) => k.t.type === "list_item_open" && isTask(k)) ? "tasks" : ""}>${kids()}</ul>`;
    case "ordered_list_open": {
      const start = Number(t.attrGet("start") ?? 1);
      return html`<ol start=${Number.isFinite(start) && start !== 1 ? start : nothing}>${kids()}</ol>`;
    }
    case "list_item_open":
      return listItem(n, ctx);
    case "table_open":
      return html`<div class="table" part="table"><table>${kids()}</table></div>`;
    case "thead_open":
      return html`<thead>${kids()}</thead>`;
    case "tbody_open":
      return html`<tbody>${kids()}</tbody>`;
    case "tr_open":
      return html`<tr>${kids()}</tr>`;
    case "th_open":
      return html`<th scope="col" style=${align(t)}>${kids()}</th>`;
    case "td_open":
      return html`<td style=${align(t)}>${kids()}</td>`;
    case "hr":
      return html`<hr />`;
    case "fence":
    case "code_block":
      return codeBlock(t, ctx);
    case "math_block":
      return ctx.math ? html`<div class="math-block" part="math" ${ref(ctx.mathRef(t.content, true))}></div>` : html`<p>$$${t.content}$$</p>`;
    case "footnote_block_open":
      return html`<section class="footnotes" role="doc-endnotes" part="footnotes"><hr /><ol>${kids()}</ol></section>`;
    case "footnote_open":
      return html`<li id=${footnoteId(ctx, t.meta as { id: number }, "fn")}>${kids()}</li>`;
    case "footnote_anchor": {
      const meta = t.meta as { id: number; subId: number };
      return html` <a href="#${footnoteId(ctx, meta, "fnref")}" class="footnote-backref" aria-label="Retour au texte">↩︎</a>`;
    }
    default:
      return n.kids.length ? kids() : t.content ? html`<p>${restoreEscapes(t.content)}</p>` : nothing;
  }
}

function isTask(n: Node): boolean {
  const first = n.kids[0];
  const inline = first?.t.type === "paragraph_open" ? first.kids[0] : undefined;
  const ft = inline?.t.children?.[0];
  return !!ft && ft.type === "text" && TASK_RE.test(ft.content);
}

export function renderBlocks(nodes: Node[], ctx: RenderCtx): unknown[] {
  return nodes.map((n) => blockNode(n, ctx));
}

/** Rendu d'un bloc de premier niveau (liste de tokens à plat). */
export function renderTokens(tokens: Token[], ctx: RenderCtx): unknown[] {
  return renderBlocks(toTree(tokens), ctx);
}
