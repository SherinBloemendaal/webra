// Daily scheduled job (wrangler.jsonc `triggers.crons`): retention for
// accounts data (docs/accounts-api.md, sections 6 and 8; apps/website/privacy.html).

import { pruneSessions } from '../directory.js';
import { UNLISTED_RETENTION_MS } from '../maps.js';
import { ONLINE_SAVE_RETENTION_MS } from '@webra/protocol';
import { pruneQuotas } from '../quota.js';
import { auditStatement, AUDIT_RETENTION_MS } from './audit.js';
import { purgeStatements } from './routes-admin.js';
import { IP_RETENTION_MS, SESSION_IDLE_MS } from './sessions.js';
import { DELETED_RETENTION_MS } from './users.js';

export const PRESENCE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Unverified email addresses are removed after this long. */
export const UNVERIFIED_EMAIL_MS = 7 * 24 * 60 * 60 * 1000;
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
    // Unverified addresses expire: they never claimed the address, and now they are gone.
    unverifiedEmails: await run(
      'UPDATE users SET email = NULL, email_set_at = NULL WHERE email IS NOT NULL AND email_verified = 0 AND (email_set_at IS NULL OR email_set_at < ?1)',
      now - UNVERIFIED_EMAIL_MS,
    ),
    // Maps shared with an online session only (unlisted): kept while sessions use them.
    sharedMaps: await run('DELETE FROM maps WHERE listed = 0 AND COALESCE(used_at, created_at) < ?1', now - UNLISTED_RETENTION_MS),
    // Saved online games: their records go after 90 days (the files stay with the players).
    onlineSaves: await run('DELETE FROM online_saves WHERE created_at < ?1', now - ONLINE_SAVE_RETENTION_MS),
    purged: 0,
  };
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
