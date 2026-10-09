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
import { dummyVerify, hashAccountPassword, verifyAccountPassword } from './password.js';
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
import { reauthUntil, sessionToken, signOutCookies } from './sessions.js';
import { banOf, initialStatus, insertUser, uniqueViolation, userByEmail, userById, userByUsername } from './users.js';
import { assertionIds, rpIdFor, verifyAuthentication, verifyRegistration, WebAuthnError } from './webauthn.js';
import { ipRecord } from './ip.js';
import { rateLimited } from '../http.js';

export const MIN15 = 15 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/**
 * Rate limits (docs/accounts-api.md section 9). `*Burst` limits are per IP
 * and go through the AUTH_LIMITER binding when it exists (no D1 access);
 * the values here are the D1 fallback.
 */
export const LIMITS = {
  signup: [10, HOUR],
  loginBurst: [30, MIN15],
  /** Failures per account (or unknown name) from one address: a short lock for that address only. */
  loginFail: [10, MIN15],
  /** Failures per address across all accounts, per day. */
  loginFailIp: [100, DAY],
  passkeyBurst: [30, MIN15],
  reauthFail: [10, MIN15],
  forgotIp: [5, HOUR],
  forgotEmail: [3, HOUR],
  tokenBurst: [20, MIN15],
  discordBurst: [20, MIN15],
};

/**
 * Account-wide escalating delay (all addresses together): after this many
 * failures within a day, each further failure doubles a wait, up to the
 * maximum. Addresses the account signed in from before are exempt, so a
 * third party cannot keep the owner out; there is no hard lock.
 */
export const ACCOUNT_DELAY = { after: 10, maxMs: 15 * 60 * 1000, resetMs: DAY };

export function accountDelayMs(failures) {
  if (failures < ACCOUNT_DELAY.after) return 0;
  return Math.min(ACCOUNT_DELAY.maxMs, 1000 * 2 ** Math.min(20, failures - ACCOUNT_DELAY.after + 1));
}

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

/** Key for an unknown login name (so unknown and existing names cost the same). */
function loginKey(login) {
  const s = login.trim();
  if (s.includes('@')) return `e:${emailKey(s)}`;
  return `u:${usernameKey(s.normalize('NFC').replace(/\s+/g, ' '))}`;
}

/** Whether the account signed in from this address before (its IP history). */
async function knownAddress(db, userId, ip) {
  const rec = ipRecord(ip);
  if (!rec) return false;
  return (await db.prepare('SELECT 1 AS ok FROM user_ips WHERE user_id = ?1 AND ip = ?2').bind(userId, rec.ip).first()) !== null;
}

/**
 * Verify an assertion against the stored passkey; returns { user, uv }.
 * Generic 401 on failure.
 */
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
    return { user, uv: r.uv };
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
  // Addresses are only taken when they can be confirmed (no unverified claims while email is off).
  if (email && !eff.login.email) throw invalid('email', 'Email addresses can be added once this server can confirm them. Leave it empty for now.');
  const hasPassword = body.password !== undefined && body.password !== null;
  const hasPasskey = body.passkey !== undefined && body.passkey !== null;
  if (hasPassword === hasPasskey) throw invalid('password', 'Choose a password or a passkey.');

  // Counted once the request is well formed, before any expensive work or lookups.
  await ctx.limit('signup', ctx.ip, ...LIMITS.signup, 'Too many signups from your network. Try again later.');
  if (email && (await emailTaken(ctx.db, email))) throw new HttpError(409, 'conflict', 'This email address is already used by another account.', {}, { field: 'email' });
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

