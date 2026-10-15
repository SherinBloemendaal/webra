// Art for the Red Alert infantry (engine/src/infantry.rs): rifleman, grenadier,
// rocket soldier, flamethrower, engineer, Tanya, attack dog, medic, mechanic,
// spy, thief and Shock Trooper, standing and prone (drawn nose up like every
// unit sprite), the giant ants of the ant missions, plus the module's
// specials: the dying soldiers per death type (engine/src/infantry_render.rs),
// the spy and fake tags and the Sonar Pulse ring.
//
// Materials follow the design canvas's Units board (2D minimal pack): an olive
// helmet, team shoulders with a belt line, skin at the face and hands, and per
// soldier its kit in steel, hazard yellow or copper. Helpers come from ./kit.js
// and ./unitkit.js.

import { C, rect, rrect, circle, poly, line, ring } from './kit.js';
import { U, PANEL_SHADE, copper } from './unitkit.js';

const HELMET = U.helmet;
const OUTLINE = '#141414';
const RED = '#c8281e';
const WHITE = '#e8e6dc';

/** A hand (or a pair) in skin colour at each [x, y]. */
export function hands(ctx, P, ...pts) {
  for (const [x, y] of pts) circle(ctx, P.c(U.skin), x, y, 0.6);
}

/**
 * Shadow, shoulders with a belt line and the head of a standing soldier seen
 * from above: the face shows in front of the `head` cover (helmet, hat, hood).
 */
export function soldier(ctx, P, head, body = 0.7) {
  circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
  poly(ctx, P.team(body), [1.5, 5.5, 8.5, 5.5, 8, 9.5, 2, 9.5]);
  rect(ctx, P.team(body * PANEL_SHADE), 2, 8.2, 6, 0.5); // belt
  circle(ctx, P.team(0.55), 5, 6, 2.2);
  circle(ctx, P.c(U.skin), 5, 5.1, 1.5);
  circle(ctx, P.c(head), 5, 5.7, 1.7);
}

/** A soldier lying along its facing: legs behind, back with a belt line, face and head forward. */
export function lying(ctx, P, head) {
  circle(ctx, P.c(C.shadow), 4.5, 8, 3.4);
  rect(ctx, P.team(0.4), 2.2, 9, 1.5, 4.6);
  rect(ctx, P.team(0.4), 4.3, 9, 1.5, 4.6);
  poly(ctx, P.team(0.7), [1.5, 5, 6.5, 5, 6, 10, 2, 10]);
  rect(ctx, P.team(0.7 * PANEL_SHADE), 1.9, 8.4, 4.3, 0.5); // belt
  circle(ctx, P.team(0.55), 4, 4.4, 1.9);
  circle(ctx, P.c(U.skin), 4, 3.6, 1.3);
  circle(ctx, P.c(head), 4, 4.2, 1.5);
}

/** A hard hat in hazard yellow with a black band (engineer, mechanic). */
function hardHat(ctx, P, cx, cy, r) {
  circle(ctx, P.c(C.yellowDark), cx, cy, r);
  circle(ctx, P.c(U.yellow), cx, cy, r * 0.82);
  rect(ctx, P.c(U.track), cx - r * 0.8, cy - 0.3, r * 1.6, 0.6);
}

/** A red cross on a white ground (the medic's helmet and kit). */
function cross(ctx, P, x, y, s) {
  rect(ctx, P.c(RED), x - s / 2, y - s / 6, s, s / 3);
  rect(ctx, P.c(RED), x - s / 6, y - s / 2, s / 3, s);
}

/** A fuel tank seen from above: hazard yellow with a black band, a steel cap. */
function fuelTank(ctx, P, x, y, w, h) {
  rrect(ctx, P.c(C.yellowDark), x, y, w, h, w / 2);
  rrect(ctx, P.c(U.yellow), x + 0.25, y + 0.25, w - 0.5, h - 0.5, w / 2 - 0.25);
  rect(ctx, P.c(U.track), x + 0.25, y + h * 0.45, w - 0.5, h * 0.18);
  circle(ctx, P.c(U.steel), x + w / 2, y + 0.9, w * 0.25);
}

