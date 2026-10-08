// Synthetic Westwood files for the audio tests: AUD and MIX files built here
// from generated tones, never from Electronic Arts content. Includes encoders
// (IMA ADPCM, MIX writer, encrypted MIX index with a test RSA key) that the
// game itself does not need.

import { Blowfish } from '../js/audio/blowfish.js';
import { mixHash } from '../js/audio/mix.js';
import { modPow } from '../js/audio/mixkey.js';
import { IMA_STEPS, imaDecodeNibble, FORMAT_IMA, FORMAT_WESTWOOD, CHUNK_MAGIC } from '../js/audio/aud.js';

/** A test tone: 16-bit samples. */
export function sineSamples(n, freq = 440, rate = 22050, amp = 12000) {
  return Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp));
}

/** Encode 16-bit samples as IMA ADPCM nibbles (state shared with the decoder's rules). */
export function imaEncode(samples) {
  const state = { index: 0, sample: 0 };
  const out = new Uint8Array(Math.ceil(samples.length / 2));
  for (let i = 0; i < samples.length; i++) {
    const step = IMA_STEPS[state.index];
    let diff = samples[i] - state.sample;
    let code = 0;
    if (diff < 0) {
      code = 8;
      diff = -diff;
    }
    let s = step;
    if (diff >= s) {
      code |= 4;
      diff -= s;
    }
    s >>= 1;
    if (diff >= s) {
      code |= 2;
      diff -= s;
    }
    s >>= 1;
    if (diff >= s) code |= 1;
    imaDecodeNibble(code, state);
    out[i >> 1] |= i & 1 ? code << 4 : code;
  }
  return out;
}

/**
 * An .aud file. `chunks` are [compressedBytes, outputBytes] pairs.
 */
export function audFile({ rate = 22050, format = FORMAT_IMA, flags = 2, chunks }) {
  const dataSize = chunks.reduce((n, [c]) => n + 8 + c.length, 0);
  const outSize = chunks.reduce((n, [, o]) => n + o, 0);
  const out = new Uint8Array(12 + dataSize);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, rate, true);
  dv.setUint32(2, dataSize, true);
  dv.setUint32(6, outSize, true);
  out[10] = flags;
  out[11] = format;
  let at = 12;
  for (const [c, o] of chunks) {
    dv.setUint16(at, c.length, true);
    dv.setUint16(at + 2, o, true);
    dv.setUint32(at + 4, CHUNK_MAGIC, true);
    out.set(c, at + 8);
    at += 8 + c.length;
  }
  return out;
}

/** IMA .aud of `samples`, split into chunks of `chunkBytes` compressed bytes. */
export function imaAud(samples, { rate = 22050, chunkBytes = 512 } = {}) {
  const enc = imaEncode(samples);
  const chunks = [];
  for (let i = 0; i < enc.length; i += chunkBytes) {
    const c = enc.subarray(i, i + chunkBytes);
    chunks.push([c, c.length * 4]);
  }
  return audFile({ rate, format: FORMAT_IMA, flags: 2, chunks });
}

/** A Westwood ADPCM .aud from hand-made chunks. */
export function wsAud(chunks, rate = 11025) {
  return audFile({ rate, format: FORMAT_WESTWOOD, flags: 0, chunks });
}

/** A MIX archive index + data; `layout` 'td' (no flags) or 'ra' (flags 0). Returns { header, data }. */
function mixParts(files) {
  const list = files.map(({ name, data }) => ({ id: mixHash(name), data })).sort((a, b) => (a.id | 0) - (b.id | 0));
  let offset = 0;
  const header = new Uint8Array(6 + list.length * 12);
  const dv = new DataView(header.buffer);
  dv.setUint16(0, list.length, true);
  list.forEach((f, i) => {
    dv.setUint32(6 + i * 12, f.id, true);
    dv.setUint32(10 + i * 12, offset, true);
    dv.setUint32(14 + i * 12, f.data.length, true);
    offset += f.data.length;
  });
  dv.setUint32(2, offset, true);
  const data = new Uint8Array(offset);
  let at = 0;
  for (const f of list) {
    data.set(f.data, at);
    at += f.data.length;
  }
  return { header, data };
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Unencrypted MIX: { name, data }[] -> bytes. */
export function buildMix(files, { layout = 'ra', checksum = false } = {}) {
  const { header, data } = mixParts(files);
  if (layout === 'td') return concat(header, data);
  const flags = new Uint8Array([0, 0, checksum ? 1 : 0, 0]);
  return concat(flags, header, data, checksum ? new Uint8Array(20) : new Uint8Array(0));
}

// ---- Encrypted MIX with a test RSA key ------------------------------------------

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBig(bits, r) {
  let v = 0n;
  for (let i = 0; i < bits; i += 16) v = (v << 16n) | BigInt(Math.floor(r() * 65536));
  v &= (1n << BigInt(bits)) - 1n;
  return v | (3n << BigInt(bits - 2)) | 1n; // top two bits set, odd
}

function isProbablePrime(n) {
  if (n < 2n) return false;
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

function modInverse(a, m) {
  let [r0, r1] = [a % m, m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

/** A deterministic RSA key with a 319-bit modulus, like Westwood's. */
export function testRsaKey(seed = 1) {
  const r = seeded(seed);
  const e = 0x10001n;
  for (;;) {
    let p = randomBig(160, r);
    while (!isProbablePrime(p)) p += 2n;
    let q = randomBig(160, r);
    while (!isProbablePrime(q)) q += 2n;
    const n = p * q;
    const phi = (p - 1n) * (q - 1n);
    if (n.toString(2).length !== 319 && n.toString(2).length !== 320) continue;
    if (phi % e === 0n) continue;
    return { n, e, d: modInverse(e, phi) };
  }
}

const leToBig = (b) => b.reduceRight((v, x) => (v << 8n) | BigInt(x), 0n);
function bigToLe(v, len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The 80-byte key source that decrypts (with `key`'s public half) to `blowfishKey`. */
export function encryptKeySource(blowfishKey, key) {
  const blockBytes = Math.floor((key.n.toString(2).length - 1) / 8);
  const plain = new Uint8Array(2 * blockBytes);
  plain.set(blowfishKey);
  const blocks = [];
  for (let off = 0; off < plain.length; off += blockBytes) {
    blocks.push(bigToLe(modPow(leToBig(plain.subarray(off, off + blockBytes)), key.d, key.n), blockBytes + 1));
  }
  return concat(...blocks);
}

/** Red Alert MIX with a Blowfish-encrypted index. */
export function buildEncryptedMix(files, key, blowfishKey = Uint8Array.from({ length: 56 }, (_, i) => (i * 37 + 11) & 255)) {
  const { header, data } = mixParts(files);
  const padded = new Uint8Array(Math.ceil(header.length / 8) * 8);
  padded.set(header);
  const index = new Blowfish(blowfishKey).encrypt(padded);
  return concat(new Uint8Array([0, 0, 2, 0]), encryptKeySource(blowfishKey, key), index, data);
}
