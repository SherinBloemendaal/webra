// Procedural art for the neutral world of OpenRA maps (engine/src/neutral.rs,
// bridges.rs): trees and their burnt stumps, civilian houses, fields and huts,
// tech buildings (hospital, bio lab, communications center, forward command
// post, oil derrick), barrels and ammo boxes, crates, ice floes, rocks, poles
// and tank traps, ore and gem mines, the map-only walls, bridges and the
// civilians. Same camera, light and helpers as buildings.js (volume.js).
//
// Structures draw into their footprint box (cells times 24 world pixels).
// Trees and the like draw only over their occupied cells (OpenRA footprints
// such as `__ x_`: the trunk stands on the occupied cell, the crown leans into
// the empty ones above). Civilians are not team coloured: OpenRA draws them
// with fixed civilian palettes. Trees, ice and huts look like the map's biome
// (`P.biome`: temperate, snow or desert; js/sprites.js buildAtlas passes it).

import { C, rect, circle, poly, polyline, ring } from './kit.js';
import { K, KY, tone, radial, quad, disc, oval, stroke, at, castShadows, box, patch, mark, cylinder, dome, gable, prism } from './volume.js';

/** Seeded pseudo random numbers in [0, 1). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A stable seed from an actor id. */
function seedOf(id) {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

const biomeOf = (P) => P.biome ?? 'temperate';

// ---- Trees ------------------------------------------------------------------------------

/** Crown colours (dark, light) per biome. */
const LEAVES = {
  temperate: ['#1f3d18', '#4e7a2e'],
  snow: ['#1d3a30', '#3d6656'],
  desert: ['#4f6a24', '#8aa046'],
};

/** A leafy crown of overlapping lumps around (cx, cy), lit from the top left. */
function crown(ctx, P, cx, cy, r, seed) {
  const [dark, light] = LEAVES[biomeOf(P)] ?? LEAVES.temperate;
  const rnd = rng(seed);
  oval(ctx, P.c('rgba(0,0,0,0.3)'), cx + r * 0.45, cy + r * 0.75, r, r * 0.6);
  const lumps = [];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + rnd() * 0.6;
    const d = r * (0.42 + rnd() * 0.22);
    lumps.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.85, r * (0.48 + rnd() * 0.14)]);
  }
  lumps.push([cx, cy, r * 0.62]);
  for (const [x, y, rr] of lumps) disc(ctx, P.c(dark), x + 0.6, y + 0.8, rr);
  for (const [x, y, rr] of lumps) {
    disc(ctx, radial(ctx, P, K(light), x - rr * 0.45, y - rr * 0.45, 0, x, y, rr * 1.2, [[0, 0.32], [0.55, 0], [1, -0.45]]), x, y, rr);
  }
  if (biomeOf(P) === 'snow') {
    for (const [x, y, rr] of lumps.slice(0, 5)) oval(ctx, P.c('rgba(236,242,248,0.85)'), x - rr * 0.25, y - rr * 0.35, rr * 0.55, rr * 0.3);
  }
}

/** A conifer: stacked tiers over (cx, base), `h` high. */
function pine(ctx, P, cx, base, h, w) {
  const snow = biomeOf(P) === 'snow';
  oval(ctx, P.c('rgba(0,0,0,0.3)'), cx + w * 0.55, base - 1, w * 0.8, w * 0.35);
  rect(ctx, P.c('#4a3420'), cx - 0.8, base - 4, 1.6, 4);
  for (let k = 0; k < 4; k++) {
    const y1 = base - 3 - k * (h / 5);
    const y0 = y1 - h * 0.42;
    const hw = w * (1 - k * 0.2);
    poly(ctx, P.c('#16301f'), [cx - hw, y1, cx + hw, y1, cx + 0.6, y0]);
    poly(ctx, P.c('#2f5a3c'), [cx - hw + 0.8, y1 - 0.8, cx, y1 - 0.8, cx, y0 + 1]);
    if (snow) poly(ctx, P.c('rgba(236,242,248,0.9)'), [cx - hw * 0.5, y1 - h * 0.21, cx + hw * 0.35, y1 - h * 0.21, cx + 0.3, y0 + 0.6]);
  }
}

/** A palm: a leaning trunk and drooping fronds. */
function palm(ctx, P, cx, base) {
  oval(ctx, P.c('rgba(0,0,0,0.3)'), cx + 7, base - 1, 9, 3);
  polyline(ctx, P.c('#6b4a2a'), 2.2, [cx, base, cx + 1.5, base - 9, cx + 3.5, base - 18]);
  polyline(ctx, P.c('#a07448'), 0.8, [cx - 0.5, base - 1, cx + 1, base - 9, cx + 3, base - 17]);
  const [hx, hy] = [cx + 3.5, base - 19];
  for (let k = 0; k < 7; k++) {
    const a = -Math.PI / 2 + (k - 3) * 0.55;
    const tip = [hx + Math.cos(a) * 10, hy + Math.sin(a) * 5 + 4];
    polyline(ctx, P.c('#3e5a1c'), 1.8, [hx, hy, (hx + tip[0]) / 2, hy + Math.sin(a) * 4 - 1, tip[0], tip[1]]);
    polyline(ctx, P.c('#7c9a3a'), 0.7, [hx, hy - 0.4, (hx + tip[0]) / 2, hy + Math.sin(a) * 4 - 1.4, tip[0], tip[1] - 0.4]);
  }
  disc(ctx, P.c('#5a3c20'), hx, hy, 1.4);
}

/** A saguaro-like cactus. */
function cactus(ctx, P, cx, base) {
  oval(ctx, P.c('rgba(0,0,0,0.28)'), cx + 4, base - 1, 5, 2);
  const arm = (pts) => {
    polyline(ctx, P.c('#2f5224'), 3, pts);
    polyline(ctx, P.c('#6f9a46'), 1, pts.map((v, i) => (i % 2 ? v : v - 0.6)));
  };
  arm([cx, base, cx, base - 15]);
  arm([cx, base - 6, cx - 4, base - 6, cx - 4, base - 11]);
  arm([cx, base - 9, cx + 4, base - 9, cx + 4, base - 13]);
}

/** A burnt stump on the cell centred at (cx, cy). */
function stump(ctx, P, cx, cy, seed) {
  const rnd = rng(seed);
  oval(ctx, P.c('rgba(20,16,12,0.55)'), cx, cy + 3, 9, 5);
  for (let k = 0; k < 5; k++) disc(ctx, P.c('rgba(40,36,30,0.6)'), cx - 6 + rnd() * 12, cy + rnd() * 6, 1.4 + rnd());
  cylinder(ctx, P, cx, cy + 2, 2.6, 4 + rnd() * 3, K('#2e2418'), K('#5a4630'));
  stroke(ctx, P.c('#1a140e'), 1, cx + 1, cy - 2, cx + 4, cy - 6);
}

