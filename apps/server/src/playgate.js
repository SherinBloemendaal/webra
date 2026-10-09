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

import { errorResponse, HttpError, isReturnPath, parseCookies, cookieName, withCookies } from './http.js';
import { ipSalt } from './ipkey.js';
import { applyPlayHeaders } from './static-headers.js';
import { bannedError, inactiveError, ipBannedError, RequestContext } from './accounts/context.js';
import { clearPlayPassCookie, passKey, passMatchesSession, PASS_TTL_S, PLAY_COOKIE, playPassCookie, signPass, sidOfHash, verifyPass } from './accounts/playpass.js';
import { loadSiteCached } from './accounts/site.js';
import { sessionToken } from './accounts/sessions.js';
import { banOf, effectiveStatus } from './accounts/users.js';

/** Cache-Control of every gated response: browsers may keep a copy, shared caches never. */
export const PLAY_CACHE_CONTROL = 'private, max-age=0, must-revalidate';
const STAFF = new Set(['admin', 'moderator']);
const DEFAULT_RETURN = '/play/';

export function isPlayPath(pathname) {
  return pathname === '/play' || pathname.startsWith('/play/');
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
  return isPlayPath(url.pathname) && isReturnPath(target) ? target : DEFAULT_RETURN;
}

function appendVary(headers, name) {
  const current = headers.get('Vary');
  if (!current) headers.set('Vary', name);
  else if (!current.split(',').some((v) => v.trim().toLowerCase() === name.toLowerCase())) headers.set('Vary', `${current}, ${name}`);
}

/** The file from Workers Static Assets with the static security headers and private caching. */
async function serve(request, env, cookies) {
  const asset = await env.ASSETS.fetch(request);
  const res = new Response(asset.body, asset);
  applyPlayHeaders(res.headers);
  res.headers.set('Cache-Control', PLAY_CACHE_CONTROL);
  appendVary(res.headers, 'Cookie');
  return withCookies(res, cookies);
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
    if (err instanceof HttpError) return refuse(request, url, err, cookies);
    console.error('play gate error', err?.name, err?.message);
    return refuse(request, url, new HttpError(500, 'internal', 'Internal error.'), cookies);
  }
}
