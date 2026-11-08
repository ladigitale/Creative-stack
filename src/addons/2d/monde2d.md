# Format « monde2d » : un monde 2D complet, dessiné pour la 2D (`sonic-2d`)

Clé `monde2d` du DataProvider (ou attribut `monde2d`) : un monde entier — ciel, calques à parallaxe, décor, personnages
et animaux articulés et animés — en formes vectorielles (aplats, dégradés, motifs, relief, contours). Même esprit que le
format `monde` 3D (modèles, clips, placement, instances pilotées par `nodes`), mais **pensé pour la 2D** : unités de la
scène (px, y vers le bas), vues de profil, de face ou de dessus, styles graphiques 2D.

```json
{ "tagName": "sonic-2d", "attributes": { "dataProvider": "jeu", "target": "jeu", "width": "720", "height": "480" } }
```

DP `jeu` : `{ "monde2d": {…}, "nodes": { "p0": { "x": 320, "y": 400, "clip": "course", "flip": true, "ease": { "ms": 300 } } } }`.

## Clés du monde

| Clé | Rôle |
|---|---|
| `ciel` | Fond : `"#rrggbb"` ou dégradé `["#haut", "#bas"]` |
| `layers` | Calques du fond vers l'avant : `[{"name": "loin", "parallax": 0.3}, {"name": "monde", "parallax": 1, "ysort": true}, …]` (12 max). Appliqués si l'attribut `layers` est vide. `ysort` : tri par y (vue de dessus, 3/4) |
| `style` | `plat` (aplats, contour fin), `doux` (relief, contour léger), `bd` (gros contour noir, relief), `encre` (contour noir, couleurs claires), `gouache` (relief, grain) ; ou un style vectoriel procgen : `flat`, `ligne-claire`, `gravure`, `affiche`, `papier-decoupe` |
| `styleGen` | Style vectoriel des modèles `gen` (sinon déduit de `style` : plat/doux → flat, bd → ligne-claire, encre → gravure, gouache → affiche) |
| `outline` | Épaisseur du contour (px) ; `relief` : ombre et reflet internes (bool) |
| `palette`, `textures`, `texture` | Couleurs par rôle ; motifs par rôle ou pour tout (voir `../3d/monde.md`, Textures : `scale` = motifs pour 100 px) |
| `models`, `place` | Modèles (64 max) et placements |
| `detail` | Finesse des courbes : `low`, `mid`, `high` |

## Pièces (2D)

| Clé | Rôle |
|---|---|
| `name`, `parent` | Nom (nœud `<instance>_<name>`), pièce parente |
| `at` | **Articulation** dans le repère du parent (px) |
| `rot` | Rotation de repos (degrés, sens horaire) |
| `off` | Centre de la forme depuis l'articulation (bras pendant : `[0, 12]`) |
| `scale`, `z` | Échelle ; ordre de dessin dans l'instance (plus grand = devant) |
| forme | **Une** des clés : `rect [w, h, rayon]`, `circle r`, `ellipse [rx, ry]`, `capsule [r, longueur]` (verticale), `poly [[x, y], …]`, `blob [[x, y], …]` (courbe fermée lisse), `star [branches, r1, r2]`, `arc [r, début°, fin°, épaisseur]`, `path "M … L … Q … C … Z"` (chemin SVG restreint), `trait {pts, smooth}` (ligne ouverte), `text {text, size}` (40 caractères) |
| `role` / `color` | Rôle (palette, recolorable) ou couleur fixe |
| `grad`, `gradAngle` | Dégradé `[clair, foncé]` |
| `tex` | Motif (`"rayures"`, `{kind, scale, color2, angle, contrast}`) |
| `line`, `stroke`, `fill` | Épaisseur et couleur du contour ; `fill: false` = tracé seul |
| `relief`, `glow`, `opacity` | Relief de la pièce, lumineuse (0..1), opacité |
| `mirror` | Dédoublement `<name>L` / `<name>R` : `x` (gauche / droite, vue de face), `y` (vue de dessus, regard +x), `z` (profil : même place, copie derrière, assombrie, animée en décalé). Les enfants suivent. `mirrorZ`, `mirrorShade` règlent la copie |
| `repeat` | `{n, at, rot}` : copies `<name>0…` |
| `hidden` | Cachée au départ |

## Clips

`{ms, loop, then, ease, tracks: {pièce: {r (degrés), x, y (px), s, sx, sy (facteurs), o (opacité), sync, phase}}}` :
listes de clés réparties sur la durée. Piste au nom d'une paire `mirror` : les deux côtés, en opposition (`sync` : ensemble).

## Placement

`{model, name, at: [x, y], rot, scale, flip, roles, clip, layer, z, hidden}` ; décor en masse : `grid [nx, ny]` + `step`,
`scatter n` + `area [x0, y0, x1, y1]`, `jitter`, `turn`, `size [min, max]`, `seed`. **Avec `name`** : instance pilotable
et animée (ombre au sol pour les personnages et animaux). **Sans `name`** : décor dessiné une fois. Budgets : 3000 copies,
300 instances, 30 000 pièces, 6 000 pièces animées.

