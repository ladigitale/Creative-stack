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
| `sonic-trigger` | Sensor → action: watches a DataProvider value and dispatches an action to a store, or plays a MIDI note — see below |
| `sonic-motion` | Speed / acceleration / peak speed of a sensor value (velocity for MIDI) — see below |
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
| `state-provider` | DataProvider `{active, armed, count, value, note, vel}` for the UI | — |

The hold and cooldown are confirmed by a 100 ms loop, so timings are accurate to about 0.1 s. No code is evaluated: only the fixed operators above.

Typical sources: `sonic-object-detector` (`labels.person`, `count`), `sonic-face-tracker` (`present`, `smile`, `mouthOpen`), `sonic-hand-tracker` (`right.gesture`), `sonic-mic` (`db`), `sonic-audio-analyser` (`onset`, `rms`).

### Direct MIDI output (`emit`)

Besides (or instead of) the store action, a firing can play a note through a `sonic-midi` (or any instrument fed by an events DataProvider), with no store in between:

```json
{ "tagName": "sonic-motion", "attributes": { "source": "hands", "keys": "right.x,right.y", "speed-max": "2", "out-data-provider": "hand-speed" } }
{ "tagName": "sonic-trigger", "attributes": {
  "source": "hand-speed", "key": "moving", "emit": "noteOn",
  "emit-provider": "midi-ev", "emit-trigger": "midi-go",
  "note-key": "value", "note-range": "48,72", "scale": "0,2,4,7,9",
  "vel-source": "hand-speed", "vel-key": "peakVel", "vel-min": "0.2" } }
{ "tagName": "sonic-midi", "attributes": { "events": "midi-ev", "trigger": "midi-go", "out-channel": "1" } }
```

| Attribute | Role | Default |
|---|---|---|
| `emit` | `note` (duration `dur-s`) or `noteOn` (held until the condition goes false, then `noteOff`; also released when disabled or removed). Empty: no MIDI | — |
| `emit-provider` | DataProvider receiving the event list → `events` of `sonic-midi` | — |
| `emit-trigger` | DataProvider counter bumped after each emission → `trigger` of `sonic-midi` (starts at 0 so the first message is not swallowed) | — |
| `note` | Fixed note (`C4` or MIDI number) when `note-key` is empty | `60` |
| `note-key` | Path of a 0..1 value in `source` choosing the pitch | — |
| `note-range` | `low,high` MIDI notes for `note-key` | `48,72` |
| `scale` | Semitone offsets from the low note (`0,2,4,7,9`); empty: chromatic | — |
| `vel-source`, `vel-key` | DataProvider and path (0..1) giving the velocity (e.g. `sonic-motion` `vel` or `peakVel`) | `vel` |
| `vel-min` | Velocity floor (and the velocity without `vel-source`) | `0.3` |
| `dur-s`, `ch` | Note duration (`note` only), MIDI channel 1..16 (0: sonic-midi's) | `0.25`, `0` |

The velocity is read **at the instant of firing**: use `peakVel` (strongest speed of the last `peak-ms`) to play "how hard the gesture was" rather than the instantaneous speed.

**Latency.** Camera-driven MIDI cannot be tighter than the camera frame period plus inference and the worker transfer (tens of ms, see `latencyMs` on the trackers). The hold/cooldown loop adds up to 100 ms only when `hold-ms` is used; a firing triggered by a new value is immediate.

## `sonic-motion`

Publishes the speed of one or several values of a DataProvider (`keys="x"` or `keys="x,y"`: with several, the norm of the displacement).

| Attribute | Role | Default |
|---|---|---|
| `source`, `keys` | DataProvider and dotted paths (comma-separated) | required |
| `smooth-ms` | Time constant of the speed smoothing (0: raw) | `60` |
| `speed-max` | Speed (units/s) giving `vel = 1`; normalized positions typically need 1–4 | `2` |
| `idle-ms` | Without a new value for this long, the speed decays toward 0 | `120` |
| `peak-ms` | Window of the peak speed | `150` |
| `out-data-provider` | `{value, values, speed, accel, vel, peak, peakVel, moving}` | — |

A gap longer than 0.5 s between two values restarts the measure with a speed of 0 (no spike when a hand reappears).

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
