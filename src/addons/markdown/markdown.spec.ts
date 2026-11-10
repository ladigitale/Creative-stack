import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { dp, set } from "@supersoniks/concorde/core/utils/PublisherProxy";
import {
  MarkdownDoc, extract, extractVars, parseFeatures, protectEscapes, resolveVars, safeUrl, slugify, splitFrontmatter,
  type Feature,
} from "./parse";
import { SonicMarkdown, readMarkdownParams, readSource, type MarkdownState } from "./markdown";
import { setKatex, setPrism, type PrismGlobal } from "./engines";

void SonicMarkdown;

const GFM: Feature[] = ["gfm", "copy", "anchors"];

async function mount(attrs: Record<string, string>, content = ""): Promise<SonicMarkdown> {
  const el = document.createElement("sonic-markdown") as SonicMarkdown;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (content) el.textContent = content;
  document.body.appendChild(el);
  await el.updateComplete;
  el.flush();
  await el.updateComplete;
  return el;
}

const root = (el: SonicMarkdown) => el.shadowRoot!.querySelector(".root") as HTMLElement;
/** HTML rendu sans les marqueurs Lit (comparaison de DOM). */
const clean = (el: SonicMarkdown) => root(el).innerHTML.replace(/<!--[^>]*-->/g, "");

afterEach(() => {
  document.body.replaceChildren();
  setPrism(null);
  setKatex(null);
  vi.restoreAllMocks();
});