/** Centre of footprint cell (dx, dy). */
const cellCentre = (dx, dy) => [dx * 24 + 12, dy * 24 + 12];

/** Occupied cells of a footprint (`footprint` rows of rules_json: [x, y, kind]). */
function occupied(a) {
  return (a.footprint ?? []).filter((c) => c[2] === 1).map((c) => [c[0], c[1]]);
}

/** Tree kinds per OpenRA tree type: round crowns, conifers, small bushes, palms, cacti. */
const TREE_KIND = {
  T01: 'round', T02: 'round', T03: 'pine', T04: 'palm', T05: 'round', T06: 'pine', T07: 'round', T08: 'bush', T09: 'cactus',
  T10: 'round', T11: 'round', T12: 'round', T13: 'pine', T14: 'round', T15: 'pine', T16: 'round', T17: 'pine',
  TC01: 'round', TC02: 'pine', TC03: 'round', TC04: 'round', TC05: 'pine',
};

/**
 * One tree standing on the cell centred at (cx, cy). Trees on the top row of
 * their footprint (no empty cell above for the crown) grow smaller, so the
 * drawing stays inside the footprint box.
 */
function treeAt(ctx, P, kind, cx, cy, seed, boxWidth = 24) {
  // Snow and desert maps get their own kinds of tree.
  if (biomeOf(P) === 'desert' && (kind === 'round' || kind === 'pine')) kind = seed % 3 === 0 ? 'cactus' : 'palm';
  // A full-size round crown reaches 22 pixels above the cell centre and 17 to
  // either side: smaller on the top row and at the sides of the box.
  const s = Math.min(1, (cy + 1) / 22, (boxWidth + 1 - cx) / 17, (cx + 1) / 17);
  switch (kind) {
    case 'pine':
      pine(ctx, P, cx, cy + 8, Math.min(26, (cy + 5) / 1.02), 9);
      break;
    case 'palm':
      palm(ctx, P, cx - 2, cy + 8);
      break;
    case 'cactus':
      cactus(ctx, P, cx, cy + 8);
      break;
    case 'bush':
      crown(ctx, P, cx, cy, 8, seed);
      break;
    default:
      rect(ctx, P.c('#4a3420'), cx - 1, cy - 2, 2.2, 10);
      crown(ctx, P, cx + 1, cy - 8 * s, 12 * s, seed);
  }
}

function treeDraw(id, a) {
  const kind = TREE_KIND[id] ?? 'round';
  const cells = occupied(a);
  const boxWidth = (a.width ?? 1) * 24;
  return (ctx, P) => {
    // Back rows first, so crowns in front overlap the ones behind.
    cells.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    cells.forEach(([dx, dy], k) => {
      const [cx, cy] = cellCentre(dx, dy);
      treeAt(ctx, P, kind, cx, cy, seedOf(id) + k * 7919, boxWidth);
    });
  };
}

function stumpDraw(id, a) {
  const cells = occupied(a);
  return (ctx, P) => {
    cells.forEach(([dx, dy], k) => {
      const [cx, cy] = cellCentre(dx, dy);
      stump(ctx, P, cx, cy, seedOf(id) + k);
    });
  };
}

// ---- Civilian buildings ---------------------------------------------------------------------

const PLASTER = ['#cfc3a4', '#d8cfb8', '#c6b48e', '#b9ad96', '#d4c7b0'];
const TILES = ['#8a3a2a', '#6a4a34', '#5b5f63', '#7a3226', '#4d4438'];
const ADOBE = ['#c9a676', '#d4b486', '#bf9a68', '#caa880'];

/** A cottage: walls, a pitched roof, windows, a door and maybe a chimney. */
function cottage(ctx, P, x, y, w, d, z, seed, o = {}) {
  const r = rng(seed);
  const wall = K(o.wall ?? PLASTER[Math.floor(r() * PLASTER.length)]);
  const roof = K(o.roof ?? TILES[Math.floor(r() * TILES.length)]);
  castShadows(ctx, P, [{ x, y, w, d, z: z + 5 }]);
  const H = box(ctx, P, x, y, w, d, z, wall, wall);
  // windows and a door on the south face
  const n = Math.max(1, Math.floor(w / 7));
  for (let k = 0; k < n; k++) {
    const u = ((k + 0.5) * w) / n - 1.4;
    if (k === Math.floor(n / 2) && o.door !== false) {
      patch(ctx, P.c('#4a3524'), H, 'front', u, 0, u + 3, Math.min(z - 1, 5));
    } else {
      patch(ctx, P.c('#2c3a44'), H, 'front', u, z * 0.45, u + 2.8, z * 0.45 + 2.4);
      patch(ctx, P.c('#9bc0d0'), H, 'front', u + 0.4, z * 0.45 + 1.4, u + 1.4, z * 0.45 + 2.2);
    }
  }
  gable(ctx, P, H, o.rise ?? Math.min(6, d * 0.4), roof, { axis: o.axis ?? (w >= d ? 'x' : 'y'), overhang: 1, seams: Math.round(w / 3) });
  if (o.chimney ?? r() < 0.6) {
    // On the front slope, just clearing the ridge, and never above the footprint box.
    const cx = x + w * (0.25 + r() * 0.5);
    const cy = y + d * 0.55;
    cylinder(ctx, P, cx, cy, 1.4, Math.min(z + (o.rise ?? 5) + 1.5, (cy - 1.6) / KY), K('#6b5a4c'), K('#3a302a'));
  }
  return H;
}

/** A flat-roofed adobe house with a parapet (desert). */
function adobe(ctx, P, x, y, w, d, z, seed, o = {}) {
  const r = rng(seed);
  const wall = K(ADOBE[Math.floor(r() * ADOBE.length)]);
  castShadows(ctx, P, [{ x, y, w, d, z }]);
  const H = box(ctx, P, x, y, w, d, z, wall, K(tone(wall.c, 0.12)));
  patch(ctx, P.c(tone(wall.c, -0.12)), H, 'roof', 1.2, 1.2, w - 1.2, d - 1.2);
  const n = Math.max(1, Math.floor(w / 6));
  for (let k = 0; k < n; k++) {
    const u = ((k + 0.5) * w) / n - 1.2;
    patch(ctx, P.c('#3a2c20'), H, 'front', u, z * 0.35, u + 2.4, z * 0.35 + (k === 0 ? 4.2 : 2.4));
  }
  if (o.dome) {
    const [cx, cy] = [x + w * 0.5, y + d * 0.5];
    dome(ctx, P, cx, cy, Math.min(w, d) * 0.32, K('#e2d6b8'), { z0: z });
  }
  // A tower at the front corner (one at the back would reach above the footprint box).
  if (o.tower) cylinder(ctx, P, x + w - 6, y + d - 3, 2.4, Math.min(z + 9, (y + d - 6) / KY), wall, K('#e2d6b8'));
  return H;
}

