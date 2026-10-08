// Settings, hotkey registry, control groups and the game menu state: plain
// modules, no DOM. Run with: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettings, SCHEMA } from '../js/settings.js';
import { HotkeyRegistry, comboFromEvent, normalizeCombo, formatCombo, isReservedCombo, keyName } from '../js/hotkeys.js';
import { ControlGroups, groupKeyFromEvent, groupCommand, DOUBLE_TAP_MS } from '../js/controlgroups.js';
import { MenuState, fixedControls, speedLabel } from '../js/gamemenu.js';

/** In-memory Web Storage stand-in; `fail` makes every call throw. */
function memoryStorage(initial = {}, fail = false) {
  const data = new Map(Object.entries(initial));
  const guard = () => {
    if (fail) throw new Error('SecurityError');
  };
  return {
    data,
    getItem: (k) => (guard(), data.has(k) ? data.get(k) : null),
    setItem: (k, v) => (guard(), data.set(k, String(v))),
  };
}

const key = (code, keyValue, mods = {}) => ({ code, key: keyValue, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...mods });

// ---- settings.js ---------------------------------------------------------------

test('settings: defaults, clamping, persistence and wrong types', () => {
  const storage = memoryStorage();
  const s = createSettings(storage);
  assert.equal(s.get('edgeScrollSpeed'), 1);
  assert.equal(s.get('keyScrollSpeed'), 1);
  assert.equal(s.get('showUnitPaths'), false);
  assert.deepEqual(s.get('hotkeys'), {});
  assert.equal(s.set('edgeScrollSpeed', 99), SCHEMA.edgeScrollSpeed.max);
  assert.equal(s.set('keyScrollSpeed', 0), SCHEMA.keyScrollSpeed.min);
  assert.equal(s.set('edgeScrollSpeed', 'fast'), 1, 'not a number: default');
  assert.equal(s.set('showUnitPaths', true), true);
  assert.equal(s.set('showUnitPaths', 'yes'), false, 'not a boolean: default');
  s.set('showUnitPaths', true);
  s.set('edgeScrollSpeed', 2.5);
  const again = createSettings(storage);
  assert.equal(again.get('edgeScrollSpeed'), 2.5);
  assert.equal(again.get('showUnitPaths'), true);
  assert.throws(() => s.get('nope'), /Unknown setting/);
  assert.throws(() => s.set('nope', 1), /Unknown setting/);
});

test('settings: choices keep one of their options (health bars)', () => {
  const storage = memoryStorage();
  const s = createSettings(storage);
  assert.equal(s.get('healthBars'), 'off');
  assert.deepEqual(SCHEMA.healthBars.options, ['off', 'damaged', 'all']);
  assert.equal(s.set('healthBars', 'damaged'), 'damaged');
  assert.equal(createSettings(storage).get('healthBars'), 'damaged', 'persisted');
  assert.equal(s.set('healthBars', 'sometimes'), 'off', 'unknown option: default');
  assert.equal(s.set('healthBars', 2), 'off', 'not an option: default');
  assert.equal(s.set('healthBars', 'all'), 'all');
  assert.equal(s.reset('healthBars'), 'off');
});

test('settings: corrupt or throwing storage falls back to defaults and keeps working', () => {
  const corrupt = createSettings(memoryStorage({ 'webra.settings': '{not json' }));
  assert.equal(corrupt.get('edgeScrollSpeed'), 1);
  const broken = createSettings(memoryStorage({}, true));
  assert.equal(broken.get('keyScrollSpeed'), 1);
  assert.equal(broken.set('keyScrollSpeed', 2), 2, 'still applies for the session');
  assert.equal(broken.get('keyScrollSpeed'), 2);
  const none = createSettings(null);
  assert.equal(none.set('showUnitPaths', true), true);
});

test('settings: unknown stored keys survive a save; objects are copies', () => {
  const storage = memoryStorage({ 'webra.settings': JSON.stringify({ futureKey: 7, edgeScrollSpeed: 0.5 }) });
  const s = createSettings(storage);
  assert.equal(s.get('edgeScrollSpeed'), 0.5);
  s.set('keyScrollSpeed', 2);
  assert.equal(JSON.parse(storage.data.get('webra.settings')).futureKey, 7);
  const hk = s.get('hotkeys');
  hk.attackMove = ['X'];
  assert.deepEqual(s.get('hotkeys'), {}, 'mutating a returned object changes nothing');
});

