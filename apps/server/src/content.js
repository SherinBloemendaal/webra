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
// - same-origin requests only (the game's own page), 3 downloads per hour
//   per IP through the D1 quota table (IPs only as salted hashes, never
//   logged), and a time limit per mirror and for the whole transfer.
// docs/security.md and docs/contracts.md section 4 describe the route.

import { HttpError } from './http.js';
import { takeQuota } from './quota.js';

/** OpenRA's quick install mirrors (mods/ra/installer), tried in this order. */
export const QUICKINSTALL_MIRRORS = Object.freeze([
  'https://openra.baxxster.no/openra/ra-quickinstall.zip',
  'https://republic.community/hosted/files/command-and-conquer/openra/ra-quickinstall.zip',
  'https://openra.0x47.net/ra-quickinstall.zip',
  'https://openra.ppmsite.com/ra-quickinstall.zip',
]);
export const QUICKINSTALL_BYTES = 13_502_031;
export const CONTENT_LIMIT = 3;
export const CONTENT_WINDOW_MS = 60 * 60 * 1000;
/** Time for a mirror to answer with headers, and for the whole transfer. */
export const HEADER_TIMEOUT_MS = 15_000;
export const TRANSFER_TIMEOUT_MS = 240_000;
/** The game sends this header; browsers never add it to cross-site requests without a CORS preflight we do not answer. */
export const CONTENT_HEADER = 'X-WebRA-Content';

/**
 * A stream that passes `expected` bytes through (chunk by chunk, nothing is
 * held back) and errors on any more or less; `done` runs when it ends.
 */
function exactly(expected, done = () => {}) {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expected) {
        done();
        controller.error(new Error('upstream sent more than the expected size'));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      done();
      if (seen !== expected) controller.error(new Error('upstream sent less than the expected size'));
    },
  });
}

/**
 * Handle the route. `fetchImpl` and `mirrors` are replaceable for tests
 * (tests never reach the real mirrors).
 */
export async function quickInstall(request, env, ip, { fetchImpl = fetch, mirrors = QUICKINSTALL_MIRRORS, now = Date.now() } = {}) {
  if (request.method !== 'GET') throw new HttpError(405, 'bad_message', 'Method not allowed.', { allow: 'GET' });
  if (request.headers.get(CONTENT_HEADER) !== '1') throw new HttpError(403, 'forbidden', 'This download is for the WebRA game page only.');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site !== null && site !== 'same-origin') throw new HttpError(403, 'forbidden', 'Cross-site requests are not allowed.');
  if (!(await takeQuota(env.DB, 'content', ip, CONTENT_LIMIT, CONTENT_WINDOW_MS, now))) {
    const retry = Math.ceil((CONTENT_WINDOW_MS - (now % CONTENT_WINDOW_MS)) / 1000);
    throw new HttpError(429, 'rate_limited', 'Too many content downloads. Try again later.', { 'retry-after': String(retry) });
  }
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
    const out = upstream.body.pipeThrough(exactly(QUICKINSTALL_BYTES, () => clearTimeout(timer)));
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
  throw new HttpError(502, 'unavailable', 'None of the OpenRA mirrors answered with the Red Alert files. Try again later or download them yourself.');
}
