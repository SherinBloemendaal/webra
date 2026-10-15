// js/loadingscreen.js: shown at once, steps from the start's spans, gone on
// the first frame, an error state with a way back; accessible and still with
// "Reduce motion".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FirstFrameGuard, LOADING_FADE_MS, LOADING_MIN_MS, LoadingScreen, loadingPlan, SPAN_STEPS, STEP_LABELS } from '../js/loadingscreen.js';
import { Events } from '../js/sim/host.js';
import { FakeEvent } from './dom-fixtures.mjs';
import { PerfTrace } from '../js/perfcapture.js';
import { click, installDom, textOf, uninstallDom } from './dom-fixtures.mjs';

/** Inline custom properties the screen sets (the fake DOM drops styles). */
function recordStyles(doc) {
  const make = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const el = make(tag);
    const props = new Map();
    el.style = { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), getPropertyValue: (k) => props.get(k) ?? '' };
    return el;
  };
}

function setup({ reduced = false } = {}) {
  const doc = installDom();
  recordStyles(doc);
  const root = doc.createElement('section');
  root.id = 'loading';
  const start = doc.createElement('button');
  doc.body.append(start, root);
  // The Start button had the focus.
  doc.activeElement = start;
  const focus = (el) => () => (doc.activeElement = el);
  // A clock and timers of the test's own: the least showing time and the fade run when the test says.
  const clock = { now: 0 };
  const pending = new Map();
  let ids = 0;
  const timers = {
    setTimeout: (fn, ms) => (pending.set(++ids, { fn, ms }), ids),
    clearTimeout: (id) => pending.delete(id),
  };
  const flush = () => {
    for (const [id, t] of [...pending]) {
      pending.delete(id);
      t.fn();
    }
  };
  const screen = new LoadingScreen(root, { reducedMotion: () => reduced, doc, now: () => clock.now, timers });
  start.focus = focus(start);
  screen.card.focus = focus(screen.card);
  return { doc, root, screen, start, clock, pending, flush };
}

const steps = (root) => root.querySelectorAll('.loading-step').map((li) => [li.dataset.step, li.dataset.state]);

test('loadingPlan: the steps of each kind of start, with real work only', () => {
  assert.deepEqual(
    loadingPlan('skirmish').steps.map((s) => s.id),
    ['content', 'engine', 'world', 'battlefield', 'frame'],
  );
  assert.equal(loadingPlan('skirmish').steps[2].label, 'Generating the map');
  assert.equal(loadingPlan('skirmish', { mapFile: true }).steps[2].label, 'Loading the map');
  const mission = loadingPlan('mission', { missionFile: true, title: 'Allies 01: In the thick of it', restart: true });
  assert.equal(mission.title, 'Restarting: Allies 01: In the thick of it');
  assert.deepEqual(
    mission.steps.map((s) => s.id),
    ['mission', 'content', 'engine', 'world', 'battlefield', 'frame'],
  );
  assert.equal(loadingPlan('save').steps[2].label, 'Loading the saved game');
  assert.equal(loadingPlan('replay').steps[2].label, 'Opening the replay');
  // Online: the map download first, no content step (the page loaded it already).
  assert.deepEqual(
    loadingPlan('online', { download: true, mapFile: true }).steps.map((s) => s.id),
    ['map', 'engine', 'world', 'battlefield', 'frame'],
  );
  assert.equal(loadingPlan('online').steps.find((s) => s.id === 'world').label, 'Generating the map');
  assert.equal(loadingPlan('stress').title, 'Stress test');
  assert.throws(() => loadingPlan('tutorial'), /unknown kind/);
  for (const s of loadingPlan('mission', { missionFile: true }).steps) assert.ok(s.label, s.id);
  assert.equal(STEP_LABELS.frame, 'Drawing the first frame');
});

