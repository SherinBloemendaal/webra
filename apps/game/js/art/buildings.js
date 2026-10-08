// Procedural art for every structure (Allied and Soviet), in the 1996 Red Alert
// look: top-down 3/4 view, light from the top-left, cast shadows to the
// bottom-right, concrete pads (bibs) in front of the doors, and team colour on
// roofs, trim and lights through the shared mask (see sprites.js).
//
// Every draw function takes (ctx, P) and paints into a box of footprint cells
// times 24 world pixels. Everything is deterministic (seeded noise, no
// Math.random) and cheap: the atlas draws each sprite exactly once.
//
// Colours are "specs": T(level) is a team-colour grey level, K(hex) a fixed
// colour. A shade argument in [-1, 1] darkens or lightens either kind, which
// keeps the team mask intact (a darker team grey is still fully masked).

import { C, rect, circle, poly, polyline, ring, ngon, hazard, trefoil, barrel, drum, teslaHead, dish } from './kit.js';

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

// ---- Spec helpers --------------------------------------------------------------

const T = (level) => ({ t: level });
const K = (hex) => ({ c: hex });

/** Lighten (d > 0) or darken (d < 0) a #rrggbb colour. */
function tone(hex, d) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(d >= 0 ? v + (255 - v) * d : v * (1 + d)));
  return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Resolve a spec to a fill for the current pass. */
function col(P, s, d = 0) {
  return s.t !== undefined ? P.team(Math.max(0, Math.min(1, s.t + d * 0.45))) : P.c(tone(s.c, d));
}

const fr = (ctx, P, s, x, y, w, h, d = 0) => rect(ctx, col(P, s, d), x, y, w, h);
const fc = (ctx, P, s, x, y, r, d = 0) => circle(ctx, col(P, s, d), x, y, r);
const fp = (ctx, P, s, pts, d = 0) => poly(ctx, col(P, s, d), pts);

/** Seeded pseudo random numbers in [0, 1). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function ell(ctx, fill, cx, cy, rx, ry) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

const fe = (ctx, P, s, cx, cy, rx, ry, d = 0) => ell(ctx, col(P, s, d), cx, cy, rx, ry);

/**
 * One translucent shadow fill from several shapes, so overlaps never darken
 * twice. Shapes: ['r', x, y, w, h], ['e', cx, cy, rx, ry], ['p', [x0, y0, ...]].
 */
function shadow(ctx, P, shapes) {
  ctx.fillStyle = P.c(C.shadow);
  ctx.beginPath();
  for (const [kind, a, b, c, d] of shapes) {
    if (kind === 'r') {
      ctx.rect(a, b, c, d);
    } else if (kind === 'e') {
      ctx.moveTo(a + c, b);
      ctx.ellipse(a, b, c, d, 0, 0, Math.PI * 2);
    } else {
      // Normalise to clockwise so the union never cancels out.
      let area = 0;
      for (let i = 0; i < a.length; i += 2) {
        const j = (i + 2) % a.length;
        area += a[i] * a[j + 1] - a[j] * a[i + 1];
      }
      const n = a.length / 2;
      for (let i = 0; i < n; i++) {
        const k = (area < 0 ? n - 1 - i : i) * 2;
        if (i === 0) ctx.moveTo(a[k], a[k + 1]);
        else ctx.lineTo(a[k], a[k + 1]);
      }
      ctx.closePath();
    }
  }
  ctx.fill();
}

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

// ---- Volumes --------------------------------------------------------------------

/**
 * A building volume in 3/4 view: lit roof on top, the south wall in front, a
 * cast shadow to the bottom-right. (x, y, w, h) covers roof and wall together.
 */
function box(ctx, P, x, y, w, h, top, front, depth = 7, o = {}) {
  const sh = o.sh ?? 3;
  if (o.shadow !== false) rect(ctx, P.c(C.shadow), x + sh, y + sh, w, h);
  const ty = h - depth;
  fr(ctx, P, front, x, y + ty, w, depth);
  fr(ctx, P, front, x, y + ty, 1, depth, 0.2);
  fr(ctx, P, front, x + w - 1, y + ty, 1, depth, -0.25);
  fr(ctx, P, front, x, y + h - 1, w, 1, -0.4);
  fr(ctx, P, front, x, y + ty, w, 1, -0.45); // eave shadow
  fr(ctx, P, top, x, y, w, ty);
  fr(ctx, P, top, x, y, w, 1, 0.3);
  fr(ctx, P, top, x, y, 1, ty, 0.22);
  fr(ctx, P, top, x + w - 1, y + 1, 1, ty - 1, -0.28);
}

/** Seams across a roof: dark groove plus a lit lip below/right of it. */
function panels(ctx, P, s, x, y, w, h, cols, rows) {
  for (let i = 1; i < cols; i++) {
    const px = x + (w * i) / cols;
    fr(ctx, P, s, px, y, 0.8, h, -0.28);
    fr(ctx, P, s, px + 0.8, y, 0.7, h, 0.18);
  }
  for (let j = 1; j < rows; j++) {
    const py = y + (h * j) / rows;
    fr(ctx, P, s, x, py, w, 0.8, -0.28);
    fr(ctx, P, s, x, py + 0.8, w, 0.7, 0.18);
  }
}

/** Upright cylinder (tank, silo, stack): banded side, elliptical lid. */
function cyl(ctx, P, cx, cy, r, h, top, side, o = {}) {
  const ry = o.ry ?? r * 0.55;
  if (o.shadow !== false) {
    shadow(ctx, P, [
      ['r', cx - r + 3, cy + 3, r * 2, h],
      ['e', cx + 3, cy + 3, r, ry],
      ['e', cx + 3, cy + h + 3, r, ry],
    ]);
  }
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx - r, cy + h);
  ctx.ellipse(cx, cy + h, r, ry, 0, Math.PI, 0, true);
  ctx.lineTo(cx + r, cy);
  ctx.closePath();
  ctx.clip();
  const n = 8;
  const step = (r * 2) / n;
  for (let i = 0; i < n; i++) fr(ctx, P, side, cx - r + i * step, cy, step + 0.3, h + ry + 1, 0.28 - (i / (n - 1)) * 0.7);
  for (const [off, bh, s] of o.bands ?? []) {
    for (let i = 0; i < n; i++) fr(ctx, P, s, cx - r + i * step, cy + off, step + 0.3, bh, 0.28 - (i / (n - 1)) * 0.7);
  }
  fr(ctx, P, side, cx - r, cy + h - 1, r * 2, ry + 2, -0.4); // base shade
  ctx.restore();
  fe(ctx, P, top, cx, cy, r, ry, -0.3);
  fe(ctx, P, top, cx, cy, r - 1, ry - 0.8, 0.05);
  fe(ctx, P, top, cx - r * 0.25, cy - ry * 0.25, r * 0.45, ry * 0.4, 0.25);
}

/** Shaded sphere / dome seen from above, light at the top-left. */
function sphere(ctx, P, cx, cy, r, s) {
  for (let k = 0; k < 6; k++) {
    fc(ctx, P, s, cx - k * r * 0.06, cy - k * r * 0.06, r * (1 - k * 0.14), -0.38 + k * 0.12);
  }
  fc(ctx, P, s, cx - r * 0.42, cy - r * 0.42, r * 0.16, 0.7);
}

// ---- Details --------------------------------------------------------------------

function vents(ctx, P, x, y, n, w, h, gap) {
  for (let i = 0; i < n; i++) {
    const vx = x + i * (w + gap);
    rect(ctx, P.c(C.steelDark), vx, y, w, h);
    rect(ctx, P.c(C.steel), vx, y + h - 0.8, w, 0.8);
    if (h >= 3) rect(ctx, P.c('#1f2022'), vx + 0.5, y + 0.5, w - 1, 1);
  }
}

function windows(ctx, P, x, y, n, w, h, gap) {
  for (let i = 0; i < n; i++) {
    const wx = x + i * (w + gap);
    rect(ctx, P.c(GLASS_DK), wx - 0.5, y - 0.5, w + 1, h + 1);
    rect(ctx, P.c(GLASS), wx, y, w, h);
    rect(ctx, P.c(GLASS_HI), wx, y, w, Math.min(1, h / 3));
    rect(ctx, P.c('#8fc0d6'), wx, y, 1, h);
  }
}

/** Open bay: dark interior with horizontal ribs of a roll-up door. */
function bay(ctx, P, x, y, w, h, rib = 2.5) {
  rect(ctx, P.c(C.yellowDark), x - 1, y - 1, w + 2, h + 1);
  rect(ctx, P.c(C.track), x, y, w, h);
  for (let ry = y + 0.5; ry < y + h; ry += rib) {
    rect(ctx, P.c(C.steelDark), x, ry, w, rib * 0.55);
    rect(ctx, P.c('#4a4c50'), x, ry, w, 0.6);
  }
}

function pipe(ctx, P, pts, w = 2, s = K(C.steel)) {
  polyline(ctx, P.c(C.steelDark), w + 1.2, pts);
  polyline(ctx, col(P, s), w, pts);
  polyline(ctx, col(P, s, 0.45), Math.max(0.5, w * 0.3), pts.map((v, i) => v - (i % 2 === 0 ? 0.4 : 0.4)));
}

