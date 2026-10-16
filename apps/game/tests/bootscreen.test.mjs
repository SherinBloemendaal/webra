// js/bootscreen.js and index.html #boot: the boot screen of /play shows from
// the first paint (static markup, no inline scripts or styles), lights the
// boot's real steps, goes only once the start menu is ready (the account and
// installed content at most BOOT_WAIT_MS later), hands over to a game's
// loading screen, and never hangs: a boot that fails shows the error with
// Reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOOT_LATE_MS, BOOT_LATE_TEXT, BOOT_OPTIONAL, BOOT_STEPS, BOOT_WAIT_MS, BootScreen, watchGameFiles } from '../js/bootscreen.js';
import { LOADING_FADE_MS, LoadingScreen, loadingPlan } from '../js/loadingscreen.js';
import { AccountSession } from '../js/account/session.js';
import { click, FakeEvent, installDom, textOf, uninstallDom } from './dom-fixtures.mjs';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../css/loading.css', import.meta.url), 'utf8');

/** Timers the test runs by hand. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      pending.set(next, { fn, ms });
      return next++;
    },
    clearTimeout: (id) => pending.delete(id),
    /** Run every pending timer of at most `ms`. */
    run(ms = Infinity) {
      for (const [id, t] of [...pending]) {
        if (t.ms > ms) continue;
        pending.delete(id);
        t.fn();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

/** Inline custom properties the screen sets (the fake DOM drops styles). */
function recordStyles(el) {
  const props = new Map();
  el.style = { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), getPropertyValue: (k) => props.get(k) ?? '' };
  return el;
}

/** index.html's #boot as the fake DOM can build it (the static test below keeps the two equal). */
function bootDom(doc) {
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const root = el('section', 'loading-screen');
  root.id = 'boot';
  const card = el('div', 'loading-card');
  const status = el('p', 'loading-status', `${BOOT_STEPS[0].label}...`);
  status.setAttribute('role', 'status');
  const bar = el('div', 'loading-bar');
  bar.setAttribute('role', 'progressbar');
  const fill = recordStyles(el('span', 'loading-bar-fill'));
  bar.append(fill);
  const list = el('ol', 'loading-steps');
  for (const s of BOOT_STEPS) {
    const li = el('li', 'loading-step', s.label);
    li.dataset.step = s.id;
    li.dataset.state = 'pending';
    list.append(li);
  }
  const late = el('p', 'boot-late', 'This is taking longer than usual. ');
  const reload = el('a', 'boot-reload', 'reload the page');
  reload.setAttribute('href', '');
  late.append(reload);
  card.append(status, bar, list, late);
  root.append(card);
  const menu = el('section');
  menu.id = 'menu';
  doc.body.className = 'is-booting';
  doc.body.append(root, menu);
  return { root, status, bar, fill, reload };
}

function setup({ reduced = false, closeMs = LOADING_FADE_MS } = {}) {
  const doc = installDom();
  const dom = bootDom(doc);
  const timers = fakeTimers();
  const reloads = [];
  const screen = new BootScreen(dom.root, { doc, timers, closeMs: () => closeMs, reload: () => reloads.push(1) });
  screen.reducedMotion = () => reduced;
  return { doc, ...dom, screen, timers, reloads };
}

const lamps = (root) => Object.fromEntries([...root.querySelectorAll('.loading-step')].map((li) => [li.dataset.step, li.dataset.state]));
const settle = () => new Promise((r) => setImmediate(r));

// ---- The static page -----------------------------------------------------------------------

test('index.html: no inline scripts, styles or handlers (the CSP: script-src and style-src self)', () => {
  for (const page of ['../index.html', '../editor/index.html']) {
    const html = readFileSync(new URL(page, import.meta.url), 'utf8');
    assert.equal(/<style\b/i.test(html), false, `${page}: a <style> element`);
    assert.equal(/\sstyle\s*=/i.test(html), false, `${page}: a style attribute`);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, `${page}: an inline event handler`);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\ssrc="[^"]+"/, `${page}: a script without src`);
      assert.equal(m[2].trim(), '', `${page}: a script with inline code`);
    }
    assert.equal(/javascript:/i.test(html), false, `${page}: a javascript: URL`);
  }
});

