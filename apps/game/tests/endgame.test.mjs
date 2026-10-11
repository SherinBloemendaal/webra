// The end of a game: the defeat / victory dialog state machine
// (js/endgame.js), the statistics screen's data shaping and graph scaling
// (js/stats.js) with real engine reports, Restart (js/restart.js, the game
// menu), view-only after a defeat and CSP safety. Run after `npm run build:wasm`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { DIALOGS, dialogContent, EndGameDialog, EndGameFlow } from '../js/endgame.js';
import {
  actionsPerMinute,
  formatDuration,
  GRAPHS,
  graphLayout,
  graphSeries,
  nearestIndex,
  niceScale,
  rateSeries,
  shapeReport,
  STATS_TABS,
  StatsScreen,
  tableRows,
} from '../js/stats.js';
import { RESTART_KEY, restartRecord, saveRestart, takeRestart } from '../js/restart.js';
import { GameMenu } from '../js/gamemenu.js';
import { viewOnly } from '../js/observer.js';
import { QUERY_DEFAULTS } from '../js/sim/methods.js';
import { SimCore } from '../js/sim/core.js';
import { replayOptions } from '../js/protocol.js';
import { installDom, memoryStorage, settle, textOf, uninstallDom } from './dom-fixtures.mjs';

const wasm = initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });

