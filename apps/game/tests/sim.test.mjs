// The simulation worker boundary (js/sim): mode selection, the shared frame
// double buffer (seqlock), the query cache and actor table, and games run
// through the boundary (in Node's worker_threads, like a browser worker)
// against the engine driven directly: same state hashes, orders and queries
// arrive, online lockstep, replays and saves work. Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { initSync, Game, version } from '../pkg/webra_sim.js';
import { chooseSimMode } from '../js/sim/modes.js';
import { BufferPool, capacityFor, SharedFrames } from '../js/sim/framebuffer.js';
import { createSimHost, DirectHost } from '../js/sim/host.js';
import { DriverHandle, EXPIRE_MS, LIVE_MS, QueryCache, ReplayHandle } from '../js/sim/proxy.js';
import { actorInfo, COMPOSITES, NONE, queryKey, tableInfo } from '../js/sim/methods.js';
import { LocalDriver, Recorder, ReplayController } from '../js/replay.js';
import { LockstepDriver } from '../js/net.js';
import { parseReplay, replayOptions, REPLAY_HASH_INTERVAL } from '../js/protocol.js';
import { RECT_REC_FLOATS, SPRITE_EXTRA_FLOATS, SPRITE_REC_FLOATS } from '../js/crowd.js';
import { NodeWorker, nodeEnv, scriptedOrders, SKIRMISH, until, WASM_PATH, wasmModule } from './sim-fixtures.mjs';

const wasm = initSync({ module: readFileSync(WASM_PATH) });
const OPTIONS = replayOptions(SKIRMISH);
const TICK_MS = 40;
const units = (game, p) => Array.from(game.select_box(p, -1e9, -1e9, 1e9, 1e9));

// ---- Mode selection --------------------------------------------------------------------

test('the mode falls back from shared memory to transferred buffers to the main thread', () => {
  const env = (o) => ({ worker: true, moduleWorker: true, sharedMemory: true, isolated: true, requested: null, ...o });
  assert.equal(chooseSimMode(env({})).mode, 'shared');
  assert.equal(chooseSimMode(env({ isolated: false })).mode, 'transfer', 'no COOP/COEP: no SharedArrayBuffer for workers');
  assert.match(chooseSimMode(env({ isolated: false })).reason, /not cross-origin isolated/);
  assert.equal(chooseSimMode(env({ sharedMemory: false })).mode, 'transfer');
  assert.equal(chooseSimMode(env({ moduleWorker: false })).mode, 'direct');
  assert.equal(chooseSimMode(env({ worker: false })).mode, 'direct');
  // Asked for in the URL: honoured when possible, else the next one down.
  assert.equal(chooseSimMode(env({ requested: 'direct' })).mode, 'direct');
  assert.equal(chooseSimMode(env({ requested: 'transfer' })).mode, 'transfer');
  assert.equal(chooseSimMode(env({ requested: 'shared', isolated: false })).mode, 'transfer');
  assert.equal(chooseSimMode(env({ requested: 'bogus', isolated: false })).mode, 'transfer');
});

test('a worker that cannot start leaves the game on the main thread', async () => {
  class BrokenWorker {
    constructor() {
      setTimeout(() => this.onerror?.({ message: 'blocked by CSP', preventDefault() {} }), 1);
    }

    postMessage() {}

    terminate() {}
  }
  const host = await createSimHost({ Game, memory: () => wasm.memory, module: null, env: nodeEnv(null), WorkerClass: BrokenWorker });
  assert.ok(host instanceof DirectHost);
  assert.match(host.reason, /worker failed \(blocked by CSP\)/);
  class SilentWorker {
    postMessage() {}

    terminate() {}
  }
  const slow = await createSimHost({ Game, memory: () => wasm.memory, env: nodeEnv(null), WorkerClass: SilentWorker, timeoutMs: 20 });
  assert.equal(slow.mode, 'direct');
  assert.match(slow.reason, /in time/);
});

// ---- Shared frames (seqlock double buffer) ------------------------------------------------

