// Procedural art for every structure (Allied and Soviet) in WebRA's "2D
// minimal" look: flat 1996 style seen from straight above with a slight 3/4
// tilt, after the top-down boards of the design canvas (buildings/Basis,
// Productie, Tech, Verdediging). Every surface is one flat colour with at most
// one seam or pattern layer (concrete, roof, steel, brick, canvas, ...); a roof
// shows a darker front wall strip below it; shadows are one hard 30% black
// shape thrown to the bottom right (light from the top left). Each structure
// shows what it does: a building site with scaffold and tower crane, cooling
// towers with steam, a smelter with molten gold, a tank on the factory ramp.
//
// Team colour sits in lamps, flags, cabins and strips along the roofs, never
// on a whole roof: those areas are drawn with P.team(level) (grey in the
// colour pass, white in the mask pass, see sprites.js), and nothing
// translucent is drawn over them inside one sprite (the mask pass draws every
// translucent colour as opaque black, which would cut the team colour away).
//
// Each draw function takes (ctx, P) and paints into its footprint box (cells
// times 24 world pixels, BUILDING_SIZE). Coordinates are the boards' halved.
// Everything is deterministic (no Math.random) and drawn once into the atlas;
// the moving parts (steam, radar, crane trolley, lights) are the animated
// layers in art/animated.js.

import { C, rect, rrect, circle, poly, polyline, ring, hazard, trefoil } from './kit.js';
import { pixelDraw } from './pixel.js';
import { tone } from './volume.js';

const TAU = Math.PI * 2;

// ---- Palette (design canvas "Materialen en kleuren") ---------------------------------

const SHADE = 'rgba(0,0,0,0.3)';
const CONC = '#8d8b80';
const CONC_LINE = '#6c6a61';
const ROOF = '#b8b5a7';
const ROOF_LINE = '#a4a193';
const ROOF_LIT = '#c6c3b6';
const FRONT = '#8a877a'; // front wall strip under a roof
const STEEL = '#70747a';
const STEEL_LINE = '#868b91';
const STEEL_L = '#98a0a8';
const STEEL_D = '#3f4247';
const GUNMETAL = '#55585c';
const BOLT = '#35373a';
const PIT = '#1a1c1f';
const BLACK = '#2b2b28';
const PAINT = '#e8e6dc';
const GLASS = '#5f93ad';
const GLASS_HI = '#bfe3f2';
const DISH = '#c4c7cb';
const BRICK = '#8a4a38';
const BRICK_LINE = '#5e3226';
const DIRT = '#7d6e4c';
const WOOD = '#8a6a3a';
const COPPER = '#b0703a';
const COPPER_L = '#cc8a4e';
const GLOW = '#ffd98a';
const MOLTEN = '#ff9a2a';
const GOLD = '#e6c25a';
const GOLD_D = '#9c7d20';
const RED = '#c23a26';
const SIGNAL = '#e84a3a';
const SCREEN = '#4fd067';
const CYAN = '#7fe0ff';
const ICE = '#e0f8ff';
const WINDSOCK = '#ff7a1a';

/** Team levels: strips and lamps are light so the player's colour reads; shaded halves darker. */
const TEAM = 0.85;
const TEAM_D = 0.62;

/** Footprint of every building art key in cells (width, height), checked against the rules in tests. */
export const BUILDING_SIZE = {
  FACT: [3, 4], POWR: [2, 3], APWR: [3, 3], PROC: [3, 4], SILO: [1, 1], TENT: [2, 3], BARR: [2, 3], KENN: [1, 1],
  WEAP: [3, 3], FIX: [3, 3], DOME: [2, 3], HPAD: [2, 3], AFLD: [3, 2], SYRD: [3, 3], SPEN: [3, 3], ATEK: [2, 3],
  STEK: [3, 3], GAP: [1, 1], PDOX: [2, 2], IRON: [2, 2], MSLO: [2, 1], SBAG: [1, 1], FENC: [1, 1], BRIK: [1, 1],
  PBOX: [1, 1], HBOX: [1, 1], GUN: [1, 1], FTUR: [1, 1], TSLA: [1, 1], AGUN: [1, 1], SAM: [2, 1],
  LROD: [1, 1],
};

// ---- Shapes ----------------------------------------------------------------------------

/** An outlined rectangle: four bars of thickness t centred on its edges. */
function frame(ctx, fill, x, y, w, h, t) {
  rect(ctx, fill, x - t / 2, y - t / 2, w + t, t);
  rect(ctx, fill, x - t / 2, y + h - t / 2, w + t, t);
  rect(ctx, fill, x - t / 2, y + t / 2, t, h - t);
  rect(ctx, fill, x + w - t / 2, y + t / 2, t, h - t);
}

/** A straight stroke with square ends. */
function bar(ctx, style, width, x0, y0, x1, y1) {
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** A dashed straight line (on and off in pixels). */
function dashLine(ctx, style, width, x0, y0, x1, y1, on, off) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  for (let s = 0; s < len; s += on + off) {
    const e = Math.min(len, s + on);
    bar(ctx, style, width, x0 + ux * s, y0 + uy * s, x0 + ux * e, y0 + uy * e);
  }
}

/** A dashed ring of n dashes, each `fill` of its step long, turned by `phase` radians. */
export function dashRing(ctx, style, width, cx, cy, r, n, fill = 0.6, phase = 0) {
  const step = TAU / n;
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  for (let i = 0; i < n; i++) {
    const a = phase + i * step;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a, a + step * fill);
    ctx.stroke();
  }
}

/** Points of a quadratic curve from (x0, y0) over (cx, cy) to (x1, y1), without the start point. */
function curve(x0, y0, cx, cy, x1, y1, n = 8) {
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
  }
  return pts;
}

/** Corners of a w x h rectangle centred on (cx, cy), turned by a radians. */
export function turned(cx, cy, w, h, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pts = [];
  for (const [u, v] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) pts.push(cx + u * c - v * s, cy + u * s + v * c);
  return pts;
}

/** Corners of a regular n-gon (octagonal bunkers). */
function gon(cx, cy, r, n, rot = Math.PI / n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

/** A five pointed star centred on (cx, cy). */
function star(cx, cy, r, inner = 0.42) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * inner : r;
    pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  return pts;
}

/** A closed outline through [x0, y0, x1, y1, ...]. */
function outline(ctx, style, width, pts) {
  polyline(ctx, style, width, [...pts, pts[0], pts[1]]);
}

// ---- Textures --------------------------------------------------------------------------
//
// Each paints the rectangle (x, y, w, h) inside a clip the caller set; seams
// sit on the world grid (multiples of their period), so neighbours join.

const from = (v, step) => Math.floor(v / step) * step;

/** Camouflage colours per biome: base, then three blot colours (dark, light, darkest). */
const CAMO = {
  temperate: ['#4a6234', '#344e24', '#5e7a3e', '#2a3e1c'],
  snow: ['#c3c9cf', '#9aa4ad', '#e3e7eb', '#7d8891'],
  desert: ['#a08a5c', '#7d6a44', '#b9a374', '#5e5034'],
};
export const camoOf = (P) => CAMO[P.biome] ?? CAMO.temperate;

