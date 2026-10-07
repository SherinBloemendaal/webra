// Procedural sprite atlas. Every unit and building is drawn with flat shapes in
// the spirit of the 1996 game: plain, readable silhouettes instead of detailed
// textures. Team-coloured parts are painted grey into the colour atlas and white
// into a separate mask, so the shader can tint them for any player.

const RES = 2; // atlas pixels per world pixel
const PAD = 2;

// Palette (non-team colours).
import {
  C,
  rect,
  rrect,
  circle,
  poly,
  line,
  bib,
  block,
  ring,
  polyline,
  ngon,
  hazard,
  trefoil,
  tracks,
  wheels,
  truck,
  dish,
  pod,
  drum,
  barrel,
  teslaHead,
  crate,
} from './art/kit.js';
import { NAVAL_DRAW, NAVAL_SPECIALS } from './art/naval.js';
import { PLANE_DRAW, PLANE_SPECIALS } from './art/planes.js';
import { HELI_DRAW, HELI_SPECIALS } from './art/helis.js';
import { ABILITY_SPECIALS } from './art/abilities.js';

const UNIT_DRAW = {
  '1TNK': {
    body: [22, 22, (ctx, P) => {
      tracks(ctx, P, 2, 2, 5, 18);
      tracks(ctx, P, 15, 2, 5, 18);
      rrect(ctx, P.team(0.55), 6, 4, 10, 16, 2);
      rect(ctx, P.team(0.8), 7, 4, 8, 4);
      rect(ctx, P.team(0.4), 7, 17, 8, 2);
    }],
    turret: [22, 22, (ctx, P) => {
      rect(ctx, P.c(C.steelDark), 10, 0, 2, 10);
      circle(ctx, P.c(C.steelDark), 11, 12, 5);
      circle(ctx, P.team(0.85), 11, 12, 4.2);
      circle(ctx, P.team(1.0), 10, 11, 1.6);
    }],
  },
  '3TNK': {
    body: [26, 26, (ctx, P) => {
      tracks(ctx, P, 1, 1, 7, 24);
      tracks(ctx, P, 18, 1, 7, 24);
      rrect(ctx, P.team(0.5), 7, 3, 12, 21, 2);
      rect(ctx, P.team(0.75), 8, 3, 10, 5);
      rect(ctx, P.team(0.35), 8, 21, 10, 2);
    }],
    turret: [26, 26, (ctx, P) => {
      rect(ctx, P.c(C.steelDark), 10, 0, 2, 11);
      rect(ctx, P.c(C.steelDark), 14, 0, 2, 11);
      rrect(ctx, P.c(C.steelDark), 6.5, 8.5, 13, 12, 3);
      rrect(ctx, P.team(0.8), 7.5, 9.5, 11, 10, 2.5);
      rect(ctx, P.team(1.0), 9, 11, 3, 2);
    }],
  },
  HARV: {
    body: [24, 28, (ctx, P) => {
      tracks(ctx, P, 1, 3, 5, 23);
      tracks(ctx, P, 18, 3, 5, 23);
      // cab at the front
      rrect(ctx, P.team(0.65), 5, 1, 14, 8, 2);
      rect(ctx, P.c(C.glass), 7, 2, 10, 3);
      // ore hopper
      rrect(ctx, P.c(C.steel), 5, 10, 14, 16, 1.5);
      rect(ctx, P.c(C.yellowDark), 6.5, 11.5, 11, 13);
      for (let i = 0; i < 9; i++) circle(ctx, P.c(C.ore), 8 + (i % 3) * 4, 13.5 + Math.floor(i / 3) * 4, 1.2);
      rect(ctx, P.team(0.45), 5, 24, 14, 2);
    }],
  },
  E1: {
    body: [10, 12, (ctx, P) => {
      rect(ctx, P.c(C.steelDark), 6.5, 0, 1, 6); // rifle
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      poly(ctx, P.team(0.7), [1.5, 5.5, 8.5, 5.5, 8, 9.5, 2, 9.5]);
      circle(ctx, P.team(0.55), 5, 6, 2.2);
      circle(ctx, P.c('#5d6b3a'), 5, 5.5, 1.7); // helmet
    }],
  },
  // Rocket soldier: an E1 silhouette with a launch tube over the right shoulder.
  E3: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      poly(ctx, P.team(0.7), [1.5, 5.5, 8.5, 5.5, 8, 9.5, 2, 9.5]);
      rect(ctx, P.c(C.steelDark), 6.2, 0.5, 2, 9); // launcher
      rect(ctx, P.c(C.steelLight), 6.6, 0.5, 1.2, 1.2);
      circle(ctx, P.team(0.55), 5, 6, 2.2);
      circle(ctx, P.c('#5d6b3a'), 4.6, 5.5, 1.7); // helmet
    }],
  },
  JEEP: {
    body: [18, 22, (ctx, P) => {
      wheels(ctx, P, 18, [3, 15]);
      rrect(ctx, P.c(C.steelDark), 3, 2, 12, 19, 3);
      rrect(ctx, P.team(0.55), 3.5, 2.5, 11, 18, 2.5);
      rect(ctx, P.team(0.8), 4.5, 2.5, 9, 4.5); // hood
      rect(ctx, P.c(C.glass), 4.5, 7.5, 9, 1.8); // windscreen
      rect(ctx, P.team(0.4), 4.5, 17.5, 9, 2); // tailgate
      circle(ctx, P.c(C.yellow), 5.5, 3.2, 0.8);
      circle(ctx, P.c(C.yellow), 12.5, 3.2, 0.8);
    }],
    turret: [18, 22, (ctx, P) => {
      rect(ctx, P.c(C.steelDark), 8.5, 3, 1, 9); // M60
      circle(ctx, P.c(C.steelDark), 9, 12.5, 2.8);
      circle(ctx, P.team(0.9), 9, 12.5, 2);
      circle(ctx, P.c('#5d6b3a'), 9, 13.5, 1.3); // gunner's helmet
    }],
  },
  APC: {
    body: [22, 24, (ctx, P) => {
      tracks(ctx, P, 1, 2, 5, 21);
      tracks(ctx, P, 16, 2, 5, 21);
      rrect(ctx, P.team(0.5), 5, 4, 12, 19, 2);
      poly(ctx, P.team(0.78), [5, 9, 7, 3, 15, 3, 17, 9]); // sloped glacis
      rect(ctx, P.team(0.62), 6, 9, 10, 1);
      rect(ctx, P.c(C.steelDark), 10.5, 0, 1, 5); // bow MG
      circle(ctx, P.c(C.steelDark), 11, 5.5, 1.6);
      for (const y of [12, 16]) {
        rect(ctx, P.team(0.38), 7, y, 3, 3);
        rect(ctx, P.team(0.38), 12, y, 3, 3);
      }
      rect(ctx, P.team(0.32), 7, 20.5, 8, 2); // rear door
    }],
  },
  FTRK: {
    body: [20, 24, (ctx, P) => {
      const bed = truck(ctx, P, 20, 24, [3, 10, 17]);
      rrect(ctx, P.team(0.5), 3.5, bed, 13, 22 - bed, 1);
      rect(ctx, P.team(0.38), 3.5, 20, 13, 2);
      for (const x of [4.5, 13.5]) rect(ctx, P.c(C.steel), x, bed + 1, 2, 9); // outriggers
    }],
    turret: [20, 24, (ctx, P) => {
      rect(ctx, P.c(C.steelDark), 7.6, 2, 1.6, 9);
      rect(ctx, P.c(C.steelDark), 10.8, 2, 1.6, 9);
      rect(ctx, P.c(C.steelDark), 7, 2, 6, 1.5); // flak muzzles
      rrect(ctx, P.c(C.steelDark), 5, 10, 10, 9, 2);
      rrect(ctx, P.team(0.82), 6, 11, 8, 7, 1.5);
      rect(ctx, P.team(1.0), 7, 12, 2.5, 1.5);
    }],
  },
  '2TNK': {
    body: [24, 24, (ctx, P) => {
      tracks(ctx, P, 1, 1, 6, 22);
      tracks(ctx, P, 17, 1, 6, 22);
      rrect(ctx, P.team(0.5), 6, 3, 12, 19, 2);
      rect(ctx, P.team(0.78), 7, 3, 10, 4.5);
      rect(ctx, P.team(0.35), 7, 19.5, 10, 2);
    }],
    turret: [24, 24, (ctx, P) => {
      barrel(ctx, P, 11, 0, 9, 2);
      drum(ctx, P, 12, 13, 5.6);
      circle(ctx, P.c(C.steelDark), 13.8, 15, 1.3); // hatch
    }],
  },
  V2RL: {
    body: [22, 28, (ctx, P) => {
      const bed = truck(ctx, P, 22, 28, [3, 13, 20]);
      rrect(ctx, P.team(0.5), 3.5, bed, 15, 26 - bed, 1);
      rect(ctx, P.team(0.36), 3.5, 24, 15, 2);
      rect(ctx, P.c(C.steel), 9.5, bed - 1, 3, 26 - bed); // launch rail
      // V2 rocket on the rail
      rrect(ctx, P.c('#e8e6dc'), 9.6, 5, 2.8, 16, 1.4);
      poly(ctx, P.c('#c23a26'), [9.6, 6.5, 11, 3, 12.4, 6.5]);
      rect(ctx, P.c('#b8b6ac'), 11.4, 7, 1, 13); // shaded side
      poly(ctx, P.c(C.steelDark), [9.6, 18, 7.5, 22, 9.6, 21]);
      poly(ctx, P.c(C.steelDark), [12.4, 18, 14.5, 22, 12.4, 21]);
    }],
  },
  ARTY: {
    body: [22, 26, (ctx, P) => {
      tracks(ctx, P, 1, 7, 5, 18);
      tracks(ctx, P, 16, 7, 5, 18);
      rrect(ctx, P.team(0.5), 5, 9, 12, 15, 2);
      rect(ctx, P.team(0.35), 6, 21.5, 10, 2);
      rect(ctx, P.c(C.steelDark), 7.5, 23.5, 7, 2.5); // recoil spade
      rrect(ctx, P.c(C.steelDark), 5.5, 9.5, 11, 7, 1.5);
      rrect(ctx, P.team(0.78), 6.5, 10, 9, 6, 1.5); // gun shield
      barrel(ctx, P, 10.1, 0, 14, 1.8);
      circle(ctx, P.c(C.steelDark), 11, 15, 2);
    }],
  },
  MNLY: {
    body: [22, 24, (ctx, P) => {
      tracks(ctx, P, 1, 1, 5, 22);
      tracks(ctx, P, 16, 1, 5, 22);
      rrect(ctx, P.team(0.5), 5, 2, 12, 20, 2);
      poly(ctx, P.team(0.78), [5, 7, 7, 2, 15, 2, 17, 7]);
      rect(ctx, P.c(C.glass), 8, 4, 6, 1.5);
      // mine racks
      rrect(ctx, P.c(C.steelDark), 6, 10, 10, 11, 1);
      for (let i = 0; i < 6; i++) {
        const x = 8.5 + (i % 2) * 5;
        const y = 12 + Math.floor(i / 2) * 3.3;
        circle(ctx, P.c('#6a6a48'), x, y, 1.5);
        circle(ctx, P.c(C.track), x, y, 0.6);
      }
      rect(ctx, P.team(0.35), 6, 21, 10, 1.5);
    }],
  },
  '4TNK': {
    body: [30, 30, (ctx, P) => {
      tracks(ctx, P, 0.5, 1, 8, 28);
      tracks(ctx, P, 21.5, 1, 8, 28);
      rrect(ctx, P.team(0.48), 7, 3, 16, 25, 2);
      rect(ctx, P.team(0.74), 8, 3, 14, 5);
      rect(ctx, P.team(0.34), 8, 25, 14, 2);
      for (const x of [9, 19]) rect(ctx, P.c(C.steelDark), x, 22, 2, 2); // exhausts
    }],
    turret: [30, 30, (ctx, P) => {
      barrel(ctx, P, 11.2, 0, 12, 2.2);
      barrel(ctx, P, 16.6, 0, 12, 2.2);
      pod(ctx, P, 2, 11, 5.5, 9, 2, 3);
      pod(ctx, P, 22.5, 11, 5.5, 9, 2, 3);
      rrect(ctx, P.c(C.steelDark), 7.5, 9.5, 15, 14, 3);
      rrect(ctx, P.team(0.8), 8.5, 10.5, 13, 12, 2.5);
      rect(ctx, P.team(1.0), 10, 12, 4, 2);
      circle(ctx, P.c(C.steelDark), 18, 19, 1.6);
    }],
  },
  MRJ: {
    body: [20, 26, (ctx, P) => {
      const bed = truck(ctx, P, 20, 26, [3, 11, 19]);
      rrect(ctx, P.c(C.steel), 3.5, bed, 13, 24 - bed, 1);
      rect(ctx, P.team(0.5), 3.5, 22, 13, 2);
      line(ctx, P.c(C.steelDark), 0.8, 5, 20, 5, 11); // whip antennas
      line(ctx, P.c(C.steelDark), 0.8, 15, 20, 15, 11);
      dish(ctx, P, 10, 16, 5.5);
    }],
  },
  MGG: {
    body: [20, 26, (ctx, P) => {
      const bed = truck(ctx, P, 20, 26, [3, 11, 19]);
      rrect(ctx, P.team(0.5), 3.5, bed, 13, 24 - bed, 1);
      rect(ctx, P.team(0.35), 3.5, 22, 13, 2);
      // gap emitter: dark orb with a cross-bar array
      rect(ctx, P.c(C.steelDark), 2, 14.5, 16, 3);
      rect(ctx, P.c(C.steelLight), 2.5, 15, 15, 1);
      circle(ctx, P.c(C.steelDark), 10, 16, 4.5);
      circle(ctx, P.c('#2c2a3e'), 10, 16, 3.6);
      circle(ctx, P.c('#5a5680'), 9, 15, 1.2);
    }],
  },
  TTNK: {
    body: [24, 24, (ctx, P) => {
      tracks(ctx, P, 1, 1, 6, 22);
      tracks(ctx, P, 17, 1, 6, 22);
      rrect(ctx, P.team(0.45), 6, 3, 12, 19, 2);
      rect(ctx, P.team(0.7), 7, 3, 10, 4);
      rect(ctx, P.team(0.32), 7, 19.5, 10, 2);
    }],
    turret: [24, 24, (ctx, P) => {
      rrect(ctx, P.c(C.steelDark), 6, 6.5, 12, 12, 3);
      rrect(ctx, P.team(0.78), 7, 7.5, 10, 10, 2.5);
      teslaHead(ctx, P, 12, 12, 3.6);
      rect(ctx, P.c(C.steelLight), 11.3, 4, 1.4, 3); // emitter prong
    }],
  },
  DTRK: {
    body: [20, 24, (ctx, P) => {
      const bed = truck(ctx, P, 20, 24, [3, 10, 17]);
      rect(ctx, P.team(0.4), 3.5, bed, 13, 22 - bed);
      rect(ctx, P.c(C.track), 4, bed + 0.5, 12, 12.5);
      hazard(ctx, P, 4.5, bed + 1, 11, 11.5, 2);
      rect(ctx, P.c(C.yellow), 6, bed + 2.5, 8, 8.5);
      trefoil(ctx, P, 10, bed + 6.75, 3.6);
    }],
  },
  CTNK: {
    body: [24, 26, (ctx, P) => {
      tracks(ctx, P, 2, 3, 5, 21);
      tracks(ctx, P, 17, 3, 5, 21);
      poly(ctx, P.c(C.steelDark), [12, 0.5, 18.5, 5, 18.5, 22, 15, 25.5, 9, 25.5, 5.5, 22, 5.5, 5]);
      poly(ctx, P.team(0.55), [12, 1.5, 17.5, 5.5, 17.5, 21.5, 14.5, 24.5, 9.5, 24.5, 6.5, 21.5, 6.5, 5.5]);
      poly(ctx, P.team(0.82), [12, 1.5, 17.5, 5.5, 6.5, 5.5]);
      // chrono core
      circle(ctx, P.c('rgba(90,220,240,0.45)'), 12, 14, 4.4);
      circle(ctx, P.c('#5fd8ea'), 12, 14, 3);
      circle(ctx, P.c('#e4fbff'), 11.2, 13.2, 1.1);
      // missile pods on the flanks
      pod(ctx, P, 0.5, 9, 5, 9, 1, 3);
      pod(ctx, P, 18.5, 9, 5, 9, 1, 3);
    }],
  },
  STNK: {
    body: [24, 26, (ctx, P) => {
      tracks(ctx, P, 1, 2, 5, 23);
      tracks(ctx, P, 18, 2, 5, 23);
      poly(ctx, P.c(C.steelDark), [7, 1, 17, 1, 19.5, 5, 19.5, 25, 4.5, 25, 4.5, 5]);
      poly(ctx, P.team(0.5), [7.5, 2, 16.5, 2, 18.5, 5.5, 18.5, 24, 5.5, 24, 5.5, 5.5]);
      poly(ctx, P.team(0.76), [7.5, 2, 16.5, 2, 18.5, 5.5, 5.5, 5.5]);
      rect(ctx, P.team(0.36), 5.5, 21.5, 13, 2.5);
      for (const y of [8, 19]) rect(ctx, P.team(0.62), 5.5, y, 13, 0.8); // panel seams
    }],
    turret: [24, 26, (ctx, P) => {
      rrect(ctx, P.c(C.steelDark), 8, 9, 8, 9, 2);
      rrect(ctx, P.team(0.82), 8.8, 9.8, 6.4, 7.4, 1.5);
      rect(ctx, P.c(C.steel), 11, 2.5, 2, 9); // launch tube
      rect(ctx, P.c('#e8e6dc'), 11.3, 2, 1.4, 3);
      poly(ctx, P.c('#c23a26'), [11.3, 2.2, 12, 0.8, 12.7, 2.2]);
    }],
  },
  TRUK: {
    body: [20, 26, (ctx, P) => {
      const bed = truck(ctx, P, 20, 26, [3, 11, 19]);
      rrect(ctx, P.team(0.45), 3.5, bed, 13, 24 - bed, 1);
      for (let i = 0; i < 6; i++) crate(ctx, P, 4.5 + (i % 2) * 5.8, bed + 1 + Math.floor(i / 2) * 4.4, 5.2, 4);
    }],
  },
  QTNK: {
    body: [26, 26, (ctx, P) => {
      tracks(ctx, P, 1, 1, 6, 24);
      tracks(ctx, P, 19, 1, 6, 24);
      rect(ctx, P.c(C.steelDark), 6, 2, 14, 23);
      rect(ctx, P.team(0.5), 6.5, 2.5, 13, 22);
      rect(ctx, P.team(0.78), 6.5, 2.5, 13, 3.5);
      rect(ctx, P.team(0.34), 6.5, 22, 13, 2.5);
      // seismic hammer
      circle(ctx, P.c(C.steelDark), 13, 14, 6.2);
      ctx.save();
      ctx.beginPath();
      ctx.arc(13, 14, 5.6, 0, Math.PI * 2);
      ctx.clip();
      hazard(ctx, P, 7, 8, 12, 12, 2);
      ctx.restore();
      circle(ctx, P.c(C.steel), 13, 14, 3.6);
      circle(ctx, P.c(C.steelLight), 12.2, 13.2, 1.6);
    }],
  },
  MCV: {
    body: [30, 34, (ctx, P) => {
      wheels(ctx, P, 30, [4, 12, 21, 27], 4, 5);
      rrect(ctx, P.c(C.steelDark), 3.5, 1, 23, 32, 2);
      rrect(ctx, P.team(0.55), 4.5, 9, 21, 23, 1.5);
      rect(ctx, P.team(0.38), 4.5, 29.5, 21, 2.5);
      // cab
      rrect(ctx, P.team(0.68), 4.5, 1.5, 21, 7, 2);
      rect(ctx, P.team(0.88), 5.5, 1.5, 19, 1.5);
      rect(ctx, P.c(C.glass), 6, 3.5, 18, 2.5);
      // folded crane: turntable at the rear, lattice boom laid forward
      circle(ctx, P.c(C.yellowDark), 15, 24, 5.5);
      circle(ctx, P.c(C.yellow), 15, 24, 4.3);
      rect(ctx, P.c(C.yellowDark), 12.5, 9, 5, 15);
      rect(ctx, P.c(C.yellow), 13, 9, 4, 15);
      for (let y = 10; y < 23; y += 3) line(ctx, P.c(C.yellowDark), 0.6, 13, y, 17, y + 2.5);
      rect(ctx, P.c(C.steelDark), 14, 7.5, 2, 2.5); // hook
      circle(ctx, P.c(C.steelDark), 15, 24, 1.4);
    }],
  },
};

