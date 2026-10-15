// The 0.17 menu screens: the start screen's online count (js/startmenu.js),
// the loading screen's board and tips (js/loadingboard.js, js/tips.js).
// Synthetic data only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEvent, click, installDom, textOf, uninstallDom } from './dom-fixtures.mjs';
import { TIPS, TIP_GROUPS, TIP_MS, nextTipIndex, stepTip, tipParts } from '../js/tips.js';
import { LoadingBoard, colorCss, describeStart, factionText, mapNameOf, startSides, versusText } from '../js/loadingboard.js';
import { LoadingScreen, loadingPlan } from '../js/loadingscreen.js';
import { OPENRA_HOTKEYS } from '../js/openra-hotkeys.js';
import { LOADING_TIP_INDEX_MAX } from '../protocol/index.js';

afterEach(() => uninstallDom());

/** Interval timers the test runs by hand. */
function fakeTimers() {
  const intervals = new Map();
  let ids = 0;
  return {
    intervals,
    setInterval: (fn, ms) => (intervals.set(++ids, { fn, ms }), ids),
    clearInterval: (id) => intervals.delete(id),
    tick: () => [...intervals.values()].forEach((t) => t.fn()),
  };
}

// ---- Tips --------------------------------------------------------------------------------------

test('tips: one sentence each, at most two lines, every hotkey a real one; shown in turn after the last one', () => {
  assert.equal(TIPS.length, TIP_GROUPS.reduce((n, g) => n + g.tips.length, 0));
  assert.ok(TIPS.length <= LOADING_TIP_INDEX_MAX + 1, 'guide.lastTip can name every tip');
  for (const t of TIPS) {
    assert.ok(t.text.length <= 110, `too long for two lines: ${t.text}`);
    assert.doesNotMatch(t.text, /[\u2013\u2014]/, 'no en or em dashes');
    if (t.hotkey) assert.ok(OPENRA_HOTKEYS[t.hotkey]?.key, `${t.hotkey} is an OpenRA hotkey with a key`);
  }
  assert.equal(TIP_MS, 5000);
  assert.equal(nextTipIndex(-1), 0);
  assert.equal(nextTipIndex(3), 4);
  assert.equal(nextTipIndex(TIPS.length - 1), 0, 'round the list');
  assert.equal(nextTipIndex(9999), 0, 'a stored index this version has no tip for starts over');
  assert.equal(stepTip(0, -1), TIPS.length - 1);
  assert.deepEqual(tipParts({ hotkey: 'AttackMove', text: 'x' }, () => 'A'), { key: 'A', text: 'x' });
  assert.deepEqual(tipParts({ hotkey: 'AttackMove', text: 'x' }, () => null), { key: null, text: 'x' }, 'unbound: no key');
  assert.deepEqual(tipParts({ key: 'Shift', text: 'x' }, () => null), { key: 'Shift', text: 'x' });
});

// ---- Loading board -----------------------------------------------------------------------------

const PLAYERS = [
  { type: 'human', name: 'Commander', faction: 'england', team: 1, color: 0 },
  { type: 'human', name: 'Kara', faction: 'randomallies', team: 1, color: 1 },
  { type: 'ai', faction: 'russia', team: 2, color: 2, bot: 'turtle', difficulty: 'hard' },
  { type: 'ai', faction: 'random', team: 2, color: 3, difficulty: 'normal' },
];

