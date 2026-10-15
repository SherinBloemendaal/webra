// Animated layers of buildings, drawn over the static art (art/buildings.js)
// like the looping overlays of the 1996 Red Alert sprites: steam over the
// cooling towers, the radar sweep, the crane trolley, chasing runway and pad
// lights, glowing reactor rings, turning portal rings, crackling tesla arcs.
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

import { C, circle, poly, polyline, rect, ring } from './kit.js';
import { siloHatch, dashRing, turned, HPAD_LIGHTS, AFLD_LIGHTS, AFLD_LIGHT_ROWS } from './buildings.js';

const TAU = Math.PI * 2;
const GLOW = '#ffd98a';

/** How far a puff has faded in at s (0 at its source) so new puffs do not pop up. */
const fadeIn = (s) => Math.min(1, s / 0.2);

/** One flat puff of steam (white) or smoke (grey) of radius r and opacity a. */
function puff(ctx, P, x, y, r, a, rgb = '242,246,248') {
  if (a <= 0.01) return;
  circle(ctx, P.c(`rgba(${rgb},${a.toFixed(3)})`), x, y, r);
}

/**
 * Puffs rising from (x, y): `n` of them evenly spaced along the plume, moved
 * on by `t` (0..1) of one spacing, growing and fading as they rise `rise`
 * pixels and drift `drift` sideways.
 */
function plume(ctx, P, x, y, t, o) {
  const n = o.n ?? 2;
  for (let k = n - 1; k >= 0; k--) {
    const s = (k + t) / n;
    puff(ctx, P, x + s * o.drift, y - s * o.rise, o.r0 + s * o.grow, o.a * (1 - s) * fadeIn(s), o.rgb);
  }
}

/** A small lamp: lit (halo and bright dot) or dark. */
function lamp(ctx, P, x, y, r, on, lit = GLOW, halo = 'rgba(255,217,138,0.45)', dark = '#6b5a3a') {
  if (on) {
    circle(ctx, P.c(halo), x, y, r * 1.9);
    circle(ctx, P.c(lit), x, y, r);
  } else {
    circle(ctx, P.c(dark), x, y, r);
  }
}

/** A team coloured beacon, lit or dark. */
function beacon(ctx, P, x, y, r, on) {
  if (on) {
    circle(ctx, P.team(0.6), x, y, r + 1.4);
    circle(ctx, P.team(0.9), x, y, r);
    circle(ctx, P.team(1), x - r * 0.3, y - r * 0.3, r * 0.35);
  } else {
    circle(ctx, P.c(C.steelDark), x, y, r + 0.5);
    circle(ctx, P.team(0.3), x, y, r);
  }
}

/** The tesla coil's three arcs as drawn on the board (frame 0). */
const TESLA_ARCS = [
  [12, 12, 9, 10, 7.5, 11.5, 4.5, 8.5, 3, 9.5, 1, 6.5],
  [12, 12, 15, 9.5, 16, 11, 19, 7.5, 20.5, 8.5, 23, 5],
  [12, 12, 13.5, 15.5, 12, 17, 14, 20, 12.5, 21.5, 14, 23.5],
];

/** The iron curtain's hexagonal force field. */
const FIELD = [24, 5, 42.5, 15, 42.5, 36, 24, 46, 5.5, 36, 5.5, 15];

