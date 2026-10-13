// Procedural art for every structure (Allied and Soviet), modelled as pseudo-3D
// volumes in the look of the pre-rendered 1996 Red Alert / OpenRA sprites: a
// raised 3/4 camera, chunky boxes with visible south and east walls, roofs seen
// from above, light from the top left, cast shadows to the bottom right, concrete
// bibs and sandbags around the bases, and team colour on trims, roofs and lights
// through the shared mask (see sprites.js).
//
// The projection, volumes and light live in volume.js, so every building shares
// one camera. Each draw function takes (ctx, P) and paints into a box of
// footprint cells times 24 world pixels (the atlas cell has no headroom, so
// tall volumes lean up and to the right inside the box). Everything is
// deterministic (seeded noise, no Math.random) and cheap: the atlas draws each
// sprite exactly once.

import { C, rect, circle, poly, polyline, ring, ngon, hazard, trefoil, barrel, drum, teslaHead } from './kit.js';
import {
  KX,
  KY,
  T,
  K,
  tone,
  col,
  grad,
  radial,
  quad,
  disc,
  oval,
  stroke,
  at,
  castShadows,
  box,
  patch,
  mark,
  clipRoof,
  cylinder,
  dome,
  prism,
  gable,
  vault,
} from './volume.js';

// ---- Palette -------------------------------------------------------------------

const BRICK = '#8a4a38';
const GLASS = '#5f93ad';
const GLASS_HI = '#bfe3f2';
const GLASS_DK = '#23363f';
const WATER = '#1e3440';
const ASPHALT = '#44433e';
const DIRT = '#7d6e4c';
const PAINT = '#e8e6dc';
const RED = '#c23a26';
const COPPER = '#b0703a';
const LIT = '#ffd98a';

const WALL = K('#a4a193'); // concrete walls
const ROOF = K('#b8b5a7'); // concrete roofs
export const STEEL = K('#70747a');
const STEEL_L = K('#98a0a8');
export const STEEL_D = K('#3f4247');
const YEL = K(C.yellow);
const YEL_D = K(C.yellowDark);

/** Footprint of every building art key in cells (width, height), checked against the rules in tests. */
export const BUILDING_SIZE = {
  FACT: [3, 4], POWR: [2, 3], APWR: [3, 3], PROC: [3, 4], SILO: [1, 1], TENT: [2, 3], BARR: [2, 3], KENN: [1, 1],
  WEAP: [3, 3], FIX: [3, 3], DOME: [2, 3], HPAD: [2, 3], AFLD: [3, 2], SYRD: [3, 3], SPEN: [3, 3], ATEK: [2, 3],
  STEK: [3, 3], GAP: [1, 1], PDOX: [2, 2], IRON: [2, 2], MSLO: [2, 1], SBAG: [1, 1], FENC: [1, 1], BRIK: [1, 1],
  PBOX: [1, 1], HBOX: [1, 1], GUN: [1, 1], FTUR: [1, 1], TSLA: [1, 1], AGUN: [1, 1], SAM: [2, 1],
};

/** Seeded pseudo random numbers in [0, 1). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const fr = (ctx, P, s, x, y, w, h, d = 0) => rect(ctx, col(P, s, d), x, y, w, h);
const fc = (ctx, P, s, x, y, r, d = 0) => circle(ctx, col(P, s, d), x, y, r);
const fp = (ctx, P, s, pts, d = 0) => poly(ctx, col(P, s, d), pts);
const fe = (ctx, P, s, cx, cy, rx, ry, d = 0) => oval(ctx, col(P, s, d), cx, cy, rx, ry);

// ---- Ground ---------------------------------------------------------------------

/** Poured concrete slab: lit top/left edge, seams every half cell, speckles and a crack. */
function pad(ctx, P, x, y, w, h, seed = 1) {
  const r = rng(seed);
  rect(ctx, P.c(C.concreteDark), x, y, w, h);
  rect(ctx, P.c(C.concrete), x + 1, y + 1, w - 2, h - 2);
  rect(ctx, P.c(C.concreteLight), x + 1, y + 1, w - 2, 1);
  rect(ctx, P.c(C.concreteLight), x + 1, y + 1, 1, h - 2);
  for (let sx = x + 12; sx < x + w - 1; sx += 12) {
    rect(ctx, P.c(C.seam), sx, y + 1, 1, h - 2);
    rect(ctx, P.c('#9b988b'), sx + 1, y + 1, 1, h - 2);
  }
  for (let sy = y + 12; sy < y + h - 1; sy += 12) {
    rect(ctx, P.c(C.seam), x + 1, sy, w - 2, 1);
    rect(ctx, P.c('#9b988b'), x + 1, sy + 1, w - 2, 1);
  }
  const dots = Math.floor((w * h) / 36);
  for (let i = 0; i < dots; i++) {
    const dx = x + 2 + r() * (w - 4);
    const dy = y + 2 + r() * (h - 4);
    rect(ctx, P.c(r() < 0.5 ? '#7c7a70' : '#9d9a8d'), Math.floor(dx), Math.floor(dy), 1, 1);
  }
  if (w >= 24 && h >= 24) {
    const cx = x + 3 + r() * (w - 14);
    const cy = y + 3 + r() * (h - 14);
    polyline(ctx, P.c('#6f6d63'), 0.6, [cx, cy, cx + 3, cy + 2, cx + 4, cy + 5, cx + 7, cy + 7]);
  }
}

/** A pad with tyre marks, used in front of doors where units roll in and out. */
function apron(ctx, P, x, y, w, h, seed = 1) {
  pad(ctx, P, x, y, w, h, seed);
  const mid = x + Math.floor(w / 2);
  for (const tx of [mid - 4, mid + 3]) {
    rect(ctx, P.c('#7f7d72'), tx, y + 3, 1, h - 6);
    rect(ctx, P.c('#7f7d72'), tx + 1.6, y + 3, 0.6, h - 6);
  }
}

function dirt(ctx, P, x, y, w, h, seed = 1) {
  const r = rng(seed);
  rect(ctx, P.c('#5e5238'), x, y, w, h);
  rect(ctx, P.c(DIRT), x + 1, y + 1, w - 2, h - 2);
  for (let i = 0; i < (w * h) / 14; i++) {
    rect(ctx, P.c(r() < 0.5 ? '#6a5c3d' : '#8e7e58'), Math.floor(x + 1 + r() * (w - 3)), Math.floor(y + 1 + r() * (h - 3)), 1 + Math.floor(r() * 2), 1);
  }
}

/** A row of stacked sandbags with a lit top and a shaded underside, centred on y. */
function sandbags(ctx, P, x, y, n) {
  for (let i = 0; i < n; i++) {
    const bx = x + i * 5.2;
    oval(ctx, P.c('rgba(0,0,0,0.3)'), bx + 3.2, y + 3.2, 3.2, 1.5);
    oval(ctx, P.c('#6a6a42'), bx + 2.6, y + 1.8, 3.2, 2.1);
    oval(ctx, grad(ctx, P, K(C.canvas), 0, y - 0.4, 0, y + 3, [[0, 0.3], [1, -0.18]]), bx + 2.6, y + 1.4, 2.9, 1.7);
    rect(ctx, P.c('#b6b680'), bx + 1.4, y + 0.6, 2.4, 0.5);
  }
}

// ---- Face details ------------------------------------------------------------------

/** Roll-up door in a south wall: hazard-yellow frame, dark opening with ribs. */
function door(ctx, P, V, u, w, h, rib = 2.2) {
  patch(ctx, P.c(C.yellowDark), V, 'front', u - 1, 0, u + w + 1, h + 1);
  patch(ctx, P.c(C.track), V, 'front', u, 0, u + w, h);
  for (let v = 0.5; v < h - 0.5; v += rib) {
    patch(ctx, P.c(C.steelDark), V, 'front', u, v, u + w, v + rib * 0.6);
    mark(ctx, P.c('#585b60'), 0.5, V, 'front', u, v + rib * 0.6, u + w, v + rib * 0.6);
  }
  patch(ctx, P.c('rgba(0,0,0,0.45)'), V, 'front', u, h - 1.4, u + w, h);
}

/** A glazed window in a south wall (lit when `lit`). */
function win(ctx, P, V, u, v, w, h, lit = false) {
  patch(ctx, P.c(GLASS_DK), V, 'front', u - 0.5, v - 0.5, u + w + 0.5, v + h + 0.5);
  const a = V.front(u, v + h);
  const b = V.front(u, v);
  const g = ctx.createLinearGradient(0, a[1], 0, b[1]);
  g.addColorStop(0, P.c(lit ? '#fff0b8' : GLASS_HI));
  g.addColorStop(0.4, P.c(lit ? LIT : GLASS));
  g.addColorStop(1, P.c(lit ? '#c8903a' : '#3f6679'));
  patch(ctx, g, V, 'front', u, v, u + w, v + h);
  mark(ctx, P.c('rgba(255,255,255,0.45)'), 0.5, V, 'front', u + 0.4, v + h - 0.4, u + w * 0.5, v + 0.4);
}

function wins(ctx, P, V, u, v, n, w, h, gap, lit = false) {
  for (let i = 0; i < n; i++) win(ctx, P, V, u + i * (w + gap), v, w, h, lit);
}

/** A team (or any) coloured band wrapped around the south and east walls. */
function band(ctx, P, V, spec, v0, v1, from = 0, to = V.w) {
  patch(ctx, grad(ctx, P, spec, 0, V.front(0, v1)[1], 0, V.front(0, v0)[1], [[0, 0.2], [1, -0.12]]), V, 'front', from, v0, to, v1);
  mark(ctx, col(P, spec, 0.5), 0.5, V, 'front', from, v1 - 0.3, to, v1 - 0.3);
  if (to >= V.w - 0.01) patch(ctx, col(P, spec, -0.38), V, 'side', 0, v0, V.d, v1);
}

/** Seam grooves with a lit lip on a roof. */
function seams(ctx, P, V, spec, x0, t0, x1, t1, cols, rows) {
  for (let i = 1; i < cols; i++) {
    const u = x0 + ((x1 - x0) * i) / cols;
    mark(ctx, col(P, spec, -0.3), 0.7, V, 'roof', u, t0, u, t1);
    mark(ctx, col(P, spec, 0.3), 0.5, V, 'roof', u + 0.7, t0, u + 0.7, t1);
  }
  for (let j = 1; j < rows; j++) {
    const t = t0 + ((t1 - t0) * j) / rows;
    mark(ctx, col(P, spec, -0.3), 0.7, V, 'roof', x0, t, x1, t);
    mark(ctx, col(P, spec, 0.3), 0.5, V, 'roof', x0, t + 0.7, x1, t + 0.7);
  }
}

/** Louvre vents on a roof. */
function roofVents(ctx, P, V, u, t, n, w, d, gap) {
  for (let i = 0; i < n; i++) {
    const x = u + i * (w + gap);
    patch(ctx, P.c('#1f2022'), V, 'roof', x, t, x + w, t + d);
    patch(ctx, P.c(C.steel), V, 'roof', x, t + d - 0.7, x + w, t + d);
  }
}

