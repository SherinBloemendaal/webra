// Animated layers of buildings, drawn over the static art (art/buildings.js)
// like the looping overlays of the 1996 Red Alert sprites: the radar dish
// turning, chimney smoke, blinking beacons, turbine fans and the crane hook.
//
// Each entry is { box: [x, y, w, h], frames, fps, draw(ctx, P, f) }. `draw`
// paints frame f (0 <= f < frames) in the building's own coordinates (the
// footprint box of buildings.js, origin at its top left); the atlas keeps only
// `box` of it, so a layer costs a handful of small frames. The box may reach
// above the footprint (smoke rises over the roof). Frame 0 is the still image
// used by icons, cameos, fogged buildings and prefers-reduced-motion.
//
// The GPU picks the frame from a render clock (js/anim.js, shaders/sprite.wgsl),
// so the simulation never sees any of this.

import { C, circle, poly } from './kit.js';
import { K, at, box, col, radial, stroke } from './volume.js';
import { fan, lamp, teamLamp, puff, STEEL, STEEL_D } from './buildings.js';

const TAU = Math.PI * 2;

/**
 * A radar dish turning about its post at (cx, cy) from height z0: the rim is
 * the projected circle of a bowl whose axis points at `theta` (radians, in
 * the ground plane; 0 is east, PI / 2 towards the viewer).
 */
export function spinDish(ctx, P, cx, cy, z0, r, theta, spec = K('#c4c7cb')) {
  const [px, py] = at(cx, cy, z0 + r * 0.9);
  const [bx, by] = at(cx, cy, z0);
  stroke(ctx, P.c(C.steelDark), 1.2, bx, by, px, py);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // Rim: the circle across the axis n = (c, s, 0), spanned by the horizontal
  // u = (-s, c, 0) and the vertical, projected like every other point (at()).
  const rim = (k) => {
    const pts = [];
    for (let i = 0; i < 16; i++) {
      const phi = (i / 16) * TAU;
      const u = Math.cos(phi) * r * k;
      const v = Math.sin(phi) * r * k;
      pts.push(px - s * u + 0.28 * v, py + c * u - 0.92 * v);
    }
    return pts;
  };
  const horn = [px + c * r * 0.8, py + s * r * 0.8];
  const facing = s > -0.15; // the bowl opens towards the camera (south)
  const drawHorn = () => {
    stroke(ctx, P.c(C.steelDark), 0.7, px, py, horn[0], horn[1]);
    circle(ctx, P.c('#c23a26'), horn[0], horn[1], 0.7);
  };
  if (!facing) drawHorn();
  poly(ctx, P.c(C.steelDark), rim(1.12));
  const bowl = facing ? radial(ctx, P, spec, px - r * 0.3, py - r * 0.3, 0, px, py, r, [[0, 0.5], [0.6, -0.05], [1, -0.4]]) : col(P, spec, -0.3);
  poly(ctx, bowl, rim(1));
  if (facing) drawHorn();
}

/**
 * Smoke rising from (x, y): `n` puffs evenly spaced along the plume, moved on
 * by `t` (0..1) of one spacing, growing and fading as they rise.
 */
export function plume(ctx, P, x, y, size, t, n = 4) {
  for (let k = n - 1; k >= 0; k--) {
    const s = (k + t) / n;
    const fadeIn = Math.min(1, s / 0.12);
    const a = 0.5 * (1 - s) * fadeIn;
    if (a <= 0.01) continue;
    const wobble = Math.sin(s * 5.5) * 0.8;
    puff(ctx, P, x + (s * 5 + wobble) * size, y - s * 11 * size, (1.4 + s * 2) * size, a);
  }
}

/** A team coloured beacon, lit or dark. */
function beacon(ctx, P, x, y, r, on) {
  if (on) {
    circle(ctx, P.team(0.6), x, y, r + 1.4);
    teamLamp(ctx, P, x, y, r);
  } else {
    circle(ctx, P.c(C.steelDark), x, y, r + 0.7);
    circle(ctx, P.team(0.3), x, y, r);
  }
}

/** A red warning lamp, lit (with halo) or dark. */
function warning(ctx, P, x, y, on) {
  if (on) lamp(ctx, P, x, y);
  else lamp(ctx, P, x, y, '#5a1d16', 'rgba(0,0,0,0)');
}

const HPAD_BEACONS = [[6, 7], [42, 7], [6, 42], [42, 42]].map(([x, y]) => at(x, y, 1.6));

