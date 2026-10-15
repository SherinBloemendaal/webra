// The guide and the tour (js/guide.js, js/tour.js, js/guideview.js): the
// steps tick off from engine events, the player state, orders and signals;
// the progress is the declared guide.* setting; the tour runs only in the
// player's own skirmish games and stops when done or skipped; the Guide
// page shows chapters, ticks off read steps and has the tour switch. Fake
// DOM, no browser, no WebAssembly.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, check, textOf, memoryStorage } from './dom-fixtures.mjs';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { GUIDE, HELP } from '../js/help.js';
import { EV, STRIDE } from '../js/audio/director.js';
import { GuideProgress, GuideTracker, STEP_IDS, TOUR_STEPS, TRIGGERS, guideFollows, guideText, readSteps, stepStatus, tourRuns, withGuide } from '../js/guide.js';
import { TourCard, TARGET_CLASS, tourModel } from '../js/tour.js';
import { GameMenu } from '../js/gamemenu.js';
import { SETTINGS_GUIDE_DONE_MAX_BYTES } from '../protocol/accounts.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

const ACTORS = ['MCV', 'FACT', 'POWR', 'APWR', 'PROC', 'TENT', 'BARR', 'WEAP', 'DOME', 'SILO', 'HARV', 'LROD', 'E1'].map((id) => ({ id }));
const T = Object.fromEntries(ACTORS.map((a, i) => [a.id, i]));

/** Engine events as the sim gives them: [kind, a, x, y, owner, b] each. */
function events(...list) {
  const out = new Int32Array(list.length * STRIDE);
  list.forEach(([kind, a = 0, owner = 0, b = 0], i) => out.set([kind, a, 0, 0, owner, b], i * STRIDE));
  return out;
}

function setup() {
  const registry = createRegistry({ storage: memoryStorage() });
  const progress = new GuideProgress(registry);
  const done = [];
  const tracker = new GuideTracker({ progress, actors: ACTORS, player: 0, onDone: (ids) => done.push(...ids) });
  return { registry, progress, tracker, done };
}

test('guide texts: every step has an id, a title, a text and what ticks it off; every step has a trigger; no dashes', () => {
  const ids = GUIDE.flatMap((c) => c.steps.map((s) => s.id));
  assert.equal(new Set(ids).size, ids.length, 'unique step ids');
  assert.deepEqual(ids, STEP_IDS);
  for (const c of GUIDE) {
    assert.ok(c.title && c.intro && c.tip, c.id);
    for (const s of c.steps) {
      assert.ok(s.id.startsWith(`${c.id}.`), s.id);
      assert.ok(s.title && s.text && s.watch, s.id);
      assert.ok(TRIGGERS[s.id], `${s.id} has a trigger`);
      for (const t of [s.title, s.text, s.watch, s.tour ?? '']) assert.doesNotMatch(t, /[\u2013\u2014]/, s.id);
    }
  }
  for (const id of TOUR_STEPS) assert.ok(GUIDE[0].steps.find((s) => s.id === id).tour, `${id} has the tour's text`);
  // Facts that follow the rules (the README and HELP.weather).
  const weather = GUIDE.find((c) => c.id === 'weather');
  assert.match(weather.steps.find((s) => s.id === 'weather.rod').text, /6 cells/);
  assert.match(weather.steps.find((s) => s.id === 'weather.plants').text, /15 seconds/);
  assert.match(HELP.weather, /within 6 cells/);
  assert.match(HELP.weather, /15 s/);
  // Every step done fits the declared setting's limit (protocol accounts.js).
  assert.ok(JSON.stringify(Object.fromEntries(STEP_IDS.map((id) => [id, true]))).length < SETTINGS_GUIDE_DONE_MAX_BYTES);
});

test('guide text: {key:action} becomes the key bound now', () => {
  const settings = createSettings(createRegistry({ storage: memoryStorage() }));
  const hotkeys = new HotkeyRegistry(settings);
  hotkeys.registerAction('deploy', ['F'], () => {});
  assert.equal(guideText('Deploy ({key:deploy})', hotkeys), 'Deploy (F)');
  assert.equal(guideText('Scatter ({key:scatter})', hotkeys), 'Scatter (no key)');
  hotkeys.rebind('deploy', 'G');
  assert.equal(guideText('Deploy ({key:deploy})', hotkeys), 'Deploy (G)');
});

