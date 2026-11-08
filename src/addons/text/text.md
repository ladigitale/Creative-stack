# Addon `text` — texte cinétique

`sonic-split-text` découpe un texte en **caractères, mots ou lignes** et les révèle l'un après l'autre. L'avancement (0 → 1) peut venir du défilement, d'une timeline, du curseur ou d'une lecture automatique.

```json
{ "tagName": "sonic-scroll", "attributes": { "out-data-provider": "defil" } }
{ "tagName": "sonic-split-text", "attributes": { "text": "Le texte se dévoile au fil du défilement", "split": "words", "effect": "rise", "progress-source": "defil.smoothProgress", "style": "font-size:48px" } }
{ "tagName": "sonic-split-text", "attributes": { "text": "Bienvenue", "split": "chars", "effect": "blur", "play": "", "duration": "1.5" } }
```

## Attributs

| Attribut | Rôle |
|---|---|
| `text` | Texte à découper ; vide : le texte contenu dans l'élément |
| `split` | `chars`, `words` (défaut) ou `lines` (les lignes sont mesurées et suivent le retour à la ligne) |
| `effect` | `rise` (montée depuis un masque), `fade`, `blur`, `wipe` (balayage `clip-path` de gauche à droite), `scale`, `slide` (glissement horizontal, `distance` px) |
| `spread` | Part de la course consacrée au décalage entre la première et la dernière unité : 0 tout ensemble, 1 l'une après l'autre (défaut 0,7) |
| `ease` | `linear`, `out` (défaut), `inout` |
| `progress` | Avancement 0..1 fixé à la main |
| `progress-source` | Chemin DataProvider de l'avancement, par exemple `defil.smoothProgress` ; remplace `progress` |
| `play`, `duration` | Lecture automatique d'une durée `duration` secondes (défaut 1,2) quand le texte entre dans l'écran |
| `params` | Chemin DataProvider de réglages en direct `{ text, split, effect, ease, spread, distance, duration }` : chaque clé présente remplace l'attribut, une clé retirée (ou `null`) rend la main à l'attribut. `spread` borné à 0..1, `distance` à ±2000 px, `duration` à 0,05..600 s, `text` à 20 000 caractères |
| `out-data-provider` | Reçoit `{ status, error, progress, units, done, settings }` |

`status` : `idle` (aucun texte), `ready`, `error` (valeur inconnue de `split` / `effect` / `ease`, ou valeur `params` refusée : le message est dans `error`, le rendu retombe sur le défaut) ; `settings` : réglages effectifs.

```json
{ "tagName": "sonic-split-text", "attributes": { "text": "Titre", "params": "ui.titre", "progress-source": "defil.smoothProgress", "out-data-provider": "titreState" } }
```

```json
{ "ui": { "titre": { "text": "Nouveau titre", "split": "chars", "effect": "blur", "spread": 0.5 } } }
```

Au plus 2000 unités.

## Accessibilité

Le texte complet est porté par l'élément (`aria-label`) ; les unités sont masquées aux lecteurs d'écran. Avec `prefers-reduced-motion`, le texte est affiché entièrement, sans animation.
