# Game algorithms in reducers (`$grid…`, `$gen…`, `$roll`…)

Pure JSONata functions available in every `sonic-store` reducer and every `sonic-jsonata` expression. No component to add, nothing to load. Same input → same output: randomness only comes from a **seed** kept in the state (`$random` is forbidden in reducers).

Source: `src/shared/algo/` (typed arrays, shared with the procgen navigation). Limits: 65 536 cells per grid (256 × 256), 65 536 visited cells per path search, 100 000 graph edges. A bad input throws a clear error (the store reports it and keeps its state).

## Grids

A grid is what you keep in the state, in one of two shapes:

- **text rows** (best for an agent to write and read): `["#######", "#@..~.#", "#..#.X#", "#######"]`;
- **matrix**: `[[1, 1, 1], [1, 0, 0]]` (e.g. from `$matrix`).

Cells are `[x, y]` (x = column, y = row, `[0, 0]` top-left); `{"x": 3, "y": 1}` is accepted too.

Every grid function takes an optional last `options` object:

| option | default | meaning |
|---|---|---|
| `walls` | `"#"` (rows), `1` (matrix) | impassable values: a string of characters (`"#T"`) or a list |
| `costs` | — | entry cost per value, `{"~": 3, "^": 2}`; others cost 1 |
| `opaque` | = walls | values that block sight (`"#"` but not water `"~"`) |
| `diag` | `false` | 8 neighbours instead of 4 (diagonal step costs √2) |
| `cut` | `false` | with `diag`, allow squeezing diagonally between two walls touching by a corner |

Grids are parsed once and cached (by content + options): calling several functions on the same grid in one reducer costs one parse.

### Read and edit

| function | returns |
|---|---|
| `$gridGet(grid, [x, y])` | the value of the cell (`undefined` outside) |
| `$gridSet(grid, cell or [cells], value)` | a new grid (same shape) with those cells changed |
| `$gridFind(grid, value)` | every cell holding that value: `[[x, y], …]` (e.g. find `"@"`) |

### Paths

| function | returns |
|---|---|
| `$gridPath(grid, from, to, options?)` | `{found, path: [[x, y]…], cost, visited}` — A*, optimal with costs. `to` may be a list of cells: the nearest one is reached. `smooth: true` keeps only turning points (line of sight). `maxVisits` caps the work. |
| `$gridNext(grid, from, goals, options?)` | the next cell `[x, y]` towards the nearest goal (or `from` when there or stuck). `flee: true` moves away. **Flow field**: the distance map of `goals` is computed once and cached, so 100 units stepping towards the same target cost almost nothing (0.03 ms per call on 256 × 256). |
| `$gridDistance(grid, sources, options?)` | number matrix: cost to reach each cell from the nearest source, `-1` if unreachable. `max` stops early. |
| `$gridReach(grid, from, budget, options?)` | cells reachable with a movement budget: `[[x, y, cost]…]` (tactics move range) |

Measured on 256 × 256: A* across a 255 × 255 maze 3 ms, distance map 6 ms, flood fill of the whole grid 7 ms — all well inside the store's default 50 ms budget.

### Sight

| function | returns |
|---|---|
| `$gridLine(a, b)` | Bresenham cells from `a` to `b`, both included |
| `$gridSight(grid, a, b, options?)` | `true` if no opaque cell lies between (`walk: true`: no wall, arrival included) |
| `$gridFov(grid, origin, radius, options?)` | visible cells `[[x, y]…]` (walls that are seen included), recursive shadowcasting. `as: "mask"` returns text rows (`on` `"1"`, `off` `"0"`); `into: <previous mask>` keeps already explored cells (fog of war). |

### Regions and cell games

