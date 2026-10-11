// Client of the accounts and admin API (docs/accounts-api.md), used by the
// game (/play), the account page (/account/) and the admin page (/admin.html).
// Every method returns the parsed answer or throws an AccountError with the
// server's code, message and extra members (field, status, ban, retryAfter,
// current). Messages are plain text: show them with textContent.
//
//   const api = new AccountApi();
//   const { user } = await api.me();
//   await api.login({ login: 'Tanya', password: '...' });

import { noteUserText } from '../telemetry/index.js';

/** Header every write (and every account and admin read) carries (1.1). */
export const CSRF_HEADER = 'X-WebRA-CSRF';

export class AccountError extends Error {
  /**
   * @param {number} status HTTP status (0: the server could not be reached)
   * @param {string} code machine readable code (docs/accounts-api.md 1.2)
   * @param {string} message human readable, plain text
   * @param {object} [detail] the error object: field, status, ban, retryAfter, current
   */
  constructor(status, code, message, detail = {}) {
    super(message);
    this.name = 'AccountError';
    this.status = status;
    this.code = code;
    this.field = detail.field ?? null;
    this.detail = detail;
  }
}

/** Messages for codes when the server sent none we can use (offline, a static file server). */
const FALLBACK = {
  offline: 'The WebRA server cannot be reached. Check your connection and try again.',
  unavailable: 'This is not available right now.',
};

/** Whether a GET to `path` needs the CSRF header (account and admin reads). */
export const needsCsrf = (method, path) => method !== 'GET' && method !== 'HEAD' ? true : /^\/api\/(account|admin)(\/|$|\?)/.test(path);

const enc = encodeURIComponent;

/** `?a=1&b=x` from the defined, non-empty members of `params`. */
export function queryString(params = {}) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** `"v3"` <-> 3 (settings documents and site settings are versioned with ETags). */
export const etagOf = (version) => `"v${version}"`;
export function versionOfEtag(etag) {
  const m = /^(?:W\/)?"v(\d+)"$/.exec(etag ?? '');
  return m ? Number(m[1]) : null;
}

export class AccountApi {
  /**
   * @param {{ fetchImpl?: typeof fetch, base?: string }} [o] base: the site origin ('' for this page's)
   */
  constructor({ fetchImpl, base = '' } = {}) {
    this.fetchImpl = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.base = base;
  }

  /**
   * One request. `body` is sent as JSON; `ifMatch` a version number; `raw`
   * returns the Response (downloads). Returns `{ body, etag, status }`.
   */
  async send(method, path, { body, ifMatch, raw = false } = {}) {
    // Names, emails and other players' text are cut out of error reports (js/telemetry).
    if (body !== undefined) noteUserText(body);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (needsCsrf(method, path)) headers[CSRF_HEADER] = '1';
    if (ifMatch !== undefined && ifMatch !== null) headers['If-Match'] = etagOf(ifMatch);
    let res;
    try {
      res = await this.fetchImpl(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new AccountError(0, 'offline', FALLBACK.offline);
    }
    if (raw && res.ok) return { body: null, res, etag: res.headers.get('ETag'), status: res.status };
    const text = res.status === 204 ? '' : await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
      noteUserText(data);
    } catch {
      data = undefined; // not JSON: a static server without the API, or a proxy error page
    }
    if (!res.ok || data === undefined) {
      const e = data?.error && typeof data.error === 'object' ? data.error : null;
      const code = typeof e?.code === 'string' ? e.code : res.ok ? 'unavailable' : res.status === 404 ? 'not_found' : 'unavailable';
      const message = typeof e?.message === 'string' && e.message ? e.message.slice(0, 300) : FALLBACK.unavailable;
      const detail = e ? { ...e } : {};
      if (detail.retryAfter === undefined && res.headers.get('Retry-After')) detail.retryAfter = Number(res.headers.get('Retry-After'));
      throw new AccountError(res.status, code, message, detail);
    }
    return { body: data ?? {}, etag: res.headers.get('ETag'), status: res.status };
  }

