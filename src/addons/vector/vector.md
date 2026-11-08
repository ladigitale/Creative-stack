# Addon `vector` — outils vectoriels

Opérations sur des **chemins SVG** (`M L H V C S Q T A Z`, absolus ou relatifs). Les courbes sont aplaties pour calculer, le résultat est un chemin `d`.

```json
{ "tagName": "sonic-vector-op", "attributes": { "op": "difference", "a": "formes.cercle", "b": "formes.carre", "out-data-provider": "formes.trou" } }
```

| Opération | Effet | Paramètre |
|---|---|---|
| `union`, `intersect`, `difference`, `xor` | Booléens a ∘ b (trous gérés) | — |
| `offset` | Agrandit (`delta` > 0) ou réduit (< 0), jonctions arrondies | `delta`, `segments` |
| `simplify` | Retire les points inutiles | `tolerance` |
| `round` | Arrondit les coins | `radius` |
| `fit` | Remplace les segments par des courbes de Bézier (coins vifs conservés) | `tolerance` |
| `clip` | Découpe à un rectangle `{x,y,w,h}` (DP `view`) | `view` |

Entrées : `a` / `b` (chemin DP portant une chaîne ou `{ d }`) ou `a-d` / `b-d` (chemin en attribut). Sortie : `{ status, d, polygons, bbox, area, error }` — `status` : `idle` (pas de chemin `a`), `ready`, `error` (détail dans `error`).

### Pilotage en direct

Tout se pilote par DataProvider : `op`, `delta`, `tolerance`, `radius`, `segments` se lisent dans `control` et dans `params`, et chaque changement relance le calcul. Priorité : attributs < `control` < `params` (une clé absente laisse la valeur précédente).

| Attribut | Clé DP (`control` / `params`) | Rôle |
|---|---|---|
| `op` | `op` | Opération (liste ci-dessus) ; inconnue → `status: "error"` |
| `delta` | `delta` | Décalage, borné à ±10 000 |
| `tolerance` | `tolerance` | Écart max de `simplify` / `fit`, 0 à 1 000 |
| `radius` | `radius` | Rayon de `round`, 0 à 10 000 |
| `segments` | `segments` | Segments des jonctions de `offset`, 3 à 64 |
| `control` | `n` | DP de pilotage : une hausse de `n` force le recalcul ; ses autres clés sont des réglages |
| `params` | — | DP de réglages en direct (prioritaire sur `control`) |

```json
{ "tagName": "sonic-vector-op", "attributes": { "op": "offset", "a": "formes.cercle", "params": "formes.reglages", "out-data-provider": "formes.halo" } }
```

Puis `formes.reglages = { "delta": 6 }` agrandit le halo, `{ "op": "fit", "tolerance": 0.5 }` bascule en lissage.

### Ajustement de courbes (`fit`)

Le contour est d'abord coupé à ses **coins** (virage ≥ 55°, mesuré sur quelques tolérances pour ignorer le bruit) : chaque coin reste vif, avec des tangentes unilatérales de part et d'autre. Les portions droites deviennent des segments `L`. Les autres portions sont **rééchantillonnées** en points denses (pas ≤ `tolerance`) puis ajustées par l'algorithme de Schneider : l'écart est mesuré tout le long de la polyligne, pas seulement à ses sommets, et les poignées sont bornées (≤ moitié de la corde, sinon repli corde / 3), ce qui exclut boucles et pointes. Un contour fermé lisse est coupé en deux au point le plus éloigné du départ, avec tangentes partagées (raccord sans cassure). La courbe suit la **polyligne** : un cercle grossièrement échantillonné (8 points) donne un octogone adouci ; augmenter `tolerance` pour obtenir un cercle. API TypeScript : `fitCurve(points, tol, closed, { cornerDeg })` (`cornerDeg` ≥ 180 désactive les coins).

## Bibliothèque

`sonic-vector-library` garde des formes `{ id, name, d, tags }` (500 max). Commande par compteur : la commande n'agit que si `n` augmente.

```json
{ "n": 2, "add": { "name": "étoile", "d": "M0 0 L10 0 L5 9 Z", "tags": ["base"] } }
```

Autres commandes : `remove` (id), `rename` (`{id, name}`), `clear`, `load` (tableau). `filter` : texte ou `tag:texte`. État : `{ status, shapes (avec bbox et area), count, error }` — `status` : `ready`, ou `error` si la dernière commande a échoué.

## Culling (API TypeScript)

`cull`, `TileIndex` (grille spatiale), `levelOfDetail` (simplification à la taille d'un pixel, `null` si invisible), `clipToView`, `viewFromCamera`.

## Limites

Chemins limités à 400 000 caractères et 100 000 segments. Pas de remplissage non nul distinct (règle pair-impair). `sonic-2d` n'accepte pas encore de trous.
