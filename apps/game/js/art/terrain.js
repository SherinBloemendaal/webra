// Terrain tiles: one pre-rendered atlas per biome, drawn once at game start,
// and a per-cell tile layer that picks the tile, a decal and the water depth
// for every map cell. The terrain shader (shaders/terrain.wgsl) only samples
// these two textures, so a frame costs one texture lookup or two per pixel.
//
// The look is the minimal one of the design board "Retexture 2D en 3D"
// (0.21.0): flat tiles in the colours the 3D minimal pack uses too
// (art/shared-palette.js SHARED_PALETTE.terrain), one block or two per tile
// at most, straight edges. Rock is a raised plateau (a lit rim on the top and
// left edges, a cliff face on the bottom and right edges, its shadow on the
// ground to the lower right); water lies one step lower than the land (a
// darker edge under the shore); roads are one flat colour; trees are two
// blocks (trunk and crown) with one hard shadow to the lower right. Light
// comes from the top left, like the building art.
//
// Pure module: pixels are computed into a Uint8ClampedArray (RGBA), so it runs
// and is tested under Node without a canvas.

import { SHARED_PALETTE } from './shared-palette.js';

/** Tile size in atlas pixels (a cell is 24 world pixels; tiles are oversampled). */
export const TILE = 32;
/** Tiles per atlas row. */
export const ATLAS_COLS = 16;

/** Engine terrain values (engine/src/map.rs Terrain). */
export const T = Object.freeze({ CLEAR: 0, ROUGH: 1, ROCK: 2, WATER: 3, TREE: 4, FORD: 5, ROAD: 6, BRIDGE: 7, BEACH: 8, RIVER: 9, WALL: 10 });

/** Tile indices in the atlas. Masks: bit 1 north, 2 east, 4 south, 8 west. */
export const TILES = Object.freeze({
  CLEAR: 0, // 4 variants
  ROUGH: 4, // 4 variants
  ROCK: 8, // 16 masks: neighbour is rock too
  WATER: 24, // 16 masks: neighbour is water or ford (or off the map)
  FORD: 40, // 16 masks: neighbour is water or ford
  TREE: 56, // 4 variants
  DECAL: 60, // 8 decal overlays (transparent)
  ROAD: 68, // 16 masks: neighbour is road or bridge
  BEACH: 84, // 4 variants
  COUNT: 88,
});
export const DECALS = 8;
export const BIOMES = ['temperate', 'snow', 'desert'];

/** Shadow bits of the cell layer: rock to the north, west and north-west. */
export const SHADOW = Object.freeze({ N: 1, W: 2, NW: 4 });

// ---- Palettes ------------------------------------------------------------------------

const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The one hard shadow of the minimal art: black at this alpha, offset this many tile pixels to the lower right. */
const SHADE = SHARED_PALETTE.shadow.alpha;
const SHADE_OFFSET = Math.round(SHARED_PALETTE.shadow.offset * TILE);
const BLACK = [0, 0, 0];

/**
 * The tile colours of a biome (RGB 0..255) from the shared 2D/3D palette:
 * `ground` and `rough` as [base, alternate], the rock's top, lit rim and
 * face, water, its darker edge under the land and the light shallows, the
 * ford and its bank (also the beach sand), roads, trees and the decals'
 * accent (flowers, ice, bones).
 */
function makePalette(biome) {
  const s = SHARED_PALETTE.terrain[biome];
  const c = (k) => rgbOf(s[k]);
  return {
    ground: [c('clear'), c('clearAlt')],
    rough: [c('rough'), c('roughStone')],
    rockTop: c('rock'),
    // A snow cap on the lit rim in the snow biome.
    rim: biome === 'snow' ? c('clear') : c('rockLight'),
    rockFace: c('rockDark'),
    water: c('water'),
    waterEdge: c('waterEdge'),
    shallow: c('waterLight'),
    ford: c('ford'),
    sand: c('fordBank'),
    road: c('road'),
    tree: c('tree'),
    treeDark: c('treeDark'),
    trunk: c('trunk'),
    accent: biome === 'snow' ? c('waterLight') : biome === 'desert' ? rgbOf(SHARED_PALETTE.materials.paint) : rgbOf(SHARED_PALETTE.materials.yellow),
  };
}

const PALETTES = Object.fromEntries(BIOMES.map((b) => [b, makePalette(b)]));

