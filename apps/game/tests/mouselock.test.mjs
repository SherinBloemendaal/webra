// Mouse capture (js/mouselock.js): the settings, the lock's state machine
// (clicks, fullscreen, menus, blur, the browser's cooldown), Esc, the capture
// hotkey, the virtual pointer (clamping, speed, the events it fires, focus,
// wheel, pointer capture, cursor art) and edge scrolling and box selection
// through js/input.js with it. Fake DOM, no browser.
// Run with: node --test apps/game/tests/*.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, uninstallDom, FakeEvent, FakeElement, memoryStorage } from './dom-fixtures.mjs';
import { createRegistry, specOf, defaultValues } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { GAME_KEYS, registerGameKeys } from '../js/gamekeys.js';
import { OPENRA_HOTKEYS } from '../js/openra-hotkeys.js';
import { CURSORS } from '../js/cursors.js';
import { validateSettingsDocument } from '../protocol/accounts.js';
import {
  CAPTURE_ACTION,
  CAPTURE_MODES,
  ESC_GUARD_MS,
  HINT_LIMIT,
  MouseCapture,
  RELOCK_COOLDOWN_MS,
  VIRTUAL_POINTER_ID,
  clampToView,
  cursorArt,
  hintText,
  mirrorPointerStates,
  movementFactor,
  parseCursor,
  pointerLockAvailable,
} from '../js/mouselock.js';

const NONE = 0xffffffff;
let doc;
let win;

beforeEach(() => {
  doc = installDom({ windowEvents: true });
  win = globalThis.window;
});
afterEach(() => uninstallDom());

