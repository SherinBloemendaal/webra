# Accounts and admin API

The contract between the Worker (`apps/server/src/accounts/*`) and every
client (the game, the website, the account and admin pages). Change it first,
in its own commit, when it has to move. Shared validators (usernames, emails,
passwords, the settings document, roles, statuses, flags) live in
`packages/protocol/src/accounts.js` and are importable in the browser as
`/play/protocol/accounts.js` (re-exported from `/play/protocol/index.js`).

Everything here is served by the Worker under `https://webra.sherin.dev/api/`.
Times are Unix milliseconds (numbers). Ids are lower case hex strings. All
bodies are JSON (UTF-8).

## 1. Conventions

### 1.1 Requests

- **Content type.** Every request with a body sends `Content-Type:
  application/json`. Other types get `415 bad_message`. Bodies are capped
  (default 8 KiB, settings documents 40 KiB, see each endpoint) and must be a
  JSON object; unknown fields are refused (`400 invalid`).
- **CSRF.** Every request whose method is not `GET` or `HEAD` (to any
  `/api/*` path, including the older `POST /api/sessions` and
  `POST /api/maps`) must:
  1. carry `Origin` equal to the site's own origin (`https://webra.sherin.dev`,
     or the local dev origin);
  2. carry `Sec-Fetch-Site: same-origin` or no `Sec-Fetch-Site` at all
     (`same-site` and `cross-site` are refused);
  3. carry the header `X-WebRA-CSRF: 1`.

  A failure answers `403 csrf`. Browsers never attach a custom header to a
  cross-site request without a CORS preflight, and the API answers no
  preflight. `GET` requests to `/api/account/*` and `/api/admin/*` must also
  send `X-WebRA-CSRF: 1` (so a top-level navigation cannot read or trigger
  them). The only `GET` without the header is the Discord callback (a
  navigation coming back from discord.com, section 4.6).
- **WebSocket upgrades** (`/api/sessions/:id/ws`) cannot carry custom headers:
  they need `Origin` equal to the site's origin and are authenticated by the
  session cookie (section 7.2).

### 1.2 Responses and errors

Successful responses are JSON with `Cache-Control: no-store`. `204` has no
body. Errors always look like this:

```json
{ "error": { "code": "invalid", "message": "Username must be 3 to 24 characters.", "field": "username" } }
```

- `code`: machine readable (`/^[a-z_]{1,32}$/`), see the table below.
- `message`: human readable, at most 200 characters, safe to show as text
  (never insert it as HTML).
- `field` (optional): the request field that was refused.
- Extra members for some codes: `status` (account state) for
  `account_inactive`, `ban: { reason, expiresAt }` for `banned`,
  `current: { version, settings }` for `version_conflict`,
  `retryAfter` (seconds) for `rate_limited` and `locked` (also sent as the
  `Retry-After` header).

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `bad_message` | Malformed request (JSON, method, encoding) |
| 400 | `invalid` | A field failed validation (`field` names it) |
| 401 | `unauthenticated` | No valid session cookie |
| 401 | `bad_credentials` | Wrong login, password, passkey or token; always generic |
| 403 | `csrf` | The CSRF rules of 1.1 were not met |
| 403 | `forbidden` | Signed in, but the role or the request is not allowed |
| 403 | `reauth_required` | The action needs a recent re-authentication (section 4.5) |
| 403 | `account_inactive` | The account is `pending_email`, `pending_approval` or `deleted` (`status` says which) |
| 403 | `banned` | The account is banned (`ban` has the reason and expiry) |
| 403 | `ip_banned` | The client's IP address is banned |
| 403 | `registration_closed` | Signup is closed in the site settings |
| 403 | `method_disabled` | That login method is switched off in the site settings |
| (WebSocket) | `account_required` | Online play needs a signed-in account; HTTP routes answer `401 unauthenticated` instead |
| 403 | `relay_forbidden` | The content relays (package and music) need the `content_autoinstall` flag (or admin) and the relay switched on |
| 404 | `not_found` | No such endpoint or object |
| 405 | `bad_message` | Method not allowed (`Allow` header lists the allowed ones) |
| 409 | `conflict` | Username or email already taken, Discord already linked, last login method |
| 412 | `version_conflict` | `If-Match` does not match the stored version (`current` attached) |
| 413 | `too_large` | Body too large |
| 416 | `bad_range` | The music relay got no single byte range inside `scores.mix` (`Content-Range: bytes */64171360`) |
| 415 | `bad_message` | Not `application/json` |
| 428 | `precondition_required` | `If-Match` missing on a versioned write |
| 429 | `rate_limited` | A rate limit was hit (`retryAfter`) |
| 429 | `locked` | Too many failed sign-ins for this login name or account (`retryAfter`) |
| 500 | `internal` | Server error (nothing about it is echoed) |
| 503 | `unavailable` | The feature needs a service that is not configured (email, Discord) |
| 503 | `misconfigured` | The server lacks a required secret (`IP_HASH_SALT`); nothing that would store an address hash runs |

## 2. Model

### 2.1 Accounts

| Field | Type | Rules |
|-------|------|-------|
| `id` | string | 32 hex characters, random, never changes |
| `username` | string | 3 to 24 characters after normalization: NFC, whitespace runs collapsed to one space, trimmed, no control, bidi or invisible formatting characters. Letters, combining marks, digits, space, `_`, `-`, `.`; starts with a letter or digit; no `@`; letters from one script family only (no Latin mixed with Cyrillic or Greek). Unique case-insensitively and after compatibility folding (NFKC, lower case); a set of reserved names (`admin`, `moderator`, `system`, `webra`, `server`, ...) is refused. Shown in lobbies. Users may change it once every 30 days; admins any time. |
| `displayName` | string | 1 to 32 characters, same text rules as lobby names. Not unique. Defaults to the username. |
| `email` | string or null | At most 254 characters, ASCII only (internationalized domains in punycode), one `@`, a domain with a dot. Stored as entered with the domain lower cased; a verified address is unique case-insensitively. Required at signup (every signup path, 4.2 and 4.6); accounts created before it was required may have none (`null`). |
| `emailVerified` | boolean | Proven by a link sent to it, or by Discord reporting it verified |
| `avatarColor` | string | `#rrggbb`, lower case hex. Random at signup. |
| `role` | string | `user`, `moderator` or `admin` |
| `status` | string | `pending_email`, `pending_approval`, `active`, `banned`, `deleted` (see 2.2) |
| `flags` | string[] | Known flags only: `content_autoinstall` (may use the one-click Red Alert content relays: the package and the music) |
| `createdAt`, `lastSeenAt` | number | `lastSeenAt` is updated at most hourly (or when the address changes) |
| `usernameChangedAt` | number or null | Last self-service rename |

Username and email normalization are exported by the protocol package
(`validUsername`, `usernameKey`, `validEmail`, `emailKey`) so clients can
check input before sending; the server is the authority.

**Passwords:** 10 to 128 characters (code points), NFC normalized, otherwise
taken as typed (spaces and any script allowed). Refused when equal to the
username or the email, or when on a short list of very common passwords.
Stored as PBKDF2-HMAC-SHA256 with a 16-byte random salt per user, the
iteration count stored with every hash (default 40,000, configurable with
the `PASSWORD_ITERATIONS` variable up to the Workers maximum of 100,000; keep
it at or below 50,000 on the Workers Free plan, see docs/deploy.md), and,
when the Worker secret `PASSWORD_PEPPER` is set, an HMAC-SHA256 of the
password with the pepper before PBKDF2 (also recorded per hash). No request
derives more than one key (10 ms of CPU per request on the Free plan), so
hashes are upgraded to the current count and pepper when the password is
next set (change or reset), never at sign-in.

**Email addresses** are required for new accounts and claim nothing until
verified: only a verified address is unique, used for sign-in by email and
sent reset links. A second account may sign up with an address another
account typed (or even verified); the first one to verify it keeps it (a
later verification answers `409 conflict`). No answer tells whether an
address belongs to an account: a signup, change or resend with an address
another account verified is answered as usual, and the address gets a
notice without a link instead of the verification link (section 4.3).

While email sending is unavailable (no binding or no `EMAIL_FROM`, docs/deploy.md)
or `login.email` is off, signup still takes the address and keeps it
unverified; there is no verification step and the account page says that
verification email is not available yet. An unverified address stays on its
account until the owner changes it or the account is deleted (it is no
longer cleared after 7 days); signups that wait in `pending_email` expire
instead (2.2). Accounts from before addresses were required keep working
without one and may add one (5.4); they are never asked to.

### 2.2 Account states

