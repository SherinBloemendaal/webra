// Generated map previews off the main thread (js/mappreview.js,
// js/mappreview-worker.js) and the New seed loader in the skirmish and
// online lobbies: latest wins, the cache, the worker and its fallback, the
// button and preview states. Synthetic seeds and maps only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeEvent, installDom, uninstallDom } from './dom-fixtures.mjs';
import { initSync, Game } from '../pkg/webra_sim.js';
import { GeneratedPreviews, StalePreview, computePreview, previewBackend, previewKey } from '../js/mappreview.js';
import { defaultRegistry } from '../js/registry.js';

const WASM = readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url)));
initSync({ module: WASM });

afterEach(() => {
  delete globalThis.requestAnimationFrame;
  uninstallDom();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const req = (seed, extra = {}) => ({ seed, size: 64, players: 2, style: 'land', biome: 'temperate', ...extra });

/** A backend whose generations the test finishes by hand. */
function manualBackend() {
  const calls = [];
  const backend = (r) =>
    new Promise((resolve, reject) => {
      calls.push({ r, resolve: () => resolve({ rgba: new Uint8Array(r.size * r.size * 4).fill(r.seed % 256), spawns: [1, 2, 3, 4] }), reject });
    });
  return { calls, backend };
}

const outcome = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e }));

test('latest wins: a waiting request is replaced and never starts; an overtaken running one is cached but stale', async () => {
  const { calls, backend } = manualBackend();
  const previews = new GeneratedPreviews({ backend });
  const a = outcome(previews.request(req(1)));
  await tick();
  assert.equal(calls.length, 1, 'one generation at a time');
  const b = outcome(previews.request(req(2)));
  const c = outcome(previews.request(req(3)));
  assert.ok((await b).err instanceof StalePreview, 'the waiting one is replaced');
  assert.equal(previews.busy, true);
  calls[0].resolve();
  assert.ok((await a).err instanceof StalePreview, 'overtaken while running');
  assert.ok(previews.get(req(1)), 'but its map is kept');
  await tick();
  assert.deepEqual(calls.map((x) => x.r.seed), [1, 3], 'seed 2 never started');
  calls[1].resolve();
  const done = await c;
  assert.deepEqual(done.ok.spawns, [[1, 2], [3, 4]]);
  await tick();
  assert.equal(previews.busy, false);
  // Back to a known seed: at once, from the cache, and nothing else waits.
  assert.equal((await outcome(previews.request(req(1)))).ok, previews.get(req(1)));
  assert.equal(calls.length, 2);
  // The same request twice shares one generation.
  const d1 = previews.request(req(4));
  const d2 = previews.request(req(4));
  assert.equal(d1, d2);
  await tick();
  calls[2].resolve();
  await d1;
});

test('the cache keeps the last few maps', async () => {
  const previews = new GeneratedPreviews({ backend: async (r) => ({ rgba: new Uint8Array(4), spawns: [r.seed, 0] }), limit: 2 });
  for (const s of [1, 2, 3]) await previews.request(req(s));
  assert.equal(previews.get(req(1)), null);
  assert.ok(previews.get(req(2)) && previews.get(req(3)));
  assert.equal(previewKey(req(5)), '5/64/2/land/temperate');
});

test('the quick spawns are the spawns of the generated map file, and the preview is the engine preview', () => {
  for (const r of [req(11), req(12, { size: 96, players: 4, style: 'rivers', biome: 'snow' })]) {
    const got = computePreview(Game, r);
    const file = JSON.parse(Game.generated_map_styled(r.seed, r.size, r.players, r.style, 'temperate'));
    assert.deepEqual(got.spawns, file.spawns.flat());
    assert.deepEqual([...got.rgba], [...Game.map_preview_styled(r.seed, r.size, r.players, r.style, r.biome)]);
  }
});

/** A Worker stand-in that runs js/mappreview-worker.js in this process (its port is a message channel). */
async function workerClass() {
  const port = {};
  globalThis.__webraPreviewPort = port;
  await import(`../js/mappreview-worker.js?run=${Date.now()}`);
  delete globalThis.__webraPreviewPort;
  const made = [];
  class FakeWorker {
    constructor(url, opts) {
      made.push({ url: String(url), opts });
      port.postMessage = (data) => setTimeout(() => this.onmessage?.({ data }), 0);
    }
    postMessage(data) {
      setTimeout(() => port.onmessage({ data }), 0);
    }
    terminate() {}
  }
  return { FakeWorker, made };
}

