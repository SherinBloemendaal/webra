// WebAssembly API used by camera hotkeys: Game.units_center (control group
// double tap, Home). Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';

const wasmPath = fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url));
initSync({ module: readFileSync(wasmPath) });

const SIZE = 48;
const px = (cell) => (cell + 0.5) * 24;

function game(actors) {
  const map = JSON.stringify({
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
  const options = JSON.stringify({
    seed: 3,
    players: [
      { slot: 0, type: 'human', faction: 'soviet' },
      { slot: 1, type: 'human', faction: 'allies' },
    ],
    startingUnits: 'mcv',
    techLevel: 'unrestricted',
    fog: false,
  });
  return Game.from_map(map, options);
}

test('units_center: mean position of own living units, others ignored', () => {
  const g = game([
    { type: '3TNK', owner: 0, x: 10, y: 10, facing: 0 },
    { type: '3TNK', owner: 0, x: 20, y: 30, facing: 0 },
    { type: '2TNK', owner: 1, x: 40, y: 40, facing: 0 },
  ]);
  g.tick();
  const a = g.pick(0, px(10), px(10));
  const b = g.pick(0, px(20), px(30));
  const enemy = g.pick(1, px(40), px(40));
  assert.notEqual(a, 0xffffffff);
  assert.notEqual(b, 0xffffffff);
  assert.notEqual(enemy, 0xffffffff);
  const [x, y] = g.units_center(0, Uint32Array.from([a, b, enemy, 0xffffffff, 12345]));
  assert.ok(Math.abs(x - (px(10) + px(20)) / 2) < 1, `x ${x}`);
  assert.ok(Math.abs(y - (px(10) + px(30)) / 2) < 1, `y ${y}`);
  assert.deepEqual(Array.from(g.units_center(0, Uint32Array.from([enemy]))), [], 'not own');
  assert.deepEqual(Array.from(g.units_center(0, new Uint32Array(0))), []);
  assert.equal(g.units_center(1, Uint32Array.from([enemy])).length, 2, 'the owner can centre on it');
});
