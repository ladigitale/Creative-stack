# Addon `vectorize` — image vers vecteurs

`sonic-vectorize` transforme une image en **chemins SVG** : palette de couleurs (k-moyennes), un masque par couleur, contours suivis sur la grille de pixels et débarrassés de leur escalier, simplification, puis courbes en option (coins vifs conservés).

Tout se pilote par DataProvider : les réglages se lisent dans `control` (avec le compteur `n`) et dans `params` ; un changement de réglage relance le calcul sur l'image déjà lue. Avec `auto`, chaque nouvelle image de la source (fichier déposé, photo) est revectorisée.

```json
{ "tagName": "sonic-file-open", "attributes": { "accept": "image/*", "ref-provider": "photo" } }
{ "tagName": "sonic-still", "attributes": { "id": "img", "in-data-provider": "photo", "hidden-preview": true } }
{ "tagName": "sonic-vectorize", "attributes": { "source": "#img", "auto": true, "control": "vec", "out-data-provider": "vecState" } }
{ "tagName": "sonic-media-download", "attributes": { "source": "vecState.file", "filename": "image-vectorisee", "label": "Télécharger le SVG" } }
```

Store `vec` piloté par des `sonic-action` : `{ "n": 0, "colors": 8, "tolerance": 1, "denoise": 1, "curves": false, "flat": false, "maxSize": 512 }`. Le reducer modifie une clé : le résultat suit, sans incrémenter `n`.

| Attribut | Clé DP (`control` / `params`) | Rôle |
|---|---|---|
| `source` | — | `#id` d'une source d'images (`sonic-still`, `sonic-camera`, `sonic-video`…) |
| `control` | `n` | DP de pilotage : une hausse de `n` relit l'image et lance ; ses autres clés sont des réglages |
| `params` | — | DP de réglages en direct (prioritaire sur `control`) |
| `auto` | — | Vectorise dès que l'image est prête, puis à chaque nouvelle image |
| `interval` | — | Écart minimal entre deux calculs en `auto` (défaut 500 ms) |
| `colors` | `colors` | 2 à 32 couleurs (défaut 8) |
| `palette` | `palette` | Palette imposée : couleurs séparées par des virgules, ou tableau dans le DP (l'état d'un `sonic-palette`, `{ colors }`, convient aussi). Chaque pixel prend la plus proche ; `colors` est alors ignoré. Pour vectoriser sur une palette d'harmonie |
| `tolerance` | `tolerance` | Simplification en pixels (défaut 1 ; plus bas = plus fidèle et plus lourd) |
| `min-area` | `minArea` | Taches plus petites ignorées (défaut 4 px²) |
| `denoise` | `denoise` | Passes de filtre majoritaire 3×3 (0 à 3, défaut 1) ; retire aussi les liserés d'un pixel laissés par l'anticrénelage. `0` garde les traits fins |
| `curves` | `curves` | Courbes lisses ; les coins nets (virage fort) restent vifs |
| `flat` | `flat` | Sans empilement : chaque couleur seule, avec trous (peut laisser des fentes) |
| `max-size` | `maxSize` | Côté maximal analysé en pixels (16 à 1400, défaut 512) |
| `hidden-preview` | — | N'affiche pas le dessin |
| `main-thread` | — | Calcule sur le fil principal au lieu d'un Web Worker (débogage) |

État (`out-data-provider`) :

