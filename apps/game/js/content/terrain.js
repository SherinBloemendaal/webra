// Tile terrain: the map drawn with Red Alert's own terrain tiles (TMP
// templates from the player's theater MIX, content/tables.js TERRAIN) or a
// texture pack's tiles, instead of WebRA's generated tiles (js/art/terrain.js).
//
// WebRA maps store terrain types, not templates, so every cell gets a single
// tile of its class (L land, R rough, K rock, W water; trees are land with a
// tree on top, fords are water). Cells whose neighbours are all of their own
// class take a tile from a plain template (clear ground, water, debris);
// cells at a border take the tile of a shore or cliff template whose own
// neighbours inside the template match the map best, so shorelines and
// cliff edges face the right way. It is an approximation of OpenRA's
// hand-made maps: templates are not matched across several cells.
//
// The atlas has ATLAS_COLS tiles to a row (shaders/terrain.wgsl reads the
// tile size from its width); ore and gem overlays sit at fixed tiles.

import { RESOURCES, TERRAIN, TREES } from './tables.js';
import { decodeSprite } from './shp.js';
import { TERRAIN_SHADOW, decodePalette, paletteLookup } from './palette.js';
import { resolveSequence, sequenceFile } from './sequences.js';

export const ATLAS_COLS = 16;
export const ORIGINAL_TILE = 24;
/** Tiles for the map itself: 0 .. TERRAIN_TILES - 1. */
export const TERRAIN_TILES = 192;
export const ORE_TILE_BASE = 192;
export const ORE_LEVELS = 12;
export const ORE_VARIANTS = 4;
export const GEM_TILE_BASE = 240;
export const GEM_LEVELS = 4;
export const GEM_VARIANTS = 4;
/** Globals.art.x bits (shaders/common.wgsl). */
export const ART_TILES = 1;
export const ART_ORE = 2;
export const ART_GEMS = 4;

/** Engine terrain values (engine/src/map.rs) -> tile class. */
const CLASS_OF_TERRAIN = ['L', 'R', 'K', 'W', 'L', 'W'];
const TREE = 4;
const group = (c) => (c === 'R' ? 'L' : c);

function hash(x, y, salt = 0) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Index the tile table of a tileset: plain tiles per class and border tiles.
 * `available(image)` says whether the template file is installed.
 */
export function tileChoices(tileset, available = () => true) {
  const info = TERRAIN[tileset];
  const pure = { L: [], R: [], K: [], W: [] };
  const edge = { L: [], R: [], K: [], W: [] };
  if (!info) return { pure, edge };
  for (const [img, tile, cls, sig, isPure] of info.tiles) {
    if (!available(info.images[img])) continue;
    const t = { image: info.images[img], tile, cls, sig };
    (isPure ? pure : edge)[cls].push(t);
  }
  return { pure, edge };
}

/**
 * The tile for each cell: `{ picks, trees }` where `picks[i]` is
 * `{ image, tile }` (or null when the tileset has nothing for the class) and
 * `trees[i]` whether a tree stands there. `terrain` is the engine's terrain
 * bytes (RGBA per cell, R = terrain type).
 */
export function chooseTiles(terrain, w, h, choices) {
  const cls = new Array(w * h);
  for (let i = 0; i < w * h; i++) cls[i] = CLASS_OF_TERRAIN[terrain[i * 4]] ?? 'L';
  const picks = new Array(w * h).fill(null);
  const trees = new Uint8Array(w * h);
  const DIRS = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const own = cls[i];
      trees[i] = terrain[i * 4] === TREE ? 1 : 0;
      const n = DIRS.map(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx < 0 || ny < 0 || nx >= w || ny >= h ? group(own) : group(cls[ny * w + nx]);
      });
      const plain = n.every((c) => c === group(own));
      const pool = choices.pure[own].length ? choices.pure[own] : choices.pure[group(own)];
      if (plain && pool.length) {
        picks[i] = pool[hash(x, y) % pool.length];
        continue;
      }
      // Border tiles: every known neighbour inside the template matches the
      // map, every different neighbour is shown; most matches wins.
      let best = [];
      let bestScore = -1;
      for (const c of own === 'R' ? ['R', 'L'] : [own]) {
        for (const t of choices.edge[c]) {
          let score = 0;
          let ok = true;
          for (let d = 0; d < 4 && ok; d++) {
            const s = t.sig[d];
            if (s === '?') {
              if (n[d] !== group(own)) ok = false;
            } else if (s === n[d]) {
              score++;
            } else {
              ok = false;
            }
          }
          if (!ok) continue;
          if (score > bestScore) {
            bestScore = score;
            best = [t];
          } else if (score === bestScore) {
            best.push(t);
          }
        }
        if (best.length) break;
      }
      if (best.length) picks[i] = best[hash(x, y, 1) % best.length];
      else if (pool.length) picks[i] = pool[hash(x, y) % pool.length];
    }
  }
  return { picks, trees };
}

