// Tile terrain: the map drawn with Red Alert's own terrain tiles (TMP
// templates from the player's theater MIX, content/tables.js TERRAIN) or a
// texture pack's tiles, instead of WebRA's generated tiles (js/art/terrain.js).
//
// WebRA maps store terrain types, not templates, so the tiles are chosen
// here, the same way on every machine (the choice depends on the map and
// the files only):
// - clear ground and tree cells take one of the plain ground variants;
// - water cells far from land take open water tiles;
// - water cells at the coast take beach tiles that fit the coastline. Each
//   tile is read for where its water is (the palette indices of the open
//   water tiles), in nine regions and along its four edges, and the tile
//   whose water best matches the cell's neighbours (land wherever a
//   neighbouring cell is land) and the edges of the tiles already chosen
//   to the north and west wins. The beach is drawn inside the water cells;
//   when nothing fits well, the cell keeps open water, never a stray tile;
// - rough and rock cells take loose stones and boulders standing on plain
//   ground (whole templates where a run of cells fits one), rock cells out
//   in the water rocks standing in water;
// - road cells take plain road pieces, beaches are drawn like rough ground
//   by the water (beach tiles where they fit), rivers and the river under a
//   bridge like water (the bridge actor draws its template over it,
//   content/atlas.js), walls like rock.
//
// Water moves the way OpenRA animates it (RotationPaletteEffect): the
// terrain palette indices of `TERRAIN[tileset].rotation` cycle. Their
// pixels keep their palette offset in the alpha channel (WATER_ALPHA + k)
// and the atlas's last pixel row holds their colours; shaders/terrain.wgsl
// rotates them on the render clock (ART_WATER_ROTATION).
//
// The atlas has ATLAS_COLS tiles to a row (shaders/terrain.wgsl reads the
// tile size from its width). Map tiles take indexes 0 .. TERRAIN_TILES - 1
// and from EXTRA_TILE_BASE on (cell R + 256 G); ore and gem overlays sit at
// fixed tiles in between.

import { RESOURCES, SMUDGES, TERRAIN, TREES } from './tables.js';
import { decodeSprite } from './shp.js';
import { TERRAIN_SHADOW, decodePalette, paletteLookup } from './palette.js';
import { resolveSequence, sequenceFile } from './sequences.js';

export const ATLAS_COLS = 16;
export const ORIGINAL_TILE = 24;
/** Tiles for the map itself: 0 .. TERRAIN_TILES - 1, then EXTRA_TILE_BASE .. SMUDGE_TILE_BASE - 1. */
export const TERRAIN_TILES = 192;
export const ORE_TILE_BASE = 192;
export const ORE_LEVELS = 12;
export const ORE_VARIANTS = 4;
export const GEM_TILE_BASE = 240;
export const GEM_LEVELS = 4;
export const GEM_VARIANTS = 4;
export const EXTRA_TILE_BASE = 256;
/** Largest tile index a cell can name (shaders/terrain.wgsl reads R + 256 G). */
export const MAX_TILE_INDEX = 1023;
/**
 * Scorch marks and craters (engine/src/smudges.rs) at fixed tiles at the end
 * of the atlas: (type * SMUDGE_VARIANTS + variant) * SMUDGE_DEPTHS + depth,
 * type 0 scorch, 1 crater (shaders/terrain.wgsl). Map tiles stay below.
 */
export const SMUDGE_TILE_BASE = 960;
export const SMUDGE_VARIANTS = 6;
export const SMUDGE_DEPTHS = 5;
/** The atlas has the smudge tiles. */
export const ART_SMUDGES = 16;
/** Globals.art.x bits (shaders/common.wgsl). */
export const ART_TILES = 1;
export const ART_ORE = 2;
export const ART_GEMS = 4;
/** The atlas carries rotating water pixels (alpha WATER_ALPHA + k) and their colours in its last row. */
export const ART_WATER_ROTATION = 8;
export const WATER_ALPHA = 248;
/** Rotating water colours shaders/terrain.wgsl knows (WATER_COLORS there). */
export const WATER_COLORS = 7;

