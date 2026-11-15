# Format « monde » : un monde complet en primitives, pour `sonic-3d` et `sonic-2d`

Un **monde** est un JSON que l'agent écrit (ou qu'un reducer modifie) : une palette, des **modèles articulés**
faits de formes simples, leurs **animations** (clips), et le **placement** (instances pilotables, décor semé).
Les deux rendus lisent **le même JSON** (clé `monde` du DataProvider ou attribut `monde`) et **les mêmes `nodes`** :
un reducer écrit pour la 3D anime la 2D à l'identique, et inversement.

```json
{ "tagName": "sonic-3d", "attributes": { "dataProvider": "jeu", "target": "jeu", "pick": true, "pick-names": "^p[0-9]" } }
{ "tagName": "sonic-2d", "attributes": { "dataProvider": "jeu", "target": "jeu", "width": "720", "height": "480" } }
```

DP `jeu` : `{ "monde": {…}, "nodes": { "p0": { "x": 2, "z": 1, "ry": 1.57, "clip": "course", "ease": { "ms": 300 } } } }`.

## Repère et unités

Mètres, **y vers le haut**, le sol en `y = 0`, l'avant d'un modèle vers **+z**. Rotations en **degrés** dans le JSON
du monde (`rot`), en **radians** dans `nodes` (format partagé). Euler ordre XYZ.
`unite: "cm"` (ou `mm`) permet d'écrire le monde dans une autre unité (voir Prefabs paramétrés) ; `nodes` reste en mètres.

## Clés du monde

| Clé | Rôle |
|---|---|
| `palette` | Couleurs par rôle : `{"maillot": "#2563eb", "peau": "#f2c29b"}` (rôles par défaut : peau, maillot, short, chaussure, cheveux, oeil, pupille, accent, bois, feuillage, pierre, metal, sol, eau, blanc, noir) |
| `models` | `{nom: modèle}` (64 au plus) |
| `place` | Liste de placements (4000 copies au plus, 400 instances nommées) |
| `textures` | Texture par rôle : `{"maillot": "rayures", "sol": {"kind": "herbe", "scale": 2}}` |
| `texture` | Texture de toutes les pièces sans texture propre (`"grain"` = aspect gouache) |
| `look` | `doux` (mat, défaut), `toon` (aplats), `brillant` |
| `detail` | Finesse des maillages : `low`, `mid`, `high` |
| `shadows` | Ombres au sol des instances (défaut `true`) |
| `outline` | Contour des silhouettes 2D en px (défaut 1, 0 = aucun) |
| `view2d` | Vue 2D : `{"view": "top" \| "side" \| "front" \| "iso", "unit": 48 (px par m), "origin": [x, y] (position écran de l'origine)}` |
| `ciel`, `brume` | Fond 3D et brume (0 à 1) |
| `traits` | Importance des traits (contours) des modèles `gen` : 0 aucun, 1 (défaut) celui du style, jusqu'à 3 ; 0,4 pour un rendu léger |
| `style` | Style des modèles `gen` : préréglage procgen (`gouache`, `doux`, `bd`, `encre`, `aquarelle`, `papier`, `nuit`, `crepuscule`…) ou jetons `{preset, shading, bands, outline, palette…}` ; défaut selon `look` |

## Modèle

```json
{ "preset": "bipede", "seed": 3, "params": { "espece": "chat" },
  "parts": [ { "name": "casquette", "parent": "tete", "at": [0, 0.3, 0], "sphere": [0.2, 0.08, 0.22], "role": "accent" } ],
  "clips": { "salut": { "ms": 600, "loop": false, "then": "idle", "tracks": { "brasR": { "rz": [8, 150, 130, 150, 8] } } } },
  "clip": "idle" }
```

- `preset` + `seed` + `params` : générateur procédural (voir plus bas) ; ses pièces et clips sont ensuite complétés
  ou remplacés par `parts` (même `name` = remplace) et `clips` (même nom = remplace).
- `parts` (160 au plus), dans n'importe quel ordre :

