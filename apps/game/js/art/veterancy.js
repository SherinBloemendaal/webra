// Art for veterancy (engine/src/veterancy.rs): the rank decorations drawn at the
// bottom right of a ranked unit, like OpenRA's WithDecoration@RANK-* (`rank`
// image: one, two and three chevrons, then the elite star), and the prone pose
// of the infantry (TakeCover), which sprites.js puts in the infantry's turret slot.
// Helpers and palette come from ./kit.js; the prone soldier from ./infantry.js.

import { rect, circle, poly } from './kit.js';
import { U } from './unitkit.js';
import { hands, lying } from './infantry.js';

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
  E1: [8, 14, (ctx, P) => {
    lying(ctx, P, U.helmet);
    rect(ctx, P.c(U.steelDark), 3.6, 0, 0.9, 4); // rifle
    hands(ctx, P, [4.1, 2.8]);
  }],
  E3: [8, 14, (ctx, P) => {
    lying(ctx, P, U.helmet);
    rect(ctx, P.c(U.steelDark), 5, 0.5, 1.8, 9); // launcher along the right side
    rect(ctx, P.c(U.steel), 5.4, 1.5, 0.7, 7.5);
    rect(ctx, P.c(U.steelLight), 5.3, 0.5, 1.2, 1.2);
    hands(ctx, P, [5, 3]);
  }],
};
