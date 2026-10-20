// Procedural art for every structure (Allied and Soviet) in WebRA's "2D
// minimal" look, after the design board "Retexture 2D en 3D: minder detail"
// (buildings3d/Retexture): seen from straight above, every structure is three
// to six big flat shapes in the colours it shares with the 3D minimal pack
// (art/shared-palette.js), one hard shadow thrown to the bottom right (light
// from the top left) and one team strip. Each keeps the one or two things that
// make it recognisable: the crane on the yard, cooling towers on the power
// plant, the big door on the factory, the gold silo of the refinery.
//
// Size: each structure fills its cells the way the original sprite does
// (content/render-facts.js ORIGINAL_BOUNDS, tests/buildings-art.test.mjs; the
// service depot, naval yard and sub pen fill their whole 3x3 footprint): the
// raised parts and their shadow cover the original's box; the bib rows below
// it are a flat concrete apron (GROUND). A structure the original draws taller
// than its footprint (the gap generator's mast, the tesla coil) reaches up by
// BUILDING_RISE: those parts draw above the footprint (negative y) and
// js/sprites.js grows the sprite's box upwards.
//
// Team colour is one strip (or cap) per structure, drawn with P.team(level)
// (grey in the colour pass, white in the mask pass, see sprites.js); nothing
// translucent is drawn over it (the mask pass draws every translucent colour
// as opaque black, which would cut the team colour away). So the flat GROUND
// comes first, then the shadow on it, then the structure.
//
// Each draw function takes (ctx, P) and paints into its footprint box (cells
// times 24 world pixels, BUILDING_SIZE). Everything is deterministic and drawn
// once into the atlas; the moving parts (steam, the radar sweep, the crane
// trolley, lights) are the animated layers in art/animated.js.

import { SHARED_PALETTE } from './shared-palette.js';
import { pixelDraw } from './pixel.js';

const TAU = Math.PI * 2;

// ---- Palette (art/shared-palette.js) ------------------------------------------------------

const M = SHARED_PALETTE.materials;
/** The hard shadow: offset to the bottom right in world pixels, and its colour. */
export const SHADOW_OFFSET = SHARED_PALETTE.shadow.offset * 24;
export const SHADOW = `rgba(0,0,0,${SHARED_PALETTE.shadow.alpha})`;
/** The flat ground under and around structures (the bib rows, the yard's pad): not part of the raised body. */
export const GROUND = M.concrete;

/** Team strips: light, so the player's colour reads. */
const TEAM = 0.85;

/** Footprint of every building art key in cells (width, height), checked against the rules in tests. */
export const BUILDING_SIZE = {
  FACT: [3, 4], POWR: [2, 3], APWR: [3, 3], PROC: [3, 4], SILO: [1, 1], TENT: [2, 3], BARR: [2, 3], KENN: [1, 1],
  WEAP: [3, 3], FIX: [3, 3], DOME: [2, 3], HPAD: [2, 3], AFLD: [3, 2], SYRD: [3, 3], SPEN: [3, 3], ATEK: [2, 3],
  STEK: [3, 3], GAP: [1, 1], PDOX: [2, 2], IRON: [2, 2], MSLO: [2, 1], SBAG: [1, 1], FENC: [1, 1], BRIK: [1, 1],
  PBOX: [1, 1], HBOX: [1, 1], GUN: [1, 1], FTUR: [1, 1], TSLA: [1, 1], AGUN: [1, 1], SAM: [2, 1],
  LROD: [1, 1],
};

/**
 * World pixels a structure reaches above its footprint, as the original
 * sprite does (its decoration bounds, content/render-facts.js
 * ORIGINAL_BOUNDS): the advanced power plant's reactors, the gap
 * generator's mast, the tesla coil, the AA gun's emplacement and the iron
 * curtain. js/sprites.js grows the sprite's box by this much at the top.
 */
export const BUILDING_RISE = { APWR: 20, GAP: 24, TSLA: 16, AGUN: 8, IRON: 5 };

