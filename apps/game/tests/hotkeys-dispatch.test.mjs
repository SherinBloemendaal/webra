// Every hotkey through the path the game uses: a keydown on the focused
// element, its way up to the window, js/input.js's window listener and the
// registry (js/hotkeys.js), with every action of a game mode registered
// (js/input.js, the command bar's js/commandbar.js keys, js/gamekeys.js and
// the chat keys of js/chatkeys.js). Table driven: for every bindable action,
// its default key must reach its handler, whatever has the focus, except the
// keys a focused control uses itself (each case says which and why).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, FakeEvent } from './dom-fixtures.mjs';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { createSettings as settingsOver } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';
import { registerGameKeys } from '../js/gamekeys.js';
import { COMMAND_HOTKEYS } from '../js/commandbar.js';
import { CHAT_HOTKEYS } from '../js/chatkeys.js';

const NONE = 0xffffffff;
const createSettings = () => settingsOver(createRegistry({ storage: null }));

/** The engine queries js/input.js uses for its hotkeys (nothing on the map). */
function fakeGame() {
  return new Proxy(
    { map_width: () => 64, map_height: () => 64, pick: () => NONE, actor_json: () => 'null', queue_producer: () => NONE },
    { get: (o, k) => (k in o ? o[k] : typeof k === 'string' ? () => new Uint32Array(0) : undefined) },
  );
}

/**
 * A game screen: the fake document (events go from the focused element up to
 * the window), the input with its window listeners and every hotkey of a
 * player (or spectator) game in one registry.
 */
async function gameScreen({ spectator = false } = {}) {
  const doc = installDom({ windowEvents: true });
  const { Input } = await import('../js/input.js');
  const canvas = doc.createElement('canvas');
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
  doc.body.append(canvas);
  const hotkeys = new HotkeyRegistry(createSettings());
  const input = new Input(canvas, fakeGame(), { actors: [] }, 0, {}, { hotkeys, settings: createSettings(), spectator });
  if (!spectator) for (const h of COMMAND_HOTKEYS) hotkeys.registerAction(h.name, h.keys, () => {}, { openra: h.openra, label: h.label, group: h.group });
  registerGameKeys(hotkeys, new Proxy({}, { get: () => () => {} }), { spectator });
  for (const h of CHAT_HOTKEYS) hotkeys.registerAction(h.name, undefined, () => {}, { openra: h.openra, inControls: false, listOnly: h.listOnly });
  return { doc, input, hotkeys };
}

/** Replace every handler with one that logs its action (the real ones are tested elsewhere). */
function recordHandlers(hotkeys) {
  const hits = [];
  for (const a of hotkeys.actions.values()) a.handler = () => hits.push(a.name);
  return hits;
}

const CODES = { Space: ['Space', ' '], '[': ['BracketLeft', '['], ']': ['BracketRight', ']'], '.': ['Period', '.'], ',': ['Comma', ','], '-': ['Minus', '-'], '=': ['Equal', '='], '`': ['Backquote', '`'] };

/**
 * The keydown a combo is pressed with on a US layout ("Ctrl+X": code KeyX,
 * key "x"); `letter` gives the character a letter key types instead (another
 * layout, Option on macOS).
 */
function keyEvent(combo, { letter = null, type = 'keydown' } = {}) {
  const parts = combo.split('+');
  const k = parts.pop();
  const mods = new Set(parts);
  let code = k;
  let key = k;
  if (/^[A-Z]$/.test(k)) {
    code = `Key${k}`;
    key = letter ?? (mods.has('Shift') ? k : k.toLowerCase());
  } else if (/^[0-9]$/.test(k)) code = `Digit${k}`;
  else if (CODES[k]) [code, key] = CODES[k];
  else if (k.startsWith('Numpad')) key = k === 'NumpadEnter' ? 'Enter' : k;
  else if (/^F[0-9]+$/.test(k) || k.startsWith('Arrow') || k.startsWith('Media')) key = k;
  else if (k === 'Pause' || k === 'Home' || k === 'Tab' || k === 'Enter') key = k;
  return new FakeEvent(type, { code, key, ctrlKey: mods.has('Ctrl'), metaKey: false, altKey: mods.has('Alt'), shiftKey: mods.has('Shift'), repeat: false, cancelable: true });
}

