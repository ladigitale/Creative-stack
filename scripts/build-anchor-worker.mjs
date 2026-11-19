// Empaquette src/addons/anchor/worker-entry.ts (et le moteur d'ancrage) en un script autonome,
// écrit comme chaîne dans src/addons/anchor/worker-source.ts (Worker lancé depuis un blob:,
// compatible avec la CSP des artefacts, sans dépendre du bundler du projet hôte).
// `--check` : échoue si le fichier committé n'est plus à jour.
import { build } from "esbuild";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}src/addons/anchor/worker-source.ts`;
const res = await build({
  entryPoints: [`${root}src/addons/anchor/worker-entry.ts`],
  bundle: true, write: false, format: "iife", minify: true, target: "es2020", platform: "browser", legalComments: "none",
});
const code = res.outputFiles[0].text.trim();
const file = `// Fichier généré par scripts/build-anchor-worker.mjs — ne pas modifier à la main.\n// Source : worker-entry.ts + core/*.ts. Régénérer : node scripts/build-anchor-worker.mjs\nexport const ANCHOR_WORKER_SOURCE = ${JSON.stringify(code)};\n`;
if (process.argv.includes("--check")) {
  const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (cur !== file) { console.error("worker-source.ts n'est pas à jour : node scripts/build-anchor-worker.mjs"); process.exit(1); }
  console.log("worker-source.ts à jour");
} else {
  writeFileSync(out, file);
  console.log(`worker-source.ts : ${code.length} caractères`);
}
