// Audit log of admin and moderator actions (docs/accounts-api.md, 8.9).

export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export const AUDIT_ACTIONS = Object.freeze([
  'user.update',
  'user.approve',
  'user.approve_all',
  'user.reject',
  'user.ban',
  'user.unban',
  'user.logout',
  'user.session_revoke',
  'user.password_reset_link',
  'user.delete',
  'user.restore',
  'user.purge',
  'user.settings_update',
  'user.guide_update',
  'user.relay_quota_reset',
  'user.expire',
  'user.email_verify',
  'user.email_resend',
  'ipban.create',
  'ipban.update',
  'ipban.delete',
  'site.update',
]);

/**
 * Statement that records one action. `actor` is the acting user row (null
 * for the system); `before` and `after` are JSON-serializable or null.
 */
export function auditStatement(db, { actor, action, targetType, targetId = null, targetLabel = null, before = null, after = null, reason = null }, now = Date.now()) {
  if (!AUDIT_ACTIONS.includes(action)) throw new Error(`unknown audit action ${action}`);
  return db
    .prepare(
      `INSERT INTO audit_log (at, actor_id, actor_username, action, target_type, target_id, target_label, before_json, after_json, reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      now,
      actor?.id ?? null,
      actor?.username ?? null,
      action,
      targetType,
      targetId,
      targetLabel,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
    );
}

export async function audit(db, entry, now = Date.now()) {
  await auditStatement(db, entry, now).run();
}

function parse(textValue) {
  if (textValue === null || textValue === undefined) return null;
  try {
    return JSON.parse(textValue);
  } catch {
    return null;
  }
}

export function auditView(row) {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor_id ? { id: row.actor_id, username: row.actor_username } : null,
    action: row.action,
    target: { type: row.target_type, id: row.target_id, label: row.target_label },
    before: parse(row.before_json),
    after: parse(row.after_json),
    reason: row.reason,
  };
}
