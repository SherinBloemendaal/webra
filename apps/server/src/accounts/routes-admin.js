// Admin and moderator API: /api/admin/* (docs/accounts-api.md, section 8).
// Every check is made here on the server; every change is audit logged.

import { purgeOnlineSavesStatement } from '../onlinesaves.js';
import { relayQuotas, resetRelayQuotas } from '../relayquota.js';
import {
  ACCOUNT_FLAGS,
  ACCOUNT_ROLES,
  ACCOUNT_STATUSES,
  BAN_REASON_MAX,
  emailKey,
  flagsToMask,
  mergeSiteSettings,
  usernameKey,
  validAvatarColor,
  validDisplayName,
  validEmail,
  validFlags,
  validLabel,
  validUsername,
} from '@webra/protocol';
import { HttpError, json } from '../http.js';
import { check, invalid } from './context.js';
import { audit, auditStatement, auditView, AUDIT_ACTIONS } from './audit.js';
import { accountBanView, evictFromGames, ipBanView } from './bans.js';
import { accountLink, createEmailToken, resetMessage, sendEmail, TOKEN_TTL_MS } from './email.js';
import { inRange, parseCidr } from './ip.js';
import { listPasskeys } from './passkeys.js';
import { listSessions, sessionView } from './sessions.js';
import { getSettingsDoc, ifMatchVersion, putSettingsDoc, readSettingsBody, settingsResponse } from './settings-doc.js';
import { effective, loadSite, publicSite, saveSite } from './site.js';
import { adminUser, banOf, uniqueViolation, userById, userSelect } from './users.js';
import { statusAfterVerification } from './common.js';
import { sendAddressMail } from './verification.js';

const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
const notFound = (what = 'user') => new HttpError(404, 'not_found', `No such ${what}.`);
const forbidden = (message = 'You do not have permission for this.') => new HttpError(403, 'forbidden', message);
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function page(url) {
  const p = Number(url.searchParams.get('page') ?? '1');
  const l = Number(url.searchParams.get('limit') ?? '25');
  if (!Number.isInteger(p) || p < 1 || p > 100000) throw invalid('page', 'page must be a positive integer.');
  if (!Number.isInteger(l) || l < 1 || l > 100) throw invalid('limit', 'limit must be 1 to 100.');
  return { page: p, limit: l, offset: (p - 1) * l };
}

function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

async function target(ctx, id) {
  const row = await userById(ctx.db, id, ctx.now);
  if (!row) throw notFound();
  return row;
}

/** Moderators act only on plain users; nobody acts on themselves where `self` is forbidden. */
function assertCanModerate(actor, row) {
  if (row.id === actor.id) throw forbidden('You cannot do this to your own account.');
  if (actor.role !== 'admin' && row.role !== 'user') throw forbidden('Only admins can do this to moderators and admins.');
}

