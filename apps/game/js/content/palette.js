// Red Alert palettes (.pal): 256 colours of three 6-bit VGA components. As in
// OpenRA (ImmutablePalette, mods/ra/rules/palettes.yaml):
// - each component c becomes (c << 2) | (c >> 4) in 8 bits;
// - index 0 is transparent;
// - the shadow indices are drawn as black at alpha 140 (actors: index 4,
//   terrain: indices 3 and 4);
// - indices 80 to 95 are the remap range: the team colour. WebRA keeps its
//   own team colouring: remap pixels go into the atlas as a grey level (the
//   ramp's brightness) with the team mask set, and the sprite shader tints
//   them like the team areas of WebRA's own art (shaders/sprite.wgsl).

import { ContentError } from './shp.js';

export const PALETTE_BYTES = 768;
export const TRANSPARENT_INDEX = 0;
export const SHADOW_ALPHA = 140;
/** Shadow indices of the "player" and "effect" palettes. */
export const ACTOR_SHADOW = Object.freeze([4]);
/** Shadow indices of the "terrain" palettes. */
export const TERRAIN_SHADOW = Object.freeze([3, 4]);
/** The remap (team colour) range of Red Alert, inclusive (OpenRA PlayerColorPalette RemapIndex). */
export const REMAP_START = 80;
export const REMAP_END = 95;

/** Decode a .pal file to 8-bit RGB (Uint8Array of 768). */
export function decodePalette(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < PALETTE_BYTES) throw new ContentError('not a palette (too short)');
  const out = new Uint8Array(PALETTE_BYTES);
  for (let i = 0; i < PALETTE_BYTES; i++) {
    const v = bytes[i];
    if (v > 63) throw new ContentError('not a palette (component above 63)');
    out[i] = (v << 2) | (v >> 4);
  }
  return out;
}

export const isRemap = (index) => index >= REMAP_START && index <= REMAP_END;

/**
 * Colour and team-mask lookup of a palette, RGBA per index:
 * `{ color: Uint8Array(1024), mask: Uint8Array(256) }`. With `remap`, the
 * remap range becomes grey levels with mask 255 (the shader tints them);
 * `shadow` lists the indices drawn as translucent black.
 */
export function paletteLookup(rgb, { remap = true, shadow = ACTOR_SHADOW } = {}) {
  const color = new Uint8Array(256 * 4);
  const mask = new Uint8Array(256);
  const lum = (i) => (0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) / 255;
  let top = 0;
  for (let i = REMAP_START; i <= REMAP_END; i++) top = Math.max(top, lum(i));
  for (let i = 0; i < 256; i++) {
    const o = i * 4;
    if (i === TRANSPARENT_INDEX) continue;
    if (shadow.includes(i)) {
      color[o + 3] = SHADOW_ALPHA;
      continue;
    }
    if (remap && isRemap(i)) {
      // The ramp's own shading, brightest at 0.9 (shaders/sprite.wgsl: team * (0.35 + grey * 1.05)).
      const g = Math.round(Math.min(1, top > 0 ? (lum(i) / top) * 0.9 : 0.5) * 255);
      color[o] = color[o + 1] = color[o + 2] = g;
      color[o + 3] = 255;
      mask[i] = 255;
      continue;
    }
    color[o] = rgb[i * 3];
    color[o + 1] = rgb[i * 3 + 1];
    color[o + 2] = rgb[i * 3 + 2];
    color[o + 3] = 255;
  }
  return { color, mask };
}

/**
 * Paint 8-bit pixels into RGBA buffers through a lookup: `color` and `mask`
 * are RGBA images of `stride` pixels per row; (x, y) is where the
 * width x height block goes.
 */
export function blitIndexed(px, width, height, lookup, color, mask, stride, x, y) {
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const v = px[j * width + i];
      if (v === TRANSPARENT_INDEX) continue;
      const o = ((y + j) * stride + x + i) * 4;
      const c = v * 4;
      color[o] = lookup.color[c];
      color[o + 1] = lookup.color[c + 1];
      color[o + 2] = lookup.color[c + 2];
      color[o + 3] = lookup.color[c + 3];
      if (mask) {
        const m = lookup.mask[v];
        mask[o] = mask[o + 1] = mask[o + 2] = m;
        mask[o + 3] = 255;
      }
    }
  }
}
