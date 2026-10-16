// The original graphics' tiles of a game and the map lens are planned off
// the main thread (js/terraintiles.js): in the tile worker the map editor
// uses (editor/js/tiles.js TileWorker), or on the main thread when no worker
// can start; the same tiles either way. Synthetic theater, no EA files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { mapTerrain } from '../js/terraintiles.js';
import { TileWorker, planTiles, InstalledTiles } from '../editor/js/tiles.js';
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

test('the game plans its terrain in the tile worker and the loading screen waits for it', () => {
  const main = readFileSync(fileURLToPath(new URL('../js/main.js', import.meta.url)), 'utf8');
  assert.ok(!/content\??\.terrain\(/.test(main), 'no tile plan on the main thread');
  assert.match(main, /mapTerrain\(content, biome, terrainTypes/);
  assert.match(main, /new LensArt\(\{[^}]*planner: planInWorker/);
  assert.match(main, /!firstFrame\.drawn && terrainReady/, 'the first frame (the end of the loading screen) waits for the plan');
  assert.match(main, /terrainPlan\.then\(\(\) => loader\.step\('frame'\)\)/);
  const editor = readFileSync(fileURLToPath(new URL('../editor/editor.js', import.meta.url)), 'utf8');
  assert.match(editor, /new LensArt\(\{[^}]*planner: planInWorker/);
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
