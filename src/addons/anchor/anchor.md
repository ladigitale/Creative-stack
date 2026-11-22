# Ancrage sur le réel (SDUI)

Addon `@supersoniks/creative-stack/anchor` : accrocher du contenu à une surface réelle vue par la caméra, entièrement dans le navigateur, sans service tiers ni modèle à télécharger.

| Composant | Rôle |
|---|---|
| `sonic-anchor-ref` | Photographier un lieu, délimiter la zone (4 coins au doigt), produire une **référence** JSON |
| `sonic-anchor` | Retrouver une ou plusieurs références dans l'image de la caméra, en direct |
| `sonic-anchor-view` | Projeter ses enfants SDUI (shader, image, texte, dessin) sur la zone retrouvée, en perspective |

Avec `sonic-geolocation` (addon `device`) pour choisir les lieux candidats autour de soi, et `sonic-orientation` pour la gravité.

## Principe

1. **À la pose** : une photo de la surface, la zone délimitée. On garde les points caractéristiques de la zone élargie de `margin` (coins détectés sur plusieurs échelles, orientation, descripteur binaire de 256 bits), la direction du haut (gravité) et la position GPS.
2. **À la visite** : chaque image de la caméra est analysée de la même façon, ses points sont appariés à ceux de la référence, puis une **homographie** (transformation d'un plan vu sous un autre angle) est estimée par RANSAC. Les solutions incohérentes sont rejetées : zone retournée ou non convexe, taille absurde, rotation qui contredit l'inclinaison du téléphone (`gravity`).
3. **Projection** : les 4 coins retrouvés donnent une matrice CSS `matrix3d` appliquée au plan de contenu.

**Surface plane seulement** : façade, mur, panneau, vitrine, affiche, sol, table. Une surface unie (mur blanc, ciel) n'a pas de points : `quality: "weak"`.

## Exemple complet

`examples/balise.sdui.json` : une caméra arrière, l'onglet « Poser » (photo + coins), l'onglet « Retrouver » (motif animé ou message projeté sur la zone).

Le cœur du câblage :

```json
{ "tagName": "div", "attributes": { "style": "position:relative;aspect-ratio:3/4;overflow:hidden" }, "nodes": [
  { "tagName": "sonic-camera", "attributes": { "id": "cam", "facing": "environment", "fit": "cover", "style": "position:absolute;inset:0;width:100%;height:100%" } },
  { "tagName": "sonic-anchor", "attributes": { "id": "ancre", "source": "#cam", "reference": "poseState.reference", "gravity": "orientState", "active": true } },
  { "tagName": "sonic-anchor-view", "attributes": { "anchor": "ancreState", "fit": "cover", "content-width": "800", "content-height": "600" }, "nodes": [
    { "tagName": "sonic-shader", "attributes": { "image": "void mainImage(out vec4 o, in vec2 f){ o = vec4(f / iResolution.xy, 0.5, 0.8); }", "style": "display:block;width:100%;height:100%" } }
  ] }
] }
```

```json
{ "tagName": "sonic-anchor-ref", "attributes": { "id": "pose", "source": "#cam", "for": "btnPhoto", "gravity": "orientState", "geo": "geoState" } }
```

## Enregistrer des balises

`sonic-anchor-ref` envoie la balise courante à un store (`target`) au clic d'un bouton (`save-for`) ou par `control.save` :

```json
{ "tagName": "sonic-anchor-ref", "attributes": { "id": "pose", "source": "#cam", "for": "btnPhoto", "save-for": "btnGarder", "target": "balises", "extra": "brouillon", "gravity": "orientState", "geo": "geoState", "embedding": "emb" } }
```

Action `{type: "save", payload: {id, createdAt, lat, lon, accuracy, points, ref, …clés de extra}}`. Réducteur type :

```
$action.type = "save" ? $merge([$state, {"items": $append($state.items, [$action.payload])}]) :
$action.type = "remove" ? $merge([$state, {"items": [$state.items[id != $action.payload]]}]) : $state
```

Garder `balises` d'une visite à l'autre : `data.persist = {providers: ["balises"], version: 1}` (et `online: true` pour une copie chez Tadaaa), `maxStateBytes` du store relevé (une balise pèse 30 à 50 Ko).

`sonic-anchor reference="balises.items"` lit directement ces entrées ; quand l'une est trouvée, ses autres champs (message, effet…) sont publiés dans `ancreState.item`. Pour ne chercher que près de soi : `sonic-geolocation places="balises.items"` puis `sonic-anchor within="geoState"` (une entrée prise sans GPS reste toujours candidate). Avec un `sonic-image-embedder id="emb" for="cam"` partagé, `embedding="emb"` sur les deux composants : l'empreinte de la photo est gardée dans la référence, et les candidates les plus ressemblantes à l'image courante sont essayées d'abord (`top`, `ancreState.similarity`).

## Références

`poseState.reference` est un objet JSON (environ 30 à 60 Ko pour 600 points) :

```ts
{ v: 1, pattern: 1, id?, width, height, zone: [{x,y}×4], up?: {x,y}, geo?: {lat, lon, accuracy}, n, pts: "<base64>", desc: "<base64>", createdAt }
```

À enregistrer dans les données de l'artefact (collecte, store persistant) pour constituer une liste de lieux ; `sonic-anchor reference` accepte une référence seule ou une liste. Avec une liste, la dernière référence trouvée est essayée en premier, puis une autre à chaque analyse : garder la liste courte (lieux proches de `sonic-geolocation`, ou classés par ressemblance globale avec `sonic-image-embedder` et `$rankBySimilarity`).

`pattern` est la version du motif de descripteurs : une référence d'une autre version est ignorée (`error` le signale).

## État de `sonic-anchor`

| Clé | Sens |
|---|---|
| `status` | `idle`, `searching`, `tracking`, `holding` (perdue depuis peu, position gardée), `error` |
| `found` | zone affichable |
| `refId`, `index` | référence trouvée |
| `corners` | 4 coins (haut-gauche, haut-droit, bas-droit, bas-gauche) en 0..1 de l'image de la caméra |
| `width`, `height` | taille de l'image analysée |
| `matches`, `inliers`, `confidence` | appariements, appariements cohérents, confiance 0..1 |
| `rotation` | rotation de la zone par rapport à la pose (degrés, sens horaire) |
| `ms`, `fps` | coût d'une analyse et analyses par seconde |

`debug` dessine la zone par-dessus la caméra (même `fit`).

## Dessiner sur le mur tel qu'il est (prise de vue)

La commande `capture` de `control` (`{"capture": n}`, compteur) prend la zone suivie dans l'image en couleur, redressée de face, avec `capture-pad` fois sa taille autour (défaut 1 : trois fois la zone en largeur et en hauteur, gris hors de la photo) et `capture-size` px au plus. Pendant l'analyse, la photo est prise sur l'image même où la zone a été mesurée (pas sur une image plus récente avec des coins lissés, qui seraient en retard), dès que trois mesures successives concordent à 0,6 % près (coins médians : le tremblement du suivi s'annule), sinon au bout de 1,5 s avec la dernière mesure. Elle arrive dans `capture` de l'état : `{url, width, height, mime, pad, refId, seq, steady}` (`steady` : prise sur une zone immobile), ou `{error, seq}` si le mur n'a pas été vu. Posée en `backdrop-from` d'un `sonic-sketch` (`background="transparent"`, mêmes proportions, `export-area="page"`), elle permet de dessiner plein écran et zoomé, au-delà de la zone ; le SVG exporté couvre tout le cadre et se replace sur le mur en le projetant `pad` fois plus grand autour de la zone.