/** Engine terrain values (engine/src/map.rs): clear, rough, rock, water, tree, ford, road, bridge, beach, river, wall. */
const CLEAR = 0;
const ROUGH = 1;
const ROCK = 2;
const WATER = 3;
const TREE = 4;
const FORD = 5;
const ROAD = 6;
const BRIDGE = 7;
const BEACH = 8;
const RIVER = 9;
const WALL = 10;
const isWaterType = (v) => v === WATER || v === FORD || v === RIVER || v === BRIDGE;

export function hash(x, y, salt = 0) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---- Reading tiles ---------------------------------------------------------------------------

/** Regions of a tile, row by row: NW, N, NE, W, centre, E, SW, S, SE (8 x 8 pixels each). */
const REGION_SIZE = 8;
/** Edges: north, east, south, west; the cell across each. */
const SIDES = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * How wet a tile is where: `{ regions, edges }`. Every pixel counts 1 when
 * its palette index is one of the open water tiles' (`water`), 0 when it is
 * one of the plain ground tiles' (`ground`) and 0.5 otherwise (sand, surf,
 * stones). `regions` holds the mean of each of the nine 8 x 8 regions,
 * `edges[side]` one value per pixel along that edge (north and south left to
 * right, east and west top to bottom): the mean of the two outermost pixels.
 */
export function analyzeTile(data, water, ground, size = ORIGINAL_TILE) {
  const val = (v) => (water[v] ? 1 : ground[v] ? 0 : 0.5);
  const regions = new Float32Array(9);
  const step = size / 3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let y = r * step; y < (r + 1) * step; y++) for (let x = c * step; x < (c + 1) * step; x++) sum += val(data[y * size + x]);
      regions[r * 3 + c] = sum / (step * step);
    }
  }
  const at = (x, y) => val(data[y * size + x]);
  const edges = SIDES.map((_, side) => {
    const out = new Float32Array(size);
    for (let k = 0; k < size; k++) {
      let v;
      if (side === 0) v = at(k, 0) + at(k, 1);
      else if (side === 1) v = at(size - 1, k) + at(size - 2, k);
      else if (side === 2) v = at(k, size - 1) + at(k, size - 2);
      else v = at(0, k) + at(1, k);
      out[k] = v / 2;
    }
    return out;
  });
  return { regions, edges };
}

/** What plain ground (0) or open water (1) reads as. */
function solid(v, size = ORIGINAL_TILE) {
  return { regions: new Float32Array(9).fill(v), edges: SIDES.map(() => new Float32Array(size).fill(v)) };
}

// ---- Choosing tiles --------------------------------------------------------------------------

/**
 * How wet the ground should look at a distance from the water, in cells: a
 * beach runs from the water's edge through about a cell of sand into the
 * ground, the shape Red Alert's beach templates are drawn in (a hand-tuned
 * curve): `[distance, wetness]` points, linear in between.
 */
export const BEACH_PROFILE = Object.freeze([
  [0, 1],
  [1 / 6, 0.75],
  [0.5, 0.55],
  [5 / 6, 0.35],
  [7 / 6, 0.25],
  [1.5, 0.05],
  [1.85, 0],
]);
/** Land cells this close to water (cells, from any point of the cell) get a beach tile when one fits. */
export const BEACH_REACH = 1.85;

export function beachWetness(d) {
  if (d <= 0) return 1;
  for (let k = 1; k < BEACH_PROFILE.length; k++) {
    const [d1, v1] = BEACH_PROFILE[k];
    if (d <= d1) {
      const [d0, v0] = BEACH_PROFILE[k - 1];
      return v0 + ((v1 - v0) * (d - d0)) / (d1 - d0);
    }
  }
  return 0;
}

/**
 * Distance (in cells) from point (px, py), in map cell units, to the nearest
 * cell for which `wet(cx, cy)` holds, looking up to two cells around; Infinity
 * when there is none that close.
 */
