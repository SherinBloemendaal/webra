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
| `data/` | Red Alert catalog extracted from OpenRA | Input for `tools/gen_rules.py` |
| `tools/` | `gen_rules.py`, `shader-check`, `check-js.mjs` | |

The browser imports `packages/protocol` through the path `/play/protocol/` (the
build copies `packages/protocol/src` to `dist/play/protocol/`). In the repo
`apps/game/protocol` is a symlink to `../../packages/protocol/src`, and the game
imports it only through the re-export file `apps/game/js/protocol.js` (from
`../protocol/index.js`), so the same path works in local dev and in `dist/`.

## 2. Map format (`.webra-map.json`, formats 1 and 2)

```jsonc
{
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
    { "type": "SBAG", "owner": -1, "x": 40, "y": 40, "facing": 0 }  // owner: spawn index, or -1 for neutral; type: 1..16 of A-Z a-z 0-9 . (V19.Husk)
  ],
  "rules": null,                    // optional rules overrides, see below
  "biome": "snow"                   // optional: temperate (default, left out), snow or desert
}
```

- Terrain: a ford (5) is shallow water. Ground units cross it at rough
  speed (the locomotor's `Rough` entry) and ships sail over it at water speed,
  so a ground route over a river never cuts the water network. Structures
  never stand on a ford (naval yards need open water), and fords hold no ore
  or gems. Generated maps put fords where ground routes cross water.
- Terrain types 6 to 10 are OpenRA's (`data/source/rules/world.yaml`,
  `defaults.yaml`; speeds per locomotor in `engine/rules.json`): road (6)
  is clear ground with OpenRA's road speed, buildable and able to hold
  resources; bridge (7) is the deck of a bridge actor (as fast as a road,
  never buildable); beach (8) is passable sand that slows everything,
  wheeled vehicles most (50 %), and holds no resources or structures; river (9) and wall (10)
  stop ground units and ships alike. The engine owns bridge cells: a
  bridge actor writes its template's terrain over them when it is placed,
  damaged, destroyed or repaired, so a destroyed span turns into river or
  water under it (`engine/src/bridges.rs`).
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
  `lcraft`) use their own passability (`World::pass_landing`: water, fords
  and beaches), so they run up on beach cells to unload and other ships do not.
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
- Identity: `sha256` (hex) of the canonical JSON: top-level keys in the order
  above (`description`, `actors` and `rules` always present, `gems` only in
  format 2, right after `ore`, `biome` last and only when it is not
  temperate; `actors` entries
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
  can be unfair or act as a cheat.") and the player must accept before the map
  is installed. The lobby shows a MODDED badge for such maps.
- Engine API (landed): `Game.from_map(mapJson, optionsJson)` builds a world
  from a map (players fill spawns in slot order, extra spawns stay empty,
  neutral actors get a passive owner); `Game.map_hash(mapJson)`,
  `Game.map_canonical(mapJson)`, `Game.validate_map(mapJson)` returns
  `{ ok, errors: [], modded, hash }`; `Game.generated_map(seed, size, players)`
  exports a generated temperate map file in the seed's style (format 2:
  generated maps have gems) and `Game.generated_map_styled(seed, size,
  players, style, biome)` any style and biome (names as in section 3,
  `random` resolved from the seed); previews: `Game.map_file_preview(mapJson)`,
  `Game.map_preview_players(seed, size, players)` and
  `Game.map_preview_styled(seed, size, players, style, biome)` (RGBA per
  cell in the biome's colours, spawns in player colours);
  `Game.resolved_style(seed, style)` and `Game.resolved_biome(seed, biome)`
  name what `random` picks.

### Importing OpenRA maps (`.oramap`)

The lobby ("Load map file") and the map editor ("Open", or drop a file)
import OpenRA Red Alert maps in the browser (`apps/game/js/oramap/`). The
result is an ordinary map file of this section: it is validated by
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
  `data/source/tilesets` and `data/source/rules`) and maps as: Clear, Road,
  Bridge, Ore, Gems to clear; Rough and Beach to rough; Rock, Wall and River
  to rock (OpenRA lets neither tanks nor ships through rivers); Water to
  water; Tree to tree. Unknown templates or tiles become clear (reported).
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
  `Buildable.Prerequisites`; weapons `Range`, `MinRange`, `ReloadDelay`,
  `Burst`, `Projectile.Speed`, `Projectile.Inaccuracy`, and `Damage` of a
  single warhead. Each kept field is checked by the engine alone; refused
  fields are dropped and reported. Everything else (removals, inheritance,
  other traits, `Player`, `World`) is listed as unsupported and never
  applied. Lua scripts are never run. Custom sequences, voices, music,
  notifications and other files are ignored and reported.
