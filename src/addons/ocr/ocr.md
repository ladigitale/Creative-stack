# Addon `ocr` — lire le texte d'une image

`sonic-ocr` lit le texte d'une image : fichier ouvert (`sonic-file-open` + `sonic-still`), photo, caméra ou vidéo. La lecture est **locale** (Tesseract.js en WebAssembly, dans un worker) : aucune image ne quitte l'appareil.

```json
{ "tagName": "sonic-file-open", "attributes": { "accept": "image/*", "ref-provider": "page" } }
{ "tagName": "sonic-still", "attributes": { "id": "scan", "in-data-provider": "page" } }
{ "tagName": "sonic-ocr", "attributes": { "source": "#scan", "lang": "fra+eng", "control": "lire", "out-data-provider": "ocrState" } }
```

| Attribut | Rôle |
|---|---|
| `source` | `#id` d'une source d'images |
| `lang` | Langues Tesseract séparées par `+`, 3 au plus : `eng` (défaut), `fra`, `deu`, `spa`, `ita`, `por`, `nld`, `pol`, `ces`, `swe`, `dan`, `nor`, `fin`, `tur`, `ron`, `hun`, `ell`, `rus` |
| `control` | DP `{ n, lang?, minConfidence?, maxSize? }` : une hausse de `n` lance la lecture ; les réglages présents s'appliquent en direct |
| `params` | DP de réglages en direct `{ lang, minConfidence, maxSize }` (clés en tirets acceptées : `min-confidence`, `max-size`) |
| `auto` | Lit dès que l'image est prête, puis à chaque nouvelle image de la source (caméra, vidéo, nouvelle photo) |
| `interval` | Intervalle minimal entre deux lectures en mode `auto`, en ms (défaut 1000, 100 au moins) |
| `max-size` | Côté maximal analysé en pixels (64 à 4000, défaut 2000) |
| `min-confidence` | Mots sous cette confiance (0 à 100) écartés |

État : `{ status: idle | loading | working | ready | error, error, step, progress, text, confidence, lines, words, width, height, lang, ms, runs, settings }`. Chaque ligne porte `{ text, confidence, x, y, w, h, words[] }`, positions en pixels de l'image d'origine : de quoi surligner le texte trouvé. `settings` donne les réglages effectifs `{ lang, minConfidence, maxSize }`, `runs` le nombre de lectures abouties.

## Pilotage par DataProvider

Les réglages se lisent dans les attributs, puis dans `control`, puis dans `params` : le dernier l'emporte, valeurs bornées. Un changement de réglage après une première lecture s'applique aussitôt :
- `minConfidence` : le dernier résultat est refiltré sans relire l'image ;
- `maxSize` : l'image courante est relue ;
- `lang` : le moteur de l'ancienne langue est libéré, celui de la nouvelle se charge, puis l'image courante est relue. Une langue inconnue donne `status: "error"` (`langue non prise en charge`).

Un changement pendant une lecture est appliqué à la fin de celle-ci.

```json
{ "tagName": "sonic-camera", "attributes": { "id": "cam" } }
{ "tagName": "sonic-ocr", "attributes": { "source": "#cam", "auto": true, "interval": 2000, "params": "ocrReglages", "out-data-provider": "ocrState" } }
```

## Chargement

Au premier usage, le moteur (script épinglé avec empreinte d'intégrité, noyau WebAssembly, données de langue) se télécharge depuis jsDelivr, environ 10 à 20 Mo, puis reste en cache du navigateur. Pendant ce temps, `status` vaut `loading` et `step` indique l'étape. Réseau et CSP doivent autoriser `cdn.jsdelivr.net` (scripts, workers, connexions).

## Limites

Fait pour du texte imprimé, net, contrasté et droit. L'écriture manuscrite, les photos penchées ou floues et les textes très petits donnent de mauvais résultats. Une image d'un autre site doit autoriser CORS. Une lecture à la fois : en `auto`, une image arrivée pendant une lecture est ignorée, la suivante sera lue.
