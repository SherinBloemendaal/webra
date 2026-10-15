// Art for the vehicles (2D minimal pack, flat 1996 style). Entries: id ->
// { body: [w, h, draw], turret?: [w, h, draw] }, drawn facing north; a turret
// sprite is drawn centred on the body and turns about its centre.
//
// Materials follow the design canvas's Units board: team plating with panel
// lines, steel with seams, treads or tyres, and per vehicle its own accent
// (hazard stripes, glass, copper, canvas, ore). Shapes and the base palette
// come from ./kit.js, the materials from ./unitkit.js.

import { C, rect, rrect, circle, poly, line, trefoil, dish, crate } from './kit.js';
import { U, PANEL_SHADE, plate, steel, treads, tyres, glass, bubble, copper, tarp, stripes, oreLoad } from './unitkit.js';
import { pixelUnitDraw } from './pixel.js';

const MISSILE = '#e8e6dc';
const RED = '#c23a26';

/** Turret drum: steel rim, team plate, a lit spot top left. */
function drum(ctx, P, cx, cy, r, level = 0.82) {
  circle(ctx, P.c(U.steelDark), cx, cy, r);
  circle(ctx, P.team(level), cx, cy, r - 0.9);
  circle(ctx, P.team(level * PANEL_SHADE), cx + r * 0.15, cy + r * 0.2, r * 0.55);
  circle(ctx, P.team(Math.min(1, level + 0.18)), cx - r * 0.35, cy - r * 0.35, r * 0.28);
}

/** A gun barrel pointing north from y0 to y1 with a muzzle brake and a lit edge. */
function barrel(ctx, P, x, y0, y1, w = 2) {
  rect(ctx, P.c(U.steelDark), x, y0, w, y1 - y0);
  rect(ctx, P.c(U.steel), x + w * 0.25, y0 + 2, w * 0.35, y1 - y0 - 2);
  rect(ctx, P.c(U.steelDark), x - 0.5, y0, w + 1, 2);
}

/** A hatch: dark ring with a steel lid. */
function hatch(ctx, P, cx, cy, r) {
  circle(ctx, P.c(U.steelDark), cx, cy, r);
  circle(ctx, P.c(U.steel), cx - r * 0.15, cy - r * 0.15, r * 0.65);
}

/** Engine deck: a steel grille at the back of a hull. */
function grille(ctx, P, x, y, w, h) {
  steel(ctx, P, x, y, w, h, 0.5);
  rect(ctx, P.c(U.steelDark), x, y, w, 0.5);
}

/** Missile pod: a team box with a grid of dark launch tubes. */
function pod(ctx, P, x, y, w, h, cols, rows) {
  rrect(ctx, P.c(U.steelDark), x, y, w, h, 1);
  plate(ctx, P, x + 0.5, y + 0.5, w - 1, h - 1, 0.6, 1, 3);
  const tr = Math.min((w - 1) / cols, (h - 1) / rows) * 0.3;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) circle(ctx, P.c(U.track), x + 0.5 + ((i + 0.5) * (w - 1)) / cols, y + 0.5 + ((j + 0.5) * (h - 1)) / rows, tr);
  }
}

/**
 * Wheeled truck chassis with a team cab and windscreen at the front; the bed
 * is left to the caller. Returns the bed's top y.
 */
function truck(ctx, P, w, h, ys, cabH = 7) {
  tyres(ctx, P, w, ys);
  rrect(ctx, P.c(U.steelDark), 3, 1, w - 6, h - 2, 1.5);
  plate(ctx, P, 3, 1, w - 6, cabH, 0.65, 2, 3);
  rect(ctx, P.team(0.85), 4, 1, w - 8, 1.2);
  glass(ctx, P, 4.5, 2.8, w - 9, 2.6, 0.6);
  rect(ctx, P.c(U.steelDark), 3, cabH + 1, w - 6, 1);
  return cabH + 2;
}