/** A giant ant seen from above (facing north): ant brown, its `accent` drawn by the caller. */
function ant(ctx, P, legs, accent) {
  circle(ctx, P.c(C.shadow), 8, 12, 6);
  // Legs: three pairs from the thorax, bent backwards.
  for (const [y, dy] of [[8.5, -2.5], [10.5, 0.5], [12.5, 3.5]]) {
    line(ctx, P.c(legs), 0.9, 6.4, y, 1.4, y + dy);
    line(ctx, P.c(legs), 0.9, 9.6, y, 14.6, y + dy);
  }
  poly(ctx, P.c(U.antDark), [5.6, 1.4, 4.6, 0.3, 6.4, 1.8]); // mandibles
  poly(ctx, P.c(U.antDark), [10.4, 1.4, 11.4, 0.3, 9.6, 1.8]);
  circle(ctx, P.c(U.ant), 8, 3.6, 2.8); // head
  circle(ctx, P.c(U.antDark), 8, 10, 2.4); // thorax
  rect(ctx, P.team(0.9), 6.8, 9.2, 2.4, 1.4); // team mark
  circle(ctx, P.c(U.ant), 8, 16.4, 4.4); // abdomen
  accent(ctx, P);
  circle(ctx, P.c(OUTLINE), 6.8, 2.6, 0.6); // eyes
  circle(ctx, P.c(OUTLINE), 9.2, 2.6, 0.6);
}

