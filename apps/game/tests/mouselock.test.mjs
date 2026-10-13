// Mouse capture (js/mouselock.js): the settings, the lock's state machine
// (clicks, fullscreen, menus, blur, the browser's cooldown), Esc, the capture
// hotkey, the virtual pointer (clamping, speed, the events it fires, focus,
// wheel, pointer capture, cursor art) and edge scrolling and box selection
// through js/input.js with it. Fake DOM, no browser.
// Run with: node --test apps/game/tests/*.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, uninstallDom, FakeEvent, FakeElement, memoryStorage } from './dom-fixtures.mjs';
import { createRegistry, specOf, defaultValues } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { formatCombo, HotkeyRegistry, openraDefaults, RELEASE_MOUSE_KEYS, releaseMouseKey, WEBRA_SUBSTITUTES } from '../js/hotkeys.js';
import { GAME_KEYS, registerGameKeys } from '../js/gamekeys.js';
import { OPENRA_HOTKEYS } from '../js/openra-hotkeys.js';
import { CURSORS } from '../js/cursors.js';
import { validateSettingsDocument } from '../protocol/accounts.js';
import {
  CAPTURE_ACTION,
  CAPTURE_MODES,
  DETACHED_ESC_TEXT,
  ESC_GUARD_MS,
  FIRST_MOVE_JUMP,
  HINT_LIMIT,
  MouseCapture,
  NOTICE_MODES,
  RAW_ACCEL,
  RELOCK_COOLDOWN_MS,
  VIRTUAL_POINTER_ID,
  clampToView,
  cursorArt,
  hintText,
  mirrorPointerStates,
  moveDuration,
  movementFactor,
  parseCursor,
  pointerLockAvailable,
  rawGain,
  requestRawLock,
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
 * What a browser does with requestPointerLock({ unadjustedMovement }):
 * - full: reads the option and returns a promise (Chromium with raw input)
 * - unsupported: reads the option and rejects it with NotSupportedError
 *   (Chromium where the system has no raw input)
 * - ignored: returns a promise but never reads the option
 * - legacy: returns undefined and never reads the option (older Firefox, Safari)
 */
const RAW_SUPPORT = ['full', 'unsupported', 'ignored', 'legacy'];

/**
 * The game page: #app with the battlefield canvas (x < 800) and the sidebar
 * (x >= 800) holding a card, a chat line, a list, a scrollable panel and the
 * radar; the Menu button outside the hit map. Pointer Lock on <html>, the
 * game's settings and hotkeys, and a MouseCapture over all of it. `requests`
 * records each request's option names (null for none) without reading them.
 */
function page({ fullscreen = false, rawSupport = 'full', settingsInit = {}, dpr = 2 } = {}) {
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
  Object.assign(win, { innerWidth: 1000, innerHeight: 600, devicePixelRatio: dpr, Element: FakeElement });
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
    requests.push(opts ? Object.keys(opts) : null);
    const reads = rawSupport === 'full' || rawSupport === 'unsupported';
    if (opts && reads && opts.unadjustedMovement && rawSupport === 'unsupported') {
      return Promise.reject(Object.assign(new Error('no raw input'), { name: 'NotSupportedError' }));
    }
    return rawSupport === 'legacy' ? undefined : Promise.resolve();
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
  // Timers the capture sets (the focus check after the browser let go): run by `flush`.
  const pending = [];
  const flush = () => pending.splice(0).forEach((fn) => fn());
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
    later: (fn) => pending.push(fn),
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
  return { app, view, sidebar, card, chat, list, panel, row, radar, menuButton, outside, capture, settings, hotkeys, requests, grant, refuse, browserExit, exits: () => exits, real, clickInto, hints, escapes, seen, t, setFullscreen, flush, pending };
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

/** The release key of this platform (RELEASE_MOUSE_KEYS), as the keydown a keyboard sends: Option+E on macOS is a dead key, its code is still KeyE. */
const RELEASE = releaseMouseKey();
const pressRelease = (p, key = 'Dead') =>
  p.hotkeys.handle({ type: 'keydown', key, code: 'KeyE', altKey: true, shiftKey: RELEASE.includes('Shift'), target: doc.body, preventDefault() {} });
/** The notice with the default key (the test pages format keys the Windows / Linux way). */
const NOTICE = `Mouse captured. Press ${formatCombo(RELEASE, false)} to release.`;

/** A real mouse move while locked; a first one after locking that jumps (Chromium) is skipped. */
const move = (p, dx, dy, mods = {}) => p.real('mousemove', { movementX: dx, movementY: dy, ...mods });

// ---- Settings and the hotkey ----------------------------------------------------------------

test('settings: capture in fullscreen by default, speed 1, the first Esc only releases; synced through the account document', () => {
  const s = createSettings(null);
  assert.equal(s.get('mouseCapture'), 'fullscreen');
  assert.equal(s.get('mouseCaptureSpeed'), 1);
  assert.equal(s.get('mouseCaptureEscMenu'), true);
  assert.equal(s.get('mouseCaptureHints'), 0);
  assert.equal(s.get('mouseCaptureNotice'), 'always', 'the notice shows on every capture, like cloud gaming services');
  assert.equal(s.get('pauseWhenHidden'), false, 'a hidden single-player game plays on');
  assert.deepEqual(specOf('game', 'mouseCapture').options, CAPTURE_MODES);
  assert.deepEqual(specOf('game', 'mouseCaptureNotice').options, NOTICE_MODES);
  assert.equal(s.set('mouseCapture', 'sometimes'), 'fullscreen', 'not a mode: the default');
  assert.equal(s.set('mouseCaptureSpeed', 9), 3, 'clamped');
  assert.equal(s.set('mouseCaptureSpeed', 0), 0.25);
  assert.equal(s.set('mouseCaptureHints', 500), 99);
  const d = defaultValues();
  assert.equal(d.game.mouseCapture, 'fullscreen');
  assert.equal(d.extra.mouseCaptureHints, 0);
  // The account accepts them (and refuses bad values), so they follow the player.
  const game = { mouseCapture: 'always', mouseCaptureSpeed: 1.5, mouseCaptureEscMenu: true, mouseCaptureNotice: 'first', pauseWhenHidden: true };
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

test('hotkey: Option+E on macOS, Alt+Shift+E on Windows and Linux; releases and captures, listed and rebindable', () => {
  assert.deepEqual(RELEASE_MOUSE_KEYS, { mac: 'Alt+E', other: 'Alt+Shift+E' });
  assert.equal(releaseMouseKey(true), 'Alt+E', "macOS: Option+E, like cloud gaming services");
  assert.equal(releaseMouseKey(false), 'Alt+Shift+E', 'Windows and Linux: Alt+E opens the browser menu, Ctrl+Alt+E is AltGr+E');
  assert.equal(formatCombo(releaseMouseKey(true), true), 'Option+E');
  assert.ok(!Object.values(OPENRA_HOTKEYS).some((h) => h.key === 'Alt+Shift+E'), 'no OpenRA hotkey has Alt+Shift+E');
  // OpenRA's Alt+E (jump to bookmark 3) gives way on macOS only.
  assert.equal(OPENRA_HOTKEYS.MapBookmarkRestore03.key, 'Alt+E');
  assert.equal(WEBRA_SUBSTITUTES.MapBookmarkRestore03.macOnly, true);
  assert.deepEqual(openraDefaults('MapBookmarkRestore03', true), [], 'macOS: no default key, bindable in Controls');
  assert.deepEqual(openraDefaults('MapBookmarkRestore03', false), ['Alt+E'], "Windows and Linux: OpenRA's key");
  const entry = GAME_KEYS.find((e) => e.name === CAPTURE_ACTION);
  assert.deepEqual(entry.keys, [RELEASE]);
  assert.ok(!GAME_KEYS.some((e) => e !== entry && (e.keys ?? []).includes(RELEASE)));
  const p = page({ fullscreen: false });
  const listed = p.hotkeys.list().find((a) => a.name === CAPTURE_ACTION);
  assert.deepEqual(listed.keys, [RELEASE]);
  assert.equal(listed.label, 'Release or capture the mouse');
  assert.equal(listed.group, 'Game Commands');
  assert.equal(pressRelease(p), true);
  assert.equal(p.requests.length, 1, 'released: captures, even outside fullscreen (the press is the player asking)');
  p.grant();
  assert.equal(p.capture.state, 'locked');
  pressRelease(p, '\u00b4');
  assert.equal(p.capture.state, 'off', 'captured: releases');
  assert.equal(p.exits(), 1);
  assert.equal(p.capture.lastRelease, 'hotkey');
  // Rebindable like every hotkey.
  assert.equal(p.hotkeys.rebind(CAPTURE_ACTION, 'Ctrl+Shift+M').ok, true);
  assert.equal(p.hotkeys.actionFor('Ctrl+Shift+M'), CAPTURE_ACTION);
  assert.equal(p.hotkeys.actionFor(RELEASE), null);
});

test('detached: the release hotkey opens no menu, Esc opens none until a click captures again, then Esc works as usual', () => {
  const p = page();
  lockAt(p);
  const hotkey = () => pressRelease(p);
  const esc = () => p.real('keydown', { key: 'Escape' }, doc.body);
  hotkey();
  p.flush();
  assert.equal(p.capture.state, 'off');
  assert.deepEqual(p.escapes, [], 'the hotkey opens no menu');
  assert.equal(p.capture.isDetached(), true);
  // The window loses the focus (another monitor): nothing changes, no menu.
  win.dispatchEvent(new FakeEvent('blur', { bubbles: false }));
  assert.equal(p.capture.isDetached(), true);
  // Esc reaches the game (it cancels a mode there), which asks isDetached before opening the menu.
  const e = esc();
  assert.equal(e.defaultPrevented, false, 'not swallowed here: js/input.js cancels modes with it');
  assert.equal(p.seen.filter(([type]) => type === 'keydown').length, 1);
  assert.equal(p.capture.isDetached(), true, 'still detached: js/main.js shows DETACHED_ESC_TEXT instead of the menu');
  assert.match(DETACHED_ESC_TEXT, /Click into the game/);
  // No cooldown after the hotkey (the page let go, not the browser's Esc): one click captures again.
  p.clickInto(p.view);
  p.grant();
  assert.equal(p.capture.state, 'locked');
  assert.equal(p.capture.isDetached(), false, 'captured again');
  // Esc as usual: releases and (Esc also opens the menu) goes on to the game's menu.
  esc();
  assert.equal(p.capture.state, 'off');
  assert.equal(p.capture.isDetached(), false);
  assert.equal(p.seen.filter(([type]) => type === 'keydown').length, 2);
});

test('detached: Esc works as usual wherever a click would not capture again; the menu ends it', () => {
  const p = page();
  lockAt(p);
  const hotkey = () => p.capture.toggle();
  hotkey();
  assert.equal(p.capture.isDetached(), true);
  // Capture the mouse turned off: nothing would capture again.
  p.settings.set('mouseCapture', 'off');
  assert.equal(p.capture.isDetached(), false);
  p.settings.set('mouseCapture', 'fullscreen');
  assert.equal(p.capture.isDetached(), true);
  // 'In fullscreen' outside fullscreen: likewise.
  p.setFullscreen(false);
  assert.equal(p.capture.isDetached(), false);
  p.setFullscreen(true);
  p.grant();
  hotkey();
  assert.equal(p.capture.isDetached(), true);
  // A menu or dialog (the Menu button, an end of game dialog): the game's own UI again.
  p.capture.setBlocked(true);
  assert.equal(p.capture.isDetached(), false);
  p.capture.setBlocked(false);
  assert.equal(p.capture.isDetached(), false, 'after the menu closes Esc opens it again');
  // Pressed while released, the hotkey captures: not detached.
  hotkey();
  assert.equal(p.capture.isDetached(), false);
});

test('losing the focus never opens the menu; the browser letting go with the focus kept is Esc (menu)', () => {
  const p = page({ settingsInit: { mouseCaptureEscMenu: true } });
  lockAt(p);
  // Alt-tab or a click on another monitor: the browser lets go, blur follows a moment later.
  p.browserExit();
  let focused = true;
  doc.hasFocus = () => focused;
  focused = false;
  win.dispatchEvent(new FakeEvent('blur', { bubbles: false }));
  p.flush();
  assert.deepEqual(p.escapes, [], 'no menu for another window');
  // Blur first, then the lock goes.
  focused = true;
  p.t.advance(RELOCK_COOLDOWN_MS + 1);
  p.clickInto(p.view);
  p.grant();
  focused = false;
  win.dispatchEvent(new FakeEvent('blur', { bubbles: false }));
  p.browserExit();
  p.flush();
  assert.deepEqual(p.escapes, []);
  // A hidden page (another tab): no menu from here either (js/main.js decides: Pause when the game is hidden).
  focused = true;
  p.t.advance(RELOCK_COOLDOWN_MS + 1);
  p.clickInto(p.view);
  p.grant();
  p.browserExit();
  doc.hidden = true;
  p.flush();
  assert.deepEqual(p.escapes, []);
  doc.hidden = false;
  // The focus kept: the browser's Esc, and the menu opens.
  p.t.advance(RELOCK_COOLDOWN_MS + 1);
  p.clickInto(p.view);
  p.grant();
  p.browserExit();
  assert.deepEqual(p.escapes, [], 'asked a moment later');
  p.flush();
  assert.equal(p.escapes.length, 1);
  // A new lock before the check: the old one's check is dropped.
  p.t.advance(RELOCK_COOLDOWN_MS + 1);
  p.clickInto(p.view);
  p.grant();
  p.browserExit();
  p.t.advance(RELOCK_COOLDOWN_MS + 1);
  p.clickInto(p.view);
  p.grant();
  p.flush();
  assert.equal(p.escapes.length, 1);
});

test('notice: names the bound key every capture by default; the first 3 times, or never, by the setting', () => {
  const p = page();
  const capture = () => {
    p.setFullscreen(true);
    p.grant();
    p.setFullscreen(false);
  };
  for (let i = 0; i < HINT_LIMIT + 2; i++) capture();
  assert.equal(p.hints.length, HINT_LIMIT + 2, 'every time');
  assert.ok(p.hints.every((h) => h === NOTICE));
  assert.equal(p.settings.get('mouseCaptureHints'), HINT_LIMIT, 'counted only as far as "first" needs (no settings write per capture)');
  // The key the player bound.
  p.hotkeys.rebind(CAPTURE_ACTION, 'Alt+M');
  capture();
  assert.equal(p.hints.at(-1), 'Mouse captured. Press Alt+M to release.');
  p.hotkeys.unbind(CAPTURE_ACTION);
  capture();
  assert.equal(p.hints.at(-1), 'Mouse captured. Press Esc to release.', 'no key bound: Esc');
  p.hotkeys.reset(CAPTURE_ACTION);
  // Never.
  p.settings.set('mouseCaptureNotice', 'off');
  const shown = p.hints.length;
  capture();
  assert.equal(p.hints.length, shown);
  // The first 3 times: counted over every capture so far (mouseCaptureHints), so none now.
  p.settings.set('mouseCaptureNotice', 'first');
  capture();
  assert.equal(p.hints.length, shown);
  p.settings.set('mouseCaptureHints', 0);
  for (let i = 0; i < HINT_LIMIT + 2; i++) capture();
  assert.equal(p.hints.length, shown + HINT_LIMIT);
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
  assert.equal(movementFactor({ speed: 1 }), 1, 'accelerated movement is CSS px already');
  assert.equal(movementFactor({ speed: 2, distance: 50, dtMs: 1 }), 2, 'only the speed setting: the OS accelerated it');
  assert.equal(movementFactor({ speed: 1, raw: true, distance: 0 }), 1, 'raw at rest: one CSS px per count');
  assert.equal(movementFactor({ speed: 2, raw: true, distance: RAW_ACCEL.halfSpeed * RAW_ACCEL.nominalMs }), 4, 'raw: the speed setting times the gain (2 at halfSpeed)');
  assert.equal(movementFactor({ speed: NaN }), 1);
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
  assert.equal(hintText('Alt+E', false), 'Mouse captured. Press Alt+E to release.');
  assert.equal(hintText('Alt+E', true), 'Mouse captured. Press Option+E to release.', 'the macOS name');
  assert.equal(hintText('Alt+Shift+E', false), 'Mouse captured. Press Alt+Shift+E to release.');
  assert.equal(hintText('Ctrl+Shift+M', true), 'Mouse captured. Press Cmd+Shift+M to release.');
  assert.equal(hintText(null, true), 'Mouse captured. Press Esc to release.');
});

// ---- The state machine ----------------------------------------------------------------------

test('capture: in fullscreen by default; a click into the game asks for the plain (accelerated) lock; the notice shows', () => {
  const p = page();
  p.clickInto(p.view);
  assert.equal(p.requests.length, 0, 'not fullscreen: no capture');
  p.setFullscreen(true);
  assert.equal(p.requests.length, 1, 'entering fullscreen asks');
  assert.equal(p.requests[0], null, 'no unadjustedMovement unless Raw mouse input is on');
  assert.equal(p.capture.state, 'pending');
  p.grant();
  assert.equal(p.capture.state, 'locked');
  assert.equal(p.capture.raw, false);
  assert.deepEqual(p.hints, [NOTICE]);
  assert.equal(p.settings.get('mouseCaptureHints'), 1);
  // Leaving fullscreen lets go; clicks there do not capture.
  p.setFullscreen(false);
  assert.equal(p.capture.state, 'off');
  p.clickInto(p.view);
  assert.equal(p.requests.length, 1);
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
  const p = page({ fullscreen: true, rawSupport: 'unsupported', settingsInit: { mouseCaptureRaw: true } });
  p.clickInto(p.view);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(p.requests, [['unadjustedMovement'], null]);
  assert.equal(p.capture.raw, false);
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

test('Esc with "Esc also opens the menu" off: the first one only releases the mouse, the next one reaches the game (menu)', () => {
  const p = page({ settingsInit: { mouseCaptureEscMenu: false } });
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

test('Esc kept by the browser with "Esc also opens the menu" off: no menu, the Esc that follows is swallowed, and the browser cooldown is waited out', () => {
  const p = page({ settingsInit: { mouseCaptureEscMenu: false } });
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
  p.flush();
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
  assert.equal(log.length, 0, 'a first movement that jumps is skipped');
  move(p, 30, -10);
  // The OS cursor's (accelerated) movement on a 2x screen: CSS px as they come.
  assert.deepEqual(log.map((e) => [e.type, e.x, e.y]), [
    ['pointermove', 130, 90],
    ['mousemove', 130, 90],
  ]);
  assert.equal(log[0].pointerId, VIRTUAL_POINTER_ID);
  p.settings.set('mouseCaptureSpeed', 2);
  move(p, 10, 10);
  assert.deepEqual([log.at(-1).x, log.at(-1).y], [150, 110]);
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

// ---- Raw mouse input, the speed and the first move ------------------------------------------------

test('raw mouse input: off by default, a switch synced through the account document', () => {
  const s = createSettings(null);
  assert.equal(s.get('mouseCaptureRaw'), false, 'the OS movement by default');
  assert.equal(specOf('game', 'mouseCaptureRaw').type, 'boolean');
  assert.equal(defaultValues().game.mouseCaptureRaw, false);
  assert.equal(s.set('mouseCaptureRaw', 'yes'), false, 'not a boolean: the default');
  assert.equal(s.set('mouseCaptureRaw', true), true);
  assert.deepEqual(validateSettingsDocument({ game: { mouseCaptureRaw: true } }).game, { mouseCaptureRaw: true });
  assert.throws(() => validateSettingsDocument({ game: { mouseCaptureRaw: 1 } }), (err) => err.field === 'settings.game.mouseCaptureRaw');
});

test('raw detection: raw only where the browser read the option and took the request', async () => {
  const lock = async (rawSupport) => {
    const p = page({ fullscreen: true, rawSupport, settingsInit: { mouseCaptureRaw: true } });
    p.clickInto(p.view);
    await new Promise((r) => setImmediate(r));
    p.grant();
    assert.equal(p.capture.state, 'locked', rawSupport);
    const out = { requests: p.requests, raw: p.capture.raw };
    p.capture.dispose();
    for (const n of [...doc.body.childNodes]) n.remove();
    return out;
  };
  assert.deepEqual(await lock('full'), { requests: [['unadjustedMovement']], raw: true });
  assert.deepEqual(await lock('ignored'), { requests: [['unadjustedMovement']], raw: false }, 'a promise alone is no proof');
  assert.deepEqual(await lock('legacy'), { requests: [['unadjustedMovement']], raw: false }, 'no promise and the option unread');
  assert.deepEqual(await lock('unsupported'), { requests: [['unadjustedMovement'], null], raw: false }, 'NotSupportedError: the plain lock');
  // A browser that reads the option but returns no promise (it reports through the events): raw once it locks.
  const el = { requestPointerLock: (o) => void o.unadjustedMovement };
  assert.deepEqual(requestRawLock(el), { result: undefined, raw: true });
  // Errors other than NotSupportedError are the caller's (no gesture, another window has focus).
  assert.throws(() => requestRawLock({ requestPointerLock: () => { throw new Error('denied'); } }), /denied/);
  // With the setting off the option is never sent, whatever the browser can do.
  const off = page({ fullscreen: true, rawSupport: 'full' });
  off.clickInto(off.view);
  off.grant();
  assert.deepEqual(off.requests, [null]);
  assert.equal(off.capture.raw, false);
});

test('raw acceleration: 1 at rest, monotonic in the speed and in the distance moved, bounded by maxGain', () => {
  assert.equal(rawGain(0), 1);
  assert.equal(rawGain(-5), 1);
  assert.equal(rawGain(NaN), 1);
  assert.equal(rawGain(RAW_ACCEL.halfSpeed), (1 + RAW_ACCEL.maxGain) / 2, 'half way at halfSpeed');
  let prev = rawGain(0);
  for (let v = 0.05; v <= 1000; v *= 1.1) {
    const g = rawGain(v);
    assert.ok(g >= prev, `rising at ${v}`);
    assert.ok(g >= 1 && g < RAW_ACCEL.maxGain, `bounded at ${v}`);
    prev = g;
  }
  assert.ok(RAW_ACCEL.maxGain - rawGain(1e6) < 1e-6, 'tends to maxGain');
  // A slow aim is barely scaled, a flick goes about 3 times as far (a 1000 CPI mouse: counts per ms = inches per second).
  assert.ok(rawGain(0.5) < 1.15);
  assert.ok(rawGain(6) > 2.7);
  // Per event: more counts in the same time always move the pointer further, and never more than maxGain times.
  let last = 0;
  for (let d = 1; d <= 400; d++) {
    const out = d * movementFactor({ raw: true, distance: d, dtMs: 8 });
    assert.ok(out > last, `${d} counts`);
    assert.ok(out <= d * RAW_ACCEL.maxGain);
    last = out;
  }
  // The same speed gives the same gain whatever the polling rate (125 Hz and 1000 Hz).
  assert.equal(movementFactor({ raw: true, distance: 16, dtMs: 8 }), movementFactor({ raw: true, distance: 2, dtMs: 1 }));
  // The time of a move: kept within limits; unknown or after a pause it is a nominal event.
  assert.equal(moveDuration(0), RAW_ACCEL.minMs);
  assert.equal(moveDuration(4), 4);
  assert.equal(moveDuration(NaN), RAW_ACCEL.nominalMs);
  assert.equal(moveDuration(RAW_ACCEL.maxMs + 1), RAW_ACCEL.nominalMs);
});

test('captured speed: 1x moves like the OS cursor (CSS px) at 1x and 2x screens; raw is never divided by the pixel ratio', async () => {
  for (const dpr of [1, 2]) {
    // The OS (accelerated) movement: exactly what the OS cursor got.
    const a = page({ dpr });
    lockAt(a, 100, 100);
    move(a, 5, 5);
    move(a, 30, -10);
    assert.deepEqual([a.capture.pointer.x, a.capture.pointer.y], [135, 95], `accelerated at ${dpr}x`);
    a.capture.dispose();
    for (const n of [...doc.body.childNodes]) n.remove();
    // Raw: counts times the gain at the move's speed, the same at 1x and 2x.
    const r = page({ dpr, settingsInit: { mouseCaptureRaw: true } });
    lockAt(r, 100, 100);
    await new Promise((res) => setImmediate(res));
    assert.equal(r.capture.raw, true);
    r.real('mousemove', { movementX: 2, movementY: 0, timeStamp: 1000 });
    const slow = r.capture.pointer.x - 100;
    assert.ok(Math.abs(slow - 2 * rawGain(2 / RAW_ACCEL.nominalMs)) < 1e-9, `a slow first move at ${dpr}x: ${slow}`);
    assert.ok(slow > 2 && slow < 2.1, 'about one CSS px per count');
    r.real('mousemove', { movementX: 48, movementY: 0, timeStamp: 1008 });
    const fast = r.capture.pointer.x - 100 - slow;
    assert.ok(Math.abs(fast - 48 * rawGain(6)) < 1e-9, `a flick at ${dpr}x: ${fast}`);
    r.settings.set('mouseCaptureSpeed', 0.5);
    r.real('mousemove', { movementX: 0, movementY: 4, timeStamp: 1100 });
    assert.ok(Math.abs(r.capture.pointer.y - 100 - 0.5 * 4 * rawGain(4 / RAW_ACCEL.nominalMs)) < 1e-9, 'times the speed setting');
    r.capture.dispose();
    for (const n of [...doc.body.childNodes]) n.remove();
  }
});

test('first move after locking: dropped only when it jumps more than FIRST_MOVE_JUMP; real deltas are kept', () => {
  const small = page();
  lockAt(small, 100, 100);
  move(small, 12, -7);
  assert.deepEqual([small.capture.pointer.x, small.capture.pointer.y], [112, 93], 'a real first move is not lost');
  small.capture.dispose();
  for (const n of [...doc.body.childNodes]) n.remove();
  const edge = page();
  lockAt(edge, 100, 100);
  move(edge, FIRST_MOVE_JUMP, 0);
  assert.equal(edge.capture.pointer.x, 100 + FIRST_MOVE_JUMP, 'up to the limit it is a move');
  edge.capture.dispose();
  for (const n of [...doc.body.childNodes]) n.remove();
  const jump = page();
  lockAt(jump, 100, 100);
  move(jump, 80, 80); // 113 px: the jump to the old OS cursor position
  assert.deepEqual([jump.capture.pointer.x, jump.capture.pointer.y], [100, 100]);
  move(jump, 80, 80);
  assert.deepEqual([jump.capture.pointer.x, jump.capture.pointer.y], [180, 180], 'only the first one: later large moves are moves');
  // Each new lock checks its first move again.
  jump.capture.release();
  jump.clickInto(jump.view, 50, 50);
  jump.grant();
  move(jump, 300, 0);
  assert.equal(jump.capture.pointer.x, 50);
});

test('virtual pointer: hover (over, out, enter, leave, :hover marks), clicks, double clicks, right clicks', () => {
  const p = page();
  lockAt(p, 790, 50);
  move(p, 0, 0);
  const view = record(p.view, ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']);
  const card = record(p.card, ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick']);
  const sidebar = record(p.sidebar, ['pointerenter', 'mouseenter', 'click']);
  move(p, 20, 0); // 20 CSS px, into the card at x 810
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
  move(p, 400, 200); // x 900, y 350: the panel's row
  p.real('wheel', { deltaY: 3, deltaMode: 1 });
  assert.equal(p.panel.scrollTop, 48);
  // The battlefield takes the wheel itself (zoom): nothing scrolls.
  p.view.addEventListener('wheel', (e) => e.preventDefault());
  move(p, -400, 0);
  const w = p.real('wheel', { deltaY: 100 });
  assert.equal(w.defaultPrevented, true, 'no page scroll from the real one');
  assert.ok(p.seen.some(([type, how, id]) => type === 'wheel' && how === 'virtual' && id === 'view'));
  // A list needs the OS cursor: the press lets go and focuses it.
  move(p, 400, -100); // x 900, y 250: the list
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
  move(p, -500, 0); // far off the radar: x 400
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
    select_at: () => NONE,
    actor_json: () => 'null',
    set_selection: (ids) => (selection = Array.from(ids)),
    selection: () => Uint32Array.from(selection),
    deploy_state: () => 0,
    cursor_action: () => 0,
    select_box: (_p, ...rect) => (boxes.push(rect.slice(0, 4)), Uint32Array.from([5])),
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
  move(p, 100, 50); // CSS px as they come: +100, +50
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

// ---- A hidden page and the focus (js/background.js, js/main.js) ------------------------------

test('a hidden page: single player plays on (background ticks) unless "Pause when the game is hidden" is on; online, replays and stress never', async () => {
  const { pausesWhenHidden, runsInBackground } = await import('../js/background.js');
  const local = { stress: false, online: false, replay: false };
  assert.equal(pausesWhenHidden(local, false), false, 'default: no menu, no pause');
  assert.equal(pausesWhenHidden(local, true), true, 'the setting on: the menu opens (and pauses)');
  assert.equal(runsInBackground(local, { hidden: true, paused: false }), true, 'plays on while hidden');
  assert.equal(runsInBackground(local, { hidden: true, paused: true }), false, 'paused (the menu the setting opened, Pause): stands still');
  assert.equal(runsInBackground(local, { hidden: false, paused: false }), false, 'shown: animation frames drive it');
  for (const other of [{ online: true }, { replay: true }, { stress: true }]) {
    assert.equal(pausesWhenHidden({ ...local, ...other }, true), false, JSON.stringify(other));
    assert.equal(runsInBackground({ ...local, ...other }, { hidden: true }), false, JSON.stringify(other));
  }
  // Losing the focus is not hiding: js/main.js listens to visibilitychange only, never blur.
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.ok(!/addEventListener\('blur'/.test(main), 'no blur handler in the game screen');
  assert.match(main, /if \(document\.hidden && pausesWhenHidden\(gameKind, settings\.get\('pauseWhenHidden'\)\)\) menu\.open\(\);/);
  assert.match(main, /if \(mouseCapture\?\.isDetached\(\)\) showToast\(DETACHED_ESC_TEXT\);\s*else menu\.open\(\);/, 'Esc while detached opens no menu');
});
