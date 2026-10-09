// The play pass (docs/security.md, "The play gate"): a short-lived signed
// cookie that lets the Worker serve game files without reading D1 for each
// one. It names the account, the first 16 hex digits of the session's id
// hash (so it only works next to the session cookie it was issued with) and
// its expiry, MACed with HMAC-SHA256 under a key derived with HKDF from the
// Worker secret IP_HASH_SALT (its own info label, so the key is not the one
// used for address hashes and no new secret is needed).
//
// Value: `1.<userId:32 hex>.<sid:16 hex>.<exp:unix seconds>.<mac:43 base64url>`.

import { cookieHeader } from '../http.js';
import { fromBase64Url, sha256Hex, timingSafeEqual, toBase64Url } from '../crypto.js';

export const PLAY_COOKIE = 'webra_play';
export const PASS_VERSION = 1;
/** Lifetime of a pass: the bound on how long a revoked session, ban or status change can still load game files. */
export const PASS_TTL_S = 600;
/** Passes that claim to live longer than this (clock skew included) are refused. */
const PASS_MAX_AHEAD_S = PASS_TTL_S + 60;
const PASS_INFO = 'webra play pass v1';
const SID_HEX = 16;

const enc = new TextEncoder();
const PASS_RE = /^([0-9]{1,3})\.([0-9a-f]{32})\.([0-9a-f]{16})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/;

/** Derived keys by secret (one or two per isolate). */
const keys = new Map();

/** The HMAC key for passes, derived from `secret` (HKDF-SHA256, info "webra play pass v1"). */
export function passKey(secret) {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(PASS_INFO) },
        ikm,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      );
    })();
    if (keys.size >= 4) keys.clear();
    keys.set(secret, key);
  }
  return key;
}

/** The session part of a pass: the first 16 hex digits of the session id hash (auth_sessions.id_hash). */
export function sidOfHash(idHash) {
  return idHash.slice(0, SID_HEX);
}

/** The session part of a pass for a session token (the cookie value). */
export async function sidOfToken(token) {
  return sidOfHash(await sha256Hex(token));
}

const payload = (version, userId, sid, exp) => `${version}.${userId}.${sid}.${exp}`;

/** A signed pass value for the account and session, valid until `exp` (unix seconds). */
export async function signPass(key, { userId, sid, exp, version = PASS_VERSION }) {
  const body = payload(version, userId, sid, exp);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${toBase64Url(mac)}`;
}

/**
 * Check a pass value: format, version, expiry (not past, not too far ahead)
 * and the MAC (crypto.subtle.verify compares in constant time). Returns
 * { userId, sid, exp } or null.
 */
export async function verifyPass(key, value, nowMs = Date.now()) {
  if (typeof value !== 'string') return null;
  const m = PASS_RE.exec(value);
  if (!m) return null;
  const [, version, userId, sid, expText, macText] = m;
  if (Number(version) !== PASS_VERSION) return null;
  const exp = Number(expText);
  const now = Math.floor(nowMs / 1000);
  if (exp <= now || exp > now + PASS_MAX_AHEAD_S) return null;
  const mac = fromBase64Url(macText);
  if (!mac || mac.length !== 32) return null;
  const ok = await crypto.subtle.verify('HMAC', key, mac, enc.encode(payload(version, userId, sid, expText)));
  return ok ? { userId, sid, exp } : null;
}

/** Whether a verified pass belongs to the session token of the request (constant-time compare). */
export async function passMatchesSession(pass, token) {
  if (!pass || !token) return false;
  return timingSafeEqual(enc.encode(pass.sid), enc.encode(await sidOfToken(token)));
}

/**
 * Set-Cookie for a pass: `__Host-webra_play` (plain `webra_play` on http
 * localhost), HttpOnly, SameSite=Lax, Secure except on http localhost,
 * Max-Age 600. Path=/ because browsers refuse `__Host-` cookies with any
 * other path; the Worker reads it only on /play requests.
 */
export function playPassCookie(request, value) {
  return cookieHeader(request, PLAY_COOKIE, value, PASS_TTL_S);
}

export function clearPlayPassCookie(request) {
  return cookieHeader(request, PLAY_COOKIE, '', 0);
}