export function palette(biome) {
  return PALETTES[biome] ?? PALETTES.temperate;
}

// ---- Deterministic noise -------------------------------------------------------------

/** 32-bit integer hash of up to three integers, 0..1. */
export function hash3(a, b, c = 0) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A seeded integer in lo..hi (inclusive). */
const pick = (lo, hi, a, b, c) => lo + Math.floor(hash3(a, b, c) * (hi - lo + 1));

// ---- Tile canvas ---------------------------------------------------------------------

/** A TILE x TILE RGBA tile with small drawing helpers (all coordinates in tile pixels). */
class Tile {
  constructor() {
    this.px = new Float32Array(TILE * TILE * 4);
  }

  set(x, y, rgb, a = 1) {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const o = (y * TILE + x) * 4;
    this.px[o] = rgb[0];
    this.px[o + 1] = rgb[1];
    this.px[o + 2] = rgb[2];
    this.px[o + 3] = a;
  }

  /** Fill the whole tile with one opaque colour. */
  fill(rgb) {
    this.block(0, 0, TILE, TILE, rgb);
  }

  /** Alpha-blend a colour over the pixel. */
  blend(x, y, rgb, a) {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE || a <= 0) return;
    const o = (y * TILE + x) * 4;
    const ia = this.px[o + 3];
    const oa = a + ia * (1 - a);
    for (let k = 0; k < 3; k++) {
      this.px[o + k] = oa > 0 ? (rgb[k] * a + this.px[o + k] * ia * (1 - a)) / oa : 0;
    }
    this.px[o + 3] = oa;
  }

  /** Multiply the pixel's colour (shading). */
  shade(x, y, k) {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const o = (y * TILE + x) * 4;
    for (let c = 0; c < 3; c++) this.px[o + c] *= k;
  }

  /** A rectangle of one colour, blended at alpha `a` (opaque by default), clipped to the tile. */
  block(x, y, w, h, rgb, a = 1) {
    for (let yy = Math.max(0, y); yy < Math.min(TILE, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(TILE, x + w); xx++) {
        if (a >= 1) this.set(xx, yy, rgb, 1);
        else this.blend(xx, yy, rgb, a);
      }
    }
  }

  /** A block with the minimal art's hard shadow to the lower right. */
  solid(x, y, w, h, rgb) {
    this.block(x + SHADE_OFFSET, y + SHADE_OFFSET, w, h, BLACK, SHADE);
    this.block(x, y, w, h, rgb);
  }
}

// ---- Ground ------------------------------------------------------------------------------

/**
 * Open ground: one flat colour per tile, the base or the alternate tone
 * (the board's two grass tones), and on two of the four variants one small
 * block of the other tone so repeated cells do not line up. Rough ground
 * (heath, ice, dunes) is the rough colour with two blocks: a stone and a lighter
 * patch. Blocks stay a few pixels inside the tile, so neighbouring cells join
 * without seams; the shader adds large-scale variation.
 */
function ground(p, kind, variant) {
  const t = new Tile();
  if (kind === 'rough') {
    const [base, stone] = p.rough;
    t.fill(base);
    const seed = 500 + variant;
    t.block(pick(3, 14, seed, 1, 1), pick(3, 12, seed, 2, 1), 9, 6, mixRgb(base, p.ground[0], 0.5));
    t.solid(pick(4, 20, seed, 3, 1), pick(4, 20, seed, 4, 1), 6, 5, stone);
    return t;
  }
  const [base, alt] = variant % 2 ? [p.ground[1], p.ground[0]] : p.ground;
  t.fill(base);
  if (variant >= 2) t.block(pick(4, 20, variant, 1, 100), pick(4, 22, variant, 2, 100), 8, 6, alt);
  return t;
}

// ---- Roads and beaches -------------------------------------------------------------------

/** Half the width of a road in tile pixels. */
const ROAD_HALF = 11;

/**
 * A road cell over open ground: one flat band of the road colour from the
 * middle of the cell toward each neighbour that is road or bridge too
 * (`mask`: north 1, east 2, south 4, west 8), joined by a square hub; a road
 * cell with no road around is a patch. Straight edges, so roads join.
 */
