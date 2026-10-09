// Account password hashes: PBKDF2-HMAC-SHA256 through WebCrypto with a
// 16-byte salt per hash, the iteration count stored with every hash, and an
// optional pepper (Worker secret PASSWORD_PEPPER) applied as HMAC-SHA256
// before PBKDF2 (recorded per hash, so turning it on later keeps old hashes
// valid until they are upgraded at the next sign-in).
//
// Iterations: Workers allow at most 100,000 for PBKDF2, and the free plan
// gives a request 10 ms of CPU. Measured under workerd (wrangler dev, 2026-10):
// 50,000 iterations take about 3 to 4 ms and 100,000 about 6 to 8 ms, so the
// default of 60,000 leaves room for the rest of a sign-in. The
// PASSWORD_ITERATIONS variable (10,000 to 100,000) raises it later, for
// example on the Paid plan; hashes with fewer iterations are upgraded at the
// next successful sign-in.

import { fromHex, hmacSha256, pbkdf2, randomBytes, timingSafeEqual, toHex } from '../crypto.js';

export const DEFAULT_ITERATIONS = 60_000;
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

/** Whether a verified hash should be replaced (fewer iterations, or the pepper state changed). */
export function needsRehash(row, env) {
  return row.password_iterations < targetIterations(env) || row.password_peppered !== (pepperOf(env) ? 1 : 0);
}

/** Burn the time of one verification (unknown logins). */
export async function dummyVerify(password, env) {
  await derive(password, randomBytes(SALT_BYTES), targetIterations(env), pepperOf(env));
  return false;
}
