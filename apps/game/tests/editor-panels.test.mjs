// The map editor's side panels (editor/js/panels.js) and tool icons on a
// fake DOM: history steps and where they go, layer switches, the fairness
// table and its spreads, problems with quick fixes, stamps and the
// shortcuts list. No markup strings, no style attributes (the fake DOM
// throws on both, as the CSP refuses them).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, click, check, textOf, FakeNode } from './dom-fixtures.mjs';
import { LAYERS, FAIRNESS_COLUMNS, checkVerdict, problemEntries, fairnessView, historyList, keysList, layersList, problemsView, spread, stampsList } from '../editor/js/panels.js';
import { EDITOR_ICONS, editorIcon } from '../editor/js/icons.js';
import { COMMANDS, TOOLS, actionName } from '../editor/js/commands.js';
import { HotkeyRegistry, normalizeCombo } from '../js/hotkeys.js';
import { createSettings } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';

let doc;
beforeEach(() => {
  doc = installDom();
  // editor/js/ui.js el() tells nodes from text with instanceof Node.
  globalThis.Node = FakeNode;
});
afterEach(() => {
  delete globalThis.Node;
  uninstallDom();
});

test('history: oldest first, the current step marked, clicks go back or forward by the right count', () => {
  const went = [];
  const undo = [{ label: 'Paint terrain', time: 1 }, { label: 'Add spawn', time: 2 }];
  const redo = [{ label: 'Delete actors', time: 4 }, { label: 'Fill', time: 3 }];
  const list = historyList(undo, redo, (n) => went.push(n));
  const steps = list.querySelectorAll('.history-step');
  assert.deepEqual(steps.map((s) => textOf(s.querySelector('.history-label'))), ['Opened', 'Paint terrain', 'Add spawn', 'Fill', 'Delete actors']);
  assert.deepEqual(steps.map((s) => s.className.split(' ')[1]), ['past', 'past', 'current', 'future', 'future']);
  assert.equal(steps[2].querySelector('button').disabled, true, 'the current state is no step to go to');
  for (const s of steps) if (!s.querySelector('button').disabled) click(s.querySelector('button'));
  assert.deepEqual(went, [-2, -1, 1, 2]);
  const empty = historyList([], [], () => {});
  assert.equal(empty.querySelectorAll('.history-step')[0].className.includes('current'), true);
});

test('layers: one switch per layer, in order, telling which changed', () => {
  const changes = [];
  const root = layersList({ grid: true, zones: false }, (k, on) => changes.push([k, on]));
  const boxes = root.querySelectorAll('input');
  assert.equal(boxes.length, LAYERS.length);
  assert.equal(boxes[0].checked, true);
  check(boxes[LAYERS.findIndex((l) => l.key === 'zones')]);
  assert.deepEqual(changes, [['zones', true]]);
  assert.ok(LAYERS.every((l) => l.hint), 'every layer explains itself');
});

const REPORT = {
  reach: 14,
  bases: [
    { rush: 50, ore: 600, gems: 0, buildable: 700, zone: 2000 },
    { rush: 50, ore: 300, gems: 0, buildable: 690, zone: 2100 },
    { rush: null, ore: 610, gems: 6, buildable: 0, zone: 10 },
  ],
  unreachableSpawns: [2],
};

test('fairness: a row per start, spreads, unfair columns marked, cut-off starts named, rows jump', () => {
  assert.equal(spread(REPORT.bases, 'ore'), 610 / 300);
  assert.equal(spread(REPORT.bases, 'buildable'), Infinity, 'one start without any');
  assert.equal(spread([{ gems: 0 }, { gems: 0 }], 'gems'), 1);
  assert.equal(spread([{ rush: 3 }], 'rush'), null);
  const jumps = [];
  const view = fairnessView(REPORT, (k) => `rgb(${k},0,0)`, (k) => jumps.push(k));
  const rows = view.querySelectorAll('tbody tr');
  assert.equal(rows.length, 4, 'three starts and the spread');
  assert.equal(textOf(rows[2].querySelectorAll('td')[0]), 'none', 'no rush distance');
  const spreadCells = rows[3].querySelectorAll('td');
  assert.equal(spreadCells.length, FAIRNESS_COLUMNS.length);
  const ore = spreadCells[FAIRNESS_COLUMNS.findIndex((c) => c.key === 'ore')];
  assert.equal(ore.className, 'unfair');
  assert.equal(textOf(ore), 'x2.03');
  assert.match(textOf(view), /Cut off by ground from spawn 1: 3\./);
  click(rows[1].querySelector('button'));
  assert.deepEqual(jumps, [1]);
  assert.match(textOf(fairnessView({ bases: [] }, () => '', () => {})), /Place spawns/);
});