The stored status is one of `pending_email`, `pending_approval`, `active`,
`deleted`. `banned` is reported (as `status`) whenever an account ban is in
effect (section 6); the stored status comes back when the ban ends or is
lifted.

| Status | Sign in | Account pages | Online play, uploads, relay | How it ends |
|--------|---------|---------------|------------------------------|-------------|
| `pending_email` | yes | yes | no (`account_inactive`) | Following the verification link (or an admin marking the address verified, 8.6); then `pending_approval` when approval is required, else `active`. An admin can set the status or approve. Expires (`deleted`, address cleared) when not confirmed within 7 days of the address being set, see below. |
| `pending_approval` | yes | yes | no (`account_inactive`) | A moderator or admin approves (`active`) or rejects (`deleted`) |
| `active` | yes | yes | yes (the relay also needs the flag) | |
| `banned` | no (`banned` after correct credentials) | no | no | The ban expires or is lifted. A ban signs the account out everywhere and drops it from running games. |
| `deleted` | no (`bad_credentials`) | no | no | An admin restores it within 30 days; then the account and everything about it is purged |

At signup: `pending_email` when email verification is in effect (section 3)
and the email is not verified yet, else `pending_approval` when approval is
required, else `active`. Turning approval or verification on later (or email
sending becoming available) does not change existing accounts: an existing
account never moves to `pending_email` by itself.

**Unconfirmed signups expire.** The daily job deletes accounts that have
waited in `pending_email` since their signup (the first status change of an
account ends this for good, so an account that was ever verified, approved,
active, restored, or set to `pending_email` by an admin never expires), that
are plain users (never staff), were never approved, and whose address was set
more than 7 days ago. They are deleted like a self-deletion (sessions and
links removed, purged 30 days later), their address is cleared (it may
belong to someone else), and a system `user.expire` audit entry is written.
Changing the address restarts the 7 days. It runs only while verification
links can actually be sent (email sending configured and `login.email` on).
An admin can restore such an account within the 30 days; it comes back
without an address.

**Deleted accounts claim nothing but their username.** A soft-deleted account
(self-deletion, admin deletion, rejection, expiry) gives up its address
(`email_key` cleared; the address and whether it was verified stay for a
restore) and its Discord account (the id is kept aside, not linked). Both are
free for a new signup at once. A restore claims them again only when nobody
else did meanwhile (8.5).

### 2.3 Roles and permissions

Every check is made on the server. `self` means the signed-in account.

| Action | user | moderator | admin |
|--------|------|-----------|-------|
| Self service (section 5) | yes | yes | yes |
| List and search users, user detail without IP history, email masked, without the settings document | | yes | yes |
| Approve or reject pending accounts | | yes | yes |
| Ban and unban accounts (not moderators or admins, never self) | | yes | yes |
| Stats (`GET /api/admin/stats`) | | yes | yes |
| Full user detail (email, IP history, sessions, settings document) | | | yes |
| Edit profile, email, status, role, flags | | | yes |
| Ban and unban moderators and admins (never self) | | | yes |
| Force sign-out, revoke one session | | | yes |
| Password reset link | | | yes |
| Delete, restore, purge accounts | | | yes |
| Read and edit any settings document | | | yes |
| IP bans | | | yes |
| Site settings | | | yes |
| Audit log | | | yes |

Admins cannot change their own role or delete or ban themselves, and the last
active admin cannot be demoted. A role change signs the target out
everywhere (its sessions are revoked), so privileges never change under a
live session.

### 2.4 Sessions and cookies

- **Session cookie:** `__Host-webra_session`, except for plain HTTP to a
  local development host (`localhost`, `127.0.0.1`, `[::1]`), where it is
  `webra_session` without `Secure` (`__Host-` and `Secure` cannot apply
  there). Plain HTTP to any other host still gets the Secure `__Host-`
  cookie, which browsers refuse to store: sign-in fails closed. Attributes: `HttpOnly; Secure; SameSite=Lax;
  Path=/; Max-Age=2592000` (the `Secure` attribute is left out only on plain
  HTTP). The value is 32 random bytes, base64url (43 characters). The server
  stores only its SHA-256.
- **Lifetime:** 30 days at most from sign-in (absolute), and 14 days without
  use (idle). A session in use is extended by nothing beyond the absolute
  limit.
- **Rotation:** a new session id on every sign-in (an old cookie's session is
  deleted), on re-authentication, on password change or reset (all other
  sessions are revoked), on linking or unlinking a login method. Role changes
  and bans revoke all of the account's sessions.
- **Per session** the server keeps: a public id (16 hex, for listing and
  revoking), device label (editable, 1 to 40 characters, defaults to a summary
  of the user agent such as `Firefox on Linux`), user agent summary (at most
  120 characters), IP hash (salted SHA-256, not the IP), created, last used,
  expiry, and the time of the last re-authentication.
- **OAuth cookie:** `__Host-webra_oauth` (or `webra_oauth` on HTTP), same
  attributes, `Max-Age=600`, set by `POST /api/auth/discord/start` and
  cleared by the callback. It binds the Discord flow to the browser that
  started it.
- **Play pass cookie:** `__Host-webra_play` (or `webra_play` on plain HTTP to
  a local development host), `HttpOnly; Secure; SameSite=Lax; Path=/;
  Max-Age=600`, set by the play gate (section 7.1) on a game file response
  after it checked the session in D1. `Path=/` because browsers refuse
  `__Host-` cookies with any other path; only `/play` requests read it.
  Signing out, revoking the current session, deleting the account and every
  response that clears a stale session cookie clear it too.

### 2.5 Site settings

One versioned document, edited by admins. Defaults in brackets.

```json
{
  "version": 1,
  "registration": { "open": true, "approvalRequired": true, "emailVerification": true },
  "login": { "password": true, "email": true, "discord": true, "passkey": true },
  "onlineRequiresAccount": true,
  "gameRequiresAccount": true,
  "contentRelay": true,
  "motd": ""
}
```

The document is stored as JSON in one row; a key it lacks reads as its
default, so a new setting needs no migration (`gameRequiresAccount` is on for
documents saved before it existed).

- `registration.open` [true]: signup allowed (all methods).
- `registration.approvalRequired` [true]: new accounts wait for approval
  (closed beta). False: open beta.
- `registration.emailVerification` [true]: new accounts must verify an email
  before they are approved or active. **Only in effect while email sending is
  available** and `login.email` is on (see `GET /api/site`).
- `login.password`, `login.email`, `login.discord`, `login.passkey` [all true]:
  each login method on or off. `email` covers verification, reset and email
  change links. A method that is on but not configured (no email binding, no
  Discord credentials) is reported unavailable and behaves as off. Switching a
  method off never removes credentials; accounts whose only method is off
  cannot sign in until it is on again or an admin sends a reset link.
- `onlineRequiresAccount` [true]: creating and joining online sessions and
  uploading maps need an active account. False: anonymous play as before
  (signed-in players still play under their username).
- `gameRequiresAccount` [true]: the game itself (`/play`, `/play/*`) is served
  only to active, unbanned accounts from unbanned addresses (section 7.1).
  False: anyone may load the game. A change applies at once on the server that
  saved it and within 30 seconds everywhere (each server caches the settings
  for the gate that long).
- `contentRelay` [true]: the one-click Red Alert content relay is on (it
  always also needs the flag or the admin role).
- `motd` [""]: message of the day, 0 to 500 characters, plain text with line
  breaks; clients show it with `textContent`.

## 3. Public endpoints

### `GET /api/site`

No authentication. What clients need to draw sign-in and signup forms.

```json
{
  "registration": { "open": true, "approvalRequired": true, "emailVerificationRequired": false },
  "login": {
    "password": true,
    "email": false,
    "discord": false,
    "passkey": true
  },
  "services": { "email": false, "discord": false },
  "email": { "sentToday": 0, "dailyLimit": 300, "limitReached": false },
  "onlineRequiresAccount": true,
  "gameRequiresAccount": true,
  "contentRelay": true,
  "motd": "",
  "passkey": { "rpId": "webra.sherin.dev" },
  "policy": { "usernameMin": 3, "usernameMax": 24, "passwordMin": 10, "passwordMax": 128, "displayNameMax": 32 },
  "privacyUrl": "/privacy.html"
}
```

`login.*` here are the **effective** values: the setting is on and the
service behind it is configured (`email` needs the binding `env.EMAIL` and a
valid sender address in the variable `EMAIL_FROM`, `discord` needs
`DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`). `services` tells whether the
binding or credentials exist at all. `emailVerificationRequired` is the
effective value of `registration.emailVerification` (false while email is
unavailable or `login.email` is off).

## 4. Authentication (`/api/auth/*`)

