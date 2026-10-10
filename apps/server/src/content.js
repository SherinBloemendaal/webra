// GET /api/content/ra-quickinstall: the original Red Alert files for the
// game's one-click install (apps/game/js/content). These are Electronic
// Arts' files (Red Alert, released as freeware in 2008), packaged by OpenRA
// as ra-quickinstall.zip and hosted on OpenRA's community mirrors. The
// Worker relays one mirror's response to the player as a stream:
//
// - nothing is stored or cached: no Cache API, no KV, R2 or D1 for the
//   content, `cache: 'no-store'` on the upstream fetch (Cloudflare's cache
//   is bypassed) and `Cache-Control: no-store` on the response;
// - only a response of exactly the known size (Content-Length) is relayed,
//   and the stream is cut off if it runs longer;
// - same-origin requests only (the game's own page), only for a signed-in,
//   active account with the content_autoinstall flag or the admin role
//   (accounts/play.js requireRelay, checked in index.js), and a time limit
//   per mirror and for the whole transfer;
// - budgets in the D1 quota table (keys are salted hashes, IPs never
//   logged) that count completed downloads, not attempts:
//   CONTENT_ACCOUNT_LIMIT per account per UTC day and CONTENT_NET_LIMIT per
//   network (an IPv4 address or an IPv6 /64, accounts/ip.js networkOf) per
//   hour. A download is charged when it starts and given back when it does
//   not complete (no mirror answered, the transfer broke off, the player
//   cancelled), so a retry of a failed download is never charged twice.
//   CONTENT_NET_ATTEMPTS requests per network per hour are a ceiling on
//   attempts of any outcome (never given back) against start and cancel
//   loops. A request over a budget costs no upstream fetch.
// docs/security.md and docs/contracts.md section 4 describe the route.

import { HttpError } from './http.js';
import { ipSalt } from './ipkey.js';
import { networkOf } from './accounts/ip.js';
import { peekQuota, refundQuota, takeQuota } from './quota.js';

/** OpenRA's quick install mirrors (mods/ra/installer), tried in this order. */
export const QUICKINSTALL_MIRRORS = Object.freeze([
  'https://openra.baxxster.no/openra/ra-quickinstall.zip',
  'https://republic.community/hosted/files/command-and-conquer/openra/ra-quickinstall.zip',
  'https://openra.0x47.net/ra-quickinstall.zip',
  'https://openra.ppmsite.com/ra-quickinstall.zip',
]);
export const QUICKINSTALL_BYTES = 13_502_031;
/**
 * Completed downloads per account and UTC day. A player needs one per
 * browser and device (the game keeps the ZIP, so updates need none): eight
 * cover a desktop, a laptop, a phone and a tablet twice over, and cap an
 * account at about 108 MB of mirror traffic a day.
 */
export const CONTENT_ACCOUNT_LIMIT = 8;
export const CONTENT_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Completed downloads per network and hour: a household or a LAN party
 * behind one address (ten flagged players with two devices each) fits; one
 * network cannot pull more than about 270 MB an hour through the relay.
 */
export const CONTENT_NET_LIMIT = 20;
/** Requests per network and hour, whatever their outcome (never given back). */
export const CONTENT_NET_ATTEMPTS = 30;
export const CONTENT_NET_WINDOW_MS = 60 * 60 * 1000;
/** Time for a mirror to answer with headers, and for the whole transfer. */
export const HEADER_TIMEOUT_MS = 15_000;
export const TRANSFER_TIMEOUT_MS = 240_000;
/** The game sends this header; browsers never add it to cross-site requests without a CORS preflight we do not answer. */
export const CONTENT_HEADER = 'X-WebRA-Content';

/**
 * A stream of exactly `expected` bytes read from `upstream` (chunk by chunk,
 * nothing is held back): it errors on any more or less. `done(completed)`
 * runs once when it ends for any reason: finished (`completed` true),
 * failed, or cancelled by the reader (a player closing the page), so the
 * transfer deadline never outlives it and an unfinished transfer can be
 * given back to the budgets.
 */
