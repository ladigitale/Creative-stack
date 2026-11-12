# Addon `color` — palettes d'harmonie

`sonic-palette` calcule un nombre fixé de couleurs à partir d'une couleur de base et d'une **règle de théorie des couleurs**, et les affiche en pastilles cliquables. Le calcul se fait en **OKLCH** : les teintes tournent autour du cercle chromatique à clarté et saturation constantes, si bien que toutes les couleurs paraissent aussi claires que la base. Une couleur hors du gamut sRGB perd un peu de saturation, jamais sa teinte ni sa clarté.

```json
{ "tagName": "sonic-palette", "attributes": { "base": "#c2410c", "rule": "triadic", "count": 6, "target": "pinceau", "payload": "{\"tool\":\"paint\"}", "selected": "0", "out-data-provider": "palette" } }
```

## Règles

| `rule` | Teintes (° depuis la base) | Usage |
|---|---|---|
| `mono` | 0 (nuances seulement) | sobre, une seule couleur |
| `analogous` | 0, −s, +s, −2s, +2s | doux, voisin |
| `complementary` | 0, 180 | contraste fort |
| `split` | 0, 180−s, 180+s | contraste plus nuancé |
| `triadic` | 0, 120, 240 | équilibré, vif |
| `tetradic` | 0, 2s, 180, 180+2s (rectangle) | riche |
| `square` | 0, 90, 180, 270 | riche, très contrasté |

`custom` (alias `perso`, `libre`) : **palette libre**, les couleurs de `colors` telles quelles (attribut : liste JSON ou `#a, #b…` ; ou `params.colors`, tableau ; 12 au plus, doublons et valeurs invalides écartés). Sans couleurs, retombe sur l'harmonie complémentaire de la base. `random` / `rotate` tournent alors la teinte de toutes ses couleurs (OKLCH) ; avec `write-base`, les couleurs tournées sont écrites dans `params` (clé `colors`). Une palette libre peut venir d'un échantillonnage du dessin (`sonic-sketch`, commande `samplePalette`).

`s` = `spread` (défaut 30°). `count` (1..12) : au-delà du nombre de teintes de la règle, la palette ajoute des **nuances** plus claires et plus sombres de ces mêmes teintes (écart `step`, défaut 0,14 de clarté, resserré au besoin). `count` = 0 : autant de couleurs que de teintes (5 en monochrome).

## Choisir une couleur

Clic (ou flèches au clavier) sur une pastille : action `{ type: action, payload: { ...payload, [key]: "#rrggbb" } }` vers le store `target` (défauts : `set`, `color`). Avec un réducteur `$merge([$state, $action.payload])`, le store `pinceau` d'un `sonic-sketch brush-from="pinceau"` change de couleur.

`selected` : rang choisi au départ. `follow` (défaut vrai) : quand la palette change (base, règle, `random`…), la couleur au même rang est renvoyée au store.

## Pilotage et état

`params` : DP `{ base, rule, colors, count, spread, step, selected }` prioritaire sur les attributs. `control` : `{ random, rotate }` compteurs (teinte de base au hasard, rotation de 30°). `headless` : pas de pastilles, calcul et état seulement (par exemple pour colorer un shader).

État (`out-data-provider`) : `{ status, base, rule, count, spread, step, colors: ["#…"], items: [{ hex, hue, l, c, role: base|harmony|shade|custom }], selected, selectedIndex }`.

Variables CSS : `--palette-gap`. Les pastilles suivent `--sc-base`, `--sc-base-content` et `--sc-primary` (anneau du choix, focus).

## sonic-palette-editor

Éditeur de palette pour une modale de configuration : bande des couleurs (clic : sélection ; cadenas : verrou ; `+` : ajouter), carré clarté × saturation en OKLCH à la teinte courante (les zones hors gamut sRGB sont grisées : la couleur retenue est la plus proche affichable), bande des teintes, code hex, nombre de couleurs (1..12), nom.

**Aide d'harmonie** : une règle (`mono`, `analogous`, `complementary`, `split`, `triadic`, `tetradic`, `square`) et « Proposer les couleurs libres » : les couleurs verrouillées restent ; la première verrouillée sert de base (sans verrou, la couleur sélectionnée) ; les autres verrouillées retirent de la proposition les teintes qu'elles occupent déjà ; les couleurs libres reçoivent les teintes de la règle puis leurs nuances. Chaque nouvelle demande donne une variante (écarts de teinte et de clarté, petites variations). Ajouter une couleur la propose aussi selon la règle.

| Attribut | Rôle |
| --- | --- |
| `params` | `dp` ou `dp.clé` d'un objet `{ id, name, colors, locked, rule }` : palette chargée, rechargée quand l'objet change |
| `colors`, `name`, `rule` | Valeurs de départ sans `params` |
| `control` | DP de commandes, compteurs `{ suggest, save, add, remove }` |
| `save-to`, `save-action` | Enregistrer envoie `{ type: save-action (défaut savePalette), payload: { id, name, colors } }` à ce store |
| `out-data-provider` | État `{ id, name, colors, locked, count, selected, rule, lockedCount }` |

Les boutons Enregistrer / Annuler restent ceux de la modale (`control.save`).

```html
<sonic-palette-editor params="harmonie.edit" control="palCtl" save-to="harmonie" out-data-provider="palEditeur"></sonic-palette-editor>
```

`suggestPalette({ colors, locked, rule, anchor, variant })` (export de l'addon) fait le même calcul hors composant.