/** A round extractor fan on a roof. */
function roofFan(ctx, P, V, u, t, r) {
  const [x, y] = V.roof(u, t);
  disc(ctx, P.c(C.steelDark), x, y, r);
  disc(ctx, P.c('#1f2022'), x, y, r - 0.9);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.5;
    poly(ctx, P.c(C.steel), [x, y, x + Math.cos(a - 0.35) * (r - 1), y + Math.sin(a - 0.35) * (r - 1), x + Math.cos(a + 0.35) * (r - 1), y + Math.sin(a + 0.35) * (r - 1)]);
  }
  disc(ctx, P.c(C.steelLight), x, y, 0.8);
}

/** Round fan seen from above on the ground or any flat top, its blades turned by `rot` radians. */
export function fan(ctx, P, cx, cy, r, rot = 0) {
  circle(ctx, P.c(C.steelDark), cx, cy, r);
  circle(ctx, P.c('#1f2022'), cx, cy, r - 1);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.5 + rot;
    poly(ctx, P.c(C.steel), [cx, cy, cx + Math.cos(a - 0.35) * (r - 1), cy + Math.sin(a - 0.35) * (r - 1), cx + Math.cos(a + 0.35) * (r - 1), cy + Math.sin(a + 0.35) * (r - 1)]);
  }
  circle(ctx, P.c(C.steelLight), cx, cy, 1);
}

/** A small lamp with a halo. */
export function lamp(ctx, P, x, y, bulb = '#ff4a3a', halo = 'rgba(255,90,70,0.35)') {
  circle(ctx, P.c(halo), x, y, 2.4);
  circle(ctx, P.c(C.steelDark), x, y, 1.3);
  circle(ctx, P.c(bulb), x, y, 0.9);
}

export function teamLamp(ctx, P, x, y, r = 1.6) {
  circle(ctx, P.c(C.steelDark), x, y, r + 0.7);
  circle(ctx, P.team(0.85), x, y, r);
  circle(ctx, P.team(1.0), x - r * 0.3, y - r * 0.3, r * 0.4);
}

/** A standing mast from the ground up to height h with a warning lamp (none when bulb is null). */
function mast(ctx, P, x, y, h, bulb) {
  const [x1, y1] = at(x, y, h);
  stroke(ctx, P.c(C.steelDark), 1.1, x, y, x1, y1);
  stroke(ctx, P.c(C.steelLight), 0.5, x - 0.3, y, x1 - 0.3, y1);
  if (bulb !== null) lamp(ctx, P, x1, y1, bulb);
}

/** Oil drum: a short upright cylinder. */
function drumAt(ctx, P, x, y, spec = K('#b8442e')) {
  cylinder(ctx, P, x, y, 1.9, 3.4, spec, K('#c9c6bb'));
}

/** A small wooden crate box. */
function crateAt(ctx, P, x, y, s = 4) {
  box(ctx, P, x, y, s, s * 0.8, s * 0.9, K('#8a6a3c'), K('#a98450'));
}

/** Satellite dish on a post: the bowl is tilted towards the upper right. */
export function dishAt(ctx, P, cx, cy, z0, r, spec = K('#c4c7cb')) {
  const [px, py] = at(cx, cy, z0 + r * 0.9);
  const [bx, by] = at(cx, cy, z0);
  stroke(ctx, P.c(C.steelDark), 1.2, bx, by, px, py);
  ctx.save();
  ctx.translate(px, py - r * 0.2);
  ctx.rotate(-0.55);
  oval(ctx, P.c(C.steelDark), 0, 0, r, r * 0.78);
  oval(ctx, radial(ctx, P, spec, -r * 0.3, -r * 0.2, 0, 0, 0, r, [[0, 0.5], [0.6, -0.05], [1, -0.4]]), -0.2, -0.1, r * 0.88, r * 0.66);
  ctx.restore();
  stroke(ctx, P.c(C.steelDark), 0.7, px, py - r * 0.2, px + r * 0.75, py - r * 1.1);
  circle(ctx, P.c(RED), px + r * 0.75, py - r * 1.1, 0.7);
}

/** One soft grey smoke puff of radius r and opacity a. */
export function puff(ctx, P, x, y, r, a) {
  circle(ctx, P.c(`rgba(214,214,208,${a.toFixed(3)})`), x, y, r);
  circle(ctx, P.c(`rgba(250,250,246,${(a * 0.6).toFixed(3)})`), x - r * 0.3, y - r * 0.3, r * 0.55);
}

/** Pipe run drawn on a roof or the ground: dark outline, lit core. */
function pipe(ctx, P, pts, w = 2, s = K(C.steel)) {
  polyline(ctx, P.c(C.steelDark), w + 1.2, pts);
  polyline(ctx, col(P, s), w, pts);
  polyline(ctx, col(P, s, 0.45), Math.max(0.5, w * 0.3), pts.map((v) => v - 0.4));
}

/** Rows of fixed-colour brick for a south wall. */
function bricks(ctx, P, V, u0, v0, u1, v1, base = BRICK) {
  patch(ctx, P.c(base), V, 'front', u0, v0, u1, v1);
  const row = 2.4;
  let i = 0;
  for (let v = v0; v < v1; v += row, i++) {
    mark(ctx, P.c(tone(base, -0.32)), 0.5, V, 'front', u0, v, u1, v);
    for (let u = u0 + (i % 2 ? 2 : 0); u < u1; u += 4.5) mark(ctx, P.c(tone(base, -0.32)), 0.5, V, 'front', u, v, u, Math.min(v + row, v1));
    mark(ctx, P.c(tone(base, 0.16)), 0.4, V, 'front', u0, v + 0.5, u1, v + 0.5);
  }
}

// ---- Buildings --------------------------------------------------------------------

/** Yellow/black hazard posts on a south wall. */
function hazardF(ctx, P, V, u0, u1, v1, step = 1.6) {
  let on = true;
  for (let v = 0; v < v1; v += step) {
    patch(ctx, P.c(on ? C.yellow : C.track), V, 'front', u0, v, u1, Math.min(v + step, v1));
    on = !on;
  }
}

/** Shadows that rooftop items throw onto their roof. */
function roofShadows(ctx, P, V, items) {
  ctx.save();
  clipRoof(ctx, V);
  castShadows(ctx, P, items.map((it) => ({ ...it, z0: V.top })));
  ctx.restore();
}

