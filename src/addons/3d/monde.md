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
`issues` liste les erreurs du JSON (chemin + message) : une erreur n'empêche jamais le rendu du reste.
Tap : `pick` avec `objectId` = instance (en 2D, `part` en plus).

## Modèles `gen` : générateurs procgen (3D)

`{"gen": "character", "params": {…}, "seed": 4}` confie la forme aux générateurs procgen : personnages humains en
maillage continu skinné (visage, coiffure, garde-robe en couches), animaux (`animal.dog`, `animal.horse`, `animal.duck`…),
`tree`, `bush`, `rock`, `plant`, `flowers`, `building` (17 styles), `prop.<objet>`, `vehicle`, `wall`, `ball.<ballon>`,
`seat.<assise>`, `assembly`. `params` = paramètres du générateur (voir le catalogue procgen : `top`, `bottom`, `hair`,
`archetype` `chibi|cartoon|stylized|heroic`, `height`…). Rendu `sonic-3d` avec le style procgen (`style` du monde) :
bandes toon, AO, textures et relief par matière, contour. Généré à la demande sans figer la page (le nœud est pilotable
tout de suite, le maillage apparaît quand il est prêt). Pas de rendu dans la projection 2D (`sonic-2d` : `monde2d`).

- **Os = pièces** (sans forme) : `racine bassin dos torse cou tete epauleL/R brasL/R avantBrasL/R mainL/R cuisseL/R
  molletL/R piedL/R orteilL/R` (animaux : `cou1 cou2 machoire oreilleL/R queue1..3 doigtL/R`, oiseaux : `aileL/R`).
  Les pistes de clips les tournent (degrés, **ajoutés** à l'animation procédurale ; `racine` : aussi `x y z`).
- **Clips du moteur** : `idle`, `marche`, `course` (foulée intégrée par la distance réellement parcourue : un
  personnage déplacé par `nodes` marche ou court, pieds plantés ; immobile, `marche` / `course` le font courir sur place),
  `joie`, `saut`, `salut`, `montre`, `parle`, `porte`, `assis`, `reflechit`, `salue`. **Gestes de jeu** (pistes d'os) :
  `tir`, `passe`, `controle`, `tacle`, `chute`, `plongeon`. Un clip écrit au même nom remplace le geste.
- **Couleurs** : `roles` (placement ou `nodes`) avec les noms du format (`maillot`, `short`, `chaussette`, `chaussure`,
  `peau`, `cheveux`, `toit`, `mur`, `feuillage`…) ou procgen (`cloth1`, `skin`, `roof`…).
- `nodes.<instance>_<os>` : `emissive` (0..1) et `emissiveColor` donnent un éclat à tout l'acteur.
- Sans `name` : décor instancié (un appel de dessin par modèle, quel que soit le nombre de copies).

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