test('settings: subscribe to all keys or one key, unsubscribe, no call without a change', () => {
  const s = createSettings(null);
  const all = [];
  const one = [];
  const offAll = s.subscribe((k, v) => all.push([k, v]));
  const offOne = s.subscribe('showUnitPaths', (v) => one.push(v));
  s.set('showUnitPaths', true);
  s.set('showUnitPaths', true); // unchanged
  s.set('edgeScrollSpeed', 2);
  assert.deepEqual(all, [['showUnitPaths', true], ['edgeScrollSpeed', 2]]);
  assert.deepEqual(one, [true]);
  offAll();
  offOne();
  s.reset('showUnitPaths');
  assert.equal(all.length, 2);
  assert.equal(one.length, 1);
  assert.throws(() => s.subscribe('nope', () => {}), /Unknown setting/);
});

// ---- hotkeys.js ------------------------------------------------------------------

test('hotkeys: combos from events (layout letters, Cmd as Ctrl, digits by code)', () => {
  assert.equal(comboFromEvent(key('KeyA', 'a')), 'A');
  assert.equal(comboFromEvent(key('KeyQ', 'a')), 'A', 'AZERTY: the printed letter');
  assert.equal(comboFromEvent(key('KeyQ', 'œ', { altKey: true })), 'Alt+Q', 'Option on macOS: the key position');
  assert.equal(comboFromEvent(key('KeyX', 'x', { metaKey: true })), 'Ctrl+X');
  assert.equal(comboFromEvent(key('Digit1', '&', { shiftKey: true })), 'Shift+1');
  assert.equal(comboFromEvent(key('Enter', 'Enter', { altKey: true })), 'Alt+Enter');
  assert.equal(comboFromEvent(key('Space', ' ')), 'Space');
  assert.equal(comboFromEvent(key('BracketRight', ']')), ']');
  assert.equal(comboFromEvent(key('F1', 'F1', { shiftKey: true })), 'Shift+F1');
  assert.equal(comboFromEvent(key('ShiftLeft', 'Shift', { shiftKey: true })), null);
  assert.equal(keyName(key('Numpad5', '5')), 'Numpad5');
  assert.equal(normalizeCombo('shift+ctrl+x'), 'Ctrl+Shift+X');
  assert.equal(normalizeCombo('cmd+f2'), 'Ctrl+F2');
  assert.equal(normalizeCombo('Hyper+X'), null);
  assert.equal(formatCombo('Ctrl+Alt+X', true), 'Cmd+Option+X');
  assert.equal(formatCombo('Ctrl+Alt+X', false), 'Ctrl+Alt+X');
  assert.equal(formatCombo('Alt+ArrowUp', false), 'Alt+Up');
});

function registry() {
  const settings = createSettings(memoryStorage());
  return { settings, reg: new HotkeyRegistry(settings) };
}

test('hotkeys: register, dispatch, repeat and inputs', () => {
  const { reg } = registry();
  const calls = [];
  reg.registerAction('attackMove', 'A', () => calls.push('a'));
  reg.registerAction('zoomIn', ']', () => calls.push('zoom'), { repeat: true });
  reg.registerAction('nextTab', 'Tab', () => calls.push('tab'), { inControls: false });
  let prevented = 0;
  const ev = (code, k, mods = {}, target = { tagName: 'BODY' }) => ({ ...key(code, k, mods), target, preventDefault: () => prevented++ });
  assert.equal(reg.handle(ev('KeyA', 'a')), true);
  assert.equal(reg.handle(ev('KeyA', 'a', { repeat: true })), true, 'held key: swallowed, not repeated');
  assert.equal(reg.handle(ev('BracketRight', ']', { repeat: true })), true);
  assert.equal(reg.handle(ev('KeyB', 'b')), false, 'unbound');
  assert.equal(reg.handle(ev('KeyA', 'a', {}, { tagName: 'INPUT' })), false, 'typing in a field');
  assert.equal(reg.handle(ev('KeyA', 'a', {}, { tagName: 'BUTTON' })), true, 'a focused button does not block hotkeys');
  assert.equal(reg.handle(ev('Tab', 'Tab', {}, { tagName: 'BUTTON' })), false, 'Tab keeps moving focus between buttons');
  assert.equal(reg.handle(ev('Tab', 'Tab')), true);
  assert.deepEqual(calls, ['a', 'zoom', 'a', 'tab']);
  assert.equal(prevented, 5);
  assert.throws(() => reg.registerAction('attackMove', 'B', () => {}), /already registered/);
  assert.throws(() => reg.registerAction('x', 'Bogus+Q', () => {}), /bad key/);
  assert.throws(() => reg.registerAction('y', 'Q'), /needs a handler/);
});

