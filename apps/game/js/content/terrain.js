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
// - road cells take the tiles of Red Alert's road templates that fit the
//   road through them: each road tile is read for where its road is (the
//   palette indices of the road templates' road cells against those of the
//   plain ground), and the tile whose road best matches a road along the
//   centre line of the cell's road neighbours, and the tiles already chosen
//   around it, wins. Clear ground beside a road takes a verge tile of the
//   road templates (their Clear cells, where the road's edge fades into the
//   grass) when one fits better than plain ground;
// - bridges (actors that draw their template over the cells, content/atlas.js)
//   are fixed tiles of the plan: the ground, roads and beaches around them
//   are fitted to the template's edges on every side;
// - beaches are drawn like rough ground by the water (beach tiles where they
//   fit), rivers and the river under a bridge like water, walls like rock.
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

import { ACTOR_ART, RESOURCES, SMUDGES, TERRAIN, TREES } from './tables.js';
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
/** Open water to draw: rivers, and the river under a bridge's deck (the bridge actor draws the deck). */
const isWaterType = (v) => v === WATER || v === RIVER || v === BRIDGE;
/**
 * The tile class an engine terrain is drawn as: walls as rock, beaches as
 * rough ground (beach tiles by the water) and fords as a gravel crossing,
 * rough ground with beach tiles toward the water like Red Alert's ford
 * templates (Rough and Road tiles over the river), never as open water
 * the units would seem to walk on.
 */
const drawnAs = (v) => (v === WALL ? ROCK : v === BEACH || v === FORD ? ROUGH : v);

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
  return analyzeWith(data, (v) => (water[v] ? 1 : ground[v] ? 0 : 0.5), size);
}

/**
 * `{ regions, edges }` of a tile (analyzeTile's layout) for any reading of
 * its pixels: `val(palette index)` from 0 to 1.
 */
export function analyzeWith(data, val, size = ORIGINAL_TILE) {
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

/**
 * How much a pixel of each terrain palette index reads as road, from 0
 * (plain ground) to 1 (the middle of a road): Red Alert draws roads and
 * grass with partly the same colours, so an index counts by how often it
 * appears in the road cells of the road templates (`road`) against the
 * plain ground tiles (`ground`), each as a share of its own pixels, then
 * scaled so that plain ground reads 0 and the middle regions of the road
 * cells 1. Indices in neither read halfway. Null without both kinds of tile.
 */
export function roadPalette(road, ground, size = ORIGINAL_TILE) {
  const hr = new Float64Array(256);
  const hg = new Float64Array(256);
  for (const t of road) for (const v of t.data) hr[v]++;
  for (const t of ground) for (const v of t.data) hg[v]++;
  const sr = hr.reduce((a, b) => a + b, 0);
  const sg = hg.reduce((a, b) => a + b, 0);
  if (!sr || !sg) return null;
  const share = new Float64Array(256);
  for (let v = 0; v < 256; v++) {
    const a = hr[v] / sr;
    const b = hg[v] / sg;
    share[v] = a + b > 0 ? a / (a + b) : 0.5;
  }
  const mean = (tiles, x0, x1) => {
    let sum = 0;
    let n = 0;
    for (const t of tiles) {
      for (let y = x0; y < x1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += share[t.data[y * size + x]];
          n++;
        }
      }
    }
    return sum / n;
  };
  const low = mean(ground, 0, size);
  const high = mean(road, size / 3, (2 * size) / 3);
  if (!(high > low)) return null;
  return Float32Array.from(share, (p) => Math.min(1, Math.max(0, (p - low) / (high - low))));
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

/** A `[distance, value]` profile at distance `d` (linear in between, the last value past its end). */
function profileAt(profile, d) {
  if (d <= profile[0][0]) return profile[0][1];
  for (let k = 1; k < profile.length; k++) {
    const [d1, v1] = profile[k];
    if (d <= d1) {
      const [d0, v0] = profile[k - 1];
      return v0 + ((v1 - v0) * (d - d0)) / (d1 - d0);
    }
  }
  return profile[profile.length - 1][1];
}

export function beachWetness(d) {
  return profileAt(BEACH_PROFILE, d);
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
  return targetsBy(x, y, size, (px, py) => beachWetness(waterDistance(px, py, wet)));
}

/**
 * How much road there should be at a distance from a road's centre line, in
 * cells: Red Alert's roads fill the cells they run through (their road
 * cells read as road almost to the edges) and fade out in about a third of
 * a cell of the clear ground beside them (the templates' Clear cells), the
 * shape of the d-templates read from their pixels: `[distance, road]`
 * points, linear in between.
 */
export const ROAD_PROFILE = Object.freeze([
  [0, 1],
  [0.4, 1],
  [0.55, 0.7],
  [0.7, 0.3],
  [0.85, 0],
]);

export function roadLevel(d) {
  return profileAt(ROAD_PROFILE, d);
}

/** Distance from point (px, py) to the segment from (ax, ay) to (bx, by). */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Distance (in cells) from point (px, py), in map cell units, to the centre
 * line of the roads around it, looking up to two cells around (Infinity
 * when there is no road that close). `road(cx, cy)` says whether a cell
 * carries road (bridge decks too, so roads run onto their bridges). The
 * centre line joins the centres of road cells side by side, and of road
 * cells corner to corner where no road cell beside both joins them (a
 * diagonal road); a road cell's centre is on it too (a lone cell, a road's
 * end).
 */