const SKIRMISH = {
  seed: 4321,
  mapSize: 64,
  players: [
    { slot: 0, type: 'human', name: 'Me', faction: 'england', color: 0, team: 0 },
    { slot: 1, type: 'closed' },
    { slot: 2, type: 'ai', difficulty: 'hard', faction: 'russia', color: 1, team: 0 },
    { slot: 3, type: 'ai', difficulty: 'hard', faction: 'france', color: 2, team: 0 },
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
  // OpenRA's other lobby options (protocol 6).
  crates: true,
  shortGame: true,
  bounty: false,
  separateTeamSpawns: true,
  allyBuildRadius: true,
  timeLimit: 0,
  reusableEngineers: false,
  cheats: false,
  mapStyle: 'land',
  biome: 'temperate',
  weather: 'full',
};

const PLAYERS = [
  { name: 'Me', color: [0.2, 0.4, 1] },
  { name: 'Ivan', color: [1, 0.2, 0.2] },
  { name: 'Pierre', color: [1, 0.8, 0.2] },
];

/** A skirmish where the AIs play `ticks` ticks (the human does nothing). */
function playedGame(ticks) {
  const game = Game.from_options(JSON.stringify(replayOptions(SKIRMISH)));
  for (let t = 0; t < ticks; t++) game.tick();
  return game;
}

const PLAYING = { defeated: false, won: false, winner: null };
const LOST = { defeated: true, won: false, winner: null };

// ---- EndGameFlow ------------------------------------------------------------------------

test('single player: the defeat pauses, spectating unpauses, the end of the game shows the result', () => {
  const changes = [];
  const flow = new EndGameFlow({ onChange: (f) => changes.push([f.dialog, f.paused, f.spectating]) });
  assert.equal(flow.update(PLAYING), null);
  assert.equal(flow.paused, false);
  assert.equal(flow.update(LOST), 'defeat');
  assert.equal(flow.dialog, DIALOGS.DEFEAT);
  assert.equal(flow.paused, true, 'paused while the dialog is open');
  assert.equal(flow.update(LOST), null, 'once');
  assert.equal(flow.spectate(), true);
  assert.deepEqual([flow.dialog, flow.paused, flow.spectating, flow.watching], [null, false, true, true]);
  // The AIs play on; one wins.
  assert.equal(flow.update({ defeated: true, won: false, winner: 2 }), 'over');
  assert.equal(flow.dialog, DIALOGS.FINAL);
  assert.equal(flow.paused, true);
  assert.equal(flow.update({ defeated: true, won: false, winner: 2 }), null, 'the result shows once');
  flow.close();
  assert.equal(flow.paused, false);
  assert.deepEqual(changes, [
    ['defeat', true, false],
    [null, false, true],
    ['final', true, true],
    [null, false, true],
  ]);
});

test('online: the same dialogs, never a pause; the dialog says so', () => {
  const flow = new EndGameFlow({ online: true });
  flow.update(LOST);
  assert.equal(flow.dialog, DIALOGS.DEFEAT);
  assert.equal(flow.paused, false, 'online games cannot pause');
  const c = dialogContent(flow, { canRestart: false });
  assert.match(c.text, /cannot be paused/);
  assert.deepEqual(
    c.buttons.map((b) => b.id),
    ['spectate', 'stats', 'leave', 'exit'],
    'no restart online',
  );
  assert.equal(c.buttons.find((b) => b.id === 'leave').label, 'Leave game');
  flow.spectate();
  assert.equal(flow.spectating, true);
});

test('victory, a defeat on the last tick, an ally winning after a defeat', () => {
  const win = new EndGameFlow();
  assert.equal(win.update({ defeated: false, won: true, winner: 0 }), 'victory');
  const c = dialogContent(win, { canRestart: true, canDownload: true, winnerText: 'Me wins' });
  assert.equal(c.title, 'Mission accomplished');
  assert.deepEqual(
    c.buttons.map((b) => b.id),
    ['stats', 'restart', 'download', 'leave', 'exit'],
    'a won game is over: no playing on',
  );
  assert.equal(c.buttons[0].primary, true);
  assert.match(c.text, /Me wins/);
  assert.doesNotMatch(c.text, /paused/, 'nothing left to pause');
  assert.equal(c.buttons.find((b) => b.id === 'restart').label, 'Play again');
  assert.equal(win.spectate(), false, 'a winner does not spectate');
  win.close();
  assert.equal(win.dialog, DIALOGS.VICTORY, 'the victory dialog cannot be closed');
  assert.equal(win.paused, true, 'the local game stays stopped behind it');
  assert.equal(win.update({ defeated: false, won: true, winner: 0 }), null);

  // 1 against 1: defeated on the tick the game ends. One dialog, it is the final result.
  const last = new EndGameFlow();
  assert.equal(last.update({ defeated: true, won: false, winner: 1 }), 'defeat');
  assert.equal(dialogContent(last, { winnerText: 'Ivan wins' }).buttons[0].label, 'Keep watching');
  assert.match(dialogContent(last, { winnerText: 'Ivan wins' }).text, /Ivan wins\./);
  last.spectate();
  assert.equal(last.update({ defeated: true, won: false, winner: 1 }), null);

  // Defeated, then the ally wins: Mission accomplished after all.
  const team = new EndGameFlow();
  team.update(LOST);
  team.spectate();
  assert.equal(team.update({ defeated: true, won: true, winner: 2 }), 'over');
  const f = dialogContent(team, { winnerText: 'Me and Pierre win' });
  assert.equal(f.title, 'Mission accomplished');
  assert.match(f.text, /Your team won/);
});

test('spectators and replays: only the final result; a replay restart starts over', () => {
  const v = new EndGameFlow({ viewer: true, replay: true });
  assert.equal(v.update(LOST), null, 'a viewer is never defeated');
  assert.equal(v.update(PLAYING, { ended: true }), 'over', 'the replay ended');
  assert.equal(v.paused, false, 'replays keep playing');
  const c = dialogContent(v, { canRestart: true });
  assert.equal(c.title, 'Replay ended');
  assert.equal(c.buttons.find((b) => b.id === 'restart').label, 'Restart replay');
  v.reset();
  assert.equal(v.dialog, null);
  assert.equal(v.update({ ...PLAYING, winner: 1 }), 'over');
  assert.equal(dialogContent(v, {}).title, 'Game over');
});

test('the dialog renders its buttons and runs their actions', () => {
  installDom();
  try {
    const root = document.createElement('section');
    document.body.append(root);
    const flow = new EndGameFlow({ onChange: () => dialog.render() });
    const ran = [];
    const actions = Object.fromEntries(['spectate', 'continue', 'stats', 'restart', 'download', 'leave', 'exit'].map((id) => [id, () => ran.push(id)]));
    actions.spectate = () => flow.spectate();
    const dialog = new EndGameDialog(root, { flow, actions, context: () => ({ canRestart: true }) });
    assert.equal(root.hidden, true);
    flow.update(LOST);
    assert.equal(root.hidden, false);
    assert.match(textOf(root), /Mission failed/);
    assert.match(textOf(root), /The game is paused/);
    const btn = (id) => root.querySelector(`[data-action="${id}"]`);
    assert.equal(document.activeElement, btn('spectate'), 'the main choice has focus');
    btn('stats').click();
    btn('restart').click();
    assert.deepEqual(ran, ['stats', 'restart']);
    btn('spectate').click();
    assert.equal(root.hidden, true);
    assert.equal(flow.spectating, true);
  } finally {
    uninstallDom();
  }
});

// ---- Statistics: shaping and scaling --------------------------------------------------

test('scales: round steps, never below zero for positive data, nearest samples, rates', () => {
  assert.deepEqual(niceScale(0, 9300), { min: 0, max: 10000, step: 2000, ticks: [0, 2000, 4000, 6000, 8000, 10000] });
  assert.deepEqual(niceScale(0, 0).ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.equal(niceScale(5, 5).min, 0, 'a flat positive line starts at 0');
  const s = niceScale(-120, 480);
  assert.ok(s.min <= -120 && s.max >= 480 && [1, 2, 2.5, 5].some((k) => s.step / 10 ** Math.floor(Math.log10(s.step)) === k));
  assert.equal(nearestIndex([1, 125, 250, 375], 200), 2);
  assert.equal(nearestIndex([1, 125, 250, 375], 9999), 3);
  assert.equal(nearestIndex([], 5), -1);
  // 1000 earned per 125 ticks (5 s) is 12,000 a minute.
  const ticks = [1, 125, 250, 375, 500];
  assert.deepEqual(rateSeries(ticks, [0, 1000, 2000, 3000, 4000], 25).map(Math.round).slice(1), [12097, 12048, 12032, 12024]);
  assert.equal(rateSeries([0, 1500, 3000], [0, 600, 600], 25).at(-1), 0, 'nothing in the last minute');
  assert.equal(actionsPerMinute(120, 25 * 60 * 2), 60);
  assert.equal(formatDuration(25 * 3725), '1:02:05');
  assert.deepEqual(tableRows(5, 120), [0, 1, 2, 3, 4]);
  const thin = tableRows(1000, 120);
  assert.ok(thin.length <= 121 && thin[0] === 0 && thin.at(-1) === 999);
});

test('graph layout: every point inside the plot, time left to right, values bottom to top', () => {
  const ticks = [1, 125, 250, 375];
  const series = [
    { player: 0, values: [0, 500, 2500, 1200] },
    { player: 1, values: [0, 100, 300, 9100] },
  ];
  const L = graphLayout(series, ticks, 600, 260);
  assert.equal(L.scale.max, 10000);
  for (const s of series) {
    for (let i = 0; i < ticks.length; i++) {
      const x = L.xOf(ticks[i]);
      const y = L.yOf(s.values[i]);
      assert.ok(x >= L.plot.x0 && x <= L.plot.x1, `x ${x}`);
      assert.ok(y >= L.plot.y0 && y <= L.plot.y1, `y ${y}`);
    }
  }
  assert.equal(L.xOf(1), L.plot.x0);
  assert.equal(L.xOf(375), L.plot.x1);
  assert.equal(L.yOf(0), L.plot.y1);
  assert.equal(L.yOf(10000), L.plot.y0);
  assert.ok(Math.abs(L.tickOf(L.xOf(250)) - 250) < 1e-9, 'pointer x back to the time');
  // No data at all still gives a usable scale.
  assert.equal(graphLayout([], [], 300, 200).scale.max, 1);
});

test('a real engine report shapes into every tab, the score ranking and the graphs', () => {
  const game = playedGame(25 * 90);
  const report = JSON.parse(game.observer_report());
  assert.equal(report.players.length, 3);
  assert.deepEqual(report.history.ticks.slice(0, 3), [1, 125, 250]);
  const rules = JSON.parse(game.rules_json());
  const d = shapeReport(report, { players: PLAYERS, rules, localPlayer: 0 });
  for (const [tab] of STATS_TABS.filter(([t]) => t !== 'graphs')) {
    assert.equal(d.tables[tab].rows.length, 3, tab);
    for (const r of d.tables[tab].rows) assert.equal(r.cells.length, d.tables[tab].columns.length, `${tab}: one cell per column`);
  }
  assert.equal(d.rows[0].local, true);
  assert.equal(d.result, 'The game is still on');
  assert.equal(d.duration, '1:30');
  const scores = d.ranking.map((r) => r.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'ranked by score');
  // The AIs built things: names come from the rules.
  const built = d.lists.production.find((l) => l.player === 1).entries;
  assert.ok(built.length > 0 && built.every((e) => e.name && e.count > 0));
  assert.ok(built.some((e) => e.name === rules.actors.find((a) => a.id === e.id).name));
  assert.equal(d.tables.basic.rows[1].cells.at(-1), 'AI', 'AIs have no actions per minute');
  for (const g of GRAPHS) {
    const series = graphSeries(report, g.id);
    assert.equal(series.length, 3, g.id);
    for (const s of series) assert.equal(s.values.length, report.history.ticks.length, `${g.id}: aligned with the ticks`);
  }
  const army = graphSeries(report, 'army');
  assert.deepEqual(army[1].values, report.history.players[1].armyValue);
  // The winner shows once the game is decided.
  const over = { ...report, winner: 1, endTick: report.tick, players: report.players.map((p) => ({ ...p, won: p.player === 1, defeated: p.player !== 1 })) };
  assert.equal(shapeReport(over, { players: PLAYERS }).result, 'Ivan wins');
  assert.equal(shapeReport(over, { players: PLAYERS }).ranking.find((r) => r.player === 1).won, true);
});

test('the statistics are identical through the simulation boundary and in a replayed copy', () => {
  const a = playedGame(25 * 40);
  const b = playedGame(25 * 40);
  assert.equal(a.observer_report(), b.observer_report(), 'deterministic');
  assert.equal(QUERY_DEFAULTS.observer_report(), null, 'null until the worker answered');
  const core = new SimCore({ Game, memory: () => wasm.memory });
  core.start({ kind: 'skirmish', options: replayOptions(SKIRMISH), map: null, player: 0, recorder: null, tickMs: 40 });
  for (let i = 0; i < 25; i++) core.step({ dt: 40 * 8, view: 0, rect: [0, 0, 100, 100] });
  const viaCore = JSON.parse(core.query('observer_report', []));
  assert.equal(viaCore.tick, core.game.tick_count());
  assert.equal(viaCore.players.length, 3);
});

test('the statistics screen: tabs, graphs with their data table, actions, Esc closes', async () => {
  installDom();
  const listeners = [];
  window.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
  try {
    const game = playedGame(25 * 60);
    const rules = JSON.parse(game.rules_json());
    const root = document.createElement('section');
    document.body.append(root);
    let loads = 0;
    let closed = 0;
    const played = [];
    const screen = new StatsScreen(root, {
      load: async () => {
        loads++;
        return JSON.parse(game.observer_report());
      },
      players: PLAYERS,
      rules,
      localPlayer: 0,
      actions: [{ label: 'Play again', run: () => played.push('again') }],
      onChange: (open) => !open && closed++,
    });
    assert.equal(root.hidden, true);
    await screen.open();
    assert.equal(root.hidden, false);
    assert.equal(loads, 1);
    assert.match(textOf(root), /Statistics/);
    assert.match(textOf(root), /Me \(you\)/);
    const tabs = root.querySelectorAll('[role="tab"]');
    assert.deepEqual(
      tabs.map((t) => t.textContent),
      STATS_TABS.map(([, label]) => label),
    );
    assert.equal(root.querySelectorAll('tbody tr').length, 3, 'one row per player');
    tabs.find((t) => t.textContent === 'Production').click();
    assert.equal(root.querySelector('[aria-selected="true"]').textContent, 'Production');
    assert.match(textOf(root), /Ivan: built/);
    root.querySelectorAll('[role="tab"]').find((t) => t.textContent === 'Graphs').click();
    assert.ok(root.querySelector('canvas'), 'a graph');
    assert.equal(root.querySelector('canvas').getAttribute('role'), 'img');
    const table = root.querySelector('details table');
    assert.ok(table, 'the accessible table behind the graph');
    assert.equal(table.querySelectorAll('thead th').length, 4, 'time plus one column per player');
    root.querySelectorAll('button').find((b) => b.textContent === 'Play again').click();
    assert.deepEqual(played, ['again']);
    // Esc closes it (capture phase, before game hotkeys).
    const key = listeners.find((l) => l.type === 'keydown' && l.capture === true);
    let stopped = false;
    key.fn({ key: 'Escape', preventDefault() {}, stopImmediatePropagation: () => (stopped = true) });
    assert.equal(root.hidden, true);
    assert.equal(stopped, true);
    assert.equal(closed, 1);
    await settle();
  } finally {
    uninstallDom();
  }
});

// ---- Restart ------------------------------------------------------------------------------

test('restart settings: stored per tab, taken once, malformed ones dropped', () => {
  const storage = memoryStorage();
  const options = { ...SKIRMISH, map: '{"format":2,"name":"Test"}' };
  const record = restartRecord(options);
  assert.ok(saveRestart(record, storage));
  const back = takeRestart(storage);
  assert.deepEqual(back.options, options, 'the same options, map text included');
  assert.notEqual(back.options.players, options.players, 'a copy');
  assert.equal(takeRestart(storage), null, 'runs once');
  storage.setItem(RESTART_KEY, '{"v":1,"kind":"skirmish","options":{"players":"x"}}');
  assert.equal(takeRestart(storage), null);
  assert.equal(storage.getItem(RESTART_KEY), null, 'a malformed record is removed');
  storage.setItem(RESTART_KEY, 'not json');
  assert.equal(takeRestart(storage), null);
  assert.throws(() => restartRecord({ players: [] }));
  assert.throws(() => restartRecord({ ...SKIRMISH, map: { not: 'text' } }));
  assert.equal(saveRestart(record, { setItem: () => { throw new Error('quota'); } }), false);
  assert.equal(takeRestart(null), null);
});

test('a restarted game is the same game from tick 0: options round trip, identical simulation', () => {
  const storage = memoryStorage();
  saveRestart(restartRecord(SKIRMISH), storage);
  const again = takeRestart(storage).options;
  const first = Game.from_options(JSON.stringify(replayOptions(SKIRMISH)));
  const second = Game.from_options(JSON.stringify(replayOptions(again)));
  assert.equal(second.tick_count(), 0);
  for (let t = 0; t < 500; t++) {
    first.tick();
    second.tick();
  }
  assert.equal(first.state_hash(), second.state_hash());
  assert.equal(first.observer_report(), second.observer_report(), 'fresh statistics, the same ones');
  // A loaded save restarts from its own options (the replay form: closed slots already out).
  const saved = replayOptions(SKIRMISH);
  assert.deepEqual(replayOptions(takeRestartOf({ ...saved, map: null })), saved, 'replay form options restart unchanged');
});

function takeRestartOf(options) {
  const storage = memoryStorage();
  saveRestart(restartRecord(options), storage);
  const { map: _map, ...rest } = takeRestart(storage).options;
  return rest;
}

test('the game menu: Restart asks first; Statistics only while watching', () => {
  installDom();
  try {
    const root = document.createElement('section');
    document.body.append(root);
    let restarts = 0;
    let watching = false;
    const menu = new GameMenu(root, {
      online: false,
      hotkeys: { onChange() {}, list: () => [], actionFor: () => null, handle() {} },
      settings: { get: () => 0, set: (k, v) => v, reset() {}, subscribe() {} },
      fullscreen: { available: () => false, active: () => false, toggle: async () => ({ ok: true }) },
      onChange() {},
      restart: { run: () => restarts++ },
      onStats() {},
      statsAvailable: () => watching,
      onLeave() {},
      onExit() {},
    });
    menu.open();
    const button = (label) => root.querySelectorAll('button').find((b) => b.textContent === label);
    assert.equal(button('Statistics'), undefined, 'a player still in the game sees no live statistics');
    button('Restart').click();
    assert.equal(restarts, 0, 'not without confirming');
    assert.match(textOf(root), /same settings/);
    button('Back').click();
    button('Restart').click();
    button('Restart').click();
    assert.equal(restarts, 1);
    assert.equal(menu.isOpen, false);
    watching = true;
    menu.open();
    assert.ok(button('Statistics'));
  } finally {
    uninstallDom();
  }
});

// ---- View only after a defeat -------------------------------------------------------------

test('a player turns view-only when it starts spectating', () => {
  const game = Game.from_options(JSON.stringify(replayOptions(SKIRMISH)));
  game.set_lockstep(true);
  let spectating = false;
  const ui = viewOnly(game, () => spectating);
  const ids = Uint32Array.from(game.select_box(0, -1e9, -1e9, 1e9, 1e9));
  ui.order_move(0, ids, 100, 100, false);
  assert.notEqual(game.take_orders(), '[]', 'orders work while playing');
  spectating = true;
  ui.order_move(0, ids, 100, 100, false);
  ui.start_production(0, 'E1', 1);
  ui.sell(0, ids[0] ?? 0);
  assert.equal(game.take_orders(), '[]', 'no orders once watching');
  assert.equal(ui.cursor_action(0, ids, 0, 0), 0);
  assert.equal(ui.tick_count(), 0, 'reading still works');
});

// ---- CSP ----------------------------------------------------------------------------------

test('CSP safety: the end-game UI builds the DOM with text only, no HTML strings or inline styles', () => {
  for (const rel of ['../js/endgame.js', '../js/stats.js', '../js/restart.js', '../js/gamemenu.js', '../js/observer.js']) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|setAttribute\(\s*['"]style|\.style\.cssText|eval\(|new Function/, rel);
  }
  const css = readFileSync(fileURLToPath(new URL('../css/endgame.css', import.meta.url)), 'utf8');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/, 'no remote styles');
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="css\/endgame.css" \/>/);
  assert.doesNotMatch(html, /\sstyle=|<script>|\son[a-z]+=/i, 'no inline styles or scripts in the page');
});

test('a game the time limit ends without a winner still ends (gameOver)', () => {
  const flow = new EndGameFlow({});
  assert.equal(flow.update(PLAYING), null);
  // Everyone lost at once: the defeat is the final result.
  assert.equal(flow.update({ defeated: true, won: false, winner: null, gameOver: true }), 'defeat');
  assert.equal(flow.over, true);
  const viewer = new EndGameFlow({ viewer: true });
  assert.equal(viewer.update({ defeated: false, won: false, winner: null, gameOver: true }), 'over');
});
