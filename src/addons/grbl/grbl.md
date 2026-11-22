# Addon `grbl` — gravure et découpe laser, traceur

Addon `@supersoniks/creative-stack/grbl` : du dessin à la machine, par DataProviders, sans JS.

| Composant | Rôle |
|---|---|
| `sonic-gcode` | Préparation : dessin (SVG ou image) → programme G-code, aperçu, durée, emprise |
| `sonic-laser-pattern` | Modèles paramétriques : boîte à encoches, engrenages, puzzle, tampon, porte-clés, pendentif, dessous de verre, règle, grille d'essais |
| `sonic-gcode-view` | Contrôle : parcours réel à zoom libre, repère en mm (grille, règles, origine, plateau), tête, avancement, simulation, placement au doigt |
| `sonic-grbl` | Pilote : machine GRBL derrière un `sonic-serial` (état, déplacements, cadrage, essai à vide, envoi, pause, arrêt, reprise) |

Machines visées : graveurs et découpeuses laser à diode sous GRBL 1.1 (Atomstack, Ortur, Sculpfun, Longer, TwoTrees…), traceurs à stylo. **Non validé sur matériel par ce dépôt** : le protocole suit la documentation de GRBL et les tests passent sur une machine simulée.

## Sécurité

Un laser brûle et aveugle. Le composant ne remplace ni les lunettes, ni la surveillance de la machine, ni l'extraction des fumées. Ce qu'il garantit :

1. **Geste obligatoire** pour lancer une tâche ou un cadrage faisceau allumé : un minuteur ou un script ne peut pas déclencher un tir.
2. **M4 imposé** (`tool="laser"`) : en puissance dynamique, GRBL coupe le faisceau dès que le mouvement s'arrête. Tout `M3` (puissance constante) est remplacé par `M4`. Une machine dont le mode laser est coupé (`$32=0`) est refusée.
3. **Arrêt à la fermeture** de la page ou au retrait du composant pendant une tâche (pause puis remise à zéro), et écran tenu éveillé pendant la tâche.
4. **Réglages protégés** : `send` refuse `$RST`, les lignes de démarrage et l'écriture de réglages (`$n=`, sauf `allow-settings`). Une tâche ne peut contenir aucune commande `$`.
5. `max-power` plafonne la puissance de toute tâche ; le cadrage faisceau allumé est limité à 5 %.
6. Fin de tâche réelle : le programme se termine par `M5` puis une temporisation que GRBL n'acquitte qu'une fois tout exécuté ; `job` ne disparaît qu'à ce moment.

Si le navigateur plante ou si le câble est arraché, GRBL finit les quelques mouvements déjà reçus puis s'arrête ; avec `M4` le faisceau se coupe à l'arrêt. Garder le bouton d'arrêt de la machine à portée de main.

## Graver un dessin

```json
{ "tagName": "sonic-serial", "attributes": { "id": "port", "profile": "ch340", "for": "connecter", "auto-reconnect": true } }
{ "tagName": "sonic-sketch", "attributes": { "id": "dessin", "width": 600, "height": 400, "background": "#ffffff", "color": "#000000", "size": 4 } }
{ "tagName": "sonic-gcode", "attributes": { "id": "prog", "source": "#dessin", "width-mm": 60, "power": 25, "speed": 2000, "auto": true, "show-preview": true, "control": "reglages", "style": "width:320px" } }
{ "tagName": "sonic-grbl", "attributes": { "id": "laser", "transport": "#port", "source": "#prog", "machine": "atomstack-a5-pro", "control": "laserControl", "for": "lancer" } }

{ "tagName": "sonic-button", "attributes": { "id": "connecter", "type": "primary" }, "nodes": [{ "tagName": "span", "attributes": { "text": "Connecter le laser" } }] }
{ "tagName": "sonic-button", "attributes": { "id": "lancer", "type": "danger" }, "nodes": [{ "tagName": "span", "attributes": { "text": "Lancer" } }] }
```

Déroulé conseillé pour l'interface : connecter (`laserState.connected`), placer la tête à la main ou par `jog`, `setOrigin` (le coin bas gauche du dessin sera là), `frame` (la tête fait le tour de l'emprise, faisceau éteint), puis `run`. `laserState.job.progress` suit l'avancement, `stop` arrête.

## `sonic-gcode`

Entrées :