export function roadDistance(px, py, road) {
  const x0 = Math.floor(px) - 2;
  const y0 = Math.floor(py) - 2;
  return nearestSegment(px, py, roadSegments(x0, y0, x0 + 4, y0 + 4, road));
}

/** The centre line pieces (roadDistance) starting in the cells x0..x1, y0..y1: [ax, ay, bx, by] each. */
function roadSegments(x0, y0, x1, y1, road) {
  const out = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (!road(cx, cy)) continue;
      const ax = cx + 0.5;
      const ay = cy + 0.5;
      out.push([ax, ay, ax, ay]);
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [-1, 1],
      ]) {
        if (!road(cx + dx, cy + dy)) continue;
        if (dx && dy && (road(cx + dx, cy) || road(cx, cy + dy))) continue;
        out.push([ax, ay, ax + dx, ay + dy]);
      }
    }
  }
  return out;
}

function nearestSegment(px, py, segments) {
  let best = Infinity;
  for (const [ax, ay, bx, by] of segments) best = Math.min(best, segmentDistance(px, py, ax, ay, bx, by));
  return best;
}

/**
 * What a cell's tile should look like on or beside a road: the road wanted
 * in each region (REGION order) and along each edge (beachTargets' layout),
 * from the distance of each spot to the roads' centre line.
 */
export function roadTargets(x, y, road, size = ORIGINAL_TILE) {
  // Pieces farther from the cell's middle than its corners plus the profile's reach add nothing.
  const reach = Math.SQRT1_2 + ROAD_PROFILE[ROAD_PROFILE.length - 1][0];
  const segments = roadSegments(x - 3, y - 3, x + 3, y + 3, road).filter(([ax, ay, bx, by]) => segmentDistance(x + 0.5, y + 0.5, ax, ay, bx, by) <= reach);
  return targetsBy(x, y, size, (px, py) => roadLevel(nearestSegment(px, py, segments)));
}

/** Regions and edges of cell (x, y) wanted by `at(px, py)` (map cell units). */
function targetsBy(x, y, size, at) {
  const regions = new Float32Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) regions[r * 3 + c] = at(x + (c + 0.5) / 3, y + (r + 0.5) / 3);
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
      out[k] = at(px, py);
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
/** The most a beach tile under a structure or tree may be wet in its centre region: sand, no water. */
export const DRY_CENTRE = 0.5;
/** Scores within this of the best count as equally good (the cell's hash picks among them). */
const TIE = 0.05;

/**
 * How much worse a whole road template's tiles may fit, on average
 * (fitScore), than the best single tiles of their cells: the road a cell
 * wants is a rough shape, and a template's tiles join each other the way
 * Red Alert's artists drew them, which no choice of single tiles matches.
 * Hand-tuned on the d-templates: their straight pieces, corners and
 * crossings fit within it where the road runs their way.
 */
