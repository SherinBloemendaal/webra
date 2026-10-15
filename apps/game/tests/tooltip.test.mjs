// The shared tooltip (js/ui/tooltip.js) and what the game puts in it: hover
// delay, keyboard focus, Esc, touch long press, aria-describedby, placement
// inside the viewport, and the specs of the command bar, sidebar, support
// powers, HUD buttons and production cameos (with the bound hotkeys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installDom, uninstallDom, FakeEvent } from './dom-fixtures.mjs';
import { attachTooltip, hideTooltip, LONG_PRESS_MS, openTooltip, placeTooltip, TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS, TOUCH_HOLD_MS, tooltipText } from '../js/ui/tooltip.js';
import { commandTip, COMMANDS, stanceTip, STANCES } from '../js/commandbar.js';
import { formatPower, productionTip } from '../js/production.js';
import { powerTip } from '../js/powers.js';
import { tabTip } from '../js/sidebar.js';
import { debugTip, menuKeys, menuTip, sidebarToggleTip } from '../js/hudtips.js';
import { boundKey, formatCombo, HotkeyRegistry } from '../js/hotkeys.js';
import { createSettings as settingsOver } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';

const createSettings = () => settingsOver(createRegistry({ storage: null }));
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Timers run by hand: `run()` fires everything due by `now`. */
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        timers.delete(id);
        t.fn();
      }
    },
    pending: () => timers.size,
  };
}

function setup() {
  const doc = installDom();
  globalThis.window.innerWidth = 1000;
  globalThis.window.innerHeight = 700;
  const button = doc.createElement('button');
  button.setAttribute('aria-label', 'Guard');
  doc.body.append(button);
  return { doc, button };
}

const ev = (type, init = {}) => new FakeEvent(type, init);

test('tooltip: opens after the hover delay, closes on leave, points aria-describedby at itself', () => {
  const { doc, button } = setup();
  try {
    const t = clock();
    let key = 'D';
    const tip = attachTooltip(button, () => ({ title: 'Guard', hotkey: key, desc: 'Click a unit to protect it.' }), t);
    assert.ok(button.classList.contains('has-tooltip'));
    button.dispatchEvent(ev('pointerenter', { pointerType: 'mouse' }));
    assert.equal(openTooltip(doc), null, 'not at once');
    t.advance(TOOLTIP_DELAY_MS - 1);
    assert.equal(openTooltip(doc), null);
    t.advance(1);
    const open = openTooltip(doc);
    assert.equal(open.target, button);
    assert.equal(open.text, 'Guard (D)\nClick a unit to protect it.');
    assert.equal(open.panel.getAttribute('role'), 'tooltip');
    assert.equal(open.panel.hidden, false);
    assert.equal(button.getAttribute('aria-describedby'), open.panel.id);
    assert.equal(button.getAttribute('aria-label'), 'Guard', 'the short name stays');
    // The panel shows the key in its own (yellow) element.
    assert.equal(open.panel.querySelector('.ui-tooltip-key').textContent, '(D)');
    // A rebind while it shows: refresh re-renders it.
    key = 'G';
    tip.refresh();
    assert.equal(openTooltip(doc).text, 'Guard (G)\nClick a unit to protect it.');
    button.dispatchEvent(ev('pointerleave', { pointerType: 'mouse' }));
    assert.equal(openTooltip(doc), null);
    assert.equal(open.panel.hidden, true);
    assert.equal(button.getAttribute('aria-describedby'), null);
    // Right after it closed, hovering again opens it at once (moving along a bar) ...
    button.dispatchEvent(ev('pointerenter', { pointerType: 'mouse' }));
    assert.ok(openTooltip(doc), 'warm: no second delay');
    button.dispatchEvent(ev('pointerleave', { pointerType: 'mouse' }));
    t.advance(TOOLTIP_WARM_MS);
    // ... later the delay is back. Leaving before the delay: it never opens.
    button.dispatchEvent(ev('pointerenter', { pointerType: 'mouse' }));
    button.dispatchEvent(ev('pointerleave', { pointerType: 'mouse' }));
    t.advance(TOOLTIP_DELAY_MS * 2);
    assert.equal(openTooltip(doc), null);
    tip.detach();
    assert.ok(!button.classList.contains('has-tooltip'));
  } finally {
    uninstallDom();
  }
});

