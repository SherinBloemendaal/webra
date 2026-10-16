// Animated layers of buildings, drawn over the static art (art/buildings.js)
// like the looping overlays of the original sprites: steam over the cooling
// towers, the radar sweep, the crane trolley, a running landing light,
// pulsing reactor cores, the portal ring, crackling tesla arcs. In the 2D
// minimal look each frame is one or two flat shapes.
//
// Each entry is { box: [x, y, w, h], frames, fps, draw(ctx, P, f) }. `draw`
// paints frame f (0 <= f < frames) in the building's own coordinates (the
// footprint box of buildings.js, origin at its top left); the atlas keeps only
// `box` of it, so a layer costs a handful of small frames. The box may reach
// above the footprint (steam rises over the roof). Frame 0 is the still image
// used by icons, cameos, fogged buildings and prefers-reduced-motion.
//
// The GPU picks the frame from a render clock (js/anim.js, shaders/sprite.wgsl),
// so the simulation never sees any of this.

import { SHARED_PALETTE } from './shared-palette.js';
import { shape, siloHatch } from './buildings.js';

const TAU = Math.PI * 2;
const M = SHARED_PALETTE.materials;

/** A palette colour (#rrggbb) at opacity a. */
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

const r = (x, y, w, h) => ['r', x, y, w, h];
const c = (cx, cy, rad) => ['c', cx, cy, rad];

/** The helipad's landing light, clockwise round the pad's corners. */
const HPAD_LIGHTS = [[5, 5], [41, 5], [41, 36], [5, 36]];