/** A small lamp with a halo (halos only ever sit over non-team ground). */
function lamp(ctx, P, x, y, bulb = '#ff4a3a', halo = 'rgba(255,90,70,0.35)') {
  circle(ctx, P.c(halo), x, y, 2.4);
  circle(ctx, P.c(C.steelDark), x, y, 1.3);
  circle(ctx, P.c(bulb), x, y, 0.9);
}

function teamLamp(ctx, P, x, y, r = 1.6) {
  circle(ctx, P.c(C.steelDark), x, y, r + 0.7);
  circle(ctx, P.team(0.85), x, y, r);
  circle(ctx, P.team(1.0), x - r * 0.3, y - r * 0.3, r * 0.4);
}

function mast(ctx, P, x, y0, y1) {
  rect(ctx, P.c(C.steelDark), x - 0.5, y0, 1, y1 - y0);
  rect(ctx, P.c(C.steelLight), x - 0.5, y0, 0.5, y1 - y0);
  lamp(ctx, P, x, y0);
}

function fan(ctx, P, cx, cy, r) {
  circle(ctx, P.c(C.steelDark), cx, cy, r);
  circle(ctx, P.c('#1f2022'), cx, cy, r - 1);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.5;
    poly(ctx, P.c(C.steel), [cx, cy, cx + Math.cos(a - 0.35) * (r - 1), cy + Math.sin(a - 0.35) * (r - 1), cx + Math.cos(a + 0.35) * (r - 1), cy + Math.sin(a + 0.35) * (r - 1)]);
  }
  circle(ctx, P.c(C.steelLight), cx, cy, 1);
}

/** Rows of fixed-colour brick for walls. */
function bricks(ctx, P, x, y, w, h, base = BRICK) {
  rect(ctx, P.c(base), x, y, w, h);
  const row = 2.5;
  let i = 0;
  for (let by = y; by < y + h; by += row, i++) {
    rect(ctx, P.c(tone(base, -0.32)), x, by, w, 0.5);
    for (let bx = x + (i % 2 ? 2 : 0); bx < x + w; bx += 4.5) rect(ctx, P.c(tone(base, -0.32)), bx, by, 0.5, Math.min(row, y + h - by));
    rect(ctx, P.c(tone(base, 0.16)), x, by + 0.5, w, 0.4);
  }
}

/** Barrel-vault corrugated roof: bands shade from lit (north) to dark (south). */
function vault(ctx, P, x, y, w, h, s, n = 6) {
  const bh = h / n;
  for (let k = 0; k < n; k++) {
    fr(ctx, P, s, x, y + k * bh, w, bh + 0.2, 0.28 - (k / (n - 1)) * 0.6);
    fr(ctx, P, s, x, y + k * bh, w, 0.6, 0.35 - (k / (n - 1)) * 0.5);
  }
  for (let jx = x + 12; jx < x + w - 2; jx += 12) fr(ctx, P, s, jx, y, 0.7, h, -0.42);
}

function hexToRgbaHalo(alpha) {
  return `rgba(90,200,240,${alpha})`;
}

// ---- Buildings --------------------------------------------------------------------