test('index.html: the boot screen is static markup over the page, with the steps BOOT_STEPS lights', () => {
  assert.match(HTML, /<body class="is-booting">/);
  const boot = /<section id="boot" class="loading-screen" aria-busy="true" aria-labelledby="boot-title">([\s\S]*?)<\/section>/.exec(HTML);
  assert.ok(boot, 'the #boot section');
  assert.ok(HTML.indexOf('id="boot"') < HTML.indexOf('id="menu"'), 'the boot screen comes before the menu');
  const body = boot[1];
  // The loading screen's look: the emblem from brand/, the kicker, the title, status, bar and lamps.
  assert.match(body, /<div class="loading-brand ui-brand" aria-hidden="true"><img class="ui-brand-emblem" src="brand\/favicon\.svg" alt=""/);
  assert.match(body, /<h1 id="boot-title" class="loading-title">/);
  assert.match(body, /<p class="loading-status" role="status" aria-live="polite">Loading the game files\.\.\.<\/p>/);
  assert.match(body, /<div class="loading-bar" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="loading-bar-fill"><\/span><\/div>/);
  const items = [...body.matchAll(/<li class="loading-step" data-step="([a-z]+)" data-state="([a-z]+)"[^>]*>([^<]+)<\/li>/g)].map((m) => ({ id: m[1], state: m[2], label: m[3] }));
  assert.deepEqual(
    items.map(({ id, label }) => ({ id, label })),
    BOOT_STEPS.map(({ id, label }) => ({ id, label })),
  );
  // Before any script: the files load.
  assert.deepEqual(
    items.map((i) => i.state),
    ['active', 'pending', 'pending', 'pending', 'pending', 'pending'],
  );
  assert.match(body, /<noscript>/);
  // The late line: no live region (a change of visibility is not reliably announced; the status line says it).
  const late = /<p class="boot-late">([^]*?)<\/p>/.exec(body);
  assert.ok(late, 'the late line');
  assert.match(late[1], /<a class="boot-reload" href="">/);
  assert.equal(late[1].replace(/<[^>]+>/g, ''), BOOT_LATE_TEXT, 'the late line and the status line say the same');
  // The scripts: error reports first, then the boot screen, then the game (which imports the same module).
  const at = (src) => HTML.indexOf(`<script type="module" src="${src}"></script>`);
  assert.ok(at('js/telemetry/boot.js') > 0 && at('js/telemetry/boot.js') < at('js/bootscreen.js') && at('js/bootscreen.js') < at('js/main.js'));
  assert.match(readFileSync(new URL('../js/main.js', import.meta.url), 'utf8'), /import \{ BOOT_WAIT_MS, bootScreen \} from '\.\/bootscreen\.js';/);
});

