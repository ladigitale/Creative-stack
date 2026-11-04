/**
 * Agrège les bibliothèques de ressources de base des addons
 * (src/addons/<id>/library/library.json + fichiers référencés) en dist/library.json.
 *
 * Consommé par Tadaaa (synchro comme catalog.json) pour proposer ces ressources en lecture
 * seule (badge « base ») dans la bibliothèque, avec détection des mises à jour :
 * une ressource copiée dans un artefact garde `id` + `version` (+ `sha256` du contenu).
 *
 *   LIBRARY_OUT=chemin   sortie (défaut dist/library.json)
 *
 * Format d'une entrée de library.json : { id, kind, file, version, license, title, description,
 * tags[], channels[], params[] } — `kind` parmi KINDS. Sortie : id préfixé par l'addon
 * (`shader/plasma`), `source` = contenu texte du fichier, `sha256`.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonsDir = path.join(root, "src/addons");
const out = process.env.LIBRARY_OUT ?? path.join(root, "dist/library.json");
const KINDS = new Set(["shader", "model3d", "data", "image", "audio"]);
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const errors = [];
const entries = [];
const ids = new Set();

for (const dir of readdirSync(addonsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const base = path.join(addonsDir, dir.name, "library");
  const index = path.join(base, "library.json");
  if (!existsSync(index)) continue;
  const lib = JSON.parse(readFileSync(index, "utf8"));
  if (lib.schema !== "shader-library/1" && lib.schema !== "library/1") errors.push(`${dir.name} : schema inconnu "${lib.schema}"`);
  for (const e of lib.entries ?? []) {
    const where = `${dir.name}/${e.id ?? "?"}`;
    if (!/^[a-z0-9-]+$/.test(e.id ?? "")) errors.push(`${where} : id invalide`);
    if (!KINDS.has(e.kind)) errors.push(`${where} : kind "${e.kind}" inconnu`);
    if (!Number.isInteger(e.version) || e.version < 1) errors.push(`${where} : version entière ≥ 1 requise`);
    for (const k of ["title", "description", "license", "file"]) if (!e[k] || typeof e[k] !== "string") errors.push(`${where} : ${k} manquant`);
    if (!Array.isArray(e.tags) || !e.tags.length) errors.push(`${where} : tags manquants`);
    const full = e.id ? `${dir.name}/${e.id}` : where;
    if (ids.has(full)) errors.push(`${full} : doublon`);
    ids.add(full);
    const file = path.join(base, e.file ?? "");
    if (!e.file || !existsSync(file)) {
      errors.push(`${where} : fichier ${e.file} introuvable`);
      continue;
    }
    const source = readFileSync(file, "utf8");
    const { file: _file, ...rest } = e;
    entries.push({ ...rest, id: full, addon: dir.name, sha256: createHash("sha256").update(source).digest("hex"), source });
  }
}

if (errors.length) {
  console.error("❌ library :\n - " + errors.join("\n - "));
  process.exit(1);
}
entries.sort((a, b) => a.id.localeCompare(b.id));
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ schema: "library/1", creativeStackVersion: pkg.version, entries }, null, 2) + "\n");
console.log(`📚 library.json : ${entries.length} ressource(s) (${[...new Set(entries.map((e) => e.kind))].join(", ")})`);
