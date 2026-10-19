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

## Démos

- `examples/miroir.sdui.json` : caméra (au clic) → shader à 4 effets choisis par le store ; photo par compteur, affichée encadrée dans un second shader via `snapshot-provider`.
- Sampler de poche (addon `audio`, `examples/sampler-de-poche.sdui.json`) : export du visuel avec le son et téléchargement.
- `examples/clip-reactif.sdui.json` : `sonic-video` → moteur audio → analyseur ; le shader lit l'image (`#clip`) et le spectre (`#spectre`) : zoom et décalage des couleurs sur la grosse caisse. Lecture, boucle et vitesse pilotées par le store.

## Plateforme (viewer Artefacts)

Le document déclare ce qu'il utilise : `"capabilities": ["camera", "microphone", "midi", "screen"]`. Le viewer refuse un `sonic-camera` / `sonic-mic` / `sonic-midi` / `sonic-screen` non déclaré, et l'en-tête `Permissions-Policy` doit autoriser `camera=(self)`, `microphone=(self)`, `midi=(self)` et `display-capture=(self)`.
