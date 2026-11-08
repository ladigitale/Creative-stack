# Animation (SDUI)

Addon opt-in `@supersoniks/creative-stack/animation`. Anime des éléments d'un artefact SDUI **sans JS** : le temps est une valeur de DataProvider, une timeline la lit et applique l'état.

## En deux phrases

`sonic-clock` produit un temps `t` (0 à 1) dans un DataProvider ; `sonic-timeline` lit un `t` et anime des éléments en conséquence. Tout ce qui écrit un nombre dans un DataProvider peut piloter une timeline : horloge, slider de formulaire, sortie `sonic-p2p`, analyseur audio.

## Règles d'or

1. **Commence par `sonic-animate`** : une recette, des enfants, aucun JSON de timeline. Descends à `sonic-timeline` seulement pour une chorégraphie sur mesure.
2. Une timeline **ne joue jamais toute seule** : elle lit `t`. Pour qu'elle joue, ajoute un `sonic-clock`.
3. **Cibles = `id` DOM.** Donne à tout nœud animé `"attributes": {"id": "titre"}` (et `"nodeId": "titre"` pour les validateurs). Concorde 5.0.x ne rend pas `nodeId` dans le DOM ; `data-node-id` est aussi reconnu.
4. Aucun JS, aucun HTML : l'animation est de la donnée (compatible `profile="safe"`). Le texte animé n'écrit que `textContent`.
5. **Un seul écrivain par DataProvider de temps** : une horloge **ou** un slider **ou** un pair p2p.
6. Le descripteur de `sonic-timeline` est un **JSON en chaîne dans l'attribut `descriptor`** (les nœuds SDUI n'ont pas de champ `props`).
7. Propriétés animables : `opacity`, `x`, `y`, `scale`, `rotate`, `blur` (nombres, **sans unité**) et toute variable CSS `--nom`. Pas `width`, `height`, `top`, `left`.
8. `prefers-reduced-motion` est respecté : état final immédiat, pas de boucle.

## `sonic-animate` (le plus courant)

Enveloppe ses enfants directs et leur applique une recette. Pas besoin d'horloge : il a la sienne.

```json
{
  "tagName": "sonic-animate",
  "attributes": { "recipe": "reveal", "trigger": "viewport", "stagger": "0.12" },
  "nodes": [
    { "tagName": "h2", "textContent": "Bienvenue" },
    { "tagName": "p", "textContent": "Chaque enfant apparaît à son tour." }
  ]
}
```

| Attribut | Valeurs | Défaut |
|---|---|---|
| `recipe` | `reveal`, `fade`, `slide-up`, `count-up`, `typewriter` | obligatoire |
| `trigger` | `viewport`, `load`, `data` (changement du chemin `watch`), `manual` (appel de `start()`) | `viewport` |
| `duration` | secondes d'un effet | propre à la recette |
| `stagger` | secondes entre enfants | propre à la recette |
| `once` | `"true"` / `"false"` : `"false"` rejoue à chaque entrée dans l'écran | `true` |
| `time-source` | chemin DataProvider d'un temps 0..1 (ex. `scrub.t`) : remplace l'horloge locale | aucun |
| `ease` | `linear`, `easeIn`, `easeOut`, `easeInOut` | selon la recette |
| `from`, `to`, `decimals`, `text-prefix`, `text-suffix` | `count-up` : nombres de départ et d'arrivée, décimales, texte autour | `0`, `100`, `0` |
| `control` | chemin DataProvider `{ n }` : chaque hausse de `n` lance (ou relance) l'animation, quel que soit `trigger` ; avec `trigger="manual"`, c'est le déclenchement sans JS (la première valeur vue sert de référence) | aucun |
| `out-data-provider` | reçoit l'état `{ status, error, progress, done, runs, duration }` (≈ 30 Hz au plus pendant la lecture) | aucun |

