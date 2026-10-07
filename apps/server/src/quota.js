// Per-IP fixed-window quotas for HTTP endpoints, stored in D1. IPs are kept
// only as salted SHA-256 hashes scoped to the purpose.

import { sha256, toHex } from './crypto.js';

/**
 * Count one attempt for `purpose` from `ip`. Returns true while the caller is
 * within `limit` attempts per `windowMs`.
 */
export async function takeQuota(db, purpose, ip, limit, windowMs, now = Date.now()) {
  const win = Math.floor(now / windowMs);
  const key = `${purpose}:${toHex(await sha256(`webra-quota:${purpose}:${ip}`))}`;
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

/** Remove counters from old windows (called opportunistically). */
export async function pruneQuotas(db, windowMs, now = Date.now()) {
  await db.prepare('DELETE FROM rate_limits WHERE win < ?1').bind(Math.floor(now / windowMs) - 1).run();
}