test('the worker makes the preview and the spawns with the page engine module', async () => {
  const { FakeWorker, made } = await workerClass();
  const backend = previewBackend({ Game, module: new WebAssembly.Module(WASM), WorkerClass: FakeWorker });
  const previews = new GeneratedPreviews({ backend });
  const r = req(21, { size: 96, players: 3 });
  const got = await previews.request(r);
  assert.equal(made.length, 1);
  assert.match(made[0].url, /mappreview-worker\.js$/);
  assert.equal(made[0].opts.type, 'module');
  const local = computePreview(Game, r);
  assert.deepEqual(got.spawns.flat(), local.spawns);
  assert.equal(got.rgba.length, 96 * 96 * 4);
  await previews.request(req(22));
  assert.equal(made.length, 1, 'one worker for every preview');
});

test('without a worker, or when it cannot load, previews are made on the page after a timeout', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    class Broken {
      constructor() {
        throw new Error('no workers here');
      }
    }
    const previews = new GeneratedPreviews({ backend: previewBackend({ Game, module: {}, WorkerClass: Broken }) });
    const got = await previews.request(req(31));
    assert.deepEqual(got.spawns.flat(), computePreview(Game, req(31)).spawns);
    const none = new GeneratedPreviews({ backend: previewBackend({ Game, module: null, WorkerClass: null }) });
    let sync = true;
    const p = none.request(req(32)).then(() => assert.equal(sync, false, 'not in the same task as the click'));
    sync = false;
    await p;
  } finally {
    console.warn = warn;
  }
});

// ---- The skirmish lobby ---------------------------------------------------------------------

