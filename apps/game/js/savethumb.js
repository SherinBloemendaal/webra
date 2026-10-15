// The picture of a save in Load game (js/records.js): the game's map as the
// radar draws its terrain (js/minimap.js composeRadar: terrain, ore and gems,
// the whole map, no units), scaled down to a small image data URL that is
// kept with the save in the browser (js/saves.js validThumb).

import { composeRadar } from './minimap.js';
import { THUMB_MAX_CHARS } from './saves.js';

/** The largest thumbnail (CSS px of the Load game rows' 4:3 box, at twice the density). */
export const THUMB_BOX = Object.freeze({ width: 144, height: 108 });

/** Formats tried in turn until one fits THUMB_MAX_CHARS: lossless first. */
export const THUMB_FORMATS = Object.freeze([
  ['image/png', undefined],
  ['image/webp', 0.85],
  ['image/jpeg', 0.8],
  ['image/jpeg', 0.6],
]);

/** The thumbnail's size for a map of `w` x `h` cells: the map's shape inside THUMB_BOX, never larger than the map. */
export function thumbSize(w, h, box = THUMB_BOX) {
  const scale = Math.min(box.width / w, box.height / h, 1);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The first encoding of `canvas` that fits `max` characters, or null (THUMB_FORMATS order). */
export function encodeThumb(canvas, max = THUMB_MAX_CHARS) {
  for (const [type, quality] of THUMB_FORMATS) {
    let url;
    try {
      url = canvas.toDataURL(type, quality);
    } catch {
      return null;
    }
    // A browser without the format answers with PNG: only a URL of the asked type counts.
    if (url.startsWith(`data:${type};`) && url.length <= max) return url;
  }
  return null;
}

/**
 * The thumbnail of a game's map, or null when the browser cannot draw it.
 * @param {{ terrain: Uint8Array, width: number, height: number, biome?: string }} map
 *   the radar's terrain bytes (Minimap.terrain: 4 per cell) and the map's size in cells
 */
export function saveThumbnail({ terrain, width, height, biome = 'temperate' }, doc = globalThis.document) {
  try {
    if (!doc || !terrain || terrain.length !== width * height * 4) return null;
    const full = doc.createElement('canvas');
    full.width = width;
    full.height = height;
    const ctx = full.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(width, height);
    // The whole map: every cell seen, no units.
    composeRadar(image.data, terrain, new Uint8Array(width * height).fill(255), [], [], width, height, biome);
    ctx.putImageData(image, 0, 0);
    const size = thumbSize(width, height);
    const small = doc.createElement('canvas');
    small.width = size.width;
    small.height = size.height;
    const sctx = small.getContext('2d');
    if (!sctx) return null;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(full, 0, 0, size.width, size.height);
    return encodeThumb(small);
  } catch {
    return null;
  }
}
