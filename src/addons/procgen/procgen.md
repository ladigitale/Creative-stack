# sonic-procgen

Scène 2D procédurale rendue sur GPU (WebGL2) : rues avec sol et trottoirs, ports, bivouacs, forêts, donjons, personnages,
signalétique, motifs, insignes. Animée sans recomposition (balancement, flammes, eau, nuages, foule…). Aucun JS dans
l'artefact : tout passe par un DataProvider.

## Attributs

| Attribut | Rôle |
|---|---|
| `dataProvider` | Chemin lu et écrit (voir ci-dessous). Sans lui, seuls `scene`, `seed`, `scene-style` s'appliquent. |
| `scene`, `seed`, `scene-style` | Valeurs initiales, utilisées si le DataProvider ne les a pas. |
| `interactive="false"` | Désactive pan, zoom et sélection. |
| `target` | Id d'un `sonic-store` : reçoit `{type: "select", payload: {objectId, pointer, copy, type, def}}` à chaque sélection (`objectId: null` si rien). |
| `select-action-type` | Remplace le type `select`. |

Donner une hauteur à l'élément (`style="height:380px"`). Deux scènes au plus par document (contextes WebGL).

## Clés du DataProvider

Lues : `scene` (nom), `seed`, `params` (paramètres du def racine), `style` (jetons : palette, nuit, lumière, contour… en direct),
`view` `{zoom, cx, cy}`, `select` (pointeur JSON d'un nœud), `anim` `{play, speed, time}`, `patch` (scène complète : `{root, canvas, defs, seed}`).
Écrites : `selection` (objet cliqué ; modifier `selection.params.*` ou `selection.place.*` l'édite et recompose),
`status` `{composing, items, issues, ms, fps, gpuMs, scale, skip, animated, error}`, `view`.

Un `sonic-store` qui publie dans le même DataProvider réécrit tout son état à chaque action : `selection` et `status`
disparaissent alors. Pour garder la sélection, passer par `target`, ou donner à la scène un DataProvider que ce store ne publie pas.

## Scènes

port vivant (animé), bivouac de nuit (animé), rue vivante (animé), rue (scène déclarative), allée forestière, plaine des montgolfières,
personnages, rue à vapeur, espace profond, fond marin, port au phare, désert, donjon (vu du dessus), inventaire de jeu,
insignes et blasons, signalétique, foule et robots, motifs et matières, bestiaire, bourg isométrique, bourg oblique, carte,
forêt de nuit, ruines, marais, paysage, ville néon, ville à vapeur (ancienne).

Styles (`style` = nom ou jetons) : laiton, gravure sépia, nuit vapeur, nocturne, braise, brume, papier, encre, néon, aquarelle,
brutaliste, crypte, réverbères, bivouac, cosmos, abysses, bande dessinée, trame, gouache, pixel art.

## Fluidité

Les couches statiques sont mises en cache, la résolution et la cadence s'adaptent à la charge, le rendu s'arrête hors écran.
`prefers-reduced-motion` n'est pas encore lu : pour figer, écrire `anim: {play: false}`.

## Exemple

`examples/port-vivant.sdui.json` : store + scène + boutons (scène, graine, lecture) + objet touché.

## CSP

Le worker de composition est lancé depuis un `Blob` (`worker-src blob:`) ; sans lui la composition retombe sur le fil principal.
Pas d'`eval`, pas de `new Function`.
