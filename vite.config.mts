import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import path from "path";
import { readdirSync, existsSync } from "fs";

const addonsDir = path.resolve(__dirname, "src/addons");

/** Un addon = un dossier `src/addons/<id>` avec `index.ts` + `manifest.json`. */
export const addonIds = readdirSync(addonsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(addonsDir, d.name, "index.ts")))
  .map((d) => d.name);

const toGlobalName = (id: string) =>
  "CreativeStack" + id.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());

const addon = process.env.ADDON;
if (addon && !addonIds.includes(addon)) {
  throw new Error(`Addon inconnu : ${addon} (connus : ${addonIds.join(", ")})`);
}

export default defineConfig({
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toString()),
  },
  build: addon
    ? {
        outDir: "dist",
        emptyOutDir: false,
        lib: {
          entry: path.join(addonsDir, addon, "index.ts"),
          name: toGlobalName(addon),
          formats: ["es", "iife"],
          fileName: (format) =>
            format === "es"
              ? `creative-stack-${addon}.es.js`
              : `creative-stack-${addon}.bundle.js`,
        },
      }
    : undefined,
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    exclude: [...configDefaults.exclude, "scripts/**"],
  },
});
