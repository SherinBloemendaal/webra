# Deploying WebRA

WebRA runs at <https://webra.sherin.dev> as **one Cloudflare Worker** named
`webra` on the `WebRA` Cloudflare account. The same Worker serves the
website, the game, the HTTP API and the multiplayer sessions
([contracts](contracts.md), section 6).

## Hosting

| Path | Served by | Source |
|------|-----------|--------|
| `/`, `/maps.html`, `/multiplayer.html`, `/assets/*`, `/404.html`, `/version.json` | Workers static assets | `apps/website`, copied to `dist/` |
| `/play/*` | Workers static assets | `apps/game` with `pkg/` (wasm-pack) and `protocol/` (from `packages/protocol/src`), copied to `dist/play/` |
| `/api/*` | The Worker's fetch handler | `apps/server/src` |

Storage:

- **Durable Objects (SQLite)**: one object per multiplayer session (lobby,
  lockstep relay, password hash).
- **D1 database `webra`**: community maps, the public session directory,
  accounts, sign-in sessions, passkeys, bans, site settings and the audit log
  ([accounts API](accounts-api.md)). Schema changes live in
  `apps/server/migrations` and are applied on deploy.
- **Cron trigger** (`triggers.crons`, daily at 03:17 UTC): the accounts
  retention job (`apps/server/src/accounts/cron.js`): expired sessions, links
  and challenges, IP history after 90 days, accounts deleted more than 30
  days ago, audit entries after 365 days.

What `apps/server/wrangler.jsonc` (owned by the server code) has to provide for
this layout:

- `"name": "webra"` and the custom domain `webra.sherin.dev` (a `routes` entry
  with `"custom_domain": true`).
- `assets.directory` pointing at the repository's `dist/` (`"../../dist"`
  from `apps/server`), `run_worker_first` for `/api/*` so the API is never
  shadowed by a file, and `not_found_handling: "404-page"` so unknown paths get
  `dist/404.html`.
- The Durable Object binding with its SQLite migration, and the D1 binding for
  the database named `webra`.
