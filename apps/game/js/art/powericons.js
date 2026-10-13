// Support power icons (WebRA's own art): the pictures of the observer's
// support power panel (OpenRA ObserverSupportPowerIcons draws each power's
// SupportPowerInfo.Icon). One emblem per Red Alert icon name, on the cameo
// backdrop and frame of art/cameo.js. Players with the original graphics
// see Red Alert's own icons instead (js/content/cameos.js).

import { cameoInner, paintCameoBackdrop, paintCameoFrame } from './cameo.js';
import { circle, poly } from './kit.js';

function stroke(ctx, color, width, draw) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  draw();
  ctx.stroke();
}

function glow(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** A parachute canopy over (x, y) with its lines down to (x, ly). */
function canopy(ctx, x, y, r, ly, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, Math.PI, 0);
  ctx.quadraticCurveTo(x + r * 0.5, y - r * 0.18, x, y);
  ctx.quadraticCurveTo(x - r * 0.5, y - r * 0.18, x - r, y);
  ctx.fill();
  stroke(ctx, 'rgba(230,230,210,0.8)', 1.2, () => {
    for (const dx of [-r, -r * 0.35, r * 0.35, r]) {
      ctx.moveTo(x + dx, y);
      ctx.lineTo(x, ly);
    }
  });
}

