// The guide and the tour (js/guide.js, js/tour.js, js/guideview.js): the
// steps tick off in order from what the game remembers of engine events,
// the player state, orders and signals; the progress is the declared guide.*
// setting; the tour runs only in the player's own skirmish games, goes
// through every chapter with an "Also" step and a low power line, and ends
// with the quick tips question; the Guide page shows chapters, ticks off read
// steps in order and has the tour switch. Fake DOM, no browser, no
// WebAssembly.
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
  CARRIED,
  CONTENT,
  GUIDE_BASELINE,
  TOUR_ORDER,
  GuideProgress,
  GuideTracker,
  STEP_IDS,
  TOUR_STEPS,
  TRIGGERS,
  guideContent,
  guideFollows,
  gameSteps,
  guideText,
  newerThan,
  readSteps,
  stepStatus,
  tourRuns,
  withGuide,
} from '../js/guide.js';
import { compareVersions, newestVersion } from '../js/releasenotes.js';
import { ALSO_CLASS, LOW_POWER_WARNING, TourCard, TARGET_CLASS, TOUR_TARGETS, tourModel } from '../js/tour.js';
import { GameMenu } from '../js/gamemenu.js';
import { SETTINGS_GUIDE_DONE_MAX_BYTES, validateSettingsDocument } from '../protocol/accounts.js';
import { GUIDE_OUTLINE, applyGuideAction, guideSummary } from '../protocol/guide.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());


