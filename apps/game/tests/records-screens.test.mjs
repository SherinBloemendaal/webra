// Load game, Replays and the replay bar (js/records.js), with the parts they
// use: the seek bar's marks (js/replaymarks.js), save pictures
// (js/savethumb.js), the replay list lines (js/account/replays.js) and the
// keys the controls keep (js/ownkeys.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, FakeEvent, installDom, settle, textOf, uninstallDom } from './dom-fixtures.mjs';
import { BATTLE_LOSSES, BATTLE_WINDOW, MAX_GAP, ReplayMarks } from '../js/replaymarks.js';
import { encodeThumb, THUMB_BOX, thumbSize } from '../js/savethumb.js';
import { THUMB_MAX_CHARS, validThumb } from '../js/saves.js';
import { replayFacts, replayMeta, usageShare } from '../js/account/replays.js';
import { controlOwnsKey } from '../js/ownkeys.js';

const player = (n, o = {}) => ({ player: n, unitsLost: 0, buildingsLost: 0, defeated: false, defeatedAt: null, ...o });

// ---- Seek bar marks -------------------------------------------------------------------

test('replay marks: defeats at their tick, destroyed structures, heavy fighting; seeks count nothing', () => {
  const m = new ReplayMarks(10000);
  let units = 0;
  const frame = (tick, o = {}) => m.observe([player(0, { unitsLost: units, ...o }), player(1)], tick);
  frame(0);
  assert.equal(frame(25), false, 'nothing happened');
  // A structure lost between two frames.
  assert.equal(frame(50, { buildingsLost: 1 }), true);
  assert.deepEqual(m.marks, [{ tick: 50, kind: 'building' }]);
  // Units lost one by one: heavy fighting once BATTLE_LOSSES fall within the window.
  let t = 1000;
  // After a jump the next frame only sets the baseline.
  frame(t, { buildingsLost: 1 });
  for (let i = 0; i < BATTLE_LOSSES; i++) {
    units++;
    t += 20;
    frame(t, { buildingsLost: 1 });
  }
  assert.deepEqual(m.marks.at(-1), { tick: t, kind: 'battle' });
  // Spread out over more than the window: no mark.
  const before = m.marks.length;
  for (let i = 0; i < BATTLE_LOSSES; i++) {
    units++;
    t += BATTLE_WINDOW / 2;
    frame(t, { buildingsLost: 1 });
  }
  assert.equal(m.marks.length, before);
  // A seek forward re-simulates many ticks in one frame: its losses are no mark.
  units += 50;
  assert.equal(frame(t + MAX_GAP + 1, { buildingsLost: 9 }), false);
  // A defeat is marked at the engine's tick, also after a jump.
  assert.equal(m.observe([player(0), player(1, { defeated: true, defeatedAt: 7000 })], 9000), true);
  assert.ok(m.marks.some((x) => x.kind === 'defeat' && x.tick === 7000));
  assert.equal(m.observe([player(0), player(1, { defeated: true, defeatedAt: 7000 })], 9025), false, 'once');
  // Watching an earlier part again adds nothing.
  const count = m.marks.length;
  m.observe([player(0, { buildingsLost: 0 })], 100);
  m.observe([player(0, { buildingsLost: 5 })], 125);
  assert.equal(m.marks.length, count);
});

test('replay marks: a short seek forward counts its skipped ticks as not watched', async () => {
  const m = new ReplayMarks(10000);
  m.observe([player(0)], 1000);
  m.jump();
  assert.equal(m.observe([player(0, { buildingsLost: 3 })], 1025), false, 'the 25 ticks skipped by one keyboard step');
  assert.equal(m.observe([player(0, { buildingsLost: 4 })], 1050), true, 'then it counts again');
  // The bar: a seek it sees (keyboard step on the seek bar) resets the baseline before the next frame.
  installDom();
  try {
    const { ReplayBar } = await import('../js/records.js');
    const c = { ticks: 2000, length: 10000, playing: true, speed: 1, ended: false, seeking: false, target: null, diverged: null, setSpeed() {}, togglePlay() {}, seek(t) { c.seeking = true; c.target = t; } };
    const bar = new ReplayBar(document.createElement('div'), c);
    bar.observe([player(0)], 2000);
    bar.seek.value = '2025';
    bar.seek.dispatchEvent(new FakeEvent('change'));
    // The seek is done by the next frame.
    c.seeking = false;
    c.ticks = 2025;
    bar.observe([player(0, { buildingsLost: 2 })], 2025);
    assert.equal(bar.marks.marks.length, 0);
  } finally {
    uninstallDom();
  }
});