export const BUILDING_DRAW = {
  // Construction yard 3x4: assembly hall, rooftop plant and a tower crane.
  FACT: (ctx, P) => {
    pad(ctx, P, 0, 0, 72, 72, 11);
    apron(ctx, P, 0, 72, 72, 24, 12);
    for (let x = 2; x < 70; x += 8) rect(ctx, P.c(C.yellow), x, 73.5, 4, 1);
    // main hall
    box(ctx, P, 4, 8, 44, 54, T(0.62), T(0.34), 11);
    panels(ctx, P, T(0.62), 4, 8, 44, 43, 7, 1);
    for (const x of [9, 22, 35]) {
      rect(ctx, P.c(GLASS_DK), x - 0.5, 13.5, 8, 5);
      rect(ctx, P.c(GLASS), x, 14, 7, 4);
      rect(ctx, P.c(GLASS_HI), x, 14, 7, 1);
    }
    box(ctx, P, 9, 28, 12, 10, K(C.concreteLight), K(C.concreteDark), 3, { sh: 2 });
    fan(ctx, P, 15, 31, 3);
    box(ctx, P, 28, 30, 14, 8, K(C.steelLight), K(C.steelDark), 3, { sh: 2 });
    vents(ctx, P, 30, 32, 4, 2, 3, 1.5);
    pipe(ctx, P, [21, 33, 24, 33, 24, 34, 28, 34], 1.6, K(C.steel));
    mast(ctx, P, 44, 10, 20);
    // south wall: workshop door, windows, hazard posts
    bay(ctx, P, 16, 52, 20, 9);
    windows(ctx, P, 6, 54, 2, 3.5, 3, 2);
    windows(ctx, P, 39, 54, 2, 3.5, 3, 2);
    hazard(ctx, P, 13, 52, 2, 9, 1.5);
    hazard(ctx, P, 37, 52, 2, 9, 1.5);
    // tower crane
    shadow(ctx, P, [['p', [55, 56, 70, 56, 72, 22, 64, 14]]]);
    box(ctx, P, 52, 46, 16, 16, K(C.yellow), K(C.yellowDark), 5, { shadow: false });
    fr(ctx, P, K(C.steelDark), 54, 55, 12, 1);
    for (const rx of [57, 63]) {
      polyline(ctx, P.c(C.steelDark), 2.3, [rx, 48, rx + 1.4, 10]);
      polyline(ctx, P.c(C.yellow), 1.2, [rx, 48, rx + 1.4, 10]);
    }
    polyline(ctx, P.c(C.yellowDark), 0.8, [57, 48, 64, 43, 57.3, 38, 64.3, 33, 57.7, 28, 64.6, 23, 58, 18, 64.9, 14]);
    box(ctx, P, 56, 6, 12, 7, K(C.steelDark), K(C.steel), 2, { sh: 2 });
    rect(ctx, P.c(C.yellow), 56, 6, 12, 1.2);
    teamLamp(ctx, P, 62, 8.5, 1.3);
    line1(ctx, P, 66, 12, 66, 31);
    rect(ctx, P.c(C.steelDark), 64.5, 31, 3, 3);
    rect(ctx, P.c(C.yellow), 65, 31, 2, 1);
    box(ctx, P, 53, 40, 6, 6, K(C.steel), K(C.steelDark), 2, { sh: 1 });
    rect(ctx, P.c(GLASS), 54, 41, 4, 2);
    // yard details
    cyl(ctx, P, 57, 64, 3.5, 3, K(C.steelLight), K(C.steel), { ry: 2 });
    cyl(ctx, P, 66, 65, 3.5, 3, K(C.steelLight), K(C.steel), { ry: 2 });
    teamLamp(ctx, P, 68, 4, 1.8);
    teamLamp(ctx, P, 4, 67, 1.8);
  },

  // Power plant 2x3: boiler hall with two stacks.
  POWR: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 31);
    box(ctx, P, 2, 6, 44, 40, K(C.concrete), K(C.concreteDark), 9);
    panels(ctx, P, K(C.concrete), 2, 6, 44, 31, 4, 3);
    // team service band along the front wall
    fr(ctx, P, T(0.62), 3, 38, 42, 4);
    fr(ctx, P, T(0.9), 3, 38, 42, 1);
    for (let x = 8; x < 44; x += 8) fr(ctx, P, T(0.62), x, 38, 0.7, 4, -0.5);
    rect(ctx, P.c(C.track), 20, 42, 8, 3);
    windows(ctx, P, 6, 43, 2, 3, 1.6, 2);
    windows(ctx, P, 35, 43, 2, 3, 1.6, 2);
    // transformer and pipework between the stacks
    pipe(ctx, P, [14, 31, 24, 31, 34, 31], 2.2, K(C.steel));
    box(ctx, P, 20, 22, 8, 7, K(C.steelLight), K(C.steelDark), 3, { sh: 2 });
    vents(ctx, P, 21.5, 24, 3, 1.4, 2, 0.8);
    for (const x of [14, 34]) {
      cyl(ctx, P, x, 17, 8, 16, K(C.steelLight), K(C.steel), { ry: 4.4, bands: [[10, 2.2, T(0.62)]] });
      fe(ctx, P, K(C.track), x, 17, 5.4, 2.8);
      fe(ctx, P, K('#e8641c'), x, 17.4, 3.2, 1.5, 0);
      fe(ctx, P, K('#ffd070'), x - 0.5, 17, 1.4, 0.7);
    }
    lamp(ctx, P, 6, 9);
  },

  // Advanced power plant 3x3: three turbine halls.
  APWR: (ctx, P) => {
    apron(ctx, P, 0, 48, 72, 24, 41);
    box(ctx, P, 2, 4, 68, 44, K(C.concrete), K(C.concreteDark), 9);
    panels(ctx, P, K(C.concrete), 2, 4, 68, 35, 6, 1);
    fr(ctx, P, T(0.62), 3, 40, 66, 4);
    fr(ctx, P, T(0.92), 3, 40, 66, 1);
    for (let x = 9; x < 68; x += 8) fr(ctx, P, T(0.62), x, 40, 0.7, 4, -0.5);
    rect(ctx, P.c(C.track), 30, 43, 12, 4);
    pipe(ctx, P, [14, 30, 36, 30, 58, 30], 2.4, K(C.steel));
    for (const x of [14, 36, 58]) {
      cyl(ctx, P, x, 16, 9.5, 14, K(C.steelLight), K(C.steel), { ry: 5.2, bands: [[8, 2.4, T(0.62)]] });
      fe(ctx, P, K(C.steelDark), x, 16, 7.4, 4);
      fan(ctx, P, x, 16, 3.4);
    }
    for (const x of [6, 66]) {
      box(ctx, P, x - 3, 8, 6, 12, K(C.steelLight), K(C.steelDark), 3, { sh: 2 });
      vents(ctx, P, x - 2, 10, 4, 1, 3, 0.2);
    }
    lamp(ctx, P, 24, 8);
    lamp(ctx, P, 48, 8);
  },

  // Ore refinery 3x4: ore tower, processing plant and an unloading dock.
  PROC: (ctx, P) => {
    // row 0: silo in the middle; row 1: plant; rows 2-3: dock pad
    apron(ctx, P, 0, 48, 72, 48, 51);
    // lane markings leading to the dock
    for (let x = 30; x < 42; x += 4) rect(ctx, P.c(C.yellow), x, 56, 2, 14);
    // plant
    box(ctx, P, 0, 25, 72, 25, K(C.concrete), K(C.concreteDark), 8);
    for (const x of [4, 42]) {
      fr(ctx, P, T(0.62), x, 29, 26, 14);
      fr(ctx, P, T(0.85), x, 29, 26, 1);
      fr(ctx, P, T(0.4), x + 25, 29, 1, 14);
      panels(ctx, P, T(0.62), x, 29, 26, 14, 4, 2);
    }
    windows(ctx, P, 4, 44, 5, 4, 2, 2);
    windows(ctx, P, 44, 44, 5, 4, 2, 2);
    pipe(ctx, P, [30, 33, 36, 33, 36, 28], 2.2, K(C.steel));
    pipe(ctx, P, [42, 38, 36, 38], 1.8, K(C.steel));
    cyl(ctx, P, 33, 31, 2.5, 6, K(C.steelLight), K(C.steel), { ry: 1.6, shadow: false });
    // ore tower
    cyl(ctx, P, 36, 11, 12, 13, K(C.concreteLight), K(C.concrete), { ry: 7, bands: [[6, 3, T(0.62)]] });
    fe(ctx, P, K('#3a3830'), 36, 11, 8.6, 4.6);
    fe(ctx, P, K(C.ore), 36, 11.6, 7.4, 3.8);
    for (const [x, y, r] of [[32, 10, 1.6], [37, 9.5, 1.8], [40, 12, 1.5], [34, 13, 1.4], [38, 13, 1.2]]) circle(ctx, P.c('#e0b040'), x, y, r);
    circle(ctx, P.c('#f2d36a'), 36, 9.4, 0.8);
    // unloading dock
    rect(ctx, P.c(C.yellowDark), 0, 50, 24, 22);
    rect(ctx, P.c(C.steelDark), 1, 51, 22, 20);
    rect(ctx, P.c(C.steel), 2, 52, 20, 18);
    for (let gx = 4; gx < 22; gx += 3) rect(ctx, P.c('#46484c'), gx, 52, 0.8, 18);
    for (let gy = 54; gy < 70; gy += 3) rect(ctx, P.c('#46484c'), 2, gy, 20, 0.8);
    rect(ctx, P.c(C.steelLight), 2, 52, 20, 1);
    hazard(ctx, P, 1, 69, 22, 2, 2);
    lamp(ctx, P, 3, 50.5, '#ffb030', 'rgba(255,180,50,0.35)');
    lamp(ctx, P, 21, 50.5, '#ffb030', 'rgba(255,180,50,0.35)');
  },

  // Allied barracks 2x3: a canvas field tent.
  TENT: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 61);
    dirt(ctx, P, 0, 0, 48, 48, 62);
    shadow(ctx, P, [['p', [6, 46, 26, 9, 49, 40, 48, 48]]]);
    // roof planes
    fp(ctx, P, K('#a3a36a'), [3, 43, 24, 5, 24, 43]);
    fp(ctx, P, K(C.canvasDark), [24, 5, 45, 43, 24, 43]);
    // canvas seams parallel to the slopes
    for (const k of [0.3, 0.6]) {
      polyline(ctx, P.c('#7c7c4e'), 0.6, [3 + 21 * k, 43 - 38 * k, 3 + 21 * k + 3, 43]);
      polyline(ctx, P.c('#585838'), 0.6, [45 - 21 * k, 43 - 38 * k, 45 - 21 * k - 3, 43]);
    }
    polyline(ctx, P.c('#b8b87a'), 0.9, [3, 43, 24, 5]);
    rect(ctx, P.c(C.canvasDark), 23.5, 5, 1, 38);
    rect(ctx, P.c('#b8b87a'), 24.5, 5, 0.6, 38);
    // team valance along the eaves and a team patch on the lit slope
    fp(ctx, P, T(0.7), [3, 43, 45, 43, 45.8, 46, 2.2, 46]);
    fr(ctx, P, T(0.9), 2.2, 43, 43.6, 1);
    fr(ctx, P, T(0.6), 10, 28, 7, 5);
    fr(ctx, P, T(0.9), 10, 28, 7, 1);
    // open tent door with tied-back flaps
    fp(ctx, P, K(C.track), [18, 46, 24, 29, 30, 46]);
    fp(ctx, P, K('#8c8c58'), [18, 46, 24, 29, 20.5, 46]);
    fp(ctx, P, K('#7a7a4c'), [30, 46, 24, 29, 27.5, 46]);
    // guy ropes and stakes
    for (const [x, y] of [[0.5, 40], [47, 40], [3, 31], [45, 31]]) {
      polyline(ctx, P.c('#cdbb88'), 0.5, [x, y, x < 24 ? x + 5 : x - 5, y < 36 ? 20 : 36]);
      rect(ctx, P.c(C.steelDark), x - 0.5, y - 0.5, 1.5, 1.5);
    }
    // flag
    rect(ctx, P.c(C.steelDark), 38.5, 3, 1, 14);
    poly(ctx, P.team(0.9), [39.5, 3.5, 46, 6, 39.5, 8.5]);
    // supplies
    for (const [x, y] of [[1, 3], [8, 2]]) {
      rect(ctx, P.c('#4a3a20'), x, y, 6, 6);
      rect(ctx, P.c('#9a7442'), x + 0.5, y + 0.5, 5, 4.5);
      rect(ctx, P.c('#5e4424'), x + 0.5, y + 2.5, 5, 0.6);
    }
    cyl(ctx, P, 44, 12, 2.4, 3, K(C.steelLight), K('#4f6b2f'), { ry: 1.3, shadow: false });
  },

  // Soviet barracks 2x3: brick barracks block with a star plate.
  BARR: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 71);
    pad(ctx, P, 0, 0, 48, 48, 72);
    box(ctx, P, 3, 3, 42, 44, K('#5b5f63'), K(BRICK), 11);
    // pitched roof: lit northern slope, shaded southern slope
    fr(ctx, P, K('#6b7075'), 3, 3, 42, 16);
    fr(ctx, P, K('#4b4f53'), 3, 19, 42, 17);
    fr(ctx, P, K('#868b90'), 3, 3, 42, 1);
    fr(ctx, P, K('#33363a'), 3, 19, 42, 0.8);
    for (let x = 7; x < 44; x += 5) {
      fr(ctx, P, K('#33363a'), x, 4, 0.6, 15);
      fr(ctx, P, K('#33363a'), x, 20, 0.6, 15);
    }
    // star plate
    fr(ctx, P, T(0.52), 10, 9, 28, 20);
    fr(ctx, P, T(0.75), 10, 9, 28, 1);
    fr(ctx, P, T(0.35), 10, 28, 28, 1);
    fp(ctx, P, T(1.0), [24, 11, 26.2, 17, 33, 17, 27.6, 21, 29.6, 27.5, 24, 23.6, 18.4, 27.5, 20.4, 21, 15, 17, 21.8, 17]);
    fp(ctx, P, T(0.78), [24, 11, 24, 23.6, 18.4, 27.5, 20.4, 21, 15, 17, 21.8, 17]);
    // chimney
    box(ctx, P, 36, 5, 5, 6, K(C.concreteDark), K(C.seam), 2, { sh: 2 });
    rect(ctx, P.c(C.track), 37, 6, 3, 2);
    // brick south wall
    bricks(ctx, P, 3, 36, 42, 11);
    rect(ctx, P.c(C.seam), 3, 35, 42, 1);
    rect(ctx, P.c(C.track), 19, 38, 10, 9);
    rect(ctx, P.c(C.steelDark), 18, 37, 12, 1.2);
    windows(ctx, P, 6, 39, 2, 3.5, 3, 2);
    windows(ctx, P, 33, 39, 2, 3.5, 3, 2);
    // sandbags at the door
    for (let x = 6; x < 42; x += 5) {
      if (x > 14 && x < 30) continue;
      circle(ctx, P.c(C.canvasDark), x + 2, 47.5, 2.6);
      circle(ctx, P.c(C.canvas), x + 1.6, 47, 2);
    }
  },

  // War factory 3x3: arched vehicle hangar with a roll-up bay.
  WEAP: (ctx, P) => {
    apron(ctx, P, 0, 48, 72, 24, 81);
    rect(ctx, P.c(C.shadow), 4, 4, 70, 48);
    rect(ctx, P.c(C.concreteDark), 0, 0, 72, 50);
    rect(ctx, P.c(C.concrete), 1, 1, 70, 48);
    // arched hangar roof, team coloured
    vault(ctx, P, 3, 3, 66, 32, T(0.64), 7);
    fr(ctx, P, T(0.4), 3, 34, 66, 2);
    // roof furniture
    for (const x of [10, 24, 50]) {
      box(ctx, P, x, 12, 8, 6, K(C.concreteLight), K(C.concreteDark), 2, { sh: 2 });
      fan(ctx, P, x + 4, 14, 2.2);
    }
    vents(ctx, P, 38, 20, 5, 2, 4, 1.2);
    pipe(ctx, P, [18, 15, 24, 15], 1.4, K(C.steel));
    mast(ctx, P, 64, 6, 16);
    // front wall and bay
    rect(ctx, P.c(C.concreteDark), 0, 38, 72, 12);
    rect(ctx, P.c(C.concreteLight), 0, 38, 72, 1);
    rect(ctx, P.c(C.seam), 0, 49, 72, 1);
    bay(ctx, P, 21, 39, 30, 11, 2.5);
    hazard(ctx, P, 17, 39, 3, 11, 1.8);
    hazard(ctx, P, 52, 39, 3, 11, 1.8);
    windows(ctx, P, 3, 41, 3, 3.5, 3, 2);
    windows(ctx, P, 58, 41, 3, 3.5, 3, 2);
    lamp(ctx, P, 19, 37, '#ffb030', 'rgba(255,180,50,0.35)');
    lamp(ctx, P, 53, 37, '#ffb030', 'rgba(255,180,50,0.35)');
    teamLamp(ctx, P, 68, 46, 1.4);
  },

  // Service depot 3x3: a plus of repair pads with a robot arm in the middle.
  FIX: (ctx, P) => {
    const cells = [[24, 0], [0, 24], [24, 24], [48, 24], [24, 48]];
    cells.forEach(([x, y], i) => {
      pad(ctx, P, x, y, 24, 24, 90 + i);
    });
    // bay outlines on the four arms
    for (const [x, y, w, h] of [[28, 3, 16, 18], [3, 28, 18, 16], [51, 28, 18, 16], [28, 51, 16, 18]]) {
      rect(ctx, P.c(C.yellow), x, y, w, 1);
      rect(ctx, P.c(C.yellow), x, y + h - 1, w, 1);
      rect(ctx, P.c(C.yellow), x, y, 1, h);
      rect(ctx, P.c(C.yellow), x + w - 1, y, 1, h);
    }
    // raised central platform
    rect(ctx, P.c(C.shadow), 27, 27, 24, 24);
    rect(ctx, P.c(C.steelDark), 25, 25, 24, 24);
    rect(ctx, P.c(C.steel), 26, 26, 22, 22);
    for (let i = 28; i < 48; i += 4) {
      rect(ctx, P.c('#5f6266'), i, 26, 1, 22);
      rect(ctx, P.c('#5f6266'), 26, i, 22, 1);
    }
    circle(ctx, P.c(C.steelDark), 37, 37, 9.5);
    circle(ctx, P.team(0.68), 37, 37, 8.2);
    circle(ctx, P.team(0.82), 36, 36, 6);
    // repair cross
    fr(ctx, P, T(1.0), 35, 31, 4, 12);
    fr(ctx, P, T(1.0), 31, 35, 12, 4);
    fr(ctx, P, T(0.6), 35, 42, 4, 1);
    // robotic arm on a pedestal at the upper left of the platform
    cyl(ctx, P, 29, 29, 3.2, 3, K(C.steelLight), K(C.steel), { ry: 1.8, shadow: false });
    pipe(ctx, P, [29, 29, 35, 24, 41, 27], 2.2, K(C.yellow));
    circle(ctx, P.c(C.steelDark), 41, 27, 2.4);
    circle(ctx, P.team(0.8), 41, 27, 1.6);
    for (const [x, y] of [[26, 4], [46, 4], [4, 26], [4, 46], [68, 26], [68, 46], [26, 68], [46, 68]]) lamp(ctx, P, x, y, '#ffd24a', 'rgba(255,210,70,0.3)');
  },

  // Radar dome 2x3: control building under a radar sphere.
  DOME: (ctx, P) => {
    // rows 0-1: radar building, row 2: bib
    apron(ctx, P, 0, 48, 48, 24, 101);
    box(ctx, P, 2, 14, 44, 33, K(C.concrete), K(C.concreteDark), 8);
    fr(ctx, P, T(0.55), 3, 38, 42, 2);
    rect(ctx, P.c(C.track), 19, 41, 10, 6);
    windows(ctx, P, 6, 41, 3, 3, 2.5, 2.4);
    windows(ctx, P, 33, 41, 3, 3, 2.5, 2.4);
    vents(ctx, P, 6, 30, 4, 3, 3, 1.5);
    vents(ctx, P, 33, 30, 4, 3, 3, 1.5);
    // dome on its drum
    shadow(ctx, P, [['e', 28, 26, 15, 14]]);
    sphere(ctx, P, 24, 22, 15, T(0.78));
    outline(ctx, P, 24, 22, 15);
    // meridians and latitude seam
    polyline(ctx, P.team(0.42), 0.7, [24, 7.5, 24, 36.5]);
    for (const dx of [-7, 7]) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(24, 22, 14.4, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = P.team(0.45);
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.ellipse(24, 22, Math.abs(dx), 14.5, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(24, 22, 14.4, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = P.team(0.45);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.ellipse(24, 22, 14.5, 6, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    dish(ctx, P, 40, 12, 4);
    mast(ctx, P, 5, 6, 16);
  },

  // Helipad 2x3: a lit pad with a painted H.
  HPAD: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 111);
    pad(ctx, P, 0, 0, 48, 48, 112);
    // painted circle and H
    circle(ctx, P.c(C.yellowDark), 24, 24, 19);
    circle(ctx, P.c(C.concrete), 24, 24, 17.2);
    circle(ctx, P.c('#a3a094'), 24, 24, 17.2);
    circle(ctx, P.c(C.concrete), 24, 24, 16.4);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      circle(ctx, P.c(C.yellow), 24 + Math.cos(a) * 18.2, 24 + Math.sin(a) * 18.2, 0.9);
    }
    fr(ctx, P, T(0.88), 16, 14, 4.5, 20);
    fr(ctx, P, T(0.88), 27.5, 14, 4.5, 20);
    fr(ctx, P, T(0.88), 16, 22, 16, 4);
    fr(ctx, P, T(1.0), 16, 14, 4.5, 1);
    fr(ctx, P, T(1.0), 27.5, 14, 4.5, 1);
    // corner beacons with hazard bases
    for (const [x, y] of [[4, 4], [44, 4], [4, 44], [44, 44]]) {
      circle(ctx, P.c(C.yellow), x, y, 2.8);
      circle(ctx, P.c(C.track), x, y, 1.8);
      teamLamp(ctx, P, x, y, 1.2);
    }
    // fuel cart
    box(ctx, P, 38, 28, 6, 9, K(C.steelLight), K(C.steelDark), 3, { sh: 1.5 });
    cyl(ctx, P, 41, 31, 2, 4, K('#c4c7cb'), K('#b8442e'), { ry: 1.2, shadow: false });
    // windsock
    rect(ctx, P.c(C.steelDark), 4, 14, 1, 8);
    poly(ctx, P.team(0.85), [5, 14, 12, 15.5, 12, 18, 5, 18.5]);
    poly(ctx, P.c(PAINT), [8, 14.6, 10, 15, 10, 17.4, 8, 17.7]);
  },

  // Airfield 3x2: runway, hangar and control tower.
  AFLD: (ctx, P) => {
    rect(ctx, P.c(C.shadow), 2, 2, 72, 48);
    rect(ctx, P.c(C.concreteDark), 0, 0, 72, 48);
    rect(ctx, P.c(C.concrete), 1, 1, 70, 46);
    // runway
    rect(ctx, P.c('#2e2d2a'), 1, 19, 70, 28);
    rect(ctx, P.c(ASPHALT), 2, 20, 68, 26);
    for (let i = 0; i < 40; i++) {
      const r = rng(130 + i);
      rect(ctx, P.c(r() < 0.5 ? '#3b3a36' : '#4d4c46'), 3 + Math.floor(r() * 64), 21 + Math.floor(r() * 24), 2, 1);
    }
    rect(ctx, P.c(PAINT), 2, 21, 68, 1);
    rect(ctx, P.c(PAINT), 2, 44, 68, 1);
    for (let x = 12; x < 68; x += 10) rect(ctx, P.c(PAINT), x, 32, 6, 1.5);
    for (let y = 23; y < 43; y += 3) rect(ctx, P.c(PAINT), 3, y, 4, 1.6); // threshold bars
    rect(ctx, P.c('#2c2b28'), 40, 26, 14, 1); // rubber streaks
    rect(ctx, P.c('#2c2b28'), 40, 38, 14, 1);
    for (let x = 4; x < 70; x += 8) {
      circle(ctx, P.c(C.yellow), x, 19.5, 0.9);
      circle(ctx, P.c(C.yellow), x, 46, 0.9);
    }
    // hangar
    shadow(ctx, P, [['r', 6, 5, 34, 17]]);
    box(ctx, P, 3, 2, 34, 17, T(0.62), T(0.34), 5, { shadow: false });
    vault(ctx, P, 3, 2, 34, 12, T(0.64), 4);
    bay(ctx, P, 11, 14, 18, 5, 1.8);
    fan(ctx, P, 33, 8, 2);
    // control tower
    box(ctx, P, 52, 3, 14, 15, K(C.concreteLight), K(C.concreteDark), 7);
    rect(ctx, P.c(C.steelDark), 54, 9, 10, 5.5);
    rect(ctx, P.c(GLASS), 54.5, 9.5, 9, 4);
    rect(ctx, P.c(GLASS_HI), 54.5, 9.5, 9, 1);
    for (let x = 58.5; x < 63; x += 3) rect(ctx, P.c(C.steelDark), x, 9.5, 0.8, 4);
    fr(ctx, P, T(0.7), 53, 5, 12, 2);
    dish(ctx, P, 59, 5, 2.6);
    // fuel tank and windsock
    cyl(ctx, P, 44, 8, 3.5, 5, K(C.steelLight), K('#b8442e'), { ry: 2 });
    rect(ctx, P.c(C.steelDark), 69, 23, 1, 8);
    poly(ctx, P.team(0.85), [68.6, 23, 63, 24.4, 63, 26.6, 68.6, 28]);
    teamLamp(ctx, P, 68, 4, 1.2);
  },

  // Allied tech center 2x3: laboratory with an observatory dome and a big dish.
  ATEK: (ctx, P) => {
    apron(ctx, P, 0, 48, 48, 24, 121);
    box(ctx, P, 2, 5, 44, 42, K(C.concreteLight), K(C.concreteDark), 9);
    panels(ctx, P, K(C.concreteLight), 2, 5, 44, 33, 4, 3);
    // glass curtain wall in a team frame
    fr(ctx, P, T(0.62), 4, 40, 40, 6);
    windows(ctx, P, 6, 41, 6, 4.4, 4, 1.6);
    fr(ctx, P, T(0.9), 4, 39, 40, 1.2);
    rect(ctx, P.c(C.track), 20, 47, 8, 0.01);
    // observatory dome
    shadow(ctx, P, [['e', 18, 21, 10, 10]]);
    sphere(ctx, P, 15, 18, 10, K(C.steelLight));
    rect(ctx, P.c(C.steelDark), 14.2, 7.6, 1.8, 10.4);
    rect(ctx, P.c('#1f2a30'), 14.5, 8, 1.2, 10);
    outline(ctx, P, 15, 18, 10);
    // radio dish on a tower
    shadow(ctx, P, [['e', 37, 20, 9, 9]]);
    circle(ctx, P.c(C.steelDark), 35, 17, 8.6);
    circle(ctx, P.c(C.steel), 35, 17, 7.6);
    circle(ctx, P.c(C.steelLight), 34.4, 16.4, 6.2);
    circle(ctx, P.c('#c9ccd0'), 33, 15, 3.6);
    for (const a of [0.4, 1.2, 2.0, 2.8]) polyline(ctx, P.c(C.steel), 0.5, [35, 17, 35 + Math.cos(a * Math.PI) * 7, 17 + Math.sin(a * Math.PI) * 7]);
    polyline(ctx, P.c(C.steelDark), 0.9, [35, 17, 40, 11]);
    circle(ctx, P.c(RED), 40, 11, 1.1);
    vents(ctx, P, 25, 29, 3, 3, 3, 1.4);
    lamp(ctx, P, 5, 8);
    lamp(ctx, P, 43, 8);
  },

  // Soviet tech center 3x3: reactor spheres around a central laboratory.
  STEK: (ctx, P) => {
    apron(ctx, P, 0, 48, 72, 24, 131);
    box(ctx, P, 2, 3, 68, 45, K(C.concreteDark), K(C.seam), 8);
    panels(ctx, P, K(C.concreteDark), 2, 3, 68, 37, 8, 2);
    fr(ctx, P, T(0.5), 6, 7, 60, 30);
    fr(ctx, P, T(0.7), 6, 7, 60, 1);
    // central lab
    box(ctx, P, 20, 8, 32, 30, T(0.74), T(0.42), 7);
    panels(ctx, P, T(0.74), 20, 8, 32, 23, 4, 2);
    windows(ctx, P, 23, 33, 6, 3.5, 3, 1.4);
    rect(ctx, P.c(C.track), 32, 39, 8, 9);
    dish(ctx, P, 36, 18, 5.4);
    vents(ctx, P, 24, 25, 6, 2, 3, 1.4);
    // reactor spheres
    for (const x of [12, 60]) {
      shadow(ctx, P, [['e', x + 3, 19, 7, 7]]);
      sphere(ctx, P, x, 16, 7, K(C.steelLight));
      outline(ctx, P, x, 16, 7);
      circle(ctx, P.c('#7fc4ff'), x + 1.2, 17.4, 1.5);
      pipe(ctx, P, x < 36 ? [x + 3, 22, 20, 27] : [x - 3, 22, 52, 27], 1.6, K(C.steel));
    }
    for (const x of [12, 60]) {
      polyline(ctx, P.c(C.steelDark), 1.6, [x, 34, x, 25]);
      teamLamp(ctx, P, x, 24, 1.5);
    }
    mast(ctx, P, 5, 6, 14);
    mast(ctx, P, 67, 6, 14);
  },

  // Kennel 1x1: a small wooden hut.
  KENN: (ctx, P) => {
    shadow(ctx, P, [['p', [5, 22, 22, 22, 24, 10, 14, 5]]]);
    // front wall
    rect(ctx, P.c('#4a3419'), 3, 14, 18, 7);
    rect(ctx, P.c('#6b4d28'), 3, 14, 18, 6.2);
    for (let x = 6; x < 21; x += 3) rect(ctx, P.c('#4a3419'), x, 14, 0.6, 7);
    ell(ctx, P.c(C.track), 12, 17.6, 3.5, 3.4);
    rect(ctx, P.c(C.track), 8.5, 17.6, 7, 3.4);
    // gabled roof, sloped planes seen from the front
    fp(ctx, P, T(0.72), [2, 15, 2, 6, 12, 2.5, 12, 15]);
    fp(ctx, P, T(0.44), [12, 2.5, 22, 6, 22, 15, 12, 15]);
    fr(ctx, P, T(0.9), 11.4, 2.5, 1.2, 12.5);
    fr(ctx, P, T(0.9), 2, 6, 10, 0.8);
    for (const k of [4.5, 8, 11.5]) {
      fr(ctx, P, T(0.72), 2, k, 10, 0.5, -0.4);
      fr(ctx, P, T(0.44), 12, k, 10, 0.5, -0.4);
    }
    // bowl and bone sign
    ell(ctx, P.c('#7e7a68'), 19.6, 22, 2.4, 1.2);
    ell(ctx, P.c('#c8c0a8'), 19.4, 21.6, 1.9, 0.9);
    rect(ctx, P.c(PAINT), 10, 12.4, 4, 1);
    circle(ctx, P.c(PAINT), 9.6, 12.2, 0.8);
    circle(ctx, P.c(PAINT), 14.4, 12.2, 0.8);
  },

  // Naval yard 3x3: a U-shaped dock around open water (the water stays clear).
  SYRD: (ctx, P) => {
    const areas = [[0, 0, 72, 26], [0, 24, 14, 48], [58, 24, 14, 48]];
    shadow(ctx, P, [['r', 3, 3, 72, 24], ['r', 3, 24, 14, 48], ['r', 61, 24, 14, 48]]);
    areas.forEach(([x, y, w, h], i) => pad(ctx, P, x, y, w, h, 140 + i));
    // quay edge toward the water: dark rim, lit cap, rubber fenders
    rect(ctx, P.c(C.concreteDark), 14, 24, 44, 2);
    rect(ctx, P.c(C.steelDark), 14, 25, 44, 1);
    for (let x = 17; x < 56; x += 7) rrectDark(ctx, P, x, 24, 4, 3);
    rect(ctx, P.c(C.steelDark), 13, 26, 1, 46);
    rect(ctx, P.c(C.steelDark), 58, 26, 1, 46);
    for (let y = 30; y < 70; y += 8) {
      rrectDark(ctx, P, 12, y, 3, 4);
      rrectDark(ctx, P, 57, y, 3, 4);
    }
    // warehouse
    box(ctx, P, 14, 3, 44, 21, T(0.62), T(0.34), 6);
    panels(ctx, P, T(0.62), 14, 3, 44, 15, 6, 1);
    for (const x of [20, 34, 47]) {
      rect(ctx, P.c(GLASS_DK), x - 0.5, 6.5, 7, 4);
      rect(ctx, P.c(GLASS), x, 7, 6, 3);
      rect(ctx, P.c(GLASS_HI), x, 7, 6, 1);
    }
    bay(ctx, P, 28, 18, 16, 5, 1.8);
    vents(ctx, P, 18, 12, 3, 3, 2, 1.4);
    // gantry crane on the right pier
    shadow(ctx, P, [['p', [60, 46, 74, 46, 74, 40, 40, 44]]]);
    box(ctx, P, 59, 36, 12, 12, K(C.yellow), K(C.yellowDark), 4, { shadow: false });
    fr(ctx, P, K(C.steelDark), 60, 41, 10, 1);
    rect(ctx, P.c(GLASS), 61, 37, 4, 3);
    polyline(ctx, P.c(C.steelDark), 3, [59, 41, 36, 41]);
    polyline(ctx, P.c(C.yellow), 1.8, [59, 41, 36, 41]);
    polyline(ctx, P.c(C.yellowDark), 0.6, [58, 40, 53, 42.4, 48, 40, 43, 42.4, 38, 40]);
    rect(ctx, P.c(C.steelDark), 36, 41, 3, 4);
    rect(ctx, P.c(C.yellow), 36.5, 44.5, 2, 1.4);
    // left pier: fuel tank and crates
    cyl(ctx, P, 7, 38, 4.6, 7, K(C.steelLight), K('#b8442e'), { ry: 2.6 });
    for (const [x, y] of [[3, 56], [8, 59]]) {
      rect(ctx, P.c('#4a3a20'), x, y, 5, 5);
      rect(ctx, P.c('#9a7442'), x + 0.5, y + 0.5, 4, 3.5);
    }
    mast(ctx, P, 7, 28, 33);
    for (const [x, y] of [[7, 69], [65, 69]]) teamLamp(ctx, P, x, y, 1.6);
    hazard(ctx, P, 1, 70, 12, 1.6, 1.8);
    hazard(ctx, P, 59, 70, 12, 1.6, 1.8);
  },

  // Sub pen 3x3: a roofed concrete pen opening onto the water.
  SPEN: (ctx, P) => {
    pad(ctx, P, 2, 2, 68, 68, 150);
    // water inside the bay, rippled and darker toward the pen
    rect(ctx, P.c(WATER), 24, 40, 24, 30);
    rect(ctx, P.c('#16282f'), 24, 40, 24, 5);
    for (let y = 47; y < 70; y += 5) {
      rect(ctx, P.c('#2b4756'), 27, y, 7, 1);
      rect(ctx, P.c('#2b4756'), 37, y + 2, 7, 1);
    }
    for (const x of [21, 48]) {
      rect(ctx, P.c(C.concreteDark), x, 40, 3, 30);
      rect(ctx, P.c(C.concreteLight), x, 40, 1, 30);
      rect(ctx, P.c(C.seam), x + 2, 40, 1, 30);
    }
    for (let y = 44; y < 70; y += 8) {
      circle(ctx, P.c(C.steelDark), 22.5, y, 1.1);
      circle(ctx, P.c(C.steelDark), 49.5, y, 1.1);
    }
    // arched roof
    shadow(ctx, P, [['r', 11, 8, 58, 33]]);
    vault(ctx, P, 8, 6, 56, 33, T(0.62), 6);
    fr(ctx, P, T(0.3), 8, 38, 56, 4);
    fr(ctx, P, T(0.5), 8, 38, 56, 1);
    // pen mouth and gate pillars
    rect(ctx, P.c(C.track), 24, 38, 24, 4);
    for (const x of [22, 47]) {
      rect(ctx, P.c(C.concreteDark), x, 36, 3, 6);
      rect(ctx, P.c(C.concreteLight), x, 36, 1, 6);
    }
    hazard(ctx, P, 24, 41, 24, 1.6, 1.6);
    fan(ctx, P, 20, 14, 2.4);
    fan(ctx, P, 52, 14, 2.4);
    mast(ctx, P, 36, 8, 14);
    for (const x of [13, 59]) teamLamp(ctx, P, x, 62, 1.6);
  },

  // Silo 1x1: ore storage tank.
  SILO: (ctx, P) => {
    cyl(ctx, P, 12, 9, 9.4, 11, K(C.concreteLight), K(C.concrete), { ry: 5.4, bands: [[5, 3, T(0.62)]] });
    fe(ctx, P, K(C.concreteDark), 12, 9, 6.2, 3.4);
    fe(ctx, P, K(C.yellowDark), 12, 9.2, 5.4, 2.9);
    for (const [x, y, r] of [[10, 8.6, 1.4], [14, 8.2, 1.5], [12, 10.4, 1.3], [9.4, 10, 1.1], [15, 10.2, 1.1]]) circle(ctx, P.c(C.ore), x, y, r);
    circle(ctx, P.c('#f2d36a'), 10.2, 8.2, 0.7);
    rect(ctx, P.c(C.steelDark), 16.4, 15, 1.4, 5); // ladder
  },

  // Sandbags 1x1: stacked, stitched bags.
  SBAG: (ctx, P) => {
    rect(ctx, P.c(C.shadow), 2, 22, 22, 2);
    for (let row = 0; row < 4; row++) {
      const off = row % 2 ? 3 : 0;
      const y = 1 + row * 5.6;
      for (let x = 1 - off; x < 23; x += 6) {
        const bx = Math.max(1, x);
        const bw = Math.min(x + 6, 23) - bx;
        if (bw < 2) continue;
        rrectBag(ctx, P, bx, y, bw);
      }
    }
  },

  // Wire fence 1x1: posts and diamond mesh (joins neighbours on all four sides).
  FENC: (ctx, P) => {
    const wire = P.c('#a6a6a0');
    const mesh = (x, y, w, h) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.strokeStyle = wire;
      ctx.lineWidth = 0.5;
      for (let d = -h; d < w + h; d += 3) {
        ctx.beginPath();
        ctx.moveTo(x + d, y);
        ctx.lineTo(x + d + h, y + h);
        ctx.moveTo(x + d + h, y);
        ctx.lineTo(x + d, y + h);
        ctx.stroke();
      }
      ctx.restore();
    };
    rect(ctx, P.c(C.shadow), 1, 14, 24, 4);
    rect(ctx, P.c(C.shadow), 14, 1, 4, 24);
    mesh(0, 8, 24, 7);
    mesh(8, 0, 7, 24);
    for (const [x, y, w, h] of [[0, 7.4, 24, 0.9], [0, 14.6, 24, 0.9], [7.4, 0, 0.9, 24], [14.6, 0, 0.9, 24]]) rect(ctx, P.c('#c4c4be'), x, y, w, h);
    // barbed strand on top
    polyline(ctx, P.c(C.steelDark), 0.5, [0, 7, 3, 6.2, 6, 7, 9, 6.2, 12, 7, 15, 6.2, 18, 7, 21, 6.2, 24, 7]);
    for (const [x, y] of [[1, 11.5], [23, 11.5], [11.5, 1], [11.5, 23], [11.5, 11.5]]) {
      circle(ctx, P.c(C.shadow), x + 1, y + 1.2, 1.8);
      circle(ctx, P.c('#4d3c24'), x, y, 1.7);
      circle(ctx, P.c('#8a6c42'), x - 0.4, y - 0.4, 1);
    }
  },

  // Concrete wall 1x1: a slab with a lit cap.
  BRIK: (ctx, P) => {
    box(ctx, P, 0, 0, 24, 24, K(C.concreteLight), K(C.concreteDark), 7);
    // cap stones and block joints on the face
    rect(ctx, P.c(C.concrete), 2, 2, 20, 14);
    rect(ctx, P.c('#b8b5a8'), 2, 2, 20, 1);
    rect(ctx, P.c(C.seam), 0, 9, 24, 0.8);
    rect(ctx, P.c(C.seam), 12, 0, 0.8, 9);
    rect(ctx, P.c(C.seam), 0, 17, 24, 0.7);
    for (const x of [6, 18]) rect(ctx, P.c(C.seam), x, 17, 0.8, 7);
    rect(ctx, P.c(C.seam), 12, 9, 0.8, 8);
    for (const x of [5, 17]) rect(ctx, P.c(C.seam), x, 9, 0.8, 8);
    rect(ctx, P.c('#9b988b'), 0, 9.8, 24, 0.6);
    rect(ctx, P.c(C.concreteLight), 0, 18, 24, 0.6);
  },

  // Pillbox 1x1: domed concrete bunker.
  PBOX: (ctx, P) => {
    shadow(ctx, P, [['p', octPts(14, 14, 11)]]);
    ngon(ctx, P.c(C.concreteDark), 12, 13, 11, 8);
    ngon(ctx, P.c(C.concrete), 12, 11.2, 10, 8);
    ngon(ctx, P.c(C.concreteLight), 11.6, 10.8, 8.2, 8);
    ngon(ctx, P.c(C.concrete), 12.2, 11.4, 7, 8);
    // firing slits with a lit lower lip
    rect(ctx, P.c(C.track), 7, 3.2, 10, 2.2);
    rect(ctx, P.c('#b8b5a8'), 7, 5.4, 10, 0.7);
    rect(ctx, P.c(C.track), 3.6, 9.6, 1.6, 4);
    rect(ctx, P.c(C.track), 18.8, 9.6, 1.6, 4);
    // team plate with hatch
    circle(ctx, P.c(C.steelDark), 12, 11.6, 4.6);
    circle(ctx, P.team(0.6), 12, 11.6, 4);
    circle(ctx, P.team(0.9), 11, 10.6, 1.5);
    ring(ctx, P.team(0.4), 12, 11.6, 2.6, 0.5);
    for (const [x, y] of octPts(12, 11.2, 8.4).reduce((a, v, i, s) => (i % 2 ? a : [...a, [v, s[i + 1]]]), [])) circle(ctx, P.c(C.steelDark), x, y, 0.5);
  },

  // Camo pillbox 1x1: netted bunker hidden in foliage.
  HBOX: (ctx, P) => {
    shadow(ctx, P, [['p', octPts(14, 14, 11)]]);
    ngon(ctx, P.c('#33481e'), 12, 13, 11, 8);
    ngon(ctx, P.c('#3e5426'), 12, 11.2, 10, 8);
    ngon(ctx, P.c('#4f6b2f'), 11.8, 11, 8.8, 8);
    const r = rng(160);
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2;
      const d = r() * 8;
      circle(ctx, P.c(['#668a3a', '#587a30', '#3e5426', '#7a9a4c'][i % 4]), 12 + Math.cos(a) * d, 11.4 + Math.sin(a) * d, 1.2 + r() * 1.8);
    }
    for (const [x, y] of [[6, 13], [13, 12], [17, 10], [9, 8], [15, 16]]) poly(ctx, P.c('#8aae56'), [x, y, x + 1, y - 3, x + 2, y]);
    // net strings
    polyline(ctx, P.c('#33481e'), 0.4, [4, 8, 20, 14]);
    polyline(ctx, P.c('#33481e'), 0.4, [4, 14, 20, 8]);
    rect(ctx, P.c(C.track), 7, 3.4, 10, 1.8);
    circle(ctx, P.team(0.7), 18, 18, 1.4);
    circle(ctx, P.team(1.0), 17.6, 17.6, 0.6);
  },

  // Flame tower 1x1: round bunker with a fuel tank and a nozzle.
  FTUR: (ctx, P) => {
    shadow(ctx, P, [['e', 14, 14, 10.5, 10.5]]);
    circle(ctx, P.c(C.concreteDark), 12, 12.4, 10.5);
    circle(ctx, P.c(C.concrete), 12, 11.4, 9.4);
    circle(ctx, P.c(C.concreteLight), 11.4, 10.8, 7.6);
    circle(ctx, P.c(C.concrete), 12, 11.6, 6.8);
    // team ring and fuel tank
    ring(ctx, P.team(0.65), 12, 11.6, 6.4, 1.6);
    circle(ctx, P.c(C.steelDark), 12, 12, 4);
    circle(ctx, P.c(C.yellowDark), 12, 12, 3.2);
    circle(ctx, P.c(C.yellow), 11.4, 11.4, 2);
    circle(ctx, P.c(C.steelDark), 12, 12, 1);
    // hoses to the nozzle and the pilot flame
    pipe(ctx, P, [12, 10, 12, 6], 1.4, K(C.steel));
    rect(ctx, P.c(C.steelDark), 10.5, 1, 3, 6);
    rect(ctx, P.c(C.steelLight), 10.6, 1, 0.8, 6);
    circle(ctx, P.c('rgba(232,100,28,0.4)'), 12, 1.8, 2.2);
    circle(ctx, P.c('#e8641c'), 12, 1.8, 1.3);
    circle(ctx, P.c('#ffd070'), 12, 2, 0.6);
    hazard(ctx, P, 17, 16, 4, 3, 1.4);
    teamLamp(ctx, P, 5, 17, 1.1);
  },

  // Turret 1x1: a gun emplacement (the gun itself is the turret sprite).
  GUN: (ctx, P) => {
    shadow(ctx, P, [['p', octPts(14, 14, 11.5)]]);
    ngon(ctx, P.c(C.concreteDark), 12, 13, 11.5, 8);
    ngon(ctx, P.c(C.concrete), 12, 11.4, 10.4, 8);
    ngon(ctx, P.c(C.concreteLight), 11.6, 11, 8.6, 8);
    ngon(ctx, P.c(C.concrete), 12.2, 11.6, 7.6, 8);
    circle(ctx, P.c(C.steelDark), 12, 12, 8);
    circle(ctx, P.c(C.steel), 12, 12, 7.2);
    circle(ctx, P.c(C.steelDark), 12, 12, 6.2);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      circle(ctx, P.c(C.steelLight), 12 + Math.cos(a) * 7.1, 12 + Math.sin(a) * 7.1, 0.4);
    }
    for (const [x, y] of [[3.5, 5], [20.5, 5], [3.5, 19.5], [20.5, 19.5]]) {
      circle(ctx, P.team(0.6), x, y, 1.6);
      circle(ctx, P.team(0.9), x - 0.4, y - 0.4, 0.6);
    }
  },

  // Tesla coil 1x1: copper-wound column on a base.
  TSLA: (ctx, P) => {
    shadow(ctx, P, [['p', [8, 22, 22, 22, 24, 20, 17, 9, 13, 9]]]);
    // base with transformer boxes
    rect(ctx, P.c(C.concreteDark), 3, 16, 18, 7);
    rect(ctx, P.c(C.concrete), 3, 16, 18, 5.4);
    rect(ctx, P.c(C.concreteLight), 3, 16, 18, 0.8);
    fr(ctx, P, T(0.62), 4, 17.5, 16, 3);
    fr(ctx, P, T(0.88), 4, 17.5, 16, 0.9);
    rect(ctx, P.c(C.steelDark), 1.5, 14, 4, 6);
    rect(ctx, P.c(C.steelLight), 1.5, 14, 4, 1);
    rect(ctx, P.c(C.steelDark), 18.5, 14, 4, 6);
    rect(ctx, P.c(C.steelLight), 18.5, 14, 4, 1);
    // the column: windings with lit left edge
    rect(ctx, P.c(C.steelDark), 8.5, 6, 7, 11);
    rect(ctx, P.c(C.steel), 9, 6, 3, 11);
    for (let y = 7.5; y < 16.5; y += 2) {
      rect(ctx, P.c('#7a4a22'), 8, y, 8, 1.4);
      rect(ctx, P.c(COPPER), 8, y, 8, 0.9);
      rect(ctx, P.c('#e0a064'), 8.5, y, 2.5, 0.5);
    }
    teslaHead(ctx, P, 12, 6.6, 4);
    polyline(ctx, P.c(C.steelDark), 0.5, [3.5, 14, 6, 11, 9, 9]);
    lamp(ctx, P, 21.5, 14, '#7fc4ff', 'rgba(110,170,255,0.35)');
  },

  // AA gun 1x1: a hexagonal sandbagged platform (the gun is the turret sprite).
  AGUN: (ctx, P) => {
    shadow(ctx, P, [['p', hexPts(14, 14, 11)]]);
    ngon(ctx, P.c(C.concreteDark), 12, 13, 11, 6, 0);
    ngon(ctx, P.c(C.concrete), 12, 11.4, 10, 6, 0);
    ngon(ctx, P.c(C.concreteLight), 11.6, 11, 8.2, 6, 0);
    ngon(ctx, P.c(C.concrete), 12.2, 11.6, 7.2, 6, 0);
    circle(ctx, P.c(C.steelDark), 12, 12, 6.8);
    circle(ctx, P.c(C.steel), 12, 12, 6);
    circle(ctx, P.c(C.steelDark), 12, 12, 5.2);
    for (const [x, y] of [[3.6, 11.4], [20.4, 11.4]]) {
      rect(ctx, P.c(C.yellowDark), x - 1.4, y - 1.4, 2.8, 2.8);
      rect(ctx, P.c(C.yellow), x - 1.2, y - 1.2, 2.2, 2.2);
    }
    // ammunition crates
    for (const [x, y] of [[4, 17.5], [17, 18]]) {
      rect(ctx, P.c('#4a3a20'), x, y, 4, 3);
      rect(ctx, P.c('#9a7442'), x + 0.4, y + 0.4, 3.2, 1.8);
    }
    teamLamp(ctx, P, 12, 3.2, 1);
  },

  // SAM site 2x1: launcher pad with control shed and radar.
  SAM: (ctx, P) => {
    box(ctx, P, 1, 2, 46, 21, K(C.concreteDark), K(C.seam), 4);
    pad(ctx, P, 2, 3, 44, 15, 170);
    for (const x of [3, 39]) hazard(ctx, P, x, 4, 6, 12, 2);
    fr(ctx, P, T(0.62), 11, 3, 26, 2);
    // launcher well under the turret
    circle(ctx, P.c(C.steelDark), 24, 12, 9);
    circle(ctx, P.c(C.steel), 24, 12, 8.2);
    circle(ctx, P.c(C.track), 24, 12, 7.2);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      circle(ctx, P.c(C.steelLight), 24 + Math.cos(a) * 8.2, 12 + Math.sin(a) * 8.2, 0.4);
    }
    // control shed and radar mast
    box(ctx, P, 10, 5, 4, 5, K(C.steelLight), K(C.steelDark), 2, { sh: 1 });
    dish(ctx, P, 41, 6, 2.8);
    pipe(ctx, P, [14, 14, 16, 14], 1, K(C.steel));
    lamp(ctx, P, 4, 20, '#ffb030', 'rgba(255,180,50,0.35)');
    lamp(ctx, P, 44, 20, '#ffb030', 'rgba(255,180,50,0.35)');
  },

  // Gap generator 1x1: a mast with an emitter array.
  GAP: (ctx, P) => {
    shadow(ctx, P, [['p', [8, 22, 23, 22, 25, 14, 20, 5, 16, 6]]]);
    rect(ctx, P.c(C.concreteDark), 3, 16, 18, 7);
    rect(ctx, P.c(C.concrete), 3, 16, 18, 5.4);
    rect(ctx, P.c(C.concreteLight), 3, 16, 18, 0.8);
    fr(ctx, P, T(0.6), 4, 17.5, 16, 3);
    fr(ctx, P, T(0.85), 4, 17.5, 16, 0.9);
    vents(ctx, P, 5, 18.4, 4, 2, 1.4, 1.6);
    // lattice mast
    rect(ctx, P.c(C.steelDark), 9.5, 6, 5, 11);
    rect(ctx, P.c(C.steel), 10, 6, 2, 11);
    polyline(ctx, P.c(C.steelLight), 0.5, [10, 16, 14, 12, 10, 8, 14, 6]);
    // emitter array and orb
    rect(ctx, P.c(C.steelDark), 2.5, 4, 19, 4);
    rect(ctx, P.c(C.steelLight), 3, 4.4, 18, 1.4);
    circle(ctx, P.c(C.steelDark), 12, 6.2, 4.8);
    circle(ctx, P.c('#2c2a3e'), 12, 6.2, 3.9);
    circle(ctx, P.c('#4a4478'), 12.3, 6.5, 2.6);
    circle(ctx, P.c('#8a84c8'), 11, 5.2, 1.4);
    circle(ctx, P.c('#d8d4ff'), 10.6, 4.8, 0.5);
    teamLamp(ctx, P, 4, 6, 1.1);
    teamLamp(ctx, P, 20, 6, 1.1);
  },

  // Chronosphere 2x2: gyroscope sphere on a pylon platform.
  PDOX: (ctx, P) => {
    box(ctx, P, 1, 2, 46, 44, K(C.concrete), K(C.concreteDark), 7);
    panels(ctx, P, K(C.concrete), 1, 2, 46, 37, 4, 4);
    hazard(ctx, P, 3, 36, 42, 1.6, 1.8);
    // pylons with team caps, linked by conduits
    for (const [x, y] of [[3, 4], [37, 4], [3, 27], [37, 27]]) {
      rect(ctx, P.c(C.steelDark), x - 0.5, y - 0.5, 9, 9);
      fr(ctx, P, T(0.65), x, y, 8, 8);
      fr(ctx, P, T(0.9), x, y, 8, 1);
      fr(ctx, P, T(0.42), x, y + 7, 8, 1);
      fc(ctx, P, T(1.0), x + 4, y + 4, 1.3);
    }
    pipe(ctx, P, [11, 8, 24, 20], 1.4, K(C.steel));
    pipe(ctx, P, [37, 8, 24, 20], 1.4, K(C.steel));
    pipe(ctx, P, [11, 31, 24, 20], 1.4, K(C.steel));
    pipe(ctx, P, [37, 31, 24, 20], 1.4, K(C.steel));
    // the sphere
    shadow(ctx, P, [['e', 27, 23, 15, 14]]);
    circle(ctx, P.c(C.steelDark), 24, 20, 15);
    circle(ctx, P.c('#16282f'), 24, 20, 13.4);
    circle(ctx, P.c(WATER), 23.6, 19.6, 12.4);
    ctx.save();
    ctx.translate(24, 20);
    for (const a of [0, Math.PI / 3, -Math.PI / 3]) {
      ctx.save();
      ctx.rotate(a);
      ctx.scale(1, 0.38);
      ring(ctx, P.c(C.steelDark), 0, 0, 12.5, 3);
      ring(ctx, P.c(C.steelLight), 0, 0, 12.5, 2);
      ring(ctx, P.c('#c4c7cb'), 0, -0.4, 12.5, 0.7);
      ctx.restore();
    }
    ctx.restore();
    circle(ctx, P.c('rgba(90,220,240,0.45)'), 24, 20, 8.4);
    circle(ctx, P.c('#3cb8cc'), 24, 20, 6.4);
    circle(ctx, P.c('#5fd8ea'), 23.6, 19.6, 5.2);
    circle(ctx, P.c('#e4fbff'), 22.2, 18.2, 2);
    lamp(ctx, P, 24, 41, '#5fd8ea', hexToRgbaHalo(0.35));
  },

  // Iron curtain 2x2: open pad in front, projector building behind.
  IRON: (ctx, P) => {
    // row 0: open pad, row 1: the curtain projector
    pad(ctx, P, 0, 0, 48, 24, 180);
    rect(ctx, P.c(C.yellow), 6, 3, 36, 1.4);
    circle(ctx, P.c(C.yellowDark), 24, 10, 6.8);
    circle(ctx, P.c(C.concrete), 24, 10, 5.6);
    outline(ctx, P, 24, 10, 3);
    box(ctx, P, 1, 18, 46, 28, K(C.concreteDark), K(C.seam), 8);
    // curtain folds
    for (let i = 0; i < 10; i++) fr(ctx, P, T(i % 2 ? 0.44 : 0.7), 3 + i * 4.2, 20, 4.2, 17);
    fr(ctx, P, T(0.95), 3, 20, 42, 1.4);
    rect(ctx, P.c(C.steelDark), 3, 37, 42, 1);
    // projector head over the pad
    rect(ctx, P.c(C.shadow), 20, 14, 12, 9);
    rect(ctx, P.c(C.steelDark), 17, 11, 14, 10);
    rect(ctx, P.c(C.steel), 18, 11, 12, 3);
    rect(ctx, P.c(C.steelLight), 18, 11, 12, 1);
    circle(ctx, P.c(C.steelDark), 24, 17, 3.6);
    circle(ctx, P.c('rgba(194,58,38,0.45)'), 24, 17, 3.4);
    circle(ctx, P.c(RED), 24, 17, 2.4);
    circle(ctx, P.c('#ff9a80'), 23.4, 16.4, 0.9);
    // front insulators and door
    for (const x of [8, 40]) {
      rect(ctx, P.c(C.steelDark), x - 2, 38, 4, 7);
      rect(ctx, P.c(C.steelLight), x - 2, 38, 1, 7);
      for (let y = 39; y < 45; y += 2) rect(ctx, P.c(C.steel), x - 2.6, y, 5.2, 0.8);
    }
    rect(ctx, P.c(C.track), 20, 39, 8, 7);
    mast(ctx, P, 45, 20, 26);
  },

  // Missile silo 2x1: hardened hatch with hazard framing.
  MSLO: (ctx, P) => {
    box(ctx, P, 0, 0, 48, 24, K(C.concreteDark), K(C.seam), 4);
    pad(ctx, P, 1, 1, 46, 18, 190);
    hazard(ctx, P, 7, 2, 34, 17, 2.5);
    // armoured hatch doors with ribs and hinges
    for (const x of [9.5, 24.5]) {
      rect(ctx, P.c(C.steelDark), x - 0.5, 3.5, 14.5, 14);
      rect(ctx, P.c(C.steel), x, 4, 13.5, 13);
      rect(ctx, P.c(C.steelLight), x, 4, 13.5, 1.4);
      for (let i = 1; i < 4; i++) rect(ctx, P.c('#46484c'), x + i * 3.4, 5.4, 0.7, 11.6);
      rect(ctx, P.c(C.steelDark), x, 16, 13.5, 1);
    }
    rect(ctx, P.c('#3b1a12'), 23.2, 4, 1.6, 13); // seam between the doors
    rect(ctx, P.c('#e8641c'), 23.7, 6, 0.6, 9);
    trefoil(ctx, P, 24, 10.5, 4);
    // team pylons and warning lights
    for (const x of [2, 42]) {
      fr(ctx, P, T(0.65), x, 3, 4, 14);
      fr(ctx, P, T(0.9), x, 3, 4, 1);
      fr(ctx, P, T(0.42), x + 3, 3, 1, 14);
    }
    lamp(ctx, P, 6.5, 20.6, '#ff4a3a', 'rgba(255,90,70,0.35)');
    lamp(ctx, P, 41.5, 20.6, '#ff4a3a', 'rgba(255,90,70,0.35)');
  },
};

