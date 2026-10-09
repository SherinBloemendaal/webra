// /api/site and /api/auth/* (docs/accounts-api.md, sections 3 and 4).

import {
  emailKey,
  loginPassword,
  usernameKey,
  validDisplayName,
  validEmail,
  validNewPassword,
  validUsername,
} from '@webra/protocol';
import { HttpError, json } from '../http.js';
import { randomToken, sha256Hex } from '../crypto.js';
import { bannedError, check, invalid } from './context.js';
import { rotate, selfView, signIn, statusAfterVerification } from './common.js';
import { accountLink, consumeEmailToken, createEmailToken, resetMessage, sendEmail, TOKEN_TTL_MS, verifyMessage } from './email.js';
import { dummyVerify, hashAccountPassword, needsRehash, verifyAccountPassword } from './password.js';
import {
  consumeChallenge,
  createChallenge,
  creationOptions,
  duplicatePasskey,
  insertPasskey,
  listPasskeys,
  passkeyConflict,
  requestOptions,
} from './passkeys.js';
import { publicSite } from './site.js';
import { clearSessionCookie, reauthUntil, sessionToken } from './sessions.js';
import { banOf, initialStatus, insertUser, uniqueViolation, userByEmail, userById, userByUsername } from './users.js';
import { assertionIds, rpIdFor, verifyAuthentication, verifyRegistration, WebAuthnError } from './webauthn.js';
import { clearQuota } from '../quota.js';

export const MIN15 = 15 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const LIMITS = {
  signup: [10, HOUR],
  loginIp: [30, MIN15],
  loginFail: [10, MIN15],
  loginFailDay: [50, DAY],
  passkeyIp: [30, MIN15],
  reauthFail: [10, MIN15],
  forgotIp: [5, HOUR],
  forgotEmail: [3, HOUR],
  tokenIp: [20, MIN15],
  discordIp: [20, MIN15],
};

const badCredentials = (message = 'Wrong sign-in details.') => new HttpError(401, 'bad_credentials', message);

export function methodDisabled(name) {
  return new HttpError(403, 'method_disabled', `Signing in with ${name} is switched off.`);
}

/** The rp id for passkeys on this host, or 503. */
export function requireRpId(ctx) {
  const rpId = rpIdFor(ctx.request);
  if (!rpId) throw new HttpError(503, 'unavailable', 'Passkeys are not available on this address.');
  return rpId;
}

export async function requirePasskeys(ctx) {
  if (!(await ctx.eff()).login.passkey) throw methodDisabled('passkeys');
  return requireRpId(ctx);
}

/** Key for sign-in lockouts: the normalized login name (existing or not). */
function loginKey(login) {
  const s = login.trim();
  if (s.includes('@')) return `e:${emailKey(s)}`;
  return `u:${usernameKey(s.normalize('NFC').replace(/\s+/g, ' '))}`;
}

/** Verify an assertion against the stored passkey; returns the user row. Generic 401 on failure. */
export async function verifyPasskeyAssertion(ctx, challenge, credential, { userId = null } = {}) {
  const rpId = requireRpId(ctx);
  try {
    const ids = assertionIds(credential);
    const pk = await ctx.db.prepare('SELECT * FROM passkeys WHERE id = ?1').bind(ids.credentialId).first();
    if (!pk || (userId !== null && pk.user_id !== userId)) throw new WebAuthnError('unknown credential');
    const user = await userById(ctx.db, pk.user_id, ctx.now);
    if (!user || (ids.userHandle !== null && ids.userHandle !== user.user_handle)) throw new WebAuthnError('user handle');
    const r = await verifyAuthentication({
      credential,
      challenge,
      origin: ctx.origin,
      rpId,
      stored: { publicKey: pk.public_key, alg: pk.alg, signCount: pk.sign_count },
    });
    if (r.counterError) {
      await ctx.db.prepare('UPDATE passkeys SET counter_error = 1 WHERE id = ?1').bind(pk.id).run();
      throw new WebAuthnError('signature counter went backwards');
    }
    await ctx.db
      .prepare('UPDATE passkeys SET sign_count = ?2, last_used_at = ?3, uv = ?4, backed_up = ?5 WHERE id = ?1')
      .bind(pk.id, r.signCount, ctx.now, r.uv ? 1 : 0, r.backedUp ? 1 : 0)
      .run();
    return user;
  } catch (err) {
    if (err instanceof WebAuthnError) throw badCredentials('The passkey could not be verified.');
    throw err;
  }
}