test('loading board: the sides by team with the local player and the AIs named, the versus line and the map name', () => {
  assert.equal(factionText('england'), 'Allies · England');
  assert.equal(factionText('randomsoviet'), 'Soviet · Random');
  assert.equal(factionText('random'), 'Random');
  assert.equal(colorCss([1, 0.5, 0]), 'rgb(255, 128, 0)');
  assert.equal(mapNameOf('{"name":" Ore Lord "}'), 'Ore Lord');
  assert.equal(mapNameOf('not json'), null);
  const sides = startSides(PLAYERS, { you: 0, colorOf: (c) => `c${c}` });
  assert.deepEqual(
    sides.map((s) => [s.label, s.players.map((p) => [p.name, p.tag, p.color])]),
    [
      ['Team 1', [['Commander', 'You', 'c0'], ['Kara', '', 'c1']]],
      ['Team 2', [['Turtle AI', 'AI · Hard', 'c2'], ['Normal AI', 'AI · Normal', 'c3']]],
    ],
  );
  assert.equal(versusText(sides), '2 vs 2');
  // Without teams everyone is a side of their own; many of them are a free for all.
  const ffa = startSides(PLAYERS.map((p) => ({ ...p, team: 0 })), { you: 0 });
  assert.equal(ffa.length, 4);
  assert.equal(versusText(ffa), 'Free for all');
  assert.equal(versusText(ffa.slice(0, 2)), '1 vs 1');
  // Closed slots do not play.
  assert.equal(startSides([...PLAYERS, { type: 'closed' }]).flatMap((s) => s.players).length, 4);
  const d = describeStart({ kind: 'skirmish', options: { players: PLAYERS }, map: '{"name":"Ore Lord"}', player: 0 });
  assert.equal(d.kicker, 'Skirmish · 2 vs 2');
  assert.equal(d.title, 'Ore Lord');
  // A replay watches: nobody is "You"; a generated map keeps the screen's title.
  const r = describeStart({ kind: 'replay', replay: { options: { players: PLAYERS }, map: null } });
  assert.equal(r.title, null);
  assert.ok(r.sides.flatMap((s) => s.players).every((p) => !p.you));
});

function mountScreen({ lastTip = -1 } = {}) {
  const doc = installDom();
  const root = doc.createElement('section');
  doc.body.append(root);
  const timers = fakeTimers();
  const kept = [];
  const board = new LoadingBoard({ doc, timers, tips: { get: () => lastTip, set: (i) => kept.push(i) }, keyText: (h) => (h === 'AttackMove' ? 'A' : null) });
  const screen = new LoadingScreen(root, { doc, board, reducedMotion: () => true });
  return { doc, root, screen, board, timers, kept };
}

test('loading board: around the steps it shows the emblem, the kicker, the sides with VS, and the tips in turn', () => {
  const { root, screen, timers, kept } = mountScreen({ lastTip: 4 });
  screen.begin(loadingPlan('skirmish'));
  // The screen's own parts stay: title (the dialog's name), status, bar and steps, now in the bottom block.
  assert.equal(textOf(root.querySelector('.loading-kicker')), 'Skirmish');
  assert.ok(root.querySelector('.loading-intro .loading-title'));
  assert.ok(root.querySelector('.loading-bottom .loading-bar[role="progressbar"]'));
  assert.ok(root.querySelector('.loading-bottom .loading-steps'));
  assert.equal(root.querySelector('.loading-sides').hidden, true, 'no sides until the start is known');
  // The tip after the last one shown.
  assert.equal(textOf(root.querySelector('.loading-tip-count')), `Tip 6 of ${TIPS.length}`);
  assert.equal(root.querySelector('.loading-tip-text').getAttribute('aria-live'), 'polite');
  screen.describe(describeStart({ kind: 'skirmish', options: { players: PLAYERS }, map: '{"name":"Ore Lord"}', player: 0 }));
  assert.equal(textOf(root.querySelector('.loading-title')), 'Ore Lord');
  assert.equal(textOf(root.querySelector('.loading-kicker')), 'Skirmish · 2 vs 2');
  assert.equal(root.querySelector('.loading-sides').hidden, false);
  assert.deepEqual(root.querySelectorAll('.loading-side-label').map(textOf), ['Team 1', 'Team 2']);
  assert.ok(root.querySelector('.loading-sides > .loading-vs'), 'two sides face each other');
  assert.equal(root.querySelector('.loading-vs').getAttribute('aria-hidden'), 'true');
  assert.equal(root.querySelectorAll('.loading-player').length, 4);
  assert.equal(textOf(root.querySelector('.loading-player-tag.is-you')), 'You');
  assert.equal(root.querySelector('.loading-flag').dataset.faction, 'england');
  // Next and Previous; the timer moves on by itself.
  click(root.querySelector('.loading-tip-next'));
  assert.equal(textOf(root.querySelector('.loading-tip-count')), `Tip 7 of ${TIPS.length}`);
  click(root.querySelector('.loading-tip-prev'));
  click(root.querySelector('.loading-tip-prev'));
  assert.equal(textOf(root.querySelector('.loading-tip-count')), `Tip 5 of ${TIPS.length}`);
  assert.equal(timers.intervals.size, 1);
  assert.equal([...timers.intervals.values()][0].ms, TIP_MS);
  timers.tick();
  assert.equal(textOf(root.querySelector('.loading-tip-count')), `Tip 6 of ${TIPS.length}`);
  // The tip buttons are in the card: Tab cycles through them.
  assert.ok(root.querySelectorAll('.loading-card button').length >= 2);
  // The first frame (Reduce motion: at once): the tips stop, the last one shown is kept.
  screen.done();
  assert.equal(root.hidden, true);
  assert.equal(timers.intervals.size, 0);
  assert.deepEqual(kept, [5]);
});

