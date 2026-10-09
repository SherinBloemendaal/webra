// Per-request context for the account routes: the site settings, the IP ban
// and the session of the request (each loaded once), guards for roles,
// re-authentication and account states, body parsing and rate limits.

import { FieldError, ProtocolError } from '@webra/protocol';
import { clientIp, HttpError, rateLimited, readJson, withCookies } from '../http.js';
import { peekQuota, takeQuota, windowRemaining } from '../quota.js';
import { findIpBan } from './bans.js';
import { effective, loadSite } from './site.js';
import { clearSessionCookie, hasRecentReauth, loadSession } from './sessions.js';
import { banOf, effectiveStatus } from './users.js';

/** A JSON object (not an array or null). */
export function isPlainObjectValue(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export const ROLE_RANK = { user: 0, moderator: 1, admin: 2 };
const DEFAULT_BODY_MAX = 8 * 1024;

export function invalid(field, message) {
  return new HttpError(400, 'invalid', message, {}, field ? { field } : {});
}

/** Run validators and turn their errors into `400 invalid` with the field. */
export function check(fn, fallbackField = null) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FieldError) throw invalid(err.field, err.message);
    if (err instanceof ProtocolError) throw invalid(fallbackField, err.message);
    throw err;
  }
}

export function bannedError(ban) {
  const until = ban.expiresAt ? ` until ${new Date(ban.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  return new HttpError(403, 'banned', `This account is banned${until}. Reason: ${ban.reason}`, {}, { ban: { reason: ban.reason, expiresAt: ban.expiresAt } });
}

export function inactiveError(status) {
  const message = {
    pending_email: 'Confirm your email address first.',
    pending_approval: 'Your account is waiting for approval.',
    deleted: 'This account was deleted.',
  }[status] ?? 'This account is not active.';
  return new HttpError(403, 'account_inactive', message, {}, { status });
}

export const ipBannedError = () => new HttpError(403, 'ip_banned', 'Your network address is banned from WebRA.');

export class RequestContext {
  constructor(request, env, exec, now = Date.now()) {
    this.request = request;
    this.env = env;
    this.exec = exec;
    this.now = now;
    this.url = new URL(request.url);
    this.origin = this.url.origin;
    this.ip = clientIp(request);
    /** Set-Cookie values added to the response (also to error responses). */
    this.cookies = [];
    this._site = null;
    this._ipBan = undefined;
    this._auth = null;
  }

  get db() {
    return this.env.DB;
  }

  async site() {
    this._site ??= await loadSite(this.db);
    return this._site;
  }

  async eff() {
    return effective((await this.site()).settings, this.env);
  }

  async ipBan() {
    if (this._ipBan === undefined) this._ipBan = await findIpBan(this.db, this.ip, this.now);
    return this._ipBan;
  }

  async assertIpAllowed() {
    if (await this.ipBan()) throw ipBannedError();
  }

  /** { session, user } of the request (both null when signed out). */
  async auth() {
    if (!this._auth) {
      const r = await loadSession(this.env, this.request, this.ip, this.now);
      if (r.clear) this.cookies.push(clearSessionCookie(this.request));
      this._auth = { session: r.session, user: r.user };
    }
    return this._auth;
  }

  /** Forget the loaded session (after sign-in, sign-out or rotation). */
  setAuth(session, user) {
    this._auth = { session, user };
  }

  /**
   * The signed-in account (IP not banned). `active`: the account must be
   * active (not pending).
   */
  async requireUser({ active = false } = {}) {
    await this.assertIpAllowed();
    const { user } = await this.auth();
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    const ban = banOf(user);
    if (ban) throw bannedError(ban);
    const status = effectiveStatus(user);
    if (status === 'deleted' || (active && status !== 'active')) throw inactiveError(status);
    return user;
  }

  async requireRole(role) {
    const user = await this.requireUser();
    if (ROLE_RANK[user.role] < ROLE_RANK[role]) throw new HttpError(403, 'forbidden', 'You do not have permission for this.');
    return user;
  }

  async requireReauth() {
    const { session } = await this.auth();
    if (!hasRecentReauth(session, this.now)) {
      throw new HttpError(403, 'reauth_required', 'Confirm it is you: sign in again (password, passkey or Discord) and retry.');
    }
  }

  /** The JSON body as a plain object with only `allowed` keys. */
  async body(allowed, maxBytes = DEFAULT_BODY_MAX) {
    const { value } = await readJson(this.request, maxBytes);
    if (!isPlainObjectValue(value)) throw invalid(null, 'Body must be a JSON object.');
    for (const k of Object.keys(value)) if (!allowed.includes(k)) throw invalid(k, `Unknown field ${k.slice(0, 32)}.`);
    return value;
  }

  /** Count one request against a limit; 429 when over it. */
  async limit(purpose, subject, limit, windowMs, message = 'Too many requests. Try again later.') {
    if (!(await takeQuota(this.db, purpose, subject, limit, windowMs, this.now))) {
      throw rateLimited(windowRemaining(windowMs, this.now), message);
    }
  }

  /** Count one request against a limit; false when over it (no error). */
  async limitSoft(purpose, subject, limit, windowMs) {
    return takeQuota(this.db, purpose, subject, limit, windowMs, this.now);
  }

  /** 429 `locked` when `purpose` already has `limit` failures for `subject`. */
  async assertNotLocked(purpose, subject, limit, windowMs) {
    if ((await peekQuota(this.db, purpose, subject, windowMs, this.now)) >= limit) {
      throw rateLimited(windowRemaining(windowMs, this.now), 'Too many failed attempts. Try again later.', 'locked');
    }
  }

  async countFailure(purpose, subject, windowMs) {
    await takeQuota(this.db, purpose, subject, Number.MAX_SAFE_INTEGER, windowMs, this.now);
  }

  respond(response) {
    return withCookies(response, this.cookies);
  }
}
