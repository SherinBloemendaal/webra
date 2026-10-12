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
  ring,
  polyline,
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
import { ABILITY_DRAW, ABILITY_SPECIALS } from './art/abilities.js';
import { PRONE_DRAW, VETERANCY_SPECIALS } from './art/veterancy.js';
import { DECORATION_SPECIALS } from './art/decorations.js';
import { CIVILIAN_DRAW, worldDraw, worldSecond } from './art/world.js';
import { INFANTRY_DRAW, INFANTRY_PRONE, INFANTRY_SPECIALS } from './art/infantry.js';
import { CRATE_DRAW, LEFTOVER_SPECIALS, huskBase, huskOf } from './art/leftovers.js';
import { EFFECT_SPECIALS, MUZZLE_FLASH, explosionArt } from './art/effects.js';
import { EXPLOSIONS, MUZZLE_ACTORS } from './content/tables.js';
import { BUILDING_DRAW, BUILDING_TURRET, BUILDING_SIZE } from './art/buildings.js';
import { BUILDING_ANIM } from './art/animated.js';
import { drawPixelCameo, pixelSlots, pixelUnitDraw } from './art/pixel.js';
import { cameoInner, paintCameoBackdrop, paintCameoFrame, paintCameoShadow } from './art/cameo.js';
import { INFANTRY_TIMED_POSES, MODE, POSE, POSE_STRIDE, onceTicks, packSprite } from './content/sequences.js';

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
  // WebRA's own pixel art in Red Alert's style (art/pixel.js); the turret sits
  // at OpenRA's Turreted offset (vehicles.yaml FTRK: -298,0,298).
  FTRK: pixelUnitDraw('FTRK', [-298, 0]),
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
Object.assign(UNIT_DRAW, NAVAL_DRAW, PLANE_DRAW, HELI_DRAW, ABILITY_DRAW, INFANTRY_DRAW);
const PRONE = { ...PRONE_DRAW, ...INFANTRY_PRONE };

// Buildings are drawn in art/buildings.js.

