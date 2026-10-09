// Debug menu (js/debug.js, engine/src/debug.rs): cheats are lockstep orders that
// only work with the cheats option, the views are read only, and the pure
// helpers of the menu. Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { CELL, CHEATS, decodeGrid, DIRS, formatStats, PerfHistory, sanitizePrefs, VIEWS } from '../js/debug.js';
import { LockstepDriver } from '../js/net.js';
import { DEV_FLAGS, encodeClient, isCheatOrder, parseClientMessage, validOrders } from '../js/protocol.js';
import { Lockstep } from '../../server/src/lockstep.js';
import { cheatsAllowed } from '../../server/src/validate.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

const OPTIONS = {
  seed: 4242,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'A', faction: 'russia', color: 0, team: 0 },
    { slot: 1, type: 'human', name: 'B', faction: 'england', color: 1, team: 0 },
  ],
  startingCash: 5000,
  startingUnits: 'base',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: false,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: true,
  reusableEngineers: false,
  cheats: false,
};

const newGame = (cheats, more = {}) => Game.from_options(JSON.stringify({ ...OPTIONS, ...more, cheats }));
const state = (game, p = 0) => JSON.parse(game.player_json(p));
const ticks = (game, n) => {
  for (let i = 0; i < n; i++) game.tick();
};
const unitsOf = (game, p) => Array.from(game.select_box(p, -1e9, -1e9, 1e9, 1e9));

/** Every cheat the menu can send, issued for `player`. */
function cheatAll(game, player, killIds) {
  for (const c of CHEATS) game.dev_flag(player, c.flag, true);
  game.dev_give_cash(player);
  game.dev_kill(player, Uint32Array.from(killIds));
  game.dev_experience(player, Uint32Array.from(killIds));
}

test('the menu offers exactly the engine and protocol cheat flags', () => {
  assert.deepEqual(
    CHEATS.map((c) => c.flag),
    DEV_FLAGS,
  );
  assert.deepEqual(Object.keys(state(newGame(true)).dev).sort(), [...DEV_FLAGS].sort());
});

test('cheats do nothing in a game without the cheats option', () => {
  const game = newGame(false);
  const twin = newGame(false);
  assert.equal(game.cheats_enabled(), false);
  assert.equal(state(game).cheats, false);
  const before = state(game).cash;
  // Player 0 (local, not lockstep) tries every cheat and to kill the enemy yard.
  const enemy = Array.from({ length: 4096 }, (_, i) => i);
  cheatAll(game, 0, enemy);
  ticks(game, 5);
  ticks(twin, 5);
  const s = state(game);
  assert.equal(s.cash, before);
  assert.ok(Object.values(s.dev).every((v) => v === false), JSON.stringify(s.dev));
  assert.equal(game.state_hash(), twin.state_hash(), 'nothing changed');
  // A forged frame from the network is ignored the same way.
  const frame = [[1, [{ o: 'dev_cash', player: 1 }, { o: 'dev_flag', player: 1, flag: 'disable_shroud', on: true }]]];
  game.apply_frame(JSON.stringify(frame));
  twin.apply_frame(JSON.stringify(frame));
  ticks(game, 3);
  ticks(twin, 3);
  assert.equal(state(game, 1).cash, state(twin, 1).cash);
  assert.equal(game.state_hash(), twin.state_hash());
});

test('cheats work in a game with the cheats option', () => {
  const game = newGame(true);
  assert.equal(game.cheats_enabled(), true);
  const before = state(game).cash;
  game.dev_give_cash(0);
  game.dev_flag(0, 'disable_shroud', true);
  game.dev_flag(0, 'unknown_flag', true); // ignored by the API
  ticks(game, 3);
  const s = state(game);
  assert.equal(s.cash, before + 20000);
  assert.equal(s.dev.disable_shroud, true);
  assert.equal(state(game, 1).dev.disable_shroud, false, 'per player');
  // Reveal map: every cell is visible.
  const cells = decodeGrid(game.debug_cells(0, 0, 0, 64 * 24, 64 * 24));
  assert.equal(cells.w * cells.h, 64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) assert.ok(cells.at(x, y) & CELL.VISIBLE, `${x},${y}`);
  // Destroy: the enemy's construction yard, picked by its position (visible now).
  const [ex, ey] = game.start_position(1);
  const yard = game.pick(0, ex, ey - 12);
  assert.notEqual(yard, 0xffffffff);
  game.dev_kill(0, Uint32Array.from([yard]));
  ticks(game, 2);
  assert.equal(game.actor_json(yard), 'null', 'destroyed');
});