function road(p, mask) {
  const t = ground(p, 'ground', mask % 2);
  const lo = TILE / 2 - ROAD_HALF;
  const hi = TILE / 2 + ROAD_HALF;
  t.block(lo, lo, hi - lo, hi - lo, p.road);
  if (mask & 1) t.block(lo, 0, hi - lo, lo, p.road);
  if (mask & 4) t.block(lo, hi, hi - lo, TILE - hi, p.road);
  if (mask & 8) t.block(0, lo, lo, hi - lo, p.road);
  if (mask & 2) t.block(hi, lo, TILE - hi, hi - lo, p.road);
  return t;
}

/** Sand (beaches): the sand colour with one ripple bar a step darker. */
function beach(p, variant) {
  const t = new Tile();
  t.fill(p.sand);
  t.block(pick(3, 12, variant, 1, 1400), pick(4, 26, variant, 2, 1400), 14, 2, scale(p.sand, 0.9));
  return t;
}

// ---- Rock: raised plateaus -------------------------------------------------------------

/** Rock: how far the plateau top stops short of an open north or west edge, the rim's width, the cliff faces' depth. */
const ROCK_INSET = 2;
const ROCK_RIM = 3;
const ROCK_FACE_S = 10;
const ROCK_FACE_E = 6;

/**
 * A rock cell. `mask` bits say which neighbours are rock too (north 1, east 2,
 * south 4, west 8). Open edges get a lit rim (north, west) or a cliff face
 * (east: narrow, south: tall), so plateaus read as raised blocks lit from the
 * top left, and joined cells form one plateau. Flat bands: the rim, the top,
 * the face; the ground at the foot of an open north or west edge lies in the
 * plateau's shadow.
 */
function rock(p, mask) {
  const t = ground(p, 'ground', mask % 2); // what shows beside the plateau
  const open = { n: !(mask & 1), e: !(mask & 2), s: !(mask & 4), w: !(mask & 8) };
  const x0 = open.w ? ROCK_INSET : 0;
  const y0 = open.n ? ROCK_INSET : 0;
  const x1 = TILE - (open.e ? ROCK_FACE_E : 0);
  const y1 = TILE - (open.s ? ROCK_FACE_S : 0);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (x >= x0 && y >= y0 && x < x1 && y < y1) {
        const rim = (open.n && y < y0 + ROCK_RIM) || (open.w && x < x0 + ROCK_RIM);
        t.set(x, y, rim ? p.rim : p.rockTop);
      } else if (x >= x1 && y >= y1) {
        t.set(x, y, scale(p.rockFace, 0.7)); // south-east corner: the darkest bit of both faces
      } else if (y >= y1 && x >= x0) {
        t.set(x, y, p.rockFace); // south face
      } else if (x >= x1 && y >= y0) {
        t.set(x, y, scale(p.rockFace, 0.85)); // east face, turned away from the light
      } else {
        t.shade(x, y, 1 - SHADE);
      }
    }
  }
  return t;
}

// ---- Water, shorelines and fords ---------------------------------------------------

/** Width in tile pixels of the darker step where water meets land. */
const WATER_STEP = 3;

/**
 * Water: one flat colour, one step lower than the land: a darker edge
 * (the bank's drop) along every edge whose neighbour is land (mask bit
 * clear). Fords are the light ford colour with two stones of the bank's
 * sand. The depth gradient further out comes from the cell layer (shader).
 */
function water(p, mask, ford, variantSeed) {
  const t = new Tile();
  const land = { n: !(mask & 1), e: !(mask & 2), s: !(mask & 4), w: !(mask & 8) };
  t.fill(ford ? p.ford : p.water);
  if (ford) {
    t.block(pick(4, 12, variantSeed, 1, 1600), pick(5, 12, variantSeed, 2, 1600), 6, 4, p.sand);
    t.block(pick(16, 22, variantSeed, 3, 1600), pick(16, 22, variantSeed, 4, 1600), 5, 4, p.sand);
  }
  if (land.n) t.block(0, 0, TILE, WATER_STEP, p.waterEdge);
  if (land.s) t.block(0, TILE - WATER_STEP, TILE, WATER_STEP, p.waterEdge);
  if (land.w) t.block(0, 0, WATER_STEP, TILE, p.waterEdge);
  if (land.e) t.block(TILE - WATER_STEP, 0, WATER_STEP, TILE, p.waterEdge);
  return t;
}

// ---- Trees ---------------------------------------------------------------------------------