/** Whether a verified address belongs to an account (unverified ones claim nothing). */
export async function emailTaken(db, email, exceptUserId = null) {
  const row = await db.prepare('SELECT id FROM users WHERE email_key = ?1').bind(emailKey(email)).first();
  return row !== null && row.id !== exceptUserId;
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
  await ctx.burst('login', LIMITS.loginBurst);
  await ctx.assertNotLocked('login-fail-ip', ctx.ip, ...LIMITS.loginFailIp);
  // Resolve the account first: username and email share one failure budget.
  const name = body.login.trim();
  let row = null;
  try {
    row = name.includes('@') ? await userByEmail(ctx.db, validEmail(name), ctx.now) : await userByUsername(ctx.db, name.normalize('NFC').replace(/\s+/g, ' '), ctx.now);
  } catch {
    row = null; // malformed names match nobody
  }
  if (row && row.status === 'deleted') row = null;
  const subject = `${row ? `a:${row.id}` : `n:${loginKey(name)}`}|${ctx.ip}`;
  await ctx.assertNotLocked('login-fail', subject, ...LIMITS.loginFail);
  if (row && row.login_delay_until !== null && row.login_delay_until > ctx.now && !(await knownAddress(ctx.db, row.id, ctx.ip))) {
    throw rateLimited((row.login_delay_until - ctx.now) / 1000, 'Too many failed sign-ins for this account. Wait a moment, or use a passkey, Discord or a reset link.', 'locked');
  }
  // Exactly one key derivation per request (CPU budget); hashes are upgraded when the password is next set.
  const ok = row ? await verifyAccountPassword(password, row, ctx.env) : await dummyVerify(password, ctx.env);
  if (!ok) {
    await ctx.countFailure('login-fail', subject, LIMITS.loginFail[1]);
    await ctx.countFailure('login-fail-ip', ctx.ip, LIMITS.loginFailIp[1]);
    if (row) {
      const recent = row.login_failed_at !== null && row.login_failed_at > ctx.now - ACCOUNT_DELAY.resetMs;
      const failures = (recent ? row.login_failures : 0) + 1;
      const delay = accountDelayMs(failures);
      await ctx.db
        .prepare('UPDATE users SET login_failures = ?2, login_failed_at = ?3, login_delay_until = ?4 WHERE id = ?1')
        .bind(row.id, failures, ctx.now, delay > 0 ? ctx.now + delay : null)
        .run();
    }
    throw badCredentials('Wrong username, email or password.');
  }
  const ban = banOf(row);
  if (ban) throw bannedError(ban);
  await ctx.clearFailures('login-fail', subject);
  return signIn(ctx, row.id);
}

async function logout(ctx) {
  const token = sessionToken(ctx.request);
  if (token) await ctx.db.prepare('DELETE FROM auth_sessions WHERE id_hash = ?1').bind(await sha256Hex(token)).run();
  ctx.cookies.push(...signOutCookies(ctx.request));
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
  // Only verified addresses get reset links (an address someone merely typed proves nothing).
  if (row && row.status !== 'deleted' && row.email_verified === 1) {
    const { token } = await createEmailToken(ctx.db, row.id, 'reset', row.email, TOKEN_TTL_MS.reset, ctx.now);
    await sendEmail(ctx.env, row.email, resetMessage(row.username, accountLink(ctx.origin, 'reset', token), 1));
  }
  return json({}, 202);
}

