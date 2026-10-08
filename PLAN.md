# creative-stack — plan

Objectif : qu'un artefact SDUI, sans aucun JS, puisse **capter** (caméra, micro, vidéo, MIDI), **produire du son** (bruitages, synthèse modulaire, sampler, séquenceur), **analyser** (spectre, niveau, attaques) et tout relier aux shaders, à la 3D et aux stores JSONata **par DataProvider**.

Ce plan reprend la spec « creative-stack » (prompt Cursor du 3 octobre) en l'adaptant à ce qui existe maintenant :

- le dépôt est `ladigitale/Creative-stack` ; les addons visuels de `4.9.98-visual-stack.4` y ont été portés ;
- l'addon `sound` (bruitages et musique de jeu légers) est livré et branché dans le viewer Artefacts ;
- **le viewer reste sur Concorde `4.9.98-visual-stack.4`** : ses composants `sonic-shader`, `sonic-3d`, `sonic-store`, `sonic-matrix`… viennent de Concorde. Tout ce qui est nouveau doit fonctionner avec eux tels quels.

## Principes

1. **Tout pilotage passe par DataProvider.** Entrées par chemins DP (notation pointée acceptée : `game.sound`), sorties dans un `out-data-provider`. Pas de registre d'actions propre à creative-stack : le viewer utilise le `sonic-action` de Concorde, qui ne vise que des stores. Pour un mode « store », on appelle `dispatchAction()` sur l'élément `sonic-store` désigné par son id (fonctionne avec le store de Concorde comme avec celui d'ici).
2. **Flux par `#id`**, comme les canaux shader : `source="#mic"`, `output="#fx"`, valeur réservée `master`.
3. **Un seul `AudioContext` par page** : `AudioEngine` partagé (singleton sur `window`, donc partagé aussi entre bundles autonomes), déverrouillé au premier geste, master avec limiteur toujours actif. Tous les addons audio, `sound` compris, passent par lui.
4. **WebAudio natif** ; AudioWorklet seulement en phase 6. Pas de Tone.js, Howler, ni Strudel (AGPL : on réécrit un sous-ensemble de mini-notation).
5. **CSP stricte** : pas d'`eval`, pas de `new Function`, pas d'attribut `on*`. Configuration par attributs (JSON en chaîne accepté) ou DP.
6. **État standard** publié par chaque composant actif : `status` (`idle | requesting | ready | denied | error | unsupported`), `error`, plus ses valeurs propres. Publication paresseuse et plafonnée (`rate`, défaut 30 Hz) pour les valeurs continues.
7. **Nettoyage** : tracks arrêtés, nœuds déconnectés, blob URLs révoquées au `disconnectedCallback` ; on ne touche jamais à un élément qu'on ne possède pas.
8. Unités dans les noms : `freq-hz`, `time-s`, `gain-db`, `bpm`. Notes en nom (`A4`, `C#3`) ou en MIDI (`69`).
9. Chaque composant : `.ts`, `.spec.ts`, doc `.md` avec exemple SDUI JSON complet, entrée dans le manifeste de son addon (donc dans le catalogue).

## Contrats (socle partagé `src/shared/audio/`)

```ts
type SonicAudioSource = { getAudioOutput(): AudioNode | null };
type SonicAudioSink = { getAudioInput(): AudioNode | null };
type SonicInstrument = { schedule(events: SonicNoteEvent[]): void; allNotesOff(): void };

type SonicNoteEvent = {
  note?: string | number;   // "A4" ou 69
  sample?: string;          // sampler / batterie : nom de pad
  vel?: number;             // 0..1 (0.8)
  durS?: number;            // absent : jusqu'au noteOff
  when?: number;            // AudioContext.currentTime ; absent = maintenant ; passé de > 50 ms = ignoré
  id?: string;              // dédoublonnage
  type?: "note" | "noteOff" | "param";
  path?: string; value?: number; rampS?: number;   // type "param"
};
```

`SonicFrameSource` (déjà dans `src/shared/mediaRef.ts`) : `getFrameCanvas()`, `frameSeq`, et `getFrameSource?()` optionnel (source native sans copie, lue seulement par les shaders qui la connaissent).

## Composants

| Phase | Addon | Composant | Rôle | État |
|---|---|---|---|---|
| — | `sound` | `sonic-sound` | Bruitages, sons d'interface, musiques et jingles depuis une banque JSON | **fait** |
| — | `sound` | `sonic-sfx` | Son au clic / survol des enfants | **fait** |
| 1 | socle | `AudioEngine` | Contexte unique, déverrouillage, master + limiteur, DP `audio` | **fait** |
| 1 | `audio` | `sonic-audio-unlock` | Bouton « Activer le son », caché une fois déverrouillé | **fait** |
| 1 | `audio` | `sonic-audio-master` | Volume, muet du master, depuis un DP | **fait** |
| 1 | `audio` | `sonic-patch` | Instrument modulaire : compile ses modules, une voix WebAudio par note, `SonicInstrument` | **fait** |
| 1 | `audio` | `sonic-voice` | Portée « par note » à l'intérieur d'un patch | **fait** |
| 1 | `audio` | `sonic-osc` | Oscillateur (formes, `harmonics`, `octave`, `semi`, `detune`, `fm`) | **fait** |
| 1 | `audio` | `sonic-noise` | Bruit blanc / rose / brun | **fait** |
| 1 | `audio` | `sonic-mixer` | Somme pondérée | **fait** |
| 1 | `audio` | `sonic-filter` | Filtre biquad | **fait** |
| 1 | `audio` | `sonic-vca` | Ampli (gain souvent piloté par une enveloppe) | **fait** |
| 1 | `audio` | `sonic-env` | ADSR déclenchée par la note | **fait** |
| 1 | `audio` | `sonic-lfo` | LFO, libre ou calé sur le tempo | **fait** |
| 1 | `audio` | `sonic-shaper` | Saturation / wavefold simple | **fait** |
| 1 | `audio` | `sonic-pan` | Panoramique | **fait** |
| 1 | `audio` | `sonic-delay` | Délai, seul moyen d'autoriser une rétroaction | **fait** |
| 1 | `audio` | `sonic-reverb` | Réverbération à réponse générée (sans fichier) | **fait** |
| 1 | `audio` | `sonic-chorus` | Chorus / flanger | **fait** |
| 1 | `audio` | `sonic-comp` | Compresseur | **fait** |
| 1 | `audio` | `sonic-mod` | Câble de modulation `from` → `to`, `amount` | **fait** |
| 1 | `audio` | `sonic-param` | Paramètre lu dans un DP, avec rampe ; `expose` pour les patches de bibliothèque | **fait** |
| 1 | `audio` | bibliothèque | `synth/lead bass pad pluck fm-bell chip`, `drums/kick snare hat kit` (`sonic-patch preset="…"`) | **fait** |
| 2 | `audio` | `sonic-sequencer` | Horloge musicale (lookahead), mini-notation, euclide, probabilité, graine ; mode direct et mode store | **fait** |
| 2 | `audio` | `sonic-sampler` | Samples (URL, `SonicMediaRef`), choke, transposition | **fait** |
| 2 | `audio` | `sonic-sample-osc` | Sample joué comme oscillateur dans un patch | |
| 2 | `audio` | `sonic-audio-analyser` | `rms`, `peak`, `bands`, `onset`, `pitchHz` en DP + texture `#spectre` pour shader | **fait** |
| 3 | `audio` | `sonic-mic` | Micro (jamais vers le master par défaut) | **fait** |
| 3 | `media` | `sonic-camera` | Caméra, aperçu, `snapshot` → `SonicMediaRef`, source de frames pour shader | **fait** |
| 3 | `media` | `sonic-video` | Lecteur propriétaire de sa `<video>`, pilotage DP, son routable vers l'`AudioEngine` | **fait** |
| 3 | `media` | `sonic-media-start` | Bouton d'invite : démarre caméra / micro / vidéo sur un clic, affiche un refus | **fait** |
| 4 | `audio` | `sonic-audio-recorder` | Enregistre une source → `SonicMediaRef` (rejouable par le sampler) | **fait** |
| 4 | `media` | `sonic-media-recorder` | Export d'une performance (canvas shader/3D + son) en webm/mp4 | **fait** |
| 4 | `media` | `sonic-media-download` | Lien de téléchargement d'un enregistrement | **fait** |
| 4 | `audio` | `sonic-patch` + `sonic-audio-input` | Un patch qui traite une entrée (effet autonome : `#mic → #fx`) | **fait** |
| 5 | `audio` | `sonic-midi` | Web MIDI entrée / sortie / horloge, MPE en entrée | **fait** |
| 5 | `media` | `sonic-screen` | Capture d'écran (`getDisplayMedia`) | **fait** |
| 6 | `audio` | modules AudioWorklet | `sonic-osc sync` (BLEP), `sonic-ladder`, `sonic-fold`, `sonic-karplus`, `sonic-resonator`, `sonic-grain` | |

Chaque phase se termine par son intégration dans la plateforme : composants ajoutés au catalogue et au validateur (`tadaaa`), import dans le viewer (`artifacts`), smoke test sous CSP de prod. À partir de la phase 3 : `Permissions-Policy` (`camera`, `microphone`, `midi`, `display-capture`), `media-src blob:`, et déclaration `capabilities` dans le document avec bandeau avant le premier geste.

## Synthèse modulaire (`sonic-patch`)

La balise décrit, le moteur construit : les modules sont des éléments déclaratifs sans rendu ni nœud WebAudio. `sonic-patch` compile son arbre en une description de voix, puis crée un graphe WebAudio **par note**. Un patch 8 voix = 8 graphes, un seul arbre DOM.

- **Portée voix** (dans `sonic-voice`) : instanciée par note ; sources implicites `voice.pitch`, `voice.gate`, `voice.vel`, `voice.note`, `voice.rand`.
- **Portée globale** : instanciée une fois (LFO communs, effets). `voices` = somme des voix. Un module de voix peut être modulé par un module global, pas l'inverse.
- **Câblage audio** : `in="o1 o2"` (somme) ; sans `in`, entrée = module audio précédent (chaîne implicite) ; le premier module global prend `voices`.
- **Modulation** : `sonic-mod from to amount` (unités du paramètre), ou raccourci `gain="aenv"`, `freq-hz="voice.pitch"`.
- **Rétroaction** : autorisée seulement à travers un `sonic-delay`.
- **Noms locaux** (`name`) ; seul le patch porte un `id` global.
- **Validation** à la compilation : nom inconnu, paramètre inexistant, cycle sans délai, portée interdite → erreurs publiées, patch muet, rien ne casse.
- **Pilotage** : `events` (DP : liste de `SonicNoteEvent`) et `trigger` (DP : compteur ou valeur qui change) ; dédoublonnage par `id`. `sonic-param source="game.cutoff"` pour les valeurs continues.
- **Bibliothèque** : `sonic-patch preset="synth/lead" params='{"cutoff":900}'`. Un patch de bibliothèque est un arbre de modules comme un autre (sauvegardable, générable par l'agent).

## Décisions sur les questions ouvertes

1. **Deux addons, `audio` et `media`** : une page caméra seule ne charge pas le moteur audio. `media` peut importer le socle audio (pour router le son d'une vidéo), jamais l'inverse.
2. **Séquenceur et `sonic-ticker` restent séparés.** Le séquenceur est l'horloge musicale (calée sur l'audio) ; il peut dispatcher `step` à un store pour les jeux rythmiques.
3. **Chaîne implicite et `in` explicite**, les deux : courte pour les petits patches, explicite quand ça compte. La doc recommande `in` dès qu'un patch dépasse une chaîne simple.
4. **Vue graphique du patch : plus tard** (après la phase 2).
5. **`sound` reste un addon à part** (simple, orienté jeu, banque JSON) mais passe sur l'`AudioEngine` partagé dès la phase 1, pour qu'un jeu puisse mêler `sonic-sound` et des `sonic-patch` sur le même master.

## Phase 2 — critères d'acceptation (validés)

- [x] Mini-notation : suite table-driven (59 cas, entrées invalides comprises).
- [x] Gigue : 64 pas à 140 bpm enregistrés (MediaRecorder) : écart maximal 0,09 ms à la grille (objectif < 2 ms) ; programmation exacte à 0 µs.
- [x] Même graine → mêmes événements.
- [x] `sonic-shader channel0="#spectre"` reçoit une texture mise à jour à chaque image.
- [x] Sampler : blob WAV transposé (A4 → A5 = 880 Hz), URL dangereuse refusée.
- [x] Démo « Vie sonore » zéro JS : jeu de la vie en store, séquenceur en mode store, pluck + kit, fond shader piloté par l'analyseur.
- [ ] `sonic-sample-osc` (sample comme oscillateur de patch) : reporté.

## Phase 3 — critères d'acceptation (validés)

- [x] Aucune demande d'accès au chargement ; démarrage par bouton d'invite, `autostart` (premier geste) ou DP.
- [x] Chromium avec caméra et micro factices : caméra `idle → ready`, images numérotées (~20 i/s), copie non noire, `sonic-shader channel0="#cam"` (code Concorde) abonné à la caméra.
- [x] Photo par compteur → SonicMediaRef décodable, écrite dans `snapshot-provider`.
- [x] Refus de permission : `status = denied`, message affiché par `sonic-media-start`, aucune exception.
- [x] Retrait de la page : toutes les pistes `ended`.
- [x] Micro : un clic sur `sonic-audio-unlock start="mic"` active le son et le micro ; niveau publié ; analyseur branché sur `#mic`.
- [x] Vidéo : temps publié, déplacement / vitesse / boucle A–B / pause par DP, `preload="blob"`, URL dangereuse refusée ; son routé vers l'analyseur ; un shader hors écran qui lit `#clip` ne touche pas la vidéo (bug 10 bis).
- [x] Lecture automatique refusée : démarrage muet `needs-gesture`, son rétabli au premier geste.
- [x] Démos « Miroir » et « Clip réactif » zéro JS.
- [x] Correctif de câblage : les sources ne débranchent plus en bloc leur sortie (un analyseur abonné était coupé) — `AudioRoute`.

## Phase 4 — critères d'acceptation (validés)

- [x] Micro factice → `sonic-audio-recorder` 2 s : prise de 2,00 s (WebM/Opus) écrite dans `control.target`, chargée par `sonic-sampler` (`ref`) et rejouée (niveau mesuré par l'analyseur).
- [x] `sonic-audio-input` : patch sans `sonic-voice` branché sur `#mic` dès que le micro est prêt (`inputs.voix = true`), `master` refusé ; balise distincte de `sonic-input` de Concorde (le catalogue refuse désormais tout doublon de balise Concorde).
- [x] Export 3 s d'un `sonic-shader` + master : `<video>` relit 2,98 s (± 0,2 s), 320 × 180, pistes VP9 + Opus ; durée écrite dans le WebM (ffprobe la lit sans parcourir le fichier).
- [x] `sonic-media-download` : caché sans prise, lien `blob:` avec nom et extension déduits du format ; URL non `blob:` refusée.
- [x] Démo « Sampler de poche » zéro JS : micro nettoyé (`sonic-audio-input` → filtre → compresseur) → 4 pads enregistrés → sampler à la main et au séquenceur → fond shader → export vidéo téléchargeable.

## Phase 5 — critères d'acceptation (validés)

- [x] Web MIDI factice (entrée « LinnStrument », sortie « Digitone II ») dans Chromium : aucun accès avant le clic, `requestMIDIAccess({ sysex: false })` au clic, ports listés.
- [x] MPE : bend du canal envoyé avant la note → note tenue à +12 demi-tons ; le patch (`target="#syn"`) joue 880 Hz pour un A4 ; pression par note publiée ; store qui reçoit `{ type: "midi", payload }`.
- [x] Sortie : `sonic-sequencer pattern='{"out": "c4 e4"}'` → notes canal 3 horodatées à 1 000 ms ± 0,03 ms ; CC envoyé au changement seulement.
- [x] Horloge sortante : Start puis 24 ticks par noire, écart max 0,003 ms ; premier tick au même instant que la première note ; Stop à l'arrêt.
- [x] Horloge entrante à 100 bpm : tempo mesuré, séquenceur démarré par Start, tempo suivi, verrouillé (écart < 10 ms), arrêté par Stop.
- [x] Correspondance stable entre `performance.now` et l'horloge audio (`AudioEngine.ctxTimeAtPerf` / `perfAtCtxTime`, lissée) : sans elle, ±1,2 ms de gigue.
- [x] `sonic-screen` : partage au clic, images pour `sonic-shader`, photo, export vidéo de l'écran ; arrêt par l'utilisateur → `idle` + message ; refus → `denied`.
- [x] Démo « Jam MIDI » zéro JS : voix expressive MPE, pads de secours, batterie calée sur l'horloge d'une machine ou maîtresse (horloge sortante), panique.

## Ce qui reste côté Concorde (prompt Cursor, non bloquant)

Le viewer garde ses composants visuels Concorde ; ces améliorations ne viendront donc que de Concorde :

- `sonic-shader` / `sonic-webgpu` / `sonic-3d` : lire `getFrameSource()` quand il existe (caméra et vidéo sans copie canvas). En attendant, caméra et vidéo exposent `getFrameCanvas()`, déjà compris par les shaders.
- `sonic-matrix` : `emit="cell"` / `paint` (case touchée vers un store).
- `sonic-gesture` : coordonnées dans `tap`, `long-press`, `swipe`, et `drag` continu.
- `sonic-if` lié aux données et `sonic-value format` à restaurer en 5.x avant toute migration du viewer.

## Phase 1 — critères d'acceptation (validés)

- [x] Un seul `AudioContext` même avec `sonic-sound`, plusieurs patches et plusieurs bundles ; master avec limiteur ; DP `audio` publié.
- [x] Compilateur testé seul : graphe valide → description attendue ; nom inconnu, paramètre inexistant, cycle sans délai, modulation voix → global → erreurs lisibles.
- [x] Rendu `OfflineAudioContext` (Chromium) : A4 de 0,5 s → fréquence dominante 440 Hz ± 2 Hz, enveloppe conforme à l'ADSR (± 10 ms).
- [x] Dédoublonnage par `id` ; événement `when` passé de plus de 50 ms ignoré ; données invalides ignorées sans exception.
- [x] Patch FM 2 opérateurs et `drums/kit` rendus : pas de NaN, pas de dépassement de 0 dBFS après le limiteur.
- [x] Démo « Premier son » zéro JS : `sonic-keyboard` (Concorde) → `sonic-store` → `notes` → `sonic-patch preset="synth/lead"` + un patch écrit à la main.