/** Standing infantry (sprite key -> { body: [w, h, draw] }). */
export const INFANTRY_DRAW = {
  // Rifle Infantry: a rifle held forward.
  E1: {
    body: [10, 12, (ctx, P) => {
      rect(ctx, P.c(U.steelDark), 6.5, 0, 1, 6); // rifle
      soldier(ctx, P, HELMET);
      hands(ctx, P, [7, 3.6], [6.6, 5.6]);
    }],
  },
  // Grenadier: a raised arm with a grenade, a pouch on the hip.
  E2: {
    body: [10, 12, (ctx, P) => {
      soldier(ctx, P, HELMET);
      line(ctx, P.team(0.6), 1.2, 7.6, 6.2, 8.4, 2.8); // throwing arm
      hands(ctx, P, [8.4, 2.6]);
      circle(ctx, P.c('#3a4226'), 8.4, 1.5, 1.1); // grenade
      rect(ctx, P.c(U.canvasDark), 1.6, 7.6, 1.8, 1.6); // pouch
    }],
  },
  // Rocket Soldier: a steel launch tube over the right shoulder.
  E3: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      poly(ctx, P.team(0.7), [1.5, 5.5, 8.5, 5.5, 8, 9.5, 2, 9.5]);
      rect(ctx, P.team(0.7 * PANEL_SHADE), 2, 8.2, 6, 0.5);
      rect(ctx, P.c(U.steelDark), 6.2, 0.5, 2, 9); // launcher
      rect(ctx, P.c(U.steel), 6.6, 1.5, 0.8, 7.5);
      rect(ctx, P.c(U.steelLight), 6.6, 0.5, 1.2, 1.2);
      hands(ctx, P, [6, 3.4]);
      circle(ctx, P.team(0.55), 5, 6, 2.2);
      circle(ctx, P.c(U.skin), 4.6, 5.1, 1.5);
      circle(ctx, P.c(HELMET), 4.6, 5.7, 1.7); // helmet
    }],
  },
  // Flamethrower: twin hazard-yellow fuel tanks on the back, the nozzle forward.
  E4: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      fuelTank(ctx, P, 2.6, 8.2, 1.8, 3.6);
      fuelTank(ctx, P, 5, 8.2, 1.8, 3.6);
      poly(ctx, P.team(0.7), [1.5, 5.5, 8.5, 5.5, 8, 9, 2, 9]);
      rect(ctx, P.c(U.steelDark), 6.4, 0.5, 1.1, 5.6); // nozzle
      circle(ctx, P.c('#f08a24'), 7, 0.8, 0.7);
      hands(ctx, P, [7, 4.2]);
      circle(ctx, P.team(0.55), 5, 6, 2.2);
      circle(ctx, P.c(U.skin), 5, 5.1, 1.5);
      circle(ctx, P.c(HELMET), 5, 5.7, 1.7);
      rect(ctx, P.c(U.glassDark), 4, 4.3, 2, 0.6); // mask visor
    }],
  },
  // Engineer: a hazard-yellow hard hat and a steel tool box.
  E6: {
    body: [10, 12, (ctx, P) => {
      soldier(ctx, P, C.yellow);
      hardHat(ctx, P, 5, 5.7, 1.8);
      rrect(ctx, P.c(U.steelDark), 6.7, 7.1, 2.8, 2.2, 0.4); // tool box
      rect(ctx, P.c(U.steel), 7, 7.4, 2.2, 1.6);
      rect(ctx, P.c(U.steelLight), 7.4, 6.7, 1.4, 0.6);
      hands(ctx, P, [7.6, 6.6]);
    }],
  },
  // Tanya: no helmet, dark hair, a steel pistol in each hand.
  E7: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      poly(ctx, P.team(0.7), [1.8, 5.5, 8.2, 5.5, 7.6, 9.5, 2.4, 9.5]);
      rect(ctx, P.team(0.7 * PANEL_SHADE), 2.2, 8.2, 5.6, 0.5);
      rect(ctx, P.c(U.steelDark), 1.6, 1.8, 0.9, 3.6); // pistols
      rect(ctx, P.c(U.steelDark), 7.5, 1.8, 0.9, 3.6);
      rect(ctx, P.c(U.steelLight), 1.8, 2, 0.4, 1.4);
      rect(ctx, P.c(U.steelLight), 7.7, 2, 0.4, 1.4);
      hands(ctx, P, [2, 5], [8, 5]);
      circle(ctx, P.c(U.skin), 5, 5.8, 2);
      circle(ctx, P.c('#4a2a16'), 5, 6.4, 1.7); // hair
      rect(ctx, P.c('#4a2a16'), 4.5, 7.4, 1, 2.2); // ponytail
    }],
  },
  // Giant ants of the ant missions (OpenRA WarriorAnt, FireAnt, ScoutAnt):
  // head, thorax and abdomen with six legs and mandibles, a team coloured mark.
  // The warrior is plain, the fire ant has hazard bands, the scout glassy wings.
  ANT: {
    body: [16, 22, (ctx, P) => ant(ctx, P, U.track, () => {
      circle(ctx, P.c(U.antDark), 8, 17, 2.6);
    })],
  },
  FIREANT: {
    body: [16, 22, (ctx, P) => ant(ctx, P, U.antDark, () => {
      for (const y of [14.4, 17.4]) rect(ctx, P.c(U.yellow), 4.6, y, 6.8, 1.2);
      circle(ctx, P.c('#f08a24'), 8, 20, 1.2);
    })],
  },
  SCOUTANT: {
    body: [16, 22, (ctx, P) => ant(ctx, P, U.antDark, () => {
      poly(ctx, P.c('rgba(95,147,173,0.75)'), [6.6, 10.6, 1.4, 15.6, 2.6, 18.2, 7.2, 12.2]);
      poly(ctx, P.c('rgba(95,147,173,0.75)'), [9.4, 10.6, 14.6, 15.6, 13.4, 18.2, 8.8, 12.2]);
      line(ctx, P.c(U.glassLight), 0.4, 6.2, 11.4, 2.4, 15.8);
      line(ctx, P.c(U.glassLight), 0.4, 9.8, 11.4, 13.6, 15.8);
    })],
  },
  // Attack dog: a long body, head forward, a team coloured collar.
  DOG: {
    body: [8, 14, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 4.5, 8, 3.4);
      poly(ctx, P.c(U.ant), [2.4, 5, 5.6, 5, 5.8, 11, 4, 12, 2.2, 11]); // body
      rect(ctx, P.c(U.antDark), 3.6, 6, 0.8, 4.6); // back
      line(ctx, P.c(U.ant), 0.9, 4, 11.4, 4.6, 13.6); // tail
      rect(ctx, P.team(0.9), 2.6, 4.2, 2.8, 1); // collar
      poly(ctx, P.c('#7c3a28'), [2.8, 1.4, 5.2, 1.4, 5.4, 4.6, 2.6, 4.6]); // head
      circle(ctx, P.c(OUTLINE), 4, 1, 0.7); // nose
      poly(ctx, P.c(U.antDark), [2.4, 2.8, 1.6, 3.8, 2.6, 4.2]); // ears
      poly(ctx, P.c(U.antDark), [5.6, 2.8, 6.4, 3.8, 5.4, 4.2]);
    }],
  },
  // Medic: an olive helmet with a red cross on white, a kit bag.
  MEDI: {
    body: [10, 12, (ctx, P) => {
      soldier(ctx, P, HELMET);
      circle(ctx, P.c(WHITE), 5, 5.7, 1.1);
      cross(ctx, P, 5, 5.7, 1.6);
      rect(ctx, P.c(WHITE), 6.8, 7.3, 2.6, 2);
      cross(ctx, P, 8.1, 8.3, 1.6);
      hands(ctx, P, [7.4, 6.8]);
    }],
  },
  // Mechanic: a hazard-yellow cap and a big steel wrench.
  MECH: {
    body: [10, 12, (ctx, P) => {
      soldier(ctx, P, C.yellow);
      hardHat(ctx, P, 5, 5.7, 1.6);
      line(ctx, P.c(U.steel), 1, 7.8, 7.5, 8.6, 2.2); // wrench
      ring(ctx, P.c(U.steelLight), 8.6, 1.8, 0.8, 0.6);
      hands(ctx, P, [7.9, 6.6]);
    }],
  },
  // Spy: a steel grey suit and hat, a team tie, a small pistol.
  SPY: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      poly(ctx, P.c(U.steel), [1.5, 5.5, 8.5, 5.5, 8, 9.5, 2, 9.5]); // suit
      rect(ctx, P.c(U.steelSeam), 2, 8.2, 6, 0.5);
      rect(ctx, P.team(0.8), 4.4, 5.6, 1.2, 2.6); // tie
      rect(ctx, P.c(U.steelDark), 7, 2.6, 0.8, 2.8); // pistol
      hands(ctx, P, [7.4, 5.4]);
      circle(ctx, P.c(U.skin), 5, 5, 1.6);
      circle(ctx, P.c(U.steelDark), 5, 5.8, 2.4); // hat brim
      circle(ctx, P.c('#4a4e54'), 5, 5.7, 1.5);
    }],
  },
  // Thief: a steel grey hood, a team jacket and a loot sack.
  THF: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      circle(ctx, P.c('#a08454'), 3, 8.6, 2); // sack
      line(ctx, P.c('#6e5a38'), 0.5, 2, 7.4, 3.8, 7.2);
      poly(ctx, P.team(0.45), [1.8, 5.5, 8.2, 5.5, 7.8, 9.5, 2.2, 9.5]);
      hands(ctx, P, [3.6, 7], [7.6, 6]);
      circle(ctx, P.c(U.steelDark), 5, 5.8, 2.2); // hood
      rect(ctx, P.c(U.skin), 4, 4.4, 2, 0.8); // eyes slit
    }],
  },
  // Shock Trooper: a heavy suit with a copper Tesla coil on the back.
  SHOK: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.8);
      copper(ctx, P, 2.8, 7.6, 4.4, 3.6, 1); // coil pack
      circle(ctx, P.c('#7fb8ff'), 5, 9.4, 1);
      poly(ctx, P.team(0.65), [1.2, 5.2, 8.8, 5.2, 8.4, 8.6, 1.6, 8.6]);
      rect(ctx, P.c(U.steel), 6.8, 0.6, 1.4, 5); // zapper
      circle(ctx, P.c('#cfe8ff'), 7.5, 0.8, 0.8);
      hands(ctx, P, [7.5, 4.6]);
      circle(ctx, P.c(HELMET), 5, 5.5, 2.3); // helmet
      rect(ctx, P.c('#7fb8ff'), 4, 4, 2, 0.7); // visor
    }],
  },
};

