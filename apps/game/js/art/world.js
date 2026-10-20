// Procedural art for the neutral world of OpenRA maps (engine/src/neutral.rs,
// bridges.rs): trees and their burnt stumps, civilian houses, fields and huts,
// tech buildings (hospital, bio lab, communications center, forward command
// post; the oil derrick is pixel art, art/pixel.js), barrels and ammo boxes,
// crates, ice floes, rocks, poles and tank traps, ore and gem mines, the
// map-only walls, bridges and the civilians.
//
// The minimal look of the design board "Retexture 2D en 3D" (0.21.0): seen
// straight from above, every object is three to six flat blocks in the
// colours the 3D minimal pack uses too (art/shared-palette.js), with one hard
// shadow to the lower right, and keeps the one or two things that make it
// recognisable (the hospital's red cross, the church's steeple, the
// windmill's sails, the mine's shaft). Captured tech buildings show their
// owner as one strip along the front. Civilians are not team coloured: the
// original art draws them with fixed civilian palettes. Trees, huts, rocks and mines look
// like the map's biome (`P.biome`: temperate, snow or desert;
// js/sprites.js buildAtlas passes it).
//
// Structures fill their footprint box (cells times 24 world pixels) as the
// original sprites do; the few whose original sprite reaches past the
// footprint (the lighthouse and the windmill stand tall) draw into the box
// worldBox gives, grown evenly around the footprint's centre. Trees and the
// like draw only over their occupied cells (footprints such as
// `__ x_`: the trunk stands on the occupied cell, the crown leans into the
// empty ones above).

import { C, rect, rrect, circle, poly } from './kit.js';
import { pixelDraw } from './pixel.js';
import { tone, oval } from './volume.js';
import { SHARED_PALETTE } from './shared-palette.js';
import { ORIGINAL_BOUNDS } from '../content/render-facts.js';

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

// ---- Colours and blocks -------------------------------------------------------------------

/** The shared materials and the terrain colours of the map's biome. */
const M = SHARED_PALETTE.materials;
const ground = (P) => SHARED_PALETTE.terrain[biomeOf(P)] ?? SHARED_PALETTE.terrain.temperate;
/** The one hard shadow: black at the shared alpha, offset by the shared fraction of a cell. */
const SHADOW = `rgba(0,0,0,${SHARED_PALETTE.shadow.alpha})`;
const SHADOW_OFFSET = SHARED_PALETTE.shadow.offset * 24;

/** A flat block, square or with rounded corners (`r`). */
function flat(ctx, P, fill, x, y, w, h, r = 0) {
  if (r > 0) rrect(ctx, P.c(fill), x, y, w, h, Math.min(r, w / 2, h / 2));
  else rect(ctx, P.c(fill), x, y, w, h);
}

/** A block with its hard shadow to the lower right. */
function slab(ctx, P, fill, x, y, w, h, r = 0) {
  flat(ctx, P, SHADOW, x + SHADOW_OFFSET, y + SHADOW_OFFSET, w, h, r);
  flat(ctx, P, fill, x, y, w, h, r);
}

/** The owner's strip along the front of a tech building (captured buildings show their owner). */
function teamStrip(ctx, P, x, y, w, h) {
  rect(ctx, P.team(0.9), x, y, w, h);
}

/** A thin block from (x0, y0) to (x1, y1), `w` wide: a blade, a bar or a beam that is not upright. */
function bar(ctx, fill, x0, y0, x1, y1, w) {
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = (-(y1 - y0) / len) * (w / 2);
  const ny = ((x1 - x0) / len) * (w / 2);
  poly(ctx, fill, [x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny]);
}

// ---- The original extent --------------------------------------------------------------------

/**
 * How big the original sprite of world actor `a` (rules_json record) looks,
 * in world pixels around the footprint's centre: [x0, y0, x1, y1]. The original
 * art's DecorationBounds, else its Bounds (content/render-facts.js
 * ORIGINAL_BOUNDS, around the actor's centre: the footprint's centre plus
 * `centerOffset`), else the footprint itself (the original frames of
 * structures without bounds are their footprint).
 */
