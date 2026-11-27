# sonic-procgen

Générateur procédural **3D** dont la 2D n'est qu'une manière de regarder : un même monde (sol, routes, bâtiments, végétation, objets, personnages animés) se voit de profil comme un jeu de plateforme, en isométrique, en cavalière, de dessus ou en perspective libre. Tout passe par un DataProvider : aucun JS dans l'artefact. Le cahier des charges (architecture, décisions de revue, feuille de route) est dans `SPEC.md`.

## Le plus court

```json
{ "tagName": "sonic-procgen", "attributes": { "dataProvider": "monde", "scene": "village", "style": "height:420px" } }
```

**Source d'images** : avec l'attribut `frame-source`, la scène sert de `channel0: "#id"` à un `sonic-shader` (filtre pixel art, post-traitement maison) ou à `sonic-media-recorder`. En 3D, l'image est alors gardée après présentation (léger coût, d'où l'attribut, lu à la création de la vue) ; sans lui, une toile qui la relit peut la trouver vide.

```json
{ "tagName": "sonic-procgen", "attributes": { "id": "scene", "frame-source": true, "dataProvider": "monde", "style": "position:absolute;inset:0" } },
{ "tagName": "sonic-shader", "attributes": { "channel0": "#scene", "image": "<pixel-art.glsl>", "render-size": "320x180", "style": "image-rendering:pixelated" } }
```

**Chargement** : pendant la composition d'une scène, une carte avec barre de progression (« Composition de la scène… 42 % », puis « Mise en scène… ») s'affiche au premier chargement ; une fine barre en haut pendant une recomposition. Rien n'apparaît si la scène arrive en moins de 150 ms. Attribut `loader="none"` pour le retirer (l'appli peut lire `state-out.status.progress`).

## Clés lues dans `dataProvider`

