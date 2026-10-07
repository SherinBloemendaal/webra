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
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function errorResponse(status, code, message, headers = {}) {
  return json({ error: { code, message: truncate(message, 200) } }, status, headers);
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
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > maxBytes)) {
    throw new HttpError(413, 'too_large', 'Request body is too large.');
  }
  if (!request.body) return '';
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
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
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

/** Client IP as Cloudflare reports it (never logged, only hashed for rate limits). */
export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}
