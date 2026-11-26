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

L'attribut `spec` (objet JSON) ou `spec-data-provider` accepte tous les champs : `rules: [{ value, label }]` (lignes de référence), `colors: ["primary", "danger", "#e63"]`, `yMin`, `yMax`, `legend`, `grid`, `height`.

Priorité : `spec` < attributs < `spec-data-provider`. Les attributs écrasent `spec` ; le DP l'emporte sur les attributs **clé par clé** (une clé absente du DP laisse la valeur de l'attribut), et chaque nouvelle valeur du DP redessine le graphique. On peut donc poser les réglages par défaut en attributs et les changer en direct par DataProvider. Un descripteur DP remplace `spec` (pas de fusion entre les deux). Dans le DP, `y` accepte une liste ou `"ca,marge"`, et les noms d'attributs sont acceptés en alias : `heading` (= `title`), `x-label`, `y-label`, `format-x`, `format-y`, `format-value` (fusionnés dans `format`).

```json
{ "tagName": "sonic-plot", "attributes": { "id": "ventes", "data-provider": "ventes", "spec-data-provider": "ventesVue", "type": "bar", "x": "mois", "y": "ca" } }
```

Puis `ventesVue = { "type": "line", "y": "ca,marge", "curve": "monotone" }` bascule en courbes ; `ventesVue = {}` revient aux attributs. Valeurs refusées (listées dans `state.error`) : types inconnus, formats autres que les noms ci-dessus, couleurs hors jetons / `#hex`.

## Interaction

Survol, clic (re-clic pour retirer), flèches et Entrée au clavier. `out-data-provider` (défaut `<id>State`) reçoit `{ hover, selected, count, status, error }` — `status` : `idle` (aucune ligne), `ready` (dessiné), `error` (descripteur en partie refusé, détail dans `error`, le reste est dessiné) ; republié à chaque changement de statut ou d'erreur — avec `{ series, label, value, share?, row }` : de quoi filtrer un tableau ou afficher le détail.

Accessibilité : `role="img"` et résumé en `aria-label` ; le graphique est focusable.

# `sonic-graph` — graphes nœuds / liens

`sonic-graph` dessine un graphe en SVG avec les mêmes jetons que `sonic-plot` (couleur par `group` : primaire, info, succès, alerte, danger, puis nuances ; liens en `--sc-base-400`, sélection en `--sc-primary`). Le placement par forces est écrit à la main (pas de d3) : répulsion entre nœuds (quadtree de Barnes-Hut au-delà de 300 nœuds), ressorts des liens, gravité vers le centre, collision par rayon, refroidissement. 2000 nœuds et 10 000 liens au plus.

```json
{ "tagName": "sonic-graph", "attributes": { "id": "reseau", "data-provider": "carte.graphe", "selection": "carte.chemin", "target": "carte", "seed": "4", "height": 380 } }
```

## Données

`data-provider` (relu en direct) :

```json
{
  "nodes": [{ "id": "gare", "label": "Gare", "group": "transport", "size": 9 }, { "id": "parc", "x": 0, "y": 0, "fixed": true }],
  "links": [{ "source": "gare", "target": "parc", "weight": 2, "label": "5 min", "directed": true }]
}
```

- `size` : rayon du nœud (6 par défaut, 2 à 40) ; `x` / `y` : position de départ, figée avec `fixed: true`.
- `weight` : épaisseur du trait (et raideur du ressort) ; `directed` : flèche (attribut `directed` = tous les liens).
- Un nœud cité par un lien mais absent de `nodes` est créé ; un nœud peut être une simple chaîne ; `edges` = alias de `links`.
- La forme de `$graphPath` est acceptée telle quelle : `{"edges": [["a", "b", 2], ["b", "c"]], "directed": true}` ou liste d'adjacence `{"a": {"b": 2}, "b": ["c"]}` (liens orientés). Le même objet peut donc servir au calcul du chemin et au dessin.

Un changement de données garde la position des nœuds déjà présents (même `id`) ; un nouveau nœud part près d'un voisin déjà placé, et la simulation repart doucement. Des données republiées à l'identique (le store republie tout son état à chaque action) ne relancent rien.

