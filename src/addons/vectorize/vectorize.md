# Addon `vectorize` — image vers vecteurs

`sonic-vectorize` transforme une image en **chemins SVG** : palette de couleurs (k-moyennes), un masque par couleur, contours suivis sur la grille de pixels, puis simplification (et courbes de Bézier en option).

```json
{ "tagName": "sonic-file-open", "attributes": { "accept": "image/*", "ref-provider": "photo" } }
{ "tagName": "sonic-still", "attributes": { "id": "img", "in-data-provider": "photo" } }
{ "tagName": "sonic-vectorize", "attributes": { "source": "#img", "colors": 8, "curves": true, "control": "vec", "out-data-provider": "vecState" } }
```

| Attribut | Rôle |
|---|---|
| `source` | `#id` d'une source d'images (`sonic-still`, `sonic-camera`, `sonic-video`…) |
| `control` | DP `{ n }` : une hausse de `n` lance la vectorisation |
| `auto` | Vectorise une fois dès que l'image est prête |
| `colors` | 2 à 32 couleurs (défaut 8) |
| `tolerance` | Simplification en pixels (défaut 0,8) |
| `min-area` | Taches plus petites ignorées (défaut 4 px²) |
| `denoise` | Passes de filtre majoritaire 3×3 (0 à 3, défaut 1) |
| `curves` | Courbes de Bézier au lieu de polygones |
| `flat` | Sans empilement : chaque couleur seule, avec trous (peut laisser des fentes) |
| `max-size` | Côté maximal analysé en pixels (défaut 256) |
| `hidden-preview` | N'affiche pas le dessin |

État : `{ status: idle | working | ready | error, error, width, height, layers, palette, svg, ms, truncated }`. `svg` est un document SVG autonome ; chaque couche est un `path` rempli.

## Limites

Calcul sur le fil principal : l'image est réduite à `max-size`. L'image d'un autre site doit autoriser CORS pour être lisible. Convient aux logos, dessins, affiches et photos posterisées, pas au rendu photographique fidèle. Les dégradés deviennent des aplats.
