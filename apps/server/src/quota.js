// Fixed-window counters for HTTP rate limits and sign-in lockouts, stored in
// D1. The subject (a client IP, a login name, an account id) is kept only as
// a SHA-256 hash scoped to the purpose. `win` holds the start of the window
// (unix milliseconds), so counters of different window lengths live side by
// side and one prune removes them all.

import { sha256, toHex } from './crypto.js';

/** Counters older than this are removed (longer than the longest window, one day). */
export const QUOTA_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

async function quotaKey(purpose, subject) {
  return `${purpose}:${toHex(await sha256(`webra-quota:${purpose}:${subject}`))}`;
}

const windowStart = (now, windowMs) => Math.floor(now / windowMs) * windowMs;

/** Seconds until the current window of `windowMs` ends. */
export function windowRemaining(windowMs, now = Date.now()) {
  return Math.ceil((windowStart(now, windowMs) + windowMs - now) / 1000);
}

/**
 * Count one attempt for `purpose` from `subject`. Returns true while the
 * caller is within `limit` attempts per `windowMs`.
 */
export async function takeQuota(db, purpose, subject, limit, windowMs, now = Date.now()) {
  const win = windowStart(now, windowMs);
  const key = await quotaKey(purpose, subject);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, win, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.win = excluded.win THEN rate_limits.count + 1 ELSE 1 END,
         win = excluded.win
       RETURNING count`,
    )
    .bind(key, win)
    .first();
  return Number(row?.count ?? limit + 1) <= limit;
}

/** Attempts counted so far in the current window (without counting one). */
export async function peekQuota(db, purpose, subject, windowMs, now = Date.now()) {
  const key = await quotaKey(purpose, subject);
  const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ?1 AND win = ?2').bind(key, windowStart(now, windowMs)).first();
  return Number(row?.count ?? 0);
}

/** Forget a counter (a successful sign-in clears its failures). */
export async function clearQuota(db, purpose, subject) {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?1').bind(await quotaKey(purpose, subject)).run();
}

/** Remove counters from old windows (called opportunistically and by the daily job). */
export async function pruneQuotas(db, now = Date.now()) {
  await db.prepare('DELETE FROM rate_limits WHERE win < ?1').bind(now - QUOTA_RETENTION_MS).run();
}