export function originalExtent(a) {
  const b = ORIGINAL_BOUNDS[a.id] ?? ORIGINAL_BOUNDS[String(a.id).toUpperCase()];
  const rec = b?.decoration ?? b?.bounds;
  const [cw, ch] = [(a.width ?? 1) * 12, (a.height ?? 1) * 12];
  if (!rec) return [-cw, -ch, cw, ch];
  const k = 24 / 1024;
  const [ox, oy] = a.centerOffset ?? [0, 0];
  const cx = ox + rec[2] * k;
  const cy = oy + rec[3] * k;
  return [cx - (rec[0] * k) / 2, cy - (rec[1] * k) / 2, cx + (rec[0] * k) / 2, cy + (rec[1] * k) / 2];
}

/**
 * The box [w, h] (world pixels) a world structure draws into when its
 * original sprite reaches past its footprint (the lighthouse, the windmill):
 * the footprint grown evenly around its centre so it holds originalExtent,
 * like art/pixel.js pixelBox. Null when the footprint holds it.
 */
export function worldBox(a) {
  if (!worldDraw(a) || a.world?.bridge) return null;
  const [x0, y0, x1, y1] = originalExtent(a);
  const half = (cells, lo, hi) => Math.max(cells * 12, Math.ceil(-lo - 0.01), Math.ceil(hi - 0.01));
  const w = 2 * half(a.width ?? 1, x0, x1);
  const h = 2 * half(a.height ?? 1, y0, y1);
  return w === (a.width ?? 1) * 24 && h === (a.height ?? 1) * 24 ? null : [w, h];
}

/** Where originalExtent lies in the box of `a` (worldBox or the footprint): [x0, y0, x1, y1]. */
function extentInBox(a) {
  const [w, h] = worldBox(a) ?? [(a.width ?? 1) * 24, (a.height ?? 1) * 24];
  const [x0, y0, x1, y1] = originalExtent(a);
  return [x0 + w / 2, y0 + h / 2, x1 + w / 2, y1 + h / 2];
}

// ---- Trees ------------------------------------------------------------------------------

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
 * One tree standing on the cell centred at (cx, cy): two blocks, the trunk
 * and the crown over it (a lit top and a darker front face, snow on the top
 * in the snow biome), as on the terrain's tree cells. The crown leans into the cells above and
 * stays inside the footprint box (`boxWidth` wide).
 */
