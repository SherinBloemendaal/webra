// Art for the Red Alert infantry beyond the rifleman and rocket soldier
// (engine/src/infantry.rs): grenadier, flamethrower, engineer, Tanya, attack
// dog, medic, mechanic, spy, thief and Shock Trooper, standing and prone
// (drawn nose up like every unit sprite), plus the module's specials: the
// dying soldiers per death type (engine/src/infantry_render.rs), the spy and
// fake tags and the Sonar Pulse ring. Helpers and palette come from ./kit.js.

import { C, rect, rrect, circle, poly, line, ring } from './kit.js';

const HELMET = '#5d6b3a';
const OUTLINE = '#141414';
const RED = '#c8281e';

/** Shadow, shoulders and the head of a standing soldier seen from above. */
function soldier(ctx, P, head) {
  circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
  poly(ctx, P.team(0.7), [1.5, 5.5, 8.5, 5.5, 8, 9.5, 2, 9.5]);
  circle(ctx, P.team(0.55), 5, 6, 2.2);
  circle(ctx, P.c(head), 5, 5.5, 1.7);
}

/** A soldier lying along its facing: legs behind, back, head forward. */
function lying(ctx, P, head) {
  circle(ctx, P.c(C.shadow), 4.5, 8, 3.4);
  rect(ctx, P.team(0.4), 2.2, 9, 1.5, 4.6);
  rect(ctx, P.team(0.4), 4.3, 9, 1.5, 4.6);
  poly(ctx, P.team(0.7), [1.5, 5, 6.5, 5, 6, 10, 2, 10]);
  circle(ctx, P.team(0.55), 4, 4.4, 1.9);
  circle(ctx, P.c(head), 4, 4.1, 1.5);
}

/** A red cross on a white ground (the medic's helmet and kit). */
function cross(ctx, P, x, y, s) {
  rect(ctx, P.c(RED), x - s / 2, y - s / 6, s, s / 3);
  rect(ctx, P.c(RED), x - s / 6, y - s / 2, s / 3, s);
}

/** Standing infantry (sprite key -> [w, h, draw]). */
/** A giant ant seen from above (facing north) in `dark` and `light`. */
function antDraw(dark, light) {
  return (ctx, P) => {
    circle(ctx, P.c(C.shadow), 8, 12, 6);
    // Legs: three pairs from the thorax, bent backwards.
    for (const [y, dy] of [[8.5, -2.5], [10.5, 0.5], [12.5, 3.5]]) {
      line(ctx, P.c(dark), 0.9, 6.4, y, 1.4, y + dy);
      line(ctx, P.c(dark), 0.9, 9.6, y, 14.6, y + dy);
    }
    poly(ctx, P.c(dark), [5.6, 1.4, 4.6, 0.3, 6.4, 1.8]); // mandibles
    poly(ctx, P.c(dark), [10.4, 1.4, 11.4, 0.3, 9.6, 1.8]);
    circle(ctx, P.c(light), 8, 3.6, 2.8); // head
    circle(ctx, P.c(dark), 8, 10, 2.4); // thorax
    rect(ctx, P.team(0.9), 6.8, 9.2, 2.4, 1.4); // team mark
    circle(ctx, P.c(light), 8, 16.4, 4.4); // abdomen
    circle(ctx, P.c(dark), 8, 17, 2.6);
    circle(ctx, P.c(OUTLINE), 6.8, 2.6, 0.6); // eyes
    circle(ctx, P.c(OUTLINE), 9.2, 2.6, 0.6);
  };
}

