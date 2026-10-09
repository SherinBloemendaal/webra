// Replays, saves, spectators and rejoining, headless with the real engine
// (js/replay.js, js/net.js, js/observer.js, js/saves.js). Run after
// `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game, version } from '../pkg/webra_sim.js';
import { LockstepDriver } from '../js/net.js';
import { engineMismatch, formatTicks, LocalDriver, newGame, Recorder, recordFileName, ReplayController } from '../js/replay.js';
import { IncomeTracker, OBSERVER_VIEW, viewOnly } from '../js/observer.js';
import { MemoryBackend, SaveStore } from '../js/saves.js';
import { clearRejoin, leftText, loadRejoin, saveRejoin } from '../js/online.js';
import { encodeClient, parseClientMessage, parseReplay, replayOptions, REPLAY_HASH_INTERVAL } from '../js/protocol.js';
import { Lockstep } from '../../server/src/lockstep.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

const SKIRMISH = {
  seed: 1234,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'Me', faction: 'england', color: 0, team: 0 },
    { slot: 1, type: 'closed' },
    { slot: 2, type: 'ai', difficulty: 'normal', faction: 'russia', color: 1, team: 0 },
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
  cheats: false,
  mapStyle: 'land',
  biome: 'temperate',
  weather: 'full',
};

const units = (game, p) => Array.from(game.select_box(p, -1e9, -1e9, 1e9, 1e9));

/** A recorded skirmish: the player orders its units around now and then. */
function playSkirmish(ticks, { saveAt = null } = {}) {
  const options = replayOptions(SKIRMISH);
  const game = Game.from_options(JSON.stringify(options));
  const recorder = new Recorder({ mode: 'skirmish', options, map: null, mapHash: null, player: 0, engine: version(), title: 'Test skirmish' });
  const local = new LocalDriver(game, { player: 0, recorder });
  const hashes = new Map();
  let save = null;
  for (let t = 0; t < ticks; t++) {
    if (t % 150 === 10) game.order_move(0, Uint32Array.from(units(game, 0)), 400 + (t % 7) * 90, 500 + (t % 5) * 60, t % 300 === 10);
    if (t === 333) game.start_production(0, 'E1', 3);
    if (saveAt !== null && t === saveAt) save = recorder.encode('save', game.tick_count(), game.state_hash());
    local.tick();
    hashes.set(game.tick_count(), game.state_hash());
  }
  return { game, recorder, local, hashes, save, options };
}

test('a recorded skirmish plays back identically, hashes checked', async () => {
  const live = playSkirmish(1200);
  assert.ok(live.recorder.frames.length >= 8, `${live.recorder.frames.length} frames`);
  assert.equal(live.recorder.hashes.length, Math.floor(1200 / REPLAY_HASH_INTERVAL));
  const text = live.recorder.encode('replay', live.game.tick_count());
  const r = await parseReplay(text);
  assert.ok(r.ok, r.error);
  assert.equal(r.replay.ticks, 1200);
  const c = new ReplayController(Game, r.replay);
  c.setSpeed(8);
  while (!c.ended) c.advance(1000, 40);
  assert.equal(c.ticks, 1200);
  assert.equal(c.diverged, null);
  assert.equal(c.game.state_hash(), live.game.state_hash());
  assert.equal(engineMismatch(r.replay, version()), null);
  assert.match(engineMismatch({ ...r.replay, engine: '0.0.1+deadbeef' }, version()), /0\.0\.1\+deadbeef/);
  assert.match(recordFileName(r.replay), /^webra-replay-Test-skirmish-\d{4}-\d\d-\d\d-\d\d-\d\d\.json$/);
  assert.equal(formatTicks(25 * 3661), '1:01:01');
});

