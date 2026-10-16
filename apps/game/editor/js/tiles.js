// Installed terrain tiles for the map being edited, kept up to date without
// stalling the editor.
//
// The original graphics pick a tile for every cell from its neighbourhood
// (coasts, cliffs, whole templates: js/content/terrain.js originalTerrain),
// which takes from a fraction of a second to seconds on a big map. The
// editor plans them in a worker (tiles-worker.js) whenever the terrain
// types change and draws the last plan meanwhile: cells whose terrain type
// changed since that plan show the tile most cells of their new type have
// in it, until the next plan comes in. The terrain hints (bridges and the
// cells structures and trees stand on, from the engine preview) are part of
// the plan: when they change the map is planned again. The finished picture
// is exactly the one a game on the map draws. Texture packs tile cell by cell and stay on
// the main thread (js/content/index.js packTerrain).

import { originalTerrain } from '../../js/content/terrain.js';

/** Plan the tiles of engine terrain bytes (and terrain hints, or null) in the theater `{ tileset, files }` (here, in this thread). */
export function planTiles(theater, bytes, w, h, hints = null) {
  return originalTerrain((name) => theater.files.get(name) ?? null, theater.tileset, bytes, w, h, hints);
}

/**
 * The tile worker from the main thread's side: `plan(job)` resolves with
 * planTiles' result. The theater goes to the worker once per `key`. Without
 * module workers (or when the worker fails) plans run in this thread.
 */
export class TileWorker {
  constructor({ WorkerClass = globalThis.Worker, url = new URL('./tiles-worker.js', import.meta.url) } = {}) {
    this.WorkerClass = WorkerClass;
    this.url = url;
    this.worker = null;
    this.sentKey = null;
    this.next = 1;
    this.waiting = new Map();
    this.broken = !WorkerClass;
  }

  /** `job`: `{ key, tileset, files, bytes, w, h, hints }`. */
  plan(job) {
    if (this.broken) return Promise.resolve().then(() => planTiles(job, job.bytes, job.w, job.h, job.hints ?? null));
    try {
      this.start();
      if (this.sentKey !== job.key) {
        this.worker.postMessage({ t: 'theater', key: job.key, tileset: job.tileset, files: [...job.files] });
        this.sentKey = job.key;
      }
    } catch (err) {
      this.fail(err);
      return this.plan(job);
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, job });
      this.worker.postMessage({ t: 'plan', id, key: job.key, bytes: job.bytes, w: job.w, h: job.h, hints: job.hints ?? null });
    });
  }

  start() {
    if (this.worker) return;
    this.worker = new this.WorkerClass(this.url, { type: 'module', name: 'webra-tiles' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      const w = this.waiting.get(m?.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.t === 'planned') w.resolve(m.result);
      else w.reject(new Error(m.error));
    };
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail(new Error(e.message || 'the tile worker failed to load'));
    };
  }

  /** The worker is unusable: plan in this thread from now on, the plans in flight too. */
  fail(err) {
    console.warn('Terrain tiles are planned on the main thread:', err?.message ?? err);
    this.broken = true;
    this.worker?.terminate();
    this.worker = null;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of waiting) this.plan(w.job).then(w.resolve, w.reject);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.sentKey = null;
  }
}

/**
 * The share of a map's cells that may show stand-in tiles (their type's
 * most common one) while a plan runs before the editor says it is busy
 * laying tiles: a map opened, resized or turned to another biome.
 */
export const STAND_IN_SHARE = 0.25;

