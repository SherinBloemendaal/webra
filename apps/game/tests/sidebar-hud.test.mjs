// The sidebar's parts of the 0.17 HUD (js/sidebar.js, the InGame board): the
// Fullscreen button, the lamps of the production tabs, the place for the
// signal bars next to the clock and the selection panel with the cameo, the
// types of a group and the control group number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeEvent, installDom, uninstallDom } from './dom-fixtures.mjs';
import { selectionGroup, selectionTypes, Sidebar } from '../js/sidebar.js';
import { UNAVAILABLE } from '../js/fullscreen.js';
import { openTooltip } from '../js/ui/tooltip.js';
import { quickTip } from '../js/quicktips.js';

const RULES = {
  lowPowerModifier: 100,
  actors: [
    { id: 'E1', name: 'Rifle Infantry', queue: 2, cost: 100, order: 1 },
    { id: 'FTRK', name: 'Mobile Flak', queue: 3, cost: 600, order: 2 },
  ],
};

function state(over = {}) {
  return {
    cash: 1000,
    resources: 0,
    storage: 0,
    powerGenerated: 100,
    powerUsed: 50,
    lowPower: false,
    tick: 0,
    queues: [[], [], [], [], [], []],
    hasProducer: [true, true, true, true, false, false],
    buildable: [],
    ...over,
  };
}

function make(callbacks = {}) {
  const doc = installDom();
  const root = doc.createElement('aside');
  doc.body.append(root);
  const sidebar = new Sidebar(root, {}, RULES, 0, { onMenu() {}, onMode() {}, onDeploy() {}, ...callbacks }, { ticksPerSecond: 25 });
  return { doc, root, sidebar };
}

test('selection types: by type, the most numerous first; the control group when the whole selection is one', () => {
  const info = { 1: { type: 'E1', owner: 0 }, 2: { type: 'FTRK', owner: 0 }, 3: { type: 'FTRK', owner: 0 }, 4: null, 5: { type: 'E1', owner: 0 }, 6: { type: 'FTRK', owner: 0 } };
  const names = { E1: 'Rifle Infantry', FTRK: 'Mobile Flak' };
  assert.deepEqual(selectionTypes([1, 2, 3, 4, 5, 6], (id) => info[id], (t) => names[t]), [
    { type: 'FTRK', owner: 0, name: 'Mobile Flak', count: 3 },
    { type: 'E1', owner: 0, name: 'Rifle Infantry', count: 2 },
  ]);
  assert.deepEqual(selectionTypes([4], (id) => info[id], (t) => names[t]), [], 'gone actors are left out');
  const groups = new Map([
    ['2', [2, 3]],
    ['5', [5, 6]],
  ]);
  assert.equal(selectionGroup([3, 2], groups), 2);
  assert.equal(selectionGroup([2], groups), 2, 'part of a group is that group');
  assert.equal(selectionGroup([2, 5], groups), null, 'two groups');
  assert.equal(selectionGroup([1], groups), null);
  assert.equal(selectionGroup([], groups), null);
  assert.equal(selectionGroup([2], new Map()), null);
});

test('selection panel: one type reads "3 × Mobile Flak", several list their types, and the group number shows', () => {
  const { root, sidebar } = make();
  // The fake canvas has no 2D context: the cameo painter says so once per type.
  const warn = console.warn;
  console.warn = () => {};
  try {
    const name = root.querySelector('.sb-sel-name');
    const types = root.querySelector('.sb-sel-types');
    const group = root.querySelector('.sb-sel-group');
    const cameo = root.querySelector('.sb-sel-cameo');
    sidebar.setSelection(null);
    assert.equal(name.textContent, 'No selection');
    assert.equal(group.hidden, true);
    assert.equal(cameo.hidden, true);
    sidebar.setSelection({ count: 3, name: '3 units selected', types: [{ type: 'FTRK', owner: 0, name: 'Mobile Flak', count: 3 }], group: 2 });
    assert.equal(name.textContent, '3 × Mobile Flak');
    assert.equal(types.hidden, true);
    assert.equal(group.textContent, 'Group 2');
    assert.equal(group.hidden, false);
    assert.equal(cameo.hidden, false, 'the cameo of the type');
    const many = [
      { type: 'FTRK', owner: 0, name: 'Mobile Flak', count: 3 },
      { type: 'E1', owner: 0, name: 'Rifle Infantry', count: 2 },
      { type: 'X', owner: 0, name: 'A', count: 1 },
      { type: 'Y', owner: 0, name: 'B', count: 1 },
    ];
    sidebar.setSelection({ count: 7, name: '7 units selected', types: many, group: null });
    assert.equal(name.textContent, '7 units selected');
    assert.equal(types.textContent, '3 × Mobile Flak, 2 × Rifle Infantry, 1 × A, +1 more');
    assert.equal(group.hidden, true);
    // One actor: its name, health and its group.
    sidebar.setSelection({ type: 'E1', name: 'Rifle Infantry', owner: 0, hp: 25, maxHp: 50, group: 4 });
    assert.equal(name.textContent, 'Rifle Infantry');
    assert.equal(types.hidden, true);
    assert.equal(root.querySelector('.sb-hp').hidden, false);
    assert.equal(group.textContent, 'Group 4');
  } finally {
    console.warn = warn;
    sidebar.dispose();
    uninstallDom();
  }
});

