// Blowfish (Bruce Schneier, 1993), as used by Westwood to encrypt the index of
// Red Alert MIX archives (see mix.js). Only ECB decryption of whole blocks is
// needed. The initial P-array and S-boxes are the hexadecimal digits of pi;
// instead of shipping 4 KiB of constants they are computed once, on first use,
// with BigInt arithmetic (Machin's formula). tests/audio-decoders.test.mjs
// checks the result against the published Blowfish test vectors.

const P_WORDS = 18;
const S_WORDS = 4 * 256;
const WORDS = P_WORDS + S_WORDS;

let tables = null;

/** arctan(1/x) scaled by `scale`, as a BigInt. */
function arctanInverse(x, scale) {
  const x2 = x * x;
  let term = scale / x;
  let sum = 0n;
  let n = 1n;
  let positive = true;
  while (term !== 0n) {
    sum += positive ? term / n : -(term / n);
    term /= x2;
    n += 2n;
    positive = !positive;
  }
  return sum;
}

/** The first `count` 32-bit words of the fractional part of pi, in hexadecimal. */
export function piWords(count) {
  const guard = 64n;
  const bits = BigInt(count * 32) + guard;
  const scale = 1n << bits;
  const pi = 16n * arctanInverse(5n, scale) - 4n * arctanInverse(239n, scale);
  let frac = (pi - 3n * scale) >> guard; // count * 32 bits after the point
  const out = new Uint32Array(count);
  for (let i = count - 1; i >= 0; i--) {
    out[i] = Number(frac & 0xffffffffn);
    frac >>= 32n;
  }
  return out;
}

function initialTables() {
  if (!tables) tables = piWords(WORDS);
  return tables;
}

export class Blowfish {
  /** @param {Uint8Array} key 4 to 56 bytes */
  constructor(key) {
    if (!(key instanceof Uint8Array) || key.length < 1 || key.length > 72) throw new Error('Blowfish key must be 1 to 72 bytes');
    const init = initialTables();
    this.p = init.slice(0, P_WORDS);
    this.s = init.slice(P_WORDS, WORDS);
    let j = 0;
    for (let i = 0; i < P_WORDS; i++) {
      let data = 0;
      for (let k = 0; k < 4; k++) {
        data = ((data << 8) | key[j]) >>> 0;
        j = (j + 1) % key.length;
      }
      this.p[i] ^= data;
    }
    const block = [0, 0];
    for (let i = 0; i < P_WORDS; i += 2) {
      this.encryptWords(block);
      this.p[i] = block[0];
      this.p[i + 1] = block[1];
    }
    for (let i = 0; i < S_WORDS; i += 2) {
      this.encryptWords(block);
      this.s[i] = block[0];
      this.s[i + 1] = block[1];
    }
  }

  f(x) {
    const s = this.s;
    const h = (s[x >>> 24] + s[256 + ((x >>> 16) & 255)]) >>> 0;
    return ((h ^ s[512 + ((x >>> 8) & 255)]) + s[768 + (x & 255)]) >>> 0;
  }

  /** Encrypt one block in place: [left, right] as unsigned 32-bit words. */
  encryptWords(block) {
    let [l, r] = block;
    for (let i = 0; i < 16; i++) {
      l = (l ^ this.p[i]) >>> 0;
      r = (r ^ this.f(l)) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    r = (r ^ this.p[16]) >>> 0;
    l = (l ^ this.p[17]) >>> 0;
    block[0] = l;
    block[1] = r;
  }

  /** Decrypt one block in place. */
  decryptWords(block) {
    let [l, r] = block;
    for (let i = 17; i > 1; i--) {
      l = (l ^ this.p[i]) >>> 0;
      r = (r ^ this.f(l)) >>> 0;
      [l, r] = [r, l];
    }
    [l, r] = [r, l];
    r = (r ^ this.p[1]) >>> 0;
    l = (l ^ this.p[0]) >>> 0;
    block[0] = l;
    block[1] = r;
  }

  /** ECB over whole 8-byte blocks (big-endian words); returns a new array. */
  decrypt(bytes) {
    return this.run(bytes, (b) => this.decryptWords(b));
  }

  encrypt(bytes) {
    return this.run(bytes, (b) => this.encryptWords(b));
  }

  run(bytes, op) {
    if (bytes.length % 8 !== 0) throw new Error('Blowfish data must be a multiple of 8 bytes');
    const out = new Uint8Array(bytes.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dst = new DataView(out.buffer);
    const block = [0, 0];
    for (let i = 0; i < bytes.length; i += 8) {
      block[0] = view.getUint32(i, false);
      block[1] = view.getUint32(i + 4, false);
      op(block);
      dst.setUint32(i, block[0], false);
      dst.setUint32(i + 4, block[1], false);
    }
    return out;
  }
}
