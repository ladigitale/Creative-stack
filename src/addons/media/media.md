# Media (SDUI)

Addon `@supersoniks/creative-stack/media` : caméra, lecteur vidéo, bouton d'invite, export vidéo et téléchargement. Chaque composant est piloté par DataProvider, publie son état, et sert de **source d'images** pour `sonic-shader channel0="#id"` (le shader de Concorde, sans modification). Le son d'une vidéo peut passer par le moteur audio partagé (addon `audio`) pour être analysé.

Le micro (`sonic-mic`) est dans l'addon `audio`.

## Règles communes

- **Aucune demande d'accès au chargement de la page.** Caméra et micro démarrent sur un clic (`sonic-media-start`, `sonic-audio-unlock start="…"`), au premier geste (`autostart`), ou sur pilotage (`active`, DP `control`).
- **État standard** publié dans `out-data-provider` (défaut `<id>State`) : `status` parmi `idle`, `requesting`, `ready`, `paused`, `denied`, `error`, `unsupported`, et `error` (message lisible : « accès à la caméra refusé », « aucune caméra trouvée »…). Afficher l'invite ou le message avec `sonic-if` / `sonic-value` sur cet état.
- **Compteurs** dans les DP de pilotage (comme `play` de `sonic-sound`) : `{ "snapshot": 4 }` déclenche une photo quand la valeur augmente ; la première valeur vue sert de référence.
- Pistes arrêtées et URL `blob:` libérées quand le composant est retiré de la page.

## Composants

| Tag | Rôle |
|---|---|
| `sonic-camera` | Caméra : aperçu, images pour les shaders, photos |
| `sonic-screen` | Capture d'écran : source d'images, photos, son du partage, export |
| `sonic-video` | Lecteur vidéo propriétaire de sa `<video>` |
| `sonic-frame-sync` | Resynchronise l'image et un résultat de tracker (image exacte analysée, ou retard fixe) |
| `sonic-luma` | Sonde de luminosité : niveaux et fronts allumé / éteint d'un signal lumineux, horodatés |
| `sonic-morse` | Morse par la lumière : émet un texte sur un booléen (torche), décode les fronts d'une `sonic-luma` |
| `sonic-media-start` | Bouton d'invite qui démarre caméra / micro / vidéo, affiche un refus |
| `sonic-media-recorder` | Export vidéo d'un shader, d'une caméra ou d'une vidéo, avec le son |
| `sonic-media-download` | Lien de téléchargement d'une prise, d'une photo ou d'un export |

## `sonic-camera`

```json
{ "tagName": "sonic-camera", "attributes": {
  "id": "cam", "hidden-preview": "", "control": "game.cam", "snapshot-provider": "gallery.channel0" } }
```

| Attribut | Rôle |
|---|---|
| `active`, `autostart` | Démarrer (attribut) / au premier geste |
| `facing` | `user` (avant, défaut) ou `environment` |
| `width` `height` `fps` | Résolution et cadence souhaitées (1280 × 720, 30) |
| `device-id` | Caméra précise (liste dans l'état : `devices`) |
| `mirror` | `auto` (défaut : miroir pour la caméra avant), `true`, `false` — s'applique à l'aperçu, aux images envoyées aux shaders et aux photos |
| `hidden-preview` | Pas d'aperçu : la caméra ne sert que de source |
| `fit` | `cover` (défaut) ou `contain` |
| `keep-running` | Ne pas couper la caméra quand l'onglet est caché (par défaut : coupée, relancée au retour, état `paused`) |
| `max-width` | Largeur max des images et photos (1280) |
| `snapshot-type`, `max-snapshots` | `jpeg` (défaut), `png`, `webp` ; photos gardées (8) |
| `snapshot-provider` | Chemin DP où écrire chaque photo (SonicMediaRef `{ url, width, height, mime }`) : par ex. `gallery.channel0` pour l'afficher dans un `sonic-shader dataProvider="gallery"` |
| `control` | DP : `{ active, facing, deviceId, snapshot: compteur }` |
| `adjust` | DP d'entrée des réglages de la piste (zoom, torche, focus…) — voir « Réglages de la caméra » |
| `capabilities-provider`, `settings-provider` | DP de sortie des capacités et des réglages (défauts `<id>Capabilities` et `<id>Settings`) |
| `ptz` | Demande aussi panoramique / inclinaison / zoom motorisés à l'ouverture (permission supplémentaire dans Chrome : seulement si nécessaire) |

État : `{ status, error, active, facing, width, height, deviceId, devices, snapshot: { url, width, height, mime } | null, snapshots }`.

Dans un shader : `channel0="#cam"` puis `texture(iChannel0, uv)`.

### Réglages de la caméra

Au-delà de la résolution et de la caméra choisie (attributs `width`, `height`, `fps`, `facing`, qui **redémarrent** le flux), la piste vidéo expose des réglages sans redémarrage : zoom, torche, mise au point, exposition, balance des blancs, image. Trois DataProviders, qui séparent *ce que la caméra sait faire* de *ce qu'on lui demande* :

| DP | Sens | Contenu |
|---|---|---|
| `<id>Capabilities` | sortie | Réglages pris en charge par la caméra ouverte |
| `adjust` (attribut) | entrée | Valeurs demandées |
| `<id>Settings` | sortie | Valeurs demandées (`desired`) et réellement appliquées (`applied`) |

**1. Lire les capacités avant d'écrire.** Les capacités n'existent qu'une fois la caméra ouverte (le navigateur ne les donne qu'après `getUserMedia`) ; avant, `status` vaut `unavailable`.