// Ships, planes and helicopters are drawn in their own modules (art/*.js).
Object.assign(UNIT_DRAW, NAVAL_DRAW, PLANE_DRAW, HELI_DRAW);

// ---- Buildings ----------------------------------------------------------------

const BUILDING_DRAW = {
  FACT: (ctx, P) => {
    bib(ctx, P, 0, 72, 72, 24);
    rect(ctx, P.c(C.shadow), 4, 4, 70, 70);
    rect(ctx, P.c(C.concreteDark), 0, 0, 72, 72);
    rect(ctx, P.c(C.concrete), 2, 2, 68, 66);
    // main hall
    block(ctx, P, 6, 8, 40, 50, P.team(0.6), P.team(0.35), 7);
    for (let x = 10; x < 44; x += 6) rect(ctx, P.team(0.75), x, 10, 2, 38);
    rect(ctx, P.c(C.steelDark), 18, 51, 16, 7);
    // crane
    circle(ctx, P.c(C.yellowDark), 58, 54, 7);
    circle(ctx, P.c(C.yellow), 58, 54, 5);
    line(ctx, P.c(C.yellowDark), 5, 58, 54, 60, 12);
    line(ctx, P.c(C.yellow), 3, 58, 54, 60, 12);
    rect(ctx, P.c(C.steelDark), 58, 10, 4, 8);
    // landing lights
    circle(ctx, P.team(1.0), 66, 6, 2);
    circle(ctx, P.team(1.0), 6, 64, 2);
  },
  POWR: (ctx, P) => {
    bib(ctx, P, 0, 48, 48, 24);
    block(ctx, P, 2, 4, 44, 44, P.c(C.concrete), P.c(C.concreteDark), 6);
    rect(ctx, P.team(0.6), 4, 26, 40, 12);
    rect(ctx, P.team(0.85), 4, 26, 40, 3);
    for (const x of [14, 34]) {
      circle(ctx, P.c(C.steelDark), x, 15, 9);
      circle(ctx, P.c(C.steelLight), x, 15, 7.5);
      circle(ctx, P.c(C.steelDark), x, 15, 4);
    }
  },
  PROC: (ctx, P) => {
    // row 0: silo in the middle; row 1: plant; rows 2-3: dock pad
    bib(ctx, P, 0, 48, 72, 48);
    for (let x = 30; x < 42; x += 4) rect(ctx, P.c(C.yellow), x, 52, 2, 18);
    rect(ctx, P.c(C.shadow), 4, 28, 70, 24);
    block(ctx, P, 0, 24, 72, 26, P.c(C.concrete), P.c(C.concreteDark), 6);
    rect(ctx, P.team(0.6), 4, 28, 26, 14);
    rect(ctx, P.team(0.6), 42, 28, 26, 14);
    rect(ctx, P.c(C.steelDark), 0, 50, 24, 22);
    rect(ctx, P.c(C.steel), 2, 52, 20, 18);
    circle(ctx, P.c(C.shadow), 38, 16, 13);
    circle(ctx, P.c(C.concreteDark), 36, 14, 13);
    circle(ctx, P.team(0.7), 36, 14, 11);
    circle(ctx, P.team(0.95), 32, 10, 4);
  },
  TENT: (ctx, P) => {
    bib(ctx, P, 0, 48, 48, 24);
    rect(ctx, P.c(C.shadow), 6, 6, 42, 42);
    poly(ctx, P.c(C.canvasDark), [4, 44, 24, 6, 44, 44]);
    poly(ctx, P.c(C.canvas), [4, 44, 24, 6, 24, 44]);
    rect(ctx, P.c(C.canvasDark), 22, 6, 2, 38);
    rect(ctx, P.c(C.track), 20, 34, 8, 10);
    rect(ctx, P.c(C.steelDark), 40, 4, 1.5, 20);
    rect(ctx, P.team(0.9), 41.5, 4, 6, 5);
  },
  BARR: (ctx, P) => {
    bib(ctx, P, 0, 48, 48, 24);
    block(ctx, P, 3, 4, 42, 42, P.c(C.concreteDark), P.c(C.seam), 7);
    rect(ctx, P.team(0.55), 7, 8, 34, 22);
    poly(ctx, P.team(1.0), [24, 11, 26.5, 17, 33, 17, 28, 21, 30, 27, 24, 23, 18, 27, 20, 21, 15, 17, 21.5, 17]);
    rect(ctx, P.c(C.track), 19, 36, 10, 7);
    for (let x = 4; x < 44; x += 6) circle(ctx, P.c(C.canvas), x + 2, 46, 2.4);
  },
  WEAP: (ctx, P) => {
    bib(ctx, P, 0, 48, 72, 24);
    rect(ctx, P.c(C.shadow), 4, 4, 70, 48);
    rect(ctx, P.c(C.concreteDark), 0, 0, 72, 50);
    // arched hangar roof
    for (let i = 0; i < 6; i++) rect(ctx, P.team(i % 2 ? 0.55 : 0.7), 4, 4 + i * 6, 64, 6);
    rect(ctx, P.c(C.concreteDark), 0, 40, 72, 10);
    rect(ctx, P.c(C.track), 24, 38, 24, 12);
    for (let y = 40; y < 50; y += 3) rect(ctx, P.c(C.steelDark), 24, y, 24, 1);
    circle(ctx, P.c(C.yellow), 20, 45, 1.6);
    circle(ctx, P.c(C.yellow), 52, 45, 1.6);
  },
  FIX: (ctx, P) => {
    // plus-shaped repair pad
    const pad = (x, y) => bib(ctx, P, x, y, 24, 24);
    pad(24, 0);
    pad(0, 24);
    pad(24, 24);
    pad(48, 24);
    pad(24, 48);
    circle(ctx, P.c(C.concreteDark), 36, 36, 10);
    circle(ctx, P.team(0.7), 36, 36, 8);
    line(ctx, P.c(C.steelDark), 3, 31, 41, 41, 31);
    circle(ctx, P.c(C.steelDark), 41, 31, 3);
    circle(ctx, P.team(0.7), 42, 30, 1.4);
    for (const [x, y] of [[28, 4], [44, 4], [4, 28], [4, 44], [68, 28], [68, 44], [28, 68], [44, 68]]) circle(ctx, P.c(C.yellow), x, y, 1.6);
  },
  DOME: (ctx, P) => {
    // rows 0-1: radar building, row 2: bib
    bib(ctx, P, 0, 48, 48, 24);
    block(ctx, P, 3, 5, 42, 42, P.c(C.concrete), P.c(C.concreteDark), 6);
    rect(ctx, P.team(0.55), 5, 33, 38, 3);
    rect(ctx, P.c(C.track), 19, 40, 10, 6); // door
    circle(ctx, P.c(C.shadow), 26, 22, 15);
    circle(ctx, P.c(C.concreteDark), 24, 20, 15);
    circle(ctx, P.team(0.62), 24, 20, 13.5);
    ring(ctx, P.team(0.45), 24, 20, 8, 1);
    rect(ctx, P.team(0.45), 23.5, 7, 1, 26);
    circle(ctx, P.team(0.92), 19, 15, 4.5);
    dish(ctx, P, 39, 9, 4);
  },
  APWR: (ctx, P) => {
    bib(ctx, P, 0, 48, 72, 24);
    block(ctx, P, 2, 3, 68, 45, P.c(C.concrete), P.c(C.concreteDark), 7);
    rect(ctx, P.team(0.6), 4, 28, 64, 10);
    rect(ctx, P.team(0.85), 4, 28, 64, 2.5);
    for (let x = 8; x < 66; x += 8) rect(ctx, P.c(C.steelDark), x, 32, 4, 4); // vents
    for (const x of [14, 36, 58]) {
      circle(ctx, P.c(C.steelDark), x, 15, 9.5);
      circle(ctx, P.c(C.steelLight), x, 15, 8);
      circle(ctx, P.c(C.steelDark), x, 15, 5);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 4;
        line(ctx, P.c(C.steel), 1, x - Math.cos(a) * 4.5, 15 - Math.sin(a) * 4.5, x + Math.cos(a) * 4.5, 15 + Math.sin(a) * 4.5);
      }
      circle(ctx, P.c(C.steelLight), x, 15, 1.5);
    }
  },
  HPAD: (ctx, P) => {
    bib(ctx, P, 0, 48, 48, 24);
    rect(ctx, P.c(C.shadow), 2, 2, 47, 47);
    rect(ctx, P.c(C.concreteDark), 0, 0, 48, 48);
    rect(ctx, P.c(C.concrete), 2, 2, 44, 44);
    circle(ctx, P.c(C.yellowDark), 24, 24, 18);
    circle(ctx, P.c(C.concrete), 24, 24, 16);
    rect(ctx, P.team(0.85), 16, 14, 4, 20); // H
    rect(ctx, P.team(0.85), 28, 14, 4, 20);
    rect(ctx, P.team(0.85), 16, 22, 16, 4);
    for (const [x, y] of [[4, 4], [44, 4], [4, 44], [44, 44]]) circle(ctx, P.team(1.0), x, y, 1.6);
  },
  AFLD: (ctx, P) => {
    rect(ctx, P.c(C.shadow), 2, 2, 72, 48);
    rect(ctx, P.c(C.concreteDark), 0, 0, 72, 48);
    rect(ctx, P.c('#4a4943'), 2, 18, 68, 28); // runway
    for (let x = 6; x < 68; x += 10) rect(ctx, P.c('#e8e6dc'), x, 31, 6, 1.5);
    for (let x = 4; x < 70; x += 8) {
      circle(ctx, P.c(C.yellow), x, 20, 0.9);
      circle(ctx, P.c(C.yellow), x, 44, 0.9);
    }
    rect(ctx, P.c(C.concrete), 2, 2, 68, 14); // apron
    block(ctx, P, 4, 2, 30, 14, P.team(0.6), P.team(0.35), 4); // hangar
    for (let x = 6; x < 34; x += 4) rect(ctx, P.team(0.75), x, 3, 2, 8);
    block(ctx, P, 52, 2, 14, 14, P.c(C.concreteLight), P.c(C.concreteDark), 4); // tower
    rect(ctx, P.c(C.glass), 54, 4, 10, 4);
    circle(ctx, P.team(1.0), 59, 10, 1.5);
  },
  ATEK: (ctx, P) => {
    bib(ctx, P, 0, 48, 48, 24);
    block(ctx, P, 2, 4, 44, 43, P.c(C.concreteLight), P.c(C.concreteDark), 6);
    rect(ctx, P.team(0.6), 4, 30, 40, 8);
    rect(ctx, P.team(0.85), 4, 30, 40, 2);
    rect(ctx, P.c(C.glass), 8, 33, 32, 3);
    // observatory dome
    circle(ctx, P.c(C.shadow), 17, 18, 10);
    circle(ctx, P.c(C.steelLight), 15, 16, 10);
    circle(ctx, P.c('#c4c7cb'), 12, 13, 4.5);
    rect(ctx, P.c(C.steelDark), 14.2, 6, 1.6, 10); // slit
    dish(ctx, P, 35, 15, 8);
  },
  STEK: (ctx, P) => {
    bib(ctx, P, 0, 48, 72, 24);
    block(ctx, P, 2, 3, 68, 45, P.c(C.concreteDark), P.c(C.seam), 7);
    rect(ctx, P.team(0.5), 6, 7, 60, 30);
    block(ctx, P, 22, 10, 28, 24, P.team(0.75), P.team(0.42), 5); // central lab
    rect(ctx, P.c(C.glass), 26, 13, 20, 3);
    for (const x of [13, 59]) {
      circle(ctx, P.c(C.steelDark), x, 16, 6);
      circle(ctx, P.c(C.steel), x, 16, 5);
      circle(ctx, P.c(C.steelLight), x - 1.5, 14.5, 2);
    }
    for (const x of [12, 60]) {
      line(ctx, P.c(C.steelDark), 1.5, x, 34, x, 24);
      circle(ctx, P.team(1.0), x, 24, 1.6);
    }
    for (let x = 26; x < 48; x += 5) rect(ctx, P.c(C.steelDark), x, 22, 3, 6); // vents
  },
  KENN: (ctx, P) => {
    rect(ctx, P.c(C.shadow), 6, 7, 16, 15);
    rect(ctx, P.c('#5e4424'), 3, 15, 18, 6); // front wall
    rect(ctx, P.c(C.track), 9, 16, 6, 5); // door
    poly(ctx, P.team(0.65), [3, 15, 3, 7, 12, 4, 12, 15]);
    poly(ctx, P.team(0.45), [12, 4, 21, 7, 21, 15, 12, 15]);
    rect(ctx, P.team(0.9), 11.5, 4, 1, 11);
    circle(ctx, P.c('#c8c0a8'), 19, 20, 1.5); // bowl
  },
  SYRD: (ctx, P) => {
    // a U-shaped dock around open water: back quay plus two piers
    rect(ctx, P.c(C.shadow), 3, 3, 72, 24);
    rect(ctx, P.c(C.shadow), 3, 24, 14, 48);
    rect(ctx, P.c(C.shadow), 61, 24, 14, 48);
    for (const [x, y, w, h] of [[0, 0, 72, 26], [0, 24, 14, 48], [58, 24, 14, 48]]) {
      rect(ctx, P.c(C.concreteDark), x, y, w, h);
      rect(ctx, P.c(C.concrete), x + 1, y + 1, w - 2, h - 2);
    }
    rect(ctx, P.c(C.concreteDark), 14, 24, 44, 2); // quay edge
    block(ctx, P, 16, 2, 40, 18, P.team(0.6), P.team(0.35), 5);
    for (let x = 19; x < 54; x += 6) rect(ctx, P.team(0.78), x, 3, 3, 10);
    for (const x of [2, 60]) for (let y = 30; y < 70; y += 10) circle(ctx, P.c(C.steelDark), x + 10, y, 1.2); // bollards
    // gantry crane on the right pier
    rect(ctx, P.c(C.yellowDark), 58, 40, 14, 4);
    rect(ctx, P.c(C.yellow), 58, 40.5, 14, 3);
    line(ctx, P.c(C.yellow), 2, 60, 42, 40, 42);
    rect(ctx, P.c(C.steelDark), 39, 41, 3, 4);
    for (const [x, y] of [[7, 70], [65, 70]]) circle(ctx, P.team(1.0), x, y, 1.8);
  },
  SPEN: (ctx, P) => {
    // concrete pen with a roofed bay opening south onto the water
    rect(ctx, P.c(C.shadow), 5, 5, 66, 66);
    rect(ctx, P.c(C.concreteDark), 2, 2, 68, 68);
    rect(ctx, P.c(C.concrete), 3, 3, 66, 66);
    rect(ctx, P.c('#1e3440'), 24, 40, 24, 30); // dark water inside the pen
    for (let y = 44; y < 70; y += 6) rect(ctx, P.c('#2b4756'), 26, y, 20, 1);
    rect(ctx, P.c(C.concreteDark), 22, 40, 2, 30);
    rect(ctx, P.c(C.concreteDark), 48, 40, 2, 30);
    // arched roof
    for (let i = 0; i < 6; i++) rect(ctx, P.team(i % 2 ? 0.5 : 0.66), 8, 6 + i * 5.5, 56, 5.5);
    rect(ctx, P.team(0.32), 8, 38, 56, 4);
    rect(ctx, P.c(C.track), 24, 38, 24, 4); // pen mouth
    for (const x of [14, 58]) circle(ctx, P.team(1.0), x, 62, 1.8);
  },
  SILO: (ctx, P) => {
    circle(ctx, P.c(C.shadow), 14, 14, 10.5);
    circle(ctx, P.c(C.concreteDark), 12, 12, 10.5);
    circle(ctx, P.team(0.6), 12, 12, 9.5);
    circle(ctx, P.c(C.concreteDark), 12, 12, 7);
    circle(ctx, P.c(C.yellowDark), 12, 12, 6);
    for (const [x, y] of [[10, 10], [14, 10], [12, 13], [9, 14], [15, 14]]) circle(ctx, P.c(C.ore), x, y, 1.6);
    circle(ctx, P.c('#f2d36a'), 10, 9.5, 0.8);
  },
  SBAG: (ctx, P) => {
    for (let row = 0; row < 4; row++) {
      const off = row % 2 ? 3 : 0;
      for (let x = 1 - off; x < 23; x += 6) {
        const bx = Math.max(1, x);
        const bw = Math.min(x + 6, 23) - bx;
        if (bw < 2) continue;
        rrect(ctx, P.c(C.canvasDark), bx, 1 + row * 5.5, bw, 5.5, 2);
        rrect(ctx, P.c(C.canvas), bx + 0.4, 1.4 + row * 5.5, bw - 1.2, 3.8, 1.6);
      }
    }
  },
  FENC: (ctx, P) => {
    const wire = P.c('#9a9a94');
    for (const y of [9, 15]) polyline(ctx, wire, 0.7, [0, y, 4, y - 1.5, 8, y + 1, 12, y - 1.5, 16, y + 1, 20, y - 1.5, 24, y]);
    for (const x of [9, 15]) polyline(ctx, wire, 0.7, [x, 0, x - 1.5, 4, x + 1, 8, x - 1.5, 12, x + 1, 16, x - 1.5, 20, x, 24]);
    for (const [x, y] of [[3, 12], [21, 12], [12, 3], [12, 21], [12, 12]]) {
      circle(ctx, P.c(C.shadow), x + 1, y + 1, 1.8);
      circle(ctx, P.c('#6a5232'), x, y, 1.6);
    }
  },
  BRIK: (ctx, P) => {
    block(ctx, P, 0, 0, 24, 24, P.c(C.concreteLight), P.c(C.concreteDark), 5);
    rect(ctx, P.c(C.concrete), 2, 2, 20, 15);
    rect(ctx, P.c(C.seam), 0, 9, 24, 0.8);
    rect(ctx, P.c(C.seam), 12, 0, 0.8, 9);
    rect(ctx, P.c(C.seam), 6, 9, 0.8, 10);
    rect(ctx, P.c(C.seam), 18, 9, 0.8, 10);
  },
  PBOX: (ctx, P) => {
    ngon(ctx, P.c(C.shadow), 14, 14, 11, 8);
    ngon(ctx, P.c(C.concreteDark), 12, 12, 11, 8);
    ngon(ctx, P.c(C.concrete), 12, 11.5, 9.5, 8);
    rect(ctx, P.c(C.track), 7, 3.5, 10, 2); // firing slit
    circle(ctx, P.team(0.6), 12, 12.5, 4.5);
    circle(ctx, P.team(0.9), 11, 11.5, 1.6);
  },
  HBOX: (ctx, P) => {
    ngon(ctx, P.c(C.shadow), 14, 14, 11, 8);
    ngon(ctx, P.c('#3e5426'), 12, 12, 11, 8);
    ngon(ctx, P.c('#4f6b2f'), 12, 11.5, 9.5, 8);
    for (const [x, y, r] of [[8, 9, 3], [15, 8, 2.5], [10, 15, 2.6], [16, 14, 3]]) circle(ctx, P.c('#668a3a'), x, y, r);
    for (const [x, y] of [[6, 13], [13, 12], [17, 10]]) poly(ctx, P.c('#7da04a'), [x, y, x + 1, y - 3, x + 2, y]);
    rect(ctx, P.c(C.track), 7, 3.5, 10, 1.8); // firing slit
    circle(ctx, P.team(0.7), 18, 18, 1.2); // small owner marker
  },
  FTUR: (ctx, P) => {
    circle(ctx, P.c(C.shadow), 14, 14, 10.5);
    circle(ctx, P.c(C.concreteDark), 12, 12, 10.5);
    circle(ctx, P.c(C.concrete), 12, 11.5, 9);
    circle(ctx, P.team(0.6), 12, 12, 6.5);
    rect(ctx, P.c(C.steelDark), 10.5, 1, 3, 7); // nozzle
    circle(ctx, P.c('#e8641c'), 12, 2.5, 1.4);
    circle(ctx, P.c(C.steelDark), 12, 12, 3.5);
    circle(ctx, P.c(C.yellowDark), 12, 12, 2.4); // fuel tank cap
    circle(ctx, P.team(1.0), 10, 10, 1.2);
  },
  GUN: (ctx, P) => {
    ngon(ctx, P.c(C.shadow), 14, 14, 11.5, 8);
    ngon(ctx, P.c(C.concreteDark), 12, 12, 11.5, 8);
    ngon(ctx, P.c(C.concrete), 12, 11.5, 10, 8);
    circle(ctx, P.c(C.steelDark), 12, 12, 7.5);
  },
  TSLA: (ctx, P) => {
    rect(ctx, P.c(C.shadow), 6, 16, 16, 8);
    rrect(ctx, P.c(C.concreteDark), 3, 14, 18, 9, 2);
    rect(ctx, P.team(0.6), 4, 15, 16, 4);
    rect(ctx, P.team(0.85), 4, 15, 16, 1.2);
    // tall coil column rising toward the viewer's top
    rect(ctx, P.c(C.steelDark), 9, 6, 6, 13);
    rect(ctx, P.c(C.steel), 9.5, 6, 3, 13);
    for (let y = 8; y < 18; y += 2.5) rect(ctx, P.c('#b0703a'), 8, y, 8, 1.2); // copper windings
    teslaHead(ctx, P, 12, 5, 4);
  },
  AGUN: (ctx, P) => {
    ngon(ctx, P.c(C.shadow), 14, 14, 11, 6, 0);
    ngon(ctx, P.c(C.concreteDark), 12, 12, 11, 6, 0);
    ngon(ctx, P.c(C.concrete), 12, 11.5, 9.5, 6, 0);
    for (const [x, y] of [[4, 12], [20, 12]]) rect(ctx, P.c(C.yellow), x - 1, y - 1, 2, 2);
    circle(ctx, P.c(C.steelDark), 12, 12, 6.5);
  },
  SAM: (ctx, P) => {
    block(ctx, P, 1, 2, 46, 21, P.c(C.concreteDark), P.c(C.seam), 4);
    rect(ctx, P.c(C.concrete), 3, 3, 42, 14);
    for (const x of [3, 39]) hazard(ctx, P, x, 4, 6, 12, 2);
    rect(ctx, P.team(0.6), 11, 3, 26, 2);
    circle(ctx, P.c(C.steelDark), 24, 12, 8.5);
    circle(ctx, P.c(C.track), 24, 12, 7);
  },
  GAP: (ctx, P) => {
    rect(ctx, P.c(C.shadow), 6, 16, 16, 8);
    rrect(ctx, P.c(C.concreteDark), 3, 14, 18, 9, 2);
    rect(ctx, P.team(0.55), 4, 15, 16, 4);
    rect(ctx, P.team(0.8), 4, 15, 16, 1.2);
    rect(ctx, P.c(C.steelDark), 9.5, 6, 5, 12); // mast
    rect(ctx, P.c(C.steel), 10, 6, 2, 12);
    // emitter array: horizontal vanes around a dark orb
    rect(ctx, P.c(C.steelDark), 2.5, 4.5, 19, 4);
    rect(ctx, P.c(C.steelLight), 3, 5, 18, 1.5);
    circle(ctx, P.c(C.steelDark), 12, 6.5, 4.6);
    circle(ctx, P.c('#2c2a3e'), 12, 6.5, 3.8);
    circle(ctx, P.c('#6a64a0'), 11, 5.5, 1.3);
    circle(ctx, P.team(1.0), 4, 6.5, 1);
    circle(ctx, P.team(1.0), 20, 6.5, 1);
  },
  PDOX: (ctx, P) => {
    block(ctx, P, 1, 2, 46, 44, P.c(C.concrete), P.c(C.concreteDark), 6);
    for (const [x, y] of [[3, 4], [37, 4], [3, 30], [37, 30]]) rect(ctx, P.team(0.65), x, y, 8, 8);
    // chronosphere: gyroscope rings around a glowing sphere
    circle(ctx, P.c(C.shadow), 26, 22, 15);
    circle(ctx, P.c(C.steelDark), 24, 20, 15);
    circle(ctx, P.c('#1e3440'), 24, 20, 13);
    ctx.save();
    ctx.translate(24, 20);
    for (const a of [0, Math.PI / 3, -Math.PI / 3]) {
      ctx.save();
      ctx.rotate(a);
      ctx.scale(1, 0.38);
      ring(ctx, P.c(C.steelLight), 0, 0, 12.5, 2.4);
      ctx.restore();
    }
    ctx.restore();
    circle(ctx, P.c('rgba(90,220,240,0.45)'), 24, 20, 8);
    circle(ctx, P.c('#5fd8ea'), 24, 20, 5.5);
    circle(ctx, P.c('#e4fbff'), 22.3, 18.3, 2);
  },
  IRON: (ctx, P) => {
    // row 0: open pad, row 1: the curtain projector
    bib(ctx, P, 0, 0, 48, 24);
    rect(ctx, P.c(C.yellow), 6, 4, 36, 1.5);
    block(ctx, P, 1, 18, 46, 28, P.c(C.concreteDark), P.c(C.seam), 6);
    for (let i = 0; i < 9; i++) rect(ctx, P.team(i % 2 ? 0.45 : 0.72), 4 + i * 4.4, 20, 4.4, 14); // curtain folds
    rect(ctx, P.team(0.95), 4, 20, 39.6, 1.5);
    rect(ctx, P.c(C.steelDark), 4, 34, 40, 2);
    rect(ctx, P.c(C.steelDark), 18, 12, 12, 9); // projector head over the pad
    rect(ctx, P.c(C.steel), 19, 12, 10, 3);
    circle(ctx, P.c('#c23a26'), 24, 17, 2.2);
  },
  MSLO: (ctx, P) => {
    block(ctx, P, 0, 0, 48, 24, P.c(C.concreteDark), P.c(C.seam), 4);
    hazard(ctx, P, 8, 2, 32, 17, 2.5);
    rect(ctx, P.c(C.steel), 10, 4, 13.5, 13); // hatch doors
    rect(ctx, P.c(C.steel), 24.5, 4, 13.5, 13);
    rect(ctx, P.c(C.steelLight), 10, 4, 13.5, 1.5);
    rect(ctx, P.c(C.steelLight), 24.5, 4, 13.5, 1.5);
    trefoil(ctx, P, 24, 10.5, 4);
    for (const x of [2, 42]) rect(ctx, P.team(0.65), x, 3, 4, 14);
  },
};