const TEXTURES = {
  concrete(ctx, P, x, y, w, h) {
    rect(ctx, P.c(CONC), x, y, w, h);
    for (let gx = from(x, 12); gx < x + w; gx += 12) rect(ctx, P.c(CONC_LINE), gx, y, 0.5, h);
    for (let gy = from(y, 12); gy < y + h; gy += 12) rect(ctx, P.c(CONC_LINE), x, gy, w, 0.5);
  },
  roof(ctx, P, x, y, w, h) {
    rect(ctx, P.c(ROOF), x, y, w, h);
    for (let gy = from(y, 6); gy < y + h; gy += 6) rect(ctx, P.c(ROOF_LINE), x, gy, w, 0.5);
  },
  steel(ctx, P, x, y, w, h) {
    rect(ctx, P.c(STEEL), x, y, w, h);
    for (let gx = from(x, 4); gx < x + w; gx += 4) rect(ctx, P.c(STEEL_LINE), gx, y, 0.75, h);
  },
  grate(ctx, P, x, y, w, h) {
    rect(ctx, P.c(BOLT), x, y, w, h);
    for (let gy = from(y, 2); gy < y + h; gy += 2) {
      for (let gx = from(x, 2); gx < x + w; gx += 2) rect(ctx, P.c(GUNMETAL), gx, gy, 1, 1);
    }
  },
  asphalt(ctx, P, x, y, w, h) {
    rect(ctx, P.c('#44433e'), x, y, w, h);
    for (let gy = from(y, 3.5); gy < y + h; gy += 3.5) {
      for (let gx = from(x, 4.5); gx < x + w; gx += 4.5) {
        rect(ctx, P.c('#55544e'), gx + 0.6, gy + 0.6, 0.8, 0.8);
        rect(ctx, P.c('#3a3934'), gx + 2.7, gy + 2.2, 0.6, 0.6);
      }
    }
  },
  ore(ctx, P, x, y, w, h) {
    rect(ctx, P.c(C.ore), x, y, w, h);
    for (let gy = from(y, 4); gy < y + h; gy += 4) {
      for (let gx = from(x, 4); gx < x + w; gx += 4) {
        circle(ctx, P.c(GOLD), gx + 1.25, gy + 1.25, 0.8);
        circle(ctx, P.c('#9c7420'), gx + 3, gy + 3, 0.6);
      }
    }
  },
  brick(ctx, P, x, y, w, h) {
    rect(ctx, P.c(BRICK), x, y, w, h);
    for (let gy = from(y, 2); gy < y + h; gy += 2) {
      rect(ctx, P.c(BRICK_LINE), x, gy, w, 0.5);
      const off = Math.round(gy / 2) % 2 ? 4 : 0;
      for (let gx = from(x, 8) + off - 8; gx < x + w; gx += 8) rect(ctx, P.c(BRICK_LINE), gx, gy, 0.5, 2);
    }
  },
  canvas(ctx, P, x, y, w, h) {
    rect(ctx, P.c(C.canvas), x, y, w, h);
    for (let d = from(x - h, 3); d < x + w; d += 3) bar(ctx, P.c('#7a7a4e'), 0.6, d, y + h, d + h, y);
  },
  tiles(ctx, P, x, y, w, h) {
    rect(ctx, P.c('#8a3a2a'), x, y, w, h);
    for (let gy = from(y, 3); gy < y + h; gy += 3) rect(ctx, P.c('#5e2418'), x, gy + 2.5, w, 0.5);
  },
  wood(ctx, P, x, y, w, h) {
    rect(ctx, P.c(WOOD), x, y, w, h);
    for (let gx = from(x, 3); gx < x + w; gx += 3) rect(ctx, P.c('#5e4624'), gx, y, 0.5, h);
  },
  glass(ctx, P, x, y, w, h) {
    rect(ctx, P.c(GLASS), x, y, w, h);
    for (let gy = from(y, 8); gy < y + h; gy += 8) {
      for (let gx = from(x, 8); gx < x + w; gx += 8) bar(ctx, P.c(GLASS_HI), 0.75, gx + 1, gy + 5, gx + 5, gy + 1);
    }
    for (let gx = from(x, 8); gx < x + w; gx += 8) rect(ctx, P.c(STEEL_L), gx, y, 0.5, h);
    for (let gy = from(y, 8); gy < y + h; gy += 8) rect(ctx, P.c(STEEL_L), x, gy, w, 0.5);
  },
  sand(ctx, P, x, y, w, h) {
    rect(ctx, P.c(C.canvasDark), x, y, w, h);
    for (let gy = from(y, 3.5); gy < y + h; gy += 3.5) {
      const off = Math.round(gy / 3.5) % 2 ? 3 : 0;
      for (let gx = from(x, 6) + off - 6; gx < x + w; gx += 6) rrect(ctx, P.c('#a09e6c'), gx + 0.25, gy + 0.25, 5.5, 2.75, 1.25);
    }
  },
  hazard(ctx, P, x, y, w, h) {
    rect(ctx, P.c(C.yellow), x, y, w, h);
    for (let s = from(x - h, 5); s < x + w; s += 5) poly(ctx, P.c(BLACK), [s, y + h, s + 2.5, y + h, s + 2.5 + h, y, s + h, y]);
  },
  mesh(ctx, P, x, y, w, h) {
    for (let d = from(x - h, 3); d < x + w; d += 3) {
      bar(ctx, P.c(STEEL_L), 0.4, d, y, d + h, y + h);
      bar(ctx, P.c(STEEL_L), 0.4, d, y + h, d + h, y);
    }
  },
  camo(ctx, P, x, y, w, h) {
    const [base, dark, light, darkest] = camoOf(P);
    rect(ctx, P.c(base), x, y, w, h);
    for (let gy = from(y, 10); gy < y + h; gy += 10) {
      for (let gx = from(x, 10); gx < x + w; gx += 10) {
        circle(ctx, P.c(dark), gx + 2.5, gy + 3, 2);
        circle(ctx, P.c(light), gx + 7.5, gy + 7, 2.5);
        circle(ctx, P.c(darkest), gx + 7, gy + 1.5, 1.25);
      }
    }
  },
};

function texRect(ctx, P, kind, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  TEXTURES[kind](ctx, P, x, y, w, h);
  ctx.restore();
}

function texDisc(ctx, P, kind, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();
  TEXTURES[kind](ctx, P, cx - r, cy - r, 2 * r, 2 * r);
  ctx.restore();
}

function texPoly(ctx, P, kind, pts) {
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
  ctx.clip();
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  TEXTURES[kind](ctx, P, x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0);
  ctx.restore();
}

function texRound(ctx, P, kind, x, y, w, h, r) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.clip();
  TEXTURES[kind](ctx, P, x, y, w, h);
  ctx.restore();
}

// ---- Building parts ----------------------------------------------------------------------

/**
 * A roofed hall: roof (x, y, w, h) seen from above, the front wall strip
 * (wallH high) below it and the hard shadow behind both. o.roof is the
 * roof's texture, o.wall the wall colour; o.top / o.bottom draw team strips
 * that thick along the roof's north and south edges.
 */
function hall(ctx, P, x, y, w, h, wallH, o = {}) {
  if (o.shadow !== false) rect(ctx, P.c(SHADE), x + 3, y + 3, w, h + wallH);
  const wall = o.wall ?? FRONT;
  if (wallH > 0) {
    rect(ctx, P.c(wall), x, y + h, w, wallH);
    rect(ctx, P.c(tone(wall, -0.3)), x, y + h + wallH - 0.75, w, 0.75);
  }
  texRect(ctx, P, o.roof ?? 'roof', x, y, w, h);
  if ((o.roof ?? 'roof') === 'roof') rect(ctx, P.c(ROOF_LIT), x, y, w, 0.75);
  if (o.top) rect(ctx, P.team(TEAM), x, y, w, o.top);
  if (o.bottom) rect(ctx, P.team(TEAM), x, y + h - o.bottom, w, o.bottom);
}

