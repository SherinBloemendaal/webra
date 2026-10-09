// Account password hashes: PBKDF2-HMAC-SHA256 through WebCrypto with a
// 16-byte salt per hash, the iteration count stored with every hash, and an
// optional pepper (Worker secret PASSWORD_PEPPER) applied as HMAC-SHA256
// before PBKDF2 (recorded per hash, so turning it on later keeps old hashes
// valid until they are upgraded at the next sign-in).
//
// CPU budget: the Workers Free plan gives a request 10 ms of CPU, and every
// request does at most ONE key derivation (sign-in, re-authentication,
// signup, setting or resetting a password; never verify-and-rehash in one
// request). Measured under workerd (wrangler dev 4.148, Apple M-series,
// 2026-10-09), per derivation: 30,000 iterations 2.2 ms, 40,000 2.8 ms,
// 50,000 3.6 ms, 60,000 4.2 ms, 100,000 7.2 ms. Edge machines can be up to
// about twice as slow, so the default of 40,000 (about 3 to 6 ms) leaves
// room for the rest of the request. PASSWORD_ITERATIONS (10,000 to 100,000,
// the Workers maximum for PBKDF2) raises it: keep it at or below 50,000 on
// the Free plan; on the Paid plan (30 s of CPU) 100,000 is fine. Hashes are
// upgraded to the current count and pepper whenever the password is set
// (change or reset), never at sign-in.

import { fromHex, hmacSha256, pbkdf2, randomBytes, timingSafeEqual, toHex } from '../crypto.js';

export const DEFAULT_ITERATIONS = 40_000;
export const MIN_ITERATIONS = 10_000;
export const MAX_ITERATIONS = 100_000;
const SALT_BYTES = 16;

/** The iteration count for new hashes. */
export function targetIterations(env) {
  const n = Number(env?.PASSWORD_ITERATIONS);
  return Number.isInteger(n) && n >= MIN_ITERATIONS && n <= MAX_ITERATIONS ? n : DEFAULT_ITERATIONS;
}

function pepperOf(env) {
  const p = env?.PASSWORD_PEPPER;
  return typeof p === 'string' && p.length >= 16 ? p : null;
}

async function derive(password, salt, iterations, pepper) {
  const material = pepper ? await hmacSha256(pepper, password) : password;
  return pbkdf2(material, salt, iterations);
}

/** A new hash record: { hash, salt, iterations, peppered } (hex, 0 or 1). */
export async function hashAccountPassword(password, env) {
  const salt = randomBytes(SALT_BYTES);
  const iterations = targetIterations(env);
  const pepper = pepperOf(env);
  const hash = await derive(password, salt, iterations, pepper);
  return { hash: toHex(hash), salt: toHex(salt), iterations, peppered: pepper ? 1 : 0 };
}

/**
 * Check a password against a stored user row (password_hash, password_salt,
 * password_iterations, password_peppered). Rows without a password, and a
 * peppered hash while the pepper is missing, still cost one derivation so
 * timing does not tell them apart.
 */
export async function verifyAccountPassword(password, row, env) {
  const pepper = pepperOf(env);
  const usable =
    row &&
    typeof row.password_hash === 'string' &&
    typeof row.password_salt === 'string' &&
    Number.isInteger(row.password_iterations) &&
    row.password_iterations >= 1 &&
    row.password_iterations <= MAX_ITERATIONS &&
    !(row.password_peppered === 1 && !pepper);
  if (!usable) {
    await derive(password, randomBytes(SALT_BYTES), targetIterations(env), pepper);
    return false;
  }
  const hash = await derive(password, fromHex(row.password_salt), row.password_iterations, row.password_peppered === 1 ? pepper : null);
  return timingSafeEqual(hash, fromHex(row.password_hash));
}

/** Burn the time of one verification (unknown logins). */
export async function dummyVerify(password, env) {
  await derive(password, randomBytes(SALT_BYTES), targetIterations(env), pepperOf(env));
  return false;
}
