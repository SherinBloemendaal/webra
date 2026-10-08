// The key of an encrypted Red Alert MIX index. Westwood stored an 80-byte key
// source after the archive flags; raising it to the public exponent modulo
// their public RSA modulus gives the 56-byte Blowfish key (the same scheme as
// XCC and OpenRA's BlowfishKeyProvider). The public key below is the one every
// tool that reads these archives uses: it is a key, not game content.

/** Westwood's public key: DER-style INTEGER (tag 2, length, big-endian bytes). */
export const WESTWOOD_PUBLIC_KEY = 'AihRvNoIbTn85FZRYNZRcT+i6KpU+maCsEqr3Q5q+LDB5tH7Tz2qQ38V';
export const PUBLIC_EXPONENT = 0x10001n;
export const KEY_SOURCE_LENGTH = 80;
export const BLOWFISH_KEY_LENGTH = 56;

function base64Bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Parse a tag-2 INTEGER (short or long length form) into a BigInt. */
export function parseKeyInteger(bytes) {
  if (bytes[0] !== 2) throw new Error('public key is not an INTEGER');
  let i = 1;
  let len = bytes[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + bytes[i++];
  }
  if (i + len > bytes.length) throw new Error('public key is truncated');
  let v = 0n;
  for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(bytes[i + k]);
  return v;
}

export function westwoodPublicKey() {
  return { n: parseKeyInteger(base64Bytes(WESTWOOD_PUBLIC_KEY)), e: PUBLIC_EXPONENT };
}

export function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

const bitLength = (n) => n.toString(2).length;

function leToBig(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function bigToLe(v, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Turn the key source into the Blowfish key. The source is split into blocks
 * one byte longer than the modulus allows for output; every block (little
 * endian) is raised to `e` mod `n` and contributes `blockBytes` output bytes.
 * @param {Uint8Array} source the 80 bytes after the archive flags
 * @param {{ n: bigint, e: bigint }} [key] RSA public key (tests pass their own)
 */
export function decryptKeySource(source, key = westwoodPublicKey()) {
  const blockBytes = Math.floor((bitLength(key.n) - 1) / 8);
  const out = [];
  for (let off = 0; off + blockBytes + 1 <= source.length; off += blockBytes + 1) {
    const m = modPow(leToBig(source.subarray(off, off + blockBytes + 1)), key.e, key.n);
    out.push(...bigToLe(m, blockBytes));
  }
  if (out.length < BLOWFISH_KEY_LENGTH) throw new Error('MIX key source is too short');
  return Uint8Array.from(out.slice(0, BLOWFISH_KEY_LENGTH));
}