| Clé | Rôle |
|---|---|
| `scene` | Scène de la bibliothèque : `campagne` (monde infini : routes, bois, fermes, un randonneur suivi), `village`, `rue`, `port`, `foret`, `bivouac`, `personnages`, `marche`, `montagne`, `vapeur`, `neon`, `blasons`, `jardin`, `ferme`, `bord-de-mer`, `aire-de-jeux`, `place-medievale`, `jardin-japonais`, `riviere` (pont de pierre et passerelle, ponton, mare, abreuvoir, train, animaux qui boivent, mangent, dorment), `prairie` (blé, prairie fleurie, herbes hautes, roseaux autour d'une mare, au vent ; promeneurs et moutons qui couchent les herbes) |
| `render` | `3d` (défaut), `vector` (illustration vectorielle 2D, voir plus bas) ou `photo` (3D, rendu soigné à l'arrêt qui fige l'animation, voir Rendu soigné) |
| `ambiance` | Direction artistique d'un mot (voir Ambiances) : `realiste`, `militaire`, `cartoon`, `jouet`, `cyber`, `alien`, `silhouette`, `noir`, `voxel`, `retro`, `horreur`, `western`, `pastel`, `tableau`, `onirique`, ou `{base, …surcharges}` ; aussi attribut `ambiance`, clé `ambiance` de la recette ou jeton de style |
| `photo` | Rendu soigné quand la scène est immobile : `true` ou `{moteur, echantillons, rebonds, attente, filtre, tramage, niveaux, touche, echelle}` (voir Rendu soigné) ; aussi attribut `photo` |
| `exportSvg` | Compteur : chaque changement publie le SVG de la vue dans `state-out.svg` (mode vectoriel) |
| `football` | Match de football jouable (rendu 3D, voir Football) : `true` ou `{players: 5\|7\|11, minutes, level, human: "home"\|"away"\|"none", teams: [{name, shirt, shorts, socks, keeper, pattern}], cinematics, hud, keyboard, touch, sound, seed, input}` ; prioritaire sur `recipe` et `scene` |
| `recipe` | Recette complète (prioritaire sur `scene`, voir plus bas) |
| `seed` | Graine. Même graine = même monde ; chaque objet a sa sous-graine, donc modifier un objet ne bouge pas les autres |
| `params` | Paramètres exposés par la recette (ex. `village` : `maisons`, `habitants`) |
| `style` | Préréglage (`gouache`, `doux`, `encre`, `bd`, `pixel`, `lowpoly`, `brume`, `nuit`, `neon`, `crepuscule`, `automne`, `printemps`, `desert`, `neige`, `papier`, `abysses`, `aquarelle`) ou jetons (voir Styles) |
| `view` | `{camera, yaw, pitch, zoom, cx, cy, cz, actor}` ; `camera` : `side`, `front`, `iso`, `oblique`, `top`, `perspective`, `follow` (suit `actor` ou `follow` : acteur ou véhicule, voir Conduite) |
| `anim` | `{play, speed}` |
| `actors` | Intentions par acteur (voir Jeu) |
| `select` | Id d'objet à surligner (`maisons.3`) |
| `edit` | `{id: "maisons.3", params: {floors: 4}}` ou `{layer: "maisons", params: {...}}` : modifie sans réécrire la recette |
| `hidden` | Ids cachés (objet ramassé, personnage parti) |
| `anchors` | Ancres à suivre à l'écran : `["heros@head.top", "maisons.2@door"]` |
| `placeRequest` | Place libre pour un nouvel objet : `{id, gen, params, at: [x, z], size: [w, d], yaw (°), onWater, onPath, ignore}` (voir Édition au doigt) ; calculée une fois par valeur |
| `forces` | Physique 3D : ordres par corps `{<id>: {vx, fy, impulse: {n, x, y, z}, set: {n, …}, wake}}` (voir Physique 3D) |
| `queries` | Physique 3D : requêtes `{<id>: {n, ray: {from, dir, max}} \| {n, sphere: {at, r}} \| {n, box: {lo, hi}}, mask, ignore, live}` |
| `weather` | Météo prioritaire sur celle de la recette (voir Particules) : `"rain"` ou `{kind, intensity}` ; sans recomposition |
| `fx` | Salves : `{<système>: {n, at, scale, color, count}}`, une salve à chaque hausse de `n` (ex. `{"campfires-sparks": {n: 3}}`) |
| `tiles` | Monde infini : retouches persistées par tuile `{"cx,cz": {remove, move, add}}` (voir Monde infini) ; recopier `place.payload.tiles` |
| `kick` | Coup donné à un ballon sans acteur : `{ball: "ballons.0", power, dir (°, 0 = +z), loft, n}` ou `{ball, vx, vy, vz}` (m/s, norme bornée à 40), ou une liste de 16 au plus ; joué quand la valeur change (pas au chargement) : pour retirer le même coup, incrémenter `n` |
| `emitters` | Émetteurs ajoutés ou réglés sans recomposer : `{<id>: {…}}` fusionné champ par champ avec `recipe.emitters` (`null` retire celui de la recette) ; voir Émetteurs |
| `states` | États des objets sans recomposer : `{"<objectId>": {"lid": 1, "door.fl": 0.5, "burning": true}}`, fusionné par objet par-dessus les états de la recette (voir Parties et états) |
| `stateSpeed` | Durée d'une course complète d'une partie (s, 0,6 par défaut ; 0 = immédiat) ; aussi clé `stateSpeed` de la recette |
| `drive` | Conduite directe sans recomposer : `{"<véhicule ou monture>": {throttle: -1…1, steer: -1…1 (> 0 : à droite), brake: 0…1}}` (voir Conduite) |
| `emit` | Ordres de tir : `{<id>: {n, count, at, dir, toward, clear, kill}}` (chaque hausse de `n` tire une salve ; voir Émetteurs) |

## Clés écrites dans `state-out` (défaut `<dataProvider>State`)

Le composant **n'écrit jamais** dans `dataProvider` : un `sonic-store` qui le publie ne peut donc rien effacer.

| Clé | Contenu |
|---|---|
| `status` | `{phase: idle\|composing\|ready\|error, progress, error, ms, objects, actors, blades, triangles, drawCalls, fps, scale, issues}` (`blades` : brins des prairies, s'il y en a) |
| `selection` | `{id, generator, layer, params, x, y, z, yaw (°), w, d, h (m), place, index, movable, parts, states}` de l'objet touché ; suit l'objet pendant un glisser |
| `ids` | Liste des objets placés `{id, generator, layer, x, z, yaw (°), w, d (emprise, m), place, affords, parts, states}` : ce qui existe et peut être visé (400 au plus) ; `parts` : `[{name, label, kind: rotation\|translation, range: [fermé, ouvert] (° ou m), value}]`, `states` : états libres posés |
| `drag` | Pendant un glisser : `{objectId, x, y, z, yaw, valid}` ; `null` sinon |
| `free` | Réponse à `placeRequest` : `{id, x, y, z, yaw, valid, hits, snaps}` |
| `actors` | Position, cap, vitesse, action de chaque acteur (5 fois par seconde au plus) |
| `anchors` / `nodes` | Positions écran des ancres demandées ; `nodes` est au format de `sonic-stage` (bulles de dialogue en HTML par-dessus la scène) |
| `view` | Vue courante (après pan / zoom de l'utilisateur) |
| `physics` | Physique 3D (si la recette la demande) : `{status: loading\|ready\|error, time, count, awake, bodies: {<id>: {x, y, z, rx, ry, rz (°), vx, vy, vz, awake}}}`, 10 fois par seconde au plus tant que ça bouge, rien au repos |
| `queries` | Réponses aux requêtes : `{<id>: {n, hit, objectId, tags, x, y, z, normal, dist}}` (rayon) ou `{n, hit, objectId, all}` (sphère, boîte) |
| `infinite` | Monde infini : `{center, tile: [cx, cz], radius, loaded, pending, ms, lastTileMs, avgTileMs, uploadMs, uploadMaxMs, pumpMaxMs, edits, persist, worker, mounted, gpu: {tris, calls}}` |
| `tiles` | Monde infini : retouches persistées (copie du composant, bornée par `persist`) |
| `balls` | `{<id>: {x, y, z, moving}}` des ballons visibles (200 au plus), republié pendant le mouvement (5 fois par seconde au plus), au coup et à l'arrêt |
| `photo` | Rendu soigné : `{etat: arret\|attente\|calcul\|fini\|indisponible, moteur: rayons\|raster, echantillons, total, progression (0…1), raison}` ; `null` sans `photo` ; `status.photoMs` : coût du démarrage (copie traçable et BVH, ms) |
| `ambiance` | `{name, meteo}` de l'ambiance appliquée (`meteo` : préréglages de particules demandés), `null` sans ambiance |
| `emitters` | `{<id>: {alive, emitted, dropped, expired, exited?, ms, near?}}` : copies vivantes, nées, recyclées, mortes, sorties de la scène, coût de la simulation (ms) |
| `vehicles` | Véhicules et montures (64 au plus) : `{<id>: {x, z, yaw (°), speed (m/s), driver, passengers: [ids], seats: {"seat.driver": id\|null, …}, to?: {x, z, target}}}` |
| `impacts` | Dernières touches des projectiles (16 au plus) : `{emitter, id, target, copy?, tags, x, y, z, dir, t}` |

`issues` : `{path, code: unknown|clamped|type|expr|missing|limit|info, message, got, used, hint, didYouMean}`. Une erreur n'arrête jamais le rendu : la scène s'affiche avec ce qui est valide.

## Jeu

Événements envoyés au store `target` (`type` préfixé par `action-prefix` s'il est donné) :

| Type | Charge utile |
|---|---|
| `pick` | `{objectId, generator, layer, x, y, z, actor, zone, part}` : position au sol comprise (point-and-click) ; `part` : partie mobile touchée (`lid`, `door.fl`…, rendu 3D) |
| `state` | `{objectId, part, value}` : une partie a fini de bouger (fin de l'animation vers l'état demandé) |
| `select` | `{objectId, generator, layer, params}` |
| `arrive` | `{actor, x, z, target}` : l'acteur est arrivé ; `{actor, vehicle, x, z, target}` : le véhicule conduit est arrivé |
| `board` / `alight` | `{actor, vehicle, seat, driver}` : assis à sa place (portière refermée ensuite) / `{actor, vehicle, seat, x, z}` : descendu |
| `bump` | `{vehicle, hit, x, z}` : le véhicule s'arrête contre `hit` (objet, `edge`, `water`, `shore`, `rails-end`), une fois par contact |
| `blocked` | `{actor, reason: no-path\|wall\|ball-moved}` (`ball-moved` : le ballon visé a roulé hors d'atteinte trois fois) ; conduite : `{actor, vehicle, reason: no-vehicle\|no-seat\|seat-taken\|not-rider\|not-driver\|no-target\|no-path\|wall\|stuck}` |
| `enter` / `leave` | `{zone, actor}` ou `{zone, ball, actor: null}` quand un ballon entre dans une zone (un but) |
| `kick` | `{actor, ball, power}` ; `{actor: null, ball}` pour la clé `kick` |
| `hit` | `{ball, actor}` : un acteur a heurté un ballon (dribble) |
| `rest` | `{ball, x, z}` : le ballon s'est arrêté |
| `place` | Au lâcher d'un glisser (une seule fois) : `{objectId, instance, layer, index, place, x, y, z, yaw (°), ry (rad), valid: true, snaps, from: {x, z}}` (voir Édition au doigt) |
| `dragstart` | `{objectId, instance, layer, index, x, z}` : un glisser commence (rien d'autre n'est envoyé pendant le geste) |
| `dragRefused` | `{objectId, layer, index, place, reason: placement\|occupied, hits}` : objet qui ne se glisse pas (ballon), ou aucune place libre au lâcher (l'objet revient à sa place) |
| `placeFree` | Réponse à `placeRequest` (comme `state-out.free`) |
| `contact` | Physique 3D : choc `{a, b, tagsA, tagsB, impulse (N·s), x, y, z}` au début d'un contact (`b` vide = sol, bord ou ouvrage ; `tags` : calque, générateur, `acteur`) |
| `settle` | Physique 3D : `{bodies}` quand tous les corps dynamiques se sont immobilisés |
| `splash` | Physique 3D : `{body, x, z, speed}` quand un corps tombe dans l'eau |
| `drop` | Physique 3D : `{objectId, x, y, z}` au lâcher d'un corps glissé (il reprend la physique) |
| `actionEnd` | `{actor, action}` (après `wave`, `cheer`, `jump`, `bow`, `point`, `kick`, ou au bout de `duration`) |
| `impact` | `{hits: [{emitter, id, target, copy?, tags, x, y, z}], t}` : toutes les touches d'une image en un seul événement (équivalent du `hit` du format monde ; `hit` reste ici le dribble d'un ballon) |
| `expire` / `exit` | `{emitter, count}` : copies mortes de vieillesse / projectiles sortis de la scène, si l'émetteur les demande (`events: ["expire", "exit"]`) |

Intentions d'acteur (`actors.<id>`), écrites par le reducer, **jamais à chaque image** (le composant interpole) :

- `{x, z}` ou `{target: "maisons.2"}` (ancre `door` par défaut, ou `"maisons.2.door"`) : marche jusque-là par la grille de navigation, contourne les bâtiments, puis `arrive` ; `run: true` pour courir, `speed` en m/s ;
- `{target: "bancs.1.sit.0", action: "sit"}` : marche jusqu'à la place (ancre `approach.0`, devant l'assise), s'assied sur `sit.0` face à l'avant, le bassin à hauteur d'assise (chaise, tabouret de bar, rondin, balançoire…), puis `arrive` ;
- `{target: "voitures.0", action: "board", seat: "driver" | N}`, `{action: "alight"}`, `{action: "drive", to}` : monter, descendre, conduire (voir Conduite) ;
- `{target: "ballons.0", action: "kick", power, loft}` : va au ballon (le rattrape s'il a roulé) et tire dans l'axe de son arrivée (`power` en m/s, 7 par défaut, 30 au plus ; `loft` 0 à 1,5 lève le ballon) ; les ballons (`ball`) rebondissent selon leur `physics` (restitution, frottement) sur le sol, les obstacles (à toute hauteur) et les bords, roulent, s'empilent, sont poussés par les acteurs qui marchent dessus ; les ovales et les ballons écrasés glissent sans culbuter ; un ballon caché (`hidden`) sort du jeu ; `pick` et `selection` donnent la position de départ, `balls` la position courante ;
- `{vx, vz}` : déplacement direct (manette à 30 Hz), sans chemin ;
- `{target: "bassin.0.spot.1", action: "drink"}` (ou `"eat"`, `"sleep"`) : marche jusqu'à `approach.N`, se place la bouche au-dessus de l'ancre `spot.N` (eau d'un `water`, abreuvoir, gamelle, mangeoire d'un `pet`), tourné vers elle, puis boit ou mange (cou baissé jusqu'à la hauteur de la cible) ; `sleep` vers une niche ou un panier : s'y couche ; `{target: "bassin.0", action: "drink"}` prend la place la plus proche ; `{target: "bancs.1.sit.0", action: "sleep"}` : s'endort assis. Chien, chat, cheval, vache, mouton, oiseaux et personnages ;
- **Relief retouché en direct** (rendu 3D, scène finie) : clé `terrain` du DataProvider (ou `recipe.terrain`) = liste complète des retouches, rejouée depuis le sol d'origine à chaque changement (même liste = même sol) : `[{op: dig|raise|flatten|smooth, x, z, r (m), depth (m : profondeur du trou, hauteur du tas), height (aplanir à cette hauteur ; défaut : hauteur au centre), k (0…1 : avancement), id}]`. Un trou rejette sa terre en bourrelet autour de lui ; la terre retournée prend la couleur de la terre battue ; acteurs et ballons suivent le nouveau sol (les objets posés restent à leur hauteur, les routes ne sont pas reprises). Retouche faite par un acteur : `actors.<id>.shape = {op, r, depth, height, dist (m devant l'acteur, défaut 0,75) | at [x, z]}` avec une action (`dig`, `hammer`…) : le trou se creuse au fil de l'action (`duration`, sinon 3 s), puis l'événement `terrain {actor, edit}` est publié (`edit.id` = `<acteur>.<n>`) : l'ajouter à la clé `terrain` pour le garder (une retouche de la liste qui porte le même `id` remplace celle de l'acteur, pas de double creusement).
- `{action}` : `idle`, `walk`, `run`, `wave`, `point`, `cheer`, `talk`, `carry`, `sit`, `jump`, `think`, `bow`, `hammer` (frapper), `sweep` (balayer, ratisser), `dig` (bêcher), `kick` (geste de jambe), `drink` (boire : gobelet ou, cible basse, penché, mains en coupe ; animal : tête baissée, lapées), `eat` (manger : bouchées ; animal : broute, mâche, picore), `sleep` (dormir : personnage assoupi assis ou par terre, animal couché, oiseau tête rentrée ; yeux fermés), `throw` (lancer par-dessus l'épaule : armé, fouet du bras, accompagnement ; combiné avec un émetteur `emitters` pour l'objet lancé), `comb` (se coiffer), `guard` (garde de combat), `punch` (enchaînement direct, direct arrière, crochet, uppercut), `fightkick` (coups de pied de face, circulaire, latéral), `sword` (escrime à une main : coups de taille vertical, diagonal, horizontal, estoc en fente ; `item: sword`), `archery` (tir à l'arc de profil : encoche, tire jusqu'à la mâchoire, vise, lâche ; `item: bow`, flèches avec un émetteur `shape: arrow`), `hang` (pendu à une barre, une branche : bras tendus, corps qui se balance, pieds dans le vide ; avec `target` sur une ancre (`id.spot.N`), les mains se posent à sa hauteur, sinon pieds à 35 % de jambe du sol), `dance` (danse en rythme : rebond, pas de côté marqués, quatre enchaînements de bras qui tournent), `swim` (crawl : corps à l'horizontale à la surface de l'eau, l'eau devient praticable pour l'acteur ; sans eau, il nage au sol), `tackle` (tacle glissé), `diveleft` / `diveright` (plongeon de gardien), `fall` (chute fauché, relevé), `header` (tête en extension), `climb` (grimper : mains et pieds en alternance ; avec `target` sur un objet ou une ancre, l'acteur va au pied et monte jusqu'à la prise, sinon à un mètre et demi) ; personne ne se traverse : les acteurs se contournent, s'écartent et glissent le long des obstacles ; escalade complète (rendu 3D) : `climb` vers un objet (rocher, caisse, mur, banc, ouvrage, assemblage…) va au pied de la vraie paroi (dessus réel du modèle, gradins compris), monte jusqu'au rebord, se rétablit (`mantle`) et se tient debout sur le sommet ; un nouvel ordre `climb` sur le même objet grimpe le gradin suivant ; sur un sommet, on marche, une marche plus haute qu'un pas fait mur, passer le bord fait tomber (gravité, réception fléchie) ; en tombant sans ordre de déplacement, l'acteur se rattrape à un rebord à portée de main (événement `grab`), s'y suspend puis se rétablit ; sur une pente du relief plus raide que 35°, il glisse (accroupi, bras en balancier) ; `arrive {on}` quand il est debout sur le sommet ; chaque geste varie d'un cycle à l'autre (rythme et articulations, bruit lissé propre à l'acteur) : jamais deux boucles identiques ; `duration` (s) : l'action s'arrête et publie `actionEnd` ; `{mood}` : `neutral`, `happy`, `sad`, `angry`, `surprised`, `sleepy` (le visage passe en douceur d'une expression à l'autre, en 3D comme en vectoriel) ; `{look}` : id d'un acteur ou d'un objet, ou `camera` (les yeux suivent la cible, `""` ou `none` : regard libre, petits mouvements d'yeux au repos) ; la bouche bouge pendant `talk`, mâche pendant `eat`, s'ouvre pendant `cheer` ; les mains libres prennent la pose de l'action (main ouverte pour `wave`, `talk`, `jump`, index tendu pour `point`, poings pour `cheer`, la garde, les coups et la course ; une main qui tient un objet garde sa prise) ; `{facing}` (°).

Exemple de reducer (voir `examples/village-vivant.sdui.json`) : sur `pick`, écrire `actors.heros = {x, z}` ; sur `arrive`, passer à la suite du dialogue.

## Football

Un match complet, jouable, dans un stade composé à partir des réglages (rendu 3D) :

```json
{ "football": { "players": 11, "minutes": 6, "level": 0.6, "human": "home",
  "teams": [{ "name": "Lions", "shirt": "#c8202c", "shorts": "#ffffff" }, { "name": "Aigles", "shirt": "#1f4fa8", "shorts": "#14204a" }] } }
```

- **Stade** : terrain réglementaire tracé (105 × 68 m à 11, 60 × 40 m à 7, 40 × 25 m à 5), herbe tondue en bandes, buts avec filets, panneaux, tribunes garnies aux couleurs des équipes (générateur `sport`), 2 × `players` joueurs en tenue (`pattern` : `plain`, `stripes`, `vstripes` ; gardiens en `keeper`).
- **Règles** : coup d'envoi, touches, corners, sorties de but, fautes sur tacle glissé (coup franc, penalty dans la surface), buts, mi-temps (changement de camp), fin du match ; l'horloge affichée va de 0 à 90' en `minutes` réelles.
- **Jeu** : ballon physique (vol, effet, rebonds, roulement freiné, poteaux, transversale, filets), conduite de balle, passes au sol et lobées, tirs (puissance à la touche tenue), têtes, tacles debout et glissés, gardiens qui se placent, plongent, captent ou repoussent. Les équipes gérées pressent, marquent, se replacent, font des appels ; `level` (0 … 1) règle l'adversaire.
- **Caméra** : vue de haut fixe qui suit le ballon. **Cinématiques** (`cinematics: false` pour les couper) : grosse occasion, arrêt, poteau, tacle (ralenti, caméra au ras du sol), but (le buteur qui célèbre, puis ralenti rejoué derrière le but, passé par une touche d'action), penalty, coup d'envoi, mi-temps, fin du match.
- **Commandes** (`human` : l'équipe jouée ; le joueur contrôlé a un anneau jaune) : clavier (flèches ou ZQSD/WASD, Maj sprint, Espace tir tenu, J ou X passe, K ou C ballon long, L ou V tacle, Tab ou E changer de joueur), manette (stick, A passe, B tir, X ballon long, Y/LB changer, RB/RT sprint), écran tactile (stick virtuel à gauche, boutons TIR, PASSE, LONG ; en défense TIR fait un tacle glissé, PASSE change de joueur). Entrée externe : `football.input = {x, z (-1…1, haut de l'écran = z négatif), sprint, pass, shoot, lob, tackle, switch}` ; `keyboard: false` / `touch: false` coupent les commandes intégrées.
- **Son** (généré en Web Audio, aucun fichier ; `sound: false` pour le couper, modifiable en cours de match) : rumeur de la foule qui monte quand le ballon approche d'un but, « ooh » sur une occasion, un arrêt ou un poteau, clameur et cornes au but, applaudissements, chants rythmés avec tambour pendant les temps calmes, sifflet de l'arbitre (coup d'envoi, faute, penalty, mi-temps, fin), frappes selon leur puissance, rebonds, poteau qui résonne, filet, chocs des tacles ; au ralenti, le son est étouffé. Le son démarre au premier geste de l'utilisateur (règle des navigateurs).
- **Habillage** (`hud: false` pour le retirer) : tableau d'affichage, bandeaux (BUT !, QUEL ARRÊT !, PENALTY…), barres de cinéma, jauge de tir.
- **Sorties** : `state-out.football` `{phase: intro|setpiece|play|goal|halftime|fulltime, half, minute, score, teams, possession, ctrl, set: {kind, team, ready}, cine}` ; événements `kickoff`, `kick`, `shot`, `save`, `header`, `tackle`, `foul`, `post`, `goal {team, player, own, score, minute}`, `throwin`, `corner`, `goalkick`, `freekick`, `penalty`, `miss`, `possession`, `halftime`, `fulltime {score, winner}`.
- Gestes ajoutés aux personnages : `tackle` (tacle glissé), `diveleft`, `diveright` (plongeon du gardien), `fall` (chute, relevé sur un genou), `header` (tête en extension).

## Édition au doigt

Les mêmes gestes que le format monde de `sonic-3d` (voir `3d/monde.md`, Édition) :

```json
{ "tagName": "sonic-procgen", "attributes": { "dataProvider": "scene", "target": "atelier", "action-prefix": "pg_", "drag": ".*", "drag-selected": true, "keep-heading": true } }
```

- **Vue** : un doigt sur le vide = orbite (perspective) ou déplacement (vues de profil, iso) ; **deux doigts = pincer pour zoomer et glisser pour déplacer la vue**, ensemble ; molette = zoom ; clic droit = déplacer ; double-clic (souris) = revenir à la vue de la scène.
- **Sélection** : un tap (moins de 6 px et 400 ms, un seul doigt) envoie `pick` puis `select` avec `objectId` (= `instance`) ; toucher une partie d'un bâtiment sélectionne le bâtiment entier, toucher le sol ou le vide désélectionne (`objectId: null`). L'objet sélectionné est surligné.
- **Glisser** (`drag` = regex des ids ou des calques, `".*"` : tous) : avec `drag-selected`, seul l'objet sélectionné se glisse, et seulement s'il est le premier sous le doigt ; ailleurs le geste tourne la vue. Pendant le geste, le composant range l'objet à chaque image **sans rien envoyer au store** : posé sur le relief (sur l'eau pour une couche `onWater`), dos contre un bâtiment, un mur ou une clôture à moins de 30 cm, bords alignés sur un voisin parallèle à moins de 8 cm, sinon grille de 5 cm ; s'il gêne (emprises des objets composés, tronçons de clôture et garde-corps, chaussée et rivière hors `onPath`, eau, bords de la scène), il glisse vers la place libre la plus proche. Il est soulevé de quelques centimètres et retombe au lâcher ; il devient rouge tant qu'aucune place libre n'existe. Au lâcher : **une** action `place` (le store en fait une entrée d'historique) ; sans place libre, l'objet revient à sa place et `dragRefused` (`occupied`) est envoyé.
- **Ce qui se glisse** : tout objet de couche et les acteurs de `recipe.actors`. Couche placée par points (`place: {at: […]}`) : `index` est le rang du point dans `at`, que l'appli réécrit. Calque réparti (`grid`, `poisson`, `along`, `edges`, `scatter`, `ring`…) : l'objet se glisse comme un objet posé seul ; au lâcher, `place` porte `{objectId, layer, index, place, x, z, yaw (°)}` et **l'appli écrit `layers[i].moves[index] = {x, z, yaw}`** dans la recette (voir Options de couche) : la recomposition le garde à sa nouvelle place sans saut ni changement de vue, les autres objets du calque ne bougent pas. Pour retirer un objet d'un calque réparti : ajouter son `index` à `layers[i].remove`. Ballons exclus (`dragRefused`, `placement`). Rendu 3D seulement : en rendu vectoriel, sélection et gestes de vue marchent, pas le glisser.
- **Cap** : jamais tourné automatiquement (`keep-heading` est accepté pour la parité avec `sonic-3d`) ; pendant le geste, R (quart de tour, Maj+R dans l'autre sens), Q / E ou la molette (15°). `place.yaw` (degrés) est à recopier : un point `at` sans `yaw` reçoit sinon un cap tiré au hasard.
- **Persistance** : le glisser déplace l'objet à l'écran sans recomposer ; c'est au store de recopier `x`, `z` (et `yaw`) dans le point `at[index]` de la couche `layer` (ou `actors.<id>.at`). Sinon la prochaine recomposition le remet à sa place.
- **Pendant une recomposition** (après un `place` recopié dans la recette) : la scène affichée reste saisissable, le geste sur l'objet sélectionné le déplace sans toucher à la vue ; un modèle qui arrive pendant le geste est adopté au lâcher, et les poses faites depuis le début de sa composition y sont rejouées. La vue (orbite, zoom, cadrage) et la sélection survivent à la recomposition.
- **Nouvel objet sans collision** : écrire `placeRequest = {id: "n12", gen: "seat.parkbench", params, at: [x, z]}` (sans `at` : centre de la vue ; `size: [w, d]` en mètres au lieu de mesurer le générateur ; `ignore` : id ou calque, ou liste, à ne pas compter comme obstacle — l'objet lui-même s'il est déjà dans la recette) ; le composant répond une fois par valeur dans `state-out.free` et par l'action `placeFree` `{id, x, y, z, yaw, valid, hits, snaps}` : le réducteur ajoute alors l'objet à ce point.
- Avec la physique 3D : un corps dynamique se glisse quel que soit son placement (ballons compris) : il suit le doigt à 25 cm au-dessus du sol en poussant les autres corps, puis retombe au lâcher, lancé à la vitesse du geste (`drop`, puis `rest` / `settle`). Un objet du décor glissé pousse les corps sur son passage ; les corps ne comptent pas comme obstacles pour le rangement.
- Coût : rien par image hors geste ; une recherche de rangement par image pendant le glisser (emprises 2D, contexte préparé au début du geste) ; publication de `state-out` 15 fois par seconde pendant un geste, 5 sinon.

## Parties et états

Des objets ont des **parties mobiles** : un sous-groupe du modèle qui tourne autour d'un pivot ou glisse le long d'un axe (repère de l'objet), avec une course `[fermé, ouvert]` en degrés (rotation) ou en mètres (translation). Un **état** va de 0 (fermé) à 1 (ouvert) ; le rendu 3D passe d'un état à l'autre en douceur (`stateSpeed` s par course complète) **sans recomposer** : la partie est une instance à part (matrice objet × partie), ou, pour un objet fusionné dans le décor (bâtiment), ses sommets sont réécrits dans la tuile. L'objet reste instancié, rien n'est reconstruit.

```json
"layers": [
  { "id": "malles", "gen": "container.chest", "params": { "open": false }, "place": { "at": [[0, 0], [2, 0]] }, "states": { "1": { "lid": 1 } } },
  { "id": "marmites", "gen": "container.pot", "place": { "at": [[4, 0]] }, "stateFx": { "lid>0.3": "steam" } },
  { "id": "autos", "gen": "vehicle.moderncar", "place": { "at": [[8, 0]] }, "states": { "*": { "door.fl": 1, "trunk": 1 } } }
],
"actors": { "heros": { "at": [0, 3], "states": { "burning": 1 } } }
```

- **Où les écrire** : `layers[i].states` `{"<rang>" | "*": {…}}`, `actors.<id>.states`, puis la clé `states` du DataProvider `{"<objectId>": {…}}` (fusionnée par objet, prioritaire). Changer ces clés (et `stateFx`, `stateSpeed`) ne recompose jamais la scène ; une recomposition (après un `place`, un `edit`) réapplique les états d'un coup.
- **Clés d'un état** : nom exact d'une partie (`door.fl`), préfixe (`door` : toutes les portières ; `lid` : les quatre rabats d'un carton), `open` (le couvercle, sinon tout ce qui s'ouvre ; jamais les roues), ou un état libre. Valeur : nombre 0…1 ou booléen. Une valeur hors bornes est ramenée (`clamped`), une partie inconnue est signalée dans `status.issues` avec `didYouMean` (`unknown`), un mauvais type aussi (`type`).
- **Publication** : `selection.parts` et `ids[].parts` = `[{name, label, kind, range, value}]` (valeur courante, publiée à la fin de chaque animation) ; `affords` contient `open` dès que l'objet a une partie qui s'ouvre. `pick.part` donne la partie touchée (3D) ; l'événement `state {objectId, part, value}` part à la fin d'une animation.
- **Ancres de parties** : `<partie>.<ancre>` suivent la partie (`lid.top`, `door.fl.handle`, `door.handle`, `trunk.handle`, `gate.l.handle`) ; utilisables dans `anchors`, `particles.at` (`"marmites.0@lid.top"`), `layers[].fx`.
- **Particules liées à un état** : `layers[i].stateFx` ou `fx` dans l'état d'un objet (`"states": {"marmites.0": {"lid": 1, "fx": {"lid>0.3": "steam"}}}`) : `{"<partie|état>[>|>=|<|<=seuil]": "<effet>" | {preset, anchor, intensity, …réglages}}` (sans seuil : `> 0`). Effets de `scene/fx.ts` (steam, smoke, fire, embers, bubbles…), nés à l'ancre donnée, sinon `<partie>.top`, `inside` ou `top`. La condition est lue sur l'état demandé (l'effet part dès l'ordre).
- **États libres** (sans partie, booléen ou 0…1) :

| État | Alias | Effet par défaut |
|---|---|---|
| `burning` | `brule`, `feu`, `fire` | flammes, fumée noire et braises en haut de l'objet (plus larges sur un objet de plus de 2,5 m), lueur de feu |
| `lit` | `allume`, `on` | petite flamme à l'ancre `light` (lanterne, feu de camp, lampadaire) ou en haut, et sa lumière |
| `boiling` | `bout` | vapeur et bulles à l'ancre `inside` (marmite, seau, bidon) ou en haut |
| `smoking` | `fume` | fumée grise aux cheminées `chimney.N`, à l'ancre `light` ou en haut |

Un acteur peut porter un état libre (`actors.<id>.states`) : ses effets le suivent.

**Parties par générateur**

| Générateur | Parties |
|---|---|
| `container` | `lid` : coffre (chest), caisse (crate), caisse à outils, poubelle à roulettes, glacière, marmite (pot), bidon à lait, valise (coque avant, en livre) ; carton : rabats `lid.f`, `lid.b`, `lid.l`, `lid.r`. `open` = valeur de départ ; contenu (`fill`) seulement s'il part ouvert |
| `vehicle` | `moderncar` : `door.fl` (conducteur, à gauche, x > 0), `door.fr`, `door.rl`, `door.rr`, `trunk` (hayon), `hood` ; `van` : `door.fl`, `door.fr`, `door.side` (coulissante, à droite), `door.back.l`, `door.back.r` ; `bus` : `door.0`, `door.1` (coulissantes, à droite) ; `truck` : `door.fl`, `door.fr`, puis `door.back.l|r` (caisse) ou `tailgate` (benne). Essieux `wheel.N` (un tour = 0…1, jamais ouverts par `open`) ; essieu avant directeur : roues `wheel.0.l` / `wheel.0.r` (préfixe `wheel.0`), enfants de `steer.fl` / `steer.fr` (±35°, 0,5 = tout droit) : moderncar, van, bus, truck, tractor. Places : `seat.driver`, `seat.N`, `approach.door.fl`… |
| `building` | `door` (porte d'entrée, vers l'intérieur, embrasure sombre) ; volets `shutter.N` (0 = fermé devant la fenêtre, 1 = ouvert à plat ; entrebâillés au départ selon la graine), 24 parties au plus |
| `structure.gate` | `gate.l`, `gate.r` (vantaux, `open` = valeur de départ) |
| `pet.kennel` | `door` (porte battante, ouverte au départ) |
| `prop.mailbox` | `lid` (volet de la fente) |
| `assembly` | toute pièce avec `part: {name, pivot, axis, range, kind: rotation\|translation, label, initial}` ; les pièces d'un même nom forment une partie |

**Parties imbriquées** : une partie peut avoir une parente (`parent`, trois niveaux au plus) ; sa matrice vaut objet × parente × partie (pivots en repère de l'objet fermé). La roue `wheel.0.l` braque avec `steer.fl` et tourne sur son axe en même temps ; une partie sans maillage (direction) ne sert que de parente.

**Non couvert (limites)** : voiture ancienne (`vehicle.car`), carrosse et autres véhicules dessinés au maillage ; portes d'armoire et tiroirs (aucun générateur de meuble à portes) ; `street.barrier` (barrière de chantier fixe : utiliser `structure.gate`) ; porte des tours, moulins, phares et des annexes d'un bâtiment. Le vectoriel fige l'état demandé pour les objets sur la grammaire de pièces (contenants, véhicules modernes, portail, niche, assemblage) ; le bâtiment et la boîte aux lettres y restent fermés, sans `pick.part`. La navigation et les obstacles d'un portail suivent `open` à la composition, pas l'état. Monde infini : parties à leur valeur de départ (la clé `states` n'y est pas appliquée). Physique : pas de charnière automatique ; une partie ne pousse pas les corps (pour un battant physique, `physics.joints` avec `hinge`). Un contenu qui dépasse d'un contenant ouvert puis refermé traverse le couvercle.

**Structure pour la suite** : une partie a un nom stable, ses ancres et son propre maillage (instance ou plage de sommets) ; des dégâts pourront l'arracher (cacher son instance, lâcher un débris) et des contenus s'attacher à une ancre de partie ou se cacher sous une partie fermée.

## Conduite

Véhicules (`vehicle`) et montures (`animal` : `horse`, `deer`, `cow`, `bear`) se conduisent sans recomposer : la caisse, ses parties et ses occupants sont déplacés image par image (rendu 3D).

```json
{ "actors": { "heros": { "target": "voitures.0", "action": "board", "seat": "driver" } } }
{ "actors": { "heros": { "action": "drive", "to": "gare" } } }
{ "drive": { "voitures.0": { "throttle": 0.6, "steer": -0.4, "brake": 0 } } }
```

**Monter, descendre** (`actors.<id>`, personnages seulement) :
- `{target: "<véhicule>", action: "board", seat}` : `seat` = `"driver"` (défaut, `seat.driver`, `seat` ou `seat.rider`), un rang N (`seat.N`) ou un nom d'ancre. L'acteur marche jusqu'à `approach.door.X` (la portière la plus proche de sa place, du même côté), la portière s'ouvre (état `door.X`, `stateSpeed`), il se glisse à sa place, s'assied (bassin à l'ancre, pieds au plancher, mains au volant), `board` part, la portière se referme. Sans portière (vélo, charrette, voiture ancienne, carrosse, barque, voilier, tracteur, montgolfière, train, monture) : à côté de la place, du côté d'où il vient, puis il monte directement. Une place prise : `blocked` (`seat-taken`).
- `{action: "alight"}` : la portière s'ouvre, il descend devant elle (ou à côté de sa place, sur une case libre), `alight`, elle se referme. Tout ordre de déplacement (`x, z`, `target`, `vx`) fait descendre d'abord.
- Poses à bord : `drive` (assis, mains au volant ou aux rênes : voitures, tracteur, carrosse, train), `ride` (à califourchon, pieds dans le vide ; sur le vélo, les pieds pédalent), `row` (barque : le rameur tourne le dos à l'avant et rame), `sit` (passagers), debout (montgolfière ; charrette : il marche entre les brancards en la tirant). Montures : à cru, ancre `seat.rider` sur le dos.
- L'occupant suit sa place dans le repère du véhicule ; `state-out.actors.<id>` porte `vehicle`, `seat`, `boarding`.

**Conduire vers une destination** : `{action: "drive", to}` sur le conducteur (assis à la place du conducteur ; reçu pendant la montée, l'ordre attend qu'il soit assis ; sinon `blocked` `not-driver`). `to` : `{x, z}` ou `[x, z]`, id de zone (centre), id d'objet (arrêt devant son emprise) ou d'acteur ; `speed` (m/s), `run` (monture au galop). Itinéraire : par les routes et chemins de la recette (`paths`, routes du monde infini) quand elles rapprochent (gabarit compatible : une voiture ne prend pas un sentier, le vélo si), sinon par la grille de navigation élargie au gabarit ; bateaux par l'eau (eau du terrain ou mare, bassin, piscine ; une cible à terre : on accoste au plus près) ; train le long de sa voie ; montgolfière en ligne droite, elle s'élève en route et se pose à l'arrêt. Le véhicule suit l'itinéraire en visant un point devant lui, accélère et freine en douceur (vitesse bornée par les virages et la distance d'arrêt), recule pour une cible proche derrière lui, puis `arrive` `{actor, vehicle, x, z, target}`. Coincé 6 s : un nouvel itinéraire, puis `blocked` (`wall` ou `stuck`).

**Commande directe** : clé `drive` `{<id>: {throttle, steer, brake}}` (manette, curseurs) ; prioritaire sur l'itinéraire tant qu'une valeur est non nulle, retirer l'entrée laisse le véhicule s'arrêter en roue libre. Aucun conducteur n'est exigé. Modèle « bicyclette » : cap = vitesse × tan(braquage) / empattement ; braquage lissé, réduit à haute vitesse ; marche arrière avec `throttle` < 0 une fois arrêté.

| Sorte | Empattement | Braquage | Vitesse max | Milieu |
|---|---|---|---|---|
| `moderncar` / `van` / `bus` / `truck` | 2,6 / 3,05 / 7,8 / 5,1 m | 35 / 33 / 30 / 30° | 14 / 12 / 10 / 10 m/s | sol, portières |
| `tractor`, `car`, `carriage` | 2,2 / 2,2 / 1,75 m | 38 / 32 / 30° | 7 / 10 / 6 m/s | sol |
| `bicycle`, `handcart` | 1,04 / 1 m | 40 / 45° | 6 / 1,6 m/s | sol |
| `rowboat`, `sailboat` | 2 / 3,5 m | 40 / 30° | 2 / 4 m/s | eau |
| `balloon`, `locomotive` | 2 / 5 m | 60 / 0° | 3 / 12 m/s | air / rails (`structure` à ancres `end.0`, `end.1`) |
| montures `horse`, `deer`, `cow`, `bear` | 1,1 × longueur | 50 à 55° | 9 / 8 / 3 / 5 m/s | sol ; au pas, tourne sur place |

Échelle d'objet : empattement et gabarit suivent. Le `wagon` ne se conduit pas.

**Rendu** : caisse posée sur le relief (tangage, roulis), qui roule un peu vers l'extérieur des virages (le vélo se penche vers l'intérieur) et pique au freinage ; bateaux qui tanguent sur l'eau ; roues `wheel.N` qui tournent à la vitesse du sol et roues avant braquées (`steer.f*`) ; monture qui marche, trotte ou galope selon la vitesse.

**Collisions** : le véhicule s'arrête au contact (`bump`) des emprises du décor (bâtiments, mobilier, troncs des arbres, tronçons de clôture, garde-corps et piles d'ouvrages ; pas l'herbe, les fleurs, les petits objets bas ni les ballons), des autres véhicules, des bords de la scène, de l'eau (au sol) ou de la rive (bateaux). Il pousse les ballons (simulation simple) ; avec `physics`, il devient un corps cinématique pendant qu'il roule et pousse les corps dynamiques. À l'arrêt, son emprise reprend place dans la grille de navigation (les piétons le contournent) : un véhicule est un obstacle mobile, ni recomposé ni assombri au sol.

**Caméra** : `view: {camera: "follow", actor: "<véhicule>"}` (ou `follow: "<id>"`, ou l'acteur assis : la caméra suit son véhicule) : suivi doux derrière lui (position et cap lissés) ; un doigt tourne autour (décalage gardé), sans saut ni réinitialisation à la recomposition.

**Publication** : `state-out.vehicles` (voir plus haut) ; `ids[].affords` et `selection.affords` contiennent `board` et `drive` ; `selection.seats` (places, conducteur d'abord) et `selection.occupants` (`{place: acteur}`). Le glisser au doigt d'un véhicule (ou d'une monture) emmène ses occupants ; un passager saisi descend.

**Monde infini** : le véhicule conduit quitte sa tuile pour la séance (dessiné à part, parties comprises ; la tuile le retire à sa recomposition, sans écrire dans `tiles`) et roule d'une tuile à l'autre ; `infinite.follow` et `view.actor` peuvent viser le véhicule. Itinéraires par les tuiles chargées (160 m au plus, au-delà en ligne droite).

**Limites** : rendu 3D seulement (le vectoriel ignore les ordres de conduite) ; pas de selle (à cru) ; pas d'attelage (le carrosse n'a pas de chevaux attelés, le wagon ne suit pas la locomotive) ; le train suit une seule voie droite ; occupants assis droits (ils ne suivent pas le roulis) ; les véhicules ne s'arrêtent pas devant les piétons ; un véhicule conduit en monde infini revient à sa tuile si le monde est recomposé ; les véhicules déplacés d'une scène finie gardent leur pose et leurs occupants à la recomposition, pas leur itinéraire.

## Physique 3D (corps rigides)

Même moteur que le format monde de `sonic-3d` (Rapier, environ 1,5 Mo, **chargé seulement si la recette le demande** : clé
`physics` de la recette, ou `physics` sur une couche ou un point). Sans cette demande, rien ne change.

```json
{
  "size": [24, 16], "ground": { "relief": 0.3, "water": -0.4 },
  "physics": { "gravity": [0, -9.81, 0], "joints": [{ "type": "rope", "a": "caisses.1", "at": [0.2, 6, 0.1], "length": 1.5 }] },
  "layers": [
    { "id": "caisses", "gen": "prop.crate", "physics": { "body": "dynamic", "mass": 15 }, "place": { "at": [{ "x": 0, "z": 0, "y": 3 }, { "x": 0.2, "z": 0.1, "y": 4.2 }] } },
    { "id": "tonneaux", "gen": "prop.barrel", "physics": "dynamic", "place": { "grid": [3, 1], "spacing": [1.2, 1] } },
    { "id": "ballons", "gen": "ball.soccer", "count": 4, "place": { "cluster": [4, 2], "radius": 2 } },
    { "id": "chaises", "gen": "seat.chair", "physics": { "body": "dynamic", "restitution": 0.05 }, "place": { "at": [[-3, 2]] } }
  ]
}
```

**`physics` de la recette** : `true` ou `{gravity ([0, -9.81, 0]), ground (sol, défaut true), contactMin (impulsion
minimale d'un choc signalé, N·s, 0,5), hz (pas par seconde, 60), paused (corps endormis jusqu'au premier ordre ou
choc), joints, water (flottaison, défaut true), walls (bords de la scène, défaut true)}` ; les clés françaises du
format monde (`gravite`, `sol`, `frequence`, `pause`, `liaisons`) sont acceptées.

**`physics` d'une couche** (ou d'un point `at` : `{x, z, y, physics}`, prioritaire) : `"dynamic"` | `"static"` |
`"kinematic"`, `false` (aucun corps), ou un objet :

| Clé | Rôle |
|---|---|
| `body` | `dynamic` (défaut), `static` (obstacle aux réglages donnés), `kinematic` (suit sa pose, pousse sans être poussé) |
| `mass` | kg (sinon volume × `density`, 500 kg/m³ : le bois flotte) |
| `friction`, `restitution` | 0,6 ; 0,1 |
| `damping`, `angularDamping` | Freinage dans l'air et en rotation |
| `gravity` | Échelle de gravité (0 : flotte, -1 : monte) |
| `ccd` | Détection continue (objet rapide) |
| `lockRotation`, `lockPosition` | Axes bloqués (`["x", "z"]` : reste debout) |
| `shape` | `auto`, `box`, `sphere`, `capsule`, `cylinder`, `hull` (enveloppe convexe du maillage) |
| `vel` | Vitesse de départ [vx, vy, vz] (m/s) |
| `sleep` | `false` : ne s'endort jamais |

- `y` d'un point `at` : hauteur de départ au-dessus du sol (m) d'un corps dynamique (il tombe).
- Avec la physique de scène, **les ballons sont dynamiques par défaut** (masse, rebond et frottement publiés par le
  générateur, freinage au roulement) ; `physics: false` sur leur couche les rend à la simulation simple.
- Formes automatiques : ballon → sphère ; tonneau, poubelle, borne, bouche d'incendie… → cylindre ; assises, outils,
  véhicules, contenants, `assembly` → enveloppe convexe ; le reste → boîte du maillage. Un objet dynamique est toujours
  instancié (sa matrice est réécrite à chaque pas).
- Décor (sans `physics`) : boîtes des emprises procgen (bâtiments, objets), troncs des arbres, tronçons de clôture,
  garde-corps et piles, tabliers et marches des ouvrages en dalles ; herbe, fleurs, plantes basses et eau ne bloquent
  pas. Sol = relief (champ de hauteurs, une maille par mètre, 128 au plus par côté) ; bords de la scène fermés.
- Acteurs (personnages, animaux) : capsules cinématiques, ils poussent les corps en marchant ; un acteur qui vise un
  ballon dynamique (`kick`) le tire par la physique.
- Eau (`ground.water`) : poussée selon la part immergée et freinage ; `splash` à l'entrée.
- Prairies (`meadows`) : les corps qui bougent couchent les brins sur leur passage.
- Zones de la recette = capteurs : `enter` / `leave` `{zone, body, actor: null}` (`ball` en plus pour un ballon).
- 200 corps dynamiques au plus (les suivants restent fixes, signalé dans `issues`).

**Liaisons** (`physics.joints`, 200 au plus) : `{type, a, b, at, axis, limits, motor, length, stiffness, damping,
collide}` (ids d'objets ; `b` absent = accroché au monde au point `at`) : `hinge` (porte, roue, `limits` en degrés,
`motor: {speed (°/s), force}`), `ball` (rotule), `fixed`, `slider` (glissière, `limits` en m), `spring` (ressort),
`rope` (corde). Noms français du format monde acceptés.

**Piloter** : `kick` (ballons et tout corps dynamique : vitesse ajoutée), `forces.<id>` comme dans le format monde :
`vx vy vz` (vitesse imposée), `fx fy fz` (force continue, N), `torque`, `spin` (°/s), `wake: true`, `impulse: {n, x, y,
z | toward: [x, y, z], power, at}` (N·s), `set: {n, x, y, z, rx, ry, rz, vx, vy, vz}` ; `impulse` et `set` sont des
compteurs : la première lecture ne fait que mémoriser, chaque hausse de `n` agit une fois. Les ordres et coups arrivés
pendant le chargement du moteur sont joués à son arrivée.

**Requêtes** (`queries`) : rayon (premier objet touché, sol compris), sphère ou boîte (tout ce qui chevauche, 16 au
plus), `mask` (ids ou étiquettes : calque, générateur, `sol`, `acteur`, `bord`), `ignore` ; réponse à chaque hausse de
`n`, ou à chaque pas avec `live: true` (16 requêtes au plus).

**Recomposition** : la scène recomposée (après un `place`, un `edit`) reprend la pose courante des corps dont l'objet
et le point de départ n'ont pas changé (endormis) ; les autres repartent de la recette.

**Coût** : corps endormis gratuits ; quand tout dort (et sans acteur animé), plus aucune image n'est dessinée ni rien
publié. Pas fixes de 1/60 s (4 au plus par image). Rendu 3D seulement : en rendu vectoriel, la physique est ignorée
(signalé dans `issues`) et les ballons gardent leur simulation simple.

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
- Placement (`place`) : `at` (points ou `{x, z, yaw}` : un `yaw` donné est respecté), `across` (`{across: "riviere", distance, spacing}` : en travers d'une route ou d'une rivière, au milieu par défaut ou à `distance` m le long du tracé ; un pont y prend la longueur voulue si `length` n'est pas donné), `grid` (`[nx, nz]`, `spacing`), `poisson` (`true` ou boîte `[x0, z0, x1, z1]`, `minDist`), `along` (route, `side` `left|right|both|center`, `spacing`, `offset`, `jitter`, `start`, `end`), `cluster` (centre, `radius`), `ring` (centre, `radius`, `jitter`), `edges` (`buildings|paths|all` : touffes au pied des murs et en bord de route).
- Options de couche : `yaw` (`path`, `random`, `center`, `away` ou degrés), `scale`, `spacing`, `onPath`, `onWater` (bateaux), `walkable`, `behavior` (`idle|wander|patrol`, personnages), `action`, `target` (personnages et animaux : `"bassin.0"`, `"abreuvoir.0.spot"`, `"bancs.0.sit.0"` : chacun part posé à sa place, tourné vers elle, avec son `action` ; les places `spot.0`, `spot.1`… d'un objet sont réparties dans la couche). Un acteur de `actors` accepte aussi `target`.
- Retouches d'un calque (scène finie ; monde infini : clé `tiles`) : `moves` `{"<index>": {x, z, yaw?}}` replace l'objet de rang `index` (mètres, cap en degrés ; sans `yaw`, le cap tiré est gardé) et `remove` `[index…]` retire des objets. Appliquées **après** le tirage seedé : les autres objets du calque et des calques suivants restent exactement où ils étaient (la place d'origine d'un objet déplacé ou retiré reste prise pendant la composition, puis libérée), et chacun garde son `index`. L'objet déplacé est reposé sur le relief à sa nouvelle place, son emprise bloque la navigation là, et `selection` comme `ids` le donnent à cette place. Aucun contrôle de place libre à la composition (le glisser l'a déjà fait) ; rang inconnu : sans effet. Vaut aussi pour le rendu vectoriel (même composition).
- Ouvrages (`structure`) : ponts, pontons, quais, escaliers, rampes sont praticables (les acteurs y marchent à la hauteur du tablier, des marches, du palier ; la navigation passe au-dessus de l'eau) ; garde-corps, piliers et piles bloquent. Ils sont posés au plus bas de leurs appuis (les berges), pas au fond du lit.
- Les ids sont `<couche>.<rang>` et ne changent pas quand on modifie un autre objet.
- `wind` : force du vent (1 par défaut, 0 = calme) ; `windDir` : direction vers laquelle il souffle (°, 0 = vers +z, 90 = vers +x ; 67 par défaut). Feuillages et touffes souples (`grass`, `flowers`…) ondulent avec `wind` ; les prairies, tissus et mèches simulés suivent aussi `windDir` (voir Tissus et mèches).

### Prairies (`meadows`)

Herbes hautes, champs de blé, roseaux, prairies fleuries et gazon en **brins instanciés** semés sur une zone : le portage dans `sonic-procgen` des `herbes` du format monde de `sonic-3d` (même semis, même forme de brin, même vent et même ploiement, code commun dans `shared/monde/herbes.ts`).

```json
"wind": 1.2, "windDir": 70,
"meadows": [
  { "kind": "ble", "zone": [4, -15, 21, -4] },
  { "kind": "fleurs", "zone": [[-21, -15], [-2, -15], [-3, -2], [-21, -1]], "flowers": ["#f2d64b", "#e86a6a"] },
  { "kind": "herbe", "density": 160 },
  { "kind": "roseau", "zone": "berge", "height": [1.6, 2.4] }
]
```

- `kind` (ou `type`) : `herbe` (herbes hautes, défaut), `ble` (blé à épis), `roseau` (roseaux à massettes), `fleurs` (prairie fleurie : une tige sur trois porte une corolle), `gazon` (herbe rase dense) ; alias anglais `grass`, `wheat`, `reeds`, `flowers`, `lawn`. Sorte inconnue : champ ignoré, `issue` `meadows.N`.
- `zone` : rectangle `[x0, z0, x1, z1]`, polygone `[[x, z]…]` (64 points au plus), id d'une zone de `zones` (boîte ou cercle) ; absente : toute la scène. Ramenée aux bords de la scène.
- `density` (brins par m², 1 à 3000), `height` (m : `[mini, maxi]` ou un nombre), `base` / `tip` (couleurs du pied et de la pointe), `flowers` (couleurs des corolles), `width` (largeur du brin, m), `sway` (souplesse au vent, 0 à 2), `bend` (`false` : ne se couche pas au passage), `clear` (`false` : pousse aussi sous les objets), `seed`. Les clés françaises du format monde (`densite`, `hauteur`, `pied`, `pointe`, `fleurs`, `largeur`, `souplesse`, `plie`, `degage`, `graine`) sont acceptées. Défauts par sorte : ceux du format monde (`herbe` 220 brins/m², 0,35–0,8 m ; `ble` 260, 0,8–1,15 m ; `roseau` 90, 1,4–2,3 m ; `fleurs` 180, 0,25–0,6 m ; `gazon` 600, 6–14 cm). Les nombres acceptent les expressions `"= …"`.
- **Sol libre** : rien sur les routes, trottoirs, rivières et chemins de terre (bord compris), ni sous l'eau, ni sous les objets qui ne se traversent pas (bâtiments, objets, tronçons de clôtures et garde-corps ; sous un arbre, seul le tronc), sauf `clear: false`. Les couches `walkable` (touffes `grass`, `flowers`) et les acteurs n'en retirent rien. Brins posés sur le relief.
- **Vent et passage** : ondulation en rafales selon `wind` et `windDir`, multipliée par `sway` ; les brins se couchent autour des acteurs, de l'objet glissé (pendant le geste et sa retombée) et des ballons qui roulent (8 au plus, les plus proches du point visé). Le semis ne bouge pas pendant un glisser : la place libérée reste dégarnie jusqu'à la recomposition (`place` recopié dans la recette).
- **Style** : brins dessinés par les shaders de la scène (bandes, brume, nuit, ombres reçues du décor, finis) ; couleurs accordées au style comme les rôles, et, sans `base` / `tip` / `flowers` donnés, teintées par l'herbe de la palette (`automne`, `neige`, `desert`…). Pas de contour sur les brins ni à leur contact (des milliers de traits sinon).
- **Densité** : `meadowDetail` (clé de recette) `0`, `1`, `2` ou `auto` (défaut : 0 sur mobile — écran tactile ou petit —, 1 sinon) fixe le plafond de brins de toute la scène (20 000, 60 000, 160 000), partagé entre les champs au prorata ; un champ qui dépasse sa part est semé moins dense, uniformément.
- **Coût** : rien sans `meadows`. Avec : un appel de dessin par champ (maillage instancié, 12 à 24 triangles par brin), vent et ploiement dans le shader de sommet (le CPU ne pousse que l'horloge, le vent et 8 positions par image), pas d'ombre portée par les brins (passe d'ombre sans eux), pas de sélection (les touchers traversent la prairie). Semis à la composition : une grille du sol semable et des emprises par case, quelques dizaines de ms. Une prairie au vent impose un rendu continu (comme les feuillages souples ; `anim.play: false` le suspend).
- **Rendu vectoriel** : les prairies sont ignorées (une `issue` `info` le signale) ; pour un équivalent dessiné, semer des touffes `grass` / `flowers` ou des `plant.tallgrass` / `plant.reeds`, qui ont leur dessin vectoriel.

## Monde infini

Une recette avec `infinite` n'a pas de bords : sol, routes et couches sont composés **par tuiles** carrées autour d'un point suivi, chargées devant lui et relâchées derrière. Même graine → même monde, quel que soit le chemin parcouru.

```json
{
  "infinite": { "tile": 32, "radius": 2, "follow": "heros", "seed": "campagne",
    "roads": [{ "id": "routes", "kind": "road", "width": 3.6, "spacing": 112, "density": 0.75 },
              { "id": "chemins", "kind": "path", "width": 1.6, "spacing": 48, "density": 0.45, "wiggle": 0.35 }],
    "persist": 400 },
  "ground": { "relief": 2.2, "scale": 38 },
  "layers": [
    { "id": "arbres", "gen": "tree", "place": { "scatter": { "cell": 7, "density": "= clamp(noise(x / 70, z / 70) * 1.6, 0, 0.9)" } } },
    { "id": "herbes", "gen": "grass", "walkable": true, "place": { "scatter": { "cell": 3, "density": 0.45 } } },
    { "id": "bornes", "gen": "prop.milestone", "place": { "along": "routes", "side": "left", "spacing": 40 } },
    { "id": "puits", "gen": "prop.well", "place": { "at": [[6, 5]] } }
  ],
  "actors": { "heros": { "at": [0, 0] } },
  "view": { "camera": "follow", "actor": "heros" }
}
```

Scène de bibliothèque : `scene: "campagne"`.

| `infinite.` | Rôle |
|---|---|
| `tile` | Côté d'une tuile (m, 8 à 128, défaut 32) |
| `radius` | Rayon de chargement en tuiles (1 à 4, défaut 2) ; réduit d'une tuile en qualité basse |
| `follow` | Id d'acteur de `recipe.actors` autour duquel charger, ou `camera` (centre de la vue : `view.cx`, `view.cz`) |
| `seed` | Graine du monde (défaut : `seed` de la scène) |
| `roads` | Réseau(x) de routes du monde (4 au plus) : `{id, kind: road\|street\|path\|river\|plaza, width, sidewalk, spacing (m entre carrefours), density (part des tronçons tracés), wiggle (sinuosité 0 à 0,45)}` ; tronçons `<id>.<i>_<j>_<h\|v>` |
| `persist` | Retouches persistées au plus, tout le monde confondu (défaut 400, `{total}` accepté) |
| `budget` | Composition sur le fil principal par image (ms, défaut 4 ; 2,5 sur mobile) |
| `quality` | `auto` (défaut : rayon réduit sur mobile ou quand la densité de pixels a dû baisser), `low`, `high` |
| `step` | Pas du maillage de sol (m, défaut 1) |

- **Sol** : relief en coordonnées du monde (même `ground.relief`, `scale`, `mountains`, `water` qu'une scène finie ; ni côte ni socle) : deux tuiles voisines se raccordent sans couture. Au-delà des tuiles chargées, un sol lointain grossier (relief brut) s'étend sous le brouillard : jamais de bord du monde ni de trou pendant qu'une tuile se compose.
- **Routes** : un nœud par cellule de `spacing` m (à désordre), une route entre nœuds voisins selon `density` ; chaque tronçon a les mêmes points vus de toutes les tuiles (chaussée raccordée), dessiné par la tuile qui contient chaque bout. `paths` de la recette (coordonnées du monde) s'y ajoutent.
- **Couches** : `place.scatter` `{cell, density, jitter}` sème sur une grille du monde (un candidat par cellule, graine par cellule, `density` nombre ou expression avec `x`, `z`, `h`) : sans couture ni chevauchement entre tuiles. `along: "routes"` suit tous les tronçons du réseau. `at`, `grid`, `cluster`, `ring` sont ancrés au monde (seuls les points de la tuile y sont posés, `at` garde son rang : `puits.0`). `poisson` et `edges` tirent `count` objets **par tuile**. Personnages et animaux : dans `recipe.actors` seulement (les couches d'acteurs sont ignorées, signalé).
- **Ids** : `<couche>.<cx>_<cz>_<rang>` (stables : revenir sur une tuile redonne les mêmes objets), `<couche>.<rang>` pour `at`.
- **Collisions** : les acteurs marchent sur le relief et les tabliers des tuiles, leur navigation passe par les grilles des tuiles chargées (chemin recousu sur 160 m au plus ; au-delà, ligne droite) ; `{vx, vz}` s'arrête contre un obstacle (`blocked`) ; le glisser range l'objet contre le peuplement de toutes les tuiles chargées.
- **Édition au doigt** : tout objet d'une tuile se glisse (avec `drag`), d'une tuile à l'autre. Au lâcher, `place` porte en plus `tile` (`"cx,cz"` d'arrivée), `tiles` (toutes les retouches, déjà bornées) et `persist: {count, total, dropped}` : **le reducer recopie `payload.tiles` dans la clé `tiles`** (rien d'autre à calculer). Le composant garde aussi sa copie (publiée dans `state-out.tiles`) : une tuile relâchée puis rechargée garde la pose même sans store. `placeFree` porte `tile` : pour un nouvel objet, ajouter `{id, gen, params, x, z, yaw}` à `tiles."cx,cz".add`.
- **Retouches** (`tiles."cx,cz"`) : `remove` (ids), `move` (`{id: {x, z, yaw (°)}}`), `add` (`[{id, layer, gen, params, x, z, yaw, scale}]`), `t` (instant). Un objet déplacé dans une autre tuile y est ajouté et retiré de la sienne. Le total est borné par `persist` : au-delà, les tuiles **les plus éloignées** du point suivi sont oubliées d'abord (à distance égale, la plus ancienne), la tuile qu'on vient de retoucher jamais : le total se répartit sur les tuiles proches.
- **Fluidité** : les tuiles se composent les plus proches d'abord, deux en file au plus ; sur le fil principal, par tranches (une étape par objet neuf, `budget` ms par image) ; dans un **worker** si l'application en fournit un (voir CSP). Une tuile au plus est envoyée à la carte graphique par image ; une tuile retouchée reste affichée jusqu'à l'arrivée de la nouvelle. Les objets répétés de toutes les tuiles partagent un maillage instancié par asset (un appel de dessin par asset) ; herbes, fleurs, plantes et petits objets ne sont dessinés que sur les tuiles voisines (plus les buissons en qualité basse) ; ombres et brouillard suivent le point suivi.
- Limites : physique 3D (`physics`) et prairies (`meadows`) des scènes finies seulement (ignorées, signalé) ; rendu 3D seulement (en rendu vectoriel, la recette est composée comme une scène finie, signalé) ; les ballons semés dans les tuiles sont du décor immobile ; `zones` et `target` d'acteur au départ visent des coordonnées ou les objets de `recipe.actors`, pas ceux des tuiles (un acteur peut ensuite marcher vers un objet chargé : `{target: "puits.0"}`).

## Générateurs

Table générée depuis les schémas (`generatorCatalog()`). Raccourcis : `prop.lamp`, `animal.horse`, `tree.oak`, `plant.fern`, `vehicle.sailboat`, `ball.soccer`, `seat.parkbench`, `tool.rake`, `container.basket`, `street.roadsign`, `pet.kennel`, `structure.bridge`, `water.pond`, `textile.flag`, `vehicle.bus`, `animal.pigeon`…

| `gen` | Description et paramètres (`auto` = tiré de la graine) |
|---|---|
| `character` | Humanoïde skinné (quaternions duaux) : proportions par archétype et silhouette variée, tête et mains fines (4 doigts + pouce, prise refermée sur l'objet), visage paramétrique (yeux, iris, sourcils, nez, lèvres, oreilles, barbe, moustache, lunettes, rides, taches de rousseur, grains de beauté, bijoux), garde-robe en couches (cols, gilets, vestes, tablier, salopette, robe, plastron, ceinture, boutons, poches, gants, bottes, motifs), 16 coiffures, 15 couvre-chefs, rôles sociaux qui biaisent les tirages. Bords de couleur nets. Animé par la scène. Paramètres : `role` (auto\|villager\|merchant\|guard\|noble\|sailor\|farmer\|wizard\|worker\|child\|traveler\|scholar\|cook), `figure` (auto\|feminine\|masculine\|androgynous), `height`, `archetype` (chibi\|cartoon\|stylized\|heroic\|realistic), `age` (auto\|child\|teen\|adult\|elder), `build`, `shape`, `headSize`, `belly`, `body`, `variation`, `skin`, `hair` (auto\|none\|shaved\|crop\|short\|sidepart\|bob\|wavy\|long\|ponytail\|lowtail\|bun\|topknot\|pigtails\|braids\|curly\|afro\|mohawk), `hairColor`, `headShape` (auto\|round\|oval\|square\|long), `eyes` (auto\|round\|almond\|narrow\|sleepy\|big), `eyeColor`, `brows` (auto\|none\|thin\|straight\|arched\|thick\|bushy), `nose` (auto\|button\|long\|aquiline\|wide\|upturned), `lips` (auto\|thin\|medium\|full), `ears` (auto\|small\|round\|large\|pointed), `animal` (none\|custom\|cat\|fox\|dog\|bear\|rabbit\|mouse\|pig\|owl\|frog\|dino\|lion\|tiger\|panda\|koala\|raccoon\|monkey\|cow\|sheep\|deer\|horse\|elephant\|duck), `animalSpec`, `beard` (auto\|none\|stubble\|short\|full\|goatee\|long\|chinstrap), `mustache` (auto\|none\|thin\|pencil\|walrus\|handlebar), `glasses` (auto\|none\|round\|square\|half), `freckles` (auto\|none\|light\|strong), `moles` (auto\|none\|light\|strong), `jewelry` (auto\|none\|earrings\|necklace\|nosering\|all), `blush` (auto\|none\|light\|strong), `wrinkles` (auto\|none\|light\|strong), `top` (auto\|none\|tee\|long\|tank\|sweater\|shirt\|tunic\|coat\|robe\|dress), `bottom` (auto\|trousers\|shorts\|skirt\|longskirt\|overalls), `over` (auto\|none\|vest\|jacket\|apron\|armor), `collar` (auto\|none\|round\|shirt\|turtle), `belt` (auto\|none\|belt\|sash), `details` (auto\|none\|buttons\|pockets\|full), `gloves` (auto\|none\|gloves), `pattern` (auto\|plain\|stripes\|vstripes\|checks), `shoes` (auto\|shoes\|boots\|tallboots\|sandals\|barefoot), `hat` (auto\|none\|cap\|beret\|tophat\|wizard\|straw\|helmet\|crown\|beanie\|bandana\|turban\|cowboy\|flowers\|tricorn\|toque\|hood), `bag` (auto\|none\|backpack\|satchel\|cape\|scarf\|pouch), `cape` (none\|short\|long), `soft` (none\|cloth\|hair\|all), `item` (auto\|none\|staff\|sword\|lantern\|book\|umbrella\|torch\|flower\|mug\|spear\|hammer\|pitchfork\|wand\|tool.hammer\|tool.mallet\|tool.sledgehammer\|tool.axe\|tool.pickaxe\|tool.shovel\|tool.spade\|tool.rake\|tool.leafrake\|tool.hoe\|tool.pitchfork\|tool.broom\|tool.besom\|tool.mop\|tool.scythe\|tool.saw\|tool.trowel\|tool.wrench\|tool.screwdriver\|tool.paintbrush\|tool.paintroller\|tool.crowbar\|tool.fishingrod\|tool.machete), `mood` (neutral\|happy\|sad\|angry\|surprised\|sleepy), `outfit`, `colors`, `shirtText`, `shirtName`, `shirtNumber`, `detail` (auto\|high\|crowd) |
| `animal` | Quadrupèdes et oiseaux d'une seule peau, skinnés (quaternions duaux) : 15 espèces (dont pigeon et goéland posés), robes par graine (uni, tacheté, pie, rayé), cornes, bois, crinière, laine, yeux avec clignement. Animés par la scène (repos, marche, trot, galop, hochement des oiseaux). Paramètres : `species` (dog\|cat\|horse\|cow\|sheep\|pig\|fox\|rabbit\|deer\|goat\|bear\|duck\|chicken\|pigeon\|seagull), `size`, `build`, `coat` (auto\|solid\|spotted\|pie\|striped), `palette`, `variant`, `mood` (calm\|alert\|happy\|tired\|grazing), `colors`, `detail` (auto\|high\|crowd) |
| `tree` | Arbre ramifié (tronc et branches soudés, canopée en grappes ajourées à contour dentelé, branches visibles entre les masses). Espèces : oak (chêne), beech (hêtre), maple (érable), birch (bouleau), willow (saule), poplar (peuplier), cypress (cyprès), stonepine (pin parasol), olive (olivier), cherry (cerisier en fleurs), fruit (fruitier), pine, fir (sapin), palm (palmier), dead (arbre mort). Saisons : spring, summer, autumn (teintes mêlées), winter (branches nues, neige sur les conifères). Paramètres : `species` (oak\|beech\|maple\|birch\|willow\|poplar\|cypress\|stonepine\|olive\|cherry\|fruit\|pine\|fir\|palm\|dead), `height`, `density`, `season` (spring\|summer\|autumn\|winter), `variant` |
| `bush` | Buisson en masses implicites, fleuri ou non, ou arbuste taillé : shape = round (libre), ball (boule), cone (topiaire), box (cube de buis), cloud (nuages taillés à la japonaise), spiral (topiaire en spirale). Paramètres : `size`, `flowers`, `shape` (round\|ball\|cone\|box\|cloud\|spiral), `variant` |
| `grass` | Touffe de brins (lames effilées), souple au vent. À semer en nombre aux raccords (pied des murs, bords de route). Paramètres : `size`, `blades`, `flowers`, `variant` |
| `flowers` | Parterre de fleurs sur tiges, souples. kind = mixed, round (pompons), daisy (marguerites), tulip (tulipes), spike (épis : lupins, lavande), bell (clochettes). Paramètres : `size`, `count`, `kind` (mixed\|round\|daisy\|tulip\|spike\|bell) |
| `rock` | Minéral : kind = boulder (rocher taillé par plans, en groupe, enfoui), pebbles (galets roulés), cliff (falaise à strates), slab (dalle plate), steps (pas japonais en file), scree (éboulis). Paramètres : `kind` (boulder\|pebbles\|cliff\|slab\|steps\|scree), `size`, `pieces`, `sharpness`, `flat`, `moss`, `variant` |
| `plant` | Plantes et débris naturels instanciables : fern (fougère), tallgrass (herbes hautes à épis), reeds (roseaux et massettes, bord d'eau), waterlily (nénuphars, onWater), mushrooms (champignons), stump (souche), log (tronc couché moussu), cactus, bamboo (bosquet de bambous), ivy (lierre plaqué contre un mur en −z ; placement edges + yaw path), lavender (touffe de lavande). Paramètres : `species` (fern\|tallgrass\|reeds\|waterlily\|mushrooms\|stump\|log\|cactus\|bamboo\|ivy\|lavender), `size`, `variant` |
| `building` | Maison ou édifice par grammaire de découpe : corps, ailes, appentis, tourelles, porches, perrons ; fenêtres (rectangulaires, plein cintre, segmentaires, à meneaux, ogives, œils-de-bœuf), volets pleins ou persiennes, petits bois, jardinières, balcons en ferronnerie, corniches à modillons, gouttières ; toits à deux pans (coyaux), pignon sur rue, croupe, mansarde, monopente, terrasse, pavillon. Matériaux : enduit, pierre appareillée, brique, bardage, colombages ; tuile, ardoise, chaume, zinc, lauze. Styles : bourg, colombages, vapeur, moderne, neon, chaumiere, pierre, ferme, chalet, mediterraneen, japonais, chateau, tour, moulin, chapelle, phare, boutique. Chaque graine donne une maison distincte. Ancres : door, roof, `chimney.N` (sortie de chaque conduit : fumée des cheminées), `door.handle` ; parties `door`, `shutter.N` (voir Parties et états). Paramètres : `style` (bourg\|colombages\|vapeur\|moderne\|neon\|chaumiere\|pierre\|ferme\|chalet\|mediterraneen\|japonais\|chateau\|tour\|moulin\|chapelle\|phare\|boutique), `floors`, `bays`, `depth`, `roof` (auto\|gable\|pignon\|hip\|mansard\|flat\|shed), `walls` (auto\|enduit\|pierre\|brique\|bardage\|colombages), `roofing` (auto\|tuile\|ardoise\|chaume\|zinc\|lauze), `shop`, `sign`, `trade` (auto\|boulangerie\|patisserie\|cafe\|bar\|restaurant\|hotel\|epicerie\|librairie\|fleuriste\|boucherie\|fromagerie\|poissonnerie\|pharmacie\|coiffeur\|quincaillerie\|tabac\|cinema\|banque\|poste\|garage), `balconies`, `shutters`, `ornament`, `annexes`, `decay`, `chimneys` |
| `prop` | Objet de décor instanciable : lamp, bench, crate, barrel, well, campfire, tent, cart, stall, signpost, lantern, fence, haystack, bollard, planter, statue, mailbox, boat, fountain, kiosk, busstop, billboard, pillar, bin, lamp2, clock, hydrant, awningstall, baskets, fruitcrates, sacks, wheelbarrow, wateringcan, beehive, scarecrow, birdhouse, pergola, greenhouse, table, chair, parasol, hanginglantern, garland, hangingsign, milestone, puddle, townsign, streetsign. Paramètres : `kind` (lamp\|bench\|crate\|barrel\|well\|campfire\|tent\|cart\|stall\|signpost\|lantern\|fence\|haystack\|bollard\|planter\|statue\|mailbox\|boat\|fountain\|kiosk\|busstop\|billboard\|pillar\|bin\|lamp2\|clock\|hydrant\|awningstall\|baskets\|fruitcrates\|sacks\|wheelbarrow\|wateringcan\|beehive\|scarecrow\|birdhouse\|pergola\|greenhouse\|table\|chair\|parasol\|hanginglantern\|garland\|hangingsign\|milestone\|puddle\|townsign\|streetsign), `size`, `variant`, `text` |
| `vehicle` | Véhicule instanciable : carriage (carrosse), bicycle (vélo), car (voiture ancienne), rowboat (barque), sailboat (voilier), balloon (montgolfière), handcart (charrette à bras), et sur la grammaire de pièces (même modèle en 3D et en vectoriel) : moderncar (voiture moderne), van (fourgonnette), bus, truck (camion : caisse fermée ou benne selon la variante), tractor (tracteur), wagon (voiture de voyageurs ou wagon de marchandises selon la variante), locomotive (à vapeur). Barque et voilier : couche `onWater`. Wagon et locomotive : `onRails` les pose sur une voie `structure.rails` (même point, même cap). Couleur de caisse : paint (auto = selon la variante ; couleurs franches pour les véhicules modernes). Ancres : light (montgolfière), seat (conducteur), front, back ; véhicules modernes : `seat.driver`, `seat.N`, `approach.door.*` et parties mobiles (voir Parties et états). Paramètres : `kind` (carriage\|bicycle\|car\|rowboat\|sailboat\|balloon\|handcart\|moderncar\|van\|bus\|truck\|tractor\|wagon\|locomotive), `paint` (auto\|accent\|cloth1\|cloth2\|leaf2\|water\|wood\|paper\|ink\|red\|orange\|yellow\|green\|blue\|purple\|white\|black), `size`, `variant`, `onRails` |
| `wall` | Clôture continue le long de `points` (coordonnées de scène ; placer la couche à l'origine : place {at: [[0,0]]}). kind = drystone (muret de pierre sèche à couronnement), coping (muret maçonné à chaperon), fence (piquets et lisses), picket (palissade à lattes), hedge (haie taillée), railing (grille de fer forgé sur mur bahut), bamboo (clôture japonaise). Drapé sur le relief, brèches et portillons selon `gaps`. Paramètres : `kind` (drystone\|coping\|fence\|picket\|hedge\|railing\|bamboo), `points`, `height`, `gaps`, `closed` |
| `emblem` | Écu en relief (heater, round, kite, banner, square) : partition, bordure, meuble. Se pose sur un mur ou se présente de face (vue `front`). Paramètres : `shape` (heater\|round\|kite\|banner\|square), `division` (plain\|per-pale\|per-fess\|per-bend\|quarterly\|chief), `charge` (none\|star\|circle\|cross\|chevron\|tower\|tree\|crescent), `field`, `tincture`, `metal`, `size` |

| `ball` | Ballons et balles à taille réelle (football 22 cm, basket 24 cm, tennis 6,7 cm, ballon de gym 65 cm…) avec leurs vrais motifs : panneaux, fuseaux, coutures en relief. Ovales (rugby, football américain) couchés sur le flanc. `diameter` change la taille (ballon géant, bille), `squash` l'écrase au sol (dégonflé), `color`/`color2`/`color3` prennent un rôle (red, orange, yellow, green, blue, purple, white, black, accent, cloth1…). Billard : `number` 0 (blanche) à 15. Publie `extra.affords` (kick, roll, bounce, throw, catch, hold…) et `extra.physics` {radius, mass, restitution, friction} ; ancres center, top, grip. Paramètres : `kind` (soccer\|basketball\|volleyball\|handball\|waterpolo\|rugby\|americanfootball\|tennis\|baseball\|cricket\|golf\|pingpong\|petanque\|cochonnet\|billiard\|bowling\|beach\|gym\|medicine\|bouncy\|marble\|playground), `diameter`, `squash`, `color`, `color2`, `color3`, `number`, `turn` |
| `seat` | Assises paramétriques (stool, barstool, chair, armchair, school, folding, rocking, highchair, throne, monobloc, bench, parkbench, pew, sofa, log, stonebench, deckchair, pouf, beanbag, swing, dogbed, perch) construites par pièces : même modèle en 3D et en vectoriel. `user` règle le gabarit (adult, child, toddler, giant, pet, gnome), `places` la longueur des bancs et canapés, `material` (wood, metal, plastic, stone, upholstered, wicker…), `back` (none, low, high), `arms` (yes, no), `color`/`color2` les rôles de l'assise et de la structure. Ancres `sit.N` (bassin assis) et `approach.N` (devant, au sol) ; un acteur `{target: "<id>.sit.0", action: "sit"}` va s'y asseoir. `extra.affords` : sit, lie, rock, swing, perch… Paramètres : `kind` (stool\|barstool\|chair\|armchair\|school\|folding\|rocking\|highchair\|throne\|monobloc\|bench\|parkbench\|pew\|sofa\|log\|stonebench\|deckchair\|pouf\|beanbag\|swing\|dogbed\|perch), `user` (adult\|child\|toddler\|giant\|pet\|gnome), `scale`, `places`, `width`, `material` (auto\|wood\|metal\|plastic\|stone\|upholstered\|wicker\|park\|log\|deckchair\|throne\|swing), `back` (auto\|none\|low\|high), `arms` (auto\|yes\|no), `cushion`, `color`, `color2`, `variant` |
| `assembly` | Objet composé par l'agent : `parts` = liste de pièces en mètres (y vers le haut, base au sol, avant = +z). Types : {t:'box', c:[x,y,z], h:[demi-côtés], rot?:[°x,°y,°z], role}, {t:'rod', a, b, r, r1?, role} (barre, pied), {t:'tube', pts:[[x,y,z]…], r, role} (barre courbe), {t:'lathe', c, profile:[[rayon, hauteur]…], role} (vase, seau, poteau tourné), {t:'blob', c, r:[rx,ry,rz], role} (coussin, sac, galet), {t:'plate', c, pts:[[x,y]…] convexe, d, rot?, role} (panneau, pignon, pointe de flèche ; une forme concave = plusieurs plaques). 80 pièces au plus. `anchors` : {nom: [x,y,z]} (ex. sit.0, grip, top) ; `affords` : ['sit', 'push', 'carry'…]. Exemples : brouette, seau, pelle, établi, niche, mangeoire, panneau, jouet. Paramètres : `parts`, `anchors`, `affords`, `label` |
| `tool` | Outils à taille réelle (hammer, mallet, sledgehammer, axe, pickaxe, shovel, spade, rake, leafrake, hoe, pitchfork, broom, besom, mop, scythe, saw, trowel, wrench, screwdriver, paintbrush, paintroller, crowbar, fishingrod, machete) : posés (`pose`: lying au sol, leaning appuyé — penché vers l'arrière de l'objet, à placer dos au mur —, upright planté). Un personnage peut en tenir un : `character.item: "tool.rake"` ; action d'usage `hammer`, `sweep` ou `dig` (voir `extra.use`). `color` = rôle du manche, `color2` = tête, `color3` = détail. Ancre grip. Paramètres : `kind` (hammer\|mallet\|sledgehammer\|axe\|pickaxe\|shovel\|spade\|rake\|leafrake\|hoe\|pitchfork\|broom\|besom\|mop\|scythe\|saw\|trowel\|wrench\|screwdriver\|paintbrush\|paintroller\|crowbar\|fishingrod\|machete), `pose` (lying\|leaning\|upright), `scale`, `color`, `color2`, `color3` |
| `container` | Contenants à taille réelle (crate, chest, cardboard, basket, bucket, sack, jar, amphora, pot, jerrycan, toolbox, suitcase, bag, pallet, wheeliebin, milkcan, cooler) sur la grammaire de pièces. `open` ouvre le couvercle au départ (coffre, caisse, caisse à outils, poubelle, glacière, carton, marmite, bidon, valise ; partie mobile `lid`, rabats `lid.f|b|l|r` du carton, réglable sans recomposer par la clé `states` ; sac : forme ouverte ; sans effet sur panier, seau, jarre…), `fill` le remplit — contenus permis selon le contenant, sinon laissé vide avec une issue — (apples, oranges, potatoes, sand, soil, grain, water, milk, logs, tools, hay, flowers, gold). `color`/`color2` = rôles du corps et des ferrures. Ancres top, grip (anse), inside, sit.0 (fermé, ou palette vide) ; `extra.affords` (carry, open, fill, pour, sit, stack, push…). Paramètres : `kind` (crate\|chest\|cardboard\|basket\|bucket\|sack\|jar\|amphora\|pot\|jerrycan\|toolbox\|suitcase\|bag\|pallet\|wheeliebin\|milkcan\|cooler), `open`, `fill` (none\|apples\|oranges\|potatoes\|sand\|soil\|grain\|water\|milk\|logs\|tools\|hay\|flowers\|gold), `scale`, `color`, `color2` |
| `street` | Mobilier urbain à taille réelle (streetlight, trafficlight, roadsign, streetsign, trafficcone, barrier, bikerack, recycling, phonebooth, picnictable, drinkingfountain, parkingmeter, electricbox, litterbin, manhole, hydrantpost), face lisible vers +z. `sign` choisit le panneau (stop, yield, noentry, limit, parking, crossing, danger, arrow, oneway, deadend), `state` la couleur du feu (red, orange, green, off), `count` le nombre d'arceaux. Le lampadaire éclaire la nuit (ancre light) ; la table de pique-nique a 4 places (sit.N). Complète prop (lamp, bollard, busstop, bench, mailbox…). Paramètres : `kind` (streetlight\|trafficlight\|roadsign\|streetsign\|trafficcone\|barrier\|bikerack\|recycling\|phonebooth\|picnictable\|drinkingfountain\|parkingmeter\|electricbox\|litterbin\|manhole\|hydrantpost), `sign` (stop\|yield\|noentry\|limit\|parking\|crossing\|danger\|arrow\|oneway\|deadend), `state` (red\|orange\|green\|off), `count`, `scale`, `color`, `color2` |
| `pet` | Objets pour animaux (kennel, bowl, trough, birdfeeder, birdcage, hutch, henhouse, cattree, scratchingpost, aquarium, birdbath, hayrack, litterbox, saddlerack) sur la grammaire de pièces. `for` (auto, dog, cat, horse, chicken, rabbit, bird : tailles de référence, bird ≈ petit oiseau) met l'objet à la taille de l'animal (une niche pour cheval est 2,6 fois plus grande ; échelle totale bornée à ×5 hors scène). Ancre `spot` : position de l'animal quand il mange, boit, dort ou se perche (pas celle de sa bouche) ; `approach` : où il arrive (devant l'entrée) — `target: <id>.spot` y mène ; `extra.affords` (shelter, sleep, eat, drink, perch, climb, scratch, lay…). Paramètres : `kind` (kennel\|bowl\|trough\|birdfeeder\|birdcage\|hutch\|henhouse\|cattree\|scratchingpost\|aquarium\|birdbath\|hayrack\|litterbox\|saddlerack), `for` (auto\|dog\|cat\|horse\|chicken\|rabbit\|bird), `scale`, `color`, `color2` |
| `structure` | Ouvrages praticables sur la grammaire de pièces (même modèle en 3D et en vectoriel) : bridge (pont : `form` arch = arc de pierre en dos d'âne, plusieurs arches au-delà de 16 m ; flat = tablier plat sur pieux avec rampes ; truss = poutres de métal en treillis), pontoon (ponton de planches sur pieux, échelle, taquets), quay (quai maçonné, front vers +z, bittes d'amarrage), stairs (escalier et palier : `height`, `steps`), ramp (rampe et palier), arch (arche : `form` round, pointed, torii), gate (portail à deux vantaux : `form` iron ou wood, `open` 0…1 = valeur de départ des parties `gate.l` / `gate.r`), rails (voie ferrée : ballast, traverses, rails). Passage selon z (entrées −z et +z), largeur selon x ; y = 0 au niveau des appuis. Pont : `length` (portée, m), `width`, `clearance` (hauteur libre au milieu au-dessus des berges : ≥ 2,5 m laisse passer une barque ou un voilier démâté) ; placé `{across: "<rivière>"}`, il enjambe la route ou la rivière (longueur ajustée à sa largeur si `length` n'est pas donné). `rails` (garde-corps). Les acteurs marchent sur le tablier, les marches et le palier à leur hauteur (la navigation passe au-dessus de l'eau) ; les garde-corps et piliers bloquent. Ancres : deck, top, entry.0 / entry.1, approach.0 / approach.1 (devant les entrées), under (sous le pont), pass (arche, portail), bottom / top (escalier), end, spot (bout du ponton, bord du quai : pêcher, boire), moor.N (amarrage), track, end.0 / end.1 (voie ferrée). `extra.affords` : walk, cross, pass-under, moor, fish, climb, pass, open… Paramètres : `kind` (bridge\|pontoon\|quay\|stairs\|ramp\|arch\|gate\|rails), `form` (auto\|arch\|flat\|truss\|round\|pointed\|torii\|iron\|wood), `material` (auto\|stone\|wood\|metal\|brick\|concrete), `length`, `width`, `height`, `clearance`, `steps`, `rails` (auto\|yes\|no), `open`, `depth`, `scale`, `color`, `color2`, `color3` |
| `sport` | Stade de football : `pitch` (terrain tracé, bandes de tonte, poteaux de corner, panneaux `boards`), `goal` (but et filet : `width`, `height`, `depth`), `stand` (tribune garnie : `length`, `rows`, `fill`, `color1` / `color2` maillots des supporters ; `ads` textes des panneaux). Utilisé par la clé `football` |
| `water` | Points d'eau sur la grammaire de pièces (même modèle en 3D et en vectoriel) : pond (mare naturelle, berge et pierres), basin (bassin maçonné à margelle, `shape` round ou rect), pool (piscine affleurante, margelle de dalles, frise, échelle), cascade (rochers en gradins, lames d'eau, écume, vasque au pied). `length` × `width` (m), `level` (eau sous le haut de la margelle, m), `rimHeight` (hauteur de la margelle), `rim` (largeur de la margelle), `height` (cascade). L'eau est posée sur le sol (le terrain n'est pas creusé). Ancres `spot.0`…`spot.3` (bord de l'eau, à son niveau : avant, droite, arrière, gauche ; `spot` = `spot.0`) et `approach.N` (au sol devant) : `{target: "<id>.spot.1", action: "drink"}` y fait boire un animal ou un personnage ; `center` ; cascade : `fall` (pied de la chute, embruns) et `fall.top`. `extra.affords` : drink, bathe, swim, fish, dive. Paramètres : `kind` (pond\|basin\|pool\|cascade), `shape` (auto\|round\|rect), `length`, `width`, `level`, `rimHeight`, `rim`, `height`, `variant`, `scale`, `color`, `color2`, `color3` |
| `textile` | Tissus simulés qui flottent au vent de la recette (`wind`, `windDir`) : flag (drapeau sur mât), banner (bannière pendue à une potence), pennant (fanion triangulaire), windsock (manche à air), laundry (corde à linge entre deux poteaux, `count` pièces, `length` portée), curtain (rideau à deux pans froncés sur tringle, `length` largeur ; à poser dos au mur). `fabric` : silk (léger, flotte), cotton, canvas (raide), wool (lourd). `color` = rôle du tissu, `color2` = mât ou poteaux. 3D : tissu simulé (figé en drapé de repos au-delà du plafond de tissus, au loin ou hors écran) ; vectoriel : forme figée. Ancre top. Paramètres : `kind` (flag\|banner\|pennant\|windsock\|laundry\|curtain), `fabric` (auto\|silk\|cotton\|canvas\|wool), `count`, `length`, `scale`, `color`, `color2` |
Ancres : personnages `head.top`, `head.center`, `hand.r.grip`, `hand.l.grip`, `back`, `chest.front`, `hip.l`, `hip.r`, `feet` ; animaux `head.top`, `back`, `mouth`, `feet` ; bâtiments `door`, `roof` ; lampes et feux `light` ; ballons `center`, `top`, `grip` ; assises `sit.N`, `approach.N`, `back` ; outils `grip`, `top` ; objets pour animaux `spot` (où l'animal mange, boit, dort, se perche), `top` ; contenants `top`, `grip`, `inside` (et `sit.0` s'il est assis) ; ouvrages `deck`, `top`, `entry.0` / `entry.1`, `approach.0` / `approach.1`, `under` (pont), `pass` (arche, portail), `bottom` (escalier), `end`, `spot`, `moor.N` (ponton, quai), `track`, `end.0` / `end.1` (voie ferrée) ; points d'eau `spot.0`…`spot.3`, `approach.N`, `center` ; véhicules à pièces `front`, `back`, `seat`.

### Texte et noms

Un texte s'écrit à l'identique en 3D (lettres en relief, peintes à plat sur un panneau, ou imprimées sur le tissu) et en vectoriel ; `\n` = retour à la ligne. Un texte laissé à `auto` est un nom généré par la graine (toujours le même pour la même graine) ; `none` n'écrit rien.

**Polices** (paramètre `font` des bâtiments et des objets, `shirtFont` des personnages, `adsFont` du terrain ; `auto` = choisie selon le style du bâtiment ou l'objet, toujours la même pour une graine) :

| `font` | Police | Usage |
|---|---|---|
| `procgen` | police à traits intégrée (capitales) | toujours disponible, repli |
| `inter` | Inter gras | signalétique, panneaux d'entrée de ville, plaques de rue |
| `playfair` | Playfair Display gras | boutiques chic, bourg |
| `slab` | Roboto Slab gras | enseignes, poteaux indicateurs |
| `pacifico` | Pacifico | néons, plage |
| `lobster` | Lobster | enseignes rétro, affiches |
| `fraktur` | UnifrakturMaguntia | châteaux, chapelles, tavernes |
| `rye` | Rye | western, ferme, vapeur |
| `stencil` | Black Ops One | pochoir, caisses, militaire |
| `pixel` | Press Start 2P | jeux rétro |
| `bebas` | Bebas Neue | maillots (défaut des noms et numéros), stade |
| `caveat` | Caveat gras | écriture manuscrite, ardoises |
| `bangers` | Bangers | bande dessinée, t-shirts |

Contours issus de Google Fonts (licence OFL), convertis par `scripts/build-procgen-fonts.mjs` ; chaque police n'est téléchargée que si la scène peut s'en servir (lu dans la recette), avant la composition. Crénage de la police compris, casse et accents gardés (sauf `procgen`, en capitales).

**Icônes** dans n'importe quel texte : `{nom}`, par exemple `"{croissant} Boulangerie"`, `"I {heart} Paris"`, `"Garage {car}"`. Environ 230 pictogrammes Lucide (licence ISC) : commerces (croissant, coffee, beer, wine, pizza, utensils, cake, ice-cream-cone, fish, beef, shopping-cart, store, scissors, pill, cross, book, flower…), transports (car, bus, bike, train-front, plane, ship, anchor, fuel, circle-parking…), signalétique (arrow-right, arrow-left, info, triangle-alert, ban, wifi, phone, map-pin, toilet…), lieux (house, hotel, church, castle, landmark, school, hospital, tent…), nature et météo (sun, cloud-rain, snowflake, leaf, tree-pine, mountain, waves…), sport et fête (trophy, medal, star, heart, music, ticket, party-popper…). Un nom inconnu est ignoré.

| Où | Paramètre | Rendu |
|---|---|---|
| `building` (vitrine `shop: true` ou style `boutique`) | `sign` (auto), `trade` | Enseigne en lettres en relief sur le mur au-dessus de la devanture ; un seul niveau : sur le bandeau (3D) ou peinte en haut de la vitrine (2D). Auto : « Boulangerie Martin », « Café du Port », « Chez Louise »… |
| `prop.townsign` | `text` (auto) | Panneau d'entrée de ville : fond blanc, cadre rouge, nom (« Saint-Hilaire-sur-Lys » passe sur deux lignes). |
| `prop.streetsign` | `text` (auto) | Plaque de rue bleue sur poteau (« Rue du Moulin »). |
| `prop.signpost` | `text` (auto) | Destinations séparées par `\|`, une par flèche (« Montvalon 4\|Le Pontoux 12 »). |
| `prop.billboard`, `prop.hangingsign`, `prop.milestone` | `text` (auto) | Affiche, mot de métier sur l'enseigne suspendue, distance sur la borne. |
| `character` | `shirtText`, `shirtName` (auto possible), `shirtNumber`, `colors.print` | Devant : texte (coupé en deux lignes s'il est long) et petit numéro ; dos : nom sous le col et grand numéro. Imprimés sur le vêtement, ils suivent ses mouvements ; couleur contrastée avec le haut par défaut. |
| `sport.pitch` | `ads` (auto) | Textes des panneaux publicitaires, tour à tour (`A\|B\|C`). En mode `football`, chaque joueur porte son numéro et un nom généré. |

### Objets du quotidien : ce que l'objet permet

`ball`, `seat` et `assembly` publient dans `selection` et dans `ids` leurs `affords` (ce que l'objet permet : `sit`, `lie`, `kick`, `roll`, `bounce`, `throw`, `catch`, `hold`, `carry`, `push`, `swing`, `rock`, `perch`…) ; la sélection d'un ballon ajoute `physics` `{shape, radius, length, mass, restitution, friction}`, celle d'une assise `seats` (`sit.0`, `sit.1`…) (unités SI) pour un jeu ou `sonic-physics`. Couleurs franches disponibles comme rôles : `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `white`, `black` (harmonisées par le style comme les autres rôles).

**Grammaire de pièces** : un objet absent du catalogue se décrit en données avec `assembly` (planche `box`, barre `rod`, tube courbe `tube`, tour `lathe`, coussin `blob`, plaque `plate` : polygone convexe `pts` [[x, y]…] extrudé d'épaisseur 2·`d`, face vers +z — panneau, pignon, flèche) ; rendu identique en 3D et en vectoriel, aucune évaluation de code. Exemple d'un seau : `{"gen": "assembly", "params": {"parts": [{"t": "lathe", "c": [0, 0, 0], "profile": [[0.1, 0], [0.14, 0.26]], "role": "red"}, {"t": "tube", "pts": [[-0.14, 0.25, 0], [0, 0.36, 0], [0.14, 0.25, 0]], "r": 0.006, "role": "metal"}], "anchors": {"grip": [0, 0.36, 0]}, "affords": ["carry", "fill"]}}`.

## Tissus et mèches

Capes, jupes et robes, écharpes, cheveux longs, drapeaux, fanions, manches à air, linge étendu et rideaux sont **simulés** en 3D : ils flottent au vent de la recette (`wind`, `windDir`, avec rafales), suivent les mouvements des acteurs (une cape traîne quand on court, une jupe s'écarte au pas) et ne traversent pas le corps (sphères posées sur les os : torse, épaules, bassin, jambes ; une cape passe par-dessus une robe). Même moteur que les pièces `souple` et `cheveux` du format monde (`shared/sim`).

- **Personnages** : `cape` (`short` aux cuisses, `long` aux chevilles) ajoute une cape en tissu simulé ; `soft` passe en simulation ce que le personnage porte déjà : `cloth` = cape de `bag`, pan d'écharpe (`bag: scarf`), jupes (`skirt`, `longskirt`), robes (`dress`, `robe`) et pans de manteau (`coat`) — un empiècement rigide reste à la taille, le tube souple pend dessous ; `hair` = `long` en mèches (masse courte sur le crâne, longueur en mèches), `ponytail` et `lowtail` (queue en mèches) ; `all` = les deux. Par défaut (`soft: none`, `cape: none`) l'aspect des personnages ne change pas. Les autres coiffures (tresses, couettes, chignons…) restent rigides.
- **Objets** : générateur `textile` (`textile.flag`, `textile.banner`, `textile.pennant`, `textile.windsock`, `textile.laundry`, `textile.curtain`), voir Générateurs.
- **Vectoriel** : forme figée (la cape et les cheveux du dessin, le tissu des textiles dans son drapé de repos en plaques), pas de simulation.
- **Budget** : 48 objets à tissus au plus par scène (`MAX_SOFT_OBJECTS` ; au-delà, leur drapé de repos est fusionné au décor, immobile). À l'image, seules les pièces visibles et d'au moins 14 px à l'écran sont simulées, les plus grandes d'abord, dans une limite de 9 000 points et 32 pièces (2 600 points et 10 pièces sur mobile) ; les autres sont figées et suivent leur acteur ou leur objet sans calcul de tissu, et reprennent sans à-coup quand elles redeviennent visibles. Rien n'est calculé quand l'animation est en pause (`anim.play: false`, `prefers-reduced-motion`). `status.soft` : `{pieces, active, points, ms}` (pièces, pièces simulées, points simulés, temps de calcul moyen par image).
- Ordres de grandeur (un cœur de portable, pas de 1/60 s) : drapeau ≈ 80 points ; personnage `soft: all` avec cape longue, robe, écharpe et cheveux longs ≈ 500 points ; corde à linge de 5 pièces ≈ 220 points.

## Émetteurs : projectiles et nuées

`emitters` (dans la recette, ou dans le DataProvider pour régler sans recomposer) fait naître, bouger et mourir des copies en masse sans que le reducer les connaisse une par une : projectiles (boules de feu, flèches, pierres, ballons lancés) et nuées (oiseaux, papillons, abeilles, poissons, rats, troupeau, foule légère). Même moteur et mêmes clés que les émetteurs du format monde de `sonic-3d` (`3d/monde.md`, Émetteurs), simulés à pas fixe dans des tableaux typés ; l'apparence vient des générateurs procgen ou de formes légères.

```json
"emitters": {
  "pigeons": { "gen": "animal.pigeon", "variants": 2, "max": 120, "spawn": { "count": 120, "area": [-20, -14, 20, 14] },
               "flock": { "altitude": [9, 14], "speed": [3, 5], "wander": 0.5, "bounds": [-24, -18, 24, 18] } },
  "feu": { "shape": "fireball", "from": "heros", "offset": [0, 1.3, 0.5], "speed": [14, 16], "gravity": 2, "life": 3,
           "mask": ["mur", "sol", "eau"], "onHit": "die", "events": ["exit"] },
  "fleches": { "shape": "arrow", "at": [-15, 2, 0], "dir": [1, 0.15, 0], "spread": 4, "speed": 25, "gravity": 9.8,
               "mask": ["batiment", "arbre", "sol"], "onHit": "stick", "life": 8, "max": 40 }
}
```

| Clé | Rôle |
|---|---|
| `gen`, `params`, `variants`, `lod` | Générateur procgen (`animal.pigeon`, `animal.seagull`, `animal.chicken`, `animal.sheep`, `ball.soccer`, `prop.crate`, `plant.mushrooms`, `character`…) et ses paramètres (expressions tirées par variante) ; `variants` : 1 (défaut) à 8 modèles différents, tirés au hasard par copie. Bâtiments, ouvrages, murs et points d'eau sont refusés (trop lourds). Animaux et personnages sont construits en maillage de foule (`detail: "crowd"`) ; `lod` : voir Allègement |
| `shape`, `size`, `color`, `color2` | Forme légère au lieu d'un générateur : `sphere`, `stone`, `fireball`, `arrow`, `dart`, `bird`, `butterfly`, `bee`, `fish`, `rat`, `leaf` ; `size` = longueur (m) ; `color`/`color2` = rôles (`red`, `fire`, `cloth1`, `ink`…) |
| `flap` | Cadence d'animation (cycles/s) : battement d'ailes, foulée, queue qui ondule ; défaut selon la forme (oiseau 4, abeille 18, poisson 2,5), 5 pour un animal en vol, 2,2 au sol, 0 : figé |
| `spin` | Culbute des projectiles (°/s) : pierre, ballon, hache lancée |
| `max`, `rate`, `life` | Copies vivantes au plus (2 000 par émetteur, 6 000 en tout ; pool plein : la plus ancienne est recyclée), naissances par seconde en continu, durée de vie (s, `0` : immortelle) |
| `from`, `offset`, `at` | Source : acteur ou objet nommé (`heros`, `maisons.2` : le tir part de lui et suit son cap, `offset` dans son repère), sinon le point `at` |
| `dir`, `spread`, `speed`, `gravity`, `drag` | Direction (repère de la source), écart (°), vitesse `[min, max]` (m/s), gravité (m/s²), frottement |
| `mask`, `radius`, `onHit`, `bounce`, `kills`, `push` | Ce qui est touché (voir Cibles), rayon de contact (m) ; `die` (défaut), `bounce`, `stick` (fiché), `pierce` ; `push` (N·s) lance le ballon ou le corps physique (Physique 3D) touché |
| `trail`, `burst` | Particules (voir Particules) : `trail` = id d'un système de `particles` semé par chaque copie en vol (fumée d'une boule de feu, poussière d'un troupeau ; son `rate` devient le débit par copie et il ne naît plus à sa propre source), `burst` = id d'un système lancé en salve au point de chaque touche (étincelles, éclaboussure) |
| `flock` | Nuée : `seek` / `flee` (acteur ou objet, `fleeRadius`), `speed`, `separation`, `cohesion`, `align`, `radius`, `wander`, `avoid` (étiquettes contournées, sinon `mask`), `bounds` `[x0, z0, x1, z1]`, **`altitude`** `[min, max]` (m au-dessus du relief : nuée en vol, oiseaux, papillons ; absente : au sol, posée sur le relief et les tabliers) |
| `on` | `false` : nuée ni au sol ni en vol, à la hauteur `at[1]` (poissons sous l'eau) |
| `spawn`, `scale`, `seed` | Semis initial `{count, area}`, taille `[min, max]` par copie, graine |
| `events`, `publish` | `["expire", "exit"]` : événements de fin de vie et de sortie ; `publish: N` : les N copies les plus proches de la cible (`seek`, `flee` ou `from`) dans `state-out.emitters` |
| `mobile` | Part des copies gardée sur mobile (0,05 à 1 ; défaut 0,5 : `max`, `spawn.count` et `rate` divisés par deux) |

**Cibles (`mask`)** : un objet par son id (`maisons.2`), son calque (`maisons`), son générateur (`building`, `tree`…), son espèce ou sorte (`prop.lamp`, `animal.sheep`) ou sa famille : `batiment`, `mur` (bâtiments, murs, clôtures), `cloture`, `arbre`, `vegetation`, `rocher`, `vehicule`, `ouvrage`, `objet`, `ballon`, `decor` (tous les objets) ; un acteur par son id ou `acteur`, `personnage`, `animal` ; `sol` (relief, tabliers des ponts), `eau` (surface de l'eau) ; le **nom d'un autre émetteur** (ses copies : tir sur une nuée de rats). Les objets sont des boîtes : emprise tournée, du sol à leur sommet (un corps de la physique 3D, à sa pose courante) ; une clôture ou un pont n'arrête un tir que par ses tronçons, garde-corps et piles ; herbes et fleurs se traversent. Un projectile qui quitte la scène (12 m au-delà du bord, ou 20 m sous le point le plus bas) meurt et compte dans `exited`. Monde infini (`infinite`) : le sol, l'eau et le peuplement des tuiles chargées comptent (boîtes refaites quand des tuiles arrivent ou partent), sans bord de scène (un projectile vit jusqu'au bout de sa `life`).

**Ordres** (clé `emit`) : `{"emit": {"feu": {"n": 3, "count": 1, "toward": "loup"}}}` : chaque hausse de `n` tire une salve de `count` copies (`at`, `dir`, `toward` : acteur, objet ou point `[x, y, z]`) ; `clear` (compteur) vide le pool ; `kill: {n, ids}` retire des copies. La première lecture ne fait que mémoriser les compteurs (un rechargement ne tire pas).

**Persistance** : les copies vivent hors DataProvider. Une recomposition (objet déplacé, paramètre changé) ou une relecture d'`emitters` qui ne change ni l'apparence, ni `max`, ni `spawn`, ni `seed`, ni `altitude` garde les copies en vol ; les réglages vivants (`speed`, `rate`, `mask`, cible…) s'appliquent tout de suite.

**Rendu et coût** : chaque variante est figée en 4 images (ailes battues, foulée, queue) calculées une fois ; une copie choisit son image selon le temps et sa propre phase. Une instanciation par image et par variante, quel que soit le nombre de copies : 4 appels de dessin pour une nuée d'une variante. Les copies ne portent pas d'ombre, ne se sélectionnent pas et n'apparaissent pas dans `ids`. Rien n'est calculé sans émetteur ; la scène ne tourne en continu que tant qu'une copie vit ou qu'un débit (`rate`) est donné. Sur mobile, moitié des copies (`mobile`). Rendu 3D seulement : en rendu vectoriel, les émetteurs sont ignorés (signalé dans `issues`).
**Allègement** (`lod`) : les copies d'un émetteur se partagent un budget de 80 000 triangles (40 000 sur mobile) ; au-delà, le modèle est allégé par regroupement de sommets (silhouette et couleurs gardées, détails fins fondus). Un pigeon de 160 copies passe ainsi à ≈ 500 triangles. `lod: N` impose N triangles par copie, `lod: false` garde le modèle entier. Les formes légères (`shape`) font 50 à 400 triangles et ne sont jamais allégées.

**Coût mesuré** (village, 160 pigeons en 2 variantes, 24 goélands, flèches et boules de feu) : +14 appels de dessin (150 → 164), ≈ +60 000 triangles ; simulation et matrices ≈ 2 ms par image pour 220 copies, 2,6 ms pour 560, 5 ms pour 1 560 (machine partagée, à diviser par deux environ sur un poste libre). Construction au premier montage : ≈ 0,3 à 1 s par variante d'animal ou de personnage (une fois, gardée en cache), quelques millisecondes pour une forme légère.

## Vrai 2D : illustration vectorielle

`render: "vector"` (clé du DataProvider ou attribut), ou un style vectoriel, bascule sur un rendu **Canvas 2D en courbes de Bézier** : aplats, traits à épaisseur variable, net à tout zoom. Même recette, mêmes ids, mêmes acteurs, mêmes événements ; la composition est bien plus rapide (pas de maillage). Personnages et animaux sont des traits continus suivant le même squelette animé (aucune jointure possible).

- Styles : `ligne-claire` (contour noir, aplats), `flat` (aplats et ombres portées en aplat), `gravure` (hachures et trames), `affiche` (palette réduite, grandes masses), `papier-decoupe` (calques à ombre douce). Variante d'ambiance : `"flat/nuit"`, `"ligne-claire/automne"`… (préréglage 3D après la barre), ou `{vector: "gravure", …jetons}`.
- Prairies (`meadows`) : ignorées, voir Prairies.
- Caméras : `side` (élévation, défaut) et `oblique` (cavalière) ; `front` donne `side`, `iso` / `perspective` / `top` donnent `oblique`, `follow` suit un acteur.
- Export : changer `exportSvg` (compteur) publie le SVG de la vue dans `state-out.svg` (sans script).

## Styles

Jetons (tous facultatifs, par-dessus `preset`) : `palette` (`gouache`, `brume`, `automne`, `printemps`, `desert`, `neige`, `crepuscule`, `nuit`, `neon`, `papier`, `abysses`), `hue` (°), `chroma`, `contrast`, `shading` (`flat|toon|soft|lit`), `bands` (2–4), `bandSoftness`, `brush`, `ssao` (occlusion ambiante en espace écran, 0,6 par défaut, 0 : aucune ; creuse plis, aisselles, cou, jonctions au sol), `outline` (px) et `outlineStrength` (contours : aucun par défaut, seuls les préréglages `encre` et `bd` en mettent ; donner l'un des deux suffit à les activer, l'autre prend 0,75 ou 1,6 px), `lightAzimuth`, `lightElevation`, `lightIntensity`, `shadows`, `shadowStrength`, `ao`, `texture`, `fog`, `fogHeight`, `night`, `lamps`, `rim`, `grain`, `paper`, `vignette`, `pixel` (taille du pixel, ou `{size, snap}`), `pixelSnap` (pixels accrochés au monde en vue orthographique, vrai par défaut), `post` (pile de post-traitement, voir Post-traitement), `postQuality` (`auto|low|high`), `saturation`, `sky`, `skyHorizon` / `skyTop` (couleurs du ciel, `""` : celles de la palette), `sunColor`, `ambientColor` (ciel ambiant), `ambient` (force de la lumière ambiante, 1), `environment` (reflets des finis : `exterieur` ciel et sol, `studio` pièce claire à deux boîtes à lumière, `aucun`), `meteo` (temps qu'il fait, deux au plus : `pluie`, `neige`, `feuilles`, `petales`, `brume` ; voir Ambiances), `ambiance` (voir Ambiances), `detail` (relief de surface et usure des arêtes, 0 = lisse), `roles` (`{"wall": "#e8d8c0"}`), `matieres` (finis par
rôle : `{"metal": "chrome", "cloth1": "velours", "roof": {"fini": "laque", "rough": 0.3}}` ; finis du format monde :
rugosité, métal, reflet de tissu, vernis ; reflet franc en `toon` ; finis texturés, verre et eau : voir Matières).

### Matières (`matieres`)

Finis par rôle, mêmes noms et réglages que les finis du format monde (`mat`, `satine`, `brillant`, `laque`, `plastique`, `ceramique`, `metal`, `brosse`, `chrome`, `miroir`, `verre`, `depoli`, `eau`, `tissu`, `velours`, `cuir`, `caoutchouc`, `bois`, `pierre`, `pave`, `brique`, `ecorce`, `rouille`, `cire`), rôles procgen ou du format (`maillot` → `cloth1`). Un objet part d'un fini (`fini`) et en change des valeurs : `rough`, `metal`, `clear`, `sheen`, `glass`, `ior`, `relief`, `profondeur`, `usure`, `occlusion` (0 à 1).

- **Finis texturés** (`pierre`, `pave`, `brique`, `ecorce`, `bois`, `cuir`, `tissu`, `velours`, `brosse`, `rouille`, `caoutchouc`, ou tout fini avec `relief`, `profondeur`, `usure` ou `occlusion` > 0) : cartes tirées d'un **motif** des textures du format (hauteurs : la seconde couleur du motif = les creux, comme les cartes de normales et ORM de `sonic-3d`), collé en mètres sur l'objet (projection selon les axes de l'objet, au repos : le motif suit le corps qui bouge). `relief` = bosses éclairées (joints, veines), `profondeur` = parallaxe (les joints semblent creusés quand on tourne autour), `usure` = bosses polies et creux mats (reflets), `occlusion` = creux assombris.
  - **Motif** : `motif` (ou `texture`) = une texture du format (`brique`, `pierre`, `dalles`, `gravier`, `bois`, `fourrure`, `ecailles`, `carrelage`, `parquet`, `beton`…, ou `{kind, seed}`), `echelle` = répétitions par mètre. Par défaut, celui du fini : `pierre` → `pierre` (0,7 /m), `pave` → `dalles` (3,5), `brique` → `brique` (2,5), `ecorce` → `fourrure` (0,8, sillons verticaux), `bois` → `bois` (1,5), `cuir` → `grain` (3), `tissu` → `tissu` (6), `velours` → `moquette` (3), `brosse` → `metal` (2), `rouille` → `bruit` (3), `caoutchouc` → `grain` (5) ; sinon celui du rôle (`road` dalles, `path` gravier, `stone` et `trim` pierre, `wall` béton, `roof` écailles, `wood` bois, `bark` fourrure, `metal`, tissus, `leather`…). Exemple : `{"wall": "brique", "road": "pave", "roof": {"fini": "brique", "motif": "ecailles", "echelle": 2.5}, "bark": "ecorce"}`. 8 motifs distincts au plus par scène.
  - `caoutchouc` : le format monde le définit comme un mat ; procgen lui ajoute un grain fin (`relief` 0,25, `occlusion` 0,2) pour le distinguer, sauf valeurs écrites.
- **Verre et eau** (`verre`, `depoli`, `eau`, ou `glass` > 0) : rendu opaque (pas de transparence dans procgen) : fond assombri teinté par la couleur du rôle, reflet de Fresnel du ciel selon `ior`, reflet du soleil selon la rugosité ; `eau` (`ior` < 1,4) ajoute des rides qui défilent. L'opacité (`opacity`) est ignorée.
- **Coût** : rien tant qu'aucun rôle n'a de fini texturé ni de verre (une seule condition uniforme dans le shader). Sinon, par pixel d'un rôle concerné : qualité haute 3 lectures (projection dominante) à 9 (surfaces courbes, trois projections fondues) + parallaxe (14 pas au plus, s'estompe avec la distance, coupée au loin) ; qualité basse (`postQuality` `low`, ou `auto` sur mobile) : projection dominante seule, 6 pas de parallaxe, motifs en 128 px au lieu de 256. Motifs calculés une fois (quelques ms chacun) au premier fini qui s'en sert.


Rôles de couleur : `ground grass path road stone wall trim roof wood bark leaf leaf2 flower water metal glass lamp cloth1 cloth2 cloth3 leather skin hair eye eyeWhite mouth accent ink paper snow fire`. La peau, les yeux et la bouche gardent la couleur du personnage quel que soit le thème.

Ciel (`sky`) : dégradé de l'horizon vers le haut, calé sur la direction de visée horizontale de la caméra (`render/horizon.ts`) : en orbite, l'horizon garde la même hauteur quel que soit le `yaw` (ligne de fuite du sol en perspective, point au sol dans l'axe de visée en vues orthographiques).

## Ambiances

Une ambiance règle d'un mot ce qu'un style demande en vingt jetons : lumière (soleil : intensité, couleur, hauteur, azimut ; ciel ambiant : force, couleur), ciel et brume, palette par rôle, finis par défaut des pièces fabriquées (`plastique`, `laque`…), style des modèles (préréglage procgen de l'ambiance), étalonnage de l'image (pile `post`) et météo. Ce sont les ambiances du format monde de `sonic-3d` (`shared/monde/ambiance.ts` : mêmes noms, mêmes alias — `cyberpunk`, `neon`, `fps`, `polar`, `pixel`, `peinture`, `reve`… —, même lecture), traduites en jetons procgen par `style/ambiance.ts`.

```json
{ "scene": "rue", "ambiance": "cyber" }
{ "scene": "village", "ambiance": { "base": "realiste", "ciel": "#f2c890", "lumiere": { "hauteur": 12 }, "meteo": "neige" } }
{ "scene": "village", "style": { "ambiance": "tableau", "lightAzimuth": 120, "post": [{ "fx": "vignette" }] } }
```

- **Où l'écrire** : clé `ambiance` du DataProvider (ou attribut, ou clé `ambiance` de la recette) : elle remplace le style de la recette, et le `style` du DataProvider la complète (un nom de préréglage passe par-dessus comme `preset`) ; ou jeton `ambiance` dans un style écrit.
- **Priorité** : défauts → ambiance → `preset` écrit → jetons écrits. Un style qui écrit tous ses jetons (un éditeur qui recopie tout l'état) efface l'ambiance : n'écrire que ce que l'utilisateur a changé.
- **Étalonnage** (`etalonnage` du format) → pile `post`, dans cet ordre : `kuwahara-aniso` (peinture, avec tramage et niveaux) → `silhouette` → `couleur` (saturation, noir et blanc, contraste, luminosité, `tint`) → `sepia` → `niveaux` (postérisation sans peinture) → `bloom` (halo ≥ 0,15) → `neon` (contours clairs et colorés) ou contours du style (contours sombres : jetons `outline`, `outlineStrength`, rôle `ink`) → `aberration` → `crt` (lignes de balayage, sans courbure) → `grain` (figé). Vignette, pixels (`pixel`) et occlusion (`ao`) passent par les jetons de l'image de base. Le grain du style est mis à 0 : une ambiance ne force jamais un rendu continu. Une pile `post` écrite s'ajoute après l'étalonnage (8 effets au plus en tout, au-delà coupés et signalés).
- **Correspondances** : intensité du soleil ÷ 1,6 (unités physiques de three → procgen), ambiante ÷ 0,55, brume `b` → `fog` = 0,1 + 2,1 b, `ciel` → `skyHorizon` (et `skyTop` un peu plus sombre et plus coloré), palette du format (`sol`, `pierre`, `bois`, `feuillage`, `eau`, `peau`, `metal`, `accent`, `maillot`, `short`, `chaussure`, `blanc`) → rôles procgen (`sol` vert vaut aussi pour l'herbe), `environnement` → `environment`, `look` → ombrage si le style de l'ambiance n'en donne pas (`toon`, `brillant` → `lit`, sinon `soft`).
- **Météo** (`meteo`, coordination avec les particules) : une ambiance peut demander du temps qu'il fait (`cyber` : `pluie`, `horreur` : `brume` ; `{base, meteo: "neige"}`, une liste de deux au plus, ou `meteo: false` pour changer) ; valeurs : `pluie`, `neige`, `feuilles`, `petales` (clé `weather` des particules, qui suivent la vue) et `brume` (brume au sol, `fx.mist`). Le jeton de style `meteo` porte la liste, publiée dans `state-out.ambiance.meteo`. Contrat avec le rendu des particules (`ambianceFx` de `style/ambiance.ts`) : l'ambiance donne `weather` seulement si ni la recette ni le DataProvider n'en écrivent, et `fx.mist` si la recette n'en écrit pas ; branché dans `sonic-procgen` sur la lecture des particules (`fxInputOf`).
- **Rendu vectoriel** : l'ambiance n'agit que sur le rendu 3D.
- **Coût** : rien de plus qu'un style (jetons = uniformes) ; la pile d'étalonnage compte de 1 à 6 effets, presque tous ponctuels (fusionnés en une passe) ; `bloom` ajoute ses passes annexes (`cyber`, `alien`, `onirique`, `silhouette`, `noir`, `horreur` ≥ 0,15), `kuwahara-aniso` (`tableau`) est la passe lourde (voir Coût de la pile).

## Rendu soigné

Quand la scène est immobile, l'image s'affine image après image (lancer de rayons progressif, ou accumulation du rendu temps réel), puis plus rien n'est dessiné ; le premier geste (doigt, molette, changement de vue, de style ou de scène) rend la main au temps réel, et le rendu soigné reprend après `attente` ms d'immobilité.

```json
{ "scene": "rue", "ambiance": "realiste", "photo": true, "anim": { "play": false } }
{ "scene": "jardin", "render": "photo", "photo": { "filtre": "peinture", "touche": 6, "tramage": 0.5 } }
```

- **Quand** : clé `photo` → dès que la scène est immobile (animation en pause, ou rien d'animé : ni acteurs, ni particules, ni ballons ou corps physiques en mouvement, ni eau, ni végétation ou prairie au vent ; le grain animé ne compte pas et se fige) et la vue lâchée depuis `attente` ms (600). `render: "photo"` (clé ou attribut) → à chaque arrêt de la vue, l'animation est figée le temps du rendu soigné et repart au premier geste.
- **Moteurs** (`moteur`) : `rayons` — lancer de rayons progressif (three-gpu-pathtracer, chargé à la demande, le même que le rendu photo du format monde) : ombres douces, occlusion, lumière indirecte, reflets des finis justes (environnement `exterieur` ou `studio`) ; la scène est copiée (une matière physique par rôle et par fini, couleurs des rôles dans les sommets, poses des personnages figées par les mêmes quaternions duaux que le shader, lampes et feux émissifs, lumières ponctuelles la nuit), la brume de profondeur est reposée sur l'image tracée. `raster` — accumulation du rendu temps réel : sous-pixels décalés (anticrénelage) et soleil décalé dans un cône de 2,5° (ombres douces). `auto` (défaut) : `rayons` sur ordinateur quand l'ombrage est modelé (`soft`, `lit`), `raster` pour les aplats (`toon`, `flat`), le rendu `pixel` et le mobile.
- **Réglages** (ceux du format monde) : `echantillons` (200 ; 4 en `peinture`, 32 en `lisse`), `rebonds` (5 ; 2 en `peinture`, 3 en `lisse`), `attente` (ms), `echelle` (0,25 à 1 ; 0,5 en peinture), `filtre` : `peinture` (Kuwahara anisotrope pré-tramé en tête de la pile `post`, `touche` = rayon, `tramage`, `niveaux`) ou `lisse` (débruitage du traceur qui garde les arêtes). Raster : `echantillons` images au plus, 32 sur ordinateur, **8 sur mobile**.
- **Ordre des passes** : scène (ou image tracée / accumulée) → image de base (ciel, contours, papier, grain, vignette du style, sRGB ; la couleur de la scène y est remplacée par l'image soignée, en fondu de 350 ms après les premiers échantillons) → pile `post` (étalonnage de l'ambiance, effets écrits, et `kuwahara-aniso` du filtre `peinture` en tête) → écran.
- **Coût** : rien tant que `photo` est absent (aucun module chargé, une branche d'uniforme dans la passe de base). Avec `photo` : rien pendant le mouvement ; à l'arrêt, en `rayons`, une copie de la scène et son BVH, sur le fil principal (`status.photoMs` ; mesuré : 12 s pour la rue de 450 k triangles en WebGL logiciel sur 2 cœurs partagés, de l'ordre de la seconde sur un ordinateur) — gardés tant que le contenu ne change pas : tourner la vue puis la lâcher ne recopie rien — puis un échantillon par image jusqu'au compte, puis plus rien. Raster : une image complète et la carte d'ombre par image accumulée (8 sur mobile, 32 sur ordinateur). Au-delà de 2,5 millions de triangles dépliés, le lancer de rayons se rabat sur le raster (`raison`).
- **Limites** : particules et effets animés de la pile figés ; prairies en brins instanciés absentes de l'image tracée (présentes en raster) ; vent, eau et clignements à l'instant de l'arrêt ; fenêtres allumées la nuit sans tirage par fenêtre en rayons ; rendu vectoriel : sans objet.

## Post-traitement

Jeton de style `post` : une **pile d'effets** paramétriques, cumulables, appliqués dans l'ordre donné sur l'image finie (rendu 3D). Vide ou absent : aucune passe de plus, aucun coût.

```json
"style": { "preset": "gouache", "post": "riso" }
"style": { "post": [{ "preset": "huile", "mix": 0.8 }, { "fx": "miniature", "focus": 1 }, { "fx": "grain", "amount": 0.3, "mask": "objects" }] }
"style": { "post": [{ "fx": "kuwahara-aniso", "radius": 6, "dither": 0.8, "levels": 6, "pattern": "bruit-bleu" }, { "fx": "bichromie", "ink": "#1d3557", "ink2": "#e76f51", "mask": "far" }] }
```

- **Forme** : nom de préréglage (`"riso"`), objet `{preset, …surcharges}`, ou liste. Dans une liste, une chaîne est un préréglage s'il en existe un de ce nom, sinon un effet ; `{fx: "…"}` désigne toujours l'effet seul. Les surcharges d'un préréglage (`mix`, `mask`, réglages) s'appliquent à chacun de ses effets qui les connaît. **8 effets au plus** après développement des préréglages (au-delà : coupés, signalés).
- **Chaque effet** : `fx` (identifiant), réglages propres (bornés : une valeur hors bornes est ramenée et signalée `clamped`, un réglage inconnu signalé `unknown` avec suggestion), `mix` (0..1, intensité, 1 par défaut) et `mask` facultatif :
  - `"near"` / `"far"` : plus près / plus loin que le point visé ; `{from, to, soft, invert}` : plage de profondeur en multiples de la distance du point visé (`{from: 1.5}` = au-delà de 1,5 fois cette distance, `{to: 0.8}` = en deçà, les deux = entre ; `soft` : fondu, 0,15) ;
  - `"objects"` (la scène) / `"sky"` (le fond) ; `invert: true` inverse.
- **Couleurs** : `#rrggbb` (ou `#rgb`) ; encres Riso par nom (`rose`, `bleu`, `jaune`, `vert`, `rouge`, `orange`, `violet`, `noir`, `turquoise`, `marine`) ; palettes nommées (`gameboy`, `pico8`, `cga`, `mac`, `zx`, `nord`, `pastel`, `terre`, `ocean`, `braise`, `coucher`, `menthe`, `encre`, `pop`, `nuit`) pour `palette.colors` et `degrade.stops`.
- **Ordre** : scène (lumière, brume du style ; ou image du rendu soigné) → image de base (ciel, contours, papier, grain et vignette du style, conversion sRGB) → pile `post` dans l'ordre de la liste (étalonnage d'une ambiance en tête) → écran. Les effets travaillent en sRGB affiché ; ceux qui lisent la géométrie (masques, `miniature`, `brume`, `thermique`, `neon`, plomb du `vitrail`) lisent la profondeur, les normales et l'identifiant d'objet de la scène.
- **Tailles** en px CSS (même aspect quelle que soit la densité de l'écran) ; flous en fraction du petit côté.
- **Qualité** : jeton `postQuality` = `auto` (défaut : basse sur mobile), `low` (Kuwahara anisotrope et isotrope calculés à demi-résolution), `high`. La densité de pixels reste régulée par la charge (comme sans `post`).
- **Coût** : les effets « ponctuels » (couleur seule : encres, palettes, trames, grain, vignette…) sont fusionnés dans la passe qui précède ; un effet de voisinage ou qui déplace l'image ouvre une passe. Passes annexes : tenseur de structure lissé (3 passes, `kuwahara-aniso`), image floutée au quart de la résolution (3 passes, `bloom`, `halo`, `miniature`). Cibles réutilisées d'une image à l'autre ; shaders mis en cache par suite d'effets : **changer un réglage ne recompile rien**, changer la liste compose (ou retrouve) les shaders. Mesures relatives (Chrome, WebGL logiciel, village 960 × 600, coût de la pile rapporté au rendu de la scène) : 8 effets ponctuels fusionnés en une passe ≈ 3 %, `riso`, `gameboy`, `argentique`, `miniature`, `vitrail` 1 à 3 %, `aquarelle` ≈ 4 %, `neon` ≈ 11 %, `huile` et `kuwahara-aniso` de loin les plus lourds (fenêtre de 300 à 400 échantillons × 8 secteurs par pixel : du même ordre que la scène elle-même, ou plus) ; en qualité basse, `kuwahara-aniso` coûte environ 4 fois moins. Sur un vrai GPU, tout cela tient en quelques millisecondes ; sur mobile, réserver `kuwahara-aniso` / `huile` à des scènes calmes (rendu à la demande). `status.postPasses` donne le nombre de passes plein écran.
- **Animation** : `grain` animé, `glitch` (`speed`), `crt` (`flicker`) et `fuite` (`speed`) imposent un rendu continu ; sinon rendu à la demande comme d'habitude.
- **Pixel** : l'ancien jeton `pixel` (taille du pixel, rendu de la scène en basse résolution) marche toujours ; l'effet `{fx: "pixel"}` pixellise l'image finie (après les contours, compatible avec toute la pile).
- **Pixels accrochés au monde** (caméras orthographiques `iso`, `top`, `side`, `front`, `oblique`) : avec le jeton `pixel`, la translation de la caméra est arrondie à la grille des texels de la cible basse résolution (axes droite / haut de la vue), la cible est agrandie de 2 texels de chaque côté, puis l'image est affichée décalée du reste sous-texel : pendant un déplacement, les pixels de la scène restent fixes par rapport au monde (ni scintillement ni « nage ») et la vue suit la position réelle au pixel écran près. Les effets de grille de la pile (`pixel`, `1bit`, tramage de `palette`, `trichromie`, pré-tramage de `kuwahara-aniso`, `points`, `cmjn`, `riso`, `lignes`, `hachures`, `lino`, `pointillisme`, `vitrail`, grains et papiers) ont leurs grilles accrochées au monde de la même façon (origine décalée de la position de la caméra). Rotation ou zoom : la grille est recalculée. Les objets qui bougent (acteurs, objet glissé) ne sont pas arrondis : ils passent d'un texel à l'autre. Perspective (`perspective`, `follow`) : pas d'accrochage (la parallaxe déplace chaque point différemment), grilles fixées à l'écran. Désactiver : `pixel: {size: 4, snap: false}` ou `pixelSnap: false`.
- **Rendu vectoriel** (`render: "vector"`) : `post` est ignoré (passes GPU du rendu 3D seulement), signalé par une `issue` `info` ; la vue vectorielle n'a pas de mode pixel.
- **Robustesse** : un shader refusé par le pilote désactive la pile (l'image de base s'affiche) et le signale dans `status.issues`.
- **Kuwahara anisotrope sur GPU** : même algorithme que le prétraitement CPU de `sketch` (Kyprianidis, Kang, Döllner 2009 : tenseur de structure de Sobel lissé → orientation et anisotropie, fenêtre elliptique orientée, secteurs à poids polynomiaux, pondération 1 / (1 + σ^q)). Différences : le tenseur est calculé sur l'image non tramée (orientation plus propre), et le pré-tramage est **ordonné** (Bayer 8 × 8 ou bruit bleu procédural, appliqué à chaque échantillon du filtre) au lieu de Floyd–Steinberg, séquentiel donc impossible en un passage GPU ; le bruit bleu évite les stries que la trame de Bayer laisse dans les dégradés étirés.

### Effets

Identifiants courts (`fx`), nom français, réglages : défaut et bornes. ⚙ : passe coûteuse ou passe annexe.

**Peinture**

| `fx` | Effet | Réglages (défaut, bornes) |
|---|---|---|
| `kuwahara-aniso` | **Kuwahara anisotrope** ⚙ — Peinture aux aplats étirés le long des formes (Kyprianidis, Kang, Döllner 2009) : tenseur de structure lissé, fenêtre elliptique orientée, secteurs pondérés. Pré-tramage ordonné facultatif (la trame fondue par le filtre donne des transitions douces). | `radius` rayon (px) (5 ; 2–12) ; `sectors` secteurs (4 ou 8) (8 ; 4–8) ; `sharpness` netteté q (8 ; 1–16) ; `alpha` étirement (petit = plus étiré) (1 ; 0.3–4) ; `dither` force du pré-tramage (0 = aucun) (0 ; 0–1) ; `levels` niveaux par canal du pré-tramage (8 ; 2–32) ; `pattern` motif du pré-tramage (bayer\|bruit-bleu) ; `cell` taille de la cellule de trame (px) (1 ; 1–4) |
| `kuwahara` | **Kuwahara** ⚙ — Kuwahara isotrope (4 quadrants, garde la moyenne du plus homogène) : petites plages de couleur aux bords francs. | `radius` rayon (px) (4 ; 2–10) |
| `huile` | **Huile (empâtement)** — Empâtement en relief éclairé : la luminance devient une hauteur de pâte, striée de coups de brosse dans le sens des formes, éclairée en rasant. | `relief` hauteur de pâte (0.8 ; 0–2) ; `size` échelle du relief (px) (2 ; 1–6) ; `light` direction de la lumière (°) (135 ; 0–360) ; `brush` stries de brosse (0.45 ; 0–1) ; `shine` brillant du vernis (0.35 ; 0–1) |
| `aquarelle` | **Aquarelle** — Lavis transparents : diffusion, bords foncés où le pigment s'accumule, granulation dans le grain du papier, contours qui ondulent. | `bleed` diffusion (0.45 ; 0–1) ; `edges` bords foncés (0.6 ; 0–1) ; `granulation` granulation (0.5 ; 0–1) ; `paper` papier (0.6 ; 0–1) ; `scale` échelle (px) (1.5 ; 0.5–4) ; `wobble` ondulation (0.5 ; 0–1) |

**Encres et impression**

| `fx` | Effet | Réglages (défaut, bornes) |
|---|---|---|
| `bichromie` | **Bichromie** — Deux encres sur papier : l'encre sombre dans les ombres, la seconde dans les demi-tons, en surimpression. | `ink` encre sombre (#1d3557) ; `ink2` seconde encre (#e76f51) ; `paper` papier (#f4ede0) ; `contrast` contraste (1.2 ; 0.3–3) ; `balance` équilibre (− sombre, + clair) (0 ; -0.5–0.5) |
| `trichromie` | **Trichromie** — Trois encres : séparation par projection de chaque couleur sur les encres (modèle soustractif), recombinées en surimpression ; `levels` postérise chaque plaque (tramage ordonné). | `inks` encres (2 ou 3) (2 à 3) ; `paper` papier (#f5efe3) ; `levels` niveaux par plaque (0 = continu) (0 ; 0–8) ; `dither` tramage des plaques (0.7 ; 0–1) ; `pattern` motif (bayer\|bruit-bleu) |
| `riso` | **Risographie** — 2 ou 3 encres Riso (noms : rose, bleu, jaune, vert, rouge, orange, violet, noir, turquoise, marine, ou hexadécimal) décalées de registre, grain stochastique ou trame de points, surimpression, densité d'encre irrégulière. | `inks` encres (2 à 3) ; `paper` papier (#f7f2e8) ; `misregister` décalage de registre (px) (1.5 ; 0–8) ; `grain` grain (0.7 ; 0–1) ; `dot` trame de points (px, 0 = grain) (0 ; 0–12) ; `seed` graine du registre (1 ; 0–99) |
| `cmjn` | **Demi-teinte CMJN** — Quadrichromie tramée : cyan 15°, magenta 75°, jaune 0°, noir 45° (plus `angle`), points ronds proportionnels à l'encre, génération du noir réglable. | `size` pas de trame (px) (6 ; 3–20) ; `angle` rotation des trames (°) (0 ; -45–45) ; `gcr` génération du noir (0.5 ; 0–1) ; `paper` papier (#fbf8f1) |
| `degrade` | **Carte de dégradé** — La luminance parcourt un dégradé de 2 à 8 couleurs (mélange en OKLab) ; palette nommée ou liste. | `stops` couleurs, de l'ombre à la lumière (2 à 8) ; `contrast` contraste (1 ; 0.3–3) ; `offset` décalage (0 ; -0.5–0.5) |
| `palette` | **Postérisation par palette** — Chaque pixel prend la couleur la plus proche (OKLab) d'une palette nommée (gameboy, pico8, cga, mac, zx, nord, pastel, terre, ocean, braise…) ou libre (16 couleurs au plus), avec tramage ordonné entre les deux plus proches ; `match: luminance` range la palette de la plus sombre à la plus claire et y projette la luminance (palettes monochromes : gameboy). | `colors` palette (2 à 16) ; `match` correspondance (couleur\|luminance) ; `dither` tramage (0.6 ; 0–1) ; `pattern` motif (bayer\|bruit-bleu) ; `cell` taille de la cellule de trame (px) (1 ; 1–8) |
| `cyanotype` | **Cyanotype** — Tirage au ferro-prussiate : bleu de Prusse profond, blancs de papier, léger voile. | `contrast` contraste (1.15 ; 0.3–3) ; `tone` chaleur du papier (0.5 ; 0–1) ; `depth` profondeur du bleu (0.6 ; 0–1) |
| `sepia` | **Sépia** — Virage sépia : bruns chauds, noirs relevés, hautes lumières crème. | `tone` chaleur (0.6 ; 0–1) ; `contrast` contraste (1.05 ; 0.3–3) ; `fade` noirs relevés (0.15 ; 0–0.6) |

**Trames et gravure**

| `fx` | Effet | Réglages (défaut, bornes) |
|---|---|---|
| `points` | **Trame de points** — Similigravure : points ronds dont la taille suit l'ombre, sur une grille tournée ; `color` garde la couleur de l'image (points Ben-Day). | `size` pas (px) (6 ; 3–24) ; `angle` angle (°) (45 ; -90–90) ; `color` points de la couleur de l'image (false) ; `ink` encre (#1a1a1f) ; `paper` papier (#f5f1e8) |
| `lignes` | **Trame de lignes** — Lignes parallèles dont l'épaisseur suit l'ombre (gravure en taille-douce), légèrement ondulées. | `size` pas (px) (5 ; 2–20) ; `angle` angle (°) (30 ; -90–90) ; `wobble` ondulation (0.3 ; 0–1) ; `ink` encre (#1d1b22) ; `paper` papier (#f3eddf) |
| `hachures` | **Hachures croisées** — Hachures superposées par paliers de luminance (1 à 4 directions), trait vibré. | `size` pas (px) (5 ; 2–16) ; `angle` angle de la première passe (°) (40 ; -90–90) ; `layers` directions (4 ; 1–4) ; `wobble` vibration du trait (0.4 ; 0–1) ; `ink` encre (#2b2118) ; `paper` papier (#efe6d2) |
| `1bit` | **Tramage ordonné 1 bit** — Deux couleurs seulement, tramage ordonné (Bayer 8×8) ou bruit bleu procédural. | `ink` encre (#1b1b1b) ; `paper` papier (#f2f0e6) ; `pattern` motif (bayer\|bruit-bleu) ; `cell` taille de la cellule (px) (1 ; 1–6) ; `contrast` contraste (1.1 ; 0.3–3) ; `bias` seuil (− plus clair) (0 ; -0.5–0.5) |
| `lino` | **Linogravure** — Encre pleine dans les ombres, papier dans les lumières, gouges blanches dans les demi-tons qui suivent les formes (orientation du gradient), bords mâchés. | `threshold` seuil (0.5 ; 0.1–0.9) ; `size` pas des gouges (px) (5 ; 2–14) ; `angle` angle des gouges sans forme (°) (20 ; -90–90) ; `rough` bords irréguliers (0.5 ; 0–1) ; `ink` encre (#16131a) ; `paper` papier (#efe7d6) |
| `pointillisme` | **Pointillisme** — Touches rondes juxtaposées, couleurs vibrées (petits écarts de teinte), papier entre les points. | `size` taille des touches (px) (5 ; 2–16) ; `jitter` vibration des couleurs (0.6 ; 0–1) ; `saturation` saturation (1.25 ; 0.5–2) ; `paper` papier (#f4eee2) |
| `vitrail` | **Vitrail** — Mosaïque de Voronoï : chaque verre prend la couleur de son centre, lumière qui traverse, plomb entre les verres. | `size` taille des verres (px) (22 ; 6–80) ; `lead` épaisseur du plomb (0.12 ; 0–0.4) ; `glow` lumière traversante (0.5 ; 0–1) ; `lead_color` couleur du plomb (#1c1a1f) |

**Lumière et optique**

| `fx` | Effet | Réglages (défaut, bornes) |
|---|---|---|
| `bloom` | **Bloom doux** ⚙ — Les hautes lumières débordent en un halo doux (seuil à genou, flou séparable à basse résolution). | `intensity` intensité (0.8 ; 0–3) ; `threshold` seuil (0.65 ; 0–1) ; `radius` rayon (1 ; 0.2–3) ; `tint` teinte (#fff2e0) |
| `halo` | **Halo (effet Orton)** ⚙ — Toute l'image floutée en écran par-dessus elle-même : lumière diffuse, rêveuse. | `intensity` intensité (0.45 ; 0–1.5) ; `radius` rayon (1.2 ; 0.2–3) ; `tint` teinte (#ffe9d6) |
| `aberration` | **Aberration chromatique** — Rouge et bleu décalés, du centre vers les bords (radial) ou en travers. | `amount` décalage (px) (2 ; 0–20) ; `radial` radial (sinon horizontal) (true) |
| `miniature` | **Effet miniature** ⚙ — Bascule-décentrement : net à la distance du point visé, flou devant et derrière (profondeur réelle de la scène), couleurs vives : la scène devient une maquette. | `focus` distance nette (1 = point visé) (1 ; 0.3–3) ; `range` profondeur de champ (0.25 ; 0.02–2) ; `blur` flou (1 ; 0–1) ; `radius` rayon du flou (1 ; 0.3–3) ; `saturation` saturation (1.25 ; 0.5–2) |
| `silhouette` | **Silhouettes** — Contre-jour : les objets deviennent des aplats sombres, éclaircis par la distance vers la couleur du ciel (perspective atmosphérique) ; le ciel reste. | `color` couleur du lointain (ciel) (#d9d7cf) ; `ink` couleur des silhouettes proches (#1d1c22) ; `depth` éclaircissement par la distance (0.6 ; 0–2) |
| `brume` | **Brume colorée** — Brume de profondeur teintée, posée sur l'image finie (en plus de la brume du style). | `color` couleur (#c9b7e8) ; `start` début (1 = point visé) (0.8 ; 0–3) ; `density` densité (0.8 ; 0–3) ; `sky` sur le ciel (0.7 ; 0–1) |
| `grain` | **Grain argentique** — Grain de film, plus marqué dans les demi-tons, chromatique ou non, animé ou figé. | `amount` quantité (0.4 ; 0–1) ; `size` taille (px) (1.5 ; 1–4) ; `chroma` grain coloré (0.3 ; 0–1) ; `animated` grain animé (false) |
| `vignette` | **Vignette** — Assombrit (ou colore) les bords du cadre. | `amount` force (0.5 ; 0–1) ; `roundness` rondeur (0.7 ; 0–1) ; `softness` douceur (0.6 ; 0.05–1) ; `color` couleur (#0d0b10) |
| `fuite` | **Fuite de lumière** — Voile chaud entré par un bord de la pellicule, en lueur d'écran. | `amount` force (0.5 ; 0–1) ; `angle` bord d'entrée (°) (35 ; 0–360) ; `color` couleur (#ff7a3d) ; `color2` seconde couleur (#ffd27a) ; `speed` dérive animée (0 ; 0–2) |

**Excentriques**

| `fx` | Effet | Réglages (défaut, bornes) |
|---|---|---|
| `neon` | **Néon des contours** — Les arêtes de la géométrie (profondeur, normales, objets) et de l'image deviennent des tubes de néon lumineux sur fond assombri. | `color` couleur (#ff3fd2) ; `color2` couleur des plis (#38e8ff) ; `width` épaisseur (px) (1.5 ; 0.5–4) ; `glow` lueur (0.8 ; 0–2) ; `dark` fond éteint (0.85 ; 0–1) ; `image` couleur de l'image dans les tubes (0.3 ; 0–1) |
| `thermique` | **Caméra thermique** — Palette « fer chaud » ; les objets proches sont plus chauds, le ciel froid. | `contrast` contraste (1.8 ; 0.3–4) ; `depth` chaleur des objets proches (0.4 ; 0–1) |
| `glitch` | **Glitch** — Bandes décalées, canaux RVB séparés, blocs corrompus ; figé (graine) ou animé (`speed`). | `amount` quantité (0.35 ; 0–1) ; `bands` bandes (24 ; 4–80) ; `shift` décalage RVB (px) (6 ; 0–40) ; `speed` animation (0 ; 0–3) ; `seed` graine (3 ; 0–99) |
| `crt` | **Écran cathodique** — Courbure du verre, lignes de balayage, grille de luminophores RVB, bavure lumineuse, coins sombres. | `curvature` courbure (0.35 ; 0–1) ; `scanlines` balayage (0.5 ; 0–1) ; `grille` grille RVB (0.35 ; 0–1) ; `bleed` bavure (0.4 ; 0–1) ; `flicker` scintillement (0 ; 0–1) |
| `decoupe` | **Papier découpé** — Postérisation en couches de papier superposées, chaque couche portant son ombre sur la suivante. | `layers` couches (5 ; 2–10) ; `shadow` ombre (px) (4 ; 0–16) ; `angle` direction de l'ombre (°) (135 ; 0–360) ; `texture` fibres du papier (0.5 ; 0–1) ; `saturation` saturation (1.1 ; 0.3–2) |
| `kaleido` | **Kaléidoscope** — Symétrie en miroirs autour du centre. | `segments` branches (6 ; 2–16) ; `rotation` rotation (°) (0 ; 0–360) ; `zoom` zoom (1 ; 0.3–3) ; `x` centre x (0.5 ; 0–1) ; `y` centre y (0.5 ; 0–1) |

**Base**

| `fx` | Effet | Réglages (défaut, bornes) |
|---|---|---|
| `pixel` | **Pixels** — Gros pixels (après le rendu, contrairement au jeton `pixel` qui rend la scène en basse résolution). | `size` taille (px) (4 ; 2–32) |
| `couleur` | **Réglages de couleur** — Exposition, contraste, saturation, rotation de teinte, température, gamma. | `exposure` exposition (IL) (0 ; -2–2) ; `contrast` contraste (1 ; 0.3–3) ; `saturation` saturation (1 ; 0–3) ; `hue` teinte (°) (0 ; -180–180) ; `temperature` température (− froid, + chaud) (0 ; -1–1) ; `gamma` gamma (1 ; 0.3–3) ; `tint` teinte multipliée (blanc = aucune) (#ffffff) |
| `niveaux` | **Postérisation** — Nombre de niveaux par couleur, avec tramage ordonné facultatif entre deux niveaux (pixel art, affiche). | `levels` niveaux par canal (6 ; 2–32) ; `dither` tramage (0 ; 0–1) ; `pattern` motif (bayer\|bruit-bleu) ; `cell` taille de la cellule de trame (px) (1 ; 1–8) |

### Préréglages

| Préréglage | Pile |
|---|---|
| `riso` | Risographie deux encres rose et bleu, registre décalé, grain (couleur → riso) |
| `riso-3` | Risographie trois encres (rose, jaune, bleu) (riso) |
| `trame-aniso` | Kuwahara anisotrope avec pré-tramage (l'effet de l'outil de vectorisation) (kuwahara-aniso) |
| `huile` | Peinture à l'huile : aplats orientés puis empâtement éclairé (kuwahara-aniso → huile → vignette) |
| `aquarelle` | Aquarelle : aplats doux, lavis, bords foncés, papier (kuwahara → aquarelle) |
| `gravure` | Gravure en taille-douce : hachures croisées brun-noir sur papier crème (couleur → hachures → vignette) |
| `lino` | Linogravure noir et crème, gouges dans les demi-tons (lino) |
| `bd-tramee` | Bande dessinée imprimée : couleurs vives en points Ben-Day (couleur → points) |
| `pop` | Quadrichromie CMJN à gros points (couleur → cmjn) |
| `miniature` | Effet maquette : flou de profondeur de champ et couleurs vives (miniature → couleur) |
| `cyanotype` | Cyanotype sur papier, grain et vignette (cyanotype → grain → vignette) |
| `sepia` | Vieille photographie sépia (sepia → grain → vignette) |
| `vitrail` | Vitrail de verres colorés sertis de plomb, lumière diffuse (couleur → vitrail → bloom) |
| `1bit` | Écran 1 bit des premiers Macintosh (noir et blanc tramé) (couleur → 1bit) |
| `gameboy` | Console de poche : gros pixels, 4 verts tramés (couleur → pixel → palette) |
| `pico8` | Console fantaisie : pixels et palette de 16 couleurs (pixel → palette) |
| `neon` | Contours en tubes de néon sur fond nocturne (neon → bloom) |
| `vhs` | Cassette vidéo sur écran cathodique : glitch léger, aberration, balayage (glitch → aberration → crt) |
| `argentique` | Pellicule couleur : tons chauds, halo, grain, vignette, fuite de lumière (couleur → halo → fuite → grain → vignette) |
| `thermique` | Caméra thermique (thermique) |
| `bichromie` | Bichromie bleu nuit et corail sur papier, grain (bichromie → grain) |
| `trichromie` | Trichromie bleu, rose, jaune, plaques tramées (trichromie) |
| `pointillisme` | Pointillisme à la Seurat (pointillisme) |
| `decoupe` | Papier découpé en couches avec ombres portées (decoupe) |
| `coucher` | Carte de dégradé coucher de soleil, halo (degrade → halo) |


## Particules : météo, fumées, feux, embruns

Moteur du format monde (`shared/sim/particles.ts` : mêmes préréglages, mêmes réglages, mouvement en forme close calculé par le GPU, `shared/sim/particles-gl.ts` pour le dessin, partagé avec `sonic-3d`). procgen ne fait que dire **où** naissent les grains : aux **ancres** des objets composés (relues à chaque image : un objet glissé garde sa fumée, un objet caché n'en émet plus), au-dessus de la vue (météo) ou sur toute la scène (brume). Rien n'est créé quand aucune de ces clés n'est écrite. **Changer ces clés ne recompose pas la scène** (elles sont retirées de la clé de composition) ; un système dont les réglages et les sources n'ont pas changé garde ses grains en vol.

```json
"weather": { "kind": "rain", "intensity": 0.6 },
"wind": 1.2, "windDir": 80,
"fx": { "chimneys": true, "campfires": true, "cascades": true, "mist": 0.5, "dust": 0.4, "quality": "auto" },
"layers": [ { "id": "arbres", "gen": "tree", "count": 8, "place": { "poisson": true }, "fx": "leaves" },
            { "id": "forge", "gen": "building", "place": { "at": [[4, 2]] }, "fx": [{ "preset": "smoke", "anchor": "chimney", "color": ["#3a3a3a", "#8a8a8a"] }, { "preset": "embers", "anchor": "door" }] } ],
"particles": { "vapeur": { "preset": "steam", "at": "maisons.2@chimney.0", "rate": 20 }, "eclair": { "preset": "flash", "at": [0, 6, 0] } }
```

| Clé de recette | Rôle |
|---|---|
| `weather` | Météo sur toute la scène : `rain` / `pluie`, `snow` / `neige`, `leaves` / `feuilles`, `petals` / `petales`, `none`. `intensity` 0 à 1 (0,5) = densité de grains par m² ; réglages facultatifs `color`, `size`, `opacity`, `speed`, `life`, `sprite`, `wind`. Les grains naissent dans une boîte au-dessus du point visé, de la taille de la vue (bornée à la scène) : densité constante quel que soit le zoom. Grains d'au moins ~1,3 px à l'écran (pluie lointaine lisible, plus transparente d'autant). |
| `wind`, `windDir` | `wind` (force, 1 par défaut ; déjà lu par la végétation) × 1,4 m/s, `windDir` en degrés (0 = vers +z, 90 = vers +x, 67 par défaut ; le même que pour les prairies) : penche la pluie, emporte fumées, brume et feuilles selon la sensibilité `wind` de chaque préréglage. |
| `fx.chimneys` | Fumée sur chaque ancre `chimney.N` des bâtiments (`true`, intensité, ou `{intensity, color, size, rate, layers: ["maisons"]…}`) ; paramètre `chimneys` du bâtiment pour en avoir. |
| `fx.campfires` | Sur chaque `prop.campfire` : flammes (`campfires-fire`), braises (`campfires-embers`), fumée (`campfires-smoke`) et étincelles sur ordre (`campfires-sparks`, voir clé `fx` du DataProvider). Réglages de l'objet appliqués aux flammes. |
| `fx.cascades` | Embruns et gouttes à l'ancre `fall` de chaque `water.cascade`. |
| `fx.mist` | Brume au sol sur toute la scène (intensité). `fx.dust` (ou `motes`) : poussières en suspension qui scintillent dans la vue. |
| `fx.quality` | `auto` (défaut), `low`, `high` ; `fx.max` : plafond explicite de grains. |
| `layers[].fx` | Effet sur chaque objet du calque : nom (`smoke`, `fire`, `embers`, `sparks`, `glow`, `steam`, `spray`, `splash`, `drops`, `bubbles`, `dust`, `mist`, `magic`, `leaves`, `petals`, `snow`, `confetti`… ou le nom français du format monde : `fumee`, `feu`, `braise`…), objet `{preset, anchor, intensity, …réglages}` ou liste (3 au plus). `anchor` : nom exact (`door`, `light`, `fall`, `top`…) ou préfixe (`chimney` = toutes les `chimney.N`) ; défaut `chimney` pour une fumée, `top` sinon ; ancre absente : haut de l'objet. Feuilles, pétales, neige posés sur un objet tombent de sa couronne. Système nommé `<calque>-fx` (`-fx2`, `-fx3`). |
| `particles` | Systèmes libres, mêmes réglages que `particles` du format monde (`preset`, `rate`, `burst`, `max`, `shape`, `extent`, `dir`, `spread`, `speed`, `life`, `gravity`, `rise`, `drag`, `turbulence`, `wind`, `size`, `color` (1 à 4), `opacity`, `blend`, `sprite`, `stretch`, `spin`, `floor`, `offset`) ; `at` : point `[x, y, z]` ou `"objet@ancre"`. |

- **Salves** (clé `fx` du DataProvider) : `{"campfires-sparks": {n: 4}}` lance une salve sur chaque source du système à chaque hausse de `n` (la première lecture mémorise le compteur) ; `at` impose le point, `scale`, `color`, `count` comme dans le format monde.
- **Ids** des systèmes : `weather`, `chimneys`, `campfires-fire|embers|smoke|sparks`, `cascades`, `cascades-drops`, `mist`, `dust`, `<calque>-fx`, et les clés de `particles` ; `status.fx` = `{systems: [{id, preset, sources, max}], grains, budget}`. Problèmes dans `status.issues` (`weather`, `fx.*`, `particles.*`, `layers[i].fx`).
- **Budget** : 8000 grains pour toute la scène (4000 en `auto` sur mobile ou en `low`, 1500 en vectoriel) ; au-delà, débits et tampons de tous les systèmes sont réduits d'autant (signalé `limit`). 16 systèmes au plus. Coût CPU : les seules naissances (aucune mise à jour par grain et par image) ; GPU : un appel de dessin par système, quads instanciés, sans tri ni écriture de profondeur ; dessinés dans la passe de la scène (cachés par le décor), absents de la passe d'ombre ; contours, masques et brume du post-traitement les ignorent. Arrêt hors écran et `prefers-reduced-motion` comme le reste de l'animation ; une scène avec des naissances continues reste animée tant qu'elle est visible.
- **Vectoriel** (`render: "vector"`) : version simplifiée en aplats par-dessus le dessin (disques, traits de pluie et d'étincelles, flocons, feuilles ; feu en fusion « lighter »), **sans occultation** par le décor, budget 1500 grains ; pas d'export dans le SVG (`exportSvg`).
- Les lumières (`light`) des systèmes du format monde sont ignorées : les feux de camp et lanternes éclairent déjà par les lumières de la scène.
- Scènes de la bibliothèque : `village` (fumée des cheminées), `bivouac` (feu de camp), `vapeur` (fumées noires), `montagne` (neige et cheminées).

## Fluidité

La composition se fait par tranches (la page reste fluide ; `status.phase = composing`, `status.progress`). Bâtiments fusionnés par tuile, objets répétés instanciés, personnages en un seul maillage chacun. Rendu à la demande, densité de pixels adaptée à la charge, arrêt hors écran, `prefers-reduced-motion` respecté (animation en pause). Une scène de village (≈ 230 objets, 6 personnages) tient en une cinquantaine d'appels de dessin.

La vue de l'utilisateur (orbite, pan, zoom) est conservée à la recomposition : déplacer un objet ou changer un paramètre ne recadre pas la scène. La vue n'est ré-appliquée que si son entrée change (`view` de la recette, attribut `camera`, `view` du DataProvider) ; une nouvelle vue de recette ou caméra repart de la vue par défaut, un `view` du DataProvider se fusionne avec la vue courante. Le cadrage reste celui de la scène précédente tant que sa taille varie de moins de 50 %. Pas de clignotement : l'ancienne scène reste affichée jusqu'au remplacement, et les changements de taille (mise en page, barre d'adresse mobile, densité de pixels) sont appliqués au début du rendu suivant, dans la même image que le dessin ; la densité de pixels ne remonte qu'après plusieurs secondes fluides, jamais dans les 10 s qui suivent une baisse.

## CSP

Pas d'`eval`, pas de `new Function`, pas d'URL de script. Les recettes et expressions sont analysées par procgen lui-même.

Monde infini hors du fil principal : l'application construit le worker avec son propre bundler et le confie à procgen (sinon, composition par tranches sur le fil principal ; repli automatique si le worker échoue) :

```ts
// procgen-tiles.worker.ts
import { serveTileWorker } from "@supersoniks/creative-stack/procgen/tile-worker";
serveTileWorker(self);
// au chargement de l'addon
import { setProcgenTileRunner, WorkerTileRunner } from "@supersoniks/creative-stack/procgen";
setProcgenTileRunner(() => new WorkerTileRunner(new Worker(new URL("./procgen-tiles.worker.ts", import.meta.url), { type: "module" })));
```

Personnages construits en parallèle : le même script sert un pool de workers (cœurs − 1, au plus 6). Avant une composition 3D qui contient des personnages, procgen les repère par une composition à blanc, reprend ceux déjà construits dans le cache du navigateur (IndexedDB `procgen-personnages`, vidé de lui-même quand le code des générateurs change), fait construire les autres par le pool, puis compose : plus de tâche longue de 0,2 à 0,9 s par personnage, et une deuxième visite ne reconstruit rien. Le maillage obtenu est celui d'une construction sur place (même précision envoyée à la carte graphique). Avec ces workers, chaque personnage détaillé reçoit aussi, en arrière-plan, une version allégée (maillage « foule », même apparence, même squelette, même visage, ≈ 4 fois moins de triangles) affichée quand il fait moins de ≈ 140 px de haut à l'écran (retour au détail complet au-dessus de 170 px ; toujours complet pour les captures et le rendu soigné) : football vu de haut, 2,3 M → 0,8 M triangles par image. Sans workers (Node, tests, application qui n'en fournit pas), les personnages sont construits pendant la composition ; une erreur de worker n'est jamais bloquante.

```ts
import { setProcgenCharacterWorkers } from "@supersoniks/creative-stack/procgen";
setProcgenCharacterWorkers(() => new Worker(new URL("./procgen-tiles.worker.ts", import.meta.url), { type: "module" }));
```
