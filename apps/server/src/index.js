// WebRA Worker entry: the HTTP API (docs/contracts.md, section 4). Static
// files (website and game) are served by Workers Assets; only /api/* reaches
// this handler first.

import { PROTOCOL_VERSION, SESSION_ID_RE } from '@webra/protocol';
import pkg from '../package.json' with { type: 'json' };
import { clientIp, checkOrigin, errorResponse, HttpError, json, readJson } from './http.js';
import { listSessions, pruneSessions } from './directory.js';
import { getMap, listMaps, uploadMap } from './maps.js';
import { pruneQuotas, takeQuota } from './quota.js';
import { validateCreateSession } from './validate.js';
import { quickInstall } from './content.js';

export { Session } from './session.js';

const SERVER_VERSION = pkg.version;
const SESSION_LIMIT = 20;
const SESSION_WINDOW_MS = 60 * 60 * 1000;
const SESSION_BODY_MAX = 1024;

async function createSession(request, env, ip) {
  const { value } = await readJson(request, SESSION_BODY_MAX);
  const input = validateCreateSession(value);
  if (!(await takeQuota(env.DB, 'sessions', ip, SESSION_LIMIT, SESSION_WINDOW_MS))) {
    throw new HttpError(429, 'rate_limited', 'Too many sessions created. Try again later.', { 'retry-after': '3600' });
  }
  const id = env.SESSION.newUniqueId();
  const stub = env.SESSION.get(id);
  const { hostKey } = await stub.init({ id: id.toString(), ...input });
  return json({ id: id.toString(), hostKey }, 201);
}

async function connectSession(request, env, id) {
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
  return env.SESSION.get(doId).fetch(request);
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const ip = clientIp(request);
  const mutating = method !== 'GET' && method !== 'HEAD';
  const upgrade = request.headers.get('Upgrade') !== null;
  checkOrigin(request, { required: mutating || upgrade });

  if (path === '/api/version') {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return json({ version: SERVER_VERSION, protocol: PROTOCOL_VERSION });
  }
  if (path === '/api/sessions') {
    if (method === 'GET') {
      if (Math.random() < 0.02) ctx.waitUntil(pruneSessions(env.DB).catch(() => {}));
      return json(await listSessions(env.DB));
    }
    if (method === 'POST') return createSession(request, env, ip);
    throw methodNotAllowed('GET, POST');
  }
  let m = /^\/api\/sessions\/([^/]+)\/ws$/.exec(path);
  if (m) {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return connectSession(request, env, m[1]);
  }
  if (path === '/api/maps') {
    if (method === 'GET') return listMaps(env);
    if (method === 'POST') {
      if (Math.random() < 0.05) ctx.waitUntil(pruneQuotas(env.DB, SESSION_WINDOW_MS).catch(() => {}));
      return uploadMap(request, env, ip);
    }
    throw methodNotAllowed('GET, POST');
  }
  if (path === '/api/content/ra-quickinstall') {
    // EA's freeware Red Alert files from OpenRA's mirrors, streamed, never stored (content.js).
    return quickInstall(request, env, ip);
  }
  m = /^\/api\/maps\/([^/]+)$/.exec(path);
  if (m) {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return getMap(env, ctx, m[1]);
  }
  throw new HttpError(404, 'not_found', 'No such API endpoint.');
}

function methodNotAllowed(allow) {
  return new HttpError(405, 'bad_message', 'Method not allowed.', { allow });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message, err.headers);
      // Never echo internals or request data; log only the error type and message.
      console.error('api error', err?.name, err?.message);
      return errorResponse(500, 'internal', 'Internal error.');
    }
  },
};
