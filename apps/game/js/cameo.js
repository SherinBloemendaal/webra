// Build button pictures ("cameos") for the sidebar. One place decides where
// the picture comes from:
//
// - the cameo art of js/art, `drawCameo(ctx, typeName, size)`, once it exists;
// - until then, the existing sprite art (sprites.js drawIcon) scaled into the
//   button, on the cameo's metal backdrop.
//
// Switching to the new art is one line: replace the `cameoArt` line below
// with `import { drawCameo as cameoArt } from './art/<module>.js';`.

import { drawIcon } from './sprites.js';

const cameoArt = null;

/**
 * Paint the backdrop every cameo shares: a dark steel gradient with a faint
 * horizon, so sprite art (which has no background of its own) sits on a
 * picture like the 1996 build icons instead of on a flat colour.
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
 * A painter for one canvas size. `art` and `fallback` are injectable so the
 * choice is unit tested without a canvas (tests/cameo.test.mjs).
 *
 * @param {object} [o]
 * @param {((ctx: CanvasRenderingContext2D, typeName: string, size: number) => void) | null} [o.art] js/art drawCameo
 * @param {(canvas: HTMLCanvasElement, actor: object, teamRgb: number[]) => void} [o.fallback] sprite icon painter
 * @param {(ctx: CanvasRenderingContext2D, w: number, h: number) => void} [o.backdrop]
 * @returns {{ source: 'art' | 'sprite', paint(canvas: HTMLCanvasElement, actor: object, teamRgb: number[]): void }}
 */
export function createCameoPainter({ art = cameoArt, fallback = drawIcon, backdrop = paintBackdrop } = {}) {
  if (typeof art === 'function') {
    return {
      source: 'art',
      paint(canvas, actor) {
        const ctx = canvas.getContext('2d');
        const size = Math.min(canvas.width, canvas.height);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        // Centre the square picture when the canvas is not square.
        ctx.translate(Math.round((canvas.width - size) / 2), Math.round((canvas.height - size) / 2));
        art(ctx, actor.id, size);
        ctx.restore();
      },
    };
  }
  return {
    source: 'sprite',
    paint(canvas, actor, teamRgb) {
      // drawIcon clears the canvas, so it draws first and the backdrop goes
      // underneath with destination-over.
      fallback(canvas, actor, teamRgb);
      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      backdrop(ctx, canvas.width, canvas.height);
      ctx.restore();
    },
  };
}

/** The painter the sidebar uses. */
export const cameoPainter = createCameoPainter();
