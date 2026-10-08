# Manettes (SDUI)

Addon `@supersoniks/creative-stack/controller` : `sonic-controller` lit les manettes (API Gamepad du navigateur) et les relie au reste par le store et un DataProvider. Complète `sonic-gamepad` (boutons seulement, une manette) : sticks et gâchettes **analogiques**, jusqu'à 4 manettes, relâchements, vibration.

```json
{ "tagName": "sonic-controller", "attributes": {
  "id": "pad", "store": "game", "analog-action": "stick", "release": "", "control": "game.padCtl",
  "keymap": "{\"a\":\"jump\",\"start\":\"pause\",\"left\":\"left\",\"right\":\"right\"}" } }
```

| Attribut | Rôle |
|---|---|
| `store` | Store qui reçoit les actions |
| `keymap` | Bouton → action (`"jump"` ou `{ "type": "fire", "payload": 2 }` ; sans payload : `{ pad }`) |
| `release` | Envoie aussi `<type>:up` au relâchement (tenir pour avancer) |
| `analog-action` | Action envoyée quand un axe bouge : `{ type, payload: { pad, lx, ly, rx, ry, lt, rt } }` (sticks -1..1, gâchettes 0..1), au plus `rate` fois par seconde |
| `deadzone` | Zone morte radiale des sticks (0.15) |
| `player` | `all` (défaut) ou index 0..3 |
| `rate` | Publications par seconde (30) |
| `control` | DP `{ rumble: { n: compteur, ms, strong, weak } }` : vibration à chaque hausse de `n` |

Boutons (disposition standard) : `a b x y lb rb lt rt select start ls rs up down left right home`, plus `ls-left`, `ls-right`, `ls-up`, `ls-down` (stick gauche poussé à fond).

État (`<id>State`) : `{ status: idle | ready | unsupported, count, pads: [{ index, id, mapping, lx, ly, rx, ry, lt, rt, pressed }] }`.

Le navigateur ne montre une manette qu'après un appui sur l'un de ses boutons : afficher l'état (`padState.status`) pour l'indiquer.

Reducer type (raquette pilotée au stick) :

```jsonata
$action.type = "stick" ? $merge([$state, {"input": {"paddle": {"vx": $action.payload.lx * 700}}}]) : $state
```