function treeAt(ctx, P, kind, cx, cy, seed, boxWidth = 24) {
  const g = ground(P);
  // Snow and desert maps get their own kinds of tree.
  if (biomeOf(P) === 'desert' && (kind === 'round' || kind === 'pine')) kind = seed % 3 === 0 ? 'cactus' : 'palm';
  if (kind === 'cactus') {
    slab(ctx, P, g.treeDark, cx - 2.5, Math.max(1, cy - 14), 5, Math.min(22, cy + 8 - 1));
    slab(ctx, P, g.treeDark, cx - 7, cy - 6, 14, 4, 1);
    return;
  }
  // The crown's size by kind: [half width, reach above the centre, reach below].
  const [hw, up, down] = { pine: [9, 24, 4], palm: [13, 16, 0], bush: [9, 8, 6] }[kind] ?? [13, 22, 4];
  const x0 = Math.max(1, cx - hw + (seed % 3) - 1);
  const x1 = Math.min(boxWidth - 2, cx + hw + (seed % 3) - 1);
  const y0 = Math.max(1, cy - up);
  const y1 = cy + down;
  if (kind !== 'bush') slab(ctx, P, g.trunk, cx - 2, y1 - 2, 4, cy + 9 - y1);
  // The crown: its darker body and the lit top over most of it (a conifer is darker and narrower).
  const [body, lit] = kind === 'pine' ? [tone(g.treeDark, -0.2), g.treeDark] : [g.treeDark, g.tree];
  const r = kind === 'pine' ? 1 : 3;
  slab(ctx, P, body, x0, y0, x1 - x0, y1 - y0, r);
  flat(ctx, P, biomeOf(P) === 'snow' ? M.steam : lit, x0, y0, x1 - x0, (y1 - y0) * 0.62, r);
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

/** A burnt stump on each occupied cell: a charred patch, the stump and its cut top. */
function stumpDraw(id, a) {
  const cells = occupied(a);
  return (ctx, P) => {
    cells.forEach(([dx, dy]) => {
      const [cx, cy] = cellCentre(dx, dy);
      flat(ctx, P, 'rgba(20,16,12,0.5)', cx - 9, cy - 4, 18, 12, 4);
      slab(ctx, P, M.char, cx - 3, cy - 2, 6, 6, 1);
      flat(ctx, P, M.ash, cx - 2, cy - 1, 4, 2.5);
    });
  };
}

// ---- Civilian buildings ---------------------------------------------------------------------

/** House walls and roofs (design board "Wereldobjecten" in the shared materials). */
const WALLS = [M.wall, M.paint, M.sand];
const ROOFS = [M.tiles, M.brick, M.dark];

/**
 * A cottage filling (x, y, w, d): walls, a roof over most of it with a
 * darker ridge, a door in the front wall and maybe a chimney.
 */
function cottage(ctx, P, x, y, w, d, seed, o = {}) {
  const r = rng(seed);
  const wall = o.wall ?? WALLS[Math.floor(r() * WALLS.length)];
  const roof = o.roof ?? (biomeOf(P) === 'snow' ? M.steam : ROOFS[Math.floor(r() * ROOFS.length)]);
  const roofD = d * 0.68;
  slab(ctx, P, wall, x, y, w, d);
  flat(ctx, P, roof, x, y, w, roofD);
  if (w >= d) flat(ctx, P, tone(roof, -0.22), x, y + roofD / 2 - 0.75, w, 1.5);
  else flat(ctx, P, tone(roof, -0.22), x + w / 2 - 0.75, y, 1.5, roofD);
  flat(ctx, P, M.darker, x + w / 2 - 2, y + d - Math.min(6, d * 0.3), 4, Math.min(6, d * 0.3));
  if (o.chimney ?? r() < 0.5) flat(ctx, P, M.dark, x + w * (0.2 + r() * 0.5), y + roofD * 0.15, 3, 3);
}

/** A flat-roofed adobe house filling (x, y, w, d): walls, a lighter roof inside its parapet, a door, maybe a dome. */
function adobe(ctx, P, x, y, w, d, seed, o = {}) {
  slab(ctx, P, M.sandy, x, y, w, d);
  flat(ctx, P, M.sand, x + 2, y + 2, w - 4, d - 6);
  flat(ctx, P, M.darker, x + w * 0.3, y + d - 4, 4, 4);
  if (o.dome) slab(ctx, P, M.paint, x + w / 2 - d * 0.22, y + d * 0.2, d * 0.44, d * 0.44, d * 0.22);
  if (o.tower) slab(ctx, P, tone(M.sandy, -0.1), x + w - 8, y + 2, 6, 6);
  if (seed % 2) flat(ctx, P, tone(M.sand, -0.1), x + 4, y + 4, 5, 5);
}

/** A church: a nave and the steeple with its gold cross (temperate), or a domed one (desert). */
function church(ctx, P, desert) {
  if (desert) {
    slab(ctx, P, M.sandy, 1, 1, 45, 45);
    flat(ctx, P, M.sand, 3, 3, 41, 37);
    slab(ctx, P, M.paint, 12, 12, 20, 20, 10);
    slab(ctx, P, tone(M.sandy, -0.1), 35, 4, 9, 9);
    flat(ctx, P, M.darker, 19, 40, 6, 6);
    return;
  }
  slab(ctx, P, M.wall, 1, 14, 45, 32);
  flat(ctx, P, M.dark, 1, 14, 45, 22);
  slab(ctx, P, M.wall, 6, 1, 14, 16);
  flat(ctx, P, M.dark, 8, 3, 10, 10);
  flat(ctx, P, M.gold, 12, 4, 2, 7);
  flat(ctx, P, M.gold, 10, 6, 6, 2);
}

/** A field: tilled soil with three rows of a crop. */
function field(ctx, P, crop) {
  const soil = crop === 'rice' ? ground(P).ford : biomeOf(P) === 'snow' ? SHARED_PALETTE.terrain.snow.rough : M.dirt;
  const plant = crop === 'wheat' ? M.yellow : M.camo2;
  flat(ctx, P, soil, 0.5, 0.5, 23, 23);
  for (const x of [3, 10, 17]) flat(ctx, P, plant, x, 2, 4, 20);
}

/** A haystack: a rounded straw heap with a lighter top (or an igloo on snow maps, as in the original art). */
function haystack(ctx, P) {
  if (biomeOf(P) === 'snow') {
    slab(ctx, P, M.steam, 2, 2, 19, 19, 9);
    flat(ctx, P, M.dome, 5, 5, 9, 6, 3);
    flat(ctx, P, M.dark, 9, 16, 5, 5, 1);
    return;
  }
  slab(ctx, P, M.sandy, 2, 2, 19, 19, 7);
  flat(ctx, P, M.sand, 5, 5, 10, 8, 4);
}

/** Oil pump (V19): a pad, the pump's base, its beam and the yellow head; burnt, all charred. */
function pumpjack(ctx, P, burnt = false) {
  slab(ctx, P, burnt ? M.char2 : M.concrete, 1, 2, 21, 20);
  slab(ctx, P, burnt ? M.char : M.dark, 10, 7, 5, 11);
  slab(ctx, P, burnt ? M.char2 : M.darker, 3, 9, 18, 3);
  flat(ctx, P, burnt ? M.ash : M.yellow, 2, 7, 5, 7, 1);
}

// ---- Tech buildings ----------------------------------------------------------------------------

/** Hospital (HOSP): a white roof with the red cross, the owner's strip in front. */
function hospital(ctx, P) {
  slab(ctx, P, M.wall, 1, 1, 45, 45);
  flat(ctx, P, M.paint, 4, 4, 39, 34);
  flat(ctx, P, M.red, 19, 8, 9, 26);
  flat(ctx, P, M.red, 10, 16.5, 27, 9);
  teamStrip(ctx, P, 1, 42, 45, 4);
}

/** Bio lab: concrete with a green glass roof and the round glowing sample tank. */
function bioLab(ctx, P) {
  slab(ctx, P, M.concrete, 1, 1, 45, 45);
  flat(ctx, P, M.radar, 4, 4, 22, 34);
  slab(ctx, P, M.camo, 29, 6, 15, 15, 7.5);
  flat(ctx, P, M.green, 33, 10, 7, 7, 3.5);
  teamStrip(ctx, P, 1, 42, 45, 4);
}

/** Communications center (MISS): the building over its two back rows, a glass band, the big dish; the pad in front. */
function commCenter(ctx, P) {
  flat(ctx, P, M.concrete, 0, 48, 72, 24);
  slab(ctx, P, M.wall, 1, 1, 69, 45);
  flat(ctx, P, M.glass, 5, 32, 61, 6);
  slab(ctx, P, M.dome, 8, 5, 22, 22, 11);
  teamStrip(ctx, P, 1, 42, 69, 4);
}

/** Forward command post (FCOM): canvas over its two back rows, a seam, the radar dish; the pad in front. */
function commandPost(ctx, P) {
  flat(ctx, P, M.concrete, 0, 48, 48, 24);
  slab(ctx, P, M.canvas, 1, 1, 45, 45);
  flat(ctx, P, tone(M.canvas, -0.18), 1, 20, 45, 2);
  slab(ctx, P, M.steel2, 26, 5, 14, 11, 5.5);
  teamStrip(ctx, P, 1, 42, 45, 4);
}

/** Lighthouse (LHUS): a rock plinth, the white tower with a red band and the lamp, as tall as the original. */
function lighthouse(a) {
  return (ctx, P) => {
    const [x0, y0, x1, y1] = extentInBox(a);
    const w = x1 - x0;
    const h = y1 - y0;
    slab(ctx, P, ground(P).rock, x0 + 1, y1 - h * 0.25, w - 3, h * 0.25 - 1, 2);
    slab(ctx, P, M.paint, x0 + w * 0.25, y0 + h * 0.12, w * 0.5, h * 0.66);
    flat(ctx, P, M.red, x0 + w * 0.25, y0 + h * 0.36, w * 0.5, h * 0.1);
    flat(ctx, P, M.dark, x0 + w * 0.2, y0 + 1, w * 0.6, h * 0.13);
    flat(ctx, P, M.glow, x0 + w * 0.32, y0 + 2, w * 0.36, h * 0.08);
  };
}

/** Windmill: a tower with its cap and the four sails crossed in front, as big as the original. */
function windmill(a) {
  return (ctx, P) => {
    const [x0, y0, x1, y1] = extentInBox(a);
    const w = x1 - x0;
    const h = y1 - y0;
    const [hx, hy] = [x0 + w / 2, y0 + h * 0.4];
    slab(ctx, P, M.sand, hx - w * 0.17, y0 + h * 0.3, w * 0.34, h * 0.7 - 1);
    flat(ctx, P, M.tiles, hx - w * 0.2, y0 + h * 0.24, w * 0.4, h * 0.14);
    bar(ctx, P.c(M.paint), x0 + 2, y0 + 2, x1 - 2, y0 + h * 0.8 - 2, 3.5);
    bar(ctx, P.c(M.paint), x1 - 2, y0 + 2, x0 + 2, y0 + h * 0.8 - 2, 3.5);
    circle(ctx, P.c(M.darker), hx, hy, 2);
  };
}

/** A hut (RUSHOUSE, SNOWHUT, ASIANHUT): a cottage filling its footprint. */
const hut = (o, seed) => (a) => (ctx, P) => cottage(ctx, P, 1, 1, (a.width ?? 1) * 24 - 3, (a.height ?? 1) * 24 - 3, seed, o);

/** The mine railway (RAILMINE): a track bed with two rails running into the mine's wooden mouth. */
function railMine(ctx, P) {
  flat(ctx, P, M.dirt, 0, 3, 48, 19);
  flat(ctx, P, M.steel, 0, 8, 48, 1.5);
  flat(ctx, P, M.steel, 0, 15, 48, 1.5);
  slab(ctx, P, M.wood, 30, 2, 16, 18);
  flat(ctx, P, M.darker, 34, 10, 8, 10);
}

// ---- Barrels, boxes and other props ------------------------------------------------------

/** A red oil drum seen from above: the drum, its yellow band and the lit lid. */
function drum(ctx, P, x, y, s, tint = M.red) {
  slab(ctx, P, tint, x, y, s, s, s / 2);
  flat(ctx, P, M.yellow, x, y + s * 0.42, s, s * 0.18);
}

/** A wooden crate: the box and one dark seam across it. */
function crateBox(ctx, P, x, y, s, wood = M.wood) {
  slab(ctx, P, wood, x, y, s, s);
  flat(ctx, P, tone(wood, -0.3), x, y + s / 2 - 0.6, s, 1.2);
}

function boxes(ctx, P, seed) {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 3);
  const items = [];
  for (let k = 0; k < n; k++) items.push({ x: 2 + r() * 9, y: 3 + r() * 9, s: 7 + r() * 4 });
  items.sort((a, b) => a.y - b.y);
  items.forEach((b, k) => crateBox(ctx, P, b.x, b.y, b.s, k % 2 ? tone(M.wood, -0.1) : M.wood));
}

