# Addon `serial` — port série

Addon `@supersoniks/creative-stack/serial` : un appareil branché en USB derrière un pont série, piloté par DataProviders, sans JS.

| Composant | Rôle |
|---|---|
| `sonic-serial` | Transport : un port série choisi par l'utilisateur, ses octets et ses lignes de texte |

Mêmes conventions que l'addon `device` : sans rendu, état dans `<id>State` (ou `out-data-provider`), commandes par compteurs dans `control`, clic direct par `for`. C'est le pendant filaire de `sonic-bluetooth` : même contrat de canal d'octets (`SonicBytePipe`), donc les pilotes se branchent dessus par `transport="#id"` (`sonic-grbl`, addon `grbl`).

## Ce qui marche, et où

- **Navigateurs** : Chrome, Edge, Opera sur ordinateur (Linux, Windows, macOS, ChromeOS), et Chrome récent sur Android. **Pas d'iPhone ni d'iPad, pas de Firefox, pas de Safari** : `status: "unsupported"`, à tester avec `sonic-capabilities` (`capsState.serial.supported`).
- **HTTPS** obligatoire. Dans une iframe : `allow="serial"`.
- **Geste** obligatoire pour ouvrir le sélecteur de port : `for="idBouton"`, ou un compteur écrit par un bouton. Un port déjà autorisé pour le site (un seul qui correspond aux filtres) est rouvert sans sélecteur ; `connect {pick: true}` force le sélecteur.
- **Un seul logiciel par port** : fermer LaserGRBL, Rayforge, le moniteur série d'Arduino… avant de connecter.
- **Linux** : l'utilisateur doit être dans le groupe `dialout` (`sudo usermod -aG dialout $USER`, puis se reconnecter). Avec Chromium en snap, brancher aussi l'interface `raw-usb`.
- Ouvrir le port redémarre la plupart des cartes (Arduino, ESP32) : c'est normal, la carte renvoie son message d'accueil.

Pourquoi le port série et pas l'USB brut : un pont CH340, CP210x ou FTDI est pris par le pilote série du système, WebUSB ne peut pas l'ouvrir. Web Serial passe par ce pilote.

## Lire et écrire

```json
{ "tagName": "sonic-serial", "attributes": { "id": "port", "profile": "ch340", "for": "connecter", "auto-reconnect": true, "control": "portControl" } }
{ "tagName": "sonic-button", "attributes": { "id": "connecter", "type": "primary" }, "nodes": [{ "tagName": "span", "attributes": { "text": "Connecter" } }] }
```

`portState.connected` dit quand le port est ouvert, `portState.lastLine` porte la dernière ligne reçue et `portState.rx.lines` augmente à chaque ligne (utilisable comme `trigger`). Écrire : `{"line": {"n": 1, "text": "$I"}}` dans `portControl` envoie `$I` suivi d'une fin de ligne.

## `sonic-serial`

| Attribut | Rôle |
|---|---|
| `profile` | `ch340`, `cp210x`, `ftdi`, `arduino`, `esp32`, `grbl` : filtres du sélecteur et débit |
| `filters` | JSON `[{ "usbVendorId": "1a86", "usbProductId": "7523" }]` (hexadécimal en chaîne, ou nombre), ajouté au profil |
| `baud` | Débit (défaut du profil, sinon 115200) |
| `data-bits`, `stop-bits`, `parity`, `flow-control` | Réglages de la liaison (8, 1, `none`, `none`) |
| `eol` | Fin de ligne de la commande `line` : `lf` (défaut), `crlf`, `cr` |
| `auto-reconnect` | Réouverture du même port quand il est rebranché |
| `accept-all` | Sélecteur sans filtre |

| Profil | Ponts acceptés | Appareils |
|---|---|---|
| `ch340` | WCH CH340 / CH341 (`1a86`) | Graveurs laser de bureau (Atomstack, Ortur, Sculpfun), clones Arduino |
| `cp210x` | Silicon Labs (`10c4`) | Cartes ESP32, certaines cartes GRBL |
| `ftdi` | FTDI (`0403`) | Adaptateurs série, anciennes cartes Arduino |
| `arduino` | Arduino (`2341`, `2a03`) | Cartes Arduino officielles |
| `esp32` | Espressif (`303a`) + CP210x + CH340 | ESP32 en USB natif ou derrière un pont |
| `grbl` | Tous ceux-là, plus STM32 (`0483`) | Machines GRBL de toute marque |

| Commande (`control`) | Effet |
|---|---|
| `connect` (défaut de `for`), `disconnect`, `toggle` | `connect {n, pick: true}` force le sélecteur |
| `write {n, hex \| bytes \| text}` | Écrit des octets (4096 au plus) |
| `line {n, text}` | Écrit le texte suivi de la fin de ligne |
| `signals {n, dtr, rts}` | Lignes de contrôle (un front sur DTR redémarre la carte) |
| `forget` | Ferme le port et retire l'autorisation |

État : `{ status, error, supported, allowed, active, connected, port {vendorId, productId, name}, profile, baud, rx {bytes, lines}, lastLine, last {hex, at}, tx {queued, sent, n}, reconnecting }`.

- `status` : `idle` → `requesting` (sélecteur ouvert) → `ready`. Sélecteur fermé sans choix : retour à `idle`, sans erreur.
- `error` dit pourquoi une ouverture échoue : port pris par un autre logiciel, accès refusé par le système.
- Événements DOM : `sonic-serial-connect`, `sonic-serial-disconnect {wanted}`, `sonic-serial-line {text}`.

## Écrire un pilote

Un pilote ne voit que le contrat `SonicBytePipe` (`src/shared/pipe/pipe.ts`) : `pipeReady`, `deviceName`, `writeBytes()`, `onBytes()`. Il marche donc à l'identique sur `sonic-serial` et `sonic-bluetooth`, et se teste sans matériel avec `FakePipe`. `LineSplitter` (`src/shared/pipe/lines.ts`) découpe les octets reçus en lignes.