export const INFANTRY_DRAW = {
  // Grenadier: a raised arm with a grenade, a pouch on the hip.
  E2: {
    body: [10, 12, (ctx, P) => {
      soldier(ctx, P, HELMET);
      line(ctx, P.team(0.6), 1.2, 7.6, 6.2, 8.4, 2.4); // throwing arm
      circle(ctx, P.c('#3a4226'), 8.4, 1.9, 1.1); // grenade
      rect(ctx, P.c(C.canvasDark), 1.6, 7.6, 1.8, 1.6); // pouch
    }],
  },
  // Flamethrower: twin fuel tanks on the back, the nozzle forward.
  E4: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      rect(ctx, P.c('#7a2a18'), 2.6, 8.2, 1.8, 3.4);
      rect(ctx, P.c('#7a2a18'), 5, 8.2, 1.8, 3.4);
      poly(ctx, P.team(0.7), [1.5, 5.5, 8.5, 5.5, 8, 9, 2, 9]);
      rect(ctx, P.c(C.steelDark), 6.4, 0.5, 1.1, 5.6); // nozzle
      circle(ctx, P.c('#f08a24'), 7, 0.8, 0.7);
      circle(ctx, P.team(0.55), 5, 6, 2.2);
      circle(ctx, P.c('#4a4a40'), 5, 5.5, 1.7); // hood
    }],
  },
  // Engineer: a yellow hard hat and a tool box.
  E6: {
    body: [10, 12, (ctx, P) => {
      soldier(ctx, P, C.yellow);
      rect(ctx, P.c(C.steel), 6.8, 7.2, 2.6, 2); // tool box
      rect(ctx, P.c(C.steelLight), 7.4, 6.8, 1.4, 0.6);
    }],
  },
  // Tanya: no helmet, dark hair, a pistol in each hand.
  E7: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      poly(ctx, P.team(0.7), [1.8, 5.5, 8.2, 5.5, 7.6, 9.5, 2.4, 9.5]);
      rect(ctx, P.c(C.steelDark), 1.6, 1.8, 0.9, 3.6); // pistols
      rect(ctx, P.c(C.steelDark), 7.5, 1.8, 0.9, 3.6);
      circle(ctx, P.c(C.skin), 5, 5.8, 2);
      circle(ctx, P.c('#4a2a16'), 5, 6.4, 1.7); // hair
      rect(ctx, P.c('#4a2a16'), 4.5, 7.4, 1, 2.2); // ponytail
    }],
  },
  // Giant ants of the ant missions (OpenRA WarriorAnt, FireAnt, ScoutAnt):
  // head, thorax and abdomen with six legs and mandibles, a team coloured mark.
  ANT: { body: [16, 22, antDraw('#5a2c1c', '#7a3e26')] },
  FIREANT: { body: [16, 22, antDraw('#9a2a14', '#d0501e')] },
  SCOUTANT: { body: [16, 22, antDraw('#24201c', '#4a403a')] },
  // Attack dog: a long body, head forward, a team coloured collar.
  DOG: {
    body: [8, 14, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 4.5, 8, 3.4);
      poly(ctx, P.c('#6b4a2a'), [2.4, 5, 5.6, 5, 5.8, 11, 4, 12, 2.2, 11]); // body
      line(ctx, P.c('#6b4a2a'), 0.9, 4, 11.4, 4.6, 13.6); // tail
      rect(ctx, P.team(0.9), 2.6, 4.2, 2.8, 1); // collar
      poly(ctx, P.c('#7c5a34'), [2.8, 1.4, 5.2, 1.4, 5.4, 4.6, 2.6, 4.6]); // head
      circle(ctx, P.c(OUTLINE), 4, 1, 0.7); // nose
      poly(ctx, P.c('#4e341c'), [2.4, 2.8, 1.6, 3.8, 2.6, 4.2]); // ears
      poly(ctx, P.c('#4e341c'), [5.6, 2.8, 6.4, 3.8, 5.4, 4.2]);
    }],
  },
  // Medic: a white helmet with a red cross, a kit bag.
  MEDI: {
    body: [10, 12, (ctx, P) => {
      soldier(ctx, P, '#e8e6dc');
      cross(ctx, P, 5, 5.5, 2.2);
      rect(ctx, P.c('#e8e6dc'), 6.8, 7.3, 2.6, 2);
      cross(ctx, P, 8.1, 8.3, 1.6);
    }],
  },
  // Mechanic: a team coloured cap and a big wrench.
  MECH: {
    body: [10, 12, (ctx, P) => {
      soldier(ctx, P, '#8a8a7a');
      circle(ctx, P.team(0.9), 5, 5, 1.5); // cap
      line(ctx, P.c(C.steelLight), 1, 7.8, 7.5, 8.6, 2.2); // wrench
      ring(ctx, P.c(C.steelLight), 8.6, 1.8, 0.8, 0.6);
    }],
  },
  // Spy: a dark suit and hat, a small pistol.
  SPY: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      poly(ctx, P.c('#2e2e36'), [1.5, 5.5, 8.5, 5.5, 8, 9.5, 2, 9.5]); // suit
      rect(ctx, P.team(0.8), 4.4, 5.6, 1.2, 2.6); // tie
      rect(ctx, P.c(C.steelDark), 7, 2.6, 0.8, 2.8); // pistol
      circle(ctx, P.c('#1e1e24'), 5, 5.6, 2.5); // hat brim
      circle(ctx, P.c('#3a3a44'), 5, 5.4, 1.6);
    }],
  },
  // Thief: a black hood and a loot sack.
  THF: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
      circle(ctx, P.c('#a08454'), 3, 8.6, 2); // sack
      poly(ctx, P.team(0.45), [1.8, 5.5, 8.2, 5.5, 7.8, 9.5, 2.2, 9.5]);
      circle(ctx, P.c('#1a1a1a'), 5, 5.8, 2.2); // hood
      rect(ctx, P.c(C.skin), 4, 4.4, 2, 0.8); // eyes slit
    }],
  },
  // Shock Trooper: a heavy suit with a Tesla coil on the back.
  SHOK: {
    body: [10, 12, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 7, 3.8);
      rrect(ctx, P.c(C.steelDark), 2.8, 7.6, 4.4, 3.6, 1); // coil pack
      circle(ctx, P.c('#7fb8ff'), 5, 9.4, 1.2);
      poly(ctx, P.team(0.65), [1.2, 5.2, 8.8, 5.2, 8.4, 8.6, 1.6, 8.6]);
      rect(ctx, P.c(C.steel), 6.8, 0.6, 1.4, 5); // zapper
      circle(ctx, P.c('#cfe8ff'), 7.5, 0.8, 0.8);
      circle(ctx, P.c(C.steelDark), 5, 5.5, 2.3); // helmet
      rect(ctx, P.c('#7fb8ff'), 4, 4.2, 2, 0.7); // visor
    }],
  },
};

