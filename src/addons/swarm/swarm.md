# Swarms (`sonic-swarm`)

Addon `swarm`. Up to 200 steered agents simulated at 60 Hz: fish schools and bird flocks, chasers and fleeing prey, patrols along a path, crowds flowing through a maze towards a goal. Each agent has a bounded speed and steering force (Reynolds steering); its behaviours are weighted and summed. Neighbours are found through a spatial hash, so cost grows about linearly with the number of agents.

The swarm writes the shared scene format: `nodes` (`{x, y, rz}`, or `{x, z, ry}` with `plane="xz"` for a 3D floor) and, when a group declares a `sprite`, a `sprites` list ready for `sonic-2d sprites="…"`. No `sonic-sprite` to write by hand.

## Attributes

| attribute | role |
|---|---|
| `spec` | description (below): inline JSON, or the path of a DataProvider (read live: changing `count` adds or removes agents, the others keep moving) |
| `control` | DataProvider path of live settings, merged over `spec` **by group name**: `{"groups": [{"name": "fish", "seek": {"target": [400, 300]}}], "paused": true}`. Counter `respawn` (raise it: `{"respawn": 3}`): every agent back to its spawn area, removed agents come back (new level) |
| `out-data-provider` | output: `nodes`, `sprites`, `agents` (`[{name, group, x, y, heading, leader?}]`), `count`, `groups` (`{group: alive count}`), `catches` (total), `status`, `error` |
| `plane` | `screen` (default: `x`, `y`, `rz` in radians) or `xz` (`x`, `z`, `ry`, divided by `scale`: world units per metre) |
| `rate` | publications per second (30; the simulation always runs at 60 Hz) |
| `report`, `report-groups`, `report-ms` | store receiving `{type: "swarm:report", payload: {agents: {name: [x, y, heading]}, groups: {group: alive}, leaders: {leader: followers}}}` every `report-ms` (100) ms, for the groups listed in `report-groups` (comma-separated; all if empty). A reducer cannot read other DataProviders: this is its view of the world (players' positions, light left per player…) |
| `target`, `action` | store receiving captures: `{type: "swarm:catch", payload: {by, caught, group, x, y}}` (also a DOM `catch` event) |

## Description

```json
{
  "bounds": [0, 0, 800, 500],
  "edges": "steer",
  "seed": 7,
  "grid": {"rows": ["#########", "#.......#", "#..##...#", "#########"], "cell": 50},
  "groups": [
    {"name": "fish", "count": 60, "maxSpeed": 90, "radius": 5, "view": 45,
     "separation": 1.6, "alignment": 1, "cohesion": 0.9, "wander": 0.3,
     "evade": {"target": "group:shark", "radius": 140, "weight": 3},
     "sprite": {"shape": "circle", "r": 5, "fill": "--sc-info"}},
    {"name": "shark", "count": 1, "maxSpeed": 110, "radius": 12,
     "pursue": {"target": "group:fish"},
     "catch": {"target": "group:fish", "respawn": true},
     "sprite": {"shape": "text", "text": "🦈", "font-size": 28}}
  ]
}
```

- `bounds` `[x0, y0, x1, y1]` in world units (the same as the `sonic-2d` scene); `edges`: `steer` (turn back softly, default), `wrap` (torus), `bounce`.
- `grid`: walls from a text grid (same format as the `$grid…` functions of [../interactive/algo.md](../interactive/algo.md)), `cell` = size of a cell in world units. Agents look ahead and turn away from walls, then slide along them. Outside the grid counts as wall. `smooth` (0 to 4): agents hit the smoothed walls that `$gridContours` draws with the same `smooth` and `scale` = `cell`, not the square cells — what the player sees is what blocks (rounded corners, diagonal slopes). Without `smooth`, walls are the square cells.
- `seed`: same seed → same start (spawn positions, wandering).

### Group keys

| key | meaning |
|---|---|
| `name`, `count`, `prefix` | agents are named `<prefix><i>` (prefix defaults to the name): `fish0`, `fish1`… |
| `maxSpeed` (100), `maxForce` (200), `radius` (6), `view` (50) | units per second, units per second², body radius, neighbour perception distance |
| `separation` | weight (1.5) or `{weight, radius}`: keep apart from every agent closer than `radius` (3 × body radius) |
| `alignment`, `cohesion` | weights: match the heading / move to the centre of same-group neighbours (boids) |
| `wander` | weight: smooth random wandering |
| `seek`, `arrive` | `{target, weight, radius}`: go to the target; `arrive` slows down within `radius` (80) |
| `flee`, `evade` | `{target, weight, radius}`: get away when closer than `radius` (120); `evade` anticipates the pursuer's motion |
| `pursue` | `{target, weight}`: chase, aiming where the target will be |
| `path` | `{points: [[x, y]…], loop: true, weight}`: follow waypoints |
| `flow` | `{target, weight}`: follow the distance field of `grid` towards the target cell — the shortest way around the walls, computed once for everyone and cached |
| `catch` | `{target: "group:<name>", radius, respawn, remove}`: when a target agent is within `radius` (sum of body radii by default), send the capture to the store (payload `{by, caught, group, x, y, leader}`); `respawn: true` puts the prey back at a random spawn point; `remove: true` takes it out for good (its node gets `visible: false`; it does not come back when the spec changes, only with the `respawn` counter of `control`) |
| `follow` | `{target: "group:<name>", radius, swap, slow, weight, colors, role, lost}`: each agent picks a **leader** (nearest agent of that group within `radius`) and follows it, slowing down within `slow` (60); it switches to another leader that passes closer than `swap` (radius / 3). `colors` `{leader: colour}`: the agent takes its leader's colour (`color` in `nodes` for a sprite, `roles.<role>` for a monde2d instance, `role` = `peau`), `lost` without a leader. Co-op « lend your light »: fish follow the diver they are near |
| `spawn` | `[x0, y0, x1, y1]` spawn area (default: `bounds`, avoiding walls) |
| `clips` | `{swim, fast, catch, fastAt, catchMs, pace}`: clip of the agent's model (`monde2d`, `monde`) by state — `swim` at rest, `fast` above `fastAt` × `maxSpeed` (0.7), `catch` for `catchMs` (400) after a capture; `pace: true` makes the clip cadence follow the speed (`clipSpeed` 0.6 to 1.5). Sent in `nodes` only when it changes. Preset `marin`: `{"swim": "nage", "fast": "rapide", "catch": "morsure", "pace": true}` |
| `sprite` | sprite published in `sprites` for every agent (keys of `sonic-sprite`; `shape` `circle` and `r` = `radius` by default) |

**Targets**: `[x, y]`, `"group:<name>"` (nearest agent of that group), `"agent:<name>"`, or `"dp:<path>"` (a DataProvider holding `[x, y]` or `{x, y}`: a player position, a store key, the pointer). `{name}` in a `dp:` path is replaced by the agent's name: one target per agent (`"dp:jeu.cibles.{name}"` → `jeu.cibles.p0`, `jeu.cibles.p1`…), e.g. one player per pad.

## Example: a school of fish fleeing a shark that follows the pointer

```json
{"tagName": "div", "attributes": {"style": "position:relative"}, "nodes": [
  {"tagName": "sonic-store", "attributes": {"id": "lac", "initial": {"mange": 0},
    "reducer": "$action.type = 'swarm:catch' ? $merge([$state, {'mange': $state.mange + 1}]) : $state"}},
  {"tagName": "sonic-swarm", "attributes": {"out-data-provider": "banc", "target": "lac",
    "spec": "{\"bounds\":[0,0,800,500],\"seed\":3,\"groups\":[{\"name\":\"fish\",\"count\":80,\"maxSpeed\":90,\"radius\":4,\"view\":40,\"separation\":1.6,\"alignment\":1,\"cohesion\":0.9,\"wander\":0.2,\"evade\":{\"target\":\"agent:shark0\",\"radius\":130,\"weight\":3},\"sprite\":{\"shape\":\"circle\",\"fill\":\"--sc-info\"}},{\"name\":\"shark\",\"count\":1,\"maxSpeed\":140,\"radius\":10,\"arrive\":{\"target\":\"dp:mer.pointer\"},\"catch\":{\"target\":\"group:fish\",\"respawn\":true},\"sprite\":{\"shape\":\"text\",\"text\":\"🦈\",\"font-size\":26}}]}"}},
  {"tagName": "sonic-2d", "attributes": {"dataProvider": "banc", "sprites": "banc.sprites", "width": "800", "height": "500"}}
]}
```

Feed `mer.pointer` with the pointer position in scene units (for example a `sonic-cursor` mapped to the scene, or the tap position written by a store). Show `lac.mange` with a `sonic-value`.

## With the `$grid…` functions

A level generated in a reducer (`$genCave`, `$genDungeon`, `$genMaze`) goes straight to `grid.rows`; `flow` then walks a whole crowd towards the exit through the corridors, and `$gridFind(rows, 'X')` gives the target cell (multiply by `cell` and add half a cell for world units). Draw the walls with `$gridContours(rows, {"values": ".", "scale": cell, "smooth": 2, "sprites": {…}})` and give the swarm `grid.smooth: 2`: the school then follows the drawn shapes exactly. Keep passages at least two cells wide: smoothing rounds the corners of a one-cell turn.

## Limits

200 agents per swarm (the `nodes` format applies 200 nodes per update), 16 groups. Paused when the page is hidden.