Every response that signs someone in sets the session cookie and returns
`{ "user": UserSelf }` (section 5.1). Sign-in and signup are refused with
`ip_banned` for banned IPs before any other check.

### 4.1 `GET /api/auth/me`

The current account, or none. Never 401.

```json
{ "user": UserSelf | null, "session": { "id": "9f1c...", "createdAt": 0, "expiresAt": 0, "reauthUntil": 0 } | null }
```

`reauthUntil` is when the recent re-authentication (4.5) runs out (0 when
there is none). A banned IP gets `403 ip_banned`. A session whose account was
banned, deleted or purged is deleted, the cookie is cleared, and `user` is
null.

### 4.2 Signup: `POST /api/auth/signup`

```json
{
  "username": "Tanya",
  "displayName": "Tanya Adams",
  "email": "tanya@example.com",
  "password": "a long passphrase",
  "passkey": { "challengeId": "...", "credential": RegistrationCredential },
  "acceptPrivacy": true
}
```

- `acceptPrivacy` must be `true` (the form links `/privacy.html`).
- `displayName` optional (defaults to the username).
- `email`: required (`400 invalid`, `field: email` when missing or
  malformed), also with a passkey (checked before the passkey challenge is
  used). It is stored unverified and claims nothing.
- Exactly one of `password` (needs `login.password`) or `passkey` (needs
  `login.passkey`; the challenge comes from 4.4 `signup-options` with the same
  username). Discord signup is 4.6.
- `201 { user }` and a session cookie, also for pending accounts (they can
  verify their email, add login methods and see their status). While email
  sending is available (`login.email`), the verification mail goes out
  after the answer (so neither the answer nor its timing depends on it):
  the link, or, when another account verified the address, a notice without
  a link (4.3). Without email sending nothing is mailed and the address
  waits unverified.
- Errors: `registration_closed`, `method_disabled`, `invalid` (with `field`),
  `conflict` (`field: username`; never for the email), `ip_banned`,
  `rate_limited` (10 signups per hour per network: an IPv4 address or an
  IPv6 /64, together with Discord signups).

### 4.3 Password sign-in

`POST /api/auth/login`

```json
{ "login": "Tanya or tanya@example.com", "password": "..." }
```

- `200 { user }` with a new session (the old one, if any, is deleted).
- Wrong login or password, a deleted account, or an account without a
  password: `401 bad_credentials` with the same message and about the same
  time (an unknown login still pays for a password hash).
- After correct credentials: `403 banned` (with `ban`). Pending accounts sign
  in normally (their `status` says what is missing).
- Throttling (`429` with `retryAfter`; `rate_limited` or `locked`). The login
  is resolved to its account first, so username and email share one budget:
  - a burst limit per IP (20 per minute through the Workers Rate Limiting
    binding; 30 per 15 minutes in D1 without it);
  - 10 failures per 15 minutes per account (or unknown name) **and IP**:
    that address is locked for that account for the rest of the window;
  - 100 failures per day per IP across all accounts;
  - per account across all addresses an escalating delay: from the 10th
    failure within a day each further failure doubles a wait (2 s, 4 s, ...,
    at most 15 minutes). Addresses the account signed in from before (its IP
    history) are exempt, so nobody else can keep the owner out; there is no
    hard lock. Passkeys, Discord and reset links are never affected.
  A successful sign-in clears the account's failure count and delay and the
  failures of that account from that address. Refused attempts cost no D1
  writes.
- `login.password` off: `method_disabled`.

`POST /api/auth/logout`: `204`, deletes the session and clears the cookie
(also without a session).

`POST /api/auth/password/forgot` `{ "email": "..." }`: always `202 {}` when
the request is well formed (whether or not an account has that email; the
lookup and the mail happen after the answer), and sends a reset link if an account has that address **verified** (never to an
unverified one). Needs email to be
available and `login.email` on (`503 unavailable` / `method_disabled`
otherwise). Limits: 5 per hour per IP, 3 per hour per mailbox (4.3).

`POST /api/auth/password/reset` `{ "token": "...", "password": "..." }`:
sets the password, marks the email verified (the link proved it), revokes
every session of the account and signs in (`200 { user }`). Bad, used or
expired tokens: `401 bad_credentials`. A banned account: `403 banned` (the
password is still changed). Limit: 20 token redemptions per 15 minutes per
IP.

`POST /api/auth/email/verify` `{ "token": "..." }`: confirms a verification
or email change link (no session needed: the link proves the inbox, and it
only ever verifies the account it was made for). `200 { user: UserSelf |
null }` (`user` only when the request also carries a session of that
account). Bad, tampered, used, superseded or expired tokens, and a
verification link for an address the account no longer has: `401
bad_credentials`. When another account verified the address meanwhile:
`409 conflict`. Verifying moves a `pending_email` account on (2.2).

**Address mail.** A verification link is bound to the account and the exact
address it was sent to. Each new link (signup, resend, change, admin resend)
replaces the account's earlier verification and change links. When another
account already verified the address, the address gets a notice that it
already has an account (no link, nothing the requester typed) instead, the
link record is still stored (so `pendingEmail` and every answer look the
same), and the mail is prepared after the answer. Each mailbox receives at
most 3 such mails per hour and 6 per day, whoever asks; a mailbox is the
address in lower case without a `+suffix`, and for Gmail (`gmail.com`,
`googlemail.com`, counted as one) without dots, so variants of one inbox
share the limit (uniqueness still uses the plain address, 2.1). All account
mail together is limited to `EMAIL_DAILY_LIMIT` messages per UTC day
(default 300). Over a limit nothing is sent and the answer is unchanged; a
verification link is then not made (the earlier one stays valid), a change
link is recorded anyway (it is what `pendingEmail` shows). The admin stats
show the day's count and whether the ceiling is reached (8.9).
Messages are plain text plus simple HTML with the site name, the link to the
account page, its expiry and a note to ignore it if unexpected; no images,
no tracking. Links always point at the configured site origin (the variable
`SITE_ORIGIN`, `https://webra.sherin.dev`), whatever host the request
reached; only plain HTTP to a local development host links to itself. They
are sent from `EMAIL_FROM`.

**Links in emails** point at the account page and carry the token in the URL
fragment (never sent to any server, never in a `Referer`):

- `https://webra.sherin.dev/account/#verify=<token>` (verification and email change)
- `https://webra.sherin.dev/account/#reset=<token>` (password reset)

The account page posts the token to the endpoint above and removes the
fragment with `history.replaceState`. Tokens are 32 random bytes, base64url
(43 characters), stored as SHA-256, single use; a newer token of the same
purpose replaces older ones. Lifetimes: verification 24 hours, email change
24 hours, reset 1 hour. Admin generated reset links (8.6) live 24 hours.

### 4.4 Passkeys (WebAuthn)

