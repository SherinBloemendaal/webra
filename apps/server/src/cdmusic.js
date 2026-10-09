// GET /api/content/ra-scores: the original Red Alert music (scores.mix) for
// the game's one-click install (apps/game/js/content/cdmusic.js), read by
// HTTP range from the freeware Red Alert CDs that Electronic Arts released in
// 2008 (the Allied and the Soviet disc), as hosted on the Internet Archive.
//
// The relay is as narrow as the music needs:
//
// - The client never names a URL, a disc or an offset. It asks for a byte
//   range of scores.mix (Range: bytes=a-b, one range, at most
//   SCORES_MAX_RANGE bytes, inside SCORES_BYTES); the Worker adds the pinned
//   offset of scores.mix inside the pinned disc image and asks the pinned
//   upstream URL for exactly that window. Nothing else on the discs (the
//   game, the movies) can be read through it.
// - The upstream URLs are fixed (SCORES_DISCS). The Internet Archive answers
//   a download with a redirect to one of its data nodes: exactly one such
//   redirect is followed, by hand, and only to an https data node of the
//   archive (ARCHIVE_NODE) with the same item and file path. Anything else
//   (another host, a query, a second redirect) is refused.
// - The upstream answer must be 206 with Content-Range of exactly the asked
//   window and the pinned size of the whole image, so a different or
//   changed image is refused. The body is relayed as a stream of exactly the
//   asked length (content.js `exactly`) and cut off when it runs longer.
// - Only GET, only from the game page (the X-WebRA-Content header and
//   same-origin), only for a signed-in, active account with the
//   content_autoinstall flag or the admin role while the contentRelay site
//   setting is on (accounts/play.js requireRelay, checked in index.js).
// - Budgets in the D1 quota table (keys are salted hashes): SCORES_DAILY_MIB
//   megabytes per account per day and SCORES_IP_LIMIT requests per IP per
//   hour. A request over a budget costs no upstream fetch.
// - Nothing is stored or cached: `cache: 'no-store'` upstream and
//   `Cache-Control: no-store` on the answer; no request header of the player
//   (cookies, address) is passed upstream.
//
// The client checks the assembled scores.mix against SCORES_SHA256 before it
// installs anything. The pins (sizes, offsets, hash) were measured once from
// the discs with range requests (docs/security.md); they are numbers about
// EA's files, not the files.
// docs/security.md, docs/accounts-api.md and docs/contracts.md describe the route.

import { HttpError } from './http.js';
import { ipSalt } from './ipkey.js';
import { takeQuota } from './quota.js';
import { CONTENT_HEADER, exactly } from './content.js';

/** scores.mix as found in MAIN.MIX on both freeware discs (the same bytes on each). */
export const SCORES_BYTES = 64_171_360;
export const SCORES_SHA256 = '313ef2e4e9dfe33d0d282d078d9c545fe1aff4748375f062d2da2a96f93c0846';

const ITEM = 'command-conquer-red-alert_202309';
/**
 * The two freeware discs (EA's CD1_ALLIED_DISC.ISO and CD2_SOVIET_DISC.ISO,
 * byte sizes as in EA's 2008 download), tried in this order. `scoresOffset`
 * is where scores.mix starts in the image: MAIN.MIX's extent in the ISO 9660
 * directory plus scores.mix's offset in MAIN.MIX's (encrypted) index.
 */
export const SCORES_DISCS = Object.freeze([
  Object.freeze({
    disc: 'allied',
    url: `https://archive.org/download/${ITEM}/Command%20%26%20Conquer%20Red%20Alert%20%5BCD1%5D.ISO`,
    isoBytes: 654_348_288,
    scoresOffset: 389_208_833,
  }),
  Object.freeze({
    disc: 'soviet',
    url: `https://archive.org/download/${ITEM}/Command%20%26%20Conquer%20Red%20Alert%20%5BCD2%5D.ISO`,
    isoBytes: 677_396_480,
    scoresOffset: 435_168_665,
  }),
]);