## Pilotage par `nodes`

| Nœud | Champs |
|---|---|
| `<instance>` | `x y` (px), `rz` (rad), `scale`, `opacity`, `visible`, `z`, **`flip`** (regard vers la gauche), `ease`, `lift` (saut en arc : l'ombre reste au sol), **`clip`**, **`clipSpeed`**, **`clipT`**, **`roles`** |
| `<instance>_<pièce>` | `visible`, `color`, `opacity` |

Republier la même valeur ne fait rien ; le monde peut changer sans perdre l'état des instances. Tap : `{objectId: instance,
part, x, y}`. Sortie (`out-data-provider`) : `monde2dInfo {models, instances, decor, layers, issues}`.

## Modèles `gen` : illustration vectorielle procgen

`{"gen": "character", "vue": "plongee", "taille": 80, "params": {…}, "seed": 4}` : l'objet est dessiné par les
générateurs procgen en illustration vectorielle (traits continus à épaisseur variable sur le squelette posé, aplats,
encre, hachures selon `styleGen`) : personnages humains (visage, coiffure, garde-robe), animaux (`animal.dog`,
`animal.horse`, `animal.duck`…), `building`, `tree`, `bush`, `rock`, `plant`, `flowers`, `prop.<objet>`, `vehicle`,
`ball.<ballon>`, `seat.<assise>`… `params` = paramètres du générateur (`top`, `bottom`, `hair`, `archetype`…).

| Clé | Rôle |
|---|---|
| `vue` | `profil` (défaut ; `flip` tourne le regard), `face`, `dessus` (verticale), `plongee` (vue d'en haut inclinée : le plus lisible pour un jeu vu de dessus) |
| `taille` | Hauteur à l'écran (px) d'un objet à sa taille de référence (personnage 1,7 m, animal 0,8 m, arbre 6 m, bâtiment 7 m) |
| `pitch` | Inclinaison de la plongée (degrés, 90 = verticale ; défaut 55) |

Os, clips et rôles : ceux du format monde (voir `../3d/monde.md`, Modèles `gen`) : clips `idle marche course joie saut
salut…` (moteur procgen : un personnage déplacé par `nodes` marche ou court, pieds plantés) et gestes `tir passe
controle tacle chute plongeon` ; `roles` `maillot short chaussette peau cheveux toit mur…`. En `dessus` / `plongee`,
`rz` est le **cap** (le personnage est redessiné tourné, l'image ne pivote pas). Le personnage porte son ombre.
Dessin cadencé à 24 images/s ; décor dessiné une fois. Tap : `{objectId: instance}`.

## Préréglages (`preset`)

| Nom | Contenu | `params` |
|---|---|---|
| `personnage` | Personnage ou créature, `vue` `profil` (regard +x), `face` ou `dessus` (regard +x). Clips `idle marche course controle tir passe tacle chute saut joie plongeon` | `espece` (humain chat renard ours lapin dino monstre grenouille robot), `taille` (px, défaut 64), `corpulence`, `grosseTete`, `tete`, `oreilles`, `queue`, `cornes`, `cheveux`, `yeux`, `museau`, `numero`, `peau` |
| `animal` | Quadrupède, `profil` ou `dessus` ; clips `idle marche course assis` (+ `saut`) | `taille`, `longueur`, `oreilles`, `queue`, `peau` |
| `arbre` | `rond`, `sapin`, `boules`, `palmier` ; profil (clip `vent`) ou dessus | `vue`, `taille`, `forme` |
| `buisson`, `rocher`, `fleur`, `herbe`, `nuage` | Décor (clips `vent`, `derive`) | `taille` |
| `maison` | Façade (profil) ou toit (dessus) | `vue`, `largeur`, `hauteur`, `toit`, `cheminee` |
| `sol`, `collines` | Sol de profil (herbe, terre, relief), collines d'arrière-plan | `largeur`, `epaisseur` / `hauteur`, `relief` |
| `terrain`, `but`, `ballon`, `foule` | Football vu de dessus : pelouse à bandes et lignes, buts (filet), ballon (clip `roule`), gradins et supporters (clip `ola`) | voir le générateur |

Rôles des personnages : `peau`, `maillot`, `short`, `chaussette`, `chaussure`, `numero`, `museau`, `interieur`, `cheveux`,
`oeil`, `pupille`, `corne`, `crete`.

## Performance

Chaque pièce de modèle est dessinée une fois par couleur et partagée par toutes les instances ; une image d'animation ne
fait que déplacer des pièces (aucun redessin). Décor dessiné une fois. Rendu à la demande : rien ne bouge, rien n'est
calculé.
