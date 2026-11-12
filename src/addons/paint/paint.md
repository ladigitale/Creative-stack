# Addon `paint` — peindre en temps réel

`sonic-paint` est une toile de peinture : pinceau doux à espacement régulier, gomme, pression du stylet, lissage du tracé, annuler / rétablir. La toile est une **source d'images** : un `sonic-shader` la lit à chaque trait avec `channel0="#toile"`, de quoi peindre pour déformer, éclairer ou faire couler une image.

```json
{ "tagName": "sonic-paint", "attributes": { "id": "toile", "width": "1024", "height": "768", "brush-from": "pinceau", "control": "peintureCtl", "out-data-provider": "peintureState" } }
{ "tagName": "sonic-shader", "attributes": { "channel0": "#toile", "fragment": "…" } }
```

| Attribut | Rôle |
|---|---|
| `width` `height` | Taille de la toile en pixels (jusqu'à 4096 de côté et 16 millions de pixels) |
| `background` | Couleur de fond ou `transparent` |
| `color` `size` `hardness` `opacity` | Couleur CSS, diamètre (1 à 512), bord net (0 flou, 1 net), opacité de chaque empreinte |
| `spacing` | Écart entre empreintes, en fraction du diamètre (0,12) |
| `smoothing` | Lissage du tracé, 0 à 0,95 : plus haut, plus stable et plus en retard |
| `tool` | `paint`, `erase` (gomme : rend transparent) ou `pick` (pipette, voir plus bas) |
| `pressure` | La pression du stylet module le diamètre (par défaut oui) |
| `tip` | Pointe personnalisée : un chemin SVG `d` (étoile, feuille, tampon…), dessinée à la taille du pinceau et nette à toute taille. Vide : disque doux |
| `tip-from` | DP d'une forme utilisée comme pointe : chaîne `d`, `{ d }` ou une forme de `sonic-vector-library` (choisir une forme change le pinceau) |
| `angle` `angle-follow` | Rotation de la pointe en degrés ; `angle-follow` y ajoute la direction du tracé (pointe qui suit le geste) |
| `angle-jitter` `size-jitter` `scatter` | Variation aléatoire de l'angle (± degrés), de la taille (0 à 1) et dispersion autour du tracé (fraction du diamètre) |
| `roundness` | Aplatissement de la pointe, 1 intacte à 0,05 très plate (pinceau plat, calligraphie avec `angle`) |
| `blend` | Mode de fusion du trait avec la toile : `normal`, `multiply` (produit), `screen` (écran), `overlay` (incrustation), `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`. Le trait est peint sur un calque puis fusionné : il ne se fusionne pas avec lui-même. Sans effet sur la gomme |
| `brush-from` | DP de réglages en direct `{ color, size, hardness, opacity, spacing, smoothing, tool, pressure, tip, angle, blend… }` : une palette en SDUI écrit dedans |
| `control` | DP de commandes à compteur : `{ undo: n, redo: n, clear: n, save: n, stamp: n }` (la commande part quand `n` augmente) |
| `stamp-from` | Sources d'images fondues dans la toile à la commande `stamp` (sélecteurs `#id` séparés par des virgules, du dessous vers le dessus) : voir « Calques » |
| `view-sync` | Toile navigable : DP de vue partagée `{ x, y, zoom, rotation }`, lu et écrit (voir « Calques ») |
| `in-data-provider` | Image de départ (`SonicMediaRef`, par exemple une photo de `sonic-file-open`) : dessinée à la place de la toile |
| `undo-levels` | Étapes d'annulation gardées (20 par défaut, 0 pour aucune) |
| `readonly` | Ne peint plus (affichage seul) |
| `hidden-preview` | Toile invisible : elle ne sert que de source d'images |

État : `{ status, error, width, height, strokes, drawing, canUndo, canRedo, tool, color, picked, size, last }`. `save` enregistre un PNG dans `last` (`{ url blob:, mime, width, height, size }`) : brancher `sonic-media-download source="peintureState.last"`.

Les variations aléatoires sont tirées d'une graine par trait : un trait se dessine de la même façon à chaque fois.

## Toile navigable (`navigable`)

Avec `navigable`, l'élément devient une **fenêtre** (sa taille CSS : lui donner une hauteur, par exemple `height:100%` dans un conteneur plein écran) sur l'image `width × height`. La navigation est **la même que celle de `sonic-sketch`** (code partagé, `src/shared/view2d.ts`) :

| Geste | Effet |
|---|---|
| Molette (Ctrl + molette, pincement du pavé) | Zoom sous le curseur |
| Espace + glisser, bouton du milieu, ou outil main (`tool: "hand"` dans `brush-from`) | Déplacer |
| Deux doigts | Déplacer, zoomer et **tourner** autour des doigts (le trait commencé au premier doigt est annulé) |
| `+` `-` `0` `R` / `Maj+R` (toile active) | Zoom avant / arrière / cadrer l'image / tourner de ±15° |

Pixels nets au zoom avant, damier sous la transparence. `view-from` : DP `{ x, y, zoom, rotation }` (centre en pixels d'image, rotation en radians). `control` ajoute `fit`, `reset` (image entière, droite), `zoomIn`, `zoomOut`, `rotateLeft`, `rotateRight`, `straighten`. L'état publie `x`, `y`, `zoom`, `rotation` et la taille de la fenêtre `viewWidth`, `viewHeight` (de quoi dessiner le cadre visible sur une vignette). La toile reste une source d'images (l'image entière, pas la fenêtre) et `save` exporte l'image entière.

```json
{ "tagName": "sonic-paint", "attributes": { "navigable": "", "width": "4000", "height": "4000", "background": "transparent", "brush-from": "pinceau", "control": "peintureCtl", "out-data-provider": "peintureState", "style": "height:100%" } }
```

## Toile déplacée, zoomée, tournée par un parent

La position du pointeur est lue dans le repère propre de la toile : un parent peut la mettre à l'échelle, la déplacer ou la **tourner** (`sonic-stage`, nœud avec `scale` et `rz`) sans fausser le tracé. Au doigt, si un deuxième doigt touche l'écran pendant un trait, le trait est **annulé** (la toile revient à son état d'avant) et la toile ne peint plus jusqu'à ce que tous les doigts soient levés : c'est un geste, à confier à une `sonic-gesture passthrough pan pinch` placée autour de la toile.

## Pipette

`tool="pick"` (ou Alt + clic avec le pinceau) : la couleur **vue** sous le point devient celle du pinceau. Elle est écrite dans `brush-from` (`color`), si bien que la palette et les nuanciers la montrent, et publiée dans l'état (`picked`) et par l'évènement `paint-pick` `{color, done}`. Glisser fait suivre la couleur. Si `pick` venait de `brush-from` (`tool`), l'outil revient à `paint` au lever.

La pipette voit **tous les calques** sous le point : les sources d'images visibles (`sonic-sketch`, `sonic-paint`, `sonic-shader`, `sonic-2d`, `sonic-3d`, caméra…) sont composées du dessus vers le dessous, l'ordre étant celui du document (un frère placé après est au-dessus). Un aplat vectoriel donne sa couleur exacte. Ce qui reste transparent tout en bas est pris sur blanc. Un canvas WebGL sans `preserveDrawingBuffer` peut se lire transparent hors de son rendu : il est alors ignoré.

## Calques : pixels et vectoriel

Une toile `sonic-paint navigable` et un `sonic-sketch` à fond transparent superposés (même boîte, `position:absolute;inset:0`) forment un dessin à deux calques :

```json
{ "tagName": "sonic-paint", "attributes": { "id": "pixels", "navigable": "", "width": "2048", "height": "2048", "view-sync": "vue", "brush-from": "pinceau", "control": "pixCtl", "stamp-from": "#vecteurs", "style": "position:absolute;inset:0" } }
{ "tagName": "sonic-sketch", "attributes": { "id": "vecteurs", "background": "transparent", "view-sync": "vue", "brush-from": "pinceau", "data-bind": "", "::width": "$w", "::height": "$h", "style": "position:absolute;inset:0" } }
```

- **Vue partagée.** Les deux toiles lisent et écrivent la même vue `view-sync`. Une unité du monde vectoriel vaut alors un pixel de l'image, et les deux calques restent alignés en zoomant, en déplaçant et en tournant. La toile pixel borne le zoom : la vue bornée est réécrite et le vectoriel l'adopte. Au départ, le cadrage de l'image est adopté par le vectoriel, sauf si le DP de vue a déjà une valeur.
- **Calque actif.** Seul le calque actif reçoit le pointeur : on donne à l'autre `pointer-events:none`. La molette et les gestes de vue passent par le calque actif et la vue suit sur l'autre.
- **Pipette.** Elle traverse les calques, depuis l'une ou l'autre toile.
- **Aplatir.** La commande `stamp` (DP `control`) fond les sources de `stamp-from` dans l'image telles qu'elles apparaissent à l'écran, à leur place. On peut y fondre le calque vectoriel, mais aussi une image de `sonic-shader`, de `sonic-2d` ou de `sonic-3d` posée au-dessus. C'est une étape d'annulation. La résolution est celle de l'écran au moment de la fusion : zoomer avant de fondre donne plus de détail.
- **Rendu.** Chaque toile est une source d'images : `sonic-shader channel0="#vecteurs"` (ou `#pixels`) la lit en texture, comme un `sonic-2d` ou un `sonic-3d` qui accepte des canaux d'images.

## Limites

L'opacité s'applique à chaque empreinte : un trait lent à faible opacité s'épaissit en s'y superposant. L'annulation garde des copies de la toile : sur une grande toile, le nombre d'étapes est réduit pour rester sous une borne de mémoire. Une image de départ de grande taille est ramenée à la toile en conservant ses proportions.

### Stylets

Comportement standard des applications de dessin, pour les stylets (Apple Pencil, Wacom, Surface Pen, S Pen…) :

| Attribut | Rôle |
| --- | --- |
| `pen-eraser` | Bout gomme du stylet : `erase` (défaut) le trait devient une gomme, `none` il dessine |
| `pen-barrel` | Bouton latéral : `pick` (défaut) pipette, `pan` déplace la vue, `none` dessine |
| `pen-tilt` | Rotation du stylet (`twist`) ou, à défaut, direction de son inclinaison : `angle` (défaut) oriente la pointe (ajoutée à `angle`), `none` l'ignore |
| `touch` | Doigt : `auto` (défaut) dessine tant qu'aucun stylet n'a servi, puis ne fait plus que déplacer / zoomer la vue (rejet de la paume) ; `draw` ; `navigate` |
| `pressure-curve`, `pressure-min` | Courbe de pression : `min + (1 − min) · p^courbe` (> 1 plus doux, < 1 plus ferme) |
| `simulate-pressure` | Souris et doigt : pression simulée par la vitesse (lent = appuyé) |

La pression vient du stylet (`pressure`), les points intermédiaires d'un geste rapide sont tous lus (`getCoalescedEvents`), et le survol du stylet alimente le curseur-pinceau (orienté comme la pointe).

Les mêmes réglages peuvent venir en direct du DP du pinceau (`brush-from`) : `pressureCurve`, `pressureMin`, `simulatePressure` (prioritaires sur les attributs, enregistrables avec les préférences).