test('replay marks: close marks merge, the more important kind wins', () => {
  const m = new ReplayMarks(10000);
  assert.equal(m.add('battle', 500), true);
  assert.equal(m.add('building', 550), true, 'within 1 %: the structure wins');
  assert.deepEqual(m.marks, [{ tick: 500, kind: 'building' }]);
  assert.equal(m.add('battle', 520), false);
  assert.equal(m.add('defeat', 480), true);
  assert.deepEqual(m.marks, [{ tick: 500, kind: 'defeat' }]);
  m.add('battle', 3000);
  assert.deepEqual(m.marks.map((x) => x.tick), [500, 3000]);
  assert.equal(m.at(m.marks[1]), 0.3);
});

// ---- Save pictures --------------------------------------------------------------------

test('save pictures: the map\'s shape in the box, the first format that fits, only image data URLs kept', () => {
  assert.deepEqual(thumbSize(128, 128), { width: THUMB_BOX.height, height: THUMB_BOX.height });
  assert.deepEqual(thumbSize(256, 64), { width: THUMB_BOX.width, height: 36 });
  assert.deepEqual(thumbSize(40, 30), { width: 40, height: 30 }, 'never larger than the map');
  const canvas = (sizes) => ({ toDataURL: (type) => `data:${type};base64,${'A'.repeat(sizes[type] ?? 10)}` });
  assert.match(encodeThumb(canvas({ 'image/png': 100 })), /^data:image\/png;/);
  assert.match(encodeThumb(canvas({ 'image/png': THUMB_MAX_CHARS })), /^data:image\/webp;/, 'too large as PNG');
  // A browser without WebP answers with PNG: the next format is tried.
  const noWebp = { toDataURL: (type) => (type === 'image/jpeg' ? 'data:image/jpeg;base64,AAAA' : `data:image/png;base64,${'A'.repeat(THUMB_MAX_CHARS)}`) };
  assert.match(encodeThumb(noWebp), /^data:image\/jpeg;/);
  assert.equal(encodeThumb({ toDataURL: () => `data:image/png;base64,${'A'.repeat(THUMB_MAX_CHARS)}` }), null);
  assert.equal(encodeThumb({ toDataURL: () => { throw new Error('tainted'); } }), null);
  assert.equal(validThumb('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(validThumb('data:image/svg+xml;base64,AAAA'), null);
  assert.equal(validThumb(`data:image/png;base64,${'A'.repeat(THUMB_MAX_CHARS)}`), null);
  assert.equal(validThumb(null), null);
});

// ---- Lines of the lists ---------------------------------------------------------------

const REPLAY = {
  id: '0'.repeat(16),
  title: 'Skirmish on Tiny',
  mode: 'online',
  mapName: 'Tiny',
  players: [{ name: 'Tanya', type: 'human' }, { name: null, type: 'ai' }],
  playedAt: Date.UTC(2026, 9, 12, 20, 0),
  ticks: 25 * 75,
  result: 'won',
  size: 2048,
  expiresAt: Date.UTC(2026, 9, 15, 12, 0),
  engine: '0.17.0',
};

test('replay lines: the row\'s line, the facts of the chosen one and the storage share', async () => {
  assert.equal(replayMeta(REPLAY), 'Online · Tiny · Tanya and 1 AI');
  const facts = Object.fromEntries(replayFacts(REPLAY, Date.UTC(2026, 9, 13, 12, 0)));
  assert.equal(facts.Length, '1:15');
  assert.equal(facts.Players, 'Tanya and 1 AI');
  assert.equal(facts.Result, 'Won');
  assert.equal(facts.Size, '2 KB');
  assert.equal(facts.Kept, '2 days left');
  assert.equal(facts.Version, '0.17.0');
  assert.equal(usageShare({ count: 10, bytes: 0 }, { count: 100, bytes: 100 }), 0.1);
  assert.equal(usageShare({ count: 10, bytes: 90 }, { count: 100, bytes: 100 }), 0.9, 'the fuller of the two');
  assert.equal(usageShare({ count: 500, bytes: 0 }, { count: 100, bytes: 100 }), 1);
  const { shortDate, saveMeta, saveFacts, playerCount } = await import('../js/records.js');
  const now = new Date(2026, 9, 15, 22, 0).getTime();
  assert.equal(shortDate(new Date(2026, 9, 15, 9, 5).getTime(), now), 'today 09:05');
  assert.equal(shortDate(new Date(2026, 9, 14, 23, 59).getTime(), now), 'yesterday');
  assert.equal(shortDate(new Date(2026, 9, 12, 12, 0).getTime(), now), '12 Oct');
  assert.equal(shortDate(new Date(2025, 0, 3, 12, 0).getTime(), now), '3 Jan 2025');
  assert.equal(playerCount([{}]), '1 player');
  const skirmish = { mode: 'skirmish', ticks: 25 * 768, createdAt: now, engine: '0.17.0', summary: { mapName: 'Ore Lord', players: [{ name: 'Tanya', type: 'human' }, { name: null, type: 'ai' }, { name: null, type: 'ai' }, { name: 'Boris', type: 'human' }], mission: null } };
  assert.equal(saveMeta(skirmish), 'Skirmish · Ore Lord · 4 players');
  const mission = { mode: 'mission', ticks: 100, createdAt: now, engine: '0.17.0', summary: { mapName: 'allies-05a', players: [], mission: { id: 'allies-05a', difficulty: 'hard' } } };
  assert.equal(saveMeta(mission, "05a: Tanya's Tale"), "Mission · 05a: Tanya's Tale · Hard");
  assert.equal(saveMeta(mission), 'Mission · allies-05a · Hard', 'the id until the title is known');
  assert.equal(saveMeta({ mode: 'skirmish' }), 'Skirmish', 'an older save: the mode only');
  const f = Object.fromEntries(saveFacts(skirmish));
  assert.equal(f.Map, 'Ore Lord');
  assert.equal(f['Game time'], '12:48');
  assert.equal(f.Players, 'Tanya, Boris and 2 AIs');
  assert.equal(Object.fromEntries(saveFacts(mission, 'Tanya')).Mission, 'Tanya');
});

// ---- Load game ------------------------------------------------------------------------

const save = (id, o = {}) => ({ id, title: `Save ${id}`, createdAt: 1000 + id, ticks: 250, engine: 'test', mode: 'skirmish', online: null, bytes: 10, summary: { mapName: 'Ore Lord', players: [], mission: null }, thumb: null, ...o });

test('Load game: tabs, rows with pictures, the chosen save\'s details, Load and a Delete that asks first', async () => {
  const doc = installDom();
  try {
    const { mountRecordEntries } = await import('../js/records.js');
    const rows = [
      save(1, { thumb: 'data:image/png;base64,AAAA' }),
      save(2, { mode: 'mission', summary: { mapName: 'allies-01', players: [], mission: { id: 'allies-01', difficulty: 'easy' } } }),
      save(3, { mode: 'online', online: 'a'.repeat(16) }),
      save(4, { engine: 'old', summary: undefined }),
    ];
    const removed = [];
    const loaded = [];
    const store = {
      list: async () => rows.filter((r) => !removed.includes(r.id)).map((r) => ({ ...r })).sort((a, b) => b.createdAt - a.createdAt),
      load: async (id) => ({ ok: true, replay: { kind: 'save', mode: rows.find((r) => r.id === id).mode, id } }),
      remove: async (id) => removed.push(id),
    };
    const root = doc.createElement('div');
    doc.body.append(root);
    mountRecordEntries(root, {
      version: 'test',
      canPlay: () => true,
      showError: (m) => assert.fail(m),
      onLoadSave: (r) => loaded.push(r.id),
      onWatchReplay() {},
      store,
      missionTitle: async (id) => (id === 'allies-01' ? '01: In the Thick of It' : null),
    });
    click([...root.querySelectorAll('button')].find((b) => b.textContent === 'Load game'));
    await settle(20);
    const dialog = doc.body.querySelector('dialog');
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    assert.deepEqual(tabs.map((t) => textOf(t)), ['In this browser', 'Online saves', 'From file']);
    const panels = [...dialog.querySelectorAll('[role="tabpanel"]')];
    assert.deepEqual(panels.map((p) => p.hidden), [false, true, true]);
    const list = [...panels[0].querySelectorAll('.records-row')];
    assert.deepEqual(list.map((r) => r.querySelector('strong').textContent), ['Save 4', 'Save 2', 'Save 1'], 'newest first; online saves in their own tab');
    assert.equal(list[2].querySelector('img').getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.ok(list[0].querySelector('.records-thumb-none'), 'an older save has no picture');
    assert.match(textOf(list[0]), /WebRA old/);
    assert.match(textOf(list[1]), /Mission · 01: In the Thick of It · Easy/);
    assert.match(textOf(list[2]), /Skirmish · Ore Lord/);
    // The newest is chosen; arrows move through the rows.
    assert.equal(list[0].getAttribute('aria-current'), 'true');
    const detail = () => panels[0].querySelector('.records-detail');
    assert.match(textOf(detail()), /Made with WebRA old/);
    list[0].dispatchEvent(new FakeEvent('keydown', { key: 'ArrowDown' }));
    assert.equal(list[1].getAttribute('aria-current'), 'true');
    assert.match(textOf(detail()), /Mission01: In the Thick of It/);
    // Delete asks first; Keep keeps it.
    click(detail().querySelector('.records-delete-ask'));
    assert.match(textOf(detail()), /Delete this save\?/);
    click([...detail().querySelectorAll('button')].find((b) => b.textContent === 'Keep'));
    assert.deepEqual(removed, []);
    click(detail().querySelector('.records-delete-ask'));
    click(detail().querySelector('.records-delete-confirm'));
    await settle(20);
    assert.deepEqual(removed, [2]);
    assert.equal(panels[0].querySelectorAll('.records-row').length, 2);
    // Online saves: listed, never loaded here.
    click(tabs[1]);
    assert.equal(panels[1].hidden, false);
    assert.equal(panels[1].querySelectorAll('.records-row').length, 1);
    assert.equal(panels[1].querySelector('.records-main-action'), null, 'no Load for an online save');
    click(tabs[0]);
    click([...panels[0].querySelectorAll('.records-row')].find((r) => r.textContent.includes('Save 1')));
    click(detail().querySelector('.records-main-action'));
    await settle(20);
    assert.deepEqual(loaded, [1]);
    assert.equal(doc.body.querySelector('dialog'), null, 'the screen closed');
  } finally {
    uninstallDom();
  }
});

test('Load game: a delete runs once, a failed one says why, focus goes to the next row; bad pictures are not shown', async () => {
  const doc = installDom();
  try {
    const { mountRecordEntries } = await import('../js/records.js');
    const rows = [save(1), save(2), save(3, { thumb: 'data:image/svg+xml;base64,AAAA' })];
    const removed = [];
    let fail = true;
    let release;
    const store = {
      list: async () => rows.filter((r) => !removed.includes(r.id)).map((r) => ({ ...r })).sort((a, b) => b.createdAt - a.createdAt),
      load: async () => ({ ok: false, error: 'no' }),
      remove: async (id) => {
        if (fail) throw new Error('blocked storage');
        await new Promise((r) => (release = r));
        removed.push(id);
      },
    };
    const root = doc.createElement('div');
    mountRecordEntries(root, { version: 'test', canPlay: () => true, showError: () => {}, onLoadSave() {}, onWatchReplay() {}, store });
    click([...root.querySelectorAll('button')].find((b) => b.textContent === 'Load game'));
    await settle(20);
    const dialog = doc.body.querySelector('dialog');
    const list = () => dialog.querySelectorAll('[role="tabpanel"]')[0].querySelectorAll('.records-row');
    assert.equal(list()[0].querySelector('img'), null, 'an SVG picture is never drawn');
    assert.ok(list()[0].querySelector('.records-thumb-none'));
    const detail = () => dialog.querySelector('.records-detail');
    // Failing storage: a message, and the question stays.
    click(detail().querySelector('.records-delete-ask'));
    click(detail().querySelector('.records-delete-confirm'));
    await settle(10);
    assert.match(textOf(dialog.querySelector('.records-status')), /could not be deleted: blocked storage/);
    assert.ok(detail().querySelector('.records-delete-confirm'));
    // A delete under way: the button waits, a second click deletes nothing more.
    fail = false;
    const yes = detail().querySelector('.records-delete-confirm');
    click(yes);
    assert.equal(yes.disabled, true);
    click(yes);
    release();
    await settle(20);
    assert.deepEqual(removed, [3]);
    // The next row is chosen and has the focus.
    assert.equal(list().length, 2);
    assert.equal(list()[0].getAttribute('aria-current'), 'true');
    assert.equal(doc.activeElement, list()[0]);
  } finally {
    uninstallDom();
  }
});

test('Replays: the account\'s storage as a bar, and an empty list says how replays get there', async () => {
  const doc = installDom();
  try {
    const { mountRecordEntries } = await import('../js/records.js');
    const api = { replays: async () => ({ replays: [], usage: { count: 95, bytes: 1024 }, limits: { count: 100, bytes: 100 * 1024 * 1024, retentionMs: 30 * 86400000 } }) };
    const root = doc.createElement('div');
    mountRecordEntries(root, { version: 'test', canPlay: () => true, showError: () => {}, onLoadSave() {}, onWatchReplay() {}, store: { list: async () => [] }, accountReplays: { available: () => true, api } });
    click([...root.querySelectorAll('button')].find((b) => b.textContent === 'Replays'));
    await settle(20);
    const dialog = doc.body.querySelector('dialog');
    const bar = dialog.querySelector('.records-usage-bar');
    assert.equal(bar.getAttribute('role'), 'progressbar');
    assert.equal(bar.getAttribute('aria-valuenow'), '95');
    assert.ok(bar.classList.contains('records-usage-full'));
    assert.match(textOf(dialog), /95 of 100 replays/);
    assert.match(textOf(dialog), /kept for 30 days/);
    assert.match(textOf(dialog), /No replays in your account yet/);
    assert.equal(dialog.querySelector('.records-detail').hidden, true);
    assert.deepEqual([...dialog.querySelectorAll('[role="tab"]')].map((t) => textOf(t)), ['Your account', 'From file']);
  } finally {
    uninstallDom();
  }
});

// ---- The replay bar ------------------------------------------------------------------

test('the replay bar: play, speeds with lamps, the seek bar\'s marks, Download and Exit', async () => {
  const doc = installDom();
  try {
    const { ReplayBar } = await import('../js/records.js');
    const calls = [];
    const c = { ticks: 0, length: 10000, playing: true, speed: 1, ended: false, seeking: false, target: null, diverged: null, setSpeed: (s) => calls.push(['speed', s]), togglePlay: () => calls.push(['toggle']), seek: (t) => calls.push(['seek', t]) };
    const field = doc.createElement('div');
    const bar = new ReplayBar(field, c, { onDownload: () => calls.push(['download']), onExit: () => calls.push(['exit']) });
    assert.equal(bar.play.getAttribute('aria-label'), 'Pause');
    assert.equal(bar.playIcon.dataset.icon, 'pause');
    c.playing = false;
    bar.update();
    assert.equal(bar.play.getAttribute('aria-label'), 'Play');
    c.ended = true;
    bar.update();
    assert.equal(bar.play.getAttribute('aria-label'), 'Restart');
    const speeds = field.querySelectorAll('.replay-speed');
    assert.equal(speeds[1].getAttribute('aria-pressed'), 'true');
    assert.ok(speeds[1].querySelector('.ui-led').classList.contains('ui-led-on'));
    click(speeds[3]);
    assert.deepEqual(calls.at(-1), ['speed', 4]);
    c.ticks = 2500;
    bar.update();
    assert.equal(bar.time.textContent, '1:40');
    assert.equal(bar.seek.getAttribute('aria-valuetext'), '1:40 of 6:40');
    // Marks: drawn where they happened, and said in words for screen readers.
    bar.observe([player(0)], 2500);
    bar.observe([player(0, { buildingsLost: 1 })], 2525);
    const marks = field.querySelectorAll('.replay-mark');
    assert.equal(marks.length, 1);
    assert.ok(marks[0].classList.contains('replay-mark-building'));
    assert.match(textOf(field.querySelector(`#${bar.seek.getAttribute('aria-describedby')}`)), /1:41 a structure was destroyed/);
    // Not while a seek re-simulates.
    c.seeking = true;
    bar.observe([player(0, { buildingsLost: 2 })], 2550);
    assert.equal(field.querySelectorAll('.replay-mark').length, 1);
    click(field.querySelector('.replay-download'));
    click(field.querySelector('.replay-exit'));
    assert.deepEqual(calls.slice(-2), [['download'], ['exit']]);
    // Without them (a test, a spectator view), no buttons.
    const plain = doc.createElement('div');
    new ReplayBar(plain, c);
    assert.equal(plain.querySelector('.replay-download'), null);
    assert.equal(plain.querySelector('.replay-exit'), null);
  } finally {
    uninstallDom();
  }
});

// ---- Esc the controls keep -------------------------------------------------------------

test('an open select list keeps Esc from the screens; tab rows and steppers do not', () => {
  const doc = installDom();
  try {
    const wrap = (role) => {
      const outer = doc.createElement('div');
      if (role) outer.setAttribute('role', role);
      const inner = doc.createElement('button');
      outer.append(inner);
      doc.body.append(outer);
      return inner;
    };
    assert.equal(controlOwnsKey(wrap('listbox')), true);
    assert.equal(controlOwnsKey(wrap('spinbutton')), false, 'Esc on a stepper closes the screen');
    assert.equal(controlOwnsKey(wrap('tablist')), false, 'Esc on a tab closes the screen');
    assert.equal(controlOwnsKey(wrap(null)), false);
    const panel = doc.createElement('div');
    panel.className = 'ui-sp-panel';
    const inside = doc.createElement('span');
    panel.append(inside);
    assert.equal(controlOwnsKey(inside), true);
    assert.equal(controlOwnsKey(null), false);
  } finally {
    uninstallDom();
  }
});