  get = async (path) => (await this.send('GET', path)).body;
  post = async (path, body = {}) => (await this.send('POST', path, { body })).body;
  patch = async (path, body) => (await this.send('PATCH', path, { body })).body;
  del = async (path, body) => (await this.send('DELETE', path, { body })).body;

  // ---- Public (3) and authentication (4) ------------------------------------------------
  site = () => this.get('/api/site');
  me = () => this.get('/api/auth/me');
  signup = (input) => this.post('/api/auth/signup', input);
  login = (input) => this.post('/api/auth/login', input);
  logout = () => this.post('/api/auth/logout');
  forgotPassword = (email) => this.post('/api/auth/password/forgot', { email });
  resetPassword = (token, password) => this.post('/api/auth/password/reset', { token, password });
  verifyEmail = (token) => this.post('/api/auth/email/verify', { token });
  passkeySignupOptions = (input) => this.post('/api/auth/passkey/signup-options', input);
  /** `purpose: 'reauth'` for a re-authentication challenge (signed in). */
  passkeyOptions = (purpose) => this.post('/api/auth/passkey/options', purpose ? { purpose } : {});
  passkeyLogin = (challengeId, credential) => this.post('/api/auth/passkey/login', { challengeId, credential });
  reauth = (proof) => this.post('/api/auth/reauth', proof);
  /**
   * `email` (signup only): the address to use when Discord reports no verified one.
   * @param {{ mode: 'login' | 'signup' | 'link' | 'reauth', returnTo?: string, acceptPrivacy?: boolean, email?: string }} input
   */
  discordStart = (input) => this.post('/api/auth/discord/start', input);

  // ---- Self service (5) -------------------------------------------------------------------
  account = () => this.get('/api/account');
  updateProfile = (input) => this.patch('/api/account', input);
  changePassword = (input) => this.post('/api/account/password', input);
  removePassword = () => this.del('/api/account/password');
  changeEmail = (email) => this.post('/api/account/email', { email });
  resendVerification = () => this.post('/api/account/email/resend');
  passkeys = () => this.get('/api/account/passkeys');
  newPasskeyOptions = () => this.post('/api/account/passkeys/options');
  addPasskey = (challengeId, name, credential) => this.post('/api/account/passkeys', { challengeId, name, credential });
  renamePasskey = (id, name) => this.patch(`/api/account/passkeys/${enc(id)}`, { name });
  deletePasskey = (id) => this.del(`/api/account/passkeys/${enc(id)}`);
  unlinkDiscord = () => this.del('/api/account/discord');
  sessions = () => this.get('/api/account/sessions');
  renameSession = (id, deviceLabel) => this.patch(`/api/account/sessions/${enc(id)}`, { deviceLabel });
  revokeSession = (id) => this.del(`/api/account/sessions/${enc(id)}`);
  revokeOtherSessions = () => this.del('/api/account/sessions');
  /** `{ version, updatedAt, settings }` (version 0: nothing stored yet). */
  async settings() {
    const { body, etag } = await this.send('GET', '/api/account/settings');
    return { ...body, version: body.version ?? versionOfEtag(etag) ?? 0 };
  }
  /** Replace the settings document; throws `version_conflict` (with `detail.current`) on a stale version. */
  putSettings = async (version, settings) => (await this.send('PUT', '/api/account/settings', { body: { settings }, ifMatch: version })).body;
  /** The data export as a Blob and its file name. */
  async exportData() {
    const { res } = await this.send('GET', '/api/account/export', { raw: true });
    const disposition = res.headers.get('Content-Disposition') ?? '';
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'webra-account.json';
    return { blob: await res.blob(), name };
  }
  deleteAccount = (confirm) => this.del('/api/account', { confirm });