```json
{
  "status": "ready",
  "deviceId": "…",
  "ptz": false,
  "controls": {
    "zoom": { "key": "zoom", "kind": "range", "label": "Zoom", "unit": "×", "min": 1, "max": 5, "step": 0.1, "value": 1 },
    "torch": { "key": "torch", "kind": "boolean", "label": "Torche", "value": false },
    "focusMode": { "key": "focusMode", "kind": "enum", "label": "Mode de mise au point", "values": ["continuous", "manual"], "value": "continuous" }
  },
  "list": [ "…les mêmes descripteurs, en tableau (modes d'abord), pour une liste SDUI…" ],
  "unsupported": ["iso", "colorTemperature", "…"]
}
```

Chaque descripteur est un **schéma de contrôle** : `kind` (`range` → curseur avec `min`/`max`/`step`, `enum` → choix parmi `values`, `boolean` → interrupteur), `label` en français, `unit` éventuelle, `value` courante. Un réglage absent de `controls` n'existe pas sur cette caméra : ne pas l'afficher, ne pas le demander. Beaucoup de caméras n'en gèrent qu'une partie (ordinateur portable : souvent aucun ; téléphone : zoom, torche, mise au point).

| Clé | Type | Remarque |
|---|---|---|
| `zoom` | plage | Sur ordinateur, peut exiger `ptz` |
| `torch` | booléen | Lumière continue, pas un flash ; tant que le flux est ouvert |
| `focusMode`, `exposureMode`, `whiteBalanceMode` | énuméré | `continuous`, `manual`, `single-shot`, `none` selon la caméra |
| `focusDistance` (m), `exposureTime`, `exposureCompensation` (EV), `iso`, `colorTemperature` (K) | plage | Les valeurs « manuelles » demandent d'abord le mode `manual` correspondant |
| `brightness`, `contrast`, `saturation`, `sharpness` | plage | |
| `pan`, `tilt` | plage | Seulement avec l'attribut `ptz` et la permission accordée |

**2. Demander.** Le DP `adjust` reçoit un objet ; seules les clés présentes sont modifiées, `null` oublie une clé. Revenir en automatique : remettre le mode (`"focusMode": "continuous"`).

```json
{ "zoom": 2, "torch": true, "focusMode": "manual", "focusDistance": 0.4 }
```

- Nombres **bornés et alignés sur le pas** de la caméra ; énumérés et booléens vérifiés. Une valeur invalide ou un réglage absent produit un message dans `errors`, jamais d'exception.
- Les **modes passent avant les valeurs** (`focusMode` avant `focusDistance`), quel que soit l'ordre dans l'objet.
- Un réglage à la fois : si l'un est refusé, les autres passent. Les demandes qui s'enchaînent vite (curseur) sont regroupées, les valeurs intermédiaires sautées.
- Valeur présente dans le DP **avant** l'ouverture de la caméra (par ex. dans le `initial` d'un store) : mémorisée, bornée puis appliquée à l'ouverture. Après un changement de caméra (`facing`, `device-id`), les réglages demandés sont revérifiés sur la nouvelle : ceux qu'elle ne gère pas restent demandés avec un message dans `errors`.

**3. Lire le résultat.**

```json
{
  "desired": { "zoom": 2, "torch": true },
  "applied": { "zoom": 2, "torch": true },
  "pending": [],
  "errors": { "iso": "non pris en charge par cette caméra" }
}
```

**Lire `applied`, jamais `desired`** : le navigateur arrondit, ajuste ou refuse (« valeur refusée par la caméra »). `pending` liste les clés en cours d'application, `errors` un message par clé. Les bornes d'un réglage peuvent changer quand on en modifie un autre (mode manuel) : les capacités sont relues après chaque passe.

Le DP `adjust` s'alimente comme `control` : un chemin d'un store (`adjust="reglages.adj"`, avec un reducer qui met à jour `adj`, voir `control="miroir.cam"` dans `examples/miroir.sdui.json`) ou n'importe quel DataProvider.

