// End-to-end tests of the WebAssembly API exactly as the browser uses it.
// Run after `npm run build:wasm` (see README): node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game, version } from '../pkg/webra_sim.js';

const wasmPath = fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url));
const wasm = initSync({ module: readFileSync(wasmPath) });

const OPTIONS = {
  seed: 1234,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'Commander', faction: 'germany', color: 0 },
    { slot: 1, type: 'ai', difficulty: 'normal', faction: 'russia', color: 1 },
  ],
  startingCash: 5000,
  startingUnits: 'mcv',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: false,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: true,
};

const newGame = (overrides = {}) => Game.from_options(JSON.stringify({ ...OPTIONS, ...overrides }));
const ticks = (game, n) => {
  for (let i = 0; i < n; i++) game.tick();
};
const ownUnits = (game) => Array.from(game.select_box(0, -1e9, -1e9, 1e9, 1e9));
const actor = (game, id) => JSON.parse(game.actor_json(id));

test('version is semver plus a commit', () => {
  assert.match(version(), /^\d+\.\d+\.\d+\+[0-9a-z]+$/);
});

test('map preview is RGBA per cell', () => {
  const px = Game.map_preview(7, 64);
  assert.equal(px.length, 64 * 64 * 4);
  assert.ok(px.every((v, i) => i % 4 !== 3 || v === 255), 'opaque');
});

test('rules list every buildable actor with metadata', () => {
  const rules = JSON.parse(newGame().rules_json());
  const ids = rules.actors.map((a) => a.id);
  for (const id of ['FACT', 'MCV', '4TNK', 'TTNK', 'CTNK', 'DTRK', 'TSLA', 'GAP', 'IRON', 'PDOX', 'MSLO', 'SYRD']) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(rules.actors.every((a) => a.name && a.cost >= 0 && a.hp > 0));
});

test('bad options are rejected with a message', () => {
  assert.throws(() => Game.from_options('{'), /bad options/);
  assert.throws(() => newGame({ players: [{ type: 'human', faction: 'atlantis' }, { type: 'ai', faction: 'russia' }] }), /unknown faction/);
});

test('MCV start: deploy, build a power plant and place it', () => {
  const game = newGame();
  const [mcv] = ownUnits(game);
  assert.equal(actor(game, mcv).type, 'MCV');
  assert.equal(game.deploy_state(0, mcv), 1);
  game.deploy(0, Uint32Array.from([mcv]));
  ticks(game, 1);
  let state = JSON.parse(game.player_json(0));
  assert.equal(state.hasProducer[0], true, 'construction yard deployed');

  game.start_production(0, 'POWR', 1);
  ticks(game, 200);
  state = JSON.parse(game.player_json(0));
  assert.equal(state.queues[0][0].done, true);
  // Find a legal spot next to the yard via the placement preview.
  const [sx, sy] = game.start_position(0).map((v) => Math.floor(v / 24));
  let placed = false;
  for (let dy = -4; dy <= 6 && !placed; dy++) {
    for (let dx = 2; dx <= 6 && !placed; dx++) {
      const cells = game.placement_preview(0, 'POWR', sx + dx, sy + dy);
      let ok = cells.length > 0;
      for (let i = 2; i < cells.length; i += 3) ok = ok && cells[i] === 1;
      if (ok) {
        game.place_building(0, 'POWR', sx + dx, sy + dy);
        placed = true;
      }
    }
  }
  assert.ok(placed, 'found a placement');
  ticks(game, 1);
  state = JSON.parse(game.player_json(0));
  assert.equal(state.powerGenerated, 100);
  const tent = state.buildable.find((b) => b.id === 'TENT');
  assert.equal(tent.enabled, true);
  const barr = state.buildable.find((b) => b.id === 'BARR');
  assert.equal(barr.exclusive, 'Soviet only');
});

test('selling a structure refunds money', () => {
  const game = newGame({ startingUnits: 'base' });
  ticks(game, 1);
  const before = JSON.parse(game.player_json(0)).cash;
  // The construction yard is under the start position.
  const [x, y] = game.start_position(0);
  const yard = game.pick(0, x, y);
  assert.ok(game.sell_value(0, yard) > 0);
  game.sell(0, yard);
  ticks(game, 1);
  assert.equal(JSON.parse(game.player_json(0)).cash, before + 1000, '50% of 2000');
});

test('render buffers are produced for the view', () => {
  const game = newGame({ startingUnits: 'light' });
  ticks(game, 5);
  game.set_selection(Uint32Array.from(ownUnits(game)));
  const n = game.build_render(0, 0.5, 0, 0, 64 * 24, 64 * 24);
  assert.ok(n >= 5, `sprites: ${n}`);
  const sprites = new Float32Array(wasm.memory.buffer, game.sprite_ptr(), n * 8);
  assert.ok(sprites.every(Number.isFinite));
  assert.ok(game.rect_count() > 0, 'selection brackets and health bars');
  const fog = new Uint8Array(wasm.memory.buffer, game.fog_ptr(0), game.fog_len());
  assert.equal(fog.length, 64 * 64);
  assert.ok(fog.some((v) => v === 255) && fog.some((v) => v === 0), 'visible area and shroud');
});

test('orders: smart move and stop', () => {
  const game = newGame({ startingUnits: 'light' });
  const units = ownUnits(game);
  const before = units.map((id) => actor(game, id));
  game.order_smart(0, Uint32Array.from(units), 40 * 24, 40 * 24);
  ticks(game, 50);
  game.order_stop(0, Uint32Array.from(units));
  ticks(game, 1);
  assert.ok(units.length >= 4);
  assert.deepEqual(before.map((a) => a.type).sort(), units.map((id) => actor(game, id).type).sort());
});

test('same seed gives the same game', () => {
  const a = newGame();
  const b = newGame();
  ticks(a, 600);
  ticks(b, 600);
  assert.equal(a.state_hash(), b.state_hash());
});
