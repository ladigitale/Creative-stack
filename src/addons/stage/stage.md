# Scène 2D en DOM (SDUI)

Addon opt-in `@supersoniks/creative-stack/stage`. `sonic-stage` place des éléments HTML (ou SVG) d'après la clé `nodes` de son DataProvider, **au même format que `sonic-3d`**. Tout ce qui écrit `nodes` l'anime sans adaptateur : `sonic-physics` (`nodes-plane="screen"`), un `sonic-store`, `sonic-timeline` (`nodes-out`), `sonic-p2p`.

## Qui fait quoi

| Rôle | Composant |
|---|---|
| Créer, retirer les éléments, leur contenu, leur style | le SDUI (et `sonic-list`, `sonic-states`, `sonic-if` pour ce qui apparaît ou disparaît) |
| Décider où sont les choses | un producteur de `nodes` : physique, store (reducer), timeline, pair p2p |
| Placer les éléments | `sonic-stage` (position, rotation, échelle, opacité, visibilité, empilement) |
| Clics sur un bouton | `sonic-action` (inchangé) |
| Taps dans la scène, avec coordonnées | `sonic-stage target="store"` → `{type: "pick", payload: {objectId, x, y}}` |
| Afficher une valeur | `sonic-value` (inchangé) |

`sonic-stage` ne crée ni ne supprime aucun élément. Un élément qui apparaît (liste, état, condition) reçoit aussitôt le dernier état de son nœud ; un nœud sans élément est gardé et compté dans `missing`.

## Exemple : la physique place des éléments HTML

```json
{ "tagName": "sonic-physics", "attributes": { "id": "monde", "width": "800", "height": "450", "hidden-preview": "", "nodes-plane": "screen", "input": "jeu.input", "style": "position:absolute;inset:0" },
  "nodes": [ { "tagName": "sonic-body", "attributes": { "name": "b1", "r": "28", "x": "200", "y": "90" } },
             { "tagName": "sonic-body", "attributes": { "name": "carte", "type": "static", "w": "300", "h": "90", "x": "400", "y": "330", "angle": "-6" } } ] },
{ "tagName": "sonic-stage", "attributes": { "dataProvider": "mondeState", "width": "800", "height": "450", "target": "jeu", "pick-names": "^b[0-9]$" },
  "nodes": [ { "tagName": "div", "attributes": { "id": "b1", "style": "width:56px;height:56px;border-radius:50%;background:#f472b6" } },
             { "tagName": "div", "attributes": { "id": "carte", "style": "width:300px;height:90px;background:#e2e8f0" } } ] }
```

Même `width` / `height` des deux côtés, même nom de corps et d'`id` : la carte HTML est exactement le corps statique (les billes s'y posent). Voir `examples/billes-dom.sdui.json`.

## Attributs

| Attribut | Rôle |
|---|---|
| `dataProvider` | DataProvider dont la clé `nodes` place les éléments (sinon celui d'un ancêtre, comme les autres composants) |
| `width`, `height` | Taille logique de la scène (unités de `nodes`). Avec les deux, la scène prend la largeur disponible, garde ses proportions et met son contenu à l'échelle |
| `layout` | `absolute` (défaut avec `width` et `height`) : `(x, y)` est le **centre** de l'élément dans la scène. `offset` : décalage depuis la place donnée par la mise en page (comme `sonic-timeline`) |
| `target` | Id du `sonic-store` qui reçoit les taps |
| `pick-action-type` | Type d'action (défaut `pick`) |
| `pick-names` | Regex sur le nom du nœud tapé ; les autres taps sont ignorés |
| `pick-empty` | Envoie aussi `{objectId: null, x, y}` pour un tap hors nœud |
| `out-data-provider` | Publie `{ count, missing }` |

## Format `nodes`

Le même que `sonic-3d` (`src/shared/nodes.ts`) : `{ "nom": { x, y, rz, scale, opacity, visible, z, color, ease: { ms, curve } } }`.

- **Nom** = `id` (ou `data-node-id`) d'un élément de la scène.
- `rz` en **radians** (sens horaire, y vers le bas) ; `scale` nombre ou `[x, y, z]` ; `z` = ordre d'empilement (`z-index`) ; `color` = couleur du texte (HTML) ou remplissage (SVG).
- Sémantique **patch** : champs absents inchangés ; `"$reset": true` retire tout ce que la scène a posé. Republier la même valeur ne fait rien. ≤ 200 nœuds par mutation. Les champs 3D (`rx`, `ry`, `emissive`, `lift`) sont ignorés.
- `ease` : interpolation de position, rotation, échelle et opacité (`linear`, `in`, `out`, `inOut`). Ignoré si l'utilisateur préfère moins de mouvement ; terminé d'un coup quand l'onglet est caché.
- Écrire depuis un reducer : `{"nodes": {"titre": {"x": 120, "ease": {"ms": 300, "curve": "out"}}}}`.

## Règles

1. **Un seul écrivain par élément.** Un élément placé par `sonic-stage` ne doit pas être animé en même temps par `sonic-timeline` / `sonic-animate` en mode DOM : faire écrire la timeline dans `nodes` (`nodes-out`).
2. La scène ne touche qu'à `transform`, `opacity`, `visibility`, `z-index`, `color` (et `position` en `absolute`) : le reste du style vient du SDUI.
3. SVG : les descendants nommés d'un `<svg>` reçoivent l'attribut `transform` en unités du viewBox, le dessin étant centré sur son origine. Le SDUI de Concorde ne crée pas encore d'éléments SVG (et les artefacts n'autorisent pas `markup`) : cette voie sert aux pages qui fournissent leur SVG.