- The daily cron trigger and the `DISCORD_CLIENT_ID` variable (see
  [Accounts](#accounts)).

## Build

```bash
npm ci
npm run build:wasm   # engine/ to apps/game/pkg (needs Rust, wasm32 target, wasm-pack)
npm run build        # assembles dist/
```

`npm run build` (`tools/build-dist.mjs`) empties `dist/` and then copies:

- `apps/website/*` (except `package.json`) to `dist/`
- `apps/game/` (except `tests/`, `package.json`, `node_modules` and dotfiles) to `dist/play/`
- `packages/protocol/src` to `dist/play/protocol/`
- writes `dist/version.json`: `{ version, commit, builtAt }`, version from the
  root `package.json`, commit from `git rev-parse HEAD`
- writes this build's error report settings into `js/telemetry/config.js`
  under `dist/play/` and `dist/lib/` and keeps the privacy notice's section
  that applies; with a DSN, bundles the error report SDK (`@sentry/browser`,
  `tools/vendor-sentry.mjs`) into `dist/play/vendor/sentry.js` and
  `dist/lib/vendor/sentry.js` with a source map (see Error reports below)

It stops with an error when `apps/game/pkg/webra_sim_bg.wasm` is missing, so a
deploy can never ship a game without its engine.

## Automatic deploys (GitHub Actions)

`.github/workflows/deploy.yml` runs on every push to `main` and on manual
dispatch (Actions, Deploy, Run workflow):

1. `ci`: the full CI (`ci.yml`, called as a reusable workflow, see
   [ci.md](ci.md)). Nothing deploys unless engine tests, rules sync, shader
   checks and web checks pass. On a release commit that only bumps versions
   the engine and shader jobs are skipped (they passed on the commit before);
   skipped jobs do not block the deploy, failed or cancelled ones do. CI's web
   job builds the engine (`npm run build:wasm`, with `WEBRA_GIT_HASH` set to
   the commit) and uploads `apps/game/pkg` as the artifact `webra-pkg` of
   the run.
2. `deploy` (GitHub environment `production`, a `small` runner): first checks
   that the commit is still the tip of `main` (`git ls-remote`; when that
   fails, the deploy fails, it never skips silently); when a newer
   commit has arrived meanwhile, every further step is skipped, the job
   succeeds and the newer commit's own run deploys. Otherwise it downloads
   `webra-pkg` of this run into `apps/game/pkg` (no Rust, no second wasm
   build), installs Node 22, runs `npm ci` and
   `npm run build` (with `WEBRA_ENV=production` and the error report
   variables, see Error reports),
   and from `apps/server`:
   - `npx wrangler d1 migrations apply webra --remote`, only when
     `apps/server/migrations` exists
   - creates the R2 bucket `webra-replays` (replays in accounts, binding
     `REPLAYS` in `wrangler.jsonc`) when it is missing: `wrangler r2 bucket
     info` first, `wrangler r2 bucket create` only when that fails, and an
     "already exists" answer counts as success, so the step changes nothing
     once the bucket exists. It runs before the deploy because a Worker
     cannot deploy with a binding to a missing bucket.
   - with the secret `SENTRY_AUTH_TOKEN`: create the Sentry release and upload
     the JavaScript sources and source maps (skipped without it)
   - `npx wrangler deploy` with the Worker's `SENTRY_*` variables
   - with `SENTRY_AUTH_TOKEN`: finalize the release and record the deploy in
     Sentry (skipped without it)

The CI of two pushes runs side by side; only the deploy job has the
concurrency group `deploy-production`, without cancelling: a newer push's
deploy job waits until the running deploy is done, so two deploys never
overlap. GitHub keeps one waiting job per group, so with three pushes in quick
succession the second one's waiting deploy job is cancelled (its run shows as
cancelled) and the third deploys; with the tip check above an older commit
never deploys after a newer one. Two manual runs of Deploy on `main` share
CI's concurrency group `ci-Deploy-refs/heads/main` (only pushes are grouped
per commit), so the second cancels the first one's CI and with it that run's
deploy; the second run deploys. Wrangler runs with `--no-install`, so it must be a pinned dependency
in the lockfile (a `devDependency` of `apps/server`), never a fresh download.

### Required GitHub secrets

Add these under Settings, Secrets and variables, Actions (repository secrets,
or secrets of the `production` environment):

| Secret | Value |
|--------|-------|
| `CLOUDFLARE_API_TOKEN` | An API token with the permissions below |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID of `WebRA` (dashboard, Workers and Pages, right sidebar) |

The deploy job fails early with a clear error when either one is missing.

### Cloudflare API token permissions

`tools/create-deploy-token.sh` creates this token from an existing token that
may create API tokens and stores it as the repository secret without ever
printing it. To do it by hand, create a **custom token** (My Profile, API
Tokens, Create Token, Custom token) with exactly these permissions:

| Scope | Resource | Permission |
|-------|----------|------------|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Account Settings | Read |
| Zone | Workers Routes | Edit |
| Zone | Zone | Read |
| Zone | DNS | Edit |

- Account resources: include only the `WebRA` account.
- Zone resources: include only the zone `sherin.dev`.
- DNS Edit is needed because wrangler creates the DNS record for the custom
  domain `webra.sherin.dev`.
- Leave client IP filtering empty (GitHub-hosted runners have no fixed IPs)
  and give the token an expiry date that you rotate.

## First-time setup

Done once, by hand, by someone with access to the Cloudflare account:

1. Create the D1 database and put its id into `apps/server/wrangler.jsonc`:

   ```bash
   cd apps/server
   npx wrangler login
   npx wrangler d1 create webra
   ```

