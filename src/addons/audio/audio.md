# Audio (SDUI)

Addon `@supersoniks/creative-stack/audio` : synthèse modulaire déclarative. Un instrument est un **patch**, un arbre SDUI de petits modules câblés entre eux comme un modulaire. Aucun fichier audio, aucun JS : tout se pilote par DataProvider.

Le moteur audio est **partagé** : un seul `AudioContext` par page (y compris avec l'addon `sound`), déverrouillé au premier geste, master avec limiteur toujours actif. Son état est publié dans le DataProvider `audio` : `{ supported, ready, state, sampleRate, latencyS, volume, muted }`.

## Composants

| Tag | Rôle |
|---|---|
| `sonic-patch` | Instrument : compile ses modules (ou un preset), une voix WebAudio par note |
| `sonic-voice` | Portée « par note » ; plusieurs `sonic-voice` avec `sample` / `note` = un kit |
| `sonic-osc` `sonic-noise` | Sources |
| `sonic-mixer` `sonic-filter` `sonic-vca` `sonic-shaper` `sonic-pan` | Traitements |
| `sonic-env` `sonic-lfo` | Modulations (enveloppe 0..1, LFO -1..1) |
| `sonic-delay` `sonic-reverb` `sonic-chorus` `sonic-comp` | Effets |
| `sonic-mod` | Câble de modulation |
| `sonic-param` | Paramètre lu dans un DataProvider, ou exposé au preset |
| `sonic-audio-unlock` | Bouton « Activer le son » (caché une fois actif) |
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
| `type` | `note` (défaut), `noteOn` (tenue jusqu'au `noteOff`), `noteOff`, `param` (`path`, `value`, `rampS`) |
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

- **Dans `sonic-voice`** : modules recréés à chaque note. Sources implicites : `voice.pitch` (Hz de la note), `voice.gate` (0/1), `voice.vel`, `voice.note` (MIDI), `voice.rand` (0..1 tiré à chaque note).
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
| `sonic-osc` | `wave` (sawtooth : sine square sawtooth triangle pulse), *`freq-hz`* (voice.pitch), *`detune`* (0, cents), `octave`, `semi`, `pw` (0.5, pulse), `harmonics` (`"1 0.5 0.33"` → forme sur mesure), *`level`* (1), `fm` (module modulateur), `fm-amount` (200 Hz) |
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

**État publié** : `{ status: "idle" | "ready" | "error" | "unsupported", preset, voices, played, errors, warnings }`. `idle` = en attente du premier geste. Les erreurs (module inconnu, paramètre inexistant, boucle sans délai…) rendent le patch muet ; les avertissements (valeur invalide, attribut inconnu) sont ignorés et le patch joue.

### `sonic-param`

`to="flt.freq-hz"` + au choix `source="game.cutoff"` (DP, rampe `ramp-s`, bornes `min` / `max`), `expose="cutoff"` (réglable par `params` du patch), `value="900"`. Un paramètre non modulable (`a`, `d`, `wave`…) s'applique aux notes suivantes.

## Démo

`examples/premier-son.sdui.json` : clavier (`sonic-keyboard`) → `sonic-store` → `synth/lead`, un patch écrit à la main avec filtre piloté par le store, et `drums/kit`.

## API JS

```ts
import { AudioEngine, compilePatch, PATCH_LIBRARY } from "@supersoniks/creative-stack/audio";

document.querySelector("sonic-patch#lead").schedule([{ note: "C4", durS: 0.5 }]);
const { errors, warnings } = compilePatch(tree); // pur : validation côté serveur possible
```