/**
 * A tree on its ground cell: two blocks, the trunk and the crown over it (a
 * lit top and a darker front face), with one hard shadow to the lower right.
 * Snow crowns carry snow on the top; desert cells alternate a
 * cactus (stem and arm) and a palm (trunk and a flat crown).
 */
function tree(p, variant, biome) {
  const t = ground(p, 'ground', variant);
  const dx = pick(-2, 2, variant, 1, 1500);
  const dy = pick(-2, 1, variant, 2, 1500);
  if (biome === 'desert' && variant % 2 === 0) {
    // Cactus: a tall stem and one arm across it.
    t.solid(13 + dx, 6 + dy, 6, 21, p.treeDark);
    t.solid(7 + dx, 12 + dy, 18, 5, p.treeDark);
    return t;
  }
  const [cw, ch] = biome === 'desert' ? [22, 14] : [20, 18];
  const cx = 16 - cw / 2 + dx;
  const cy = 5 + dy;
  t.solid(14 + dx, cy + ch - 2, 5, 28 - ch - dy - 2, p.trunk);
  t.solid(cx, cy, cw, ch, p.treeDark);
  t.block(cx, cy, cw, Math.round(ch * 0.62), biome === 'snow' ? p.ground[0] : p.tree);
  return t;
}

// ---- Decals --------------------------------------------------------------------------

/** Transparent overlays scattered over open ground: index 0..DECALS-1. One block or two each, hard shadows. */
function decal(p, k) {
  const t = new Tile();
  const r = (j, lo, hi) => pick(lo, hi, k, j, 1700);
  const stone = p.rough[1];
  switch (k) {
    case 0: // two stones
      t.solid(r(1, 5, 12), r(2, 5, 12), 5, 4, stone);
      t.solid(r(3, 16, 22), r(4, 15, 21), 4, 3, stone);
      break;
    case 1: // pebbles
      for (let j = 0; j < 3; j++) t.solid(r(j * 2 + 1, 4, 24), r(j * 2 + 2, 4, 24), 2, 2, stone);
      break;
    case 2: // crater: a dark pit, its lower right rim lit
      t.block(9, 9, 14, 12, [30, 26, 22], 0.55);
      t.block(11, 21, 14, 2, stone, 0.8);
      break;
    case 3: // shrub: two blocks of leaves
      t.solid(r(1, 7, 12), r(2, 8, 12), 8, 7, p.treeDark);
      t.solid(r(3, 14, 18), r(4, 14, 18), 7, 6, p.tree);
      break;
    case 4: // vehicle tracks: two faint bands
      t.block(0, 10, TILE, 2, BLACK, 0.18);
      t.block(0, 20, TILE, 2, BLACK, 0.18);
      break;
    case 5: // tufts: two small lighter blocks
      t.block(r(1, 4, 12), r(2, 5, 12), 5, 3, mixRgb(p.ground[0], [255, 255, 255], 0.22));
      t.block(r(3, 16, 24), r(4, 16, 24), 4, 3, mixRgb(p.ground[0], [255, 255, 255], 0.22));
      break;
    case 6: // flowers, ice or bones: two small accent blocks
      t.block(r(1, 5, 12), r(2, 5, 14), 3, 3, p.accent);
      t.block(r(3, 16, 24), r(4, 14, 24), 3, 2, p.accent);
      break;
    default: // a boulder: the stone and its lit top
      t.solid(10, 10, 11, 9, scale(stone, 0.85));
      t.block(10, 10, 11, 4, stone);
  }
  return t;
}

// ---- Atlas -------------------------------------------------------------------------------

/**
 * The tile atlas of a biome: `{ width, height, data, cols, tile }` with
 * RGBA pixels (straight alpha) and TILES.COUNT tiles in rows of ATLAS_COLS.
 */