/** A church: nave with a steeple (temperate) or a domed one (desert). */
function church(ctx, P, desert) {
  if (desert) {
    castShadows(ctx, P, [{ x: 6, y: 18, w: 34, d: 24, z: 9 }, { cx: 36, cy: 22, r: 3, z: 19 }]);
    const H = box(ctx, P, 6, 18, 34, 24, 9, K('#d8c7a0'), K('#e4d6b4'));
    patch(ctx, P.c('#3a2c20'), H, 'front', 14, 0, 19, 6);
    dome(ctx, P, 21, 30, 9, K('#e9e2cf'), { z0: 9 });
    cylinder(ctx, P, 36, 22, 2.6, 19, K('#d8c7a0'), K('#e9e2cf'));
    return;
  }
  // The steeple stands behind the nave; both stay inside the 2x2 footprint box.
  castShadows(ctx, P, [{ x: 8, y: 22, w: 30, d: 20, z: 14 }, { x: 10, y: 12, w: 9, d: 9, z: 15 }]);
  const S = box(ctx, P, 10, 12, 9, 9, 11, K('#b0a998'), K('#c8c0ae'));
  patch(ctx, P.c('#2c2c2c'), S, 'front', 3.2, 6.5, 5.8, 9.5);
  const [sx, sy] = at(14.5, 16.5, 11);
  poly(ctx, P.c('#4a4e52'), [sx - 5, sy + 1.5, sx + 5, sy + 1.5, sx + 0.4, sy - 5]);
  stroke(ctx, P.c('#e0c060'), 0.8, sx + 0.4, sy - 5, sx + 0.4, sy - 7.4);
  stroke(ctx, P.c('#e0c060'), 0.8, sx - 1.1, sy - 6.4, sx + 1.9, sy - 6.4);
  const N = box(ctx, P, 8, 22, 30, 20, 9, K('#b9b2a2'), K('#c8c0ae'));
  for (const u of [5, 13, 21]) patch(ctx, P.c('#2e3d55'), N, 'front', u, 2.5, u + 3, 7);
  gable(ctx, P, N, 7, K('#5b5f63'), { axis: 'y', overhang: 1, seams: 6 });
}

/** A field: rows of a crop on tilled soil. */
function field(ctx, P, w, h, seed, crop) {
  const r = rng(seed);
  const soil = biomeOf(P) === 'snow' ? '#b9bfc6' : '#6e5434';
  rect(ctx, P.c(soil), 1, 1, w - 2, h - 2);
  for (let y = 3; y < h - 2; y += 3) {
    rect(ctx, P.c(tone(soil, -0.25)), 2, y, w - 4, 1);
    for (let x = 3; x < w - 3; x += 2.5 + r()) {
      const c = crop === 'rice' ? '#7caa48' : crop === 'wheat' ? '#c9a83e' : '#5f8a36';
      disc(ctx, P.c(c), x, y - 0.6, crop === 'wheat' ? 0.9 : 1.1);
    }
  }
  if (crop === 'rice') {
    ctx.save();
    ctx.globalAlpha = 0.35;
    rect(ctx, P.c('#5f93ad'), 1, 1, w - 2, h - 2);
    ctx.restore();
  }
}

/** Haystack (or an igloo on snow maps: OpenRA's Tooltip@WINTER). */
function haystack(ctx, P, seed) {
  if (biomeOf(P) === 'snow') {
    castShadows(ctx, P, [{ cx: 12, cy: 13, r: 8, z: 7 }]);
    dome(ctx, P, 12, 13, 8, K('#e9eef3'));
    for (const h of [2.4, 4.6]) {
      const [lx, ly] = at(12, 13, h);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(lx, ly, 7.6 - h * 0.6, 3, 0, 0, Math.PI);
      ctx.strokeStyle = P.c('#b8c4d0');
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.restore();
    }
    patch(ctx, P.c('#3a4450'), box(ctx, P, 10, 19, 4, 3, 3, K('#dfe6ec')), 'front', 0.8, 0, 3.2, 2.4);
    return;
  }
  const r = rng(seed);
  castShadows(ctx, P, [{ cx: 12, cy: 14, r: 7.5, z: 9 }]);
  dome(ctx, P, 12, 14, 8, K('#c9a83e'));
  for (let k = 0; k < 14; k++) {
    const [lx, ly] = at(6 + r() * 12, 9 + r() * 9, 3 + r() * 6);
    stroke(ctx, P.c('#e4cf7a'), 0.4, lx, ly, lx + r() * 2 - 1, ly + 1.5);
  }
}

/** Oil pump (V19): a pumpjack on a pad. */
function pumpjack(ctx, P, burnt = false) {
  rect(ctx, P.c(burnt ? '#2a2620' : C.concreteDark), 2, 6, 20, 15);
  rect(ctx, P.c(burnt ? '#3a342c' : C.concrete), 3, 7, 18, 13);
  const steel = burnt ? K('#2e2a26') : K('#55585c');
  castShadows(ctx, P, [{ x: 5, y: 10, w: 14, d: 5, z: 10 }]);
  box(ctx, P, 9, 11, 3, 4, 8, steel, steel);
  const [ax, ay] = at(10.5, 13, 8.5);
  stroke(ctx, P.c(burnt ? '#1c1a18' : '#33363a'), 2, ax - 8, ay + 2, ax + 7, ay - 1);
  disc(ctx, P.c(burnt ? '#1c1a18' : '#c23a26'), ax - 8, ay + 3, 2.4);
  box(ctx, P, 16, 13, 3, 3, 3, steel, steel);
}

// ---- Tech buildings ----------------------------------------------------------------------------

function hospital(ctx, P) {
  castShadows(ctx, P, [{ x: 4, y: 12, w: 40, d: 30, z: 13 }]);
  const H = box(ctx, P, 4, 12, 40, 30, 11, K('#d9d6cc'), K('#e8e6de'), { panel: 8 });
  for (let k = 0; k < 4; k++) patch(ctx, P.c('#3b5566'), H, 'front', 3 + k * 9.5, 4.5, 8 + k * 9.5, 8);
  patch(ctx, P.c('#3a3a3a'), H, 'front', 17, 0, 23, 4);
  // red cross on the roof (OpenRA HOSP: the Red Cross)
  const cross = (u0, t0, u1, t1) => patch(ctx, P.c('#c8261c'), H, 'roof', u0, t0, u1, t1);
  patch(ctx, P.c('#f4f2ec'), H, 'roof', 11, 5, 29, 25);
  cross(18, 7, 22, 23);
  cross(13, 13, 27, 17);
  stroke(ctx, P.team(0.9), 1, 4, 44, 44, 44);
}

