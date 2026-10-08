# Security

WebRA's online multiplayer is deterministic lockstep: every player runs the
same simulation, only orders travel, and the server (a Cloudflare Worker with
one Durable Object per game) relays and validates them without simulating.
That design shapes the threat model: anything that crashes one peer crashes
every peer, and every client necessarily holds the full game state.

## Review (2026-10-07)

A dedicated security review (Fable 5.1) covered the Worker API, the session
Durable Object, the protocol package, the engine's order, map and rules paths,
the browser client, the website and the CI/deploy setup. Findings and status:

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| F1 | Critical | A `place` order with an out-of-range actor type made `place_building` index past the rules table; the panic aborted the engine on every peer. | Fixed: bounds check in the engine; the protocol caps type ids (`ACTOR_TYPE_MAX`); the server rejects orders naming types the engine does not have and drops the sender. Fuzz tests throw thousands of hostile orders (extreme coordinates, unknown ids, every variant, raw JSON) at the engine. |
| F2 | Medium | Rules overrides in modded maps only had type checks, so values such as `hp: 0` could divide by zero mid-game. | Fixed: the engine validates every merged rules value (ranges, table lengths, cross references) for every modded map, on the server at upload and on each client before play; silent normalisation of bad values was removed; divisions by data are defensive. A fuzz test plays modded games with random accepted overrides. |
| F3 | Low | One player could send a wrong state hash and make the server tell everyone the game desynced. | Fixed for three or more players: hashes are compared once every active player reported; with a strict majority only the outliers are told. Without a strict majority everyone is warned, and a two-player game never has one when the hashes differ: there one player can still make both see a desync warning (nobody can tell who is right). |
| F4 | Low | No security headers on the site and game. | Fixed: `_headers` sets a strict Content-Security-Policy (no inline script; `wasm-unsafe-eval` for the engine), `frame-ancestors 'none'`, nosniff, referrer, permissions, COOP and HSTS. Inline scripts were moved to files and style attributes go through the CSSOM. |
| F5 | Info | The Origin check is CSRF protection, not authentication; a silent player stalls peers until dropped after 10 s. | Accepted (inherent to lockstep, bounded; see N4 for players that are slow on purpose). |

## Follow-up review (2026-10-07)

A second pass (Fable 5.1) over the fixes above found these gaps. Findings and
status:

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| N1 | High | Map validation only checked that a pre-placed actor's top-left cell was on the map. A structure hanging over the edge (a Construction Yard at 45,46 on a 48x48 map) passed, and `spawn_building` indexed past the cell tables for its other cells: every client trapped at game start, also on maps without rules overrides. | Fixed: the engine requires every footprint cell of a pre-placed structure on the map (the server runs this check at upload), and `spawn_building` refuses a footprint that does not fit, so no structure can cover a cell outside the map. The map editor reports it as an error. The protocol package does not repeat the check: footprints live in the engine rules, and overrides can change them. |
| N2 | High (modded maps) | `Rules::validate` missed nested fields: support power missile weapons, MAD tank weapons and aircraft crash weapons indexed the weapon table unchecked, transform offsets were read as two values whatever their length, gap generator and gap sight ranges sized vision circles of (2r)^2 cells, squad sizes spawned that many planes. Objects inside replaced arrays could change their `kind`. | Fixed: every field an override can reach is validated: weapon and actor references (spawned actors must be of a kind that can be spawned there), fixed shapes, and bounds for every range, count, list and timer. Objects inside replaced arrays keep their built-in `kind` (engine and protocol). Regression tests cover each case, and a test breaks every slot of every built-in actor and weapon at any depth (huge, negative, emptied, grown, misshapen) and plays the accepted edits in games that spawn every actor, fire every support power, deploy, teleport, lay mines and kill everything. |
| N3 | Medium | `Rules::from_raw` ran before validation and panicked on malformed shapes (unknown footprint characters, empty exits, short offsets, unknown free actors). Map uploads that trapped the engine answered 500, and the trapped WebAssembly instance stayed in use. | Fixed: `from_raw` returns errors for every malformed shape. The server calls the engine through its own small binding that drops the instance after any exception and instantiates a fresh one on the next call; a map the engine traps on is refused with 422. |
| N4 | Low | Drop detection reset on every submission, so a client sending one tick every 9 s stalled a game forever without being dropped. Later passes found that seats could take turns, that a per-seat budget let k seats rotating a stall slow the game to 2.5 / k ticks per second, and that blaming "whoever held longest" in a stalled window let a griefer get an honest seat dropped after a single freeze. | Fixed: the server counts how long each player held the game up (did not deliver the frame everyone waits for), but not the first second after the frame its client needed went out (a round trip). Within a window that renews after 25 frames (one second of game time), a player still holding after more than 10 s of it is dropped. The same time also goes into a per-seat debt that drains by 1 s every 20 s and never resets on progress; a seat whose debt passes 10 s is dropped. Only a seat's own holds count, so nobody can be framed: one freeze of up to about 10 s (a GC pause, a tab switch, a wifi roam) is never dropped, next to any griefer. Measured with the review's simulations: honest seats with a round trip up to about 1 s are never dropped (none up to 1050 ms in the simulations; the client now runs waiting frames at once as soon as the server waits for it, so its pacing adds at most one tick, about 40 ms, where a backlog of exactly delay + 1 frames used to add about 120 to 140 ms); k seats rotating 9.5 s stalls are all dropped (k = 7 within 95 s, at about 0.4 ticks per second meanwhile); seats that budget their stalls to stay under the debt keep the game at about 2.3 ticks per second or more (7 seats). Deliberate floor: a single slow player can keep the game at about 2.5 ticks per second (10 percent of normal speed) without being dropped. |
| N5 | Info | In two-player games a 1 vs 1 hash split warns both players, so one player can still show both a desync warning. | Accepted (nobody can tell who is right); F3 above now says so. |

