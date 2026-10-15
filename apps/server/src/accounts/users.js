// Account rows: lookups (with the ban in effect and the passkey count), the
// effective status, and the JSON shapes of docs/accounts-api.md (UserSelf,
// AdminUser).

import { emailKey, maskEmail, maskToFlags, usernameKey } from '@webra/protocol';
import { randomHex, randomToken } from '../crypto.js';

/** Days a soft-deleted account is kept before it is purged. */
export const DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Self-service username changes: one per this period. */
export const USERNAME_CHANGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Avatar colors handed out at signup (the lobby player colors, lower case). */
const AVATAR_COLORS = ['#c8402a', '#2a6fc8', '#d8b030', '#3a9a3a', '#e07820', '#8a4ac0', '#30a8a8', '#c84a8a'];

export function randomAvatarColor() {
  return AVATAR_COLORS[crypto.getRandomValues(new Uint8Array(1))[0] % AVATAR_COLORS.length];
}

/**
 * SELECT for users with `b_*` columns of the ban in effect at ?1 (now) and
 * the passkey count. `where` is fixed SQL from this module's callers (never
 * user input); its parameters start at ?2.
 */
export function userSelect(where) {
  return `SELECT u.*,
      b.id AS b_id, b.reason AS b_reason, b.created_at AS b_created_at, b.created_by AS b_created_by, b.expires_at AS b_expires_at,
      (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count
    FROM users u
    LEFT JOIN account_bans b ON b.id = (
      SELECT id FROM account_bans x
      WHERE x.user_id = u.id AND x.revoked_at IS NULL AND (x.expires_at IS NULL OR x.expires_at > ?1)
      ORDER BY x.id DESC LIMIT 1)
    WHERE ${where}`;
}

export async function userById(db, id, now = Date.now()) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return null;
  return db.prepare(userSelect('u.id = ?2')).bind(now, id).first();
}

export async function userByUsername(db, username, now = Date.now()) {
  return db.prepare(userSelect('u.username_key = ?2')).bind(now, usernameKey(username)).first();
}

/** The account whose VERIFIED address this is (unverified addresses are not looked up). */
export async function userByEmail(db, email, now = Date.now()) {
  return db.prepare(userSelect('u.email_key = ?2')).bind(now, emailKey(email)).first();
}

export async function userByDiscord(db, discordId, now = Date.now()) {
  return db.prepare(userSelect('u.discord_id = ?2')).bind(now, discordId).first();
}

export function banOf(row) {
  if (!row || row.b_id === null || row.b_id === undefined) return null;
  return { id: row.b_id, reason: row.b_reason, createdAt: row.b_created_at, createdBy: row.b_created_by, expiresAt: row.b_expires_at };
}

/** The status clients see: `banned` while a ban is in effect (deleted wins). */
export function effectiveStatus(row) {
  if (row.status === 'deleted') return 'deleted';
  if (banOf(row)) return 'banned';
  return row.status;
}

export function hasPassword(row) {
  return typeof row.password_hash === 'string' && row.password_hash.length > 0;
}

/** Whether the account may play online, given the effective site switches. */
export function canPlayOnline(row, eff) {
  const status = effectiveStatus(row);
  if (status === 'banned' || status === 'deleted') return false;
  return status === 'active' || !eff.onlineRequiresAccount;
}

/**
 * Whether the account may load the game (/play, the play gate in
 * src/playgate.js): an active account, or anyone not banned while the site
 * does not require accounts for the game. The gate also refuses banned
 * addresses, which this verdict does not know about.
 */
export function canPlay(row, eff) {
  const status = effectiveStatus(row);
  if (status === 'banned' || status === 'deleted') return false;
  return status === 'active' || !eff.gameRequiresAccount;
}

export function canUseContentRelay(row, eff) {
  if (!eff.contentRelay || effectiveStatus(row) !== 'active') return false;
  return row.role === 'admin' || maskToFlags(row.flags).includes('content_autoinstall');
}

/** UserSelf (section 5.1). */
export function selfUser(row, eff, pendingEmail = null) {
  const ban = banOf(row);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    emailVerified: row.email_verified === 1,
    pendingEmail,
    avatarColor: row.avatar_color,
    role: row.role,
    status: effectiveStatus(row),
    flags: maskToFlags(row.flags),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    usernameChangedAt: row.username_changed_at,
    passwordChangedAt: row.password_changed_at ?? null,
    methods: {
      password: hasPassword(row),
      discord: row.discord_id ? { username: row.discord_username, linkedAt: row.discord_linked_at } : null,
      passkeys: Number(row.passkey_count ?? 0),
    },
    ban: ban ? { reason: ban.reason, expiresAt: ban.expiresAt, createdAt: ban.createdAt } : null,
    canPlay: canPlay(row, eff),
    canPlayOnline: canPlayOnline(row, eff),
    canUseContentRelay: canUseContentRelay(row, eff),
  };
}