export function buildTerrainAtlas(biome = 'temperate') {
  const b = BIOMES.includes(biome) ? biome : 'temperate';
  const p = palette(b);
  const tiles = [];
  for (let v = 0; v < 4; v++) tiles[TILES.CLEAR + v] = ground(p, 'ground', v);
  for (let v = 0; v < 4; v++) tiles[TILES.ROUGH + v] = ground(p, 'rough', v);
  for (let m = 0; m < 16; m++) tiles[TILES.ROCK + m] = rock(p, m);
  for (let m = 0; m < 16; m++) tiles[TILES.WATER + m] = water(p, m, false, m);
  for (let m = 0; m < 16; m++) tiles[TILES.FORD + m] = water(p, m, true, m);
  for (let v = 0; v < 4; v++) tiles[TILES.TREE + v] = tree(p, v, b);
  for (let k = 0; k < DECALS; k++) tiles[TILES.DECAL + k] = decal(p, k);
  for (let m = 0; m < 16; m++) tiles[TILES.ROAD + m] = road(p, m);
  for (let v = 0; v < 4; v++) tiles[TILES.BEACH + v] = beach(p, v);
  const rows = Math.ceil(TILES.COUNT / ATLAS_COLS);
  const width = ATLAS_COLS * TILE;
  const height = rows * TILE;
  const data = new Uint8ClampedArray(width * height * 4);
  tiles.forEach((t, i) => {
    const ox = (i % ATLAS_COLS) * TILE;
    const oy = Math.floor(i / ATLAS_COLS) * TILE;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const s = (y * TILE + x) * 4;
        const o = ((oy + y) * width + ox + x) * 4;
        data[o] = t.px[s];
        data[o + 1] = t.px[s + 1];
        data[o + 2] = t.px[s + 2];
        data[o + 3] = Math.round(clamp01(t.px[s + 3]) * 255);
      }
    }
  });
  return { width, height, data, cols: ATLAS_COLS, tile: TILE, biome: b };
}

// ---- Cell layer ----------------------------------------------------------------------------

/**
 * Seed for terrain decals: a hash of the map's terrain types (engine terrain
 * bytes, RGBA per cell), so every player of a map, and the map editor, see
 * the same decals.
 */
export function terrainSeed(terrain) {
  let h = 0x811c9dc5;
  for (let i = 0; i < terrain.length; i += 4) h = Math.imul(h ^ terrain[i], 0x01000193);
  return h >>> 0;
}

/** Which neighbours have kind bit `k`: north 1, east 2, south 4, west 8. */
const sides = (k, north, east, south, west) => (north & k ? 1 : 0) | (east & k ? 2 : 0) | (south & k ? 4 : 0) | (west & k ? 8 : 0);

/** How far water depth looks for land: depth counts up to this many cells (cellTiles). */
export const DEPTH_STEPS = 4;

/**
 * Per-cell tile layer for the shader, RGBA per cell: R tile index, G decal
 * (0 none, 1 + decal index), B water depth (0 at the shore to 255 four or more
 * cells out), A shadow bits (rock to the north, west, north-west). `terrain`
 * is the engine's terrain bytes (Game.terrain_ptr: R terrain type, G ore, B
 * gems, A 255). Decals follow `seed`, so every player sees the same map.
 *
 * `area` ({ x0, y0, x1, y1 }, inclusive) tiles only those cells, into `out`
 * (the whole map's layer, kept elsewhere): the map editor redoes the cells
 * around an edit. A cell's tile depends on the cells up to DEPTH_STEPS away,
 * so only that window around the area is read.
 */