test('css/loading.css: the boot screen is the loading screen, over it, without a least time, and its late line needs no script', () => {
  assert.match(CSS, /#boot,\n#loading \{\n  --loading-min/);
  assert.match(CSS, /#boot\.is-closing,\n#loading\.is-closing \{\n  opacity: 0;/);
  assert.match(CSS, /#boot \{\n  --boot-late: (\d+)s;\n  z-index: 84;/);
  assert.equal(Number(/--boot-late: (\d+)s;/.exec(CSS)[1]) * 1000, BOOT_LATE_MS);
  assert.ok(84 > Number(/#loading \{[^}]*z-index: (\d+);/s.exec(CSS.replace('#boot,\n#loading {', '#loading {'))[1]), 'over the loading screen');
  assert.match(CSS, /#boot \.loading-bar \{\n  animation: none;/);
  assert.match(CSS, /\.is-booting #menu,\n\.is-booting #online-root,\n\.is-booting #campaign-root,\n\.is-booting #friends-root \{\n  visibility: hidden;/);
  assert.match(CSS, /\.boot-late \{[^}]*visibility: hidden;[^}]*animation: boot-late 1ms var\(--boot-late\) both;/s);
  // The browser's "Reduce motion" applies before the settings load; the late line still appears.
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{[^@]*#boot \*:not\(\.boot-late\),/s);
  assert.match(CSS, /@media \(forced-colors: active\) \{[^@]*#boot \.loading-step\[data-state='failed'\]::before/s);
  // The failed lamp is the boot screen's alone: the loading screen keeps its own steps.
  assert.equal(/(^|\n)\s*\.loading-step\[data-state='failed'\]/.test(CSS), false);
});

// ---- Steps ---------------------------------------------------------------------------------

test('steps: the files load until main.js runs, then the tracked work lights its lamps', async () => {
  const { root, status, bar, fill, screen } = setup();
  assert.equal(root.getAttribute('aria-busy'), 'true');
  assert.equal(lamps(root).files, 'active');
  screen.started();
  assert.equal(lamps(root).files, 'done');
  let ok;
  let no;
  const engine = new Promise((r) => (ok = r));
  const account = new Promise((_, r) => (no = r));
  assert.equal(screen.track('engine', engine), engine, 'the caller keeps the promise');
  screen.track('account', account);
  assert.equal(lamps(root).engine, 'active');
  assert.equal(root.querySelector('[data-step="engine"]').getAttribute('aria-current'), 'step');
  // The status line names the first step that runs.
  assert.equal(status.textContent, 'Starting the engine...');
  ok();
  no(new Error('offline'));
  await settle();
  assert.equal(lamps(root).engine, 'done');
  assert.equal(lamps(root).account, 'failed');
  // The word says it too, not only the lamp's colour.
  assert.equal(textOf(root.querySelector('[data-step="account"]')), 'Checking your account: unavailable');
  assert.equal(bar.getAttribute('aria-valuenow'), String(Math.round((3 / BOOT_STEPS.length) * 100)));
  assert.equal(fill.style.getPropertyValue('--fill'), String(3 / BOOT_STEPS.length));
  // Nothing to track (accounts unavailable): the step is not available.
  screen.track('content', null);
  assert.equal(lamps(root).content, 'failed');
  // A finished step stays finished.
  screen.begin('engine');
  assert.equal(lamps(root).engine, 'done');
  uninstallDom();
});

// ---- Leaving -------------------------------------------------------------------------------

test('the screen stays while the work is done but the menu is not ready, and goes once it is', async () => {
  const { doc, root, screen, timers } = setup();
  screen.started();
  for (const id of ['engine', 'account', 'content', 'graphics']) screen.track(id, Promise.resolve());
  await settle();
  assert.equal(root.hidden, false, 'every step done, the menu not built: still there');
  assert.ok(doc.body.classList.contains('is-booting'));
  let gone = false;
  screen.closed.then(() => (gone = true));
  screen.begin('menu');
  const ready = screen.ready();
  await settle();
  assert.equal(lamps(root).menu, 'done');
  // The fade: the menu shows behind it, the screen hides once the transition ends.
  assert.ok(root.classList.contains('is-closing'));
  assert.equal(root.getAttribute('aria-busy'), 'false');
  assert.equal(doc.body.classList.contains('is-booting'), false);
  assert.equal(root.hidden, false);
  root.dispatchEvent(new FakeEvent('transitionend'));
  await ready;
  assert.equal(root.hidden, true);
  assert.equal(gone, true);
  assert.equal(timers.size, 0, 'the fallback timer is cleared');
  uninstallDom();
});

test('ready waits for the account and installed content, at most BOOT_WAIT_MS; steps that never ran are skipped', async () => {
  const { root, screen, timers } = setup({ closeMs: 0 });
  assert.deepEqual(BOOT_OPTIONAL, ['account', 'content']);
  screen.started();
  screen.track('engine', Promise.resolve());
  screen.track('account', new Promise(() => {}));
  let finishContent;
  screen.track('content', new Promise((r) => (finishContent = r)));
  await settle();
  const ready = screen.ready();
  await settle();
  assert.equal(root.hidden, false, 'waits for the account and the content');
  finishContent();
  await settle();
  assert.equal(root.hidden, false, 'still waits for the account');
  // The account never answers: the menu shows after BOOT_WAIT_MS; the account finishes behind it.
  timers.run(BOOT_WAIT_MS);
  await ready;
  assert.equal(root.hidden, true);
  // Graphics never began (no engine, no WebGPU): skipped, not done.
  assert.equal(lamps(root).graphics, 'skipped');
  assert.equal(lamps(root).account, 'active');
  uninstallDom();
});

test('a hidden tab (no transition events) still loses the screen after the fade', async () => {
  const { root, screen, timers } = setup();
  screen.started();
  for (const id of BOOT_OPTIONAL) screen.track(id, Promise.resolve());
  await settle();
  const ready = screen.ready();
  await settle();
  assert.equal(root.hidden, false);
  timers.run();
  await ready;
  assert.equal(root.hidden, true);
  uninstallDom();
});

test('Reduce motion: no fade, the screen goes at once', async () => {
  const { root, screen } = setup({ reduced: true });
  screen.started({ reducedMotion: () => true });
  assert.ok(root.classList.contains('is-still'));
  for (const id of BOOT_OPTIONAL) screen.track(id, Promise.resolve());
  await settle();
  await screen.ready();
  assert.equal(root.hidden, true);
  assert.equal(root.classList.contains('is-closing'), false);
  uninstallDom();
});

test('a game that starts during the boot: its loading screen begins and the boot screen fades over it', () => {
  const { doc, root, screen } = setup();
  screen.started();
  const loading = doc.createElement('section');
  loading.id = 'loading';
  doc.body.append(loading);
  const loader = new LoadingScreen(loading, { doc, onBegin: () => screen.handOver() });
  loader.begin(loadingPlan('skirmish'));
  assert.equal(loading.hidden, false);
  assert.equal(screen.state, 'closing');
  assert.ok(root.classList.contains('is-closing'));
  assert.equal(doc.body.classList.contains('is-booting'), false);
  // The boot's own end later changes nothing; neither does a failure, which goes to the console.
  screen.ready();
  const error = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a);
  try {
    screen.fail(new Error('late'));
  } finally {
    console.error = error;
  }
  assert.equal(logged.length, 1);
  assert.equal(root.classList.contains('is-failed'), false);
  uninstallDom();
});

test('after BOOT_LATE_MS the polite status line says the boot takes long (the visual line is CSS)', () => {
  const { status, screen, timers } = setup();
  screen.started();
  timers.run(BOOT_LATE_MS);
  assert.equal(status.textContent, BOOT_LATE_TEXT);
  assert.equal(screen.state, 'booting');
  uninstallDom();
  // A boot that ends in time never says it.
  const quick = setup({ closeMs: 0 });
  quick.screen.started();
  quick.screen.close();
  assert.equal(quick.timers.size, 0, 'the late timer is cleared');
  uninstallDom();
});

test("What's new waits for the boot screen to be gone, and never opens after a failed boot", async () => {
  // main.js: the dialog opens from ready()'s promise, not right after calling it.
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /bootScreen\.ready\(\)\.then\(\(\) => releaseNotes\.showWhatsNewOnce\(\)\);/);
  assert.equal((main.match(/showWhatsNewOnce\(/g) ?? []).length, 1);
  const { root, screen } = setup();
  screen.started();
  screen.track('account', new Promise(() => {}));
  screen.track('content', Promise.resolve());
  let shown = false;
  const ready = screen.ready().then(() => (shown = true));
  await settle();
  assert.equal(shown, false, 'waiting for the account: the screen still shows');
  // Gone after the fade: then it opens.
  screen.set('account', 'done');
  await settle();
  assert.equal(shown, false, 'fading');
  root.dispatchEvent(new FakeEvent('transitionend'));
  await ready;
  assert.equal(shown, true);
  uninstallDom();
  // A failed boot: ready() never resolves, the dialog never opens over the error.
  const failed = setup();
  failed.screen.started();
  failed.screen.fail(new Error('broke'));
  let opened = false;
  failed.screen.ready().then(() => (opened = true));
  await settle();
  failed.timers.run();
  await settle();
  assert.equal(opened, false);
  uninstallDom();
});

test('within: boot work the screen waits for, until it settles or the time is up', async () => {
  const { screen, timers } = setup();
  assert.equal(await screen.within(Promise.resolve(1), 100), true);
  assert.equal(await screen.within(Promise.reject(new Error('404')), 100), true, 'a failure ends the wait too');
  const never = screen.within(new Promise(() => {}), BOOT_WAIT_MS);
  timers.run(BOOT_WAIT_MS);
  assert.equal(await never, false);
  // A restart record's mission: main.js waits for the mission index (at most BOOT_WAIT_MS) before it starts the mission.
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /await bootScreen\.within\(missionIndex\(\), BOOT_WAIT_MS\);\n    startMissionById\(again\.id/);
  uninstallDom();
});

// ---- Failures ------------------------------------------------------------------------------

test('a boot that fails shows why with Reload, as an alert, and never closes', async () => {
  const { root, screen, reloads } = setup();
  screen.started();
  screen.track('engine', Promise.resolve());
  await settle();
  screen.begin('menu');
  screen.fail(new Error('lobby exploded'));
  assert.equal(screen.state, 'failed');
  assert.ok(root.classList.contains('is-failed'));
  assert.equal(root.getAttribute('aria-busy'), 'false');
  const alert = root.querySelector('[role="alert"]');
  assert.equal(textOf(alert), 'WebRA could not start: lobby exploded');
  assert.equal(textOf(root.querySelector('h1')), 'Could not start');
  assert.equal(root.querySelector('h1').id, 'boot-title');
  const button = root.querySelector('button');
  assert.equal(textOf(button), 'Reload');
  click(button);
  assert.equal(reloads.length, 1);
  // A failed boot keeps covering the half-built page (its `closed` never resolves).
  screen.ready();
  await settle();
  assert.equal(root.hidden, false);
  assert.equal(screen.state, 'failed');
  uninstallDom();
});

test('the late line reloads the page in place', () => {
  const { reload, reloads } = setup();
  const e = new FakeEvent('click');
  reload.dispatchEvent(e);
  assert.equal(reloads.length, 1);
  assert.equal(e.defaultPrevented, true);
  uninstallDom();
});

test('game files that do not load fail the boot; errors after main.js runs are its own', () => {
  const doc = installDom({ windowEvents: true });
  const { root } = bootDom(doc);
  const script = doc.createElement('script');
  script.setAttribute('type', 'module');
  script.setAttribute('src', 'js/main.js');
  doc.body.append(script);
  const make = () => new BootScreen(root, { doc, timers: fakeTimers(), reload: () => {} });
  // The main script (or a module it imports) did not arrive.
  let screen = make();
  watchGameFiles(screen, { doc, win: doc.defaultView });
  script.dispatchEvent(new FakeEvent('error', { bubbles: false }));
  assert.equal(screen.state, 'failed');
  assert.equal(textOf(root.querySelector('[role="alert"]')), 'WebRA could not start: the game files did not load.');
  uninstallDom();

  // A module that throws while it loads: a script error on the window.
  const doc2 = installDom({ windowEvents: true });
  const { root: root2 } = bootDom(doc2);
  screen = new BootScreen(root2, { doc: doc2, timers: fakeTimers(), reload: () => {} });
  watchGameFiles(screen, { doc: doc2, win: doc2.defaultView });
  doc2.defaultView.dispatchEvent(new FakeEvent('error', { error: new SyntaxError('Unexpected token'), bubbles: false }));
  assert.equal(textOf(root2.querySelector('[role="alert"]')), 'WebRA could not start: Unexpected token');
  uninstallDom();

  // Once main.js runs, a stray error elsewhere does not end the boot.
  const doc3 = installDom({ windowEvents: true });
  const { root: root3 } = bootDom(doc3);
  screen = new BootScreen(root3, { doc: doc3, timers: fakeTimers(), reload: () => {} });
  watchGameFiles(screen, { doc: doc3, win: doc3.defaultView });
  screen.started();
  doc3.defaultView.dispatchEvent(new FakeEvent('error', { error: new Error('a listener broke'), bubbles: false }));
  assert.equal(screen.state, 'booting');
  uninstallDom();
});

test('without #boot (another page, tests) every call does nothing', async () => {
  const screen = new BootScreen(null);
  screen.started();
  const p = Promise.resolve(3);
  assert.equal(screen.track('engine', p), p);
  screen.fail(new Error('x'));
  await screen.ready();
  await screen.closed;
  assert.equal(screen.state, 'gone');
});

// ---- The account step ----------------------------------------------------------------------

test('AccountSession.whenReady resolves once refresh answered, also offline', async () => {
  const api = { site: async () => ({}), me: async () => Promise.reject(new Error('offline')) };
  const session = new AccountSession({ api });
  let ready = false;
  session.whenReady().then(() => (ready = true));
  await settle();
  assert.equal(ready, false);
  await session.refresh();
  await settle();
  assert.equal(ready, true);
  // Ready already: at once.
  assert.equal(await session.whenReady(), session);
});
