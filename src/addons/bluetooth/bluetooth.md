# Addon `bluetooth` — appareils Bluetooth Low Energy

Addon `@supersoniks/creative-stack/bluetooth` : un appareil Bluetooth piloté par DataProviders, sans JS.

| Composant | Rôle |
|---|---|
| `sonic-bluetooth` | Transport : un appareil choisi par l'utilisateur, ses caractéristiques GATT lues, écrites, écoutées |
| `sonic-label-printer` | Pilote : imprimante thermique d'étiquettes ou de tickets, branchée sur un `sonic-bluetooth` |

Le profil `midi` de `sonic-bluetooth` décode lui-même les claviers et contrôleurs MIDI Bluetooth (voir « MIDI Bluetooth »).

Les deux suivent les conventions de l'addon `device` : sans rendu, état dans `<id>State` (ou `out-data-provider`), commandes par compteurs dans `control`, clic direct par `for`.

## Ce qui marche, et où

- **Navigateurs** : Chrome, Edge, Opera (Android, Windows, macOS, ChromeOS ; Linux selon la version). **Pas d'iPhone ni d'iPad, pas de Firefox, pas de Safari** : `status: "unsupported"`, à tester avec `sonic-capabilities` (`capsState.bluetooth.supported`).
- **HTTPS** obligatoire. Dans une iframe : `allow="bluetooth"`.
- **Geste** obligatoire pour ouvrir le sélecteur d'appareil : `for="idBouton"`, ou un compteur écrit par un bouton.
- **Bluetooth Low Energy seulement.** Enceintes, casques, anciens appareils « série » (Bluetooth classique) sont hors de portée. Claviers, souris et manettes BLE aussi (bloqués par le navigateur) : `sonic-keyboard`, `sonic-controller`.
- Après un rechargement de page, il faut un nouveau clic. `auto-reconnect` ne couvre que les coupures en cours de session.

## Imprimer une étiquette (Fichero d'Action)

```json
{ "tagName": "sonic-bluetooth", "attributes": { "id": "bt", "profile": "luck", "for": "connecter", "auto-reconnect": true } }
{ "tagName": "sonic-sketch", "attributes": { "id": "dessin", "width": 480, "height": 192, "background": "#ffffff", "color": "#000000", "size": 6 } }
{ "tagName": "sonic-label-printer", "attributes": { "id": "imp", "transport": "#bt", "source": "#dessin", "label-mm": "30x12", "for": "imprimer", "show-preview": true, "style": "width:240px" } }

{ "tagName": "sonic-button", "attributes": { "id": "connecter", "type": "primary" }, "nodes": [{ "tagName": "span", "attributes": { "text": "Connecter l'imprimante" } }] }
{ "tagName": "sonic-button", "attributes": { "id": "imprimer", "type": "success" }, "nodes": [{ "tagName": "span", "attributes": { "text": "Imprimer" } }] }
```

`btState.connected` et `impState.status == "ready"` disent quand afficher le bouton Imprimer ; `impState.error` porte un message lisible (capot ouvert, plus de papier, source vide). Avec `show-preview`, le composant affiche l'aperçu **exact** : mêmes points que sur le papier. Sans lui il reste invisible, et son `#id` sert de source d'images (canal de shader, par exemple).

Le dessin est fait dans le sens de lecture : pour une étiquette `30x12`, 240 × 96 points (8 points par millimètre). Une source plus grande est ramenée à cette taille (`fit`). Donner à la source le même rapport largeur / hauteur que l'étiquette (ici 5:2) évite les marges.

## `sonic-bluetooth`

| Attribut | Rôle |
|---|---|
| `profile` | Profil nommé (tableau ci-dessous), ou plusieurs séparés par des espaces (`"luck niimbot"`, 4 au plus) : le sélecteur réunit leurs filtres et le profil dont le service est présent sur l'appareil choisi est retenu (clé `profile` de l'état) |
| `filters` | JSON `[{ "namePrefix": "MonAppareil" }, { "services": ["heart_rate"] }]`, ajouté aux filtres du profil |
| `services` | Services à ouvrir en plus, séparés par des espaces (`180f`, UUID complet, ou nom standard) |
| `channels` | JSON `{ "tx": "18f0/2af1", "rx": "18f0/2af0" }` : alias → `service/caractéristique`. `tx` = écriture par défaut, `rx` = notifications |
| `notify` | Alias écoutés dès la connexion (défaut `rx`) |
| `chunk-size`, `gap-ms` | Découpage des écritures (défauts du profil, sinon 20 octets, sans délai) |
| `auto-reconnect` | Reconnexion après une coupure : 1 s, 2 s, 4 s… 30 s |
| `accept-all` | Sélecteur sans filtre de nom. Déconseillé : l'utilisateur voit tous les appareils alentour |

