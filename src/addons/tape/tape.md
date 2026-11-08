# Addon `tape` — bande et platine

`sonic-tape` lit un son à une **vitesse signée et continue** : 1 = normal, 2 = double vitesse, 0 = arrêt, −1 = à l'envers. La vitesse vient d'un DataProvider, donc d'un capteur, d'un curseur ou d'une valeur calculée. Prises d'un enregistreur (`sonic-audio-recorder`) ou fichiers ouverts (`sonic-file-open`) se jouent directement.

```json
{ "tagName": "sonic-tape", "attributes": { "id": "bande", "source": "prise", "loop": true, "rate-from": "orientationState.rg", "rate-mode": "omega", "control": "tapeCtl" } }
```

| Attribut | Rôle |
|---|---|
| `source` | URL (https, `blob:`, `data:audio`, relative) ou chemin DP portant `{ url }` |
| `loop`, `loop-start`, `loop-end` | Boucle (secondes ; fin 0 = fin du son) |
| `gain`, `pitch` | Volume ; multiplicateur de toutes les vitesses |
| `output` | `master` (défaut), `none`, ou `#id` d'un effet / analyseur |
| `rate-from` | Chemin DP (pointé) d'un nombre qui pilote la vitesse |
| `rate-mode` | `rate` : valeur × `rate-scale` ; `omega` : °/s → vitesse (33⅓ tr/min = 1×, `rate-scale` = °/s pour 1×) ; `accel` : accélération → secousse |
| `rate-deadzone`, `rate-smooth` | Zone morte du signal ; lissage (ms, défaut 40) |
| `control` | DP : `{ rate, position, play, hold }` et réglages (voir ci-dessous) |

### Réglages par DataProvider

Les clés `loop`, `loopStart`, `loopEnd`, `gain`, `pitch`, `rateMode`, `rateScale`, `rateDeadzone`, `rateSmooth` lues dans `control` l'emportent sur les attributs correspondants ; une clé absente rend la main à l'attribut. Valeurs bornées (`gain` 0..4, `pitch` −16..16, durées ≥ 0) ; une valeur invalide est ignorée. Appliquées en direct, sans recharger le son ni couper la lecture.

```json
{ "tagName": "sonic-tape", "attributes": { "id": "bande", "source": "prise", "control": "tapeCtl", "out-data-provider": "bandeState" } }
```

```json
{ "tapeCtl": { "play": true, "loop": true, "loopStart": 1.5, "loopEnd": 3, "gain": 0.8, "pitch": 0.5 } }
```

## Pilotage par l'appareil

`sonic-orientation` (addon `device`) publie `rg` (rotation autour de la normale de l'écran, °/s), `ax ay az` (accélération avec gravité). Avec `rate-from="orientationState.rg" rate-mode="omega"`, tourner le téléphone comme un plateau lit en avant ou en arrière. Avec `rate-from="orientationState.ax" rate-mode="accel"`, la gravité est retirée (passe-haut) puis l'accélération est intégrée en vitesse qui retombe seule : une secousse lance la bande. iOS exige l'autorisation capteurs (geste), gérée par `sonic-orientation`.

## Scrub

`control.position` (0..1) vise une position : la bande la rejoint en avant ou en arrière en ~30 ms, et s'arrête dessus (curseur de souris, doigt, valeur d'un slider). `control.position: null` relâche, puis `rate` / `play` / `hold` reprennent la main.

État : `{ status: idle | loading | ready | error, error, duration, position, rate, playing, reversed, settings }` ; `settings` donne les réglages effectifs (attributs, puis `control`).

## Limites

Pas d'AudioWorklet : deux copies du son (normale et inversée), une source à la fois, fondu croisé de 8 ms au changement de sens. La position est suivie par un modèle (précision de l'ordre de quelques ms) ; suffisant pour le scrub et le jeu, pas pour de l'édition à l'échantillon. Aucune correction de hauteur : la hauteur suit la vitesse, comme sur une platine.