/** Tesla coil head from above: copper windings round a glowing core. */
function teslaHead(ctx, P, cx, cy, r) {
  circle(ctx, P.c('rgba(110,170,255,0.35)'), cx, cy, r * 1.6);
  circle(ctx, P.c(U.copperDark), cx, cy, r);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    circle(ctx, P.c(U.copperLight), cx + Math.cos(a) * r * 0.72, cy + Math.sin(a) * r * 0.72, r * 0.2);
  }
  circle(ctx, P.c('#7fc4ff'), cx, cy, r * 0.42);
  circle(ctx, P.c('#eef8ff'), cx - r * 0.1, cy - r * 0.1, r * 0.2);
}

/** A tracked hull: two treads, a team plate between and a lit glacis plate at the front. */
function trackedHull(ctx, P, o) {
  const { tx, ty, tw, th, hx, hy, hw, hh, level, glacis } = o;
  treads(ctx, P, tx[0], ty, tw, th);
  treads(ctx, P, tx[1], ty, tw, th);
  plate(ctx, P, hx, hy, hw, hh, level, 2);
  rect(ctx, P.team(Math.min(1, level + 0.26)), hx + 1, hy, hw - 2, glacis);
  rect(ctx, P.team(level * 0.7), hx + 1, hy + glacis, hw - 2, 0.6);
}

