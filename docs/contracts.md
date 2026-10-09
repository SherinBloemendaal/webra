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
  "terrain": "<base64>",            // width*height bytes, row-major, values: 0 clear, 1 rough, 2 rock, 3 water, 4 tree, 5 ford
  "ore": "<base64>",                // width*height bytes, 0..12 ore density
  "gems": "<base64>",               // format 2 only: width*height bytes, 0..3 gem density
  "spawns": [[8, 8], [85, 84]],     // 2..8 top-left cells of the starting construction yard / MCV
  "actors": [                       // optional pre-placed actors
    { "type": "SBAG", "owner": -1, "x": 40, "y": 40, "facing": 0 }  // owner: spawn index, or -1 for neutral
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
  gems up to 3. Both lie on clear or rough ground only, and a cell holds ore
  or gems, never both. A bale pays `player.ore_value` (25) or
  `player.gem_value` (50) credits (OpenRA `PlayerResources.ResourceValues`);
  a harvester carries 20 bales of either or both and the refinery pays each
  bale at its own value. With the `oreRegrowth` option ore regrows and
  spreads onto free clear ground; gems neither regrow nor spread (Red Alert).
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
  lie on clear or rough ground`, `a cell cannot hold both ore and gems`,
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
human|ai|closed, name, faction, color, team, difficulty}], startingCash,
startingUnits, techLevel, gameSpeed, fog, explored, buildRadius,
redeployableMcv, oreRegrowth, cheats, mapStyle, biome, weather, map`.
`mapStyle` (`random`, `land`, `rivers`, `lakes`, `islands`) and `biome`
(`random`, `temperate`, `snow`, `desert`) shape a generated map; `random`
is resolved by the engine from the seed, so every peer gets the same map and
sky. A map file brings its own biome and ignores both. `weather` is `full`
(visuals and gameplay effects), `cosmetic` (visuals only: the simulation runs
as under clear skies, including the biome effects) or `off` (clear skies).
The protocol requires all three (protocol version 4); the engine treats
missing keys as `random`, `temperate` and `full` (older callers, tools) and
refuses unknown values. `cheats` is the "Debug menu"
option (OpenRA's `cheats`, default off): only then do the debug menu's cheat
orders work (section 5). `team` 0 means no team (free for all);
players with the same non-zero team are allies (shared vision, no
auto-targeting, win together). 2..8 players. Closed slots are listed as
`{slot, type: "closed"}` and do not play: engine player N is the N-th slot
that is not closed, and it takes spawn N. `map` is the map file JSON string
(the client starts `Game.from_map(map, options)`) or null for a generated map
(`Game.from_options(options)`); it is not passed on to the engine options.

Game modes (`packages/protocol/src/presets.js`, `apps/game/js/modes.js`)
are named bundles of every lobby option except `seed` and `mapSize`:
Classic, Weather war, Winter, Desert storm, Islands naval, Rush, Turtle and
Sandbox (skirmish only), plus the player's saved modes (settings
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
also mirrored top to bottom), 5 to 8 on a ring. On the water styles the walls
are harbour moats; the moat nearer the hub is dug through to it, nearly
straight, and the other one becomes rock, so every base has exactly one
harbour on the network and every harbour is about as far from the hub as its
base is. Ground routes that would be cut by water get fords. Their spawns are
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
times the nearest plus 8 cells.

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
| `GET` | `/api/sessions` | `[{ id, name, host, players, maxPlayers, locked, map: { id, name, hash, modded }, version, state }]` (public, open lobbies only) |
| `POST` | `/api/sessions` | `{ name, password?, public, maxPlayers, version }` -> `{ id, hostKey }` |
| `GET` | `/api/sessions/:id/ws` | WebSocket upgrade into the session's Durable Object |
| `GET` | `/api/maps` | `[{ id, name, author, players, width, height, hash, modded, downloads, createdAt }]` |
| `GET` | `/api/maps/:id` | the map JSON |
| `POST` | `/api/maps` | map JSON -> `{ id, hash }` (validated, size limited, rate limited) |
| `GET` | `/api/content/ra-quickinstall` | OpenRA's `ra-quickinstall.zip` (EA's freeware Red Alert files) streamed from OpenRA's mirrors, see below |
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
`Sec-Fetch-Site` absent or `same-origin`) and stay within 3 downloads per
hour per IP (D1 quota table, IP as a salted hash; 429 with `Retry-After`).
The Worker tries the mirrors in order (`openra.baxxster.no`,
`republic.community`, `openra.0x47.net`, `openra.ppmsite.com`) with
`cache: 'no-store'` (Cloudflare's cache bypassed), takes the first answer
whose `Content-Length` is exactly 13,502,031 bytes and passes its body
through as a stream, cut off if it runs longer (15 s for a mirror to
answer, 240 s for the transfer). Response: `200`, `Content-Type:
application/zip`, `Content-Length`, `Cache-Control: no-store`,
`Cross-Origin-Resource-Policy: same-origin`; 502 when no mirror fits.
Nothing is stored anywhere on the server.

### WebSocket messages (JSON, `{ "t": type, ... }`)

Client to server:

| t | Fields | When |
|---|--------|------|
| `hello` | `protocol, version, name?, password?, hostKey?, spectate?, rejoin?: { client, key }` (`name` required without an account; ignored for signed-in connections, which play under their username) | first message |
| `slot` | `slot, faction?, color?, team?, type?(host only: ai/closed/open), difficulty?` | lobby |
| `spectators` | `max` (0..8, host only, not below the spectators present) | lobby |
| `spectate` | `on: bool` (move between a player slot and the spectators) | lobby |
| `resume` | | rejoining player, after catching up |
| `synced` | | spectator joining a running game, after catching up |
| `options` | `options` (host only) | lobby |
| `map` | `{ id, hash, name, modded }` (host only) | lobby |
| `ready` | `ready: bool, mapHash` | lobby (must have the map installed) |
| `chat` | `text` (<= 200 chars) | any time |
| `defeated` | | in game, a player whose engine defeated it (once per connection) |
| `start` | (host only, everyone ready) | lobby |
| `orders` | `tick, orders: [...]` | in game, every tick (may be empty) |
| `hash` | `tick, hash` | in game, every 25 ticks |
| `leave` | | any time |

Server to client: `welcome {you, name, hostId, session, role, key?}`, `lobby {slots,
options, map, hostId, spectators: [{client, name, account?}], maxSpectators}`
(human slots and spectators carry `account: true` when the name comes from a
signed-in account), `chat
{from, text}`, `start {seed, options, map, players, delay}`, `frame {tick,
orders: [[player, [...]], ...]}`, `desync {tick}`, `left {player, client, name,
reason}` (`player` null for spectators and lobby members; reasons `left`,
`dropped`, `kicked`, `disconnected`, `removed`, `expired`), `log {frames:
[[tick, orders], ...]}`, `sync {tick, check: {tick, hash} | null}`, `back
{player, client, name, tick}`, `error {code, message}`. Protocol version 5
(`PROTOCOL_VERSION`); `/api/version` reports it and older clients are refused
at `hello`. Version 5 added accounts: the optional hello `name`, the welcome
`name`, the `account` marks, one place per account and session, rejoin keys
bound to their account, and the error codes `account_required`,
`account_inactive`, `banned` and `ip_banned` (sent in answer to `hello`, or
when a ban drops a connected member with left reason `removed`).

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
ghosts, no owner-only decorations); `Game.observer_stats()` returns `[{
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

Orders `start_production {ty, count}` and `cancel_production {ty}` serve every
queue, structures included (no extra order types):

- Structures queue like units (OpenRA): left click queues one, shift queues
  five. Only the first item of a queue is built. A finished structure waits
  for placement and the items behind it do not start until it is placed, so
  each structure queue has at most one ready structure. `place` only accepts
  the finished head of the queue.
- `cancel_production` removes the last queued item of that type and refunds
  what was paid for it (a finished structure refunds its full cost).
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

## 5. Domains for units

`engine` units move in a domain: `ground` (flow fields on land), `water` (flow
fields on water cells, naval yards are their docks) and `air` (free flight,
no pathfinding). Queue types: Building, Defense, Infantry, Vehicle, Aircraft,
Ship. Target classes: infantry 1, vehicle 2, structure 4, air 8, water 16,
mine 32, underwater 64 (submerged submarines), submarine 128 (any
submarine; depth charge warheads). Naval yards are structure and water.

Transports (engine/src/cargo.rs): a right-click with units on an own
transport they fit in is the smart action `Load` (6, `Game.cursor_action`).
`Game.deploy` on a loaded transport unloads it; `Game.deploy_state` is 1 when
it can unload now and 2 when no free cell is next to it. `Game.actor_json`
reports `passengers` (ids), `cargoWeight`, `cargoMax`, `carrier` (the
transport a passenger is in, or 0xFFFFFFFF) and `submerged`. Passengers are
out of the world: not pickable, not box-selectable, dropped from the selection.

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
`can_guard`, `can_attack_ground`, `are_allies` and `set_hover(id)` (that
actor and the targets of the selection get health bars). Target class 256 is
`ground` (terrain for force-fire; no actor has it). Return fire uses the shooter that every shot
carries for veterancy (`Shot.source`), so shells in flight count too.

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
  "kind": "replay",                 // or "save" (skirmish only)
  "mode": "skirmish",               // or "online"
  "engine": "0.3.0+abcdef12",       // Game version(): files only load in the same build
  "createdAt": 1760000000000,
  "title": "England vs 1 opponent", // 1..64 chars
  "options": { ... },               // engine game options (section 3), closed slots left out
  "map": null,                      // or the canonical map JSON text (section 2)
  "mapHash": null,                  // sha256 of `map`, checked on load
  "player": 0,                      // the recording player, null for a spectator
  "ticks": 1200,                    // ticks recorded
  "frames": [[12, [[0, [{ "o": "move", ... }]]]]],  // non-empty frames, tick < ticks, increasing
  "hashes": [[250, "0123456789abcdef"]]            // state hash after N ticks, every 250 ticks
}
```

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
  viewer restarts playback in place. Online games have no restart.
