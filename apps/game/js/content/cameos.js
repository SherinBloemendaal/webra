// Sidebar cameos from installed original graphics (the "icon" sequences,
// hires.mix) and texture packs. js/cameo.js asks `cameoArt` first and falls
// back to WebRA's own cameo art when it returns null.

import { ACTOR_ART, ACTOR_PALETTE, SEQUENCES } from './tables.js';
import { decodeSprite } from './shp.js';
import { decodePalette, paletteLookup } from './palette.js';
import { paintFakeMark } from '../art/cameo.js';

/** Cameo source names of support power icons: `icon:<SupportPowerInfo.Icon>`. */
export const POWER_ICON_PREFIX = 'icon:';

/**
 * RGBA pixels of an actor's original cameo: `{ width, height, rgba, labelled,
 * fake }` or null. Cameos keep their own colours (OpenRA draws them with the
 * chrome palette, no team remap). Red Alert's cameos have the name in the
 * picture (`labelled`), so the sidebar leaves out its own label. `fake`: a
 * fake structure Red Alert has no fake cameo for (ACTOR_ART fakeMark, the
 * ones OpenRA drew itself), shown as the real cameo with WebRA's FAKE mark.
 */
export function originalCameoPixels(actorId, getFile) {
  const id = String(actorId);
  // Support power icons (js/cameo.js powerIconArt): OpenRA's "icon" image.
  if (id.startsWith(POWER_ICON_PREFIX)) return originalPowerIconPixels(id.slice(POWER_ICON_PREFIX.length), getFile);
  const entry = ACTOR_ART[id] ?? ACTOR_ART[id.toUpperCase()];
  if (!entry?.cameo) return null;
  const pic = iconPixels(SEQUENCES[entry.image]?.[entry.cameo], getFile);
  if (pic && entry.fakeMark) pic.fake = true;
  return pic;
}

/**
 * RGBA pixels of a support power's original icon (SupportPowerInfo.Icon, a
 * sequence of OpenRA's "icon" image, hires.mix), like `originalCameoPixels`.
 */
export function originalPowerIconPixels(icon, getFile) {
  return iconPixels(SEQUENCES.icon?.[String(icon)], getFile);
}

function iconPixels(def, getFile) {
  if (!def) return null;
  const pal = getFile(ACTOR_PALETTE);
  const bytes = def && getFile(def.file);
  if (!pal || !bytes) return null;
  try {
    const lookup = paletteLookup(decodePalette(pal), { remap: false, shadow: [] });
    const sprite = decodeSprite(bytes);
    const frame = sprite.frames[def.start ?? 0];
    if (!frame || !frame.width) return null;
    const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
    for (let i = 0; i < frame.data.length; i++) {
      const v = frame.data[i];
      rgba.set(lookup.color.subarray(v * 4, v * 4 + 4), i * 4);
      // Cameos are opaque pictures: index 0 is black there, not a hole.
      if (v === 0) rgba[i * 4 + 3] = 255;
    }
    return { width: frame.width, height: frame.height, rgba, labelled: true };
  } catch {
    return null;
  }
}

/**
 * A cameo source for js/cameo.js: `(typeName, width, height) => canvas | null`.
 * `sources` are tried in order: each `(typeName) => { width, height, rgba }
 * | ImageBitmap-like { width, height, image } | null`, with `labelled` when the
 * picture shows the name and `fake` when it needs the FAKE mark (drawn over
 * it at the button's size, art/cameo.js paintFakeMark). Pictures are scaled
 * to the button with nearest-neighbour sampling and cached per size; the
 * canvas carries `labelled` on to js/cameo.js.
 */
export function cameoSource(sources, doc = globalThis.document) {
  const cache = new Map();
  return (typeName, width, height) => {
    const key = `${typeName}|${width}x${height}`;
    if (cache.has(key)) return cache.get(key);
    let canvas = null;
    for (const source of sources) {
      const pic = source(typeName);
      if (!pic) continue;
      const src = doc.createElement('canvas');
      src.width = pic.width;
      src.height = pic.height;
      const sctx = src.getContext('2d');
      if (pic.rgba) sctx.putImageData(new ImageData(pic.rgba, pic.width, pic.height), 0, 0);
      else sctx.drawImage(pic.image, 0, 0);
      canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      // Fit inside the button, keeping the picture's shape.
      const scale = Math.min(width / pic.width, height / pic.height);
      const w = Math.round(pic.width * scale);
      const h = Math.round(pic.height * scale);
      ctx.drawImage(src, Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h);
      if (pic.fake) paintFakeMark(ctx, width, height);
      canvas.labelled = !!pic.labelled;
      break;
    }
    cache.set(key, canvas);
    return canvas;
  };
}