test('loading board: an attack move tip shows the key; a failed start stops the tips', () => {
  const index = TIPS.findIndex((t) => t.hotkey === 'AttackMove');
  const { root, screen, timers, kept } = mountScreen({ lastTip: index - 1 });
  screen.begin(loadingPlan('online'));
  assert.equal(textOf(root.querySelector('.loading-tip-key')), 'A');
  // A tip without a bound key reads without one.
  click(root.querySelector('.loading-tip-next'));
  screen.fail('Could not start the game: test');
  assert.equal(timers.intervals.size, 0);
  assert.deepEqual(kept, [index + 1]);
  assert.equal(root.querySelector('.loading-tip'), null, 'the error card has no tips');
});

// ---- Start screen ------------------------------------------------------------------------------

test('main menu: the players online show next to the account, asked again every minute while the start screen shows', async () => {
  const doc = installDom();
  const { mountStartMenu, onlineText, ONLINE_REFRESH_MS } = await import('../js/startmenu.js');
  assert.equal(onlineText(1), '1 player online');
  assert.equal(onlineText(1204), '1,204 players online');
  assert.equal(onlineText(undefined), null);
  const nav = doc.createElement('nav');
  const more = doc.createElement('button');
  more.id = 'start-more-button';
  const list = doc.createElement('div');
  list.id = 'start-more-list';
  list.hidden = true;
  const online = doc.createElement('p');
  online.id = 'start-online';
  online.hidden = true;
  const text = doc.createElement('span');
  text.className = 'start-online-text';
  online.append(text);
  nav.append(more, list, online);
  doc.body.append(nav);
  const timers = fakeTimers();
  let players = 12;
  let shows = true;
  const menu = mountStartMenu(nav, { onlineCount: async () => (players === null ? undefined : { players }), visible: () => shows, timers });
  await new Promise((r) => setImmediate(r));
  assert.equal(online.hidden, false);
  assert.equal(textOf(online), '12 players online');
  assert.equal([...timers.intervals.values()][0].ms, ONLINE_REFRESH_MS);
  // Not asked while a game or another screen shows.
  players = 3;
  shows = false;
  timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(textOf(online), '12 players online');
  shows = true;
  await menu.refreshOnline();
  assert.equal(textOf(online), '3 players online');
  // A server without the count (before protocol 8): hidden.
  players = null;
  await menu.refreshOnline();
  assert.equal(online.hidden, true);
  menu.stop();
  assert.equal(timers.intervals.size, 0);
});

test('main menu: without an online count handler the line stays hidden', async () => {
  const doc = installDom();
  const { mountStartMenu } = await import('../js/startmenu.js');
  const nav = doc.createElement('nav');
  const more = doc.createElement('button');
  more.id = 'start-more-button';
  const list = doc.createElement('div');
  list.id = 'start-more-list';
  const online = doc.createElement('p');
  online.id = 'start-online';
  online.hidden = true;
  nav.append(more, list, online);
  doc.body.append(nav);
  mountStartMenu(nav, {});
  assert.equal(online.hidden, true);

});

