// The shared themed controls (js/ui/controls.js, css/controls.css): accessible
// markup, aria-checked kept in step, labels wired, keyboard-operable parts, and
// the CSP rules (no inline styles, no HTML strings), on the fake DOM.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom, uninstallDom, FakeEvent, check, click, textOf, strayValues } from './dom-fixtures.mjs';
import {
  switchInput,
  checkInput,
  toggle,
  checkbox,
  segmented,
  slider,
  styleSlider,
  syncSliderFill,
  selectPlate,
  selectRow,
  selectSheetMode,
  stepper,
  tabs,
  badge,
  badgeKind,
  led,
  setLed,
  BADGE_KINDS,
  BADGE_ALIASES,
  LED_STATES,
  TYPEAHEAD_MS,
} from '../js/ui/controls.js';

let doc;
beforeEach(() => {
  doc = installDom();
});
afterEach(() => uninstallDom());

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('switch: a real checkbox with role switch, aria-checked follows events and code', () => {
  const seen = [];
  const t = toggle({ id: 'fx', label: 'Effects', onChange: (on) => seen.push(on) });
  const input = t.input;
  assert.equal(input.localName, 'input');
  assert.equal(input.getAttribute('type'), 'checkbox');
  assert.equal(input.getAttribute('role'), 'switch');
  assert.equal(input.getAttribute('aria-checked'), 'false');
  assert.equal(input.hasAttribute('tabindex'), false, 'in the tab order, operated by Space like any checkbox');
  assert.ok(input.classList.contains('ui-switch'));

  check(input, true);
  assert.equal(input.getAttribute('aria-checked'), 'true');
  check(input, false);
  assert.equal(input.getAttribute('aria-checked'), 'false');
  assert.deepEqual(seen, [true, false]);

  // Code that sets the property (no event) keeps the attribute honest too.
  input.checked = true;
  assert.equal(input.getAttribute('aria-checked'), 'true');
  t.set(false);
  assert.equal(input.getAttribute('aria-checked'), 'false');
  assert.equal(t.get(), false);
});

test('switch: starts in the state it is given, can be disabled, small variant', () => {
  const on = switchInput({ checked: true });
  assert.equal(on.getAttribute('aria-checked'), 'true');
  assert.equal(on.checked, true);
  const off = switchInput({ disabled: true, small: true, label: 'Speech' });
  assert.equal(off.disabled, true);
  assert.equal(off.getAttribute('aria-label'), 'Speech');
  assert.ok(off.classList.contains('ui-sm'));
});

test('toggle row: label is tied to the switch (for / id) and hints are described', () => {
  const t = toggle({ id: 'wx', label: 'Weather', hint: 'Cosmetic only.', rowClass: 'audio-row' });
  doc.body.append(t.row);
  const label = t.row.querySelector('label');
  assert.equal(label.getAttribute('for'), 'wx');
  assert.equal(label.textContent, 'Weather');
  assert.equal(t.input.id, 'wx');
  const hint = t.row.querySelector('.ui-hint');
  assert.equal(t.input.getAttribute('aria-describedby'), hint.id);
  assert.ok(t.row.classList.contains('audio-row') && t.row.classList.contains('ui-row'));
  // Generated ids are unique.
  assert.notEqual(toggle({ label: 'a' }).input.id, toggle({ label: 'b' }).input.id);
});

test('checkbox: themed list checkbox with its label after it', () => {
  const c = checkbox({ id: 'pick', label: 'Select Alice', checked: true });
  assert.equal(c.input.getAttribute('type'), 'checkbox');
  assert.equal(c.input.getAttribute('role'), null, 'a plain checkbox, not a switch');
  assert.ok(c.input.classList.contains('ui-check'));
  assert.equal(c.row.children[0], c.input, 'the box comes first');
  assert.equal(c.label.getAttribute('for'), 'pick');
  assert.equal(c.get(), true);
  assert.equal(checkInput({ label: 'Select all' }).getAttribute('aria-label'), 'Select all');
});