export function waterDistance(px, py, wet) {
  let best = Infinity;
  const x0 = Math.floor(px) - 2;
  const y0 = Math.floor(py) - 2;
  for (let cy = y0; cy <= y0 + 4; cy++) {
    for (let cx = x0; cx <= x0 + 4; cx++) {
      if (!wet(cx, cy)) continue;
      const dx = Math.max(cx - px, 0, px - (cx + 1));
      const dy = Math.max(cy - py, 0, py - (cy + 1));
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * What a land cell's tile should look like next to the water: the wetness
 * wanted in each region (REGION order) and along each edge, from the
 * distance of each spot to the nearest water cell. `wet(cx, cy)` says
 * whether a cell is water.
 */
export function beachTargets(x, y, wet, size = ORIGINAL_TILE) {
  const regions = new Float32Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) regions[r * 3 + c] = beachWetness(waterDistance(x + (c + 0.5) / 3, y + (r + 0.5) / 3, wet));
  }
  const edges = SIDES.map((_, side) => {
    const out = new Float32Array(size);
    for (let k = 0; k < size; k++) {
      const f = (k + 0.5) / size;
      const [px, py] = [
        [x + f, y],
        [x + 1, y + f],
        [x + f, y + 1],
        [x, y + f],
      ][side];
      out[k] = beachWetness(waterDistance(px, py, wet));
    }
    return out;
  });
  return { regions, edges };
}

const meanDiff = (a, b) => {
  let d = 0;
  for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]);
  return d / a.length;
};

/** Region weights. */
const REGION_WEIGHT = [1, 1, 1, 1, 1, 1, 1, 1, 1];
/** How much each edge counts: matching the tiles already chosen to the north and west keeps the beach whole. */
const SEAM_WEIGHT = 4;
/** The most a beach tile on a land cell may be wet in its centre region (0.5 is sand). */
export const LAND_CENTRE = 0.6;
/** Scores within this of the best count as equally good (the cell's hash picks among them). */
const TIE = 0.05;

/** How much the colours along an edge shared with a tile already chosen count. */
const COLOR_WEIGHT = 6;

/**
 * The outermost pixels of a tile in colour, per side (same order as
 * analyzeTile edges): RGB triples, for matching seams by eye.
 */
export function edgeColors(data, lookup, size = ORIGINAL_TILE) {
  return SIDES.map((_, side) => {
    const out = new Uint8Array(size * 3);
    for (let k = 0; k < size; k++) {
      const [x, y] = [
        [k, 0],
        [size - 1, k],
        [k, size - 1],
        [0, k],
      ][side];
      const v = data[y * size + x];
      out.set(lookup.color.subarray(v * 4, v * 4 + 3), k * 3);
    }
    return out;
  });
}

const colorDiff = (a, b) => {
  let d = 0;
  for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]);
  return d / (a.length * 255);
};

/**
 * A tile's distance from what its cell wants: the wetness of its regions and
 * edges against `want`, and the colours along the edges it shares with the
 * tiles already chosen (`seams[side]`: that neighbour's tile, or null).
 */
function fitScore(tile, want, seams) {
  const info = tile.info;
  let s = 0;
  for (let k = 0; k < 9; k++) s += REGION_WEIGHT[k] * Math.abs(info.regions[k] - want.regions[k]);
  for (let side = 0; side < 4; side++) {
    const n = seams[side];
    const opposite = (side + 2) % 4;
    s += SEAM_WEIGHT * meanDiff(info.edges[side], n?.info ? n.info.edges[opposite] : want.edges[side]);
    if (n?.colors && tile.colors) s += COLOR_WEIGHT * colorDiff(tile.colors[side], n.colors[opposite]);
  }
  return s;
}

/**
 * Pick the tile of every cell. `pools` holds the tiles per role (clear,
 * water, shore, rough, rock, water-rock), each tile `{ key, info, colors,
 * template }` with `info` from analyzeTile, `colors` from edgeColors (or
 * null) and `pools.templates` the templates `{ role,
 * width, tiles: Map<cell index, tile> }` for whole-template placement.
 * Returns `{ picks, trees, coast }`: `picks[i]` the tile of cell i (null
 * when the theater has none for it), `trees[i]` 1 where a tree stands,
 * `coast` how many land cells lie by the water and how many took a beach
 * tile.
 * @param {Uint8Array} terrain engine terrain bytes (RGBA per cell, R = type)
 */