2. Enable R2 on the account (dashboard, R2 Object Storage: accept the terms
   once; the free tier covers WebRA's replays). The deploy then creates the
   bucket `webra-replays` itself; by hand it is
   `npx wrangler r2 bucket create webra-replays`.
3. Make sure `webra.sherin.dev` has no existing DNS record that conflicts with
   the Worker custom domain (wrangler creates the record on the first deploy).
4. Create the GitHub environment `production` (Settings, Environments) and add
   the two secrets. Optionally add required reviewers to gate deploys.

## Manual deploy

From a clean checkout of `main`, with Rust, the wasm32 target, wasm-pack and
Node 22 installed:

```bash
npm ci
WEBRA_GIT_HASH=$(git rev-parse HEAD) npm run build:wasm
WEBRA_ENV=production npm run build   # add SENTRY_DSN=<dsn> once error reports are turned on
cd apps/server
npx wrangler login            # or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
# The d1 commands ignore account_id in wrangler.jsonc; with a login that sees
# several accounts they need it in the environment.
export CLOUDFLARE_ACCOUNT_ID=6a1cde1074a1925835edfca0f807efb5
npx wrangler d1 migrations apply webra --remote   # only when apps/server/migrations exists
npx wrangler r2 bucket info webra-replays || npx wrangler r2 bucket create webra-replays
npx wrangler deploy $(WEBRA_ENV=production node ../../tools/sentry-config.mjs worker-vars)
```

Then check <https://webra.sherin.dev/version.json> for the deployed commit and
<https://webra.sherin.dev/api/version> for the API. The end-to-end smoke test
runs only against a local `wrangler dev` (see Local development): it creates
its admin through a test-only route that exists only there, and online play
needs approved accounts.

### Rolling back

```bash
cd apps/server
npx wrangler deployments list
npx wrangler rollback <version-id>
```

A rollback restores the Worker code and its assets, but not the D1 schema:
write migrations so that the previous Worker version still works with them.

A rollback across the Durable Object migration `v2` (the realtime hub
`UserHub`, docs/accounts-api.md 5.12) is fine: the class stays defined, the
hub stores only an event counter, and pages fall back to polling when the
upgrade fails. To switch the realtime channel off without a deploy, turn off
"Live updates" in the admin site settings. New page loads poll at once; pages
that already hold a socket keep it but hear nothing, and fall back to their
normal polls once no hint has arrived for `REALTIME_FRESH_MS` (10 minutes):
the friends lists poll every 30 s again within 15 minutes at most (one
5 minute safety poll may still be armed); the waiting card and the admin
waiting list check every minute regardless.

## Local development

- Site and game without the API: `npm run build`, then
  `python3 -m http.server 8080 --directory dist` and open
  <http://localhost:8080/>. The maps and multiplayer pages show a notice that
  the API is unavailable. There is no play gate there: the game is open.
- Everything, including the API and Durable Objects: `npm run build`, then
  from `apps/server`:

  ```bash
  npx wrangler d1 migrations apply webra --local
  npx wrangler dev --port 8799 --local-upstream localhost:8799
  ```

  `--local-upstream` keeps the request host `localhost`. Without it wrangler
  dev presents every request as `webra.sherin.dev`: the session cookie then
  gets `Secure` and the `__Host-` prefix (browsers refuse it over plain HTTP)
  and passkeys are unavailable. Open <http://localhost:8799/> (passkeys need
  `localhost`, not `127.0.0.1`). Local development needs no `IP_HASH_SALT`
  (plain HTTP to localhost uses a fixed development key, also for the play
  pass). The play gate is on here too: sign up, make the account an admin
  (`node tools/promote-admin.mjs <username> --local`) or switch
  "The game needs an account" off in the admin dashboard to load `/play/`.
  In production the gate needs `IP_HASH_SALT`; without it `/play` answers 503.
  Replays in accounts work here too: wrangler dev gives the `REPLAYS`
  binding a local bucket (kept under `.wrangler/state`, never the real one),
  so nothing has to be created for it. The server tests use an in-memory
  stand-in (`apps/server/test/fake-r2.mjs`).