test('tracker: the local player\'s engine events tick steps off; other players\' do not', () => {
  const { tracker, progress, done } = setup();
  tracker.onEvents(events([EV.TRANSFORMED, T.MCV, 1], [EV.BUILDING_PLACED, T.POWR, 1]));
  assert.equal(progress.count(), 0, 'another player deployed and built');
  tracker.onEvents(events([EV.TRANSFORMED, T.MCV, 0, T.FACT], [EV.BUILDING_PLACED, T.POWR, 0]));
  assert.ok(progress.isDone('base.mcv') && progress.isDone('base.power'));
  assert.deepEqual(done, ['base.mcv', 'base.power']);
  // Barracks and a War Factory: both in one game.
  tracker.onEvents(events([EV.BUILDING_PLACED, T.TENT, 0]));
  assert.equal(progress.isDone('base.production'), false);
  tracker.onEvents(events([EV.BUILDING_PLACED, T.WEAP, 0]));
  assert.equal(progress.isDone('base.production'), true);
  // A second plant in the game: Build more power.
  assert.equal(progress.isDone('power.more'), false);
  tracker.onEvents(events([EV.BUILDING_PLACED, T.POWR, 0]));
  assert.equal(progress.isDone('power.more'), true);
  // Powered down (b 1), not powered up again (b 0).
  tracker.onEvents(events([EV.POWER_TOGGLED, T.POWR, 0, 0]));
  assert.equal(progress.isDone('power.down'), false);
  tracker.onEvents(events([EV.POWER_TOGGLED, T.POWR, 0, 1]));
  assert.equal(progress.isDone('power.down'), true);
  tracker.onEvents(events([EV.UNIT_PRODUCED, T.HARV, 0], [EV.BUILDING_PLACED, T.LROD, 0], [EV.POWER_READY, T.DOME, 0]));
  for (const id of ['ore.truck', 'weather.rod', 'powers.ready']) assert.ok(progress.isDone(id), id);
  // Lightning anywhere counts (the player was in the storm).
  tracker.onEvents(events([EV.LIGHTNING_STRIKE, T.E1, 3, 2]));
  assert.ok(progress.isDone('weather.storm'));
  // Nothing twice.
  const before = done.length;
  tracker.onEvents(events([EV.BUILDING_PLACED, T.POWR, 0]));
  assert.equal(done.length, before);
});

test('tracker: state (ore delivered, low power, a thunderstorm), orders and signals', () => {
  const { tracker, progress } = setup();
  tracker.onState({ resources: 0, lowPower: false });
  tracker.onState({ resources: 0, lowPower: false });
  assert.equal(progress.isDone('ore.deliver'), false);
  tracker.onState({ resources: 75, lowPower: false });
  assert.ok(progress.isDone('ore.deliver'), 'the stored ore went up');
  tracker.onState({ resources: 0, lowPower: true });
  assert.ok(progress.isDone('power.low'));
  tracker.onState({ resources: 0 }, { weather: 'rain' });
  assert.equal(progress.isDone('weather.storm'), false);
  tracker.onState({ resources: 0 }, { weather: 'thunderstorm' });
  assert.ok(progress.isDone('weather.storm'));
  // Orders through the UI's game.
  const calls = [];
  const game = { order_move: (...a) => calls.push(['move', a]), order_waypoint: (...a) => calls.push(['waypoint', a]), order_guard: () => 'g', set_stance: () => true, tick_count: () => 7, value: 3 };
  const ui = withGuide(game, (m, a) => tracker.onOrder(m, a));
  assert.equal(ui.tick_count(), 7, 'everything else passes through');
  assert.equal(ui.value, 3);
  ui.order_move(0, [1], 10, 10, false);
  assert.ok(progress.isDone('units.order'));
  assert.equal(progress.isDone('units.attackMove'), false);
  ui.order_move(0, [1], 10, 10, true);
  assert.ok(progress.isDone('units.attackMove'));
  ui.order_waypoint(0, [1], 10, 10, false);
  assert.ok(progress.isDone('units.queue'));
  assert.equal(ui.order_guard(0, [1], 2), 'g', 'the order runs and returns');
  assert.ok(progress.isDone('units.guard'));
  ui.set_stance(0, [1], 'holdfire');
  assert.ok(progress.isDone('units.stance'));
  assert.equal(calls.length, 3);
  tracker.signal('teamChat');
  tracker.signal('onlineGame');
  assert.ok(progress.isDone('team.chat') && progress.isDone('team.online'));
  // A tracker of a game that went marks nothing more.
  tracker.dispose();
  tracker.onEvents(events([EV.BUILDING_PLACED, T.SILO, 0]));
  assert.equal(progress.isDone('ore.silo'), false);
});

