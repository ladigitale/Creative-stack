// Empaquette src/addons/sketch/layer-worker-entry.ts (et le rendu des traits) en un script autonome,
// écrit comme chaîne dans src/addons/sketch/layer-worker-source.ts (Worker lancé depuis un blob:,
// compatible avec la CSP des artefacts, sans dépendre du bundler du projet hôte).
// `--check` : échoue si le fichier committé n'est plus à jour.
import { build } from "esbuild";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}src/addons/sketch/layer-worker-source.ts`;
const res = await build({
  entryPoints: [`${root}src/addons/sketch/layer-worker-entry.ts`],
  bundle: true, write: false, format: "iife", minify: true, target: "es2020", platform: "browser", legalComments: "none",
});
const code = res.outputFiles[0].text.trim();
const file = `// Fichier généré par scripts/build-sketch-worker.mjs — ne pas modifier à la main.\n// Source : layer-worker-entry.ts + render.ts. Régénérer : node scripts/build-sketch-worker.mjs\nexport const LAYER_WORKER_SOURCE = ${JSON.stringify(code)};\n`;
if (process.argv.includes("--check")) {
  const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (cur !== file) { console.error("layer-worker-source.ts n'est pas à jour : node scripts/build-sketch-worker.mjs"); process.exit(1); }
  console.log("layer-worker-source.ts à jour");
} else {
  writeFileSync(out, file);
  console.log(`layer-worker-source.ts : ${code.length} caractères`);
}
