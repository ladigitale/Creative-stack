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
| `fit` | Remplace les segments par des courbes de Bézier | `tolerance` |
| `clip` | Découpe à un rectangle `{x,y,w,h}` (DP `view`) | `view` |

Entrées : `a` / `b` (chemin DP portant une chaîne ou `{ d }`) ou `a-d` / `b-d` (chemin en attribut). Sortie : `{ d, polygons, bbox, area, error }`.

## Bibliothèque

`sonic-vector-library` garde des formes `{ id, name, d, tags }` (500 max). Commande par compteur : la commande n'agit que si `n` augmente.

```json
{ "n": 2, "add": { "name": "étoile", "d": "M0 0 L10 0 L5 9 Z", "tags": ["base"] } }
```

Autres commandes : `remove` (id), `rename` (`{id, name}`), `clear`, `load` (tableau). `filter` : texte ou `tag:texte`. État : `{ shapes (avec bbox et area), count, error }`.

## Culling (API TypeScript)

`cull`, `TileIndex` (grille spatiale), `levelOfDetail` (simplification à la taille d'un pixel, `null` si invisible), `clipToView`, `viewFromCamera`.

## Limites

Chemins limités à 400 000 caractères et 100 000 segments. Pas de remplissage non nul distinct (règle pair-impair). `sonic-2d` n'accepte pas encore de trous.
