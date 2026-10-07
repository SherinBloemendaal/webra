// WebAssembly API tests for ships and transports (engine/src/naval.rs, cargo.rs).
// Run after `npm run build:wasm`: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';

const wasmPath = fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url));
initSync({ module: readFileSync(wasmPath) });

const NONE = 0xffffffff;
const SIZE = 48;
const SHORE = 24; // columns >= SHORE are sea

/** A coast map: land on the left, sea on the right, with pre-placed actors. */
function coastMap(actors) {
  const terrain = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = SHORE; x < SIZE; x++) terrain[y * SIZE + x] = 3;
  return JSON.stringify({
    format: 1,
    name: 'Coast',
    author: 'Tests',
    description: '',
    width: SIZE,
    height: SIZE,
    terrain: Buffer.from(terrain).toString('base64'),
    ore: Buffer.from(new Uint8Array(SIZE * SIZE)).toString('base64'),
    spawns: [[2, 2], [2, 40]],
    actors,
    rules: null,
  });
}

const OPTIONS = {
  seed: 5,
  players: [
    { slot: 0, type: 'human', faction: 'england' },
    { slot: 1, type: 'human', faction: 'russia' },
  ],
  startingUnits: 'mcv',
  techLevel: 'unrestricted',
  fog: true,
};

const ticks = (game, n) => {
  for (let i = 0; i < n; i++) game.tick();
};
const info = (game, id) => JSON.parse(game.actor_json(id));
const px = (cell) => (cell + 0.5) * 24;
/** Ids of a player's actors of a type, picked at their known cells. */
const at = (game, player, cx, cy) => game.pick(player, px(cx), px(cy));

test('infantry board a transport with a smart order and unload with deploy', () => {
  const game = Game.from_map(
    coastMap([
      { type: 'APC', owner: 0, x: 12, y: 12, facing: 0 },
      { type: 'E1', owner: 0, x: 8, y: 18, facing: 0 },
      { type: 'E1', owner: 0, x: 10, y: 18, facing: 0 },
    ]),
    JSON.stringify(OPTIONS),
  );
  ticks(game, 1);
  const apc = at(game, 0, 12, 12);
  const men = [at(game, 0, 8, 18), at(game, 0, 10, 18)];
  assert.equal(info(game, apc).type, 'APC');
  assert.deepEqual(men.map((id) => info(game, id).type), ['E1', 'E1']);
  assert.equal(info(game, apc).cargoMax, 5);
  assert.equal(game.deploy_state(0, apc), 0, 'empty: nothing to unload');

  assert.equal(game.cursor_action(0, Uint32Array.from(men), px(12), px(12)), 6, 'load cursor over the own APC');
  game.order_smart(0, Uint32Array.from(men), px(12), px(12));
  ticks(game, 300);
  const loaded = info(game, apc);
  assert.deepEqual([...loaded.passengers].sort(), [...men].sort());
  assert.equal(loaded.cargoWeight, 2);
  for (const id of men) assert.equal(info(game, id).carrier, apc);
  const boxed = Array.from(game.select_box(0, 0, 0, SIZE * 24, SIZE * 24));
  assert.ok(boxed.includes(apc) && !men.some((id) => boxed.includes(id)), 'passengers cannot be box-selected');
  game.set_selection(Uint32Array.from(men));
  assert.equal(game.selection().length, 0, 'passengers drop out of the selection');

  assert.equal(game.deploy_state(0, apc), 1, 'a loaded transport can unload');
  game.deploy(0, Uint32Array.from([apc]));
  ticks(game, 100);
  assert.equal(info(game, apc).passengers.length, 0);
  for (const id of men) assert.equal(info(game, id).carrier, NONE);
  assert.equal(game.deploy_state(0, apc), 0);
});

test('submerged submarines are hidden from the enemy', () => {
  const game = Game.from_map(
    coastMap([
      { type: 'SS', owner: 0, x: 34, y: 20, facing: 0 },
      // An enemy cruiser in sight of the sub, but cruisers do not detect submarines.
      { type: 'CA', owner: 1, x: 40, y: 20, facing: 0 },
    ]),
    JSON.stringify({ ...OPTIONS, startingUnits: 'mcv' }),
  );
  ticks(game, 4);
  const sub = at(game, 0, 34, 20);
  assert.equal(info(game, sub).type, 'SS');
  assert.equal(info(game, sub).submerged, true);
  assert.equal(at(game, 1, 34, 20), NONE, 'the enemy cannot see or pick it');
  const cruiser = at(game, 1, 40, 20);
  assert.equal(info(game, cruiser).type, 'CA');
  assert.equal(game.cursor_action(1, Uint32Array.from([cruiser]), px(34), px(20)), 1, 'just a move order there');
});

test('ships launched from a naval yard', () => {
  const game = Game.from_map(
    coastMap([
      { type: 'POWR', owner: 0, x: 8, y: 2, facing: 0 },
      { type: 'SYRD', owner: 0, x: 28, y: 6, facing: 0 },
    ]),
    JSON.stringify({ ...OPTIONS, startingUnits: 'base', startingCash: 10000 }),
  );
  game.start_production(0, 'PT', 1);
  ticks(game, 600);
  const units = Array.from(game.select_box(0, SHORE * 24, 0, SIZE * 24, SIZE * 24)).map((id) => info(game, id));
  assert.ok(units.some((u) => u.type === 'PT'), 'a gunboat sails out of the yard');
});
