/**
 * Agrège les manifestes src/addons/<id>/manifest.json en dist/catalog.json,
 * consommé par l'app Artefacts (get_artifact_catalog).
 *
 * Sélection des addons :
 *   CREATIVE_STACK_ADDONS=3d,interactive   liste explicite (inclut les addons désactivés par défaut)
 *   sinon                                  tous les addons enabledByDefault !== false
 *
 * Vérifications : id = nom du dossier, noms de composants uniques,
 * chaque composant déclaré est bien défini dans le code de l'addon, aucune
 * balise ne double une balise de Concorde.
 */
import { fileURLToPath } from "url";
import path from "path";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonsDir = path.join(root, "src/addons");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const errors = [];
const manifests = readdirSync(addonsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const file = path.join(addonsDir, d.name, "manifest.json");
    if (!existsSync(file)) {
      errors.push(`${d.name} : manifest.json manquant`);
      return null;
    }
    const m = JSON.parse(readFileSync(file, "utf8"));
    if (m.id !== d.name) errors.push(`${d.name} : id "${m.id}" ≠ nom du dossier`);
    if (!existsSync(path.join(addonsDir, d.name, "index.ts")))
      errors.push(`${d.name} : index.ts manquant`);
    for (const f of [m.docs, ...(m.examples ?? [])].filter(Boolean)) {
      if (!existsSync(path.join(addonsDir, d.name, f))) errors.push(`${d.name} : fichier ${f} introuvable`);
    }
    const source = readdirSync(path.join(addonsDir, d.name), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
      .map((f) => readFileSync(path.join(addonsDir, d.name, f), "utf8"))
      .join("\n");
    for (const c of m.components ?? []) {
      if (!source.includes(`"${c.name}"`))
        errors.push(`${d.name} : composant ${c.name} déclaré mais introuvable dans le code`);
    }
    return m;
  })
  .filter(Boolean);

const seen = new Map();
for (const m of manifests)
  for (const c of m.components ?? []) {
    if (seen.has(c.name)) errors.push(`${c.name} déclaré par ${seen.get(c.name)} et ${m.id}`);
    seen.set(c.name, m.id);
  }

// Collision avec une balise de Concorde : la sienne gagnerait (définie avant), le composant serait muet.
const concordeBundle = path.join(root, "node_modules/@supersoniks/concorde/dist/concorde-core.es.js");
if (existsSync(concordeBundle)) {
  const concordeTags = new Set(readFileSync(concordeBundle, "utf8").match(/"sonic-[a-z0-9-]+"/g)?.map((t) => t.slice(1, -1)) ?? []);
  for (const [name, id] of seen) if (concordeTags.has(name)) errors.push(`${id} : ${name} est déjà une balise de Concorde`);
}

if (errors.length) {
  console.error("❌ Catalogue invalide :\n  " + errors.join("\n  "));
  process.exit(1);
}

const explicit = process.env.CREATIVE_STACK_ADDONS?.split(",").map((s) => s.trim()).filter(Boolean);
if (explicit) {
  const unknown = explicit.filter((id) => !manifests.some((m) => m.id === id));
  if (unknown.length) {
    console.error(`❌ Addons inconnus : ${unknown.join(", ")}`);
    process.exit(1);
  }
}
const selected = manifests.filter((m) =>
  explicit ? explicit.includes(m.id) : m.enabledByDefault !== false,
);

const catalog = {
  schema: "creative-stack-catalog/1",
  package: pkg.name,
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  addons: selected.map(({ $schema, components, ...m }) => ({
    ...m,
    status: m.status ?? "experimental",
    requires: m.requires ?? [],
    scripts: m.scripts ?? [],
    docs: m.docs ? `src/addons/${m.id}/${m.docs}` : null,
    examples: (m.examples ?? []).map((f) => `src/addons/${m.id}/${f}`),
    bundles: {
      es: `creative-stack-${m.id}.es.js`,
      iife: `creative-stack-${m.id}.bundle.js`,
    },
    components: components.map((c) => c.name),
  })),
  components: selected.flatMap((m) =>
    m.components.map((c) => ({ ...c, addon: m.id })),
  ),
};

mkdirSync(path.join(root, "dist"), { recursive: true });
writeFileSync(path.join(root, "dist/catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
console.log(
  `📚 catalog.json : ${catalog.addons.length} addon(s), ${catalog.components.length} composant(s)` +
    ` [${catalog.addons.map((a) => a.id).join(", ")}]`,
);