| function | returns |
|---|---|
| `$gridFlood(grid, start, options?)` | connected cells with the same value as `start` (`match: "walkable"`: all passable cells), `diag`, `max` |
| `$gridFill(grid, start, value, options?)` | new grid, that region repainted (paint bucket, territory capture) |
| `$gridRegions(grid, options?)` | every connected region, largest first: `[{id, value, size, at, bounds: [x0, y0, x1, y1], cells?}]`. `values`: only those values (`"."`); `cells: true` lists the cells (4096 per region at most) |
| `$gridMatches(grid, min?, options?)` | runs of at least `min` (3) identical cells: `[{value, cells, dir: h|v|d1|d2}]`; `diag: true` adds diagonals; `ignore: "."` skips empty cells (match-3, N in a row) |
| `$gridFall(grid, empty, dir?)` | new grid where non-empty cells fall towards `dir` (`down`, `up`, `left`, `right`); walls stay and hold what is above |
| `$gridLife(grid, rule?, options?)` | one (or `steps`) cellular automaton step, rule `"B3/S23"` (Life) by default; `alive` `"#"`, `dead` `"."`, `wrap: true` (torus), `edge: "alive"` |
| `$gridContours(grid, options?)` | smooth closed outlines of the "inside" cells (`values`, default: the walls): `[{points: [[x, y]…], hole, depth, area}]` in world units (`scale` = size of a cell, `offset`), marching squares then `smooth` Chaikin passes (2). `border: "fill"`: walls beyond the edge (a cave). With `sprites: {prefix, fill, holeFill, stroke, line, layer, z}` it returns a list ready for `sonic-2d sprites="…"`: polygons in nesting order, `fill` for inside regions, `holeFill` for holes (give the scene background the wall colour when `border` is `fill`). A 100 × 70 cave ≈ 16 ms, 25 polygons. `sonic-swarm` with `grid.smooth` (same value, `cell` = `scale`) collides with exactly these outlines |

## Generation (seeded)

| function | returns |
|---|---|
| `$genMaze(w, h, seed, options?)` | perfect maze of `w × h` cells as `(2w+1) × (2h+1)` text rows. `algo`: `backtracker` (long corridors, default), `prim` (many short dead ends), `kruskal`, `wilson` (unbiased). `wall` `"#"`, `floor` `"."`. Up to 127 × 127 cells. |
| `$genCave(w, h, seed, options?)` | cave rows: random fill (`fill` 0.45) smoothed by `steps` (4) automaton passes (`rule` `"B5678/S45678"`); only the largest pocket is kept, so every floor cell is reachable (`keep: "all"` to keep all) |
| `$genDungeon(w, h, seed, options?)` | `{rows, rooms: [{x, y, w, h, center}]}`: BSP split, one room per leaf (`min` 4, `max` 10, `depth` 4), L corridors: everything is connected |
| `$genPoisson(w, h, r, seed, options?)` | points `[[x, y]…]` at least `r` apart (trees, enemies, stars), `max` 2000 |
| `$genNoise(w, h, options?)` | coherent noise map: matrix of numbers in [-1, 1], or text rows with `levels: [[-0.2, "~"], [0.3, "."], [9, "^"]]` (first threshold above the value wins). `seed`, `scale` (0.1), `octaves` (4), `kind`: `fbm`, `ridge`, `warp` |
| `$noise(x, y, options?)` | one noise value (same options) |
| `$genWfc(sample, w, h, seed, options?)` | Wave Function Collapse: new rows (≤ 128 × 128) that only use neighbourhoods seen in `sample` (small text grid, 32 distinct characters at most), with its frequencies. `periodic` (output tiles seamlessly), `wrapSample`, `fixed`: rows where `?` is free and any other character is imposed (borders, an entrance, a key cell), `tries` (8). Throws when the imposed cells contradict the sample. 64 × 64 ≈ 7 ms |
| `$genVoronoi(w, h, seed, options?)` | `{rows, sites}`: Voronoi regions on a grid, `count` sites (8), `relax` Lloyd passes (0–10, more regular), `metric` `euclid`/`manhattan`, `values`: characters cycled per region (countries, biomes, shards) |
| `$delaunay(points)` | `{triangles: [[i, j, k]…], edges: [[i, j]…]}` (indices into `points`, 2000 at most) |
| `$mst(points)` | minimum spanning tree `[[i, j, length]…]`: the shortest network linking all points (connect dungeon rooms, draw constellations, roads); add a few `$delaunay` edges back for loops |

