// WebCrypto helpers: random tokens, PBKDF2 password hashes, constant-time compares.

export const PBKDF2_ITERATIONS = 100_000; // Workers' maximum for PBKDF2
const SALT_BYTES = 16;
const HASH_BITS = 256;

const enc = new TextEncoder();

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomHex(bytes) {
  return toHex(randomBytes(bytes));
}

/** 32 random bytes, base64url (43 characters): the host key. */
export function randomToken() {
  return toBase64Url(randomBytes(32));
}

/** Uniform random integer in 0..n-1 (rejection sampling, no modulo bias). */
export function randomInt(n) {
  if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError('bad range');
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Compare two byte arrays in time that depends only on their lengths. */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256(textValue) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(textValue)));
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

/** Salted PBKDF2-SHA256 record for storage: { salt, hash, iterations } (hex). */
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2(password, salt, iterations);
  return { salt: toHex(salt), hash: toHex(hash), iterations };
}

export async function verifyPassword(password, record) {
  const hash = await pbkdf2(password, fromHex(record.salt), record.iterations);
  return timingSafeEqual(hash, fromHex(record.hash));
}

/** Host keys are stored as their SHA-256 only (high entropy, no salt needed). */
export async function hashHostKey(hostKey) {
  return toHex(await sha256(hostKey));
}

export async function verifyHostKey(hostKey, storedHex) {
  return timingSafeEqual(await sha256(hostKey), fromHex(storedHex));
}