/** Fakes and variants that reuse another actor's art. Keys are upper-case. */
const SPRITE_ALIAS = {
  'AFLD.UKRAINE': 'AFLD',
  // Paratroopers (support power) and the parabomb Badger look like their base actors.
  E1R1: 'E1',
  E3R1: 'E3',
  // The British spy looks like every spy (OpenRA RenderSprites Image: spy).
  'SPY.ENGLAND': 'SPY',
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
  // The campaign's helicopter wrecks (OpenRA tran1husk, tran2husk): the Chinook, charred.
  TRAN1HUSK: 'TRAN',
  TRAN2HUSK: 'TRAN',
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
  // anti-tank and anti-personnel mines: reserved, the mines are actors
  // (MINV, MINP in art/abilities.js; packs address them by these names too)
  null,
  null,
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
 * the built-in specials (naval, planes, helicopters, abilities, veterancy, decorations, effects, leftovers), padded with
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

/** One frame of a building's animated layer (art/animated.js) as a sprite: its box cut out of frame f. */
function layerSprite(anim, f) {
  const [bx, by, bw, bh] = anim.box;
  return [bw, bh, (ctx, P) => {
    ctx.translate(-bx, -by);
    anim.draw(ctx, P, f);
  }];
}

/** The animated layer of a building sprite key, or null (buildings with a turret have none). */
function buildingAnim(key) {
  return BUILDING_TURRET[key] ? null : (BUILDING_ANIM[key] ?? null);
}

/**
 * The two sprite slots of an actor (see spriteList): `body` and `second`,
 * each [w, h, draw] or null, and `turret`, whether the second slot is drawn
 * on the body (a turret or an animated layer) rather than instead of it (an
 * infantry's prone pose, a crate's water image). Throws for an actor without
 * art.
 */
export function actorSprites(a) {
  const key = spriteKey(a.id);
  if (a.kind === 'proxy') {
    // Proxies (engine/src/infantry.rs) have no body.
    return { body: null, second: null, turret: false };
  }
  if (a.kind === 'building') {
    // The neutral world (trees, houses, tech buildings, bridges) has its own art module.
    const draw = BUILDING_DRAW[key] ?? worldDraw(a);
    if (!draw) throw new Error(`no sprite for building ${a.id} (looked up as ${key})`);
    const anim = buildingAnim(key);
    const turret = BUILDING_TURRET[key] ?? null;
    const second = turret ?? worldSecond(a) ?? (anim ? layerSprite(anim, 0) : null);
    return { body: [a.width * 24, a.height * 24, draw], second, turret: !!turret };
  }
  if (a.kind === 'crate') {
    // Crates (art/leftovers.js): the land image, then the water image.
    const d = CRATE_DRAW[key] ?? CRATE_DRAW.CRATE;
    return { body: d.body, second: d.turret, turret: false };
  }
  if (a.kind === 'husk') {
    // Husks: the vehicle's hull, charred (art/leftovers.js); no turret.
    const base = UNIT_DRAW[spriteKey(huskBase(a.id))] ?? fallbackUnit({ ...a, kind: 'vehicle' });
    if (!base) throw new Error(`no sprite for husk ${a.id} (looked up as ${huskBase(a.id)})`);
    return { body: huskOf(base.body), second: null, turret: false };
  }
  const d = UNIT_DRAW[key] ?? CIVILIAN_DRAW[key] ?? fallbackUnit(a);
  if (!d) throw new Error(`no sprite for unit ${a.id} (looked up as ${key})`);
  if (a.kind === 'infantry') {
    // Infantry: the prone pose, or for civilians the panic pose (engine neutral.rs draws_panic).
    return { body: d.body, second: PRONE[key] ?? CIVILIAN_DRAW[key]?.panic ?? d.body, turret: false };
  }
  return { body: d.body, second: d.turret ?? null, turret: !!d.turret };
}

/**
 * Sprite definitions in atlas order: [w, h, draw] or null (empty). Every actor
 * has two slots: body and turret. Infantry have no turret; their second slot is
 * the prone pose (engine/src/veterancy.rs), the standing body when there is no
 * prone art. Buildings without a turret keep their animated layer there (the
 * head frame the GPU animates, see buildAtlas).
 */
export function spriteList(actors) {
  const list = [];
  for (const a of actors) {
    const { body, second } = actorSprites(a);
    list.push(body, second);
  }
  const muzzles = new Set(MUZZLE_ACTORS);
  return list.concat(
    SPECIALS,
    slots(NAVAL_SPECIALS),
    slots(PLANE_SPECIALS),
    slots(HELI_SPECIALS),
    slots(ABILITY_SPECIALS),
    slots(VETERANCY_SPECIALS),
    slots(DECORATION_SPECIALS),
    slots(EFFECT_SPECIALS),
    slots(LEFTOVER_SPECIALS),
    slots(INFANTRY_SPECIALS),
    // Muzzle flashes, one slot per actor (engine/src/render.rs SpriteIds muzzle_base).
    actors.map((a) => (muzzles.has(a.id) ? MUZZLE_FLASH : null)),
    // Explosions per name (engine/render.json, SpriteIds explosion_base).
    EXPLOSIONS.map(explosionArt),
  );
}

/** Floats per frame table entry (shaders/sprite.wgsl `Frame`). */
export const FRAME_FLOATS = 16;

/**
 * Animated building layers: per actor index with one, its head slot (2i + 1),
 * the first of its frames after the sprite list (`start`, shared by aliases),
 * the frame count, rate and the layer's offset from the building centre.
 * `skip(i)` leaves out actors whose second slot holds other art.
 */
export function animationPlan(actors, listLength, skip = () => false) {
  const plan = [];
  const starts = new Map();
  let next = listLength;
  actors.forEach((a, i) => {
    if (a.kind !== 'building' || skip(i)) return;
    const key = spriteKey(a.id);
    const anim = buildingAnim(key);
    if (!anim) return;
    if (!starts.has(key)) {
      starts.set(key, next);
      next += anim.frames;
    }
    const [bx, by, bw, bh] = anim.box;
    const offset = [bx + bw / 2 - (a.width * 24) / 2, by + bh / 2 - (a.height * 24) / 2];
    plan.push({ actor: i, key, anim, head: 2 * i + 1, start: starts.get(key), frames: anim.frames, fps: anim.fps, offset });
  });
  return plan;
}

/** Smallest power of two at least `n`. */
const pow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * Shelf-pack boxes ({ pw, ph } in atlas pixels) into rows of `width`;
 * adds x and y to each and returns the height.
 */
function shelfPack(boxes, width, startY = 0) {
  let x = 0;
  let y = startY;
  let rowH = 0;
  for (const b of boxes) {
    if (x + b.pw > width) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    b.x = x;
    b.y = y;
    x += b.pw;
    rowH = Math.max(rowH, b.ph);
  }
  return y + rowH;
}

/**
 * Build the colour atlas, mask atlas, frame table and building overlay table.
 * Frame table: FRAME_FLOATS per entry
 *   [u0, v0, u1, v1, w, h, offset x, offset y, anim start, anim frames, anim fps, 0, 0, 0, 0, 0]
 * with sizes and offsets in world pixels. An entry with more than one anim
 * frame is the head of an animation: the shader draws frame
 * `start + k` instead (shaders/sprite.wgsl, js/anim.js animFrame).
 * `overlays[t]` is the still frame of actor type t's animated layer, or 0; the
 * engine draws it for fogged buildings and those without power
 * (engine/src/overlays.rs, Game.set_building_overlays). For a layer that is
 * a pose table (`opts.layers`, js/content/atlas.js) it is the layer's slot
 * with the STILL pose and the door frames as its age (`packSprite(slot,
 * POSE.STILL, frames)`, at least POSE_STRIDE): the engine then draws the
 * layer with the door frame (engine/src/doors.rs).
 *
 * `opts.slots` (js/content/atlas.js) replaces sprite slots with other art:
 * a slot mapped to null is empty, a slot mapped to a sequence slot
 * `{ images, poses }` becomes the head of a pose table (the last vec4 of the
 * entry: first descriptor, pose count), followed by one descriptor per pose
 * ([0 x 8, first frame, frames per facing, fps, mode, facings, flags,
 * interpolated facings, lead-in frames]) and the frames of each pose, facing by facing.
 * `images` are `{ width, height, color (RGBA), mask (one byte per pixel, 255
 * team colour) | null, offset: [x, y], scale }` with offset and scale in world
 * pixels; each is placed in the atlas once. Slots of actors with WebRA's
 * own pixel art (art/pixel.js pixelSlots) get its pose tables unless
 * `opts.slots` has them (listed in the result's `pixel`). A building whose second slot is
 * replaced has no animated WebRA layer (`overlays` 0). `opts.filter` is the
 * sampler the renderer uses ('nearest' for pixel art); `opts.maxSize` the
 * largest atlas side. `opts.biome` is the map's biome (temperate, snow or
 * desert): the neutral world's trees, ice and huts follow it (art/world.js).
 */
export function buildAtlas(actors, opts = {}) {
  // WebRA's own pixel art (art/pixel.js) fills the slots nobody else does.
  const slots = new Map(opts.slots ?? []);
  const pixel = [];
  for (const [k, art] of pixelSlots(actors)) {
    if (slots.has(k)) continue;
    slots.set(k, art);
    pixel.push(k);
  }
  const maxSize = opts.maxSize ?? 8192;
  const list = spriteList(actors);
  const slotCount = list.length;
  for (const k of slots.keys()) {
    if (k < 0 || k >= slotCount) throw new Error(`no sprite slot ${k}`);
    list[k] = null;
  }
  const plan = animationPlan(actors, list.length, (i) => slots.has(2 * i + 1));
  const meta = new Map(); // atlas index -> { offset, anim: [start, frames, fps] }
  const overlays = new Uint32Array(actors.length);
  for (const p of plan) {
    meta.set(p.head, { offset: p.offset, anim: [p.start, p.frames, p.fps] });
    // Still frames stay below POSE_STRIDE: larger values mark pose-table layers.
    if (p.start >= POSE_STRIDE) throw new Error(`animated layer frame ${p.start} past ${POSE_STRIDE}`);
    overlays[p.actor] = p.start;
    if (meta.has(p.start)) continue; // an alias already added the frames
    for (let f = 0; f < p.frames; f++) {
      meta.set(p.start + f, { offset: p.offset, anim: [0, 0, 0] });
      list.push(layerSprite(p.anim, f));
    }
  }
  // Layers drawn over structures by the engine (original War Factory roof and
  // door): the still pose, its age the door frames (the idle pose's length).
  for (const k of opts.layers ?? []) {
    const art = slots.get(k);
    if (k % 2 === 1 && art) overlays[(k - 1) / 2] = packSprite(k, POSE.STILL, art.poses[POSE.IDLE].length);
  }
  // Sequence slots: images placed once, entries after the WebRA frames.
  const images = [];
  const extra = []; // [slot head, descriptor base, pose count, entries]
  const shared = new Map(); // art -> descriptor base (aliases share one copy)
  let next = list.length;
  for (const [slot, art] of slots) {
    if (!art) continue;
    if (shared.has(art)) {
      extra.push([slot, shared.get(art), art.poses.length, []]);
      continue;
    }
    const base = images.length;
    for (const img of art.images) images.push(img);
    const descs = [];
    const seen = new Map();
    for (const pose of art.poses) {
      if (!seen.has(pose)) {
        seen.set(pose, descs.length);
        descs.push(pose);
      }
    }
    const descBase = next;
    shared.set(art, descBase);
    next += art.poses.length;
    const blocks = descs.map((d) => {
      const first = next;
      next += d.frames.length;
      return first;
    });
    const entries = art.poses.map((pose) => {
      const k = seen.get(pose);
      const d = descs[k];
      const flags = (d.classic ? 1 : 0) | (d.rotate ? 2 : 0);
      return { desc: [blocks[k], d.length, d.fps, d.mode, d.facings, flags, d.interpolatedFacings ?? 0, d.lead ?? 0] };
    });
    for (let k = 0; k < descs.length; k++) for (const img of descs[k].frames) entries.push({ image: base + img });
    extra.push([slot, descBase, art.poses.length, entries]);
  }
  // WebRA art at RES atlas pixels per world pixel, sequence images at their own resolution.
  const boxes = list.map((s) => {
    const [w, h] = s ?? [1, 1];
    return { pw: Math.ceil(w * RES) + PAD * 2, ph: Math.ceil(h * RES) + PAD * 2 };
  });
  const imageBoxes = images.map((img) => ({ pw: img.width + PAD * 2, ph: img.height + PAD * 2, img }));
  let width = 1024;
  let height;
  if (imageBoxes.length) {
    const area = [...boxes, ...imageBoxes].reduce((n, b) => n + b.pw * b.ph, 0);
    width = Math.min(maxSize, Math.max(1024, pow2(Math.sqrt(area * 1.2))));
    const order = [...imageBoxes].sort((a, b) => b.ph - a.ph);
    for (;;) {
      const top = shelfPack(boxes, width);
      height = shelfPack(order, width, top);
      if (height <= maxSize || width >= maxSize) break;
      width *= 2;
    }
    if (height > maxSize) throw new Error(`the sprites need a ${width} x ${height} atlas; this device allows ${maxSize}`);
  } else {
    height = shelfPack(boxes, width);
  }
  const color = document.createElement('canvas');
  const mask = document.createElement('canvas');
  for (const c of [color, mask]) {
    c.width = width;
    c.height = height;
  }
  const cctx = color.getContext('2d');
  const mctx = mask.getContext('2d');
  // The map's biome: trees, ice and huts of the neutral world look like it (art/world.js).
  const biome = opts.biome ?? 'temperate';
  const passes = [[cctx, { ...COLOR_PASS, biome }], [mctx, { ...MASK_PASS, biome }]];
  const frames = new Float32Array(next * FRAME_FLOATS);
  list.forEach((s, i) => {
    const p = boxes[i];
    const [w, h, draw] = s ?? [1, 1, null];
    if (draw) {
      for (const [ctx, P] of passes) {
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
    const m = meta.get(i);
    const [ox, oy] = m?.offset ?? [0, 0];
    const [start, count, fps] = m?.anim ?? [0, 0, 0];
    frames.set(
      [(p.x + PAD) / width, (p.y + PAD) / height, (p.x + PAD + w * RES) / width, (p.y + PAD + h * RES) / height, w, h, ox, oy, start, count, fps, 0],
      i * FRAME_FLOATS,
    );
  });
  // The mask only matters where the colour atlas has alpha; clear the rest.
  const cdata = cctx.getImageData(0, 0, width, height);
  const mdata = mctx.getImageData(0, 0, width, height);
  for (let i = 3; i < cdata.data.length; i += 4) {
    if (cdata.data[i] === 0) mdata.data[i - 3] = mdata.data[i - 2] = mdata.data[i - 1] = 0;
  }
  // Sequence images straight into the pixels.
  for (const b of imageBoxes) {
    const { img } = b;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const s = (y * img.width + x) * 4;
        if (img.color[s + 3] === 0) continue;
        const o = ((b.y + PAD + y) * width + b.x + PAD + x) * 4;
        cdata.data[o] = img.color[s];
        cdata.data[o + 1] = img.color[s + 1];
        cdata.data[o + 2] = img.color[s + 2];
        cdata.data[o + 3] = img.color[s + 3];
        const m = img.mask ? img.mask[y * img.width + x] : 0;
        mdata.data[o] = mdata.data[o + 1] = mdata.data[o + 2] = m;
        mdata.data[o + 3] = 255;
      }
    }
  }
  cctx.putImageData(cdata, 0, 0);
  mctx.putImageData(mdata, 0, 0);
  for (const [slot, descBase, count, entries] of extra) {
    frames.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, descBase, count, 0, 0], slot * FRAME_FLOATS);
    entries.forEach((e, k) => {
      const at = (descBase + k) * FRAME_FLOATS;
      if (e.desc) {
        const [first, length, fps, mode, facings, flags, interp, lead] = e.desc;
        frames.set([0, 0, 0, 0, 0, 0, 0, 0, first, length, fps, mode, facings, flags, interp, lead], at);
        return;
      }
      const b = imageBoxes[e.image];
      const { img } = b;
      const scale = img.scale ?? 1;
      frames.set(
        [
          (b.x + PAD) / width,
          (b.y + PAD) / height,
          (b.x + PAD + img.width) / width,
          (b.y + PAD + img.height) / height,
          img.width * scale,
          img.height * scale,
          img.offset[0],
          img.offset[1],
          0, 0, 0, 0, 0, 0, 0, 0,
        ],
        at,
      );
    });
  }
  // Actor types whose body art has death sequences, and how many ticks each
  // death and the longer idle animation play (Game.set_death_art).
  const deaths = [];
  const deathTicks = [];
  for (const [slot, art] of slots) {
    if (!art?.deaths || slot % 2 !== 0 || slot >= actors.length * 2) continue;
    deaths.push(slot / 2);
    // Idle animations count when the art has them (played once); deaths always.
    const t = INFANTRY_TIMED_POSES.map((p) => {
      const desc = art.poses[POSE[p]];
      return p.startsWith('IDLE') && desc?.mode !== MODE.ONCE ? 0 : onceTicks(desc);
    });
    deathTicks.push(...t.slice(0, 7), Math.max(t[7], t[8]));
  }
  // Pose tables (sequence slots) need the engine's poses (Game.set_sprite_poses).
  const filter = opts.filter ?? 'linear';
  // `pixel`: the slots of WebRA's pixel art, which the engine draws like pre-rendered art (gameart.js applyGameArt).
  return { color, mask, frames, overlays, deaths, deathTicks, filter, poses: filter === 'nearest' || extra.length > 0, pixel: pixel.sort((x, y) => x - y), width, height };
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