test('tooltip: keyboard focus opens it at once, blur and Esc close it, a click focus does not', () => {
  const { doc, button } = setup();
  try {
    const t = clock();
    attachTooltip(button, () => ({ title: 'Stop', hotkey: 'S' }), t);
    button.dispatchEvent(ev('focus', { bubbles: false }));
    assert.equal(openTooltip(doc)?.text, 'Stop (S)');
    button.dispatchEvent(ev('blur', { bubbles: false }));
    assert.equal(openTooltip(doc), null);
    button.dispatchEvent(ev('focus', { bubbles: false }));
    const esc = ev('keydown', { key: 'Escape' });
    doc.dispatchEvent(esc);
    assert.equal(openTooltip(doc), null, 'Esc dismisses it');
    assert.equal(esc.defaultPrevented, false, 'and still reaches the game (cancel, menu)');
    // Focus that comes with a mouse press is not keyboard focus.
    button.dispatchEvent(ev('blur', { bubbles: false }));
    button.dispatchEvent(ev('pointerdown', { pointerType: 'mouse' }));
    button.dispatchEvent(ev('focus', { bubbles: false }));
    assert.equal(openTooltip(doc), null);
    button.dispatchEvent(ev('pointerup', { pointerType: 'mouse' }));
  } finally {
    uninstallDom();
  }
});

test('tooltip: one at a time, a second target switches at once, a press closes it, hideTooltip closes it', () => {
  const { doc, button } = setup();
  try {
    const t = clock();
    const other = doc.createElement('button');
    doc.body.append(other);
    attachTooltip(button, () => ({ title: 'A' }), t);
    attachTooltip(other, () => ({ title: 'B' }), t);
    button.dispatchEvent(ev('pointerenter', { pointerType: 'mouse' }));
    t.advance(TOOLTIP_DELAY_MS);
    other.dispatchEvent(ev('pointerenter', { pointerType: 'mouse' }));
    assert.equal(openTooltip(doc).text, 'B', 'no second delay while one shows');
    assert.equal(button.getAttribute('aria-describedby'), null);
    other.dispatchEvent(ev('pointerdown', { pointerType: 'mouse' }));
    assert.equal(openTooltip(doc), null, 'pressing the button closes its tooltip');
    other.dispatchEvent(ev('pointerup', { pointerType: 'mouse' }));
    other.dispatchEvent(ev('focus', { bubbles: false }));
    assert.equal(openTooltip(doc).text, 'B');
    hideTooltip(doc);
    assert.equal(openTooltip(doc), null);
    // The target leaves the page while its tooltip shows: the next refresh closes it.
    const tipB = attachTooltip(other, () => ({ title: 'B again' }), t);
    other.dispatchEvent(ev('focus', { bubbles: false }));
    assert.ok(openTooltip(doc));
    other.remove();
    tipB.refresh();
    assert.equal(openTooltip(doc), null);
    // No title: nothing to show.
    const empty = doc.createElement('button');
    doc.body.append(empty);
    attachTooltip(empty, () => null, t);
    empty.dispatchEvent(ev('focus', { bubbles: false }));
    assert.equal(openTooltip(doc), null);
  } finally {
    uninstallDom();
  }
});