| Clé | Rôle |
|---|---|
| `name` | Nom (lettres, chiffres, `_`, `-`) ; nœud `<instance>_<name>` |
| `parent` | Pièce parente (sinon la racine du modèle) |
| `at` | **Articulation** dans le repère du parent : c'est le point autour duquel la pièce tourne |
| `rot` | Rotation de repos (degrés) |
| `off` | Centre de la forme par rapport à l'articulation (un bras qui pend : `off: [0, -0.2, 0]`) |
| `scale` | Nombre ou `[x, y, z]` |
| forme | **Une** des clés : `box: [w, h, d, arrondi]`, `sphere: r` ou `[rx, ry, rz]`, `capsule: [r, longueur]` (le long de y), `cylinder: [r, h, rHaut]`, `cone: [r, h]`, `torus: [R, r, arcDeg]` (autour de y), `lathe: [[r, y], …]` (profil tourné autour de y), `extrude: {pts: [[x, y], …], depth}` (polygone dans le plan XY, épaissi en z), `tube: {pts: [[x, y, z], …], r, r2}`, `plane: [w, d]` (sol, face vers +y). Sans forme : articulation pure |
| `role` / `color` | Rôle de couleur (palette, recolorable par instance) ou couleur fixe |
| `tex` | Texture propre (voir Textures) |
| `glow` | 0 à 1 : pièce lumineuse (reflet d'œil, lampe, écran) |
| `mirror: "x"` | Pièce dédoublée : `<name>L` (telle quelle) et `<name>R` (symétrique en x). **Les enfants d'une pièce dédoublée le sont aussi** (bras → avant-bras → main) |
| `repeat` | `{n, at, rot}` : `n` copies `<name>0…`, chacune décalée de `at` et tournée de `rot` depuis la précédente (dents, boutons, pétales, piquets) |
| `hidden` | Pièce cachée au départ |

- `clips` (32 au plus) : `{ms, loop (défaut true), then, ease: "smooth" | "linear", tracks}`.
  `tracks.<pièce>` = canaux `rx ry rz` (degrés, **ajoutés** au repos), `x y z` (mètres), `s` (facteur d'échelle), chacun
  une liste de clés réparties sur la durée (courbe douce qui passe par chaque clé). Une piste au nom d'une paire
  `mirror` (`"bras"`) anime les deux côtés **en opposition** (marche) ; `"sync": true` les anime ensemble ; `"phase"`
  décale (0 à 1). Une piste `"brasR"` ne vise qu'un côté. Une piste au nom d'une `repeat` décale chaque copie (vague).
  Un clip non bouclé reste sur sa dernière clé, ou enchaîne sur `then`. Un changement de clip se fond en 160 ms.

## Placement

```json
[ { "model": "terrain" },
  { "model": "joueur", "name": "p0", "at": [0, 0, 2], "rot": [0, 180, 0], "roles": { "maillot": "#e11d48" }, "clip": "idle" },
  { "model": "arbre", "scatter": 40, "area": [-20, -20, 20, -8], "seed": 3, "size": [0.7, 1.3] },
  { "model": "piquet", "grid": [12, 1], "step": [1.5, 0, 0], "at": [-9, 0, 6], "jitter": 0.1, "turn": 8 } ]
```

- **Avec `name`** : instance pilotable (nœud `name`, pièces `name_<pièce>`), animée, recolorable, touchable.
- **Sans `name`** : décor statique, fusionné pour la performance (3D : un appel de dessin par pièce de modèle, quel que
  soit le nombre de copies ; 2D : dessiné une fois). `grid` `[nx, nz]` ou `[nx, ny, nz]` + `step` ; `scatter` n copies
  dans `area` `[x0, z0, x1, z1]` (orientation aléatoire) ; `jitter` (part du pas), `turn` (degrés), `size` `[min, max]`.

## Pilotage par `nodes` (format partagé)

| Nœud | Champs |
|---|---|
| `<instance>` | `x y z` (m), `rx ry rz` (rad), `scale`, `visible`, `opacity`, `ease {ms, curve}`, `lift` (saut en arc pendant l'interpolation) ; **`clip`** (nom), **`clipSpeed`** (1 = normal, garde la phase), **`clipT`** (0..1 : pose figée, `null` pour relâcher) ; **`roles`** `{"maillot": "#…"}` |
| `<instance>_<pièce>` | `visible`, `color`, `opacity` (3D : aussi `emissive`, `rx`…) |

Republier la même valeur ne relance rien. Les instances gardent leur état quand le monde change (ajout d'un arbre,
retouche d'un modèle) : seuls les modèles modifiés sont reconstruits.

## Sortie

`out-data-provider` (distinct du `dataProvider`) reçoit `mondeInfo : {models: {nom: {parts, clips, roles, clip}}, instances: [{name, model}], decor, issues}`.
Avec des prefabs : `mondeInfo.prefabs = {nom: {params, famille, tags, pose, degagement, slots, variants}}` (de quoi bâtir un
formulaire ou un catalogue) et `instances[].prefab` = nom écrit du modèle (`model` est alors sa variante `nom~clé`).
Avec des appuis : `instances[].on` = `appui@surface` et `mondeInfo.conflicts` (voir Pose).
`issues` liste les erreurs du JSON (chemin + message) : une erreur n'empêche jamais le rendu du reste.
Tap : `pick` avec `objectId` = instance (en 2D, `part` en plus).

## Prefabs paramétrés

Un modèle en pièces peut déclarer des **paramètres**, les utiliser dans ses pièces par des **expressions**, contenir
d'autres modèles (`use`) et offrir des **emplacements** (`slots`). Chaque placement donne ses valeurs : un seul modèle
écrit, autant de déclinaisons que voulu.

```json
{
  "models": {
    "chaise": { "parts": [ { "name": "assise", "box": [0.42, 0.04, 0.42], "at": [0, 0.45, 0], "role": "bois" } ] },
    "table": {
      "params": {
        "longueur": { "default": 1.6, "min": 0.8, "max": 4, "step": 0.2, "unit": "m" },
        "couverts": { "default": 4, "options": [2, 4, 6] },
        "teinte": { "default": "#8b5a2b" }
      },
      "parts": [
        { "name": "plateau", "box": ["= longueur", 0.05, 0.8, 0.02], "at": [0, 0.75, 0], "color": "= teinte" },
        { "name": "pied", "cylinder": [0.03, 0.75], "at": ["= longueur / 2 - 0.08", 0, 0.32], "mirror": "x" }
      ],
      "use": [ { "model": "chaise", "repeat": "= couverts / 2", "rot": [0, 180, 0],
                 "at": ["= (i + 0.5) * longueur / (couverts / 2) - longueur / 2", 0, 0.6] } ]
    }
  },
  "place": [
    { "model": "table", "name": "t1", "params": { "longueur": 2.4, "couverts": 6 } },
    { "model": "table", "scatter": 40, "area": [-30, -30, 30, 30],
      "params": { "longueur": "= pick(1.2, 1.6, 2.4)", "teinte": "= pick('#8b5a2b', '#5b3a1e')" } }
  ]
}
```

- **`params.<nom>`** : `{default, min, max, step, options, unit, doc, type}`. `type` se déduit du défaut : `nombre`,
  `choix` (dès qu'il y a `options`), `couleur` (`#rrggbb`), `bool`, `texte` ; `matiere` se déclare. `unit` est une
  indication pour les interfaces. Une valeur nue (`"hauteur": 2`) vaut `{default: 2}`.
- **Expressions** : toute valeur d'une pièce, d'un `use`, d'un emplacement ou d'un clip peut être `"= …"` : paramètres
  du modèle, `+ - * / % ^`, comparaisons, `a ? b : c`, `min max clamp mix abs floor round sqrt pow sin cos` (degrés),
  `rand(a, b)`, `randint`, `pick(…)`, `chance(p)`, `noise(x, y)`. Aucun code n'est exécuté.
- **`use`** : `{model, name, parent, at, rot, scale, repeat, params, slots}`. Le sous-modèle est déplié : une
  articulation `<name>` (pilotable, animable) puis ses pièces `<name>_<pièce>`. Avec `repeat`, les copies s'appellent
  `<name>0…` et lisent `i` (rang) et `n` (total). 4 niveaux au plus, 64 sous-modèles par modèle ; un modèle `gen` ne se
  déplie pas (le placer à part).
- **`slots`** : `{"abatJour": {"accepte": "abat-jour", "at": [0, "= hauteur", 0], "default": "cone"}}` réserve un
  emplacement aux modèles de la `famille` indiquée. Le placement choisit : `"slots": {"abatJour": "boule"}`,
  `{"model": "boule", "params": {…}}` ou `null` (vide).
- **`matiere`** sur une pièce : nom du nuancier, qui donne couleur, texture et éclat. Matières de base : `chene`, `pin`,
  `noyer`, `hetre`, `bois-blanc`, `bois-noir`, `acier`, `laiton`, `metal-noir`, `lin`, `coton`, `laine`, `marbre`,
  `pierre`, `blanc`, `noir` ; `materiaux` du monde en ajoute ou en remplace
  (`{"rose": "#ff66aa", "velours": {"color": "#7c2d12", "tex": "tissu"}}`).
- **Catalogue** : `famille`, `tags`, `pose` (`sol`, `mur`, `plafond`, `dessus`), `degagement` décrivent le modèle ; ils
  sont publiés tels quels (voir Sortie).
- **Placement** : `params` accepte des expressions tirées **par copie** dans une grille ou un semis (`i`, `n`, `rand`,
  `pick`). Un nombre tiré sans `step` est ramené à 16 paliers (entre `min` et `max`).
- **`unite`** (clé du monde) : `m` (défaut), `cm` ou `mm`. Elle vaut pour les longueurs écrites : pièces, `use`,
  placements (`at`, `step`, `area`), translations de clips, et donc les paramètres qui les nourrissent. Les
  préréglages, les modèles `gen`, `view2d` et **`nodes` restent en mètres**.

**Coût.** Chaque jeu de valeurs distinct devient une *variante* : un modèle ordinaire `table~<clé>`, construit une fois
et instancié comme n'importe quel décor. Un paramètre de couleur lu seulement par `"color": "= nom"` ne crée **aucune**
variante : c'est un rôle de couleur de la copie (`~nom`), modifiable en jeu par `nodes.<instance>.roles = {"~teinte":
"#…"}`. Tout autre paramètre crée une variante par valeur : donner un `step` ou des `options` aux paramètres tirés au
hasard. Plafonds : 32 variantes par modèle, 512 par monde ; au-delà la variante la plus proche est réutilisée et une
`issue` le dit. Changer un paramètre d'une instance dans le store ne reconstruit que la nouvelle variante.

## Pose : appuis, piles, semis sans chevauchement

Un placement peut dire **sur quoi** il repose au lieu de donner une hauteur. La pose est calculée à la lecture, sur le
maillage réel des modèles : pas de moteur physique.

```json
{ "place": [
  { "model": "table", "name": "t1", "at": [4, 0, 2], "rot": [0, 90, 0] },
  { "model": "paquet", "name": "colis", "on": "t1", "at": [0.5, 0.1], "turn": 20 },
  { "model": "livre", "on": "t1@tablette", "scatter": 5, "spacing": 0.02 },
  { "model": "caisse", "on": "sol", "at": [8, 0, 2], "stack": 3 },
  { "model": "arbre", "on": "sol", "scatter": 200, "area": [-40, -40, 40, 40], "spacing": 1.5, "avoid": ["route", "batiment"] }
] }
```

- **`on: "<instance>"`** ou **`"<instance>@<surface>"`** : posé sur une instance **nommée** (écrite avant ou après, peu
  importe). `at` vaut alors `[x, z]` depuis le centre de la surface, dans le repère de l'appui (il tourne avec lui) ;
  l'objet est ramené dans le contour de la surface. Sa base (point le plus bas du modèle) touche la surface.
- **Surfaces** : `top` (défaut) est le dessus de la pièce marquée `"surface": "top"`, sinon le dessus de tout le modèle.
  Une pièce marquée `"surface": "<nom>"`, ou simplement nommée, est adressable par ce nom (`t1@tablette`). Un modèle
  `gen` n'a pas de surface mesurable (on peut le poser, pas poser dessus).
- **`on: "sol"`** : la base du modèle est posée à la hauteur `at[1]` (utile quand l'origine du modèle n'est pas à sa base).
- **`stack: n`** : `n` copies empilées (au sol ou sur un appui), avec un léger désordre. Les copies ne sont pas nommées.
- **`grid` / `scatter` sur un appui** : la grille se répartit sur la surface (`step` facultatif) ; le semis ne chevauche
  ni ses copies ni ce qui est déjà posé sur la surface.
- **`spacing`** (semis) : écart minimal entre copies, au-delà de leur emprise. **`avoid`** (semis au sol) : noms
  d'instances, de modèles, de `famille` ou de `tags` dont l'emprise (rectangle au sol, tourné comme l'objet) est
  interdite ; seuls les placements écrits **avant** le semis comptent. Les copies sans place libre sont sautées et
  comptées dans une `issue`.
- **Suivre l'appui** : une instance nommée posée sur une instance nommée la suit (position, cap, échelle uniforme)
  quand `nodes` la déplace, de proche en proche (livre sur paquet sur table). Le décor sans nom est posé une fois.
- **En jeu** : `nodes.colis = {"on": "t2@top", "at": [0, 0.1], "ease": {"ms": 300}, "lift": 0.3}` déplace l'objet
  d'un appui à l'autre ; `"on": null` le détache sur place ; lui donner `x`, `y` ou `z` le détache aussi ; `ry` le
  tourne sur son appui.
- **À revoir** : `mondeInfo.conflicts = [{a, b, type}]`, `type` = `hors-appui` (objet plus grand que la surface ou
  ramené dans son contour) ou `chevauchement` (deux objets posés au même endroit). La pose est faite quand même.
- Limites : appui horizontal seulement (pas de mur ni de plafond), échelle d'appui uniforme, inclinaison de l'appui
  ignorée. Format `monde` seulement (pas `monde2d`).

## Modèles `gen` : générateurs procgen (3D)

`{"gen": "character", "params": {…}, "seed": 4}` confie la forme aux générateurs procgen : personnages humains en
maillage continu skinné (visage, coiffure, garde-robe en couches), animaux (`animal.dog`, `animal.horse`, `animal.duck`…),
`tree`, `bush`, `rock`, `plant`, `flowers`, `building` (17 styles), `prop.<objet>`, `vehicle`, `wall`, `ball.<ballon>`,
`seat.<assise>`, `assembly`. `params` = paramètres du générateur (voir le catalogue procgen : `top`, `bottom`, `hair`,
`archetype` `chibi|cartoon|stylized|heroic`, `height`…). **Personnages animaux** : `params.animal` `cat|fox|dog|bear|rabbit|mouse|pig|owl|frog|dino|lion|tiger|panda|koala|raccoon|monkey|cow|sheep|deer|horse|elephant|duck` donne
la tête, les oreilles, le museau (ou le bec), la queue et le pelage de l'espèce au corps humanoïde (mêmes vêtements, mêmes
os, mêmes clips : une équipe de chats en maillot). Rendu `sonic-3d` avec le style procgen (`style` du monde) :
bandes toon, AO, textures et relief par matière, contour. Généré à la demande sans figer la page (le nœud est pilotable
tout de suite, le maillage apparaît quand il est prêt). Pas de rendu dans la projection 2D (`sonic-2d` : `monde2d`).

- **Os = pièces** (sans forme) : `racine bassin dos torse cou tete epauleL/R brasL/R avantBrasL/R mainL/R cuisseL/R
  molletL/R piedL/R orteilL/R` (animaux : `cou1 cou2 machoire oreilleL/R queue1..3 doigtL/R`, oiseaux : `aileL/R`).
  Les pistes de clips les tournent (degrés, **ajoutés** à l'animation procédurale ; `racine` : aussi `x y z`).
- **Clips du moteur** : `idle`, `marche`, `course` (foulée intégrée par la distance réellement parcourue : un
  personnage déplacé par `nodes` marche ou court, pieds plantés ; immobile, `marche` / `course` le font courir sur place),
  `joie`, `saut`, `salut`, `montre`, `parle`, `porte`, `assis`, `reflechit`, `salue`, `boit`, `mange`, `dort`. **Gestes de jeu** (pistes d'os) :
  `tir`, `passe`, `controle`, `tacle`, `chute`, `plongeon`. Un clip écrit au même nom remplace le geste.
- **Couleurs** : `roles` (placement ou `nodes`) avec les noms du format (`maillot`, `short`, `chaussette`, `chaussure`,
  `peau`, `cheveux`, `toit`, `mur`, `feuillage`…) ou procgen (`cloth1`, `skin`, `roof`…).
- `nodes.<instance>_<os>` : `emissive` (0..1) et `emissiveColor` donnent un éclat à tout l'acteur.
- Sans `name` : décor instancié (un appel de dessin par modèle, quel que soit le nombre de copies).
- **Fiche animal** `params.animalSpec` : retouche l'espèce (ou en invente une : sans `animal`, ou `animal: "custom"`),
  champs facultatifs : `ears {shape pointed|round|floppy|long|flap|tuft|none, size 0..3, spread 0..1, tilt}`,
  `horns none|small|antlers`, `snout {w, h, l}` (`l` > 1,2 : trompe), `nose` (bool ou `"disc"` : groin), `beak`, `mane`,
  `markings none|mask|patches`, `eyeBulge`, `spikes`, `eyeDiscs`, `tail {shape curve|bushy|wag|stub|pom|long|curl|fan|thick|tuft|none, length 0..3, tip}`,
  `colors {fur [#…], muzzle, nose, innerEar, beak, mane, marks, tailTip}`. Valeurs inconnues ignorées.
  Rôles recolorables par instance : `fourrure museau truffe oreille bec criniere marques boutQueue cornes`.
- **Variantes par placement** : `params` (fusionnés à ceux du modèle) et `genSeed` sur un placement d'un modèle `gen`
  (`{ "model": "j", "name": "p3", "params": { "animal": "fox", "mood": "happy" } }`) : une foule variée sans un modèle
  par personne ; les placements identiques partagent la variante (64 au plus). Changer ces `params` dans le store
  reconstruit seulement l'acteur concerné (humeur, espèce, tenue en cours de jeu).
- **Clips libres** : un clip d'un modèle `gen` peut fixer `action` (moteur procgen : `idle walk run wave point cheer talk
  carry sit jump think bow hammer sweep dig kick`) et `speed` (locomotion en m/s, 0 sur place), en plus de ses pistes :
  `"danse": { "action": "cheer", "speed": 0, "tracks": { "brasL": { "rz": [0, 60, 0] } } }`.

```json
{ "style": "bd",
  "models": { "joueur": { "gen": "character", "params": { "archetype": "cartoon", "top": "tee", "bottom": "shorts", "pattern": "plain", "hat": "none" } },
              "maison": { "gen": "building", "seed": 2 }, "chene": { "gen": "tree" } },
  "place": [ { "model": "maison", "at": [-6, 0, -6] }, { "model": "chene", "scatter": 8, "area": [-12, -9, 12, -4] },
             { "model": "joueur", "name": "p0", "roles": { "maillot": "#e11d48" } } ] }
```

## Préréglages (`preset`)

| Nom | Contenu | `params` |
|---|---|---|
| `bipede` | Personnage ou créature : bassin, torse, ventre, numero (dos), tête, yeux (pupille, reflet), museau, nez, bouche, oreilles, cornes, cheveux, bras, avant-bras, mains, cuisses, mollets, pieds, queue. Clips `idle marche course controle tir passe tacle chute saut joie plongeon` | `espece` (humain, chat, renard, ours, lapin, dino, monstre, grenouille, robot), `taille`, `corpulence`, `grosseTete` (0.26 à 0.42), `tete`, `oreilles`, `queue`, `cornes`, `cheveux`, `yeux`, `museau`, `ventre`, `peau` |
| `quadrupede` | Animal : corps, cou, tête, museau, yeux, oreilles, pattes avant/arrière (2 segments), queue. Clips `idle marche course assis saut` | `taille`, `longueur`, `oreilles`, `queue`, `peau` |
| `arbre` | `rond`, `sapin`, `palmier`, `boules` | `taille`, `forme` |
| `rocher`, `maison`, `nuage`, `ballon` | Décor ; `ballon` a le clip `roule` | voir le générateur |

Rôles des préréglages : `peau`, `maillot`, `short`, `chaussette`, `chaussure`, `numero`, `museau`, `ventre`, `corne`, `crete`,
`cheveux`, `oeil`, `pupille` ; recoloriables par instance (`roles`).

## Textures

Procédurales (aucune image), tuilables, collées **en mètres** (même taille de motif sur un bras et sur un mur), teintées
par la couleur de la pièce : `bois tissu marbre bruit grain rayures damier pois herbe brique carrelage ecailles fourrure
metal pierre hachures tricot nuages camouflage` (noms anglais acceptés). Forme longue :
`{"kind": "rayures", "color2": "#ffffff", "scale": 6 (motifs par m), "angle": 30, "contrast": 0.6}`. Priorité : `tex` de la
pièce > `textures.<rôle>` > `texture` du monde. Styles rapides : `"texture": "grain"` (gouache), `"hachures"` (BD),
`"look": "toon"` (aplats).

## Performance

Géométries et matières partagées entre instances ; décor instancié (3D) ou dessiné une fois (2D) ; en 2D, une
silhouette n'est recalculée que lorsqu'une pièce tourne assez pour changer de profil, et ses dessins sont partagés
entre instances d'un même modèle. Aucune animation tant qu'aucun clip ne bouge (2D rendu à la demande).