// ---- End of game and statistics ---------------------------------------------------------------

/** A synthetic observer report (engine/src/observer.rs shape): two teams of two, team 1 won. */
function report() {
  const player = (p, team, extra) => ({
    player: p,
    faction: ['england', 'france', 'russia', 'ukraine'][p],
    team,
    isAi: p >= 2,
    funds: 1000,
    earned: 10000 * (p + 1),
    harvestedOre: 0,
    harvestedGems: 0,
    spent: 0,
    repairSpent: 0,
    sold: 0,
    armyValue: 500,
    unitsKilled: 10 + p,
    unitsLost: 3,
    buildingsKilled: 2,
    buildingsLost: 1,
    assetsDestroyed: 4000,
    assetsLost: 1200,
    damageDealt: 0,
    damageTaken: 0,
    unitsBuilt: 0,
    buildingsBuilt: 0,
    aircraftBuilt: 0,
    shipsBuilt: 0,
    builtValue: 0,
    experience: 900,
    promotions: 0,
    powersUsed: 0,
    orders: 100,
    score: 100 * p,
    powerGenerated: 0,
    powerUsed: 0,
    defeated: false,
    defeatedAt: null,
    won: false,
    ...extra,
  });
  const players = [player(0, 1, { won: true }), player(1, 1, { won: true }), player(2, 2, { defeated: true, defeatedAt: 25 * 60 }), player(3, 2, { defeated: true, defeatedAt: 25 * 90 })];
  return {
    tick: 25 * 120,
    ticksPerSecond: 25,
    winner: 0,
    endTick: 25 * 120,
    players,
    history: { interval: 125, ticks: [0, 125], players: players.map((p) => ({ player: p.player, earned: [0, 1], armyValue: [0, 1], funds: [0, 1], spent: [0, 0], kills: [0, 0], deaths: [0, 0], assetsDestroyed: [0, 0], assetsLost: [0, 0], powerGenerated: [0, 0], orders: [0, 0] })) },
  };
}
const NAMES = [
  { name: 'Commander', color: [0.3, 0.5, 0.9] },
  { name: 'Kara', color: [0.3, 0.8, 0.4] },
  { name: 'Turtle AI', color: [0.9, 0.3, 0.2] },
  { name: 'Normal AI', color: [0.9, 0.8, 0.2] },
];

test('end of game: the outcome look, the results by team with a winner head, the rematch line and the count-up', async () => {
  const { DIALOGS, EndGameFlow, endOutcome, kickerText, resultRows, rematchLine, countShare, RESULT_COLUMNS, REPLAY_TEXTS } = await import('../js/endgame.js');
  const { shapeReport } = await import('../js/stats.js');
  const flow = new EndGameFlow({});
  flow.update({ defeated: false, won: true, winner: 0 });
  assert.equal(flow.dialog, DIALOGS.VICTORY);
  assert.equal(endOutcome(flow), 'victory');
  const lost = new EndGameFlow({});
  lost.update({ defeated: true, won: false, winner: null });
  assert.equal(endOutcome(lost), 'defeat');
  const viewer = new EndGameFlow({ viewer: true });
  viewer.update({ winner: 1 });
  assert.equal(endOutcome(viewer), 'neutral');
  assert.equal(kickerText('Commander and Kara win', '2:00'), 'Commander and Kara win · 2:00');
  assert.equal(kickerText('', '2:00'), '2:00');
  const rows = resultRows(shapeReport(report(), { players: NAMES, localPlayer: 0 }));
  assert.deepEqual(
    rows.map((r) => (r.kind === 'team' ? `[${r.label}]` : r.name)),
    ['[Team 1 · Winner]', 'Commander', 'Kara', '[Team 2]', 'Turtle AI', 'Normal AI'],
  );
  assert.deepEqual(RESULT_COLUMNS.map((c) => c.label), ['Kills', 'Losses', 'Destroyed', 'Earned', 'Experience']);
  assert.deepEqual(rows[1].values, [12, 4, 4000, 10000, 900]);
  assert.equal(rows[1].local, true);
  assert.equal(rows[4].sub, 'AI · Soviet · Russia');
  assert.equal(rematchLine(null), null);
  assert.deepEqual(rematchLine({ by: 'Kara', voters: [{ name: 'Kara', accepted: true }, { name: 'Ivan', accepted: true }, { name: 'Mo', accepted: false }] }).text, 'Kara proposed it · 2 of 3 accepted');
  assert.equal(countShare(0, 1400), 0);
  assert.equal(countShare(1400, 1400), 1);
  assert.equal(countShare(-5, 1400), 0, 'before the delay');
  assert.ok(countShare(700, 1400) > 0.5, 'eases out');
  assert.equal(REPLAY_TEXTS.saved[1], 'Replay saved to your account');
});