/** Admins that are active and not banned, other than `exceptId`. */
async function activeAdminCount(db, exceptId, now) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM users u WHERE u.role = 'admin' AND u.status = 'active' AND u.id != ?1
         AND NOT EXISTS (SELECT 1 FROM account_bans b WHERE b.user_id = u.id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > ?2))`,
    )
    .bind(exceptId, now)
    .first();
  return r.n;
}

/** 409 when taking `row` out of service would leave no active, unbanned admin. */
async function assertKeepsAnAdmin(ctx, row) {
  if (row.role === 'admin' && (await activeAdminCount(ctx.db, row.id, ctx.now)) === 0) {
    throw new HttpError(409, 'conflict', 'This is the last active admin. Make someone else an admin first.');
  }
}

function expiry(ctx, v, field = 'expiresAt') {
  if (v === null || v === undefined) return null;
  if (!Number.isSafeInteger(v) || v <= ctx.now || v > ctx.now + 100 * YEAR_MS) throw invalid(field, 'expiresAt must be a future time (unix milliseconds) or null.');
  return v;
}

function reasonOf(v, field = 'reason') {
  return check(() => validLabel(v, BAN_REASON_MAX, field));
}

// ---- Users --------------------------------------------------------------------------------

const SORTS = { created: 'u.created_at', lastSeen: 'u.last_seen_at', username: 'u.username_key' };

async function listUsers(ctx) {
  const actor = await ctx.requireRole('moderator');
  const moderator = actor.role !== 'admin';
  const url = ctx.url;
  const { page: p, limit, offset } = page(url);
  const where = ['1 = 1'];
  const args = [];
  const arg = (v) => {
    args.push(v);
    return `?${args.length + 1}`;
  };
  const q = url.searchParams.get('q');
  if (q) {
    if (q.length > 100) throw invalid('q', 'q is at most 100 characters.');
    const pat = arg(likePattern(q.normalize('NFC')));
    where.push(
      moderator
        ? `(u.username LIKE ${pat} ESCAPE '\\' OR u.display_name LIKE ${pat} ESCAPE '\\')`
        : `(u.username LIKE ${pat} ESCAPE '\\' OR u.display_name LIKE ${pat} ESCAPE '\\' OR u.email LIKE ${pat} ESCAPE '\\')`,
    );
  }
  const status = url.searchParams.get('status');
  if (status) {
    if (!ACCOUNT_STATUSES.includes(status)) throw invalid('status', 'Unknown status.');
    if (status === 'banned') where.push("b.id IS NOT NULL AND u.status != 'deleted'");
    else if (status === 'deleted') where.push("u.status = 'deleted'");
    else where.push(`u.status = ${arg(status)} AND b.id IS NULL`);
  }
  const role = url.searchParams.get('role');
  if (role) {
    if (!ACCOUNT_ROLES.includes(role)) throw invalid('role', 'Unknown role.');
    where.push(`u.role = ${arg(role)}`);
  }
  const flag = url.searchParams.get('flag');
  if (flag) {
    if (!Object.hasOwn(ACCOUNT_FLAGS, flag)) throw invalid('flag', 'Unknown flag.');
    where.push(`(u.flags & ${arg(ACCOUNT_FLAGS[flag])}) != 0`);
  }
  const sort = SORTS[url.searchParams.get('sort') ?? 'created'];
  if (!sort) throw invalid('sort', 'sort must be created, lastSeen or username.');
  const order = (url.searchParams.get('order') ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
  if (!['asc', 'desc', null].includes(url.searchParams.get('order'))) throw invalid('order', 'order must be asc or desc.');
  const base = userSelect(where.join(' AND '));
  const total = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM (${base})`).bind(ctx.now, ...args).first();
  const { results } = await ctx.db
    .prepare(`${base} ORDER BY ${sort} ${order}, u.id LIMIT ${limit} OFFSET ${offset}`)
    .bind(ctx.now, ...args)
    .all();
  return json({ users: results.map((r) => adminUser(r, { moderator })), total: total.n, page: p, limit });
}

async function userDetail(ctx, { id }) {
  const actor = await ctx.requireRole('moderator');
  const row = await target(ctx, id);
  const bans = (await ctx.db.prepare('SELECT * FROM account_bans WHERE user_id = ?1 ORDER BY id DESC LIMIT 50').bind(row.id).all()).results.map(accountBanView);
  if (actor.role !== 'admin') return json({ user: adminUser(row, { moderator: true }), bans });
  const ips = (await ctx.db.prepare('SELECT ip, first_seen, last_seen, count FROM user_ips WHERE user_id = ?1 ORDER BY last_seen DESC').bind(row.id).all()).results;
  return json({
    user: adminUser(row),
    sessions: (await listSessions(ctx.db, row.id)).map((s) => {
      const { current: _current, ...view } = sessionView(s);
      return view;
    }),
    passkeys: (await listPasskeys(ctx.db, row.id)).map((p) => ({ id: p.id, name: p.name, alg: p.alg, createdAt: p.created_at, lastUsedAt: p.last_used_at, counterError: p.counter_error === 1 })),
    ips: ips.map((r) => ({ ip: r.ip, firstSeen: r.first_seen, lastSeen: r.last_seen, count: r.count })),
    bans,
    settings: await getSettingsDoc(ctx.db, row.id),
    relay: await relayQuotas(ctx.db, ctx.salt(), row.id, ctx.now),
    emailLink: await pendingAddressLink(ctx, row.id),
    emailSending: (await ctx.eff()).login.email,
  });
}

/** The account's unused verification or change link (purpose, address, dates), or null. */
async function pendingAddressLink(ctx, userId) {
  const t = await ctx.db
    .prepare("SELECT purpose, email, created_at, expires_at FROM email_tokens WHERE user_id = ?1 AND purpose IN ('verify', 'change') AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1")
    .bind(userId, ctx.now)
    .first();
  return t ? { purpose: t.purpose, email: t.email, sentAt: t.created_at, expiresAt: t.expires_at } : null;
}

/** An account whose address an admin can act on: not deleted, an address that is not verified yet. */
function assertUnverifiedAddress(row) {
  if (row.status === 'deleted') throw new HttpError(409, 'conflict', 'Restore the account first.');
  if (!row.email) throw new HttpError(409, 'conflict', 'This account has no email address.');
  if (row.email_verified === 1) throw new HttpError(409, 'conflict', 'This email address is already verified.');
}

/**
 * Mark the account's address verified (the admin vouches for it): it claims
 * its key, a `pending_email` account moves on as after its link, open links
 * go. 409 when another account verified the address.
 */
