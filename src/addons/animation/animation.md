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

## Hors périmètre (v1)

Ressorts et physique, `flip` / `draw-path` / `pulse`, transitions de vues (View Transitions), animation de la mise en page, synchronisation de l'horloge interne par p2p (le pilotage p2p passe par `time-source`).

## Mode `nodes` : animer une scène (`sonic-stage`, `sonic-3d`)

`nodes-out="anim"` : la timeline n'écrit plus dans le DOM, elle publie l'état de ses cibles dans `anim.nodes`, au format partagé (`x`, `y`, `scale`, `opacity` ; `rotate` en degrés devient `rz` en radians ; `blur`, variables CSS et texte sont ignorés). Les cibles sont des **noms de nœuds** : `id` d'un élément de `sonic-stage dataProvider="anim"`, ou nœud glTF de `sonic-3d dataProvider="anim"`. `children:` et `group:` n'existent pas dans ce mode. Un seul écrivain par DataProvider : la timeline possède `anim.nodes`.
