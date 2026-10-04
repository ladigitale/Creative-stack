#!/usr/bin/env node
/**
 * Prépare les fichiers à héberger sur le CDN pour `sonic-hugging-face-infer`.
 *
 *   # Moteur figé (Transformers.js + binaires ONNX Runtime de la MÊME version)
 *   node scripts/hf-vendor.mjs runtime --out ./cdn/vendor/hf-transformers
 *     → ./cdn/vendor/hf-transformers/<version>/{transformers.min.js, ort-wasm-simd-threaded*.{mjs,wasm}, manifest.json}
 *
 *   # Un modèle, à une révision figée (réseau vers huggingface.co requis)
 *   node scripts/hf-vendor.mjs model Xenova/paraphrase-multilingual-MiniLM-L12-v2 <sha> --dtype q8 --out ./cdn/models
 *     → ./cdn/models/<repo>/<sha>/…   (à servir avec remotePathTemplate: "{model}/{revision}/")
 *
 * Servir ces dossiers avec `Cache-Control: public, max-age=31536000, immutable`
 * (les chemins contiennent la version / la révision : ils ne changent jamais).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const [, , command, ...rest] = process.argv;

function option(name, fallback) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Dossier d'un paquet installé (sans passer par ses `exports`). */
function packageDir(name, from = process.cwd()) {
  const candidates = require.resolve.paths(name) ?? [];
  for (const dir of [path.join(from, "node_modules"), ...candidates]) {
    if (existsSync(path.join(dir, name, "package.json"))) return path.join(dir, name);
  }
  throw new Error(`Paquet introuvable : ${name} (npm i -D ${name}).`);
}

function runtime() {
  const out = path.resolve(option("out", "./cdn/vendor/hf-transformers"));
  const tfDir = packageDir("@huggingface/transformers");
  const tf = JSON.parse(readFileSync(path.join(tfDir, "package.json"), "utf8"));
  // onnxruntime-web imbriqué sous Transformers.js s'il existe, sinon à la racine.
  const nested = path.join(tfDir, "node_modules/onnxruntime-web");
  const ortDir = existsSync(path.join(nested, "package.json"))
    ? nested
    : packageDir("onnxruntime-web");
  const ort = JSON.parse(readFileSync(path.join(ortDir, "package.json"), "utf8"));
  if (ort.version !== tf.dependencies["onnxruntime-web"]) {
    console.error(
      `onnxruntime-web ${ort.version} ≠ version attendue par Transformers.js (${tf.dependencies["onnxruntime-web"]}).`,
    );
    process.exit(1);
  }
  const target = path.join(out, tf.version);
  mkdirSync(target, { recursive: true });
  const files = [
    [path.join(tfDir, "dist/transformers.min.js"), "transformers.min.js"],
    // Build WebGPU (asyncify), utilisé partout sauf Safari < 26 sans WebGPU.
    [path.join(ortDir, "dist/ort-wasm-simd-threaded.asyncify.mjs"), "ort-wasm-simd-threaded.asyncify.mjs"],
    [path.join(ortDir, "dist/ort-wasm-simd-threaded.asyncify.wasm"), "ort-wasm-simd-threaded.asyncify.wasm"],
    [path.join(ortDir, "dist/ort-wasm-simd-threaded.mjs"), "ort-wasm-simd-threaded.mjs"],
    [path.join(ortDir, "dist/ort-wasm-simd-threaded.wasm"), "ort-wasm-simd-threaded.wasm"],
  ];
  const manifest = {
    transformers: tf.version,
    "onnxruntime-web": ort.version,
    generatedAt: new Date().toISOString(),
    files: {},
  };
  for (const [from, name] of files) {
    copyFileSync(from, path.join(target, name));
    manifest.files[name] = sha256(from);
  }
  writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`✅ Moteur ${tf.version} (onnxruntime-web ${ort.version}) → ${target}`);
  console.log(`   runtime: { source: "cdn", version: "${tf.version}", url: "<cdn>/${tf.version}/transformers.min.js" }`);
}

const DTYPE_SUFFIX = {
  fp32: "",
  fp16: "_fp16",
  q8: "_quantized",
  int8: "_int8",
  uint8: "_uint8",
  q4: "_q4",
  q4f16: "_q4f16",
  bnb4: "_bnb4",
};

async function model() {
  const [repo, revision] = rest;
  if (!repo || !revision || repo.startsWith("--") || revision.startsWith("--")) {
    console.error("Usage : node scripts/hf-vendor.mjs model <repo> <révision (sha)> [--dtype q8] [--out ./cdn/models]");
    process.exit(1);
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    console.warn(`⚠️  « ${revision} » n'est pas un sha de commit : la révision peut bouger.`);
  }
  const dtype = option("dtype", "q8");
  const suffix = DTYPE_SUFFIX[dtype];
  if (suffix === undefined) {
    console.error(`dtype inconnu : ${dtype} (${Object.keys(DTYPE_SUFFIX).join(", ")})`);
    process.exit(1);
  }
  const hub = option("hub", "https://huggingface.co");
  const out = path.resolve(option("out", "./cdn/models"), repo, revision);
  const info = await fetch(`${hub}/api/models/${repo}/revision/${revision}`).then((r) => {
    if (!r.ok) throw new Error(`API Hub ${r.status}`);
    return r.json();
  });
  const names = info.siblings.map((s) => s.rfilename);
  const wanted = names.filter(
    (f) =>
      /^(config|generation_config|preprocessor_config|tokenizer|tokenizer_config|special_tokens_map|vocab|merges|sentencepiece\.bpe|source|target)\.(json|txt|model)$/.test(f) ||
      new RegExp(`^onnx/[a-z_]*model${suffix}\\.onnx(_data(_\\d+)?)?$`).test(f),
  );
  if (!wanted.some((f) => f.endsWith(".onnx"))) {
    console.error(`Aucun fichier ONNX « *${suffix}.onnx » pour ${repo}@${revision}.`);
    process.exit(1);
  }
  const manifest = { repo, revision, dtype, license: info.cardData?.license ?? null, files: {} };
  let total = 0;
  for (const file of wanted) {
    const dest = path.join(out, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    if (!existsSync(dest)) {
      const res = await fetch(`${hub}/${repo}/resolve/${revision}/${file}`);
      if (!res.ok) throw new Error(`${file} : ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    }
    const size = readFileSync(dest).length;
    total += size;
    manifest.files[file] = { size, sha256: sha256(dest) };
    console.log(`   ${file} (${(size / 1048576).toFixed(1)} Mo)`);
  }
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`✅ ${repo}@${revision} (${dtype}) → ${out} — ${(total / 1048576).toFixed(1)} Mo`);
  console.log(`   Licence : ${manifest.license ?? "à vérifier"} — sizeBytes: ${total}`);
}

if (command === "runtime") runtime();
else if (command === "model")
  await model().catch((err) => {
    console.error(`❌ ${err.message}${err.cause ? ` (${err.cause.message ?? err.cause})` : ""}`);
    process.exit(1);
  });
else {
  console.log("Usage : node scripts/hf-vendor.mjs runtime|model …  (voir l'en-tête du script)");
  process.exit(command ? 1 : 0);
}
