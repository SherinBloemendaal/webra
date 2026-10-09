// Fixed-window counters for HTTP rate limits and sign-in failures, stored in
// D1. The subject (a client IP, a login name, an account id) is kept only as
// an HMAC under IP_HASH_SALT (src/ipkey.js). `win` holds the start of the
// window (unix milliseconds), so counters of different window lengths live
// side by side and one prune removes them all.
//
// Writes are the scarce resource (the D1 Free plan allows 100,000 row writes
// a day), so a counter is read first and a request that is already over its
// limit costs no write at all.

import { keyedHash } from './ipkey.js';

/** Counters older than this are removed (longer than the longest window, one day). */
export const QUOTA_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

async function quotaKey(salt, purpose, subject) {
  return `${purpose}:${await keyedHash(salt, 'quota', `${purpose}:${subject}`)}`;
}

const windowStart = (now, windowMs) => Math.floor(now / windowMs) * windowMs;

/** Seconds until the current window of `windowMs` ends. */
export function windowRemaining(windowMs, now = Date.now()) {
  return Math.ceil((windowStart(now, windowMs) + windowMs - now) / 1000);
}

async function current(db, key, win) {
  const row = await db.prepare('SELECT win, count FROM rate_limits WHERE key = ?1').bind(key).first();
  return row && row.win === win ? Number(row.count) : 0;
}

async function bump(db, key, win, amount = 1) {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, win, count) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.win = excluded.win THEN rate_limits.count + excluded.count ELSE excluded.count END,
         win = excluded.win
       RETURNING count`,
    )
    .bind(key, win, amount)
    .first();
  return Number(row?.count ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Count one attempt for `purpose` from `subject` (or `amount` units of it,
 * such as megabytes of a download). Returns true while the caller is within
 * `limit` units per `windowMs`. A caller this would take over the limit is
 * refused after one read, without a write.
 */
export async function takeQuota(db, salt, purpose, subject, limit, windowMs, now = Date.now(), amount = 1) {
  if (!Number.isSafeInteger(amount) || amount < 1) throw new RangeError('quota amount must be a positive integer');
  const win = windowStart(now, windowMs);
  const key = await quotaKey(salt, purpose, subject);
  if ((await current(db, key, win)) + amount > limit) return false;
  return (await bump(db, key, win, amount)) <= limit;
}

/** Attempts counted so far in the current window (a read only). */
export async function peekQuota(db, salt, purpose, subject, windowMs, now = Date.now()) {
  return current(db, await quotaKey(salt, purpose, subject), windowStart(now, windowMs));
}

/** Count one event (a failure) without a limit check: one write. */
export async function countQuota(db, salt, purpose, subject, windowMs, now = Date.now()) {
  return bump(db, await quotaKey(salt, purpose, subject), windowStart(now, windowMs));
}

/**
 * Give back `amount` units counted in the current window (a download that
 * never started). Never below zero; a counter of an older window is left
 * alone. One write.
 */
export async function refundQuota(db, salt, purpose, subject, windowMs, now = Date.now(), amount = 1) {
  if (!Number.isSafeInteger(amount) || amount < 1) throw new RangeError('quota amount must be a positive integer');
  const key = await quotaKey(salt, purpose, subject);
  await db
    .prepare('UPDATE rate_limits SET count = MAX(0, count - ?3) WHERE key = ?1 AND win = ?2')
    .bind(key, windowStart(now, windowMs), amount)
    .run();
}

/** Forget a counter (a successful sign-in clears its failures). */
export async function clearQuota(db, salt, purpose, subject) {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?1').bind(await quotaKey(salt, purpose, subject)).run();
}

/** Remove counters from old windows (called opportunistically and by the daily job). */
export async function pruneQuotas(db, now = Date.now()) {
  await db.prepare('DELETE FROM rate_limits WHERE win < ?1').bind(now - QUOTA_RETENTION_MS).run();
}
