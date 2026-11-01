# Interactive (SDUI)

Addon opt-in `@supersoniks/creative-stack/interactive` for **declarative** playable UIs under a strict CSP (no `eval`, no inline script, no `on*` handlers).

## Components

| Tag | Role |
|---|---|
| `sonic-store` | State + JSONata reducer (`$state`, `$action`, `$env`) |
| `sonic-keyboard` | Keymap → actions |
| `sonic-gamepad` | Standard gamepad → actions |
| `sonic-gesture` | Tap / swipe / long-press, drag, pan, pinch (multipoint), wheel — see below |
| `sonic-action` | Click / hold-repeat → action |
| `sonic-ticker` | Clock `tick` with `dt` |
| `sonic-matrix` | 2D grid canvas from DataProvider |

Also: `sonic-if` accepts `dataProvider` + `key` + `equals`/`not`/`truthy`/`gt`/`lt` for SDUI. `sonic-value` accepts `format="00000"` or `format="intl:fr-FR"`.

These two come from `src/shared/concorde-compat.ts`, loaded by this addon: they complete the `sonic-if` / `sonic-value` classes of **classic Concorde 5.x** (no fork, no redefinition; nothing changes when the attributes are absent). `sonic-value` also tolerates text values starting with `[` or `{` that are not JSON (the classic Subscriber would throw).

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
