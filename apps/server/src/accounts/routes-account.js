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
import { clearSessionCookie, listSessions, revokeAllSessions, sessionView } from './sessions.js';
import { getSettingsDoc, ifMatchVersion, putSettingsDoc, readSettingsBody, settingsResponse } from './settings-doc.js';
import { hasPassword, uniqueViolation, USERNAME_CHANGE_MS, userById } from './users.js';
import { evictFromGames } from './bans.js';
import { DAY, emailTaken, HOUR, requirePasskeys, sendVerification, verifyPasskeyRegistration } from './routes-auth.js';

const noContent = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
const lastMethod = () => new HttpError(409, 'conflict', 'Keep at least one way to sign in.');

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
  await rotate(ctx);
  return json({ user: await selfView(ctx, user.id) });
}

async function changeEmail(ctx) {
  const body = await ctx.body(['email']);
  const user = await ctx.requireUser();
  await ctx.requireReauth();
  const email = check(() => validEmail(body.email));
  // Addresses are only taken through a confirmation link: none while email cannot be sent.
  if (!(await ctx.eff()).login.email) throw new HttpError(503, 'unavailable', 'Email addresses can be changed once this server can confirm them.');
  await ctx.limit('email-change', user.id, 5, DAY);
  if (await emailTaken(ctx.db, email, user.id)) throw new HttpError(409, 'conflict', 'This email address is already used by another account.', {}, { field: 'email' });
  if (user.email_key === emailKey(email)) return json({ user: await selfView(ctx, user.id) }, 202);
  if (!(await sendVerification(ctx, user.id, user.username, email, 'change'))) {
    await ctx.db.prepare("DELETE FROM email_tokens WHERE user_id = ?1 AND purpose = 'change'").bind(user.id).run();
    throw new HttpError(503, 'unavailable', 'The email could not be sent. Try again later.');
  }
  return json({ user: await selfView(ctx, user.id) }, 202);
}

async function resendVerification(ctx) {
  await ctx.body([]);
  const user = await ctx.requireUser();
  const eff = await ctx.eff();
  if (!eff.services.email) throw new HttpError(503, 'unavailable', 'Email is not available on this server.');
  if (!eff.login.email) throw new HttpError(403, 'method_disabled', 'Email links are switched off.');
  if (!user.email || user.email_verified === 1) throw new HttpError(409, 'conflict', 'There is no unverified email address to confirm.');
  await ctx.limit('verify-resend', user.id, 3, HOUR);
  if (!(await sendVerification(ctx, user.id, user.username, user.email, 'verify'))) {
    throw new HttpError(503, 'unavailable', 'The email could not be sent. Try again later.');
  }
  return json({}, 202);
}

async function removeEmail(ctx) {
  const user = await ctx.requireUser();
  await ctx.requireReauth();
  if ((await ctx.eff()).emailVerificationRequired) throw new HttpError(409, 'conflict', 'An email address is required on this server.');
  await ctx.db.batch([
    ctx.db.prepare('UPDATE users SET email = NULL, email_key = NULL, email_verified = 0 WHERE id = ?1').bind(user.id),
    ctx.db.prepare("DELETE FROM email_tokens WHERE user_id = ?1 AND purpose IN ('verify', 'change')").bind(user.id),
  ]);
  return json({ user: await selfView(ctx, user.id) });
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
  const { session } = await ctx.auth();
  if (row.id_hash === session.id_hash) ctx.cookies.push(clearSessionCookie(ctx.request));
  return noContent();
}

async function revokeOtherSessions(ctx) {
  const user = await ctx.requireUser();
  const { session } = await ctx.auth();
  await revokeAllSessions(ctx.db, user.id, { except: session.id_hash });
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
  return settingsResponse(await putSettingsDoc(ctx.db, user.id, expected, settings, user.id, ctx.now));
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
    maps: (await all('SELECT id, name, hash, created_at FROM maps WHERE uploader_id = ?1 ORDER BY created_at')).map((m) => ({
      id: m.id,
      name: m.name,
      hash: m.hash,
      createdAt: m.created_at,
    })),
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
  await ctx.db.batch([
    ctx.db.prepare("UPDATE users SET status = 'deleted', status_before_delete = status, deleted_at = ?2 WHERE id = ?1").bind(user.id, ctx.now),
    ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(user.id),
    ctx.db.prepare('DELETE FROM email_tokens WHERE user_id = ?1').bind(user.id),
  ]);
  ctx.cookies.push(clearSessionCookie(ctx.request));
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