/** Colour pass for icons and cameos: team levels scale the player's colour. */
function iconPalette(teamRgb) {
  return {
    team: (s) => {
      const k = 0.35 + s * 1.05;
      const [r, g, b] = teamRgb.map((c) => Math.round(Math.min(1, c * k) * 255));
      return `rgb(${r},${g},${b})`;
    },
    c: (col) => col,
  };
}

/**
 * Sidebar and palette icon: the body, with its turret or animated layer
 * centred on it, in a team colour. Every actor with art has one (the same
 * art as its atlas slots, actorSprites); a proxy has none and stays blank.
 */
export function drawIcon(canvas, actor, teamRgb) {
  const ctx = canvas.getContext('2d');
  const P = iconPalette(teamRgb);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // A mission's own actor uses the art of its art key (engine rules_json `art`).
  const sprites = actorSprites(actor.art ? { ...actor, id: actor.art } : actor);
  if (!sprites.body) return;
  const [w, h, body] = sprites.body;
  // Each part is [draw, dx, dy]: turrets are drawn centred on the body,
  // animated building layers (their first frame) where they belong.
  const parts = [[body, 0, 0]];
  const anim = actor.kind === 'building' ? buildingAnim(spriteKey(actor.art ?? actor.id)) : null;
  if (sprites.turret) {
    const [tw, th, draw] = sprites.second;
    parts.push([draw, (w - tw) / 2, (h - th) / 2]);
  } else if (anim) {
    parts.push([(c, p) => anim.draw(c, p, 0), 0, 0]);
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

// ---- Cameos ---------------------------------------------------------------------------

const CAMEO_TEAM = [0.2, 0.5, 0.95];
/** Units are turned this far (radians) so they show their side, as RA cameos do. */
const CAMEO_TURN = 0.62;

/** Draw order and extent of the model behind a type name, or null when it has no art. */
function cameoModel(typeName, kind) {
  const key = spriteKey(typeName);
  if (BUILDING_DRAW[key]) {
    const [cw, ch] = BUILDING_SIZE[key];
    const w = cw * 24;
    const h = ch * 24;
    const parts = [[BUILDING_DRAW[key], 0, 0]];
    const t = BUILDING_TURRET[key];
    if (t) parts.push([t[2], (w - t[0]) / 2, (h - t[1]) / 2]);
    const anim = buildingAnim(key);
    if (anim) parts.push([(c, P) => anim.draw(c, P, 0), 0, 0]);
    return { building: true, w, h, parts };
  }
  const d = UNIT_DRAW[key] ?? CIVILIAN_DRAW[key] ?? (kind ? fallbackUnit({ kind }) : null);
  if (!d) return null;
  const [w, h] = d.body;
  const parts = [[d.body[2], 0, 0]];
  if (d.turret) parts.push([d.turret[2], (w - d.turret[0]) / 2, (h - d.turret[1]) / 2]);
  return { building: false, w, h, parts };
}

/**
 * Draw the sidebar cameo of a building or unit into the rectangle (0, 0) to
 * (size, opts.height ?? size) of ctx: a framed dark backdrop with the model in
 * 3/4 view. Buildings are the atlas drawings; units are turned towards the
 * viewer and lit by a spotlight. opts.team is the player's colour as [r, g, b]
 * in 0..1 (default blue); opts.kind names the actor kind for ships and aircraft
 * without dedicated art. Returns false (drawing nothing) for a type without art.
 */
export function drawCameo(ctx, typeName, size, opts = {}) {
  // WebRA's own pixel art cameos (art/pixel.js) are pictures of their own.
  if (drawPixelCameo(ctx, spriteKey(typeName), size, opts.height ?? size)) return true;
  const model = cameoModel(typeName, opts.kind);
  if (!model) return false;
  const width = size;
  const height = opts.height ?? size;
  const P = iconPalette(opts.team ?? CAMEO_TEAM);
  const inner = cameoInner(width, height);
  ctx.save();
  paintCameoBackdrop(ctx, width, height);
  ctx.beginPath();
  ctx.rect(inner.x, inner.y, inner.w, inner.h);
  ctx.clip();
  const { w, h } = model;
  let scale;
  if (model.building) {
    scale = Math.min(inner.w / w, inner.h / h) * 0.94;
    ctx.translate(inner.x + (inner.w - w * scale) / 2, inner.y + (inner.h - h * scale) / 2);
  } else {
    const ex = Math.abs(w * Math.cos(CAMEO_TURN)) + Math.abs(h * Math.sin(CAMEO_TURN));
    const ey = Math.abs(w * Math.sin(CAMEO_TURN)) + Math.abs(h * Math.cos(CAMEO_TURN));
    scale = Math.min(inner.w / ex, inner.h / ey) * 0.88;
    paintCameoShadow(ctx, inner.x + inner.w * 0.54, inner.y + inner.h * 0.72, ex * scale * 0.5, ex * scale * 0.2);
    ctx.translate(inner.x + inner.w / 2, inner.y + inner.h * 0.46);
    ctx.rotate(CAMEO_TURN);
    ctx.translate((-w * scale) / 2, (-h * scale) / 2);
  }
  ctx.scale(scale, scale);
  for (const [draw, dx, dy] of model.parts) {
    ctx.save();
    ctx.translate(dx, dy);
    draw(ctx, P);
    ctx.restore();
  }
  ctx.restore();
  ctx.save();
  paintCameoFrame(ctx, width, height);
  ctx.restore();
  return true;
}

const cameoCache = new Map();

/**
 * A cached canvas holding the cameo, so the sidebar draws each picture once.
 * The key is the sprite key, size, height and team colour.
 */
export function getCameo(typeName, size, opts = {}) {
  const team = opts.team ?? CAMEO_TEAM;
  const height = opts.height ?? size;
  const id = `${spriteKey(typeName)}|${size}x${height}|${team.map((c) => c.toFixed(3)).join(',')}`;
  let canvas = cameoCache.get(id);
  if (canvas === undefined) {
    canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = height;
    canvas = drawCameo(canvas.getContext('2d'), typeName, size, { ...opts, height }) ? canvas : null;
    cameoCache.set(id, canvas);
  }
  return canvas;
}

/** Forget all cached cameos (after a team colour change, say). */
export function clearCameoCache() {
  cameoCache.clear();
}