/** Ammo boxes: olive, two dark straps and a yellow stencil. */
function ammoBox(ctx, P, seed) {
  const y = 6 + (seed % 3);
  slab(ctx, P, M.olive, 3, y, 18, 11);
  flat(ctx, P, tone(M.olive, -0.25), 6, y, 2, 11);
  flat(ctx, P, tone(M.olive, -0.25), 15, y, 2, 11);
  flat(ctx, P, M.yellow, 10, y + 4, 4, 3);
}

/** Ice floes: a white slab with a pale blue rim on each occupied cell. */
function iceFloe(ctx, P, a, seed) {
  const r = rng(seed);
  for (const [dx, dy] of occupied(a)) {
    const [x, y] = [dx * 24 + 1 + r() * 2, dy * 24 + 1 + r() * 2];
    slab(ctx, P, M.ice, x, y, 20, 19, 6);
    flat(ctx, P, M.ice2, x + 1.5, y + 1.5, 15, 13, 5);
  }
}

/** Rocks: a boulder with its lit top on each occupied cell, in the biome's rock tones. */
function rocks(ctx, P, a, seed) {
  const r = rng(seed);
  const g = ground(P);
  for (const [dx, dy] of occupied(a)) {
    const [x, y] = [dx * 24 + 2 + r() * 3, dy * 24 + 3 + r() * 3];
    slab(ctx, P, g.rockDark, x, y, 17, 14, 3);
    flat(ctx, P, g.rockLight, x, y, 17, 7, 3);
  }
}