test('fullscreen button: pressed while fullscreen, dark with the reason where the page cannot', () => {
  const fs = { ok: true, on: false, toggles: 0 };
  const { root, sidebar } = make({ fullscreen: { available: () => fs.ok, active: () => fs.on, toggle: () => fs.toggles++ } });
  try {
    const b = root.querySelector('.sb-tool-fullscreen');
    assert.ok(b, 'in the top row');
    assert.equal(b.getAttribute('aria-label'), 'Fullscreen');
    assert.equal(b.disabled, false);
    b.click();
    assert.equal(fs.toggles, 1);
    fs.on = true;
    sidebar.update(state());
    assert.equal(b.getAttribute('aria-pressed'), 'true');
    assert.ok(b.classList.contains('active'));
    // The tooltip (focus opens it) follows the state.
    b.dispatchEvent(new FakeEvent('focus', { bubbles: false }));
    assert.ok(openTooltip()?.target === b, 'the Fullscreen tooltip is open');
    assert.equal(openTooltip().spec.desc, 'Leave fullscreen.');
    fs.ok = false;
    sidebar.update(state());
    assert.equal(b.disabled, true);
    assert.equal(b.getAttribute('aria-pressed'), 'false');
    // Dark: it names the reason (js/fullscreen.js UNAVAILABLE).
    assert.equal(openTooltip()?.spec.notes[0].text, UNAVAILABLE);
  } finally {
    sidebar.dispose();
    uninstallDom();
  }
  // Without the callback (tests, tools) there is no button.
  const bare = make();
  try {
    assert.equal(bare.root.querySelector('.sb-tool-fullscreen'), null);
  } finally {
    bare.sidebar.dispose();
    uninstallDom();
  }
});

test('production tabs: a white lamp on the open tab, a gold one and a gold edge where something is ready', () => {
  const { root, sidebar } = make();
  try {
    const tabs = root.querySelectorAll('.sb-tab');
    const lamp = (i) => tabs[i].querySelector('.sb-tab-led');
    assert.ok(lamp(0).classList.contains('ui-led-on'), 'Buildings is open');
    assert.ok(lamp(2).classList.contains('ui-led-off'));
    const queues = [[], [], [{ id: 'E1', count: 1, done: true, progress: 1 }], [], [], []];
    sidebar.update(state({ queues }));
    assert.ok(lamp(2).classList.contains('ui-led-warn'), 'Infantry has something ready');
    assert.ok(tabs[2].classList.contains('ready'));
    assert.equal(tabs[2].querySelector('.sb-tab-badge').textContent, '!', 'the word next to the lamp');
    sidebar.selectTab(3);
    assert.ok(lamp(3).classList.contains('ui-led-on'));
    assert.ok(lamp(0).classList.contains('ui-led-off'));
    assert.ok(lamp(2).classList.contains('ui-led-warn'), 'ready stays gold');
    // The signal bars' place next to the clock (js/netwarn.js fills it in online games).
    assert.ok(sidebar.netSlot.parentNode === root.querySelector('.sb-status-right'), 'next to the clock');
    assert.ok(root.querySelector('.sb-status-right .sb-clock-text')?.parentNode === sidebar.netSlot.parentNode, 'the clock beside it');
  } finally {
    sidebar.dispose();
    uninstallDom();
  }
});

test('cameo tooltips: the quick tip of the item while the Quick tips setting is on', () => {
  let on = true;
  const { sidebar } = make({ quickTips: () => on });
  try {
    sidebar.selectTab(2);
    sidebar.update(state({ buildable: [{ id: 'E1', queue: 2, enabled: true, requires: [], buildTicks: 100 }] }));
    assert.equal(sidebar.cardTip('E1').tip, quickTip('E1'));
    on = false;
    assert.equal(sidebar.cardTip('E1').tip, '', 'off: no line');
  } finally {
    sidebar.dispose();
    uninstallDom();
  }
});