export function exactly(upstream, expected, done = () => {}) {
  const reader = upstream.getReader();
  let seen = 0;
  let finished = false;
  const finish = (completed = false) => {
    if (finished) return;
    finished = true;
    done(completed);
  };
  return new ReadableStream({
    async pull(controller) {
      let r;
      try {
        r = await reader.read();
      } catch (err) {
        finish();
        controller.error(err);
        return;
      }
      if (r.done) {
        finish(seen === expected);
        if (seen !== expected) controller.error(new Error('upstream sent less than the expected size'));
        else controller.close();
        return;
      }
      seen += r.value.byteLength;
      if (seen > expected) {
        finish();
        reader.cancel().catch(() => {});
        controller.error(new Error('upstream sent more than the expected size'));
        return;
      }
      controller.enqueue(r.value);
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** Seconds until the fixed window of `windowMs` that holds `now` ends. */
const untilWindowEnd = (windowMs, now) => Math.ceil((windowMs - (now % windowMs)) / 1000);

/** 429 with Retry-After, and which budget refused (`scope`: account or network) in the body. */
function overBudget(scope, windowMs, now) {
  const retry = untilWindowEnd(windowMs, now);
  const message =
    scope === 'account'
      ? 'This account has used its one-click downloads for today.'
      : 'Too many one-click downloads from this network in the last hour.';
  return new HttpError(429, 'rate_limited', message, { 'retry-after': String(retry) }, { retryAfter: retry, scope });
}

/**
 * The relay's budgets for one request (see the top of this file): checks
 * them, charges one download to the account and the network, and returns
 * `refund()`, which gives that download back (once). Throws 429.
 */
export async function chargeDownload(db, salt, account, ip, now) {
  const net = networkOf(ip);
  // An account that has used its day is refused by a read alone: its clicks cost no write, not even an attempt.
  if ((await peekQuota(db, salt, 'content-account', account.id, CONTENT_ACCOUNT_WINDOW_MS, now)) >= CONTENT_ACCOUNT_LIMIT) {
    throw overBudget('account', CONTENT_ACCOUNT_WINDOW_MS, now);
  }
  if (!(await takeQuota(db, salt, 'content-tries', net, CONTENT_NET_ATTEMPTS, CONTENT_NET_WINDOW_MS, now))) {
    throw overBudget('network', CONTENT_NET_WINDOW_MS, now);
  }
  if (!(await takeQuota(db, salt, 'content-net', net, CONTENT_NET_LIMIT, CONTENT_NET_WINDOW_MS, now))) {
    throw overBudget('network', CONTENT_NET_WINDOW_MS, now);
  }
  if (!(await takeQuota(db, salt, 'content-account', account.id, CONTENT_ACCOUNT_LIMIT, CONTENT_ACCOUNT_WINDOW_MS, now))) {
    // Two downloads of one account raced for its last one: the network's charge goes back.
    await refundQuota(db, salt, 'content-net', net, CONTENT_NET_WINDOW_MS, now).catch(() => {});
    throw overBudget('account', CONTENT_ACCOUNT_WINDOW_MS, now);
  }
  let refunded = false;
  return async () => {
    if (refunded) return;
    refunded = true;
    // Given back in the window it was charged in (a later window starts from zero anyway).
    await Promise.all([
      refundQuota(db, salt, 'content-net', net, CONTENT_NET_WINDOW_MS, now),
      refundQuota(db, salt, 'content-account', account.id, CONTENT_ACCOUNT_WINDOW_MS, now),
    ]).catch(() => {});
  };
}

/**
 * Handle the route for `account` (the user requireRelay let through).
 * `fetchImpl` and `mirrors` are replaceable for tests (tests never reach
 * the real mirrors). `waitUntil` keeps the Worker alive for the refund of a
 * transfer that ends after the response went out (ExecutionContext
 * waitUntil).
 */
export async function quickInstall(
  request,
  env,
  ip,
  account,
  { fetchImpl = fetch, mirrors = QUICKINSTALL_MIRRORS, now = Date.now(), salt = null, waitUntil = (p) => p.catch(() => {}) } = {},
) {
  if (request.method !== 'GET') throw new HttpError(405, 'bad_message', 'Method not allowed.', { allow: 'GET' });
  if (request.headers.get(CONTENT_HEADER) !== '1') throw new HttpError(403, 'forbidden', 'This download is for the WebRA game page only.');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site !== null && site !== 'same-origin') throw new HttpError(403, 'forbidden', 'Cross-site requests are not allowed.');
  if (!account?.id) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
  const refund = await chargeDownload(env.DB, salt ?? ipSalt(env, request), account, ip, now);
  for (const url of mirrors) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetchImpl(url, { method: 'GET', redirect: 'follow', cache: 'no-store', signal: controller.signal });
    } catch {
      clearTimeout(timer);
      continue; // unreachable or too slow: the next mirror
    }
    clearTimeout(timer);
    const length = upstream.headers.get('Content-Length');
    if (!upstream.ok || !upstream.body || length !== String(QUICKINSTALL_BYTES)) {
      await upstream.body?.cancel().catch(() => {});
      continue;
    }
    // The transfer has a deadline of its own; the stream ends with an error after it.
    timer = setTimeout(() => controller.abort(), TRANSFER_TIMEOUT_MS);
    // The deadline is cleared however the stream ends (also when the reader cancels it).
    // An unfinished transfer (cut off, too long, cancelled by the player) is not charged.
    const out = exactly(upstream.body, QUICKINSTALL_BYTES, (completed) => {
      clearTimeout(timer);
      controller.abort();
      if (!completed) waitUntil(refund());
    });
    return new Response(out, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-length': String(QUICKINSTALL_BYTES),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'same-origin',
        'content-disposition': 'attachment; filename="ra-quickinstall.zip"',
      },
    });
  }
  // Nothing was streamed: the download goes back to both budgets (the attempt still counts).
  await refund();
  throw new HttpError(502, 'unavailable', 'None of the OpenRA mirrors answered with the Red Alert files. Try again later or download them yourself.');
}