const RULES = JSON.parse(readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8'));
const RULE_ACTOR = new Map(RULES.actors.map((a) => [a.id, a]));
/** rules_json's queue numbers (engine/src/rules.rs QueueType). */
const QUEUE = { Building: 0, Defense: 1, Infantry: 2, Vehicle: 3, Aircraft: 4, Ship: 5 };

/** The actors as rules_json gives them to the client: id, queue number and power, from engine/rules.json. */
const ACTORS = ['MCV', 'FACT', 'POWR', 'APWR', 'PROC', 'TENT', 'BARR', 'WEAP', 'DOME', 'SILO', 'HARV', 'LROD', 'E1', 'E2', '1TNK', 'APC'].map((id) => {
  const a = RULE_ACTOR.get(id);
  return { id, queue: QUEUE[a.queue], power: a.building?.power ?? 0 };
});
const T = Object.fromEntries(ACTORS.map((a, i) => [a.id, i]));
const ALL_BUILDABLE = ACTORS.map(({ id }) => ({ id }));

/** Engine events as the sim gives them: [kind, a, x, y, owner, b] each. */
function events(...list) {
  const out = new Int32Array(list.length * STRIDE);
  list.forEach(([kind, a = 0, owner = 0, b = 0], i) => out.set([kind, a, 0, 0, owner, b], i * STRIDE));
  return out;
}

const placed = (...ids) => events(...ids.map((id) => [EV.BUILDING_PLACED, T[id], 0]));
const produced = (...ids) => events(...ids.map((id) => [EV.UNIT_PRODUCED, T[id], 0]));
const DEPLOYED = events([EV.TRANSFORMED, T.MCV, 0, T.FACT]);

/** A player state as Game.player_json has it (the fields the guide reads). */
function playerState({ gen = 0, used = 0, yard = false, resources = 0, buildable = ALL_BUILDABLE } = {}) {
  return { powerGenerated: gen, powerUsed: used, lowPower: used > gen, hasProducer: [yard, false, false, false, false, false], resources, buildable };
}

function setup({ tour = false, content } = {}) {
  const registry = createRegistry({ storage: memoryStorage() });
  const progress = new GuideProgress(registry, content);
  const done = [];
  const calls = [];
  const tracker = new GuideTracker({
    progress,
    actors: ACTORS,
    player: 0,
    tour,
    onDone: (ids) => {
      calls.push([...ids]);
      done.push(...ids);
    },
  });
  return { registry, progress, tracker, done, calls };
}

/** A tour card over a fake sidebar with `cameos`, ticking from `tracker` (as js/main.js builds it). */
function tourCard(progress, tracker, { cameos = [], hotkeys, onGuide = () => {} } = {}) {
  const field = doc.createElement('div');
  const sidebar = doc.createElement('div');
  const cards = Object.fromEntries(
    cameos.map((id) => {
      const b = doc.createElement('button');
      b.className = 'sb-card';
      b.dataset.id = id;
      sidebar.append(b);
      return [id, b];
    }),
  );
  doc.body.append(field, sidebar);
  const timers = [];
  const card = new TourCard(field, { progress, hotkeys, ctx: () => tracker.ctx(), onGuide, setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
  tracker.onDone = (ids) => card.stepsDone(ids);
  const root = field.querySelector('.tour');
  const toast = () => root.querySelector('.tour-toast').textContent;
  const buttonOf = (text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text || b.textContent.startsWith(text));
  return { card, root, cards, toast, timers, buttonOf };
}

/** The steps of chapter `id`, in order. */
const chapterIds = (id) => GUIDE.find((c) => c.id === id).steps.map((s) => s.id);

test('guide texts: every step has an id, a title, a text, what ticks it off and a trigger; order, parallel, passive, outside and builds follow the design; no dashes', () => {
  const ids = GUIDE.flatMap((c) => c.steps.map((s) => s.id));
  assert.equal(new Set(ids).size, ids.length, 'unique step ids');
  assert.deepEqual(ids, STEP_IDS);
  assert.deepEqual(GUIDE.map((c) => c.id), [...TOUR_ORDER], 'the guide is in tour order');
  assert.equal(ids.length, 32);
  assert.ok(!ids.includes('base.production'), 'base.production is retired (ids are never reused)');
  for (const c of GUIDE) {
    assert.ok(c.title && c.intro && c.tip, c.id);
    c.steps.forEach((s, i) => {
      assert.ok(s.title && s.text && s.watch, s.id);
      assert.ok(TRIGGERS[s.id], `${s.id} has a trigger`);
      assert.ok(TRIGGERS[s.id].read === true || typeof TRIGGERS[s.id].test === 'function', `${s.id}: a test or read`);
      for (const t of [s.title, s.text, s.watch, s.tour ?? '']) assert.doesNotMatch(t, /[\u2013\u2014]/, s.id);
      const earlier = c.steps.slice(0, i).map((x) => x.id);
      for (const a of s.after ?? []) assert.ok(earlier.includes(a), `${s.id}: after ${a} is earlier in its chapter`);
      if (s.parallel) assert.ok(s.after?.length, `${s.id}: parallel names its after`);
      for (const a of [...(s.builds ?? []), ...(s.needs ?? [])]) assert.ok(RULE_ACTOR.has(a), `${s.id}: ${a} is an actor of rules.json`);
      for (const a of TOUR_TARGETS[s.id] ?? []) assert.ok(RULE_ACTOR.has(a), `${s.id}: cameo ${a}`);
    });
  }
  // The flow of the first chapter, and its "Also" steps.
  assert.deepEqual(chapterIds('base'), ['base.mcv', 'base.power', 'base.refinery', 'base.barracks', 'army.infantry', 'base.factory', 'army.vehicle', 'base.morePower', 'base.radar']);
  assert.deepEqual(ids.filter((id) => CONTENT.steps.get(id).step.parallel), ['army.infantry', 'army.vehicle']);
  assert.deepEqual(CONTENT.steps.get('army.infantry').after, ['base.barracks']);
  assert.deepEqual(CONTENT.steps.get('base.factory').after, ['base.barracks'], 'the main line does not wait for a parallel step');
  assert.deepEqual(CONTENT.steps.get('base.morePower').after, ['base.factory']);
  assert.deepEqual(ids.filter((id) => CONTENT.steps.get(id).step.outside), ['team.chat', 'team.online']);
  assert.deepEqual(ids.filter((id) => CONTENT.steps.get(id).step.passive), ['ore.deliver', 'power.low', 'weather.storm', 'powers.ready']);
  // Every step the tour counts has a tour text or explains (Got it shows its text).
  assert.equal(TOUR_STEPS.length, 26);
  for (const id of TOUR_STEPS) assert.ok(CONTENT.steps.get(id).step.tour || TRIGGERS[id].read, `${id} has the tour's text`);
  // Facts that follow the rules (the README, HELP.weather and engine/rules.json).
  const weather = GUIDE.find((c) => c.id === 'weather');
  assert.match(weather.steps.find((s) => s.id === 'weather.rod').text, /6 cells/);
  assert.match(weather.steps.find((s) => s.id === 'weather.plants').text, /15 seconds/);
  assert.match(HELP.weather, /within 6 cells/);
  assert.match(HELP.weather, /15 s/);
  const dome = -RULE_ACTOR.get('DOME').building.power;
  const more = CONTENT.steps.get('base.morePower').step;
  assert.equal(dome, 40);
  for (const t of [more.text, more.tour, more.watch]) assert.ok(t.includes(String(dome)), `${t}: the dome's ${dome}`);
  assert.match(CONTENT.steps.get('power.down').step.tour, new RegExp(`${dome} power`));
  const powr = RULE_ACTOR.get('POWR').building.power;
  assert.match(CONTENT.steps.get('base.power').step.tour, new RegExp(`${powr} power`));
  // One plant, a refinery, barracks and a war factory leave the 20 the text says.
  const spare = powr + ['PROC', 'TENT', 'WEAP'].reduce((n, id) => n + RULE_ACTOR.get(id).building.power, 0);
  assert.match(more.text, new RegExp(`you have ${spare} to spare`));
  assert.equal(RULES.player.low_power_modifier, 300);
  assert.match(LOW_POWER_WARNING, /three times slower/);
  // Every step done fits the declared setting's limit (protocol accounts.js), with the retired id.
  assert.ok(JSON.stringify(Object.fromEntries([...STEP_IDS, 'base.production'].map((id) => [id, true]))).length < SETTINGS_GUIDE_DONE_MAX_BYTES);
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

test('tracker: the local player\'s engine events tick steps off, in order; other players\' do not', () => {
  const { tracker, progress, done } = setup();
  tracker.onEvents(events([EV.TRANSFORMED, T.MCV, 1], [EV.BUILDING_PLACED, T.POWR, 1]));
  assert.equal(progress.count(), 0, 'another player deployed and built');
  tracker.onEvents(events([EV.TRANSFORMED, T.MCV, 0, T.FACT], [EV.BUILDING_PLACED, T.POWR, 0]));
  assert.deepEqual(done, ['base.mcv', 'base.power']);
  tracker.onEvents(placed('PROC', 'TENT'));
  assert.ok(progress.isDone('base.refinery') && progress.isDone('base.barracks'));
  tracker.onEvents(produced('E1'));
  assert.ok(progress.isDone('army.infantry'));
  tracker.onEvents(placed('WEAP'));
  assert.ok(progress.isDone('base.factory'));
  tracker.onEvents(produced('1TNK'));
  assert.ok(progress.isDone('army.vehicle'));
  // A second plant in the game: room for a radar dome once the state says so, and Build more power once Power is read.
  tracker.onEvents(placed('POWR'));
  assert.equal(progress.isDone('power.more'), false, 'its turn comes after Watch the power bar');
  progress.mark(['power.bar']);
  tracker.onEvents(events([EV.POWER_TOGGLED, T.POWR, 0, 0]));
  assert.ok(progress.isDone('power.more'), 'remembered, ticks when it is its turn');
  // Powered down (b 1), not powered up again (b 0).
  assert.equal(progress.isDone('power.down'), false);
  tracker.onEvents(events([EV.POWER_TOGGLED, T.POWR, 0, 1]));
  assert.equal(progress.isDone('power.down'), true);
  progress.mark(['weather.plants', 'powers.timers']);
  tracker.onEvents(events([EV.UNIT_PRODUCED, T.HARV, 0], [EV.BUILDING_PLACED, T.LROD, 0], [EV.POWER_READY, T.DOME, 0]));
  for (const id of ['ore.truck', 'weather.rod', 'powers.ready']) assert.ok(progress.isDone(id), id);
  // Lightning anywhere counts (the player was in the storm).
  tracker.onEvents(events([EV.LIGHTNING_STRIKE, T.E1, 3, 2]));
  assert.ok(progress.isDone('weather.storm'));
  // Nothing twice.
  const before = done.length;
  tracker.onEvents(placed('POWR'));
  assert.equal(done.length, before);
});

test('tracker: state (a yard, ore delivered, low power, a thunderstorm), orders and signals', () => {
  const { tracker, progress } = setup();
  tracker.onState({ resources: 0, lowPower: false });
  tracker.onState({ resources: 0, lowPower: false });
  assert.equal(progress.isDone('ore.deliver'), false);
  tracker.onState({ resources: 75, lowPower: false });
  assert.ok(progress.isDone('ore.deliver'), 'the stored ore went up');
  progress.mark(['power.bar']);
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
  assert.equal(ui.order_guard(0, [1], 2), 'g', 'the order runs and returns');
  assert.ok(progress.isDone('units.guard'));
  ui.order_waypoint(0, [1], 10, 10, false);
  assert.ok(progress.isDone('units.queue'));
  ui.set_stance(0, [1], 'holdfire');
  assert.ok(progress.isDone('units.stance'));
  assert.equal(calls.length, 3);
  tracker.signal('teamChat');
  tracker.signal('onlineGame');
  assert.ok(progress.isDone('team.chat') && progress.isDone('team.online'));
  // A tracker of a game that went marks nothing more.
  tracker.dispose();
  progress.mark(['ore.truck', 'ore.gems']);
  tracker.onEvents(placed('SILO'));
  assert.equal(progress.isDone('ore.silo'), false);
});

test('progress: kept in the declared guide.done setting; unknown ids are left alone; read steps', () => {
  const { registry, progress } = setup();
  registry.set('guide', 'done', { 'base.mcv': true, 'future.step': true });
  assert.equal(progress.count(), 1);
  assert.deepEqual(progress.mark(['base.mcv', 'nope', 'ore.gems']), ['ore.gems']);
  assert.deepEqual(registry.get('guide', 'done'), { 'base.mcv': true, 'future.step': true, 'ore.gems': true });
  assert.deepEqual(readSteps('power'), ['power.bar']);
  assert.deepEqual(progress.chapter('base'), { done: 1, total: 9 });
  assert.equal(progress.firstOpen('base'), 'base.power');
  assert.equal(stepStatus('base.power', { done: false, active: true }), 'Watching: Power Plant placed');
  assert.equal(stepStatus('base.power', { done: true, active: false }), 'Done: Power Plant placed');
});

// ---- Order and memory (design 1.1) -------------------------------------------------------

test('order: a Power Plant placed before the MCV deploys ticks nothing; the deploy ticks both, in order, in one call', () => {
  const { tracker, progress, calls } = setup({ tour: true });
  tracker.onEvents(placed('POWR'));
  assert.equal(progress.count(), 0, 'Build a Power Plant waits for Deploy the MCV');
  tracker.onEvents(DEPLOYED);
  assert.deepEqual(calls, [['base.mcv', 'base.power']], 'the cascade: one onDone, in order');
});

test('order: a "Construction Yard" start ticks Deploy the MCV from the state, without any event', () => {
  const { tracker, progress } = setup({ tour: true });
  tracker.onState(playerState());
  assert.equal(progress.isDone('base.mcv'), false);
  tracker.onState(playerState({ yard: true }));
  assert.ok(progress.isDone('base.mcv'));
});

test('order: a second Power Plant in the base chapter waits for the Power chapter (tour) or for Watch the power bar (no tour)', () => {
  // With the tour: only its chapter ticks; the Power chapter's step is remembered.
  {
    const { tracker, progress, calls } = setup({ tour: true });
    tracker.onEvents(DEPLOYED);
    tracker.onEvents(placed('POWR', 'POWR', 'APWR'));
    progress.mark(['power.bar']);
    tracker.onEvents(placed('PROC'));
    assert.equal(progress.isDone('power.more'), false, 'the tour is in Your first base');
    // The tour reaches the Power chapter: what was done ticks as already done.
    progress.mark(TOUR_STEPS.filter((id) => id.startsWith('base.') || id.startsWith('army.') || id.startsWith('units.') || id.startsWith('ore.')));
    assert.equal(progress.tourChapter().id, 'power');
    tracker.onState(playerState({ gen: 400, used: 30, yard: true }));
    assert.ok(progress.isDone('power.more'));
    assert.ok(calls.at(-1).includes('power.more'));
  }
  // Without the tour every chapter ticks in its own order.
  {
    const { tracker, progress } = setup({ tour: false });
    tracker.onEvents(placed('POWR', 'POWR'));
    assert.equal(progress.isDone('power.more'), false, 'not before Watch the power bar');
    progress.mark(['power.bar']);
    tracker.onEvents(placed('SILO'));
    assert.ok(progress.isDone('power.more'), 'power.low is passive: it does not hold power.more up');
    assert.equal(progress.isDone('power.low'), false);
  }
});

test('order: orders tick their steps in order; a fire stance given first ticks last, by cascade', () => {
  const { tracker, progress, calls } = setup();
  tracker.onOrder('set_stance', [0, [1], 'holdfire']);
  assert.equal(progress.count(), 0);
  tracker.onOrder('order_move', [0, [1], 1, 1, false]);
  tracker.onOrder('order_move', [0, [1], 1, 1, true]);
  tracker.onOrder('order_guard', [0, [1], 2]);
  assert.deepEqual(calls, [['units.order'], ['units.attackMove'], ['units.guard']]);
  tracker.onOrder('order_waypoint', [0, [1], 1, 1, false]);
  assert.deepEqual(calls.at(-1), ['units.queue', 'units.stance']);
});

test('order: stored progress with gaps is not unticked; the tour starts at the first open step and passes the done ones', () => {
  const { tracker, progress, registry } = setup({ tour: true });
  registry.set('guide', 'done', { 'base.power': true, 'base.radar': true });
  assert.equal(progress.tourStep(), 'base.mcv');
  tracker.onEvents(DEPLOYED);
  assert.ok(progress.isDone('base.power') && progress.isDone('base.radar'), 'nothing unticked');
  assert.equal(progress.tourStep(), 'base.refinery', 'the plant was done before: passed');
  assert.deepEqual(tourModel(progress).dots, ['done', 'done', 'active', 'open', 'open', 'open', 'open', 'open', 'done']);
});

test('order: the Guide page ticks a read step only when the steps before it are done', () => {
  const { progress } = setup();
  assert.deepEqual(progress.markRead('ore'), [], 'ore.gems waits for ore.truck');
  progress.mark(['ore.truck']);
  assert.deepEqual(progress.markRead('ore'), ['ore.gems'], 'ore.deliver is passive: it does not hold the chapter up');
  // A read step after an undone step that is not read stays open; read steps before it tick.
  assert.deepEqual(progress.markRead('weather'), ['weather.plants'], 'weather.other waits for the Lightning Rod');
  assert.equal(progress.isDone('weather.other'), false);
  progress.mark(['weather.rod']);
  assert.deepEqual(progress.markRead('weather'), ['weather.other']);
  // Two in a row tick together; the team chapter's online steps do not hold Losing the connection up.
  assert.deepEqual(progress.markRead('powers'), ['powers.timers', 'powers.spread']);
  assert.deepEqual(progress.markRead('team'), ['team.rejoin']);
});

// ---- Parallel steps (design 1.2) ---------------------------------------------------------

test('also: after the Barracks the War Factory with Train infantry beside it; after the factory the power check with Build a vehicle', () => {
  const { tracker, progress } = setup({ tour: true });
  const { root, cards } = tourCard(progress, tracker, { cameos: ['WEAP', 'E1', 'E2', '1TNK', 'POWR', 'DOME'] });
  tracker.onEvents(DEPLOYED);
  tracker.onEvents(placed('POWR', 'PROC', 'TENT'));
  let m = tourModel(progress);
  assert.equal(m.id, 'base.factory');
  assert.equal(m.also.id, 'army.infantry');
  assert.deepEqual([...m.targets, ...m.also.targets], ['WEAP', 'E1', 'E2']);
  assert.ok(cards.WEAP.classList.contains(TARGET_CLASS) && !cards.WEAP.classList.contains(ALSO_CLASS));
  assert.ok(cards.E1.classList.contains(TARGET_CLASS) && cards.E1.classList.contains(ALSO_CLASS), 'the also step lit, dimmer');
  const also = root.querySelector('.tour-also');
  assert.equal(also.hidden, false);
  assert.match(also.textContent, /^Also: open the Infantry tab/);
  assert.deepEqual(m.dots, ['done', 'done', 'done', 'done', 'also', 'active', 'open', 'open', 'open']);
  // Infantry out: the also line goes.
  tracker.onEvents(produced('E1'));
  assert.ok(progress.isDone('army.infantry'));
  assert.equal(tourModel(progress).also, null);
  assert.equal(also.hidden, true);
  assert.ok(!cards.E1.classList.contains(TARGET_CLASS));
  // The free refinery truck is never reported as produced (engine tests_sound.rs); a bought one is no army.
  tracker.onEvents(placed('WEAP'));
  tracker.onEvents(produced('HARV'));
  assert.equal(progress.isDone('army.vehicle'), false, 'an Ore Truck is not a vehicle for the army');
  // Factory placed, no vehicle: the power check is the main step, Build a vehicle the also.
  tracker.onState(playerState({ gen: 100, used: 80, yard: true }));
  m = tourModel(progress, tracker.ctx());
  assert.equal(m.id, 'base.morePower');
  assert.equal(m.also.id, 'army.vehicle');
  tracker.onEvents(produced('1TNK'));
  assert.ok(progress.isDone('army.vehicle'));
  // With the main line done the parallel step is the main step.
  const p2 = setup({ tour: true });
  p2.progress.mark(['base.mcv', 'base.power', 'base.refinery', 'base.barracks', 'base.factory', 'base.morePower', 'base.radar']);
  assert.equal(p2.progress.tourStep(), 'army.infantry');
  assert.equal(p2.progress.tourAlso(), 'army.vehicle');
});

// ---- Power (design 1.4) --------------------------------------------------------------------

test('power: Check your power before the radar ticks when a Radar Dome fits, or a dome was placed; never before the War Factory', () => {
  {
    const { tracker, progress } = setup({ tour: true });
    tracker.onEvents(DEPLOYED);
    tracker.onEvents(placed('POWR'));
    tracker.onState(playerState({ gen: 100, used: 0, yard: true }));
    assert.equal(progress.isDone('base.morePower'), false, 'a margin of 100, but not its turn');
    tracker.onEvents(placed('PROC', 'TENT', 'WEAP'));
    tracker.onState(playerState({ gen: 100, used: 80, yard: true }));
    assert.equal(progress.isDone('base.morePower'), false, '20 to spare, the dome needs 40');
    const { cards, root } = tourCard(progress, tracker, { cameos: ['POWR', 'DOME'] });
    assert.equal(tourModel(progress, tracker.ctx()).id, 'base.morePower');
    assert.match(textOf(root.querySelector('.tour-title')), /Check your power before the radar/);
    assert.ok(cards.POWR.classList.contains(TARGET_CLASS));
    tracker.onState(playerState({ gen: 200, used: 80, yard: true }));
    assert.ok(progress.isDone('base.morePower'));
    assert.equal(tourModel(progress, tracker.ctx()).id, 'base.radar');
  }
  {
    const { tracker, progress } = setup({ tour: true });
    tracker.onEvents(DEPLOYED);
    tracker.onEvents(placed('POWR', 'PROC', 'TENT', 'WEAP'));
    tracker.onState(playerState({ gen: 100, used: 80, yard: true }));
    tracker.onEvents(placed('DOME'));
    assert.ok(progress.isDone('base.morePower') && progress.isDone('base.radar'), 'the dome placed anyway');
  }
});

test('power: the low power line shows on the card with the Power Plant lit, and goes when the power is back', () => {
  const { tracker, progress } = setup({ tour: true });
  const { card, root, cards } = tourCard(progress, tracker, { cameos: ['POWR', 'PROC'] });
  tracker.onEvents(DEPLOYED);
  tracker.onEvents(placed('POWR'));
  const warn = root.querySelector('.tour-warn');
  assert.equal(warn.hidden, true);
  card.refresh({ ...playerState({ gen: 100, used: 120, yard: true }) });
  assert.equal(warn.hidden, false);
  assert.equal(warn.textContent, LOW_POWER_WARNING);
  assert.ok(cards.PROC.classList.contains(TARGET_CLASS), "the step's cameo");
  assert.ok(cards.POWR.classList.contains(TARGET_CLASS), 'and the Power Plant');
  // Said once in the live region when the power drops, not on every refresh while it stays low.
  const toast = root.querySelector('.tour-toast');
  assert.equal(toast.textContent, LOW_POWER_WARNING);
  toast.textContent = '';
  card.refresh({ ...playerState({ gen: 100, used: 130, yard: true }) });
  assert.equal(toast.textContent, '', 'still low: no repeat');
  card.refresh({ ...playerState({ gen: 200, used: 120, yard: true }) });
  assert.equal(warn.hidden, true);
  assert.ok(!cards.POWR.classList.contains(TARGET_CLASS));
  assert.equal(toast.textContent, '');
  // Low again: said again.
  card.refresh({ ...playerState({ gen: 100, used: 120, yard: true }) });
  assert.equal(toast.textContent, LOW_POWER_WARNING);
});

// ---- The tour through every chapter (design 1.3) -------------------------------------------

test('tour: goes on through every chapter by itself, says Chapter done, ends with Tour done and the quick tips question', () => {
  const { tracker, progress, registry } = setup({ tour: true });
  const { root, toast, buttonOf } = tourCard(progress, tracker);
  const where = () => root.querySelector('.tour-where').textContent;
  assert.equal(where(), 'Tour · Your first base · 1 of 9');
  // A plant placed before the yard was there (a quick player): it ticks with the deploy, already done.
  tracker.onEvents(placed('POWR'));
  tracker.onEvents(DEPLOYED);
  assert.equal(toast(), 'Step done: MCV deployed. Power Plant placed (already done).');
  tracker.onEvents(placed('PROC', 'TENT'));
  tracker.onEvents(produced('E1'));
  // A second plant while the factory is on its way: room for a dome once the factory's power is counted.
  tracker.onEvents(placed('POWR', 'WEAP'));
  assert.equal(progress.isDone('base.morePower'), false, 'an event never tests the power: its state is not in yet');
  tracker.onState(playerState({ gen: 200, used: 80, yard: true }));
  assert.match(toast(), /^Step done: Room for a Radar Dome/);
  tracker.onEvents(produced('1TNK'));
  tracker.onEvents(placed('DOME'));
  assert.match(toast(), /Chapter done: Your first base/);
  assert.equal(where(), 'Tour · Commanding units · 1 of 5');
  for (const [m, a] of [['order_move', [0, [1], 1, 1, false]], ['order_move', [0, [1], 1, 1, true]], ['order_guard', [0, [1], 2]], ['order_waypoint', [0, [1], 1, 1, false]], ['set_stance', [0, [1], 'defend']]]) tracker.onOrder(m, a);
  assert.match(toast(), /Chapter done: Commanding units/);
  assert.equal(where(), 'Tour · Money and ore · 1 of 3', 'Keep the trucks busy is passive: not counted');
  tracker.onEvents(produced('HARV'));
  assert.equal(root.querySelector('.tour-title').textContent, 'Gems are worth more');
  assert.equal(buttonOf('Got it').hidden, false, 'a step that explains: Got it');
  click(buttonOf('Got it'));
  tracker.onEvents(placed('SILO'));
  assert.equal(where(), 'Tour · Power · 1 of 3');
  click(buttonOf('Got it'));
  // The second plant was placed in the base chapter: it ticks on the next state.
  tracker.onState(playerState({ gen: 200, used: 120, yard: true }));
  assert.equal(root.querySelector('.tour-title').textContent, 'Power down to save');
  tracker.onEvents(events([EV.POWER_TOGGLED, T.DOME, 0, 1]));
  assert.equal(where(), 'Tour · Weather and lightning · 1 of 3');
  click(buttonOf('Got it'));
  tracker.onEvents(placed('LROD'));
  click(buttonOf('Got it'));
  assert.equal(where(), 'Tour · Superweapons · 1 of 2');
  click(buttonOf('Got it'));
  click(buttonOf('Got it'));
  assert.equal(where(), 'Tour · Teams and online · 1 of 1', 'team chat and online games are not in a skirmish tour');
  assert.equal(progress.tourComplete(), false);
  click(buttonOf('Got it'));
  assert.equal(progress.tourComplete(), true);
  // Open passive and outside steps: ore.deliver, power.low, weather.storm, powers.ready, team.chat, team.online.
  assert.match(toast(), /^Tour done\. Keep the quick tips\? Two buttons on the tour card\. The Guide \(Esc\) keeps the rest: 6 steps tick off by themselves when they happen\.$/);
  assert.equal(where(), 'Tour · Done');
  assert.equal(root.querySelector('.tour-finale').hidden, false);
  assert.equal(registry.get('guide', 'quickTipsAsked'), false);
});

test('tour: steps this game cannot build are passed; nothing left in this game shows a note; the next game with them goes on', () => {
  const { tracker, progress, registry } = setup({ tour: true });
  const { root, card, buttonOf } = tourCard(progress, tracker);
  // A Low tech level: the engine lists every item of the game mode, the locked ones with `exclusive` (lib.rs).
  const lowTech = ALL_BUILDABLE.map((b) => (b.id === 'DOME' ? { id: 'DOME', exclusive: 'Tech level Medium' } : b.id === 'WEAP' ? { id: 'WEAP', exclusive: 'Tech level Low' } : b));
  tracker.onState(playerState({ yard: true, buildable: lowTech }));
  tracker.onEvents(placed('POWR', 'PROC', 'TENT'));
  tracker.onEvents(produced('E1'));
  const ctx = tracker.ctx();
  for (const id of ['base.factory', 'army.vehicle', 'base.morePower', 'base.radar']) assert.equal(ctx.available(id), false, id);
  assert.equal(gameSteps(undefined).available('base.radar'), true, 'before the first state every step is in the game');
  // A side's items: Soviets have Barracks (BARR), the Allied TENT is the other side's; the step stays.
  const soviet = gameSteps(ALL_BUILDABLE.map((b) => (b.id === 'TENT' || b.id === 'E1' ? { ...b, exclusive: 'Allies' } : b)));
  assert.equal(soviet.available('base.barracks'), true, 'BARR is there');
  assert.equal(soviet.available('army.infantry'), true);
  const neither = gameSteps(ALL_BUILDABLE.map((b) => (b.id === 'TENT' || b.id === 'BARR' ? { ...b, exclusive: 'Allies' } : b)));
  assert.equal(neither.available('base.barracks'), false);
  // The base chapter has nothing more here: the tour goes on with Commanding units.
  assert.equal(progress.tourChapter(ctx).id, 'units');
  card.refresh(playerState({ yard: true, buildable: lowTech }));
  assert.match(root.querySelector('.tour-where').textContent, /Commanding units/);
  // Everything else done: the note, no step to skip; the tour is not done.
  progress.mark(TOUR_STEPS.filter((id) => !id.startsWith('base.') && !id.startsWith('army.')));
  card.refresh(playerState({ yard: true, buildable: lowTech }));
  const m = tourModel(progress, ctx);
  assert.equal(m.id, null);
  assert.match(m.note, /^Nothing more in this game: "Build a War Factory" needs a higher tech level or another game mode\. The tour goes on in your next skirmish\.$/);
  assert.match(textOf(root.querySelector('.tour-text')), /Nothing more in this game/);
  assert.equal(buttonOf('Skip step').hidden, true);
  assert.equal(progress.tourComplete(), false);
  assert.equal(tourRuns({ kind: 'skirmish' }, progress), true);
  // Closing the note closes the card for this game only.
  click(root.querySelector('.tour-close'));
  assert.equal(card.shown, false);
  assert.equal(registry.get('guide', 'tourInGames'), true);
  // The next game can build them: the tour resumes at the War Factory.
  const next = new GuideTracker({ progress, actors: ACTORS, player: 0, tour: true });
  next.onState(playerState({ yard: true }));
  assert.equal(progress.tourStep(next.ctx()), 'base.factory');
});

test('tour: only in the player\'s own skirmish games, while the switch is on and a step is open or the question waits', () => {
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
  assert.match(main, /new GuideTracker\(\{[^}]*tour: tourRuns\(guideGame, guide\)/, 'the tracker knows whether the tour runs');
  progress.mark(TOUR_STEPS);
  assert.equal(progress.tourComplete(), true);
  // Finished is not skipped: the switch stays on; the tour runs once more for its question.
  assert.equal(progress.tourInGames, true, 'finished: the switch stays on');
  assert.equal(progress.finalePending(), true);
  assert.equal(tourRuns(skirmish, progress), true, 'the question waits');
  progress.answerQuickTips(true);
  assert.equal(tourRuns(skirmish, progress), false);
  progress.setTourInGames(false);
  assert.equal(tourRuns(skirmish, progress), false, 'skipped');
});

test('tour: Take the tour again clears the steps it counts; passive and outside ticks stay', () => {
  const { progress } = setup();
  progress.mark([...TOUR_STEPS, 'power.low', 'team.chat', 'ore.deliver']);
  progress.restartTour();
  assert.equal(progress.count(TOUR_STEPS), 0);
  for (const id of ['power.low', 'team.chat', 'ore.deliver']) assert.ok(progress.isDone(id), id);
  assert.equal(tourRuns({ kind: 'skirmish' }, progress), true);
  progress.setTourInGames(false);
  // On again after everything was done (played without the tour): it starts over.
  progress.mark(TOUR_STEPS);
  progress.setTourInGames(true);
  assert.equal(progress.count(TOUR_STEPS), 0);
  assert.equal(tourRuns({ kind: 'skirmish' }, progress), true);
});

test('tour card: the open step, its dots and lit cameo; Step done; Skip step; Skip the tour', () => {
  const { registry, progress, tracker } = setup({ tour: true });
  const settings = createSettings(registry);
  const hotkeys = new HotkeyRegistry(settings);
  hotkeys.registerAction('deploy', ['F'], () => {});
  let guideOpened = 0;
  const { card, root, cards, timers, buttonOf } = tourCard(progress, tracker, { cameos: ['POWR', 'PROC', 'TENT'], hotkeys, onGuide: () => guideOpened++ });
  assert.equal(root.getAttribute('aria-label'), 'Tour');
  assert.ok(card.shown);
  assert.match(textOf(root), /Tour · Your first base · 1 of 9/);
  assert.match(textOf(root), /Deploy \(F\)/);
  assert.equal(root.querySelectorAll('.tour-dot').length, 9);
  assert.equal(root.querySelector('[aria-current="step"]').textContent, 'Step 1: now');
  // The game ticks off the first step: "Step done", the next step with its cameo lit.
  tracker.onEvents(DEPLOYED);
  assert.equal(root.querySelector('.tour-toast').getAttribute('role'), 'status');
  assert.match(root.querySelector('.tour-toast').textContent, /Step done: MCV deployed/);
  assert.match(textOf(root.querySelector('.tour-card')), /Build a Power Plant/);
  assert.ok(cards.POWR.classList.contains(TARGET_CLASS));
  assert.ok(!cards.PROC.classList.contains(TARGET_CLASS));
  assert.deepEqual(tourModel(progress).dots, ['done', 'active', 'open', 'open', 'open', 'open', 'open', 'open', 'open']);
  // Skip step: the next one, the cameo moves.
  click(buttonOf('Skip step'));
  assert.ok(progress.isDone('base.power'));
  assert.ok(!cards.POWR.classList.contains(TARGET_CLASS) && cards.PROC.classList.contains(TARGET_CLASS));
  // Full guide opens the game menu's Guide page.
  click(buttonOf('Full guide'));
  assert.equal(guideOpened, 1);
  // The close button skips the whole tour; the Guide's switch turns it on again.
  click(root.querySelector('.tour-close'));
  assert.equal(progress.tourInGames, false);
  assert.equal(card.shown, false);
  assert.ok(!cards.PROC.classList.contains(TARGET_CLASS), 'no lit cameo left');
  assert.match(root.querySelector('.tour-toast').textContent, /Tour off/);
  timers.forEach((fn) => fn());
  assert.equal(root.querySelector('.tour-toast').textContent, '');
  card.dispose();
  assert.equal(doc.body.querySelector('.tour'), null);
});

// ---- The quick tips question (design 5) ----------------------------------------------------

test('finale: Keep or Turn them off sets game.quickTips once; a tour done elsewhere asks in the next skirmish; skipped or restarted never asks again', () => {
  const almost = TOUR_STEPS.filter((id) => id !== 'team.rejoin');
  // Keep.
  {
    const { tracker, progress, registry } = setup({ tour: true });
    registry.set('game', 'quickTips', false); // say another device synced false: the answer wins
    progress.mark(almost);
    const { root, card, toast, buttonOf } = tourCard(progress, tracker);
    click(buttonOf('Got it'));
    const finale = root.querySelector('.tour-finale');
    assert.equal(finale.hidden, false);
    assert.equal(finale.getAttribute('role'), 'group');
    assert.equal(finale.getAttribute('aria-labelledby'), 'tour-finale-title');
    assert.equal(root.querySelector('#tour-finale-title').textContent, 'Tour done');
    assert.equal(root.querySelector('#tour-finale-title').tagName.toLowerCase(), 'h2');
    assert.match(textOf(finale), /Quick tips say what a building or unit does when you hover it, in the build menu and on the battlefield/);
    for (const b of [buttonOf('Keep quick tips'), buttonOf('Turn them off')]) assert.equal(b.getAttribute('aria-describedby'), 'tour-finale-text');
    assert.match(toast(), /Tour done\. Keep the quick tips\? Two buttons on the tour card\./);
    assert.equal(buttonOf('Skip step').hidden, true);
    assert.equal(root.querySelector('.tour-dots').hidden, true);
    assert.equal(buttonOf('Full guide').hidden, false);
    click(buttonOf('Keep quick tips'));
    assert.equal(registry.get('game', 'quickTips'), true);
    assert.equal(registry.get('guide', 'quickTipsAsked'), true);
    assert.equal(card.shown, false);
    assert.equal(progress.tourInGames, true, 'the switch stays on');
    assert.equal(toast(), 'Quick tips stay on.');
    assert.equal(tourRuns({ kind: 'skirmish' }, progress), false);
    // Take the tour again and finish it: not asked again.
    progress.restartTour();
    progress.mark(TOUR_STEPS);
    assert.equal(progress.finalePending(), false);
    assert.equal(tourModel(progress), null);
  }
  // Turn them off.
  {
    const { tracker, progress, registry } = setup({ tour: true });
    progress.mark(TOUR_STEPS);
    const { buttonOf, toast } = tourCard(progress, tracker);
    click(buttonOf('Turn them off'));
    assert.equal(registry.get('game', 'quickTips'), false);
    assert.equal(registry.get('guide', 'quickTipsAsked'), true);
    assert.match(toast(), /Quick tips off\. Settings, Game turns them on again\./);
  }
  // Done in a mission (no card): the next skirmish shows the question straight away.
  {
    const { progress } = setup();
    const mission = new GuideTracker({ progress, actors: ACTORS, player: 0, tour: false });
    progress.mark(almost);
    mission.onState(playerState({ yard: true }));
    progress.mark(['team.rejoin']); // the Guide page, in the mission
    assert.equal(tourRuns({ kind: 'skirmish' }, progress), true);
    const next = new GuideTracker({ progress, actors: ACTORS, player: 0, tour: true });
    const { root } = tourCard(progress, next);
    assert.equal(root.querySelector('.tour-finale').hidden, false);
    assert.equal(root.querySelector('.tour-where').textContent, 'Tour · Done');
    // Closing it answers nothing about the tips and never asks again; the tour is done, not skipped: the switch stays on.
    const close = root.querySelector('.tour-close');
    assert.equal(close.getAttribute('aria-label'), 'Close');
    click(close);
    assert.equal(progress.registry.get('game', 'quickTips'), true, 'unchanged');
    assert.equal(progress.quickTipsAsked, true);
    assert.equal(progress.tourInGames, true, 'tour steps of later versions still come');
    assert.equal(root.querySelector('.tour-card').hidden, true, 'the card goes');
    assert.match(root.querySelector('.tour-toast').textContent, /Quick tips stay as they are/);
    assert.equal(tourRuns({ kind: 'skirmish' }, progress), false);
  }
  // Skipped the tour: never asked.
  {
    const { progress } = setup();
    progress.setTourInGames(false);
    progress.mark(TOUR_STEPS);
    assert.equal(progress.finalePending(), false);
    assert.equal(tourRuns({ kind: 'skirmish' }, progress), false);
  }
});

// ---- Migration (design 4) ------------------------------------------------------------------

test('migration: base.production carries over to the Barracks and War Factory steps, a radar done to the power check; the 0.19.0 steps are New to a 0.18.0 player', () => {
  const registry = createRegistry({ storage: memoryStorage() });
  const old = ['base.mcv', 'base.power', 'base.refinery', 'base.production', 'base.radar', 'ore.gems'];
  registry.patch('guide', { seen: '0.18.0', done: Object.fromEntries(old.map((id) => [id, true])) });
  const progress = new GuideProgress(registry);
  assert.deepEqual(CARRIED, { 'base.barracks': ['base.production'], 'base.factory': ['base.production'], 'base.morePower': ['base.radar'] });
  progress.reconcile();
  assert.ok(progress.isDone('base.barracks') && progress.isDone('base.factory'));
  assert.ok(progress.isDone('base.morePower'), 'the dome is built: no power check before it');
  assert.ok(registry.get('guide', 'done')['base.production'], 'the retired id stays as stored');
  assert.deepEqual(progress.newSteps(), ['army.infantry', 'army.vehicle']);
  // The tour of a 0.18.0 finisher: Train infantry, Build a vehicle beside it.
  assert.equal(progress.tourStep(), 'army.infantry');
  assert.equal(progress.tourAlso(), 'army.vehicle');
  assert.equal(tourRuns({ kind: 'skirmish' }, progress), true);
  // Without base.production done the two new ids are New as well, and nothing carries over.
  const r2 = createRegistry({ storage: memoryStorage() });
  r2.patch('guide', { seen: '0.18.0', done: { 'base.mcv': true } });
  const p2 = new GuideProgress(r2);
  p2.reconcile();
  assert.deepEqual(p2.newSteps(), ['base.barracks', 'army.infantry', 'base.factory', 'army.vehicle', 'base.morePower']);
  // A brand-new player: no New badges, the tour from Deploy the MCV.
  const r3 = createRegistry({ storage: memoryStorage() });
  const p3 = new GuideProgress(r3);
  p3.reconcile();
  assert.equal(r3.get('guide', 'seen'), '0.19.0');
  assert.deepEqual(p3.newSteps(), []);
  assert.equal(p3.tourStep(), 'base.mcv');
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
    const { progress, tracker } = setup({ tour: true });
    const field = doc.createElement('div');
    doc.body.append(field);
    // As js/main.js builds it: no timers of its own, so the page's setTimeout.
    const card = new TourCard(field, { progress, ctx: () => tracker.ctx(), onGuide: () => {} });
    tracker.onDone = (ids) => card.stepsDone(ids);
    const toast = () => field.querySelector('.tour-toast').textContent;
    // What the engine reports for each tour step (js/guide.js TRIGGERS), in a frame of its own.
    const frames = [
      ['base.mcv', [[EV.TRANSFORMED, T.MCV, 0, T.FACT]], /Step done: MCV deployed/],
      ['base.power', [[EV.BUILDING_PLACED, T.POWR, 0]], /Step done: Power Plant placed/],
      ['base.refinery', [[EV.BUILDING_PLACED, T.PROC, 0]], /Step done: Ore Refinery placed/],
      ['base.barracks', [[EV.BUILDING_PLACED, T.TENT, 0]], /Step done: Barracks placed/],
      ['army.infantry', [[EV.UNIT_PRODUCED, T.E1, 0]], /Step done: Infantry trained/],
      ['base.factory', [[EV.BUILDING_PLACED, T.WEAP, 0]], /Step done: War Factory placed/],
      ['army.vehicle', [[EV.UNIT_PRODUCED, T.APC, 0]], /Step done: Vehicle built/],
      ['base.morePower', [[EV.BUILDING_PLACED, T.POWR, 0]], /Step done: Room for a Radar Dome/],
      ['base.radar', [[EV.BUILDING_PLACED, T.DOME, 0]], /Chapter done: Your first base/],
    ];
    tracker.onState(playerState({ gen: 100, used: 80 }));
    for (const [id, list, said] of frames) {
      // A throw here stopped the 0.17.0 game loop (js/main.js frameBody); js/frameloop.js now keeps the loop going, but the step's toast must still work.
      assert.doesNotThrow(() => tracker.onEvents(events(...list)), id);
      // The state after the second plant: room for the dome.
      if (id === 'base.morePower') tracker.onState(playerState({ gen: 200, used: 80 }));
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
  assert.match(guideButton.textContent, /1 of 32 steps done/);
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
  assert.match(textOf(root), /Chapter 4/);
  // The switch.
  const sw = root.querySelector('#guide-tour-in-games');
  assert.equal(sw.checked, true);
  check(sw, false);
  assert.equal(registry.get('guide', 'tourInGames'), false);
  click([...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Back to the game menu'));
  assert.ok([...root.querySelectorAll('button')].find((b) => b.textContent === 'Resume'));
  menu.dispose();
});

test('reset: Reset guide progress starts every step over, the tour on, the quick tips question again; guide.seen stays; a newer reset epoch', () => {
  const { registry, progress } = setup();
  progress.reconcile();
  const seen = registry.get('guide', 'seen');
  assert.equal(progress.started, false, 'a new player has nothing to reset');
  progress.mark([...TOUR_STEPS, 'power.low', 'team.chat']);
  progress.answerQuickTips(false);
  progress.setTourInGames(false);
  registry.set('guide', 'lastTip', 7);
  assert.equal(progress.started, true);
  progress.resetProgress(5_000);
  assert.deepEqual(registry.get('guide', 'done'), {});
  assert.equal(progress.tourInGames, true);
  assert.equal(progress.quickTipsAsked, false);
  assert.equal(registry.get('guide', 'seen'), seen, 'what was seen stays seen: no flood of New badges');
  assert.deepEqual(progress.newSteps(), []);
  assert.equal(registry.get('guide', 'lastTip'), 7, 'the loading tips go on where they were');
  assert.equal(registry.get('game', 'quickTips'), false, 'the quick tips choice itself stays until asked again');
  assert.equal(registry.get('guide', 'resetAt'), 5_000);
  assert.equal(tourRuns({ kind: 'skirmish' }, progress), true);
  assert.equal(progress.tourStep(), 'base.mcv');
  // Every reset moves the epoch on, also with a clock that went back.
  progress.resetProgress(1_000);
  assert.equal(registry.get('guide', 'resetAt'), 5_001);
  // Take the tour again keeps the epoch: the set merge carries it to other devices without dropping their steps.
  progress.mark(TOUR_STEPS);
  progress.restartTour();
  assert.equal(registry.get('guide', 'resetAt'), 5_001);
  // The registry's document still passes the server.
  assert.doesNotThrow(() => validateSettingsDocument(registry.document()));
});

test('Guide page: Reset guide progress asks first; Back keeps everything; Reset starts the guide over; Take the tour again stays', () => {
  const registry = createRegistry({ storage: memoryStorage() });
  const progress = new GuideProgress(registry);
  progress.reconcile();
  const { menu, root, guideButton } = guideMenu(progress, registry);
  menu.open();
  click(guideButton());
  const resetButton = () => [...root.querySelectorAll('button')].find((b) => b.textContent === 'Reset guide progress');
  assert.equal(resetButton(), undefined, 'nothing to reset yet');
  menu.close();
  progress.mark(TOUR_STEPS);
  progress.answerQuickTips(true);
  menu.open();
  click(guideButton());
  assert.ok([...root.querySelectorAll('button')].find((b) => b.textContent === 'Take the tour again'), 'Take the tour again is still offered');
  click(resetButton());
  // The menu's confirm step.
  assert.equal(root.querySelector('h1').textContent, 'Reset guide progress');
  assert.match(textOf(root.querySelector('.gm-confirm')), /Every step is open again/);
  const confirmButton = (label) => [...root.querySelectorAll('.gm-confirm button')].find((b) => b.textContent === label);
  click(confirmButton('Back'));
  assert.equal(root.querySelector('h1').textContent, 'Guide', 'Back returns to the Guide');
  assert.equal(progress.count(TOUR_STEPS), TOUR_STEPS.length, 'nothing changed');
  click(resetButton());
  click(confirmButton('Reset progress'));
  assert.equal(root.querySelector('h1').textContent, 'Guide');
  assert.match(textOf(root.querySelector('.gm-message')), /Guide progress reset/);
  assert.equal(progress.count(), 0);
  assert.equal(progress.quickTipsAsked, false);
  assert.equal(root.querySelector('#guide-tour-in-games').checked, true);
  assert.equal(resetButton(), undefined, 'nothing left to reset');
  assert.match(textOf(root), /0 of 32 steps done/);
  menu.dispose();
});

test('outline: the protocol\'s guide outline and progress summary (the admin view) follow GuideProgress', () => {
  // The generated outline (tools/gen-guide-outline.mjs) is this guide.
  assert.deepEqual(GUIDE_OUTLINE.chapters.map((c) => c.steps.map((st) => st.id)), CONTENT.chapters.map((c) => c.steps.map((st) => st.id)));
  assert.equal(GUIDE_OUTLINE.version, CONTENT.version);
  const empty = guideSummary({});
  assert.deepEqual([empty.steps.total, empty.tour.total], [STEP_IDS.length, TOUR_STEPS.length]);
  assert.deepEqual([STEP_IDS.length, TOUR_STEPS.length], [32, 26]);
  // Where the tour is, for many sets of done steps: the same chapter and step as the game.
  const registry = createRegistry({ storage: memoryStorage() });
  const progress = new GuideProgress(registry);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 300; i++) {
    const p = i % 3 === 0 ? 0.9 : rand();
    const done = Object.fromEntries(STEP_IDS.filter(() => rand() < p).map((id) => [id, true]));
    registry.set('guide', 'done', done);
    const sum = guideSummary(registry.values().guide);
    assert.equal(sum.steps.done, progress.count(), `steps of set ${i}`);
    assert.equal(sum.tour.done, progress.count(TOUR_STEPS));
    assert.equal(sum.tour.chapter, progress.tourChapter()?.id ?? null, `chapter of set ${i}`);
    assert.equal(sum.tour.step, progress.tourStep(), `step of set ${i}`);
  }
  // The tour's states.
  const g = (o) => guideSummary({ done: Object.fromEntries(TOUR_STEPS.map((id) => [id, true])), ...o }).tour.state;
  assert.equal(guideSummary({}).tour.state, 'running');
  assert.equal(guideSummary({ tourInGames: false }).tour.state, 'off');
  assert.equal(g({}), 'finale');
  assert.equal(g({ quickTipsAsked: true }), 'finished');
  assert.equal(g({ tourInGames: false }), 'finished');
  // The admin actions do what the Guide page does.
  registry.set('guide', 'done', { 'base.mcv': true, 'power.low': true });
  const restarted = applyGuideAction(registry.values().guide, 'restartTour', 10);
  progress.restartTour();
  assert.deepEqual(restarted, registry.values().guide);
  progress.mark(STEP_IDS);
  registry.set('guide', 'quickTipsAsked', true);
  const reset = applyGuideAction(registry.values().guide, 'reset', 20);
  progress.resetProgress(20);
  assert.deepEqual(reset, registry.values().guide);
  const complete = guideSummary(applyGuideAction(registry.values().guide, 'complete', 30));
  assert.equal(complete.steps.done, STEP_IDS.length);
  assert.equal(complete.tour.state, 'finished');
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
  // Events the guide remembers: one pass (guide.done and the tour switch read once), whatever their number.
  const tour = setup({ tour: true });
  let tourReads = 0;
  const tourGet = tour.registry.get.bind(tour.registry);
  tour.registry.get = (...a) => {
    tourReads++;
    return tourGet(...a);
  };
  tour.tracker.onEvents(events(...Array.from({ length: 500 }, () => [EV.BUILDING_PLACED, T.POWR, 1])));
  assert.ok(tourReads <= 4, `${tourReads} reads for 500 placements of another player`);
  tourReads = 0;
  tour.tracker.onState(playerState());
  assert.ok(tourReads <= 4, `${tourReads} reads for a state`);
});

// ---- Guide content of later versions (docs/contracts.md, "The guide and the tour") ----------

/** The guide's 0.17.0 content: this guide without the steps later versions added. */
const BASELINE = GUIDE.map((c) => ({ ...c, steps: c.steps.filter((s) => !s.since || s.since === GUIDE_BASELINE) }));
const chapterOfBaseline = (id) => BASELINE.find((c) => c.id === id);

/**
 * The guide as a later release might grow the 0.17.0 one: a 0.18.0 step in
 * the first chapter, one in another chapter and a new chapter. Synthetic.
 */
const LATER = guideContent([
  {
    ...chapterOfBaseline('base'),
    steps: [...chapterOfBaseline('base').steps, { id: 'base.silo', since: '0.18.0', title: 'Store the ore', text: 'Silos keep what the refinery cannot.', watch: 'Silo placed', tour: 'Build a Silo.' }],
  },
  ...BASELINE.filter((c) => c.id !== 'base' && c.id !== 'ore'),
  { ...chapterOfBaseline('ore'), steps: [...chapterOfBaseline('ore').steps, { id: 'ore.derrick', since: '0.18.0', title: 'Oil Derricks', text: 'Capture one with an engineer.', watch: 'Chapter read' }] },
  { id: 'navy', since: '0.18.0', title: 'The navy', intro: 'Ships.', tip: 'Subs.', steps: [{ id: 'navy.yard', title: 'Build a Naval Yard', text: 'On the coast.', watch: 'Naval Yard placed' }] },
]);
const NEW_IDS = ['base.silo', 'ore.derrick', 'navy.yard'];
/** As 0.17.0 left a player who finished its tour (the first chapter) and played on a bit. */
const BASELINE_TOUR = chapterOfBaseline('base').steps.map((s) => s.id);
const BASELINE_DONE = Object.fromEntries([...BASELINE_TOUR, 'ore.deliver', 'power.bar'].map((id) => [id, true]));

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
  // The tour walks the chapters in TOUR_ORDER (ore before power, whatever the content's order), a new chapter last.
  assert.deepEqual(LATER.tourChapters.map((c) => c.id), [...TOUR_ORDER, 'navy']);
  assert.deepEqual(LATER.tourIds.slice(0, 5), [...BASELINE_TOUR, 'base.silo']);
  assert.ok(LATER.tourIds.includes('navy.yard'));
  // The guide this game ships: every chapter says its version, no step is older than its chapter.
  for (const c of GUIDE) {
    assert.ok(compareVersions(c.since, '0.0.1') > 0 && /^\d+\.\d+\.\d+$/.test(c.since), `${c.id} since`);
    for (const st of c.steps) if (st.since) assert.ok(compareVersions(st.since, c.since) >= 0, `${st.id} is not older than its chapter`);
  }
  assert.equal(CONTENT.version, '0.19.0');
  assert.deepEqual(
    STEP_IDS.filter((id) => CONTENT.steps.get(id).since === '0.19.0'),
    ['base.barracks', 'army.infantry', 'base.factory', 'army.vehicle', 'base.morePower'],
  );
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
  assert.match(model.where, /5 of 5/);
  assert.deepEqual(model.dots, ['done', 'done', 'done', 'done', 'active']);
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
  progress.mark(LATER.tourIds);
  assert.equal(progress.tourInGames, true);
  const later = guideContent([{ ...LATER.chapters[0], steps: [...LATER.chapters[0].steps, { id: 'base.repair', since: '0.19.0', title: 'Repair', text: 'Wrench.', watch: 'Repaired', tour: 'Repair it.' }] }]);
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