- `source="#id"` d'un `sonic-sketch` : son SVG. Un dessin de `sonic-sketch` est fait de surfaces de couleur : elles sont **hachurées** (gravure). Pour en découper le contour, donner `mode: "line"` à leur couleur dans `ops`.
- `svg-from` : DP du fichier SVG ouvert par `sonic-file-open` (`ref-provider`), ou du SVG en texte. Un trait (`stroke`) est suivi tel quel, une surface (`fill`) est hachurée.
- `source="#id"` d'une source d'images (`sonic-still`, `sonic-paint`, `sonic-camera`…) : gravure par balayage. `input="image"` l'impose même si la source sait donner un SVG.

| Attribut (ou clé de `control`) | Rôle |
|---|---|
| `power`, `speed`, `passes` | Puissance en %, vitesse en mm/min, nombre de passes, pour les couleurs sans réglage propre |
| `mode` | `auto` (trait pour un contour, hachures pour un remplissage), `line`, `fill`, `skip` |
| `interval` | Écart entre deux lignes de hachure ou de balayage, en mm (0.1) |
| `kerf` | Compensation du trait de coupe : décalage des contours fermés, en mm (positif vers l'extérieur) |
| `ops` | Réglages par couleur, dans l'ordre d'exécution : `[{"color":"#000000","mode":"fill","power":20,"speed":3000},{"color":"#ff0000","mode":"line","power":90,"speed":300,"passes":2}]` |
| `width-mm`, `height-mm` | Taille voulue, proportions gardées. Sans elles : taille réelle du SVG (unités `mm`, `in`… ou 96 points par pouce), 50 mm de large pour une image |
| `x-mm`, `y-mm` | Position du coin bas gauche par rapport à l'origine de travail |
| `frame` | `content` (défaut : le cadre est l'emprise des formes) ou `document` (la page du SVG) |
| `max-s` | Valeur S de pleine puissance : celle de la machine (`laserState.maxS`, souvent 1000) |
| `dither`, `threshold`, `min-power` | Image : rendu (voir « Photo ») |
| `line-spacing`, `levels` | Écart des traits, paliers des lignes de niveau |
| `tool` | `laser` ou `pen` (traits seulement, stylo baissé par `M3 S…`, levé par `M5`) |
| `auto` | Reconstruit le programme à chaque changement de source ou de réglage |
| `show-preview` | Affiche les parcours ; le composant est alors aussi une source d'images |

Ordre d'exécution : les hachures d'abord, puis les traits ; les couleurs sans réglage propre avant celles de `ops`, puis `ops` dans l'ordre donné (mettre la découpe en dernier). Dans une même passe, les contours intérieurs passent avant ceux qui les entourent, puis au plus proche (recherche gloutonne bornée par les emprises, puis 2-opt sous budget de temps) ; un contour fermé est entamé au sommet le plus proche de la tête, un trait ouvert par son bout le plus proche. Les hachures sont faites île par île (une forme et ses trous, en serpentin), les îles enchaînées au plus proche. Avec plusieurs passes, chaque contour est repassé sur place avant le suivant (un trait ouvert repart dans l'autre sens) : pas de trajet entre les passes. La tête part de là où la passe précédente l'a laissée (`travelMm` de l'état : trajet à vide total). Le blanc (`#ffffff`) ne brûle pas.

Commandes : `build` (défaut de `for`), `download` (enregistre le fichier `.gcode`, utilisable dans un autre logiciel), `clear`.

État : `{ status, error, ready, seq, kind, colors, lines, bbox {x, y, w, h}, sizeMm {w, h}, estimateS, burnMm, travelMm, issues, skipped, settings }`.

### SVG quelconque : attribuer ses couleurs

Seules les couleurs nommées dans `ops` brûlent quand `mode="skip"` ; les autres suivent `mode`. `colors` liste les couleurs du dessin avec leur nombre de surfaces (`fill`) et de traits (`stroke`), même quand aucune n'est encore attribuée (`error` le dit) : une interface les affiche, l'utilisateur choisit une opération par couleur, et `ops` est reconstruit à partir de ce choix (une `sonic-jsonata` sur `progState.colors` et le store des choix). Les feuilles `<style>` simples (`.classe`, `#id`, balise) sont lues ; textes et images incrustées sont ignorés (`skipped`).

### Photo