/** A utility pole seen from above: the pole and its crossbar (no wires). */
function utilityPole(ctx, P, seed) {
  const x = 10 + (seed % 2) * 2;
  slab(ctx, P, M.wood, x, 3, 2.5, 18);
  slab(ctx, P, tone(M.wood, -0.2), x - 7, 6, 16.5, 2.2);
}

/** Tank traps: steel hedgehogs, two crossed beams each. */
function tankTrap(ctx, P, seed) {
  const r = rng(seed);
  for (let k = 0; k < (seed % 2 ? 1 : 2); k++) {
    const [cx, cy] = [seed % 2 ? 12 : 7 + k * 10, 9 + r() * 6];
    bar(ctx, P.c(SHADOW), cx - 5 + SHADOW_OFFSET, cy - 5 + SHADOW_OFFSET, cx + 5 + SHADOW_OFFSET, cy + 5 + SHADOW_OFFSET, 2.6);
    bar(ctx, P.c(M.dark), cx - 5, cy - 5, cx + 5, cy + 5, 2.6);
    bar(ctx, P.c(M.steel), cx + 5, cy - 5, cx - 5, cy + 5, 2.6);
  }
}

/**
 * Mine colours (the shared palette's ore, oreDark and gems, materials.ice2
 * for the gems' glint): the ore's base and lit tones; the gems' blue and
 * magenta crystals with their pale glint.
 */
