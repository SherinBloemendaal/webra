// Uploaded maps in D1. Uploads are validated with packages/protocol and then by
// the engine itself (WebAssembly), stored as canonical JSON, deduplicated by hash
// and rate limited per IP.
//
// Map versions (docs/contracts.md section 2): an upload of an older format
// version is upgraded before it is validated, hashed and stored, so a row
// always holds the map every client plays. Rows stored before a later format
// change are upgraded when they are first read (upgradeStoredMap): json and
// hash are rewritten in place, the old hash stays resolvable (map_aliases).
// Maps that cannot be upgraded automatically are refused with the message
// players see everywhere ("made for WebRA x.y ... save it again").
//
// Two kinds of rows (docs/security.md, "Map sharing"): listed maps, published
// to the community map list (POST /api/maps), and unlisted maps a host shared
// with one online session (POST /api/sessions/<id>/map). Unlisted maps are
// never listed, never served by id and cannot be picked into a lobby by id;
// the session serves them to its own members only (session.js). Publishing a
// map that was shared before lists it.

import { incompatibleMapMessage, MAP_ID_RE, MAP_MAX_BYTES, MAP_VERSIONS, parseMap, SHA256_RE, sha256Hex } from '@webra/protocol';
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
/** Rows of an older format version a map list request upgrades first (the rest are left out until upgraded). */
export const LIST_UPGRADE_BATCH = 25;
/** Rows of an older format version the daily job upgrades. */
export const DAILY_UPGRADE_BATCH = 200;

/**
 * Validate map text and compute its identity. Pure apart from WebCrypto.
 * An older format version is upgraded first (packages/protocol mapversions.js):
 * the result is the map as every client plays it. `judge` is the engine
 * instance (tests pass their own); `versions` the format version registry
 * (tests); `upgrade: false` keeps the map as given (saved games: they keep
 * the map they were played on).
 */
export async function prepareMap(textValue, judge = engine(), { versions = MAP_VERSIONS, upgrade = true } = {}) {
  const r = parseMap(textValue, { rules: ENGINE_RULES, versions, upgrade });
  if (!r.ok) {
    // A format version problem has one sentence players act on; anything else lists the reasons.
    if (r.compat) throw new HttpError(422, 'invalid', r.compat.message);
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
    const why = verdict.errors.slice(0, 5).map((e) => String(e).slice(0, 120)).join('; ');
    // Fine for the release that made it, refused after the upgrade: not compatible any more.
    if (r.upgrade) throw new HttpError(422, 'invalid', `${incompatibleMapMessage(r.upgrade.from, r.writtenBy, versions)} (${why})`);
    throw new HttpError(422, 'invalid', `Invalid map: ${why}`);
  }
  if (verdict.hash !== hash || verdict.modded !== r.modded) {
    throw new HttpError(500, 'internal', 'Map identity check failed.');
  }
  return { map: r.map, canonical: r.canonical, hash, modded: r.modded, players: r.players, formatVersion: r.map.formatVersion, upgradedFrom: r.upgrade?.from ?? null };
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
      `INSERT INTO maps (id, name, author, players, width, height, hash, modded, json, downloads, created_at, uploader_id, listed, used_at, format_version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT(hash) DO UPDATE SET
         listed = MAX(maps.listed, excluded.listed),
         uploader_id = COALESCE(maps.uploader_id, excluded.uploader_id),
         used_at = COALESCE(excluded.used_at, maps.used_at)`,
    )
    .bind(id, p.map.name, p.map.author, p.players, p.map.width, p.map.height, p.hash, p.modded ? 1 : 0, p.canonical, now, uploaderId, listed ? 1 : 0, listed ? null : now, p.formatVersion)
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
  // `upgradedFrom`: the file was of an older format version (what was stored is the upgraded map).
  return json({ id: stored.id, hash: stored.hash, ...(p.upgradedFrom ? { upgradedFrom: p.upgradedFrom } : {}) }, stored.created ? 201 : 200);
}

export function checkJsonType(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!/^application\/json\s*(;|$)/i.test(type)) throw new HttpError(415, 'bad_message', 'Content-Type must be application/json.');
}

/**
 * The community map list. Rows of an older format version are upgraded first
 * (LIST_UPGRADE_BATCH per request; the daily job does the rest), so every
 * hash listed is the hash clients compute. Rows waiting for their upgrade
 * and rows that cannot be upgraded are left out.
 */
