// Unit materials of the 2D minimal pack, after the design canvas "WebRA
// texturen" (page Top-down, boards "Materialen en kleuren" and "Units"): every
// surface is one plain colour with one seam or pattern layer, as in 1996.
//
// Team plates keep their pattern in darker team greys, so the team mask stays
// whole and the player's colour stays readable under it. Patterns are cut to
// their rectangle here instead of with a canvas clip, so the drawings need no
// save/restore and work in every recording context the tests use.
//
// Used by the unit art modules (vehicles, infantry, naval, planes, helis);
// shapes and the base palette come from ./kit.js.

import { rect, rrect, circle, poly } from './kit.js';

/** Unit material colours (board "Materialen en kleuren"; the Units board's swatches). */
export const U = {
  steel: '#70747a',
  steelSeam: '#7b8086',
  steelLight: '#98a0a8',
  steelDark: '#3f4247',
  hull: '#55585c',
  hullDark: '#35373a',
  deck: '#1e3440',
  deckSeam: '#2a4554',
  glass: '#5f93ad',
  glassLight: '#bfe3f2',
  glassDark: '#23363f',
  copper: '#b0703a',
  copperDark: '#8c5528',
  copperLight: '#cc8a4e',
  canvas: '#8a8a5a',
  canvasDark: '#6a6a42',
  track: '#2b2b28',
  trackLight: '#4a4a44',
  yellow: '#d9b23a',
  ore: '#c99a2e',
  oreLight: '#e6c25a',
  helmet: '#5d6b3a',
  skin: '#d8b48a',
  ant: '#6a2a1e',
  antDark: '#4a1c14',
};

/** Team panel lines: this much darker than the plate's grey (the board's 18 % shade). */
export const PANEL_SHADE = 0.82;

// ---- Pattern geometry (pure) -------------------------------------------------------

/**
 * Stripes `width` wide every `period` along [from, to), the first one starting
 * at `from + phase`: a list of [start, size], each cut to the range.
 */
export function bands(from, to, period, width, phase = 0) {
  const out = [];
  if (!(period > 0) || !(width > 0) || !(to > from)) return out;
  let s = from + phase;
  while (s + width <= from) s += period;
  for (; s < to; s += period) {
    const a = Math.max(from, s);
    const b = Math.min(to, s + width);
    if (b > a) out.push([a, b - a]);
  }
  return out;
}

/**
 * A convex polygon [x0, y0, x1, y1, ...] cut to the rectangle x0..x1, y0..y1
 * (Sutherland-Hodgman). Returns the cut polygon in the same form, or [] when
 * nothing of it lies inside.
 */
export function clipToRect(pts, x0, y0, x1, y1) {
  let poly2 = [];
  for (let i = 0; i < pts.length; i += 2) poly2.push([pts[i], pts[i + 1]]);
  const edges = [
    (p) => p[0] >= x0, (a, b) => cut(a, b, 0, x0),
    (p) => p[0] <= x1, (a, b) => cut(a, b, 0, x1),
    (p) => p[1] >= y0, (a, b) => cut(a, b, 1, y0),
    (p) => p[1] <= y1, (a, b) => cut(a, b, 1, y1),
  ];
  for (let e = 0; e < edges.length && poly2.length; e += 2) {
    const inside = edges[e];
    const meet = edges[e + 1];
    const next = [];
    for (let i = 0; i < poly2.length; i++) {
      const cur = poly2[i];
      const prev = poly2[(i + poly2.length - 1) % poly2.length];
      if (inside(cur)) {
        if (!inside(prev)) next.push(meet(prev, cur));
        next.push(cur);
      } else if (inside(prev)) {
        next.push(meet(prev, cur));
      }
    }
    poly2 = next;
  }
  if (poly2.length < 3) return [];
  return poly2.flat();
}

/** Where segment a-b crosses the line `axis` = v. */
function cut(a, b, axis, v) {
  const t = (v - a[axis]) / (b[axis] - a[axis]);
  return axis === 0 ? [v, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, v];
}

/**
 * 45 degree stripes rising to the right ("/"), `width` wide with `gap` between
 * them, cut to the rectangle: a list of polygons for poly().
 */
export function diagonals(x, y, w, h, width, gap) {
  const out = [];
  if (!(width > 0) || !(w > 0) || !(h > 0)) return out;
  const step = width + Math.max(0, gap);
  for (let s = -h; s < w; s += step) {
    const p = clipToRect([x + s, y + h, x + s + width, y + h, x + s + width + h, y, x + s + h, y], x, y, x + w, y + h);
    if (p.length) out.push(p);
  }
  return out;
}

// ---- Materials -------------------------------------------------------------------------

/**
 * Team plating: a plate in team grey `level` with darker panel lines across it
 * every `period` px, kept clear of rounded corners.
 */
export function plate(ctx, P, x, y, w, h, level, r = 0, period = 4) {
  rrect(ctx, P.team(level), x, y, w, h, r);
  const m = Math.max(r, 1);
  for (const [sy, sh] of bands(y + m, y + h - m, period, 0.5, period - m)) rect(ctx, P.team(level * PANEL_SHADE), x + 0.5, sy, w - 1, sh);
}

