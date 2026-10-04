# Sound (SDUI)

Addon `@supersoniks/creative-stack/sound` : système son léger pour jeux et interfaces.
Tout est **synthétisé en WebAudio**, sans fichier audio : une banque complète (musiques, jingles, bruitages, sons de boutons) tient en quelques Ko de JSON écrit à la main ou par un agent.

- **Entrée** : un DataProvider de pilotage (`control`) — typiquement une sous-clé de l'état d'un `sonic-store`.
- **Sortie** : un DataProvider d'état complet (`out-data-provider`).
- Aucun JS à écrire, aucune URL : compatible avec les artefacts générés.

## Composants

| Tag | Rôle |
|---|---|
| `sonic-sound` | Moteur : banque + pilotage + état publié. Un par page suffit. |
| `sonic-sfx` | Enveloppe des éléments et joue un son au clic (ou autre événement) et au survol. |

### `sonic-sound`

| Attribut | Rôle |
|---|---|
| `bank` | Banque inline `{ "sfx": {…}, "songs": {…} }` |
| `bank-provider` | DataProvider contenant une banque (fusionnée par-dessus `bank`) |
| `control` | DataProvider de pilotage. Chemin pointé accepté : `game.sound` |
| `out-data-provider` | DataProvider de l'état publié (défaut `<id>State`, sinon `soundState`) |
| `id` | Id du moteur (pour `sonic-sfx engine="…"`) |
| `max-voices` | Polyphonie max des bruitages (défaut 32) |

### `sonic-sfx`

| Attribut | Rôle |
|---|---|
| `sound` | Son joué sur l'événement `on` |
| `on` | Événement déclencheur : `click` (défaut), `pointerdown`, `change`, `focusin`… |
| `hover` | Son joué à l'entrée du pointeur sur chaque enfant direct (ignoré au tactile) |
| `pitch`, `vol` | Transposition (demi-tons) et volume |
| `engine` | Id du `sonic-sound` visé (défaut : le premier) |

Les éléments `disabled` / `aria-disabled="true"` ne déclenchent rien.

## Déverrouillage audio

Les navigateurs n'autorisent le son qu'après un geste de l'utilisateur. Le moteur se déverrouille tout seul au premier clic, toucher ou touche clavier ; avant cela, les bruitages sont ignorés et la musique demandée attend. L'état expose `unlocked` : afficher un « Touchez pour jouer » tant qu'il vaut `false`.

## Pilotage (`control`)

```json
{
  "music": "theme",
  "fade": 0.8,
  "paused": false,
  "muted": false,
  "volume": { "master": 0.8, "music": 0.7, "sfx": 1, "ui": 0.8 },
  "play": { "coin": 12, "jump": 3, "hit": { "n": 4, "pitch": 2, "vol": 0.8 } }
}
```

Toutes les clés sont facultatives ; seules celles présentes sont appliquées.

- **`music`** : morceau courant. Changer la valeur enchaîne en fondu (`fade` secondes). `null` coupe la musique.
- **`play`** : **compteurs**. Toute hausse d'un compteur joue le son une fois. La première valeur vue sert de référence (rien ne joue au chargement) ; une baisse redéfinit la référence. Forme objet pour transposer (`pitch`, en demi-tons) ou doser (`vol`) ce déclenchement : idéal pour un combo qui monte.
- Un nom dans `play` peut désigner un bruitage de la banque, un **preset intégré** (sans rien déclarer), ou un **morceau** joué une fois par-dessus la musique (jingle).

Côté reducer JSONata, déclencher un son revient à incrémenter un nombre :

```jsonata
$merge([$state, {"sound": $merge([$state.sound, {"play": $merge([$state.sound.play, {"coin": $state.sound.play.coin + 1}])}])}])
```

## État publié (`out-data-provider`)

```json
{
  "supported": true,
  "unlocked": true,
  "muted": false,
  "paused": false,
  "volume": { "master": 0.8, "music": 0.7, "sfx": 1, "ui": 0.8 },
  "music": { "id": "theme", "playing": true, "ended": false, "bpm": 132, "bar": 3, "beat": 2, "step": 8, "pattern": "A", "loops": 0 },
  "lastSfx": { "id": "coin", "at": 18342 },
  "lastUi": { "id": "click", "at": 18290 },
  "played": { "coin": 12, "click": 30 },
  "voices": 4,
  "sounds": ["coin", "jump", "click", "…"],
  "songs": ["theme", "boss", "win"],
  "errors": []
}
```

`music.bar` / `music.beat` sont publiés à chaque temps, calés sur l'audio : de quoi animer au rythme (`sonic-value`, `sonic-if`, shader param…). `errors` liste en français les problèmes de banque et de pilotage (note invalide, instrument non déclaré, son inconnu…).

## Banque