/** Building turrets, centred on the building centre and facing north. */
const BUILDING_TURRET = {
  GUN: [24, 24, (ctx, P) => {
    barrel(ctx, P, 11, 0, 9, 2);
    drum(ctx, P, 12, 12, 5.5);
  }],
  AGUN: [24, 24, (ctx, P) => {
    barrel(ctx, P, 8.5, 0, 10, 1.5);
    barrel(ctx, P, 14, 0, 10, 1.5);
    rrect(ctx, P.c(C.steelDark), 6, 8, 12, 10, 2);
    rrect(ctx, P.team(0.8), 7, 9, 10, 8, 1.5);
    rect(ctx, P.team(1.0), 8, 10, 3, 1.5);
    rect(ctx, P.c(C.glass), 10.5, 13.5, 3, 1.5);
  }],
  SAM: [24, 24, (ctx, P) => {
    rrect(ctx, P.c(C.steelDark), 6, 9, 12, 10, 2);
    rrect(ctx, P.team(0.78), 7, 10, 10, 8, 1.5);
    for (const x of [7.5, 13.5]) {
      rect(ctx, P.c(C.steel), x - 0.5, 3, 4, 13); // rail
      rrect(ctx, P.c('#e8e6dc'), x, 2, 3, 13, 1.2);
      rect(ctx, P.c('#b8b6ac'), x + 2, 4, 1, 10);
      poly(ctx, P.c('#c23a26'), [x, 3.5, x + 1.5, 0.5, x + 3, 3.5]);
    }
  }],
};