function bioLab(ctx, P) {
  castShadows(ctx, P, [{ x: 4, y: 14, w: 26, d: 28, z: 10 }, { cx: 36, cy: 20, r: 7, z: 10 }, { cx: 36, cy: 38, r: 5, z: 7 }]);
  const H = box(ctx, P, 4, 14, 26, 28, 9, K('#8e958a'), K('#a3aa9e'), { panel: 6 });
  for (const u of [3, 10, 17]) patch(ctx, P.c('#4c6a4a'), H, 'front', u, 3.5, u + 4, 6.5);
  patch(ctx, P.c('#c9b02c'), H, 'roof', 4, 4, 22, 24);
  const [tx, ty] = H.roof(13, 14);
  ctx.save();
  ctx.fillStyle = P.c('#1c1c1c');
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(tx + Math.cos(a) * 3.4, ty + Math.sin(a) * 3.4, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  disc(ctx, P.c('#c9b02c'), tx, ty, 1.4);
  dome(ctx, P, 36, 20, 7, K('#9cc0a0'), { z0: 2 });
  cylinder(ctx, P, 36, 38, 4.6, 7, K('#7a8276'), K('#9aa496'));
  stroke(ctx, P.c('#3a5a3a'), 1.2, 30, 26, 32, 22);
}

function commCenter(ctx, P) {
  // bib in front (=== row), building behind
  rect(ctx, P.c(C.concreteDark), 0, 48, 72, 24);
  rect(ctx, P.c(C.concrete), 1, 49, 70, 22);
  for (let x = 12; x < 72; x += 12) rect(ctx, P.c(C.seam), x, 49, 1, 22);
  castShadows(ctx, P, [{ x: 4, y: 10, w: 64, d: 36, z: 12 }]);
  const H = box(ctx, P, 4, 10, 64, 36, 11, K('#8f8c80'), K('#a7a497'), { panel: 8 });
  for (let k = 0; k < 6; k++) patch(ctx, P.c('#35505e'), H, 'front', 4 + k * 10, 4.5, 9 + k * 10, 8);
  patch(ctx, P.c('#3a3a3a'), H, 'front', 28, 0, 36, 5);
  // antennas and a dish on the roof
  const [dx, dy] = H.roof(18, 16);
  disc(ctx, P.c('#55585c'), dx, dy, 8);
  disc(ctx, radial(ctx, P, K('#d8dde2'), dx - 3, dy - 3, 0, dx, dy, 8, [[0, 0.3], [1, -0.4]]), dx, dy, 7);
  disc(ctx, P.c('#3a3d42'), dx + 1, dy + 1, 1.4);
  for (const [u, t, h] of [[44, 14, 12], [52, 22, 10], [58, 12, 12]]) {
    const [bx, by] = H.roof(u, t);
    stroke(ctx, P.c('#3f4247'), 1, bx, by, bx + h * 0.28, by - h * 0.92);
    for (let k = 1; k < 4; k++) stroke(ctx, P.c('#6c7076'), 0.6, bx + k * 1.4 - 2, by - k * h * 0.22, bx + k * 1.4 + 2, by - k * h * 0.22);
    disc(ctx, P.c('#ff4a3a'), bx + h * 0.28, by - h * 0.92, 0.8);
  }
}

function commandPost(ctx, P) {
  rect(ctx, P.c(C.concreteDark), 0, 48, 48, 24);
  rect(ctx, P.c(C.concrete), 1, 49, 46, 22);
  rect(ctx, P.c(C.seam), 24, 49, 1, 22);
  castShadows(ctx, P, [{ x: 4, y: 12, w: 40, d: 34, z: 9 }]);
  const H = box(ctx, P, 4, 12, 40, 34, 8, K('#6f7457'), K('#7f8466'), { panel: 10 });
  // sandbags along the front
  for (let x = 4; x < 44; x += 5) oval(ctx, P.c('#8a8a5a'), x + 2.5, 46, 2.8, 1.8);
  patch(ctx, P.c('#2c2c22'), H, 'front', 17, 0, 23, 5);
  for (const u of [6, 30]) patch(ctx, P.c('#1f2a22'), H, 'front', u, 4, u + 4, 6);
  // radar on a mast and a flag in the owner's colour
  const [rx, ry] = H.roof(28, 12);
  stroke(ctx, P.c('#3f4247'), 1.2, rx, ry, rx + 2.5, ry - 9);
  oval(ctx, P.c('#c8ccd0'), rx + 2.5, ry - 10, 5, 2);
  const [fx, fy] = H.roof(9, 8);
  stroke(ctx, P.c('#3f4247'), 0.8, fx, fy, fx + 3, fy - 13);
  poly(ctx, P.team(0.9), [fx + 3, fy - 13, fx + 10, fy - 11, fx + 3, fy - 8.5]);
}

function derrick(ctx, P) {
  rect(ctx, P.c('#3c3a34'), 2, 6, 44, 40);
  rect(ctx, P.c('#4a473f'), 3, 7, 42, 38);
  castShadows(ctx, P, [{ cx: 33, cy: 34, r: 6.5, z: 9 }, { x: 8, y: 16, w: 16, d: 16, z: 24 }]);
  cylinder(ctx, P, 33, 34, 6.5, 9, K('#b7b3a5'), K('#cbc7b9'), { bands: [[3, 4, K('#8a3a2a')]] });
  cylinder(ctx, P, 36, 18, 4.5, 7, K('#b7b3a5'), K('#cbc7b9'));
  // the lattice tower
  const base = [[8, 32], [24, 32], [24, 16], [8, 16]];
  const top = at(16, 24, 24);
  for (const [gx, gy] of base) stroke(ctx, P.c('#2b2b28'), 1.2, gx, gy, top[0], top[1]);
  for (let h = 6; h < 24; h += 6) {
    const f = 1 - h / 24;
    const pts = base.map(([gx, gy]) => at(16 + (gx - 16) * f, 24 + (gy - 24) * f, h));
    for (let k = 0; k < 4; k++) {
      const [a, b] = [pts[k], pts[(k + 1) % 4]];
      stroke(ctx, P.c('#4a4a44'), 0.6, a[0], a[1], b[0], b[1]);
    }
  }
  disc(ctx, P.c('#ff4a3a'), top[0], top[1], 1);
  stroke(ctx, P.team(0.9), 1.4, 2, 46, 46, 46);
  polyline(ctx, P.c('#2b2b28'), 1, [24, 26, 28, 32, 33, 34]);
}

// ---- Barrels, boxes and other decorations ------------------------------------------------------

function oilBarrel(ctx, P, cx, cy, tint = '#a8321e') {
  cylinder(ctx, P, cx, cy, 3.6, 7, K(tint), K(tone(tint, 0.15)), { bands: [[2, 2.6, K('#2c2c2c')], [4.6, 5.2, K('#2c2c2c')]] });
}

function crateBox(ctx, P, x, y, s, z, wood = '#8a6a3a', seed = 1) {
  const r = rng(seed);
  const V = box(ctx, P, x, y, s, s, z, K(wood), K(tone(wood, 0.12)));
  mark(ctx, P.c(tone(wood, -0.4)), 0.5, V, 'front', 0, 0, s, z);
  mark(ctx, P.c(tone(wood, -0.4)), 0.5, V, 'front', s, 0, 0, z);
  mark(ctx, P.c(tone(wood, -0.3)), 0.5, V, 'roof', r() * 2, s / 2, s, s / 2);
  return V;
}

function boxes(ctx, P, seed) {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 3);
  const items = [];
  for (let k = 0; k < n; k++) items.push({ x: 3 + r() * 8, y: 7 + r() * 6, s: 6 + r() * 4, z: 5 + r() * 3 });
  castShadows(ctx, P, items.map((b) => ({ x: b.x, y: b.y, w: b.s, d: b.s, z: b.z })));
  items.sort((a, b) => a.y - b.y);
  items.forEach((b, k) => crateBox(ctx, P, b.x, b.y, b.s, b.z, k % 2 ? '#7a5c30' : '#94744a', seed + k));
}