/** A hard round shadow (offset to the bottom right). */
function shadowDisc(ctx, P, cx, cy, r, off = 2) {
  circle(ctx, P.c(SHADE), cx + off, cy + off, r);
}

/** A team coloured lamp. */
function teamDot(ctx, P, x, y, r) {
  circle(ctx, P.team(TEAM), x, y, r);
  circle(ctx, P.team(1), x - r * 0.3, y - r * 0.3, r * 0.35);
}

/** A lightning bolt sign: yellow with a black edge. */
function boltSign(ctx, P, pts) {
  poly(ctx, P.c(C.yellow), pts);
  outline(ctx, P.c(BLACK), 0.5, pts);
}

/** A transformer box with copper coils (glowing cores) seen from above. */
function transformer(ctx, P, x, y, w, h, coils) {
  rect(ctx, P.c(STEEL_D), x, y, w, h);
  for (const [cx, cy, r] of coils) {
    circle(ctx, P.c(COPPER), cx, cy, r);
    circle(ctx, P.c(GLOW), cx, cy, r * 0.4);
  }
}

/** Stacked sandbags as a block of the sand texture. */
function sandbags(ctx, P, x, y, w, h) {
  texRect(ctx, P, 'sand', x, y, w, h);
}

/** A gold bar seen from above. */
function goldBar(ctx, P, x, y, light = false) {
  rect(ctx, P.c(GOLD_D), x, y, 6, 3.5);
  rect(ctx, P.c(light ? '#f0d67a' : GOLD), x + 0.5, y + 0.5, 5, 2.5);
}

// ---- Buildings --------------------------------------------------------------------------