test('progress: kept in the declared guide.done setting; unknown ids are left alone; read steps', () => {
  const { registry, progress } = setup();
  registry.set('guide', 'done', { 'base.mcv': true, 'future.step': true });
  assert.equal(progress.count(), 1);
  assert.deepEqual(progress.mark(['base.mcv', 'nope', 'ore.gems']), ['ore.gems']);
  assert.deepEqual(registry.get('guide', 'done'), { 'base.mcv': true, 'future.step': true, 'ore.gems': true });
  assert.deepEqual(readSteps('power'), ['power.bar']);
  assert.deepEqual(progress.chapter('base'), { done: 1, total: 5 });
  assert.equal(progress.firstOpen('base'), 'base.power');
  assert.equal(stepStatus('base.power', { done: false, active: true }), 'Watching: Power Plant placed');
  assert.equal(stepStatus('base.power', { done: true, active: false }), 'Done: Power Plant placed');
});

test('tour: only in the player\'s own skirmish games, while the switch is on and a step is open; done turns it off; on again starts over', () => {
  const { registry, progress } = setup();
  assert.equal(registry.get('guide', 'tourInGames'), true, 'on by default');
  const skirmish = { kind: 'skirmish', watching: false };
  assert.equal(tourRuns(skirmish, progress), true);
  for (const kind of ['mission', 'online', 'replay', 'stress']) assert.equal(tourRuns({ kind }, progress), false, kind);
  assert.equal(tourRuns({ kind: 'skirmish', watching: true }, progress), false, 'not for a viewer');
  assert.equal(guideFollows({ kind: 'online' }), true);
  assert.equal(guideFollows({ kind: 'mission' }), true);
  assert.equal(guideFollows({ kind: 'replay' }), false);
  assert.equal(guideFollows({ kind: 'online', watching: true }), false, 'spectators');
  progress.mark(TOUR_STEPS);
  assert.equal(progress.tourComplete(), true);
  assert.equal(progress.tourInGames, false, 'finished: the switch goes off');
  assert.equal(tourRuns(skirmish, progress), false);
  // The rest of the guide keeps its ticks when the tour starts over.
  progress.mark(['ore.gems']);
  progress.setTourInGames(true);
  assert.equal(progress.count(TOUR_STEPS), 0);
  assert.ok(progress.isDone('ore.gems'));
  assert.equal(tourRuns(skirmish, progress), true);
  progress.setTourInGames(false);
  assert.equal(tourRuns(skirmish, progress), false, 'skipped');
});

