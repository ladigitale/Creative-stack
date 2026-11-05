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

Une hiérarchie d'**os rigides** (marionnette articulée, bras mécanique, plante, chaîne de pendules) qui **écrit des `nodes`** : le format partagé que lisent `sonic-2d` (sprites), `sonic-3d` (nœuds glTF) et `sonic-stage` (éléments HTML / SVG). Un élément de même nom que l'os le suit : le squelette ne dessine rien. À l'écriture, `<nodes-out>.nodes` reçoit un nœud par os (`x`, `y` de l'articulation, `rz` en radians par rapport au repos), `<nodes-out>.bones` l'état des os (`x`, `y`, `x2`, `y2` de l'extrémité, `angle`, `rz`, `length`) et `<nodes-out>.present`.

**Conventions.** Angles en **degrés** : `0` = l'os pointe vers le bas, positif = sens horaire à l'écran (bas, gauche, haut, droite). `angle` est l'angle de **repos**, relatif au parent. Au repos tous les `rz` valent 0 : on dessine donc chaque élément **dans la pose de repos**, avec son `pivot` (sprite de `sonic-2d`) sur l'articulation ; il suit ensuite l'os sans autre calcul. Pour un bras pendant : `pivot="0.5,0"` (haut du sprite = épaule).

### `sonic-skeleton`

| Attribut | Rôle | Défaut |
|---|---|---|
| `nodes-out` | DataProvider qui reçoit `nodes`, `bones`, `present` ; c'est celui que lit `sonic-2d dataProvider` | aucun (rien n'est écrit) |
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
| `angle-scale`, `angle-offset` | Facteur et décalage appliqués à `angle-from` (`valeur × scale + offset`) | `1`, `0` |
| `attach` | Autres noms de nœuds alimentés par cet os (séparés par des espaces ou des virgules) | aucun |

`aim` l'emporte sur `angle-from`. Une articulation absente ou sous `min-visibility` rend `aim` indisponible : l'os garde sa dernière direction `hold-ms`, puis revient au repos. Les noms d'articulations sont ceux de `sonic-pose-tracker` (`left*` = côté gauche de l'écran).

**Preset `humain`** (corps de face d'environ 300 unités, tête en haut ; dessiner bras et jambes pendants) : `bassin` (racine, milieu des hanches), `torse`, `tete`, `bras-gauche`, `avant-bras-gauche`, `main-gauche`, `bras-droit`, `avant-bras-droit`, `main-droite`, `cuisse-gauche`, `mollet-gauche`, `cuisse-droite`, `mollet-droit`. Voir `examples/marionnette.sdui.json`.

**Sans caméra** : `angle-from` suffit (un `sonic-store` piloté par des curseurs, un `sonic-clock`, un analyseur audio) pour un bras articulé ou une chaîne de pendules.

Limites : os **rigides** (une image qui se plie entre deux os demande un maillage déformable, hors de cette version) ; cinématique directe seulement (pas de cinématique inverse : on donne les directions, pas la position d'un bout) ; pose de face (un os de longueur fixe ne se raccourcit pas quand le segment se tourne vers la caméra) ; un seul sujet.

## Hors périmètre (v1)

Ressorts et physique, `flip` / `draw-path` / `pulse`, transitions de vues (View Transitions), animation de la mise en page, synchronisation de l'horloge interne par p2p (le pilotage p2p passe par `time-source`).

## Mode `nodes` : animer une scène (`sonic-stage`, `sonic-3d`)

`nodes-out="anim"` : la timeline n'écrit plus dans le DOM, elle publie l'état de ses cibles dans `anim.nodes`, au format partagé (`x`, `y`, `scale`, `opacity` ; `rotate` en degrés devient `rz` en radians ; `blur`, variables CSS et texte sont ignorés). Les cibles sont des **noms de nœuds** : `id` d'un élément de `sonic-stage dataProvider="anim"`, ou nœud glTF de `sonic-3d dataProvider="anim"`. `children:` et `group:` n'existent pas dans ce mode. Un seul écrivain par DataProvider : la timeline possède `anim.nodes`.
