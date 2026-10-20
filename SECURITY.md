# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue, pull request or
discussion for a security problem, and do not post details in a lobby or
chat on the live site.

A useful report says:

- what is affected (a route, a protocol message, a page, a workflow);
- how to reproduce it, as small as possible (requests, messages, a map or
  replay file made for the test);
- what an attacker gains, and what they need first (an account, a role, a
  game with the victim);
- the version (`/version.json` on the site, or the commit).

## Scope

In scope:

- The Cloudflare Worker in `apps/server`: the HTTP API, accounts, sessions,
  roles and the admin API, email and Discord sign-in flows, the multiplayer
  sessions (Durable Objects), replays and online saves, map sharing, invite
  codes, friends, the content relay and the play gate.
- The protocol package (`packages/protocol`): validation of everything a
  client or server sends.
- The game client and website (`apps/game`, `apps/website`): XSS, CSP and
  header issues, files a player loads (maps, replays, saves, texture packs)
  that run code or crash other players.
- The engine (`engine`): crashes or desyncs that one player can cause in
  another player's game through orders, maps or rules.
- The GitHub Actions workflows in `.github/`.

Out of scope:

- Denial of service by volume against Cloudflare, and rate limits that work
  as documented in `docs/security.md`.
- What lockstep multiplayer cannot prevent by design (every peer simulates
  the whole game, so map hacks are possible): see "Inherent to lockstep" in
  `docs/security.md`.
- Reports from automated scanners without a demonstrated impact.
- The original game's files, which players load from their own copy.

Test against a local `wrangler dev` (see `docs/deploy.md`, "Local
development") rather than the live site. Never access other people's
accounts or data, and stop and report as soon as you see data that is not
yours.

## What to expect

- An acknowledgement within a week.
- An assessment (accepted or not, with the severity) after that, and
  updates while a fix is under way.
- A fix released through the normal release process, with a GitHub
  security advisory once it is deployed. You are credited in the advisory
  unless you ask not to be.

This is a hobby project maintained by one person: there is no bug bounty.

`docs/security.md` describes the threat model and the reviews done so far.