test('end of game: the dialog shows the results (numbers at once with Reduce motion), the replay line and the rematch lamps', async () => {
  installDom();
  const { EndGameDialog, EndGameFlow } = await import('../js/endgame.js');
  const root = document.createElement('section');
  document.body.append(root);
  let ctx = { winnerText: 'Commander and Kara win', replay: 'saving', rematch: null };
  const flow = new EndGameFlow({ online: true, onChange: () => dialog.render() });
  const dialog = new EndGameDialog(root, { flow, actions: {}, context: () => ctx, report: async () => report(), players: NAMES, localPlayer: 0, reducedMotion: () => true });
  flow.update({ defeated: false, won: true, winner: 0 });
  await new Promise((r) => setImmediate(r));
  assert.equal(root.dataset.outcome, 'victory');
  assert.ok(root.classList.contains('is-still'));
  assert.equal(root.querySelector('.endgame-fx').getAttribute('aria-hidden'), 'true');
  assert.equal(textOf(root.querySelector('#endgame-title')), 'Mission accomplished');
  assert.equal(root.querySelector('.endgame-glitch').getAttribute('aria-hidden'), 'true');
  assert.equal(textOf(root.querySelector('.endgame-kicker')), 'Commander and Kara win · 2:00');
  assert.equal(textOf(root.querySelector('.endgame-replay')), 'Saving the replay to your account...');
  const cells = root.querySelectorAll('.endgame-table tbody tr')[1].querySelectorAll('td').map(textOf);
  assert.deepEqual(cells, ['12', '4', '$4,000', '$10,000', '900']);
  assert.deepEqual(root.querySelectorAll('.endgame-team th').map(textOf), ['Team 1 · Winner', 'Team 2']);
  // A rematch proposal and the upload's answer update the open dialog without building it again.
  const table = root.querySelector('.endgame-table');
  ctx = { ...ctx, replay: 'saved', rematch: { by: 'Kara', voters: [{ name: 'Kara', accepted: true }, { name: 'Commander', accepted: false }] } };
  dialog.render();
  assert.equal(root.querySelector('.endgame-table'), table, 'the table (and its entrance) stays');
  assert.equal(textOf(root.querySelector('.endgame-replay')), 'Replay saved to your account');
  assert.equal(textOf(root.querySelector('.endgame-rematch-text')), 'Kara proposed it · 1 of 2 accepted');
  assert.deepEqual(root.querySelectorAll('.endgame-rematch-lamps [role="img"]').map((l) => l.getAttribute('aria-label')), ['Kara: accepted', 'Commander: waiting']);
  dialog.dispose();
});

