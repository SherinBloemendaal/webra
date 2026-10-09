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
  relay's existing header, origin and rate limit checks.
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
- Rate limits per connection and per IP (`CF-Connecting-IP`), message size
  limits, strict message schemas, no `innerHTML` sinks for user text.
- Rejoin keys are high-entropy tokens stored as SHA-256 and compared in
  constant time, like the host key; spectators can never send orders.

## Reporting

Please report security issues privately to the repository owner rather than in
public issues.