/** Fakes and variants that reuse another actor's art. Keys are upper-case. */
const SPRITE_ALIAS = {
  'AFLD.UKRAINE': 'AFLD',
  // Paratroopers (support power) and the parabomb Badger look like their base actors.
  E1R1: 'E1',
  E3R1: 'E3',
  'BADR.BOMBER': 'BADR',
  FPWR: 'POWR',
  TENF: 'TENT',
  SYRF: 'SYRD',
  SPEF: 'SPEN',
  WEAF: 'WEAP',
  DOMF: 'DOME',
  FIXF: 'FIX',
  FAPW: 'APWR',
  ATEF: 'ATEK',
  PDOF: 'PDOX',
  MSLF: 'MSLO',
  FACF: 'FACT',
};

/** The sprite key an actor id draws with (case-insensitive, aliases resolved). */
function spriteKey(id) {
  const up = String(id).toUpperCase();
  return SPRITE_ALIAS[up] ?? up;
}

// ---- Specials (must match render.rs SpriteIds order) ---------------------------

const SPECIALS = [
  // bullet
  [6, 6, (ctx, P) => {
    circle(ctx, P.c('rgba(255,220,120,0.45)'), 3, 3, 3);
    circle(ctx, P.c('#fff6c8'), 3, 3, 1.4);
  }],
  // small explosion
  [18, 18, (ctx, P) => burst(ctx, P, 9, 9, 8, 7)],
  // large explosion
  [36, 36, (ctx, P) => {
    circle(ctx, P.c('rgba(40,30,25,0.55)'), 18, 18, 17);
    burst(ctx, P, 18, 18, 15, 11);
  }],
  // piff (small arms impact)
  [8, 8, (ctx, P) => {
    circle(ctx, P.c('rgba(255,240,200,0.6)'), 4, 4, 3.5);
    circle(ctx, P.c('#fffbe8'), 4, 4, 1.5);
  }],
  // rally flag
  [12, 16, (ctx, P) => {
    rect(ctx, P.c('#222'), 2, 1, 1.5, 15);
    poly(ctx, P.team(0.9), [3.5, 1.5, 11, 4, 3.5, 7]);
    circle(ctx, P.c('rgba(0,0,0,0.3)'), 3, 15, 2);
  }],
  // anti-tank mine
  [8, 8, (ctx, P) => {
    circle(ctx, P.c(C.shadow), 4.5, 4.5, 3.6);
    circle(ctx, P.c('#3a3a2a'), 4, 4, 3.6);
    circle(ctx, P.c('#5e5e42'), 4, 4, 2.8);
    circle(ctx, P.c('#77775a'), 3.3, 3.3, 1);
    circle(ctx, P.c('#2a2a20'), 4, 4, 0.9);
  }],
  // anti-personnel mine
  [6, 6, (ctx, P) => {
    circle(ctx, P.c('#3a3a2a'), 3, 3, 2.6);
    circle(ctx, P.c('#6a6a48'), 3, 3, 1.8);
    circle(ctx, P.c('#c03020'), 3, 3, 0.7);
  }],
  // tesla bolt segment (stretched along x)
  [16, 4, (ctx, P) => {
    const pts = [0, 2, 3, 0.8, 6, 3.2, 9, 0.8, 12, 3, 14, 1.4, 16, 2];
    polyline(ctx, P.c('rgba(110,170,255,0.55)'), 2.6, pts);
    polyline(ctx, P.c('#cfe8ff'), 1.1, pts);
    polyline(ctx, P.c('#ffffff'), 0.5, pts);
  }],
  // missile (nose east)
  [8, 3, (ctx, P) => {
    poly(ctx, P.c('#f08a24'), [0, 1.5, 2.2, 0.6, 2.2, 2.4]);
    circle(ctx, P.c('#ffe08a'), 2, 1.5, 0.6);
    rect(ctx, P.c('#e8e6dc'), 2, 0.9, 4.6, 1.2);
    poly(ctx, P.c('#c23a26'), [6.6, 0.9, 8, 1.5, 6.6, 2.1]);
    rect(ctx, P.c(C.steel), 2.2, 0.3, 1, 2.4); // fins
  }],
  // artillery shell
  [5, 5, (ctx, P) => {
    circle(ctx, P.c('rgba(255,170,60,0.4)'), 2.5, 2.5, 2.5);
    circle(ctx, P.c('#ffd070'), 2.5, 2.5, 1.3);
    circle(ctx, P.c('#fff6d8'), 2.2, 2.2, 0.6);
  }],
  // chrono shimmer
  [24, 24, (ctx, P) => {
    ring(ctx, P.c('rgba(90,220,240,0.35)'), 12, 12, 10, 2.5);
    ring(ctx, P.c('rgba(160,240,255,0.7)'), 12, 12, 7.5, 1.2);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      line(ctx, P.c('rgba(200,250,255,0.8)'), 0.8, 12 + Math.cos(a) * 3, 12 + Math.sin(a) * 3, 12 + Math.cos(a) * 11, 12 + Math.sin(a) * 11);
    }
    circle(ctx, P.c('rgba(220,252,255,0.85)'), 12, 12, 2.5);
  }],
  // nuke explosion
  [64, 64, (ctx, P) => {
    circle(ctx, P.c('rgba(40,30,25,0.5)'), 32, 32, 31);
    ring(ctx, P.c('rgba(245,170,70,0.6)'), 32, 32, 26, 4); // shock ring
    ring(ctx, P.c('rgba(255,235,190,0.7)'), 32, 32, 23, 1.5);
    circle(ctx, P.c('rgba(90,60,40,0.7)'), 32, 32, 19); // mushroom cap
    burst(ctx, P, 32, 32, 18, 13);
    circle(ctx, P.c('#ffd36a'), 32, 32, 7);
    circle(ctx, P.c('#ffffff'), 32, 32, 3.5);
  }],
];

