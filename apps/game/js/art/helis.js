// Art for helicopters (2D minimal pack). Entries: id -> { body: [w, h, draw], turret?: [w, h, draw] },
// drawn facing north. Two to four flat shapes per helicopter, rotor included (./unitkit.js): the
// airframe (tail boom, fin, stub wings), the fuselage in team colour, the glass cockpit and the
// rotor. No shadow: the engine draws one under every aircraft (engine/src/render.rs).
//
// The "turret" of a helicopter is its rotor: the engine spins it every tick
// (fast in the air, slowly on the ground) and draws it once per rotor (the
// Chinook has two). In the air it is drawn faint over the blurred disc of
// HELI_SPECIALS[0], so the blades read as a spinning blur.

import { circle, line } from './kit.js';
import { M, TEAM, box, disc, shape, sprite, blade } from './unitkit.js';
import { pixelUnitDraw } from './pixel.js';

/** A rotor centred in an s x s sprite: `n` dark blades round a hub of radius `hub`. Not team coloured. */
function rotor(s, n, width, hub = 2) {
  const c = s / 2;
  const blades = Array.from({ length: n }, (_, k) => blade(c, c, (k / n) * Math.PI * 2, c - 0.6, width));
  return sprite(s, s, [[M.dark, ...blades, disc(c, c, hub)]]);
}

/** A gunship's tail boom with its fin and its stub wings (the fuselage over them is the caller's). */
function airframe(w, h, wingY) {
  const c = w / 2;
  return [M.steel, box(c - 1.2, 20, 2.4, h - 20), box(c - 5, h - 4, 10, 3, 1), box(0, wingY, w, 4.5, 1.5)];
}

/** A gunship's pointed fuselage, `half` wide each side of the centre line. */
function fuselage(w, half) {
  const c = w / 2;
  return [TEAM, shape(c, 0, c + half, 5.5, c + half, 22, c, 26, c - half, 22, c - half, 5.5)];
}

export const HELI_DRAW = {
  // Chinook: a long twin-rotor transport.
  TRAN: {
    body: sprite(20, 40, [
      [M.steel, box(0, 0, 20, 40, 6)],
      [TEAM, box(7, 8, 6, 24, 1.5)],
      [M.glass, box(4.5, 1.5, 11, 4, 2)],
    ]),
    turret: rotor(24, 3, 1.6),
  },
  // Hind: a gunship with a tandem glass cockpit and stub wings.
  HIND: {
    body: sprite(28, 34, [airframe(28, 34, 12), fuselage(28, 4.5), [M.glass, box(12, 3, 4, 7.5, 2)]]),
    turret: rotor(34, 5, 1.8),
  },
  // Black Hawk: WebRA's own pixel art in Red Alert's style (art/pixel.js),
  // the stopped rotor over it.
  MH60: pixelUnitDraw('MH60'),
  // Longbow (Apache): a slim gunship, the radar dome on the mast.
  HELI: {
    body: sprite(26, 34, [airframe(26, 34, 11), fuselage(26, 3.6), [M.glass, box(11.2, 3, 3.6, 7, 1.8)]]),
    turret: rotor(32, 4, 1.8, 3.2),
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