export async function listMaps(env, { judge, versions = MAP_VERSIONS, now = Date.now() } = {}) {
  await upgradeStaleMaps(env.DB, { judge, versions, now, limit: LIST_UPGRADE_BATCH, listedOnly: true });
  const { results } = await env.DB.prepare(
    `SELECT id, name, author, players, width, height, hash, modded, downloads, created_at
     FROM maps WHERE listed = 1 AND format_version = ?1 AND upgrade_error IS NULL ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
  )
    .bind(versions.current)
    .all();
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

/**
 * A listed map by id (unlisted maps are not found: their sessions serve them).
 * An id an upgrade merged away still finds its map. A map that cannot be
 * upgraded is still served as stored: clients upgrade every map they load
 * and show why this one is not compatible, and the map editor opens it for
 * repair.
 */
export async function getMap(env, ctx, id, { judge, versions = MAP_VERSIONS, now = Date.now() } = {}) {
  if (!MAP_ID_RE.test(id)) throw new HttpError(404, 'not_found', 'No such map.');
  const found = await rowById(env.DB, id);
  if (!found || found.listed !== 1) throw new HttpError(404, 'not_found', 'No such map.');
  const row = await upgradeStoredMap(env.DB, found, { judge, versions, now });
  if (!row) throw new HttpError(404, 'not_found', 'No such map.');
  ctx.waitUntil(env.DB.prepare('UPDATE maps SET downloads = downloads + 1 WHERE id = ?1').bind(row.id).run());
  // A map id names the same map; after a format upgrade a client that cached
  // the old text upgrades it to exactly this.
  return jsonText(row.json, 200, { 'cache-control': 'public, max-age=3600' });
}

const SUMMARY_COLUMNS = 'id, name, author, hash, modded, players, width, height, listed, LENGTH(CAST(json AS BLOB)) AS bytes';
/** What upgradeStoredMap needs besides the summary. */
const ROW_COLUMNS = `${SUMMARY_COLUMNS}, json, format_version, upgrade_error, downloads, uploader_id, used_at`;

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

/** The row with this id, or the row an upgrade merged it into. */
async function rowById(db, id) {
  const row = await db.prepare(`SELECT ${ROW_COLUMNS} FROM maps WHERE id = ?1`).bind(id).first();
  if (row) return row;
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM maps WHERE hash = (SELECT hash FROM map_aliases WHERE old_id = ?1 LIMIT 1)`).bind(id).first();
}

/** The row with this hash, or the row that holds the map since an upgrade changed its hash. */
async function rowByHash(db, hash) {
  const row = await db.prepare(`SELECT ${ROW_COLUMNS} FROM maps WHERE hash = ?1`).bind(hash).first();
  if (row) return row;
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM maps WHERE hash = (SELECT hash FROM map_aliases WHERE old_hash = ?1)`).bind(hash).first();
}

/**
 * Bring a stored row to the current format version (docs/contracts.md
 * "Map versions"): prepareMap upgrades and validates its text exactly like
 * an upload, then json, hash and summary are rewritten in place (same id),
 * and the old hash goes to map_aliases (aliases of the old hash follow). When
 * another row already holds the upgraded map, the two merge into that one
 * (listed if either was, downloads added up) and the old id becomes an alias
 * too. A row that cannot be upgraded keeps its text and gets `upgrade_error`
 * (the compatibility message). Returns the row as it is now (ROW_COLUMNS), or
 * null when it is gone. Rows already current come back untouched.
 */
export async function upgradeStoredMap(db, row, { judge, versions = MAP_VERSIONS, now = Date.now() } = {}) {
  if (row.format_version >= versions.current || row.upgrade_error !== null) return row;
  let p;
  try {
    p = await prepareMap(row.json, judge ?? engine(), { versions });
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 422) throw err;
    await db.prepare('UPDATE maps SET upgrade_error = ?2 WHERE id = ?1').bind(row.id, err.message).run();
    return { ...row, upgrade_error: err.message };
  }
  const other = p.hash === row.hash ? null : await db.prepare('SELECT id FROM maps WHERE hash = ?1').bind(p.hash).first();
  const steps = [];
  if (!other || other.id === row.id) {
    steps.push(
      db
        .prepare('UPDATE maps SET json = ?2, hash = ?3, name = ?4, author = ?5, players = ?6, width = ?7, height = ?8, modded = ?9, format_version = ?10 WHERE id = ?1')
        .bind(row.id, p.canonical, p.hash, p.map.name, p.map.author, p.players, p.map.width, p.map.height, p.modded ? 1 : 0, p.formatVersion),
    );
  } else {
    steps.push(
      db
        .prepare(
          `UPDATE maps SET listed = MAX(listed, ?2), uploader_id = COALESCE(uploader_id, ?3), downloads = downloads + ?4,
             used_at = CASE WHEN ?5 IS NULL THEN used_at WHEN used_at IS NULL THEN ?5 ELSE MAX(used_at, ?5) END
           WHERE id = ?1`,
        )
        .bind(other.id, row.listed, row.uploader_id, row.downloads, row.used_at),
      db.prepare('DELETE FROM maps WHERE id = ?1').bind(row.id),
    );
  }
  if (p.hash !== row.hash) {
    steps.push(
      db.prepare('UPDATE map_aliases SET hash = ?2 WHERE hash = ?1').bind(row.hash, p.hash),
      db
        .prepare('INSERT INTO map_aliases (old_hash, old_id, hash, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(old_hash) DO UPDATE SET hash = excluded.hash')
        .bind(row.hash, row.id, p.hash, now),
    );
  }
  await db.batch(steps);
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM maps WHERE hash = ?1`).bind(p.hash).first();
}

