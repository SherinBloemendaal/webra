// Replays in accounts: /api/account/replays (docs/accounts-api.md 5.10,
// docs/security.md "Replays in your account").
//
// The game uploads the replay of every game a signed-in player finishes or
// leaves (account setting `privacy.cloudReplays`, on by default). The file
// is checked like any replay file (the protocol's parseReplay), stored once
// per account and content (SHA-256) as a gzip object in the R2 bucket bound
// as REPLAYS, and listed from D1 (`account_replays`). Limits per account:
// ACCOUNT_REPLAYS_MAX replays and ACCOUNT_REPLAYS_BYTES_MAX stored bytes; an
// upload that goes over removes the oldest ones in the same D1 batch that
// adds it, so the limits hold whatever runs at the same time. Each replay is
// deleted ACCOUNT_REPLAY_RETENTION_MS after its upload (the daily job,
// src/accounts/cron.js), with the account, or by the player.
//
// R2 objects are never deleted in the same step as their rows: every removed
// row queues its object in `replay_object_trash` (a trigger, migration
// 0008), and `drainReplayTrash` deletes queued objects after the change and
// again in the daily job, so a failed delete is retried and an object never
// outlives its row by more than a day. An upload queues its own object before
// writing it (ready an hour later) and takes it out of the queue in the
// batch that adds the row, so an upload that fails halfway leaves nothing.

import {
  ACCOUNT_REPLAY_ID_RE,
  ACCOUNT_REPLAY_MAX_BYTES,
  ACCOUNT_REPLAY_RESULTS,
  ACCOUNT_REPLAY_RETENTION_MS,
  ACCOUNT_REPLAYS_BYTES_MAX,
  ACCOUNT_REPLAYS_MAX,
  parseReplay,
  replaySummary,
} from '@webra/protocol';
import { HttpError, json, readBody } from '../http.js';
import { randomHex } from '../crypto.js';
import { checkJsonType } from '../maps.js';
import { invalid } from './context.js';
import { notify, originOf, publishToUsers } from '../realtime/publish.js';

const HOUR = 60 * 60 * 1000;
/** Uploads per account and hour (one per game; retries of a failed one count too). */
export const REPLAY_UPLOAD_LIMIT = 60;
/** Downloads (Watch and Download) per account and hour. */
export const REPLAY_DOWNLOAD_LIMIT = 300;
/** An upload's object is deleted this long after the upload started unless its row was added. */
export const PENDING_OBJECT_MS = HOUR;
/** Objects deleted per round (D1 binds at most 100 parameters per statement). */
const TRASH_BATCH = 100;
/** Expired rows removed per statement in the daily job. */
const EXPIRE_BATCH = 500;

const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
const notFound = () => new HttpError(404, 'not_found', 'No such replay.');

/** The bucket, or 503 when this server has none (wrangler.jsonc `r2_buckets`). */
function bucketOf(env) {
  const bucket = env.REPLAYS;
  if (!bucket || typeof bucket.put !== 'function') throw new HttpError(503, 'unavailable', 'Replays cannot be kept in accounts on this server.');
  return bucket;
}

/** Whether this server keeps replays in accounts (the same test as GET /api/site `services.replays`, site.js). */
export function replaysAvailable(env) {
  return Boolean(env?.REPLAYS) && typeof env.REPLAYS.put === 'function';
}

export const objectKey = (userId, id) => `replays/${userId}/${id}`;

function parsePlayers(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** A row as the API answers it. */
export function replayView(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    size: r.size,
    rawSize: r.raw_size,
    engine: r.engine,
    mode: r.mode,
    title: r.title,
    mapName: r.map_name,
    players: parsePlayers(r.players),
    playedAt: r.played_at,
    ticks: r.ticks,
    result: r.result,
  };
}

