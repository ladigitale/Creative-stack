# sonic-procgen

Générateur procédural **3D** dont la 2D n'est qu'une manière de regarder : un même monde (sol, routes, bâtiments, végétation, objets, personnages animés) se voit de profil comme un jeu de plateforme, en isométrique, en cavalière, de dessus ou en perspective libre. Tout passe par un DataProvider : aucun JS dans l'artefact. Le cahier des charges (architecture, décisions de revue, feuille de route) est dans `SPEC.md`.

## Le plus court

```json
{ "tagName": "sonic-procgen", "attributes": { "dataProvider": "monde", "scene": "village", "style": "height:420px" } }
```

## Clés lues dans `dataProvider`

| Clé | Rôle |
|---|---|
| `scene` | Scène de la bibliothèque : `village`, `rue`, `port`, `foret`, `bivouac`, `personnages`, `marche`, `montagne`, `vapeur`, `neon`, `blasons`, `jardin` |
| `recipe` | Recette complète (prioritaire sur `scene`, voir plus bas) |
| `seed` | Graine. Même graine = même monde ; chaque objet a sa sous-graine, donc modifier un objet ne bouge pas les autres |
| `params` | Paramètres exposés par la recette (ex. `village` : `maisons`, `habitants`) |
| `style` | Préréglage (`gouache`, `doux`, `encre`, `bd`, `pixel`, `lowpoly`, `brume`, `nuit`, `neon`, `crepuscule`, `automne`, `printemps`, `desert`, `neige`, `papier`, `abysses`, `aquarelle`) ou jetons (voir Styles) |
| `view` | `{camera, yaw, pitch, zoom, cx, cy, cz, actor}` ; `camera` : `side`, `front`, `iso`, `oblique`, `top`, `perspective`, `follow` (suit `actor`) |
| `anim` | `{play, speed}` |
| `actors` | Intentions par acteur (voir Jeu) |
| `select` | Id d'objet à surligner (`maisons.3`) |
| `edit` | `{id: "maisons.3", params: {floors: 4}}` ou `{layer: "maisons", params: {...}}` : modifie sans réécrire la recette |
| `hidden` | Ids cachés (objet ramassé, personnage parti) |
| `anchors` | Ancres à suivre à l'écran : `["heros@head.top", "maisons.2@door"]` |

## Clés écrites dans `state-out` (défaut `<dataProvider>State`)

Le composant **n'écrit jamais** dans `dataProvider` : un `sonic-store` qui le publie ne peut donc rien effacer.

