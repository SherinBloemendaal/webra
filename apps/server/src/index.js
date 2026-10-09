// WebRA Worker entry: the HTTP API (docs/contracts.md, section 4, and
// docs/accounts-api.md) and the play gate in front of the game files
// (playgate.js, docs/security.md). Other static files (the website) are
// served by Workers Assets directly; only /api/*, /play and /play/* reach
// this handler first (wrangler.jsonc `run_worker_first`). The daily cron
// trigger runs the accounts retention job.

import { PROTOCOL_VERSION, SESSION_ID_RE } from '@webra/protocol';
import pkg from '../package.json' with { type: 'json' };
import { checkCsrf, checkOrigin, errorResponse, HttpError, json, readJson, withCookies } from './http.js';
import { listSessions, pruneSessions } from './directory.js';
import { getMap, listMaps, uploadMap } from './maps.js';
import { pruneQuotas, takeQuota } from './quota.js';
import { validateCreateSession } from './validate.js';
import { quickInstall } from './content.js';
import { scoresRange } from './cdmusic.js';
import { isPlayPath, servePlay } from './playgate.js';
import { AUTH_HEADER, handleAccountApi, isNavigationRoute, newContext, playVerdict, requirePlay, requireRelay, scheduled } from './accounts/index.js';

export { Session } from './session.js';

const SERVER_VERSION = pkg.version;
const SESSION_LIMIT = 20;
const SESSION_WINDOW_MS = 60 * 60 * 1000;
const SESSION_BODY_MAX = 1024;

async function createSession(ctx) {
  const { request, env } = ctx;
  const { value } = await readJson(request, SESSION_BODY_MAX);
  const input = validateCreateSession(value);
  await requirePlay(ctx);
  if (!(await takeQuota(env.DB, ctx.salt(), 'sessions', ctx.ip, SESSION_LIMIT, SESSION_WINDOW_MS, ctx.now))) {
    throw new HttpError(429, 'rate_limited', 'Too many sessions created. Try again later.', { 'retry-after': '3600' }, { retryAfter: 3600 });
  }
  const id = env.SESSION.newUniqueId();
  const stub = env.SESSION.get(id);
  const { hostKey } = await stub.init({ id: id.toString(), ...input });
  return json({ id: id.toString(), hostKey }, 201);
}

/**
 * WebSocket upgrade into the session's Durable Object. The Worker decides
 * who the connection is (session cookie) and whether it may play, and tells
 * the object in a header it sets itself (any client copy is replaced); the
 * object answers `hello` with the refusal, so the player sees why.
 */
async function connectSession(ctx, id) {
  const { request, env } = ctx;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'bad_message', 'Expected a WebSocket upgrade.');
  }
  if (!SESSION_ID_RE.test(id)) throw new HttpError(404, 'not_found', 'No such session.');
  let doId;
  try {
    doId = env.SESSION.idFromString(id);
  } catch {
    throw new HttpError(404, 'not_found', 'No such session.');
  }
  const verdict = await playVerdict(ctx);
  const headers = new Headers(request.headers);
  headers.delete('Cookie');
  headers.set(AUTH_HEADER, JSON.stringify({ account: verdict.account, refuse: verdict.refuse ? { code: verdict.refuse.code, message: verdict.refuse.message } : null }));
  return env.SESSION.get(doId).fetch(new Request(request, { headers }));
}

async function route(ctx) {
  const { request, env, exec } = ctx;
  const path = ctx.url.pathname;
  const method = request.method;
  const mutating = method !== 'GET' && method !== 'HEAD';
  const upgrade = request.headers.get('Upgrade') !== null;
  if (mutating) checkCsrf(request);
  else if (!isNavigationRoute(method, path)) checkOrigin(request, { required: upgrade });

  if (path === '/api/version') {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return json({ version: SERVER_VERSION, protocol: PROTOCOL_VERSION });
  }
  if (path === '/api/sessions') {
    if (method === 'GET') {
      if (Math.random() < 0.02) exec.waitUntil(pruneSessions(env.DB).catch(() => {}));
      return json(await listSessions(env.DB));
    }
    if (method === 'POST') return createSession(ctx);
    throw methodNotAllowed('GET, POST');
  }
  let m = /^\/api\/sessions\/([^/]+)\/ws$/.exec(path);
  if (m) {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return connectSession(ctx, m[1]);
  }
  if (path === '/api/maps') {
    if (method === 'GET') return listMaps(env);
    if (method === 'POST') {
      if (Math.random() < 0.05) exec.waitUntil(pruneQuotas(env.DB).catch(() => {}));
      const account = await requirePlay(ctx);
      return uploadMap(request, env, ctx.ip, ctx.now, account?.id ?? null, ctx.salt());
    }
    throw methodNotAllowed('GET, POST');
  }
  if (path === '/api/content/ra-quickinstall') {
    // EA's freeware Red Alert files from OpenRA's mirrors, streamed, never stored (content.js).
    if (method !== 'GET') throw methodNotAllowed('GET');
    await requireRelay(ctx);
    return quickInstall(request, env, ctx.ip, { salt: ctx.salt() });
  }
  if (path === '/api/content/ra-scores') {
    // The Red Alert music: byte ranges of scores.mix from the freeware CD images, streamed, never stored (cdmusic.js).
    if (method !== 'GET') throw methodNotAllowed('GET');
    const user = await requireRelay(ctx);
    return scoresRange(request, env, ctx.ip, user, { salt: ctx.salt() });
  }
  m = /^\/api\/maps\/([^/]+)$/.exec(path);
  if (m) {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return getMap(env, exec, m[1]);
  }
  const res = await handleAccountApi(ctx);
  if (res) return res;
  throw new HttpError(404, 'not_found', 'No such API endpoint.');
}

function methodNotAllowed(allow) {
  return new HttpError(405, 'bad_message', 'Method not allowed.', { allow });
}

export default {
  async fetch(request, env, exec) {
    const url = new URL(request.url);
    if (isPlayPath(url.pathname)) return servePlay(request, env, exec);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const ctx = newContext(request, env, exec);
    try {
      return await route(ctx);
    } catch (err) {
      if (err instanceof HttpError) return withCookies(errorResponse(err.status, err.code, err.message, err.headers, err.extra), ctx.cookies);
      // Never echo internals or request data; log only the error type and message.
      console.error('api error', err?.name, err?.message);
      return withCookies(errorResponse(500, 'internal', 'Internal error.'), ctx.cookies);
    }
  },
  scheduled,
};
