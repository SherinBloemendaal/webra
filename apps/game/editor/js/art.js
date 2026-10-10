// The editor's art: the same sprite atlas, terrain tiles and cameos as a game
// on the map (js/gameart.js, js/content). With the original Red Alert
// graphics installed and chosen (the Graphics setting, registry
// game.graphics, shared with the game) the map, the palette and the previews
// show them; otherwise, or for what they lack, WebRA's own art.
//
// Palette pictures, in order: a cameo from installed content (a texture
// pack's, or the original "icon" sequence); for an actor the original
// graphics draw without a cameo (trees, civilians, decorations), its
// original sprite from the atlas; then WebRA's cameo art, then its sprite
// icon (js/cameo.js, js/sprites.js drawIcon).

import { ContentSystem, GRAPHICS_SETTING } from '../../js/content/index.js';
import { applyGameArt, buildGameAtlas } from '../../js/gameart.js';
import { createCameoPainter, paintBackdrop } from '../../js/cameo.js';
import { FRAME_FLOATS, drawIcon, getCameo } from '../../js/sprites.js';
import { POSE, facingFrame } from '../../js/content/sequences.js';

/** The facing palette pictures of units show (OpenRA's editor previews face south-west too). */
export const PREVIEW_FACING = 384;

/**
 * The atlas frame the sprite shader draws for sprite slot `slot` in pose
 * `pose` at `radians` (shaders/sprite.wgsl, first animation frame): a
 * sequence slot's facing frame, a WebRA animation's first frame, or the slot.
 * Returns { index, rotation } (rotation: radians still applied to the frame).
 */
export function slotFrame(frames, slot, pose = POSE.IDLE, radians = 0) {
  const at = (i) => frames.subarray(i * FRAME_FLOATS, (i + 1) * FRAME_FLOATS);
  const head = at(slot);
  if (head[13] > 0.5) {
    const base = head[12];
    const d = at(base + Math.min(pose, head[13] - 1));
    const length = Math.max(1, d[9]);
    const desc = { facings: Math.max(1, d[12]), classic: (d[13] & 1) !== 0, rotate: (d[13] & 2) !== 0, interpolatedFacings: d[14] };
    const { facing, rotation } = facingFrame(radians, desc);
    return { index: d[8] + facing * length, rotation };
  }
  if (head[9] > 1.5) return { index: head[8], rotation: radians };
  return { index: slot, rotation: radians };
}

/**
 * Paint atlas frame `index` into `ctx` (w x h), scaled to fit and centred,
 * in the team colour `teamRgb` the way the sprite shader does (team areas
 * are grey in the colour atlas; the mask says where). `pixels` is
 * `{ width, height, color, mask }` with RGBA arrays of the atlas canvases.
 * Returns false when the frame is empty.
 */
