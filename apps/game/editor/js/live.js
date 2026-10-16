// An edit in progress, drawn as it goes: the cells a gesture changes (a
// brush stroke, a line, a shape, a moved region) show at the next frame,
// not only once the pointer lets go.
//
// The map's picture comes from the engine's preview of the map (js/world.js),
// rebuilt when a transaction closes. While one is open the editor patches
// that picture instead: the changed cells' terrain bytes, their tiles and
// those of the cells around them (roads join, shores and cliffs follow their
// neighbours, water depth looks four cells out), uploaded in chunks of
// CHUNK x CHUNK cells. The work per frame follows the cells that changed,
// not the size of the map.
//
// WebRA's tiles come out exactly as the full tiling of the same terrain
// (js/art/terrain.js cellTiles, with the decal seed of the last full
// upload). Installed tiles (the original graphics, texture packs) show a
// changed cell in its type's most common tile until the commit tiles the map
// again, as js/tiles.js does between plans. Tree terrain is a tree actor in
// the preview: a changed tree cell shows the tree tile until the editor
// rebuilds the preview (`mark` says when that is wanted).

import { DEPTH_STEPS, cellTiles } from '../../js/art/terrain.js';
import { TERRAIN } from './mapformat.js';
import { commonTiles } from './tiles.js';

/** Cells per side of the pieces re-tiled and uploaded. */
export const CHUNK = 16;
/** Ore and gem densities that the engine's terrain bytes scale to 255 (render.rs terrain_bytes). */
export const ORE_MAX = 12;
export const GEM_MAX = 3;
/** Chunk keys: row * CHUNK_KEY + column. */
const CHUNK_KEY = 65536;

/**
 * Engine terrain bytes (RGBA: type, ore and gems scaled to 255, 255) of
 * document cell `i`, into `out` from index `at` (the cell's own place in
 * a map-sized array by default).
 */
export function docCellBytes(doc, i, out, at = i * 4) {
  out[at] = doc.terrain[i];
  out[at + 1] = Math.floor((Math.min(doc.ore[i], ORE_MAX) * 255) / ORE_MAX);
  out[at + 2] = Math.floor((Math.min(doc.gems[i], GEM_MAX) * 255) / GEM_MAX);
  out[at + 3] = 255;
}

export class LiveTerrain {
  constructor() {
    /** The terrain bytes and tile layer on the GPU (map sized, RGBA per cell), patched in place. */
    this.bytes = null;
    this.cells = null;
    this.w = 0;
    this.h = 0;
    this.seed = 0;
    /** Installed tiles: `{ cells, types, common }` of the full tiling; null for WebRA's. */
    this.installed = null;
    /**
     * The document as the engine preview was built from it, with the
     * preview's bytes: `{ terrain, ore, gems, bytes }`. A cell the
     * document still has like that takes the preview's bytes (a tree
     * cell is clear ground under its tree there).
     */
    this.base = null;
    /** Cells whose bytes came from the document, not the preview, since `base` was set. */
    this.since = new Set();
    /** Chunk keys to tile again and to upload. */
    this.retile = new Set();
    this.upload = new Set();
    /** Counts (the tests check the work follows the change): cells tiled again, cells uploaded, chunks uploaded. */
    this.stats = { tiled: 0, uploaded: 0, chunks: 0 };
  }

  /**
   * The full picture was uploaded: `bytes` and `cells` (owned from now on;
   * installed tiles are copied, their plan stays as it is), WebRA's decal
   * `seed`, and whether the tiles are installed ones.
   */
  reset(bytes, cells, w, h, { seed = 0, installed = false } = {}) {
    this.bytes = bytes;
    this.w = w;
    this.h = h;
    this.seed = seed;
    this.cells = installed ? cells.slice() : cells;
    this.installed = installed ? { cells, types: null, common: null } : null;
    this.retile.clear();
    this.upload.clear();
    this.since.clear();
  }

  /** The preview was built from the document as it is now (`bytes`: its terrain bytes, or null without a preview). */
  setBase(doc, bytes) {
    this.base = bytes && bytes.length === doc.width * doc.height * 4 ? { terrain: doc.terrain.slice(), ore: doc.ore.slice(), gems: doc.gems.slice(), bytes } : null;
  }

  /**
   * After `setBase` during an edit: the cells that took the document's
   * bytes since the previous base take the new preview's (`mark`).
   */
  remark(doc) {
    const list = [...this.since];
    this.since.clear();
    return this.mark(doc, list);
  }