// ---- Shapes ----------------------------------------------------------------------------
//
// A shape is one fill of one colour, made of parts: ['r', x, y, w, h] a
// rectangle, ['c', cx, cy, r] a disc, ['p', [x0, y0, x1, y1, ...]] a polygon.

function trace(ctx, parts, d = 0) {
  ctx.beginPath();
  for (const [kind, ...v] of parts) {
    if (kind === 'r') {
      ctx.rect(v[0] + d, v[1] + d, v[2], v[3]);
    } else if (kind === 'c') {
      ctx.moveTo(v[0] + v[2] + d, v[1] + d);
      ctx.arc(v[0] + d, v[1] + d, v[2], 0, TAU);
      ctx.closePath();
    } else {
      const pts = v[0];
      ctx.moveTo(pts[0] + d, pts[1] + d);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] + d, pts[i + 1] + d);
      ctx.closePath();
    }
  }
}

/** One flat shape of colour `fill`. */
export function shape(ctx, fill, ...parts) {
  ctx.fillStyle = fill;
  trace(ctx, parts);
  ctx.fill();
}

/** The structure's one hard shadow: the raised parts, offset to the bottom right, in one fill. */
function shadow(ctx, P, ...parts) {
  ctx.fillStyle = P.c(SHADOW);
  trace(ctx, parts, SHADOW_OFFSET);
  ctx.fill();
}

/** Shorthands for the parts. */
const r = (x, y, w, h) => ['r', x, y, w, h];
const c = (cx, cy, rad) => ['c', cx, cy, rad];
const p = (...pts) => ['p', pts];

/** Corners of a regular n-gon. */
function gon(cx, cy, rad, n, rot = Math.PI / n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    pts.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  return pts;
}

/** A five pointed star centred on (cx, cy). */
function star(cx, cy, rad, inner = 0.42) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? rad * inner : rad;
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  return pts;
}

/** The camouflage of the camo pillbox per biome (the biome's trees, art/shared-palette.js terrain). */
export const camoOf = (P) => {
  const t = SHARED_PALETTE.terrain[P.biome] ?? SHARED_PALETTE.terrain.temperate;
  return [t.treeDark, t.tree];
};

// Edges of the raised body: the shadow takes the last SHADOW_OFFSET pixels of
// the original's box, so body plus shadow fill it exactly.
const S = SHADOW_OFFSET;
const E1 = 24 - S;
const E2 = 48 - S;
const E3 = 72 - S;

// ---- Buildings --------------------------------------------------------------------------

