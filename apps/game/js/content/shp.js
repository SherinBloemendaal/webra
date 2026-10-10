// Westwood sprite and tile formats of Red Alert (and Tiberian Dawn, for the
// desert theater), read in the browser from the player's own files:
//
//   SHP (TD/RA): u16 frame count, u16 x, u16 y, u16 width, u16 height,
//     u32 (unused), then count + 2 headers of 8 bytes { u24 file offset,
//     u8 format, u16 reference offset, u16 reference format } (the last two
//     mark the end of the file and an all-zero terminator). Formats:
//     0x80 LCW ("Format80") compressed full frame, 0x40 XOR delta
//     ("Format40") against the frame at the reference offset, 0x20 XOR delta
//     against the previous frame.
//   TMP (RA and TD templates): a header, an index of tile slots (255 = no
//     tile) and raw 8-bit tiles of width x height.
//
// Every file is hostile: each offset and size is checked, sizes are capped
// and decoding never reads or writes outside its buffers. The algorithms
// follow OpenRA (OpenRA.Mods.Cnc ShpTDLoader, LCWCompression,
// XORDeltaCompression, TmpRALoader, TmpTDLoader, ShpD2Loader,
// RLEZerosCompression; GPL-3.0).

export class ContentError extends Error {}

export const SPRITE_LIMITS = Object.freeze({
  maxFrames: 4096,
  /** Largest frame or tile side in pixels. */
  maxSide: 1024,
  /** Largest file. */
  maxBytes: 16 * 1024 * 1024,
});

const FORMAT_XOR_PREV = 0x20;
const FORMAT_XOR_LCW = 0x40;
const FORMAT_LCW = 0x80;

/**
 * Decode LCW (Format80) from `src` at `offset` into `dest` (absolute back
 * references, as in SHP frames). Returns the number of bytes written. Like
 * OpenRA, a back reference that would run past the end stops the decoding.
 */
export function lcwDecode(src, offset, dest) {
  let s = offset;
  let d = 0;
  const need = (n) => {
    if (s + n > src.length) throw new ContentError('corrupt LCW data (reads past the end)');
  };
  for (;;) {
    need(1);
    const i = src[s++];
    if ((i & 0x80) === 0) {
      // Copy count bytes from `rpos` bytes back.
      need(1);
      const second = src[s++];
      const count = ((i & 0x70) >> 4) + 3;
      const rpos = ((i & 0x0f) << 8) + second;
      if (d + count > dest.length) return d;
      const from = d - rpos;
      if (from < 0) throw new ContentError('corrupt LCW data (bad back reference)');
      for (let k = 0; k < count; k++) dest[d + k] = rpos === 1 ? dest[d - 1] : dest[from + k];
      d += count;
    } else if ((i & 0x40) === 0) {
      const count = i & 0x3f;
      if (count === 0) return d;
      need(count);
      if (d + count > dest.length) throw new ContentError('corrupt LCW data (writes past the frame)');
      dest.set(src.subarray(s, s + count), d);
      s += count;
      d += count;
    } else {
      const count3 = i & 0x3f;
      if (count3 === 0x3e) {
        need(3);
        const count = src[s] | (src[s + 1] << 8);
        const color = src[s + 2];
        s += 3;
        if (d + count > dest.length) throw new ContentError('corrupt LCW data (writes past the frame)');
        dest.fill(color, d, d + count);
        d += count;
      } else {
        let count;
        if (count3 === 0x3f) {
          need(2);
          count = src[s] | (src[s + 1] << 8);
          s += 2;
        } else {
          count = count3 + 3;
        }
        need(2);
        let from = src[s] | (src[s + 1] << 8);
        s += 2;
        if (from >= d) throw new ContentError('corrupt LCW data (copies from ahead)');
        if (d + count > dest.length) throw new ContentError('corrupt LCW data (writes past the frame)');
        for (let k = 0; k < count; k++) dest[d++] = dest[from++];
      }
    }
  }
}

