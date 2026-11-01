#!/usr/bin/env node
/**
 * Artefact Tadaaa « BITD » en deux parties, pour la mise à jour depuis le dépôt :
 *  - tadaaa/bitd-gicat.artifact.json : document léger (vues, store, calculs), sans les données ;
 *  - tadaaa/bitd-NN.json : données en morceaux de moins de 64 Ko (limite d'un fichier d'artefact).
 * Les morceaux sont chargés par Tadaaa depuis raw.githubusercontent.com (update_artifact, `fetch`),
 * référencés par "@file:bitd-NN.json" dans data.stores.etat.initial.parts, puis relus par
 * sonic-jsonata ($eval de chaque morceau : évaluateur JSONata, pas d'eval JavaScript).
 *
 *   node src/addons/map/examples/build-bitd-artifact.mjs
 * Sortie : la liste des fichiers avec leur sha256 (à passer à `fetch`).
 */
import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "tadaaa");
mkdirSync(outDir, { recursive: true });
const src = JSON.parse(readFileSync(path.join(here, "data/bitd-gicat.json"), "utf8"));
const CHUNK = 60 * 1024;
const MAX_ROWS = 150;

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const rows = src.entreprises.map((e) => {
  const dm = e.domaines.join(" · ");
  const adresse = [e.adresse, `${e.cp} ${e.ville}`, "France"].filter(Boolean).join(", ");
  return {
    i: e.i, n: e.nom, v: e.ville, c: e.cp, d: e.dep, dn: e.depNom, rg: e.region,
    a: e.adresse, t: e.tel, w: e.site, f: e.effectif ? `${e.effectif.toLocaleString("fr-FR")} personnes` : "",
    dm, lat: e.lat, lon: e.lon,
    mq: e.lat !== null ? `${e.lat},${e.lon}` : encodeURIComponent(adresse),
    s: strip([e.nom, e.ville, e.cp, e.depNom, e.region, dm].join(" ")),
  };
});