export const BUILDING_DRAW = {
  // Construction yard 3x4: the assembly hall and, beside it, the building
  // site: scaffold around a half built block and a tower crane whose jib
  // reaches over both (its trolley and load move: art/animated.js).
  FACT: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 72, 72, 24);
    polyline(ctx, P.c(PAINT), 1.5, [30, 80, 36, 86, 42, 80]);
    texRect(ctx, P, 'concrete', 39, 7, 31, 62);
    hazard(ctx, P, 39, 66, 31, 3, 2.5);
    hall(ctx, P, 3, 5, 33, 56, 9, { top: 2.5, bottom: 2.5 });
    hazard(ctx, P, 9, 62, 18, 8, 2.5);
    rect(ctx, P.c(PIT), 11, 62, 14, 1);
    // half built block, its bolts showing
    rect(ctx, P.c(SHADE), 48, 28, 17, 22);
    rect(ctx, P.c(C.concreteLight), 46, 26, 17, 22);
    rect(ctx, P.c(ROOF_LIT), 46, 26, 17, 2);
    for (const [x, y] of [[47.5, 27.5], [61.5, 27.5], [47.5, 46.5], [61.5, 46.5]]) circle(ctx, P.c(GUNMETAL), x, y, 0.75);
    // scaffold
    frame(ctx, P.c(C.yellow), 42.5, 12, 24, 52, 1.5);
    dashLine(ctx, P.c(GOLD_D), 0.75, 42.5, 38, 66.5, 38, 2, 1.5);
    dashLine(ctx, P.c(GOLD_D), 0.75, 54.5, 12, 54.5, 64, 2, 1.5);
    for (const [x, y] of [[41, 10.5], [65, 10.5], [41, 62.5], [65, 62.5]]) rect(ctx, P.c(GOLD_D), x, y, 3, 3);
    // tower crane: base on the hall, jib with its lattice, team cabin
    rect(ctx, P.c(STEEL_D), 2, 13.5, 7, 5);
    rect(ctx, P.c(GOLD_D), 5, 14.5, 57, 3);
    rect(ctx, P.c(C.yellow), 5, 14.75, 57, 1.5);
    const zig = [];
    for (let x = 15, k = 0; x <= 57; x += 3, k++) zig.push(x, k % 2 ? 16.5 : 15.5);
    polyline(ctx, P.c(GOLD_D), 0.5, zig);
    rect(ctx, P.team(TEAM), 9.5, 13, 6, 6);
    rect(ctx, P.c(GLASS), 10.5, 17, 4, 1.2);
    teamDot(ctx, P, 4, 75, 1.5);
    teamDot(ctx, P, 68, 75, 1.5);
  },

  // Power plant 2x3: two cooling towers (their steam rises: art/animated.js),
  // a lightning sign, and a transformer and pole on the apron.
  POWR: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 52, 48, 20);
    hall(ctx, P, 3, 4, 40, 39, 7, { top: 2.5, bottom: 2.5 });
    boltSign(ctx, P, [25, 29, 18, 36, 22.5, 36, 19.5, 42, 29, 34, 24.5, 34, 27.5, 29]);
    hazard(ctx, P, 30, 44, 10, 6, 2.5);
    for (const x of [13, 31]) {
      shadowDisc(ctx, P, x, 17, 8.5);
      circle(ctx, P.c(STEEL_L), x, 17, 8);
      ring(ctx, P.c('#b4bac0'), x, 17, 7.2, 0.6);
      circle(ctx, P.c(GUNMETAL), x, 17, 5.5);
    }
    // pole with insulators, wired to the transformer
    bar(ctx, P.c(BLACK), 0.5, 8, 58, 28, 58);
    bar(ctx, P.c(GUNMETAL), 1.25, 5, 56, 5, 70);
    bar(ctx, P.c(GUNMETAL), 1.25, 2, 58, 8, 58);
    circle(ctx, P.c(PAINT), 2, 58, 1);
    circle(ctx, P.c(PAINT), 8, 58, 1);
    transformer(ctx, P, 28, 54, 17, 12, [[33, 60, 2.5], [40, 60, 2.5]]);
  },

  // Advanced power plant 3x3: two reactors in glowing rings (they pulse:
  // art/animated.js), a coil column, a lightning sign, two transformers.
  APWR: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 56, 72, 16);
    hall(ctx, P, 3, 4, 66, 42, 7, { top: 2.5, bottom: 2.5 });
    rect(ctx, P.c(STEEL_D), 31.5, 10, 9, 25);
    for (const y of [15, 22.5, 30]) {
      circle(ctx, P.c(COPPER), 36, y, 2);
      circle(ctx, P.c(GLOW), 36, y, 0.9);
    }
    boltSign(ctx, P, [38, 35, 31, 41, 35, 41, 32, 46, 41, 39, 37, 39, 40, 35]);
    for (const x of [20, 52]) {
      shadowDisc(ctx, P, x, 22, 13);
      circle(ctx, P.c(C.steelLight), x, 22, 12.5);
      circle(ctx, P.c(DISH), x, 22, 11);
      ctx.fillStyle = P.c('#e2e5e8');
      ctx.beginPath();
      ctx.ellipse(x - 3.5, 18, 5, 3.5, 0, 0, TAU);
      ctx.fill();
      teamDot(ctx, P, x, 22, 2);
    }
    shadowDisc(ctx, P, 65, 8, 3, 1.5);
    circle(ctx, P.c(STEEL_L), 65, 8, 3);
    circle(ctx, P.c(GUNMETAL), 65, 8, 1.8);
    // a wisp of steam over the stack, flat and opaque (it crosses the team strip)
    circle(ctx, P.c('#dfe4e7'), 63.6, 6, 2.8);
    circle(ctx, P.c('#f2f6f8'), 62.9, 5.3, 1.6);
    hazard(ctx, P, 10, 47, 15, 6, 2.5);
    transformer(ctx, P, 5, 58, 13, 10, [[11.5, 63, 2]]);
    transformer(ctx, P, 54, 58, 13, 10, [[60.5, 63, 2]]);
  },

  // Ore refinery 3x4: ore comes up the conveyor into the smelter hall, the
  // furnace glows (and smokes: art/animated.js), molten gold pours out, and
  // the yard holds a crucible, gold bars and gems.
  PROC: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 64, 72, 32);
    texRect(ctx, P, 'asphalt', 24, 64, 24, 32);
    texRect(ctx, P, 'grate', 28, 75, 16, 10);
    texDisc(ctx, P, 'ore', 36, 80, 4);
    rect(ctx, P.c(STEEL_D), 33, 60, 6, 15);
    for (const y of [63, 66, 69, 72]) rect(ctx, P.c(GUNMETAL), 33, y - 0.375, 6, 0.75);
    hall(ctx, P, 3, 4, 42, 50, 8, { top: 2.5, bottom: 2.5 });
    texRect(ctx, P, 'steel', 7, 10, 34, 22);
    rect(ctx, P.team(TEAM), 7, 19, 34, 3);
    // furnace
    texRect(ctx, P, 'brick', 30, 37, 10, 10);
    rect(ctx, P.c(MOLTEN), 32.5, 39.5, 5, 5);
    rect(ctx, P.c(MOLTEN), 7, 56, 15, 4);
    rect(ctx, P.c(GLOW), 9, 57, 9, 1);
    // ore tanks
    for (const y of [18, 46]) {
      shadowDisc(ctx, P, 58, y, 10.5);
      circle(ctx, P.c(STEEL_L), 58, y, 10);
      ring(ctx, P.team(TEAM), 58, y, 9, 1.5);
      texDisc(ctx, P, 'ore', 58, y, 5.5);
    }
    // the riches: bars, gems, the crucible pouring into moulds
    goldBar(ctx, P, 4, 74);
    goldBar(ctx, P, 11, 74);
    goldBar(ctx, P, 7.5, 70.5, true);
    poly(ctx, P.c('#4a7ac4'), [6, 85, 8.5, 82, 11, 85, 8.5, 89]);
    poly(ctx, P.c('#c84a9a'), [13, 87, 15.5, 84, 18, 87, 15.5, 91]);
    poly(ctx, P.c('#3ab0a0'), [17, 81, 19, 78.5, 21, 81, 19, 84]);
    circle(ctx, P.c(STEEL_D), 60, 79, 6.5);
    circle(ctx, P.c(MOLTEN), 60, 79, 4.5);
    circle(ctx, P.c(GLOW), 58.5, 77.5, 1.5);
    bar(ctx, P.c(MOLTEN), 1.5, 60, 85.5, 60, 89);
    goldBar(ctx, P, 52, 89);
    goldBar(ctx, P, 60.5, 89);
  },

  // Silo 1x1: a round ore tank with a team ring and a hatch.
  SILO: (ctx, P) => {
    shadowDisc(ctx, P, 12, 12, 9.5, 1.5);
    circle(ctx, P.c(STEEL), 12, 12, 9.5);
    circle(ctx, P.c(STEEL_L), 12, 12, 8);
    texDisc(ctx, P, 'ore', 12, 12, 5);
    ring(ctx, P.c(GUNMETAL), 12, 12, 5, 0.75);
    ring(ctx, P.team(TEAM), 12, 12, 9, 1.25);
    rect(ctx, P.c(BOLT), 10.5, 2.5, 3, 2.5);
  },

  // Allied barracks 2x3: a canvas tent, a team band over both halves, a flag.
  TENT: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 60, 48, 12);
    rect(ctx, P.c(SHADE), 8, 10, 38, 44);
    texRect(ctx, P, 'canvas', 5, 7, 38, 44);
    rect(ctx, P.c('rgba(0,0,0,0.14)'), 24, 7, 19, 44);
    rect(ctx, P.team(TEAM), 5, 23, 19, 4);
    rect(ctx, P.team(TEAM_D), 24, 23, 19, 4);
    bar(ctx, P.c('#5a5a38'), 1.5, 24, 7, 24, 51);
    poly(ctx, P.c(BLACK), [19, 51, 24, 44, 29, 51]);
    sandbags(ctx, P, 2, 53, 16, 6);
    sandbags(ctx, P, 30, 53, 16, 6);
    bar(ctx, P.c(BOLT), 1, 41, 2, 41, 14);
    rect(ctx, P.team(TEAM), 41, 2, 6, 4);
  },

  // Soviet barracks 2x3: brick walls under a tiled roof with team stripes and
  // a chimney (its smoke: art/animated.js).
  BARR: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 56, 48, 16);
    rect(ctx, P.c(SHADE), 7, 8, 40, 47);
    texRect(ctx, P, 'brick', 4, 46, 40, 7);
    texRect(ctx, P, 'tiles', 3, 4, 42, 43);
    rect(ctx, P.c('rgba(0,0,0,0.18)'), 24, 4, 21, 43);
    bar(ctx, P.c('#5e2418'), 1.5, 24, 4, 24, 47);
    for (const x of [8, 15]) rect(ctx, P.team(TEAM), x, 4, 3, 43);
    for (const x of [30, 37]) rect(ctx, P.team(TEAM_D), x, 4, 3, 43);
    texRect(ctx, P, 'brick', 11, 11, 6, 6);
    rect(ctx, P.c(BLACK), 12.5, 12.5, 3, 3);
    rect(ctx, P.c('#6a4a2e'), 19, 47, 10, 6);
    sandbags(ctx, P, 2, 57, 14, 5);
    sandbags(ctx, P, 32, 57, 14, 5);
  },

  // Kennel 1x1: a wooden hut with a team ridge, an arched door and a bowl.
  KENN: (ctx, P) => {
    rect(ctx, P.c(SHADE), 6, 6, 16, 16);
    texRect(ctx, P, 'wood', 4, 4, 8, 14);
    rect(ctx, P.c('#6e5230'), 12, 4, 8, 14);
    rect(ctx, P.team(TEAM), 11.25, 4, 1.5, 14);
    rect(ctx, P.c('#5e4624'), 4, 18, 16, 3);
    poly(ctx, P.c('#141414'), [9.5, 21, 9.5, 19.5, ...curve(9.5, 19.5, 12, 17, 14.5, 19.5), 14.5, 21]);
    circle(ctx, P.c(RED), 20, 22, 1.5);
  },

  // War factory 3x3: a steel shed with team bands, the open bay, and the
  // ramp down onto the asphalt (left clear: the units it builds roll out there).
  WEAP: (ctx, P) => {
    texRect(ctx, P, 'asphalt', 0, 52, 72, 20);
    polyline(ctx, P.c(PAINT), 1.5, [7, 58, 11, 62, 7, 66]);
    polyline(ctx, P.c(PAINT), 1.5, [62, 58, 66, 62, 62, 66]);
    hall(ctx, P, 3, 4, 66, 41, 7, { top: 2.5 });
    texRect(ctx, P, 'steel', 12, 8, 48, 31);
    rect(ctx, P.team(TEAM), 12, 17, 48, 3);
    rect(ctx, P.team(TEAM), 12, 28, 48, 3);
    rect(ctx, P.c(STEEL_D), 12, 23, 48, 1);
    // the ramp: a concrete slab with grooves and yellow edges, out of the bay
    rect(ctx, P.c(CONC), 21, 52, 30, 18);
    for (const y of [55, 58.5, 62, 65.5]) rect(ctx, P.c(CONC_LINE), 22, y, 28, 0.5);
    rect(ctx, P.c(C.yellow), 21, 52, 1, 18);
    rect(ctx, P.c(C.yellow), 50, 52, 1, 18);
    rect(ctx, P.c(C.yellow), 19, 44, 34, 8);
    rect(ctx, P.c(PIT), 21, 45, 30, 7);
  },

  // Service depot 3x3: a hexagonal repair pad in hazard paint with a big
  // wrench, two crane arms, and the workshop behind.
  FIX: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 0, 72, 72);
    hall(ctx, P, 21, 2, 29, 12, 3, { top: 2, bottom: 2 });
    texPoly(ctx, P, 'hazard', [36, 17, 58.5, 30, 58.5, 56, 36, 69, 13.5, 56, 13.5, 30]);
    texPoly(ctx, P, 'asphalt', [36, 21, 55, 32, 55, 54, 36, 65, 17, 54, 17, 32]);
    const wrench = [-0.2, -0.1, -0.2, -0.28, -0.08, -0.38, -0.08, -0.22, 0.08, -0.22, 0.08, -0.38, 0.2, -0.28, 0.2, -0.1, 0.07, 0.02, 0.07, 0.42, 0, 0.48, -0.07, 0.42, -0.07, 0.02];
    const k = Math.SQRT1_2 * 36;
    const pts = [];
    for (let i = 0; i < wrench.length; i += 2) pts.push(36 + (wrench[i] - wrench[i + 1]) * k, 43 + (wrench[i] + wrench[i + 1]) * k);
    poly(ctx, P.c(PAINT), pts);
    for (const [x0, x1] of [[9, 23], [63, 49]]) {
      bar(ctx, P.c(GOLD_D), 3, x0, 4, x1, 31);
      bar(ctx, P.c(C.yellow), 1.5, x0, 3, x1, 30);
      circle(ctx, P.c(GUNMETAL), x0, 4, 3);
      circle(ctx, P.c(C.steelLight), x0 - 0.8, 3.2, 1);
    }
  },

  // Radar dome 2x3: a big dome in a team ring with screens in the front wall
  // and an antenna; the radar sweep turns over the dome (art/animated.js).
  DOME: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 60, 48, 12);
    hall(ctx, P, 3, 4, 40, 48, 7, { top: 2, bottom: 2 });
    rect(ctx, P.c(SCREEN), 6, 53.5, 11, 3.5);
    rect(ctx, P.c(SCREEN), 29, 53.5, 11, 3.5);
    shadowDisc(ctx, P, 22, 31, 17);
    circle(ctx, P.team(TEAM), 22, 31, 17);
    circle(ctx, P.c(DISH), 22, 31, 15);
    const meridian = (pts) => polyline(ctx, P.c(STEEL_L), 0.6, pts);
    meridian([7, 31, ...curve(7, 31, 22, 25, 37, 31)]);
    meridian([7, 31, ...curve(7, 31, 22, 37, 37, 31)]);
    meridian([22, 16, ...curve(22, 16, 16, 31, 22, 46)]);
    meridian([22, 16, ...curve(22, 16, 28, 31, 22, 46)]);
    ring(ctx, P.c('rgba(79,208,103,0.6)'), 22, 31, 10, 0.5);
    ring(ctx, P.c('rgba(79,208,103,0.6)'), 22, 31, 5, 0.5);
    ctx.fillStyle = P.c('rgba(226,229,232,0.8)');
    ctx.beginPath();
    ctx.ellipse(16.5, 24, 5, 3.5, 0, 0, TAU);
    ctx.fill();
    // the antenna on its post (the sweep over the dome turns: art/animated.js)
    rect(ctx, P.c(GUNMETAL), 37.5, 6, 3, 3);
    const th = -0.44;
    poly(ctx, P.c(STEEL_L), turned(39, 7.5, 17, 4.5, th));
    for (const u of [-6.5, -3.5, -0.5, 2.5, 5.5]) {
      const [c, sn] = [Math.cos(th), Math.sin(th)];
      bar(ctx, P.c(STEEL_D), 0.5, 39 + u * c + 2.1 * sn, 7.5 + u * sn - 2.1 * c, 39 + u * c - 2.1 * sn, 7.5 + u * sn + 2.1 * c);
    }
    teamDot(ctx, P, 39, 7.5, 1);
  },

  // Helipad 2x3: a team rimmed pad with a light ring and the H, a hut with a
  // beacon, a fuel tank and a windsock (the landing lights chase: art/animated.js).
  HPAD: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 0, 48, 72);
    hall(ctx, P, 4, 2, 19, 13, 3, { top: 2 });
    rect(ctx, P.c(GLASS), 6, 15.5, 15, 2);
    circle(ctx, P.c(RED), 13.5, 8, 1.5);
    shadowDisc(ctx, P, 38, 10, 5.5, 1.5);
    circle(ctx, P.c(STEEL_L), 38, 10, 5.5);
    circle(ctx, P.c('#b8442e'), 38, 10, 3.5);
    circle(ctx, P.team(TEAM), 24, 46, 21);
    texDisc(ctx, P, 'asphalt', 24, 46, 19);
    ring(ctx, P.c(PAINT), 24, 46, 16.5, 1.5);
    for (const [x0, y0, x1, y1] of [[18, 38, 18, 54], [30, 38, 30, 54], [18, 46, 30, 46]]) bar(ctx, P.c(PAINT), 3, x0, y0, x1, y1);
    for (const [x, y] of HPAD_LIGHTS) circle(ctx, P.c('#8a7a4a'), x, y, 1.25);
    circle(ctx, P.c(PAINT), 44, 68, 1);
    poly(ctx, P.c(WINDSOCK), [44, 68, 40, 64, 38.5, 65.5]);
  },

  // Airfield 3x2: a runway with edge, end and approach lights, the hangar and
  // a glass control tower with its beacon lit (the edge lights chase:
  // art/animated.js).
  AFLD: (ctx, P) => {
    texRect(ctx, P, 'asphalt', 0, 0, 72, 48);
    frame(ctx, P.c(BLACK), 0.5, 0.5, 71, 47, 1);
    rect(ctx, P.c(SHADE), 4, 2.5, 25, 15);
    texRect(ctx, P, 'steel', 2, 1, 25, 14);
    rect(ctx, P.team(TEAM), 2, 6, 25, 2.5);
    rect(ctx, P.c(PIT), 6, 14, 17, 2);
    bar(ctx, P.c(PAINT), 0.75, 3, 23, 69, 23);
    bar(ctx, P.c(PAINT), 0.75, 3, 45, 69, 45);
    dashLine(ctx, P.c(PAINT), 1, 15, 34, 68, 34, 5, 4);
    for (const x of [4.5, 7, 9.5, 12]) bar(ctx, P.c(PAINT), 1.25, x, 26, x, 42);
    for (const y of AFLD_LIGHT_ROWS) {
      circle(ctx, P.c('#5ef08a'), 3, y, 1.1);
      circle(ctx, P.c(SIGNAL), 69, y, 1.1);
      for (const x of AFLD_LIGHTS) circle(ctx, P.c('#8a7a4a'), x, y, 0.75);
    }
    for (const y of [30, 34, 38]) circle(ctx, P.c('#6ab0ff'), 1, y, 0.9);
    bar(ctx, P.c(PAINT), 0.75, 39, 7, 39, 11);
    poly(ctx, P.c(WINDSOCK), [39, 7, 46, 8, 46, 9.5, 39, 10]);
    rect(ctx, P.c(SHADE), 57, 4, 13, 13);
    rect(ctx, P.c(GLASS), 55, 2, 13, 13);
    bar(ctx, P.c(GLASS_HI), 0.75, 55.8, 6, 59, 2.8);
    rect(ctx, P.team(TEAM), 57, 4, 9, 9);
    circle(ctx, P.c('#c9a050'), 61.5, 8.5, 1.9);
    circle(ctx, P.c(GLOW), 61.5, 8.5, 1.3);
  },

  // Allied tech center 2x3: a lab under a glass roof, a satellite dish and an
  // antenna mast (the dish turns, the mast lamp blinks: art/animated.js).
  ATEK: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 61, 48, 11);
    hall(ctx, P, 3, 4, 40, 48, 7, { top: 2 });
    texRect(ctx, P, 'glass', 7, 22, 32, 26);
    frame(ctx, P.c(STEEL_L), 7, 22, 32, 26, 1);
    rect(ctx, P.team(TEAM), 3, 20, 40, 2);
    rect(ctx, P.c(GLASS), 5, 53.5, 36, 3);
    shadowDisc(ctx, P, 24, 11.5, 6.5);
    circle(ctx, P.c(DISH), 24, 11.5, 6.5);
    ring(ctx, P.c(STEEL_L), 24, 11.5, 4.5, 0.6);
    circle(ctx, P.c(GUNMETAL), 24, 11.5, 1);
    bar(ctx, P.c(BOLT), 1, 9, 7, 9, 15);
    teamDot(ctx, P, 9, 7, 1.5);
  },

  // Soviet tech center 3x3: a brick block with a team emblem and a star, an
  // antenna block with a red light (it blinks: art/animated.js).
  STEK: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 59, 72, 13);
    hall(ctx, P, 3, 4, 66, 46, 7, { roof: 'brick', wall: BRICK_LINE });
    hall(ctx, P, 8, 9, 35, 35, 0, { top: 2.5, bottom: 2.5, shadow: false });
    rect(ctx, P.team(TEAM), 18, 19, 15, 15);
    poly(ctx, P.c(PAINT), [25.5, 21, 27, 25, 31, 25, 28, 27.5, 29, 31.5, 25.5, 29, 22, 31.5, 23, 27.5, 20, 25, 24, 25]);
    rect(ctx, P.c(SHADE), 48, 15, 14, 14);
    texRect(ctx, P, 'steel', 46, 13, 14, 14);
    rect(ctx, P.c(STEEL_L), 49.5, 16.5, 7, 7);
    circle(ctx, P.c('#5a1d16'), 53, 20, 2);
    texRect(ctx, P, 'hazard', 29, 51, 14, 6);
  },


  // Naval yard 3x3: team quays around open water (the water stays the map's),
  // a team roofed shed, a crane with its cabin, a buoy.
  SYRD: (ctx, P) => {
    rect(ctx, P.c(SHADE), 2, 2, 70, 20);
    texRect(ctx, P, 'concrete', 0, 0, 72, 18);
    texRect(ctx, P, 'concrete', 0, 18, 13, 54);
    texRect(ctx, P, 'concrete', 59, 18, 13, 54);
    rect(ctx, P.team(TEAM), 13, 15.5, 46, 2.5);
    rect(ctx, P.team(TEAM), 10.5, 18, 2.5, 50);
    rect(ctx, P.team(TEAM), 59, 18, 2.5, 50);
    hazard(ctx, P, 0, 68, 13, 4, 2.5);
    hazard(ctx, P, 59, 68, 13, 4, 2.5);
    // the shed: a team roof with its seams, the front wall below
    rect(ctx, P.c(FRONT), 4, 13, 20, 2.5);
    rect(ctx, P.team(0.8), 4, 2, 20, 11);
    for (let y = 5; y < 13; y += 3) rect(ctx, P.team(0.7), 4, y, 20, 0.5);
    // crane over the water
    bar(ctx, P.c(GOLD_D), 3, 45, 9, 45, 37);
    bar(ctx, P.c(C.yellow), 1.5, 44, 9, 44, 37);
    rect(ctx, P.team(TEAM), 41, 5, 8, 7);
    rect(ctx, P.c(GLASS), 42, 10, 6, 1.2);
    bar(ctx, P.c(BLACK), 0.75, 45, 37, 45, 43);
    rect(ctx, P.c(STEEL_D), 43.5, 43, 3, 2);
    circle(ctx, P.team(TEAM), 36, 62, 3);
    circle(ctx, P.c(GLOW), 36, 62, 1);
  },

  // Sub pen 3x3: a rounded concrete pen with team stripes on its roof and a
  // team rim around the dark opening to the water, buoys either side.
  SPEN: (ctx, P) => {
    rrect(ctx, P.c(SHADE), 7, 7, 64, 48, 11);
    rrect(ctx, P.c(CONC), 4, 4, 64, 48, 11);
    texRound(ctx, P, 'roof', 8, 7, 56, 35, 8);
    rect(ctx, P.team(TEAM), 8, 14, 56, 4);
    rect(ctx, P.team(TEAM), 8, 28, 56, 4);
    poly(ctx, P.team(TEAM), [20, 52, 20, 38, ...curve(20, 38, 36, 26, 52, 38), 52, 52]);
    poly(ctx, P.c('#0e1a22'), [22, 52, 22, 39, ...curve(22, 39, 36, 28, 50, 39), 50, 52]);
    poly(ctx, P.c('#26323a'), [30, 52, 30, 45, ...curve(30, 45, 36, 40, 42, 45), 42, 52]);
    teamDot(ctx, P, 12, 62, 3);
    teamDot(ctx, P, 60, 62, 3);
  },

  // Gap generator 1x1: an emitter under a dark veil with noise at its edges
  // (the jamming rings turn: art/animated.js).
  GAP: (ctx, P) => {
    texRect(ctx, P, 'concrete', 4, 4, 16, 16);
    circle(ctx, P.c('rgba(26,42,58,0.5)'), 12, 12, 11.5);
    rect(ctx, P.team(TEAM_D), 4, 18, 16, 2);
    circle(ctx, P.c('#e4ebf0'), 12, 12, 4.5);
    circle(ctx, P.c(CYAN), 12, 12, 2);
    polyline(ctx, P.c(CYAN), 0.6, [1.5, 8, 3, 9.5, 1.5, 11, 3, 12.5, 1.5, 14]);
    polyline(ctx, P.c(CYAN), 0.6, [22.5, 10, 21, 11.5, 22.5, 13, 21, 14.5, 22.5, 16]);
  },

  // Chronosphere 2x2: a portal well with a light core and a ghost block on
  // its way, four team pylons (the portal rings turn: art/animated.js).
  PDOX: (ctx, P) => {
    texRound(ctx, P, 'concrete', 1, 1, 46, 46, 5);
    shadowDisc(ctx, P, 24, 24, 20);
    circle(ctx, P.c(GUNMETAL), 24, 24, 20);
    circle(ctx, P.c(STEEL_L), 24, 24, 17);
    circle(ctx, P.c('#23363f'), 24, 24, 14);
    ctx.strokeStyle = P.c(ICE);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(24, 24, 6, -Math.PI / 2, Math.PI);
    ctx.stroke();
    circle(ctx, P.c(ICE), 24, 24, 4);
    rect(ctx, P.c('rgba(127,224,255,0.4)'), 27, 15, 8, 8);
    for (const [x0, y0, x1, y1] of [[27, 15, 35, 15], [35, 15, 35, 23], [35, 23, 27, 23], [27, 23, 27, 15]]) dashLine(ctx, P.c(ICE), 0.5, x0, y0, x1, y1, 1, 1);
    for (const [x, y] of [[21.5, 2], [21.5, 41], [2, 21.5], [41, 21.5]]) {
      rect(ctx, P.c(GUNMETAL), x, y, 5, 5);
      rect(ctx, P.team(TEAM), x + 1, y + 1, 3, 3);
    }
  },

  // Iron curtain 2x2: a fan of curtain panels around the projector (its
  // hexagonal force field pulses: art/animated.js), four team posts.
  IRON: (ctx, P) => {
    texRect(ctx, P, 'concrete', 1, 1, 46, 46);
    for (const [cx, cy, deg] of [[12, 14, -50], [18.5, 10, -25], [24, 8.5, 0], [29.5, 10, 25], [36, 14, 50]]) {
      const pts = turned(cx, cy, 5, 8, (deg * Math.PI) / 180);
      poly(ctx, P.c(SHADE), pts.map((v) => v + 1));
      poly(ctx, P.c(STEEL_L), pts);
    }
    rect(ctx, P.c(SHADE), 16, 20, 17, 15);
    texRect(ctx, P, 'steel', 15, 19, 18, 15);
    circle(ctx, P.c(BLACK), 24, 26.5, 3.5);
    circle(ctx, P.c(SIGNAL), 24, 26.5, 1.75);
    for (const [x, y] of [[2, 2], [40, 2], [2, 40], [40, 40]]) {
      rect(ctx, P.c(GUNMETAL), x, y, 6, 6);
      rect(ctx, P.team(TEAM), x + 1.5, y + 1.5, 3, 3);
    }
  },

  // Missile silo 2x1: the hatch in a hazard frame (its doors slide into the
  // steel housings at a launch, showing the missile: art/animated.js), a
  // radiation sign, a team edge and a warning lamp.
  MSLO: (ctx, P) => {
    texRect(ctx, P, 'concrete', 0, 0, 48, 24);
    rect(ctx, P.team(TEAM), 0, 22, 48, 2);
    hazard(ctx, P, 12, 3, 24, 18, 2.5);
    for (const x of [2, 35]) {
      rect(ctx, P.c(SHADE), x + 1, 5, 11, 16);
      texRect(ctx, P, 'steel', x, 4, 11, 16);
    }
    siloHatch(ctx, P, 0);
    circle(ctx, P.c(C.yellow), 40.5, 12, 4);
    trefoil(ctx, P, 40.5, 12, 3.5);
    circle(ctx, P.c(SIGNAL), 4, 2, 1.25);
  },

  // Sandbags 1x1: a band of stacked bags, tiling sideways.
  SBAG: (ctx, P) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 24, 24);
    ctx.clip();
    rect(ctx, P.c(SHADE), 1.5, 8.5, 24, 10);
    TEXTURES.sand(ctx, P, 0, 7, 24, 10);
    rect(ctx, P.c('#5a5a38'), 0, 6.6, 24, 0.75);
    rect(ctx, P.c('#5a5a38'), 0, 16.6, 24, 0.75);
    ctx.restore();
  },

  // Wire fence 1x1: diamond mesh between rails, a post where the runs meet
  // (joins neighbours on all four sides).
  FENC: (ctx, P) => {
    rect(ctx, P.c('rgba(0,0,0,0.25)'), 12, 12, 3, 3);
    texRect(ctx, P, 'mesh', 0, 9, 24, 6);
    texRect(ctx, P, 'mesh', 9, 0, 6, 24);
    for (const v of [9, 15]) {
      bar(ctx, P.c(C.steelLight), 0.75, 0, v, 24, v);
      bar(ctx, P.c(C.steelLight), 0.75, v, 0, v, 24);
    }
    rect(ctx, P.c(GUNMETAL), 10.5, 10.5, 3, 3);
    rect(ctx, P.c(STEEL_L), 10.5, 10.5, 3, 0.75);
  },

  // Concrete wall 1x1: a block course with a lit cap and joints, tiling sideways.
  BRIK: (ctx, P) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 24, 24);
    ctx.clip();
    rect(ctx, P.c(SHADE), 2, 4, 24, 18);
    rect(ctx, P.c(C.concreteLight), 0, 2, 24, 15);
    rect(ctx, P.c(CONC_LINE), 0, 17, 24, 4);
    rect(ctx, P.c(ROOF_LIT), 0, 2, 24, 1);
    rect(ctx, P.c(C.seam), 0, 2, 0.5, 19);
    rect(ctx, P.c(C.seam), 23.5, 2, 0.5, 19);
    bar(ctx, P.c(CONC), 0.75, 3, 6, 8, 6);
    bar(ctx, P.c(CONC), 0.75, 14, 11, 18, 11);
    ctx.restore();
  },

  // Pillbox 1x1: an octagonal concrete bunker with three firing slits.
  PBOX: (ctx, P) => {
    poly(ctx, P.c(SHADE), gon(13.5, 13.5, 9, 8));
    poly(ctx, P.c(CONC_LINE), gon(12, 12, 9, 8));
    poly(ctx, P.c(CONC), gon(12, 12, 7, 8));
    for (const [x, y, w, h] of [[10, 4, 4, 1.5], [4, 11, 1.5, 2.5], [18.5, 11, 1.5, 2.5]]) rect(ctx, P.c('#141414'), x, y, w, h);
    teamDot(ctx, P, 12, 12, 2);
  },

  // Camo pillbox 1x1: the bunker under camouflage in the biome's colours.
  HBOX: (ctx, P) => {
    texPoly(ctx, P, 'camo', gon(12, 12, 9, 8));
    outline(ctx, P.c(camoOf(P)[3]), 0.75, gon(12, 12, 7, 8));
    rect(ctx, P.c('#141414'), 10, 4, 4, 1.5);
    teamDot(ctx, P, 12, 12, 1.25);
  },

  // Turret 1x1: a concrete base (the gun is the turret sprite).
  GUN: (ctx, P) => {
    texRect(ctx, P, 'concrete', 3, 3, 18, 18);
    shadowDisc(ctx, P, 12, 12, 6.5, 1.5);
    rect(ctx, P.team(TEAM), 4, 19, 3, 1.5);
    rect(ctx, P.team(TEAM), 17, 19, 3, 1.5);
  },

  // Flame tower 1x1: a brick tower with a team ring, red fuel tanks, a nozzle
  // with its pilot flame and a scorch mark.
  FTUR: (ctx, P) => {
    texRect(ctx, P, 'concrete', 3, 1, 18, 18);
    ctx.fillStyle = P.c('rgba(43,43,40,0.5)');
    ctx.beginPath();
    ctx.ellipse(12, 21, 5, 3, 0, 0, TAU);
    ctx.fill();
    circle(ctx, P.c(RED), 19.5, 4, 2);
    circle(ctx, P.c(RED), 19.5, 8.5, 2);
    shadowDisc(ctx, P, 11, 8.5, 6, 1.5);
    texDisc(ctx, P, 'brick', 11, 8.5, 6);
    ring(ctx, P.team(TEAM), 11, 8.5, 6, 1.25);
    circle(ctx, P.c(GUNMETAL), 11, 8.5, 2.5);
    rect(ctx, P.c(BOLT), 10, 12, 2, 4.5);
    poly(ctx, P.c(WINDSOCK), [11, 16, ...curve(11, 16, 7, 19, 8, 23, 4), ...curve(8, 23, 11, 21, 11, 24, 3), ...curve(11, 24, 13, 21, 15, 23, 3), ...curve(15, 23, 16, 19, 11, 16, 4)]);
    poly(ctx, P.c(GLOW), [11, 17, ...curve(11, 17, 9, 19.5, 10, 22, 3), ...curve(10, 22, 11, 20.5, 12, 22, 2), ...curve(12, 22, 13, 19.5, 11, 17, 3)]);
  },

  // Tesla coil 1x1: copper windings around a glowing core (its arcs crackle:
  // art/animated.js), team plates on the base.
  TSLA: (ctx, P) => {
    texRect(ctx, P, 'concrete', 3, 3, 18, 18);
    shadowDisc(ctx, P, 12, 12, 7, 1.5);
    circle(ctx, P.c(GUNMETAL), 12, 12, 7);
    ring(ctx, P.c(COPPER), 12, 12, 5.5, 1.25);
    ring(ctx, P.c(COPPER_L), 12, 12, 3.5, 1.25);
    circle(ctx, P.c('rgba(127,224,255,0.3)'), 12, 12, 5);
    circle(ctx, P.c(GLOW), 12, 12, 2.5);
    circle(ctx, P.c('#ffffff'), 12, 12, 1);
    rect(ctx, P.team(TEAM), 3, 19, 4, 2);
    rect(ctx, P.team(TEAM), 17, 19, 4, 2);
  },

  // AA gun 1x1: a sandbag ring around a dirt pit (the gun is the turret sprite).
  AGUN: (ctx, P) => {
    shadowDisc(ctx, P, 12, 12, 10, 1.5);
    texDisc(ctx, P, 'sand', 12, 12, 10);
    circle(ctx, P.c(DIRT), 12, 12, 6.5);
    teamDot(ctx, P, 12, 3.8, 1.6);
  },

  // SAM site 2x1: a sandbagged pit with the launcher well (the launcher is the
  // turret sprite), a team plate with a red star and a radar dish.
  SAM: (ctx, P) => {
    texRect(ctx, P, 'sand', 0, 2, 48, 20);
    rect(ctx, P.c(DIRT), 3, 5, 42, 14);
    circle(ctx, P.c(GUNMETAL), 24, 12, 5.5);
    rect(ctx, P.team(TEAM), 5, 6, 5, 5);
    poly(ctx, P.c(RED), star(7.5, 15.6, 2.8));
    bar(ctx, P.c(GUNMETAL), 1, 40, 12, 40, 17);
    circle(ctx, P.c(DISH), 40, 11, 3.5);
    circle(ctx, P.c(C.steelLight), 40, 11, 1.5);
  },

  // WebRA's own Lightning Rod: WebRA's pixel art in Red Alert's style
  // (art/pixel.js). Its mast stands above the footprint, so it paints into
  // the taller box pixelBox gives (js/sprites.js actorSprites).
  LROD: pixelDraw({ id: 'LROD', width: BUILDING_SIZE.LROD[0], height: BUILDING_SIZE.LROD[1] }),
};