/** Animated layers by sprite key (sprites.js resolves aliases such as fakes). */
export const BUILDING_ANIM = {
  // Radar dome: the green sweep goes round the dome, the antenna turns.
  DOME: {
    box: [6, -2, 42, 49],
    frames: 8,
    fps: 6,
    draw: (ctx, P, f) => {
      const a = (f / 8) * TAU - 0.55;
      ctx.fillStyle = P.c('rgba(79,208,103,0.55)');
      ctx.beginPath();
      ctx.moveTo(22, 31);
      ctx.arc(22, 31, 15, a, a + 0.8);
      ctx.closePath();
      ctx.fill();
      const th = (f / 8) * TAU - 0.44;
      poly(ctx, P.c('#98a0a8'), turned(39.5, 7.5, 17, 4.5, th));
      const c = Math.cos(th);
      const s = Math.sin(th);
      for (const u of [-6.5, -3.5, -0.5, 2.5, 5.5]) {
        polyline(ctx, P.c('#3f4247'), 0.5, [39.5 + u * c + 2.1 * s, 7.5 + u * s - 2.1 * c, 39.5 + u * c - 2.1 * s, 7.5 + u * s + 2.1 * c]);
      }
      circle(ctx, P.team(0.9), 39.5, 7.5, 1);
    },
  },
  // Power plant: steam billows from both cooling towers.
  POWR: {
    box: [1, -8, 44, 32],
    frames: 6,
    fps: 6,
    draw: (ctx, P, f) => {
      for (const x of [13, 31]) {
        plume(ctx, P, x + 2.5, 11.5, f / 6, { r0: 3.5, grow: 3, rise: 12, drift: -5, a: 0.6 });
        puff(ctx, P, x - 1.5, 15, 6, 0.75);
      }
    },
  },
  // Advanced power plant: the reactor rings glow brighter and dimmer, the stack steams.
  APWR: {
    box: [4, -8, 67, 46],
    frames: 4,
    fps: 5,
    draw: (ctx, P, f) => {
      const core = ['#ffd98a', '#ffe6ae', '#fff3d6', '#ffe6ae'][f];
      const halo = [0.2, 0.32, 0.45, 0.32][f];
      for (const x of [20, 52]) {
        ring(ctx, P.c(`rgba(255,217,138,${halo})`), x, 22, 14.5, 3.5);
        ring(ctx, P.c(core), x, 22, 14.5, 1.5);
      }
      plume(ctx, P, 64, 6.5, f / 4, { r0: 3.5, grow: 2, rise: 8, drift: -3, a: 0.7 });
    },
  },
  // Refinery: the furnace flickers and smokes.
  PROC: {
    box: [28, 14, 20, 34],
    frames: 6,
    fps: 6,
    draw: (ctx, P, f) => {
      rect(ctx, P.c(['#ff9a2a', '#ffb24a', '#ff8a1a', '#ffc060', '#ff9a2a', '#ffb24a'][f]), 32.5, 39.5, 5, 5);
      rect(ctx, P.c(GLOW), 34, 41, 2, 2);
      plume(ctx, P, 38, 35, f / 6, { n: 3, r0: 4.5, grow: 2, rise: 12, drift: 3, a: 0.55, rgb: '106,110,116' });
    },
  },
  // Soviet barracks: a thin wisp from the chimney.
  BARR: {
    box: [6, -4, 18, 20],
    frames: 6,
    fps: 5,
    draw: (ctx, P, f) => plume(ctx, P, 14, 14, f / 6, { n: 3, r0: 1.5, grow: 2.5, rise: 12, drift: 4, a: 0.5, rgb: '214,214,208' }),
  },
  // Helipad: the landing lights chase round the pad, the hut beacon blinks.
  HPAD: {
    box: [0, 5, 48, 67],
    frames: 8,
    fps: 8,
    draw: (ctx, P, f) => {
      const [tx, ty] = HPAD_LIGHTS[(f + 7) % 8];
      circle(ctx, P.c('#d9b870'), tx, ty, 1.25);
      const [x, y] = HPAD_LIGHTS[f];
      lamp(ctx, P, x, y, 1.3, true, GLOW, 'rgba(255,217,138,0.4)');
      lamp(ctx, P, 13.5, 8, 1.5, f % 4 < 2, '#e84a3a', 'rgba(232,74,58,0.35)', '#5a1d16');
    },
  },
  // Airfield: the edge lights chase down the runway, the tower beacon blinks.
  AFLD: {
    box: [0, 4, 72, 44],
    frames: 6,
    fps: 6,
    draw: (ctx, P, f) => {
      for (const y of AFLD_LIGHT_ROWS) {
        circle(ctx, P.c(GLOW), AFLD_LIGHTS[(f + 5) % 6], y, 0.75);
        lamp(ctx, P, AFLD_LIGHTS[f], y, 0.95, true, '#fff3b8', 'rgba(255,217,138,0.45)');
      }
      if (f < 3) lamp(ctx, P, 61.5, 8.5, 1.5, true);
    },
  },
  // Allied tech center: the dish's feed turns round, the mast lamp blinks.
  ATEK: {
    box: [5, 3, 28, 17],
    frames: 8,
    fps: 4,
    draw: (ctx, P, f) => {
      const a = (f / 8) * TAU - (3 * Math.PI) / 4;
      const fx = 24 + Math.cos(a) * 5.6;
      const fy = 11.5 + Math.sin(a) * 5.6;
      polyline(ctx, P.c('#3f4247'), 0.75, [24, 11.5, fx, fy]);
      circle(ctx, P.c('#3f4247'), fx, fy, 1.25);
      beacon(ctx, P, 9, 7, 1.5, f % 4 < 2);
    },
  },
  // Soviet tech center: the red antenna light blinks.
  STEK: {
    box: [49, 16, 8, 8],
    frames: 2,
    fps: 1.5,
    draw: (ctx, P, f) => {
      lamp(ctx, P, 53, 20, 2, f === 0, '#e84a3a', 'rgba(232,74,58,0.4)', '#5a1d16');
      if (f === 0) circle(ctx, P.c('#ff9a80'), 52.4, 19.4, 0.6);
    },
  },
  // Construction yard: the crane trolley runs along the jib with its load,
  // the lamp on the cabin blinks.
  FACT: {
    box: [8, 10, 57, 19],
    frames: 8,
    fps: 4,
    draw: (ctx, P, f) => {
      const x = 45 + Math.cos((f / 8) * TAU) * 11;
      rect(ctx, P.c('rgba(0,0,0,0.3)'), x - 2, 23.5, 7, 4.5);
      rect(ctx, P.c('#3f4247'), x - 2, 14.25, 4, 3.5);
      polyline(ctx, P.c('#2b2b28'), 0.75, [x, 17.5, x, 22]);
      rect(ctx, P.c('#5e4624'), x - 3.5, 22, 7, 4.5);
      rect(ctx, P.c('#8a6a3a'), x - 3, 22.5, 6, 3.5);
      polyline(ctx, P.c('#5e4624'), 0.5, [x - 3, 22.5, x + 3, 26]);
      lamp(ctx, P, 12.5, 14.5, 0.9, f % 4 < 2);
    },
  },
  // Gap generator: the jamming rings turn against each other, the core pulses.
  GAP: {
    box: [0, 0, 24, 24],
    frames: 4,
    fps: 6,
    draw: (ctx, P, f) => {
      dashRing(ctx, P.c('rgba(127,224,255,0.8)'), 0.6, 12, 12, 10, 12, 0.5, (f / 4) * (TAU / 12));
      dashRing(ctx, P.c('rgba(127,224,255,0.8)'), 0.6, 12, 12, 7.5, 10, 0.5, -(f / 4) * (TAU / 10));
      circle(ctx, P.c('#7fe0ff'), 12, 12, [2, 2.4, 2.8, 2.4][f]);
    },
  },
  // Chronosphere: the two portal rings turn against each other.
  PDOX: {
    box: [11, 11, 26, 26],
    frames: 4,
    fps: 6,
    draw: (ctx, P, f) => {
      dashRing(ctx, P.c('#7fe0ff'), 1.25, 24, 24, 12, 10, 0.67, (f / 4) * (TAU / 10));
      dashRing(ctx, P.c('#7fe0ff'), 1.25, 24, 24, 8.5, 10, 0.64, -(f / 4) * (TAU / 10));
    },
  },
  // Iron curtain: the force field pulses.
  IRON: {
    box: [4, 3, 40, 45],
    frames: 4,
    fps: 4,
    draw: (ctx, P, f) => {
      poly(ctx, P.c(`rgba(255,90,58,${[0.18, 0.24, 0.3, 0.24][f]})`), FIELD);
      for (const [a, b] of [[0, 3], [1, 4], [2, 5]]) {
        polyline(ctx, P.c('rgba(255,90,58,0.4)'), 0.4, [FIELD[a * 2], FIELD[a * 2 + 1], FIELD[b * 2], FIELD[b * 2 + 1]]);
      }
      polyline(ctx, P.c(`rgba(255,90,58,${[0.8, 0.88, 0.95, 0.88][f]})`), 1, [...FIELD, FIELD[0], FIELD[1]]);
    },
  },
  // Tesla coil: the arcs crackle round the head.
  TSLA: {
    box: [0, 0, 24, 24],
    frames: 4,
    fps: 8,
    draw: (ctx, P, f) => {
      const turn = f * (TAU / 12);
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      for (const arc of TESLA_ARCS) {
        const pts = [];
        for (let i = 0; i < arc.length; i += 2) {
          // The ends stay put on the head; the kinks jitter from frame to frame.
          const j = i === 0 || i === arc.length - 2 || f === 0 ? 0 : Math.sin(i * 7.1 + f * 13.7) * 0.8;
          const dx = arc[i] - 12;
          const dy = arc[i + 1] - 12;
          pts.push(12 + dx * c - dy * s + j, 12 + dx * s + dy * c - j);
        }
        polyline(ctx, P.c('rgba(127,224,255,0.45)'), 2, pts);
        polyline(ctx, P.c('#e0f8ff'), 0.8, pts);
      }
      circle(ctx, P.c(GLOW), 12, 12, 2.5);
      circle(ctx, P.c('#ffffff'), 12, 12, 1);
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