/** Apply XOR delta (Format40) data from `src` at `offset` to `dest` in place. Returns the end position in dest. */
export function xorDeltaDecode(src, offset, dest) {
  let s = offset;
  let d = 0;
  const need = (n) => {
    if (s + n > src.length) throw new ContentError('corrupt XOR delta data (reads past the end)');
  };
  const room = (n) => {
    if (d + n > dest.length) throw new ContentError('corrupt XOR delta data (writes past the frame)');
  };
  for (;;) {
    need(1);
    const i = src[s++];
    if ((i & 0x80) === 0) {
      let count = i & 0x7f;
      if (count === 0) {
        need(2);
        count = src[s];
        const value = src[s + 1];
        s += 2;
        room(count);
        for (let k = 0; k < count; k++) dest[d++] ^= value;
      } else {
        need(count);
        room(count);
        for (let k = 0; k < count; k++) dest[d++] ^= src[s++];
      }
    } else {
      let count = i & 0x7f;
      if (count === 0) {
        need(2);
        count = src[s] | (src[s + 1] << 8);
        s += 2;
        if (count === 0) return d;
        if ((count & 0x8000) === 0) {
          d += count & 0x7fff;
          if (d > dest.length) throw new ContentError('corrupt XOR delta data (skips past the frame)');
        } else if ((count & 0x4000) === 0) {
          const n = count & 0x3fff;
          need(n);
          room(n);
          for (let k = 0; k < n; k++) dest[d++] ^= src[s++];
        } else {
          const n = count & 0x3fff;
          need(1);
          const value = src[s++];
          room(n);
          for (let k = 0; k < n; k++) dest[d++] ^= value;
        }
      } else {
        d += count;
        if (d > dest.length) throw new ContentError('corrupt XOR delta data (skips past the frame)');
      }
    }
  }
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Whether `bytes` look like a TD/RA SHP (OpenRA ShpTDLoader.IsShpTD). */
export function isShp(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 14 + 16) return false;
  const count = u16(bytes, 0);
  if (count === 0) return false;
  const final = 14 + 8 * count;
  if (final + 4 > bytes.length) return false;
  if (u32(bytes, final) !== bytes.length) return false;
  const format = bytes[17];
  return format === FORMAT_XOR_PREV || format === FORMAT_XOR_LCW || format === FORMAT_LCW;
}

/**
 * Decode a TD/RA SHP. Returns `{ width, height, frames }` where every frame
 * is `{ width, height, data }` with `data` the full 8-bit frame (palette
 * indices, 0 transparent).
 */
export function decodeShp(bytes, limits = SPRITE_LIMITS) {
  if (!isShp(bytes)) throw new ContentError('not a SHP sprite');
  if (bytes.length > limits.maxBytes) throw new ContentError('the sprite file is too large');
  const count = u16(bytes, 0);
  const width = u16(bytes, 6);
  const height = u16(bytes, 8);
  if (count > limits.maxFrames) throw new ContentError(`the sprite has more than ${limits.maxFrames} frames`);
  if (width > limits.maxSide || height > limits.maxSide) throw new ContentError('the sprite frames are too large');
  const headers = [];
  for (let i = 0; i < count; i++) {
    const o = 14 + i * 8;
    const word = u32(bytes, o);
    headers.push({ offset: word & 0xffffff, format: word >>> 24, refOffset: u16(bytes, o + 4), data: null, busy: false });
  }
  const byOffset = new Map();
  for (const h of headers) if (!byOffset.has(h.offset)) byOffset.set(h.offset, h);
  const size = width * height;
  const dataStart = 14 + (count + 2) * 8;
  const decode = (index) => {
    // Iterative: follow references to the first frame that is already decoded or LCW.
    const chain = [];
    let k = index;
    for (;;) {
      const h = headers[k];
      if (h.data) break;
      if (h.busy || chain.length > count) throw new ContentError('corrupt sprite (frames refer to each other in a loop)');
      h.busy = true;
      chain.push(k);
      if (size === 0 || h.format === FORMAT_LCW) break;
      if (h.format === FORMAT_XOR_PREV) {
        if (k === 0) throw new ContentError('corrupt sprite (the first frame refers to a previous one)');
        k -= 1;
      } else if (h.format === FORMAT_XOR_LCW) {
        const ref = byOffset.get(h.refOffset);
        if (!ref) throw new ContentError('corrupt sprite (reference to missing image data)');
        k = headers.indexOf(ref);
      } else {
        throw new ContentError(`corrupt sprite (unknown frame format 0x${h.format.toString(16)})`);
      }
    }
    for (let c = chain.length - 1; c >= 0; c--) {
      const h = headers[chain[c]];
      if (h.offset < dataStart || h.offset >= bytes.length) throw new ContentError('corrupt sprite (frame data outside the file)');
      if (size === 0) {
        h.data = new Uint8Array(0);
      } else if (h.format === FORMAT_LCW) {
        h.data = new Uint8Array(size);
        lcwDecode(bytes, h.offset, h.data);
      } else {
        const ref = h.format === FORMAT_XOR_PREV ? headers[chain[c] - 1] : byOffset.get(h.refOffset);
        h.data = ref.data.slice();
        xorDeltaDecode(bytes, h.offset, h.data);
      }
      h.busy = false;
    }
    return headers[index].data;
  };
  const frames = headers.map((_, i) => ({ width, height, data: decode(i) }));
  return { width, height, frames };
}