  // ---- Admin (8) ----------------------------------------------------------------------------
  stats = () => this.get('/api/admin/stats');
  /** @param {{ q?, status?, role?, flag?, sort?, order?, page?, limit? }} query */
  users = (query = {}) => this.get(`/api/admin/users${queryString(query)}`);
  user = (id) => this.get(`/api/admin/users/${enc(id)}`);
  updateUser = (id, input) => this.patch(`/api/admin/users/${enc(id)}`, input);
  approveUser = (id) => this.post(`/api/admin/users/${enc(id)}/approve`);
  rejectUser = (id, reason) => this.post(`/api/admin/users/${enc(id)}/reject`, reason ? { reason } : {});
  banUser = (id, reason, expiresAt) => this.post(`/api/admin/users/${enc(id)}/ban`, { reason, expiresAt });
  unbanUser = (id) => this.del(`/api/admin/users/${enc(id)}/ban`);
  logoutUser = (id) => this.post(`/api/admin/users/${enc(id)}/logout`);
  revokeUserSession = (id, sessionId) => this.del(`/api/admin/users/${enc(id)}/sessions/${enc(sessionId)}`);
  /** Give the account and its recent networks their one-click relay budgets back: { relay }. */
  resetRelayQuota = (id) => this.del(`/api/admin/users/${enc(id)}/relay-quota`);
  deleteUser = (id) => this.del(`/api/admin/users/${enc(id)}`);
  restoreUser = (id) => this.post(`/api/admin/users/${enc(id)}/restore`);
  purgeUser = (id, confirm) => this.post(`/api/admin/users/${enc(id)}/purge`, { confirm });
  resetLink = (id, send = false) => this.post(`/api/admin/users/${enc(id)}/password-reset`, { send });
  /** Mark the account's unverified address verified: { user }. */
  verifyUserEmail = (id) => this.post(`/api/admin/users/${enc(id)}/email/verify`);
  /** Mail the account's unverified address a new link: { sent, emailLink }. */
  resendUserEmail = (id) => this.post(`/api/admin/users/${enc(id)}/email/resend`);
  async userSettings(id) {
    const { body, etag } = await this.send('GET', `/api/admin/users/${enc(id)}/settings`);
    return { ...body, version: body.version ?? versionOfEtag(etag) ?? 0 };
  }
  putUserSettings = async (id, version, settings) => (await this.send('PUT', `/api/admin/users/${enc(id)}/settings`, { body: { settings }, ifMatch: version })).body;
  ipBans = (query = {}) => this.get(`/api/admin/ip-bans${queryString(query)}`);
  createIpBan = (input) => this.post('/api/admin/ip-bans', input);
  updateIpBan = (id, input) => this.patch(`/api/admin/ip-bans/${enc(id)}`, input);
  deleteIpBan = (id) => this.del(`/api/admin/ip-bans/${enc(id)}`);
  /** `{ settings, services, effective, version }`. */
  async adminSite() {
    const { body, etag } = await this.send('GET', '/api/admin/site');
    return { ...body, version: body.settings?.version ?? versionOfEtag(etag) ?? 0 };
  }
  patchSite = async (version, patch) => (await this.send('PATCH', '/api/admin/site', { body: patch, ifMatch: version })).body;
  audit = (query = {}) => this.get(`/api/admin/audit${queryString(query)}`);
}

/** Text for an error a player sees, with what to do next where it helps. */
export function errorText(err) {
  if (!(err instanceof AccountError)) return err?.message ?? String(err);
  const d = err.detail ?? {};
  switch (err.code) {
    case 'banned': {
      const until = d.ban?.expiresAt ? ` until ${formatDateTime(d.ban.expiresAt)}` : '';
      return `This account is banned${until}.${d.ban?.reason ? ` Reason: ${d.ban.reason}` : ''}`;
    }
    case 'rate_limited':
    case 'locked':
      return d.retryAfter ? `${err.message} Try again in ${formatWait(d.retryAfter)}.` : err.message;
    default:
      return err.message;
  }
}

/** "5 minutes", "1 hour" from seconds. */
export function formatWait(seconds) {
  const s = Math.max(1, Math.round(Number(seconds) || 0));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

const dateTime = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** "9 Oct 2026, 14:05" for Unix milliseconds; "never" for 0 or null. */
export function formatDateTime(ms) {
  return ms ? dateTime.format(new Date(ms)) : 'never';
}