/**
 * Upgrade up to `limit` rows of an older format version (oldest first;
 * `listedOnly`: published maps only). Returns `{ upgraded, failed }`. Rows
 * that cannot be upgraded are marked and not tried again.
 */
export async function upgradeStaleMaps(db, { judge, versions = MAP_VERSIONS, now = Date.now(), limit, listedOnly = false } = {}) {
  const { results } = await db
    .prepare(`SELECT ${ROW_COLUMNS} FROM maps WHERE format_version < ?1 AND upgrade_error IS NULL ${listedOnly ? 'AND listed = 1' : ''} ORDER BY created_at LIMIT ?2`)
    .bind(versions.current, limit)
    .all();
  const done = { upgraded: 0, failed: 0 };
  for (const row of results) {
    const after = await upgradeStoredMap(db, row, { judge: judge ?? engine(), versions, now });
    if (after?.upgrade_error) done.failed++;
    else done.upgraded++;
  }
  return done;
}

/**
 * The lobby's summary of a listed map a host picked by id and hash (the host
 * sends only those), upgraded to the current format version first. A hash
 * the map had before an upgrade still matches. Returns the summary, null
 * (unknown, unlisted or another map) or `{ incompatible: message }`.
 * Unlisted maps cannot be picked by id.
 */
export async function lookupMap(db, id, hash, { judge, versions = MAP_VERSIONS, now = Date.now() } = {}) {
  if (!MAP_ID_RE.test(id) || typeof hash !== 'string' || !SHA256_RE.test(hash)) return null;
  const found = await rowById(db, id);
  if (!found || found.listed !== 1) return null;
  const row = await upgradeStoredMap(db, found, { judge, versions, now });
  if (!row) return null;
  if (row.hash !== hash && found.hash !== hash) {
    const alias = await db.prepare('SELECT 1 FROM map_aliases WHERE old_hash = ?1 AND hash = ?2').bind(hash, row.hash).first();
    if (!alias) return null;
  }
  if (row.upgrade_error) return { incompatible: row.upgrade_error };
  return summaryOf(row);
}

/**
 * The canonical text of the map with `hash` (any row: the caller checked who
 * may have it), upgraded to the current format version, or null. A hash the
 * map had before an upgrade still finds it.
 */
export async function mapTextByHash(db, hash, now = Date.now(), { judge, versions = MAP_VERSIONS } = {}) {
  const found = await rowByHash(db, hash);
  if (!found) return null;
  const row = await upgradeStoredMap(db, found, { judge, versions, now });
  if (!row) return null;
  await db.prepare('UPDATE maps SET used_at = ?2 WHERE id = ?1 AND listed = 0').bind(row.id, now).run();
  return row.json;
}

/** Delete unlisted maps no session used for UNLISTED_RETENTION_MS (daily job). */
export function pruneSharedMapsStatement(db, now) {
  return db.prepare('DELETE FROM maps WHERE listed = 0 AND COALESCE(used_at, created_at) < ?1').bind(now - UNLISTED_RETENTION_MS);
}
