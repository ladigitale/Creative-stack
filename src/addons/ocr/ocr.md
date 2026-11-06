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
| `control` | DP `{ n }` : une hausse de `n` lance la lecture |
| `auto` | Lit une fois dès que l'image est prête |
| `max-size` | Côté maximal analysé en pixels (défaut 2000) |
| `min-confidence` | Mots sous cette confiance (0 à 100) écartés |

État : `{ status: idle | loading | working | ready | error, error, step, progress, text, confidence, lines, words, width, height, lang, ms }`. Chaque ligne porte `{ text, confidence, x, y, w, h, words[] }`, positions en pixels de l'image d'origine : de quoi surligner le texte trouvé.

## Chargement

Au premier usage, le moteur (script épinglé avec empreinte d'intégrité, noyau WebAssembly, données de langue) se télécharge depuis jsDelivr, environ 10 à 20 Mo, puis reste en cache du navigateur. Pendant ce temps, `status` vaut `loading` et `step` indique l'étape. Réseau et CSP doivent autoriser `cdn.jsdelivr.net` (scripts, workers, connexions).

## Limites

Fait pour du texte imprimé, net, contrasté et droit. L'écriture manuscrite, les photos penchées ou floues et les textes très petits donnent de mauvais résultats. Une image d'un autre site doit autoriser CORS. Une lecture à la fois.
