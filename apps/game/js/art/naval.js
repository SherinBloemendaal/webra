// Art for ships (flat 1996 style). Entries: id -> { body: [w, h, draw], turret?: [w, h, draw] },
// drawn facing north. Helpers and palette come from ./kit.js.
//
// Turret sprites are centred on their pivot: the engine draws them at each
// OpenRA Turreted offset along the hull (render.rs push_ship), so the Cruiser
// shows its one turret sprite twice. Team colour goes on the decks.

import { C, rect, rrect, circle, poly, line, ring } from './kit.js';

const HULL = '#4b5258';
const HULL_DARK = '#30353a';
const HULL_LIGHT = '#6f777e';
const DECK = '#8e8a78';
const WAKE = 'rgba(225,240,255,0.55)';

/** Pointed hull outline from bow (top) to a square stern. */
function hull(ctx, P, w, h, bow, inset = 1) {
  const m = w / 2;
  poly(ctx, P.c(C.shadow), [m + 1.5, 1.5, w + 0.5, bow + 1.5, w + 0.5, h + 0.5, 1.5, h + 0.5, 1.5, bow + 1.5]);
  poly(ctx, P.c(HULL_DARK), [m, 0, w - inset + 0.5, bow, w - inset + 0.5, h - 1, inset - 0.5, h - 1, inset - 0.5, bow]);
  poly(ctx, P.c(HULL), [m, 1.2, w - inset - 0.5, bow + 0.5, w - inset - 0.5, h - 2, inset + 0.5, h - 2, inset + 0.5, bow + 0.5]);
}

/** Stern wake: two short white streaks. */
function wake(ctx, P, w, h) {
  line(ctx, P.c(WAKE), 1, w * 0.3, h - 1.5, w * 0.22, h);
  line(ctx, P.c(WAKE), 1, w * 0.7, h - 1.5, w * 0.78, h);
}

/** Small gun turret centred in a s x s sprite, barrels pointing north. */
function gunTurret(s, r, barrels, len) {
  return [s, s, (ctx, P) => {
    const c = s / 2;
    for (const dx of barrels) rect(ctx, P.c(C.steelDark), c + dx - 0.5, c - len, 1, len);
    circle(ctx, P.c(HULL_DARK), c, c, r);
    circle(ctx, P.team(0.8), c, c, r - 0.8);
    circle(ctx, P.team(1.0), c - r * 0.3, c - r * 0.3, r * 0.3);
  }];
}