Relying party id: `webra.sherin.dev` in production, `localhost` for local
development (the request's host decides; any other host is refused).
Allowed origins: `https://webra.sherin.dev`, and `http://localhost:<port>`
or `http://127.0.0.1:<port>` only for local development (127.0.0.1 is
accepted as an origin but its rp id is `localhost`, so browsers need
`localhost`). Attestation `none` is requested and any attestation format is
accepted without verifying the statement (no attestation trust). Algorithms:
EdDSA (-8, Ed25519), ES256 (-7), RS256 (-257). Challenges are 32 random
bytes, single use, expire after 5 minutes, and are bound to their purpose
(and account, when signed in).

All binary members (`challenge`, `user.id`, credential ids, `clientDataJSON`,
`authenticatorData`, `attestationObject`, `signature`, `userHandle`) travel as
base64url without padding, the format of
`PublicKeyCredential.toJSON()` and `PublicKeyCredential.parse*OptionsFromJSON()`.

**Options for a new passkey**

- Signup: `POST /api/auth/passkey/signup-options` `{ "username": "...", "displayName": "..." }`
  (checks the username is free; registration open; `login.passkey` on).
- Signed in: `POST /api/account/passkeys/options` `{}` (needs a recent
  re-authentication, 4.5).

Both answer:

```json
{
  "challengeId": "c0ffee...",
  "publicKey": {
    "rp": { "id": "webra.sherin.dev", "name": "WebRA" },
    "user": { "id": "<base64url user handle>", "name": "Tanya", "displayName": "Tanya Adams" },
    "challenge": "<base64url>",
    "pubKeyCredParams": [{ "type": "public-key", "alg": -8 }, { "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -257 }],
    "timeout": 300000,
    "attestation": "none",
    "authenticatorSelection": { "residentKey": "required", "requireResidentKey": true, "userVerification": "preferred" },
    "excludeCredentials": [{ "type": "public-key", "id": "<base64url>", "transports": ["internal"] }]
  }
}
```

`RegistrationCredential` (from `credential.toJSON()`):

```json
{
  "id": "<base64url>",
  "rawId": "<base64url>",
  "type": "public-key",
  "response": { "clientDataJSON": "<base64url>", "attestationObject": "<base64url>", "transports": ["internal", "hybrid"] },
  "clientExtensionResults": {},
  "authenticatorAttachment": "platform"
}
```

Registration checks: `type` is `webauthn.create`, the challenge matches the
stored one, the origin is allowed, the rp id hash matches, user presence is
set, the credential id is new, the algorithm is one of the three, and the
COSE key is well formed. A credential id already registered anywhere is a
`409 conflict`.

**Sign in with a passkey** (usernameless, discoverable credentials):

1. `POST /api/auth/passkey/options` `{}` ->
   `{ "challengeId", "publicKey": { "challenge", "rpId", "timeout": 300000, "userVerification": "preferred", "allowCredentials": [] } }`
2. `POST /api/auth/passkey/login` `{ "challengeId", "credential": AuthenticationCredential }`
   -> `200 { user }` and a session.

```json
{
  "id": "<base64url>", "rawId": "<base64url>", "type": "public-key",
  "response": { "clientDataJSON": "<base64url>", "authenticatorData": "<base64url>", "signature": "<base64url>", "userHandle": "<base64url>" },
  "clientExtensionResults": {}
}
```

Checks: `type` is `webauthn.get`, challenge, origin, rp id hash, user
presence, the credential is known, `userHandle` (when present) belongs to its
account, the signature over `authenticatorData || SHA-256(clientDataJSON)`
verifies with the stored key, and the signature counter: when the stored and
received counters are not both zero, the received one must be greater (else
`401 bad_credentials`, and the passkey is marked `counterError` for the
owner and admins to see). Every failure is `401 bad_credentials`. Limits: 20
per minute per IP (binding) or 30 per 15 minutes (D1). User verification is
recorded (`uv`); it is not required to sign in, but it is required for a
re-authentication (4.5).

### 4.5 Re-authentication

Sensitive actions need an explicit re-authentication from the last 10
minutes on this session (`reauthUntil` in `/api/auth/me`, 0 when there is
none): setting or changing the password, changing or removing the email,
adding or removing passkeys, linking or unlinking Discord, removing the
password, deleting the account, exporting data. **Signing in or up does not
count**: a stolen or forgotten session cannot change credentials without the
password, a user-verified passkey, or Discord.

`POST /api/auth/reauth` with one of

```json
{ "password": "..." }
{ "passkey": { "challengeId": "...", "credential": AuthenticationCredential } }
```

The passkey challenge comes from `POST /api/auth/passkey/options`
`{ "purpose": "reauth" }` (signed in; `allowCredentials` lists the account's
passkeys; `userVerification: "required"`). The assertion must carry the user
verification flag (PIN or biometrics), else `401 bad_credentials`. Discord-only accounts re-authenticate through Discord (4.6,
`mode: "reauth"`). Answers `200 { "reauthUntil": 0 }` and rotates the
session cookie. Wrong proofs: `401 bad_credentials`; 10 failures per 15
minutes per account lock it (`locked`).

### 4.6 Discord

Available when `DISCORD_CLIENT_ID` (wrangler var) and `DISCORD_CLIENT_SECRET`
(Worker secret) are set and `login.discord` is on. Authorization code flow
with PKCE (S256) and `state`, scopes `identify email`, redirect URI
`<origin>/api/auth/discord/callback`.

`POST /api/auth/discord/start`

```json
{ "mode": "login" | "signup" | "link" | "reauth", "returnTo": "/account/", "acceptPrivacy": true, "email": "tanya@example.com" }
```

- `login`: sign in with a linked Discord account.
- `signup`: like `login`, but an unknown Discord account creates a WebRA
  account (registration must be open; `acceptPrivacy: true` required). The
  username is taken from the Discord username (passed through the lobby text
  rules, `Discord user` when it does not fit; a number is
  appended when it is taken or invalid; changeable later). Every new
  account gets an address: the Discord email when Discord reports it
  verified (stored as verified; when it already belongs to another account,
  the signup fails with `email_taken`, which only the owner of that Discord
  inbox can see), else the optional `email` of this request (checked here,
  `400 invalid` with `field: email`; it travels with the OAuth state and is
  stored unverified with a verification link mailed as in 4.2). With
  neither the callback answers `email_required` and creates nothing.
- `email` is accepted with `signup` only.
- `link` (signed in, recent re-authentication): link Discord to this account.
- `reauth` (signed in, Discord linked): counts as a re-authentication.
- `returnTo`: a same-origin path starting with `/` (not `//`), at most 200
  characters; default `/account/`.

Answers `200 { "url": "https://discord.com/oauth2/authorize?..." }` and sets
the OAuth cookie. The client navigates to `url`. Limit: 20 per 15 minutes
per IP.

`GET /api/auth/discord/callback?code=...&state=...` (navigation from
Discord, no CSRF header): checks the state (single use, 10 minutes, bound to
the OAuth cookie), exchanges the code with the PKCE verifier, reads
`/users/@me`, and redirects (`302`) to `returnTo` with the outcome in the
fragment: `#discord=ok` or `#discord=error&code=<code>`, codes:
`denied` (the user cancelled), `invalid_state`, `no_account` (login with an
unlinked Discord account), `already_linked` (that Discord account belongs to
another WebRA account), `email_taken`, `email_required` (signup: no
verified Discord email and none typed), `registration_closed`,
`method_disabled`, `banned`, `ip_banned`, `account_inactive` (a deleted
account), `rate_limited` (the signup limit of 4.2, per network), `unavailable` (Discord unreachable
or misconfigured). On success a
session cookie is set for `login` and `signup`; `link` and `reauth` rotate
the existing one. A Discord email that Discord reports verified counts as a
verified email when it equals the account's email (link and login).

## 5. Self service (`/api/account/*`)

All need a session (`401 unauthenticated`) of an account that is not banned
or deleted (`403 banned` / `account_inactive`). Pending accounts may use
everything here.

### 5.1 `GET /api/account`

```json
{
  "user": {
    "id": "0a1b...",
    "username": "Tanya",
    "displayName": "Tanya Adams",
    "email": "tanya@example.com",
    "emailVerified": true,
    "pendingEmail": null,
    "avatarColor": "#c8402a",
    "role": "user",
    "status": "active",
    "flags": ["content_autoinstall"],
    "createdAt": 0,
    "lastSeenAt": 0,
    "usernameChangedAt": null,
    "methods": { "password": true, "discord": { "username": "tanya", "linkedAt": 0 } | null, "passkeys": 2 },
    "ban": null,
    "canPlay": true,
    "canPlayOnline": true,
    "canUseContentRelay": true
  }
}
```

This object is `UserSelf` everywhere in this document. `pendingEmail` is an
address waiting for its change link. `canPlay` is the server's verdict for
loading the game (section 7.1: active, or anyone not banned while
`gameRequiresAccount` is off; a banned address is refused by the gate
anyway, and `GET /api/auth/me` answers it with `403 ip_banned`).
`canPlayOnline` is the server's verdict for online play right now (status,
site settings); `canUseContentRelay` likewise for the relay.

### 5.2 Profile

`PATCH /api/account` `{ "displayName"?, "avatarColor"?, "username"? }` ->
`200 { user }`. A new `username` needs 30 days since the last self-service
change (`403 forbidden` otherwise) and must be free (`409 conflict`). 30
changes per hour per account.

### 5.3 Password

- `POST /api/account/password` `{ "newPassword" }` (recent
  re-authentication, 4.5; there is no `currentPassword` field: proving the
  old password and hashing the new one in one request would exceed the CPU
  budget). Also upgrades the hash to the current iteration count and pepper.
  Revokes all other sessions, rotates this one, `200 { user }`.
- `DELETE /api/account/password`: removes the password (recent
  re-authentication; another login method must remain, else `409 conflict`,
  checked atomically: concurrent removals never leave an account without a
  method).

### 5.4 Email

- `POST /api/account/email` `{ "email": "..." }` (recent re-authentication):
  - the account has a **verified** address: a change link goes to the new
    address and the answer is `202 { user }` (`pendingEmail` set; the
    address changes when the link is followed). Without email sending:
    `503 unavailable` (a confirmed address is never swapped for one nobody
    can confirm).
  - the account has **no address or an unverified one**: the new address
    replaces it at once, unverified (`200 { user }`; `email_set_at` restarts,
    see 2.2), and a verification link goes to it while email sending is
    available. Works without email sending too.
  - the same address again: `200 { user }`, nothing changes.
  An address another account verified is answered the same way (it gets the
  notice of 4.3 instead of a link). Limits: 5 per day per account, 20 per day
  per network.