/** Prone poses (TakeCover): every soldier but the dog and the thief lies down. */
export const INFANTRY_PRONE = {
  E2: [8, 14, (ctx, P) => {
    lying(ctx, P, HELMET);
    circle(ctx, P.c('#3a4226'), 6.6, 3, 1); // grenade in hand
  }],
  E4: [8, 14, (ctx, P) => {
    rect(ctx, P.c('#7a2a18'), 2.4, 7.4, 1.6, 3.2);
    rect(ctx, P.c('#7a2a18'), 4.4, 7.4, 1.6, 3.2);
    lying(ctx, P, '#4a4a40');
    rect(ctx, P.c(C.steelDark), 5.4, 0.2, 1, 4.4);
  }],
  E6: [8, 14, (ctx, P) => lying(ctx, P, C.yellow)],
  E7: [8, 14, (ctx, P) => {
    lying(ctx, P, '#4a2a16');
    rect(ctx, P.c(C.steelDark), 1.6, 0.6, 0.9, 3.4);
    rect(ctx, P.c(C.steelDark), 5.6, 0.6, 0.9, 3.4);
  }],
  MEDI: [8, 14, (ctx, P) => {
    lying(ctx, P, '#e8e6dc');
    cross(ctx, P, 4, 4.1, 1.8);
  }],
  MECH: [8, 14, (ctx, P) => {
    lying(ctx, P, '#8a8a7a');
    circle(ctx, P.team(0.9), 4, 4, 1.3);
  }],
  SPY: [8, 14, (ctx, P) => {
    lying(ctx, P, '#1e1e24');
    rect(ctx, P.c(C.steelDark), 5.4, 1.2, 0.8, 2.6);
  }],
  SHOK: [8, 14, (ctx, P) => {
    rrect(ctx, P.c(C.steelDark), 2.2, 7, 3.6, 3.6, 1);
    lying(ctx, P, C.steelDark);
    rect(ctx, P.c(C.steel), 5.4, 0, 1.2, 4.4);
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

