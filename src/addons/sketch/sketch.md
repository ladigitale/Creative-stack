# Addon `sketch` — dessiner en vectoriel, zoom infini

`sonic-sketch` est une toile de dessin dont les traits restent des **données** : points, pression, pinceau. Chaque trait est redessiné net à chaque zoom (de 0,0001 à 10 000 000 pixels par unité), et l'ensemble s'exporte en **SVG**. La toile est aussi une **source d'images** : `sonic-shader channel0="#id"` la lit.

```json
{ "tagName": "sonic-sketch", "attributes": { "id": "dessin", "width": "900", "height": "600", "brush-from": "pinceau", "tip-from": "formeChoisie", "control": "dessinCtl", "out-data-provider": "dessinState" } }
```

## Se déplacer

| Geste | Effet |
|---|---|
| Molette (ou Ctrl + molette, pincement du pavé tactile) | Zoom sous le curseur |
| Espace + glisser, bouton du milieu, ou `tool="hand"` | Déplacer la vue |
| Deux doigts | Déplacer, zoomer et **tourner** autour des doigts (le trait en cours est abandonné) |
| `+` `-` `0` `R` / `Maj+R` (toile active) | Zoom avant / arrière / cadrer le dessin / tourner de ±15° |

Même navigation que `sonic-paint navigable` (code partagé, `src/shared/view2d.ts`).

Pendant un geste, l'image est transformée en direct, puis redessinée nette une fois la vue stable.

## Pinceau

