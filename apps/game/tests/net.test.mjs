// Lockstep driver tests: order packing, and two real engine instances kept in
// sync through the server's lockstep relay (no network, same code paths).
// Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { LockstepDriver, packOrders, splitOrders } from '../js/net.js';
import { encodeClient, MAX_MESSAGE_BYTES, parseClientMessage } from '../js/protocol.js';
import { Lockstep } from '../../server/src/lockstep.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

test('large selections are split and packed under the message limits', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => 1_000_000 + i);
  const queue = splitOrders([
    { o: 'move', player: 0, ids, x: 100, y: 100, attack_move: false },
    { o: 'stop', player: 0, ids: [1] },
  ]);
  assert.ok(queue.length > 2);
  assert.equal(queue.filter((o) => o.o === 'move').flatMap((o) => o.ids).length, 2000);
  let ticks = 0;
  const sent = [];
  while (queue.length) {
    const batch = packOrders(queue);
    const raw = encodeClient({ t: 'orders', tick: ticks, orders: batch });
    assert.ok(raw.length <= MAX_MESSAGE_BYTES);
    assert.ok(parseClientMessage(raw).ok);
    sent.push(...batch);
    ticks++;
  }
  assert.ok(ticks >= 2, 'spread over several ticks');
  assert.equal(sent.at(-1).o, 'stop', 'order preserved');
});

const OPTIONS = {
  seed: 77,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'A', faction: 'germany', color: 0, team: 0 },
    { slot: 1, type: 'human', name: 'B', faction: 'russia', color: 1, team: 0 },
    { slot: 2, type: 'ai', difficulty: 'easy', faction: 'england', color: 2, team: 0 },
  ],
  startingCash: 5000,
  startingUnits: 'light',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: false,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: true,
  // OpenRA's other lobby options (protocol 6).
  crates: true,
  shortGame: true,
  bounty: false,
  separateTeamSpawns: true,
  allyBuildRadius: true,
  timeLimit: 0,
};

/** In-memory relay: client messages go through the protocol and the server's Lockstep. */
function harness(players) {
  const relay = new Lockstep({ players, delay: 3 });
  const clients = [];
  const hashes = [];
  const deliver = (frames) => {
    for (const f of frames) for (const c of clients) c.inbox.push(f);
  };
  const connFor = (seat) => ({
    send(msg) {
      const parsed = parseClientMessage(encodeClient(msg));
      assert.ok(parsed.ok, parsed.message);
      const m = parsed.msg;
      if (m.t === 'orders') deliver(relay.submit(seat, m.tick, m.orders));
      if (m.t === 'hash') {
        hashes.push([seat, m.tick, m.hash]);
        assert.equal(relay.hash(seat, m.tick, m.hash), null, `desync at ${m.tick}`);
      }
    },
  });
  for (const seat of players) {
    const game = Game.from_options(JSON.stringify(OPTIONS));
    const driver = new LockstepDriver(connFor(seat), game, { delay: 3, tickMs: 40 });
    clients.push({ seat, game, driver, inbox: [] });
  }
  deliver(relay.initialFrames());
  return { relay, clients, hashes };
}

test('two engines stay in sync through the relay while issuing different orders', () => {
  const { clients, hashes } = harness([0, 1]);
  const [a, b] = clients;
  const unitsOf = (c) => Array.from(c.game.select_box(c.seat, -1e9, -1e9, 1e9, 1e9));
  for (let step = 0; step < 300; step++) {
    if (step === 10) a.game.order_move(0, Uint32Array.from(unitsOf(a)), 900, 900, true);
    if (step === 40) b.game.order_smart(1, Uint32Array.from(unitsOf(b)), 300, 300);
    // A cheating client issues orders for player 0 from seat 1: the stamp neutralizes it.
    if (step === 60) b.game.order_stop(0, Uint32Array.from(unitsOf(a)));
    for (const c of clients) {
      // Deliver frames like WebSocket messages, then let wall time pass.
      for (const f of c.inbox.splice(0)) c.driver.onFrame(f);
      c.driver.advance(40);
    }
  }
  assert.ok(a.driver.next > 250, `advanced to ${a.driver.next}`);
  assert.equal(a.game.tick_count(), b.game.tick_count());
  assert.equal(a.game.state_hash(), b.game.state_hash());
  assert.ok(hashes.length >= 20);
  // The orders really changed the game: an idle copy ends up different.
  const idle = Game.from_options(JSON.stringify(OPTIONS));
  for (let i = 0; i < a.game.tick_count(); i++) idle.tick();
  assert.notEqual(idle.state_hash(), a.game.state_hash());
});

test('a client never runs a tick before its frame arrives', () => {
  const { clients } = harness([0, 1]);
  const [a, b] = clients;
  for (const f of a.inbox.splice(0)) a.driver.onFrame(f);
  // b never delivers: a can run the 3 initial frames, then stalls.
  for (let i = 0; i < 50; i++) a.driver.advance(40);
  assert.equal(a.driver.next, 3);
  assert.equal(a.game.tick_count(), 3);
  assert.ok(a.driver.stalledMs > 1000);
  // Once b catches up, a continues.
  for (const f of b.inbox.splice(0)) b.driver.onFrame(f);
  for (let i = 0; i < 5; i++) b.driver.advance(40);
  for (const f of a.inbox.splice(0)) a.driver.onFrame(f);
  a.driver.advance(40);
  assert.ok(a.driver.next > 3);
  assert.equal(a.driver.stalledMs, 0);
});

test('a backlog of delay + 1 frames is caught up at once, delay frames are paced', () => {
  const { clients } = harness([0, 1]);
  const [a] = clients;
  for (const tick of [0, 1, 2]) a.driver.onFrame({ tick, orders: [] });
  // Three waiting frames (the order delay) still run at the normal pace.
  assert.equal(a.driver.advance(1).ticks, 0);
  // A fourth means the server waits for this client: run them all now.
  a.driver.onFrame({ tick: 3, orders: [] });
  assert.equal(a.driver.advance(1).ticks, 4);
  assert.equal(a.driver.next, 4);
});