async function skirmish(previews, reduced = false) {
  const doc = installDom();
  globalThis.requestAnimationFrame = (f) => (queueMicrotask(f), 1);
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  const root = doc.createElement('section');
  doc.body.append(root);
  defaultRegistry().set('lobby', 'lastOptions', { seed: 100, mapSize: 64, mapStyle: 'land', biome: 'temperate' });
  const { Lobby } = await import('../js/lobby.js');
  const drawn = [];
  const lobby = new Lobby(root, {
    colors: Array.from({ length: 8 }, () => [1, 1, 1]),
    colorNames: [],
    maps: {
      preview: () => {
        throw new Error('not on the main thread');
      },
      spawns: () => {
        throw new Error('not on the main thread');
      },
      validate: () => ({ ok: true, errors: [], modded: false, hash: 'h' }),
      filePreview: () => new Uint8Array(0),
    },
    previews,
    reducedMotion: () => reduced,
    onStart: () => {},
    onStress: () => {},
  });
  lobby.canvas.getContext = () => ({ putImageData: (img) => drawn.push(img.data[0]), clearRect() {} });
  lobby.ctx = lobby.canvas.getContext();
  return { root, lobby, drawn };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

test('skirmish lobby: New seed shows a loader, disables itself and Start game until the map is made off the page', async () => {
  const { calls, backend } = manualBackend();
  const { lobby, drawn } = await skirmish(new GeneratedPreviews({ backend }));
  await settle();
  calls.at(-1).resolve();
  await settle();
  assert.equal(lobby.previewBusy, false);
  assert.equal(lobby.startBtn.disabled, false);
  assert.equal(lobby.diceBtn.getAttribute('aria-busy'), 'false');

  lobby.diceBtn.click();
  assert.equal(lobby.diceBtn.disabled, true, 'at once');
  assert.equal(lobby.diceBtn.getAttribute('aria-busy'), 'true');
  assert.ok(lobby.diceBtn.classList.contains('is-busy'));
  assert.equal(lobby.diceBtn.classList.contains('is-still'), false, 'the die turns');
  assert.equal(lobby.diceBtn.querySelector('.lobby-dice-text').textContent, 'Generating...');
  assert.equal(lobby.startBtn.disabled, true);
  assert.equal(lobby.problemText.textContent, 'Generating the map...');
  await settle();
  assert.equal(lobby.previewLoading.hidden, false, 'the preview says it is generating');
  assert.equal(lobby.previewFrame$.getAttribute('aria-busy'), 'true');
  assert.equal(lobby.markerList.length, 0, 'no markers of the old map');
  const before = drawn.length;
  calls.at(-1).resolve();
  await settle();
  assert.equal(drawn.length, before + 1, 'drawn when ready');
  assert.equal(lobby.diceBtn.disabled, false);
  assert.equal(lobby.diceBtn.querySelector('.lobby-dice-text').textContent, 'New seed');
  assert.equal(lobby.previewLoading.hidden, true);
  assert.equal(lobby.startBtn.disabled, false);
  assert.equal(lobby.markerList.length, 2, 'the new map has its markers');
});

test('skirmish lobby: rapid changes draw only the latest map; Reduce motion keeps the loader still', async () => {
  const { calls, backend } = manualBackend();
  const { root, lobby, drawn } = await skirmish(new GeneratedPreviews({ backend }), true);
  await settle();
  calls.at(-1).resolve();
  await settle();
  const seed = root.querySelector('.lobby-seed');
  for (const v of ['501', '502', '503']) {
    seed.value = v;
    seed.dispatchEvent(new FakeEvent('input'));
    await settle();
  }
  // 501 runs, 502 was replaced while waiting, 503 waits.
  assert.deepEqual(calls.map((c) => c.r.seed), [100, 501]);
  calls[1].resolve();
  await settle();
  assert.deepEqual(calls.map((c) => c.r.seed), [100, 501, 503], 'the newest runs next, 502 never');
  assert.equal(lobby.previewBusy, true, 'still waiting for 503: the 501 map is not drawn');
  const before = drawn.length;
  calls[2].resolve();
  await settle();
  assert.equal(drawn.length, before + 1);
  assert.equal(drawn.at(-1), 503 % 256, 'the latest map is on show');
  assert.equal(lobby.previewBusy, false);
  lobby.diceBtn.click();
  assert.ok(lobby.diceBtn.classList.contains('is-still'), 'Reduce motion: no turning');
});

// ---- The online lobby -----------------------------------------------------------------------------

test('online lobby: the host New seed waits for the lobby and the map; Start game waits too', async () => {
  installDom();
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  const { calls, backend } = manualBackend();
  const { OnlineUI } = await import('../js/online.js');
  const sent = [];
  const ui = Object.create(OnlineUI.prototype);
  Object.assign(ui, {
    root: globalThis.document.createElement('div'),
    lens: null,
    ctx: { colors: [], colorNames: [], previews: new GeneratedPreviews({ backend }), reducedMotion: () => false, Game: { map_preview_styled: () => assert.fail('not on the main thread'), generated_map_styled: () => assert.fail('not on the main thread') } },
    installed: new Map(),
    missionPreviews: new Map(),
    missionEntries: new Map(),
    mapStatus: { text: '', ok: true },
    mapNotice: null,
    mapOffer: null,
    send: (m) => sent.push(m),
    libraryMaps: [],
    serverMaps: [],
    state: {
      you: 1,
      hostId: 1,
      session: { id: 'a'.repeat(64), name: 'Test', public: false },
      slots: [{ type: 'human', client: 1, name: 'Host', faction: 'random', color: 0, team: 0 }, { type: 'ai', difficulty: 'normal', bot: 'normal', faction: 'random', color: 1, team: 0 }],
      options: { seed: 9, mapSize: 64, mapStyle: 'land', biome: 'snow', techBuildings: 'standard', separateTeamSpawns: true },
      map: null,
      mission: null,
      spectators: [],
      maxSpectators: 2,
      role: 'player',
    },
  });
  const error = console.error;
  console.error = () => {};
  try {
    ui.buildLobby();
    ui.renderLobby();
    const dice = () => ui.mapBox.querySelectorAll('button').find((b) => b.classList.contains('online-dice'));
    assert.equal(ui.previewBusy, true);
    assert.ok(ui.mapBox.querySelector('.online-preview-loading'));
    assert.equal(ui.startBtn.disabled, true);
    assert.equal(dice().getAttribute('aria-busy'), 'true');
    await settle();
    calls.at(-1).resolve();
    await settle();
    assert.equal(ui.previewBusy, false, 'rendered again once made');
    assert.equal(ui.mapBox.querySelector('.online-preview-loading'), null);
    assert.equal(ui.startBtn.disabled, false);
    assert.equal(ui.markerList.length, 2);
    // New seed: busy at once, while the server answers.
    dice().click();
    const seed = sent.at(-1).options.seed;
    assert.equal(dice().disabled, true);
    ui.renderLobby();
    assert.equal(dice().getAttribute('aria-busy'), 'true', 'still busy until the lobby has the seed');
    ui.onLobby({ slots: ui.state.slots, options: { ...ui.state.options, seed }, map: null, hostId: 1, spectators: [], maxSpectators: 2 });
    assert.equal(ui.seedPending, null);
    assert.equal(dice().getAttribute('aria-busy'), 'true', 'now the map is made');
    await settle();
    assert.equal(calls.at(-1).r.seed, seed);
    calls.at(-1).resolve();
    await settle();
    assert.equal(dice().getAttribute('aria-busy'), 'false');
    assert.equal(dice().disabled, false);
  } finally {
    console.error = error;
  }
});
