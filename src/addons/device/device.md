# Appareil et navigateur (SDUI)

Addon `@supersoniks/creative-stack/device` : les API « appareil » du navigateur, sans JS, par DataProviders. Chaque composant est **sans rendu** : il publie son état dans `<id>State` (ou `out-data-provider`), se pilote par compteurs dans un DataProvider `control`, et peut être lancé directement par le clic d'un bouton (`for`).

| Composant | Rôle | Commandes (`control`) |
|---|---|---|
| `sonic-fullscreen` | Plein écran de la page ou d'une zone (bouton slotté, repli simulé sur iPhone) | `enter {navigationUI}`, `exit`, `toggle {navigationUI}` ; réglage `navigationUI` |
| `sonic-pointer-lock` | Souris verrouillée, déplacements relatifs | `lock {unadjustedMovement}`, `unlock`, `toggle {unadjustedMovement}`, `reset` ; réglage `unadjustedMovement` |
| `sonic-wake-lock` | Écran toujours allumé | `acquire`, `release`, `toggle` |
| `sonic-orientation` | Orientation de l'écran, capteurs de mouvement | `lock {type}`, `unlock`, `sensors`, `stop` ; réglage `smoothing` |
| `sonic-geolocation` | Position GPS, lieux proches (distance, relèvement) | `start`, `stop`, `once` |
| `sonic-clipboard` | Copier, lire le presse-papiers (texte) ; recevoir une image collée, copier une image | `copy {text}`, `read`, `readImage`, `copyImage` |
| `sonic-share` | Partage natif, repli par copie | `share {title, text, url}` |
| `sonic-vibrate` | Vibration (Android) | `vibrate {pattern}`, `stop` |
| `sonic-nfc` | Tags NFC : lire, écrire texte / URL / JSON (Chrome Android) | `scan`, `stop`, `write {text \| url \| records}`, `makeReadOnly` (avec `allow-lock`) |
| `sonic-hid` | Appareil HID : boutons, pédaliers, claviers de macros | `connect {pick}`, `close`, `sendReport`, `sendFeatureReport`, `receiveFeatureReport`, `forget` |
| `sonic-usb` | Appareil USB à protocole maison (WebUSB) | `connect {pick}`, `open`, `close`, `transferIn`, `transferOut`, `controlTransferIn`, `controlTransferOut`, `forget` |
| `sonic-page-state` | Visibilité, focus, connexion, taille, préférences | — |
| `sonic-capabilities` | Ce que la page autorise, en un DataProvider | `refresh` |

Les manettes (`sonic-controller`, addon `controller`), le MIDI (`sonic-midi`, addon `audio`), le Bluetooth (`sonic-bluetooth`, addon `bluetooth`, `allow="bluetooth"` dans une iframe) et le port série (`sonic-serial`, addon `serial`, `allow="serial"`) ont leur addon.

## Conventions communes

État de base, dans tous les composants :

```ts
{
  status: "idle" | "requesting" | "ready" | "denied" | "error" | "unsupported",
  error: string | null,      // message lisible
  supported: boolean,        // l'API existe dans ce navigateur
  allowed: boolean | "unknown", // la Permissions Policy de la page l'autorise (iframe)
  active: boolean,           // la fonction est engagée (plein écran, verrou, vibration…)
}
```

| Attribut | Rôle |
|---|---|
| `control` | DP de pilotage : compteurs `{ toggle: 3 }` puis `{ toggle: 4 }` déclenche une fois. La première valeur vue sert de référence. Avec arguments : `{ share: { n: 2, text: "…" } }` |
| `for` | Ids (séparés par des espaces) dont le **clic** lance la commande par défaut, dans le geste |
| `out-data-provider` | DP d'état (défaut `<id>State`) |
| `rate` | Publications par seconde au plus pour les valeurs continues (30) |

Les commandes ne lèvent jamais d'exception : un refus du navigateur devient `status: "denied"` avec un message (`error`), un API absente `status: "unsupported"`.

### Geste utilisateur

Plein écran, pointer lock, vibration, partage et permission des capteurs iOS **exigent un geste**. Deux façons fiables :

1. `for="monBouton"` : l'action part dans le clic lui-même.
2. Un compteur écrit par un bouton (`sonic-action` → reducer) : marche dans la fenêtre d'activation transitoire du navigateur (quelques secondes sous Chrome et Firefox, plus court sous Safari).

