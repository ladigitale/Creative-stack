# Addon `predict` — créer un modèle de prédiction, puis l'utiliser

`sonic-train` entraîne un modèle **dans le navigateur** à partir d'un tableau : à partir d'une colonne à prédire, il choisit tout seul entre **régression** (une quantité : prix, durée…) et **classification** (une catégorie : oui / non, type…), sépare des lignes de test, entraîne, mesure et explique. `sonic-predict` utilise ensuite le modèle sur une saisie ou un tableau. Rien n'est envoyé nulle part.

```json
{ "tagName": "sonic-file-open", "attributes": { "accept": ".csv", "out-data-provider": "fichier" } }
{ "tagName": "sonic-train", "attributes": { "data-provider": "fichier.text", "target": "prix", "control": "entrCtl", "model-data-provider": "modele", "out-data-provider": "entr" } }
{ "tagName": "sonic-predict", "attributes": { "model-from": "modele", "input-from": "saisie", "out-data-provider": "pred" } }
```

## Données

`data-provider` : un tableau d'objets `[{ "surface": 45, "ville": "Tours", "prix": 120000 }, …]`, un objet `{ rows | items | data }`, ou un **texte CSV** (en-tête obligatoire ; séparateur `,` `;` tabulation ou `|` détecté ; nombres à la française acceptés). Au plus 50 000 lignes et 200 colonnes.

Chaque colonne est rangée automatiquement :
- **nombres** (au moins 90 % des valeurs) : standardisés, manquants remplacés par la moyenne ;
- **catégories** (30 valeurs distinctes au plus) : une colonne 0/1 par valeur ;
- **ignorées**, avec la raison dans `ignored` : presque vides, constantes, identifiants ou texte libre (trop de valeurs distinctes).

La cible est `target` (par défaut la **dernière colonne**). `task="auto"` choisit : classification si la cible n'est pas numérique ou n'a que quelques valeurs entières (0/1, 1 à 5), régression sinon. Les lignes sans cible valide sont écartées (`droppedRows`).

## Entraîner

| Attribut | Rôle |
|---|---|
| `kind` | `mlp` (petit réseau, défaut) ou `linear` (régression linéaire / logistique : plus simple, plus lisible) |
| `hidden-units` | Neurones de la couche cachée (1 à 128, défaut 16) |
| `epochs` | Passages sur les données (1 à 2000, défaut 150) |
| `learning-rate` | Pas d'apprentissage (défaut 0,02) |
| `test-split` | Part de lignes gardées pour tester (0,05 à 0,5, défaut 0,2) |
| `seed` | Graine : même données et mêmes réglages donnent le même modèle |
| `features` | Variables à utiliser, séparées par des virgules (défaut : toutes) |
| `auto-train` | Entraîne dès que les données arrivent |
| `control` | `{ train: n, stop: n }` : compteurs (la commande part quand `n` augmente) |

L'entraînement avance par tranches de 12 ms : la page reste fluide. `stop` garde le modèle à l'époque atteinte.

## Lire le résultat

`out-data-provider` reçoit `status` (`empty`, `ready`, `training`, `done`, `error`), `epoch`, `progress` (0 à 1) et :
- `curve` : `[{ epoch, train, test }]` — la courbe d'apprentissage, à donner à `sonic-plot type="line" x="epoch" y="train,test"` ; si `test` remonte pendant que `train` descend, le modèle apprend les données par cœur ;
- `metrics` — **régression** : `r2`, `rmse`, `mae` et `baselineRmse` (l'erreur qu'on ferait en prédisant toujours la moyenne : le modèle doit faire nettement mieux) ; **classification** : `accuracy`, `baselineAccuracy` (toujours la classe majoritaire), `macroF1`, `confusion` ;
- `importance` : `[{ name, importance }]` triées, parts de 0 à 1 — baisse de qualité quand on mélange une variable (importance par permutation) ;
- `confusion` : `[{ reel, predit, n }]` à plat, pour `sonic-plot type="heatmap" x="predit" y="reel" value="n"` ;
- `ignored`, `features`, `droppedRows`, `columns`, `task`, `target`.

Le **modèle** (JSON, format `sonic-model/1`) est dans `state.model` et dans `model-data-provider` : il contient les poids et l'encodage, pas les données.

## Prédire

`sonic-predict` : `model-from` (DP du modèle), `input-from` : un objet `{ colonne: valeur }` (formulaire, curseurs) ou un tableau de lignes (5 000 au plus). État : `inputs` (variables attendues, avec les valeurs possibles des catégories : de quoi bâtir le formulaire), `prediction` — `{ value }` en régression, `{ label, confidence, probabilities }` en classification —, `predictions` pour un tableau, `missing` (valeurs absentes ou jamais vues à l'entraînement, traitées comme neutres), `metrics`. Un modèle invalide est refusé avec la raison dans `error`.

## Limites

Données tabulaires de quelques milliers de lignes : un petit réseau entraîné sur le processeur du navigateur, pas de l'apprentissage profond. Le découpage test est un tirage au hasard (pas de séparation par date : une série temporelle donnera des mesures trop optimistes). Les modèles ne sont pas des preuves : avec peu de lignes, la mesure sur le test est elle-même incertaine. Pas de validation croisée, pas de réglage automatique des paramètres.