## Image et contenu synchrones

L'analyse prend 50 à 200 ms : posé sur l'image *courante* de la caméra, le contenu traîne derrière la vidéo quand on bouge. `sonic-anchor` publie `frameSeq` (numéro de l'image analysée) et `latencyMs` ; `sonic-frame-sync` (addon media) garde les dernières images et montre exactement celle-là. La caméra n'affiche plus rien elle-même :

```json
{ "tagName": "sonic-camera", "attributes": { "id": "cam", "facing": "environment", "hidden-preview": true } },
{ "tagName": "sonic-frame-sync", "attributes": { "id": "vue", "for": "cam", "sync": "ancreState", "history": "24", "max-width": "960" } },
{ "tagName": "sonic-shader", "attributes": { "channel0": "#vue", "image": "<affichage en cover, voir l'exemple>", "style": "position:absolute;inset:0;width:100%;height:100%" } },
{ "tagName": "sonic-anchor", "attributes": { "id": "ancre", "source": "#cam", "...": "…" } }
```

`sonic-anchor` lit toujours `#cam` (la source en direct) ; seul l'affichage passe par `#vue`. Contrepartie : la vidéo montrée a le retard de l'analyse et avance au rythme des analyses (`fps` de l'état). Quand la zone est perdue depuis peu (`holding`), l'image du dernier succès reste affichée avec son contenu. `history` doit couvrir la latence : 24 images à 30 i/s = 800 ms.

## Réglages utiles

- `max-size` (480) : taille d'analyse. Plus grand = plus de points et plus de portée, plus lent.
- `interval` (90 ms) : rythme d'analyse ; le fil principal garde toujours du temps pour l'affichage.
- `smoothing` (0.5) : lissage des coins. `hold` (4) : analyses ratées tolérées avant de cacher le contenu.
- `gravity-tolerance` (45°) : écart toléré entre la rotation trouvée et celle attendue d'après l'accéléromètre. Mettre `0` pour désactiver le filtre.

## Performances

L'analyse tourne dans un Web Worker (script en `blob:`, compatible CSP ; repli sur le fil principal si le worker est refusé, ou avec `no-worker`). Le fil principal ne fait que copier l'image réduite (`max-size`).

1. **Détection** (`mode: "detect"`) : points et descripteurs de toute l'image, appariement, homographie. Environ 80 ms pour 480 × 360 sur un ordinateur ; essayée au rythme de `interval`.
2. **Suivi** (`mode: "track"`) : une fois la zone trouvée, ses points (120 au plus) sont suivis d'une image à l'autre par flot optique de Lucas-Kanade pyramidal avec vérification aller-retour, puis l'homographie est réestimée. Environ 10 ms : la zone est suivie à chaque image de la caméra.
3. **Regarnissage** : quand les points suivis s'appauvrissent (moins de la moitié) ou toutes les 30 images, une détection sur la même référence remplace le suivi si elle trouve mieux.

Les coins sont lissés par un filtre One Euro (`smoothing`) : immobile, très stable ; en mouvement, sans retard.

## Limites connues

- Forts changements de lumière (jour / nuit), reflets, occultations : enregistrer plusieurs références du même lieu.
- Signe de l'accéléromètre : corrigé pour iOS d'après la présence de `DeviceMotionEvent.requestPermission` ; à vérifier sur chaque appareil cible avant de resserrer `gravity-tolerance`.
