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

test('generated map files validate, hash stably and start a game', () => {
  const json = Game.generated_map(42, 64, 4);
  const map = JSON.parse(json);
  assert.equal(map.format, 1);
  assert.equal(map.spawns.length, 4);
  const v = JSON.parse(Game.validate_map(json));
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.modded, false);
  assert.match(v.hash, /^[0-9a-f]{64}$/);
  // Re-serializing in another key order keeps the identity.
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(map).reverse()));
  assert.equal(Game.map_hash(reordered), v.hash);
  const options = { ...OPTIONS, players: [...OPTIONS.players, { slot: 2, type: 'ai', faction: 'england', team: 0 }] };
  const game = Game.from_map(json, JSON.stringify(options));
  assert.equal(game.player_count(), 3);
  ticks(game, 10);
});

test('modded maps are reported and bad maps rejected', () => {
  const map = JSON.parse(Game.generated_map(1, 48, 2));
  map.rules = { actors: { '1TNK': { cost: 1 } } };
  const v = JSON.parse(Game.validate_map(JSON.stringify(map)));
  assert.equal(v.ok, true);
  assert.equal(v.modded, true);
  map.rules = { actors: { '1TNK': { cost: 'free' } } };
  assert.equal(JSON.parse(Game.validate_map(JSON.stringify(map))).ok, false);
  assert.equal(JSON.parse(Game.validate_map('{"format":1}')).ok, false);
  assert.throws(() => Game.from_map('{"format":1}', JSON.stringify(OPTIONS)));
});

test('lockstep: orders go to the outbox and frames are re-stamped', () => {
  const a = newGame({ startingUnits: 'light' });
  const b = newGame({ startingUnits: 'light' });
  a.set_lockstep(true);
  const units = ownUnits(a);
  a.order_move(0, Uint32Array.from(units), 30 * 24, 30 * 24, false);
  const out = JSON.parse(a.take_orders());
  assert.equal(out.length, 1);
  assert.equal(out[0].o, 'move');
  assert.equal(a.take_orders(), '[]', 'outbox drained');
  // A frame claiming player 1 for player 0's units does nothing: the server's stamp wins.
  const forged = JSON.stringify([[1, out]]);
  const honest = JSON.stringify([[0, out]]);
  assert.equal(a.apply_frame(honest), 1);
  assert.equal(b.apply_frame(honest), 1);
  for (let i = 0; i < 100; i++) {
    a.tick();
    b.tick();
  }
  assert.equal(a.state_hash(), b.state_hash(), 'same frames, same game');
  const c = newGame({ startingUnits: 'light' });
  c.apply_frame(forged);
  ticks(c, 100);
  assert.notEqual(c.state_hash(), a.state_hash(), 'forged orders did not move player 0 units');
  assert.throws(() => a.apply_frame('not json'));
  assert.equal(a.apply_frame('[[0,[{"o":"nope"}]],[99,[]]]'), 0, 'invalid entries skipped');
});

test('support powers: airfield timers in player_json and activate_power', async () => {
  const { validOrder } = await import('../../../packages/protocol/src/index.js');
  const map = JSON.parse(Game.generated_map(5, 64, 2));
  const [sx, sy] = map.spawns[0];
  map.actors = [
    { type: 'AFLD', owner: 0, x: sx + 4, y: sy, facing: 0 },
    { type: 'POWR', owner: 0, x: sx + 4, y: sy + 3, facing: 0 },
  ];
  const options = {
    ...OPTIONS,
    startingUnits: 'base',
    players: [
      { slot: 0, type: 'human', faction: 'russia', color: 0 },
      { slot: 1, type: 'human', faction: 'england', color: 1 },
    ],
  };
  const game = Game.from_map(JSON.stringify(map), JSON.stringify(options));
  ticks(game, 2);
  let powers = JSON.parse(game.player_json(0)).powers;
  assert.deepEqual(powers.map((p) => p.key), ['ParatroopersPower@paratroopers', 'AirstrikePower@spyplane']);
  assert.ok(powers.every((p) => p.name && !p.ready && p.charging && p.progress > 0 && p.progress < 0.01));
  assert.deepEqual(JSON.parse(game.player_json(1)).powers, [], 'no airfield, no powers');
  ticks(game, 3750);
  powers = JSON.parse(game.player_json(0)).powers;
  const spy = powers.find((p) => p.key === 'AirstrikePower@spyplane');
  assert.equal(spy.ready, true);
  assert.equal(spy.progress, 1);
  assert.equal(powers.find((p) => p.key === 'ParatroopersPower@paratroopers').ready, false);
  const before = game.actor_count();
  game.activate_power(0, spy.key, 10 * 24, 10 * 24);
  ticks(game, 1);
  assert.equal(game.actor_count(), before + 1, 'the spy plane flies in');
  assert.equal(JSON.parse(game.player_json(0)).powers.find((p) => p.key === spy.key).ready, false, 'timer restarted');
  // Online: the order goes out with its direction and passes the protocol check.
  game.set_lockstep(true);
  game.activate_power(0, 'ParatroopersPower@paratroopers', 240, 240, 480, 240);
  const [order] = JSON.parse(game.take_orders());
  assert.deepEqual(order, { o: 'support_power', player: 0, key: 'ParatroopersPower@paratroopers', x: 10240, y: 10240, x2: 20480, y2: 10240 });
  assert.deepEqual(validOrder(order), order);
});
