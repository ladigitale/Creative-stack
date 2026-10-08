# Interactive (SDUI)

Addon opt-in `@supersoniks/creative-stack/interactive` for **declarative** playable UIs under a strict CSP (no `eval`, no inline script, no `on*` handlers).

## Components

| Tag | Role |
|---|---|
| `sonic-store` | State + JSONata reducer (`$state`, `$action`, `$env`) |
| `sonic-keyboard` | Keymap → actions |
| `sonic-gamepad` | Standard gamepad → actions |
| `sonic-gesture` | Tap / swipe / long-press |
| `sonic-action` | Click / hold-repeat → action |
| `sonic-ticker` | Clock `tick` with `dt` |
| `sonic-matrix` | 2D grid canvas from DataProvider |

Also: `sonic-if` accepts `dataProvider` + `key` + `equals`/`not`/`truthy`/`gt`/`lt` for SDUI. `sonic-value` accepts `format="00000"` or `format="intl:fr-FR"`.

These two come from `src/shared/concorde-compat.ts`, loaded by this addon: they complete the `sonic-if` / `sonic-value` classes of **classic Concorde 5.x** (no fork, no redefinition; nothing changes when the attributes are absent). `sonic-value` also tolerates text values starting with `[` or `{` that are not JSON (the classic Subscriber would throw).

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
