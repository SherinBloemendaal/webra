// The map editor's boot screen (editor/index.html #boot, editor/js/boot.js):
// the game's boot screen (js/bootscreen.js, css/loading.css) with the
// editor's own steps and title, static markup from the first paint, lamps
// for the real steps, gone only once the editor's first frame is drawn
// (installed tiles get at most BOOT_WAIT_MS more), and an error with Reload
// when a step fails. The game's own boot screen leaves the editor's alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOOT_LATE_TEXT, BOOT_WAIT_MS } from '../js/bootscreen.js';
import { EDITOR_BOOT_OPTIONAL, EDITOR_BOOT_STEPS, bootEditor, editorBootScreen, requestFirstFrame } from '../editor/js/boot.js';
import { FakeEvent, installDom, textOf, uninstallDom } from './dom-fixtures.mjs';
import { TERRAIN } from '../editor/js/mapformat.js';

const HTML = readFileSync(new URL('../editor/index.html', import.meta.url), 'utf8');
const EDITOR_JS = readFileSync(new URL('../editor/editor.js', import.meta.url), 'utf8');

/** Timers the test runs by hand. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => (pending.set(next, { fn, ms }), next++),
    clearTimeout: (id) => pending.delete(id),
    run(ms = Infinity) {
      for (const [id, t] of [...pending]) {
        if (t.ms > ms) continue;
        pending.delete(id);
        t.fn();
      }
    },
  };
}

/** editor/index.html's #boot as the fake DOM builds it (the static test keeps the two equal). */
function bootDom(doc) {
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const root = el('section', 'loading-screen');
  root.id = 'boot';
  root.dataset.boot = 'editor';
  const card = el('div', 'loading-card');
  const status = el('p', 'loading-status', `${EDITOR_BOOT_STEPS[0].label}...`);
  const bar = el('div', 'loading-bar');
  const fill = el('span', 'loading-bar-fill');
  fill.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' };
  bar.append(fill);
  const list = el('ol', 'loading-steps');
  for (const s of EDITOR_BOOT_STEPS) {
    const li = el('li', 'loading-step', s.label);
    li.dataset.step = s.id;
    li.dataset.state = 'pending';
    list.append(li);
  }
  card.append(status, bar, list);
  root.append(card);
  doc.body.className = 'editor is-booting';
  doc.body.append(root);
  return { root, status };
}

function setup() {
  const doc = installDom();
  const dom = bootDom(doc);
  const timers = fakeTimers();
  const reloads = [];
  const screen = editorBootScreen(dom.root, { doc, timers, closeMs: () => 0, reload: () => reloads.push(1) });
  return { doc, ...dom, screen, timers, reloads };
}

const lamps = (root) => Object.fromEntries([...root.querySelectorAll('.loading-step')].map((li) => [li.dataset.step, li.dataset.state]));
const settle = () => new Promise((r) => setImmediate(r));

/** Work for bootEditor whose steps finish when the test says (`finish(id)`), recording the order they began. */
function controlledWork() {
  const began = [];
  const finish = {};
  const fail = {};
  const work = {};
  for (const id of ['engine', 'rules', 'graphics', 'content', 'map', 'editor']) {
    work[id] = () => {
      began.push(id);
      return new Promise((resolve, reject) => {
        finish[id] = resolve;
        fail[id] = reject;
      });
    };
  }
  return { work, began, finish, fail };
}

// ---- The static page -----------------------------------------------------------------------