test('cheat orders go through lockstep: protocol valid, identical on every peer', () => {
  const relay = new Lockstep({ players: [0, 1], delay: 3 });
  const options = { ...OPTIONS, cheats: true };
  const clients = [];
  const deliver = (frames) => {
    for (const f of frames) for (const c of clients) c.inbox.push(f);
  };
  const sent = [];
  for (const seat of [0, 1]) {
    const game = Game.from_options(JSON.stringify(options));
    const conn = {
      send(msg) {
        const parsed = parseClientMessage(encodeClient(msg));
        assert.ok(parsed.ok, parsed.message);
        const m = parsed.msg;
        if (m.t === 'orders') {
          // What the server checks before relaying (apps/server/src/session.js).
          assert.ok(cheatsAllowed(m.orders, options));
          sent.push(...m.orders);
          deliver(relay.submit(seat, m.tick, m.orders));
        }
        if (m.t === 'hash') assert.equal(relay.hash(seat, m.tick, m.hash), null, `desync at ${m.tick}`);
      },
    };
    clients.push({ seat, game, driver: new LockstepDriver(conn, game, { delay: 3, tickMs: 40 }), inbox: [] });
  }
  deliver(relay.initialFrames());
  const [a, b] = clients;
  const cash0 = state(a.game).cash;
  for (let step = 0; step < 200; step++) {
    if (step === 10) cheatAll(a.game, 0, unitsOf(a.game, 1));
    if (step === 20) b.game.dev_flag(1, 'fast_build', true);
    if (step === 30) b.game.start_production(1, 'POWR', 1);
    for (const c of clients) {
      for (const f of c.inbox.splice(0)) c.driver.onFrame(f);
      c.driver.advance(40);
    }
  }
  assert.ok(sent.some(isCheatOrder), 'the cheats travelled as orders');
  assert.deepEqual(validOrders(sent), sent);
  assert.equal(a.game.state_hash(), b.game.state_hash());
  for (const c of clients) {
    assert.equal(state(c.game).cash, cash0 + 20000, 'both peers gave player 0 the cash');
    assert.equal(state(c.game).dev.all_tech, true);
    assert.equal(state(c.game, 1).dev.fast_build, true);
    assert.equal(state(c.game, 1).queues[0][0]?.done, true, 'instant build for player 1 on both peers');
  }
  // In lockstep mode the local call only queues the order: nothing happens before the frame.
  const solo = Game.from_options(JSON.stringify(options));
  solo.set_lockstep(true);
  solo.dev_give_cash(0);
  ticks(solo, 5);
  assert.equal(state(solo).cash, cash0);
  assert.deepEqual(JSON.parse(solo.take_orders()), [{ o: 'dev_cash', player: 0 }]);
});

test('debug views are read only and only show what the player sees', () => {
  const a = newGame(true, { startingUnits: 'light' });
  const b = newGame(true, { startingUnits: 'light' });
  const units = unitsOf(a, 0);
  assert.ok(units.length > 0);
  const [sx, sy] = a.start_position(0);
  for (const g of [a, b]) {
    g.order_move(0, Uint32Array.from(units), sx + 6 * 24, sy + 8 * 24, false);
    ticks(g, 2);
  }
  let flowSeen = false;
  for (let i = 0; i < 60; i++) {
    const cells = decodeGrid(a.debug_cells(0, -100, -100, 5000, 5000));
    assert.equal(cells.x0, 0, 'clamped to the map');
    const actors = JSON.parse(a.debug_actors(0, 0, 0, 64 * 24, 64 * 24));
    assert.ok(actors.every((x) => x.owner === 0 || x.owner === 1));
    for (const id of units) {
      const flow = a.debug_flow(0, id, 0, 0, 64 * 24, 64 * 24);
      if (flow.length > 0) {
        flowSeen = true;
        const g = decodeGrid(flow, 2);
        assert.ok(g && g.w === 64 && g.h === 64);
        assert.ok([...flow.slice(6)].every((d) => d === 255 || d <= 8));
      }
      // Another player's view of my unit: nothing.
      assert.equal(a.debug_flow(1, id, 0, 0, 64 * 24, 64 * 24).length, 0);
    }
    JSON.parse(a.debug_stats());
    a.tick();
    b.tick();
  }
  assert.ok(flowSeen, 'a moving unit shows its flow field');
  assert.equal(a.state_hash(), b.state_hash(), 'the views changed nothing');
  // Under the shroud: the enemy base is not reported.
  const actors = JSON.parse(a.debug_actors(0, 0, 0, 64 * 24, 64 * 24));
  assert.ok(actors.every((x) => x.owner === 0), 'no enemy actors seen yet');
  const own = actors.find((x) => x.type === 'MCV');
  assert.ok(own && !own.building && own.hp > 0 && own.maxHp >= own.hp && own.radius > 0);
  const stats = JSON.parse(a.debug_stats());
  for (const k of ['tick', 'units', 'buildings', 'projectiles', 'flowComputed', 'flowCached']) assert.ok(Number.isInteger(stats[k]), k);
});