  /**
   * Document cells `list` changed: their bytes follow the document (or the
   * preview's, where the document is as the preview has it), and the chunks
   * whose tiles that changes are marked. Returns whether a changed cell
   * needs the preview built again (a tree that comes or goes: the preview
   * makes tree terrain a tree actor).
   */
  mark(doc, list) {
    if (!this.bytes || doc.width !== this.w || doc.height !== this.h) return false;
    const { bytes, w } = this;
    const base = this.base;
    const inst = this.installed;
    if (inst && !inst.types) {
      // The types of the full tiling, before any patch.
      inst.types = new Uint8Array(w * this.h);
      for (let i = 0; i < inst.types.length; i++) inst.types[i] = bytes[i * 4];
    }
    const cell = new Uint8Array(4);
    let wantsPreview = false;
    for (const i of list) {
      if (base && doc.terrain[i] === base.terrain[i] && doc.ore[i] === base.ore[i] && doc.gems[i] === base.gems[i]) {
        cell.set(base.bytes.subarray(i * 4, i * 4 + 4));
      } else {
        docCellBytes(doc, i, cell, 0);
        this.since.add(i);
        if (doc.terrain[i] === TERRAIN.TREE || (base ? base.terrain[i] === TERRAIN.TREE : false)) wantsPreview = true;
      }
      const k = i * 4;
      if (bytes[k] === cell[0] && bytes[k + 1] === cell[1] && bytes[k + 2] === cell[2] && bytes[k + 3] === cell[3]) continue;
      const typeChanged = bytes[k] !== cell[0];
      bytes.set(cell, k);
      const x = i % w;
      const y = (i - x) / w;
      if (!typeChanged) {
        this.upload.add(this.key(x, y));
      } else if (inst) {
        this.installedTile(i);
        this.upload.add(this.key(x, y));
      } else {
        // The tiles up to DEPTH_STEPS away follow this cell (neighbours, shadows, water depth).
        const cx0 = Math.floor(Math.max(0, x - DEPTH_STEPS) / CHUNK);
        const cx1 = Math.floor(Math.min(w - 1, x + DEPTH_STEPS) / CHUNK);
        const cy0 = Math.floor(Math.max(0, y - DEPTH_STEPS) / CHUNK);
        const cy1 = Math.floor(Math.min(this.h - 1, y + DEPTH_STEPS) / CHUNK);
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) this.retile.add(cy * CHUNK_KEY + cx);
      }
    }
    return wantsPreview;
  }

  /** The key of the chunk holding cell (x, y). */
  key(x, y) {
    return Math.floor(y / CHUNK) * CHUNK_KEY + Math.floor(x / CHUNK);
  }

  /** An installed tile for cell `i`: its tile in the full tiling while its type is the same, else its type's most common one. */
  installedTile(i) {
    const inst = this.installed;
    const t = this.bytes[i * 4];
    let k;
    if (t === inst.types[i]) {
      k = inst.cells[i * 4] | (inst.cells[i * 4 + 1] << 8);
    } else {
      inst.common ??= commonTiles(inst.types, inst.cells);
      k = inst.common[t] ?? inst.common.fallback;
    }
    const c = this.cells;
    c[i * 4] = k & 255;
    c[i * 4 + 1] = k >> 8;
    c[i * 4 + 2] = t === inst.types[i] ? inst.cells[i * 4 + 2] : 0;
    c[i * 4 + 3] = t === inst.types[i] ? inst.cells[i * 4 + 3] : 255;
  }

  /** Whether marked chunks wait for `flush`. */
  get pending() {
    return this.retile.size > 0 || this.upload.size > 0;
  }

  /**
   * Tile the marked chunks again and hand each changed chunk to
   * `upload(x, y, w, h)` (cells; `bytes` and `cells` hold the data).
   * Returns how many chunks went up.
   */
  flush(upload) {
    if (!this.pending) return 0;
    const chunks = new Set([...this.retile, ...this.upload]);
    for (const key of this.retile) {
      const area = this.area(key);
      cellTiles(this.bytes, this.w, this.h, this.seed, area, this.cells);
      this.stats.tiled += (area.x1 - area.x0 + 1) * (area.y1 - area.y0 + 1);
    }
    for (const key of chunks) {
      const a = this.area(key);
      const cw = a.x1 - a.x0 + 1;
      const ch = a.y1 - a.y0 + 1;
      upload(a.x0, a.y0, cw, ch);
      this.stats.uploaded += cw * ch;
    }
    this.stats.chunks += chunks.size;
    this.retile.clear();
    this.upload.clear();
    return chunks.size;
  }

  /** The cells of chunk `key`, inclusive and inside the map. */
  area(key) {
    const cx = key % CHUNK_KEY;
    const cy = Math.floor(key / CHUNK_KEY);
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    return { x0, y0, x1: Math.min(this.w - 1, x0 + CHUNK - 1), y1: Math.min(this.h - 1, y0 + CHUNK - 1) };
  }
}

/** An edit in progress rebuilds the engine preview (its actors, spawns and trees) at most this often. */
export const LIVE_PREVIEW_MS = 100;
/** ...and spends at most about 1 / LIVE_PREVIEW_SHARE of the time on it: a slow rebuild spaces the next ones out. */
export const LIVE_PREVIEW_SHARE = 8;

/**
 * When the editor builds the engine preview (js/world.js): at once after a
 * closed transaction (`full`: the checks and the fog follow, `onFull`), and
 * during an edit that changes actors or trees (`want`, then `live` once a
 * frame) at most every `interval` ms. Live rebuilds are for the picture
 * only: the checks wait for the commit.
 */
export class LivePreview {
  constructor({ build, onFull = () => {}, ms = LIVE_PREVIEW_MS, clock = () => performance.now() }) {
    this.build = build;
    this.onFull = onFull;
    this.ms = ms;
    this.clock = clock;
    this.interval = ms;
    this.wanted = false;
    this.at = -Infinity;
  }

  /** The document changed and its transaction closed: build now, the checks follow. */
  full() {
    this.wanted = false;
    this.build();
    this.onFull();
  }

  /** The edit in progress changed what the preview shows. */
  want() {
    this.wanted = true;
  }

  /** A frame of an edit in progress: builds when wanted and due. Returns whether it built. */
  live(now) {
    if (!this.wanted || now - this.at < this.interval) return false;
    this.wanted = false;
    this.at = now;
    const t0 = this.clock();
    this.build();
    this.interval = Math.max(this.ms, (this.clock() - t0) * LIVE_PREVIEW_SHARE);
    return true;
  }
}