function ammoBox(ctx, P, seed) {
  const r = rng(seed);
  castShadows(ctx, P, [{ x: 3, y: 7, w: 18, d: 11, z: 6 }]);
  const V = box(ctx, P, 3, 7, 18, 11, 6, K('#5c6a3a'), K('#6c7a48'));
  for (const u of [4, 13]) patch(ctx, P.c('#3a4424'), V, 'front', u, 1, u + 2, 5);
  patch(ctx, P.c('#c9b02c'), V, 'roof', 7 + r() * 2, 4, 11 + r() * 2, 7);
}

function iceFloe(ctx, P, a, seed) {
  const r = rng(seed);
  for (const [dx, dy] of occupied(a)) {
    const [cx, cy] = cellCentre(dx, dy);
    const pts = [];
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const rr = 9 + r() * 3;
      pts.push(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * 0.9);
    }
    poly(ctx, P.c('rgba(20,40,60,0.35)'), pts.map((v, i) => v + (i % 2 ? 1.5 : 1)));
    poly(ctx, P.c('#c8dbe8'), pts);
    poly(ctx, P.c('#eef5fa'), pts.map((v, i) => (i % 2 ? cy + (v - cy) * 0.75 - 1 : cx + (v - cx) * 0.75 - 1)));
  }
}

function rocks(ctx, P, a, seed) {
  const r = rng(seed);
  const cells = occupied(a);
  castShadows(ctx, P, cells.map(([dx, dy]) => ({ cx: dx * 24 + 12, cy: dy * 24 + 13, r: 9, z: 6 })));
  for (const [dx, dy] of cells) {
    const [cx, cy] = cellCentre(dx, dy);
    for (let k = 0; k < 3; k++) {
      const x = cx - 5 + r() * 10;
      const y = cy - 3 + r() * 7;
      dome(ctx, P, x, y, 4 + r() * 4, K(k % 2 ? '#8e6a48' : '#a27c56'));
    }
  }
}

function utilityPole(ctx, P, seed) {
  const [bx, by] = [11, 20];
  const top = at(bx, by, 20);
  stroke(ctx, P.c('rgba(0,0,0,0.3)'), 1.4, bx, by, bx + 11, by + 4);
  stroke(ctx, P.c('#4a3420'), 1.8, bx, by, top[0], top[1]);
  stroke(ctx, P.c('#7a5a38'), 0.6, bx - 0.5, by, top[0] - 0.5, top[1]);
  stroke(ctx, P.c('#4a3420'), 1.2, top[0] - 7, top[1] + 2, top[0] + 7, top[1] + 2);
  for (const dx of [-6, 0, 6]) disc(ctx, P.c('#cfd4d8'), top[0] + dx, top[1] + 1.4, 0.7);
  if (seed % 2) {
    polyline(ctx, P.c('#2b2b28'), 0.4, [0, top[1] + 5, top[0] - 6, top[1] + 1.6, 24, top[1] + 4]);
  } else {
    polyline(ctx, P.c('#2b2b28'), 0.4, [top[0] - 6, top[1] + 1.6, top[0] - 4, 24]);
  }
}

function tankTrap(ctx, P, seed) {
  const r = rng(seed);
  for (let k = 0; k < (seed % 2 ? 1 : 2); k++) {
    const [cx, cy] = [8 + k * 8 + r() * 3, 12 + r() * 5];
    oval(ctx, P.c('rgba(0,0,0,0.3)'), cx + 3, cy + 3, 6, 2.5);
    for (const [dx, dy] of [[-5, 4], [5, -4], [-4, -4], [4, 4], [0, 6], [0, -6]]) {
      stroke(ctx, P.c('#4a4c50'), 1.6, cx - dx * 0.5, cy - dy * 0.5 + 2, cx + dx * 0.5, cy + dy * 0.5 - 2);
      stroke(ctx, P.c('#8a8e93'), 0.5, cx - dx * 0.5 - 0.4, cy - dy * 0.5 + 1.6, cx + dx * 0.5 - 0.4, cy + dy * 0.5 - 2.4);
    }
  }
}

function oreMine(ctx, P, gems) {
  castShadows(ctx, P, [{ cx: 12, cy: 13, r: 8, z: 6 }]);
  dome(ctx, P, 12, 13, 8.5, K('#6c5a44'));
  const r = rng(gems ? 17 : 5);
  for (let k = 0; k < 9; k++) {
    const [x, y] = at(5 + r() * 14, 7 + r() * 10, 2 + r() * 5);
    if (gems) {
      poly(ctx, P.c(k % 2 ? '#b03a9a' : '#5a8ae0'), [x, y - 2.6, x + 1.4, y, x, y + 1.4, x - 1.4, y]);
      disc(ctx, P.c('#f4e0ff'), x - 0.4, y - 0.8, 0.4);
    } else {
      disc(ctx, P.c(k % 2 ? C.ore : '#e2bd52'), x, y, 1.2 + r() * 0.6);
    }
  }
}

function flag(ctx, P) {
  oval(ctx, P.c('rgba(0,0,0,0.3)'), 12, 20, 5, 2);
  rect(ctx, P.c(C.concreteDark), 7, 17, 6, 4);
  const top = at(10, 19, 18);
  stroke(ctx, P.c('#cfd4d8'), 1, 10, 19, top[0], top[1]);
  poly(ctx, P.team(0.9), [top[0], top[1], top[0] + 7.5, top[1] + 2.5, top[0], top[1] + 5.5]);
  poly(ctx, P.team(0.6), [top[0], top[1] + 3, top[0] + 7.5, top[1] + 2.5, top[0], top[1] + 5.5]);
}