/** The Internet Archive's data nodes (ia601402.us.archive.org, dn721505.ca.archive.org). */
export const ARCHIVE_NODE = /^(?:ia|dn)\d{3,8}\.[a-z]{2}\.archive\.org$/;

/** Largest range per request (the client asks for 8 MiB pieces). */
export const SCORES_MAX_RANGE = 8 * 1024 * 1024;
/** Per account and UTC day, in MiB (each request counts its size rounded up): four full downloads. */
export const SCORES_DAILY_MIB = 256;
export const SCORES_DAY_MS = 24 * 60 * 60 * 1000;
/** Requests per IP and hour (a full download is 8). */
export const SCORES_IP_LIMIT = 64;
export const SCORES_IP_WINDOW_MS = 60 * 60 * 1000;
/** Time for an upstream answer with headers, and for one piece's transfer. */
export const SCORES_HEADER_TIMEOUT_MS = 15_000;
export const SCORES_TRANSFER_TIMEOUT_MS = 120_000;
/** Rounds over the discs (the archive's data nodes sometimes answer 500 once). */
export const SCORES_ROUNDS = 2;

const MIB = 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Parse the player's Range header: one `bytes=a-b` (or `bytes=a-`, which
 * ends at the piece limit or the file end) inside scores.mix. Returns
 * { start, end } (inclusive) or throws 416.
 */
export function parseScoresRange(header) {
  const unsatisfiable = () => new HttpError(416, 'bad_range', 'Ask for one byte range of scores.mix.', { 'content-range': `bytes */${SCORES_BYTES}` });
  if (typeof header !== 'string' || header.length > 64) throw unsatisfiable();
  const m = /^bytes=(\d{1,9})-(\d{0,9})$/.exec(header.trim());
  if (!m) throw unsatisfiable();
  const start = Number(m[1]);
  let end = m[2] === '' ? Math.min(SCORES_BYTES - 1, start + SCORES_MAX_RANGE - 1) : Number(m[2]);
  if (start >= SCORES_BYTES || end < start) throw unsatisfiable();
  end = Math.min(end, SCORES_BYTES - 1);
  if (end - start + 1 > SCORES_MAX_RANGE) throw unsatisfiable();
  return { start, end };
}

/**
 * Whether `location` (a redirect from `pinned`) is the same item and file on
 * one of the archive's https data nodes: https, a data node host, the
 * default port, no credentials, query or fragment, already in normal form,
 * and the path /<n>/items/<item>/<file> with the pinned item and file.
 */
export function allowedRedirect(pinned, location) {
  let to;
  try {
    to = new URL(location);
  } catch {
    return null;
  }
  const from = new URL(pinned);
  const tail = from.pathname.replace(/^\/download\//, '');
  if (to.protocol !== 'https:' || !ARCHIVE_NODE.test(to.hostname) || to.port !== '' || to.username || to.password) return null;
  if (to.search !== '' || to.hash !== '' || location.includes('?') || location.includes('#')) return null;
  // Taken as sent: a location the URL parser would rewrite (dot segments, case, escapes) is refused.
  if (to.href !== location) return null;
  const m = /^\/\d{1,4}\/items\/(.+)$/.exec(to.pathname);
  if (!m || m[1] !== tail) return null;
  return to.href;
}

/** `bytes a-b/total` exactly. */
const contentRange = (start, end, total) => `bytes ${start}-${end}/${total}`;

/**
 * One upstream attempt for `disc`: the window of the image, after at most
 * one checked redirect. Returns { res, controller, timer } with a usable
 * 206 answer, or null (the body of a refused answer is cancelled).
 */
async function fetchWindow(disc, start, end, fetchImpl) {
  const from = disc.scoresOffset + start;
  const to = disc.scoresOffset + end;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCORES_HEADER_TIMEOUT_MS);
  const init = { method: 'GET', redirect: 'manual', cache: 'no-store', signal: controller.signal, headers: { Range: `bytes=${from}-${to}` } };
  const refuse = async (res) => {
    clearTimeout(timer);
    controller.abort();
    await res?.body?.cancel().catch(() => {});
    return null;
  };
  let url = disc.url;
  let res;
  try {
    res = await fetchImpl(url, init);
    if (REDIRECTS.has(res.status)) {
      const next = allowedRedirect(disc.url, res.headers.get('Location') ?? '');
      await res.body?.cancel().catch(() => {});
      if (!next) return refuse(null);
      url = next;
      res = await fetchImpl(url, init);
    }
  } catch {
    return refuse(null); // unreachable or too slow: the next attempt
  }
  if (res.status !== 206 || !res.body) return refuse(res);
  if (res.headers.get('Content-Range') !== contentRange(from, to, disc.isoBytes)) return refuse(res);
  const length = res.headers.get('Content-Length');
  if (length !== null && length !== String(to - from + 1)) return refuse(res);
  clearTimeout(timer);
  return { res, controller };
}