describe("sécurité des sources", () => {
  it("aucun innerHTML, unsafeHTML, eval ni new Function dans l'addon", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".spec.ts"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|unsafeHTML|unsafeSVG|unsafeStatic|\beval\s*\(|new Function\s*\(/);
    }
  });

  it("URL filtrées", () => {
    expect(safeUrl("https://a.b/c", "link")).toBe("https://a.b/c");
    expect(safeUrl("mailto:x@y.z", "link")).toBe("mailto:x@y.z");
    expect(safeUrl("#titre", "link")).toBe("#titre");
    expect(safeUrl("docs/page.md", "link")).toBe("docs/page.md");
    expect(safeUrl("javascript:alert(1)", "link")).toBeNull();
    expect(safeUrl("JaVaScRiPt:alert(1)", "link")).toBeNull();
    expect(safeUrl("java\nscript:alert(1)", "link")).toBeNull();
    expect(safeUrl("data:text/html,<b>", "link")).toBeNull();
    expect(safeUrl("//evil.example", "link")).toBeNull();
    expect(safeUrl("data:image/png;base64,AAA", "image")).toBe("data:image/png;base64,AAA");
    expect(safeUrl("data:image/svg+xml,<svg>", "image")).toBeNull();
    expect(safeUrl("http://a.b/i.png", "image")).toBeNull();
    expect(safeUrl("blob:https://a.b/x", "image")).toBe("blob:https://a.b/x");
  });

  it("HTML et schémas dangereux rendus inertes", async () => {
    const md = [
      "<script>alert(1)</script>",
      "",
      "<img src=x onerror=alert(1)>",
      "",
      "[clic](javascript:alert(1)) [data](data:text/html,<b>x</b>)",
      "",
      "![x](data:text/html,<b>x</b>) ![svg](data:image/svg+xml,<svg onload=alert(1)>)",
      "",
      "<a href=\"javascript:alert(1)\">a</a>",
    ].join("\n");
    const el = await mount({ text: md });
    const r = root(el);
    expect(r.querySelector("script")).toBeNull();
    expect(r.querySelector("img")).toBeNull();
    expect([...r.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([]);
    expect(r.textContent).toContain("<script>alert(1)</script>");
    expect(r.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(r.textContent).toContain("clic");
    expect(r.querySelectorAll("[onerror],[onload],[onclick]").length).toBe(0);
  });
});

describe("analyse", () => {
  it("features", () => {
    expect(parseFeatures("gfm copy  vars,math")).toEqual({ features: ["gfm", "copy", "vars", "math"], unknown: [] });
    expect(parseFeatures("gfm magie").unknown).toEqual(["magie"]);
  });

  it("frontmatter YAML simple", () => {
    const { frontmatter, body } = splitFrontmatter("---\ntitle: \"Mon prompt\"\ntags: [a, b]\nmodel: opus\nn: 3\nlist:\n  - x\n  - 'y'\n__proto__: bad\n---\n# Corps\n");
    expect(frontmatter).toEqual({ title: "Mon prompt", tags: ["a", "b"], model: "opus", n: 3, list: ["x", "y"] });
    expect(body).toBe("# Corps\n");
    expect(splitFrontmatter("pas de frontmatter").frontmatter).toBeNull();
  });

  it("slugs", () => {
    expect(slugify("Été à Paris !")).toBe("ete-a-paris");
    expect(slugify("???")).toBe("section");
  });

  it("variables : défauts, valeurs, échappement", () => {
    const src = protectEscapes("Réponds en {{langue}}, ton {{ton|neutre}}. {{langue}} encore. \\{{pas_une_var}} {{x}}");
    const vars = extractVars(src, { langue: "français" });
    expect(vars).toEqual([
      { name: "langue", default: null, value: "français", filled: true },
      { name: "ton", default: "neutre", value: null, filled: false },
      { name: "x", default: null, value: null, filled: false },
    ]);
    expect(resolveVars(src, { langue: "français" }, true)).toBe("Réponds en français, ton neutre. français encore. {{pas_une_var}} {{x}}");
    expect(resolveVars(src, {}, false)).toBe("Réponds en {{langue}}, ton {{ton|neutre}}. {{langue}} encore. {{pas_une_var}} {{x}}");
  });

  it("params et source", () => {
    expect(readMarkdownParams({ features: "gfm vars", headingOffset: 9, linkTarget: "_self", streaming: true })).toEqual({
      settings: { features: ["gfm", "vars"], headingOffset: 5, linkTarget: "_self", streaming: true }, invalid: [],
    });
    expect(readMarkdownParams({ features: "gfm nope", linkTarget: "top", streaming: "oui" }).invalid).toEqual(["features", "linkTarget", "streaming"]);
    expect(readSource("abc")).toEqual({ text: "abc", done: null });
    expect(readSource({ text: "abc", done: true })).toEqual({ text: "abc", done: true });
    expect(readSource({ nope: 1 })).toBeNull();
  });
});

const CORPUS = `# Titre principal

Un paragraphe avec **gras**, *italique*, ~~barré~~, \`code\` et un [lien](https://example.com "Exemple").
Ligne suivante (saut doux).

## Listes

- un
- deux
    - imbriqué
- [x] fait
- [ ] à faire

1. premier
2. second

3) troisième

> Citation
> sur deux lignes

| Gauche | Centre | Droite |
| :----- | :----: | -----: |
| a      | b      | c      |

\`\`\`ts
const x: number = 1;
\`\`\`

    code indenté

---

Note[^1] et lien https://auto.example.org.

[^1]: Le texte de la note.

## Listes
`;

describe("rendu GFM", () => {
  it("structure de référence", async () => {
    const el = await mount({ text: CORPUS, id: "doc" });
    const r = root(el);
    expect(r.querySelector("h1")!.id).toBe("doc-titre-principal");
    expect([...r.querySelectorAll("h2")].map((h) => h.id)).toEqual(["doc-listes", "doc-listes-2"]);
    expect(r.querySelector("strong")!.textContent).toBe("gras");
    expect(r.querySelector("em")!.textContent).toBe("italique");
    expect(r.querySelector("s")!.textContent).toBe("barré");
    const link = r.querySelector('a[href="https://example.com"]')!;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("title")).toBe("Exemple");
    expect(r.querySelector("ul ul li")!.textContent!.trim()).toBe("imbriqué");
    const tasks = [...r.querySelectorAll("li.task input")] as HTMLInputElement[];
    expect(tasks.map((t) => t.checked)).toEqual([true, false]);
    expect(tasks.every((t) => t.disabled)).toBe(true);
    expect(r.querySelector("li.task")!.textContent!.trim()).toBe("fait");
    expect(r.querySelectorAll("ol").length).toBeGreaterThanOrEqual(2);
    expect(r.querySelector("ol[start='3']")).not.toBeNull();
    expect(r.querySelector("blockquote")!.textContent).toContain("Citation");
    const ths = [...r.querySelectorAll("th")];
    expect(ths.map((t) => t.getAttribute("style"))).toEqual(["text-align:left", "text-align:center", "text-align:right"]);
    expect(ths[0].getAttribute("scope")).toBe("col");
    expect(r.querySelector("code.language-ts")!.textContent).toBe("const x: number = 1;");
    expect([...r.querySelectorAll("pre code")].map((c) => c.textContent)).toContain("code indenté");
    expect(r.querySelector("hr")).not.toBeNull();
    expect(r.querySelector('a[href="https://auto.example.org"]')).not.toBeNull();
    expect(r.querySelector("sup.footnote-ref a")!.getAttribute("href")).toBe("#doc-fn1");
    expect(r.querySelector("section.footnotes li")!.id).toBe("doc-fn1");
  });

  it("sortie DataProvider complète", async () => {
    await mount({ text: "---\ntitle: Fiche\ntags: [a]\n---\n" + CORPUS + "\nRéponds en {{langue}} {{ton|neutre}}.\n", features: "gfm vars", vars: "md1.vars", "out-data-provider": "md1.out" });
    const out = dp("md1.out").get() as MarkdownState;
    expect(out.status).toBe("ready");
    expect(out.source).toBe("text");
    expect(out.title).toBe("Fiche");
    expect(out.frontmatter).toEqual({ title: "Fiche", tags: ["a"] });
    expect(out.toc.map((t) => [t.level, t.id])).toEqual([[1, "titre-principal"], [2, "listes"], [2, "listes-2"]]);
    expect(out.code).toEqual([
      { index: 0, lang: "ts", info: "ts", text: "const x: number = 1;", lines: 1 },
      { index: 1, lang: null, info: "", text: "code indenté", lines: 1 },
    ]);
    expect(out.links.map((l) => l.href)).toContain("https://example.com");
    expect(out.vars.map((v) => v.name)).toEqual(["langue", "ton"]);
    expect(out.missingVars).toEqual(["langue"]);
    expect(out.stats.words).toBeGreaterThan(40);
    expect(out.settings.features).toEqual(["gfm", "vars"]);
    set("md1.vars", { langue: "breton" });
    await vi.waitFor(() => expect((dp("md1.out").get() as MarkdownState).missingVars).toEqual([]));
    expect((dp("md1.out").get() as MarkdownState).resolved).toContain("Réponds en breton neutre.");
  });

  it("puces de variables et code", async () => {
    set("md2.vars", { nom: "Ada" });
    const el = await mount({ text: "Bonjour {{nom}} et {{autre}}.\n\n```\nsalut {{nom}}\n```", features: "gfm vars copy", vars: "md2.vars" });
    await vi.waitFor(() => expect(root(el).querySelector(".var")?.textContent).toBe("Ada"));
    const r = root(el);
    expect(r.querySelector(".var.missing")!.textContent).toBe("autre");
    expect(r.querySelector("pre .var")!.textContent).toBe("Ada");
  });

  it("heading-offset, link-target, features désactivées", async () => {
    const el = await mount({ text: "# A\n\n[l](https://x.y)\n\n```js\nx\n```", "heading-offset": "1", "link-target": "_self", features: "gfm" });
    const r = root(el);
    expect(r.querySelector("h2")).not.toBeNull();
    expect(r.querySelector("h1")).toBeNull();
    expect(r.querySelector("a[href='https://x.y']")!.getAttribute("target")).toBe("_self");
    expect(r.querySelector("button.copy")).toBeNull();
    expect(r.querySelector(".anchor")).toBeNull();
  });

  it("contenu de l'élément, désindenté", async () => {
    const el = await mount({}, "\n      # Titre\n\n      - a\n      - b\n    ");
    expect(root(el).querySelector("h1")!.textContent).toBe("Titre");
    expect(root(el).querySelectorAll("li").length).toBe(2);
  });

  it("plan rendu avec toc", async () => {
    const el = await mount({ text: "# A\n\n## B\n\n## C", features: "gfm toc anchors" });
    expect([...root(el).querySelectorAll("nav.toc a")].map((a) => a.getAttribute("href"))).toEqual(["#a", "#b", "#c"]);
  });

  it("max-length tronque", async () => {
    await mount({ text: "x".repeat(50), "max-length": "10", "out-data-provider": "md3.out" });
    const out = dp("md3.out").get() as MarkdownState;
    expect(out.truncated).toBe(true);
    expect(out.length).toBe(50);
  });

  it("feature inconnue → erreur, rendu conservé", async () => {
    const el = await mount({ text: "ok", features: "gfm magie", "out-data-provider": "md4.out" });
    expect((dp("md4.out").get() as MarkdownState).status).toBe("error");
    expect(root(el).textContent).toContain("ok");
  });
});

describe("streaming", () => {
  const TEXT = CORPUS + "\n\nFin avec $x$ et **gras incomplet";

  it("ajouts caractère par caractère = analyse en une fois (tokens)", () => {
    const inc = new MarkdownDoc();
    for (let i = 1; i <= TEXT.length; i++) inc.update(TEXT.slice(0, i), GFM, true);
    const full = new MarkdownDoc();
    const a = inc.blocks.map((b) => b.tokens.map((t) => `${t.type}:${t.content}`).join("|"));
    const blocksFull = full.update(TEXT, GFM, true);
    const b = blocksFull.map((x) => x.tokens.map((t) => `${t.type}:${t.content}`).join("|"));
    expect(a).toEqual(b);
    expect(inc.fullParses).toBe(1);
    expect(inc.partialParses).toBe(TEXT.length - 1);
  });

  it("DOM final identique, nœuds stables conservés, done finalise", async () => {
    const ref = await mount({ text: TEXT, id: "s" });
    const expected = clean(ref);
    ref.remove();

    set("st.answer", { text: "", done: false });
    const el = await mount({ source: "st.answer", streaming: "", id: "s", "out-data-provider": "st.out" });
    let firstH1: Element | null = null;
    for (let i = 1; i <= TEXT.length; i += 7) {
      set("st.answer", { text: TEXT.slice(0, i), done: false });
      el.flush();
      await el.updateComplete;
      if (!firstH1 && i > 40) firstH1 = root(el).querySelector("h1");
    }
    await vi.waitFor(() => expect((dp("st.out").get() as MarkdownState).status).toBe("streaming"));
    expect(root(el).getAttribute("aria-busy")).toBe("true");
    set("st.answer", { text: TEXT, done: true });
    el.flush();
    await el.updateComplete;
    expect(root(el).querySelector("h1")).toBe(firstH1);
    expect(clean(el)).toBe(expected);
    expect(root(el).querySelector("section.footnotes")).not.toBeNull();
    await vi.waitFor(() => expect((dp("st.out").get() as MarkdownState).status).toBe("ready"));
  });

  it("fence non fermée affichée comme code pendant le flux", () => {
    const doc = new MarkdownDoc();
    const blocks = doc.update("Intro\n\n```py\nprint(1)\n", GFM, true);
    expect(blocks[blocks.length - 1].tokens[0].type).toBe("fence");
  });

  it("remplacement (pas un ajout) → analyse complète", () => {
    const doc = new MarkdownDoc();
    doc.update("# A\n\ntexte", GFM, true);
    doc.update("# B\n\ntexte", GFM, true);
    expect(doc.fullParses).toBe(2);
    const ex = extract(doc.blocks, "", 0);
    expect(ex.toc[0].text).toBe("B");
  });
});

describe("contrôle et copie", () => {
  it("copy copie le Markdown résolu ; scroll-to ; action inconnue", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    set("ct.vars", { a: "1" });
    set("ct.ctl", { n: 0 });
    const el = await mount({ text: "# Haut\n\nValeur {{a}} \\{{b}}", features: "gfm vars", vars: "ct.vars", control: "ct.ctl", "out-data-provider": "ct.out" });
    set("ct.ctl", { n: 1, action: "copy" });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("# Haut\n\nValeur 1 {{b}}"));
    await vi.waitFor(() => expect((dp("ct.out").get() as MarkdownState).lastAction).toEqual({ n: 1, action: "copy", ok: true }));
    const h1 = root(el).querySelector("h1")!;
    const spy = vi.fn();
    (h1 as HTMLElement).scrollIntoView = spy;
    set("ct.ctl", { n: 2, action: "scroll-to", id: "haut" });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    set("ct.ctl", { n: 3, action: "danse" });
    await vi.waitFor(() => expect((dp("ct.out").get() as MarkdownState).lastAction).toMatchObject({ n: 3, ok: false }));
  });

  it("bouton copier d'un bloc de code", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const el = await mount({ text: "```sh\nnpm i\n```" });
    const btn = root(el).querySelector("button.copy") as HTMLButtonElement;
    btn.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("npm i"));
    await vi.waitFor(() => expect(btn.hasAttribute("data-copied")).toBe(true));
  });

  it("params en direct", async () => {
    set("pp.params", { text: "## Direct", headingOffset: 0 });
    const el = await mount({ text: "# Attribut", params: "pp.params" });
    await vi.waitFor(() => expect(root(el).querySelector("h2")?.textContent).toBe("Direct"));
    set("pp.params", {});
    await vi.waitFor(() => expect(root(el).querySelector("h1")?.textContent).toBe("Attribut"));
  });
});

