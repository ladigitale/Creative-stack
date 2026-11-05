# Interactive (SDUI)

Addon opt-in `@supersoniks/creative-stack/interactive` for **declarative** playable UIs under a strict CSP (no `eval`, no inline script, no `on*` handlers).

## Components

| Tag | Role |
|---|---|
| `sonic-store` | State + JSONata reducer (`$state`, `$action`, `$env`) |
| `sonic-keyboard` | Keymap → actions |
| `sonic-gamepad` | Standard gamepad → actions |
| `sonic-gesture` | Tap / swipe / long-press, drag, pan, pinch (multipoint), wheel — see below |
| `sonic-action` | `pointerdown` (default: games, touch d-pads, `hold-repeat`) or `trigger="click"` (UI buttons: tabs, details, filters) → action |
| `sonic-ticker` | Clock `tick` with `dt` |
| `sonic-trigger` | Sensor → action: watches a DataProvider value and dispatches an action to a store — see below |
| `sonic-matrix` | 2D grid canvas from DataProvider |

Also: `sonic-if` accepts `dataProvider` + `key` + `equals`/`not`/`truthy`/`gt`/`lt` for SDUI. `sonic-value` accepts `format="00000"` or `format="intl:fr-FR"`.

These two come from `src/shared/concorde-compat.ts`, loaded by this addon: they complete the `sonic-if` / `sonic-value` classes of **classic Concorde 5.x** (no fork, no redefinition; nothing changes when the attributes are absent). `sonic-value` also tolerates text values starting with `[` or `{` that are not JSON (the classic Subscriber would throw).

## `sonic-trigger`

Watches one value of a DataProvider (tracker output, microphone, another store…) and, when the condition holds long enough, dispatches an action to a `sonic-store`. It is the missing link between a **sensor** and a **reaction**: the store decides what happens (counter, alert, journal, `outbox` for a collection).

```json
{ "tagName": "sonic-trigger", "attributes": {
  "source": "objs", "key": "labels.person", "gt": "0",
  "hold-ms": "800", "cooldown-ms": "5000",
  "target": "watch", "type": "seen", "payload": "{\"what\":\"person\"}",
  "end-type": "gone" } }
```

| Attribute | Role | Default |
|---|---|---|
| `source` | DataProvider watched (a tracker's `outputProvider` or id, `sonic-mic` `out-data-provider`, a store id…) | required |
| `key` | Dotted path inside the value: `labels.person`, `right.gesture`, `db`, `faces.0.blend.jawOpen`. Empty: the whole value | — |
| `equals`, `not`, `gt`, `gte`, `lt`, `lte`, `truthy` | Condition on the value (several = all must hold, e.g. `gt="0.2" lt="0.8"`). No operator: the value must be truthy (`"false"`, `"0"`, empty and missing are false). Numeric operators ignore non-numeric or missing values | truthy |
| `hold-ms` | The condition must stay true this long before firing (filters false positives) | `0` |
| `cooldown-ms` | Minimum time between two firings; a crossing that comes too early is delayed, not lost | `1000` |
| `mode` | `edge`: one firing per crossing (must go false to re-arm); `repeat`: fires at each cooldown while true | `edge` |
| `target` | Id of the `sonic-store` receiving the action | required |
| `type` | Action type sent on firing | `trigger` |
| `payload` | Fixed JSON object merged into the payload; the component adds `value` (value read) and `count` (rank of the firing) | — |
| `end-type` | Action type sent when the condition goes false after a firing (payload `{value}`); empty: none | — |
| `disabled` | Suspends watching | `false` |
| `state-provider` | DataProvider `{active, armed, count, value}` for the UI | — |

The hold and cooldown are confirmed by a 100 ms loop, so timings are accurate to about 0.1 s. No code is evaluated: only the fixed operators above.

Typical sources: `sonic-object-detector` (`labels.person`, `count`), `sonic-face-tracker` (`present`, `smile`, `mouthOpen`), `sonic-hand-tracker` (`right.gesture`), `sonic-mic` (`db`), `sonic-audio-analyser` (`onset`, `rms`).

## `sonic-gesture`

Pointer area (touch, mouse, pen) dispatching actions to `target`. Coordinates are px relative to the area; `u`, `v` are fractions (0..1).

| Option | Actions |
|---|---|
| always | `tap`, `double-tap`, `long-press` with `{x, y, u, v}` ; `swipe-up|down|left|right` (one finger) |
| `drag` | `drag {dx, dy}` = **cumulative fraction** of the area since the start (historical meaning) ; `drag-end {dx, dy, x, y, u, v}` |
| `pan` | `pan {dx, dy, x, y}` = **px delta** since the previous action (centre of the fingers) ; `pan-end {dx, dy, vx, vy}` (total px, px/s). No swipe when `pan` is on. |
| `pinch` | `pinch-start {cx, cy}`, `pinch {scale, dScale, rotation, dRotation, cx, cy}` (two fingers; `scale` cumulative, `dScale` since the previous action, radians), `pinch-end {scale, rotation}` |
| `wheel` | mouse wheel / trackpad → `pinch {source: "wheel", scale, dScale, cx, cy}` (page scroll blocked on the area) |
| `state-provider="nom"` | DataProvider `{active, pointers, scale, rotation, panX, panY, x, y}` |

Continuous actions (`drag`, `pan`, `pinch`) are coalesced: at most one of each per animation frame (`pan` deltas summed, `dScale` multiplied). A gesture with two fingers never ends in `tap` or `swipe`, nor does a fired long press.

Camera reducer example (zoom around the fingers, pan in px):

```jsonata
$action.type = 'pinch' ? $merge([$state, {'zoom': $clamp($state.zoom * $action.payload.dScale, 0.5, 4)}])
: $action.type = 'pan' ? $merge([$state, {'x': $state.x - $action.payload.dx / $state.zoom, 'y': $state.y - $action.payload.dy / $state.zoom}])
: $state
```

## Reducer purity

Injected: `$rand`, `$randInt`, `$clamp`, `$range`, `$set`, `$matrix`, `$rotate`.  
`$random` and `$now` throw — use `$rand(seed)` and `$action.t`.

## CDN

```html
<script src="concorde-core.bundle.js"></script>
<script src="creative-stack-interactive.bundle.js"></script>
```

## Out of scope (this pass)

Multiplayer, persistence. Pour le son, voir l’addon `sound` (`sonic-sound` piloté par une sous-clé du store).