/** The helipad's landing lights, clockwise from the top (the animated layer chases them). */
export const HPAD_LIGHTS = [[24, 24], [39.5, 30.5], [45.5, 46], [39.5, 61.5], [24, 68], [8.5, 61.5], [2.5, 46], [8.5, 30.5]];
/** The airfield's runway edge lights (x) along both rows (y). */
export const AFLD_LIGHTS = [12, 21, 30, 39, 48, 57];
export const AFLD_LIGHT_ROWS = [21.5, 46.5];

/** The dark of the silo shaft. */
export const SHAFT = '#141210';

/**
 * The missile silo's hatch (MSLO), `open` from 0 (shut: two ribbed steel
 * leaves meeting over the shaft) to 1 (the leaves slid into the housings,
 * the missile in the shaft seen from above: its nose ringed in yellow, red
 * fins). The structure draws it shut; WebRA's launch layer (art/animated.js
 * BUILDING_WORKING) draws it opening and closing over the structure when
 * the atom bomb leaves.
 */
export function siloHatch(ctx, P, open) {
  if (open > 0) {
    rect(ctx, P.c(SHAFT), 14, 5, 20, 14);
    for (const [x, y] of [[19, 6.5], [27, 6.5], [19, 14], [27, 14]]) rect(ctx, P.c(RED), x, y, 2, 3.5);
    circle(ctx, P.c(PAINT), 24, 12, 4.5);
    ring(ctx, P.c(C.yellow), 24, 12, 4.5, 1);
    circle(ctx, P.c(RED), 24, 12, 2);
  }
  // Each leaf keeps its outer part as it slides under its housing.
  const width = 10 * (1 - open);
  for (const [u0, u1] of [[14, 14 + width], [34 - width, 34]]) {
    if (u1 - u0 < 0.2) continue;
    rect(ctx, P.c(STEEL_D), u0, 5, u1 - u0, 14);
    rect(ctx, P.c(STEEL), u0 + 0.4, 5.4, u1 - u0 - 0.8, 13.2);
    for (let y = 7.5; y < 18; y += 2.5) rect(ctx, P.c(STEEL_LINE), u0 + 0.4, y, u1 - u0 - 0.8, 0.6);
  }
  if (open > 0) return;
  rect(ctx, P.c('#e8641c'), 23.75, 5.5, 0.5, 13);
}

