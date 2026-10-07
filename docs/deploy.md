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
- **D1 database `webra`**: community maps and the public session directory.
  Schema changes live in `apps/server/migrations` and are applied on deploy.

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

It stops with an error when `apps/game/pkg/webra_sim_bg.wasm` is missing, so a
deploy can never ship a game without its engine.

## Automatic deploys (GitHub Actions)

`.github/workflows/deploy.yml` runs on every push to `main` and on manual
dispatch (Actions, Deploy, Run workflow):

1. `ci`: the full CI (`ci.yml`, called as a reusable workflow). Nothing deploys
   unless engine tests, rules sync, shader checks and web checks pass.
2. `deploy` (GitHub environment `production`): installs Rust with the
   `wasm32-unknown-unknown` target, wasm-pack and Node 22, then `npm ci`,
   `npm run build:wasm` (with `WEBRA_GIT_HASH` set to the commit),
   `npm run build`, and from `apps/server`:
   - `npx wrangler d1 migrations apply webra --remote`, only when
     `apps/server/migrations` exists
   - `npx wrangler deploy`

Deploys share the concurrency group `deploy-production` without cancelling:
a newer push waits until the running deploy is done, so two deploys never
overlap. Wrangler runs with `--no-install`, so it must be a pinned dependency
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

2. Make sure `webra.sherin.dev` has no existing DNS record that conflicts with
   the Worker custom domain (wrangler creates the record on the first deploy).
3. Create the GitHub environment `production` (Settings, Environments) and add
   the two secrets. Optionally add required reviewers to gate deploys.

## Manual deploy

From a clean checkout of `main`, with Rust, the wasm32 target, wasm-pack and
Node 22 installed:

```bash
npm ci
WEBRA_GIT_HASH=$(git rev-parse HEAD) npm run build:wasm
npm run build
cd apps/server
npx wrangler login            # or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
# The d1 commands ignore account_id in wrangler.jsonc; with a login that sees
# several accounts they need it in the environment.
export CLOUDFLARE_ACCOUNT_ID=6a1cde1074a1925835edfca0f807efb5
npx wrangler d1 migrations apply webra --remote   # only when apps/server/migrations exists
npx wrangler deploy
```

Then check <https://webra.sherin.dev/version.json> for the deployed commit and
<https://webra.sherin.dev/api/version> for the API. The end-to-end smoke test
also runs against the live site (`node test/e2e/smoke.mjs
https://webra.sherin.dev` in `apps/server`); it uploads maps named
`Smoke <timestamp>` by `Tester`, so delete those from the `maps` table
afterwards.

### Rolling back

```bash
cd apps/server
npx wrangler deployments list
npx wrangler rollback <version-id>
```

A rollback restores the Worker code and its assets, but not the D1 schema:
write migrations so that the previous Worker version still works with them.

## Local development

- Site and game without the API: `npm run build`, then
  `python3 -m http.server 8080 --directory dist` and open
  <http://localhost:8080/>. The maps and multiplayer pages show a notice that
  the API is unavailable.
- Everything, including the API and Durable Objects: `npm run build`, then
  `npx wrangler dev` from `apps/server` (local D1 and Durable Objects).

## Turning automatic deploys on

The deploy job only runs when the repository variable `DEPLOY_ENABLED` is
`true` (Settings, Secrets and variables, Actions, Variables). Set it after the
two secrets above exist, so pushes before hosting is ready do not fail.