| Commande (`control`) | Effet |
|---|---|
| `connect` (défaut de `for`), `disconnect`, `toggle` | |
| `write {n, channel, hex \| bytes \| text, response}` | Écrit sur un alias (défaut `tx`) : `{"write": {"n": 1, "hex": "10 FF 40"}}` |
| `read {n, channel}` | Lit une caractéristique, résultat dans `values.<alias>` |
| `subscribe {n, channel}`, `unsubscribe {n, channel}` | Notifications |
| `forget` | Déconnecte et oublie l'appareil |
| `midiSend {n, bytes \| hex}` | Profil `midi` : envoie des messages MIDI complets (voir plus bas) |

État : `{ status, error, supported, allowed, active, available, connected, device {id, name}, profile, services [{uuid, characteristics [{uuid, props}]}], channels, values {<alias>: {hex, bytes, text, n, at}}, rx, tx {queued, sent, n}, reconnecting, midi }` (`midi` : `null` hors profil `midi`).

- `status` : `idle` → `requesting` (sélecteur ouvert) → `ready`. Sélecteur fermé sans choix : retour à `idle`, sans erreur.
- `values.rx.text` n'existe que si les octets reçus sont de l'UTF-8 valide ; `values.rx.bytes` et `hex` toujours.
- `rx` compte les notifications : utilisable comme `trigger`.

### Profils

| `profile` | Appareils | Canaux | État |
|---|---|---|---|
| `luck` | Fichero (Action), AiYin D11s | `18f0` : `2af1` / `2af0`, morceaux de 200 octets | validé par le projet `0xMH/fichero-printer` |
| `escpos` | Imprimantes tickets ESC/POS | `18f0` : `2af1` / `2af0` | non testé |
| `uart-nus` | ESP32, micro:bit, Espruino, Adafruit (Nordic UART) | `6e400002` / `6e400003` | non testé |
| `uart-issc`, `uart-hm10` | Modules série Microchip, HM-10 | | non testé |
| `heart-rate`, `battery`, `csc`, `cycling-power` | Capteurs standard : valeur brute dans `values.rx.bytes` | UUID Bluetooth SIG | non testé |
| `niimbot` | Imprimantes d'étiquettes Niimbot (D11, D110, D101, B1, B21, B18…) | `e7810a71…` : une caractéristique en écriture et notification, un paquet par écriture | écrit d'après `printers.niim.blue`, non testé sur matériel |
| `cat` | Imprimantes « chat » GB01, GB02, GB03, GT01, YT01, MX05 à MX10, X5 | `ae30` : `ae01` / `ae02` | écrit d'après documentation, non testé sur matériel |
| `phomemo` | Imprimantes Phomemo M02, T02, M110, M120, M200, D30, D35 | `ff00` : `ff02` / `ff03`, morceaux de 128 octets | écrit d'après documentation, non testé sur matériel |
| `midi` | Claviers et contrôleurs MIDI Bluetooth LE | `03b80e5a…` : `7772e5db…` (écriture et notification) | écrit d'après la spécification BLE-MIDI, non testé sur matériel |

Exemple sans pilote, un ESP32 qui envoie des lignes de texte :

```json
{ "tagName": "sonic-bluetooth", "attributes": { "id": "esp", "profile": "uart-nus", "for": "go", "control": "ui.esp" } }
{ "tagName": "sonic-value", "attributes": { "dataProvider": "espState", "key": "values.rx.text" } }
```

Envoyer : écrire `{ "write": { "n": 1, "text": "led on\n" } }` dans `ui.esp`.

### Sécurité

- Les services de mise à jour de micrologiciel (DFU), HID et FIDO sont refusés, même demandés.
- Avec le profil `luck`, le passage en mode mise à jour, la remise à zéro d'usine et le réglage d'extinction sont refusés en écriture.
- 512 octets au plus par écriture ; filtres, canaux et charges utiles sont validés.

## `sonic-label-printer`

