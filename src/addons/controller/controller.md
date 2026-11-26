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
| `control` | DP `{ rumble: { n: compteur, duration, strong, weak, pad }, stopRumble: n }` : vibration à chaque hausse de `n`, arrêt à chaque hausse de `stopRumble` |

Boutons (disposition standard) : `a b x y lb rb lt rt select start ls rs up down left right home`, plus `ls-left`, `ls-right`, `ls-up`, `ls-down` (stick gauche poussé à fond).

État (`<id>State`) : `{ status: idle | ready | unsupported, count, pads: [{ index, id, mapping, lx, ly, rx, ry, lt, rt, pressed }], error, rumble: { supported, active } }`.

Vibration : `duration` en ms (alias historique `ms`, ≤ 5000, défaut 200), `strong` / `weak` 0..1 (moteurs lourd / léger, défauts 0.8 / 0.5), `pad` = index de la manette ; sans `pad`, toutes les manettes suivies (`player`) vibrent. `vibrationActuator.playEffect("dual-rumble")`, sinon `hapticActuators[0].pulse` (ancien Firefox). `rumble.supported` : une des manettes suivies sait vibrer ; `rumble.active` : un effet joue. Impossible (pas de manette à cet index, manette muette, refus du navigateur) : message en français dans `error` (effacé par le prochain essai réussi). Non testé sur matériel.

Le navigateur ne montre une manette qu'après un appui sur l'un de ses boutons : afficher l'état (`padState.status`) pour l'indiquer.

Reducer type (raquette pilotée au stick) :

```jsonata
$action.type = "stick" ? $merge([$state, {"input": {"paddle": {"vx": $action.payload.lx * 700}}}]) : $state
```
