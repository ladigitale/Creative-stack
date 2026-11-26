# Addon `bluetooth` — cahier des charges

Statut : **phases A et B livrées** (socle, `sonic-bluetooth`, `sonic-label-printer` avec `luck-aiyin`, `luck-lujiang`, `escpos`). Phase D en partie : `niimbot`, `cat`, `phomemo` écrits ; phase C : MIDI BLE décodé par le profil `midi` du transport. Restent l'UART, les capteurs et les lumières. La validation sur matériel de `luck-aiyin` par ce dépôt reste à faire : le protocole suit la référence, vérifiée par son auteur sur un D11s.

Objectif : qu'un artefact SDUI, sans JS, puisse **se connecter à un appareil Bluetooth Low Energy**, lire et écrire ses données par DataProvider, et piloter les familles d'appareils courantes par des **pilotes** (imprimantes d'étiquettes, liaisons série, capteurs standard, MIDI, lumières). Premier appareil visé et testable : l'imprimante d'étiquettes **Fichero** (Action).

---

## 0. Existant et contraintes

| Constat | Conséquence |
|---|---|
| Aucun composant Bluetooth, série ou USB dans le dépôt. `sonic-capabilities` ne connaît pas `bluetooth`. | Nouvel addon `bluetooth` ; ajouter la clé `bluetooth` à `META` dans `device/capabilities.ts`. |
| Le socle `DeviceElement` (`src/shared/device/base.ts`) fournit déjà `control` par compteurs, `for`, `out-data-provider`, `rate`, `deviceError`, `policyAllows`. | `sonic-bluetooth` et les pilotes en héritent. Aucune convention nouvelle. |
| `sonic-midi` a déjà `parseMidi`, `encode`, `NoteTracker`, `matchPorts` (`audio/midi/core.ts`). | Le MIDI BLE se branche sur `sonic-midi`, il ne le duplique pas. |
| Sources d'images : contrat `SonicFrameSource` et attribut `source="#id"` (`ocr`, `blobs`, `vectorize`). | Le pilote d'imprimante lit sa source de la même façon. |
| Tramage : uniquement en GLSL (`shader/library/dither-bayer.glsl`) et dans `sketch/prefilter.ts`. | Tramage 1 bit CPU à écrire dans `src/shared/` (petit, pur, testé). |
| Web Bluetooth : Chromium seulement (Chrome, Edge, Opera ; Android, macOS, Windows, ChromeOS, Linux selon version), HTTPS, **pas d'iOS, pas de Firefox, pas de Safari**. | `status: "unsupported"` propre + message ; jamais d'erreur levée. |
| Web Bluetooth ne fait que du **BLE (GATT)**. Le Bluetooth classique (SPP, audio) est hors de portée. | Les appareils SPP relèvent d'un futur `sonic-serial` (§9). |
| Le sélecteur d'appareil du navigateur exige un **geste** et ne s'ouvre qu'une fois par demande. Les services doivent être déclarés **avant** la demande (`filters` / `optionalServices`). | `connect` part d'un clic (`for`) ; les profils portent la liste des services. |
| Chrome interdit certains UUID (liste de blocage GATT) : service HID `1812`, caractéristique numéro de série `2a25`, DFU historique. | Claviers, souris, manettes BLE **inaccessibles** ici : rester sur `sonic-keyboard` / `sonic-controller`. |
| Dans une iframe, il faut `allow="bluetooth"` (Permissions Policy `bluetooth`). | À ajouter à l'iframe du viewer Artefacts et au tableau de `device.md`. |
| Les artefacts sont écrits par un LLM. Un composant d'écriture GATT libre peut envoyer n'importe quoi à l'appareil choisi. | Garde-fous §7 : pas de mise à jour de micrologiciel, pas de remise à zéro d'usine, services refusés. |

---

## 1. Principes

1. **Deux couches.** `sonic-bluetooth` = transport GATT générique. Un pilote = composant qui parle un protocole au-dessus d'un transport désigné par `transport="#id"`.
2. **Pilotes indépendants du transport.** Un pilote ne voit qu'un `SonicBytePipe` (§2). Le même codec servira demain sur Web Serial ou WebUSB.
3. **Codecs purs.** Chaque protocole = fonctions sans DOM ni Bluetooth (`encode…`, `parse…`), testées par vecteurs. Le composant ne fait que la plomberie.
4. **Tout par DataProvider**, état standard `{status, error, supported, allowed, active}`, publication plafonnée par `rate`.
5. **Aucune dépendance npm** en phase A et B. Bibliothèques tierces seulement si le protocole est trop gros à réécrire (Niimbot, §5), chargées à la demande.
6. **Honnêteté sur la validation.** Le manifeste et la doc distinguent « validé sur matériel » et « implémenté d'après documentation, non testé ».

---

## 2. Socle partagé `src/shared/bluetooth/`

```ts
/** Canal d'octets bidirectionnel, quel que soit le transport. */
export type SonicBytePipe = {
  readonly pipeReady: boolean;
  /** Taille maximale d'une écriture (défaut prudent 20 ; profil ou réglage pour plus). */
  readonly chunkSize: number;
  /** Écrit en file : découpe en morceaux, respecte gapMs, ne lève pas en cas de déconnexion (résout false). */
  writeBytes(data: Uint8Array, opts?: { channel?: string; response?: boolean; gapMs?: number }): Promise<boolean>;
  /** Notifications reçues ; retourne la fonction de désabonnement. */
  onBytes(cb: (data: Uint8Array, channel: string) => void): () => void;
  /** Nom annoncé de l'appareil (détection de modèle par les pilotes). */
  readonly deviceName: string;
};
export function isBytePipe(el: unknown): el is SonicBytePipe;
```

- `hex.ts` : `toHex`, `fromHex` (tolère espaces et `0x`), `concat`.
- `uuid.ts` : forme courte (`18f0`, `heart_rate`) vers UUID complet ; table des noms standard utilisés.
- `queue.ts` : file d'écriture sérialisée (une opération GATT à la fois, obligatoire sous Chrome), morceaux, délai entre morceaux, annulation à la déconnexion.
- `profiles.ts` : profils nommés (§3.3).
- `fake-pipe.ts` (tests et démo hors matériel) : `SonicBytePipe` en mémoire, avec script de réponses.
- `src/shared/raster1bit.ts` : niveaux de gris, seuil, Floyd-Steinberg, Atkinson, Bayer 4×4, rotation 90/180/270, miroir, emballage 1 bit MSB à gauche.

---

## 3. `sonic-bluetooth` (transport)

Sans rendu. Hérite de `DeviceElement`. `feature = "bluetooth"`. Implémente `SonicBytePipe`.

### 3.1 Attributs

| Attribut | Rôle |
|---|---|
| `profile` | Profil nommé (§3.3) : remplit filtres, services, canaux, taille de morceau |
| `filters` | JSON `[{ "namePrefix": "FICHERO" }, { "services": ["heart_rate"] }]` ; s'ajoute au profil |
| `services` | Services supplémentaires à ouvrir (séparés par des espaces) |
| `channels` | JSON `{ "tx": "18f0/2af1", "rx": "18f0/2af0" }` : alias vers `service/caractéristique` |
| `notify` | Alias à écouter dès la connexion (défaut : `rx` s'il existe) |
| `chunk-size`, `gap-ms` | Découpage des écritures (défauts du profil, sinon 20 et 0) |
| `auto-reconnect` | Reconnexion au même appareil après une coupure (sans sélecteur), avec recul 1, 2, 4… 30 s |
| `accept-all` | Sélecteur sans filtre. Déconseillé, exige `services` |
| `control`, `for`, `out-data-provider`, `rate` | Conventions `DeviceElement` |

### 3.2 Commandes (`control`) et état

| Commande | Effet |
|---|---|
| `connect` (défaut de `for`) | Ouvre le sélecteur, connecte, découvre les services déclarés, s'abonne à `notify` |
| `disconnect`, `toggle` | |
| `write {channel, hex \| bytes \| text, response}` | Écrit sur un alias |
| `read {channel}` | Lit une caractéristique ; résultat dans `values.<alias>` |
| `subscribe {channel}` / `unsubscribe {channel}` | Notifications |
| `forget` | Oublie l'appareil (`device.forget()` si disponible) |

```ts
type BluetoothState = DeviceBaseState & {
  available: boolean | "unknown";          // navigator.bluetooth.getAvailability()
  connected: boolean;
  device: { id: string; name: string } | null;
  profile: string | null;
  services: { uuid: string; characteristics: { uuid: string; props: string[] }[] }[];
  /** Dernière valeur par alias. `text` seulement si UTF-8 valide. */
  values: Record<string, { hex: string; bytes: number[]; text?: string; n: number; at: number }>;
  rx: number;                               // compteur de notifications (utilisable comme trigger)
  tx: { queued: number; sent: number; n: number };
  reconnecting: boolean;
};
```

Événements DOM : `sonic-bluetooth-connect`, `sonic-bluetooth-disconnect`, `sonic-bluetooth-data {channel, bytes}`.

`active` = connecté. `status` : `idle` → `requesting` (sélecteur ouvert) → `ready` ; annulation du sélecteur = retour à `idle` sans erreur ; refus de politique = `denied`.

Reconnexion après rechargement de page : tenter `navigator.bluetooth.getDevices()` s'il existe (historiquement derrière un drapeau Chrome, à vérifier sur les cibles) ; sinon un clic est nécessaire. Ne jamais promettre une reconnexion silencieuse dans la doc.

### 3.3 Profils (`profiles.ts`)

| Profil | Filtres | Service / écriture / notification | Morceau, délai | Source |
|---|---|---|---|---|
| `luck` | `FICHERO`, `D11s_` | `18f0` / `2af1` / `2af0` | 200, 20 ms | dépôt `0xMH/fichero-printer` (MIT), validé D11s micrologiciel 2.4.6 |
| `uart-nus` | service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` / `…0002` / `…0003` | 20 | Nordic UART (ESP32, micro:bit, Espruino, Adafruit) |
| `uart-issc` | service | `49535343-fe7d-4ae5-8fa9-9fafd205e455` / `…8841-43f4-a8d4-ecbe34729bb3` / `…1e4d-4bd9-ba61-23c647249616` | 20 | UART transparent Microchip |
| `uart-hm10` | service | `ffe0` / `ffe1` / `ffe1` | 20 | modules HM-10 (à vérifier) |
| `cat` | noms `GB0`, `GT01`, `YT01`, `MX0`, `MX10`, `X5` | `ae30` / `ae01` / `ae02` | 20 à ajuster | projets catprinter |
| `niimbot` | noms Niimbot | `e7810a71-73ae-499d-8c15-faa9aef0c3f2` / `bef8d6c9-9c21-4c9e-b632-bd58c1009f9f` (écriture et notification) | selon lib | wiki niim.blue |
| `phomemo` | noms Phomemo | `ff00` / `ff02` / notification à relever | 128 | pyphomemo, phomymo |
| `heart-rate`, `battery`, `csc`, `cycling-power`, `ftms`, `environment` | service standard | UUID SIG | — | spécifications Bluetooth SIG |
| `midi` | service | `03b80e5a-ede8-4b33-a751-6ce34ec4c700` / `7772e5db-3868-4112-a1a9-f2669d106bf3` | 20 | spécification BLE MIDI |

Attention : `D11s_` (AiYin) ressemble aux noms des Niimbot D11. Le pilote d'imprimante confirme le modèle par la commande d'information avant d'imprimer.

---

## 4. Pilote `sonic-label-printer` (imprimantes thermiques)

Sans rendu. `transport="#bt"`.

### 4.1 Attributs, commandes, état

| Attribut | Rôle |
|---|---|
| `protocol` | `auto` (défaut, d'après le nom puis la réponse modèle), `luck-aiyin`, `luck-lujiang`, `escpos`, `cat`, `niimbot`, `phomemo` |
| `source` | `#id` d'une source d'images (`SonicFrameSource`, `canvas`, `img`) |
| `label-mm` | `"30x12"` (longueur × largeur). Défaut selon modèle |
| `orientation` | `landscape` (défaut : le dessin est tourné de 90° pour sortir dans le sens du ruban) ou `portrait` |
| `fit` | `contain` (défaut), `cover`, `stretch` |
| `dither` | `threshold` (défaut), `floyd` (photo), `atkinson`, `bayer` |
| `threshold` | 0..255 (128) |
| `density` | 0..2 pour `luck` ; ramené à l'échelle de chaque protocole |
| `paper` | `gap` (défaut), `black-mark`, `continuous` |
| `copies` | 1..50 |
| `control`, `out-data-provider` | réglages ci-dessus modifiables en direct par `control` |

Commandes : `print {copies}`, `preview`, `feed`, `cancel` (entre deux copies), `refresh` (relit état et batterie).

```ts
type LabelPrinterState = DeviceBaseState & {
  protocol: string | null;
  model: string | null; firmware: string | null;
  head: { widthPx: number; dpi: number } | null;
  battery: number | null; charging: boolean;
  paper: "ok" | "out" | "unknown"; cover: "closed" | "open" | "unknown"; overheated: boolean;
  printing: boolean; progress: number;   // 0..1
  copy: number; copies: number; jobs: number;
  preview: { width: number; height: number; ink: number } | null;
  issues: string[];                      // image redimensionnée, densité ramenée, etc.
};
```

Le composant est aussi une `SonicFrameSource` : `getFrameCanvas()` rend **l'aperçu 1 bit exact** (après redimensionnement, tramage, rotation), pour l'afficher dans l'artefact avant d'imprimer.

### 4.2 Protocole `luck-aiyin` (Fichero D11s) — phase B, validable

Tête 96 px (12 octets par ligne), 203 dpi (8 points/mm) : 12 mm imprimables ; étiquette 30 mm = 240 lignes.

Séquence par copie (délais de la référence) :

```
10 FF 40                      état ; refuser si capot (0x02), papier (0x04), surchauffe (0x10 | 0x40)
10 FF 10 00 dd                densité 0..2, attendre la réponse, 100 ms
10 FF 84 pp                   papier 0 étiquettes, 1 marque noire, 2 continu ; 50 ms
00 × 12                       réveil ; 50 ms
10 FF FE 01                   activation (propre à AiYin) ; 50 ms
1D 76 30 00 0C 00 yL yH       en-tête raster (GS v 0), puis lignes, par morceaux de 200 octets, 20 ms
                              500 ms
1D 0C                         avance à l'étiquette suivante ; 300 ms
10 FF FE 45                   fin ; attendre 0xAA ou "OK", délai max 60 s
```

- Informations : `10 FF 20 F0` modèle, `10 FF 20 F1` micrologiciel, `10 FF 50 F1` batterie `[état, %]`.
- État (`10 FF 40`) : bit 0 impression, 1 capot ouvert, 2 plus de papier, 3 batterie faible, 4 et 6 surchauffe, 5 en charge.
- Erreur `FF nn` : bit 0 surchauffe, 1 capot, 2 papier, 3 batterie.
- Écritures sans réponse (`writeValueWithoutResponse`). Les notifications arrivent fragmentées : accumuler, puis 50 ms de grâce.
- Pixel : 1 = noir, bit de poids fort à gauche.

Vecteur de test : image 96×240 → en-tête `1D 76 30 00 0C 00 F0 00`, 2880 octets de données, 15 morceaux.

### 4.3 Autres protocoles

| Protocole | Appareils | Différence | Phase | Validation |
|---|---|---|---|---|
| `luck-lujiang` | autres Fichero (3561, 4575, 4437), LuckP, DP, L12, L13 | activation `10 FF F1 03`, fin `10 FF F1 45` ; largeur de tête par modèle | B | non testé |
| `escpos` | imprimantes tickets 58 mm BLE génériques | `1B 40`, raster `GS v 0`, avance `1B 4A n` ; `width-px` requis (384 courant) | B | non testé |
| `cat` | GB01/02/03, GT01, YT01, MX05 à MX10, X5 | trames `51 78 cmd 00 len 00 … crc8 FF`, 384 px ; énergie, qualité, avance | D | écrit d'après documentation, non testé sur matériel |
| `phomemo` | M110, M02, T02, D30 | ESC/POS avec extensions constructeur, morceaux de 128 | D | écrit d'après documentation, non testé sur matériel |
| `niimbot` | D11, D110, B1, B21, B1 Pro, B21 Pro, M2 | protocole à paquets, deux variantes de tâche d'impression | D | écrit d'après documentation, non testé sur matériel |

`cat` : écrit (`printer/cat.ts`) d'après WerWolv, `rbaron/catprinter` et `NaitLee/Cat-Printer`, sans code repris. Sûr : cadre, CRC-8 (polynôme 0x07, vérifié sur les trames publiées), `a2` ligne de 48 octets bits inversés, `a1` avance, `a6` lattice, `a4` qualité, `af` énergie, `bd` vitesse, `be` mode, `ae` contrôle de flux venu de l'imprimante (respecté). Supposé : énergie et vitesse par noirceur, bits de l'octet d'état `a3`. Lignes envoyées quatre par écriture avec 15 ms de pause, morceaux du profil (20 octets, 10 ms). Compression `bf` des modèles récents absente.

`phomemo` : écrit (`printer/phomemo.ts`), trois variantes choisies au nom. Sûr : `1B 40`, raster `GS v 0`, avance `1B 64 n`. Supposé : `1F 11 02 04` et requêtes de fin `1F 11 08 / 0E / 07 / 09` (M02), vitesse `1B 4E 0D`, noirceur `1B 4E 04`, papier `1F 11 0A|0B|26`, fin `1F F0 05 00 1F F0 03 00` (M110), préambule `1F 11 24 00` (D30). Aucune lecture d'état ni de batterie.

`niimbot` : écrit (`printer/niimbot.ts`, cinq variantes de tâche reprises de `@mmote/niimbluelib`, sans dépendance), non testé sur matériel. Note d'origine : ne pas réécrire le protocole. Évaluer `@mmote/niimbluelib` (référence de NiimBlue) ou `niimbot-web-bluetooth` (MIT, sans dépendance) ; vérifier licence et taille, charger à la demande.

Table des modèles (`models.ts`) : préfixe de nom → `{ protocol, widthPx, dpi, labelMm par défaut }`. Modèle inconnu : `issues` l'indique et `width-px` devient obligatoire.

---

## 5. Autres pilotes, par utilité

| Rang | Pilote | Ce que ça ouvre | Coût | Phase |
|---|---|---|---|---|
| 1 | `sonic-label-printer` | Imprimer depuis `sonic-sketch`, `sonic-paint`, une scène, un QR code. Matériel à 10 € disponible | moyen | B |
| 2 | `sonic-ble-uart` | **Tout appareil fait maison** (ESP32, micro:bit, Espruino, Arduino) : lignes de texte ou JSON dans les deux sens. Le pilote le plus générique | faible | C |
| 3 | `sonic-ble-sensor` | Capteurs standard sans rétro-ingénierie : cardio, batterie, cadence et puissance vélo, home-trainer, température | faible | C |
| 4 | MIDI BLE dans `sonic-midi` | Claviers et contrôleurs BLE, adaptateurs MIDI sans fil, sur Android notamment | faible | C |
| 5 | `sonic-ble-light` | Rubans LED bon marché (famille ELK-BLEDOM, trames de 9 octets `7E … EF`) : couleur pilotée par l'audio ou un shader | faible | D |
| 6 | `cat`, `phomemo`, `niimbot` | Parc d'imprimantes le plus répandu | moyen à fort | D |
| 7 | LEGO Powered Up, micro:bit natif | Moteurs, capteurs, boutons : jouets programmables | moyen | plus tard |

### 5.1 `sonic-ble-uart`

`transport="#bt"`, `mode="lines"` (défaut) | `json` | `bytes`, `delimiter="\n"`, `encoding="utf-8"`.
- Sortie : `{ line, lines (compteur), value (JSON analysé), history[≤ 50] }`.
- Entrée : commande `send {text}` ; DP `tx` : chaque changement de valeur est envoyé (JSON + délimiteur), plafonné par `rate`.
- `store="id"` : chaque ligne devient `{ type: "uart", payload }`.

### 5.2 `sonic-ble-sensor`

`profile` choisit l'analyseur. État par profil :
- `heart-rate` (`180d`/`2a37`) : `{ bpm, rrMs[], contact, energyKj }`
- `battery` (`180f`/`2a19`) : `{ level }`
- `csc` (`1816`/`2a5b`) : `{ wheelRpm, crankRpm }` ; `cycling-power` (`1818`/`2a63`) : `{ watts, crankRpm }`
- `ftms` (`1826`) : `{ speedKmh, cadenceRpm, watts, inclinePct }`
- `environment` (`181a`) : `{ temperatureC, humidityPct, pressureHpa }`

### 5.3 MIDI BLE

Livré autrement que prévu : le profil `midi` de `sonic-bluetooth` décode lui-même (codec pur `midi/ble-midi.ts` de cet addon : horodatage, statut courant, messages multiples par paquet, SysEx sur plusieurs paquets en réception) et publie `midi {last, notes, n, sent}`, action `midi:message` vers `target`, envoi `midiSend {n, bytes | hex}` (SysEx refusé en envoi). Forme des événements alignée sur `sonic-midi` (canal 1..16, valeurs 0..1), sans import entre addons. Écrit d'après la spécification, non testé sur matériel. Reste possible : `sonic-midi ble="#bt"` pour jouer un instrument. Avant de coder : vérifier si Web MIDI voit déjà les appareils BLE sur les cibles (c'est le cas quand le système les a appairés ; pas garanti sous Android).

### 5.4 `sonic-ble-light`

`protocol="elk-bledom"`. DP `color` (`#rrggbb` ou `{r,g,b}`), `brightness` 0..1, `power`. Plafond 20 écritures/s, dernière valeur gagnante. UUID et variantes d'en-tête (`7E 00`, `7E FF`, `7E 07`) à relever dans les projets `elkbledom` avant implémentation.

---

## 6. Hors de portée (à dire clairement dans la doc)

- Claviers, souris, manettes BLE (service HID bloqué) ; enceintes, casques, imprimantes SPP (Bluetooth classique).
- Appareils à protocole chiffré ou lié au nuage (ampoules Tuya, la plupart des montres).
- Capteurs qui ne font que diffuser des annonces sans connexion : l'écoute des annonces reste expérimentale.
- iPhone et iPad, Firefox, Safari.

---

## 7. Sécurité

1. Jamais de connexion sans geste ; le sélecteur du navigateur est le consentement.
2. Aucune évaluation de code, aucun `innerHTML` ; `filters`, `channels` et les charges utiles sont validés (types, tailles, UUID bien formés).
3. Services refusés par le transport même si demandés : DFU Nordic (`fe59`, `00001530-1212-efde-1523-785feabcd123`), HID, FIDO.
4. `sonic-label-printer` n'expose **ni** la mise à jour de micrologiciel (`10 FF E0…`) **ni** la remise à zéro d'usine (`10 FF 04`) **ni** le réglage d'extinction. Le transport refuse aussi ces préfixes quand le profil est `luck`.
5. Écriture plafonnée : 512 octets par écriture (limite de l'API), 1 Mo par tâche d'impression, 50 copies.
6. Nettoyage au `disconnectedCallback` : désabonnement, file vidée, `gatt.disconnect()`.

---

## 8. Phases et critères d'acceptation

**A. Socle et transport.** `src/shared/bluetooth/*`, `sonic-bluetooth`, clé `bluetooth` dans `sonic-capabilities`, `bluetooth.md`, manifeste (`status: "experimental"`).
- Tests : file d'écriture (ordre, morceaux, délai, annulation), analyse des filtres et canaux, machine d'états avec un faux `navigator.bluetooth`, refus des services interdits.

**B. Imprimante.** `raster1bit.ts`, `sonic-label-printer` avec `luck-aiyin`, `luck-lujiang`, `escpos`.
- Tests : vecteur §4.2, masque d'état, séquence complète sur `fake-pipe` (ordre des trames, attente de `0xAA`), tramages sur images de référence, rotation.
- Validation matérielle : une étiquette 30×12 mm sortie d'un `sonic-sketch`, aperçu 1 bit identique à l'impression, erreur lisible capot ouvert et papier absent.

**C. UART, capteurs, MIDI BLE.** Tests par vecteurs (mesure cardiaque avec et sans intervalles RR, paquets MIDI BLE à statut courant). Démo : cardio → tempo d'un `sonic-sequencer`.

**D. Autres imprimantes et lumières**, une par une, chacune marquée non validée tant qu'aucun matériel ne l'a confirmée.

Chaque phase se termine comme les autres addons : catalogue, validateur Tadaaa, import dans le viewer Artefacts, et `allow="bluetooth"` sur l'iframe du viewer dès la phase A.

---

## 9. `sonic-serial` (livré, addon `serial`)

Le socle (`SonicBytePipe`, file, octets, faux canal) est passé dans `src/shared/pipe/`. `sonic-serial` et le pilote GRBL (`sonic-grbl`, addon `grbl`) sont livrés ; restent à brancher ici les imprimantes en USB.

Même contrat `SonicBytePipe` au-dessus de Web Serial (ordinateur seulement) : imprimantes ESC/POS et Niimbot en USB, appareils Bluetooth classique SPP exposés en port série, machines GRBL (graveurs laser, traceurs à stylo). Les codecs des phases B à D s'y branchent sans changement.

---

## 10. Sources

- Protocole Fichero / AiYin D11s : https://github.com/0xMH/fichero-printer (`docs/PROTOCOL.md`, `web/src/lib/fichero/`), licence MIT
- Niimbot : https://printers.niim.blue/interfacing/connecting/ ; `@mmote/niimbluelib` ; `niimbot-web-bluetooth`
- Imprimantes « chat » : https://werwolv.net/blog/cat_printer ; https://github.com/rbaron/catprinter ; https://github.com/opuu/cat-printer
- Phomemo : https://github.com/mkuhlmann/pyphomemo ; https://github.com/transcriptionstream/phomymo
- ELK-BLEDOM : https://github.com/arduino12/ble_rgb_led_strip_controller ; https://github.com/dave-code-ruiz/elkbledom
- Nordic UART : https://www.espruino.com/BLE+UART
- Liste de blocage GATT : https://github.com/WebBluetoothCG/registries (`gatt_blocklist.txt`)
- État d'implémentation Web Bluetooth : https://github.com/WebBluetoothCG/web-bluetooth (`implementation-status.md`)