test('editor/index.html: the boot screen is static markup with the editor\'s title and the steps EDITOR_BOOT_STEPS lights', () => {
  assert.match(HTML, /<body class="editor is-booting">/);
  const boot = /<section id="boot" class="loading-screen" data-boot="editor" aria-busy="true" aria-labelledby="boot-title">([\s\S]*?)<\/section>/.exec(HTML);
  assert.ok(boot, 'the #boot section, marked as the editor\'s');
  assert.ok(HTML.indexOf('id="boot"') < HTML.indexOf('id="topbar"'), 'before the editor');
  const body = boot[1];
  assert.match(body, /<h1 id="boot-title" class="loading-title">Map editor<\/h1>/);
  assert.match(body, /<p class="loading-status" role="status" aria-live="polite">Loading the editor files\.\.\.<\/p>/);
  assert.match(body, /<div class="loading-bar" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="loading-bar-fill"><\/span><\/div>/);
  const items = [...body.matchAll(/<li class="loading-step" data-step="([a-z]+)" data-state="([a-z]+)"[^>]*>([^<]+)<\/li>/g)].map((m) => ({ id: m[1], state: m[2], label: m[3] }));
  assert.deepEqual(
    items.map(({ id, label }) => ({ id, label })),
    EDITOR_BOOT_STEPS.map(({ id, label }) => ({ id, label })),
  );
  assert.deepEqual(
    items.map((i) => i.state),
    ['active', ...EDITOR_BOOT_STEPS.slice(1).map(() => 'pending')],
  );
  assert.match(body, /<noscript><p class="loading-error">The map editor needs JavaScript\./);
  const late = /<p class="boot-late">([^]*?)<\/p>/.exec(body);
  // The page's base is /play/: the late line's link names the editor's page.
  assert.match(late[1], /<a class="boot-reload" href="editor\/">/);
  assert.equal(late[1].replace(/<[^>]+>/g, ''), BOOT_LATE_TEXT);
  // Error reports first, then the boot screen, then the editor (which imports the same module).
  const at = (src) => HTML.indexOf(`<script type="module" src="${src}"></script>`);
  assert.ok(at('js/telemetry/boot.js') > 0 && at('js/telemetry/boot.js') < at('editor/js/boot.js') && at('editor/js/boot.js') < at('editor/editor.js'));
  assert.match(EDITOR_JS, /import \{ bootEditor, editorBoot, requestFirstFrame \} from '\.\/js\/boot\.js';/);
  // The old boot line is gone; the busy line for tile plans has no inline style.
  assert.doesNotMatch(HTML, /class="boot"/);
  assert.match(HTML, /<p id="busy" class="busy" hidden><span class="loading-spinner" aria-hidden="true"><\/span><span class="busy-text" role="status" aria-live="polite"><\/span><\/p>/);
});

test('the game\'s boot screen leaves a #boot with data-boot alone; the editor\'s takes it', async () => {
  const doc = installDom();
  const { root } = bootDom(doc);
  try {
    const game = await import(`../js/bootscreen.js?page=editor`);
    const editor = await import(`../editor/js/boot.js?page=editor`);
    assert.equal(game.bootScreen.root, null);
    assert.equal(game.bootScreen.state, 'gone');
    assert.equal(editor.editorBoot.root, root);
    assert.equal(lamps(root).files, 'active');
    assert.deepEqual(editor.editorBoot.steps, EDITOR_BOOT_STEPS);
  } finally {
    uninstallDom();
  }
});

// ---- Steps and leaving -----------------------------------------------------------------------

test('the steps light in order, and the screen goes only once the first frame is drawn', async () => {
  const { doc, root, status, screen } = setup();
  const { work, began, finish } = controlledWork();
  let tilesDone;
  work.tiles = () => new Promise((r) => (tilesDone = r));
  let started = false;
  const boot = bootEditor(screen, work).then((ok) => (started = ok));
  assert.equal(lamps(root).files, 'done', 'editor.js runs: its files are here');
  for (const id of ['engine', 'rules', 'graphics', 'content', 'map']) {
    await settle();
    assert.equal(began.at(-1), id);
    assert.equal(lamps(root)[id], 'active');
    assert.equal(status.textContent, `${EDITOR_BOOT_STEPS.find((s) => s.id === id).label}...`);
    finish[id]();
    await settle();
    assert.equal(lamps(root)[id], 'done');
  }
  await settle();
  assert.equal(lamps(root).editor, 'active', 'the editor is being built');
  assert.equal(root.hidden, false, 'every step but the first frame: still there');
  assert.ok(doc.body.classList.contains('is-booting'));
  finish.editor();
  await settle();
  // The first frame is drawn: the installed tiles get a little longer.
  assert.equal(lamps(root).tiles, 'active');
  assert.equal(status.textContent, 'Laying the terrain tiles...');
  assert.equal(root.hidden, false);
  tilesDone();
  await boot;
  assert.equal(started, true);
  assert.equal(root.hidden, true);
  assert.equal(doc.body.classList.contains('is-booting'), false);
  assert.ok(Object.values(lamps(root)).every((s) => s === 'done'));
  uninstallDom();
});