export function planTerrain(terrain, w, h, pools) {
  // Walls are drawn as rock, beaches as rough ground (beach tiles by the water).
  const type = (x, y) => {
    const v = terrain[(y * w + x) * 4];
    return v === WALL ? ROCK : v === BEACH ? ROUGH : v;
  };
  const picks = new Array(w * h).fill(null);
  const trees = new Uint8Array(w * h);
  const coast = { cells: 0, fitted: 0 };
  const pick = (list, x, y, salt) => (list.length ? list[hash(x, y, salt) % list.length] : null);
  const inMap = (x, y) => x >= 0 && y >= 0 && x < w && y < h;

  // Rocks standing in water: rock cells with water on two or more sides.
  const wetRock = new Uint8Array(w * h);
  if (pools['water-rock'].length) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (type(x, y) !== ROCK) continue;
        let n = 0;
        for (const [dx, dy] of SIDES) if (inMap(x + dx, y + dy) && isWaterType(type(x + dx, y + dy))) n++;
        if (n >= 2) wetRock[y * w + x] = 1;
      }
    }
  }
  // Water for the beaches: water cells and rocks in the water; off the map is not.
  const wetCell = (x, y) => inMap(x, y) && (isWaterType(type(x, y)) || wetRock[y * w + x] === 1);

  // Whole templates over runs of rough and rock cells (raster order, first fit by the cell's hash).
  const placeTemplates = (want, templates, salt) => {
    if (!templates.length) return;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (picks[y * w + x] || !want(x, y)) continue;
        const order = templates.map((t, k) => [hash(x, y, salt + k), k, t]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (const [, , t] of order) {
          // The template's first tile sits on this cell; every tile on a free cell of the kind.
          if (!t.tiles.has(0)) continue;
          let fits = true;
          for (const c of t.tiles.keys()) {
            const cx = x + (c % t.width);
            const cy = y + Math.floor(c / t.width);
            if (!inMap(cx, cy) || picks[cy * w + cx] || !want(cx, cy)) {
              fits = false;
              break;
            }
          }
          if (!fits) continue;
          for (const [c, tile] of t.tiles) picks[(y + Math.floor(c / t.width)) * w + x + (c % t.width)] = tile;
          break;
        }
      }
    }
  };
  const multi = (role) => pools.templates.filter((t) => t.role === role && t.tiles.size > 1);
  const single = (role) => pools[role].filter((t) => t.template.tiles.size === 1);
  placeTemplates((x, y) => type(x, y) === ROCK && !wetRock[y * w + x], multi('rock'), 11);
  // Rough ground by the water becomes beach where a beach tile fits: no whole templates there.
  const nearWater = (x, y) => waterDistance(x + 0.5, y + 0.5, wetCell) <= BEACH_REACH + 0.71;
  placeTemplates((x, y) => type(x, y) === ROUGH && !nearWater(x, y), multi('rough'), 13);
  placeTemplates((x, y) => wetRock[y * w + x] === 1, multi('water-rock'), 17);

  const ground = pools.clear;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = type(x, y);
      trees[i] = v === TREE ? 1 : 0;
      if (picks[i]) continue;
      if (v === ROCK) {
        picks[i] = wetRock[i] ? pick(single('water-rock'), x, y, 5) : pick(single('rock'), x, y, 5);
        picks[i] ??= pick(pools.rock, x, y, 5) ?? pick(single('rough'), x, y, 5) ?? pick(ground, x, y);
        continue;
      }
      if (isWaterType(v)) {
        picks[i] = pick(pools.water, x, y);
        continue;
      }
      if (v === ROAD) {
        picks[i] = pick(pools.road ?? [], x, y, 7) ?? pick(ground, x, y);
        continue;
      }
      // Clear and rough ground: a beach tile by the water when one fits better than the ground's own tile.
      picks[i] = v === ROUGH ? (pick(single('rough'), x, y, 3) ?? pick(ground, x, y)) : pick(ground, x, y);
      if (v === TREE || !pools.shore.length || !nearWater(x, y)) continue;
      const want = beachTargets(x, y, wetCell);
      if (want.regions.every((k) => k === 0) && want.edges.every((e) => e.every((k) => k === 0))) continue;
      coast.cells++;
      // The tiles already chosen to the north and west.
      const seams = SIDES.map(([dx, dy]) => (dx > 0 || dy > 0 || !inMap(x + dx, y + dy) ? null : picks[(y + dy) * w + x + dx]));
      let best = fitScore(picks[i], want, seams);
      const near = [];
      for (const tile of pools.shore) {
        // The cell is land: its tile must not look like water in the middle.
        if (tile.info.regions[4] > LAND_CENTRE) continue;
        const s = fitScore(tile, want, seams);
        if (s < best - TIE) {
          best = s;
          near.length = 0;
        }
        if (s <= best + TIE) near.push([s, tile]);
      }
      const good = near.filter(([s]) => s <= best + TIE).map(([, t]) => t);
      if (good.length) {
        picks[i] = good[hash(x, y, 1) % good.length];
        coast.fitted++;
      }
    }
  }
  return { picks, trees, coast };
}