function burst(ctx, P, cx, cy, r, spikes) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const rr = i % 2 ? r * 0.55 : r;
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  poly(ctx, P.c('#e8641c'), pts);
  circle(ctx, P.c('#f5b030'), cx, cy, r * 0.5);
  circle(ctx, P.c('#fff2b0'), cx, cy, r * 0.25);
}

/**
 * Every art module owns SPECIAL_SLOTS special sprites at a fixed position after
 * the built-in specials (naval, planes, helicopters, abilities), padded with
 * empty slots, so ids in engine/src/render.rs never depend on another module.
 */
export const SPECIAL_SLOTS = 8;

function slots(list) {
  if (list.length > SPECIAL_SLOTS) throw new Error(`art module has ${list.length} specials, the limit is ${SPECIAL_SLOTS}`);
  return list.concat(Array(SPECIAL_SLOTS - list.length).fill(null));
}

// ---- Atlas construction ---------------------------------------------------------

function grey(s) {
  const v = Math.round(Math.max(0, Math.min(1, s)) * 255);
  return `rgb(${v},${v},${v})`;
}

const COLOR_PASS = { team: grey, c: (col) => col };
const MASK_PASS = { team: () => '#fff', c: (col) => (col.startsWith('rgba') ? 'rgba(0,0,0,1)' : '#000') };

