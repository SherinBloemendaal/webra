// Self service: /api/account/* (docs/accounts-api.md, section 5).

import {
  DEVICE_LABEL_MAX,
  emailKey,
  PASSKEY_NAME_MAX,
  usernameKey,
  validAvatarColor,
  validDisplayName,
  validEmail,
  validLabel,
  validNewPassword,
  validUsername,
} from '@webra/protocol';
import { HttpError, json } from '../http.js';
import { check, invalid } from './context.js';
import { pendingEmailOf, rotate, selfView } from './common.js';
import { accountBanView } from './bans.js';
import { auditView } from './audit.js';
import { hashAccountPassword } from './password.js';
import {
  consumeChallenge,
  createChallenge,
  creationOptions,
  duplicatePasskey,
  insertPasskey,
  listPasskeys,
  passkeyConflict,
  passkeyView,
  PASSKEYS_MAX,
} from './passkeys.js';
import { listSessions, revokeAllSessions, sessionView, signOutCookies } from './sessions.js';
import { getSettingsDoc, ifMatchVersion, putSettingsDoc, readSettingsBody, settingsResponse } from './settings-doc.js';
import { hasPassword, softDeleteStatement, uniqueViolation, USERNAME_CHANGE_MS, userById } from './users.js';
import { evictFromGames } from './bans.js';
import { HOUR, requirePasskeys, verifyPasskeyRegistration } from './routes-auth.js';
import { MAIL_LIMITS, queueAddressMail } from './verification.js';
import { networkOf } from './ip.js';
import { deleteAccountReplaysStatement, drainReplayTrash, listReplayRows, replayView } from './replays.js';
import { friendsCleanupStatements, friendsExport } from './friends.js';
import { closeUserSockets, friendIds, isStaffRole, notify, originOf, publishAdmin, publishToFriendsOf, publishToUsers, revoke } from '../realtime/publish.js';

const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
const lastMethod = () => new HttpError(409, 'conflict', 'Keep at least one way to sign in.');
const isStaff = (user) => isStaffRole(user.role);

/** After the answer: `account/<kind>` to the account's other tabs and devices (realtime/publish.js). */
function accountHint(ctx, user, kind = 'profile') {
  notify(ctx, async (env) => publishToUsers(env, [user.id], { topic: 'account', kind, origin: await originOf(ctx) }));
}

async function me(ctx) {
  const user = await ctx.requireUser();
  return { user, view: await selfView(ctx, user.id) };
}

async function getAccount(ctx) {
  return json({ user: (await me(ctx)).view });
}