- End-to-end smoke test: start wrangler dev as above with
  `--var WEBRA_DEV_ROUTES:1` added, then `node test/e2e/smoke.mjs
  http://localhost:8799`. The variable enables the test-only
  `POST /api/dev/promote` route, which also requires plain HTTP to a local
  host; it is never in `wrangler.jsonc` and never set for deploys.

## Accounts

Everything below is optional except the first admin; without it the site
works with password and passkey sign-in, and email and Discord are reported
unavailable (`GET /api/site`, the admin stats).

### First admin

1. Sign up on the site (or on local wrangler dev) with the username you want.
2. Run, from the repository root:

   ```bash
   # local wrangler dev database
   node tools/promote-admin.mjs <username> --local
   # production (asks for nothing else; the confirmation must repeat the name)
   export CLOUDFLARE_ACCOUNT_ID=6a1cde1074a1925835edfca0f807efb5
   node tools/promote-admin.mjs <username> --remote --confirm <username>
   ```

   It sets the role `admin` and the status `active`, signs that account out
   (sign in again) and writes an audit entry. `--role moderator` makes a
   moderator instead. No personal data goes into the repository. Further
   admins and moderators are made in the admin API.

New sites start as a closed beta: registration open, approval required,
email verification required (in effect only once email works), every login
method on, online play requires an account. Change this in the admin site
settings.

### Variables and secrets

| Name | Kind | Purpose |
|------|------|---------|
| `DISCORD_CLIENT_ID` | variable in `wrangler.jsonc` | Discord application id (public); empty means Discord is unavailable |
| `DISCORD_CLIENT_SECRET` | secret | Discord application secret |
| `PASSWORD_PEPPER` | secret, optional | At least 16 characters; HMAC key applied to passwords before PBKDF2 |
| `IP_HASH_SALT` | secret, **required** | At least 16 random characters; HMAC key for every stored address hash (sessions, rate limits). Without it the Worker answers `503 misconfigured` to anything that would store one (only plain HTTP to localhost uses a fixed development key) |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE` | variables in `wrangler.jsonc` (empty DSN: off), set by the deploy | Error reports of the Worker (see Error reports) |
| `EMAIL_FROM` | repository variable, passed by the deploy (absent locally) | Sender of account mail; set, the deploy also adds the `send_email` binding `EMAIL` (see Email). Unset: no email |
| `SITE_ORIGIN` | variable in `wrangler.jsonc` | Where links in account mail point (`https://webra.sherin.dev`); `wrangler dev` links to its own local address |
| `EMAIL_DAILY_LIMIT` | variable in `wrangler.jsonc` | Most account mails per UTC day, whoever asks (default 300, 1 to 100,000); over it nothing is sent until the next day and the admin overview warns |
| `PASSWORD_ITERATIONS` | variable in `wrangler.jsonc` (100,000 since 0.15.0, on the Workers Paid plan) | PBKDF2 iterations for new hashes, 10,000 to 100,000 (code default 40,000). CPU ceiling: one derivation must fit well inside the Free plan's 10 ms per request; keep it at or below 50,000 on the Free plan, 100,000 is fine on the Paid plan |

Secrets are set by the owner, never committed:

```bash
cd apps/server
openssl rand -base64 32 | npx wrangler secret put IP_HASH_SALT   # required, before the first deploy
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put PASSWORD_PEPPER      # optional
```

Notes:

- **Pepper:** once set, never change or remove it. Each hash records whether
  it was peppered; hashes made before the pepper keep working and are
  upgraded at the next sign-in, but peppered hashes cannot be checked without
  it (those accounts would need a reset link).
- **Iterations:** no request derives more than one key (a sign-in that also
  rehashed would need two). Raising `PASSWORD_ITERATIONS` (for example to
  100,000 on the Workers Paid plan) applies to new hashes and to each
  account's hash the next time its password is set (change or reset).
  Measured under workerd (Apple M-series): 40,000 iterations 2.8 ms, 50,000
  3.6 ms, 60,000 4.2 ms, 100,000 7.2 ms per derivation; edge machines can be
  up to about twice as slow.
