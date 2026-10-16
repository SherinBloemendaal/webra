# WebRA contracts

Shared agreements between the parts of the monorepo. Every part builds against
this document; change it first (in its own commit) when a contract has to move.

## 1. Layout and ownership

| Path | What | Notes |
|------|------|-------|
| `engine/` | Rust simulation (`webra-sim`), compiled to WebAssembly | Deterministic, integer math only |
| `apps/game/` | Browser client, served at `https://webra.sherin.dev/play/` | ES modules, no bundler, WebGPU |
| `apps/game/editor/` | Map editor, served at `/play/editor/` | Same engine package for previews and test play |
| `apps/website/` | Landing site, served at `https://webra.sherin.dev/` | Static, no framework |
| `apps/server/` | Cloudflare Worker: static assets, HTTP API, Durable Objects | `wrangler.jsonc` lives here |
| `packages/protocol/` | Multiplayer message definitions and validators (plain JS) | Imported by `apps/game` and `apps/server` |
| `data/` | Red Alert catalog extracted from OpenRA; `data/webra/rules.yaml` holds WebRA's own actors (OpenRA MiniYaml) | Input for `tools/gen_rules.py` |
| `tools/` | `gen_rules.py`, `shader-check`, `check-js.mjs` | |

The browser imports `packages/protocol` through the path `/play/protocol/` (the
build copies `packages/protocol/src` to `dist/play/protocol/`). In the repo
`apps/game/protocol` is a symlink to `../../packages/protocol/src`, and the game
imports it only through the re-export file `apps/game/js/protocol.js` (from
`../protocol/index.js`), so the same path works in local dev and in `dist/`.

## 2. Map format (`.webra-map.json`, formats 1 and 2)

```jsonc
{
  "formatVersion": 2,               // the map format version, see "Map versions" below (absent: 1)
  "gameVersion": "0.9.0",           // the WebRA release that wrote the file (optional, never part of the identity)
  "format": 2,                      // 1 (ore only) or 2 (ore and gems), see below
  "name": "Twin Rivers",            // 1..64 chars
  "author": "Commander",            // 1..64 chars
  "description": "",                // 0..500 chars
  "width": 96, "height": 96,        // 32..256 each
  "terrain": "<base64>",            // width*height bytes, row-major, values: 0 clear, 1 rough, 2 rock, 3 water, 4 tree, 5 ford, 6 road, 7 bridge, 8 beach, 9 river, 10 wall
  "ore": "<base64>",                // width*height bytes, 0..12 ore density
  "gems": "<base64>",               // format 2 only: width*height bytes, 0..3 gem density
  "spawns": [[8, 8], [85, 84]],     // 2..8 top-left cells of the starting construction yard / MCV
  "actors": [                       // optional pre-placed actors
    { "type": "SBAG", "owner": -1, "x": 40, "y": 40, "facing": 0 },  // owner: spawn index, or -1 for neutral; type: 1..16 of A-Z a-z 0-9 . (V19.Husk)
    { "type": "APC", "owner": 1, "x": 50, "y": 60, "facing": 256, "health": 60, "stance": "defend", "veterancy": 1, "cargo": ["E1", "E3"] }  // state: see "Map setup"
  ],
  "rules": null,                    // optional rules overrides, see below
  "biome": "snow",                  // optional: temperate (default, left out), snow or desert
  "players": [                      // format version 2: the player slots, see "Map setup"
    { "faction": "randomsoviet", "team": 1, "color": -1, "type": "open", "difficulty": "normal", "bot": "normal", "lock": ["faction"] }
  ],
  "options": { "startingCash": 10000, "techLevel": "medium" },  // lobby options the map starts with
  "lockedOptions": ["techLevel"],   // options the lobbies keep at the map's value
  "tags": ["2 players", "naval"]    // up to 8
}
```

- Terrain: a ford (5) is a river crossing. Ground units cross it at rough
  speed (the locomotor's `Rough` entry); to ships and the Transport it is
  land, like OpenRA's ford templates (Rough and Road cells), so no ship ever
  sails over one. Structures never stand on a ford (naval yards need open
  water), and fords hold no ore or gems. Generated maps put fords where
  ground routes cross water, never on a base's route to the shared sea.
  Maps made before fords closed to ships keep their fords and need no
  migration (the file format is unchanged): water that only a ford joined
  is two bodies of water now. A ford
  is drawn as a crossing (WebRA's shallow ford tiles; with the original
  graphics rough ground with beach tiles, like Red Alert's ford templates),
  never as open water, since ground units walk on it.
- Terrain types 6 to 10 are OpenRA's (`data/source/rules/world.yaml`,
  `defaults.yaml`; speeds per locomotor in `engine/rules.json`): road (6)
  is clear ground with OpenRA's road speed, buildable and able to hold
  resources; bridge (7) is the deck of a bridge actor (as fast as a road,
  never buildable); beach (8) is passable sand that slows everything,
  wheeled vehicles most (50 %), and holds no resources or structures; river (9) and wall (10)
  stop ground units and ships alike. The engine owns bridge cells: a
  bridge actor writes its template's terrain over them when it is placed,
  damaged, destroyed or repaired, so a destroyed span turns into river or
  water under it (`engine/src/bridges.rs`). Whatever cannot stand on a
  span's new terrain dies: a tank on a fallen span, a paratrooper coming
  down onto it (OpenRA's ActorMap holds it already; aircraft in the air
  fly on), a boat in the water gap of a long bridge when the span is
  repaired (OpenRA kills only when a span falls or a dead one is
  repaired).
- The neutral world (`engine/src/neutral.rs`): actors with owner -1 belong
  to a neutral player that never attacks and never wins. Trees (`T01`...), civilians (`C1`...`C11`), civilian buildings
  (`V01`...`V37`, huts, windmill), tech buildings (`HOSP`, `BIO`, `MISS`,
  `FCOM`, `OILB`), barrels (`BARL`, `BRL3`, `AMMOBOX1`...), rocks, ice floes,
  bridges (`BRIDGE1`...`BRIDGE4`, `SBRIDGE1`...`SBRIDGE4`, `BR1`...`BR3`),
  ore mines (`MINE`, `GMINE`) and the map-only walls (`CYCL`, `BARB`,
  `WOOD`) and France's fake Sub Pen (`SPEF`) are ordinary actors of the
  `actors` list. Tree terrain (4) of older maps becomes tree actors when
  the game starts (one per cell, deterministic). A bridge actor goes at the
  top-left cell of its template; its footprint is all `-` (lies over the
  cells without claiming them), and the engine places its huts itself.
  Generated maps get an ore mine (gem mine on gems) at the heart of every
  field, mirrored like the bases, and tech buildings and villages (section 3,
  `techBuildings`).
- Presentation of the neutral world: panicking civilians (ScaredyCat) draw
  their second sprite slot, where soldiers have the prone pose (original
  art: `panic-stand`, `panic-run`); burning trees show decoration special 2,
  4 or 5 by damage state (Light, Medium, Heavy: OpenRA's burn-s, burn-m and
  burn-l, whose start, loop and end frames the engine names from
  `Game.set_original_slots` records 3 and 4: size, milliseconds per frame,
  start frames; size, loop and end frames), special 3 is the hospital's red
  cross (pips medic); tech buildings with WithDeathAnimation leave a dying
  body that shows their `dead` sequence (die1) with the original art; cash ticks (OpenRA FloatingText,
  `World::show_cash_tick(actor, owner, amount)`: "+$100" in that player's
  colour over the actor, for everyone who sees the spot) are `CashTick` (44)
  events that js/battlefx.js draws like the crate and bounty texts, from
  GivesCashOnCapture, CashTrickler, InfiltrateForCash and DeliversCash. Landing craft (the Transport, locomotor
  `lcraft`) use their own passability (`World::pass_landing`: water and
  beaches), so they run up on beach cells to unload and other ships do not.
  No ship is ever on a cell its locomotor cannot enter (OpenRA `naval`:
  Water; `lcraft`: Water and Beach; `World::terrain_open_to`): every move
  and crowd push goes through `World::may_enter`, a map actor drawn on
  terrain it cannot use appears on the nearest cell it can (within 7 cells,
  else it is left out; OpenRA leaves it stuck where it is), and the map
  editor places ships and naval yards only on water (`rules_json` actors:
  `terrain`, the terrain codes a ground unit or ship may stand on, and
  `onWater` for structures). A map actor on a cell a structure of the map
  holds (OpenRA maps can put a civilian on its house) stays there, as in
  OpenRA (no placement check), and walks off when it moves: a unit on a
  cell blocked for it paths from the open neighbour nearest its goal and
  steps off first (`World::nearest_reachable`, movement/cellmove.rs
  `route_next`). A game on a map file computes the connectivity labels of
  the cells once for all the map's actors, structures, bridges and husks
  alike (`World::place_map_actors`, `placing_map_actors`; mission maps
  too). A wandering civilian whose stroll cannot start waits a fresh
  Wanders countdown like OpenRA's (the queued Move ends at once and the
  unit becomes idle), instead of asking for a path every tick.
- Biome (`engine/src/weather.rs`): `temperate`, `snow` or `desert`, the
  terrain look and which weather can happen (section 3). It is optional:
  absent means temperate, and a temperate map leaves the key out of its
  canonical form, so every map from before biomes keeps its hash. A biome is
  not a rules override: a map with a biome is not modded. Unknown values are
  refused (`biome must be one of temperate, snow, desert` in
  `packages/protocol`, a parse error in the engine).
- Formats: format 2 is format 1 plus the `gems` layer. A format 2 map must
  have `gems`; a format 1 map must not (`"gems": null` counts as absent).
  Every reader (engine, `packages/protocol`, editor, server) accepts both.
  Writers (the engine's `MapData::from_map` and `Game.generated_map`, the
  editor) write format 2 when any cell holds gems and format 1 otherwise, so
  maps without gems keep the identity they had before gems existed. A format
  2 map with an all-zero gems layer is valid, but it is a different map
  (different hash) from its format 1 twin.
- Resources (OpenRA `ResourceLayer`): ore holds up to 12 bales per cell,
  gems up to 3. Both lie on clear or rough ground or roads only, and a cell holds ore
  or gems, never both. A bale pays `player.ore_value` (25) or
  `player.gem_value` (50) credits (OpenRA `PlayerResources.ResourceValues`);
  a harvester carries 20 bales of either or both and the refinery pays each
  bale at its own value. With the `oreRegrowth` option ore mines (`MINE`)
  and gem mines (`GMINE`) grow one bale every 75 ticks on the first cell of
  a random walk from the mine that can take one (OpenRA `SeedsResource`);
  without mines, fields never grow back.
  Gem cells slow units like ore cells (OpenRA gives the `Gems` and `Ore`
  terrain types the same locomotor speeds). Harvesters pick the nearest
  resource cell by distance only, gems or ore alike, as OpenRA does
  (`FindAndDeliverResources.ClosestHarvestablePos`). `Game.actor_json`
  reports `bales` and `gemBales` (how many of them are gems); the terrain
  texture (`Game.terrain_ptr`, RGBA per cell) has the terrain type in R, ore
  density in G and gem density in B, each density scaled to 255 at its
  maximum. Previews colour gem cells (190, 70, 150), ore cells (200, 160, 50).
- Validation errors for the layers (engine wording, `packages/protocol`
  matches it): `format 1 maps have no gems layer`, `format 2 maps need a gems
  layer`, `unsupported map format N`, `invalid gem density N`, `gems can only
  lie on clear or rough ground or roads`, `a cell cannot hold both ore and gems`,
  `the gems layer must have N bytes`, `gems is not valid base64`.
- Identity: `sha256` (hex) of the canonical JSON of the map *after its
  upgrade to the current format version* (see "Map versions"): top-level keys
  in the order above (`formatVersion` first and only when it is not 1,
  `gameVersion` never, `description`, `actors` and `rules` always present,
  `gems` only in format 2, right after `ore`, `biome` last and only when it
  is not temperate; `actors` entries
  as `type, owner, x, y, facing`), keys inside `rules` sorted alphabetically at
  every level, integers only, no whitespace. `Game.map_canonical(json)` returns
  exactly that string; JavaScript implementations must match it byte for byte
  (tests compare against the engine). The server and clients check the hash
  after every download.
- Size limit: 1 MiB serialized.
- `rules` overrides (the rules.ini story): a partial copy of `engine/rules.json`
  keyed by id: `{ "actors": { "1TNK": { "cost": 400, "unit": { "speed": 150 } } }, "weapons": { "25mm": { "range": 6000 } } }`.
  Deep-merged over the built-in rules before the game starts. Unknown ids or
  fields are rejected. Arrays are replaced whole; `kind` and `queue` never
  change, so objects inside a replaced array (warheads, support powers) must
  repeat the built-in `kind` at the same position. The engine then checks
  every merged value (ranges, list lengths, shapes, references to weapons and
  actors). **Any map with `rules` is a modded map**: the client
  shows a warning ("This map changes game rules (costs, damage, speed...). It
  can be unfair or act as a cheat.") with a list of what the rules change,
  one line per value from the built-in value to the map's (times in ticks
  also as game time at normal speed; `js/maprules.js` `describeMapRules`,
  in the skirmish lobby, the online lobby and for replays and saves), and
  the player must accept before the map is installed. The lobby shows a
  MODDED badge for such maps.
- Engine API (landed): `Game.from_map(mapJson, optionsJson)` builds a world
  from a map (players fill spawns in slot order, extra spawns stay empty,
  neutral actors get a passive owner); `Game.map_hash(mapJson)`,
  `Game.map_canonical(mapJson)`, `Game.validate_map(mapJson)` returns
  `{ ok, errors: [], modded, hash }` (all of them read the current map format
  version only); `Game.generated_map(seed, size, players)`
  exports a generated temperate map file in the seed's style (format 2:
  generated maps have gems; a map file with `formatVersion` and this
  release's `gameVersion` in front, `MapData::file_json`) and `Game.generated_map_styled(seed, size,
  players, style, biome)` any style and biome (names as in section 3,
  `random` resolved from the seed); previews: `Game.map_file_preview(mapJson)`,
  `Game.map_preview_players(seed, size, players)` and
  `Game.map_preview_styled(seed, size, players, style, biome)` (RGBA per
  cell in the biome's colours, spawns in player colours);
  `Game.map_spawns_styled(seed, size, players, style)` the spawns
  `generated_map_styled` places, flat `[x0, y0, x1, y1, ...]`, from the
  map alone (no actors, no map file: the lobby previews);
  `Game.resolved_style(seed, style)` and `Game.resolved_biome(seed, biome)`
  name what `random` picks.
- Map editor (presentation only, never ticked): `Game.editor_preview(mapJson)`
  builds the world a game on a map file starts with (its actors, the trees of
  tree terrain, bridges) without validating it and without starting units, for
  `build_render` and `terrain_ptr` with the spectator view (player 255); spawn
  k's actors are player k, neutral ones player 8. On such a preview,
  `editor_cells()` gives per cell the flags 1 passable, 2 buildable, 4
  reachable by ground from spawn 1, 8 on a shortest ground path between starts,
  and in the high byte the spawn that reaches the cell first (255 none);
  `editor_report()` is JSON with per spawn `rush` (ground steps to the nearest
  other start, or null), `ore`, `oreCells`, `gems`, `gemCells`, `buildable`
  (within `reach` cells), `zone`, `harbourCells`, `navalYardSite`, and the
  totals and `unreachableSpawns`. `editor_fog(k)` is the fog the player of
  spawn k starts a game with (default starting units), one byte per cell.
- Editor test play: the editor writes the map to sessionStorage
  `webra.editor.testMap` and a setup to `webra.editor.testSetup`
  (`{ players: [{ type, faction, difficulty, bot, team }], camera: [x, y] |
  null, autostart }`) and opens `/play/?editorTest=1`; the lobby checks the
  slots like stored settings, the camera starts at `camera` (world pixels) and
  `autostart` starts the game at once.
- Map lens (`apps/game/js/maplens`, presentation only): a round magnifier
  over a map preview that shows the real map under the pointer as a game on
  it starts, fog free like the preview: terrain with ore, gems, cliffs and
  water, bridges, buildings, units and trees, and the start positions. The
  map is read through `Game.editor_preview(mapJson)` (map
  files, and generated maps through `Game.generated_map_with` with the
  lobby's seed, size, player count, style, biome and tech buildings) or
  `Game.from_mission(text, '{"seed":1}')` (missions: their actors after
  `WorldLoaded`, in the mission's colours), copied out (`terrain_ptr`,
  `build_render` for the spectator view 255) and the engine game is freed.
  The read does not wait for the first hover and never runs in one go: as
  soon as a preview with a lens is shown (`setSource`, `attach`; a preview
  that is not on screen waits) `LensArt.mapSteps`, `generatedSteps` and
  `missionSteps` (generators) read it one part per idle task
  (`requestIdleCallback` with a 500 ms timeout, else a timer): the engine's
  map, the rules, the sprite atlas, the world's terrain and sprites, the
  terrain tiles. A pointer that comes before the map is in sees the
  preview's pixels, dimmed, under a ring that fills with the share read, a
  turning arc (not with "Reduce motion", the setting or the browser's: then
  the ring alone shows the progress) and "Loading map"; the remaining
  steps then run in zero-delay tasks, never inside a frame or a pointer
  event. Another map stops an unfinished read (`return()` frees its engine
  game). Measured in Node with the real engine and WebRA's art (fake 2D
  canvases, so canvas drawing is not counted; a fresh `LensArt` per map,
  so every atlas is built): before, the first hover's longest task was
  339 ms (96 x 96, 2 players, cold), 160 ms (128 x 128, 4) and 238 ms
  (160 x 160, 8), all of the read in one frame; after, with the read done
  in the background first, the hover path's longest task is 6.4 to 6.9 ms
  (a frame's tile budget), and the read's longest single step 45 to 65 ms
  (the sprite atlas, built once per rule set and biome) in an idle task of
  its own; a pointer that comes first waits for the same steps in their own
  tasks while the frames stay within the budget. The players'
  colours (`setColors`: player k's actors) and the start markers
  (`setMarkers`) change without reading the map again; the marker under
  the pointer or keyboard focus (`setHotMarker`, from js/spawnpick.js) gets
  a ring, and the lens never takes a click (`pointer-events: none`), so a
  click on a start marker under it picks that start position (section 4,
  "Start positions"). A touch hold that showed the lens is no tap
  (`heldRecently`: until 700 ms after the finger lifts).
  It is drawn with the game's art (`js/gameart.js` `buildGameAtlas`, the
  biome's terrain tiles, installed original graphics or texture packs when
  chosen, else WebRA's) by `js/maplens/raster.js`, a 2D canvas port of
  `shaders/terrain.wgsl` and the frame choice of `shaders/sprite.wgsl` with
  the render clock at 0 and clear weather, so it needs no WebGPU context.
  The map is cut into tiles of 8 x 8 cells at 24 pixels per cell, drawn a
  few rows per animation frame within a 6 ms budget (the preview's pixels
  stand in until a tile is ready) and kept in an LRU cache of 64 tiles per
  lens (about 9 MB of tile canvases); one view needs at most 36 (below), so
  drawing never evicts a tile the same view still needs. At most two sprite
  atlases are kept, and all of it is let go when a game starts (`LensArt.release`). The lens starts at half the game's
  zoom (`LENS_START_FACTOR` of `baseZoom` at the player's game scale, at the
  render ratio a game uses: `gameScaleFor`), so it shows twice the map
  around the pointer; not at the zoom the player last used in a game
  (`game.zoomFactor`), which is for playing. When it shows (mouse): only
  while the pointer is over the preview and the magnify key is held
  (`magnifyHeld`: Ctrl; on macOS also Cmd, because Ctrl + click is the
  system's right click there), so a plain preview never covers a click on
  a start marker; pressing the key under a resting mouse shows it at once
  (window `keydown`/`keyup`), releasing it, leaving the preview or the
  window losing focus (a lost key release) hides it. While the mouse is
  over a preview with a lens and the key is up, a small click-through hint
  (`.map-lens-hint`, `aria-hidden`) at the bottom of the preview says "Hold
  Ctrl to magnify, scroll to zoom" ("Hold Cmd or Ctrl ..." on macOS). The
  mouse wheel zooms it only while it shows after the pointer moved over the
  preview, between `lensZoomLimits`: out to `LENS_MIN_ZOOM` (0.25 CSS px per
  world pixel at game scale 1, half the game's `MIN_ZOOM`: about 29 cells
  across the 176 px lens of UI scale 1 at game scale 1), but never wider
  than `LENS_MAX_VIEW_CELLS` (40) cells across: the lens's size follows the
  UI scale (`--ui-px`) and the zoom the game scale, so at UI 1.3 and game
  0.67 the plain limit would span 57 cells (81 tiles) and at UI 2 and game
  0.5 even 117; with the cap one view is at most 6 x 6 tiles. In: to the
  game's `MAX_ZOOM`. While it shows the
  wheel never reaches the page, also at a limit (Ctrl + wheel would zoom
  the browser page). Without the key the wheel scrolls the page. The same
  rule on every preview with a lens (lobbies, campaign, the editor's
  thumbnail). On touch and with a pen (no key at hand), press and hold
  (350 ms) shows it above the finger or pen tip, without a key. Keyboard
  focus does not open it (it is decorative; the markers and preview keep
  their labels). It is `aria-hidden`,
  never focused, placed through CSSOM custom properties (CSP) and sized in
  `--ui-px` (`css/maplens.css`). Previews with a lens: the skirmish lobby,
  the online lobby (generated maps, installed shared and community maps,
  co-op missions), the campaign screen and the map editor's thumbnail. None
  where only the server's PNG exists (the website's map list, the editor's
  community map list): that would mean downloading every map and the
  engine and art into those pages; and none on an Install/Decline question,
  which shows no preview until the map is installed.

### Map versions (`formatVersion`, `gameVersion`)

Maps made for one release keep working when a later release renames or
rewrites things: every map file names its **map format version**, and older
files are upgraded automatically by one chain of migrations that every
reader shares (`packages/protocol/src/mapversions.js`).

- `formatVersion`: a whole number, 1 to 65535. A file without it is format 1,
  forever: format 1 is the baseline, every map made before map versions
  existed (pinned by `packages/protocol/test/fixtures/maps/format1-*`). The
  current format is `MAP_FORMAT_VERSION` (protocol) and `FORMAT_VERSION`
  (`engine/src/mapdata.rs`), now 2. It is a different thing from `format`
  (1 or 2), which only says whether the gems layer is there and stays part
  of every map for its identity.
- `gameVersion`: the release that wrote the file (1 to 32 of `0-9 A-Z a-z . +
  -`, null counts as absent). Provenance only: messages name it, nothing else
  reads it, and it is never part of the canonical form or the hash.
- Writers write the **file form**: `formatVersion` (always) and `gameVersion`
  (this release, `packages/protocol/src/version.js` `GAME_VERSION`, kept in
  step by release-please) in front, then the canonical body, compact JSON:
  the map editor's Save (`mapFileJson`, through `mapFileText`), the generator
  (`Game.generated_map*`, `MapData::file_json`: the same bytes), the
  `.oramap` importer and `tools/map-upgrade.mjs`. Mission maps inside mission
  files (section 9) name `formatVersion` only when it is not 1
  (`tools/gen_missions.py`), so mission files do not change with every
  release; the engine reads them like map files.
- Readers upgrade first: `validateMap` and `parseMap` run `upgradeMap`, and
  everything that loads a map goes through them (skirmish lobby
  `inspectMapFile`, the online lobby, the map library, the map editor, the
  server, the tools); what they validate, hash, store and hand to the engine
  is the upgraded map. The engine parses the current format only and refuses
  anything else when it reads the JSON, map files and mission maps alike:
  `this map is in map format N, made by a newer version of WebRA; this engine
  reads format 2`, `this map is in map format N; it must be upgraded to format
  2 before the engine reads it` (a file without `formatVersion` is format 1).
- Outcomes of `upgradeMap(map)` (`{ status, map, notes, problems, message }`):
  `current`; `upgraded` (non-blocking notice "This map was upgraded from an
  older version; save it in the editor to keep the upgrade."); `incompatible`,
  when a migration meets a removed feature or an ambiguous change ("This map
  was made for WebRA x.y (format N) and is no longer compatible with this
  version. Open it in the map editor and save it again.", x.y from
  `gameVersion`, else the last release of that format,
  `MAP_FORMAT_HISTORY[].lastGame`); `newer` ("This map was made with a newer
  version of WebRA (x.y, format N; this version reads format M). Update the
  game to play it."); `invalid` (a malformed `formatVersion` or
  `gameVersion`). A map that upgrades but then fails the protocol or engine
  checks counts as incompatible too: it was valid for the release that made
  it. A current map that fails them is just an invalid map.
- Where players see it: the skirmish lobby (the notice under the installed
  map, the messages as map errors), the online lobby (the host's notice under
  a shared file, the messages in the banner; a downloaded lobby map is checked
  the same way), the map editor (a toast and, until the map is saved, the
  first lines of the Map tab's validation list), the server (422 with the
  message) and the tool's report.
- The map editor opens what others refuse, best effort
  (`apps/game/editor/js/upgrade.js` `openMapFile`, protocol `salvageMap`):
  the upgrades it can run, then structural repairs only (unknown fields left
  out, layers read or rebuilt to the map size, malformed spawns and actors
  left out). Every problem is listed with its location (click to jump) and
  quick fixes (`applyMapFix` actions: `removeActors`, `setActorType`,
  `setTerrain`, `setField`, `moveField`, `dropActorFields`, `accept`;
  actors are named by type and cell, fields by key path, so fixes stay
  right after other fixes), each one undoable. Saving writes the current format.
- Identity and multiplayer: the hash covers the upgraded canonical form.
  `formatVersion` is part of it only above 1, so every map from before map
  versions kept its hash, and a canonical text always says its version
  (absent: 1). The engine plays the upgraded map, lockstep needs every client
  on the same bytes, and two files that upgrade to the same map are the same
  map. So upgrading happens before hashing everywhere: the host's client, the
  server (which stores the upgraded canonical text, `upgradedFrom` in the
  upload answer) and every member (who downloads that text and checks the
  hash) end up with the identical map; the lobby announcement needs no
  version. Online sessions only ever pair identical builds, so they share one
  migration chain.
- Stored maps (D1, migration `0006_map_versions.sql`): `maps.format_version`,
  `maps.upgrade_error`, `maps.upgrade_tried`, `map_aliases(old_hash, old_id,
  hash)`. A row of an older format is upgraded the first time it is read (the
  community list, 25 rows per request, newest first like the list, leaving
  out the rest until then; `GET /api/maps/:id`; a host picking it; a session
  download) and by the daily job (200 a day, oldest first):
  validated like an upload, then json, hash and summary are rewritten in
  place (same id) and the old hash goes to `map_aliases`, so links, lobbies
  and old hashes still find the map (aliases of an alias follow it). When
  the upgraded map is already stored, the two rows merge (listed if either
  was, downloads added up, the listed row's uploader kept) and the old id
  becomes an alias too. A row that cannot be upgraded keeps its text and gets
  `upgrade_error` and `upgrade_tried` (`<format>/<release>`; a later format or
  release tries again): it leaves the list, a lobby refuses it with the
  message, and `GET /api/maps/:id` still serves it as stored, so clients
  explain why and the map editor can repair it. Any other failure (the
  engine, the database) leaves the row as it was for a later try: the list
  leaves it out, a lobby refuses it for now, downloads serve it as stored.
  Upgrades write only rows that are still stale, so concurrent requests never
  count anything twice. Aliases go with their map (daily job).
- Online saves and replays keep the map as played (validated with
  `upgrade: false`): they are pinned to the engine build that made them
  anyway. The local map library (`apps/game/js/maplibrary.js`) upgrades its
  entries on first use (new hash, the old entry goes; an entry that cannot be
  upgraded is removed, its file opens in the map editor).
- `node tools/map-upgrade.mjs [--check] [--out <dir>] [--no-engine] <files>`
  upgrades map files in bulk with the same checks (the engine's too when
  `apps/game/pkg` is built), writes the file form (files from before map
  versions gain their version; current files stay untouched) and lists every
  file that needs an author, with each problem, its location and the editor's
  quick fixes. Exit 1 when a file failed (or `--check` found work).

**Migration policy.** A change that alters what an existing map means needs
a new format version: a renamed or removed actor id, a terrain code that
changes or goes, a field that moves, a new required field, a rules field or
an option value that is renamed or dropped. A purely additive change does
not: a new actor type, or a new optional field whose default is left out of
the canonical form (as `biome` and `gems` were added). To add version N + 1:

1. Bump `MAP_FORMAT_VERSION` (`packages/protocol/src/mapversions.js`) and
   `FORMAT_VERSION` (`engine/src/mapdata.rs`) together; the engine keeps
   reading only the current version.
2. Add the migration `{ from: N, to: N + 1, summary, migrate(map, ctx) }` to
   `MAP_MIGRATIONS`, built from the helpers: `renameActors` (the alias table:
   `{ OLD: 'NEW' }`, `{ OLD: null }` removed, `{ OLD: ['A', 'B'] }` split;
   pre-placed actors and `rules.actors`), `remapTerrain` (`{ old: new }`, or
   `{ old: { fallback, choices, reason } }` when no single code fits),
   `moveField`, `addField` (a new required field with its default),
   `renameRuleFields` and `renameValues` (key paths never use `__proto__`,
  `constructor` or `prototype`). Anything they cannot decide is a
   `ctx.problem` with a location and quick fixes, never a guess. A migration
   is pure and deterministic (no clock, randomness or engine) and is never
   changed after a release has shipped it.
3. Add version N + 1 to `MAP_FORMAT_HISTORY` and set `lastGame` of version N
   to the last release that wrote it.
4. Add fixtures: at least one `format<N>-<name>.webra-map.json` written by
   the old release with its `.expected.json` (`status: "upgraded"`, the
   canonical text and hash after the upgrade), and move the current-format
   fixtures along. `packages/protocol/test/mapversions.test.mjs` fails a
   bump without the migration, the history entry, the fixtures and equal
   engine and protocol versions (CI).
5. Regenerate generated files that hold maps (`tools/gen_missions.py`), run
   `tools/map-upgrade.mjs` on maps kept in the repository, and update this
   section. Stored maps upgrade themselves (above).

### Map setup (format version 2)

Format version 2 (the first real format change, migration 1 to 2 in
`packages/protocol/src/mapversions.js`) lets a map carry its game setup,
checked by `packages/protocol/src/mapsetup.js` and the engine
(`engine/src/mapdata.rs`). The migration adds the four new fields with
their defaults, which change nothing a game does: `players: []`,
`options: {}`, `lockedOptions: []`, `tags: []`. From version 2 on they are
always in the canonical form (defaults filled in, `options` keys sorted).
A format 1 file that already has any of them (or actors with `health`,
`stance`, `veterancy` or `cargo`) is not upgraded silently: each is a
problem (`field-from-later-format`) the author settles in the map editor,
keeping them (the map is read as format 2) or dropping them (fix actions
`accept`, `setField`, `dropActorFields`). A field written as `null` is
refused (protocol and engine alike); leave it out for its default.

- `players`: the player slots, at most one per spawn (OpenRA MapPlayers).
  Lobby slot k is slot k; a spawn without an entry is an open slot with
  nothing set. Each: `faction` (`random`, `randomallies`, `randomsoviet`
  or a country), `team` (0 none, 1..4), `color` (-1 any, 0..7 the lobby
  colours, unique), `type` (`open`: a player or an AI as the lobby likes,
  `ai`: an AI with `difficulty` and `bot`, `closed`), and `lock`: the parts
  players cannot change (`faction`, `team`, `color`, `type`; a locked
  colour needs a colour; a locked random faction allows the countries it
  picks from). A map must be able to start a game: at least two slots
  stay playable (not locked closed), at least one can take a person (not
  locked to an AI or closed), and the playable slots are not all locked to
  the same team (`mapSlotsProblem`, the engine's `validate_setup`).
- `options`: lobby options the map starts with, from `weather`,
  `startingCash`, `startingUnits`, `techLevel`, `gameSpeed`, `timeLimit`,
  `movement`, `factoryLoss` and the boolean options (section 3), with their section 3 values; not
  the generator options (seed, size, style, biome, tech buildings).
  `lockedOptions`: options the lobbies keep at the map's value (each one
  the map sets, once).
- `tags`: up to 8, each 1 to 24 of `a-z 0-9`, spaces and hyphens, no
  repeats; the community list shows and searches them.
- Pre-placed actor state, each left out of the canonical form at its
  default: `health` 1..100 (percent of its hit points; 100), `stance`
  (`hold_fire`, `return_fire`, `defend`, `attack_anything`, only for
  actors with a fire stance; its own), `veterancy` 0..4 (at most the
  actor's levels; 0), `cargo` (up to 16 passenger types that fit the
  transport's cargo types and weight; garrisons excluded; none). A game
  starts them so (quietly: no level-up sound), passengers inside their
  transport and owned by its owner.
- Lobbies: installing the map (skirmish lobby) or picking it (online
  lobby, the server applies it: `applyMapSetup` in `apps/server/src/room.js`)
  sets the listed slots (a person in a slot the map closes or gives to an
  AI moves to a slot the map leaves open; a map without one is refused
  online) and merges the map's options into the lobby's. Whoever comes into
  a slot later (joining, leaving the spectators, moving to another slot, an
  AI the host adds) takes that slot's faction, team and colour from the map
  (`mapSlotSettings`; a colour another slot holds is swapped). Locked parts
  and options are disabled in both lobbies; the server refuses a slot change
  only when it adds a broken lock (`lockedSlotProblems`), so a lobby that
  breaks one can always be repaired, and every start refuses any
  (`lockedSlotProblem`, `lockedOptionProblem`). `Game.from_map` refuses options that break the
  locked options. Lobby map descriptions (`validMapRef` full) carry
  `setup: { players, options, lockedOptions }` from the stored map.
- Thumbnail: `mapThumbnail(map)` (protocol `mapthumb.js`) draws the map
  from its data alone, one pixel per cell (terrain in the biome's preview
  colours, ore and gems, actors at their cell, spawns in their slot's
  colour), never from art, so no original Red Alert graphics can end up in
  it; the server serves it as a PNG for the community list and the map
  editor shows the same picture. Publishing sends the map data only.
- The map editor edits all of it (Setup tab, tags in the Map tab, actor
  state in the selection) and test play starts from the map's slots. The
  `.oramap` importer takes OpenRA's Multi0.. slots (faction, team, colour and
  their locks) and the Health, Stance and Cargo inits of actors. A slot's
  OpenRA `Color` (`RRGGBB`, `RRGGBBAA` or `r,g,b[,a]`) becomes the nearest
  lobby colour by squared RGB distance to the lobby palette (0 blue
  77,140,242; 1 red 230,64,51; 2 gold 242,204,64; 3 green 89,204,102; 4
  purple 204,115,242; 5 orange 242,140,51; 6 teal 102,217,217; 7 white
  217,217,217), skipping colours earlier slots took; a slot without a
  readable colour stays "Any" (-1). `Cargo: e1, e1, e3` (OpenRA CargoInit)
  becomes `cargo` with the editor's checks: known types whose passenger type
  the transport's (non-garrison) cargo takes, within its weight, at most 16;
  the rest is listed as skipped in the import report.

### Importing OpenRA maps (`.oramap`)

The lobby ("Load map file") and the map editor ("Open", or drop a file)
import OpenRA Red Alert maps in the browser (`apps/game/js/oramap/`). The
result is an ordinary map file of this section, in the current format version
with this release as `gameVersion`: it is validated by
`packages/protocol` and the engine before it is installed or opened, the
modded warning applies when it carries `rules`, and the server validates it
on upload like any other map (it never unpacks `.oramap` files itself).

- Package: a ZIP (stored or deflate entries only; deflate through the
  platform's `DecompressionStream('deflate-raw')`) with `map.yaml` and
  `map.bin` at the root or in one folder. Limits: 16 MiB file, 512 entries,
  8 MiB per entry, 32 MiB unpacked in total, compression ratio 1000:1 for
  entries over 64 KiB, output counted while it streams, CRC-32 checked.
  No ZIP64, encryption or multi-disk archives.
- `map.yaml` (MiniYaml, tabs or four spaces): `MapFormat` 11 or 12,
  `RequiresMod: ra`, `Title`, `Author`, `Tileset` (TEMPERAT, SNOW, DESERT,
  INTERIOR), `MapSize`, `Bounds`, `Players`, `Actors`, `Rules`, `Weapons`.
  Limits: 2 MiB, 200000 lines, 100000 entries, depth 32. `map.bin`:
  format 1 or 2 (`Map.SaveBinaryData`: column-major tiles as template id +
  index, optional height layer, resources as type + density), at most
  1024 x 1024.
- Terrain: each tile's OpenRA terrain type comes from the RA tilesets
  (`apps/game/js/oramap/tables.js`, generated by
  `tools/gen_oramap_tables.py` from the OpenRA YAML copied into
  `data/source/tilesets` and `data/source/rules`) and maps as: Clear, Ore
  and Gems to clear; Rough, Road, Bridge, Beach, River and Wall to the
  WebRA terrain of the same name (section 2: roads and bridges faster,
  beaches slow wheels, rivers and walls stop everything, as OpenRA lets
  neither tanks nor ships through rivers); Rock to rock; Water to water;
  Tree to tree (`ORA_TO_WEBRA_TERRAIN`). A tile index of 255 means the
  tile `(x % 4) + (y % 4) * 4` of the template, as OpenRA Map.LoadBinaryData
  reads it; an index the template has no tile for (OpenRA cannot load such a
  map) is a missing tile, clear ground, reported like an unknown template.
  Only the terrain type of each cell is kept: the map file has no tile
  templates, so the game draws the terrain from the types alone (WebRA
  tiles, or tile terrain chosen from the theater's templates when original
  art is installed, `js/content/terrain.js`), not OpenRA's cliff, shore and
  road templates. Unknown templates or tiles become clear (reported).
  Trees (`t01`...) become tree terrain and rocks, ice floes, boxes and
  civilian buildings become rock under their footprint. The map is cropped
  to `Bounds`; more than 256 cells is refused, less than 32 is padded with
  rock on the right and bottom. Tilesets map to biomes in `TILESET_BIOMES`:
  SNOW and DESERT maps get that `biome`, TEMPERAT and INTERIOR are temperate.
- Resources: type 1 is ore, type 2 gems (`RESOURCE_TYPES`), densities
  recalculated like OpenRA (`max(MaxDensity * sameTypeNeighbours / 9, 1)`
  over the 3 x 3 block). A map with gems is written as format 2.
- Spawns: `mpspawn` actors, the first 8 in file order. OpenRA deploys the
  yard one cell up and left of the spawn, so the WebRA spawn is
  `location - (1, 1)` minus the crop; a spawn without clear ground for the
  yard moves to the nearest fitting spot within 8 cells (reported) or is
  dropped. Fewer than 2 spawns is refused.
- Actors: types the engine knows (ids matched case-insensitively) are kept,
  inside the bounds, structures only where they do not overlap a start or
  another structure. Neutral, Creeps and non-playable owners become
  neutral (-1); actors of playable slots (`Multi0`...) go to the nearest
  spawn. `Facing` turns from OpenRA's counter-clockwise WAngle (MapFormat
  12; older maps 0..255) to WebRA's clockwise facing. Everything else is
  listed as skipped.
- Rules: inline `Rules`/`Weapons` and files inside the package (mod files
  such as `ra|rules/...` are not loaded). Mapped fields: `Valued.Cost`
  (build time follows the cost as in OpenRA, or `Buildable.BuildDuration` /
  `BuildDurationModifier`), `Health.HP`, `Mobile.Speed`,
  `Mobile.TurnSpeed`, `RevealsShroud.Range`, `Power.Amount`,
  `Buildable.Prerequisites` (tech level tokens such as `~techlevel.low`
  included); support powers, matched by the trait's full key (`NukePower`,
  `AirstrikePower@spyplane`, `GrantExternalConditionPower@IRONCURTAIN`, ...):
  `ChargeInterval` (ticks in both games: WebRA's tick is OpenRA's, 40 ms at
  normal speed and 20 ms at fastest), `OneShot`, `StartFullyCharged`,
  `Prerequisites` and `DisplayTimerRelationships`, written as the actor's
  whole `abilities.support_powers` list with the built-in entries and the
  changed fields (the list is replaced whole, see `rules` above); weapons
  `Range`, `MinRange`, `ReloadDelay`, `Burst`, `Projectile.Speed`,
  `Projectile.Inaccuracy`, and `Damage` of a single warhead. A later
  duplicate of an actor merges into the earlier one (OpenRA MiniYaml), the
  last value winning. A change to an actor also reaches the actors that
  inherit it in OpenRA (`INHERITS` in `tables.js`, generated from
  `data/source/rules`: AFLD.Ukraine from AFLD, SPY.England from SPY, E1R1
  from E1, ...) except for the keys those set themselves, as OpenRA
  resolves `Inherits` after merging a map's rules. Each kept field is
  checked by the engine alone; refused fields are dropped and reported.
- Lobby options in the `World` and `Player` rules become the map's
  `options` and `lockedOptions` (not rules: the map is not modded for
  them): `MapOptions` `TechLevel`, `GameSpeed` (`default` is `normal`),
  `ShortGameCheckboxEnabled`; `CrateSpawner`, `MapBuildRadius` (build
  radius, ally build radius), `MapStartingLocations` (separate team
  spawns), `SpawnStartingUnits` `StartingUnitsClass` (`none` is `mcv`),
  `TimeLimitManager` `TimeLimitDefault`, `PlayerResources` `DefaultCash`,
  `DeveloperMode` (the debug menu), `Shroud` (fog, explored map) and the
  `LobbyPrerequisiteCheckbox` options bounty, redeployable MCVs and
  reusable engineers, each with its `...Locked` field. A locked option the
  map does not set keeps OpenRA's default, as OpenRA's lobby does; a value
  the lobby has no choice for (a starting cash of 3000) is reported, and
  when the map locks it the option is left unset and unlocked (warned)
  rather than locked at OpenRA's default or snapped to the nearest choice.
- Everything else (removals, `Inherits`, templates, other traits and
  fields such as `AllowMultiple` or the `...Visible` lobby flags, other
  `World` and `Player` traits) is listed as unsupported and never applied.
  Lua scripts are never run. Custom sequences, voices, music,
  notifications and other files are ignored and reported.
- Import report (shown before the map is used): converted, rules applied,
  warnings, skipped, not supported, and the validation errors when the
  converted map is not playable yet (the editor still opens it for fixing).

### The map editor on big maps (`apps/game/editor`)

The editor's work per frame and per edit follows what changed, not the size
of the map (a 256 x 256 community map with hundreds of actors edits like a
small one). `tools/editor-bench.mjs` times it headlessly (the real document,
tools, view, engine preview, checks and tile planning; a stub renderer) on a
generated map or a given `.oramap`; `apps/game/tests/editor-perf.test.mjs`
guards it by counting reads, not by the clock.

- One document version (`MapDoc.version`): it moves on when a transaction
  that changed something closes, on rollback, undo, redo and load (a click
  that changes nothing keeps it). Every change happens inside a
  transaction, so outside one an equal version is the same document.
  `MapDoc.snapshot()` is the map object and its JSON text made once per
  version (frozen; `toMap()` for a copy to change), shared by the engine
  preview, the checks, the thumbnail and the draft.
- Undo steps hold the changed cells' before and after values and, for
  actors, spawns and properties, their before and after state; undo and redo
  write those back and rebuild nothing else of the document.
- Placement checks go against an index of who stands where (`edits.js`
  `Occupancy`: structure cells and other actors per cell index), built once
  per pass and kept in step as actors are placed: the quick fixes, the red
  ghosts of structures a game would refuse (found once per version), pasting,
  symmetric placing and dragging a selection check each actor's footprint,
  never every actor per actor. The results are those of `placementProblem`.
- The shape preview (line, rectangle, ellipse while dragging) is made when
  its corners, the brush, the fill or the symmetry change, as runs of cells
  along each row (the same pixels as a rect per cell), not every frame.
- After a burst of edits the editor runs, once and when the browser is idle
  (`js/idle.js`): the checks (engine `validate_map`, the editor's checks and
  quick fixes; 300 ms after the last change) and the draft save (800 ms).
  The problem list and the thumbnail are drawn only while their tab shows
  (else when it is opened); the fairness table waits for idle time too. Side
  panels (owner lists, selection, history, undo buttons) update once per
  frame however many changes it had (undoing several steps at once).
- The engine keeps the rules it loaded last with their overrides
  (`Rules::load_with`) and hands out a copy for the same overrides: the
  preview, validation and games on one map load the same rules repeatedly.
- Terrain tiles: WebRA's (`js/art/terrain.js` `cellTiles`) are made for the
  whole map on the main thread (a few milliseconds; the decals follow a seed
  of the whole map's terrain, as in a game). The original graphics' tiles are
  planned in a worker (`editor/js/tiles-worker.js`, section 8) whenever the
  terrain types change; meanwhile the editor draws the last plan, with the
  cells whose type changed since in the tile most cells of that type have in
  it, and WebRA's tiles until the first plan is in. The finished picture is
  the one a game on the map draws. Texture packs tile cell by cell on the
  main thread.

## 3. Game options (lobby to engine)

`options` JSON as produced by `apps/game/js/lobby.js` (value sets in
`apps/game/js/lobby-state.js`): `seed, mapSize, players[{slot, type:
human|ai|closed, name, faction, color, team, difficulty, bot?, handicap?, spawn?}],
startingCash, startingUnits, techLevel, gameSpeed, crates, shortGame, fog,
explored, buildRadius, allyBuildRadius, separateTeamSpawns, redeployableMcv,
reusableEngineers, bounty, oreRegrowth, timeLimit, cheats, mapStyle, biome,
weather, techBuildings, movement, factoryLoss, map`.
`mapStyle` (`random`, `land`, `rivers`, `lakes`, `islands`) and `biome`
(`random`, `temperate`, `snow`, `desert`) shape a generated map; `random`
is resolved by the engine from the seed, so every peer gets the same map and
sky. A map file brings its own biome and ignores both. `bot` (AI players
only) is the OpenRA bot the slot plays: `rush`, `normal`, `turtle` or
`naval` (see "Skirmish AI" in section 5); left out it is `normal`, so lobby
states, game modes, replays and online saves from before bot types keep
their meaning (protocol 6, no version bump). `weather` is `full`
(visuals and gameplay effects), `cosmetic` (visuals only: the simulation runs
as under clear skies, including the biome effects) or `off` (clear skies).
The protocol requires all three (protocol version 4); the engine treats
missing keys as `random`, `temperate` and `full` (older callers, tools) and
refuses unknown values. `techBuildings` (OpenRA's map generator option
"Buildings", `engine/src/mapgen/settlements.rs`) is `none`, `standard`
(default: an oil derrick in the back of every base area and a hospital in
the middle), `extra` (also forward command posts and communications centers
between neighbouring bases), `oilonly` (a derrick per base and one in the
middle) or `oilrush` (two per base, in the middle and between neighbours).
Everything is placed by the generator's symmetry (every image or none), so
every base gets the same buildings; generated maps also get villages of
civilian buildings of their biome, each building with a free ring around it
so no passage closes. A map file brings its own actors and ignores it; the
engine treats a missing key as `standard`. Game modes include it; a mode
saved before it existed takes `standard`.
`Game.generated_map_with(seed, size, players, style, biome, techBuildings)`
exports such a map file (`generated_map_styled` is the same with
`standard`). `cheats` is the "Debug menu"
option (OpenRA's `cheats`, default off): only then do the debug menu's cheat
orders work (section 5). `reusableEngineers` is OpenRA's "Reusable
Engineers" (default off): engineers capture from next to a structure after
375 ticks instead of going in after 200, and stay (`Captures@REUSABLE`).
Game modes saved before it existed get it off. `movement` is how units
move among each other ("Movement" in the lobbies, section 5 "Movement
models"): `openra` (the default: OpenRA's cell occupancy, waiting and
nudging) or `webra` (WebRA's soft crowd separation). It is part of the
game's state (`state_hash`). Live lobby options (the `options` message
and the lobby state) always carry it. Start options, saves and replays may
leave it out, and the engine then plays `webra`: those from before the
option were made with WebRA's model and replay with it; a lobby resuming
such a save shows `webra`. Game modes include it; a mode saved before it
existed takes `openra`. `factoryLoss` is what a production queue does
when its player loses the last structure of its type ("Factory loss" in
the lobbies, "Production queues" below): `openra` (the default,
OpenRA's ClassicProductionQueue: the queue is cleared and refunded) or
`webra` (unit queues wait for a new factory). It is part of the game's
state and follows `movement` in everything else: live lobby options carry
it, start options, saves and replays may leave it out and then play
`webra` (the rule of games from before the option; a lobby resuming such a
save shows `webra`), game modes saved before it take `openra`, and maps may
set and lock it. Both defaults are `openra` for the same reason: new games
play like OpenRA, old ones replay as they were made. `team` 0 means no team (free for all);
players with the same non-zero team are allies (shared vision, no
auto-targeting, win together). 2..8 players. Closed slots are listed as
`{slot, type: "closed"}` and do not play: engine player N is the N-th slot
that is not closed, and it takes spawn N (unless separate team spawns
moves it, below). `map` is the map file JSON string
(the client starts `Game.from_map(map, options)`) or null for a generated map
(`Game.from_options(options)`); it is not passed on to the engine options.
`spawn` (optional, 0 to 7) is the start position the player picked in the
lobby (OpenRA's lobby spawn selection; 0-based, where OpenRA counts from 1
and uses 0 for random); left out, the lobby's automatic choice applies
(below), as in games, replays and saves from before spawn picks (protocol
6, no version bump: an optional field, and sessions pair identical builds).
No two players may pick one spawn, and the map must have it (a generated
map has one per player): the protocol refuses doubles, the engine refuses
both (`gamerules.rs` `spawn_pick_problem`, `from_options`, `from_map`).

OpenRA's other lobby options (rules in `data/source/rules/world.yaml`,
`player.yaml`, `misc.yaml`; protocol version 6 requires the keys, the
engine treats a missing one as its OpenRA default; `techBuildings` above
joined protocol 6 the same way, without a version of its own):

- `crates` (default on, OpenRA CrateSpawner): crates appear on land and water
  or are dropped by a neutral Badger (`engine/src/crates.rs`), with OpenRA's
  minimum and maximum counts, spawn interval, lifetime and action weights;
  ground units and ships pick them up. A neutral player owns crates and the
  wrecks of defeated players.
- `shortGame` (default on, OpenRA MapOptions ShortGame): a player has lost
  when it has no structures and no MCV left (MustBeDestroyed); off, every
  unit counts too.
- `allyBuildRadius` (default on): structures may also be placed near allied
  structures.
- Start positions (OpenRA MapStartingLocations): a player who picked a
  spawn starts there. Everyone else shows their spawn on the preview: slot
  k (the k-th that plays) at spawn k when nobody picked it, else (in slot
  order, after those who keep theirs) the lowest free spawn.
- `separateTeamSpawns` (default on, OpenRA MapStartingLocations): in a team
  game the players without a team (and without a pick) take their spawn as
  above and team members without a pick take the spawns still free. On a generated map the teams take them team by team
  (in the order of each team's first slot, members in slot order) in the
  order the map lists its spawns, which is by column, top first, so the
  halves of the list are mirrored sides; on a map file the members, in slot
  order, take the free spawn farthest from the enemies placed so far (sum of
  squared distances; picked spawns count as placed), then nearest to team
  mates, then the lowest.
  `engine/src/gamerules.rs` `assign_spawns` and `packages/protocol`
  `assignSpawns` (lobby markers) share the cases of
  `packages/protocol/test/fixtures/spawn-cases.json`.
- `bounty` (default off, OpenRA GivesBounty): a kill pays the killer the
  victim's GivesBounty percentage (10 % by default) of its sell value
  (CustomSellValue, else the cost: a pillbox pays 40, not 60); allies pay
  nothing.
- `timeLimit` (minutes: 0 = none, 10, 20, 30, 40, 60, 90; OpenRA
  TimeLimitManager): the countdown counts game time in real seconds of the
  chosen speed, warns at OpenRA's notification marks and when it runs out
  the player or team with the most player experience wins, everyone else
  loses; a tie is a draw.
- `handicap` per player (0 to 95 in steps of 5, default 0, OpenRA
  HandicapFirepowerMultiplier and friends): firepower and armour drop and
  build time grows by the percentage. AI slots take 0. The engine refuses
  other values.

Starting units (`startingUnits`) come from `world.yaml` StartingUnits per
faction and class (`none`, `light`, `heavy`) through `tools/gen_rules.py`;
`base` keeps WebRA's construction yard start. Support units stand on a ring
around the MCV (inner and outer radius from the rules) with a random facing.

Game modes (`packages/protocol/src/presets.js`, `apps/game/js/modes.js`)
are named bundles of every lobby option except `seed` and `mapSize`:
Classic, Competitive, Weather war, Winter, Desert storm, Islands naval, Rush,
Turtle and Sandbox (skirmish only), plus the player's saved modes (settings
`lobby.presets`, docs/accounts-api.md section 5.8). Picking one sets those
options; changing any of them reads as Custom. They are a lobby
convenience only: online the host sends plain `options` (protocol
unchanged), and every peer works out the mode name from the options, so
guests see the built-in mode a setup matches (a host's saved mode reads as
Custom to them). The lobby help texts (`apps/game/js/help.js`) quote the
numbers of this section and are checked against the engine by
`apps/game/tests/help.test.mjs`.

Generated maps come in a style (`engine/src/mapgen/`): **land** (open
plains, or highlands with long cliffs broken by passes), **rivers** (river
valleys from a confluence pool to the map edges, fords every 11 to 15 cells,
pools and tributaries), **lakes** (a central lake and satellite lakes, most
of them joined to it by streams) and **islands** (a central sea with bays,
islands, some with ore, and straits to the map edges). Water radiates from a
hub on the mirror axis, placed where the farthest base is as near as
possible, along spokes that run between the bases, so no river crosses a
base. All water of a map is one network (apart from decorative ponds).

Generated 2-player maps are mirrored left to right with both bases at the
same height, so mirror matches are fair: Red Alert structures face south
(exits, refinery docks), which favours one side on a point symmetric map.
On the water styles each base has a harbour bay behind it, three cells off
the map edge, dug through to the network (its channel leaves along the
bay's columns and never along the map border, so land runs round behind
the bay). Generated maps for 3 to 8 players are
mirrored left to right too, and every base gets the same surroundings,
shifted and never rotated (a clearing with its ore fields south of the yard,
walls of three rows north and south, open sides): 3 and 4 players in two
rows (the bottom half repeats the top half; with four players the water is
also mirrored top to bottom), 5 to 8 on a ring. Rings of six and eight are
mirrored top to bottom as well: a base below the middle sits on row
`height - y` of its partner above, and the terrain, the water, the harbour
channels and the roads over water are mirrored with them, so two neighbours
below are never closer by ground than their mirror images above (on the
8-player lakes map of seed 1706698519 one pair used to be 25 steps apart and
every other pair 37). On the water styles the walls are harbour moats; the
moat with the cheapest channel to the hub (the one facing the hub on ties) is
dug through to it, nearly straight, and the other one becomes rock, so every
base has exactly one harbour on the network and every harbour is about as far
from the hub as its base is; a base below the middle gets the mirror image of
its partner's channel and moat, a base on the middle row its own channel
mirrored too. Channels never dig along the two cells of the map border.
Ground routes that would be cut by water get fords, except on a base's sea
route: per base the 3x3 naval yard site in its own bay or moat that ships
reach from the hub soonest and the shortest water route from there to the
hub, a cell wider either side and mirrored like the map
(`mapgen::sea_routes`), which roads never cross; a large land region only a
sea route could join is flooded instead. A finished map is checked
(`mapgen::validate`: every base joined by ground, no land region of 60 cells
or more cut off, and on the water styles every base with a naval yard site
ships reach from the hub over open water); one that fails is made again
from a seed derived from the map seed (up to 8 layouts, the style stays
the one of the map seed), which the generator tests keep under 1 % of
first layouts. Last, every
base of a 3 to 8 player map gets as many ore cells within 14 cells of its yard
(`mapgen::metrics::REACH`) as the richest one: ore grows next to existing
fields on open ground that only that base (and its mirror image) is near and
reaches by land, nearest to the yard first (`Map::equalise_ore`). Their spawns are
listed by column, top first, so slots 0 and 1 (the left column of a 4-player
map) against slots 2 and 3 is a mirror match. Gems lie only in contested
fields, as the dense middle of an ore field: on 2-player maps in the two
contested fields of each half (mirrored) and in the style's fields near the
mirror axis (river crossings, islands, passes), on 3 to 8 player maps in
every field halfway between two neighbouring bases and in the style's fields
near the axis. No base pocket holds gems, so every base has the same home ore
and gems are always something neighbours fight over.

Fairness checks (`engine/src/mapgen/tests.rs`, `engine/examples/map_stats.rs`):
every style and player count is mirrored, ground connected and has no
resources on water; two-player bases get identical numbers; on the water
styles every base has a naval yard site on the network, and for 3 to 8
players the water distance from the hub to each harbour stays within 1.5
times the nearest plus 8 cells. For 3 to 8 players the ore cells within
`REACH` differ by at most 5 % between bases, and on layouts mirrored top to
bottom a base and its mirror image are within 10 % (or 4 steps) as far from
their nearest neighbour by ground, for all but one mirrored pair in fifty
(pockets face south and are not mirrored, so a channel or road next to one
can still differ). `map_stats` prints these numbers per seed (`seeds` takes a
count or a comma separated list).

### Biomes and weather (`engine/src/weather.rs`)

The biome decides the terrain art and the weather. The weather cycle runs on
its own random stream seeded from the game seed (it never draws from the
simulation's stream): clear skies for the first 2 to 3 minutes, then the
biome's weather alternates with clear spells of 90 to 180 s. Temperate:
rain (60 %, 60 to 120 s) or thunderstorm (40 %, 45 to 90 s); snow:
snowfall (60 to 150 s); desert: heat wave (60 %, 60 to 120 s) or sandstorm
(40 %, 40 to 90 s). Lightning strikes every 4 to 12 s of a thunderstorm,
but never in its last 8 s (`STORM_CALM_SECONDS`): the client dies the rain
down over the spell's last 4 s (`RAMP_SECONDS`, js/weather-fx.js `RAMP`)
and thunder comes up to 2.8 s after its flash, so neither a flash nor its
thunder comes while the rain is stopping. A strike that comes due in that
window still makes its draws from both streams and is dropped, so the
weather cycle and every later strike are the same as without the calm.
Effects with `weather: full`:

| What | Effect |
|------|--------|
| Rain | sight of every actor 90 % |
| Thunderstorm | sight 85 %; lightning strikes (below) |
| Snowfall | sight 85 % |
| Sandstorm | sight 75 % |
| Snow biome, infantry | speed 90 % |
| Snow biome, vehicles | momentum: +10 % of top speed per tick, -12 % when braking or coasting; turn rate 70 %; they slide on along their heading while turning and for a short coast after stopping (harvesting, docking, repair, boarding and abilities stop dead) |
| Ice (rough ground in the snow biome) | +6 % / -7 % per tick, turn rate 50 % |
| Heat wave, vehicles | heat +1 per tick driving (40 s of driving), +25 per shot; overheated at 1000: speed 75 %, reload 133 %, until heat drops to 400 |
| Cooling | -5 per tick standing still without firing, -1 per tick otherwise outside a heat wave |

**Lightning and the Lightning Rod** (WebRA additions, no OpenRA counterpart;
`engine/src/lightning.rs`, `engine/src/ai_lightning.rs`). Each strike's random cell comes from the
weather's own stream as before; its roll 0..99 and pick come from a stream
of their own (seeded from the game seed), so the weather cycle and the
flashes are the same in every mode and as before strikes had effects. With
`full` the world resolves it:

1. Power plants attract lightning (tall structures): with a roll below 25
   the strike goes for a power plant (a structure with positive power: the
   Power Plant and the Advanced Power Plant), `pick` modulo the number of
   candidates among every player's plants that no rod protects, in actor
   order. Every plant is as likely as any other: humans', bots' of every
   type, allies' and enemies' alike, in skirmish, online games and missions
   (co-op included); nothing in the targeting looks at who controls a
   player or at the local player. Only the owner of the map's neutral world
   (OpenRA `OwnsWorld`) is left out. Without a candidate it falls on the
   random cell.
2. A strike point within a Lightning Rod's range (its centre to the point)
   is grounded on the nearest rod (lowest actor index on a tie): nothing is
   damaged, the rod included. Rods protect everyone's actors, whoever owns
   them, need no power and work during an outage.
3. Otherwise it hits what stands on the struck cell: structures whose hit
   cells cover it and ground units on it, players' actors only (aircraft in
   the air, mines, husks and the neutral world are never hit, nor an actor
   whose centre a rod protects).
4. Each struck actor loses half of its current hit points, rounded down
   (the normal damage path with its events, AI reactions and damage states,
   but without veterancy, prone or handicap modifiers and without an
   attacker: no "under attack" line, no kill credit). So lightning never
   destroys anything; the Iron Curtain blocks it.
5. A struck power plant (picked or on the struck cell) also blacks out its
   owner's power plants for 15 s (375 ticks; the spy's power outage, OpenRA
   PowerManager.TriggerPowerOutage: a longer running outage stays), with the
   low power effects that follow (defences, radar and the gap generator go
   dark, production slows down, the Low power line) and the owner's line
   "Power plant struck by lightning. Power outage." Power plants make power
   in proportion to their health (OpenRA ScalePowerWithHealth), so after
   the outage a struck plant makes half of what it made before until it is
   repaired.

The flash (`weather_json().flash`, `[tick, x, y, kind]`) moves onto what the
strike hit; every flash is a strike (cosmetic weather included), there are
no other flashes, so the calm above holds for the bolt, the sky flash and
the thunder alike; kind 0 ground (or `cosmetic` weather), 1 grounded on a rod, 2 a
unit or structure, 3 a power plant. `Game.build_lines` draws the bolt for 8
ticks where the viewer has explored the ground (jitter from the flash
itself, never the simulation's random streams); thunder follows it
(js/weather-fx.js, js/audio). Hit points and outages are simulation state;
the flash, the bolt and the `LightningStrike` audio events are presentation.

The Lightning Rod `LROD` (`data/webra/rules.yaml`, WebRA trait
`LightningRod: Range 6c0`, read by `tools/gen_rules.py` into
`building.lightning_rod`): Defense tab, both sides, prerequisite `anypower`
(a power plant), tech level low, cost 300, build time 180 ticks, 300 HP,
Heavy armour, 1x1 with a minibib, no power, sight 4 cells; inherits OpenRA
`^Building` (sell, repair, engineer capture, make animation). It is
buildable in every skirmish and multiplayer game, also where no
thunderstorm can come (desert, snow, weather off): it is cheap and the
tooltip and badge say what it does. Campaign and co-op missions keep
OpenRA's rules: its prerequisite `~global-skirmish` is a WebRA token the
engine grants every player outside missions (production.rs
`GLOBAL_SKIRMISH`; `World::in_game_mode` keeps it out of a mission's
sidebar and observer lists altogether), and tools/gen_missions.py leaves
WebRA's actors out of the mission rules. A dashed yellow
`WithRangeCircle` (Type LightningRod, 6 cells) shows when selected and
around other rods while placing one. Art: WebRA's own pixel art
(`tools/gen_pixel_art.py`: idle, damaged, a 12 frame make animation and a
cameo). The skirmish AI builds rods only while thunderstorms can strike
(temperate biome, `weather: full`) and after the game's first lightning
strike, once it owns two power plants and has three times the rod's cost,
one rod per three plants and at most three, and only
while one of its plants is unprotected; it places each where it covers the
most of its unprotected plants. Through a blackout from lightning the bot
counts the power its intact plants will make again
(`ai_lightning::power_gen`). It buys no extra power plants. It switches no
structures off (power down module). It sells no plants it would otherwise
keep. A spy's or a mission's outage counts as low power, as for OpenRA's
bots (PowerManager.ExcessPower drops while AffectedByPowerOutage disables
the plants' Power trait).

The AI rests overheated vehicles until they cool down (they still defend).
Long games can harvest every field a base reaches, so the AI also handles
running dry (`engine/src/ai_economy.rs`): waiting ore trucks drive to any
ore they can reach (their own side of the map first, unexplored fields too);
with no income left (no reachable ore, no refinery or no truck) it cancels
queued structures, aircraft and ships, puts every credit into the army and,
while it is broke with fewer than four army units, sells one structure every
8 s that it can do without (refineries without ore, aircraft and naval yards
without aircraft or ships, tech and support structures, spare power), never
its Construction Yard, its first barracks and war factory or its defences.
Warships are only bought for water from which they can hit an enemy structure
or ship (see the naval bullet under the Skirmish AI's differences).
Waves that do not fill up go after 90 s without growth or 120 s without a
wave (after the eighth minute) and set the next wave to their size; an enemy
without structures is hunted by the whole army; ground waves never aim at
ships. Generated maps join every land region of 60 cells or more to the bases
by fords (or flood it, see above), and the land the bases reach holds at least 4.5 % (two players) or
6 % ore and gems, a third more on the water styles.
Submarines alone do not keep a player in the game (OpenRA `^Submarine`
has no `MustBeDestroyed`), nor do walls and mines.

Engine API: `Game.weather_json()` returns `{ biome, mode, weather, since,
until, tick, sightPct, flash }` (`flash`: the latest lightning `[tick, x, y,
kind]` in world pixels, or null); `Game.build_heat_fx(player, x0, y0, x1, y1)`
fills `[x, y, heat 0..1, overheated]` per hot vehicle in view (at most 512,
read at `Game.fx_ptr()`); `Game.actor_json` has `heat` (percent) and
`overheated`.

## 4. Online multiplayer

Deterministic lockstep: every client runs the same simulation; only orders
travel over the network. The server never runs the simulation.

### HTTP API (Worker)

| Method | Path | Body / result |
|--------|------|---------------|
| `GET` | `/api/version` | `{ version, protocol }` |
| `GET` | `/api/sessions` | `[{ id, name, host, players, maxPlayers, locked, map: { id, name, hash, modded } \| { name, modded, shared: true } \| { mission, name, modded }, version, state: lobby \| game, summary }]` (public sessions only, lobbies first: open and full lobbies and running games (protocol 8); a map shared with the session shows only its name; `summary` see "Session directory"; cached per isolate for 5 s) |
| `GET` | `/api/online` | `{ players, lobbies, games }` (protocol 8, see "Session directory"; cached per isolate for 30 s) |
| `POST` | `/api/sessions/:id/invite` | host only, `X-WebRA-Member`: -> `{ code, expiresAt, path }`, a new invite code for the lobby (the previous one stops working; see "Invite codes") |
| `GET` | `/api/invite/:code` | the lobby an invite code names: `{ invite: { code, session, name, host, map, players, maxPlayers, spectators, maxSpectators, mode, locked, public, version, expiresAt } }`; 404 unknown, 410 expired (see "Invite codes") |
| `GET` | `/join/:code` | an invite link: 302 to `/play/?invite=<code>` (a malformed code: the 404 page) |
| `POST` | `/api/sessions` | `{ name, password?, public, maxPlayers, version }` -> `{ id, hostKey }` |
| `GET` | `/api/sessions/:id/ws` | WebSocket upgrade into the session's Durable Object |
| `POST` | `/api/sessions/:id/map` | host only, `X-WebRA-Member`: map JSON -> `{ id, hash, upgradedFrom? }`; shares a map file with this session only (see "Lobby maps") |
| `GET` | `/api/sessions/:id/map?hash=` | members only, `X-WebRA-Member`: the lobby's (or running game's) map JSON with that hash (see "Lobby maps") |
| `POST` | `/api/sessions/:id/resume` | host only, `X-WebRA-Member`: an online save file -> `{ id }`; the lobby resumes that saved game (see "Online saves") |
| `GET` | `/api/maps` | `[{ id, name, author, players, width, height, hash, modded, downloads, createdAt, tags, thumbnail }]` (published maps of the current format version only, section 2 "Map versions"; `thumbnail` the URL of the map's thumbnail) |
| `GET` | `/api/maps/:id/thumbnail.png` | the published map's thumbnail: a PNG, one pixel per cell, drawn from the map data (section 2 "Map setup"), cached publicly (the list's URL names the map's hash). Drawn once per map version: kept in the edge cache by id and stored hash (the query is ignored); `ETag` is the hash (`If-None-Match` gets 304); drawing counts against 600 per hour per IP (429 with `Retry-After`; cached and 304 answers do not count); a map that cannot be drawn is logged and answered 404 |
| `GET` | `/api/maps/:id` | the map JSON (published maps only; upgraded to the current format version, or as stored when it cannot be) |
| `POST` | `/api/maps` | map JSON -> `{ id, hash, upgradedFrom? }` (upgraded, validated, size limited, rate limited); publishes it to the community list. `upgradedFrom`: the file's older format version (what is stored is the upgraded map). A map that is not compatible or from a newer format: 422 with the message of section 2 |
| `GET` | `/api/content/ra-quickinstall` | OpenRA's `ra-quickinstall.zip` (EA's freeware Red Alert files) streamed from OpenRA's mirrors, see below |
| `GET` | `/api/content/ra-scores` | A byte range of `scores.mix` (the Red Alert music) read from the freeware Red Alert CD images on the Internet Archive, see below |
| `GET` | `/api/content/ra-movies/allied`, `/api/content/ra-movies/soviet` | A byte range of `movies1.mix` or `movies2.mix` (the mission movies) from the same CD images, see below |
| any | `/api/site`, `/api/auth/*`, `/api/account/*`, `/api/admin/*` | Accounts, sign-in, self service and the admin API: [accounts API](accounts-api.md) |
| `GET`, `POST` | `/api/account/replays` | The signed-in account's replays (list) and uploading one (the replay file, section 7): [accounts API](accounts-api.md) 5.10 |
| `GET`, `DELETE` | `/api/account/replays/:id` | One replay of the signed-in account: the file, or deleting it (5.10) |
| any | `/api/account/friends/*`, `/api/account/presence` | Friends, requests, blocks, friend invites and the presence heartbeat (protocol 8): [accounts API](accounts-api.md) 5.11 |

Every request that is not `GET` or `HEAD` needs `Origin` equal to the site,
`Sec-Fetch-Site` same-origin or absent, and the header `X-WebRA-CSRF: 1`
(accounts API, section 1.1). With the site setting `onlineRequiresAccount`
(on by default), `POST /api/sessions`, `POST /api/maps` and joining over the
WebSocket need a signed-in, active, unbanned account (accounts API, section
7.2); the session cookie travels with the WebSocket upgrade. With
`gameRequiresAccount` (on by default) the game files themselves need one too
(section 6 and accounts API, section 7.1); `UserSelf.canPlay` and
`GET /api/site` `gameRequiresAccount` tell clients in advance.

`/api/content/ra-quickinstall` (`apps/server/src/content.js`): the game's
one-click install of the original content. It needs a signed-in, active
account with the `content_autoinstall` flag (or an admin) and the
`contentRelay` site setting (401, 403 `account_inactive` or
`relay_forbidden` otherwise). The request must carry
`X-WebRA-Content: 1`, come from the game page (`Origin` absent or ours,
`Sec-Fetch-Site` absent or `same-origin`) and stay within the budgets: 8
completed downloads and 24 requests per account per UTC day, 20 completed
downloads and 30 requests per network (an IPv4 address or an IPv6 /64) per hour (D1 quota
table, account and network as salted hashes; a download that does not
complete is given back; 429 with `Retry-After` and `retryAfter` and `scope`
in the body, docs/accounts-api.md 7.3).
The Worker tries the mirrors in order (`openra.baxxster.no`,
`republic.community`, `openra.0x47.net`, `openra.ppmsite.com`) with
`cache: 'no-store'` (Cloudflare's cache bypassed), takes the first answer
whose `Content-Length` is exactly 13,502,031 bytes and passes its body
through as a stream, cut off if it runs longer (15 s for a mirror to
answer, 240 s for the transfer). Response: `200`, `Content-Type:
application/zip`, `Content-Length`, `Cache-Control: no-store`,
`Cross-Origin-Resource-Policy: same-origin`; 502 when no mirror fits.
Nothing is stored anywhere on the server.

`/api/content/ra-scores` (`apps/server/src/cdmusic.js`): the game's
one-click music install. The same account gate and `X-WebRA-Content` and
same-origin checks as above. The request carries `Range: bytes=a-b` (or
`bytes=a-`): one range inside `scores.mix` (64,171,360 bytes), at most
8 MiB (8,388,608 bytes); otherwise `416 bad_range` with `Content-Range:
bytes */64171360`. Budgets: 256 MiB per account per UTC day (each request
counts its length rounded up to whole MiB; a piece that does not arrive
whole is given back) and 64 requests per network per hour (429 with
`Retry-After`, `retryAfter` and `scope`). The Worker reads the matching window of the
pinned Allied disc image, then the Soviet one (`scores.mix` is the same on
both), from the Internet Archive with `Range`, `redirect: 'manual'` (one
redirect to an archive data node with the same item and path) and `cache:
'no-store'`; it takes only a `206` whose `Content-Range` is exactly that
window of the pinned image size. Response: `206`, `Content-Type:
application/octet-stream`, `Content-Length`, `Content-Range: bytes
a-b/64171360`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy:
same-origin`; 502 when neither disc answers (two rounds). The game
(`apps/game/js/content/cdmusic.js`) asks for 8 MiB pieces, keeps finished
pieces in IndexedDB (`partials` in the content database) to resume, checks
the whole file's SHA-256 (`313ef2e4...0846`, pinned on both sides) and
then installs it like a picked `scores.mix`.

`/api/content/ra-movies/allied` and `/api/content/ra-movies/soviet`
(`moviesRange` in `apps/server/src/cdmusic.js`): the optional one-click
install of the mission movies, the same relay for `movies1.mix`
(369,362,336 bytes, Allied disc) and `movies2.mix` (415,334,456 bytes,
Soviet disc). Same gate, Range rules (416 with `Content-Range: bytes
*/<size>`), answer and refunds; budgets 1,500 MiB and 288 requests per
account per UTC day and 192 requests per network per hour. The game
(`apps/game/js/content/cdmovies.js`) checks each 8 MiB piece against its
pinned SHA-256 before keeping it, installs the movies from the kept pieces
and forgets them.

### WebSocket messages (JSON, `{ "t": type, ... }`)

Client to server:

| t | Fields | When |
|---|--------|------|
| `hello` | `protocol, version, name?, password?, hostKey?, spectate?, rejoin?: { client, key }` (`name` required without an account; ignored for signed-in connections, which play under their username) | first message |
| `slot` | `slot, faction?, color?, team?, type?(host only: ai/closed/open), difficulty?, bot?, handicap?, spawn?` (difficulty and bot: AI slots, host only; `spawn`: 0 to 7 or null, see "Start positions"; another player's team, handicap and spawn: host only, as OpenRA's lobby offers; another player's faction and colour: never) | lobby |
| `slots` | `changes: [{ slot, ...the fields of slot }]` (host only; 1 to 8 changes, each slot once, each changing something; see "Bulk edit") | lobby |
| `spectators` | `max` (0..8, host only, not below the spectators present) | lobby |
| `spectate` | `on: bool` (move between a player slot and the spectators) | lobby |
| `resume` | | rejoining player, after catching up |
| `synced` | | spectator joining a running game, after catching up |
| `options` | `options` (host only) | lobby |
| `map` | `{ id, hash, name, modded }` (host only; a published map, or `null` for a generated one; a map shared with the session goes through `POST /api/sessions/:id/map`) | lobby |
| `mapstate` | `hash, state: installed \| declined` (for the lobby map with that hash) | lobby |
| `mission` | `{ id, hash, options }` or `null` (host only; a co-op mission of `COOP_MISSIONS` with its file's hash, or back to a skirmish; section 9, "Co-op online") | lobby |
| `kick` | `client` (host only: remove a spectator; players are removed through `slot`) | lobby |
| `ready` | `ready: bool, mapHash` | lobby (must have the map installed; ready with the hash counts as installed) |
| `rematch` | `accept: bool` (host: propose, then withdraw with `false`; players: accept or decline) | in game |
| `save` | `accept: bool` (any player: propose, accept, decline; the proposer withdraws with `false`) | in game |
| `chat` | `text` (<= 200 chars), `team?: true` (team chat) | any time |
| `defeated` | | in game, a player whose engine defeated it (once per connection) |
| `start` | (host only, everyone ready) | lobby |
| `loaded` | | in game, once: this player's loading screen has closed (the start gate, see "Start gate"); spectators, rejoining players and resumed saves may send it, it is ignored |
| `orders` | `tick, orders: [...]` | in game, every tick (may be empty) |
| `hash` | `tick, hash` | in game, every 25 ticks |
| `ping` | `n` (0..2^31-1), `at` (the sender's clock, whole milliseconds), and `rtt, jitter, late` together once the sender has a measurement (rtt and jitter 0..60000 ms, late 0..100 percent) | lobby and game, every 2 s (see "Network quality") |
| `stalls` | | any time after hello: the game's stall log (see "Network quality") |
| `leave` | | any time |

Server to client: `welcome {you, name, hostId, session, role, key?}`, `lobby {slots,
options, map, hostId, spectators: [{client, name, account?, mapState?}], maxSpectators}`
(human slots and spectators carry `account: true` when the name comes from a
signed-in account, and `mapState` while the lobby has a map; `map` is null or
`{ id, hash, name, modded, players, author, width, height, bytes, shared }`,
looked up by the server, also in `start`; `resume?` while the lobby resumes
a save: `{ id, title, createdAt, ticks, waiting: [names] }`; `mission?` while
the lobby plays a co-op mission: `{ id, hash, options }`, also in `start`), `rematch {state, by, accepted,
waiting, msLeft?, reason?}` (see "Rematch"), `save {state, ...}` and
`start.resume?: { ticks, hash }` (see "Online saves"), `chat
{from, text, team?, spectators?}` (with `team: true` the line went to the
sender's team only: the players of its non-zero team, the sender alone
without a team, the spectators among themselves; OpenRA's team chat. A player
that reported `defeated` is on the spectators' side from then on, also after
a rejoin: its team chat goes to the spectators and the other defeated
players, and it gets theirs, no longer its old team's, like OpenRA sending a
player with a win state's team chat as ExtraData uint.MaxValue; such lines
carry `spectators: true`), `start {seed, options, map, players, delay}`, `frame {tick,
orders: [[player, [...]], ...]}`, `desync {tick}`, `left {player, client, name,
reason}` (`player` null for spectators and lobby members; reasons `left`,
`dropped`, `kicked`, `disconnected`, `removed`, `expired`), `log {frames:
[[tick, orders], ...]}`, `sync {tick, check: {tick, hash} | null}`, `back
{player, client, name, tick}`, `pong {n, at}`, `netstat {players: [{client,
rtt, jitter, late, silent?}]}`, `waiting {client, heldMs, dropInMs}` or
`waiting {client: null}`, `stalls {stalls: [{tick, client, ms}], totals:
[{client, ms, count}]}` (see "Network quality"), `lobby.invite? {code,
expiresAt}` (see "Invite codes"), `error {code, message}`. Protocol version 8
(`PROTOCOL_VERSION`); `/api/version` reports it and older clients are refused
at `hello` with "Protocol 8 required. Reload the page.", which the client
shows in its error banner. Version 8 added the start gate (`loaded`: no
frame past the start frames until every player's loading screen closed),
network quality (`ping`, `pong`, `netstat`, `waiting`, `stalls`) and invite
codes (`lobby.invite`); the session list also shows full lobbies and running
games with a summary, and the Worker answers `/api/online`. A version 7
client would refuse a lobby with an invite code and could not start a game
(it never sends `loaded`). Version 7 made live
lobby messages stricter: lobby options must carry `factoryLoss` (section
3), and the host may change several slots at once (`slots`) and edit
other players' team, handicap and spawn; frames may carry the bulk orders
`repair_buildings`, `repair_units` and `sell_buildings`, which a version 6 client would refuse
to parse. Version 6 added lobby maps (the map details, `mapState`,
`mapstate`, `kick`), the rematch (`rematch` both ways, rejoining the lobby),
online saves (`save` both ways, `start.resume`, `lobby.resume`, online save
files) and OpenRA's other lobby options (section 3: the option keys and the
slots' optional `handicap`, kept by rematches and in saved games). Version 5
added accounts: the optional hello `name`, the welcome `name`, the `account`
marks, one place per account and session, rejoin keys bound to their
account, and the error codes `account_required`, `account_inactive`, `banned`
and `ip_banned` (sent in answer to `hello`, or when a ban drops a connected
member with left reason `removed`).

Rules: the server stamps the sender's player index on every order (clients
cannot send orders for others), validates every message against
`packages/protocol`, limits message size (8 KiB) and rate, compares hashes and
reports desyncs, and drops a player who, while fewer than 25 frames (one
second of game time) went out, held the game up for more than 10 s in total,
or whose stall debt (the same time, draining by 1 s every 20 s) passes 10 s.
Time within 1 s of the frame a client needed going out does not count; the
client runs waiting frames at once as soon as more than `delay` are queued.
Passwords are stored as salted PBKDF2 hashes in the Durable Object. Order
delay: 3 ticks. A signed-in player that a member present in the session
blocked (accounts API 5.11) is refused at `hello` with `forbidden` "You
cannot join this session." (who blocked it is not said).

### Start gate

The game, and every AI in it, starts only once every player's loading screen
has closed. After `start` the server sends the empty start frames 0 to
`delay - 1` at once (the clients need them to begin) but no frame after them
until every seat that holds a person sent `loaded` (`apps/server/src/lockstep.js`
`loading`). Clients stay at tick 0 until their loading screen closes, then
send `loaded` once. Orders a fast client sends meanwhile (for ticks up to
`delay` past the start frames) wait in the relay.

- The wait at the start counts toward nothing: no stall time, no stall debt
  (HOLD_GRACE_MS, DROP_AFTER_MS), no `waiting` message and no stall log
  entry. When the last seat loaded, every stall clock starts from that
  moment, as if the start frames went out then.
- A seat that has not sent `loaded` LOAD_TIMEOUT_MS (60 s) after the start
  is dropped by the session alarm like a stalling player (`error dropped`
  "You did not finish loading in time. You can rejoin.", `left` with reason
  `dropped`): its seat waits RECONNECT_GRACE_MS for a rejoin, and the other
  players begin at once.
- Rejoining players and resumed online saves have no start gate: their
  `resume` says they caught up. `loaded` from them, from spectators, or a
  second one is ignored; in the lobby it is refused (`bad_state`).

### Network quality

Measured with a ping through the game server, in the lobby and in the game
(`packages/protocol/src/netquality.js`, `apps/game/js/netquality.js`). A
client sends `ping { n, at }` every PING_INTERVAL_MS (2 s), `at` from its
own clock; the server answers at once with `pong { n, at }`, so the round
trip needs no clock synchronization. A pong slower than LATE_PING_MS (1 s),
or one that never comes, is a late ping: WebSocket runs over TCP, so nothing
is lost visibly, and late pings are what a player feels as stutter (the
UI calls them loss). Each ping carries the sender's last measurement:
`rtt`, the median of its last NET_SAMPLES (10) round trips; `jitter`, the
mean difference between consecutive round trips among them; `late`, the
share of late pings among its last NET_LATE_WINDOW (100) in percent, one
decimal.

The server keeps each connection's last measurement (in its socket
attachment, so hibernation keeps it) and sends `netstat` to everyone in the
room at most every NETSTAT_INTERVAL_MS (2 s), triggered by an incoming ping
(no alarm wakes the lobby for it). `netstat.players` lists every connected
player (a lobby slot or a seat of the running game); spectators get the
message but are not listed. `rtt`, `jitter` and `late` are null until the
player reported a measurement; `silent` (milliseconds) is present when the
server has not heard a ping from it for more than NET_SILENT_MS (5 s).

Quality (`netQuality`, the same in lobby, game and statistics): poor above
NET_POOR_RTT_MS (150 ms) or with more than NET_POOR_LATE_PCT (2) percent
late; good below NET_GOOD_RTT_MS (80 ms) with jitter up to
NET_GOOD_JITTER_MS (20 ms) and no late pings; fair otherwise. Signal bars:
4 good, 3 fair, 1 poor.

Pings have their own budget per connection besides the message rate limit
(60 per second): 2 per second, bursts of 6 ("Test again" sends three).
Pings beyond it get no pong (an honest client never sends that many) and a
flood of refused pings closes the connection. They count against nothing
else (the one-click content relay budgets of `relayquota.js` are
unrelated). Cost: pings keep the session object awake while members are
connected; in the game it is awake anyway (the alarm runs every second), in
the lobby it now is too (one small message per member every 2 s).

`waiting`: while the game waits for a player beyond HOLD_GRACE_MS (1 s
after it could have sent the frame and the frame before went out), the
session alarm (every second) sends `waiting { client, heldMs, dropInMs }`
to everyone: whom, for how long so far, and how long until the drop rule
removes it (from its drop window and stall debt). When several players hold
the game, the one waited for longest. Once the game runs again (that player
delivered, or was dropped or left), `waiting { client: null }` goes out at
once. Never during the start gate.

`stalls`: every wait beyond HOLD_GRACE_MS of a running game (also one that
ended with the player dropped or leaving) is logged as `{ tick, client, ms }`:
the frame that waited, the player, and how long it waited from when the
player could have sent it and the frame before it went out (a player
catching up after one long stall does not log the frames behind it). The
server keeps the newest STALL_LOG_MAX (500) and per player `totals` of all
of them (`{ client, ms, count }`). A member asks with `stalls` (at most every
5 s per connection, bursts of 2; more get `rate_limited`); the answer is
`stalls { stalls, totals }`, empty in the lobby (a finished game's log goes
with its relay at a rematch). The order log does not change.

The per-player series of the statistics (one point per 10 s, at most 150
points) are recorded by each client from `netstat`, not by the server.

### Invite codes

A short name for a lobby (`packages/protocol/src/invite.js`,
`apps/server/src/invites.js`): six characters from INVITE_ALPHABET
(`23456789ABCDEFGHJKMNPQRSTUVWXYZ`: no 0/O or 1/I/L, 31 characters,
887,503,681 codes), shown as `K7Q-2MX`. Input is folded to upper case and
may carry the dash, spaces, or be a whole link (`/join/<code>` or
`?invite=<code>`).

- `POST /api/sessions/:id/invite` (host only, its `X-WebRA-Member`
  credential, 30 issued codes per network per hour; refused requests do not
  count): a new random code (the D1 primary
  key is the collision check; another code is drawn on a clash), valid while
  the lobby is open and at most INVITE_TTL_MS (2 hours). The previous code
  stops working in the same step. Every member sees the current code in
  `lobby.invite { code, expiresAt }` (without the dash); members share it.
- The code ends when the game starts, when the session closes, or when it is
  replaced. A code that ended answers 410 for a day, then 404 (rows are
  deleted by the daily job). A rematch back to the lobby needs a new code.
- `GET /api/invite/:code`: `{ invite }` for a code whose lobby is open; 404
  unknown, 410 expired. Lookups are limited per address (20 per minute,
  without D1 when the rate limit binding exists) and failed ones (404 and
  410) to 30 per network per hour, then 429 for every lookup until the hour
  ends. A signed-in player that a present member of the lobby blocked gets
  404 (not counted as a failed lookup).
- The code is only a name: a password lobby still asks for its password
  (`invite.locked`), a full lobby can still be watched while there are
  spectator places, and the long link with the session id keeps working.
- `/join/:code` (the Worker, `run_worker_first`) redirects to
  `/play/?invite=<code>`; the game reads the parameter
  (`apps/game/js/invites.js` `inviteFromLocation`), looks the code up and
  joins.

### Session directory

Every session object keeps a D1 row (`apps/server/src/directory.js`):
written when something listed changes and every 60 s; a change of the
summary alone is written at most every 10 s. Private sessions have rows too
(`public = 0`): they are never listed, but invite codes and the friends list
find them. `summary` (null for rows of older versions): `{ players: [{ name,
team, color, ai? }], spectators, maxSpectators, mode, options: { startingCash,
fog, techLevel, gameSpeed, crates, timeLimit }, startedAt? }`; `mode` is the
id of the built-in game mode (section 3, protocol `BUILTIN_MODES`) whose
options the lobby has exactly, `custom` otherwise, null for a co-op mission;
`startedAt` while the game runs. Only what a public lobby shows anyone
anyway.

`GET /api/online`: `players` counts signed-in players with a presence
heartbeat in the last PRESENCE_ONLINE_MS (accounts API 5.11, whatever their
`social.showOnline`: it is only a count) or in a session, plus anonymous
members of sessions; `lobbies` and `games` count sessions (public or not)
in each phase.

### Online screens and friends in the game (`apps/game/js/online.js`, `online-view.js`, `online-dialog.js`, `friends-ui.js`)

What the screens show is worked out in `online-view.js` (no DOM, tested
with fixtures in `tests/onlineui.test.mjs` and `tests/friends-ui.test.mjs`).

- **Server browser**: the online counter (`/api/online`) and this
  browser's round trip to the Worker (`/api/version`, one per refresh) in the
  header; search (name, host, map), the filter All, Open, Friends (sessions a
  friend is in, from the friends list; signed-in players only) and In
  progress, and Hide full (full lobbies; running games are their own
  filter), all client side. The list is a grid (Up, Down, Home, End choose a
  row, Enter joins it or watches a running or full one); the chosen session's
  detail panel shows the players from `summary` with their team colour, the
  open places, option chips and Join or Spectate. Rows of another game
  version cannot be joined.
- **Join with a code**: six cells over one text field (the dash by itself,
  0/O and 1/I/L dropped), a pasted `/join/<code>` or `?invite=` link, or an
  older long `?join=<session id>` link. A complete code is looked up
  (`invites.js lookupInvite`) and shows the lobby, or Unknown, Expired, Full
  (then "Join as spectator") or another version. A code never skips a
  password. The page opened with `?invite=` opens it with the code.
- **Host game**: name, Public or Private, a password switch, Players and
  Spectator places steppers and the map (generated, the host's maps,
  community maps, co-op missions). The spectator places and the map are the
  first lobby messages after `welcome`; a private lobby gets an invite code
  at once.
- **Online lobby**: PUBLIC or PRIVATE and PASSWORD (`welcome.session.locked`)
  under the name; the player's own connection top right; the Connection
  column (four bars, the round trip and "jitter, loss" from `netstat`; AI and
  empty slots none); a warning bar when someone is poor (the worst named,
  Test again for everyone, Kick for the host, never for itself); Start game
  asks "Start anyway?" when someone is poor and never refuses; "I'm ready" is
  a switch and the status line names who is not ready. Invite players shows
  the code (`lobby.invite`), Copy code, Copy link, the time left, New code
  (host), the long session link and friends to invite. The NetQuality object
  of the lobby goes on into the game, started with `beginGame()`, as
  `onStartGame({ net })` (`online.js gameNet`, null outside online games):
  `{ quality, source, roster, you, players() }` with `quality` and `source`
  the same NetQuality (the HUD's js/netwarn.js reads `quality`, the game
  menu's js/netmenu.js `source`), `roster` the people of the start message
  `[{ client, player, name }]` (AI left out), `you` this member's client id
  (also for spectators, who are not in the roster) and `players()` the roster
  as `[{ client, name, color }]` with each player's colour as CSS (null when
  unknown). main.js hands it to the game as `online.net`.
- The online screens and the friends screen share one friends store per page
  (`friends-ui.js sharedFriendsStore`); it polls while either shows
  (`useFriendsStore`). The friends screen closes when a game starts and then
  leaves the lobby hidden behind the game. Confirmations focus Cancel.
- **Friends screen** (`#friends-root`, signed-in players; the main menu's
  Friends entry and a Friends button on the online screens): the list by
  status (in a game, online with lobby and away, offline) with Join
  (`joinable`), Spectate (`spectatable`) and Invite (only while this player
  is in a lobby; Sent once invited), More with Remove friend and Block (each
  asked first), Add a friend, invites from friends with Join and Dismiss,
  requests (Accept, Ignore, Withdraw), the privacy switches (`social.*`
  settings) and the blocked players with Unblock. It polls the list while it
  shows; the presence heartbeat runs while a player is signed in.
- Every select of these screens is a select plate; the bulk edit bar and the
  game mode picker keep their own (`lobby-bulkbar.js`, `modepicker.js`).

### Start positions

OpenRA's lobby spawn selection (`LobbyUtils.SelectSpawnPoint`, the `spawn`
and `clear_spawn` commands, `SpawnSelectorTooltipLogic`), in the skirmish
and online lobbies (`apps/game/js/spawnpick.js`):

- The map preview shows every spawn as a marker named A, B, C... (OpenRA's
  letters), filled in the colour of the player who starts there: a solid
  ring for a picked spawn, a dashed one where the automatic choice
  (section 3) puts a player, hollow for an empty spawn. Each slot row has a
  start list (OpenRA's spawn dropdown): "Automatic (B)" (where it starts
  now) and the spawns no other slot picked.
- Left click on a free spawn (one nobody picked; one the automatic choice
  gave someone counts as free, that player moves on): the first of your
  slots without a pick goes there; yours are your own slot and, for the
  host, the AI slots, you first. When all have one, you move there (OpenRA).
  Left click on a spawn one of yours picked frees it (automatic again; a
  WebRA addition, OpenRA ignores it). A spawn another slot picked is taken.
- Right click (or Delete / Backspace on a focused marker) frees a picked
  spawn: your own; the host frees anyone's, which makes that player not
  ready (OpenRA `clear_spawn`). OpenRA also frees with a click beside every
  spawn; WebRA does not, because the preview carries the map lens. OpenRA's
  host disables empty spawns with a right click; WebRA has no disabled spawns.
- Hover or focus shows the shared tooltip (who starts there, team, picked
  or automatic, and what a click does); the markers are buttons (Tab, Enter
  or Space), and the lens rings the one under the pointer or focus. The
  lens shows only while Ctrl (on macOS Cmd or Ctrl) is held, so a plain
  preview never covers a marker; on macOS Ctrl + click is the system's
  right click, which frees a spawn, so Cmd is the key to click with while
  magnifying (the hint names Cmd first there).
- How many spawns a battlefield has is one definition for both lobbies
  and the server (`packages/protocol` `battlefieldSpawns`): a map file's
  own, none in a co-op mission, else one per player of the generated map,
  which is made for `generatedMapPlayers(n)` = at least 2 players (so a
  host alone already sees, and picks on, the two player map).
- Picks belong to one battlefield: the map file (by hash), or the generated
  map of a seed, size, style and `generatedMapPlayers` count. When it
  changes the picks are cleared (OpenRA clears them on a map change): on a
  generated map another player count is another map, generated anew with
  its spawns elsewhere, so a pick there would name a different place.
  The first guest joining a lone host keeps the host's pick (still the two
  player map); a third player, or an AI added or closed beyond two,
  clears all picks.
- A map file's pre-placed actors belong to the player of their slot
  (actor owner k is the k-th slot that plays), wherever that player
  starts, as in OpenRA: its actors name a map player (`Owner: Multi0`),
  the player in that slot becomes that map player (`Player.InternalName =
  PlayerReference.Name`, `CreateMapPlayers`) and `SpawnMapActors` gives
  them to it, while the start position comes separately from
  `MapStartingLocations` (`HomeLocation`).
  No picks in a co-op mission (the mission places everyone); a resumed
  save keeps the saved ones.
- Online: the client sends `slot { slot, spawn }` (null: automatic). The
  server (`apps/server/src/room.js`) checks it: your own slot (a change of
  your own makes you not ready), the host for AI slots and other people's
  team, handicap and spawn (everyone not ready, like other host changes),
  and `spawn: null` alone for another person's slot only makes that person
  not ready (OpenRA `clear_spawn`). OpenRA's server would also take the
  host's faction and colour for another client (LobbyCommands.cs), but its
  lobby (LobbyLogic, a player who is not you) offers the host only team,
  handicap, spawn and the slot admin; WebRA's server accepts that same set
  and refuses the rest; the spawn on the battlefield (`map.players` spawns, or one
  per player); not picked by another slot; never with `type` and never in
  a mission or a resumed save. Lobby slots carry `spawn` when picked; the
  start message's players carry it to the engine. Like OpenRA a ready player
  could not change its spawn; WebRA lets every own change through and makes
  the player not ready, as for faction or colour.

### Bulk edit

The skirmish and online lobbies edit many slots at once
(`apps/game/js/lobby-bulk.js` plans, `lobby-bulkbar.js` is the bar),
beyond OpenRA's slot admin dropdown and its `assign_teams` command
(`LobbyCommands.cs AssignTeams`):

- **Bulk edit** (a toggle by the slots) shows a checkbox in every row.
  Selection works like a file manager, by slot index: a click on a row
  (not on one of its controls) selects that row alone, Ctrl or Cmd adds or
  removes it, and both set the anchor; Shift selects every row from the
  anchor to the clicked one, up or down, in place of the selection (with
  Ctrl or Cmd, or on a checkbox, the range takes the clicked row's new
  state, like Shift on checkbox lists). The anchor stays for Shift. "All"
  selects or clears every row. The selection survives lobby updates and
  forgets rows that are gone; turning bulk edit off clears it.
- One grouped action list and Apply (Enter in the list applies). With no
  row selected an action applies to every slot it can change; slots the
  map locks (map format version 2) keep the locked part. Actions: team
  presets (free for all; humans vs AI, OpenRA's "Humans vs Bots"; split
  into 2 to 4 teams in slot order, OpenRA's `assigned * teams / count + 1`;
  alternating teams; put on one team), AI (fill empty slots with a bot
  type, Normal difficulty: online the open slots, in skirmish the closed
  ones and, with nothing selected, new rows up to the map's spawns; set
  the bot type or difficulty of AI slots; remove the AI: online the slots
  open, in skirmish they close and at least two players must stay),
  factions (any choice of the faction list, or "Shuffle countries" which
  picks a country per slot now), shuffled colours (unique: the targets
  share the colours no other slot holds; skirmish closed rows keep
  theirs; online both only for the host's own slot and the AI slots, as
  the bar says, since another player's faction and colour are its own), handicap (0 to 90 %), start positions back to automatic, and
  slots (make open or closed slots Normal AI; online also remove selected
  players, open or close AI and empty slots; never your own slot).
- Skirmish: the plan is applied all or nothing (`applyBulk`), checked for
  unique colours, two to the map's spawns of players and your own slot.
- Online: only the host has bulk edit (not while resuming a save; in a
  co-op mission only the slot actions, within the mission's places). It
  sends one `slots` message. The server (`room.js setSlots`) applies each
  change exactly as the host's `slot` message (types, AI settings, other
  people's settings, spawns, the mission's places), checks the colours
  once all changes are in (a shuffle swaps them), then the map's locks
  like `slot`; any refusal puts every slot back. Everyone is no longer
  ready, removed players are kicked like the slot admin's, and the lobby
  goes out once. The bar says "Sent to the server..." until a lobby update
  shows every change (then the summary), or the server's refusal. Added in protocol 6 without a version bump (a new
  message only the host sends; sessions pair identical builds).

### Unloading a map

The skirmish lobby's **Unload map** (next to Load map file, while a map
file or `.oramap` is installed) goes back to the generated map with the
size, style, biome, tech buildings and seed it had before: they are kept
while a map file is in use. The file is forgotten as the lobby's map (it
stays in the map library); the slots stay as they are, and the spawn
picks clear with the battlefield as on every map change. The seed field
and New seed show only for a generated map. A game on a map file still
draws its random events from the seed (crates, random factions, the AI,
the weather), so each start on a map file gets a new random seed (the
skirmish lobby picks it at Start, the server at `start` for a lobby map);
the game's options carry it, so replays, saves and Restart keep it, and
the lobby keeps its own seed for the generated map. Online, the host's **Unload
map** (a shared or community map) or **Leave mission** (a co-op mission)
sends `map: null`, like Generated map in the map list: the lobby's
options, seed included, were kept.

### Lobby previews of generated maps

The skirmish and online lobbies make the preview and the start positions of
a generated map in a worker (`apps/game/js/mappreview.js`,
`mappreview-worker.js`), given the engine module the page compiled; the
main thread only draws the bytes. Without workers, or when the worker
cannot load, the same work runs on the page after a timeout (so the loading
state paints first). One generation runs at a time and the latest wins: a
newer request replaces the one waiting (it never starts) and a running one
it overtakes is kept in a small cache but not drawn. The spawns come from
`Game.map_spawns_styled` instead of a whole generated map file.

While a map is made, New seed shows a loader (disabled, `aria-busy`, its die
or ring turns unless Reduce motion, the setting or the browser's, is on),
the preview is dimmed with "Generating the map...", its start markers are
gone (they would name places on the old map) and Start game waits. Online
the host's New seed stays busy from the click until the lobby has the new
seed and its map is made. The map lens still reads its map only when the
pointer first rests on the preview.

Main thread time of one New seed (Node 26, Apple Silicon, `node` timing of
the engine calls; the browser's draw of the preview bytes comes on top in
both): before, the preview, the full map file for the spawns and the caption
took 49 ms (96 x 96) and 60 ms (160 x 160) for the first seed of a page, and
10 to 17 ms on average (up to 45 ms) after that; now only the caption is
left on the main thread (under 0.1 ms), and the worker takes 8 ms and 16 ms
for a first seed, 2.4 to 7.5 ms after that.

### Reconnecting

Every member gets a rejoin key in `welcome.key` (32 random bytes, base64url;
the server stores its SHA-256 only and compares in constant time). The client
keeps `{ id, client, key, name }` per tab in sessionStorage (`webra.rejoin.v1`).

- A player's connection closing in a running game (or the stall drop above)
  takes its seat out of lockstep at once: nobody waits for it. Everyone gets
  `left` with reason `disconnected` (or `dropped`). The seat may come back
  within `RECONNECT_GRACE_MS` (2 minutes); after that it is `expired`.
  **The game does not pause** for a missing player: its units keep their last
  orders. `left`, `kicked` and `removed` (protocol violations) are final.
- `hello` with `rejoin: { client, key }` (no password needed: the key proves
  an earlier admission; wrong keys count toward the per-IP lockout). The
  server answers `welcome` (no new key), `start` (the same fields as at the
  start), `log` messages (the order log: every frame that had orders, in tick
  order, at most 96 KiB per message) and `sync { tick, check }`: every frame
  before `tick` was sent, the ones not in the log were empty; `check` is the
  last state hash a strict majority of players reported (after running tick
  `check.tick`), or null. Live `frame`s follow (one may repeat a logged frame).
- The client fast-forwards (a time budget per animation frame), compares its
  state hash at `check.tick`, then sends `resume`. The server answers `back`
  to everyone with `tick` = its `next frame + delay`: the rejoined player's
  orders count from that frame on (earlier frames go out without it), and it
  sends hashes for ticks from there on. It must resume within 60 s plus 5 ms
  per tick played so far (at most 15 minutes). If its connection drops while
  catching up, it keeps only what is left of the 2 minute grace that started
  when it left play (rejoins never extend it).
- The seat keeps its stall budget: the debt it left with is restored (it
  drains over wall time as usual), and so is its hold time in the current
  drop window while that window has not renewed, so disconnecting never
  resets the drop rules. At most `MAX_REJOINS` (10) rejoins per member and
  game; rejoins that are refused anyway (cap, seat gone, game over) never
  touch the member's open connection.
- A tab whose connection drops reconnects by itself with backoff and keeps
  its game (it only runs the frames it missed); after a page reload it
  rebuilds the game from the start message and the log.
- The order log lives in Durable Object storage: chunks of up to 512 frames
  or 64 KiB of JSON, gzip compressed (`log:<n>`), deleted with the session.
  It stops at `LOG_MAX_BYTES` (16 MiB of JSON); from then on rejoins and late
  spectators are refused and the game goes on. A catch-up counts from its
  start until the client confirms (`resume`, or `synced` from a spectator,
  which must come within the catch-up time); at most 2 count at once, at most
  6 start per minute, and their bytes are budgeted (each takes the log's
  current size; bursts of two full logs, refilled by one full log per
  minute). Refused ones get `rate_limited` and retry.
- Chat: one line a second per connection, bursts of five; flooding closes
  the connection.

### Lobby maps

The host plays a generated map (`map: null`), a published map from the
community list (`map` with its id and hash; the server looks up its details
in D1) or a map file of its own (the map editor, an `.oramap` import, a map
from an earlier lobby; the game keeps them in its map library,
`apps/game/js/maplibrary.js`, IndexedDB keyed by hash). Its own map is
**shared with this session only**: `POST /api/sessions/:id/map` with the map
JSON and the header `X-WebRA-Member: <client>.<rejoin key>` (the key from
`welcome.key`). The Worker checks the account gate (as for the WebSocket),
the upload quota (10 per hour per network, shared with `POST /api/maps`), the
size (1 MiB) and the map (upgraded to the current format version, then the
protocol package and engine, as for uploads; the lobby hash is the upgraded
map's, so every member gets the same map); the
session object checks the member key (constant time, bound to the account it
was issued to, wrong keys count toward the per-IP lockout) and that the
member is the host, stores the map **unlisted** (deduplicated by hash) and
makes it the lobby map. Unlisted maps are not in `GET /api/maps`, not served
by `GET /api/maps/:id` and cannot be picked by id with `map`; publishing the
same map with `POST /api/maps` lists it. See security.md "Map sharing".

Every lobby message with a map gives each member a `mapState`: `installed`,
`missing` (the default) or `declined`. A player without the map sees
"Custom map: <name> by <author>. Install?" (map details: players, size,
file bytes, modded) with Install and Decline. Install downloads it with
`GET /api/sessions/:id/map?hash=<sha256>` and the member header (members of
the lobby or the running game only; 409 when the session's map has another
hash; `Cache-Control: private, no-store`; 120 per hour per network), checks
it like any map (protocol package and engine, the hash must match), shows the
modded warning when it carries rules, keeps it in the map library and sends
`mapstate installed`. Decline sends `mapstate declined`: the player cannot be
ready, and the host sees who lacks the map (and may remove a spectator with
`kick`). `ready` with the map's hash counts as installed. The game starts
only when every player and every spectator has the exact map installed; the
host has it. A map already in the library is installed at once (checked by
the engine again). Members joining a running game (a reload, a late
spectator) get the game's map the same way. Names and authors are shown as
text only.

### Rematch

Like OpenRA's way back to the lobby with everyone: in a running game the
host sends `rematch { accept: true }`. Everyone gets `rematch { state: 'open',
by, accepted, waiting, msLeft }`; `waiting` lists the players still in the
game (seats that are not gone, also one whose connection is away) that have
not accepted. Players answer with `rematch { accept }` (from the in-game
overlay, the end of game dialog, the statistics screen or the game menu);
spectators do not vote. One decline, the host withdrawing (`accept: false`)
or leaving, or 2 minutes without everyone (`REMATCH_VOTE_MS`) end it:
`rematch { state: 'cancelled', reason: declined | withdrawn | left | expired }`,
and the host can propose again after 10 s. When every player accepted, the
session goes back to its lobby with the same slots (factions, colours,
teams), options (seed included: the same map) and map, ready flags cleared,
and sends `rematch { state: 'lobby' }`. The relay and the order log are
dropped. The players who accepted and the spectators keep their places and
must come back within `REMATCH_RETURN_MS` (60 s): the client reloads the page
(a finished game is not torn down in place) and sends `hello` with `rejoin`
and its key, answered with `welcome` and `lobby`. Until that deadline a lost
connection (closing the old page, a second reload) does not give up the
place, and a newer connection replaces an older one; `leave` does give it up.
At the deadline connected members stay and the others lose their places.
Other places open at once. A client that missed `rematch { state: 'lobby' }`
(its connection was away) reconnects into the lobby and reloads the same way.
The host starts the next game as usual.

### Online saves

Any player still in the game proposes saving it with `save { accept: true }`;
everyone gets `save { state: 'open', by, accepted, waiting, msLeft }`. Every
player still in the game (also a defeated one) must accept within 60 s
(`SAVE_VOTE_MS`) and be connected; every human seat must still be in the game
and signed in with an account (players are matched by account when the save
is resumed). One decline, the proposer withdrawing or leaving, or the time
running out ends it: `save { state: 'cancelled', reason }` (`declined`,
`withdrawn`, `left`, `expired`, `desync`, `accounts`, `too_long`, `failed`),
then 10 s before the next proposal. Spectators do not take part.

Agreed: the server picks the save point, the first multiple of 25 at or
after its next frame plus the order delay (no client ran it yet), and sends
`save { state: 'agreed', tick }`. The game goes on; it does not pause (the
save point is a tick in the past for everyone by the time the save is
written, so nothing has to stand still). Every player reports its state hash
at that tick anyway (`hash`). When all of them match, the server stores a
record in D1 (`online_saves`, `online_save_members`): the save point
(`ticks = tick + 1`), the agreed state hash, a digest of the order frames
before the save point (`framesDigest`: starting from the SHA-256 of the empty
string, each frame in its validated form is chained as `h = SHA-256(h +
JSON([tick, orders]))`, so the server computes it from its order log chunk
by chunk), the SHA-256 of the game options (`optionsDigest`), the map
hash, the game version, the session name and the account of every seat. It
answers `save { state: 'saved', id, ticks, hash }`, and every player's client
writes the save file (section 7, `online.id` = the record) from its own
recording into the browser's saves. Different hashes: `cancelled` with
`desync`; no hash within 60 s (`SAVE_HASH_MS`): `expired`. The server keeps no
orders, options or map of a save. Records are deleted after 90 days, beyond
20 per account (the oldest go first) and when an account that played in
them is purged.

Resume: in the online browser, "Resume a saved game" lists the browser's
online saves; the player creates a session as host (private by default, at
least as many places as the save has players; the other players join with
the invite link) and the client sends the file with
`POST /api/sessions/:id/resume` and its member header. The Worker needs a
signed-in account and 10 resumes per hour per network; before reading the
body it checks that the requester is the host (the session's `checkHost`)
and that Content-Length is at most the order log limit plus a map plus 256 KiB
(413). It validates the file (`parseReplay`, the orders counted against the
order log limit while validating with the order log's own accounting,
`logEntryBytes`: 413), finds the record by `online.id` (404 when
the server no longer keeps it), and requires the same save point, final state
hash, game version, map hash, options digest and frames digest (409
otherwise) and the requester's account among the save's players (403). The map, when there is one, is
checked like an upload and shared with the session (it stays unlisted). The
session object checks the member key and the host role and that the session
runs the save's game version, keeps the orders in its storage and turns the
lobby into the saved game: the slots are the saved players with their
resolved factions, colours and teams; each human slot is reserved for the
account that played it, and only that account can take it (others may watch);
the options and the map stay as saved. Lobby messages carry `resume` with the
names the lobby still waits for; the host can start once every saved player
is back, ready (which means agreeing to continue) and has the map.

The start message carries the saved options exactly and `resume: { ticks,
hash }`. Every member gets it with the saved orders as `log` messages and
`sync { tick: ticks, check: { tick: ticks - 1, hash } }`: clients fast-forward
like a rejoin and compare their state hash at the save point. A player whose
hash differs does not continue; the others send `resume`. When every player
caught up (or the catch-up time ran out for some: 60 s plus 1 ms per saved
tick, at most 3 minutes; such a player gets `error dropped`, everyone gets
`left` with reason `dropped`, and its seat waits `RECONNECT_GRACE_MS` for a
rejoin like after a lost connection), the relay starts at `ticks`: `back` with that tick for
every player, then the empty frames `ticks .. ticks + delay - 1`, and the game
goes on in lockstep. Orders and hashes before that are refused with
`bad_state`. The resumed game records itself completely (it replays from tick
0), so it can be saved again.

### Spectators

Lobby places for observers: the host sets `maxSpectators` (0..8, default 2).
`hello` with `spectate: true` joins as a spectator (same password and host
key rules as players), in the lobby or in a running game (then like a rejoin:
`start`, `log`, `sync`, live frames). In the lobby a member switches between
an open slot and the spectators with `spectate`; a spectating host keeps the
host role. Spectators are not in `start.players`, receive every frame and
chat, never count for stalls or hash majorities, and the server removes a
spectator that sends `orders` or `hash` (`left` reason `removed`).

On phones and touch screens (`apps/game/tests/spectate-mobile.test.mjs`):
the session list's Join and Watch get a row of their own below 760 px;
the catch-up message ("Joining the game...", "Catching up with the game...
N%", `js/records.js` ProgressOverlay) is one line where it fits; the
observer panel starts below the 44 px HUD buttons (it covered Menu) and
scrolls on short screens; in the phone layouts (`js/layout.js`) its view
buttons are one sideways-scrolling row, full width in portrait and at most
half the width in landscape; spectators and replays get no touch action bar
or placement buttons (no orders), so the bottom belongs to the replay bar
and the chat; a Chat button in the HUD row (touch screens only) opens the
chat of online games and replays with chat, and the chat's first line says
"Tap Chat to chat" there; in replays the chat follows the replay bar's
height (`--replay-bar-height`, measured by a ResizeObserver). Spectators
have no radar in WebRA (the sidebar that holds it is hidden for them).

### Defeated players

The engine refuses every order of a defeated player (it may still own
submarines, walls or mines), on every peer and in replays; `apply_frame`
skips them. A defeated player may keep watching: its client switches to the
observer view, keeps running lockstep (empty `orders` every tick, `hash`
as before, the same stall rules) and sends `defeated` once (again after a
reconnect). The server keeps the seat but drops its orders from then on,
also ones already waiting for a frame and after a rejoin, and its team chat
joins the spectators' (see `chat`). A seat cannot undo it; a spectator sending `defeated` gets `bad_state`. Online games never
pause for the end-game dialog.

Surrender (OpenRA IngameMenuLogic SURRENDER and its "Surrender" order,
which MissionObjectives.ResolveOrder answers with ForceDefeat) is the order
`{ "o": "surrender", "player" }` (`Order::Surrender`, `Game.surrender(p)`;
protocol 6, no version bump: sessions pair identical builds). It goes
through lockstep like every order: the server validates it (no fields
besides `player`), stamps the sender's seat and relays it in a frame, so
every peer and replay applies it on the same tick. In a skirmish the player
loses at once (gamerules.rs `surrender`: OwnerLostAction, the PlayerLost
event with the "Mission failed" line, `defeatedAt`), and the game ends when
the players left are on one side; in a mission (co-op online) the mission's
tick fails the player's open objectives with their script triggers, which
loses it. A player that already lost, the neutral player and a decided game
ignore it. From then on it is a defeated player as above: the client sends
`defeated`, watches as a spectator or leaves. The game menu offers it like
OpenRA: only to a player (never a spectator or a replay) of an online game
with more than one person (OpenRA's `isSinglePlayer`: one client that is not
a bot, spectators included), after a confirm step ("Surrender" or "Stay"),
disabled once the player's game is decided or a mission's script stopped.
Single player games (skirmish against AI players, campaign missions) have
no Surrender, as in OpenRA; leaving an online game still keeps the seat
playing on as described above.

Game info (the game menu's Game info page, `js/gameinfo.js`; OpenRA
GAME_INFO_PANEL, GameInfoLogic): the map's title over the tabs Objectives,
Briefing (only with a mission briefing or a map file description: OpenRA's
MissionData.Briefing; the map preview, author and text) and Options (the
lobby options or a mission's options as played, read only). Objectives is
OpenRA's SKIRMISH_STATS (GameInfoStatsLogic) in a skirmish: the local
player's "Destroy all opposition!" with In progress, Accomplished or Failed,
then every player's score (`observer_stats` `experience`, OpenRA
PlayerStatistics.Experience, the PlayerExperience trait) sorted by score and grouped by team, the teams
with the most score first (headers only with more than one group), names
with "(Won)" or "(Lost)", then the spectators. A player still in the game
sees the real country only of itself and its allies; the others show the
lobby's choice ("Random" for a random pick) until its own game is decided,
like OpenRA's DisplayFaction. Where the lobby's choices are not known
(a rejoin after a reload, which saw no lobby; a loaded single player save,
whose file keeps only the drawn countries, so OpenRA's "Random stays
Random" cannot be restored), opponents show "Unknown" until the player's
game is decided, never the drawn country. Replays and spectators see the
drawn countries. No other statistics reach a player still in the game: the full
statistics screen stays for spectators, defeated players and the end. In a
mission Objectives is OpenRA's MISSION_OBJECTIVES (the mission status and
the objectives, primary first, from `mission_state`). The page draws its
scores again every second while it is open. Not ported: OpenRA's Debug and
Chat tabs (WebRA's debug menu and chat are elsewhere), the per player Mute
and Kick buttons (WebRA has no in-game kick), and the "(Gone)" suffix of a
player who disconnected.

Engine side (landed): `Game.set_lockstep(true)` makes order methods queue into
an outbox; `Game.take_orders()` returns them as a JSON array of order objects
(`{"o": "move", ...}`, see `Order` in engine/src/world.rs); 
`Game.apply_frame('[[player, [order, ...]], ...]')` queues one frame before
`tick()` and re-stamps every order with that player index (invalid entries are
skipped, returns the count). `Game.state_hash()` (hex string) for desync
checks, `Game.player_count()`. Players: 2..8, `team` per player (0 = free for
all); `player_json` has `won`, `defeated` and `team`.

Observers (engine/src/observer.rs): `Game.observer_player()` (255) passed to
`build_render`, `build_render_records` and `fog_ptr` renders the whole map with every actor live (no
ghosts, no owner-only decorations); 254 (engine/src/combined.rs, OpenRA's "All
players" view) renders what every non-neutral player sees together: cells any
of them sees, structures any of them remembers, fog where any explored, gap
generator shroud only where it hides a cell from all, cloaked and submerged
units shown and no owner-only decorations (render only: slot 0's vision is
swapped for the union during the call and restored). `Game.army_counts(player)`
lists `[actor type index, count, ...]` of the units that count for the army
value (the observer panel's army icons, OpenRA PlayerStatistics.Units): each
under the type its UpdatesPlayerStatistics.OverrideActor names (rules
`world.stats_actor`: the paratroopers' E1R1 and E3R1 count as E1 and E3),
only types with a build icon (never `~disabled`, OpenRA Buildable), ordered
by production tab (QueueType order, which is OpenRA's ProductionQueue
DisplayOrder) and then BuildPaletteOrder. `Game.observer_production(player)`
returns `{ funds, powerGenerated, powerUsed, lowPower, queues: [{ queue, id,
progress, done, paused, remainingTicks, buildTicks }], powers: [{ key, icon,
name, description, progress, ready, charging, remainingTicks, totalTicks }] }`
(null for an unknown player): each production tab's current item with the
time left as OpenRA's RemainingTimeActual (stretched by LowPowerModifier
while power is low), and the support powers in palette order with their
SupportPowerInfo.Icon (rules `icon`, also in `player_json` powers). It is
small enough to ask for every player on each UI update (`player_json` lists
every buildable type). `Game.observer_stats()` returns `[{
player, faction, team, isAi, cash, funds, earned, harvestedOre, harvestedGems,
spent, repairSpent, sold, armyValue, unitsKilled, unitsLost, buildingsKilled,
buildingsLost, assetsDestroyed, assetsLost, damageDealt, damageTaken,
unitsBuilt, buildingsBuilt, aircraftBuilt, shipsBuilt, builtValue, experience,
unitExperience, promotions, powersUsed, orders, score, powerGenerated, powerUsed, vision,
derricks, defeated, defeatedAt, won }]` for the non-neutral players (kills credited to the owner
of the weapon that dealt the killing damage; `experience` is OpenRA's
PlayerStatistics.Experience, the player's PlayerExperience (a kill gives
the victim's value times its PlayerExperienceModifier, 1 per 100 credits;
repairs of an ally's structure and infiltrations add theirs; the time
limit's tie breaker), shown by the game info scores, the observer panel's
Experience column and the statistics screen; `unitExperience` is the
veterancy experience the player's units gained, behind `promotions`;
`vision`: the percentage of the map's cells the player sees now, rounded up, 0 once defeated, OpenRA ObserverStatsLogic.Vision of Shroud.RevealedCells; with the fog of war off the engine's visible cells include every explored one, like OpenRA's count that never goes down without fog, except that cells a GPS satellite explored count at once where OpenRA counts them when first seen. `derricks`: owned actors with UpdatesDerrickCount, rules `world.derrick`, the oil derricks. `orders` counts the orders of
the order log, AI decisions are not orders; `score` is the value destroyed
plus half the value built; not part of the state hash).
`Game.observer_report()` adds per player `productionTicks` (per queue),
`built`, `killed`, `lost`, `units`, `structures` (actor id -> count) and
`powers` (power key -> times fired), plus `{ tick, ticksPerSecond, winner,
endTick, history: { interval, ticks, players: [{ player, funds, earned,
spent, armyValue, kills, deaths, assetsDestroyed, assetsLost, harvested,
powerGenerated, powerUsed, orders, damageDealt }] } }`: a sample on tick 1,
every 125 ticks (5 s) and on the tick the game ended, the same on every peer
and in a replay. `Game.player_defeated(p)` is a cheap check for the lockstep
driver. The client's end-game dialog (`js/endgame.js`) and statistics screen
(`js/stats.js`, tabs Basic, Economy, Production, Combat, Army, Support powers,
Graphs) read these; the screen asks for the report (`ask.observer_report`)
when it opens and every two seconds while it is open.

The spectator's statistics panel (`js/observer.js`, OpenRA
ingame-observer.yaml with ObserverStatsLogic; F1..F7 or its list) groups the
players by team in ascending order with a "Team N" or "No team" header row
when anyone has a team (TEAM_TEMPLATE), shows each player's faction flag
before the name (FLAG; the flags of css/lobby.css), and has OpenRA's
columns: Economy with Derricks, Combat with Vision. Production, Support
powers and Army are rows of icons per player (`js/observer-icons.js`,
ObserverProductionIcons, ObserverSupportPowerIcons, ObserverArmyIcons): the
cameo (js/cameo.js, the player's own content first), a clock shade over what
is still to go, and the time left (FormatTime: seconds rounded up), "Ready"
or "On hold"; production icons group the current items of all tabs by type
(the count shows when several tabs build it, which Red Alert's one tab per
type never does) in tab and palette order, ready first, then building, then
on hold; support powers show "Ready" (OpenRA SupportPowerInstance.Ready:
charged and Active, with a powered provider; `observer_production` `ready`
means the same) or the time left, in red while every provider is without
power (00:00 in red once charged, as OpenRA draws it; its "ON HOLD" is for
powers without a provider, which it leaves out); army icons
show the unit count. Each icon has OpenRA's tooltip: production (name, cost
red when the player cannot pay, build time red under low power, power, the
description; no hotkey or click hints for spectators), support power (name,
"time left / charge time" red while paused, description) and army (name and
description). Support power pictures are WebRA's own emblems
(`js/art/powericons.js`) or, with the original content installed, Red
Alert's icons (`icon:<name>` through the cameo source, sequences of OpenRA's
"icon" image in the content tables). The rows stay on screen between
updates (rebuilt only when the panel or the players change) and each update
writes only the text, clock and counts that changed; pictures are painted
once and again when the installed content changes. Not shown: OpenRA's
Economy "Assets" column (the value of everything a player owns) and the
production icon overlays (veterancy chevrons). `Game.snapshot()` and
`game.restore(snapshot)` copy the whole world in memory (replay seeking; not
serialized).

### Production queues (`engine/src/production.rs`)

Orders `start_production {ty, count}`, `cancel_production {ty, count?}`
and `pause_production {ty, paused}` serve every queue, structures included:

- Queueing never depends on the credits (OpenRA ProductionQueue
  StartProduction and CanQueue): `start_production` queues as many as fit
  under Buildable.BuildLimit and ProductionQueueInfo ItemLimit (999 of one
  type per queue, `ITEM_LIMIT`, Red Alert keeps OpenRA's default; the "all
  tech" cheat lifts it and the BuildLimit). OpenRA's QueueLimit is 0 (no
  cap on a queue's total); WebRA caps a queue at 2000 items (`QUEUE_CAP`,
  also with the cheat), far above real use, because every client of a
  lockstep game simulates every queue. Earlier WebRA versions capped every
  queue at 30 items, which made further clicks do nothing. Production pays as it goes (OpenRA
  ProductionItem.Tick): each tick the head takes its share of the cost, and
  when the credits do not cover it the item stands still (no progress,
  InsufficientFunds, throttled) and goes on by itself once money comes in.
  `player_json().buildable[].itemRoom` is how many more of a type its queue
  takes (ItemLimit and QUEUE_CAP); queue items carry `paid` (credits paid
  so far). `cancel_production` with a count and `CancelUnbuildableItems`
  below each take one pass over the queue (the latter asks each item type's
  availability once per queue and tick), so long queues stay cheap.

- Structures queue like units (OpenRA): left click queues one, shift queues
  five. Only the first item of a queue is built. A finished structure waits
  for placement and the items behind it do not start until it is placed, so
  each structure queue has at most one ready structure. `place` only accepts
  the finished head of the queue.
- Placement follows OpenRA's BuildingInfo.IsCloseEnoughToBase and
  World.CanPlaceBuilding. A structure with RequiresBuildableArea needs a
  footprint cell within `adjacent` cells (both axes) of a footprint cell (not
  `_`) of an own structure, or an allied one with the "Ally build radius"
  option, whose GivesBuildableArea types (`gives_area` in rules.json) share
  one of its `requires_area` types: 2 cells for most structures, 7 for walls,
  8 for naval yards and sub pens (and their fakes); fakes give and need only
  `fake` area, so a real structure never goes next to fakes alone. With the
  "Build radius" option a structure with `requires_base_provider` also needs
  its OpenRA centre within a base provider's range of the provider's OpenRA
  centre (both footprint centres plus LocalCenterOffset, `center_offset`;
  the yard's is half a cell up), comparing squared lengths like OpenRA. A
  structure without RequiresBuildableArea (`requires_area` null) goes
  anywhere its terrain allows. Every footprint cell must be on the map, of
  the structure's terrain (naval yards and sub pens: Water only, never
  beach or river), without ore or gems, and empty: no structure, unit,
  husk, crate or mine. A unit takes its cell like in OpenRA's ActorMap
  (`occupies_cell`): from its creation, a paratrooper on its parachute
  too, but an aircraft only when landed. The same rule decides where
  crates drop (the spawner's target cell; the delivery plane drops the
  crate over the first cell of its approach within DropRange that suits
  it, the crate's TerrainTypes from ^Crate and no actor there, usually
  before the chosen cell, as in OpenRA, and flies off with it when none
  does; WaterChance only chooses the target), where a helicopter may land,
  what a falling bridge kills and which units a mission's footprint
  trigger sees. A crate landing on a unit whose locomotor crushes crates
  (a paratrooper still on its parachute too) is collected by it; landing
  on anything else (a landed aircraft, a structure, husk or mine)
  destroys it (OpenRA Crate.OnLanded).
- Like OpenRA (World.IsCellBuildable at b6fc03f), placement reads the true
  world state and never the player's view: footprints may reach into the
  shroud and the fog, and every occupant blocks its cell whether the player
  can see it or not: enemy units and structures under the shroud or fog,
  cloaked units (submarines, phase transports), hidden enemy mines, husks and
  crates, and ore or gems under the shroud. The footprint preview
  (`placement_preview`) asks the same check, so a blocked cell there tells
  the player something occupies it; a structure destroyed under the fog
  frees its cells at once. See docs/security.md.
- Wall lines follow OpenRA GetLineBuildCells: from a placed piece each
  direction is searched up to LineBuild Range - 1 cells (7 for Red Alert's
  walls); free cells and unexplored cells are passed over, the first other
  cell ends the search, and a piece of the same wall there (any owner) fills
  the cells passed over (OpenRA joins a LineBuildNode whose Types match the
  piece's NodeTypes; every Red Alert wall has its own node type, so WebRA
  compares the wall type). OpenRA puts a piece on every passed cell, even an
  unexplored occupied one; WebRA structures never share a cell, so such a
  cell stays empty.
- `cancel_production` (OpenRA CancelProduction with its count) removes the
  last `count` queued items of that type, the most recently queued first,
  and refunds what was paid for each (a partly built one what it cost so
  far, a finished structure its full cost). `count` is 1..50 like
  `start_production`'s; orders without one (older replays) cancel one.
- `pause_production` (OpenRA PauseProduction) puts the first queued item of
  that type on hold or resumes it. An item on hold at the head of its queue
  holds up the queue (no progress, nothing paid); finished items are never
  on hold. It is in the state hash.
- The sidebar (`js/production.js`) follows OpenRA's ProductionPaletteWidget:
  left click queues one, Shift five (`SHIFT_COUNT`); left click on a held
  item resumes it; middle click cancels at once (Shift: five). Right click
  acts on the press (OpenRA handles MouseInputEvent.Down; Firefox shows its
  own menu for Shift + right click without a contextmenu event) and follows
  the personal setting `game.buildRightClick` (Controls page, synced with
  the account), which only changes the orders the client sends:
  `openra` (default, OpenRA HandleRightClick, the sidebar's behaviour
  before the setting existed): the first queued item of the type is held
  while it is being built; on hold, finished or not started (nothing paid)
  it cancels the click's count, the most recently queued first, so a held
  item goes last. OpenRA has no other Shift rule: Shift only sets the count
  to five. `webra` (a stack, the item being built at the bottom): while the
  first item of the type is being built and others of the type are queued,
  a right click cancels the most recently queued ones (at most all but the
  one being built); once it is the only one, it is held, then cancelled.
  Shift cancels five the same way. Ctrl + right click (OpenRA: cancel the
  whole queue's count) is not mapped, as Ctrl + click is a right click on
  macOS. A touch long press is the right click, the Add toggle is Shift.
  Each card counts the holds, resumes and cancels it sent as done until
  `player_json` shows them (at most `PENDING_MS`, 1.5 s): it takes the
  smaller of the shown count and the count before its cancels minus them,
  so cancels the engine already applied (or a first item that finished)
  are never counted twice, and items queued meanwhile move that start
  count up. A contextmenu event within 2 s of a right press on the cameo
  is that press's own (`RIGHT_PRESS_MENU_MS`); later ones (the menu key)
  act like a right click. Quick clicks
  act on what the earlier ones ordered rather than on a state a few ticks
  old (in the WebRA style that keeps a fast series of right clicks from
  reaching the item being built early).
  `player_json().queues[][]` items have `paused` and `started` (something
  paid).
- Short of credits: a cameo gets a red frame and a red "$" (class `short`,
  `shortOfFunds`) while the credits (`funds`) are less than what is still to
  pay for one of its queued items plus every item ahead of it in its queue
  (cost minus `paid`; finished items are paid). Each queue is counted on
  its own though all draw on the same credits. Updated with every
  `player_json` refresh; the tooltip says how many items wait for credits
  and the accessible name adds "waiting for credits". WebRA's own marker:
  OpenRA's palette shows none.
- Buildable.BuildLimit (`build_limit` in rules.json, 0 none: the
  superweapons, Tanya): owned plus queued of that type stay within it;
  `start_production` queues only what fits, the "all tech" cheat lifts it.
  `player_json().buildable[].limitLeft` is how many more fit (null: no
  limit); with `itemRoom` the sidebar knows what OpenRA's CanQueue would say
  (Building or Training; Building in progress at ItemLimit; Unable to build
  more at BuildLimit).
- OpenRA `CancelUnbuildableItems`: every tick, before production advances,
  each queued item that can no longer be produced is cancelled and refunded,
  wherever it is in the queue. That is an item whose prerequisites were lost
  (a half-built Heavy Tank after the Service Depot died), and every Building
  and Defense item once the player has no Construction Yard. The rest of the
  queue carries on; the items can be queued again once the prerequisites (or
  a deployed MCV) are back. Unit queues keep going from their own factories.
  `start_production` and `place` are refused for such items.
- Losing the last factory (lobby option `factoryLoss`, section 3): a queue
  builds while the player has a structure of its type (OpenRA
  ClassicProductionQueue.Enabled). Under `openra` (OpenRA at b6fc03f) a
  queue without one is not Enabled: every tick, before anything else,
  ClearQueue empties it and refunds everything paid for each item (a
  finished one, also a structure waiting for placement, in full; partly
  built ones what they cost so far), with no notification, and nothing can
  be queued there (`can_produce` is false, `requirements` names the
  producers) until such a structure stands again. That holds for every
  queue: structures and defences after the last Construction Yard, units
  after the last barracks or kennel, war factory, airfield or helipad,
  naval yard or sub pen. Under `webra` a unit queue keeps its items and
  waits, paying nothing, and builds on once a structure of its type stands;
  structure items are cancelled with a refund and one ProductionCancelled
  (`CancelUnbuildableItems` above). WebRA refunds everything to cash
  (OpenRA returns the stored-ore share of a payment to the silos). A unit
  that finishes while structures of its queue's type stand but none makes
  its `build_at` type is not made
  (OpenRA BuildUnit with CancelProduction(unit, 1)): the last item of that
  type in the queue is cancelled and refunded, one per tick, so the finished
  one goes once it is the last, and the queue says ProductionBlocked once
  (not for instant builds).
- `player_json().buildable[].enabled` is false for structures without a
  Construction Yard, and their `requires` lists `Construction Yard`; under
  the `openra` factory loss rule likewise for units without a structure of
  their queue's type (once their prerequisites are met: those already
  name it).
- `player_json().buildable[].buildTicks` is the time the item takes with the
  player's current factories (BuildTimeSpeedReduction), before the low power
  slowdown; `rules_json().lowPowerModifier` is that slowdown in percent. The
  sidebar's production tooltip shows both (OpenRA ProductionTooltipLogic).
- Leaving the factory (OpenRA Production.Produce, SelectExit, CanUseExit;
  ClassicProductionQueue.BuildUnit): a unit is built as its
  `build_at` production type (OpenRA Buildable.BuildAtProductionType, else
  the queue's type; under the debug menu's "all tech" the queue's type, so
  a submarine comes out of a naval yard and a dog out of barracks then).
  The structures whose Production types hold that type make it; a finished
  unit tries the primary one, then the others (OpenRA: the newest first;
  WebRA: in actor order). The build time still counts the structures by
  `build_at` (OpenRA GetBuildTime). A structure's exits are those whose
  `exit_types` (OpenRA ExitInfo.ProductionTypes, empty for any) hold the
  type the unit is built as. The sub pen has four Submarine exits, (-1, 2)
  and (3, 2) beside it and its top corners (0, 0) and (2, 0), and four Ship
  exits on all four corners; the Ship exits let out only units built as
  Ship (the transport, which has no BuildAtProductionType, and under "all
  tech" every ship). They are tried by
  `exit_priority` (OpenRA
  ExitInfo.Priority, highest first: the Kennel's down-left exit), then
  nearest the rally point (without one, nearest a point below the structure;
  OpenRA shuffles them). Each exit tried first tells the friendly units on
  it that they are in the way (idle ones step aside, see the movement
  models), and the unit leaves by the first exit cell it can enter now:
  nobody holds it that it could not run over, infantry need a free
  sub-cell. The new unit holds its exit cell at once (OpenRA LocationInit),
  so the next one waits until it has driven off: units come out one at a
  time, also with the debug menu's instant build, and never stack. While
  every exit of every producer is blocked (an enemy, a unit that does not
  move, a husk) the item stays finished, the queue says so once
  (ProductionBlocked) and tries again every tick. Ships follow the same
  rule on their launch cells: the open water at each exit that lets them
  out, just outside the structure for an exit on its own corner and the
  exit cell itself for one already outside it (the sub pen's submarine
  exits) (`naval_launch_cells`; water joined to the
  rally point first, else the largest water, and only cells on that water,
  so a ship is never launched into a pond it cannot leave, OpenRA issue
  19154; then the exit nearest the rally point): friendly idle ships on one
  are asked to make way, and the ship waits while every launch cell is
  taken. Aircraft are never held up.
  Without a rally point a unit or ship stays where it came out until the
  next one asks it to make way (OpenRA at b6fc03f: RallyPointInfo.Path is
  empty by default and Red Alert sets none, so Production.DoProduction
  gives the unit its exit cell as rally point; older OpenRA releases had a
  default rally point offset);
  helicopters stay on their pad. In the WebRA movement model ground units
  and ships drive on to a cell below the structure instead, and only units
  standing idle on an exit block it (that model's crowd separation spreads
  the ones on the move; waiting for those would jam the door behind the
  crowd its arrival rule gathers in front of it). Differences: units appear
  on the exit cell instead of inside the structure at the Exit's
  SpawnOffset (ships launched from a corner exit on the water just outside
  it instead of on the corner itself), and the Exit's Facing is not used.
- Selling (`{"o": "sell", player, building}`, `World::sell_refund`) pays
  OpenRA's Sell activity refund: `sell_value * sell_refund * hp / (100 *
  max_hp)`, rounded down, where `sell_value` is OpenRA GetSellValue
  (`custom_sell_value`, the actor's CustomSellValue, else its `cost`) and
  `building.sell_refund` is Sellable.RefundPercent (50 in Red Alert; 0: no
  Sellable, so it cannot be sold). So a pillbox pays 200 (CustomSellValue
  400, not its cost 600), a camouflaged pillbox 275, a refinery 150, and
  walls (CustomSellValue 0) can be sold for nothing. A map rule that
  changes the cost changes the refund of actors without CustomSellValue,
  like OpenRA. The same value is the base of the repair cost (repair.rs),
  kill bounties (gamerules.rs), the sell crew (sell.rs) and the AI's
  capture value. A structure being captured or demolished cannot be sold.
  `Game.sell_value(player, id)` is that refund for an own structure, -1
  while it cannot be sold (the sell cursor, and the "Refund: $n" tooltip
  line, $0 for walls); the Sold event (7) carries the refund in `b`, which
  js/battlefx.js floats as "+$n" for the seller and its allies when it is
  above 0 (Sell ShowTicks); the statistics' `sold` adds it up. The broke
  AI sells the structure that pays the most first within a rank.
  Map rules overrides may give any actor `custom_sell_value` (a whole
  number 0 to 1,000,000), and `null` takes a built-in one away like
  OpenRA's `-CustomSellValue` (the cost counts again); the editor's rules
  tab and its raw JSON view accept the same (editor/js/overrides.js). A
  CustomSellValue node without a Value counts 0 (the field's default in
  CustomSellValue.cs; OpenRA's FieldLoader.Require would refuse it).
  Known difference (timing): WebRA sells within the tick the order runs: it
  pays the refund at the health the structure has then, to its owner then,
  spawns the crew (SpawnActorsOnSell), raises Sold and removes the
  structure at once. OpenRA's Sellable.Sell cancels the activity, plays the
  sell sounds, calls INotifySold.Selling and, unless SkipMakeAnimation,
  plays the make animation backwards first; only then does the Sell
  activity (not interruptible) compute the refund from the health at that
  moment (damage taken meanwhile lowers it), pay the PlayerResources of the
  owner it captured when the order was given, call INotifySold.Sold (the
  crew comes out then), speak the notification and dispose of the actor.
  RefundPercent 0 also means "not sellable" here.

## 5. Domains for units

`engine` units move in a domain: `ground` (flow fields on land), `water` (flow
fields on water cells, naval yards are their docks) and `air` (free flight,
no pathfinding). Queue types: Building, Defense, Infantry, Vehicle, Aircraft,
Ship. Target classes: infantry 1, vehicle 2, structure 4, air 8, water 16,
mine 32, underwater 64 (submerged submarines), submarine 128 (any
submarine; depth charge warheads), husk 512 (husks), heal 2048 (damaged infantry: the Medic),
repair 4096 (damaged vehicles, ships and landed aircraft: the Mechanic).
Naval yards are structure and water. Warheads carry `relationships`
(OpenRA ValidRelationships: 1 ally, 2 neutral, 4 enemy).

Transports (engine/src/cargo.rs): a right-click with units on an own
transport they fit in is the smart action `Load` (6, `Game.cursor_action`).
`Game.deploy` on a loaded transport unloads it; `Game.deploy_state` is 1 when
it can unload now and 2 when no free cell is next to it. `Game.actor_json`
reports `passengers` (ids), `cargoWeight`, `cargoMax`, `carrier` (the
transport a passenger is in, or 0xFFFFFFFF) and `submerged`. Passengers are
out of the world: not pickable, not box-selectable, dropped from the selection.

Primary buildings: on a production structure with PrimaryBuilding
`Game.deploy_state` is 3: `Game.deploy` (or clicking the
selected structure) toggles it as the primary producer of its queue
(`engine/src/primary.rs`), which new units leave from first; sound event 32
PrimaryBuildingSelected announces it.

Leftovers (`engine/src/husks.rs`, `crates.rs`, `smudges.rs`): crates and
husks are actors of kind `crate` and `husk`. They are not units: not selectable or targetable (husks take damage
from warheads and burn down by ChangesHealth), each holds its cell for
placement and movement, and a right click on one is a move. Husks follow
OpenRA's Husk rules (drag to the death position, crush what the locomotor
crushes, Capturable / InfiltrateForTransform data in `rules_json` for the
capture orders). Selling spawns crew (SpawnActorsOnSell). LeaveSmudge
warheads mark a cell (one mark per cell: a newer one replaces it) in the
alpha byte of `terrain_ptr`: 255 none, else bit 6 crater (else scorch), bits
3 to 5 the variant (0 to 5, OpenRA cr1..cr6 and sc1..sc6), bits 0 to 2 the
depth (`engine/src/smudges.rs` `encode`); the terrain shader draws them and a
new mark only shows once its cell is in the view player's sight. DestroyResource
and CreateResource change ore deterministically. Effects of these are sound
events (`[kind, a, x, y, owner, b]`): 36 CrateCollected (a =
`crate_action_code` of the action's class, b = crate type), 35
TimeLimitWarning (a = minutes left, owner = `ALL_PLAYERS`), 38 Bounty (a =
amount shown, owner = killer), 39 TimeLimitExpired (owner = `ALL_PLAYERS`),
40 PlayerLost, 41 ScreenShake (a = ticks, b = intensity, owner = `mx + 16 *
my`) and 42 Flash (a = ticks, b = 1 nuke); they are presentation only (`apps/game/js/battlefx.js`, the audio director), and the
Reduce motion setting turns the shake off and the flash down.

### Movement models (`engine/src/movement`)

The lobby option `movement` (section 3) picks how ground units and ships
move among each other; aircraft fly over both. Both models follow the flow
fields (`engine/src/flowfield.rs`) for the way to a goal, and both keep one
invariant: no unit is ever moved, pushed or nudged onto a cell its
locomotor cannot enter (water for land units, land for ships), and a
diagonal step never cuts a blocked corner.

**`openra` (default): OpenRA's Mobile, Locomotor and Move activity**
(`movement/cellmove.rs`, `occupancy.rs`, `search.rs`).

- A unit holds the cell it stands on; while it steps to the next cell it
  holds both until it is half way, then only the new one (OpenRA
  MoveFirstHalf, MoveSecondHalf, Mobile.OccupiedCells). It drives from cell
  point to cell point and never pushes or is pushed.
- Infantry share cells (Locomotor `SharesCell`): five sub-cells, the centre
  first (OpenRA DefaultSubCell). Vehicles and ships hold the whole cell.
- Who may enter a cell is OpenRA's Locomotor.CanMoveFreelyInto with
  BlockedByActor `All`, `Stationary`, `Immovable` and `None`: allies that
  can be asked to move do not count under `Immovable`, moving units not
  under `Stationary`, and an enemy soldier a tracked vehicle may crush
  never blocks it.
- A move first searches a route around every unit, then around standing
  ones, then around those that cannot be asked to move, else it follows the
  flow field (Move.PathSearchOrder). Route searches are A* with the flow
  field's remaining path length as the estimate and OpenRA's 125 % weight
  (the straight distance for cells farther from the goal than the unit, so
  that a route never depends on how far other units extended a partial
  field); one search expands at most 4096 cells (then it counts as no
  route). WebRA addition, a safety net for huge armies: the searches of
  one tick expand at most 100,000 cells (`ROUTE_SEARCH_BUDGET`; searches
  expand about 4,000 cells a millisecond natively and 2,800 in wasm, so
  about 25 ms and 36 ms). A search asked for after that waits (the unit
  stands, a unit waiting for a blocker keeps waiting), and before units
  act in the next tick the waiting searches run, the oldest first, then
  by actor (`serve_deferred_searches`, `Motion::pending_since`), as long
  as the budget lasts; new searches only get what they leave. So no unit
  waits behind ones that asked later, whatever its place in the actor
  list, and which searches wait depends only on the game state. Normal
  games never reach the budget; the first ticks of the stress test with
  2,000 units or more do.
- When the next cell is taken (Move.PopPath): within `near` cells of the
  destination the move gives up unless a free cell next to the blocker is
  as close (player and AI move orders: 8 cells, OpenRA's `Move` order; a
  rally point 1); an enemy or a unit that cannot move ends the move; else
  the unit tells the blockers (idle allies step aside to a random free
  neighbouring cell, else toward a neighbouring idle ally that is asked in
  turn, OpenRA Nudge and GetAdjacentCell; busy ones are marked as
  blocking), waits up to the locomotor's `WaitAverage` (40 ticks), and
  then, unless the blockers are leaving, searches a way around every unit.
  Without one it backs out of the way if others wait for it, else the move
  ends. A move that ended short is over for move orders; other activities
  (repairs, docking, attacks) try again after 20 to 30 ticks (OpenRA
  MoveCooldownHelper).
- Leaving blockers (OpenRA Move.CellIsEvacuating counts units moving or
  turning in this tick). WebRA addition, queues through passes: the
  holders also count as leaving when they wait in turn for a cell further
  on whose holders leave or wait in the same way (each waiting unit
  remembers the cell it waits for, `Motion::waiting_for`), and that queue
  runs through a pass or the waiting unit's own route does within its next
  24 cells (`queue_is_moving`, `pass_cell`: along a row, a column or a
  diagonal, cells the unit may not enter close in on both sides within 4
  cells, so bridges, gaps in walls or between buildings and valleys up to
  7 cells wide). The unit then waits on instead of searching a way round
  every unit: a column ordered through a gap files through it in turn, one
  or seven cells wide. In OpenRA, and in WebRA before (which followed
  queues on cells one cell wide only), the units at the back gave up or
  drove round the map once `WaitAverage` ran out: 24 tanks ordered
  through a gap one cell wide left 11 in front of it without a way round
  and sent 10 round the map with one. A queue counts only while its head
  moves on: one that leads back to the waiting unit, runs in a circle, is
  longer than 256 cells or ends at a unit that does not move (an enemy, a
  unit that gave up, one that stands and fires) does not, so a pass an
  enemy blocks still sends the units round or makes them give up, and
  units facing each other on a bridge still wait, search, give up and
  stand still. A unit waits in a queue for at most 60 seconds without a
  step (`QUEUE_PATIENCE`, a safety net). Units that only make way (asked
  aside, scattered) count as a moving head only in a pass, and in the open
  OpenRA's rule alone holds, so a crowd around its goal, whose units the
  ones behind keep asking aside, settles as in OpenRA. A unit that started
  a step in this tick counts as leaving too (OpenRA's flag is the last
  tick's movement).
- Huge move orders (WebRA addition, orders of at least 250 units,
  `HUGE_ORDER`): a unit boxed in when its move starts, every neighbouring
  cell it may step to held, and only by friendly units about to move
  (driving, turning, waiting for their route or for a cell, or ordered and
  not yet acting; a free sub-cell beside soldiers of its own crowd does
  not count as room, see below), does not search its route yet
  (`Pending::Boxed`): it
  waits like a unit held up by a blocker (`WaitAverage`, then on while
  the queue toward its goal moves, up to `QUEUE_PATIENCE`) until a
  neighbouring cell comes free, then searches around the units that
  cannot be asked to move (`Immovable`), the route OpenRA's search order
  gives a boxed-in unit, whose searches around every unit and around
  standing ones fail at the first cell. The front of a crowd drives off
  first and the rows behind follow as cells come free, as they would
  anyway; only the route searches move from the order's first tick to the
  ticks the rows start in (34,506 searches in the first tick of the
  stress test with 20,000 units before, 31 now). A unit of a huge order
  held up in a queue that moves waits in the open too, not only in a pass
  (a huge army files after its own head). Smaller orders search at once
  and follow OpenRA's rule in the open, as before. A soldier with
  room only beside soldiers of its own crowd that are about to move counts
  as boxed in: stepping in beside them gets it nowhere yet, and counting
  that room (as OpenRA's CanEnterCell would) made the soldiers in the
  middle of the stress test's crowds (two to a cell) search at once, so
  the units at the crowds' edges, which can drive off, waited up to 44
  ticks (2,000 units) and 102 ticks (20,000) for theirs instead of 3 and
  14. Beside idle soldiers with room it is not boxed in.
- A unit that backs out of the way of others (no way round a blocker,
  Mobile.IsBlocking) and must turn first keeps the cell it backs out to on
  its route while it turns (OpenRA's Move.Tick adds it to its path before
  the Turn). WebRA forgot it after one tick of turning, so two units head
  on in a lane could wait for each other for half a minute and more: the
  one waiting saw the other turn (leaving) every WaitAverage and waited on.
- Feedback (WebRA addition; OpenRA has none: its move cursor only shows
  terrain that cannot be reached when the order is given): a move order
  that ends short because the way stayed blocked, farther from its goal
  than it may stop short (8 cells), sends the owner the audio event 49
  RouteBlocked at the unit, at most once every 250 ticks per player
  (`ROUTE_BLOCKED_INTERVAL`); the WebRA model sends it when a move gives up
  as blocked for good more than 8 cells (of path) out. The client shows
  the line "Route blocked." (at most every 10 seconds) and a yellow radar
  ping at the unit for the player who gave the order (Space jumps there).
- Half way into a cell a moving unit already looks at the cell after it
  (MoveFirstHalf.OnComplete): a route that a new structure cut is searched
  again while it drives on.
- Tracked vehicles crush enemy infantry on the cell they enter; soldiers
  about to be run over jump to a free neighbouring cell three times in four
  (Crushable.WarnProbability 75).
- Scatter is a nudge of the unit itself (OpenRA Mobile `Scatter`).
- The service depot's pad cells may be crossed but not stayed on
  (footprint `+`, OccupiedPassableTransitOnly): an idle unit on one moves
  off. Vehicles sent for repair wait their turn in the depot's line and
  drive onto the pad when called (see "Service depot line" below). Ore trucks dock the same way; an empty truck that finds no ore leaves the
  dock for a cell near four cells below it (Harvester.UnblockCell), and a
  refinery's free truck belongs to that refinery.
- A unit that other code placed (unloaded, teleported, landed from a leap)
  takes the cell it stands on; when it may not
  share it, it steps off once idle.
- Differences from OpenRA: no arcs between cells; a vehicle turns while it
  drives when the next cell is at most 45 degrees off its heading and on
  the spot for sharper turns (OpenRA turns on the spot to the exact heading
  when it starts and arcs on the way); on snow vehicles keep their slow
  acceleration but never slide off their cells. For mirror fairness there
  is no lane bias in route searches and equally good cells are taken
  nearest the goal, then the map centre; the left sub-cells sit at -256
  like the right ones at 256 (OpenRA -299) and a unit takes the free
  sub-cell nearest to it (OpenRA: the first in index order); a cell left in
  a tick is free from the next tick on, and units that want the same free
  cell in a tick get it by a rank drawn from the game seed and the tick
  (OpenRA: whoever acts first). A unit that stands still when its route
  turns bad (an enemy or a structure in its next cell) ends its move
  without the new search OpenRA makes there, whose route the end of the
  move throws away in both; one driving on searches it as in OpenRA.

**`webra`: WebRA's soft crowd separation, damped** (`movement/soft.rs`).
Overlapping units of a domain push each other apart at the end of every
tick, at most 96 world units a tick, and a moving crusher runs over enemy
soldiers it overlaps. Two standing units only make room when they overlap
by more than 16 world units, by half of it a tick and not at all below 8,
so a crowd that arrived comes to rest and then does not move. A unit
driving through a standing crowd on its way elsewhere pushes it aside; a
unit within 4 cells (of path) of its destination stops against standing
friends instead and arrives there, while one farther out pushes, so a big
group funnels through a gap. Units waiting for a refinery dock stop
within 3 cells of it; the next in line reserves the dock before it drives
on, so they come one at a time. Units in a service depot's line wait on
cells of their own (below). Units holding a pad, a dock or an ore cell, or
standing on their waiting cell in a depot's line, are never pushed.

### Service depot line (`engine/src/service.rs`)

WebRA difference (design request): OpenRA serves one unit at a time on a
service depot's pad but keeps no line. Ground units sent there together
crowd the pad and push for it (Resupply moves onto the host with
MoveCooldownHelper retries), and an aircraft cannot be sent to a depot
another aircraft has reserved (Aircraft.ResolveOrder: Reservable.IsAvailableFor,
blocked cursor). WebRA keeps a line per depot, the same in both movement
models, single player, skirmish and multiplayer:

- Who repairs where follows OpenRA RA's rules: vehicles (harvesters and the
  MCV included) and all aircraft, planes and helicopters, have
  `Repairable RepairActors: fix` (`^Vehicle`, `^Plane`, `^Helicopter`);
  ships use RepairableNear at the naval yard and sub pen and are repaired
  side by side there, without a line (as in OpenRA); infantry are not
  repaired by structures in RA (medics heal them, a captured hospital heals
  nearby infantry). A smart order (or the bulk repair order) on an own
  depot sends the selected units that can be repaired there; with nothing
  to repair (or, minelayers, to reload) the cursor is blocked (cursor 15)
  and the click does nothing (it does not select the depot, and the units
  do not reply), as OpenRA ignores the Repair order then. In a mixed
  selection the units with nothing to get there ignore it the same way and
  go on with what they were doing (an undamaged ore truck keeps
  harvesting). A damaged ore truck is sent whatever it was doing, also full
  or unloading on the refinery's dock (it lets the dock go and keeps its
  load); once repaired and off the pad it goes back to harvesting after
  the short pause WebRA gives every idle truck (units.rs
  HARVESTER_IDLE_RESUME; OpenRA's truck stays idle after Resupply until it
  gets an order).
- On its way a unit joins the line within 6 cells of the pad, or where it
  is held up on the way while the pad can still be reached. Its ticket is
  the tick it joined, ties by actor index: first come first served, the
  same order on every machine. A unit that cannot reach the pad at all
  stops.
- Ground units wait on a cell of their own: the nearest ring around the
  pad from 2 cells out first (up to 8), there the cell nearest the unit,
  never on the four corridors straight out of the pad (3 cells; the way on
  and off the pad) of this or any other depot, nor on a structure's exit
  cell or the cell in front of it, nor on a structure, nor where someone
  stands or waits. A unit that finds no free cell waits where it is and
  looks again a second later.
  Held up on the way to it they wait where they are when that is such a
  cell, else they take another. Helicopters hover over every other cell of
  the rings 4 to 10 cells out (OpenRA WaitDistanceFromResupplyBase 4c0);
  planes circle the depot within WaitDistanceFromResupplyBase.
- When the pad is free the first in line is called and reserves it
  (`dock_user`); vehicles drive onto it, helicopters land on it, planes
  glide down onto it. Something else in the way: it tries again (OpenRA
  RetryIfDestinationBlocked). Repair is OpenRA's Resupply.RepairTick: the
  StartRepairing notification at the first step, then a step every
  `Interval + 1` ticks (FIX: 8) heals HpPerStep (1000) for
  `max(1, HpPerStep * Cost * ValuePercentage / (MaxHP * 100))` (20 %);
  without the money the insufficient funds notification plays and it tries
  again two ticks later: the unit stays on the pad and the line waits, as
  in OpenRA. A minelayer also reloads its mines there before it leaves.
- Done (UnitRepaired notification), it leaves for the depot's rally point
  (OpenRA Resupply with RallyPoint: MoveTo(cell, 1)); a rally point is set
  on a selected own depot like on a factory and drawn the same way. Without
  one, ground units drive to the nearest free cell next to the depot they
  can reach without passing a standing unit, south first, out of the
  corridors and the waiting cells (OpenRA moves them just off the pad);
  helicopters hover over such a spot (OpenRA: TakeOff above the pad);
  planes take off and fly home to a free airfield, circling until one is
  free (OpenRA: TakeOff, then FlyIdle circling over the depot). Leaving frees the
  pad for the next one. While a unit holds the pad, idle own ground units
  standing on a corridor or the footprint move to such a spot too.
- A unit that no longer needs anything (healed by a mechanic) leaves the
  line and stops. When the depot is destroyed, sold or captured, everyone
  in its line stops where it is and aircraft on it take off (OpenRA
  Resupply with an invalid host). A new order takes a unit out of the line;
  a new repair order to the same depot keeps its place, and the unit on
  the pad keeps the pad (OpenRA queues the new Resupply on the same host;
  like OpenRA it starts the repair steps afresh, StartRepairing included).
  The line state stays on the unit until an order that is not a repair
  there (it is dead then: a later repair order or a repair started without
  an order takes a fresh place at the end, unless the pad is still reserved
  for it). Repairs start without an order (WebRA additions: OpenRA's
  Repairable and Aircraft need the order) for a damaged helicopter landed
  on the depot and, in the `webra` movement model only, for a damaged
  vehicle left idle on its footprint (in the `openra` model an idle unit
  moves off the pad's cells first). A Stop given to a minelayer on the pad also ends its return to
  the minefield (as a Stop ends OpenRA's LayMines). Clicking the middle of the depot while a unit stands on the pad
  targets that unit, as in OpenRA; clicking an arm of the depot gives the
  repair order.
- A minelayer out of mines with cells left to mine goes to reload in the
  depot's line like any unit sent for repair, and back to the minefield
  once full (OpenRA Rearmable, Resupply). Minelayers reload only on the pad
  they were called to (OpenRA reloads only in Resupply), and one that leaves
  the line early goes back to its minefield with the mines it has.
- Tickets, waiting cells and the pad reservation are part of the state
  hash. The lines and the waiting cells taken are gathered once a tick, so
  the work per unit follows the length of its line, not the number of
  actors. Measured on an open
  map (tests_depot_queue.rs): ten Heavy Tanks at a quarter of their hit
  points are repaired in about 140 seconds, ten Hinds in about 55, ten
  MiGs in about 56, one after another in the order they arrived.

### Combat and auto-targeting (`engine/src/combat.rs`, `engine/src/units.rs`)

Close to OpenRA, and the same for every player whatever its slot:

- **Simultaneous shots.** Hitscan weapons and Tesla bolts land when fired,
  but their damage applies after every actor has acted in that tick (with
  the delayed warheads, in `tick_projectiles`), and range checks, aiming and
  chasing read where targets stood when the tick began (`Actor.px`, `py`).
  So the actor processed first in a tick never kills its target before the
  target fires back.
- **Scan delays.** An actor that picks its own targets (idle under Defend
  and AttackAnything, on attack-move, guarding, or firing on the move) scans
  after a random 3 to 7 ticks from the shared game random, like OpenRA's
  `AutoTarget` (MinimumScanTimeInterval 3, MaximumScanTimeInterval 8); a new
  unit's first scan comes after 1 to 7. Before, a fixed 8 ticks per actor
  slot decided mirrored fights by which side's scan came first.
- **Priorities.** Under AttackAnything auto-targeting takes structures;
  under Defend and ReturnFire (also on attack-move, as in OpenRA without
  assault-move) only defences (`defense` in rules.json: Targetable `Defense`,
  OpenRA `^Defense`) among them, never other structures
  (`AutoTargetPriority@DEFAULT`). Units always come first, walls never.
- **Opportunity fire.** Turreted units (`opportunity_fire` in rules.json:
  OpenRA `AttackTurreted` with `OpportunityFire`: tanks, Ranger, Flak Truck,
  Tesla Tank, Phase Transport, turreted ships) on a plain move shoot at
  enemies in range under Defend or AttackAnything without leaving the move:
  the turret aims, the hull drives on. Infantry, artillery, V2 and the APC
  (`AttackFrontal`) hold their fire on a plain move.
- **Scan range and weapon reach.** Scans look as far as the actor's longest
  weapon reaches, anti-air weapons included (OpenRA
  `AttackBase.GetMaximumRange`): AA guns and SAM sites (air-only weapons)
  and the rocket soldier's Redeye (7.5 cells, its Dragon 5) see aircraft at
  their full range. A target counts when a weapon can hit its target class
  as it is now (`ValidTargets`: a flying aircraft only for anti-air, a
  landed one for ground weapons); scans that may not move (structures,
  Defend and ReturnFire, opportunity fire) also need such a weapon to reach
  it from where the actor stands (range, outside minimum range), while
  mobile actors under AttackAnything and on attack-move take what they see
  in scan range and close in (OpenRA `AutoTarget.AllowMove`).
- **Shots in the air.** A shot at an aircraft bursts at its height, and
  warheads measure their spread in 3D (OpenRA SpreadDamage from the impact
  position): an anti-air burst hits only what flies there, a burst on the
  ground (a crash, a jammed missile) misses aircraft overhead unless its
  spread reaches up (the Atom Bomb's does). Homing missiles keep their
  inaccuracy offset from the target and fly at most their `RangeLimit`
  (else the weapon's range, `range_limit` in rules.json): out of fuel they
  burst where they are (OpenRA Missile ExplodeWhenEmpty), so a plane can
  outrun a missile. Projectiles fly flat, so OpenRA's `Arm` delay (no
  burst before a few ticks of flight) is left out: it counts 3D flight
  time the engine does not model, and would turn close shots into duds.
- **Moving into range** (`engine/src/attack_range.rs`, OpenRA
  `MoveWithinRange`). A ground unit or ship out of range of its target
  (attack, force-fire on an actor or the ground, attack-move and guard
  fights, AI attacks), or inside its minimum range, does not head for the
  target's cell: it heads for the nearest cell, by route, from which the
  target is within range and outside minimum range (measured to the
  target's hit shape from the point the unit stands on; for infantry from
  every sub-cell), that it can enter, stay in and reach (water for ships).
  A unit in range does not move; the cell is found again when the target
  moves on (`chase_replan`), and at once when the unit stands on its cell,
  still out of range, and the target's cell changed (OpenRA repaths then). Cells another unit stands in, or another unit
  moving into range is heading for, do not count, so a row of artillery or
  ships told to fire shifts up beside its front units. Routes: in the
  OpenRA movement model around every unit, then standing ones, then those
  that cannot be asked to move (`find_path_to_cells` in
  `movement/search.rs`, OpenRA `FindPathToTargetCells`, searched backward
  from all the cells toward the unit as OpenRA does); in the WebRA model
  over the terrain, then along the flow field to the cell found.
  Differences from OpenRA: a route to a free cell may cost at most twice
  the straight way to the ring of cells in range plus ten cells. When only
  farther free cells are left, the unit drives up behind the own units
  holding the nearer ones and waits, looking again every 25 ticks
  (`Actor.range_retry`, in the state hash), instead of circling the map;
  with no such route at all (a target far round a lake) it follows the flow
  field toward the cell in range nearest it and searches again every 25
  ticks. A target with no reachable cell in range is let go (as before:
  across a river, on an island). A unit that stays in one cell for 20
  seconds while moving into range, with no own or allied unit firing at the
  same target, gives up too (`Actor.range_cell`, `range_since`, in the state
  hash): a jam that does not clear, or two units each waiting for the
  other's cell. Bot squads count a member waiting short of range as free
  and order it on, and a stuck squad's new orders leave members that fire
  at a target in reach alone (`ai_squads.rs` `busy_attack`,
  `World::attack_firing`). These searches count toward the tick's route
  search budget (`ROUTE_SEARCH_BUDGET`); once it is spent, a unit due to
  search drives on toward its old goal and searches the next tick. The cells in range of a target are worked
  out once per tick per kind of unit (`World::range_memo`).
- **Lost targets.** An attack whose target goes out of sight (or cloaks)
  keeps the target and heads for where it was last seen (`Actor.target_seen`,
  OpenRA's last visible target); seen again, it is attacked again; within
  weapon range of that spot without seeing it, the attack ends (attack-move
  resumes its way). Attacks that may not move (Defend, ReturnFire) end at
  once. An order to attack an actor the owner does not see has no spot to
  head for.
- After a clicked attack target dies, units go idle and only take on enemies
  that come into weapon range (OpenRA AutoTarget). The client's one-time tip
  points players at attack-move (`move_hint` above).

`examples/mirror_fight.rs` plays equal mirrored armies under different order
styles: `am_vs_am` (6 riflemen and 4 Medium Tanks a side) over tick shifts 0
to 3 with 25 seeds each now ends 48 against 52 wins, where every shift used
to be decided 25 of 25 by one side (75 against 25).

### Skirmish AI (`engine/src/ai.rs`, `ai_*.rs`)

Every AI slot plays one of OpenRA's Red Alert bots (`mods/ra/rules/ai.yaml`,
vendored in `data/source/rules/ai.yaml`): Rush AI, Normal AI, Turtle AI or
Naval AI. `tools/gen_rules.py` exports each bot's module configs, with the C#
defaults of every field ai.yaml leaves out, to `engine/rules.json` `bots`;
the engine ports the modules (OpenRA.Mods.Common/Traits/BotModules):

| Module | File | What it does |
|---|---|---|
| BaseBuilderBotModule | `ai_base.rs` | Building and Defense queues: power when low, refineries, extra factories above NewProductionCashThreshold, a naval yard by water, silos when full, then BuildingFractions within BuildingLimits after BuildingDelays; rally points; sells crowded or dry refineries |
| UnitBuilderBotModule | `ai_units.rs` | every 30 ticks one unit by UnitsToBuild shares, UnitLimits and UnitDelays, and what other modules ask for (ore trucks, MCVs, engineers) |
| SquadManagerBotModule | `ai_squads.rs`, `ai_fuzzy.rs` | assault squads of SquadSize plus a random bonus, rushes on enemy yards, air, naval and protection squads; AttackOrFleeFuzzy in integer math |
| HarvesterBotModule, ResourceMapBotModule | `ai_harvest.rs` | InitialHarvesters, idle trucks to the nearest ore along a path that avoids enemies, trucks from crowded fields to empty ones, trucks under fire home |
| McvExpansionManagerBotModule, McvManagerBotModule | `ai_mcv.rs` | MinimumConstructionYardCount yards: new MCVs deploy by a good ore field and ask for a refinery there; yards pack up to move (with redeployable MCVs) |
| SupportPowerBotModule | `ai_support.rs` | spy plane, paratroopers, parabombs and nuke at the most attractive spot (coarse then fine scan of the considerations) |
| BuildingRepairBotModule, PowerDownBotModule | `ai_upkeep.rs` | repair hit structures; switch PowerDownTypes off while power is short |
| MinelayerBotModule (Turtle) | `ai_mines.rs` | mine where fights were, favourite spots, halfway to the enemy |
| CaptureManagerBotModule | `ai_infantry.rs` | engineers take the most valuable capturable structures of a random enemy or neutral player |

The AI runs in lockstep on every client (OpenRA runs bots on the host only):
all randomness comes from the world RNG and all math is integer. Its state
is not part of `state_hash`; saves and replays replay the orders.

**Difficulty.** OpenRA has none: in 2014 it renamed its Easy and Hard AI to
Rush and Turtle AI "as they are identical" (commit 2320a7d571), so a bot
type is a personality. WebRA keeps Easy, Normal and Hard as a strength on
top of any bot type (`Difficulty` in `ai_bots.rs`): Normal is OpenRA's
timing; Hard reacts in two thirds of the time (production checks, role
and squad updates, harvester scans, power down and capture intervals; the
personality timings BuildingDelays, UnitDelays, RushInterval,
MinimumAttackForceDelay and MoveConyardTick stay as they are); Easy waits
twice as long, plays with an extra 25 % handicap (OpenRA's handicap, on top
of the slot's) and leaves the Iron Curtain, Chronosphere and Sonar Pulse
alone. Reacting slower alone did not weaken a bot: Normal AI at Easy timing
won 8 of 16 against Normal; with the handicap 5 of 16. Settings from before
bot types (`difficulty` only) play the Normal AI at that difficulty.

**Differences from OpenRA**, all to make AI-only games end and keep the
engine's rules:

- Like most skirmish AIs, the bots know where enemy structures are (squads,
  support powers), and hunt the last units of a player without structures,
  aircraft included. OpenRA's squads only see what is visible.
- Ground squads attack-move onto structures, not to the edge of their
  weapon range: the engine's units only auto-target what they see.
- A squad whose leader can hit nothing (Tanya among structures, anti-air
  only aircraft left) takes another unit as leader. After a squad fled from
  a player's actors, squads prefer other enemies for three minutes.
- Fuzzy attack-or-flee: against enemies that cannot shoot back a squad
  always attacks.
- Stalemate breaker: units at the base that stopped growing for two minutes
  (from minute 10) leave below SquadSize, at least 4 (any number once the
  bot earns nothing); bots that attack at any time (MinimumAttackForceDelay
  below five minutes, all but Turtle AI) also send them after five minutes
  without an attack force.
- Air squads look for targets over the whole map and skip flight paths with
  heavy enemy anti-air (OpenRA's grid misses the map edges, and its check
  skips the safe paths and counts own anti-air too); they fly to structures
  under the fog before attacking.
- No refineries while no ore is in reach; while broke and earning nothing
  (`ai_economy.rs`) only the power, the first refinery and a factory the
  army needs, unit production below ProductionMinCashRequirement, and
  surplus structures sold for an army or a refinery.
- Placement: structures spiral out from the base centre (mirrored for bases
  in the right half), refineries go where the dock is nearest to ore,
  defences use OpenRA's ordering toward the nearest enemy with mirrored
  ties.
- The ResourceMap recounts friendly units on every update (OpenRA only adds).
- MCVs remember their spot and deploy on arrival (no queued deploy). A
  resource square without ore is never an expansion target: OpenRA's
  resource centre of such a square is CPos.Zero, outside every map's
  bounds, so no path leads there; WebRA's maps have a corner cell (0, 0).
  A yard waits with packing up while a refinery is queued, as OpenRA
  intends (its check looks at the yard's own queues, and RA's queues
  belong to the player, so it never holds there).
- The Iron Curtain (on the army in a fight), Chronosphere (idle vehicles
  into the enemy base) and Sonar Pulse (where an unseen attacker hit a ship)
  are WebRA additions: OpenRA's bots have no decisions for them. The GPS
  Satellite launches by itself.
- Capturing: RA's bots lost the capture module in 2016 (7e6488c522); WebRA
  keeps it with OpenRA's defaults and trains up to two engineers while a
  neutral structure worth taking is in reach. Targets rank by
  `capture_value`, read from traits: sell value, plus that again per lasting
  benefit (support powers, production, radar, storage, power), GivesCash
  OnCapture, five minutes of CashTrickler income (oil derricks) and 1000 for
  a hospital.
- Allies: an attack on an ally's structure, ore truck or MCV calls the
  bot's protection squad too.
- Fleets (`ai_naval.rs`, `ai_squads.rs`): OpenRA's bots build naval yards
  wherever the base has water and ships by their UnitsToBuild shares, and
  put every ship into one naval squad that scans for enemies around the
  point its leader aims at; with a Cruiser or Missile Submarine leading
  (20 cell range) that point is 20 cells from the target, the scan finds
  nothing and the fleet never sets out, and on a lake or a river stretch
  between fords it idles for good while it keeps growing (Turtle AI fleets
  of 37 and 41 ships that never fired in 1v1s on generated maps,
  `examples/naval_probe.rs`). WebRA's bots build naval yards
  and warships only for water from which a warship can hit an enemy
  structure or ship (within its sight after the weather, less a cell, when
  the target is out of sight: units only fire at what their owner sees),
  put the yard's rally
  point on that water and make that yard primary; keep one naval squad per
  body of water; scan around the target itself; send each ship to a point
  from which it sees the target and order ships to attack a target they see
  directly (bots' Missile Submarines are on ReturnFire, and attack moves
  below AttackAnything skip most structures); do not order firing ships on
  or count them stuck; leave a target alone for two minutes when the fleet
  stood where it should see it and did not (fog or a Gap Generator's
  shroud; a diving submarine's cloak does not count); fall back to
  a naval yard on their own water when fleeing; and let the ship nearest an
  attacker of the base decide whether the fleet can answer it. Ships left
  on water with nothing in reach stay there as a defensive fleet, as in
  OpenRA. A Transport (in OpenRA's NavalUnitsTypes) joins the fleet of the
  water it floats on or beaches next to. Ground squads keep OpenRA's
  behaviour.

**Measurements** (`examples/bot_matrix.rs -- 16 90`, 16 seeds per pairing,
1v1 on generated 80 maps of random style with the standard tech buildings,
each bot on both spawns, Normal difficulty, 90 minutes at most; wins of the
first bot listed, then of the second, and game lengths in minutes), with the
OpenRA movement model (the default) and with the WebRA model
(`AI_MOVEMENT=webra`):

| Pairing | OpenRA: wins | unfinished | mean | median | longest | WebRA: wins | unfinished | mean | median | longest |
|---|---|---|---|---|---|---|---|---|---|---|
| Rush vs Rush | 11-5 | 0 | 17.9 | 16.0 | 45.3 | 7-9 | 0 | 14.0 | 12.9 | 31.3 |
| Rush vs Normal | 7-9 | 0 | 20.0 | 18.1 | 48.8 | 7-9 | 0 | 17.3 | 18.7 | 32.5 |
| Rush vs Turtle | 15-1 | 0 | 22.5 | 21.7 | 41.7 | 12-4 | 0 | 21.2 | 18.6 | 60.8 |
| Rush vs Naval | 16-0 | 0 | 11.3 | 7.8 | 65.0 | 15-1 | 0 | 9.2 | 9.2 | 17.8 |
| Normal vs Normal | 8-8 | 0 | 24.9 | 24.0 | 52.2 | 9-7 | 0 | 19.3 | 20.0 | 33.1 |
| Normal vs Turtle | 7-9 | 0 | 34.2 | 33.8 | 66.9 | 8-8 | 0 | 36.3 | 31.0 | 70.7 |
| Normal vs Naval | 15-0 | 1 (seed 6, rivers) | 13.0 | 12.7 | 22.5 | 15-1 | 0 | 14.0 | 12.7 | 24.1 |
| Turtle vs Turtle | 8-8 | 0 | 48.5 | 49.0 | 83.9 | 7-9 | 0 | 50.1 | 51.1 | 82.3 |
| Turtle vs Naval | 12-4 | 0 | 36.8 | 29.1 | 88.5 | 8-8 | 0 | 36.4 | 35.1 | 78.7 |
| Naval vs Naval | 8-8 | 0 | 14.1 | 12.1 | 30.0 | 8-8 | 0 | 13.0 | 13.8 | 18.9 |

Land games last a few minutes longer with OpenRA movement: an attack wave
drives one unit per cell (five soldiers) and a squad that regroups waits for
its stragglers to come through the crowd instead of shoving it aside, so
waves arrive more strung out and a defence holds a little longer.

A Turtle AI can make a game outlast an hour and a half: Turtle AI forms
an attack force at most every 100000 ticks (MinimumAttackForceDelay, about
67 minutes, the first at a random time) and the stalemate breaker only
sends its units once they stop growing. Difficulty (Normal AI against
Normal AI, same setup): Easy against Normal 5-11, Normal against Hard 7-9,
Easy against Hard 3-13 (difficulty and the free for alls below were
measured before the movement models, with what is now the WebRA model).
Four player free for alls on 96 maps (the engine's whole-game tests) end
after 20 to 66 minutes, 2v2s after 9 to 49. `ai_vs_ai -- 3` (an hour at
most) ends after 20:08 with the OpenRA model and 16:03 with the WebRA model.

**Base spread.** OpenRA's Rush, Normal and Turtle AI (McvExpansionManager,
since 2025) keep MinimumConstructionYardCount 2 yards and found bases over
the whole map: after every factory, tech structure or refinery placed while
refineries lag behind factories plus tech structures (ExpansionTolerate, less
cash / PerExpansionTolerateOnCash), and every MoveConyardTick (3.8 minutes,
Turtle 5.3) anyway, a yard packs up (with the "Redeployable MCVs" option, on
by default in OpenRA and WebRA) and drives to the ore square scoring best
(CRmodeFriendlyConyardDislikeRange and the refinery range: 14 cells from
its own yards and refineries), asking for a refinery there. The old
structures stay. WebRA matches this (`examples/base_spread.rs`, Normal
against Normal, 20 minutes in: 9 to 10 yard sites and 4 to 8 clusters of
structures on an 80 or 128 land map; with the option off 2 sites and 1 to 2
clusters). Only OpenRA's releases up to 2025 (McvManagerBotModule, one yard)
stay compact.

### Skirmish AI target choice (`engine/src/ai.rs`)

In free for alls each AI attacks one enemy player at a time. Candidates are
the live enemies whose base is within 8 cells of the nearest one, measured to
the starting yard while the player has structures (an expansion does not
bring a base nearer), else to its nearest unit. They are ranked by:

1. a grudge: the player damaged one of this AI's structures in the last two
   minutes;
2. fewest other AIs already attacking it (AIs on the same team excepted:
   teammates attack their leader's target on purpose);
3. a seeded tie break: the next base around the map centre in a direction
   picked by the game seed (on a ring each AI then takes a different
   neighbour), then a seeded hash;
4. strength (armed units and defences by cost), weakest first; it only
   decides exact ties.

Every minute the AI reconsiders, but keeps its current target unless the
best candidate is clearly better (a grudge where the current one has none,
or fewer attackers). `examples/target_sweep.rs` measures the result: 8-player
games (6 seeds, each slot once a passive Easy AI that never attacks, like a
human who turtles, 20 minutes) count how often a player in the game is the
target of two or more AIs. While all eight are in, the passive slot now has
two attackers in 0.8 % of samples against 7.8 % for the others (was 14 % and
22 %); over whole games 20 % against 10 % (was 30 % and 21 %): late in a game
the turtling slot is often the last near enemy of the AIs left.

### Veterancy and prone infantry (`engine/src/veterancy.rs`)

Kills give the killer the victim's value as experience (OpenRA
`GivesExperience`, `GainsExperience`); levels at 2, 4, 8 and 16 times the
unit's own cost, level 4 elite, with RA's firepower, damage, speed and reload
bonuses and elite self repair. Soldiers hit by a `TriggerProne` warhead lie
prone (`TakeCover`): half damage from `Prone50Percent` warheads, half speed,
for 50 ticks after the last hit. rules.json carries the values per actor
(`experience`: `thresholds` and per-level `firepower`, `damage`, `speed`,
`reload` percentages and `heal`; `gives_experience`; `take_cover`) and per
warhead (`damage_types`); modded maps can tune them within
`Rules::validate`'s bounds. `Game.actor_json` reports `rank` (0 rookie),
`maxRank`, `xp` and `nextXp` (value points: $100 of kills is 100) and
`prone`. The sidebar cameo of a unit that will come out with a level shows
OpenRA's ProductionIconOverlayManager chevron (player.yaml Type Veterancy,
iconchevrons veteran, an OpenRA-made sprite, so it is WebRA's own shape in
both art sets) at its top left: rules.json `production_overlays` (per actor,
`WithProductionIconOverlay` `types` and `prerequisites`, only types the
player's managers draw) and `player_json` `buildable[].overlays` (the types
whose prerequisites the player has, `World::production_overlays`;
presentation only). Sprites: a ranked unit gets a rank decoration
(`SpriteIds::veterancy_base` + 0..2 chevrons, + 3 elite,
apps/game/js/art/veterancy.js); infantry have no turret, so their sprite
`2t + 1` is the prone pose.

### Infantry (`engine/src/infantry.rs`, `infantry_combat.rs`, `dog.rs`)

Every Red Alert soldier of OpenRA's infantry.yaml: E1 to E4, E6 (engineer),
E7 (Tanya), DOG, MEDI, MECH, SPY and SPY.England, THF and SHOK. rules.json
carries per actor `producible_level` (ProducibleWithLevel), `fire_delays`
(Armament.FireDelay per weapon slot), `targets_allies` (healers), `death`
(WithDeathAnimation: death sequence per damage type), `infiltrate_types`
and `disguisable`, and abilities `captures`, `capturable`,
`instantly_repairs`, `instantly_repairable`, `repairs_bridges`,
`infiltrates`, `infiltrated` (InfiltrateFor* effects: cash, exploration,
power_outage, support_power, power_reset, decoration, transform),
`disguise`, `ignores_disguise`, `demolition`, `demolishable`, `attack_leap`,
`announce_on_kill` and, on proxy actors (kind `proxy`, never on a map),
`proxy`. Proxies are granted per player (`Player::proxies`) for their
prerequisites and support powers (the Sonar Pulse, a `SpawnActorPower`).
Buildable.BuildLimit (Tanya) is the shared `build_limit` (production.rs
`build_limit_left`). Heal and repair warheads target the bits 2048 (`Heal`)
and 4096 (`Repair`).

Right clicks (`Game.cursor_action`, world.rs `SmartAction`): 8 capture, 9
infiltrate, 10 C4, 11 engineer repair (structures and bridge huts), 12 heal,
13 mechanic repair, 14 disguise, 15 blocked enter, 16 blocked engineer
repair (undamaged), 17 capture from outside (reusable engineers, the lobby
option `reusableEngineers`: OpenRA's Captures@REUSABLE), 18 blocked move
(explored terrain none of the units' locomotors can enter, OpenRA
MoveOrderTargeter `move-blocked`; the order is still a move). They go through the
`Smart` order: no new order kinds. A forced attack of Tanya on a structure
plants C4. `Game.actor_json` adds `disguise` (`{type, owner}` or null; only
the owner and allies should be shown the spy behind it), `beingCaptured`,
`demolished` and `powerOutage` (ticks left).

For the world objects: anything with `abilities.capturable` can be captured
(`World::can_capture`, `World::capture(target, new_owner, captor)`); a
captured husk becomes its vehicle again for the captor (husks.rs
`restore_husk`, TransformOnCapture), and the mechanic's infiltration repairs
an allied husk (InfiltrateForTransform). A capture of a neutral or tech
building gets its effects through `World::after_capture` (neutral.rs:
GivesCashOnCapture with its cash tick; derricks, the hospital and the
prerequisites follow the owner). Engineers enter a bridge hut while
`World::can_repair_bridge_at_hut` holds and start the repair with
`World::repair_bridge_at_hut(hut, owner)` (bridges.rs).

Audio: the `Death` event's `b` is the kind code with the death sequence
(1..6 die1..die6, 7 crushed) in the bits above 8. Captures and stolen
vehicles send `Captured` (33), infiltrations `Infiltrated` (34), and a kill
Tanya announces `KillAnnounced` (43, `a` the killer's type, to its owner).
Sprites: `SpriteIds::infantry_base` + 0..4 built-in dying soldiers (shot,
blown up, burned, electrocuted, crushed), 5 spy tag, 6 fake tag, 7 sonar
ring (apps/game/js/art/infantry.js). The fake tag shows over every fake
structure (rules `building.fake_tag`, OpenRA ^FakeBuilding
WithDecoration@fake) to its owner, allies and spectators, selected or not;
an enemy sees it only on a selected fake one of its (or an ally's) spies
infiltrated (InfiltrateForDecoration). The build palette marks fakes too:
`FAKE_ACTORS` (js/content/tables.js) get the FAKE mark across WebRA's cameo
(js/art/cameo.js `paintFakeMark`), and with the original graphics Red
Alert's own fake cameo where it has one (dome, construction yard, naval
yard, sub pen, war factory), else the real cameo with the same mark
(ACTOR_ART `fakeMark`: the fakes whose cameo OpenRA drew itself).

### Make animations (`engine/src/world.rs` `make_until`, `combat.rs` `build_incomplete`)

OpenRA's WithMakeAnimation grants a structure the `build-incomplete`
condition while its `make` sequence plays once, and Red Alert's rules
switch traits off with it. In WebRA a structure that is placed, deployed
from an MCV or created by a mission script (`Actor.Create`, also in
WorldLoaded at tick 0: OpenRA adds no SkipMakeAnimsInit there) is being
built from the tick it appeared through `building.make_ticks` ticks after
it (`make_until`, `World::begin_make`, in the state hash; the map's own
actors, the starting base and a mission's SpawnActorOnDeath skip it, like
OpenRA's SkipMakeAnimsInit).
Meanwhile its `building.make_gates` are off: `sell` (Sellable: no sell
order, `sell_value` 0), `capture` (Capturable), `attack` (AttackTurreted,
AttackTesla, AttackGarrisoned paused and Turreted off: it neither aims nor
fires and keeps its target) and `transform` (the Construction Yard does not
pack up). `make_ticks` is the frame count of the structure's make sequence
at one frame per tick (every RA make sequence is `Length: *` at Tick 40);
`tools/gen_rules.py` `MAKE_FRAMES` holds the counts with their sources,
read once from Red Alert's files (and OpenRA's own `mods/ra/bits`, which
override files of the same name) by `node tools/make-frames.mjs <files>`
(it prints file names and frame counts only). The tileset variants have
the same counts, so the time does not depend on the map.

Selling (OpenRA Sellable.Sell, then the Sell activity): the sell order
plays the sell sound at once (`Sold` event, b = -1), then the make animation
backwards: from the order's tick the structure is `build-incomplete` again
for `make_ticks` ticks (`unmake_at` with `unmake_sell`, in the state hash;
no second sale, no capture, no pack-up, its attacks paused), and in the
tick `make_ticks` after the order it is sold: the refund for its health at
that moment (`World::sell_refund`'s RefundPercent of the sell value), paid,
counted and announced for the player who owned it when the sale started
(`unmake_seller`, OpenRA's Sell activity keeps that player's resources),
the crew walking out (SpawnActorsOnSell), the script's Sold event and the
announcement (`Sold`, b = the refund, for the cash tick); then it is gone.
Destroyed meanwhile, it brings nothing. A structure without a make
animation (walls) is sold at once (both events). `sell_value` is -1 during
the sale (no sell cursor, no refund line). WebRA removes it exactly
`make_ticks` ticks after the order; OpenRA takes one or two ticks more (the
reverse animation's callback queues the Sell activity, which runs on the
actor's next tick, and the reversed make condition is revoked in a frame
end task); packing up likewise.

Packing up (OpenRA Transform on the Construction Yard): the pack-up order
plays the make animation backwards first. From the order's tick the yard
is `build-incomplete` again for `make_ticks` ticks (`unmake_at`, in the
state hash; no selling, no capture, no second pack-up: the activity cannot
be interrupted), and in the tick `make_ticks` after the order it turns into
the MCV (production.rs `tick_pack_up`). Should the MCV no longer fit then,
or C4 tick on the yard, it plays its make animation forwards again (the
make pose from that tick) and stays, silently (OpenRA
Transform.DoTransform). A pack-up order is ignored without a word while
the yard cannot pack up (OpenRA Transforms PauseOnCondition
being-captured, being-demolished, build-incomplete; WebRA has no chrono
vortex): it is not remembered for later (TransformsIntoTransforms only
queues a deploy behind a pack-up that already runs). Only a yard whose MCV
would not fit reports a blocked deploy. Not modelled: the ConyardChronoReturn of a chronoshifted MCV,
and TransformsIntoTransforms (a deploy order for the coming MCV queued
behind a pack-up that runs).

### Pilots (`engine/src/plane.rs` `eject_pilot`)

OpenRA EjectOnDeath (rules `abilities.eject_on_death {pilot, success_rate,
in_air, on_ground, allow_unsuitable_cell}`, every RA plane and helicopter
but the Badger): when such an actor dies, unless its owner is defeated or it
is off the map, `rng.range(0, 100) < success_rate` (the shared simulation
random numbers, so it is in the state hash through the pilot) decides
whether its pilot (E1) comes out at its position. In the air the pilot falls
by parachute from the aircraft's height and dies where it cannot stand
(water, structures); at ground level only with `on_ground` (false in RA).
Without `allow_unsuitable_cell` (true in RA) no pilot comes out over a cell
infantry cannot enter. A plane that starts to fall decides when it is hit,
not again where it crashes.

### Helicopters (`engine/src/helicopter.rs`)

Built at the Helipad (HPAD) and start landed on it. VTOL: take off and land
vertically, hover in place when idle, turn in place, slide toward their goal.
Landed aircraft (altitude 0) count as vehicles for targeting (OpenRA
`Targetable@GROUND`), so anti-air cannot hit them and ground weapons can.
Idle armed helicopters hold fire (OpenRA `InitialStance: HoldFire`) and only
engage on attack-move or an attack order. Rounds are spent per shot; an empty
helicopter reserves a free helipad (one per pad), lands, reloads
`reload_count` rounds every `reload_delay` ticks (OpenRA AmmoPool) and takes
off again. Helicopters and planes out of ammo follow OpenRA's FlyAttack and
AttackAircraft `AbortOnResupply` (rules.json `aircraft.abort_on_resupply`).
WebRA deviates on purpose (the owner's choice): the default is false for every
aircraft, where OpenRA's is true and no Red Alert rule changes it. So an
aircraft out of ammo always rearms and then takes the attack up again once
full, heading for where the target was last seen when the base does not see
it; a dead target leaves it waiting at the base. A new order given meanwhile
replaces that attack. A map's rules that set `AbortOnResupply: true` get
OpenRA's behaviour: the attack and the orders queued after it end while
they rearm, and they wait at the base (or hover after `TakeOffOnResupply`)
for a new order. On an attack-move they never resupply: the attack ends,
the move goes on, and an aircraft with an empty AmmoPool picks no targets. Damaged helicopters and planes land on the service depot to be repaired, in turn ("Service depot line").
Shot down in the air they fall and explode on impact.

Orders (`Order` in engine/src/world.rs, validated by `packages/protocol`):
`{"o": "land", ids, x, y}` lands on or next to a cell (on an own helipad or
service depot: reload or repair there), `{"o": "return_to_base", ids}` flies
to a free helipad (a full helicopter only waits near the base), `deploy`
lands where the helicopter hovers or takes off again. A smart order on an own
helipad docks (cursor 4), on an own service depot repairs (cursor 5). Engine
API: `Game.order_land(player, ids, x, y)`, `Game.order_return_to_base(player,
ids)`; `actor_json` reports `ammo`, `maxAmmo` and `landed`.

Deliberate deviations from OpenRA (the `OVERRIDES` table in
`tools/gen_rules.py`):

- The Helipad is buildable by both sides (OpenRA: Allies only), as in classic
  Red Alert (1996), where the Soviets fly the Hind from it.
- The Hind is enabled for the Soviets (OpenRA: `~disabled`).
- The Black Hawk requires `structures.allies`, so it stays Allied as in
  OpenRA; the Chinook is available to both sides, as in classic Red Alert.

The Chinook is a transport (cargo.rs): infantry board it only while it is
landed (Deploy on the empty Chinook lands it); Deploy on a loaded Chinook
lands it on or next to its spot, unloads and takes off again. Passengers die
when it is shot down.

Not modelled: landed helicopters do not block ground units' paths.

Aircraft are targeted by their state: airborne ones are `air`, landed ones
count as `vehicle` (OpenRA `Targetable@AIRBORNE` / `Targetable@GROUND`).

Support powers (engine/src/powers.rs, API documented at the top of that
file): one timer per player per power key (the OpenRA trait name, e.g.
`AirstrikePower@spyplane`), however many structures provide it. Order
`{"o": "support_power", player, key, x, y, x2?, y2?}` (world units; the
optional second point gives aircraft powers their flight direction; the
engine leaves it out when there is none, and `null` counts as left out), wasm
`Game.activate_power(player, key, x, y, x2?, y2?)` (world pixels), and
`player_json(p).powers`: `[{ key, kind, name, description, progress (0..1),
ready, charging, remainingTicks }]`. Superweapons (engine/src/abilities.rs):
`ChronoshiftPower` takes the destination as (x, y) and the source area as
(x2, y2) (both required; units whose target cell they cannot enter, ships
over land, stay); when the Duration runs out a unit goes back to its origin,
or to the nearest explored cell it can enter if the origin closed meanwhile
(a naval yard went up there), and dies when there is none (OpenRA Teleport
killOnFailure), `GrantExternalConditionPower` (Iron Curtain) and
`NukePower` take the target as (x, y) (the atom bomb flies like OpenRA's
NukeLaunch: the silo plays its activation animation at the order, the
missile leaves `missile_delay + 1` ticks after it from the silo's centre
plus `spawn_offset` (forward, right, up through LocalToWorld: right, minus
sin 40 degrees times forward), climbs `flight_velocity` per tick for half
of `flight_delay`, turns `flight_velocity * flight_delay / 2` over the
target and falls as fast, and goes off `flight_delay` ticks after leaving;
`Nuke::position` gives its point and height per tick; the camera over the
target opens `flight_delay - camera_spawn_advance + 1` ticks after the
order for `camera_spawn_advance + camera_remove_delay` ticks, and the
target beacon shows until `flight_delay - beacon_remove_advance` ticks
after it (OpenRA's Beacon only removes itself for a positive duration: with
an advance of `flight_delay` or more it stays, in WebRA while the missile
flies); drawn with fx specials 4 and 5, OpenRA's `atomic` image `up` and
`down` with the original graphics), `GpsPower` launches by itself when
charged and is `OneShot` (it disappears from `powers` after launch). A
power charges for its `charge` ticks (OpenRA ChargeInterval) from empty, or
starts ready when its `start_fully_charged` is set (OpenRA
StartFullyCharged; no built-in power has it, map rules may set it), which
applies only when a provider creates the player's instance. As in OpenRA's
SupportPowerManager, a power whose `prerequisites` go missing leaves the
power bar and resets to a full charge but its instance stays (also after
its last provider is lost), so rebuilding the prerequisite charges it from
empty; an instance whose prerequisites are met goes with its last
provider. The
client starts targeting with `Input.startPowerTargeting(key, kind)`.

Support power timers (OpenRA `SupportPowerTimerWidget`, the
`SupportPowerTimer@SUPPORT_POWER_TIMER` of mods/ra/chrome/ingame-player.yaml;
engine `World::power_timers`, apps/game/js/powertimers.js): wasm
`Game.power_timers_json(viewer)` lists `[{ player, key, name, remainingTicks,
ready }]`, the countdowns `viewer` may see: every power whose
`display_timer` (rules.json, from `DisplayTimerRelationships`; empty, the
OpenRA default `None`, shows nobody, not even the owner) holds the owner's
relationship to the viewer (`World::relationship`: the owner and its team are
`ally`, hostile players `enemy`, the rest `neutral`). A negative viewer sees
every power that shows to anyone. In Red Alert only `NukePower` and `GpsPower`
show (to everyone); the missions soviet-13a and soviet-13b (GPS: Ally),
allies-10a and situation-critical (the enemy silo: Neutral, so hidden)
override it. A power
is listed from its first provider until its owner loses the last one, also
while paused by low power or a power down (the clock stops, `ready` is
false), not after a one-shot power fired (GPS), and never for a defeated or
non-combatant owner. `ready` is OpenRA's `Ready`: charged and charging. Order:
by player, then the owner's power bar order (palette order; OpenRA keeps the
order the powers were first acquired in). The client shows one line per timer
right of the power bar (the top-left HUD column, index.html `#hud-stack`:
the status line, the weather badge, the mission objectives when open, then
the power bar and the timers side by side, all in one flow so none overlaps
another at any size), "<player>'s <power>: m:ss" (mods/ra/fluent/ra.ftl
`support-power-timer`, `WidgetUtils.FormatTime` without a leading minute zero
at the game speed's tick length), Bold 14 with a one pixel contrast shadow,
in the owner's colour (relationship colours when that setting is on), white
for 25 of every 50 ticks once ready. Like OpenRA's Red Alert, only players
see the list: spectators, replays and a defeated player who watches on get
the observer panel (its Support powers view lists every player's powers)
instead, since mods/ra/chrome/ingame-observer.yaml has no timer. There is no
setting for it in OpenRA, so none here. The notifications that go with the
same powers were already in place (js/audio/director.js `powerActivated`,
OpenRA `SupportPower.PlayLaunchSounds`): "A-bomb launch detected" for every
player not allied to the silo's owner, "Satellite launched" to the owner and
allies; RA defines no `DetectedSound` or `DetectedSpeechNotification`.

Unit abilities (engine/src/abilities.rs): orders `{"o": "lay_mines", player,
ids, x0, y0, x1, y1}` (cells, at most 32 * 32 cells) and `{"o": "teleport",
player, ids, x, y}` (world units); `deploy` also lays a mine, deploys a MAD
tank or detonates a demolition truck. Wasm: `order_lay_mines`,
`order_teleport`, `teleport_valid`, `ability_deploy_state` (0 none, 1 now, 2
not now, 3 needs a target), `has_minelayer`; `actor_json(id).ability` holds
`{ ammo, maxAmmo, charge, chargeMax, maxDistance, cloaked, deployed,
detonatesIn, payload }` (only the fields that apply). Smart action 7 is
"deliver cash" (supply truck onto an own or allied structure). Mines are
actors of kind `mine` (`MINV`, `MINP`).

A minefield follows OpenRA's Minelayer and LayMines. The order keeps the
rectangle's cells of a terrain the Minelayer mines that its owner has
explored (not under a Gap Generator's shroud either; bots too, so a bot
mines nothing in the shroud) and the Minelayer can drive onto and stop on.
While it works, a cell goes for good (CleanMineField) once a mine its
owner sees lies there, or once its owner sees the Minelayer cannot get
onto it (Locomotor.IsBlockedBy with BlockedByActor.Immovable): a
structure, a husk, blocking terrain, an enemy vehicle or ship, or a landed
aircraft (aircraft have no Mobile to move away). A cell with a unit of
its own side, enemy infantry (its tracks crush infantry, as WebRA's
movement does too), a crate it crushes or anything under the fog stays:
the Minelayer skips it
while a mine cannot go there now (CanLayMine: nothing but itself in the
ActorMap, `occupies_cell` for units) and comes back once it is free. When
no cell left can take a mine now, the Minelayer stops, as OpenRA's
activity ends. Deploying lays a mine under the Minelayer only when one can
go there now.

Debug menu (engine/src/debug.rs, apps/game/js/debug.js, opened with the `
key or the Debug button). Cheats are orders, so online they go through
lockstep: `{"o": "dev_flag", player, flag, on}` with `flag` one of
`fast_build`, `build_anywhere`, `unlimited_power`, `fast_charge`,
`disable_shroud`, `all_tech` (per player); `{"o": "dev_cash", player}` (adds
20000, cash capped at 100000000); `{"o": "dev_kill", player, ids}` (destroys
actors of any owner); `{"o": "dev_experience", player, ids}` (one more
veterancy level for each of the player's own listed units). The engine ignores them unless the game options have
`cheats: true`, and the server drops a client that sends one in a game
without it. Wasm: `cheats_enabled`, `dev_flag(player, flag, on)`,
`dev_give_cash`, `dev_kill`, `dev_experience`; `player_json(p)` has `cheats` and `dev` (the
flags). Read-only views: `debug_cells(player, x0, y0, x1, y1)` (`[x0, y0, w,
h, flags...]`, bits in debug.rs `cell`), `debug_flow(player, id, ...)`
(`[goalX, goalY, x0, y0, w, h, dir...]`, the flow field an own moving unit
follows), `debug_actors(player, ...)` (JSON: ids, health, footprints, weapon
ranges, targets) and `debug_stats()`; they only report explored cells and
visible actors and never change the simulation.

Radar minimap (engine/src/minimap.rs, apps/game/js/minimap.js). Read-only
wasm calls, made a few times per second: `radar_state(player)` (0 no radar
structure, 1 online, 2 jammed, 3 low power) and `minimap_blips(player)`
(`Int32Array` of `[cellX, cellY, width, height, owner]` per blip, owner 255
for neutral; structures first, then units). The radar is online while the
player owns a powered `ProvidesRadar` structure (the Radar Dome) with no
enemy radar jammer (`jams_radar`, OpenRA `ProximityExternalCondition@JAMMER`,
18c0) in range. Blips are empty while it is offline; enemy actors appear only
while visible and not cloaked, enemy structures also as remembered ghosts,
and nothing hostile within range of an enemy jammer. Terrain and fog come
from `terrain_ptr` and `fog_ptr`.

Radar input is client side and adds no order kinds (OpenRA RadarWidget): a
left click on the radar is a click on that world spot (`Input.radarClick`),
so it goes through the same order generators as the battlefield (support
powers, sidebar modes, ability targeting, the command bar, minefields,
attack move, `order_smart`, rally points) and the same `ui` game handle
(unit replies, target lines; spectators' handles drop orders). Buttons, as
OpenRA's `RadarWidget.HandleMouseInput`: a press of the order generator's
`ActionButton` fakes a click on the world there, any other button centres
the view there and drags it while held (`isMinimapMoving`). OpenRA's
ActionButton is left in its Classic mouse style and right in Modern;
WebRA has only the Classic style (the battlefield orders with the left
button, the right one cancels or deselects), so on the radar:
- Left: the order the cursor shows for that spot (Shift, Ctrl, Alt and
  the command bar as on the battlefield). A left click that is no order
  there (nothing selected, an own unit, deploy, placement, spectators)
  moves the camera and drags it while held (a WebRA addition: OpenRA's
  Classic radar would select there); a left press that gave an order does
  not drag.
- Right and middle: move the camera there and drag it while held, never an
  order, also with units selected or a sidebar mode, support power or
  attack move on (they stay on). Back and forward buttons do nothing.

The radar cursor is `Input.radarCursor` (the battlefield's cursor for a
left click on that cell, in the original cursors' `-minimap` variant when
installed). Touch: a tap with units selected or a mode on gives the order
(`TouchControls.radarTap`, with Add and Force); a drag, or any touch with
nothing to order, moves the camera.

Edge scrolling is client side too (`js/input.js` `edgeDirection`,
`edgeScrollAllowed`; OpenRA `ViewportControllerWidget.CheckForDirections`).
The zone is measured against the window, not the battlefield canvas: the
mouse's window position comes from every mouse event on the page
(`Input.windowMouse`), so the edge scrolls whatever is under it, the
sidebar, radar, HUD buttons and chat included, and clicks there still work.
The zone is `EDGE` (12) CSS px on each side, a deliberate difference from
OpenRA's `ViewportEdgeScrollMargin` of 5: a browser window that is not
maximised lets the mouse leave, and a quick move skips a narrow zone. It
covers the rightmost 12 px of the sidebar buttons, which still take clicks.
While it scrolls the whole page shows the scroll arrow (`html.edge-scroll`,
css/style.css); OpenRA keeps the widget's own cursor off the battlefield,
WebRA follows Red Alert there. It holds while the speed setting is 0, the
mouse is outside the window (browsers report no position there, so leaving
the window, even through an edge, stops it; a maximised or fullscreen window
has its edge at the screen's, and mouse capture keeps the pointer inside),
the window has no input focus (as OpenRA), for a touch (a finger or pen
leaves no position: the mouse-like events js/touch.js feeds in carry
`pointerType: 'touch'`, and the browser's compatibility mouse events after a
pointer event of a finger are ignored until a mouse moves again,
`Input.notePointerType`), while the game menu, end of game, statistics or a
modal dialog is open, during a box selection, repair box, middle button pan
or radar drag, while a text field has the focus (the chat line), and while
the mouse is released with the release hotkey (`MouseCapture.isDetached`,
where it exists). The map editor has no edge scrolling.

Command bar (engine/src/commands.rs, apps/game/js/commandbar.js): orders
`{"o": "attack_ground", player, ids, x, y}` (force-fire on the ground until
told otherwise; weapons need the `Ground` target type, or `Water` on water;
not planes), `{"o": "guard", player, ids, target}` (follow an own or allied
unit within 2 cells and fight what comes near; not planes), `{"o": "scatter",
player, ids}` (each unit to a random free neighbouring cell, from the shared
game random), `{"o": "waypoint", player, ids, x, y, attack_move}` (queued
move, at most 16 per unit; any other unit order clears the queue) and
`{"o": "set_stance", player, ids, stance}` with stance `hold_fire`,
`return_fire`, `defend` or `attack_anything` (OpenRA AutoTarget stances; rules
`stance: [initial, initialAI]`, null for actors without AutoTarget). Force-fire
on an actor is `attack`, which may target own and allied actors; only units
with a weapon that can hit the actor as it is now take it (an aircraft in the
air needs an anti-air weapon), and without one the click fires on the ground
under it (OpenRA AttackOrderTargeter). Wasm:
`order_attack_ground`, `order_guard`, `order_scatter`, `order_waypoint`,
`set_stance` (false for an unknown name), `command_state(player, ids)` (JSON
`{ units, armed, attackGround, guard, scatter, queued, stances: { name: count } }`),
`can_guard`, `can_attack_ground`, `can_attack_actor(player, ids, target)`,
`are_allies`, `move_hint(player, ids, x, y)`
(true when a plain move of the armed units among `ids` to (x, y) passes within
6 cells of a visible enemy unit or armed structure: the client then shows its
one-time attack-move tip, `game.attackMoveTipSeen` in the settings document)
and `set_hover(id)` (that actor and the targets of the selection get health
bars). Target class 256 is
`ground` (terrain for force-fire; no actor has it). Return fire uses the shooter that every shot
carries for veterancy (`Shot.source`), so shells in flight count too.

Sidebar buttons (engine/src/repair.rs, engine/src/beacons.rs,
apps/game/js/input.js modes, js/sidebar.js top row): orders
`{"o": "repair_building", player, building}` (start or stop repairing an own
or allied structure with `building.repairable`; starting needs it damaged; at
most `bonuses.len() - 1` repairers), `{"o": "power_down", player, building}`
(switch an own structure with `building.power_down` off or on),
`{"o": "repair_buildings", player, ids}` (WebRA bulk repair, not in OpenRA:
OpenRA's per-structure toggle applied to a group; of the listed structures
only the sender's own, alive, repairable and damaged ones count, each once;
when any of them can start (the sender does not repair it yet and a repairer
slot is free) all of those start, otherwise all that the sender repairs stop;
one `RepairStarted` sound event for the group, at the first one started;
funds are paid per step exactly as for single repairs; allied structures stay
one `repair_building` click each, so a box over an ally's base never spends
money on it; at most 2000 ids like the other id lists),
`{"o": "repair_units", player, ids}` (WebRA bulk repair: each listed unit of
the sender that is alive, in the world, damaged and has repair structures at
all, each once, goes to the nearest own structure that repairs it, ties to the
lower actor index: OpenRA's Repair order, exactly what a smart order on that
service depot or naval yard does with the unit selected (the state hash after
both is the same); difference from OpenRA: OpenRA's FindRepairBuilding and
Repair order also use an ally's structure (own first, the unit's owner pays,
the ally gains PlayerExperience), WebRA repairs units at own structures only,
in the click path and in `repair_units` alike; its waypoints and guarding end as with any new command;
units without such a structure now, infantry (no Repairable in Red Alert;
they heal at a Hospital or by a medic), support power aircraft, other
players' and undamaged units are skipped; planes and helicopters go to the
service depot (OpenRA RA `Repairable: fix`) and wait in its line like the
others, "Service depot line"),
`{"o": "sell_buildings", player, ids}` (WebRA bulk sell: each listed
structure that `can_bulk_sell` allows is sold as by `sell`, in the order
listed: the sender's own, alive, in the world, with OpenRA's Sellable (a
refund percent, so no tech buildings), not being captured or demolished, and
never one with OpenRA's Transforms (the Construction Yard, which packs up into
an MCV; a single `sell` still sells it); the announcer's per-key cooldown
makes N sales one "Structure sold") and
`{"o": "place_beacon", player, x, y}` (world units, inside the map; the
beacon sits on the centre of that cell and replaces the player's previous
one). Repair follows OpenRA's RepairableBuilding: a step of `min(step,
missing hp)` every `interval + 1` ticks, each repairing player pays
`max(1, hp * percent * value / (max_hp * 100))` (value: OpenRA
GetSellValue, `custom_sell_value` or the cost), the step is multiplied by
`bonuses[payers - 1]` percent, nobody paying waits two ticks and pushes an
insufficient funds event per player, repairers who are no longer allied or
playing drop out, a full structure ends the repair. The wrench over a
structure being repaired shows in the colour of each repairer in turn
(OpenRA WithBuildingRepairDecoration loops `allyrepair`, Tick 160, in the
player palette and takes the next repairer after each loop, CycleRepairer):
WebRA's wrench is one team coloured picture (Red Alert's own wrench has no
team colours), shown steadily, the colour changing every 8 ticks (WebRA
counts a loop as two frames of 160 ms). The power off icon blinks, one
frame on and one off, next to the wrench when both show; like every OpenRA
decoration only the owner, allies and spectators see them. Powered off, a structure
adds nothing to the power drain and `is_powered_down` is true (defences hold
fire, radar, gap generator and detection stop, support powers stop
charging, the sprite stands still and is darkened like low power). Both are
in the state hash; beacons are not (they change nothing) and last
`player.beacon_duration` ticks (OpenRA PlaceBeacon.Duration, 750), shown to
the owner and allies (rects over the shroud, not in the spectator views).
Rules: `building.repairable {percent, interval, step, bonuses}` or null,
`building.power_down`, `custom_sell_value` (actor, absent: the cost), `base_building` (actor),
`player.beacon_duration`; `Rules::validate` bounds them (bonuses 1..9 values).
`rules_json` actors have `repairable` and `powerDown`, players `team` and
`neutral`. Wasm: `repair_building`, `power_down`, `place_beacon(player, x,
y)` (pixels), `repair_cursor(player, id)` (0 nothing, 1 toggle repairing that
structure, 2 an own damaged unit goes to its depot), `repair_unit_target(player,
id)` (`[x, y]` of that depot, own depots, the nearest), `can_power_down`,
for bulk repair and sell `repair_buildings(player, ids)`,
`repair_units(player, ids)`, `sell_buildings(player, ids)`,
`repair_selection_json(player, ids)` and `repair_box_json(player, x0, y0,
x1, y1)` (pixels; the player's actors whose selection bounds touch the box,
in actor order) as `{"buildings", "combat", "harvesters", "other",
"noFacility"}` id lists (each id once, in order: own damaged structures with
the repair button; own damaged units that structures repair, armed ones
`combat`, harvesters `harvesters`, the rest `other` (MCV, transports,
minelayers, unarmed helicopters); `noFacility`: those units with no own repair
structure now), and `sell_box(player, x0, y0, x1, y1)` (the structures a box
sells, in actor order). Client (apps/game/js/input.js, js/boxchooser.js): the
Repair button or key with own actors selected, outside repair mode, ends a
sell or power down mode at once, then sends `repair_buildings` for the
selected structures and `repair_units` for the selected units that have a
repair structure (all kinds: the selection is the choice, no chooser) and a
feedback line ("No repair facility for N units.") for the rest; with nothing
to repair it opens repair mode. In repair and sell mode a drag of at least 6
view px is a box (a shorter one is the usual click; touch: a drag in those
modes), drawn yellow (repair) or red (sell), with the mode's cursor while it
holds something and the blocked one otherwise. On release a repair box with
one kind acts at once; with several, a chooser next to the release point
offers the kinds present and All (number keys or the letters S, C, O, U, A,
Enter for the focused one, which is the last choice when offered, Esc or a
press outside cancels, the mode ending closes it); the choice is remembered
in the settings (`extra.repairBoxChoice`, default `all`), and Shift held at
the press or release (touch: Add) skips the chooser with it (All when it is
not present). A sell box sells at once when it holds one structure; more
asks "Sell N structures for $X?" with the total of `sell_value`; only a
click on Sell or its keys S and Y sell, Cancel has the focus and Enter (also
the chat key), Esc, N, C, Cancel or a press outside cancel; no modifier skips
that question, since a sale cannot be undone. The answers of a box are
dropped when the mode changes, a newer box starts, the game menu opens or
the view goes (`Input.dispose`) while they come (no question is left open).
Tab and Shift+Tab cycle within the chooser and the question while one is
open; it takes every key meanwhile, and the view does not scroll at the
screen edges (js/main.js `holdsEdgeScroll`). With the mouse captured
(js/mouselock.js) the browser keeps Esc to let the mouse go: with "Esc also
opens the menu" on, that Esc ends the mode and so the question; off, the
question stays and the next Esc (after the 250 ms release guard) cancels
it. There is no separate "repair
all damaged structures" hotkey: OpenRA's hotkey set has no such command to
name it after, and a box in repair mode or selecting the base and pressing
Repair does the same. Wasm for the hotkeys:
`base_actors(player)` (Construction Yards and MCVs, else the first
structure), `harvesters(player)`, `production_buildings(player)` (no
Construction Yards, by first production type) and `queue_producer(player,
queue)` (the structure units of that tab come out of, or NONE). The selection
keys and double click follow OpenRA's `Selectable` (engine/src/selection.rs):
actors have `selection {priority, modifiers, class, bounds}` or null
(tools/gen_rules.py; modifiers bits 1 Ctrl, 2 Alt; class: the actor's name
unless the trait sets one; bounds `[w, h, x, y]` in world units or empty for
the footprint or one cell); `select_all(owners, x0, y0, x1, y1, ctrl, alt)`
returns the selectable actors of `owners` whose bounds touch the rectangle
(pixels), those of the highest priority (OpenRA
SubsetWithHighestSelectionPriority), and `select_by_class(owners, ids, x0, y0,
x1, y1)` those of the classes of the actors of `ids` that `owners` own.
`select_box(player, x0, y0, x1, y1, ctrl, alt)` (OpenRA box selection) returns
the visible selectable actors whose bounds touch the box, those of the highest
priority for `player` (other players' actors lowered by 30 for an ally, 60
for a neutral, 90 for an enemy; a `player` past the players is a spectator
watching everyone), and `select_at(player, x, y, ctrl, alt)` the actor a click
selects (priority less the pixel distance to its bounds' centre) or NONE. Local
queries: not in the state hash. `actor_json`
has `repairing`, `repairers`, `poweredOff` and `canPowerDown`. Audio events
(engine/src/sound_events.rs): 11 `RepairStarted` (owner: the repairing
player, b: the structure's owner; the "Repairing" announcement), 12
`PowerToggled` (b: 1 off, 0 on; OpenRA's power sounds), 13 `BeaconPlaced`
(b: ticks it stays; a sound and radar ping for allies), 14 `UnitDamaged` (a
unit hit by another player after a quiet spell; a radar ping like OpenRA's
DamageNotifier@Unit).

### Audio events and notifications (`engine/src/sound_events.rs`, `apps/game/js/audio`)

The engine logs what happened as audio events (`EVENT_STRIDE` i32s each:
`[kind, a, x, y, owner, b]`, world units); the client drains them per frame
(`take_audio_events`) and decides what to play (js/audio/director.js). The
log is presentation only: never read by the simulation, off by default
(servers, tests), not in the state hash; presentation-only bookkeeping
(power instances' `notified_charging` / `notified_ready`, aircraft
`air.power` / `air.launched`) is not hashed either. Kinds and their fields:
1 Fire, 2 Impact, 3 Death, 4 BuildingDamaged and 14 UnitDamaged (b: the
attacking player; only another player's fire counts, as in OpenRA's
DamageNotifier), 5 UnitProduced, 6 BuildingPlaced, 7 Sold (b: -1 when the sale starts, the sell sound; the refund when it is done after the reverse make animation, the announcement and cash tick), 8
InsufficientFunds, 9 PowerActivated (a: `power_code`, b: `power_ref`), 10
ConstructionReady, 11 RepairStarted, 12 PowerToggled, 13 BeaconPlaced, 15
Transformed, 16 DeployBlocked, 17 PowerCharging and 18 PowerReady (a: the
provider type, b: its power index; OpenRA SupportPowerInstance's
notifiedCharging and notifiedReady), 19 ReinforcementsArrived (the first
paratrooper plane of a drop in the drop zone), 20 ProductionCancelled
(CancelUnbuildableItems), 21 ProductionBlocked (a finished unit cannot
leave, once per item), 22 UnitRepairStarted and 23 UnitRepaired (b: the
repairing structure's type), 24 LevelUp, 25 Crushed (at the crusher; b: its
owner), 26 DamageHeavy (fell below half health: SoundOnDamageTransition), 27
CloakChanged (b: 1 cloaked; not when an actor starts cloaked), 28 ParaDrop
(the dropping aircraft's ChuteSound), 29 ParachuteImpact (b: 1 on water), 30
Rearmed (one magazine; the owner only), 31 NewOptions (10 ticks after a
placement that added buildable items), 32 PrimaryBuildingSelected, 33
Captured (owner: new owner, b: old owner), 34 Infiltrated (owner: the
target's owner, b: `infiltrator_code(type, owner)`), 35 TimeLimitWarning (a:
minutes left, owner `ALL_PLAYERS`; `SoundEvents::push_time_limit`), 36
CrateCollected (a: `crate_action_code`, b: the crate's type), 37
PilotEjected (a: the aircraft's type; its EjectOnDeath ChuteSound), 43
KillAnnounced (a: the killer's type; its AnnounceOnKill voice line, to its
owner), 44 CashTick (a: the amount; owner: whose colour; no sound, js/battlefx.js
draws it), 45 MadTank (b: 0 when a deployed MAD tank starts charging,
ChargeDelay ticks after deploying: MadTank.ChargeSound; 1 as it detonates:
DetonationSound and its DetonationWeapon's impact), 46 Teleported (one
event at each end of a teleport, OpenRA Teleport's ChronoshiftSound; b: 1 for
a chrono tank's own jump, PortableChrono, 0 for the Chronosphere, its way
back and the missions' chronoshifts, Chronoshiftable), 40 PlayerLost and 47
PlayerWon (owner: the player; one PlayerWon per player of the last side
standing, after the losers' PlayerLost, like OpenRA ConquestVictoryConditions
marking each remaining ally's objective; js/battlefx.js writes "X is
defeated." and "X is victorious." as system lines), 48 LightningStrike
(WebRA, engine/src/lightning.rs: one event per actor lightning struck, at it;
a: its type, owner: its owner, b: the strike kind, 2 a unit or structure, 3
a power plant, whose owner hears the WebRA line "Power plant struck by
lightning. Power outage." (EVA key `lightningOutage`, chime and text, no
original), 1 grounded on a Lightning Rod, a: the rod's type), 49
RouteBlocked (a: the unit's type, at the unit; WebRA addition, see the
movement models: the line "Route blocked." and a radar ping for its
owner). Kinds 32 to 36
are the API for features other code emits (`self.sound.push(...)`); the
client already plays them. `rules_json` actors list their support power keys
(`powers`) so `power_ref` names a power.

The client follows OpenRA's notifications (data/source/audio/notifications.yaml
and the rules, through `tools/gen-audio-catalog.mjs` into
js/audio/catalog-data.js): speech goes to the player it is for (spectators
and replays hear none of it, but the time limit warnings), with OpenRA's
intervals (low power every 10 s while low, silos needed every 20 s above 80
percent of the storage, base under attack and insufficient funds at most
every 30 s); sound notifications (RadarUp, LevelUp, ChatLine, ClickSound,
...) honour their InterruptType and VolumeModifier; world sounds are heard
near the camera where the player can see (WebRA's fog rule; OpenRA plays
them regardless of the shroud). Lines that only exist as text in OpenRA
(Unit promoted., Our ally is under attack.) are shown without sound.

A paused game says and shows nothing new, as OpenRA's notifications come
from world ticks: the low power and silo intervals count the `tick` of
`player_json` (game time at the game's speed), not the page clock, so the
state the UI polls during a pause (the same tick) never fires them and the
cadence goes on after it. The announcer holds the simulation's lines (engine
events, player state, mission speech; `announce(key, { world: true })`) while
the player pauses (`AudioSystem.setPaused`, `holdsGameAudio`: the pause
hotkey, the game menu and a hidden tab of a local game, a paused replay) and
plays them after it; the player's own clicks (production, support powers)
still speak, music and interface sounds go on. The end of game dialogs
stand a local game still but hold nothing (OpenRA's world goes on at the
end): the lines of the last ticks and the Win or Lose line, which is never
held, play at once. Sounds asked for while the installed originals load
(`defer`, only while the store may have any) are held the same way: the
simulation's wait out a pause, the player's play when the load is done. Radar pings,
floating texts, camera shake, the nuke flash, lightning, thunder, weather
particles, water and building animations run on the simulation clock
(js/simclock.js: tick and interpolation), so they stand still with the game.
Interface timers (target lines, text lines, cursors, the radar's opening)
keep the page clock, as OpenRA's widgets tick while paused. Online games
have no pause (see section 4).

Original sounds (catalog.js `openra`, bank.js `keepsOriginal`): every cue
OpenRA defines (weapons, actors, speech and sound notifications, voices,
support powers, including the C# defaults the yaml leaves out: MadTank
madchrg2 and madexplo, Chronoshiftable chrono2, PortableChrono chrotnk1) is
marked as OpenRA's. With original sounds in use (the setting is on and the
player installed some), such a cue plays only originals: where OpenRA plays
nothing (a bullet's impact, a flamethrower's shot, a tree falling, an empty
notification, the support powers' targets) or only a file OpenRA made itself
(data/source/bits.txt: bctrinit "Battle control online", unitsto "Unit
stolen", enmydet, the thief's scandy, sclean1 and ssteal1, the spy's silppk),
nothing plays and an announcer line only shows its text; the browser's
speech never stands in for an original line or reply. A cue whose Red Alert
file is just not installed (a partial install) and WebRA's own cues
(thunder) keep WebRA's sound. Thunder comes after the light-to-sound delay
of the strike's distance (js/weather-fx.js, `flash` `[tick, x, y]` or
`[tick, x, y, kind]`) and is placed like the other world sounds
(director.js `thunderCue`, gain and pan of `spatial`): on screen
`thunder_close` (a tearing crack with echoes, then rolling rumble), up to 3
half-views away `thunder` (a dull clap and rolls), further `thunder_distant`
(a soft rumble that swells in), fading over 4 times the usual reach but
never below 0.4; a strike on a lightning rod, units, structures or a
power plant (`kind` above 0) cracks just off the view's edge too. Until the installed sounds are loaded
(`AudioSystem.loaded`), effects, notifications and replies wait for them (at
most DEFER_MAX_AGE, 1 s, then they are dropped) and announcer lines wait up
to ANNOUNCE_WAIT (3 s) for them and for audio to start, so a game started
right after the page opened begins with the original lines. The Tesla
Coil's AttackTesla.ChargeAudio (tslachg2) plays with its zap: OpenRA plays it
InitialChargeDelay (22 ticks) before the first zap of a burst, a charge phase
the engine does not model (one zap per ReloadDelay).

Hotkeys (apps/game/js/hotkeys.js): defaults are OpenRA's Red Alert hotkeys
(`apps/game/js/openra-hotkeys.js`, generated by `tools/gen_hotkeys.py` from
data/source/hotkeys; CI checks it is up to date), each action naming its
OpenRA hotkey (`openra`), except `BROWSER_SUBSTITUTES` (Ctrl+Tab, Ctrl+Q,
Ctrl+W, F11, F12) and `WEBRA_SUBSTITUTES` (on macOS Alt+E is WebRA's release mouse key,
so OpenRA's MapBookmarkRestore03 has no default key there; `substituteFor`). Saved overrides (`settings.hotkeys`, synced with the
account) carry `"webra:keymap": ["2"]`; overrides without it come from WebRA
0.7 and are migrated on reading (`migrateOverrides`: overrides equal to the
old defaults, or old defaults that only lost keys to other actions' user
bindings, are dropped; everything else stays). Radar pings and the "last
event" (Space) are client side (js/radarpings.js) from the audio events.

### Battlefield tooltip and range circles (`engine/src/tooltip.rs`, `engine/src/range_circles.rs`)

Both are local UI like `pick`: they read the world, never change it, and
are not part of the state hash; they work the same in every mode.

`Game.world_tooltip(view, x, y, ctrl, alt)` (world pixels; `view` a player,
`observer_player()` or the combined spectator view) answers what OpenRA's
ViewportControllerWidget puts in the WORLD_TOOLTIP, as JSON: `null` (off the
map, nothing there), or `{ kind, label, id, owner, faction, extras }` with
`kind` `unexplored` (shroud: not explored, or hidden by an enemy gap
generator; "Unrevealed Terrain"), `actor` (`id` its actor id), `frozen` (a
remembered structure under the fog, with the type and owner it was seen
with) or `resource` (ore and gems: the ResourceRenderer name). Actors count
as the render paths draw them for `view` (fogged and undetected cloaked
enemies are not there); of those whose bounds hold the point
(Selectable bounds, else the footprint or one cell) the highest selection
priority less the pixel distance to the bounds' centre wins, actors that
cannot be selected last (OpenRA WithHighestSelectionPriority). `label` is
OpenRA's TooltipForPlayerStance: the name, or for the relationships in
Tooltip.GenericVisibility the GenericName after "Ally" or "Enemy" (fakes:
enemies read "Power Plant"); spectators get the name. A disguised spy
carries its disguise's tooltip for everyone and the disguise's owner for
all but its owner's allies (DisguiseTooltip). `owner` is the owner row's
player: null without ShowOwnerRow and for non-combatants (the neutral
player). `extras` are the TooltipDescription lines (tech buildings:
@ally for the owner and allies, @other for the rest, none for spectators).
Rules: `actors[].tooltip` (`generic_name`, `generic_visibility` bits Ally 1,
Neutral 2, Enemy 4, `generic_prefix`, `show_owner`; null: no tooltip) and
`world.tooltips` (texts), from tools/gen_rules.py. The client
(js/worldtooltip.js) shows it 200 ms after the mouse last moved over the
battlefield (TooltipContainerWidget), 20 px under the cursor, moved left at
the right edge and above the cursor at the bottom; it adds the owner's name
and colour, the faction flag (css flag chips) and, in sell mode,
"Refund: $n" for the player's own structures that can be sold (Sellable:
`Game.sell_value`, the amount the sale pays; walls say $0). Differences: a
remembered structure's TooltipDescription follows the owner it was seen
with (OpenRA reads the live actor's, which tells a capture under the fog);
mouse bounds of actors without Selectable bounds are their footprint or one
cell, not their sprite.

Range circles (`actors[].range_circles`: `kind`, `group`, `range`, colours,
widths, `placement`, `passengers`) follow OpenRA's RenderRangeCircle
(^Defense: the longest weapon, FallbackRange 6c0 on the garrisons when
placing, RangeCircleType `aa` on AGUN and SAM; yellow), RenderDetectionCircle
(the DetectCloaked range of SS, MSUB, DD, PT, SPEN, SYRD and MNLY; lime
green), RenderShroudCircle (CreatesShroud of GAP and MGG; cyan),
RenderJammerCircle (JamsMissiles of MRJ; red) and WithRangeCircle (the MAD
tank's 7c0 and the jammer's 18c0, the pillbox's 5c0 with a rocket soldier
inside). `build_lines` draws them for the selected actors of the viewer and
their allies (spectators: every combatant's), and with `set_placing` for the
structure being placed at its footprint's centre plus the viewer's and
allies' circles of the same group (RangeCircleType or WithRangeCircle Type;
every shroud and jammer circle). Each circle is 32 straight dashes over
facings 8i to 8i + 6, a BorderWidth 3 border of 96 alpha black under a
Width 1 line of the colour, at a fixed width on screen at every zoom
(shaders/line.wgsl; the line width is a line instance's ninth float).
WebRA's pillbox fires its garrison's weapon itself, so its circle is that
weapon's range rather than its passengers'.

### Chat, system lines and the HUD (`apps/game/js/chatlog.js`, `chatpanel.js`, `gametimer.js`, `muteindicator.js`)

Every game (skirmish, missions, online games, spectators, replays) has
OpenRA's in-game chat panel (mods/common/chrome/ingame-chat.yaml,
IngameChatLogic, TextNotificationsManager):

- `TextLog` keeps every chat, system and mission line of the game. System
  lines (OpenRA AddSystemLine) carry the prefix "Battlefield Control" and are
  yellow (SYSTEM_LINE_TEMPLATE FFFF00): the time limit's warnings ("5 minutes
  remaining.") and its end, "X is defeated.", "X is victorious." and WebRA's
  online lines (connection, saves, rematch). Mission lines are the scripts'
  `Media.DisplayMessage` (AddMissionLine, js/campaign/view.js `missionLine`).
  Chat lines carry the sender's name in the player's colour with OpenRA
  UnitOrders' marks (`chatPrefix`): " (Dead)", " (Spectator)", " (Ally)" in
  all chat, "[Team] name", in replays "[Team N] name", and "[Spectators] name"
  for the spectators' team chat (the server's `spectators` mark: spectators
  and defeated players). A defeated player's Team mode talks to the
  spectators; once the game is over nobody has team chat (OpenRA
  IngameChatLogic).
- The overlay (CHAT_OVERLAY, TextNotificationsDisplayWidget) shows the newest
  8 lines while the panel is closed; each leaves after 10 s (DisplayDurationMs
  10000; WebRA's old online overlay kept 15 s). WebRA's connection lines that
  need the player's attention ("Connection lost") stay until newer lines push
  them out. Each new line plays ChatLine (ChatLineSound).
- OpenTeamChat (Enter) and OpenGeneralChat (Shift+Enter) open the panel in
  every game: the scrollback with every line (CHAT_SCROLLPANEL), the mode
  button (Team / All, ToggleChatMode Shift+Tab), the chat line (Tab completes
  a name) and the close button. Where nobody can be talked to (single player,
  missions, replays) the line is off and Enter or Esc closes the panel, like
  OpenRA. Esc closes the open panel wherever the focus is (also after a click
  on the battlefield), before it can cancel a mode or open the game menu;
  with the panel closed Esc is the game's as before. Up and Down in the chat line recall sent lines (CommandHistory: 50,
  newest first, a repeat moves to the front). OpenRA keeps only chat commands
  (`/...`) there; WebRA has no chat commands, so it keeps the sent lines.
- The scrollback shows each line's local time (TIME label, HH:MM), as
  OpenRA's chat in the game menu does (OpenRA's in-game panel and replays show
  none; WebRA has no separate menu chat, so the panel shows it, except in
  replays).
- Mute (OpenRA TextNotificationsManager.MutedPlayers, GameInfoStatsLogic's
  MUTE checkbox): the open panel lists the other people of an online game
  (players and spectators, not bots or yourself) with a Mute / Unmute toggle.
  A muted person's new lines are dropped from the overlay and the scrollback
  and play no sound; the replay still records them. The API for other panels
  (the game info player list): `window.webra.chat.log` (a `TextLog`)
  `isMuted(client)`, `setMuted(client, on)`, `toggleMuted(client)` (the MUTE
  checkbox's OnClick, returns the new state) and `onMute(fn(client, muted))`;
  `ChatPanel.mutable()` lists who can be muted (`{ client, name }`).
- "Hide chat in replays" (game menu, Settings; OpenRA HideReplayChat): in a
  replay the players' chat stays in the scrollback but leaves the overlay and
  plays no sound.
- The transient lines at the bottom (js/notifications.js, OpenRA's
  TRANSIENT_LINE_TEMPLATE: the announcer's lines and UI feedback such as
  "Selected 12 units across screen." and "Audio muted.") have OpenRA's two
  filters (TextNotificationPoolFilters): "Show UI feedback notifications"
  (Feedback) and "Show game event notifications" (Transients).

The game clock (OpenRA GameTimerLogic): the sidebar clock shows "Paused"
instead of the time every other second while a local game is paused (the
game menu, the Pause key, the debug menu; RA's clock has no status label).
The replay bar's time is the observer timer: its tooltip says "N% complete"
and a status beside it blinks "Paused", "Max Speed" (8x, the highest) or "N%
Speed" while the replay is paused or not at 1x. Online spectators have no
timer in WebRA's observer panel.

"Audio Muted" (OpenRA MUTE_INDICATOR, MuteIndicatorLogic) shows with a muted
speaker in the HUD button row for as long as all sound is off (ToggleMute or
the audio settings), in every game; ToggleMute itself writes "Audio muted." or
"Audio unmuted." as a feedback line (MuteHotkeyLogic).

### Mouse capture, the release key and pausing (`apps/game/js/mouselock.js`, `main.js`)

Mouse capture (Pointer Lock, desktop browsers with a mouse only) follows
Settings > Capture the mouse (`off`, `fullscreen` default, `always`). One
model, like cloud gaming services:

- Captured: a short notice at the top, "Mouse captured. Press Option+E to
  release." with the bound key in the platform's names (Option on macOS;
  Esc when none is bound), every capture by default; Settings > Mouse
  captured notice `always` / `first` (the first 3 captures,
  `extra.mouseCaptureHints` counts them) / `off`. Never on touch screens
  (no capture there).
- The release key (`toggleMouseCapture`, rebindable; `RELEASE_MOUSE_KEYS`):
  Option+E on macOS (matched by `code` KeyE since Option makes a dead key),
  Alt+Shift+E on Windows and Linux, where Alt+E opens Chrome's and Edge's
  menu and Firefox's Edit menu (a page cannot reliably hold that back) and
  Ctrl+Alt+E is AltGr+E (the euro sign on many European layouts); no
  browser reserves Alt+Shift+E and no OpenRA hotkey has it. While
  captured releases without the menu: the game plays on, single player is
  not paused. The game is then detached (`MouseCapture.isDetached()`): Esc
  still cancels a mode and closes what it closes (the chat, a tip), but
  where it would open the game menu the HUD shows "Mouse released. Click
  into the game to capture it again; then Esc opens the menu." instead. A
  click into the game captures again (no browser cooldown after the key) and
  ends it; so do a menu or dialog (the Menu button, the end of the game).
  Where a click would not capture again (capture off, `fullscreen` outside
  fullscreen, a dialog open) Esc opens the menu as usual. Pressed while
  released, the key captures (whatever the setting says).
- Esc while captured releases the mouse and, with "Esc also opens the menu"
  (default), cancels a mode or opens the menu at once; off, the next Esc
  does.
- The browser letting go by itself is Esc, or the focus going to another
  window (alt-tab, a click on another monitor). The page cannot tell at
  once (blur may come just after), so `FOCUS_SETTLE_MS` (100 ms) later a
  window that still has the focus and is shown means Esc. Losing the focus
  never opens the menu, and nothing else opens it on blur.
- Settings > "Pause when the game is hidden" (single player, default off):
  off, a hidden tab or window keeps playing (section 8, "Hidden pages"),
  sounds of the hidden time are dropped and the music goes on; on, the game
  menu opens (and so pauses) when the page is hidden. Online games never
  pause.

### Menu screens and dialogs (`apps/game/css`)

Every menu screen outside the battlefield is one card as wide and as tall
as the window, with the grid background showing around it; small dialogs
stay compact cards in the middle. `tests/screens-layout.test.mjs` checks
the rules below.

- **Screens**: the start screen (main menu bar over the skirmish setup,
  `#menu`), online play (server browser and online lobby, `#online-root`),
  the campaign's mission browser (`#campaign-root`), the end-game
  statistics (`#stats-screen`, over the dimmed battlefield), the friends
  screen (`#friends-root`, over the start or online screen) and Load game
  (`js/records.js` `dialog(..., { screen: true })`). Their cards have no
  width cap; the screen pads them by `--ui-screen-pad` (theme.css), and the
  card stretches to the rest of the window, its footer bar at the bottom
  (the server browser's session list grows into a well with its status
  line under it).
  A card taller than the window scrolls with the screen (the statistics
  scroll inside the card, so the tabs and buttons stay in view).
- **The gap**: `--ui-screen-gap` is `clamp(12px, 1.5vw, 24px)` (12 px up to
  an 800 px window, 24 px from 1600 px) and 8 px on phones (600 px and
  less), in plain pixels at any UI scale. Each side is at least the
  safe-area inset there. At the bottom the gap is at least
  `--ui-corner-clear`, so a card ends above the parts in the bottom left
  corner: 24 px for the version tag on every screen (Load game too); 56 px
  times the UI scale while the Sound button shows on the online and
  campaign screens, 84 px times the UI scale while Original content shows
  above it (on touch screens and phones the safe-area inset or 24 px, the
  buttons' offsets and a 44 px row, plus 8 px); and 56 px times the UI
  scale on the statistics over a game on a mouse device in the desktop
  layout, where the Sound button stays (touch screens and the phone
  layouts hide it).
- **Fallbacks**: the corner clearance needs `:has()` (Chrome 105, Safari
  15.4, Firefox 121; older browsers keep the 24 px and the buttons may
  overlap the card), and Load game's grid backdrop needs a `::backdrop`
  that inherits custom properties (Chrome 122, Firefox 120, Safari 17.4;
  older ones show the plain dark background).
- **Inside a card**: the parts are laid out by the card's width through
  named container queries, never unnamed ones, so a wider card cannot
  change what a query measures:
  - `lobby` (the skirmish card): one column up to 930 px; map | players
    over options from there; map | players | options from 1440 px (the
    map column 26% of the card, 300 to 440 px), where the players panel
    stays wider than the 560 px at which its slots turn into cards.
  - `lobby-panel` (each lobby panel): the player slots become cards and
    the option grid one column at 560 px and less.
  - `online` (the online card): from 1440 px the game options get a column
    of their own next to the slots; the map and the chat stay on the right.
  - `campaign` (the mission browser): the mission list takes 40% of the
    card, at most 420 px; from 1200 px (a mission column of 760 px or more)
    the map preview goes beside the briefing.
  - `records` (Load game): from 720 px a save's name and details share a
    line.
  Viewport media queries stay for phone sizes (touch targets, padding).
- **Line length**: running text in a screen card (briefings, notes,
  warnings, errors) keeps to `--ui-measure` (75ch); the card is not capped
  for it.
- **Compact dialogs**: the game menu (over the running game; up to 980 px
  for its main page, 1080 px for Settings and the Guide, 560 px for its
  confirm steps and the Music page; see "The game menu, the guide and the
  tour" below), victory and defeat, the modded map
  question, the online host, password and resume dialogs, sign in and the
  settings conflict, Sound and music, the music player, Original content,
  release notes, the bulk repair and sell chooser, help tips and tooltips,
  and the map editor's dialogs keep their widths.

### The in-game HUD and its connection parts (`apps/game/js/sidebar.js`, `js/netwarn.js`, `css/netwarn.css`)

The HUD follows the InGame, NetInGame and Tooltips boards. The logic of
production (clicks, holds, cancels, queue counts, the red funds marker of
`shortOfFunds`) is unchanged; the sidebar adds:

- **Fullscreen** in the top row (callback `fullscreen: { available, active,
  toggle }`, js/fullscreen.js; Alt+Enter is the same): pressed while
  fullscreen, dark with js/fullscreen.js UNAVAILABLE in its tooltip where
  the page cannot go fullscreen. Without the callback there is no button.
- **Tab lamps**: a `.sb-tab-led` (js/ui/controls.js `led`) per production
  tab, `on` (white) for the open tab, `warn` (gold, with a gold edge
  `.sb-tab.ready`) when something of it is ready; the count badge ("!" or
  N) stays as the word.
- **Selection panel**: the cameo of the selected type (or the most numerous
  one) in its owner's colour, "3 × Mobile Flak" for one type, the count and
  up to three "N × name" for more (`selectionTypes(ids, infoOf, nameOf)`,
  infoOf js/sim/methods.js `actorInfo`), and "Group N" when the whole
  selection is one control group (`selectionGroup(ids, groups)`,
  js/controlgroups.js). js/main.js `selectionInfo` passes `types` and
  `group`.
- `netSlot`: the place next to the clock where js/netwarn.js puts the signal
  bars.

**Connection parts of an online game** (`NetWarn`, docs/redesign-uitwerking.md
29). The wiring comes from three branches besides this one (work/hud):

- work/netround provides the data: `js/netquality.js` (`NetQuality`, which
  measures with `ping`/`pong` and reads `netstat` and the server's `waiting`
  message, section 4 "Network quality").
- work/onlineui hands the game one network object as `onStartGame`'s `net`
  (js/online.js `gameNet`): `{ quality, source, roster, you, players() }`.
  `quality` and `source` are the session's NetQuality (the same object; it
  lives on from the lobby into the game), `roster` the start message's people
  `[{ client, player, name }]` (AI players left out), `you` this member's
  client id, `players()` the roster with colours for the game menu. js/main.js
  makes a NetWarn when `online.net.quality` is there and passes it `quality`,
  `roster` and `you`; single player, skirmish and replays have none.
- work/escmenu listens on the window for `OPEN_NETWORK_EVENT` and opens the
  game menu on its Network tab.

The quality interface NetWarn relies on (js/netquality.js `NetQuality`, the
only place it is defined; tests use a stand-in with the same shape):

| Member | Shape |
|---|---|
| `on(type, fn)` | subscribes; returns the function that unsubscribes |
| `'self'` event, `self` field | `{ rtt, jitter, late, quality, bars, poorSince, sent, latePings }`: rtt and jitter in ms or null, late in percent or null, quality `'good' \| 'fair' \| 'poor' \| null`, bars 4, 3, 1 or 0 (netBars) |
| `'players'` event, `players` field | `Map<client, { client, rtt, jitter, late, silent, quality, bars, you }>` (silent: ms since the last ping when over 5 s, else null) |
| `'waiting'` event, `waiting` field | `{ client, heldMs, dropInMs, at }` (at: `Date.now()` when it arrived) or null when the game runs again |

NetWarn reads the three fields once when it is made and then follows the
events; its clock is `Date.now()`, the same as `waiting.at`.

- **Signal bars** (players only, in the sidebar): 4 bars lit by NetQuality's
  own `self.bars` (4 good, 3 fair, 1 poor, 0 measuring), the level as
  `data-level` and in the label ("Your connection: poor, 320 ms"), a tooltip
  with ping, jitter and loss (late pings). A click dispatches
  `OPEN_NETWORK_EVENT` (`'webra:open-network'`, a CustomEvent with `detail:
  { tab: 'network' }`) on the window; the game menu (js/gamemenu.js) opens on
  its Network tab when it hears it.
- **Own warning** (players only): `role=alert` at the top of the battlefield
  once the own quality has been `poor` for SELF_WARN_AFTER_MS (10 s) without
  a break ("320 ms · 6% loss."). Its close button hides it until the
  connection was not poor once and then poor for 10 s again; it also goes
  when the connection recovers (`SelfWarning`).
- **Waiting for a player** (players and spectators): on a `waiting` for
  another client, the system line "Waiting for X." once per wait; after
  WAIT_PANEL_AFTER_MS (2 s from the first `waiting` of that client) the
  panel over a dimmed battlefield with the drop countdown (`dropInMs` less
  the time since it came, as a share of DROP_AFTER_MS) and a row per person
  of the game (`waitRows`: behind, ok, fair, poor, silent or measuring, as a
  word and a lamp). `waiting { client: null }` closes it (`WaitWatch`). Never
  for this member itself.
- Settings: `net.signalBars`, `net.warnSelf`, `net.warnOthers` (the `net`
  group of js/registry.js) switch the three off at once.

### Start, loading, end of game and statistics screens (0.17)

The boards Skirmish, Loading, LoadingTips, GameOver, Defeat, Statistics and
NetStats in code.

- **Start menu** (`js/startmenu.js`, `css/startmenu.css`): the menu bar
  pattern; `#start-online` says how many players are online from
  `onlineCount()` (main.js calls `net.js api.online?.()`, which the protocol
  8 round adds for `/api/online`; without it the line stays hidden), asked
  when the menu mounts and every `ONLINE_REFRESH_MS` (60 s) while the start
  screen shows.
- **Skirmish** (`js/lobby.js`): select plates everywhere (also the game mode
  list, `js/modepicker.js`, and the bulk action list, `js/lobby-bulkbar.js`,
  shared with the online lobby; screens call `destroy()` on rebuilt rows'
  plates), starting cash a stepper, game speed a segmented row, team
  presets (`TEAM_PRESETS`: the bulk actions `teams:ffa`, `teams:split:2`,
  `teams:humans-vs-ai` for every slot; `lobby-bulk.js matchingTeamAction`
  shows the one the teams already are), Save setup (the mode list's Save
  as: a saved game mode in `lobby.presets`, no second store).
- **Loading screen** (`js/loadingscreen.js`, `js/loadingboard.js`,
  `js/tips.js`, `css/loading.css`): `LoadingScreen.describe(describeStart(spec))`
  (main.js `launch` and `createOnlineGame`) shows the kind of game, the map's
  name and the sides. Tips go on in turn from `guide.lastTip` + 1 every
  `TIP_MS` (5 s, keys as the player bound them); the last one shown is
  stored when the screen goes. The screen shows at least `LOADING_MIN_MS`
  (1600 ms, the bar's reveal animation, `--loading-min`): at the first frame
  `done()` sets `--loading-hold` to what is left of it, and the stylesheet
  makes that the delay of the fade (`LOADING_FADE_MS`, 300 ms,
  `--loading-fade`, opacity 1 to 0) on `#loading.is-closing`. The close is
  the start gate's: it adds `.is-closing` and waits for that transition, its
  duration plus its delay, before the screen hides and the game begins; so
  the screen waits out the hold, then fades. Reduce motion: no hold, no
  fade.
- **Boot screen** (`index.html #boot`, `js/bootscreen.js`, `css/loading.css`):
  the loading screen's look from the page's first paint until the start menu
  is ready. Static markup (no inline script or style, the CSP holds), with
  `body.is-booting` hiding `#menu`, `#online-root`, `#campaign-root` and
  `#friends-root` (visibility, so they still lay out) until it goes; the
  browser's `prefers-reduced-motion` applies before the settings load.
  `js/bootscreen.js` loads ahead of main.js, which imports the same
  `bootScreen`: `started()` (the files are loaded), `track(id, promise)` for
  `engine` (loadEngine), `account` (`AccountSession.whenReady()`), `content`
  (`ContentSystem.load()`), `graphics` (`Renderer.create`), `begin('menu')`
  before the lobby, and `ready()` at the end of boot (after the records, an
  invite or rejoin's online screen and a linked map). `ready()` waits at most
  `BOOT_WAIT_MS` (5 s) more for `account` and `content`, marks steps that
  never ran `skipped`, removes `is-booting` and fades with the loading
  screen's `.is-closing` transition (no least time, no hold). A game that
  starts during the boot hands over (`LoadingScreen` `onBegin` calls
  `handOver()`; `#boot` is z-index 84, over `#loading` at 82 and under the
  account dialogs at 85). Known problems (no engine, no WebGPU) are not
  failures: their steps fail, the lobby shows them. A main script that does
  not load or a module error before main.js runs (`watchGameFiles`), and a
  `boot()` that throws, call `fail()`: an alert and Reload. After
  `--boot-late` (`BOOT_LATE_MS`, 20 s) `.boot-late` shows a reload link by CSS
  alone.
- **End of game** (`js/endgame.js`): `EndGameDialog` takes `report()` (the
  parsed `observer_report`), `players`, `localPlayer` and `reducedMotion`;
  its `context()` adds `replay` (`saving`, `saved`, `failed` or null: main.js
  from the account's upload events) and `rematch` (the online rematch
  handle's `status()`: `{ by, voters: [{ name, accepted }] }`).
- **Statistics** (`js/stats.js`, `js/netstats.js`): the Network tab shows
  for online games when `onStartGame` gives main.js the game's `net`
  (js/online.js gameNet: `{ quality, source, roster, you, players() }`);
  `netStatsData(net)` reads `quality` (the NetQuality: `report()`,
  `requestStalls()`, `self`) with `roster` as the seats, quality is
  the protocol's `netQuality`. A stall's entry opens the game's replay at its
  tick (`openReplayAt`: the session is left and the replay viewer seeks
  there) once the game is over. Keys: an open select list gets every key,
  the tab list (vertical) its arrows, Home and End; Esc otherwise closes
  the screen.

### Design system: tokens, fonts, controls and patterns (`apps/game/css`, `js/ui/controls.js`)

The design system boards (Foundations, Controls, Patterns, Tooltips, Logo)
in code. Screens use these parts instead of their own copies; the website
loads the same sheets and modules from `/lib/`.

**Tokens** (`css/theme.css` `:root`; `apps/website/assets/site.css` offers
the same values under the same `--ui-*` names, checked by
`tests/theme-tokens.test.mjs`, which also checks contrast):

- Metal: `--ui-bg`, `--ui-metal-0` (wells) to `--ui-metal-4`, `--ui-edge`,
  `--ui-line`, `--ui-line-soft` (between table rows), `--ui-bevel`,
  `--ui-bevel-in`, `--ui-rivet`, `--ui-scan`, `--ui-hazard`; surfaces
  `--ui-well`, `--ui-raised`, `--ui-raised-hover`, `--ui-panel`.
- Text (4.5:1 on every panel and well): `--ui-text`, `--ui-text-2` (body copy
  in dialogs and tooltips), `--ui-muted`, `--ui-money`, `--ui-ok`,
  `--ui-warn`, `--ui-info-text`; `--ui-bad` is text only on `--ui-bg`,
  `--ui-metal-0` and tooltips; `--ui-dim` is decoration only.
- Accent: `--ui-accent` (parts), `--ui-accent-hi` (text, focus),
  `--ui-accent-hover`, `--ui-accent-lo` (chosen backgrounds),
  `--ui-accent-glow`, `--ui-primary*` and `--ui-primary-fill*` (main
  buttons), `--ui-primary-glow`, `--ui-primary-glow-hover`,
  `--ui-primary-disabled-text`, `--ui-brand-red` (the logo's RA).
- Lamps: `--ui-led-{off,on,ok,warn,bad,info}` with `-edge` and `-glow`.
- Sides and ground: `--ui-allies`, `--ui-soviet`, `--ui-neutral`,
  `--ui-terrain`, `--ui-info`.
- Tooltips: `--ui-tip-bg`, `--ui-tip-rim`, `--ui-tip-key` (`#f2d64b`, hotkeys
  and times only), `--ui-tip-text`, `--ui-tip-shadow`.
- Type: `--ui-font` (Barlow), `--ui-font-display` (Barlow Condensed),
  `--ui-font-mono` (JetBrains Mono); sizes `--ui-fs-xs/s/m/l` (10, 11, 13,
  15) and the board's scale `--ui-fs-display` 44, `--ui-fs-title` 26,
  `--ui-fs-section` 20, `--ui-fs-label` 14, `--ui-fs-body` 15 (Barlow
  Condensed 700 in capitals for the first three, 600 for labels), tracking
  `--ui-track-{display,title,section,button,label}`, `--ui-lh-body`.
- Space and shape: `--ui-space-1` to `--ui-space-7` (4, 8, 12, 16, 24, 32,
  48 px), `--ui-radius` (2 px), `--ui-focus-ring` and `--ui-focus-offset`
  (2 px, 2 px), shadows `--ui-shadow` (dialogs), `--ui-shadow-pop`
  (drop-downs), `--ui-shadow-toast`.
- Inside the scaled parts (`#app`, `#game-menu`, the tooltips and dialogs
  listed in theme.css) the sizes and spaces follow the UI scale (`--ui-px`).

**Fonts**: `css/fonts.css` (written by `tools/gen-fonts.mjs` from the
pinned `@fontsource/*` packages; do not edit) declares Barlow 400 to 700,
Barlow Condensed 500 to 700 and JetBrains Mono 400 to 700, Latin subset,
woff2, `font-display: swap`. The files and their OFL licences are in
`apps/game/fonts/`. The game links `css/fonts.css` and preloads
`fonts/barlow-latin-400.woff2` and `fonts/barlow-condensed-latin-700.woff2`;
the website links `/lib/css/fonts.css` and preloads the same two from
`/lib/fonts/`. In `dist/` the game's references point at `/lib/fonts/` too
(`tools/share-assets.mjs`), so there is one copy for both. `font-src 'self'`
in the CSP allows them; COEP on `/play` allows same-origin files.

**Controls** (`js/ui/controls.js`, styled by `css/controls.css`). Every
builder returns its elements and `get`/`set`; callbacks fire on user
changes only, never on `set()`.

| Builder | Returns | Notes |
|---|---|---|
| `toggle({ id?, label, hint?, checked?, disabled?, title?, rowClass?, onChange?(on) })` | `{ row, input, label, get, set }` | switch row; `switchInput()` alone |
| `checkbox({ ... })`, `checkInput({ ... })` | as toggle | |
| `segmented({ name?, id?, label, options: [{ value, label, disabled?, title? }], value, block?, describedBy?, disabled?, onChange?(v) })` | `{ root, inputs, labels, get, set, setDisabled, setTitle }` | 2 to 5 choices, lamp on the chosen one |
| `slider({ id?, label, min, max, step?, value, format?, disabled?, rowClass?, onInput?(v) })`, `styleSlider(input)` | `{ row, input, output, get, set }` | |
| `selectPlate({ id?, label \| labelledBy, describedBy?, options, value?, placeholder?, disabled?, block?, small?, title?, sheet?: 'auto'\|'always'\|'never', className?, onChange?(value, option), onOpen?, onClose? })` | `{ root, button, listbox, panel, get, set, option, setOptions(options, value?), setDisabled, setOptionDisabled(value, off, title?), open(at?), close(focus?), isOpen, isSheet, destroy }` | options `{ value, label, hint?, disabled?, title?, led? }` or groups `{ label, options }`; values compare as strings |
| `selectRow({ id?, label, hint?, rowClass?, ...selectPlate })` | `{ row, label, select }` | label + select row (`.ui-row-choice`) |
| `stepper({ id?, label \| labelledBy, describedBy?, values, value?, format?, disabled?, block?, decLabel?, incLabel?, onChange?(v) })` | `{ root, field, dec, inc, get, set, setValues(values, value?), setDisabled }` | discrete values, the value in mono |
| `tabs({ id?, label, vertical?, value?, tabs: [{ id, label, panel?, disabled?, title? }], onChange?(id) })` | `{ root, buttons, get, set, setDisabled }` | panels get `role=tabpanel` and `hidden` |
| `badge(kind, text, { led?, title? })` | element | kinds `BADGE_KINDS`: neutral, accent, ok, warn, bad, info, hazard, allies, soviet; names `BADGE_ALIASES`: ready, online, host, ingame, modded, locked, full, kicked, waiting, away, primary, ai, spectator, offline |
| `led(state, label?)`, `setLed(el, state)` | element | `LED_STATES`: off, on, ok, warn, bad, info; decorative unless `label` |

- **Select**: the WAI-ARIA collapsible listbox. The button has
  `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls` and is named by
  the label and the value; focus moves to the listbox
  (`aria-activedescendant`). Keys: on the button Down, Up, Home, End and
  typing open the list (Enter and Space click it); in the list Up, Down,
  Home, End, Page Up, Page Down move (disabled options are skipped, no
  wrap), typing jumps (`TYPEAHEAD_MS` 500; one letter again cycles), Enter
  or Space chooses, Tab chooses and moves on, Esc closes without a change
  and stops there (`stopPropagation`; a handler on the window in the
  capture phase still sees it first, see the key rule below). Focus returns
  to the button. A press outside closes without a change. The list is a `popover="manual"`
  in the top layer (over modal dialogs, not clipped by scrolling cards),
  placed at the button through `--sp-left`, `--sp-top`/`--sp-bottom`,
  `--sp-width`, `--sp-max-h`; above the button when there is no room
  below. In the phone layouts (`selectSheetMode(w, h)`, js/layout.js) it is
  a sheet at the bottom (`.ui-sp-sheet`) with the label as title, a close
  button and 44 px options; a tap on the dimmed area closes it. A resize
  across that breakpoint reopens the open list in the other mode.
- **Unmounting**: an open list keeps listeners on the document and the
  window. Screens call `destroy()` on a select they remove (or `close()`
  before hiding it); a list whose control left the page also closes itself
  at the next press, scroll or resize.
- **Screens with global key handlers** (a keydown listener on the window or
  the document, often in the capture phase, such as the game menu and the
  statistics): let the key through, without `preventDefault` or
  `stopPropagation`, when `event.target` is inside `[role=listbox]`,
  `[role=spinbutton]` or `[role=tablist]` (`target.closest(...)`), so the
  control gets its arrows, Home/End, typing and Esc. Esc in an open list
  closes the list, not the menu.
- **Stepper**: an ARIA spinbutton (`aria-valuenow` is the index,
  `aria-valuetext` the formatted value); Up/Right and Down/Left step,
  Page Up/Down step a tenth, Home/End go to the ends; the minus and plus
  buttons are for the pointer (`tabindex=-1`) and disable at the ends.
- **Tabs**: roving `tabindex`, arrows (Up/Down when `vertical`), Home/End,
  automatic activation; disabled tabs are skipped.
- Class names for screens: `.ui-row`, `.ui-row-switch`, `.ui-row-check`,
  `.ui-row-slider`, `.ui-row-choice`, `.ui-label`, `.ui-hint`, `.ui-value`,
  `.ui-field` with `.ui-field-label` and `.ui-field-error`, `.ui-input`,
  `.ui-select` (native select look, until every select is a plate),
  `.ui-switch`, `.ui-check`, `.ui-segmented`, `.ui-slider`,
  `.ui-select-plate` (`.ui-block`, `.ui-sm`), `.ui-sp-*`, `.ui-stepper`,
  `.ui-tabs` (`.ui-vertical`), `.ui-tab`, `.ui-badge-*`, `.ui-led-*`.
  Every animation has a `prefers-reduced-motion` rule and every state a
  `forced-colors` rule; rows are at least `--ctl-row` (44 px on touch).

**Patterns** (`css/patterns.css`, tokens only): `.ui-panel`, `.ui-card`,
`.ui-well`, `.ui-plate` (theme.css, riveted), `.ui-hazard`,
`.ui-hazard-rule`, `.ui-head` with `.ui-head-title` and `.ui-head-sub`,
`.ui-title`, `.ui-section-title`, `.ui-caps`, `.ui-num`, `.ui-money`,
`.ui-muted-text`, buttons `.ui-btn` with `.ui-btn-primary`,
`.ui-btn-ghost`, `.ui-btn-hazard` (word in a `<span>`), `.ui-btn-sm`,
`.ui-btn-icon`; `.ui-dialog` with `.ui-dialog-body`, `.ui-dialog-title`,
`.ui-dialog-text`, `.ui-dialog-actions`; `.ui-menubar` with
`.ui-menubar-brand` and `.ui-menubar-item[aria-current]` (a `.ui-led`
inside); `.ui-brand` with `.ui-brand-emblem` and the word (in a `.ui-brand-word`,
or as plain text in the `.ui-brand` itself as the start screen's
`h1.start-logo` has it; `RA` in a `<span>` takes `--ui-brand-red` either
way, unless the screen's sheet colours it);
`.ui-slot-row` with `.ui-slot-strip` (`--slot-color` set from script);
`.ui-table` (`.ui-table-head`, `[aria-selected=true]` rows); `.ui-toast`;
`.ui-meter` with `.ui-meter-seg.ui-ok|.ui-warn|.ui-bad`; `.ui-progress`
(`--ui-progress` set from script).

**Tooltips** (`css/tooltip.css`, `css/worldtooltip.css`): Red Alert's dark
panel (`--ui-tip-*`), the name in Barlow Condensed 700 (no capitals, no
tracking), hotkeys in `--ui-tip-key`, description in `--ui-tip-text`,
production stats in mono. The logic (`js/ui/tooltip.js`,
`js/worldtooltip.js`) is unchanged.

**Logo** (`tools/gen-brand.mjs`, output in `apps/game/brand/`, published
under `/lib/brand/` for the website): `emblem.svg` (with the plate, 40 px
and larger), `favicon.svg` (the simplified one-colour emblem: the favicon
and every mark under 40 px), `wordmark.svg`, `favicon-16.png`,
`favicon-32.png`, `apple-touch-icon.png` (180 px, opaque). Presentation
attributes only; `node tools/gen-brand.mjs --check` and
`tools/gen-brand.test.mjs` keep them in step with the script.

### The game menu, the guide and the tour (`apps/game/js/gamemenu.js`, `guide.js`, `guideview.js`, `tour.js`, `netmenu.js`)

The design boards GameMenu, Options, Controls, Guide, GuideTour, Sound,
Debug and NetMenu.

- **Game menu** (Esc, the HUD's Menu button): the actions on the left
  (Resume; Guide with its progress; Statistics; the record actions;
  Settings; Network in online games; Sound; Music; Original content;
  Controls and hotkeys; Fullscreen; Release notes; Restart; Surrender,
  Leave, Exit at the bottom) and the game info on the right (Objectives,
  Briefing, Options as `tabs()`; every player with a lamp and its state in
  words, Playing, Defeated or Won, and the tags You and AI with the
  difficulty; the weather), stacked below 760 px of card width (container
  `gm`). Single player pauses, online games do not.
- **Keys**: the menu listens on `window` in the capture phase. A key whose
  target is a control of the menu reaches it and stops at the card, so the
  game never sees it: an open select list and text fields get every key;
  tab bars, steppers and radio groups their arrows, Home, End and Page
  keys; buttons the rest, after the menu's own hotkeys (fullscreen, mute).
  Every other key is stopped in the capture phase.
  Esc in an open select list only closes the list; otherwise Esc goes back
  a page or closes the menu. While a hotkey waits for its new key, every
  key goes to the rebinding.
- **Settings**: one page with vertical tabs Game (scrolling, health bars,
  chat lines, pausing, the three `net.*` switches), Graphics (the texture
  pack cards over `game.graphics`, `webra2d | webra3d | original`, with
  their install state; UI scale, game scale, battlefield zoom
  `zoomFactor`, resolution, low quality, reduce motion, fullscreen),
  Controls (right click in the build menu, mouse capture, the fixed mouse
  and touch controls), Hotkeys (search by command, group or key; groups;
  Change, Clear, Reset, Reset group; Reset all), Sound (the Sound dialog's
  settings beside the music player), Privacy, Advanced (recording the start
  of every game). Every tab's panel is in the DOM (hidden but one); "Reset
  this section" puts back that tab's settings (`SECTION_SETTINGS`; Privacy
  has none). The header says whether the settings sync with the account
  (`syncStatus()`).
- **Network tab** (online games, `opts.net = { source, players() }`):
  `source` is the session's `NetQuality` (protocol 8, `js/netquality.js`:
  events `players`, `self`, `waiting`, `stalls`, `requestStalls()`),
  `players()` the game's players `{ client, name, color }`. `NetHistory`
  keeps the last minute of pings and the stalls from the game's start.
  The tab shows tiles (your ping, jitter, late pings, the slowest player),
  the chart with the stalls marked, the table per player (quality in
  words), the waiting time (the server's stall log once it answers) and the
  three switches. The HUD's signal bars open it with
  `window.dispatchEvent(new CustomEvent('webra:open-network'))`
  (`OPEN_NETWORK_EVENT`); without a source the event does nothing.
  `js/main.js` hands `onStartGame`'s `net` to the menu; the online screen's
  work (work/onlineui) provides it as its canonical net object `{ quality,
  source, roster, you, players() }`, of which the menu reads `source` and
  `players()`. Until that is merged online games have no Network tab.
- **Guide** (texts: `GUIDE` in `js/help.js`): seven chapters of steps. A
  step ticks off by itself (`js/guide.js` `GuideTracker`) from the local
  player's engine events (MCV deployed, structure placed, unit produced,
  building powered down, support power ready, lightning), the player state
  every 100 ms (ore delivered: the stored ore goes up; low power; the sky's
  thunderstorm), the orders given through the UI's game (`withGuide`, a
  wrapper like `withTargetLines`) and signals (a team chat line, an online
  game); explaining steps tick off when their chapter is shown. Skip this
  step ticks one off by hand. The tracker follows skirmish games, missions
  and online games of the local player, never replays or spectators.
  Progress is the declared setting `guide.done` (`{ stepId: true }`); ids
  the game does not know are kept.
- **Tour** (`js/tour.js`): a card above the command bar in the player's own
  skirmish games (a skirmish save too; never missions, online games,
  replays or spectators) while `guide.tourInGames` is on and a step of the
  first chapter is open. It lights the sidebar's cameo of the step
  (`.sb-card.tour-target`), says "Step done" in a polite live region, has
  Skip step, Full guide (the menu's Guide page) and a close button that
  skips the tour (`tourInGames` off). Done, the tour switches
  `tourInGames` off; turning "Tour in my games" on again in the Guide
  clears the tour's steps (the rest of the guide keeps its ticks), so it
  shows in the next skirmish. It never takes the focus.
- **Sound and Music dialogs**: `.ui-dialog` cards with `.ui-btn` buttons;
  the music player's tracks carry a lamp.
- **Debug menu** (`js/debug.js`): the panel on the right with a hazard
  stripe, the hotkey, cheats and views as switch rows, the capture length
  as a `selectPlate`; the Performance stats and Frame graph views are a box
  over the top left of the battlefield, shown with the panel closed too.

### Website pages (`apps/website`)

The pages follow the Website and Account boards with the design system's
tokens (`site.css` maps the `--ui-*` names) and the shared controls from
`/lib/` (`/lib/css/controls.css`, `/lib/js/ui/controls.js`). The CSP
(`style-src 'self'`) allows no style attributes: everything is a class in
`site.css` or `account.css`, values set at run time are custom properties
set through CSSOM (`--avatar`, `--fill`, the select plate's `--sp-*`).

- **Header and footer**: the same on every page: the emblem (40 px,
  `/lib/brand/emblem.svg`) and WEBRA, then Multiplayer, Maps, Changelog,
  Account (the current page `aria-current="page"`, accent text and a rule)
  and Play. Under 680 px a Menu button opens the links.
- **Home**: the hero's battlefield is an inline SVG animated with SMIL (no
  script, no game sprites). Under `prefers-reduced-motion` the stylesheet
  shows a still copy instead (no script needed); otherwise a Pause button
  stops it (`svg.pauseAnimations()`), and it rests off screen. The badge over the
  hero comes from `GET /api/site` (`registration.open`,
  `registration.approvalRequired`) and `version.json`
  (`assets/site-data.js` `betaBadge`: "Closed beta · v0.17"); the sign-up
  buttons say "Request access" during a closed beta and lead to the sign-in
  when signing up is closed. Texture packs are explained with pictures, not
  chosen here.
- **Selects**: the maps page's sort, the admin filters, the admin's user
  form and audit filter and the settings editor
  (`js/account/admin-forms.js`) use `selectPlate`; `assets/ui.js`
  `selectField(label, options, { value, help, disabled, onChange })` gives a
  labelled one. The website has no native `<select>` left.
- **Multiplayer, "Join with a code"**: the field takes the six characters
  (the dash fills in) or a pasted link (`assets/invite.js`
  `typedInviteCode`), looks the code up (`GET /api/invite/:code`) and shows
  the lobby or why not (unknown, expired, full: spectators); Join opens
  `/join/<code>`, which the Worker sends into the game.
- **Account page**: a side menu with the account's state on a lamp and a
  lamp per section (the one in view is `aria-current`); sections Profile
  (with Email), Sign-in methods (Password with `passwordChangedAt`,
  Passkeys, Discord, each a row with a lamp and a detail), Replays (with a
  bar of the space used), Friends, Devices, Your data. A pending account
  gets a card with Check again (and back to the game once approved). From
  the play gate (`?returnTo=`) the sign-in shows "Sign in to play", and a
  game link with `?invite=` (an invite link `/join/<code>` while signed
  out) shows the lobby the code names. A server that cannot be reached
  gets "No connection" with Try again.
- **Friends** (accounts API 5.11): grouped In a game, In a lobby, Online,
  Offline with a search; Join (`/play/?join=<session>`) when the lobby is
  joinable, Spectate when the friend allows it; More: Remove, Block;
  requests (Accept, Ignore; sent ones Withdraw), lobby invites (Join by
  `/join/<code>`, Dismiss), add and block by username, blocked players with
  Unblock, and the switches `social.showOnline`, `social.friendsJoin`,
  `social.allowSpectate` (written to the settings document). Polls every 30
  s while the tab is visible; a server without the routes (404) says
  friends are not available.
- **Changelog**: each release as on the Release notes board: "Version
  x.y.z", the date, a Live badge for the running version, and per kind of
  change and part of the game a tagged heading (New, Fixed, Faster,
  Breaking; `site-data.js` `releaseTag`).
- **Shared with the game and the server**: the code rules come from the
  protocol (`/lib/protocol/invite.js`: `normalizeInviteCode`,
  `formatInviteCode`, `invitePath`), the friends client from the game
  (`/lib/js/account/friends.js` `FriendsClient`), the poll interval and
  the privacy reader from the protocol (`/lib/protocol/friends.js`
  `FRIENDS_POLL_MS`, `socialSettings`) and the privacy defaults from the
  protocol's accounts module (`/lib/protocol/accounts.js`
  `SOCIAL_SETTING_DEFAULTS`). The routes are the Worker's:
  `/join/<code>` (the redirect into the game), `GET /api/invite/:code` and
  `/api/account/friends/*` (see "Invite codes" and the accounts API 5.11).

## 6. Deployment

One Worker named `webra` on the `WebRA` Cloudflare account serves
everything on `webra.sherin.dev`:

- `/` and `/assets/*`: `apps/website` build output
- `/play` and `/play/*`: `apps/game` (with `pkg/` from wasm-pack and
  `protocol/`), served by the Worker's play gate (`apps/server/src/playgate.js`)
  only to accounts that may play while the site setting `gameRequiresAccount`
  is on (accounts API, section 7.1): page loads without access go to
  `/account/?returnTo=<path>`, other requests get 401 or 403
- `/lib/*`: the game modules and stylesheets the website's pages load,
  copied from `apps/game` with the same layout (`tools/shared-modules.mjs`
  lists them from the website's `/lib/` imports and links), with the logo
  (`/lib/brand/`) and the fonts (`/lib/fonts/`, also used by the game:
  `tools/share-assets.mjs`); public. No website page, script or stylesheet
  loads from `/play` (the build fails otherwise)
- `/api/*`: the Worker's fetch handler (`apps/server/src`)

`wrangler.jsonc` runs the Worker first for `/api/*`, `/play` and `/play/*`;
every other path is answered by Workers Static Assets with `_headers`.

Build: `npm run build` assembles `dist/` (website at the root, game under
`play/`, the website's shared modules under `lib/`) and writes `dist/version.json` and `dist/release-notes.json`. The
release notes are CHANGELOG.md (written by release-please) as data, parsed by
`tools/release-notes.mjs`: the newest 30 releases, newest first, each with
`version`, `date`, `compareUrl` and `sections` of entries `{ scope, text,
commit, url, refs? }`, plus `scopes` (commit scope to the name players read).
The game loads it from `../release-notes.json` for its "What's new" dialog
(once per new version, remembered in localStorage under
`webra.releaseNotes.seen`) and its Release notes entries in the lobby and the
game menu; the website's `/changelog` page shows the same file. The build
fails when CHANGELOG.md has no release for the version in package.json. Deploy: GitHub Actions `deploy.yml` runs `wrangler deploy` from
`apps/server` on every push to `main` after CI passes, using the repository
secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Storage: Durable
Objects (SQLite) for sessions, D1 database `webra` for maps, the session
directory, accounts and everything around them (docs/accounts-api.md). A
daily cron trigger runs the accounts retention job.

## 7. Replays and saves

Every game records itself (apps/game/js/replay.js): the engine runs in
lockstep mode also in single player, so the local player's orders go through
the outbox and are applied as frames, exactly like online. A replay or save
file is JSON, validated by `parseReplay` in packages/protocol (src/replay.js)
before any use. The game passes its own build (`parseReplay(text, { version
})`): a file made by another build is checked only up to its header (format,
kind, mode, engine, createdAt, title) and resolves with `foreign: true`, so the
player is told which version made it instead of seeing a validation error
about options added since; files of the running build are validated in full:

```jsonc
{
  "format": "webra-replay", "version": 1,
  "kind": "replay",                 // or "save" (skirmish, mission, or online with `online`)
  "mode": "skirmish",               // or "online", or "mission" (section 9)
  "engine": "0.3.0+abcdef12",       // Game version(): files only load in the same build
  "createdAt": 1760000000000,
  "title": "England vs 1 opponent", // 1..64 chars
  "options": { ... },               // engine game options (section 3), closed slots left out
  "map": null,                      // or the canonical map JSON text (section 2), as played: never upgraded
  "mapHash": null,                  // sha256 of `map`, checked on load
  "player": 0,                      // the recording player, null for a spectator
  "ticks": 1200,                    // ticks recorded
  "frames": [[12, [[0, [{ "o": "move", ... }]]]]],  // non-empty frames, tick < ticks, increasing
  "hashes": [[250, "0123456789abcdef"]],           // state hash after N ticks, every 250 ticks
  "online": { "id": "0123456789abcdef" },          // online saves only: the server's record (section 4)
  "mission": { "id": "allies-01", "hash": "<sha256>" }, // missions only (section 9)
  "chat": [[40, 0, "Alice", "glhf", 0]]            // online replays only, optional (below)
}
```

A mission replay or save (`mode: "mission"`) has no `map` (null) and names
its mission file instead: `mission.id` (`[a-z0-9][a-z0-9-]{0,63}`, the file
`apps/game/missions/<id>.json`) and `mission.hash` (SHA-256 of the file's
text). Its `options` are the mission's start options, `{ seed, gameSpeed,
options, movement, factoryLoss }` (`movement` and `factoryLoss` as in
section 3: missions started now play `openra`; left out by saves and
replays from before them, which play `webra`)
with at most 8 mission options (`options.difficulty`: `easy`,
...; keys and values `[a-z0-9][a-z0-9_-]{0,31}`, case-insensitive), not
the game options of section 3. The person playing is player 0, so `player`
is 0 and every frame carries player 0's orders only. The loader fetches the
mission file and refuses it when its hash differs (another version of the
game). `packages/protocol/src/mission.js` validates both. An online replay
or save of a co-op mission (`mode: "online"`) keeps the game options and
adds `mission: { id, hash, options }` (section 9, "Co-op online"): a
mission of `COOP_MISSIONS` with this version's file, every player a person.

- Chat: a replay of an online game keeps the chat its recording client
  received (OpenRA replays hold the Chat orders): `[tick, player, name,
  text, channel]`, `player` the sender's seat or -1 for a spectator,
  `channel` 0 all chat, 1 team chat, 2 the spectators' team chat (only the
  team chat of the recording client's own side reaches it), at most 5000 lines in tick order. The viewer shows
  each line as the replay passes its tick (not while seeking); saves never
  carry chat.
- Limits: 32 MiB, eight hours of game time, orders and options as strict as
  the network messages, frame players within the options, map canonical and
  matching its hash. A modded map shows the modded-map warning first.
- Another engine version: a clear message, nothing runs (the simulation can
  differ between builds).
- Playback feeds the frames into a fresh game at the same ticks and compares
  the stored hashes ("this replay no longer matches the game from m:ss").
  The viewer plays, pauses, runs at 1x to 8x, seeks by re-simulating
  (backwards from in-memory snapshots, `Game.snapshot`), and switches between
  the whole map and each player's view with the observer stats. Its bar
  (`js/records.js` ReplayBar) has Download (the file as it was opened,
  `downloadReplayFile`) and Exit, and marks on the seek bar for the part
  already watched (`js/replaymarks.js`, from `Game.observer_stats`): a
  player defeated (at `defeatedAt`), a structure destroyed, heavy fighting
  (6 or more units lost within 250 ticks); frames more than 125 ticks apart
  (a seek) count no losses. Presentation only.
- Restart (`js/gamesession.js`): single player games, loaded saves and the
  map editor's test play restart from tick 0 with the same options and map
  in the page. The loading screen shows at once; the game is left (its
  replay is queued for the account with the result `left`, a performance
  capture ends) and taken down (`js/disposer.js`: the frame loop, the
  simulation worker or the main thread game (`Game.free`), the GPU
  textures, the game's sounds, input, hotkeys, listeners, timers and its
  parts of the screen), then the same start runs again (a skirmish keeps
  its seed, so the generated map is the same; a mission picks a new seed as
  every start of it does). When taking the game down fails part way, the
  page reloads with a `js/restart.js` record instead (sessionStorage
  `webra.restart.v1`, taken once), which starts the same game after the
  reload. The replay viewer restarts playback in place. Online games have a
  rematch instead (section 4), which goes back to the session's lobby
  through a page reload and rejoin.
- A save is a replay of kind `save` whose `hashes` end with the hash of its
  last tick. Loading re-simulates it (fast-forward with progress), refuses it
  when a stored hash does not match, then play continues and the recording
  goes on from the save. Saves go to the browser (IndexedDB database
  `webra`, store `saves`, at most 50) or to a file. A row keeps, besides
  the header fields, `summary` (`saveSummary`: the map's name, the players
  as `replaySummary` lists them, a mission's id and difficulty) and `thumb`
  (`js/savethumb.js`: the map's terrain as the radar draws it, a PNG, WebP or
  JPEG data URL of at most 8192 characters, else null); rows from before
  0.17 have neither and show without them.
- An online save (mode `online`, with `online.id`) ends right after a hash
  tick (`ticks - 1` is a multiple of 25) and is never loaded alone: it is
  resumed online with its players (section 4, "Online saves").
- Replays in the account (accounts API 5.10, `apps/game/js/account/replays.js`):
  while a signed-in, active account has "Save replays to my account"
  (`privacy.cloudReplays`, on by default) on, the game encodes the replay of
  every skirmish, online game, mission and co-op game once, when the whole
  game ended (or this player won) or when the player leaves it first, with
  the result `won`, `lost`, `left` or `spectated`. It is queued in IndexedDB
  (database `webra-replay-uploads`, store `pending`, keyed by account, start
  time and title; at most 10, dropped after 7 days) and uploaded in the
  background (`POST /api/account/replays`), never in the game's frame. The
  server validates it with `parseReplay` (refusing saves), keeps it 30 days,
  at most 100 replays and 100 MiB per account, and lists a summary
  (`replaySummary` in the protocol package: mode, title, engine, start time,
  ticks, map name, players). Watching one downloads the file and checks it
  like a file (above): one made by another engine version shows the version
  message. `/play/#replay=<id>` opens a replay of the account directly (the
  account page's Watch).

## 8. Simulation worker (`apps/game/js/sim`)

The game's simulation runs in a dedicated module Web Worker; the main thread
keeps rendering, input and UI. Determinism does not change: the worker runs
the same engine and the same drivers (`LocalDriver`, `LockstepDriver`,
`ReplayController`, `Recorder`) the main thread ran before, fed the same
orders at the same ticks. `apps/game/tests/sim.test.mjs` plays games through
the boundary (in Node's `worker_threads`) and compares state hashes with the
engine driven directly.

### Modes (`js/sim/modes.js`)

| Mode | When | Render data |
|------|------|-------------|
| `shared` | Module workers, `SharedArrayBuffer`, and the page is cross-origin isolated (`/play` sends COOP `same-origin` and COEP `require-corp`) | Two slots of SharedArrayBuffers per section (sprites, rects, fog, path lines, heat shimmer), one sequence counter per slot (`js/sim/framebuffer.js`) |
| `transfer` | Module workers without isolation | ArrayBuffers transferred with each frame; the main thread returns them with its next step (a pool) |
| `direct` | No module workers, or the worker failed to start (error or 15 s timeout) | Views of wasm memory on the main thread, as before |

`?sim=direct|transfer|shared` asks for a mode; one the browser cannot run
falls back to the next one down. The debug menu's performance stats show the
mode, why it was picked, the worker's time per frame, the step round trip
and (shared mode) frames found overwritten while read.

### Messages

Main thread to worker:

| `t` | Fields | Answer |
|-----|--------|--------|
| `init` | `module` (the compiled engine, or null: fetch it), `mode` | `ready { version, mode, shared }` or `failed { error }` |
| `start` | `id`, `spec` (below) | `result { id, value: info }` (static facts: rules, map size, cheats, start positions, alliances, recorder start, replay length, `weatherJson`: the sky at the start, whose biome picks the terrain atlas and minimap colours, `terrain`: the terrain bytes at the start, so the terrain art and the minimap are made before the first frame (frames carry terrain only when it changed later), `timings { createMs, infoMs }`: the engine's time to make the game, for the performance capture, section 10) |
| `call` | `method`, `args` | none: an order, `set_selection`, `set_hover`, `set_control_groups`, `set_placing`, `set_audio_events`, `set_health_bars`, `set_building_overlays`, `set_sprite_poses`, `set_original_slots`, `set_death_art`, `set_make_art` |
| `ask` | `id`, `method`, `args` | `result { id, value }`: a fresh query answer |
| `command` | `id`, `name`, `args` | `result { id, value }`: `net` (`frame`/`log`/`sync`), `back`, `reattach`, `stop`, `hidden`, `background` (`[on]`: tick a hidden local game on a timer, see "Hidden pages"; answers whether the timer runs; false while held), `begin` (a held game starts, see "Start"; answers whether it was held), `seek`, `setSpeed`, `togglePlay`, `dispose`, `encode` (`save`/`replay`: `{ text, ticks, full }`), `debugStep`, `stateHash`, `tick`, `report` (facts for an error report: `{ engine, mode, tick, hashes }`, the newest state hashes `[tick, hash]` sent online or kept by the recorder) |
| `step` | `req { dt, paused, view, rect, audio, paths, table, queries, instances, perf }`, `recycle` | `frame` |

Worker to main thread, unasked: `event { type, payload }` (`send { msg, epoch }`
for the lockstep driver's network messages, `caughtUp`, `check { ok, tick }`),
`warn`, `failed` (the worker cannot go on; the page says so), and `error {
error: { name, message, stack, context } }`: an error for the error report
(docs/security.md, "Error reports"). The worker has no reporting of its own;
the main thread reports it when reports are on (`js/telemetry`).

Engine panics: the wasm32 engine aborts on a Rust panic, which JavaScript sees
as `RuntimeError: unreachable`. The engine's panic hook
(`engine/src/panic_report.rs`, installed at module start) keeps the message,
source location and tick, and the free function `take_panic()` returns them
once as JSON `{ message, location, tick }`. `SimCore` (`js/sim/core.js`)
turns every trap of a call into the engine into an `EnginePanic` (with the
panic's message and location) or `EngineTrap` error carrying
`webraContext { engine, mode, tick, hashes, panicTick }`
(`js/sim/engine-error.js`); after one, the game is stopped and every later
call throws the same error.

Start specs: `skirmish { options, map, player, recorder }`, `mission {
mission, options, recorder }` (the mission file's text and its start
options, section 9), `save { replay, mission? }`, `replay { replay,
mission? }` (a mission save or replay also gets its mission file's text),
`stress { seed, units, size }`, `online { options, map, player, spectator,
delay, rejoining, recorder }`, each with `tickMs` and `held` (the page
always passes true: the game waits for `begin`, see "Start"). A mission's `info` adds
`mission { camera, players }`: where the camera starts (world pixels) and
the players' names and colours in engine order.

A frame carries: ticks run and the interpolation `alpha`, the tick, the
worker's simulation time, `busy` (loading a save, catching up, seeking),
driver status (save loading and its error, online catch-up and stall time,
replay position, recorder full), answers to the step's queries, sound events
(none while busy), the actor table when it changed, terrain bytes when they
changed, the sky (`weather`: `Game.weather_json()` text, for the weather
renderer, lightning, thunder and the HUD badge), and the render data: sprites
and rects (8 floats each), fog bytes of `view`, lines (9 floats each:
`[x0, y0, x1, y1, r, g, b, a, width]`, engine/src/paths.rs `push_line`:
range circles, rally lines, path lines when `paths` is set, target lines),
and heat shimmer instances (`heatCount`, 4 floats each,
`Game.build_heat_fx` for `view` and `rect`; on both instance paths). With
`instances: 'gpu'` (below) it carries tick-rate records and fog instead of
sprites, rects and fog, only when they changed, plus `instances`, `buildMs`
(time spent building render data this step) and `renderBytes` (render data
handed over this step). Every frame carries `simFrameMs` (the ticks, for
the debug panel). With `req.perf` (a performance capture records, section
10) it also carries `tickMaxMs` (the slowest tick of the step; under the
lockstep driver and in replays, which tick inside, the mean of the step's
ticks), `queryMs` (the query answers), `stepMs` (the whole step in the
simulation) and `actors` (actors alive); without it these are null and the
step reads the clock no more than before. In a mission it also carries `mission { state,
events }`: `Game.mission_state()` text when a tick ran (else null) and the
`Game.take_mission_events()` text of the step (null when empty or busy); the
handles keep the newest state and queue the events (`MissionFeed`).

Messages are handled in order. A `call` or `ask` sent before a `step` is
applied (or answered) before that step's ticks, so an order reaches the same
tick it would have reached on the main thread, and an `ask` sees every order
sent before it. One step is in flight at a time; wall time that passes
meanwhile goes with the next step, so the simulation keeps its pace and the
main thread never waits. Online sends carry the connection epoch they were
made under; after a reconnect (`reattach`) the main thread drops sends made
for the old connection.

Hidden pages: a hidden page gets no animation frames, so no `step`. Online,
`hidden` makes the lockstep driver run frames as they arrive. A local game
(skirmish, mission, a loaded save; never online, a replay, the stress test
or a save still loading) that is not paused gets `background [true]` from
the main thread while the page is hidden and Settings > "Pause when the game
is hidden" is off (the default; on, the game menu opens and pauses it):
`SimCore.setBackground` then ticks it on a `setInterval` of `tickMs`, each
wake advancing by the wall time since the last one, at most
`BACKGROUND_MAX_MS` (1000) of it (more is dropped: no burst after a
suspended page). The ticks are the same ticks a frame would run (same
orders, same state hash; `apps/game/tests/sim.test.mjs`); their sound
events are dropped, mission events wait for the next frame. `background
[false]` (shown again, or paused) stops it, as do an engine error (the next
`step` throws it) and disposing a direct host. In the worker the timer is
the worker's own, which desktop Chromium browsers and Firefox usually do not
throttle; in direct mode it is the page's, throttled to about once a second
(Chrome: once a minute after 5 minutes hidden and silent). Browsers that
suspend hidden pages (Safari, phones) stop it; the game then stands still
until shown.

Start: a game starts only once its loading screen is gone. Every start of
the page (skirmish, a mission, Restart and Next mission in place, a loaded
save, a replay, the map editor's test play, the stress test, an online game)
passes `held: true`, and one sequence in `js/main.js` runGame follows:

1. The game is made at tick 0 and held (`SimCore.held`): `step` runs no
   tick and banks no wall time, `background [true]` does not start the
   timer, `debugStep` does nothing, and the lockstep driver does not run
   the frames that arrive while the page is hidden. Only fast-forwards
   through recorded history go on: a save re-simulating (with its
   progress), an online catch-up after a rejoin.
2. The frame loop runs from the end of the setup with `dt` 0
   (`js/gamesession.js` GameStart): the first frame draws the map at tick 0
   behind the screen and begins the screen's close (`FirstFrameGuard`,
   `LoadingScreen.done`). The input stays suspended.
3. The screen closes after the stylesheet's transition or animation on
   `#loading.is-closing`, if any (at once with "Reduce motion" or none;
   the fade itself is css/loading.css's), staying modal; its end event,
   or a timer of its duration plus `CLOSE_GRACE_MS` (100) in a tab that
   runs no transitions, hides it and resolves `closed`. A transition must
   change a property on `.is-closing`, else no end event comes and the
   timer ends the close. A start whose screen failed (`LoadingScreen.fail`,
   from anywhere) never resolves `closed`, so its game never begins.
4. Then `GameStart.begin`: `begin` goes to the simulation (its time
   counts from now, so the screen's time is never caught up in a burst of
   ticks), the frame clock restarts, the input follows, a hidden page's
   background timer may start, "Battle control online" plays, and an
   online player (not a spectator, who holds no seat) sends
   `loaded {}` on its connection (`js/net.js sendLoaded`) once the
   protocol defines `C2S.LOADED` (work/netround's protocol 8 round, with
   the server holding the frames until every seat sent it); without it
   nothing is sent.
   Online, the game then runs as the server's frames arrive, as before.

A game taken down before its screen is gone (a restart, leaving) never
starts. `apps/game/tests/startgate.test.mjs` plays these starts headless
with a Normal AI and checks that nothing changed until `closed` and that
the game then runs in real time.

### Shared frames

Per slot: a sequence counter, odd while the worker writes. The worker writes
the slot it did not publish last, makes the counter even again, then stores
the slot as the latest. The reader takes the slot and counter from the frame
message, reads (uploads to the GPU), then checks the counter: changed means
the slot was written over meanwhile and the frame is counted as torn (the next
frame replaces it). With one step in flight the worker only writes the other
slot, so this does not happen in normal play; the check is the guarantee. A
section that outgrows its buffer gets a new SharedArrayBuffer for that slot,
sent with the frame.

### Instance paths (`js/crowd.js`, `js/crowd-gpu.js`, `shaders/instances.wgsl`)

What the renderer draws for the simulation reaches it on one of two paths.
The GPU path is the default; the CPU path is the fallback.

| Path | Built by the simulation | Per render frame on the GPU side |
|------|-------------------------|----------------------------------|
| `cpu` | `Game.build_render(view, alpha, rect)` every step: sprites and rects interpolated by `alpha` and culled to `rect` | Upload and draw them |
| `gpu` | `Game.build_render_records(view)` only when the tick, `view` or the render epoch (any `call`, `seek`, `debugStep`) changed: every sprite and rect of the whole map as a record with both ends of its interpolation and the cull of its group; sent with the fog | A compute pass interpolates the records by the frame's `alpha`, culls them against the camera, compacts the visible ones in order and writes the instance count of a `drawIndirect` |

Both paths run the same engine code (`engine/src/instances.rs`, `Sink`): in
`Eval` mode each record is evaluated at once, in `Record` mode it is stored.
Evaluation per record, in 32-bit floats, in this order:

- reference point `p = from + (to - from) * alpha`; culled unless the
  margin is negative or `p` lies inside the view grown by the margin
- angle `(angle + turn * alpha) * TAU / 1024` (raw units, `turn` already
  wrapped by `angle_diff`, so facings interpolate the short way round)
- with an extra part: plus the offset `o0 + (o1 - o0) * alpha`; plus an arm
  `(sin b * forward + cos b * right, -cos b * forward + sin b * right)` with
  `b` the body angle interpolated like the angle; angle times `angle_mul`
  plus `angle_add`; scale and alpha interpolated to `scale1`, `alpha1`

Flat layouts (f32): sprite record `[x0, y0, x1, y1, margin, angle, turn,
sprite, team, scale, alpha, flash, extra]` (`extra` is an index into the
extras array or -1), extra `[ox0, oy0, ox1, oy1, forward, right, body,
body_turn, angle_mul, angle_add, scale1, alpha1]`, rect record `[x0, y0, x1,
y1, margin, ox, oy, w, h, r, g, b, a]`. The output is the CPU path's
instance layout (8 floats), so the sprite and rect pipelines are unchanged.

The compute pass has three dispatches per kind (workgroups of 256): visible
flags and a total per block, an exclusive scan of the block totals in one
workgroup (its sum is the draw's instance count), and a write of each
visible record at its block offset plus its rank in the block. The draw
order is the record order, which is the CPU path's order (the renderer does
not sort by y). The view for culling is the camera's rectangle of the frame
being drawn; the CPU path culls with the rectangle sent with the step.

Records go to the main thread as transferred buffers in every worker mode
(the shared double buffer is not used for them), and the host keeps the
latest records and fog until newer ones arrive. Between ticks a GPU path
frame carries no render data at all (path lines excepted, when on).

The main thread uses the CPU path by default: the GPU pass is opt-in with
`?instances=gpu` until it has been seen working in browsers. With that
parameter it uses the GPU path unless the debug menu's "CPU instance path"
box is ticked or the pass is unavailable: no
compute workgroups of 256, fewer than 5 storage buffers per compute stage,
too little workgroup memory, a shader or pipeline error, or records larger
than the device's storage buffer or dispatch limits (the renderer then
switches to the CPU path for good). The debug menu's performance stats name
the active path, why, and the frame's build time and render data size.

Tests: `engine/src/tests_instances.rs` checks that records evaluated at any
alpha and view equal `build_render` bit for bit (every actor type, effects,
crashes, bombs, ability effects, overlays, AI games, the observer view);
`apps/game/tests/crowd.test.mjs` runs `js/crowd.js` (the shader's math and
compaction, in JavaScript) on records from the wasm `Game` against
`build_render` (bit for bit, arms within 1/1000 px since sine and cosine
differ between the engine's libm and JavaScript) and checks the compaction
across blocks; `sim.test.mjs` checks records crossing each boundary mode.
`cargo run -p shader-check` validates the shader. The GPU itself is not
tested or measured headless.

### Sprite poses and pre-rendered art (`js/content`, `shaders/sprite.wgsl`)

WebRA's own sprites are single frames the shader rotates by the instance
angle. Original graphics and texture packs are pre-rendered per facing and
animated, the OpenRA way, so the renderer needs to know what each actor is
doing. So is WebRA's own pixel art (`js/art/pixel.js`, from
`tools/gen_pixel_art.py`: the oil derrick `OILB`, idle and damaged frames;
the Black Hawk `MH60` and the Mobile Flak `FTRK`, 32 facings, the rotor and
the turret), which every atlas holds. `Game.set_sprite_poses(true)` (a render setting,
off by default; the main thread turns it on when the atlas holds such art,
`buildAtlas` `poses`) makes body sprites
carry a pose in the sprite id:

    id = slot + 4096 * (pose + 32 * age)

`slot` is the sprite slot as before (actor `t`: body `2t`, second part
`2t + 1`; specials after them, the leftover specials of
`apps/game/js/art/leftovers.js` at `2 * actors + 68`: fire, smoke, the
PRIMARY tag and the crate pickup signs), always below 4096. Poses
(`engine/src/render.rs` `Pose`, `js/content/sequences.js` `POSE`): 0 idle,
1 move (the actor moved this tick), 2 attack (attacking and standing), 3
damaged (structure below half health, OpenRA's DamageState.Heavy), 4 make
(structure placed during the game, `age` = ticks since then, while it is
being built: the simulation's `make_until`, from the rules'
`building.make_ticks`, the same for every player whatever their art; see
"Make animations" below; `Game.set_make_art(types)` names the types whose
art plays a make animation, the atlas's `makeArt`, and the others fade in
from 25 percent over that time; a render setting: players with different
art keep the same simulation and state hash, `tests_poses.rs`
`poses_never_change_the_simulation`), 5
harvest, 6 dock (unloading at the refinery), 7 still (no power, or a
remembered structure under fog), 8 damaged and still, 9 and 10 aux idle and
aux move (a second overlay in the same slot: the Chinook's rear rotor on the
ground and in the air), 11 and 12 active and damaged active (working:
resupplying, the Tesla charge, a launch, placing, turret recoil, the
landing craft's doors open, the V2 launcher reloading), 13 parachute (a
paratrooper falling), 14 active end (the landing craft closing, the
harvester leaving the refinery played backwards), 15 the second stand
sequence and 16, 17 the idle animations of a standing soldier (`age` = ticks
into the animation), 18 to 23 death sequences die1 to die6 and 24 a crushed
body (`age` = ticks since the death), 25 a soldier's second attack sequence
(AttackSequences: picked per shot, Tanya's shoot-right), 26 the make
animation backwards (a structure being sold, a Construction Yard packing
up; `age` = ticks since the order; art without one fades out). Dying soldiers are drawn with their
death sequences only for actor types `Game.set_death_art(types, ticks)`
names (the atlas's `deaths`; `ticks`, the atlas's `deathTicks`, has eight
lengths per type: die1..die6, crushed and the longest idle animation, so a
body stays until its sequence ended and an idle animation plays to its end);
others show the built-in bodies. Walls report idle or
damaged with `age` = their connection mask (OpenRA WithWallSpriteBody: 1
north, 2 east, 4 south, 8 west, same type only). Building turrets report
damaged too. Poses are read from the world and never written: the state
hash is the same with poses on or off (`engine/src/tests_poses.rs`,
`apps/game/tests/content.test.mjs`). Both instance paths carry the id
unchanged.

Frame table (`js/sprites.js` `FRAME_FLOATS` = 16, `Frame` in the shader):
`uv`, `size` (w, h, offset x, offset y in world pixels), `anim` and `seq`.
A slot whose `seq.y` (pose count) is non-zero is a pose table: entry
`seq.x + pose` (clamped to the count) is a descriptor with `anim` = (first
frame, frames per facing, frames per second, mode) and `seq` = (facings,
flags: 1 classic facings, 2 free rotation; interpolated facings; lead-in
frames). Modes: 0 loop on the render clock, 1 once from `age` (then the idle
descriptor), 2 first frame, 3 frame `age`, 4 lead: the first lead-in frames
once from `age`, then the rest looping on the render clock (the harvester's
dock, the landing craft's ramp, an opening parachute), 5 once from `age` and
then nothing (deaths). The facing comes from the instance angle:
`a = (1024 - round(angle * 1024 / 2pi)) mod 1024` (OpenRA turns
counter-clockwise), then OpenRA's `IndexFacing` or, for classic 32-facing
sprites, `ClassicIndexFacing`; the frame drawn is `first + facing * length
+ k` and the sprite is not rotated (interpolated facings turn it by
OpenRA's `GetInterpolatedFacingRotation`, with the rest rounded to the
nearest interpolated step where OpenRA truncates it: a heading a unit short
of a frame showed that frame turned a whole step, and WebRA's ships hold
their course a unit or two off, so submarines looked skewed sailing straight). Slots without a pose table work
as before. `Globals.art.x` tells the terrain shader that the atlas holds
tile terrain (bit 1), ore overlay tiles at 192 (bit 2, 4 variants x 12
levels), gem overlay tiles at 240 (bit 4, 4 x 4) and rotating water colours
(bit 8: a pixel with alpha 248 + k shows the k-th of the 7 colours in the
atlas's last pixel row, turned 6.25 times a second on the render clock like
OpenRA's RotationPaletteEffect). With tile terrain a cell names its tile as
R + 256 G (map tiles 0..191 and 256..1023).

Layers over structures (`Game.set_building_overlays`, one value per actor
type): a value below 4096 is the still frame of WebRA's animated layer
(slot `2t + 1` animates, the still frame is drawn without power or under
fog). A value of 4096 or more marks a layer that is a pose table (the
original War Factory roof and door, OpenRA WithProductionDoorOverlay; WebRA's
missile silo hatch, `js/art/animated.js` `BUILDING_WORKING`): the
value is the layer's still pose with `age` = the number of door frames.
With poses on, the engine leaves slot `2t + 1` out while the structure is
built (the make pose: only as long as the make animation plays, like
OpenRA's `build-incomplete` condition, so the War Factory's roof shows the
moment its make animation ends), draws it with the structure's working
pose and its `age` while it works (fx.rs: the silo's hatch opens and shuts
once at a launch, mode 1, then rests on frame 0) and otherwise with the
idle or damaged pose (by damage state only: the door is never paused) and
`age` = the door frame, which the layer shows as is (mode 3). The door frame
(`engine/src/doors.rs`, presentation only, not in the state hash) follows
OpenRA's `PlayFetchDirection`: 0 (shut) while the factory is idle or
building; once it produces a unit, one frame per tick up to the last while
that unit is on its exit cell and not yet idle there, then one frame per
tick back to 0. Under fog the value itself (the layer's still pose) is
drawn.

Slots from the original graphics (`Game.set_original_slots(slots, info)`, a
render setting; `js/content/atlas.js` `originalSlotInfo`, plus the slots of
WebRA's own pixel art, `js/gameart.js` `applyGameArt`, and the actor slots of
texture packs with `"perspective": "classic"`, such as the built-in 3D
minimal pack) are drawn the way
OpenRA draws them: helicopter rotors are OpenRA's rotor overlays (pose 0 the
slow-rotor sequence on the ground, 1 the rotor sequence in the air, 9 and
10 for a second rotor; no WebRA rotor disc or wash), placed like turrets on
ships, turrets on vehicles with a Turreted offset (the Mobile Flak's) and
spinners on units with OpenRA's classic perspective
(`BodyOrientation.LocalToWorld`: the north-south part of an offset along
the body times sin 40 degrees, `render.rs` `classic_offset`); heights of
turrets and overlays are drawn into their frames. Explosions and splashes
with original art play once (pose 4, `age` = ticks since the effect
started, the idle pose is empty) at their own size, without WebRA's
growth and fade, and WebRA's dust cloud is left out; original missiles
and torpedoes pick their facing frame instead of being turned; WebRA's
submerged ripple is not drawn over an original hull. `info` holds
records `[kind, actor type, a, b]`: kind 0 an overlay over a unit without
a turret (the Radar Jammer's and Mobile Gap Generator's dishes; a forward,
b side offset in world units, drawn from slot `2t + 1` with the idle
pose), kind 1 a structure whose body shows the storage level (OpenRA
WithResourceLevelSpriteBody, the silo: `age` = (a - 1) * resources /
capacity of its owner, mode 3), kind 2 the original damage smoke
(milliseconds per frame, start frames, loop frames), kind 5 the ground
shear of an actor type's art (a: the pack's `groundShear` in 1024ths,
clamped to plus or minus 1024): its turret, rotor and muzzle offsets move
a / 1024 world pixels sideways per world pixel south, as its sheared hull
does (`render.rs` `sheared_offset`), so every mount (the Cruiser has two
turrets, the Chinook two rotors) carries its part in every facing.
Presentation only: the state hash is the
same either way.

Sprite slots after the specials: the effects module (`fx_base`: 0 damage
smoke, 1 and 2 the original Tesla zap's bright and dim frames, 3 the
anti-air missile of the weapons in render.json `missiles`: Nike, RedEye and
SubMissileAA fly OpenRA's MISSILE image, every other missile the DRAGON
rocket of the `missile` special), one muzzle
flash per actor type (`muzzle_base + t`) and one explosion per name of
`engine/render.json` (`explosion_base + k`). Specials 5 and 6 (`at_mine`,
`ap_mine`) are reserved: mines are drawn as their actors, and a texture
pack's sprites of those names replace the mine actors' bodies.

`engine/render.json` (generated by `tools/gen_content_tables.py` from
OpenRA's rules and weapons) holds what the engine's effects need
(`engine/src/fx.rs`, presentation only, never in the state hash): the
CreateEffect warheads of every weapon (explosion names, where they show:
ground, open water, ship, air; delay), the missiles drawn as anti-air
missiles (`missiles`), the muzzle flashes of every actor
(Armament MuzzleSequence, LocalOffset, turret), its damage smoke
(WithDamageOverlay) and its working animations. Impacts and deaths show
their weapon's explosions (one per valid warhead, picked out of its list by
a hash of the impact instead of OpenRA's random); WebRA draws its own
picture of each explosion, grown and faded, or with the original graphics
OpenRA's sequence once from the make pose. Muzzle flashes follow every shot
at OpenRA's barrel offset, one per barrel (barrels take turns as OpenRA's
Armament cycles them, and every barrel that fired lately shows its own flash
at once, also across armaments); the damage smoke starts when a unit is hit
below its damage state: OpenRA's start sequence, then the loop LoopCount
times (`Next(1, 3)`: once or twice, picked by a hash of the actor and the
tick instead of OpenRA's shared random). With the original graphics the
client gives the smoke's frame time and its start and loop frame counts
(`info` kind 2) and the engine names the frame (mode 3). With the original graphics the Tesla zap is OpenRA's
TeslaZapRenderable: two dim and one bright wandering bolt in 8 pixel steps
showing litning.shp's direction frames, for TeslaZap.Duration (2 ticks).

Mouse cursors: every cursor kind has an OpenRA cursor name
(`js/cursors.js` `CURSOR_NAMES`, `COMMAND_CURSOR_NAMES`); with the original
graphics `setCursorArt` shows Red Alert's mouse.shp cursors (a Dune 2
layout SHP, `js/content/shp.js` `decodeShpD2`) cut by OpenRA's
mods/ra/cursors.yaml (`data/source/cursors.yaml`, `CURSOR_ART`): PNG data
URLs with OpenRA's hotspots, animated at 12.5 frames per second like
OpenRA's CursorManager. Mouse capture draws them as its virtual cursor.

The original art audit (`js/content/audit.js`, run on a player's own files
with `node tools/art-audit.mjs <files or directories>`) lists for every
actor and special sprite each sequence OpenRA's render traits draw
(`js/content/render-facts.js`, generated with `tables.js`) and whether
WebRA shows it (ok), falls back to its own art, maps a wrong one, has no
way to show it yet (gap, with what is missing) or Red Alert has no art for
it (webra-only; its note and `webra` field say when WebRA draws that part
with its own pixel art in Red Alert's style, `js/art/pixel.js`). The campaign's characters and wrecks (`render-facts.js`
`MISSION_ACTORS`, `withMissionActors`) are audited like the rules actors.
An OpenRA-made file (`render-facts.js` `OPENRA_MADE_FILES`) found among the
player's files makes its rows and a `(files)` row wrong: the tables would
leave out art Red Alert has (`tools/gen_content_tables.py`
`IN_RED_ALERT_TOO`). The generator itself fails when an actor OpenRA draws
from an original file has no `ACTOR_ART` entry. `apps/game/tests/art-audit.test.mjs` runs it on synthetic
files whose frames spell their own file and frame number, so a missing
mapping or a frame out of OpenRA's order fails CI.

Content priority per part, cameo, terrain and sound: texture pack > original
content > WebRA (its pixel art, then its vector art).

WebRA's own pixel art (`tools/gen_pixel_art.py` writes
`js/art/pixel-data.js`, CI checks it is up to date): 8-bit frames at one
pixel per world pixel on WebRA's own palette with Red Alert's index
conventions (0 transparent, 4 shadow, 80 to 95 the owner's colour), for
actors Red Alert has no art for: the oil derrick, the Black Hawk, the
Mobile Flak and WebRA's own Lightning Rod. Per actor `PIXEL_ART` holds trimmed frames placed around the
actor's origin and OpenRA-style sequences over them (`start`, `length`,
`facings` anticlockwise from north in even steps, `tick`) for the `body`
and `second` slot, the same roles the original art has: the derrick's idle
and damaged body, the Black Hawk's 32 body facings (its falling husk too)
and its rotor (pose idle the 8 frame slow-rotor on the ground, move the 4
frame blurred rotor in the air, around the hub over the mast like OpenRA's
rotor overlay at offset 0), the Mobile Flak's 32 body and 32 turret facings
(the turret drawn around its pivot at the height of OpenRA's Turreted
offset -298,0,298), the Lightning Rod's idle, damaged and 12 frame make
body (OpenRA ^Building WithMakeAnimation: pose make, played once from the
age the engine reports for 127 ticks after placement, then idle; the engine
has no sell animation, so make is never played backwards). `js/art/pixel.js` `pixelSlots` makes the pose tables
(`content/sequences.js` resolveSequence and `content/atlas.js` poseTable,
like loaded original sequences; structures centred on the footprint plus
the building's centre offset), stored at two atlas pixels per world pixel
so they stay crisp with either sampler; `buildAtlas` adds each to every
atlas where no pack or original art has that slot and lists them in
`pixel`, and `gameart.js` `applyGameArt` passes them to
`Game.set_original_slots` with the original ones: the engine draws them as
pre-rendered art (rotor sequences instead of WebRA's spinning blades and
disc, the turret at `classic_offset` of the Turreted offset's forward part,
as for original turrets). The muzzle flashes stay the slot's own: Red
Alert's (`ACTOR_ART` keeps only `muzzle` for these two) with the original
graphics, WebRA's otherwise. `pixelDraw` and `pixelUnitDraw` paint the idle
frame (north) for icons (a structure's in `pixelBox`: its footprint, grown
evenly where the art reaches past it, the Lightning Rod's mast), `drawPixelCameo` the 64 x 48 cameo, in its own
colours like Red Alert's cameos (the sidebar labels it). Nothing in it
comes from Westwood's or OpenRA's files. The pack format is in `docs/texture-packs.md`; packs are
cosmetic and never reach the simulation.

### Game methods across the boundary

The UI holds a game handle (`js/sim/proxy.js`: `RemoteGame` for a worker,
`DirectGame` on the main thread) with the `Game`'s method names.
`js/sim/methods.js` lists them.

| Methods | Used by | Across the boundary |
|---------|---------|---------------------|
| `tick`, `apply_frame`, `take_orders`, `set_lockstep`, `state_hash`, `snapshot`, `restore` | drivers, recorder | Only in the worker (`js/sim/core.js`); hashes through `stateHash` and `encode` |
| `build_render`, `sprite_ptr`, `rect_*`, `build_render_records`, `record_*`, `rect_record_*`, `build_lines` (range circles, engine/src/range_circles.rs, rally lines, with "Show unit paths" `build_paths`, and the target lines of the units js/targetlines.js shows, engine/src/target_lines.rs), `path_ptr`, `build_heat_fx`, `fx_ptr`, `weather_json`, `fog_ptr`, `fog_len`, `terrain_*`, `take_audio_events` | main loop, audio, weather renderer | In the worker each step; results come with the frame (`take_audio_events` hands out the frame's events once) |
| `rules_json`, `map_width`, `map_height`, `cheats_enabled`, `player_count`, `start_position`, `are_allies`, `weather_json` (the start's sky), `mission_camera` | setup, command bar, terrain atlas, minimap | Static: read once at `start` |
| `is_mission`, `mission_state`, `take_mission_events` | the mission view (`js/campaign/view.js`) | In the worker each step; results come with the frame (`game.mission`, a `MissionFeed`) |
| `set_audio_events`, `set_health_bars`, `set_building_overlays`, `set_sprite_poses`, `set_original_slots`, `set_death_art`, `set_make_art` | audio, settings, atlas | `call` (render and audio settings, never simulation state) |
| `order_*`, `sell`, `sell_buildings`, `repair_building`, `repair_buildings`, `repair_units`, `power_down`, `place_beacon`, `surrender`, `deploy`, `activate_power`, `set_rally`, `set_stance`, `start_production`, `cancel_production`, `pause_production`, `place_building`, `dev_*` | input, sidebar, command bar, minimap, debug menu, touch, game menu | `call`, in order |
| `set_selection`, `set_hover`, `set_control_groups`, `set_placing` | input, command bar, main loop | `call`, mirrored on the main thread (`set_hover` and `set_placing` only when they change; `set_control_groups(ids, groups)` is local UI state for the group numbers on selection boxes, `set_placing(actor, cx, cy)` the structure being placed for its range circles; never part of the state hash) |
| `selection`, owner and kind lookups (`actor_info`) | input, command bar, audio voices | The actor table (`Game.actor_table`: id and `owner \| flags << 8 \| type << 16` per slot), synchronous |
| `pick`, `world_tooltip`, `cursor_action`, `can_guard`, `can_attack_ground`, `can_attack_actor`, `teleport_valid`, `placement_preview`, `sell_value`, `repair_cursor`, `repair_unit_target`, `repair_selection_json`, `repair_box_json`, `sell_box`, `can_power_down`, `base_actors`, `harvesters`, `production_buildings`, `queue_producer`, `army_counts`, `deploy_state`, `has_minelayer`, `command_state`, `actor_json`, `debug_cells`, `debug_flow`, `debug_actors`, `debug_stats`, `player_json`, `power_timers_json`, `observer_stats`, `observer_production`, `radar_state`, `minimap_blips`, `actor_count`, `fog_bytes`, `deploy_summary` | cursor, footprint preview, command bar and deploy button state, selection panel, sidebar, observer panel, radar, debug views | Synchronous from a cache: each call registers the query, every step asks the queries called in the last 300 ms, the answers come with the frame. Before the first answer a call returns the engine's "nothing" value (`player_json` and `observer_stats`: null, and the caller waits); hover and view queries return the last answer to the same method meanwhile |
| The same queries plus `select_box`, `select_at`, `select_all`, `select_by_class`, `units_center`, `deploy_targets`, `observer_report`, `move_hint` | clicks, taps, hotkeys (select, order, place, sell, deploy, teleport, centre), the statistics screen, the attack-move tip | `ask.<method>()`: a promise of a fresh answer; the action happens when it arrives |

`deploy_summary` and `deploy_targets` are composite queries run where the
game is (one message for a whole selection instead of one per actor).

### The map editor's tile worker (`apps/game/editor/js/tiles-worker.js`)

The map editor plans the original graphics' terrain tiles
(`js/content/terrain.js` `originalTerrain`) in a module worker
(`editor/js/tiles.js` `TileWorker`); without module workers, or when the
worker fails, the plans run on the main thread.

| Direction | Message | Meaning |
|-----------|---------|---------|
| to the worker | `{ t: 'theater', key, tileset, files: [name, bytes][] }` | The theater to tile with: the installed files `theaterFiles(tileset)` names (palette, templates, trees, smudges, ore and gems), sent once per `key` (art and biome) |
| to the worker | `{ t: 'plan', id, key, bytes, w, h }` | Tile engine terrain bytes (RGBA per cell, R the type) |
| from the worker | `{ t: 'planned', id, result }` | `originalTerrain`'s `{ atlas, cells, report }`, or null; the atlas pixels and cells are transferred |
| from the worker | `{ t: 'failed', id, error }` | The plan failed (the editor keeps WebRA's tiles) |

### Simulation performance (`engine/examples/sim_bench.rs`, `engine/src/profile.rs`)

The simulation is one integer-only tick on one thread; this section is how
it is measured, where its time goes with very large armies, what keeps it
fast without changing a result, and why it does not use more cores yet.

**Measuring.** `cargo run -p webra-sim --release --example sim_bench --
<units> <ticks> [seed] [--window N] [--hashes FILE]` steps the lobby's stress
test (`World::new_stress`: two armies of soldiers, light and heavy tanks,
one tank or a pair of soldiers per cell, that attack-move across an open
map into each other) and prints the average and worst tick per window, the
units alive, flow fields and route searches, the first tick and the ticks
after it on their own (median, 95th percentile, worst), a digest of the
state hashes (every 25 ticks, outside the timed ticks), the final state
hash and the peak resident memory. With `--features profile` (and `--sections` per
window) it also prints the time of each system: `profile::scope` timers in
`World::step` and the hot functions, which compile to nothing without the
feature (the game never builds it; the feature refuses to build for
wasm32, where `std::time::Instant` panics). `node tools/sim-tick-bench.mjs <units>
<ticks>` runs the same scenario on the game's wasm build in node and prints
the same final state hash as the native run.

**Where the time goes**, 20,000 units over 1,500 ticks, native, before and
after the changes below (identical state hashes):

| System | Squeezed layout, before | after | Stress test, before | after |
|--------|------------------------:|------:|--------------------:|------:|
| Whole tick (average) | 37.6 ms | 28.9 ms | 29.0 ms | 18.1 ms |
| Idle upkeep (crowded units looking for a free cell) | 15.2 ms | 11.7 ms | 0.2 ms | 0.2 ms |
| Cell moves | 8.3 ms | 7.3 ms | 18.3 ms | 11.0 ms |
| of which route searches | 1.2 ms | 1.1 ms | 14.8 ms | 7.9 ms |
| Target scans | 4.3 ms | 1.4 ms | 5.3 ms | 1.8 ms |
| Vision | 2.4 ms | 1.4 ms | 1.2 ms | 0.7 ms |
| Tick start (unit hash, occupancy) | 1.5 ms | 1.3 ms | 0.9 ms | 1.1 ms |

The squeezed layout is the stress test as it was placed before: a tank and
a soldier in every cell (the type index skipped every other entry of its
mix), which leaves the whole army crowded under the OpenRA movement model,
and every idle crowded unit searched ten rings of cells for a free one on
every tick. The stress test now places one tank or a pair of soldiers per
cell. There the route searches dominate, and nearly all of them fell in
the first tick, when every unit of both armies starts its move: 34,500
searches expanding 37 million cells at 20,000 units, 6 to 10 s native and
7 to 8 s in wasm for that one tick in the quieter runs on a busy machine
(17 s in wasm before); see "Huge move orders" below for how that tick
went down to 0.06 s native and 0.1 s in wasm. Flow fields (the HUD's count
is the fields computed since the start, not the fields kept) cost about
2 % of a tick. The worker's render build (`build_render` with the whole map
in view) is 1.9 ms per frame at 20,000 units in wasm; the GPU instance path
builds once per tick instead (section 8, Instance paths).

**What is faster, with the same results.** Each change answers exactly what
the code answered before; `engine/src/tests_simperf.rs` compares each with
its plain definition on crowds of both sides, and the state hashes of the
stress test (2,000 to 20,000 units, 1,500 ticks, every 25 ticks), the
ai_vs_ai games and the native against the wasm build are identical.

- Sub-cell questions (movement/occupancy.rs `free_sub_cell`, the
  shared-cell check of `can_enter_cell`, the sub-cell choice of
  `available_sub_cell` for soldiers) collect the sub-cells a cell's
  holders take as bits in one pass over the holders, instead of one pass
  per sub-cell. `can_enter_cell`'s blocking check (when no sub-cell is
  free) and `available_sub_cell` for units that do not share cells still
  make their own pass, as before; the blocking rule (`blocked_by`) only
  looks up what the check needs.
- A route search (movement/search.rs) asks each cell's can-enter answer
  and terrain cost once (a search reaches a cell from up to eight
  neighbours, and nothing moves while it runs), keeps a cell's bookkeeping
  in one record and reuses its open list.
- The unit hash (world.rs `rebuild_hash`) keeps the owners of each cell's
  units as bits, and target scans (combat.rs `scan_for_target`) skip cells
  without enemies. An owner change or a freed actor slot voids the bits
  until the next rebuild (scans then look at every cell).
- Vision (vision.rs) adds each sight circle as row spans to a difference
  array per player instead of writing every cell of every circle.

**Huge move orders** (movement section 5, `Pending::Boxed`,
`ROUTE_SEARCH_BUDGET`). A unit of an order of 250 units or more that is
boxed in by its own units when its move starts searches its route once a
neighbouring cell comes free, and the searches of one tick expand at most
100,000 cells, the ones that waited the longest first. The first tick of
the stress test now searches the routes of the units at the edges of the
two crowds only; the rows behind search as they start. Units of such an
order also wait in a queue that moves on instead of searching a way round
every unit after each `WaitAverage`. Measured with `sim_bench` (native,
1,500 ticks) and `tools/sim-tick-bench.mjs` (wasm in node 26, 600 ticks),
seed 1, before and after, one run each on a busy machine (the state hashes
of native and wasm agree, at tick 600: 2,000 units `c882217a445391c6`,
20,000 units `9144b76ebf6789d8`):

| Units | First tick, before | after | Ticks after it: median / p95 / worst, before | after |
|------:|-------------------:|------:|----------------------------------------------:|------:|
| 2,000 native | 682 ms | 24 ms | 0.68 / 2.41 / 5.3 ms | 0.72 / 3.16 / 16 ms |
| 5,000 native | 408 ms | 25 ms | 1.88 / 4.97 / 12.7 ms | 1.75 / 4.47 / 19 ms |
| 10,000 native | 1,604 ms | 36 ms | 6.38 / 10.6 / 29 ms | 3.84 / 12.2 / 35 ms |
| 20,000 native | 5,068 ms | 61 ms | 7.93 / 15.7 / 65 ms | 9.47 / 24.1 / 77 ms |
| 2,000 wasm | 953 ms | 48 ms | 1.27 / 3.62 / 6.8 ms | 1.13 / 5.55 / 25 ms |
| 5,000 wasm | 525 ms | 57 ms | 2.74 / 5.89 / 8.7 ms | 2.48 / 5.75 / 23 ms |
| 10,000 wasm | 1,980 ms | 69 ms | 7.91 / 11.9 / 17 ms | 6.97 / 18.4 / 26 ms |
| 20,000 wasm | 6,220 ms | 101 ms | 12.3 / 20.6 / 49 ms | 22.4 / 29.3 / 42 ms |

The first tick holds more than the searches (the two crowds' flow fields,
the boxed-in checks, target scans). At 20,000 units the whole native run
averages 12.6 ms a tick against 13.9 before, with fewer searches in all
(18,470 against 51,835, 38 against 46 million cells); 9,988 searches
waited for a later tick, none longer than 14 ticks (3, 3 and 6 at 2,000,
5,000 and 10,000 units), and the units that started at once when theirs
ran had waited 1 to 4 ticks (median). The 20,000-unit wasm run of 600
ticks ends before the spread-out searches even out, and the armies play
differently: before, the units behind the front gave up their move once
`WaitAverage` ran out (12,000 of 20,000 stood idle by tick 1,500), now
they keep filing after the units ahead, which costs a little every tick.
The worst ticks after the first are fights, not searches.

**Several cores.** The game page is already cross-origin isolated (COOP
`same-origin`, COEP `require-corp`, docs/security.md), so
`SharedArrayBuffer` is there; what is missing is a threaded wasm build and
work that can run side by side without changing a result.

- Toolchain: wasm threads with wasm-bindgen need the `atomics` and
  `bulk-memory` target features and a standard library built with them,
  which only a nightly Rust can do (`-Z build-std`; `wasm-bindgen-rayon`
  needs the same). The project builds on stable Rust, so this is a
  decision of its own: a pinned nightly for the wasm build.
- What could run in parallel unchanged: vision, the unit hash and
  occupancy rebuild, flow field computations. Together they are under a
  tenth of a tick (table above), so even with many cores a tick would get
  at most about 10 % faster. Every unit's activity, movement and target
  scan runs one unit after another and sees the moves of the units before
  it (OpenRA's order), which is most of the tick; running them side by side
  changes what happens.
- The one large parallel win once in sight, the first tick of a huge move
  order, is mostly gone with the boxed-in units' deferred searches (above).
  Route searches could still run on all cores against the occupancy at the
  start of the tick, each recording the cells it read, and the sequential
  pass would take a result only when none of those cells changed before
  that unit's turn (else it searches again itself). The results stay those
  of the sequential search, whatever the core count. This needs the
  threaded build above plus a record of every change to the occupancy
  table and to the units holding cells.
- Without isolation or threads (Safari before 15.2, an embed without COEP)
  the game would keep the single-threaded build it uses now. Moving the
  render build to another worker or flow fields to separate workers was
  measured and is not worth it: the render build is about 2 ms per frame
  with the whole map in view, flow fields about 2 % of a tick, and both
  would need the world's state in the other worker (a shared, threaded
  wasm memory again).

## 9. Campaign missions (`engine/src/mission`, `engine/src/lua`, `apps/game/js/campaign`)

OpenRA's Red Alert missions (`mods/ra/missions.yaml`: the Allied and Soviet
campaigns, Counterstrike, Aftermath, OpenRA's own and the ant missions) run
in the engine with their maps, rules and Lua scripts. The scripts are part
of the simulation: lockstep-safe, replayed exactly, in the state hash.

### Mission files (`apps/game/missions`, `tools/gen_missions.py`)

`data/source/missions` vendors OpenRA's mission maps (map.yaml, map.bin,
Lua, map rules and weapons, Fluent strings), `missions.yaml`, the campaign
rules and the shared Lua scripts at commit
`b6fc03fcfaef1277592bbd4cbc7d44dd85219902` (GPL-3.0, see data/CATALOG.md;
no art, sounds or videos). `python3 tools/gen_missions.py` writes one JSON
file per mission and `index.json` (campaigns, missions with title, faction,
briefing, options, videos and the SHA-256 of each file). Never edit them by
hand; CI regenerates and diffs them.

A mission file (`format: 1`, at most 4 MiB, checked by
`engine/src/mission/data.rs`) holds:

| Field | What |
|-------|------|
| `id`, `title`, `campaign`, `author`, `source`, `briefing`, `videos` | From map.yaml and missions.yaml |
| `tileset`, `origin`, `map` | The map converted by the `.oramap` importer (`tools/mission-map.mjs`), cropped to its bounds: `origin` is the OpenRA cell of WebRA cell (0, 0) |
| `players` | map.yaml Players: name, faction, colour, playable, required, owns world, non-combatant, bot, allies, enemies |
| `actors` | Every map actor with its inits (owner, location, facing, subcell, health, stance, free actor, tags), the map's bridges too |
| `rules` | The mission's rules (OpenRA's merged with the map's, through `gen_rules.py`) as changes to `engine/rules.json`: actors, weapons, locomotors and armour types patched by key or added (`Rules::load_mission`) |
| `props`, `art`, `conditions`, `death_spawns`, `bot_conditions`, `smudges` | Script-only actors (waypoints, cameras, flares), the art key each mission actor draws with, ExternalCondition effects, actors left on death, the conditions a bot gives, map smudges |
| `scripts`, `messages`, `options` | The Lua files in load order (`campaign.lua`, `utils.lua`, the map's), the Fluent strings, the lobby options (`difficulty` with its values and default) |
| `starting_cash`, `tech_level`, `time_limit`, `start_notification`, `objectives` | World settings: MissionObjectives (`early_game_over`, `game_over_delay`, `cooperative`) |

### The Lua interpreter (`engine/src/lua`)

A Lua 5.1 interpreter in Rust (no C, compiles to wasm), written for the
lockstep simulation rather than embedding a C Lua:

- **Determinism.** Numbers are IEEE doubles like Lua 5.1. +, -, *, / and
  sqrt are exactly rounded everywhere; floor, fmod and the transcendental
  functions come from `libm` (a Rust port of musl), never from the
  platform; number formatting (`%.14g`) uses Rust's exact formatting.
  Tables keep insertion order (also for `pairs` and `next`), objects live
  in index arenas (so `tostring(t)` is the same everywhere), and
  `math.random` does not exist (OpenRA scripts use `Utils.Random*`, which
  draw from the world's RNG). The interpreter state is part of
  `World::state_hash`.
- **Budget.** Every run (a callback, `Tick`, loading) gets an instruction
  budget (statements, loop rounds and calls; library functions charge for
  their work), calls nest at most 120 deep, every recursive evaluation
  (expressions, blocks, calls, host round trips such as `Utils.Do`) takes
  native stack levels, at most 400, and the heap is bounded. The levels are
  sized from per-target measurements (`engine/src/stack_check.rs`): the
  wasm32 build the game and the server run takes about 150 to 340 bytes of
  its 1 MiB stack per level, under 140 KiB for the deepest run (budget 512
  KiB), and under 160 KiB of the JS engine's own stack (node's default is
  984 KiB; checked at 300 KiB). `npm run test:luastack` builds
  `examples/lua_stack.rs` for wasm32 and checks this in CI; the native tests
  check their own target (490 to 680 bytes per level on macOS, about 850 on
  Linux x86_64; budget 512 KiB of a 1 MiB thread). Running out of budget or heap is a script error no `pcall`
  can catch; a stack overflow is an ordinary Lua error. Integers from
  scripts are checked or saturated; script positions and distances are
  clamped to 2^20 cells and 2^29 world units, so no engine arithmetic on
  them overflows.
- **Sandbox.** OpenRA's globals only: ipairs, next, pairs, pcall, select,
  tonumber, tostring, type, unpack, xpcall, math (without random), string,
  table and print. No io, os, debug, load, require or coroutine.
- **Collection** runs only between runs, from the globals and the host's
  roots (triggers, activity queues, delayed calls).
- **Not there:** proper tail calls (a deep tail recursion hits the depth
  limit), `string.dump`, `setfenv`, `getfenv`, `collectgarbage` and
  metatable `__gc`; no OpenRA mission needs them.

### The scripting API (`engine/src/mission/api.rs`, `actor_api.rs`, `player_api.rs`)

OpenRA's globals (`Actor`, `Player`, `Map`, `Trigger` with every On*
trigger, `Reinforcements`, `Media`, `Utils`, `DateTime`, `Camera`, `Beacon`,
`Radar`, `UserInterface`, `CPos`, `WPos`, `CVec`, `WVec`, `WDist`, `Angle`,
`HSLColor`) and the actor and player properties and methods every RA
mission uses (movement and attack activities, `CallFunc`, `Wait`, `Hunt`,
transports, production with `Build`, capture, infiltration, chronoshift,
conditions, objectives, cash, power, alliances, bots). Actors are handles:
a dead or removed actor still answers `IsDead` and its last position. The
human player is engine player 0 (`IsLocalPlayer`).

Differences from OpenRA, all deterministic:

- Engine events (killed, damaged, captured, produced, sold, passengers,
  infiltrated, placed) reach triggers at the end of the tick they happened
  in: a callback runs up to one tick later than OpenRA's.
- Movies (`Media.PlayMovieFullscreen`, `PlayMovieInRadar`) play full screen
  from the player's own original content, or show a card ("Movies" below);
  the game goes on meanwhile and their callback runs on the next tick. Music
  calls leave the music to the player's settings and call back at once.
- `DateTime` gives the game time; the real date (`CurrentYear`, ...,
  `IsHalloween`) is fixed (2000-01-01 00:00, not Halloween) so every player
  sees the same.
- Players a script hands to OpenRA's bot (bot modules switched on by an
  `ExternalCondition` the script grants, as in soviet-05) play the campaign
  bot (`BotType::Campaign`, OpenRA's ModularBot@CampaignAI): its build
  orders, unit mix, squads, harvesters, MCV and repairs come from the
  mission's own bot modules (`tools/gen_missions.py` writes them as the
  mission's `bots` rules). Scripted AIs (`ActivateAI` in a mission's Lua)
  use the scripting API and are unchanged.
- Script errors stop the mission's scripts (the battle goes on) and show an
  error banner with Restart, like OpenRA's script error screen.
- The map is cropped to its bounds. Structures beyond them
  (`World::offmap`) keep giving power, prerequisites and storage and count
  as required units, as in OpenRA; other actors there, and tree clumps that
  stick out of the bounds, are left out (`Mission::unplaced`).
- From the campaign screen a mission is single player; in OpenRA's co-op
  missions (Evacuation, Exodus, Infiltration) the other playable slots then
  stay empty, like unoccupied slots in OpenRA (their scripts check for
  that). Online, people play them together ("Co-op online" below).

### Saves, replays, restart

A mission save or replay stores the mission file's id and hash, the start
options and the order frames (section 7) and re-simulates on load: the Lua
state is never serialized, so a save cannot disagree with its scripts.
Restart and the next mission run in the page (section 7, Restart): the
mission is taken down and the next start runs behind the loading screen.
The way back to the campaign screen goes through a page reload with a
`webra.restart.v1` record (`js/restart.js`: `campaign { id }`); a
`mission { id, options, gameSpeed }` record is the fallback when a mission
could not be taken down in place.

### Campaign screen and progress (`js/campaign`)

The lobby's Campaign button opens the mission browser: campaigns, missions,
map preview (`Game.mission_preview`), briefing, difficulty and game speed.
Progress is the registry setting `extra.campaignProgress` (mission id to the
difficulty it was won on, synced with the account). In the numbered
campaigns the first chapter is open and a chapter opens once a mission of
the chapter before it is won; the expansion and OpenRA missions are open
from the start. In a mission, `js/campaign/view.js` shows the objectives
panel, messages, mission text, floating texts, movies (or their cards) and
script errors, plays the scripts' speech and sounds, moves the camera and pings the
radar; the end of game dialogs offer the next mission, a restart and the
way back to the campaign.

### Art

Mission actors are drawn like the actor their `art` key names (engine
`rules_json` `art`): the built-in actor they inherit from or that has the
same OpenRA image, or a campaign character (`tools/gen_content_tables.py`
`MISSION_ART`: Einstein, Delphi, Chan, the general, the ants and the Chinook
wrecks), with WebRA art (`js/art/world.js`, `js/art/infantry.js`) and, with
the player's own original content, OpenRA's sequences. Missions may have up
to 16 players; the renderer has 16 team colours (the lobby offers 8).

### Tests

`engine/src/lua/tests.rs` (interpreter, determinism, limits),
`engine/src/tests_mission.rs` (every mission loads and runs without script
errors, allies-01 and soviet-01 won with scripted orders, API behaviour,
determinism of whole missions) and `apps/game/tests/campaign.test.mjs`
(every mission in the wasm engine with its art, a mission through the
simulation boundary with saves and replays, the campaign screen and the
mission view).

### Co-op online

OpenRA offers three missions in its multiplayer lobby (map.yaml
`Visibility: Lobby`): Evacuation, Exodus and Infiltration, each for two
people. `tools/gen_missions.py` lists them in `index.json` (`coop`: the
playable players in slot order) and writes
`packages/protocol/src/coop-missions.js` (`COOP_MISSIONS`: id, title, the
SHA-256 of the mission file, the playable players, the number of actor
types its rules have, the values of each option), which the game and the
server share.

- **Lobby.** The host picks a co-op mission in the online lobby (`mission`
  message, validated against `COOP_MISSIONS`: a file of another version is
  refused). The first slots become the mission's playable players, people
  only (OpenRA `AllowBots: False`); later slots close; faction, colour and
  team are the mission's. Only the game speed, the movement model and the
  factory loss rule of the lobby options apply.
  The game starts when every place holds a ready person. Choosing a map or
  a generated map goes back to a skirmish.
- **Start.** `start.mission` names the mission; every client loads its own
  copy of the mission file from its own server, checks the hash and starts
  `Game.from_mission` with `humans` (the playable players, engine players 0
  and 1), `localPlayer` (its own seat) and the lobby's `movement` and
  `factoryLoss`. No client
  ever sends a script or a mission file to another.
- **Lockstep.** The scripts run on every client. `IsLocalPlayer` is true for
  each client's own player only, and the scripts use it for presentation
  (their objective messages, timer colours, the camera), so the interpreter
  state may differ between clients without changing the game. The state hash
  of a co-op mission therefore leaves the interpreter heap, the trigger and
  timer counts and the local result out (like OpenRA, whose sync hash never
  covers Lua) and covers what the scripts did: actor handles, objectives,
  activity queues, reinforcements, builds and the whole world.
  `engine/src/tests_mission.rs` and `apps/game/tests/campaign.test.mjs` run
  both points of view side by side and compare the hashes every tick.
- **Server.** Orders are checked against the mission's actor types
  (`COOP_MISSIONS[].actors`), cheats are off. Rematches keep the mission.
  Online saves record the mission (`map_hash` holds the SHA-256 of the
  validated `{ id, hash, options }`), and a resume needs the same mission
  file and options. Online replays and saves carry `mission: { id, hash,
  options }` (section 7); the replay viewer loads the file like the game.
- **Directory.** A co-op mission lobby is listed under the mission's title
  (`map: { mission, name }`).

### Movies

`Media.PlayMovieFullscreen` (and the other movie calls) send a `movie` event
with the file name; `MissionView.movie` asks the movie player
(`js/content/movies.js` `createMoviePlayer`, the `movies` option) and shows
the card when the movie is not installed or fails. The installer
(`js/content/install.js`) takes the movies of OpenRA's `movies-allied` and
`movies-soviet` packages (`MOVIE_FILES`) from `movies1.mix` and
`movies2.mix` (nested in `MAIN.MIX`, also on CD images) or loose `.vqa`
files, checks each with `openVqa` and stores it with kind `movie`, one
transaction per movie (a full storage stops the rest with a message);
`ContentSystem` keeps only their names (`hasMovie`) and reads one when it
plays (`movieBytes`). `js/content/vqa.js` decodes Red Alert's VQA version 2
(and the 15-bit version 3 layout): 8-bit codebooks (CBF0, CBFZ, CBP0, CBPZ
applied a frame after the last part, as OpenRA), palettes (CPL0, CPLZ),
vector pointers (VPT0, VPTZ, VPTR, VPRZ) and SND0, SND1 (Westwood ADPCM) and
SND2 (IMA ADPCM) sound; sizes, frame index, chunks and LCW output are
checked and anything wrong throws `VqaError`. The player decodes at most
`DECODE_PER_TICK` frames per animation frame, follows the sound track's
clock, and resolves `play` with `played`, `skipped` (click, Esc, Space,
Enter, `stop`, or another movie), `missing` or `failed`. Presentation only:
the mission goes on while a movie plays (the engine calls the script's
callback on the next tick).

## 10. Performance capture (`apps/game/js/perfcapture.js`)

A recording of where a game's time went, saved as a JSON file the player
sends with a report of a slow game. Started from the debug menu ("Record
performance", for 10, 30, 60 or 120 seconds: debug setting
`perfCaptureSeconds`, which takes only these lengths, `PERF_CAPTURE_SECONDS`
of packages/protocol accounts.js), with `recordPerformance` (Alt+P; again:
stop and save), or for the first 60 seconds of every game with the debug
setting `perfCaptureStart` ("Record the start of every game", also on the game
menu's Settings page). The start-of-game capture begins with the game's first
frame, so a slow load never uses up its 60 seconds; the loading steps before
it are in the file's `startup` spans. A capture the player started or stopped
downloads when it ends; the start-of-game capture waits in the debug menu
("Download last capture"). Leaving the game (Leave, Exit, Restart, a rematch,
the next mission) ends a running capture with what it recorded and downloads
any capture not downloaded yet before the page reloads (`endReason: "left"`);
closing or reloading the tab itself leaves no time for a download, so a
capture still in memory is lost then.
Launching another game ends a running capture first (`"restarted"`, with the
facts of the game it recorded). Nothing is sent anywhere by the game.

File name: `webra-perf-<version>-<YYYYMMDD-HHMMSS>.json` (local time).

```jsonc
{
  "format": "webra-perf", "version": 1,
  "summary": {                     // first, for a person reading the file
    "durationMs": 30012, "frames": 1790, "fps": 59.6,
    "frameMs": { "avg": 16.8, "p50": 16.7, "p95": 18.1, "max": 812.4 },
    "hitches": { "over50ms": 3, "over100ms": 2, "over250ms": 1 },
    "worstFrames": [               // the 10 slowest frames and what overlapped them
      { "t": 1210.5, "frameMs": 812.4, "workMs": 790.1, "stepMs": 0.4, "drawMs": 2.1, "workerMs": 1.2, "ticks": 1, "tickMaxMs": 1.2, "roundTripMs": 6.3, "tick": 3,
        "during": ["longtask self 795 ms", "terrain.tiles 701 ms"] }
    ],
    "time": {                      // where the time went
      "mainThreadMs": 6100.2, "mainThreadShare": 0.2,
      "stepMs": { "avg": .., "p50": .., "p95": .., "max": .. },   // also drawMs, gpuMs, gpuDoneMs, workerMs, workerStepMs, tickMaxMs, roundTripMs (null: never measured)
      "longTasks": { "count": 2, "totalMs": 900 }, "longAnimationFrames": { "count": 4, "totalMs": 1100 },
      "gcHints": { "count": 3, "freedMB": 40 },
      "spans": [{ "name": "terrain.tiles", "count": 1, "totalMs": 701, "maxMs": 701 }]   // the 12 largest by total
    },
    "startup": { "firstFrameMs": 2410, "slowest": [{ "name": "atlas.sprites", "ms": 640 }] },
    "findings": ["The game took 2410 ms from launch to its first frame; ..."]   // plain sentences
  },
  "privacy": "...",                // what the file holds and leaves out (PRIVACY_NOTE)
  "capture": { "reason": "manual", "requestedSeconds": 30, "durationMs": 30012, "frames": 1790,
               "endReason": "time", "maxFrames": 30000, "droppedEvents": 0 },   // reason manual | start; endReason time | full | stopped | left | restarted
  "build": { "version": "0.13.0" },
  "environment": { "userAgent": "...", "brands": ["Chromium 140"], "mobile": false, "platform": "macOS", "cores": 8, "deviceMemoryGB": 8,
                   "devicePixelRatio": 2, "viewport": { "width": 1512, "height": 860 }, "screen": { .. }, "crossOriginIsolated": true,
                   "observers": ["longtask", "long-animation-frame"], "jsHeapLimitMB": 4096,
                   "gpu": { "vendor": "apple", "architecture": "metal-3", "device": "", "description": "", "fallbackAdapter": false,
                            "timestamps": true, "timestampError": null, "maxTextureSize": 16384, "format": "bgra8unorm", "instances": "available" },
                   "sim": { "mode": "shared", "reason": "..." } },
  "settings": { "pixelRatioCap": 2, "lowQuality": false, "reduceMotion": "auto", "uiScale": "auto", "gameScale": "auto", "graphics": "original",
                "healthBars": "off", "showUnitPaths": false, "targetLines": "automatic", "originalContent": true, "instancesParam": null,
                "instances": { "path": "cpu", "reason": "...", "cpuForced": false } },
  "game": { "mode": "skirmish", "title": "Example map", "generatedMap": false, "mapWidth": 96, "mapHeight": 96, "biome": "temperate",
            "players": 2, "ais": 1, "spectating": false, "tickMs": 40, "gameSpeed": "normal",
            "options": { "seed": 1, "startingCash": 10000, "players": [{ "type": "human", "faction": "england", "team": 0, "difficulty": null, "bot": null }] } },
  "startup": { "spans": [{ "name": "sim.start", "t": 120.4, "ms": 61.2, "detail": { "kind": "skirmish", "engineMs": 43.8 } }], "dropped": 0 },
  "frameFields": ["t", "frameMs", "workMs", "stepMs", "drawMs", "gpuMs", "gpuDoneMs", "workerMs", "workerStepMs", "ticks", "tickMaxMs", "buildMs",
                  "queryMs", "roundTripMs", "uploadKB", "sprites", "tick", "actors", "heapMB", "wasmMB"],
  "frames": { "t": [16.7, 33.4], "frameMs": [16.7, 16.7], "...": [] },   // one array per field, frame order, 2 decimals, null: none
  "events": [{ "t": 1220.1, "kind": "span", "name": "terrain.tiles", "ms": 701.2, "detail": { "source": "original", "tiles": 557 } }]
}
```

- Times are milliseconds; `t` of frames and events counts from the capture's
  start (frames: when the frame began), `t` of startup spans from the game's
  launch. A frame's stall lies between `t - frameMs` and `t`.
- Frame fields: `frameMs` the time since the previous animation frame,
  `workMs` the game's own frame callback on the main thread, of which
  `stepMs` (handing the step to the simulation; in main thread mode the ticks
  themselves) and `drawMs` (encoding the WebGPU frame); `gpuMs` the render
  pass on the GPU (timestamp queries, where the adapter has `timestamp-query`),
  `gpuDoneMs` from the frame's submit until the GPU finished it; `workerMs`
  (its ticks), `workerStepMs` (its whole step: ticks, queries, render data),
  `ticks`, `tickMaxMs`, `buildMs`, `queryMs` from the newest simulation frame
  (0 when no new one came: section 8), `roundTripMs` a step's way to the worker
  and back, `uploadKB` texture and buffer writes of the frame, `sprites` the
  CPU path's sprites, `tick`, `actors`, `heapMB` the used JS heap (Chrome's
  `performance.memory`, every 250 ms, else null) and `wasmMB` the engine's
  memory.
- Event kinds: `span` (heavy work, `perfTrace.span`: `content.load`,
  `sim.host`, `sim.start`, `rules.parse`, `atlas.sprites`, `upload.sprites`,
  `terrain.tiles`, `atlas.terrain`, `terrain.cells`, `upload.terrain-atlas`,
  `audio.attach`, `audio.synth`, `audio.decode`, `audio.decode-pack`,
  `game.setup`, `first-frame`), `longtask` and `loaf` (PerformanceObserver
  `longtask` and `long-animation-frame` where the browser has them; a `loaf`
  has `blockingMs`, `renderMs`, `layoutMs` and up to five `scripts { ms,
  invoker, source, fn, layoutMs }`), `gc-hint` (the heap dropped by 1 MB or
  more between samples: `freedMB`).
- The start of every game is traced (spans from the launch to the first drawn
  frame, at most 64), whether or not a capture runs, and goes into every
  capture of that game. The loading screen (`js/loadingscreen.js`) follows
  the same trace (`PerfTrace.onSpan`, called when a span of the start
  begins): `content.load`, `sim.host`, `sim.start` and `rules.parse` begin
  its steps, and the first drawn frame closes it; the game itself starts
  once the screen is gone (section 8, "Start"). Before `start()` builds the
  battlefield in one go the page lets one frame paint, so that step shows;
  that frame (about 16 ms, none in a hidden tab) is all the screen adds to a
  start.
- Bounds: one capture at a time, at most 120 s, 30000 frames (a fuller capture
  ends with `endReason: "full"`) and 4000 events (`droppedEvents` counts the
  rest); the frame columns are preallocated.
- Privacy: no player names (`options.players` keeps type, faction, team and
  AI only), chat, account, map contents, IP address or location. Script
  addresses are cut to their path on the game's site; other origins are
  `other origin`, browser extensions `extension`. The user agent, the GPU
  adapter facts the browser reports, screen size and the map's title are in
  it.
- Off, the capture costs one check per span and the per-frame upload counter;
  the simulation's capture timings and actor count (`req.perf`, section 8)
  and GPU timing (js/gputimer.js) run only while recording. GPU timestamps
  stop for good (their buffers freed) when a readback fails or the device is
  lost; `environment.gpu.timestampError` says why.