export const BUILDING_DRAW = {
  // Construction yard 3x4: assembly hall, rooftop plant and a tower crane.
  FACT: (ctx, P) => {
    pad(ctx, P, 0, 0, 72, 72, 11);
    apron(ctx, P, 0, 72, 72, 24, 12);
    for (let x = 2; x < 70; x += 8) rect(ctx, P.c(C.yellow), x, 73.5, 4, 1);
    castShadows(ctx, P, [{ x: 4, y: 30, w: 40, d: 36, z: 16 }, { x: 49, y: 50, w: 5, d: 5, z: 26 }]);
    const H = box(ctx, P, 4, 30, 40, 36, 16, WALL, K('#8a9096'));
    // team roof panels and seams
    patch(ctx, grad(ctx, P, T(0.64), 0, H.roof(0, 0)[1], 0, H.roof(0, 36)[1], [[0, 0.25], [1, -0.05]]), H, 'roof', 3, 3, 37, 13);
    seams(ctx, P, H, T(0.64), 3, 3, 37, 13, 6, 1);
    seams(ctx, P, H, K('#8a9096'), 3, 15, 37, 33, 6, 2);
    // front: team fascia, clerestory windows, workshop door, hazard posts
    band(ctx, P, H, T(0.62), 13, 15.6);
    wins(ctx, P, H, 3, 9, 3, 3.6, 2.6, 1.6);
    wins(ctx, P, H, 27, 9, 3, 3.6, 2.6, 1.6);
    door(ctx, P, H, 12, 16, 10);
    hazardF(ctx, P, H, 9.5, 11.2, 10);
    hazardF(ctx, P, H, 28.8, 30.5, 10);
    // rooftop plant: ventilation block and a machinery box
    roofShadows(ctx, P, H, [{ x: H.x + 4, y: H.y + 16, w: 12, d: 10, z: 5 }, { x: H.x + 21, y: H.y + 19, w: 14, d: 8, z: 4 }]);
    const A = box(ctx, P, H.x + 4, H.y + 16, 12, 10, 5, K('#9a978a'), K('#b2afa2'), { z0: 16 });
    roofFan(ctx, P, A, 6, 5, 3);
    const B = box(ctx, P, H.x + 21, H.y + 19, 14, 8, 4, STEEL, STEEL_L, { z0: 16 });
    roofVents(ctx, P, B, 2, 2.4, 5, 1.6, 3.4, 0.8);
    pipe(ctx, P, [...at(H.x + 16, H.y + 21, 16 + 2.5), ...at(H.x + 21, H.y + 23, 16 + 2)], 1.4, K(C.steel));
    // tower crane: lattice tower, cab, jib with a hanging hook, counterweight
    const tw = box(ctx, P, 49, 50, 5, 5, 26, K('#c9a02e'), K('#e0b840'));
    for (let v = 1; v < 24; v += 5) {
      mark(ctx, P.c(C.yellowDark), 0.7, tw, 'front', 0.3, v, 4.7, v + 5);
      mark(ctx, P.c(C.yellowDark), 0.7, tw, 'front', 4.7, v, 0.3, v + 5);
    }
    box(ctx, P, 47, 47, 9, 8, 4.5, STEEL_D, STEEL_L, { z0: 26 });
    box(ctx, P, 24, 49, 31, 2.6, 2.2, YEL, K('#e8c850'), { z0: 31 });
    box(ctx, P, 54, 48, 5, 4, 3, K('#5c5f64'), K('#74787e'), { z0: 29.5 });
    // the hook going up and down and the tower lamp are animated (art/animated.js)
    // yard details
    drumAt(ctx, P, 60, 62);
    drumAt(ctx, P, 64, 64, K('#4f6b2f'));
    crateAt(ctx, P, 56, 58, 4);
    sandbags(ctx, P, 6, 68, 3);
    teamLamp(ctx, P, 68, 4, 1.8);
    teamLamp(ctx, P, 4, 70, 1.6);
  },

  // Power plant 2x3: boiler hall with two stacks.
  POWR: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 31);
    castShadows(ctx, P, [
      { cx: 11, cy: 23, r: 5.6, z: 14 },
      { cx: 25, cy: 23, r: 5.6, z: 14 },
      { x: 3, y: 26, w: 38, d: 22, z: 10 },
      { cx: 35, cy: 34, r: 2.4, z: 24 },
    ]);
    const banded = [[7.5, 10.5, T(0.62)]];
    cylinder(ctx, P, 11, 23, 5.6, 14, STEEL, STEEL_L, { bands: banded });
    cylinder(ctx, P, 25, 23, 5.6, 14, STEEL, STEEL_L, { bands: banded });
    const H = box(ctx, P, 3, 26, 38, 22, 10, WALL, ROOF);
    seams(ctx, P, H, ROOF, 2, 2, 36, 20, 5, 2);
    band(ctx, P, H, T(0.62), 6.2, 8.8);
    door(ctx, P, H, 15, 8, 5.4);
    wins(ctx, P, H, 3, 2.6, 2, 3.2, 2, 1.8);
    wins(ctx, P, H, 27, 2.6, 2, 3.2, 2, 1.8);
    // transformer yard on the roof
    const X = box(ctx, P, H.x + 3, H.y + 4, 11, 9, 4, STEEL_L, K('#a9b0b6'), { z0: 10 });
    roofVents(ctx, P, X, 2, 2, 4, 1.4, 4.4, 0.9);
    pipe(ctx, P, [...at(H.x + 16, H.y + 8, 10.5), ...at(H.x + 24, H.y + 8, 10.5)], 1.6, K(C.steel));
    cylinder(ctx, P, 35, 34, 2.4, 14, STEEL_D, STEEL, { z0: 10, bands: [[10, 12, T(0.62)]] });
    // the stack's smoke is animated (art/animated.js)
    lamp(ctx, P, 6, 51);
    drumAt(ctx, P, 42, 56);
  },

  // Advanced power plant 3x3: three turbine halls.
  APWR: (ctx, P) => {
    apron(ctx, P, 0, 48, 72, 24, 41);
    castShadows(ctx, P, [
      { cx: 14, cy: 22, r: 8, z: 12 },
      { cx: 36, cy: 22, r: 8, z: 12 },
      { cx: 58, cy: 22, r: 8, z: 12 },
      { x: 3, y: 28, w: 62, d: 20, z: 9 },
    ]);
    for (const x of [14, 36, 58]) {
      cylinder(ctx, P, x, 22, 8, 12, STEEL, STEEL_L, { bands: [[6.5, 8.5, T(0.62)]] });
    }
    const H = box(ctx, P, 3, 28, 62, 20, 9, WALL, ROOF);
    seams(ctx, P, H, ROOF, 2, 2, 60, 18, 8, 2);
    band(ctx, P, H, T(0.62), 5.4, 7.8);
    door(ctx, P, H, 27, 10, 5);
    wins(ctx, P, H, 4, 1.8, 3, 3.6, 2.2, 1.8, true);
    wins(ctx, P, H, 44, 1.8, 3, 3.6, 2.2, 1.8, true);
    // turbine fan wells on the three lids; the turning fans are animated (art/animated.js)
    for (const x of [14, 36, 58]) {
      const [lx, ly] = at(x, 22, 12);
      disc(ctx, P.c(C.steelDark), lx, ly, 5.6);
    }
    pipe(ctx, P, [...at(14, 30, 9.5), ...at(36, 30, 9.5), ...at(58, 30, 9.5)], 2, K(C.steel));
    mast(ctx, P, 66, 31, 6);
    lamp(ctx, P, 24, 52);
    sandbags(ctx, P, 54, 54, 3);
  },

  // Ore refinery 3x4: ore tower, processing plant and an unloading dock.
  PROC: (ctx, P) => {
    apron(ctx, P, 0, 48, 72, 48, 51);
    for (let x = 30; x < 42; x += 4) rect(ctx, P.c(C.yellow), x, 58, 2, 14);
    castShadows(ctx, P, [
      { x: 2, y: 26, w: 62, d: 24, z: 10 },
      { cx: 34, cy: 23, r: 10, z: 10 },
    ]);
    // ore tower behind the plant
    cylinder(ctx, P, 34, 23, 10, 10, K('#a9a698'), K('#8e8b7e'), { bands: [[5, 7.4, T(0.62)]] });
    const [tx, ty] = at(34, 23, 10);
    disc(ctx, P.c('#3a3830'), tx, ty, 7.4);
    disc(ctx, radial(ctx, P, K(C.ore), tx - 3, ty - 3, 0, tx, ty, 8, [[0, 0.4], [1, -0.25]]), tx, ty + 0.6, 6.4);
    for (const [dx, dy, r] of [[-3, -1.2, 1.5], [1.2, -2.2, 1.7], [3.8, 0.5, 1.4], [-1.8, 2.2, 1.3], [2.2, 2.6, 1.2]]) disc(ctx, P.c('#e0b040'), tx + dx, ty + dy, r);
    disc(ctx, P.c('#f2d36a'), tx - 0.6, ty - 3, 0.8);
    // plant hall
    const H = box(ctx, P, 2, 26, 62, 24, 10, WALL, ROOF);
    patch(ctx, grad(ctx, P, T(0.62), 0, H.roof(0, 0)[1], 0, H.roof(0, 24)[1], [[0, 0.25], [1, -0.05]]), H, 'roof', 3, 3, 24, 17);
    patch(ctx, grad(ctx, P, T(0.62), 0, H.roof(0, 0)[1], 0, H.roof(0, 24)[1], [[0, 0.25], [1, -0.05]]), H, 'roof', 38, 3, 59, 17);
    seams(ctx, P, H, T(0.62), 3, 3, 24, 17, 4, 2);
    seams(ctx, P, H, T(0.62), 38, 3, 59, 17, 4, 2);
    band(ctx, P, H, T(0.62), 6.4, 8.8);
    wins(ctx, P, H, 4, 1.8, 4, 4, 2.6, 2.2, true);
    wins(ctx, P, H, 38, 1.8, 4, 4, 2.6, 2.2, true);
    // rooftop piping and a stack
    pipe(ctx, P, [...at(26, 36, 10.5), ...at(32, 36, 10.5), ...at(32, 30, 10.5)], 2, K(C.steel));
    cylinder(ctx, P, 45, 40, 2.6, 8, STEEL, STEEL_L, { z0: 10 });
    // the stack's smoke is animated (art/animated.js)
    // unloading dock: steel grating with hazard edge
    rect(ctx, P.c(C.yellowDark), 0, 52, 26, 22);
    rect(ctx, P.c(C.steelDark), 1, 53, 24, 20);
    rect(ctx, P.c(C.steel), 2, 54, 22, 18);
    for (let gx = 4; gx < 24; gx += 3) rect(ctx, P.c('#46484c'), gx, 54, 0.8, 18);
    for (let gy = 56; gy < 72; gy += 3) rect(ctx, P.c('#46484c'), 2, gy, 22, 0.8);
    rect(ctx, P.c(C.steelLight), 2, 54, 22, 1);
    hazard(ctx, P, 1, 71, 24, 2, 2);
    lamp(ctx, P, 3, 52.5, '#ffb030', 'rgba(255,180,50,0.35)');
    lamp(ctx, P, 24, 52.5, '#ffb030', 'rgba(255,180,50,0.35)');
    sandbags(ctx, P, 50, 76, 4);
    drumAt(ctx, P, 62, 62);
    drumAt(ctx, P, 66, 64);
  },

  // Allied barracks 2x3: a canvas field tent.
  TENT: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 61);
    dirt(ctx, P, 0, 0, 48, 48, 62);
    castShadows(ctx, P, [{ x: 4, y: 20, w: 36, d: 24, z: 9 }]);
    const H = box(ctx, P, 4, 22, 36, 22, 3, K('#8c8c58'), K('#8c8c58'));
    gable(ctx, P, H, 11, K('#9c9c66'), { axis: 'y', seams: 5, overhang: 1.5, end: K('#7a7a4c') });
    // open door with tied-back flaps in the front gable
    const [dx, dy] = at(22, 44, 3);
    poly(ctx, P.c(C.track), [dx - 5, dy + 3, dx, dy - 9, dx + 5, dy + 3]);
    poly(ctx, P.c('#8c8c58'), [dx - 5, dy + 3, dx, dy - 9, dx - 2.4, dy + 3]);
    poly(ctx, P.c('#6e6e44'), [dx + 5, dy + 3, dx, dy - 9, dx + 2.4, dy + 3]);
    // team valance along the front eave and a team patch on the lit slope
    const ve = at(2.5, 45.5, 3);
    const vw = at(41.5, 45.5, 3);
    poly(ctx, P.team(0.7), [ve[0], ve[1], vw[0], vw[1], vw[0], vw[1] + 2.2, ve[0], ve[1] + 2.2]);
    const [px, py] = at(11, 30, 8);
    poly(ctx, P.team(0.62), [px, py, px + 6, py + 1, px + 6.4, py + 6, px + 0.4, py + 5]);
    // flag on the ridge pole
    const [fx, fy] = at(22, 24, 14);
    const [fx2, fy2] = at(22, 24, 24);
    stroke(ctx, P.c(C.steelDark), 1, fx, fy, fx2, fy2);
    poly(ctx, P.team(0.9), [fx2, fy2, fx2 + 6.6, fy2 + 2.6, fx2, fy2 + 5]);
    // guy ropes and stakes
    for (const [x, y] of [[1, 42], [46, 42], [3, 30], [44, 30]]) {
      polyline(ctx, P.c('#cdbb88'), 0.5, [x, y, x < 24 ? x + 4 : x - 4, y - 6]);
      rect(ctx, P.c(C.steelDark), x - 0.5, y - 0.5, 1.5, 1.5);
    }
    // supplies
    crateAt(ctx, P, 2, 6, 5);
    crateAt(ctx, P, 9, 5, 4);
    drumAt(ctx, P, 42, 12, K('#4f6b2f'));
    sandbags(ctx, P, 6, 48, 3);
    sandbags(ctx, P, 30, 48, 3);
  },

  // Soviet barracks 2x3: brick barracks block with a star plate.
  BARR: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 71);
    pad(ctx, P, 0, 0, 48, 48, 72);
    castShadows(ctx, P, [{ x: 3, y: 18, w: 38, d: 28, z: 11 }, { x: 33, y: 20, w: 5, d: 5, z: 18 }]);
    const H = box(ctx, P, 3, 18, 38, 28, 11, K(BRICK), K('#6b7075'));
    bricks(ctx, P, H, 0, 0, 38, 11);
    patch(ctx, grad(ctx, P, K('#5a5f64'), 0, H.front(0, 11)[1], 0, H.front(0, 0)[1], [[0, 0.3], [1, -0.4]]), H, 'front', 0, 9.6, 38, 11);
    // pitched roof: lit northern slope, shaded southern slope
    patch(ctx, grad(ctx, P, K('#6b7075'), 0, H.roof(0, 0)[1], 0, H.roof(0, 14)[1], [[0, 0.2], [1, 0.0]]), H, 'roof', 0, 0, 38, 14);
    patch(ctx, grad(ctx, P, K('#4b4f53'), 0, H.roof(0, 14)[1], 0, H.roof(0, 28)[1], [[0, -0.05], [1, -0.3]]), H, 'roof', 0, 14, 38, 28);
    mark(ctx, P.c('#a0a5aa'), 0.8, H, 'roof', 0, 0.5, 38, 0.5);
    mark(ctx, P.c('#33363a'), 0.9, H, 'roof', 0, 14, 38, 14);
    for (let u = 3; u < 38; u += 4.5) {
      mark(ctx, P.c('#33363a'), 0.5, H, 'roof', u, 1, u, 13.5);
      mark(ctx, P.c('#2b2e32'), 0.5, H, 'roof', u, 14.5, u, 27);
    }
    // star plate on the south slope
    patch(ctx, grad(ctx, P, T(0.55), 0, H.roof(0, 15)[1], 0, H.roof(0, 26)[1], [[0, 0.2], [1, -0.18]]), H, 'roof', 7, 15, 31, 26);
    const [stx, sty] = H.roof(19, 20.5);
    const star = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? 2.4 : 5.4;
      star.push(stx + Math.cos(a) * rr, sty + Math.sin(a) * rr);
    }
    poly(ctx, P.team(1.0), star);
    // chimney; its smoke is animated (art/animated.js)
    const Ch = box(ctx, P, 31, 22, 4, 4, 5, K('#7a746a'), K('#8a847a'), { z0: 11 });
    patch(ctx, P.c(C.track), Ch, 'roof', 1, 1, 3, 3);
    // door, windows and a team lintel
    door(ctx, P, H, 14, 10, 7, 2.6);
    patch(ctx, P.team(0.7), H, 'front', 13, 7.6, 25, 9);
    wins(ctx, P, H, 4, 3.2, 2, 3.6, 3, 2);
    wins(ctx, P, H, 28, 3.2, 2, 3.6, 3, 2);
    for (let x = 4; x < 40; x += 5) {
      if (x > 11 && x < 28) continue;
      sandbags(ctx, P, x, 46.6, 1);
    }
  },

  // War factory 3x3: arched vehicle hangar with a roll-up bay.
  WEAP: (ctx, P) => {
    apron(ctx, P, 0, 48, 72, 24, 81);
    pad(ctx, P, 0, 0, 72, 48, 82);
    castShadows(ctx, P, [{ x: 3, y: 20, w: 62, d: 28, z: 11 }]);
    const H = box(ctx, P, 3, 20, 62, 28, 11, WALL, K('#8a9096'));
    vault(ctx, P, H, 5, T(0.64), { bands: 10, rib: 11, end: T(0.4) });
    // roof furniture
    const A = box(ctx, P, 8, 29, 9, 6, 2.5, K('#9a978a'), K('#b2afa2'), { z0: 11 });
    roofFan(ctx, P, A, 4.5, 3, 2.1);
    const B = box(ctx, P, 46, 32, 12, 5, 2.5, STEEL, STEEL_L, { z0: 11 });
    roofVents(ctx, P, B, 1.6, 1.2, 5, 1.6, 2.6, 0.9);
    // front wall: big bay, hazard posts, windows and lamps
    band(ctx, P, H, T(0.5), 8.4, 10.4);
    door(ctx, P, H, 17, 28, 8.2, 2.5);
    hazardF(ctx, P, H, 12.5, 14.5, 8.2);
    hazardF(ctx, P, H, 48.5, 50.5, 8.2);
    wins(ctx, P, H, 2.6, 3.4, 2, 3.4, 2.8, 1.8);
    wins(ctx, P, H, 53, 3.4, 2, 3.4, 2.8, 1.8);
    mast(ctx, P, 67, 24, 10);
    lamp(ctx, P, 15, 50, '#ffb030', 'rgba(255,180,50,0.35)');
    lamp(ctx, P, 52, 50, '#ffb030', 'rgba(255,180,50,0.35)');
    teamLamp(ctx, P, 67, 46, 1.4);
    sandbags(ctx, P, 3, 49, 2);
    sandbags(ctx, P, 56, 49, 2);
  },

  // Service depot 3x3: a plus of repair pads with a robot arm in the middle.
  FIX: (ctx, P) => {
    const cells = [[24, 0], [0, 24], [24, 24], [48, 24], [24, 48]];
    cells.forEach(([x, y], i) => pad(ctx, P, x, y, 24, 24, 90 + i));
    // bay outlines on the four arms
    for (const [x, y, w, h] of [[28, 3, 16, 18], [3, 28, 18, 16], [51, 28, 18, 16], [28, 51, 16, 18]]) {
      rect(ctx, P.c(C.yellow), x, y, w, 1);
      rect(ctx, P.c(C.yellow), x, y + h - 1, w, 1);
      rect(ctx, P.c(C.yellow), x, y, 1, h);
      rect(ctx, P.c(C.yellow), x + w - 1, y, 1, h);
    }
    castShadows(ctx, P, [
      { x: 25, y: 29, w: 22, d: 20, z: 3 },
      { cx: 30, cy: 34, r: 3, z: 12 },
      { x: 55, y: 14, w: 9, d: 7, z: 9 },
    ]);
    // raised repair platform with the team cross
    const D = box(ctx, P, 25, 29, 22, 20, 3, K('#6c7076'), K('#80858b'));
    for (let i = 3; i < 22; i += 4) mark(ctx, P.c('#5f6266'), 0.5, D, 'roof', i, 0, i, 20);
    for (let i = 3; i < 20; i += 4) mark(ctx, P.c('#5f6266'), 0.5, D, 'roof', 0, i, 22, i);
    const [cx, cy] = D.roof(11, 10);
    disc(ctx, P.c(C.steelDark), cx, cy, 8.6);
    disc(ctx, grad(ctx, P, T(0.7), cx - 8, cy - 8, cx + 8, cy + 8, [[0, 0.25], [1, -0.15]]), cx, cy, 7.6);
    patch(ctx, P.team(1.0), D, 'roof', 9, 4, 13, 16);
    patch(ctx, P.team(1.0), D, 'roof', 5, 8, 17, 12);
    band(ctx, P, D, T(0.62), 0.6, 1.8);
    // robot arm: pedestal, two yellow segments, claw
    cylinder(ctx, P, 31, 35, 3, 4, STEEL, STEEL_L, { z0: 3 });
    const a0 = at(31, 35, 7);
    const a1 = at(34, 33, 17);
    const a2 = at(41, 36, 15);
    polyline(ctx, P.c(C.steelDark), 3.4, [...a0, ...a1, ...a2]);
    polyline(ctx, P.c(C.yellow), 2.2, [...a0, ...a1, ...a2]);
    polyline(ctx, P.c('#f0d878'), 0.7, [a0[0] - 0.5, a0[1], a1[0] - 0.5, a1[1], a2[0] - 0.5, a2[1]]);
    disc(ctx, P.c(C.steelDark), a1[0], a1[1], 2);
    disc(ctx, P.team(0.8), a1[0], a1[1], 1.2);
    disc(ctx, P.c(C.steelDark), a2[0], a2[1], 1.9);
    polyline(ctx, P.c(C.steelDark), 0.8, [a2[0], a2[1], a2[0] + 1.4, a2[1] + 2.8]);
    // control booth on the east arm
    const B = box(ctx, P, 55, 14, 9, 7, 9, WALL, K('#8f959b'));
    wins(ctx, P, B, 1.4, 4.6, 2, 2.6, 2.6, 0.9, true);
    band(ctx, P, B, T(0.62), 7.8, 9);
    roofFan(ctx, P, B, 4.5, 3.5, 1.7);
    for (const [x, y] of [[26, 4], [46, 4], [4, 26], [4, 46], [68, 26], [68, 46], [26, 68], [46, 68]]) lamp(ctx, P, x, y, '#ffd24a', 'rgba(255,210,70,0.3)');
  },

  // Radar dome 2x3: control building under a radar sphere.
  DOME: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 101);
    castShadows(ctx, P, [{ x: 3, y: 26, w: 40, d: 22, z: 8 }, { cx: 23, cy: 36, r: 13, z: 12 }]);
    const H = box(ctx, P, 3, 26, 40, 22, 8, WALL, ROOF, { panel: 8 });
    band(ctx, P, H, T(0.58), 5.4, 7.2);
    door(ctx, P, H, 15, 10, 5, 2.6);
    wins(ctx, P, H, 3.5, 1.6, 3, 3, 2.4, 2.4);
    wins(ctx, P, H, 28, 1.6, 3, 3, 2.4, 2.4);
    // the radar sphere on a drum
    cylinder(ctx, P, 23, 35, 13.6, 2.6, K('#6c7076'), K('#80858b'), { z0: 8 });
    dome(ctx, P, 23, 35, 13, T(0.82), { z0: 10.6 });
    // latitude seams
    for (const [h, a] of [[4, 0.85], [8.5, 0.5]]) {
      const [rx, ry] = at(23, 35, 10.6 + h);
      const rr = Math.sqrt(169 - h * h);
      ctx.strokeStyle = P.team(0.4);
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(rx, ry, rr, 0.15, Math.PI - 0.15);
      ctx.stroke();
    }
    // the turning radar dish is animated (art/animated.js)
    mast(ctx, P, 5, 28, 12);
    sandbags(ctx, P, 4, 48, 2);
    sandbags(ctx, P, 32, 48, 2);
  },

  // Helipad 2x3: a lit pad with a painted H.
  HPAD: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 111);
    pad(ctx, P, 0, 0, 48, 48, 112);
    castShadows(ctx, P, [{ x: 2, y: 3, w: 44, d: 43, z: 1.6 }, { x: 36, y: 28, w: 7, d: 9, z: 5 }, { x: 4, y: 12, w: 1, d: 1, z: 9 }]);
    // raised landing platform
    const D = box(ctx, P, 2, 3, 44, 43, 1.6, K('#9b988b'), K('#a8a598'));
    // painted ring and H (flat on the platform top)
    const [cx, cy] = D.roof(22, 20);
    disc(ctx, P.c(C.yellowDark), cx, cy, 18.6);
    disc(ctx, P.c('#a3a094'), cx, cy, 17.4);
    disc(ctx, grad(ctx, P, K('#a8a598'), cx - 16, cy - 16, cx + 16, cy + 16, [[0, 0.2], [1, -0.1]]), cx, cy, 16.6);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      disc(ctx, P.c(C.yellow), cx + Math.cos(a) * 18, cy + Math.sin(a) * 18, 0.9);
    }
    fr(ctx, P, T(0.9), cx - 7, cy - 10, 4.4, 20);
    fr(ctx, P, T(0.9), cx + 2.6, cy - 10, 4.4, 20);
    fr(ctx, P, T(0.9), cx - 7, cy - 2, 14, 4);
    fr(ctx, P, T(1.0), cx - 7, cy - 10, 4.4, 1);
    fr(ctx, P, T(1.0), cx + 2.6, cy - 10, 4.4, 1);
    // corner beacons
    for (const [x, y] of [[6, 7], [42, 7], [6, 42], [42, 42]]) {
      const [bx, by] = D.roof(x - 2, y - 3);
      disc(ctx, P.c(C.yellow), bx, by, 2.8);
      disc(ctx, P.c(C.track), bx, by, 1.8);
      // the blinking lamp itself is animated (art/animated.js)
    }
    // fuel cart
    box(ctx, P, 38, 28, 6, 9, 3.4, STEEL_L, K('#a9b0b6'));
    cylinder(ctx, P, 41, 31, 2.1, 4, K('#b8442e'), K('#c9c6bb'), { z0: 3.4 });
    // windsock on a pole
    const [wx, wy] = at(5, 16, 0);
    const [wx2, wy2] = at(5, 16, 9);
    stroke(ctx, P.c(C.steelDark), 0.9, wx, wy, wx2, wy2);
    poly(ctx, P.team(0.85), [wx2, wy2, wx2 + 7, wy2 + 1.6, wx2 + 7, wy2 + 4, wx2, wy2 + 4.6]);
    poly(ctx, P.c(PAINT), [wx2 + 3, wy2 + 0.7, wx2 + 5, wy2 + 1.2, wx2 + 5, wy2 + 3.6, wx2 + 3, wy2 + 3.9]);
    sandbags(ctx, P, 6, 48, 2);
  },

  // Airfield 3x2: runway, hangar and control tower.
  AFLD: (ctx, P) => {
    pad(ctx, P, 0, 0, 72, 48, 129);
    // runway
    rect(ctx, P.c('#2e2d2a'), 1, 28, 70, 19);
    rect(ctx, P.c(ASPHALT), 2, 29, 68, 17);
    const rr = rng(130);
    for (let i = 0; i < 40; i++) rect(ctx, P.c(rr() < 0.5 ? '#3b3a36' : '#4d4c46'), 3 + Math.floor(rr() * 64), 30 + Math.floor(rr() * 15), 2, 1);
    rect(ctx, P.c(PAINT), 2, 30, 68, 1);
    rect(ctx, P.c(PAINT), 2, 44, 68, 1);
    for (let x = 12; x < 68; x += 10) rect(ctx, P.c(PAINT), x, 37, 6, 1.5);
    for (let y = 32; y < 43; y += 3) rect(ctx, P.c(PAINT), 3, y, 4, 1.6);
    rect(ctx, P.c('#2c2b28'), 40, 33, 14, 1);
    rect(ctx, P.c('#2c2b28'), 40, 41, 14, 1);
    for (let x = 4; x < 70; x += 8) {
      circle(ctx, P.c(C.yellow), x, 28.5, 0.9);
      circle(ctx, P.c(C.yellow), x, 46, 0.9);
    }
    castShadows(ctx, P, [{ x: 3, y: 12, w: 34, d: 14, z: 8 }, { x: 52, y: 17, w: 9, d: 7, z: 13 }, { cx: 44, cy: 20, r: 3.6, z: 6 }]);
    // hangar
    const H = box(ctx, P, 3, 12, 34, 14, 8, WALL, K('#8a9096'));
    vault(ctx, P, H, 3.6, T(0.64), { bands: 6, rib: 11, end: T(0.4) });
    band(ctx, P, H, T(0.5), 5.4, 7.2);
    door(ctx, P, H, 9, 16, 5.2, 1.8);
    wins(ctx, P, H, 2, 2.4, 1, 3, 2.4, 1);
    roofFan(ctx, P, H, 30, 3.6, 1.6);
    // control tower: shaft, glazed cab, dish
    const S = box(ctx, P, 53, 17, 8, 7, 10, K('#aaa79a'), K('#b8b5a8'), { panel: 4 });
    const Cb = box(ctx, P, 51, 16, 12, 9, 4, K(GLASS_DK), K('#c0c4c8'), { z0: 10 });
    patch(ctx, grad(ctx, P, K(GLASS), 0, Cb.front(0, 4)[1], 0, Cb.front(0, 0)[1], [[0, 0.5], [1, -0.1]]), Cb, 'front', 0.8, 0.7, 11.2, 3.2);
    for (const u of [4, 8]) mark(ctx, P.c(C.steelDark), 0.5, Cb, 'front', u, 0.7, u, 3.2);
    patch(ctx, P.team(0.7), Cb, 'roof', 0, 7.4, 12, 9);
    // the tower's turning dish is animated (art/animated.js)
    // fuel tank and windsock
    cylinder(ctx, P, 44, 20, 3.6, 6, K('#b8442e'), K('#c9c6bb'));
    const [wx, wy] = at(67, 34, 0);
    const [wx2, wy2] = at(67, 34, 8);
    stroke(ctx, P.c(C.steelDark), 0.9, wx, wy, wx2, wy2);
    poly(ctx, P.team(0.85), [wx2, wy2, wx2 - 6, wy2 + 1.4, wx2 - 6, wy2 + 3.6, wx2, wy2 + 4.8]);
    // the beacon at (68, 6) and the runway light chase are animated (art/animated.js)
    sandbags(ctx, P, 28, 25.6, 3);
  },

  // Allied tech center 2x3: laboratory with an observatory dome and a big dish.
  ATEK: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 121);
    castShadows(ctx, P, [{ x: 3, y: 28, w: 40, d: 20, z: 10 }]);
    const H = box(ctx, P, 3, 28, 40, 20, 10, K('#b6b3a6'), K('#c4c1b4'), { panel: 8 });
    seams(ctx, P, H, K('#c4c1b4'), 1, 1, 39, 19, 5, 2);
    // glass curtain wall in a team frame
    patch(ctx, P.team(0.62), H, 'front', 1.4, 1, 38.6, 8.4);
    wins(ctx, P, H, 2.4, 2.2, 6, 4.4, 4.6, 1.4);
    band(ctx, P, H, T(0.66), 8.4, 9.8);
    // rooftop: observatory dome, radio dish, machinery
    roofShadows(ctx, P, H, [{ cx: 14, cy: 38, r: 8, z: 9 }, { x: H.x + 30, y: H.y + 12, w: 6, d: 4, z: 4 }]);
    dome(ctx, P, 14, 37, 8, K('#c4c9ce'), { z0: 10 });
    const [sx, sy] = at(14, 37, 10 + 4);
    stroke(ctx, P.c('#1f2a30'), 1.8, sx - 0.5, sy - 7, sx - 0.5, sy + 2);
    ctx.save();
    ctx.strokeStyle = P.c(C.steelDark);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(sx, sy + 1, 7.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    box(ctx, P, 33, 40, 7, 4, 3, STEEL, STEEL_L, { z0: 10 });
    // the turning dish and the blinking lamps at (5, 50) and (41, 50) are animated (art/animated.js)
    sandbags(ctx, P, 4, 47.6, 2);
    sandbags(ctx, P, 33, 47.6, 2);
  },

  // Soviet tech center 3x3: reactor spheres around a central laboratory.
  STEK: (ctx, P) => {
    apron(ctx, P, 0, 48, 72, 24, 131);
    castShadows(ctx, P, [
      { x: 3, y: 32, w: 66, d: 16, z: 8 },
      { x: 22, y: 26, w: 26, d: 16, z: 18 },
      { cx: 11, cy: 34, r: 7, z: 14 },
      { cx: 61, cy: 34, r: 7, z: 14 },
    ]);
    // reactor spheres on short pedestals
    for (const x of [11, 61]) {
      cylinder(ctx, P, x, 34, 4.4, 4, K('#6b6f74'), K('#80858b'));
      dome(ctx, P, x, 34, 6.6, K('#9aa3ab'), { z0: 3, full: true });
      const [sx, sy] = at(x, 34, 3 + 6.6);
      ring(ctx, P.team(0.55), sx, sy + 0.4, 6.3, 1);
      disc(ctx, P.c('#7fc4ff'), sx + 1.6, sy + 1.4, 1.5);
    }
    const H = box(ctx, P, 3, 32, 66, 16, 8, K('#8a8579'), K('#9a968a'), { panel: 8 });
    band(ctx, P, H, T(0.5), 5.4, 7);
    wins(ctx, P, H, 5, 1.8, 3, 3.6, 2.4, 1.8, true);
    wins(ctx, P, H, 47, 1.8, 3, 3.6, 2.4, 1.8, true);
    // central laboratory with a team roof
    const L = box(ctx, P, 22, 26, 26, 16, 18, K('#6f6a60'), T(0.74), { panel: 6.5 });
    seams(ctx, P, L, T(0.74), 1, 1, 25, 15, 4, 2);
    band(ctx, P, L, T(0.5), 13.5, 15.5);
    wins(ctx, P, L, 3, 3.4, 3, 4.4, 4.4, 1.8);
    door(ctx, P, L, 8, 10, 3);
    // the turning dish is animated (art/animated.js)
    roofVents(ctx, P, L, 3, 3, 4, 2, 2.4, 1.2);
    // conduits from the spheres to the lab
    pipe(ctx, P, [...at(17, 37, 6), ...at(22, 38, 6)], 1.4, K(C.steel));
    pipe(ctx, P, [...at(55, 37, 6), ...at(48, 38, 6)], 1.4, K(C.steel));
    // mast lamps blink (art/animated.js)
    mast(ctx, P, 4, 46, 9, null);
    mast(ctx, P, 68, 46, 9, null);
    sandbags(ctx, P, 6, 48, 3);
    sandbags(ctx, P, 50, 48, 3);
  },

  // Kennel 1x1: a small wooden hut.
  KENN: (ctx, P) => {
    castShadows(ctx, P, [{ x: 2, y: 11, w: 19, d: 11, z: 7 }]);
    const H = box(ctx, P, 2, 11, 19, 11, 7, K('#7a5a30'), K('#7a5a30'));
    for (let u = 3; u < 19; u += 3) mark(ctx, P.c('#4a3419'), 0.6, H, 'front', u, 0, u, 7);
    gable(ctx, P, H, 5.4, T(0.62), { axis: 'x', seams: 7, overhang: 1, end: K('#6b4d28') });
    // dog door, bone sign and bowl
    patch(ctx, P.c(C.track), H, 'front', 6.5, 0, 11, 4.2);
    const [bx, by] = H.front(15, 5);
    rect(ctx, P.c(PAINT), bx - 2, by - 0.5, 4, 1);
    circle(ctx, P.c(PAINT), bx - 2.2, by - 0.9, 0.8);
    circle(ctx, P.c(PAINT), bx + 2.2, by - 0.9, 0.8);
    oval(ctx, P.c('#6d6a5a'), 19, 22.8, 2.2, 1);
    oval(ctx, P.c('#c8c0a8'), 18.9, 22.5, 1.7, 0.7);
  },

  // Naval yard 3x3: a U-shaped dock around open water (the water stays clear).
  SYRD: (ctx, P) => {
    const areas = [[0, 0, 72, 26], [0, 24, 14, 48], [58, 24, 14, 48]];
    areas.forEach(([x, y, w, h], i) => pad(ctx, P, x, y, w, h, 140 + i));
    // quay edge toward the water: dark rim, lit cap, rubber fenders
    rect(ctx, P.c(C.concreteDark), 14, 24, 44, 2);
    rect(ctx, P.c(C.steelDark), 14, 25, 44, 1);
    for (let x = 17; x < 56; x += 7) rect(ctx, P.c('#1f2022'), x, 24, 4, 3);
    rect(ctx, P.c(C.steelDark), 13, 26, 1, 46);
    rect(ctx, P.c(C.steelDark), 58, 26, 1, 46);
    for (let y = 30; y < 70; y += 8) {
      rect(ctx, P.c('#1f2022'), 12, y, 3, 4);
      rect(ctx, P.c('#1f2022'), 57, y, 3, 4);
    }
    castShadows(ctx, P, [
      { x: 16, y: 10, w: 40, d: 14, z: 9 },
      { x: 58, y: 42, w: 8, d: 8, z: 13 },
      { cx: 7, cy: 42, r: 4.4, z: 7 },
    ]);
    // warehouse
    const W = box(ctx, P, 16, 10, 40, 14, 9, WALL, K('#8a9096'), { panel: 8 });
    seams(ctx, P, W, K('#8a9096'), 1, 1, 39, 13, 6, 1);
    patch(ctx, P.team(0.62), W, 'roof', 1, 1, 39, 5);
    band(ctx, P, W, T(0.6), 6.4, 8);
    door(ctx, P, W, 13, 14, 5.4, 1.8);
    wins(ctx, P, W, 3, 2, 2, 3.4, 2.6, 1.8);
    wins(ctx, P, W, 28, 2, 2, 3.4, 2.6, 1.8);
    // gantry crane on the right pier
    const Tw = box(ctx, P, 58, 42, 8, 8, 13, K('#c9a02e'), K('#e0b840'));
    for (let v = 1; v < 12; v += 4) {
      mark(ctx, P.c(C.yellowDark), 0.7, Tw, 'front', 0.4, v, 7.6, v + 4);
      mark(ctx, P.c(C.yellowDark), 0.7, Tw, 'front', 7.6, v, 0.4, v + 4);
    }
    box(ctx, P, 56, 41, 10, 10, 3.6, STEEL_D, STEEL_L, { z0: 13 });
    box(ctx, P, 28, 44, 30, 2.6, 2, YEL, K('#e8c850'), { z0: 14.6 });
    const [c0x, c0y] = at(32, 45.3, 14.6);
    const [c1x, c1y] = at(32, 45.3, 7);
    stroke(ctx, P.c(C.steelDark), 0.5, c0x, c0y, c1x, c1y);
    box(ctx, P, 30.8, 44.5, 2.4, 1.8, 1.8, STEEL_D, STEEL, { z0: 5.4 });
    // left pier: fuel tank, crates, mast
    cylinder(ctx, P, 7, 42, 4.4, 7, K('#b8442e'), K('#c9c6bb'));
    crateAt(ctx, P, 3, 56, 4.4);
    crateAt(ctx, P, 8, 60, 4);
    mast(ctx, P, 7, 31, 7);
    for (const [x, y] of [[7, 69], [65, 69]]) teamLamp(ctx, P, x, y, 1.6);
    hazard(ctx, P, 1, 70, 12, 1.6, 1.8);
    hazard(ctx, P, 59, 70, 12, 1.6, 1.8);
  },

  // Sub pen 3x3: a roofed concrete pen opening onto the water.
  SPEN: (ctx, P) => {
    pad(ctx, P, 2, 2, 68, 68, 150);
    // water inside the bay, rippled and darker toward the pen
    rect(ctx, P.c(WATER), 24, 42, 24, 28);
    rect(ctx, P.c('#16282f'), 24, 42, 24, 5);
    for (let y = 49; y < 70; y += 5) {
      rect(ctx, P.c('#2b4756'), 27, y, 7, 1);
      rect(ctx, P.c('#2b4756'), 37, y + 2, 7, 1);
    }
    for (const x of [21, 48]) {
      rect(ctx, P.c(C.concreteDark), x, 42, 3, 28);
      rect(ctx, P.c(C.concreteLight), x, 42, 1, 28);
      rect(ctx, P.c(C.seam), x + 2, 42, 1, 28);
    }
    for (let y = 46; y < 70; y += 8) {
      circle(ctx, P.c(C.steelDark), 22.5, y, 1.1);
      circle(ctx, P.c(C.steelDark), 49.5, y, 1.1);
    }
    castShadows(ctx, P, [{ x: 8, y: 14, w: 56, d: 28, z: 10 }]);
    const H = box(ctx, P, 8, 14, 56, 28, 10, K('#8e8b7e'), K('#8a9096'), { panel: 8 });
    vault(ctx, P, H, 5, T(0.62), { bands: 10, rib: 11, end: T(0.34) });
    band(ctx, P, H, T(0.34), 8, 9.6);
    // pen mouth: dark opening with a gate rim and hazard sill
    patch(ctx, P.c(C.yellowDark), H, 'front', 14.5, 0, 41.5, 8);
    patch(ctx, P.c(C.track), H, 'front', 16, 0, 40, 7);
    patch(ctx, grad(ctx, P, K('#1a2a30'), 0, H.front(0, 7)[1], 0, H.front(0, 0)[1], [[0, -0.3], [1, 0.1]]), H, 'front', 16, 0, 40, 7);
    for (const x of [13, 41.5]) {
      box(ctx, P, 8 + x - 1, 40, 3, 3, 9, K(C.concrete), K(C.concreteLight));
    }
    roofFan(ctx, P, H, 6, 5, 2.4);
    roofFan(ctx, P, H, 50, 5, 2.4);
    mast(ctx, P, 34, 18, 8);
    for (const x of [13, 59]) teamLamp(ctx, P, x, 62, 1.6);
  },

  // Silo 1x1: ore storage tank.
  SILO: (ctx, P) => {
    castShadows(ctx, P, [{ cx: 11, cy: 16.4, r: 7.2, z: 9 }]);
    cylinder(ctx, P, 11, 16.4, 7.2, 9, K('#a9a698'), K('#b8b5a7'), { bands: [[4.4, 6.4, T(0.62)]] });
    const [lx, ly] = at(11, 16.4, 9);
    disc(ctx, P.c(C.concreteDark), lx, ly, 4.9);
    disc(ctx, radial(ctx, P, K(C.ore), lx - 2, ly - 2, 0, lx, ly, 6, [[0, 0.4], [1, -0.3]]), lx, ly + 0.3, 4.2);
    for (const [dx, dy, r] of [[-1.4, -1, 1.1], [1.4, -1.4, 1.2], [0.4, 1.2, 1.1], [-2.2, 0.9, 0.9]]) disc(ctx, P.c(C.ore), lx + dx, ly + dy, r);
    disc(ctx, P.c('#f2d36a'), lx - 1.6, ly - 1.8, 0.6);
    stroke(ctx, P.c(C.steelDark), 1, 17.4, 15, 18, 21);
  },

  // Sandbags 1x1: three courses of stitched bags, tiling sideways.
  SBAG: (ctx, P) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 24, 24);
    ctx.clip();
    rect(ctx, P.c('rgba(0,0,0,0.32)'), 0, 18.5, 24, 4.5);
    for (let row = 0; row < 3; row++) {
      const off = row % 2 ? 3 : 0;
      const cy = 17.4 - row * 4.6;
      for (let x = -6 + off; x < 26; x += 6) {
        oval(ctx, P.c('#5a5a38'), x + 3.1, cy + 0.9, 3.3, 2.7);
        oval(ctx, grad(ctx, P, K(C.canvas), 0, cy - 2.4, 0, cy + 2.6, [[0, 0.36], [0.5, 0.02], [1, -0.28]]), x + 3, cy, 3.1, 2.5);
        rect(ctx, P.c('#c0c08a'), x + 1.6, cy - 1.7, 2.8, 0.5);
        rect(ctx, P.c('#6a6a42'), x + 3, cy - 1.1, 0.5, 2.4);
      }
    }
    ctx.restore();
  },

  // Wire fence 1x1: posts and diamond mesh (joins neighbours on all four sides).
  FENC: (ctx, P) => {
    const wire = P.c('#b4b4ae');
    const zz = 8;
    const [lx, ly] = [KX * zz, -KY * zz];
    const mesh = (pts) => {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = wire;
      ctx.lineWidth = 0.5;
      for (let d = -30; d < 60; d += 3) {
        ctx.beginPath();
        ctx.moveTo(d, 0);
        ctx.lineTo(d + 30, 30);
        ctx.moveTo(d + 30, 0);
        ctx.lineTo(d, 30);
        ctx.stroke();
      }
      ctx.restore();
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 24, 24);
    ctx.clip();
    // shadows on the ground
    quad(ctx, P.c('rgba(0,0,0,0.26)'), [0, 12, 24, 12, 24 + 5, 12 + 4, 5, 12 + 4]);
    quad(ctx, P.c('rgba(0,0,0,0.26)'), [12, 0, 12 + 5, 4, 12 + 5, 28, 12, 24]);
    // north-south run, seen from the side
    mesh([12, 24, 12 + lx, 24 + ly, 12 + lx, ly, 12, 0]);
    // east-west run
    mesh([0, 13, 24, 13, 24 + lx, 13 + ly, lx, 13 + ly]);
    for (const [x0, y0, x1, y1] of [[0, 13, 24, 13], [lx, 13 + ly, 24 + lx, 13 + ly]]) stroke(ctx, P.c('#d4d4ce'), 0.8, x0, y0, x1, y1);
    stroke(ctx, P.c('#d4d4ce'), 0.8, 12 + lx, ly, 12 + lx, 24 + ly);
    // barbed strand
    polyline(ctx, P.c(C.steelDark), 0.5, [lx, 13 + ly - 0.6, lx + 3, 13 + ly - 1.4, lx + 6, 13 + ly - 0.6, lx + 9, 13 + ly - 1.4, lx + 12, 13 + ly - 0.6, lx + 15, 13 + ly - 1.4, lx + 18, 13 + ly - 0.6, lx + 21, 13 + ly - 1.4, lx + 24, 13 + ly - 0.6]);
    // posts
    for (const [x, y] of [[1.2, 13], [12, 13], [22.8, 13], [12, 2], [12, 23]]) {
      const [px, py] = at(x, y, zz + 0.6);
      stroke(ctx, P.c('#4d3c24'), 1.5, x, y, px, py);
      stroke(ctx, P.c('#a98450'), 0.6, x - 0.4, y, px - 0.4, py);
    }
    ctx.restore();
  },

  // Concrete wall 1x1: a block course with a lit cap, tiling sideways.
  BRIK: (ctx, P) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 24, 24);
    ctx.clip();
    rect(ctx, P.c('rgba(0,0,0,0.3)'), 0, 18, 24, 6);
    const W = box(ctx, P, -4, 10, 34, 8, 9, K('#9b988b'), K('#b4b1a4'), { run: true });
    // block joints on the face and on the cap
    for (const v of [3, 6]) mark(ctx, P.c(C.seam), 0.6, W, 'front', 0, v, 34, v);
    for (let r = 0; r < 3; r++) {
      for (let u = (r % 2) * 4; u < 34; u += 8) mark(ctx, P.c(C.seam), 0.6, W, 'front', u, r * 3, u, r * 3 + 3);
    }
    for (let u = 3; u < 34; u += 8) mark(ctx, P.c(C.seam), 0.6, W, 'roof', u, 0, u, 8);
    mark(ctx, P.c('#c8c5b8'), 0.5, W, 'front', 0, 8.6, 34, 8.6);
    ctx.restore();
  },

  // Pillbox 1x1: domed concrete bunker.
  PBOX: (ctx, P) => {
    castShadows(ctx, P, [{ cx: 12, cy: 14.6, r: 9.4, z: 5.5 }]);
    prism(ctx, P, 12, 14.6, 9.4, 8, 5.5, K('#9b988b'), K('#aaa79a'), { seam: true });
    // firing slits with a lit lower lip
    const slit = (x, y, w, z0, z1) => quad(ctx, P.c(C.track), [...at(x, y, z0), ...at(x + w, y, z0), ...at(x + w, y, z1), ...at(x, y, z1)]);
    slit(8.8, 23.7, 6.4, 2.4, 3.9);
    // team plate with a hatch on the roof
    const [lx, ly] = at(12, 14.6, 5.5);
    disc(ctx, P.c(C.steelDark), lx, ly, 3.6);
    disc(ctx, grad(ctx, P, T(0.62), lx - 3, ly - 3, lx + 3, ly + 3, [[0, 0.3], [1, -0.2]]), lx, ly, 3);
    ring(ctx, P.team(0.4), lx, ly, 1.8, 0.5);
    disc(ctx, P.team(0.95), lx - 0.9, ly - 0.9, 0.9);
    sandbags(ctx, P, 3, 20.6, 4);
  },

  // Camo pillbox 1x1: netted bunker hidden in foliage.
  HBOX: (ctx, P) => {
    castShadows(ctx, P, [{ cx: 12, cy: 14.6, r: 9.4, z: 5.5 }]);
    prism(ctx, P, 12, 14.6, 9.4, 8, 5.5, K('#4f6b2f'), K('#5c7a36'), { seam: true });
    const [lx, ly] = at(12, 14.6, 5.5);
    const r = rng(160);
    for (let i = 0; i < 28; i++) {
      const a = r() * Math.PI * 2;
      const d = r() * 9;
      circle(ctx, P.c(['#668a3a', '#587a30', '#3e5426', '#7a9a4c'][i % 4]), lx + Math.cos(a) * d, ly + 2 + Math.sin(a) * d * 0.9, 1.2 + r() * 1.8);
    }
    for (const [x, y] of [[-6, 2], [1, 1], [5, -1], [-3, -4], [3, 5]]) poly(ctx, P.c('#8aae56'), [lx + x, ly + y, lx + x + 1, ly + y - 3, lx + x + 2, ly + y]);
    polyline(ctx, P.c('#33481e'), 0.4, [lx - 8, ly - 4, lx + 8, ly + 4]);
    polyline(ctx, P.c('#33481e'), 0.4, [lx - 8, ly + 4, lx + 8, ly - 4]);
    patch(ctx, P.c(C.track), { front: (u, v) => at(u, 23.9, v) }, 'front', 8.8, 2.4, 15.2, 3.9);
    circle(ctx, P.team(0.7), lx + 6, ly + 6, 1.4);
    circle(ctx, P.team(1.0), lx + 5.6, ly + 5.6, 0.6);
  },

  // Flame tower 1x1: round bunker with a fuel tank and a nozzle.
  FTUR: (ctx, P) => {
    castShadows(ctx, P, [{ cx: 12, cy: 15, r: 9.4, z: 6 }]);
    cylinder(ctx, P, 12, 15, 9.4, 6, K('#9b988b'), K('#aaa79a'), { bands: [[3, 4.6, T(0.62)]] });
    const [lx, ly] = at(12, 15, 6);
    // fuel tank on the lid
    disc(ctx, P.c(C.steelDark), lx, ly, 4.4);
    disc(ctx, radial(ctx, P, K(C.yellow), lx - 1.5, ly - 1.5, 0, lx, ly, 4, [[0, 0.5], [1, -0.3]]), lx, ly, 3.6);
    disc(ctx, P.c(C.steelDark), lx, ly, 1);
    // nozzle with a pilot flame
    pipe(ctx, P, [lx, ly - 3, lx, ly - 6.5], 1.4, K(C.steel));
    rect(ctx, P.c(C.steelDark), lx - 1.5, 1, 3, 4.6);
    rect(ctx, P.c(C.steelLight), lx - 1.4, 1, 0.8, 4.6);
    circle(ctx, P.c('rgba(232,100,28,0.4)'), lx, 1.6, 2);
    circle(ctx, P.c('#e8641c'), lx, 1.6, 1.2);
    circle(ctx, P.c('#ffd070'), lx, 1.8, 0.6);
    hazard(ctx, P, 16, 18, 4, 3, 1.4);
    teamLamp(ctx, P, 5, 19, 1.1);
  },

  // Turret 1x1: a gun emplacement (the gun itself is the turret sprite).
  GUN: (ctx, P) => {
    castShadows(ctx, P, [{ cx: 12, cy: 14, r: 10.6, z: 3.4 }]);
    prism(ctx, P, 12, 14, 10.6, 8, 3.4, K('#9b988b'), K('#aaa79a'), { seam: true });
    const [lx, ly] = at(12, 14, 3.4);
    disc(ctx, P.c(C.steelDark), lx, ly, 8);
    disc(ctx, P.c(C.steel), lx, ly, 7.2);
    disc(ctx, P.c(C.steelDark), lx, ly, 6.2);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      circle(ctx, P.c(C.steelLight), lx + Math.cos(a) * 7.1, ly + Math.sin(a) * 7.1, 0.4);
    }
    for (const [x, y] of [[3.5, 5], [20.5, 5], [3.5, 19.5], [20.5, 19.5]]) {
      circle(ctx, P.team(0.6), x, y, 1.6);
      circle(ctx, P.team(0.9), x - 0.4, y - 0.4, 0.6);
    }
    sandbags(ctx, P, 2, 20.6, 4);
  },

  // Tesla coil 1x1: copper-wound column on a base.
  TSLA: (ctx, P) => {
    castShadows(ctx, P, [{ x: 3, y: 15, w: 18, d: 8, z: 4 }, { cx: 11, cy: 19, r: 2.8, z: 15 }]);
    const B = box(ctx, P, 3, 15, 18, 8, 4, K('#9b988b'), K('#aaa79a'));
    band(ctx, P, B, T(0.62), 1.4, 3);
    box(ctx, P, 1.5, 16, 3.5, 5, 5, STEEL_D, STEEL_L);
    box(ctx, P, 19, 16, 3.5, 5, 5, STEEL_D, STEEL_L);
    // the column: copper windings over a steel core
    const bands = [];
    for (let v = 0.8; v < 10.6; v += 2) bands.push([v, v + 1.2, K(COPPER)]);
    cylinder(ctx, P, 11, 19, 2.8, 11, K('#5a4a3a'), STEEL, { z0: 4, bands });
    const [hx, hy] = at(11, 19, 15 + 0.6);
    teslaHead(ctx, P, hx, hy, 3.6);
    lamp(ctx, P, 21.5, 20, '#7fc4ff', 'rgba(110,170,255,0.35)');
  },

  // AA gun 1x1: a hexagonal sandbagged platform (the gun is the turret sprite).
  AGUN: (ctx, P) => {
    castShadows(ctx, P, [{ cx: 12, cy: 14, r: 10.4, z: 3.4 }]);
    prism(ctx, P, 12, 14, 10.4, 6, 3.4, K('#9b988b'), K('#aaa79a'), { rot: 0, seam: true });
    const [lx, ly] = at(12, 14, 3.4);
    disc(ctx, P.c(C.steelDark), lx, ly, 6.8);
    disc(ctx, P.c(C.steel), lx, ly, 6);
    disc(ctx, P.c(C.steelDark), lx, ly, 5.2);
    for (const [x, y] of [[4, 11.4], [20, 11.4]]) {
      rect(ctx, P.c(C.yellowDark), x - 1.4, y - 1.4, 2.8, 2.8);
      rect(ctx, P.c(C.yellow), x - 1.2, y - 1.2, 2.2, 2.2);
    }
    crateAt(ctx, P, 3.4, 17.4, 3.6);
    crateAt(ctx, P, 16, 18, 3.6);
    teamLamp(ctx, P, 12, 3.2, 1);
  },

  // SAM site 2x1: launcher pad with control shed and radar.
  SAM: (ctx, P) => {
    castShadows(ctx, P, [{ x: 2, y: 5, w: 44, d: 16, z: 2 }, { x: 6, y: 8, w: 8, d: 6, z: 6 }]);
    const D = box(ctx, P, 2, 5, 44, 16, 2, K('#8e8b7e'), K('#9b988b'));
    for (const x of [3, 37]) {
      for (let k = 0; k < 6; k++) patch(ctx, P.c(k % 2 ? C.track : C.yellow), D, 'roof', x + k * 1.2, 1.5, x + k * 1.2 + 1.2, 14.5);
    }
    patch(ctx, P.team(0.62), D, 'roof', 11, 0.6, 33, 1.6);
    // launcher well under the turret
    const [wx, wy] = D.roof(22, 8);
    disc(ctx, P.c(C.steelDark), wx, wy, 9);
    disc(ctx, P.c(C.steel), wx, wy, 8.2);
    disc(ctx, P.c(C.track), wx, wy, 7.2);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      circle(ctx, P.c(C.steelLight), wx + Math.cos(a) * 8.2, wy + Math.sin(a) * 8.2, 0.4);
    }
    // control shed and radar
    const S = box(ctx, P, 6, 8, 8, 6, 5, STEEL_L, K('#a9b0b6'), { z0: 2 });
    patch(ctx, P.c(GLASS), S, 'front', 1.2, 1.6, 4, 3.6);
    band(ctx, P, S, T(0.62), 3.8, 4.8);
    dishAt(ctx, P, 40, 14, 2, 3);
    lamp(ctx, P, 4, 22.4, '#ffb030', 'rgba(255,180,50,0.35)');
    lamp(ctx, P, 44, 22.4, '#ffb030', 'rgba(255,180,50,0.35)');
  },

  // Gap generator 1x1: a mast with an emitter array.
  GAP: (ctx, P) => {
    castShadows(ctx, P, [{ x: 4, y: 15, w: 16, d: 8, z: 4 }, { cx: 12, cy: 19, r: 1.5, z: 15 }]);
    const B = box(ctx, P, 4, 15, 16, 8, 4, K('#9b988b'), K('#aaa79a'));
    band(ctx, P, B, T(0.6), 1.2, 2.8);
    for (let i = 0; i < 4; i++) patch(ctx, P.c('#1f2022'), B, 'roof', 1.4 + i * 3.6, 2, 3.6 + i * 3.6, 5.6);
    // lattice mast
    cylinder(ctx, P, 12, 19, 1.5, 7, K('#5a5d62'), STEEL_L, { z0: 4 });
    const [ax, ay] = at(12, 19, 11);
    // emitter array and orb
    rect(ctx, P.c(C.steelDark), ax - 8, ay - 4.5, 16, 3);
    rect(ctx, P.c(C.steelLight), ax - 7.6, ay - 4.2, 15.2, 1);
    dome(ctx, P, 12, 19, 3.8, K('#6a64a8'), { z0: 11, full: true });
    disc(ctx, P.c('#d8d4ff'), ax - 1.4, ay - 4.8, 0.6);
    teamLamp(ctx, P, ax - 8, ay - 3, 1.1);
    teamLamp(ctx, P, ax + 8, ay - 3, 1.1);
  },

  // Chronosphere 2x2: gyroscope sphere on a pylon platform.
  PDOX: (ctx, P) => {
    castShadows(ctx, P, [
      { x: 2, y: 20, w: 42, d: 25, z: 4 },
      { x: 4, y: 20, w: 5, d: 5, z: 12 },
      { x: 37, y: 20, w: 5, d: 5, z: 12 },
      { cx: 23, cy: 31, r: 9, z: 9 },
    ]);
    const D = box(ctx, P, 2, 20, 42, 25, 4, K('#908d80'), K('#a29f92'), { panel: 7 });
    seams(ctx, P, D, K('#a29f92'), 1, 1, 41, 24, 4, 3);
    // pylons with team caps
    for (const [x, y] of [[4, 21], [38, 21], [4, 35], [38, 35]]) {
      const Pl = box(ctx, P, x, y, 5, 5, 7, K('#6c7076'), T(0.68), { z0: 4 });
      patch(ctx, P.team(1.0), Pl, 'roof', 1.6, 1.6, 3.4, 3.4);
    }
    for (const [x, y] of [[7, 24], [41, 24], [7, 38], [41, 38]]) {
      pipe(ctx, P, [...at(x, y, 6), ...at(23.5, 30, 6.5)], 1.2, K(C.steel));
    }
    // the sphere with its rings and glowing core
    const cx = 23.5;
    const cy = 32;
    const [sx, sy] = at(cx, cy, 4 + 9);
    dome(ctx, P, cx, cy, 9, K('#23363f'), { z0: 4, full: true });
    ctx.save();
    ctx.translate(sx, sy);
    for (const a of [0.2, Math.PI / 3 + 0.2, -Math.PI / 3 + 0.2]) {
      ctx.save();
      ctx.rotate(a);
      ctx.scale(1, 0.36);
      ring(ctx, P.c(C.steelDark), 0, 0, 9.4, 2.4);
      ring(ctx, P.c(C.steelLight), 0, 0, 9.4, 1.5);
      ring(ctx, P.c('#c4c7cb'), 0, -0.3, 9.4, 0.6);
      ctx.restore();
    }
    ctx.restore();
    disc(ctx, P.c('rgba(90,220,240,0.45)'), sx, sy, 5.8);
    disc(ctx, P.c('#3cb8cc'), sx, sy, 4.3);
    disc(ctx, P.c('#5fd8ea'), sx - 0.4, sy - 0.4, 3.5);
    disc(ctx, P.c('#e4fbff'), sx - 1.6, sy - 1.6, 1.4);
    lamp(ctx, P, 24, 46, '#5fd8ea', 'rgba(90,200,240,0.35)');
  },

  // Iron curtain 2x2: open pad in front, projector building behind.
  IRON: (ctx, P) => {
    pad(ctx, P, 0, 0, 48, 24, 180);
    rect(ctx, P.c(C.yellow), 6, 3, 36, 1.4);
    circle(ctx, P.c(C.yellowDark), 24, 11, 6.8);
    circle(ctx, P.c(C.concrete), 24, 11, 5.6);
    ring(ctx, P.c(C.steelDark), 24, 11, 3, 0.7);
    castShadows(ctx, P, [{ x: 2, y: 24, w: 42, d: 21, z: 10 }, { cx: 20, cy: 33, r: 4.4, z: 6 }]);
    const H = box(ctx, P, 2, 24, 42, 21, 10, K('#8a8579'), K('#9a968a'), { panel: 8 });
    // curtain folds on the face
    for (let i = 0; i < 10; i++) patch(ctx, P.team(i % 2 ? 0.44 : 0.7), H, 'front', 1.4 + i * 3.96, 1.5, 1.4 + (i + 1) * 3.96, 8.4);
    patch(ctx, P.team(0.95), H, 'front', 1.4, 8.4, 41, 9.4);
    door(ctx, P, H, 17, 8, 5.4);
    // projector head on the roof
    const [px, py] = H.roof(19, 9);
    cylinder(ctx, P, H.x + 19, H.y + 9, 4.4, 5, K('#5c5f64'), STEEL_L, { z0: 10 });
    const [lx, ly] = at(H.x + 19, H.y + 9, 15);
    disc(ctx, P.c(C.steelDark), lx, ly, 3.4);
    disc(ctx, P.c('rgba(194,58,38,0.45)'), lx, ly, 3.3);
    disc(ctx, P.c(RED), lx, ly, 2.3);
    disc(ctx, P.c('#ff9a80'), lx - 0.6, ly - 0.6, 0.9);
    // front insulators
    for (const x of [6, 40]) {
      cylinder(ctx, P, x, 44, 1.8, 6, K('#6a6e74'), STEEL_L, { bands: [[1.2, 1.8, STEEL_D], [3, 3.6, STEEL_D], [4.8, 5.4, STEEL_D]] });
    }
    mast(ctx, P, 45, 30, 5);
  },

  // Missile silo 2x1: hardened hatch with hazard framing.
  MSLO: (ctx, P) => {
    castShadows(ctx, P, [{ x: 1, y: 3, w: 44, d: 17, z: 3.4 }, { x: 2, y: 5.5, w: 4, d: 4, z: 5 }, { x: 40, y: 5.5, w: 4, d: 4, z: 5 }]);
    const D = box(ctx, P, 1, 3, 44, 17, 3.4, K('#8e8b7e'), K('#9b988b'));
    band(ctx, P, D, T(0.5), 0.6, 1.4);
    // hazard frame around the hatch
    for (let k = 0; k < 28; k++) patch(ctx, P.c(k % 2 ? C.track : C.yellow), D, 'roof', 6 + k * 1.2, 1, 7.2 + k * 1.2, 16);
    siloHatch(ctx, P, 0);
    // team pylons and warning lights
    for (const x of [2, 40]) {
      const Pl = box(ctx, P, x, 5.5, 4, 4, 5, K('#6c7076'), T(0.68));
      patch(ctx, P.team(1.0), Pl, 'roof', 1, 1, 3, 3);
    }
    lamp(ctx, P, 6.5, 21.6, '#ff4a3a', 'rgba(255,90,70,0.35)');
    lamp(ctx, P, 41.5, 21.6, '#ff4a3a', 'rgba(255,90,70,0.35)');
  },
};

