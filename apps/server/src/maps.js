// Uploaded maps in D1. Uploads are validated with packages/protocol and then by
// the engine itself (WebAssembly), stored as canonical JSON, deduplicated by hash
// and rate limited per IP.

import { MAP_ID_RE, MAP_MAX_BYTES, parseMap, sha256Hex } from '@webra/protocol';
import ENGINE_RULES from '../../../engine/rules.json' with { type: 'json' };
import { randomHex } from './crypto.js';
import { engine, EngineTrap } from './engine.js';
import { HttpError, json, jsonText, readText } from './http.js';
import { ipSalt } from './ipkey.js';
import { takeQuota } from './quota.js';

export const UPLOAD_LIMIT = 10;
export const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
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

/** `uploaderId`: the signed-in account (stored with the map), or null. */
export async function uploadMap(request, env, ip, now = Date.now(), uploaderId = null, salt = ipSalt(env, request)) {
  const type = request.headers.get('Content-Type') || '';
  if (!/^application\/json\s*(;|$)/i.test(type)) throw new HttpError(415, 'bad_message', 'Content-Type must be application/json.');
  if (!(await takeQuota(env.DB, salt, 'maps', ip, UPLOAD_LIMIT, UPLOAD_WINDOW_MS, now))) {
    throw new HttpError(429, 'rate_limited', 'Too many map uploads. Try again later.', { 'retry-after': '3600' });
  }
  const p = await prepareMap(await readText(request, MAP_MAX_BYTES));
  const id = randomHex(8);
  await env.DB.prepare(
    `INSERT INTO maps (id, name, author, players, width, height, hash, modded, json, downloads, created_at, uploader_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11)
     ON CONFLICT(hash) DO NOTHING`,
  )
    .bind(id, p.map.name, p.map.author, p.players, p.map.width, p.map.height, p.hash, p.modded ? 1 : 0, p.canonical, now, uploaderId)
    .run();
  const row = await env.DB.prepare('SELECT id FROM maps WHERE hash = ?1').bind(p.hash).first();
  if (!row) throw new HttpError(500, 'internal', 'The map could not be stored.');
  return json({ id: row.id, hash: p.hash }, row.id === id ? 201 : 200);
}

export async function listMaps(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, author, players, width, height, hash, modded, downloads, created_at
     FROM maps ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
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

export async function getMap(env, ctx, id) {
  if (!MAP_ID_RE.test(id)) throw new HttpError(404, 'not_found', 'No such map.');
  const row = await env.DB.prepare('SELECT json FROM maps WHERE id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'not_found', 'No such map.');
  ctx.waitUntil(env.DB.prepare('UPDATE maps SET downloads = downloads + 1 WHERE id = ?1').bind(id).run());
  // A map id always names the same content.
  return jsonText(row.json, 200, { 'cache-control': 'public, max-age=3600' });
}

/** Trusted summary of a stored map for the session (host sends only id + hash). */
export async function lookupMap(db, id) {
  if (!MAP_ID_RE.test(id)) return null;
  const row = await db.prepare('SELECT id, name, hash, modded, players FROM maps WHERE id = ?1').bind(id).first();
  if (!row) return null;
  return { id: row.id, hash: row.hash, name: row.name, modded: row.modded === 1, players: row.players };
}
