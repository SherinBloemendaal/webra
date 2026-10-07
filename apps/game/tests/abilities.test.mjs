// WebAssembly API tests for unit abilities and support powers (engine/src/abilities.rs).
// Run after `npm run build:wasm`: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';

const wasmPath = fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url));
initSync({ module: readFileSync(wasmPath) });

const SIZE = 48;

/** An open, clear map with pre-placed actors. */
function openMap(actors) {
  return JSON.stringify({
    format: 1,
    name: 'Open',
    author: 'Tests',
    description: '',
    width: SIZE,
    height: SIZE,
    terrain: Buffer.from(new Uint8Array(SIZE * SIZE)).toString('base64'),
    ore: Buffer.from(new Uint8Array(SIZE * SIZE)).toString('base64'),
    spawns: [[2, 2], [2, 40]],
    actors,
    rules: null,
  });
}

const options = (a, b) =>
  JSON.stringify({
    seed: 3,
    players: [
      { slot: 0, type: 'human', faction: a },
      { slot: 1, type: 'human', faction: b },
    ],
    startingUnits: 'mcv',
    techLevel: 'unrestricted',
    fog: true,
    explored: true,
  });

const ticks = (game, n) => {
  for (let i = 0; i < n; i++) game.tick();
};
const info = (game, id) => JSON.parse(game.actor_json(id));
const px = (cell) => (cell + 0.5) * 24;
const at = (game, player, cx, cy) => game.pick(player, px(cx), px(cy));
const ids = (...list) => Uint32Array.from(list);

test('minelayer: deploy lays a mine, Ctrl-drag lays a field, ammo shows in actor_json', () => {
  const game = Game.from_map(
    openMap([
      { type: 'MNLY', owner: 0, x: 20, y: 20, facing: 0 },
      { type: '2TNK', owner: 1, x: 30, y: 30, facing: 0 },
    ]),
    options('allies', 'soviet'),
  );
  ticks(game, 1);
  const ml = at(game, 0, 20, 20);
  assert.equal(info(game, ml).type, 'MNLY');
  assert.deepEqual(info(game, ml).ability, { ammo: 5, maxAmmo: 5, minelayer: true });
  assert.ok(game.has_minelayer(0, ids(ml)));
  assert.equal(game.ability_deploy_state(0, ml), 1);
  assert.equal(game.ability_deploy_state(1, ml), 0, 'not for other players');
  game.deploy(0, ids(ml));
  ticks(game, 1);
  assert.equal(info(game, ml).ability.ammo, 4);
  game.order_lay_mines(0, ids(ml), px(22), px(24), px(24), px(24));
  ticks(game, 25 * 15);
  assert.equal(info(game, ml).ability.ammo, 1, 'three more mines');
  const rules = JSON.parse(game.rules_json());
  assert.equal(rules.actors.find((a) => a.id === 'MINV').kind, 'mine');
  // Mines are hidden from the enemy.
  assert.equal(game.pick(1, px(23), px(24)), 0xffffffff);
  assert.equal(info(game, game.pick(0, px(23), px(24))).type, 'MINV');
});

test('chrono tank: deploy needs a target, teleport_valid checks range, order_teleport jumps', () => {
  const game = Game.from_map(openMap([{ type: 'CTNK', owner: 0, x: 10, y: 20, facing: 0 }]), options('germany', 'soviet'));
  ticks(game, 1);
  const ct = at(game, 0, 10, 20);
  assert.equal(game.ability_deploy_state(0, ct), 3, 'needs a target');
  assert.ok(game.teleport_valid(0, ids(ct), px(22), px(20)), '12 cells');
  assert.ok(!game.teleport_valid(0, ids(ct), px(23), px(20)), '13 cells');
  assert.ok(!game.teleport_valid(1, ids(ct), px(15), px(20)), 'not your tank');
  game.order_teleport(0, ids(ct), px(22), px(20));
  ticks(game, 1);
  assert.equal(at(game, 0, 22, 20), ct);
  const ab = info(game, ct).ability;
  assert.equal(ab.chargeMax, 250);
  assert.ok(ab.charge < 5);
  assert.equal(game.ability_deploy_state(0, ct), 2, 'charging');
});

test('MAD tank and demolition truck deploy; supply truck gets the deliver cursor', () => {
  const game = Game.from_map(
    openMap([
      { type: 'QTNK', owner: 0, x: 10, y: 10, facing: 0 },
      { type: 'TRUK', owner: 0, x: 20, y: 20, facing: 0 },
      { type: 'POWR', owner: 0, x: 24, y: 20, facing: 0 },
    ]),
    options('soviet', 'allies'),
  );
  ticks(game, 2);
  const mad = at(game, 0, 10, 10);
  const truck = at(game, 0, 20, 20);
  assert.equal(game.ability_deploy_state(0, mad), 1);
  game.deploy(0, ids(mad));
  ticks(game, 2);
  assert.equal(info(game, mad).ability.deployed, true);
  assert.equal(game.ability_deploy_state(0, mad), 2);
  assert.equal(game.cursor_action(0, ids(truck), px(24.5), px(20.5)), 7, 'deliver cash');
  const cash = JSON.parse(game.player_json(0)).cash;
  game.order_smart(0, ids(truck), px(24.5), px(20.5));
  ticks(game, 25 * 8);
  assert.equal(JSON.parse(game.player_json(0)).cash, cash + 500);
});

test('lockstep: ability orders travel as JSON', () => {
  const game = Game.from_map(openMap([{ type: 'MNLY', owner: 0, x: 20, y: 20, facing: 0 }]), options('allies', 'soviet'));
  ticks(game, 1);
  const ml = at(game, 0, 20, 20);
  game.set_lockstep(true);
  game.order_lay_mines(0, ids(ml), px(1), px(2), px(3), px(4));
  game.order_teleport(0, ids(ml), px(5), px(6));
  const out = JSON.parse(game.take_orders());
  assert.deepEqual(out.map((o) => o.o), ['lay_mines', 'teleport']);
  assert.deepEqual([out[0].x0, out[0].y0, out[0].x1, out[0].y1], [1, 2, 3, 4]);
  assert.equal(game.apply_frame(JSON.stringify([[0, out]])), 2);
});
