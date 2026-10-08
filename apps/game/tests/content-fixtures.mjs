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