/** Verify a registration ceremony; generic 400 on failure. */
export async function verifyPasskeyRegistration(ctx, challenge, credential) {
  const rpId = requireRpId(ctx);
  try {
    return await verifyRegistration({ credential, challenge, origin: ctx.origin, rpId });
  } catch (err) {
    if (err instanceof WebAuthnError) throw invalid('credential', 'The passkey could not be registered.');
    throw err;
  }
}

// ---- Handlers -----------------------------------------------------------------------------

async function getSite(ctx) {
  return json(publicSite(ctx.request, ctx.env, (await ctx.site()).settings));
}

async function getMe(ctx) {
  await ctx.assertIpAllowed();
  const { session, user } = await ctx.auth();
  if (!user) return json({ user: null, session: null });
  return json({
    user: await selfView(ctx, user.id),
    session: { id: session.public_id, createdAt: session.created_at, expiresAt: session.expires_at, reauthUntil: reauthUntil(session) },
  });
}

async function signup(ctx) {
  const body = await ctx.body(['username', 'displayName', 'email', 'password', 'passkey', 'acceptPrivacy']);
  await ctx.assertIpAllowed();
  const eff = await ctx.eff();
  if (!eff.registrationOpen) throw new HttpError(403, 'registration_closed', 'Signup is closed right now.');
  if (body.acceptPrivacy !== true) throw invalid('acceptPrivacy', 'Please accept the privacy notice.');
  const username = check(() => validUsername(body.username));
  const displayName = body.displayName === undefined || body.displayName === null || body.displayName === '' ? username : check(() => validDisplayName(body.displayName));
  let email = null;
  if (body.email !== undefined && body.email !== null && body.email !== '') email = check(() => validEmail(body.email));
  if (!email && eff.emailVerificationRequired) throw invalid('email', 'An email address is required.');
  const hasPassword = body.password !== undefined && body.password !== null;
  const hasPasskey = body.passkey !== undefined && body.passkey !== null;
  if (hasPassword === hasPasskey) throw invalid('password', 'Choose a password or a passkey.');

  // Counted once the request is well formed, before any expensive work or lookups.
  await ctx.limit('signup', ctx.ip, ...LIMITS.signup, 'Too many signups from your network. Try again later.');
  let password = null;
  let registration = null;
  let userHandle;
  if (hasPassword) {
    if (!eff.login.password) throw methodDisabled('a password');
    const pw = check(() => validNewPassword(body.password, { username, email }));
    password = await hashAccountPassword(pw, ctx.env);
  } else {
    await requirePasskeys(ctx);
    const pk = body.passkey;
    if (pk === null || typeof pk !== 'object' || Array.isArray(pk)) throw invalid('passkey', 'Passkey is malformed.');
    const c = await consumeChallenge(ctx.db, pk.challengeId, 'signup', {}, ctx.now);
    if (!c || c.data?.usernameKey !== usernameKey(username)) throw invalid('passkey', 'The passkey request expired. Try again.');
    registration = await verifyPasskeyRegistration(ctx, c.challenge, pk.credential);
    userHandle = c.data.userHandle;
  }

  const status = initialStatus({ emailVerified: false, eff });
  const { id, statement } = insertUser(ctx.db, { username, displayName, email, status, password, userHandle }, ctx.now);
  const statements = [statement];
  if (registration) statements.push(insertPasskey(ctx.db, id, 'Passkey', registration, ctx.now));
  try {
    await ctx.db.batch(statements);
  } catch (err) {
    const which = uniqueViolation(err);
    if (which === 'username') throw new HttpError(409, 'conflict', 'This username is taken.', {}, { field: 'username' });
    if (which === 'email') throw new HttpError(409, 'conflict', 'This email address is already used by another account.', {}, { field: 'email' });
    if (duplicatePasskey(err)) throw passkeyConflict();
    throw err;
  }
  if (email && eff.login.email) await sendVerification(ctx, id, username, email, 'verify');
  return signIn(ctx, id, 201);
}