Une commande lancée par un minuteur, par un agent ou au chargement n'a pas de geste et sera refusée (`denied`). `sonic-wake-lock auto` et `sonic-orientation sensors` essaient quand même au chargement, ce qui est refusé quand le navigateur l'impose (sous iOS pour les capteurs).

### Dans une iframe (artefact, aperçu)

L'hôte doit autoriser la fonction : attribut `allow` de l'`<iframe>`, ou en-tête `Permissions-Policy`. `allowed` le reflète quand le navigateur sait le dire.

| Composant | À autoriser |
|---|---|
| `sonic-fullscreen` | `allow="fullscreen"` |
| `sonic-pointer-lock` | `sandbox="… allow-pointer-lock"` (c'est un drapeau `sandbox`, pas `allow`) |
| `sonic-wake-lock` | `allow="screen-wake-lock"` |
| `sonic-orientation` | `allow="accelerometer; gyroscope; magnetometer"` |
| `sonic-geolocation` | `allow="geolocation"` |
| `sonic-clipboard` | `allow="clipboard-write; clipboard-read"` |
| `sonic-share` | `allow="web-share"` |
| `sonic-vibrate` | `allow="vibrate"` (selon le navigateur) |
| `sonic-nfc` | rien à autoriser : Web NFC n'a pas de Permissions Policy et ne marche que dans le cadre principal ou une iframe de même origine |
| `sonic-hid` | `allow="hid"` ; en-tête de la page `Permissions-Policy: hid=(self)` |
| `sonic-usb` | `allow="usb"` ; en-tête de la page `Permissions-Policy: usb=(self)` |

Tableau de départ : à vérifier sur chaque navigateur cible avant de s'y fier.

## Exemples

### Bouton « Plein écran » (le plus simple)

```json
{ "tagName": "section", "attributes": { "id": "atelier", "data-fullscreen-root": "" }, "nodes": [
  { "tagName": "sonic-fullscreen", "attributes": { "id": "fs" }, "nodes": [
    { "tagName": "sonic-button", "attributes": { "variant": "ghost", "size": "sm" }, "nodes": [
      { "tagName": "span", "attributes": { "swap": "off", "text": "Plein écran" } },
      { "tagName": "span", "attributes": { "swap": "on", "text": "Quitter le plein écran" } }
    ] }
  ] }
] }
```

Le bouton est **dans** `sonic-fullscreen` : un clic bascule le plein écran de l'ancêtre `data-fullscreen-root` (ici `#atelier` ; sans ancêtre marqué : toute la page ; `target="scene"` ou `target="#scene"` pour une autre zone). Le composant pose `active` sur lui-même et sur le `sonic-button` (les enfants `swap="on"` / `swap="off"` alternent) et `aria-pressed` sur le bouton. `fsState` : `{ active, simulated, … }` pour le reste de l'artefact.

Repli `fallback="simulate"` (défaut) : quand le navigateur n'a pas l'API ou la refuse (iPhone Safari, qui ne permet le vrai plein écran que sur une `<video>` ; iframe sans `allow="fullscreen"`), la cible passe en `position: fixed; inset: 0; height: 100svh; z-index` très élevé, fond `--sonic-fullscreen-background` (sinon `--sc-base`), défilement de la page bloqué, attribut `data-fullscreen-simulated` posé pour le CSS de l'artefact. Échap, une nouvelle bascule ou le retrait du composant rendent le style d'origine. Les barres du navigateur restent visibles et l'orientation n'est pas verrouillée. Un ancêtre avec `transform`, `filter` ou `contain` enferme la position fixe : placer la cible hors de ces conteneurs. `fallback="none"` : pas de repli, l'échec est publié (`unsupported`, `denied`).

### Plein écran et écran allumé, sans store

```json
{ "tagName": "div", "attributes": { "id": "scene", "style": "aspect-ratio:16/9;background:#0b0d14" } }
{ "tagName": "sonic-button", "attributes": { "id": "btn-plein", "variant": "default" }, "nodes": [{ "tagName": "span", "attributes": { "text": "Plein écran" } }] }
{ "tagName": "sonic-fullscreen", "attributes": { "id": "fs", "target": "#scene", "for": "btn-plein" } }
{ "tagName": "sonic-wake-lock", "attributes": { "id": "wl", "for": "btn-plein", "auto": "" } }
```

Un clic sur `btn-plein` bascule le plein écran de `#scene` et le verrou d'écran. `fsState.active` dit si c'est en cours (Échap compris).

### Pilotage par un store

```json
{ "tagName": "sonic-store", "attributes": { "id": "ui",
  "initial": "{\"fs\": {\"toggle\": 0}, \"vib\": {\"vibrate\": {\"n\": 0, \"pattern\": \"60,40,60\"}}}",
  "reducer": "($t := $action.type; $s := $state; $t = \"fs\" ? $merge([$s, {\"fs\": {\"toggle\": $s.fs.toggle + 1}}]) : $t = \"buzz\" ? $merge([$s, {\"vib\": {\"vibrate\": $merge([$s.vib.vibrate, {\"n\": $s.vib.vibrate.n + 1}])}}]) : $s)" } }
{ "tagName": "sonic-fullscreen", "attributes": { "id": "fs", "target": "#scene", "control": "ui.fs" } }
{ "tagName": "sonic-vibrate", "attributes": { "id": "vib", "control": "ui.vib" } }
{ "tagName": "sonic-action", "attributes": { "target": "ui", "type": "fs" }, "nodes": [{ "tagName": "sonic-button", "attributes": { "data-action": "fs" }, "nodes": [] }] }
```

### Visée à la souris (pointer lock)

```json
{ "tagName": "canvas", "attributes": { "id": "vue" } }
{ "tagName": "sonic-pointer-lock", "attributes": { "id": "visee", "target": "#vue", "for": "vue", "unadjusted-movement": "", "rate": "60" } }
```

Un clic sur le canevas verrouille la souris. `viseeState` : `{ active, dx, dy, x, y }` — `dx`/`dy` sont la somme des déplacements depuis la dernière publication (puis 0 quand la souris s'arrête), `x`/`y` le cumul depuis le verrouillage. Pour un contrôle plus fin, l'événement `sonic-pointerlock-move` (`detail: { dx, dy }`) part à chaque mouvement.

### Capteurs (inclinaison du téléphone)

```json
{ "tagName": "sonic-button", "attributes": { "id": "btn-capteurs" }, "nodes": [] }
{ "tagName": "sonic-orientation", "attributes": { "id": "tilt", "for": "btn-capteurs", "smoothing": "0.4", "rate": "30" } }
```

Un clic démarre les capteurs (sous iOS, la permission est demandée dans le clic). `tiltState` : `alpha` / `beta` / `gamma` (degrés), `ax` / `ay` / `az` (accélération), `ra` / `rb` / `rg` (rotation), `null` quand l'appareil n'en envoie pas (ordinateur).

### Position et lieux proches

```json
{ "tagName": "sonic-geolocation", "attributes": { "id": "geo", "for": "btn-position", "places": "lieux", "radius": "250" } }
```

`geoState` : `{ lat, lon, accuracy, heading, speed, nearby: [{ id, lat, lon, …, distance, bearing }], nearest }`. `lieux` est n'importe quel DataProvider qui contient une liste `[{ id, lat, lon, … }]` (store, transform, collecte) ; les autres clés de chaque lieu sont recopiées telles quelles dans `nearby`. La précision (`accuracy`, en mètres) tourne autour de 5 à 15 m en ville : pour un repérage plus fin, enchaîner avec l'addon `anchor` (reconnaissance visuelle).

### Dégrader proprement avec `sonic-capabilities`

```json
{ "tagName": "sonic-capabilities", "attributes": { "id": "caps" } }
```

`capsState` : `{ status: "ready", embedded, secureContext, fullscreen: { supported, allowed, permission }, wakeLock: {…}, … }`. Lire par exemple `capsState.vibrate.supported` pour n'afficher le bouton « vibrer » que sur les appareils qui le permettent, ou `capsState.fullscreen.allowed` pour savoir si la page hôte autorise le plein écran. Aucune demande de permission n'est ouverte : détection par présence de l'API, lecture de la Permissions Policy et de `navigator.permissions` quand le navigateur connaît le nom (`permission : "unknown"` sinon, `"n/a"` quand l'API n'en demande pas).

Clés : `fullscreen`, `pointerLock`, `wakeLock`, `gamepad`, `midi`, `orientation`, `clipboard`, `share`, `vibrate`, `camera`, `microphone`, `audio`, `screen`.

## Détails par composant

**`sonic-fullscreen`** — contenu slotté = bouton de bascule (voir l'exemple plus haut). `target` : id (`scene`, `#scene`) ou sélecteur CSS, cherché dans l'arbre du composant (shadow root du viewer compris) puis dans le document ; défaut : l'ancêtre `data-fullscreen-root` le plus proche, sinon la page. Une cible dans un shadow root est reconnue active via `shadowRoot.fullscreenElement`. `fallback` : `simulate` (défaut) ou `none` ; l'état publie `simulated`. `navigation-ui` : `auto`, `hide`, `show` ; aussi en clé de réglage de `control` (`{ navigationUI: "hide" }`, prioritaire sur l'attribut tant qu'elle est présente) ou en argument d'une seule entrée (`{ enter: { n: 3, navigationUI: "hide" } }`). L'état publie `navigationUI` (valeur effective). L'état suit toujours l'événement `fullscreenchange` (sortie par Échap comprise). iPhone Safari : plein écran seulement sur une `<video>` (`target="#ma-video"`), `supportsVideoOnly` l'indique. Événement `sonic-fullscreen-change`.

**`sonic-pointer-lock`** — `unadjusted-movement` demande le mouvement brut ; si le navigateur ne le connaît pas, repli automatique (`raw: false`). Aussi en clé de réglage de `control` (`{ unadjustedMovement: true }`, prioritaire sur l'attribut tant qu'elle est présente) ou en argument d'un seul verrouillage (`{ lock: { n: 2, unadjustedMovement: true } }`) ; l'état publie `unadjustedMovement` (demandé) à côté de `raw` (obtenu). Échap rend toujours la souris ; un nouveau verrouillage est parfois refusé environ une seconde après. Retiré de la page, le composant libère la souris.

**`sonic-wake-lock`** — Le navigateur relâche le verrou quand l'onglet passe en arrière-plan ; tant que `wanted` reste vrai, il est repris au retour (`reacquired` compte les reprises). Pas de repli par vidéo cachée.

**`sonic-orientation`** — `type` / `angle` suivent l'écran. `lock {type}` : `landscape`, `portrait`, `natural`, `any`, `portrait-primary`, `portrait-secondary`, `landscape-primary`, `landscape-secondary` ; sur mobile, souvent seulement en plein écran. `smoothing` (0 à 0,95) lisse les capteurs, aussi en clé de réglage de `control` (`{ smoothing: 0.5 }`, appliqué en direct, prioritaire sur l'attribut tant qu'il est présent ; publié dans l'état) ; `alpha` (boussole) est lissé par le plus court chemin sur le cercle.

**`sonic-clipboard`** — `text` : texte copié par défaut. La lecture (`read`) n'a lieu que sur commande, avec la permission du navigateur ; le texte lu (tronqué à 10 000 caractères) est publié dans le DataProvider : ne pas s'en servir pour des données sensibles.

Images : `paste` reçoit l'image collée dans la page (Ctrl + V, sans permission) et la publie en `SonicMediaRef` dans `ref-provider`, avec une action vers `target` (`action-type`, défaut `paste`, charge `{...payload, image: {mime, size, width, height}}`) ; `readImage` fait la même chose depuis un bouton (geste et permission du navigateur). `file-from` désigne une image produite par la page (URL `blob:`) : `for`, `copy` sans texte ou `copyImage` la copient en PNG ; avec `wait`, le clic réserve le presse-papiers et l'image y arrive dès que le prochain média est publié dans `file-from`.

```json
{ "tagName": "sonic-clipboard", "attributes": { "id": "pp", "paste": "", "ref-provider": "capture.image", "target": "ui", "file-from": "toileState.last", "wait": "", "for": "copier" } }
```

**`sonic-share`** — `title`, `text`, `url` (http ou https seulement : `javascript:` et `data:` sont refusés). Sans partage natif, `fallback="copy"` (défaut) copie `texte + url`. Annuler la feuille de partage incrémente `cancelled`, ce n'est pas une erreur.

Partage d'un fichier : `file-from` désigne un SonicMediaRef (URL `blob:` seulement, ce que la page a créé : `fxState.last`, `camState.snapshot`…) ; le fichier est joint (`filename`, extension déduite du format), préparé d'avance pour que la feuille s'ouvre dans le geste. `canShareFiles` dit si le système accepte ce type de fichier (souvent vrai sur mobile, faux sur certains navigateurs de bureau) : s'en servir pour n'afficher le bouton que là où il marche. Avec `wait`, le clic attend le **prochain** média publié dans `file-from`, produit par une action autour du bouton (un export, par exemple) ; si le navigateur juge alors le geste trop ancien (export long, Safari), `ready` passe à vrai et le clic suivant partage aussitôt le fichier prêt (30 s), sans relancer d'attente.

**`sonic-vibrate`** — `pattern` : `"200"` ou `"100,50,100"` (vibration, pause, vibration…), 20 éléments au plus, 5 s chacun. Absent sous iOS (`supported: false`) : prévoir un autre retour (son, animation).

**`sonic-page-state`** — Sans permission ni commande. `active` = `visible`. À utiliser pour couper un rendu ou un son quand l'onglet est caché (`visible: false`), ou adapter la scène au tactile (`touch`), au thème sombre (`colorScheme`) ou au mouvement réduit (`reducedMotion`).

## NFC, HID et USB

Trois composants pour du matériel, **non testés sur matériel** (seulement avec des doublures des API) : à essayer sur l'appareil visé avant de s'y fier. Tous exigent HTTPS et un geste de l'utilisateur pour la première autorisation (`for="idBouton"`). Navigateurs : Chromium seulement (Chrome, Edge, Opera, Samsung Internet) ; ni Firefox, ni Safari, ni iOS. Prévoir un repli : `supported: false` et `status: "unsupported"` le disent dès le chargement.

### `sonic-nfc` — tags NFC

Chrome sous **Android** seulement (Web NFC), page visible et au premier plan, NFC activé dans les réglages du téléphone (sinon `error` le dit). Pas de Permissions Policy : rien à mettre dans `allow` ; une iframe d'une autre origine ne peut pas s'en servir.

- `for` : le clic lance `scan` (demande de permission au premier usage). Ensuite chaque tag approché est lu : `records`, `serial`, `count` ; action `nfc:read {serial, records}` vers le store `target`.
- Enregistrements lus : `text` → `{recordType: "text", text}` ; `url` / `absolute-url` → `{url}` si http(s) (sinon seulement `size`) ; `mime` JSON (`application/json`, `…+json`) → `{json}` ; les autres types → `{recordType, mediaType, size}` sans les données. 16 enregistrements au plus, textes tronqués à 10 000 caractères.
- `write` : `{n, text}`, `{n, url}` (http ou https), ou `{n, records: [{recordType: "text"|"url"|"mime", data, mediaType}]}` (`mime` = `application/json` seulement, `data` = valeur JSON). 8 Ko au plus (un tag courant en contient bien moins : NTAG213 ≈ 140 octets, NTAG215 ≈ 500). L'écriture **attend qu'un tag soit approché** (`writing: true`) ; `stop` l'annule. `no-overwrite` refuse un tag qui contient déjà un message.
- `makeReadOnly` verrouille le tag **définitivement** : refusé sans l'attribut `allow-lock`.

```json
{ "tagName": "div", "nodes": [
  { "tagName": "sonic-nfc", "attributes": { "id": "nfc", "for": "lire", "target": "jeu", "control": "nfcCmd" } },
  { "tagName": "sonic-button", "attributes": { "id": "lire", "type": "primary" }, "nodes": [{ "tagName": "span", "attributes": { "text": "Approcher une carte" } }] },
  { "tagName": "sonic-value", "attributes": { "dataProvider": "nfcState", "key": "records.0.text" } }
] }
```

Le store `jeu` reçoit `{type: "nfc:read", payload: {serial, records}}`. Pour écrire, un reducer incrémente `nfcCmd.write` : `{ "write": { "n": 2, "url": "https://exemple.fr/salle-3" } }`.

### `sonic-hid` — appareils HID

Chrome, Edge et Opera **sur ordinateur** (WebHID). Les claviers et souris sont masqués par le navigateur (inutilisables) ; les manettes standard passent mieux par `sonic-controller`.

- `for` : le clic ouvre le sélecteur. `filters` JSON `[{vendorId, productId, usagePage, usage}]` (identifiants en hexadécimal en chaîne, `"1a86"`, ou en nombre) : **sans `filters`, le sélecteur liste tous les appareils HID de la machine** ; mieux vaut filtrer quand on connaît l'appareil. Un seul appareil déjà autorisé qui correspond est rouvert sans sélecteur (`{connect: {n, pick: true}}` force le sélecteur).
- `auto-reconnect` : rouvre l'appareil autorisé au chargement de la page, et quand il est rebranché.
- Rapports d'entrée : `last = {reportId, bytes, at}` et `reports` (les `keep` derniers, 16 par défaut, 64 au plus) ; action `hid:input` (même forme) vers `target`, au plus `rate` par seconde, le dernier rapport n'est jamais perdu. `profile="buttons"` ajoute `buttons` : les 8 bits du premier octet (bit 0 d'abord) ; `gamepad-generic` laisse les octets bruts.
- Commandes : `sendReport {n, reportId, bytes | hex}`, `sendFeatureReport {…}` (4096 octets au plus), `receiveFeatureReport {n, reportId}` (résultat dans `feature`), `close`, `forget` (retire l'autorisation).

```json
{ "tagName": "div", "nodes": [
  { "tagName": "sonic-hid", "attributes": { "id": "pedale", "for": "brancher", "filters": "[{\"usagePage\": 12}]", "profile": "buttons", "auto-reconnect": "", "target": "lecteur", "rate": "20" } },
  { "tagName": "sonic-button", "attributes": { "id": "brancher" }, "nodes": [{ "tagName": "span", "attributes": { "text": "Brancher le pédalier" } }] }
] }
```

Le store `lecteur` reçoit `{type: "hid:input", payload: {reportId, bytes, at, buttons}}` et tourne la page sur `buttons.0`.

### `sonic-usb` — appareils USB

Chromium sur ordinateur et sous Android (WebUSB). Pour un appareil à protocole maison (carte Arduino ou RP2040 avec WebUSB, instrument de mesure) ; les interfaces HID, stockage de masse, audio et vidéo sont **protégées** par le navigateur (`claimInterface` refusé), et un appareil déjà tenu par un pilote du système ne s'ouvre pas (sous Windows : pilote WinUSB ; sous Linux : règle udev). Pour un pont série USB, `sonic-serial` (addon `serial`) convient mieux.

- `for` : le clic ouvre le sélecteur. `filters` JSON `[{vendorId, productId, classCode}]` (`subclassCode`, `protocolCode` aussi) ; **sans `filters`, tous les appareils USB** de la machine sont listés. Un seul appareil déjà autorisé qui correspond est rouvert sans sélecteur ; `auto-reconnect` au chargement et au rebranchement.
- Ouverture : `open()`, `selectConfiguration(configuration)` (attribut, 1), `claimInterface(interface)` (attribut, 0). L'état publie `claimed`.
- Transferts, un à la fois dans l'ordre des commandes, **64 Ko au plus** : `transferIn {n, endpoint, length}`, `transferOut {n, endpoint, bytes | hex | text}`, `controlTransferIn {n, setup, length}`, `controlTransferOut {n, setup, bytes | hex | text}` avec `setup = {requestType: "standard"|"class"|"vendor", recipient: "device"|"interface"|"endpoint"|"other", request, value, index}`. `endpoint` de 1 à 15.
- Réception : `last = {endpoint, bytes, length, truncated, status, at}` (les 4096 premiers octets recopiés ; `length` donne la taille reçue) ; action `usb:in` (même forme) vers `target`. `status` `stall` ou `babble` est aussi signalé dans `error`. Envoi : `lastOut = {endpoint, bytesWritten, status, at}`.

```json
{ "tagName": "div", "nodes": [
  { "tagName": "sonic-usb", "attributes": { "id": "carte", "for": "connecter", "filters": "[{\"vendorId\": \"2e8a\"}]", "interface": "2", "control": "carteCmd", "target": "mesures" } },
  { "tagName": "sonic-button", "attributes": { "id": "connecter" }, "nodes": [{ "tagName": "span", "attributes": { "text": "Connecter la carte" } }] }
] }
```

Un reducer écrit `carteCmd = { "transferOut": { "n": 3, "endpoint": 4, "text": "mesure\n" }, "transferIn": { "n": 3, "endpoint": 5, "length": 64 } }` ; le store `mesures` reçoit `usb:in`.

### Permissions-Policy

Hors iframe, la page elle-même est autorisée tant que l'en-tête ne l'interdit pas. Pour servir explicitement : `Permissions-Policy: hid=(self), usb=(self)`. Dans une iframe : `<iframe allow="hid; usb">`. Web NFC n'a pas de directive.
