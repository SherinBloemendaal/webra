// Synthetic Westwood graphics for the content tests: encoders for LCW
// (Format80) and XOR delta (Format40), SHP, PAL and TMP writers, PNG
// headers and small sheets. Every image is made up here; no Red Alert file
// (or anything made from one) is in the repository.
import { deflateSync } from 'node:zlib';
import { crc32 } from '../js/oramap/zip.js';

/** A deterministic random generator (0..1). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * LCW (Format80) encoder: runs of 4+ equal bytes as fills (command 4), long
 * matches against earlier output as absolute copies (commands 3 and 5) and
 * short ones as relative copies (command 2), the rest as literal blocks.
 */
export function lcwEncode(src, { copies = true } = {}) {
  const out = [];
  let lit = [];
  const flush = () => {
    for (let i = 0; i < lit.length; i += 0x3f) {
      const chunk = lit.slice(i, i + 0x3f);
      out.push(0x80 | chunk.length, ...chunk);
    }
    lit = [];
  };
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && run < 0xffff && src[i + run] === src[i]) run++;
    if (run >= 4) {
      flush();
      out.push(0xfe, run & 0xff, run >> 8, src[i]);
      i += run;
      continue;
    }
    if (copies) {
      // Longest earlier match (absolute source offset), only non-overlapping.
      let best = 0;
      let at = -1;
      for (let s = Math.max(0, i - 2000); s < i; s++) {
        let n = 0;
        while (i + n < src.length && s + n < i && src[s + n] === src[i + n] && n < 0xffff) n++;
        if (n > best) {
          best = n;
          at = s;
        }
      }
      if (best >= 3) {
        flush();
        const back = i - at;
        if (best <= 10 && back <= 0xfff) {
          out.push(((best - 3) << 4) | (back >> 8), back & 0xff); // command 2
        } else if (best <= 64) {
          out.push(0xc0 | (best - 3), at & 0xff, at >> 8); // command 3
        } else {
          out.push(0xff, best & 0xff, best >> 8, at & 0xff, at >> 8); // command 5
        }
        i += best;
        continue;
      }
    }
    lit.push(src[i]);
    i++;
  }
  flush();
  out.push(0x80);
  return Uint8Array.from(out);
}

/**
 * XOR delta (Format40) from `prev` to `cur`: skips for unchanged bytes,
 * fills for runs of one XOR value and XOR byte runs, short and long forms.
 */
export function xorDeltaEncode(prev, cur) {
  const out = [];
  const x = cur.map((v, k) => v ^ prev[k]);
  let i = 0;
  while (i < x.length) {
    if (x[i] === 0) {
      let n = 0;
      while (i + n < x.length && x[i + n] === 0 && n < 0x7fff) n++;
      if (n <= 0x7f) out.push(0x80 | n);
      else out.push(0x80, n & 0xff, n >> 8);
      i += n;
      continue;
    }
    let same = 1;
    while (i + same < x.length && x[i + same] === x[i] && same < 0x3fff) same++;
    if (same >= 3) {
      if (same <= 0xff) out.push(0x00, same, x[i]);
      else out.push(0x80, same & 0xff, 0xc0 | (same >> 8), x[i]);
      i += same;
      continue;
    }
    let n = 0;
    while (i + n < x.length && x[i + n] !== 0 && n < 0x3fff) n++;
    if (n <= 0x7f) out.push(n, ...x.slice(i, i + n));
    else out.push(0x80, n & 0xff, 0x80 | (n >> 8), ...x.slice(i, i + n));
    i += n;
  }
  out.push(0x80, 0, 0);
  return Uint8Array.from(out);
}

/**
 * A TD/RA SHP. `frames` are width x height 8-bit images; `formats[i]` is
 * 'lcw' (default), 'prev' (XOR against frame i - 1) or ['ref', k] (XOR
 * against LCW frame k).
 */
