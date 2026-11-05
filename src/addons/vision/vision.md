# Vision (SDUI)

Addon `@supersoniks/creative-stack/vision` : suivi temps réel par des modèles ML qui **tournent sur l'appareil** (aucune image n'est envoyée). Les résultats sont publiés en DataProvider, avec des clés plates et stables, directement lisibles par `sonic-param`, `sonic-if`, `sonic-value`, `sonic-stage`, `sonic-shader` et `sonic-jsonata`.

Composants : `sonic-hand-tracker` (mains), `sonic-face-tracker` (visage), `sonic-pose-tracker` (corps), `sonic-object-detector` (objets), `sonic-segmenter` (silhouette), `sonic-example-classifier` (gestes appris par l'utilisateur), `sonic-landmarks-overlay` pour dessiner leurs sorties, `sonic-face-mesh` pour greffer un visage sur le visage suivi, et `sonic-mask-replace` pour remplacer le fond ou un objet détecté, `sonic-image-embedder` pour l'empreinte numérique d'une image ou d'un objet. Ils partagent le même contrat (source `for`, modèle, confiance, consentement, worker, statut, `map`) via `SonicMlTracker` ; les suivants (segmentation, détection…) s'y brancheront de la même façon.

## Règles communes

- **Source d'images par `for`** : l'id d'un `sonic-camera` ou `sonic-video` (le tracker lit leur `<video>` natif, sans copie, ou à défaut leur canvas).
- **Modèle = donnée.** `model` est un **alias** (toujours de confiance) ou une **URL https**. Le runtime (MediaPipe tasks-vision) est épinglé et chargé à la demande ; seul lui exécute du code. Le modèle est téléchargé par le composant (plafond de taille, progression, `model-sha256` vérifié s'il est donné) puis passé au moteur : rien n'est lu par le runtime avant ces contrôles.
- **Niveaux de confiance** (`configureMl` côté app hôte) :

  | Niveau | Source | Consentement |
  |---|---|---|
  | alias | `hand-landmarker`, `gesture-recognizer`, `face-landmarker`, `pose-landmarker` (léger), `pose-landmarker-full`, `pose-landmarker-heavy`, `object-detector`, `selfie-segmenter`, ou alias ajoutés par l'hôte | aucun |
  | `origins` (défaut) | URL dans une origine approuvée (`storage.googleapis.com/mediapipe-models/`, `huggingface.co`, `cdn.jsdelivr.net` par défaut, plus `capabilities.ml` de l'artefact) | par origine, mémorisé |
  | `open` | toute URL https | par modèle, mémorisé |

  Une URL hors origines approuvées est refusée (`error.code = "origin-not-allowed"`) tant que l'hôte n'est pas en niveau `open`. Les URL `http:`, `data:` ou avec identifiants sont toujours refusées.
- **Statut** dans `status-provider` (défaut `<id>State`) : `phase` parmi `idle`, `awaiting-consent`, `declined`, `downloading`, `loading`, `ready`, `error`, `unsupported`, plus `error {code, message}` (`origin-not-allowed`, `too-large`, `hash-mismatch`, `download-failed`, `load-failed`, `detect-failed`, `invalid-map`…), `backend` (`gpu` / `cpu`), `thread` (`worker` / `main`), `download {loaded, total}`, `fps`, `latencyMs`, `model {url, origin}`, `consent {key, origin, url}`.
- **Consentement** : en `awaiting-consent`, afficher une `sonic-modal` avec `consent.origin` et un bouton qui écrit `accepted` ou `declined` dans le DP de `consent-provider`. La réponse est mémorisée (localStorage, clé `concorde-ml-consent:…`).
- **Chargement** (`load`) : `first-use` (défaut, au premier cadre disponible), `auto`, `idle`, `manual` (`loadModel()`).

## `sonic-hand-tracker`

```json
{ "tagName": "sonic-hand-tracker", "attributes": {
  "id": "hand", "for": "cam", "smooth": "0.6", "hold-ms": "200",
  "map": "cents=clamp(right.x,0,1)*3600; gain=left.present ? 0.5*(1-clamp(left.y,0,1)) : 0" } }
```

### Attributs

| Attribut | Rôle | Défaut |
|---|---|---|
| `for` | Id de la source d'images | requis |
| `model` | Alias ou URL https | `gesture-recognizer` (`hand-landmarker` si `gestures="false"`) |
| `model-sha256` | Empreinte attendue du modèle (hex, `sha256-` accepté) ; refus si elle diffère | aucune |
| `thread` | `auto` : worker puis repli sur le fil principal ; `worker` : sans repli ; `main` : jamais de worker | `auto` |
| `engine` | `mediapipe`. Un autre moteur se fournit par `configureVision({ createEngine })` | `mediapipe` |
| `max-hands` | 1 ou 2 | `2` |
| `fps` | Cadence max d'inférence | `30` |
| `delegate` | `gpu`, `cpu`, `auto` (GPU puis repli CPU) | `auto` |
| `mirror` | `auto` : miroir seulement pour la source native ; `true` / `false` forcent | `auto` |
| `smooth` | Lissage One Euro 0..1 (0 = aucun) ; s'applique aux métriques, pas aux points | `0.5` |
| `hold-ms` | Main perdue : dernière valeur gardée (`present` 1) pendant cette durée | `150` |
| `min-score` | Seuil de confiance | `0.5` |
| `gestures` | `"false"` : points seuls, sans geste | `true` |
| `map` | Clés dérivées calculées dans le composant, sans latence | aucun |
| `outputProvider` | DP de sortie | l'id de l'élément |
| `statusProvider` | DP du statut | `<id>State` |
| `consentProvider` | DP de la réponse de consentement | aucun |
| `load` | `first-use`, `auto`, `idle`, `manual` | `first-use` |

### Sortie

Repère **écran** (après miroir) : `left` est la main qui apparaît à gauche de l'écran. Coordonnées normalisées 0..1, origine en haut à gauche.

| Clé | Contenu |
|---|---|
| `count` | Mains vues dans l'image |
| `left.present`, `right.present` | `1` suivie (ou maintenue par `hold-ms`), sinon `0` |
| `left.x`, `.y`, `.z` | Centre de la paume ; `z` relatif |
| `left.tipX`, `.tipY` | Bout de l'index |
| `left.pinch` | 0 écartés, 1 pouce et index qui se touchent |
| `left.openness` | 0 poing, 1 doigts tendus |
| `left.roll` | 0,5 main verticale ; 0 / 1 penchée à gauche / à droite |
| `left.thumb`, `.index`, `.middle`, `.ring`, `.pinky` | Ouverture de **chaque doigt** : 0 replié, 1 tendu (moyenne des angles de ses deux articulations ; indépendante de la position, de la rotation et de la distance) |
| `left.fingerCount` | Nombre de doigts tendus, 0 à 5 (un doigt compte au-dessus de 0,55) : les chiffres montrés avec les doigts |
| `left.pinchMiddle`, `.pinchRing`, `.pinchPinky` | Comme `pinch`, entre le pouce et le majeur / l'annulaire / l'auriculaire (0 écartés, 1 bouts qui se touchent) |
| `left.spread` | 0 doigts serrés, 1 doigts écartés |
| `left.gesture`, `left.gestureScore` | `Closed_Fist`, `Open_Palm`, `Pointing_Up`, `Thumb_Down`, `Thumb_Up`, `Victory`, `ILoveYou` (vide sinon) |
| `hands.N.role`, `.score`, `.label`, `.gesture` | Chaque main vue |
| `hands.N.landmarks.I.x/y/z` | 21 points, miroir appliqué, non lissés |
| `hands.N.world.I.x/y/z` | 21 points en mètres centrés sur la main |

Les mesures de doigts sont calculées sur les points en mètres (`world`) quand le modèle les fournit, sinon sur les points image. Les bornes (doigts : 95° replié → 165° tendu ; pouce : 130° → 165° ; écartement : 0,2 → 0,65 de la taille de la paume) sont **empiriques** : elles n'ont été vérifiées que sur des mains synthétiques, pas sur du matériel réel. Mesure en 3D mais fiabilité moindre quand la main est vue de profil, et le pouce est le doigt le plus difficile.

Une main seule garde son rôle quand elle traverse le centre ; deux mains : la plus à gauche est `left`. Quand une main disparaît plus longtemps que `hold-ms`, `present` passe à 0 et les autres valeurs gardent leur dernière valeur (utile pour tenir une note).

### Identité de l'image analysée (tous les trackers)

Chaque sortie contient aussi, à la racine :

| Clé | Contenu |
|---|---|
| `frameSeq` | `frameSeq` de la source à l'instant où l'image a été lue (null si la source n'en a pas) |
| `frameTime` | `currentTime` de la vidéo pour cette image (s) ; null pour une source canvas |
| `capturedAt` | `performance.now()` (ms) au début de l'analyse |
| `latencyMs` | Durée de l'analyse (lecture de l'image → résultat), ms |

C'est ce qui permet à `sonic-frame-sync` (addon media) d'afficher l'image exacte que le tracker a analysée : voir `media.md`. Ces clés ne sont pas lissées et sont publiées à chaque analyse (même sans visage).

### `map`

`clé=expression; clé=expression`, évaluées sur la sortie avant publication, sans `eval` : nombres, chemins (`right.x`), `+ - * / %`, comparaisons, `&& || !`, `?:`, parenthèses et `min max abs clamp mix pow sqrt floor round log2 sign`. Chemin absent = 0, booléen = 1 / 0. Les clés peuvent être pointées (`play.cents`) ; `__proto__`, `constructor`, `prototype` sont refusés. Une erreur de syntaxe est publiée dans le statut (`error.code = "invalid-map"`).

Sans `map`, on passe par `sonic-jsonata` (debounce de 50 ms) : suffisant pour l'affichage, plus lent pour jouer.

### Configuration (app hôte)

```ts
import { configureMl } from "@supersoniks/creative-stack/vision";
import { configureVision } from "@supersoniks/creative-stack/vision";

configureMl({ level: "origins", origins: ["https://mon-cdn.example/modeles/"] });
configureVision({ mediapipeBundleUrl: "…/vision_bundle.mjs", mediapipeWasmUrl: "…/wasm" });
```

CSP : `script-src` et `connect-src` pour l'URL du bundle MediaPipe, `connect-src` pour les modèles, `'wasm-unsafe-eval'`.

### Worker et repli

Par défaut l'inférence tourne dans un **worker classique** (blob) : le fil principal reste libre pour l'audio, les shaders et l'interface. Chaque image est transférée en `ImageBitmap` (sans copie) ; une seule détection est en cours à la fois, les images reçues entre-temps sont sautées (la latence reste d'un aller-retour, jamais d'une file d'attente). Si le worker est impossible (pas d'`OffscreenCanvas`, CSP sans `worker-src blob:`, WASM ou GPU indisponible, initialisation trop longue), `thread="auto"` bascule sur le fil principal et `thread` du statut vaut `main`.

`configureVision({ createWorker })` permet à l'hôte de servir lui-même le script du worker (CSP stricte) ; `WORKER_SOURCE` est exporté pour cela.

### Limites actuelles

- Le chargement réel de MediaPipe depuis le CDN et le suivi sur une vraie caméra n'ont pas été testés (les tests couvrent le protocole du worker, le repli, le téléchargement, les contrôles de confiance et la logique de suivi avec des mains synthétiques).
- Attribution gauche/droite d'une main **seule** à l'apparition : d'après l'étiquette du modèle puis la moitié d'écran ; non vérifiée sur matériel réel.
- Seuils de `openness` et `pinch` empiriques ; `yaw` / `pitch` / `roll` du visage et `lean` / `raise*` du corps sont des estimations géométriques, pas des mesures 3D.
- Segmentation et détection : API `ImageSegmenter` / `ObjectDetector` de MediaPipe 0.10.21 utilisée d'après sa documentation, non exécutée ici ; le choix du masque « personne » quand le modèle en fournit deux (`mask-index=auto` prend le dernier) est à vérifier sur le vrai modèle.
- Côtés gauche/droite du visage (clignements) et du corps : convention « écran » déduite de l'image miroir ; non vérifiée sur matériel réel.
- Le modèle est téléchargé par le composant : un hôte dont la CSP interdit `connect-src` vers l'origine du modèle doit l'autoriser (ou servir le modèle lui-même).

## `sonic-face-tracker`

```json
{ "tagName": "sonic-face-tracker", "attributes": {
  "id": "face", "for": "cam", "smooth": "0.6",
  "map": "cut=300+mouthOpen*5000; gain=present ? 0.4 : 0" } }
```

Mêmes attributs communs que `sonic-hand-tracker` (`for`, `model`, `model-sha256`, `thread`, `fps`, `delegate`, `mirror`, `smooth`, `hold-ms`, `min-score`, `map`, `outputProvider`, `statusProvider`, `consentProvider`, `load`), plus :

| Attribut | Rôle | Défaut |
|---|---|---|
| `max-faces` | 1 ou 2 | `1` |
| `landmarks` | `"true"` : publie aussi les 478 points de chaque visage (`faces.N.landmarks`). Lourd | `false` |

Modèle par défaut : alias `face-landmarker`. Sortie (premier visage, repère écran, miroir appliqué) :

| Clé | Contenu |
|---|---|
| `present`, `count` | `1` si un visage est suivi (ou maintenu par `hold-ms`) ; nombre de visages vus |
| `x`, `y`, `z` | Bout du nez, 0..1 |
| `size` | Largeur du visage (joue à joue) relative à l'image : proxy de distance |
| `yaw`, `pitch`, `roll` | Orientation de la tête, -1..1 (estimée d'après les points, sans matrice 3D) : `yaw` > 0 visage tourné vers la droite de l'écran, `pitch` > 0 tête baissée, `roll` > 0 oreille vers la droite de l'écran |
| `mouthOpen`, `smile`, `pucker`, `browUp`, `browDown` | Expressions 0..1 (d'après `jawOpen`, `mouthSmile*`, `mouthPucker`, `browInnerUp` / `browOuterUp*`, `browDown*`) |
| `blinkLeft`, `blinkRight` | Clignements 0..1, côtés **écran** (échangés si l'image n'est pas en miroir) |
| `gazeX`, `gazeY` | Regard, -1..1 (> 0 : vers la droite de l'écran / vers le haut) |
| `blend.<nom>` | Les 52 blendshapes MediaPipe bruts (`jawOpen`, `eyeBlinkLeft`, …), noms du sujet |
| `faces.N.blend` | Idem pour chaque visage |

## `sonic-pose-tracker`

```json
{ "tagName": "sonic-pose-tracker", "attributes": {
  "id": "body", "for": "cam", "smooth": "0.6",
  "map": "cents=raiseRight*3600; gain=present ? 0.5*raiseLeft : 0" } }
```

Attributs communs, plus `max-poses` (1 à 4, défaut `1`). Modèle par défaut : `pose-landmarker` (léger) ; `pose-landmarker-full` et `pose-landmarker-heavy` plus précis, plus lents. Sortie (premier corps, côtés **écran** : `leftWrist` est le poignet du côté gauche de l'écran) :

| Clé | Contenu |
|---|---|
| `present`, `count` | `1` si un corps est suivi (ou maintenu) ; nombre de corps vus |
| `x`, `y` | Centre des hanches |
| `raiseLeft`, `raiseRight` | Hauteur du poignet : hanche ≈ 0, épaule 0,5, une longueur de buste au-dessus de l'épaule 1 |
| `span` | Écart entre les poignets / largeur d'épaules (bras écartés ≈ 3 à 4) |
| `lean` | Inclinaison du buste, -1..1 (> 0 : épaules vers la droite de l'écran) |
| `elbowLeft`, `elbowRight`, `kneeLeft`, `kneeRight` | Extension de l'articulation : 0 très fléchie (≤ 45°), 1 tendue (180°). Calculée sur les points en mètres (`world`) quand ils existent |
| `squat` | 0 jambes tendues, 1 très fléchi (moyenne de la flexion des genoux) |
| `joints.<nom>.x/y/z/v` | 33 points (`nose`, `leftShoulder`, `rightWrist`, `leftFootIndex`…) ; `v` = visibilité 0..1 |
| `poses.N.landmarks.I.x/y/z` | Les 33 points de chaque corps |

Aucun des deux ne demande de calibration. Les côtés gauche/droite ne sont pas vérifiés sur matériel réel (voir limites).

## `sonic-object-detector`

```json
{ "tagName": "sonic-object-detector", "attributes": {
  "id": "obj", "for": "cam", "categories": "person,cup", "min-score": "0.45", "hold-ms": "300" } }
```

Détecte des objets (80 classes COCO : personne, tasse, téléphone, chaise…). Attributs communs, plus `max-results` (1 à 20, défaut `5`) et `categories` (liste blanche d'étiquettes séparées par des virgules). `smooth` est sans effet sans `track` (pas d'identité entre images). Modèle par défaut : `object-detector` (EfficientDet-Lite0). Sortie, repère écran, boîtes 0..1 :

| Clé | Contenu |
|---|---|
| `present`, `count` | `1` si au moins un objet (ou maintenu par `hold-ms`) ; nombre d'objets |
| `label`, `score`, `x`, `y`, `w`, `h`, `cx`, `cy` | Meilleur objet (score le plus haut) |
| `labels.<étiquette>` | Nombre d'objets par étiquette (minuscules, `_` pour les séparateurs : `labels.cell_phone`) |
| `objects.N.label/score/x/y/w/h/cx/cy` | Tous les objets, du meilleur au moins bon |
| `id`, `ageMs`, `ids`, `objects.N.id/ageMs` | Seulement avec `track="true"` : identité de l'objet entre images (1, 2, 3…, jamais réutilisée), durée depuis son apparition, `id` des objets dans l'ordre de `objects` |

**Identité entre images (`track="true"`)** : chaque boîte reçoit l'`id` de la boîte de même étiquette qui la recouvre le plus à l'image précédente (`track-iou`, `0.3` par défaut) ; un objet qui disparaît garde son `id` `track-max-age-ms` (`500`) et le retrouve s'il revient au même endroit. `smooth` lisse alors la boîte de chaque objet. Appariement simple par recouvrement : fiable pour quelques objets qui bougent peu entre deux images, il confond deux objets de même étiquette qui se croisent et ne réidentifie pas un objet revenu ailleurs. Un autre composant suit un objet précis avec son `id` : `sonic-mask-replace object-id`, `sonic-image-embedder crop-id`. Voir `examples/suivre-objet.sdui.json`.

## `sonic-segmenter`

```json
[ { "tagName": "sonic-segmenter", "attributes": { "id": "seg", "for": "cam" } },
  { "tagName": "sonic-shader", "attributes": { "channel0": "#cam", "channel1": "#seg", "image": "…" } } ]
```

Segmente la personne (modèle `selfie-segmenter` par défaut). Le masque est une **source d'images** (même contrat que `sonic-camera`) : un `sonic-shader` le lit par `channelN="#seg"`, sans passer par un DataProvider ni encoder d'image. Attributs communs, plus :

| Attribut | Rôle | Défaut |
|---|---|---|
| `mode` | `gray` : r = g = b = masque, alpha 255 ; `alpha` : blanc, alpha = masque (à composer) | `gray` |
| `invert` | `"true"` : fond au lieu de la personne | `false` |
| `threshold` | Seuil 0..1 des statistiques | `0.5` |
| `mask-index` | Masque à utiliser si le modèle en fournit plusieurs : `auto` (le dernier si plusieurs) ou un indice | `auto` |

Le masque est dessiné en repère écran (miroir appliqué comme pour les autres trackers) ; l'image de la caméra lue par le shader, elle, n'est pas retournée si elle vient de la vidéo native : retourner `x` dans le shader (`1.-uv.x`) avec `mirror="false"` sur la caméra. Sortie : `present`, `coverage` (part de l'image), `cx`, `cy`, `x0`, `y0`, `x1`, `y1` (centre et boîte, lissés).

## `sonic-mask-replace`

```json
[ { "tagName": "sonic-segmenter", "attributes": { "id": "seg", "for": "cam", "mode": "alpha" } },
  { "tagName": "sonic-frame-sync", "attributes": { "id": "synced", "for": "cam", "sync": "seg" } },
  { "tagName": "sonic-mask-replace", "attributes": {
    "source": "synced", "mask": "seg", "mirror": "false", "effect": "blur", "amount": "0.6" } } ]
```

Remplace une zone de l'image avec un masque, sans écrire de shader : le **fond derrière la personne** (`mask` = un `sonic-segmenter`) ou les **objets détectés** (`detections` = la sortie d'un `sonic-object-detector`). Les deux se combinent (la zone est leur réunion). Le composant est lui-même une source d'images (`getFrameCanvas`) : un `sonic-shader` ou un autre `sonic-mask-replace` peut le lire.

| Attribut | Rôle | Défaut |
|---|---|---|
| `source` | Id de l'image à modifier (`sonic-camera`, `sonic-frame-sync`) | requis |
| `mask` | Id d'un `sonic-segmenter` (masque `alpha` ou `gray`) | aucun |
| `detections` | DataProvider de la sortie d'un `sonic-object-detector` | aucun |
| `object-id` | `id` d'un `sonic-object-detector track="true"` : seul cet objet est retenu ; `0` : tous | `0` |
| `labels`, `min-score`, `max-objects` | Objets retenus : étiquettes (virgules, `cell phone` ou `cell_phone`), score minimal, nombre maximal (les meilleurs) | toutes, `0.4`, `5` |
| `shape`, `pad` | Forme du masque d'un objet (`ellipse` ou `rect`) et marge autour de sa boîte (part de sa taille) | `ellipse`, `0.05` |
| `target` | `background` : garde la zone masquée, remplace le reste (fond virtuel) ; `subject` : remplace la zone masquée | `background` |
| `effect` | `blur`, `pixelate`, `color`, `image`, `source` (autre source d'images), `cutout` (zone remplacée transparente) | `blur` |
| `amount` | Force du flou ou de la pixellisation, 0..1 | `0.5` |
| `color` | Couleur CSS de `effect="color"` (hexadécimal, `rgb()`, `hsl()` ou nom) | `#101820` |
| `image` | URL de `effect="image"` (https, `blob:`, `data:image`, relative) ; recadrée pour remplir | aucune |
| `with-source` | Id de la source d'images de `effect="source"` (vidéo, shader, canvas) ; absente : repli en flou | aucune |
| `feather` | Adoucissement des bords du masque, 0 (net) à 1 | `0.3` |
| `smooth` | Lissage du masque dans le temps, 0 à 0,9 | `0.4` |
| `mirror` | `auto` (retourne une vidéo native, pas un canvas déjà dessiné), `true`, `false` | `auto` |
| `fps`, `width`, `height` | Images par seconde au plus ; taille du canvas quand il n'y a pas de source | `30`, 640 × 480 |
| `crop` | `true` (avec `target="background"`) : l'image produite est recadrée sur la zone gardée, avec `effect="cutout"` un sprite à fond transparent | `false` |
| `out-data-provider` | `{ready, effect, target, mask, regions, box, error}` ; `box` = `{x, y, w, h, cx, cy}` de la zone gardée (0..1 de l'image, lissée, `null` si rien) | — |

**Récupérer la personne (ou un objet) pour la recomposer** : `effect="cutout"` + `target="background"` donne la personne sur fond transparent (un objet détecté seul : `detections` sans `mask`). Le résultat se place ensuite avec l'existant, sans composant de plus : `sonic-sprite shape="image" source="#personne"` dans un `sonic-2d` (calques, parallaxe, `nodes`, caméra, physique) ; la copie, le reflet, l'échelle ou la rotation sont d'autres sprites ou des `nodes`. Sans `crop`, le sprite garde la position de la personne dans l'image (stable) ; avec `crop`, il est serré sur sa boîte (la taille de l'image change donc d'une image à l'autre : le sprite tient dans `w` × `h`, à placer avec `box.cx`/`box.cy`). `box` sert aussi à faire suivre la personne par un autre élément (store, reducer). Voir `examples/recomposition.sdui.json`.

Avec `sonic-frame-sync` (`sync` = le segmenteur ou le détecteur), l'image est celle qui a été analysée : le masque colle au corps même quand il bouge (sans cela il retarde d'une inférence). Si la source de masque n'a encore rien produit, l'image passe telle quelle (pas de clignotement) ; sans personne dans l'image, `target="background"` remplace tout le fond. Les bords du masque sont fondus et lissés en canvas 2D : c'est un effet de présentation, pas une découpe nette au pixel. Le calcul reste sur l'appareil.

## `sonic-image-embedder`

```json
[ { "tagName": "sonic-object-detector", "attributes": { "id": "obj", "for": "cam" } },
  { "tagName": "sonic-image-embedder", "attributes": { "id": "emb", "for": "cam", "crop": "obj", "reference": "refEmb" } } ]
```

Calcule l'**empreinte numérique** d'une image (MobileNet V3 par défaut, un vecteur d'environ 1 024 nombres) : deux images qui se ressemblent donnent des vecteurs proches. On s'en sert pour reconnaître « ce qui est dans l'image » sans l'avoir nommé à l'avance : comparer à une référence (`similarity`), ou apprendre des classes d'objets avec `sonic-example-classifier features="embed"`. Attributs communs ; cadence par défaut **5 images / s** (`fps`), `smooth` `0.3`, `hold-ms` `300`.

| Attribut | Rôle | Défaut |
|---|---|---|
| `reference` | DataProvider d'un vecteur de comparaison : un tableau, ou la sortie d'un autre embedder (`{vector}`) → `similarity` | aucun |
| `crop` | DataProvider de la sortie d'un `sonic-object-detector` : seule la meilleure boîte retenue est analysée ; sans boîte, rien n'est analysé (`present` 0) | image entière |
| `crop-labels`, `crop-min-score`, `crop-pad` | Étiquettes retenues (virgules), score minimal, marge autour de la boîte (part de sa taille) | toutes, `0.4`, `0.1` |
| `crop-id` | `id` d'un détecteur en `track="true"` : analyse cet objet précis, pas le meilleur ; absent : rien n'est analysé | `0` (meilleure boîte) |
| `region` | Zone fixe `x,y,w,h` (0..1 de l'image, repère écran) ; ignorée si `crop` est renseigné | aucune |
| `head` | Tête du modèle dont on lit le vecteur | `0` |
| `mirror` | Comme le détecteur de `crop` : mettre la même valeur aux deux (une zone en repère écran est retournée vers l'image brute) | `auto` |

| Clé | Contenu |
|---|---|
| `present`, `dim` | `1` si une empreinte existe (ou maintenue par `hold-ms`) ; nombre de valeurs |
| `vector` | Vecteur unitaire (norme 2 = 1), 4 décimales, lissé par `smooth` |
| `norm` | Norme du vecteur brut du modèle |
| `similarity` | Cosinus (-1..1) avec `reference` ; `0` sans référence ou si les dimensions diffèrent |

Limites : le modèle par défaut est petit et généraliste (ImageNet) : il distingue bien des objets courants, mal des différences fines (deux visages, deux tasses semblables). Un objet recadré trop petit (moins de 8 pixels) n'est pas analysé. `similarity` est relative à une référence et à un modèle donnés : ne pas comparer des vecteurs de modèles différents. Voir `examples/mes-objets.sdui.json` : apprendre ses propres objets (détecteur → embedder → classifieur).

## `sonic-example-classifier`

```json
{ "tagName": "sonic-example-classifier", "attributes": {
  "id": "gesture", "source": "hand", "control": "learn", "storage": "mes-gestes" } }
```

Apprend à reconnaître des **poses de main, de corps ou des expressions de visage à partir d'exemples** que l'utilisateur enregistre (k plus proches voisins) : pas de modèle, pas de réseau, tout est local. Branché sur la sortie d'un tracker (`source`). Les mains et le corps sont comparés relativement au poignet / aux hanches et à leur taille : un geste appris est reconnu où que la main soit dans l'image et à n'importe quelle distance.

Pilotage par le DataProvider `control` (typiquement un `sonic-store`) : `label` (étiquette courante), `record` (compteur : une hausse enregistre `samples` exemples sous `label`), `clear` (compteur : efface `label`, ou tout si `label` est vide), `clearAll` (compteur : efface tout). La première valeur vue sert de référence : rien ne s'enregistre au chargement.

| Attribut | Rôle | Défaut |
|---|---|---|
| `source` | DataProvider de sortie d'un tracker | requis |
| `features` | `auto` (d'après les clés), `hand`, `pose`, `face` (blendshapes), `embed` (vecteur d'un `sonic-image-embedder` : objets, scènes) | `auto` |
| `hand` | `any`, `left`, `right` (côté écran) | `any` |
| `control` | DataProvider de pilotage | aucun |
| `outputProvider` | DataProvider de sortie | l'id |
| `k` | Voisins du vote | `3` |
| `samples` | Exemples pris par enregistrement | `20` |
| `sample-ms` | Écart minimal entre deux exemples | `50` |
| `window` | Dernières prédictions votant pour l'étiquette stable | `5` |
| `min-confidence` | Confiance minimale pour afficher une étiquette | `0.6` |
| `max-distance` | Distance maximale au plus proche exemple, 0 = sans limite | `0` |
| `storage` | Clé de mémoire locale (`localStorage`) des exemples ; vide = pas de sauvegarde | aucune |

Sortie : `present`, `label` (stable, vide sans exemples ni confiance), `raw` (dernière image, sans lissage), `confidence`, `scores.<étiquette>`, `match.<étiquette>` (1 pour l'étiquette stable, utile à `sonic-if`), `counts.<étiquette>`, `total`, `recording`, `recordingLabel`, `samplesLeft`. Les étiquettes servent de clés en minuscules (`_` pour les séparateurs). Un enregistrement dont la dimension ne correspond pas aux exemples existants (autre type de source) s'arrête sans rien ajouter.

## `sonic-landmarks-overlay`

```json
{ "tagName": "sonic-landmarks-overlay", "attributes": {
  "source": "hand", "background": "cam", "color": "#f2b45c", "color2": "#5cc8f2" } }
```

Dessine sur un canvas la sortie d'un tracker : points et squelette des mains, squelette du corps, contours et points du visage (le tracker doit publier `landmarks="true"`), boîtes étiquetées des objets. Pensé comme **panneau séparé** (rien ne se superpose à la vue de jeu ou de caméra) et comme mode de réglage : on y juge `smooth`, `min-score`, `thread`. Aucun HTML n'est injecté.

| Attribut | Rôle | Défaut |
|---|---|---|
| `source` | DataProvider de sortie du tracker (son `outputProvider`, ou son id) | requis |
| `kind` | `auto` (d'après les clés), `hands`, `face`, `pose`, `objects` | `auto` |
| `background` | Id d'une source d'images (`sonic-camera`, `sonic-segmenter`) redessinée dessous | aucun |
| `mirror` | Miroir de l'image de fond : `auto` (retournée si la source est une vidéo native), `true`, `false` | `auto` |
| `width`, `height` | Taille du canvas sans image de fond | 640 × 480 |
| `fill` | Couleur de fond | transparent |
| `color`, `color2` | Gauche / premier ; droite / suivants | `#f2b45c`, `#5cc8f2` |
| `line-width`, `point-radius` | Trait et points | 3, 4 |
| `points`, `bones` | `"false"` les masque | `true` |

## `sonic-face-mesh`

```json
{ "tagName": "sonic-face-tracker", "attributes": { "id": "face", "for": "cam", "max-faces": "2", "landmarks": "true", "mirror": "true", "smooth": "0" } },
{ "tagName": "sonic-frame-sync", "attributes": { "id": "synced", "for": "cam", "sync": "face" } },
{ "tagName": "sonic-face-mesh", "attributes": { "source": "face", "background": "synced", "mirror": "false" } }
```

Greffe un visage sur le visage suivi : les 468 points du tracker forment un maillage de 880 triangles, dessiné en WebGL avec une texture et déformé comme le visage (pose, bouche, yeux). La couleur de la texture est ramenée vers celle de la peau cible (`color-match`) et les bords sont estompés (`feather`) pour que la greffe se fonde dans l'image. Le tracker doit publier `landmarks="true"` ; pour une greffe synchrone avec l'image, afficher `sonic-frame-sync` (`sync` = DataProvider du tracker) en `background`.

Trois façons de fournir la texture :

| Mode | Réglage | Effet |
|---|---|---|
| échange (défaut) | `background` + `max-faces="2"` côté tracker | avec deux visages, chacun prend le visage de l'autre, lu dans la même image ; avec un seul, rien n'est greffé |
| portrait | `texture-source="#img"` (source d'images) + `texture-landmarks` (DataProvider d'un second `sonic-face-tracker` qui analyse cette image, `landmarks="true"`) | le premier visage de l'image de référence est plaqué sur le visage suivi |
| à plat | `texture="https://…"` | l'image est dessinée à plat sur le modèle canonique de visage MediaPipe (masques, peintures) : même disposition que la texture UV de MediaPipe Face Mesh |

| Attribut | Rôle | Défaut |
|---|---|---|
| `source` | DataProvider de sortie du tracker (son `outputProvider`, ou son id) | requis |
| `background` | Id d'une source d'images (`sonic-camera`, `sonic-frame-sync`) dessinée dessous ; vide : seul le visage greffé est dessiné, fond transparent | aucun |
| `texture`, `texture-source`, `texture-landmarks` | Voir les modes | aucun |
| `mirror` | Retournement des images : `auto` (retourne une vidéo native, pas un canvas déjà dessiné), `true`, `false`. Avec une caméra `mirror="true"` et `sonic-frame-sync`, mettre `false` | `auto` |
| `face` | `all`, `0` ou `1` : quels visages reçoivent la greffe | `all` |
| `feather` | Largeur du fondu des bords en anneaux de triangles (0 = bords nets) | 6 |
| `color-match` | Correction de couleur vers la peau cible, 0 à 1 | 0,8 |
| `opacity` | Opacité de la greffe, 0 à 1 | 1 |
| `width`, `height` | Taille du canvas sans image de fond | 640 × 480 |
| `out-data-provider` | Publie `{ready, mode, faces, drawn, error}` (`mode` : `swap`, `portrait`, `canonical`, `none`) | aucun |

Le composant est lui-même une source d'images (`getFrameCanvas`, `frameSeq`) : on peut le brancher dans `sonic-shader channel0="#id"`. La correction de couleur est ignorée si l'image vient d'une autre origine (canvas « teinté »). Les textures passent par le même filtre d'URL que les autres médias (https, `blob:`, `data:image`, relatif). Aucun HTML n'est injecté et tout se calcule sur l'appareil. Limites : maillage 2D appliqué à plat (pas de relief ni d'éclairage, donc de profil la greffe se déforme), pas de réglage des yeux ni de la bouche à l'intérieur de la texture, et la ressemblance vient de la texture, pas d'un modèle neuronal. À n'utiliser qu'avec des visages dont les personnes sont d'accord.

## Exemples

- `examples/theremin-deux-mains.sdui.json` : main droite = hauteur, main gauche = volume.
- `examples/synthe-visage.sdui.json` : hocher la tête = hauteur, ouvrir la bouche = filtre.
- `examples/theremin-corps.sdui.json` : bras droit levé = hauteur, bras gauche levé = volume.
- `examples/controle-mains-panneau.sdui.json` : caméra + squelette des mains dans un panneau séparé.
- `examples/silhouette.sdui.json` : silhouette lue par un shader.
- `examples/detecteur-objets.sdui.json` : boîtes d'objets dans un panneau séparé.
- `examples/mes-gestes.sdui.json` : apprendre ses propres gestes (A, B, C) et les reconnaître.
- `examples/fond-virtuel.sdui.json` : fond flouté derrière la personne.
- `examples/masquer-objet.sdui.json` : téléphone, tasse et livre pixellisés dans l'image.
- `examples/recomposition.sdui.json` : la personne découpée, replacée en sprite (et son reflet) dans une scène `sonic-2d`.
- `examples/mes-objets.sdui.json` : apprendre ses propres objets (détecteur, empreinte de la boîte, classifieur).
- `examples/suivre-objet.sdui.json` : chaque objet garde son numéro ; celui qu'on choisit est pixellisé.
- `examples/echange-visages.sdui.json` : à deux devant la caméra, chacun porte le visage de l'autre.