- `POST /api/account/email/resend` `{}`: sends the verification link again
  for the current unverified address (`409 conflict` without one). `202 {}`,
  the mail goes out after the answer. Limits: 3 per hour and 10 per day per
  account, 10 per hour per network (an IPv4 address or IPv6 /64), plus the
  per-address mail limit of 4.3. Without email sending `503 unavailable`,
  with `login.email` off `403 method_disabled`.
- `DELETE /api/account/email`: always `409 conflict`. An address is required;
  change it instead, or delete the account.

### 5.5 Passkeys

- `GET /api/account/passkeys` -> `{ "passkeys": [{ "id", "name", "alg", "createdAt", "lastUsedAt", "backedUp", "transports", "counterError" }] }`
- `POST /api/account/passkeys/options` `{}` (4.4)
- `POST /api/account/passkeys` `{ "challengeId", "name", "credential" }`
  (recent re-authentication) -> `201 { "passkey": {...} }`. `name` 1 to 40
  characters. At most 20 passkeys per account.
- `PATCH /api/account/passkeys/:id` `{ "name" }` -> `200 { "passkey" }`
- `DELETE /api/account/passkeys/:id` (recent re-authentication) -> `204`;
  `409 conflict` when it is the last login method (checked atomically).

Passkey ids in paths are the credential ids (base64url).

### 5.6 Discord

- Linking: `POST /api/auth/discord/start` with `mode: "link"` (4.6).
- `DELETE /api/account/discord` (recent re-authentication) -> `200 { user }`;
  `409 conflict` when it is the last login method.

### 5.7 Sessions

- `GET /api/account/sessions` ->
  `{ "sessions": [{ "id", "current", "deviceLabel", "userAgent", "createdAt", "lastUsedAt", "expiresAt" }] }`
- `PATCH /api/account/sessions/:id` `{ "deviceLabel" }` -> `200 { "session" }`
- `DELETE /api/account/sessions/:id` -> `204` (the current one signs out and
  its play pass cookie is cleared)
- `DELETE /api/account/sessions` -> `204`, revokes every session except the
  current one. Their browsers may still load game files with a play pass they
  hold, for at most its remaining 10 minutes (section 7.1).

### 5.8 Settings document

The player's game settings, synchronized across devices.

`GET /api/account/settings` -> `200`, `ETag: "v<version>"`:

```json
{ "version": 3, "updatedAt": 0, "settings": SettingsDocument }
```

Version 0 with `settings: {}` means nothing is stored yet.

`PUT /api/account/settings` with `If-Match: "v<version>"` and body
`{ "settings": SettingsDocument }` replaces the whole document:

- `200 { version, updatedAt, settings }` with the new `ETag`.
- No `If-Match`: `428 precondition_required`. A stale one: `412
  version_conflict` with `current: { version, settings }`, so the client can
  merge and retry. `If-Match: "v0"` creates the first version.
- Invalid documents: `400 invalid` with `field` as a path such as
  `settings.audio.master`.
- 120 writes per hour per account; body at most 40 KiB.

**SettingsDocument** (schema 1; validated by
`validateSettingsDocument` in the protocol package). Every section and every
key is optional (the client fills defaults); unknown keys are refused except
inside `extra`. The keys `__proto__`, `constructor` and `prototype` are
refused everywhere (sections, `extra`, `lastOptions`, hotkey action names).
Serialized size at most 32 KiB.

```json
{
  "schema": 1,
  "game": {
    "edgeScrollSpeed": 1,          // number 0..3
    "keyScrollSpeed": 1,           // number 0.25..3
    "showUnitPaths": false,
    "pixelRatioCap": 2,            // number 0.5..3 (resolution cap)
    "lowQuality": false,
    "uiScale": "auto",             // "auto" | number 0.5..2 (size of the sidebar, bars, menus; UI_SCALE_LIMITS)
    "gameScale": "auto",           // "auto" | number 0.5..3 (base zoom of the battlefield; GAME_SCALE_LIMITS)
    "zoomFactor": 1,               // number 1/3..8/3 (the player's last zoom over the base zoom; ZOOM_FACTOR_LIMITS)
    "healthBars": "off",           // "off" | "damaged" | "all"
    "playerStanceColors": false,   // relationship colours (OpenRA TogglePlayerStanceColor)
    "hideReplayChat": false,       // OpenRA HideReplayChat: replay chat only in the chat history
    "uiFeedbackNotifications": true, // OpenRA TextNotificationPoolFilters Feedback
    "gameEventNotifications": true,  // OpenRA TextNotificationPoolFilters Transients
    "graphics": "webra",           // "webra" | "original"
    "hotkeys": { "attackMove": ["A"], "stop": [] },
    "attackMoveTipSeen": false,    // the one-time attack-move tip was shown (apps/game/js/hints.js)
    "mouseCapture": "fullscreen",  // "off" | "fullscreen" | "always" (Pointer Lock, js/mouselock.js)
    "mouseCaptureRaw": false,      // true: raw (unadjusted) movement with the game's acceleration curve
    "mouseCaptureSpeed": 1,        // number 0.25..3 (pointer speed while captured)
    "mouseCaptureEscMenu": true,   // true (default): Esc releases the mouse and opens the menu at once
    "mouseCaptureNotice": "always", // "always" | "first" (the first 3 captures) | "off": the "Mouse captured" notice
    "pauseWhenHidden": false       // single player: true opens the menu (pauses) when the page is hidden
  },
  "audio": {
    "enabled": true, "master": 0.8, "effects": 0.8, "voices": 0.9, "music": 0.5,   // volumes 0..1
    "speech": true, "original": true, "cashTicks": true,
    "musicOn": true, "musicShuffle": true,
    "musicRepeat": "all"           // "all" | "one" | "off" (MUSIC_REPEAT_MODES)
  },
  "content": {
    "packs": [{ "id": "desert tiles|someone", "enabled": true }]   // order = priority, first wins
  },
  "debug": {
    "cells": false, "footprints": false, "flow": false, "combat": false,
    "tags": false, "health": false, "stats": false, "graph": false, "cpuInstances": false,
    "perfCaptureSeconds": 30,      // performance capture length: 10, 30, 60 or 120 (PERF_CAPTURE_SECONDS, docs/contracts.md section 10)
    "perfCaptureStart": false      // record the first 60 s of every game
  },
  "lobby": {
    "name": "Commander",           // 1..20 characters, lobby name text rules
    "faction": "random",           // a lobby faction (FACTIONS)
    "color": 0,                    // 0..7
    "lastOptions": { },            // the skirmish lobby's stored setup, a JSON object (see below)
    "presets": [                   // saved game modes (see below)
      { "name": "Night ops", "options": { "mapStyle": "land", "biome": "snow", "weather": "full", "startingCash": 5000,
        "startingUnits": "mcv", "techLevel": "unrestricted", "gameSpeed": "normal", "fog": true, "explored": false,
        "buildRadius": true, "redeployableMcv": true, "oreRegrowth": true, "cheats": false } }
    ]
  },
  "releaseNotes": { "lastSeenVersion": "0.6.0" },   // VERSION_RE
  "privacy": { "errorReports": true },               // "Send error reports" (docs/security.md, "Error reports")
  "extra": { }                     // any JSON object for future keys, at most 8 KiB serialized
                                   // (the game keeps e.g. "mouseCaptureHints": 0..99 and the
                                   // repair box chooser's "repairBoxChoice" there)
}
```

(Comments only for this document; the JSON has none.)

- `hotkeys`: at most 200 actions; action names `/^[A-Za-z0-9_.:-]{1,64}$/`;
  each a list of at most 4 key combos, each 1 to 40 printable ASCII
  characters without spaces (`Ctrl+Shift+F1`); `[]` means unbound.
- `packs`: at most 64 entries with distinct ids; an id is 1 to 160
  characters of text without control characters.
- `lastOptions` and `extra`: JSON objects at most 4 levels deep, keys
  `/^[A-Za-z0-9_.-]{1,64}$/`, strings at most 500 characters, arrays at most
  64 entries, finite numbers only; `lastOptions` at most 4 KiB, `extra` at
  most 8 KiB serialized.
