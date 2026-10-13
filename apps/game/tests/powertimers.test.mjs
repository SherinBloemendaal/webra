// The top-left support power timers (js/powertimers.js, OpenRA
// SupportPowerTimerWidget): the text, colours and blinking, and the engine
// query behind them (Game.power_timers_json) in a skirmish where one player
// builds a Missile Silo. Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { LocalDriver } from '../js/replay.js';
import { PowerTimers, formatPowerTime, shadowColor, timerLines, BLINK_TICKS } from '../js/powertimers.js';
import { QUERY_DEFAULTS } from '../js/sim/methods.js';
import { installDom, textOf, uninstallDom } from './dom-fixtures.mjs';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

test('times read like OpenRA WidgetUtils.FormatTime without a leading minute zero', () => {
  // 13500 ticks (the Atom Bomb's ChargeInterval) at 40 ms: 9 minutes.
  assert.equal(formatPowerTime(13500, 40), '9:00');
  assert.equal(formatPowerTime(13499, 40), '9:00', 'seconds round up');
  assert.equal(formatPowerTime(26, 40), '0:02');
  assert.equal(formatPowerTime(0, 40), '0:00');
  // The game speed's tick length counts (Fastest: 20 ms).
  assert.equal(formatPowerTime(13500, 20), '4:30');
  assert.equal(formatPowerTime(25 * 3600, 40), '1:00:00');
  assert.equal(formatPowerTime(25 * 3725, 40), '1:02:05');
});

test('lines are "<player>\'s <power>: time" in the owner colour, blinking white once ready', () => {
  const red = [0.9, 0.1, 0.1];
  const timers = [
    { player: 1, key: 'NukePower', name: 'Atom Bomb', remainingTicks: 750, ready: false },
    { player: 2, key: 'GpsPower', name: 'GPS Satellite', remainingTicks: 0, ready: true },
  ];
  const o = (tick) => ({ tick, tickMs: 40, nameOf: (p) => ['Me', 'Ivan', 'Tanya'][p], colorOf: () => red });
  const at0 = timerLines(timers, o(0));
  assert.deepEqual(
    at0.map((l) => l.text),
    ["Ivan's Atom Bomb: 0:30", "Tanya's GPS Satellite: 0:00"],
  );
  assert.equal(at0[0].id, '1:NukePower');
  assert.deepEqual(at0[1].color, red, 'the first half of the blink: the owner colour');
  const half = timerLines(timers, o(BLINK_TICKS / 2));
  assert.deepEqual(half[0].color, red, 'a charging timer never blinks');
  assert.deepEqual(half[1].color, [1, 1, 1], 'the second half: white');
  assert.deepEqual(timerLines(timers, o(BLINK_TICKS))[1].color, red);
  // OpenRA GetContrastColor: black behind light text, grey behind dark text.
  assert.deepEqual(shadowColor([1, 1, 1]), [0, 0, 0]);
  assert.deepEqual(shadowColor(red), [0, 0, 0]);
  assert.deepEqual(shadowColor([0.1, 0.1, 0.3]), [127 / 255, 127 / 255, 127 / 255]);
});

test('the list keeps one node per timer in order and hides when empty', () => {
  installDom();
  try {
    const field = document.createElement('main');
    const view = new PowerTimers(field);
    assert.equal(view.root.hidden, true);
    const line = (id, text) => ({ id, text, color: [1, 0, 0], shadow: [0, 0, 0] });
    view.update([line('1:NukePower', "Ivan's Atom Bomb: 0:30"), line('2:GpsPower', "Tanya's GPS Satellite: 1:00")]);
    assert.equal(view.root.hidden, false);
    assert.deepEqual(
      [...view.root.children].map(textOf),
      ["Ivan's Atom Bomb: 0:30", "Tanya's GPS Satellite: 1:00"],
    );
    const first = view.root.children[0];
    assert.equal(first.className, 'power-timer');
    view.update([line('1:NukePower', "Ivan's Atom Bomb: 0:29")]);
    assert.equal(view.root.children.length, 1);
    assert.equal(view.root.children[0], first, 'the same node, new text');
    assert.equal(textOf(first), "Ivan's Atom Bomb: 0:29");
    view.clear();
    assert.equal(view.root.hidden, true);
    assert.equal(view.root.children.length, 0);
  } finally {
    uninstallDom();
  }
});

const OPTIONS = {
  seed: 977,
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

test("the enemy sees a player's Atom Bomb countdown under fog, the Iron Curtain stays private", () => {
  assert.equal(QUERY_DEFAULTS.power_timers_json(), '[]', 'nothing before the worker answers');
  const game = Game.from_options(JSON.stringify(OPTIONS));
  const local = new LocalDriver(game, { player: 0 });
  for (const flag of ['all_tech', 'fast_build', 'build_anywhere', 'unlimited_power']) game.dev_flag(0, flag, true);
  game.dev_give_cash(0);
  local.tick();
  const [sx, sy] = game.start_position(0);
  const queued = (id) => JSON.parse(game.player_json(0)).queues.some((q) => q.some((it) => it.id === id));
  for (const id of ['MSLO', 'IRON']) {
    game.start_production(0, id, 1);
    for (let t = 0; t < 200 && !JSON.parse(game.player_json(0)).queues.some((q) => q.some((it) => it.id === id && it.done)); t++) local.tick();
    // The first spot near the start that takes it (build anywhere is on).
    for (let i = 0; i < 400 && queued(id); i++) {
      game.place_building(0, id, Math.floor(sx / 24) + (i % 20) - 8, Math.floor(sy / 24) + Math.floor(i / 20) - 8);
      local.tick();
      local.tick();
    }
    assert.ok(!queued(id), `${id} placed`);
  }
  for (let t = 0; t < 5; t++) local.tick();
  const powers = JSON.parse(game.player_json(0)).powers.map((p) => p.key).sort();
  assert.deepEqual(powers, ['GrantExternalConditionPower@IRONCURTAIN', 'NukePower']);
  for (const viewer of [0, 1, -1]) {
    const timers = JSON.parse(game.power_timers_json(viewer));
    assert.equal(timers.length, 1, `viewer ${viewer}`);
    assert.deepEqual(
      { player: timers[0].player, key: timers[0].key, name: timers[0].name, ready: timers[0].ready },
      { player: 0, key: 'NukePower', name: 'Atom Bomb', ready: false },
    );
    assert.ok(timers[0].remainingTicks > 13000 && timers[0].remainingTicks < 13500);
  }
  const [line] = timerLines(JSON.parse(game.power_timers_json(1)), { tick: 0, tickMs: 40, nameOf: () => 'A', colorOf: () => [0.2, 0.4, 1] });
  assert.match(line.text, /^A's Atom Bomb: [89]:\d\d$/);
});
