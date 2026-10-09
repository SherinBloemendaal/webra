// Account and IP bans (docs/accounts-api.md, section 6) and dropping banned
// players from running games through the session Durable Objects.

import { ipRecord } from './ip.js';

/** Recently active presence and IP history rows considered when an IP ban drops players. */
const EVICT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const EVICT_MAX_SESSIONS = 50;

/** The IP ban in effect for an address, or null. */
export async function findIpBan(db, ip, now = Date.now()) {
  const rec = ipRecord(ip);
  if (!rec) return null;
  return db
    .prepare(
      `SELECT id, cidr, reason, expires_at FROM ip_bans
       WHERE ip_v = ?1 AND start_hex <= ?2 AND end_hex >= ?2 AND (expires_at IS NULL OR expires_at > ?3)
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(rec.v, rec.hex, now)
    .first();
}

export function ipBanView(row, now = Date.now()) {
  return {
    id: row.id,
    cidr: row.cidr,
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    active: row.expires_at === null || row.expires_at > now,
  };
}

export function accountBanView(row) {
  return {
    id: row.id,
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

/**
 * Ask every session Durable Object that has (or recently had) a matching
 * member to drop it. `userIds`: accounts; `range`: { v, start, end } of an
 * IP ban (members connected from it, and accounts seen from it recently).
 * Failures are logged and skipped: the ban itself is already stored and
 * every new connection is refused.
 */
export async function evictFromGames(env, { userIds = [], range = null }, now = Date.now()) {
  if (!env.SESSION) return 0;
  const ids = new Set(userIds);
  const sessions = new Set();
  if (range) {
    const { results: users } = await env.DB.prepare(
      'SELECT DISTINCT user_id FROM user_ips WHERE ip_v = ?1 AND ip_hex >= ?2 AND ip_hex <= ?3 AND last_seen > ?4',
    )
      .bind(range.v, range.start, range.end, now - EVICT_LOOKBACK_MS)
      .all();
    for (const u of users) ids.add(u.user_id);
    const { results } = await env.DB.prepare(
      'SELECT DISTINCT session_id FROM game_presence WHERE ip_v = ?1 AND ip_hex >= ?2 AND ip_hex <= ?3 LIMIT ?4',
    )
      .bind(range.v, range.start, range.end, EVICT_MAX_SESSIONS)
      .all();
    for (const r of results) sessions.add(r.session_id);
  }
  for (const id of ids) {
    const { results } = await env.DB.prepare('SELECT DISTINCT session_id FROM game_presence WHERE user_id = ?1 LIMIT ?2')
      .bind(id, EVICT_MAX_SESSIONS)
      .all();
    for (const r of results) sessions.add(r.session_id);
  }
  let dropped = 0;
  for (const sessionId of [...sessions].slice(0, EVICT_MAX_SESSIONS)) {
    try {
      const stub = env.SESSION.get(env.SESSION.idFromString(sessionId));
      dropped += await stub.evict({ userIds: [...ids], range });
    } catch (err) {
      console.error('evict failed', err?.name, err?.message);
    }
  }
  return dropped;
}