/** AdminUser (section 8); moderators see a masked email and no Discord id. */
export function adminUser(row, { moderator = false } = {}) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: moderator ? maskEmail(row.email) : row.email,
    emailVerified: row.email_verified === 1,
    emailSetAt: row.email_set_at ?? null,
    avatarColor: row.avatar_color,
    role: row.role,
    status: effectiveStatus(row),
    storedStatus: row.status,
    flags: maskToFlags(row.flags),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    deletedAt: row.deleted_at,
    methods: {
      password: hasPassword(row),
      // A deleted account's Discord id is kept aside (deleted_discord_id) until a restore or the purge.
      discord: (row.discord_id ?? row.deleted_discord_id)
        ? moderator
          ? { username: row.discord_username }
          : { id: row.discord_id ?? row.deleted_discord_id, username: row.discord_username }
        : null,
      passkeys: Number(row.passkey_count ?? 0),
    },
    ban: banOf(row),
  };
}

/** The status a new or newly verified account gets. */
export function initialStatus({ emailVerified, eff }) {
  if (eff.emailVerificationRequired && !emailVerified) return 'pending_email';
  if (eff.approvalRequired) return 'pending_approval';
  return 'active';
}

/**
 * INSERT statement for a new account. Returns { id, statement }. Uniqueness
 * conflicts surface as constraint errors from D1 (see isUniqueError).
 */
export function insertUser(db, fields, now = Date.now()) {
  const id = randomHex(16);
  const statement = db
    .prepare(
      `INSERT INTO users (id, username, username_key, display_name, email, email_key, email_verified, avatar_color, role, status,
         flags, password_hash, password_salt, password_iterations, password_peppered, password_changed_at, user_handle,
         discord_id, discord_username, discord_linked_at, created_at, last_seen_at, email_set_at, unconfirmed_signup)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'user', ?9, 0, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19, ?20, ?21)`,
    )
    .bind(
      id,
      fields.username,
      usernameKey(fields.username),
      fields.displayName ?? fields.username,
      fields.email ?? null,
      // Only a verified address claims its key (unverified ones block nobody).
      fields.email && fields.emailVerified ? emailKey(fields.email) : null,
      fields.emailVerified ? 1 : 0,
      randomAvatarColor(),
      fields.status,
      fields.password?.hash ?? null,
      fields.password?.salt ?? null,
      fields.password?.iterations ?? null,
      fields.password?.peppered ?? 0,
      fields.password ? now : null,
      fields.userHandle ?? randomToken(),
      fields.discord?.id ?? null,
      fields.discord?.username ?? null,
      fields.discord ? now : null,
      now,
      fields.email ? now : null,
      // A signup that starts waiting for its email may expire (cron.js); the flag ends with the first status change.
      fields.status === 'pending_email' ? 1 : 0,
    );
  return { id, statement };
}

/**
 * Soft deletion (self-deletion, admin deletion, rejection, expiry): the
 * account keeps its username for 30 days, but claims neither its address
 * (`email_key` cleared; the address and its verified flag stay for a
 * restore, which checks them again) nor its Discord account (the id moves to
 * `deleted_discord_id`). `clearEmail` also drops the address (an expired
 * signup's address may belong to someone else). `onlyStatus` deletes only
 * while the stored status is still that one. The caller removes sessions
 * and links.
 */
export function softDeleteStatement(db, userId, now, { clearEmail = false, onlyStatus = null } = {}) {
  const email = clearEmail ? ', email = NULL, email_verified = 0, email_set_at = NULL' : '';
  return db
    .prepare(
      `UPDATE users SET status = 'deleted', status_before_delete = status, deleted_at = ?2, email_key = NULL,
         deleted_discord_id = discord_id, discord_id = NULL${email}
       WHERE id = ?1 AND status != 'deleted' AND (?3 IS NULL OR status = ?3)`,
    )
    .bind(userId, now, onlyStatus);
}

/** Which unique column a D1 constraint error is about, or null. */
export function uniqueViolation(err) {
  const m = /UNIQUE constraint failed: users\.(\w+)/.exec(String(err?.message ?? ''));
  if (!m) return null;
  return { username_key: 'username', email_key: 'email', discord_id: 'discord', user_handle: 'userHandle' }[m[1]] ?? m[1];
}