test('hotkeys: primary keys beat extra default keys, whatever the registration order', () => {
  const { reg } = registry();
  // WebRA's deploy keeps D as an extra key; a later command bar registers guard on D (OpenRA).
  reg.registerAction('deploy', ['F', 'D'], () => {});
  assert.equal(reg.actionFor('D'), 'deploy');
  const off = reg.registerAction('guard', 'D', () => {});
  assert.equal(reg.actionFor('D'), 'guard');
  assert.deepEqual(reg.bindingsFor('deploy'), ['F']);
  off();
  assert.equal(reg.actionFor('D'), 'deploy', 'unregistering gives the key back');
  // Two primaries: the first registered keeps it.
  reg.registerAction('one', 'K', () => {});
  reg.registerAction('two', 'K', () => {});
  assert.equal(reg.actionFor('K'), 'one');
  assert.deepEqual(reg.bindingsFor('two'), []);
});

test('hotkeys: rebinding persists, moves a key from its old action, and resets', () => {
  const { settings, reg } = registry();
  const calls = [];
  reg.registerAction('attackMove', 'A', () => calls.push('attackMove'));
  reg.registerAction('stop', 'S', () => calls.push('stop'));
  reg.registerAction('deploy', ['F', 'D'], () => calls.push('deploy'));
  assert.deepEqual(reg.rebind('stop', 'ctrl+s'), { ok: true, displaced: null });
  assert.equal(reg.actionFor('S'), null);
  assert.equal(reg.actionFor('Ctrl+S'), 'stop');
  assert.deepEqual(settings.get('hotkeys'), { stop: ['Ctrl+S'] });
  // Taking a key of another action: that action keeps its other keys.
  assert.deepEqual(reg.rebind('attackMove', 'F'), { ok: true, displaced: 'deploy' });
  assert.deepEqual(reg.bindingsFor('deploy'), ['D']);
  assert.deepEqual(reg.bindingsFor('attackMove'), ['F']);
  // A fresh registry over the same settings sees the saved bindings.
  const reg2 = new HotkeyRegistry(settings);
  reg2.registerAction('attackMove', 'A', () => {});
  reg2.registerAction('stop', 'S', () => {});
  reg2.registerAction('deploy', ['F', 'D'], () => {});
  assert.equal(reg2.actionFor('F'), 'attackMove');
  assert.equal(reg2.actionFor('Ctrl+S'), 'stop');
  assert.equal(reg2.actionFor('A'), null);
  // A user binding wins over another action's default key.
  reg.rebind('stop', 'A');
  assert.equal(reg.actionFor('A'), 'stop');
  reg.unbind('stop');
  assert.deepEqual(reg.bindingsFor('stop'), []);
  assert.equal(reg.actionFor('A'), null, 'attackMove was rebound to F, so A stays free');
  reg.reset('stop');
  assert.deepEqual(reg.bindingsFor('stop'), ['S']);
  reg.reset();
  assert.deepEqual(settings.get('hotkeys'), {});
  assert.deepEqual(reg.bindingsFor('deploy'), ['F', 'D']);
  assert.deepEqual(
    reg.list().map((a) => [a.name, a.keys]),
    [
      ['attackMove', ['A']],
      ['stop', ['S']],
      ['deploy', ['F', 'D']],
    ],
  );
});

test('hotkeys: reserved and browser keys cannot be bound; listeners hear changes', () => {
  const { reg } = registry();
  reg.registerAction('stop', 'S', () => {});
  let changes = 0;
  reg.onChange(() => changes++);
  for (const combo of ['Escape', '1', 'Ctrl+1', 'Shift+0', 'Numpad5', 'ArrowUp', 'Enter', 'Ctrl+W', 'Ctrl+T', 'F11']) {
    assert.ok(isReservedCombo(normalizeCombo(combo)), combo);
    const r = reg.rebind('stop', combo);
    assert.equal(r.ok, false, combo);
  }
  assert.equal(isReservedCombo('Alt+ArrowUp'), null);
  assert.equal(isReservedCombo('Alt+Enter'), null);
  assert.equal(reg.rebind('nope', 'X').ok, false);
  assert.equal(changes, 0);
  reg.rebind('stop', 'X');
  assert.equal(changes, 1);
});

