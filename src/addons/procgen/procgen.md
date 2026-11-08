# sonic-procgen

Générateur procédural **3D** dont la 2D n'est qu'une manière de regarder : un même monde (sol, routes, bâtiments, végétation, objets, personnages animés) se voit de profil comme un jeu de plateforme, en isométrique, en cavalière, de dessus ou en perspective libre. Tout passe par un DataProvider : aucun JS dans l'artefact. Le cahier des charges (architecture, décisions de revue, feuille de route) est dans `SPEC.md`.

## Le plus court

```json
{ "tagName": "sonic-procgen", "attributes": { "dataProvider": "monde", "scene": "village", "style": "height:420px" } }
```

## Clés lues dans `dataProvider`

| Clé | Rôle |
|---|---|
| `scene` | Scène de la bibliothèque : `village`, `rue`, `port`, `foret`, `bivouac`, `personnages`, `marche`, `montagne`, `vapeur`, `neon`, `blasons`, `jardin`, `ferme`, `bord-de-mer`, `aire-de-jeux`, `place-medievale`, `jardin-japonais` |
| `render` | `3d` (défaut) ou `vector` (illustration vectorielle 2D, voir plus bas) |
| `exportSvg` | Compteur : chaque changement publie le SVG de la vue dans `state-out.svg` (mode vectoriel) |
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
- `{target: "bancs.1.sit.0", action: "sit"}` : marche jusqu'à la place (ancre `approach.0`, devant l'assise), s'assied sur `sit.0` face à l'avant, le bassin à hauteur d'assise (chaise, tabouret de bar, rondin, balançoire…), puis `arrive` ;
- `{vx, vz}` : déplacement direct (manette à 30 Hz), sans chemin ;
- `{action}` : `idle`, `walk`, `run`, `wave`, `point`, `cheer`, `talk`, `carry`, `sit`, `jump`, `think`, `bow`, `hammer` (frapper), `sweep` (balayer, ratisser), `dig` (bêcher) ; `{mood}` : `neutral`, `happy`, `sad`, `angry`, `surprised`, `sleepy` ; `{facing}` (°).

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
- Placement (`place`) : `at` (points ou `{x, z, yaw}` : un `yaw` donné est respecté), `grid` (`[nx, nz]`, `spacing`), `poisson` (`true` ou boîte `[x0, z0, x1, z1]`, `minDist`), `along` (route, `side` `left|right|both|center`, `spacing`, `offset`, `jitter`, `start`, `end`), `cluster` (centre, `radius`), `ring` (centre, `radius`, `jitter`), `edges` (`buildings|paths|all` : touffes au pied des murs et en bord de route).
- Options de couche : `yaw` (`path`, `random`, `center`, `away` ou degrés), `scale`, `spacing`, `onPath`, `onWater` (bateaux), `walkable`, `behavior` (`idle|wander|patrol`, personnages), `action`.
- Les ids sont `<couche>.<rang>` et ne changent pas quand on modifie un autre objet.

## Générateurs

Table générée depuis les schémas (`generatorCatalog()`). Raccourcis : `prop.lamp`, `animal.horse`, `tree.oak`, `plant.fern`, `vehicle.sailboat`, `ball.soccer`, `seat.parkbench`, `tool.rake`…