/** Map-only walls (tile sideways like buildings.js FENC): chain-link, barbed wire, wood. */
function chainLink(ctx, P) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 24, 24);
  ctx.clip();
  quad(ctx, P.c('rgba(0,0,0,0.24)'), [0, 13, 24, 13, 29, 17, 5, 17]);
  const [lx, ly] = at(0, 0, 9);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 13);
  ctx.lineTo(24, 13);
  ctx.lineTo(24 + lx, 13 + ly);
  ctx.lineTo(lx, 13 + ly);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = P.c('#9aa0a4');
  ctx.lineWidth = 0.45;
  for (let d = -30; d < 60; d += 2.4) {
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d + 30, 30);
    ctx.moveTo(d + 30, 0);
    ctx.lineTo(d, 30);
    ctx.stroke();
  }
  ctx.restore();
  for (const x of [2, 22]) {
    const p = at(x, 13, 10);
    stroke(ctx, P.c('#55585c'), 1.4, x, 13, p[0], p[1]);
  }
  stroke(ctx, P.c('#cfd4d8'), 0.7, lx, 13 + ly, 24 + lx, 13 + ly);
  ctx.restore();
}

function barbedWire(ctx, P) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 24, 24);
  ctx.clip();
  oval(ctx, P.c('rgba(0,0,0,0.22)'), 14, 16, 14, 3);
  for (let x = -4; x < 28; x += 4) ring(ctx, P.c('#55585c'), x, 11, 4, 0.6);
  for (let x = -2; x < 28; x += 4) ring(ctx, P.c('#8a8e93'), x, 10.4, 3.6, 0.4);
  for (const x of [4, 20]) {
    const p = at(x, 15, 9);
    stroke(ctx, P.c('#4a3420'), 1.2, x, 15, p[0], p[1]);
  }
  ctx.restore();
}

function woodFence(ctx, P) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 24, 24);
  ctx.clip();
  quad(ctx, P.c('rgba(0,0,0,0.24)'), [0, 15, 24, 15, 28, 18, 4, 18]);
  for (const h of [3, 7]) {
    const a = at(0, 14, h);
    const b = at(24, 14, h);
    stroke(ctx, P.c('#6b4a2a'), 1.4, a[0], a[1], b[0], b[1]);
    stroke(ctx, P.c('#a07448'), 0.5, a[0], a[1] - 0.6, b[0], b[1] - 0.6);
  }
  for (const x of [3, 12, 21]) {
    const p = at(x, 14, 9);
    stroke(ctx, P.c('#4a3420'), 1.6, x, 14, p[0], p[1]);
  }
  ctx.restore();
}

// ---- Bridges ---------------------------------------------------------------------------------

/** Template rows of a bridge for the biome (rules_json world.bridge), or the first biome's. */
function bridgeTemplate(a, P) {
  const t = a.world?.bridge ?? {};
  return t[biomeOf(P)] ?? Object.values(t)[0] ?? null;
}

const letterAt = (rows, x, y) => (rows[y] ?? '')[x] ?? '.';

/**
 * A bridge over its template's cells: a plank deck on the bridge cells
 * (railings where the deck ends), stone abutments on the bank cells; with
 * `destroyed` the broken stubs, rubble and a gap. The terrain under the deck
 * (bridge cells) is drawn as river by the terrain art.
 */
function bridgeDraw(a, destroyed) {
  return (ctx, P) => {
    const t = bridgeTemplate(a, P);
    if (!t) return;
    const deck = t.healthy;
    const [w, h] = t.size;
    const isDeck = (x, y) => letterAt(deck, x, y) === 'g';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = letterAt(deck, x, y);
        const [px, py] = [x * 24, y * 24];
        if (c === 'k' || c === 'l') {
          // abutment
          const V = box(ctx, P, px + 2, py + 4, 20, 18, destroyed ? 3 : 5, K('#7d776c'), K('#99938a'));
          if (destroyed) for (let k = 0; k < 4; k++) disc(ctx, P.c('#5e5a52'), px + 6 + k * 4, py + 18 - (k % 2) * 4, 1.6);
          else mark(ctx, P.c('#5e5a52'), 0.5, V, 'front', 0, 2.5, 20, 2.5);
          continue;
        }
        if (c !== 'g') continue;
        if (destroyed) {
          // a stub of deck where the bank holds it, debris in the water elsewhere
          const bank = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => 'kl'.includes(letterAt(deck, x + dx, y + dy)));
          if (bank) {
            rect(ctx, P.c('#5a4028'), px + 4, py + 6, 10, 12);
            polyline(ctx, P.c('#2a1e14'), 0.8, [px + 14, py + 6, px + 16, py + 10, px + 13, py + 13, px + 16, py + 18]);
          } else {
            for (let k = 0; k < 3; k++) rect(ctx, P.c('rgba(70,50,32,0.8)'), px + 4 + k * 6, py + 9 + (k % 2) * 6, 5, 1.6);
          }
          continue;
        }
        rect(ctx, P.c('rgba(0,0,0,0.3)'), px + 2, py + 3, 24, 24);
        rect(ctx, P.c('#6e5236'), px, py, 24, 24);
        const vertical = isDeck(x, y - 1) || isDeck(x, y + 1);
        for (let k = 0; k < 24; k += 3) {
          if (vertical) rect(ctx, P.c(k % 6 ? '#8a6a46' : '#7a5c3a'), px + 1, py + k, 22, 2.4);
          else rect(ctx, P.c(k % 6 ? '#8a6a46' : '#7a5c3a'), px + k, py + 1, 2.4, 22);
        }
        // railings where the deck does not continue
        if (!isDeck(x - 1, y) && vertical) rect(ctx, P.c('#3a2c1e'), px, py, 2, 24);
        if (!isDeck(x + 1, y) && vertical) rect(ctx, P.c('#3a2c1e'), px + 22, py, 2, 24);
        if (!isDeck(x, y - 1) && !vertical) rect(ctx, P.c('#3a2c1e'), px, py, 24, 2);
        if (!isDeck(x, y + 1) && !vertical) rect(ctx, P.c('#3a2c1e'), px, py + 22, 24, 2);
      }
    }
  };
}

// ---- Civilians -------------------------------------------------------------------------------

/** Clothes per civilian type (shirt, trousers or skirt, hair); `f` female, `gun` armed. */
const CIVILIANS = {
  C1: { shirt: '#8a6a4a', legs: '#4a4a5a', hair: '#3a2a1a', gun: true },
  C2: { shirt: '#5a7aa0', legs: '#3c3c48', hair: '#2a2016' },
  C3: { shirt: '#b04a5a', legs: '#5a3a4a', hair: '#7a4a24', f: true },
  C4: { shirt: '#6a9a5a', legs: '#4a5a3a', hair: '#c9a24a', f: true },
  C5: { shirt: '#c9a24a', legs: '#7a5a3a', hair: '#2a2016', f: true },
  C6: { shirt: '#a0a0a0', legs: '#4a4a4a', hair: '#4a3420' },
  C7: { shirt: '#7a3a2a', legs: '#3a3a2a', hair: '#1a1410', gun: true },
  C8: { shirt: '#d8c8a0', legs: '#5a4a3a', hair: '#6a4a2a' },
  C9: { shirt: '#3a5a6a', legs: '#2a2a2a', hair: '#9a9a9a' },
  C10: { shirt: '#eeeeea', legs: '#4a4a5a', hair: '#bdbdbd', coat: true },
  C11: { shirt: '#6a5a8a', legs: '#3a3a4a', hair: '#d0d0d0' },
  TECN: { shirt: '#e4e4dc', legs: '#5a5a62', hair: '#3a2a1a', coat: true, gun: true },
  TECN2: { shirt: '#c8d0dc', legs: '#4a4a52', hair: '#5a3a1a', coat: true, gun: true },
};

