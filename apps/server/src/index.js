// WebRA Worker entry: the HTTP API (docs/contracts.md, section 4, and
// docs/accounts-api.md) and the play gate in front of the game files
// (playgate.js, docs/security.md). Other static files (the website) are
// served by Workers Assets directly; only /api/*, /play and /play/* reach
// this handler first (wrangler.jsonc `run_worker_first`). The daily cron
// trigger runs the accounts retention job. Errors are reported to WebRA's
// Sentry when SENTRY_DSN is set (telemetry.js).

import {
  framesDigest,
  LOG_MAX_BYTES,
  MAP_MAX_BYTES,
  MEMBER_HEADER,
  MEMBER_RE,
  optionsDigest,
  parseReplay,
  PROTOCOL_VERSION,
  SESSION_ID_RE,
  SHA256_RE,
} from '@webra/protocol';
import pkg from '../package.json' with { type: 'json' };
import { checkCsrf, checkOrigin, errorResponse, HttpError, json, jsonText, readJson, readText, withCookies } from './http.js';
import { listSessions, pruneSessions } from './directory.js';
import { checkJsonType, getMap, getMapThumbnail, listMaps, prepareMap, SESSION_MAP_GET_LIMIT, UPLOAD_LIMIT, UPLOAD_WINDOW_MS, uploadMap } from './maps.js';
import { pruneQuotas, takeQuota } from './quota.js';
import { validateCreateSession } from './validate.js';
import { quickInstall } from './content.js';
import { loadSaveRecord, missionDigest } from './onlinesaves.js';
import { moviesRange, scoresRange } from './cdmusic.js';
import { isPlayPath, servePlay } from './playgate.js';
import { AUTH_HEADER, handleAccountApi, isNavigationRoute, newContext, playVerdict, requirePlay, requireRelay, scheduled } from './accounts/index.js';
import { Session as SessionObject } from './session.js';
import { instrumentSession, logError, reportHttpError, withTelemetry } from './telemetry.js';

/** The session Durable Object (wrangler.jsonc), with error reports. */
export const Session = instrumentSession(SessionObject);

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

/** The session's Durable Object for an id from a path (404 for malformed ids). */
function sessionStub(env, id) {
  if (!SESSION_ID_RE.test(id)) throw new HttpError(404, 'not_found', 'No such session.');
  try {
    return env.SESSION.get(env.SESSION.idFromString(id));
  } catch {
    throw new HttpError(404, 'not_found', 'No such session.');
  }
}

/** The member credential of a session map request: `<client>.<rejoin key>` (docs/contracts.md section 4). */
function memberOf(request) {
  const m = MEMBER_RE.exec(request.headers.get(MEMBER_HEADER) ?? '');
  const client = m ? Number(m[1]) : 0;
  if (!m || client > 0x7fffffff) throw new HttpError(403, 'forbidden', 'You are not a member of this session.');
  return { client, key: m[2] };
}

/** An RPC answer of the session object, or its error as an HttpError. */
function rpcResult(r) {
  if (r?.ok === true) return r;
  if (r && Number.isInteger(r.status) && typeof r.code === 'string') throw new HttpError(r.status, r.code, String(r.message));
  throw new HttpError(500, 'internal', 'The session did not answer.');
}

/**
 * GET /api/sessions/<id>/map?hash=<sha256>: the session's map file for one of
 * its members (docs/security.md "Map sharing"). Never cached by anyone else.
 */
async function sessionMapGet(ctx, id) {
  const hash = ctx.url.searchParams.get('hash') ?? '';
  if (!SHA256_RE.test(hash)) throw new HttpError(400, 'bad_message', 'The map hash is missing or malformed.');
  const member = memberOf(ctx.request);
  const stub = sessionStub(ctx.env, id);
  const account = await requirePlay(ctx);
  if (!(await takeQuota(ctx.env.DB, ctx.salt(), 'mapget', ctx.ip, SESSION_MAP_GET_LIMIT, UPLOAD_WINDOW_MS, ctx.now))) {
    throw new HttpError(429, 'rate_limited', 'Too many map downloads. Try again later.', { 'retry-after': '3600' }, { retryAfter: 3600 });
  }
  const r = rpcResult(await stub.memberMap({ member, account, ip: ctx.ip, hash }));
  return jsonText(r.text, 200, { 'cache-control': 'private, no-store' });
}