| Clé | Contenu |
|---|---|
| `status` | `{phase: idle\|composing\|ready\|error, progress, error, ms, objects, actors, triangles, drawCalls, fps, scale, issues}` |
| `selection` | `{id, generator, layer, params, x, y, z}` de l'objet touché |
| `ids` | Liste des objets placés `{id, generator, layer}` : ce qui existe et peut être visé |
| `actors` | Position, cap, vitesse, action de chaque acteur (5 fois par seconde au plus) |
| `anchors` / `nodes` | Positions écran des ancres demandées ; `nodes` est au format de `sonic-stage` (bulles de dialogue en HTML par-dessus la scène) |
| `view` | Vue courante (après pan / zoom de l'utilisateur) |

`issues` : `{path, code: unknown|clamped|type|expr|missing|limit|info, message, got, used, hint, didYouMean}`. Une erreur n'arrête jamais le rendu : la scène s'affiche avec ce qui est valide.

## Jeu

Événements envoyés au store `target` (`type` préfixé par `action-prefix` s'il est donné) :

| Type | Charge utile |
|---|---|
| `pick` | `{objectId, generator, layer, x, y, z, actor, zone}` : position au sol comprise (point-and-click) |
| `select` | `{objectId, generator, layer, params}` |
| `arrive` | `{actor, x, z, target}` : l'acteur est arrivé |
| `blocked` | `{actor, reason: no-path\|wall}` |
| `enter` / `leave` | `{zone, actor}` |
| `actionEnd` | `{actor, action}` (après `wave`, `cheer`, `jump`, `bow`, `point`) |

Intentions d'acteur (`actors.<id>`), écrites par le reducer, **jamais à chaque image** (le composant interpole) :

- `{x, z}` ou `{target: "maisons.2"}` (ancre `door` par défaut, ou `"maisons.2.door"`) : marche jusque-là par la grille de navigation, contourne les bâtiments, puis `arrive` ; `run: true` pour courir, `speed` en m/s ;
- `{vx, vz}` : déplacement direct (manette à 30 Hz), sans chemin ;
- `{action}` : `idle`, `walk`, `run`, `wave`, `point`, `cheer`, `talk`, `carry`, `sit`, `jump`, `think`, `bow` ; `{mood}` : `neutral`, `happy`, `sad`, `angry`, `surprised`, `sleepy` ; `{facing}` (°).

Exemple de reducer (voir `examples/village-vivant.sdui.json`) : sur `pick`, écrire `actors.heros = {x, z}` ; sur `arrive`, passer à la suite du dialogue.

## Recette

```json
{
  "params": { "maisons": { "default": 6, "min": 0, "max": 14 } },
  "size": [60, 40],
  "ground": { "relief": 0.8, "scale": 20, "water": -0.5, "coast": "south", "surface": "grass" },
  "paths": [{ "id": "rue", "points": [[-30, 0], [30, 2]], "width": 5, "kind": "street", "sidewalk": 2 }],
  "layers": [
    { "id": "maisons", "gen": "building", "count": "= maisons", "place": { "along": "rue", "side": "right", "spacing": 10 },
      "params": { "style": "= pick('bourg', 'colombages')", "floors": "= randint(1, 3)" } },
    { "id": "arbres", "gen": "tree", "count": 20, "place": { "poisson": true, "minDist": 4 }, "params": { "species": "oak", "height": "= rand(5, 8)" } },
    { "id": "lampes", "gen": "prop.lamp", "count": 6, "place": { "along": "rue", "side": "left", "spacing": 10, "offset": -1.5 } }
  ],
  "zones": [{ "id": "porte", "at": "maisons.2.door", "r": 1.2 }],
  "actors": { "heros": { "params": { "archetype": "cartoon", "hat": "straw" }, "at": [0, 3] } },
  "view": { "camera": "iso", "yaw": 30 },
  "style": "gouache"
}
```

- **Unités : mètres.** Un personnage adulte mesure 1,7 m, une maison 3 m par étage.
- Un nombre peut être une **expression** `"= …"` : `+ - * / % ^`, comparaisons, `cond ? a : b`, `min max clamp mix abs floor round sqrt pow sin cos`, `rand(a, b)`, `randint(a, b)`, `pick(…)`, `chance(p)`, `noise(x, y)`. Variables : paramètres de la recette, et dans une couche `i` (rang), `n`, `t` (0…1), `x`, `z`. Aucun code n'est exécuté.
- `ground` : `relief`, `scale` (taille des collines, m), `mountains`, `water` (niveau), `coast` (`north|south|east|west`, avec `coastAt`, `coastDepth`), `surface` (`grass|sand|snow|dirt|paved|seabed`) ; `false` : pas de sol.
- `paths[].kind` : `street` (chaussée, trottoirs, bordures), `road`, `path` (terre battue, chemin usé), `river`, `plaza`.
- Placement (`place`) : `at` (points ou `{x, z, yaw}`), `grid` (`[nx, nz]`, `spacing`), `poisson` (`true` ou boîte `[x0, z0, x1, z1]`, `minDist`), `along` (route, `side` `left|right|both|center`, `spacing`, `offset`, `jitter`, `start`, `end`), `cluster` (centre, `radius`), `ring` (centre, `radius`, `jitter`), `edges` (`buildings|paths|all` : touffes au pied des murs et en bord de route).
- Options de couche : `yaw` (`path`, `random`, `center`, `away` ou degrés), `scale`, `spacing`, `onPath`, `onWater` (bateaux), `walkable`, `behavior` (`idle|wander|patrol`, personnages), `action`.
- Les ids sont `<couche>.<rang>` et ne changent pas quand on modifie un autre objet.

## Générateurs

| `gen` | Paramètres principaux |
|---|---|
| `character` | `height` (m), `archetype` (`chibi` 2,6 têtes, `cartoon` 4,5, `stylized` 6, `heroic` 7,2), `age` (`child|teen|adult|elder`), `build`, `shape`, `headSize`, `belly`, `skin` (`porcelain…ebony`, `green`, `blue`, `#rrggbb`), `hair` (`none|crop|short|bob|long|ponytail|bun|curly|mohawk`), `hairColor`, `top` (`none|tee|long|tank|sweater|coat|robe`), `bottom` (`trousers|shorts|skirt|longskirt`), `shoes`, `hat` (`none|cap|beret|tophat|wizard|straw|helmet|crown`), `bag` (`none|backpack|satchel|cape|scarf`), `item` (main droite : `staff|sword|lantern|book|umbrella|torch|flower|mug`), `mood`, `outfit` (garde-robe : `earth|sea|forest|royal|work|autumn|slate|rose|sand|ink`), `colors` `{top, bottom, detail, leather, hat}`, `detail` |
| `tree` | `species` (`oak|birch|pine|fir|palm|willow|dead|fruit`), `height`, `density`, `season`, `variant` |
| `bush`, `grass`, `flowers` | `size`, `flowers`, `blades`, `count` |
| `rock` | `size`, `pieces`, `sharpness`, `flat`, `moss` |
| `building` | `style` (`bourg|colombages|vapeur|moderne|neon|chaumiere|pierre`), `floors`, `bays`, `depth`, `roof` (`gable|hip|flat|mansard`), `shop`, `balconies`, `shutters`, `decay`, `chimneys` |
| `prop` / `prop.<kind>` | `lamp`, `bench`, `crate`, `barrel`, `well`, `campfire`, `tent`, `cart`, `stall`, `signpost`, `lantern`, `fence`, `haystack`, `bollard`, `planter`, `statue`, `mailbox`, `boat` ; `size` |
| `emblem` | `shape` (`heater|round|kite|banner|square`), `division` (`plain|per-pale|per-fess|per-bend|quarterly|chief`), `charge` (`star|circle|cross|chevron|tower|tree|crescent`), `field`, `tincture`, `metal` (rôles de couleur), `size` |

Ancres : personnages `head.top`, `head.center`, `hand.r.grip`, `hand.l.grip`, `back`, `chest.front`, `hip.l`, `hip.r`, `feet` ; bâtiments `door`, `roof` ; lampes et feux `light`.

## Styles

Jetons (tous facultatifs, par-dessus `preset`) : `palette` (`gouache`, `brume`, `automne`, `printemps`, `desert`, `neige`, `crepuscule`, `nuit`, `neon`, `papier`, `abysses`), `hue` (°), `chroma`, `contrast`, `shading` (`flat|toon|soft|lit`), `bands` (2–4), `bandSoftness`, `brush`, `outline` (px), `outlineStrength`, `lightAzimuth`, `lightElevation`, `lightIntensity`, `shadows`, `shadowStrength`, `ao`, `texture`, `fog`, `fogHeight`, `night`, `lamps`, `rim`, `grain`, `paper`, `vignette`, `pixel` (taille du pixel), `saturation`, `sky`, `roles` (`{"wall": "#e8d8c0"}`).

Rôles de couleur : `ground grass path road stone wall trim roof wood bark leaf leaf2 flower water metal glass lamp cloth1 cloth2 cloth3 leather skin hair eye eyeWhite mouth accent ink paper snow fire`. La peau, les yeux et la bouche gardent la couleur du personnage quel que soit le thème.

## Fluidité

La composition se fait par tranches (la page reste fluide ; `status.phase = composing`, `status.progress`). Bâtiments fusionnés par tuile, objets répétés instanciés, personnages en un seul maillage chacun. Rendu à la demande, densité de pixels adaptée à la charge, arrêt hors écran, `prefers-reduced-motion` respecté (animation en pause). Une scène de village (≈ 230 objets, 6 personnages) tient en une cinquantaine d'appels de dessin.

## CSP

Pas d'`eval`, pas de `new Function`, pas de worker. Les recettes et expressions sont analysées par procgen lui-même.