test('begin shows the screen at once, busy, at the first step, with the focus on it', () => {
  const { doc, root, screen } = setup();
  assert.equal(root.hidden, true, 'hidden until a start');
  screen.begin(loadingPlan('skirmish'));
  assert.equal(root.hidden, false);
  assert.equal(screen.active, true);
  assert.equal(root.getAttribute('aria-busy'), 'true');
  assert.equal(root.getAttribute('aria-labelledby'), 'loading-title');
  assert.equal(root.querySelector('#loading-title').textContent, 'Skirmish');
  assert.equal(doc.activeElement, screen.card, 'keyboard users are on the screen, not on a hidden button');
  const status = root.querySelector('.loading-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.textContent, 'Reading installed content...');
  const bar = root.querySelector('.loading-bar');
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuenow'), '0');
  assert.equal(bar.getAttribute('aria-valuetext'), 'Step 1 of 5: Reading installed content');
  assert.deepEqual(steps(root), [
    ['content', 'active'],
    ['engine', 'pending'],
    ['world', 'pending'],
    ['battlefield', 'pending'],
    ['frame', 'pending'],
  ]);
  assert.equal(root.querySelector('.loading-spinner').getAttribute('aria-hidden'), 'true');
  assert.equal(root.classList.contains('is-still'), false);
  uninstallDom();
});

test('the start trace spans move the steps forward (never back), then the first frame hides the screen', () => {
  const { doc, root, screen, start, flush } = setup();
  const trace = new PerfTrace(() => 0);
  trace.onSpan = (name) => screen.span(name);
  screen.begin(loadingPlan('skirmish'));
  trace.beginStartup();
  trace.span('content.load', () => {});
  assert.equal(steps(root)[0][1], 'active');
  trace.span('sim.host', () => {});
  assert.deepEqual(steps(root).slice(0, 2), [
    ['content', 'done'],
    ['engine', 'active'],
  ]);
  trace.span('sim.start', () => {});
  assert.equal(root.querySelector('.loading-status').textContent, 'Generating the map...');
  // Spans that are no step change nothing; an earlier step does not go back.
  trace.span('upload.sprites', () => {});
  screen.span('content.load');
  assert.equal(root.querySelector('.loading-status').textContent, 'Generating the map...');
  trace.span('rules.parse', () => {});
  assert.equal(steps(root)[3][1], 'active');
  assert.equal(root.querySelector('[aria-current="step"]').dataset.step, 'battlefield');
  screen.step('frame');
  const bar = root.querySelector('.loading-bar');
  assert.equal(bar.getAttribute('aria-valuenow'), '80');
  assert.equal(root.querySelector('.loading-bar-fill').style.getPropertyValue('--fill'), '0.8');
  assert.deepEqual(Object.keys(SPAN_STEPS).sort(), ['content.load', 'rules.parse', 'sim.host', 'sim.start']);
  // The first frame: the bar fills, the screen fades out after its least time.
  screen.done();
  assert.equal(root.querySelector('.loading-bar-fill').style.getPropertyValue('--fill'), '1');
  assert.equal(root.querySelector('.loading-status').textContent, 'Ready. Starting the game');
  assert.equal(root.hidden, false);
  flush();
  assert.equal(root.hidden, true);
  assert.equal(screen.active, false);
  assert.equal(root.getAttribute('aria-busy'), 'false');
  assert.notEqual(doc.activeElement, start, 'the game keeps the focus: it does not go back to the hidden Start button');
  // Spans of a later start trace with no screen open do nothing.
  screen.span('sim.host');
  assert.equal(root.hidden, true);
  uninstallDom();
});

test('a failed start: an alert with the reason, Back closes and gives the focus back (or runs its own action)', () => {
  const { doc, root, screen, start } = setup();
  screen.begin(loadingPlan('mission', { missionFile: true }));
  screen.fail('Could not load the mission: HTTP 404');
  assert.equal(root.hidden, false);
  assert.equal(screen.active, false);
  assert.equal(root.getAttribute('aria-busy'), 'false');
  assert.ok(root.classList.contains('is-failed'));
  const alert = root.querySelector('[role="alert"]');
  assert.equal(textOf(alert), 'Could not load the mission: HTTP 404');
  assert.equal(root.querySelector('.loading-spinner'), null, 'no spinner once it failed');
  const back = root.querySelector('button');
  assert.equal(back.textContent, 'Back');
  back.focus = () => (doc.activeElement = back);
  // fail() focused the button before the test could watch: focus it again through the same path.
  screen.fail('Could not load the mission: HTTP 404');
  assert.equal(doc.activeElement.textContent, 'Back');
  click(root.querySelector('button'));
  assert.equal(root.hidden, true);
  assert.equal(doc.activeElement, start, 'back where the start came from');
  // After a game was taken down (a restart in place): the button goes back to the menu.
  let reloaded = 0;
  screen.begin(loadingPlan('skirmish', { restart: true }));
  screen.fail('Could not start the game: the worker stopped', { label: 'Back to the menu', run: () => reloaded++ });
  const toMenu = root.querySelector('button');
  assert.equal(toMenu.textContent, 'Back to the menu');
  click(toMenu);
  assert.equal(reloaded, 1);
  // done() after a failure changes nothing.
  screen.done();
  assert.equal(root.hidden, false);
  uninstallDom();
});

test('"Reduce motion" stills the spinner, the bar and the entrance (the setting, and the browser\'s in the stylesheet)', () => {
  const { root, screen, pending } = setup({ reduced: true });
  screen.begin(loadingPlan('replay'));
  assert.ok(root.classList.contains('is-still'));
  // No least time and no fade: the first frame closes it at once.
  assert.equal(screen.holdMs(), 0);
  screen.done();
  assert.equal(root.hidden, true);
  assert.equal(pending.size, 0);
  uninstallDom();
  const css = readFileSync(new URL('../css/loading.css', import.meta.url), 'utf8');
  assert.match(css, /#loading\.is-still \*,[^{]*\{\s*animation: none !important;\s*transition: none !important;/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^@]*#loading \*,[^{]*\{\s*animation: none !important;/s);
  assert.match(css, /@media \(forced-colors: active\)/);
  // The spinner turns with a transform (the compositor keeps it turning while the main thread works).
  assert.match(css, /@keyframes loading-spin \{\s*to \{\s*transform: rotate\(360deg\)/);
  // The times in the stylesheet are the script's.
  assert.match(css, new RegExp(`--loading-min: ${LOADING_MIN_MS}ms;`));
  assert.match(css, new RegExp(`--loading-fade: ${LOADING_FADE_MS}ms;`));
  assert.match(css, /#loading\.is-closing \{[^}]*transition: opacity var\(--loading-fade\) ease-in var\(--loading-hold, 0ms\);/s);
  assert.match(css, /\.loading-bar \{[^}]*animation: loading-reveal var\(--loading-min\)/s);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="css\/loading\.css" \/>/);
  assert.match(html, /<section id="loading" aria-busy="false" hidden><\/section>/);
});

test('the screen shows at least LOADING_MIN_MS (the bar\'s animation), then fades out in LOADING_FADE_MS', () => {
  const { root, screen, clock, pending, flush } = setup();
  clock.now = 1000;
  screen.begin(loadingPlan('skirmish'));
  // A quick start: the first frame after 400 ms.
  clock.now = 1400;
  assert.equal(screen.holdMs(), LOADING_MIN_MS - 400);
  screen.done();
  assert.ok(root.classList.contains('is-closing'));
  assert.equal(root.style.getPropertyValue('--loading-hold'), `${LOADING_MIN_MS - 400}ms`);
  assert.deepEqual([...pending.values()].map((t) => t.ms), [LOADING_MIN_MS - 400 + LOADING_FADE_MS]);
  assert.equal(screen.active, true, 'still showing while it waits');
  // A second first frame changes nothing.
  screen.done();
  assert.equal(pending.size, 1);
  flush();
  assert.equal(root.hidden, true);
  assert.ok(!root.classList.contains('is-closing'));
  // A slow start: no hold, only the fade.
  screen.begin(loadingPlan('skirmish'));
  clock.now += LOADING_MIN_MS + 5000;
  screen.done();
  assert.equal(root.style.getPropertyValue('--loading-hold'), '0ms');
  assert.deepEqual([...pending.values()].map((t) => t.ms), [LOADING_FADE_MS]);
  // A restart while it fades: the new start shows at once, the old close is dropped.
  screen.begin(loadingPlan('skirmish', { restart: true }));
  assert.equal(pending.size, 0);
  assert.ok(!root.classList.contains('is-closing'));
  assert.equal(root.hidden, false);
  uninstallDom();
});

test('a span listener that throws does not break the span it follows', () => {
  const trace = new PerfTrace(() => 0);
  const warn = console.warn;
  console.warn = () => {};
  try {
    trace.onSpan = () => {
      throw new Error('listener broke');
    };
    trace.beginStartup();
    assert.equal(
      trace.span('sim.host', () => 7),
      7,
    );
    assert.equal(trace.startup[0].name, 'sim.host');
  } finally {
    console.warn = warn;
  }
  // Outside a game's start the listener hears nothing.
  const heard = [];
  trace.onSpan = (n) => heard.push(n);
  trace.endStartup();
  trace.span('atlas.sprites', () => {});
  assert.deepEqual(heard, []);
});

test('a modal dialog: the page behind is inert while it shows (and as it was after), keys stay on the screen, Tab cycles in the card', () => {
  const { doc, root, screen, start, flush } = setup();
  const menu = doc.createElement('section');
  const ended = doc.createElement('section');
  ended.inert = true; // inert already: stays so afterwards
  doc.body.append(menu, ended);
  assert.equal(root.getAttribute('role'), 'dialog');
  assert.equal(root.getAttribute('aria-modal'), 'true');
  screen.begin(loadingPlan('skirmish', { restart: true }));
  assert.equal(start.inert, true);
  assert.equal(menu.inert, true);
  assert.equal(root.inert, undefined, 'the screen itself is not inert');
  // A key on the screen never reaches the game's hotkeys on the window (Esc would open the menu behind it).
  let reached = 0;
  doc.body.addEventListener('keydown', () => reached++);
  const esc = new FakeEvent('keydown', { key: 'Escape' });
  screen.card.dispatchEvent(esc);
  assert.equal(reached, 0);
  // A failed start: Tab and Shift+Tab stay between the card and its button; Enter on what is behind is impossible.
  screen.fail('The game stopped while it started: worker failed', { label: 'Back to the menu', run: () => {} });
  const back = root.querySelector('button');
  back.focus = () => (doc.activeElement = back);
  doc.activeElement = back;
  const tab = new FakeEvent('keydown', { key: 'Tab' });
  back.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(doc.activeElement, screen.card);
  screen.card.dispatchEvent(new FakeEvent('keydown', { key: 'Tab' }));
  assert.equal(doc.activeElement, back);
  screen.card.dispatchEvent(new FakeEvent('keydown', { key: 'Tab', shiftKey: true }));
  assert.equal(doc.activeElement, screen.card);
  assert.equal(reached, 0);
  screen.close();
  assert.equal(start.inert, false);
  assert.equal(menu.inert, false);
  assert.equal(ended.inert, true, 'what was inert before stays inert');
  // The first frame of a game also gives the page back.
  screen.begin(loadingPlan('skirmish'));
  assert.equal(menu.inert, true);
  screen.done();
  assert.equal(menu.inert, true, 'modal until it is gone');
  flush();
  assert.equal(menu.inert, false);
  uninstallDom();
});

test('a game that fails before its first frame ends the loading screen with the error and the way back to the menu', () => {
  const { root, screen } = setup();
  screen.begin(loadingPlan('skirmish'));
  // The simulation worker stopped (js/main.js: host.on('failed')).
  const host = new Events();
  let stops = 0;
  let back = 0;
  const guard = new FirstFrameGuard({ screen, stop: () => stops++, back: () => back++ });
  host.on('failed', (message) => guard.fail(`The game stopped while it started: ${message}`));
  host.emit('failed', 'engine panic at tick 0');
  assert.equal(stops, 1, 'the loop stops');
  assert.equal(screen.state, 'failed');
  assert.match(root.querySelector('[role="alert"]').textContent, /engine panic at tick 0/);
  const button = root.querySelector('button');
  assert.equal(button.textContent, 'Back to the menu');
  click(button);
  assert.equal(back, 1);
  // A second failure changes nothing.
  assert.equal(guard.fail('again'), false);
  uninstallDom();
});

test('a frame that throws before the first one is drawn ends the start; once drawn, frames throw as before', () => {
  const { root, screen, flush } = setup();
  const errors = console.error;
  console.error = () => {};
  try {
    screen.begin(loadingPlan('mission', { missionFile: true }));
    let stops = 0;
    const guard = new FirstFrameGuard({ screen, stop: () => stops++, back() {} });
    // Worker frames not there yet: nothing happens.
    guard.run(() => {});
    assert.equal(screen.active, true);
    guard.run(() => {
      throw new Error('renderer.draw: device lost');
    });
    assert.equal(stops, 1);
    assert.equal(screen.state, 'failed');
    assert.match(root.querySelector('[role="alert"]').textContent, /device lost/);

    // A start that draws its first frame: the screen goes, later errors are the frame's own.
    screen.begin(loadingPlan('skirmish'));
    const ok = new FirstFrameGuard({ screen, stop: () => stops++, back() {} });
    ok.run(() => ok.firstFrame());
    flush();
    assert.equal(root.hidden, true);
    assert.throws(() => ok.run(() => {
      throw new Error('later');
    }), /later/);
    assert.equal(ok.fail('the worker stopped later'), false, 'after the first frame the toast says it, not the screen');
    assert.equal(root.hidden, true);
    assert.equal(stops, 1);
  } finally {
    console.error = errors;
    uninstallDom();
  }
});