test('seeking re-simulates (backwards from snapshots) and lands on the recorded state', async () => {
  const live = playSkirmish(1600);
  const r = await parseReplay(live.recorder.encode('replay', 1600));
  const c = new ReplayController(Game, r.replay, { keyframeTicks: 300, maxKeyframes: 4 });
  const settle = () => {
    for (let i = 0; i < 1000 && c.seeking; i++) c.advance(16, 40);
  };
  c.seek(1500);
  settle();
  assert.equal(c.ticks, 1500);
  assert.equal(c.game.state_hash(), live.hashes.get(1500));
  assert.ok(c.keyframes.length <= 4, 'keyframes are thinned out');
  c.seek(700);
  assert.ok(c.ticks <= 700, 'restored an earlier snapshot');
  settle();
  assert.equal(c.game.state_hash(), live.hashes.get(700));
  c.seek(1000);
  settle();
  assert.equal(c.game.state_hash(), live.hashes.get(1000));
  c.seek(0);
  settle();
  assert.equal(c.ticks, 0);
  // Play and pause.
  c.togglePlay();
  assert.equal(c.playing, false);
  assert.equal(c.advance(1000, 40).ticks, 0);
  c.togglePlay();
  assert.ok(c.advance(200, 40).ticks > 0);
  c.dispose();
});

test('a save loads by re-simulating, checks its hash and plays on identically', async () => {
  const live = playSkirmish(900, { saveAt: 600 });
  const r = await parseReplay(live.save);
  assert.ok(r.ok, r.error);
  assert.equal(r.replay.kind, 'save');
  assert.equal(r.replay.hashes.at(-1)[0], 600);
  const game = newGame(Game, r.replay);
  const recorder = new Recorder({ ...r.replay, frames: r.replay.frames, hashes: r.replay.hashes });
  const local = new LocalDriver(game, { player: 0, recorder, preload: r.replay });
  assert.equal(local.loading, true);
  local.tick(); // ignored while loading
  let rounds = 0;
  while (!local.load(5)) rounds++;
  assert.ok(rounds >= 0);
  assert.equal(local.error, null);
  assert.equal(game.tick_count(), 600);
  assert.equal(game.state_hash(), live.hashes.get(600));
  // Same orders from here on as the live game: same result.
  for (let t = 600; t < 900; t++) {
    if (t % 150 === 10) game.order_move(0, Uint32Array.from(units(game, 0)), 400 + (t % 7) * 90, 500 + (t % 5) * 60, t % 300 === 10);
    local.tick();
  }
  assert.equal(game.state_hash(), live.game.state_hash());
  // The continued recording is a valid replay of the whole game.
  const again = await parseReplay(recorder.encode('replay', 900));
  assert.ok(again.ok, again.error);
});

test('a save whose game does not match its state hashes is refused', async () => {
  const live = playSkirmish(700, { saveAt: 650 });
  const data = JSON.parse(live.save);
  // A different game for the same file (as another engine build or an edited
  // order would give): the stored hash at 500 no longer matches.
  data.hashes[1][1] = '0123456789abcdef';
  const r = await parseReplay(JSON.stringify(data));
  assert.ok(r.ok, r.error);
  const game = newGame(Game, r.replay);
  const local = new LocalDriver(game, { player: 0, preload: r.replay });
  while (!local.load(50));
  assert.match(local.error, /differs from the saved one at 0:20/);
  // Replays report it too, and keep playing.
  const c = new ReplayController(Game, { ...r.replay, kind: 'replay' });
  c.seek(700);
  while (c.seeking) c.advance(16, 40);
  assert.equal(c.diverged, 500);
});

test('files of an older build say which version made them; files of this build stay strict', async () => {
  const a = playSkirmish(260, { saveAt: 250 });
  // As an older build wrote them: another engine version, options without the ones added since.
  const oldFile = (text) => {
    const v = JSON.parse(text);
    v.engine = '0.4.0+0ld0ld00';
    for (const k of ['mapStyle', 'biome', 'weather']) delete v.options[k];
    return JSON.stringify(v);
  };
  for (const text of [oldFile(a.save), oldFile(a.recorder.encode('replay', 260))]) {
    const r = await parseReplay(text, { version: version() });
    assert.ok(r.ok && r.foreign, r.error);
    assert.equal(r.replay.engine, '0.4.0+0ld0ld00');
    const msg = engineMismatch(r.replay, version());
    assert.match(msg, /made with WebRA 0\.4\.0\+0ld0ld00/);
    assert.match(msg, /only load in the version that made them/);
    // Without a version to compare (and for this build's own files) the settings are checked in full.
    assert.equal((await parseReplay(text)).ok, false);
  }
  // A file claiming this build but missing the options is refused.
  const v = JSON.parse(a.save);
  delete v.options.weather;
  const strict = await parseReplay(JSON.stringify(v), { version: version() });
  assert.equal(strict.ok, false);
  assert.match(strict.error, /weather/);
  // A save of this build loads in full.
  const own = await parseReplay(a.save, { version: version() });
  assert.ok(own.ok && !own.foreign && own.replay.frames);
  // The save store: an old save lists and loads its header, so the lobby can explain it.
  const store = new SaveStore(new MemoryBackend());
  const id = await store.backend.add({ title: 'Old', createdAt: 1, ticks: 250, engine: '0.4.0+0ld0ld00', data: oldFile(a.save) });
  const loaded = await store.load(id, version());
  assert.ok(loaded.ok && loaded.foreign);
  assert.match(engineMismatch(loaded.replay, version()), /This save was made with WebRA 0\.4\.0/);
});

