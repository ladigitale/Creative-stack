# Vision (SDUI)

Addon `@supersoniks/creative-stack/vision` : suivi temps réel par des modèles ML qui **tournent sur l'appareil** (aucune image n'est envoyée). Les résultats sont publiés en DataProvider, avec des clés plates et stables, directement lisibles par `sonic-param`, `sonic-if`, `sonic-value`, `sonic-stage`, `sonic-shader` et `sonic-jsonata`.

Premier composant : `sonic-hand-tracker`. D'autres (visage, corps, segmentation…) suivront le même contrat.

## Règles communes

- **Source d'images par `for`** : l'id d'un `sonic-camera` ou `sonic-video` (le tracker lit leur `<video>` natif, sans copie, ou à défaut leur canvas).
- **Modèle = donnée.** `model` est un **alias** (toujours de confiance) ou une **URL https**. Le runtime (MediaPipe tasks-vision) est épinglé et chargé à la demande ; seul lui exécute du code. Le modèle est téléchargé par le composant (plafond de taille, progression, `model-sha256` vérifié s'il est donné) puis passé au moteur : rien n'est lu par le runtime avant ces contrôles.
- **Niveaux de confiance** (`configureMl` côté app hôte) :

  | Niveau | Source | Consentement |
  |---|---|---|
  | alias | `hand-landmarker`, `gesture-recognizer`, ou alias ajoutés par l'hôte | aucun |
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
| `left.gesture`, `left.gestureScore` | `Closed_Fist`, `Open_Palm`, `Pointing_Up`, `Thumb_Down`, `Thumb_Up`, `Victory`, `ILoveYou` (vide sinon) |
| `hands.N.role`, `.score`, `.label`, `.gesture` | Chaque main vue |
| `hands.N.landmarks.I.x/y/z` | 21 points, miroir appliqué, non lissés |
| `hands.N.world.I.x/y/z` | 21 points en mètres centrés sur la main |

Une main seule garde son rôle quand elle traverse le centre ; deux mains : la plus à gauche est `left`. Quand une main disparaît plus longtemps que `hold-ms`, `present` passe à 0 et les autres valeurs gardent leur dernière valeur (utile pour tenir une note).

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
- Seuils de `openness` et `pinch` empiriques.
- Le modèle est téléchargé par le composant : un hôte dont la CSP interdit `connect-src` vers l'origine du modèle doit l'autoriser (ou servir le modèle lui-même).

## Exemple

`examples/theremin-deux-mains.sdui.json` : main droite = hauteur, main gauche = volume, sans calibration.
