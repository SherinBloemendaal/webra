// Art for ships (2D minimal pack, flat 1996 style). Entries: id -> { body: [w, h, draw], turret?: [w, h, draw] },
// drawn facing north.
//
// Turret sprites are centred on their pivot: the engine draws them at each
// OpenRA Turreted offset along the hull (render.rs push_ship), so the Cruiser
// shows its one turret sprite twice. Materials follow the design canvas's
// Units board: welded hull plating, a dark blue deck with plank seams, team
// colour on the superstructure. Helpers come from ./kit.js and ./unitkit.js.

import { C, rect, rrect, circle, poly, line, ring } from './kit.js';
import { U, PANEL_SHADE, bands, plate, glass, deck, steel, stripes, hullPlates } from './unitkit.js';

const HULL = U.hull;
const HULL_DARK = U.hullDark;
const WAKE = 'rgba(225,240,255,0.55)';

/**
 * Pointed hull from bow (top) to a square stern: dark outline, hull plating
 * with weld bands, and the dark blue deck inside it.
 */
function hull(ctx, P, w, h, bow, inset = 1) {
  const m = w / 2;
  poly(ctx, P.c(C.shadow), [m + 1.5, 1.5, w + 0.5, bow + 1.5, w + 0.5, h + 0.5, 1.5, h + 0.5, 1.5, bow + 1.5]);
  poly(ctx, P.c(HULL_DARK), [m, 0, w - inset + 0.5, bow, w - inset + 0.5, h - 1, inset - 0.5, h - 1, inset - 0.5, bow]);
  poly(ctx, P.c(HULL), [m, 1.2, w - inset - 0.5, bow + 0.5, w - inset - 0.5, h - 2, inset + 0.5, h - 2, inset + 0.5, bow + 0.5]);
  for (const [y, t] of bands(bow + 1, h - 2, 3.5, 0.6, 2.9)) rect(ctx, P.c(HULL_DARK), inset + 0.5, y, w - 2 * inset - 1, t);
  // Deck: a pointed fore deck and the long deck behind it.
  const d = inset + 1.5;
  poly(ctx, P.c(U.deck), [m, 3.2, w - d, bow + 1, d, bow + 1]);
  deck(ctx, P, d, bow + 1, w - 2 * d, h - bow - 4.5);
}

/** Stern wake: two short white streaks. */
function wake(ctx, P, w, h) {
  line(ctx, P.c(WAKE), 1, w * 0.3, h - 1.5, w * 0.22, h);
  line(ctx, P.c(WAKE), 1, w * 0.7, h - 1.5, w * 0.78, h);
}

/** Superstructure: a hull-plated block with a team roof and a glazed front. */
function bridge(ctx, P, x, y, w, h, level = 0.62) {
  rrect(ctx, P.c(HULL_DARK), x - 0.5, y - 0.5, w + 1, h + 1, 1.2);
  plate(ctx, P, x, y, w, h, level, 1, 3);
  glass(ctx, P, x + 0.5, y + 0.4, w - 1, 1.6, 0.3);
}

/** A funnel seen from above. */
function funnel(ctx, P, cx, cy, r) {
  circle(ctx, P.c(HULL_DARK), cx, cy, r);
  circle(ctx, P.c(HULL), cx, cy, r * 0.75);
  circle(ctx, P.c('#1d1f21'), cx, cy, r * 0.55);
}

/** Small gun turret centred in a s x s sprite, barrels pointing north. */
function gunTurret(s, r, barrels, len) {
  return [s, s, (ctx, P) => {
    const c = s / 2;
    for (const dx of barrels) rect(ctx, P.c(U.steelDark), c + dx - 0.5, c - len, 1, len);
    circle(ctx, P.c(HULL_DARK), c, c, r);
    circle(ctx, P.team(0.8), c, c, r - 0.8);
    circle(ctx, P.team(0.8 * PANEL_SHADE), c + r * 0.15, c + r * 0.2, r * 0.45);
    circle(ctx, P.team(1.0), c - r * 0.3, c - r * 0.3, r * 0.3);
  }];
}

/** Submarine hull: a dark cigar with welded plating along it. */
function subHull(ctx, P, w, h, r) {
  rrect(ctx, P.c(C.shadow), 2.5, 1.5, w - 3, h - 2, r);
  rrect(ctx, P.c(HULL_DARK), 1.5, 0.5, w - 3, h - 2, r);
  rrect(ctx, P.c('#3d4a52'), 2.3, 1.3, w - 4.6, h - 3.6, r - 0.8);
  for (const [y, t] of bands(r + 1, h - r - 2, 3.5, 0.5, 2.9)) rect(ctx, P.c(HULL_DARK), 3, y, w - 6, t);
  rect(ctx, P.c(U.deck), w / 2 - 1, r, 2, h - 2 * r - 2); // deck walk
}

