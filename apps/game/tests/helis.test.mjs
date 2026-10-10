// Helicopter API tests (Game.order_land, Game.order_return_to_base, deploy, ammo).
// Run after `npm run build:wasm`: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';

const wasmPath = fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url));
initSync({ module: readFileSync(wasmPath) });

const PX = 24; // world pixels per cell
const OPTIONS = {
  seed: 7,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'Commander', faction: 'russia', color: 0 },
    { slot: 1, type: 'human', name: 'Other', faction: 'england', color: 1 },
  ],
  startingCash: 10000,
  startingUnits: 'base',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: false,
  explored: true,
  buildRadius: true,
  redeployableMcv: true,
  oreRegrowth: false,
  techBuildings: 'standard',
  reusableEngineers: false,
};

/** A generated map with a Soviet helipad and a Hind hovering near player 0's base. */
function heliGame() {
  const map = JSON.parse(Game.generated_map(11, 64, 2));
  const [sx, sy] = map.spawns[0];
  map.actors = [
    { type: 'HPAD', owner: 0, x: sx + 5, y: sy, facing: 0 },
    { type: 'HIND', owner: 0, x: sx + 2, y: sy + 6, facing: 0 },
  ];
  const game = Game.from_map(JSON.stringify(map), JSON.stringify(OPTIONS));
  game.tick();
  const ids = Array.from(game.select_box(0, -1e9, -1e9, 1e9, 1e9));
  const hind = ids.find((id) => JSON.parse(game.actor_json(id)).type === 'HIND');
  assert.ok(hind, 'the Hind is on the map');
  return { game, hind, sx, sy };
}

const actor = (game, id) => JSON.parse(game.actor_json(id));
const ticks = (game, n) => {
  for (let i = 0; i < n; i++) game.tick();
};

test('helicopters report their ammo and landing state', () => {
  const { game, hind } = heliGame();
  const a = actor(game, hind);
  assert.equal(a.maxAmmo, 24);
  assert.equal(a.ammo, 24);
  assert.equal(a.landed, false);
  const rules = JSON.parse(game.rules_json());
  for (const id of ['TRAN', 'HIND', 'MH60', 'HELI']) {
    const r = rules.actors.find((x) => x.id === id);
    assert.ok(r && r.kind === 'aircraft' && r.altitude > 0, id);
  }
});

test('order_land puts a helicopter down and deploy takes it off again', () => {
  const { game, hind, sx, sy } = heliGame();
  game.order_land(0, Uint32Array.from([hind]), (sx + 2.5) * PX, (sy + 8.5) * PX);
  ticks(game, 200);
  assert.equal(actor(game, hind).landed, true, 'landed');
  assert.equal(game.deploy_state(0, hind), 1, 'can take off');
  game.deploy(0, Uint32Array.from([hind]));
  ticks(game, 5);
  assert.equal(actor(game, hind).landed, false, 'took off');
});

test('a smart order onto the own helipad lands the helicopter there', () => {
  const { game, hind, sx, sy } = heliGame();
  const [x, y] = [(sx + 6) * PX, (sy + 1) * PX];
  assert.equal(game.cursor_action(0, Uint32Array.from([hind]), x, y), 4, 'dock cursor');
  game.order_smart(0, Uint32Array.from([hind]), x, y);
  let landed = false;
  for (let t = 0; t < 400 && !landed; t++) {
    game.tick();
    landed = actor(game, hind).landed;
  }
  assert.ok(landed, 'touched down on the pad');
  ticks(game, 40);
  assert.equal(actor(game, hind).landed, true, 'stays on the pad it was sent to');
  // Return to base with full ammo: it takes off and waits near the base.
  game.order_return_to_base(0, Uint32Array.from([hind]));
  ticks(game, 40);
  assert.equal(actor(game, hind).landed, false);
});

test('helicopter orders travel through lockstep frames', () => {
  const { game, hind } = heliGame();
  const other = heliGame().game;
  game.set_lockstep(true);
  game.order_land(0, Uint32Array.from([hind]), 100, 100);
  game.order_return_to_base(0, Uint32Array.from([hind]));
  const out = JSON.parse(game.take_orders());
  assert.deepEqual(out.map((o) => o.o), ['land', 'return_to_base']);
  const frame = JSON.stringify([[0, out]]);
  assert.equal(game.apply_frame(frame), 2);
  assert.equal(other.apply_frame(frame), 2);
  ticks(game, 200);
  ticks(other, 200);
  assert.equal(game.state_hash(), other.state_hash());
});