export const ROAD_TEMPLATE_FIT = 2;
/**
 * The most beach a clear cell beside a road may want in its middle
 * (beachWetness) and still take a road verge: nearer the water its beach
 * goes first.
 */
export const VERGE_SHORE = 0.1;
/**
 * How much road a whole road template's road tile has along a side on the
 * template's border (the mean of its road edge): at least the first where
 * the map's road goes on through that side, at most the second where it
 * does not (a road that runs off the template into the grass).
 */
export const ROAD_EXIT = Object.freeze([0.5, 0.75]);
/** What a road or verge tile costs when the cell beside it has the same tile (runs of one tile repeat its stones). */
const ROAD_REPEAT = 0.6;

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
 * A tile's distance from what its cell wants: the reading `key` of its
 * regions and edges (`info`: wetness, `road`: road) against `want`, and the
 * colours along the edges it shares with the tiles already chosen
 * (`seams[side]`: that neighbour's tile, or null).
 * Every term is zero or more, so once the sum passes `limit` the tile cannot
 * win any more: the sum so far is returned (above `limit`). `cached[side]`
 * (SeamCache `of` the neighbour on that side, with `k` the tile's index in
 * the cache) keeps the terms of a pair of tiles, which do not depend on the
 * cell; the sum is the same either way.
 */
function fitScore(tile, want, seams, limit = Infinity, cached = null, k = 0, key = 'info') {
  const info = tile[key];
  let s = 0;
  for (let r = 0; r < 9; r++) s += REGION_WEIGHT[r] * Math.abs(info.regions[r] - want.regions[r]);
  if (s > limit) return s;
  for (let side = 0; side < 4; side++) {
    const n = seams[side];
    const opposite = (side + 2) % 4;
    const pair = cached?.[side] ?? null;
    if (n?.[key]) {
      let v = pair ? pair.edge[side][k] : NaN;
      if (Number.isNaN(v)) {
        v = meanDiff(info.edges[side], n[key].edges[opposite]);
        if (pair) pair.edge[side][k] = v;
      }
      s += SEAM_WEIGHT * v;
    } else {
      s += SEAM_WEIGHT * meanDiff(info.edges[side], want.edges[side]);
    }
    if (n?.colors && tile.colors) {
      let v = pair ? pair.color[side][k] : NaN;
      if (Number.isNaN(v)) {
        v = colorDiff(tile.colors[side], n.colors[opposite]);
        if (pair) pair.color[side][k] = v;
      }
      s += COLOR_WEIGHT * v;
    }
    if (s > limit) return s;
  }
  return s;
}

/**
 * The seam terms of fitScore per pair of tiles (one of `count` beach tiles
 * and a neighbour's tile) and side, worked out once: a map has thousands of
 * coast cells but only a few hundred tiles meet there.
 */
class SeamCache {
  constructor(count) {
    this.count = count;
    this.pairs = new Map();
  }

  /** The terms against neighbour `n`: `{ edge, color }`, per side one value per tile (NaN until worked out). */
  of(n) {
    let p = this.pairs.get(n);
    if (!p) {
      const row = () => new Float64Array(this.count).fill(NaN);
      p = { edge: [row(), row(), row(), row()], color: [row(), row(), row(), row()] };
      this.pairs.set(n, p);
    }
    return p;
  }
}

/**
 * The best of `list` for a cell (fitScore against `want` and `seams`, reading
 * `key`), or `incumbent` (scored first) when none beats it by more than TIE:
 * `{ tile, fitted }`, `fitted` true when a tile of `list` won. Tiles within
 * TIE of the best are equally good; the cell's hash picks among them.
 */
function bestFit(list, incumbent, want, seams, cache, key, x, y, repeat = 0) {
  let best = incumbent ? fitScore(incumbent, want, seams, Infinity, null, 0, key) : Infinity;
  const near = [];
  const cached = seams.map((n) => (n ? cache.of(n) : null));
  for (let k = 0; k < list.length; k++) {
    const tile = list[k];
    // The same tile as a neighbour's costs `repeat` (a run of one tile shows its stones over and over).
    const again = repeat && seams.includes(tile) ? repeat : 0;
    // A tile scoring above best + TIE is never kept (and never the best): its score may stop early.
    const s = again + fitScore(tile, want, seams, best + TIE - again, cached, k, key);
    if (s < best - TIE) {
      best = s;
      near.length = 0;
    }
    if (s <= best + TIE) near.push([s, tile]);
  }
  const good = near.filter(([s]) => s <= best + TIE).map(([, t]) => t);
  if (!good.length) return { tile: incumbent, fitted: false };
  return { tile: good[hash(x, y, 1) % good.length], fitted: true };
}

/**
 * Pick the tile of every cell. `pools` holds the tiles per role (clear,
 * water, shore, rough, rock, water-rock, road), each tile `{ key, info, road,
 * colors, template }` with `info` from analyzeTile, `road` its reading for
 * road (analyzeWith and roadPalette; plain ground for tiles of other roles),
 * `colors` from edgeColors (or null), road tiles `onRoad` when their
 * template has them on a road cell, and `pools.templates` the templates `{
 * role, width, tiles: Map<cell index, tile> }` for whole-template
 * placement. `fixed` lists templates that are already there (bridges): `{
 * x, y, width, tiles: Map<cell index, tile> }`, which take their cells
 * first and are matched on every side. `dry` (one byte per cell, or null)
 * marks cells something stands on (structures, trees): a beach there is
 * sand at most in its middle, never water.
 * Returns `{ picks, trees, coast, roads }`: `picks[i]` the tile of cell i
 * (null when the theater has none for it), `trees[i]` 1 where a tree
 * stands, `coast` how many land cells lie by the water and how many took a
 * beach tile, `roads` how many road cells there are and how many took a
 * fitted road tile (and how many clear cells beside them took a verge).
 * @param {Uint8Array} terrain engine terrain bytes (RGBA per cell, R = type)
 */
export function planTerrain(terrain, w, h, pools, fixed = [], dry = null) {
  const type = (x, y) => drawnAs(terrain[(y * w + x) * 4]);
  const picks = new Array(w * h).fill(null);
  const trees = new Uint8Array(w * h);
  const coast = { cells: 0, fitted: 0, banks: 0 };
  const roads = { cells: 0, fitted: 0, templates: 0, verges: 0 };
  const pick = (list, x, y, salt) => (list.length ? list[hash(x, y, salt) % list.length] : null);
  const inMap = (x, y) => x >= 0 && y >= 0 && x < w && y < h;

  // Templates already in place (bridges) take their cells.
  const isFixed = new Uint8Array(w * h);
  // Tiles placed before the cell by cell passes and matched on every side: fixed templates and whole road templates.
  const anchored = new Uint8Array(w * h);
  for (const f of fixed) {
    for (const [c, tile] of f.tiles) {
      const cx = f.x + (c % f.width);
      const cy = f.y + Math.floor(c / f.width);
      if (!inMap(cx, cy) || isFixed[cy * w + cx]) continue;
      picks[cy * w + cx] = tile;
      isFixed[cy * w + cx] = 1;
      anchored[cy * w + cx] = 1;
    }
  }
  // The tiles a cell is matched to: those already chosen to the north and west, anchored ones on every side.
  const seamsAt = (x, y) =>
    SIDES.map(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      if (!inMap(nx, ny)) return null;
      const j = ny * w + nx;
      return dx > 0 || dy > 0 ? (anchored[j] ? picks[j] : null) : picks[j];
    });

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
  // Water for the beaches: water cells and rocks in the water, and fixed
  // tiles that are mostly water (a bridge's banks); off the map is not.
  const wetCell = (x, y) => {
    if (!inMap(x, y)) return false;
    const i = y * w + x;
    if (isFixed[i]) return picks[i].info.regions.reduce((a, b) => a + b, 0) / 9 > 0.5;
    return isWaterType(type(x, y)) || wetRock[i] === 1;
  };

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
  // Roads: road cells take the road tiles that fit the road through them,
  // clear cells beside a road a verge tile where one fits better than plain ground.
  const onRoad = pools.road.filter((t) => t.onRoad);
  if (onRoad.length) {
    const verges = pools.road.filter((t) => !t.onRoad);
    const roadish = (x, y) => inMap(x, y) && (type(x, y) === ROAD || type(x, y) === BRIDGE);
    const besideRoad = (x, y) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && roadish(x + dx, y + dy)) return true;
      return false;
    };
    const roadCache = new SeamCache(onRoad.length);
    const vergeCache = new SeamCache(verges.length);
    const targets = new Map();
    const targetAt = (x, y) => {
      const i = y * w + x;
      if (!targets.has(i)) targets.set(i, roadTargets(x, y, roadish));
      return targets.get(i);
    };
    // Clear ground beside a road, unless it is the beach's (its middle wants sand or water).
    const vergeOk = (x, y) => type(x, y) === CLEAR && !(pools.shore.length && beachWetness(waterDistance(x + 0.5, y + 0.5, wetCell)) > VERGE_SHORE);
    // How well the best single tile fits a cell's road alone (no neighbours): what a whole template is held against.
    const baselines = new Map();
    const none = [null, null, null, null];
    const baseline = (x, y, road) => {
      const i = y * w + x;
      if (!baselines.has(i)) {
        const list = road ? onRoad : [...verges, pick(ground, x, y)];
        let best = Infinity;
        for (const tile of list) best = Math.min(best, fitScore(tile, targetAt(x, y), none, best, null, 0, 'road'));
        baselines.set(i, best);
      }
      return baselines.get(i);
    };
    // Whole road templates first: Red Alert's own pieces, drawn to join,
    // where the template's road cells lie on free road cells and its clear
    // cells on free clear ground (not by the water: beaches go first), the
    // road leaves the template only where the template's road does, and its
    // tiles fit the road through them and the tiles around them
    // (ROAD_TEMPLATE_FIT). Each road cell in raster order tries every
    // template with its first road cell there; the one covering the most road
    // cells wins (then the best fit, then the cell's hash).
    const roadTemplates = pools.templates
      .filter((t) => t.role === 'road' && t.tiles.size > 1)
      .map((t) => ({ t, first: [...t.tiles.keys()].sort((a, b) => a - b).find((c) => t.tiles.get(c).onRoad) }))
      .filter((r) => r.first !== undefined);
    for (let y = 0; y < h && roadTemplates.length; y++) {
      for (let x = 0; x < w; x++) {
        if (picks[y * w + x] || type(x, y) !== ROAD) continue;
        let best = null;
        roadTemplates.forEach(({ t, first }, k) => {
          const ox = x - (first % t.width);
          const oy = y - Math.floor(first / t.width);
          const at = new Map();
          let roadCells = 0;
          for (const [c, tile] of t.tiles) {
            const cx = ox + (c % t.width);
            const cy = oy + Math.floor(c / t.width);
            if (!inMap(cx, cy) || picks[cy * w + cx]) return;
            if (tile.onRoad ? type(cx, cy) !== ROAD : !vergeOk(cx, cy)) return;
            at.set(cy * w + cx, tile);
            if (tile.onRoad) roadCells++;
          }
          // The road leaves the template only through its road cells' sides
          // on its border, and there exactly where the map's road goes on:
          // the tile's road reaches that side (ROAD_EXIT), or keeps off it.
          for (const [c, tile] of t.tiles) {
            if (!tile.onRoad) continue;
            const cx = ox + (c % t.width);
            const cy = oy + Math.floor(c / t.width);
            for (let side = 0; side < 4; side++) {
              const nx = cx + SIDES[side][0];
              const ny = cy + SIDES[side][1];
              const inside = nx >= ox && ny >= oy && nx < ox + t.width && ny < oy + t.height;
              if (inside) {
                if (roadish(nx, ny) && !at.get(ny * w + nx)?.onRoad) return;
              } else if (inMap(nx, ny)) {
                const reach = meanOf(tile.road.edges[side]);
                if (roadish(nx, ny) ? reach < ROAD_EXIT[0] : reach > ROAD_EXIT[1]) return;
              }
            }
          }
          let score = 0;
          for (const [i, tile] of at) {
            const cx = i % w;
            const cy = Math.floor(i / w);
            // Inside the template its tiles join by design: they are held against the road there, like the single tiles.
            const seams = SIDES.map(([dx, dy]) => (inMap(cx + dx, cy + dy) && !at.has(i + dy * w + dx) ? picks[i + dy * w + dx] : null));
            score += fitScore(tile, targetAt(cx, cy), seams, Infinity, null, 0, 'road');
          }
          score /= at.size;
          let base = 0;
          for (const [i, tile] of at) base += baseline(i % w, Math.floor(i / w), tile.onRoad);
          base /= at.size;
          if (score > base + ROAD_TEMPLATE_FIT) return;
          const key = [-roadCells, score, hash(x, y, 19 + k)];
          if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] - TIE || (Math.abs(key[1] - best.key[1]) <= TIE && key[2] < best.key[2])))) best = { key, at };
        });
        if (!best) continue;
        for (const [i, tile] of best.at) {
          picks[i] = tile;
          anchored[i] = 1;
          if (tile.onRoad) {
            roads.cells++;
            roads.fitted++;
            roads.templates++;
          } else roads.verges++;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = type(x, y);
        if (picks[i]) continue;
        if (v === ROAD) {
          roads.cells++;
          const { tile } = bestFit(onRoad, null, targetAt(x, y), seamsAt(x, y), roadCache, 'road', x, y, ROAD_REPEAT);
          picks[i] = tile;
          if (tile) roads.fitted++;
        } else if (verges.length && vergeOk(x, y) && besideRoad(x, y)) {
          const plain = pick(ground, x, y);
          const { tile, fitted } = bestFit(verges, plain, targetAt(x, y), seamsAt(x, y), vergeCache, 'road', x, y, ROAD_REPEAT);
          if (fitted) {
            picks[i] = tile;
            roads.verges++;
          }
        }
      }
    }
  }

  // Beach candidates for land cells: their tile must not look like water in the middle
  // (where something stands, not even partly: sand at most).
  const landShore = pools.shore.filter((tile) => !(tile.info.regions[4] > LAND_CENTRE));
  const dryShore = landShore.filter((tile) => !(tile.info.regions[4] > DRY_CENTRE));
  const seamCache = new SeamCache(landShore.length);
  const drySeamCache = new SeamCache(dryShore.length);
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
        // No road tiles fitted (none installed): plain ground.
        picks[i] = pick(ground, x, y);
        continue;
      }
      // Clear and rough ground: a beach tile by the water when one fits better than the ground's own tile.
      picks[i] = v === ROUGH ? (pick(single('rough'), x, y, 3) ?? pick(ground, x, y)) : pick(ground, x, y);
      if (v === TREE || !pools.shore.length || !nearWater(x, y)) continue;
      const want = beachTargets(x, y, wetCell);
      if (want.regions.every((k) => k === 0) && want.edges.every((e) => e.every((k) => k === 0))) continue;
      coast.cells++;
      const standing = dry?.[i] === 1;
      const { tile, fitted } = bestFit(standing ? dryShore : landShore, picks[i], want, seamsAt(x, y), standing ? drySeamCache : seamCache, 'info', x, y);
      if (fitted) {
        picks[i] = tile;
        coast.fitted++;
      }
    }
  }
  // Open water beside a fixed template (a bridge's banks reach the edge of
  // its template): a wet beach tile that meets the bank where one fits
  // better than open water, matched to every tile around it.
  const wetShore = pools.shore.filter((tile) => tile.info.regions[4] > LAND_CENTRE);
  if (fixed.length && wetShore.length) {
    const water = solid(1);
    const bankCache = new SeamCache(wetShore.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (isFixed[i] || type(x, y) !== WATER) continue;
        const banks = SIDES.some(([dx, dy], side) => {
          const j = (y + dy) * w + x + dx;
          return inMap(x + dx, y + dy) && isFixed[j] && meanOf(picks[j].info.edges[(side + 2) % 4]) < 0.75;
        });
        if (!banks) continue;
        const seams = SIDES.map(([dx, dy]) => (inMap(x + dx, y + dy) ? picks[(y + dy) * w + x + dx] : null));
        const { tile, fitted } = bestFit(wetShore, picks[i], water, seams, bankCache, 'info', x, y);
        if (fitted) {
          picks[i] = tile;
          coast.banks++;
        }
      }
    }
  }
  return { picks, trees, coast, roads };
}

