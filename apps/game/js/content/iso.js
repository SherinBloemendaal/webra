// ISO 9660 CD images (the freeware Red Alert discs EA released in 2008),
// read in the browser without loading the image: a source is anything with
// `size` and `read(offset, length)` (audio/mix.js: blobSource over a File,
// or a window of bytes fetched by range). Only the volume descriptor and the
// directories on the way to a file are read, a few kilobytes of a 650 MB
// image; the file itself becomes a window of the image (subSource), so a
// MIX archive inside is opened like any other.
//
// Layout (ECMA-119): 2048-byte sectors; sector 16 holds the primary volume
// descriptor (type 1, "CD001"), with the logical block size at byte 128 and
// the root directory record at byte 156. A directory record is
//   u8 length, u8 ext attr length, u32le+u32be extent (block), u32le+u32be size,
//   7 bytes date, u8 flags (0x02 directory, 0x80 multi-extent), ..., u8 name length @32, name @33
// and records never cross a sector: a zero length byte pads to the next one.

import { subSource } from '../audio/mix.js';

export const SECTOR = 2048;
const PVD_OFFSET = 16 * SECTOR;
const FLAG_DIRECTORY = 0x02;
const FLAG_MULTI_EXTENT = 0x80;
/** Directories larger than this are not CD directories (the discs' largest is a few sectors). */
const MAX_DIRECTORY_BYTES = 1024 * 1024;
/** Path depth limit (the files we look for are at most one directory deep). */
const MAX_DEPTH = 8;

export class IsoError extends Error {}

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

async function readExact(source, offset, length) {
  if (offset < 0 || offset + length > source.size) throw new IsoError('not a CD image (truncated)');
  const b = await source.read(offset, length);
  if (b.length !== length) throw new IsoError('not a CD image (short read)');
  return b;
}

/** "MAIN.MIX;1" -> "MAIN.MIX", "README." -> "README" (ISO 9660 version and empty extension). */
export function isoName(raw) {
  return raw.replace(/;\d+$/, '').replace(/\.$/, '');
}

/** Whether the first bytes of a file look like an ISO 9660 image (needs 32 KiB + 6 bytes). */
export function looksLikeIso(head) {
  return head.length >= PVD_OFFSET + 6 && head[PVD_OFFSET] === 1 && String.fromCharCode(...head.subarray(PVD_OFFSET + 1, PVD_OFFSET + 6)) === 'CD001';
}

/** Parse the directory records in `bytes`: [{ name, extent, size, dir }]. */
export function parseDirectory(bytes, blockSize) {
  const out = [];
  let o = 0;
  while (o < bytes.length) {
    const len = bytes[o];
    if (len === 0) {
      // Padding to the next sector.
      o = (Math.floor(o / SECTOR) + 1) * SECTOR;
      continue;
    }
    // A record is at least 34 bytes, stays inside the directory and never crosses a sector.
    if (len < 34 || o + len > bytes.length || (o % SECTOR) + len > SECTOR) throw new IsoError('not a CD image (bad directory record)');
    const nameLen = bytes[o + 32];
    if (33 + nameLen > len) throw new IsoError('not a CD image (bad directory record)');
    const flags = bytes[o + 25];
    const nameBytes = bytes.subarray(o + 33, o + 33 + nameLen);
    // 0x00 and 0x01 are the "." and ".." records.
    if (!(nameLen === 1 && nameBytes[0] <= 1)) {
      out.push({
        name: isoName(String.fromCharCode(...nameBytes)),
        extent: u32(bytes, o + 2) * blockSize,
        size: u32(bytes, o + 10),
        dir: (flags & FLAG_DIRECTORY) !== 0,
        multiExtent: (flags & FLAG_MULTI_EXTENT) !== 0,
      });
    }
    o += len;
  }
  return out;
}

export class IsoImage {
  constructor(source, blockSize, root) {
    this.source = source;
    this.blockSize = blockSize;
    this.root = root;
  }

  /** Read the primary volume descriptor of `source`. Throws IsoError when it is not an ISO 9660 image. */
  static async open(source) {
    if (source.size < PVD_OFFSET + SECTOR) throw new IsoError('not a CD image (too small)');
    const pvd = await readExact(source, PVD_OFFSET, SECTOR);
    if (pvd[0] !== 1 || String.fromCharCode(...pvd.subarray(1, 6)) !== 'CD001') throw new IsoError('not a CD image (no ISO 9660 volume)');
    const blockSize = u16(pvd, 128);
    if (blockSize !== 2048 && blockSize !== 1024 && blockSize !== 512) throw new IsoError('not a CD image (bad block size)');
    const root = { name: '', extent: u32(pvd, 156 + 2) * blockSize, size: u32(pvd, 156 + 10), dir: true, multiExtent: false };
    return new IsoImage(source, blockSize, root);
  }

  async list(dir) {
    if (!dir.dir) throw new IsoError(`${dir.name} is not a directory`);
    if (dir.size > MAX_DIRECTORY_BYTES) throw new IsoError('not a CD image (directory too large)');
    return parseDirectory(await readExact(this.source, dir.extent, dir.size), this.blockSize);
  }

  /** The record of `path` ("MAIN.MIX", "INSTALL/REDALERT.MIX"; any case), or null. */
  async find(path) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    if (!parts.length || parts.length > MAX_DEPTH) return null;
    let at = this.root;
    for (let i = 0; i < parts.length; i++) {
      const want = parts[i].toUpperCase();
      const hit = (await this.list(at)).find((r) => r.name.toUpperCase() === want);
      if (!hit || hit.dir !== (i < parts.length - 1)) return null;
      at = hit;
    }
    if (at.multiExtent) throw new IsoError(`${path} is split in parts, which is not supported`);
    if (at.extent + at.size > this.source.size) throw new IsoError(`${path} lies outside the image (truncated download?)`);
    return at;
  }

  /** A byte source for the file at `path` (a window of the image), or null. */
  async fileSource(path) {
    const r = await this.find(path);
    return r ? subSource(this.source, r.extent, r.size) : null;
  }
}