/** Animated layers by sprite key (sprites.js resolves aliases such as fakes). */
export const BUILDING_ANIM = {
  // Radar dome: the green sweep goes round the dome.
  DOME: {
    box: [8, 6, 30, 30],
    frames: 8,
    fps: 6,
    draw: (ctx, P, f) => {
      const a = (f / 8) * TAU - 0.55;
      ctx.fillStyle = P.c(alpha(M.radar, 0.55));
      ctx.beginPath();
      ctx.moveTo(23, 21);
      ctx.arc(23, 21, 15, a, a + 0.8);
      ctx.closePath();
      ctx.fill();
    },
  },
  // Power plant: steam rises from both cooling towers.
  POWR: {
    box: [2, -4, 40, 22],
    frames: 4,
    fps: 4,
    draw: (ctx, P, f) => shape(ctx, P.c(alpha(M.steam, 0.7)), c(12.5 - f, 13 - f * 3, 4 + f), c(33.5 - f, 13 - f * 3, 4 + f)),
  },
  // Advanced power plant: the reactor cores glow brighter and dimmer.
  APWR: {
    box: [10, -4, 50, 16],
    frames: 4,
    fps: 5,
    draw: (ctx, P, f) => {
      const rad = [6, 6.5, 7, 6.5][f];
      shape(ctx, P.c([M.yellow, M.orange, M.glow, M.orange][f]), c(18, 4, rad), c(52, 4, rad));
    },
  },
  // Refinery: the furnace flickers.
  PROC: {
    box: [14, 40, 16, 10],
    frames: 6,
    fps: 6,
    draw: (ctx, P, f) => shape(ctx, P.c([M.molten, M.orange, M.molten, M.glow, M.molten, M.orange][f]), r(14, 40, 16, 10)),
  },
  // Soviet barracks: a puff of smoke from the chimney.
  BARR: {
    box: [4, -9, 17, 20],
    frames: 6,
    fps: 5,
    draw: (ctx, P, f) => shape(ctx, P.c(alpha(M.ash, 0.55)), c(10.5 + f * 0.6, 8 - f * 2.2, 2.5 + f * 0.5)),
  },
  // Helipad: the landing light runs round the pad.
  HPAD: {
    box: [1, 1, 44, 39],
    frames: 4,
    fps: 6,
    draw: (ctx, P, f) => shape(ctx, P.c(M.glow), c(...HPAD_LIGHTS[f], 2.5)),
  },
  // Airfield: two lights run down each runway edge.
  AFLD: {
    box: [8, 20, 46, 26],
    frames: 3,
    fps: 6,
    draw: (ctx, P, f) => shape(ctx, P.c(M.glow), ...[22, 44].flatMap((y) => [0, 1].map((k) => c(10 + f * 8 + k * 24, y, 1.5)))),
  },
  // Allied tech center: the dish's feed turns round.
  ATEK: {
    box: [4, 2, 14, 14],
    frames: 4,
    fps: 2,
    draw: (ctx, P, f) => {
      const a = (f / 4) * TAU - (3 * Math.PI) / 4;
      shape(ctx, P.c(M.darker), c(11 + Math.cos(a) * 4, 9 + Math.sin(a) * 4, 1.5));
    },
  },
  // Soviet tech center: the red antenna light blinks.
  STEK: {
    box: [56, 8, 8, 8],
    frames: 2,
    fps: 1.5,
    draw: (ctx, P, f) => shape(ctx, P.c(f === 0 ? M.red : M.darker), c(60, 12, 3)),
  },
  // Construction yard: the crane trolley runs along the jib with its load.
  FACT: {
    box: [12, 6, 55, 18],
    frames: 8,
    fps: 4,
    draw: (ctx, P, f) => {
      const x = 39 + Math.cos((f / 8) * TAU) * 22;
      shape(ctx, P.c(M.darker), r(x - 3, 7, 6, 7), r(x - 4, 16, 8, 6));
    },
  },
  // Gap generator: the emitter pulses.
  GAP: {
    box: [7, -20, 8, 8],
    frames: 4,
    fps: 6,
    draw: (ctx, P, f) => shape(ctx, P.c(M.ice2), c(11, -16, [2, 2.8, 3.6, 2.8][f])),
  },
  // Chronosphere: a light ring runs out through the portal well.
  PDOX: {
    box: [8, 7, 30, 30],
    frames: 4,
    fps: 6,
    draw: (ctx, P, f) => {
      ctx.strokeStyle = P.c(M.ice2);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(23, 22, [9, 10.5, 12, 13.5][f], 0, TAU);
      ctx.stroke();
    },
  },
  // Iron curtain: the force field over the projector pulses.
  IRON: {
    box: [10, 8, 28, 28],
    frames: 4,
    fps: 4,
    draw: (ctx, P, f) => {
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i * TAU) / 6;
        pts.push(24 + Math.cos(a) * 13, 22 + Math.sin(a) * 13);
      }
      shape(ctx, P.c(alpha(M.field, [0.25, 0.32, 0.4, 0.32][f])), ['p', pts]);
    },
  },
  // Tesla coil: an arc crackles round the head.
  TSLA: {
    box: [0, -20, 24, 24],
    frames: 4,
    fps: 8,
    draw: (ctx, P, f) => {
      const a0 = (f / 4) * TAU - Math.PI / 4;
      const pts = [];
      for (let i = 0; i <= 4; i++) {
        const a = a0 + (i % 2 ? 0.35 : 0);
        const d = 3 + i * 1.3;
        pts.push(11 + Math.cos(a) * d, -9 + Math.sin(a) * d);
      }
      ctx.strokeStyle = P.c(M.ice2);
      ctx.lineWidth = 1;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.stroke();
    },
  },
};

/** How far the silo hatch is open in each frame of its launch layer. */
const SILO_OPEN = [0, 0.25, 0.55, 0.85, 1, 0.85, 0.55, 0.25];

/**
 * Working layers: drawn over a structure like the animated layers, but the
 * engine says when they play (engine/src/overlays.rs: the structure's
 * working pose, fx.rs), the way the original art plays its working
 * sequence. Each entry is { box, frames, draw(ctx, P, f), active: { start,
 * length, fps } }: frame 0 is the layer at rest (the still frame), the
 * active frames play once from the moment the engine names. Keyed by
 * sprite key; a structure has either one of these or an animated layer.
 */
export const BUILDING_WORKING = {
  // Missile silo: the hatch opens for the atom bomb and shuts again (OpenRA
  // WithSupportPowerActivationAnimation, sequence active: seven frames at
  // 80 ms). Frame 0 draws nothing over the shut hatch of the structure.
  MSLO: {
    box: [6, 0, 36, 20],
    frames: SILO_OPEN.length,
    active: { start: 1, length: SILO_OPEN.length - 1, fps: 1000 / 80 },
    draw: (ctx, P, f) => {
      if (SILO_OPEN[f] > 0) siloHatch(ctx, P, SILO_OPEN[f]);
    },
  },
};