test('tooltip: a touch long press opens it, swallows the click, and it closes after the finger lifts', () => {
  const { doc, button } = setup();
  try {
    const t = clock();
    let clicks = 0;
    attachTooltip(button, () => ({ title: 'Scatter', hotkey: 'Ctrl+X' }), t);
    button.addEventListener('click', () => clicks++);
    // A short tap is a normal click.
    button.dispatchEvent(ev('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    t.advance(LONG_PRESS_MS / 2);
    button.dispatchEvent(ev('pointerup', { pointerType: 'touch' }));
    const tap = ev('click');
    button.dispatchEvent(tap);
    assert.equal(tap.defaultPrevented, false);
    assert.equal(clicks, 1);
    assert.equal(openTooltip(doc), null);
    // Moving the finger is no long press.
    button.dispatchEvent(ev('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    button.dispatchEvent(ev('pointermove', { pointerType: 'touch', clientX: 40, clientY: 10 }));
    t.advance(LONG_PRESS_MS);
    assert.equal(openTooltip(doc), null);
    button.dispatchEvent(ev('pointerup', { pointerType: 'touch' }));
    // A long press.
    button.dispatchEvent(ev('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    t.advance(LONG_PRESS_MS);
    assert.equal(openTooltip(doc)?.text, 'Scatter (Ctrl+X)');
    const menu = ev('contextmenu');
    button.dispatchEvent(menu);
    assert.equal(menu.defaultPrevented, true, 'no browser menu over it');
    button.dispatchEvent(ev('pointerup', { pointerType: 'touch' }));
    const after = ev('click');
    button.dispatchEvent(after);
    assert.equal(after.defaultPrevented, true, 'reading the tooltip does not press the button');
    assert.equal(after.propagationStopped, true);
    assert.ok(openTooltip(doc), 'it stays a moment after the finger lifts');
    t.advance(TOUCH_HOLD_MS);
    assert.equal(openTooltip(doc), null);
    // A touch elsewhere closes it at once.
    button.dispatchEvent(ev('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 }));
    t.advance(LONG_PRESS_MS);
    button.dispatchEvent(ev('pointerup', { pointerType: 'touch' }));
    doc.body.dispatchEvent(ev('pointerdown', { pointerType: 'touch' }));
    assert.equal(openTooltip(doc), null);
  } finally {
    uninstallDom();
  }
});

test('tooltip: placement prefers its side, flips, and is never clipped by the viewport', () => {
  const vp = { width: 800, height: 600 };
  const size = { width: 200, height: 60 };
  // Command bar button at the bottom left: above it, slid right to stay inside.
  const low = placeTooltip({ left: 4, top: 540, right: 40, bottom: 576 }, size, vp, 'top');
  assert.equal(low.side, 'top');
  assert.ok(low.x >= 6 && low.y + size.height <= 540);
  // A HUD button at the top asking for the top: no room, so below.
  const high = placeTooltip({ left: 700, top: 4, right: 760, bottom: 30 }, size, vp, 'top');
  assert.equal(high.side, 'bottom');
  assert.ok(high.y >= 30 && high.x + size.width <= vp.width - 6, 'clamped to the right edge');
  // Sidebar cameo at the right edge: to its left.
  const card = placeTooltip({ left: 700, top: 300, right: 790, bottom: 360 }, size, vp, 'left');
  assert.equal(card.side, 'left');
  assert.ok(card.x + size.width <= 700);
  // Bigger than any side: still inside the viewport.
  const huge = placeTooltip({ left: 300, top: 250, right: 500, bottom: 350 }, { width: 900, height: 700 }, vp, 'left');
  assert.ok(huge.x >= 6 && huge.y >= 6);
  for (const s of ['top', 'bottom', 'left', 'right']) {
    for (const a of [
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 790, top: 590, right: 800, bottom: 600 },
    ]) {
      const p = placeTooltip(a, size, vp, s);
      assert.ok(p.x >= 6 && p.y >= 6 && p.x + size.width <= 794 && p.y + size.height <= 594, `${s} ${JSON.stringify(a)}`);
    }
  }
});

test('tooltip specs: command bar orders and stances show the bound key and follow rebinding', () => {
  const hotkeys = new HotkeyRegistry(createSettings());
  hotkeys.registerAction('guard', undefined, () => {}, { openra: 'Guard' });
  hotkeys.registerAction('stanceDefend', undefined, () => {}, { openra: 'StanceDefend' });
  const guard = COMMANDS.find((c) => c.id === 'guard');
  assert.deepEqual(commandTip(guard, boundKey(hotkeys, 'guard'), true), { title: 'Guard', hotkey: 'D', desc: guard.help, notes: [] });
  hotkeys.rebind('guard', 'G');
  assert.equal(commandTip(guard, boundKey(hotkeys, 'guard')).hotkey, 'G', 'the tooltip shows the new key');
  const force = COMMANDS.find((c) => c.id === 'forceAttack');
  assert.equal(commandTip(force, null).hotkey, 'Ctrl+click', 'modifier orders show their click');
  assert.match(tooltipText(commandTip(force, null, false)), /Select units/);
  const defend = STANCES.find((s) => s.id === 'defend');
  const spec = stanceTip(defend, boundKey(hotkeys, 'stanceDefend'), 'some', 'Alt+Q', true);
  assert.equal(spec.title, 'Defend');
  assert.equal(spec.hotkey, formatCombo('Alt+S'), 'Option+S on macOS');
  assert.match(tooltipText(spec), /Some of the selection/);
  assert.match(tooltipText(spec), /Alt\+Q cycles the stances/);
  // Every button of the bar has a name and a description.
  for (const c of COMMANDS) assert.ok(commandTip(c, null).title && commandTip(c, null).desc, c.id);
  for (const s of STANCES) assert.ok(stanceTip(s, null).title && stanceTip(s, null).desc, s.id);
});

test('tooltip specs: production cameo like OpenRA (name, key, cost, time, power, description, red when short)', () => {
  const powr = { name: 'Power Plant', description: 'Provides power for other structures.', cost: 300, power: 100, kind: 'building', queue: 0 };
  const tsla = { name: 'Tesla Coil', description: 'Advanced base defense.', cost: 1500, power: -100, kind: 'building', queue: 1 };
  const e1 = { name: 'Rifle Infantry', description: '', cost: 100, power: 0, kind: 'infantry', queue: 2 };
  const state = { funds: 1000, powerGenerated: 200, powerUsed: 150, lowPower: false };
  const spec = productionTip(powr, { enabled: true, requires: [], buildTicks: 250 }, state, { hotkey: 'F1', ticksPerSecond: 25, lowPowerModifier: 150 });
  assert.equal(spec.title, 'Power Plant');
  assert.equal(spec.hotkey, 'F1');
  assert.deepEqual(
    spec.stats.map((s) => [s.kind, s.text, s.bad]),
    [
      ['cost', '$300', false],
      ['time', '00:10', false],
      ['power', '+100', false],
    ],
  );
  assert.equal(spec.desc, powr.description);
  assert.equal(spec.requires, '');
  // Cannot afford, low power slows it, and the coil would overload the grid.
  const short = productionTip(tsla, { enabled: false, requires: ['Radar Dome'], buildTicks: 500 }, { ...state, lowPower: true }, { lowPowerModifier: 150 });
  assert.deepEqual(
    short.stats.map((s) => [s.kind, s.text, s.bad]),
    [
      ['cost', '$1500', true],
      ['time', '00:30', true],
      ['power', '-100', true],
    ],
  );
  assert.equal(short.requires, 'Requires Radar Dome');
  assert.equal(short.hotkey, null);
  // No power stat for units; exclusive items say whose they are.
  const inf = productionTip(e1, { enabled: false, exclusive: 'Soviet only', buildTicks: 100 }, state);
  assert.deepEqual(inf.stats.map((s) => s.kind), ['cost', 'time']);
  assert.equal(inf.requires, 'Soviet only');
  assert.match(tooltipText(inf), /Shift: 5 at a time/);
  assert.equal(formatPower(0), '0');
});

test('tooltip specs: support powers, production tabs and the HUD buttons', () => {
  const hotkeys = new HotkeyRegistry(createSettings());
  const p = { name: 'Spy Plane', description: 'Reveals an area of the map.', ready: false, charging: true, remainingTicks: 25 * 75 };
  assert.equal(tooltipText(powerTip(p, 'F5', 25)), 'Spy Plane (F5)\nReveals an area of the map.\nCharging: 1:15 left.');
  assert.match(tooltipText(powerTip({ ...p, ready: true }, null, 25)), /^Spy Plane\n/);
  assert.equal(powerTip({ ...p, charging: false }, null, 25).notes[0].tone, 'warn');
  assert.deepEqual(tabTip({ name: 'Infantry', state: 'available', activity: 2, ready: false }, 'T'), { title: 'Infantry', hotkey: 'T', desc: '2 in production.' });
  assert.match(tabTip({ name: 'Naval', state: 'no-producer', activity: 0, ready: false }, 'I').desc, /No production building/);
  assert.equal(menuKeys(hotkeys), 'Esc');
  hotkeys.registerAction('menu', ['F10'], () => {});
  hotkeys.registerAction('debugMenu', ['`'], () => {});
  assert.equal(menuKeys(hotkeys), 'Esc, F10');
  assert.equal(menuTip(hotkeys, false).title, 'Game menu');
  assert.equal(menuTip(hotkeys, true).title, 'Resume');
  assert.equal(debugTip(hotkeys, false).hotkey, '`');
  hotkeys.rebind('debugMenu', 'F9');
  assert.equal(debugTip(hotkeys, true).hotkey, 'F9');
  assert.notEqual(sidebarToggleTip(true).title, sidebarToggleTip(false).title);
});

test('tooltip: the replaced title attributes are gone and the stylesheet is linked', () => {
  const html = read('../index.html');
  assert.match(html, /css\/tooltip\.css/);
  assert.doesNotMatch(html, /id="menu-button"[^>]*title=/);
  for (const file of ['commandbar.js', 'sidebar.js', 'powers.js', 'layout.js']) {
    assert.doesNotMatch(read(`../js/${file}`), /\.title = /, `${file} still sets a title attribute`);
  }
  assert.ok(!read('../js/debug.js').includes('this.button.title'), 'the Debug button has the shared tooltip');
  const lobby = read('../js/lobby.js');
  for (const name of ['this.button.title', 'this.diceBtn.title', 'remove.title', 'node.title']) assert.ok(!lobby.includes(name), name);
  const css = read('../css/tooltip.css');
  // The hotkey in yellow (OpenRA TextColor FFFF00, the Tooltips board's #f2d64b as --ui-tip-key).
  assert.match(css, /\.ui-tooltip-key \{[^}]*color: var\(--ui-tip-key\)/);
  assert.match(read('../css/theme.css'), /--ui-tip-key: #f2d64b;/);
  assert.match(css, /pointer-events: none/);
  assert.doesNotMatch(read('../js/ui/tooltip.js'), /innerHTML|setAttribute\('style'/);
});

test('tooltip under mouse capture: the virtual pointer hovers, waits the delay, presses through, and nothing is intercepted', async () => {
  const { VirtualPointer } = await import('../js/mouselock.js');
  const { doc, button } = setup();
  try {
    const t = clock();
    const bar = doc.createElement('div');
    const other = doc.createElement('button');
    const map = doc.createElement('canvas');
    doc.body.append(bar, map);
    bar.append(button, other);
    // Hit map: the tooltip panel is never hit (pointer-events: none in css/tooltip.css).
    doc.elementFromPoint = (x) => (x < 100 ? button : x < 200 ? other : map);
    attachTooltip(button, () => ({ title: 'Guard', hotkey: 'D' }), t);
    attachTooltip(other, () => ({ title: 'Stop', hotkey: 'S' }), t);
    // What the page's own listeners see of the replayed events.
    const seen = [];
    for (const [node, name] of [
      [button, 'button'],
      [bar, 'bar'],
      [doc, 'doc'],
    ]) {
      for (const type of ['pointerenter', 'pointerleave', 'pointerdown', 'pointerup', 'mousedown', 'click']) {
        node.addEventListener(type, (e) => seen.push(`${name}:${type}${e.defaultPrevented ? ':prevented' : ''}`));
      }
    }
    const p = new VirtualPointer({ doc, win: globalThis.window, makeEvent: (type, init) => new FakeEvent(type, init), now: () => 0 });
    p.place(500, 10);
    p.moveBy(-450, 0, 1000, 700);
    assert.equal(p.hovered, button);
    assert.equal(button.getAttribute('data-vhover'), '', 'the :hover stand-in');
    assert.ok(seen.includes('button:pointerenter') && seen.includes('bar:pointerenter'), 'the replayed enter reaches the page');
    assert.equal(openTooltip(doc), null, 'the hover delay holds for the virtual pointer too');
    t.advance(TOOLTIP_DELAY_MS);
    assert.equal(openTooltip(doc)?.text, 'Guard (D)');
    assert.ok(openTooltip(doc).panel !== doc.elementFromPoint(50, 10), 'the panel is not what the pointer hits');
    // To the neighbour: switches at once; out to the map: closes.
    p.moveBy(100, 0, 1000, 700);
    assert.equal(openTooltip(doc)?.text, 'Stop (S)');
    p.moveBy(-100, 0, 1000, 700);
    assert.equal(openTooltip(doc)?.text, 'Guard (D)');
    // A press goes through: the tooltip closes, the page gets every event, unprevented.
    seen.length = 0;
    p.down(0);
    p.up(0);
    assert.equal(openTooltip(doc), null, 'pressing closes it, like a real mouse');
    for (const e of ['button:pointerdown', 'bar:pointerdown', 'doc:pointerdown', 'button:mousedown', 'button:pointerup', 'button:click', 'bar:click', 'doc:click']) {
      assert.ok(seen.includes(e), `${e} reached the page (${seen.join(', ')})`);
    }
    assert.ok(!seen.some((e) => e.endsWith(':prevented')), 'no replayed event was cancelled');
    // Leaving to the map: the leave reaches the page and no tooltip opens later.
    seen.length = 0;
    t.advance(TOOLTIP_WARM_MS);
    p.moveBy(450, 0, 1000, 700);
    assert.ok(seen.includes('button:pointerleave') && seen.includes('bar:pointerleave'));
    t.advance(TOOLTIP_DELAY_MS * 2);
    assert.equal(openTooltip(doc), null);
    assert.equal(button.getAttribute('aria-describedby'), null);
    // Keyboard focus still opens it while the mouse is captured.
    button.dispatchEvent(ev('focus', { bubbles: false }));
    assert.equal(openTooltip(doc)?.text, 'Guard (D)');
  } finally {
    uninstallDom();
  }
});