export const MINE_ORE = Object.freeze({ base: SHARED_PALETTE.terrain.temperate.oreDark, lit: SHARED_PALETTE.terrain.temperate.ore });
export const MINE_GEMS = Object.freeze({ blue: SHARED_PALETTE.terrain.temperate.gems[0], magenta: SHARED_PALETTE.terrain.temperate.gems[1], glint: M.ice2 });
/** The pit of a mine: its dark shaft and the lit inner wall facing the light. */
const PIT = { deep: '#14110d', wall: '#3a3026' };

/**
 * An ore or gem mine: a crater of the biome's rock round a dark shaft (its
 * lit inner wall on the far side), with two blocks of ore or two crystals,
 * one in the shaft and one spilled over the rim at the lower left, where the
 * fields around it start.
 */
function oreMine(ctx, P, gems) {
  const g = ground(P);
  slab(ctx, P, g.rock, 1, 1, 22, 21, 7);
  flat(ctx, P, g.rockLight, 3, 2, 18, 5, 2.5);
  flat(ctx, P, PIT.wall, 5, 5, 15, 12, 5);
  flat(ctx, P, PIT.deep, 6, 5.5, 11, 9, 4);
  const block = (x, y, w, h, lit, base) => {
    slab(ctx, P, base, x, y, w, h);
    flat(ctx, P, lit, x, y, w, h * 0.6);
  };
  if (gems) {
    block(9, 6, 5, 6, MINE_GEMS.blue, tone(MINE_GEMS.blue, -0.3));
    block(2, 14, 6, 7, MINE_GEMS.magenta, tone(MINE_GEMS.magenta, -0.3));
    flat(ctx, P, MINE_GEMS.glint, 2, 14, 2, 2);
  } else {
    block(9, 7, 6, 5, MINE_ORE.lit, MINE_ORE.base);
    block(2, 15, 7, 6, MINE_ORE.lit, MINE_ORE.base);
  }
}

/** The capture-the-flag flag: a footing, the pole and the owner's flag. */
function flag(ctx, P) {
  slab(ctx, P, M.concrete, 7, 16, 8, 5);
  flat(ctx, P, M.steel2, 9.6, 3, 1.4, 15);
  rect(ctx, P.team(0.9), 11, 3, 8, 5.5);
}

/** Map-only walls (tile sideways like buildings.js FENC): chain-link, barbed wire, wood. */
function chainLink(ctx, P) {
  flat(ctx, P, SHADOW, 0, 10 + SHADOW_OFFSET, 24, 4);
  flat(ctx, P, 'rgba(170,183,195,0.55)', 0, 9, 24, 5);
  flat(ctx, P, M.steel2, 0, 8, 24, 1.5);
  slab(ctx, P, M.steel, 2, 6, 2.5, 10);
  slab(ctx, P, M.steel, 19.5, 6, 2.5, 10);
}

function barbedWire(ctx, P) {
  slab(ctx, P, M.dark, 0, 8, 24, 7, 3.5);
  flat(ctx, P, M.steel2, 0, 10.5, 24, 1.5);
  slab(ctx, P, M.wood, 4, 6, 2.5, 11);
  slab(ctx, P, M.wood, 18, 6, 2.5, 11);
}

function woodFence(ctx, P) {
  slab(ctx, P, M.wood, 0, 9, 24, 2);
  slab(ctx, P, M.wood, 0, 14, 24, 2);
  for (const x of [3, 11, 19]) slab(ctx, P, tone(M.wood, -0.25), x, 6, 2.5, 13);
}

// ---- Bridges ---------------------------------------------------------------------------------

/** Template rows of a bridge for the biome (rules_json world.bridge), or the first biome's. */
function bridgeTemplate(a, P) {
  const t = a.world?.bridge ?? {};
  return t[biomeOf(P)] ?? Object.values(t)[0] ?? null;
}

const letterAt = (rows, x, y) => (rows[y] ?? '')[x] ?? '.';
const DECK = tone(M.wood, -0.2);
const RAIL = tone(M.wood, -0.5);