- `presets`: the player's saved game modes (`validateSavedPresets` in the
  protocol package, `src/presets.js`): a list of at most 16 entries
  `{ name, options }`. `name` is 1 to 32 characters of display text
  (normalized: single spaces, no control or bidi characters), unique
  ignoring case and not the name of a built-in mode. `options` holds the
  mode keys (every lobby option but `seed` and `mapSize`: `mapStyle`,
  `biome`, `weather`, `techBuildings`, `startingCash`, `startingUnits`,
  `techLevel`, `gameSpeed`, `timeLimit`, `movement`, `factoryLoss`, `fog`,
  `explored`, `buildRadius`,
  `redeployableMcv`, `oreRegrowth`, `cheats` and the other boolean
  options), each with a value the lobby options accept (docs/contracts.md
  section 3). Keys added after modes could be saved (`ADDED_PRESET_KEYS`:
  `timeLimit`, `crates`, `shortGame`, `bounty`, `separateTeamSpawns`,
  `allyBuildRadius`, `reusableEngineers`, `techBuildings`, `movement`,
  `factoryLoss`) may be missing:
  they take their defaults.

### 5.9 Data export and deletion

- `GET /api/account/export` (recent re-authentication; 5 per hour) ->
  `200`, `Content-Disposition: attachment; filename="webra-account-<username>.json"`:
  every stored record about the account: profile, status, role, flags,
  login methods (passkey ids, names, algorithms, counters, dates; never key
  material or password hashes), Discord id and username, sessions (without
  their secrets), IP history (raw addresses with first and last seen), bans,
  the settings document, pending email tokens (purpose and dates only),
  uploaded maps (ids, names, hashes, `published`: in the community list or
  only shared with online sessions, and when a session last used them),
  saved online games it played in (`onlineSaves`: record id, time, session
  name, ticks, game version and its seat), and audit log entries that target
  the account.
- `DELETE /api/account` `{ "confirm": "<username>" }` (recent
  re-authentication) -> `204`: the account becomes `deleted`, every session
  is revoked and the cookie cleared. It is purged 30 days later (an admin can
  restore it until then). The username stays reserved until the purge.

## 6. Bans

**Account bans:** reason (1 to 500 characters), expiry (`expiresAt`, a time in
the future, or null for permanent), who banned and when; lifting records who
and when. A ban signs the account out everywhere (sessions revoked) and
drops it from every running lobby or game (final, no rejoin). While a ban is
in effect the account cannot sign in, sign up again with the same Discord
account, play online, upload maps or use the relay.

**IP bans:** a single address or a CIDR range, IPv4 (`203.0.113.7`,
`203.0.113.0/24`) or IPv6 (`2001:db8::/48`; an IPv6 address without a prefix
bans its /64, the block one network uses, since devices rotate addresses
within it; write `/128` for a single address), stored
normalized (host bits cleared; IPv4-mapped IPv6 addresses count as IPv4),
with reason, expiry and author. Prefixes shorter than /8 (IPv4) or /16
(IPv6) are refused. Requests from a banned address get `403 ip_banned` on
sign-in, signup, every authenticated request, creating or joining online
sessions, map uploads and the relay; accounts seen from the range recently
are dropped from running games.

**IP history:** to make IP bans possible, the server keeps the last 20
addresses per account (raw, with first and last seen and a count), recorded
at sign-in, signup, and while signed in at most hourly or when the address
changes. Only admins can see
them (and the account itself, in the export). Entries not seen for 90 days
are deleted by a daily scheduled job, and all of them when the account is
purged. `/privacy.html` documents this.

## 7. Online play

### 7.1 The play gate (`/play`, `/play/*`)

The Worker runs first for `/play` and `/play/*` (wrangler.jsonc
`run_worker_first`) and serves every file there (the page, JavaScript modules
including the simulation worker and the protocol modules, CSS, wasm, shaders,
the editor) through Workers Static Assets only when the request may play:

- `gameRequiresAccount` off: everyone (no IP ban check, no pass).
- On: a session of an account that is active and not banned, from an address
  that is not banned. Admins and moderators with an active account also pass
  from a banned address. Pending, banned and deleted accounts never pass.

Refusals:

- A page load (`Sec-Fetch-Mode: navigate`; without Fetch Metadata, an
  `Accept` that includes `text/html`) of `GET` or `HEAD`: `302` to
  `/account/?returnTo=<path and query>`. The target is built from the request
  URL, only for `/play` paths, and checked like Discord's `returnTo` (one
  leading slash, at most 200 characters); anything else becomes `/play/`.
- Anything else: `401 unauthenticated` (no session), `403 account_inactive`,
  `banned` or `ip_banned`, as a JSON error without any game content.
- `503 misconfigured` when `IP_HASH_SALT` is missing outside local
  development (the pass key is derived from it).

Every gated response, served or refused, carries the static security headers
of `apps/website/_headers` (CSP, COOP, COEP `require-corp`, HSTS and the
rest), `Cross-Origin-Resource-Policy: same-origin` and `Vary: Cookie`. Served
files have `Cache-Control: private, max-age=0, must-revalidate` (browsers
revalidate with the ETag through the gate; shared caches never store them);
refusals and redirects `no-store`.

**Play pass.** After a successful D1 check the response sets the play pass
cookie (section 2.4): `1.<userId>.<sid>.<exp>.<mac>`, where `sid` is the first
16 hex digits of the session id hash, `exp` unix seconds (10 minutes ahead)
and `mac` HMAC-SHA256 (base64url) under a key derived with HKDF-SHA256 from
`IP_HASH_SALT` with the info `webra play pass v1`. Requests with a pass whose
MAC, version and expiry check out (WebCrypto, constant time) and whose `sid`
matches the request's session cookie are served without reading D1. A
missing, expired, invalid or foreign pass falls back to the D1 check, which
issues a new one; a refused request clears it.

**Revocation bound.** A pass is not re-checked against D1 while it is valid:
a ban, a status change, a session revoked from another device or an IP ban
stops game file loads within 10 minutes at most. Signing out, revoking the
current session and deleting the account clear the pass at once, and a pass
never works without its own session cookie. The IP ban list is read only on
the D1 path (one query), so a new IP ban has the same 10 minute bound.

**What stays public:** the website, `/api/*` as documented,
`/release-notes.json`, `/version.json`, and `/lib/`: the modules and
stylesheets the account and admin pages load (the account client, the
settings registry with the map editor helpers it uses, the protocol checks
and the shared controls; the exact list is computed by
`tools/shared-modules.mjs` at build time). Nothing that draws or runs the
game is under `/lib/`.

**Path spellings.** The gate matches the path after percent-decoding,
backslashes as slashes, dot and empty segments, `;params`, trailing dots and
case are normalized, so `/%70lay/`, `//play/`, `/PLAY/` or `/x/../play/`
are gated when they reach the Worker. Static Assets answers non-canonical
spellings that do not reach it with a redirect to the canonical, gated path
(docs/security.md, "The play gate").

### 7.2 Online sessions and map uploads

When `onlineRequiresAccount` is on, these need a signed-in, active account
that is not banned, from an address that is not banned:

- `POST /api/sessions` (create): `401 unauthenticated`, `403
  account_required`, `account_inactive`, `banned`, `ip_banned`.
- `POST /api/maps` (upload): the same. The uploader's account id is stored
  with the map.
- `POST /api/sessions/:id/map` (a host shares a map with its lobby) and
  `GET /api/sessions/:id/map` (a member downloads it): the same codes, plus
  the session's own check of the member key in `X-WebRA-Member`, which only
  works for the account it was issued to (`403 forbidden` otherwise; docs/
  contracts.md section 4, "Lobby maps"). The sharer's account id is stored
  with the map, which stays unlisted (not public).
- `POST /api/sessions/:id/resume` (the host resumes a saved online game): a
  signed-in account is always needed, also with the setting off (`403
  account_required`), and it must have played in the save (`403 forbidden`).
  Saving an online game needs every player signed in.
- `GET /api/sessions/:id/ws`: the upgrade always succeeds for a well-formed
  request from the site's origin; the server answers the first `hello` with
  `error` and closes when the connection may not play: codes
  `account_required` (no session), `account_inactive`, `banned`,
  `ip_banned`. With the setting off, anonymous connections play as before
  and IP bans still apply.

Protocol 5 (`PROTOCOL_VERSION`, docs/contracts.md section 4):

- `hello.name` is optional. A signed-in connection always plays under its
  username (a `name` it sends is ignored); an anonymous one must send `name`,
  which may not be the username of any account (compared after folding):
  `error invalid`.
- `welcome` gains `name` (the name the server gave this member).
- Human lobby slots and spectator entries gain `account: true` when the name
  comes from an account (clients may show a marker); anonymous members have
  no `account` field.
- An account can hold one place per session: a second connection of the same
  account is refused with `bad_state` (a rejoin with the rejoin key replaces
  the old connection as before). A rejoin must come from the same account as
  the original member (or anonymous for an anonymous member).