/** A civilian seen from above (facing north), in the shape of WebRA's soldiers (sprites.js E1). */
function civilianDraw(c) {
  return (ctx, P) => {
    if (c.gun) rect(ctx, P.c('#2b2b28'), 6.5, 2, 1, 4); // pistol
    circle(ctx, P.c(C.shadow), 5.6, 7, 3.6);
    if (c.f) poly(ctx, P.c(c.legs), [1.5, 9.8, 8.5, 9.8, 7.4, 6.6, 2.6, 6.6]);
    poly(ctx, P.c(c.shirt), [2, 5.5, 8, 5.5, 7.6, 9, 2.4, 9]);
    if (c.coat) poly(ctx, P.c(tone(c.shirt, -0.12)), [2, 8, 8, 8, 8.4, 10.6, 1.6, 10.6]);
    circle(ctx, P.c(C.skin), 5, 6, 1.9);
    circle(ctx, P.c(c.hair), 5, 5.6, 1.6);
  };
}

/**
 * A civilian in panic (OpenRA ScaredyCat "panic-stand" and "panic-run"):
 * both arms thrown up beside the head, the weapon dropped, the body leaning
 * forward into the run.
 */
function civilianPanicDraw(c) {
  return (ctx, P) => {
    circle(ctx, P.c(C.shadow), 5.6, 7.4, 3.6);
    if (c.f) poly(ctx, P.c(c.legs), [1.5, 10.4, 8.5, 10.4, 7.4, 7.2, 2.6, 7.2]);
    poly(ctx, P.c(c.shirt), [2, 6.2, 8, 6.2, 7.6, 9.6, 2.4, 9.6]);
    if (c.coat) poly(ctx, P.c(tone(c.shirt, -0.12)), [2, 8.6, 8, 8.6, 8.4, 11.2, 1.6, 11.2]);
    // Arms up: sleeves from the shoulders past the head, hands at the top.
    for (const [x0, x1] of [[2.4, 1.2], [7.6, 8.8]]) {
      poly(ctx, P.c(c.shirt), [x0 - 0.7, 6.6, x0 + 0.7, 6.6, x1 + 0.6, 1.6, x1 - 0.6, 1.6]);
      circle(ctx, P.c(C.skin), x1, 1.4, 0.8);
    }
    circle(ctx, P.c(C.skin), 5, 5.2, 1.9);
    circle(ctx, P.c(c.hair), 5, 4.8, 1.6);
  };
}

// ---- Tables ------------------------------------------------------------------------------------

/** Structure art by actor id (upper-case): (actor record of rules_json) -> draw(ctx, P). */
const STRUCTURES = {
  HOSP: () => hospital,
  BIO: () => bioLab,
  MISS: () => commCenter,
  FCOM: () => commandPost,
  OILB: () => derrick,
  V01: () => (ctx, P) => church(ctx, P, false),
  V25: () => (ctx, P) => church(ctx, P, true),
  V12: () => (ctx, P) => haystack(ctx, P, 12),
  V13: () => (ctx, P) => haystack(ctx, P, 13),
  V14: () => (ctx, P) => field(ctx, P, 24, 24, 14, 'veg'),
  V15: () => (ctx, P) => field(ctx, P, 24, 24, 15, 'wheat'),
  V16: () => (ctx, P) => field(ctx, P, 24, 24, 16, 'veg'),
  V17: () => (ctx, P) => field(ctx, P, 24, 24, 17, 'wheat'),
  V18: () => (ctx, P) => field(ctx, P, 24, 24, 18, 'veg'),
  RICE: () => (ctx, P) => field(ctx, P, 24, 24, 19, 'rice'),
  V19: () => (ctx, P) => pumpjack(ctx, P, false),
  'V19.HUSK': () => (ctx, P) => pumpjack(ctx, P, true),
  LHUS: () => (ctx, P) => {
    castShadows(ctx, P, [{ cx: 11, cy: 17, r: 4, z: 14 }]);
    cylinder(ctx, P, 11, 17, 4, 13, K('#e8e4dc'), K('#c8261c'), { bands: [[4, 5.5, K('#c8261c')], [8.5, 10, K('#c8261c')]] });
    const [lx, ly] = at(11, 17, 14);
    disc(ctx, P.c('rgba(255,230,140,0.5)'), lx, ly, 4);
    disc(ctx, P.c('#fff2b0'), lx, ly, 2);
  },
  WINDMILL: () => (ctx, P) => {
    castShadows(ctx, P, [{ cx: 11, cy: 16, r: 6, z: 14 }]);
    prism(ctx, P, 11, 16, 6, 8, 12, K('#b8a888'), K('#8a3a2a'));
    const [hx, hy] = at(11, 21, 10);
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const tip = [hx + Math.cos(a) * 8, hy + Math.sin(a) * 8];
      stroke(ctx, P.c('#4a3420'), 1.2, hx, hy, tip[0], tip[1]);
      quad(ctx, P.c('rgba(230,224,206,0.9)'), [hx + Math.cos(a) * 3, hy + Math.sin(a) * 3, tip[0], tip[1], tip[0] + Math.cos(a + 1.6) * 3, tip[1] + Math.sin(a + 1.6) * 3, hx + Math.cos(a + 0.5) * 3, hy + Math.sin(a + 0.5) * 3]);
    }
    disc(ctx, P.c('#3a2c20'), hx, hy, 1.4);
  },
  RUSHOUSE: () => (ctx, P) => cottage(ctx, P, 2, 15, 19, 29, 9, 31, { wall: '#7a5a3a', roof: '#4d4438', axis: 'y' }),
  SNOWHUT: () => (ctx, P) => cottage(ctx, P, 2, 13, 20, 31, 8, 37, { wall: '#8a6a4a', roof: '#e8eef4', axis: 'y' }),
  ASIANHUT: () => (ctx, P) => cottage(ctx, P, 3, 6, 18, 15, 6, 41, { wall: '#b9a27a', roof: '#c9a83e', chimney: false }),
  RAILMINE: () => (ctx, P) => {
    rect(ctx, P.c('#5a4a3a'), 0, 4, 48, 18);
    for (let x = 2; x < 48; x += 4) rect(ctx, P.c('#4a3420'), x, 12, 2, 8);
    for (const y of [13, 18]) rect(ctx, P.c('#8a8e93'), 0, y, 48, 1);
    castShadows(ctx, P, [{ x: 30, y: 8, w: 16, d: 10, z: 8 }]);
    const V = box(ctx, P, 30, 8, 16, 10, 8, K('#6b5a44'), K('#7a6850'));
    patch(ctx, P.c('#1a1410'), V, 'front', 4, 0, 12, 6);
  },
  CTFLAG: () => flag,
  BARL: () => (ctx, P) => {
    castShadows(ctx, P, [{ cx: 12, cy: 14, r: 3.6, z: 7 }]);
    oilBarrel(ctx, P, 12, 14);
  },
  BRL3: () => (ctx, P) => {
    castShadows(ctx, P, [{ cx: 8, cy: 11, r: 3.6, z: 7 }, { cx: 16, cy: 11, r: 3.6, z: 7 }, { cx: 12, cy: 17, r: 3.6, z: 7 }]);
    oilBarrel(ctx, P, 8, 11);
    oilBarrel(ctx, P, 16, 11, '#8a6a2a');
    oilBarrel(ctx, P, 12, 17);
  },
  AMMOBOX1: () => (ctx, P) => ammoBox(ctx, P, 1),
  AMMOBOX2: () => (ctx, P) => ammoBox(ctx, P, 2),
  AMMOBOX3: () => (ctx, P) => ammoBox(ctx, P, 3),
  UTILPOL1: () => (ctx, P) => utilityPole(ctx, P, 1),
  UTILPOL2: () => (ctx, P) => utilityPole(ctx, P, 2),
  TANKTRAP1: () => (ctx, P) => tankTrap(ctx, P, 1),
  TANKTRAP2: () => (ctx, P) => tankTrap(ctx, P, 2),
  MINE: () => (ctx, P) => oreMine(ctx, P, false),
  GMINE: () => (ctx, P) => oreMine(ctx, P, true),
  CYCL: () => chainLink,
  BARB: () => barbedWire,
  WOOD: () => woodFence,
  BRIDGEHUT: () => () => {},
  'BRIDGEHUT.SMALL': () => () => {},
};