- Import report (shown before the map is used): converted, rules applied,
  warnings, skipped, not supported, and the validation errors when the
  converted map is not playable yet (the editor still opens it for fixing).

## 3. Game options (lobby to engine)

`options` JSON as produced by `apps/game/js/lobby.js` (value sets in
`apps/game/js/lobby-state.js`): `seed, mapSize, players[{slot, type:
human|ai|closed, name, faction, color, team, difficulty, bot?, handicap?}],
startingCash, startingUnits, techLevel, gameSpeed, crates, shortGame, fog,
explored, buildRadius, allyBuildRadius, separateTeamSpawns, redeployableMcv,
reusableEngineers, bounty, oreRegrowth, timeLimit, cheats, mapStyle, biome,
weather, techBuildings, map`.
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
Game modes saved before it existed get it off. `team` 0 means no team (free for all);
players with the same non-zero team are allies (shared vision, no
auto-targeting, win together). 2..8 players. Closed slots are listed as
`{slot, type: "closed"}` and do not play: engine player N is the N-th slot
that is not closed, and it takes spawn N (unless separate team spawns
moves it, below). `map` is the map file JSON string
(the client starts `Game.from_map(map, options)`) or null for a generated map
(`Game.from_options(options)`); it is not passed on to the engine options.

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
- `separateTeamSpawns` (default on, OpenRA MapStartingLocations): in a team
  game the players without a team keep their slot's spawn and team members
  take the free spawns. On a generated map the teams take them team by team
  (in the order of each team's first slot, members in slot order) in the
  order the map lists its spawns, which is by column, top first, so the
  halves of the list are mirrored sides; on a map file the members, in slot
  order, take the free spawn farthest from the enemies placed so far (sum of
  squared distances), then nearest to team mates, then the lowest.
  `engine/src/gamerules.rs` `assign_spawns` and `packages/protocol`
  `assignSpawns` (lobby markers) share the cases of
  `packages/protocol/test/fixtures/spawn-cases.json`.
- `bounty` (default off, OpenRA GivesBounty): a kill pays the killer the
  victim's GivesBounty percentage (10 % by default) of its value; allies pay
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
On the water styles each base has a harbour bay along the map edge behind
it, dug through to the network. Generated maps for 3 to 8 players are
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
mirrored too. Ground routes that would be cut by water get fords. Last, every
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
(40 %, 40 to 90 s). Lightning strikes every 4 to 12 s of a thunderstorm and
is cosmetic (no damage). Effects with `weather: full`:

| What | Effect |
|------|--------|
| Rain | sight of every actor 90 % |
| Thunderstorm | sight 85 % |
| Snowfall | sight 85 % |
| Sandstorm | sight 75 % |
| Snow biome, infantry | speed 90 % |
| Snow biome, vehicles | momentum: +10 % of top speed per tick, -12 % when braking or coasting; turn rate 70 %; they slide on along their heading while turning and for a short coast after stopping (harvesting, docking, repair, boarding and abilities stop dead) |
| Ice (rough ground in the snow biome) | +6 % / -7 % per tick, turn rate 50 % |
| Heat wave, vehicles | heat +1 per tick driving (40 s of driving), +25 per shot; overheated at 1000: speed 75 %, reload 133 %, until heat drops to 400 |
| Cooling | -5 per tick standing still without firing, -1 per tick otherwise outside a heat wave |

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
Warships are only bought when they can hurt something the enemy fields.
Waves that do not fill up go after 90 s without growth or 120 s without a
wave (after the eighth minute) and set the next wave to their size; an enemy
without structures is hunted by the whole army; ground waves never aim at
ships. Generated maps join every land region of 60 cells or more to the bases
by fords, and the land the bases reach holds at least 4.5 % (two players) or
6 % ore and gems, a third more on the water styles.
Submarines alone do not keep a player in the game (OpenRA `^Submarine`
has no `MustBeDestroyed`), nor do walls and mines.

Engine API: `Game.weather_json()` returns `{ biome, mode, weather, since,
until, tick, sightPct, flash }` (`flash`: the latest lightning `[tick, x, y]`
in world pixels, or null); `Game.build_heat_fx(player, x0, y0, x1, y1)`
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
| `GET` | `/api/sessions` | `[{ id, name, host, players, maxPlayers, locked, map: { id, name, hash, modded } \| { name, modded, shared: true }, version, state }]` (public, open lobbies only; a map shared with the session shows only its name) |
| `POST` | `/api/sessions` | `{ name, password?, public, maxPlayers, version }` -> `{ id, hostKey }` |
| `GET` | `/api/sessions/:id/ws` | WebSocket upgrade into the session's Durable Object |
| `POST` | `/api/sessions/:id/map` | host only, `X-WebRA-Member`: map JSON -> `{ id, hash }`; shares a map file with this session only (see "Lobby maps") |
| `GET` | `/api/sessions/:id/map?hash=` | members only, `X-WebRA-Member`: the lobby's (or running game's) map JSON with that hash (see "Lobby maps") |
| `POST` | `/api/sessions/:id/resume` | host only, `X-WebRA-Member`: an online save file -> `{ id }`; the lobby resumes that saved game (see "Online saves") |
| `GET` | `/api/maps` | `[{ id, name, author, players, width, height, hash, modded, downloads, createdAt }]` (published maps only) |
| `GET` | `/api/maps/:id` | the map JSON (published maps only) |
| `POST` | `/api/maps` | map JSON -> `{ id, hash }` (validated, size limited, rate limited); publishes it to the community list |
| `GET` | `/api/content/ra-quickinstall` | OpenRA's `ra-quickinstall.zip` (EA's freeware Red Alert files) streamed from OpenRA's mirrors, see below |
| `GET` | `/api/content/ra-scores` | A byte range of `scores.mix` (the Red Alert music) read from the freeware Red Alert CD images on the Internet Archive, see below |
| `GET` | `/api/content/ra-movies/allied`, `/api/content/ra-movies/soviet` | A byte range of `movies1.mix` or `movies2.mix` (the mission movies) from the same CD images, see below |
| any | `/api/site`, `/api/auth/*`, `/api/account/*`, `/api/admin/*` | Accounts, sign-in, self service and the admin API: [accounts API](accounts-api.md) |

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
| `slot` | `slot, faction?, color?, team?, type?(host only: ai/closed/open), difficulty?, bot?` (difficulty and bot: AI slots, host only) | lobby |
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
| `orders` | `tick, orders: [...]` | in game, every tick (may be empty) |
| `hash` | `tick, hash` | in game, every 25 ticks |
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
{from, text, team?}` (with `team: true` the line went to the sender's team
only: the players of its non-zero team, the sender alone without a team, the
spectators among themselves; OpenRA's team chat), `start {seed, options, map, players, delay}`, `frame {tick,
orders: [[player, [...]], ...]}`, `desync {tick}`, `left {player, client, name,
reason}` (`player` null for spectators and lobby members; reasons `left`,
`dropped`, `kicked`, `disconnected`, `removed`, `expired`), `log {frames:
[[tick, orders], ...]}`, `sync {tick, check: {tick, hash} | null}`, `back
{player, client, name, tick}`, `error {code, message}`. Protocol version 6
(`PROTOCOL_VERSION`); `/api/version` reports it and older clients are refused
at `hello`. Version 6 added lobby maps (the map details, `mapState`,
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
delay: 3 ticks.

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
size (1 MiB) and the map (protocol package and engine, as for uploads); the
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

### Defeated players

The engine refuses every order of a defeated player (it may still own
submarines, walls or mines), on every peer and in replays; `apply_frame`
skips them. A defeated player may keep watching: its client switches to the
observer view, keeps running lockstep (empty `orders` every tick, `hash`
as before, the same stall rules) and sends `defeated` once (again after a
reconnect). The server keeps the seat but drops its orders from then on,
also ones already waiting for a frame and after a rejoin. A seat cannot
undo it; a spectator sending `defeated` gets `bad_state`. Online games never
pause for the end-game dialog.

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
value (the observer panel's army statistics). `Game.observer_stats()` returns `[{
player, faction, team, isAi, cash, funds, earned, harvestedOre, harvestedGems,
spent, repairSpent, sold, armyValue, unitsKilled, unitsLost, buildingsKilled,
buildingsLost, assetsDestroyed, assetsLost, damageDealt, damageTaken,
unitsBuilt, buildingsBuilt, aircraftBuilt, shipsBuilt, builtValue, experience,
promotions, powersUsed, orders, score, powerGenerated, powerUsed, defeated,
defeatedAt, won }]` for the non-neutral players (kills credited to the owner
of the weapon that dealt the killing damage; `orders` counts the orders of
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
when it opens and every two seconds while it is open. `Game.snapshot()` and
`game.restore(snapshot)` copy the whole world in memory (replay seeking; not
serialized).

### Production queues (`engine/src/production.rs`)

Orders `start_production {ty, count}`, `cancel_production {ty}` and
`pause_production {ty, paused}` serve every queue, structures included:

- Structures queue like units (OpenRA): left click queues one, shift queues
  five. Only the first item of a queue is built. A finished structure waits
  for placement and the items behind it do not start until it is placed, so
  each structure queue has at most one ready structure. `place` only accepts
  the finished head of the queue.
- `cancel_production` removes the last queued item of that type and refunds
  what was paid for it (a finished structure refunds its full cost).
- `pause_production` (OpenRA PauseProduction) puts the first queued item of
  that type on hold or resumes it. An item on hold at the head of its queue
  holds up the queue (no progress, nothing paid); finished items are never
  on hold. It is in the state hash. The sidebar follows OpenRA's
  ProductionPaletteWidget: right click holds the item being built and
  cancels one that is on hold, finished or not started (nothing paid yet),
  middle click cancels at once, left click on a held item resumes it.
  `player_json().queues[][]` items have `paused` and `started` (something
  paid).
- Buildable.BuildLimit (`build_limit` in rules.json, 0 none: the
  superweapons, Tanya): owned plus queued of that type stay within it;
  `start_production` queues only what fits, the "all tech" cheat lifts it.
  `player_json().buildable[].limitLeft` is how many more fit (null: no
  limit); with the queue length (at most 30) the sidebar knows what OpenRA's
  CanQueue would say (Building or Training, Unable to build more, Building
  in progress).
- OpenRA `CancelUnbuildableItems`: every tick, before production advances,
  each queued item that can no longer be produced is cancelled and refunded,
  wherever it is in the queue. That is an item whose prerequisites were lost
  (a half-built Heavy Tank after the Service Depot died), and every Building
  and Defense item once the player has no Construction Yard. The rest of the
  queue carries on; the items can be queued again once the prerequisites (or
  a deployed MCV) are back. Unit queues keep going from their own factories.
  `start_production` and `place` are refused for such items.
- `player_json().buildable[].enabled` is false for structures without a
  Construction Yard, and their `requires` lists `Construction Yard`.
- `player_json().buildable[].buildTicks` is the time the item takes with the
  player's current factories (BuildTimeSpeedReduction), before the low power
  slowdown; `rules_json().lowPowerModifier` is that slowdown in percent. The
  sidebar's production tooltip shows both (OpenRA ProductionTooltipLogic).

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
- MCVs remember their spot and deploy on arrival (no queued deploy).
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

**Measurements** (`examples/bot_matrix.rs -- 16 90`, 16 seeds per pairing,
1v1 on generated 80 maps of random style with the standard tech buildings,
each bot on both spawns, Normal difficulty, 90 minutes at most; wins of the
first bot listed, then of the second, and game lengths in minutes):

| Pairing | Wins | Unfinished | Mean | Median | Longest |
|---|---|---|---|---|---|
| Rush vs Rush | 7-9 | 0 | 14.9 | 14.1 | 26.2 |
| Rush vs Normal | 11-5 | 0 | 17.6 | 18.6 | 25.1 |
| Rush vs Turtle | 11-5 | 0 | 24.4 | 21.0 | 66.0 |
| Rush vs Naval | 16-0 | 0 | 8.5 | 8.0 | 19.0 |
| Normal vs Normal | 10-6 | 0 | 22.7 | 18.1 | 65.6 |
| Normal vs Turtle | 12-4 | 0 | 29.3 | 27.8 | 54.6 |
| Normal vs Naval | 13-3 | 0 | 12.8 | 12.0 | 23.3 |
| Turtle vs Turtle | 4-11 | 1 (seed 8, lakes) | 39.7 | 38.7 | 78.2 |
| Turtle vs Naval | 3-13 | 0 | 24.4 | 24.1 | 66.1 |
| Naval vs Naval | 8-8 | 0 | 10.9 | 10.7 | 18.5 |

Two Turtle AIs can outlast an hour and a half on water maps: Turtle AI forms
an attack force at most every 100000 ticks (MinimumAttackForceDelay, about
67 minutes, the first at a random time) and the stalemate breaker only
sends its units once they stop growing. Difficulty (Normal AI against
Normal AI, same setup): Easy against Normal 5-11, Normal against Hard 7-9,
Easy against Hard 3-13. Four player free for alls on 96 maps (the engine's
whole-game tests) end after 20 to 66 minutes, 2v2s after 9 to 49;
`ai_vs_ai -- 3` ends after 14:44.

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
`prone`. Sprites: a ranked unit gets a rank decoration
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
option `reusableEngineers`: OpenRA's Captures@REUSABLE). They go through the
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
ring (apps/game/js/art/infantry.js).

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
off again. Damaged helicopters land on the service depot to be repaired.
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
optional second point gives aircraft powers their flight direction), wasm
`Game.activate_power(player, key, x, y, x2?, y2?)` (world pixels), and
`player_json(p).powers`: `[{ key, kind, name, description, progress (0..1),
ready, charging, remainingTicks }]`. Superweapons (engine/src/abilities.rs):
`ChronoshiftPower` takes the destination as (x, y) and the source area as
(x2, y2) (both required), `GrantExternalConditionPower` (Iron Curtain) and
`NukePower` take the target as (x, y), `GpsPower` launches by itself when
charged and is `OneShot` (it disappears from `powers` after launch). The
client starts targeting with `Input.startPowerTargeting(key, kind)`.

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
on an actor is `attack`, which may target own and allied actors. Wasm:
`order_attack_ground`, `order_guard`, `order_scatter`, `order_waypoint`,
`set_stance` (false for an unknown name), `command_state(player, ids)` (JSON
`{ units, armed, attackGround, guard, scatter, queued, stances: { name: count } }`),
`can_guard`, `can_attack_ground`, `are_allies`, `move_hint(player, ids, x, y)`
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
(switch an own structure with `building.power_down` off or on) and
`{"o": "place_beacon", player, x, y}` (world units, inside the map; the
beacon sits on the centre of that cell and replaces the player's previous
one). Repair follows OpenRA's RepairableBuilding: a step of `min(step,
missing hp)` every `interval + 1` ticks, each repairing player pays
`max(1, hp * percent * value / (max_hp * 100))` (`building.value`: OpenRA
GetSellValue, CustomSellValue or the cost), the step is multiplied by
`bonuses[payers - 1]` percent, nobody paying waits two ticks and pushes an
insufficient funds event per player, repairers who are no longer allied or
playing drop out, a full structure ends the repair. Powered off, a structure
adds nothing to the power drain and `is_powered_down` is true (defences hold
fire, radar, gap generator and detection stop, support powers stop
charging, the sprite stands still and is darkened like low power). Both are
in the state hash; beacons are not (they change nothing) and last
`player.beacon_duration` ticks (OpenRA PlaceBeacon.Duration, 750), shown to
the owner and allies (rects over the shroud, not in the spectator views).
Rules: `building.repairable {percent, interval, step, bonuses}` or null,
`building.power_down`, `building.value`, `base_building` (actor),
`player.beacon_duration`; `Rules::validate` bounds them (bonuses 1..9 values).
`rules_json` actors have `repairable` and `powerDown`, players `team` and
`neutral`. Wasm: `repair_building`, `power_down`, `place_beacon(player, x,
y)` (pixels), `repair_cursor(player, id)` (0 nothing, 1 toggle repairing that
structure, 2 an own damaged unit goes to its depot), `repair_unit_target(player,
id)` (`[x, y]` of that depot, own depots, the nearest), `can_power_down`, and for the hotkeys
`base_actors(player)` (Construction Yards and MCVs, else the first
structure), `harvesters(player)`, `production_buildings(player)` (no
Construction Yards, by first production type) and `queue_producer(player,
queue)` (the structure units of that tab come out of, or NONE). `actor_json`
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
DamageNotifier), 5 UnitProduced, 6 BuildingPlaced, 7 Sold, 8
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
draws it). Kinds 32 to 36
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

Hotkeys (apps/game/js/hotkeys.js): defaults are OpenRA's Red Alert hotkeys
(`apps/game/js/openra-hotkeys.js`, generated by `tools/gen_hotkeys.py` from
data/source/hotkeys; CI checks it is up to date), each action naming its
OpenRA hotkey (`openra`), except `BROWSER_SUBSTITUTES` (Ctrl+Tab, Ctrl+Q,
Ctrl+W, F11, F12). Saved overrides (`settings.hotkeys`, synced with the
account) carry `"webra:keymap": ["2"]`; overrides without it come from WebRA
0.7 and are migrated on reading (`migrateOverrides`: overrides equal to the
old defaults, or old defaults that only lost keys to other actions' user
bindings, are dropped; everything else stays). Radar pings and the "last
event" (Space) are client side (js/radarpings.js) from the audio events.

## 6. Deployment

One Worker named `webra` on the `WebRA` Cloudflare account serves
everything on `webra.sherin.dev`:

- `/` and `/assets/*`: `apps/website` build output
- `/play` and `/play/*`: `apps/game` (with `pkg/` from wasm-pack and
  `protocol/`), served by the Worker's play gate (`apps/server/src/playgate.js`)
  only to accounts that may play while the site setting `gameRequiresAccount`
  is on (accounts API, section 7.1): page loads without access go to
  `/account/?returnTo=<path>`, other requests get 401 or 403
- `/lib/*`: the game modules and stylesheets the website's account and admin
  pages load, copied from `apps/game` with the same layout
  (`tools/shared-modules.mjs` lists them from the website's `/lib/` imports
  and links); public. No website page, script or stylesheet loads from
  `/play` (the build fails otherwise)
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
  "map": null,                      // or the canonical map JSON text (section 2)
  "mapHash": null,                  // sha256 of `map`, checked on load
  "player": 0,                      // the recording player, null for a spectator
  "ticks": 1200,                    // ticks recorded
  "frames": [[12, [[0, [{ "o": "move", ... }]]]]],  // non-empty frames, tick < ticks, increasing
  "hashes": [[250, "0123456789abcdef"]],           // state hash after N ticks, every 250 ticks
  "online": { "id": "0123456789abcdef" },          // online saves only: the server's record (section 4)
  "mission": { "id": "allies-01", "hash": "<sha256>" } // missions only (section 9)
}
```

A mission replay or save (`mode: "mission"`) has no `map` (null) and names
its mission file instead: `mission.id` (`[a-z0-9][a-z0-9-]{0,63}`, the file
`apps/game/missions/<id>.json`) and `mission.hash` (SHA-256 of the file's
text). Its `options` are the mission's start options, `{ seed, gameSpeed,
options }` with at most 8 mission options (`options.difficulty`: `easy`,
...; keys and values `[a-z0-9][a-z0-9_-]{0,31}`, case-insensitive), not
the game options of section 3. The person playing is player 0, so `player`
is 0 and every frame carries player 0's orders only. The loader fetches the
mission file and refuses it when its hash differs (another version of the
game). `packages/protocol/src/mission.js` validates both. An online replay
or save of a co-op mission (`mode: "online"`) keeps the game options and
adds `mission: { id, hash, options }` (section 9, "Co-op online"): a
mission of `COOP_MISSIONS` with this version's file, every player a person.

- Limits: 32 MiB, eight hours of game time, orders and options as strict as
  the network messages, frame players within the options, map canonical and
  matching its hash. A modded map shows the modded-map warning first.
- Another engine version: a clear message, nothing runs (the simulation can
  differ between builds).
- Playback feeds the frames into a fresh game at the same ticks and compares
  the stored hashes ("this replay no longer matches the game from m:ss").
  The viewer plays, pauses, runs at 1x to 8x, seeks by re-simulating
  (backwards from in-memory snapshots, `Game.snapshot`), and switches between
  the whole map and each player's view with the observer stats.
- Restart (`js/restart.js`): single player games and loaded saves restart
  from tick 0 with the same options and map through a page reload (the
  settings wait in sessionStorage `webra.restart.v1`, taken once); the replay
  viewer restarts playback in place. Online games have a rematch instead
  (section 4).
- A save is a replay of kind `save` whose `hashes` end with the hash of its
  last tick. Loading re-simulates it (fast-forward with progress), refuses it
  when a stored hash does not match, then play continues and the recording
  goes on from the save. Saves go to the browser (IndexedDB database
  `webra`, store `saves`, at most 50) or to a file.
- An online save (mode `online`, with `online.id`) ends right after a hash
  tick (`ticks - 1` is a multiple of 25) and is never loaded alone: it is
  resumed online with its players (section 4, "Online saves").

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
| `start` | `id`, `spec` (below) | `result { id, value: info }` (static facts: rules, map size, cheats, start positions, alliances, recorder start, replay length, `weatherJson`: the sky at the start, whose biome picks the terrain atlas and minimap colours) |
| `call` | `method`, `args` | none: an order, `set_selection`, `set_hover`, `set_control_groups`, `set_audio_events`, `set_health_bars`, `set_building_overlays`, `set_sprite_poses`, `set_original_slots` |
| `ask` | `id`, `method`, `args` | `result { id, value }`: a fresh query answer |
| `command` | `id`, `name`, `args` | `result { id, value }`: `net` (`frame`/`log`/`sync`), `back`, `reattach`, `stop`, `hidden`, `seek`, `setSpeed`, `togglePlay`, `dispose`, `encode` (`save`/`replay`: `{ text, ticks, full }`), `debugStep`, `stateHash`, `tick` |
| `step` | `req { dt, paused, view, rect, audio, paths, table, queries, instances }`, `recycle` | `frame` |

Worker to main thread, unasked: `event { type, payload }` (`send { msg, epoch }`
for the lockstep driver's network messages, `caughtUp`, `check { ok, tick }`),
`warn`, and `failed` (the worker cannot go on; the page says so).

Start specs: `skirmish { options, map, player, recorder }`, `mission {
mission, options, recorder }` (the mission file's text and its start
options, section 9), `save { replay, mission? }`, `replay { replay,
mission? }` (a mission save or replay also gets its mission file's text),
`stress { seed, units, size }`, `online { options, map, player, spectator,
delay, rejoining, recorder }`, each with `tickMs`. A mission's `info` adds
`mission { camera, players }`: where the camera starts (world pixels) and
the players' names and colours in engine order.

A frame carries: ticks run and the interpolation `alpha`, the tick, the
worker's simulation time, `busy` (loading a save, catching up, seeking),
driver status (save loading and its error, online catch-up and stall time,
replay position, recorder full), answers to the step's queries, sound events
(none while busy), the actor table when it changed, terrain bytes when they
changed, the sky (`weather`: `Game.weather_json()` text, for the weather
renderer, lightning, thunder and the HUD badge), and the render data: sprites
and rects (8 floats each), fog bytes of `view`, path lines when `paths` is
set, and heat shimmer instances (`heatCount`, 4 floats each,
`Game.build_heat_fx` for `view` and `rect`; on both instance paths). With
`instances: 'gpu'` (below) it carries tick-rate records and fog instead of
sprites, rects and fog, only when they changed, plus `instances`, `buildMs`
(time spent building render data this step) and `renderBytes` (render data
handed over this step). In a mission it also carries `mission { state,
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
doing. `Game.set_sprite_poses(true)` (a render setting, off by default; the
main thread turns it on when the atlas holds such art) makes body sprites
carry a pose in the sprite id:

    id = slot + 4096 * (pose + 32 * age)

`slot` is the sprite slot as before (actor `t`: body `2t`, second part
`2t + 1`; specials after them, the leftover specials of
`apps/game/js/art/leftovers.js` at `2 * actors + 68`: fire, smoke, the
PRIMARY tag and the crate pickup signs), always below 4096. Poses
(`engine/src/render.rs` `Pose`, `js/content/sequences.js` `POSE`): 0 idle,
1 move (the actor moved this tick), 2 attack (attacking and standing), 3
damaged (structure below half health, OpenRA's DamageState.Heavy), 4 make
(structure placed during the game, `age` = ticks since then, up to 127), 5
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
(AttackSequences: picked per shot, Tanya's shoot-right). Dying soldiers are drawn with their
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
OpenRA's `GetInterpolatedFacingRotation`). Slots without a pose table work
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
original War Factory roof and door, OpenRA WithProductionDoorOverlay): the
value is the layer's still pose with `age` = the number of door frames.
With poses on, the engine leaves slot `2t + 1` out while the structure is
built (make) and otherwise draws it with the idle or damaged pose (by
damage state only: the door is never paused) and `age` = the door frame,
which the layer shows as is (mode 3). The door frame
(`engine/src/doors.rs`, presentation only, not in the state hash) follows
OpenRA's `PlayFetchDirection`: 0 (shut) while the factory is idle or
building; once it produces a unit, one frame per tick up to the last while
that unit is on its exit cell and not yet idle there, then one frame per
tick back to 0. Under fog the value itself (the layer's still pose) is
drawn.

Slots from the original graphics (`Game.set_original_slots(slots, info)`, a
render setting; `js/content/atlas.js` `originalSlotInfo`) are drawn the way
OpenRA draws them: helicopter rotors are OpenRA's rotor overlays (pose 0 the
slow-rotor sequence on the ground, 1 the rotor sequence in the air, 9 and
10 for a second rotor; no WebRA rotor disc or wash), placed like turrets on
ships and spinners on units with OpenRA's classic perspective
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
(milliseconds per frame, start frames, loop frames). Presentation only: the state hash is the
same either way.

Sprite slots after the specials: the effects module (`fx_base`: 0 damage
smoke, 1 and 2 the original Tesla zap's bright and dim frames), one muzzle
flash per actor type (`muzzle_base + t`) and one explosion per name of
`engine/render.json` (`explosion_base + k`). Specials 5 and 6 (`at_mine`,
`ap_mine`) are reserved: mines are drawn as their actors, and a texture
pack's sprites of those names replace the mine actors' bodies.

`engine/render.json` (generated by `tools/gen_content_tables.py` from
OpenRA's rules and weapons) holds what the engine's effects need
(`engine/src/fx.rs`, presentation only, never in the state hash): the
CreateEffect warheads of every weapon (explosion names, where they show:
ground, open water, ship, air; delay), the muzzle flashes of every actor
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
it (webra-only). `apps/game/tests/art-audit.test.mjs` runs it on synthetic
files whose frames spell their own file and frame number, so a missing
mapping or a frame out of OpenRA's order fails CI.

Content priority per part, cameo, terrain and sound: texture pack > original
content > WebRA. The pack format is in `docs/texture-packs.md`; packs are
cosmetic and never reach the simulation.

### Game methods across the boundary

The UI holds a game handle (`js/sim/proxy.js`: `RemoteGame` for a worker,
`DirectGame` on the main thread) with the `Game`'s method names.
`js/sim/methods.js` lists them.

| Methods | Used by | Across the boundary |
|---------|---------|---------------------|
| `tick`, `apply_frame`, `take_orders`, `set_lockstep`, `state_hash`, `snapshot`, `restore` | drivers, recorder | Only in the worker (`js/sim/core.js`); hashes through `stateHash` and `encode` |
| `build_render`, `sprite_ptr`, `rect_*`, `build_render_records`, `record_*`, `rect_record_*`, `build_lines` (rally lines and, with "Show unit paths", `build_paths`), `path_ptr`, `build_heat_fx`, `fx_ptr`, `weather_json`, `fog_ptr`, `fog_len`, `terrain_*`, `take_audio_events` | main loop, audio, weather renderer | In the worker each step; results come with the frame (`take_audio_events` hands out the frame's events once) |
| `rules_json`, `map_width`, `map_height`, `cheats_enabled`, `player_count`, `start_position`, `are_allies`, `weather_json` (the start's sky), `mission_camera` | setup, command bar, terrain atlas, minimap | Static: read once at `start` |
| `is_mission`, `mission_state`, `take_mission_events` | the mission view (`js/campaign/view.js`) | In the worker each step; results come with the frame (`game.mission`, a `MissionFeed`) |
| `set_audio_events`, `set_health_bars`, `set_building_overlays`, `set_sprite_poses`, `set_original_slots`, `set_death_art` | audio, settings, atlas | `call` (render and audio settings, never simulation state) |
| `order_*`, `sell`, `repair_building`, `power_down`, `place_beacon`, `deploy`, `activate_power`, `set_rally`, `set_stance`, `start_production`, `cancel_production`, `pause_production`, `place_building`, `dev_*` | input, sidebar, command bar, minimap, debug menu, touch | `call`, in order |
| `set_selection`, `set_hover`, `set_control_groups` | input, command bar | `call`, mirrored on the main thread (`set_hover` only when it changes; `set_control_groups(ids, groups)` is local UI state for the group numbers on selection boxes, never part of the state hash) |
| `selection`, owner and kind lookups (`actor_info`) | input, command bar, audio voices | The actor table (`Game.actor_table`: id and `owner \| flags << 8 \| type << 16` per slot), synchronous |
| `pick`, `cursor_action`, `can_guard`, `can_attack_ground`, `teleport_valid`, `placement_preview`, `sell_value`, `repair_cursor`, `repair_unit_target`, `can_power_down`, `base_actors`, `harvesters`, `production_buildings`, `queue_producer`, `army_counts`, `deploy_state`, `has_minelayer`, `command_state`, `actor_json`, `debug_cells`, `debug_flow`, `debug_actors`, `debug_stats`, `player_json`, `observer_stats`, `radar_state`, `minimap_blips`, `actor_count`, `fog_bytes`, `deploy_summary` | cursor, footprint preview, command bar and deploy button state, selection panel, sidebar, observer panel, radar, debug views | Synchronous from a cache: each call registers the query, every step asks the queries called in the last 300 ms, the answers come with the frame. Before the first answer a call returns the engine's "nothing" value (`player_json` and `observer_stats`: null, and the caller waits); hover and view queries return the last answer to the same method meanwhile |
| The same queries plus `select_box`, `select_same_type`, `units_center`, `deploy_targets`, `observer_report`, `move_hint` | clicks, taps, hotkeys (select, order, place, sell, deploy, teleport, centre), the statistics screen, the attack-move tip | `ask.<method>()`: a promise of a fresh answer; the action happens when it arrives |

`deploy_summary` and `deploy_targets` are composite queries run where the
game is (one message for a whole selection instead of one per actor).

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
Restart, the next mission and the way back to the campaign screen go
through a page reload with a `webra.restart.v1` record (`js/restart.js`:
`mission { id, options, gameSpeed }`, `campaign { id }`).

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
  team are the mission's. Only the game speed of the lobby options applies.
  The game starts when every place holds a ready person. Choosing a map or
  a generated map goes back to a skirmish.
- **Start.** `start.mission` names the mission; every client loads its own
  copy of the mission file from its own server, checks the hash and starts
  `Game.from_mission` with `humans` (the playable players, engine players 0
  and 1) and `localPlayer` (its own seat). No client ever sends a script or a
  mission file to another.
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
