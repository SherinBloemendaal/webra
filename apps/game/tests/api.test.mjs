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
  techBuildings: 'standard',
  // OpenRA's other lobby options (protocol 6).
  crates: true,
  shortGame: true,
  bounty: false,
  separateTeamSpawns: true,
  allyBuildRadius: true,
  timeLimit: 0,
  reusableEngineers: false,
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
  // Crates have no health (OpenRA ^Crate), proxies (engine/src/infantry.rs) no body.
  assert.ok(rules.actors.every((a) => a.name && a.cost >= 0 && (a.hp > 0 || a.kind === 'crate' || a.kind === 'proxy')));
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

test('structures queue; without a Construction Yard they are cancelled and unavailable', () => {
  const game = newGame({ startingUnits: 'base' });
  ticks(game, 1);
  game.start_production(0, 'POWR', 3);
  ticks(game, 1);
  let state = JSON.parse(game.player_json(0));
  assert.deepEqual(
    state.queues[0].map((it) => it.id),
    ['POWR', 'POWR', 'POWR'],
  );
  ticks(game, 400);
  state = JSON.parse(game.player_json(0));
  assert.equal(state.queues[0][0].done, true);
  assert.equal(state.queues[0][1].progress, 0, 'the next one waits for placement');
  const before = state.cash;
  // Sell the only Construction Yard: the finished power plant is refunded.
  const [x, y] = game.start_position(0);
  game.sell(0, game.pick(0, x, y));
  ticks(game, 2);
  state = JSON.parse(game.player_json(0));
  assert.equal(state.hasProducer[0], false);
  assert.deepEqual(state.queues[0], []);
  assert.equal(state.cash, before + 1000 + 300, 'sale plus the refunded power plant');
  const powr = state.buildable.find((b) => b.id === 'POWR');
  assert.equal(powr.enabled, false);
  assert.ok(powr.requires.includes('Construction Yard'));
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

test('unit paths: route lines for selected own units only', () => {
  // Open land, so the clicked point is reachable ground.
  const game = newGame({ startingUnits: 'light', mapStyle: 'land' });
  const units = ownUnits(game);
  game.set_selection(Uint32Array.from(units));
  assert.equal(game.build_paths(0, 1), 0, 'idle units have no route');
  game.order_move(0, Uint32Array.from(units), 40 * 24, 40 * 24, false);
  ticks(game, 3);
  const n = game.build_paths(0, 1);
  assert.ok(n >= units.length, `segments: ${n}`);
  // 9 floats per segment: [x0, y0, x1, y1, r, g, b, a, width] (engine/src/paths.rs LINE_FLOATS).
  const lines = new Float32Array(wasm.memory.buffer, game.path_ptr(), n * 9);
  assert.ok(lines.every(Number.isFinite));
  // Routes end on the centre of the goal cell, next to the clicked point.
  const ends = [];
  for (let k = 0; k < n; k++) ends.push([lines[k * 9 + 2], lines[k * 9 + 3]]);
  const near = ([x, y]) => Math.abs(x - 40 * 24) <= 36 && Math.abs(y - 40 * 24) <= 36 && (x - 12) % 24 === 0 && (y - 12) % 24 === 0;
  assert.ok(ends.some(near), 'a segment ends on the goal');
  assert.equal(game.build_paths(1, 1), 0, 'the other player sees none of our routes');
  game.set_selection(new Uint32Array());
  assert.equal(game.build_paths(0, 1), 0, 'nothing selected');
});

test('rally lines and control group numbers: local UI state drawn by the engine, outside the state hash', () => {
  const game = newGame();
  const [mcv] = ownUnits(game);
  game.deploy(0, Uint32Array.from([mcv]));
  ticks(game, 2);
  const [yard] = Array.from(game.base_actors(0));
  assert.equal(actor(game, yard).type, 'FACT');
  const [sx, sy] = game.start_position(0);
  game.set_rally(0, yard, sx + 5 * 24, sy + 6 * 24);
  ticks(game, 1);
  const hash = game.state_hash();
  // Not selected: no rally line.
  game.set_selection(new Uint32Array());
  assert.equal(game.build_lines(0, 1, false), 0);
  game.set_selection(Uint32Array.from([yard]));
  assert.equal(game.build_lines(0, 1, false), 1, 'the rally line of the selected structure');
  const line = new Float32Array(wasm.memory.buffer, game.path_ptr(), 9);
  assert.ok(Math.abs(line[2] - (sx + 5 * 24)) < 1 && Math.abs(line[3] - (sy + 6 * 24)) < 1, 'it ends on the rally point');
  assert.equal(line[4], -1, 'in player 0\'s team colour (shaders/line.wgsl)');
  assert.equal(line[8], 1, 'one line width');
  assert.equal(game.build_lines(1, 1, false), 0, 'not for the enemy');
  // Control groups change what is drawn only.
  const plates = () => {
    game.build_render(0, 1, 0, 0, 64 * 24, 64 * 24);
    const r = new Float32Array(wasm.memory.buffer, game.rect_ptr(), game.rect_count() * 8);
    let n = 0;
    for (let k = 0; k < r.length; k += 8) if (r[k + 2] === 5 && r[k + 3] === 7 && r[k + 4] === 0 && r[k + 7] > 0.7) n++;
    return n;
  };
  assert.equal(plates(), 0, 'no group yet');
  game.set_control_groups(Uint32Array.from([yard]), Uint8Array.from([4]));
  assert.equal(plates(), 1, 'the selected yard shows its group number');
  game.set_selection(new Uint32Array());
  assert.equal(plates(), 0, 'only while selected');
  game.set_selection(Uint32Array.from([yard]));
  assert.equal(game.state_hash(), hash, 'selection, rally line and groups are not simulation state');
  // The production tooltip's numbers come with the game.
  const state = JSON.parse(game.player_json(0));
  const powr = state.buildable.find((b) => b.id === 'POWR');
  assert.ok(Number.isInteger(powr.buildTicks) && powr.buildTicks > 0, `build ticks ${powr.buildTicks}`);
  assert.ok(JSON.parse(game.rules_json()).lowPowerModifier > 100);
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

test("selection: OpenRA's select all and select by class (priorities, classes, owners)", () => {
  // Light support: the MCV with riflemen, rocket soldiers and more around it (both sides).
  const game = newGame({ startingUnits: 'light' });
  const map = [-1e5, -1e5, 1e5, 1e5];
  const all = (owners, ctrl = false, alt = false) => Array.from(game.select_all(Uint8Array.from(owners), ...map, ctrl, alt));
  const types = (ids) => ids.map((id) => actor(game, id).type).sort();
  const own = all([0]);
  assert.ok(own.length >= 5, 'the combat units');
  assert.ok(own.every((id) => actor(game, id).owner === 0), 'own actors only');
  assert.ok(!types(own).includes('MCV'), 'the MCV (a support unit) is not a combat unit');
  assert.ok(types(all([0], false, true)).includes('MCV'), 'Alt raises the support units');
  const both = all([0, 1]);
  assert.ok(both.some((id) => actor(game, id).owner === 1), 'a spectator watching everyone selects every player');
  // Select by class: the riflemen of the selection, across the map.
  const e1 = own.find((id) => actor(game, id).type === 'E1');
  const riflemen = Array.from(game.select_by_class(Uint8Array.of(0), Uint32Array.of(e1), ...map));
  assert.ok(riflemen.length >= 2 && riflemen.every((id) => actor(game, id).type === 'E1' && actor(game, id).owner === 0));
  assert.deepEqual(Array.from(game.select_by_class(Uint8Array.of(1), Uint32Array.of(e1), ...map)), [], "another player's actor gives no class");
  // An empty view selects nothing.
  assert.deepEqual(Array.from(game.select_all(Uint8Array.of(0), -500, -500, -400, -400, false, false)), []);
  // A box: own combat units first (the MCV and other players' units rank lower); Alt raises the MCV.
  const box = (ctrl = false, alt = false) => types(Array.from(game.select_box(0, ...map, ctrl, alt)));
  assert.deepEqual(box(), types(own));
  assert.deepEqual(box(false, true), ['MCV']);
  assert.ok(box(true).includes('MCV') && box(true).includes('E1'), 'Ctrl raises every unit that allows it');
  // A click on a rifleman selects him; nothing there selects nothing.
  const [x, y] = Array.from(game.units_center(0, Uint32Array.of(e1)));
  assert.equal(actor(game, game.select_at(0, x, y - 8, false, false)).type, 'E1');
  assert.equal(game.select_at(0, -500, -500, false, false), 0xffffffff);
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
  assert.equal(map.format, 2, 'generated maps have gems (format 2)');
  assert.equal(typeof map.gems, 'string');
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

// ---- Map styles, biomes and weather (engine/src/mapgen, engine/src/weather.rs) ----------

test('generated maps come in styles and biomes, as map files and previews', async () => {
  const { parseMap, canonicalMapJson } = await import('../../../packages/protocol/src/index.js');
  const { canonicalJson } = await import('../editor/js/mapformat.js');
  for (const style of ['land', 'rivers', 'lakes', 'islands']) {
    const json = Game.generated_map_styled(9, 64, 2, style, 'snow');
    const v = JSON.parse(Game.validate_map(json));
    assert.ok(v.ok && !v.modded, `${style}: ${v.errors}`);
    const map = JSON.parse(json);
    assert.equal(map.biome, 'snow');
    assert.ok(map.description.includes(style));
    // Engine, protocol and editor agree on the canonical form with a biome.
    const p = parseMap(json);
    assert.ok(p.ok, p.errors.join('; '));
    assert.equal(canonicalMapJson(p.map), Game.map_canonical(json));
    assert.equal(canonicalJson(map), Game.map_canonical(json));
    assert.equal(Game.map_file_preview(json).length, 64 * 64 * 4);
  }
  // Random picks from the seed, the same everywhere; the preview follows style and biome.
  assert.equal(Game.resolved_style(9, 'random'), Game.resolved_style(9, 'random'));
  assert.ok(['land', 'rivers', 'lakes', 'islands'].includes(Game.resolved_style(9, 'random')));
  assert.equal(Game.resolved_biome(9, 'desert'), 'desert');
  const desert = Game.map_preview_styled(9, 64, 2, 'islands', 'desert');
  const snow = Game.map_preview_styled(9, 64, 2, 'islands', 'snow');
  assert.equal(desert.length, 64 * 64 * 4);
  assert.notDeepEqual(desert, snow);
  assert.throws(() => Game.map_preview_styled(9, 64, 2, 'volcano', 'snow'), /map style/);
  assert.throws(() => Game.generated_map_styled(9, 64, 2, 'land', 'moon'), /biome/);
  // A temperate generated map has no biome key and keeps the old identity rules.
  assert.ok(!Game.generated_map(9, 64, 2).includes('"biome"'));
});

test('weather options are checked and the sky is reported', () => {
  assert.throws(() => newGame({ weather: 'stormy' }), /weather/);
  assert.throws(() => newGame({ biome: 'lava' }), /biome/);
  assert.throws(() => newGame({ mapStyle: 'maze' }), /map style/);
  assert.throws(() => newGame({ biome: 7 }), /biome must be a string/);
  const g = newGame({ biome: 'desert', weather: 'cosmetic', mapStyle: 'islands' });
  const sky = JSON.parse(g.weather_json());
  assert.deepEqual([sky.biome, sky.mode, sky.weather, sky.sightPct, sky.flash], ['desert', 'cosmetic', 'clear', 100, null]);
  assert.ok(sky.until > 0);
  // Random biome: picked from the seed, the same for every peer.
  const a = JSON.parse(newGame({ biome: 'random' }).weather_json()).biome;
  assert.equal(JSON.parse(newGame({ biome: 'random' }).weather_json()).biome, a);
  // Older callers without the keys still start a temperate game with full weather.
  const old = JSON.parse(newGame().weather_json());
  assert.deepEqual([old.biome, old.mode], ['temperate', 'full']);
  // Nothing is hot at the start; the heat buffer is empty but valid.
  assert.equal(g.build_heat_fx(0, 0, 0, 64 * 24, 64 * 24), 0);
  const info = JSON.parse(g.actor_json(g.pick(0, ...g.start_position(0))));
  if (info) assert.equal(info.heat, 0);
});