/** Prone poses (TakeCover): every soldier but the dog and the thief lies down (E1 and E3 in art/veterancy.js). */
export const INFANTRY_PRONE = {
  E2: [8, 14, (ctx, P) => {
    lying(ctx, P, HELMET);
    circle(ctx, P.c('#3a4226'), 6.6, 3, 1); // grenade in hand
    hands(ctx, P, [6.4, 4.2]);
  }],
  E4: [8, 14, (ctx, P) => {
    fuelTank(ctx, P, 2.4, 7.4, 1.6, 3.2);
    fuelTank(ctx, P, 4.4, 7.4, 1.6, 3.2);
    lying(ctx, P, HELMET);
    rect(ctx, P.c(U.steelDark), 5.4, 0.2, 1, 4.4);
  }],
  E6: [8, 14, (ctx, P) => {
    lying(ctx, P, C.yellow);
    hardHat(ctx, P, 4, 4.2, 1.5);
  }],
  E7: [8, 14, (ctx, P) => {
    lying(ctx, P, '#4a2a16');
    rect(ctx, P.c(U.steelDark), 1.6, 0.6, 0.9, 3.4);
    rect(ctx, P.c(U.steelDark), 5.6, 0.6, 0.9, 3.4);
    hands(ctx, P, [2, 3.8], [6, 3.8]);
  }],
  MEDI: [8, 14, (ctx, P) => {
    lying(ctx, P, HELMET);
    circle(ctx, P.c(WHITE), 4, 4.2, 1);
    cross(ctx, P, 4, 4.2, 1.5);
  }],
  MECH: [8, 14, (ctx, P) => {
    lying(ctx, P, C.yellow);
    hardHat(ctx, P, 4, 4.2, 1.4);
  }],
  SPY: [8, 14, (ctx, P) => {
    lying(ctx, P, U.steelDark);
    rect(ctx, P.c(U.steelDark), 5.4, 1.2, 0.8, 2.6);
  }],
  SHOK: [8, 14, (ctx, P) => {
    copper(ctx, P, 2.2, 7, 3.6, 3.6, 1);
    lying(ctx, P, HELMET);
    rect(ctx, P.c(U.steel), 5.4, 0, 1.2, 4.4);
  }],
};

