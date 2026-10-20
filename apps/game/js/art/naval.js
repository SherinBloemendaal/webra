// Art for ships (2D minimal pack). Entries: id -> { body: [w, h, draw], turret?: [w, h, draw] },
// drawn facing north.
//
// Turret sprites are centred on their pivot: the engine draws them at each
// OpenRA Turreted offset along the hull (render.rs push_ship), so the Cruiser
// shows its one turret sprite twice. Two to four flat shapes per ship (hull,
// superstructure in team colour, and the gun or the ship's own feature), the ground
// shadow is the renderer's (art/unitkit.js). The kit is ./unitkit.js.

import { rect, rrect, circle, poly, line, ring } from './kit.js';
import { M, TEAM, box, disc, shape, sprite, GROUND } from './unitkit.js';

const HULL_DARK = M.darker;

/** A pointed hull from the bow (top) to a square stern, the bow `bow` long, filling the box. */
function hull(w, h, bow) {
  return shape(w / 2, 0, w, bow, w, h, 0, h, 0, bow);
}

/** A ship of `parts` over its hull shape. */
function ship(w, h, hullGeom, fill, ...parts) {
  return sprite(w, h, [[fill, hullGeom], ...parts], GROUND);
}

export const NAVAL_DRAW = {
  // Gunboat: small and fast, a team bridge, a single gun forward.
  PT: {
    body: ship(16, 34, hull(16, 34, 9), M.steel, [TEAM, box(3.5, 15, 7, 8, 1)]),
    turret: sprite(10, 10, [[M.steel2, disc(5, 5, 2.8)], [M.dark, box(4.4, 0, 1.2, 4)]], GROUND),
  },
  // Destroyer: a long hull, the team bridge amidships, the twin missile launcher forward.
  DD: {
    body: ship(18, 40, hull(18, 40, 11), M.steel, [TEAM, box(4, 17, 8, 10, 1)]),
    turret: sprite(12, 12, [[M.steel2, box(3, 3.5, 6, 6, 1)], [M.paint, box(3.8, 0.5, 1.4, 4.5), box(6.8, 0.5, 1.4, 4.5)]], GROUND),
  },
  // Cruiser: the big one, two twin gun houses fore and aft, the team superstructure between.
  CA: {
    body: ship(24, 50, hull(24, 50, 13), M.steel, [TEAM, box(5, 17, 12, 16, 1.5)]),
    turret: sprite(14, 14, [[M.steel2, box(3, 3.5, 8, 8, 2)], [M.dark, box(4.6, 0, 1.4, 5), box(8, 0, 1.4, 5)]], GROUND),
  },
  // Submarine: a dark cigar hull and the team conning tower.
  SS: (() => {
    const [W, H] = [12, 34];
    return { body: ship(12, 34, box(0, 0, W, H, 5), M.dark, [TEAM, box(2.5, 11, W - 5, 8, 1.5)]) };
  })(),
  // Missile submarine: a wider hull, the team sail and a double row of launch hatches.
  MSUB: (() => {
    const [W, H] = [16, 42];
    const hatches = [22, 27, 32].flatMap((y) => [disc(W / 2 - 2.6, y, 1.4), disc(W / 2 + 2.6, y, 1.4)]);
    return { body: ship(16, 42, box(0, 0, W, H, 7), M.dark, [TEAM, box(4, 7, W - 8, 9, 1.5)], [M.steel2, ...hatches]) };
  })(),
  // Transport (landing craft): a boxy hull, the yellow bow ramp, the open well deck, the team stern house.
  LST: (() => {
    const [W, H] = [24, 38];
    return {
      body: ship(24, 38, box(0, 0, W, H, 2), M.steel, [M.yellow, box(1.5, 0, W - 3, 4, 1)], [M.dark, box(3, 5, W - 6, H - 16)], [TEAM, box(3, H - 10, W - 6, 8.5, 1)]),
    };
  })(),
};

/** Extra special sprites ([w, h, draw]), at most 8; see SPECIAL_SLOTS in sprites.js.
 * Order matches the NAVAL_* constants in engine/src/naval.rs. */
export const NAVAL_SPECIALS = [
  // 0 torpedo (nose east, like the missile special), with a bubble trail
  [10, 4, (ctx, P) => {
    for (const [x, r] of [[0.8, 0.6], [2, 0.8], [3.3, 0.6]]) circle(ctx, P.c('rgba(220,240,255,0.7)'), x, 2, r);
    rrect(ctx, P.c('#2c3236'), 3.5, 1, 6, 2, 1);
    rect(ctx, P.c('#c9a23a'), 8.4, 1.2, 1.2, 1.6);
  }],
  // 1 depth charge (a barrel, seen from above)
  [5, 5, (ctx, P) => {
    circle(ctx, P.c('#2a2e30'), 2.5, 2.5, 2.3);
    circle(ctx, P.c('#4a5054'), 2.5, 2.5, 1.6);
    rect(ctx, P.c('#c9a23a'), 1, 2.2, 3, 0.6);
  }],
  // 2 splash: white water ring and spray
  [20, 20, (ctx, P) => {
    circle(ctx, P.c('rgba(170,210,240,0.35)'), 10, 10, 9);
    ring(ctx, P.c('rgba(235,248,255,0.85)'), 10, 10, 7, 1.6);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      circle(ctx, P.c('rgba(245,252,255,0.9)'), 10 + Math.cos(a) * 4, 10 + Math.sin(a) * 4, 1.2);
    }
    circle(ctx, P.c('#ffffff'), 10, 10, 2);
  }],
  // 3 submerged ripple: faint wake rings over a diving submarine
  [18, 30, (ctx, P) => {
    ctx.save();
    ctx.translate(9, 15);
    ctx.scale(1, 1.7);
    ring(ctx, P.c('rgba(200,230,255,0.45)'), 0, 0, 7.5, 0.9);
    ring(ctx, P.c('rgba(200,230,255,0.3)'), 0, 0, 5, 0.7);
    ctx.restore();
    line(ctx, P.c('rgba(225,242,255,0.6)'), 0.9, 9, 1, 9, 5); // periscope wake
  }],
  // 4 sinking wreck: dark hull slipping under, oil and foam
  [26, 26, (ctx, P) => {
    circle(ctx, P.c('rgba(20,20,22,0.45)'), 13, 13, 12);
    poly(ctx, P.c(HULL_DARK), [13, 4, 18, 9, 17, 21, 9, 21, 8, 9]);
    rect(ctx, P.c('#5a2a1a'), 10, 12, 6, 3);
    ring(ctx, P.c('rgba(235,248,255,0.7)'), 13, 13, 10, 1.4);
    for (const [x, y] of [[5, 8], [21, 10], [7, 20], [19, 19]]) circle(ctx, P.c('rgba(245,252,255,0.85)'), x, y, 1.3);
  }],
];