export function cellTiles(terrain, w, h, seed = 0, area = null, out = null) {
  out ??= new Uint8Array(w * h * 4);
  const ax0 = area ? Math.max(0, area.x0) : 0;
  const ay0 = area ? Math.max(0, area.y0) : 0;
  const ax1 = area ? Math.min(w - 1, area.x1) : w - 1;
  const ay1 = area ? Math.min(h - 1, area.y1) : h - 1;
  if (ax0 > ax1 || ay0 > ay1) return out;
  // The window the area's tiles read (the whole map without an area), in its own coordinates.
  const wx0 = Math.max(0, ax0 - DEPTH_STEPS);
  const wy0 = Math.max(0, ay0 - DEPTH_STEPS);
  const ww = Math.min(w - 1, ax1 + DEPTH_STEPS) - wx0 + 1;
  const wh = Math.min(h - 1, ay1 + DEPTH_STEPS) - wy0 + 1;
  const n = ww * wh;
  // What a terrain type counts as for its neighbours. Rivers look like water,
  // and so does the river under a bridge's deck (the bridge actor draws the
  // deck, art/world.js); walls of the tilesets like rock. Off the map counts
  // as water and rock.
  const WET = 1;
  const ROCKY = 2;
  const ROADY = 4;
  const OFF = WET | ROCKY;
  const kind = new Uint8Array(256);
  for (const t of [T.WATER, T.FORD, T.RIVER, T.BRIDGE]) kind[t] |= WET;
  for (const t of [T.ROCK, T.WALL]) kind[t] |= ROCKY;
  for (const t of [T.ROAD, T.BRIDGE]) kind[t] |= ROADY;
  const kinds = new Uint8Array(n);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) kinds[y * ww + x] = kind[terrain[((wy0 + y) * w + wx0 + x) * 4]];
  }
  // Water depth: steps to the nearest land cell (breadth first), capped at DEPTH_STEPS.
  const depth = new Uint8Array(n).fill(255);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (!(kinds[i] & WET)) {
      depth[i] = 0;
      queue[tail++] = i;
    }
  }
  for (let q = 0; q < tail; q++) {
    const i = queue[q];
    const d = depth[i] + 1;
    if (d > DEPTH_STEPS) continue;
    const x = i % ww;
    const y = (i - x) / ww;
    // East, west, south, north.
    if (x + 1 < ww && depth[i + 1] > d) {
      depth[i + 1] = d;
      queue[tail++] = i + 1;
    }
    if (x > 0 && depth[i - 1] > d) {
      depth[i - 1] = d;
      queue[tail++] = i - 1;
    }
    if (y + 1 < wh && depth[i + ww] > d) {
      depth[i + ww] = d;
      queue[tail++] = i + ww;
    }
    if (y > 0 && depth[i - ww] > d) {
      depth[i - ww] = d;
      queue[tail++] = i - ww;
    }
  }
  for (let y = ay0; y <= ay1; y++) {
    for (let x = ax0; x <= ax1; x++) {
      const i = y * w + x;
      // The cell in the window (its neighbours on the map are in it too).
      const j = (y - wy0) * ww + (x - wx0);
      const t = terrain[i * 4];
      const north = y > 0 ? kinds[j - ww] : OFF;
      const east = x + 1 < w ? kinds[j + 1] : OFF;
      const south = y + 1 < h ? kinds[j + ww] : OFF;
      const west = x > 0 ? kinds[j - 1] : OFF;
      const n4 = (k) => sides(k, north, east, south, west);
      const v = Math.floor(hash3(x, y, seed) * 4);
      let tile;
      let decalIndex = 0;
      switch (t) {
        case T.ROUGH:
          tile = TILES.ROUGH + v;
          if (hash3(x, y, seed + 2) < 0.04) decalIndex = 1 + (hash3(x, y, seed + 3) < 0.5 ? 0 : 1);
          break;
        case T.ROCK:
        case T.WALL:
          tile = TILES.ROCK + n4(ROCKY);
          break;
        case T.WATER:
        case T.RIVER:
        case T.BRIDGE:
          tile = TILES.WATER + n4(WET);
          break;
        case T.ROAD:
          tile = TILES.ROAD + n4(ROADY);
          break;
        case T.BEACH:
          tile = TILES.BEACH + v;
          break;
        case T.TREE:
          tile = TILES.TREE + v;
          break;
        case T.FORD:
          tile = TILES.FORD + n4(WET);
          break;
        default: {
          tile = TILES.CLEAR + v;
          // Decals on 8 % of open ground; craters and boulders are rarer.
          const roll = hash3(x, y, seed + 1);
          if (roll < 0.08) {
            const k = Math.floor(hash3(x, y, seed + 4) * 10);
            decalIndex = 1 + [0, 1, 1, 3, 3, 4, 5, 5, 6, roll < 0.012 ? 2 : 7][k];
          }
        }
      }
      // Rock (or a wall) to the north, west and north-west casts a shadow; rock itself takes none.
      const shadowBits =
        t === T.ROCK ? 0 : (y > 0 && north & ROCKY ? SHADOW.N : 0) | (x > 0 && west & ROCKY ? SHADOW.W : 0) | (x > 0 && y > 0 && kinds[j - ww - 1] & ROCKY ? SHADOW.NW : 0);
      out[i * 4] = tile;
      out[i * 4 + 1] = decalIndex;
      out[i * 4 + 2] = kinds[j] & WET ? Math.min(255, depth[j] * 64) : 0;
      out[i * 4 + 3] = shadowBits;
    }
  }
  return out;
}
