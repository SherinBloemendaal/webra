// Map sharing API (docs/contracts.md section 4): publish, list and fetch maps.
// Every call throws `ApiError` with a message fit for the UI; `unavailable`
// is set when the service cannot be reached at all (local development).

import { canonicalJson, mapHash, parseMap } from './mapformat.js';
import { CSRF_HEADER } from '../../js/net.js';

export class ApiError extends Error {
  constructor(message, { status = 0, unavailable = false, code = null } = {}) {
    super(message);
    this.status = status;
    this.unavailable = unavailable;
    this.code = code;
  }
}

const API = '/api/maps';

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiError('The map service cannot be reached. Publishing needs the online server (it is not part of a local static server).', { unavailable: true });
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    // A static dev server answers /api with 404 HTML (or the index page).
    throw new ApiError(
      res.ok
        ? 'The map service is not available here (got a non-JSON answer). Use the deployed site to publish.'
        : `The map service is not available here (HTTP ${res.status}).`,
      { status: res.status, unavailable: true },
    );
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`The map service sent invalid JSON (HTTP ${res.status}).`, { status: res.status });
  }
  if (!res.ok) {
    const err = body?.error && typeof body.error === 'object' ? body.error : null;
    const msg = err?.message ?? body?.message ?? (typeof body?.error === 'string' ? body.error : null) ?? (Array.isArray(body?.errors) ? body.errors.join('; ') : null);
    throw new ApiError(accountProblem(err?.code) ?? (res.status === 429 ? 'Too many uploads. Please wait a moment and try again.' : `The map service refused the request (HTTP ${res.status})${msg ? `: ${msg}` : '.'}`), {
      status: res.status,
      code: err?.code ?? null,
    });
  }
  return body;
}

/** Why an account problem stops an upload (docs/accounts-api.md 7), or null. */
export function accountProblem(code) {
  switch (code) {
    case 'unauthenticated':
    case 'account_required':
      return 'Publishing maps needs a WebRA account. Sign in at /account/ and try again.';
    case 'account_inactive':
      return 'Your account is not active yet (email verification or approval). See /account/.';
    case 'banned':
      return 'Your account is banned, so it cannot publish maps.';
    case 'ip_banned':
      return 'Publishing is blocked from your network.';
    default:
      return null;
  }
}

/** Publish a map. Returns `{ id, hash, localHash }`; `hash` is the server's. */
export async function publishMap(map) {
  const body = canonicalJson(map);
  const localHash = await mapHash(map);
  // X-WebRA-CSRF: every API write carries it (docs/accounts-api.md 1.1).
  const out = await request(API, { method: 'POST', headers: { 'Content-Type': 'application/json', ...CSRF_HEADER }, body });
  if (typeof out?.id !== 'string' && typeof out?.id !== 'number') throw new ApiError('The map service did not return a map id.');
  return { id: String(out.id), hash: out.hash ?? null, localHash };
}

/** List published maps. */
export async function listMaps() {
  const out = await request(API, { method: 'GET' });
  if (!Array.isArray(out)) throw new ApiError('The map list has an unexpected format.');
  return out;
}

/**
 * Download a published map and check its hash against `expectedHash` (from the
 * list) when given. Returns `{ map, hash }`.
 */
export async function fetchMap(id, expectedHash = null) {
  const out = await request(`${API}/${encodeURIComponent(id)}`, { method: 'GET' });
  const map = typeof out === 'string' ? parseMap(out) : out;
  const hash = await mapHash(map);
  if (expectedHash && hash !== expectedHash) {
    throw new ApiError(`The downloaded map does not match its published hash (${expectedHash.slice(0, 12)}...).`);
  }
  return { map, hash };
}

/** Link that opens a published map in the game. */
export function shareLink(id, base = document.baseURI) {
  return new URL(`./?map=${encodeURIComponent(id)}`, base).href;
}