export const BUILDING_DRAW = {
  // Construction yard 3x4: the hall with its team strip, the building pad with
  // a half built block, and the tower crane's jib over both (its trolley runs:
  // art/animated.js).
  FACT: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(40, 0, 32, 72), r(0, 72, 72, 24));
    shadow(ctx, P, r(0, 0, 40, E3), r(46, 30, 18, 20), r(3, 8, E3 - 3, 5));
    shape(ctx, P.c(M.roof), r(0, 0, 40, E3));
    shape(ctx, P.team(TEAM), r(0, E3 - 8, 40, 8));
    shape(ctx, P.c(M.yellow), r(46, 30, 18, 20), r(3, 8, E3 - 3, 5));
  },

  // Power plant 2x3: the block with two cooling towers (their steam rises:
  // art/animated.js) and the lightning sign.
  POWR: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(0, 48, 48, 24));
    shadow(ctx, P, r(0, 0, E2, E2));
    shape(ctx, P.c(M.roof), r(0, 0, E2, E2));
    shape(ctx, P.team(TEAM), r(0, E2 - 6, E2, 6));
    shape(ctx, P.c(M.steel2), c(12.5, 16, 10), c(33.5, 16, 10));
    shape(ctx, P.c(M.dark), c(12.5, 16, 5.5), c(33.5, 16, 5.5));
    shape(ctx, P.c(M.yellow), p(26, 26, 19, 33, 23, 33, 20, 39, 28, 31, 24, 31, 27, 26));
  },

  // Advanced power plant 3x3: a tall block (it reaches above its footprint like
  // the original) under two big reactors with glowing cores (they pulse:
  // art/animated.js), its front wall below.
  APWR: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(0, 48, 72, 24));
    shadow(ctx, P, r(0, -20, E3, E2 + 20));
    shape(ctx, P.c(M.roof), r(0, -20, E3, E2 + 20));
    shape(ctx, P.c(M.wall), r(0, 26, E3, E2 - 26));
    shape(ctx, P.team(TEAM), r(0, E2 - 6, E3, 6));
    shape(ctx, P.c(M.steel2), c(18, 4, 14), c(52, 4, 14));
    shape(ctx, P.c(M.yellow), c(18, 4, 6), c(52, 4, 6));
  },

  // Ore refinery 3x4: the smelter hall with its furnace (it flickers:
  // art/animated.js) and the round silo full of gold.
  PROC: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(24, 48, 48, 24), r(0, 72, 72, 24));
    shadow(ctx, P, r(0, 0, 44, 67), c(56, 30, 14));
    shape(ctx, P.c(M.roof), r(0, 0, 44, 67));
    shape(ctx, P.team(TEAM), r(0, 61, 44, 6));
    shape(ctx, P.c(M.molten), r(14, 40, 16, 10));
    shape(ctx, P.c(M.steel2), c(56, 30, 14));
    shape(ctx, P.c(M.gold), c(56, 30, 7));
  },

  // Silo 1x1: a round tank of gold under a team cap.
  SILO: (ctx, P) => {
    shadow(ctx, P, c(11, 11, 11));
    shape(ctx, P.c(M.steel2), c(11, 11, 11));
    shape(ctx, P.c(M.gold), c(11, 11, 6.5));
    shape(ctx, P.team(TEAM), c(11, 11, 2.5));
  },

  // Allied barracks 2x3: a canvas tent, its shaded half, the team band across
  // both halves and the door.
  TENT: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(0, 48, 48, 24));
    shadow(ctx, P, r(0, 0, E2, E2));
    shape(ctx, P.c(M.canvas), r(0, 0, E2, E2));
    shape(ctx, P.c(M.olive), r(E2 / 2, 0, E2 / 2, E2));
    shape(ctx, P.team(TEAM), r(0, 16, E2, 6));
    shape(ctx, P.c(M.darker), p(17, E2, 23, 34, 29, E2));
  },

  // Soviet barracks 2x3: a tiled roof in two halves, the team strip along the
  // front and the chimney (its smoke: art/animated.js).
  BARR: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(0, 48, 48, 24));
    shadow(ctx, P, r(0, 0, E2, E2));
    shape(ctx, P.c(M.brick), r(0, 0, E2, E2));
    shape(ctx, P.c(M.tiles), r(E2 / 2, 0, E2 / 2, E2));
    shape(ctx, P.team(TEAM), r(0, E2 - 6, E2, 6));
    shape(ctx, P.c(M.dark), r(7, 6, 7, 7));
  },

  // Kennel 1x1: a wooden hut, its shaded half, a team ridge and the door.
  KENN: (ctx, P) => {
    shadow(ctx, P, r(0, 0, E1, E1));
    shape(ctx, P.c(M.wood), r(0, 0, E1, E1));
    shape(ctx, P.c(M.rust), r(E1 / 2, 0, E1 / 2, E1));
    shape(ctx, P.team(TEAM), r(E1 / 2 - 1.5, 0, 3, 14));
    shape(ctx, P.c(M.darker), r(8, 16, 6, E1 - 16));
  },

  // War factory 3x3: the hangar with its ridge, the team strip and the big
  // door onto the apron (left clear: the units it builds roll out there).
  WEAP: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(0, 48, 72, 24));
    shadow(ctx, P, r(0, 0, E3, E2));
    shape(ctx, P.c(M.roof), r(0, 0, E3, E2));
    shape(ctx, P.c(M.seam), r(0, 19, E3, 3));
    shape(ctx, P.team(TEAM), r(0, 33, E3, 5));
    shape(ctx, P.c(M.darker), r(16, 30, 38, E2 - 30));
  },

  // Service depot 3x3: the hexagonal repair pad in a yellow rim with the big
  // wrench, a team strip along its top.
  FIX: (ctx, P) => {
    const rim = [20, 0, 52, 0, E3, 36, 52, E3, 20, E3, 0, 36];
    shadow(ctx, P, ['p', rim]);
    shape(ctx, P.c(M.yellow), ['p', rim]);
    shape(ctx, P.c(M.darker), p(23, 6, 49, 6, 64, 36, 49, 64, 23, 64, 8, 36));
    const wrench = [-0.2, -0.1, -0.2, -0.28, -0.08, -0.38, -0.08, -0.22, 0.08, -0.22, 0.08, -0.38, 0.2, -0.28, 0.2, -0.1, 0.07, 0.02, 0.07, 0.42, 0, 0.48, -0.07, 0.42, -0.07, 0.02];
    const k = Math.SQRT1_2 * 40;
    const pts = [];
    for (let i = 0; i < wrench.length; i += 2) pts.push(35 + (wrench[i] - wrench[i + 1]) * k, 36 + (wrench[i] + wrench[i + 1]) * k);
    shape(ctx, P.c(M.paint), ['p', pts]);
    shape(ctx, P.team(TEAM), r(22, 0, 28, 4));
  },

  // Radar dome 2x3: the big dome on its block with the antenna mount (the
  // radar sweep turns over the dome: art/animated.js).
  DOME: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(0, 48, 48, 24));
    shadow(ctx, P, r(0, 0, E2, E2));
    shape(ctx, P.c(M.roof), r(0, 0, E2, E2));
    shape(ctx, P.team(TEAM), r(0, E2 - 6, E2, 6));
    shape(ctx, P.c(M.dome), c(23, 21, 17));
    shape(ctx, P.c(M.dark), c(23, 21, 3));
  },

  // Helipad 2x3: a raised pad with the H and a team strip (a landing light
  // runs round it: art/animated.js).
  HPAD: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(0, 48, 48, 24));
    shadow(ctx, P, r(0, 0, E2, E2));
    shape(ctx, P.c(M.asphalt), r(0, 0, E2, E2));
    shape(ctx, P.c(M.paint), r(15, 9, 4, 24), r(29, 9, 4, 24), r(19, 19, 10, 4));
    shape(ctx, P.team(TEAM), r(0, E2 - 5, E2, 5));
  },

  // Airfield 3x2: the runway with its centre line, the hangar with the team
  // strip and the glass control tower (the edge lights run: art/animated.js).
  AFLD: (ctx, P) => {
    shadow(ctx, P, r(0, 0, 28, 14), r(56, 0, 14, 14));
    shape(ctx, P.c(M.asphalt), r(0, 0, 72, 48));
    shape(ctx, P.c(M.paint), ...[0, 1, 2, 3, 4].map((k) => r(8 + k * 12, 32, 7, 2)));
    shape(ctx, P.c(M.roof), r(0, 0, 28, 14));
    shape(ctx, P.team(TEAM), r(0, 10, 28, 4));
    shape(ctx, P.c(M.glass), r(56, 0, 14, 14));
  },

  // Allied tech center 2x3: the lab under its glass roof and the satellite
  // dish (its feed turns: art/animated.js).
  ATEK: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(0, 48, 48, 24));
    shadow(ctx, P, r(0, 0, E2, E2));
    shape(ctx, P.c(M.roof), r(0, 0, E2, E2));
    shape(ctx, P.c(M.glass), r(6, 19, 34, 16));
    shape(ctx, P.team(TEAM), r(0, E2 - 6, E2, 6));
    shape(ctx, P.c(M.steel2), c(11, 9, 7));
  },

  // Soviet tech center 3x3: a brick block with a tiled roof panel and the
  // star, the antenna block (its red light blinks: art/animated.js).
  STEK: (ctx, P) => {
    shape(ctx, P.c(GROUND), r(0, 48, 72, 24));
    shadow(ctx, P, r(0, 0, E3, E2));
    shape(ctx, P.c(M.brick), r(0, 0, E3, E2));
    shape(ctx, P.c(M.tiles), r(6, 6, 40, 28));
    shape(ctx, P.team(TEAM), r(0, E2 - 6, E3, 6));
    shape(ctx, P.c(M.paint), ['p', star(26, 20, 10)]);
    shape(ctx, P.c(M.steel2), r(54, 6, 12, 12));
  },

  // Naval yard 3x3: quays round open water (the water stays the map's), a team
  // strip along the back quay and the yard crane over the water.
  SYRD: (ctx, P) => {
    const quay = [0, 0, E3, 0, E3, E3, 56, E3, 56, 18, 14, 18, 14, E3, 0, E3];
    shadow(ctx, P, ['p', quay]);
    shape(ctx, P.c(M.wall), ['p', quay]);
    shape(ctx, P.team(TEAM), r(14, 14, 42, 4));
    shape(ctx, P.c(M.yellow), r(40, 4, 4, 38));
    shape(ctx, P.c(M.darker), r(37, 4, 10, 7));
  },

  // Sub pen 3x3: a concrete pen with a team strip over its roof and the dark
  // arch where the submarines leave.
  SPEN: (ctx, P) => {
    shadow(ctx, P, r(0, 0, E3, E3));
    shape(ctx, P.c(M.wall), r(0, 0, E3, E3));
    shape(ctx, P.c(M.roof), r(6, 6, 58, 30));
    shape(ctx, P.team(TEAM), r(6, 21, 58, 5));
    shape(ctx, P.c(M.darker), p(22, E3, 22, 50, 29, 42, 43, 42, 50, 50, 50, E3));
  },

  // Gap generator 1x1: the tall emitter mast (above its footprint like the
  // original) on a base with a team strip (the emitter pulses: art/animated.js).
  GAP: (ctx, P) => {
    shadow(ctx, P, r(5, -24, 12, 40), r(0, 12, E1, E1 - 12));
    shape(ctx, P.c(M.wall), r(0, 12, E1, E1 - 12));
    shape(ctx, P.team(TEAM), r(0, E1 - 4, E1, 4));
    shape(ctx, P.c(M.dark), r(5, -24, 12, 40));
    shape(ctx, P.c(M.ice), c(11, -16, 5));
  },

  // Chronosphere 2x2: the portal well with its light core (a ring runs
  // through it: art/animated.js).
  PDOX: (ctx, P) => {
    shadow(ctx, P, r(0, 0, E2, E2));
    shape(ctx, P.c(M.roof), r(0, 0, E2, E2));
    shape(ctx, P.team(TEAM), r(0, E2 - 6, E2, 6));
    shape(ctx, P.c(M.darker), c(23, 22, 17));
    shape(ctx, P.c(M.ice), c(23, 22, 7));
  },

  // Iron curtain 2x2: the fan of curtain panels behind the projector and its
  // red lens (the force field pulses: art/animated.js).
  IRON: (ctx, P) => {
    // The original's box is 45 px tall from 5 px above the footprint.
    const bottom = 45 - S;
    shadow(ctx, P, r(0, -5, E2, bottom + 5));
    shape(ctx, P.c(M.roof), r(0, -5, E2, bottom + 5));
    shape(ctx, P.c(M.steel2), r(7, -1, 8, 12), r(20, -3, 8, 12), r(33, -1, 8, 12));
    shape(ctx, P.team(TEAM), r(0, bottom - 6, E2, 6));
    shape(ctx, P.c(M.darker), c(24, 22, 8));
    shape(ctx, P.c(M.red), c(24, 22, 3));
  },

  // Missile silo 2x1: the hatch in its yellow frame (its leaves slide open at
  // a launch: art/animated.js), a team strip along the front.
  MSLO: (ctx, P) => {
    shadow(ctx, P, r(0, 0, E2, E1));
    shape(ctx, P.c(M.roof), r(0, 0, E2, E1));
    shape(ctx, P.team(TEAM), r(0, E1 - 4, E2, 4));
    shape(ctx, P.c(M.yellow), r(12, 3, 24, 16));
    siloHatch(ctx, P, 0);
  },

  // Sandbags 1x1: a block of bags filling the cell, so runs join; its shadow
  // falls below it.
  SBAG: (ctx, P) => {
    shadow(ctx, P, r(-S, 0, 24, E1));
    shape(ctx, P.c(M.sand), r(0, 0, 24, E1));
    shape(ctx, P.c(M.sandy), r(0, 0, 24, 7));
    shape(ctx, P.c(M.dirt), r(0, 13, 24, 2));
  },

  // Wire fence 1x1: mesh and rails across the cell both ways and the post
  // where they meet (joins neighbours on all four sides).
  FENC: (ctx, P) => {
    shadow(ctx, P, r(9, 9, 6, 6));
    shape(ctx, P.c(M.steel), r(0, 9, 24, 6), r(9, 0, 6, 24));
    shape(ctx, P.c(M.steel2), r(0, 11, 24, 2), r(11, 0, 2, 24));
    shape(ctx, P.c(M.darker), r(9, 9, 6, 6));
  },

  // Concrete wall 1x1: a block filling the cell with a lit cap and a joint.
  BRIK: (ctx, P) => {
    shadow(ctx, P, r(-S, 0, 24, E1));
    shape(ctx, P.c(M.wall), r(0, 0, 24, E1));
    shape(ctx, P.c(M.roof), r(0, 0, 24, 5));
    shape(ctx, P.c(M.seam), r(11, 5, 2, E1 - 5));
  },

  // Pillbox 1x1: an octagonal bunker, its firing slits and a team cap.
  PBOX: (ctx, P) => {
    const oct = gon(11, 11, 11 / Math.cos(Math.PI / 8), 8);
    shadow(ctx, P, ['p', oct]);
    shape(ctx, P.c(M.wall), ['p', oct]);
    shape(ctx, P.c(M.darker), r(9, 2, 4, 2), r(2, 9.5, 2, 3), r(18, 9.5, 2, 3));
    shape(ctx, P.team(TEAM), c(11, 11, 2.5));
  },

  // Camo pillbox 1x1: the bunker under camouflage in the biome's colours.
  HBOX: (ctx, P) => {
    const [base, blot] = camoOf(P);
    const oct = gon(11, 11, 11 / Math.cos(Math.PI / 8), 8);
    shadow(ctx, P, ['p', oct]);
    shape(ctx, P.c(base), ['p', oct]);
    shape(ctx, P.c(blot), c(6.5, 14, 3.5), c(16, 7, 3));
    shape(ctx, P.c(M.darker), r(9, 2, 4, 2));
    shape(ctx, P.team(TEAM), c(11, 11, 2));
  },

  // Turret 1x1: a concrete base with the gun's well (the gun is the turret sprite).
  GUN: (ctx, P) => {
    shadow(ctx, P, r(0, 0, E1, E1));
    shape(ctx, P.c(M.wall), r(0, 0, E1, E1));
    shape(ctx, P.team(TEAM), r(0, E1 - 4, E1, 4));
    shape(ctx, P.c(M.dark), c(11, 11, 7.5));
  },

  // Flame tower 1x1: a brick fuel tank with its nozzle and pilot flame.
  FTUR: (ctx, P) => {
    shadow(ctx, P, r(0, 0, E1, E1));
    shape(ctx, P.c(M.wall), r(0, 0, E1, E1));
    shape(ctx, P.team(TEAM), r(0, E1 - 4, E1, 4));
    shape(ctx, P.c(M.brick), c(11, 10, 8));
    shape(ctx, P.c(M.darker), r(9.5, 14, 3, 6));
    shape(ctx, P.c(M.glow), c(11, 10, 2.5));
  },

  // Tesla coil 1x1: the tall column (above its footprint like the original)
  // with the copper coil and its core (the arcs crackle: art/animated.js).
  TSLA: (ctx, P) => {
    shadow(ctx, P, r(6, -10, 10, 24), c(11, -9, 7), r(0, 12, E1, E1 - 12));
    shape(ctx, P.c(M.wall), r(0, 12, E1, E1 - 12));
    shape(ctx, P.team(TEAM), r(0, E1 - 4, E1, 4));
    shape(ctx, P.c(M.dark), r(6, -10, 10, 24));
    shape(ctx, P.c(M.copper), c(11, -9, 7));
    shape(ctx, P.c(M.glow), c(11, -9, 3));
  },

  // AA gun 1x1: a tall sandbag emplacement round the gun pit (the gun is the
  // turret sprite).
  AGUN: (ctx, P) => {
    shadow(ctx, P, r(0, -8, E1, E1 + 8));
    shape(ctx, P.c(M.sand), r(0, -8, E1, E1 + 8));
    shape(ctx, P.team(TEAM), r(0, E1 - 4, E1, 4));
    shape(ctx, P.c(M.dirt), c(11, 10, 7.5));
  },

  // SAM site 2x1: a sandbagged pit with the launcher well (the launcher is
  // the turret sprite).
  SAM: (ctx, P) => {
    shadow(ctx, P, r(0, 0, E2, E1));
    shape(ctx, P.c(M.sand), r(0, 0, E2, E1));
    shape(ctx, P.c(M.dirt), r(4, 3, 38, 14));
    shape(ctx, P.team(TEAM), r(0, E1 - 4, E2, 4));
    shape(ctx, P.c(M.darker), c(23, 10, 6));
  },

  // WebRA's own Lightning Rod: WebRA's pixel art (art/pixel.js), the same in
  // both 2D packs. Its mast stands above the footprint, so it paints into
  // the taller box pixelBox gives (js/sprites.js actorSprites).
  LROD: pixelDraw({ id: 'LROD', width: BUILDING_SIZE.LROD[0], height: BUILDING_SIZE.LROD[1] }),
};