/**
 * A bridge over its template's cells: a flat wooden deck on the bridge
 * cells (railings where the deck ends), concrete abutments on the bank
 * cells; with `destroyed` the broken stubs, a little debris and a gap. The
 * terrain under the deck (bridge cells) is drawn as river by the terrain art.
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
          slab(ctx, P, M.concrete, px + 1, py + 2, 21, destroyed ? 12 : 20);
          continue;
        }
        if (c !== 'g') continue;
        if (destroyed) {
          // a stub of deck where the bank holds it, debris in the water elsewhere
          const bank = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => 'kl'.includes(letterAt(deck, x + dx, y + dy)));
          if (bank) slab(ctx, P, DECK, px + 4, py + 6, 10, 12);
          else slab(ctx, P, M.char, px + 6, py + 9, 10, 4);
          continue;
        }
        flat(ctx, P, SHADOW, px + 2, py + 2, 22, 22);
        flat(ctx, P, DECK, px, py, 24, 24);
        const vertical = isDeck(x, y - 1) || isDeck(x, y + 1);
        // railings where the deck does not continue
        if (!isDeck(x - 1, y) && vertical) flat(ctx, P, RAIL, px, py, 2, 24);
        if (!isDeck(x + 1, y) && vertical) flat(ctx, P, RAIL, px + 22, py, 2, 24);
        if (!isDeck(x, y - 1) && !vertical) flat(ctx, P, RAIL, px, py, 24, 2);
        if (!isDeck(x, y + 1) && !vertical) flat(ctx, P, RAIL, px, py + 22, 24, 2);
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
  // The campaign's characters (tools/gen_content_tables.py MISSION_ART):
  // Einstein in his lab coat, the agents Delphi and Chan, a Soviet general.
  EINSTEIN: { shirt: '#f2f2ee', legs: '#5a5a62', hair: '#e8e8e8', coat: true },
  DELPHI: { shirt: '#3a3a42', legs: '#26262c', hair: '#2a2016', gun: true },
  CHAN: { shirt: '#e4e8ec', legs: '#3c3c48', hair: '#141210', coat: true },
  GNRL: { shirt: '#5a6040', legs: '#3e4230', hair: '#8a2a20', coat: true, gun: true },
};

/**
 * The civilians' sprite box: the soldiers' size in the 0.21 retexture, 12 x 16, the figure filling it. They carry
 * no shadow of their own: the renderer casts the ground shadow of every slot whose draw function has
 * `groundShadow` set (js/sprites.js shadowSlots, as the soldiers do).
 */
const CIV_W = 12;
const CIV_H = 16;
const FIG_W = CIV_W;
const FIG_H = CIV_H;

/** Marks a civilian draw function for the renderer's ground shadow. */
function grounded(draw) {
  draw.groundShadow = true;
  return draw;
}

/** The civilian's legs (trousers, or a skirt for `f`) under the shoulders. */
function civilianLegs(ctx, P, c, y) {
  if (c.f) flat(ctx, P, c.legs, 1, y, FIG_W - 2, FIG_H - y, 1);
  else {
    flat(ctx, P, c.legs, 1.5, y, 3, FIG_H - y, 1);
    flat(ctx, P, c.legs, FIG_W - 4.5, y, 3, FIG_H - y, 1);
  }
}

/**
 * A civilian seen from above (facing north), in the shape of WebRA's
 * soldiers: the shirt (or a longer coat) over the legs, the head with its
 * hair, a pistol held forward when armed.
 */
function civilianDraw(c) {
  return grounded((ctx, P) => {
    civilianLegs(ctx, P, c, 9.5);
    flat(ctx, P, c.coat ? tone(c.shirt, -0.12) : c.shirt, 0, 4.5, FIG_W, c.coat ? 8 : 6, 2.5);
    circle(ctx, P.c(C.skin), FIG_W / 2, 7, 2.4);
    circle(ctx, P.c(c.hair), FIG_W / 2, 6.4, 1.9);
    if (c.gun) flat(ctx, P, M.darker, FIG_W - 2.6, 0, 1.4, 5);
  });
}

/**
 * A civilian in panic (OpenRA ScaredyCat "panic-stand" and "panic-run"):
 * both arms thrown up beside the head, the weapon dropped.
 */
