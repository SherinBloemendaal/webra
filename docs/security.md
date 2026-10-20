# Security

WebRA's online multiplayer is deterministic lockstep: every player runs the
same simulation, only orders travel, and the server (a Cloudflare Worker with
one Durable Object per game) relays and validates them without simulating.
That design shapes the threat model: anything that crashes one peer crashes
every peer, and every client necessarily holds the full game state.

## Review (2026-10-07)

An independent security review covered the Worker API, the session
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

A second independent review over the fixes above found these gaps. Findings and
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
  key only works for its own client id, only while the game runs (and, since
  protocol 6, to come back into the lobby after a rematch: repeatedly, but
  only until that member's return deadline), at most 10
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

## Original content and texture packs (2026-10-09)

- **Files from the player.** Original Red Alert files (MIX, SHP, PAL, TMP,
  AUD, OpenRA's `ra-quickinstall.zip`) and texture packs are parsed in the
  browser as hostile input: every offset and size is checked, decoders never
  read or write outside their buffers (fuzz tested), sizes and frame counts
  are capped, and ZIPs go through the hardened `.oramap` reader (compression
  ratio, entry and total limits, streamed inflate, CRC). The quick install
  ZIP gets raised size limits for its known shape only; the ratio checks
  stay.
- **Packs are data.** A pack holds PNG images and OGG, WAV or MP3 sounds
  only (by signature; other file types refuse the pack), images are checked
  from the PNG header before the browser decodes them with
  `createImageBitmap`, nothing is ever run or inserted as HTML, and the
  manifest has no keys that reach the simulation (unknown keys are refused).
  Different packs on different clients cannot desync a game.
- **Stored locally.** Installed content and packs stay in IndexedDB on the
  player's device; nothing is uploaded.
- **The server relays EA's freeware files.** `GET
  /api/content/ra-quickinstall` (`apps/server/src/content.js`) streams
  OpenRA's `ra-quickinstall.zip` from OpenRA's community mirrors for the
  game's one-click install, only when the player clicks. These are
  Electronic Arts' Red Alert files (freeware since 2008), so
  webra.sherin.dev passes EA's files through; the project owner chose this
  with the risk explained (OpenRA itself only lets the client download from
  the mirrors). Limits: the game page only (`X-WebRA-Content` header, Origin
  and `Sec-Fetch-Site` checks), the account gate (below), and budgets in the
  D1 quota table that count completed downloads, not attempts: 8 per account
  per UTC day and 20 per network per hour (an IPv4 address, or the /64 of an
  IPv6 address, so a household behind one address and a phone with rotating
  privacy addresses each count as one network), plus ceilings on requests
  whatever their outcome, never given back: 24 per account per UTC day and
  30 per network per hour. A download is charged when it starts and given
  back (`refundQuota`) when it does not complete: no mirror answered (502),
  the transfer broke off or ran too long, or the player cancelled (the
  stream's end is seen by the Worker and the refund runs under
  `waitUntil`); so a retry of a failed download is charged once. A
  transfer counts as completed as soon as every byte went to the player
  (the upstream is then cancelled), so a player closing right after the
  last byte gets no refund; and since refunds never touch the attempt
  ceilings, cancelling just before the end from many networks (a /56 holds
  256 /64s) cannot buy more than 24 transfers a day. `takeQuota` gives back
  what it took when a concurrent request took the last units between its
  read and its write. A 429 with `scope: network` tells the player that
  others on the same network used its budget (no more than the address
  itself reveals to anyone on that network). An account over its day is refused by one read, without a
  write or an attempt. Keys are salted hashes of the account id and the
  network (never logged); a 429 carries `Retry-After` and `retryAfter` and
  `scope` (`account` or `network`) in the body, and the game shows the time
  and never retries on its own. Admins can see and reset an account's
  budgets and those of the networks it used in the last day (audit logged,
  without addresses: docs/accounts-api.md 8.10). The game keeps the
  downloaded ZIP on the device (`content/index.js` `KEPT_PACKAGE`), so an
  install in the same browser again or a WebRA update that uses more of its
  files needs no new download. Exactly
  13,502,031 bytes or nothing (checked from `Content-Length` before
  streaming, cut off if the body runs longer), 15 s for a mirror to answer
  and 240 s for the transfer. Nothing is stored or cached: no Cache API, KV,
  R2 or D1 for the content, `cache: 'no-store'` upstream and `Cache-Control:
  no-store` downstream. Tests mock the mirrors; CI never downloads them.
- **The music relay reads one file out of the freeware CDs.** `GET
  /api/content/ra-scores` (`apps/server/src/cdmusic.js`) serves byte ranges
  of `scores.mix` (the soundtrack, 64,171,360 bytes) out of the freeware
  Red Alert CD images (EA's `CD1_ALLIED_DISC.ISO` and `CD2_SOVIET_DISC.ISO`
  of 2008) on the Internet Archive, for the game's one-click music install.
  It is not a proxy: the player sends only a range of `scores.mix`
  (`Range: bytes=a-b`, one range, at most 8 MiB, inside the file; anything
  else is 416 before any fetch or quota write); the Worker adds the pinned
  offset of `scores.mix` in the pinned image and asks the pinned URL
  (`archive.org/download/command-conquer-red-alert_202309/...[CD1].ISO`,
  then `[CD2].ISO`) for exactly that window, so no other part of the discs
  can be read through it. Redirects are followed by hand (`redirect:
  'manual'`), once, and only to an https data node of the archive
  (`ia<n>`/`dn<n>.<region>.archive.org`, default port, no user info, query,
  fragment or backslash) with the path `/<n>/items/<item>/<file>`, whose
  item and file must equal the pinned ones after percent-decoding both
  sides (a segment that does not decode, or decodes to `.`, `..`, a slash,
  a backslash or a control character, is refused). The request after the
  redirect goes to that node with the pinned, escaped item and file, never
  the location's own path. Observed on 2026-10-09 with one `redirect:
  'manual'` request per pinned URL (Location header only): the archive
  answers `302` with the file name fully escaped, for example
  `https://dn721505.ca.archive.org/0/items/command-conquer-red-alert_202309/Command%20%26%20Conquer%20Red%20Alert%20%5BCD1%5D.ISO`
  (earlier probes also saw `https://ia601402.us.archive.org/20/items/...`);
  a redirector that left `[`, `]` or `&` unescaped would match too. A
  piece that does not arrive whole (the upstream fails before anything
  streams with a 502, the transfer breaks off, the player cancels) gives
  its bytes back to the account's daily budget (`refundQuota`, never below
  zero; the network request and the account's request still count: at
  most 96 requests of at most 8 MiB per account per UTC day, so an account
  can pull at most 768 MiB of music upstream a day whatever it cancels), so the game's retry of that
  piece is charged once, and a piece counts as whole once every byte went
  out; the game retries a 502 at most once per click and
  never retries a 429. The answer must be `206` with `Content-Range` of
  exactly the asked window and the pinned image size (a changed or other
  image is refused) and is streamed through cut to the asked length. Only
  `GET`, the game page (`X-WebRA-Content`, Origin, `Sec-Fetch-Site`), the
  same account gate as the package relay (active, `content_autoinstall` or
  admin, `contentRelay` on, address not banned). Budgets in the D1 quota
  table: 256 MiB per account per UTC day (each request counts its size,
  rounded up to whole MiB: four full downloads) and 64 requests per network
  (IPv4 address or IPv6 /64) per hour; keys are salted hashes. No player header (cookie, address) goes
  upstream; nothing is stored or cached (`cache: 'no-store'`, `Cache-Control:
  no-store`). At most four upstream attempts per request (two rounds over
  the two discs, the archive's data nodes sometimes answer 500 once), 15 s
  for headers, 120 s per piece. The game checks the assembled file against
  the pinned SHA-256 before it installs anything and throws a mismatch away.
  The pins (image sizes, offsets, the size and SHA-256 of `scores.mix`)
  were measured once with range requests: the ISO 9660 directory gives
  `MAIN.MIX`'s extent, its encrypted MIX index gives `scores.mix`'s offset,
  the first 4,096 bytes of `MAIN.MIX` match the SHA-1 that OpenRA's content
  installer uses to recognise each disc (`mods/ra-content/installer/allies95.yaml`
  and `soviet95.yaml`), the image sizes match EA's 2008 download, and only
  the `scores.mix` range was downloaded to hash it (the same hash on both
  discs). They are numbers about EA's files, not the files. Tests use
  synthetic bytes and a mocked archive.
- **The movie relay reads the movie archives out of the same discs.** `GET
  /api/content/ra-movies/allied` and `/soviet` (`moviesRange` in
  `apps/server/src/cdmusic.js`) are the same relay for `movies1.mix`
  (369,362,336 bytes at offset 19,846,497 of the Allied image) and
  `movies2.mix` (415,334,456 bytes at offset 19,834,209 of the Soviet
  image), each only from the disc that has it: the same Range rules (one
  range of at most 8 MiB inside the archive, 416 otherwise), the same
  redirect checks, `Content-Range` checks, account gate, no-store and
  refunds. Their budgets are their own, sized for archives of hundreds of
  megabytes: 1,500 MiB (both archives twice) and 288 requests (three per
  piece of both) per account per UTC day, and 192 requests per network per
  hour; the requests are never given back, so an account can pull at most
  288 x 8 MiB = 2,304 MiB of movies upstream a day whatever it cancels. The game offers them as an
  optional button with the size (about 748 MB) and never as part of
  "Install everything". It checks every 8 MiB piece against its pinned
  SHA-256 before it keeps it (`apps/game/js/content/cdmovies.js`; a whole
  archive is never held in memory), installs the movies from the kept
  pieces and then forgets them. The pins were measured on 2026-10-10 like
  the music's: the offsets from the ISO 9660 directory and `MAIN.MIX`'s
  index (the `scores.mix` offsets found the same way matched the existing
  pins), the hashes by streaming each archive once by range through a hash
  without writing it anywhere. The Counterstrike and Aftermath music is not
  relayed: those expansion discs were not part of EA's 2008 freeware
  release, so players install it from their own discs.
- **CD images from the player.** A dropped or picked `.iso` is read by
  slices (`File.slice`), never loaded whole: the volume descriptor, the
  directories on the way to `MAIN.MIX` and `INSTALL/REDALERT.MIX`, then
  those archives' indexes and the wanted entries, all bounds checked
  (`apps/game/js/content/iso.js`: directories capped at 1 MiB, depth at 8,
  records must stay inside their directory, files inside the image,
  multi-extent files refused, records may not cross a sector). From any
  archive or picked loose, a wanted file larger than its limit (32 MiB for
  a music track, 8 MiB for anything else) is reported as too large from its
  index size, before anything is read.

## Accounts and admin (2026-10-09)

Accounts, sign-in, sessions, bans and the admin API
([accounts API](accounts-api.md), `apps/server/src/accounts`). Every
guarantee above still holds: host keys, rejoin keys, passwords of lobbies,
spectator rules, stall rules and rate limits are unchanged; accounts add
checks in front of them.

**Assets:** account credentials (password hashes, passkey public keys,
Discord links), session ids, email and reset links, the IP history (personal
data, admins only), roles (admin powers), and the right to play online.

**Threats and what answers them:**

- **Password guessing and stuffing.** PBKDF2-HMAC-SHA256 through WebCrypto,
  16-byte salt per hash, iteration count stored per hash (default 40,000,
  sized so one derivation takes about 3 to 6 ms of the Workers Free plan's
  10 ms per request; raised with `PASSWORD_ITERATIONS` up to the Workers
  maximum of 100,000, at most 50,000 on the Free plan; the deployment
  uses 100,000 on the Workers Paid plan), optional pepper from
  a Worker secret recorded per hash. No request derives more than one key;
  hashes are upgraded when the password is next set, never at sign-in.
  Sign-in throttling resolves the login to its account first (username and
  email share a budget): a burst limit per IP, 10 failures per 15 minutes per
  account and IP (only that address is locked), 100 failures a day per IP,
  and per account an escalating delay (doubling from the 10th failure in a
  day, at most 15 minutes) that does not apply to addresses the account
  signed in from before, so a third party cannot keep the owner out; there
  is no hard lock. Unknown names are throttled the same way, so a lockout
  does not reveal accounts. Wrong name, wrong
  password, deleted account and password-less account all get the same
  `bad_credentials` answer after the same work (unknown names still pay for a
  hash). New passwords: 10 to 128 characters, not the username or email, not
  on a list of very common passwords. Comparisons are constant time.
- **Session theft and fixation.** Session ids are 32 random bytes in an
  HttpOnly, Secure, SameSite=Lax cookie with the `__Host-` prefix (no Domain,
  Path=/); only their SHA-256 is stored. A new id on every sign-in (the
  previous cookie's session is deleted), on re-authentication and credential
  changes; password changes and resets revoke the other sessions; role
  changes, status changes away from active and bans revoke all of them. 30
  days absolute, 14 days idle.
  Plain-HTTP cookies without `Secure` exist only for local development hosts;
  a plain-HTTP request to any other host still gets a Secure cookie, which
  browsers refuse to store, so it fails closed.
- **CSRF and cross-site use.** Every state-changing request needs an Origin
  equal to the site, `Sec-Fetch-Site` same-origin or absent, the custom
  header `X-WebRA-CSRF: 1` (forces a CORS preflight the API never answers)
  and a JSON body; account and admin reads need the header too. The only
  cross-site entry is the Discord callback, which works only with the single
  use state bound to the browser's OAuth cookie.
- **Account takeover through recovery.** Email links carry 32 random bytes,
  are stored hashed, work once (deleted on first use, also when the attempt
  fails), expire (1 hour reset, 24 hours verification), are replaced by newer
  ones of the same purpose, and travel in the URL fragment (never in server
  logs or a Referer). Only verified addresses get reset links, a reset link
  only works while the account's email is still the one it was sent to, and
  an unverified address claims nothing (another account may use and verify
  it; see "Required email and verification" below), so typing someone else's
  address neither squats it nor lets its owner take the account over. "Forgot password" answers the same
  whether or not an address exists and is limited per IP and per address.
  Sensitive changes (password, email, passkeys, Discord, export, deletion)
  need an explicit re-authentication from the last 10 minutes (password,
  passkey with user verification, or Discord; signing in does not count);
  failed re-authentications lock after 10 per 15 minutes. An account always
  keeps at least one sign-in method (checked in one conditional statement,
  so concurrent removals cannot race).
- **Passkeys.** Implemented server-side without libraries: strict CBOR
  (no indefinite lengths, tags or duplicate keys, bounded depth and sizes),
  challenges of 32 random bytes that are single use, bound to their purpose
  and account and expire after 5 minutes, exact origin and rp id hash checks,
  user presence required (user verification too for re-authentication),
  floats refused, ES256 (strict minimal DER signatures), RS256
  (2048-bit keys or more) and Ed25519. The signature counter must grow when
  either side is non-zero; a regression refuses the sign-in and flags the
  passkey. Attestation is not trusted (format `none` requested). Tests drive
  every ceremony with a software authenticator.
- **Discord.** Authorization code with PKCE (S256) and state; the state is
  single use, expires after 10 minutes and is bound to an HttpOnly cookie, so
  a callback URL stolen or planted in another browser does nothing. The
  verifier stays on the server; the access token is revoked right after the
  profile is read. A Discord email counts as verified only when Discord says
  so, and never links an existing account by itself (an email collision
  refuses the signup). Discord usernames go through the lobby text rules.
  `returnTo` is a same-site path only.
- **Privilege escalation.** Roles are checked on the server for every admin
  route, and only for **active** accounts (pending or banned staff have no
  powers; a status change away from active signs the account out).
  Moderators approve, reject, ban and unban plain users and view users with
  masked emails; admins do everything. Nobody acts on themselves, and the
  last active, unbanned admin cannot be deactivated, demoted, banned or
  deleted. The first admin is made outside the web API
  (`tools/promote-admin.mjs`). The test-only promote route needs a variable
  that is never configured for deploys, plain HTTP and a local host, all
  three (tested). Every admin action is in the audit log with actor, target,
  before and after.
- **Admin reset links.** An admin can issue a password reset link for any
  account (`POST /api/admin/users/:id/password-reset`), which is the same
  as taking it over: whoever holds the link sets the password. For plain
  users and the admin's own account the link is shown to the admin (and
  audited as `displayed: true`), so support can hand it over by another
  channel. For another moderator or admin the server refuses that (`403
  forbidden`) and accepts only `send: true`: the link goes to that account's
  own address, the response carries `url: null` and the audit entry
  `displayed: false`, so one admin cannot quietly take over another staff
  account (`apps/server/test/accounts-admin.test.mjs`, "reset links for
  other staff"). Admins remain fully trusted otherwise: they can still
  change another staff account's role or email address, and each of those
  is audited.
- **Injection.** Every SQL statement binds its values; dynamic SQL is built
  only from fixed column names and whitelisted sort keys. Settings documents
  refuse `__proto__`, `constructor` and `prototype` keys. Usernames follow the
  lobby name rules (NFC, no control, bidi or invisible characters), may not
  mix Latin with Cyrillic or Greek letters (homoglyph impersonation), are
  unique after compatibility folding and lower casing, and exclude reserved
  names. Emails are ASCII only. Clients show account text with `textContent`.
- **Online play.** The Worker authenticates the WebSocket upgrade by the
  session cookie and passes its verdict to the session object in a header it
  always sets itself (a client's copy is replaced; the object is reachable
  only through the Worker; a missing or malformed verdict counts as refused).
  Signed-in members play under their username, hold one place per session,
  and rejoin keys only work for the account they were issued to (wrong ones
  count toward the existing per-IP lockout). Lobbies mark account names
  without publishing account ids, and anonymous players (when accounts are
  not required) cannot use a name that is an account's username.
- **Bans.** Account bans (reason, expiry, author) and IP bans for addresses
  and CIDR ranges (IPv4 and IPv6, IPv4-mapped addresses count as IPv4, a bare
  IPv6 address bans its /64, no range wider than /8 or /16, an admin cannot
  ban their own address) are
  checked at sign-in, signup, on every authenticated request, for session
  creation, map uploads, WebSocket hellos and the content relay. A ban signs
  the account out and drops it from running lobbies and games for good
  through the `game_presence` table and the session object's `evict`.
- **Content relay.** Only active accounts with the `content_autoinstall`
  flag (or admins), only while the site setting allows it, on top of the
  relay's existing header, origin and rate limit checks. The same gate
  covers the music relay (`/api/content/ra-scores`). Both relays count
  their main budget per account (completed package downloads, music bytes)
  with a coarser per network ceiling against abuse.
- **Abuse of the API.** Rate limits per IP and per account (section 9 of the
  accounts API), body size caps, strict schemas that refuse unknown fields,
  versioned writes (`If-Match`) for settings documents and site settings.
  D1 writes are the scarce resource (100,000 a day on the Free plan): burst
  limits for the sign-in endpoints go through the Workers Rate Limiting
  binding (no D1 access), D1 counters are read before they are written so a
  refused request costs no write, and an active session costs about one row
  write per 15 minutes. A Cloudflare WAF rate limiting rule for `/api/auth/*`
  (docs/deploy.md) stops floods before they reach the Worker.

**Privacy.** IP addresses are personal data: only the last 20 per account are
kept raw, for admins only, and deleted 90 days after they were last seen;
sessions and rate limits keep only HMACs of addresses under the Worker
secret `IP_HASH_SALT` (without it the Worker refuses to store any, except
for local development), so a stored hash cannot be reversed by hashing the
IPv4 space. The daily retention job
also removes expired sessions, links and challenges, presence rows after a
day, expired IP bans after 90 days, audit entries after 365 days, and
accounts deleted more than 30 days ago (their audit entries keep only that an
action happened). Users export everything stored about them as JSON and can
delete their account. `apps/website/privacy.html` says all of this to players.

**Accepted:** no attestation trust (any authenticator can register);
from a new address the owner may wait up to 15 minutes while someone keeps
failing to guess the password (passkeys, Discord and reset links are not
affected);
usernames in non-Latin scripts can still resemble each other within one
script; moderators see usernames and masked emails of every account; the
first admin needs shell access to wrangler. Email verification is off while
the email binding or its sender is missing (Workers Free plan; see
"Required email and verification").

## Accounts review (2026-10-09)

An independent review of the accounts system found these issues; all
are fixed, and `apps/server/test/accounts-review.test.mjs` replays each
exploit:

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| F1 | Medium | The sign-in lockout was keyed on the login string: anyone could lock a victim's password sign-in for a whole day with 50 requests, and username and email were separate budgets. | The login is resolved to the account first; the short lock is per account and address, the long budget per address, and the account-wide limit is an escalating delay (at most 15 minutes) that addresses the account used before do not see. Success clears the counters. |
| F2 | Medium | Staff routes did not require an active account, status changes kept sessions alive, approve and reject skipped the moderation rules: a deactivated admin could ban the last admin, a pending moderator could approve itself, a moderator could reject a pending admin. | Staff routes need an active account; a status change away from active revokes the sessions; approve and reject follow the moderation rules; the last active, unbanned admin is protected for status changes, demotion, bans and deletion. |
| F3 | Medium | A password change with the current password, and a sign-in that rehashed, derived two keys in one request, more than the Free plan's 10 ms of CPU. | One derivation per request: password changes need a re-authentication instead, hashes are upgraded when the password is set; the default is 40,000 iterations (measured), with the ceiling documented. |
| F4 | Medium-Low | Every rate limit check wrote to D1, even for refused requests, and a failed sign-in wrote three rows: a flood could use up the D1 Free daily write quota and take the site down. | Burst limits through the Workers Rate Limiting binding; D1 counters are read before written (refusals cost no write); session use writes about one row per 15 minutes; a WAF rule is documented. |
| F5 | Low | IP hashes were unsalted by default (reversible by hashing the IPv4 space). | HMAC under the required secret `IP_HASH_SALT`; production refuses to store hashes without it. |
| F6 | Low | Unverified addresses could get reset links and could be squatted while email was unavailable. | Reset links go to verified addresses only; unverified ones claim nothing. (Then addresses were only entered while they could be confirmed and expired after 7 days; since addresses are required, see "Required email and verification".) |
| F7 | Low | The "keep one sign-in method" check was not atomic. | Conditional UPDATE and DELETE statements checked by their change count. |
| F8 | Low | Discord usernames were not passed through the text rules. | Normalized with the lobby text rules, with a fallback. |

Also done: sensitive changes need an explicit re-authentication (signing in
no longer counts), passkey re-authentication needs user verification,
prototype keys are refused in settings documents, bare IPv6 bans cover a
/64, displayed admin reset links are audited, the privacy notice says that
deleted accounts keep their username and email for 30 days, anonymous
lobby names cannot be account usernames, and the content relay's transfer
timer ends with the stream.

## The play gate (2026-10-09)

The game is only for accounts while the site setting `gameRequiresAccount`
is on (the default): the server, not the client, decides who gets the game
files ([accounts API](accounts-api.md), section 7.1,
`apps/server/src/playgate.js`).

**What is gated.** Every request for `/play` and `/play/*`: the game page,
all JavaScript modules (the simulation worker script and the protocol
modules included), CSS, the wasm engine, shaders, images and the map editor.
`wrangler.jsonc` runs the Worker first for these paths, so Workers Static
Assets never answers them on its own; the Worker fetches the file through the
`ASSETS` binding only after the check. Who passes: an active, unbanned
account from an address that is not banned; active admins and moderators
also from a banned address (so a range ban cannot lock staff out of the
game they moderate). Page loads without access are redirected to
`/account/?returnTo=<path>`; the target is built from the request's own path
and only for `/play` paths, so it cannot point anywhere else, and the account
page checks it again (one leading slash, never `//`, never `/api/`). Other
requests get `401` or `403` with a JSON error and nothing of the game.

**The play pass.** Checking the session, the account and the IP ban in D1 for
each of the game's files would cost a D1 read per file and CPU on the Free
plan. After a successful check the Worker sets a pass cookie
(`__Host-webra_play`, HttpOnly, Secure, SameSite=Lax, 10 minutes) with the
account id, the first 16 hex digits of the session id hash, the expiry and a
version, MACed with HMAC-SHA256 under a key derived with HKDF from the
existing secret `IP_HASH_SALT` (its own info label, so neither key reveals
the other, and no new secret is needed). The pass is verified with WebCrypto
(`crypto.subtle.verify`, constant time) without D1, and only together with
the session cookie it was issued for: a copied pass without that cookie, or
next to another account's session, falls back to the D1 check. A pass that
claims to live longer than 11 minutes is refused, so a bug in issuing cannot
create long-lived passes. Without the secret in production the gate answers
`503` (fails closed). The site settings are cached per isolate for 30
seconds for the gate, so anonymous requests do not read D1 each time either.

**Revocation bound.** While a pass is valid it is trusted without D1: a ban,
a status change, a session revoked from another device, a password change
elsewhere and a new IP ban stop game file loads within **10 minutes** at
most. Signing out, revoking the current session and deleting the account
clear the pass at once, and every response that clears a stale session
cookie clears it too. The server does not record revoked passes: a client
that keeps both cookies after signing out (a browser does not) can load
game files for the rest of the pass lifetime, the same bound. Online play, map uploads and every account API call
still check D1 on each request, so the bound only concerns static game
files. A game already running in a browser keeps running (it is in memory);
when a later load is refused, the game offers to sign in again
(`apps/game/js/account/gate.js`). A refusal for another reason (waiting for
approval, banned) and a gate that does not answer (offline, a server error)
get a dialog that says why (`apps/game/js/account/ui.js` `openAccessProblem`),
with "Try again" asking the gate once more; it never stops the running game.

**Path spellings.** `run_worker_first` matches the raw request path, so
`/play` and `/play/*` catch the canonical spelling only. Workers Static
Assets decodes a path before it looks a file up, and answers every
non-canonical spelling (`/%70lay/js/main.js`, `/play%2Fjs/main.js`,
`//play/`, `/pl%61y/`, double encoding) with a `307` to the canonical path,
without a body; that path is gated. Its lookup is case-sensitive (`/PLAY/`
is a 404), and dot segments are resolved before routing, so `/x/../play/`
reaches the gate. No pattern list could name every encoding, so the Worker
does not rely on it: whatever reaches it is matched after decoding
(repeatedly), backslashes as slashes, empty and dot segments resolved,
`;params` and trailing dots ignored and case folded
(`normalizedSegments` in `apps/server/src/playgate.js`), so any spelling of
a game path that reaches the Worker is gated. The end-to-end smoke test
sends 39 spellings (percent-encoded letters and slashes, double encoding,
double slashes, dot segments, case, trailing dots and semicolons,
backslashes, overlong UTF-8, `/play/..%2f`) with GET, HEAD, OPTIONS and
POST, with and without `Range` and as page loads, follows every redirect
without cookies, and checks that none returns a game file. Cloudflare's
edge URL normalization, when on for the zone, only makes more requests
canonical before they arrive.

**Caching.** Gated responses are `Cache-Control: private, max-age=0,
must-revalidate` with `Vary: Cookie`: browsers may keep a copy and revalidate
it through the gate, shared caches and the Cloudflare edge never store them
(Worker responses are not cached unless the Worker uses the Cache API, which
it does not, and nothing in `_headers` sets a public cache policy for
`/play`). Refusals and redirects are `no-store`.

**Headers.** Workers Static Assets applies `_headers` only to files it serves
itself, so the Worker sets the same security headers (CSP, COOP, COEP
`require-corp`, HSTS, nosniff, frame and referrer policies) on every gated
response, served, redirected or refused, plus
`Cross-Origin-Resource-Policy: same-origin`. A test keeps the Worker's copy
(`apps/server/src/static-headers.js`) equal to `apps/website/_headers`.

**What stays public.** The website pages, `/release-notes.json`,
`/version.json`, the API as documented, and `/lib/`: the modules the account
and admin pages load (the account client, the settings registry and the map
editor helpers it uses, the protocol checks, the shared controls
`js/ui/controls.js` and `css/controls.css`), copied there by the build so a
signed-out visitor can sign in. `tools/shared-modules.mjs` computes that list
from the website's script imports, stylesheet imports and page links
(`<link>`, `<script>`, images) and fails the build when any website page,
script or stylesheet loads from `/play` in any spelling; nothing that draws
or runs the game is in it. The one exception is deliberate: the home page
imports the game's sprite module from `/play/` for its unit gallery, and
only after `/api/auth/me` says the visitor may play. The home
page's unit gallery draws with the game's sprite code, so signed-out visitors
see a note instead of the art. The game is GPL software in a public
repository: the gate controls who gets this site's running copy, not the
source code.

## Map versions (2026-10-10)

Map files carry a format version and the release that wrote them, and older
files are upgraded automatically (docs/contracts.md section 2, "Map
versions"). What changed for validation:

- **Upgrades run before every check, never instead of one.** `validateMap`
  (protocol) upgrades a file and then validates the *result* in full; the
  server then runs the engine's own validation on the upgraded canonical
  text, exactly as for any upload. An upgrade cannot carry anything past the
  checks: what is stored, hashed, shared and played is always a fully
  validated current-format map. The engine refuses any other format version
  when it reads the JSON (map files and mission maps), so a map that skipped
  the upgrade cannot reach a game either.
- **Strict version fields.** `formatVersion` must be a whole number from 1 to
  65535 and `gameVersion` 1 to 32 of `0-9 A-Z a-z . + -` (null counts as
  absent), in the protocol package and the engine alike; anything else is an
  invalid map. Unknown fields stay refused (`deny_unknown_fields`); a newer
  format is refused with an "update the game" message before anything else
  of it is read.
- **Bounded, pure migrations.** Migrations are data transforms over the
  parsed file (at most 1 MiB, parsed after the size check): one pass per
  version step, no clock, randomness, network or engine, so the same file
  gives the same map on every client and on the server. A gap in the chain
  is a programming error the tests refuse, never a file's fault.
- **Messages carry no raw input.** The compatibility messages name only the
  format version and the release (`gameVersion`, already restricted to
  version characters). Problem lists and notes name actor ids, rule ids,
  field names and values from the file only through the protocol's
  `excerpt` (at most 40 characters, control and non-ASCII characters
  replaced), and the map editor shows all of it as text nodes.
- **No prototype pollution.** `__proto__`, `constructor` and `prototype`
  are refused anywhere in a map file before any migration runs, as rule ids
  and field names by the validator, and as segments of every key path the
  migrations and quick fixes use; paths only descend own properties and
  values are set as own properties. Quick-fix actions are checked like input
  (kind, paths, actor matches, cells, values) before they apply.
- **Stored maps.** Rows stored before a format change are rewritten only
  through the same `prepareMap` an upload uses. One row can never take the
  map list or the daily job down: a failure other than "not compatible" is
  logged and the row stays as it was for a later try, and the list serves
  the current rows even when the upgrade pass fails. Writes apply only to a
  row that is still stale (no double counting under concurrent upgrades;
  a hash clash is retried once). Aliases (`map_aliases`) map
  an old hash or id to the row that holds the map now; they never widen who
  can read a map: `GET /api/maps/:id` and picking by id still need a listed
  row, unlisted maps are still served only through their sessions. A row
  that cannot be upgraded keeps its text, leaves the community list and is
  refused by lobbies; `GET /api/maps/:id` serves it as stored (clients run
  the same upgrade and show why, the map editor opens it for repair).
- **Saves and replays** keep their map as played and are validated without
  upgrades (`upgrade: false`), so a saved game cannot be resumed on a
  different map than the one its hashes were recorded with.

## Map sharing and rematches (2026-10-09)

Protocol 6 lets a host share its own map files (map editor maps, `.oramap`
imports, maps from earlier lobbies) with an online lobby, and lets a finished
game go back to its lobby for a rematch.

- **Who can see a shared map: the least public option that works.** A map
  the host shares is stored *unlisted* in D1 (`maps.listed = 0`): it is not
  in the community list, `GET /api/maps/<id>` answers 404 for it, and the
  `map` lobby message cannot pick it by id (only published maps can be
  picked by id). The only way to read it is
  `GET /api/sessions/<id>/map?hash=` of a session whose lobby or running
  game uses it, by a member of that session. So a shared map reaches exactly
  the players and spectators of the lobbies its host shared it with, who need
  it to play. The public session list names a shared map but carries neither
  its id, hash nor author. Publishing stays a separate, explicit step (the
  map editor's Publish, `POST /api/maps`), which lists the map for good.
- **Member credential.** Both session map endpoints take
  `X-WebRA-Member: <client>.<rejoin key>`, the 32-byte key every member gets
  in `welcome.key`. The session object compares it against the stored
  SHA-256 in constant time (an unknown client still costs a hash), requires
  the account it was issued to (from the Worker's verdict, as for the
  WebSocket; a stolen key is useless from another account), counts wrong
  keys toward the per-IP lockout (5 failures, 60 s), and requires the member
  to be in the lobby or the running game now: a member who left, was
  removed or kicked has no key any more. The key travels in a header, never
  in the URL, and same-origin rules apply (the custom header forces a CORS
  preflight that cross-origin pages cannot pass). Sharing also needs the
  host role, checked again after the database write.
- **Same gates as uploads.** Sharing goes through the account gate (with
  `onlineRequiresAccount`, an active unbanned account; IP bans always), the
  upload quota (10 per hour per network, shared with public uploads), the
  1 MiB limit, the protocol package and the engine (in the Worker) before
  anything is stored. Downloads have their own quota (120 per hour per
  network) and are sent with `Cache-Control: private, no-store`.
- **Hash pinning.** A lobby announces the map's hash (and name, author,
  players, size and file bytes, looked up by the server, never taken from the
  host); downloads name that hash and the server refuses a different one
  (409). Every client parses the map with the protocol package, checks it
  with its own engine, compares both hashes with the lobby's, recomputes the
  modded flag from the content and shows the modded warning before
  installing; a map that fails any check is not installed. Ready and the
  game start need every player and spectator to have reported that exact
  hash installed (ready itself carries the hash, as before).
- **No new content sinks.** Map names and authors are shown with
  `textContent` only (a test renders markup names and finds no elements);
  the server validates them as display text (no control or bidi characters).
  No URLs are taken from anyone: clients only ever call the fixed session
  endpoints.
- **Retention and accounts.** Unlisted maps no session used for 30 days are
  deleted by the daily job (`used_at` moves on every share and download).
  A map is stored once per content: a later sharer of the same map reuses
  the row, which keeps its first signed-in sharer as uploader (an anonymous
  sharer leaves none, and a later signed-in one is recorded). Purging an
  account deletes the maps it shared that no session used for a day (its own
  sessions ended long before a purge, so a map in use was shared by someone
  else too); a map still in use stays without the uploader and goes with the
  30 day retention. Its published maps stay, without the uploader. The data
  export lists both kinds.
- **Rematch.** Only the host proposes; every player still in the game must
  accept (one decline, the host leaving or 2 minutes end it, then 10 s
  before the next proposal), so a host cannot end a game others are playing.
  Spectators do not vote. Back in the lobby, the members of the finished
  game come back with their existing rejoin keys within 60 s
  (`hello` with `rejoin`, the same constant-time, account-bound check and
  lockout as a game rejoin). It works only for a member that is returning
  and only until its deadline (a newer connection replaces an older one, so a
  second reload during the return keeps the place); after the deadline a
  connected member simply stays and one that is not connected loses its
  place. Places of players who did not accept open at once (their keys are
  forgotten). The order log is deleted from storage.

## Online saves (2026-10-09)

Players can save a running online game and resume it later with the same
players (docs/contracts.md section 4, "Online saves").

- **What the server keeps.** Only what a resume is checked against: the save
  point, the state hash every player reported there, SHA-256 digests of the
  order frames and of the options, the map hash, the game version, the
  session name and the account id of each seat (`online_saves`,
  `online_save_members` in D1). The save file itself (options, map and every
  order) stays in the players' browsers. Records are deleted after 90 days,
  beyond 20 per account, and with an account that played in them when it is
  purged (a save cannot be resumed without all of its players); the data
  export lists them.
- **Agreement.** Every player still in the game must accept and be connected,
  and every human seat must be a signed-in account; spectators do not vote.
  The record is written only when every player's state hash at the save
  point matches, so a client cannot get a state of its own stored. The
  frames digest comes from the server's own order log, not from any client.
- **Resume checks.** Only a signed-in account that played in the save can
  load it, as the host of the session (member key, constant time and bound to
  the account, as for the map endpoints), within 10 resumes per hour per
  network. The host role is checked before the body is read, and the body is
  limited to the order log limit plus a map plus 256 KiB (Content-Length
  checked first); the orders are counted against the order log limit while
  they are validated, before any digest. The file is validated strictly (`parseReplay`) and must
  match the record exactly (save point, state hash, game version, map hash,
  options digest, frames digest), so a player cannot resume with edited
  orders, options or map. Its orders must fit the order log limit. Only the
  accounts that played a seat can take it again; anybody else may only watch
  (within the spectator places, with the session's password rules), as in any
  game. The map is checked like an upload and shared with the session only.
- **Fair restart.** Every client fast-forwards through the same orders and
  compares its state hash with the saved one before it may continue; the
  relay starts only when every player caught up, so nobody gets a head start.
  Orders and hashes sent before that are refused. A player who does not catch
  up holds the start at most 60 s plus 1 ms per saved tick, never more than 3
  minutes, not the 15 minutes a rejoin may take: then the game starts without
  it and its seat waits 2 minutes for a rejoin, like after a lost connection
  (the client reconnects by itself and goes on catching up).
- **Orders budget.** The order log and the resume check count a frame the
  same way (protocol `logEntryBytes`), so every game the server recorded as
  saved fits the budget when it is resumed.
- **Server memory.** The frames digest is chained frame by frame, so the
  session computes it while reading its order log one chunk at a time, and a
  resumed start writes each log chunk before reading the next.

## Mission scripts and co-op missions (2026-10-10)

The campaign runs OpenRA's Lua mission scripts inside the simulation
(engine/src/lua, engine/src/mission; docs/contracts.md section 9).

- **Where Lua comes from.** Only the game's own mission files
  (`apps/game/missions/<id>.json`, generated from the vendored OpenRA files
  and served with the game) carry scripts. Every load checks the file's
  SHA-256: against `index.json` (the campaign screen), against the hash a
  save or replay names, and online against `COOP_MISSIONS` (the protocol
  package, the same on game and server). Saves, replays and the online
  protocol name a mission by id and hash only; no client ever sends a script
  or a mission file to another, and the server never receives one.
- **Player maps cannot carry scripts.** Uploaded, shared and imported maps
  are map files (`.webra-map.json`): the format has no field for scripts and
  the engine's parser refuses unknown fields (`MapData`,
  `deny_unknown_fields`), so the validator the server runs
  (`Game.validate_map` in apps/server/src/engine.js) and the game refuse a
  map with `scripts`, `lua` or `mission` (tests:
  `player_maps_cannot_carry_scripts` in engine/src/tests_mission.rs, "maps
  cannot carry scripts" in apps/server/test/engine.test.mjs). A map's
  `rules` overrides only reach `Rules::load_with`, never the interpreter. The
  `.oramap` importer never runs the Lua files of a package and says so in
  its report. A world built from a map has no mission and no interpreter.
- **Limits that hold anyway.** Every script run (loading, each callback, the
  per-tick `Tick`) gets an instruction budget (50 million while loading, 20
  million per tick), calls nest at most 120 deep, the parser at most 200,
  strings are capped at 1 MiB and the heap at 3 million slots; running out
  is an error no `pcall` can catch, and it only stops the mission's scripts
  (test: `a_script_that_never_ends_is_stopped`). Native recursion (nested
  expressions, blocks, calls and host round trips like `Utils.Do`) is
  counted in stack levels sized from measured frame costs, so a script hits
  "stack overflow" well before the WebAssembly stack does. The wasm32 build
  itself is measured in CI (`npm run test:luastack`: the deepest run takes
  under 140 KiB of its 1 MiB stack and under 160 KiB of the JS engine's
  stack, checked at 300 KiB), the native builds by `native_stack_per_level`,
  `deep_recursion_fits_in_a_small_stack` and
  `host_round_trips_fit_the_native_stack` on a 1 MiB thread. Integer arguments
  are checked or saturated (`string.rep`, `unpack`, `select`, positions,
  delays; `huge_integers_never_overflow`, `script_positions_never_overflow`
  with 2^62 and +-1e300), and `string.byte` results cost budget.
  (Review 2026-10-10: these were the medium findings; none was reachable
  from a player, since only the game's own mission files run Lua.) The sandbox has OpenRA's
  globals only: no io, os, debug, load, require, string.dump or coroutines,
  so a script reaches nothing outside the simulation. The interpreter has no
  `unsafe` code. Mission files are at most 4 MiB.
- **Co-op online.** The host picks a mission from `COOP_MISSIONS` by id and
  hash; the server refuses any other, keeps orders within the mission's
  actor types and turns cheats off. Each client runs the scripts with its
  own local player; the state hash of a co-op game leaves the interpreter
  state out (presentation differs per client, as in OpenRA, whose sync hash
  never covers Lua) and covers everything the scripts did to the game, so a
  client whose scripts misbehave still shows up as a desync. A generator
  lint (`tools/gen_missions.py`, tested in `tools/gen-missions.test.mjs`)
  refuses code under `IsLocalPlayer` that does more than presentation, and
  the co-op test plays each co-op mission to its end on both seats. The
  directory lists a co-op lobby only under a mission this version knows.
- **Movies** from the player's own content are decoded in the browser
  (js/content/vqa.js) with every size, chunk and decompression bound
  checked; a sound track may not run longer than the pictures (plus two
  seconds, at most 6 minutes), so a small file cannot make the decoder
  allocate a huge one; a broken file throws and the card shows instead. Videos are never
  bundled or uploaded.

## Error reports (2026-10-10)

The game, the map editor, the website and the Worker can report errors to
WebRA's self-hosted Sentry at `sentry.vitrion.dev` (one project; its DSN is a
public client key). Reporting is opt-in for the operator: no DSN is built in,
and only a deploy with the repository variable `SENTRY_DSN` set reports
anything (docs/deploy.md, "Error reports"). Without it the browser never
loads the SDK, the Worker's wrapper does nothing, and the build writes the
privacy notice's "Error reporting is currently off" section instead of the
description below (`privacySections`, tools/sentry-config.mjs).

- **What is sent.** Errors nothing caught (`window` error and
  `unhandledrejection`, the Worker's handlers), errors the code reports on
  purpose (engine panics and traps, a simulation worker that stopped, a 5xx
  the Worker answers, failed background writes, failed cron runs), online
  desyncs (`Lockstep desync`, with the newest state hashes), and a sampled
  share (`SENTRY_TRACES_SAMPLE_RATE`, default 5%) of page loads and Worker
  requests as performance traces. Each report has the release
  (`webra@<version>+<commit>`), the environment, tags (`surface`: game,
  website or worker; `mode`: menu, editor, skirmish, mission, online, replay,
  stress; `renderer`: webgpu or unavailable; `original_content`: on or off;
  `protocol`) and, for engine errors, the `engine` context: engine version,
  mode, tick and the newest state hashes (checksums, no game content).
  Browser reports keep the User-Agent (browser and GPU stack bugs need it);
  the Worker's keep none.
- **What is never sent.** Users (no id, name or email; no hashed id either:
  errors are not tied to accounts), network addresses (both SDKs tell
  Sentry not to infer them, `infer_ip: never`, and the project must have
  "Prevent Storing of IP Addresses" on), cookies, request headers and
  bodies (Authorization, `X-WebRA-Member`, `X-WebRA-Auth`, passwords, map
  uploads), query strings and fragments (rejoin keys, invite links, OAuth
  codes), local variables, session replays and sessions. Both SDKs run with
  every `dataCollection` category off (in @sentry 11 it replaced
  `sendDefaultPii`), and every event, transaction and breadcrumb passes
  `packages/protocol/src/scrub.js` before it leaves: URLs lose user info,
  query values (the names stay) and fragments,
  path segments that look like tokens or ids; text loses URLs' secrets, email
  addresses and long tokens; keys that name secrets (`password`, `token`,
  `key`, `session`, `member`, `rejoin`, `cookie`, `auth`) are dropped;
  console breadcrumbs are kept for warnings and errors only, without their
  arguments, and click breadcrumbs lose the values
  of their attributes; traces lose header, user agent, address, query and body
  attributes and the time zone. Traces are sent as transactions
  (`traceLifecycle: 'static'`), so they pass the same scrubber (the SDK's
  default streams spans past `beforeSendTransaction`). Spans that the SDK
  sends on their own bypass every `beforeSend*` hook, so: the browser traces
  only page loads and navigations (LCP and CLS ride on the page load
  transaction); INP, which is such a span named after the element clicked
  (whose title or label can hold a player's name), long tasks and request
  spans are off; `beforeSendSpan` scrubs every span; and the browser's
  transport sends nothing while reports are switched off, whatever produced
  the envelope. Neither SDK adds `sentry-trace` or `baggage` headers to any
  request (`tracePropagationTargets: []`): not to the API, not to Discord,
  the content mirrors or archive.org.
- **Players' text.** Chat, player, lobby and map names cannot be recognized
  by their shape, so the client remembers the text it receives and sends
  (`noteUserText`: WebSocket messages and API answers in `js/net.js`,
  `js/account/api.js` and the website's fetches, map files the lobby
  checks, the player's own lobby name) and replaces it with `[redacted]`
  wherever it shows up in a report. Residual risk: text that reaches an error
  message without passing those points (none is known) would only lose its
  URLs, email addresses and tokens.
- **Consent.** Once the operator has turned reporting on, reports are on by
  default and the player switches them off in
  the game's Settings (Privacy) or on the privacy page; it is the settings
  registry's `privacy.errorReports`, synced with the account. It is read
  from localStorage before anything loads: switched off, the SDK is never
  loaded. Switching it off later (this tab, another tab, an account sync)
  drops every event, transaction and breadcrumb from then on and the
  transport sends nothing; switching it on loads the SDK. The game menu's
  Defaults button never switches it back on. The switch covers what this
  browser sends: the Worker reports its own errors whatever it says, also of
  a player's request that failed, with none of the player's data (above).
- **Loading and CSP.** With a DSN, the SDK is bundled by `tools/build-dist.mjs` into
  `/play/vendor/sentry.js` and `/lib/vendor/sentry.js` (only what WebRA uses:
  no replay or feedback code) and loaded from the site's own origin: the CSP
  keeps `script-src 'self'`. Only `connect-src` gained
  `https://sentry.vitrion.dev`; the build stops when the DSN's host is not
  in it. Reports are CORS requests, which COEP `require-corp` does not block.
- **Worker.** `@sentry/cloudflare` wraps `fetch`, `scheduled` and the
  `Session` Durable Object (fetch, alarms, WebSocket handlers, RPC methods)
  only when `SENTRY_DSN` is set; it is empty in `wrangler.jsonc`, so
  `wrangler dev` and the tests send nothing, and the deploy workflow sets it.
  The SDK needs `AsyncLocalStorage` (compatibility flag `nodejs_als`).
- **Engine panics.** The wasm32 engine aborts on a panic; a panic hook
  (`engine/src/panic_report.rs`) keeps its message, source location (a path
  in the repository) and the running tick for the JavaScript side. The tick
  it notes is presentation only and never enters the simulation or
  `state_hash`. The native `sentry` crate is not used: it needs threads and
  a native HTTP transport, which `wasm32-unknown-unknown` lacks in the
  browser and the Worker, and the native tools (the examples such as
  `ai_vs_ai`, `shader-check`) run in CI and on developers' machines, where a
  panic already fails the run with its message on stderr.
- **Abuse.** The DSN is public by design: anyone can send made-up events to
  the project. That costs Sentry quota and noise, never data: the project
  holds nothing but these reports. Rate limits of the Sentry server apply.
- **The Sentry server.** It sees each report's connection like any web
  server. Required project settings (docs/deploy.md): "Prevent Storing of
  IP Addresses" and 90 days of retention; recommended: the default data
  scrubbers.
  `apps/website/privacy.html` says all of this to players.

## Required email and verification (2026-10-11)

Every new account gives an email address (password, passkey and Discord
signup; Discord's own address counts when Discord reports it verified).
Verification mail goes through Cloudflare Email Service (the `send_email`
binding, added by the deploy only when the sender `EMAIL_FROM` is set,
docs/deploy.md); without it addresses are kept unverified and nothing is
sent. `apps/server/test/accounts-email.test.mjs` and
`apps/server/test/e2e/email.mjs` cover what follows.

- **Squatting and takeover.** An unverified address claims nothing (only a
  verified one is unique, signs in or gets reset links), so typing someone
  else's address blocks nobody; the first account to follow its link keeps
  it and any later verification answers `409`.
- **Enumeration.** No answer says whether an address has an account: signup
  never refuses an address, an address change or resend is answered the same
  way, `pendingEmail` shows the requested address either way, and the mail
  (the link, or a notice without a link to an address another account
  verified) is prepared after the answer (`waitUntil`), so neither the
  answer nor its timing depends on it. "Forgot password" was already
  generic. Discord signup still says `email_taken` for a Discord-verified
  address, which only the owner of that inbox can trigger. The per-address
  mail limit is the one remaining signal: it shows that someone asked for
  mail to an address recently, not that it has an account.
- **Tokens.** 32 random bytes (base64url), stored as SHA-256 only, looked up
  by that hash and compared again in constant time, single use (deleted on
  the first attempt), 24 hours, bound to the account and the exact address
  (a link for an address the account no longer has does nothing), and every
  new link replaces the account's older verification and change links.
  They travel in the URL fragment of a link to the account page of the
  configured site origin (there is no redirect parameter, so no open
  redirect). The verify endpoint is burst
  limited per IP like the reset endpoint.
- **Mail bombing and cost.** Each mailbox gets at most 3 mails an hour and 6
  a day, whoever asks (signups, changes and resends together; admin resends
  excepted, 10 a day per account). A mailbox is the address in lower case
  without its `+suffix`, and for Gmail (gmail.com and googlemail.com, one
  provider) without dots, so `victim+1@gmail.com` and `v.ictim@googlemail.com`
  share the victim's budget (this key is only for limits; uniqueness keeps
  the plain address). Resends are limited per account (3 an hour, 10 a day)
  and per network (10 an hour per IPv4 address or IPv6 /64), changes per
  account and network, signups (password, passkey and Discord together) per
  network, so rotating addresses inside one IPv6 /64 does not help. All
  account mail together stops at `EMAIL_DAILY_LIMIT` per UTC day (default
  300): after that nothing is sent until the next day, requesters get the
  same answers as always (the check runs after the answer), and the admin
  dashboard shows the count and a warning. The limits are D1 counters keyed
  with HMAC under `IP_HASH_SALT`. Email Service's own daily quota is a
  further backstop: when it refuses, the error code is logged (never the
  address) and the request is unaffected.
- **Content.** Plain text plus simple HTML, no images or tracking, one link.
  Text players choose is limited to the username (letters and digits, 24
  characters) in the verification link mail and escaped in HTML; the in-use
  notice carries nothing the requester typed. The sender is fixed by the
  owner (`EMAIL_FROM`), and the binding may send only from it
  (`allowed_sender_addresses`). SPF, DKIM and DMARC records come from
  onboarding the sending domain (docs/deploy.md).
- **Unconfirmed signups.** A `pending_email` account cannot play or upload.
  If a plain user's signup has waited in `pending_email` since it was made
  and its address is not confirmed within 7 days (while links can be sent:
  email configured and `login.email` on), it is deleted and its address
  cleared, so an address typed by someone else does not stay stored. Staff,
  and any account that ever left `pending_email` (verified, approved,
  restored, or set back to it by an admin), never expire, so an admin action
  can never schedule an old account for deletion.
- **Deleted accounts** keep their username for 30 days but claim neither
  their address nor their Discord account, so a self-deleted, rejected,
  deleted or expired account never locks its owner (or the address's owner)
  out of a new signup; a restore claims them again only when nobody else did
  meanwhile and reports what it had to drop.
- **Races.** Verifying writes only while the account still has the address,
  verified state and status the link was checked against, so a link
  followed while the address changes cannot bring the old address back.
- **Link hosts.** Links point at the configured `SITE_ORIGIN`, never at the
  host a request reached; the Worker has no workers.dev address and no
  preview URLs (`workers_dev` and `preview_urls` off). Unverified addresses on other accounts (created while
  sending was unavailable or verification was switched off) stay until the
  owner changes them; they are only ever sent the links their account asks
  for. Existing accounts never move to `pending_email` and accounts without
  an address keep working.
- **Admins** see the verification state, can resend a link (and are told
  when the in-use notice went out instead) and can mark an address verified
  (both audited); a mark that would take another account's verified address
  is refused.
- **Development outbox.** `WEBRA_DEV_MAIL` routes mail to memory only with
  `WEBRA_DEV_ROUTES`, plain HTTP and a local host (like the promote route);
  neither variable is ever configured for deploys.

**Accepted:** an attacker who knows a victim's address can spend that
address's mail budget for an hour (the victim's own account then gets no new
link until the next hour; earlier links stay valid); a verification link
opened while signed in to another account verifies the account it was made
for.

## Replays in accounts (2026-10-14)

The game keeps the replay of every game a signed-in player finishes or
leaves in the player's account (docs/accounts-api.md 5.10). The setting
"Save replays to my account" (`privacy.cloudReplays`) is on by default and
syncs with the account; the privacy notice (`apps/website/privacy.html`,
"Replays in your account") says what is kept.

- **What is stored.** The replay file as the player's client recorded it:
  the game options (every player's name, faction, colour and team), the map,
  every order and, for online games, the chat lines the player received
  (names and text of other players and spectators, team chat of the
  player's own team). The file is a gzip object in the R2 bucket `REPLAYS`
  under `replays/<user id>/<random id>`; D1 (`account_replays`) holds the
  list entry: upload and expiry time, sizes, SHA-256, game version, mode,
  title, map name, the players' names, factions and teams, when the game was
  played, its length and the result the uploader's client reported. Other
  players are not asked: it is the uploader's own view of a game they took
  part in, which their browser could already download as a file.
- **Who can access.** Only the account that uploaded it: every route reads
  the row by id and the caller's user id together and answers an unknown,
  expired or foreign id the same `404`, so ids are never confirmed. There is
  no admin or public route to replays, and players of the same game cannot
  see each other's copies. Downloads carry `Cache-Control: private,
  no-store` and the API's `nosniff` and same-origin resource policy; the
  JSON is served as a download, never rendered. Reads need the CSRF header,
  writes the full CSRF rules (Origin, Fetch Metadata, header), like every
  account route.
- **Memory.** The Worker hashes and compresses the uploaded bytes as they
  came, drops the text once it is parsed and the parsed replay once it is
  summarized, so a 16 MiB upload holds the bytes plus one transient copy.
  `createdAt` must be a time the Date range holds (protocol
  `REPLAY_TIME_MAX`), so formatting it never throws.
- **Validation and limits.** An upload needs an active account (not banned,
  not pending), 60 uploads per hour per account (counted before the body is
  read), `Content-Type: application/json` and at most 16 MiB
  (Content-Length checked first, then while reading). The file goes through
  the protocol's `parseReplay` (size, schema, orders, options, map hash)
  before anything is stored, saves are refused, and only validated values
  reach the list entry. Per account at most 100 replays and 100 MiB of
  stored objects: the oldest are deleted in the same D1 batch that adds a
  new one, so the limits hold under concurrent uploads, and one file is
  stored once per account (a unique index on the SHA-256).
- **Retention and deletion.** A replay is deleted 30 days after its upload
  (daily job), by its owner, by the limits, and when the account is deleted
  (self-deletion, admin deletion, rejection and expired signups delete the
  replays at once, not after the 30 days the rest of a deleted account
  waits; the purge deletes any left). The R2 object of every removed row is
  queued by a trigger (`replay_object_trash`) and deleted right after the
  change and again by the daily job until R2 confirms, so a failed delete
  never leaves a file behind for more than a day. An upload that fails after
  writing its object leaves it queued and it is deleted within the hour.
- **Client.** Uploads run in the background after the game ended or while
  the player leaves (the replay is queued in IndexedDB first, at most 3 s,
  so leaving never hangs), only for the account that played the game, and
  never while the setting is off; switching it off drops the replays still
  waiting, and so does signing out (a session that ends by itself keeps
  them for that account's next sign-in, at most 7 days). A sign-in or
  refusal answer for one account never stops another account's uploads. Server text in the lists goes in with `textContent`. A replay
  watched from the account is checked like a file (`parseReplay`, engine
  version) before the viewer runs it.
- **Infrastructure.** The bucket is private (no public access, no custom
  domain); only the Worker binding reads or writes it. The deploy creates it
  when missing (docs/deploy.md); the deploy token needs Workers R2 Storage
  Edit for that.

## Protocol 8: start gate, network quality, invite codes, friends (2026-10-15)

Threat model for the server round of 0.17.0 (docs/contracts.md section 4,
docs/accounts-api.md 5.11).

### Start gate and network quality

- **Start gate.** `loaded` only lets frames go out; it carries nothing. A
  player who never sends it holds the game at its start for at most
  LOAD_TIMEOUT_MS (60 s), then is dropped like a staller (and can rejoin).
  The start wait never counts toward anyone's stall budget, so a slow
  loader cannot get an honest player dropped, and the gate cannot be used to
  hold a running game: it ends for good once every seat loaded or left.
- **Pings.** A ping is answered only to its sender; `n` and `at` are echoed
  as validated integers. The measurement a client reports (rtt, jitter,
  late) is its own claim and is only shown, never acted on: no rule drops or
  favours a player by it. A client can lie about its own numbers (look
  worse or better in the lobby); it cannot change anyone else's. Pings have
  their own budget (2 per second, bursts of 6) inside the connection's
  message rate limit; refused pings get no answer and a flood closes the
  connection. `netstat` goes out at most every 2 s whatever the ping rate,
  so pings cannot amplify traffic to the room.
- **Waiting and stall log.** `waiting` and `stalls` come from the server's
  own lockstep bookkeeping (when frames went out and orders came in), never
  from client reports; the stall log is bounded (500 entries) and asked for
  at most every 5 s per connection. It reveals nothing a player of the game
  could not see (who held the game up), and spectators of a public game
  already watch it.
- **Cost.** Pings keep a session object awake while members are connected
  (also in the lobby); a session holds at most 24 sockets, so the cost per
  lobby is bounded.

### Invite codes

- **Guessing.** A code is 6 characters of 31 (887,503,681 codes); only open
  lobbies have one (at most 2 hours, replaced or ended at the start). Lookups
  are limited per address (20 per minute) and failed ones per network (30
  per hour, then every lookup waits out the hour), so finding a live code by
  guessing is hopeless. Codes are drawn with `crypto.getRandomValues` and
  rejection sampling (uniform), and the D1 primary key makes collisions
  impossible (a clash draws again). An ended code answers 410 for a day so
  players learn it was replaced; then the row goes.
- **What a code gives.** Only a short name for the session: the lookup
  answers what the join dialog shows (name, host, map, occupancy, mode,
  whether a password is needed) and the session id, which the long link
  already carried. A password lobby still needs its password (checked by the
  session object with its per-address lockout); a code never skips it.
- **Who can make one.** Only the host, proven by its member credential (the
  rejoin key, checked in constant time and bound to its account, failures
  counting toward the per-address lockout); 30 issued codes per network per
  hour (a refused request, such as a member who is not the host, costs no
  quota, so it cannot use up a shared network's codes).
  Every member sees the code (`lobby.invite`): anyone in a lobby could share
  the long link before anyway.
- **Private lobbies.** A private session now has an unlisted directory row
  (for codes and friends). The list (`public = 1`) never shows it.
- **/join/<code>.** The Worker only redirects a well-formed code to
  `/play/?invite=<code>` (the game itself stays behind the play gate);
  anything else gets the 404 page. No user input reaches a header except the
  validated code.

### Friends and presence

- **Enumeration.** Friends are addressed by username, which every lobby,
  chat line and replay already shows; a request for a name that is not an
  active account says so (the player needs to know about a typo). Account
  ids, emails and roles never appear. Requests are limited to 20 per hour
  per account and 50 open ones, so the endpoint is no faster a username
  oracle than signup is.
- **Blocking cannot be detected.** A request to a player who blocked the
  sender is answered like any other and shows as waiting to the sender; it
  is stored hidden from the receiver, and cannot be accepted by name while
  the block stands. Ignoring a request works the same way.
  A blocked player trying to join a session gets "You cannot join this
  session." without being told who blocked it, and an invite code lookup
  answers it like an unknown code (without counting as a failed lookup, so a
  blocked player cannot lock its network out of invite codes).
- **Blocking applies everywhere.** No requests or friend invites either way
  (a block ends any friendship, request and invite between the two), no
  joining a session (lobby or running game, also as a spectator) one of
  whose present members blocked the player, no looking such a lobby's code
  up. A failed block check at join lets the player in (logged): blocking is
  a social tool; access control (passwords, bans) does not depend on it.
- **Presence privacy.** What friends see is decided on the server from the
  friend's stored settings (`social.showOnline`, `social.friendsJoin`,
  `social.allowSpectate`), with defaults that show status but keep games
  closed to watchers. With `showOnline` off a player is "offline" without a
  last-seen time, and nothing about its sessions is shown; last-seen times
  are rounded to the hour. A private session is named to a friend only when
  that friend allows joining (lobby) or watching (game). Only friends (a
  mutual, accepted relation) see any of it; strangers see nothing. The
  online counter (`/api/online`) is a number only.
- **Heartbeat cost.** The presence heartbeat is stored at most every 45 s
  per account, and a change of `away` at most every 5 s after the last
  write, so flipping the flag cannot turn it into many D1 writes. Both the
  heartbeat and the friends list (read-only, polled every 30 s, or every 5
  minutes while realtime hints arrive) have a
  burst limit per address (20 a minute with the rate limit binding).
- **Authorization.** Every friends route needs a signed-in, active account
  and only acts on rows of the caller (the SQL always names the caller's
  id); invites need friendship and the caller's own membership of the
  session (D1 `game_presence`) and carry the lobby's real code. CSRF rules
  as for every account route (header on reads, Origin and Fetch Metadata on
  writes).
- **Deletion and retention.** Deleting an account removes its friends rows
  at once (others see it vanish); the daily job removes rows of accounts
  deleted in other ways, requests after 30 days, ended invites and stale
  heartbeats; the purge removes the rest (foreign keys). The data export
  lists friends, requests, blocks, invites and the heartbeat.
- **Realtime hints leak nothing.** The realtime channel
  (docs/accounts-api.md 5.12) carries hints, not data: a topic, a kind and
  at most the other player's username (public already; never for presence,
  whose hints carry nothing), a session id for an invite, a settings
  version, a replay id or, on the admin topic, an account id. Changes only
  admins may see (settings documents and guide progress) reach only admins'
  dashboards, not moderators'. No private field leaves the hub; the receiving page loads its list
  through the same route and rules as before. A hidden request, an ignore,
  the withdrawal of an ignored or hidden request, and a block of a player
  who was no friend publish **nothing** to the other player (the timing of a
  hint cannot reveal them); blocking a friend reads as a removal. Tests
  assert both the hints and their absence
  (apps/server/test/accounts-realtime.test.mjs).

### Realtime channel

- **Who connects.** The Worker authenticates the upgrade (session cookie,
  same `Origin` required, not banned or deleted, IP bans apply) and passes
  its verdict to the `UserHub` Durable Object in `X-WebRA-Auth`, replacing
  any client copy; the cookie is not forwarded. One object per account, one
  for the admin dashboard (moderators and admins only). Topics follow the
  account state: a pending account hears only about itself.
- **Ended sign-ins close sockets.** Sign-out, a new sign-in replacing the
  browser's session, revocation (one, all others, by an admin), password
  change or reset, deletion, rejection, bans, role changes and deactivation
  close the affected sockets with 4001, also while the feature is switched
  off. The worst case of a missed close is a hint whose reload answers 401.
- **Accepted: expiry and IP bans.** A sign-in session that expires (idle or
  absolute lifetime) and an IP ban (which ends no sign-in) close no socket:
  such a socket keeps hearing hints of its own account, which carry no
  private data, and every reload they cause is refused (401 or 403).
- **Cost and abuse.** Connects are burst limited per address, 16 sockets per
  object; the client sends only a ping (answered by the runtime without
  waking the object); anything else is limited to 10 a minute per socket,
  counted in the socket's attachment, then closed (1008). The hub keeps no
  state besides an event counter, writes nothing for accounts without open
  pages, and has no timers. Hints follow writes that are rate limited
  already; presence hints go out only on a change of state.
- **Failure isolation.** Publishing runs after the answer (or in try/catch
  in the session object) and is logged when it fails; a missing binding
  makes it a no-op and the upgrade routes 503. The site setting `realtime`
  switches hints and new connections off at once.
- **Migrations.** 0009 and 0010 only add tables and one nullable column
  (`sessions.summary_json`); nothing existing is rewritten, so applying them
  to the production database is safe and old Workers keep working with the
  new schema.

## Inherent to lockstep

- **Map hack:** every client holds the whole simulation; fog of war is a
  client-side view. A modified client can reveal the map. Preventing this
  needs a server-authoritative simulation, which this design avoids. The wire
  carries only orders.
- **Placement preview (like OpenRA):** structure placement checks the true
  world state, as OpenRA's World.IsCellBuildable does, so the footprint
  preview of an unmodified client shows a cell blocked when an enemy unit,
  structure, cloaked unit, hidden mine, husk, crate or ore lies there under
  the shroud or fog. A player can probe hidden cells near the base with it.
  This matches OpenRA's rules by choice (docs/contracts.md, production
  queues).
- **Long production queues:** a queue holds up to 999 items of each actor
  type (OpenRA ItemLimit) and, unlike OpenRA (QueueLimit 0), at most 2000 in
  all (`QUEUE_CAP`, also under the "all tech" cheat), since every client
  simulates every player's queues. Only the head of a queue is built; a
  count cancel and the per tick scan for items that became unbuildable each
  take one pass over the queue (no per item shifting of the rest), so a
  player spamming `start_production` and `cancel_production` (at most 50
  items per order, 32 orders per tick) costs every peer a few linear scans
  of at most 2000 items per order (docs/contracts.md, production queues).
- **Shared fate:** an input that crashes one engine crashes all, which is why
  validation happens at the engine boundary (not only in the protocol) and is
  fuzz tested.

## What protects a game

- Orders are stamped with the sender's seat by the server and again by the
  engine (`apply_frame`); the engine re-checks unit ownership.
- Host privileges need a high-entropy host key, stored hashed; passwords are
  salted PBKDF2 with per-IP lockout; comparisons are constant time.
- Online play needs an active, unbanned account (site setting, on by
  default); the session object learns who connects only from the Worker.
- Maps are identified by the SHA-256 of their canonical JSON, validated by the
  protocol package and by the engine itself (WebAssembly inside the Worker)
  before they are stored, and re-checked by every client after download. The
  MODDED flag is recomputed from content everywhere, never trusted from the
  wire, and players must accept the modded-map warning before installing.
  Maps shared in a lobby reach only that session's members (see "Map
  sharing and rematches").
- Rate limits per connection and per IP (`CF-Connecting-IP`), message size
  limits, strict message schemas, no `innerHTML` sinks for user text.
- Rejoin keys are high-entropy tokens stored as SHA-256 and compared in
  constant time, like the host key; spectators can never send orders.

## Reporting

Please report security issues privately to the repository owner rather than in
public issues.