/** The dark of the silo shaft. */
export const SHAFT = M.black;

/**
 * The missile silo's hatch (MSLO), `open` from 0 (shut: two steel leaves
 * meeting over the shaft) to 1 (the leaves slid aside, the missile's nose in
 * the shaft). The structure draws it shut; WebRA's launch layer
 * (art/animated.js BUILDING_WORKING) draws it opening and closing over the
 * structure when the atom bomb leaves.
 */
export function siloHatch(ctx, P, open) {
  if (open > 0) {
    shape(ctx, P.c(SHAFT), r(14, 5, 20, 12));
    shape(ctx, P.c(M.paint), c(24, 11, 4));
  }
  // Each leaf keeps its outer part as it slides away.
  const width = 9.8 * (1 - open);
  if (width >= 0.2) shape(ctx, P.c(M.steel2), r(14, 5, width, 12), r(34 - width, 5, width, 12));
}

/** Building turrets, centred on the building centre and facing north. */
export const BUILDING_TURRET = {
  // Turret: a steel drum with the long barrel and a team hatch.
  GUN: [24, 24, (ctx, P) => {
    shape(ctx, P.c(M.steel2), c(12, 12, 6));
    shape(ctx, P.c(M.darker), r(10.75, 0.5, 2.5, 10));
    shape(ctx, P.team(TEAM), c(12, 13, 2.5));
  }],
  // AA gun: twin barrels on a steel mount.
  AGUN: [24, 24, (ctx, P) => {
    shape(ctx, P.c(M.darker), r(9.5, 3, 2, 8), r(12.5, 3, 2, 8));
    shape(ctx, P.c(M.steel2), c(12, 12, 4.5));
    shape(ctx, P.team(TEAM), c(12, 12, 1.8));
  }],
  // SAM: three missiles on a team launcher block.
  SAM: [24, 24, (ctx, P) => {
    shape(ctx, P.c(M.darker), r(6, 10, 12, 7));
    shape(ctx, P.team(TEAM), r(8, 12, 8, 3));
    shape(ctx, P.c(M.paint), r(7, 2, 2.5, 11), r(10.75, 2, 2.5, 11), r(14.5, 2, 2.5, 11));
  }],
};
