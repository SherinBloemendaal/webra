# Launch checklist

What to do before, during and after a public announcement (a post that may
bring 1,000 to 10,000 players in a day). Every switch below is in the admin
dashboard (`/admin.html`, tab Site settings) unless it says otherwise; a
change there applies at once on the server that saved it and within 30
seconds everywhere (the play gate caches the settings that long; session
creation reads them fresh).

## 1. Site settings for the launch (do these first)

| Setting (admin, Site settings) | For the launch | Why | To undo |
|------|------|------|------|
| Registration: "Approval required (closed beta)" | **off** | New accounts are active at once; nobody waits for an admin. | Switch it on again. New signups then wait in "Waiting for approval"; accounts created meanwhile stay active. |
| Registration: "Email verification required" | **off** | No signup waits for a mail, and no mail goes out at signup at all (so a burst of signups cannot use up `EMAIL_DAILY_LIMIT`, which password resets need). Players confirm their address later from their account page; only confirmed addresses get reset links. | Switch it on again. New signups then get their link at once and wait in `pending_email`; accounts created meanwhile stay active with an unconfirmed address. |
| Play: "The game needs an account" | **off** | Anyone can load `/play` and play skirmish or missions against the AI without an account. | Switch it on again. Within 30 seconds the game is served only to active accounts; open pages keep running, a reload asks to sign in. |
| Play: "Online play needs an account" | **stays on** | Online lobbies and games need an active account (names, bans and abuse handling depend on it). The online screen says so with Sign in and Create an account. | (No change.) |

Before switching approval off, approve the accounts that are already
waiting: Overview, **Approve all pending** (admins; 100 per call, the button
repeats until none are left; banned accounts and accounts still waiting for
their email are left alone, approve those one by one from Users if wanted).
Accounts that were waiting for their email when verification goes off stay
in `pending_email`: approve them from Users (filter "Email not verified").

## 2. Before posting

1. Deploy the release with these launch changes and check
   <https://webra.sherin.dev/version.json> and `/api/version`.
2. Site settings: Registration open on, "New online games" on, Live updates
   on, the three switches of section 1 as listed. Set the Message of the day
   (shown on the game's start screen and the account page), for example how
   to report bugs.
3. Error reports: the repository variable `SENTRY_TRACES_SAMPLE_RATE`
   overrides the default (0.005, docs/deploy.md). Delete it, or set it to
   `0.005` or lower, before the deploy. Durable Object alarms and WebSocket
   messages are never traced; each page sends at most 3 reports of one error
   and 10 a minute. Check that `sentry.vitrion.dev` has room (disk, rate
   limits per project) for a few thousand events.
4. Mail: `EMAIL_DAILY_LIMIT` is 5000 in `apps/server/wrangler.jsonc`. Check
   that the account's Email Sending quota allows that many a day; lower the
   variable if not. The admin overview warns at the top from 80% and alerts
   at the limit.
5. Logs: Workers Logs keep one request in ten (`observability.head_sampling_rate`
   0.1 in `wrangler.jsonc`), so the daily log allowance lasts the event.
6. Rate limits: two Workers Rate Limiting bindings, `AUTH_LIMITER` (sign-in,
   60 a minute per address and purpose) and `APP_LIMITER` (presence, friends,
   realtime and session sockets, 600 a minute), and 40 signups per hour per
   network (docs/accounts-api.md section 9). Optionally add the WAF rule of
   docs/deploy.md "Rate limiting and D1 writes".

## 3. During the event: what to watch

- Admin dashboard, Overview: signed-in sessions, open lobbies, running games,
  new accounts, the mail budget line (warning from 80%).
- Cloudflare dashboard, Workers & Pages, `webra`: requests, errors (5xx),
  CPU time, and Workers Logs (sampled 1 in 10); Durable Objects (requests,
  duration, active WebSockets); D1 `webra` metrics (rows read and written,
  query duration: D1 is one writer); R2 `webra-replays` operations; Email
  Sending (sent, bounces, quota).
- Sentry (`sentry.vitrion.dev`): new issues per release, event volume.
- The site's own counter: `/api/online` (players, lobbies, games).

## 4. Kill switches (no deploy needed)

| Switch (admin, Site settings) | Effect |
|------|------|
| Play: "New online games" off | Nobody can host a new online game (the game shows "New online games are paused for a moment..."; `POST /api/sessions` answers `503 sessions_closed`). Lobbies and games already running go on, players can still join existing lobbies. Applies at once. |
| Play: "Live updates" off | The realtime channel stops; pages poll instead (docs/deploy.md, Rolling back). |
| Registration: "Registration open" off | No new accounts (every method). |
| Play: "One-click content relay" off | The content relay (game files, music and movies streamed from the freeware mirrors) stops for everyone. |
| Play: "The game needs an account" on | Only active accounts load the game (within 30 seconds). |
| Message of the day | Tell players what is going on (start screen and account page). |

Abuse: ban an account or an address range (Users, IP bans); a banned
address cannot play, sign up or sign in.

## 5. No deploys while games run

**A deploy ends every running online game and lobby**: it restarts the
Durable Objects, so every session's WebSocket closes (docs/deploy.md). The
same holds for a rollback. Skirmish and missions in open tabs keep running
(they run in the browser), but a reload loads the new version.

When a fix cannot wait:

1. Set the Message of the day ("A short update follows in a few minutes;
   online games end then").
2. Switch "New online games" off and wait until the Overview shows no
   running games (or until the remaining ones may be ended).
3. Deploy (push to `main`; CI and deploy take about 11 minutes) or roll back
   (below).
4. Check `/version.json`, switch "New online games" on, clear the message.

Game files are cached by browsers for at most 10 minutes, only while the
browser's cookies stay the same (a renewed play pass or a new sign-in fetches
them again), and only for the build they came with (docs/security.md, "The play gate"), so after a deploy
a page reload always gets matching files.

## 6. Rollback

```bash
cd apps/server
npx wrangler deployments list
npx wrangler rollback <version-id>
```

A rollback restores the Worker and its assets, not D1 (docs/deploy.md,
"Rolling back"); it also ends running online games. The launch changes add
no D1 migration. An older Worker does not know the setting "New online
games" (it reads as on); saving the site settings from an older admin page
drops it, which also reads as on.

## 7. After the event

- Decide whether approval and email verification come back on (section 1,
  "To undo"). With verification off, players without a confirmed address
  cannot reset their password; the account page offers "Send verification
  link".
- `EMAIL_DAILY_LIMIT` and the trace rate can stay; lower them in
  `wrangler.jsonc` if the bill or the Sentry volume asks for it.