| Attribut | Rôle |
|---|---|
| `transport` | `#id` du `sonic-bluetooth` |
| `source` | `#id` d'une source d'images (`sonic-sketch`, `sonic-paint`, `sonic-still`, `sonic-2d`, `sonic-shader`…), d'un `canvas` ou d'une `img` |
| `protocol` | `auto` (défaut, d'après le nom de l'appareil, puis le profil du transport), `luck-aiyin`, `luck-lujiang`, `escpos`, `niimbot…`, `cat`, `phomemo`, `phomemo-m02`, `phomemo-m110`, `phomemo-d30` |
| `width-px` | Largeur de la tête en points pour un modèle inconnu (384 pour un ticket 58 mm) |
| `label-mm` | `"30x12"` : longueur × largeur. Défaut selon le modèle |
| `orientation` | `landscape` (défaut : on dessine dans le sens de la longueur) ou `portrait` |
| `fit` | `contain` (défaut), `cover`, `stretch` |
| `dither` | `threshold` (défaut : texte, traits, QR codes), `floyd` (photo), `atkinson`, `bayer` |
| `threshold` | 0..255 (128). Plus haut : plus de noir |
| `density` | 0 clair, 1 normal, 2 foncé |
| `paper` | `gap` (étiquettes séparées, défaut), `black-mark`, `continuous` |
| `copies` | 1..50 |
| `flip` | Retourne l'impression d'un demi-tour, si l'étiquette sort à l'envers |
| `show-preview` | Affiche l'aperçu 1 bit à la place du composant (largeur par `style`) |

Commandes : `print {n, copies}` (défaut de `for`), `preview`, `feed`, `refresh` (relit batterie et état), `cancel` (effectif entre deux copies). Les réglages se changent en direct dans `control` : `{ "dither": "floyd", "threshold": 140, "copies": 3 }`.

État : `{ status, error, active, protocol, model, firmware, head {widthPx, dpi}, battery, charging, paper, cover, overheated, printing, progress, copy, copies, jobs, preview {width, height, ink}, issues, settings }`.

- `jobs` augmente à chaque impression terminée (`trigger`).
- `preview.ink` : part de points noirs (0..1). `0` : rien à imprimer, l'impression est refusée.
- `issues` : remarques pour l'auteur du document (valeur ramenée dans ses bornes, modèle non reconnu).

### Modèles

| Appareil | `protocol` | Tête | État |
|---|---|---|---|
| Fichero d'Action (`FICHERO_…`), AiYin D11s | `luck-aiyin` | 96 points, 203 dpi, 12 mm | protocole validé par `0xMH/fichero-printer` (micrologiciel 2.4.6) |
| Autres Fichero, LuckP, DP, L12, L13 | `luck-lujiang` + `width-px` | selon modèle | non testé |
| Tickets 58 mm ESC/POS | `escpos` + `width-px="384"` | 384 points | non testé |
| Niimbot D11, D110, D101, B16, B18, B1, B21 (`D110-…`, `B1-…`) | `niimbot` (transport `profile="niimbot"`) | lue sur l'imprimante : 96 points (D11, D110, B18), 192 (D101), 384 (B1, B21) | écrit d'après la documentation communautaire, **non testé sur matériel** |
| Imprimantes « chat » GB01, GB02, GB03, GT01, YT01, MX05 à MX10, X5 | `cat` (transport `profile="cat"`) | 384 points, 203 dpi, papier continu 57 mm (48 mm imprimables) | écrit d'après documentation, **non testé sur matériel** |
| Phomemo M02, M02S, T02 (tickets) | `phomemo` ou `phomemo-m02` (transport `profile="phomemo"`) | 384 points | écrit d'après documentation, **non testé sur matériel** |
| Phomemo M110, M120, M200 (étiquettes) | `phomemo` ou `phomemo-m110` | 384 points, étiquette par défaut 40 x 30 mm | idem ; réglages constructeur supposés |
| Phomemo D30, D35 (étiquettes 12 mm) | `phomemo` ou `phomemo-d30` | 96 points, étiquette par défaut 40 x 12 mm | idem ; préambule supposé |

### Imprimantes « chat »

