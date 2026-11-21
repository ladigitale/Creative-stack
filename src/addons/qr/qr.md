# sonic-qr

QR code dessiné en SVG dans la page : aucun service tiers, aucune requête. Pour montrer un lien à
scanner avec un téléphone (lien spectateur d'un run, appairage d'une télécommande, code de salon,
URL d'un artefact).

```json
{ "tagName": "sonic-qr", "attributes": { "text": "https://artifacts.tadaaa.space/mon-artefact", "link": true } }
```

Texte lu en direct dans un DataProvider (le code se redessine quand la valeur change) :

```json
{ "tagName": "sonic-qr", "attributes": { "text-from": "artifactRun.watchUrl", "placeholder": "Lien pas encore prêt", "size": 240 } }
```

| Attribut | Rôle |
|---|---|
| `text` | Texte à encoder |
| `text-from` | DataProvider ou `dp.chemin` dont la valeur (texte ou nombre) est encodée ; l'emporte sur `text` |
| `ecc` | Correction d'erreur `L`, `M` (défaut), `Q`, `H` : plus haut = plus robuste (écran sale, reflets) mais plus dense |
| `size` | Taille en px (défaut 192) ; la variable CSS `--qr-size` l'emporte (`style="--qr-size:40vmin"`) |
| `margin` | Zone de silence en modules (défaut 2 ; 4 pour l'impression) |
| `color`, `background` | Défaut `#000000` sur `#ffffff`. Garder un fort contraste et des modules sombres sur fond clair : beaucoup de lecteurs refusent un code inversé |
| `link` | Le code est aussi un lien quand le texte est une URL `http(s)` (jamais `javascript:` ni `data:`) |
| `label` | Texte lu par les lecteurs d'écran (défaut : « QR code : » suivi du texte) |
| `placeholder` | Affiché tant que le texte est vide |
| `out-data-provider` | État `{status: ready|empty|error, text, version, modules, error}` |

- 1200 caractères au plus (au-delà, `status: "error"`) : un lien court se lit de plus loin. Les
  accents et émojis sont encodés en UTF-8.
- Lisibilité à distance : un module doit faire au moins ~1 mm par mètre de distance de lecture ;
  pour un écran de salle, `--qr-size: 40vmin` et `ecc: "Q"`.

# Lire un QR code : `sonic-qr-reader`

Analyse en continu les images d'une source et publie le texte du QR code vu. Invisible.

```json
{ "tagName": "sonic-camera", "attributes": { "id": "cam", "facing": "environment" } },
{ "tagName": "sonic-qr-reader", "attributes": { "id": "lecteur", "source": "#cam", "target": "etat" } }
```

- État `lecteurState` : `{status, error, engine, active, text, count, scans, rate, ms, settings}`. `text` est le dernier texte lu, `count` augmente à chaque texte différent du précédent.
- `target` : une action `{type: "qr", payload: {text}}` par nouveau texte.
- Moteur : le détecteur du navigateur quand il lit les QR codes (Chrome sur Android), sinon un décodeur chargé à la demande depuis jsDelivr (version épinglée, empreinte d'intégrité). `engine="native"` ou `"jsqr"` impose l'un des deux.
- `interval` : ms entre deux analyses (50). `max-size` : taille de l'image donnée au décodeur de repli (640 px ; monter pour un code dense ou lointain, baisser pour un téléphone lent).
- `params` : `{active, interval, maxSize}` en direct (`active: false` met en pause).

# Passer un fichier par QR codes animés : `sonic-qr-sender` et `sonic-qr-receiver`

Un appareil affiche une suite de QR codes, l'autre les filme : une photo, un dessin ou un texte passe de l'un à l'autre sans réseau. Le fichier est découpé en trames numérotées, affichées en boucle ; le récepteur les rassemble dans n'importe quel ordre et vérifie une empreinte.

```json
{ "tagName": "sonic-qr-sender", "attributes": { "id": "envoi", "from": "photo", "auto": true } },
{ "tagName": "sonic-qr", "attributes": { "text-from": "envoiState.frame", "ecc": "L", "margin": "3", "style": "--qr-size:min(92vw,28rem)" } }
```

```json
{ "tagName": "sonic-camera", "attributes": { "id": "cam", "facing": "environment" } },
{ "tagName": "sonic-qr-reader", "attributes": { "id": "lecteur", "source": "#cam" } },
{ "tagName": "sonic-qr-receiver", "attributes": { "id": "recu", "source": "lecteurState.text", "file-provider": "fichier" } },
{ "tagName": "sonic-still", "attributes": { "in-data-provider": "fichier" } }
```

## Émetteur

- `from` : chemin de DataProvider de ce qu'il faut envoyer. URL `blob:` ou `data:`, SonicMediaRef `{url, mime}` (le `snapshot-provider` d'une `sonic-camera`, l'export d'un dessin), ou texte brut.
- `auto` envoie à chaque changement de la source ; `send-from` à chaque hausse d'un compteur.
- Une image est réduite avant l'envoi : `image-max` (320 px de plus grand côté) et `image-quality` (JPEG, 0,6). Une photo fait alors 10 à 25 ko. `image-max="0"` l'envoie telle quelle. 400 ko au plus.
- `fps` (8) et `chunk` (300 octets par trame) fixent le débit : 2,4 ko par seconde par défaut. Une trame plus grosse donne un code plus dense, plus dur à lire ; une cadence plus haute que celle du lecteur fait sauter des trames, rattrapées au tour suivant.
- État `envoiState` : `{status, error, frame, index, frames, loops, bytes, mime, name, loopSeconds, settings}`. Afficher `frame` avec `sonic-qr ecc="L"`, en grand, noir sur blanc.
- `control {cancel: compteur}` arrête l'envoi ; `params {fps, chunk, imageMax, imageQuality}`.

## Récepteur

- `source` : chemin du texte lu, `lecteurState.text`.
- État `recuState` : `{status: idle|receiving|done|error, received, total, progress, percent, mime, name, size, file, text, seconds, count}`. `file` est `{url (blob:), mime, name, size}` ; `text` porte le contenu d'un fichier texte.
- `file-provider` publie le fichier seul en SonicMediaRef : entrée d'un `sonic-still in-data-provider` (affichage) ou d'un `sonic-media-download source`.
- `target` : action `{type: "qr:received", payload: {name, mime, size}}`.
- Un nouvel envoi (autre identifiant) remplace le précédent ; `control {reset: compteur}` oublie tout.
- Barre de progression : `div dataProvider="recuState"` > `sonic-progress data-bind="" ::value="$percent" max="100"`.

## À savoir

- Les dernières trames se font attendre : quand il en manque deux ou trois, il faut parfois un tour complet pour les revoir. `loopSeconds` donne la durée d'un tour.
- L'écran émetteur à pleine luminosité, le code bien cadré dans l'image, sans reflet.
- Format d'une trame : `QS1|<id>|<i>|<n>|<base64>` ; la trame 0 porte la fiche du fichier (type, nom, taille, empreinte).
