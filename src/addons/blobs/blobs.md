# Addon `blobs` — compter des objets

`sonic-blobs` compte les objets posés sur un fond (vis, billes, perles, pièces, graines, comprimés…) dans une image : photo, fichier ou flux caméra.

1. L'éclairage est aplati : l'image est divisée par un flou très large, ce qui supprime dégradés et vignettage.
2. Le seuil est calculé par Otsu, et la polarité est automatique : les objets sont la classe minoritaire, sombres ou clairs.
3. Une ouverture morphologique efface poussières et reflets fins.
4. Les composantes connexes sont extraites, puis les objets qui se touchent sont séparés : transformée de distance, une graine par centre, partage de l'amas entre les graines.

```json
{ "tagName": "sonic-camera", "attributes": { "id": "cam", "facing": "environment", "fit": "contain", "control": "ui.cam", "snapshot-provider": "shot.photo" } }
{ "tagName": "div", "attributes": { "style": "position:relative;height:60svh" }, "nodes": [
  { "tagName": "sonic-still", "attributes": { "id": "photo", "in-data-provider": "shot.photo", "fit": "contain", "style": "position:absolute;inset:0;width:100%;height:100%" } },
  { "tagName": "sonic-blobs", "attributes": { "source": "#photo", "auto": true, "fit": "contain", "out-data-provider": "compte", "style": "position:absolute;inset:0;width:100%;height:100%" } }
] }
{ "tagName": "sonic-value", "attributes": { "dataProvider": "compte", "key": "count" } }
```

| Attribut | Rôle |
|---|---|
| `source` | `#id` d'une source d'images : `sonic-still`, `sonic-camera`, `sonic-video`, `sonic-paint`… |
| `auto` | Analyse chaque nouvelle image, au plus toutes les `interval` ms (défaut 500). Sur une caméra, le comptage se fait en continu. Sur une photo, il a lieu à chaque nouvelle photo |
| `control` | DP `{ n }` : une hausse de `n` lance l'analyse (à utiliser à la place de `auto`) |
| `max-size` | Côté analysé en pixels (défaut 640, 1600 au plus) |
| `polarity` | `auto` (défaut), `dark` (objets plus sombres que le fond), `light` |
| `bias` | Décale le seuil, en écarts-types (−3..3). Négatif : seuil plus permissif, les objets pâles sont gardés |
| `flatten` | Rayon de correction de l'éclairage, en fraction du petit côté (défaut 0,12). Il doit rester plus grand qu'un objet |
| `open` | Passes de nettoyage, de 0 à 4 (défaut 1). Plus haut : moins de poussières, mais les objets fins s'amincissent |
| `min-area-rel` | Ignore les taches plus petites que cette fraction d'un objet type (défaut 0,3) |
| `min-area-frac` | Taille minimale absolue, en fraction de l'image (défaut 0,0002) |
| `no-split` | Ne sépare pas les objets qui se touchent : un amas compte pour un, mais `k` l'estime |
| `drop-border` | Ignore les objets coupés par le bord de l'image |
| `ref-from` | DP `{ x, y }` (0..1, repère de l'image) d'un point touché sur un objet type : sa taille devient la référence, au lieu de la médiane |
| `params` | DP de réglages en direct `{ polarity, bias, flatten, open, minAreaRel, split, dropBorder }` : changer une valeur recalcule sans relire l'image |
| `fit` | Cadrage de l'aperçu, `contain` (défaut) ou `cover`, identique à celui de l'image dessous |
| `hidden-preview` | Sans aperçu |

**État** : `{ status: idle|working|ready|error, error, count, estimate, clusters, median, reference, polarity, width, height, ms, runs, blobs, overlay }`.

- `count` : nombre d'objets trouvés, objets séparés compris.
- `estimate` : somme des `k`. Chaque objet porte `k`, le nombre estimé d'après sa surface rapportée à celle d'un objet type. Cette valeur rattrape les amas que la séparation n'a pas découpés.
- `clusters` : objets dont `k` vaut plus de 1.
- `blobs[]` : `{ id, cx, cy, x, y, w, h, nx, ny, nw, nh, area, k, split, border }`. Les champs `n*` sont en 0..1 et servent à se placer sur l'image affichée.
- `overlay.url` : SVG des marqueurs, utilisable comme image (`sonic-still in-data-provider="compte.overlay"`).

**Aperçu** : cercles numérotés (`×k` pour un amas estimé ; couleurs `--sonic-blobs-color`, `--sonic-blobs-split`), sans fond. On le pose en `position:absolute;inset:0` sur l'image, avec le même `fit` : il ne capte aucun clic.

**Correction manuelle** : afficher `count` + une correction (store −/+). Pour « toucher un objet type », un `sonic-cursor` ou un clic qui écrit `{x, y}` dans le DP de `ref-from`.

## Limites

- Il faut un fond qui contraste avec les objets : uni, ou au moins plus régulier qu'eux. Une boîte à lumière (fond éclairé par-dessous) donne les meilleures silhouettes.
- Des objets de couleur proche du fond, ou très réfléchissants, peuvent être coupés en morceaux ou perdus. Régler `bias`, ou `polarity` si la détection automatique se trompe.
- La séparation suppose des objets de taille comparable, plutôt compacts. Des objets très allongés et entremêlés (clous en tas) restent difficiles : `estimate` est alors plus fiable que `count`.
- Le calcul se fait sur le fil principal : de 20 à 150 ms pour 640 px.
