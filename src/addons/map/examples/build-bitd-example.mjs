#!/usr/bin/env node
/**
 * Construit l'exemple SDUI `bitd-gicat.sdui.json` à partir de l'asset `data/bitd-gicat.json`.
 *   node src/addons/map/examples/build-bitd-example.mjs
 *
 * Montre la voie SDUI par défaut : sonic-list + <template> + data-bind (texte, lien, clic de ligne),
 * filtres de formulaire calculés par sonic-jsonata, et sonic-map piloté par DataProviders.
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(path.join(here, "data/bitd-gicat.json"), "utf8"));
const MAX_ROWS = 150;

const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const all = src.entreprises.map((e) => {
  const dm = e.domaines.join(" · ");
  const adresse = [e.adresse, `${e.cp} ${e.ville}`, "France"].filter(Boolean).join(", ");
  return {
    i: e.i, n: e.nom, v: e.ville, c: e.cp, d: e.dep, dn: e.depNom, rg: e.region,
    a: e.adresse, t: e.tel, w: e.site, f: e.effectif ? `${e.effectif.toLocaleString("fr-FR")} personnes` : "",
    dm, lat: e.lat, lon: e.lon,
    // Google Maps : coordonnées si connues (centre de la commune), sinon adresse
    mq: e.lat !== null ? `${e.lat},${e.lon}` : encodeURIComponent(adresse),
    s: strip([e.nom, e.ville, e.cp, e.depNom, e.region, dm].join(" ")),
  };
});
const regions = [...new Set(all.map((e) => e.rg).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));

const REDUCER = `(
  $t := $action.type; $p := $action.payload;
  $t = 'select' ? (
    $e := $state.all[i = $number($type($p) = 'object' ? $p.id : $p)];
    $s := $state.seq + 1;
    $merge([$state, {'seq': $s, 'sel': $e.i, 'det': $e, 'detOn': 'true',
      'view': $exists($e.lat) and $e.lat != null
        ? {'center': [$e.lon, $e.lat], 'zoom': 10, 'mode': 'fly', 'duration': 800, 'seq': $s, 'selectedId': $e.i}
        : $merge([$state.view, {'selectedId': $e.i}])}])
  ) : $t = 'close' ? $merge([$state, {'sel': null, 'det': {}, 'detOn': 'false', 'view': $merge([$state.view, {'selectedId': null}])}])
  : $t = 'fit' ? ($s := $state.seq + 1; $merge([$state, {'seq': $s, 'view': {'fit': 'points', 'mode': 'ease', 'duration': 600, 'seq': $s, 'selectedId': null}}]))
  : $state
)`;

// Filtre commun (variables du formulaire « filtres » : $q, $reg). Un code 2-3 chiffres ou 2A/2B = département exact.
const FILTER = `$qq := $lowercase($trim($string($exists($q) ? $q : '')));
  $rr := $exists($reg) and $reg != null ? $reg : '';
  $isDep := $contains($qq, /^([0-9]{2,3}|2[ab])$/);
  $f := $input.all[($rr = '' or rg = $rr) and ($qq = '' or ($isDep ? $lowercase(d) = $qq : $contains(s, $qq)))]`;

const jsonata = (out, expression) => ({
  tagName: "sonic-jsonata",
  attributes: { inputProvider: "etat", formDataProvider: "filtres", outputProvider: out, expression },
});
const text = (tagName, t, attributes) => ({ tagName, textContent: t, ...(attributes ? { attributes } : {}) });
const field = (label, key) => ({
  tagName: "div", attributes: { class: "flex gap-2 text-sm" },
  nodes: [text("span", label, { class: "opacity-70 w-28 shrink-0" }), { tagName: "sonic-value", attributes: { dataProvider: "etat", key } }],
});

const doc = {
  schema: "artifacts/1",
  title: "Membres du GICAT par territoire",
  defaultView: "carte",
  page: { padding: "compact" },
  data: {
    stores: {
      etat: { initial: { all, seq: 0, sel: null, det: {}, detOn: "false", view: { fit: "points", mode: "jump", seq: 0 } }, reducer: REDUCER },
      fond: { initial: { style: "https://tiles.openfreemap.org/styles/positron" }, reducer: "$state" },
    },
  },
  views: [{
    id: "carte", title: "Carte",
    root: { nodes: [{
      tagName: "div", attributes: { class: "grid gap-4" },
      nodes: [
        jsonata("liste", `( ${FILTER}; $f[[0..${MAX_ROWS - 1}]] )`),
        jsonata("pts", `( ${FILTER}; {'data': $f[lat != null].{'id': i, 'lat': lat, 'lon': lon, 'label': n}} )`),
        jsonata("vue", "$input.view"),
        jsonata("compte", `( ${FILTER}; $n := $count($f); {'txt': $string($n) & ' entreprise' & ($n > 1 ? 's' : '') & ($n > ${MAX_ROWS} ? ' (${MAX_ROWS} premières listées)' : '') & ' · ' & $string($count($f[lat != null])) & ' sur la carte'} )`),
        text("h1", "Membres du GICAT par territoire", { class: "text-2xl font-semibold" }),
        text("p", `Annuaire GICAT 2026, informations déclarées par les sociétés. Position = centre de la commune (${src.meta.sansCoordonnees} entreprises sans position). Une adhésion au GICAT ne suffit pas à classer une entreprise dans la BITD.`, { class: "text-sm opacity-70" }),
        {
          tagName: "div", attributes: { style: "display:grid;gap:.5rem;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));align-items:end" },
          nodes: [
            { tagName: "sonic-input", attributes: { name: "q", formDataProvider: "filtres", label: "Recherche", placeholder: "Nom, ville, 37, 2A, drone, cyber…" } },
            { tagName: "sonic-select", attributes: { name: "reg", formDataProvider: "filtres", label: "Région",
              options: JSON.stringify([{ value: "", wording: "Toutes les régions" }, ...regions.map((r) => ({ value: r, wording: r }))]) } },
            { tagName: "sonic-action", attributes: { target: "etat", type: "fit" }, nodes: [{ tagName: "sonic-button", attributes: { type: "default", variant: "outline" }, nodes: [text("span", "Recadrer la carte")] }] },
          ],
        },
        { tagName: "p", attributes: { class: "text-sm" }, nodes: [{ tagName: "sonic-value", attributes: { dataProvider: "compte", key: "txt" } }] },
        {
          tagName: "div", attributes: { style: "display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));align-items:start" },
          nodes: [
            {
              tagName: "div", attributes: { class: "grid gap-3 content-start" },
              nodes: [
                { tagName: "sonic-if", attributes: { dataProvider: "etat", key: "detOn", equals: "true" }, nodes: [{
                  tagName: "sonic-card", nodes: [{
                    tagName: "div", attributes: { class: "grid gap-2 p-4" },
                    nodes: [
                      { tagName: "h2", attributes: { class: "text-lg font-semibold" }, nodes: [{ tagName: "sonic-value", attributes: { dataProvider: "etat", key: "det.n" } }] },
                      field("Adresse", "det.a"), field("Commune", "det.v"), field("Département", "det.dn"), field("Région", "det.rg"),
                      field("Téléphone", "det.t"), field("Site", "det.w"), field("Effectif", "det.f"), field("Domaines", "det.dm"),
                      { tagName: "sonic-subscriber", attributes: { dataProvider: "etat" }, nodes: [{
                        tagName: "div", attributes: { class: "flex gap-3 pt-2" },
                        nodes: [
                          { tagName: "a", attributes: { "data-bind": "", "::href": "https://www.google.com/maps/search/?api=1&query=$det.mq", target: "_blank", rel: "noopener noreferrer", class: "underline" }, textContent: "Ouvrir dans Google Maps" },
                        ],
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
                            { tagName: "span", attributes: { class: "text-sm opacity-70", "data-bind": "", "::text-content": "$v · $dn ($d) · $rg" } },
                          ],
                        }],
                      }] },
                      { tagName: "template", attributes: { "data-value": "no-item" }, nodes: [text("p", "Aucune entreprise ne correspond. Élargissez la recherche.", { class: "text-sm opacity-70 p-3" })] },
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

const out = path.join(here, "bitd-gicat.sdui.json");
writeFileSync(out, JSON.stringify(doc));
console.log(`${all.length} entreprises -> ${path.relative(process.cwd(), out)} (${Math.round(JSON.stringify(doc).length / 1024)} Ko)`);