async function markEmailVerified(ctx, { id }) {
  await ctx.body([]);
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  assertUnverifiedAddress(row);
  const status = statusAfterVerification(row, await ctx.eff());
  try {
    await ctx.db.batch([
      ctx.db.prepare('UPDATE users SET email_key = ?2, email_verified = 1, status = ?3 WHERE id = ?1').bind(row.id, emailKey(row.email), status),
      ctx.db.prepare("DELETE FROM email_tokens WHERE user_id = ?1 AND purpose IN ('verify', 'change')").bind(row.id),
      auditStatement(
        ctx.db,
        { actor, action: 'user.email_verify', targetType: 'user', targetId: row.id, targetLabel: row.username, before: { email: row.email, emailVerified: false, status: row.status }, after: { email: row.email, emailVerified: true, status } },
        ctx.now,
      ),
    ]);
  } catch (err) {
    if (uniqueViolation(err) === 'email') throw new HttpError(409, 'conflict', 'Another account verified this email address.', {}, { field: 'email' });
    throw err;
  }
  return json({ user: adminUser(await target(ctx, row.id)) });
}

/** Mail the account's unverified address a new verification link now (not capped per address). */
async function resendEmailLink(ctx, { id }) {
  await ctx.body([]);
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  assertUnverifiedAddress(row);
  const eff = await ctx.eff();
  if (!eff.services.email) throw new HttpError(503, 'unavailable', 'Email is not available on this server.');
  if (!eff.login.email) throw new HttpError(403, 'method_disabled', 'Email links are switched off.');
  await ctx.limit('admin-email-resend', row.id, 10, 24 * 60 * 60 * 1000, 'This account was sent several links today already.');
  const sent = await sendAddressMail(ctx, { userId: row.id, username: row.username, email: row.email, purpose: 'verify', capped: false });
  await audit(ctx.db, { actor, action: 'user.email_resend', targetType: 'user', targetId: row.id, targetLabel: row.username, after: { email: row.email, sent } }, ctx.now);
  return json({ sent, emailLink: await pendingAddressLink(ctx, row.id) }, 202);
}