export const VEHICLE_DRAW = {
  // Light Tank: a small hull, one gun.
  '1TNK': {
    body: [22, 22, (ctx, P) => {
      trackedHull(ctx, P, { tx: [2, 15], ty: 2, tw: 5, th: 18, hx: 6, hy: 4, hw: 10, hh: 16, level: 0.55, glacis: 4 });
      grille(ctx, P, 7, 16.5, 8, 2.5);
    }],
    turret: [22, 22, (ctx, P) => {
      barrel(ctx, P, 10, 0, 10, 2);
      drum(ctx, P, 11, 12, 5, 0.85);
      hatch(ctx, P, 12.8, 13.8, 1.1);
    }],
  },
  // Medium Tank: a longer hull, a bigger drum with a muzzle brake.
  '2TNK': {
    body: [24, 24, (ctx, P) => {
      trackedHull(ctx, P, { tx: [1, 17], ty: 1, tw: 6, th: 22, hx: 6, hy: 3, hw: 12, hh: 19, level: 0.5, glacis: 4.5 });
      grille(ctx, P, 7, 18.5, 10, 3);
    }],
    turret: [24, 24, (ctx, P) => {
      barrel(ctx, P, 11, 0, 9, 2);
      drum(ctx, P, 12, 13, 5.6);
      hatch(ctx, P, 13.8, 15, 1.3);
    }],
  },
  // Heavy Tank: wide treads, a boxy turret with twin guns.
  '3TNK': {
    body: [26, 26, (ctx, P) => {
      trackedHull(ctx, P, { tx: [1, 18], ty: 1, tw: 7, th: 24, hx: 7, hy: 3, hw: 12, hh: 21, level: 0.5, glacis: 5 });
      grille(ctx, P, 8, 20, 10, 3);
    }],
    turret: [26, 26, (ctx, P) => {
      barrel(ctx, P, 10, 0, 11, 2);
      barrel(ctx, P, 14, 0, 11, 2);
      rrect(ctx, P.c(U.steelDark), 6.5, 8.5, 13, 12, 3);
      plate(ctx, P, 7.5, 9.5, 11, 10, 0.8, 2.5, 3);
      rect(ctx, P.team(1.0), 9, 10.5, 3, 1.6);
      hatch(ctx, P, 15.5, 16.5, 1.4);
    }],
  },
  // Mammoth Tank: the biggest hull, twin guns and missile pods on the turret.
  '4TNK': {
    body: [30, 30, (ctx, P) => {
      trackedHull(ctx, P, { tx: [0.5, 21.5], ty: 1, tw: 8, th: 28, hx: 7, hy: 3, hw: 16, hh: 25, level: 0.48, glacis: 5 });
      grille(ctx, P, 8, 22, 14, 4);
      for (const x of [9, 19]) circle(ctx, P.c(U.steelDark), x + 1, 27, 1); // exhausts
    }],
    turret: [30, 30, (ctx, P) => {
      barrel(ctx, P, 11.2, 0, 12, 2.2);
      barrel(ctx, P, 16.6, 0, 12, 2.2);
      pod(ctx, P, 2, 11, 5.5, 9, 2, 3);
      pod(ctx, P, 22.5, 11, 5.5, 9, 2, 3);
      rrect(ctx, P.c(U.steelDark), 7.5, 9.5, 15, 14, 3);
      plate(ctx, P, 8.5, 10.5, 13, 12, 0.8, 2.5, 3);
      rect(ctx, P.team(1.0), 10, 11.5, 4, 1.6);
      hatch(ctx, P, 18, 19, 1.6);
    }],
  },
  // Ore Truck: the cab at the front, the hopper of ore behind.
  HARV: {
    body: [24, 28, (ctx, P) => {
      treads(ctx, P, 1, 3, 5, 23);
      treads(ctx, P, 18, 3, 5, 23);
      plate(ctx, P, 5, 1, 14, 8, 0.65, 2, 3);
      glass(ctx, P, 7, 2, 10, 3, 0.8);
      rrect(ctx, P.c(U.steelDark), 5, 10, 14, 16, 1.5);
      steel(ctx, P, 5.5, 10.5, 13, 15, 1);
      oreLoad(ctx, P, 6.5, 11.5, 11, 13);
      plate(ctx, P, 5, 24, 14, 2.4, 0.45);
    }],
  },
  // Ranger: a jeep with a pintle machine gun.
  JEEP: {
    body: [18, 22, (ctx, P) => {
      tyres(ctx, P, 18, [3, 15]);
      rrect(ctx, P.c(U.steelDark), 3, 2, 12, 19, 3);
      plate(ctx, P, 3.5, 2.5, 11, 18, 0.55, 2.5, 3.5);
      rect(ctx, P.team(0.8), 4.5, 2.5, 9, 4.5); // hood
      glass(ctx, P, 4.5, 7.4, 9, 2, 0.5); // windscreen
      steel(ctx, P, 4.5, 17.2, 9, 2.3, 0.5, false); // tailgate
      circle(ctx, P.c(U.yellow), 5.5, 3.2, 0.8);
      circle(ctx, P.c(U.yellow), 12.5, 3.2, 0.8);
    }],
    turret: [18, 22, (ctx, P) => {
      rect(ctx, P.c(U.steelDark), 8.5, 3, 1, 9); // M60
      circle(ctx, P.c(U.steelDark), 9, 12.5, 2.8);
      circle(ctx, P.team(0.9), 9, 12.5, 2);
      circle(ctx, P.c(U.helmet), 9, 13.5, 1.3); // gunner's helmet
    }],
  },
  // APC: a sloped glacis, roof hatches, a bow machine gun.
  APC: {
    body: [22, 24, (ctx, P) => {
      treads(ctx, P, 1, 2, 5, 21);
      treads(ctx, P, 16, 2, 5, 21);
      plate(ctx, P, 5, 4, 12, 19, 0.5, 2);
      poly(ctx, P.team(0.78), [5, 9, 7, 3, 15, 3, 17, 9]); // sloped glacis
      rect(ctx, P.team(0.62), 6, 9, 10, 1);
      rect(ctx, P.c(U.steelDark), 10.5, 0, 1, 5); // bow MG
      circle(ctx, P.c(U.steelDark), 11, 5.5, 1.6);
      for (const y of [12, 16]) {
        steel(ctx, P, 7, y, 3, 3, 0.5);
        steel(ctx, P, 12, y, 3, 3, 0.5);
      }
      rect(ctx, P.team(0.32), 7, 20.5, 8, 2); // rear door
    }],
  },
  // Mobile Flak: WebRA's own pixel art in Red Alert's style (art/pixel.js); the
  // turret sits at OpenRA's Turreted offset (vehicles.yaml FTRK: -298,0,298).
  FTRK: pixelUnitDraw('FTRK', [-298, 0]),
  // V2 Launcher: a truck with the rocket on its rail, hazard plates at the tail.
  V2RL: {
    body: [22, 28, (ctx, P) => {
      const bed = truck(ctx, P, 22, 28, [3, 13, 20]);
      plate(ctx, P, 3.5, bed, 15, 26 - bed, 0.5, 1);
      stripes(ctx, P, 3.5, 23.5, 15, 2.5, 1.5);
      steel(ctx, P, 9.5, bed - 1, 3, 26 - bed); // launch rail
      // V2 rocket on the rail
      rrect(ctx, P.c(MISSILE), 9.6, 5, 2.8, 16, 1.4);
      poly(ctx, P.c(RED), [9.6, 6.5, 11, 3, 12.4, 6.5]);
      rect(ctx, P.c('#b8b6ac'), 11.4, 7, 1, 13); // shaded side
      poly(ctx, P.c(U.steelDark), [9.6, 18, 7.5, 22, 9.6, 21]);
      poly(ctx, P.c(U.steelDark), [12.4, 18, 14.5, 22, 12.4, 21]);
    }],
  },
  // Artillery: a long howitzer over a light tracked chassis.
  ARTY: {
    body: [22, 26, (ctx, P) => {
      treads(ctx, P, 1, 7, 5, 18);
      treads(ctx, P, 16, 7, 5, 18);
      plate(ctx, P, 5, 9, 12, 15, 0.5, 2);
      rect(ctx, P.team(0.35), 6, 21.5, 10, 2);
      steel(ctx, P, 7.5, 23.5, 7, 2.5, 0.5); // recoil spade
      rrect(ctx, P.c(U.steelDark), 5.5, 9.5, 11, 7, 1.5);
      plate(ctx, P, 6.5, 10, 9, 6, 0.78, 1.5, 3); // gun shield
      barrel(ctx, P, 10.1, 0, 14, 1.8);
      hatch(ctx, P, 11, 15, 2);
    }],
  },
  // Minelayer: hazard-striped bow, the mine racks behind.
  MNLY: {
    body: [22, 24, (ctx, P) => {
      treads(ctx, P, 1, 1, 5, 22);
      treads(ctx, P, 16, 1, 5, 22);
      plate(ctx, P, 5, 2, 12, 20, 0.5, 2);
      poly(ctx, P.team(0.78), [5, 7, 7, 2, 15, 2, 17, 7]);
      glass(ctx, P, 8, 3.6, 6, 1.8, 0.4);
      stripes(ctx, P, 6, 7.5, 10, 1.8, 1.2);
      // mine racks
      rrect(ctx, P.c(U.steelDark), 6, 10, 10, 11, 1);
      for (let i = 0; i < 6; i++) {
        const x = 8.5 + (i % 2) * 5;
        const y = 12 + Math.floor(i / 2) * 3.3;
        circle(ctx, P.c('#6a6a48'), x, y, 1.5);
        circle(ctx, P.c(U.track), x, y, 0.6);
      }
      rect(ctx, P.team(0.35), 6, 21, 10, 1.5);
    }],
  },
  // Radar Jammer: a truck with a steel bed, whip antennas and the jamming dish.
  MRJ: {
    body: [20, 26, (ctx, P) => {
      const bed = truck(ctx, P, 20, 26, [3, 11, 19]);
      steel(ctx, P, 3.5, bed, 13, 24 - bed, 1);
      plate(ctx, P, 3.5, 22, 13, 2, 0.5);
      line(ctx, P.c(U.steelDark), 0.8, 5, 20, 5, 11); // whip antennas
      line(ctx, P.c(U.steelDark), 0.8, 15, 20, 15, 11);
      dish(ctx, P, 10, 16, 5.5);
    }],
  },
  // Mobile Gap Generator: a truck carrying the glass gap emitter on a cross-bar.
  MGG: {
    body: [20, 26, (ctx, P) => {
      const bed = truck(ctx, P, 20, 26, [3, 11, 19]);
      plate(ctx, P, 3.5, bed, 13, 24 - bed, 0.5, 1);
      rect(ctx, P.team(0.35), 3.5, 22, 13, 2);
      steel(ctx, P, 2, 14.5, 16, 3, 0.5, false);
      circle(ctx, P.c(U.steelDark), 10, 16, 4.5);
      circle(ctx, P.c('#2c2a3e'), 10, 16, 3.6);
      circle(ctx, P.c('#5a5680'), 10, 16, 2.6);
      circle(ctx, P.c(U.glassLight), 9, 15, 1.1);
    }],
  },
  // Tesla Tank: copper coils on the hull, the tesla head on the turret.
  TTNK: {
    body: [24, 24, (ctx, P) => {
      trackedHull(ctx, P, { tx: [1, 17], ty: 1, tw: 6, th: 22, hx: 6, hy: 3, hw: 12, hh: 19, level: 0.45, glacis: 4 });
      copper(ctx, P, 7, 18, 4, 3.5, 0.6);
      copper(ctx, P, 13, 18, 4, 3.5, 0.6);
    }],
    turret: [24, 24, (ctx, P) => {
      rrect(ctx, P.c(U.steelDark), 6, 6.5, 12, 12, 3);
      plate(ctx, P, 7, 7.5, 10, 10, 0.78, 2.5, 3);
      teslaHead(ctx, P, 12, 12, 3.6);
      rect(ctx, P.c(U.steelLight), 11.3, 4, 1.4, 3); // emitter prong
    }],
  },
  // Demolition Truck: a canvas-covered bomb under hazard stripes.
  DTRK: {
    body: [20, 24, (ctx, P) => {
      const bed = truck(ctx, P, 20, 24, [3, 10, 17]);
      rect(ctx, P.team(0.4), 3.5, bed, 13, 22 - bed);
      stripes(ctx, P, 4, bed + 0.5, 12, 12.5, 2);
      tarp(ctx, P, 6, bed + 2.5, 8, 8.5);
      trefoil(ctx, P, 10, bed + 6.75, 3.2);
    }],
  },
  // Chrono Tank: an angular hull with the glass chrono core and flank pods.
  CTNK: {
    body: [24, 26, (ctx, P) => {
      treads(ctx, P, 2, 3, 5, 21);
      treads(ctx, P, 17, 3, 5, 21);
      poly(ctx, P.c(U.steelDark), [12, 0.5, 18.5, 5, 18.5, 22, 15, 25.5, 9, 25.5, 5.5, 22, 5.5, 5]);
      poly(ctx, P.team(0.55), [12, 1.5, 17.5, 5.5, 17.5, 21.5, 14.5, 24.5, 9.5, 24.5, 6.5, 21.5, 6.5, 5.5]);
      for (const y of [9, 19]) rect(ctx, P.team(0.55 * PANEL_SHADE), 7, y, 10, 0.5); // panel lines
      poly(ctx, P.team(0.82), [12, 1.5, 17.5, 5.5, 6.5, 5.5]);
      // chrono core
      circle(ctx, P.c('rgba(90,220,240,0.45)'), 12, 14, 4.4);
      bubble(ctx, P, 12, 14, 3.2);
      circle(ctx, P.c('#5fd8ea'), 12, 14, 1.4);
      // missile pods on the flanks
      pod(ctx, P, 0.5, 9, 5, 9, 1, 3);
      pod(ctx, P, 18.5, 9, 5, 9, 1, 3);
    }],
  },
  // Phase Transport: a slab-sided hull, a missile launcher turret.
  STNK: {
    body: [24, 26, (ctx, P) => {
      treads(ctx, P, 1, 2, 5, 23);
      treads(ctx, P, 18, 2, 5, 23);
      poly(ctx, P.c(U.steelDark), [7, 1, 17, 1, 19.5, 5, 19.5, 25, 4.5, 25, 4.5, 5]);
      poly(ctx, P.team(0.5), [7.5, 2, 16.5, 2, 18.5, 5.5, 18.5, 24, 5.5, 24, 5.5, 5.5]);
      poly(ctx, P.team(0.76), [7.5, 2, 16.5, 2, 18.5, 5.5, 5.5, 5.5]);
      grille(ctx, P, 5.5, 21.5, 13, 2.5);
      for (const y of [8, 19]) rect(ctx, P.team(0.5 * PANEL_SHADE), 5.5, y, 13, 0.6); // panel seams
    }],
    turret: [24, 26, (ctx, P) => {
      rrect(ctx, P.c(U.steelDark), 8, 9, 8, 9, 2);
      plate(ctx, P, 8.8, 9.8, 6.4, 7.4, 0.82, 1.5, 3);
      steel(ctx, P, 11, 2.5, 2, 9); // launch tube
      rect(ctx, P.c(MISSILE), 11.3, 2, 1.4, 3);
      poly(ctx, P.c(RED), [11.3, 2.2, 12, 0.8, 12.7, 2.2]);
    }],
  },
  // Supply Truck: crates under a canvas tarp, the tail of the load open.
  TRUK: {
    body: [20, 26, (ctx, P) => {
      const bed = truck(ctx, P, 20, 26, [3, 11, 19]);
      steel(ctx, P, 3.5, bed, 13, 24 - bed, 1);
      tarp(ctx, P, 4, bed + 0.5, 12, 10);
      rect(ctx, P.c(U.canvasDark), 4, bed + 10.5, 12, 0.6);
      for (let i = 0; i < 2; i++) crate(ctx, P, 4.5 + i * 5.8, bed + 11.4, 5.2, 2.4);
      plate(ctx, P, 3.5, 23, 13, 1.5, 0.45);
    }],
  },
  // MAD Tank: the hazard-striped seismic hammer on a slab hull.
  QTNK: {
    body: [26, 26, (ctx, P) => {
      treads(ctx, P, 1, 1, 6, 24);
      treads(ctx, P, 19, 1, 6, 24);
      rect(ctx, P.c(U.steelDark), 6, 2, 14, 23);
      plate(ctx, P, 6.5, 2.5, 13, 22, 0.5);
      rect(ctx, P.team(0.78), 6.5, 2.5, 13, 3.5);
      rect(ctx, P.team(0.34), 6.5, 22, 13, 2.5);
      // seismic hammer: a hazard ring round a steel piston
      circle(ctx, P.c(U.steelDark), 13, 14, 6.2);
      for (let k = 0; k < 12; k++) {
        const a0 = (k / 12) * Math.PI * 2;
        const a1 = ((k + 1) / 12) * Math.PI * 2;
        const pts = [13 + Math.cos(a0) * 3.8, 14 + Math.sin(a0) * 3.8, 13 + Math.cos(a0) * 5.6, 14 + Math.sin(a0) * 5.6, 13 + Math.cos(a1) * 5.6, 14 + Math.sin(a1) * 5.6, 13 + Math.cos(a1) * 3.8, 14 + Math.sin(a1) * 3.8];
        poly(ctx, P.c(k % 2 ? U.track : U.yellow), pts);
      }
      circle(ctx, P.c(U.steel), 13, 14, 3.6);
      circle(ctx, P.c(U.steelLight), 12.2, 13.2, 1.6);
    }],
  },
  // MCV: the cab up front, the folded crane over a hazard-edged deck.
  MCV: {
    body: [30, 34, (ctx, P) => {
      tyres(ctx, P, 30, [4, 12, 21, 27], 4, 5);
      rrect(ctx, P.c(U.steelDark), 3.5, 1, 23, 32, 2);
      plate(ctx, P, 4.5, 9, 21, 23, 0.55, 1.5);
      stripes(ctx, P, 4.5, 29.5, 21, 2.5, 1.5);
      // cab
      plate(ctx, P, 4.5, 1.5, 21, 7, 0.68, 2, 3);
      rect(ctx, P.team(0.88), 5.5, 1.5, 19, 1.4);
      glass(ctx, P, 6, 3.4, 18, 2.6, 0.6);
      // folded crane: turntable at the rear, lattice boom laid forward
      circle(ctx, P.c(C.yellowDark), 15, 24, 5.5);
      circle(ctx, P.c(U.yellow), 15, 24, 4.3);
      rect(ctx, P.c(C.yellowDark), 12.5, 9, 5, 15);
      rect(ctx, P.c(U.yellow), 13, 9, 4, 15);
      for (let y = 10; y < 23; y += 3) line(ctx, P.c(C.yellowDark), 0.6, 13, y, 17, y + 2.5);
      rect(ctx, P.c(U.steelDark), 14, 7.5, 2, 2.5); // hook
      circle(ctx, P.c(U.steelDark), 15, 24, 1.4);
    }],
  },
};