// ---- The atlas -------------------------------------------------------------------------------

/** The atlas index of the n-th map tile: 0 .. TERRAIN_TILES - 1, then from EXTRA_TILE_BASE (past the ore and gem tiles). */
export function terrainTileIndex(n) {
  return n < TERRAIN_TILES ? n : EXTRA_TILE_BASE + (n - TERRAIN_TILES);
}

/** A blank RGBA atlas of ATLAS_COLS x `rows` tiles of `tile` pixels (one extra pixel row with `extraRow`). */
export function blankAtlas(tile = ORIGINAL_TILE, rows = 16, extraRow = false) {
  const width = ATLAS_COLS * tile;
  const height = rows * tile + (extraRow ? 1 : 0);
  return { width, height, tile, data: new Uint8Array(width * height * 4), cols: ATLAS_COLS };
}

/** Copy an RGBA tile (tile x tile pixels) into atlas slot `index`. */
export function putTile(atlas, index, rgba) {
  const t = atlas.tile;
  const ox = (index % ATLAS_COLS) * t;
  const oy = Math.floor(index / ATLAS_COLS) * t;
  for (let y = 0; y < t; y++) atlas.data.set(rgba.subarray(y * t * 4, (y + 1) * t * 4), ((oy + y) * atlas.width + ox) * 4);
}

/**
 * 8-bit pixels (width x height, 0 transparent) through a palette lookup,
 * centred into a tile x tile RGBA tile, or over `under`. `rotation` ([first index,
 * count]) marks rotating water pixels in the alpha channel.
 */
function indexedTile(data, width, height, lookup, tile, under = null, rotation = null) {
  const out = under ? under.slice() : new Uint8Array(tile * tile * 4);
  const ox = Math.floor((tile - width) / 2);
  const oy = Math.floor((tile - height) / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      const tx = x + ox;
      const ty = y + oy;
      if (tx < 0 || ty < 0 || tx >= tile || ty >= tile) continue;
      const o = (ty * tile + tx) * 4;
      if (!under) {
        out.set(lookup.color.subarray(v * 4, v * 4 + 4), o);
        if (rotation && v >= rotation[0] && v < rotation[0] + rotation[1]) out[o + 3] = WATER_ALPHA + (v - rotation[0]);
        continue;
      }
      if (v === 0) continue;
      const a = lookup.color[v * 4 + 3] / 255;
      for (let k = 0; k < 3; k++) out[o + k] = Math.round(out[o + k] * (1 - a) + lookup.color[v * 4 + k] * a);
    }
  }
  return out;
}

/** Halve 8-bit pixels (nearest: the top-left pixel of each 2 x 2 block that is not transparent). */
function halve(data, width, height) {
  const w = Math.ceil(width / 2);
  const h = Math.ceil(height / 2);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < 4 && v === 0; k++) {
        const sx = x * 2 + (k & 1);
        const sy = y * 2 + (k >> 1);
        if (sx < width && sy < height) v = data[sy * width + sx];
      }
      out[y * w + x] = v;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * The tiles of a theater by role (planTerrain `pools`), read from the
 * installed templates, or null without plain ground or open water.
 * `sprite(name)` decodes a template file (null when missing or broken);
 * `lookup` (the terrain palette) gives the tiles their edge colours.
 */
