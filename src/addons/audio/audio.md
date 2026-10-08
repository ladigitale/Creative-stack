# Audio (SDUI)

Addon `@supersoniks/creative-stack/audio` : synthèse modulaire déclarative. Un instrument est un **patch**, un arbre SDUI de petits modules câblés entre eux comme un modulaire. Aucun fichier audio, aucun JS : tout se pilote par DataProvider.

Le moteur audio est **partagé** : un seul `AudioContext` par page (y compris avec l'addon `sound`), déverrouillé au premier geste, master avec limiteur toujours actif. Son état est publié dans le DataProvider `audio` : `{ supported, ready, state, sampleRate, latencyS, volume, muted }`.

## Composants

| Tag | Rôle |
|---|---|
| `sonic-patch` | Instrument : compile ses modules (ou un preset), une voix WebAudio par note |
| `sonic-voice` | Portée « par note » ; plusieurs `sonic-voice` avec `sample` / `note` = un kit |
| `sonic-osc` `sonic-noise` `sonic-karplus` `sonic-grain` | Sources (oscillateur, bruit, corde pincée, granulaire) |
| `sonic-mixer` `sonic-filter` `sonic-vca` `sonic-shaper` `sonic-pan` | Traitements |
| `sonic-env` `sonic-lfo` | Modulations (enveloppe 0..1, LFO -1..1) |
| `sonic-ladder` `sonic-fold` `sonic-resonator` | Filtre ladder, wavefolder, résonateur |
| `sonic-delay` `sonic-reverb` `sonic-chorus` `sonic-comp` | Effets |
| `sonic-mod` | Câble de modulation |
| `sonic-param` | Paramètre lu dans un DataProvider, ou exposé au preset |
| `sonic-sequencer` | Horloge musicale : motifs en mini-notation joués sur des instruments, ou pas envoyés à un store |
| `sonic-sampler` | Joue des samples (URL, enregistrement en DataProvider), par nom ou chromatiquement |
| `sonic-audio-analyser` | Niveaux, bandes, attaques, hauteur en DataProvider + texture pour `sonic-shader` |
| `sonic-mic` | Micro : source pour l'analyseur, un patch, un enregistreur (jamais vers les haut-parleurs sauf `monitor`) |
| `sonic-audio-input` | Module de patch : entrée externe (micro, vidéo, sampler…) ; un patch sans voix devient une chaîne d'effets |
| `sonic-midi` | Web MIDI : claviers et contrôleurs MPE en entrée, notes / CC / horloge vers des appareils |
| `sonic-audio-recorder` | Enregistre une source en prise (SonicMediaRef) rejouable par le sampler, téléchargeable |
| `sonic-audio-unlock` | Bouton « Activer le son » (caché une fois actif) ; `start="mic"` démarre aussi le micro |
| `sonic-audio-master` | Volume / muet du master |

## Le plus court : un preset

```json
{ "tagName": "sonic-patch", "attributes": {
  "id": "lead", "preset": "synth/lead", "params": "{\"cutoff\":1100}",
  "events": "game.notes", "trigger": "game.tick" } }
```

| Preset | Son | `params` |
|---|---|---|
| `synth/lead` | 2 scies désaccordées, filtre à enveloppe, délai | `cutoff`, `reso` |
| `synth/bass` | scie + sous-oscillateur, filtre résonant | `cutoff`, `reso` |
| `synth/pad` | nappe lente, LFO, chorus, réverb | `cutoff`, `attack` |
| `synth/pluck` | corde pincée | `cutoff`, `decay` |
| `synth/fm-bell` | cloche FM 2 opérateurs | `level` |
| `synth/chip` | impulsion 25 %, son 8 bits | `pw` |
| `synth/string` | corde Karplus-Strong (suit le bend MPE) | `decay`, `damp` |
| `synth/sync-lead` | synchro dure balayée par enveloppe (et par la pression), ladder | `sweep`, `cutoff` |
| `synth/acid` | scie dans un ladder résonant, enveloppe courte | `cutoff`, `reso`, `accent` |
| `drums/kick` `drums/snare` `drums/hat` | batterie de synthèse | — |
| `drums/kit` | `kick` (C2) `snare` (D2) `clap` (D#2) `hat` (F#2) `openhat` (A#2) | — |

## Jouer des notes

`events` désigne un DataProvider contenant une **liste d'événements** :

```json
[{ "note": "C4", "vel": 0.8, "durS": 0.4 }, { "note": "E4" }, { "sample": "kick" }]
```

| Champ | Rôle |
|---|---|
| `note` | `"A4"`, `"C#3"`, `"Bb2"` ou numéro MIDI |
| `sample` | Nom de pad (`drums/kit`, ou `sonic-voice sample="…"`) |
| `vel` | 0..1 (défaut 0.8) |
| `durS` | Durée en s (défaut : attribut `dur-s` du patch, 0.3) |
| `type` | `note` (défaut), `noteOn` (tenue jusqu'au `noteOff`), `noteOff`, `param` (`path`, `value`, `rampS`), `expr` (expressions d'une note tenue), `cc` (vers un appareil MIDI : `cc`, `value` 0..1) |
| `bend`, `pressure`, `timbre` | Expressions : bend en demi-tons, pression et timbre 0..1 (valeurs initiales d'un `noteOn`, ou mises à jour avec `type: "expr"`) |
| `ch` | Canal MIDI 1..16 (entrée MIDI, ou sortie vers un appareil) |
| `id` | Dédoublonnage : un id déjà joué est ignoré |
| `when` | Instant audio précis (séquenceur) ; passé de plus de 50 ms = ignoré |

**Quand la liste est-elle jouée ?**
- Avec `trigger` (recommandé avec un `sonic-store`) : à chaque changement de la valeur de `trigger`. Un compteur incrémenté par le reducer suffit, même si la liste est identique (deux fois la même note).
- Sans `trigger` : quand le contenu de la liste change.

Reducer type :

```jsonata
$merge([$state, {"notes": [{"note": "C4"}], "tick": $state.tick + 1}])
```

La note jouée au moment même où l'utilisateur active le son n'est pas perdue : elle part dès que le moteur est prêt.

## Écrire un patch

```json
{ "tagName": "sonic-patch", "attributes": { "id": "warm", "events": "game.notes", "trigger": "game.tick" },
  "nodes": [
    { "tagName": "sonic-voice", "nodes": [
      { "tagName": "sonic-osc",    "attributes": { "name": "o1", "wave": "sawtooth", "detune": "-8" } },
      { "tagName": "sonic-osc",    "attributes": { "name": "o2", "wave": "square", "octave": "-1" } },
      { "tagName": "sonic-mixer",  "attributes": { "name": "mix", "in": "o1 o2", "levels": "0.5 0.35" } },
      { "tagName": "sonic-env",    "attributes": { "name": "fenv", "a": "0.01", "d": "0.4", "s": "0.2", "r": "0.4" } },
      { "tagName": "sonic-filter", "attributes": { "name": "flt", "in": "mix", "type": "lowpass", "freq-hz": "900", "q": "5" } },
      { "tagName": "sonic-env",    "attributes": { "name": "aenv", "a": "0.01", "d": "0.3", "s": "0.6", "r": "0.5" } },
      { "tagName": "sonic-vca",    "attributes": { "name": "amp", "in": "flt", "gain": "aenv" } },
      { "tagName": "sonic-mod",    "attributes": { "from": "fenv", "to": "flt.freq-hz", "amount": "2400" } },
      { "tagName": "sonic-mod",    "attributes": { "from": "voice.vel", "to": "flt.freq-hz", "amount": "600" } }
    ]},
    { "tagName": "sonic-lfo",    "attributes": { "name": "wob", "rate-hz": "0.4" } },
    { "tagName": "sonic-mod",    "attributes": { "from": "wob", "to": "o1.detune", "amount": "10" } },
    { "tagName": "sonic-delay",  "attributes": { "name": "dly", "time": "3/16", "feedback": "0.35", "mix": "0.25" } },
    { "tagName": "sonic-reverb", "attributes": { "name": "rev", "size-s": "2.2", "mix": "0.25" } },
    { "tagName": "sonic-param",  "attributes": { "to": "flt.freq-hz", "source": "game.cutoff", "ramp-s": "0.08", "min": "150", "max": "8000" } }
  ]}
```

### Règles

- **Dans `sonic-voice`** : modules recréés à chaque note. Sources implicites : `voice.pitch` (Hz de la note), `voice.gate` (0/1), `voice.vel`, `voice.note` (MIDI), `voice.rand` (0..1 tiré à chaque note), et les **expressions** qui bougent pendant la note : `voice.bend` (demi-tons), `voice.pressure` (0..1, aftertouch), `voice.timbre` (0..1, CC74 en MPE). Le bend s'applique tout seul aux oscillateurs qui suivent la note ; pression et timbre se branchent avec `sonic-mod` (`from="voice.pressure" to="flt.freq-hz" amount="2000"`).
- **Hors de `sonic-voice`** : modules créés une fois (LFO communs, effets). `voices` = somme des voix ; le premier effet global la reçoit automatiquement.
- **Audio** : `in="o1 o2"` (plusieurs = somme). Sans `in` : entrée = module audio précédent. Un `sonic-mixer` sans `in` prend toutes les sources précédentes non utilisées.
- **Sortie** : dernier module audio de la voix (ou `out` sur `sonic-voice`) ; dernier module global (ou `out` sur le patch).
- **Modulation** : `sonic-mod from="fenv" to="flt.freq-hz" amount="2400"` ajoute `source × amount` à la valeur du paramètre, dans ses unités (Hz, cents…). `curve="exp"` (vers `freq-hz` d'un oscillateur ou d'un filtre) : `amount` en demi-tons. Raccourci : un paramètre modulable peut recevoir un nom (`gain="aenv"`) ou `freq-hz="voice.pitch"`.
- Un module global peut moduler une voix (LFO commun), pas l'inverse.
- **Boucles** autorisées seulement à travers un `sonic-delay`.
- **Noms** (`name`) locaux au patch ; seul le patch a un `id`.
- **Kit** : plusieurs `sonic-voice`, chacun avec `sample="kick"` et/ou `note="C2"` ; un seul peut rester sans clé (voix par défaut). Une voix à clé garde sa propre hauteur (`freq-hz` fixe).

### Modules

| Module | Paramètres (défaut) — *modulables en italique* |
|---|---|
| `sonic-osc` | `wave` (sawtooth : sine square sawtooth triangle pulse), *`freq-hz`* (voice.pitch), *`detune`* (0, cents), `octave`, `semi`, `pw` (0.5, pulse), `harmonics` (`"1 0.5 0.33"` → forme sur mesure), *`level`* (1), `fm` (module modulateur), `fm-amount` (200 Hz), `sync` (nom d'un autre `sonic-osc` : synchro dure ¹) |
| `sonic-noise` | `color` (white pink brown), *`level`* |
| `sonic-mixer` | `levels` (`"0.6 0.4"`) |
| `sonic-filter` | `type` (lowpass highpass bandpass notch lowshelf highshelf peaking allpass), *`freq-hz`* (1200), *`q`* (1), *`gain-db`* |
| `sonic-vca` | *`gain`* (1) |
| `sonic-env` | `a` `d` `s` `r` (0.005, 0.1, 0.7, 0.2) |
| `sonic-lfo` | `wave`, *`rate-hz`* (2), `sync` (`1/8` : calé sur `bpm` du patch) |
| `sonic-shaper` | `curve` (soft hard fold bit), `drive` (2), `oversample` |
| `sonic-pan` | *`pan`* (-1..1) |
| `sonic-delay` | *`time`* (0.25 s ou `3/16`), *`feedback`* (0.35), `mix` (0.3), `tone` (6000 Hz) |
| `sonic-reverb` | `size-s` (2), `damp` (0.5), `mix` (0.25) |
| `sonic-chorus` | *`rate-hz`* (0.8), `depth` (3 ms), `delay` (12 ms), `mix` (0.5) |
| `sonic-comp` | *`threshold-db`* (-18), *`ratio`* (4), *`knee`*, *`attack`*, *`release`* |
| `sonic-ladder` ¹ | *`freq-hz`* (1000), *`res`* (0.3 ; auto-oscillation vers 1), *`drive`* (1), *`detune`* |
| `sonic-fold` ¹ | *`amount`* (2, 0..12), *`bias`* (0), `mix` (1) |
| `sonic-karplus` ¹ | *`freq-hz`* (voice.pitch), *`detune`*, `decay` (1.5 s), `damp` (0.4), *`level`* |
| `sonic-resonator` | *`freq-hz`* (voice.pitch), *`detune`*, `q` (40), `partials` (`"1 2 3 4 5 6"`), *`level`* — à exciter : bruit, `sonic-audio-input`… |
| `sonic-grain` | `sample` (URL ou chemin DP d'une prise), `position` (0.5), `spread` (0.05), `size-s` (0.08), `density` (24 grains/s), `pitch` (0), `jitter` (0 demi-ton), *`level`* |

¹ Processeur **AudioWorklet**, chargé une fois par page avant le premier son (le patch reste `idle` le temps du chargement). S'il est indisponible (navigateur, CSP), le module passe sur une version native approchée et l'état du patch le dit (`warnings`). Les modules qui suivent la note (`freq-hz="voice.pitch"`) suivent aussi le bend MPE.

**Granulaire** : `sonic-grain` découpe un son (URL `https:` / `blob:`, ou chemin DP d'un SonicMediaRef, par exemple une prise `takes.voix` de `sonic-audio-recorder` : une nouvelle prise remplace le son) en grains de `size-s` secondes, `density` fois par seconde, autour de `position` (0..1, ± `spread`). Dans une voix, la hauteur suit la note (C4 = vitesse d'origine). Tous ses réglages se changent pendant le jeu avec `sonic-param source="dp.pos"` ; le son est chargé une fois par page, partagé entre voix.

**Fichier des processeurs** : avec un bundler (le viewer Artefacts), il est servi à côté du code. Avec les bundles autonomes (`dist/creative-stack-audio.*.js`) il est embarqué en `data:` ; sous une CSP stricte (`script-src` sans `data:`), servir `dist/creative-stack-audio-worklet.js` (ou `src/addons/audio/worklet/processors.js` via jsDelivr) et appeler `AudioEngine.setWorkletUrl(url)` (ou `window.__creativeStackWorkletUrl = url` avant le chargement).
| `sonic-audio-input` | `source` (`#mic` : `#id` d'une source audio ; `in` : reçoit ce qui est routé vers le patch), *`level`* (1). Hors de `sonic-voice` uniquement |

**Traiter une entrée** : un patch peut n'avoir **aucun** `sonic-voice` s'il contient un `sonic-audio-input`. Il devient une chaîne d'effets toujours active (micro nettoyé avant enregistrement, voix passée dans un délai…). Avec des voix, l'entrée se mélange aux notes (`sonic-mixer` sans `in` prend `voices` et l'entrée). L'entrée se branche dès que la source est prête (micro activé, vidéo chargée) ; l'état du patch l'indique : `inputs: { "voix": true }`. `source="master"` est refusé (boucle). Un autre élément peut aussi envoyer son son au patch : `output="#fx"` (premier `sonic-audio-input` du patch).

```json
{ "tagName": "sonic-patch", "attributes": { "id": "clean", "output": "none" }, "nodes": [
  { "tagName": "sonic-audio-input", "attributes": { "name": "voix", "source": "#mic" } },
  { "tagName": "sonic-filter", "attributes": { "type": "highpass", "freq-hz": "110" } },
  { "tagName": "sonic-comp", "attributes": { "threshold-db": "-24" } } ] }
```

Micro + `output` autre que `none` = risque de Larsen sans casque : préférer `output="none"` et enregistrer / analyser `#clean`.

### `sonic-patch`

| Attribut | Rôle |
|---|---|
| `preset`, `params` | Patch de la bibliothèque et valeurs de ses paramètres exposés |
| `events`, `trigger` | DataProviders d'événements (voir plus haut) |
| `poly` (8), `steal` (oldest quietest same-note) | Polyphonie |
| `vel-sense` (0.6) | Part de la vélocité dans le volume |
| `gain` (0.6) | Volume du patch |
| `bpm` (120) | Pour `time="3/16"` et `sync="1/8"` |
| `dur-s` (0.3) | Durée d'une note sans `durS` |
| `output` | `master` (défaut), `#id` d'un élément qui reçoit du son, `none` |
| `notes-map` | `{"kick": 36}` : noms → notes pour les événements `sample` |
| `out-data-provider` | État publié (défaut `<id>State`) |

**État publié** : `{ status: "idle" | "ready" | "error" | "unsupported", preset, voices, played, inputs, errors, warnings }`. `idle` = en attente du premier geste. Les erreurs (module inconnu, paramètre inexistant, boucle sans délai…) rendent le patch muet ; les avertissements (valeur invalide, attribut inconnu) sont ignorés et le patch joue.

### `sonic-param`

`to="flt.freq-hz"` + au choix `source="game.cutoff"` (DP, rampe `ramp-s`, bornes `min` / `max`), `expose="cutoff"` (réglable par `params` du patch), `value="900"`. Un paramètre non modulable (`a`, `d`, `wave`…) s'applique aux notes suivantes.

## Séquenceur (`sonic-sequencer`)

Horloge calée sur l'audio (ordonnancement anticipé : précision à l'échantillon, mesurée à 0,1 ms près). Deux usages, cumulables :

**Direct** — `pattern` joue des lignes sur des instruments désignés par leur `id` (`sonic-patch`, `sonic-sampler`) :

```json
{ "tagName": "sonic-sequencer", "attributes": {
  "id": "seq", "bpm": "112", "swing": "0.1", "control": "game.transport",
  "pattern": "{\"kit\":{\"kick\":\"x...x...x...x...\",\"snare\":\"....x.......x...\",\"hat\":\"[..x.]*4\"},\"bass\":{\"notes\":\"0 ~ 0 [2 4]\",\"scale\":\"a2:minor-pentatonic\"},\"lead\":\"<c5 e5 g5 [a5 g5]>\"}" } }
```

- Clé de premier niveau = `id` de l'instrument.
- Valeur chaîne = ligne de notes. Valeur objet : `notes` (ligne de notes) et/ou des lignes de pads (`"kick": "x..."` envoie `{ sample: "kick" }`), plus `scale` (`"a:minor-pentatonic"`, `"c3:dorian"`…), `octave`, `vel` (0.8), `gate` (part de la case tenue, 0.9), `transpose`.

**Store** — `store="life"` envoie à chaque pas, en avance de `lookahead-ms` (100), l'action `{ type: "step", payload: { step, beat, bar, phase, when, bpm } }`. Le reducer écrit des notes avec ce `when` dans un DataProvider lu par un instrument (`events`) : la musique calculée tombe exactement sur le temps. Le reducer doit répondre en moins de `lookahead-ms` (augmenter `budget-ms` du store et `lookahead-ms` pour un reducer lourd).

**Horloge externe** : `sync="#midi"` (un `sonic-midi`) : Start / Continue / Stop, tempo mesuré et phase viennent de l'appareil (Elektron, DAW…). La phase est recalée à chaque temps ; l'état publie `sync: { source, locked, driftMs }`. Sans horloge reçue, `playing` / `control` marchent comme d'habitude.

**Pilotage** : `control` (DP) `{ playing, bpm, swing, seed, pattern }` ; attributs `playing`, `bpm`, `swing`, `seed`, `beats` (4), `steps-per-beat` (4). Le tempo change sans saut. Le séquenceur démarre au premier geste si `playing` est vrai.

**État** (`out-data-provider`, défaut `<id>State`) : `{ status, playing, bpm, swing, step, beat, bar, phase, sync, errors, warnings }`, publié quand le pas est **entendu** (latence de sortie comprise).

### Mini-notation

Une ligne décrit **une mesure** ; ses éléments se partagent le temps.

| Écriture | Sens |
|---|---|
| `x...x...x...x...` | grille : un caractère par pas (`x` frappe, `X` accent, `.` silence) |
| `c4 e4 g4 b4` | 4 notes réparties sur la mesure |
| `c4 [e4 g4]` | sous-division |
| `~` ou `.` | silence |
| `c4 - e4 _` | `-` / `_` prolongent l'élément précédent |
| `<c4 e4 g4>` | alternance : un élément par mesure |
| `x*4` `[x .]*2` | répétition dans la case |
| `c4!3` | duplication en 3 cases |
| `c4@3 e4` | poids (c4 dure 3 fois plus) |
| `x?0.3` | probabilité (défaut 0.5), tirage déterministe : même `seed`, même musique |
| `x(3,8)` `x(3,8,2)` | rythme euclidien (k frappes sur n pas, rotation à gauche) |
| `[c4, e4, g4]` ou `c4+e4+g4` | accord |
| `0 2 4 7` | degrés de `scale` (sinon notes MIDI) |

Une grille plus courte que la mesure ne se répète pas (`..x.` = une frappe au 3e quart) ; pour répéter : `[..x.]*4`.

## Sampler (`sonic-sampler`)

```json
{ "tagName": "sonic-sampler", "attributes": {
  "id": "drums",
  "samples": "{\"kick\":\"https://exemple.org/kick.wav\",\"snare\":{\"url\":\"https://exemple.org/snare.wav\",\"gain\":0.8},\"voix\":{\"ref\":\"rec.last\",\"root\":\"C4\"}}",
  "choke": "[[\"hat\",\"openhat\"]]" } }
```

- Sources : URL `https:`, `blob:`, `data:audio/…` ou relative ; ou `ref` = DataProvider contenant un `SonicMediaRef` (`{ url }`), par exemple un enregistrement.
- Par sample : `gain`, `pan`, `pitch` (demi-tons), `root` (note de référence pour jouer chromatiquement), `start`, `end` (s), `loop`, `reverse`, `gate` (couper à la fin de la note ; sinon le sample est joué en entier).
- Événements : `{ sample: "kick" }`, ou `{ note: "E4" }` (sample `chromatic`, sinon le premier qui a un `root` ; `notes-map` pour associer des notes à des noms).
- `choke` : groupes où jouer un sample coupe les autres (charleston ouvert / fermé).
- Mêmes `events` / `trigger` / `output` que `sonic-patch`. État : `{ status, loaded, total, samples, empty, voices, played, errors }` ; `empty` liste les samples `ref` encore vides (pad pas encore enregistré, sans bloquer `ready`). Les samples sont décodés avant même le premier geste ; une nouvelle prise écrite dans le `ref` remplace le son du pad.

## Analyseur (`sonic-audio-analyser`)

```json
{ "tagName": "sonic-audio-analyser", "attributes": { "id": "spectre", "source": "master", "bands": "16", "rate": "30" } }
```

- `source` : `master` (défaut) ou `#id` d'un patch / sampler (suivi même si le patch est recompilé).
- État (`out-data-provider`, défaut `<id>State`) : `rms`, `peak`, `db`, `bands` (0..1, échelle log 40 Hz – 16 kHz), `centroidHz`, `onset` (attaque à cette mise à jour), `onsetCount` (compteur, utilisable comme `trigger`), `pitchHz` (avec l'attribut `pitch`).
- **Texture** : `sonic-shader channel0="#spectre"` reçoit une image de 512 × 2 (ligne du haut : spectre, ligne du bas : forme d'onde). Dans le shader : `texture(iChannel0, vec2(x, 0.25)).r` pour le spectre, `vec2(x, 0.75)` pour l'onde.
- `fft` (2048), `smoothing` (0.7), `onset-threshold` (1.5).

## Micro (`sonic-mic`)

```json
{ "tagName": "sonic-mic", "attributes": { "id": "mic", "control": "game.mic" } }
```

- Démarrage : un clic sur `sonic-audio-unlock start="mic"` (active le son **et** le micro en un geste), `sonic-media-start for="mic"`, `autostart` (premier geste), `active` ou DP `control` `{ active, monitor, gain, deviceId }`. Jamais au chargement.
- `monitor` : écouter le micro dans les haut-parleurs (risque de Larsen sans casque). Par défaut, le micro ne sort **pas** vers le master : il sert de source (`sonic-audio-analyser source="#mic"`, futur enregistreur).
- `echo-cancellation`, `noise-suppression`, `auto-gain` : désactivés par défaut (son brut, pour la création) ; `gain` ; `device-id`.
- État (`<id>State`) : `{ status: idle | requesting | ready | denied | error | unsupported, error, active, rms, peak, db, monitor, deviceId, devices }`. `rms` / `db` à `rate` mises à jour par seconde (15).
- Avec l'analyseur : `pitchHz` (attribut `pitch`) pour un accordeur ou un jeu chanté, `onsetCount` pour des claquements de mains.

## MIDI (`sonic-midi`)

```json
{ "tagName": "sonic-midi", "attributes": { "id": "midi", "mpe": "", "target": "#voix", "store": "jam", "output": "digitone", "clock-out": "#seq" } }
```

Accès demandé **sur geste** seulement (`sonic-media-start for="midi"`, `sonic-audio-unlock start="midi"`, `autostart`, `active`, DP `control`), jamais de SysEx. Le document déclare `"capabilities": ["midi"]`.

**Entrée**
- `input` : `all` (défaut), `none`, `first` ou un morceau de nom (`linnstrument`) ; `channel` : `all` ou `1..16` ; `transpose`.
- `target="#voix #kit"` : les notes jouent directement sur ces instruments (`noteOn` / `noteOff`, sans passer par un store : latence minimale). Pitch bend, pression (canal ou polyphonique) et CC74 arrivent en événements `expr` : dans un patch, `voice.bend`, `voice.pressure`, `voice.timbre` ; dans un sampler, le bend désaccorde la lecture.
- `mpe` : un canal par note (zone basse, canal maître 1 ; `mpe-master="16"` pour la zone haute) ; bend ±48 demi-tons par note (`bend-range`), ±2 sur le canal maître. Sans `mpe`, bend / pression d'un canal touchent toutes ses notes (`bend-range` 2).
- `store="jam"` : chaque message devient `{ type: "midi" (action-type), payload: { kind: "noteOn" | "noteOff" | "cc" | "program" | "start" | "stop" | "beat", ch, note, name, vel, cc, value, beat, bpm } }`. Pas d'horloge à 24 ppq dans le store : un `beat` par noire.
- État (`<id>State`) : `{ status, error, inputs, outputs, input, output, held: [{ note, name, ch, vel, bend, pressure, timbre }], last, notes (compteur), sent, cc: { "74": 0.5 }, bend, pressure, program, clock: { running, bpm, ticks, beat } }`. Valeurs continues publiées au plus `rate` fois par seconde (30).

**Sortie** — `output` : vide (aucune, défaut), `first`, `all` ou morceau de nom ; `out-channel` (1).
- C'est un **instrument** : `sonic-sequencer pattern='{"midi": "c3 ~ e3 g3"}'` joue sur l'appareil, horodaté au son près (même ancre que l'audio) ; ou `events` / `trigger` comme un patch. `ch` dans un événement choisit le canal, `notes-map` associe des pads à des notes.
- `cc-out="knobs"` : DP `{ "74": 0.5, "71": 0.2 }`, chaque valeur changée (0..1) part en CC (pas les valeurs initiales).
- `clock-out="#seq"` : horloge 24 ppq + Start / Stop calée sur le séquenceur (la machine suit le tempo et la mesure de la page). `offset-ms` compense la latence d'un appareil.
- `control` (DP) : `{ active, input, output, channel, outChannel, program, panic: compteur }` — `panic` coupe toutes les notes (CC 123 sur les 16 canaux).

## Enregistreur (`sonic-audio-recorder`)

```json
{ "tagName": "sonic-audio-recorder", "attributes": { "id": "rec", "source": "#mic", "control": "poche.rec", "max-s": "6" } }
```

- `source` : `#mic` (défaut), `#id` d'une source audio (patch, sampler, vidéo `audio-out`) ou `master` (tout ce qu'on entend).
- Pilotage : DP `control` `{ recording: true | false, target: "takes.A" }`. Passer `recording` à `true` démarre une prise, `false` l'arrête ; `max-s` (30) l'arrête de lui-même. Chaque prise est écrite dans `target` (sinon `take-provider`).
- Prise = SonicMediaRef `{ url, mime, durS, size }` (WebM/Opus, ou MP4 sur Safari) : rejouable par `sonic-sampler` (`{"A": {"ref": "takes.A"}}`), téléchargeable avec `sonic-media-download source="recState.last"`.
- `max-takes` (8) : prises gardées en mémoire, les plus anciennes sont libérées.
- État (`<id>State`) : `{ status: idle | waiting-source | ready | recording | error | unsupported, error, recording, elapsedS, last, takes }`.
- Avec un store qui inverse `recording` à chaque clic : si `max-s` a coupé la prise, le clic suivant remet `false` (sans effet) ; prévoir un `max-s` confortable.

## Démo

- `examples/premier-son.sdui.json` : clavier (`sonic-keyboard`) → `sonic-store` → `synth/lead`, un patch écrit à la main avec filtre piloté par le store, et `drums/kit`.
- `examples/nuage.sdui.json` : instrument granulaire sur un son d'exemple ou sur sa voix (prise de 4 s), position / taille / densité réglées par le store, `sonic-fold` et `sonic-ladder` modulés en direct, basse `synth/acid` au séquenceur.
- `examples/jam-midi.sdui.json` : `sonic-midi mpe` → voix expressive (bend, pression → filtre et désaccord, timbre → filtre), pads de secours sans appareil ; batterie `sync="#midi"` qui suit l'horloge d'une machine, « Horloge sortante » qui pilote les machines depuis la page ; panique. Demande `"capabilities": ["midi"]`.
- `examples/sampler-de-poche.sdui.json` : micro nettoyé par un patch d'effets (`sonic-audio-input`) → `sonic-audio-recorder` vers 4 pads (`takes.A`…) → `sonic-sampler` joué à la main et par le séquenceur ; fond `sonic-shader` (spectre du master + onde du micro) ; export vidéo du visuel avec le son (`sonic-media-recorder`) et téléchargement (`sonic-media-download`). Demande `"capabilities": ["microphone"]`.
- `examples/vie-sonore.sdui.json` : jeu de la vie dans un `sonic-store` lu par le séquenceur en mode store (une colonne par pas, une génération par mesure), `synth/pluck`, `drums/kit` en mode direct, fond `sonic-shader` nourri par l'analyseur.

## API JS

```ts
import { AudioEngine, compilePatch, PATCH_LIBRARY } from "@supersoniks/creative-stack/audio";

document.querySelector("sonic-patch#lead").schedule([{ note: "C4", durS: 0.5 }]);
document.querySelector("sonic-midi#midi").send([0xb0, 74, 64]); // message brut vers la sortie
const { errors, warnings } = compilePatch(tree); // pur : validation côté serveur possible
```
