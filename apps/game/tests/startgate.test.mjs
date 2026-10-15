// A game starts only once its loading screen is gone (docs/contracts.md
// section 8, "Start"): js/main.js runGame holds the simulation at tick 0
// (js/sim/core.js `held`), draws the first frame behind the screen, and
// starts the game on the screen's `closed` (js/loadingscreen.js) through
// js/gamesession.js GameStart. Played headless with the real engine and a
// Normal AI. Needs the built engine (npm run build:wasm).
//
// The cause this guards against: a tab hidden while the game loads gets no
// animation frames (so no first frame, and the screen stays), but a local
// game ticked on the background timer (Settings > "Pause when the game is
// hidden" off, the default) from the moment the page became hidden. Back on
// the tab the screen closed on the first frame over a game that had played
// on for as long as the tab was away: the AI's base was already up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Game, version } from '../pkg/webra_sim.js';
import { createSimHost } from '../js/sim/host.js';
import { SimCore } from '../js/sim/core.js';
import { FirstFrameGuard, LoadingScreen, loadingPlan } from '../js/loadingscreen.js';
import { GameStart, GameSession, MAX_FRAME_MS } from '../js/gamesession.js';
import { LocalDriver, Recorder } from '../js/replay.js';
import { sendLoaded } from '../js/net.js';
import { C2S, parseReplay } from '../js/protocol.js';
import { FakeEvent, installDom, uninstallDom } from './dom-fixtures.mjs';
import { NodeWorker, nodeEnv, SKIRMISH, until, WASM_PATH, wasmModule } from './sim-fixtures.mjs';

const wasm = initSync({ module: readFileSync(WASM_PATH) });
const TICK_MS = 40;
const FRAME_MS = 1000 / 60;
const RECT = [0, 0, 1536, 1536];
const AI = 1;
const recording = (title) => ({ mode: 'skirmish', options: SKIRMISH, map: null, mapHash: null, player: 0, engine: version(), title });
const skirmish = (held = true) => ({ kind: 'skirmish', options: SKIRMISH, map: null, player: 0, recorder: recording('Start'), tickMs: TICK_MS, held });

/** The AI's statistics (engine observer.rs): what it built, spent and ordered. */
function aiStats(game) {
  return JSON.parse(game.observer_stats()).find((p) => p.player === AI);
}

/** The state of a fresh game of SKIRMISH at tick 0. */
const fresh = (() => {
  const g = Game.from_options(JSON.stringify(SKIRMISH));
  const out = { hash: g.state_hash(), ai: aiStats(g) };
  g.free();
  return out;
})();

/** Timers the test runs by hand: `run(ms)` moves their clock on. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    now: () => now,
    setInterval: (fn, ms) => (intervals.set(nextId, { fn, ms, at: now + ms }), nextId++),
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn, ms) => (timeouts.set(nextId, { fn, at: now + ms }), nextId++),
    clearTimeout: (id) => timeouts.delete(id),
    get pending() {
      return intervals.size + timeouts.size;
    },
    run(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of [...intervals, ...timeouts]) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (intervals.has(id)) t.at += t.ms;
        else timeouts.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

/** The loading screen in a fake page, with a close transition of `closeMs` run by `timers`. */
function screen({ closeMs = 300, reduced = false, timers = manualTimers() } = {}) {
  const doc = installDom();
  const root = doc.createElement('section');
  root.id = 'loading';
  doc.body.append(doc.createElement('main'), root);
  const loader = new LoadingScreen(root, { doc, reducedMotion: () => reduced, closeMs: () => closeMs, timers });
  loader.card.focus = () => {};
  return { loader, root, timers };
}

/** The transition of the screen's close ended (the browser's event). */
function transitionEnded(root) {
  root.dispatchEvent(new FakeEvent('transitionend'));
}

/** Let promise reactions run (closed, then begin). */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * js/main.js runGame's start for `host`: the frame loop (GameStart.frame,
 * host.step) and the first frame closing the loading screen, whose `closed`
 * begins the game. `frame(now)` runs one animation frame; returns its frame.
 */
function runGame(host, loader, now = 0) {
  const started = [];
  const gameStart = new GameStart({ host, now, onStart: () => started.push(clock.now) });
  const guard = new FirstFrameGuard({ screen: loader, stop() {}, back() {} });
  const clock = { now };
  const frame = (at) => {
    clock.now = at;
    const { dt } = gameStart.frame(at);
    const f = host.step({ dt, paused: false, view: 0, rect: RECT, audio: true });
    if (f && !guard.drawn) guard.firstFrame().then(() => gameStart.begin(clock.now));
    return f;
  };
  return { gameStart, guard, frame, started, clock };
}