`profile="cat"` sur le transport, `protocol="auto"` (ou `cat`) sur l'imprimante. Papier continu : `label-mm` donne la longueur imprimée et la largeur (48 mm au plus), `"60x48"` par défaut ; `paper` est ignoré. `density` 0, 1, 2 règle l'énergie de chauffe et la vitesse (valeurs supposées : si c'est trop pâle, `density: 2`). Les lignes partent quatre par écriture avec une courte pause ; une demande de pause de l'imprimante (tampon plein) est respectée. `refresh` lit papier et capot (sens des bits supposé). Les modèles récents qui exigent des lignes compressées ne sont pas gérés.

### Phomemo

`profile="phomemo"`, `protocol="auto"` : la famille vient du nom annoncé (`M110…` étiquettes, `D30…` petites étiquettes, le reste en tickets). Pour un nom inconnu, imposer `phomemo-m02`, `phomemo-m110` ou `phomemo-d30`. Le raster `GS v 0` et l'avance `ESC d` sont sûrs ; les commandes constructeur (`1F 11 …` type de papier, `1B 4E …` vitesse et noirceur de la M110, préambule de la D30) sont reprises des outils communautaires sans documentation officielle. Batterie et état ne sont pas lus.

### Niimbot

Le transport est `profile="niimbot"`, ou `profile="luck niimbot"` pour accepter une Fichero ou une Niimbot avec le même bouton. `protocol="auto"` reconnaît l'imprimante à son nom, sinon au profil retenu, puis lit son modèle : la tête (`head`) et l'étiquette par défaut en découlent (30 x 12 mm sur les petites, 50 x 30 mm sur B1 et B21 : donner `label-mm` si le rouleau diffère).

La séquence d'impression dépend du modèle. `niimbot` la choisit d'après le modèle lu ; pour une imprimante que la table ne connaît pas, ou si rien ne sort, imposer une variante :

| `protocol` | Séquence | Modèles |
|---|---|---|
| `niimbot-d110` | effacement, page, dimensions sur 4 octets, quantité, lignes, attente par l'état d'impression | D110, D11 récents, B16, B18, B21S |
| `niimbot-b1` | début de tâche sur 7 octets, dimensions sur 6 octets | B1, B21 C2B, D110 M, D101 |
| `niimbot-d11v1` | dimensions sur 2 octets, fin annoncée par l'imprimante | anciens D11 |
| `niimbot-b21v1` | comptes de points en total, fin obtenue en répétant la fin de tâche | B21 d'origine |
| `niimbot-v4` | dimensions sur 13 octets | D11 H, B1 Pro, B21 Pro, protocoles 4 et plus |

`density` 0, 1, 2 devient la noirceur minimale, normale et maximale du modèle. `paper` : `gap`, `black-mark`, `continuous`. La commande `feed` n'a pas d'équivalent commun : elle ne fait rien. Les rouleaux à puce RFID ne sont ni lus ni écrits.

## MIDI Bluetooth

`profile="midi"` : clavier, pad ou contrôleur MIDI Bluetooth LE (spécification « MIDI over Bluetooth LE »). Les paquets reçus (horodatage, statut courant, plusieurs messages par paquet, SysEx sur plusieurs paquets) sont décodés par le transport lui-même ; aucun autre composant n'est nécessaire. Sur ordinateur, un appareil déjà appairé par le système apparaît souvent aussi dans `sonic-midi` (Web MIDI), qui reste le choix pour jouer un synthétiseur.

```json
{ "tagName": "sonic-bluetooth", "attributes": { "id": "clavier", "profile": "midi", "for": "connecter", "target": "jeu", "control": "ui.clavier" } }
{ "tagName": "sonic-value", "attributes": { "dataProvider": "clavierState", "key": "midi.last.name" } }
```

| Attribut | Rôle |
|---|---|
| `target` | Id d'un `sonic-store` : chaque message reçu y part en action `{type: "midi:message", payload: <événement>}` |

Événement (même forme de valeurs que `sonic-midi` : canal 1..16, valeurs 0..1) : `{ type, channel, note, name, velocity, value, cc, program, data, t }`.

| `type` | Champs |
|---|---|
| `noteon`, `noteoff` | `channel`, `note`, `name` (`C4`), `velocity` 0..1 (note on de vélocité 0 = `noteoff`) |
| `cc` | `channel`, `cc`, `value` 0..1 |
| `pitchbend` | `channel`, `value` -1..1 |
| `program` | `channel`, `program` |
| `aftertouch` | `channel`, `value` 0..1, `note` pour l'aftertouch polyphonique |
| `sysex` | `data` (`F0 … F7`, 1024 octets au plus) |
| `start`, `continue`, `stop` | transport ; l'horloge (`F8`) et l'active sensing ne sont pas exposés |

`data` porte les octets MIDI du message, `t` l'horodatage de l'appareil en ms (revient à 0 toutes les 8,192 s).

État `<id>State.midi` : `{ last (dernier événement), notes [{note, name, channel, velocity}] (notes tenues, 64 au plus ; CC 120 et 123 vident le canal), n (compteur de messages reçus, utilisable comme trigger), sent }`.

Envoi : `{ "midiSend": { "n": 1, "bytes": [144, 60, 100] } }` dans `control` (ou `hex: "90 3C 64"`) : un ou plusieurs messages complets, statut compris, 256 octets au plus. Le SysEx est refusé en envoi. Chaque paquet porte son horodatage et tient dans une écriture (20 octets par défaut).