export const NAVAL_DRAW = {
  // Gunboat: small, fast, a single deck gun forward.
  PT: {
    body: [14, 30, (ctx, P) => {
      hull(ctx, P, 14, 30, 9);
      rect(ctx, P.team(0.55), 3, 9, 8, 17);
      rrect(ctx, P.c(HULL_LIGHT), 4, 15, 6, 6, 1); // wheelhouse
      rect(ctx, P.c(C.glass), 4.5, 15.5, 5, 1.5);
      rect(ctx, P.c(C.yellow), 6, 24, 2, 3); // depth charge rack
      wake(ctx, P, 14, 30);
    }],
    turret: gunTurret(10, 2.6, [0], 5),
  },
  // Destroyer: long hull, missile turret forward, bridge and stack amidships.
  DD: {
    body: [18, 40, (ctx, P) => {
      hull(ctx, P, 18, 40, 12);
      rect(ctx, P.team(0.5), 3.5, 12, 11, 25);
      rect(ctx, P.team(0.75), 3.5, 12, 11, 2);
      rrect(ctx, P.c(HULL_LIGHT), 5, 18, 8, 8, 1); // bridge
      rect(ctx, P.c(C.glass), 5.5, 18.5, 7, 1.5);
      circle(ctx, P.c(HULL_DARK), 9, 29, 2.3); // funnel
      circle(ctx, P.c('#1d1f21'), 9, 29, 1.4);
      for (const x of [5, 13]) rect(ctx, P.c(C.yellowDark), x - 1, 34, 2, 2.5); // depth charges aft
      wake(ctx, P, 18, 40);
    }],
    turret: [12, 12, (ctx, P) => {
      // Twin Stinger launcher.
      rrect(ctx, P.c(HULL_DARK), 2.5, 2.5, 7, 8, 1.5);
      rrect(ctx, P.team(0.8), 3.2, 3.2, 5.6, 6.6, 1);
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
      rect(ctx, P.c(DECK), 4, 15, 16, 36);
      rect(ctx, P.team(0.5), 5, 22, 14, 18);
      rect(ctx, P.team(0.75), 5, 22, 14, 2);
      rrect(ctx, P.c(HULL_LIGHT), 7, 24, 10, 9, 1.5); // bridge tower
      rect(ctx, P.c(C.glass), 7.5, 24.5, 9, 1.6);
      for (const y of [35, 38.5]) {
        circle(ctx, P.c(HULL_DARK), 12, y, 2.4);
        circle(ctx, P.c('#1d1f21'), 12, y, 1.4);
      }
      rect(ctx, P.c(HULL_DARK), 11.5, 41, 1, 4); // mast
      line(ctx, P.c(HULL_DARK), 0.8, 8, 43, 16, 43);
      wake(ctx, P, 24, 54);
    }],
    turret: [14, 14, (ctx, P) => {
      // Twin 8 inch gun house.
      for (const x of [5.5, 8.5]) rect(ctx, P.c(C.steelDark), x - 0.7, 0, 1.4, 7);
      rrect(ctx, P.c(HULL_DARK), 2.5, 4.5, 9, 8, 2);
      rrect(ctx, P.team(0.8), 3.3, 5.3, 7.4, 6.4, 1.5);
      rect(ctx, P.team(1.0), 4.3, 6, 3, 1.4);
    }],
  },
  // Submarine: slim cigar hull, conning tower, no turret (torpedoes fire forward).
  SS: {
    body: [12, 34, (ctx, P) => {
      rrect(ctx, P.c(C.shadow), 2.5, 1.5, 9, 32, 4.5);
      rrect(ctx, P.c(HULL_DARK), 1.5, 0.5, 9, 32, 4.5);
      rrect(ctx, P.c('#3d4a52'), 2.3, 1.3, 7.4, 30.4, 3.7);
      rrect(ctx, P.team(0.55), 3.5, 12, 5, 9, 2); // sail
      rect(ctx, P.team(0.85), 4, 12.5, 4, 1.2);
      rect(ctx, P.c(HULL_DARK), 5.6, 9, 0.8, 4); // periscope
      poly(ctx, P.c(HULL_DARK), [1, 31, 6, 28, 11, 31, 6, 33.5]); // tail planes
    }],
  },
  // Missile submarine: wider hull with a double row of launch hatches.
  MSUB: {
    body: [16, 42, (ctx, P) => {
      rrect(ctx, P.c(C.shadow), 2.5, 1.5, 13, 40, 6);
      rrect(ctx, P.c(HULL_DARK), 1.5, 0.5, 13, 40, 6);
      rrect(ctx, P.c('#3d4a52'), 2.3, 1.3, 11.4, 38.4, 5.2);
      rrect(ctx, P.team(0.55), 5, 8, 6, 9, 2); // sail
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
  // Transport (landing craft): boxy hull with an open well deck and a bow ramp.
  LST: {
    body: [24, 38, (ctx, P) => {
      rect(ctx, P.c(C.shadow), 2.5, 2.5, 21, 35);
      rrect(ctx, P.c(HULL_DARK), 1, 1, 22, 35, 2);
      rrect(ctx, P.c(HULL), 2, 2, 20, 33, 1.5);
      rect(ctx, P.c(C.steelDark), 3, 1, 18, 4); // bow ramp
      for (let x = 4; x < 20; x += 3) rect(ctx, P.c(C.steel), x, 1.5, 1.5, 3);
      rect(ctx, P.c(DECK), 4, 6, 16, 20); // well deck
      for (let y = 9; y < 25; y += 4) rect(ctx, P.c('#77735f'), 4, y, 16, 0.8);
      rect(ctx, P.team(0.55), 3, 27, 18, 8); // stern house
      rrect(ctx, P.c(HULL_LIGHT), 7, 28, 10, 5, 1);
      rect(ctx, P.c(C.glass), 7.5, 28.5, 9, 1.4);
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
