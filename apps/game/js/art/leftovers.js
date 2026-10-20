// Art for what battles leave and drop (engine/src/husks.rs, crates.rs,
// primary.rs, smudges.rs): crates (the land image in the body slot, the
// water image in the second slot), husks (the wreck of the vehicle: its
// hull charred; the engine darkens it further and puts the fire on top, like
// OpenRA's WithColoredOverlay@IDISABLE and WithIdleOverlay@Burns), and the
// leftover specials: the fire of husks and scorch marks, crater smoke, the
// PRIMARY tag and the crate pickup animations.
// Helpers and palette come from ./kit.js.

import { rect, rrect, circle, poly, line, ring } from './kit.js';
import { tone } from './volume.js';
import { SHARED_PALETTE } from './shared-palette.js';

const OUTLINE = '#141414';

/**
 * Where the leftover specials start after the actor slots: past the 12
 * built-in specials and the seven art modules before this one (SPECIAL_SLOTS
 * each; engine/src/render.rs SpriteIds::leftovers_base).
 */
export const LEFTOVER_SPECIAL_OFFSET = 68;

/** The shared 2D/3D materials (art/shared-palette.js): steel for the steel crate, wood for the wooden one. */
const M = SHARED_PALETTE.materials;
const SHADOW = `rgba(0,0,0,${SHARED_PALETTE.shadow.alpha})`;
const SHADOW_OFFSET = SHARED_PALETTE.shadow.offset * 24;

/** A steel crate (the original art's scrate, the multiplayer crate): the box, a dark band each way and a yellow stud. */
function steelCrate(ctx, P, x, y, s) {
  rect(ctx, P.c(M.steel), x, y, s, s);
  rect(ctx, P.c(M.dark), x, y + s / 2 - 0.7, s, 1.4);
  rect(ctx, P.c(M.dark), x + s / 2 - 0.7, y, 1.4, s);
  rect(ctx, P.c(M.yellow), x + s / 2 - 1.2, y + s / 2 - 1.2, 2.4, 2.4);
}

/** A wooden crate (the original art's wcrate): the planks, one seam and a lit top edge. */
function woodCrate(ctx, P, x, y, s) {
  rect(ctx, P.c(M.wood), x, y, s, s);
  rect(ctx, P.c(tone(M.wood, -0.3)), x, y + s / 2 - 0.6, s, 1.2);
  rect(ctx, P.c(tone(M.wood, 0.2)), x, y, s, 1.2);
}

/** One ripple round a crate bobbing in the water. */
function ripples(ctx, P) {
  ring(ctx, P.c('rgba(210,235,245,0.55)'), 8, 8, 6.6, 0.8);
}

const steelLand = [14, 14, (ctx, P) => {
  rect(ctx, P.c(SHADOW), 2.5 + SHADOW_OFFSET, 2.5 + SHADOW_OFFSET, 9, 9);
  steelCrate(ctx, P, 2.5, 2.5, 9);
}];
const steelWater = [16, 16, (ctx, P) => {
  ripples(ctx, P);
  steelCrate(ctx, P, 4, 4, 8);
}];
const woodLand = [14, 14, (ctx, P) => {
  rect(ctx, P.c(SHADOW), 2.5 + SHADOW_OFFSET, 2.5 + SHADOW_OFFSET, 9, 9);
  woodCrate(ctx, P, 2.5, 2.5, 9);
}];
const woodWater = [16, 16, (ctx, P) => {
  ripples(ctx, P);
  woodCrate(ctx, P, 4, 4, 8);
}];

/**
 * Crates by actor id: { body: land, second: water }. OpenRA draws CRATE and
 * HEALCRATE with the steel crate (scrate), WCRATE and MONEYCRATE with the
 * wooden one (wcrate).
 */
export const CRATE_DRAW = {
  CRATE: { body: steelLand, turret: steelWater },
  SCRATE: { body: steelLand, turret: steelWater },
  HEALCRATE: { body: steelLand, turret: steelWater },
  WCRATE: { body: woodLand, turret: woodWater },
  MONEYCRATE: { body: woodLand, turret: woodWater },
};

/** Scorch marks over a sprite: two charred blocks [x, y, w, h] as fractions of its size. */
const SOOT = [
  [0.18, 0.18, 0.4, 0.3],
  [0.45, 0.5, 0.4, 0.32],
];

/**
 * The husk of a vehicle drawn by `body` ([w, h, draw], the vehicle's own
 * body sprite): the hull with two charred patches; its turret is gone
 * (thrown off as a particle). A wreck casts the renderer's ground shadow
 * when its vehicle does (`groundShadow`, sprites.js shadowSlots).
 */
export function huskOf(body) {
  const [w, h, draw] = body;
  const husk = (ctx, P) => {
    draw(ctx, P);
    for (const [fx, fy, fw, fh] of SOOT) rect(ctx, P.c('rgba(20,16,12,0.55)'), w * fx, h * fy, w * fw, h * fh);
  };
  if (draw.groundShadow !== undefined) husk.groundShadow = draw.groundShadow;
  return [w, h, husk];
}

/** The vehicle a husk id is the wreck of: 2TNK.Husk -> 2TNK, HARV.FullHusk -> HARV. */
export function huskBase(id) {
  return String(id).toUpperCase().replace(/\.(FULL|EMPTY)?HUSK$/, '');
}

