/** Addon markdown : rendu Markdown (GFM) en DOM natif, sans innerHTML, piloté et publié par DataProvider. */
export { SonicMarkdown, readMarkdownParams, readSource, type MarkdownState, type MarkdownSettings } from "./markdown";
export {
  MarkdownDoc, parseFeatures, safeUrl, splitFrontmatter, parseFrontmatterYaml, extractVars, resolveVars, slugify, countWords,
  FEATURES, DEFAULT_FEATURES, type Feature, type Block, type TocEntry, type CodeEntry, type LinkEntry, type VarInfo,
} from "./parse";
export { setPrism, setKatex, prismLanguage, PRISM_VERSION, KATEX_VERSION, PRISM_LANGUAGES } from "./engines";