export function buildShp(width, height, frames, formats = []) {
  const count = frames.length;
  const headerEnd = 14 + (count + 2) * 8;
  const blobs = frames.map((f, i) => {
    const kind = formats[i] ?? 'lcw';
    if (kind === 'lcw') return lcwEncode(f);
    if (kind === 'prev') return xorDeltaEncode(frames[i - 1], f);
    return xorDeltaEncode(frames[kind[1]], f);
  });
  const offsets = [];
  let at = headerEnd;
  for (const b of blobs) {
    offsets.push(at);
    at += b.length;
  }
  const head = new Uint8Array(headerEnd);
  const v = new DataView(head.buffer);
  v.setUint16(0, count, true);
  v.setUint16(6, width, true);
  v.setUint16(8, height, true);
  for (let i = 0; i < count; i++) {
    const kind = formats[i] ?? 'lcw';
    const fmt = kind === 'lcw' ? 0x80 : kind === 'prev' ? 0x20 : 0x40;
    v.setUint32(14 + i * 8, (offsets[i] & 0xffffff) | (fmt << 24), true);
    if (Array.isArray(kind)) {
      v.setUint16(14 + i * 8 + 4, offsets[kind[1]], true);
      v.setUint16(14 + i * 8 + 6, 0x80, true);
    } else if (kind === 'prev') {
      v.setUint16(14 + i * 8 + 6, 0x48, true);
    }
  }
  // End of file marker, then the all-zero header.
  v.setUint32(14 + count * 8, at, true);
  return concat([head, ...blobs]);
}

/** A width x height test frame: a shape of `color` on 0 with a remap stripe and a shadow pixel. */
export function testFrame(width, height, seed = 1, { remap = true, shadow = true } = {}) {
  const r = rng(seed);
  const f = new Uint8Array(width * height);
  const x0 = 1 + Math.floor(r() * 3);
  const y0 = 1 + Math.floor(r() * 3);
  for (let y = y0; y < height - 2; y++) for (let x = x0; x < width - 2; x++) f[y * width + x] = 16 + ((x * 7 + y * 3 + seed) % 40);
  if (remap) for (let x = x0; x < width - 2; x++) f[y0 * width + x] = 80 + (x % 16);
  if (shadow) f[(height - 1) * width + x0] = 4;
  return f;
}

/** A 6-bit VGA palette: 768 bytes; `fn(i)` gives [r, g, b] in 0..63. */
export function buildPal(fn = (i) => [i % 64, (i * 3) % 64, (i * 7) % 64]) {
  const out = new Uint8Array(768);
  for (let i = 0; i < 256; i++) out.set(fn(i), i * 3);
  return out;
}

/** A Red Alert TMP template: `tiles` are width*height arrays or null (empty slot). */
export function buildTmpRa(width, height, tiles) {
  const present = tiles.filter(Boolean);
  const indexStart = 40;
  const indexEnd = indexStart + tiles.length;
  const imgStart = indexEnd;
  const out = new Uint8Array(imgStart + present.length * width * height);
  const v = new DataView(out.buffer);
  v.setUint16(0, width, true);
  v.setUint16(2, height, true);
  v.setUint32(16, imgStart, true);
  v.setUint32(20, 0, true);
  v.setUint16(26, 0x2c73, true);
  v.setUint32(28, indexEnd, true);
  v.setUint32(36, indexStart, true);
  let k = 0;
  tiles.forEach((t, i) => {
    if (!t) {
      out[indexStart + i] = 255;
      return;
    }
    out[indexStart + i] = k;
    out.set(t, imgStart + k * width * height);
    k++;
  });
  return out;
}

