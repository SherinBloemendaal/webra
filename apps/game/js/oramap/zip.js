// Minimal ZIP reader for .oramap packages. Files are hostile: every offset and
// size is checked against the buffer, entries are unpacked one at a time on
// request, and limits on entry count, sizes and compression ratio stop zip
// bombs. Stored (0) and deflate (8) entries only; deflate goes through the
// platform's DecompressionStream('deflate-raw') (browsers, Node 18+), with the
// output counted while it streams so a lying header cannot blow past a limit.
// No ZIP64, no encryption, no multi-disk archives.

export class ZipError extends Error {}

export const ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 16 * 1024 * 1024,
  maxEntries: 512,
  maxNameBytes: 255,
  /** Largest unpacked entry. */
  maxEntryBytes: 8 * 1024 * 1024,
  /** Sum of all unpacked entries that are read. */
  maxTotalBytes: 32 * 1024 * 1024,
  /** Unpacked / packed size, for entries larger than ratioFloorBytes. */
  maxRatio: 1000,
  ratioFloorBytes: 64 * 1024,
});

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const EOCD_MIN = 22;
const CEN_MIN = 46;
const LOC_MIN = 30;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ZIP polynomial) of a byte array. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Whether the bytes start like a ZIP archive (local file header or empty archive). */
export function looksLikeZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return false;
  const sig = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  return sig >>> 0 === SIG_LOC || sig >>> 0 === SIG_EOCD;
}

function decodeName(raw, utf8) {
  // Bit 11 marks UTF-8; otherwise CP437, of which the ASCII part is all we need
  // (names we look up are ASCII). Non-ASCII bytes stay recognizable as U+FFFD.
  if (utf8) return new TextDecoder('utf-8', { fatal: false }).decode(raw);
  let s = '';
  for (const b of raw) s += b < 0x80 ? String.fromCharCode(b) : '\ufffd';
  return s;
}

/**
 * Parse the central directory of a ZIP archive.
 *
 * @param {Uint8Array} bytes the whole archive
 * @param {Partial<typeof ZIP_LIMITS>} [limits]
 * @returns {ZipArchive}
 */
export function openZip(bytes, limits = {}) {
  const lim = { ...ZIP_LIMITS, ...limits };
  if (!(bytes instanceof Uint8Array)) throw new ZipError('not a byte array');
  if (bytes.length > lim.maxArchiveBytes) throw new ZipError(`the archive is larger than ${lim.maxArchiveBytes} bytes`);
  if (bytes.length < EOCD_MIN) throw new ZipError('not a ZIP archive (too short)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => view.getUint16(o, true);
  const u32 = (o) => view.getUint32(o, true);

  // End of central directory: the last 22 bytes plus a comment of up to 65535.
  let eocd = -1;
  const stop = Math.max(0, bytes.length - EOCD_MIN - 0xffff);
  for (let o = bytes.length - EOCD_MIN; o >= stop; o--) {
    if (u32(o) === SIG_EOCD && o + EOCD_MIN + u16(o + 20) === bytes.length) {
      eocd = o;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('not a ZIP archive (no end of central directory)');
  const disk = u16(eocd + 4);
  const cdDisk = u16(eocd + 6);
  const entriesHere = u16(eocd + 8);
  const entryCount = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entryCount) throw new ZipError('multi-disk archives are not supported');
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported');
  if (entryCount > lim.maxEntries) throw new ZipError(`the archive has more than ${lim.maxEntries} entries`);
  if (cdOffset + cdSize > eocd) throw new ZipError('corrupt archive (central directory out of range)');

  const entries = [];
  const byName = new Map();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + CEN_MIN > cdOffset + cdSize) throw new ZipError('corrupt archive (central directory truncated)');
    if (u32(p) !== SIG_CEN) throw new ZipError('corrupt archive (bad central directory entry)');
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const compressedSize = u32(p + 20);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const localOffset = u32(p + 42);
    const next = p + CEN_MIN + nameLen + extraLen + commentLen;
    if (next > cdOffset + cdSize) throw new ZipError('corrupt archive (central directory truncated)');
    if (nameLen === 0 || nameLen > lim.maxNameBytes) throw new ZipError('corrupt archive (bad entry name)');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('ZIP64 archives are not supported');
    }
    const name = decodeName(bytes.subarray(p + CEN_MIN, p + CEN_MIN + nameLen), (flags & 0x800) !== 0);
    const entry = {
      name,
      flags,
      method,
      crc,
      compressedSize,
      size,
      localOffset,
      directory: name.endsWith('/'),
      encrypted: (flags & 1) !== 0,
    };
    entries.push(entry);
    // Duplicate names: the first one wins, like most tools; the reader reports it.
    if (!byName.has(name)) byName.set(name, entry);
    p = next;
  }
  return new ZipArchive(bytes, entries, byName, lim);
}