test('problems: fixes as buttons, located ones jump, engine errors without a fix listed once', () => {
  const fixed = [];
  const jumps = [];
  const fixes = [{ key: 'a', level: 'error', message: 'Spawn 1 needs 3x4 clear ground for the construction yard.', x: 4, y: 5, fixes: [{ label: 'Clear the ground' }, { label: 'Move' }] }];
  const engine = { ok: false, errors: ['Spawn 1 needs 3x4 clear ground for the construction yard.', 'a map needs 2 to 8 spawn points'] };
  const issues = [{ level: 'warning', message: 'Spawns 1 and 2 are very close.', x: 9, y: 9 }, { level: 'error', message: 'unlocated js error' }];
  const view = problemsView({ engine, issues, fixes }, (p, f) => fixed.push(f.label), (x, y) => jumps.push([x, y]));
  const items = view.querySelectorAll('li');
  assert.deepEqual(items.map((li) => textOf(li.querySelector('.issue-text'))), [fixes[0].message, 'a map needs 2 to 8 spawn points', 'Spawns 1 and 2 are very close.']);
  click(items[0].querySelector('button.fix'));
  click(items[0].querySelector('button.link'));
  click(items[2].querySelector('button.link'));
  assert.deepEqual(fixed, ['Clear the ground']);
  assert.deepEqual(jumps, [[4, 5], [9, 9]]);
});

test('stamps: use, rename, delete; a hint without any', () => {
  const calls = [];
  const list = stampsList([{ name: 'Base', region: { w: 10, h: 8 } }, { name: 'Bridge', region: { w: 6, h: 3 } }], {
    onUse: (k) => calls.push(['use', k]),
    onRename: (k) => calls.push(['rename', k]),
    onDelete: (k) => calls.push(['delete', k]),
  });
  const items = list.querySelectorAll('li');
  assert.match(textOf(items[1]), /Bridge 6 x 3/);
  for (const b of items[1].querySelectorAll('button')) click(b);
  assert.deepEqual(calls, [['use', 1], ['rename', 1], ['delete', 1]]);
  assert.match(textOf(stampsList([], {})), /No stamps yet/);
});

test('tools and commands: one default key each at most, no two the same, all valid for the hotkey registry', () => {
  const keys = new Map();
  for (const t of TOOLS) if (t.key) keys.set(normalizeCombo(t.key), [...(keys.get(normalizeCombo(t.key)) ?? []), `tool ${t.id}`]);
  for (const c of COMMANDS) for (const k of c.keys) keys.set(normalizeCombo(k), [...(keys.get(normalizeCombo(k)) ?? []), c.name]);
  for (const [k, who] of keys) {
    assert.ok(k, `bad key for ${who}`);
    assert.equal(who.length, 1, `${k} is the default of ${who.join(' and ')}`);
  }
  for (const k of '1234567890') assert.ok(!keys.has(k), `${k} is a terrain key`);
  for (const t of TOOLS) assert.ok(EDITOR_ICONS[t.icon], `icon for ${t.id}`);
  const icon = editorIcon('brush', doc);
  assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.throws(() => editorIcon('nope', doc), /unknown editor icon/);
});

test('shortcuts list: groups, keys shown, rebinding and defaults through the game registry', () => {
  const settings = createSettings(createRegistry({ storage: null }));
  const reg = new HotkeyRegistry(settings);
  let ran = 0;
  reg.registerAction(actionName('tool.brush'), ['B'], () => ran++, { label: 'Brush', group: 'Map editor: Tools', context: 'editor' });
  reg.registerAction(actionName('undo'), ['Ctrl+Z'], () => {}, { label: 'Undo', group: 'Map editor: Edit', context: 'editor' });
  const calls = [];
  const render = (listening) => keysList(reg.list(), { listening, mac: false, onRebind: (n) => calls.push(['rebind', n]), onReset: (n) => calls.push(['reset', n]) });
  let view = render(null);
  assert.deepEqual(view.querySelectorAll('h2').map(textOf), ['Map editor: Tools', 'Map editor: Edit']);
  assert.deepEqual(view.querySelectorAll('.key-bind').map(textOf), ['B', 'Ctrl+Z']);
  click(view.querySelectorAll('.key-bind')[0]);
  click(view.querySelectorAll('button.link')[0]);
  assert.deepEqual(calls, [['rebind', 'editor.tool.brush'], ['reset', 'editor.tool.brush']]);
  view = render('editor.tool.brush');
  assert.equal(textOf(view.querySelectorAll('.key-bind')[0]), 'Press a key...');
  // Rebinding is kept in the game's hotkey setting.
  assert.deepEqual(reg.rebind('editor.tool.brush', 'K'), { ok: true, displaced: null });
  assert.deepEqual(settings.get('hotkeys')['editor.tool.brush'], ['K']);
  assert.equal(reg.resolve('K'), 'editor.tool.brush');
  reg.run('editor.tool.brush');
  assert.equal(ran, 1);
});

