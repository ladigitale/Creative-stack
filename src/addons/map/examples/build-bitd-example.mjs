#!/usr/bin/env node
/**
 * Construit l'exemple SDUI autonome `bitd-gicat.sdui.json` (données incluses dans le document).
 *   node src/addons/map/examples/build-bitd-artifact.mjs   # d'abord : génère tadaaa/*
 *   node src/addons/map/examples/build-bitd-example.mjs
 *
 * Même interface que l'artefact Tadaaa (onglets Carte / Liste, bouton « Détails » → modal, « Voir sur la carte »,
 * icônes) : les vues et le réducteur viennent de `tadaaa/bitd-gicat.artifact.json`, une seule source à maintenir.
 * La différence : les morceaux de données (tadaaa/bitd-0N.json) sont ici inclus en texte dans le store `etat`,
 * là où l'artefact les charge par `fetch` + sha256.
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tdir = path.join(here, "tadaaa");
const doc = JSON.parse(readFileSync(path.join(tdir, "bitd-gicat.artifact.json"), "utf8"));
const parts = readdirSync(tdir).filter((f) => /^bitd-\d+\.json$/.test(f)).sort().map((f) => readFileSync(path.join(tdir, f), "utf8"));
if (!parts.length) throw new Error("Lancez d'abord build-bitd-artifact.mjs");

doc.data.stores.etat.initial.parts = parts;

const out = path.join(here, "bitd-gicat.sdui.json");
writeFileSync(out, JSON.stringify(doc));
console.log(`${parts.length} morceaux -> ${path.relative(process.cwd(), out)} (${Math.round(JSON.stringify(doc).length / 1024)} Ko)`);