export function paintAtlasFrame(ctx, w, h, pixels, frames, index, teamRgb) {
  const f = frames.subarray(index * FRAME_FLOATS, (index + 1) * FRAME_FLOATS);
  const x0 = Math.round(f[0] * pixels.width);
  const y0 = Math.round(f[1] * pixels.height);
  const x1 = Math.round(f[2] * pixels.width);
  const y1 = Math.round(f[3] * pixels.height);
  const sw = x1 - x0;
  const sh = y1 - y0;
  if (sw <= 0 || sh <= 0) return false;
  const scale = Math.min(w / sw, h / sh) * 0.9;
  const dw = Math.max(1, Math.floor(sw * scale));
  const dh = Math.max(1, Math.floor(sh * scale));
  const ox = Math.floor((w - dw) / 2);
  const oy = Math.floor((h - dh) / 2);
  const img = ctx.getImageData(0, 0, w, h);
  const out = img.data;
  for (let y = 0; y < dh; y++) {
    const sy = y0 + Math.min(sh - 1, Math.floor(y / scale));
    for (let x = 0; x < dw; x++) {
      const sx = x0 + Math.min(sw - 1, Math.floor(x / scale));
      const s = (sy * pixels.width + sx) * 4;
      const a = pixels.color[s + 3];
      if (a === 0) continue;
      const m = pixels.mask[s] / 255;
      const o = ((oy + y) * w + ox + x) * 4;
      for (let c = 0; c < 3; c++) {
        const base = pixels.color[s + c] / 255;
        const team = teamRgb[c] * (0.35 + (pixels.color[s] / 255) * 1.05);
        const v = base + (team - base) * m;
        // Over what is there (the backdrop), by the sprite's alpha.
        out[o + c] = Math.round(Math.min(1, v) * a + out[o + c] * (1 - a / 255));
      }
      out[o + 3] = Math.max(out[o + 3], a);
    }
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

export class EditorArt {
  /**
   * @param {object} o
   * @param {{ get(k: string): any, set(k: string, v: any): any, subscribe(k: string, fn: Function): Function }} o.settings
   * @param {ContentSystem | null} [o.content] installed content (made here when left out; null: WebRA art only)
   */
  constructor({ settings, content }) {
    this.settings = settings;
    if (content === undefined) {
      try {
        content = new ContentSystem({ settings });
      } catch (err) {
        console.warn('Original content and texture packs are unavailable:', err);
        content = null;
      }
    }
    this.content = content;
    this.listeners = new Set();
    this.atlas = null;
    this.original = null;
    this.pixels = null;
    this.cameos = null;
    this.content?.onChange(() => this.changed());
  }

  /** Read the installed content (never rejects; WebRA art until it is in). */
  async load() {
    try {
      await this.content?.load();
    } catch (err) {
      console.warn('Installed content is unavailable:', err);
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    this.cameos = this.content?.cameos() ?? null;
    for (const fn of this.listeners) fn();
  }

  /** 'webra' or 'original' (the game's Graphics setting). */
  get graphics() {
    return this.settings.get(GRAPHICS_SETTING) === 'original' ? 'original' : 'webra';
  }

  set graphics(v) {
    this.settings.set(GRAPHICS_SETTING, v === 'original' ? 'original' : 'webra');
  }

  /** Whether the original graphics are installed on this device. */
  get hasOriginal() {
    return !!this.content?.hasOriginalGraphics;
  }

  /** Whether the map is drawn with the original graphics now. */
  get originalActive() {
    return !!this.content?.originalActive;
  }

  /**
   * Build the atlas for `actors` (js/gameart.js artActors) on `biome`, as a
   * game does. Keeps it for the palette pictures.
   */
  build(actors, biome, maxSize) {
    const { atlas, original } = buildGameAtlas(this.content, actors, biome, maxSize);
    this.atlas = atlas;
    this.original = original;
    this.pixels = null;
    this.actors = actors;
    this.cameos = this.content?.cameos() ?? null;
    return { atlas, original };
  }

  /** Apply the current atlas's engine settings to a preview game (js/gameart.js). */
  applyTo(game) {
    if (this.atlas) applyGameArt(game, this.atlas, this.original);
  }

  /** Tile terrain from installed content for engine terrain bytes, or null for WebRA's tiles. */
  terrain(biome, bytes, w, h) {
    return this.content?.terrain(biome, bytes, w, h) ?? null;
  }

  /** Whether actor type index `t` has its body drawn from the original graphics. */
  originalBody(t) {
    const slots = this.original?.slots;
    if (!slots) return false;
    const body = 2 * t;
    let lo = 0;
    let hi = slots.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (slots[mid] === body) return true;
      if (slots[mid] < body) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /** RGBA of the atlas canvases (read once per atlas). */
  atlasPixels() {
    if (!this.pixels && this.atlas) {
      const read = (canvas) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      this.pixels = { width: this.atlas.width, height: this.atlas.height, color: read(this.atlas.color), mask: read(this.atlas.mask) };
    }
    return this.pixels;
  }

  /**
   * Paint the palette picture of actor `actor` (type index `t`) in
   * `teamRgb` into `canvas`. Returns where it came from: 'content' (an
   * installed cameo), 'original' (the original sprite), 'art' (WebRA's
   * cameo) or 'sprite' (WebRA's sprite icon).
   */
  paintPalette(canvas, actor, t, teamRgb) {
    const id = actor.art ?? actor.id;
    const ctx = canvas.getContext('2d');
    const installed = this.cameos?.(id, canvas.width, canvas.height) ?? null;
    if (installed) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(installed, 0, 0, canvas.width, canvas.height);
      return 'content';
    }
    if (t >= 0 && this.originalBody(t)) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paintBackdrop(ctx, canvas.width, canvas.height);
      const radians = actor.kind === 'building' ? 0 : (PREVIEW_FACING * Math.PI * 2) / 1024;
      const { index } = slotFrame(this.atlas.frames, 2 * t, POSE.IDLE, radians);
      if (paintAtlasFrame(ctx, canvas.width, canvas.height, this.atlasPixels(), this.atlas.frames, index, teamRgb)) return 'original';
    }
    return createCameoPainter({ art: (type, size, opts) => getCameo(type, size, opts), fallback: drawIcon }).paint(canvas, actor, teamRgb);
  }
}