/** The missile silo's roof (MSLO: box at (1, 3), 44 x 17, 3.4 high). */
const SILO_ROOF = { roof: (u, t) => at(1 + u, 3 + t, 3.4) };

/**
 * The missile silo's armoured hatch, `open` from 0 (shut: two ribbed doors
 * with the warning seam and trefoil over the middle) to 1 (both doors slid
 * under the hazard frame, the dark shaft between them). The structure draws
 * it shut; WebRA's launch layer (art/animated.js BUILDING_WORKING) draws it
 * opening and closing over the structure when the atom bomb leaves.
 */
export function siloHatch(ctx, P, open) {
  const D = SILO_ROOF;
  if (open > 0) {
    // The shaft: dark, its north wall lit a little.
    patch(ctx, P.c('#141210'), D, 'roof', 8, 2.2, 35.8, 15);
    patch(ctx, P.c('#2c2722'), D, 'roof', 8, 2.2, 35.8, 4.2);
  }
  // The doors slide apart under the frame: each keeps its outer part.
  const width = 13 * (1 - open);
  for (const [u0, u1] of [[8, 8 + width], [35.8 - width, 35.8]]) {
    if (u1 - u0 < 0.2) continue;
    patch(ctx, P.c(C.steelDark), D, 'roof', u0, 2.2, u1, 15);
    patch(ctx, grad(ctx, P, K(C.steel), 0, D.roof(0, 2.6)[1], 0, D.roof(0, 14.6)[1], [[0, 0.28], [1, -0.12]]), D, 'roof', u0 + 0.4, 2.6, u1 - 0.4, 14.6);
    for (let u = u0 + 3.45; u < u1 - 0.6; u += 3.05) mark(ctx, P.c('#46484c'), 0.6, D, 'roof', u, 3.4, u, 13.8);
  }
  if (open > 0) return;
  patch(ctx, P.c('#3b1a12'), D, 'roof', 20.7, 2.4, 22.3, 14.8);
  patch(ctx, P.c('#e8641c'), D, 'roof', 21.2, 4, 21.8, 13);
  const [tx, ty] = D.roof(21.5, 8.4);
  trefoil(ctx, P, tx, ty, 3.8);
}

