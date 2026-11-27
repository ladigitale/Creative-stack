// Empreinte du code qui construit les maillages procgen (générateurs, géométrie, squelettes) : elle préfixe les clés
// du cache persistant des personnages (IndexedDB), qui se vide de lui-même quand ce code change.
// Écrit src/addons/procgen/gen/character/version.ts. `--check` : échoue si le fichier committé n'est plus à jour.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}src/addons/procgen/gen/character/version.ts`;
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d).sort()) {
    const p = `${d}/${f}`;
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".ts") && !f.endsWith(".spec.ts") && p !== out) files.push(p);
  }
};
for (const d of ["core", "geom", "gen", "rig"]) walk(`${root}src/addons/procgen/${d}`);
for (const f of ["expr", "noise", "rng"]) files.push(`${root}src/shared/${f}.ts`);
const h = createHash("sha1");
for (const p of files) h.update(p.slice(root.length)).update("\0").update(readFileSync(p)).update("\0");
const file = `// Fichier généré par scripts/build-procgen-version.mjs — ne pas modifier à la main.\nexport const PROCGEN_BUILD_VERSION = "${h.digest("hex").slice(0, 16)}";\n`;
if (process.argv.includes("--check")) {
  const cur = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (cur !== file) {
    console.error("gen/character/version.ts n'est pas à jour : node scripts/build-procgen-version.mjs");
    process.exit(1);
  }
  console.log("gen/character/version.ts à jour");
} else {
  writeFileSync(out, file);
  console.log(`gen/character/version.ts : ${file.match(/"(\w+)"/)[1]} (${files.length} fichiers)`);
}
