// Sign-in sessions (docs/accounts-api.md, section 2.4): opaque random ids in
// an HttpOnly cookie, stored as SHA-256 in D1 with an absolute and an idle
// expiry, rotated on sign-in, re-authentication and credential changes.

import { cookieHeader, cookieName, parseCookies } from '../http.js';
import { randomHex, randomToken, sha256Hex } from '../crypto.js';
import { ipSalt, keyedHash } from '../ipkey.js';
import { userSelect } from './users.js';
import { summarizeUserAgent } from './useragent.js';
import { ipRecord } from './ip.js';
import { clearPlayPassCookie } from './playpass.js';

export const SESSION_COOKIE = 'webra_session';
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * A session's last_used_at (and address hash) is written at most this often;
 * the account's last_seen_at and the IP history at most hourly, or when the
 * address changed. A typical active session costs one row write per 15
 * minutes.
 */
export const TOUCH_MS = 15 * 60 * 1000;
export const SEEN_MS = 60 * 60 * 1000;
export const REAUTH_MS = 10 * 60 * 1000;
/** IP addresses kept per account, and for how long. */
export const IP_HISTORY_MAX = 20;
export const IP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Keyed hash of the client address stored with a session (HMAC under IP_HASH_SALT). */
export async function ipHash(ip, salt) {
  return keyedHash(salt, 'session-ip', ip);
}

/** The session token from the request's cookie, or null. */
export function sessionToken(request) {
  const value = parseCookies(request).get(cookieName(request, SESSION_COOKIE));
  return value && TOKEN_RE.test(value) ? value : null;
}

export function sessionCookie(request, token) {
  return cookieHeader(request, SESSION_COOKIE, token, SESSION_ABSOLUTE_MS / 1000);
}

export function clearSessionCookie(request) {
  return cookieHeader(request, SESSION_COOKIE, '', 0);
}

/**
 * Set-Cookie values that end this browser's sign-in: the session cookie and
 * the play pass (accounts/playpass.js), so the game stops loading at once.
 */
export function signOutCookies(request) {
  return [clearSessionCookie(request), clearPlayPassCookie(request)];
}

/** Record the client's address in the account's IP history (bounded, admins only). */
export async function recordIp(db, userId, ip, now = Date.now()) {
  const rec = ipRecord(ip);
  if (!rec) return;
  await db.batch([
    db
      .prepare(
        `INSERT INTO user_ips (user_id, ip, ip_v, ip_hex, first_seen, last_seen, count) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1)
         ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = excluded.last_seen, count = user_ips.count + 1`,
      )
      .bind(userId, rec.ip, rec.v, rec.hex, now),
    db
      .prepare(
        `DELETE FROM user_ips WHERE user_id = ?1 AND ip NOT IN (
           SELECT ip FROM user_ips WHERE user_id = ?1 ORDER BY last_seen DESC LIMIT ?2)`,
      )
      .bind(userId, IP_HISTORY_MAX),
  ]);
}

/**
 * Start a session for `userId`. Deletes the request's current session (if
 * any) in the same batch. Returns { token, publicId, cookie }.
 */
export async function createSession(env, request, ip, userId, now = Date.now(), { replace = true } = {}) {
  const token = randomToken();
  const publicId = randomHex(8);
  const summary = summarizeUserAgent(request.headers.get('User-Agent'));
  const statements = [];
  const old = replace ? sessionToken(request) : null;
  if (old) statements.push(env.DB.prepare('DELETE FROM auth_sessions WHERE id_hash = ?1').bind(await sha256Hex(old)));
  // Signing in is not a re-authentication (reauth_at 0): sensitive changes ask for an explicit one.
  statements.push(
    env.DB.prepare(
      `INSERT INTO auth_sessions (id_hash, public_id, user_id, created_at, last_used_at, expires_at, reauth_at, ip_hash, user_agent, device_label)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, 0, ?6, ?7, ?7)`,
    ).bind(await sha256Hex(token), publicId, userId, now, now + SESSION_ABSOLUTE_MS, await ipHash(ip, ipSalt(env, request)), summary),
    // A successful sign-in also clears the account's failure count and delay.
    env.DB.prepare('UPDATE users SET last_seen_at = ?2, login_failures = 0, login_failed_at = NULL, login_delay_until = NULL WHERE id = ?1').bind(userId, now),
  );
  await env.DB.batch(statements);
  await recordIp(env.DB, userId, ip, now);
  return { token, publicId, cookie: sessionCookie(request, token) };
}