- New error codes: `account_required`, `account_inactive`, `banned`,
  `ip_banned`.

Protocol 6 keeps all of this. A member coming back into the lobby after a
rematch rejoins with its key from the same account too.

### 7.3 Content relay

`GET /api/content/ra-quickinstall` additionally needs (before the existing
checks): a signed-in account (`401 unauthenticated`) that is active (`403
account_inactive`, `banned`), an address that is not banned (`ip_banned`),
the `contentRelay` site setting on and either the `content_autoinstall` flag
or the admin role (`403 relay_forbidden`, message: "The one-click install is
not enabled for your account. Ask an admin, or install the files from your
own copy."). `GET` stays without the CSRF header (it is a download started by
the game page, with the existing `X-WebRA-Content: 1` header).

`GET /api/content/ra-scores` (the music from the freeware CDs, see
[contracts](contracts.md) section 4) has the same gate, in the same order,
before its own checks. Its daily budget of 256 MiB is counted per account
(the account id as a salted hash in the quota table), next to 64 requests
per network per hour.

Budgets of the package relay: 8 completed downloads per account per UTC
day, 20 completed downloads per network per hour (an IPv4 address or an
IPv6 /64), and requests whatever their outcome (never given back): 24 per
account per UTC day and 30 per network per hour. The music relay also
counts 96 requests per account per UTC day. Because these request counts
are never given back, they bound what one account can pull upstream a day
whatever it cancels: 24 packages (about 324 MB), 96 x 8 MiB = 768 MiB of
music. A transfer is completed once
every byte went out. `GET /api/content/ra-movies/allied` and `/soviet`
(the mission movies) have the same gate and their own budgets: 1,500 MiB
and 288 requests per account per UTC day, 192 requests per network per
hour; at most 288 x 8 MiB = 2,304 MiB of movies upstream per account a day. A
download (or a music piece) that does not complete is given back, so a
retry of a failed one is charged once. Every budget answers `429
rate_limited` with `Retry-After` (seconds) and the body
`{ "error": { "code": "rate_limited", "message", "retryAfter", "scope": "account" | "network" } }`;
clients show the time and never retry on their own. Admins see and reset
them per account (8.10).

## 8. Admin API (`/api/admin/*`)

Session required; the role rules of 2.3; `403 forbidden` otherwise. Every
change writes an audit log entry (8.9). Users in responses are `AdminUser`:

```json
{
  "id", "username", "displayName", "email", "emailVerified", "emailSetAt", "avatarColor",
  "role", "status", "storedStatus", "flags", "createdAt", "lastSeenAt",
  "approvedAt", "approvedBy", "deletedAt",
  "methods": { "password": true, "discord": { "id": "1234", "username": "tanya" } | null, "passkeys": 1 },
  "ban": { "id", "reason", "createdAt", "createdBy", "expiresAt" } | null
}
```

For moderators `email` is masked (`t***@example.com`) and `methods.discord.id`
is left out.

### 8.1 Users

`GET /api/admin/users?q=&status=&role=&flag=&sort=&order=&page=&limit=`

- `q`: matches username, display name or email (case-insensitive substring;
  moderators: username and display name only), at most 100 characters.
- `status`: one of the five statuses (`banned` means a ban in effect).
- `role`, `flag`: exact. `sort`: `created` (default), `lastSeen`, `username`.
  `order`: `desc` (default) or `asc`. `page` from 1, `limit` 1 to 100 (25).
- `200 { "users": [AdminUser], "total", "page", "limit" }`

`GET /api/admin/users/:id` -> `200`:

```json
{
  "user": AdminUser,
  "sessions": [{ "id", "deviceLabel", "userAgent", "createdAt", "lastUsedAt", "expiresAt" }],
  "passkeys": [{ "id", "name", "alg", "createdAt", "lastUsedAt", "counterError" }],
  "ips": [{ "ip": "203.0.113.7", "firstSeen", "lastSeen", "count" }],
  "bans": [{ "id", "reason", "createdAt", "createdBy", "expiresAt", "revokedAt", "revokedBy" }],
  "settings": { "version", "updatedAt", "settings" },
  "relay": RelayBudgets,
  "emailLink": { "purpose": "verify" | "change", "email", "sentAt", "expiresAt" } | null,
  "emailSending": true
}
```

Moderators get `user`, `bans` and `passkeys` count only (`sessions`, `ips`,
`settings`, `relay`, `emailLink`, `emailSending` are left out). `relay` is
described in 8.10. `emailLink` is the account's open verification or change
link (8.6); `emailSending` whether links can be sent now (`login.email`).
`emailSetAt` (AdminUser) is when the current address was set.

`PATCH /api/admin/users/:id` (admin)
`{ "username"?, "displayName"?, "email"?, "emailVerified"?, "avatarColor"?, "status"?, "role"?, "flags"? }`
-> `200 { user: AdminUser }`. `status` may be `pending_email`,
`pending_approval` or `active` (bans and deletion have their own endpoints).
`email: null` removes it; an address only claims its key when
`emailVerified` ends up true. Role changes and status changes away from
`active` revoke the target's sessions. Taking the last active, unbanned
admin out of service (status, role, ban, deletion) is `409 conflict`.

Staff routes need an **active** account with the role: pending or banned
staff have no powers (`403 account_inactive` or `banned`). Approval and
rejection follow the moderation rules (nobody on themselves; moderators only
on plain users).

### 8.2 Approval

- `POST /api/admin/users/:id/approve` `{}` (moderator) -> `200 { user }`;
  `pending_approval` or `pending_email` to `active` (`409 conflict` for other
  states).
- `POST /api/admin/users/:id/reject` `{ "reason"? }` (moderator) -> `200 { user }`;
  a pending account becomes `deleted`.

### 8.3 Account bans

- `POST /api/admin/users/:id/ban` `{ "reason": "...", "expiresAt": 0 | null }`
  (moderator; admins for moderators and admins; never self) ->
  `201 { "ban": {...}, "user": AdminUser }`. A new ban replaces one in effect.
- `DELETE /api/admin/users/:id/ban` -> `200 { user }` (lifts every ban in
  effect; `404` when there is none).

### 8.4 Sessions

- `POST /api/admin/users/:id/logout` `{}` (admin) -> `204`, revokes every
  session.
- `DELETE /api/admin/users/:id/sessions/:sessionId` (admin) -> `204`.

### 8.5 Deletion

- `DELETE /api/admin/users/:id` (admin) -> `200 { user }`: soft delete
  (status `deleted`, sessions revoked, dropped from games). Never self.
- `DELETE /api/admin/users/:id` and rejection give up the address and the
  Discord account like any soft deletion (2.2).
- `POST /api/admin/users/:id/restore` `{}` (admin) -> `200 { user, dropped }`:
  back to the status it had (`active` when unknown). Its verified address and
  its Discord account come back when still free; otherwise `dropped` names
  what did not: `emailVerified` (another account verified the address: it
  stays on the account, unverified) and `discord` (linked to another account
  now; `409 conflict` with `field: discord` instead when the account has no
  password or passkey to sign in with). The audit entry records `dropped`.
- `POST /api/admin/users/:id/purge` `{ "confirm": "<username>" }` (admin,
  only for `deleted` accounts) -> `204`: removes the account and everything
  stored about it now (maps it only shared with online sessions and the
  records of saved online games it played in included; maps it published
  stay, without the uploader). Audit entries about it keep
  the action, actor and time; their before and after values are replaced by
  `{ "purged": true }`.
  Soft-deleted accounts are purged automatically after 30 days.

### 8.6 Email verification and password reset link

For an account with an unverified address (not deleted; `409 conflict`
otherwise), admins can:

- `POST /api/admin/users/:id/email/resend` `{}` -> `202 { "sent": true, "notice": false, "emailLink" }`:
  mails a new verification link now, as in 4.3, not subject to the
  per-mailbox limit (the daily ceiling applies; `sent: false` then); 10 per
  day per account. `notice: true` when the address belongs to another
  verified account and got the in-use notice instead of a link. `503 unavailable` without email sending,
  `403 method_disabled` with `login.email` off. Audit `user.email_resend`
  (`after: { email, sent }`).
- `POST /api/admin/users/:id/email/verify` `{}` -> `200 { user: AdminUser }`:
  marks the address verified (the admin vouches for it, for example when
  mail cannot be sent): it claims the address, a `pending_email` account
  moves on as after its link (2.2), open verification and change links are
  removed. `409 conflict` (`field: email`) when another account verified the
  address. Audit `user.email_verify` (`before`/`after`: email, emailVerified,
  status). Works without email sending.

Moderators can do neither (`403 forbidden`); they can approve a
`pending_email` account (8.2).


