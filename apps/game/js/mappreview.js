// Previews of generated maps for the lobbies: the preview image and the start
// positions of a seed, size, player count, style and biome. Generating a map
// took the main thread 40 to 170 ms per change (the full map file with its
// actors, built only to read the spawns), which froze New seed. Now:
//
// - the spawns come from Game.map_spawns_styled (the map alone, no actors and
//   no map file), and the preview and the spawns are made in a worker
//   (js/mappreview-worker.js) with the engine module the page compiled, so
//   the main thread only draws the result;
// - without workers (or when the worker fails to load) the same work runs on
//   the main thread after a timeout, so the loading state paints first;
// - latest wins: one generation runs at a time; a newer request replaces the
//   one waiting (which never starts and rejects with StalePreview), and the
//   result of a running one that was overtaken is kept in the cache but its
//   request rejects with StalePreview too;
// - results are cached (the last few), so going back to a seed is instant.

/** A request was overtaken by a newer one (latest wins). */
export class StalePreview extends Error {
  constructor() {
    super('a newer map preview was requested');
    this.name = 'StalePreview';
  }
}

/** The cache key of a request. */
export function previewKey(r) {
  return `${r.seed}/${r.size}/${r.players}/${r.style}/${r.biome}`;
}

/** Preview and spawns of request `r` with the engine on this thread (pairs of [x, y]). */
export function computePreview(Game, r) {
  const rgba = Game.map_preview_styled(r.seed, r.size, r.players, r.style, r.biome);
  return { rgba, spawns: Array.from(Game.map_spawns_styled(r.seed, r.size, r.players, r.style)) };
}

function pairs(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject }));
  // A stale request nobody waits for must not report an unhandled rejection.
  d.promise.catch(() => {});
  return d;
}

/**
 * The backend: generate in a worker with the page's engine `module`, or on
 * this thread (after a timeout) with `Game` when there is no worker or it
 * fails. Returns `(request) => Promise<{ rgba, spawns: number[] (flat) }>`.
 */
export function previewBackend({ Game, module = null, WorkerClass = globalThis.Worker, url = new URL('./mappreview-worker.js', import.meta.url), timeoutMs = 10_000 }) {
  const local = (r) =>
    new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(computePreview(Game, r));
        } catch (err) {
          reject(err);
        }
      }, 0),
    );
  if (!WorkerClass || !module) return local;
  let worker = null;
  let starting = null;
  let failed = false;
  let next = 0;
  const waiting = new Map();
  const fail = (err) => {
    failed = true;
    console.warn('Map preview worker unavailable, previews are made on the page:', err?.message ?? err);
    worker?.terminate?.();
    worker = null;
    // Whatever was asked of the worker is made here instead.
    for (const [, w] of waiting) local(w.r).then(w.resolve, w.reject);
    waiting.clear();
  };
  const start = () =>
    (starting ??= new Promise((resolve, reject) => {
      try {
        worker = new WorkerClass(url, { type: 'module', name: 'webra-map-preview' });
      } catch (err) {
        reject(err);
        return;
      }
      const timer = setTimeout(() => reject(new Error('the preview worker did not load the engine in time')), timeoutMs);
      worker.onmessage = ({ data }) => {
        if (data?.t === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (data?.t === 'failed') {
          clearTimeout(timer);
          reject(new Error(data.error));
        } else if (data?.t === 'done' || data?.t === 'error') {
          const w = waiting.get(data.id);
          if (!w) return;
          waiting.delete(data.id);
          if (data.t === 'done') w.resolve({ rgba: data.rgba, spawns: data.spawns });
          else w.reject(new Error(data.error));
        }
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        clearTimeout(timer);
        if (failed) return;
        const err = new Error(e.message || 'the preview worker failed');
        reject(err);
        fail(err);
      };
      worker.postMessage({ t: 'init', module });
    }));
  return async (r) => {
    if (failed) return local(r);
    try {
      await start();
    } catch (err) {
      if (!failed) fail(err);
      return local(r);
    }
    if (failed) return local(r);
    const id = ++next;
    return new Promise((resolve, reject) => {
      waiting.set(id, { r, resolve, reject });
      worker.postMessage({ t: 'gen', id, ...r });
    });
  };
}

export class GeneratedPreviews {
  /** @param {{ backend: (r: object) => Promise<{ rgba: Uint8Array, spawns: number[] }>, limit?: number }} o */
  constructor({ backend, limit = 6 }) {
    this.backend = backend;
    this.limit = limit;
    this.cache = new Map();
    this.running = null;
    this.waiting = null;
    this.latest = null;
  }

  /** The cached preview of `r` ({ rgba, spawns: [[x, y], ...] }), or null. */
  get(r) {
    const key = previewKey(r);
    const hit = this.cache.get(key);
    if (!hit) return null;
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  /** Whether a generation runs or waits. */
  get busy() {
    return !!(this.running || this.waiting);
  }

  /**
   * The preview of `r`: at once when cached, else generated. Latest wins: an
   * older request still waiting or running rejects with StalePreview.
   */
  request(r) {
    const key = previewKey(r);
    this.latest = key;
    const hit = this.get(r);
    if (hit) {
      // Whatever waits is stale now.
      this.waiting?.reject(new StalePreview());
      this.waiting = null;
      return Promise.resolve(hit);
    }
    if (this.running?.key === key) return this.running.promise;
    if (this.waiting?.key === key) return this.waiting.promise;
    this.waiting?.reject(new StalePreview());
    const job = Object.assign(deferred(), { key, r });
    if (this.running) this.waiting = job;
    else this.run(job);
    return job.promise;
  }

  run(job) {
    this.running = job;
    Promise.resolve()
      .then(() => this.backend(job.r))
      .then(
        (res) => {
          const value = { rgba: res.rgba, spawns: pairs(res.spawns) };
          this.cache.set(job.key, value);
          while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
          if (this.latest === job.key) job.resolve(value);
          else job.reject(new StalePreview());
        },
        (err) => job.reject(err),
      )
      .finally(() => {
        this.running = null;
        const next = this.waiting;
        this.waiting = null;
        if (next) this.run(next);
      });
  }
}