/**
 * POST /api/sessions/<id>/map: the host shares a map file with this session
 * only. Validated like a public upload (protocol package and engine, upload
 * quota) and stored unlisted.
 */
async function sessionMapShare(ctx, id) {
  checkJsonType(ctx.request);
  const member = memberOf(ctx.request);
  const stub = sessionStub(ctx.env, id);
  const account = await requirePlay(ctx);
  if (!(await takeQuota(ctx.env.DB, ctx.salt(), 'maps', ctx.ip, UPLOAD_LIMIT, UPLOAD_WINDOW_MS, ctx.now))) {
    throw new HttpError(429, 'rate_limited', 'Too many map uploads. Try again later.', { 'retry-after': '3600' }, { retryAfter: 3600 });
  }
  const prepared = await prepareMap(await readText(ctx.request, MAP_MAX_BYTES));
  const r = rpcResult(await stub.shareMap({ member, account, ip: ctx.ip, prepared }));
  // `upgradedFrom`: the file was of an older map format version; the lobby has the upgraded map.
  return json({ id: r.id, hash: r.hash, ...(prepared.upgradedFrom ? { upgradedFrom: prepared.upgradedFrom } : {}) }, r.created ? 201 : 200);
}

/** Resumes per network and hour (each upload is a whole save file). */
const RESUME_LIMIT = 10;
/**
 * Largest resume upload: the orders (the order log limit), the map and room
 * for the rest of the file. Checked from Content-Length before reading.
 */
const RESUME_MAX_BYTES = LOG_MAX_BYTES + MAP_MAX_BYTES + 256 * 1024;

/**
 * POST /api/sessions/<id>/resume: the host loads a saved online game into
 * its lobby (docs/contracts.md section 4, "Online saves"). Cheap checks first
 * (member header, account, quota, the host role, Content-Length), then the
 * file is checked strictly (orders within the order log limit while they are
 * validated) and against the server's record of the save: the same save
 * point, state hash, orders, options, map and game version, and the
 * requester's account played in it.
 */
