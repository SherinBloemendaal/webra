// Art for the engine's effects (engine/src/fx.rs), flat 1996 style: the
// damage smoke over badly hit vehicles and ships (OpenRA WithDamageOverlay),
// muzzle flashes (WithMuzzleOverlay) and one picture per explosion of
// OpenRA's CreateEffect warheads (engine/render.json `explosions`). The
// engine grows and fades them; with the original graphics installed their
// slots hold OpenRA's sequences instead. Helpers come from ./kit.js.

import { circle, ring, poly } from './kit.js';

/** A spiky burst: dark smoke ring, orange flame, yellow and white core. */
function burst(ctx, P, c, r, spikes, { smoke = true, flame = '#e8641c', mid = '#f5b030', core = '#fff2b0' } = {}) {
  if (smoke) circle(ctx, P.c('rgba(40,30,25,0.5)'), c, c, r);
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const rr = i % 2 ? r * 0.5 : r * 0.92;
    pts.push(c + Math.cos(a) * rr, c + Math.sin(a) * rr);
  }
  poly(ctx, P.c(flame), pts);
  circle(ctx, P.c(mid), c, c, r * 0.5);
  circle(ctx, P.c(core), c, c, r * 0.25);
}

/** Small puffs of a bullet hit (two for "piffs"), white on land, blue-white on water. */
function puffs(n, water) {
  const fill = water ? 'rgba(170,215,255,0.75)' : 'rgba(255,240,200,0.7)';
  const core = water ? '#eef8ff' : '#fffbe8';
  return [10, 10, (ctx, P) => {
    for (let k = 0; k < n; k++) {
      const x = 5 + (k ? 2.2 : 0) - (n > 1 ? 1.1 : 0);
      const y = 5 + (k ? -1.6 : 0) + (n > 1 ? 0.8 : 0);
      circle(ctx, P.c(fill), x, y, 3.4);
      circle(ctx, P.c(core), x, y, 1.4);
    }
  }];
}

/** A splash: white spray inside a pale blue ring. */
function splash(size) {
  const c = size / 2;
  return [size, size, (ctx, P) => {
    ring(ctx, P.c('rgba(150,200,255,0.55)'), c, c, c * 0.8, Math.max(1, size / 12));
    ring(ctx, P.c('rgba(235,245,255,0.85)'), c, c, c * 0.5, Math.max(1, size / 16));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      circle(ctx, P.c('#f4faff'), c + Math.cos(a) * c * 0.3, c + Math.sin(a) * c * 0.3, Math.max(0.8, size / 18));
    }
  }];
}

/** Burning napalm: flames on a dark scorch. */
function flames(size) {
  const c = size / 2;
  return [size, size, (ctx, P) => {
    circle(ctx, P.c('rgba(30,20,15,0.45)'), c, c, c * 0.95);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const x = c + Math.cos(a) * c * 0.45;
      const y = c + Math.sin(a) * c * 0.45;
      poly(ctx, P.c('#e8481c'), [x - c * 0.22, y + c * 0.18, x, y - c * 0.42, x + c * 0.22, y + c * 0.18]);
    }
    circle(ctx, P.c('#f5a030'), c, c, c * 0.4);
    circle(ctx, P.c('#ffe8a0'), c, c, c * 0.18);
  }];
}

/** Flak: a dark puff with a small orange core (hits in the air). */
function flak(size) {
  const c = size / 2;
  return [size, size, (ctx, P) => {
    circle(ctx, P.c('rgba(55,50,48,0.8)'), c, c, c * 0.9);
    circle(ctx, P.c('rgba(90,84,80,0.85)'), c - c * 0.2, c - c * 0.2, c * 0.5);
    circle(ctx, P.c('#f08a24'), c, c, c * 0.28);
  }];
}

const blast = (size, spikes, opts) => [size, size, (ctx, P) => burst(ctx, P, size / 2, size / 2 - 0.5, spikes, opts)];

/** WebRA's picture of an explosion of OpenRA's "explosion" image, by name. */
export function explosionArt(name) {
  switch (name) {
    case 'piff':
      return puffs(1, false);
    case 'piffs':
      return puffs(2, false);
    case 'water_piff':
      return puffs(1, true);
    case 'water_piffs':
      return puffs(2, true);
    case 'small_splash':
      return splash(16);
    case 'med_splash':
      return splash(24);
    case 'large_splash':
      return splash(34);
    case 'napalm':
    case 'small_napalm':
    case 'offset_napalm':
      return flames(18);
    case 'large_napalm':
    case 'building_napalm':
      return flames(34);
    case 'flak_explosion_ground':
    case 'small_explosion_air':
      return flak(16);
    case 'med_explosion_air':
      return flak(24);
    case 'small_explosion':
      return blast(18, 7);
    case 'med_explosion':
      return blast(24, 8);
    case 'artillery_explosion':
      return blast(28, 9);
    case 'large_explosion':
    case 'self_destruct':
      return blast(36, 11);
    case 'building':
      return blast(48, 12);
    case 'nuke':
      return [64, 64, (ctx, P) => {
        ring(ctx, P.c('rgba(245,170,70,0.6)'), 32, 32, 26, 4);
        circle(ctx, P.c('rgba(90,60,40,0.7)'), 32, 32, 19);
        burst(ctx, P, 32, 18, 13, { smoke: false });
        circle(ctx, P.c('#ffffff'), 32, 32, 3.5);
      }];
    default:
      return blast(20, 8);
  }
}

/** A muzzle flash, pointing north (the engine turns it with the barrel). */
export const MUZZLE_FLASH = [10, 12, (ctx, P) => {
  poly(ctx, P.c('rgba(255,170,60,0.7)'), [5, 0, 8.5, 7, 5, 12, 1.5, 7]);
  poly(ctx, P.c('#ffe680'), [5, 2, 7, 7, 5, 10, 3, 7]);
  circle(ctx, P.c('#ffffff'), 5, 7, 1.3);
}];

/**
 * Special sprites ([w, h, draw] or null), at most 8; see SPECIAL_SLOTS in
 * sprites.js. Order matters: engine/src/fx.rs uses `fx_base + index`.
 */
export const EFFECT_SPECIALS = [
  // 0: damage smoke, a grey cloud rising from a badly hit vehicle or ship
  [20, 22, (ctx, P) => {
    circle(ctx, P.c('rgba(60,58,55,0.55)'), 10, 15, 6);
    circle(ctx, P.c('rgba(85,82,78,0.6)'), 7, 10, 5);
    circle(ctx, P.c('rgba(110,106,100,0.55)'), 13, 7, 4.5);
    circle(ctx, P.c('rgba(140,136,130,0.45)'), 9, 4, 3.5);
  }],
  // 1, 2: the original Tesla zap frames (bright, dim); WebRA's zap is the tesla_bolt special
  null,
  null,
];