test('segmented: a radio group with one name, labels wired, keyboard-reachable radios', () => {
  const got = [];
  const g = segmented({
    name: 'gfx',
    label: 'Graphics',
    value: 'webra',
    describedBy: 'gfx-note',
    options: [
      { value: 'webra', label: 'WebRA' },
      { value: 'original', label: 'Original', disabled: true, title: 'Install the content first' },
    ],
    onChange: (v) => got.push(v),
  });
  assert.equal(g.root.getAttribute('role'), 'radiogroup');
  assert.equal(g.root.getAttribute('aria-label'), 'Graphics');
  assert.equal(g.root.getAttribute('aria-describedby'), 'gfx-note');
  const radios = [...g.inputs.values()];
  assert.deepEqual(radios.map((r) => r.getAttribute('type')), ['radio', 'radio']);
  assert.deepEqual(radios.map((r) => r.getAttribute('name')), ['gfx', 'gfx'], 'one group: arrow keys move between them');
  assert.deepEqual(radios.map((r) => r.id), ['gfx-webra', 'gfx-original']);
  for (const r of radios) assert.equal(r.hasAttribute('tabindex'), false);
  assert.equal(g.labels.get('original').getAttribute('for'), 'gfx-original');
  assert.equal(g.labels.get('original').getAttribute('title'), 'Install the content first');
  assert.equal(g.get(), 'webra');
  assert.equal(g.inputs.get('original').disabled, true);

  g.setDisabled('original', false);
  g.setTitle('original', '');
  assert.equal(g.inputs.get('original').disabled, false);
  assert.equal(g.labels.get('original').hasAttribute('title'), false);

  check(g.inputs.get('original'), true);
  assert.deepEqual(got, ['original']);
  assert.equal(g.get(), 'original');
  assert.equal(g.inputs.get('webra').checked, false, 'exclusive');
  g.set('webra');
  assert.equal(g.get(), 'webra');
  assert.deepEqual(got, ['original'], 'set() from code does not fire onChange');
});

test('segmented: a disabled group disables every radio', () => {
  const g = segmented({ label: 'Sounds', value: 'webra', disabled: true, options: [{ value: 'webra', label: 'WebRA' }, { value: 'original', label: 'Original' }] });
  assert.ok([...g.inputs.values()].every((r) => r.disabled));
});

test('slider: label, value readout, aria-valuetext and the fill go with the value', () => {
  const moves = [];
  const s = slider({ id: 'vol', label: 'Master volume', min: 0, max: 100, value: 40, format: (v) => `${v}%`, onInput: (v) => moves.push(v) });
  doc.body.append(s.row);
  assert.equal(s.input.getAttribute('type'), 'range');
  assert.ok(s.input.classList.contains('ui-slider'));
  assert.equal(s.row.querySelector('label').getAttribute('for'), 'vol');
  assert.equal(s.output.textContent, '40%');
  assert.equal(s.output.getAttribute('for'), 'vol');
  assert.equal(s.input.getAttribute('aria-valuetext'), '40%');

  s.input.value = '75';
  s.input.dispatchEvent(new FakeEvent('input'));
  assert.equal(s.output.textContent, '75%');
  assert.deepEqual(moves, [75]);
  s.set(10);
  assert.equal(s.get(), 10);
  assert.equal(s.output.textContent, '10%');
});

test('slider fill: a percentage through the CSSOM, never a style attribute', () => {
  const calls = [];
  const input = doc.createElement('input');
  input.min = '0.5';
  input.max = '2.5';
  input.value = '1.5';
  input.style = { setProperty: (k, v) => calls.push([k, v]) };
  syncSliderFill(input);
  assert.deepEqual(calls, [['--ui-fill', '50%']]);
  input.value = '9';
  syncSliderFill(input);
  assert.deepEqual(calls.at(-1), ['--ui-fill', '100%'], 'clamped');
  assert.equal(input.hasAttribute('style'), false);
  // An existing range input (the replay position) can be themed in place.
  const seek = doc.createElement('input');
  seek.max = '10';
  seek.value = '5';
  styleSlider(seek);
  assert.ok(seek.classList.contains('ui-slider'));
});

test('CSP: the controls module and every sheet it needs have no HTML strings or inline styles', () => {
  const js = read('../js/ui/controls.js');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|setAttribute\(\s*['"]style|\.style\.(?!setProperty)\w+\s*=/);
  const css = read('../css/controls.css');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/, 'no remote parts');
});

test('CSS: focus ring, disabled, reduced motion and em sizing for every control', () => {
  const css = read('../css/controls.css');
  for (const sel of ['input.ui-switch:focus-visible', 'input.ui-check:focus-visible', '.ui-segmented > input:focus-visible + .ui-segment', 'input.ui-slider:focus-visible']) {
    assert.ok(css.includes(sel), `${sel} has a focus ring`);
  }
  for (const sel of ['input.ui-switch:disabled', '.ui-segmented > input:disabled + .ui-segment', 'input.ui-slider:disabled']) assert.ok(css.includes(sel), `${sel} has a disabled look`);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^{]*\{[^@]*transition: none/s);
  assert.match(css, /input\.ui-switch\s*\{[^}]*--sw-w: 4\.7em/s, 'the switch is sized in em (66 x 28 px at 14 px)');
  assert.match(css, /--ctl-size: 0\.875rem/);
  assert.match(css, /content: 'ON'/);
  assert.match(css, /content: 'OFF'/);
  assert.match(css, /@media \(pointer: coarse\)/, 'touch sizes');
  // The radios stay in the page (not display:none), so the keyboard and screen readers find them.
  const radio = css.match(/\.ui-segmented > input \{[^}]*\}/)[0];
  assert.doesNotMatch(radio, /display:\s*none|visibility:\s*hidden/);
});