export function theaterPools(tileset, sprite, lookup = null) {
  const info = TERRAIN[tileset];
  if (!info) return null;
  const pools = { clear: [], water: [], shore: [], rough: [], rock: [], 'water-rock': [], road: [], templates: [] };
  const raw = [];
  info.templates.forEach(([img, width, height, role, cells], id) => {
    const s = sprite(info.images[img]);
    if (!s) return;
    const template = { id, image: info.images[img], width, height, role, tiles: new Map() };
    for (const c of cells) {
      const f = s.frames[c];
      if (!f || f.width !== ORIGINAL_TILE || f.height !== ORIGINAL_TILE) continue;
      const tile = { key: `${template.image}#${c}`, image: template.image, tile: c, role, template, data: f.data, info: null, colors: null };
      template.tiles.set(c, tile);
      raw.push(tile);
    }
    if (template.tiles.size) pools.templates.push(template);
  });
  // Water is whatever the open water tiles are made of, ground whatever the plain ground tiles are.
  const water = new Uint8Array(256);
  const ground = new Uint8Array(256);
  for (const t of raw) if (t.role === 'water') for (const v of t.data) water[v] = 1;
  for (const t of raw) if (t.role === 'clear') for (const v of t.data) if (!water[v]) ground[v] = 1;
  for (const t of raw) {
    if (t.role === 'shore') t.info = analyzeTile(t.data, water, ground);
    else if (t.role === 'water' || t.role === 'water-rock') t.info = solid(1);
    else t.info = solid(0);
    t.colors = lookup ? edgeColors(t.data, lookup) : null;
    pools[t.role].push(t);
  }
  if (!pools.clear.length || !pools.water.length) return null;
  return pools;
}

/**
 * The tile atlas and per-cell tile layer of a map in the original theater
 * tiles: `{ atlas, cells, report }` or null when the theater is not
 * installed. `atlas` is ready for Renderer.setTerrainAtlas (flags for the
 * shader, nearest filtering); `cells` is RGBA per cell (tile index R + 256 G)
 * for Renderer.uploadCells.
 * @param {(name: string) => Uint8Array | null} getFile
 */
