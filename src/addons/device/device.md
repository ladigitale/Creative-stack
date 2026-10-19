# Appareil et navigateur (SDUI)

Addon `@supersoniks/creative-stack/device` : les API « appareil » du navigateur, sans JS, par DataProviders. Chaque composant est **sans rendu** : il publie son état dans `<id>State` (ou `out-data-provider`), se pilote par compteurs dans un DataProvider `control`, et peut être lancé directement par le clic d'un bouton (`for`).

| Composant | Rôle | Commandes (`control`) |
|---|---|---|
| `sonic-fullscreen` | Plein écran de la page ou d'un élément | `enter`, `exit`, `toggle` |
| `sonic-pointer-lock` | Souris verrouillée, déplacements relatifs | `lock`, `unlock`, `toggle`, `reset` |
| `sonic-wake-lock` | Écran toujours allumé | `acquire`, `release`, `toggle` |
| `sonic-orientation` | Orientation de l'écran, capteurs de mouvement | `lock {type}`, `unlock`, `sensors`, `stop` |
| `sonic-clipboard` | Copier, lire le presse-papiers (texte) | `copy {text}`, `read` |
| `sonic-share` | Partage natif, repli par copie | `share {title, text, url}` |
| `sonic-vibrate` | Vibration (Android) | `vibrate {pattern}`, `stop` |
| `sonic-page-state` | Visibilité, focus, connexion, taille, préférences | — |
| `sonic-capabilities` | Ce que la page autorise, en un DataProvider | `refresh` |

Les manettes (`sonic-controller`, addon `controller`) et le MIDI (`sonic-midi`, addon `audio`) existent déjà.

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
| `sonic-clipboard` | `allow="clipboard-write; clipboard-read"` |
| `sonic-share` | `allow="web-share"` |
| `sonic-vibrate` | `allow="vibrate"` (selon le navigateur) |

Tableau de départ : à vérifier sur chaque navigateur cible avant de s'y fier.

## Exemples

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

### Dégrader proprement avec `sonic-capabilities`

```json
{ "tagName": "sonic-capabilities", "attributes": { "id": "caps" } }
```

`capsState` : `{ status: "ready", embedded, secureContext, fullscreen: { supported, allowed, permission }, wakeLock: {…}, … }`. Lire par exemple `capsState.vibrate.supported` pour n'afficher le bouton « vibrer » que sur les appareils qui le permettent, ou `capsState.fullscreen.allowed` pour savoir si la page hôte autorise le plein écran. Aucune demande de permission n'est ouverte : détection par présence de l'API, lecture de la Permissions Policy et de `navigator.permissions` quand le navigateur connaît le nom (`permission : "unknown"` sinon, `"n/a"` quand l'API n'en demande pas).

Clés : `fullscreen`, `pointerLock`, `wakeLock`, `gamepad`, `midi`, `orientation`, `clipboard`, `share`, `vibrate`, `camera`, `microphone`, `audio`, `screen`.

## Détails par composant

**`sonic-fullscreen`** — `target` : sélecteur CSS (défaut : la page). `navigation-ui` : `auto`, `hide`, `show`. L'état suit toujours l'événement `fullscreenchange` (sortie par Échap comprise). iPhone Safari : plein écran seulement sur une `<video>` (`target="#ma-video"`), `supportsVideoOnly` l'indique. Événement `sonic-fullscreen-change`.

**`sonic-pointer-lock`** — `unadjusted-movement` demande le mouvement brut ; si le navigateur ne le connaît pas, repli automatique (`raw: false`). Échap rend toujours la souris ; un nouveau verrouillage est parfois refusé environ une seconde après. Retiré de la page, le composant libère la souris.

**`sonic-wake-lock`** — Le navigateur relâche le verrou quand l'onglet passe en arrière-plan ; tant que `wanted` reste vrai, il est repris au retour (`reacquired` compte les reprises). Pas de repli par vidéo cachée.

**`sonic-orientation`** — `type` / `angle` suivent l'écran. `lock {type}` : `landscape`, `portrait`, `natural`, `any`, `portrait-primary`, `portrait-secondary`, `landscape-primary`, `landscape-secondary` ; sur mobile, souvent seulement en plein écran. `smoothing` (0 à 0,95) lisse les capteurs ; `alpha` (boussole) est lissé par le plus court chemin sur le cercle.

**`sonic-clipboard`** — `text` : texte copié par défaut. La lecture (`read`) n'a lieu que sur commande, avec la permission du navigateur ; le texte lu (tronqué à 10 000 caractères) est publié dans le DataProvider : ne pas s'en servir pour des données sensibles.

**`sonic-share`** — `title`, `text`, `url` (http ou https seulement : `javascript:` et `data:` sont refusés). Sans partage natif, `fallback="copy"` (défaut) copie `texte + url`. Annuler la feuille de partage incrémente `cancelled`, ce n'est pas une erreur. Pas de partage de fichiers.

**`sonic-vibrate`** — `pattern` : `"200"` ou `"100,50,100"` (vibration, pause, vibration…), 20 éléments au plus, 5 s chacun. Absent sous iOS (`supported: false`) : prévoir un autre retour (son, animation).

**`sonic-page-state`** — Sans permission ni commande. `active` = `visible`. À utiliser pour couper un rendu ou un son quand l'onglet est caché (`visible: false`), ou adapter la scène au tactile (`touch`), au thème sombre (`colorScheme`) ou au mouvement réduit (`reducedMotion`).
