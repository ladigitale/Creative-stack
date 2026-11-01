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

// Pages Wikipédia (fr) des entreprises qui en ont une : data/bitd-wikipedia.json, id -> {n, t = titre de page}.
const wiki = JSON.parse(readFileSync(path.join(here, "data/bitd-wikipedia.json"), "utf8")).pages;

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const rows = src.entreprises.map((e) => {
  const dm = e.domaines.join(" · ");
  return {
    i: e.i, n: e.nom, v: e.ville, c: e.cp, d: e.dep, dn: e.depNom, rg: e.region,
    a: e.adresse, t: e.tel, w: e.site, f: e.effectif ? `${e.effectif.toLocaleString("fr-FR")} personnes` : "",
    dm, lat: e.lat, lon: e.lon,
    // Titre de page encodé pour l'URL (« wp » vide : pas de page, le lien n'est pas affiché)
    wp: wiki[e.i] ? encodeURIComponent(wiki[e.i].t) : "",
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

// Sélection, onglets, fermeture et recadrage : le store ne garde que des identifiants (les données sont dans « bitd »).
// detOn : 'off' | 'a' | 'b'. Chaque sélection bascule a <-> b, et visA / visB (booléens) pilotent `visible` de deux modals
// par data-bind. Pourquoi : sonic-if garde son contenu dans le DOM et le modal se ferme tout seul (croix, fond, Échap) sans
// que le store le sache ; un `visible: true` réécrit à chaque ouverture, sur la copie qui était fermée, le rouvre à coup sûr.
// Toute autre action (fermer, onglet, recadrer, localiser) remet les deux à false.
const REDUCER = `(
  $t := $action.type; $p := $action.payload; $s := $state.seq + 1;
  $off := {'detOn': 'off', 'visA': false, 'visB': false};
  $t = 'select' ? (
    $n := $state.detOn = 'a' ? 'b' : 'a';
    $merge([$state, {'sel': $number($type($p) = 'object' ? $p.id : $p), 'detOn': $n, 'visA': $n = 'a', 'visB': $n = 'b', 'seq': $s}])
  )
  : $t = 'close' ? $merge([$state, $off, {'seq': $s}])
  : $t = 'locate' ? $merge([$state, $off, {'sel': $number($type($p) = 'object' ? $p.id : $p), 'onglet': 'carte', 'vCarte': 'default', 'vListe': 'ghost', 'seq': $s}])
  : $t = 'fit' ? $merge([$state, $off, {'sel': -1, 'seq': $s}])
  : $t = 'tab' ? $merge([$state, $off, {'onglet': $p.tab, 'vCarte': $p.tab = 'carte' ? 'default' : 'ghost', 'vListe': $p.tab = 'liste' ? 'default' : 'ghost'}])
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
// Icônes iconoir (noms vérifiés avec find_icons) : elles donnent du sens aux onglets, champs, états et lignes de la fiche.
const icon = (name, attrs = {}) => ({ tagName: "sonic-icon", attributes: { library: "iconoir", name, ...attrs } });
const withIcon = (name, label, style = "display:inline-flex;align-items:center;gap:.4rem") =>
  ({ tagName: "span", attributes: { style }, nodes: [icon(name), text("span", label)] });
const field = (label, key, ic) => ({
  tagName: "div", attributes: { style: "display:flex;gap:.5rem;font-size:.875rem;align-items:baseline" },
  nodes: [
    { tagName: "span", attributes: { style: "opacity:.7;width:9rem;flex-shrink:0;display:inline-flex;align-items:center;gap:.4rem" }, nodes: [icon(ic), text("span", label)] },
    { tagName: "sonic-value", attributes: { dataProvider: "fiche", key } },
  ],
});

const doc = {
  schema: "artifacts/1",
  title: "Membres du GICAT par territoire",
  defaultView: "carte",
  page: { padding: "compact" },
  data: {
    stores: {
      etat: { initial: { parts: [], sel: -1, detOn: "off", visA: false, visB: false, seq: 0, onglet: "carte", vCarte: "default", vListe: "ghost" }, reducer: REDUCER },
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
            { tagName: "sonic-input", attributes: { name: "q", formDataProvider: "filtres", label: "Recherche", placeholder: "Nom, ville, 37, 2A, drone, cyber…" }, nodes: [icon("search", { slot: "prefix" })] },
            { tagName: "sonic-select", attributes: { name: "reg", formDataProvider: "filtres", label: "Région",
              options: JSON.stringify([{ value: "", wording: "Toutes les régions" }, ...regions.map((r) => ({ value: r, wording: r }))]) }, nodes: [icon("pin-alt", { slot: "prefix" })] },
          ],
        },
        { tagName: "p", attributes: { style: "font-size:.875rem;margin:0;display:flex;align-items:center;gap:.4rem" }, nodes: [icon("building"), { tagName: "sonic-value", attributes: { dataProvider: "compte", key: "txt" } }] },
        // Onglets : sonic-menu, l'onglet actif est plein (::variant lu dans le store)
        { tagName: "sonic-subscriber", attributes: { dataProvider: "etat" }, nodes: [{
          tagName: "sonic-menu", attributes: { direction: "row" },
          nodes: [
            { tagName: "sonic-action", attributes: { trigger: "click", target: "etat", type: "tab", payload: { tab: "carte" } }, nodes: [{ tagName: "sonic-menu-item", attributes: { type: "primary", "data-bind": "", "::variant": "$vCarte" }, nodes: [icon("map", { slot: "prefix" }), text("span", "Carte")] }] },
            { tagName: "sonic-action", attributes: { trigger: "click", target: "etat", type: "tab", payload: { tab: "liste" } }, nodes: [{ tagName: "sonic-menu-item", attributes: { type: "primary", "data-bind": "", "::variant": "$vListe" }, nodes: [icon("list", { slot: "prefix" }), text("span", "Liste")] }] },
          ],
        }] },
        // Panneau Carte : les points sont cliquables (clic → select → modal de détail)
        { tagName: "sonic-if", attributes: { dataProvider: "etat", key: "onglet", equals: "carte" }, nodes: [{
          tagName: "div", attributes: { style: "display:grid;gap:.5rem" },
          nodes: [
            { tagName: "sonic-map", attributes: {
              "points-provider": "pts", "view-provider": "vue", "style-provider": "fond", "state-provider": "carteEtat",
              target: "etat", "pick-action-type": "select", "auto-select": true,
              "allowed-hosts": "tiles.openfreemap.org", style: "display:block;height:min(70vh,640px);border-radius:8px;overflow:hidden",
            } },
            { tagName: "div", attributes: { style: "display:flex;gap:.5rem;align-items:center;justify-content:space-between;flex-wrap:wrap" }, nodes: [
              withIcon("cursor-pointer", "Cliquez sur un point pour voir la fiche de l'entreprise.", "display:inline-flex;align-items:center;gap:.4rem;font-size:.875rem;opacity:.7"),
              { tagName: "sonic-action", attributes: { trigger: "click", target: "etat", type: "fit" }, nodes: [{ tagName: "sonic-button", attributes: { type: "default", variant: "outline", size: "sm" }, nodes: [icon("expand", { slot: "prefix" }), text("span", "Recadrer la carte")] }] },
            ] },
          ],
        }] },
        // Panneau Liste : aucune sélection au clic sur la ligne, seul le bouton « Détails » ouvre la fiche
        { tagName: "sonic-if", attributes: { dataProvider: "etat", key: "onglet", equals: "liste" }, nodes: [{
          tagName: "div", attributes: { style: "display:grid;gap:.25rem;max-height:70vh;overflow:auto" },
          nodes: [{
            tagName: "sonic-list", attributes: { dataProvider: "liste" },
            nodes: [
              { tagName: "template", nodes: [{
                tagName: "div", attributes: { class: "ligne", style: "display:flex;gap:.75rem;align-items:center;justify-content:space-between;padding:.4rem .75rem;border-bottom:1px solid var(--sc-base-200, #e5e5e5)" },
                nodes: [
                  { tagName: "div", attributes: { style: "display:grid;min-width:0" }, nodes: [
                    { tagName: "strong", nodes: [{ tagName: "sonic-value", attributes: { key: "n" } }] },
                    { tagName: "span", attributes: { style: "display:inline-flex;align-items:center;gap:.4rem;font-size:.875rem;opacity:.7" }, nodes: [
                      icon("pin-alt"),
                      { tagName: "span", attributes: { "data-bind": "", "::text-content": "$v · $dn ($d) · $rg" } },
                    ] },
                  ] },
                  { tagName: "div", attributes: { style: "display:flex;gap:.5rem;flex-shrink:0" }, nodes: [
                    { tagName: "sonic-action", attributes: { trigger: "click", target: "etat", type: "locate", "data-bind": "", "::payload": "$i" }, nodes: [
                      { tagName: "sonic-button", attributes: { type: "default", variant: "outline", size: "sm" }, nodes: [icon("pin", { slot: "prefix" }), text("span", "Voir sur la carte")] },
                    ] },
                    { tagName: "sonic-action", attributes: { trigger: "click", target: "etat", type: "select", "data-bind": "", "::payload": "$i" }, nodes: [
                      { tagName: "sonic-button", attributes: { type: "primary", variant: "outline", size: "sm" }, nodes: [icon("info-empty", { slot: "prefix" }), text("span", "Détails")] },
                    ] },
                  ] },
                ],
              }] },
              { tagName: "template", attributes: { "data-value": "no-item" }, nodes: [{ tagName: "p", attributes: { style: "display:flex;align-items:center;gap:.5rem;font-size:.875rem;opacity:.7;padding:.75rem" }, nodes: [icon("emoji-sad", { size: "lg" }), text("span", "Aucune entreprise ne correspond. Élargissez la recherche.")] }] },
            ],
          }],
        }] },
        // Détail : modal. Deux copies (a / b) : voir le réducteur.
        ...["a", "b"].map((slot) => ({
          tagName: "sonic-subscriber", attributes: { dataProvider: "etat" },
          nodes: [{
            tagName: "sonic-modal", attributes: { "data-bind": "", "::visible": slot === "a" ? "$visA" : "$visB", maxWidth: "min(100vw, 36rem)" },
            nodes: [
              { tagName: "sonic-modal-title", nodes: [{ tagName: "span", attributes: { style: "display:inline-flex;align-items:center;gap:.5rem" }, nodes: [icon("building", { size: "lg" }), { tagName: "sonic-value", attributes: { dataProvider: "fiche", key: "n" } }] }] },
              { tagName: "sonic-modal-content", nodes: [{
                tagName: "div", attributes: { style: "display:grid;gap:.5rem" },
                nodes: [
                  field("Adresse", "a", "pin-alt"), field("Commune", "v", "city"), field("Département", "dn", "map"), field("Région", "rg", "globe"),
                  field("Téléphone", "t", "phone"), field("Site", "w", "internet"), field("Effectif", "f", "group"), field("Domaines", "dm", "label-outline"),
                  // Lien Wikipédia : seulement si l'entreprise a sa page (champ « wp » non vide)
                  { tagName: "sonic-if", attributes: { dataProvider: "fiche", key: "wp", truthy: true }, nodes: [{
                    tagName: "sonic-subscriber", attributes: { dataProvider: "fiche" }, nodes: [{
                      tagName: "div", attributes: { style: "padding-top:.5rem" },
                      nodes: [{ tagName: "a", attributes: { "data-bind": "", "::href": "https://fr.wikipedia.org/wiki/$wp", target: "_blank", rel: "noopener noreferrer", style: "display:inline-flex;align-items:center;gap:.4rem;text-decoration:underline" }, nodes: [icon("book"), text("span", "Page Wikipédia")] }],
                    }],
                  }] },
                ],
              }] },
            ],
          }],
        })),
      ],
    }] },
  }],
};

writeFileSync(path.join(outDir, "bitd-gicat.artifact.json"), JSON.stringify(doc, null, 1));
writeFileSync(path.join(outDir, "files.json"), JSON.stringify({ meta: src.meta, files }, null, 1) + "\n");
console.log(`${rows.length} entreprises, document ${Math.round(Buffer.byteLength(JSON.stringify(doc)) / 1024)} Ko`);
for (const f of files) console.log(`${f.name}  ${Math.round(f.bytes / 1024)} Ko  ${f.sha256}`);
