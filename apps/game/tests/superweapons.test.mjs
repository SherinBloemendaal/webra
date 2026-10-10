// Support powers through the client's order path: a skirmish runs on the
// LocalDriver (js/replay.js), which sends every local order through the
// protocol check like an online game (js/net.js). The atom bomb is built,
// charges, is fired with a plain click (no direction) and lands.
// Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { LocalDriver } from '../js/replay.js';
import { validOrder } from '../js/protocol.js';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

const OPTIONS = {
  seed: 4242,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'A', faction: 'russia', color: 0, team: 0 },
    { slot: 1, type: 'human', name: 'B', faction: 'england', color: 1, team: 0 },
  ],
  startingCash: 5000,
  startingUnits: 'base',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: false,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: true,
  techBuildings: 'none',
  crates: false,
  shortGame: true,
  bounty: false,
  separateTeamSpawns: true,
  allyBuildRadius: true,
  timeLimit: 0,
  reusableEngineers: false,
  cheats: true,
};

const state = (game, p = 0) => JSON.parse(game.player_json(p));
const nuke = (game) => state(game).powers.find((p) => p.kind === 'NukePower');

/** Tick the local driver until `done()` (at most `max` ticks); returns whether it happened. */
function until(local, done, max) {
  for (let t = 0; t < max; t++) {
    if (done()) return true;
    local.tick();
  }
  return done();
}

test('powers fired with a plain click pass the protocol check (no direction is left out, not null)', () => {
  const game = Game.from_options(JSON.stringify(OPTIONS));
  game.set_lockstep(true);
  game.activate_power(0, 'NukePower', 240, 240);
  game.activate_power(0, 'GrantExternalConditionPower@IRONCURTAIN', 240, 240);
  game.activate_power(0, 'AirstrikePower@spyplane', 240, 240, undefined, undefined);
  const orders = JSON.parse(game.take_orders());
  assert.equal(orders.length, 3);
  for (const o of orders) {
    assert.ok(!('x2' in o) && !('y2' in o), JSON.stringify(o));
    assert.deepEqual(validOrder(o), o);
  }
  // A null direction (older clients) means none, as serde reads it.
  const old = { o: 'support_power', player: 0, key: 'NukePower', x: 1, y: 2, x2: null, y2: null };
  assert.deepEqual(validOrder(old), { o: 'support_power', player: 0, key: 'NukePower', x: 1, y: 2 });
});

test('a skirmish player builds the Missile Silo and the atom bomb lands where they click', () => {
  const game = Game.from_options(JSON.stringify(OPTIONS));
  const local = new LocalDriver(game, { player: 0 });
  for (const flag of ['all_tech', 'fast_build', 'build_anywhere', 'unlimited_power', 'fast_charge', 'disable_shroud']) game.dev_flag(0, flag, true);
  game.dev_give_cash(0);
  local.tick();
  game.start_production(0, 'MSLO', 1);
  const ready = () => state(game).queues.some((q) => q.some((it) => it.id === 'MSLO' && it.done));
  assert.ok(until(local, ready, 200), 'the silo is built');
  const [sx, sy] = game.start_position(0);
  const placed = () => !state(game).queues.some((q) => q.some((it) => it.id === 'MSLO'));
  for (let dy = 4; dy < 14 && !placed(); dy++) {
    game.place_building(0, 'MSLO', Math.floor(sx / 24) + 6, Math.floor(sy / 24) + dy);
    local.tick();
    local.tick();
  }
  assert.ok(placed(), 'the silo is placed');
  assert.ok(until(local, () => nuke(game)?.ready, 50), 'charged (instant charge cheat)');
  game.dev_flag(0, 'fast_charge', false);
  local.tick();
  // The enemy Construction Yard, clicked as the target.
  const [ex, ey] = game.start_position(1);
  const yard = game.pick(0, ex, ey - 12);
  assert.notEqual(yard, 0xffffffff, 'the enemy yard is under the cursor');
  game.activate_power(0, nuke(game).key, ex, ey - 12);
  local.tick();
  assert.equal(nuke(game).ready, false, 'fired: the timer restarted');
  // MissileDelay 5 + FlightDelay 400, then the blast.
  const gone = () => game.actor_json(yard) === 'null';
  assert.ok(until(local, gone, 460), 'the atom bomb destroyed the yard');
});