/** Sprite definitions in atlas order: [w, h, draw] or null (empty). */
function spriteList(actors) {
  const list = [];
  for (const a of actors) {
    const key = spriteKey(a.id);
    if (a.kind === 'building') {
      const draw = BUILDING_DRAW[key];
      if (!draw) throw new Error(`no sprite for building ${a.id} (looked up as ${key})`);
      list.push([a.width * 24, a.height * 24, draw]);
      list.push(BUILDING_TURRET[key] ?? null);
    } else {
      const d = UNIT_DRAW[key] ?? fallbackUnit(a);
      if (!d) throw new Error(`no sprite for unit ${a.id} (looked up as ${key})`);
      list.push(d.body);
      list.push(d.turret ?? null);
    }
  }
  return list.concat(SPECIALS, slots(NAVAL_SPECIALS), slots(PLANE_SPECIALS), slots(HELI_SPECIALS), slots(ABILITY_SPECIALS));
}

/**
 * Build the colour atlas, mask atlas and frame table.
 * Frame table: 8 floats per sprite [u0, v0, u1, v1, w, h, 0, 0].
 */
export function buildAtlas(actors) {
  const list = spriteList(actors);
  const width = 1024;
  let x = 0;
  let y = 0;
  let rowH = 0;
  const places = list.map((s) => {
    const [w, h] = s ?? [1, 1];
    const pw = Math.ceil(w * RES) + PAD * 2;
    const ph = Math.ceil(h * RES) + PAD * 2;
    if (x + pw > width) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    const p = { x, y, pw, ph };
    x += pw;
    rowH = Math.max(rowH, ph);
    return p;
  });
  const height = y + rowH;
  const color = document.createElement('canvas');
  const mask = document.createElement('canvas');
  for (const c of [color, mask]) {
    c.width = width;
    c.height = height;
  }
  const cctx = color.getContext('2d');
  const mctx = mask.getContext('2d');
  const frames = new Float32Array(list.length * 8);
  list.forEach((s, i) => {
    const p = places[i];
    const [w, h, draw] = s ?? [1, 1, null];
    if (draw) {
      for (const [ctx, P] of [[cctx, COLOR_PASS], [mctx, MASK_PASS]]) {
        ctx.save();
        ctx.translate(p.x + PAD, p.y + PAD);
        ctx.scale(RES, RES);
        // Clip to the sprite's box so drop shadows never bleed into neighbours.
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.clip();
        draw(ctx, P);
        ctx.restore();
      }
    }
    frames.set(
      [(p.x + PAD) / width, (p.y + PAD) / height, (p.x + PAD + w * RES) / width, (p.y + PAD + h * RES) / height, w, h, 0, 0],
      i * 8,
    );
  });
  // The mask only matters where the colour atlas has alpha; clear the rest.
  const cdata = cctx.getImageData(0, 0, width, height);
  const mdata = mctx.getImageData(0, 0, width, height);
  for (let i = 3; i < cdata.data.length; i += 4) {
    if (cdata.data[i] === 0) mdata.data[i - 3] = mdata.data[i - 2] = mdata.data[i - 1] = 0;
  }
  mctx.putImageData(mdata, 0, 0);
  return { color, mask, frames };
}