/**
 * Give the current session a new id (same row data, fresh reauth time when
 * `reauth`). Returns { token, cookie } or null when there is no session.
 */
export async function rotateSession(env, request, session, now = Date.now(), { reauth = false } = {}) {
  const token = randomToken();
  const r = await env.DB.prepare(
    `UPDATE auth_sessions SET id_hash = ?2, last_used_at = ?3, reauth_at = CASE WHEN ?4 = 1 THEN ?3 ELSE reauth_at END
     WHERE id_hash = ?1`,
  )
    .bind(session.id_hash, await sha256Hex(token), now, reauth ? 1 : 0)
    .run();
  if (r.meta.changes !== 1) return null;
  session.id_hash = await sha256Hex(token);
  if (reauth) session.reauth_at = now;
  return { token, cookie: sessionCookie(request, token) };
}

/**
 * The session and account of a request. Returns { session, user } (user row
 * from userSelect with the ban in effect), or { session: null, user: null,
 * clear } where `clear` says the cookie names a session that is gone.
 */
export async function loadSession(env, request, ip, now = Date.now()) {
  const token = sessionToken(request);
  if (!token) return { session: null, user: null, clear: false };
  const idHash = await sha256Hex(token);
  const session = await env.DB.prepare('SELECT * FROM auth_sessions WHERE id_hash = ?1').bind(idHash).first();
  if (!session) return { session: null, user: null, clear: true };
  if (session.expires_at <= now || session.last_used_at + SESSION_IDLE_MS <= now) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE id_hash = ?1').bind(idHash).run();
    return { session: null, user: null, clear: true };
  }
  const user = await env.DB.prepare(userSelect('u.id = ?2')).bind(now, session.user_id).first();
  if (!user || user.status === 'deleted' || user.b_id !== null) {
    // Bans and deletion end every session; this one may have raced the revocation.
    await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(session.user_id).run();
    return { session: null, user: null, clear: true };
  }
  if (now - session.last_used_at >= TOUCH_MS) {
    const hash = await ipHash(ip, ipSalt(env, request));
    const moved = hash !== session.ip_hash;
    const seenDue = moved || user.last_seen_at === null || now - user.last_seen_at >= SEEN_MS;
    const statements = [env.DB.prepare('UPDATE auth_sessions SET last_used_at = ?2, ip_hash = ?3 WHERE id_hash = ?1').bind(idHash, now, hash)];
    if (seenDue) statements.push(env.DB.prepare('UPDATE users SET last_seen_at = ?2 WHERE id = ?1').bind(user.id, now));
    await env.DB.batch(statements);
    if (seenDue) {
      await recordIp(env.DB, user.id, ip, now);
      user.last_seen_at = now;
    }
    session.last_used_at = now;
    session.ip_hash = hash;
  }
  return { session, user, clear: false };
}

export function reauthUntil(session) {
  return session && session.reauth_at > 0 ? session.reauth_at + REAUTH_MS : 0;
}

export function hasRecentReauth(session, now = Date.now()) {
  return Boolean(session) && session.reauth_at > 0 && session.reauth_at + REAUTH_MS > now;
}

export async function revokeAllSessions(db, userId, { except = null } = {}) {
  if (except) {
    await db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1 AND id_hash != ?2').bind(userId, except).run();
  } else {
    await db.prepare('DELETE FROM auth_sessions WHERE user_id = ?1').bind(userId).run();
  }
}

export function sessionView(row, currentHash = null) {
  return {
    id: row.public_id,
    current: currentHash !== null && row.id_hash === currentHash,
    deviceLabel: row.device_label,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: Math.min(row.expires_at, row.last_used_at + SESSION_IDLE_MS),
  };
}

export async function listSessions(db, userId) {
  const { results } = await db
    .prepare('SELECT * FROM auth_sessions WHERE user_id = ?1 ORDER BY last_used_at DESC LIMIT 100')
    .bind(userId)
    .all();
  return results;
}
