// The JavaScript protocol package must agree with the engine byte for byte on
// map identity, and its order validation must accept what the engine emits.
// Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { canonicalMapJson, mapHash, parseClientMessage, validateMap, validOrders } from '../js/protocol.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const ENGINE_RULES = JSON.parse(readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8'));

const variants = () => {
  const out = [];
  for (const [seed, size, players] of [
    [1, 48, 2],
    [42, 64, 4],
    [7, 96, 8],
  ]) {
    out.push(JSON.parse(Game.generated_map(seed, size, players)));
  }
  const modded = JSON.parse(Game.generated_map(3, 48, 3));
  modded.name = 'Mod  map  ';
  modded.description = 'line one\nline two';
  modded.actors = [{ type: 'SBAG', owner: -1, x: 20, y: 20 }];
  modded.rules = { weapons: { '25mm': { range: 6000 } }, actors: { '1TNK': { unit: { speed: 150 }, cost: 400 } } };
  out.push(modded);
  const empty = JSON.parse(Game.generated_map(5, 48, 2));
  delete empty.actors;
  delete empty.description;
  empty.rules = {};
  out.push(empty);
  return out;
};

test('canonical map JSON and hash match the engine byte for byte', async () => {
  for (const map of variants()) {
    const json = JSON.stringify(Object.fromEntries(Object.entries(map).reverse()));
    const engine = JSON.parse(Game.validate_map(json));
    assert.equal(engine.ok, true, engine.errors.join('; '));
    const js = validateMap(JSON.parse(json), { rules: ENGINE_RULES });
    assert.ok(js.ok, js.errors.join('; '));
    assert.equal(js.canonical, Game.map_canonical(json));
    assert.equal(canonicalMapJson(js.map), js.canonical);
    assert.equal(await mapHash(js.map), Game.map_hash(json));
    assert.equal(await mapHash(js.map), engine.hash);
    assert.equal(js.modded, engine.modded);
  }
});

test('orders the engine emits pass protocol validation and round-trip into apply_frame', () => {
  const options = {
    seed: 9,
    mapSize: 64,
    players: [
      { slot: 0, type: 'human', name: 'A', faction: 'germany', color: 0, team: 0 },
      { slot: 1, type: 'human', name: 'B', faction: 'russia', color: 1, team: 0 },
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
    techBuildings: 'standard',
  };
  const game = Game.from_options(JSON.stringify(options));
  game.set_lockstep(true);
  const units = Array.from(game.select_box(0, -1e9, -1e9, 1e9, 1e9));
  game.order_move(0, Uint32Array.from(units), 500, 500, true);
  game.order_smart(0, Uint32Array.from(units), 400, 400);
  game.order_stop(0, Uint32Array.from(units));
  game.deploy(0, Uint32Array.from(units.slice(0, 1)));
  game.start_production(0, 'POWR', 2);
  game.cancel_production(0, 'POWR');
  // Command bar orders (engine/src/commands.rs).
  const all = Uint32Array.from(units);
  game.order_attack_ground(0, all, 300.5, 410);
  game.order_guard(0, all.slice(1), units[0]);
  game.order_scatter(0, all);
  game.order_waypoint(0, all, 600, 620, false);
  game.order_waypoint(0, all, 640, 660, true);
  for (const stance of ['hold_fire', 'return_fire', 'defend', 'attack_anything']) assert.equal(game.set_stance(0, all, stance), true);
  assert.equal(game.set_stance(0, all, 'berserk'), false, 'unknown stances are not sent');
  // Sidebar buttons (engine/src/repair.rs, beacons.rs).
  game.repair_building(0, units[0]);
  game.power_down(0, units[0]);
  game.place_beacon(0, 240, 360);
  const orders = JSON.parse(game.take_orders());
  assert.ok(orders.length >= 17);
  assert.deepEqual(
    orders.slice(-12).map((o) => o.o),
    ['attack_ground', 'guard', 'scatter', 'waypoint', 'waypoint', 'set_stance', 'set_stance', 'set_stance', 'set_stance', 'repair_building', 'power_down', 'place_beacon'],
  );
  assert.deepEqual(orders.at(-1), { o: 'place_beacon', player: 0, x: 10240, y: 15360 }, 'world units');
  const valid = validOrders(orders);
  assert.deepEqual(valid, orders);
  const r = parseClientMessage(JSON.stringify({ t: 'orders', tick: 3, orders }));
  assert.ok(r.ok, r.message);
  assert.equal(game.apply_frame(JSON.stringify([[0, valid]])), orders.length);
});
