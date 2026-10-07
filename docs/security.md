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

## Reporting

Please report security issues privately to the repository owner rather than in
public issues.