test('shared frames alternate slots, publish the latest and detect overwritten reads', () => {
  const writer = new SharedFrames({ a: 'f32', b: 'u8' });
  const reader = SharedFrames.attach(writer.describe());
  assert.equal(reader.latest(), null, 'nothing published yet');
  const w1 = writer.write((view) => {
    view('a', 3).set([1, 2, 3]);
    view('b', 2).set([7, 8]);
  });
  assert.equal(w1.slot, 0);
  assert.ok(w1.buffers, 'new buffers go with the first frame of a slot');
  reader.adopt(w1.slot, w1.buffers);
  assert.deepEqual(reader.latest(), { slot: 0, seq: w1.seq });
  assert.deepEqual(Array.from(reader.read(0, 'a', 3)), [1, 2, 3]);
  // The next frame goes to the other slot: reading slot 0 stays valid.
  const w2 = writer.write((view) => view('a', 2).set([9, 9]));
  assert.equal(w2.slot, 1);
  assert.ok(reader.valid(w1.slot, w1.seq), 'the slot being read was not touched');
  reader.adopt(w2.slot, w2.buffers);
  assert.equal(reader.latest().slot, 1);
  // A third frame overwrites slot 0: a reader still holding frame 1 sees it.
  const w3 = writer.write((view) => view('a', 3).set([4, 5, 6]));
  assert.equal(w3.slot, 0);
  assert.equal(w3.buffers, null, 'same capacity: no new buffers');
  assert.equal(reader.valid(w1.slot, w1.seq), false);
  assert.ok(reader.valid(w3.slot, w3.seq));
  // Growing a section replaces that slot's buffer.
  const w4 = writer.write((view) => view('a', 5000).fill(1));
  assert.ok(w4.buffers && w4.buffers.a.byteLength >= 5000 * 4);
  assert.equal(capacityFor(5000), 8192);
});