/** Building turrets, centred on the building centre and facing north. */
export const BUILDING_TURRET = {
  GUN: [24, 24, (ctx, P) => {
    barrel(ctx, P, 11, 0, 9, 2);
    rect(ctx, P.c(C.steelLight), 11, 2, 0.6, 7);
    drum(ctx, P, 12, 12, 5.5);
    circle(ctx, P.c(C.steelDark), 13.6, 13.4, 1.2);
  }],
  AGUN: [24, 24, (ctx, P) => {
    barrel(ctx, P, 8.5, 0, 10, 1.5);
    barrel(ctx, P, 14, 0, 10, 1.5);
    rect(ctx, P.c(C.steelLight), 8.5, 2, 0.5, 8);
    rect(ctx, P.c(C.steelLight), 14, 2, 0.5, 8);
    rrect2(ctx, P.c(C.steelDark), 6, 8, 12, 10, 2);
    rrect2(ctx, P.team(0.8), 7, 9, 10, 8, 1.5);
    rect(ctx, P.team(1.0), 8, 10, 3, 1.5);
    rect(ctx, P.team(0.5), 7, 16, 10, 1);
    rect(ctx, P.c(C.glass), 10.5, 13.5, 3, 1.5);
  }],
  SAM: [24, 24, (ctx, P) => {
    rrect2(ctx, P.c(C.steelDark), 6, 9, 12, 10, 2);
    rrect2(ctx, P.team(0.78), 7, 10, 10, 8, 1.5);
    rect(ctx, P.team(1.0), 8, 11, 3, 1.2);
    for (const x of [7.5, 13.5]) {
      rect(ctx, P.c(C.steel), x - 0.5, 3, 4, 13); // rail
      rrect2(ctx, P.c(PAINT), x, 2, 3, 13, 1.2);
      rect(ctx, P.c('#b8b6ac'), x + 2, 4, 1, 10);
      rect(ctx, P.c(C.concreteLight), x, 3, 0.6, 11);
      poly(ctx, P.c(RED), [x, 3.5, x + 1.5, 0.5, x + 3, 3.5]);
    }
  }],
};

function rrect2(ctx, fill, x, y, w, h, r) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}
