// The original graphics' tiles of a game and the map lens are planned off
// the main thread (js/terraintiles.js): in the tile worker the map editor
// uses (editor/js/tiles.js TileWorker), or on the main thread when no worker
// can start; the same tiles either way. Synthetic theater, no EA files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { mapTerrain, startWait, START_TILES_WAIT_MS } from '../js/terraintiles.js';
import { TileWorker, planTiles, InstalledTiles, tileDeadline, TILE_DEADLINE_MS } from '../editor/js/tiles.js';
import { theaterFiles } from '../js/content/terrain.js';
import { syntheticTheater } from './content-fixtures.mjs';

const synthetic = syntheticTheater();
const THEATER = { key: 'k', tileset: 'TEMPERAT', files: new Map(theaterFiles('TEMPERAT').filter((n) => synthetic.has(n)).map((n) => [n, synthetic.get(n)])) };

/** Terrain bytes: land with a lake, a road across. */
function bytesOf(w, h) {
  const b = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    b[i * 4] = Math.hypot(x - w / 2, y - h / 2) < 5 ? 3 : y === 3 ? 6 : 0;
    b[i * 4 + 3] = 255;
  }
  return b;
}

/** A content system's terrain parts: the original graphics in use (`job`), a texture pack (`pack`) or neither. */
function fakeContent({ pack = null, original = true } = {}) {
  return {
    packTerrain: () => pack,
    terrainJob: (biome, terrain, w, h, hints) => (original ? { ...THEATER, bytes: terrain, w, h, hints } : null),
  };
}

test('mapTerrain: a texture pack tiles at once, the original graphics go to the planner, WebRA tiles otherwise', async () => {
  const bytes = bytesOf(24, 16);
  const packTiles = { atlas: {}, cells: new Uint8Array(4), source: 'pack' };
  const fromPack = mapTerrain(fakeContent({ pack: packTiles }), 'temperate', bytes, 24, 16, null, () => assert.fail('no plan for a pack'));
  assert.equal(fromPack.tiles, packTiles);
  assert.equal(fromPack.plan, null);
  const none = mapTerrain(fakeContent({ original: false }), 'temperate', bytes, 24, 16, null, () => assert.fail('no plan without the original graphics'));
  assert.deepEqual(none, { tiles: null, plan: null });
  const jobs = [];
  const hints = { bridges: [], standing: [5] };
  const r = mapTerrain(fakeContent(), 'temperate', bytes, 24, 16, hints, (job) => (jobs.push(job), planTiles(job, job.bytes, job.w, job.h, job.hints)));
  assert.equal(r.tiles, null, 'WebRA tiles stand in meanwhile');
  assert.equal(jobs.length, 0, 'the plan starts after the call returns');
  const planned = await r.plan;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].hints, hints);
  assert.equal(planned.source, 'original');
  assert.deepEqual(planned.cells, planTiles(THEATER, bytes, 24, 16, hints).cells);
});

test('the tile worker plans the same tiles as the main thread; without a worker it plans on the main thread', async () => {
  const bytes = bytesOf(30, 20);
  const here = planTiles(THEATER, bytes, 30, 20);
  class NodeTileWorker {
    constructor() {
      this.thread = new ThreadWorker(new URL('./tiles-worker-boot.mjs', import.meta.url));
      this.thread.on('message', (data) => this.onmessage?.({ data }));
      this.thread.on('error', (err) => this.onerror?.({ message: err.message }));
    }
    postMessage(msg, transfer) {
      this.thread.postMessage(msg, transfer);
    }
    terminate() {
      return this.thread.terminate();
    }
  }
  const worker = new TileWorker({ WorkerClass: NodeTileWorker });
  try {
    const r = await mapTerrain(fakeContent(), 'temperate', bytes, 30, 20, null, (job) => worker.plan(job)).plan;
    assert.equal(worker.broken, false, 'planned in the worker');
    assert.deepEqual(r.cells, here.cells);
    assert.deepEqual(r.atlas.data, here.atlas.data);
  } finally {
    worker.dispose();
  }
  // A worker that cannot start, or none at all: the main thread plans.
  const warn = console.warn;
  console.warn = () => {};
  try {
    const failing = new TileWorker({
      WorkerClass: class {
        constructor() {
          throw new Error('no workers here');
        }
      },
    });
    assert.deepEqual((await failing.plan({ ...THEATER, bytes, w: 30, h: 20 })).cells, here.cells);
    assert.equal(failing.broken, true);
    const none = new TileWorker({ WorkerClass: null });
    assert.deepEqual((await none.plan({ ...THEATER, bytes, w: 30, h: 20 })).cells, here.cells);
  } finally {
    console.warn = warn;
  }
});