Mêmes réglages que `sonic-paint` : `color`, `hardness`, `opacity`, `spacing`, `smoothing`, `pressure`, et les **pointes personnalisées** : `tip` (chemin SVG) ou `tip-from` (DP d'une forme, par exemple `sonic-vector-library`), `angle`, `angle-follow`, `angle-jitter`, `size-jitter`, `scatter`, `roundness`.

`size` est un diamètre en **pixels d'écran** par défaut : le trait garde la même épaisseur apparente quel que soit le zoom, et se retrouve plus fin ou plus gros en le regardant de plus près ou de plus loin. Avec `size-space="world"`, `size` est en unités du monde (le trait grossit avec le zoom).

`blend` : mode de fusion des nouveaux traits avec ce qui est dessous (fond compris) : `normal` (défaut), `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`. Chaque trait garde son mode ; il fusionne d'un bloc (ses empreintes ne se fusionnent pas entre elles). Réglable en direct dans `brush-from` (`{"blend": "multiply"}`). Un trait fusionné est rendu un peu plus lentement qu’un trait normal (un tampon par trait visible).

`tool` : `paint`, `erase` (vraie gomme : retire sa forme de ce qu'elle touche, à tout zoom ; annulable), `pick` (pipette) ou `hand`.

## Simplification des traits

À la fin de chaque geste, le trait est compacté : les points confondus (moins d'une demi-tolérance) sont joints, puis l'algorithme de Ramer–Douglas–Peucker retire les points qui s'écartent de moins de `simplify` pixels d'écran (défaut `0.35`, au zoom du tracé) de la courbe gardée. La pression compte : un point dont la pression s'écarte de plus de 0,04 de la pression interpolée reste. `simplify="0"` garde tous les points. L'état publie `points` (total) et `lastStroke {before, after}`.

## Aplatissement à chaque geste

Avec `flatten` (défaut vrai), chaque trait **plein** (net, sans pointe personnalisée ni variation, pression constante ; l'opacité et le mode de fusion sont permis) est aplati au lever du pointeur dans la **carte d'aplats** du dessus : des régions disjointes, chacune d'une seule vraie couleur et d'un seul tenant. Le découpage se fait avec les opérations booléennes de l'addon `vector` (polygon-clipping) :

- sous le trait, chaque région prend la couleur **calculée** du mode de fusion et de l'opacité (formules W3C Compositing and Blending : `multiply`, `screen`… deviennent des couleurs unies, plus de fusion au rendu) ;
- ce que le trait recouvre entièrement disparaît des régions de dessous ;
- les morceaux de même couleur qui se touchent sont unis : une région = une couleur d'un seul tenant (polygone avec ses trous). Un trait ne recalcule que les régions qu'il touche, ce qui garde chaque fin de geste rapide (300 traits mêlés : environ 15 ms par geste en médiane).

Hors des régions, le trait se fusionne avec le fond (`background`) quand rien n'est dessous ; si des traits non aplatis (doux, pointes) sont dessous, la carte commence au-dessus d'eux et la partie du trait hors régions garde son mode (fusion au rendu). Chaque aplatissement est une étape d'annulation. `flatten="false"` garde chaque trait en empreintes (ancien nom : `merge`).

## Gomme

`tool="erase"` est une vraie gomme : disque net de la taille du pinceau. Au lever, sa forme est **retirée** de toutes les cartes d'aplats (un trou exact, à tout zoom) ; si elle touche des traits non aplatis, un masque est posé au-dessus pour les trouer aussi (export SVG : `<mask>`). Pendant le geste, l'aperçu est troué en direct.

`tool="pick"` (ou Alt + clic avec le pinceau) est une pipette : la couleur vue sous le point devient celle du pinceau, même si elle est née d'une fusion et n'est pas dans la palette. Dans un aplat opaque, c'est la couleur exacte de la région ; ailleurs (traits en empreintes, couleurs translucides), le pixel affiché. Elle traverse les calques : avec un fond transparent, ce qui est dessous (une toile `sonic-paint`, un shader, une scène) est composé. Glisser fait suivre la couleur ; elle est écrite dans `brush-from` (`color`), si bien que la palette et les nuanciers la montrent, et publiée dans l'état (`picked`) et par l'évènement `sketch-pick` `{color, done}`. Si `pick` venait de `brush-from` (`tool`), l'outil revient à `paint` au lever.

## Commandes et état

`control` : `{ undo, redo, clear, save, savePng, fit, reset, zoomIn, zoomOut, rotateLeft, rotateRight, straighten }` — compteurs (la commande part quand le nombre augmente). `view-from` : DP `{ x, y, zoom, rotation }` qui règle la vue (centre du monde, zoom, rotation en radians).

État : `{ status, error, blend, zoom, x, y, rotation, strokes, points, lastStroke, regions, colors, flats, masks, flattened, drawing, canUndo, canRedo, tool, color, picked, size, bbox, last }`. `save` enregistre un SVG dans `last` (`savePng` : un PNG de la vue) : brancher `sonic-media-download source="dessinState.last"`.

## Export SVG

Traits nets, opaques, à pression constante → un tracé de courbes lissé. Pointes personnalisées → un seul `<path>` partagé et un `<use>` par empreinte. Disques doux → cercles à dégradé partagé. Carte d'aplats → un `<path>` rempli par couleur (polygones exacts en double précision, `fill-rule="evenodd"`) ; gomme sur des traits non aplatis → groupe masqué. Trait avec mode de fusion → groupe `<g style="mix-blend-mode:…">`. Jointure : les tracés nets consécutifs de même couleur, épaisseur et mode deviennent un seul `<path>` ; culling : avec une zone d'export, les traits qui n'y entrent pas sont écartés.

## Limites

20 000 traits, 20 000 points par trait, 2 millions de points au total ; l'export SVG s'arrête à 100 000 empreintes (erreur dans `error`). Le rendu parcourt les traits visibles : au-delà de quelques milliers de traits très étendus, le redessin devient sensible. Traits non aplatis : le mode de fusion s'applique au trait entier (pas de fusion d'une empreinte avec les précédentes du même trait).

Le découpage est rendu robuste aux géométries accumulées : en cas d'échec de polygon-clipping, l'opération est rejouée avec les sommets alignés sur une grille très fine (repère local, invisible). Si elle échoue encore, le trait reste en empreintes.

## Calques : vectoriel sur pixels

`sonic-sketch background="transparent"` posé sur une `sonic-paint navigable` avec le même `view-sync` forme un dessin à deux calques alignés. `view-sync` est un DP de vue partagée `{ x, y, zoom, rotation }`, lu et écrit ; une unité du monde y vaut un pixel de l'image. On rend le calque inactif transparent au pointeur avec `pointer-events:none`. La pipette traverse les calques. `sonic-paint` peut fondre le calque vectoriel dans ses pixels avec `stamp-from="#id"` et la commande `stamp`. Voir l'addon `paint`, section « Calques ». La toile est aussi une source d'images pour `sonic-shader channel0="#id"`, `sonic-2d` et `sonic-3d`.