- **IP_HASH_SALT:** changing it makes existing rate limit counters and
  session address hashes meaningless (harmless; they expire), it never locks
  anyone out.

### Content relays

`/api/content/ra-quickinstall` (OpenRA's package) and `/api/content/ra-scores`
(the music, read by range out of the freeware CD images on the Internet
Archive) need no binding or secret beyond `IP_HASH_SALT` and the D1 quota
table; both follow the `contentRelay` site setting (admin page) and the
`content_autoinstall` account flag. The music relay makes at most four
upstream requests per call, eight with the archive's redirect (the Free
plan allows 50 subrequests), passes the body through as a stream (no
buffering, little CPU), and writes two quota rows per 8 MiB piece (16 per
full download). The package relay writes three quota rows per download
(attempts, network, account) and two more when it gives an unfinished
download back; that refund runs under `waitUntil` after the stream ends.
Admins reset a player's relay budgets on the admin page (user drawer,
"One-click relay budgets"). If the archive moves or changes the images, the relay
answers 502 (the pinned size and `Content-Range` no longer match) and
players can still install from a CD image themselves; new pins are measured
as described in docs/security.md and changed in both
`apps/server/src/cdmusic.js` and `apps/game/js/content/cdmusic.js`.

### Rate limiting and D1 writes

The D1 Free plan allows 100,000 row writes a day, so floods must not turn
into writes:

- `wrangler.jsonc` binds the Workers Rate Limiting API twice (`ratelimits`,
  per minute, purpose and address): `AUTH_LIMITER` (60) for the sign-in,
  passkey, token, Discord and invite lookup endpoints, and `APP_LIMITER`
  (600) for presence, the friends list, realtime and session sockets (many
  players behind one NAT): those checks never touch D1. Without a binding (for example if the account's plan rejects it:
  remove the `ratelimits` entry and redeploy) the Worker falls back to D1
  counters that are read before they are written, so refused requests still
  cost no write.
- Recommended in addition, a Cloudflare WAF rate limiting rule on the zone
  `sherin.dev` (Security, WAF, Rate limiting rules; the Free plan includes
  one rule): expression `(http.host eq "webra.sherin.dev" and
  starts_with(http.request.uri.path, "/api/auth/"))`, counting characteristic
  IP, 30 requests per 10 seconds, action Block for 10 seconds. It stops
  floods before they reach the Worker at all.

### Discord

1. Create an application at <https://discord.com/developers/applications>.
2. OAuth2: add the redirect `https://webra.sherin.dev/api/auth/discord/callback`
   (and `http://localhost:8799/api/auth/discord/callback` for local tests).
   The Worker requests the scopes `identify email` with PKCE.
3. Put the application id into `vars.DISCORD_CLIENT_ID` in
   `apps/server/wrangler.jsonc` (commit) and set the secret
   `DISCORD_CLIENT_SECRET` as above.

### Email (needs the Workers Paid plan)

Every new account gives an email address. Verification links (and password
reset links) are sent with Cloudflare Email Service (Email Sending) through
the Workers `send_email` binding `EMAIL`, from the address in the variable
`EMAIL_FROM`. Sending to arbitrary recipients needs the Workers Paid plan
(3,000 emails a month included, then $0.35 per 1,000), and a `send_email`
binding in `wrangler.jsonc` would break deploys and `wrangler dev` before
that, so the binding is not committed: the deploy workflow adds it, and the
variable, only when the repository variable `EMAIL_FROM` is set
(`tools/email-config.mjs` writes `apps/server/wrangler.deploy.jsonc`, the
committed configuration plus the binding restricted to that one sender, and
deploys with it). Until then the Worker reports email as unavailable: signup
still requires an address but keeps it unverified, there is no verification
step, the account page says that verification email is not available yet,
and admins can mark addresses verified by hand.

