// Daily scheduled job (wrangler.jsonc `triggers.crons`): retention for
// accounts data (docs/accounts-api.md, sections 6 and 8; apps/website/privacy.html).

import { pruneSessions } from '../directory.js';
import { DAILY_UPGRADE_BATCH, UNLISTED_RETENTION_MS, upgradeStaleMaps } from '../maps.js';
import { ONLINE_SAVE_RETENTION_MS } from '@webra/protocol';
import { pruneQuotas } from '../quota.js';
import { auditStatement, AUDIT_RETENTION_MS } from './audit.js';
import { purgeStatements } from './routes-admin.js';
import { IP_RETENTION_MS, SESSION_IDLE_MS } from './sessions.js';
import { DELETED_RETENTION_MS } from './users.js';
import { services } from './site.js';

export const PRESENCE_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * Signups waiting for their email (`pending_email`, never approved) expire
 * when the address was not confirmed this long after it was set.
 */
export const UNCONFIRMED_SIGNUP_MS = 7 * 24 * 60 * 60 * 1000;
export const EXPIRED_IP_BAN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PURGE_BATCH = 100;

/** Run every retention rule; returns counts per rule (for logs and tests). */
export async function runRetention(env, now = Date.now()) {
  const db = env.DB;
  const run = async (sql, ...args) => (await db.prepare(sql).bind(...args).run()).meta.changes ?? 0;
  const out = {
    sessions: await run('DELETE FROM auth_sessions WHERE expires_at <= ?1 OR last_used_at <= ?2', now, now - SESSION_IDLE_MS),
    challenges: await run('DELETE FROM webauthn_challenges WHERE expires_at <= ?1', now),
    emailTokens: await run('DELETE FROM email_tokens WHERE expires_at <= ?1', now),
    oauthStates: await run('DELETE FROM oauth_states WHERE expires_at <= ?1', now),
    ipHistory: await run('DELETE FROM user_ips WHERE last_seen < ?1', now - IP_RETENTION_MS),
    presence: await run('DELETE FROM game_presence WHERE updated_at < ?1', now - PRESENCE_RETENTION_MS),
    ipBans: await run('DELETE FROM ip_bans WHERE expires_at IS NOT NULL AND expires_at < ?1', now - EXPIRED_IP_BAN_RETENTION_MS),
    audit: await run('DELETE FROM audit_log WHERE at < ?1', now - AUDIT_RETENTION_MS),
    loginFailures: await run(
      'UPDATE users SET login_failures = 0, login_failed_at = NULL, login_delay_until = NULL WHERE login_failed_at IS NOT NULL AND login_failed_at < ?1',
      now - 24 * 60 * 60 * 1000,
    ),
    // Unverified addresses stay on their accounts (every new account has one; they claim nothing),
    // but signups that never confirmed theirs expire below.
    // Maps shared with an online session only (unlisted): kept while sessions use them.
    sharedMaps: await run('DELETE FROM maps WHERE listed = 0 AND COALESCE(used_at, created_at) < ?1', now - UNLISTED_RETENTION_MS),
    // Saved online games: their records go after 90 days (the files stay with the players).
    onlineSaves: await run('DELETE FROM online_saves WHERE created_at < ?1', now - ONLINE_SAVE_RETENTION_MS),
    // Old hashes of upgraded maps (map versions) go with the map they point to.
    mapAliases: await run('DELETE FROM map_aliases WHERE hash NOT IN (SELECT hash FROM maps)'),
    expiredSignups: 0,
    purged: 0,
  };
  out.expiredSignups = await expireUnconfirmedSignups(env, now);
  // Maps stored before a format version change: upgraded in batches (reads upgrade them too).
  out.mapUpgrades = await upgradeStaleMaps(db, { now, limit: DAILY_UPGRADE_BATCH });
  const { results } = await db
    .prepare("SELECT id FROM users WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?1 LIMIT ?2")
    .bind(now - DELETED_RETENTION_MS, PURGE_BATCH)
    .all();
  for (const { id } of results) {
    await db.batch([
      ...purgeStatements(db, id, now),
      auditStatement(db, { actor: null, action: 'user.purge', targetType: 'user', targetId: id, before: { purged: true }, after: { purged: true }, reason: 'Deleted more than 30 days ago' }, now),
    ]);
    out.purged++;
  }
  await pruneQuotas(db, now);
  await pruneSessions(db, now);
  return out;
}

/**
 * Signups still `pending_email` UNCONFIRMED_SIGNUP_MS after their address was
 * set (and never approved) are deleted like a self-deletion: the address is
 * cleared (it may not be theirs), sessions and links go, and the account is
 * purged with the other deleted accounts 30 days later (an admin can
 * restore it until then; restored, it has no address, so it waits until
 * one is added and then has 7 days again). Only while email can be sent:
 * without it nobody could have confirmed. Returns how many expired.
 */
export async function expireUnconfirmedSignups(env, now = Date.now()) {
  if (!services(env).email) return 0;
  const db = env.DB;
  const { results } = await db
    .prepare(
      `SELECT id, username FROM users WHERE status = 'pending_email' AND approved_at IS NULL
         AND email IS NOT NULL AND COALESCE(email_set_at, created_at) < ?1 LIMIT ?2`,
    )
    .bind(now - UNCONFIRMED_SIGNUP_MS, PURGE_BATCH)
    .all();
  for (const { id, username } of results) {
    await db.batch([
      db
        .prepare(
          `UPDATE users SET status = 'deleted', status_before_delete = status, deleted_at = ?2, email = NULL, email_key = NULL, email_set_at = NULL
           WHERE id = ?1 AND status = 'pending_email'`,
        )
        .bind(id, now),
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(id),
      db.prepare('DELETE FROM email_tokens WHERE user_id = ?1').bind(id),
      auditStatement(
        db,
        { actor: null, action: 'user.expire', targetType: 'user', targetId: id, targetLabel: username, before: { status: 'pending_email' }, after: { status: 'deleted' }, reason: 'Email address not confirmed within 7 days' },
        now,
      ),
    ]);
  }
  return results.length;
}

/**
 * The cron handler. It waits for the job, so a failure fails the run (and is
 * reported: src/telemetry.js wraps this handler).
 */
export async function scheduled(controller, env) {
  try {
    const counts = await runRetention(env, controller?.scheduledTime ?? Date.now());
    console.log('retention', JSON.stringify(counts));
  } catch (err) {
    console.error('retention failed', err?.name, err?.message);
    throw err;
  }
}
