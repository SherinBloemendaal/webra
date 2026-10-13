// Build button pictures ("cameos") for the sidebar. One place decides where
// the picture comes from:
//
// - the cameo art, `getCameo(typeName, size, opts)` from sprites.js (a cached
//   canvas with the framed 3/4 view picture), for every type that has art;
// - for a type without cameo art (getCameo returns null), the sprite icon
//   (drawIcon) scaled into the button on a dark steel backdrop;
// - before both, the player's content (js/content: a texture pack's cameo or
//   the original cameo from their own Red Alert files), set with setCameoArt.

import { drawIcon, getCameo } from './sprites.js';
import { drawPowerIcon } from './art/powericons.js';

/** Cameo pictures from installed content, or null: `(typeName, width, height) => canvas | null`. */
let contentArt = null;

/** Use cameos from installed content (js/content/cameos.js cameoSource), or null for WebRA's own. */
export function setCameoArt(fn) {
  contentArt = fn;
}

/** The cameo picture for a type: installed content first, then WebRA's cameo art. */
export function cameoArt(typeName, size, opts = {}) {
  return contentArt?.(typeName, size, opts.height ?? size) ?? getCameo(typeName, size, opts);
}

/**
 * Paint the backdrop of the sprite fallback: a dark steel gradient with a
 * faint horizon, so the sprite sits on a picture like the other cameos.
 * @param {CanvasRenderingContext2D} ctx
 */
export function paintBackdrop(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#2b333d');
  g.addColorStop(0.55, '#1a2027');
  g.addColorStop(1, '#0f1317');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fillRect(0, Math.round(h * 0.62), w, 1);
}

/**
 * Backing store size (device pixels) of a cameo canvas shown at `cssWidth`
 * x `cssHeight` CSS pixels on a screen with this pixel ratio (1 to 3).
 */
export function cameoBacking(cssWidth, cssHeight, pixelRatio) {
  const dpr = Number.isFinite(pixelRatio) && pixelRatio > 0 ? Math.min(3, Math.max(1, pixelRatio)) : 1;
  return { width: Math.max(1, Math.round(cssWidth * dpr)), height: Math.max(1, Math.round(cssHeight * dpr)) };
}

/**
 * A cameo painter. `art`, `fallback` and `backdrop` are injectable so the
 * choice is unit tested without a canvas (tests/cameo.test.mjs).
 *
 * @param {object} [o]
 * @param {(typeName: string, size: number, opts: {team?: number[], kind?: string, height?: number}) => CanvasImageSource | null} [o.art]
 *   cached cameo picture, or null when the type has no cameo art
 * @param {(canvas: HTMLCanvasElement, actor: object, teamRgb: number[]) => void} [o.fallback] sprite icon painter
 * @param {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} [o.backdrop]
 * @returns {{ paint(canvas: HTMLCanvasElement, actor: object, teamRgb: number[]): 'art' | 'labelled' | 'sprite' }}
 *   'labelled' when the picture has the name in it (Red Alert's own cameos), 'art' for other cameo art
 */
export function createCameoPainter({ art = cameoArt, fallback = drawIcon, backdrop = paintBackdrop } = {}) {
  return {
    paint(canvas, actor, teamRgb) {
      // A mission's own actor uses the art of its art key (engine rules_json `art`).
      const picture = art(actor.art ?? actor.id, canvas.width, { team: teamRgb, kind: actor.kind, height: canvas.height });
      const ctx = canvas.getContext('2d');
      if (picture) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
        return picture.labelled ? 'labelled' : 'art';
      }
      // drawIcon clears the canvas, so it draws first and the backdrop goes
      // underneath with destination-over.
      fallback(canvas, actor, teamRgb);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      backdrop(ctx, canvas.width, canvas.height);
      ctx.restore();
      return 'sprite';
    },
  };
}

/** The painter the sidebar uses. */
export const cameoPainter = createCameoPainter();

const powerIconCache = new Map();

/**
 * The picture of a support power icon (SupportPowerInfo.Icon, rules
 * `icon`), for the observer's support power panel: installed content first
 * (the cameo source answers `icon:<name>`, js/content/cameos.js), then
 * WebRA's own (art/powericons.js), cached per size.
 */
export function powerIconArt(icon, width, height) {
  const content = contentArt?.(`icon:${icon}`, width, height);
  if (content) return content;
  const key = `${icon}|${width}x${height}`;
  let canvas = powerIconCache.get(key);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    drawPowerIcon(canvas.getContext('2d'), icon, width, height);
    powerIconCache.set(key, canvas);
  }
  return canvas;
}