export function originalTerrain(getFile, tileset, terrain, w, h) {
  const info = TERRAIN[tileset];
  if (!info) return null;
  const pal = getFile(info.palette);
  if (!pal) return null;
  let lookup;
  try {
    lookup = paletteLookup(decodePalette(pal), { remap: false, shadow: TERRAIN_SHADOW });
  } catch {
    return null;
  }
  const decoded = new Map();
  const sprite = (name) => {
    if (!decoded.has(name)) {
      const bytes = getFile(name);
      let s = null;
      try {
        s = bytes ? decodeSprite(bytes) : null;
      } catch {
        s = null;
      }
      decoded.set(name, s);
    }
    return decoded.get(name);
  };
  const pools = theaterPools(tileset, sprite, lookup);
  if (!pools) return null; // no plain ground or water: not this theater
  const { picks, trees, coast } = planTerrain(terrain, w, h, pools);
  const rotation = info.rotation?.[1] === WATER_COLORS ? info.rotation : null;
  const report = { tiles: 0, overflow: 0, trees: 0, coast: coast.cells, beach: coast.fitted };
  const order = [];
  const index = new Map();
  const nextIndex = () => terrainTileIndex(order.length);
  const tiles = [];
  const place = (key, rgba) => {
    if (index.has(key)) return index.get(key);
    const k = nextIndex();
    if (k >= SMUDGE_TILE_BASE) return null;
    order.push(key);
    index.set(key, k);
    tiles.push([k, rgba]);
    return k;
  };
  // Tree tiles: a few trees, halved, on the first plain ground tile.
  const treeTiles = [];
  const ground = pools.clear[0];
  for (const [name, def] of Object.entries(TREES)) {
    if (treeTiles.length >= 4) break;
    const s = sprite(sequenceFile(def, tileset));
    const f = s?.frames[def.start ?? 0];
    if (!f || !f.width) continue;
    const small = halve(f.data, f.width, f.height);
    const base = indexedTile(ground.data, ORIGINAL_TILE, ORIGINAL_TILE, lookup, ORIGINAL_TILE);
    const k = place(`tree:${name}`, indexedTile(small.data, small.width, small.height, lookup, ORIGINAL_TILE, base));
    if (k !== null) treeTiles.push(k);
  }
  const cells = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let k = null;
    if (trees[i] && treeTiles.length) {
      k = treeTiles[hash(i % w, Math.floor(i / w), 7) % treeTiles.length];
      report.trees++;
    } else {
      // Past the atlas budget a cell keeps a plain tile of its kind (always placed early).
      const own = picks[i];
      const plain = isWaterType(terrain[i * 4]) ? pools.water[0] : pools.clear[0];
      for (const t of [own, plain]) {
        if (!t) continue;
        k = place(t.key, indexedTile(t.data, ORIGINAL_TILE, ORIGINAL_TILE, lookup, ORIGINAL_TILE, null, rotation));
        if (k !== null) break;
        report.overflow++;
      }
    }
    k ??= 0;
    cells[i * 4] = k & 255;
    cells[i * 4 + 1] = k >> 8;
    cells[i * 4 + 3] = 255;
  }
  report.tiles = index.size;
  // Smudge tiles: a frame per depth (the last one repeats), every variant of both types or none.
  const smudgeTiles = [];
  for (const [type, list] of [SMUDGES.scorch ?? [], SMUDGES.crater ?? []].entries()) {
    for (let v = 0; v < SMUDGE_VARIANTS; v++) {
      const def = list[v];
      const s = def ? sprite(sequenceFile(def, tileset)) : null;
      let r = null;
      try {
        r = s ? resolveSequence(def, s.frames.length) : null;
      } catch {
        r = null;
      }
      if (!r || !r.fileFrames.length) continue;
      for (let d = 0; d < SMUDGE_DEPTHS; d++) {
        const f = s.frames[r.fileFrames[Math.min(d, r.fileFrames.length - 1)]];
        if (!f || !f.width) continue;
        smudgeTiles.push([SMUDGE_TILE_BASE + (type * SMUDGE_VARIANTS + v) * SMUDGE_DEPTHS + d, indexedTile(f.data, f.width, f.height, lookup, ORIGINAL_TILE)]);
      }
    }
  }
  const smudges = smudgeTiles.length === 2 * SMUDGE_VARIANTS * SMUDGE_DEPTHS;
  report.smudges = smudges;
  const highest = Math.max(GEM_TILE_BASE + GEM_LEVELS * GEM_VARIANTS - 1, ...tiles.map(([k]) => k), smudges ? SMUDGE_TILE_BASE + smudgeTiles.length - 1 : 0);
  const atlas = blankAtlas(ORIGINAL_TILE, Math.ceil((highest + 1) / ATLAS_COLS), !!rotation);
  for (const [k, rgba] of tiles) putTile(atlas, k, rgba);
  let flags = ART_TILES;
  if (rotation) {
    // The rotating colours in the last pixel row, in palette order.
    const row = (atlas.height - 1) * atlas.width * 4;
    for (let k = 0; k < rotation[1]; k++) {
      atlas.data.set(lookup.color.subarray((rotation[0] + k) * 4, (rotation[0] + k) * 4 + 3), row + k * 4);
      atlas.data[row + k * 4 + 3] = 255;
    }
    flags |= ART_WATER_ROTATION;
  }
  // Ore and gem overlays: a frame per density level.
  const overlays = (list, base, levels, variants) => {
    let any = false;
    for (let v = 0; v < variants; v++) {
      const def = list[v % Math.max(1, list.length)];
      if (!def) return false;
      const s = sprite(sequenceFile(def, tileset));
      if (!s) return false;
      let r;
      try {
        r = resolveSequence(def, s.frames.length);
      } catch {
        return false;
      }
      for (let l = 0; l < levels; l++) {
        const frame = s.frames[r.fileFrames[Math.round((l * (r.fileFrames.length - 1)) / Math.max(1, levels - 1))]];
        if (!frame) return false;
        putTile(atlas, base + v * levels + l, indexedTile(frame.data, frame.width, frame.height, lookup, ORIGINAL_TILE));
        any = true;
      }
    }
    return any;
  };
  if (overlays(RESOURCES.ore, ORE_TILE_BASE, ORE_LEVELS, ORE_VARIANTS)) flags |= ART_ORE;
  if (overlays(RESOURCES.gems, GEM_TILE_BASE, GEM_LEVELS, GEM_VARIANTS)) flags |= ART_GEMS;
  if (smudges) {
    for (const [k, rgba] of smudgeTiles) putTile(atlas, k, rgba);
    flags |= ART_SMUDGES;
  }
  return { atlas: { ...atlas, flags, filter: 'nearest' }, cells, report };
}