const meanOf = (a) => a.reduce((s, v) => s + v, 0) / a.length;

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
 * `pools.read(image, c, data)` reads a tile of another template (a
 * bridge's) the same way, for fitting the ground next to it.
 */
export function theaterPools(tileset, sprite, lookup = null) {
  const info = TERRAIN[tileset];
  return info ? templatePools(info, sprite, lookup) : null;
}

/**
 * theaterPools for the templates of `info` (content/tables.js TERRAIN's
 * layout: `{ images, templates }`), whatever tileset they describe.
 */
export function templatePools(info, sprite, lookup = null) {
  const pools = { clear: [], water: [], shore: [], rough: [], rock: [], 'water-rock': [], road: [], templates: [], read: null };
  const raw = [];
  info.templates.forEach(([img, width, height, role, cells, roadCells = []], id) => {
    const s = sprite(info.images[img]);
    if (!s) return;
    const template = { id, image: info.images[img], width, height, role, tiles: new Map() };
    for (const c of cells) {
      const f = s.frames[c];
      if (!f || f.width !== ORIGINAL_TILE || f.height !== ORIGINAL_TILE) continue;
      const tile = { key: `${template.image}#${c}`, image: template.image, tile: c, role, template, data: f.data, info: null, road: null, colors: null };
      if (role === 'road') tile.onRoad = roadCells.includes(c);
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
  // Road is what the road cells of the road templates are made of, against the plain ground.
  const road = roadPalette(
    raw.filter((t) => t.onRoad),
    raw.filter((t) => t.role === 'clear'),
  );
  const flat = solid(0);
  for (const t of raw) {
    if (t.role === 'shore') t.info = analyzeTile(t.data, water, ground);
    else if (t.role === 'water' || t.role === 'water-rock') t.info = solid(1);
    else t.info = solid(0);
    t.road = t.role === 'road' && road ? analyzeWith(t.data, (v) => road[v]) : flat;
    t.colors = lookup ? edgeColors(t.data, lookup) : null;
    // Road tiles only fit where their road is read (with the road templates' palette).
    if (t.role !== 'road' || road) pools[t.role].push(t);
  }
  if (!pools.clear.length || !pools.water.length) return null;
  /** A tile of another template (`image` tile `c`, 8-bit pixels), read like the theater's for fitting next to it. */
  pools.read = (image, c, data) => ({
    key: `${image}#${c}`,
    image,
    tile: c,
    role: 'fixed',
    template: null,
    data,
    info: analyzeTile(data, water, ground),
    road: road ? analyzeWith(data, (v) => road[v]) : flat,
    colors: lookup ? edgeColors(data, lookup) : null,
  });
  return pools;
}

/**
 * The bridge templates of a map as fixed tiles for planTerrain: `bridges`
 * lists `{ type, x, y, look }` (engine Game.terrain_hints_json: actor id, the
 * template's top-left cell and its look); each becomes `{ x, y, width,
 * tiles }` with the tiles of the look's template file (content/tables.js
 * ACTOR_ART `bridge`, the healthy one when the look has none). Bridges
 * without original art on this tileset (OpenRA's own templates: WebRA draws
 * them) or whose file is missing are left out.
 */
export function bridgeTemplates(bridges, tileset, sprite, pools) {
  const out = [];
  for (const b of bridges ?? []) {
    const rec = ACTOR_ART[b?.type]?.bridge?.[tileset];
    if (!rec || !Number.isInteger(b.x) || !Number.isInteger(b.y)) continue;
    const file = rec[b.look] ?? rec.healthy;
    const s = file ? sprite(file) : null;
    if (!s) continue;
    const width = rec.size[0];
    const tiles = new Map();
    s.frames.forEach((f, c) => {
      if (f && f.width === ORIGINAL_TILE && f.height === ORIGINAL_TILE && c < width * rec.size[1]) tiles.set(c, pools.read(file, c, f.data));
    });
    if (tiles.size) out.push({ x: b.x, y: b.y, width, tiles });
  }
  return out;
}

/**
 * Every file originalTerrain may read for `tileset`: the palette, the
 * template images, and the tree, smudge, ore and gem sequences. A worker
 * that tiles terrain gets these and nothing else (editor/js/tiles.js).
 */
export function theaterFiles(tileset) {
  const info = TERRAIN[tileset];
  if (!info) return [];
  const defs = [...Object.values(TREES), ...(SMUDGES.scorch ?? []), ...(SMUDGES.crater ?? []), ...RESOURCES.ore, ...RESOURCES.gems];
  const bridges = Object.values(ACTOR_ART).flatMap((a) => Object.entries(a.bridge?.[tileset] ?? {}).filter(([k]) => k !== 'size').map(([, f]) => f));
  return [...new Set([info.palette, ...info.images, ...bridges, ...defs.filter(Boolean).map((def) => sequenceFile(def, tileset))])];
}

/**
 * The tile atlas and per-cell tile layer of a map in the original theater
 * tiles: `{ atlas, cells, report }` or null when the theater is not
 * installed. `atlas` is ready for Renderer.setTerrainAtlas (flags for the
 * shader, nearest filtering); `cells` is RGBA per cell (tile index R + 256 G)
 * for Renderer.uploadCells. `hints` (engine Game.terrain_hints_json, or
 * null) has the map's `bridges` (bridgeTemplates), whose templates the
 * ground around them is fitted to, and the cells something stands on
 * (`standing`), which stay dry.
 * @param {(name: string) => Uint8Array | null} getFile
 */
export function originalTerrain(getFile, tileset, terrain, w, h, hints = null) {
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
  const dry = new Uint8Array(w * h);
  for (const ci of hints?.standing ?? []) if (Number.isInteger(ci) && ci >= 0 && ci < w * h) dry[ci] = 1;
  const fixed = bridgeTemplates(hints?.bridges ?? [], tileset, sprite, pools);
  const { picks, trees, coast, roads } = planTerrain(terrain, w, h, pools, fixed, dry);
  const rotation = info.rotation?.[1] === WATER_COLORS ? info.rotation : null;
  const report = { tiles: 0, overflow: 0, trees: 0, coast: coast.cells, beach: coast.fitted, roads: roads.cells, roadsFitted: roads.fitted, roadTemplates: roads.templates, verges: roads.verges };
  const order = [];
  const index = new Map();
  const nextIndex = () => terrainTileIndex(order.length);
  const tiles = [];
  // `pixels()` makes the tile's RGBA: only for a key not placed before (most cells share their tile).
  const place = (key, pixels) => {
    if (index.has(key)) return index.get(key);
    const k = nextIndex();
    if (k >= SMUDGE_TILE_BASE) return null;
    order.push(key);
    index.set(key, k);
    tiles.push([k, pixels()]);
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
    const k = place(`tree:${name}`, () => indexedTile(small.data, small.width, small.height, lookup, ORIGINAL_TILE, base));
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
      const plain = isWaterType(drawnAs(terrain[i * 4])) ? pools.water[0] : pools.clear[0];
      for (const t of [own, plain]) {
        if (!t) continue;
        k = place(t.key, () => indexedTile(t.data, ORIGINAL_TILE, ORIGINAL_TILE, lookup, ORIGINAL_TILE, null, rotation));
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
 * The pack class (content/packs.js TERRAIN_CLASSES) each engine terrain is
 * drawn with: the engine's first six terrains have a class of their own;
 * roads are drawn as clear ground, bridges (the bridge actor draws the deck)
 * and rivers as water, beaches as rough ground and walls as rock.
 */
export const PACK_CLASS_OF_TERRAIN = Object.freeze([CLEAR, ROUGH, ROCK, WATER, TREE, FORD, CLEAR, WATER, ROUGH, WATER, ROCK]);

/**
 * Tile terrain from a texture pack's tiles (manifest `terrain`, content/packs.js):
 * `{ atlas, cells }`. Each class is a row of variants picked per cell
 * (PACK_CLASS_OF_TERRAIN); missing classes fall back (rough and tree to
 * clear, rock and ford to rough). `images` maps the pack's paths to
 * decoded `{ width, height, rgba }`.
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
  // A ford is a crossing: without tiles of its own it is rough ground, never open water.
  const ford = strip('ford').length ? strip('ford') : rough;
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
      const [base, count] = bases[PACK_CLASS_OF_TERRAIN[terrain[i * 4]] ?? CLEAR];
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