test('end of game: without Reduce motion the numbers count up from 0 after the delay', async () => {
  installDom();
  const { EndGameDialog, EndGameFlow, COUNT_DELAY_MS, COUNT_MS } = await import('../js/endgame.js');
  const root = document.createElement('section');
  document.body.append(root);
  let now = 0;
  const frames = [];
  const flow = new EndGameFlow({ onChange: () => dialog.render() });
  const dialog = new EndGameDialog(root, { flow, actions: {}, context: () => ({}), report: async () => report(), players: NAMES, raf: (fn) => (frames.push(fn), frames.length), cancelRaf() {}, now: () => now });
  flow.update({ defeated: true, won: false, winner: null });
  await new Promise((r) => setImmediate(r));
  assert.equal(root.dataset.outcome, 'defeat');
  const first = () => root.querySelectorAll('.endgame-table tbody tr')[1].querySelectorAll('td').map(textOf);
  assert.deepEqual(first(), ['0', '0', '$0', '$0', '0']);
  assert.equal(root.querySelector('.endgame-table').getAttribute('aria-busy'), 'true');
  now = COUNT_DELAY_MS + COUNT_MS;
  frames.shift()();
  frames.shift()?.();
  assert.deepEqual(first(), ['12', '4', '$4,000', '$10,000', '900']);
  assert.equal(root.querySelector('.endgame-table').getAttribute('aria-busy'), 'false');
});

test('statistics: team head rows, the defeat markers, and the graph list as a select plate', async () => {
  installDom();
  const { StatsScreen, shapeReport, teamSections, graphMarkers } = await import('../js/stats.js');
  const shaped = shapeReport(report(), { players: NAMES });
  assert.deepEqual(teamSections(shaped).map((s) => [s.label, s.won, s.rows.length]), [['Team 1', true, 2], ['Team 2', false, 2]]);
  const ffa = shapeReport({ ...report(), players: report().players.map((p) => ({ ...p, team: 0 })) }, { players: NAMES });
  assert.deepEqual(teamSections(ffa).map((s) => s.label), [null]);
  assert.deepEqual(graphMarkers(shaped), [{ tick: 1500, label: 'Turtle AI defeated' }, { tick: 2250, label: 'Normal AI defeated' }]);
  const root = document.createElement('section');
  document.body.append(root);
  const screen = new StatsScreen(root, { load: async () => report(), players: NAMES, localPlayer: 0 });
  await screen.open();
  assert.deepEqual(root.querySelectorAll('tr.stats-team th').map(textOf), ['Team 1 · Winner', 'Team 2']);
  assert.equal(root.querySelector('[role="tablist"]').getAttribute('aria-orientation'), 'vertical');
  assert.equal(root.querySelectorAll('[role="tab"]').some((t) => textOf(t) === 'Network'), false, 'no Network tab offline');
  screen.show('graphs');
  assert.ok(root.querySelector('.stats-graph-select .ui-sp-button'));
  assert.equal(root.querySelector('select'), null, 'no native select left');
  screen.dispose();
});

test('statistics: an open select list gets its keys, the tab list its arrows (window capture first, then the target); Esc closes only an open list, else the screen', async () => {
  const doc = installDom({ windowEvents: true });
  const { StatsScreen } = await import('../js/stats.js');
  const root = doc.createElement('section');
  doc.body.append(root);
  const screen = new StatsScreen(root, { load: async () => report(), players: NAMES });
  await screen.open('graphs');
  // A game hotkey on the window (bubbling) never hears keys from the screen.
  let hotkeys = 0;
  window.addEventListener('keydown', () => hotkeys++);
  const plate = screen.graphPick;
  click(plate.button);
  assert.equal(plate.isOpen(), true);
  const down = new FakeEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  plate.listbox.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true, 'the list moved its highlight');
  const esc = new FakeEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  plate.listbox.dispatchEvent(esc);
  assert.equal(plate.isOpen(), false, 'Esc closed the list');
  assert.equal(screen.isOpen, true, 'and not the screen');
  // Arrow keys on the tab list move between the panels.
  const tab = root.querySelector('#stats-tab-graphs');
  tab.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(screen.tab, 'powers');
  assert.equal(hotkeys, 0);
  // Esc on a tab is the screen's: it closes; game hotkeys still hear nothing.
  root.querySelector('#stats-tab-powers').dispatchEvent(new FakeEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(screen.isOpen, false);
  assert.equal(hotkeys, 0);
  screen.dispose();
});

