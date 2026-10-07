// Art for unit abilities and support powers: the Minelayer's mines (actor
// bodies) and the ability specials (marker, thump ring, chronoshift flash, iron
// curtain glow, gap shroud edge, nuke beacon, GPS dot, cloak shimmer).
// Helpers and palette come from ./kit.js.

import { C, rect, circle, poly, line, ring } from './kit.js';

/** Mines laid by the Minelayer (drawn by the engine only for players who can see them). */
export const ABILITY_DRAW = {
  // Anti-tank mine: a flat olive disc with a pressure plate.
  MINV: {
    body: [10, 10, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 5.6, 5.6, 4.4);
      circle(ctx, P.c('#3a3a2a'), 5, 5, 4.4);
      circle(ctx, P.team(0.45), 5, 5, 3.4);
      circle(ctx, P.c('#77775a'), 4.2, 4.2, 1.3);
      circle(ctx, P.c('#2a2a20'), 5, 5, 1.1);
    }],
  },
  // Anti-personnel mine: small, with a red trigger.
  MINP: {
    body: [7, 7, (ctx, P) => {
      circle(ctx, P.c(C.shadow), 3.9, 3.9, 3);
      circle(ctx, P.c('#3a3a2a'), 3.5, 3.5, 3);
      circle(ctx, P.team(0.45), 3.5, 3.5, 2.1);
      circle(ctx, P.c('#c03020'), 3.5, 3.5, 0.8);
    }],
  },
};

/**
 * Extra special sprites ([w, h, draw]), at most 8; see SPECIAL_SLOTS in sprites.js.
 * Order matters: engine/src/abilities.rs uses `abilities_base + index`.
 */
export const ABILITY_SPECIALS = [
  // 0: detected enemy mine marker (warning triangle)
  [8, 7, (ctx, P) => {
    poly(ctx, P.c('#101010'), [4, 0, 8, 7, 0, 7]);
    poly(ctx, P.c(C.yellow), [4, 1.4, 6.9, 6.3, 1.1, 6.3]);
    rect(ctx, P.c('#101010'), 3.6, 2.8, 0.8, 2);
    rect(ctx, P.c('#101010'), 3.6, 5.2, 0.8, 0.7);
  }],
  // 1: MAD tank seismic thump ring
  [48, 48, (ctx, P) => {
    ring(ctx, P.c('rgba(255,220,120,0.35)'), 24, 24, 22, 3);
    ring(ctx, P.c('rgba(255,245,200,0.7)'), 24, 24, 20, 1.2);
    ring(ctx, P.c('rgba(200,150,60,0.4)'), 24, 24, 15, 1);
  }],
  // 2: chronoshift flash
  [32, 32, (ctx, P) => {
    circle(ctx, P.c('rgba(120,230,255,0.25)'), 16, 16, 15);
    ring(ctx, P.c('rgba(180,245,255,0.8)'), 16, 16, 11, 1.6);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      line(ctx, P.c('rgba(230,252,255,0.85)'), 0.8, 16 + Math.cos(a) * 4, 16 + Math.sin(a) * 4, 16 + Math.cos(a) * 15, 16 + Math.sin(a) * 15);
    }
    circle(ctx, P.c('#f2feff'), 16, 16, 3);
  }],
  // 3: iron curtain glow (drawn over an invulnerable actor)
  [28, 28, (ctx, P) => {
    circle(ctx, P.c('rgba(200,20,20,0.22)'), 14, 14, 13.5);
    circle(ctx, P.c('rgba(240,40,30,0.25)'), 14, 14, 10);
    ring(ctx, P.c('rgba(255,90,70,0.6)'), 14, 14, 12.5, 1.2);
  }],
  // 4: gap generator shroud edge (dots along its range)
  [4, 4, (ctx, P) => {
    circle(ctx, P.c('#101010'), 2, 2, 2);
    circle(ctx, P.team(0.9), 2, 2, 1.3);
  }],
  // 5: atom bomb target beacon
  [20, 20, (ctx, P) => {
    ring(ctx, P.c('rgba(0,0,0,0.6)'), 10, 10, 8.5, 2.6);
    ring(ctx, P.c('#ff4a3a'), 10, 10, 8.5, 1.4);
    line(ctx, P.c('#ff4a3a'), 1.2, 10, 0.5, 10, 6);
    line(ctx, P.c('#ff4a3a'), 1.2, 10, 14, 10, 19.5);
    line(ctx, P.c('#ff4a3a'), 1.2, 0.5, 10, 6, 10);
    line(ctx, P.c('#ff4a3a'), 1.2, 14, 10, 19.5, 10);
    circle(ctx, P.c('#ffe08a'), 10, 10, 1.6);
  }],
  // 6: GPS dot (enemy unit under fog, team coloured)
  [5, 5, (ctx, P) => {
    circle(ctx, P.c('#101010'), 2.5, 2.5, 2.5);
    circle(ctx, P.team(1.0), 2.5, 2.5, 1.7);
  }],
  // 7: cloak shimmer (own cloaked units)
  [24, 24, (ctx, P) => {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      line(ctx, P.c('rgba(170,230,255,0.55)'), 1, 12 + Math.cos(a) * 6, 12 + Math.sin(a) * 6, 12 + Math.cos(a + 0.6) * 10, 12 + Math.sin(a + 0.6) * 10);
    }
  }],
];