/** A Tiberian Dawn TMP template (desert.mix), same idea. */
export function buildTmpTd(width, height, tiles) {
  const present = tiles.filter(Boolean);
  const indexStart = 32;
  const indexEnd = indexStart + tiles.length;
  const imgStart = indexEnd;
  const out = new Uint8Array(imgStart + present.length * width * height);
  const v = new DataView(out.buffer);
  v.setUint16(0, width, true);
  v.setUint16(2, height, true);
  v.setUint32(12, imgStart, true);
  v.setUint32(16, 0, true);
  v.setUint32(20, 0x0d1affff, true);
  v.setUint32(24, indexEnd, true);
  v.setUint32(28, indexStart, true);
  let k = 0;
  tiles.forEach((t, i) => {
    if (!t) {
      out[indexStart + i] = 255;
      return;
    }
    out[indexStart + i] = k;
    out.set(t, imgStart + k * width * height);
    k++;
  });
  return out;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  const td = new TextEncoder().encode(type);
  out.set(td, 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A real RGBA PNG of `rgba` (width x height). */
export function buildPng(width, height, rgba) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/** A sheet: frames wide x facings high, each frame filled with a colour coding (column, row). */
export function sheetRgba(fw, fh, frames, facings) {
  const w = fw * frames;
  const h = fh * facings;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = Math.floor(x / fw) * 10;
      rgba[o + 1] = Math.floor(y / fh) * 10;
      rgba[o + 2] = 200;
      rgba[o + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

/** Decode the PNGs written by buildPng (RGBA, filter 0 only) as the browser would. */
export async function decodeTestPng(bytes) {
  const { inflateSync } = await import('node:zlib');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint32(16);
  const height = v.getUint32(20);
  let p = 8;
  const idat = [];
  while (p < bytes.length) {
    const len = v.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (type === 'IDAT') idat.push(bytes.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = new Uint8Array(inflateSync(concat(idat)));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  return { width, height, rgba };
}

/** A canvas-free document for buildAtlas: 2D contexts with real pixel arrays and no drawing. */
export function pixelDocument() {
  return {
    createElement: () => {
      const canvas = { width: 0, height: 0 };
      let pixels = null;
      const ctx = new Proxy(
        {
          getImageData: (x, y, w, h) => {
            pixels ??= new Uint8ClampedArray(canvas.width * canvas.height * 4);
            return { data: pixels.slice(0, w * h * 4), width: w, height: h };
          },
          putImageData: (img) => {
            pixels = img.data;
          },
          pixels: () => pixels,
        },
        // Drawing calls do nothing; gradients and patterns are inert objects.
        { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? () => ({ addColorStop() {} }) : undefined), set: () => true },
      );
      canvas.getContext = () => ctx;
      return canvas;
    },
  };
}

// ---- ISO 9660 images ------------------------------------------------------------------

/** A directory record (ECMA-119 9.1) for `name` at block `extent` with `size` bytes. */
function isoRecord(name, extent, size, dir) {
  const nameBytes = typeof name === 'string' ? new TextEncoder().encode(name) : name;
  const len = 33 + nameBytes.length + ((33 + nameBytes.length) % 2);
  const r = new Uint8Array(len);
  const dv = new DataView(r.buffer);
  r[0] = len;
  dv.setUint32(2, extent, true);
  dv.setUint32(6, extent, false);
  dv.setUint32(10, size, true);
  dv.setUint32(14, size, false);
  r[25] = dir ? 2 : 0;
  dv.setUint16(28, 1, true);
  dv.setUint16(30, 1, false);
  r[32] = nameBytes.length;
  r.set(nameBytes, 33);
  return r;
}

/**
 * A synthetic ISO 9660 image: `files` maps paths ("MAIN.MIX",
 * "INSTALL/REDALERT.MIX", at most one directory deep) to bytes. File names
 * get the ";1" version suffix as on real discs. `padTo` grows the image with
 * zeros (to check that readers do not read the whole of it); `fillDirs` adds
 * that many dummy records to the root so it spans more than one sector.
 */
export function buildIso(files, { padTo = 0, fillDirs = 0 } = {}) {
  const SECTOR = 2048;
  const tree = new Map([['', []]]);
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/');
    const dir = parts.length > 1 ? parts[0] : '';
    if (!tree.has(dir)) {
      tree.set(dir, []);
      tree.get('').push({ name: dir, dir: true });
    }
    tree.get(dir).push({ name: `${parts.at(-1)};1`, data });
  }
  for (let i = 0; i < fillDirs; i++) tree.get('').push({ name: `FILLER${String(i).padStart(3, '0')}.TXT;1`, data: new Uint8Array(1) });
  // Directory sizes: records never cross a sector.
  const dirSectors = new Map();
  for (const [dir, entries] of tree) {
    let sectors = 1;
    let used = 34 * 2;
    for (const e of entries) {
      const len = isoRecord(e.name, 0, 0, false).length;
      if (used + len > SECTOR) {
        sectors++;
        used = 0;
      }
      used += len;
    }
    dirSectors.set(dir, sectors);
  }
  let next = 18;
  const dirAt = new Map();
  for (const [dir, n] of dirSectors) {
    dirAt.set(dir, next);
    next += n;
  }
  const fileAt = new Map();
  for (const entries of tree.values()) {
    for (const e of entries) {
      if (e.dir) continue;
      fileAt.set(e, next);
      next += Math.max(1, Math.ceil(e.data.length / SECTOR));
    }
  }
  const size = Math.max(next * SECTOR, padTo);
  const out = new Uint8Array(size);
  // Primary volume descriptor and terminator.
  const pvd = 16 * SECTOR;
  out[pvd] = 1;
  out.set(new TextEncoder().encode('CD001'), pvd + 1);
  out[pvd + 6] = 1;
  new DataView(out.buffer).setUint16(pvd + 128, SECTOR, true);
  new DataView(out.buffer).setUint16(pvd + 130, SECTOR, false);
  out.set(isoRecord(new Uint8Array([0]), dirAt.get(''), dirSectors.get('') * SECTOR, true), pvd + 156);
  out[17 * SECTOR] = 255;
  out.set(new TextEncoder().encode('CD001'), 17 * SECTOR + 1);
  for (const [dir, entries] of tree) {
    const base = dirAt.get(dir) * SECTOR;
    const self = isoRecord(new Uint8Array([0]), dirAt.get(dir), dirSectors.get(dir) * SECTOR, true);
    const parent = isoRecord(new Uint8Array([1]), dirAt.get(''), dirSectors.get('') * SECTOR, true);
    out.set(self, base);
    out.set(parent, base + self.length);
    let o = self.length + parent.length;
    for (const e of entries) {
      const rec = e.dir ? isoRecord(e.name, dirAt.get(e.name), dirSectors.get(e.name) * SECTOR, true) : isoRecord(e.name, fileAt.get(e), e.data.length, false);
      if ((o % SECTOR) + rec.length > SECTOR) o = (Math.floor(o / SECTOR) + 1) * SECTOR;
      out.set(rec, base + o);
      o += rec.length;
    }
  }
  for (const [e, at] of fileAt) out.set(e.data, at * SECTOR);
  return out;
}

// ---- VQA movies ---------------------------------------------------------------------

/** A VQA chunk: tag, big-endian size, the data (byte arrays or chunks), a zero pad byte to an even length. */
export function vqaChunk(tag, ...parts) {
  const data = concat(parts);
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, data.length, false);
  out.set(data, 8);
  return out;
}

/**
 * A VQA movie (version 2 unless told otherwise): the FORM/WVQA header, VQHD,
 * the FINF frame index and the frames, each a list of chunks (vqaChunk).
 * `extraHeader` chunks go between VQHD and FINF; `keyFrames` sets bit 30 in
 * the index entries of those frames, as Westwood's files do.
 */
export function buildVqa({
  width = 8,
  height = 4,
  blockWidth = 4,
  blockHeight = 2,
  frameRate = 15,
  cbParts = 2,
  version = 2,
  flags = 0,
  colors = 256,
  sampleRate = 22050,
  channels = 1,
  bits = 16,
  frames,
  extraHeader = [],
  keyFrames = [0],
}) {
  const header = new Uint8Array(42);
  const h = new DataView(header.buffer);
  h.setUint16(0, version, true);
  h.setUint16(2, flags, true);
  h.setUint16(4, frames.length, true);
  h.setUint16(6, width, true);
  h.setUint16(8, height, true);
  header[10] = blockWidth;
  header[11] = blockHeight;
  header[12] = frameRate;
  header[13] = cbParts;
  h.setUint16(14, colors, true);
  h.setUint16(24, sampleRate, true);
  header[26] = channels;
  header[27] = bits;
  const vqhd = vqaChunk('VQHD', header);
  const extra = concat(extraHeader);
  const index = new Uint8Array(frames.length * 4);
  const finfAt = 12 + vqhd.length + extra.length;
  let at = finfAt + 8 + index.length;
  const bodies = frames.map((chunks, i) => {
    const body = concat(chunks);
    new DataView(index.buffer).setUint32(i * 4, (at / 2) | (keyFrames.includes(i) ? 0x40000000 : 0), true);
    at += body.length;
    return body;
  });
  const finf = vqaChunk('FINF', index);
  const rest = concat([vqhd, extra, finf, ...bodies]);
  const out = new Uint8Array(12 + rest.length);
  out.set([0x46, 0x4f, 0x52, 0x4d], 0); // FORM
  new DataView(out.buffer).setUint32(4, rest.length + 4, false);
  out.set([0x57, 0x56, 0x51, 0x41], 8); // WVQA
  out.set(rest, 12);
  return out;
}