/** A fallen soldier (death animations): limbs spread, team coloured. */
function fallen(ctx, P, w, h) {
  const cx = w / 2;
  circle(ctx, P.c('rgba(0,0,0,0.25)'), cx, h / 2 + 1, 4);
  line(ctx, P.team(0.4), 1.2, cx - 1, h / 2 + 2, cx - 3, h - 1); // legs
  line(ctx, P.team(0.4), 1.2, cx + 1, h / 2 + 2, cx + 3, h - 1.5);
  line(ctx, P.team(0.55), 1, cx - 2, h / 2 - 1, cx - 4.5, h / 2 + 1); // arms
  line(ctx, P.team(0.55), 1, cx + 2, h / 2 - 1, cx + 4.6, h / 2 - 2.5);
  poly(ctx, P.team(0.6), [cx - 2.4, h / 2 - 2, cx + 2.4, h / 2 - 2, cx + 2, h / 2 + 2.5, cx - 2, h / 2 + 2.5]);
}

/**
 * Special sprites ([w, h, draw]), at most 8; see SPECIAL_SLOTS in sprites.js.
 * Order matters: engine/src/infantry_render.rs uses `infantry_base + index`.
 */
export const INFANTRY_SPECIALS = [
  // 0: fallen (die1, die2: shot)
  [12, 14, (ctx, P) => {
    fallen(ctx, P, 12, 14);
    circle(ctx, P.c(HELMET), 6, 3.6, 1.6);
    circle(ctx, P.c('rgba(120,20,16,0.7)'), 7.6, 8.8, 1.4);
  }],
  // 1: blown up (die3, die4: explosions): scorch and scattered remains
  [14, 14, (ctx, P) => {
    circle(ctx, P.c('rgba(30,24,18,0.55)'), 7, 7, 6.5);
    fallen(ctx, P, 14, 14);
    circle(ctx, P.c('rgba(120,20,16,0.75)'), 4, 5, 1.2);
    circle(ctx, P.c('rgba(120,20,16,0.75)'), 10.5, 9.5, 1);
  }],
  // 2: burned (die5: fire): a charred body with flames
  [12, 14, (ctx, P) => {
    circle(ctx, P.c('rgba(20,16,12,0.5)'), 6, 7.5, 5);
    poly(ctx, P.c('#2a1e16'), [3.6, 5, 8.4, 5, 8, 11, 4, 11]);
    circle(ctx, P.c('#1e1610'), 6, 3.8, 1.8);
    poly(ctx, P.c('#f08a24'), [4.4, 6, 5.4, 2.2, 6.4, 6]);
    poly(ctx, P.c('#ffd36a'), [6.2, 8, 7.2, 4.4, 8.2, 8]);
    poly(ctx, P.c('#f5b030'), [3.4, 10, 4.2, 7.4, 5, 10]);
  }],
  // 3: electrocuted (die6): a skeleton in blue sparks
  [12, 14, (ctx, P) => {
    circle(ctx, P.c('rgba(110,170,255,0.4)'), 6, 7, 5.6);
    line(ctx, P.c('#f2f0e6'), 0.9, 6, 4.5, 6, 10); // spine
    for (const y of [6, 7.4, 8.8]) line(ctx, P.c('#f2f0e6'), 0.6, 4.4, y, 7.6, y); // ribs
    line(ctx, P.c('#f2f0e6'), 0.6, 6, 10, 4.4, 13);
    line(ctx, P.c('#f2f0e6'), 0.6, 6, 10, 7.6, 13);
    circle(ctx, P.c('#f2f0e6'), 6, 3.2, 1.6); // skull
    line(ctx, P.c('#cfe8ff'), 0.6, 1, 2, 3, 5);
    line(ctx, P.c('#cfe8ff'), 0.6, 11, 4, 9, 7);
  }],
  // 4: crushed: a flattened body
  [12, 12, (ctx, P) => {
    circle(ctx, P.c('rgba(90,16,12,0.55)'), 6, 6, 5);
    poly(ctx, P.team(0.4), [2, 4.6, 10, 4, 10.4, 7.6, 1.6, 8]);
    circle(ctx, P.c(HELMET), 3, 6, 1.4);
  }],
  // 5: spy tag (WithDecoration@disguise): a hat over the disguised spy, for its owner
  [8, 6, (ctx, P) => {
    poly(ctx, P.c(OUTLINE), [0, 4.6, 8, 4.6, 8, 6, 0, 6]);
    poly(ctx, P.c(OUTLINE), [1.4, 4.8, 2, 0.6, 6, 0.6, 6.6, 4.8]);
    poly(ctx, P.c('#3a3a44'), [0.6, 4.9, 7.4, 4.9, 7.4, 5.5, 0.6, 5.5]);
    poly(ctx, P.c('#3a3a44'), [2.1, 4.6, 2.5, 1.2, 5.5, 1.2, 5.9, 4.6]);
    rect(ctx, P.team(0.9), 2.4, 3.4, 3.2, 0.8);
  }],
  // 6: fake tag (InfiltrateForDecoration): a red "F" plate
  [10, 8, (ctx, P) => {
    rect(ctx, P.c(OUTLINE), 0, 0, 10, 8);
    rect(ctx, P.c(RED), 0.8, 0.8, 8.4, 6.4);
    rect(ctx, P.c('#ffffff'), 3, 2, 1.2, 4);
    rect(ctx, P.c('#ffffff'), 3, 2, 4, 1);
    rect(ctx, P.c('#ffffff'), 3, 3.6, 3, 0.9);
  }],
  // 7: Sonar Pulse ring
  [48, 48, (ctx, P) => {
    ring(ctx, P.c('rgba(120,220,255,0.5)'), 24, 24, 22, 2.4);
    ring(ctx, P.c('rgba(200,245,255,0.8)'), 24, 24, 18, 1);
  }],
];