test('a reader never accepts a torn frame while another thread writes (seqlock)', async () => {
  const frames = new SharedFrames({ data: 'i32' });
  const N = 4096;
  // Prime both slots so the reader has their buffers.
  const p0 = frames.write((view) => view('data', N).fill(-1));
  const p1 = frames.write((view) => view('data', N).fill(-2));
  const buffers = [p0.buffers, p1.buffers];
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    import(workerData.url).then(({ SharedFrames }) => {
      const w = SharedFrames.attach(workerData.desc);
      w.slots = workerData.buffers.map((b) => ({ ...b }));
      for (let f = 1; f <= workerData.frames; f++) {
        w.write((view) => {
          const a = view('data', ${N});
          // Written in two halves with a pause: a reader in between would see two frame numbers.
          a.fill(f, 0, ${N / 2});
          for (let k = 0; k < 200; k++) Atomics.load(a, 0);
          a.fill(f, ${N / 2});
        });
      }
      parentPort.postMessage('done');
    });`;
  const writer = new ThreadWorker(code, {
    eval: true,
    workerData: { url: new URL('../js/sim/framebuffer.js', import.meta.url).href, desc: frames.describe(), buffers, frames: 3000 },
  });
  let done = false;
  writer.on('message', () => (done = true));
  const reader = SharedFrames.attach(frames.describe());
  reader.adopt(0, buffers[0]);
  reader.adopt(1, buffers[1]);
  let accepted = 0;
  let rejected = 0;
  while (!done) {
    const at = reader.latest();
    if (!at) continue;
    const a = reader.read(at.slot, 'data', N);
    const first = a[0];
    let same = true;
    for (let i = 1; i < N; i++) if (a[i] !== first) same = false;
    if (reader.valid(at.slot, at.seq)) {
      accepted++;
      assert.ok(same, `a validated frame was torn (${first} vs another value)`);
    } else {
      rejected++;
    }
    await new Promise((r) => setImmediate(r));
  }
  await writer.terminate();
  assert.ok(accepted > 0, 'frames were read');
  // Rejections depend on timing; the assertion above is the guarantee.
  assert.ok(accepted + rejected > 0);
});

test('the transfer pool hands buffers back for reuse', () => {
  const pool = new BufferPool(2);
  const a = pool.take(100);
  assert.ok(a.byteLength >= 100);
  pool.give([a, new ArrayBuffer(0), 'junk']);
  assert.equal(pool.take(50), a, 'the returned buffer is reused');
  pool.give([new ArrayBuffer(8192), new ArrayBuffer(8192), new ArrayBuffer(8192)]);
  assert.equal(pool.free.length, 2, 'the pool is bounded');
});

// ---- Query cache and actor table ----------------------------------------------------------

test('cached queries answer the last frame, follow the latest hover answer, and expire', () => {
  let t = 0;
  const cache = new QueryCache(() => t);
  assert.equal(cache.get('pick', [0, 10, 10]), NONE, 'default before the first answer');
  assert.equal(cache.get('player_json', [0]), null);
  const asked = cache.collect();
  assert.deepEqual(
    asked.map(([, m]) => m),
    ['pick', 'player_json'],
  );
  cache.answer(asked.map(([key, method]) => [key, method === 'pick' ? 42 : '{"tick":3}']));
  assert.equal(cache.get('pick', [0, 10, 10]), 42);
  assert.equal(cache.get('player_json', [0]), '{"tick":3}');
  // Another hover position: the last pick until its own answer arrives.
  assert.equal(cache.get('pick', [0, 11, 10]), 42);
  // Per-id queries wait for their own answer.
  cache.answer([[queryKey('deploy_state', [0, 5]), 1]]);
  assert.equal(cache.get('deploy_state', [0, 6]), 0);
  // A failed query keeps the last answer.
  cache.answer([[queryKey('pick', [0, 10, 10]), undefined]]);
  assert.equal(cache.get('pick', [0, 10, 10]), 42);
  t += LIVE_MS + 1;
  cache.get('player_json', [0]);
  assert.deepEqual(
    cache.collect().map(([, m]) => m),
    ['player_json'],
    'only recently called queries are asked again',
  );
  t += EXPIRE_MS + 1;
  cache.collect();
  assert.equal(cache.entries.size, 0, 'old queries are forgotten');
  // Large id lists hash to short keys.
  const big = Uint32Array.from({ length: 20000 }, (_, i) => i);
  assert.ok(queryKey('command_state', [0, big]).length < 40);
  assert.notEqual(queryKey('command_state', [0, big]), queryKey('command_state', [0, big.subarray(1)]));
});

test('the actor table answers what actor_json says about owner, kind and type', () => {
  const game = Game.from_options(JSON.stringify(OPTIONS));
  const local = new LocalDriver(game, { player: 0 });
  for (let t = 0; t < 300; t++) local.tick();
  const table = game.actor_table();
  const ids = JSON.parse(game.rules_json()).actors.map((a) => a.id);
  let n = 0;
  for (let slot = 0; slot < table.length; slot += 2) {
    const id = table[slot];
    if (id === NONE) continue;
    n++;
    assert.deepEqual(tableInfo(table, ids, id), actorInfo(game, id), `actor ${id}`);
  }
  assert.ok(n > 3);
  assert.equal(tableInfo(table, ids, NONE), null);
  assert.equal(tableInfo(table, ids, table[0] + (1 << 22)), null, 'another generation of the slot is gone');
  // Composite queries agree with the per-actor loop they replace.
  const all = Uint32Array.from(table.filter((_, i) => i % 2 === 0 && table[i] !== NONE));
  let best = 0;
  for (const id of all) {
    const st = game.deploy_state(0, id);
    const ab = game.ability_deploy_state(0, id);
    if (st === 1 || ab === 1 || ab === 3) {
      best = 1;
      break;
    }
    if (st === 2 || ab === 2) best = 2;
  }
  assert.equal(COMPOSITES.deploy_summary(game, 0, all), best);
  assert.deepEqual(COMPOSITES.deploy_targets(game, 0, new Uint32Array(0)), { teleport: [], deploy: [] });
});

// ---- Games through the boundary -----------------------------------------------------------

/** The scripted skirmish driven directly: state hash after every 50 ticks. */
function directHashes(ticks) {
  const game = Game.from_options(JSON.stringify(OPTIONS));
  const recorder = new Recorder({ mode: 'skirmish', options: OPTIONS, map: null, mapHash: null, player: 0, engine: version(), title: 'Boundary' });
  const local = new LocalDriver(game, { player: 0, recorder });
  const hashes = [];
  for (let t = 0; t < ticks; t++) {
    scriptedOrders(t, game, units(game, 0));
    local.tick();
    if ((t + 1) % 50 === 0) hashes.push(game.state_hash());
  }
  return { hashes, replay: recorder.encode('replay', ticks), final: game.state_hash() };
}

async function newHost(mode) {
  if (mode === 'direct') return createSimHost({ Game, memory: () => wasm.memory, env: nodeEnv('direct') });
  return createSimHost({ Game, memory: () => wasm.memory, module: wasmModule(), env: nodeEnv(mode), WorkerClass: NodeWorker });
}

/** One step of exactly one tick, waited for (worker steps are pipelined). */
async function stepOnce(host, extra = {}) {
  const before = host.frame?.id ?? 0;
  host.step({ dt: TICK_MS, view: 0, rect: [0, 0, 1536, 1536], audio: true, ...extra });
  await until(() => (host.frame?.id ?? 0) > before);
  return host.frame;
}

for (const mode of ['direct', 'transfer', 'shared']) {
  test(`a skirmish through the ${mode} boundary matches the engine driven directly`, async () => {
    const TICKS = 400;
    const expected = directHashes(TICKS);
    const host = await newHost(mode);
    assert.equal(host.mode, mode);
    const info = await host.start({ kind: 'skirmish', options: OPTIONS, map: null, player: 0, recorder: { mode: 'skirmish', options: OPTIONS, map: null, mapHash: null, player: 0, engine: version(), title: 'Boundary' }, tickMs: TICK_MS });
    assert.equal(info.mapWidth, 64);
    const game = host.game;
    const hashes = [];
    let frame = null;
    for (let t = 0; t < TICKS; t++) {
      const own = Array.from(await game.ask.select_box(0, -1e9, -1e9, 1e9, 1e9));
      scriptedOrders(t, game, own);
      frame = await stepOnce(host);
      assert.equal(frame.ticks, 1);
      if ((t + 1) % 50 === 0) hashes.push(await host.command('stateHash'));
    }
    assert.deepEqual(hashes, expected.hashes, 'same state hashes at every checkpoint');
    // Render data arrived and is readable on this side.
    assert.ok(frame.spriteCount > 0);
    assert.equal(frame.sprites().length, frame.spriteCount * 8);
    assert.equal(frame.fog().length, 64 * 64);
    assert.ok(frame.valid());
    // The recording made where the game runs is the same replay.
    const { text } = await host.command('encode', ['replay']);
    const a = await parseReplay(text);
    const b = await parseReplay(expected.replay);
    assert.deepEqual(a.replay.frames, b.replay.frames);
    assert.deepEqual(a.replay.hashes, b.replay.hashes);
    host.dispose();
  });
}

/** A desert AI game whose first heat wave makes tanks run hot at about tick 3825 (seed 11). */
const DESERT = {
  ...SKIRMISH,
  seed: 11,
  players: [
    { slot: 0, type: 'ai', difficulty: 'hard', faction: 'england', color: 0, team: 0 },
    { slot: 1, type: 'ai', difficulty: 'hard', faction: 'russia', color: 1, team: 0 },
  ],
  startingCash: 10000,
  startingUnits: 'heavy',
  biome: 'desert',
  weather: 'full',
};

/** The first tick (and the direct game there) at which a vehicle in `rect` runs hot. */
function firstHotTick(options, rect) {
  const direct = Game.from_options(JSON.stringify(options));
  for (let t = 0; t < 9000; t++) {
    direct.tick();
    if (direct.build_heat_fx(0, ...rect) > 0) return direct.tick_count();
  }
  throw new Error('no vehicle ran hot');
}

for (const mode of ['direct', 'transfer', 'shared']) {
  test(`the sky and heat shimmer cross the ${mode} boundary like the engine makes them`, async () => {
    const options = replayOptions(DESERT);
    const rect = [0, 0, 64 * 24, 64 * 24];
    const target = firstHotTick(options, rect);
    const host = await newHost(mode);
    try {
      const info = await host.start({ kind: 'skirmish', options, map: null, player: 0, recorder: null, tickMs: TICK_MS });
      // The start's sky is static: the terrain atlas and the minimap colours follow its biome.
      assert.equal(JSON.parse(info.weatherJson).biome, 'desert');
      assert.equal(JSON.parse(host.game.weather_json()).biome, 'desert');
      let frame = null;
      while (!frame || frame.tick < target) {
        const before = host.frame?.id ?? 0;
        // Eight ticks a step, then single ticks to land on the target.
        const left = target - (frame?.tick ?? 0);
        host.step({ dt: Math.min(8, left) * TICK_MS, view: 0, rect, audio: false });
        await until(() => (host.frame?.id ?? 0) > before);
        frame = host.frame;
      }
      assert.equal(frame.tick, target);
      const direct = Game.from_options(JSON.stringify(options));
      while (direct.tick_count() < target) direct.tick();
      assert.equal(frame.weather, direct.weather_json(), 'the frame carries the sky of its tick');
      assert.equal(JSON.parse(frame.weather).weather, 'heatwave');
      const n = direct.build_heat_fx(0, ...rect);
      assert.ok(n > 0);
      assert.equal(frame.heatCount, n);
      const expected = Array.from(new Float32Array(wasm.memory.buffer, direct.fx_ptr(), n * 4));
      assert.deepEqual(Array.from(frame.heat()), expected, 'the same heat shimmer instances');
      assert.ok(frame.valid());
      // The GPU instance path carries the same sky and shimmer.
      const before = host.frame.id;
      host.step({ dt: 0, view: 0, rect, audio: false, instances: 'gpu' });
      await until(() => host.frame.id > before);
      const g = host.frame;
      assert.equal(g.instances, 'gpu');
      assert.equal(g.weather, frame.weather);
      assert.deepEqual(Array.from(g.heat()), expected, 'heat shimmer on the GPU path');
    } finally {
      host.dispose();
    }
  });
}

/** Records of a directly driven game (copies), for comparison with what crossed the boundary. */
function directRecords(game, view) {
  const f32 = (ptr, len) => Array.from(new Float32Array(wasm.memory.buffer, ptr, len));
  const n = game.build_render_records(view);
  return {
    sprites: f32(game.record_ptr(), n * SPRITE_REC_FLOATS),
    extras: f32(game.record_extra_ptr(), game.record_extra_count() * SPRITE_EXTRA_FLOATS),
    rects: f32(game.rect_record_ptr(), game.rect_record_count() * RECT_REC_FLOATS),
  };
}

const sameRecords = (frame, expected, label) => {
  const r = frame.records();
  assert.ok(r, `${label}: records`);
  assert.deepEqual({ sprites: Array.from(r.sprites), extras: Array.from(r.extras), rects: Array.from(r.rects) }, expected, label);
  return r.gen;
};

for (const mode of ['direct', 'transfer', 'shared']) {
  test(`the GPU instance path through the ${mode} boundary sends records once per tick and when the selection changes`, async () => {
    const host = await newHost(mode);
    await host.start({ kind: 'stress', seed: 3, units: 600, size: 64, tickMs: TICK_MS });
    const direct = Game.new_stress(3, 600, 64);
    const gpu = { instances: 'gpu' };
    // A tick: records and fog arrive, no per-frame instances.
    let f = await stepOnce(host, gpu);
    direct.tick();
    assert.equal(f.ticks, 1);
    assert.equal(f.instances, 'gpu');
    assert.equal(f.spriteCount, 0);
    assert.equal(f.sprites().length, 0);
    let gen = sameRecords(f, directRecords(direct, 0), 'first tick');
    assert.ok(f.renderBytes > 0);
    assert.equal(f.fog().length, 64 * 64);
    const fog = f.fog();
    // Frames between ticks: nothing is built or sent, the kept records and fog stay.
    for (let k = 0; k < 3; k++) {
      f = await stepOnce(host, { ...gpu, dt: 9 });
      assert.equal(f.ticks, 0);
      assert.equal(f.renderBytes, 0, 'no render data between ticks');
      assert.equal(f.records().gen, gen);
      assert.equal(f.fog(), fog, 'the same fog');
      assert.ok(f.alpha > 0 && f.alpha < 1);
    }
    // A selection change rebuilds them without a tick.
    const pick = Array.from(direct.select_box(0, -1e9, -1e9, 1e9, 1e9)).slice(0, 5);
    host.game.set_selection(Uint32Array.from(pick));
    direct.set_selection(Uint32Array.from(pick));
    f = await stepOnce(host, { ...gpu, dt: 0 });
    assert.equal(f.ticks, 0);
    const selected = sameRecords(f, directRecords(direct, 0), 'after the selection');
    assert.ok(selected > gen);
    gen = selected;
    // The next tick (the rest of the 40 ms): new records again.
    f = await stepOnce(host, { ...gpu, dt: 13 });
    direct.tick();
    assert.equal(f.ticks, 1);
    assert.ok(sameRecords(f, directRecords(direct, 0), 'second tick') > gen);
    // Back to the CPU path: per-frame instances; then the GPU path rebuilds at once.
    f = await stepOnce(host, { dt: 0 });
    assert.equal(f.instances, 'cpu');
    assert.ok(f.spriteCount > 0);
    assert.equal(f.records(), null);
    f = await stepOnce(host, { ...gpu, dt: 0 });
    sameRecords(f, directRecords(direct, 0), 'GPU path again');
    host.dispose();
  });
}

test('orders reach the engine and queries answer from consistent snapshots', async () => {
  const host = await newHost('transfer');
  await host.start({ kind: 'skirmish', options: OPTIONS, map: null, player: 0, recorder: null, tickMs: TICK_MS });
  const game = host.game;
  // Synchronous answers start as defaults and fill in with the next frame.
  assert.equal(game.player_json(0), null);
  let frame = await stepOnce(host);
  assert.equal(JSON.parse(game.player_json(0)).tick, frame.tick, 'the answer belongs to the frame it came with');
  assert.equal(game.tick_count(), frame.tick);
  // The actor table answers ownership at once.
  const own = Array.from(await game.ask.select_box(0, -1e9, -1e9, 1e9, 1e9));
  assert.ok(own.length > 0);
  for (const id of own) {
    const fresh = JSON.parse(await game.ask.actor_json(id));
    assert.deepEqual(
      { owner: fresh.owner, type: fresh.type, building: fresh.building },
      (({ owner, type, building }) => ({ owner, type, building }))(game.actor_info(id)),
    );
  }
  // Selection mirrors locally and reaches the engine.
  game.set_selection(Uint32Array.from(own));
  assert.deepEqual(Array.from(game.selection()), own);
  // An order: the engine queues it and the units get waypoints / start moving.
  const before = JSON.parse(await game.ask.command_state(0, Uint32Array.from(own)));
  game.order_waypoint(0, Uint32Array.from(own), 900, 900, false);
  game.order_waypoint(0, Uint32Array.from(own), 950, 900, false);
  frame = await stepOnce(host);
  frame = await stepOnce(host);
  const after = JSON.parse(await game.ask.command_state(0, Uint32Array.from(own)));
  assert.ok(after.queued > before.queued, `waypoints queued (${before.queued} -> ${after.queued})`);
  // A query asked after an order sees the state that order is part of (FIFO).
  game.start_production(0, 'E1', 1);
  const queued = JSON.parse(await game.ask.player_json(0));
  assert.equal(queued.tick, frame.tick, 'no tick ran between the order and the query');
  // Unknown or non-query methods are refused where the game runs.
  await assert.rejects(host.link.ask('state_hash', []), /not a Game query/);
  await assert.rejects(host.command('nope'), /unknown simulation command/);
  host.dispose();
});

test('an online game through the worker follows the lockstep frames like the direct driver', async () => {
  const delay = 3;
  // Frames as a server would send them: empty ones, and now and then a move
  // of player 0 (orders as the engine writes them, from a scratch game).
  const scratch = Game.from_options(JSON.stringify(OPTIONS));
  scratch.set_lockstep(true);
  const frameAt = (t, own) => {
    if (t % 60 !== 20 || !own.length) return { tick: t, orders: [] };
    scratch.order_move(0, Uint32Array.from(own), 300 + t, 500, false);
    return { tick: t, orders: [[0, JSON.parse(scratch.take_orders())]] };
  };
  const sent = [];
  const direct = Game.from_options(JSON.stringify(OPTIONS));
  const ref = new LockstepDriver({ send: (m) => sent.push(m) }, direct, { delay, tickMs: TICK_MS, spectator: true });
  const host = await newHost('transfer');
  await host.start({ kind: 'online', options: OPTIONS, map: null, player: null, spectator: true, delay, tickMs: TICK_MS, rejoining: false, recorder: null });
  const out = [];
  let caught = 0;
  const driver = new DriverHandle(host, { send: (m) => out.push(m) }, { tickMs: TICK_MS, onCaughtUp: () => caught++ });
  const own = units(direct, 0);
  for (let t = 0; t < 200; t++) {
    const f = frameAt(t, own);
    ref.onFrame(f);
    driver.onFrame(f);
  }
  for (let i = 0; i < 400 && ref.next < 200; i++) ref.advance(TICK_MS);
  for (let i = 0; i < 400 && (host.frame?.tick ?? 0) < 200; i++) {
    await stepOnce(host);
    driver.update(host.frame.status.online);
  }
  assert.equal(host.frame.tick, 200);
  assert.equal(await host.command('stateHash'), direct.state_hash());
  assert.equal(driver.catchingUp, false);
  assert.equal(caught, 0, 'not rejoining: no catch-up');
  assert.deepEqual(out, [], 'a spectator sends nothing');
  driver.stop();
  host.dispose();
});

test('a rejoining player catches up in the worker, resumes, and sends on the current connection only', async () => {
  const delay = 3;
  const host = await newHost('shared');
  await host.start({ kind: 'online', options: OPTIONS, map: null, player: 0, spectator: false, delay, tickMs: TICK_MS, rejoining: true, recorder: null });
  const first = [];
  const second = [];
  let caught = 0;
  const driver = new DriverHandle(host, { send: (m) => first.push(m) }, { tickMs: TICK_MS, onCaughtUp: () => caught++ });
  // The log, then sync at tick 120: everything before is empty frames.
  driver.onLog({ frames: [] });
  driver.onSync({ tick: 120, check: null });
  for (let i = 0; i < 200 && caught === 0; i++) {
    await stepOnce(host);
    driver.update(host.frame.status.online);
  }
  assert.equal(caught, 1, 'caught up with sync');
  assert.equal(host.frame.tick, 120);
  // Seated again from tick 123: orders go out from there.
  driver.onBack(123);
  for (let t = 120; t < 140; t++) driver.onFrame({ tick: t, orders: [] });
  for (let i = 0; i < 30 && host.frame.tick < 130; i++) await stepOnce(host);
  await until(() => first.some((m) => m.t === 'orders'));
  // A reconnect: sends made for the old connection never reach the new one.
  driver.reattach({ send: (m) => second.push(m) });
  const before = first.length;
  for (let i = 0; i < 5; i++) await stepOnce(host);
  assert.equal(second.length, 0, 'the driver waits for sync after a reconnect: nothing sent');
  assert.equal(first.length, before, 'the old connection gets nothing more');
  assert.ok(first.filter((m) => m.t === 'orders').every((m) => m.tick >= 123));
  host.dispose();
});

test('a replay plays and seeks in the worker and matches its recorded hashes', async () => {
  const expected = directHashes(600);
  const r = await parseReplay(expected.replay);
  const host = await newHost('transfer');
  const info = await host.start({ kind: 'replay', replay: r.replay, tickMs: TICK_MS });
  const replay = new ReplayHandle(host, info.replayLength);
  assert.equal(replay.length, 600);
  replay.setSpeed(8);
  for (let i = 0; i < 200 && host.frame?.status.replay.ended !== true; i++) {
    await stepOnce(host, { view: 255 });
    replay.update(host.frame.status.replay);
  }
  assert.equal(replay.ticks, 600);
  assert.equal(replay.diverged, null);
  assert.equal(await host.command('stateHash'), expected.final);
  replay.seek(300);
  assert.equal(replay.seeking, true, 'shown at once');
  for (let i = 0; i < 100 && (i === 0 || host.frame.status.replay.seeking); i++) await stepOnce(host, { view: 255 });
  replay.update(host.frame.status.replay);
  assert.equal(replay.ticks, 300);
  assert.equal(await host.command('stateHash'), expected.hashes[5]);
  // Fast-forwarding is silent: no sound events come with seeking frames.
  host.dispose();
});

test('a save loads in the worker without blocking, then plays on identically', async () => {
  const game = Game.from_options(JSON.stringify(OPTIONS));
  const recorder = new Recorder({ mode: 'skirmish', options: OPTIONS, map: null, mapHash: null, player: 0, engine: version(), title: 'Save' });
  const local = new LocalDriver(game, { player: 0, recorder });
  for (let t = 0; t < 2 * REPLAY_HASH_INTERVAL; t++) {
    scriptedOrders(t, game, units(game, 0));
    local.tick();
  }
  const save = await parseReplay(recorder.encode('save', game.tick_count(), game.state_hash()));
  for (let t = 2 * REPLAY_HASH_INTERVAL; t < 600; t++) {
    scriptedOrders(t, game, units(game, 0));
    local.tick();
  }
  const host = await newHost('transfer');
  await host.start({ kind: 'save', replay: save.replay, tickMs: TICK_MS });
  let loadingFrames = 0;
  let frame = await stepOnce(host);
  while (frame.status.loading) {
    loadingFrames++;
    assert.equal(frame.busy, true);
    frame = await stepOnce(host);
  }
  assert.ok(loadingFrames >= 0);
  assert.equal(frame.status.loadError, undefined);
  assert.equal(await host.command('tick'), 2 * REPLAY_HASH_INTERVAL);
  for (let t = await host.command('tick'); t < 600; t++) {
    scriptedOrders(t, host.game, Array.from(await host.game.ask.select_box(0, -1e9, -1e9, 1e9, 1e9)));
    await stepOnce(host);
  }
  assert.equal(await host.command('stateHash'), game.state_hash());
  host.dispose();
});

test('direct mode drives the same core on this thread', async () => {
  const host = await newHost('direct');
  await host.start({ kind: 'stress', seed: 3, units: 300, size: 96, tickMs: TICK_MS });
  const f = host.step({ dt: TICK_MS * 2, view: 0, rect: [0, 0, 96 * 24, 96 * 24], audio: false });
  assert.equal(f.ticks, 2);
  assert.equal(f.status.actorCount, host.game.actor_count());
  assert.equal(f.sprites().length, f.spriteCount * 8);
  assert.ok(f.spriteCount > 0);
  // Views of wasm memory: made when used.
  assert.equal(f.sprites().buffer, wasm.memory.buffer);
  assert.equal(await host.command('debugStep'), true);
  assert.equal(host.game.tick_count(), 3);
  await assert.rejects(host.command('nope'), /unknown simulation command/);
  assert.throws(() => host.game.core.call('tick', []), /not a callable Game method/);
});

test('replay controller state is mirrored for the replay bar', () => {
  const handle = new ReplayHandle({ command: () => Promise.resolve() }, 100);
  handle.togglePlay();
  assert.equal(handle.playing, false);
  handle.update({ ticks: 40, length: 100, playing: true, speed: 2, ended: false, seeking: false, target: null, diverged: null });
  assert.equal(handle.ticks, 40);
  assert.equal(handle.speed, 2);
  handle.seek(500);
  assert.equal(handle.target, 100, 'clamped to the replay');
  assert.ok(ReplayController);
});