/** Press `combo` on `el` (and let go): which actions ran, and whether the key was held. */
function press(screen, hits, el, combo, opts) {
  hits.length = 0;
  const down = keyEvent(combo, opts);
  el.dispatchEvent(down);
  const held = [...screen.hotkeys.held.values()];
  el.dispatchEvent(keyEvent(combo, { ...opts, type: 'keyup' }));
  return { ran: hits.slice(), held, prevented: down.defaultPrevented };
}

/** Every action with a key, as [action, combo] (the chat line's own keys are its text field's). */
function bindings(hotkeys) {
  const out = [];
  for (const a of hotkeys.list()) {
    if (hotkeys.actions.get(a.name).listOnly) continue;
    for (const k of a.keys) out.push([a.name, k]);
  }
  return out;
}

/**
 * Pressing every bound key on `el`: the actions whose key did not reach them,
 * as "action (key)", leaving out the keys `keeps` says the element uses.
 */
function missed(screen, hits, el, keeps = () => false, opts = {}) {
  const out = [];
  for (const [name, combo] of bindings(screen.hotkeys)) {
    if (keeps(name, combo)) continue;
    const { ran, held } = press(screen, hits, el, combo, opts);
    const ok = screen.hotkeys.actions.get(name).hold ? held.includes(name) && ran.length === 0 : ran.length === 1 && ran[0] === name;
    if (!ok) out.push(`${name} (${combo})${ran.length ? ` ran ${ran.join(', ')}` : ''}`);
  }
  return out;
}

/**
 * Focus `el` the way the player does: with a key (Tab, or a dialog closed
 * with Esc that hands the focus back) or with a mouse press on it.
 */