`sonic-gcode` ne retouche pas l'image : la préparation se fait dans la source, avec les composants qui existent déjà. Une chaîne typique :

```json
{ "tagName": "sonic-still", "attributes": { "id": "photo", "in-data-provider": "fichierImg", "drop": true } }
{ "tagName": "sonic-shader", "attributes": { "id": "niveaux", "channel0": "#photo", "image": "@file:niveaux.glsl", "dataProvider": "niv" } }
{ "tagName": "sonic-shader", "attributes": { "id": "effet", "channel0": "#niveaux", "image": "@file:pile-effets.glsl", "dataProvider": "fx" } }
{ "tagName": "sonic-gcode", "attributes": { "id": "prog", "source": "#effet", "input": "image", "dither": "jarvis", "width-mm": 80 } }
```

- `niveaux` (bibliothèque shader) : luminosité, contraste, gamma, éclairage local (retire ombres et dégradés lents, utile avant un seuil).
- `pile-effets` : encre (contours), contour, crayonné, peinture, aplats, hachures, points, trame, négatif… ; `sobel` : contours seuls ; `halftone` : trame de points à angle réglable.
- En aplats vectoriels plutôt qu'en balayage : `sonic-vectorize` sur la photo, puis `svg-from` sur son fichier SVG (`<id>State.file`) et une opération par couleur (voir ci-dessus).

| `dither` | Rendu |
|---|---|
| `gray` | Balayage, puissance selon le gris (`min-power` pour le gris le plus clair) |
| `floyd`, `atkinson`, `jarvis`, `stucki`, `burkes`, `sierra`, `sierra-lite` | Diffusion d'erreur (shared/raster1bit, comme l'imprimante d'étiquettes) |
| `bayer` | Trame ordonnée |
| `random` | Bruit |
| `threshold` | Seuil simple (`threshold`) |
| `adaptive` | Seuil local : garde le détail dans les zones sombres et claires |
| `hatch` | Hachures croisées : 4 couches de plus en plus sombres, à 45°, −45°, 0° et 90° |
| `waves` | Ondes : une ligne par rangée, amplitude selon le sombre |
| `spiral` | Spirale depuis le centre, puissance selon le sombre |
| `isolines` | Lignes de niveau (`levels` paliers), comme une carte topographique |
| `stipple` | Pointillisme : points d'autant plus serrés que la zone est sombre |

Les rendus en traits (`hatch`, `waves`, `spiral`, `isolines`, `stipple`) utilisent `line-spacing` (mm) ; les autres `interval` (une ligne de balayage par `interval` mm). `estimateS` ignore les accélérations : la durée réelle est un peu plus longue.

## `sonic-grbl`

| Attribut | Rôle |
|---|---|
| `transport` | `#id` du `sonic-serial` |
| `source` | `#id` du `sonic-gcode` |
| `machine` | `auto` ou `atomstack-a5-pro` |
| `tool` | `laser` (défaut) ou `pen` |
| `max-power` | Plafond de puissance en % |
| `allow-settings` | Autorise `send` à écrire un réglage |

| Machine | Zone | Remarques |
|---|---|---|
| `auto` | Lue sur la machine (`$130`, `$131`) | Un programme trop grand donne une remarque, pas un refus : ces réglages sont souvent faux d'usine |
| `atomstack-a5-pro` | 410 × 400 mm | A5 Pro et A5 Pro+. Pont CH340, 115200 bauds, pas de fin de course : origine posée à la main. Un programme qui en sort est refusé |