/** Animated layers by sprite key (sprites.js resolves aliases such as fakes). */
export const BUILDING_ANIM = {
  // Radar dome: the dish turns once every 8 frames.
  DOME: {
    box: [32, 9, 16, 19],
    frames: 8,
    fps: 6,
    draw: (ctx, P, f) => spinDish(ctx, P, 39, 31, 8, 3.6, (f / 8) * TAU + 0.6),
  },
  // Power plant: smoke from the stack.
  POWR: {
    box: [36, -12, 12, 26],
    frames: 6,
    fps: 6,
    draw: (ctx, P, f) => {
      const [sx, sy] = at(35, 34, 24);
      plume(ctx, P, sx, sy - 1.5, 0.8, f / 6);
    },
  },
  // Advanced power plant: three turbine fans (four blades, so a quarter turn loops).
  APWR: {
    box: [11, 4, 57, 14],
    frames: 4,
    fps: 10,
    draw: (ctx, P, f) => {
      for (const x of [14, 36, 58]) {
        const [lx, ly] = at(x, 22, 12);
        fan(ctx, P, lx, ly, 4.6, (f / 4) * (Math.PI / 2));
      }
    },
  },
  // Refinery: smoke from the stack.
  PROC: {
    box: [45, 2, 12, 22],
    frames: 6,
    fps: 6,
    draw: (ctx, P, f) => {
      const [sx, sy] = at(45, 40, 18);
      plume(ctx, P, sx, sy - 1, 0.7, f / 6);
    },
  },
  // Soviet barracks: a thin wisp from the chimney.
  BARR: {
    box: [34, -5, 10, 15],
    frames: 6,
    fps: 5,
    draw: (ctx, P, f) => {
      const [sx, sy] = at(33, 24, 16);
      plume(ctx, P, sx, sy - 1, 0.6, f / 6, 3);
    },
  },
  // Helipad: the corner beacons blink in diagonal pairs.
  HPAD: {
    box: [2, 1, 46, 46],
    frames: 2,
    fps: 1.5,
    draw: (ctx, P, f) => HPAD_BEACONS.forEach(([x, y], k) => beacon(ctx, P, x, y, 1.1, (k === 0 || k === 3) === (f === 0))),
  },
  // Airfield: runway lights chase towards the threshold, the tower dish turns,
  // the beacon on the corner blinks.
  AFLD: {
    box: [0, 3, 72, 45],
    frames: 8,
    fps: 8,
    draw: (ctx, P, f) => {
      for (let i = 0; i < 9; i++) {
        if ((i + f) % 8 !== 0) continue;
        const x = 68 - i * 8;
        for (const y of [28.5, 46]) {
          circle(ctx, P.c('rgba(255,230,140,0.45)'), x, y, 2.2);
          circle(ctx, P.c('#fff3b8'), x, y, 1.1);
        }
      }
      spinDish(ctx, P, 56, 20, 14, 2.4, (f / 8) * TAU + 0.6);
      beacon(ctx, P, 68, 6, 1.2, f < 4);
    },
  },
  // Allied tech center: the big dish sweeps, the yard lamps blink.
  ATEK: {
    box: [2, 7, 46, 46],
    frames: 8,
    fps: 4,
    draw: (ctx, P, f) => {
      // A slow sweep back and forth instead of full turns, like a tracking antenna.
      spinDish(ctx, P, 31, 36, 10, 7, 0.6 + Math.sin((f / 8) * TAU) * 0.7);
      warning(ctx, P, 5, 50, f % 4 < 2);
      warning(ctx, P, 41, 50, f % 4 >= 2);
    },
  },
  // Soviet tech center: the lab dish turns, the mast lamps blink.
  STEK: {
    box: [3, 4, 69, 38],
    frames: 8,
    fps: 4,
    draw: (ctx, P, f) => {
      spinDish(ctx, P, 35, 33, 18, 4.6, (f / 8) * TAU + 0.6);
      warning(ctx, P, ...at(4, 46, 9), f < 4);
      warning(ctx, P, ...at(68, 46, 9), f >= 4);
    },
  },
  // Construction yard: the crane hook goes up and down, the tower lamp blinks.
  FACT: {
    box: [30, 14, 32, 22],
    frames: 8,
    fps: 4,
    draw: (ctx, P, f) => {
      const z = 16.6 + (1 - Math.cos((f / 8) * TAU)) * 4.5;
      const [cx0, cy0] = at(28, 50.3, 31);
      const [cx1, cy1] = at(28, 50.3, z + 2.4);
      stroke(ctx, P.c(C.steelDark), 0.5, cx0, cy0, cx1, cy1);
      box(ctx, P, 27, 49.5, 2, 1.6, 2.4, STEEL_D, STEEL, { z0: z });
      const [lx, ly] = at(49, 50, 33.5);
      beacon(ctx, P, lx, ly, 1.2, f % 4 < 2);
    },
  },
};
