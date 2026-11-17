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
| `detail` | Finesse des maillages : `low`, `mid`, `high` (et plafond de la texture adaptative : 256, 512, 1024 px) |
| `environnement` | Reflets : `studio`, `exterieur`, `aucun` (voir Finis) |
| `arrondi` | Arrondi des arêtes (m) des boîtes qui n'en écrivent pas (défaut : celui de l'ambiance, sinon 0) ; des arêtes un peu arrondies accrochent la lumière |
| `facettes` | `true` : facettes visibles (ombrage plat, rendu low-poly) |
| `ambiance` | Direction artistique d'un mot (rendu, ciel, palette, style `gen`, lumière, étalonnage), voir Ambiances |
| `lumiere`, `etalonnage` | Lumière et étalonnage de l'image (voir Ambiances) |
| `souple`, `cheveux` (sur une pièce) | Tissus et chaînes simulés, chevelures en mèches (voir Tissus souples et chevelures) |
| `herbes` | Herbes hautes, blé, roseaux, prairies fleuries, gazon (3D), voir Herbes et champs |
| `physique` | Physique 3D : corps rigides, liaisons, forces (voir Physique 3D) |
| `photo` | Rendu photo en lancer de rayons quand la vue s'arrête (3D) : `true` ou `{echantillons, rebonds, attente}` (voir Rendu photo) |
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
| `<instance>` | `x y z` (m), `rx ry rz` (rad), `scale`, `visible`, `opacity`, `ease {ms, curve}`, `lift` (saut en arc pendant l'interpolation) ; **`clip`** (nom), **`clipSpeed`** (1 = normal, garde la phase), **`clipT`** (0..1 : pose figée, `null` pour relâcher) ; **`roles`** `{"maillot": "#…"}` ; **`move`** `[x, z]` (m) : range l'objet au point visé, `ry` en plus = cap voulu (voir Édition) ; **`collide`** `"glisser"` \| `"bloquer"` \| `true` avec `x` / `z` : le déplacement s'arrête aux obstacles (voir Déplacements en jeu) |
| `<instance>_<pièce>` | `visible`, `color`, `opacity` (3D : aussi `emissive`, `rx`…) |

Republier la même valeur ne relance rien. Les instances gardent leur état quand le monde change (ajout d'un arbre,
retouche d'un modèle) : seuls les modèles modifiés sont reconstruits.

## Sortie

`out-data-provider` (distinct du `dataProvider`) reçoit `mondeInfo : {models: {nom: {parts, clips, roles, clip}}, instances: [{name, model}], decor, issues}`.
Avec des prefabs : `mondeInfo.prefabs = {nom: {params, famille, tags, pose, degagement, slots, variants}}` (de quoi bâtir un
formulaire ou un catalogue) et `instances[].prefab` = nom écrit du modèle (`model` est alors sa variante `nom~clé`).
Avec des appuis : `instances[].on` = `appui@surface` et `mondeInfo.conflicts` (voir Pose), recalculés après chaque
rangement (`move`, glisser). Un rangement publie aussi `placed` (voir Édition).
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
- **`matiere`** sur une pièce : nom du nuancier, qui donne couleur, texture, éclat et fini (voir « Finis »). Matières de base : `chene`, `pin`,
  `noyer`, `hetre`, `bois-blanc`, `bois-noir`, `acier`, `laiton`, `metal-noir`, `chrome`, `or`, `cuivre`, `aluminium`,
  `verre`, `verre-depoli`, `verre-fume`, `plastique`, `plastique-brillant`, `laque`, `ceramique`, `cuir`, `velours`,
  `caoutchouc`, `lin`, `coton`, `laine`, `marbre`, `pierre`, `blanc`, `noir` ; `materiaux` du monde en ajoute ou en
  remplace (`{"rose": "#ff66aa", "satin": {"color": "#7c2d12", "tex": "tissu", "finish": "velours"}}`).
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
- **Collisions** : `mondeInfo.conflicts = [{a, b, type}]` liste ce qui est à revoir ; la pose est faite quand même.
  Chaque pièce dessinée d'un modèle est une **boîte orientée**, et deux objets sont en conflit quand deux de leurs
  boîtes se pénètrent de plus de 1,2 cm (test des axes séparateurs, en 3D) : une chaise glissée sous une table ne la
  touche pas, une pile trop haute sous une tablette touche le plateau, un meuble qui traverse un mur est vu, deux
  objets longs côte à côte ne se gênent pas. Un contact (objet sur son appui, dos au mur) n'est pas un conflit.

  | `type` | Sens |
  | --- | --- |
  | `chevauchement` | Deux objets se pénètrent, ou un objet traverse un mur |
  | `degagement` | Objet dans le passage d'une porte (aussi profond que large) ou à moins de 15 cm devant une fenêtre, à sa hauteur |
  | `hors-espace` | Objet qui sort du contour de l'`espace` |
  | `hors-appui` | Objet plus grand que sa surface d'appui, ou ramené dans son contour |

  La recherche se fait d'office dès que le monde a un `espace` ou pose des objets (`on`, `against`, `stack`) ;
  `"collisions": true` la force, `false` la coupe, **`"montrer"`** la force et entoure de rouge à l'écran (3D) les
  boîtes des objets en conflit. Ne sont pas testés : sols, plafond, objets plats de moins de 3 cm (tapis), décor sans
  nom au-delà de 800 placements. Un modèle `gen` est mesuré par le rendu une fois généré (4 tranches horizontales de
  son maillage), puis testé comme les autres. Un modèle `"souple": true`
  (plante, coussin, rideau du catalogue) tolère 10 cm. `a` et `b` sont des noms d'instance, ou `modèle#rang` pour le
  décor sans nom. Un modèle de plus de 40 pièces est ramené à une seule boîte.
- Faces d'appui : `"surface": {"name": "top", "face": "+z", "from": "coin"}` sur une pièce en fait une face verticale
  (`at` = `[distance le long de la face, hauteur de la base]`, dos de l'objet contre la face) ; `"face": "-y"` un
  dessous où l'on suspend. `from` : `centre` (défaut), `origine` du modèle, ou `coin`. Les murs et le plafond d'un
  `espace` sont faits ainsi. `against: "<instance>"` = `on` avec la base au sol.
- `within: [[x, z], …]` limite un semis au sol à un polygone ; `shadow: false` retire l'ombre au sol d'une instance
  (automatique pour ce qui est posé sur un appui).
- Limites : échelle d'appui uniforme, inclinaison de l'appui ignorée. Format `monde` seulement (pas `monde2d`).

## Édition : ranger, glisser, aimanter

« Mets ce meuble ici » : à partir d'un point visé `[x, z]` (mètres), le monde range l'objet proprement.

1. **Appui selon la nature** (`pose` du prefab) : `mur` (cadre, applique, étagère murale) → le mur le plus proche, à
   la même hauteur ; `plafond` (suspension) → le plafond ; `dessus` (lampe, plante, coussin) → le dessus le plus haut
   sous le point (bureau, commode…), sinon le sol ; le reste au sol.
2. **Aimantation** : dos au mur quand l'objet en a un et en est à moins de 30 cm (plus sa profondeur), tourné vers la
   pièce ; bords alignés sur ceux des voisins au sol à moins de 8 cm (`aligne-x`, `aligne-z`) ; sinon grille de 5 cm.
3. **Collisions** : si la pose gêne (boîtes orientées, passage des portes, devant des fenêtres, hors de l'espace),
   l'objet glisse vers la place libre la plus proche (jusqu'à 1,5 m) : le long de son mur, puis au sol (meuble), ou
   sur les autres murs (objet mural). Sans place libre, la pose est faite telle quelle avec `valid: false`.

Ce qui est posé sur l'objet le suit. Les murs, sols, plafond et menuiseries de l'`espace` ne se déplacent pas. Un
objet sans nom posé sur un meuble nommé reçoit un nom, `<appui>-<modèle><n>` (`bureau-lampe1`), pour suivre son
appui et se déplacer lui-même (pas sur un mur : il y reste du décor).

- **Par les données** : `nodes.commode = {"move": [1.2, 3.0], "ease": {"ms": 300}}` ; avec `"ry": 1.57` (radians),
  l'objet garde ce cap et ne se colle dos à un mur que s'il lui tourne déjà le dos (à 45° près).
- **Au pointeur** : attribut `drag` de `sonic-3d` et de `sonic-2d` = regex des instances déplaçables (`".*"` :
  toutes). L'objet saisi suit le pointeur, rangé à chaque instant (arêtes rouges à jour avec `collisions:
  "montrer"`) ; en 3D l'orbite est suspendue pendant le geste. En 2D, vue de dessus et iso : tout le sol ; profil et
  face : l'axe horizontal de l'écran seulement. **Tourner** pendant le geste : R (quart de tour, Maj+R dans l'autre
  sens), Q / E ou la molette (15°). Au lâcher, `target` reçoit `{type: "place", payload}` et l'élément émet
  l'évènement `place`.
- **Sélection d'abord** (`drag-selected`, recommandé pour un éditeur) : sélection, déplacement et navigation
  deviennent trois gestes distincts. Un tap sur un objet le sélectionne (action `pick` avec `instance`, à recopier
  dans la clé `selection` du DataProvider) ; l'objet sélectionné est entouré de bleu ; seul lui se glisse, et
  seulement s'il est le premier sous le doigt ; un glisser partout ailleurs fait tourner (3D) la vue. `selection`
  vide : rien ne se déplace.
- **Cap gardé** (`keep-heading`) : l'objet glissé ne se tourne pas tout seul dos au mur ; il garde son cap (il ne se
  colle à un mur que s'il lui tourne déjà le dos, à 45° près) ; R, Q / E, la molette ou `$mondeTurn` le tournent.
- **Retour du geste** : l'objet saisi se soulève de 6 cm (son ombre se détache du sol), se repose au lâcher avec un
  petit rebond ; un fantôme rouge l'enveloppe tant qu'aucune place libre n'existe près du point visé. Rien à écrire.
- **Bulle de sélection** (slot `selection`, sonic-3d et sonic-2d) : un enfant `slot="selection"` est posé au-dessus de
  l'objet sélectionné et le suit à l'écran (pendant le glisser et quand la vue tourne) ; ses clics ne déplacent ni
  l'objet ni la vue. Typiquement : Tourner, Retirer, un `sonic-pop` de couleurs.
- **À hauteur d'yeux** (`camera="yeux"`, ou `view-provider` = un DataProvider `{camera: "yeux"}` pour passer d'une vue
  à l'autre sans remonter la scène) : on est dans la pièce, à `eye-height` (défaut 1,25 m) ; glisser = regarder
  autour, tap sur le sol = y aller (en glissant, à 30 cm des murs), molette ou flèches / Z Q S D = avancer, reculer,
  tourner. Sélection et glisser des objets marchent de la même façon. Revenir en `orbit` recadre toute la pièce.
- **Portes et fenêtres** : celles écrites dans `ouvertures` du monde (voir *Espace*) se sélectionnent et se glissent
  comme les objets, mais le long des murs : en 3D sur le mur visé par le pointeur (vu de l'intérieur), sur le plan
  sur le mur le plus proche ; pas de 5 cm, jamais à cheval sur un angle ni sur une autre ouverture. Au lâcher le
  `payload` porte `ouverture: {index, bord, at}` (et `place` vide) : `$mondePlace` le recopie dans
  `monde.ouvertures[index]`, le mur est alors redécoupé. Pendant le geste, le trou du mur reste à l'ancienne place.
- **Résultat** (clé de sortie `placed`, et `payload` de l'action `place`) :
  `{objectId, x, y, z, ry, valid, hits, snaps, place}` — position en mètres, cap en radians, `hits` = ce qui gêne
  encore, `snaps` parmi `mur`, `aligne-x`, `aligne-z`, `grille`, `deplace`, et **`place`** = l'entrée `place` à
  écrire dans le monde pour rendre la pose durable (unité du document : `at`/`rot`, ou `on` + `at` sur un appui).

Le rangement ne réécrit pas le monde : c'est au store de recopier la pose s'il veut la garder (sinon un nouveau
monde publié replace l'objet). Fonctions JSONata de `sonic-store` pour cela :

| Fonction | Rend |
| --- | --- |
| `$mondePlace($state.monde, $action.payload)` | Le monde où l'entrée de l'objet porte la pose (`on` / `against` / `at` / `rot` de `payload.place`). `payload` = `placed` ou le `payload` de l'action `place`. Un objet nommé d'office (`bureau-lampe1`) est retrouvé par `src` (rang de son entrée) et reçoit ce nom. Une entrée à plusieurs copies (`stack`, `grid`, `scatter`, `copies`) n'est pas modifiée |
| `$mondeAdd($state.monde, {"model": "lit", "params": {…}}, [x, z]?)` | Le monde avec l'objet ajouté (nommé `lit1`, `lit2`… sans `name`) à la place libre la plus proche du point visé (mètres ; centre de l'espace par défaut), avec l'appui de sa nature. Lit le monde complet (15 à 60 ms) : `budget-ms="200"` sur le store |
| `$mondeRemove($state.monde, "bureau", src?)` | Le monde sans l'objet ni ce qui est posé dessus (de proche en proche) |
| `$mondeParams($state.monde, "commode1", {"tiroirs": 5, "facade": "#e07a5f"}, src?)` | Le monde où les paramètres de prefab de l'objet sont changés (`null` : retour au défaut) |
| `$mondeTurn($state.monde, "commode1", 90?, src?)` | Le monde où l'objet a tourné sur place (quart de tour par défaut), rangé comme un glisser avec ce cap (lit le monde complet) |

```json
{ "tagName": "sonic-store", "attributes": { "id": "chambre", "budget-ms": "200", "history": "30",
  "reducer": "$action.type = \"place\" ? $merge([$state, {\"monde\": $mondePlace($state.monde, $action.payload)}]) : $action.type = \"add\" ? $merge([$state, {\"monde\": $mondeAdd($state.monde, $action.payload)}]) : $state" } }
```

avec `sonic-3d drag=".*" target="chambre"` : chaque lâcher envoie `place`, le monde est réécrit, la pose reste.

Un tap (`pick`) sur un objet déplaçable du monde ajoute au `payload` `instance` (son nom, même si le tap touche une
pièce `commode1_tiroir1`, et jamais un mur ou le sol) et `src` (rang de son entrée) : de quoi le sélectionner puis
l'éditer avec les fonctions ci-dessus. Un appui ne devient un glisser qu'au-delà de 4 px.

### Déplacements en jeu

`nodes.perso = {"x": 3, "z": 1.5, "collide": "glisser", "ease": {"ms": 400}}` : le trajet de la position actuelle
au point demandé est parcouru par pas de 10 cm contre les boîtes de la scène, et `x` / `z` sont ramenés au point
atteint avant d'être appliqués (même valeur pour le rendu et le pilote). `glisser` (ou `true`) longe l'obstacle (un
axe seul quand les deux sont bloqués) ; `bloquer` s'arrête au dernier point libre. Ne gênent pas : ce que l'objet
porte et ce qui le porte, sols, plafond, objets plats, portes et fenêtres (on passe par l'ouverture, le mur autour
arrête), et ce qu'il chevauchait déjà au départ. Un modèle `gen` pas encore mesuré compte pour une boîte de
50 × 100 × 50 cm.

Quand quelque chose gêne, la sortie publie `contact = {objectId, x, z, hits, blocked, t}` (`hits` : instances ou
modèles touchés, `t` : horodatage, qui change à chaque contact). Pour un jeu, le store écrit la position voulue à
chaque pas et lit `contact` pour réagir (son, rebond, ramasser un objet).

### Formes de collision, requêtes, capteurs

- `collider` sur un modèle remplace ses boîtes (une par pièce) : `"none"` (rien ne le touche), ou jusqu'à 8 formes
  posées au sol dans son repère, `{"box": [l, h, p]}`, `{"sphere": r}`, `{"capsule": [r, h]}` (`at` pour décaler).
  Elles valent pour les conflits, les trajets (`collide`), les émetteurs et les requêtes.
- `tags` sur un placement (`["ennemi"]`) : visées par les masques (émetteurs, requêtes), avec le nom de l'instance, le
  modèle, la famille et les étiquettes du prefab (`decor` pour le décor sans nom).
- `sensor: true` sur un placement nommé : zone qui détecte sans bloquer (ni conflit, ni obstacle). Quand une
  instance nommée y entre ou en sort, `target` reçoit `{type: "enter" | "leave", payload: {sensor, instance, tags}}`
  (événements DOM `monde-enter` / `monde-leave`). Un capteur tient la scène animée (`play` en 3D).
- Requêtes (clé `queries` du DataProvider) : `{"queries": {"vise": {"n": 4, "ray": {"from": [x, y, z], "dir": [dx, dy, dz], "max": 30}, "mask": ["ennemi"], "ignore": ["heros"]}}}`
  (ou `"sphere": {"at", "r"}`, `"box": {"lo", "hi"}`). Une réponse à chaque hausse de `n`, ou à chaque image avec
  `"live": true` (16 requêtes au plus) ; elle arrive dans la sortie `queries.<id>` = `{n, hit, instance, model, tags,
  x, y, z, normal, dist}` (rayon : premier objet touché ; un rayon descendant s'arrête au sol, `mask` peut viser
  `sol`) ; sphère et boîte ajoutent `all` (tout ce qui chevauche, 16 au plus). Sans `mask`, tout sauf les capteurs
  (`"sensor"` dans le masque pour les voir).

## Espace : pièce ou parcelle

La clé `espace` décrit un lieu par son contour : le sol, les murs percés de portes et de fenêtres, le plafond, ou une
parcelle avec ses clôtures et ses zones. Elle produit des instances nommées ordinaires, sur lesquelles tout se pose.

```json
{ "unite": "cm",
  "espace": {
    "contour": [[0, 0], [420, 0], [420, 310], [0, 310]], "hauteur": 250,
    "bords": [ { "couleur": "#f4f1ea" },
               { "bord": 1, "ouvertures": [ { "type": "fenetre", "at": 155, "largeur": 140, "hauteur": 125, "allege": 90 } ] },
               { "bord": 3, "couleur": "#2f5d62", "ouvertures": [ { "type": "porte", "at": 250 } ] } ],
    "zones": [ { "nom": "plancher", "revetement": "chevron" } ] },
  "place": [
    { "model": "lit", "name": "lit", "against": "mur2", "at": 70 },
    { "model": "etagere", "name": "e1", "on": "mur0", "at": [110, 120] },
    { "model": "suspension", "on": "plafond", "at": [210, 155] },
    { "model": "tapis", "on": "plancher", "at": [230, 150] } ] }
```

- **`contour`** : `[[x, z], …]` (3 à 60 points, sens quelconque, concave accepté). Le bord `i` va du point `i` au suivant.
- **`hauteur`** : hauteur des murs. Sans elle, pas de mur par défaut (parcelle).
- **`bords`** : une entrée sans `bord` vaut pour tous, une entrée `{"bord": i, …}` la complète pour ce bord.
  `type` : `mur` (défaut d'une pièce), `aucun`, ou une clôture procgen `haie`, `cloture`, `palissade`, `muret`,
  `pierre-seche`, `grille`, `bambou`. `hauteur`, `epaisseur`, `couleur` ou `matiere`, `tex`, `ouvertures`.
- **`ouvertures`** : `{type | model, at, largeur, hauteur, allege, params, name}`. `at` = distance du **coin gauche
  du mur vu de l'intérieur** au milieu de l'ouverture. Le mur est découpé autour ; la menuiserie est un prefab posé
  dans son épaisseur : `fenetre`, `porte`, `portail` de base (paramètres `largeur`, `hauteur`, `cadre`, `teinte`), ou
  un modèle du monde du même nom ou désigné par `model` (il reçoit `largeur` et `hauteur` s'il les déclare).
- **`images` du monde** : `{"affiche1": "data:image/jpeg;base64,…"}` (png, jpeg ou webp en URL `data:`, 12 au
  plus, 600 Ko chacune ; jamais d'URL réseau). Une pièce les affiche par `image: "affiche1"` sur sa face avant (+z), à sa
  taille. Prefab **`poster`** (pose au mur) : `params.image` (nom), `largeur`, `hauteur`, `baguette` (aucune, noire,
  bois, blanche), `fond`. En 2D, la pièce garde sa couleur.
- **`ouvertures` du monde** (à côté d'`espace`, pas dedans) : `[{type, bord, at, …}]`, les mêmes champs plus le rang
  du `bord`. Ce sont celles qu'on fait glisser d'un mur à l'autre ; utile aussi quand `espace` est calculé ailleurs
  (un `sonic-jsonata` qui l'écrit d'après un formulaire) et les ouvertures éditées par le réducteur. Leurs noms
  suivent l'ordre de la liste (`porte0`, `fenetre0`…) : ils ne changent pas quand une porte change de mur.
- **`zones`** : `{nom, contour, revetement, couleur, tex, layers}`. Sans `contour` la zone couvre tout l'espace.
  Revêtements : `parquet`, `chevron`, `moquette`, `carrelage`, `beton`, `lino`, `gazon`, `dalles`, `terrasse`,
  `gravier`, `paillis`, `terre`, `sable`, `eau`. `layers` sème des modèles dans le contour de la zone :
  `{model, cell, density, count, spacing, avoid, params}` (une copie par carré de côté `cell`, gardée selon `density`).
- **`plafond`** : `true` ou `{"couleur": …}` (vu de dessous seulement).
- **`murs`** : par défaut un mur n'a qu'une face, tournée vers la pièce : de dehors on voit à travers, la pièce se
  regarde de tous côtés comme une maquette. `"murs": "pleins"` donne des murs épais et opaques.

**Instances créées** : `mur0`, `mur1`… (une par bord en `mur`), `plafond`, une par zone (son `nom` ; `plancher` par
défaut), `fenetre0`, `porte0`, `portail0`… Elles se pilotent et se colorent comme les autres.

**Poser dans l'espace** (voir Pose) :

| Écriture | Effet |
| --- | --- |
| `"on": "mur0", "at": [x, h]` | Dos contre le mur, à `x` du coin gauche (vu de l'intérieur), base à la hauteur `h` |
| `"against": "mur0", "at": x` | La même chose avec la base au sol (lit, bureau, armoire) |
| `"on": "plafond", "at": [x, z]` | Suspendu : le haut de l'objet touche le plafond, en coordonnées de la pièce |
| `"on": "<zone>", "at": [x, z]` | Posé sur la zone, en coordonnées de la pièce |

Un modèle destiné à un mur a son dos en `z = 0` et s'étend vers `+z` ; un modèle suspendu a son point d'accroche en
`y = 0` et descend vers `-y`.

Textures de sol ajoutées au nuancier commun : `parquet`, `chevron`, `moquette`, `beton`, `gravier`, `dalles`, `paillis`.

Limites : pas de sous-pente, pas de soleil réglable, pas de contrôle des objets devant une ouverture ; une zone est
ramenée à son rectangle englobant pour la pose (un contour concave peut laisser un objet hors de la pièce).

## Catalogue de mobilier

Vingt prefabs sont disponibles par leur nom, sans les écrire dans `models` : un placement suffit.

```json
{ "unite": "cm",
  "espace": { "contour": [[0, 0], [440, 0], [440, 330], [0, 330]], "hauteur": 250, "zones": [ { "nom": "plancher", "revetement": "parquet" } ] },
  "place": [
    { "model": "lit", "name": "lit", "against": "mur2", "at": 85, "params": { "type": "mezzanine", "couette": "#e07a5f" } },
    { "model": "bureau", "name": "bureau", "against": "mur0", "at": 310, "params": { "largeur": 140, "caisson": true } },
    { "model": "lampe", "on": "bureau", "at": [-50, 0], "params": { "abat": "boule" } },
    { "model": "etagere", "on": "mur0", "at": [120, 125], "params": { "niveaux": 3, "largeur": 100 } },
    { "model": "rideau", "on": "mur1", "at": [165, 3], "params": { "largeur": 190, "hauteur": 235 } },
    { "model": "suspension", "on": "plafond", "at": [220, 165] },
    { "model": "tapis", "on": "plancher", "at": [240, 150], "params": { "forme": "rond", "largeur": 150 } },
    { "model": "coussin", "on": "lit" } ] }
```

| Modèle | Famille | Pose | Paramètres (premier choix ou valeur entre parenthèses = défaut ; longueurs en mètres, à écrire dans l'unité du document) |
| --- | --- | --- | --- |
| `lit` | lit | sol | type simple / mezzanine / superpose ; largeur 0.9 / 1.2 / 1.4 / 1.6 ; longueur 2 / 1.9 / 2.1 ; structure (matière, pin) ; drap (couleur) ; couette (couleur) ; tete oui |
| `bureau` | bureau | sol | largeur 0.8–2.4 m (1.2) ; profondeur 0.6 / 0.5 / 0.7 / 0.8 ; hauteur 0.5–1.1 m (0.74) ; plateau (matière, chene) ; pietement panneaux / metal / treteaux ; teinte (couleur) ; caisson non |
| `table` | table | sol | forme rectangle / ronde ; largeur 0.4–3 m (1.2) ; profondeur 0.4–1.6 m (0.8) ; hauteur 0.3–1.1 m (0.74) ; plateau (matière, chene) ; pieds (matière, metal-noir) |
| `etagere` | etagere | mur | pose mur / sol ; largeur 0.3–2.4 m (0.8) ; niveaux 3 / 1 / 2 / 4 / 5 / 6 ; ecart 0.2–0.5 m (0.32) ; profondeur 0.22 / 0.15 / 0.3 / 0.4 ; structure (matière, chene) ; fond non |
| `armoire` | rangement | sol | largeur 0.5–3 m (1) ; hauteur 1.2–2.6 m (2) ; profondeur 0.6 / 0.45 / 0.65 ; portes battantes / coulissantes ; structure (matière, bois-blanc) ; facade (couleur) |
| `commode` | rangement | sol | largeur 0.4–1.8 m (0.8) ; hauteur 0.4–1.3 m (0.8) ; profondeur 0.45 / 0.35 / 0.55 ; tiroirs 3 / 1 / 2 / 4 / 5 ; structure (matière, chene) ; facade (couleur) |
| `tapis` | tapis | sol | forme rectangle / rond ; largeur 0.5–4 m (1.6) ; longueur 0.5–4 m (1.1) ; teinte (couleur) ; motif uni / tricot / rayures / pois / damier / chevron / ecailles / hachures / carrelage / brique / nuages / camouflage / fourrure ; teinte2 (couleur du motif) ; echelle 1–24 (motifs par m) ; angle 0–165° |
| `coussin` | coussin | dessus | forme carre / rond ; taille 0.3–0.8 m (0.45) ; teinte (couleur) |
| `rideau` | rideau | mur | largeur 0.6–4 m (1.6) ; hauteur 1–3 m (2.2) ; ouverture 0.5 / 0 / 0.25 / 0.75 / 1 ; teinte (couleur) ; tringle (matière, metal-noir) |
| `lampadaire` | luminaire | sol | hauteur 1.1–1.9 m (1.5) ; abat cone / cylindre / boule ; teinte (couleur) ; structure (matière, laiton) ; allume oui |
| `lampe` | luminaire | dessus | hauteur 0.25–0.7 m (0.4) ; abat cone / cylindre / boule ; teinte (couleur) ; structure (matière, laiton) ; allume oui |
| `suspension` | luminaire | plafond | longueur 0.2–1.6 m (0.6) ; abat cone / cylindre / boule ; teinte (couleur) ; structure (matière, laiton) ; allume oui |
| `applique` | luminaire | mur | teinte (couleur) ; structure (matière, laiton) ; allume oui |
| `cadre` | decoration | mur | largeur 0.15–2 m (0.5) ; hauteur 0.15–2 m (0.4) ; cadre (couleur) ; image (couleur) ; miroir non |
| `poster` | decoration | mur | largeur 0.15–1.5 m (0.5) ; hauteur 0.15–1.5 m (0.7) ; image (nom dans `monde.images`) ; baguette aucune / noire / bois / blanche ; fond (couleur sans image) |
| `plante` | plante | sol | forme buisson / palmier / cactus ; taille 0.2–2.2 m (0.8) ; pot (couleur) ; feuillage (couleur) |
| `bac` | jardin | sol | largeur 0.4–3 m (1.2) ; profondeur 0.3–1.5 m (0.4) ; hauteur 0.2–0.9 m (0.4) ; structure (matière, pin) |
| `potager` | jardin | sol | largeur 0.6–3 m (1.2) ; longueur 0.6–4 m (1.2) ; rangs 4 / 2 / 3 / 5 / 6 ; structure (matière, pin) ; pousse (couleur) |
| `cabane` | jardin | sol | largeur 1.5–5 m (2.4) ; profondeur 1.5–4 m (2) ; hauteur 1.8–2.6 m (2) ; structure (matière, pin) ; toit (couleur) ; porte (couleur) |
| `barbecue` | jardin | sol | teinte (couleur) |
| `borne` | luminaire | sol | hauteur 0.3–1.2 m (0.6) ; teinte (couleur) ; structure (matière, metal-noir) ; allume oui |

- Les longueurs s'écrivent dans l'unité du document (`largeur: 140` en centimètres, `1.4` en mètres) ; les fiches de
  `mondeInfo.prefabs` (défaut, bornes, options) sont publiées dans cette unité.
- **Pose** : `sol` = base en y = 0 (dos en z = 0 pour ce qui va contre un mur : `against`) ; `mur` = dos en z = 0
  (`on: "mur0"`) ; `plafond` = accroche en y = 0 (`on: "plafond"`) ; `dessus` = à poser sur un meuble (`on: "bureau"`).
- **Appuis** : `lit` (matelas), `bureau`, `table`, `commode` et `bac` reçoivent des objets par `on` ; chaque planche d'une
  `etagere` est adressable (`on: "etagere1@planche2"`).
- **Matières** : nom du nuancier (`chene`, `pin`, `noyer`, `bois-blanc`, `acier`, `laiton`, `metal-noir`…) ou d'une
  matière de `materiaux`. **Couleurs** : `#rrggbb` ; elles ne coûtent rien (pas de variante).
- Un modèle écrit dans `models` sous le même nom remplace celui du catalogue. Seuls les modèles utilisés sont construits.
- **Assises et végétal** : ils viennent des générateurs procgen, pas du catalogue : `{"gen": "seat.chair"}`,
  `seat.armchair`, `seat.sofa`, `seat.pouf`, `seat.beanbag`, `seat.bench`, `seat.deckchair`… ; `{"gen": "tree"}`,
  `bush`, `flowers`. Un modèle `gen` se pose (`on`, `against`) mais ne sert pas d'appui.

**Écrire un prefab** : deux aides en plus des paramètres et des expressions. `vars` nomme des valeurs intermédiaires
(`{"H": "= type == 'mezzanine' ? 1.7 : 0.3"}`) ; `if` sur une pièce ou un `use` ne la garde que si l'expression est
vraie (`"if": "= type != 'simple'"`). `"unite": "m"` sur un modèle le déclare écrit en mètres quelle que soit l'unité
du document : ses paramètres marqués `"unit": "m"` sont alors convertis (c'est le cas de tout le catalogue).

## Émetteurs : projectiles et nuées

`emitters` fait naître, bouger et mourir des copies d'un modèle sans que le reducer les connaisse une par une. Même JSON
pour `sonic-3d` (instances : un appel de dessin par pièce, quel que soit le nombre de copies) et `sonic-2d` (silhouettes
partagées avec les instances). Le composant doit tourner (`play` en 3D).

```json
"emitters": {
  "blaster": { "model": "boule", "from": "heros", "offset": [0, 1.2, 0.6], "dir": [0, 0, 1], "spread": 3,
               "speed": [16, 18], "life": 2, "max": 64, "mask": ["rats", "mur", "sol"], "onHit": "die" },
  "rats": { "model": "rat", "max": 300, "params": { "taille": "= rand(0.7, 1.4)" },
            "spawn": { "count": 300, "area": [-12, 2, 12, 12] }, "mask": ["mur"],
            "flock": { "seek": "heros", "speed": [1.2, 2.6], "separation": 0.45 }, "publish": 3 }
}
```

| Clé | Rôle |
|---|---|
| `model`, `params` | Modèle du monde (ou prefab du catalogue) ; paramètres tirés par copie (`= rand(…)`, 8 variantes au plus) |
| `max` | Copies vivantes au plus (2 000 par émetteur, 6 000 en tout) ; pool plein : la plus ancienne est recyclée |
| `from`, `offset`, `at` | Source : instance nommée (le tir part d'elle et suit son cap, `offset` dans son repère), sinon le point `at` |
| `dir`, `spread`, `speed` | Direction (repère de la source), écart en degrés, vitesse `[min, max]` |
| `gravity`, `drag`, `life` | Gravité (m/s²), frottement, durée de vie en s (`0` : immortelle) |
| `rate` | Naissances par seconde en continu (0 : seulement sur ordre) |
| `mask`, `radius` | Ce qui est touché : nom d'instance, modèle, famille, étiquette de prefab, `decor`, `sol`, ou **nom d'un autre émetteur** (ses copies) ; rayon de contact |
| `onHit`, `bounce`, `kills` | `die` (défaut), `bounce` (restitution `bounce`), `stick`, `pierce` ; `kills: false` : une copie touchée d'un autre émetteur n'est pas retirée |
| `push` | Impulsion (N·s) donnée au corps physique touché, dans la direction du tir (voir Physique 3D) |
| `flock` | Nuée au sol : `seek` / `flee` (instance, `fleeRadius`), `speed`, `separation`, `cohesion`, `align`, `radius` (voisinage), `wander`, `avoid` (étiquettes contournées, sinon `mask`), `bounds` `[x0, z0, x1, z1]` |
| `spawn` | Semis initial `{count, area: [x0, z0, x1, z1]}` |
| `scale` | Taille `[min, max]` par copie |
| `events`, `publish`, `seed` | `["expire"]` : événement de fin de vie ; `publish: N` : les N copies les plus proches de la cible publiées ; graine |

Longueurs dans l'unité du document (`unite`). Les copies sont simulées à pas fixe (1/60 s), dans des tableaux typés,
hors DataProvider ; un monde relu dont l'émetteur n'a pas changé garde ses copies en vol.

**Ordres** (clé `emit` du DataProvider lu) : `{"emit": {"blaster": {"n": 12, "count": 3, "toward": "boss"}}}`. Chaque
hausse de `n` tire une salve de `count` copies (`at`, `dir`, `toward` : instance ou point visé) ; `clear` (compteur)
vide le pool ; `kill: {"n": 4, "ids": [17]}` retire des copies. La première lecture ne fait que mémoriser les compteurs.

**Retours** : `target` reçoit `{type: "hit", payload: {hits: [{emitter, id, target, copy?, tags, x, y, z}], t}}`, une fois
par image, toutes les touches regroupées (`copy` : identifiant de la copie touchée d'un autre émetteur) ; `{type: "expire",
payload: {emitter, count}}` avec `events: ["expire"]`. La sortie (`out-data-provider`) publie `hits` (dernières touches)
et `emitters` (`{<id>: {alive, emitted, dropped, expired, ms, near?}}`, 10 fois par seconde au plus) ; l'événement DOM
`monde-hit` porte les mêmes touches. Les copies n'apparaissent jamais dans `nodes`.

`trail` (système de particules semé par chaque copie) et `burst` (salve au point d'impact) relient un émetteur aux par## Particules : feu, fumée, étincelles, pluie

`particles` projette de la matière, de la fumée ou de la lumière : purement visuel (ni contact ni événement), un appel
de dessin par système en 3D (mouvement calculé par le GPU) et un dessin par système en 2D. `vent` (`[x, y, z]`, m/s)
pousse les systèmes qui y sont sensibles (`wind`).

```json
"vent": [0.8, 0, 0],
"particles": {
  "torche": { "preset": "feu", "from": "heros", "offset": [0.5, 1.6, 0] },
  "cheminee": { "preset": "fumee", "at": [-4, 2, 8] },
  "boum": { "preset": "etincelles", "burst": 60, "then": "nuage", "light": { "color": "#ff9a3c", "intensity": [6, 0], "radius": 8 } },
  "nuage": { "preset": "fumee", "rate": 0, "burst": 40, "size": [0.6, 2.5] }
}
```

Préréglages (un jeu de valeurs par défaut, toute clé écrite le remplace) : feu, lumière (`feu`, `etincelles`, `braise`,
`lueur`, `eclair`, `magie`), gaz (`fumee`, `vapeur`, `brume`, `poussiere`), liquide (`eclaboussure`, `gouttes`,
`bulles`, `pluie`), solide (`debris`, `eclats`, `feuilles`, `neige`, `confettis`).

| Clé | Rôle |
|---|---|
| `from`, `offset`, `at` | Source : instance suivie (le système la suit, `offset` dans son repère), sinon point |
| `shape`, `extent` | Forme de naissance : `point`, `sphere`, `box`, `ring` ; rayon ou demi-côtés |
| `dir`, `spread`, `speed` | Direction, écart (degrés), vitesse `[min, max]` |
| `rate`, `burst`, `life`, `max` | Naissances par seconde, grains d'une salve, durée de vie `[min, max]`, grains au plus (4 000 par système, 16 000 en tout) |
| `gravity`, `rise`, `drag`, `turbulence`, `wind` | Chute, poussée vers le haut, frottement, remous, sensibilité au vent |
| `size`, `color`, `opacity` | Taille `[début, fin]` (m), rampe de 1 à 4 couleurs, opacité `[début, fin]` |
| `blend`, `sprite`, `stretch`, `spin` | `add` (feu, lumière) ou `normal` ; grain `disque`, `flocon`, `goutte`, `eclat`, `trait`, `volute` ; étirement selon la vitesse ; rotation |
| `floor` | Ne descend pas sous le sol (y = 0) |
| `light` | `{color, intensity: [début, fin], radius}` : lumière qui suit le système (4 au plus, 3D) |
| `then` | Système lancé à la fin d'une salve (étincelles puis fumée) |

**Salves** (clé `fx` du DataProvider) : `{"fx": {"boum": {"n": 3, "at": [3, 0, 2], "scale": 1.5, "color": "#66ccff"}}}`,
une salve à chaque hausse de `n` (`count` : nombre de grains). Un système à `rate` > 0 émet en continu à sa source.
La scène doit tourner (`play` en 3D). En style `toon`, les grains ont un bord net.

ticules. Pas encore : les modèles `gen` (procgen) émis, le tap sur une copie.

## Monde infini

`infini` découpe le sol en tuiles carrées, générées à la demande autour d'une instance (`follow`) et relâchées
derrière elle : un monde sans bord, le même à chaque passage (graine). Les instances nommées de `place` restent
globales ; seuls les calques sont infinis.

```json
"brume": 0.25,
"infini": {
  "seed": "vallee", "tile": 24, "radius": 3, "follow": "heros",
  "ground": { "relief": "= 1.5 * noise(x / 40, z / 40)", "color": "#7fae5a" },
  "biomes": { "field": "= noise(x / 60, z / 60)", "list": [ { "to": -0.1, "name": "prairie", "color": "#9cc46a" }, { "to": 1, "name": "foret", "color": "#4f7f3f" } ] },
  "layers": [
    { "model": "sapin", "cell": 3.5, "density": "= biome == 'foret' ? 0.75 : 0.04" },
    { "models": ["rocher", "souche"], "cell": 9, "density": 0.25, "scale": [0.6, 1.4] }
  ]
}
```

| Clé | Rôle |
|---|---|
| `tile`, `radius` | Côté d'une tuile (unité du document), rayon de chargement en tuiles (6 au plus) |
| `follow`, `center` | Instance autour de laquelle charger ; à défaut, point `[x, z]` |
| `axes` | `xz` (défaut) ou `x` : une seule rangée de tuiles (défilement horizontal en 2D) |
| `ground` | `relief` (expression de la hauteur en mètres, `x` et `z` en mètres, `noise` de -1 à 1), `color` |
| `biomes` | `field` (expression de -1 à 1) et `list` de biomes par seuil croissant `to`, avec `name` et `color` de sol |
| `layers` | Peuplement : `model` ou `models` (tirés au hasard), `cell` (une copie au plus par cellule, écart garanti), `density` (0 à 1, nombre ou expression avec `x`, `z`, `h`, `biome`), `jitter`, `scale`, `turn`, `biomes` |
| `perTile` | Copies au plus par tuile (600 au plus, 300 par défaut) |

Les champs sont calculés en coordonnées du monde : deux tuiles voisines se raccordent sans couture. Un modèle de
calque peut être un modèle du monde ou un prefab du catalogue (pas un modèle `gen`). En 3D, un appel de dessin par
pièce de modèle quel que soit le nombre de tuiles ; `brume` (vers 20 / (radius × tile)) cache l'apparition des
tuiles. En 2D, le sol est teinté par biome, les objets sont des silhouettes rangées en profondeur.

**Retouches** (clé `tiles` du DataProvider) : `{"tiles": {"3,-2": {"remove": ["t.3.-2.0.12"], "add": [{"model": "feu", "x": 80, "z": -40}]}}}`,
appliquées après la génération de la tuile (identifiants stables `t.<cx>.<cz>.<calque>.<rang>`). **Retours** : sortie
`infini = {center, loaded, pending, ms}` ; `target` reçoit `{type: "tileEnter", payload: {cx, cz, biome}}` quand
l'instance suivie change de tuile.

**Collisions** : les copies des tuiles proches (à une tuile au plus du centre) comptent comme décor pour les requêtes
et capteurs (`instance` = identifiant de la copie, étiquette `infini`), pour les émetteurs (`mask` avec le nom du
modèle, ou `infini` ; contournement des nuées) et pour la physique (obstacles fixes, chocs nommés par l'identifiant).
Le relief porte les nuées posées au sol, arrête les projectiles et, avec `physique`, devient un champ de hauteurs
(le sol plat infini est alors retiré). Une copie touchée se retire par `tiles.<clé>.remove`. Pas encore : recentrage
de l'origine au-delà de quelques kilomètres.

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

### Finis et accessoires des modèles `gen`

Un modèle `gen` reçoit les mêmes matières que les pièces écrites :

- **`finish` par rôle** : `{"maillot": "velours", "cuir": "cuir", "metal": "chrome"}` (rôles du format ou de procgen),
  ou un seul nom de fini pour tous les habits (`"finish": "laque"`). Rugosité, métal, reflet de tissu et vernis
  s'appliquent dans le rendu procgen (style compris : un reflet franc en `toon`), ainsi que les finis texturés
  (`relief`, `profondeur`, `usure`, `occlusion`, motif par défaut du rôle : tissu, grain du cuir…) ; verre et eau
  y sont un reflet de Fresnel opaque ; l'opacité n'y a pas d'équivalent.
- **Accessoires** : `parts` d'un modèle gen ajoute des pièces portées par un os (`parent` : `tete`, `torse`, `bassin`,
  `main` avec `mirror: "x"`, `pied`…), à `at` / `rot` de la tête de l'os. Forme, `tex`, `finish`, `souple`
  (cape, jupe, écharpe : repoussées par le corps), `cheveux` (sur une pièce `hidden: true` posée sur la tête, la
  coiffure procgen à `"hair": "none"`). Elles suivent la pose et l'animation du personnage. 3D seulement.

```json
"chevalier": { "gen": "character", "params": { "hair": "none", "bag": "none" },
  "finish": { "maillot": "velours", "metal": "chrome" },
  "parts": [
    { "name": "cape", "parent": "torse", "box": [0.5, 0.85, 0.02], "at": [0, 0.05, -0.16], "color": "#a61e4d", "souple": { "type": "tissu", "rigidite": 0.3 } },
    { "name": "crane", "parent": "tete", "sphere": 0.105, "at": [0, 0.11, 0], "hidden": true, "cheveux": { "coupe": "longs", "couleur": "#3b2414" } },
    { "name": "couronne", "parent": "tete", "cylinder": [0.09, 0.06], "at": [0, 0.21, 0], "color": "#e8b923", "finish": "metal" }
  ] }
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

**Texture adaptative** (3D) : une texture commence à 128 px de côté puis est recalculée plus finement (256, 512,
jusqu'à 1024 avec `detail: "high"`) quand une pièce qui la porte est vue de près, pour garder au moins un texel par
pixel. Le calcul se fait par tranches hors du rendu ; une texture affinée le reste. Filtrage anisotrope pour les sols
vus en biais. Rien à écrire : c'est automatique.

## Finis : métal, verre, vernis, tissu

`finish` sur une pièce (ou dans une matière de `materiaux`) donne une matière physique : un nom de fini prêt, ou un
objet qui part d'un fini et en change des valeurs.

```json
{ "name": "abat-jour", "cone": [0.2, 0.25], "color": "#f3ead7", "finish": { "fini": "verre", "rough": 0.4, "opacity": 0.9 } }
```

Finis prêts : `mat`, `satine`, `brillant`, `laque`, `plastique`, `ceramique`, `metal`, `brosse`, `chrome`, `miroir`,
`verre`, `depoli`, `eau`, `tissu`, `velours`, `cuir`, `caoutchouc`, `bois`, `pierre`, `cire`, `pave`, `brique`,
`ecorce`, `rouille`.

| Valeur | Effet (0 à 1) |
|---|---|
| `rough` | Rugosité : 0 miroir, 1 mat (sans fini : celle du `look`) |
| `metal` | Métal : reflète l'environnement, teinte ses reflets |
| `clear` | Vernis transparent par-dessus (laque, céramique, carrosserie) |
| `sheen` | Reflet rasant du tissu (velours, laine) |
| `glass`, `ior` | Verre : la lumière traverse (`ior` de 1 à 2,5, 1,5 pour le verre, 1,33 pour l'eau) ; la couleur teinte ce qui est vu à travers |
| `opacity` | Opacité (verre fumé, voilage) |
| `relief` | Relief éclairé tiré de la texture (`tex`) : carte de normales (bois, cuir, pierre, tissu) |
| `profondeur` | Parallaxe : les creux de la texture (joints, sillons) semblent creusés quand on tourne autour (pavés, briques, écorce) |
| `usure` | Bosses polies, creux mats (variation de rugosité) |
| `occlusion` | Creux de la texture assombris |

Ces cartes viennent toutes de la texture procédurale de la pièce (sa seconde couleur marque les creux) : sans `tex`,
`relief`, `profondeur`, `usure` et `occlusion` n'ont pas d'effet. Pour les recoins et les contacts entre objets,
voir `occlusion` dans l'étalonnage.

Les matières de base portent leur fini : `chrome`, `or`, `cuivre`, `aluminium`, `acier` (brossé), `laiton`,
`metal-noir`, `verre`, `verre-depoli`, `verre-fume`, `plastique`, `plastique-brillant`, `laque`, `ceramique`, `cuir`,
`velours`, `caoutchouc`, bois, tissus, `marbre`, `pierre`. Les vitres des fenêtres sont en verre, un `cadre` en
`miroir: true` reflète.

`environnement` (monde) donne les reflets : `studio` (pièce lumineuse), `exterieur` (le ciel du monde, horizon clair,
sol sombre, soleil) ou `aucun` ; par défaut `studio` dès qu'une pièce a un fini qui reflète (métal, verre, vernis).
Calculé une fois par rendu, sans image à charger.

En style `toon`, seuls l'opacité et la transparence du verre comptent. En 2D, le verre et l'opacité rendent la
silhouette transparente ; le métal, le vernis et le verre ont un reflet franc ; un fini mat n'en a pas.

## Tissus souples et chevelures (3D)

Une pièce peut devenir **souple** : `souple` en fait un tissu (cape, drapeau, rideau, banderole), une jupe (tube
ouvert : jupe, robe, manche, manche à air) ou une chaîne
(queue, écharpe, ruban, corde, oreille tombante) simulés à chaque image. Elle reste attachée par un bord à la pièce qui
la porte, suit les mouvements de l'instance, retombe, ondule au `vent` du monde (une brise sans vent) et ne traverse
pas les autres pièces du modèle (approchées par des sphères) ni le sol.

```json
{ "name": "cape", "box": [0.6, 0.95, 0.02], "at": [0, 0.95, -0.3], "color": "#c0392b", "souple": { "type": "tissu", "rigidite": 0.3 } },
{ "name": "drapeau", "box": [1.2, 0.7, 0.01], "at": [0.62, 2.6, 0], "souple": { "type": "tissu", "attache": "gauche", "vent": 1.5 } },
{ "name": "queue", "box": [0.04, 0.5, 0.04], "at": [0, 0.6, -0.4], "souple": "chaine" },
{ "name": "jupe", "cylinder": [0.3, 0.5], "at": [0, 0.35, 0], "souple": { "type": "jupe", "rigidite": 0.4 } }
```

| Clé de `souple` | Rôle |
|---|---|
| `type` | `tissu` (grille sur les deux grandes dimensions de la pièce), `jupe` (anneaux autour de l'axe d'attache, rayons = demi-côtés de la pièce) ou `chaine` (le long de la plus grande) |
| `attache` | Bord ou bout tenu : `haut` (défaut), `bas`, `gauche`, `droite`, `avant`, `arriere` |
| `rigidite` | 0 soie, 1 cuir épais (0,5) |
| `poids`, `amorti`, `vent` | Gravité (1), freinage (0,08), prise au vent (1) |
| `collision`, `segments` | `false` : traverse le corps ; finesse (8 tissu, 10 chaîne) |
| `evasement` | Jupe : rayon du bord libre / rayon du bord attaché (1 : tube droit ; 1,6 : évasée ; 0,5 : manche à air) |
| `cintrage`, `plis` | Tissu : bords latéraux avancés de `cintrage` m (cape qui épouse le dos) ; plis en accordéon de `plis` m (rideau froncé) |

**Chevelures** : `cheveux` sur une pièce (la tête, souvent une sphère) y plante des mèches simulées, dessinées en un
seul maillage de rubans : elles tombent, suivent la tête, ondulent au vent et restent hors du crâne.

```json
{ "name": "tete", "sphere": 0.2, "at": [0, 1.55, 0], "role": "peau", "cheveux": { "coupe": "longs", "couleur": "#5a3520", "nombre": 120 } }
```

| Clé de `cheveux` | Rôle |
|---|---|
| `coupe` | `longs`, `courts`, `frange`, `queue` (touffe à l'arrière), `herisses` |
| `nombre`, `longueur`, `variation` | Mèches (90), longueur (m), écart de longueur (0 à 1) |
| `epaisseur`, `ondulation`, `raideur` | Largeur d'une mèche (m), ondulation (0 à 1), tenue près de la racine (0 à 1) |
| `couleur`, `vent` | Couleur (défaut : celle de la pièce, assombrie) ; prise au vent |

En 2D, une pièce souple est dessinée rigide et les chevelures ne sont pas dessinées. Sur un personnage `gen`, voir
« Finis et accessoires des modèles gen ».

## Herbes et champs (3D)

`herbes` sème des brins instanciés (un appel de dessin par champ) : le vent (`vent` du monde, sinon une brise) les
fait onduler par rafales, et ils se couchent au passage des instances nommées. Le sol reste libre sous le décor posé
(maisons, murs, meubles).

```json
"herbes": [
  { "type": "ble", "zone": [-8, -2, 8, 8] },
  { "type": "herbe", "zone": [[-12, -10], [12, -10], [0, -2]], "hauteur": [0.4, 0.9] },
  { "type": "fleurs", "zone": [-12, 8, 12, 12], "fleurs": ["#f2d64b", "#e86a6a"] }
]
```

| Clé | Rôle |
|---|---|
| `type` | `herbe`, `ble` (épis), `roseau` (massettes), `fleurs` (corolles), `gazon` (ras et dense) |
| `zone` | Rectangle `[x0, z0, x1, z1]` ou polygone `[[x, z], …]` (mètres) |
| `densite` | Brins par m² (herbe 220, blé 260, gazon 600) |
| `hauteur` | `[mini, maxi]` (m) ou une valeur |
| `pied`, `pointe` | Couleurs au pied et à la pointe (dégradé) |
| `fleurs` | Couleurs des corolles (`fleurs`) |
| `largeur`, `souplesse` | Largeur d'un brin (m) ; réaction au vent (0 à 2) |
| `plie`, `degage` | `false` : ne se couche pas ; pousse aussi sous le décor |

Budget de brins pour tout le monde selon `detail` : 20 000 (`low`), 60 000 (`mid`), 160 000 (`high`) ; au-delà, la
densité de chaque champ baisse au prorata. Pas d'herbes en 2D ni dans le monde `infini` (utiliser un calque).
Les mêmes champs (semis, brins, vent, ploiement : `shared/monde/herbes.ts`) existent dans `sonic-procgen`, clé de
recette `meadows` (voir `procgen/procgen.md`, Prairies) ; `height`, `flowers`, `seed` y sont aussi acceptés ici.

## Ambiances : direction artistique

`"ambiance": "cartoon"` donne d'un mot un univers complet : rendu (`look`, fini par défaut, reflets), ciel et brume,
palette des rôles, style des modèles `gen`, lumière et étalonnage de l'image. Tout ce que le monde écrit lui-même
(`ciel`, `look`, `palette`, `style`…) l'emporte ; `lumiere` et `etalonnage` complètent ceux de l'ambiance valeur par
valeur. `{"base": "noir", "etalonnage": {"grain": 0.3}}` part d'une ambiance et en change des valeurs.

| Ambiance | Pour |
|---|---|
| `realiste` | Rendu physique sobre, ciel clair, légère brume |
| `militaire` | Jeu de tir réaliste : couleurs désaturées kaki et sable, contraste, grain, vignette |
| `cartoon` | Couleurs vives, aplats, contours noirs, ciel bleu (course de karts, plateformes) |
| `jouet` | Plastique brillant, studio lumineux (jouets, figurines) |
| `cyber` | Nuit néon : arêtes lumineuses cyan, halo, aberration, lignes de balayage |
| `alien` | Monde extraterrestre bioluminescent, brume violette, halo |
| `silhouette` | Aplats noirs sur ciel lumineux, grain et vignette (plateformes en ombres chinoises) |
| `noir` | Film noir : noir et blanc contrasté, lumière rasante, grain |
| `voxel` | Monde en pixels nets, couleurs franches, aplats (associer à une caméra iso ou de côté) |
| `retro` | Console des années 90 : gros pixels, niveaux, lignes |
| `horreur` | Désaturé verdâtre, brume, vignette lourde, grain |
| `western` | Sépia chaud, soleil bas |
| `pastel`, `onirique` | Doux et clair ; rêveur avec halo et brume colorée |
| `tableau` | Peinture : touches de pinceau qui suivent les formes, léger tramage, couleurs chaudes |

Alias acceptés : `fps`, `cyberpunk`, `neon`, `extraterrestre`, `contre-jour`, `polar`, `pixel`, `far-west`, `reve`…
Une ambiance s'inspire d'un genre : elle ne reprend ni les personnages ni les éléments d'une œuvre.

**`lumiere`** : `{intensite (soleil), couleur, hauteur (°), azimut (°), ambiante, couleurAmbiante}` (lumières par défaut de
`sonic-3d`).

**`etalonnage`** (3D ; en 2D : couleurs, silhouettes et grain seulement) :

| Clé | Effet |
|---|---|
| `saturation`, `contraste`, `luminosite` | 1 = neutre |
| `teinte` | Couleur multipliée (`"#e6e0c8"`) |
| `noirEtBlanc`, `sepia` | 0 à 1 |
| `grain`, `vignette` | 0 à 1 |
| `pixel`, `niveaux` | Taille des pixels (px) ; niveaux par couleur (postérisation) |
| `silhouette` | Objets en aplat sombre, fondus vers le ciel au loin (avec `brume`) |
| `contours`, `couleurContours` | Traits aux ruptures de profondeur (0 à 1) |
| `halo`, `seuilHalo` | Lueur autour des zones claires (fenêtres, néons, `glow`) |
| `aberration`, `lignes` | Franges colorées vers les bords ; lignes de balayage |
| `occlusion` | Occlusion à l'écran (0 à 1) : coins, pieds des murs et contacts entre objets assombris (réglée par chaque ambiance) |
| `peinture` | Touches de pinceau qui suivent les contours (filtre de Kuwahara anisotrope), rayon en px (4 à 6 : touches moyennes) |
| `tramage` | Tramage ordonné avant la peinture (0 à 1, `true` = 0,6), sur `niveaux` niveaux (6 par défaut) |

Un post-traitement écrit (`post`) passe avant : l'étalonnage est alors ignoré.

## Physique 3D (corps rigides)

`"physique": true` (ou `{…}`) active un moteur physique 3D (Rapier, chargé à la demande) commun à `sonic-3d` et
`sonic-2d` (la 2D montre la même simulation en projection). Un placement **nommé** avec `corps` devient un corps
rigide ; le décor sans nom (murs, sols, meubles, `espace`) et les instances nommées sans `corps` sont des obstacles
(celles-ci suivent leur position : un personnage piloté par `nodes` pousse les caisses).

```json
{
  "physique": { "gravite": [0, -9.81, 0], "liaisons": [{ "type": "corde", "a": "pendule", "at": [-3, 4.5, 2], "longueur": 3 }] },
  "place": [
    { "model": "caisse", "name": "c1", "at": [0, 2, 0], "corps": "dynamique" },
    { "model": "boulet", "name": "boulet", "at": [0, 0, -4], "corps": { "type": "dynamique", "masse": 8, "rebond": 0.2, "ccd": true } },
    { "model": "perso", "name": "joueur", "corps": { "type": "dynamique", "bloqueRotation": ["x", "z"] } }
  ]
}
```

**`physique`** : `gravite` ([0, -9.81, 0]), `sol` (sol infini à y = 0, défaut `true`), `contactMin` (impulsion minimale
d'un choc signalé, N·s, 0,5), `frequence` (pas par seconde, 60), `pause` (corps endormis jusqu'au premier ordre ou
choc), `liaisons`.

**`corps`** : `"dynamique"` | `"statique"` | `"cinematique"` (suit sa position, pousse sans être poussé) ou un objet :

| Clé | Rôle |
|---|---|
| `type` | `dynamique` (défaut), `statique`, `cinematique` |
| `masse` | kg (sinon volume × `densite`, 500 kg/m³) |
| `friction`, `rebond` | 0,6 ; 0,1 (0 à 1) |
| `amorti`, `amortiRotation` | Freinage dans l'air et en rotation |
| `gravite` | Échelle de gravité (0 : flotte, -1 : monte) |
| `ccd` | Détection continue (projectile rapide qui ne doit pas traverser) |
| `bloqueRotation`, `bloquePosition` | Axes bloqués : `["x", "z"]` garde un personnage debout ; `["z"]` = jeu en tranche |
| `forme` | `auto` (pièces : boîtes, sphères, cylindres, capsules ; ou le `collider` du modèle), `boite`, `sphere`, `capsule` (englobantes) |
| `vitesse` | Vitesse de départ [vx, vy, vz] (m/s) |
| `sommeil` | `false` : ne s'endort jamais |

**Liaisons** (`physique.liaisons`, 200 au plus) : `{type, a, b, at, axe, butees, moteur, longueur, raideur, amorti,
choc}` ; `b` absent = accroché au monde au point `at` (repère du monde, défaut : position de `a`).

| `type` | Effet |
|---|---|
| `charniere` | Porte, roue, levier : rotation autour de `axe`, `butees` en degrés, `moteur: {vitesse (°/s), force}` |
| `rotule` | Pendule, chaîne |
| `fixe` | Soude deux corps |
| `glissiere` | Tiroir, piston : translation le long de `axe`, `butees` en mètres |
| `ressort` | `longueur` au repos (défaut : distance de départ), `raideur`, `amorti` |
| `corde` | Distance au plus `longueur` |

**Piloter** : clé DP `forces` du `dataProvider` (même vocabulaire que `sonic-physics` en 2D) :

```json
{ "joueur": { "vx": 2 }, "fusee": { "fy": 300, "torque": [0, 5, 0] },
  "boulet": { "set": { "n": 1, "x": 0, "y": 0.3, "z": -4 }, "impulse": { "n": 1, "toward": [0, 1, 4], "power": 120 } } }
```

- `vx` `vy` `vz` : vitesse imposée à chaque pas (axes donnés seulement) ; `fx` `fy` `fz` : force continue (N) ;
  `torque` [x, y, z] ; `spin` [x, y, z] (°/s) ; `wake: true` réveille.
- `impulse: {n, x, y, z}` ou `{n, toward: [x, y, z], power}` (N·s), `at` : point d'application (fait tourner) ;
  `set: {n, x, y, z, rx, ry, rz (°), vx, vy, vz}` replace le corps. Compteurs : chaque hausse de `n` agit une fois
  (la première lecture de la clé ne fait que mémoriser) ; dans un même ordre, `set` passe avant `impulse`.
- Un émetteur avec `push` pousse les corps que ses projectiles touchent.
- Glisser un corps dynamique (édition) : il suit le pointeur puis retombe.

**Sorties** : `physique` = `{time, count, awake, bodies: {nom: {x, y, z, rx, ry, rz (°), vx, vy, vz, awake}}}` (10 fois
par seconde tant que ça bouge) ; vers `target` : `contact` `{a, b, tagsA, tagsB, impulse, x, y, z}` au début d'un
choc (`b` vide = décor ou sol), `rest` `{bodies}` quand tous les corps dynamiques se sont immobilisés.

Limites : corps sur les placements nommés (400 au plus) ; avec le monde `infini`, relief et peuplement ne comptent
qu'à une tuile au plus du centre ;
un changement du monde reconstruit la simulation à partir des positions courantes (vitesses remises à zéro).

## Rendu photo (lancer de rayons)

`"photo": true` (ou `{"echantillons": 200, "rebonds": 5, "attente": 600}`) : quand la vue et la scène ne bougent plus
depuis `attente` ms, l'image est recalculée en lancer de rayons progressif. Reflets entre objets, ombres douces,
lumière indirecte, verre qui réfracte : physiquement justes, l'image s'affine pendant quelques secondes (bruit au
début) jusqu'à `echantillons`. Tout mouvement (orbite, glisser, animation, changement du monde) rend la main au rendu
temps réel ; le calcul reprend à la pause suivante. La copie de la scène pour le traceur (et sa structure d'accélération) est gardée tant que seul le point de vue change : seule la première pause après une modification du monde la reconstruit. Le moteur (environ 450 Ko) n'est chargé que si un monde le demande.

- **Filtre** (`filtre`) pour une image utilisable en peu d'échantillons :
  - `"peinture"` : 6 échantillons, 2 rebonds, calcul en demi-résolution, puis filtre de Kuwahara anisotrope (une seule fois, sur l'image finale, à la résolution de calcul ; l'écran l'agrandit) : le
    bruit devient des touches de pinceau qui suivent les contours (image en une seconde environ). `tramage` (0 à 1,
    `true` = 0,6) ajoute avant le filtre un tramage ordonné sur `niveaux` niveaux (6) : touches plus texturées ;
    `touche` règle le rayon des touches (px de calcul, 5 : plus larges à l'écran quand la résolution est réduite).
  - `"lisse"` : 32 échantillons et un débruitage qui garde les arêtes ; plus propre, moins net qu'un calcul complet.
  - `echelle` (0,25 à 1) : résolution de calcul. C'est un plafond : sur téléphone ou tablette, les pixels tracés sont limités (environ 0,35 Mpx, contre 1,6 Mpx sur ordinateur) et le calcul est découpé en tuiles, pour que le GPU ne coupe pas le contexte. Si le GPU ne suit pas (aucun échantillon au bout de 30 s, contexte perdu), `photo.etat` passe à `indisponible` avec la `raison`.
- La sortie `photo` donne l'avancement : `{etat: "attente" | "calcul" | "fini" | "indisponible", echantillons, total, raison}`.
- L'éclairage vient des lumières de la scène et de l'`environnement` (`aucun` : ciel blanc uniforme).
- Particules, contours, brume et style `toon` n'ont pas d'équivalent physique : `photo` est ignoré en `toon`, les
  particules et traits disparaissent de l'image calculée.
- Coûteux en GPU : à réserver aux vues qu'on contemple (pièce aménagée, objet présenté, nuancier), avec un
  bouton qui active `photo` plutôt qu'en permanence sur mobile. Au-delà de 2,5 millions de triangles, `indisponible`.

## Performance

Géométries et matières partagées entre instances ; décor instancié (3D) ou dessiné une fois (2D) ; en 2D, une
silhouette n'est recalculée que lorsqu'une pièce tourne assez pour changer de profil, et ses dessins sont partagés
entre instances d'un même modèle. Aucune animation tant qu'aucun clip ne bouge (2D rendu à la demande).