/** Create and mail a verification (or change) link. Returns whether it was sent. */
export async function sendVerification(ctx, userId, username, email, purpose) {
  const { token } = await createEmailToken(ctx.db, userId, purpose, email, TOKEN_TTL_MS[purpose], ctx.now);
  return sendEmail(ctx.env, email, verifyMessage(username, accountLink(ctx.origin, 'verify', token), purpose === 'change'));
}

async function login(ctx) {
  const body = await ctx.body(['login', 'password']);
  await ctx.assertIpAllowed();
  if (!(await ctx.eff()).login.password) throw methodDisabled('a password');
  if (typeof body.login !== 'string' || body.login.trim() === '' || body.login.length > 300) throw invalid('login', 'Enter your username or email.');
  const password = check(() => loginPassword(body.password));
  await ctx.limit('login-ip', ctx.ip, ...LIMITS.loginIp, 'Too many sign-in attempts from your network. Try again later.');
  const key = loginKey(body.login);
  await ctx.assertNotLocked('login-fail', key, ...LIMITS.loginFail);
  await ctx.assertNotLocked('login-fail-day', key, ...LIMITS.loginFailDay);
  const name = body.login.trim();
  let row = null;
  try {
    row = name.includes('@') ? await userByEmail(ctx.db, validEmail(name), ctx.now) : await userByUsername(ctx.db, name.normalize('NFC').replace(/\s+/g, ' '), ctx.now);
  } catch {
    row = null; // malformed names match nobody
  }
  const ok = row && row.status !== 'deleted' ? await verifyAccountPassword(password, row, ctx.env) : await dummyVerify(password, ctx.env);
  if (!ok) {
    await ctx.countFailure('login-fail', key, LIMITS.loginFail[1]);
    await ctx.countFailure('login-fail-day', key, LIMITS.loginFailDay[1]);
    throw badCredentials('Wrong username, email or password.');
  }
  const ban = banOf(row);
  if (ban) throw bannedError(ban);
  await clearQuota(ctx.db, 'login-fail', key);
  if (needsRehash(row, ctx.env)) {
    const h = await hashAccountPassword(password, ctx.env);
    await ctx.db
      .prepare('UPDATE users SET password_hash = ?2, password_salt = ?3, password_iterations = ?4, password_peppered = ?5 WHERE id = ?1')
      .bind(row.id, h.hash, h.salt, h.iterations, h.peppered)
      .run();
  }
  return signIn(ctx, row.id);
}

