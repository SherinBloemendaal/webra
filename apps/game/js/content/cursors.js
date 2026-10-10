// Mouse cursors from the installed original graphics (Red Alert's mouse.shp,
// a Dune 2 layout SHP in hires.mix), cut the way OpenRA's CursorManager does
// (mods/ra/cursors.yaml: content/tables.js CURSOR_ART). js/cursors.js
// shows them for every cursor kind whose OpenRA cursor name they have; the
// rest keep WebRA's own cursors.

import { ACTOR_PALETTE, CURSOR_ART } from './tables.js';
import { decodeSprite } from './shp.js';
import { decodePalette, paletteLookup } from './palette.js';

/**
 * OpenRA's CursorManager steps an animated cursor every two ticks of 40 ms
 * (`++ticks > 2`): 12.5 frames per second.
 */
export const CURSOR_FPS = 12.5;

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes, from, to) {
  let c = -1;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A PNG file of RGBA pixels, written without compression (zlib stored
 * blocks), so it needs no canvas: cursors are tiny.
 */
export function encodePng(width, height, rgba) {
  const rowBytes = width * 4 + 1;
  const raw = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * rowBytes + 1);
  // zlib: header, stored blocks of at most 65535 bytes, Adler-32.
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlib = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let z = 0;
  zlib[z++] = 0x78;
  zlib[z++] = 0x01;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, raw.length - start);
    zlib[z++] = b === blocks - 1 ? 1 : 0;
    zlib[z++] = len & 255;
    zlib[z++] = len >> 8;
    zlib[z++] = ~len & 255;
    zlib[z++] = (~len >> 8) & 255;
    zlib.set(raw.subarray(start, start + len), z);
    z += len;
  }
  let a = 1;
  let s = 0;
  for (const v of raw) {
    a = (a + v) % 65521;
    s = (s + a) % 65521;
  }
  for (const v of [s >> 8, s & 255, a >> 8, a & 255]) zlib[z++] = v;
  const chunks = [];
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
    chunks.push(out);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  chunk('IHDR', ihdr);
  chunk('IDAT', zlib.subarray(0, z));
  chunk('IEND', new Uint8Array(0));
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const png = new Uint8Array(total);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8;
  for (const c of chunks) {
    png.set(c, at);
    at += c.length;
  }
  return png;
}

/** A PNG data URL. */
export function pngDataUrl(width, height, rgba) {
  const png = encodePng(width, height, rgba);
  let bin = '';
  for (const b of png) bin += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(bin)}`;
}

/**
 * The original cursors: OpenRA cursor name -> { frames: [{ width, height,
 * rgba, hotspot: [x, y] }], fps } for every cursor of CURSOR_ART whose file
 * is installed. The hotspot is OpenRA's: the frame centre plus the
 * cursor's X and Y, kept inside the frame (CSS needs that).
 */
export function originalCursorFrames(getFile) {
  const out = new Map();
  const pal = getFile(ACTOR_PALETTE);
  if (!pal) return out;
  let lookup;
  try {
    // The "cursor" palette: temperat.pal without player colours or shadow.
    lookup = paletteLookup(decodePalette(pal), { remap: false, shadow: [] });
  } catch {
    return out;
  }
  const files = new Map();
  const sprite = (name) => {
    if (!files.has(name)) {
      let s = null;
      try {
        const bytes = getFile(name);
        s = bytes ? decodeSprite(bytes) : null;
      } catch {
        s = null;
      }
      files.set(name, s);
    }
    return files.get(name);
  };
  for (const [name, c] of Object.entries(CURSOR_ART)) {
    const s = sprite(c.file);
    if (!s || c.start + c.length > s.frames.length) continue;
    const frames = [];
    for (let k = c.start; k < c.start + c.length; k++) {
      const f = s.frames[k];
      if (!f || !f.width || !f.height) continue;
      const rgba = new Uint8ClampedArray(f.width * f.height * 4);
      for (let i = 0; i < f.data.length; i++) {
        const v = f.data[i];
        if (v) rgba.set(lookup.color.subarray(v * 4, v * 4 + 4), i * 4);
      }
      const hx = Math.min(f.width - 1, Math.max(0, Math.floor(f.width / 2) + c.hotspot[0]));
      const hy = Math.min(f.height - 1, Math.max(0, Math.floor(f.height / 2) + c.hotspot[1]));
      frames.push({ width: f.width, height: f.height, rgba, hotspot: [hx, hy] });
    }
    if (frames.length) out.set(name, { frames, fps: CURSOR_FPS });
  }
  return out;
}

/**
 * The original cursors as CSS cursor values for js/cursors.js
 * setCursorArt: OpenRA cursor name -> { frames: [css], fps }.
 */
export function originalCursors(getFile) {
  const out = new Map();
  for (const [name, c] of originalCursorFrames(getFile)) {
    out.set(name, {
      fps: c.fps,
      frames: c.frames.map((f) => `url("${pngDataUrl(f.width, f.height, f.rgba)}") ${f.hotspot[0]} ${f.hotspot[1]}, auto`),
    });
  }
  return out;
}