async function sessionResume(ctx, id) {
  checkJsonType(ctx.request);
  const member = memberOf(ctx.request);
  const stub = sessionStub(ctx.env, id);
  const account = await requirePlay(ctx);
  if (!account) throw new HttpError(403, 'account_required', 'Resuming an online game needs a signed-in account.');
  if (!(await takeQuota(ctx.env.DB, ctx.salt(), 'resume', ctx.ip, RESUME_LIMIT, UPLOAD_WINDOW_MS, ctx.now))) {
    throw new HttpError(429, 'rate_limited', 'Too many resumed games. Try again later.', { 'retry-after': '3600' }, { retryAfter: 3600 });
  }
  const declared = ctx.request.headers.get('Content-Length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > RESUME_MAX_BYTES)) {
    throw new HttpError(413, 'too_large', 'This saved game is too large to resume online.');
  }
  // Only the host's own upload is read at all.
  rpcResult(await stub.checkHost({ member, account, ip: ctx.ip }));
  const parsed = await parseReplay(await readText(ctx.request, RESUME_MAX_BYTES), { maxBytes: RESUME_MAX_BYTES, maxFrameBytes: LOG_MAX_BYTES });
  if (!parsed.ok) {
    if (parsed.code === 'too_large') throw new HttpError(413, 'too_large', 'This game is too long to resume online.');
    throw new HttpError(422, 'invalid', `Invalid save: ${parsed.error}.`);
  }
  const save = parsed.replay;
  if (save.kind !== 'save' || save.mode !== 'online') throw new HttpError(422, 'invalid', 'This is not a saved online game.');
  const record = await loadSaveRecord(ctx.env.DB, save.online.id);
  if (!record) throw new HttpError(404, 'not_found', 'The server no longer knows this saved game (records are kept for 90 days).');
  const same =
    record.ticks === save.ticks &&
    record.stateHash === save.hashes.at(-1)[1] &&
    record.engine === save.engine &&
    record.mapHash === (save.mission ? await missionDigest(save.mission) : save.mapHash) &&
    record.framesDigest === (await framesDigest(save.frames)) &&
    record.optionsDigest === (await optionsDigest(save.options));
  if (!same) throw new HttpError(409, 'invalid', 'This file does not match the saved game on the server.');
  const seats = save.options.players.map((p, i) => (p.type === 'human' ? (record.members.find((m) => m.seat === i)?.userId ?? null) : null));
  if (save.options.players.some((p, i) => p.type === 'human' && seats[i] === null)) throw new HttpError(409, 'invalid', 'A player of this saved game no longer exists.');
  if (!seats.includes(account.id)) throw new HttpError(403, 'forbidden', 'You did not play in this saved game.');
  // A saved game keeps the map it was played on: never upgraded (saves are pinned to their engine anyway).
  const prepared = save.map ? await prepareMap(save.map, undefined, { upgrade: false }) : null;
  const r = rpcResult(
    await stub.loadSave({
      member,
      account,
      ip: ctx.ip,
      resume: { id: record.id, title: record.title, createdAt: record.createdAt, engine: save.engine, ticks: save.ticks, hash: record.stateHash, options: save.options, seats, mapHash: save.mapHash },
      frames: save.frames,
      prepared,
      mission: save.mission ?? null,
    }),
  );
  return json({ id: record.id, ok: r.ok });
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
  m = /^\/api\/sessions\/([^/]+)\/map$/.exec(path);
  if (m) {
    if (method === 'GET') return sessionMapGet(ctx, m[1]);
    if (method === 'POST') return sessionMapShare(ctx, m[1]);
    throw methodNotAllowed('GET, POST');
  }
  m = /^\/api\/sessions\/([^/]+)\/resume$/.exec(path);
  if (m) {
    if (method !== 'POST') throw methodNotAllowed('POST');
    return sessionResume(ctx, m[1]);
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
    const user = await requireRelay(ctx);
    return quickInstall(request, env, ctx.ip, user, { salt: ctx.salt(), waitUntil: (p) => exec.waitUntil(p.catch(() => {})) });
  }
  if (path === '/api/content/ra-scores') {
    // The Red Alert music: byte ranges of scores.mix from the freeware CD images, streamed, never stored (cdmusic.js).
    if (method !== 'GET') throw methodNotAllowed('GET');
    const user = await requireRelay(ctx);
    return scoresRange(request, env, ctx.ip, user, { salt: ctx.salt(), waitUntil: (p) => exec.waitUntil(p.catch(() => {})) });
  }
  m = /^\/api\/content\/ra-movies\/(allied|soviet)$/.exec(path);
  if (m) {
    // The mission movies: byte ranges of movies1.mix or movies2.mix from the freeware CD images, streamed, never stored (cdmusic.js).
    if (method !== 'GET') throw methodNotAllowed('GET');
    const user = await requireRelay(ctx);
    return moviesRange(request, env, ctx.ip, user, m[1], { salt: ctx.salt(), waitUntil: (p) => exec.waitUntil(p.catch(() => {})) });
  }
  m = /^\/api\/maps\/([^/]+)\/thumbnail\.png$/.exec(path);
  if (m) {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return getMapThumbnail(env, m[1], { request, ip: ctx.ip, salt: ctx.salt(), exec, cache: globalThis.caches?.default ?? null, now: ctx.now });
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

export default withTelemetry({
  async fetch(request, env, exec) {
    const url = new URL(request.url);
    if (isPlayPath(url.pathname)) return servePlay(request, env, exec);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const ctx = newContext(request, env, exec);
    try {
      return await route(ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        reportHttpError(err);
        return withCookies(errorResponse(err.status, err.code, err.message, err.headers, err.extra), ctx.cookies);
      }
      // Never echo internals or request data; log only the error type and message (and report it).
      logError('api error', err);
      return withCookies(errorResponse(500, 'internal', 'Internal error.'), ctx.cookies);
    }
  },
  scheduled,
});