async function patchAccount(ctx) {
  const body = await ctx.body(['displayName', 'avatarColor', 'username']);
  const user = await ctx.requireUser();
  await ctx.limit('profile', user.id, 30, HOUR);
  const sets = [];
  const args = [];
  const add = (sql, v) => {
    args.push(v);
    sets.push(`${sql} = ?${args.length + 1}`);
  };
  if (body.displayName !== undefined) add('display_name', check(() => validDisplayName(body.displayName)));
  if (body.avatarColor !== undefined) add('avatar_color', check(() => validAvatarColor(body.avatarColor)));
  if (body.username !== undefined) {
    const username = check(() => validUsername(body.username));
    if (username !== user.username) {
      if (user.username_changed_at !== null && user.username_changed_at + USERNAME_CHANGE_MS > ctx.now) {
        throw new HttpError(403, 'forbidden', 'You can change your username once every 30 days.', {}, { field: 'username' });
      }
      add('username', username);
      add('username_key', usernameKey(username));
      add('username_changed_at', ctx.now);
    }
  }
  if (sets.length > 0) {
    try {
      await ctx.db
        .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?1`)
        .bind(user.id, ...args)
        .run();
    } catch (err) {
      if (uniqueViolation(err) === 'username') throw new HttpError(409, 'conflict', 'This username is taken.', {}, { field: 'username' });
      throw err;
    }
    accountHint(ctx, user);
    // Names and colours show in the friends' lists.
    notify(ctx, (env) => publishToFriendsOf(env, ctx.db, user.id, { topic: 'friends', kind: 'presence' }));
  }
  return json({ user: await selfView(ctx, user.id) });
}

/**
 * Set or change the password. Needs a fresh re-authentication (POST
 * /api/auth/reauth): this request then does exactly one key derivation (the
 * new hash), which also upgrades the iteration count and pepper.
 */
async function changePassword(ctx) {
  const body = await ctx.body(['newPassword']);
  const user = await ctx.requireUser();
  if (!(await ctx.eff()).login.password) throw new HttpError(403, 'method_disabled', 'Signing in with a password is switched off.');
  if (typeof body.newPassword !== 'string') throw invalid('newPassword', 'Choose a new password.');
  await ctx.requireReauth();
  const pw = check(() => validNewPassword(body.newPassword, { username: user.username, email: user.email }, 'newPassword'));
  const h = await hashAccountPassword(pw, ctx.env);
  await ctx.db
    .prepare('UPDATE users SET password_hash = ?2, password_salt = ?3, password_iterations = ?4, password_peppered = ?5, password_changed_at = ?6 WHERE id = ?1')
    .bind(user.id, h.hash, h.salt, h.iterations, h.peppered, ctx.now)
    .run();
  const { session } = await ctx.auth();
  await revokeAllSessions(ctx.db, user.id, { except: session.id_hash });
  revoke(ctx, (env) => closeUserSockets(env, user.id, { except: session.public_id, staff: isStaff(user) }));
  await rotate(ctx, { reauth: true });
  return json({ user: await selfView(ctx, user.id) });
}

/** SQL condition: the account keeps a way to sign in besides `except` ('password', 'discord' or a passkey id). */
const OTHER_METHOD = {
  password: '(u.discord_id IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id))',
  discord: '(u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id))',
};

async function removePassword(ctx) {
  const user = await ctx.requireUser();
  await ctx.requireReauth();
  if (!hasPassword(user)) throw new HttpError(409, 'conflict', 'This account has no password.');
  // One conditional statement: two concurrent removals can never leave the account without a method.
  const r = await ctx.db
    .prepare(
      `UPDATE users AS u SET password_hash = NULL, password_salt = NULL, password_iterations = NULL, password_peppered = 0, password_changed_at = ?2
       WHERE u.id = ?1 AND u.password_hash IS NOT NULL AND ${OTHER_METHOD.password}`,
    )
    .bind(user.id, ctx.now)
    .run();
  if (r.meta.changes !== 1) throw lastMethod();
  accountHint(ctx, user);
  await rotate(ctx);
  return json({ user: await selfView(ctx, user.id) });
}

/**
 * Add or change the address (recent re-authentication). A verified address
 * stays until the new one is confirmed through its link (`pendingEmail`);
 * no address or an unverified one is replaced at once (unverified addresses
 * claim nothing) and a link is sent when email works. Whether another
 * account verified the new address is never answered (src/accounts/verification.js).
 */
async function changeEmail(ctx) {
  const body = await ctx.body(['email']);
  const user = await ctx.requireUser();
  await ctx.requireReauth();
  const email = check(() => validEmail(body.email));
  const eff = await ctx.eff();
  if (user.email === email || (user.email_verified === 1 && user.email_key === emailKey(email))) return json({ user: await selfView(ctx, user.id) });
  if (user.email_verified === 1 && !eff.login.email) {
    throw new HttpError(503, 'unavailable', 'A confirmed address can be changed once this server sends verification email.');
  }
  await ctx.limit('email-change', user.id, ...MAIL_LIMITS.changeAccount);
  await ctx.limit('email-change-net', networkOf(ctx.ip), ...MAIL_LIMITS.changeNetwork);
  if (user.email_verified === 1) {
    queueAddressMail(ctx, { userId: user.id, username: user.username, email, purpose: 'change' });
    return json({ user: await selfView(ctx, user.id, { pendingEmail: email }) }, 202);
  }
  await ctx.db.batch([
    ctx.db.prepare('UPDATE users SET email = ?2, email_key = NULL, email_verified = 0, email_set_at = ?3 WHERE id = ?1').bind(user.id, email, ctx.now),
    ctx.db.prepare("DELETE FROM email_tokens WHERE user_id = ?1 AND purpose IN ('verify', 'change')").bind(user.id),
  ]);
  if (eff.login.email) queueAddressMail(ctx, { userId: user.id, username: user.username, email, purpose: 'verify' });
  accountHint(ctx, user);
  return json({ user: await selfView(ctx, user.id) });
}

/** Send the link for the account's unverified address again (limited per account and per network). */
async function resendVerification(ctx) {
  await ctx.body([]);
  const user = await ctx.requireUser();
  const eff = await ctx.eff();
  if (!eff.services.email) throw new HttpError(503, 'unavailable', 'Verification email is not available on this server yet.');
  if (!eff.login.email) throw new HttpError(403, 'method_disabled', 'Email links are switched off.');
  if (!user.email || user.email_verified === 1) throw new HttpError(409, 'conflict', 'There is no unverified email address to confirm.');
  await ctx.limit('verify-resend', user.id, ...MAIL_LIMITS.resendAccount, 'You asked for several links already. Try again later.');
  await ctx.limit('verify-resend-day', user.id, ...MAIL_LIMITS.resendAccountDay, 'You asked for several links already. Try again tomorrow.');
  await ctx.limit('verify-resend-net', networkOf(ctx.ip), ...MAIL_LIMITS.resendNetwork, 'Too many links were asked for from your network. Try again later.');
  queueAddressMail(ctx, { userId: user.id, username: user.username, email: user.email, purpose: 'verify' });
  return json({}, 202);
}

/** Addresses are required: an account changes its address but never removes it (docs/accounts-api.md 5.4). */
async function removeEmail(ctx) {
  await ctx.requireUser();
  throw new HttpError(409, 'conflict', 'An email address is required. Change it instead, or delete the account.');
}

// ---- Passkeys ---------------------------------------------------------------------------

async function getPasskeys(ctx) {
  const user = await ctx.requireUser();
  return json({ passkeys: (await listPasskeys(ctx.db, user.id)).map(passkeyView) });
}

async function passkeyOptions(ctx) {
  await ctx.body([]);
  const user = await ctx.requireUser();
  const rpId = await requirePasskeys(ctx);
  await ctx.requireReauth();
  const existing = await listPasskeys(ctx.db, user.id);
  if (existing.length >= PASSKEYS_MAX) throw new HttpError(409, 'conflict', `At most ${PASSKEYS_MAX} passkeys per account.`);
  const c = await createChallenge(ctx.db, 'register', { userId: user.id }, ctx.now);
  return json({
    challengeId: c.id,
    publicKey: creationOptions({ rpId, challenge: c.challenge, userHandle: user.user_handle, username: user.username, displayName: user.display_name, exclude: existing }),
  });
}

async function addPasskey(ctx) {
  const body = await ctx.body(['challengeId', 'name', 'credential'], 64 * 1024);
  const user = await ctx.requireUser();
  await requirePasskeys(ctx);
  await ctx.requireReauth();
  const name = check(() => validLabel(body.name, PASSKEY_NAME_MAX, 'name'));
  const c = await consumeChallenge(ctx.db, body.challengeId, 'register', { userId: user.id }, ctx.now);
  if (!c) throw invalid('challengeId', 'The passkey request expired. Try again.');
  const reg = await verifyPasskeyRegistration(ctx, c.challenge, body.credential);
  const count = await ctx.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?1').bind(user.id).first();
  if (count.n >= PASSKEYS_MAX) throw new HttpError(409, 'conflict', `At most ${PASSKEYS_MAX} passkeys per account.`);
  try {
    await insertPasskey(ctx.db, user.id, name, reg, ctx.now).run();
  } catch (err) {
    if (duplicatePasskey(err)) throw passkeyConflict();
    throw err;
  }
  accountHint(ctx, user);
  await rotate(ctx);
  const row = await ctx.db.prepare('SELECT * FROM passkeys WHERE id = ?1').bind(reg.credentialId).first();
  return json({ passkey: passkeyView(row) }, 201);
}

async function ownPasskey(ctx, user, id) {
  const row = await ctx.db.prepare('SELECT * FROM passkeys WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!row) throw new HttpError(404, 'not_found', 'No such passkey.');
  return row;
}

async function renamePasskey(ctx, { id }) {
  const body = await ctx.body(['name']);
  const user = await ctx.requireUser();
  await ownPasskey(ctx, user, id);
  const name = check(() => validLabel(body.name, PASSKEY_NAME_MAX, 'name'));
  await ctx.db.prepare('UPDATE passkeys SET name = ?2 WHERE id = ?1').bind(id, name).run();
  return json({ passkey: passkeyView(await ownPasskey(ctx, user, id)) });
}

async function deletePasskey(ctx, { id }) {
  const user = await ctx.requireUser();
  await ctx.requireReauth();
  await ownPasskey(ctx, user, id);
  const r = await ctx.db
    .prepare(
      `DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2 AND EXISTS (
         SELECT 1 FROM users u WHERE u.id = ?2 AND (u.password_hash IS NOT NULL OR u.discord_id IS NOT NULL
           OR (SELECT COUNT(*) FROM passkeys q WHERE q.user_id = ?2) > 1))`,
    )
    .bind(id, user.id)
    .run();
  if (r.meta.changes !== 1) throw lastMethod();
  accountHint(ctx, user);
  await rotate(ctx);
  return noContent();
}

async function unlinkDiscord(ctx) {
  const user = await ctx.requireUser();
  await ctx.requireReauth();
  if (!user.discord_id) throw new HttpError(409, 'conflict', 'No Discord account is linked.');
  const r = await ctx.db
    .prepare(`UPDATE users AS u SET discord_id = NULL, discord_username = NULL, discord_linked_at = NULL WHERE u.id = ?1 AND u.discord_id IS NOT NULL AND ${OTHER_METHOD.discord}`)
    .bind(user.id)
    .run();
  if (r.meta.changes !== 1) throw lastMethod();
  accountHint(ctx, user);
  await rotate(ctx);
  return json({ user: await selfView(ctx, user.id) });
}

// ---- Sessions --------------------------------------------------------------------------------

async function getSessions(ctx) {
  const user = await ctx.requireUser();
  const { session } = await ctx.auth();
  return json({ sessions: (await listSessions(ctx.db, user.id)).map((s) => sessionView(s, session.id_hash)) });
}

async function ownSession(ctx, user, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new HttpError(404, 'not_found', 'No such session.');
  const row = await ctx.db.prepare('SELECT * FROM auth_sessions WHERE public_id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!row) throw new HttpError(404, 'not_found', 'No such session.');
  return row;
}

async function labelSession(ctx, { id }) {
  const body = await ctx.body(['deviceLabel']);
  const user = await ctx.requireUser();
  await ownSession(ctx, user, id);
  const label = check(() => validLabel(body.deviceLabel, DEVICE_LABEL_MAX, 'deviceLabel'));
  await ctx.db.prepare('UPDATE auth_sessions SET device_label = ?2 WHERE public_id = ?1').bind(id, label).run();
  const { session } = await ctx.auth();
  return json({ session: sessionView(await ownSession(ctx, user, id), session.id_hash) });
}

async function revokeSession(ctx, { id }) {
  const user = await ctx.requireUser();
  const row = await ownSession(ctx, user, id);
  await ctx.db.prepare('DELETE FROM auth_sessions WHERE id_hash = ?1').bind(row.id_hash).run();
  revoke(ctx, (env) => closeUserSockets(env, user.id, { sids: [row.public_id], staff: isStaff(user) }));
  const { session } = await ctx.auth();
  if (row.id_hash === session.id_hash) ctx.cookies.push(...signOutCookies(ctx.request));
  return noContent();
}

async function revokeOtherSessions(ctx) {
  const user = await ctx.requireUser();
  const { session } = await ctx.auth();
  await revokeAllSessions(ctx.db, user.id, { except: session.id_hash });
  revoke(ctx, (env) => closeUserSockets(env, user.id, { except: session.public_id, staff: isStaff(user) }));
  return noContent();
}

// ---- Settings document --------------------------------------------------------------------------

async function getSettings(ctx) {
  const user = await ctx.requireUser();
  return settingsResponse(await getSettingsDoc(ctx.db, user.id));
}

async function putSettings(ctx) {
  const user = await ctx.requireUser();
  const expected = ifMatchVersion(ctx.request);
  const settings = await readSettingsBody(ctx.request);
  await ctx.limit('settings', user.id, 120, HOUR);
  const doc = await putSettingsDoc(ctx.db, user.id, expected, settings, user.id, ctx.now);
  // The device that saved has the new version already; the others load it.
  notify(ctx, async (env) => publishToUsers(env, [user.id], { topic: 'settings', kind: 'updated', data: { version: doc.version }, origin: await originOf(ctx) }));
  return settingsResponse(doc);
}

// ---- Export and deletion ---------------------------------------------------------------------------

async function exportData(ctx) {
  const user = await ctx.requireUser();
  await ctx.requireReauth();
  await ctx.limit('export', user.id, 5, HOUR);
  const db = ctx.db;
  const all = async (sql) => (await db.prepare(sql).bind(user.id).all()).results;
  const row = await userById(db, user.id, ctx.now);
  const { session } = await ctx.auth();
  const data = {
    format: 'webra-account-export',
    version: 1,
    exportedAt: ctx.now,
    account: {
      ...(await selfView(ctx, user.id)),
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      passwordChangedAt: row.password_changed_at,
      passkeyUserHandle: row.user_handle,
      discord: row.discord_id ? { id: row.discord_id, username: row.discord_username, linkedAt: row.discord_linked_at } : null,
    },
    passkeys: (await listPasskeys(db, user.id)).map((p) => ({ ...passkeyView(p), signCount: p.sign_count, userVerified: p.uv === 1 })),
    sessions: (await listSessions(db, user.id)).map((s) => sessionView(s, session.id_hash)),
    ipHistory: (await all('SELECT ip, first_seen, last_seen, count FROM user_ips WHERE user_id = ?1 ORDER BY last_seen DESC')).map((r) => ({
      ip: r.ip,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      count: r.count,
    })),
    bans: (await all('SELECT * FROM account_bans WHERE user_id = ?1 ORDER BY id')).map(accountBanView),
    settings: await getSettingsDoc(db, user.id),
    emailTokens: (await all('SELECT purpose, email, created_at, expires_at FROM email_tokens WHERE user_id = ?1')).map((t) => ({
      purpose: t.purpose,
      email: t.email,
      createdAt: t.created_at,
      expiresAt: t.expires_at,
    })),
    pendingEmail: await pendingEmailOf(db, user.id, ctx.now),
    maps: (await all('SELECT id, name, hash, created_at, listed, used_at FROM maps WHERE uploader_id = ?1 ORDER BY created_at')).map((m) => ({
      id: m.id,
      name: m.name,
      hash: m.hash,
      createdAt: m.created_at,
      // Published to the community list, or shared with online sessions only (and when last used).
      published: m.listed === 1,
      usedAt: m.used_at,
    })),
    // Saved online games this account played in (the server's records; the files are in the players' browsers).
    onlineSaves: (
      await all(
        `SELECT s.id, s.created_at, s.title, s.ticks, s.engine, m.seat FROM online_saves s
         JOIN online_save_members m ON m.save_id = s.id WHERE m.user_id = ?1 ORDER BY s.created_at`,
      )
    ).map((r) => ({ id: r.id, createdAt: r.created_at, title: r.title, ticks: r.ticks, engine: r.engine, seat: r.seat })),
    // Replays kept in the account (what the list shows; the files download from the Replays list).
    replays: (await listReplayRows(db, user.id, ctx.now)).map(replayView),
    // Friends, requests, blocks, invites and the presence heartbeat (5.11).
    friends: await friendsExport(db, user.id, ctx.now),
    gamePresence: (await all('SELECT session_id, client, updated_at FROM game_presence WHERE user_id = ?1')).map((p) => ({
      session: p.session_id,
      client: p.client,
      updatedAt: p.updated_at,
    })),
    auditLog: (await all("SELECT * FROM audit_log WHERE target_type = 'user' AND target_id = ?1 ORDER BY id")).map(auditView),
  };
  const safeName = user.username.replace(/[^A-Za-z0-9_.-]/g, '_');
  return json(data, 200, { 'content-disposition': `attachment; filename="webra-account-${safeName}.json"` });
}

async function deleteAccount(ctx) {
  const body = await ctx.body(['confirm']);
  const user = await ctx.requireUser();
  await ctx.requireReauth();
  if (body.confirm !== user.username) throw invalid('confirm', 'Type your username to confirm.');
  if (user.role === 'admin') {
    const others = await ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id != ?1").bind(user.id).first();
    if (others.n === 0) throw new HttpError(409, 'conflict', 'You are the last admin. Make someone else an admin first.');
  }
  // The friends rows go with the account: who to tell is read first.
  const friends = await friendIds(ctx.db, user.id);
  await ctx.db.batch([
    softDeleteStatement(ctx.db, user.id, ctx.now),
    ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(user.id),
    ctx.db.prepare('DELETE FROM email_tokens WHERE user_id = ?1').bind(user.id),
    // Replays in the account go at once (they hold other players' names and chat), their files right after.
    deleteAccountReplaysStatement(ctx.db, user.id),
    // Friends, requests, blocks, invites and presence go at once (others see the account vanish).
    ...friendsCleanupStatements(ctx.db, user.id),
  ]);
  ctx.background('replay trash', () => drainReplayTrash(ctx.env, ctx.now));
  ctx.cookies.push(...signOutCookies(ctx.request));
  revoke(ctx, (env) => closeUserSockets(env, user.id, { staff: isStaff(user) }));
  notify(ctx, async (env) => {
    await publishToUsers(env, friends, { topic: 'friends', kind: 'remove', data: { username: user.username } });
    await publishAdmin(env, { kind: 'user_deleted', data: { userId: user.id } });
  });
  await evictFromGames(ctx.env, { userIds: [user.id] }, ctx.now);
  return noContent();
}

export function registerAccountRoutes(router) {
  const csrfRead = { csrfRead: true };
  router
    .add('GET', '/api/account', getAccount, csrfRead)
    .add('PATCH', '/api/account', patchAccount)
    .add('DELETE', '/api/account', deleteAccount)
    .add('POST', '/api/account/password', changePassword)
    .add('DELETE', '/api/account/password', removePassword)
    .add('POST', '/api/account/email', changeEmail)
    .add('DELETE', '/api/account/email', removeEmail)
    .add('POST', '/api/account/email/resend', resendVerification)
    .add('GET', '/api/account/passkeys', getPasskeys, csrfRead)
    .add('POST', '/api/account/passkeys', addPasskey)
    .add('POST', '/api/account/passkeys/options', passkeyOptions)
    .add('PATCH', '/api/account/passkeys/:id', renamePasskey)
    .add('DELETE', '/api/account/passkeys/:id', deletePasskey)
    .add('DELETE', '/api/account/discord', unlinkDiscord)
    .add('GET', '/api/account/sessions', getSessions, csrfRead)
    .add('DELETE', '/api/account/sessions', revokeOtherSessions)
    .add('PATCH', '/api/account/sessions/:id', labelSession)
    .add('DELETE', '/api/account/sessions/:id', revokeSession)
    .add('GET', '/api/account/settings', getSettings, csrfRead)
    .add('PUT', '/api/account/settings', putSettings)
    .add('GET', '/api/account/export', exportData, csrfRead);
}

