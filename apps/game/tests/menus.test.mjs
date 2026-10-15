// The 0.17 menu screens: the start screen's online count (js/startmenu.js),
// the loading screen's board and tips (js/loadingboard.js, js/tips.js).
// Synthetic data only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { click, installDom, textOf, uninstallDom } from './dom-fixtures.mjs';
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
    assert.doesNotMatch(t.text, /[–—]/, 'no en or em dashes');
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