test('the cause: a hidden tab ticked an unheld game on the background timer while its loading screen still showed', () => {
  const timers = manualTimers();
  const core = new SimCore({ Game, memory: () => wasm.memory, timers, now: timers.now });
  core.start(skirmish(false));
  // The page went hidden while the game loaded: no animation frames, so no first frame and the screen stays up.
  assert.equal(core.command('background', [true]), true);
  timers.run(30000);
  const ticks = core.game.tick_count();
  assert.ok(ticks >= 700, `30 s of game behind the screen (${ticks} ticks)`);
  assert.ok(aiStats(core.game).buildingsBuilt >= 2, 'the AI built its base meanwhile');
  core.release();
});

test('a held game stands at tick 0: no ticks from frames, the background timer, debug steps or banked time', () => {
  const timers = manualTimers();
  const core = new SimCore({ Game, memory: () => wasm.memory, timers, now: timers.now });
  const info = core.start(skirmish());
  assert.equal(info.tick, 0);
  assert.equal(core.held, true);
  // A hidden tab: the background timer does not start while held.
  assert.equal(core.command('background', [true]), false);
  assert.equal(timers.pending, 0);
  timers.run(30000);
  assert.equal(core.idle(5000), 0);
  // Frames with any wall time (main.js passes 0; the core holds even so).
  for (let i = 0; i < 20; i++) {
    const f = core.step({ dt: 250, view: 0, rect: RECT, audio: true });
    assert.equal(f.ticks, 0);
    assert.equal(f.tick, 0);
    assert.ok(f.spriteCount > 0, 'the map and the units are drawn at tick 0');
  }
  assert.equal(core.command('debugStep'), false);
  assert.equal(core.game.state_hash(), fresh.hash, 'nothing changed');
  assert.deepEqual(aiStats(core.game), fresh.ai, 'the AI did nothing: no buildings, no spending, no orders');
  // Started: time counts from now, nothing of the wait is caught up.
  assert.equal(core.command('begin'), true);
  assert.equal(core.command('begin'), false, 'once');
  assert.equal(core.step({ dt: 30, view: 0, rect: RECT }).ticks, 0);
  assert.equal(core.step({ dt: 30, view: 0, rect: RECT }).ticks, 1);
  // The background timer works again once started.
  assert.equal(core.command('background', [true]), true);
  timers.run(1000);
  assert.ok(core.game.tick_count() >= 25 && core.game.tick_count() <= 27);
  core.release();
});

test('skirmish (main thread): tick 0 and an idle AI until the screen\'s close transition ended, then real time without a burst', async () => {
  const host = await createSimHost({ Game, memory: () => wasm.memory, env: nodeEnv('direct') });
  const timers = manualTimers();
  host.core.timers = timers;
  await host.start(skirmish());
  const { loader, root } = screen({ closeMs: 300, timers });
  loader.begin(loadingPlan('skirmish'));
  // A long setup (30 s of atlases), and the tab hidden meanwhile: the page asks for the background timer.
  const run = runGame(host, loader, 0);
  assert.equal(await host.command('background', [true]), false);
  timers.run(30000);
  let now = 30000;
  // The first frame draws the map and starts the close; the transition runs for 300 ms of frames.
  const first = run.frame(now);
  assert.equal(first.tick, 0);
  assert.equal(run.guard.drawn, true);
  assert.equal(loader.state, 'closing');
  assert.equal(root.hidden, false, 'the screen is still there while it fades');
  assert.ok(root.classList.contains('is-closing'));
  for (let i = 0; i < 18; i++) {
    now += FRAME_MS;
    assert.equal(run.frame(now).ticks, 0);
  }
  await settle();
  assert.equal(run.gameStart.started, false, 'not before the transition ended');
  // The transition ended: the screen hides, `closed` resolves, the game begins.
  let closedTick = null;
  let closedHash = null;
  let closedAi = null;
  loader.closed.then(() => {
    closedTick = host.core.game.tick_count();
    closedHash = host.core.game.state_hash();
    closedAi = aiStats(host.core.game);
  });
  transitionEnded(root);
  assert.equal(root.hidden, true);
  await settle();
  assert.equal(closedTick, 0, 'tick 0 when closed fires');
  assert.equal(closedHash, fresh.hash);
  assert.deepEqual(closedAi, fresh.ai, 'the AI has no buildings and gave no orders yet');
  assert.equal(closedAi.buildingsBuilt, 0);
  assert.equal(run.gameStart.started, true);
  assert.deepEqual(run.started, [now], 'begun at the close');
  // The first second after it: one tick per 40 ms of real time, never a burst.
  let most = 0;
  for (let i = 0; i < 60; i++) {
    now += FRAME_MS;
    most = Math.max(most, run.frame(now).ticks);
  }
  const ticks = host.core.game.tick_count();
  assert.ok(ticks >= 24 && ticks <= 25, `1 s of frames ran ${ticks} ticks`);
  assert.equal(most, 1, 'at most one tick per 16.7 ms frame');
  // A hitch after the start is capped as before.
  now += 5000;
  assert.ok(run.frame(now).ticks <= Math.ceil(MAX_FRAME_MS / TICK_MS));
  host.dispose();
  uninstallDom();
});