A level is fully described by its seed: store the seed, regenerate when needed (`$genMaze(10, 10, $state.level)`), or store the rows once in `@init`.

## Two-player alignment boards

Tic-tac-toe, connect four (`gravity: true`), gomoku… Boards are text rows; `.` is empty (`empty` option), players are single characters. `n` is the winning length (default 3 up to 4 × 4, 5 from 9 × 9, 4 otherwise). 400 cells at most.

| function | returns |
|---|---|
| `$boardWinner(board, options?)` | `{winner: "x" \| null, line: [[x, y]…], draw}` |
| `$boardMoves(board, options?)` | legal moves `[[x, y]…]` (with `gravity`: the lowest empty cell of each column; on big boards without gravity: cells within 2 of a stone) |
| `$boardPlay(board, at, player, options?)` | new board: `at` = `[x, y]`, or a column (number or `[x, …]`) with `gravity`; an illegal move returns the board unchanged |
| `$boardBest(board, player, options?)` | `{move: [x, y], column, score, depth, nodes}` or nothing when the game is over. `algo`: `minimax` (default: alpha-beta, iterative deepening, transposition table — perfect play on tic-tac-toe, strong on connect four) or `mcts` (random playouts, `iterations`, `seed`). Always takes an immediate win and blocks an immediate loss. `ms` time budget (40, 200 at most), `depth` limit (lower = easier opponent: 1–2 beginner, 4 medium), `opponent` character when the board has no opponent stone yet. `score`: `"win"`, `"loss"` or a heuristic number |

Computer turn in a reducer:

```jsonata
$action.type = 'play' ? (
  $b := $boardPlay($state.board, $action.payload.column, 'x', {'gravity': true});
  $b = $state.board or $boardWinner($b, {'gravity': true}).winner ? $merge([$state, {'board': $b}]) : (
    $ai := $boardBest($b, 'o', {'gravity': true, 'depth': $state.level});
    $merge([$state, {'board': $boardPlay($b, $ai.column, 'o', {'gravity': true})}])
  )
) : $state
```

## Moving crowds

For dozens of agents moving every frame (schools, flocks, chasers, crowds flowing through a generated maze), use the `sonic-swarm` component ([../swarm/swarm.md](../swarm/swarm.md)): it runs at 60 Hz, reads the same text grids for walls and flow fields, and sends captures to your store.

## Seeded chance

Each returns `seed`: write it back to the state for the next draw.

| function | returns |
|---|---|
| `$shuffled(list, seed)` | `{value: shuffled copy, seed}` (Fisher–Yates) |
| `$pick(list, seed, weights?)` | `{value, index, seed}`; `weights`: list of numbers, or the name of the field holding the weight (`"w"`) — loot tables |
| `$bag(rest, items, seed)` | `{value, bag, seed}`: every item comes out once before the bag is refilled and shuffled (no three identical pieces in a row). Keep `bag` in the state, pass it back as `rest`. |
| `$roll(notation, seed)` | `{value, rolls, min, max, seed}` for `"2d6+1"`, `"d20"`, `"4d6kh3"` (keep highest 3), `"2d20kl1"`, `"d%"`, `"4dF"`, `"1d8+1d6-2"`; 100 dice at most |

## Interpolation

`$lerp(a, b, t)`, `$remap(v, a0, a1, b0, b1, clamp?)`, `$approach(v, target, step)`, `$angleDelta(a, b)` and `$angleLerp(a, b, t)` (degrees, shortest way), `$ease(name, t)` with `linear`, `smoothstep`, `smootherstep` and `in|out|inOut` + `Quad`, `Cubic`, `Quart`, `Quint`, `Sine`, `Expo`, `Circ`, `Back`, `Elastic`, `Bounce` (e.g. `"outBack"`).