## Placement

| `layout` | Réglages |
|---|---|
| `force` (défaut) | `seed` (même graine = même dessin), `charge` (répulsion, défaut -60), `link-distance` (défaut 40), `gravity` (0..1, défaut 0.06) |
| `circle` | nœuds dans l'ordre de `nodes` |
| `grid` | grille carrée, `link-distance` = écart |
| `tree` | arbre en couches depuis `root` (défaut : premier nœud sans lien entrant) ; parents centrés sur leurs enfants ; les nœuds non reliés forment d'autres arbres à droite |

La vue se cadre seule tant qu'on ne l'a pas déplacée ; double-clic sur le fond pour recadrer.

## Interaction

- Glisser un nœud : il est figé pendant le glisser ; avec `pin`, il reste où on le lâche (contour pointillé).
- Molette ou pincement : zoom ; glisser le fond : déplacer la vue. `gestures` (`auto`, `capture`, `cooperative`) comme les scènes 3D : en mode coopératif la molette sans Ctrl fait défiler la page.
- Tap sur un nœud : action `{"type": "graph:select", "payload": {"id", "node"}}` vers le store `target` (`action` change le type) ; `node` = le nœud tel qu'il est dans les données.
- Survol : le nœud et ses voisins restent nets, le reste s'estompe ; leurs étiquettes s'affichent.
- `selection` (chemin DP) surligne : un id, une liste d'ids, `{id}`, `{ids}`, ou le résultat de `$graphPath` (`{found, path}`) : nœuds du chemin cerclés et liens entre nœuds consécutifs en couleur primaire.
- `labels` : `auto` (étiquettes des nœuds jusqu'à 100 nœuds, des liens jusqu'à 60 liens ; sinon au survol), `always`, `none`. Étiquettes en texte SVG (jamais de HTML).

## État

`out-data-provider` (défaut `<id>State`) : `{status, error, nodes, links, layout, alpha, settled, hover, selected}` — `status` : `idle` (aucun nœud), `ready`, `error` (données en partie refusées, détail dans `error`) ; `alpha` = température de la simulation, `settled` quand elle est posée ; republié au plus 4 fois par seconde pendant la simulation. Avec `publish-positions` : `positions` `{id: [x, y]}` (coordonnées du graphe, 500 nœuds au plus).

## Exemple : plus court chemin surligné

Le store garde le graphe ; un tap choisit l'arrivée et `$graphPath` calcule le chemin depuis `depart` (sur `edges` seuls : `$graphPath` attend des ids, pas les objets de `nodes`).

```json
{
  "tagName": "div",
  "children": [
    {
      "tagName": "sonic-store",
      "attributes": {
        "id": "carte",
        "initial": {
          "depart": "gare",
          "graphe": {
            "nodes": [
              { "id": "gare", "label": "Gare", "group": "transport" },
              { "id": "marche", "label": "Marché", "group": "commerce" },
              { "id": "ecole", "label": "École", "group": "service" },
              { "id": "parc", "label": "Parc", "group": "loisir" },
              { "id": "mairie", "label": "Mairie", "group": "service" }
            ],
            "edges": [["gare", "marche", 4], ["gare", "ecole", 2], ["ecole", "marche", 1], ["marche", "parc", 3], ["ecole", "mairie", 5], ["mairie", "parc", 1]]
          },
          "chemin": null
        },
        "reducer": "$action.type = 'graph:select' ? $merge([$state, {'chemin': $graphPath({'edges': $state.graphe.edges}, $state.depart, $action.payload.id)}]) : $state"
      }
    },
    { "tagName": "sonic-graph", "attributes": { "id": "plan", "data-provider": "carte.graphe", "selection": "carte.chemin", "target": "carte", "seed": "4", "height": 320 } },
    { "tagName": "sonic-value", "attributes": { "data-provider": "carte", "key": "chemin.cost" } }
  ]
}
```

Rendu et gestes non testés sur un vrai navigateur ici (tests jsdom : convergence, déterminisme, arbre, rendu SVG, tap, survol, glisser).
