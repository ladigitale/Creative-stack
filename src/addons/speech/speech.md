# Voix : `sonic-speak` et `sonic-listen`

Synthèse et reconnaissance vocales **natives** du navigateur, pilotées par DataProvider, sans JS ;
reconnaissance **sur l'appareil** avec Whisper (`engine="whisper"`).
Les deux composants sont invisibles : un bouton de l'artefact les déclenche par `for="idBouton"`
(dans le geste, ce que les navigateurs exigent) ou par compteurs dans un DataProvider `control`.

Non testé sur matériel ni en navigateur réel : les tests doublent les API du navigateur.

## Lire un texte à voix haute : `sonic-speak`

Un bouton « Lire » :

```json
{ "tagName": "sonic-speak", "attributes": { "id": "voix", "for": "btn-lire", "lang": "fr-FR",
  "text": "Bonjour ! Appuyez sur le bouton pour réécouter cette consigne." } },
{ "tagName": "sonic-button", "attributes": { "id": "btn-lire", "type": "primary" }, "nodes": [
  { "tagName": "span", "attributes": { "text": "Lire" } } ] }
```

Texte lu en direct dans un DataProvider, dit à chaque nouvelle valeur (`auto`) :

```json
{ "tagName": "sonic-speak", "attributes": { "id": "voix", "text-from": "jeu.consigne", "auto": true, "lang": "fr-FR", "rate": 1.1, "target": "jeu" } }
```

La valeur présente au chargement n'est pas dite (aucun geste n'a encore eu lieu) : seule une
nouvelle valeur parle. La toute première lecture doit suivre un geste (Chrome, Safari) : sans lui,
`status: "denied"` et un message dans `error`.

| Attribut | Rôle |
|---|---|
| `text` | Texte à dire |
| `text-from` | DataProvider ou `dp.chemin` (texte ou nombre) lu en direct ; l'emporte sur `text` |
| `auto` | Parle à chaque nouvelle valeur de `text-from` |
| `lang` | Langue BCP 47 (`fr-FR`, `en-US`…) ; choisit une voix de cette langue (par défaut, puis locale) |
| `voice` | Nom exact ou partie du nom d'une voix (« Amélie », « Thomas », « Google ») ; liste dans `voices` de l'état |
| `rate`, `pitch`, `volume` | Vitesse 0,1..10 (1), hauteur 0..2 (1), volume 0..1 (1) |
| `params` | DP `{lang, voice, rate, pitch, volume}` lu en direct, prioritaire sur les attributs |
| `control` | Compteurs `{say, stop, pause, resume, toggle}` ; `{say: {n, text}}` dit un autre texte (et accepte `lang`, `voice`, `rate`, `pitch`, `volume` pour cette lecture) |
| `for` | Ids dont le clic dit le texte courant |
| `boundary` | Envoie aussi `speak:word` à chaque mot |
| `target` | Store qui reçoit les actions |
| `out-data-provider` | DP d'état (défaut `<id>State`) |