| `gen` | Description et paramètres (`auto` = tiré de la graine) |
|---|---|
| `character` | Humanoïde skinné (quaternions duaux) : proportions par archétype et silhouette variée, tête et mains fines (4 doigts + pouce, prise refermée sur l'objet), visage paramétrique (yeux, iris, sourcils, nez, lèvres, oreilles, barbe, moustache, lunettes, rides, taches de rousseur), garde-robe en couches (cols, gilets, vestes, tablier, salopette, robe, plastron, ceinture, boutons, poches, gants, bottes, motifs), 16 coiffures, 15 couvre-chefs, rôles sociaux qui biaisent les tirages. Bords de couleur nets. Animé par la scène. Paramètres : `role` (auto\|villager\|merchant\|guard\|noble\|sailor\|farmer\|wizard\|worker\|child\|traveler\|scholar\|cook), `figure` (auto\|feminine\|masculine\|androgynous), `height`, `archetype` (chibi\|cartoon\|stylized\|heroic), `age` (auto\|child\|teen\|adult\|elder), `build`, `shape`, `headSize`, `belly`, `body`, `variation`, `skin`, `hair` (auto\|none\|shaved\|crop\|short\|sidepart\|bob\|wavy\|long\|ponytail\|lowtail\|bun\|topknot\|pigtails\|braids\|curly\|afro\|mohawk), `hairColor`, `headShape` (auto\|round\|oval\|square\|long), `eyes` (auto\|round\|almond\|narrow\|sleepy\|big), `eyeColor`, `brows` (auto\|none\|thin\|straight\|arched\|thick\|bushy), `nose` (auto\|button\|long\|aquiline\|wide\|upturned), `lips` (auto\|thin\|medium\|full), `ears` (auto\|small\|round\|large\|pointed), `beard` (auto\|none\|stubble\|short\|full\|goatee\|long\|chinstrap), `mustache` (auto\|none\|thin\|pencil\|walrus\|handlebar), `glasses` (auto\|none\|round\|square\|half), `freckles` (auto\|none\|light\|strong), `blush` (auto\|none\|light\|strong), `wrinkles` (auto\|none\|light\|strong), `top` (auto\|none\|tee\|long\|tank\|sweater\|shirt\|tunic\|coat\|robe\|dress), `bottom` (auto\|trousers\|shorts\|skirt\|longskirt\|overalls), `over` (auto\|none\|vest\|jacket\|apron\|armor), `collar` (auto\|none\|round\|shirt\|turtle), `belt` (auto\|none\|belt\|sash), `details` (auto\|none\|buttons\|pockets\|full), `gloves` (auto\|none\|gloves), `pattern` (auto\|plain\|stripes\|vstripes\|checks), `shoes` (auto\|shoes\|boots\|tallboots\|sandals\|barefoot), `hat` (auto\|none\|cap\|beret\|tophat\|wizard\|straw\|helmet\|crown\|beanie\|bandana\|turban\|cowboy\|flowers\|tricorn\|toque\|hood), `bag` (auto\|none\|backpack\|satchel\|cape\|scarf\|pouch), `item` (auto\|none\|staff\|sword\|lantern\|book\|umbrella\|torch\|flower\|mug\|spear\|hammer\|pitchfork\|wand\|tool.hammer\|tool.mallet\|tool.sledgehammer\|tool.axe\|tool.pickaxe\|tool.shovel\|tool.spade\|tool.rake\|tool.leafrake\|tool.hoe\|tool.pitchfork\|tool.broom\|tool.besom\|tool.mop\|tool.scythe\|tool.saw\|tool.trowel\|tool.wrench\|tool.screwdriver\|tool.paintbrush\|tool.paintroller\|tool.crowbar\|tool.fishingrod\|tool.machete), `mood` (neutral\|happy\|sad\|angry\|surprised\|sleepy), `outfit`, `colors`, `detail` (auto\|high\|crowd) |
| `animal` | Quadrupèdes et oiseaux d'une seule peau, skinnés (quaternions duaux) : 13 espèces, robes par graine (uni, tacheté, pie, rayé), cornes, bois, crinière, laine, yeux avec clignement. Animés par la scène (repos, marche, trot, galop, hochement des oiseaux). Paramètres : `species` (dog\|cat\|horse\|cow\|sheep\|pig\|fox\|rabbit\|deer\|goat\|bear\|duck\|chicken), `size`, `build`, `coat` (auto\|solid\|spotted\|pie\|striped), `palette`, `variant`, `mood` (calm\|alert\|happy\|tired\|grazing), `colors`, `detail` (auto\|high\|crowd) |
| `tree` | Arbre ramifié (tronc et branches soudés, canopée en grappes ajourées à contour dentelé, branches visibles entre les masses). Espèces : oak (chêne), beech (hêtre), maple (érable), birch (bouleau), willow (saule), poplar (peuplier), cypress (cyprès), stonepine (pin parasol), olive (olivier), cherry (cerisier en fleurs), fruit (fruitier), pine, fir (sapin), palm (palmier), dead (arbre mort). Saisons : spring, summer, autumn (teintes mêlées), winter (branches nues, neige sur les conifères). Paramètres : `species` (oak\|beech\|maple\|birch\|willow\|poplar\|cypress\|stonepine\|olive\|cherry\|fruit\|pine\|fir\|palm\|dead), `height`, `density`, `season` (spring\|summer\|autumn\|winter), `variant` |
| `bush` | Buisson en masses implicites, fleuri ou non, ou arbuste taillé : shape = round (libre), ball (boule), cone (topiaire), box (cube de buis), cloud (nuages taillés à la japonaise), spiral (topiaire en spirale). Paramètres : `size`, `flowers`, `shape` (round\|ball\|cone\|box\|cloud\|spiral), `variant` |
| `grass` | Touffe de brins (lames effilées), souple au vent. À semer en nombre aux raccords (pied des murs, bords de route). Paramètres : `size`, `blades`, `flowers`, `variant` |
| `flowers` | Parterre de fleurs sur tiges, souples. kind = mixed, round (pompons), daisy (marguerites), tulip (tulipes), spike (épis : lupins, lavande), bell (clochettes). Paramètres : `size`, `count`, `kind` (mixed\|round\|daisy\|tulip\|spike\|bell) |
| `rock` | Minéral : kind = boulder (rocher taillé par plans, en groupe, enfoui), pebbles (galets roulés), cliff (falaise à strates), slab (dalle plate), steps (pas japonais en file), scree (éboulis). Paramètres : `kind` (boulder\|pebbles\|cliff\|slab\|steps\|scree), `size`, `pieces`, `sharpness`, `flat`, `moss`, `variant` |
| `plant` | Plantes et débris naturels instanciables : fern (fougère), tallgrass (herbes hautes à épis), reeds (roseaux et massettes, bord d'eau), waterlily (nénuphars, onWater), mushrooms (champignons), stump (souche), log (tronc couché moussu), cactus, bamboo (bosquet de bambous), ivy (lierre plaqué contre un mur en −z ; placement edges + yaw path), lavender (touffe de lavande). Paramètres : `species` (fern\|tallgrass\|reeds\|waterlily\|mushrooms\|stump\|log\|cactus\|bamboo\|ivy\|lavender), `size`, `variant` |
| `building` | Maison ou édifice par grammaire de découpe : corps, ailes, appentis, tourelles, porches, perrons ; fenêtres (rectangulaires, plein cintre, segmentaires, à meneaux, ogives, œils-de-bœuf), volets pleins ou persiennes, petits bois, jardinières, balcons en ferronnerie, corniches à modillons, gouttières ; toits à deux pans (coyaux), pignon sur rue, croupe, mansarde, monopente, terrasse, pavillon. Matériaux : enduit, pierre appareillée, brique, bardage, colombages ; tuile, ardoise, chaume, zinc, lauze. Styles : bourg, colombages, vapeur, moderne, neon, chaumiere, pierre, ferme, chalet, mediterraneen, japonais, chateau, tour, moulin, chapelle, phare, boutique. Chaque graine donne une maison distincte. Paramètres : `style` (bourg\|colombages\|vapeur\|moderne\|neon\|chaumiere\|pierre\|ferme\|chalet\|mediterraneen\|japonais\|chateau\|tour\|moulin\|chapelle\|phare\|boutique), `floors`, `bays`, `depth`, `roof` (auto\|gable\|pignon\|hip\|mansard\|flat\|shed), `walls` (auto\|enduit\|pierre\|brique\|bardage\|colombages), `roofing` (auto\|tuile\|ardoise\|chaume\|zinc\|lauze), `shop`, `balconies`, `shutters`, `ornament`, `annexes`, `decay`, `chimneys` |
| `prop` | Objet de décor instanciable : lamp, bench, crate, barrel, well, campfire, tent, cart, stall, signpost, lantern, fence, haystack, bollard, planter, statue, mailbox, boat, fountain, kiosk, busstop, billboard, pillar, bin, lamp2, clock, hydrant, awningstall, baskets, fruitcrates, sacks, wheelbarrow, wateringcan, beehive, scarecrow, birdhouse, pergola, greenhouse, table, chair, parasol, hanginglantern, garland, hangingsign, milestone, puddle. Paramètres : `kind` (lamp\|bench\|crate\|barrel\|well\|campfire\|tent\|cart\|stall\|signpost\|lantern\|fence\|haystack\|bollard\|planter\|statue\|mailbox\|boat\|fountain\|kiosk\|busstop\|billboard\|pillar\|bin\|lamp2\|clock\|hydrant\|awningstall\|baskets\|fruitcrates\|sacks\|wheelbarrow\|wateringcan\|beehive\|scarecrow\|birdhouse\|pergola\|greenhouse\|table\|chair\|parasol\|hanginglantern\|garland\|hangingsign\|milestone\|puddle), `size`, `variant` |
| `vehicle` | Véhicule instanciable : carriage (carrosse), bicycle (vélo), car (voiture ancienne), rowboat (barque), sailboat (voilier), balloon (montgolfière), handcart (charrette à bras). Barque et voilier : couche `onWater`. Couleur de caisse : paint (auto = selon la variante). Paramètres : `kind` (carriage\|bicycle\|car\|rowboat\|sailboat\|balloon\|handcart), `paint` (auto\|accent\|cloth1\|cloth2\|leaf2\|water\|wood\|paper\|ink), `size`, `variant` |
| `wall` | Clôture continue le long de `points` (coordonnées de scène ; placer la couche à l'origine : place {at: [[0,0]]}). kind = drystone (muret de pierre sèche à couronnement), coping (muret maçonné à chaperon), fence (piquets et lisses), picket (palissade à lattes), hedge (haie taillée), railing (grille de fer forgé sur mur bahut), bamboo (clôture japonaise). Drapé sur le relief, brèches et portillons selon `gaps`. Paramètres : `kind` (drystone\|coping\|fence\|picket\|hedge\|railing\|bamboo), `points`, `height`, `gaps`, `closed` |
| `emblem` | Écu en relief (heater, round, kite, banner, square) : partition, bordure, meuble. Se pose sur un mur ou se présente de face (vue `front`). Paramètres : `shape` (heater\|round\|kite\|banner\|square), `division` (plain\|per-pale\|per-fess\|per-bend\|quarterly\|chief), `charge` (none\|star\|circle\|cross\|chevron\|tower\|tree\|crescent), `field`, `tincture`, `metal`, `size` |

| `ball` | Ballons et balles à taille réelle (football 22 cm, basket 24 cm, tennis 6,7 cm, ballon de gym 65 cm…) avec leurs vrais motifs : panneaux, fuseaux, coutures en relief. Ovales (rugby, football américain) couchés sur le flanc. `diameter` change la taille (ballon géant, bille), `squash` l'écrase au sol (dégonflé), `color`/`color2`/`color3` prennent un rôle (red, orange, yellow, green, blue, purple, white, black, accent, cloth1…). Billard : `number` 0 (blanche) à 15. Publie `extra.affords` (kick, roll, bounce, throw, catch, hold…) et `extra.physics` {radius, mass, restitution, friction} ; ancres center, top, grip. Paramètres : `kind` (soccer\|basketball\|volleyball\|handball\|waterpolo\|rugby\|americanfootball\|tennis\|baseball\|cricket\|golf\|pingpong\|petanque\|cochonnet\|billiard\|bowling\|beach\|gym\|medicine\|bouncy\|marble\|playground), `diameter`, `squash`, `color`, `color2`, `color3`, `number`, `turn` |
| `seat` | Assises paramétriques (stool, barstool, chair, armchair, school, folding, rocking, highchair, throne, monobloc, bench, parkbench, pew, sofa, log, stonebench, deckchair, pouf, beanbag, swing, dogbed, perch) construites par pièces : même modèle en 3D et en vectoriel. `user` règle le gabarit (adult, child, toddler, giant, pet, gnome), `places` la longueur des bancs et canapés, `material` (wood, metal, plastic, stone, upholstered, wicker…), `back` (none, low, high), `arms` (yes, no), `color`/`color2` les rôles de l'assise et de la structure. Ancres `sit.N` (bassin assis) et `approach.N` (devant, au sol) ; un acteur `{target: "<id>.sit.0", action: "sit"}` va s'y asseoir. `extra.affords` : sit, lie, rock, swing, perch… Paramètres : `kind` (stool\|barstool\|chair\|armchair\|school\|folding\|rocking\|highchair\|throne\|monobloc\|bench\|parkbench\|pew\|sofa\|log\|stonebench\|deckchair\|pouf\|beanbag\|swing\|dogbed\|perch), `user` (adult\|child\|toddler\|giant\|pet\|gnome), `scale`, `places`, `width`, `material` (auto\|wood\|metal\|plastic\|stone\|upholstered\|wicker\|park\|log\|deckchair\|throne\|swing), `back` (auto\|none\|low\|high), `arms` (auto\|yes\|no), `cushion`, `color`, `color2`, `variant` |
| `assembly` | Objet composé par l'agent : `parts` = liste de pièces en mètres (y vers le haut, base au sol, avant = +z). Types : {t:'box', c:[x,y,z], h:[demi-côtés], rot?:[°x,°y,°z], role}, {t:'rod', a, b, r, r1?, role} (barre, pied), {t:'tube', pts:[[x,y,z]…], r, role} (barre courbe), {t:'lathe', c, profile:[[rayon, hauteur]…], role} (vase, seau, poteau tourné), {t:'blob', c, r:[rx,ry,rz], role} (coussin, sac, galet). 80 pièces au plus. `anchors` : {nom: [x,y,z]} (ex. sit.0, grip, top) ; `affords` : ['sit', 'push', 'carry'…]. Exemples : brouette, seau, pelle, établi, niche, mangeoire, panneau, jouet. Paramètres : `parts`, `anchors`, `affords`, `label` |
| `tool` | Outils à taille réelle (hammer, mallet, sledgehammer, axe, pickaxe, shovel, spade, rake, leafrake, hoe, pitchfork, broom, besom, mop, scythe, saw, trowel, wrench, screwdriver, paintbrush, paintroller, crowbar, fishingrod, machete) : posés (`pose`: lying au sol, leaning appuyé, upright planté). Un personnage peut en tenir un : `character.item: "tool.rake"` ; action d'usage `hammer`, `sweep` ou `dig` (voir `extra.use`). `color` = rôle du manche, `color2` = tête, `color3` = détail. Ancre grip. Paramètres : `kind` (hammer\|mallet\|sledgehammer\|axe\|pickaxe\|shovel\|spade\|rake\|leafrake\|hoe\|pitchfork\|broom\|besom\|mop\|scythe\|saw\|trowel\|wrench\|screwdriver\|paintbrush\|paintroller\|crowbar\|fishingrod\|machete), `pose` (lying\|leaning\|upright), `scale`, `color`, `color2`, `color3` |
Ancres : personnages `head.top`, `head.center`, `hand.r.grip`, `hand.l.grip`, `back`, `chest.front`, `hip.l`, `hip.r`, `feet` ; animaux `head.top`, `back`, `mouth`, `feet` ; bâtiments `door`, `roof` ; lampes et feux `light` ; ballons `center`, `top`, `grip` ; assises `sit.N`, `approach.N`, `back` ; outils `grip`, `top`.

### Objets du quotidien : ce que l'objet permet

`ball`, `seat` et `assembly` publient dans `selection` et dans `ids` leurs `affords` (ce que l'objet permet : `sit`, `lie`, `kick`, `roll`, `bounce`, `throw`, `catch`, `hold`, `carry`, `push`, `swing`, `rock`, `perch`…) ; la sélection d'un ballon ajoute `physics` `{shape, radius, length, mass, restitution, friction}`, celle d'une assise `seats` (`sit.0`, `sit.1`…) (unités SI) pour un jeu ou `sonic-physics`. Couleurs franches disponibles comme rôles : `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `white`, `black` (harmonisées par le style comme les autres rôles).

**Grammaire de pièces** : un objet absent du catalogue se décrit en données avec `assembly` (planche `box`, barre `rod`, tube courbe `tube`, tour `lathe`, coussin `blob`) ; rendu identique en 3D et en vectoriel, aucune évaluation de code. Exemple d'un seau : `{"gen": "assembly", "params": {"parts": [{"t": "lathe", "c": [0, 0, 0], "profile": [[0.1, 0], [0.14, 0.26]], "role": "red"}, {"t": "tube", "pts": [[-0.14, 0.25, 0], [0, 0.36, 0], [0.14, 0.25, 0]], "r": 0.006, "role": "metal"}], "anchors": {"grip": [0, 0.36, 0]}, "affords": ["carry", "fill"]}}`.

## Vrai 2D : illustration vectorielle

`render: "vector"` (clé du DataProvider ou attribut), ou un style vectoriel, bascule sur un rendu **Canvas 2D en courbes de Bézier** : aplats, traits à épaisseur variable, net à tout zoom. Même recette, mêmes ids, mêmes acteurs, mêmes événements ; la composition est bien plus rapide (pas de maillage). Personnages et animaux sont des traits continus suivant le même squelette animé (aucune jointure possible).

- Styles : `ligne-claire` (contour noir, aplats), `flat` (aplats et ombres portées en aplat), `gravure` (hachures et trames), `affiche` (palette réduite, grandes masses), `papier-decoupe` (calques à ombre douce). Variante d'ambiance : `"flat/nuit"`, `"ligne-claire/automne"`… (préréglage 3D après la barre), ou `{vector: "gravure", …jetons}`.
- Caméras : `side` (élévation, défaut) et `oblique` (cavalière) ; `front` donne `side`, `iso` / `perspective` / `top` donnent `oblique`, `follow` suit un acteur.
- Export : changer `exportSvg` (compteur) publie le SVG de la vue dans `state-out.svg` (sans script).

## Styles

Jetons (tous facultatifs, par-dessus `preset`) : `palette` (`gouache`, `brume`, `automne`, `printemps`, `desert`, `neige`, `crepuscule`, `nuit`, `neon`, `papier`, `abysses`), `hue` (°), `chroma`, `contrast`, `shading` (`flat|toon|soft|lit`), `bands` (2–4), `bandSoftness`, `brush`, `outline` (px), `outlineStrength`, `lightAzimuth`, `lightElevation`, `lightIntensity`, `shadows`, `shadowStrength`, `ao`, `texture`, `fog`, `fogHeight`, `night`, `lamps`, `rim`, `grain`, `paper`, `vignette`, `pixel` (taille du pixel), `saturation`, `sky`, `detail` (relief de surface et usure des arêtes, 0 = lisse), `roles` (`{"wall": "#e8d8c0"}`).

Rôles de couleur : `ground grass path road stone wall trim roof wood bark leaf leaf2 flower water metal glass lamp cloth1 cloth2 cloth3 leather skin hair eye eyeWhite mouth accent ink paper snow fire`. La peau, les yeux et la bouche gardent la couleur du personnage quel que soit le thème.

## Fluidité

La composition se fait par tranches (la page reste fluide ; `status.phase = composing`, `status.progress`). Bâtiments fusionnés par tuile, objets répétés instanciés, personnages en un seul maillage chacun. Rendu à la demande, densité de pixels adaptée à la charge, arrêt hors écran, `prefers-reduced-motion` respecté (animation en pause). Une scène de village (≈ 230 objets, 6 personnages) tient en une cinquantaine d'appels de dessin.

## CSP

Pas d'`eval`, pas de `new Function`, pas de worker. Les recettes et expressions sont analysées par procgen lui-même.
