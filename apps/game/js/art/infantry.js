// Art for the Red Alert infantry (engine/src/infantry.rs): rifleman, grenadier,
// rocket soldier, flamethrower, engineer, Tanya, attack dog, medic, mechanic,
// spy, thief and Shock Trooper, standing and prone (drawn nose up like every
// unit sprite), the giant ants of the ant missions, plus the module's
// specials: the dying soldiers per death type (engine/src/infantry_render.rs),
// the spy and fake tags and the Sonar Pulse ring.
//
// 2D minimal pack: two to four flat shapes per soldier (./unitkit.js): the
// uniform in team colour (shoulders and legs), the head (helmet, hard hat,
// hair), the weapon or tool held forward and at most one accent (fuel tanks,
// coil pack, a red cross). One hard shadow under the soldier.

import { rect, circle, poly, line, ring } from './kit.js';
import { M, TEAM, box, disc, shape, sprite, inner } from './unitkit.js';

const OUTLINE = '#141414';
const RED = '#c8281e';
const HELMET = M.olive;

// ---- Standing soldiers (12 x 16) ------------------------------------------------------------

const [SW, SH] = inner(12, 16);

/** The uniform: shoulders and the two legs behind them, in `fill` (the team, or the spy's suit). */
function uniform(fill = TEAM) {
  return [fill, box(0, 4.5, SW, 6, 2.5), box(1.5, 9.5, 3, SH - 9.5, 1), box(SW - 4.5, 9.5, 3, SH - 9.5, 1)];
}

/** A standing soldier: the uniform, the head in `head` and up to two more parts (weapon, accent). */
function soldier(head, ...extra) {
  return { body: sprite(12, 16, [uniform(), [head, disc(SW / 2, 7, 2.4)], ...extra], box(0, 4.5, SW, SH - 4.5, 3)) };
}

/** A weapon held forward on the right: `w` wide, `len` long from the front edge. */
const forward = (w, len, x = SW - w - 1.8) => box(x, 0, w, len, Math.min(0.6, w / 2));

// ---- Prone soldiers (8 x 14) ----------------------------------------------------------------

const [PW, PH] = inner(8, 14);

/**
 * A soldier lying along its facing: the uniform from the head back, the head
 * in `head`, up to two more `parts` and `held`, geometries in the head's
 * colour (a kit bag, a pistol).
 */
export function prone(head, parts = [], held = []) {
  const body = box(0, 3.5, PW, PH - 3.5, 2.5);
  return sprite(8, 14, [[TEAM, body], [head, disc(PW / 2, 4.2, 2.1), ...held], ...parts], body);
}

/** A weapon held forward by a lying soldier. */
export const proneForward = (w, len, x = PW - w - 0.6) => box(x, 0, w, len, Math.min(0.5, w / 2));

/** A red cross centred on (x, y), `s` across. */
const cross = (x, y, s) => [M.red, box(x - s / 2, y - s / 6, s, s / 3), box(x - s / 6, y - s / 2, s / 3, s)];

// ---- Ants (22 x 28) and the dog (10 x 16) ---------------------------------------------------

const [AW, AH] = inner(22, 28);

/** A giant ant from above: three leg bars, head, thorax and abdomen, a team mark, and its accent. */
function ant(...accent) {
  return {
    body: sprite(22, 28, [
      [M.darker, box(0, 9, AW, 1.4), box(0, 12.5, AW, 1.4), box(0, 16, AW, 1.4)],
      [M.rust, disc(AW / 2, 4, 4), box(AW / 2 - 3, 7, 6, 9, 2), disc(AW / 2, AH - 6.5, 6.5)],
      [TEAM, box(AW / 2 - 2.5, 10, 5, 3, 0.5)],
      ...accent,
    ], box(0, 8, AW, AH - 8, 4)),
  };
}

const [DW, DH] = inner(10, 16);