État : `{status, error, supported, allowed, active, speaking, paused, pending, voices: [{name, lang, local}], charIndex, word, spoken, voice, settings}`.
`voices` arrive après coup (le navigateur charge sa liste en différé) ; `charIndex` / `word`
suivent le mot dit quand le navigateur envoie les limites de mots (pas toutes les voix ni tous les
navigateurs ; -1 hors lecture) ; `local: false` signale une voix en ligne (le texte part chez
l'éditeur du navigateur) ; `voice` = voix choisie, `null` = choix du navigateur.

Actions vers `target` : `speak:start {text, lang, voice}`, `speak:word {word, charIndex}` (avec
`boundary` : une action par mot, garder un réducteur léger), `speak:end {text, complete, interrupted, error}`
(`interrupted` : arrêtée par `stop` ou remplacée par une nouvelle lecture). Les mêmes partent en
événements DOM `speak-start`, `speak-word`, `speak-end`.

- Les longs textes sont lus phrase par phrase (morceaux de 180 caractères au plus) : Chrome coupe
  une lecture d'un seul tenant après une quinzaine de secondes.
- Une nouvelle lecture annule la précédente. `pause` / `resume` sont peu fiables sur Chrome pour
  Android (la lecture peut repartir du début du morceau, ou s'arrêter).
- Voix disponibles : celles de l'appareil ; une langue sans voix installée est lue avec une autre
  voix, ou pas du tout (`status: "unsupported"`).

## Écouter la parole : `sonic-listen`

Une dictée qui remplit un store (bouton qui démarre et arrête l'écoute) :

```json
{ "tagName": "sonic-store", "attributes": { "id": "notes", "initial": { "lignes": [] },
  "reducer": "$action.type = 'listen:result' and $action.payload.isFinal ? $merge([$state, {'lignes': $append($state.lignes, [$action.payload.text])}]) : $state" } },
{ "tagName": "sonic-listen", "attributes": { "id": "dictee", "for": "btn-dicter", "lang": "fr-FR", "continuous": true, "interim": true, "target": "notes" } },
{ "tagName": "sonic-button", "attributes": { "id": "btn-dicter", "type": "primary" }, "nodes": [
  { "tagName": "span", "attributes": { "text": "Dicter" } } ] },
{ "tagName": "sonic-value", "attributes": { "dataProvider": "dicteeState", "key": "interim" } }
```

Commandes vocales par mots-clés :

```json
{ "tagName": "sonic-listen", "attributes": { "id": "ordres", "for": "btn-micro", "lang": "fr-FR", "continuous": true,
  "phrases": "suivant, précédent, recommencer", "target": "diapo" } }
```

`listen:match {phrase, text}` part dès que le mot-clé est entendu (sur le texte provisoire, une
seule fois par phrase dite) ; « Précédent ! » ou « precedent » reconnaissent `précédent`
(comparaison en mots entiers, sans accents ni casse ; le plus long mot-clé d'abord).

| Attribut | Rôle |
|---|---|
| `lang` | Langue BCP 47 (défaut : langue du navigateur) |
| `continuous` | Ne s'arrête pas après une phrase ; relancée quand le navigateur coupe |
| `interim` | Publie `interim` (texte provisoire) et envoie `listen:result` avec `isFinal: false` |
| `max-alternatives` | Hypothèses par phrase, 1..10 (1), dans `alternatives` |
| `phrases` | Mots-clés séparés par des virgules → `match` et `listen:match` |
| `params` | DP `{lang, continuous, interim, maxAlternatives, phrases}` (tableau ou texte), prioritaire sur les attributs ; pris en compte au prochain démarrage |
| `control` | Compteurs `{start, stop, abort, toggle, clear}` : `stop` livre la dernière phrase, `abort` l'abandonne, `clear` vide `transcript` |
| `for` | Ids dont le clic démarre ou arrête l'écoute |
| `target` | Store qui reçoit les actions |
| `out-data-provider` | DP d'état (défaut `<id>State`) |

État : `{status, error, supported, allowed, active, listening, interim, final, transcript, confidence, alternatives, match, restarts, settings}`.
`active` = écoute voulue, `listening` = micro réellement ouvert (il se referme un instant entre
deux relances) ; `final` = dernière phrase, `transcript` = phrases cumulées depuis `clear` ;
`match = {phrase, text, n}` (`n` augmente à chaque mot-clé : un `sonic-trigger` ou un store voit
chaque reconnaissance, même du même mot).

Actions vers `target` : `listen:result {text, confidence, isFinal}`, `listen:match {phrase, text}`
(événements DOM `listen-result`, `listen-match`).

Erreurs traduites dans `error` : `not-allowed` (micro refusé, ou interdit par la page hôte →
`status: "denied"`), `no-speech` (rien entendu, l'écoute continue en mode continu), `network`
(service de reconnaissance injoignable), `audio-capture` (pas de micro). En continu, une écoute
coupée par le navigateur (silence, environ une minute sous Chrome) est relancée aussitôt ; si elle
recoupe tout de suite, le délai double (250 ms à 8 s) et l'écoute s'arrête après six coupures
rapides d'affilée (`status: "error"`).

Permissions-Policy : `microphone` (`allowed` dans l'état ; une iframe a besoin de
`allow="microphone"`). La première écoute ouvre la demande d'accès au micro du navigateur.

## Reconnaissance locale (Whisper)

`engine="whisper"` transcrit la parole **sur l'appareil** : aucun son n'est envoyé à Google ni à
un autre service. Le modèle Whisper tourne dans le navigateur, dans le worker de l'addon
hugging-face-infer (Transformers.js), avec sa liste blanche, son consentement et son cache.
Mêmes état et actions qu'en natif (`interim`, `final`, `transcript`, `match`, `listen:result`,
`listen:match`) ; fonctionne aussi sous Firefox.

```json
{ "tagName": "sonic-listen", "attributes": { "id": "dictee", "engine": "whisper", "for": "btn-dicter",
  "lang": "fr-FR", "continuous": true, "interim": true, "consent-provider": "dicteeConsent.accepted", "target": "notes" } },
{ "tagName": "sonic-states", "attributes": { "dataProvider": "dicteeState", "data-path": "modelPhase" }, "nodes": [
  { "tagName": "template", "attributes": { "data-value": "awaiting-consent" }, "nodes": [
    { "tagName": "div", "attributes": { "formDataProvider": "dicteeConsent" }, "nodes": [
      { "tagName": "sonic-button", "attributes": { "radio": true, "name": "accepted", "value": "accepted" }, "nodes": [
        { "tagName": "span", "attributes": { "text": "Télécharger le modèle de dictée (≈ 40 Mo, une fois)" } } ] } ] } ] },
  { "tagName": "template", "attributes": { "data-value": "downloading" }, "nodes": [
    { "tagName": "sonic-value", "attributes": { "dataProvider": "dicteeState", "key": "loading" } } ] } ] }
```

Fonctionnement : le micro (getUserMedia, ouvert par le geste `for` ou la commande `start`) est
découpé en phrases par détection de silence (énergie RMS par trames de 30 ms, seuil relevé si
le bruit de fond est fort) ; une phrase se termine après `silence-ms` de silence (700 ms) ou à
15 s. Chaque phrase est rééchantillonnée en 16 kHz mono puis transcrite ; pendant ce temps
`interim` vaut « … » (et, avec `interim`, `listen:result {text: "…", isFinal: false}` part).
La langue (`lang`, sinon celle du navigateur) est passée au modèle (`fr-FR` → `fr`) ; un modèle
anglais seul (`….en`) l'ignore. Sans `continuous`, l'écoute s'arrête après une phrase ; `stop`
transcrit la phrase en cours, `abort` l'abandonne.

| Attribut | Rôle |
|---|---|
| `engine` | `native` (défaut), `whisper`, `auto` |
| `model` | Alias du modèle dans la liste blanche de l'application (défaut `whisper-tiny`) |
| `silence-ms` | Silence qui termine une phrase (700 ms) |
| `threshold` | Seuil RMS de parole, 0..1 (0,015) ; à monter dans un lieu bruyant |
| `load` | `first-use` (défaut : au premier démarrage), `auto` (préchargé dès l'affichage), `consent` (toujours demander) |
| `consent-provider` | DP : `"accepted"` ou `true` accepte le téléchargement, `"declined"` ou `false` le refuse |
| `control` | En plus : compteurs `{load, accept, decline}` |

État en plus : `engine` (moteur effectif), `loading` (0..100 pendant le téléchargement ou le
chargement du modèle, sinon `null`), `modelReady`, `modelPhase` (`idle`, `checking`,
`awaiting-consent`, `declined`, `downloading`, `loading`, `ready`, `error`, `unsupported`),
`modelSize` (octets à télécharger, `null` si inconnu), `transcribing`. Whisper ne donne pas de
confiance : `confidence` vaut 0 et `alternatives` ne contient que la phrase.

**`engine="auto"`** : Whisper si l'application a configuré l'inférence et que `model` est dans sa
liste blanche (et que le micro existe), sinon la reconnaissance du navigateur. Règle choisie pour
la confidentialité : dès que la reconnaissance locale est possible, elle passe en premier.

À savoir :

- **Taille** : `whisper-tiny` multilingue (`onnx-community/whisper-tiny`, 8 bits) pèse environ
  40 Mo, téléchargés une seule fois puis gardés dans le cache du navigateur. L'application
  demande le consentement au-delà de son seuil (30 Mo par défaut) : `modelPhase` vaut alors
  `awaiting-consent` jusqu'à `accept` (bouton, `consent-provider` ou `control`). Taille à
  vérifier avec `hf-vendor.mjs` avant d'ajouter le modèle à la liste blanche.
- **Première utilisation lente** : téléchargement, puis compilation du modèle (quelques secondes),
  et chaque phrase prend environ 0,5 à 2 s à transcrire selon l'appareil (plus sur un téléphone
  ancien, sans WebGPU). Les phrases dites pendant le chargement attendent (4 au plus).
- **Confidentialité** : le son ne quitte pas l'appareil ; seul le modèle est téléchargé (depuis
  l'hôte de modèles de l'application). Le dire à l'utilisateur, c'est un argument.
- Whisper invente parfois du texte sur un silence ou une musique : les sorties entre crochets
  (« [Musique] »), sans lettres, ou les génériques de sous-titres sont ignorées.
- L'application doit appeler `configureHuggingFace` avec un modèle `automatic-speech-recognition`
  sous cet alias ; sinon `status: "unsupported"` et la raison dans `error`. Dans un bundle autonome
  (IIFE), charger `creative-stack-hugging-face-infer.bundle.js` avant celui de speech.
- Non testé sur matériel ni en navigateur réel (tests jsdom avec micro, Web Audio et moteur doublés).

## Limites à connaître

- **Firefox n'a pas de reconnaissance vocale native** : `sonic-listen` publie `status: "unsupported"`.
  Prévoir un champ texte en repli, ou `engine="whisper"` / `engine="auto"`.
- **Chrome envoie l'audio aux serveurs de Google** pour le transcrire (Edge à ceux de Microsoft,
  Safari à ceux d'Apple selon les réglages de l'appareil). Le dire clairement à l'utilisateur
  avant de démarrer l'écoute. Pour une transcription qui reste sur l'appareil, préférer
  `engine="whisper"` (plus lent, modèle à télécharger, mais rien ne sort du navigateur).
- La reconnaissance exige une page HTTPS et, souvent, une connexion réseau.
- Certaines voix de synthèse sont en ligne (`local: false`) : le texte lu part chez l'éditeur.
- Sur iPhone, la synthèse ne parle qu'après un geste, et un onglet en arrière-plan se tait.

### Diagnostic de la dictée Whisper

État en plus pendant l'écoute : `micLevel` (niveau du micro 0..1, ~10 fois par seconde, pour un vumètre),
`voice` (une phrase est en cours de capture), `audioState` (moteur audio du navigateur : `running` ; s'il passe en
pause, il est relancé) et `audioBlocks` (blocs de son reçus : s'il reste à 0, le micro ne délivre rien).

Détection de parole : 300 ms d'écoute du bruit de fond au démarrage (trame la plus calme retenue), puis seuil =
bruit × 2, ou bruit + 0,02 si c'est moins (au moins `threshold`, 0,01). Les micros de téléphone ont un gain
automatique qui remonte le bruit dans les silences : un seuil proportionnel au bruit (× 3) passait au-dessus de la voix.

