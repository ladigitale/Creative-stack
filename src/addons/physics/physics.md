# Physique 2D (SDUI)

Addon `@supersoniks/creative-stack/physics` : un monde physique 2D (planck.js, portage de Box2D) entièrement décrit en SDUI. Les corps sont des balises ou une liste dans un DataProvider ; on les pilote par DataProvider ; les chocs, capteurs et sorties de l'écran arrivent dans un `sonic-store`. Le monde se dessine sur un canvas, qui sert aussi d'image à `sonic-shader channel0="#id"`. Aucun JS.

## Le plus court

```json
{ "tagName": "sonic-physics", "attributes": { "id": "world", "width": "800", "height": "450", "store": "game", "drag": "" }, "nodes": [
  { "tagName": "sonic-body", "attributes": { "name": "ball", "shape": "circle", "r": "16", "x": "200", "y": "60", "restitution": "0.6", "tags": "ball" } },
  { "tagName": "sonic-body", "attributes": { "name": "ramp", "type": "static", "shape": "polygon", "points": "-200,0 200,-80 200,0", "x": "500", "y": "440" } }
] }
```

La balle tombe, rebondit, roule sur la rampe ; `drag` permet de la lancer à la souris ou au doigt ; chaque choc envoie `{ type: "collide", payload: { a, b, tagsA, tagsB, impulse, x, y } }` au store `game`.

## Unités

- Positions et tailles en **pixels de la scène** (`width` × `height`, 800 × 450 par défaut), y vers le bas, origine en haut à gauche. Le canvas s'adapte à la largeur de l'élément.
- `scale` : pixels par mètre (50). Box2D est stable pour des objets de 0,1 à 10 m : à 50 px/m, de 5 à 500 px.
- `gravity` en m/s² : `"0 9.8"` (défaut), `"0 0"` pour une vue de dessus (billard, casse-briques).
- Vitesses en px/s, angles en degrés, impulsions et forces en unités « px » (converties par `scale`).

## `sonic-physics`

