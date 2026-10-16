// The terrain tiles of a map for a game and the map lens, without holding up
// the main thread: a texture pack tiles cell by cell at once
// (js/content/index.js packTerrain), but the original graphics' tiles are
// planned (js/content/terrain.js originalTerrain: roads, beaches, bridges
// fitted cell by cell, a fraction of a second to over a second on a big
// map), so that plan runs in the tile worker the map editor uses
// (editor/js/tiles.js TileWorker, editor/js/tiles-worker.js), which plans on
// the main thread itself when no worker can start. The plan is a function
// of the map and the files only: the same tiles in a worker or not.

import { TileWorker } from '../editor/js/tiles.js';

let worker = null;

/** Plan a tile job (ContentSystem.terrainJob) in the page's shared tile worker: a promise of originalTerrain's result or null. */
export function planInWorker(job) {
  worker ??= new TileWorker();
  return worker.plan(job);
}

/** Let the shared worker go (tests). */
export function disposeTileWorker() {
  worker?.dispose();
  worker = null;
}

/**
 * The tiles of a map's terrain bytes: `{ tiles, plan }`. `tiles` is what to
 * draw now: a texture pack's `{ atlas, cells, source }`, or null for
 * WebRA's own tiles. `plan` is a promise of the original graphics' tiles
 * (`{ atlas, cells, report, source: 'original' }`, or null when the theater
 * cannot tile the map), planned by `planner(job)`, or null when there is
 * none to plan. `hints` are the engine's terrain hints (or null).
 */
export function mapTerrain(content, biome, terrain, w, h, hints = null, planner = planInWorker) {
  const pack = content?.packTerrain?.(biome, terrain, w, h) ?? null;
  if (pack) return { tiles: pack, plan: null };
  const job = content?.terrainJob?.(biome, terrain, w, h, hints) ?? null;
  if (!job) return { tiles: null, plan: null };
  const plan = Promise.resolve()
    .then(() => planner(job))
    .then((r) => (r ? { ...r, source: 'original' } : null));
  return { tiles: null, plan };
}
