// The shared themed controls (js/ui/controls.js, css/controls.css): accessible
// markup, aria-checked kept in step, labels wired, keyboard-operable parts, and
// the CSP rules (no inline styles, no HTML strings), on the fake DOM.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom, uninstallDom, FakeEvent, check } from './dom-fixtures.mjs';
import { switchInput, checkInput, toggle, checkbox, segmented, slider, styleSlider, syncSliderFill } from '../js/ui/controls.js';

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
  assert.match(css, /input\.ui-switch\s*\{[^}]*--sw-w: 4em/s, 'the switch is sized in em');
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
