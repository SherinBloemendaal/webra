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
  "terrain": "<base64>",            // width*height bytes, row-major, values: 0 clear, 1 rough, 2 rock, 3 water, 4 tree
  "ore": "<base64>",                // width*height bytes, 0..12 ore density
  "gems": "<base64>",               // format 2 only: width*height bytes, 0..3 gem density
  "spawns": [[8, 8], [85, 84]],     // 2..8 top-left cells of the starting construction yard / MCV
  "actors": [                       // optional pre-placed actors
    { "type": "SBAG", "owner": -1, "x": 40, "y": 40, "facing": 0 }  // owner: spawn index, or -1 for neutral
  ],
  "rules": null                     // optional rules overrides, see below
}
```

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
  format 2, right after `ore`; `actors` entries
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
  exports a generated map file (format 2: generated maps have gems); previews: `Game.map_file_preview(mapJson)` and
  `Game.map_preview_players(seed, size, players)` (RGBA per cell, spawns in
  player colours).

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
  rock on the right and bottom. Tilesets map to biomes in `TILESET_BIOMES`
  (not stored yet).
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
redeployableMcv, oreRegrowth, cheats, map`. `cheats` is the "Debug menu"
option (OpenRA's `cheats`, default off): only then do the debug menu's cheat
orders work (section 5). `team` 0 means no team (free for all);
players with the same non-zero team are allies (shared vision, no
auto-targeting, win together). 2..8 players. Closed slots are listed as
`{slot, type: "closed"}` and do not play: engine player N is the N-th slot
that is not closed, and it takes spawn N. `map` is the map file JSON string
(the client starts `Game.from_map(map, options)`) or null for a generated map
(`Game.from_options(options)`); it is not passed on to the engine options.

Generated 2-player maps are mirrored left to right with both bases at the
same height, so mirror matches are fair: Red Alert structures face south
(exits, refinery docks), which favours one side on a point symmetric map.
Generated maps for 3 to 8 players are mirrored left to right too, and every
base gets the same surroundings, shifted and never rotated (a clearing with
its ore fields south of the yard, rock walls north and south, open sides):
3 and 4 players in two rows (the bottom half repeats the top half), 5 to 8
on a ring. Their spawns are listed by column, top first, so slots 0 and 1
(the left column of a 4-player map) against slots 2 and 3 is a mirror match.
Gems lie only in contested fields, as the dense middle of an ore field: on
2-player maps in the two contested fields of each half (mirrored), on 3 to 8
player maps in every field halfway between two neighbouring bases. No base
pocket holds gems, so every base has the same home ore and gems are always
something neighbours fight over.

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

### WebSocket messages (JSON, `{ "t": type, ... }`)

Client to server:

| t | Fields | When |
|---|--------|------|
| `hello` | `protocol, version, name, password?, hostKey?, spectate?, rejoin?: { client, key }` | first message |
| `slot` | `slot, faction?, color?, team?, type?(host only: ai/closed/open), difficulty?` | lobby |
| `spectators` | `max` (0..8, host only, not below the spectators present) | lobby |
| `spectate` | `on: bool` (move between a player slot and the spectators) | lobby |
| `resume` | | rejoining player, after catching up |
| `synced` | | spectator joining a running game, after catching up |
| `options` | `options` (host only) | lobby |
| `map` | `{ id, hash, name, modded }` (host only) | lobby |
| `ready` | `ready: bool, mapHash` | lobby (must have the map installed) |
| `chat` | `text` (<= 200 chars) | any time |
| `start` | (host only, everyone ready) | lobby |
| `orders` | `tick, orders: [...]` | in game, every tick (may be empty) |
| `hash` | `tick, hash` | in game, every 25 ticks |
| `leave` | | any time |

Server to client: `welcome {you, hostId, session, role, key?}`, `lobby {slots,
options, map, hostId, spectators: [{client, name}], maxSpectators}`, `chat
{from, text}`, `start {seed, options, map, players, delay}`, `frame {tick,
orders: [[player, [...]], ...]}`, `desync {tick}`, `left {player, client, name,
reason}` (`player` null for spectators and lobby members; reasons `left`,
`dropped`, `kicked`, `disconnected`, `removed`, `expired`), `log {frames:
[[tick, orders], ...]}`, `sync {tick, check: {tick, hash} | null}`, `back
{player, client, name, tick}`, `error {code, message}`. Protocol version 3
(`PROTOCOL_VERSION`); `/api/version` reports it and older clients are refused
at `hello`.

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

Engine side (landed): `Game.set_lockstep(true)` makes order methods queue into
an outbox; `Game.take_orders()` returns them as a JSON array of order objects
(`{"o": "move", ...}`, see `Order` in engine/src/world.rs); 
`Game.apply_frame('[[player, [order, ...]], ...]')` queues one frame before
`tick()` and re-stamps every order with that player index (invalid entries are
skipped, returns the count). `Game.state_hash()` (hex string) for desync
checks, `Game.player_count()`. Players: 2..8, `team` per player (0 = free for
all); `player_json` has `won`, `defeated` and `team`.

Observers (engine/src/observer.rs): `Game.observer_player()` (255) passed to
`build_render` and `fog_ptr` renders the whole map with every actor live (no
ghosts, no owner-only decorations); `Game.observer_stats()` returns `[{
player, faction, team, cash, funds, earned, armyValue, unitsKilled, unitsLost,
buildingsKilled, buildingsLost, powerGenerated, powerUsed, defeated, won }]`
for the non-neutral players (kills credited to the owner of the weapon that
dealt the killing damage; not part of the state hash). `Game.snapshot()` and
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
- `/play/*`: `apps/game` (with `pkg/` from wasm-pack and `protocol/`)
- `/api/*`: the Worker's fetch handler (`apps/server/src`)

Build: `npm run build` assembles `dist/` (website at the root, game under
`play/`) and writes `dist/version.json` and `dist/release-notes.json`. The
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
Objects (SQLite) for sessions, D1 database `webra` for maps and the session
directory.

## 7. Replays and saves

Every game records itself (apps/game/js/replay.js): the engine runs in
lockstep mode also in single player, so the local player's orders go through
the outbox and are applied as frames, exactly like online. A replay or save
file is JSON, validated by `parseReplay` in packages/protocol (src/replay.js)
before any use:

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
- A save is a replay of kind `save` whose `hashes` end with the hash of its
  last tick. Loading re-simulates it (fast-forward with progress), refuses it
  when a stored hash does not match, then play continues and the recording
  goes on from the save. Saves go to the browser (IndexedDB database
  `webra`, store `saves`, at most 50) or to a file.