/**
 * Trim a frame to its non-zero pixels, keeping its centre on whole pixels
 * (OpenRA ShpTDSprite.TrimmedFrame): `{ width, height, data, offset: [x, y] }`
 * where `offset` is the trimmed rectangle's centre relative to the frame's
 * centre. An empty frame becomes 0 x 0.
 */
export function trimFrame(frame) {
  const { width: w, height: h, data } = frame;
  let top = h - 1;
  let bottom = 0;
  let left = w - 1;
  let right = 0;
  let any = false;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (data[i] !== 0) {
        any = true;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (!any) return { width: 0, height: 0, data: new Uint8Array(0), offset: [0, 0] };
  let tw = right - left + 1;
  let th = bottom - top + 1;
  if ((tw - w) % 2 !== 0) {
    if (left > 0) left--;
    else right++;
    tw++;
  }
  if ((th - h) % 2 !== 0) {
    if (top > 0) top--;
    else bottom++;
    th++;
  }
  if (tw === w && th === h) return { width: w, height: h, data, offset: [0, 0] };
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    const from = (y + top) * w + left;
    // The widened rectangle may reach one column past the frame: those pixels stay 0.
    const n = Math.max(0, Math.min(tw, w - left));
    if (y + top < h) out.set(data.subarray(from, from + n), y * tw);
  }
  return { width: tw, height: th, data: out, offset: [(left + right - w + 1) / 2, (top + bottom - h + 1) / 2] };
}

/** Whether `bytes` look like a Red Alert TMP template (OpenRA TmpRALoader.IsTmpRA). */
export function isTmpRa(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 40 && u32(bytes, 20) === 0 && u16(bytes, 26) === 0x2c73;
}

/** Whether `bytes` look like a Tiberian Dawn TMP template (OpenRA TmpTDLoader.IsTmpTD). */
export function isTmpTd(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 32 && u32(bytes, 16) === 0 && u32(bytes, 20) === 0x0d1affff;
}

/**
 * Decode a TMP template (RA or TD layout): `{ width, height, tiles }` where
 * each tile is a width x height Uint8Array or null for an empty slot.
 */
export function decodeTmp(bytes, limits = SPRITE_LIMITS) {
  let imgStart;
  let indexEnd;
  let indexStart;
  if (isTmpRa(bytes)) {
    imgStart = u32(bytes, 16);
    indexEnd = u32(bytes, 28);
    indexStart = u32(bytes, 36);
  } else if (isTmpTd(bytes)) {
    imgStart = u32(bytes, 12);
    indexEnd = u32(bytes, 24);
    indexStart = u32(bytes, 28);
  } else {
    throw new ContentError('not a TMP template');
  }
  if (bytes.length > limits.maxBytes) throw new ContentError('the template file is too large');
  const width = u16(bytes, 0);
  const height = u16(bytes, 2);
  if (width === 0 || height === 0 || width > limits.maxSide || height > limits.maxSide) throw new ContentError('the template tiles have a bad size');
  const count = indexEnd - indexStart;
  if (count < 0 || count > limits.maxFrames || indexEnd > bytes.length) throw new ContentError('corrupt template (bad tile index)');
  const tileBytes = width * height;
  const tiles = [];
  for (let i = 0; i < count; i++) {
    const slot = bytes[indexStart + i];
    if (slot === 255) {
      tiles.push(null);
      continue;
    }
    const at = imgStart + slot * tileBytes;
    if (at + tileBytes > bytes.length) throw new ContentError('corrupt template (tile data outside the file)');
    tiles.push(bytes.slice(at, at + tileBytes));
  }
  return { width, height, tiles };
}

const D2_PALETTE_TABLE = 1;
const D2_NOT_LCW = 2;
const D2_VARIABLE_TABLE = 4;

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Offsets of a Dune 2 layout SHP (count + 1 of them, the last the end of the file), or null (OpenRA ShpD2Loader.IsShpD2). */
function shpD2Offsets(bytes) {
  if (bytes.length < 6) return null;
  const count = u16le(bytes, 0);
  if (count === 0) return null;
  const two = (u32le(bytes, 2) & 0xff0000) > 0;
  const size = two ? 2 : 4;
  const end = 2 + size * count;
  if (end + size > bytes.length) return null;
  const eof = two ? u16le(bytes, end) : u32le(bytes, end);
  if (eof + 2 !== bytes.length) return null;
  const offsets = [];
  for (let i = 0; i <= count; i++) offsets.push((two ? u16le(bytes, 2 + i * size) : u32le(bytes, 2 + i * size)) + 2);
  const first = offsets[0];
  if (first + 2 > bytes.length) return null;
  const flags = u16le(bytes, first);
  return flags === 5 || flags <= 3 ? offsets : null;
}

