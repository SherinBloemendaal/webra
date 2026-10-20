// The flat block kit of the 2D minimal units (design board "Retexture 2D en 3D:
// minder detail", 0.21.0): every unit is two to four flat shapes in the colours
// the 2D and 3D minimal art share (./shared-palette.js) and one team coloured
// area (the turret, the cargo bed, the uniform or the superstructure).
//
// A sprite is declared as data: a list of parts, each one fill (a material
// colour or the team) over one or more geometries (a shape and its mirror or
// its repeats, such as a pair of treads or a row of wheels). The parts stay
// readable for the tests (shape counts, extents) and for the preview sheets.
//
// Units fill their box like the original sprites fill theirs. The sprites
// carry no shadow, because the engine turns them with the unit: the board's
// one hard shadow of a ground unit is drawn by the renderer in world space
// (engine/src/render.rs `unit_shadow`, for the slots sprites.js lists as
// `shadows`), a dark copy of the sprite offset to the bottom right, so the
// light stays at the top left whatever way the unit faces. Aircraft get the
// engine's own airborne shadow instead.

import { rect, rrect, circle, poly } from './kit.js';
import { SHARED_PALETTE } from './shared-palette.js';

/** The shared material colours (shared-palette.js). */
export const M = SHARED_PALETTE.materials;

/** World pixels per cell. */
const CELL = 24;

/**
 * The ground shadow the renderer draws under a sprite that casts one
 * (engine/src/render.rs UNIT_SHADOW_OFFSET, UNIT_SHADOW_ALPHA): world pixels
 * to the right and down, and its opacity.
 */
export const SHADOW_OFFSET = SHARED_PALETTE.shadow.offset * CELL;
export const SHADOW_ALPHA = SHARED_PALETTE.shadow.alpha;

/** The fill of the team area. */
export const TEAM = 'team';
/** The team grey the area is painted in (the shader tints it with the owner's colour). */
export const TEAM_LEVEL = 0.85;

// ---- Geometry ------------------------------------------------------------------------------

/** A (rounded) rectangle. */
export const box = (x, y, w, h, r = 0) => ['r', x, y, w, h, r];
/** A disc. */
export const disc = (cx, cy, r) => ['c', cx, cy, r];
/** A polygon through [x0, y0, x1, y1, ...]. */
export const shape = (...pts) => ['p', ...pts];

/** The bounding box [x0, y0, x1, y1] of a geometry. */
export function geomBounds(g) {
  if (g[0] === 'r') return [g[1], g[2], g[1] + g[3], g[2] + g[4]];
  if (g[0] === 'c') return [g[1] - g[3], g[2] - g[3], g[1] + g[3], g[2] + g[3]];
  const xs = g.filter((_, i) => i > 0 && i % 2 === 1);
  const ys = g.filter((_, i) => i > 0 && i % 2 === 0);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function paint(ctx, style, g) {
  if (g[0] === 'r') {
    if (g[5] > 0) rrect(ctx, style, g[1], g[2], g[3], g[4], Math.min(g[5], g[3] / 2, g[4] / 2));
    else rect(ctx, style, g[1], g[2], g[3], g[4]);
  } else if (g[0] === 'c') {
    circle(ctx, style, g[1], g[2], g[3]);
  } else {
    poly(ctx, style, g.slice(1));
  }
}

/** One thin blade from (cx, cy) at angle `a` (0 north, clockwise), `len` long and `width` wide. */
export function blade(cx, cy, a, len, width) {
  const [s, c] = [Math.sin(a), -Math.cos(a)];
  const [nx, ny] = [-c * (width / 2), s * (width / 2)];
  return shape(cx + nx, cy + ny, cx + s * len + nx, cy + c * len + ny, cx + s * len - nx, cy + c * len - ny, cx - nx, cy - ny);
}

// ---- Sprites -------------------------------------------------------------------------------

/** `sprite` option: the sprite casts the renderer's ground shadow (ground units, not aircraft). */
export const GROUND = true;

/**
 * A sprite [w, h, draw] from its parts ([fill, ...geometries], drawn in
 * order). The draw function carries `parts` for the tests and the previews,
 * and `groundShadow` (`ground`, GROUND for ground units) for sprites.js
 * buildAtlas `shadows`.
 */
export function sprite(w, h, parts, ground = false) {
  const draw = (ctx, P) => {
    for (const [fill, ...geoms] of parts) {
      const style = fill === TEAM ? P.team(TEAM_LEVEL) : P.c(fill);
      for (const g of geoms) paint(ctx, style, g);
    }
  };
  draw.parts = parts;
  draw.groundShadow = ground === true;
  return [w, h, draw];
}

/** Wheels on both flanks of a `W` wide body, one pair per y in `ys`. */
export function wheels(W, ys, tw = 3, th = 5) {
  return ys.flatMap((y) => [box(0, y, tw, th, 1), box(W - tw, y, tw, th, 1)]);
}

/** A pair of treads `tw` wide on both flanks of a `W` wide body, from y to y + h. */
export function treads(W, y, h, tw) {
  return [box(0, y, tw, h, 1), box(W - tw, y, tw, h, 1)];
}