| Clé | Contenu |
|---|---|
| `status`, `error` | `idle` \| `working` \| `ready` \| `error` |
| `width`, `height` | Image analysée (repère du `viewBox`) |
| `sourceWidth`, `sourceHeight` | Image d'origine (taille d'affichage du SVG) |
| `layers` | Nombre de couches |
| `paths` | `[{ color, area, share, d }]` du dessous au-dessus (`share` : part de l'image, 0..1 ; `d` : tracé dans le repère `width` × `height`) |
| `frame` | Où l'image lue apparaissait à l'écran : matrice `[a, b, c, d, e, f]` des pixels analysés vers le viewport, `null` si la source n'était pas affichée. `sonic-sketch import-from` s'en sert pour poser les formes à leur place |
| `palette` | Couleurs, de la plus étendue à la plus rare |
| `svg` | Document SVG autonome (une couche = un `path` rempli) |
| `file` | Le même SVG en SonicMediaRef `blob:` (`sonic-media-download`, `sonic-image`, `sonic-still`) |
| `bytes`, `ms`, `runs`, `truncated` | Taille du SVG, durée du calcul, nombre de calculs, résultat plafonné |
| `engine` | `worker` (calcul hors du fil principal) ou `main` (repli) |
| `settings` | Réglages effectivement appliqués (à afficher plutôt que ceux du store) |

## Vers le dessin vectoriel

`sonic-sketch import-from="vecState"` importe le résultat en aplats retravaillables : esquisse peinte dans un calque `sonic-paint`, photo, ou image d'un `sonic-shader` générateur (motifs, bruit, fractales) figée puis vectorisée. Avec `palette` sur la palette d'harmonie, les formes importées sont directement dans les couleurs du dessin. Voir l'addon `sketch`, section « Importer des formes ».

## Limites

Le calcul tourne dans un Web Worker (script en `blob:`) : la page reste fluide pendant qu'on règle, et un nouveau réglage interrompt le calcul en cours. Sans Worker disponible, repli sur le fil principal (`engine: "main"`). L'image est réduite à `max-size` (environ 1 s pour une image chargée en 1024 px).

Le script du worker est généré à partir de `trace.ts` : après toute modification du tracé, lancer `yarn worker:vectorize` (`test:ci` vérifie qu'il est à jour). L'image d'un autre site doit autoriser CORS pour être lisible. Convient aux logos, dessins, affiches et photos posterisées, pas au rendu photographique fidèle. Les dégradés deviennent des aplats.

## Lire un SVG tel quel (`svg-from`)

Un fichier SVG n'a pas besoin d'être tracé : ses formes sont déjà vectorielles. `svg-from` désigne un SonicMediaRef (URL `blob:`, par exemple le `ref-provider` d'un `sonic-file-open`) : quand c'est un SVG, ses formes sont lues telles quelles et publiées dans le même état que la vectorisation (`paths[{color, d, opacity}]`, `width`, `height`), avec `source: "svg"`. Sinon la source d'images (`source`) est tracée comme d'habitude : un même branchement accepte donc un SVG ou une photo.

```json
{ "tagName": "sonic-file-open", "attributes": { "accept": "image/*,.svg", "ref-provider": "fichier" } }
{ "tagName": "sonic-still", "attributes": { "id": "image-ouverte", "in-data-provider": "fichier", "hidden-preview": "" } }
{ "tagName": "sonic-vectorize", "attributes": { "source": "#image-ouverte", "svg-from": "fichier", "auto": "", "keep-colors": "", "flat": "", "hidden-preview": "", "out-data-provider": "importState" } }
```

Lu : `path`, `rect` (coins arrondis), `circle`, `ellipse`, `polygon`, `polyline`, `line`, groupes, `use` interne et symboles, `transform`, `viewBox` (à défaut `width` / `height`, sinon la boîte du contenu), couleurs CSS (noms, hex, `rgb()`, `hsl()`, `currentColor`), opacités (`opacity`, `fill-opacity`, `stroke-opacity`), `fill-rule`, styles en attribut, en `style=""` et en `<style>` (sélecteurs simples `.classe`, `#id`, `balise`). Les contours deviennent des formes pleines (bouts et jointures arrondis) ; un dégradé devient sa couleur moyenne. Ignorés et comptés dans `skipped` : textes, images, filtres, masques, découpes. Le document est analysé sans être inséré dans la page : aucun script ne s'exécute, aucune ressource n'est chargée. 5 Mo et 20 000 éléments au plus.

`keep-colors` ajoute `keepColors: true` à l'état : `sonic-sketch` garde alors les couleurs d'origine même avec `import-colors-from`.

Réglages qui s'appliquent aussi au SVG lu (dans `params` ou `control`, ou en attribut) : `palette` ramène chaque couleur à la plus proche de la palette (comme pour une image tracée), `dropBase` (`drop-base`) retire la couche du dessous — le fond : rectangle de fond d'un SVG, papier d'une photo. Les changer republie le résultat sans relire le fichier : l'aperçu du composant montre exactement ce qui sera importé.