export const NAVAL_DRAW = {
  // Gunboat: small, fast, a single deck gun forward.
  PT: {
    body: [14, 30, (ctx, P) => {
      hull(ctx, P, 14, 30, 9);
      plate(ctx, P, 3.5, 12, 7, 12, 0.55, 1, 3);
      bridge(ctx, P, 4, 15, 6, 6, 0.72);
      stripes(ctx, P, 6, 24, 2, 3, 1); // depth charge rack
      wake(ctx, P, 14, 30);
    }],
    turret: gunTurret(10, 2.6, [0], 5),
  },
  // Destroyer: long hull, missile turret forward, bridge and stack amidships.
  DD: {
    body: [18, 40, (ctx, P) => {
      hull(ctx, P, 18, 40, 12);
      plate(ctx, P, 4, 14, 10, 20, 0.5, 1);
      rect(ctx, P.team(0.75), 4, 14, 10, 1.6);
      bridge(ctx, P, 5, 18, 8, 8);
      funnel(ctx, P, 9, 29, 2.3);
      for (const x of [5, 13]) stripes(ctx, P, x - 1, 34, 2, 2.5, 1); // depth charges aft
      wake(ctx, P, 18, 40);
    }],
    turret: [12, 12, (ctx, P) => {
      // Twin Stinger launcher.
      rrect(ctx, P.c(HULL_DARK), 2.5, 2.5, 7, 8, 1.5);
      plate(ctx, P, 3.2, 3.2, 5.6, 6.6, 0.8, 1, 3);
      for (const x of [4.5, 7.5]) {
        rect(ctx, P.c('#e8e6dc'), x - 0.6, 0.5, 1.2, 4);
        rect(ctx, P.c('#c23a26'), x - 0.6, 0.2, 1.2, 0.9);
      }
    }],
  },
  // Cruiser: the big one, two heavy turrets fore and aft, superstructure between.
  CA: {
    body: [24, 54, (ctx, P) => {
      hull(ctx, P, 24, 54, 15);
      plate(ctx, P, 5, 22, 14, 18, 0.5, 1);
      rect(ctx, P.team(0.75), 5, 22, 14, 1.6);
      bridge(ctx, P, 7, 24, 10, 9);
      funnel(ctx, P, 12, 35, 2.4);
      funnel(ctx, P, 12, 38.5, 2.4);
      rect(ctx, P.c(HULL_DARK), 11.5, 41, 1, 4); // mast
      line(ctx, P.c(HULL_DARK), 0.8, 8, 43, 16, 43);
      wake(ctx, P, 24, 54);
    }],
    turret: [14, 14, (ctx, P) => {
      // Twin 8 inch gun house.
      for (const x of [5.5, 8.5]) rect(ctx, P.c(U.steelDark), x - 0.7, 0, 1.4, 7);
      rrect(ctx, P.c(HULL_DARK), 2.5, 4.5, 9, 8, 2);
      plate(ctx, P, 3.3, 5.3, 7.4, 6.4, 0.8, 1.5, 3);
      rect(ctx, P.team(1.0), 4.3, 6, 3, 1.2);
    }],
  },
  // Submarine: slim cigar hull, conning tower, no turret (torpedoes fire forward).
  SS: {
    body: [12, 34, (ctx, P) => {
      subHull(ctx, P, 12, 34, 4.5);
      plate(ctx, P, 3.5, 12, 5, 9, 0.55, 2, 3); // sail
      rect(ctx, P.team(0.85), 4, 12.5, 4, 1.2);
      rect(ctx, P.c(HULL_DARK), 5.6, 9, 0.8, 4); // periscope
      poly(ctx, P.c(HULL_DARK), [1, 31, 6, 28, 11, 31, 6, 33.5]); // tail planes
    }],
  },
  // Missile submarine: wider hull with a double row of launch hatches.
  MSUB: {
    body: [16, 42, (ctx, P) => {
      subHull(ctx, P, 16, 42, 6);
      plate(ctx, P, 5, 8, 6, 9, 0.55, 2, 3); // sail
      rect(ctx, P.team(0.85), 5.5, 8.5, 5, 1.2);
      for (let k = 0; k < 4; k++) {
        for (const x of [5.5, 10.5]) {
          circle(ctx, P.c(HULL_DARK), x, 21 + k * 4, 1.5);
          circle(ctx, P.team(0.75), x, 21 + k * 4, 1);
        }
      }
      poly(ctx, P.c(HULL_DARK), [1, 39, 8, 35, 15, 39, 8, 41.5]);
    }],
  },
  // Transport (landing craft): boxy hull, a hazard-striped bow ramp, an open well deck.
  LST: {
    body: [24, 38, (ctx, P) => {
      rect(ctx, P.c(C.shadow), 2.5, 2.5, 21, 35);
      rrect(ctx, P.c(HULL_DARK), 1, 1, 22, 35, 2);
      rrect(ctx, P.c(HULL), 2, 2, 20, 33, 1.5);
      hullPlates(ctx, P, 2, 5, 20, 22);
      steel(ctx, P, 3, 1, 18, 4, 0.5); // bow ramp
      stripes(ctx, P, 3, 4, 18, 1.5, 1);
      deck(ctx, P, 4, 6, 16, 20); // well deck
      for (let y = 9; y < 25; y += 4) rect(ctx, P.c(U.deckSeam), 4, y, 16, 0.8);
      plate(ctx, P, 3, 27, 18, 8, 0.55); // stern house
      bridge(ctx, P, 7, 28, 10, 5);
      wake(ctx, P, 24, 38);
    }],
  },
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
