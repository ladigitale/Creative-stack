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
| Deux doigts | Zoom et déplacement ensemble (le trait en cours est abandonné) |
| `+` `-` `0` (toile active) | Zoom avant / arrière / cadrer le dessin |

Pendant un geste, l'image est transformée en direct, puis redessinée nette une fois la vue stable.

## Pinceau

Mêmes réglages que `sonic-paint` : `color`, `hardness`, `opacity`, `spacing`, `smoothing`, `pressure`, et les **pointes personnalisées** : `tip` (chemin SVG) ou `tip-from` (DP d'une forme, par exemple `sonic-vector-library`), `angle`, `angle-follow`, `angle-jitter`, `size-jitter`, `scatter`, `roundness`.

`size` est un diamètre en **pixels d'écran** par défaut : le trait garde la même épaisseur apparente quel que soit le zoom, et se retrouve plus fin ou plus gros en le regardant de plus près ou de plus loin. Avec `size-space="world"`, `size` est en unités du monde (le trait grossit avec le zoom).

`blend` : mode de fusion des nouveaux traits avec ce qui est dessous (fond compris) : `normal` (défaut), `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`. Chaque trait garde son mode ; il fusionne d'un bloc (ses empreintes ne se fusionnent pas entre elles). Réglable en direct dans `brush-from` (`{"blend": "multiply"}`). Un trait fusionné est rendu un peu plus lentement qu’un trait normal (un tampon par trait visible).

`tool` : `paint`, `erase` (efface en entier les traits touchés ; annulable) ou `hand`.

## Simplification des traits

À la fin de chaque geste, le trait est compacté : les points confondus (moins d'une demi-tolérance) sont joints, puis l'algorithme de Ramer–Douglas–Peucker retire les points qui s'écartent de moins de `simplify` pixels d'écran (défaut `0.35`, au zoom du tracé) de la courbe gardée. La pression compte : un point dont la pression s'écarte de plus de 0,04 de la pression interpolée reste. `simplify="0"` garde tous les points. L'état publie `points` (total) et `lastStroke {before, after}`.

## Commandes et état

`control` : `{ undo, redo, clear, save, savePng, fit, reset, zoomIn, zoomOut }` — compteurs (la commande part quand le nombre augmente). `view-from` : DP `{ x, y, zoom }` qui règle la vue (centre du monde et zoom).

État : `{ status, error, blend, zoom, x, y, strokes, points, lastStroke, drawing, canUndo, canRedo, tool, color, size, bbox, last }`. `save` enregistre un SVG dans `last` (`savePng` : un PNG de la vue) : brancher `sonic-media-download source="dessinState.last"`.

## Export SVG

Traits nets, opaques, à pression constante → un tracé de courbes lissé. Pointes personnalisées → un seul `<path>` partagé et un `<use>` par empreinte. Disques doux → cercles à dégradé partagé. Trait fusionné → groupe `<g style="mix-blend-mode:…">`. Jointure : les tracés nets consécutifs de même couleur, épaisseur et mode deviennent un seul `<path>` ; culling : avec une zone d'export, les traits qui n'y entrent pas sont écartés.

## Limites

20 000 traits, 20 000 points par trait, 2 millions de points au total ; l'export SVG s'arrête à 100 000 empreintes (erreur dans `error`). Le rendu parcourt les traits visibles : au-delà de quelques milliers de traits très étendus, le redessin devient sensible. Les modes de fusion s'appliquent au trait entier : pas de fusion d'une empreinte avec les précédentes du même trait.
