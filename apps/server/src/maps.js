// Uploaded maps in D1. Uploads are validated with packages/protocol and then by
// the engine itself (WebAssembly), stored as canonical JSON, deduplicated by hash
// and rate limited per IP.
//
// Two kinds of rows (docs/security.md, "Map sharing"): listed maps, published
// to the community map list (POST /api/maps), and unlisted maps a host shared
// with one online session (POST /api/sessions/<id>/map). Unlisted maps are
// never listed, never served by id and cannot be picked into a lobby by id;
// the session serves them to its own members only (session.js). Publishing a
// map that was shared before lists it.

import { MAP_ID_RE, MAP_MAX_BYTES, parseMap, sha256Hex } from '@webra/protocol';
import ENGINE_RULES from '../../../engine/rules.json' with { type: 'json' };
import { randomHex } from './crypto.js';
import { engine, EngineTrap } from './engine.js';
import { HttpError, json, jsonText, readText } from './http.js';
import { ipSalt } from './ipkey.js';
import { takeQuota } from './quota.js';

export const UPLOAD_LIMIT = 10;
export const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
/** Session map downloads per network and hour (GET /api/sessions/<id>/map). */
export const SESSION_MAP_GET_LIMIT = 120;
/** Unlisted (shared) maps that no session used for this long are deleted (daily job). */
export const UNLISTED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

/**
 * Validate map text and compute its identity. Pure apart from WebCrypto.
 * `judge` is the engine instance (tests pass their own).
 */
export async function prepareMap(textValue, judge = engine()) {
  const r = parseMap(textValue, { rules: ENGINE_RULES });
  if (!r.ok) {
    throw new HttpError(422, 'invalid', `Invalid map: ${r.errors.slice(0, 5).join('; ')}`);
  }
  const hash = await sha256Hex(r.canonical);
  // Second gate: the engine itself (spawn ground, connectivity, actor types,
  // rules overrides), so nothing reaches players that their client would refuse.
  let verdict;
  try {
    verdict = judge.validateMap(r.canonical);
  } catch (err) {
    // A map the engine traps on would trap every client too: refuse it like any invalid map.
    if (err instanceof EngineTrap) throw new HttpError(422, 'invalid', 'Invalid map: the engine could not check it.');
    throw err;
  }
  if (!verdict.ok) {
    throw new HttpError(422, 'invalid', `Invalid map: ${verdict.errors.slice(0, 5).map((e) => String(e).slice(0, 120)).join('; ')}`);
  }
  if (verdict.hash !== hash || verdict.modded !== r.modded) {
    throw new HttpError(500, 'internal', 'Map identity check failed.');
  }
  return { map: r.map, canonical: r.canonical, hash, modded: r.modded, players: r.players };
}

/**
 * Store a prepared map (deduplicated by hash). `listed`: publish it to the
 * community list (an unlisted row with the same hash becomes listed);
 * otherwise an existing row keeps its state and only its use time moves.
 * Returns the stored row's summary.
 */
export async function storeMap(db, p, { listed, uploaderId = null, now = Date.now() }) {
  const id = randomHex(8);
  await db
    .prepare(
      `INSERT INTO maps (id, name, author, players, width, height, hash, modded, json, downloads, created_at, uploader_id, listed, used_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13)
       ON CONFLICT(hash) DO UPDATE SET
         listed = MAX(maps.listed, excluded.listed),
         uploader_id = COALESCE(maps.uploader_id, excluded.uploader_id),
         used_at = COALESCE(excluded.used_at, maps.used_at)`,
    )
    .bind(id, p.map.name, p.map.author, p.players, p.map.width, p.map.height, p.hash, p.modded ? 1 : 0, p.canonical, now, uploaderId, listed ? 1 : 0, listed ? null : now)
    .run();
  const row = await db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM maps WHERE hash = ?1`).bind(p.hash).first();
  if (!row) throw new HttpError(500, 'internal', 'The map could not be stored.');
  return { created: row.id === id, ...summaryOf(row) };
}

/** `uploaderId`: the signed-in account (stored with the map), or null. */
export async function uploadMap(request, env, ip, now = Date.now(), uploaderId = null, salt = ipSalt(env, request)) {
  checkJsonType(request);
  if (!(await takeQuota(env.DB, salt, 'maps', ip, UPLOAD_LIMIT, UPLOAD_WINDOW_MS, now))) {
    throw new HttpError(429, 'rate_limited', 'Too many map uploads. Try again later.', { 'retry-after': '3600' });
  }
  const p = await prepareMap(await readText(request, MAP_MAX_BYTES));
  const stored = await storeMap(env.DB, p, { listed: true, uploaderId, now });
  return json({ id: stored.id, hash: stored.hash }, stored.created ? 201 : 200);
}

export function checkJsonType(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!/^application\/json\s*(;|$)/i.test(type)) throw new HttpError(415, 'bad_message', 'Content-Type must be application/json.');
}

export async function listMaps(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, author, players, width, height, hash, modded, downloads, created_at
     FROM maps WHERE listed = 1 ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
  ).all();
  return json(
    results.map((r) => ({
      id: r.id,
      name: r.name,
      author: r.author,
      players: r.players,
      width: r.width,
      height: r.height,
      hash: r.hash,
      modded: r.modded === 1,
      downloads: r.downloads,
      createdAt: r.created_at,
    })),
  );
}

/** A listed map by id (unlisted maps are not found: their sessions serve them). */
export async function getMap(env, ctx, id) {
  if (!MAP_ID_RE.test(id)) throw new HttpError(404, 'not_found', 'No such map.');
  const row = await env.DB.prepare('SELECT json FROM maps WHERE id = ?1 AND listed = 1').bind(id).first();
  if (!row) throw new HttpError(404, 'not_found', 'No such map.');
  ctx.waitUntil(env.DB.prepare('UPDATE maps SET downloads = downloads + 1 WHERE id = ?1').bind(id).run());
  // A map id always names the same content.
  return jsonText(row.json, 200, { 'cache-control': 'public, max-age=3600' });
}

const SUMMARY_COLUMNS = 'id, name, author, hash, modded, players, width, height, listed, LENGTH(CAST(json AS BLOB)) AS bytes';

/** The lobby's description of a stored map (validMapRef `full`), from its row. */
function summaryOf(row) {
  return {
    id: row.id,
    hash: row.hash,
    name: row.name,
    modded: row.modded === 1,
    players: row.players,
    author: row.author,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    shared: row.listed !== 1,
  };
}

/**
 * Trusted summary of a listed map a host picked by id (the host sends only id
 * and hash), or null: unlisted maps cannot be picked by id.
 */
export async function lookupMap(db, id) {
  if (!MAP_ID_RE.test(id)) return null;
  const row = await db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM maps WHERE id = ?1 AND listed = 1`).bind(id).first();
  return row ? summaryOf(row) : null;
}

/** The canonical text of the map with `hash` (any row: the caller checked who may have it), or null. */
export async function mapTextByHash(db, hash, now = Date.now()) {
  const row = await db.prepare('SELECT json FROM maps WHERE hash = ?1').bind(hash).first();
  if (!row) return null;
  await db.prepare('UPDATE maps SET used_at = ?2 WHERE hash = ?1 AND listed = 0').bind(hash, now).run();
  return row.json;
}

/** Delete unlisted maps no session used for UNLISTED_RETENTION_MS (daily job). */
export function pruneSharedMapsStatement(db, now) {
  return db.prepare('DELETE FROM maps WHERE listed = 0 AND COALESCE(used_at, created_at) < ?1').bind(now - UNLISTED_RETENTION_MS);
}