Later re-audits also made deploying spawn the new form before removing the
old one (a refused deploy keeps the MCV), made map validation range-check spawn coordinates
first and refuse starts or pre-placed structures that share cells (and
`spawn_building` never puts a structure on a cell another one covers; starts
are placed first), and made wall pieces filled into a gap crush mines like
placed ones. The first re-audit also tightened two related checks: spawn points
are validated against the Construction Yard footprint of the map's own rules
(a modded yard can be up to 8x8; before, an edge spawn silently started
without one) and the MCV cell, and wall line filling checks every cell of each
piece (a modded multi-cell wall could overwrite a neighbour's cells).

## Debug menu cheats (2026-10-08)

The debug menu (OpenRA developer mode) adds cheat orders: `dev_flag`
(instant build, build anywhere, unlimited power, instant charge, reveal map,
all tech), `dev_cash`, `dev_kill` (destroy any actor) and `dev_experience`
(raise own units one veterancy level). They are guarded in
three places:

- **Lobby:** they only work when the host enabled the "Debug menu" option
  (`cheats`, off by default). Changing it resets everyone's ready flag, the
  online lobby shows "CHEATS ENABLED" to every player, and the agreed game
  options in the `start` message carry it, so every peer starts with the same
  setting. Rooms stored before the option existed read back with it off.
- **Server:** `apps/server/src/validate.js` `cheatsAllowed` refuses any
  `orders` message holding a cheat order in a game whose frozen options do
  not have `cheats: true`; the sender is dropped like for other protocol
  violations, so nothing reaches the other peers. The protocol schema checks
  their shape strictly (known flags only, no amount field, id lists capped).
- **Engine:** every cheat handler checks `GameOptions::cheats` and does
  nothing without it, whatever the network delivers. Cheat flags are part of
  the state hash in games with cheats. Fuzz tests send hostile cheat orders to
  games with and without the option.

With the option on, cheats are by design symmetric: every player has the
same menu and every peer applies the same orders, so they cannot desync a
game. The read-only views (cell grid, pathing, combat geometry, actor tags)
are local and only report explored cells and actors the player can see, so
they reveal nothing beyond what the screen already shows (a modified client
can still reveal the map, see "Map hack" below).

## Reconnect, spectators, replays and saves (2026-10-08)

Protocol 3 adds rejoining a running game, spectators and the order log, and
the client records every game as a replay. The guarantees above all hold;
the new paths are guarded like this:

- **Rejoin keys.** Every member gets a 32-byte random key at join
  (`welcome.key`). The server stores only its SHA-256 and compares in constant
  time; an unknown client id still costs a hash, so timing does not tell ids
  apart. Wrong keys count toward the per-IP lockout like wrong passwords. A
  key only works for its own client id, only while the game runs, at most 10
  times per member and game, and never after leaving, being kicked or being
  removed for a protocol violation (the key is forgotten). A rejoin replaces
  an open connection of the same member (it leaves lockstep first), so two
  connections never share a seat; every check that does not depend on that
  connection (game running, rejoin cap, seat not gone, spectator places,
  catch-up limits) runs first, so a refused rejoin never disconnects a member
  who is still playing. Keys live in the tab's sessionStorage (the
  strict CSP keeps script injection out).
- **Drop rules.** A lost connection takes the seat out of lockstep at once,
  so nobody is ever held up by a player who is reconnecting; the game does
  not pause for anyone. A rejoining seat gets its stall debt back as it left
  it (the debt keeps draining over wall time like for every seat), and its
  hold time in the current drop window too while that window is still the
  one it left in (a window that renewed meanwhile starts at zero for every
  seat alike), so disconnecting and coming back never resets the limits
  (lockstep.js `suspend` / `rejoin`, tests in lockstep.test.mjs). Its orders
  count from `next + delay` on, so it cannot inject orders into frames others
  already sent.
- **Deadlines.** A seat that left play has 2 minutes from that moment to come
  back. Catching up after a rejoin may take longer (60 s plus 5 ms per tick
  played, at most 15 minutes), but if the connection drops again while
  catching up, the seat only keeps what is left of the original 2 minutes:
  rejoins never extend the grace, and with the cap of 10 rejoins a missing
  seat holds the session (its storage and the 1 s alarm) for at most the
  grace plus the catch-up times it actually used. After that it is out for
  good.