/**
 * Handle the route for `account` (the user requireRelay let through).
 * `fetchImpl` and `discs` are replaceable for tests (tests never reach the
 * real archive).
 */
export async function scoresRange(request, env, ip, account, { fetchImpl = fetch, discs = SCORES_DISCS, now = Date.now(), salt = null } = {}) {
  if (request.method !== 'GET') throw new HttpError(405, 'bad_message', 'Method not allowed.', { allow: 'GET' });
  if (request.headers.get(CONTENT_HEADER) !== '1') throw new HttpError(403, 'forbidden', 'This download is for the WebRA game page only.');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site !== null && site !== 'same-origin') throw new HttpError(403, 'forbidden', 'Cross-site requests are not allowed.');
  if (!account?.id) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
  const { start, end } = parseScoresRange(request.headers.get('Range'));
  const length = end - start + 1;
  const key = salt ?? ipSalt(env, request);
  if (!(await takeQuota(env.DB, key, 'scores-ip', ip, SCORES_IP_LIMIT, SCORES_IP_WINDOW_MS, now))) {
    const retry = Math.ceil((SCORES_IP_WINDOW_MS - (now % SCORES_IP_WINDOW_MS)) / 1000);
    throw new HttpError(429, 'rate_limited', 'Too many music downloads from this network. Try again later.', { 'retry-after': String(retry) }, { retryAfter: retry });
  }
  if (!(await takeQuota(env.DB, key, 'scores-bytes', account.id, SCORES_DAILY_MIB, SCORES_DAY_MS, now, Math.ceil(length / MIB)))) {
    const retry = Math.ceil((SCORES_DAY_MS - (now % SCORES_DAY_MS)) / 1000);
    throw new HttpError(429, 'rate_limited', 'This account downloaded the music too often today. Try again tomorrow.', { 'retry-after': String(retry) }, { retryAfter: retry });
  }
  for (let round = 0; round < SCORES_ROUNDS; round++) {
    for (const disc of discs) {
      const got = await fetchWindow(disc, start, end, fetchImpl);
      if (!got) continue;
      const { res, controller } = got;
      // The transfer has a deadline of its own; the stream ends with an error after it.
      const timer = setTimeout(() => controller.abort(), SCORES_TRANSFER_TIMEOUT_MS);
      const out = exactly(res.body, length, () => {
        clearTimeout(timer);
        controller.abort();
      });
      return new Response(out, {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(length),
          'content-range': contentRange(start, end, SCORES_BYTES),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-origin',
          'referrer-policy': 'same-origin',
        },
      });
    }
  }
  throw new HttpError(502, 'unavailable', 'The Internet Archive did not answer with the Red Alert music. Try again later or install it from the CD image yourself.');
}