| Attribut | Rôle |
|---|---|
| `width` `height` `scale` `gravity` | Monde (voir Unités) |
| `bounds` | `walls` (défaut : 4 murs), `box` (sans sol : un corps peut sortir par le bas), `floor`, `none`. Les murs s'appellent `wall-left`, `wall-right`, `wall-top`, `wall-bottom` (tag `wall`) |
| `bodies` | DP contenant une **liste de corps** (mêmes clés que les attributs de `sonic-body`) : le monde suit ses ajouts et retraits ; un corps inchangé garde sa position |
| `input` | DP de pilotage par corps (voir plus bas) |
| `control` | DP `{ running, reset: compteur, gravity: [x, y], timeScale }` |
| `store`, `action-prefix` | Store qui reçoit les événements (types préfixés si besoin) |
| `collide-min` | Impulsion minimale d'un choc signalé (0 : tous) |
| `drag` | Glisser les corps dynamiques (souris, doigt) |
| `paused`, `time-scale` | Pause, ralenti / accéléré |
| `publish`, `rate` | Corps publiés dans l'état (noms ; défaut : tous), publications par seconde (30) |
| `background`, `debug`, `hidden-preview` | Fond du canvas ; capteurs et joints visibles ; monde invisible (seulement source d'images) |

Simulation à pas fixe (1/60 s), suspendue quand l'onglet est caché.

**État** (`<id>State`) : `{ status: running | paused | error, running, time, steps, collisions, count, dragging, bodies: { nom: { x, y, angle, vx, vy, awake } }, errors }`.

## `sonic-body`

| Attribut | Rôle |
|---|---|
| `name` | Nom (événements, pilotage, état) |
| `type` | `dynamic` (défaut), `static`, `kinematic` (bouge seulement par sa vitesse : raquette, plateforme) |
| `shape` | `circle` (`r`), `box` (`w` `h`, défaut), `polygon` (3 à 8 `points` convexes), `edge` (2 points), `chain` (points, `loop`) |
| `points` | `"x,y x,y …"` relatifs au centre |
| `x` `y` `angle` `vx` `vy` `spin` | Position, angle (°), vitesse de départ (px/s, °/s) |
| `density` `friction` `restitution` | Matière (1, 0.3, 0) ; `restitution="1"` : rebond parfait |
| `sensor` | Ne bloque rien, signale `enter` / `leave` (zone d'arrivée, piège) |
| `bullet` | Objets rapides (pas de traversée) |
| `fixed-rotation`, `damping`, `angular-damping`, `gravity-scale` | Comportement |
| `group`, `collides` | Filtres : `group="player"` et `collides="wall enemy"` (`all` défaut, `none`, `default` = sans groupe) |
| `tags` | Mots repris dans les événements (`"brick row2"`) |
| `clamp-x`, `clamp-y` | `"min max"` : bornes de position (raquette entre deux murs) |
| `fill` `stroke` `line` `label` `hidden` | Rendu intégré |

## `sonic-joint`

`a`, `b` : noms de corps (`ground` : le décor fixe). `at="x y"` : point d'ancrage (défaut : centre de `a`).

| `type` | Rôle | Attributs |
|---|---|---|
| `revolute` | Pivot (roue, porte, flipper) | `motor` (°/s), `max-torque`, `lower` / `upper` (°) |
| `distance` | Barre ou ressort | `to="x y"`, `length`, `frequency` (Hz, 0 = rigide), `damping` |
| `rope` | Corde (longueur max) | `length` |
| `weld` | Soudure | `frequency`, `damping` |
| `prismatic` | Glissière | `axis="1 0"`, `lower` / `upper` (px), `motor` (px/s) |

`collide` : les deux corps reliés se cognent quand même.

## Piloter (`input`)

```json
{ "paddle": { "vx": -650 }, "ship": { "fx": 0, "fy": -20, "spin": 90 },
  "ball": { "impulse": { "n": 3, "x": 10, "y": -34 }, "set": { "n": 1, "x": 400, "y": 396 } } }
```

- `vx` / `vy` : vitesse imposée à chaque pas ; `fx` / `fy` : force continue ; `spin` (°/s), `torque`.
- `impulse` et `set` sont des **compteurs** : rien au chargement, chaque hausse de `n` donne une impulsion ou replace le corps (position, vitesse, angle).
- Le reducer écrit ces valeurs à partir du clavier (`sonic-keyboard keyup` : `left` / `left:up`), d'une manette (`sonic-controller analog-action="stick"`), d'un bouton…

## Événements vers le store

| `type` | `payload` |
|---|---|
| `collide` | `{ a, b, tagsA, tagsB, impulse, x, y }` (impulsion du choc, point de contact) |
| `enter`, `leave` | `{ sensor, body, tags }` |
| `out` | `{ body, tags, side }` : un corps quitte la scène (balle perdue) |
| `tap` | `{ x, y, body }` : clic / toucher dans le monde |

Reducer type (casse-briques) : retirer la brique touchée de la liste `bodies`, compter les points, jouer une note.

```jsonata
$action.type = "collide" and "brick" in $action.payload.tagsB
  ? $merge([$state, {"bricks": [$state.bricks[name != $action.payload.b]], "score": $state.score + 10}])
  : $state
```

Le reducer doit répondre vite (chocs en rafale) : `budget-ms="50"` sur le store pour une liste de quelques dizaines de corps.

## Avec les autres addons

- **Shader** : `sonic-shader channel0="#world"` lit l'image du monde (lueur, distorsion, fond réactif) ; `hidden-preview` si le shader est le seul affichage.
- **Son** : un choc → le reducer incrémente un compteur `play` de `sonic-sound`, ou écrit une note pour un `sonic-patch`.
- **Manette** : `sonic-controller` (addon `controller`) pour les sticks analogiques et la vibration.

## Démo

`examples/casse-briques.sdui.json` : briques en liste dans le store, raquette cinématique bornée, balle `bullet` à rebond parfait ; clavier, manette (stick, A, vibration) ou toucher ; une note par rangée ; fond `sonic-shader` qui fait briller l'image du monde.