function civilianPanicDraw(c) {
  return grounded((ctx, P) => {
    civilianLegs(ctx, P, c, 10);
    flat(ctx, P, c.coat ? tone(c.shirt, -0.12) : c.shirt, 0, 5, FIG_W, c.coat ? 8 : 6, 2.5);
    flat(ctx, P, c.shirt, 0, 0.5, 2, 6, 1);
    flat(ctx, P, c.shirt, FIG_W - 2, 0.5, 2, 6, 1);
    circle(ctx, P.c(c.hair), FIG_W / 2, 7, 2.4);
  });
}

// ---- Tables ------------------------------------------------------------------------------------

/** Structure art by actor id (upper-case): (actor record of rules_json) -> draw(ctx, P). */
const STRUCTURES = {
  HOSP: () => hospital,
  BIO: () => bioLab,
  MISS: () => commCenter,
  FCOM: () => commandPost,
  // WebRA's own pixel art in Red Alert's style (art/pixel.js).
  OILB: (a) => pixelDraw(a),
  V01: () => (ctx, P) => church(ctx, P, false),
  V25: () => (ctx, P) => church(ctx, P, true),
  V12: () => haystack,
  V13: () => haystack,
  V14: () => (ctx, P) => field(ctx, P, 'veg'),
  V15: () => (ctx, P) => field(ctx, P, 'wheat'),
  V16: () => (ctx, P) => field(ctx, P, 'veg'),
  V17: () => (ctx, P) => field(ctx, P, 'wheat'),
  V18: () => (ctx, P) => field(ctx, P, 'veg'),
  RICE: () => (ctx, P) => field(ctx, P, 'rice'),
  V19: () => (ctx, P) => pumpjack(ctx, P, false),
  'V19.HUSK': () => (ctx, P) => pumpjack(ctx, P, true),
  LHUS: (a) => lighthouse(a),
  WINDMILL: (a) => windmill(a),
  RUSHOUSE: hut({ wall: M.wood, roof: M.dark }, 31),
  SNOWHUT: hut({ wall: M.wood, roof: M.steam }, 37),
  ASIANHUT: hut({ wall: M.sandy, roof: M.orange, chimney: false }, 41),
  RAILMINE: () => railMine,
  CTFLAG: () => flag,
  BARL: () => (ctx, P) => drum(ctx, P, 6, 6, 11),
  BRL3: () => (ctx, P) => {
    drum(ctx, P, 2, 3, 9);
    drum(ctx, P, 12, 3, 9, M.brick);
    drum(ctx, P, 7, 12, 9);
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

/** Houses by id: temperate cottages and desert adobes filling their footprint box. */
function houseDraw(id, a) {
  const w = (a.width ?? 1) * 24;
  const h = (a.height ?? 1) * 24;
  const desert = (a.world?.biomes ?? []).includes('desert') && !(a.world?.biomes ?? []).includes('temperate');
  const seed = seedOf(id);
  const cells = occupied(a);
  return (ctx, P) => {
    if (cells.length && cells.length < (a.width ?? 1) * (a.height ?? 1) && id === 'V37') {
      // An irregular footprint (V37): a walled yard over the whole frame, as the original fills it, and one
      // building over the occupied cells.
      flat(ctx, P, tone(M.sandy, -0.12), 0.5, 0.5, w - 1, h - 1);
      flat(ctx, P, M.dirt, 2.5, 2.5, w - 5, h - 5);
      const xs = cells.map((c) => c[0]);
      const ys = cells.map((c) => c[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      adobe(ctx, P, x0 * 24 + 1, y0 * 24 + 1, (Math.max(...xs) - x0 + 1) * 24 - 3, (Math.max(...ys) - y0 + 1) * 24 - 3, seed, { tower: true });
      return;
    }
    const big = w >= 48 && h >= 48;
    if (desert) adobe(ctx, P, 1, 1, w - 3, h - 3, seed, { dome: big && seed % 3 === 0, tower: big && seed % 2 === 0 });
    else cottage(ctx, P, 1, 1, w - 3, h - 3, seed);
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
  Object.entries(CIVILIANS).map(([id, c]) => [id, { body: [CIV_W, CIV_H, civilianDraw(c)], panic: [CIV_W, CIV_H, civilianPanicDraw(c)] }]),
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
    rect(ctx, P.c('#c8281e'), 2.6, 1, 1.8, 5);
    rect(ctx, P.c('#c8281e'), 1, 2.6, 5, 1.8);
  }],
  treeFire(0.85),
  treeFire(1),
];
