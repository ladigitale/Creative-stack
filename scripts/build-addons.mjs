/**
 * Construit deux bundles par addon dans dist/ :
 *  - creative-stack-<id>.es.js     Concorde, Lit, three… restent des imports (à consommer via un bundler)
 *  - creative-stack-<id>.bundle.js autonome (IIFE), embarque sa propre copie de Concorde
 * Les addons sont découverts depuis src/addons/<id>/index.ts.
 * Usage : node scripts/build-addons.mjs [id ...]
 */
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { readdirSync, existsSync } from "fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonsDir = path.join(root, "src/addons");
const all = readdirSync(addonsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(addonsDir, d.name, "index.ts")))
  .map((d) => d.name);
const wanted = process.argv.slice(2);
const addons = wanted.length ? wanted : all;

for (const addon of addons) {
  for (const format of ["es", "iife"]) {
    console.log(`📦 Addon : ${addon} (${format})`);
    execSync("npx vite build", {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ADDON: addon, FORMAT: format },
    });
  }
}
console.log(`✅ ${addons.length} addon(s) construit(s)`);
