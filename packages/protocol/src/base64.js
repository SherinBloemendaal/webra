// Standard padded base64 (RFC 4648), as the engine reads and writes it
// (engine/src/mapdata.rs). Pure, no platform helpers (atob/btoa differ in how
// they treat bad input).

import { fail } from './check.js';

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const B64_CODES = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < ABC.length; i++) t[ABC.charCodeAt(i)] = i;
  return t;
})();

/** Decode standard, padded base64 (as the engine requires). Throws on bad input. */
export function decodeBase64(s, what) {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !B64_RE.test(s)) fail(`${what} is not valid base64`);
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_CODES[s.charCodeAt(i)];
    const b = B64_CODES[s.charCodeAt(i + 1)];
    const c = s[i + 2] === '=' ? 0 : B64_CODES[s.charCodeAt(i + 2)];
    const d = s[i + 3] === '=' ? 0 : B64_CODES[s.charCodeAt(i + 3)];
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  // Non-canonical encodings (stray bits in the last group) are rejected.
  if (pad === 2 && (B64_CODES[s.charCodeAt(s.length - 3)] & 15) !== 0) fail(`${what} is not valid base64`);
  if (pad === 1 && (B64_CODES[s.charCodeAt(s.length - 2)] & 3) !== 0) fail(`${what} is not valid base64`);
  return out;
}

/** Expected base64 length for n bytes. */
export function base64Length(n) {
  return Math.ceil(n / 3) * 4;
}

/** Standard padded base64 of a byte array (the encoding decodeBase64 accepts). */
export function encodeBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ABC[(n >> 18) & 63] + ABC[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ABC[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? ABC[n & 63] : '=';
  }
  return out;
}