test('saves in the browser store: validated, listed newest first, capped', async () => {
  const store = new SaveStore(new MemoryBackend());
  const a = playSkirmish(260, { saveAt: 250 });
  await assert.rejects(store.add('{"nope":1}'), /Cannot save/);
  await assert.rejects(store.add(a.recorder.encode('replay', 260)), /Only saves/);
  const id = await store.add(a.save);
  const list = await store.list();
  assert.deepEqual(list.map((s) => [s.id, s.title, s.ticks]), [[id, 'Test skirmish', 250]]);
  assert.equal('data' in list[0], false);
  const loaded = await store.load(id);
  assert.ok(loaded.ok);
  await store.remove(id);
  assert.equal((await store.load(id)).ok, false);
  for (let i = 0; i < 50; i++) await store.backend.add({ title: 'x', createdAt: i, ticks: 1, engine: 'v', data: '' });
  await assert.rejects(store.add(a.save), /50 saves/);
});

const ONLINE = {
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
  cheats: false,
  mapStyle: 'land',
  biome: 'temperate',
  weather: 'full',
};

/** The server's relay in memory, with its order log as a list of non-empty frames. */
function relayHarness(options = ONLINE) {
  const relay = new Lockstep({ players: [0, 1], delay: 3 });
  const log = [];
  const clients = new Map();
  const hashes = [];
  const deliver = (frames) => {
    for (const f of frames) {
      if (f.orders.length) log.push([f.tick, f.orders]);
      for (const c of clients.values()) if (c.live) c.inbox.push(f);
    }
  };
  const conn = (seat, client) => ({
    sent: [],
    orderTicks: [],
    send(msg) {
      const parsed = parseClientMessage(encodeClient(msg));
      assert.ok(parsed.ok, parsed.message);
      const m = parsed.msg;
      this.sent.push(m.t);
      if (m.t === 'orders') {
        if (m.orders.length) this.orderTicks.push(m.tick);
        deliver(relay.submit(seat, m.tick, m.orders));
      }
      if (m.t === 'defeated') relay.defeat(seat);
      if (m.t === 'hash') {
        hashes.push([seat, m.tick, m.hash]);
        assert.equal(relay.hash(seat, m.tick, m.hash), null, `desync at ${m.tick}`);
      }
      if (m.t === 'resume') {
        const tick = relay.rejoin(seat, client.record);
        client.driver.onBack(tick);
        deliver(relay.flush());
      }
    },
  });
  const add = (seat, { rejoining = false, spectator = false } = {}) => {
    const game = Game.from_options(JSON.stringify(options));
    // `seen`: the state hash at every tick count this client stopped at.
    const client = { seat, game, inbox: [], live: true, record: null, seen: new Map() };
    client.conn = conn(seat, client);
    client.driver = new LockstepDriver(client.conn, game, {
      delay: 3,
      tickMs: 40,
      rejoining,
      spectator,
      player: seat,
      onCaughtUp: () => !spectator && client.conn.send({ t: 'resume' }),
      onCheck: (ok) => (client.checked = ok),
    });
    clients.set(client, client);
    return client;
  };
  const run = (steps, extra = () => {}) => {
    for (let i = 0; i < steps; i++) {
      extra(i);
      for (const c of clients.values()) {
        if (!c.live) continue;
        for (const f of c.inbox.splice(0)) c.driver.onFrame(f);
        c.driver.advance(40);
        c.seen.set(c.game.tick_count(), c.game.state_hash());
      }
    }
  };
  return { relay, log, clients, add, run, deliver, hashes };
}