- A save is a replay of kind `save` whose `hashes` end with the hash of its
  last tick. Loading re-simulates it (fast-forward with progress), refuses it
  when a stored hash does not match, then play continues and the recording
  goes on from the save. Saves go to the browser (IndexedDB database
  `webra`, store `saves`, at most 50) or to a file.

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
| `call` | `method`, `args` | none: an order, `set_selection`, `set_hover`, `set_audio_events`, `set_health_bars`, `set_building_overlays` |
| `ask` | `id`, `method`, `args` | `result { id, value }`: a fresh query answer |
| `command` | `id`, `name`, `args` | `result { id, value }`: `net` (`frame`/`log`/`sync`), `back`, `reattach`, `stop`, `hidden`, `seek`, `setSpeed`, `togglePlay`, `dispose`, `encode` (`save`/`replay`: `{ text, ticks, full }`), `debugStep`, `stateHash`, `tick` |
| `step` | `req { dt, paused, view, rect, audio, paths, table, queries, instances }`, `recycle` | `frame` |

Worker to main thread, unasked: `event { type, payload }` (`send { msg, epoch }`
for the lockstep driver's network messages, `caughtUp`, `check { ok, tick }`),
`warn`, and `failed` (the worker cannot go on; the page says so).

Start specs: `skirmish { options, map, player, recorder }`, `save { replay }`,
`replay { replay }`, `stress { seed, units, size }`, `online { options, map,
player, spectator, delay, rejoining, recorder }`, each with `tickMs`.

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
handed over this step).

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

    id = slot + 4096 * (pose + 16 * age)