async function reset(ctx) {
  const body = await ctx.body(['token', 'password']);
  await ctx.assertIpAllowed();
  await ctx.burst('token', LIMITS.tokenBurst);
  if (typeof body.password !== 'string') throw invalid('password', 'Choose a new password.');
  const t = await consumeEmailToken(ctx.db, body.token, ['reset'], ctx.now);
  const row = t ? await userById(ctx.db, t.user_id, ctx.now) : null;
  if (!row || row.status === 'deleted' || (t.email !== null && t.email !== row.email)) throw badCredentials('This link is invalid or has expired.');
  const pw = check(() => validNewPassword(body.password, { username: row.username, email: row.email }));
  const h = await hashAccountPassword(pw, ctx.env);
  const eff = await ctx.eff();
  const verified = t.email !== null && row.email !== null && row.email_verified === 1;
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
  await ctx.burst('token', LIMITS.tokenBurst);
  const t = await consumeEmailToken(ctx.db, body.token, ['verify', 'change'], ctx.now);
  const row = t ? await userById(ctx.db, t.user_id, ctx.now) : null;
  if (!row || row.status === 'deleted' || !t.email) throw badCredentials('This link is invalid or has expired.');
  const eff = await ctx.eff();
  const status = statusAfterVerification(row, eff);
  if (t.purpose === 'verify' && t.email !== row.email) throw badCredentials('This link is invalid or has expired.');
  // Verifying claims the address (email_key); someone who verified it first keeps it.
  try {
    await ctx.db
      .prepare('UPDATE users SET email = ?2, email_key = ?3, email_verified = 1, email_set_at = ?5, status = ?4 WHERE id = ?1')
      .bind(row.id, t.email, emailKey(t.email), status, ctx.now)
      .run();
  } catch (err) {
    if (uniqueViolation(err) === 'email') throw new HttpError(409, 'conflict', 'This email address is already used by another account.', {}, { field: 'email' });
    throw err;
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
  await ctx.burst('passkey', LIMITS.passkeyBurst);
  if (purpose === 'login') {
    const c = await createChallenge(ctx.db, 'login', {}, ctx.now);
    return json({ challengeId: c.id, publicKey: requestOptions({ rpId, challenge: c.challenge }) });
  }
  const user = await ctx.requireUser();
  const allow = await listPasskeys(ctx.db, user.id);
  if (allow.length === 0) throw new HttpError(409, 'conflict', 'This account has no passkeys.');
  const c = await createChallenge(ctx.db, 'reauth', { userId: user.id }, ctx.now);
  // Re-authentication for sensitive changes needs user verification (PIN or biometrics).
  return json({ challengeId: c.id, publicKey: requestOptions({ rpId, challenge: c.challenge, allow, userVerification: 'required' }) });
}

async function passkeyLogin(ctx) {
  const body = await ctx.body(['challengeId', 'credential']);
  await ctx.assertIpAllowed();
  await requirePasskeys(ctx);
  await ctx.burst('passkey', LIMITS.passkeyBurst);
  const c = await consumeChallenge(ctx.db, body.challengeId, 'login', {}, ctx.now);
  if (!c) throw badCredentials('The passkey request expired. Try again.');
  const { user } = await verifyPasskeyAssertion(ctx, c.challenge, body.credential);
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
  await ctx.burst('passkey', LIMITS.passkeyBurst);
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
  let uvMissing = false;
  try {
    if (body.password !== undefined && body.passkey === undefined) {
      ok = await verifyAccountPassword(check(() => loginPassword(body.password)), user, ctx.env);
    } else if (body.passkey !== undefined && body.password === undefined) {
      const pk = body.passkey;
      if (pk === null || typeof pk !== 'object' || Array.isArray(pk)) throw invalid('passkey', 'Passkey is malformed.');
      const c = await consumeChallenge(ctx.db, pk.challengeId, 'reauth', { userId: user.id }, ctx.now);
      if (c) {
        const r = await verifyPasskeyAssertion(ctx, c.challenge, pk.credential, { userId: user.id });
        // A re-authentication must be a real one: the authenticator verified the user (PIN or biometrics).
        uvMissing = !r.uv;
        ok = r.user.id === user.id && r.uv;
      }
    } else {
      throw invalid('password', 'Send a password or a passkey.');
    }
  } catch (err) {
    if (!(err instanceof HttpError) || err.code !== 'bad_credentials') throw err;
    ok = false;
  }
  if (!ok) {
    await ctx.countFailure('reauth-fail', user.id, LIMITS.reauthFail[1]);
    if (uvMissing) throw badCredentials('Confirm with your passkey\'s PIN or biometrics (user verification).');
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

