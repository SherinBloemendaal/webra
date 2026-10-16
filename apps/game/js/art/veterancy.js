// Art for veterancy (engine/src/veterancy.rs): the rank decorations drawn at the
// bottom right of a ranked unit, like OpenRA's WithDecoration@RANK-* (`rank`
// image: one, two and three chevrons, then the elite star), and the prone pose
// of the infantry (TakeCover), which sprites.js puts in the infantry's turret slot.
// Helpers and palette come from ./kit.js; the prone soldier from ./infantry.js.

import { circle, poly } from './kit.js';
import { M, box } from './unitkit.js';
import { prone, proneForward } from './infantry.js';

const GOLD = '#f2c94c';
const OUTLINE = '#1a1408';

/** A gold chevron pointing up, `y` its top, in a 7 px wide box. */
function chevron(ctx, P, y) {
  poly(ctx, P.c(OUTLINE), [0, y + 3.2, 3.5, y, 7, y + 3.2, 7, y + 4.8, 3.5, y + 1.8, 0, y + 4.8]);
  poly(ctx, P.c(GOLD), [0.8, y + 3.2, 3.5, y + 0.9, 6.2, y + 3.2, 6.2, y + 3.9, 3.5, y + 1.9, 0.8, y + 3.9]);
}

function chevrons(n) {
  return [7, 2.4 * n + 3, (ctx, P) => {
    for (let k = 0; k < n; k++) chevron(ctx, P, k * 2.4);
  }];
}

/**
 * Special sprites ([w, h, draw]), at most 8; see SPECIAL_SLOTS in sprites.js.
 * Order matters: engine/src/veterancy.rs uses `veterancy_base + index`.
 */
export const VETERANCY_SPECIALS = [
  // 0-2: veteran ranks 1, 2 and 3
  chevrons(1),
  chevrons(2),
  chevrons(3),
  // 3: elite (a five-pointed star)
  [8, 8, (ctx, P) => {
    const star = (r, inner) => {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? inner : r;
        pts.push(4 + Math.cos(a) * rr, 4.3 + Math.sin(a) * rr);
      }
      return pts;
    };
    poly(ctx, P.c(OUTLINE), star(4, 1.9));
    poly(ctx, P.c(GOLD), star(3.1, 1.35));
    circle(ctx, P.c('#fff3c4'), 4, 4.3, 0.6);
  }],
];

/**
 * Prone poses of the infantry (drawn nose up like every unit sprite): the
 * soldier lies along its facing, head and weapon forward, legs behind.
 */
export const PRONE_DRAW = {
  E1: prone(M.olive, [[M.dark, proneForward(1, 6)]]),
  // The launch tube along the right side.
  E3: prone(M.olive, [[M.steel2, box(3.6, 0, 2, 9, 0.6)]]),
};
