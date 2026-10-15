// js/loadingscreen.js: shown at once, steps from the start's spans, gone on
// the first frame, an error state with a way back; accessible and still with
// "Reduce motion".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LoadingScreen, loadingPlan, SPAN_STEPS, STEP_LABELS } from '../js/loadingscreen.js';
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
  const screen = new LoadingScreen(root, { reducedMotion: () => reduced, doc });
  start.focus = focus(start);
  screen.card.focus = focus(screen.card);
  return { doc, root, screen, start };
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
  const { doc, root, screen, start } = setup();
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
  // The first frame.
  screen.done();
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

test('"Reduce motion" stills the spinner and the bar (the setting, and the browser\'s in the stylesheet)', () => {
  const { root, screen } = setup({ reduced: true });
  screen.begin(loadingPlan('replay'));
  assert.ok(root.classList.contains('is-still'));
  uninstallDom();
  const css = readFileSync(new URL('../css/loading.css', import.meta.url), 'utf8');
  assert.match(css, /#loading\.is-still \.loading-spinner/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^}]*\.loading-spinner/s);
  // The spinner turns with a transform (the compositor keeps it turning while the main thread works).
  assert.match(css, /@keyframes loading-spin \{\s*to \{\s*transform: rotate\(360deg\)/);
  // A menu screen card: the window less the screen gap, over the grid.
  assert.match(css, /#loading \{[^}]*padding: var\(--ui-screen-pad\);[^}]*background: var\(--ui-screen-bg\);/s);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="css\/loading\.css" \/>/);
  assert.match(html, /<section id="loading" aria-busy="false" hidden><\/section>/);
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