async function patchUser(ctx, { id }) {
  const body = await ctx.body(['username', 'displayName', 'email', 'emailVerified', 'avatarColor', 'status', 'role', 'flags']);
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  if (row.status === 'deleted') throw new HttpError(409, 'conflict', 'Restore the account first.');
  const sets = [];
  const args = [];
  const set = (col, v) => {
    args.push(v);
    sets.push(`${col} = ?${args.length + 1}`);
  };
  if (body.username !== undefined) {
    const u = check(() => validUsername(body.username));
    set('username', u);
    set('username_key', usernameKey(u));
  }
  if (body.displayName !== undefined) set('display_name', check(() => validDisplayName(body.displayName)));
  if (body.avatarColor !== undefined) set('avatar_color', check(() => validAvatarColor(body.avatarColor)));
  if (body.emailVerified !== undefined && typeof body.emailVerified !== 'boolean') throw invalid('emailVerified', 'emailVerified must be true or false.');
  if (body.email !== undefined || body.emailVerified !== undefined) {
    const email = body.email === undefined ? row.email : body.email === null ? null : check(() => validEmail(body.email));
    const sameAddress = email !== null && email === row.email;
    const verified = email !== null && (body.emailVerified ?? (sameAddress && row.email_verified === 1));
    set('email', email);
    // Only a verified address claims its key (unverified ones block nobody).
    set('email_key', verified ? emailKey(email) : null);
    set('email_verified', verified ? 1 : 0);
    if (!sameAddress) set('email_set_at', email === null ? null : ctx.now);
  }
  if (body.status !== undefined) {
    if (!['pending_email', 'pending_approval', 'active'].includes(body.status)) {
      throw invalid('status', 'Status must be pending_email, pending_approval or active (bans and deletion have their own actions).');
    }
    if (row.id === actor.id && body.status !== 'active') throw forbidden('You cannot deactivate your own account.');
    if (row.status === 'active' && body.status !== 'active') await assertKeepsAnAdmin(ctx, row);
    set('status', body.status);
    if (body.status === 'active' && row.approved_at === null) {
      set('approved_at', ctx.now);
      set('approved_by', actor.id);
    }
  }
  let roleChanged = false;
  if (body.role !== undefined) {
    if (!ACCOUNT_ROLES.includes(body.role)) throw invalid('role', 'Unknown role.');
    if (body.role !== row.role) {
      if (row.id === actor.id) throw forbidden('You cannot change your own role.');
      if (row.role === 'admin') await assertKeepsAnAdmin(ctx, row);
      set('role', body.role);
      roleChanged = true;
    }
  }
  if (body.flags !== undefined) set('flags', flagsToMask(check(() => validFlags(body.flags))));
  if (sets.length === 0) return json({ user: adminUser(row) });
  const statements = [ctx.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?1`).bind(row.id, ...args)];
  // Privilege changes never happen under a live session: a role change or a
  // status change away from active signs the account out everywhere.
  const deactivated = body.status !== undefined && body.status !== 'active' && row.status === 'active';
  if (roleChanged || deactivated) statements.push(ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(row.id));
  try {
    await ctx.db.batch(statements);
  } catch (err) {
    const which = uniqueViolation(err);
    if (which === 'username' || which === 'email') throw new HttpError(409, 'conflict', `This ${which} is taken.`, {}, { field: which });
    throw err;
  }
  const after = await target(ctx, row.id);
  await audit(ctx.db, { actor, action: 'user.update', targetType: 'user', targetId: row.id, targetLabel: after.username, before: adminUser(row), after: adminUser(after) }, ctx.now);
  return json({ user: adminUser(after) });
}

async function approve(ctx, { id }) {
  await ctx.body([]);
  const actor = await ctx.requireRole('moderator');
  const row = await target(ctx, id);
  assertCanModerate(actor, row);
  if (row.status !== 'pending_approval' && row.status !== 'pending_email') throw new HttpError(409, 'conflict', 'This account is not waiting for approval.');
  await ctx.db.batch([
    ctx.db.prepare("UPDATE users SET status = 'active', approved_at = ?2, approved_by = ?3 WHERE id = ?1").bind(row.id, ctx.now, actor.id),
    auditStatement(ctx.db, { actor, action: 'user.approve', targetType: 'user', targetId: row.id, targetLabel: row.username, before: { status: row.status }, after: { status: 'active' } }, ctx.now),
  ]);
  return json({ user: adminUser(await target(ctx, row.id), { moderator: actor.role !== 'admin' }) });
}

async function reject(ctx, { id }) {
  const body = await ctx.body(['reason']);
  const actor = await ctx.requireRole('moderator');
  const row = await target(ctx, id);
  assertCanModerate(actor, row);
  if (row.status !== 'pending_approval' && row.status !== 'pending_email') throw new HttpError(409, 'conflict', 'This account is not waiting for approval.');
  const reason = body.reason === undefined || body.reason === null || body.reason === '' ? null : reasonOf(body.reason);
  await ctx.db.batch([
    ctx.db.prepare("UPDATE users SET status = 'deleted', status_before_delete = status, deleted_at = ?2 WHERE id = ?1").bind(row.id, ctx.now),
    ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(row.id),
    auditStatement(ctx.db, { actor, action: 'user.reject', targetType: 'user', targetId: row.id, targetLabel: row.username, before: { status: row.status }, after: { status: 'deleted' }, reason }, ctx.now),
  ]);
  return json({ user: adminUser(await target(ctx, row.id), { moderator: actor.role !== 'admin' }) });
}

async function ban(ctx, { id }) {
  const body = await ctx.body(['reason', 'expiresAt']);
  const actor = await ctx.requireRole('moderator');
  const row = await target(ctx, id);
  assertCanModerate(actor, row);
  await assertKeepsAnAdmin(ctx, row);
  const reason = reasonOf(body.reason);
  const expiresAt = expiry(ctx, body.expiresAt);
  const before = banOf(row);
  const results = await ctx.db.batch([
    ctx.db.prepare('UPDATE account_bans SET revoked_at = ?2, revoked_by = ?3 WHERE user_id = ?1 AND revoked_at IS NULL').bind(row.id, ctx.now, actor.id),
    ctx.db
      .prepare('INSERT INTO account_bans (user_id, reason, created_at, created_by, expires_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *')
      .bind(row.id, reason, ctx.now, actor.id, expiresAt),
    ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(row.id),
    auditStatement(ctx.db, { actor, action: 'user.ban', targetType: 'user', targetId: row.id, targetLabel: row.username, before, after: { reason, expiresAt }, reason }, ctx.now),
  ]);
  await evictFromGames(ctx.env, { userIds: [row.id] }, ctx.now);
  return json({ ban: accountBanView(results[1].results[0]), user: adminUser(await target(ctx, row.id), { moderator: actor.role !== 'admin' }) }, 201);
}

async function unban(ctx, { id }) {
  const actor = await ctx.requireRole('moderator');
  const row = await target(ctx, id);
  assertCanModerate(actor, row);
  const current = banOf(row);
  if (!current) throw notFound('ban in effect');
  await ctx.db.batch([
    ctx.db
      .prepare('UPDATE account_bans SET revoked_at = ?2, revoked_by = ?3 WHERE user_id = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)')
      .bind(row.id, ctx.now, actor.id),
    auditStatement(ctx.db, { actor, action: 'user.unban', targetType: 'user', targetId: row.id, targetLabel: row.username, before: current, after: null }, ctx.now),
  ]);
  return json({ user: adminUser(await target(ctx, row.id), { moderator: actor.role !== 'admin' }) });
}

async function forceLogout(ctx, { id }) {
  await ctx.body([]);
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(row.id),
    auditStatement(ctx.db, { actor, action: 'user.logout', targetType: 'user', targetId: row.id, targetLabel: row.username }, ctx.now),
  ]);
  return noContent();
}

async function revokeUserSession(ctx, { id, sessionId }) {
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  if (!/^[0-9a-f]{16}$/.test(sessionId)) throw notFound('session');
  const r = await ctx.db.prepare('DELETE FROM auth_sessions WHERE public_id = ?1 AND user_id = ?2').bind(sessionId, row.id).run();
  if (r.meta.changes !== 1) throw notFound('session');
  await audit(ctx.db, { actor, action: 'user.session_revoke', targetType: 'user', targetId: row.id, targetLabel: row.username, before: { session: sessionId } }, ctx.now);
  return noContent();
}

async function softDelete(ctx, { id }) {
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  if (row.id === actor.id) throw forbidden('You cannot delete your own account here.');
  if (row.status === 'deleted') throw new HttpError(409, 'conflict', 'This account is already deleted.');
  await assertKeepsAnAdmin(ctx, row);
  await ctx.db.batch([
    ctx.db.prepare("UPDATE users SET status = 'deleted', status_before_delete = status, deleted_at = ?2 WHERE id = ?1").bind(row.id, ctx.now),
    ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(row.id),
    ctx.db.prepare('DELETE FROM email_tokens WHERE user_id = ?1').bind(row.id),
    auditStatement(ctx.db, { actor, action: 'user.delete', targetType: 'user', targetId: row.id, targetLabel: row.username, before: { status: row.status }, after: { status: 'deleted' } }, ctx.now),
  ]);
  await evictFromGames(ctx.env, { userIds: [row.id] }, ctx.now);
  return json({ user: adminUser(await target(ctx, row.id)) });
}

async function restore(ctx, { id }) {
  await ctx.body([]);
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  if (row.status !== 'deleted') throw new HttpError(409, 'conflict', 'This account is not deleted.');
  const status = ['pending_email', 'pending_approval', 'active'].includes(row.status_before_delete) ? row.status_before_delete : 'active';
  await ctx.db.batch([
    ctx.db.prepare('UPDATE users SET status = ?2, status_before_delete = NULL, deleted_at = NULL WHERE id = ?1').bind(row.id, status),
    auditStatement(ctx.db, { actor, action: 'user.restore', targetType: 'user', targetId: row.id, targetLabel: row.username, before: { status: 'deleted' }, after: { status } }, ctx.now),
  ]);
  return json({ user: adminUser(await target(ctx, row.id)) });
}

/** Statements that remove an account and every record about it (audit details scrubbed). */
/** A shared map used this recently is in use by a session (see purgeStatements). */
export const SHARED_MAP_IN_USE_MS = 24 * 60 * 60 * 1000;

export function purgeStatements(db, userId, now = Date.now()) {
  return [
    db.prepare(`UPDATE audit_log SET before_json = '{"purged":true}', after_json = '{"purged":true}', target_label = NULL, reason = NULL WHERE target_type = 'user' AND target_id = ?1`).bind(userId),
    db.prepare('DELETE FROM game_presence WHERE user_id = ?1').bind(userId),
    // Saved online games it played in go too (none can be resumed without it).
    purgeOnlineSavesStatement(db, userId),
    // Maps the account shared with online sessions only go too (published maps stay, without the
    // uploader). A shared map is stored once per content, under its first signed-in sharer: one a
    // session used within SHARED_MAP_IN_USE_MS was shared by someone else too (this account's own
    // sessions ended long before a purge), so it stays without the uploader and expires with the
    // other unlisted maps (30 days unused).
    db.prepare('DELETE FROM maps WHERE uploader_id = ?1 AND listed = 0 AND COALESCE(used_at, created_at) < ?2').bind(userId, now - SHARED_MAP_IN_USE_MS),
    db.prepare('DELETE FROM users WHERE id = ?1').bind(userId),
  ];
}

async function purge(ctx, { id }) {
  const body = await ctx.body(['confirm']);
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  if (row.status !== 'deleted') throw new HttpError(409, 'conflict', 'Only deleted accounts can be purged.');
  if (body.confirm !== row.username) throw invalid('confirm', 'Type the username to confirm.');
  await ctx.db.batch([
    ...purgeStatements(ctx.db, row.id, ctx.now),
    auditStatement(ctx.db, { actor, action: 'user.purge', targetType: 'user', targetId: row.id, before: { purged: true }, after: { purged: true } }, ctx.now),
  ]);
  return noContent();
}

async function resetLink(ctx, { id }) {
  const body = await ctx.body(['send']);
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  if (row.status === 'deleted') throw new HttpError(409, 'conflict', 'Restore the account first.');
  if (body.send !== undefined && typeof body.send !== 'boolean') throw invalid('send', 'send must be true or false.');
  // Checked before the token exists: a new token replaces the previous link.
  if (body.send === true) {
    if (!row.email) throw new HttpError(409, 'conflict', 'This account has no email address.');
    if (!(await ctx.eff()).services.email) throw new HttpError(503, 'unavailable', 'Email is not available on this server.');
  }
  const { token, expiresAt } = await createEmailToken(ctx.db, row.id, 'reset', null, TOKEN_TTL_MS.adminReset, ctx.now);
  const url = accountLink(ctx.origin, 'reset', token);
  const sent = body.send === true ? await sendEmail(ctx.env, row.email, resetMessage(row.username, url, 24, { origin: ctx.origin })) : false;
  await audit(ctx.db, { actor, action: 'user.password_reset_link', targetType: 'user', targetId: row.id, targetLabel: row.username, after: { displayed: true, sent, expiresAt } }, ctx.now);
  return json({ url, expiresAt, sent }, 201);
}

/** Give the account (and its recent networks) their one-click relay budgets back (relayquota.js). */
async function resetRelayQuota(ctx, { id }) {
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  const before = await resetRelayQuotas(ctx.db, ctx.salt(), row.id, ctx.now);
  await audit(ctx.db, { actor, action: 'user.relay_quota_reset', targetType: 'user', targetId: row.id, targetLabel: row.username, before, after: null }, ctx.now);
  return json({ relay: await relayQuotas(ctx.db, ctx.salt(), row.id, ctx.now) });
}

async function getUserSettings(ctx, { id }) {
  await ctx.requireRole('admin');
  const row = await target(ctx, id);
  return settingsResponse(await getSettingsDoc(ctx.db, row.id));
}

async function putUserSettings(ctx, { id }) {
  const actor = await ctx.requireRole('admin');
  const row = await target(ctx, id);
  const expected = ifMatchVersion(ctx.request);
  const settings = await readSettingsBody(ctx.request);
  const before = await getSettingsDoc(ctx.db, row.id);
  const doc = await putSettingsDoc(ctx.db, row.id, expected, settings, actor.id, ctx.now);
  await audit(ctx.db, { actor, action: 'user.settings_update', targetType: 'user', targetId: row.id, targetLabel: row.username, before, after: doc }, ctx.now);
  return settingsResponse(doc);
}

// ---- IP bans ---------------------------------------------------------------------------------

async function listIpBans(ctx) {
  await ctx.requireRole('admin');
  const { page: p, limit, offset } = page(ctx.url);
  const active = ctx.url.searchParams.get('active') === '1';
  const where = active ? 'WHERE expires_at IS NULL OR expires_at > ?1' : 'WHERE ?1 = ?1';
  const total = await ctx.db.prepare(`SELECT COUNT(*) AS n FROM ip_bans ${where}`).bind(ctx.now).first();
  const { results } = await ctx.db.prepare(`SELECT * FROM ip_bans ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`).bind(ctx.now).all();
  return json({ bans: results.map((r) => ipBanView(r, ctx.now)), total: total.n, page: p, limit });
}

async function createIpBan(ctx) {
  const body = await ctx.body(['cidr', 'reason', 'expiresAt']);
  const actor = await ctx.requireRole('admin');
  const range = parseCidr(body.cidr);
  if (range.error) throw invalid('cidr', range.error);
  if (inRange(ctx.ip, range)) throw invalid('cidr', 'This range contains your own address.');
  const reason = reasonOf(body.reason);
  const expiresAt = expiry(ctx, body.expiresAt);
  // One transaction: the audit entry names the ban just inserted (ids only grow).
  const entry = auditStatement(ctx.db, { actor, action: 'ipban.create', targetType: 'ipban', targetLabel: range.cidr, after: { cidr: range.cidr, reason, expiresAt }, reason }, ctx.now);
  const [created] = await ctx.db.batch([
    ctx.db
      .prepare('INSERT INTO ip_bans (cidr, ip_v, start_hex, end_hex, reason, created_at, created_by, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING *')
      .bind(range.cidr, range.v, range.start, range.end, reason, ctx.now, actor.id, expiresAt),
    entry,
    ctx.db.prepare('UPDATE audit_log SET target_id = (SELECT CAST(MAX(id) AS TEXT) FROM ip_bans) WHERE id = (SELECT MAX(id) FROM audit_log)'),
  ]);
  const row = created.results[0];
  await evictFromGames(ctx.env, { range }, ctx.now);
  return json({ ban: ipBanView(row, ctx.now) }, 201);
}

async function ipBanById(ctx, id) {
  if (!/^[1-9][0-9]{0,15}$/.test(id)) throw notFound('IP ban');
  const row = await ctx.db.prepare('SELECT * FROM ip_bans WHERE id = ?1').bind(Number(id)).first();
  if (!row) throw notFound('IP ban');
  return row;
}

async function patchIpBan(ctx, { id }) {
  const body = await ctx.body(['reason', 'expiresAt']);
  const actor = await ctx.requireRole('admin');
  const row = await ipBanById(ctx, id);
  const reason = body.reason === undefined ? row.reason : reasonOf(body.reason);
  const expiresAt = body.expiresAt === undefined ? row.expires_at : expiry(ctx, body.expiresAt);
  await ctx.db.batch([
    ctx.db.prepare('UPDATE ip_bans SET reason = ?2, expires_at = ?3 WHERE id = ?1').bind(row.id, reason, expiresAt),
    auditStatement(ctx.db, { actor, action: 'ipban.update', targetType: 'ipban', targetId: String(row.id), targetLabel: row.cidr, before: ipBanView(row, ctx.now), after: { reason, expiresAt } }, ctx.now),
  ]);
  return json({ ban: ipBanView(await ipBanById(ctx, id), ctx.now) });
}

async function deleteIpBan(ctx, { id }) {
  const actor = await ctx.requireRole('admin');
  const row = await ipBanById(ctx, id);
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM ip_bans WHERE id = ?1').bind(row.id),
    auditStatement(ctx.db, { actor, action: 'ipban.delete', targetType: 'ipban', targetId: String(row.id), targetLabel: row.cidr, before: ipBanView(row, ctx.now) }, ctx.now),
  ]);
  return noContent();
}

// ---- Site settings, audit log, stats -------------------------------------------------------------

async function siteView(ctx) {
  const site = await loadSite(ctx.db);
  return json(
    { settings: { version: site.version, ...site.settings }, services: effective(site.settings, ctx.env).services, effective: publicSite(ctx.request, ctx.env, site.settings) },
    200,
    { etag: `"v${site.version}"` },
  );
}

async function getSite(ctx) {
  await ctx.requireRole('admin');
  return siteView(ctx);
}

async function patchSite(ctx) {
  const actor = await ctx.requireRole('admin');
  const expected = ifMatchVersion(ctx.request);
  const body = await ctx.body(['registration', 'login', 'onlineRequiresAccount', 'gameRequiresAccount', 'contentRelay', 'motd']);
  const site = await loadSite(ctx.db);
  if (site.version !== expected) {
    throw new HttpError(412, 'version_conflict', 'The site settings changed meanwhile. Reload and try again.', { etag: `"v${site.version}"` }, {
      current: { version: site.version, settings: site.settings },
    });
  }
  const next = check(() => mergeSiteSettings(site.settings, body), 'settings');
  const version = await saveSite(ctx.db, next, expected, actor.id, ctx.now);
  if (version === null) {
    const current = await loadSite(ctx.db);
    throw new HttpError(412, 'version_conflict', 'The site settings changed meanwhile. Reload and try again.', {}, { current: { version: current.version, settings: current.settings } });
  }
  await audit(ctx.db, { actor, action: 'site.update', targetType: 'site', targetId: 'site', before: site.settings, after: next }, ctx.now);
  return siteView(ctx);
}

async function auditLog(ctx) {
  await ctx.requireRole('admin');
  const url = ctx.url;
  const { page: p, limit, offset } = page(url);
  const where = ['1 = 1'];
  const args = [];
  const arg = (v) => {
    args.push(v);
    return `?${args.length}`;
  };
  const actor = url.searchParams.get('actor');
  if (actor) {
    if (!/^[0-9a-f]{32}$/.test(actor)) throw invalid('actor', 'actor must be a user id.');
    where.push(`actor_id = ${arg(actor)}`);
  }
  const tgt = url.searchParams.get('target');
  if (tgt) {
    if (!/^[0-9a-z]{1,32}$/.test(tgt)) throw invalid('target', 'target must be an id.');
    where.push(`target_id = ${arg(tgt)}`);
  }
  const action = url.searchParams.get('action');
  if (action) {
    if (!AUDIT_ACTIONS.includes(action)) throw invalid('action', 'Unknown action.');
    where.push(`action = ${arg(action)}`);
  }
  for (const [name, op] of [
    ['since', '>='],
    ['until', '<'],
  ]) {
    const v = url.searchParams.get(name);
    if (v === null) continue;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw invalid(name, `${name} must be unix milliseconds.`);
    where.push(`at ${op} ${arg(n)}`);
  }
  const sql = `FROM audit_log WHERE ${where.join(' AND ')}`;
  const total = await ctx.db.prepare(`SELECT COUNT(*) AS n ${sql}`).bind(...args).first();
  const { results } = await ctx.db.prepare(`SELECT * ${sql} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`).bind(...args).all();
  return json({ entries: results.map(auditView), total: total.n, page: p, limit });
}

async function stats(ctx) {
  await ctx.requireRole('moderator');
  const db = ctx.db;
  const now = ctx.now;
  const banned = "EXISTS (SELECT 1 FROM account_bans b WHERE b.user_id = u.id AND b.revoked_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > ?1))";
  const { results: statusRows } = await db
    .prepare(`SELECT CASE WHEN u.status = 'deleted' THEN 'deleted' WHEN ${banned} THEN 'banned' ELSE u.status END AS s, COUNT(*) AS n FROM users u GROUP BY s`)
    .bind(now)
    .all();
  const { results: roleRows } = await db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all();
  const byStatus = Object.fromEntries(ACCOUNT_STATUSES.map((s) => [s, 0]));
  for (const r of statusRows) byStatus[r.s] = r.n;
  const byRole = Object.fromEntries(ACCOUNT_ROLES.map((r) => [r, 0]));
  for (const r of roleRows) byRole[r.role] = r.n;
  const one = async (sql, ...args) => (await db.prepare(sql).bind(...args).first()).n;
  const fresh = now - 2 * 60 * 1000;
  return json({
    users: {
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
      byRole,
      newLast7Days: await one('SELECT COUNT(*) AS n FROM users WHERE created_at > ?1', now - 7 * 24 * 60 * 60 * 1000),
    },
    sessions: { active: await one('SELECT COUNT(*) AS n FROM auth_sessions WHERE expires_at > ?1 AND last_used_at > ?2', now, now - 14 * 24 * 60 * 60 * 1000) },
    games: {
      lobbies: await one("SELECT COUNT(*) AS n FROM sessions WHERE state = 'lobby' AND updated_at > ?1", fresh),
      running: await one("SELECT COUNT(*) AS n FROM sessions WHERE state = 'game' AND updated_at > ?1", fresh),
    },
    maps: { total: await one('SELECT COUNT(*) AS n FROM maps') },
    bans: {
      accounts: await one('SELECT COUNT(*) AS n FROM account_bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)', now),
      ips: await one('SELECT COUNT(*) AS n FROM ip_bans WHERE expires_at IS NULL OR expires_at > ?1', now),
    },
    services: effective((await ctx.site()).settings, ctx.env).services,
  });
}

export function registerAdminRoutes(router) {
  const read = { csrfRead: true };
  router
    .add('GET', '/api/admin/users', listUsers, read)
    .add('GET', '/api/admin/users/:id', userDetail, read)
    .add('PATCH', '/api/admin/users/:id', patchUser)
    .add('DELETE', '/api/admin/users/:id', softDelete)
    .add('POST', '/api/admin/users/:id/approve', approve)
    .add('POST', '/api/admin/users/:id/reject', reject)
    .add('POST', '/api/admin/users/:id/ban', ban)
    .add('DELETE', '/api/admin/users/:id/ban', unban)
    .add('POST', '/api/admin/users/:id/logout', forceLogout)
    .add('DELETE', '/api/admin/users/:id/sessions/:sessionId', revokeUserSession)
    .add('POST', '/api/admin/users/:id/restore', restore)
    .add('POST', '/api/admin/users/:id/purge', purge)
    .add('POST', '/api/admin/users/:id/password-reset', resetLink)
    .add('POST', '/api/admin/users/:id/email/verify', markEmailVerified)
    .add('POST', '/api/admin/users/:id/email/resend', resendEmailLink)
    .add('DELETE', '/api/admin/users/:id/relay-quota', resetRelayQuota)
    .add('GET', '/api/admin/users/:id/settings', getUserSettings, read)
    .add('PUT', '/api/admin/users/:id/settings', putUserSettings)
    .add('GET', '/api/admin/ip-bans', listIpBans, read)
    .add('POST', '/api/admin/ip-bans', createIpBan)
    .add('PATCH', '/api/admin/ip-bans/:id', patchIpBan)
    .add('DELETE', '/api/admin/ip-bans/:id', deleteIpBan)
    .add('GET', '/api/admin/site', getSite, read)
    .add('PATCH', '/api/admin/site', patchSite)
    .add('GET', '/api/admin/audit', auditLog, read)
    .add('GET', '/api/admin/stats', stats, read);
}