/** Rows (not expired) of an account, newest first. */
export async function listReplayRows(db, userId, now) {
  const { results } = await db
    .prepare('SELECT * FROM account_replays WHERE user_id = ?1 AND expires_at > ?2 ORDER BY created_at DESC, rowid DESC')
    .bind(userId, now)
    .all();
  return results;
}

/** Statement that deletes every replay of an account (its objects are queued for deletion). */
export function deleteAccountReplaysStatement(db, userId) {
  return db.prepare('DELETE FROM account_replays WHERE user_id = ?1').bind(userId);
}

/**
 * Statement that removes the account's oldest replays until the newest fit
 * ACCOUNT_REPLAYS_MAX and ACCOUNT_REPLAYS_BYTES_MAX (RETURNING the ids).
 */
function evictStatement(db, userId) {
  return db
    .prepare(
      `DELETE FROM account_replays WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER w AS n, SUM(size) OVER (w ROWS UNBOUNDED PRECEDING) AS total
           FROM account_replays WHERE user_id = ?1
           WINDOW w AS (ORDER BY created_at DESC, rowid DESC)
         ) WHERE n > ?2 OR total > ?3
       ) RETURNING id`,
    )
    .bind(userId, ACCOUNT_REPLAYS_MAX, ACCOUNT_REPLAYS_BYTES_MAX);
}

