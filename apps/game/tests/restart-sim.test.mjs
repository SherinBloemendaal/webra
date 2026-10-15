// Restart in place, the simulation side (js/sim/host.js dispose): every game
// of a page gets a simulation of its own, and the one it replaces goes
// completely. A worker is terminated; on the main thread the engine's game
// is freed (the page keeps one wasm instance, so a game left behind would
// keep its memory until the tab closes). Needs the built engine (npm run
// build:wasm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Game, version } from '../pkg/webra_sim.js';
import { createSimHost } from '../js/sim/host.js';
import { NodeWorker, nodeEnv, SKIRMISH, WASM_PATH, wasmModule } from './sim-fixtures.mjs';

const wasm = initSync({ module: readFileSync(WASM_PATH) });
const OPTIONS = SKIRMISH;
const spec = () => ({
  kind: 'skirmish',
  options: OPTIONS,
  map: null,
  player: 0,
  recorder: { mode: 'skirmish', options: OPTIONS, map: null, mapHash: null, player: 0, engine: version(), title: 'Restart' },
  tickMs: 40,
});

/** NodeWorker that counts the threads alive. */
let alive = 0;
class CountingWorker extends NodeWorker {
  constructor(url, options) {
    super(url, options);
    alive++;
    this.ended = false;
  }

  terminate() {
    if (!this.ended) alive--;
    this.ended = true;
    return super.terminate();
  }
}

test('restarting on the main thread frees each game: the same game again, nothing kept', async () => {
  const games = [];
  const hashes = [];
  for (let round = 0; round < 3; round++) {
    const host = await createSimHost({ Game, memory: () => wasm.memory, env: nodeEnv('direct') });
    assert.equal(host.mode, 'direct');
    await host.start(spec());
    const game = host.core.game;
    games.push(game);
    host.step({ dt: 40, view: 0, rect: [0, 0, 1000, 1000] });
    hashes.push(await host.command('stateHash'));
    // The replay of the game that is left, encoded before it goes (js/account/replays.js GameReplay).
    const { text } = await host.command('encode', ['replay']);
    assert.ok(text.length > 0);
    host.dispose();
    assert.equal(game.__wbg_ptr, 0, `game ${round + 1} is freed`);
    assert.equal(host.core.game, null);
    // A second dispose (a failed setup after a teardown) is harmless.
    host.dispose();
  }
  assert.equal(new Set(games).size, 3, 'a new game per start');
  assert.equal(new Set(hashes).size, 1, 'the same settings make the same game every time');
});

test('restarting with the simulation in a worker terminates each worker: never more than one runs', async () => {
  const module = wasmModule();
  for (let round = 0; round < 3; round++) {
    const host = await createSimHost({ Game, memory: () => wasm.memory, module, env: nodeEnv('transfer'), WorkerClass: CountingWorker });
    assert.equal(host.mode, 'transfer');
    const info = await host.start(spec());
    assert.equal(info.mapWidth, 64);
    assert.equal(alive, 1, `round ${round + 1}: one worker`);
    host.dispose();
    assert.equal(alive, 0, `round ${round + 1}: the worker is gone`);
  }
});