/** Whether `bytes` look like a Dune 2 layout SHP (Red Alert's mouse.shp). */
export function isShpD2(bytes) {
  return !isShp(bytes) && shpD2Offsets(bytes) !== null;
}

/** OpenRA RLEZerosCompression: 0, n writes n zeros; any other byte is itself. */
function rleZerosDecode(src, dest) {
  let d = 0;
  for (let s = 0; s < src.length; ) {
    const cmd = src[s++];
    if (cmd === 0) {
      if (s >= src.length) throw new ContentError('corrupt RLE data (truncated run)');
      const n = src[s++];
      if (d + n > dest.length) throw new ContentError('corrupt RLE data (runs past the frame)');
      d += n;
    } else {
      if (d >= dest.length) throw new ContentError('corrupt RLE data (runs past the frame)');
      dest[d++] = cmd;
    }
  }
}

/** A Dune 2 layout SHP (OpenRA ShpD2Loader): `{ width, height, frames }`, frames of their own sizes. */
export function decodeShpD2(bytes, limits = SPRITE_LIMITS) {
  if (bytes.length > limits.maxBytes) throw new ContentError('file too large');
  const offsets = shpD2Offsets(bytes);
  if (!offsets) throw new ContentError('not a Dune 2 SHP');
  if (offsets.length - 1 > limits.maxFrames) throw new ContentError('too many frames');
  const frames = [];
  let width = 0;
  let height = 0;
  for (let i = 0; i < offsets.length - 1; i++) {
    let at = offsets[i];
    if (at + 10 > bytes.length) throw new ContentError('corrupt Dune 2 SHP (frame header past the end)');
    const flags = u16le(bytes, at);
    const w = u16le(bytes, at + 3);
    const h = bytes[at + 5];
    let left = u16le(bytes, at + 6) - 10;
    const decodedSize = u16le(bytes, at + 8);
    at += 10;
    if (w > limits.maxSide || h > limits.maxSide) throw new ContentError('frame too large');
    let table = null;
    if (flags & D2_PALETTE_TABLE) {
      const n = flags & D2_VARIABLE_TABLE ? bytes[at++] : 16;
      if (flags & D2_VARIABLE_TABLE) left -= 1;
      if (at + n > bytes.length) throw new ContentError('corrupt Dune 2 SHP (table past the end)');
      table = bytes.slice(at, at + n);
      at += n;
      left -= n;
    } else {
      table = Uint8Array.from({ length: 256 }, (_, k) => k);
      table[1] = 0x7f;
      table[2] = 0x7e;
      table[3] = 0x7d;
      table[4] = 0x7c;
    }
    if (left < 0 || at + left > bytes.length) throw new ContentError('corrupt Dune 2 SHP (data past the end)');
    let packed = bytes.subarray(at, at + left);
    if (!(flags & D2_NOT_LCW)) {
      const temp = new Uint8Array(decodedSize);
      const n = lcwDecode(packed, 0, temp);
      packed = temp.subarray(0, n);
    }
    const data = new Uint8Array(w * h);
    rleZerosDecode(packed, data);
    for (let k = 0; k < data.length; k++) {
      const v = table[data[k]];
      data[k] = v === undefined ? 0 : v;
    }
    frames.push({ width: w, height: h, data });
    width = Math.max(width, w);
    height = Math.max(height, h);
  }
  return { width, height, frames };
}

/**
 * Any sprite file OpenRA's RA mod reads as a sprite (SpriteFormats: ShpTD,
 * TmpRA, TmpTD, ShpD2): `{ width, height, frames: [{ width, height, data } | null] }`.
 * Template tiles become frames (empty slots null), as in OpenRA.
 */
export function decodeSprite(bytes, limits = SPRITE_LIMITS) {
  if (isShp(bytes)) return decodeShp(bytes, limits);
  if (isTmpRa(bytes) || isTmpTd(bytes)) {
    const t = decodeTmp(bytes, limits);
    return { width: t.width, height: t.height, frames: t.tiles.map((data) => (data ? { width: t.width, height: t.height, data } : null)) };
  }
  if (isShpD2(bytes)) return decodeShpD2(bytes, limits);
  throw new ContentError('not a sprite (SHP or TMP)');
}
