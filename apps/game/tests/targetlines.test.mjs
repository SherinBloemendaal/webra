// Target lines (js/targetlines.js, engine/src/target_lines.rs, OpenRA
// DrawLineToTarget): which units show them when, and what the engine draws
// for them through Game.build_lines. Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { LINE_ORDERS, TARGET_LINE_DELAY_MS, TARGET_LINE_MODES, TargetLines, withTargetLines } from '../js/targetlines.js';
import { SCHEMA } from '../js/settings.js';

const wasm = initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

function clock(start = 1000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('the setting is OpenRA TargetLines', () => {
  assert.deepEqual(SCHEMA.targetLines.options, TARGET_LINE_MODES);
  assert.equal(SCHEMA.targetLines.default, 'automatic');
  assert.equal(TARGET_LINE_DELAY_MS, 2400, 'DrawLineToTargetInfo.Delay');
});

test('automatic: ordered and newly selected units show their lines for 2.4 seconds, Shift shows all', () => {
  const c = clock();
  const lines = new TargetLines({ mode: () => 'automatic', now: c.now });
  lines.selected([1, 2]);
  assert.deepEqual(lines.visible([1, 2]), [1, 2], 'a new selection shows its lines');
  c.t += TARGET_LINE_DELAY_MS + 1;
  assert.deepEqual(lines.visible([1, 2]), [], 'then they go');
  lines.ordered([2]);
  assert.deepEqual(lines.visible([1, 2]), [2], 'an order shows the ordered units');
  c.t += TARGET_LINE_DELAY_MS - 1;
  assert.deepEqual(lines.visible([1, 2]), [2]);
  // Selecting the same units again shows nothing new; adding one shows that one.
  lines.selected([1, 2, 3]);
  c.t += 2;
  assert.deepEqual(lines.visible([1, 2, 3]), [3]);
  assert.deepEqual(lines.visible([1, 2, 3], { shift: true }), [1, 2, 3], 'Shift: waypoint mode shows every selected unit');
  assert.deepEqual(lines.visible([1]), [], 'only selected units');
});

test('manual shows lines only with Shift, disabled never', () => {
  const c = clock();
  let mode = 'manual';
  const lines = new TargetLines({ mode: () => mode, now: c.now });
  lines.selected([1]);
  lines.ordered([1]);
  assert.deepEqual(lines.visible([1]), []);
  assert.deepEqual(lines.visible([1], { shift: true }), [1]);
  mode = 'disabled';
  assert.deepEqual(lines.visible([1], { shift: true }), []);
});

test('orders through the wrapped game show the ordered units; other calls pass through', () => {
  const calls = [];
  const game = {
    player: 0,
    order_move: (p, ids, x, y, am) => calls.push(['move', p, Array.from(ids), x, y, am]) && 'moved',
    order_stop: (p, ids) => calls.push(['stop', p, Array.from(ids)]),
    tick_count() {
      return this.player + 7;
    },
  };
  const ordered = [];
  const ui = withTargetLines(game, (ids) => ordered.push(ids));
  assert.equal(ui.order_move(0, Uint32Array.from([4, 5]), 1, 2, false), 'moved');
  ui.order_stop(0, Uint32Array.from([4]));
  assert.equal(ui.tick_count(), 7, 'methods keep their object');
  assert.equal(ui.player, 0);
  assert.deepEqual(ordered, [[4, 5]], 'stop leaves the unit idle: no line');
  assert.deepEqual(calls[0], ['move', 0, [4, 5], 1, 2, false]);
  for (const name of LINE_ORDERS) assert.equal(typeof Game.prototype[name], 'function', `${name} is a game order`);
});

test('the engine draws a green line and a marker to where a unit moves, red to its attack target', () => {
  const options = {
    seed: 99,
    mapSize: 64,
    players: [
      { slot: 0, type: 'human', name: 'A', faction: 'england', color: 0, team: 0 },
      { slot: 1, type: 'human', name: 'B', faction: 'russia', color: 1, team: 0 },
    ],
    startingCash: 5000,
    startingUnits: 'light',
    techLevel: 'unrestricted',
    gameSpeed: 'normal',
    fog: false,
    explored: true,
    buildRadius: true,
    redeployableMcv: true,
    oreRegrowth: true,
    techBuildings: 'none',
    mapStyle: 'land',
    crates: false,
    shortGame: true,
    bounty: false,
    separateTeamSpawns: true,
    allyBuildRadius: true,
    timeLimit: 0,
    reusableEngineers: false,
  };
  const game = Game.from_options(JSON.stringify(options));
  const units = Array.from(game.select_box(0, -1e9, -1e9, 1e9, 1e9)).filter((id) => JSON.parse(game.actor_json(id)).type !== 'MCV');
  const unit = units[0];
  const lines = () => {
    const n = game.build_lines(0, 1, false, Uint32Array.from([unit]));
    return Array.from({ length: n }, (_, k) => Array.from(new Float32Array(wasm.memory.buffer, game.path_ptr() + k * 36, 9)));
  };
  game.set_selection(Uint32Array.from([unit]));
  assert.equal(lines().length, 0, 'idle: no line');
  const [sx, sy] = game.start_position(0);
  const to = [Math.floor(sx / 24) * 24 + 12 + 24 * 8, Math.floor(sy / 24) * 24 + 12 + 24 * 2];
  game.order_move(0, Uint32Array.from([unit]), to[0], to[1], false);
  for (let t = 0; t < 2; t++) game.tick();
  const hash = game.state_hash();
  const [line, marker] = lines();
  assert.ok(line && marker, 'a line and its marker');
  assert.deepEqual(line.slice(4, 8).map((v) => Math.round(v * 255)), [0, 128, 0, 255], 'OpenRA Color.Green');
  assert.equal(line[8], 1, 'OpenRA LineWidth 1');
  assert.ok(Math.abs(line[2] - to[0]) <= 24 && Math.abs(line[3] - to[1]) <= 24, 'to the destination');
  assert.deepEqual([marker[0], marker[1]], [marker[2], marker[3]], 'the marker is a point (shaders/line.wgsl draws a square)');
  assert.equal(game.build_lines(0, 1, false, new Uint32Array()), 0, 'not shown: none');
  assert.equal(game.build_lines(1, 1, false, Uint32Array.from([unit])), 0, 'not for the enemy');
  game.set_selection(new Uint32Array());
  assert.equal(game.build_lines(0, 1, false, Uint32Array.from([unit])), 0, 'only selected units');
  assert.equal(game.state_hash(), hash, 'drawing lines changes nothing');
  // An attack: crimson to the target.
  const [ex, ey] = game.start_position(1);
  const yard = game.pick(0, ex, ey - 12);
  game.set_selection(Uint32Array.from([unit]));
  game.order_attack(0, Uint32Array.from([unit]), yard);
  game.tick();
  assert.deepEqual(lines()[0].slice(4, 8).map((v) => Math.round(v * 255)), [220, 20, 60, 255], 'OpenRA Color.Crimson');
});
