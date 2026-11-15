# Addon `bluetooth` — appareils Bluetooth Low Energy

Addon `@supersoniks/creative-stack/bluetooth` : un appareil Bluetooth piloté par DataProviders, sans JS.

| Composant | Rôle |
|---|---|
| `sonic-bluetooth` | Transport : un appareil choisi par l'utilisateur, ses caractéristiques GATT lues, écrites, écoutées |
| `sonic-label-printer` | Pilote : imprimante thermique d'étiquettes ou de tickets, branchée sur un `sonic-bluetooth` |

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
| `profile` | Profil nommé (tableau ci-dessous) |
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

État : `{ status, error, supported, allowed, active, available, connected, device {id, name}, profile, services [{uuid, characteristics [{uuid, props}]}], channels, values {<alias>: {hex, bytes, text, n, at}}, rx, tx {queued, sent, n}, reconnecting }`.

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
| `midi`, `cat`, `niimbot` | Canaux déclarés ; pas encore de pilote au-dessus | | non testé |

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
| `protocol` | `auto` (défaut, d'après le nom de l'appareil), `luck-aiyin`, `luck-lujiang`, `escpos` |
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

Imprimantes « chat » (GB01, MX05…), Phomemo et Niimbot : prévues, pas encore écrites (voir `SPEC.md`).
