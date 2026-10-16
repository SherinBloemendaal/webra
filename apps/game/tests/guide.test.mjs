// The guide and the tour (js/guide.js, js/tour.js, js/guideview.js): the
// steps tick off from engine events, the player state, orders and signals;
// the progress is the declared guide.* setting; the tour runs only in the
// player's own skirmish games and stops when done or skipped; the Guide
// page shows chapters, ticks off read steps and has the tour switch. Fake
// DOM, no browser, no WebAssembly.
import { test, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, check, textOf, memoryStorage } from './dom-fixtures.mjs';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { GUIDE, HELP } from '../js/help.js';
import { EV, STRIDE } from '../js/audio/director.js';
import {
  CONTENT,
  GUIDE_BASELINE,
  GuideProgress,
  GuideTracker,
  STEP_IDS,
  TOUR_STEPS,
  TRIGGERS,
  guideContent,
  guideFollows,
  guideText,
  newerThan,
  readSteps,
  stepStatus,
  tourRuns,
  withGuide,
} from '../js/guide.js';
import { compareVersions, newestVersion } from '../js/releasenotes.js';
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

test('tour: only in the player\'s own skirmish games, while the switch is on and a step is open; done leaves the switch on; again starts over', () => {
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
  // The map editor's test play: no tour and no ticks.
  assert.equal(tourRuns({ kind: 'editor' }, progress), false);
  assert.equal(guideFollows({ kind: 'editor' }), false);
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /editorTestPlay = params\.get\('editorTest'\) === '1'/, 'the test play page is known');
  assert.match(main, /editorTestPlay \? 'editor' : 'skirmish'/, 'and its games are not skirmish games for the guide');
  progress.mark(TOUR_STEPS);
  assert.equal(progress.tourComplete(), true);
  // Finished is not skipped: the switch stays on (tour steps of a later version still show), the tour does not run.
  assert.equal(progress.tourInGames, true, 'finished: the switch stays on');
  assert.equal(tourRuns(skirmish, progress), false);
  // Take the tour again: the rest of the guide keeps its ticks.
  progress.mark(['ore.gems']);
  progress.restartTour();
  assert.equal(progress.count(TOUR_STEPS), 0);
  assert.ok(progress.isDone('ore.gems'));
  assert.equal(tourRuns(skirmish, progress), true);
  progress.setTourInGames(false);
  assert.equal(tourRuns(skirmish, progress), false, 'skipped');
  // On again after everything was done (played without the tour): it starts over.
  progress.mark(TOUR_STEPS);
  progress.setTourInGames(true);
  assert.equal(progress.count(TOUR_STEPS), 0);
  assert.equal(tourRuns(skirmish, progress), true);
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
  click([...root.querySelectorAll('button')].find((b) => b.textContent === 'Skip step'));
  assert.ok(progress.isDone('base.power'));
  assert.ok(!cards[0].classList.contains(TARGET_CLASS) && cards[1].classList.contains(TARGET_CLASS));
  // Full guide opens the game menu's Guide page.
  click([...root.querySelectorAll('button')].find((b) => b.textContent.startsWith('Full guide')));
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

/**
 * Timers that behave like a browser's: window.setTimeout and clearTimeout are
 * WebIDL operations that throw "Illegal invocation" when called on anything
 * but the window (or with no receiver), for example as a method of another
 * object. Node's own timers do not care, which is how the tour card shipped
 * calling them as `this.timers.set(...)`. Returns the pending callbacks and a
 * restore function.
 */
function browserTimers() {
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const pending = new Map();
  let next = 1;
  const guard = (self, name) => {
    if (self !== undefined && self !== null && self !== globalThis && self !== globalThis.window) {
      throw new TypeError(`Failed to execute '${name}' on 'Window': Illegal invocation`);
    }
  };
  globalThis.setTimeout = function setTimeout(fn) {
    guard(this, 'setTimeout');
    pending.set(next, fn);
    return next++;
  };
  globalThis.clearTimeout = function clearTimeout(id) {
    guard(this, 'clearTimeout');
    pending.delete(id);
  };
  return {
    pending,
    run() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    restore: () => Object.assign(globalThis, saved),
  };
}

test('tour card in the game: every tour step the game ticks off says Step done without throwing (browser timers)', () => {
  const timers = browserTimers();
  try {
    const { progress, tracker } = setup();
    const field = doc.createElement('div');
    doc.body.append(field);
    // As js/main.js builds it: no timers of its own, so the page's setTimeout.
    const card = new TourCard(field, { progress, onGuide: () => {} });
    tracker.onDone = (ids) => card.stepsDone(ids);
    const toast = () => field.querySelector('.tour-toast').textContent;
    // What the engine reports for each tour step (js/guide.js TRIGGERS), in a frame of its own.
    const frames = [
      ['base.mcv', [[EV.TRANSFORMED, T.MCV, 0, T.FACT]], /Step done: MCV deployed/],
      ['base.power', [[EV.BUILDING_PLACED, T.POWR, 0]], /Step done: Power Plant placed/],
      ['base.refinery', [[EV.BUILDING_PLACED, T.PROC, 0]], /Step done: Ore Refinery placed/],
      ['base.production', [[EV.BUILDING_PLACED, T.TENT, 0], [EV.BUILDING_PLACED, T.WEAP, 0]], /Step done: Barracks and War Factory/],
      ['base.radar', [[EV.BUILDING_PLACED, T.DOME, 0]], /Tour done/],
    ];
    for (const [id, list, said] of frames) {
      // A throw here stopped the 0.17.0 game loop (js/main.js frameBody); js/frameloop.js now keeps the loop going, but the step's toast must still work.
      assert.doesNotThrow(() => tracker.onEvents(events(...list)), id);
      assert.ok(progress.isDone(id), id);
      assert.match(toast(), said, id);
      assert.equal(timers.pending.size, 1, `${id}: one toast timer, the last one cleared`);
    }
    timers.run();
    assert.equal(toast(), '', 'the toast goes after TOAST_MS');
    // The buttons say things too: Skip the tour.
    progress.setTourInGames(true);
    assert.doesNotThrow(() => click(field.querySelector('.tour-close')));
    assert.match(toast(), /Tour off/);
    assert.doesNotThrow(() => card.dispose());
    assert.equal(timers.pending.size, 0, 'dispose clears the toast timer');
  } finally {
    timers.restore();
  }
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
  const guideButton = [...root.querySelectorAll('button')].find((b) => b.textContent.startsWith('Guide'));
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
  click([...root.querySelector('[data-step="base.power"]').querySelectorAll('button')].find((b) => b.textContent === 'Skip this step'));
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
  click([...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Back to the game menu'));
  assert.ok([...root.querySelectorAll('button')].find((b) => b.textContent === 'Resume'));
  menu.dispose();
});

test('tracker: a frame with many events reads the progress a fixed number of times', () => {
  const { registry, tracker } = setup();
  let reads = 0;
  const get = registry.get.bind(registry);
  registry.get = (...a) => {
    reads++;
    return get(...a);
  };
  const many = Array.from({ length: 500 }, () => [EV.FIRE, T.E1, 1]);
  tracker.onEvents(events(...many));
  assert.ok(reads <= 4, `${reads} reads for 500 events`);
});

// ---- Guide content of later versions (docs/contracts.md, "The guide and the tour") ----------

/**
 * The guide as a later release might grow it: a 0.18.0 step in the tour's
 * chapter, one in another chapter and a new chapter. Synthetic: the real
 * guide has no 0.18.0 content.
 */
const LATER = guideContent([
  {
    ...GUIDE[0],
    steps: [...GUIDE[0].steps, { id: 'base.silo', since: '0.18.0', title: 'Store the ore', text: 'Silos keep what the refinery cannot.', watch: 'Silo placed', tour: 'Build a Silo.' }],
  },
  { ...GUIDE[1], steps: [...GUIDE[1].steps, { id: 'ore.derrick', since: '0.18.0', title: 'Oil Derricks', text: 'Capture one with an engineer.', watch: 'Chapter read' }] },
  ...GUIDE.slice(2),
  { id: 'navy', since: '0.18.0', title: 'The navy', intro: 'Ships.', tip: 'Subs.', steps: [{ id: 'navy.yard', title: 'Build a Naval Yard', text: 'On the coast.', watch: 'Naval Yard placed' }] },
]);
const NEW_IDS = ['base.silo', 'ore.derrick', 'navy.yard'];
const BASELINE_DONE = Object.fromEntries([...TOUR_STEPS, 'ore.deliver', 'power.bar'].map((id) => [id, true]));

/** A game menu over `progress`, as the in-game menu builds it. */
function guideMenu(progress, registry) {
  const settings = createSettings(registry);
  const root = doc.createElement('section');
  doc.body.append(root);
  const menu = new GameMenu(root, {
    online: false,
    hotkeys: new HotkeyRegistry(settings),
    settings,
    fullscreen: { available: () => false, active: () => false, toggle: async () => ({ ok: true }) },
    onChange() {},
    onLeave() {},
    onExit() {},
    guide: progress,
  });
  const guideButton = () => [...root.querySelectorAll('button')].find((b) => b.textContent.startsWith('Guide'));
  return { menu, root, guideButton };
}

test('guide versions: since per chapter and step, compared as versions; the real guide is the 0.17.0 baseline', () => {
  assert.equal(newerThan('0.18.0', '0.17.0'), true);
  assert.equal(newerThan('0.17.0', '0.17.0'), false);
  assert.equal(newerThan('0.10.0', '0.9.0'), true, 'numbers, not text');
  assert.equal(newerThan('0.18.0-rc.1', '0.18.0'), false, 'a pre-release is older than its release');
  assert.equal(newerThan('0.17.0', null), true, 'nothing seen: everything is newer');
  assert.equal(newestVersion('0.9.0', '0.10.0'), '0.10.0');
  assert.equal(newestVersion(null, '0.18.0'), '0.18.0');
  assert.equal(newestVersion('v0.18.0', null), '0.18.0');
  assert.equal(newestVersion(null, null), null);
  // A step without its own since is its chapter's; the content's version is the newest since.
  assert.equal(LATER.version, '0.18.0');
  assert.equal(LATER.steps.get('base.mcv').since, '0.17.0');
  assert.equal(LATER.steps.get('base.silo').since, '0.18.0');
  assert.equal(LATER.steps.get('navy.yard').since, '0.18.0');
  assert.deepEqual(LATER.tourSteps, [...TOUR_STEPS, 'base.silo']);
  // The guide this game ships: every chapter says its version, no step is older than its chapter.
  for (const c of GUIDE) {
    assert.ok(compareVersions(c.since, '0.0.1') > 0 && /^\d+\.\d+\.\d+$/.test(c.since), `${c.id} since`);
    for (const st of c.steps) if (st.since) assert.ok(compareVersions(st.since, c.since) >= 0, `${st.id} is not older than its chapter`);
  }
  assert.equal(CONTENT.version, GUIDE_BASELINE, '0.17.0 content is the baseline');
});

test('guide updates: a 0.17.0 player whose tour is done gets the new steps as New; the switch stays as stored; turned on, the tour shows the new step only', () => {
  const registry = createRegistry({ storage: memoryStorage() });
  // As 0.17.0 left it: every tour step done and the switch off (finished or skipped: 0.17.0 cannot tell), no guide.seen.
  registry.patch('guide', { tourInGames: false, done: BASELINE_DONE });
  const progress = new GuideProgress(registry, LATER);
  progress.reconcile();
  assert.equal(registry.get('guide', 'seen'), GUIDE_BASELINE);
  assert.equal(progress.tourInGames, false, 'the switch stays as stored');
  assert.equal(tourRuns({ kind: 'skirmish' }, progress), false);
  assert.deepEqual(progress.newSteps(), NEW_IDS);
  // What was done stays done.
  for (const id of Object.keys(BASELINE_DONE)) assert.ok(progress.isDone(id), id);

  // The game menu: the Guide button carries "3 new" until the Guide is opened.
  const { menu, root, guideButton } = guideMenu(progress, registry);
  menu.open();
  assert.match(textOf(guideButton()), /3 new/);
  assert.ok(guideButton().querySelector('.ui-badge'));
  click(guideButton());
  // The Guide's switch is off (the tour is not finished: a new tour step is open), so no Take the tour again.
  assert.equal(root.querySelector('#guide-tour-in-games').checked, false);
  // The Guide opens at the first chapter with a new step; its steps and chapters say New for this visit.
  assert.equal(root.querySelector('.guide-chapter[aria-current="step"]').id, 'guide-chapter-base');
  assert.match(textOf(root.querySelector('[data-step="base.silo"]')), /New/);
  assert.doesNotMatch(textOf(root.querySelector('[data-step="base.mcv"]')), /New/);
  assert.match(textOf(root.querySelector('#guide-chapter-navy')), /New/);
  assert.match(textOf(root.querySelector('#guide-chapter-ore')), /New/);
  assert.doesNotMatch(textOf(root.querySelector('#guide-chapter-power')), /New/);
  assert.equal(registry.get('guide', 'seen'), '0.18.0', 'opening the Guide marks it seen');
  assert.deepEqual(progress.newSteps(), []);
  // Another chapter in the same visit still shows what was new.
  click(root.querySelector('#guide-chapter-ore'));
  assert.match(textOf(root.querySelector('[data-step="ore.derrick"]')), /New/);
  // The player turns the tour on: the next skirmish shows the new tour step only, the old ones done.
  check(root.querySelector('#guide-tour-in-games'), true);
  assert.equal(tourRuns({ kind: 'skirmish' }, progress), true);
  assert.equal(progress.tourStep(), 'base.silo');
  const model = tourModel(progress);
  assert.match(model.where, /6 of 6/);
  assert.deepEqual(model.dots, ['done', 'done', 'done', 'done', 'done', 'active']);
  // The next time the menu opens, nothing is new any more.
  menu.close();
  menu.open();
  assert.doesNotMatch(textOf(guideButton()), /new/);
  assert.equal(guideButton().querySelector('.ui-badge'), null);
  click(guideButton());
  assert.equal(root.querySelectorAll('.guide-step .ui-badge, .guide-chapter .ui-badge').length, 0);
  menu.dispose();
});

test('guide updates: a 0.17.0 player who skipped the tour gets the New badges, never the tour back, also with every tour step done', () => {
  // Skipped early, and skipped then played on: 0.17.0's tracker ticked every tour step anyway.
  for (const done of [{ 'base.mcv': true }, { ...BASELINE_DONE }]) {
    const registry = createRegistry({ storage: memoryStorage() });
    registry.patch('guide', { tourInGames: false, done });
    const progress = new GuideProgress(registry, LATER);
    progress.reconcile();
    assert.equal(registry.get('guide', 'seen'), GUIDE_BASELINE);
    assert.equal(progress.tourInGames, false, 'skipped stays skipped');
    assert.equal(tourRuns({ kind: 'skirmish' }, progress), false);
    assert.ok(progress.newSteps().includes('base.silo'));
    // The next start changes nothing.
    progress.reconcile();
    assert.equal(progress.tourInGames, false);
    const { menu, guideButton } = guideMenu(progress, registry);
    menu.open();
    assert.match(textOf(guideButton()), /\d new/);
    menu.dispose();
  }
});

test('guide updates: a player since 0.18.0 who finished the tour gets a later tour step; a new player sees no New badges', () => {
  // Finished in 0.18.0: the switch stayed on, so a 0.19.0 tour step runs without any reconcile.
  const registry = createRegistry({ storage: memoryStorage() });
  const progress = new GuideProgress(registry, LATER);
  progress.reconcile();
  progress.mark(LATER.tourSteps);
  assert.equal(progress.tourInGames, true);
  const later = guideContent([{ ...GUIDE[0], steps: [...LATER.chapters[0].steps, { id: 'base.repair', since: '0.19.0', title: 'Repair', text: 'Wrench.', watch: 'Repaired', tour: 'Repair it.' }] }]);
  const next = new GuideProgress(registry, later);
  next.reconcile();
  assert.equal(tourRuns({ kind: 'skirmish' }, next), true);
  assert.equal(next.tourStep(), 'base.repair');
  assert.deepEqual(next.newSteps(), ['base.repair']);

  // A brand-new player: everything is the guide as it is, nothing "New", the tour from its first step.
  const fresh = createRegistry({ storage: memoryStorage() });
  fresh.set('guide', 'lastTip', 0); // the loading screen of the first game ran first
  const p = new GuideProgress(fresh, LATER);
  p.reconcile();
  assert.equal(fresh.get('guide', 'seen'), '0.18.0');
  assert.deepEqual(p.newSteps(), []);
  assert.equal(tourRuns({ kind: 'skirmish' }, p), true);
  assert.equal(p.tourStep(), 'base.mcv');
  const { menu, root, guideButton } = guideMenu(p, fresh);
  menu.open();
  assert.equal(guideButton().querySelector('.ui-badge'), null);
  assert.match(textOf(guideButton()), /New: how to play/);
  click(guideButton());
  assert.equal(root.querySelectorAll('.guide-step .ui-badge, .guide-chapter .ui-badge').length, 0);
  menu.dispose();
});
