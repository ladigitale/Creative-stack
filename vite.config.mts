import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import path from "path";
import { readdirSync, existsSync, mkdirSync, writeFileSync } from "fs";

const addonsDir = path.resolve(__dirname, "src/addons");

/** Un addon = un dossier `src/addons/<id>` avec `index.ts` + `manifest.json`. */
export const addonIds = readdirSync(addonsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(addonsDir, d.name, "index.ts")))
  .map((d) => d.name);

const toGlobalName = (id: string) =>
  "CreativeStack" + id.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());

const addon = process.env.ADDON;
/** `es` : Concorde, Lit et les libs restent des imports (une seule instance côté app). `iife` : autonome. */
const format = (process.env.FORMAT ?? "es") as "es" | "iife";
const external = (id: string) =>
  /^(lit|@lit\/|@supersoniks\/concorde|three|jsonata|@huggingface\/)/.test(id);
if (addon && !addonIds.includes(addon)) {
  throw new Error(`Addon inconnu : ${addon} (connus : ${addonIds.join(", ")})`);
}

/** Concorde est publié en TS source avec décorateurs legacy. */
const tsconfigRaw = {
  compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
};

/** En IIFE, l'entrée (générée) charge d'abord la passerelle vers Concorde core. */
function iifeEntry(id: string): string {
  const dir = path.resolve(__dirname, "node_modules/.creative-stack");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `iife-${id}.ts`);
  writeFileSync(
    file,
    `import ${JSON.stringify(path.resolve(__dirname, "src/shared/iife-bridge.ts"))};\n` +
      `export * from ${JSON.stringify(path.join(addonsDir, id, "index.ts"))};\n`,
  );
  return file;
}

export default defineConfig({
  esbuild: { tsconfigRaw },
  optimizeDeps: { esbuildOptions: { tsconfigRaw } },
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toString()),
  },
  build: addon
    ? {
        outDir: "dist",
        emptyOutDir: false,
        lib: {
          entry: format === "iife" ? iifeEntry(addon) : path.join(addonsDir, addon, "index.ts"),
          name: toGlobalName(addon),
          formats: [format],
          fileName: () =>
            format === "es"
              ? `creative-stack-${addon}.es.js`
              : `creative-stack-${addon}.bundle.js`,
        },
        rollupOptions: format === "es" ? { external } : {},
      }
    : undefined,
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    exclude: [...configDefaults.exclude, "scripts/**"],
  },
});