test('skirmish (worker): the steps in flight carry no time before the start; closed at tick 0, then real time', async () => {
  const host = await createSimHost({ Game, memory: () => wasm.memory, module: wasmModule(), env: nodeEnv('transfer'), WorkerClass: NodeWorker });
  assert.equal(host.mode, 'transfer');
  await host.start(skirmish());
  // Reduced motion: the screen goes at once with the first drawn frame.
  const { loader, root } = screen({ reduced: true });
  loader.begin(loadingPlan('skirmish'));
  const run = runGame(host, loader, 0);
  let now = 20000;
  let closedTick = null;
  loader.closed.then(() => host.command('tick').then((t) => (closedTick ??= t)));
  // Frames until the worker's first frame came back and was drawn.
  for (let i = 0; i < 400 && !run.guard.drawn; i++) {
    run.frame((now += FRAME_MS));
    await settle();
  }
  assert.equal(run.guard.drawn, true);
  assert.equal(root.hidden, true, 'no transition with Reduce motion');
  await until(() => closedTick !== null);
  assert.equal(closedTick, 0);
  assert.equal(await host.command('stateHash'), fresh.hash);
  assert.equal(run.gameStart.started, true);
  // One second of frames, each waited for (worker steps are pipelined).
  for (let i = 0; i < 60; i++) {
    run.frame((now += FRAME_MS));
    await until(() => !host.inFlight);
  }
  const ticks = await host.command('tick');
  assert.ok(ticks >= 23 && ticks <= 25, `1 s of frames ran ${ticks} ticks`);
  host.dispose();
  uninstallDom();
});

test('a replay plays from tick 0 only after the screen; a save fast-forwards behind it but plays on only after', async () => {
  // A recorded game of 300 ticks, and a save at tick 100.
  const g = Game.from_options(JSON.stringify(SKIRMISH));
  const recorder = new Recorder(recording('Replay'));
  const local = new LocalDriver(g, { player: 0, recorder });
  for (let t = 0; t < 100; t++) local.tick();
  const save = (await parseReplay(recorder.encode('save', g.tick_count(), g.state_hash()))).replay;
  for (let t = 100; t < 300; t++) local.tick();
  const replay = (await parseReplay(recorder.encode('replay', g.tick_count()))).replay;
  g.free();

  const core = new SimCore({ Game, memory: () => wasm.memory });
  core.start({ kind: 'replay', replay, tickMs: TICK_MS, held: true });
  for (let i = 0; i < 10; i++) assert.equal(core.step({ dt: 250, view: 255, rect: RECT }).ticks, 0);
  assert.equal(core.status().replay.ticks, 0);
  core.command('begin');
  core.step({ dt: 400, view: 255, rect: RECT });
  assert.equal(core.status().replay.ticks, 8, 'plays from tick 0 at the replay speed');
  core.release();

  const loading = new SimCore({ Game, memory: () => wasm.memory });
  loading.start({ kind: 'save', replay: save, tickMs: TICK_MS, held: true });
  // Behind the screen the save re-simulates (its history decides nothing new) ...
  for (let i = 0; i < 200 && loading.status().loading; i++) loading.step({ dt: 0, view: 0, rect: RECT });
  assert.equal(loading.status().loading, false);
  assert.equal(loading.game.tick_count(), 100);
  // ... and plays on only after the start.
  for (let i = 0; i < 10; i++) assert.equal(loading.step({ dt: 250, view: 0, rect: RECT }).ticks, 0);
  assert.equal(loading.game.tick_count(), 100);
  loading.command('begin');
  loading.step({ dt: 80, view: 0, rect: RECT });
  assert.equal(loading.game.tick_count(), 102);
  loading.release();
});

