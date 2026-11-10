/**
 * Extensions chargées à la demande, versions exactes servies par jsDelivr avec empreinte d'intégrité (même motif
 * que l'addon ocr) : Prism (coloration syntaxique, tokens convertis en DOM par Lit, jamais de HTML) et KaTeX
 * (formules, sortie MathML construite en DOM par `katex.render`). Rien n'est chargé tant qu'aucun bloc n'en a besoin.
 */

export const PRISM_VERSION = "1.30.0";
export const KATEX_VERSION = "0.19.1";
const PRISM_BASE = `https://cdn.jsdelivr.net/npm/prismjs@${PRISM_VERSION}/components/prism-`;
export const KATEX_SCRIPT = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.js`;
export const KATEX_SRI = "sha384-a1WQdjRj162i159OYq041X6I4K8NenkrI09LlPmiHg0YOb7CR+wJOraXwK9abpnE";

/** Composants Prism (fichier `prism-<id>.min.js`) : empreinte et dépendances. */
const PRISM: Record<string, { sri: string; requires?: string[] }> = {
  core: { sri: "sha384-zLRFO4dwowZvh8kzutOb5AWhH7f39HeJp+N7PtHF1SQtTBnifRx0AtmvTYs3F4YV" },
  markup: { sri: "sha384-HkMr0bZB9kBW4iVtXn6nd35kO/L/dQtkkUBkL9swzTEDMdIe5ExJChVDSnC79aNA" },
  css: { sri: "sha384-0mV13Neu0xhJFylI+HV43C+XiR13bGSeL7D0/7e6hK7sJgvyvK6HVjeQwmvXTstY" },
  clike: { sri: "sha384-7LHwxHIDSHTBleLmgDWZbC/IMJsfYfFVOihKhvsrxYW4j47YQcRwZja4ToFE3bA8" },
  javascript: { sri: "sha384-D44bgYYKvaiDh4cOGlj1dbSDpSctn2FSUj118HZGmZEShZcO2v//Q5vvhNy206pp", requires: ["clike"] },
  typescript: { sri: "sha384-PeOqKNW/piETaCg8rqKFy+Pm6KEk7e36/5YZE5XO/OaFdO+/Aw3O8qZ9qDPKVUgx", requires: ["javascript"] },
  jsx: { sri: "sha384-nnKpKrv4RkNTjD3hNwkWsmHW8LBti5JWyAWAgeo8iC4QkFQn2Yn2Kj4mOTTNoI9V", requires: ["markup", "javascript"] },
  tsx: { sri: "sha384-ZzE8Y/KUKzSD+AEsQQvM2PdJSEVs/T/6LE/nSetJ0ReWEE/ZgpKNBSUkTRI3Dc7E", requires: ["jsx", "typescript"] },
  json: { sri: "sha384-RhrmFFMb0ZCHImjFMpR/UE3VEtIVTCtNrtKQqXCzqXZNJala02N3UbVhi+qzw3CY" },
  scss: { sri: "sha384-kRWiSF1UhVO7HGkpK3GX+OGmVHxBjCBwRxc9EIP3tqScIgDEAizIeCWds1M6ratq", requires: ["css"] },
  bash: { sri: "sha384-9WmlN8ABpoFSSHvBGGjhvB3E/D8UkNB9HpLJjBQFC2VSQsM1odiQDv4NbEo+7l15" },
  python: { sri: "sha384-WJdEkJKrbsqw0evQ4GB6mlsKe5cGTxBOw4KAEIa52ZLB7DDpliGkwdme/HMa5n1m" },
  "markup-templating": { sri: "sha384-LMCbF6eKAywctm2tlnguxYpyYDf0/Z3ecx60ugk8J/pydfawrC24sn2gumP8MWBN", requires: ["markup"] },
  php: { sri: "sha384-+grZ1BKjM0uVvu5qwWIjfNJct1eZpnnIv7QAo1Qva9uEWA584H7dSk7sZSgwbvT7", requires: ["markup-templating"] },
  sql: { sri: "sha384-/MKWdycCDliku23mP5sYXbZNuXrzgmQO/jsVxwPFn99dVOaXRyKsqDjarqpueGAp" },
  yaml: { sri: "sha384-AKAiycghK0jDCjD+aavMHzDkLzRR7Yzcwh3+xL/295cvyVMe+cxQfyQC8xxGGcI8" },
  markdown: { sri: "sha384-s888ApkYHxfPsp8n81g77Unl/0XYnYltLvWbwqKHcheRE8/dZPlT4IjW3mRGv/Hd", requires: ["markup"] },
  diff: { sri: "sha384-5MjMyjeLq48jKCQkz3wbIdVG8+jWbG3Dlh9oy9LkluQL7zDQghWEa+UYZiYi5qRJ" },
  c: { sri: "sha384-gaD4ncierlmWk42Z3BmTp37/z+Dqt8V4Wf74UjTvFeo+M+SgnEI6Ysd98pWhksQv", requires: ["clike"] },
  cpp: { sri: "sha384-NiOrAquf32LSG3Vuig99LKS03EZPUuM8a51NOp+XXsqx08hUVo3wbNWALY7K/2J8", requires: ["c"] },
  java: { sri: "sha384-DioAMZB4yk91W6LuFit5wJDh8c5Ov09f/MBvja94y0PodMqTpTZeBeejqpRUru7D", requires: ["clike"] },
  rust: { sri: "sha384-JyDgFjMbyrE/TGiEUSXW3CLjQOySrsoiUNAlXTFdIsr/XUfaB7E+eYlR+tGQ9bCO" },
  go: { sri: "sha384-YxCco6ByOY5rJ3jD18514fa8w5so07zigIyV6tZa3CWSE5vYrbDSuFkZ5zOknnZ6", requires: ["clike"] },
  glsl: { sri: "sha384-pVTxhwiBtNI5Ft7QtXG/tusDcSM4EdV8GKzHytqK5M+rMWbpPRCvDGqjoF70fa21", requires: ["c"] },
  csharp: { sri: "sha384-nMKYzg6yfy0qgpaRpVhHvZp0gT5sgvmZYlFC0XAKZSp+zFUB9rE6zsdmIEiou4bV", requires: ["clike"] },
  ini: { sri: "sha384-IzgZExoq7muPnVEjP/MVubbALJ4d+D++YULBQxvKKWLSoXut91gFAg36n+5WAFf6" },
  toml: { sri: "sha384-Uh6n44GRSQeQSMIIfAjlbqojWR7F5KALTHNsspuLDrNCsXpDPRdZbJ5A42AP/cA4" },
  docker: { sri: "sha384-44ggPevoK6FC5kDMdbbWoMCAFkSCwaRoXXtKMkslR2lf8Ra3OSzCRrFIyeK+TQBi" },
};

/** Langage de bloc (`js`, `ts`, `html`…) → grammaire Prism ; `null` si non pris en charge. */
const ALIASES: Record<string, string> = {
  js: "javascript", javascript: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", typescript: "typescript", jsx: "jsx", tsx: "tsx",
  html: "markup", xml: "markup", svg: "markup", markup: "markup", vue: "markup",
  css: "css", scss: "scss", json: "json", jsonc: "json", json5: "json",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash", console: "bash",
  py: "python", python: "python", php: "php", sql: "sql", yaml: "yaml", yml: "yaml",
  md: "markdown", markdown: "markdown", diff: "diff", patch: "diff",
  c: "c", h: "c", cpp: "cpp", "c++": "cpp", hpp: "cpp", java: "java", rust: "rust", rs: "rust", go: "go",
  glsl: "glsl", frag: "glsl", vert: "glsl", wgsl: "glsl", cs: "csharp", csharp: "csharp",
  ini: "ini", toml: "toml", dockerfile: "docker", docker: "docker",
};

export function prismLanguage(lang: string | null | undefined): string | null {
  if (!lang) return null;
  return ALIASES[lang.toLowerCase()] ?? null;
}

export const PRISM_LANGUAGES = Object.keys(ALIASES);

export type PrismToken = { type: string; alias?: string | string[]; content: PrismStream };
export type PrismStream = string | PrismToken | Array<string | PrismToken>;
export type PrismGlobal = { languages: Record<string, unknown>; tokenize(text: string, grammar: unknown): Array<string | PrismToken>; manual?: boolean };
export type KatexGlobal = { render(expr: string, el: HTMLElement, opts: Record<string, unknown>): void };

function loadScript(src: string, integrity: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.integrity = integrity;
    s.crossOrigin = "anonymous";
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
    document.head.appendChild(s);
  });
}

/** Points d'injection pour les tests (moteurs factices). */
let prismOverride: PrismGlobal | null = null;
let katexOverride: KatexGlobal | null = null;
export function setPrism(p: PrismGlobal | null): void { prismOverride = p; prismCore = null; loaded.clear(); }
export function setKatex(k: KatexGlobal | null): void { katexOverride = k; katexPromise = null; }

let prismCore: Promise<PrismGlobal> | null = null;
const loaded = new Map<string, Promise<void>>();

function prismGlobal(): PrismGlobal | undefined {
  return prismOverride ?? (window as unknown as { Prism?: PrismGlobal }).Prism;
}

function loadPrismCore(): Promise<PrismGlobal> {
  if (prismOverride) return Promise.resolve(prismOverride);
  prismCore ??= (async () => {
    const w = window as unknown as { Prism?: Partial<PrismGlobal> };
    // Pas de coloration automatique de la page hôte.
    w.Prism = w.Prism ?? {};
    w.Prism.manual = true;
    if (!(w.Prism as PrismGlobal).tokenize) await loadScript(`${PRISM_BASE}core.min.js`, PRISM.core.sri);
    const p = prismGlobal();
    if (!p?.tokenize) throw new Error("Prism indisponible");
    return p;
  })();
  prismCore.catch(() => { prismCore = null; });
  return prismCore;
}

function loadComponent(id: string): Promise<void> {
  let p = loaded.get(id);
  if (p) return p;
  p = (async () => {
    const prism = await loadPrismCore();
    for (const dep of PRISM[id]?.requires ?? []) await loadComponent(dep);
    if (prism.languages[id]) return;
    const c = PRISM[id];
    if (!c) throw new Error(`Langage inconnu : ${id}`);
    await loadScript(`${PRISM_BASE}${id}.min.js`, c.sri);
  })();
  p.catch(() => loaded.delete(id));
  loaded.set(id, p);
  return p;
}

/** Grammaire prête (synchrone) ou `null` ; ne déclenche aucun chargement. */
export function prismGrammar(lang: string): unknown | null {
  const p = prismGlobal();
  return p?.tokenize ? p.languages[lang] ?? null : null;
}

export function prismTokenize(code: string, lang: string): Array<string | PrismToken> | null {
  const g = prismGrammar(lang);
  const p = prismGlobal();
  return g && p ? p.tokenize(code, g) : null;
}

/** Charge Prism et le langage (et ses dépendances). */
export function ensurePrismLanguage(lang: string): Promise<void> {
  if (prismGrammar(lang)) return Promise.resolve();
  return loadComponent(lang);
}

let katexPromise: Promise<KatexGlobal> | null = null;

export function katexReady(): KatexGlobal | null {
  return katexOverride ?? (window as unknown as { katex?: KatexGlobal }).katex ?? null;
}

export function ensureKatex(): Promise<KatexGlobal> {
  const ready = katexReady();
  if (ready) return Promise.resolve(ready);
  katexPromise ??= loadScript(KATEX_SCRIPT, KATEX_SRI).then(() => {
    const k = katexReady();
    if (!k) throw new Error("KaTeX indisponible");
    return k;
  });
  katexPromise.catch(() => { katexPromise = null; });
  return katexPromise;
}

/** Options KaTeX : MathML seul (aucune feuille de style ni police), pas de commandes de confiance, bornes. */
export const KATEX_OPTIONS = { output: "mathml", throwOnError: false, trust: false, strict: "ignore", maxSize: 50, maxExpand: 500 } as const;