test('without installed tiles to plan the screen goes with the first frame; a slow plan gets BOOT_WAIT_MS', async () => {
  assert.deepEqual(EDITOR_BOOT_OPTIONAL, ['tiles']);
  {
    const { root, screen } = setup();
    const done = bootEditor(screen, { engine() {}, rules() {}, graphics() {}, content() {}, map() {}, editor() {}, tiles: () => null });
    assert.equal(await done, true);
    assert.equal(root.hidden, true);
    assert.equal(lamps(root).tiles, 'done', 'WebRA\'s tiles (or a pack\'s) are laid with the frame');
    uninstallDom();
  }
  {
    const { root, screen, timers } = setup();
    const done = bootEditor(screen, { engine() {}, rules() {}, graphics() {}, content() {}, map() {}, editor() {}, tiles: () => new Promise(() => {}) });
    for (let k = 0; k < 10; k++) await settle();
    assert.equal(root.hidden, false, 'waits for the plan');
    timers.run(BOOT_WAIT_MS);
    assert.equal(await done, true);
    assert.equal(root.hidden, true, 'the editor shows; the plan lands behind it');
    assert.equal(lamps(root).tiles, 'active');
    uninstallDom();
  }
});

test('the first frame: the next animation frame, or at once in a hidden tab (no wait that looks like a slow connection)', () => {
  const page = () => {
    const listeners = new Map();
    return {
      hidden: false,
      addEventListener: (t, fn) => listeners.set(t, fn),
      removeEventListener: (t) => listeners.delete(t),
      fire: (t) => listeners.get(t)?.(),
      listeners,
    };
  };
  const run = (doc) => {
    const frames = [];
    const rafs = [];
    const timers = [];
    requestFirstFrame((t) => frames.push(t), { doc, raf: (fn) => rafs.push(fn), later: (fn) => timers.push(fn), now: () => 7 });
    return { frames, rafs, timers };
  };
  // Shown: the animation frame draws it.
  let doc = page();
  let r = run(doc);
  assert.equal(r.timers.length, 0);
  r.rafs[0](16);
  assert.deepEqual(r.frames, [16]);
  assert.equal(doc.listeners.size, 0);
  // Hidden from the start: a timer draws it; the animation frame later does not draw it again.
  doc = page();
  doc.hidden = true;
  r = run(doc);
  r.timers[0]();
  r.rafs[0](99);
  assert.deepEqual(r.frames, [7]);
  // Hidden while waiting: the timer takes over.
  doc = page();
  r = run(doc);
  doc.hidden = true;
  doc.fire('visibilitychange');
  r.timers[0]();
  assert.deepEqual(r.frames, [7]);
  r.rafs[0](50);
  assert.deepEqual(r.frames, [7], 'once');
});

// ---- Errors -----------------------------------------------------------------------------------------