// ---- controlgroups.js ---------------------------------------------------------------

test('control groups: digit row only, Ctrl/Cmd assigns, Shift adds, Alt is left alone', () => {
  assert.equal(groupKeyFromEvent(key('Digit1', '&')), '1', 'AZERTY digit row');
  assert.equal(groupKeyFromEvent(key('Digit0', '0')), '0');
  assert.equal(groupKeyFromEvent(key('Numpad1', '1')), null, 'the numpad drives the sidebar');
  assert.equal(groupCommand(key('Digit1', '1', { ctrlKey: true })), 'assign');
  assert.equal(groupCommand(key('Digit1', '1', { metaKey: true })), 'assign');
  assert.equal(groupCommand(key('Digit1', '!', { shiftKey: true })), 'add');
  assert.equal(groupCommand(key('Digit1', '1')), 'select');
  assert.equal(groupCommand(key('Digit1', '1', { altKey: true })), null);
});

test('control groups: one group per unit, dead units drop out, double tap centres', () => {
  const g = new ControlGroups();
  g.assign('1', [10, 11, 12]);
  g.assign('2', [12, 13]);
  assert.deepEqual(g.members('1'), [10, 11], 'unit 12 moved to group 2');
  assert.deepEqual(g.members('2'), [12, 13]);
  const alive = new Set([10, 12, 13]);
  const filter = (ids) => ids.filter((id) => alive.has(id));
  let r = g.recall('1', 1000, filter);
  assert.deepEqual(r, { ids: [10], center: false });
  r = g.recall('1', 1000 + DOUBLE_TAP_MS - 1, filter);
  assert.deepEqual(r, { ids: [10], center: true }, 'second quick press');
  r = g.recall('1', 1000 + DOUBLE_TAP_MS, filter);
  assert.equal(r.center, false, 'a third press starts over');
  r = g.recall('2', 5000, filter);
  r = g.recall('1', 5100, filter);
  assert.equal(r.center, false, 'another key in between');
  r = g.recall('1', 9000, filter);
  r = g.recall('1', 9000 + DOUBLE_TAP_MS + 1, filter);
  assert.equal(r.center, false, 'too slow');
  alive.delete(10);
  assert.deepEqual(g.recall('1', 20000, filter), { ids: [], center: false });
  assert.equal(g.has('1'), false, 'an all dead group is gone');
  alive.add(10);
  assert.deepEqual(g.members('1', filter), [], 'dead ids never come back');
  g.assign('2', []);
  assert.equal(g.has('2'), false, 'Ctrl+number with nothing selected clears the group');
});

// ---- gamemenu.js --------------------------------------------------------------------

test('game menu: single player pauses while open, online never pauses', () => {
  const log = [];
  const sp = new MenuState({ online: false, onChange: (open, paused) => log.push(['sp', open, paused]) });
  assert.equal(sp.open(), true);
  assert.equal(sp.paused, true);
  assert.equal(sp.open(), false, 'already open');
  sp.toggle();
  assert.equal(sp.paused, false);
  const mp = new MenuState({ online: true, onChange: (open, paused) => log.push(['mp', open, paused]) });
  mp.toggle();
  assert.equal(mp.isOpen, true);
  assert.equal(mp.paused, false);
  mp.close();
  assert.deepEqual(log, [
    ['sp', true, true],
    ['sp', false, false],
    ['mp', true, false],
    ['mp', false, false],
  ]);
});

test('game menu: fixed controls list the control groups with the right modifier', () => {
  const mac = fixedControls(true).map(([k]) => k);
  const pc = fixedControls(false).map(([k]) => k);
  assert.ok(mac.includes('Cmd (or Ctrl) + 1..9, 0'));
  assert.ok(pc.includes('Ctrl + 1..9, 0'));
  assert.ok(pc.includes('Shift + 1..9, 0'));
  assert.equal(speedLabel(0), 'Off');
  assert.equal(speedLabel(1.25), '1.25x');
});