État : `status` `idle` (pas encore joué), `running` (horloge locale en cours), `ready` (terminé, ou temps lu dans `time-source`), `error` (recette inconnue, message dans `error`) ; `progress` 0..1, `done` à 1 ; `runs` : nombre de lancements.

```json
{ "tagName": "sonic-animate", "attributes": { "recipe": "count-up", "trigger": "manual", "control": "ui.compteur", "to": "1200", "out-data-provider": "compteurState" },
  "nodes": [ { "tagName": "span", "textContent": "0" } ] }
```

Un `sonic-action` (ou un reducer) qui incrémente `ui.compteur.n` relance le compteur.

Recettes : `reveal` (fondu + montée de 16 px, décalé), `fade`, `slide-up` (montée de 40 px), `count-up` (compteur dans le texte de l'enfant), `typewriter` (le texte de l'enfant s'écrit).

Les enfants sont à leur état de départ (invisibles pour `reveal`) dès le chargement, puis l'animation se déclenche.

## `sonic-clock`

Produit du temps. N'anime rien.

```json
{ "tagName": "sonic-clock", "attributes": { "dataProvider": "clock-main", "duration": "4", "mode": "loop", "autoplay": "true" } }
```

Attributs : `dataProvider` (obligatoire), `duration` (secondes d'un tour, défaut 1), `mode` (`once` défaut, `loop`, `pingpong`), `rate` (1 = temps réel, négatif = à rebours), `autoplay`, `on-hidden` (`freeze` défaut : reprend sans saut après un onglet masqué ; `catch-up` : rattrape).

Il écrit dans son DataProvider :

| Clé | Sens |
|---|---|
| `t` | position normalisée 0..1 |
| `time` | `t × duration` en secondes |
| `duration` | durée d'un tour |
| `playing` | en lecture ? |
| `rate` | vitesse |
| `direction` | `1` ou `-1` (utile en `pingpong`) |
| `origin` | identifiant de l'horloge |

Pour le piloter, **écris dans son DataProvider** : `playing` (`true`/`false`), `rate`, ou `t`. Un `t` écrit de l'extérieur positionne l'horloge **et la met en pause** (scrub) ; écrire `playing: true` reprend.

## `sonic-timeline`

Lit un temps normalisé et anime des éléments par `id`.

```json
{
  "tagName": "sonic-timeline",
  "attributes": {
    "time-source": "clock-main.t",
    "descriptor": "{\"duration\":3,\"root\":{\"type\":\"seq\",\"nodes\":[{\"type\":\"tween\",\"targets\":[\"titre\"],\"props\":{\"opacity\":[0,1],\"y\":[24,0]},\"duration\":0.8,\"ease\":\"easeOut\"}]}}"
  }
}
```

Attributs : `descriptor` (JSON en chaîne), `descriptor-dp` (le descripteur vient d'un DataProvider), `time-source` (chemin du temps ; remplace `timeSource` du descripteur), `out-of-range` (`clamp` défaut ou `wrap`), `smooth` (secondes de lissage, 0 = aucun), `duration` (secondes ; sinon déduite des nœuds), `out-data-provider` (publie `status`, `progress`, `time`, `duration`, `currentLabel`, `issues`), `nodes-out` (mode nodes, voir plus bas).

### Descripteur

`{ "timeSource": "clock-main.t", "duration": 3, "outOfRange": "clamp", "smooth": 0, "root": <nœud> }`

| `type` | Rôle | Champs |
|---|---|---|
| `seq` | enfants l'un après l'autre | `nodes` |
| `par` | enfants en parallèle | `nodes` |
| `stagger` | décale les enfants de `each` s ; répartit aussi les cibles multiples d'un `tween` enfant | `nodes`, `each` (défaut 0.1) |
| `tween` | anime des propriétés | `targets`, `props` (`{"opacity": [de, à]}`), `duration` (0.5), `delay`, `ease` |
| `text` | compteur ou machine à écrire | `targets`, `mode` (`count`/`type`), `from`, `to`, `decimals`, `prefix`, `suffix`, `duration`, `ease` |
| `set` | écrit une valeur dans un DataProvider quand le temps franchit `at` (en avançant) | `at`, `path`, `value` |
| `label` | marqueur nommé, exposé dans `currentLabel` | `name`, `at` |

Cibles (`targets`) : `"id"` ; `"children:id"` (enfants directs de l'élément `id`) ; `"group:nom"` (éléments portant `data-anim-group="nom"`) ; `"@self"` (l'élément lui-même).

`ease` : `linear`, `easeIn`, `easeOut`, `easeInOut` ou `[x1, y1, x2, y2]` (cubic-bezier). Un nœud `set` ne doit pas écrire dans le DataProvider du temps.

Quand deux `tween` visent la même propriété d'un élément, celui qui a démarré en dernier l'emporte ; avant son démarrage, l'élément montre l'état de départ (`from`).

## Piloter le temps

**Horloge** : `sonic-clock dataProvider="clock-main"` + `time-source="clock-main.t"`.

**Slider de formulaire** : le `sonic-input` de Concorde écrit dans `<formDataProvider>.<name>` ; les chaînes numériques sont acceptées. Pas d'horloge.

```json
{ "tagName": "sonic-input", "attributes": { "type": "range", "min": "0", "max": "1", "step": "0.001", "value": "0", "name": "t", "formDataProvider": "scrub" } }
```

puis `time-source="scrub.t"` sur la timeline (ou sur un `sonic-animate`).

**Pair p2p** (dès que `sonic-p2p` existe) : `time-source` pointe vers le DataProvider de sortie de `sonic-p2p` ; ajoute `smooth="0.08"` pour absorber la gigue du réseau. Le suiveur n'a pas d'horloge.

**Audio** : un analyseur publie `rms` (0..1) ; `time-source="audio-fx.rms"` anime au rythme du son.

Plusieurs timelines peuvent lire le même DataProvider (même `t`).

## Validation

Hors navigateur (validateur d'artefacts, tests) :

```ts
import { validateSduiAnimation, validateTimelineDescriptor } from "@supersoniks/creative-stack/animation";
validateSduiAnimation(sduiDescriptor);          // horloges, timelines, recettes, cibles existantes
validateTimelineDescriptor(descriptor, { knownIds });
```

Chaque problème est `{ path, field, message, fix }` : `fix` propose la correction. Limites : arbre de 8 niveaux, 200 cibles par `tween`, 600 s au total.

Dans le navigateur, un descripteur invalide rend la timeline **muette** (aucun style appliqué), avec un `console.warn` et `status: "error"` + `issues` dans `out-data-provider`.

## Erreurs fréquentes

- Cible inconnue : l'élément n'a pas d'`id` (ou `data-node-id`). Ajoute `"attributes": {"id": "…"}`.
- Deux écrivains sur le même DataProvider de temps (horloge + slider) : saccades. Un seul.
- Unités dans les valeurs (`"y": ["24px", "0"]`) : écris des nombres.
- Animer `width`, `height`, `top`, `left` : non supporté ; utilise `x`, `y`, `scale`.
- `descriptor` collé sans échapper les guillemets : c'est une **chaîne** JSON.
- Timeline sans `timeSource` / `time-source` : elle ne bougera jamais.

## CDN

```html
<script src="concorde-core.bundle.js"></script>
<script src="creative-stack-animation.bundle.js"></script>
```

## `sonic-skeleton` et `sonic-bone` : un squelette 2D pour n'importe quel élément graphique

```json
[ { "tagName": "sonic-camera", "attributes": { "id": "cam", "hidden-preview": "" } },
  { "tagName": "sonic-pose-tracker", "attributes": { "id": "pose", "for": "cam" } },
  { "tagName": "sonic-skeleton", "attributes": { "preset": "humain", "source": "pose", "nodes-out": "rig" } },
  { "tagName": "sonic-2d", "attributes": { "dataProvider": "rig" },
    "nodes": [ { "tagName": "sonic-sprite", "attributes": { "name": "bras-gauche", "shape": "box", "w": "22", "h": "65", "pivot": "0.5,0" } } ] } ]
```

Une hiérarchie d'**os rigides** (marionnette articulée, bras mécanique, plante, chaîne de pendules) qui **écrit des `nodes`** : le format partagé que lisent `sonic-2d` (sprites), `sonic-3d` (nœuds glTF) et `sonic-stage` (éléments HTML / SVG). Un élément de même nom que l'os le suit : le squelette ne dessine rien. À l'écriture, `<nodes-out>.nodes` reçoit un nœud par os (`x`, `y` de l'articulation, `rz` en radians par rapport au repos), `<nodes-out>.bones` l'état des os (`x`, `y`, `x2`, `y2` de l'extrémité, `angle`, `rz`, `length`) `<nodes-out>.present` et `<nodes-out>.rest` (pose de repos : mêmes champs sans `rz`, racine à sa position fixe `x`,`y` ; publiée quand elle change) que lit un maillage déformable.

**Conventions.** Angles en **degrés** : `0` = l'os pointe vers le bas, positif = sens horaire à l'écran (bas, gauche, haut, droite). `angle` est l'angle de **repos**, relatif au parent. Au repos tous les `rz` valent 0 : on dessine donc chaque élément **dans la pose de repos**, avec son `pivot` (sprite de `sonic-2d`) sur l'articulation ; il suit ensuite l'os sans autre calcul. Pour un bras pendant : `pivot="0.5,0"` (haut du sprite = épaule).

### `sonic-skeleton`

| Attribut | Rôle | Défaut |
|---|---|---|
| `nodes-out` | DataProvider qui reçoit `nodes`, `bones`, `present`, `rest`, et l'état `status`, `error`, `errors` ; c'est celui que lit `sonic-2d dataProvider` | aucun (rien n'est écrit) |
| `preset` | `humain` : 13 os (bassin, torse, tête, bras, avant-bras, mains, cuisses, mollets) branchés sur les articulations d'un `sonic-pose-tracker` | aucun |
| `source` | DataProvider de la sortie d'un `sonic-pose-tracker` (clé `joints`) | aucun |
| `root` | Articulations dont la moyenne place la racine (`leftHip+rightHip`) ; avec le preset humain et `source`, c'est le défaut | position fixe |
| `x`, `y` | Position fixe de la racine (unités de la scène) | bas-centre |
| `width`, `height` | Taille de la scène : l'image de la pose y est étirée pour placer la racine | `800`, `450` |
| `aspect` | Largeur / hauteur de l'image analysée (angles justes sur une image non carrée) | `1.333` |
| `scale` | Échelle de tout le squelette (longueurs et décalages) | `1` |
| `min-visibility` | Visibilité minimale d'une articulation (0..1) pour servir | `0.5` |
| `smooth` | Lissage One Euro des articulations, 0 à 1 | `0.4` |
| `hold-ms` | Une mesure perdue garde la dernière direction cette durée, puis l'os retourne au repos | `600` |
| `ease-ms` | Durée de l'interpolation du retour au repos demandée au rendu (`ease`) | `300` |
| `rest` | `pose` : la pose de repos publiée (`<nodes-out>.rest`) est la pose **mesurée** (sans les ajouts `angle-add-from`) | – |
| `fit` | Nom d'un os (`true` = `torse`) dont la longueur mesurée règle l'échelle : les os prennent la taille de la personne ; sans mesure, dernière échelle trouvée | – |

État : `<nodes-out>.status` vaut `idle` (aucun os), `ready` ou `error` ; `<nodes-out>.errors` liste les erreurs de déclaration (os sans nom ou déclaré deux fois, parent inconnu, preset inconnu, trop d'os…) et `<nodes-out>.error` la première (ou `null`). Les os valides restent actifs malgré une erreur.

### `sonic-bone`

Enfant de `sonic-skeleton`. Avec un `preset`, un `sonic-bone` **de même nom** en modifie les attributs (la longueur du torse, une limite de coude) ; un nom nouveau ajoute un os.

| Attribut | Rôle | Défaut |
|---|---|---|
| `name` | Nom de l'os et du nœud écrit (l'élément de même nom le suit) | requis |
| `parent` | Nom de l'os parent ; vide : racine | racine |
| `length` | Longueur (unités) ; `0` pour une articulation sans segment (bassin) | `100` |
| `angle` | Angle de repos (°), relatif au parent (absolu pour la racine) | `0` |
| `at` | Où l'os s'attache sur son parent : `0` à l'origine, `1` à l'extrémité | `1` |
| `offset` | Décalage latéral (unités) perpendiculaire au parent : épaule, hanche. Positif = à droite d'un parent qui pointe vers le bas | `0` |
| `min`, `max` | Limites de rotation (°) par rapport au repos, locales (un coude ne plie que dans un sens) | `-180`, `180` |
| `aim` | Direction mesurée : `leftShoulder>leftElbow` (de l'articulation A vers B ; `a+b` moyenne ; une barre verticale sépare des alternatives, la première disponible) | aucun |
| `angle-from` | Chemin DataProvider d'un nombre (°) : rotation ajoutée au repos (slider, audio, horloge, store, main) | aucun |
| `angle-add-from` | Chemin DataProvider d'un nombre (°) **ajouté** à l'angle de l'os, mesuré (`aim`) ou de repos : une danse par-dessus la pose. Les enfants suivent leur parent qui tourne | aucun |
| `angle-scale`, `angle-offset` | Facteur (`angle-from` et `angle-add-from`) et décalage (`angle-from`) : `valeur × scale + offset` | `1`, `0` |
| `attach` | Autres noms de nœuds alimentés par cet os (séparés par des espaces ou des virgules) | aucun |

`aim` l'emporte sur `angle-from`. Une articulation absente ou sous `min-visibility` rend `aim` indisponible : l'os garde sa dernière direction `hold-ms`, puis revient au repos. Les noms d'articulations sont ceux de `sonic-pose-tracker` (`left*` = côté gauche de l'écran).

**Preset `humain`** (corps de face d'environ 300 unités, tête en haut ; dessiner bras et jambes pendants) : `bassin` (racine, milieu des hanches), `torse`, `tete`, `bras-gauche`, `avant-bras-gauche`, `main-gauche`, `bras-droit`, `avant-bras-droit`, `main-droite`, `cuisse-gauche`, `mollet-gauche`, `cuisse-droite`, `mollet-droit`. Voir `examples/marionnette.sdui.json`.

**Photo posable** : `fit="true" rest="pose"` sur un `preset="humain"` branché sur une pose figée (`sonic-frame-sync hold`, voir `media.md`) : le squelette prend la taille et la pose de la personne photographiée, et c'est cette pose que publie `rest`. Un maillage (`sonic-sprite shape="mesh"`) dessiné sur le découpage de la photo, à l'échelle de l'image, ne se déforme alors que par les `angle-add-from` (rotations d'une chorégraphie `sonic-timeline` : `nodes-out`, puis `angle-add-from="anim.nodes.<nom>.rz"` avec `angle-scale="57.29578"`). Quelques degrés suffisent pour un balancement discret.

**Sans caméra** : `angle-from` suffit (un `sonic-store` piloté par des curseurs, un `sonic-clock`, un analyseur audio) pour un bras articulé ou une chaîne de pendules.

**Image qui se plie.** Des sprites `shape="mesh"` de `sonic-2d` (voir 2d.md) lisent `rest` et `bones` et déforment une image entre les os (exemple : `examples/bras-souple.sdui.json`) ; les os restent rigides, c'est l'image qui est souple. Dessiner l'image dans la pose de repos, à la position de la racine `x`,`y` du squelette.

Limites : os **rigides** (le pli est calculé par le maillage du rendu, pas par les os) ; cinématique directe seulement (pas de cinématique inverse : on donne les directions, pas la position d'un bout) ; pose de face (un os de longueur fixe ne se raccourcit pas quand le segment se tourne vers la caméra) ; un seul sujet.

## `sonic-puppet` : une photo articulée sur ses vraies articulations

```json
[ { "tagName": "sonic-frame-sync", "attributes": { "id": "held", "for": "cam", "mode": "live", "control": "app" } },
  { "tagName": "sonic-segmenter", "attributes": { "id": "seg", "for": "held", "mode": "alpha", "mirror": "false" } },
  { "tagName": "sonic-pose-tracker", "attributes": { "id": "pose", "for": "held", "mirror": "false" } },
  { "tagName": "sonic-mask-replace", "attributes": { "id": "personne", "source": "held", "mask": "seg", "mirror": "false", "target": "background", "effect": "cutout", "style": "display:none" } },
  { "tagName": "sonic-timeline", "attributes": { "nodes-out": "anim", "time-source": "clock.t", "descriptor": "…" } },
  { "tagName": "sonic-puppet", "attributes": { "source": "#personne", "pose": "pose", "frame": "#held", "capture": "app.hold", "nodes-out": "rig", "drive": "anim.nodes", "drive-prefix": "d_", "width": "800", "height": "600" } },
  { "tagName": "sonic-2d", "attributes": { "dataProvider": "rig", "width": "800", "height": "600" },
    "nodes": [ { "tagName": "sonic-sprite", "attributes": { "shape": "mesh", "source": "#personne", "x": "400", "y": "300", "w": "800", "h": "600", "grid": "32,24", "falloff": "3", "influences": "3" } } ] } ]
```

`sonic-puppet` donne à une personne photographiée un **squelette mesuré sur elle** : les os sont les segments entre les articulations que le modèle de pose a détectées (aucune proportion préréglée, aucun squelette générique à caler). Seules les parties vues existent : une photo en buste donne tête, tronc, bras et mains ; les jambes apparaissent si les hanches, genoux et chevilles sont visibles, et le bassin est déduit sous les épaules quand il est hors cadre.

Deux modes (`mode`) :

- **`skin` (défaut) : l'image se déforme, sans coupure.** Le composant publie la pose de repos mesurée (`<nodes-out>.rest`, avec la demi-largeur `radius` de chaque os) et la pose courante (`.bones`, `.present`) au format de `sonic-skeleton`. Un `sonic-sprite shape="mesh"` dont `source` est la personne découpée se déforme alors par poids entre les os : près d'une articulation un sommet suit les deux os, loin d'elle un seul. L'image reste continue, donc aucun trou quand un bras tourne. Grâce à `radius`, les poids viennent de la distance à la **surface** de chaque os et non à son axe : un os large (le tronc) revendique tout son intérieur, et un bras le long du corps ne tire pas le flanc. `falloff` règle la douceur des jonctions (grand = plus net).
- **`pieces` : pièces rigides.** À la prise (`capture` passe à vrai), chaque pixel de la silhouette est attribué à l'os le plus proche et une image par pièce est extraite dans la pose de la photo (`<nodes-out>.sprites`, à lire par `sonic-2d sprites="rig.sprites"`). Chaque pièce garde un peu des pixels du voisin autour des jonctions, mais un grand angle finit par ouvrir un jour : réserver ce mode aux articulations nettes (pantin, marionnette) et aux petits mouvements.

**Visage qui vit (`face="true"`).** Les yeux clignent tout seuls (toutes les 2,5 à 5,5 s, parfois deux fois ; `blink="false"` pour les couper) et la bouche s'ouvre à la demande : la peau de la paupière est étirée sur l'œil, la lèvre inférieure et le menton descendent sur une ombre de bouche, retouches fondues sur les bords. Yeux et bouche sont repérés par les points du visage de la pose (`leftEye`, `leftEyeInner`, `leftEyeOuter`, `mouthLeft`, `mouthRight`), tournés comme la tête. `sonic-puppet` devient alors une source d'images : le sprite `mesh` lit `source="#<id du puppet>"` au lieu de la personne découpée. Pilotage par la timeline (mode `nodes`, propriété `y` de 0 à 1) : `<drive-prefix>paupieres` (s'ajoute aux clignements), `<drive-prefix>bouche`. Précision limitée à celle du modèle de pose (quelques pixels sur un visage de loin) : de face, visage assez grand dans l'image.

**Cadrage (`zoom`).** `zoom="auto"` publie `<nodes-out>.camera` (`{x, y, zoom}`) centré sur le corps mesuré, qui remplit alors la vue (zoom de 1 à 2,5, sans sortir de la scène) : le décor se voit moins, la personne plus. Un nombre donne un zoom fixe. `sonic-2d` lit cette caméra s'il a `dataProvider` sur le même DataProvider et pas d'attribut `camera`. `camera-drive="anim.nodes.cam"` ajoute un nœud `{x, y}` d'une timeline (autour du centre de la scène) comme balancement.

Dans les deux modes, à la prise le composant attend que la pose corresponde à l'image figée (`frame`, au plus `timeout-ms`) puis mesure. Pour la photo, `sonic-mask-replace` en `effect="fill"` fournit le fond sans la personne.

**Sorties** (dans `nodes-out`) : `rest`, `bones`, `present` (mode `skin`, voir plus haut) ; `sprites` (mode `pieces`, liste que lit `sonic-2d sprites="rig.sprites"`, image et `pivot` sur l'articulation), `nodes` (format partagé : `x`, `y` de l'articulation en unités de scène, `rz` en radians par rapport au repos, donc 0 sur la photo) et `status` (`{ phase: idle | waiting | ready | error, error, parts, missing, body }` ; `error` : `source`, `pose`, `corps` ou `silhouette`).

**Animation.** `drive` désigne les nœuds d'une `sonic-timeline` : la clé `<drive-prefix><os>` (les `-` du nom d'os deviennent `_` : `d_bras_gauche`) porte `rz` en radians, **ajouté** à la pose de la personne ; un os qui tourne entraîne ses enfants. La clé du bassin (`d_bassin`) peut porter `x`, `y` (unités de scène) pour déplacer tout le corps.

Os : `bassin` (racine, sans image), `torse`, `tete`, `bras-gauche|droit`, `avant-bras-gauche|droit`, `main-gauche|droite`, `cuisse-gauche|droite`, `mollet-gauche|droit`, `pied-gauche|droit` (`gauche` = côté gauche de l'écran, comme `left*` du tracker).

| Attribut | Rôle | Défaut |
|---|---|---|
| `mode` | `skin` (image déformée par poids) ou `pieces` (pièces rigides découpées) | `skin` |
| `zoom`, `camera-drive` | Caméra cadrée sur le corps (`auto` ou un nombre ; vide : rien) et balancement ajouté (nœud `{x, y}` autour du centre) | `""` |
| `face`, `blink` | `face="true"` : yeux qui clignent et bouche pilotée, le composant devient une source d'images ; `blink="false"` coupe les clignements automatiques | `""`, `true` |
| `source` | `#id` de la personne découpée (`sonic-mask-replace effect="cutout"`) à la taille de l'image analysée ; lu pour sa taille en `skin`, découpé en `pieces` | aucun |
| `pose` | DataProvider de la sortie du `sonic-pose-tracker` (`joints`, `present`, `frameSeq`) | aucun |
| `frame` | `#id` de la source figée (`sonic-frame-sync`) : sa `frameSeq` doit égaler celle de la pose avant la mesure | aucun |
| `capture` | Chemin d'un booléen : vrai = mesurer et découper, faux = effacer | aucun |
| `nodes-out` | DataProvider qui reçoit `sprites`, `nodes`, `status` | aucun (rien n'est écrit) |
| `drive`, `drive-prefix` | Nœuds d'animation lus (`<drive>.<prefix><os>.rz`) | aucun |
| `width`, `height` | Taille de la scène : l'image y est centrée, proportions gardées | 800 × 600 |
| `layer` | Calque `sonic-2d` des sprites | calque par défaut |
| `min-visibility` | Visibilité minimale d'une articulation | 0,5 |
| `settle-ms`, `timeout-ms` | Attente minimale / maximale d'une pose alignée sur l'image figée | 350 / 2 500 |

**Armature libre (animal, personnage dessiné, autre).** Sans `armature`, le préréglage personne s'applique. Avec `armature`, les os viennent d'une liste JSON et les points de `pose.joints` (dictionnaire `{x, y, v}` normalisé) peuvent venir de n'importe quelle source : un autre tracker, ou des points posés à la main sur une illustration, publiés dans un DataProvider. La découpe, le recouvrement des jonctions, les sorties et le pilotage sont identiques.

```json
{ "tagName": "sonic-puppet", "attributes": {
  "source": "#chat", "pose": "chat.points", "unit": "nuque,croupe",
  "armature": "[{\"name\":\"corps\",\"from\":\"croupe\",\"to\":\"nuque\",\"radius\":0.3,\"z\":1},{\"name\":\"tete\",\"parent\":\"corps\",\"cap\":\"corps\",\"from\":\"nuque\",\"to\":\"museau\",\"radius\":0.25,\"z\":2}]",
  "nodes-out": "rig", "drive": "anim.nodes", "drive-prefix": "d_" } }
```

| Champ d'un os | Rôle | Défaut |
|---|---|---|
| `name` | Nom de l'os ; clé de pilotage `<drive-prefix><name avec - → _>` | requis |
| `from` | Point d'origine (articulation) | requis |
| `to` | Point d'extrémité, ou paire de points (milieu) ; absent = articulation sans image | aucun |
| `extend` | Prolonge le segment au-delà de `to` (1 = tel quel) | 1 |
| `parent` | Os parent (déclaré avant lui) ; absent = racine | racine |
| `cap` | Os voisin dont on recouvre la jonction | aucun |
| `radius` | Demi-largeur de la capsule d'appartenance, en `unit` | 0,15 |
| `z` | Ordre de dessin (plus grand = devant) | 0 |
| `sprite` | `false` : pas d'image | vrai si `to` est donné |

`unit` est requis avec `armature` : `"pointA,pointB"` (leur distance) ou un nombre de pixels. Un os dont un point manque (ou peu visible), ou dont le parent manque, n'existe pas ; `status.error` vaut `armature` si le JSON est invalide (64 os au plus) et `corps` si l'unité n'est pas mesurable. Quand les pièces sont déjà dessinées (personnage généré), inutile de découper : un `sonic-skeleton` avec ses `sonic-bone` suffit.

Limites : en mode `pieces`, une partie cachée derrière le corps (bras croisé devant le tronc) n'a pas de fond propre ; le recouvrement n'invente pas ce qui était caché. Vue de face de préférence.

## Hors périmètre (v1)

Ressorts et physique, `flip` / `draw-path` / `pulse`, transitions de vues (View Transitions), animation de la mise en page, synchronisation de l'horloge interne par p2p (le pilotage p2p passe par `time-source`).

## Mode `nodes` : animer une scène (`sonic-stage`, `sonic-3d`)

`nodes-out="anim"` : la timeline n'écrit plus dans le DOM, elle publie l'état de ses cibles dans `anim.nodes`, au format partagé (`x`, `y`, `scale`, `opacity` ; `rotate` en degrés devient `rz` en radians ; `blur`, variables CSS et texte sont ignorés). Les cibles sont des **noms de nœuds** : `id` d'un élément de `sonic-stage dataProvider="anim"`, ou nœud glTF de `sonic-3d dataProvider="anim"`. `children:` et `group:` n'existent pas dans ce mode. Un seul écrivain par DataProvider : la timeline possède `anim.nodes`.
