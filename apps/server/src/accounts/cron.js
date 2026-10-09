// Daily scheduled job (wrangler.jsonc `triggers.crons`): retention for
// accounts data (docs/accounts-api.md, sections 6 and 8; apps/website/privacy.html).

import { pruneSessions } from '../directory.js';
import { pruneQuotas } from '../quota.js';
import { auditStatement, AUDIT_RETENTION_MS } from './audit.js';
import { purgeStatements } from './routes-admin.js';
import { IP_RETENTION_MS, SESSION_IDLE_MS } from './sessions.js';
import { DELETED_RETENTION_MS } from './users.js';

export const PRESENCE_RETENTION_MS = 24 * 60 * 60 * 1000;
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
    purged: 0,
  };
  const { results } = await db
    .prepare("SELECT id FROM users WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?1 LIMIT ?2")
    .bind(now - DELETED_RETENTION_MS, PURGE_BATCH)
    .all();
  for (const { id } of results) {
    await db.batch([
      ...purgeStatements(db, id),
      auditStatement(db, { actor: null, action: 'user.purge', targetType: 'user', targetId: id, before: { purged: true }, after: { purged: true }, reason: 'Deleted more than 30 days ago' }, now),
    ]);
    out.purged++;
  }
  await pruneQuotas(db, now);
  await pruneSessions(db, now);
  return out;
}

export async function scheduled(controller, env, ctx) {
  ctx.waitUntil(
    runRetention(env, controller?.scheduledTime ?? Date.now()).then(
      (counts) => console.log('retention', JSON.stringify(counts)),
      (err) => console.error('retention failed', err?.name, err?.message),
    ),
  );
}
