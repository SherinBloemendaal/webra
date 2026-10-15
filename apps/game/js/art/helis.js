// Art for helicopters (2D minimal pack, flat 1996 style). Entries: id -> { body: [w, h, draw], turret?: [w, h, draw] },
// drawn facing north. Materials follow the design canvas's Units board: team plating with
// panel lines, steel engines and pods, glass cockpits. Helpers come from ./kit.js and ./unitkit.js.
//
// The "turret" of a helicopter is its rotor: the engine spins it every tick
// (fast in the air, slowly on the ground) and draws it once per rotor (the
// Chinook has two). In the air it is drawn faint over the blurred disc of
// HELI_SPECIALS[0], so the blades read as a spinning blur.

import { C, rect, rrect, circle, poly, line } from './kit.js';
import { U, PANEL_SHADE, plate, steel, glass, bubble } from './unitkit.js';
import { pixelUnitDraw } from './pixel.js';

/** Rotor blades around the sprite centre: `n` blades of length `len`. */
function blades(ctx, P, cx, cy, n, len, width = 1.6) {
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const x = cx + Math.sin(a) * len;
    const y = cy - Math.cos(a) * len;
    line(ctx, P.c(U.track), width, cx, cy, x, y);
    // A lighter stripe near the tip, like the painted blade tips.
    line(ctx, P.c(U.yellow), width * 0.5, cx + Math.sin(a) * (len - 2), cy - Math.cos(a) * (len - 2), x, y);
  }
  circle(ctx, P.c(U.steelDark), cx, cy, 2.2);
  circle(ctx, P.c(U.steel), cx, cy, 1.5);
  circle(ctx, P.c(U.steelLight), cx - 0.5, cy - 0.5, 0.7);
}

/** Tail boom with a fin and a small tail rotor at the end (pointing south). */
function tail(ctx, P, cx, y0, y1, finW) {
  rect(ctx, P.team(0.45), cx - 1, y0, 2, y1 - y0);
  for (let y = y0 + 3; y < y1 - 3; y += 3) rect(ctx, P.team(0.45 * PANEL_SHADE), cx - 1, y, 2, 0.5);
  rect(ctx, P.team(0.6), cx - finW / 2, y1 - 3, finW, 2);
  line(ctx, P.c(U.track), 1, cx + 1.5, y1 - 4.5, cx + 1.5, y1 + 0.5);
}