/** A fake clock for the cooldown, the Esc guard and double clicks. */
function clock() {
  let t = 10_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/**
 * The game page: #app with the battlefield canvas (x < 800) and the sidebar
 * (x >= 800) holding a card, a chat line, a list, a scrollable panel and the
 * radar; the Menu button outside the hit map. Pointer Lock on <html>, the
 * game's settings and hotkeys, and a MouseCapture over all of it.
 */
function page({ fullscreen = false, unadjusted = true, settingsInit = {}, rejectOptions = false } = {}) {
  const el = (tag, id, parent) => {
    const e = doc.createElement(tag);
    if (id) e.id = id;
    parent.append(e);
    return e;
  };
  const app = el('div', 'app', doc.body);
  const view = el('canvas', 'view', app);
  const sidebar = el('aside', 'sidebar', app);
  const card = el('button', 'card', sidebar);
  const chat = el('input', 'chat', sidebar);
  chat.type = 'text';
  const list = el('select', 'list', sidebar);
  const panel = el('div', 'panel', sidebar);
  const row = el('p', 'row', panel);
  const radar = el('canvas', 'radar', sidebar);
  const menuButton = el('button', 'menu-button', app);
  menuButton.dataset.noCapture = '';
  const outside = el('div', 'lobby', doc.body);
  Object.assign(win, { innerWidth: 1000, innerHeight: 600, devicePixelRatio: 2, Element: FakeElement });
  // Hit map: the sidebar's parts in bands of 100 px from the top.
  const bands = [card, chat, list, row, radar, menuButton];
  doc.elementFromPoint = (x, y) => (x < 800 ? view : (bands[Math.floor(y / 100)] ?? sidebar));
  // Computed styles: the cursor an element asks for, overflow for scrolling.
  win.getComputedStyle = (n) => ({ cursor: n.cursorValue ?? 'auto', overflowY: n.overflowY ?? 'visible', overflowX: 'visible' });
  panel.overflowY = 'auto';
  Object.assign(panel, { scrollTop: 0, scrollLeft: 0, clientHeight: 100, scrollHeight: 400, clientWidth: 200, scrollWidth: 200 });
  // Pointer Lock: the browser grants (grant) or refuses (refuse) when the test says so.
  const requests = [];
  doc.pointerLockElement = null;
  doc.documentElement.requestPointerLock = (opts) => {
    requests.push(opts ?? null);
    if (opts && rejectOptions) return Promise.reject(Object.assign(new Error('no raw input'), { name: 'NotSupportedError' }));
    return unadjusted ? Promise.resolve() : undefined;
  };
  let exits = 0;
  const lockChange = () => doc.dispatchEvent(new FakeEvent('pointerlockchange', { bubbles: false }));
  doc.exitPointerLock = () => {
    exits++;
    doc.pointerLockElement = null;
    lockChange();
  };
  const grant = () => {
    doc.pointerLockElement = doc.documentElement;
    lockChange();
  };
  // The browser letting go by itself (its Esc, focus moving away).
  const browserExit = () => {
    doc.pointerLockElement = null;
    lockChange();
  };
  const refuse = () => doc.dispatchEvent(new FakeEvent('pointerlockerror', { bubbles: false }));
  const settings = createSettings(createRegistry({ storage: memoryStorage() }));
  for (const [k, v] of Object.entries(settingsInit)) settings.set(k, v);
  const hotkeys = new HotkeyRegistry(settings);
  const t = clock();
  const hints = [];
  const escapes = [];
  let fs = fullscreen;
  const capture = new MouseCapture({
    root: app,
    settings,
    hotkeys,
    doc,
    win,
    now: t.now,
    mac: false,
    isFullscreen: () => fs,
    onHint: (text) => hints.push(text),
    onEscape: () => escapes.push(t.now()),
    makeEvent: (type, init) => new FakeEvent(type, init),
  });
  registerGameKeys(hotkeys, { toggleMouseCapture: () => capture.toggle() });
  /** A real (trusted) event: at `target` while unlocked; at the lock target, <html>, while locked. */
  const real = (type, init = {}, target = doc.pointerLockElement ?? init.at ?? view) => {
    const e = new FakeEvent(type, { isTrusted: true, bubbles: true, cancelable: true, button: 0, buttons: 0, ...init });
    delete e.at;
    target.dispatchEvent(e);
    return e;
  };
  /** A real click into the page while unlocked: pointerdown and mousedown at (x, y) on `at`. */
  const clickInto = (at, x = 100, y = 100, pointerType = 'mouse') => {
    real('pointermove', { clientX: x, clientY: y, pointerType }, at);
    real('pointerdown', { clientX: x, clientY: y, pointerType }, at);
  };
  /** Events that reach the page's own listeners (bubbling phase on the window: js/input.js listens there). */
  const seen = [];
  for (const type of ['mousemove', 'mousedown', 'mouseup', 'click', 'wheel', 'keydown', 'pointerdown']) {
    win.addEventListener(type, (e) => seen.push([type, e.isTrusted ? 'real' : 'virtual', e.target?.id, e.clientX, e.clientY]));
  }
  const setFullscreen = (on) => {
    fs = on;
    capture.fullscreenChanged(on);
  };
  return { app, view, sidebar, card, chat, list, panel, row, radar, menuButton, outside, capture, settings, hotkeys, requests, grant, refuse, browserExit, exits: () => exits, real, clickInto, hints, escapes, seen, t, setFullscreen };
}

/** Events of `types` dispatched at `el`, recorded as [type, details]. */
function record(el, types) {
  const log = [];
  for (const type of types) el.addEventListener(type, (e) => log.push({ type, x: e.clientX, y: e.clientY, button: e.button, detail: e.detail, pointerId: e.pointerId, related: e.relatedTarget?.id }));
  return log;
}

/** Lock at (x, y): a click into the canvas there in fullscreen, granted. */
function lockAt(p, x = 100, y = 100) {
  p.setFullscreen(true);
  p.browserExit(); // the fullscreen request's lock did not come (no gesture): a click asks again
  p.capture.state = 'off';
  p.clickInto(p.view, x, y);
  p.real('mousedown', { clientX: x, clientY: y, buttons: 1 }, p.view);
  p.real('mouseup', { clientX: x, clientY: y, buttons: 0 }, p.view);
  p.grant();
  assert.equal(p.capture.state, 'locked');
}

/** A real mouse move while locked; the first one after locking is skipped (Chromium can jump then). */
const move = (p, dx, dy, mods = {}) => p.real('mousemove', { movementX: dx, movementY: dy, ...mods });

// ---- Settings and the hotkey ----------------------------------------------------------------

test('settings: capture in fullscreen by default, speed 1, the first Esc only releases; synced through the account document', () => {
  const s = createSettings(null);
  assert.equal(s.get('mouseCapture'), 'fullscreen');
  assert.equal(s.get('mouseCaptureSpeed'), 1);
  assert.equal(s.get('mouseCaptureEscMenu'), false);
  assert.equal(s.get('mouseCaptureHints'), 0);
  assert.deepEqual(specOf('game', 'mouseCapture').options, CAPTURE_MODES);
  assert.equal(s.set('mouseCapture', 'sometimes'), 'fullscreen', 'not a mode: the default');
  assert.equal(s.set('mouseCaptureSpeed', 9), 3, 'clamped');
  assert.equal(s.set('mouseCaptureSpeed', 0), 0.25);
  assert.equal(s.set('mouseCaptureHints', 500), 99);
  const d = defaultValues();
  assert.equal(d.game.mouseCapture, 'fullscreen');
  assert.equal(d.extra.mouseCaptureHints, 0);
  // The account accepts them (and refuses bad values), so they follow the player.
  const game = { mouseCapture: 'always', mouseCaptureSpeed: 1.5, mouseCaptureEscMenu: true };
  assert.deepEqual(validateSettingsDocument({ game }).game, game);
  const field = (doc) => {
    try {
      validateSettingsDocument(doc);
    } catch (err) {
      return err.field;
    }
    return null;
  };
  assert.equal(field({ game: { mouseCapture: 'sometimes' } }), 'settings.game.mouseCapture');
  assert.equal(field({ game: { mouseCaptureSpeed: 4 } }), 'settings.game.mouseCaptureSpeed');
  assert.equal(field({ game: { mouseCaptureEscMenu: 'yes' } }), 'settings.game.mouseCaptureEscMenu');
  assert.deepEqual(validateSettingsDocument({ extra: { mouseCaptureHints: 2 } }).extra, { mouseCaptureHints: 2 });
});

test('hotkey: Alt+M (Option+M) captures and releases, listed and rebindable, clashing with no OpenRA default', () => {
  const entry = GAME_KEYS.find((e) => e.name === CAPTURE_ACTION);
  assert.deepEqual(entry.keys, ['Alt+M']);
  assert.ok(!Object.values(OPENRA_HOTKEYS).some((h) => h.key === 'Alt+M'), 'no OpenRA hotkey has Alt+M');
  assert.equal(OPENRA_HOTKEYS.MapBookmarkRestore03.key, 'Alt+E', 'why not Alt+E: it is bookmark 3');
  assert.ok(!GAME_KEYS.some((e) => e !== entry && (e.keys ?? []).includes('Alt+M')));
  const p = page({ fullscreen: false });
  const listed = p.hotkeys.list().find((a) => a.name === CAPTURE_ACTION);
  assert.deepEqual(listed.keys, ['Alt+M']);
  assert.equal(listed.group, 'Game Commands');
  // Option+M on a Mac types "µ"; the key code is still M.
  const press = () => p.hotkeys.handle({ type: 'keydown', key: 'µ', code: 'KeyM', altKey: true, target: doc.body, preventDefault() {} });
  assert.equal(press(), true);
  assert.equal(p.requests.length, 1, 'captures even outside fullscreen: the press is the player asking');
  p.grant();
  assert.equal(p.capture.state, 'locked');
  press();
  assert.equal(p.capture.state, 'off');
  assert.equal(p.exits(), 1);
  // Turned off by hand: clicks do not capture until the key turns it on again.
  p.setFullscreen(true);
  p.clickInto(p.view);
  assert.equal(p.requests.length, 1);
  press();
  assert.equal(p.requests.length, 2);
  // Rebindable like every hotkey.
  assert.equal(p.hotkeys.rebind(CAPTURE_ACTION, 'Ctrl+Shift+M').ok, true);
  assert.equal(p.hotkeys.actionFor('Ctrl+Shift+M'), CAPTURE_ACTION);
});

// ---- Helpers --------------------------------------------------------------------------------

test('helpers: availability, speed, clamping, cursor art and the hint text', () => {
  const lockable = { documentElement: { requestPointerLock() {} }, exitPointerLock() {}, pointerLockElement: null };
  const fine = { matchMedia: (q) => ({ matches: /fine/.test(q) }) };
  const coarse = { matchMedia: (q) => ({ matches: /coarse/.test(q) }) };
  assert.equal(pointerLockAvailable(lockable, fine), true);
  assert.equal(pointerLockAvailable(lockable, coarse), false, 'touch only: no capture');
  assert.equal(pointerLockAvailable({ documentElement: {}, exitPointerLock() {} }, fine), false, 'iOS Safari: no Pointer Lock');
  assert.equal(pointerLockAvailable(null, fine), false);
  assert.equal(movementFactor({ speed: 1, unadjusted: false, dpr: 2 }), 1, 'accelerated movement is CSS px already');
  assert.equal(movementFactor({ speed: 1, unadjusted: true, dpr: 2 }), 0.5, 'raw counts are about one per device pixel');
  assert.equal(movementFactor({ speed: 2, unadjusted: true, dpr: 1 }), 2);
  assert.equal(movementFactor({ speed: NaN, dpr: 0 }), 1);
  assert.deepEqual(clampToView(-5, 700, 1000, 600), { x: 0, y: 599 });
  assert.deepEqual(clampToView(1200, 10, 1000, 600), { x: 999, y: 10 });
  assert.deepEqual(parseCursor(CURSORS.attack), { src: parseCursor(CURSORS.attack).src, x: 16, y: 16 });
  assert.match(parseCursor(CURSORS.select).src, /^data:image\/svg\+xml,/);
  assert.equal(parseCursor(CURSORS.select).x, 3);
  assert.deepEqual(parseCursor('pointer'), { keyword: 'pointer' });
  assert.equal(cursorArt('none'), null, 'cursor: none hides it (hide the interface and cursor)');
  assert.deepEqual(cursorArt('pointer'), parseCursor(CURSORS.select), 'the arrow over buttons');
  assert.deepEqual(cursorArt('not-allowed'), parseCursor(CURSORS.blocked));
  assert.match(cursorArt('text').src, /^data:image\/svg\+xml,/);
  assert.deepEqual(cursorArt(CURSORS.sellBlocked), parseCursor(CURSORS.sellBlocked));
  assert.equal(hintText('Alt+M', false), 'Mouse captured. Alt+M or Esc to release.');
  assert.equal(hintText('Alt+M', true), 'Mouse captured. Option+M or Esc to release.');
  assert.equal(hintText(null, true), 'Mouse captured. Esc to release.');
});

// ---- The state machine ----------------------------------------------------------------------

test('capture: in fullscreen by default; a click into the game asks with unadjusted movement; the hint shows the first times', () => {
  const p = page();
  p.clickInto(p.view);
  assert.equal(p.requests.length, 0, 'not fullscreen: no capture');
  p.setFullscreen(true);
  assert.equal(p.requests.length, 1, 'entering fullscreen asks');
  assert.deepEqual(p.requests[0], { unadjustedMovement: true });
  assert.equal(p.capture.state, 'pending');
  p.grant();
  assert.equal(p.capture.state, 'locked');
  assert.equal(p.capture.unadjusted, true);
  assert.deepEqual(p.hints, ['Mouse captured. Alt+M or Esc to release.']);
  assert.equal(p.settings.get('mouseCaptureHints'), 1);
  // Leaving fullscreen lets go; clicks there do not capture.
  p.setFullscreen(false);
  assert.equal(p.capture.state, 'off');
  p.clickInto(p.view);
  assert.equal(p.requests.length, 1);
  // The hint stops after HINT_LIMIT times.
  for (let i = 0; i < HINT_LIMIT + 2; i++) {
    p.setFullscreen(true);
    p.grant();
    p.setFullscreen(false);
  }
  assert.equal(p.hints.length, HINT_LIMIT);
});

test('capture: what a click captures (the game, not Menu, text fields, lists or the lobby; no touch)', () => {
  const p = page({ fullscreen: false, settingsInit: { mouseCapture: 'always' } });
  for (const at of [p.menuButton, p.chat, p.list, p.outside]) p.clickInto(at);
  p.clickInto(p.view, 10, 10, 'touch');
  p.clickInto(p.view, 10, 10, 'pen');
  assert.equal(p.requests.length, 0);
  p.clickInto(p.card);
  assert.equal(p.requests.length, 1, 'the sidebar is the game too');
  p.capture.release();
  p.settings.set('mouseCapture', 'off');
  p.clickInto(p.view);
  assert.equal(p.requests.length, 1, 'off: never');
});

test('capture: no raw movement falls back to the plain lock; refusals and late grants end cleanly', async () => {
  const p = page({ fullscreen: true, rejectOptions: true });
  p.clickInto(p.view);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(p.requests, [{ unadjustedMovement: true }, null]);
  assert.equal(p.capture.unadjusted, false);
  p.grant();
  assert.equal(p.capture.state, 'locked');
  p.capture.release();
  // The browser refuses (no gesture, another window has focus): off again, the next click asks again.
  p.clickInto(p.view);
  p.refuse();
  assert.equal(p.capture.state, 'off');
  // Let go while the browser was deciding: the lock that comes late is given back.
  p.clickInto(p.view);
  p.capture.setBlocked(true);
  const before = p.exits();
  p.grant();
  assert.equal(p.capture.state, 'off');
  assert.equal(p.exits(), before + 1);
});

test('capture: menus, dialogs, blur, hidden pages and touches let go; a blocked game does not capture', () => {
  const p = page();
  lockAt(p);
  p.capture.setBlocked(true);
  assert.equal(p.capture.state, 'off');
  assert.equal(doc.pointerLockElement, null);
  p.clickInto(p.view);
  assert.equal(p.capture.state, 'off', 'the menu is open');
  p.capture.setBlocked(false);
  p.clickInto(p.view);
  p.grant();
  assert.equal(p.capture.state, 'locked', 're-captured on the next click');
  win.dispatchEvent(new FakeEvent('blur', { bubbles: false }));
  assert.equal(p.capture.state, 'off', 'alt-tab');
  p.clickInto(p.view);
  p.grant();
  doc.hidden = true;
  doc.dispatchEvent(new FakeEvent('visibilitychange', { bubbles: false }));
  assert.equal(p.capture.state, 'off');
  doc.hidden = false;
  p.clickInto(p.view);
  p.grant();
  p.real('pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5 }, p.view);
  assert.equal(p.capture.state, 'off', 'a touch on the screen');
  p.clickInto(p.view);
  p.grant();
  p.settings.set('mouseCapture', 'off');
  assert.equal(p.capture.state, 'off', 'turned off in Settings');
});

// ---- Esc --------------------------------------------------------------------------------------

test('Esc: the first one only releases the mouse, the next one reaches the game (menu)', () => {
  const p = page();
  lockAt(p);
  const esc = () => p.real('keydown', { key: 'Escape' }, doc.body);
  const e1 = esc();
  assert.equal(p.capture.state, 'off');
  assert.equal(e1.defaultPrevented, true);
  assert.ok(!p.seen.some(([type]) => type === 'keydown'), 'the game did not see it');
  esc();
  assert.equal(p.seen.filter(([type]) => type === 'keydown').length, 1, 'the second Esc opens the menu as before');
});

test('Esc: with "Esc also opens the menu" it releases and goes on; in a text field it always goes on', () => {
  const p = page({ settingsInit: { mouseCaptureEscMenu: true } });
  lockAt(p);
  p.real('keydown', { key: 'Escape' }, doc.body);
  assert.equal(p.capture.state, 'off');
  assert.equal(p.seen.filter(([type]) => type === 'keydown').length, 1);
  p.capture.dispose();
  uninstallDom();
  doc = installDom({ windowEvents: true });
  win = globalThis.window;
  const q = page();
  lockAt(q);
  q.real('keydown', { key: 'Escape' }, q.chat);
  assert.equal(q.capture.state, 'off');
  assert.equal(q.seen.filter(([type]) => type === 'keydown').length, 1, 'the chat line closes as always');
});

test('Esc kept by the browser: no menu, the Esc that follows is swallowed, and the browser cooldown is waited out', () => {
  const p = page();
  lockAt(p);
  p.browserExit();
  assert.equal(p.capture.state, 'off');
  assert.deepEqual(p.escapes, [], 'the first Esc only releases');
  const late = p.real('keydown', { key: 'Escape' }, doc.body);
  assert.equal(late.defaultPrevented, true, 'a browser that also delivers the key: still only a release');
  p.t.advance(ESC_GUARD_MS + 1);
  p.real('keydown', { key: 'Escape' }, doc.body);
  assert.equal(p.seen.filter(([type]) => type === 'keydown').length, 1, 'the next Esc is the game\'s');
  // Within the cooldown a click acts but does not ask for the lock (the browser would refuse).
  const asked = p.requests.length;
  p.t.advance(RELOCK_COOLDOWN_MS / 2);
  p.clickInto(p.view);
  assert.equal(p.requests.length, asked);
  assert.ok(p.seen.some(([type, how]) => type === 'pointerdown' && how === 'real'), 'the click still reaches the game');
  p.t.advance(RELOCK_COOLDOWN_MS);
  p.clickInto(p.view);
  assert.equal(p.requests.length, asked + 1);
});

test('Esc kept by the browser with "Esc also opens the menu": the game gets its Esc once', () => {
  const p = page({ settingsInit: { mouseCaptureEscMenu: true } });
  lockAt(p);
  p.browserExit();
  assert.equal(p.escapes.length, 1);
  p.real('keydown', { key: 'Escape' }, doc.body);
  assert.equal(p.escapes.length, 1);
  assert.equal(p.seen.filter(([type]) => type === 'keydown').length, 0, 'the same Esc delivered late is not a second one');
});

// ---- The virtual pointer ----------------------------------------------------------------------

test('virtual pointer: starts at the real pointer, moves by movement at the right speed, clamped to the window', () => {
  const p = page();
  lockAt(p, 100, 100);
  const log = record(p.view, ['pointermove', 'mousemove']);
  move(p, 500, 500);
  assert.equal(log.length, 0, 'the first movement after locking is skipped');
  move(p, 30, -10);
  // Unadjusted (raw) movement on a 2x screen: half.
  assert.deepEqual(log.map((e) => [e.type, e.x, e.y]), [
    ['pointermove', 115, 95],
    ['mousemove', 115, 95],
  ]);
  assert.equal(log[0].pointerId, VIRTUAL_POINTER_ID);
  p.settings.set('mouseCaptureSpeed', 2);
  move(p, 10, 10);
  assert.deepEqual([log.at(-1).x, log.at(-1).y], [125, 105]);
  move(p, -100000, -100000);
  assert.deepEqual([log.at(-1).x, log.at(-1).y], [0, 0]);
  move(p, 100000, 100000);
  assert.deepEqual([p.capture.pointer.x, p.capture.pointer.y], [999, 599]);
  // The real events never reach the page; the virtual ones do.
  assert.ok(!p.seen.some(([type, how]) => type === 'mousemove' && how === 'real' && doc.pointerLockElement));
  assert.ok(p.seen.some(([type, how]) => type === 'mousemove' && how === 'virtual'));
  // The window shrinks: the pointer stays inside.
  win.innerWidth = 500;
  p.capture.frame();
  assert.equal(p.capture.pointer.x, 499);
});

test('virtual pointer: hover (over, out, enter, leave, :hover marks), clicks, double clicks, right clicks', () => {
  const p = page();
  lockAt(p, 790, 50);
  move(p, 0, 0);
  const view = record(p.view, ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']);
  const card = record(p.card, ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick']);
  const sidebar = record(p.sidebar, ['pointerenter', 'mouseenter', 'click']);
  move(p, 40, 0); // 2x screen, raw: 20 CSS px, into the card at x 810
  assert.deepEqual(view.map((e) => e.type), ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']);
  assert.equal(view[0].related, 'card');
  assert.deepEqual(card.map((e) => e.type), ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']);
  assert.deepEqual(sidebar.map((e) => e.type), ['pointerenter', 'mouseenter'], 'enter on the ancestors it entered');
  assert.ok(p.card.hasAttribute('data-vhover') && p.sidebar.hasAttribute('data-vhover') && !p.view.hasAttribute('data-vhover'));
  card.length = 0;
  p.real('mousedown', { button: 0, buttons: 1 });
  assert.ok(p.card.hasAttribute('data-vactive'));
  p.real('mouseup', { button: 0, buttons: 0 });
  assert.ok(!p.card.hasAttribute('data-vactive'));
  assert.deepEqual(card.map((e) => [e.type, e.x, e.detail ?? null]), [
    ['pointerdown', 810, null],
    ['mousedown', 810, 1],
    ['pointerup', 810, null],
    ['mouseup', 810, 1],
    ['click', 810, 1],
  ]);
  assert.equal(sidebar.filter((e) => e.type === 'click').length, 1, 'click bubbles');
  card.length = 0;
  p.t.advance(100);
  p.real('mousedown', { button: 0, buttons: 1 });
  p.real('mouseup', { button: 0, buttons: 0 });
  assert.deepEqual(card.filter((e) => e.type === 'click' || e.type === 'dblclick').map((e) => [e.type, e.detail]), [
    ['click', 2],
    ['dblclick', 2],
  ]);
  card.length = 0;
  p.real('mousedown', { button: 2, buttons: 2 });
  p.real('mouseup', { button: 2, buttons: 0 });
  assert.deepEqual(card.map((e) => e.type), ['pointerdown', 'mousedown', 'contextmenu', 'pointerup', 'mouseup', 'auxclick']);
  assert.equal(card[0].button, 2);
  // The real right click shows no browser menu either.
  const realMenu = p.real('contextmenu', { button: 2 });
  assert.equal(realMenu.defaultPrevented, true);
  // Content that moves under a still pointer changes the hover too (every frame).
  const was = doc.elementFromPoint;
  doc.elementFromPoint = () => p.radar;
  p.capture.frame();
  assert.ok(p.radar.hasAttribute('data-vhover') && !p.card.hasAttribute('data-vhover'));
  doc.elementFromPoint = was;
});

test('virtual pointer: a drag that leaves its element still ends with mouseup; no click where it did not start', () => {
  const p = page();
  lockAt(p, 100, 100);
  move(p, 0, 0);
  const view = record(p.view, ['mousedown', 'mouseup', 'click']);
  p.real('mousedown', { button: 0, buttons: 1 });
  move(p, 2000, 0); // to the sidebar
  p.real('mouseup', { button: 0, buttons: 0 });
  assert.deepEqual(view.map((e) => e.type), ['mousedown']);
  assert.ok(p.seen.some(([type, how, id]) => type === 'mouseup' && how === 'virtual' && id === 'chat'), 'mouseup where it came up (js/input.js listens on the window)');
  assert.ok(p.seen.some(([type, how, id]) => type === 'click' && how === 'virtual' && id === 'app'), 'the click goes to what holds both');
});

test('virtual pointer: text fields take the focus, lists let go of the mouse, the wheel scrolls panels', () => {
  const p = page();
  lockAt(p, 900, 150); // the chat line
  move(p, 0, 0);
  p.real('mousedown', { button: 0, buttons: 1 });
  p.real('mouseup', { button: 0, buttons: 0 });
  assert.equal(doc.activeElement, p.chat, 'typing goes to the chat line');
  move(p, -400, 0); // the battlefield
  p.real('mousedown', { button: 0, buttons: 1 });
  p.real('mouseup', { button: 0, buttons: 0 });
  assert.notEqual(doc.activeElement, p.chat, 'a click elsewhere leaves it');
  // The wheel: a panel that scrolls scrolls (a replayed wheel event does not by itself).
  move(p, 400, 400); // x 900, y 350: the panel's row
  p.real('wheel', { deltaY: 3, deltaMode: 1 });
  assert.equal(p.panel.scrollTop, 48);
  // The battlefield takes the wheel itself (zoom): nothing scrolls.
  p.view.addEventListener('wheel', (e) => e.preventDefault());
  move(p, -400, 0);
  const w = p.real('wheel', { deltaY: 100 });
  assert.equal(w.defaultPrevented, true, 'no page scroll from the real one');
  assert.ok(p.seen.some(([type, how, id]) => type === 'wheel' && how === 'virtual' && id === 'view'));
  // A list needs the OS cursor: the press lets go and focuses it.
  move(p, 400, -200); // x 900, y 250: the list
  p.real('mousedown', { button: 0, buttons: 1 });
  assert.equal(p.capture.state, 'off');
  assert.equal(doc.activeElement, p.list);
});

test('virtual pointer: setPointerCapture works for it (the radar drag), released on pointerup', () => {
  const p = page();
  lockAt(p, 900, 450); // the radar
  move(p, 0, 0);
  const radar = record(p.radar, ['pointerdown', 'pointermove', 'pointerup', 'gotpointercapture', 'lostpointercapture']);
  p.radar.addEventListener('pointerdown', (e) => p.radar.setPointerCapture(e.pointerId));
  p.real('mousedown', { button: 0, buttons: 1 });
  assert.equal(p.radar.hasPointerCapture(VIRTUAL_POINTER_ID), true);
  move(p, -1000, 0); // far off the radar
  p.real('mouseup', { button: 0, buttons: 0 });
  assert.deepEqual(radar.map((e) => e.type), ['pointerdown', 'gotpointercapture', 'pointermove', 'pointerup', 'lostpointercapture']);
  assert.equal(radar[2].x, 400, 'the move still went to the radar');
  assert.equal(p.radar.hasPointerCapture(VIRTUAL_POINTER_ID), false);
});

test('virtual pointer: the cursor art is what the page asks for there', () => {
  const p = page();
  p.view.cursorValue = CURSORS.attack;
  p.card.cursorValue = 'pointer';
  lockAt(p, 100, 100);
  assert.deepEqual(p.capture.art, parseCursor(CURSORS.attack));
  assert.equal(p.capture.overlay.hidden, false);
  assert.equal(p.capture.overlay.querySelector('img').getAttribute('src'), parseCursor(CURSORS.attack).src);
  p.view.cursorValue = CURSORS.scrollW;
  p.capture.frame();
  assert.deepEqual(p.capture.art, parseCursor(CURSORS.scrollW), 'edge scroll arrows, sell, deploy: whatever js/input.js sets');
  move(p, 0, 0);
  move(p, 2000, 0);
  assert.deepEqual(p.capture.art, parseCursor(CURSORS.select), 'the arrow over buttons');
  move(p, -2000, 0);
  p.view.cursorValue = 'none';
  p.capture.frame();
  assert.equal(p.capture.art, null);
  assert.equal(p.capture.overlay.hidden, true);
  p.capture.release();
  assert.equal(p.capture.overlay.hidden, true, 'the OS cursor is back');
});

test('release: held buttons come up without a click, hover leaves, the :hover marks go', () => {
  const p = page();
  lockAt(p, 810, 50);
  move(p, 0, 0);
  const card = record(p.card, ['mouseup', 'click', 'mouseleave', 'pointerleave']);
  p.real('mousedown', { button: 0, buttons: 1 });
  p.capture.toggle();
  assert.deepEqual(card.map((e) => e.type), ['mouseup', 'pointerleave', 'mouseleave']);
  assert.equal(doc.querySelectorAll('[data-vhover]').length, 0);
  assert.equal(doc.querySelectorAll('[data-vactive]').length, 0);
});

test('a press that captures: its button comes up through the virtual pointer and clicks', () => {
  const p = page({ fullscreen: true });
  const card = record(p.card, ['mouseup', 'click']);
  p.clickInto(p.card, 850, 50);
  p.real('mousedown', { clientX: 850, clientY: 50, buttons: 1 }, p.card);
  p.grant(); // the lock arrives while the button is held
  p.real('mouseup', { button: 0, buttons: 0 });
  assert.deepEqual(card.map((e) => e.type), ['mouseup', 'click']);
});

test(':hover and :active rules get [data-vhover] / [data-vactive] twins once, nested rules included', () => {
  const sheet = (rules) => ({
    cssRules: rules,
    insertRule(text, i) {
      const m = /^(.*?) \{ (.*) \}$/.exec(text);
      rules.splice(i, 0, { selectorText: m[1], style: { cssText: m[2] } });
    },
  });
  const media = sheet([{ selectorText: '.sb-card:hover', style: { cssText: 'color: red;' } }]);
  const main = sheet([
    { selectorText: '.hud-button:hover', style: { cssText: 'background: blue;' } },
    { selectorText: '.plain', style: { cssText: 'color: green;' } },
    { selectorText: '#sidebar .sb-tool:active:not(:disabled)', style: { cssText: 'box-shadow: none;' } },
    media,
  ]);
  const page = { styleSheets: [main] };
  assert.equal(mirrorPointerStates(page), 3);
  assert.deepEqual(main.cssRules.filter((r) => r.selectorText).map((r) => r.selectorText), [
    '.hud-button:hover',
    '.hud-button[data-vhover]',
    '.plain',
    '#sidebar .sb-tool:active:not(:disabled)',
    '#sidebar .sb-tool[data-vactive]:not(:disabled)',
  ]);
  assert.equal(main.cssRules[1].style.cssText, 'background: blue;');
  assert.deepEqual(media.cssRules.map((r) => r.selectorText), ['.sb-card:hover', '.sb-card[data-vhover]']);
  assert.equal(mirrorPointerStates(page), 0, 'once per sheet');
});

// ---- Through js/input.js --------------------------------------------------------------------------

/** js/input.js over the page's canvas, with a game that selects actor 5 in any box. */
async function withInput(p) {
  const { Input } = await import('../js/input.js');
  Object.assign(p.view, { clientWidth: 800, clientHeight: 600 });
  p.view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
  const boxes = [];
  let selection = [];
  const game = {
    map_width: () => 200,
    map_height: () => 200,
    pick: () => NONE,
    actor_json: () => 'null',
    set_selection: (ids) => (selection = Array.from(ids)),
    selection: () => Uint32Array.from(selection),
    deploy_state: () => 0,
    cursor_action: () => 0,
    select_box: (_p, ...rect) => (boxes.push(rect), Uint32Array.from([5])),
  };
  const settings = createSettings(null);
  const input = new Input(p.view, game, { actors: [] }, 0, { onSelectionChanged() {} }, { hotkeys: new HotkeyRegistry(settings), settings });
  input.camera.zoom = 1;
  input.centerOn(2400, 2400);
  return { input, boxes };
}

test('edge scrolling with the virtual pointer: the window edge scrolls, wherever the OS cursor is', async () => {
  const p = page();
  const { input } = await withInput(p);
  lockAt(p, 400, 300);
  move(p, 0, 0);
  assert.equal(input.mouse.inside, true, 'mouseenter on the canvas');
  const x0 = input.camera.x;
  input.update(0.1);
  assert.equal(input.edgeScroll, null, 'the middle does not scroll');
  move(p, -100000, 0); // pinned to the left edge: x 0
  assert.equal(input.mouse.x, 0);
  input.update(0.1);
  assert.deepEqual([input.edgeScroll.dx, input.edgeScroll.dy], [-1, 0]);
  assert.ok(input.camera.x < x0, 'scrolled left');
  // More movement against the edge keeps it there (the OS cursor would have left for the next monitor).
  move(p, -500, 0);
  assert.equal(input.mouse.x, 0);
  input.update(0.1);
  assert.ok(input.edgeScroll);
  // Down to the bottom left corner: both ways.
  move(p, 0, 100000);
  input.update(0.1);
  assert.deepEqual([input.edgeScroll.dx, input.edgeScroll.dy], [-1, 1]);
  // Released: the canvas is left, the scrolling stops.
  p.capture.release();
  assert.equal(input.mouse.inside, false);
  input.update(0.1);
  assert.equal(input.edgeScroll, null);
});

test('box selection, orders and the wheel through js/input.js with the virtual pointer', async () => {
  const p = page();
  const { input, boxes } = await withInput(p);
  lockAt(p, 100, 100);
  // The click that captured is a click on the ground (it clears the selection) once the game answered.
  await new Promise((r) => setImmediate(r));
  move(p, 0, 0);
  p.real('mousedown', { button: 0, buttons: 1 });
  assert.deepEqual([input.drag.sx, input.drag.sy], [100, 100]);
  move(p, 200, 100); // raw on a 2x screen: +100, +50
  p.real('mouseup', { button: 0, buttons: 0 });
  await new Promise((r) => setImmediate(r));
  const cx = input.camera.x;
  const cy = input.camera.y;
  assert.deepEqual(boxes, [[cx + 100, cy + 100, cx + 200, cy + 150]]);
  assert.deepEqual(input.selection, [5]);
  // Right click clears the selection (js/input.js acts on mousedown).
  p.real('mousedown', { button: 2, buttons: 2 });
  p.real('mouseup', { button: 2, buttons: 0 });
  assert.deepEqual(input.selection, []);
  // The wheel zooms at the virtual pointer.
  const zoom = input.camera.zoom;
  p.real('wheel', { deltaY: -200 });
  assert.ok(input.camera.zoom > zoom);
});