/** A flame of three tongues (fire1..fire3 in OpenRA), `h` tall. */
function flame(ctx, P, cx, base, h) {
  poly(ctx, P.c('rgba(230,80,20,0.85)'), [cx - h * 0.35, base, cx - h * 0.12, base - h * 0.75, cx, base - h * 0.45, cx + h * 0.15, base - h, cx + h * 0.35, base]);
  poly(ctx, P.c('rgba(250,170,40,0.95)'), [cx - h * 0.22, base, cx - h * 0.05, base - h * 0.55, cx + h * 0.12, base - h * 0.7, cx + h * 0.22, base]);
  poly(ctx, P.c('rgba(255,240,170,0.95)'), [cx - h * 0.1, base, cx + h * 0.02, base - h * 0.35, cx + h * 0.1, base]);
}

/** 3 by 5 pixel letters (rows top down, bit 2 the left column) of the PRIMARY tag. */
const GLYPHS = {
  P: [6, 5, 6, 4, 4],
  R: [6, 5, 6, 5, 5],
  I: [7, 2, 2, 2, 7],
  M: [5, 7, 7, 5, 5],
  A: [2, 5, 7, 5, 5],
  Y: [5, 5, 2, 2, 2],
};

/** `text` in GLYPHS at (x, y), one pixel per cell, a pixel between letters. */
function pixelText(ctx, fill, text, x, y) {
  for (const [k, ch] of [...text].entries()) {
    const rows = GLYPHS[ch] ?? [];
    rows.forEach((bits, r) => {
      for (let c = 0; c < 3; c++) if (bits & (4 >> c)) rect(ctx, fill, x + k * 4 + c, y + r, 1, 1);
    });
  }
}

/** A crate pickup sign: a dark disc with a coloured mark (OpenRA crate-effects). */
function badge(mark) {
  return [18, 18, (ctx, P) => {
    circle(ctx, P.c('rgba(0,0,0,0.55)'), 9, 9, 8.5);
    ring(ctx, P.c('rgba(255,255,255,0.75)'), 9, 9, 8, 0.8);
    mark(ctx, P);
  }];
}

/**
 * Special sprites ([w, h, draw]), at most 8; see SPECIAL_SLOTS in sprites.js.
 * Order matters: engine/src/husks.rs LEFTOVER_* uses `leftovers_base + index`.
 */
export const LEFTOVER_SPECIALS = [
  // 0: fire on a husk or a scorch mark
  [12, 14, (ctx, P) => {
    flame(ctx, P, 4, 13, 9);
    flame(ctx, P, 7.5, 13, 12);
  }],
  // 1: smoke over a crater
  [14, 14, (ctx, P) => {
    circle(ctx, P.c('rgba(60,58,54,0.45)'), 6, 9, 4.5);
    circle(ctx, P.c('rgba(80,78,72,0.4)'), 9, 6, 4);
    circle(ctx, P.c('rgba(100,98,92,0.35)'), 7, 3.5, 3);
  }],
  // 2: the PRIMARY tag over a selected primary structure
  [31, 9, (ctx, P) => {
    rrect(ctx, P.c(OUTLINE), 0, 0, 31, 9, 1.5);
    rrect(ctx, P.team(0.9), 0.8, 0.8, 29.4, 7.4, 1);
    pixelText(ctx, P.c('#ffffff'), 'PRIMARY', 2, 2);
  }],
  // 3: level up (a gold chevron rising)
  badge((ctx, P) => {
    poly(ctx, P.c('#f2c94c'), [4, 11, 9, 5, 14, 11, 14, 13.5, 9, 8, 4, 13.5]);
  }),
  // 4: heal (a red cross)
  badge((ctx, P) => {
    rect(ctx, P.c('#e8e8e8'), 4, 7, 10, 4);
    rect(ctx, P.c('#e8e8e8'), 7, 4, 4, 10);
    rect(ctx, P.c('#d02020'), 5, 8, 8, 2);
    rect(ctx, P.c('#d02020'), 8, 5, 2, 8);
  }),
  // 5: map hidden (a dark eye, crossed out)
  badge((ctx, P) => {
    poly(ctx, P.c('#9aa3ad'), [3, 9, 9, 5, 15, 9, 9, 13]);
    circle(ctx, P.c(OUTLINE), 9, 9, 2);
    line(ctx, P.c('#e04030'), 1.4, 4, 14, 14, 4);
  }),
  // 6: map revealed (a globe)
  badge((ctx, P) => {
    circle(ctx, P.c('#3d7fc4'), 9, 9, 5.5);
    poly(ctx, P.c('#5fae4a'), [6, 6, 9, 5, 10, 8, 8, 10, 6, 9]);
    poly(ctx, P.c('#5fae4a'), [10, 11, 13, 10, 12, 13]);
  }),
  // 7: invulnerability (a red shield)
  badge((ctx, P) => {
    poly(ctx, P.c('#c02828'), [9, 3.5, 14, 5.5, 13, 11, 9, 14.5, 5, 11, 4, 5.5]);
    poly(ctx, P.c('#ff6a5a'), [9, 5, 12.5, 6.5, 11.8, 10.5, 9, 13]);
  }),
];