export const HELI_DRAW = {
  // Chinook: long twin-rotor transport, rotor pylons fore and aft, steel engine pods.
  TRAN: {
    body: [20, 40, (ctx, P) => {
      rrect(ctx, P.c(C.shadow), 5, 3, 12, 36, 4);
      rrect(ctx, P.team(0.5), 4, 2, 12, 36, 4);
      plate(ctx, P, 5, 3, 10, 34, 0.7, 3.5);
      // Cockpit glazing at the nose.
      glass(ctx, P, 6, 3, 8, 3, 1.5);
      rect(ctx, P.c(U.steelDark), 9.5, 3, 1, 3);
      // Cabin windows down both sides.
      for (let y = 10; y < 28; y += 4) {
        glass(ctx, P, 5, y, 1.2, 2);
        glass(ctx, P, 13.8, y, 1.2, 2);
      }
      // Rotor pylons (front hub over the cockpit, rear one on the tail pylon).
      rrect(ctx, P.team(0.4), 7, 7, 6, 5, 1.5);
      rrect(ctx, P.team(0.4), 7, 29, 6, 8, 1.5);
      // Engine pods either side of the rear pylon.
      steel(ctx, P, 2, 28, 3, 8, 1.2);
      steel(ctx, P, 15, 28, 3, 8, 1.2);
      rect(ctx, P.c(U.steelDark), 2, 35, 3, 1);
      rect(ctx, P.c(U.steelDark), 15, 35, 3, 1);
    }],
    turret: [24, 24, (ctx, P) => blades(ctx, P, 12, 12, 3, 11, 1.5)],
  },
  // Hind: gunship with tandem glass cockpits, stub wings with rocket pods.
  HIND: {
    body: [28, 34, (ctx, P) => {
      poly(ctx, P.c(C.shadow), [16, 3, 20, 8, 20, 23, 16, 27, 12, 23, 12, 8]);
      tail(ctx, P, 14, 21, 33, 10);
      // Stub wings with a rocket pod on each tip.
      rect(ctx, P.team(0.4), 3, 13, 22, 3);
      for (const x of [2, 22]) {
        rrect(ctx, P.c(U.steelDark), x, 11, 4, 7, 1.5);
        steel(ctx, P, x + 0.5, 11.5, 3, 6, 1);
        circle(ctx, P.c(U.track), x + 2, 12.2, 0.9);
      }
      // Fuselage, pointed nose.
      poly(ctx, P.team(0.55), [14, 1, 18, 6, 18, 21, 14, 25, 10, 21, 10, 6]);
      poly(ctx, P.team(0.75), [14, 2, 17, 6, 17, 13, 11, 13, 11, 6]);
      for (const y of [17, 20]) rect(ctx, P.team(0.55 * PANEL_SHADE), 11, y, 6, 0.5); // panel lines
      // Tandem bubble cockpits: gunner in front, pilot behind.
      bubble(ctx, P, 14, 5, 1.7);
      bubble(ctx, P, 14, 9.5, 2);
      // Engine intakes beside the rotor mast.
      rect(ctx, P.c(U.steelDark), 11, 14, 2, 3);
      rect(ctx, P.c(U.steelDark), 15, 14, 2, 3);
      // Chin gun.
      rect(ctx, P.c(U.track), 13.4, 0, 1.2, 2.5);
    }],
    turret: [34, 34, (ctx, P) => blades(ctx, P, 17, 17, 5, 16)],
  },
  // Black Hawk: WebRA's own pixel art in Red Alert's style (art/pixel.js),
  // the stopped rotor over it.
  MH60: pixelUnitDraw('MH60'),
  // Longbow (Apache): slim gunship, Hellfire racks on stub wings, mast radar.
  HELI: {
    body: [26, 34, (ctx, P) => {
      poly(ctx, P.c(C.shadow), [14, 3, 17, 7, 17, 23, 14, 26, 11, 23, 11, 7]);
      tail(ctx, P, 13, 21, 33, 11);
      // Stub wings with four-round Hellfire racks.
      rect(ctx, P.team(0.4), 3, 12, 20, 2.5);
      for (const x of [3, 19]) {
        rect(ctx, P.c(U.steelDark), x, 10, 4, 6);
        for (let k = 0; k < 2; k++) for (let j = 0; j < 2; j++) circle(ctx, P.c('#d8d0b0'), x + 1 + k * 2, 11.5 + j * 3, 0.7);
      }
      // Narrow fuselage with stepped tandem cockpit.
      poly(ctx, P.team(0.55), [13, 1, 16, 5, 16, 21, 13, 24, 10, 21, 10, 5]);
      for (const y of [13, 17]) rect(ctx, P.team(0.55 * PANEL_SHADE), 10.5, y, 5, 0.5); // panel lines
      glass(ctx, P, 11.2, 4, 3.6, 3, 1.2);
      glass(ctx, P, 11, 7.5, 4, 3.5, 1.4);
      // Engine nacelles either side of the mast.
      steel(ctx, P, 8, 14, 2.5, 6, 1);
      steel(ctx, P, 15.5, 14, 2.5, 6, 1);
      // Chin gun.
      rect(ctx, P.c(U.track), 12.4, 0, 1.2, 2.5);
    }],
    // Four blades and the Longbow radar dome on top of the mast.
    turret: [32, 32, (ctx, P) => {
      blades(ctx, P, 16, 16, 4, 15);
      circle(ctx, P.c(U.steelDark), 16, 16, 3.2);
      circle(ctx, P.c('#b9bba8'), 16, 16, 2.5);
      circle(ctx, P.c('#e2e3d6'), 15.3, 15.3, 1);
    }],
  },
};

/** Extra special sprites ([w, h, draw]), at most 8; see SPECIAL_SLOTS in sprites.js. */
export const HELI_SPECIALS = [
  // 0: rotor disc, the blur of spinning blades (radius 15 px for a 1-cell helicopter).
  [32, 32, (ctx, P) => {
    circle(ctx, P.c('rgba(30,30,28,0.22)'), 16, 16, 15.5);
    circle(ctx, P.c('rgba(30,30,28,0.18)'), 16, 16, 12);
    circle(ctx, P.c('rgba(40,40,36,0.16)'), 16, 16, 7.5);
    // Faint streaks so the rotation stays visible.
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      line(ctx, P.c('rgba(25,25,22,0.22)'), 2.4, 16, 16, 16 + Math.sin(a) * 15, 16 - Math.cos(a) * 15);
    }
    circle(ctx, P.c('rgba(210,210,200,0.25)'), 16, 16, 15.5 - 0.6);
    circle(ctx, P.c('rgba(30,30,28,0.22)'), 16, 16, 14.6);
  }],
  // 1: rotor wash, dust kicked up below a helicopter taking off or landing.
  [40, 40, (ctx, P) => {
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const r = 13 + (k % 3) * 2;
      circle(ctx, P.c('rgba(196,170,120,0.35)'), 20 + Math.cos(a) * r, 20 + Math.sin(a) * r, 3.5 + (k % 2));
    }
    circle(ctx, P.c('rgba(196,170,120,0.18)'), 20, 20, 12);
  }],
  // 2: black smoke trailing a falling wreck.
  [18, 18, (ctx, P) => {
    circle(ctx, P.c('rgba(40,38,36,0.55)'), 9, 10, 6);
    circle(ctx, P.c('rgba(60,58,55,0.5)'), 6, 7, 4);
    circle(ctx, P.c('rgba(70,68,64,0.45)'), 12, 6, 3.5);
    circle(ctx, P.c('rgba(230,120,30,0.6)'), 9, 12, 2);
  }],
];