/** Square tiles of a horizontal strip image ({ width, height, rgba }), each `size` x `size`. */
function stripTiles(img, size) {
  if (!img) return [];
  const out = [];
  const count = Math.floor(img.width / size);
  for (let k = 0; k < count; k++) {
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) rgba.set(img.rgba.subarray((y * img.width + k * size) * 4, (y * img.width + k * size + size) * 4), y * size * 4);
    out.push(rgba);
  }
  return out;
}

/** Tile (col, row) of a grid image. */
function gridTile(img, size, col, row) {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const from = ((row * size + y) * img.width + col * size) * 4;
    rgba.set(img.rgba.subarray(from, from + size * 4), y * size * 4);
  }
  return rgba;
}

/**
 * Tile terrain from a texture pack's tiles (manifest `terrain`, content/packs.js):
 * `{ atlas, cells }`. Each class is a row of variants picked per cell;
 * missing classes fall back (rough and tree to clear, rock to rough, ford to
 * water). `images` maps the pack's paths to decoded `{ width, height, rgba }`.
 */
export function packTerrain(t, images, terrain, w, h) {
  const size = t.tileSize;
  const strip = (k) => stripTiles(t[k] ? images.get(t[k]) : null, size);
  const clear = strip('clear');
  const water = strip('water');
  if (!clear.length || !water.length) return null;
  const rough = strip('rough').length ? strip('rough') : clear;
  const rock = strip('rock').length ? strip('rock') : rough;
  const tree = strip('tree').length ? strip('tree') : clear;
  const ford = strip('ford').length ? strip('ford') : water;
  const atlas = blankAtlas(size);
  const classes = [clear, rough, rock, water, tree, ford]; // engine terrain values 0..5
  const bases = [];
  let next = 0;
  for (const tiles of classes) {
    bases.push([next, tiles.length]);
    for (const rgba of tiles) putTile(atlas, next++, rgba);
  }
  const cells = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const [base, count] = bases[Math.min(5, terrain[i * 4])];
      cells[i * 4] = base + (hash(x, y) % count);
      cells[i * 4 + 3] = 255;
    }
  }
  let flags = ART_TILES;
  const grid = (key, base, levels, variants, flag) => {
    const img = t[key] ? images.get(t[key]) : null;
    if (!img) return;
    const cols = Math.floor(img.width / size);
    const rows = Math.floor(img.height / size);
    if (!cols || !rows) return;
    for (let v = 0; v < variants; v++) {
      for (let l = 0; l < levels; l++) {
        const col = Math.round((l * (cols - 1)) / Math.max(1, levels - 1));
        putTile(atlas, base + v * levels + l, gridTile(img, size, col, v % rows));
      }
    }
    flags |= flag;
  };
  grid('ore', ORE_TILE_BASE, ORE_LEVELS, ORE_VARIANTS, ART_ORE);
  grid('gems', GEM_TILE_BASE, GEM_LEVELS, GEM_VARIANTS, ART_GEMS);
  return { atlas: { ...atlas, flags, filter: 'nearest' }, cells };
}