test('a failing step shows the error with Reload and stops the boot; it never hangs', async () => {
  for (const failing of ['engine', 'graphics', 'map', 'editor']) {
    const { root, screen, reloads } = setup();
    const { work, began, finish, fail } = controlledWork();
    work.tiles = () => assert.fail('no tiles after a failure');
    const error = console.error;
    console.error = () => {};
    try {
      const boot = bootEditor(screen, work);
      for (const id of ['engine', 'rules', 'graphics', 'content', 'map', 'editor']) {
        await settle();
        if (id === failing) {
          fail[id](new Error(`${id} broke`));
          break;
        }
        finish[id]();
      }
      assert.equal(await boot, false);
    } finally {
      console.error = error;
    }
    assert.equal(began.at(-1), failing, `${failing}: no step after it`);
    assert.equal(screen.states.get(failing), 'failed', 'its lamp');
    assert.ok(root.classList.contains('is-failed'));
    assert.equal(root.hidden, false, 'the screen stays with the error');
    assert.equal(screen.state, 'failed');
    assert.equal(textOf(root.querySelector('.loading-error')), `The map editor could not start: ${failing} broke`);
    assert.equal(root.querySelector('.loading-error').getAttribute('role'), 'alert');
    const reload = root.querySelector('button');
    assert.equal(textOf(reload), 'Reload');
    reload.dispatchEvent(new FakeEvent('click'));
    assert.equal(reloads.length, 1);
    uninstallDom();
  }
});

test('a step that throws at once is the boot\'s error too (the first frame throwing included)', async () => {
  const { root, screen } = setup();
  const error = console.error;
  console.error = () => {};
  try {
    const ok = await bootEditor(screen, {
      engine() {},
      rules() {},
      graphics() {},
      content() {},
      map() {},
      editor() {
        throw new Error('the frame threw');
      },
    });
    assert.equal(ok, false);
  } finally {
    console.error = error;
  }
  assert.match(textOf(root.querySelector('.loading-error')), /the frame threw/);
  // editor.js: the first frame resolves or rejects start's promise.
  assert.match(EDITOR_JS, /first\.reject\(err\)/);
  uninstallDom();
});

// ---- Busy laying tiles ---------------------------------------------------------------------------------

test('installed tiles say when they stand in for most of the map while a plan runs, and when no plan runs', async () => {
  const { InstalledTiles } = await import('../editor/js/tiles.js');
  let finish;
  const plans = [];
  const tiles = new InstalledTiles({ plan: (job) => (plans.push(job), new Promise((r) => (finish = r))) });
  const theater = { key: 'a', tileset: 'TEMPERAT', files: new Map() };
  const w = 20;
  const h = 20;
  const bytes = (water) => Uint8Array.from({ length: w * h * 4 }, (_, k) => (k % 4 === 0 ? (Math.floor(k / 4) % w < water ? TERRAIN.WATER : TERRAIN.CLEAR) : k % 4 === 3 ? 255 : 0));
  const result = (b) => ({ atlas: { data: new Uint8Array(4) }, cells: new Uint8Array(b.length).map((_, k) => (k % 4 === 0 ? b[k] : 0)) });
  await tiles.idle();
  // A map opened: no plan for it yet.
  assert.equal(tiles.tiles(theater, bytes(5), w, h), null);
  assert.equal(tiles.standIn, true);
  let idle = false;
  tiles.idle().then(() => (idle = true));
  finish(result(bytes(5)));
  await settleTicks();
  assert.equal(idle, true, 'idle once the plan is in');
  assert.ok(tiles.tiles(theater, bytes(5), w, h));
  assert.equal(tiles.standIn, false);
  // A small edit: a few cells stand in, not most of the map.
  tiles.tiles(theater, bytes(6), w, h);
  assert.equal(tiles.busy, true);
  assert.equal(tiles.standIn, false);
  finish(result(bytes(6)));
  await settleTicks();
  // Most of the map changed (another map of the same size): busy laying tiles.
  tiles.tiles(theater, bytes(18), w, h);
  assert.equal(tiles.standIn, true);
  finish(result(bytes(18)));
  await settleTicks();
  tiles.tiles(theater, bytes(18), w, h);
  assert.equal(tiles.standIn, false);
  assert.equal(plans.length, 3);
});

const settleTicks = () => new Promise((r) => setTimeout(r, 0));