| Commande (`control`) | Effet |
|---|---|
| `run` (défaut de `for`) | Lance le programme de `source`, ou `{n, gcode: "…"}`. `{n, from: 1234}` : reprise à cette ligne du programme (déplacement faisceau coupé jusqu'au point atteint, vitesse, puissance et M4 rétablis) ; `{n, dry: true}` = `dryRun` |
| `dryRun {n, speed, from}` | Essai à vide : mêmes mouvements, faisceau coupé (M3/M4 → M5, mots S retirés) ; `speed` 1 à 4 accélère (plafond 6000 mm/min). Ne compte pas dans `jobs` |
| `hold`, `resume` | Pause (le faisceau se coupe), reprise |
| `stop` | Arrêt : pause, attente de l'arrêt du mouvement, remise à zéro. La position est gardée |
| `frame {n, power, feed, shape, loops}` | Tour de l'emprise du programme (points brûlés). `shape: "hull"` : contour réel du dessin (enveloppe convexe) au lieu du rectangle ; `loops` 1 à 5. `power` 0 (défaut, faisceau éteint) à 5 % |
| `jog {n, x, y, feed}` | Déplacement relatif en mm, faisceau éteint |
| `goto {n, x, y, feed}` | Déplacement vers un point de travail |
| `jogCancel` | Interrompt un déplacement manuel |
| `setOrigin`, `clearOrigin` | L'origine de travail devient la position courante (`G92`), ou est retirée |
| `home` | Prise d'origine, si la machine a des fins de course (`$22=1`) |
| `unlock` | Déverrouille après une alarme (`$X`) |
| `reset` | Remise à zéro logicielle |
| `refresh` | Relit les réglages |
| `send {n, line}` | Ligne libre (console) |

État : `{ status, error, active, connected, firmware, machine, machineState, alarm {code, message}, pos {x, y, z}, mpos, feed, power, area {x, y}, maxS, laserMode, homing, settings, job {kind: job | dry | frame, from, total, line, lines, sent, acked, progress, running, paused, elapsedS, estimateS, bbox}, lastStop {kind, line, resumeAt, total, reason}, jobs, issues, console }`.

- `status` : `idle` (pas de transport) → `requesting` (attente de la machine) → `ready`. `error` porte un message lisible : pas de réponse (débit, machine éteinte), ligne refusée, alarme.
- `machineState` suit GRBL : `Idle`, `Run`, `Hold`, `Jog`, `Alarm`… Une tâche ne part que de `Idle`.
- `job.line` : dernière ligne du programme (préparé : sans lignes vides ni commentaires) entrée dans le planificateur. Après un arrêt, une erreur ou une alarme, `lastStop.resumeAt` donne la ligne de reprise conseillée (16 lignes avant, pour ne pas laisser de trou) : `run {n, from: lastStop.resumeAt}` (vérifier d'abord que la pièce n'a pas bougé). Une gravure menée au bout remet `lastStop` à `null`.
- `job.progress` compte les lignes acquittées : GRBL acquitte une ligne quand elle entre dans son planificateur, une quinzaine de mouvements avant de l'exécuter.
- `console` : les 30 dernières lignes échangées hors tâche, pour une console d'atelier.
- Événements DOM : `sonic-grbl-ready`, `sonic-grbl-start`, `sonic-grbl-done`, `sonic-grbl-stop`, `sonic-grbl-error {line, message}`.

## Réglages de départ (diode, à ajuster par des essais)

| Matériau | Opération | Puissance | Vitesse | Passes |
|---|---|---|---|---|
| Contreplaqué, bois clair | Gravure | 20 à 30 % | 2000 à 3000 mm/min | 1 |
| Contreplaqué 3 mm | Découpe | 90 à 100 % | 200 à 350 mm/min | 2 à 4 |
| Carton, papier épais | Découpe | 60 à 80 % | 800 à 1200 mm/min | 1 |
| Cuir | Gravure | 15 à 25 % | 2500 mm/min | 1 |

Ces valeurs sont des points de départ, pas des mesures : faire une grille d'essais sur une chute avant chaque nouveau matériau.

## Limites

- GRBL 1.1 seulement (ni Marlin, ni Ruida, ni les machines à protocole fermé).
- Sans fin de course, la machine ne sait pas où elle est : la zone de travail n'est vérifiée qu'en taille, pas en position.
- Arcs (`G2` / `G3`) d'un programme importé : envoyés tels quels, mais l'emprise et la durée n'en comptent que les extrémités.
- Textes et images incrustés dans un SVG : ignorés (comptés dans `skipped`). Convertir les textes en chemins avant.
- Pas de surcourse en gravure d'image : les bords d'une image très contrastée peuvent être un peu plus foncés.

## `sonic-laser-pattern`

Modèles paramétriques, sans JS : le SVG (millimètres réels, noir = gravure, bleu = marquage, rouge = découpe) est publié dans l'état et lu par `sonic-gcode svg-from="<id>State"`.

```json
{ "tagName": "sonic-laser-pattern", "attributes": { "id": "modele", "pattern": "boite", "control": "modeleCtl" } }
{ "tagName": "sonic-gcode", "attributes": { "id": "prog", "svg-from": "modeleState", "auto": true, "ops": "…" } }
```

`control` = `{ pattern: "boite", params: { largeur: 80, epaisseur: 3 } }` ; l'état publie `specs` (libellé, bornes, pas, unité de chaque paramètre) pour construire le formulaire, et `catalog` (les modèles). La grille d'essais publie aussi `ops` : une opération par case (puissance × vitesse), à passer telle quelle à `sonic-gcode`.

| Modèle | Paramètres |
|---|---|
| `grille` | `puissances`, `pmin`, `pmax`, `vitesses`, `vmin`, `vmax`, `case`, `decoupe` |
| `boite` | `largeur`, `profondeur`, `hauteur`, `epaisseur`, `creneau`, `couvercle`, `motif` |
| `engrenages` | `dents1`, `dents2`, `module`, `axe`, `rayons` |
| `puzzle` | `colonnes`, `lignes`, `piece`, `coins`, `graine`, `motif` |
| `tampon` | `taille`, `forme` (0 étoile, 1 cœur, 2 fleur), `branches`, `anneau`, `miroir` |
| `porte-cles` | `largeur`, `hauteur`, `rayon`, `trou`, `bordure`, `motif` |
| `pendentif` | `diametre`, `trou`, `bordure`, `motif` |
| `dessous` | `diametre`, `anneaux`, `motif` |
| `regle` | `longueur` (cm), `largeur` |

`motif` : 0 aucun, 1 cœur, 2 étoile, 3 fleur, 4 rosace.

Pour des illustrations plus riches (personnages, arbres, bâtiments, blasons…), `sonic-procgen` en rendu vectoriel publie son SVG (`control.exportSvg`, état `svg`) : même branchement sur `svg-from`, et une opération par couleur.

## `sonic-gcode-view`

```json
{ "tagName": "sonic-gcode-view", "attributes": { "id": "vue", "source": "#prog", "machine": "atomstack-a5-pro", "state-from": "laserState", "control": "vueCtl", "drag-job": true, "target": "job", "style": "height:60svh" } }
```

Le programme réel (celui que recevra la machine), à zoom libre : molette ou pincement sous le pointeur, glisser pour déplacer, double-clic ou `0` pour tout voir, boutons intégrés (zoom, travail, plateau ; `no-controls` les masque). Repère en millimètres : grille 1-2-5 adaptée au zoom, règles cotées en haut et à gauche, axes du travail (X rouge, Y vert) et origine, plateau de la machine (`machine` ou `bed="410 400"`, ou zone lue sur la machine), emprise cotée, coordonnées du pointeur. Le trait a la largeur réelle du faisceau (`beam-mm`, 0,1) quand on zoome assez.

| Attribut | Rôle |
|---|---|
| `source` | `#id` du `sonic-gcode` |
| `machine`, `bed` | Plateau (profil, ou `"largeur hauteur"` en mm) |
| `state-from` | État du `sonic-grbl` : tête (croix), origine posée (le plateau se décale d'autant), tâche en cours (le fait en plein, le reste estompé) |
| `control` | `{fit: n, bed: n, zoomIn: n, zoomOut: n, upTo: 0..1, travel: bool, beamMm}` : `upTo` simule l'avancement (tracé jusque-là, tête bleue au point atteint ; 1 ou vide : tout le tracé) ; `travel` montre les déplacements à vide en pointillés |
| `drag-job` + `target` | Glisser l'emprise envoie `{type: "place", payload: {dx, dy}}` (mm, pas de 0,1 à 1 selon le zoom) au store au lâcher : le réducteur ajoute dx, dy au décalage `xMm`, `yMm` du `sonic-gcode` |
| `show-travel`, `beam-mm`, `gestures` | Déplacements à vide, largeur du faisceau, cohabitation avec le défilement (`auto`, `capture`, `cooperative`) |

État (`out-data-provider`, défaut `<id>State`) : `{status: empty | ready, pointer {x, y} | null, zoom (px/mm), bbox, segments, lines, bed, seq}`.

**Avant de lancer** : placer (glisser l'emprise, ou décalage et ancrage dans le store), cadrer (`frame`, `shape: "hull"`), essai à vide (`dryRun`, `speed: 2`), puis `run`. Arrêt : `stop` ; reprise : `run {from: lastStop.resumeAt}`.