To enable it (owner, in this order):

1. Upgrade the Cloudflare account to the **Workers Paid** plan.
2. Dashboard: Compute, Email Service, Email Sending, **Onboard Domain**, and
   pick the sending domain. A subdomain keeps account mail apart from other
   mail of `sherin.dev`: onboard `webra.sherin.dev` (Email Sending treats a
   subdomain as its own sending domain) and use
   `noreply@webra.sherin.dev`; onboarding `sherin.dev` itself works too.
   Cloudflare adds the records itself (the zone must be on Cloudflare DNS):
   - on the `cf-bounce` subdomain of the sending domain: MX records (bounces
     back to Cloudflare), the SPF TXT record
     `v=spf1 include:_spf.mx.cloudflare.net ~all`, and the DKIM TXT record
     (selector `cf-bounce._domainkey`);
   - a DMARC TXT record on `_dmarc.<sending domain>`.
   Review them against existing mail records of the zone (an existing DMARC
   record stays: merge rather than duplicate). Wait until the domain shows
   as verified; sends from an unverified domain fail with
   `E_SENDER_NOT_VERIFIED`.
3. GitHub: add the repository variable (Settings, Secrets and variables,
   Actions, Variables) `EMAIL_FROM` = `noreply@webra.sherin.dev` (an address
   on the onboarded domain; it is not a secret). Nothing in the repository
   changes.
4. Deploy (push to main or run the workflow). The step "Deploy the Worker"
   then runs `wrangler deploy --config wrangler.deploy.jsonc --var
   EMAIL_FROM:...`. `GET /api/site` reports `services.email: true`; with the
   site setting "Email verification required" on (the default), new signups
   start as `pending_email` until they follow their link (24 hours; they can
   ask for a new one), and signups that never confirm expire after 7 days.
   Existing accounts keep their status; accounts with an unverified address
   can confirm it from their account page, accounts without an address keep
   working and can add one.

The daily ceiling `EMAIL_DAILY_LIMIT` (300 in `wrangler.jsonc`) keeps a
flood of requests from running up the bill: the admin overview shows the
day's count and warns once it is reached; raise it in `wrangler.jsonc` when
real use needs more. The Worker serves only `webra.sherin.dev`
(`workers_dev` and `preview_urls` are off), and mail links always point at
`SITE_ORIGIN`.

To switch email off again, delete the repository variable and deploy.
Delivery problems show in the dashboard (Email Sending logs) and as
"email send failed: E_..." errors of the Worker (the error code only, never
the address). New accounts start with a conservative daily sending limit
that Cloudflare raises with good deliverability (`E_DAILY_LIMIT_EXCEEDED`
until then); signups are never refused because a mail failed.

Under `wrangler dev` there is no email: signup keeps addresses unverified.
The end-to-end email test uses the development outbox instead of Email
Service (its own database directory, because signups are rate limited per
address):

```bash
cd apps/server
npx wrangler d1 migrations apply webra --local --persist-to /tmp/webra-email-e2e
npx wrangler dev --port 8798 --local-upstream localhost:8798 --persist-to /tmp/webra-email-e2e \
  --var WEBRA_DEV_ROUTES:1 --var WEBRA_DEV_MAIL:1
node test/e2e/email.mjs http://localhost:8798
```

### Retention job

The cron trigger runs `apps/server/src/accounts/cron.js` once a day. To run
it locally: `npx wrangler dev --test-scheduled`, then
`curl "http://localhost:8787/__scheduled?cron=17+3+*+*+*"`.

## Error reports

The game, the map editor, the website and the Worker can report errors to the
self-hosted Sentry at <https://sentry.vitrion.dev> (what a report holds and
what it never holds: docs/security.md, "Error reports", and the privacy
notice). Reporting is **opt-in for the operator**: no DSN is built in, and
until the repository variable `SENTRY_DSN` is set, deploys bundle no DSN, the
browser never loads the SDK, the Worker's wrapper does nothing, and the
privacy notice says "Error reporting is currently off". Once it is on,
players switch reports off for their browser in the game's Settings
(Privacy) or on the privacy page.