`$damp(current, target, velocity, smoothTime, dt, maxSpeed?)` → `{value, velocity}`: critically damped follow (camera, gauge, UI), frame-rate independent; keep `velocity` in the state.

## State machine

`$fsm(machine, state, event, context?)` → next state name (unchanged when nothing applies; `initial` when `state` is empty). `event` is a name or an action (`$action`, its `type` is used).

```json
{"initial": "idle", "states": {
  "idle":  {"on": {"see": "chase"}},
  "chase": {"on": {"lost": "idle", "hit": [{"target": "flee", "when": {"hp": {"lt": 3}}}, {"target": "fight"}]}},
  "*":     {"on": {"die": "dead"}}
}}
```

Guards (`when`) compare context paths (`"stats.hp"`) with a value or `{lt, lte, gt, gte, eq, ne, in}`; the first matching transition wins; `"*"` applies from every state.

## Hex grids

Axial coordinates `[q, r]`. `$hexDistance(a, b)`, `$hexNeighbors(h)`, `$hexRing(h, n)`, `$hexRange(h, n)` (all cells within `n`), `$hexLine(a, b)`, `$hexToPixel(h, size, "pointy" | "flat")`, `$hexFromPixel([x, y], size, orientation)` (tap → cell).

## Graphs

A graph is `{"edges": [["a", "b", 2], ["b", "c"]], "directed": false}` (weight 1 by default) or an adjacency object `{"a": {"b": 2}, "b": ["c"]}` (directed).

`$graphPath(graph, from, to)` → `{found, path: [names], cost}` (Dijkstra; `to` may be a list), `$graphReach(graph, from, max)` → `{name: cost}`, `$topoSort({"forge": ["mine", "fire"], "fire": []})` → an order where each node comes after its prerequisites (skill trees, quests, recipes; throws on a cycle and names it).

## Recipes

Player moves, monsters chase, fog of war — one store, `budget-ms` default:

```json
{
  "tag": "sonic-store",
  "attributes": {
    "id": "game",
    "initial": {
      "map": ["##########", "#@...#...#", "#.##.#.#.#", "#..#...#M#", "##########"],
      "explored": []
    },
    "reducer": "$action.type = 'move' ? ( $p := $gridFind($state.map, '@')[0]; $to := [$p[0] + $action.payload.dx, $p[1] + $action.payload.dy]; $gridGet($state.map, $to) = '.' ? ( $map := $gridSet($gridSet($state.map, $p, '.'), $to, '@'); $m := $gridFind($map, 'M')[0]; $next := $gridNext($map, $m, $to); $map2 := $gridGet($map, $next) = '.' ? $gridSet($gridSet($map, $m, '.'), $next, 'M') : $map; $merge([$state, {'map': $map2, 'explored': $gridFov($map2, $to, 6, {'as': 'mask', 'into': $state.explored})}]) ) : $state ) : $state"
  }
}
```

New maze level on demand:

```jsonata
$action.type = 'next' ? $merge([$state, {'level': $state.level + 1, 'map': $genMaze(12, 8, $state.level + 1, {'algo': 'wilson'})}]) : $state
```

Loot with a kept seed:

```jsonata
$action.type = 'open' ? ( $d := $pick($state.loot, $state.seed, 'w'); $merge([$state, {'seed': $d.seed, 'got': $append($state.got, $d.value.name)}]) ) : $state
```

Match-3 resolution step:

```jsonata
( $runs := $gridMatches($state.board, 3, {'ignore': '.'});
  $cells := $runs.cells;
  $count($cells) = 0 ? $state : $merge([$state, {'board': $gridFall($gridSet($state.board, $cells, '.'), '.'), 'score': $state.score + $count($cells)}]) )
```

Render a text grid with a `sonic-list` (one row per string), `sonic-2d` tiles, or read the rows in a `sonic-shader` through a DataProvider.