// Morceaux : tableaux JSON, chacun < 60 Ko en UTF-8.
const parts = [];
let cur = [];
for (const r of rows) {
  const next = JSON.stringify([...cur, r]);
  if (Buffer.byteLength(next) > CHUNK && cur.length) {
    parts.push(cur);
    cur = [r];
  } else cur.push(r);
}
if (cur.length) parts.push(cur);
const files = parts.map((p, k) => {
  const name = `bitd-${String(k + 1).padStart(2, "0")}.json`;
  const text = JSON.stringify(p);
  writeFileSync(path.join(outDir, name), text);
  return { name, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
});

const regions = [...new Set(rows.map((e) => e.rg).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));

// Sélection, fermeture et recadrage : le store ne garde que des identifiants (les données sont dans « bitd »).
const REDUCER = `(
  $t := $action.type; $p := $action.payload; $s := $state.seq + 1;
  $t = 'select' ? $merge([$state, {'sel': $number($type($p) = 'object' ? $p.id : $p), 'detOn': 'true', 'seq': $s}])
  : $t = 'close' ? $merge([$state, {'sel': -1, 'detOn': 'false', 'seq': $s}])
  : $t = 'fit' ? $merge([$state, {'sel': -1, 'detOn': 'false', 'seq': $s}])
  : $state
)`;

// Un seul résultat = un objet en JSONata : $append([], …) garantit un tableau pour sonic-list et sonic-map.
const FILTER = `$qq := $lowercase($trim($string($exists($q) ? $q : '')));
  $rr := $exists($reg) and $reg != null ? $reg : '';
  $isDep := $contains($qq, /^([0-9]{2,3}|2[ab])$/);
  $f := $input[($rr = '' or rg = $rr) and ($qq = '' or ($isDep ? $lowercase(d) = $qq : $contains(s, $qq)))]`;

const jsonata = (input, form, out, expression) => ({
  tagName: "sonic-jsonata",
  attributes: { inputProvider: input, ...(form ? { formDataProvider: form } : {}), outputProvider: out, expression },
});
const text = (tagName, t, attributes) => ({ tagName, textContent: t, ...(attributes ? { attributes } : {}) });
const field = (label, key) => ({
  tagName: "div", attributes: { style: "display:flex;gap:.5rem;font-size:.875rem" },
  nodes: [text("span", label, { style: "opacity:.7;width:7rem;flex-shrink:0" }), { tagName: "sonic-value", attributes: { dataProvider: "fiche", key } }],
});

const doc = {
  schema: "artifacts/1",
  title: "Membres du GICAT par territoire",
  defaultView: "carte",
  page: { padding: "compact" },
  data: {
    stores: {
      etat: { initial: { parts: [], sel: -1, detOn: "false", seq: 0 }, reducer: REDUCER },
      fond: { initial: { style: "https://tiles.openfreemap.org/styles/positron" }, reducer: "$state" },
    },
  },
  views: [{
    id: "carte", title: "Carte",
    root: { nodes: [{
      tagName: "div", attributes: { style: "display:grid;gap:1rem" },
      nodes: [
        // Données : morceaux JSON (fichiers de l'artefact) → un tableau
        jsonata("etat", null, "bitd", "$reduce($input.parts, function($a, $p) { $append($a, $eval($p)) }, [])"),
        jsonata("bitd", "filtres", "liste", `( ${FILTER}; $append([], $f[[0..${MAX_ROWS - 1}]]) )`),
        jsonata("bitd", "filtres", "pts", `( ${FILTER}; {'data': $append([], $f[lat != null].{'id': i, 'lat': lat, 'lon': lon, 'label': n})} )`),
        jsonata("bitd", "filtres", "compte", `( ${FILTER}; $n := $count($f); {'txt': $string($n) & ' entreprise' & ($n > 1 ? 's' : '') & ($n > ${MAX_ROWS} ? ' (${MAX_ROWS} premières listées)' : '') & ' · ' & $string($count($f[lat != null])) & ' sur la carte'} )`),
        jsonata("bitd", "etat", "fiche", "( $e := $input[i = $sel]; $exists($e) ? $e : {} )"),
        jsonata("bitd", "etat", "vue", "( $e := $input[i = $sel]; $exists($e) and $e.lat != null ? {'center': [$e.lon, $e.lat], 'zoom': 10, 'mode': 'fly', 'duration': 800, 'seq': $seq, 'selectedId': $sel} : {'fit': 'points', 'mode': 'ease', 'duration': 600, 'seq': $seq, 'selectedId': null} )"),
        text("h1", "Membres du GICAT par territoire", { style: "font-size:1.5rem;font-weight:600;margin:0" }),
        text("p", `Annuaire GICAT 2026, informations déclarées par les sociétés. Position = centre de la commune (${src.meta.sansCoordonnees} entreprises sans position). Une adhésion au GICAT ne suffit pas à classer une entreprise dans la BITD.`, { style: "font-size:.875rem;opacity:.7;margin:0" }),
        {
          tagName: "div", attributes: { style: "display:grid;gap:.5rem;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));align-items:end" },
          nodes: [
            { tagName: "sonic-input", attributes: { name: "q", formDataProvider: "filtres", label: "Recherche", placeholder: "Nom, ville, 37, 2A, drone, cyber…" } },
            { tagName: "sonic-select", attributes: { name: "reg", formDataProvider: "filtres", label: "Région",
              options: JSON.stringify([{ value: "", wording: "Toutes les régions" }, ...regions.map((r) => ({ value: r, wording: r }))]) } },
            { tagName: "sonic-action", attributes: { target: "etat", type: "fit" }, nodes: [{ tagName: "sonic-button", attributes: { type: "default", variant: "outline" }, nodes: [text("span", "Recadrer la carte")] }] },
          ],
        },
        { tagName: "p", attributes: { style: "font-size:.875rem;margin:0" }, nodes: [{ tagName: "sonic-value", attributes: { dataProvider: "compte", key: "txt" } }] },
        {
          tagName: "div", attributes: { style: "display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));align-items:start" },
          nodes: [
            {
              tagName: "div", attributes: { style: "display:grid;gap:.75rem;align-content:start" },
              nodes: [
                { tagName: "sonic-if", attributes: { dataProvider: "etat", key: "detOn", equals: "true" }, nodes: [{
                  tagName: "sonic-card", nodes: [{
                    tagName: "div", attributes: { style: "display:grid;gap:.5rem;padding:1rem" },
                    nodes: [
                      { tagName: "h2", attributes: { style: "font-size:1.125rem;font-weight:600;margin:0" }, nodes: [{ tagName: "sonic-value", attributes: { dataProvider: "fiche", key: "n" } }] },
                      field("Adresse", "a"), field("Commune", "v"), field("Département", "dn"), field("Région", "rg"),
                      field("Téléphone", "t"), field("Site", "w"), field("Effectif", "f"), field("Domaines", "dm"),
                      { tagName: "sonic-subscriber", attributes: { dataProvider: "fiche" }, nodes: [{
                        tagName: "div", attributes: { style: "display:flex;gap:.75rem;padding-top:.5rem" },
                        nodes: [{ tagName: "a", attributes: { "data-bind": "", "::href": "https://www.google.com/maps/search/?api=1&query=$mq", target: "_blank", rel: "noopener noreferrer", style: "text-decoration:underline" }, textContent: "Ouvrir dans Google Maps" }],
                      }] },
                      { tagName: "sonic-action", attributes: { target: "etat", type: "close" }, nodes: [{ tagName: "sonic-button", attributes: { type: "default", variant: "ghost", size: "sm" }, nodes: [text("span", "Fermer la fiche")] }] },
                    ],
                  }],
                }] },
                {
                  tagName: "div", attributes: { style: "display:grid;gap:.25rem;max-height:60vh;overflow:auto" },
                  nodes: [{
                    tagName: "sonic-list", attributes: { dataProvider: "liste" },
                    nodes: [
                      { tagName: "template", nodes: [{
                        tagName: "sonic-action", attributes: { target: "etat", type: "select", "data-bind": "", "::payload": "$i" },
                        nodes: [{
                          tagName: "div", attributes: { class: "ligne", style: "display:grid;cursor:pointer;border-radius:6px;padding:.4rem .75rem;border-bottom:1px solid var(--sc-base-200, #e5e5e5)" },
                          nodes: [
                            { tagName: "strong", nodes: [{ tagName: "sonic-value", attributes: { key: "n" } }] },
                            { tagName: "span", attributes: { style: "font-size:.875rem;opacity:.7", "data-bind": "", "::text-content": "$v · $dn ($d) · $rg" } },
                          ],
                        }],
                      }] },
                      { tagName: "template", attributes: { "data-value": "no-item" }, nodes: [text("p", "Aucune entreprise ne correspond. Élargissez la recherche.", { style: "font-size:.875rem;opacity:.7;padding:.75rem" })] },
                    ],
                  }],
                },
              ],
            },
            { tagName: "sonic-map", attributes: {
              "points-provider": "pts", "view-provider": "vue", "style-provider": "fond", "state-provider": "carteEtat",
              target: "etat", "pick-action-type": "select", "auto-select": true,
              "allowed-hosts": "tiles.openfreemap.org", style: "display:block;height:min(70vh,640px);border-radius:8px;overflow:hidden",
            } },
          ],
        },
      ],
    }] },
  }],
};

writeFileSync(path.join(outDir, "bitd-gicat.artifact.json"), JSON.stringify(doc, null, 1));
writeFileSync(path.join(outDir, "files.json"), JSON.stringify({ meta: src.meta, files }, null, 1) + "\n");
console.log(`${rows.length} entreprises, document ${Math.round(Buffer.byteLength(JSON.stringify(doc)) / 1024)} Ko`);
for (const f of files) console.log(`${f.name}  ${Math.round(f.bytes / 1024)} Ko  ${f.sha256}`);