test('online: frames that arrive behind the screen wait (also in a hidden tab); after the start the client says loaded', async () => {
  const sent = [];
  const core = new SimCore({ Game, memory: () => wasm.memory, emit: (type, p) => type === 'send' && sent.push(p.msg) });
  core.start({ kind: 'online', options: SKIRMISH, map: null, player: 0, spectator: false, delay: 3, rejoining: false, recorder: null, tickMs: TICK_MS, held: true });
  core.command('hidden', [true]);
  for (let t = 0; t < 3; t++) core.command('net', ['frame', { tick: t, orders: [] }]);
  for (let i = 0; i < 5; i++) assert.equal(core.step({ dt: 250, view: 0, rect: RECT }).ticks, 0);
  assert.equal(core.game.tick_count(), 0);
  assert.deepEqual(sent, [], 'no orders before the start');
  core.command('hidden', [false]);
  core.command('begin');
  core.step({ dt: TICK_MS, view: 0, rect: RECT });
  assert.equal(core.game.tick_count(), 1);
  assert.equal(sent[0].t, C2S.ORDERS);
  core.release();
  // js/main.js sends `loaded` on the game's connection once it started (when the protocol has it).
  const conn = { out: [], send(m) { this.out.push(m); } };
  assert.equal(sendLoaded(conn), !!C2S.LOADED);
  assert.deepEqual(conn.out, C2S.LOADED ? [{ t: C2S.LOADED }] : []);
  assert.equal(sendLoaded(null), false);
});

test('the stress test holds the same way', () => {
  const core = new SimCore({ Game, memory: () => wasm.memory });
  core.start({ kind: 'stress', seed: 7, units: 50, size: 64, tickMs: TICK_MS, held: true });
  for (let i = 0; i < 5; i++) assert.equal(core.step({ dt: 250, view: 255, rect: RECT }).ticks, 0);
  core.command('begin');
  assert.equal(core.step({ dt: 80, view: 255, rect: RECT }).ticks, 2);
  core.release();
});

test('Restart: the next game starts after its own screen; a game left while its screen fades never starts', async () => {
  const { loader, root, timers } = screen({ closeMs: 300 });
  const session = new GameSession({ loading: { begin: (p) => loader.begin(p), fail: (m, o) => loader.fail(m, o) }, reload() {} });
  // The first game: drawn, its screen fades out.
  const host1 = await createSimHost({ Game, memory: () => wasm.memory, env: nodeEnv('direct') });
  await host1.start(skirmish());
  loader.begin(loadingPlan('skirmish'));
  const one = runGame(host1, loader, 0);
  one.frame(0);
  assert.equal(loader.state, 'closing');
  // Restart while it fades (the end of game screen cannot show yet, but the page may leave): it is left before it started.
  let host2 = null;
  let two = null;
  session.attach({ leaving: async () => one.gameStart.stop(), teardown: () => host1.dispose() });
  await session.replace({
    plan: loadingPlan('skirmish', { restart: true }),
    relaunch: async () => {
      host2 = await createSimHost({ Game, memory: () => wasm.memory, env: nodeEnv('direct') });
      await host2.start(skirmish());
      two = runGame(host2, loader, 1000);
    },
  });
  assert.equal(loader.state, 'loading', 'the restart\'s screen shows');
  assert.equal(root.classList.contains('is-closing'), false);
  timers.run(1000);
  await settle();
  assert.equal(one.gameStart.started, false, 'the left game never started');
  // The restarted game: tick 0 until its own screen is gone.
  two.frame(1000);
  for (let i = 1; i <= 10; i++) assert.equal(two.frame(1000 + i * FRAME_MS).ticks, 0);
  await settle();
  assert.equal(two.gameStart.started, false);
  timers.run(400);
  await settle();
  assert.equal(root.hidden, true);
  assert.equal(two.gameStart.started, true);
  assert.equal(host2.core.game.tick_count(), 0);
  assert.equal(host2.core.game.state_hash(), fresh.hash);
  let now = two.clock.now;
  assert.deepEqual(two.started, [now]);
  for (let i = 0; i < 60; i++) two.frame((now += FRAME_MS));
  assert.ok(host2.core.game.tick_count() >= 24 && host2.core.game.tick_count() <= 25);
  host2.dispose();
  uninstallDom();
});