Pour n'afficher les commandes qu'une fois la caméra prête : `sonic-if dataProvider="camCapabilities" key="status" equals="ready"`.

Limites à connaître :
- **Chrome / Chromium surtout** (Android en tête). Firefox et Safari exposent très peu, voire aucun de ces réglages ; la torche n'est pas disponible dans Safari sur iPhone. Toujours se fonder sur `controls`, pas sur le navigateur. Comportements décrits d'après la spécification et l'usage courant, **à confirmer sur les appareils visés**.
- Une webcam d'ordinateur n'expose souvent que luminosité, contraste, saturation et netteté, parfois zoom et mise au point.
- La torche s'éteint avec le flux (arrêt, onglet caché sans `keep-running`, changement de caméra) et revient à la réouverture si elle est toujours demandée.
- Une caméra ne s'ouvre qu'une fois à la fois : deux `sonic-camera` sur le même appareil se disputent le flux.
- La photo (`takeSnapshot`) reprend l'image du flux affiché. Les réglages propres à la prise de vue (`ImageCapture` : flash, résolution du capteur) ne sont pas encore pilotables.

## `sonic-screen`

```json
{ "tagName": "sonic-screen", "attributes": { "id": "screen", "hidden-preview": "", "audio": "", "control": "game.screen" } }
```