test('statistics: the Network tab of an online game: tiles, the stalls on the chart and in a list that opens the replay', async () => {
  installDom();
  const { shapeNetwork, netQuality, seconds } = await import('../js/netstats.js');
  assert.equal(netQuality({ rtt: 34, jitter: 4, late: 0 }), 'good');
  assert.equal(netQuality({ rtt: 118, jitter: 12, late: 0.3 }), 'fair');
  assert.equal(netQuality({ rtt: 190, jitter: 60, late: 4.2 }), 'poor');
  assert.equal(seconds(900), '0.9 s');
  const seats = [
    { player: 0, client: 11, name: 'Commander', type: 'human' },
    { player: 1, client: 12, name: 'Ivan', type: 'human' },
    { player: 2, client: null, name: 'Normal AI', type: 'ai' },
  ];
  const data = {
    seats,
    you: 11,
    self: { sent: 726, latePings: 1 },
    report: new Map([
      [11, { series: [{ t: 0, rtt: 30 }, { t: 10000, rtt: 40 }], avg: 34, worst: 61, worstAt: 842000, jitter: 4, late: 0 }],
      [12, { series: [{ t: 0, rtt: 150 }, { t: 10000, rtt: 3520 }], avg: 190, worst: 3520, worstAt: 852000, jitter: 60, late: 4.2 }],
    ]),
    stalls: { stalls: [{ tick: 21300, client: 12, ms: 3500 }, { tick: 12025, client: 12, ms: 900 }], totals: [{ client: 12, ms: 4400, count: 2 }] },
  };
  const players = new Map([
    [0, { name: 'Commander', css: 'rgb(1, 2, 3)' }],
    [1, { name: 'Ivan', css: 'rgb(4, 5, 6)' }],
  ]);
  const net = shapeNetwork(data, { players, tps: 25, tickMs: 40 });
  assert.deepEqual(net.tiles.map((t) => [t.label, t.value, t.hint]), [
    ['Game waited', '4.4 s', 'in 2 stalls, all for Ivan'],
    ['Your average ping', '34 ms', 'good on average'],
    ['Your worst moment', '61 ms', 'at 14:02'],
    ['Late pings', '0.1%', '1 of 726 took over a second'],
  ]);
  assert.deepEqual(net.rows.map((r) => [r.name, r.quality, r.held, r.you]), [['Commander', 'good', 0, true], ['Ivan', 'poor', 4400, false]]);
  assert.deepEqual(net.stalls.map((s) => [s.at, s.text, s.len]), [['8:01', 'Waited for Ivan', '0.9 s'], ['14:12', 'Waited for Ivan', '3.5 s']]);
  // The screen: the Network tab only with the network data, its stalls open the replay at their tick.
  const { StatsScreen } = await import('../js/stats.js');
  const root = document.createElement('section');
  document.body.append(root);
  const opened = [];
  let over = false;
  const screen = new StatsScreen(root, { load: async () => report(), players: NAMES, network: async () => data, tickMs: 40, openReplayAt: (t) => opened.push(t), canOpenReplay: () => over, stallNote: () => 'The replay opens here once the game is over.' });
  await screen.open('network');
  await new Promise((r) => setImmediate(r));
  assert.equal(textOf(root.querySelector('#stats-tab-network')), 'Network');
  assert.equal(root.querySelectorAll('.net-tile').length, 4);
  assert.equal(root.querySelectorAll('.net-stall').length, 2, 'a red column per stall');
  assert.equal(root.querySelector('.net-svg').getAttribute('role'), 'img');
  // The names are the game's (the statistics' players by seat).
  assert.deepEqual(root.querySelectorAll('.net-table tbody th').map(textOf), ['Commander (you)', 'Kara']);
  const rows = () => root.querySelectorAll('.net-stall-row');
  assert.equal(rows()[0].disabled, true, 'not before the game is over');
  over = true;
  screen.render();
  click(rows()[1]);
  assert.deepEqual(opened, [21300]);
  screen.dispose();
});
