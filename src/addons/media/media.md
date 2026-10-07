# Media (SDUI)

Addon `@supersoniks/creative-stack/media` : caméra, lecteur vidéo et bouton d'invite. Chaque composant est piloté par DataProvider, publie son état, et sert de **source d'images** pour `sonic-shader channel0="#id"` (le shader de Concorde, sans modification). Le son d'une vidéo peut passer par le moteur audio partagé (addon `audio`) pour être analysé.

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
| `sonic-video` | Lecteur vidéo propriétaire de sa `<video>` |
| `sonic-media-start` | Bouton d'invite qui démarre caméra / micro / vidéo, affiche un refus |

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

État : `{ status, error, active, facing, width, height, deviceId, devices, snapshot: { url, width, height, mime } | null, snapshots }`.

Dans un shader : `channel0="#cam"` puis `texture(iChannel0, uv)`.

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

## Démos

- `examples/miroir.sdui.json` : caméra (au clic) → shader à 4 effets choisis par le store ; photo par compteur, affichée encadrée dans un second shader via `snapshot-provider`.
- `examples/clip-reactif.sdui.json` : `sonic-video` → moteur audio → analyseur ; le shader lit l'image (`#clip`) et le spectre (`#spectre`) : zoom et décalage des couleurs sur la grosse caisse. Lecture, boucle et vitesse pilotées par le store.

## Plateforme (viewer Artefacts)

Le document déclare ce qu'il utilise : `"capabilities": ["camera"]`, `["microphone"]`. Le viewer refuse un `sonic-camera` / `sonic-mic` non déclaré et l'en-tête `Permissions-Policy` doit autoriser `camera=(self)` et `microphone=(self)`.