test('tour card: the open step, its dots and lit cameo; Step done; Skip step; Skip the tour', () => {
  const { registry, progress, tracker } = setup();
  const settings = createSettings(registry);
  const hotkeys = new HotkeyRegistry(settings);
  hotkeys.registerAction('deploy', ['F'], () => {});
  const field = doc.createElement('div');
  const sidebar = doc.createElement('div');
  const cards = ['POWR', 'PROC', 'TENT'].map((id) => {
    const b = doc.createElement('button');
    b.className = 'sb-card';
    b.dataset.id = id;
    sidebar.append(b);
    return b;
  });
  doc.body.append(field, sidebar);
  const timers = [];
  let guideOpened = 0;
  const card = new TourCard(field, { progress, hotkeys, onGuide: () => guideOpened++, setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
  tracker.onDone = (ids) => card.stepsDone(ids);
  const root = field.querySelector('.tour');
  assert.equal(root.getAttribute('aria-label'), 'Tour');
  assert.ok(card.shown);
  assert.match(textOf(root), /Tour · Your first base · 1 of 5/);
  assert.match(textOf(root), /Deploy \(F\)/);
  assert.equal(root.querySelectorAll('.tour-dot').length, 5);
  assert.equal(root.querySelector('[aria-current="step"]').textContent, 'Step 1: now');
  // The game ticks off the first step: "Step done", the next step with its cameo lit.
  tracker.onEvents(events([EV.TRANSFORMED, T.MCV, 0, T.FACT]));
  assert.equal(root.querySelector('.tour-toast').getAttribute('role'), 'status');
  assert.match(root.querySelector('.tour-toast').textContent, /Step done: MCV deployed/);
  assert.match(textOf(root.querySelector('.tour-card')), /Build a Power Plant/);
  assert.ok(cards[0].classList.contains(TARGET_CLASS));
  assert.ok(!cards[1].classList.contains(TARGET_CLASS));
  assert.deepEqual(tourModel(progress).dots, ['done', 'active', 'open', 'open', 'open']);
  // Skip step: the next one, the cameo moves.
  click(root.querySelectorAll('button').find((b) => b.textContent === 'Skip step'));
  assert.ok(progress.isDone('base.power'));
  assert.ok(!cards[0].classList.contains(TARGET_CLASS) && cards[1].classList.contains(TARGET_CLASS));
  // Full guide opens the game menu's Guide page.
  click(root.querySelectorAll('button').find((b) => b.textContent.startsWith('Full guide')));
  assert.equal(guideOpened, 1);
  // The close button skips the whole tour; the Guide's switch turns it on again.
  click(root.querySelector('.tour-close'));
  assert.equal(progress.tourInGames, false);
  assert.equal(card.shown, false);
  assert.ok(!cards[1].classList.contains(TARGET_CLASS), 'no lit cameo left');
  assert.match(root.querySelector('.tour-toast').textContent, /Tour off/);
  timers.forEach((fn) => fn());
  assert.equal(root.querySelector('.tour-toast').textContent, '');
  card.dispose();
  assert.equal(field.querySelector('.tour'), null);
});

test('Guide page: chapters with lamps, the steps with Watching and Done, Skip this step, read steps, the tour switch', async () => {
  const registry = createRegistry({ storage: memoryStorage() });
  const settings = createSettings(registry);
  const hotkeys = new HotkeyRegistry(settings);
  const progress = new GuideProgress(registry);
  progress.mark(['base.mcv']);
  const root = doc.createElement('section');
  doc.body.append(root);
  const menu = new GameMenu(root, {
    online: false,
    hotkeys,
    settings,
    fullscreen: { available: () => false, active: () => false, toggle: async () => ({ ok: true }) },
    onChange() {},
    onLeave() {},
    onExit() {},
    guide: progress,
  });
  menu.open();
  const guideButton = root.querySelectorAll('button').find((b) => b.textContent.startsWith('Guide'));
  assert.match(guideButton.textContent, /1 of 28 steps done/);
  assert.ok(guideButton.classList.contains('gm-item-accent'));
  click(guideButton);
  assert.equal(root.querySelector('h1').textContent, 'Guide');
  assert.equal(root.querySelectorAll('.guide-chapter').length, GUIDE.length);
  // The first chapter with an open step opens; its lamp says some are done.
  assert.equal(root.querySelector('.guide-chapter[aria-current="step"]').id, 'guide-chapter-base');
  assert.ok(root.querySelector('#guide-chapter-base .ui-led-warn'));
  assert.match(textOf(root.querySelector('[data-step="base.mcv"]')), /Done: MCV deployed/);
  assert.match(textOf(root.querySelector('[data-step="base.power"]')), /Watching: Power Plant placed/);
  click(root.querySelector('[data-step="base.power"]').querySelectorAll('button').find((b) => b.textContent === 'Skip this step'));
  assert.ok(progress.isDone('base.power'));
  await Promise.resolve();
  assert.match(textOf(root.querySelector('[data-step="base.refinery"]')), /Watching/, 'drawn again: the next step is open');
  // Showing a chapter ticks off its steps that only explain.
  assert.equal(progress.isDone('power.bar'), false);
  click(root.querySelector('#guide-chapter-power'));
  assert.ok(progress.isDone('power.bar'));
  assert.match(textOf(root), /Chapter 3/);
  // The switch.
  const sw = root.querySelector('#guide-tour-in-games');
  assert.equal(sw.checked, true);
  check(sw, false);
  assert.equal(registry.get('guide', 'tourInGames'), false);
  click(root.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Back to the game menu'));
  assert.ok(root.querySelectorAll('button').find((b) => b.textContent === 'Resume'));
  menu.dispose();
});
