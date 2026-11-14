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

`tool` : `paint`, `erase` (gomme au pinceau courant : taille, forme, dureté et opacité ; annulable), `pick` (pipette), `select` / `select-color` (sélection des aplats, voir plus bas) ou `hand`.

## Simplification des traits

À la fin de chaque geste, le trait est compacté : les points confondus (moins d'une demi-tolérance) sont joints, puis l'algorithme de Ramer–Douglas–Peucker retire les points qui s'écartent de moins de `simplify` pixels d'écran (défaut `0.35`, au zoom du tracé) de la courbe gardée. La pression compte : un point dont la pression s'écarte de plus de 0,04 de la pression interpolée reste. `simplify="0"` garde tous les points. L'état publie `points` (total) et `lastStroke {before, after}`.

**Traits en courbe.** Un trait d'empreintes (non aplati) est ensuite gardé en **points de passage d'une courbe** (Catmull-Rom centripète, `curve: true`) plutôt qu'en sommets d'une ligne brisée. Les points sont choisis pour que la courbe suive le tracé brut à `simplify` près, avec la pression lissée (le tremblement du stylet ne garde pas de points). Résultat : 2 à 3 fois moins de points qu'en ligne brisée à précision égale, et un trait lisse à tous les zooms, là où une ligne brisée montrait ses facettes de près. Chaque passe d'un trait qui revient sur lui-même est ajustée à part. Les dessins enregistrés en lignes brisées se relisent tels quels.

## Rendu au dézoom

- Pendant un geste de vue, la couche déjà dessinée est réduite avec un lissage de qualité (pas de fourmillement du détail fin).
- Une empreinte plus petite qu'un pixel à l'écran est posée à 1 px avec une opacité proportionnelle à sa surface : un trait fin pâlit en dézoomant au lieu de disparaître ou de grainer.
- Quand les empreintes d'un trait font moins de 3 px à l'écran, il en reste au plus une par demi-pixel (les autres comptées dans l'opacité), et le trait se pose sans tampon intermédiaire. Le tampon d'un trait translucide est limité à sa zone. Sur un dessin de 2 800 traits translucides, le rendu en fort dézoom passe d'environ 4 s à 0,35 s (navigateur sans GPU).
- **Rendu en arrière-plan** (`layer-worker.ts`) : au-delà de 150 traits visibles, la couche est rendue dans un Web Worker (OffscreenCanvas, script en blob:) qui garde sa copie des traits (seuls les traits ajoutés partent ; une annulation ou une retouche renvoie la liste). Le fil principal ne fait qu'afficher : pendant le rendu, l'ancienne couche reste montrée transformée, puis la nouvelle la remplace d'un coup (pas de damier). Un trait posé avant la fin se pose sur l'ancienne couche ; la nouvelle arrive après lui, avec lui. Mesuré (Chrome sans GPU, écran de téléphone 390×844, 5 000 traits) : rendu de 0,6 à 0,8 s dans le worker, aucune tâche longue sur le fil principal, 42 ms au pire par image (203 ms sans worker). Image identique au rendu direct. `no-worker` : rendu sur le fil principal, par tranches au-delà de 400 traits visibles (repli automatique sans Worker ou OffscreenCanvas).
- **Rendu par la carte graphique** (`gl-render.ts`, WebGL2 dans le worker) : empreintes en quads instanciés (disque doux calculé dans le shader, pointes en texture), traits translucides ou en fusion réunis dans un tampon puis posés avec leur mode (les 16 modes du canvas, formules W3C, dans un shader), gomme, aplats et masques au stencil (pair-impair), multiéchantillonnage seulement s'il y a des formes à l'écran. Mêmes décisions que le rendu 2D (`strokePlan`, `eachStamp` : niveau de détail compris). Sur téléphone, le coût vient des changements de cible (une puce mobile recharge tout l'écran à chacun) : les traits en tampon sont posés par lots (même mode, sans chevauchement ; chacun mis à son opacité dans sa zone), soit 111 changements au lieu d'environ 19 000 pour 5 000 traits. Écart moyen avec le rendu 2D sous 1/255. Sans WebGL2 ou en cas d'échec (contexte perdu…), le worker rend en 2D.
- **Choix du moteur** : `render-mode` = `auto` (worker + carte graphique, défaut), `gpu`, `cpu` (worker en 2D), `direct` (fil principal) ; `live-render` : la vue est aussi refaite pendant les gestes (pincement, glissé, molette) quand un rendu par la carte graphique prend moins de 150 ms (désactivé par défaut : plus gourmand). `render-from` : DP du réglage (`{ mode, live }`, ou `renderMode` / `renderLive`, `live` en booléen ou « oui »/« non »), prioritaire. L'état publie `render` : `{ mode, live, engine (gl, 2d, direct), ms, batches, switches, msaa }`, mis à jour à chaque rendu (`<out-data-provider>.render`).

## Aplatissement à chaque geste

Avec `flatten` (défaut vrai), chaque trait **plein** (net, sans pointe personnalisée ni variation, pression constante ; l'opacité et le mode de fusion sont permis) est aplati au lever du pointeur dans la **carte d'aplats** du dessus : des régions disjointes, chacune d'une seule vraie couleur et d'un seul tenant. Le découpage se fait avec les opérations booléennes de l'addon `vector` (polygon-clipping) :

- sous le trait, chaque région prend la couleur **calculée** du mode de fusion et de l'opacité (formules W3C Compositing and Blending : `multiply`, `screen`… deviennent des couleurs unies, plus de fusion au rendu) ;
- ce que le trait recouvre entièrement disparaît des régions de dessous ;
- les morceaux de même couleur qui se touchent sont unis : une région = une couleur d'un seul tenant (polygone avec ses trous). Un trait ne recalcule que les régions qu'il touche, ce qui garde chaque fin de geste rapide (300 traits mêlés : environ 15 ms par geste en médiane).

Hors des régions, le trait se fusionne avec le fond (`background`) quand rien n'est dessous ; si des traits non aplatis (doux, pointes) sont dessous, la carte commence au-dessus d'eux et la partie du trait hors régions garde son mode (fusion au rendu). Chaque aplatissement est une étape d'annulation. `flatten="false"` garde chaque trait en empreintes (ancien nom : `merge`).

## Gomme

`tool="erase"` gomme avec le pinceau courant : sa taille, sa forme, sa dureté et son opacité. L'opacité règle à quel point elle efface. Pendant le geste, l'aperçu est effacé en direct, comme le résultat final.

- **Disque net** (dureté 1, sans pointe ni dispersion) : au lever, sa forme est **retirée** de toutes les cartes d'aplats (un trou exact, à tout zoom). À opacité inférieure à 1, les régions dessous gardent leur couleur et perdent cette part de leur opacité ; comme pour le pinceau, le trait est coupé en passes là où il revient sur lui-même, et chaque passe efface encore (frotter en aller-retour efface de plus en plus). Si elle touche des traits non aplatis, un masque de la même opacité est posé au-dessus (export SVG : `<mask>`).
- **Pointe, bord doux, dispersion, pression variable** : la gomme devient un trait d'empreintes qui efface ce qui est dessous comme le pinceau peindrait (bord dégradé, forme de la pointe). Il est gardé tel quel (export SVG : `<mask>` fait des empreintes).

`tool="pick"` (ou Alt + clic avec le pinceau) est une pipette : la couleur vue sous le point devient celle du pinceau, même si elle est née d'une fusion et n'est pas dans la palette. Dans un aplat opaque, c'est la couleur exacte de la région ; ailleurs (traits en empreintes, couleurs translucides), le pixel affiché. Elle traverse les calques : avec un fond transparent, ce qui est dessous (une toile `sonic-paint`, un shader, une scène) est composé. Glisser fait suivre la couleur ; elle est écrite dans `brush-from` (`color`), si bien que la palette et les nuanciers la montrent, et publiée dans l'état (`picked`) et par l'évènement `sketch-pick` `{color, done}`. Si `pick` venait de `brush-from` (`tool`), l'outil revient à `paint` au lever.

## Sélection et recoloration

Les aplats se sélectionnent : une forme est une **région** de la carte, d'une seule vraie couleur et d'un seul tenant (ce qu'on voit, fusions comprises : le croisement de deux traits en `multiply` est sa propre région).

- `tool="select"` : un clic sélectionne la région sous le point ; Maj + clic l'ajoute (ou la retire) ; un clic dans le vide vide la sélection. Un trou de gomme ou un trait non aplati par-dessus ne se sélectionne pas.
- `tool="select-color"` : un clic sélectionne toutes les régions de cette couleur, dans tout le dessin ; `contiguous` : seulement celles qui se touchent, de proche en proche ; `tolerance` (0..100, écart OKLab ×100 ; 0 = couleur exacte, défaut ; ~2 à peine visible, 10 à 20 pour attraper les teintes voisines nées de fusions). Les deux réglages aussi en direct dans `brush-from` (`{tolerance, contiguous}`).
- **Recolorer** : avec un outil de sélection actif, choisir une couleur (`brush-from.color` : palette, nuancier) recolore la sélection ; ou `control` `{recolor: n, color: "#…"}` (couleur du pinceau sans `color`). Les régions prennent la vraie couleur et se ressoudent à leurs voisines de même couleur ; la sélection suit la forme obtenue.
- Clavier (toile active) : Suppr / Retour arrière supprime la sélection, Échap la vide, Ctrl / Cmd + A sélectionne tout. Commandes `control` : `selectAll`, `deselect`, `deleteSelection`, `recolor`.
- Chaque recoloration ou suppression est une étape d'annulation. Le contour de sélection (pointillés) est dessiné sur une toile à part : il n'apparaît ni dans l'export ni dans la source d'images.
- État : `selection {count, colors[], bbox, area}` ; évènement `sketch-select` (même contenu). Passer à un autre outil vide la sélection.

## Commandes et état

`control` : `{ undo, redo, clear, save, savePng, fit, reset, zoomIn, zoomOut, rotateLeft, rotateRight, straighten, selectAll, deselect, deleteSelection, recolor }` — compteurs (la commande part quand le nombre augmente). `view-from` : DP `{ x, y, zoom, rotation }` qui règle la vue (centre du monde, zoom, rotation en radians).

État : `{ status, error, blend, zoom, x, y, rotation, strokes, points, lastStroke, regions, colors, flats, masks, flattened, drawing, canUndo, canRedo, tool, color, picked, selection, size, bbox, last }`. `save` enregistre un SVG dans `last` (`savePng` : un PNG) : brancher `sonic-media-download source="dessinState.last"`. Le PNG est redessiné net à `export-scale` (1 à 8 ; 8192 px de côté au plus) : de la vue courante (`export-area="view"`, défaut) ou de tout le dessin cadré (`export-area="content"`). Ces réglages se donnent aussi en direct dans le DP `control` : `{ savePng: n, exportScale: 4, exportArea: "content" }`. Le SVG suit aussi la zone quand elle est donnée (attribut `export-area` posé ou `exportArea` du DP `control`) : `view` = exactement la vue courante (viewBox sans marge, traits hors champ écartés) ; sans zone donnée, il reste le dessin entier.

## Export SVG

Traits nets, opaques, à pression constante → un tracé de courbes lissé. Pointes personnalisées → un seul `<path>` partagé et un `<use>` par empreinte. Disques doux → cercles à dégradé partagé. Carte d'aplats → un `<path>` rempli par couleur (polygones exacts en double précision, `fill-rule="evenodd"`) ; gomme sur des traits non aplatis → groupe masqué. Trait avec mode de fusion → groupe `<g style="mix-blend-mode:…">`. Jointure : les tracés nets consécutifs de même couleur, épaisseur et mode deviennent un seul `<path>` ; culling : avec une zone d'export, les traits qui n'y entrent pas sont écartés.

## Limites

20 000 traits, 20 000 points par trait, 2 millions de points au total ; l'export SVG s'arrête à 100 000 empreintes (erreur dans `error`). Le rendu parcourt les traits visibles : au-delà de quelques milliers de traits très étendus, le redessin devient sensible. Traits non aplatis : le mode de fusion s'applique au trait entier (pas de fusion d'une empreinte avec les précédentes du même trait).

Le découpage est rendu robuste aux géométries accumulées : en cas d'échec de polygon-clipping, l'opération est rejouée avec les sommets alignés sur une grille très fine (repère local, invisible). Si elle échoue encore, le trait reste en empreintes.

## Calques : vectoriel sur pixels

`sonic-sketch background="transparent"` posé sur une `sonic-paint navigable` avec le même `view-sync` forme un dessin à deux calques alignés. `view-sync` est un DP de vue partagée `{ x, y, zoom, rotation }`, lu et écrit ; une unité du monde y vaut un pixel de l'image. On rend le calque inactif transparent au pointeur avec `pointer-events:none`. La pipette traverse les calques. `sonic-paint` peut fondre le calque vectoriel dans ses pixels avec `stamp-from="#id"` et la commande `stamp`. Voir l'addon `paint`, section « Calques ». La toile est aussi une source d'images pour `sonic-shader channel0="#id"`, `sonic-2d` et `sonic-3d`.

## Importer des formes (pixels, photo, shader → vectoriel)

`import-from` lit l'état d'un `sonic-vectorize`. Chaque couche y devient un aplat opaque peint dans la carte d'aplats, du dessous au dessus : les couches empilées recouvrent les précédentes, et les morceaux de même couleur s'unissent entre eux et avec l'existant. L'import est une seule étape d'annulation. On s'en sert pour faire une base qu'on retravaille en vectoriel simplifié : une esquisse peinte en pixels, une photo, ou un shader générateur dont on fige une image. Plusieurs sources peuvent être listées, séparées par des espaces : chacune est suivie à part (`import-auto` importe chaque nouveau résultat de chacune). Une couche peut avoir une `opacity` (SVG lu tel quel) ; avec `keepColors: true` dans l'état, ses couleurs d'origine sont gardées même avec `import-colors-from`. La commande `import` du DP `control` importe le dernier résultat reçu ; avec `importSource` (`{import: n, importSource: "fichierVec"}`), elle importe l'état de ce DP-là, même s'il n'est pas dans `import-from` : utile pour un import validé par un bouton, après aperçu.

```json
{ "tagName": "sonic-vectorize", "attributes": { "id": "vecto", "source": "#pixels", "hidden-preview": "", "control": "vecCtl", "palette": "#c2410c,#0f766e,#1e293b", "out-data-provider": "vectoState" } }
{ "tagName": "sonic-sketch", "attributes": { "import-from": "vectoState", "import-auto": "", "import-skip": "#ffffff", "…": "…" } }
```

| Attribut | Rôle |
|---|---|
| `import-from` | DP d'état de `sonic-vectorize` (`paths[{color, d, opacity}]`, `width`, `height`, `frame`, `keepColors`) ; plusieurs, séparés par des espaces (ex. formes générées et fichier ouvert) |
| `import-auto` | Importe chaque nouveau résultat prêt. Un résultat déjà présent au branchement n'est pas réimporté. Sans cet attribut : commande `import` du DP `control` |
| `import-place` | `auto` (défaut), `screen` ou `view`. `screen` pose les formes là où la source apparaissait à l'écran : calque pixel ou shader posé sur le dessin, aligné au pixel près avec `view-sync`. `view` les ajuste dans la vue courante (source masquée : shader `hidden-preview`, fichier). `auto` choisit `screen` si la source était visible sur la toile |
| `import-skip` | Couleurs ignorées, séparées par des virgules. `background` (défaut) désigne le fond opaque de la toile ; mettre `#ffffff` quand on vectorise un calque pixel sur papier blanc sous une toile transparente. Vide : tout garder. Ne s’applique pas à un SVG lu tel quel (`keepColors`), qui garde toutes ses couleurs |
| `import-colors-from` | DP de palette : liste, chaîne ou état de `sonic-palette` (`{colors}`). Les couleurs de la source, de la plus étendue à la plus rare, prennent tour à tour celles de la palette. Utile pour un shader générateur aux couleurs arbitraires |

Les formes sont simplifiées à `simplify` px d'écran. Pour une base plus simple, on joue sur les réglages de `sonic-vectorize` : moins de couleurs ou une `palette` imposée (la palette d'harmonie), une `tolerance` plus haute, une `min-area` plus grande. Un import qui dépasserait la limite de sommets des aplats est refusé. **Shader générateur.** La bibliothèque du shader contient `formes`, une image fixe en aplats nets de 2 à 6 couleurs sur fond noir. Ses réglages sont le motif (cellules, courbes de niveau, rosace, entrelacs, taches), la graine, la densité et le nombre de couleurs. On le vectorise avec `curves`, puis on l'importe avec `import-skip="#000000"`, `import-place="view"` et `import-colors-from` branché sur la palette d'harmonie. Le shader est rendu à sa taille d'affichage : on lui donne au moins 400 px de côté pour des contours fins, quitte à le réduire en aperçu par une transformation CSS. Ne pas donner à un composant l'`id` d'un store : `source="#nom"` trouverait le store.

Résultat dans l'état (`imported` : `{ layers, regions, ms }` ou `{ error }`) et par l'évènement `sketch-import`.

## Finition et export pixel (post-traitement)

Le dessin reste vectoriel. La finition est une étape qu'on peut défaire, appliquée à l'image exportée :

1. `savePng` avec `exportScale` (et `exportArea`) rend un PNG net à haute résolution dans `last`.
2. Un `sonic-shader` lit ce PNG en texture : un `sonic-jsonata` recopie `dessinState.last` dans la clé `channel0` du store du shader. Avec `render-size="channel0"`, le shader se rend à la taille de cette image et non à sa taille d'affichage. Le shader de bibliothèque `finition` (papier, trame, sérigraphie, objectif) donne le même aspect quelle que soit la résolution.
3. La commande `save` du `control` du shader enregistre le résultat en PNG dans son `last` (`sonic-media-download source="fxState.last"`).

Pour un aperçu en direct, un second `sonic-shader` `channel0="#dessin"` posé par-dessus la toile (`pointer-events:none`) applique le même effet à la vue.

### Tracé vivant et précision

- `tremble` (0..1, aussi en direct dans `brush-from`) : le tracé ondule doucement de part et d'autre de la main et son épaisseur respire (bruit lent, propre à chaque trait). Un trait plein tremblé reste un trait plein : il se fond en aplat avec des contours vivants.
- Orientation : `angle`, `angle-follow` (la pointe suit la direction du geste) et `angle-jitter` (± ° au hasard par empreinte) ; dispersion `scatter`, taille `size-jitter`, aplatissement `roundness`, espacement `spacing`.
- Précision du tracé : `simplify` (px d'écran, 0..8) — 0 garde chaque point, plus haut épure le trait ; lissage de la main `smoothing` (0..0,95). Les deux se règlent aussi en direct dans `brush-from` (`{ simplify, smoothing }`).

## Retouches de la sélection ou de tout le dessin (aperçu puis validation)

Les retouches visent les régions sélectionnées, ou tout le dessin quand rien n'est sélectionné (état `edit.scope` : `selection` ou `all`). Le DP `control` décrit une retouche qui s'affiche en aperçu (rien n'est enregistré) : `{ edit: "grow", editAmount: 6 }`. Opérations : `simplify` (tolérance), `grow` (décalage à joints ronds ; négatif = réduire, la place libérée devient vide), `smooth` (rayon d'arrondi des creux et des pointes), `outline` (anneaux concentriques autour de la sélection, d'épaisseur `editAmount`, un par couleur de `editColors` : CSS ou `darker`, `lighter`, `complement`, `muted`, `vivid`, `black`, `white`, déduites de la couleur dominante de la sélection). `editAmount` est en pixels d'écran. Conversions de couleurs vers la palette (`palette-from`, DP d'une palette ; défaut `import-colors-from`), `editAmount` = force en % : `palette` (chaque couleur devient la plus proche de la palette, en OKLab), `levels` (couleurs rangées par clarté et réparties en paliers sur la palette rangée de même), `gradient` (la clarté relative choisit une position sur le dégradé continu de la palette, interpolé en OKLab) ; sur tout le dessin, la couleur des traits non aplatis est convertie aussi. Changer un réglage ou la sélection recalcule l'aperçu ; `editApply` (compteur) l'enregistre en une étape d'annulation, `editCancel` ou Échap l'abandonne ; `edit: ""` aussi. Les formes retouchées passent par-dessus leurs voisines. État : `edit { op, preview, error }`. En JS : `previewEdit(op, amountPx, colors)`, `applyEdit()`, `cancelEdit()`.

## Carnet de dessins (persistance locale)

`persist="mon-app"` range les dessins dans le navigateur (IndexedDB, sous cet espace de noms). Le dessin ouvert est réenregistré moins d'une seconde après chaque changement (et quand la page est masquée), puis rouvert au chargement. Le premier trait d'une toile vierge crée un nouveau dessin. Commandes du DP `control` (compteurs) : `newDrawing` (enregistre puis montre une toile vierge), `openDrawing` + `drawingId`, `duplicateDrawing`, `deleteDrawing` (+ `drawingId`, défaut : le dessin ouvert), `renameDrawing` + `drawingName`. État : `library { enabled, status (loading|saving|saved|error), id, name, drawings: [{ id, name, created, updated, strokes, thumb, current }] }` (le plus récent d'abord ; `thumb` = vignette PNG en URL `blob:`). `save-mode="manual"` : rien n'est enregistré sans commande. `saveDrawing` (compteur) enregistre le dessin ouvert ; `saveDrawingAs` en fait une copie sous le nom lu dans `name-from` (DP, clé `name`, ex. celui d'un `sonic-input`) ou `drawingName`, copie qui devient le dessin ouvert. `library.dirty` signale des changements non enregistrés (changer de dessin n'enregistre pas : à l'interface de prévenir) et `library.progress` (0..100) suit l'enregistrement en cours, à brancher sur une `sonic-progress`. Les enregistrements relus sont vérifiés (structure, nombres, couleurs, pointes) : la même origine peut héberger d'autres pages.

## Calque guide (`sonic-sketch-guide`)

Repères de dessin posés par-dessus la toile, jamais exportés, transparents aux pointeurs : `type` grid, iso, perspective1, perspective2, perspective3, thirds, golden, diagonals, radial, face (proportions du visage, `yaw` / `pitch` pour le tourner), figure (mannequin en `heads` têtes, `pose` debout, contrapposto, marche, course, assis, bras-leves, danse, accroupi ; `mirror`). `anchor="screen"` (défaut) : fixe sur l'écran ; `anchor="world"` : attaché au dessin à partir de la vue courante (lue dans `view-from`, le DP `view-sync` de la toile), les grilles s'affinent ou s'espacent avec le zoom pour garder un pas lisible. Réglages en direct par `settings-from` (DP) : `{ type, color, opacity, anchor, spacing, subdiv, rotation, angle, horizon, vp1, vp2, vp3, rays, yaw, pitch, pose, heads, mirror }`.

```html
<div style="position:relative">
  <sonic-sketch view-sync="vue"></sonic-sketch>
  <sonic-sketch-guide settings-from="guide" view-from="vue"></sonic-sketch-guide>
</div>
```

## Passes

Un trait en mode de fusion (autre que `normal`) ou à opacité inférieure à 1 est coupé en passes là où il revient sur lui-même : aller-retour de hachure, zigzag de remplissage, boucle, gribouillis, croisement. La pointe qui entre dans l'empreinte d'une partie déjà tracée du même trait (au-delà des deux derniers diamètres) ouvre une nouvelle passe. Chaque passe se pose sur la précédente, en direct comme à la mise à plat : les recouvrements foncent comme au crayon, sans marque à la jonction entre deux passes. Un virage franc qui ne repasse sur rien ne coupe pas. `passes="false"` revient à un trait d'un seul tenant (ses recouvrements ne comptent qu'une fois).

## Aplatissement progressif

Un trait plein s'aplatit pendant le geste : chaque passe, ou chaque tronçon d'une passe longue (au moins 48 points et 6 diamètres), est contouré et peint dans la carte d'aplats par tranches de quelques millisecondes dès qu'il est terminé. Au lever, il ne reste que le dernier morceau à calculer. Le résultat est le même que d'un bloc.

Tourner longtemps au même endroit avec un mode de fusion morcelle la carte en centaines de régions, et chaque passe coûte alors plus que la précédente. Au-delà d'un budget (un morceau de plus de 40 ms sur une carte de plus de 1 500 sommets), l'aplatissement s'arrête : le trait est gardé en empreintes, une par passe, pour que les recouvrements restent cumulés comme pendant le geste. Le tout fait une seule étape d'annulation. Un trait à pression variable (stylet) s'aplatit d'un bloc au lever, comme avant.

## Opacité

L'opacité est celle du trait entier, comme dans les logiciels de dessin : ses empreintes sont réunies à pleine force, puis le trait est posé (ou ôté, pour la gomme) à l'opacité du pinceau, avec son mode de fusion. Des empreintes qui se chevauchent ne foncent donc pas le trait ; seules les passes (voir plus haut) se cumulent. C'est vrai pendant le geste, à la mise à plat, au rendu des traits gardés en empreintes et à l'export SVG (groupe `opacity`). À opacité 0, un trait ne montre rien, quel que soit son mode.

Le mode de fusion se calcule contre ce qui est dessous : le fond (`background`) là où rien n'est dessiné. Sur un fond transparent, il n'y a rien avec quoi fusionner : la couleur est posée telle quelle (règle de composition standard).

## Fond et damier

`background` est la couleur du papier : ce qui n'est pas dessiné, ce que la gomme fait réapparaître, ce contre quoi se calculent les modes de fusion, et le fond des exports. `background="transparent"` : rien dessous (export PNG transparent, fusions posées telles quelles). `checker` dessine alors un damier sous le dessin, à l'écran seulement, pour voir ce qui est vide ou à moitié effacé : deux couleurs (`checker="#f4f1ea #e7e1d4"`) ou `true` ; `checker-size` en px d'écran (défaut 8). Les traits déjà aplatis gardent les couleurs calculées contre le fond de l'époque.

## Réglages et préférences

Le carnet (`persist`) garde aussi des réglages pris dans d'autres stores, en deux familles :

- `settings-from` : les **réglages du dessin** (fond, palette, guides, effets…). Ils sont enregistrés avec chaque dessin et remis en place quand on l'ouvre — donc aussi au rechargement de la page, qui rouvre le dernier dessin. Les changer rend le dessin « non enregistré ». Un nouveau dessin garde les réglages en cours.
- `prefs-from` : les **préférences de l'utilisateur** (pinceau, outil…), gardées d'une session à l'autre quel que soit le dessin ouvert (enregistrées peu après chaque changement, et à la fermeture de la page).

Syntaxe : une liste séparée par des espaces de `store` (tout son état) ou `store.clé1,clé2` (ces clés seulement, pour ne pas garder l'état d'interface d'un store, comme une modale ouverte). Exemple : `settings-from="harmonie fx fxVue.fond,gType,gSpacing"` `prefs-from="pinceau"`. Au chargement, les préférences sont posées d'abord, puis les réglages du dessin rouvert. Valeurs JSON simples, 64 Ko au plus par instantané.

### Échantillonner une palette

Commande `samplePalette` (compteur du DP `control`, avec `sampleCount`, défaut 6, 1..12) : les **couleurs dominantes** de la sélection s'il y en a une, sinon de tout le dessin — aplats pondérés par leur surface, traits non aplatis par leur encre (longueur × épaisseur²), masques et gomme ignorés —, sans la couleur du fond. Les couleurs voisines (OKLab) sont regroupées ; chaque groupe garde sa couleur réelle la plus présente. Résultat dans l'état `sampled { colors, from: selection|drawing }`, et en action `{ type: sample-action (défaut "sampled"), payload: { colors, from } }` vers le store `sample-to` : par exemple un réducteur qui range la palette dans une liste et l'active dans une `sonic-palette rule="custom"`.

**Exports envoyés à un store** : avec `export-to`, chaque export (`control.save` en SVG, `savePng` en PNG) part aussi en action `{ type: export-action (défaut "exported"), payload: { url, mime, width, height, size } }` vers ce store, au moment où le fichier est prêt. Un réducteur peut ainsi garder le fichier produit, par exemple comme fichier de sortie d'un artefact utilisé comme outil (`io.output.files`). Les URL `blob:` des quatre derniers exports restent valides : un SVG et un PNG demandés ensemble sont tous deux lisibles.

**Gestes rejoués** (`gestures-from`) : un DataProvider donne un jeu de traits, que la toile dessine un par un avec la même chaîne qu'un stylet. La pression, les pointes, l'opacité, les passes, les modes de fusion, l'aplatissement et la gomme se comportent comme à la main. Usage : un agent qui peint, une démonstration, un tutoriel.

```json
{ "width": 1000, "height": 1250, "strokes": [
  { "color": "#efe9e1", "size": 58, "hardness": 1, "pts": [300, 400, 1, 500, 380, 1, 700, 400, 1] },
  { "color": "#6e6286", "size": 90, "hardness": 0, "opacity": 0.2, "blend": "multiply", "pts": [700, 300, 0.4, 720, 600, 1] },
  { "size": 40, "pts": [650, 700, 0.3, 660, 800, 0.8] },
  { "reset": true, "tool": "erase", "size": 20, "pts": [500, 500, 1, 520, 520, 1] }
] }
```

- Coordonnées et `size` dans le cadre `width × height`, ajusté à 90 % de la toile et centré ; pression 0..1 par point (défaut 0.7, le diamètre suit la pression).
- Comme un peintre garde son pinceau en main, chaque trait reprend les réglages du précédent et ne donne que ceux qui changent ; `reset: true` repart des réglages par défaut. Les réglages de l'interface (`brush-from`) ne s'appliquent pas aux traits rejoués.
- Les points sont des points de passage reliés en courbe (Catmull-Rom) ; `curve: false` pour des segments droits.
- Un gros jeu se donne en **fichier** : le DP contient son URL (chaîne ou `{url}` ; `https:`, `blob:`, `data:application/json` ; 30 Mo max), par exemple un asset d'artefact ou l'état de `sonic-painterly`. Il est chargé puis joué (état `gestures.loading`, puis `playing`). `gestures-from` accepte plusieurs DP séparés par des espaces.
- Limites : 20 000 traits, 1 000 000 de points. Le jeu présent au branchement n'est pas rejoué ; un nouveau jeu interrompt celui en cours. La couche est redessinée par lots pendant le jeu. Une étape d'annulation par trait. L'état `gestures {playing, loading, done, total, truncated, error}` suit la progression.

Avec `sonic-palette`, l'attribut `write-base` écrit aussi la teinte tirée au hasard dans le store `params` : toute la palette tient alors dans ce store, qu'on peut mettre dans `settings-from`.

### Curseur-pinceau

`brush-cursor` : au-dessus de la toile, à la souris ou au stylet (survol compris), le curseur natif est remplacé par le **contour de l'empreinte** qui sera posée : forme de la pointe (`tip`), diamètre au zoom courant, angle, aplatissement (`roundness`) ; une petite croix quand l'empreinte fait moins de 6 px. Seulement pour le crayon et la gomme (pas la main, la pipette ni la sélection), jamais au tactile. Le contour est tracé sur la toile de la sélection, hors de l'image (ni export ni source d'images).

Quand une couche est posée sur la toile (ex. un `sonic-shader` d'effets qui la reprend en `channel0`), `style="--sketch-overlay-z: 2"` place la sélection et le curseur-pinceau au-dessus.

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


## Peindre une image : `sonic-painterly`

`sonic-painterly` peint **n'importe quelle image** au pinceau : il en tire un jeu de gestes que `sonic-sketch` rejoue avec ses vrais pinceaux. L'image peut être une photo, une image générée, un asset ou une caméra. Le résultat est un vrai dessin, retouchable trait par trait.

Trois manières de peindre (`paint-style`) :

- **`realiste`** (défaut) : on ne voit pas le pinceau. L'image est reconstruite par **touches posées** (une empreinte par trait), comme à l'aérographe : d'abord une grille de touches qui se recouvrent, du très gros au moyen (reconstruction lisse), puis des **glacis en Produit et en Écran** pour les valeurs, puis des touches de plus en plus fines, seulement là où l'écart reste fort. Chaque touche est **douce là où l'image est floue et nette là où elle est nette** (flou de profondeur gardé), ronde, ou **ovale et orientée** le long des arêtes. Près d'une arête nette, le pinceau rétrécit (pas de halo de part et d'autre d'un contour) ; sur une matière fine et orientée (herbe, poils), une touche filée suit le fil. Le budget va d'abord au **point focal** (contraste, couleur qui se distingue, centre, ou la zone `focus` donnée) : détail là où l'œil va, fond plus lâche. Enfin, chaque touche est **ajustée** (couleur, place, taille, orientation) tant que l'écart baisse (`optimizeMs`, 4 s par défaut). Le résultat est proche de l'image et reste un dessin retouchable touche à touche (5 000 touches par défaut, export SVG compris).
- **`illustration`** : l'image est construite en passes qui ont chacune un rôle et un outil, comme le ferait un illustrateur. Un fond net, puis les **masses** au pinceau plat (pointe ovale qui suit le geste), du très gros au moyen. Ensuite des **glacis doux en mode Produit** là où la toile est plus claire que l'image (ombres), puis **en mode Écran** là où elle est plus sombre (lumières), et des voiles translucides pour la couleur. Puis la **matière** (pointe craie dispersée, ou petits traits orientés sur un tissu, une herbe), quelques **détails** fins et opaques là où l'écart reste fort, des **contours** effilés en Produit sur les arêtes nettes et des **reflets** en Écran. La toile est simulée avec les mêmes fusions que `sonic-sketch` : chaque passe corrige ce que les précédentes ont laissé. Les traits suivent les formes (tenseur de structure) ; dans les zones sans forme nette (fonds, flous), la touche garde une direction constante. Quelques milliers de traits, export SVG compris.
- **`huile`** : touches opaques accumulées du gros au fin (« stroke-based rendering », d'après Hertzmann) ; pour chaque taille de pinceau, un trait part du point le plus faux, prend la couleur de l'image et suit les formes jusqu'au changement de couleur. Rendu d'empâtement, beaucoup plus de traits (trop d'empreintes pour l'export SVG au-delà de quelques milliers).

```json
{ "tagName": "sonic-still", "attributes": { "id": "photo", "in-data-provider": "fichier" } },
{ "tagName": "sonic-painterly", "attributes": { "source": "#photo", "auto": "", "detail": "0.7", "out-data-provider": "peintre" } },
{ "tagName": "sonic-sketch", "attributes": { "gestures-from": "peintre", "…": "…" } }
```

| Attribut | Rôle |
|---|---|
| `source` / `src-from` | Source d'images de la page (`#id`), ou DP d'une URL d'image (chaîne ou `{url}` : asset, `blob:`, `data:image`) |
| `paint-style` | `realiste` (défaut, touches fondues, proche de l'image), `illustration` (passes visibles avec les outils) ou `huile` (touches opaques accumulées) |
| `detail` | 0 (grosses touches) à 1 (très détaillé), défaut 0.6 |
| `max-side` | Côté de l'analyse en px (défaut 360) : plus grand = plus fin, plus de traits |
| `max-strokes` | Plafond de traits, 20 000 max ; par défaut celui de la manière : réaliste 5 000, illustration 3 000, huile 12 000. Le budget est toujours tenu : en réaliste, la base lisse passe d'abord, puis les touches fines vont là où l'écart est le plus fort |
| `params` | DP en direct : `{style, focus: {x, y, r} (0..1), optimizeMs, maxSide, detail, layers, threshold, maxLength, curvature, opacity, jitter, maxStrokes, seed, background}` |
| `auto` / `control` | Peint chaque nouvelle image, ou sur demande (`{paint}` compteur) |

État : `{status, error, url, width, height, strokes, layers, residual, ms, runs}`. `url` est le jeu de gestes en `blob:` : aucun gros volume ne transite par les DataProviders. Le calcul est aussi disponible en fonctions pures, `illustrateImage(pixels, options)` (`illustrate.ts`) et `paintImage(pixels, options)` (`painterly.ts`, huile), utilisables dans Node par un agent qui prépare un fichier de gestes.
