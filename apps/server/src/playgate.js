// The play gate (docs/security.md, "The play gate"): while the site setting
// `gameRequiresAccount` is on, the Worker serves every file under /play
// (wrangler.jsonc `run_worker_first`) only to an account that may play: an
// active account that is not banned, from an address that is not banned.
// Admins and moderators with an active account pass even from a banned
// address. Everyone may load the game while the setting is off.
//
// Cost: a valid play pass (accounts/playpass.js) is checked with WebCrypto
// only, without D1. Without one, the Worker reads the settings (cached per
// isolate for 30 seconds, accounts/site.js), the session and the IP ban
// from D1 once and issues a fresh pass for the next 10 minutes.
//
// Refusals: a page navigation goes to /account/?returnTo=<path>; any other
// request gets 401 or 403 with a JSON error and nothing of the game.
//
// Caching (docs/security.md "The play gate"): pages (HTML) are revalidated on
// every load; the other files (about 250 per load) are kept by the browser
// for as long as a play pass lives, so a reload within 10 minutes costs no
// request at all. File names carry no version, so each page load sets the
// build cookie (the deployed dist/version.json `build`) and a file is kept
// only when its request named the current build: with `Vary: Cookie`, a page
// of a newer deploy never runs with files of an older one.

import { cookieHeader, errorResponse, HttpError, isReturnPath, parseCookies, cookieName, withCookies } from './http.js';
import { ipSalt } from './ipkey.js';
import { applyPlayHeaders } from './static-headers.js';
import { logError, reportHttpError } from './telemetry.js';
import { bannedError, inactiveError, ipBannedError, RequestContext } from './accounts/context.js';
import { clearPlayPassCookie, passKey, passMatchesSession, PASS_TTL_S, PLAY_COOKIE, playPassCookie, signPass, sidOfHash, verifyPass } from './accounts/playpass.js';
import { loadSiteCached } from './accounts/site.js';
import { sessionToken } from './accounts/sessions.js';
import { banOf, effectiveStatus } from './accounts/users.js';

/** Cache-Control of the game's pages (and of anything not kept, below): browsers revalidate on every load, shared caches never store it. */
export const PLAY_CACHE_CONTROL = 'private, max-age=0, must-revalidate';
/** Cache-Control of the other game files of the current build: the browser keeps them as long as a play pass lives. */
export const PLAY_FILE_CACHE_CONTROL = `private, max-age=${PASS_TTL_S}`;
/** The cookie that names the build of the game page the browser loaded last (part of every file's cache key through Vary: Cookie). */
export const BUILD_COOKIE = 'webra_build';
/** How long the build cookie lasts (it is set again by every page load). */
const BUILD_COOKIE_TTL_S = 30 * 24 * 60 * 60;
/** A build id as dist/version.json writes it: `<version>+<commit>`. */
const BUILD_RE = /^[0-9A-Za-z.+_-]{1,64}$/;
const STAFF = new Set(['admin', 'moderator']);
const DEFAULT_RETURN = '/play/';

/** /play or a path under it, exactly as the canonical URL spells it. */
function isCanonicalPlayPath(pathname) {
  return pathname === '/play' || pathname.startsWith('/play/');
}

/** Percent-decode `s`; malformed or non-UTF-8 escapes (overlong forms) decode byte by byte, never to `/`. */
function decodeOnce(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/%([0-9a-fA-F]{2})/g, (m, hex) => {
      const c = parseInt(hex, 16);
      return c < 0x80 ? String.fromCharCode(c) : m;
    });
  }
}

/**
 * The path segments of `pathname` the way any layer might read it:
 * percent escapes decoded (repeatedly, so double encoding counts too),
 * backslashes as slashes, empty segments dropped, `;params` and trailing
 * dots or spaces of a segment ignored, dot segments resolved, lower case.
 */