test('a player drops out, rejoins from the order log, catches up and plays on in sync', () => {
  const h = relayHarness();
  const a = h.add(0);
  const b = h.add(1);
  h.deliver(h.relay.initialFrames());
  h.run(200, (i) => {
    if (i === 20) a.game.order_move(0, Uint32Array.from(units(a.game, 0)), 900, 900, true);
    if (i === 50) b.game.order_smart(1, Uint32Array.from(units(b.game, 1)), 300, 300);
  });
  // B's connection drops: the relay stops waiting for it, A plays on alone.
  b.live = false;
  const { frames, record } = h.relay.suspend(1);
  h.deliver(frames);
  h.run(150, (i) => {
    if (i === 10) a.game.order_stop(0, Uint32Array.from(units(a.game, 0)));
  });
  assert.ok(a.driver.next > 300, `A ran on to ${a.driver.next}`);

  // B reloads: a fresh game catches up from the start message, the log and sync.
  h.clients.delete(b);
  const b2 = h.add(1, { rejoining: true });
  b2.record = record;
  b2.live = false;
  assert.equal(b2.driver.catchingUp, true);
  b2.driver.onLog({ frames: h.log.filter(([t]) => t < h.relay.next) });
  b2.driver.onSync({ tick: h.relay.next, check: h.relay.agreed });
  b2.live = true;
  assert.ok(h.relay.agreed, 'the relay has an agreed hash to check against');
  h.run(400, (i) => {
    if (i === 100) b2.game.order_move(1, Uint32Array.from(units(b2.game, 1)), 700, 200, false);
  });
  assert.equal(b2.checked, true, 'the fast-forwarded state matches the agreed hash');
  assert.equal(b2.driver.sending, true);
  assert.ok(b2.conn.sent.includes('resume'));
  // The relay compared both players' hashes after the rejoin (a mismatch fails the harness).
  assert.ok(h.hashes.some(([seat, tick]) => seat === 1 && tick >= b2.driver.joinTick));
  assert.ok(h.relay.agreed.tick >= b2.driver.joinTick);
  // Let B run the frames it already has, then both are at the same tick and state.
  // Both computed the same state at every tick they both stopped at.
  const common = [...a.seen.keys()].filter((t) => b2.seen.has(t) && t > b2.driver.joinTick);
  assert.ok(common.length > 10, `${common.length} common ticks`);
  for (const t of common) assert.equal(a.seen.get(t), b2.seen.get(t), `tick ${t}`);
  // B's orders after the rejoin reached the game (A sees them too).
  assert.ok(h.log.some(([t, o]) => t >= b2.driver.joinTick && o.some(([p]) => p === 1)));
});

test('a defeated player tells the server, keeps watching in sync and never sends an order again', () => {
  const h = relayHarness({ ...ONLINE, cheats: true });
  const a = h.add(0);
  const b = h.add(1);
  h.deliver(h.relay.initialFrames());
  h.run(40);
  assert.equal(b.game.player_defeated(1), false);
  // A destroys everything B owns (cheat), B keeps clicking.
  const table = a.game.actor_table();
  const ids = [];
  for (let i = 0; i + 1 < table.length; i += 2) if (table[i] !== 0xffffffff && (table[i + 1] & 0xff) === 1) ids.push(table[i]);
  assert.ok(ids.length > 0);
  a.game.dev_kill(0, Uint32Array.from(ids));
  h.run(80, (i) => {
    if (i % 10 === 0) b.game.order_move(1, Uint32Array.from(units(b.game, 1)), 500, 500, false);
  });
  assert.ok(b.game.player_defeated(1) && a.game.player_defeated(1), 'every peer agrees');
  assert.ok(b.driver.defeated);
  assert.equal(b.conn.sent.filter((t) => t === 'defeated').length, 1, 'told the server once');
  assert.ok(h.relay.defeated.has(1));
  const defeatTick = b.game.tick_count();
  h.run(60, (i) => {
    if (i % 10 === 0) b.game.order_move(1, Uint32Array.from(units(b.game, 1)), 900, 300, true);
  });
  assert.ok(b.conn.orderTicks.every((t) => t < defeatTick), 'no orders after the defeat');
  assert.ok(!h.log.some(([t, o]) => t > defeatTick && o.some(([p]) => p === 1)), 'none reached a frame');
  const common = [...a.seen.keys()].filter((t) => b.seen.has(t) && t > defeatTick);
  assert.ok(common.length > 10);
  for (const t of common) assert.equal(a.seen.get(t), b.seen.get(t), `tick ${t}: still in sync`);
});