/** A blank RGBA atlas of ATLAS_COLS x 16 tiles of `tile` pixels. */
export function blankAtlas(tile = ORIGINAL_TILE) {
  const width = ATLAS_COLS * tile;
  const height = 16 * tile;
  return { width, height, tile, data: new Uint8Array(width * height * 4), cols: ATLAS_COLS };
}

/** Copy an RGBA tile (tile x tile pixels) into atlas slot `index`. */
export function putTile(atlas, index, rgba) {
  const t = atlas.tile;
  const ox = (index % ATLAS_COLS) * t;
  const oy = Math.floor(index / ATLAS_COLS) * t;
  for (let y = 0; y < t; y++) atlas.data.set(rgba.subarray(y * t * 4, (y + 1) * t * 4), ((oy + y) * atlas.width + ox) * 4);
}

/** 8-bit pixels (width x height, 0 transparent) through a palette lookup, centred into a tile x tile RGBA tile. */
function indexedTile(data, width, height, lookup, tile, under = null) {
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
 * The tile atlas and per-cell tile layer of a map in the original theater
 * tiles: `{ atlas, cells, report }` or null when the theater is not
 * installed. `atlas` is ready for Renderer.setTerrainAtlas (flags for the
 * shader, nearest filtering); `cells` is RGBA per cell (R tile index) for
 * Renderer.uploadCells.
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
  const tileOf = (pick) => {
    const s = sprite(pick.image);
    const f = s?.frames[pick.tile];
    return f && f.width === ORIGINAL_TILE && f.height === ORIGINAL_TILE ? f : null;
  };
  const choices = tileChoices(tileset, (img) => !!sprite(img));
  if (!choices.pure.L.length) return null; // no clear ground: not this theater
  const { picks, trees } = chooseTiles(terrain, w, h, choices);
  const atlas = blankAtlas(ORIGINAL_TILE);
  const index = new Map();
  const cells = new Uint8Array(w * h * 4);
  const report = { tiles: 0, overflow: 0, trees: 0 };
  const fallback = (i) => {
    const pool = choices.pure[CLASS_OF_TERRAIN[terrain[i * 4]]] ?? [];
    return pool[0] ?? choices.pure.L[0];
  };
  const place = (key, rgba) => {
    if (index.has(key)) return index.get(key);
    if (index.size >= TERRAIN_TILES) return null;
    const k = index.size;
    putTile(atlas, k, rgba);
    index.set(key, k);
    return k;
  };
  // Tree tiles: a few trees, halved, on the first plain land tile.
  const treeTiles = [];
  const ground = tileOf(choices.pure.L[0]);
  for (const [name, def] of Object.entries(TREES)) {
    if (treeTiles.length >= 4 || !ground) break;
    const s = sprite(sequenceFile(def, tileset));
    const f = s?.frames[def.start ?? 0];
    if (!f || !f.width) continue;
    const small = halve(f.data, f.width, f.height);
    const base = indexedTile(ground.data, ORIGINAL_TILE, ORIGINAL_TILE, lookup, ORIGINAL_TILE);
    const rgba = indexedTile(small.data, small.width, small.height, lookup, ORIGINAL_TILE, base);
    const k = place(`tree:${name}`, rgba);
    if (k !== null) treeTiles.push(k);
  }
  for (let i = 0; i < w * h; i++) {
    let k = null;
    if (trees[i] && treeTiles.length) {
      k = treeTiles[hash(i % w, Math.floor(i / w), 7) % treeTiles.length];
      report.trees++;
    } else {
      for (const pick of [picks[i], fallback(i)]) {
        if (!pick) continue;
        const f = tileOf(pick);
        if (!f) continue;
        k = place(`${pick.image}#${pick.tile}`, indexedTile(f.data, ORIGINAL_TILE, ORIGINAL_TILE, lookup, ORIGINAL_TILE));
        if (k === null) report.overflow++;
        if (k !== null) break;
      }
    }
    cells[i * 4] = k ?? 0;
    cells[i * 4 + 3] = 255;
  }
  report.tiles = index.size;
  let flags = ART_TILES;
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