function focusFrom(el, keyboard) {
  el.dispatchEvent(keyboard ? new FakeEvent('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true }) : new FakeEvent('pointerdown'));
  el.focus();
  el.dispatchEvent(new FakeEvent('focusin'));
  return el;
}

function control(doc, tag, attrs = {}) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  doc.body.append(el);
  return el;
}

const NAV = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const keyOf = (combo) => combo.split('+').pop();
const plain = (combo) => !combo.includes('+');

test('every hotkey reaches its action from the battlefield, as a player and as a spectator', async () => {
  for (const spectator of [false, true]) {
    const screen = await gameScreen({ spectator });
    const hits = recordHandlers(screen.hotkeys);
    assert.ok(bindings(screen.hotkeys).length > (spectator ? 50 : 120), 'every mode registers its hotkeys');
    assert.deepEqual(missed(screen, hits, screen.doc.body), [], spectator ? 'spectator' : 'player');
    assert.deepEqual(missed(screen, hits, screen.doc.querySelector('canvas')), []);
    uninstallDom();
  }
});

test('the sidebar tools: C repair, Z sell, X power down and B beacon switch the mode, the key again ends it', async () => {
  const screen = await gameScreen();
  const { input, doc } = screen;
  const modes = [];
  input.hooks.onMode = (m) => modes.push(m);
  const tool = focusFrom(control(doc, 'button', { class: 'sb-tool sb-tool-repair' }), false);
  for (const [combo, mode] of [['C', 'repair'], ['Z', 'sell'], ['X', 'powerDown'], ['B', 'beacon']]) {
    for (const el of [doc.body, tool]) {
      press(screen, [], el, combo);
      assert.equal(input.mode, mode, `${combo} on ${el.tagName}`);
      press(screen, [], el, combo);
      assert.equal(input.mode, null, `${combo} again`);
    }
  }
  assert.deepEqual(modes.slice(0, 2), ['repair', null]);
  uninstallDom();
});

test('other keyboard layouts and macOS Option: the key printed on it, or its place', async () => {
  const screen = await gameScreen();
  const hits = recordHandlers(screen.hotkeys);
  const body = screen.doc.body;
  // Russian layout: the C key types "с" (Cyrillic): the key's place counts.
  assert.deepEqual(press(screen, hits, body, 'C', { letter: 'с' }).ran, ['repair']);
  // Caps Lock types capitals.
  assert.deepEqual(press(screen, hits, body, 'Z', { letter: 'Z' }).ran, ['sell']);
  // Option+A types "å" on a Mac: still the Attack anything stance (OpenRA Alt+A).
  assert.deepEqual(press(screen, hits, body, 'Alt+A', { letter: 'å' }).ran, ['stanceAttackAnything']);
  // Option+E is a dead key on a Mac ("Dead"): still bookmark 3 (OpenRA Alt+E).
  assert.deepEqual(press(screen, hits, body, 'Alt+E', { letter: 'Dead' }).ran, ['bookmarkJump3']);
  // AZERTY: the key printed A (where QWERTY has Q) is A.
  const azerty = new FakeEvent('keydown', { code: 'KeyQ', key: 'a', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false });
  hits.length = 0;
  body.dispatchEvent(azerty);
  assert.deepEqual(hits, ['attackMove']);
  uninstallDom();
});

test('a button clicked with the mouse leaves the keyboard to the game, Tab included', async () => {
  const screen = await gameScreen();
  const hits = recordHandlers(screen.hotkeys);
  // Browsers keep the focus on a clicked button: Tab is
  // the production facility, Enter opens the chat, Space jumps to the last event.
  const clicked = focusFrom(control(screen.doc, 'button', { class: 'sb-tool sb-tool-sell' }), false);
  assert.deepEqual(missed(screen, hits, clicked), []);
  uninstallDom();
});

test('a button reached with Tab keeps Tab, Shift+Tab and Enter (focus moves, the button is pressed)', async () => {
  const screen = await gameScreen();
  const hits = recordHandlers(screen.hotkeys);
  const tabbed = focusFrom(control(screen.doc, 'button', { class: 'cb-button' }), true);
  const notInControls = new Set([...screen.hotkeys.actions.values()].filter((a) => !a.inControls).map((a) => a.name));
  assert.deepEqual(missed(screen, hits, tabbed, (name) => notInControls.has(name)), []);
  for (const name of notInControls) {
    for (const combo of screen.hotkeys.bindingsFor(name)) {
      const r = press(screen, hits, tabbed, combo);
      assert.deepEqual(r.ran, [], `${combo} stays with the focused button`);
      assert.equal(r.prevented, false, `${combo}: the browser's own action runs`);
    }
  }
  uninstallDom();
});

test('a focused switch, slider or list keeps only the keys it uses itself', async () => {
  const screen = await gameScreen();
  const hits = recordHandlers(screen.hotkeys);
  const { doc } = screen;
  // The debug menu's switches (js/ui/controls.js switchInput): Space toggles it.
  const box = focusFrom(control(doc, 'input', { type: 'checkbox', role: 'switch', class: 'ui-switch' }), false);
  assert.deepEqual(missed(screen, hits, box, (_n, combo) => combo === 'Space'), []);
  assert.deepEqual(press(screen, hits, box, 'Space').ran, [], 'Space toggles the switch');
  // The replay's seek bar (js/records.js): the arrows, Home and End move it.
  const seek = focusFrom(control(doc, 'input', { type: 'range', class: 'replay-seek' }), false);
  assert.deepEqual(missed(screen, hits, seek, (_n, combo) => plain(combo) && NAV.has(keyOf(combo))), []);
  // The observer's panel list (js/observer.js): arrows, Home, End, Space and
  // Enter (also the keypad's, Quick save) work the list.
  const list = focusFrom(control(doc, 'select', { class: 'observer-toggle' }), false);
  assert.deepEqual(missed(screen, hits, list, (_n, combo) => plain(combo) && (NAV.has(keyOf(combo)) || ['Space', 'Enter', 'NumpadEnter'].includes(keyOf(combo)))), []);
  uninstallDom();
});

test('text fields keep every key while they show; a hidden one keeps none', async () => {
  const screen = await gameScreen();
  const hits = recordHandlers(screen.hotkeys);
  const { doc } = screen;
  // The chat line or a save name: typing.
  const field = focusFrom(control(doc, 'input', { type: 'text' }), true);
  for (const [name, combo] of bindings(screen.hotkeys)) assert.deepEqual(press(screen, hits, field, combo).ran, [], `${name} (${combo}) while typing`);
  const area = focusFrom(control(doc, 'textarea'), true);
  assert.deepEqual(press(screen, hits, area, 'C').ran, []);
  // The lobby's name field after the game started: the lobby is hidden, and
  // some browsers keep the focus in it.
  const lobby = control(doc, 'div', { class: 'lobby' });
  const name = doc.createElement('input');
  name.setAttribute('type', 'text');
  lobby.append(name);
  focusFrom(name, false);
  lobby.hidden = true;
  assert.deepEqual(missed(screen, hits, name), []);
  // A read-only field takes no typing either.
  const ro = focusFrom(control(doc, 'input', { type: 'text', readonly: '' }), false);
  ro.readOnly = true;
  assert.deepEqual(press(screen, hits, ro, 'C').ran, ['repair']);
  uninstallDom();
});

test('Esc cancels a sidebar mode from a focused switch too', async () => {
  const screen = await gameScreen();
  const box = focusFrom(control(screen.doc, 'input', { type: 'checkbox' }), false);
  press(screen, [], box, 'C');
  assert.equal(screen.input.mode, 'repair');
  box.dispatchEvent(new FakeEvent('keydown', { code: 'Escape', key: 'Escape', cancelable: true }));
  assert.equal(screen.input.mode, null);
  uninstallDom();
});

test('a click on the button that has the keyboard focus gives Tab and Enter back to the game', async () => {
  const screen = await gameScreen();
  const hits = recordHandlers(screen.hotkeys);
  const button = focusFrom(control(screen.doc, 'button', { class: 'sb-tool' }), true);
  assert.deepEqual(press(screen, hits, button, 'Tab').ran, [], 'reached with Tab: Tab moves the focus on');
  // Clicked while focused: no focusin, the focus stays where it is.
  button.dispatchEvent(new FakeEvent('pointerdown'));
  assert.deepEqual(press(screen, hits, button, 'Tab').ran, ['selectProductionBuilding']);
  assert.deepEqual(press(screen, hits, button, 'Enter').ran, ['openTeamChat']);
  uninstallDom();
});

test('modifiers held in a text field count for the cursors, its keys stay out of the hotkeys', async () => {
  const screen = await gameScreen();
  const hits = recordHandlers(screen.hotkeys);
  const chat = focusFrom(control(screen.doc, 'input', { type: 'text', class: 'chat-input' }), true);
  for (const key of ['Control', 'Alt', 'Shift', 'Meta']) {
    chat.dispatchEvent(new FakeEvent('keydown', { key, code: `${key}Left`, cancelable: true }));
    assert.ok(screen.input.keys.has(key), `${key} held`);
  }
  assert.deepEqual(press(screen, hits, chat, 'C').ran, [], 'typing');
  assert.equal(screen.input.keys.has('c'), false, 'typed letters are not held keys');
  // Leaving the chat line with Ctrl still held: the game knows it, until it goes up.
  chat.blur();
  assert.ok(screen.input.keys.has('Control'));
  screen.doc.body.dispatchEvent(new FakeEvent('keyup', { key: 'Control', code: 'ControlLeft' }));
  assert.equal(screen.input.keys.has('Control'), false);
  uninstallDom();
});