`slot` is the sprite slot as before (actor `t`: body `2t`, second part
`2t + 1`; specials after them), always below 4096. Poses
(`engine/src/render.rs` `Pose`, `js/content/sequences.js` `POSE`): 0 idle,
1 move (the actor moved this tick), 2 attack (attacking and standing), 3
damaged (structure below half health, OpenRA's DamageState.Heavy), 4 make
(structure placed during the game, `age` = ticks since then, up to 127), 5
harvest, 6 dock (unloading at the refinery), 7 still (no power, or a
remembered structure under fog), 8 damaged and still. Walls report idle or
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
flags: 1 classic facings, 2 free rotation; interpolated facings). Modes: 0
loop on the render clock, 1 once from `age` (then the idle descriptor), 2
first frame, 3 frame `age`. The facing comes from the instance angle:
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
original War Factory roof and door, OpenRA WithProductionDoorOverlay): with
poses on, the engine draws slot `2t + 1` with the structure's pose (idle,
damaged, still), leaves it out while the structure is built (make), and
gives it the make pose with `age` = ticks since the youngest unit of the
owner within two cells of an exit appeared (the door opens and closes once).
Under fog the value itself (the layer's still pose) is drawn.

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
| `build_render`, `sprite_ptr`, `rect_*`, `build_render_records`, `record_*`, `rect_record_*`, `build_paths`, `path_ptr`, `build_heat_fx`, `fx_ptr`, `weather_json`, `fog_ptr`, `fog_len`, `terrain_*`, `take_audio_events` | main loop, audio, weather renderer | In the worker each step; results come with the frame (`take_audio_events` hands out the frame's events once) |
| `rules_json`, `map_width`, `map_height`, `cheats_enabled`, `player_count`, `start_position`, `are_allies`, `weather_json` (the start's sky) | setup, command bar, terrain atlas, minimap | Static: read once at `start` |
| `set_audio_events`, `set_health_bars`, `set_building_overlays`, `set_sprite_poses` | audio, settings, atlas | `call` (render and audio settings, never simulation state) |
| `order_*`, `sell`, `deploy`, `activate_power`, `set_rally`, `set_stance`, `start_production`, `cancel_production`, `place_building`, `dev_*` | input, sidebar, command bar, minimap, debug menu, touch | `call`, in order |
| `set_selection`, `set_hover` | input, command bar | `call`, mirrored on the main thread (`set_hover` only when it changes) |
| `selection`, owner and kind lookups (`actor_info`) | input, command bar, audio voices | The actor table (`Game.actor_table`: id and `owner \| flags << 8 \| type << 16` per slot), synchronous |
| `pick`, `cursor_action`, `can_guard`, `can_attack_ground`, `teleport_valid`, `placement_preview`, `sell_value`, `deploy_state`, `has_minelayer`, `command_state`, `actor_json`, `debug_cells`, `debug_flow`, `debug_actors`, `debug_stats`, `player_json`, `observer_stats`, `radar_state`, `minimap_blips`, `actor_count`, `fog_bytes`, `deploy_summary` | cursor, footprint preview, command bar and deploy button state, selection panel, sidebar, observer panel, radar, debug views | Synchronous from a cache: each call registers the query, every step asks the queries called in the last 300 ms, the answers come with the frame. Before the first answer a call returns the engine's "nothing" value (`player_json` and `observer_stats`: null, and the caller waits); hover and view queries return the last answer to the same method meanwhile |
| The same queries plus `select_box`, `select_same_type`, `units_center`, `deploy_targets`, `observer_report` | clicks, taps, hotkeys (select, order, place, sell, deploy, teleport, centre), the statistics screen | `ask.<method>()`: a promise of a fresh answer; the action happens when it arrives |

`deploy_summary` and `deploy_targets` are composite queries run where the
game is (one message for a whole selection instead of one per actor).