Le navigateur n'ouvre le partage que dans un **clic direct** : `sonic-media-start for="screen"` (ou un bouton dont le reducer met `control.active` à vrai). L'utilisateur choisit l'écran, la fenêtre ou l'onglet ; il peut arrêter à tout moment depuis la barre du navigateur (état `idle`, `error: "partage arrêté"`). Le partage continue quand la page passe en arrière-plan (c'est le but). Pas disponible sur mobile (`unsupported`).

| Attribut | Rôle |
|---|---|
| `audio` | Demander aussi le son (onglet, ou écran entier sous Windows / ChromeOS) : `getAudioOutput()` pour `sonic-audio-analyser source="#screen"`, un enregistreur ; jamais envoyé vers le master (écho) |
| `surface` | Suggestion : `monitor`, `window`, `browser` |
| `cursor` | `always` (défaut), `motion`, `never` |
| `allow-self` | Proposer l'onglet de la page elle-même (effet miroir infini) |
| `fps` (30), `max-width` (1920) | Cadence ; largeur max des images et photos |
| `fit`, `hidden-preview` | `contain` (défaut) ou `cover` ; pas d'aperçu |
| `snapshot-type`, `max-snapshots`, `snapshot-provider` | Photos comme `sonic-camera` |
| `control` | DP : `{ active, snapshot: compteur }` |

État : `{ status, error, active, surface, width, height, audio, snapshot, snapshots }`. Dans un shader : `channel0="#screen"`. Export : `sonic-media-recorder video-source="#screen" audio-source="#screen"`.

## `sonic-video`

```json
{ "tagName": "sonic-video", "attributes": {
  "id": "clip", "src": "https://exemple.org/clip.webm", "loop": "", "audio-out": "master", "control": "game.player" } }
```

| Attribut | Rôle |
|---|---|
| `src` | URL https, relative, `blob:` ou `data:video/` |
| `src-provider` | DP contenant la source (URL ou SonicMediaRef) : prioritaire sur `src` |
| `autoplay`, `loop`, `muted`, `controls` | Comme `<video>` |
| `preload` | `auto`, `metadata`, ou `blob` (télécharge tout le fichier : utile quand l'hébergeur ne permet pas de se déplacer dans la vidéo) |
| `crossorigin` | `anonymous` (défaut, requis pour les shaders et l'analyse d'une vidéo d'un autre site), `use-credentials`, `none` |
| `rate`, `volume` | Vitesse (0.0625–16), volume (0–1) |
| `loop-start`, `loop-end` | Boucle A–B en secondes |
| `audio-out` | Vide : son joué normalement. `master` ou `#id` : passe par le moteur audio (analysable par `sonic-audio-analyser source="#clip"`). `none` : analysable mais muet |
| `fit`, `hidden-preview` | Affichage (`contain` par défaut) ; pas d'aperçu (source seulement) |
| `update-rate` | Publications du temps par seconde (10) |
| `control` | DP : `{ playing, seek, rate, volume, muted, loop, loopStart, loopEnd }` |

- `seek` : un nombre (chaque changement déplace la lecture) ou `{ "t": 12, "n": 3 }` (chaque hausse de `n` déplace vers `t`, même si `t` ne change pas). Première valeur vue = référence.
- **Lecture automatique** : si le navigateur refuse la lecture avec son avant un geste, la vidéo démarre muette (`status: "needs-gesture"`) et le son revient au premier geste. `sonic-media-start for="clip"` fait office de bouton « Lancer ».

État : `{ status: idle | loading | ready | playing | paused | ended | needs-gesture | error, error, src, playing, ended, timeS, durationS, progress, rate, volume, muted, width, height }`.

Dans un shader : `channel0="#clip"`. Le shader ne pilote jamais la vidéo (il lit seulement ses images).

## `sonic-frame-sync` : image et effet alignés

**Problème.** Un tracker (visage, mains…) rend son résultat 30 à 150 ms après avoir pris l'image. Si un shader dessine l'effet (renard, déformation…) sur l'image *courante* de la caméra, l'effet est en retard sur la vidéo. Remède : afficher la vidéo **telle qu'elle était quand le tracker l'a analysée**.

**Principe.** Chaque tracker publie l'identité de l'image analysée (`frameSeq`, voir `vision.md`). `sonic-frame-sync` garde les `history` dernières images de la source dans un tampon et expose celle dont le numéro correspond. C'est une source d'images (`getFrameCanvas()` + `frameSeq`) : `sonic-shader channel0="#synced"`.

```json
[
  { "tagName": "sonic-camera", "attributes": { "id": "cam", "hidden-preview": "", "mirror": "true", "max-width": "960" } },
  { "tagName": "sonic-face-tracker", "attributes": { "id": "face", "for": "cam", "load": "auto", "mirror": "true", "smooth": "0" } },
  { "tagName": "sonic-frame-sync", "attributes": { "id": "synced", "for": "cam", "sync": "face", "out-data-provider": "syncState" } },
  { "tagName": "sonic-shader", "attributes": { "channel0": "#synced", "dataProvider": "face", "image": "…" } }
]
```

Le shader lit `#synced` (pas `#cam`) et les valeurs du tracker (`param0..3` via `map`, voir `shader.md`) : les deux viennent de la même image.

### Les trois modes

| Mode | Réglage | Comportement | Quand |
|---|---|---|---|
| `sync` | `sync="<DP de sortie du tracker>"` | Image exacte (`frameSeq`). Si le tracker ne publie plus depuis `stale-ms` (600) : retard = dernière latence mesurée, sinon direct | Cas normal avec un tracker |
| `delay` | `delay-ms="120"` | Image prise il y a N ms | Source sans numéro d'image, ou latence connue et stable |
| `live` | rien | Dernière image, aucun tampon utile | Désactiver sans retirer le composant |

`mode="auto"` (défaut) choisit : `sync` si `sync` est renseigné, sinon `delay` si `delay-ms` > 0, sinon `live`. `mode="sync|delay|live"` force.

### Attributs

| Attribut | Rôle | Défaut |
|---|---|---|
| `for` | `#id` de la source (`sonic-camera`, `sonic-video`, `sonic-screen`) : **la même que celle du tracker** | – |
| `sync` | DP de sortie du tracker (son `outputProvider`, souvent son `id`) | – |
| `mode` | `auto`, `sync`, `delay`, `live` | `auto` |
| `delay-ms` | Retard fixe (mode `delay`) | `0` |
| `history` | Images gardées (2–120). Au moins `latence × fps + 2` : 150 ms à 30 fps → 7 | `12` |
| `max-width` | Largeur max des copies (mémoire) ; 0 = taille de la source | `0` |
| `stale-ms` | Silence du tracker toléré en mode `sync` | `600` |
| `hold` | `true` : fige l'image affichée (la plus récente au moment du gel) et `frameSeq` | `false` |
| `control` | DP de commande `{ hold: boolean, source: "#id", delayMs, mode }` (un store) ; `hold` prime sur l'attribut, `source` sur `for` (passer de la caméra à une image envoyée sans doubler les trackers ; vide ou absent : `for`), `delayMs` (0..5000) sur `delay-ms`, `mode` (`auto`, `sync`, `delay`, `live`) sur `mode` ; clé absente ou invalide : l'attribut | – |
| `snapshot-provider` | DP où publier l'image figée à chaque gel : `{ url (blob:, PNG), width, height, mime }`, `null` à la levée. Entrée d'un modèle d'image (`sonic-hugging-face-infer inputProvider="<chemin>.url"`, carte de profondeur) | – |
| `out-data-provider` | DP d'état | – |

État publié : `{ mode, matched, seq, delayMs, trackerSeq, filled }`. `mode` = mode réellement utilisé (peut passer de `sync` à `delay`/`live` en repli), `matched` = l'image montrée est exactement celle du tracker, `delayMs` = âge de l'image montrée par rapport à la plus récente.

### À savoir

- **Miroir.** Le miroir de la caméra s'applique aux images du tampon. Le tracker lit la vidéo non retournée : mettre `mirror="true"` sur le tracker **et** sur la caméra, pour que les coordonnées publiées collent à l'image affichée. Ne pas retourner une seconde fois dans le shader.
- **Coût.** Une copie canvas par image de la source (pas par image affichée) ; `max-width` et `history` bornent la mémoire (960 × 540 × 4 o × 12 ≈ 25 Mo).
- **Retard visible.** La vidéo affichée a la latence du tracker (souvent 50–120 ms). C'est le prix de l'alignement exact ; en mode `live` la vidéo est fluide mais l'effet traîne.
- **Précision.** `frameSeq` est le compteur de la source au moment où le tracker lit l'image : au pire un écart d'une image si la source en présente une nouvelle pile à cet instant.
- **Plusieurs trackers.** Une instance de `sonic-frame-sync` par tracker ; un seul sert de référence à un même shader.
- **Diagnostic.** `matched: false` en mode `sync` = l'image du tracker n'est plus dans le tampon (augmenter `history`) ou la source de `for` n'est pas celle du tracker.
- **Une photo (figer image et résultats)** : `sonic-frame-sync id="held" for="cam" mode="live" control="app"`, puis les trackers et les remplacements de masque lisent `held` (`for="held"`). Quand le store publie `{ hold: true }`, l'image et `frameSeq` se figent : les trackers n'ont plus de nouvelle image et gardent leur dernier résultat (pose, masque). La caméra reste active ; lever le gel reprend le direct. **Image envoyée au lieu de la caméra** : un `sonic-still id="photo"` (rempli par `sonic-file-open`) et `{ source: "#photo" }` dans le même store ; trackers et découpage suivent sans changement. Les copies de `held` sont des canvas : un tracker les lit sans retourner x (si la caméra est en miroir, l'image l'est déjà : `mirror="false"` sur le tracker).
- **Pas de frameSeq ?** (source qui n'est pas un composant Media) → `delay-ms` avec la `latencyMs` du tracker (`statusProvider` ou sortie).

## `sonic-luma` : sonde de luminosité

Mesure, image par image, la luminosité d'une source d'images et détecte les fronts allumé / éteint d'un signal lumineux : une lampe, la torche d'un autre téléphone, un écran qui clignote. Invisible ; tout passe par les DataProviders.

```json
{ "tagName": "sonic-camera", "attributes": { "id": "cam", "facing": "environment", "autostart": true, "adjust": "reglages" } },
{ "tagName": "sonic-luma", "attributes": { "id": "sonde", "source": "#cam", "target": "jeu", "mark-from": "reglages.torch" } }
```

### Mesure

- `level` : luminosité moyenne de la zone (0..1) ; `peak` : point le plus clair, à `peakX` / `peakY` (0..1 dans la zone).
- `measure="mean"` (défaut) pilote la détection par la moyenne : scène entière, reflet sur un mur. `measure="peak"` par le point le plus clair : lampe lointaine qui n'occupe que quelques pixels.
- `region="x,y,w,h"` restreint l'analyse à une zone de l'image (0..1). `resolution` : largeur de la grille d'analyse (64 par défaut ; monter pour une lampe très petite).

### Fronts

- Seuil automatique : à mi-chemin entre le niveau sombre (`lo`) et le niveau clair (`hi`) observés, avec hystérésis. Les deux niveaux s'oublient en `adapt-ms` (5 s) : la détection suit les dérives lentes (exposition automatique, jour qui tombe). `threshold="0.5"` impose un seuil fixe.
- Aucun front tant que l'écart `hi − lo` reste sous `min-contrast` (`signal: false`).
- `detect="jump"` remplace le seuil par la recherche de **sauts brusques** : un front est un changement d'au moins `jump-ratio` (0,4) fois le plus grand saut récent, survenu en `jump-ms` (120 ms). À choisir dès qu'un éclat dure plus de quelques dixièmes de seconde (morse) : l'exposition automatique de la caméra assombrit l'image pendant l'éclat, parfois jusqu'au niveau d'avant, et un seuil coupe alors l'éclat trop tôt. `max-on-ms` émet l'extinction d'office si elle a été manquée.
- Chaque front : `{n, on, t, dur, level, sinceMark, markGap}`. `t` est en ms sur l'horloge de `performance.now()`, interpolé entre deux images ; `dur` est la durée de l'état qui vient de se terminer (la durée de l'éclat pour un front `on: false`, celle du silence pour un front `on: true`).
- `clock` dit d'où viennent les instants : `capture` (instant de prise de vue, donné par `sonic-camera` quand le navigateur le fournit), `frame` (présentation de l'image, en retard de la chaîne vidéo), `poll` (source sans horodatage, relevée à chaque rafraîchissement). La résolution est d'une image : `1000 / fps` ms.
- `target="store"` : une action par front, `{type: "edge", payload: {…front, fps, clock}}` (`type` change le nom). L'état garde les `max-events` derniers dans `events`.

### Délai commande → lumière

`mark-from` désigne un booléen de DataProvider qui commande la lumière, typiquement la clé `torch` du DP `adjust` d'une `sonic-camera`. À chaque bascule, la sonde note l'instant ; le front suivant de même sens porte `sinceMark` (ms entre l'ordre et la lumière vue) et `markGap` (durée commandée de l'état qui se termine). Une commande ne sert qu'à un front : un front sans commande a `sinceMark: null`.

### Pilotage

- `params` : réglages en direct, prioritaires sur les attributs : `{active, measure, region, resolution, detect, threshold, minContrast, adaptMs, hysteresis, jumpMs, jumpRatio, maxOnMs, interval}` (`active: false` met la mesure en pause, `threshold: "auto"` revient au seuil automatique).
- `control` : `{reset: compteur}`, une hausse remet à zéro niveaux observés, fronts et commandes en attente.
- Sortie (`out-data-provider`, défaut `<id>State`) : `{status, error, active, level, peak, peakX, peakY, lo, hi, contrast, signal, on, edges, last, events, fps, clock, settings}`. Les niveaux sont publiés toutes les `interval` ms (100), les fronts tout de suite. Événement DOM `luma-edge`.

### À savoir

- **Exposition automatique.** Une caméra compense une lumière qui s'allume : l'image s'assombrit en quelques dixièmes de seconde. Le seuil (`detect="level"`) ne le supporte que pour des éclats courts ; au-delà, passer en `detect="jump"`, ou verrouiller l'exposition par `adjust` (`exposureMode: "manual"`, `exposureTime` court) quand la caméra le permet.
- **Dans le noir**, la caméra allonge la pose et la cadence tombe : lire `fps`.
- **Toute source d'images convient** (`sonic-video`, `sonic-screen`, `sonic-shader`…), mais seule `sonic-camera` donne l'instant de capture.

## `sonic-morse` : morse par la lumière

Émet un texte en morse sur un booléen de DataProvider, et décode les fronts vus par une `sonic-luma`. Avec la torche et la caméra d'un téléphone : un chat sans réseau entre deux appareils face à face. Invisible.

```json
{ "tagName": "sonic-camera", "attributes": { "id": "cam", "facing": "environment", "autostart": true, "adjust": "lampe" } },
{ "tagName": "sonic-luma", "attributes": { "id": "sonde", "source": "#cam", "detect": "jump", "max-on-ms": "3000" } },
{ "tagName": "sonic-morse", "attributes": { "id": "morse", "unit": "300", "drive": "lampe.torch", "text-from": "chat.outgoing", "send-from": "chat.txN", "source": "sondeState", "target": "chat" } }
```

### Émission

- `text-from` : chemin du texte ; `send-from` : chemin d'un compteur. Chaque hausse du compteur émet le texte (le réducteur écrit le texte et incrémente le compteur dans la même action). Les messages s'enchaînent en file.
- `drive` : chemin du booléen allumé / éteint. `lampe.torch` avec `adjust="lampe"` sur la caméra pilote la torche ; les autres clés de `lampe` sont conservées.
- `unit` : durée du point en ms. Trait = 3 unités, silence entre lettres = 3, entre mots = 7. Mesuré sur un téléphone : une torche ne tient guère d'éclat sous 250 ms et s'allume environ 400 ms après l'ordre (retard constant, sans effet sur le code) ; 300 ms est un bon défaut, soit 4 mots par minute.
- `trim` : ms retirés à chaque éclat et ajoutés au silence suivant, pour une lampe qui reste allumée plus longtemps que commandé.
- Le texte est ramené aux caractères du code : majuscules, accents retirés, le reste ôté.

### Réception

- `source` : le DP d'état d'une `sonic-luma` (`sondeState`). Mettre la sonde en `detect="jump"`.
- Un éclat de moins de 2 unités est un point, sinon un trait ; un silence de 2 unités clôt la lettre, de 5 le mot, de `end-units` (12) le message.
- `auto-unit` : l'unité se cale sur les éclats observés dès que points et traits ont été vus ; sinon les deux appareils doivent avoir le même `unit`.
- La réception est coupée pendant l'émission et `guard-ms` (1500) après : la lampe éclaire aussi la scène que filme sa propre caméra, et son extinction est vue avec du retard. Un éclat n'est compté que si son allumage a été vu hors de cette période. L'échange est donc à l'alternat.
- **Signal de début** : chaque message émis commence par un éclat de `start-units` unités (5 par défaut, plus long qu'un trait) suivi d'un silence de lettre. En réception, rien n'est décodé tant que ce signal n'a pas été vu, et `status` passe à `receiving` dès qu'il l'est : une lampe qu'on allume, un reflet ou un passage devant la caméra ne deviennent pas un message. Même valeur sur les deux appareils ; `start-units="0"` le retire.
- Un message de moins de `min-chars` caractères (2) est écarté et compté dans `dropped`.

### Sorties

- Actions vers `target` : `{type: "morse:sent", payload: {text}}` à la fin d'une émission, `{type: "morse:message", payload: {text, unit}}` à la fin d'un message reçu.
- État (`out-data-provider`, défaut `<id>State`) : `{status: idle|sending|receiving, on, tx: {text, signs, done, rest, chars, total, progress, percent, queue}, rx: {text, signs, unit}, lastReceived, lastSent, sent, received, dropped, settings}`. `rx.text` et `rx.signs` suivent le message en cours de réception.
- Progression de l'émission : `tx.done` est la partie du texte déjà émise, `tx.rest` ce qui reste, `tx.percent` l'avancement de 0 à 100 (pour un `sonic-progress` : `sonic-jsonata` qui publie `{value: $input.tx.percent, max: 100}`).
- `params` : `{codec, unit, trim, autoUnit, endUnits, guardMs, minChars, startUnits}` en direct. `control` : `{cancel: compteur}` arrête l'émission et vide la file. Événements DOM `morse-sent`, `morse-message`.

### Code rapide (`codec="fast"`)

Le morse ne code que dans les éclats ; les silences ne font que séparer. Le code rapide fait porter de l'information à chaque intervalle, allumé ou éteint, de 1, 2 ou 3 unités :

- Un arbre de code unique, calé sur les fréquences du français, couvre les caractères, la fin de message et une **table de phrases** : « OUI », « CA VA ? », « J'ARRIVE » sont un seul symbole. `phrases` (tableau JSON de textes, ou de couples `[texte, poids]`) remplace la table par défaut ; elle doit être identique sur les deux appareils.
- Message : éclat de début (`start-units`), silence de 3 unités qui **étalonne** le récepteur (il suit un émetteur d'une autre unité), symboles, fin de message, 3 chiffres de contrôle en base 3 (calculés sur les symboles et l'empreinte de la table). Si le dernier intervalle est un silence, un éclat d'une unité le referme.
- Le message est livré dès qu'il est complet : pas de silence de `end-units` à attendre. Un contrôle faux, un front manqué, une durée illisible ou un silence en plein message rejettent le message (`errors`) ; un message venu d'une autre table de phrases est rejeté de même au lieu d'être mal lu.
- Même `codec`, `unit` et `start-units` des deux côtés ; `start-units="0"` n'est pas permis (le signal de début est l'étalonnage). Un récepteur rapide ignore un message morse et inversement.
- Durées à `unit=300`, attente de fin de message du morse comprise : « oui » 15 s en morse, 9 s en rapide ; « ca va ? » 26 s contre 9 s ; « salut ca va ? » 41 s contre 11 s ; texte libre « je suis devant la porte » 61 s contre 43 s. Le gros du gain vient des phrases ; l'en-tête (début, étalonnage, fin, contrôle) pèse sur les messages très courts. `unit=250` gagne encore un sixième.
- État : `codec`, `tx.signs` (durées en chiffres), `rx.text` (lecture provisoire, valable une fois le message livré), `errors`.

## `sonic-media-start`

```json
{ "tagName": "sonic-media-start", "attributes": { "for": "cam mic", "label": "Activer la caméra" } }
```

Bouton (contenu libre en slot) qui démarre les éléments listés dans `for` (caméra, micro, vidéo) : la demande d'accès part d'un clic. Caché quand toutes les cibles sont prêtes (`persist` pour le garder) ; affiche le message en cas de refus.

## `sonic-media-recorder`

```json
{ "tagName": "sonic-media-recorder", "attributes": {
  "id": "export", "video-source": "#viz", "audio-source": "master", "control": "game.export", "max-s": "30" } }
```

| Attribut | Rôle |
|---|---|
| `video-source` | `#id` d'une source d'images : `sonic-shader`, `sonic-camera`, `sonic-video` (tout ce qui sert de `channel0`) |
| `audio-source` | `master` (défaut : ce qu'on entend), `#id` d'une source audio, `none` |
| `fps` (30), `bits-per-second` (4 000 000) | Cadence et débit vidéo |
| `max-s` (20), `max-takes` (4) | Durée max d'un export ; exports gardés en mémoire |
| `take-provider` | Chemin DP où écrire chaque export |
| `control` | DP : `{ recording: true | false }` |

Export = SonicMediaRef `{ url, mime, durS, size, width, height }` (WebM VP9/Opus, MP4 sur Safari ; la durée est écrite dans le fichier). État : `{ status: idle | waiting-source | ready | recording | error | unsupported, error, recording, elapsedS, last, takes }`. L'export filme le canvas tel qu'affiché (taille du `sonic-shader` dans la page).

## `sonic-media-download`

```json
{ "tagName": "sonic-media-download", "attributes": { "source": "exportState.last", "filename": "ma-creation" }, "nodes": [ { "tagName": "sonic-value", "attributes": { "dataProvider": "t", "key": "download" } } ] }
```

Lien `<a download>` vers le SonicMediaRef lu dans `source` (`exportState.last`, `recState.last`, `camState.snapshot`…). Seules les URL `blob:` créées dans la page sont acceptées. Caché tant qu'il n'y a rien ; contenu libre en slot (sinon `label`) ; extension déduite du format (`.webm`, `.mp4`, `.m4a`, `.jpg`…).

`auto` : aucun lien affiché ; chaque **nouveau** média publié dans `source` est téléchargé aussitôt (pas celui déjà présent au branchement). Pour un bouton « Télécharger » qui produit puis télécharge : le bouton déclenche la production (`save` d'un `sonic-shader`, `savePng` d'un `sonic-sketch`…) et un `sonic-media-download auto` branché sur l'état de sortie envoie le fichier dès qu'il est prêt.

`wait` : comme `auto`, mais seulement pour le média demandé par un clic sur le contenu du composant (son slot, le bouton). Utile quand plusieurs boutons déclenchent la même production : « Télécharger » (`sonic-media-download wait`) et « Partager » (`sonic-share wait`, addon device) ne partent chacun que pour leur propre clic.

## `sonic-still` (image fixe)

```json
{ "tagName": "sonic-still", "attributes": { "id": "photo", "src": "/img/portrait.jpg", "drop": true, "max-size": 2048 } }
```

Image fixe vue comme une source d'images : `sonic-shader channel0="#photo"`, trackers de vision (`for="#photo"`), vectorisation, OCR. Sources : `src` (https, `blob:`, `data:image`, chemin relatif), dépôt d'un fichier (`drop`), ou `in-data-provider` portant un SonicMediaRef / une URL. Une image https doit autoriser CORS pour rester analysable. `ref-provider` reçoit le SonicMediaRef de l'image chargée. `max-size` (défaut 4096) : côté long au-delà duquel l'image est réduite. `vector-size` : un SVG (`data:image/svg+xml`, `.svg` ou type déclaré) est pixellisé à ce côté long (plafonné par `max-size`) au lieu de sa taille nominale, pour rester net affiché en grand (plan d'un `sonic-anchor-view`, plein écran). État : `{ status: idle | loading | ready | error, error, src, width, height, mime }`.

## `sonic-file-open`

```json
{ "tagName": "sonic-file-open", "attributes": { "accept": "image/*", "ref-provider": "fichier", "label": "Choisir une image" } }
```

Ouvre un fichier du disque (clic, ou dépôt avec `drop`) — ou, avec `capture="environment"` (caméra arrière) ou `"user"`, l'appareil photo du téléphone directement (pas de capacité `camera` à déclarer : c'est le système qui prend la photo ; sans effet sur ordinateur) — et le publie en SonicMediaRef `{ url (blob:), blob, mime, width, height }` dans `ref-provider` : à brancher sur `sonic-still in-data-provider`, un lecteur audio, etc. Les fichiers texte (CSV, JSON) exposent leur contenu dans l'état (`text`, limité par `max-text`). État : `{ name, size, mime, kind: image | audio | video | text | other, text, files, error }`.

## Démos

- `examples/miroir.sdui.json` : caméra (au clic) → shader à 4 effets choisis par le store ; photo par compteur, affichée encadrée dans un second shader via `snapshot-provider`.
- Sampler de poche (addon `audio`, `examples/sampler-de-poche.sdui.json`) : export du visuel avec le son et téléchargement.
- `examples/clip-reactif.sdui.json` : `sonic-video` → moteur audio → analyseur ; le shader lit l'image (`#clip`) et le spectre (`#spectre`) : zoom et décalage des couleurs sur la grosse caisse. Lecture, boucle et vitesse pilotées par le store.

## Plateforme (viewer Artefacts)

Le document déclare ce qu'il utilise : `"capabilities": ["camera", "microphone", "midi", "screen"]`. Le viewer refuse un `sonic-camera` / `sonic-mic` / `sonic-midi` / `sonic-screen` non déclaré, et l'en-tête `Permissions-Policy` doit autoriser `camera=(self)`, `microphone=(self)`, `midi=(self)` et `display-capture=(self)`.