test('keys: a select list, a stepper and tabs keep their keys from the editor shortcuts and capture handlers', async () => {
  const { controlOwnsKeys, isTyping } = await import('../editor/js/view.js');
  const { selectPlate, stepper, tabs } = await import('../js/ui/controls.js');
  const plate = selectPlate({ label: 'Symmetry', options: [{ value: 'none', label: 'None' }, { value: 'x', label: 'Mirror' }], value: 'none' });
  const step = stepper({ label: 'Size', values: [1, 2, 3], value: 2 });
  const tablist = tabs({ label: 'Panels', tabs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  const plain = document.createElement('button');
  document.body.append(plate.root, step.root, tablist.root, plain);
  const key = (target) => ({ target, key: 'Escape' });
  assert.equal(controlOwnsKeys(key(plate.listbox)), true, 'the open list');
  assert.equal(controlOwnsKeys(key(plate.listbox.querySelector('[role="option"]'))), true, 'an option in it');
  assert.equal(controlOwnsKeys(key(step.field)), true, 'the stepper');
  assert.equal(controlOwnsKeys(key(tablist.buttons[0] ?? tablist.root.querySelector('[role="tab"]'))), true, 'a tab');
  assert.equal(controlOwnsKeys(key(plain)), false, 'a plain button does not');
  // The plate's button takes letters (typeahead) and arrows like a native select: shortcuts wait.
  const saved = ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement'].map((n) => [n, globalThis[n]]);
  for (const [n] of saved) globalThis[n] ??= class {};
  try {
    assert.equal(isTyping(key(plate.button)), true);
    assert.equal(isTyping(key(plate.listbox)), true);
    assert.equal(isTyping(key(step.field)), true, 'arrows step the stepper, not the map');
    assert.equal(isTyping(key(tablist.buttons[0] ?? tablist.root.querySelector('[role="tab"]'))), false, 'tool keys work after a tab is clicked');
    assert.equal(isTyping(key(plain)), false);
  } finally {
    for (const [n, v] of saved) if (v === undefined) delete globalThis[n];
  }
});

test('check verdict: errors first, then warnings and fixable problems, else valid; counted as the Check tab lists them', () => {
  const none = { engine: { ok: true, errors: [] }, issues: [], fixes: [] };
  assert.deepEqual(checkVerdict(none), { kind: 'ok', count: 0, text: 'Valid', title: 'Valid map: ready to test play and publish.' });
  const warn = { engine: { ok: true, errors: [] }, issues: [{ level: 'warning', message: 'Spawns 1 and 2 are very close.', x: 1, y: 1 }, { level: 'warning', message: 'Little ore.' }], fixes: [] };
  assert.deepEqual([checkVerdict(warn).kind, checkVerdict(warn).count, checkVerdict(warn).text], ['warn', 2, '2 warnings']);
  // A fix covers the engine error with the same message: listed (and counted) once.
  const msg = 'Spawn 1 needs 3x4 clear ground for the construction yard.';
  const bad = { engine: { ok: false, errors: [msg, 'a map needs 2 to 8 spawn points'] }, issues: [{ level: 'warning', message: 'Little ore.' }], fixes: [{ level: 'error', message: msg, x: 1, y: 2, fixes: [{ label: 'Move' }] }] };
  assert.equal(problemEntries(bad).length, 3);
  assert.deepEqual([checkVerdict(bad).kind, checkVerdict(bad).text], ['bad', '2 errors']);
  assert.match(checkVerdict(bad).title, /fix before test play/);
  // An editor error while the engine accepts the map is a warning.
  const soft = { engine: { ok: true, errors: [] }, issues: [{ level: 'error', message: 'Actor off the map.', x: 0, y: 0 }], fixes: [] };
  assert.deepEqual([checkVerdict(soft).kind, checkVerdict(soft).text], ['warn', '1 warning']);
  // The engine refusing without a message still counts one error.
  assert.equal(checkVerdict({ engine: { ok: false, errors: [] }, issues: [], fixes: [] }).text, '1 error');
});
