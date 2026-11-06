# Addon `cursor` — curseur, pointeur et effet magnétique

`sonic-cursor` publie l'état du pointeur dans un DataProvider et, au choix, dessine un **suiveur** lissé et attire des éléments vers le pointeur (**effet magnétique**). Rien n'est détourné : les clics, le survol et le tactile gardent leur comportement natif.

```json
{ "tagName": "sonic-cursor", "attributes": { "follower": "ring", "size": "36", "blend": "difference", "hide-native": "", "magnetic": "[data-magnetic]", "out-data-provider": "pointeur" } }
{ "tagName": "button", "attributes": { "data-magnetic": "", "data-cursor": "voir" } }
```

## Attributs

| Attribut | Rôle |
|---|---|
| `follower` | `none` (défaut), `dot` (point plein) ou `ring` (anneau) : suiveur dessiné au-dessus de la page |
| `size`, `color`, `blend` | Taille en px (2..200), couleur CSS (jeton `--sc-primary` par défaut), `difference` pour inverser les couleurs sous le suiveur |
| `smooth` | Inertie : 1 sans retard, 0,05 très doux (défaut 0,2) |
| `hover-scale` | Agrandissement du suiveur sur un élément `data-cursor` (défaut 2,5 ; 1 : aucun) |
| `hide-native` | Masque le curseur natif, **à la souris seulement** (jamais au tactile ni au stylet) |
| `magnetic` | Sélecteur CSS des éléments attirés (100 au plus) |
| `magnetic-strength`, `magnetic-radius`, `magnetic-max` | Part de l'écart au centre suivie (0..1, défaut 0,35), portée autour de l'élément en px (60), décalage maximal en px (14) |
| `out-data-provider` | Reçoit l'état |

L'élément attiré reçoit `translate` et les variables CSS `--mx` / `--my` (décalage en px), utilisables pour décaler un contenu interne en parallaxe.

## État

`x`, `y` (px), `nx`, `ny` (0..1), `smoothX`, `smoothY` (position du suiveur), `vx`, `vy`, `speed` (px/s), `down`, `inside`, `touch`, `hover` (`{ name, id }` de l'élément survolé qui porte `data-cursor="nom"`, sinon `null`).

## Accessibilité

Avec `prefers-reduced-motion`, le suiveur et les éléments magnétiques suivent sans inertie. Le suiveur n'apparaît qu'avec un pointeur fin qui survole (`hover: hover` et `pointer: fine`) : jamais au tactile.