test('spectators catch up and follow, but never send orders or hashes', () => {
  const h = relayHarness();
  const a = h.add(0);
  const b = h.add(1);
  h.deliver(h.relay.initialFrames());
  h.run(120, (i) => {
    if (i === 30) a.game.order_move(0, Uint32Array.from(units(a.game, 0)), 800, 800, true);
  });
  const w = h.add(0, { spectator: true, rejoining: true });
  w.live = false;
  w.driver.onLog({ frames: h.log.slice() });
  w.driver.onSync({ tick: h.relay.next, check: null });
  w.live = true;
  w.game.order_move(0, Uint32Array.from(units(w.game, 0)), 10, 10, false);
  h.run(100);
  assert.deepEqual(w.conn.sent, [], 'nothing sent');
  const common = [...a.seen.keys()].filter((t) => w.seen.has(t) && t > 130);
  assert.ok(common.length > 10, `${common.length} common ticks`);
  for (const t of common) assert.equal(a.seen.get(t), w.seen.get(t), `tick ${t}`);
  // The observer view and stats work on a spectator's game.
  assert.ok(w.game.build_render(OBSERVER_VIEW, 1, 0, 0, 4000, 4000) > 0);
  const stats = JSON.parse(w.game.observer_stats());
  assert.equal(stats.length, 3);
  assert.ok(stats.every((s) => Number.isInteger(s.armyValue) && Number.isInteger(s.unitsKilled)));
});

test('view-only games cannot give orders; income is per minute', () => {
  const game = Game.from_options(JSON.stringify(replayOptions(SKIRMISH)));
  game.set_lockstep(true);
  const ro = viewOnly(game);
  ro.order_move(0, Uint32Array.from(units(game, 0)), 100, 100, false);
  ro.start_production(0, 'E1', 1);
  ro.dev_give_cash(0);
  ro.order_scatter?.(0, Uint32Array.from(units(game, 0)));
  ro.set_stance?.(0, Uint32Array.from(units(game, 0)), 'hold_fire');
  assert.equal(game.take_orders(), '[]');
  assert.equal(ro.cursor_action(0, Uint32Array.from([1]), 0, 0), 0);
  assert.equal(ro.tick_count(), 0, 'reading still works');
  const inc = new IncomeTracker(1500);
  assert.equal(inc.sample(0, 0, 0), 0);
  assert.equal(inc.sample(0, 750, 500), 1000, 'half a minute: scaled to a minute');
  inc.sample(0, 1500, 1000);
  assert.equal(inc.sample(0, 3000, 1000), 0, 'nothing earned in the last minute');
  assert.equal(inc.sample(0, 100, 0), 0, 'seeking backwards starts over');
});

test('rejoin records: stored per tab, malformed ones dropped; left messages read well', () => {
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  assert.equal(loadRejoin(storage), null);
  const rec = { id: 'a'.repeat(64), client: 3, key: 'K'.repeat(43), name: 'Tanya' };
  saveRejoin(rec, storage);
  assert.deepEqual(loadRejoin(storage), rec);
  storage.setItem('webra.rejoin.v1', JSON.stringify({ ...rec, key: 'short' }));
  assert.equal(loadRejoin(storage), null);
  assert.equal(store.size, 0, 'a malformed record is removed');
  saveRejoin(rec, storage);
  clearRejoin(storage);
  assert.equal(loadRejoin(storage), null);
  assert.match(leftText({ name: 'B', player: 1, reason: 'disconnected' }, true), /can rejoin within 2 minutes/);
  assert.match(leftText({ name: 'B', player: 1, reason: 'expired' }, true), /out of the game/);
  assert.match(leftText({ name: 'W', player: null, reason: 'left' }, true), /stopped watching/);
  assert.match(leftText({ name: 'B', player: null, reason: 'kicked' }, false), /was removed/);
});