export class ZipArchive {
  constructor(bytes, entries, byName, limits) {
    this.bytes = bytes;
    this.entries = entries;
    this.byName = byName;
    this.limits = limits;
    this.totalRead = 0;
  }

  /** File names (directories left out), in archive order. */
  names() {
    return this.entries.filter((e) => !e.directory).map((e) => e.name);
  }

  duplicateNames() {
    const seen = new Set();
    const dup = new Set();
    for (const e of this.entries) (seen.has(e.name) ? dup : seen).add(e.name);
    return [...dup];
  }

  has(name) {
    const e = this.byName.get(name);
    return Boolean(e && !e.directory);
  }

  /** Unpack one entry. Throws ZipError on a missing, corrupt or oversized entry. */
  async read(name) {
    const e = this.byName.get(name);
    if (!e || e.directory) throw new ZipError(`${name} is missing from the archive`);
    const lim = this.limits;
    if (e.encrypted) throw new ZipError(`${name} is encrypted`);
    if (e.method !== 0 && e.method !== 8) throw new ZipError(`${name} uses an unsupported compression method (${e.method})`);
    if (e.size > lim.maxEntryBytes) throw new ZipError(`${name} is larger than ${lim.maxEntryBytes} bytes`);
    if (this.totalRead + e.size > lim.maxTotalBytes) throw new ZipError('the archive unpacks to too much data');
    if (e.size > lim.ratioFloorBytes && e.size > e.compressedSize * lim.maxRatio) {
      throw new ZipError(`${name} has a suspicious compression ratio`);
    }
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const lo = e.localOffset;
    if (lo + LOC_MIN > this.bytes.length || view.getUint32(lo, true) !== SIG_LOC) {
      throw new ZipError(`corrupt archive (bad local header for ${name})`);
    }
    const start = lo + LOC_MIN + view.getUint16(lo + 26, true) + view.getUint16(lo + 28, true);
    const end = start + e.compressedSize;
    if (end > this.bytes.length) throw new ZipError(`corrupt archive (${name} is truncated)`);
    const packed = this.bytes.subarray(start, end);
    let data;
    if (e.method === 0) {
      if (e.compressedSize !== e.size) throw new ZipError(`corrupt archive (stored ${name} has two sizes)`);
      data = packed.slice();
    } else {
      data = await inflateRaw(packed, e.size, name);
    }
    if (data.length !== e.size) throw new ZipError(`corrupt archive (${name} has the wrong size)`);
    if (crc32(data) !== e.crc) throw new ZipError(`corrupt archive (${name} fails its checksum)`);
    this.totalRead += data.length;
    return data;
  }

  /** Unpack one entry as UTF-8 text (a leading BOM is dropped). */
  async readText(name) {
    const bytes = await this.read(name);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ZipError(`${name} is not UTF-8 text`);
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
}

/**
 * Inflate raw deflate data, stopping as soon as the output would pass
 * `expected` bytes (the size the archive declares, itself already limited).
 */
export async function inflateRaw(packed, expected, name = 'entry') {
  let ds;
  try {
    ds = new DecompressionStream('deflate-raw');
  } catch {
    throw new ZipError('this browser cannot unpack compressed files (no DecompressionStream deflate-raw)');
  }
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // Write and close without awaiting: the reader below drains the output, and
  // a rejected write (corrupt data) surfaces through the read as well.
  writer.write(packed).catch(() => {});
  writer.close().catch(() => {});
  const out = new Uint8Array(expected);
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > expected) {
        throw new ZipError(`corrupt archive (${name} unpacks to more than its declared size)`);
      }
      out.set(value, n);
      n += value.length;
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    if (err instanceof ZipError) throw err;
    throw new ZipError(`corrupt archive (${name} cannot be unpacked)`);
  }
  if (n !== expected) throw new ZipError(`corrupt archive (${name} has the wrong size)`);
  return out;
}