/**
 * Generic art for ships and aircraft without a dedicated drawing (also used
 * for actors added by modded maps): a plain hull or a plane silhouette.
 */
function fallbackUnit(actor) {
  if (actor.kind === 'ship') {
    return {
      body: [22, 40, (ctx, P) => {
        poly(ctx, P.c(C.steelDark), [11, 0, 21, 12, 21, 38, 1, 38, 1, 12]);
        poly(ctx, P.team(0.6), [11, 3, 19, 13, 19, 36, 3, 36, 3, 13]);
        rect(ctx, P.c(C.steel), 7, 16, 8, 12);
      }],
    };
  }
  if (actor.kind === 'aircraft') {
    return {
      body: [30, 30, (ctx, P) => {
        rect(ctx, P.team(0.6), 13, 2, 4, 26);
        poly(ctx, P.team(0.8), [15, 9, 29, 17, 29, 20, 15, 16, 1, 20, 1, 17]);
        poly(ctx, P.team(0.5), [15, 23, 22, 28, 8, 28]);
      }],
    };
  }
  return null;
}

/** Sidebar icon: body + turret composited in a team colour. */
export function drawIcon(canvas, actor, teamRgb) {
  const ctx = canvas.getContext('2d');
  const P = {
    team: (s) => {
      const k = 0.35 + s * 1.05;
      const [r, g, b] = teamRgb.map((c) => Math.round(Math.min(1, c * k) * 255));
      return `rgb(${r},${g},${b})`;
    },
    c: (col) => col,
  };
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Each part is [draw, dx, dy]: turrets are drawn centred on the body.
  const parts = [];
  const key = spriteKey(actor.id);
  let w;
  let h;
  if (actor.kind === 'building') {
    w = actor.width * 24;
    h = actor.height * 24;
    parts.push([BUILDING_DRAW[key], 0, 0]);
    const t = BUILDING_TURRET[key];
    if (t) parts.push([t[2], (w - t[0]) / 2, (h - t[1]) / 2]);
  } else {
    const d = UNIT_DRAW[key] ?? fallbackUnit(actor);
    [w, h] = d.body;
    parts.push([d.body[2], 0, 0]);
    if (d.turret) parts.push([d.turret[2], (w - d.turret[0]) / 2, (h - d.turret[1]) / 2]);
  }
  const scale = Math.min(canvas.width / w, canvas.height / h) * (actor.kind === 'building' ? 0.92 : 0.8);
  ctx.save();
  ctx.translate((canvas.width - w * scale) / 2, (canvas.height - h * scale) / 2);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  for (const [draw, dx, dy] of parts) {
    ctx.save();
    ctx.translate(dx, dy);
    draw(ctx, P);
    ctx.restore();
  }
  ctx.restore();
}