async function logout(ctx) {
  const token = sessionToken(ctx.request);
  if (token) await ctx.db.prepare('DELETE FROM auth_sessions WHERE id_hash = ?1').bind(await sha256Hex(token)).run();
  ctx.cookies.push(clearSessionCookie(ctx.request));
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

async function requireEmailLinks(ctx) {
  const eff = await ctx.eff();
  if (!eff.services.email) throw new HttpError(503, 'unavailable', 'Email is not available on this server.');
  if (!eff.login.email) throw methodDisabled('email links');
}

async function forgot(ctx) {
  const body = await ctx.body(['email']);
  await ctx.assertIpAllowed();
  await requireEmailLinks(ctx);
  const email = check(() => validEmail(body.email));
  await ctx.limit('forgot-ip', ctx.ip, ...LIMITS.forgotIp);
  await ctx.limit('forgot-email', emailKey(email), ...LIMITS.forgotEmail);
  const row = await userByEmail(ctx.db, email, ctx.now);
  if (row && row.status !== 'deleted') {
    const { token } = await createEmailToken(ctx.db, row.id, 'reset', row.email, TOKEN_TTL_MS.reset, ctx.now);
    await sendEmail(ctx.env, row.email, resetMessage(row.username, accountLink(ctx.origin, 'reset', token), 1));
  }
  return json({}, 202);
}

async function reset(ctx) {
  const body = await ctx.body(['token', 'password']);
  await ctx.assertIpAllowed();
  await ctx.limit('token-ip', ctx.ip, ...LIMITS.tokenIp);
  if (typeof body.password !== 'string') throw invalid('password', 'Choose a new password.');
  const t = await consumeEmailToken(ctx.db, body.token, ['reset'], ctx.now);
  const row = t ? await userById(ctx.db, t.user_id, ctx.now) : null;
  if (!row || row.status === 'deleted' || (t.email !== null && t.email !== row.email)) throw badCredentials('This link is invalid or has expired.');
  const pw = check(() => validNewPassword(body.password, { username: row.username, email: row.email }));
  const h = await hashAccountPassword(pw, ctx.env);
  const eff = await ctx.eff();
  const verified = t.email !== null && row.email !== null;
  const status = verified ? statusAfterVerification(row, eff) : row.status;
  await ctx.db.batch([
    ctx.db
      .prepare(
        `UPDATE users SET password_hash = ?2, password_salt = ?3, password_iterations = ?4, password_peppered = ?5, password_changed_at = ?6,
           email_verified = CASE WHEN ?7 = 1 THEN 1 ELSE email_verified END, status = ?8 WHERE id = ?1`,
      )
      .bind(row.id, h.hash, h.salt, h.iterations, h.peppered, ctx.now, verified ? 1 : 0, status),
    ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(row.id),
    ctx.db.prepare("DELETE FROM email_tokens WHERE user_id = ?1 AND purpose = 'reset'").bind(row.id),
  ]);
  const ban = banOf(row);
  if (ban) throw bannedError(ban);
  return signIn(ctx, row.id);
}

async function verifyEmail(ctx) {
  const body = await ctx.body(['token']);
  await ctx.assertIpAllowed();
  await ctx.limit('token-ip', ctx.ip, ...LIMITS.tokenIp);
  const t = await consumeEmailToken(ctx.db, body.token, ['verify', 'change'], ctx.now);
  const row = t ? await userById(ctx.db, t.user_id, ctx.now) : null;
  if (!row || row.status === 'deleted' || !t.email) throw badCredentials('This link is invalid or has expired.');
  const eff = await ctx.eff();
  const status = statusAfterVerification(row, eff);
  if (t.purpose === 'verify') {
    if (t.email !== row.email) throw badCredentials('This link is invalid or has expired.');
    await ctx.db.prepare('UPDATE users SET email_verified = 1, status = ?2 WHERE id = ?1').bind(row.id, status).run();
  } else {
    try {
      await ctx.db
        .prepare('UPDATE users SET email = ?2, email_key = ?3, email_verified = 1, status = ?4 WHERE id = ?1')
        .bind(row.id, t.email, emailKey(t.email), status)
        .run();
    } catch (err) {
      if (uniqueViolation(err) === 'email') throw new HttpError(409, 'conflict', 'This email address is already used by another account.', {}, { field: 'email' });
      throw err;
    }
  }
  const { user } = await ctx.auth();
  return json({ user: user && user.id === row.id ? await selfView(ctx, row.id) : null });
}

async function passkeyOptions(ctx) {
  const body = await ctx.body(['purpose']);
  await ctx.assertIpAllowed();
  const rpId = await requirePasskeys(ctx);
  const purpose = body.purpose ?? 'login';
  if (purpose !== 'login' && purpose !== 'reauth') throw invalid('purpose', 'Purpose must be login or reauth.');
  await ctx.limit('passkey-ip', ctx.ip, ...LIMITS.passkeyIp);
  if (purpose === 'login') {
    const c = await createChallenge(ctx.db, 'login', {}, ctx.now);
    return json({ challengeId: c.id, publicKey: requestOptions({ rpId, challenge: c.challenge }) });
  }
  const user = await ctx.requireUser();
  const allow = await listPasskeys(ctx.db, user.id);
  if (allow.length === 0) throw new HttpError(409, 'conflict', 'This account has no passkeys.');
  const c = await createChallenge(ctx.db, 'reauth', { userId: user.id }, ctx.now);
  return json({ challengeId: c.id, publicKey: requestOptions({ rpId, challenge: c.challenge, allow }) });
}

async function passkeyLogin(ctx) {
  const body = await ctx.body(['challengeId', 'credential']);
  await ctx.assertIpAllowed();
  await requirePasskeys(ctx);
  await ctx.limit('passkey-ip', ctx.ip, ...LIMITS.passkeyIp);
  const c = await consumeChallenge(ctx.db, body.challengeId, 'login', {}, ctx.now);
  if (!c) throw badCredentials('The passkey request expired. Try again.');
  const user = await verifyPasskeyAssertion(ctx, c.challenge, body.credential);
  if (user.status === 'deleted') throw badCredentials('The passkey could not be verified.');
  const ban = banOf(user);
  if (ban) throw bannedError(ban);
  return signIn(ctx, user.id);
}

async function passkeySignupOptions(ctx) {
  const body = await ctx.body(['username', 'displayName']);
  await ctx.assertIpAllowed();
  const eff = await ctx.eff();
  if (!eff.registrationOpen) throw new HttpError(403, 'registration_closed', 'Signup is closed right now.');
  const rpId = await requirePasskeys(ctx);
  await ctx.limit('passkey-ip', ctx.ip, ...LIMITS.passkeyIp);
  const username = check(() => validUsername(body.username));
  const displayName = body.displayName === undefined || body.displayName === null || body.displayName === '' ? username : check(() => validDisplayName(body.displayName));
  if (await userByUsername(ctx.db, username, ctx.now)) throw new HttpError(409, 'conflict', 'This username is taken.', {}, { field: 'username' });
  const userHandle = randomToken();
  const c = await createChallenge(ctx.db, 'signup', { data: { usernameKey: usernameKey(username), userHandle } }, ctx.now);
  return json({ challengeId: c.id, publicKey: creationOptions({ rpId, challenge: c.challenge, userHandle, username, displayName }) });
}

async function reauth(ctx) {
  const body = await ctx.body(['password', 'passkey']);
  const user = await ctx.requireUser();
  await ctx.assertNotLocked('reauth-fail', user.id, ...LIMITS.reauthFail);
  let ok = false;
  try {
    if (body.password !== undefined && body.passkey === undefined) {
      ok = await verifyAccountPassword(check(() => loginPassword(body.password)), user, ctx.env);
    } else if (body.passkey !== undefined && body.password === undefined) {
      const pk = body.passkey;
      if (pk === null || typeof pk !== 'object' || Array.isArray(pk)) throw invalid('passkey', 'Passkey is malformed.');
      const c = await consumeChallenge(ctx.db, pk.challengeId, 'reauth', { userId: user.id }, ctx.now);
      if (c) ok = (await verifyPasskeyAssertion(ctx, c.challenge, pk.credential, { userId: user.id })).id === user.id;
    } else {
      throw invalid('password', 'Send a password or a passkey.');
    }
  } catch (err) {
    if (!(err instanceof HttpError) || err.code !== 'bad_credentials') throw err;
    ok = false;
  }
  if (!ok) {
    await ctx.countFailure('reauth-fail', user.id, LIMITS.reauthFail[1]);
    throw badCredentials('That did not match. Try again.');
  }
  await rotate(ctx, { reauth: true });
  return json({ reauthUntil: reauthUntil((await ctx.auth()).session) });
}

export function registerAuthRoutes(router) {
  router
    .add('GET', '/api/site', getSite)
    .add('GET', '/api/auth/me', getMe)
    .add('POST', '/api/auth/signup', signup)
    .add('POST', '/api/auth/login', login)
    .add('POST', '/api/auth/logout', logout)
    .add('POST', '/api/auth/password/forgot', forgot)
    .add('POST', '/api/auth/password/reset', reset)
    .add('POST', '/api/auth/email/verify', verifyEmail)
    .add('POST', '/api/auth/passkey/options', passkeyOptions)
    .add('POST', '/api/auth/passkey/login', passkeyLogin)
    .add('POST', '/api/auth/passkey/signup-options', passkeySignupOptions)
    .add('POST', '/api/auth/reauth', reauth);
}

