// Art for planes (2D minimal pack). Entries: id -> { body: [w, h, draw], turret?: [w, h, draw] },
// drawn facing north. Two to four flat shapes per plane (./unitkit.js): the wings and tailplane, the
// fuselage in team colour, the canopy, and the engines or propeller where they name the plane.
//
// The engine draws airborne planes raised by their altitude with a faint copy
// as the ground shadow (engine/src/render.rs), so the sprites carry no shadow
// and fill their whole box.

import { C, rect, rrect, circle, poly, line } from './kit.js';
import { M, TEAM, box, shape, sprite } from './unitkit.js';

export const PLANE_DRAW = {
  // Yak-9: a propeller fighter with straight wings.
  YAK: {
    body: sprite(26, 24, [
      [M.steel, box(0, 7, 26, 5.5, 1.5), box(7.5, 19.5, 11, 3.5, 1)],
      [TEAM, box(11, 1, 4, 23, 2)],
      [M.glass, box(11.6, 7.5, 2.8, 4, 1)],
      [M.dark, box(7, 0, 12, 1.6, 0.8)],
    ]),
  },
  // MiG: a swept-wing jet.
  MIG: {
    body: sprite(34, 36, [
      [M.steel, shape(17, 7, 34, 26, 34, 29, 17, 25, 0, 29, 0, 26), shape(17, 28, 24, 35, 10, 35)],
      [TEAM, box(15, 0, 4, 36, 2)],
      [M.glass, box(15.6, 7, 2.8, 5, 1.2)],
    ]),
  },
  // U-2 spy plane: long glider wings, a slim fuselage.
  U2: {
    body: sprite(42, 28, [
      [M.steel, box(0, 9, 42, 4, 1.8), box(14, 22, 14, 3, 1)],
      [TEAM, box(19.5, 0, 3, 28, 1.5)],
      [M.glass, box(20, 5, 2, 3, 0.8)],
    ]),
  },
  // Tu-16 Badger: a twin-jet bomber (paratroopers and parabombs), the engine nacelles beside the fuselage.
  BADR: {
    body: sprite(42, 40, [
      [M.steel, shape(21, 9, 42, 23, 42, 26, 21, 20, 0, 26, 0, 23), shape(21, 31, 32, 38, 10, 38)],
      [M.dark, box(11.8, 9, 4.4, 13, 2), box(25.8, 9, 4.4, 13, 2)],
      [TEAM, box(18.5, 0, 5, 40, 2.5)],
      [M.glass, box(19.3, 1, 3.4, 4, 1.5)],
    ]),
  },
};

/**
 * Extra special sprites ([w, h, draw]), at most 8; see SPECIAL_SLOTS in sprites.js.
 * Engine ids: `SpriteIds::planes_base + index` (engine/src/plane.rs, render_air_extras).
 */
export const PLANE_SPECIALS = [
  // 0: parachute canopy, drawn above a falling paratrooper (team stripes)
  [14, 11, (ctx, P) => {
    ctx.fillStyle = P.c('#e9e5d6');
    ctx.beginPath();
    ctx.ellipse(7, 5, 6.5, 4.5, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    for (const x of [3, 7, 11]) rect(ctx, P.team(0.75), x - 0.6, 0.8, 1.2, 4.2);
    rect(ctx, P.c('#b9b4a2'), 0.5, 4.6, 13, 0.8);
    for (const x of [1, 4.5, 9.5, 13]) line(ctx, P.c('rgba(60,60,50,0.8)'), 0.4, x, 5, 7, 10.5);
  }],
  // 1: parabomb: a bomb hanging under a small chute
  [8, 14, (ctx, P) => {
    ctx.fillStyle = P.c('#d9d4c2');
    ctx.beginPath();
    ctx.ellipse(4, 3.2, 3.6, 2.8, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    line(ctx, P.c('rgba(60,60,50,0.8)'), 0.4, 0.6, 3.2, 4, 7);
    line(ctx, P.c('rgba(60,60,50,0.8)'), 0.4, 7.4, 3.2, 4, 7);
    rrect(ctx, P.c(C.steelDark), 2.6, 6.5, 2.8, 6, 1.3);
    rect(ctx, P.c(C.steelLight), 3.1, 7.2, 0.8, 3);
    poly(ctx, P.c(C.steelDark), [2, 13.8, 6, 13.8, 4, 11.5]); // fins
  }],
  // 2: contrail puff
  [6, 6, (ctx, P) => {
    circle(ctx, P.c('rgba(235,240,245,0.55)'), 3, 3, 2.8);
    circle(ctx, P.c('rgba(255,255,255,0.7)'), 2.6, 2.6, 1.4);
  }],
  // 3: smoke puff of a falling wreck
  [8, 8, (ctx, P) => {
    circle(ctx, P.c('rgba(40,36,32,0.65)'), 4, 4, 3.8);
    circle(ctx, P.c('rgba(80,72,64,0.6)'), 3.2, 3.2, 2);
    circle(ctx, P.c('rgba(240,140,50,0.55)'), 4.6, 4.8, 1.1);
  }],
];
