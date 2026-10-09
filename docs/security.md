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
  key only works for its own client id, only while the game runs (and, since
  protocol 6, once to come back into the lobby after a rematch), at most 10
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
  and `Sec-Fetch-Site` checks), 3 downloads per hour per IP through the D1
  quota table (IP stored only as a salted hash, never logged), exactly
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
  request whose upstream fails before anything streams (502) gives its
  bytes back to the account's daily budget (`refundQuota`, never below
  zero; the IP request still counts), and the game retries a 502 at most
  once per click. The answer must be `206` with `Content-Range` of
  exactly the asked window and the pinned image size (a changed or other
  image is refused) and is streamed through cut to the asked length. Only
  `GET`, the game page (`X-WebRA-Content`, Origin, `Sec-Fetch-Site`), the
  same account gate as the package relay (active, `content_autoinstall` or
  admin, `contentRelay` on, address not banned). Budgets in the D1 quota
  table: 256 MiB per account per UTC day (each request counts its size,
  rounded up to whole MiB: four full downloads) and 64 requests per IP per
  hour; keys are salted hashes. No player header (cookie, address) goes
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
  maximum of 100,000, at most 50,000 on the Free plan), optional pepper from
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
  it; unverified addresses expire after 7 days and can only be entered while
  email works), so typing someone else's address neither squats it nor lets
  its owner take the account over. "Forgot password" answers the same
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
  covers the music relay (`/api/content/ra-scores`), whose daily byte budget
  is kept per account.
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
the email binding is missing (Workers Free plan).

## Accounts review (2026-10-09)

A security review (Fable 5.1) of the accounts system found these issues; all
are fixed, and `apps/server/test/accounts-review.test.mjs` replays each
exploit:

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| F1 | Medium | The sign-in lockout was keyed on the login string: anyone could lock a victim's password sign-in for a whole day with 50 requests, and username and email were separate budgets. | The login is resolved to the account first; the short lock is per account and address, the long budget per address, and the account-wide limit is an escalating delay (at most 15 minutes) that addresses the account used before do not see. Success clears the counters. |
| F2 | Medium | Staff routes did not require an active account, status changes kept sessions alive, approve and reject skipped the moderation rules: a deactivated admin could ban the last admin, a pending moderator could approve itself, a moderator could reject a pending admin. | Staff routes need an active account; a status change away from active revokes the sessions; approve and reject follow the moderation rules; the last active, unbanned admin is protected for status changes, demotion, bans and deletion. |
| F3 | Medium | A password change with the current password, and a sign-in that rehashed, derived two keys in one request, more than the Free plan's 10 ms of CPU. | One derivation per request: password changes need a re-authentication instead, hashes are upgraded when the password is set; the default is 40,000 iterations (measured), with the ceiling documented. |
| F4 | Medium-Low | Every rate limit check wrote to D1, even for refused requests, and a failed sign-in wrote three rows: a flood could use up the D1 Free daily write quota and take the site down. | Burst limits through the Workers Rate Limiting binding; D1 counters are read before written (refusals cost no write); session use writes about one row per 15 minutes; a WAF rule is documented. |
| F5 | Low | IP hashes were unsalted by default (reversible by hashing the IPv4 space). | HMAC under the required secret `IP_HASH_SALT`; production refuses to store hashes without it. |
| F6 | Low | Unverified addresses could get reset links and could be squatted while email was unavailable. | Reset links go to verified addresses only; addresses are only entered while they can be confirmed; unverified ones claim nothing and expire after 7 days. |
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
(`apps/game/js/account/gate.js`).

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
  Purging an account deletes the maps it shared; its published maps stay,
  without the uploader. The data export lists both kinds.
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
  network and 32 MiB. The file is validated strictly (`parseReplay`) and must
  match the record exactly (save point, state hash, game version, map hash,
  options digest, frames digest), so a player cannot resume with edited
  orders, options or map. Its orders must fit the order log limit. Only the
  accounts that played a seat can take it again; anybody else may only watch
  (within the spectator places, with the session's password rules), as in any
  game. The map is checked like an upload and shared with the session only.
- **Fair restart.** Every client fast-forwards through the same orders and
  compares its state hash with the saved one before it may continue; the
  relay starts only when every player caught up, so nobody gets a head start.
  Orders and hashes sent before that are refused.

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
