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

/** How long the tile worker may take over a plan before the main thread takes over (ms), for a map of up to TILE_DEADLINE_CELLS cells. */
export const TILE_DEADLINE_MS = 20_000;
/** Cells per TILE_DEADLINE_MS: a bigger map gets that much longer (a 256 x 256 map 80 s). */
export const TILE_DEADLINE_CELLS = 128 * 128;

/** The deadline of a plan job `{ w, h }` in the tile worker (ms). */
export function tileDeadline(job) {
  return TILE_DEADLINE_MS * Math.max(1, ((job.w | 0) * (job.h | 0)) / TILE_DEADLINE_CELLS);
}

/**
 * The tile worker from the main thread's side: `plan(job)` resolves with
 * planTiles' result. The theater goes to the worker once per `key`. Without
 * module workers (or when the worker fails) plans run in this thread.
 *
 * One plan is in the worker at a time; the others wait here, so a request
 * given up meanwhile (`plan(job, { signal })`, the signal aborted) never
 * reaches the worker, and every plan's deadline (tileDeadline) counts from
 * when the worker got it. A worker that does not answer in time is taken as
 * gone: a browser that kills a worker (out of memory) fires no event at all.
 * A plan given up resolves with null.
 */
export class TileWorker {
  constructor({ WorkerClass = globalThis.Worker, url = new URL('./tiles-worker.js', import.meta.url), deadline = tileDeadline, timers = globalThis } = {}) {
    this.WorkerClass = WorkerClass;
    this.url = url;
    this.deadline = deadline;
    this.timers = timers;
    this.worker = null;
    this.sentKey = null;
    this.next = 1;
    /** Plans waiting for the worker: `{ job, resolve, reject, signal }`. */
    this.queue = [];
    /** The plan in the worker: `{ id, job, resolve, reject, signal, timer }`, or null. */
    this.current = null;
    this.broken = !WorkerClass;
  }

  /** `job`: `{ key, tileset, files, bytes, w, h, hints }`; `signal` (an AbortSignal) gives the plan up. */
  plan(job, { signal = null } = {}) {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.broken) return Promise.resolve().then(() => (signal?.aborted ? null : planTiles(job, job.bytes, job.w, job.h, job.hints ?? null)));
    return new Promise((resolve, reject) => {
      const entry = { job, resolve, reject, signal };
      this.queue.push(entry);
      signal?.addEventListener?.('abort', () => this.giveUp(entry), { once: true });
      this.pump();
    });
  }

  /** A plan given up: out of the queue (the worker never sees it), or its answer dropped. */
  giveUp(entry) {
    const k = this.queue.indexOf(entry);
    if (k >= 0) this.queue.splice(k, 1);
    entry.resolve(null);
  }

  /** Hand the next plan that is still wanted to the worker, when it has none. */
  pump() {
    if (this.broken || this.current) return;
    let entry;
    do entry = this.queue.shift();
    while (entry?.signal?.aborted);
    if (!entry) return;
    const { job } = entry;
    try {
      this.start();
      if (this.sentKey !== job.key) {
        this.worker.postMessage({ t: 'theater', key: job.key, tileset: job.tileset, files: [...job.files] });
        this.sentKey = job.key;
      }
      const id = this.next++;
      this.current = { ...entry, id, timer: null };
      this.worker.postMessage({ t: 'plan', id, key: job.key, bytes: job.bytes, w: job.w, h: job.h, hints: job.hints ?? null });
      const ms = this.deadline(job);
      this.current.timer = this.timers.setTimeout(() => this.fail(new Error(`the tile worker did not answer in ${Math.round(ms / 1000)} s`)), ms);
    } catch (err) {
      this.current = null;
      this.queue.unshift(entry);
      this.fail(err);
    }
  }

  start() {
    if (this.worker) return;
    this.worker = new this.WorkerClass(this.url, { type: 'module', name: 'webra-tiles' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      const cur = this.current;
      if (!cur || m?.id !== cur.id) return;
      this.timers.clearTimeout(cur.timer);
      this.current = null;
      if (cur.signal?.aborted) cur.resolve(null);
      else if (m.t === 'planned') cur.resolve(m.result);
      else cur.reject(new Error(m.error));
      this.pump();
    };
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail(new Error(e.message || 'the tile worker failed to load'));
    };
    // An answer that cannot be read here: which plan it was is unknown, so the worker is no use.
    this.worker.onmessageerror = () => this.fail(new Error('a message from the tile worker could not be read'));
  }

  /** The worker is unusable: plan in this thread from now on, the plans in flight and waiting too. */
  fail(err) {
    console.warn('Terrain tiles are planned on the main thread:', err?.message ?? err);
    this.broken = true;
    this.worker?.terminate();
    this.worker = null;
    const cur = this.current;
    if (cur) this.timers.clearTimeout(cur.timer);
    const waiting = [...(cur ? [cur] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    for (const w of waiting) this.plan(w.job, { signal: w.signal }).then(w.resolve, w.reject);
  }

  dispose() {
    if (this.current) this.timers.clearTimeout(this.current.timer);
    this.worker?.terminate();
    this.worker = null;
    this.sentKey = null;
    // Nobody hears from the worker any more: the plans it had or would have get null.
    const waiting = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    for (const w of waiting) w.resolve(null);
  }
}

/**
 * The share of a map's cells that may show stand-in tiles (their type's
 * most common one) while a plan runs before the editor says it is busy
 * laying tiles: a map opened, resized or turned to another biome.
 */
export const STAND_IN_SHARE = 0.25;

/** How long a plan waits before it starts (ms): changes that come in meanwhile join it. */
export const PLAN_DELAY_MS = 40;

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
  /**
   * `defer(fn)` runs a plan's start a moment later (PLAN_DELAY_MS): what
   * changes together in consecutive frames (a tree stroke's terrain types,
   * then its preview's terrain hints) is planned once, with the newest.
   */
  constructor({ plan, ready = () => {}, defer = (fn) => setTimeout(fn, PLAN_DELAY_MS) }) {
    this.plan = plan;
    this.ready = ready;
    this.defer = defer;
    /** The plan about to start (the newest request while `defer` waits), or null. */
    this.queued = null;
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
    if (!same && this.queued) {
      // Not started yet: it plans the newest.
      Object.assign(this.queued, { theater, bytes: bytes.slice(), types, w, h, hints, hintsKey });
    } else if (!same && !this.busy) {
      this.busy = true;
      this.queued = { theater, bytes: bytes.slice(), types, w, h, hints, hintsKey };
      this.defer(() => {
        const q = this.queued;
        this.queued = null;
        this.start(q.theater, q.bytes, q.types, q.w, q.h, q.hints, q.hintsKey);
      });
    }
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
    this.plan({ key, tileset: theater.tileset, files: theater.files, bytes, w, h, hints })
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