describe("extensions à la demande", () => {
  it("rien n'est chargé sans la feature ni sans bloc concerné", async () => {
    const append = vi.spyOn(document.head, "appendChild");
    await mount({ text: "```js\nx\n```\n\n$x$", features: "gfm" });
    await mount({ text: "texte seul", features: "gfm highlight math" });
    expect(append.mock.calls.filter(([n]) => (n as Element).tagName === "SCRIPT")).toEqual([]);
  });

  it("coloration via Prism (tokens → DOM)", async () => {
    const fake: PrismGlobal = {
      languages: { javascript: {} },
      tokenize: (text: string) => [{ type: "keyword", content: text.slice(0, 5) }, text.slice(5)],
    };
    setPrism(fake);
    const el = await mount({ text: "```js\nconst x = 1\n```", features: "gfm highlight" });
    await vi.waitFor(() => expect(root(el).querySelector("span.token.keyword")?.textContent).toBe("const"));
    expect(root(el).querySelector("code")!.textContent).toBe("const x = 1");
  });

  it("formules via KaTeX (MathML)", async () => {
    const render = vi.fn((expr: string, node: HTMLElement, opts: Record<string, unknown>) => {
      const m = document.createElementNS("http://www.w3.org/1998/Math/MathML", "math");
      m.textContent = expr;
      node.replaceChildren(m);
      expect(opts.output).toBe("mathml");
      expect(opts.trust).toBe(false);
    });
    setKatex({ render });
    const el = await mount({ text: "Inline $a+b$ fin.\n\n$$\nx^2\n$$", features: "gfm math" });
    await vi.waitFor(() => expect(root(el).querySelectorAll("math").length).toBe(2));
    expect(render.mock.calls.map((c) => [c[0], c[2].displayMode])).toEqual([["a+b", false], ["x^2", true]]);
  });

  it("dollars ordinaires non pris pour des formules", () => {
    const doc = new MarkdownDoc();
    const blocks = doc.update("Prix 5$ et 10$ ; $ x $", ["gfm", "math"], false);
    const inline = blocks[0].tokens[1].children!;
    expect(inline.some((t) => t.type === "math_inline")).toBe(false);
  });
});
