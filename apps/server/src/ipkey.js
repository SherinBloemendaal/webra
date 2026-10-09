// Keyed hashes of client IP addresses (and other rate limit subjects):
// HMAC-SHA256 under the Worker secret IP_HASH_SALT, so a stored hash cannot
// be reversed by hashing the IPv4 space. Production fails closed without the
// secret; only plain HTTP to a local development host uses a fixed dev salt.

import { HttpError } from './http.js';
import { hmacSha256, toHex } from './crypto.js';

export const DEV_IP_SALT = 'webra-local-development-ip-salt';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalDevRequest(request) {
  const url = new URL(request.url);
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
}

/** The HMAC key for IP hashes; throws 503 `misconfigured` when the secret is missing outside local development. */
export function ipSalt(env, request) {
  const s = env?.IP_HASH_SALT;
  if (typeof s === 'string' && s.length >= 16) return s;
  if (isLocalDevRequest(request)) return DEV_IP_SALT;
  console.error('IP_HASH_SALT is not set: refusing requests that would store address hashes');
  throw new HttpError(503, 'misconfigured', 'The server is not fully configured. Please try again later.');
}

/** HMAC-SHA256 (hex) of `purpose:value` under the salt. */
export async function keyedHash(salt, purpose, value) {
  return toHex(await hmacSha256(salt, `${purpose}:${value}`));
}