`POST /api/admin/users/:id/password-reset` `{ "send": false }` (admin) ->
`201 { "url": "https://webra.sherin.dev/account/#reset=...", "expiresAt", "sent": false }`.
The link lives 24 hours. With `send: true` and email available, it is also
mailed to the account's email (`sent: true`). The audit entry records that
the link was displayed to the admin (`after.displayed: true`) and whether it
was sent; a new link replaces the previous one.

### 8.7 Settings documents

- `GET /api/admin/users/:id/settings` (admin) -> like 5.8, with `ETag`.
- `PUT /api/admin/users/:id/settings` (admin) with `If-Match` -> like 5.8.
  The audit entry stores the old and new documents.

### 8.8 IP bans (admin)

- `GET /api/admin/ip-bans?active=1&page=&limit=` ->
  `{ "bans": [{ "id", "cidr", "reason", "createdAt", "createdBy", "expiresAt", "active" }], "total", "page", "limit" }`
- `POST /api/admin/ip-bans` `{ "cidr", "reason", "expiresAt": 0 | null }` ->
  `201 { "ban" }` (`invalid` for malformed or too wide ranges; an admin
  cannot ban a range that contains the address of the request).
- `PATCH /api/admin/ip-bans/:id` `{ "reason"?, "expiresAt"? }` -> `200 { "ban" }`
- `DELETE /api/admin/ip-bans/:id` -> `204`

Expired IP bans are deleted 90 days after they end.

### 8.9 Site settings, audit log, stats

- `GET /api/admin/site` (admin) -> `200 { "settings": SiteSettings, "services": { "email", "discord" }, "effective": <GET /api/site body> }`
  with `ETag: "v<version>"`.
- `PATCH /api/admin/site` (admin) with `If-Match` and any subset of the
  settings (nested objects merge) -> `200` like `GET`. Unknown keys:
  `400 invalid`.
- `GET /api/admin/audit?actor=&target=&action=&since=&until=&page=&limit=`
  (admin) -> `{ "entries": [{ "id", "at", "actor": { "id", "username" } | null, "action", "target": { "type", "id", "label" }, "before", "after", "reason" }], "total", "page", "limit" }`.
  `actor` null is the system (scheduled purges and expiries). Actions: `user.update`,
  `user.approve`, `user.reject`, `user.ban`, `user.unban`, `user.logout`,
  `user.session_revoke`, `user.password_reset_link`, `user.delete`,
  `user.restore`, `user.purge`, `user.settings_update`,
  `user.relay_quota_reset`, `user.expire` (system: an unconfirmed signup
  expired, 2.2), `user.email_verify`, `user.email_resend`, `ipban.create`,
  `ipban.update`, `ipban.delete`, `site.update`. Entries are kept 365 days.
- `GET /api/admin/stats` (moderator) ->

```json
{
  "users": { "total": 0, "byStatus": { "pending_email": 0, "pending_approval": 0, "active": 0, "banned": 0, "deleted": 0 }, "byRole": { "user": 0, "moderator": 0, "admin": 0 }, "newLast7Days": 0 },
  "sessions": { "active": 0 },
  "games": { "lobbies": 0, "running": 0 },
  "maps": { "total": 0 },
  "bans": { "accounts": 0, "ips": 0 },
  "services": { "email": false, "discord": false },
  "email": { "sentToday": 0, "dailyLimit": 300, "limitReached": false }
}
```

`games` counts the public session directory (private lobbies are not listed
anywhere).

### 8.10 Relay budgets (admin)

What the account has used of the one-click relays' budgets (7.3), and what
the networks of its IP history seen in the last 24 hours have used (an IPv4
address or an IPv6 /64; other people on those networks count there too):

```json
{
  "account": {
    "content": { "used": 2, "limit": 8, "unit": "downloads", "resetsAt": 0 },
    "music": { "used": 40, "limit": 256, "unit": "MiB", "resetsAt": 0 },
    "contentAttempts": { "used": 3, "limit": 24, "unit": "requests", "resetsAt": 0 },
    "musicAttempts": { "used": 8, "limit": 96, "unit": "requests", "resetsAt": 0 },
    "movies": { "used": 0, "limit": 1500, "unit": "MiB", "resetsAt": 0 },
    "moviesAttempts": { "used": 0, "limit": 288, "unit": "requests", "resetsAt": 0 }
  },
  "networks": [
    {
      "network": "203.0.113.7",
      "lastSeen": 0,
      "content": { "used": 3, "limit": 20, "unit": "downloads", "resetsAt": 0 },
      "contentAttempts": { "used": 4, "limit": 30, "unit": "requests", "resetsAt": 0 },
      "music": { "used": 0, "limit": 64, "unit": "requests", "resetsAt": 0 },
      "movies": { "used": 0, "limit": 192, "unit": "requests", "resetsAt": 0 }
    }
  ]
}
```

It is part of `GET /api/admin/users/:id` (`relay`). `resetsAt` is when the
current window ends (unix milliseconds).

- `DELETE /api/admin/users/:id/relay-quota` (admin) clears the account's
  budgets and those of the networks listed -> `200 { "relay": RelayBudgets }`
  (all zero). The audit entry `user.relay_quota_reset` stores what was used
  before, without the addresses.

## 9. Rate limits

Per IP limits key on an HMAC of the address under the secret `IP_HASH_SALT`
(never the address). Burst limits go through the Workers Rate Limiting
binding `AUTH_LIMITER` (20 per minute per purpose and address, no D1
access); without the binding the D1 values in brackets apply. D1 counters
are read before they are written: a request already over its limit costs no
write.

| What | Limit |
|------|-------|
| Signup (all methods) | 10 per hour per network (IPv4 address, IPv6 /64) |
| Password sign-in | burst per IP (30 per 15 minutes); 10 failures per 15 minutes per account and IP; 100 failures per day per IP; escalating account delay (4.3) |
| Passkey sign-in and options | burst per IP (30 per 15 minutes) |
| Re-authentication | 10 failures per 15 minutes per account |
| Forgot password | 5 per hour per IP, 3 per hour per mailbox |
| Token redemption (verify, reset) | burst per IP (20 per 15 minutes) |
| Verification resend | 3 per hour and 10 per day per account; 10 per hour per network (IPv4 address, IPv6 /64) |
| Email change | 5 per day per account; 20 per day per network |
| Address mail (links and in-use notices, whoever asks) | 3 per hour and 6 per day per mailbox (4.3; over it nothing is sent, the answer is unchanged) |
| All account mail (links, notices, resets, admin mail) | `EMAIL_DAILY_LIMIT` per UTC day (default 300; over it nothing is sent until the next day, answers are unchanged, the admin stats show it) |
| Admin verification resend | 10 per day per account |
| Discord start | burst per IP (20 per 15 minutes) |
| Profile changes | 30 per hour per account |
| Settings document writes | 120 per hour per account |
| Data export | 5 per hour per account |
| One-click package relay | 8 completed downloads and 24 requests per account per UTC day; 20 completed downloads and 30 requests per network (IPv4 address, IPv6 /64) per hour (7.3) |
| One-click music relay | 256 MiB and 96 requests per account per UTC day; 64 requests per network per hour (7.3) |
| One-click movie relay | 1,500 MiB and 288 requests per account per UTC day; 192 requests per network per hour (7.3) |

## 10. Local development and bootstrap

- The first admin is made with `node tools/promote-admin.mjs <username>
  [--local | --remote]` (docs/deploy.md): it sets `role = 'admin'` and
  `status = 'active'` for an existing account through `wrangler d1 execute`.
- Local development runs `wrangler dev --local-upstream localhost:8799` so
  the request host stays `localhost` (docs/deploy.md).
- Under `wrangler dev` started with `--var WEBRA_DEV_ROUTES:1`, the test-only
  endpoint `POST /api/dev/promote` `{ "username", "role" }` does the same for
  the end-to-end test. It answers `404 not_found` unless that variable is
  `1` and the request is plain HTTP to `localhost`, `127.0.0.1` or `[::1]`.
  The variable is never in `wrangler.jsonc` (a test checks that), and tests
  prove the route is unreachable otherwise.
- With `--var WEBRA_DEV_MAIL:1` as well (same conditions, and no real
  `EMAIL` binding), account mail goes to an in-memory outbox instead of
  Email Service (email sending then counts as available), and
  `GET /api/dev/mail?to=<address>` (CSRF header) returns
  `{ "messages": [{ "from", "to", "subject", "text", "html", "at" }] }` for
  the end-to-end email test (`apps/server/test/e2e/email.mjs`, docs/deploy.md).
  Without it `wrangler dev` has no email: signup keeps addresses unverified.