/** Building turrets, centred on the building centre and facing north. */
export const BUILDING_TURRET = {
  // Turret: a steel drum with the long barrel and a team hatch.
  GUN: [24, 24, (ctx, P) => {
    circle(ctx, P.c(STEEL_D), 12, 12, 6.5);
    texDisc(ctx, P, 'steel', 12, 12, 5.5);
    rect(ctx, P.c(BOLT), 10.75, 0.5, 2.5, 10);
    rect(ctx, P.c(BLACK), 10.25, 0.5, 3.5, 1.5);
    teamDot(ctx, P, 12, 13, 2);
  }],
  // AA gun: twin barrels on a steel mount.
  AGUN: [24, 24, (ctx, P) => {
    for (const x of [10.5, 13.5]) {
      polyline(ctx, P.c(BOLT), 2, [x, 10, x, 3]);
      polyline(ctx, P.c(GUNMETAL), 0.75, [x, 10, x, 3]);
    }
    circle(ctx, P.c(STEEL_D), 12, 12, 4.5);
    texDisc(ctx, P, 'steel', 12, 12, 4);
    teamDot(ctx, P, 12, 12, 1.5);
  }],
  // SAM: three missiles on a team launcher block.
  SAM: [24, 24, (ctx, P) => {
    rect(ctx, P.c(STEEL_D), 8, 8, 8, 8);
    rect(ctx, P.team(TEAM), 9.5, 9.5, 5, 5);
    for (const x of [8, 12, 16]) {
      polyline(ctx, P.c(PAINT), 2.5, [x, 2.5, x, 12]);
      polyline(ctx, P.c(RED), 2.5, [x, 1.6, x, 2.6]);
      rect(ctx, P.c(RED), x - 1.6, 11, 3.2, 1);
    }
  }],
};
