// Art for the sidebar buttons' marks on structures (engine/src/repair.rs):
// the wrench over a structure being repaired, in the colour of the player
// repairing it (OpenRA WithBuildingRepairDecoration, `allyrepair`), and the
// power off icon over a structure switched off with the power down button
// (OpenRA WithDecoration@POWERDOWN, `poweroff`). The engine blinks them.
// Helpers come from ./kit.js.

import { circle, poly, ring } from './kit.js';

const OUTLINE = '#141414';

/** Wrench points [x0, y0, ...] (jaw up) turned 45 degrees and centred in the 14 px box. */
function turn(pts) {
  const c = Math.SQRT1_2;
  const out = [];
  for (let i = 0; i < pts.length; i += 2) out.push(6.15 + (pts[i] - pts[i + 1]) * c, 7.85 + (pts[i] + pts[i + 1]) * c);
  return out;
}

/**
 * Special sprites ([w, h, draw]), at most 8; see SPECIAL_SLOTS in sprites.js.
 * Order matters: engine/src/repair.rs uses `decorations_base + index`.
 */
export const DECORATION_SPECIALS = [
  // 0: wrench, team coloured (the repairing player), drawn diagonally
  [14, 14, (ctx, P) => {
    // Handle and open jaw, outline first.
    poly(ctx, P.c(OUTLINE), turn([-1.8, -1.5, 1.8, -1.5, 1.8, 6.6, -1.8, 6.6]));
    poly(ctx, P.c(OUTLINE), turn([-4, -6.8, -1.3, -6.8, -1.3, -3.4, 1.3, -3.4, 1.3, -6.8, 4, -6.8, 4, -2.6, 2.4, -0.6, -2.4, -0.6, -4, -2.6]));
    poly(ctx, P.team(0.95), turn([-1, -1.2, 1, -1.2, 1, 5.8, -1, 5.8]));
    poly(ctx, P.team(0.95), turn([-3.2, -6, -2.1, -6, -2.1, -2.6, 2.1, -2.6, 2.1, -6, 3.2, -6, 3.2, -2.9, 2, -1.4, -2, -1.4, -3.2, -2.9]));
  }],
  // 1: power off: a red power symbol on a dark disc
  [14, 14, (ctx, P) => {
    circle(ctx, P.c(OUTLINE), 7, 7, 6.8);
    circle(ctx, P.c('#3a1010'), 7, 7, 5.8);
    ring(ctx, P.c('#ff4a3a'), 7, 7.6, 3.4, 1.4);
    poly(ctx, P.c('#3a1010'), [5.4, 2.5, 8.6, 2.5, 7.6, 6.2, 6.4, 6.2]);
    poly(ctx, P.c('#ff4a3a'), [6.3, 2.2, 7.7, 2.2, 7.7, 7.4, 6.3, 7.4]);
  }],
];