// ---- Small shared shapes ----------------------------------------------------------

function outline(ctx, P, cx, cy, r) {
  ctx.strokeStyle = P.c(C.steelDark);
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
}

function line1(ctx, P, x0, y0, x1, y1) {
  ctx.strokeStyle = P.c(C.steelDark);
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** A dark rounded rectangle: rubber fenders and the like. */
function rrectDark(ctx, P, x, y, w, h) {
  ctx.fillStyle = P.c('#1f2022');
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 1);
  ctx.fill();
}

/** One sandbag: dark body, lit top, a stitched seam in the middle. */
function rrectBag(ctx, P, x, y, w) {
  ctx.fillStyle = P.c('#6a6a42');
  ctx.beginPath();
  ctx.roundRect(x, y, w, 5.6, 2);
  ctx.fill();
  ctx.fillStyle = P.c(C.canvas);
  ctx.beginPath();
  ctx.roundRect(x + 0.3, y + 0.3, w - 0.8, 3.6, 1.6);
  ctx.fill();
  rect(ctx, P.c('#b0b07a'), x + 1, y + 0.6, Math.max(1, w - 3), 0.8);
  rect(ctx, P.c('#6a6a42'), x + w / 2, y + 1, 0.5, 2.6);
}

function octPts(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i / 8) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

function hexPts(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
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