/** Standing infantry (sprite key -> { body: [w, h, draw] }). */
export const INFANTRY_DRAW = {
  // Rifle Infantry: a rifle held forward.
  E1: soldier(HELMET, [M.dark, forward(1.4, 9)]),
  // Grenadier: a grenade raised in the right hand.
  E2: soldier(HELMET, [M.dark, disc(SW - 2.4, 1.8, 1.8)]),
  // Rocket Soldier: the long launch tube over the right shoulder.
  E3: soldier(HELMET, [M.steel2, forward(2.6, 12, SW - 3.4)]),
  // Flamethrower: the nozzle forward, twin fuel tanks on the back.
  E4: soldier(HELMET, [M.dark, forward(1.3, 7)], [M.yellow, box(1.2, 9.5, 3.2, 4, 1.2), box(SW - 4.4, 9.5, 3.2, 4, 1.2)]),
  // Engineer: a yellow hard hat and a tool box.
  E6: soldier(M.yellow, [M.steel, box(SW - 3.6, 0, 3.4, 3.6, 0.5)]),
  // Tanya: dark hair, a pistol in each hand.
  E7: soldier(M.wood, [M.dark, forward(1.2, 6, 0.6), forward(1.2, 6, SW - 1.8)]),
  // Giant ants of the ant missions (OpenRA WarriorAnt, FireAnt, ScoutAnt): the warrior is plain,
  // the fire ant has hazard bands, the scout glassy wings.
  ANT: ant(),
  FIREANT: ant([M.yellow, box(AW / 2 - 5, AH - 10, 10, 1.6), box(AW / 2 - 5, AH - 6.5, 10, 1.6)]),
  SCOUTANT: ant([M.glass, shape(AW / 2 - 2, 11, 0.5, AH - 8, 2.5, AH - 5, AW / 2 - 1, 14), shape(AW / 2 + 2, 11, AW - 0.5, AH - 8, AW - 2.5, AH - 5, AW / 2 + 1, 14)]),
  // Attack dog: a long brown body, the head forward, a team collar.
  DOG: {
    body: sprite(10, 16, [
      [M.rust, box(0.4, 4, DW - 0.8, DH - 4, 3)],
      [M.wood, box(1.4, 0, DW - 2.8, 5, 2)],
      [TEAM, box(1.4, 4.6, DW - 2.8, 1.6, 0.5)],
    ], box(0.4, 4, DW - 0.8, DH - 4, 3)),
  },
  // Medic: a white helmet with a red cross, the white kit bag held forward.
  MEDI: {
    body: sprite(12, 16, [uniform(), [M.paint, disc(SW / 2, 7, 2.4), box(SW - 3.6, 0, 3.4, 3.4, 0.5)], cross(SW / 2, 7, 2.6)], box(0, 4.5, SW, SH - 4.5, 3)),
  },
  // Mechanic: a yellow cap and a big wrench.
  MECH: soldier(M.yellow, [M.steel, forward(1.4, 9)]),
  // Spy: a grey suit and a dark hat, a team tie, a small pistol.
  SPY: {
    body: sprite(12, 16, [
      uniform(M.steel),
      [TEAM, box(SW / 2 - 0.7, 4.5, 1.4, 4.5)],
      [M.dark, disc(SW / 2, 7, 2.4), forward(1.2, 6)],
    ], box(0, 4.5, SW, SH - 4.5, 3)),
  },
  // Thief: a dark hood, the loot sack over the left shoulder.
  THF: soldier(M.darker, [M.canvas, box(0.4, 0, 4.4, 5, 2)]),
  // Shock Trooper: the zapper forward, the tesla coil pack on the back.
  SHOK: soldier(HELMET, [M.steel2, forward(1.6, 8)], [M.blue, box(2, 9.5, SW - 4, 4, 1.5)]),
};

/** Prone poses (TakeCover): every soldier but the dog and the thief lies down (E1 and E3 in art/veterancy.js). */
export const INFANTRY_PRONE = {
  E2: prone(HELMET, [[M.dark, disc(PW - 1.6, 1.5, 1.5)]]),
  E4: prone(HELMET, [[M.dark, proneForward(1, 5)], [M.yellow, box(0.6, PH - 4.5, 2.2, 3.5, 1), box(PW - 2.8, PH - 4.5, 2.2, 3.5, 1)]]),
  E6: prone(M.yellow, [[M.steel, box(PW - 2.8, 0, 2.6, 2.8, 0.4)]]),
  E7: prone(M.wood, [[M.dark, proneForward(1, 4.5, 0.4), proneForward(1, 4.5, PW - 1.4)]]),
  MEDI: prone(M.paint, [cross(PW / 2, 4.2, 2.2)], [box(PW - 2.8, 0, 2.6, 2.6, 0.4)]),
  MECH: prone(M.yellow, [[M.steel, proneForward(1.2, 5.5)]]),
  SPY: prone(M.dark, [], [proneForward(1, 4.5)]),
  SHOK: prone(HELMET, [[M.steel2, proneForward(1.4, 5)], [M.blue, box(1.2, PH - 4.5, PW - 2.4, 3.2, 1)]]),
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

