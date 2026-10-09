// Westwood MIX archives (Tiberian Dawn and Red Alert), read in the browser
// from the player's own game files. Nothing is uploaded: a source is anything
// with `size` and `read(offset, length)`, for example a File (only the index
// and the entries we need are read, so a 500 MB main.mix is fine).
//
// Formats (as documented by XCC and implemented by OpenRA's MixFile):
//   Tiberian Dawn: u16 count, u32 data size, count x { u32 id, u32 offset, u32 size }
//   Red Alert:     u32 flags (low u16 = 0; 0x20000 encrypted, 0x10000 checksum)
//                  then the same index, either plain or Blowfish-encrypted
//                  after an 80-byte key source (mixkey.js).
// Entry offsets are relative to the end of the index. Entries carry no
// names, only an id: the hash of the uppercased file name (mixHash).

import { Blowfish } from './blowfish.js';
import { decryptKeySource, KEY_SOURCE_LENGTH } from './mixkey.js';

const ENTRY_SIZE = 12;
const FLAG_ENCRYPTED = 0x2;

export class MixError extends Error {}

/** Westwood's classic file id: rotate-left-1-and-add over little-endian 4-byte chunks of the uppercased name. */
export function mixHash(name) {
  const upper = name.toUpperCase();
  const padded = upper.length % 4 ? upper.length + 4 - (upper.length % 4) : upper.length;
  let result = 0;
  for (let i = 0; i < padded; i += 4) {
    let word = 0;
    for (let k = 3; k >= 0; k--) {
      const c = i + k < upper.length ? upper.charCodeAt(i + k) & 0xff : 0;
      word = (word << 8) | c;
    }
    result = (((result << 1) | (result >>> 31)) + (word >>> 0)) >>> 0;
  }
  return result >>> 0;
}

/** A byte source over an in-memory array (tests, nested archives already read). */
export function bytesSource(bytes) {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, offset + length);
    },
  };
}

/** A byte source over a Blob or File; reads only the requested slices. */
export function blobSource(blob) {
  return {
    size: blob.size,
    async read(offset, length) {
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
}

/** A window [start, start + size) of another source (an archive inside an archive). */
export function subSource(source, start, size) {
  return {
    size,
    read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      return source.read(start + offset, len);
    },
  };
}

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

async function readExact(source, offset, length) {
  if (offset + length > source.size) throw new MixError('not a MIX archive (truncated index)');
  const b = await source.read(offset, length);
  if (b.length !== length) throw new MixError('not a MIX archive (short read)');
  return b;
}

export class MixArchive {
  constructor(source, entries, dataStart, encrypted) {
    this.source = source;
    /** @type {Map<number, { offset: number, size: number }>} id -> absolute offset and size */
    this.entries = entries;
    this.dataStart = dataStart;
    this.encrypted = encrypted;
  }

  /**
   * Parse the index of `source`. Throws MixError when it is not a MIX archive.
   * `publicKey` replaces Westwood's key for encrypted indexes (tests use their own).
   */
  static async open(source, { publicKey } = {}) {
    if (source.size < 6) throw new MixError('not a MIX archive (too small)');
    const head = await readExact(source, 0, Math.min(source.size, 10));
    let count;
    let indexBytes;
    let dataStart;
    let encrypted = false;
    if (u16(head, 0) !== 0) {
      // Tiberian Dawn layout: the count comes first.
      count = u16(head, 0);
      dataStart = 6 + count * ENTRY_SIZE;
      indexBytes = await readExact(source, 0, dataStart);
    } else {
      const flags = u16(head, 2);
      encrypted = (flags & FLAG_ENCRYPTED) !== 0;
      if (!encrypted) {
        if (source.size < 10) throw new MixError('not a MIX archive (too small)');
        count = u16(head, 4);
        const len = 6 + count * ENTRY_SIZE;
        indexBytes = await readExact(source, 4, len);
        dataStart = 4 + len;
      } else {
        const keySource = await readExact(source, 4, KEY_SOURCE_LENGTH);
        const fish = new Blowfish(decryptKeySource(keySource, publicKey));
        const at = 4 + KEY_SOURCE_LENGTH;
        const first = fish.decrypt(await readExact(source, at, 8));
        count = u16(first, 0);
        const len = 6 + count * ENTRY_SIZE;
        const padded = Math.ceil(len / 8) * 8;
        indexBytes = fish.decrypt(await readExact(source, at, padded));
        dataStart = at + padded;
      }
    }
    const dataSize = u32(indexBytes, 2);
    if (count === 0 || dataStart + dataSize > source.size) throw new MixError('not a MIX archive (bad header)');
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      const o = 6 + i * ENTRY_SIZE;
      const id = u32(indexBytes, o);
      const offset = u32(indexBytes, o + 4);
      const size = u32(indexBytes, o + 8);
      if (offset + size > dataSize) throw new MixError('not a MIX archive (entry outside the data)');
      entries.set(id, { offset: dataStart + offset, size });
    }
    return new MixArchive(source, entries, dataStart, encrypted);
  }

  has(name) {
    return this.entries.has(mixHash(name));
  }

  /** The size in bytes of a named entry (from the index, nothing is read), or null. */
  sizeOf(name) {
    return this.entries.get(mixHash(name))?.size ?? null;
  }

  /** The bytes of a named entry, or null. */
  async read(name) {
    const e = this.entries.get(mixHash(name));
    return e ? this.source.read(e.offset, e.size) : null;
  }

  /** A byte source for a named entry (to open an archive nested inside), or null. */
  entrySource(name) {
    const e = this.entries.get(mixHash(name));
    return e ? subSource(this.source, e.offset, e.size) : null;
  }
}