```json
{
  "sfx": {
    "coin": "coin",
    "jump": { "preset": "jump", "freq": 360 },
    "zap": { "wave": "sawtooth", "freq": 1200, "slide": -24, "dur": 0.12, "vol": 0.2 }
  },
  "songs": {
    "theme": {
      "bpm": 132,
      "instruments": { "lead": "lead", "bass": "bass", "kick": "kick", "snare": "snare", "hat": "hat" },
      "patterns": {
        "A": {
          "lead":  "E5 - - . A5 - G5 - E5 - - . C5 - D5 -",
          "bass":  "A2 . A2 . A3 . A2 . A2 . A3 . A2 . G2 .",
          "kick":  "x . . . x . . . x . . . x . . .",
          "snare": ". . . . x . . . . . . . x . . .",
          "hat":   ". . x ."
        }
      },
      "sequence": ["A", "A"]
    }
  }
}
```

Une chaîne seule (`"coin": "coin"`) vaut `{ "preset": "coin" }`. Un instrument qui porte le nom d'un preset (`"kick": {}`) l'utilise implicitement.

### Voix (`SynthDef`) — bruitages et instruments

| Champ | Défaut | Rôle |
|---|---|---|
| `preset` | — | Part d'un preset, les autres champs le surchargent |
| `wave` | `square` | `sine`, `square`, `triangle`, `sawtooth`, `noise` |
| `freq` | 440 | Hz (pour un instrument, la note la remplace) |
| `transpose` | 0 | Demi-tons ajoutés à la hauteur jouée |
| `slide` | 0 | Glissement en demi-tons pendant `slideTime` (défaut : `dur`) |
| `dur` | 0.15 | Tenue en s (pour un instrument : la longueur de la note) |
| `attack` `decay` `sustain` `release` | .005 .05 .8 .05 | Enveloppe (s, s, 0..1, s) |
| `vol` | 0.3 | 0..1 |
| `arp`, `arpRate` | —, .05 | Arpège en demi-tons (`[0,4,7,12]`) et durée d'un pas |
| `vibrato` | — | `{ "rate": 6, "depth": 5 }` (Hz, Hz) |
| `filter` | — | `{ "type": "lowpass", "freq": 2000, "q": 1, "to": 200 }` (`to` = balayage) |
| `repeat`, `repeatGap` | 1, .05 | Répétitions (double blip, rafale) |
| `jitter` | 0 | Variation aléatoire de hauteur (demi-tons) à chaque lecture |
| `pan` | 0 | -1..1 |
| `layers` | — | Jusqu'à 4 voix superposées (une couche suit la note jouée) |

Bruitages uniquement : `bus` (`sfx` ou `ui`), `cooldown` (ms entre deux lectures, défaut 30).

### Morceau (`SongDef`)

| Champ | Défaut | Rôle |
|---|---|---|
| `bpm` | 120 | Tempo |
| `steps` | 4 | Pas par temps (4 = doubles croches) |
| `beats` | 4 | Temps par mesure |
| `vol` | 0.8 | Volume du morceau |
| `loop` | true | `false` pour un jingle |
| `loopFrom` | 0 | Index de séquence où reprendre (intro jouée une seule fois) |
| `swing` | 0 | 0..0.5, retarde les pas impairs |
| `instruments` | — | Nom → voix |
| `patterns` | — | Nom → { instrument → piste } |
| `sequence` | ordre des motifs | Enchaînement des motifs |

**Notation des pistes** (un jeton par pas, séparés par des espaces) :

| Jeton | Sens |
|---|---|
| `C4`, `F#3`, `Bb2` | Note (octave 4 = do du milieu) |
| `C4+E4+G4` | Accord |
| `-` | Prolonge la note précédente d'un pas |
| `.` | Silence |
| `x` / `X` | Frappe / frappe accentuée (percussions) |
| `G4!` | Note accentuée |
| `\|` | Repère visuel, ignoré |

La longueur d'un motif est celle de sa plus longue piste. Une piste plus courte qui divise cette longueur se répète (`". . x ."` = charleston sur chaque contretemps d'un motif de 16 pas).

### Presets intégrés

- **Interface** (bus `ui`) : `click`, `hover`, `select`, `back`, `toggle`, `error`, `success`, `notify`, `type`
- **Jeu** : `coin`, `pickup`, `jump`, `land`, `shoot`, `laser`, `hit`, `hurt`, `explosion`, `powerup`, `levelup`, `gameover`, `whoosh`, `bounce`, `teleport`, `alarm`, `step`
- **Percussions** : `kick`, `snare`, `hat`, `openhat`, `clap`, `tom`, `shaker`
- **Mélodiques** : `lead`, `chip`, `bass`, `sub`, `pad`, `pluck`, `bell`, `organ`, `flute`, `strings`

Les presets d'interface et de jeu sont jouables directement par leur nom, même absents de la banque.

### Limites

200 bruitages, 50 morceaux, 16 instruments et 64 motifs par morceau, 256 pas par motif, 512 entrées de séquence, 4 couches par voix.

## Exemple SDUI complet

`examples/neon-run.bank.json` (banque de jeu complète, 2,4 Ko) et `examples/sound-lab.artifact.json` (artefact : store + boutons + musique + affichage de l'état).

## API JS

```ts
import { playSound, getSoundEngine, validateSoundBank } from "@supersoniks/creative-stack/sound";

playSound("coin", { pitch: 3 });
const { bank, errors } = validateSoundBank(json); // pur : utilisable côté serveur
```