test('menu helpers: grids, preferences, timings', () => {
  assert.equal(decodeGrid([]), null);
  assert.equal(decodeGrid([0, 0, 2, 2, 1, 2, 3]), null, 'length mismatch');
  const g = decodeGrid([9, 9, 5, 6, 2, 2, 1, 2, 3, 4], 2);
  assert.deepEqual([g.x0, g.y0, g.w, g.h], [5, 6, 2, 2]);
  assert.equal(g.at(6, 7), 4);
  assert.equal(DIRS.length, 8);
  assert.deepEqual(DIRS[0], [0, -1], 'north first');

  assert.deepEqual(Object.keys(sanitizePrefs(null)), [...VIEWS.map((v) => v.key), 'cpuInstances']);
  assert.ok(Object.values(sanitizePrefs({ cells: 'yes', evil: true, cpuInstances: 1 })).every((v) => v === false));
  assert.equal(sanitizePrefs({ stats: true }).stats, true);
  assert.equal(sanitizePrefs({ cpuInstances: true }).cpuInstances, true);

  const h = new PerfHistory(4);
  for (const v of [10, 20, 30, 40, 50]) h.push(v, v / 10, v / 2);
  assert.deepEqual(h.series('frame'), [20, 30, 40, 50], 'oldest dropped');
  assert.deepEqual(h.summary('frame'), { avg: 35, max: 50 });
  const lines = formatStats({ tick: 5, units: 3, buildings: 2, actorSlots: 9, projectiles: 0, effects: 1, flowComputed: 4, flowCached: 2, passVersion: 7 }, h, {
    fps: 60,
    simMs: 1.5,
    memoryBytes: 32 * 1024 * 1024,
  });
  assert.match(lines.join('\n'), /FPS 60/);
  assert.match(lines.join('\n'), /flow fields: 4 computed, 2 cached/);
  assert.match(lines.join('\n'), /wasm memory 32\.0 MB/);
  // Where the simulation runs (js/sim/host.js stats()).
  const worker = formatStats(null, h, { sim: { mode: 'shared', label: 'Worker (shared memory)', reason: 'cross-origin isolated: shared memory', workerMs: 6.25, roundTripMs: 7.5, torn: 0 } }).join('\n');
  assert.match(worker, /simulation: Worker \(shared memory\) \(cross-origin isolated: shared memory\)/);
  assert.match(worker, /worker sim\/frame 6\.25 ms  step round trip 7\.5 ms  torn frames 0/);
  const direct = formatStats(null, h, { sim: { mode: 'direct', label: 'Main thread', reason: 'no module workers: main thread', workerMs: null } }).join('\n');
  assert.match(direct, /simulation: Main thread/);
  assert.doesNotMatch(direct, /worker sim/);
  assert.doesNotMatch(direct, /instances:/);
  // The instance path (js/crowd.js): which one draws, why, and its cost per frame.
  const gpu = formatStats(null, h, { instances: { path: 'gpu', reason: 'compute and indirect draws available', buildMs: 0, bytes: 0 } }).join('\n');
  assert.match(gpu, /instances: GPU pass \(records per tick, interpolated and culled per frame\), compute and indirect draws available/);
  assert.match(gpu, /instance build 0\.00 ms\/frame  render data 0\.0 KB\/frame/);
  const cpu = formatStats(null, h, { instances: { path: 'cpu', reason: 'chosen in the debug menu', buildMs: 0.5, bytes: 2048 } }).join('\n');
  assert.match(cpu, /instances: CPU \(built in the simulation every frame\), chosen in the debug menu/);
  assert.match(cpu, /instance build 0\.50 ms\/frame  render data 2\.0 KB\/frame/);
});