/** Gzip the uploaded bytes as they came (no second encoding of the text). */
async function gzip(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** SHA-256 (hex) of the uploaded bytes: the same digest as the protocol's sha256Hex of their text. */
async function sha256Bytes(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function resultOf(url) {
  const v = url.searchParams.get('result');
  if (v === null) return 'unknown';
  if (!ACCOUNT_REPLAY_RESULTS.includes(v)) throw invalid('result', `result must be one of ${ACCOUNT_REPLAY_RESULTS.join(', ')}.`);
  return v;
}

const isHashConflict = (err) => /UNIQUE constraint failed: account_replays\.(user_id|content_hash)/.test(String(err?.message ?? ''));

/** Queue an upload's object for deletion now (the upload did not keep it). */
async function releasePending(db, key) {
  await db.prepare('UPDATE replay_object_trash SET ready_at = 0 WHERE r2_key = ?1').bind(key).run();
}

/**
 * POST /api/account/replays[?result=]: the body is the replay file
 * (application/json, at most ACCOUNT_REPLAY_MAX_BYTES). 201 with the new
 * replay; 200 with `duplicate: true` and the stored one when the account
 * already has this file. `evicted`: how many old replays made room.
 */
async function uploadReplay(ctx) {
  const user = await ctx.requireUser({ active: true });
  const bucket = bucketOf(ctx.env);
  checkJsonType(ctx.request);
  const result = resultOf(ctx.url);
  await ctx.limit('replay-upload', user.id, REPLAY_UPLOAD_LIMIT, HOUR, 'Too many replays uploaded. Try again later.');
  // Peak memory of a 4 MiB upload: the bytes, their text and the parsed replay; the text goes
  // out of reach after parsing, the replay after its summary, so only the bytes reach R2.
  const body = await readBody(ctx.request, ACCOUNT_REPLAY_MAX_BYTES);
  const bytes = body.bytes;
  const parsed = await parseReplay(body.text, { maxBytes: ACCOUNT_REPLAY_MAX_BYTES });
  body.text = null;
  if (!parsed.ok) {
    if (parsed.code === 'too_large') throw new HttpError(413, 'too_large', 'This replay is too large to keep in your account.');
    throw new HttpError(422, 'invalid', `Invalid replay: ${parsed.error}.`);
  }
  if (parsed.replay.kind !== 'replay') throw new HttpError(422, 'invalid', 'This is a saved game, not a replay.');
  const summary = replaySummary(parsed.replay);
  parsed.replay = null;
  const db = ctx.db;
  const hash = await sha256Bytes(bytes);
  const stored = async () => db.prepare('SELECT * FROM account_replays WHERE user_id = ?1 AND content_hash = ?2 AND expires_at > ?3').bind(user.id, hash, ctx.now).first();
  const existing = await stored();
  if (existing) return json({ replay: replayView(existing), duplicate: true });

  const gz = await gzip(bytes);
  const id = randomHex(8);
  const key = objectKey(user.id, id);
  await db.prepare('INSERT INTO replay_object_trash (r2_key, ready_at) VALUES (?1, ?2)').bind(key, ctx.now + PENDING_OBJECT_MS).run();
  let results;
  try {
    await bucket.put(key, gz, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { user: user.id, engine: summary.engine } });
    results = await db.batch([
      // An expired copy (the daily job has not run yet) makes way for this one.
      db.prepare('DELETE FROM account_replays WHERE user_id = ?1 AND expires_at <= ?2').bind(user.id, ctx.now),
      db
        .prepare(
          `INSERT INTO account_replays (id, user_id, r2_key, created_at, expires_at, size, raw_size, content_hash, engine, mode, title, map_name, players, played_at, ticks, result)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
        )
        .bind(
          id,
          user.id,
          key,
          ctx.now,
          ctx.now + ACCOUNT_REPLAY_RETENTION_MS,
          gz.byteLength,
          bytes.byteLength,
          hash,
          summary.engine,
          summary.mode,
          summary.title,
          summary.mapName,
          JSON.stringify(summary.players),
          summary.playedAt,
          summary.ticks,
          result,
        ),
      db.prepare('DELETE FROM replay_object_trash WHERE r2_key = ?1').bind(key),
      evictStatement(db, user.id),
    ]);
  } catch (err) {
    await releasePending(db, key).catch(() => {});
    ctx.background('replay trash', () => drainReplayTrash(ctx.env, ctx.now));
    // The same file uploaded twice at once: the other upload stored it.
    if (isHashConflict(err)) {
      const other = await stored();
      if (other) return json({ replay: replayView(other), duplicate: true });
    }
    throw err;
  }
  const evicted = results[3].results?.length ?? 0;
  ctx.background('replay trash', () => drainReplayTrash(ctx.env, ctx.now));
  replaysHint(ctx, user, 'added', id);
  const row = await db.prepare('SELECT * FROM account_replays WHERE id = ?1').bind(id).first();
  return json({ replay: replayView(row), evicted }, 201);
}

/** GET /api/account/replays: the account's replays (newest first), what they use and the limits. */
async function listReplays(ctx) {
  const user = await ctx.requireUser();
  const rows = await listReplayRows(ctx.db, user.id, ctx.now);
  return json({
    replays: rows.map(replayView),
    usage: { count: rows.length, bytes: rows.reduce((n, r) => n + r.size, 0) },
    limits: { count: ACCOUNT_REPLAYS_MAX, bytes: ACCOUNT_REPLAYS_BYTES_MAX, retentionMs: ACCOUNT_REPLAY_RETENTION_MS, uploadBytes: ACCOUNT_REPLAY_MAX_BYTES },
    available: replaysAvailable(ctx.env),
  });
}

async function ownReplay(ctx, user, id) {
  if (typeof id !== 'string' || !ACCOUNT_REPLAY_ID_RE.test(id)) throw notFound();
  const row = await ctx.db.prepare('SELECT * FROM account_replays WHERE id = ?1 AND user_id = ?2 AND expires_at > ?3').bind(id, user.id, ctx.now).first();
  if (!row) throw notFound();
  return row;
}

/** A file name for the download: letters, digits and dashes (like the game's recordFileName). */
export function replayFileName(row) {
  // The protocol keeps createdAt within the Date range; a row from before that check gets no date.
  const when = new Date(row.played_at);
  const date = Number.isNaN(when.getTime()) ? 'undated' : when.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const title = row.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'game';
  return `webra-replay-${title}-${date}.json`;
}

/** GET /api/account/replays/<id>: the replay file (owner only). */
async function downloadReplay(ctx, { id }) {
  const user = await ctx.requireUser();
  const bucket = bucketOf(ctx.env);
  const row = await ownReplay(ctx, user, id);
  await ctx.limit('replay-download', user.id, REPLAY_DOWNLOAD_LIMIT, HOUR, 'Too many replay downloads. Try again later.');
  const obj = await bucket.get(row.r2_key);
  if (!obj) throw new HttpError(404, 'not_found', 'The file of this replay is gone.');
  return new Response(obj.body.pipeThrough(new DecompressionStream('gzip')), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'content-disposition': `attachment; filename="${replayFileName(row)}"`,
    },
  });
}

/** DELETE /api/account/replays/<id> (owner only). */
async function deleteReplay(ctx, { id }) {
  const user = await ctx.requireUser();
  if (typeof id !== 'string' || !ACCOUNT_REPLAY_ID_RE.test(id)) throw notFound();
  const { results } = await ctx.db.prepare('DELETE FROM account_replays WHERE id = ?1 AND user_id = ?2 RETURNING id').bind(id, user.id).all();
  if (!results.length) throw notFound();
  ctx.background('replay trash', () => drainReplayTrash(ctx.env, ctx.now));
  replaysHint(ctx, user, 'removed', id);
  return noContent();
}

/** After the answer: the account's other open replay lists load again (the device that did it has the change). */
function replaysHint(ctx, user, kind, id) {
  notify(ctx, async (env) => publishToUsers(env, [user.id], { topic: 'replays', kind, data: { id }, origin: await originOf(ctx) }));
}

/**
 * Delete queued objects that are ready (`rounds` of TRASH_BATCH); returns
 * how many. Without the bucket nothing is deleted (the queue waits).
 * Idempotent: deleting a missing object succeeds.
 */
export async function drainReplayTrash(env, now = Date.now(), { rounds = 5 } = {}) {
  const bucket = env.REPLAYS;
  if (!bucket || typeof bucket.delete !== 'function') return 0;
  const db = env.DB;
  let n = 0;
  for (let i = 0; i < rounds; i++) {
    const { results } = await db.prepare('SELECT r2_key FROM replay_object_trash WHERE ready_at <= ?1 LIMIT ?2').bind(now, TRASH_BATCH).all();
    if (!results.length) break;
    const keys = results.map((r) => r.r2_key);
    await bucket.delete(keys);
    await db
      .prepare(`DELETE FROM replay_object_trash WHERE r2_key IN (${keys.map((_, j) => `?${j + 1}`).join(', ')})`)
      .bind(...keys)
      .run();
    n += keys.length;
    if (keys.length < TRASH_BATCH) break;
  }
  return n;
}

/**
 * The daily job: delete replays older than the retention (in batches, at
 * most `rounds` of EXPIRE_BATCH a run) and then their objects. Returns
 * `{ expired, objects }`.
 */
export async function expireReplays(env, now = Date.now(), { rounds = 20 } = {}) {
  const db = env.DB;
  let expired = 0;
  for (let i = 0; i < rounds; i++) {
    const { results } = await db
      .prepare('DELETE FROM account_replays WHERE id IN (SELECT id FROM account_replays WHERE expires_at <= ?1 LIMIT ?2) RETURNING id')
      .bind(now, EXPIRE_BATCH)
      .all();
    expired += results.length;
    if (results.length < EXPIRE_BATCH) break;
  }
  const objects = await drainReplayTrash(env, now, { rounds: 50 });
  return { expired, objects };
}

export function registerReplayRoutes(router) {
  const csrfRead = { csrfRead: true };
  router
    .add('GET', '/api/account/replays', listReplays, csrfRead)
    .add('POST', '/api/account/replays', uploadReplay)
    .add('GET', '/api/account/replays/:id', downloadReplay, csrfRead)
    .add('DELETE', '/api/account/replays/:id', deleteReplay);
}
