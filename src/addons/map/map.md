# Carte (MapLibre)

`sonic-map` affiche une carte **MapLibre GL JS 5** entièrement pilotée par DataProviders : aucune ligne de JS dans le document.

## Qui fait quoi

| DataProvider | Sens | Contenu |
|---|---|---|
| `<dp>/points` (ou `points-provider`) | entrée | `[{id, lat, lon, label?, …}]` ou `{data, cluster, clusterRadius, clusterMaxZoom}` |
| `<dp>/view` (ou `view-provider`) | entrée | caméra et comportement (ci-dessous) |
| `<dp>/style` (ou `style-provider`) | entrée | style, patches, états d'objets, style des points |
| `<dp>/state` (ou `state-provider`) | **sortie** | état publié par la carte |

Les `*-provider` permettent de brancher une transform ou une sortie de `sonic-jsonata` (un DP par rôle) sans tout ranger sous un même nom.

## Exemple

```json
{ "tagName": "sonic-jsonata", "attributes": { "inputProvider": "etat", "outputProvider": "pts",
  "expression": "{'data': $input.all[lat != null].{'id': i, 'lat': lat, 'lon': lon}}" } },
{ "tagName": "sonic-map", "attributes": { "points-provider": "pts", "view-provider": "vue", "style-provider": "fond",
  "target": "etat", "pick-action-type": "select", "auto-select": true,
  "allowed-hosts": "tiles.openfreemap.org", "style": "display:block;height:480px" } }
```

Exemple complet (495 entreprises, recherche, région, liste à gabarit, fiche, lien Google Maps en lat/lon) : `examples/bitd-gicat.sdui.json`, construit par `examples/build-bitd-example.mjs` depuis l'asset `examples/data/bitd-gicat.json`.

## Vue (`view`)

- Caméra : `center [lon, lat]`, `zoom`, `bearing`, `pitch`, `padding`, `bounds [[w,s],[e,n]]`, `boundsPadding`, `maxZoomOnFit`, `fit: "points" | "selection"` (`points` recadre aussi à chaque changement des points).
- Animation : `mode: "jump" | "ease" | "fly"`, `duration` (ms). `seq` : nombre à incrémenter pour rejouer une commande identique ; renvoyé dans `state.appliedSeq`.
- Monde : `projection: "mercator" | "globe"`, `terrain {source, exaggeration}`, `minZoom`, `maxZoom`, `minPitch`, `maxPitch`, `maxBounds`.
- Interactions : `interactions {dragPan, scrollZoom, boxZoom, dragRotate, keyboard, doubleClickZoom, touchZoomRotate, touchPitch}`. Le pincement (zoom à deux doigts) et la rotation tactile sont gérés par MapLibre.
- Contrôles : `controls {navigation, scale, attribution}` (booléen ou position), `cursor`.
- `selectedId` : sélection pilotée par les données (état d'objet `selected`).

## Style (`style`)

- `style` : style MapLibre **complet** (objet) ou URL d'un style ; `null` = fond uni. Les points sont recréés après chaque changement. Si le style ne se charge pas, la carte revient au fond uni et l'erreur est publiée.
- `patches` + `patchSeq` : `paint`, `layout`, `filter`, `zoomRange`, `addLayer`, `removeLayer`, `addSource`, `removeSource`, `setData`, `light`, `sky`, `terrain`, `projection`.
- `featureStates [{source, id, state}]` ; `pointStyle {paint, layout, clusterPaint, clusterLayout}` (expressions MapLibre, ex. sur `feature-state` `selected` / `hover`).

## État publié (`state`)

`ready`, `loaded`, `moving`, `origin` (`user` | `data` | `init`), `appliedSeq`, `center`, `zoom`, `bearing`, `pitch`, `bounds`, `projection`, `size`, `pointCount`, `visibleIds`, `visibleCount`, `hover`, `selected`, `click {seq, id, cluster, count, lngLat}`, `errors`. Publication en fin de mouvement (`emit="end"`) ou pendant (`emit="move"`, limité par `throttle-ms`).

## Règles

- **Sécurité** : toute URL du style (style, tuiles, glyphes, sprites, GeoJSON) doit être `https` sur un hôte de `allowed-hosts` (`data:` et `blob:` permis) ; sinon le style est refusé, l'erreur publiée et le style précédent conservé. Les requêtes de MapLibre sont filtrées de la même façon.
- **Anti-boucle** : recopier `state` dans `view` ne rejoue pas une caméra identique.
- Pas de HTML issu des données : libellés en texte uniquement.
- WebGL requis ; pas de fond de carte sans source de tuiles autorisée (OpenFreeMap : `tiles.openfreemap.org`, sans clé).