test('every game stylesheet is linked once, controls.css right after style.css', () => {
  const html = read('../index.html');
  const links = [...html.matchAll(/href="(css\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(links).size, links.length);
  assert.ok(links.indexOf('css/controls.css') === links.indexOf('css/style.css') + 1);
  const files = readdirSync(fileURLToPath(new URL('../css', import.meta.url))).map((f) => `css/${f}`);
  for (const f of files) assert.ok(links.includes(f), `${f} is linked in index.html`);
});

test('call sites use the shared controls instead of raw inputs', () => {
  for (const rel of ['../js/audio/panel.js', '../js/content/panel.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /type: 'checkbox'|type: 'radio'|type: 'range'/, `${rel} builds no raw checkbox, radio or range`);
  }
  assert.doesNotMatch(read('../js/debug.js'), /type = 'checkbox'/);
  assert.doesNotMatch(read('../js/gamemenu.js'), /type = 'checkbox'|type = 'range'/);
  assert.doesNotMatch(read('../js/lobby.js'), /type = 'checkbox'/);
});

// ---- Select plate ----------------------------------------------------------------

const key = (el, k, extra = {}) => {
  const e = new FakeEvent('keydown', { key: k, ...extra });
  el.dispatchEvent(e);
  return e;
};
const AI = [
  { value: 'rush', label: 'Rush AI', hint: 'Attacks early and often' },
  { value: 'normal', label: 'Normal AI', hint: 'A balanced build order' },
  { value: 'turtle', label: 'Turtle AI', hint: 'Defends, lays mines' },
  { value: 'naval', label: 'Naval AI', disabled: true, title: 'Needs water on the map' },
  { value: 'closed', label: 'Closed' },
];

test('select: a button with a listbox, named, with every option and the choice on the plate', () => {
  const s = selectPlate({ id: 'ai', label: 'AI type', options: AI, value: 'normal' });
  doc.body.append(s.root);
  const b = s.button;
  assert.equal(b.localName, 'button');
  assert.equal(b.getAttribute('type'), 'button');
  assert.equal(b.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(b.getAttribute('aria-expanded'), 'false');
  assert.equal(b.getAttribute('aria-controls'), s.listbox.id);
  // Named by the label and the chosen value: "AI type, Normal AI".
  const [labelId, valueId] = b.getAttribute('aria-labelledby').split(' ');
  assert.equal(doc.getElementById(labelId).textContent, 'AI type');
  assert.ok(doc.getElementById(labelId).classList.contains('ui-sr-only'));
  assert.equal(doc.getElementById(valueId).textContent, 'Normal AI');
  assert.equal(s.listbox.getAttribute('role'), 'listbox');
  assert.equal(s.listbox.getAttribute('aria-labelledby'), labelId);
  const opts = s.listbox.querySelectorAll('[role="option"]');
  assert.deepEqual(opts.map((o) => o.querySelector('.ui-sp-label').textContent), AI.map((o) => o.label));
  assert.deepEqual(opts.map((o) => o.getAttribute('aria-selected')), ['false', 'true', 'false', 'false', 'false']);
  assert.equal(opts[3].getAttribute('aria-disabled'), 'true');
  assert.equal(opts[3].getAttribute('title'), 'Needs water on the map');
  assert.equal(opts[0].querySelector('.ui-sp-hint').textContent, 'Attacks early and often');
  // The chosen option and the plate carry a lit lamp (a second signal next to the words).
  assert.ok(opts[1].querySelector('.ui-led').classList.contains('ui-led-on'));
  assert.ok(opts[0].querySelector('.ui-led').classList.contains('ui-led-off'));
  assert.ok(b.querySelector('.ui-led').classList.contains('ui-led-on'));
  assert.equal(s.get(), 'normal');
  assert.equal(s.panel.hidden, true, 'closed: the list is hidden');
  assert.deepEqual(strayValues(s.root), []);
});

test('select: click opens and closes; a click on an option chooses it and returns focus', () => {
  const got = [];
  const s = selectPlate({ label: 'AI type', options: AI, value: 'normal', onChange: (v, o) => got.push([v, o.label]) });
  doc.body.append(s.root);
  click(s.button);
  assert.equal(s.isOpen(), true);
  assert.equal(s.button.getAttribute('aria-expanded'), 'true');
  assert.equal(s.panel.hidden, false);
  assert.equal(doc.activeElement, s.listbox, 'focus moves into the list');
  assert.equal(s.listbox.getAttribute('aria-activedescendant'), s.listbox.querySelectorAll('[role="option"]')[1].id, 'the chosen option is highlighted');
  const opts = s.listbox.querySelectorAll('[role="option"]');
  click(opts[3]);
  assert.equal(s.isOpen(), true, 'a disabled option does nothing');
  click(opts[2]);
  assert.equal(s.isOpen(), false);
  assert.equal(s.get(), 'turtle');
  assert.deepEqual(got, [['turtle', 'Turtle AI']]);
  assert.equal(doc.activeElement, s.button);
  assert.equal(s.button.querySelector('.ui-sp-value').textContent, 'Turtle AI');
  click(s.button);
  click(s.button);
  assert.equal(s.isOpen(), false, 'the button closes it again');
  assert.deepEqual(got.length, 1, 'opening and closing changes nothing');
});

test('select: keyboard: arrows skip disabled options, Home/End, Enter chooses, Esc keeps the value', () => {
  const got = [];
  const s = selectPlate({ label: 'AI type', options: AI, value: 'normal', onChange: (v) => got.push(v) });
  doc.body.append(s.root);
  const active = () => doc.getElementById(s.listbox.getAttribute('aria-activedescendant')).querySelector('.ui-sp-label').textContent;
  assert.equal(key(s.button, 'ArrowDown').defaultPrevented, true);
  assert.equal(s.isOpen(), true);
  assert.equal(active(), 'Normal AI');
  key(s.listbox, 'ArrowDown');
  assert.equal(active(), 'Turtle AI');
  key(s.listbox, 'ArrowDown');
  assert.equal(active(), 'Closed', 'Naval AI is disabled: skipped');
  key(s.listbox, 'ArrowDown');
  assert.equal(active(), 'Closed', 'no wrap at the end');
  key(s.listbox, 'Home');
  assert.equal(active(), 'Rush AI');
  key(s.listbox, 'ArrowUp');
  assert.equal(active(), 'Rush AI');
  key(s.listbox, 'End');
  assert.equal(active(), 'Closed');
  key(s.listbox, 'PageUp');
  assert.equal(active(), 'Rush AI');
  // Esc closes without a change, focus back on the button, and the menu behind stays open.
  const esc = key(s.listbox, 'Escape');
  assert.equal(esc.propagationStopped, true);
  assert.equal(s.isOpen(), false);
  assert.equal(s.get(), 'normal');
  assert.equal(doc.activeElement, s.button);
  assert.deepEqual(got, []);
  // End on the closed button opens at the last option; Enter chooses it.
  key(s.button, 'End');
  assert.equal(active(), 'Closed');
  key(s.listbox, 'Enter');
  assert.equal(s.get(), 'closed');
  assert.equal(s.isOpen(), false);
  // Space chooses too; Tab chooses and lets the focus move on.
  key(s.button, 'Home');
  key(s.listbox, ' ');
  assert.equal(s.get(), 'rush');
  key(s.button, 'ArrowUp');
  key(s.listbox, 'ArrowDown');
  const tab = key(s.listbox, 'Tab');
  assert.equal(tab.defaultPrevented, false);
  assert.equal(s.get(), 'normal');
  assert.deepEqual(got, ['closed', 'rush', 'normal']);
});

test('select: typeahead finds options by their first letters and cycles one letter', () => {
  const s = selectPlate({ label: 'Country', options: ['England', 'France', 'Germany', 'Greece', 'Russia', 'Ukraine'].map((c) => ({ value: c.toLowerCase(), label: c })), value: 'england' });
  doc.body.append(s.root);
  const active = () => doc.getElementById(s.listbox.getAttribute('aria-activedescendant'))?.querySelector('.ui-sp-label').textContent;
  // Typing on the closed button opens the list at the match.
  key(s.button, 'g');
  assert.equal(s.isOpen(), true);
  assert.equal(active(), 'Germany');
  key(s.listbox, 'g');
  assert.equal(active(), 'Greece', 'the same letter again: the next one');
  key(s.listbox, 'g');
  assert.equal(active(), 'Germany', 'and round again');
  key(s.listbox, 'Escape');
  key(s.button, 'u');
  key(s.listbox, 'k');
  assert.equal(active(), 'Ukraine');
  // After a pause the buffer starts over.
  const realNow = Date.now;
  try {
    const t = realNow();
    Date.now = () => t + TYPEAHEAD_MS + 1;
    key(s.listbox, 'r');
    assert.equal(active(), 'Russia');
  } finally {
    Date.now = realNow;
  }
  // Modifier keys are not typeahead.
  key(s.listbox, 'f', { ctrlKey: true });
  assert.equal(active(), 'Russia');
});

test('select: a press outside closes it without a choice and leaves the focus alone', () => {
  doc = installDom({ windowEvents: true });
  const s = selectPlate({ label: 'AI type', options: AI, value: 'rush' });
  const other = doc.createElement('button');
  doc.body.append(s.root, other);
  click(s.button);
  assert.equal(s.isOpen(), true);
  // A press inside the list does not close it.
  s.listbox.querySelectorAll('[role="option"]')[2].dispatchEvent(new FakeEvent('pointerdown'));
  assert.equal(s.isOpen(), true);
  other.dispatchEvent(new FakeEvent('pointerdown'));
  assert.equal(s.isOpen(), false);
  assert.equal(s.get(), 'rush');
  assert.notEqual(doc.activeElement, s.button);
  // The listener goes with the list.
  other.dispatchEvent(new FakeEvent('pointerdown'));
  assert.equal(s.isOpen(), false);
});

test('select: on phones the list is a bottom sheet with a title and a close button', () => {
  assert.equal(selectSheetMode(390, 844), true, 'phone, portrait');
  assert.equal(selectSheetMode(844, 390), true, 'phone, landscape');
  assert.equal(selectSheetMode(1280, 800), false, 'desktop');
  assert.equal(selectSheetMode(1024, 1366), false, 'tablet portrait is wider than a phone');
  window.innerWidth = 390;
  window.innerHeight = 844;
  const s = selectPlate({ label: 'Starting units', options: AI, value: 'rush' });
  doc.body.append(s.root);
  click(s.button);
  assert.equal(s.isSheet(), true);
  assert.ok(s.panel.classList.contains('ui-sp-sheet'));
  assert.equal(s.panel.querySelector('.ui-sp-title').textContent, 'Starting units');
  const close = s.panel.querySelector('.ui-sp-close');
  assert.equal(close.getAttribute('aria-label'), 'Close');
  click(close);
  assert.equal(s.isOpen(), false);
  assert.equal(doc.activeElement, s.button);
  assert.equal(s.panel.classList.contains('ui-sp-sheet'), false, 'a closed sheet leaves no full-screen layer behind');
  // A tap on the dim area (the panel itself) closes it; a tap on the list does not.
  click(s.button);
  s.listbox.dispatchEvent(new FakeEvent('click'));
  assert.equal(s.isOpen(), true);
  s.panel.dispatchEvent(new FakeEvent('click'));
  assert.equal(s.isOpen(), false);
  // Desktop: a drop-down placed at the button through the CSSOM.
  window.innerWidth = 1280;
  window.innerHeight = 800;
  const set = [];
  const d = selectPlate({ label: 'Map size', options: AI, sheet: 'auto' });
  d.panel.style = { setProperty: (k, v) => set.push([k, v]) };
  doc.body.append(d.root);
  click(d.button);
  assert.equal(d.isSheet(), false);
  assert.ok(set.some(([k]) => k === '--sp-top') && set.some(([k]) => k === '--sp-left') && set.some(([k]) => k === '--sp-width'));
  assert.equal(d.panel.hasAttribute('style'), false);
  // sheet: 'always' and 'never' override the layout.
  const a = selectPlate({ label: 'x', options: AI, sheet: 'always' });
  doc.body.append(a.root);
  click(a.button);
  assert.equal(a.isSheet(), true);
  delete window.innerWidth;
  delete window.innerHeight;
});

test('select: groups, placeholder, set() without onChange, new options, disabled states', () => {
  const got = [];
  const s = selectPlate({
    label: 'Map',
    placeholder: 'Pick a map',
    options: [
      { label: 'Two players', options: [{ value: 1, label: 'Ore Lord' }, { value: 2, label: 'Seaside' }] },
      { label: 'Four players', options: [{ value: 3, label: 'Middle Mayhem' }] },
    ],
    onChange: (v) => got.push(v),
  });
  doc.body.append(s.root);
  assert.equal(s.get(), null);
  assert.equal(s.button.querySelector('.ui-sp-value').textContent, 'Pick a map');
  assert.ok(s.root.classList.contains('ui-sp-empty'));
  assert.ok(s.button.querySelector('.ui-led').classList.contains('ui-led-off'));
  const groups = s.listbox.querySelectorAll('[role="group"]');
  assert.equal(groups.length, 2);
  assert.equal(doc.getElementById(groups[0].getAttribute('aria-labelledby')).textContent, 'Two players');
  assert.equal(groups[0].querySelectorAll('[role="option"]').length, 2);
  // Values compare as strings, like a native select; get() returns the option's own value.
  s.set('2');
  assert.equal(s.get(), 2);
  assert.equal(s.option().label, 'Seaside');
  assert.deepEqual(got, [], 'set() from code does not fire onChange');
  s.setOptions([{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo' }], 'b');
  assert.equal(s.get(), 'b');
  assert.equal(s.listbox.querySelectorAll('[role="option"]').length, 2);
  s.setOptionDisabled('a', true, 'Too small');
  const a = s.listbox.querySelectorAll('[role="option"]')[0];
  assert.equal(a.getAttribute('aria-disabled'), 'true');
  assert.equal(a.getAttribute('title'), 'Too small');
  key(s.button, 'Home');
  assert.equal(doc.getElementById(s.listbox.getAttribute('aria-activedescendant')).querySelector('.ui-sp-label').textContent, 'Bravo', 'Home skips the disabled first option');
  key(s.listbox, 'Escape');
  s.setDisabled(true);
  assert.equal(s.button.disabled, true);
  click(s.button);
  assert.equal(s.isOpen(), false);
  key(s.button, 'ArrowDown');
  assert.equal(s.isOpen(), false);
});

test('selectRow: a visible label names the select, with the hint as its description', () => {
  const r = selectRow({ id: 'speed', label: 'Game speed', hint: 'Changes the tick rate.', options: AI, value: 'rush' });
  doc.body.append(r.row);
  assert.ok(r.row.classList.contains('ui-row') && r.row.classList.contains('ui-row-choice'));
  assert.equal(r.label.textContent, 'Game speed');
  assert.equal(r.select.button.getAttribute('aria-labelledby').split(' ')[0], r.label.id);
  assert.equal(r.select.button.getAttribute('aria-describedby'), r.row.querySelector('.ui-hint').id);
  assert.equal(r.select.root.querySelector('.ui-sr-only'), null, 'no hidden second label');
});

// ---- Stepper ----------------------------------------------------------------------

test('stepper: a spinbutton over fixed values, its buttons step one value and stop at the ends', () => {
  const got = [];
  const cash = [2500, 5000, 10000, 20000];
  const s = stepper({ label: 'Starting cash', values: cash, value: 5000, format: (v) => `$ ${v}`, onChange: (v) => got.push(v) });
  doc.body.append(s.root);
  const f = s.field;
  assert.equal(f.getAttribute('role'), 'spinbutton');
  assert.equal(f.getAttribute('aria-label'), 'Starting cash');
  assert.equal(f.getAttribute('tabindex'), '0');
  assert.equal(f.textContent, '$ 5000');
  assert.equal(f.getAttribute('aria-valuetext'), '$ 5000');
  assert.equal(f.getAttribute('aria-valuenow'), '1');
  assert.equal(f.getAttribute('aria-valuemax'), '3');
  assert.equal(s.dec.getAttribute('aria-label'), 'Less');
  assert.equal(s.inc.getAttribute('aria-label'), 'More');
  assert.equal(s.dec.getAttribute('tabindex'), '-1', 'the buttons are for the pointer; the keyboard uses the field');
  click(s.inc);
  assert.equal(s.get(), 10000);
  key(f, 'ArrowUp');
  assert.equal(s.get(), 20000);
  assert.equal(s.inc.disabled, true, 'at the top');
  key(f, 'ArrowUp');
  assert.equal(s.get(), 20000);
  key(f, 'Home');
  assert.equal(s.get(), 2500);
  assert.equal(s.dec.disabled, true);
  key(f, 'End');
  key(f, 'ArrowDown');
  assert.deepEqual(got, [10000, 20000, 2500, 20000, 10000]);
  s.set(2500);
  assert.equal(f.textContent, '$ 2500');
  assert.equal(got.length, 5, 'set() does not fire onChange');
  s.setDisabled(true);
  assert.equal(f.getAttribute('aria-disabled'), 'true');
  assert.equal(s.inc.disabled, true);
  key(f, 'ArrowUp');
  assert.equal(s.get(), 2500);
  s.setValues([1000, 2500], 1000);
  assert.equal(s.get(), 1000);
});

// ---- Tabs ---------------------------------------------------------------------------

test('tabs: a tablist with roving focus, arrows and Home/End, panels wired and hidden', () => {
  const got = [];
  const panels = ['players', 'options', 'map'].map((id) => {
    const p = doc.createElement('section');
    doc.body.append(p);
    return p;
  });
  const t = tabs({
    label: 'Lobby',
    tabs: [
      { id: 'players', label: 'Players', panel: panels[0] },
      { id: 'options', label: 'Options', panel: panels[1] },
      { id: 'map', label: 'Map', panel: panels[2], disabled: true },
    ],
    onChange: (id) => got.push(id),
  });
  doc.body.append(t.root);
  assert.equal(t.root.getAttribute('role'), 'tablist');
  assert.equal(t.root.getAttribute('aria-label'), 'Lobby');
  const [a, b] = [t.buttons.get('players'), t.buttons.get('options')];
  assert.equal(a.getAttribute('role'), 'tab');
  assert.equal(a.getAttribute('aria-selected'), 'true');
  assert.equal(a.getAttribute('tabindex'), '0');
  assert.equal(b.getAttribute('tabindex'), '-1');
  assert.equal(panels[0].getAttribute('role'), 'tabpanel');
  assert.equal(panels[0].getAttribute('aria-labelledby'), a.id);
  assert.equal(a.getAttribute('aria-controls'), panels[0].id);
  assert.equal(panels[1].hidden, true);
  assert.ok(a.querySelector('.ui-led').classList.contains('ui-led-on'));
  key(t.root, 'ArrowRight');
  assert.equal(t.get(), 'options');
  assert.equal(doc.activeElement, b);
  assert.equal(panels[0].hidden, true);
  assert.equal(panels[1].hidden, false);
  key(t.root, 'ArrowRight');
  assert.equal(t.get(), 'players', 'the disabled tab is skipped, and the strip wraps');
  key(t.root, 'End');
  assert.equal(t.get(), 'options');
  click(a);
  assert.deepEqual(got, ['options', 'players', 'options', 'players']);
  t.set('options');
  assert.equal(got.length, 4, 'set() does not fire onChange');
});

// ---- Lamps and badges ------------------------------------------------------------

test('badges and lamps: a word on a plate, lamps as a second signal, decorative unless named', () => {
  assert.deepEqual(LED_STATES, ['off', 'on', 'ok', 'warn', 'bad', 'info']);
  const l = led('ok');
  assert.ok(l.classList.contains('ui-led') && l.classList.contains('ui-led-ok'));
  assert.equal(l.getAttribute('aria-hidden'), 'true');
  const named = led('bad', 'Connection poor');
  assert.equal(named.getAttribute('role'), 'img');
  assert.equal(named.getAttribute('aria-label'), 'Connection poor');
  assert.equal(named.hasAttribute('aria-hidden'), false);
  setLed(l, 'warn');
  assert.ok(l.classList.contains('ui-led-warn') && !l.classList.contains('ui-led-ok'));
  assert.ok(led('nonsense').classList.contains('ui-led-off'));

  const ready = badge('ready', 'Ready');
  assert.ok(ready.classList.contains('ui-badge') && ready.classList.contains('ui-badge-ok'));
  assert.equal(textOf(ready), 'Ready');
  assert.ok(ready.querySelector('.ui-led.ui-led-ok'), 'READY has a green lamp');
  const host = badge('host', 'Host');
  assert.ok(host.classList.contains('ui-badge-accent'));
  assert.equal(host.querySelector('.ui-led'), null);
  const modded = badge('modded', 'Modded', { title: 'Uses a texture pack' });
  assert.ok(modded.classList.contains('ui-badge-hazard'));
  assert.ok(modded.querySelector('.ui-badge-text'));
  assert.equal(modded.getAttribute('title'), 'Uses a texture pack');
  assert.ok(badge('locked', 'Locked').classList.contains('ui-badge-bad'));
  assert.ok(badge('locked', 'Locked', { led: true }).querySelector('.ui-led-bad'));
  assert.equal(badgeKind('whatever'), 'neutral');
  for (const look of Object.values(BADGE_ALIASES)) assert.ok(BADGE_KINDS.includes(look), look);
  // Every badge look and lamp state has a rule in the sheet.
  const css = read('../css/controls.css');
  for (const k of BADGE_KINDS.filter((k) => k !== 'neutral')) assert.ok(css.includes(`.ui-badge-${k}`), `.ui-badge-${k}`);
  for (const s of LED_STATES.filter((s) => s !== 'off')) assert.ok(css.includes(`.ui-led.ui-led-${s}`), `.ui-led-${s}`);
});

test('CSS: the new controls have focus rings, touch sizes, reduced motion and forced colours', () => {
  const css = read('../css/controls.css');
  for (const sel of ['.ui-sp-button:focus-visible', '.ui-stepper-value:focus-visible', '.ui-tab:focus-visible']) assert.ok(css.includes(sel), `${sel} has a focus ring`);
  // 44 px rows on touch: the select, its options in the sheet, the stepper and the tabs use --ctl-row.
  assert.match(css, /\.ui-sp-button \{[^}]*min-height: max\(var\(--ctl-row\)/s);
  assert.match(css, /\.ui-sp-sheet \.ui-sp-option \{[^}]*min-height: 44px/s);
  assert.match(css, /\.ui-sp-close \{[^}]*width: 44px;[^}]*height: 44px/s);
  assert.match(css, /\.ui-stepper \{[^}]*min-height: max\(var\(--ctl-row\)/s);
  // The sheet slides in, except with reduced motion; every animation here has a reduce rule.
  const reduce = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)[1];
  assert.match(reduce, /\.ui-sp-sheet > \.ui-sp-card \{\s*animation: none/);
  assert.match(reduce, /\.ui-sp-flap::before/);
  const forced = css.match(/@media \(forced-colors: active\) \{([\s\S]*?)\n\}/)[1];
  for (const sel of ['.ui-led', '.ui-sp-option[aria-selected=\'true\']', '.ui-tab[aria-selected=\'true\']', '.ui-badge']) assert.ok(forced.includes(sel), `${sel} in forced colours`);
  // The list leaves the browser's popover box behind.
  assert.match(css, /\.ui-sp-panel \{[^}]*margin: 0;[^}]*background: transparent;[^}]*border: 0;/s);
});

test('patterns sheet: the shared classes exist, use tokens only, and have contrast rules', () => {
  const css = read('../css/patterns.css');
  for (const cls of ['.ui-panel', '.ui-card', '.ui-well', '.ui-hazard', '.ui-head', '.ui-section-title', '.ui-btn', '.ui-btn-primary', '.ui-btn-ghost', '.ui-btn-hazard', '.ui-dialog', '.ui-menubar', '.ui-brand', '.ui-slot-row', '.ui-table', '.ui-toast', '.ui-meter', '.ui-progress']) {
    assert.ok(css.includes(`${cls} {`) || css.includes(`${cls},`), `${cls} is defined`);
  }
  // Colours come from the tokens (a few neutral greys for the meter wells excepted).
  const literal = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/#[0-9a-f]{3,6}\b/gi)].map((m) => m[0].toLowerCase());
  assert.deepEqual([...new Set(literal)].sort(), ['#06080a', '#1a1f25', '#c9a43a', '#fff']);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.doesNotMatch(css, /@keyframes|animation:|transition:/, 'no motion here (it would need a reduced-motion rule)');
});

test('select: a list whose control left the page closes at the next event; resizing across the phone breakpoint reopens it as a sheet', () => {
  doc = installDom({ windowEvents: true });
  window.innerWidth = 1280;
  window.innerHeight = 800;
  const s = selectPlate({ label: 'AI type', options: AI, value: 'turtle' });
  doc.body.append(s.root);
  click(s.button);
  assert.equal(s.isSheet(), false);
  // The window narrows to a phone: the resize listener reopens it in sheet mode, the highlight kept.
  const resize = [];
  window.addEventListener = (t, fn) => t === 'resize' && resize.push(fn);
  click(s.button);
  click(s.button);
  window.innerWidth = 390;
  window.innerHeight = 844;
  for (const fn of resize) fn();
  assert.equal(s.isOpen(), true);
  assert.equal(s.isSheet(), true);
  assert.equal(doc.getElementById(s.listbox.getAttribute('aria-activedescendant')).querySelector('.ui-sp-label').textContent, 'Turtle AI');
  // The screen re-renders without it: the next press anywhere closes it and drops the listeners.
  s.root.remove();
  doc.body.dispatchEvent(new FakeEvent('pointerdown'));
  assert.equal(s.isOpen(), false);
  delete window.innerWidth;
  delete window.innerHeight;
});

test('CSS: the screen-reader-only rule ships with the controls (the website has no theme.css)', () => {
  assert.match(read('../css/controls.css'), /\.ui-sr-only \{[^}]*position: absolute !important;[^}]*clip: rect\(0 0 0 0\)/s);
});
