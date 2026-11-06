# Addon `paint` — peindre en temps réel

`sonic-paint` est une toile de peinture : pinceau doux à espacement régulier, gomme, pression du stylet, lissage du tracé, annuler / rétablir. La toile est une **source d'images** : un `sonic-shader` la lit à chaque trait avec `channel0="#toile"`, de quoi peindre pour déformer, éclairer ou faire couler une image.

```json
{ "tagName": "sonic-paint", "attributes": { "id": "toile", "width": "1024", "height": "768", "brush-from": "pinceau", "control": "peintureCtl", "out-data-provider": "peintureState" } }
{ "tagName": "sonic-shader", "attributes": { "channel0": "#toile", "fragment": "…" } }
```

| Attribut | Rôle |
|---|---|
| `width` `height` | Taille de la toile en pixels (jusqu'à 4096 de côté et 16 millions de pixels) |
| `background` | Couleur de fond ou `transparent` |
| `color` `size` `hardness` `opacity` | Couleur CSS, diamètre (1 à 512), bord net (0 flou, 1 net), opacité de chaque empreinte |
| `spacing` | Écart entre empreintes, en fraction du diamètre (0,12) |
| `smoothing` | Lissage du tracé, 0 à 0,95 : plus haut, plus stable et plus en retard |
| `tool` | `paint` ou `erase` (gomme : rend transparent) |
| `pressure` | La pression du stylet module le diamètre (par défaut oui) |
| `tip` | Pointe personnalisée : un chemin SVG `d` (étoile, feuille, tampon…), dessinée à la taille du pinceau et nette à toute taille. Vide : disque doux |
| `tip-from` | DP d'une forme utilisée comme pointe : chaîne `d`, `{ d }` ou une forme de `sonic-vector-library` (choisir une forme change le pinceau) |
| `angle` `angle-follow` | Rotation de la pointe en degrés ; `angle-follow` y ajoute la direction du tracé (pointe qui suit le geste) |
| `angle-jitter` `size-jitter` `scatter` | Variation aléatoire de l'angle (± degrés), de la taille (0 à 1) et dispersion autour du tracé (fraction du diamètre) |
| `roundness` | Aplatissement de la pointe, 1 intacte à 0,05 très plate (pinceau plat, calligraphie avec `angle`) |
| `brush-from` | DP de réglages en direct `{ color, size, hardness, opacity, spacing, smoothing, tool, pressure, tip, angle… }` : une palette en SDUI écrit dedans |
| `control` | DP de commandes à compteur : `{ undo: n, redo: n, clear: n, save: n }` (la commande part quand `n` augmente) |
| `in-data-provider` | Image de départ (`SonicMediaRef`, par exemple une photo de `sonic-file-open`) : dessinée à la place de la toile |
| `undo-levels` | Étapes d'annulation gardées (20 par défaut, 0 pour aucune) |
| `readonly` | Ne peint plus (affichage seul) |
| `hidden-preview` | Toile invisible : elle ne sert que de source d'images |

État : `{ status, error, width, height, strokes, drawing, canUndo, canRedo, tool, color, size, last }`. `save` enregistre un PNG dans `last` (`{ url blob:, mime, width, height, size }`) : brancher `sonic-media-download source="peintureState.last"`.

Les variations aléatoires sont tirées d'une graine par trait : un trait se dessine de la même façon à chaque fois.

## Limites

L'opacité s'applique à chaque empreinte : un trait lent à faible opacité s'épaissit en s'y superposant. L'annulation garde des copies de la toile : sur une grande toile, le nombre d'étapes est réduit pour rester sous une borne de mémoire. Une image de départ de grande taille est ramenée à la toile en conservant ses proportions.
