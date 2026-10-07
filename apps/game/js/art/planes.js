// Art for planes (flat 1996 style). Entries: id -> { body: [w, h, draw], turret?: [w, h, draw] },
// drawn facing north. Helpers and palette come from ./kit.js.
//
// The engine draws airborne planes raised by their altitude with a faint copy
// as the ground shadow (engine/src/render.rs), so the sprites carry no shadow.

import { C, rect, rrect, circle, poly, line } from './kit.js';

const RED = '#c23a26';

/** Small five-point star (Soviet insignia). */
function star(ctx, P, cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  poly(ctx, P.c(RED), pts);
}

export const PLANE_DRAW = {
  // Yak-9: propeller fighter with straight wings.
  YAK: {
    body: [26, 24, (ctx, P) => {
      rrect(ctx, P.team(0.7), 1, 8, 24, 5, 2); // wings
      rect(ctx, P.team(0.45), 1.5, 11.5, 23, 1.2); // trailing edge
      rrect(ctx, P.team(0.6), 7.5, 18.5, 11, 3, 1); // tailplane
      rrect(ctx, P.c(C.steelDark), 11, 2, 4, 20.5, 2); // fuselage outline
      rrect(ctx, P.team(0.55), 11.5, 2.5, 3, 19.5, 1.5);
      rect(ctx, P.team(0.85), 12, 3, 2, 4); // cowling highlight
      rrect(ctx, P.c(C.glass), 12, 8, 2, 3.5, 1); // canopy
      rect(ctx, P.c(C.steelDark), 12.6, 19, 0.8, 4); // fin
      star(ctx, P, 4.5, 10.5, 1.8);
      star(ctx, P, 21.5, 10.5, 1.8);
      // Spinning propeller: a blurred disc and the spinner.
      rect(ctx, P.c('rgba(40,40,40,0.45)'), 8, 1.2, 10, 1);
      circle(ctx, P.c(C.steelLight), 13, 2, 1.3);
    }],
  },
  // MiG: swept-wing jet with a pointed nose.
  MIG: {
    body: [28, 30, (ctx, P) => {
      poly(ctx, P.c(C.steelDark), [14, 6, 27, 21, 27, 24, 14, 20, 1, 24, 1, 21]); // wing outline
      poly(ctx, P.team(0.68), [14, 7.5, 25.5, 21, 25.5, 22.5, 14, 19, 2.5, 22.5, 2.5, 21]);
      poly(ctx, P.team(0.5), [14, 22, 20, 28, 8, 28]); // tailplane
      rrect(ctx, P.c(C.steelDark), 12.2, 1, 3.6, 27, 1.8); // fuselage
      rrect(ctx, P.team(0.55), 12.7, 2, 2.6, 25, 1.3);
      poly(ctx, P.c(C.steelLight), [14, 0, 15.6, 3, 12.4, 3]); // nose cone
      rrect(ctx, P.c(C.glass), 13, 6, 2, 4.5, 1); // canopy
      rect(ctx, P.c(C.steelDark), 13.6, 21, 0.8, 7); // fin
      rect(ctx, P.c('#3a2a20'), 12.8, 27.5, 2.4, 1.5); // exhaust
      star(ctx, P, 6, 21, 1.8);
      star(ctx, P, 22, 21, 1.8);
      // Missile pylons under the wings.
      for (const x of [7.5, 20.5]) rect(ctx, P.c('#e8e6dc'), x - 0.5, 15, 1, 5);
    }],
  },
  // U-2 spy plane: long glider wings, slim dark fuselage.
  U2: {
    body: [42, 28, (ctx, P) => {
      rrect(ctx, P.c(C.steelDark), 0.5, 9, 41, 3.6, 1.8); // wings
      rrect(ctx, P.team(0.5), 1, 9.5, 40, 2.6, 1.3);
      rect(ctx, P.team(0.8), 1.5, 9.5, 39, 0.8);
      rrect(ctx, P.c(C.steelDark), 14, 22, 14, 3, 1); // tailplane
      rrect(ctx, P.c(C.steelDark), 19.5, 1, 3, 26, 1.5); // fuselage
      rrect(ctx, P.c('#3d4044'), 20, 1.5, 2, 25, 1);
      rrect(ctx, P.c(C.glass), 20.2, 5, 1.6, 3, 0.8); // canopy
      rect(ctx, P.team(0.9), 20, 14, 2, 1.5); // team band
      rect(ctx, P.c(C.steelLight), 20.6, 22, 0.8, 5); // fin
      // Camera window and wing-tip skids.
      circle(ctx, P.c('#9fd0e8'), 21, 11, 0.8);
      rect(ctx, P.c(C.steelLight), 0.5, 10, 1, 2);
      rect(ctx, P.c(C.steelLight), 40.5, 10, 1, 2);
    }],
  },
  // Tu-16 Badger: twin-jet bomber (paratroopers and parabombs).
  BADR: {
    body: [42, 40, (ctx, P) => {
      poly(ctx, P.c(C.steelDark), [21, 9, 41, 22, 41, 25, 21, 19, 1, 25, 1, 22]); // wing outline
      poly(ctx, P.team(0.62), [21, 10.5, 39.5, 22, 39.5, 23.5, 21, 18, 2.5, 23.5, 2.5, 22]);
      for (const x of [14, 28]) {
        rrect(ctx, P.c(C.steelDark), x - 2.2, 10, 4.4, 12, 2); // engine nacelles
        rrect(ctx, P.team(0.45), x - 1.6, 10.5, 3.2, 11, 1.5);
        circle(ctx, P.c(C.track), x, 11, 1.2);
      }
      poly(ctx, P.team(0.5), [21, 30, 31, 37, 11, 37]); // tailplane
      rrect(ctx, P.c(C.steelDark), 18.5, 1, 5, 38, 2.5); // fuselage
      rrect(ctx, P.team(0.55), 19.2, 2, 3.6, 36, 1.8);
      rrect(ctx, P.c(C.glass), 19.6, 1.5, 2.8, 4, 1.4); // glazed nose
      rrect(ctx, P.c(C.glass), 19.8, 7, 2.4, 2.5, 1); // cockpit
      rect(ctx, P.c(C.steelDark), 20.6, 29, 0.8, 10); // fin
      rect(ctx, P.c(C.steelDark), 19.5, 36.5, 3, 2); // tail gun
      star(ctx, P, 7, 23, 2);
      star(ctx, P, 35, 23, 2);
    }],
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
