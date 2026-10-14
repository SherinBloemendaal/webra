// HTTP helpers: JSON responses, uniform errors, same-origin checks, capped bodies.

import { truncate } from '@webra/protocol';

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...headers } });
}

/** Raw JSON text body (already serialized, e.g. a stored map). */
export function jsonText(textValue, status = 200, headers = {}) {
  return new Response(textValue, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string>} [headers]
   * @param {object} [extra] more members of the error object (field, status, ban, current, retryAfter)
   */
  constructor(status, code, message, headers = {}, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.extra = extra;
  }
}

export function errorResponse(status, code, message, headers = {}, extra = {}) {
  return json({ error: { code, message: truncate(message, 200), ...extra } }, status, headers);
}

/** 429 with Retry-After (seconds) in the header and the body. */
export function rateLimited(retryAfter, message = 'Too many requests. Try again later.', code = 'rate_limited') {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  return new HttpError(429, code, message, { 'retry-after': String(seconds) }, { retryAfter: seconds });
}

/** Header that every state-changing request (and account and admin reads) must carry. */
export const CSRF_HEADER = 'X-WebRA-CSRF';

/**
 * CSRF rules for state-changing requests (docs/accounts-api.md, section 1.1):
 * Origin equal to ours, Sec-Fetch-Site same-origin or absent, and the custom
 * header. `requireOrigin` is false for reads that only need the header.
 */
export function checkCsrf(request, { requireOrigin = true } = {}) {
  const origin = request.headers.get('Origin');
  const self = new URL(request.url).origin;
  if (origin !== null && origin !== self) throw new HttpError(403, 'csrf', 'Cross-origin requests are not allowed.');
  if (requireOrigin && origin === null) throw new HttpError(403, 'csrf', 'Missing Origin header.');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site !== null && site !== 'same-origin') throw new HttpError(403, 'csrf', 'Cross-site requests are not allowed.');
  if (request.headers.get(CSRF_HEADER) !== '1') throw new HttpError(403, 'csrf', `Missing ${CSRF_HEADER} header.`);
}

// ---- Cookies ------------------------------------------------------------------------

/** Cookies of a request as a Map (first value wins, malformed pairs skipped). */
export function parseCookies(request) {
  const out = new Map();
  const header = request.headers.get('Cookie');
  if (!header || header.length > 8192) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether cookies get `Secure` and the `__Host-` prefix: always, except for
 * plain HTTP to a local development host. A plain-HTTP request to any other
 * host (a misconfigured zone) still gets Secure cookies, which browsers
 * refuse to store over HTTP: sign-in fails closed instead of leaking a
 * session cookie.
 */
export function isSecure(request) {
  const url = new URL(request.url);
  return url.protocol === 'https:' || !LOCAL_HOSTS.has(url.hostname);
}

/** Cookie name with the `__Host-` prefix on HTTPS. */
export function cookieName(request, base) {
  return isSecure(request) ? `__Host-${base}` : base;
}

/** Set-Cookie value: HttpOnly, SameSite=Lax, Path=/, Secure on HTTPS; maxAge 0 deletes. */
export function cookieHeader(request, base, value, maxAgeSeconds) {
  const parts = [`${cookieName(request, base)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`];
  if (isSecure(request)) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Browsers send Origin on POST and WebSocket requests. Cross-site requests are
 * refused; state-changing requests must carry a matching Origin.
 */
export function checkOrigin(request, { required }) {
  const origin = request.headers.get('Origin');
  const self = new URL(request.url).origin;
  if (origin !== null && origin !== self) throw new HttpError(403, 'forbidden', 'Cross-origin requests are not allowed.');
  if (required && origin === null) throw new HttpError(403, 'forbidden', 'Missing Origin header.');
  const site = request.headers.get('Sec-Fetch-Site');
  if (site === 'cross-site') throw new HttpError(403, 'forbidden', 'Cross-site requests are not allowed.');
}

/** Read a request body as text, refusing more than `maxBytes` without buffering it all. */
export async function readText(request, maxBytes) {
  return (await readBody(request, maxBytes)).text;
}

/**
 * Read a request body (at most `maxBytes`, as readText): `{ text, bytes }`,
 * the UTF-8 text and the bytes it was decoded from (their length is the
 * body's size; hash or compress them without encoding the text again).
 */
export async function readBody(request, maxBytes) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > maxBytes)) {
    throw new HttpError(413, 'too_large', 'Request body is too large.');
  }
  if (!request.body) return { text: '', bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'too_large', 'Request body is too large.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(all), bytes: all };
  } catch {
    throw new HttpError(400, 'bad_message', 'Request body is not valid UTF-8.');
  }
}

/** Parse a JSON request body with a size cap; requires a JSON content type. */
export async function readJson(request, maxBytes) {
  const type = request.headers.get('Content-Type') || '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(415, 'bad_message', 'Content-Type must be application/json.');
  }
  const body = await readText(request, maxBytes);
  try {
    return { text: body, value: JSON.parse(body) };
  } catch {
    throw new HttpError(400, 'bad_message', 'Request body is not valid JSON.');
  }
}

/**
 * A path on this site to send a browser back to after sign-in: one leading
 * slash (never `//`, so never another host), URL characters only, at most
 * 200 characters, no backslash.
 */
export const RETURN_PATH_RE = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]{0,199}$/;

export function isReturnPath(value) {
  return typeof value === 'string' && RETURN_PATH_RE.test(value) && !value.includes('\\');
}

/** Client IP as Cloudflare reports it (never logged, only hashed for rate limits). */
export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/** Append Set-Cookie headers to a response (its headers must be mutable). */
export function withCookies(response, cookies) {
  for (const c of cookies) response.headers.append('Set-Cookie', c);
  return response;
}