/** Steel: plain steel with lighter seams every 3 px, running along y (`vertical`) or along x. */
export function steel(ctx, P, x, y, w, h, r = 0, vertical = true) {
  rrect(ctx, P.c(U.steel), x, y, w, h, r);
  const m = Math.max(r * 0.6, 0.5);
  if (vertical) for (const [sx, sw] of bands(x + m, x + w - m, 3, 0.5, 2)) rect(ctx, P.c(U.steelSeam), sx, y + m, sw, h - 2 * m);
  else for (const [sy, sh] of bands(y + m, y + h - m, 3, 0.5, 2)) rect(ctx, P.c(U.steelSeam), x + m, sy, w - 2 * m, sh);
}

/** Running gear: a dark tread with lighter links every 2.5 px. */
export function treads(ctx, P, x, y, w, h) {
  rrect(ctx, P.c(U.track), x, y, w, h, Math.min(1.5, w / 3));
  for (const [ty, th] of bands(y + 1, y + h - 1, 2.5, 1, 0.5)) rect(ctx, P.c(U.trackLight), x + 0.5, ty, w - 1, th);
}

/** Tyres seen from above on both flanks of a w-wide vehicle, one pair per entry in ys. */
export function tyres(ctx, P, w, ys, tw = 3, th = 5) {
  for (const y of ys) {
    for (const x of [0.5, w - tw - 0.5]) {
      rrect(ctx, P.c(U.track), x, y, tw, th, 1);
      for (const [ty, tt] of bands(y + 0.8, y + th - 0.8, 1.6, 0.6)) rect(ctx, P.c(U.trackLight), x + 0.5, ty, tw - 1, tt);
    }
  }
}

/** A glazed window: dark frame, glass, a diagonal glint at the top left. */
export function glass(ctx, P, x, y, w, h, r = 0) {
  rrect(ctx, P.c(U.glassDark), x, y, w, h, r);
  const i = Math.min(0.4, w / 4, h / 4);
  rrect(ctx, P.c(U.glass), x + i, y + i, w - 2 * i, h - 2 * i, Math.max(0, r - i));
  const g = Math.max(0.5, Math.min(w, h) * 0.3);
  const glint = clipToRect([x + i, y + i + g * 1.6, x + i + g * 1.6, y + i, x + i + g * 2.4, y + i, x + i, y + i + g * 2.4], x + i, y + i, x + w - i, y + h - i);
  if (glint.length) poly(ctx, P.c(U.glassLight), glint);
}

/** A glass bubble (canopy, dome) with a glint. */
export function bubble(ctx, P, cx, cy, r) {
  circle(ctx, P.c(U.glassDark), cx, cy, r);
  circle(ctx, P.c(U.glass), cx, cy, r * 0.8);
  circle(ctx, P.c(U.glassLight), cx - r * 0.3, cy - r * 0.3, r * 0.28);
}

/** Copper windings: copper with dark turns every 3 px across `vertical` (rings along y) or along x. */
export function copper(ctx, P, x, y, w, h, r = 0, vertical = true) {
  rrect(ctx, P.c(U.copper), x, y, w, h, r);
  const m = Math.max(r * 0.6, 0.3);
  if (vertical) for (const [sy, sh] of bands(y + m, y + h - m, 3, 1, 1)) rect(ctx, P.c(U.copperDark), x + m, sy, w - 2 * m, sh);
  else for (const [sx, sw] of bands(x + m, x + w - m, 3, 1, 1)) rect(ctx, P.c(U.copperDark), sx, y + m, sw, h - 2 * m);
  rect(ctx, P.c(U.copperLight), x + m, y + m, w - 2 * m, Math.min(0.6, h / 4));
}

/** Canvas tarp: canvas with a dark diagonal weave. */
export function tarp(ctx, P, x, y, w, h) {
  rect(ctx, P.c(U.canvas), x, y, w, h);
  for (const p of diagonals(x, y, w, h, 0.8, 1.6)) poly(ctx, P.c(U.canvasDark), p);
}

/** Hazard stripes (yellow and black, 45 degrees) without a canvas clip. */
export function stripes(ctx, P, x, y, w, h, width = 2) {
  rect(ctx, P.c(U.yellow), x, y, w, h);
  for (const p of diagonals(x, y, w, h, width, width)) poly(ctx, P.c(U.track), p);
}

/** Hull plating: hull grey with dark weld bands every 3.5 px across it. */
export function hullPlates(ctx, P, x, y, w, h) {
  rect(ctx, P.c(U.hull), x, y, w, h);
  for (const [sy, sh] of bands(y, y + h, 3.5, 0.6, 2.9)) rect(ctx, P.c(U.hullDark), x, sy, w, sh);
}

/** A ship's deck: dark blue planking with seams every 2 px along it. */
export function deck(ctx, P, x, y, w, h) {
  rect(ctx, P.c(U.deck), x, y, w, h);
  for (const [sx, sw] of bands(x, x + w, 2, 0.4, 1.8)) rect(ctx, P.c(U.deckSeam), sx, y, sw, h);
}

/** A load of ore: ore with bright nuggets on a 3 px grid. */
export function oreLoad(ctx, P, x, y, w, h) {
  rect(ctx, P.c(U.ore), x, y, w, h);
  for (const [sy] of bands(y + 0.6, y + h - 1.4, 3, 1, 0.4)) {
    const odd = Math.round((sy - y) / 3) % 2;
    for (const [sx] of bands(x + 0.6, x + w - 1.4, 3, 1, odd ? 1.5 : 0.4)) circle(ctx, P.c(U.oreLight), sx + 0.6, sy + 0.6, 0.7);
  }
}
