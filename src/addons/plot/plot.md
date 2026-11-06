# Addon `plot` — graphiques statistiques

`sonic-plot` dessine des graphiques en SVG avec les design tokens Concorde (`--sc-primary`, `--sc-base-*`, police `--sc-font-family-base`) : ils suivent le thème, clair ou sombre, sans réglage. Les données viennent d'un DataProvider.

```json
{ "tagName": "sonic-plot", "attributes": { "id": "ventes", "data-provider": "ventes", "type": "line", "x": "mois", "y": "ca,marge", "heading": "Chiffre d'affaires", "format-y": "compact", "curve": "monotone" } }
```

## Données

`data-provider` : un tableau de lignes `[{ "mois": "2026-01", "ca": 120, "marge": 30 }, …]`, ou un objet `{ rows | items | data }`. Chemins pointés acceptés pour les champs (`stats.total`).

## Types

| `type` | Champs | Notes |
|---|---|---|
| `line`, `area` | `x`, `y` (un ou plusieurs, séparés par des virgules) ou `series` | `curve`: `linear`, `monotone`, `step` ; `stack` pour les aires ; `points` |
| `bar`, `barh` | `x` (catégorie), `y` ou `series` | groupées, ou `stack` ; `barh` = horizontales ; `aggregate` regroupe les lignes d'une même catégorie |
| `scatter` | `x`, `y`, `series`, `size` | `size` : rayon proportionnel |
| `pie`, `donut` | `x` (libellé), `value` | total au centre du donut |
| `histogram` | `x` (nombres) | `bins` (défaut : règle de Sturges) |
| `heatmap` | `x`, `y` (catégories), `value` | dégradé du thème |
| `sparkline` | `x`, `y` | sans axes, pour un tableau de bord |

L'axe des abscisses est détecté : nombres, dates ISO (`2026-03-14`) ou catégories (`xType` pour forcer).

## Regrouper les lignes

`aggregate` : `sum`, `mean`, `count`, `min`, `max` regroupe les lignes de même abscisse (par série). `count` n'a pas besoin de champ `y` : `{ "type": "bar", "x": "ville", "aggregate": "count" }` compte les lignes par ville.

## Formats nommés

`format-x`, `format-y`, `format-value` : `number`, `integer`, `compact`, `percent` (0..1), `currency:EUR`, `date`, `datetime`, `auto-date`, `none`. Jamais de fonction. Langue : `locale` du descripteur (défaut `fr`).

## Descripteur complet

L'attribut `spec` (objet JSON) ou `spec-data-provider` accepte tous les champs : `rules: [{ value, label }]` (lignes de référence), `colors: ["primary", "danger", "#e63"]`, `yMin`, `yMax`, `legend`, `grid`, `height`. Les attributs écrasent le descripteur. Valeurs refusées (listées dans `state.error`) : types inconnus, formats autres que les noms ci-dessus, couleurs hors jetons / `#hex`.

## Interaction

Survol, clic (re-clic pour retirer), flèches et Entrée au clavier. `out-data-provider` (défaut `<id>State`) reçoit `{ hover, selected, count, error }` avec `{ series, label, value, share?, row }` : de quoi filtrer un tableau ou afficher le détail.

Accessibilité : `role="img"` et résumé en `aria-label` ; le graphique est focusable.
