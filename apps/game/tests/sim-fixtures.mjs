// Test helpers for the simulation worker boundary (js/sim): a browser-like
// Worker class on top of Node's worker_threads, the compiled engine module,
// and a scripted skirmish that the tests play directly and through hosts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';

export const WASM_PATH = fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url));

/** The engine compiled once, as the page does (js/main.js), to hand to workers. */
export const wasmModule = () => new WebAssembly.Module(readFileSync(WASM_PATH));

/** `new Worker(url, { type: 'module' })` with the browser's message API, run on worker_threads. */
export class NodeWorker {
  constructor(_url, _options) {
    this.onmessage = null;
    this.onerror = null;
    this.thread = new ThreadWorker(new URL('./sim-worker-boot.mjs', import.meta.url));
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (err) => this.onerror?.({ message: err.message, preventDefault() {} }));
  }

  postMessage(msg, transfer = []) {
    this.thread.postMessage(msg, transfer);
  }

  terminate() {
    return this.thread.terminate();
  }
}

/** Environment flags for js/sim/modes.js chooseSimMode in Node. */
export const nodeEnv = (requested) => ({ worker: true, moduleWorker: true, sharedMemory: true, isolated: true, requested });

export const SKIRMISH = {
  seed: 4321,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'Me', faction: 'england', color: 0, team: 0 },
    { slot: 1, type: 'ai', difficulty: 'normal', faction: 'russia', color: 1, team: 0 },
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
  cheats: false,
  mapStyle: 'land',
  biome: 'temperate',
  weather: 'full',
};

/**
 * The scripted player of the boundary tests: orders at fixed ticks, given
 * through `game` (a wasm Game, or a host's game handle) between ticks.
 * `units` lists the player's own units at that moment.
 */
export function scriptedOrders(tick, game, units) {
  if (tick % 150 === 10 && units.length) {
    game.order_move(0, Uint32Array.from(units), 400 + (tick % 7) * 90, 500 + (tick % 5) * 60, tick % 300 === 10);
  }
  if (tick === 60) game.start_production(0, 'E1', 3);
  if (tick === 200 && units.length) game.set_stance(0, Uint32Array.from(units), 'hold_fire');
}

/** Wait for the event loop (worker messages) until `cond()` or the timeout. */
export async function until(cond, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 1));
  }
}