/** The emblems, drawn in a 100 x 75 box. */
const EMBLEMS = {
  // Atom bomb: a mushroom cloud over the horizon.
  abomb(ctx) {
    glow(ctx, 50, 40, 42, 'rgba(255,170,60,0.55)');
    poly(ctx, '#c9772b', [44, 66, 56, 66, 54, 40, 46, 40]);
    circle(ctx, '#e8963a', 50, 30, 18);
    circle(ctx, '#f2b84e', 38, 33, 11);
    circle(ctx, '#f2b84e', 62, 33, 11);
    circle(ctx, '#ffe39a', 50, 26, 10);
    circle(ctx, '#e8963a', 50, 46, 8);
    poly(ctx, '#3a2a1c', [0, 75, 0, 66, 30, 62, 70, 62, 100, 66, 100, 75]);
  },
  // Iron Curtain: a red shield with a hammered bar.
  invuln(ctx) {
    glow(ctx, 50, 38, 40, 'rgba(220,40,30,0.5)');
    poly(ctx, '#7e1510', [50, 8, 78, 18, 74, 46, 50, 68, 26, 46, 22, 18]);
    poly(ctx, '#c62a1e', [50, 13, 72, 21, 69, 44, 50, 62, 31, 44, 28, 21]);
    poly(ctx, '#ff6a4a', [50, 13, 72, 21, 50, 28, 28, 21]);
    poly(ctx, '#3a0806', [34, 33, 66, 33, 66, 39, 34, 39]);
  },
  // Chronosphere: a blue vortex with a clock hand.
  chrono(ctx) {
    glow(ctx, 50, 38, 40, 'rgba(80,170,255,0.55)');
    for (const [r, c] of [
      [30, '#2a6fb8'],
      [22, '#4a95e0'],
      [14, '#8cc8ff'],
    ]) {
      stroke(ctx, c, 4, () => ctx.ellipse(50, 38, r, r * 0.72, -0.35, 0.3, Math.PI * 1.75));
    }
    circle(ctx, '#e8f6ff', 50, 38, 5);
    stroke(ctx, '#e8f6ff', 3, () => {
      ctx.moveTo(50, 38);
      ctx.lineTo(50, 22);
      ctx.moveTo(50, 38);
      ctx.lineTo(61, 44);
    });
  },
  // Spy plane: a dark jet over a lens.
  spyplane(ctx) {
    circle(ctx, '#1d4b5c', 50, 44, 20);
    circle(ctx, '#3fa7c4', 50, 44, 12);
    circle(ctx, '#d8f6ff', 46, 40, 4);
    poly(ctx, '#2b2f33', [50, 6, 55, 22, 86, 34, 86, 39, 55, 34, 53, 52, 62, 58, 62, 62, 50, 59, 38, 62, 38, 58, 47, 52, 45, 34, 14, 39, 14, 34, 45, 22]);
    poly(ctx, '#5a6168', [50, 6, 55, 22, 50, 26, 45, 22]);
  },
  // Paratroopers: a canopy with a soldier under it.
  paratroopers(ctx) {
    canopy(ctx, 50, 30, 26, 52, '#d9d6b8');
    circle(ctx, '#d8b48a', 50, 50, 4);
    poly(ctx, '#6a7a3a', [45, 54, 55, 54, 56, 66, 52, 66, 50, 60, 48, 66, 44, 66]);
  },
  // Parabombs: a canopy carrying a bomb.
  parabombs(ctx) {
    canopy(ctx, 50, 28, 24, 48, '#b9b39a');
    ctx.fillStyle = '#3b3f2e';
    ctx.beginPath();
    ctx.ellipse(50, 58, 7, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    poly(ctx, '#6b705a', [44, 47, 56, 47, 53, 52, 47, 52]);
    poly(ctx, '#c62a1e', [43, 58, 57, 58, 57, 61, 43, 61]);
  },
  // GPS satellite: a body with two solar wings and signal arcs.
  gps(ctx) {
    for (const r of [12, 20, 28]) stroke(ctx, 'rgba(120,220,140,0.75)', 2.5, () => ctx.arc(50, 62, r, Math.PI * 1.15, Math.PI * 1.85));
    poly(ctx, '#2c5aa0', [12, 18, 38, 18, 38, 32, 12, 32]);
    poly(ctx, '#2c5aa0', [62, 18, 88, 18, 88, 32, 62, 32]);
    stroke(ctx, '#8fb4e8', 1, () => {
      for (const x of [20, 28, 70, 78]) {
        ctx.moveTo(x, 18);
        ctx.lineTo(x, 32);
      }
    });
    poly(ctx, '#c8c8c0', [42, 14, 58, 14, 58, 36, 42, 36]);
    poly(ctx, '#8a8e93', [38, 23, 62, 23, 62, 27, 38, 27]);
    circle(ctx, '#ffd23a', 50, 40, 3);
  },
  // Sonar pulse: rings spreading over the water from a periscope.
  sonar(ctx) {
    poly(ctx, '#123a52', [0, 75, 0, 50, 100, 50, 100, 75]);
    for (const r of [10, 20, 30, 40]) stroke(ctx, `rgba(110,240,170,${1 - r / 50})`, 2.5, () => ctx.ellipse(50, 50, r, r * 0.38, 0, 0, Math.PI * 2));
    poly(ctx, '#3a3f44', [47, 50, 53, 50, 53, 32, 60, 32, 60, 36, 53, 36]);
  },
};

/** A generic emblem for icon names without one: a lightning bolt. */
function fallback(ctx) {
  glow(ctx, 50, 38, 36, 'rgba(255,220,80,0.45)');
  poly(ctx, '#ffd23a', [56, 6, 30, 42, 47, 42, 40, 70, 70, 30, 53, 30]);
}

/** Whether WebRA has an emblem of its own for this icon name. */
export function hasPowerEmblem(icon) {
  return Object.hasOwn(EMBLEMS, icon);
}

/**
 * Draw the icon of a support power (SupportPowerInfo.Icon: abomb, invuln,
 * chrono, spyplane, paratroopers, parabombs, gps, sonar) into the
 * rectangle (0, 0, w, h) of ctx: backdrop, emblem, frame.
 */
export function drawPowerIcon(ctx, icon, w, h) {
  const inner = cameoInner(w, h);
  ctx.save();
  paintCameoBackdrop(ctx, w, h);
  ctx.beginPath();
  ctx.rect(inner.x, inner.y, inner.w, inner.h);
  ctx.clip();
  const scale = Math.min(inner.w / 100, inner.h / 75);
  ctx.translate(inner.x + (inner.w - 100 * scale) / 2, inner.y + (inner.h - 75 * scale) / 2);
  ctx.scale(scale, scale);
  (EMBLEMS[icon] ?? fallback)(ctx);
  ctx.restore();
  ctx.save();
  paintCameoFrame(ctx, w, h);
  ctx.restore();
}