/** The terrain type (R) of every cell of engine terrain bytes. */
function typesOf(bytes) {
  const out = new Uint8Array(bytes.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = bytes[i * 4];
  return out;
}

/**
 * The planned tiles of a map, current or a step behind. `plan(job)` plans
 * (TileWorker.plan, or planTiles for tests); `ready()` is called when a plan
 * comes in, so the editor uploads the tiles again.
 */
export class InstalledTiles {
  constructor({ plan, ready = () => {} }) {
    this.plan = plan;
    this.ready = ready;
    this.key = null;
    /** The last plan: `{ types, hints, w, h, atlas, cells, common }` (`atlas` null when the theater cannot tile; `hints` the JSON of its terrain hints). */
    this.done = null;
    this.busy = false;
    this.plans = 0;
    /**
     * Whether the tiles last handed out stand in for most of the map
     * (none planned for it yet, or more than STAND_IN_SHARE of its cells
     * changed type since the plan) while the next plan runs.
     */
    this.standIn = false;
    /** Resolved when no plan runs (`idle`). */
    this.waiters = [];
  }

  /** Resolves once no plan runs (at once when none does). */
  idle() {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /**
   * Tiles for engine terrain `bytes` (`w` x `h`) in `theater` (`{ key,
   * tileset, files }`; a new key drops what was planned for another) with
   * the engine's terrain `hints` (or null):
   * `{ atlas, cells }` from the last plan, with the cells whose type changed
   * since shown in their type's most common tile; `null` while no plan is
   * ready or when the theater cannot tile this map (WebRA's tiles then).
   * Starts a plan when the types or the hints differ from the last one and
   * none is running.
   */
  tiles(theater, bytes, w, h, hints = null) {
    if (theater.key !== this.key) {
      this.key = theater.key;
      this.done = null;
    }
    const types = typesOf(bytes);
    const hintsKey = JSON.stringify(hints);
    const done = this.done;
    const sameTypes = done && done.w === w && done.h === h && done.types.every((t, i) => t === types[i]);
    const same = sameTypes && done.hints === hintsKey;
    if (!same && !this.busy) this.start(theater, bytes, types, w, h, hints, hintsKey);
    if (!done || done.w !== w || done.h !== h || !done.atlas) {
      this.standIn = this.busy;
      return null;
    }
    if (sameTypes) {
      // The same types (other hints planning): the last plan's tiles as they are.
      this.standIn = false;
      return { atlas: done.atlas, cells: done.cells };
    }
    const cells = done.cells.slice();
    let changed = 0;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === done.types[i]) continue;
      changed++;
      const k = done.common[types[i]] ?? done.common.fallback;
      cells[i * 4] = k & 255;
      cells[i * 4 + 1] = k >> 8;
      cells[i * 4 + 2] = 0;
      cells[i * 4 + 3] = 255;
    }
    this.standIn = this.busy && changed > types.length * STAND_IN_SHARE;
    return { atlas: done.atlas, cells };
  }

  start(theater, bytes, types, w, h, hints = null, hintsKey = JSON.stringify(hints)) {
    this.busy = true;
    const key = theater.key;
    this.plans++;
    this.plan({ key, tileset: theater.tileset, files: theater.files, bytes: bytes.slice(), w, h, hints })
      .catch((err) => {
        console.warn('Planning terrain tiles failed:', err);
        return null;
      })
      .then((result) => {
        this.busy = false;
        if (key === this.key) {
          this.done = result
            ? { types, hints: hintsKey, w, h, atlas: result.atlas, cells: result.cells, common: commonTiles(types, result.cells) }
            : { types, hints: hintsKey, w, h, atlas: null };
        }
        this.ready();
        for (const resolve of this.waiters.splice(0)) resolve();
      });
  }
}

/**
 * Per terrain type, the tile most of its cells have in a plan (`fallback`:
 * the most common tile of all), for cells changed since that plan.
 */
export function commonTiles(types, cells) {
  const counts = new Map();
  for (let i = 0; i < types.length; i++) {
    const k = cells[i * 4] | (cells[i * 4 + 1] << 8);
    const key = types[i] * 65536 + k;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const best = {};
  const bestCount = {};
  const total = new Map();
  for (const [key, n] of counts) {
    const t = Math.floor(key / 65536);
    const k = key % 65536;
    if (!(n <= (bestCount[t] ?? 0))) {
      best[t] = k;
      bestCount[t] = n;
    }
    total.set(k, (total.get(k) ?? 0) + n);
  }
  let fallback = 0;
  let most = 0;
  for (const [k, n] of total) {
    if (n > most) {
      most = n;
      fallback = k;
    }
  }
  return { ...best, fallback };
}