export function normalizedSegments(pathname) {
  let s = String(pathname);
  for (let i = 0; i < 4; i++) {
    const next = decodeOnce(s);
    if (next === s) break;
    s = next;
  }
  const out = [];
  for (let seg of s.replace(/\\/g, '/').split('/')) {
    seg = seg.split(';')[0].replace(/[.\s]+$/, (m) => (seg === '.' || seg === '..' ? m : '')).toLowerCase();
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out;
}

/**
 * Whether a request is for the game: its path, normalized as above, is
 * /play or under it. Deliberately wider than the paths Workers Static Assets
 * serves (it redirects every non-canonical spelling to the canonical one,
 * which is gated, and is case-sensitive), so no spelling of a game path
 * reaches the files around the gate. Refusing a path that would only have
 * been a 404 or a redirect costs nothing.
 */
export function isPlayPath(pathname) {
  return normalizedSegments(pathname)[0] === 'play';
}

/**
 * Whether a refused request should be redirected to the sign-in page: a
 * top-level page load (Sec-Fetch-Mode navigate; without Fetch Metadata, an
 * Accept header that asks for HTML).
 */
export function isNavigation(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers.get('Sec-Fetch-Mode');
  if (mode !== null) return mode === 'navigate';
  return (request.headers.get('Accept') ?? '').toLowerCase().includes('text/html');
}

/** Where the sign-in page sends the player back to: this game path (and query), or /play/. */
export function returnPathFor(url) {
  const target = url.pathname + url.search;
  return isCanonicalPlayPath(url.pathname) && isReturnPath(target) ? target : DEFAULT_RETURN;
}

function appendVary(headers, name) {
  const current = headers.get('Vary');
  if (!current) headers.set('Vary', name);
  else if (!current.split(',').some((v) => v.trim().toLowerCase() === name.toLowerCase())) headers.set('Vary', `${current}, ${name}`);
}

/** The deployed build per isolate (an isolate serves one deployment's assets). */
const builds = new WeakMap();

/**
 * The build of the deployed files (dist/version.json `build`, read once per
 * isolate from the static assets), or null when it cannot be read (then no
 * file is kept by the browser).
 */
export async function deployedBuild(env, url) {
  if (builds.has(env.ASSETS)) return builds.get(env.ASSETS);
  try {
    const r = await env.ASSETS.fetch(new Request(new URL('/version.json', url), { method: 'GET' }));
    if (!r.ok) return null;
    const build = (await r.json())?.build;
    if (typeof build !== 'string' || !BUILD_RE.test(build)) return null;
    builds.set(env.ASSETS, build);
    return build;
  } catch {
    return null;
  }
}

/**
 * The file from Workers Static Assets with the static security headers and
 * private caching: pages revalidate, other files of the current build are
 * kept (see the top of this file). A page sets the build cookie when the
 * browser's is not the current build.
 */
async function serve(request, env, cookies) {
  const asset = await env.ASSETS.fetch(request);
  const res = new Response(asset.body, asset);
  applyPlayHeaders(res.headers);
  const page = (res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');
  const build = res.status === 200 ? await deployedBuild(env, request.url) : null;
  const named = parseCookies(request).get(cookieName(request, BUILD_COOKIE)) ?? null;
  const keep = build !== null && !page && named === build;
  res.headers.set('Cache-Control', keep ? PLAY_FILE_CACHE_CONTROL : PLAY_CACHE_CONTROL);
  appendVary(res.headers, 'Cookie');
  const out = page && build !== null && named !== build ? [...cookies, cookieHeader(request, BUILD_COOKIE, build, BUILD_COOKIE_TTL_S)] : cookies;
  return withCookies(res, out);
}

/** A refusal: the redirect to sign in for page loads, otherwise the JSON error (nothing of the game). */
function refuse(request, url, err, cookies) {
  let res;
  if ((err.status === 401 || err.status === 403) && isNavigation(request)) {
    const location = `/account/?returnTo=${encodeURIComponent(returnPathFor(url))}`;
    res = new Response(null, { status: 302, headers: { location } });
  } else {
    res = errorResponse(err.status, err.code, err.message, err.headers, err.extra);
  }
  applyPlayHeaders(res.headers);
  res.headers.set('Cache-Control', 'no-store');
  appendVary(res.headers, 'Cookie');
  return withCookies(res, cookies);
}

/**
 * The verdict from D1 for a request without a valid pass. Returns { pass }
 * (the pass to issue, or null while the setting is off) or throws the
 * refusal as an HttpError.
 */
async function checkAccess(ctx) {
  const site = await loadSiteCached(ctx.db, ctx.now);
  if (!site.settings.gameRequiresAccount) return { open: true };
  if (!sessionToken(ctx.request)) throw new HttpError(401, 'unauthenticated', 'Sign in to play.');
  const { session, user } = await ctx.auth();
  if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in to play.');
  const status = effectiveStatus(user);
  const ban = banOf(user);
  if (ban) throw bannedError(ban);
  const staff = STAFF.has(user.role) && status === 'active';
  if (!staff && (await ctx.ipBan())) throw ipBannedError();
  if (status !== 'active') throw inactiveError(status);
  return { open: false, userId: user.id, sid: sidOfHash(session.id_hash) };
}

/** Handle a request for /play or /play/*. */
export async function servePlay(request, env, exec, now = Date.now()) {
  const url = new URL(request.url);
  const ctx = new RequestContext(request, env, exec, now);
  const passValue = parseCookies(request).get(cookieName(request, PLAY_COOKIE)) ?? null;
  try {
    // Fails closed (503) when the secret is missing outside local development.
    const key = await passKey(ipSalt(env, request));
    const token = sessionToken(request);
    if (passValue && token && (await passMatchesSession(await verifyPass(key, passValue, now), token))) {
      return serve(request, env, []);
    }
    const verdict = await checkAccess(ctx);
    if (verdict.open) return serve(request, env, ctx.cookies);
    const value = await signPass(key, { userId: verdict.userId, sid: verdict.sid, exp: Math.floor(now / 1000) + PASS_TTL_S });
    return serve(request, env, [...ctx.cookies, playPassCookie(request, value)]);
  } catch (err) {
    const clear = clearPlayPassCookie(request);
    const cookies = passValue && !ctx.cookies.includes(clear) ? [...ctx.cookies, clear] : ctx.cookies;
    if (err instanceof HttpError) {
      reportHttpError(err);
      return refuse(request, url, err, cookies);
    }
    logError('play gate error', err);
    return refuse(request, url, new HttpError(500, 'internal', 'Internal error.'), cookies);
  }
}