- **Order log.** Kept in Durable Object storage (gzip chunks, deleted with
  the session), capped at 16 MiB of JSON: a player flooding the largest
  orders every tick could fill it in about 80 s, after which rejoins and late
  spectators are refused but the game goes on (accepted, bounded). Catch-ups
  stream the log one chunk at a time. A catch-up counts from its start until
  the client confirms it processed everything (`resume` for players, `synced`
  for spectators; a spectator that does not confirm in the catch-up time is
  closed), and at most 2 count at once, so at most two logs of output can sit
  in send buffers for slow readers. On top, at most 6 catch-ups start per
  minute and their bytes are budgeted (the current log size each, bursts of
  two full logs, one full log per minute). Frames emitted during a catch-up
  are queued for that socket, so a rejoining client never misses one.
- **Chat** has its own limit per connection (one line a second, bursts of
  five); a connection that keeps flooding is closed, so a spectator cannot
  flood every socket.
- **Spectators.** Same password and host-key rules as players, a host-set
  limit (0..8), and they never count for stalls or hash majorities. The
  server removes a spectator that sends `orders` or `hash` (an honest client
  never does). A spectator sees the whole map: no new information compared to
  the map hack every lockstep client can already do (see below); hosts who
  mind can set the spectator places to 0.
- **Replay and save files** are user files: size checked before parsing
  (32 MiB), then strictly validated by the protocol package (every order with
  the network schemas, the options, frame players, the map in canonical form
  and its SHA-256), and saves from the browser's storage are validated the
  same way on every load. Files of another engine version are refused with a
  message instead of being simulated. A modded map in a file shows the
  modded-map warning first. Loading a save checks its state hashes and
  refuses a save whose game does not match. File contents reach the page only
  through `textContent`.
- Tests: protocol (messages and replay schema), server (session Durable
  Object in memory: keys, rejoin, expiry, caps, spectator removal, order log),
  engine (replay determinism, snapshots, observer view), client (recording,
  playback, seeking, saves, rejoin and spectator catch-up through the real
  relay), and the end-to-end smoke test against `wrangler dev`.

## Simulation worker and cross-origin isolation (2026-10-08)

The simulation moved into a module Web Worker (`apps/game/js/sim`) that
shares render buffers with the page through SharedArrayBuffer. That needs a
cross-origin isolated page, so the headers changed:

- **COEP.** `/play` and everything under it send
  `Cross-Origin-Embedder-Policy: require-corp`; with the existing
  `Cross-Origin-Opener-Policy: same-origin` the game is cross-origin isolated.
  Every resource the game loads is same-origin (the CSP allows nothing else:
  scripts, styles, fonts, images, the engine, shaders, maps and the API), and
  WebSockets are not subject to COEP, so `require-corp` blocks nothing. The
  website pages keep COOP only: they share no memory.
- **Workers.** The CSP's `worker-src` is now `'self'` (it allowed `blob:`,
  which nothing used). The worker is a same-origin module script.
- **What isolation exposes.** SharedArrayBuffer and high-resolution timers
  make timing side channels easier within the process; isolation is what
  keeps cross-origin data out of it, so the page holds only its own data.
- **The boundary is not a trust boundary.** The worker runs the page's own
  code; its messages carry the same orders the page made before (the engine
  and the server still validate every order), and the worker only answers
  whitelisted methods (`apps/game/js/sim/methods.js`): anything else is
  refused. A failed or blocked worker leaves the game on the main thread.

## Inherent to lockstep

- **Map hack:** every client holds the whole simulation; fog of war is a
  client-side view. A modified client can reveal the map. Preventing this
  needs a server-authoritative simulation, which this design avoids. The wire
  carries only orders.
- **Shared fate:** an input that crashes one engine crashes all, which is why
  validation happens at the engine boundary (not only in the protocol) and is
  fuzz tested.

## What protects a game

- Orders are stamped with the sender's seat by the server and again by the
  engine (`apply_frame`); the engine re-checks unit ownership.
- Host privileges need a high-entropy host key, stored hashed; passwords are
  salted PBKDF2 with per-IP lockout; comparisons are constant time.
- Maps are identified by the SHA-256 of their canonical JSON, validated by the
  protocol package and by the engine itself (WebAssembly inside the Worker)
  before they are stored, and re-checked by every client after download. The
  MODDED flag is recomputed from content everywhere, never trusted from the
  wire, and players must accept the modded-map warning before installing.
- Rate limits per connection and per IP (`CF-Connecting-IP`), message size
  limits, strict message schemas, no `innerHTML` sinks for user text.
- Rejoin keys are high-entropy tokens stored as SHA-256 and compared in
  constant time, like the host key; spectators can never send orders.

## Reporting

Please report security issues privately to the repository owner rather than in
public issues.