/** Houses by id: [kind, seed]; temperate cottages and desert adobes in their footprint box. */
function houseDraw(id, a) {
  const w = (a.width ?? 1) * 24;
  const h = (a.height ?? 1) * 24;
  const desert = (a.world?.biomes ?? []).includes('desert') && !(a.world?.biomes ?? []).includes('temperate');
  const seed = seedOf(id);
  const cells = occupied(a);
  return (ctx, P) => {
    if (cells.length && cells.length < (a.width ?? 1) * (a.height ?? 1) && id === 'V37') {
      // An irregular footprint (V37): a building on each pair of occupied cells.
      const xs = cells.map((c) => c[0]);
      const ys = cells.map((c) => c[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      adobe(ctx, P, x0 * 24 + 2, y0 * 24 + 8, (Math.max(...xs) - x0 + 1) * 24 - 4, (Math.max(...ys) - y0 + 1) * 24 - 12, 9, seed, { tower: true });
      return;
    }
    const big = w >= 48 && h >= 48;
    if (desert) {
      adobe(ctx, P, 2, big ? 10 : 7, w - 5, h - (big ? 14 : 10), big ? 11 : 8, seed, { dome: seed % 3 === 0, tower: big && seed % 2 === 0 });
    } else {
      cottage(ctx, P, 3, big ? 10 : 7, w - 7, h - (big ? 16 : 10), big ? 10 : 7, seed);
    }
  };
}

/**
 * The draw function of a neutral world actor (rules_json record `a`), or
 * null when it is not one: trees and stumps, houses, tech buildings,
 * decorations, bridges.
 */
export function worldDraw(a) {
  const id = String(a.id).toUpperCase();
  if (a.world?.bridge) return bridgeDraw(a, false);
  if (STRUCTURES[id]) return STRUCTURES[id](a);
  if (/^(T\d\d|TC\d\d)\.HUSK$/.test(id)) return stumpDraw(id, a);
  if (/^(T\d\d|TC\d\d)$/.test(id)) return treeDraw(id, a);
  if (/^BOXES\d\d$/.test(id)) return (ctx, P) => boxes(ctx, P, seedOf(id));
  if (/^ICE\d\d$/.test(id)) return (ctx, P) => iceFloe(ctx, P, a, seedOf(id));
  if (/^ROCK\d$/.test(id)) return (ctx, P) => rocks(ctx, P, a, seedOf(id));
  if (/^V\d\d$/.test(id)) return houseDraw(id, a);
  return null;
}

/** The second sprite slot of a world actor: a destroyed bridge (engine bridges.rs bridge_sprite). */
export function worldSecond(a) {
  return a.world?.bridge ? [a.width * 24, a.height * 24, bridgeDraw(a, true)] : null;
}

/**
 * Civilian infantry ({ body, panic: [w, h, draw] }, like sprites.js UNIT_DRAW):
 * the panic pose fills the second sprite slot, where soldiers lie prone.
 */
export const CIVILIAN_DRAW = Object.fromEntries(
  Object.entries(CIVILIANS).map(([id, c]) => [id, { body: [10, 12, civilianDraw(c)], panic: [10, 12, civilianPanicDraw(c)] }]),
);

/** A tree fire `s` times the size of the small one (decoration specials 2, 4 and 5). */
function treeFire(s) {
  const w = Math.ceil(14 * s);
  const h = Math.ceil(18 * s);
  const k = (pts) => pts.map((v) => v * s);
  return [w, h, (ctx, P) => {
    oval(ctx, P.c('rgba(255,120,30,0.35)'), 7 * s, 13 * s, 6.5 * s, 4 * s);
    poly(ctx, P.c('#d8481a'), k([1.5, 16, 3, 7, 5, 10, 7, 2, 9, 9, 11, 5, 12.5, 16]));
    poly(ctx, P.c('#f59a2a'), k([3.5, 16, 5, 10, 7, 6, 9, 11, 10.5, 16]));
    poly(ctx, P.c('#ffe08a'), k([5.5, 16, 7, 11, 8.5, 16]));
  }];
}

/**
 * Decoration specials (art/decorations.js slots 2 to 5, engine neutral.rs
 * DECORATION_*): the small fire on a burning tree, the hospital's red cross
 * over healed infantry, then the medium and the large fire (OpenRA's
 * burn-s, burn-m and burn-l by damage state).
 */
export const WORLD_DECORATIONS = [
  treeFire(0.7),
  [7, 7, (ctx, P) => {
    rect(ctx, P.c('#f4f2ec'), 0, 0, 7, 7);
    rect(ctx, P.c('#c8261c'), 2.6, 1, 1.8, 5);
    rect(ctx, P.c('#c8261c'), 1, 2.6, 5, 1.8);
  }],
  treeFire(0.85),
  treeFire(1),
];