test('the game plans its terrain in the tile worker and the loading screen waits for it, for a while', () => {
  const main = readFileSync(fileURLToPath(new URL('../js/main.js', import.meta.url)), 'utf8');
  assert.ok(!/content\??\.terrain\(/.test(main), 'no tile plan on the main thread');
  assert.match(main, /mapTerrain\(content, biome, terrainTypes/);
  assert.match(main, /new LensArt\(\{[^}]*planner: planInWorker/);
  assert.match(main, /!firstFrame\.drawn && terrainReady/, 'the first frame (the end of the loading screen) waits for the plan');
  assert.match(main, /terrainStart = startWait\(plan\)/, 'for up to START_TILES_WAIT_MS');
  // A plan (or the end of the wait) after the game was taken down changes nothing.
  assert.match(main, /if \(stopped \|\| round !== terrainRound \|\| !planned\) return;/);
  assert.match(main, /terrainStart\.then\(\(\) => \{\s*if \(!stopped\) loader\.step\('frame'\);/);
  const declared = main.indexOf('let stopped = false;');
  assert.ok(declared > 0 && declared < main.indexOf('const applyTerrain = '), 'stopped exists before the first plan can come in');
  assert.equal(main.split('let stopped').length, 2, 'one stopped flag');
  // One tile worker per page: the editor's map tiles and its map lens share it.
  const editor = readFileSync(fileURLToPath(new URL('../editor/editor.js', import.meta.url)), 'utf8');
  assert.match(editor, /new LensArt\(\{[^}]*planner: planInWorker/);
  assert.match(editor, /new InstalledTiles\(\{ plan: \(job\) => planInWorker\(job\)/);
  assert.ok(!/new TileWorker\(/.test(editor), 'no second tile worker');
});

/** Timers the test runs by hand: `run(ms)` fires what is due by then. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map();
  return {
    setTimeout: (fn, ms) => (due.set(next, { fn, at: now + ms }), next++),
    clearTimeout: (id) => due.delete(id),
    pending: () => due.size,
    run(ms) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        due.delete(id);
        t.fn();
      }
    },
  };
}

/** A worker that takes every message and answers none (a browser killed it: no error event either); `answer` replies by hand. */
function silentWorker() {
  const made = [];
  class Silent {
    constructor() {
      this.posted = [];
      this.terminated = false;
      made.push(this);
    }
    postMessage(msg) {
      this.posted.push(msg);
    }
    terminate() {
      this.terminated = true;
    }
    plans() {
      return this.posted.filter((m) => m.t === 'plan');
    }
    answer(m, result) {
      this.onmessage?.({ data: { t: 'planned', id: m.id, result } });
    }
  }
  return { Silent, made };
}

const quiet = async (fn) => {
  const warn = console.warn;
  const said = [];
  console.warn = (...a) => said.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return said;
};

test('a tile worker that never answers: after its deadline the main thread plans, the plans in flight and waiting too', async () => {
  assert.equal(tileDeadline({ w: 64, h: 64 }), TILE_DEADLINE_MS, 'about 20 s');
  assert.equal(tileDeadline({ w: 128, h: 128 }), TILE_DEADLINE_MS);
  assert.equal(tileDeadline({ w: 256, h: 256 }), 4 * TILE_DEADLINE_MS, 'scaled by map size');
  const bytes = bytesOf(30, 20);
  const here = planTiles(THEATER, bytes, 30, 20);
  const timers = fakeTimers();
  const { Silent, made } = silentWorker();
  const worker = new TileWorker({ WorkerClass: Silent, timers });
  const said = await quiet(async () => {
    const first = worker.plan({ ...THEATER, bytes, w: 30, h: 20 });
    const second = worker.plan({ ...THEATER, bytes, w: 30, h: 20 });
    let settled = 0;
    first.then(() => settled++);
    second.then(() => settled++);
    assert.equal(made[0].plans().length, 1, 'one plan in the worker at a time');
    timers.run(TILE_DEADLINE_MS - 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, 0, 'still waiting before the deadline');
    assert.equal(worker.broken, false);
    timers.run(1);
    assert.equal(worker.broken, true, 'given up on the worker');
    assert.equal(made[0].terminated, true);
    assert.deepEqual((await first).cells, here.cells, 'the plan in flight, on the main thread');
    assert.deepEqual((await second).cells, here.cells, 'and the one waiting');
    assert.equal(made[0].plans().length, 1, 'the waiting one never went to the dead worker');
    assert.equal(timers.pending(), 0, 'no deadline left behind');
    // From now on the main thread plans.
    assert.deepEqual((await worker.plan({ ...THEATER, bytes, w: 30, h: 20 })).cells, here.cells);
    assert.equal(made.length, 1, 'no new worker');
  });
  assert.ok(said.some((s) => /did not answer in 20 s/.test(s)), said.join('\n'));
});

test('the tile worker: an answer in time clears its deadline; a message that cannot be read hands the plans to the main thread', async () => {
  const bytes = bytesOf(30, 20);
  const here = planTiles(THEATER, bytes, 30, 20);
  const timers = fakeTimers();
  const { Silent, made } = silentWorker();
  const worker = new TileWorker({ WorkerClass: Silent, timers });
  const first = worker.plan({ ...THEATER, bytes, w: 30, h: 20 });
  const second = worker.plan({ ...THEATER, bytes, w: 30, h: 20 });
  const w = made[0];
  assert.deepEqual(w.posted.map((m) => m.t), ['theater', 'plan'], 'the theater once, then the plan');
  w.answer(w.plans()[0], here);
  assert.equal(await first, here);
  assert.equal(w.plans().length, 2, 'the next plan goes once the first is in');
  assert.equal(timers.pending(), 1, 'only the second plan\'s deadline');
  assert.equal(w.posted.filter((m) => m.t === 'theater').length, 1, 'same theater: not sent again');
  await quiet(async () => {
    w.onmessageerror({});
    assert.equal(worker.broken, true);
    assert.deepEqual((await second).cells, here.cells);
  });
  assert.equal(timers.pending(), 0);
});

test('the tile worker: a plan given up never reaches the worker, or its answer is dropped', async () => {
  const bytes = bytesOf(30, 20);
  const here = planTiles(THEATER, bytes, 30, 20);
  const timers = fakeTimers();
  const { Silent, made } = silentWorker();
  const worker = new TileWorker({ WorkerClass: Silent, timers });
  const a = new AbortController();
  const b = new AbortController();
  const inFlight = worker.plan({ ...THEATER, bytes, w: 30, h: 20 }, { signal: a.signal });
  const queued = worker.plan({ ...THEATER, bytes, w: 30, h: 20 }, { signal: b.signal });
  const kept = worker.plan({ ...THEATER, bytes, w: 30, h: 20 });
  const w = made[0];
  b.abort();
  assert.equal(await queued, null, 'a waiting plan given up resolves with null at once');
  a.abort();
  assert.equal(await inFlight, null, 'so does the one in the worker');
  assert.equal(w.plans().length, 1, 'the worker is still on it');
  w.answer(w.plans()[0], here);
  assert.equal(w.plans().length, 2, 'then the one still wanted goes, the given-up one is skipped');
  w.answer(w.plans()[1], here);
  assert.equal(await kept, here);
  // Given up before it was asked: nothing is planned.
  const gone = new AbortController();
  gone.abort();
  assert.equal(await worker.plan({ ...THEATER, bytes, w: 30, h: 20 }, { signal: gone.signal }), null);
  assert.equal(w.plans().length, 2);
  // mapTerrain hands the signal on.
  const seen = [];
  const c = new AbortController();
  await mapTerrain(fakeContent(), 'temperate', bytes, 30, 20, null, (job, opts) => (seen.push(opts.signal), null), { signal: c.signal }).plan;
  assert.equal(seen[0], c.signal);
});

test('the start waits for the tile plan for START_TILES_WAIT_MS at most, then goes on without it', async () => {
  assert.equal(START_TILES_WAIT_MS, 10_000);
  const timers = fakeTimers();
  let late = null;
  startWait(new Promise(() => {}), START_TILES_WAIT_MS, timers).then((v) => (late = v));
  timers.run(START_TILES_WAIT_MS - 1);
  await Promise.resolve();
  assert.equal(late, null, 'still waiting');
  timers.run(1);
  await Promise.resolve();
  assert.equal(late, false, 'the game starts without the plan');
  // A plan in time (or one that failed): the start goes on at once, its timer cleared.
  assert.equal(await startWait(Promise.resolve({}), START_TILES_WAIT_MS, timers), true);
  assert.equal(await startWait(Promise.reject(new Error('x')), START_TILES_WAIT_MS, timers), true);
  assert.equal(timers.pending(), 0);
});

test('the editor plans once for changes that come in together (a tree stroke: its types, then its hints)', async () => {
  const deferred = [];
  const jobs = [];
  const tiles = new InstalledTiles({ plan: async (job) => (jobs.push(job), planTiles(job, job.bytes, job.w, job.h, job.hints)), defer: (fn) => deferred.push(fn) });
  const bytes = bytesOf(20, 12);
  tiles.tiles(THEATER, bytes, 20, 12, { bridges: [], standing: [] });
  const stroke = bytes.slice();
  stroke[(6 * 20 + 2) * 4] = 0;
  stroke[(6 * 20 + 3) * 4] = 0;
  tiles.tiles(THEATER, stroke, 20, 12, { bridges: [], standing: [] });
  const hints = { bridges: [], standing: [6 * 20 + 2] };
  tiles.tiles(THEATER, stroke, 20, 12, hints);
  assert.equal(deferred.length, 1, 'one plan queued');
  assert.ok(tiles.busy);
  deferred.shift()();
  await tiles.idle();
  assert.equal(jobs.length, 1, 'planned once');
  assert.equal(jobs[0].hints, hints, 'with the newest hints');
  assert.deepEqual([...tiles.tiles(THEATER, stroke, 20, 12, hints).cells], [...planTiles(THEATER, stroke, 20, 12, hints).cells]);
  assert.equal(deferred.length, 0, 'nothing more to plan');
});