### Turning error reports on

In this order (the privacy notice describes the project settings of step 1
as soon as step 2 is deployed):

1. In Sentry (sentry.vitrion.dev), project settings of the WebRA project (id
   121), Security & Privacy:
   - turn **"Prevent Storing of IP Addresses"** on;
   - set the **event retention to 90 days** (the privacy notice says so; on
     self-hosted Sentry this is `SENTRY_EVENT_RETENTION_DAYS=90`);
   - keep the default data scrubbers on (recommended).
2. In GitHub (Settings, Secrets and variables, Actions, Variables): add the
   repository variable `SENTRY_DSN` with the project's DSN:

   ```
   https://<public key>@sentry.vitrion.dev/121
   ```

   The next deploy builds the game and the website with it and passes it to
   the Worker. Optional variables: `SENTRY_ENVIRONMENT` (default
   `production`) and `SENTRY_TRACES_SAMPLE_RATE` (default `0.005`).
3. Optional, for releases, source files and deploy markers: see below.

To turn reporting off again, delete the variable (or set it to `off`) and
deploy.

Configuration (`tools/sentry-config.mjs`), from the environment of `npm run
build` and, for the Worker, passed by the deploy workflow as `--var`:

| Name | Default | Purpose |
|------|---------|---------|
| `SENTRY_DSN` | none: nothing is reported | Where reports go (a public client key, not a secret). `off` is the same as unset. A DSN for another host needs that host in the CSP `connect-src` (`apps/website/_headers` and `apps/server/src/static-headers.js`), or the build stops |
| `SENTRY_ENVIRONMENT` | `production` in production builds (`WEBRA_ENV=production`), else `dev` | The Sentry environment |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.005` | Share of page loads and Worker requests sent as performance traces (0 to 1); Durable Object alarms and WebSocket messages are never traced |

Local builds, `wrangler dev` (`SENTRY_DSN` is empty in `wrangler.jsonc`)
and the tests report nothing. To try reports locally, build with
`SENTRY_DSN=<a DSN of a test project>` and start wrangler dev with
`--var SENTRY_DSN:<that DSN>`.

The release is `webra@<version>+<commit>`, the build id of
`dist/version.json` (`node tools/sentry-config.mjs release`); the game, the
website and the Worker report the same one.

### Releases, source files and deploy markers

Optional, after reports are on. They need an auth token, which the owner
creates and stores; never paste it anywhere else:

1. In Sentry (sentry.vitrion.dev): Settings, Developer Settings (or
   Organization Tokens), create an **organization auth token** (scopes
   `project:releases` and `org:read` suffice).
2. In GitHub (Settings, Secrets and variables, Actions): add the secret
   `SENTRY_AUTH_TOKEN` (repository or `production` environment) and the
   variables `SENTRY_ORG` (the organization slug) and `SENTRY_PROJECT` (the
   project slug of the DSN's project, id 121). `SENTRY_URL` is optional
   (default `https://sentry.vitrion.dev`).

With the token, each deploy creates the release, uploads every `.js` and
`.map` under `dist/` by its URL path (`~/play/js/main.js`, the SDK with its
source map; the game's own modules are not bundled, so they are their own
sources), finalizes it and records a deploy for the environment. Without the
token those steps print a notice and are skipped; with the token but without
`SENTRY_ORG` or `SENTRY_PROJECT` the deploy fails with an error.

Reports carry no addresses and tell Sentry not to infer them (`infer_ip:
never`, browser and Worker); "Prevent Storing of IP Addresses" is the guard
on the server's side.

## Turning automatic deploys on

The deploy job only runs when the repository variable `DEPLOY_ENABLED` is
`true` (Settings, Secrets and variables, Actions, Variables). Set it after the
two secrets above exist, so pushes before hosting is ready do not fail.
