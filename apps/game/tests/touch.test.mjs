// Touch controls: the gesture recognizer (synthetic pointer sequences with a
// fake clock), the pinch camera math, the layout helpers, and TouchControls
// driving the real Input class over a fake game and a minimal fake DOM.
// No browser and no WebAssembly. Run with: node --test apps/game/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GestureRecognizer, GESTURE_DEFAULTS, pinchCamera } from '../js/gestures.js';
import { layoutMode, isCompact, renderPixelRatio, hudText, DrawerState, LOW_QUALITY_RATIO, TOUCH_TARGET } from '../js/layout.js';
import { createSettings, SCHEMA } from '../js/settings.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { ACTION } from '../js/cursors.js';

const NONE = 0xffffffff;

// ---- Gesture recognizer -----------------------------------------------------------

/** A fake clock: timers fire when advance() passes them. */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    get now() {
      return now;
    },
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

/** Recognizer that logs every event as [name, arg]. */
function recorder(options = {}) {
  const clock = fakeClock();
  const log = [];
  const names = ['tap', 'doubleTap', 'longPress', 'longPressEnd', 'dragStart', 'dragMove', 'dragEnd', 'dragCancel', 'pinchStart', 'pinch', 'pinchEnd'];
  const handlers = Object.fromEntries(names.map((n) => [n, (arg) => log.push([n, arg])]));
  const g = new GestureRecognizer(handlers, { setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options });
  // Pointer helpers stamped with the fake clock.
  const down = (id, x, y) => g.down({ id, x, y, t: clock.now });
  const move = (id, x, y) => g.move({ id, x, y, t: clock.now });
  const up = (id, x, y) => g.up({ id, x, y, t: clock.now });
  const names_ = () => log.map(([n]) => n);
  return { g, clock, log, down, move, up, names: names_ };
}

test('gestures: a short press without moving is a tap at the touch point', () => {
  const r = recorder();
  r.down(1, 100, 50);
  r.clock.advance(80);
  r.move(1, 104, 53); // inside the tap slop
  r.clock.advance(40);
  r.up(1, 104, 53);
  assert.deepEqual(r.log, [['tap', { x: 100, y: 50 }]]);
  assert.equal(r.clock.pending(), 0, 'the long press timer is cleared');
  r.clock.advance(1000);
  assert.deepEqual(r.names(), ['tap'], 'no late long press');
  assert.equal(r.g.active, false);
});

test('gestures: double tap needs the second tap soon and close; a third tap starts over', () => {
  const r = recorder();
  const tap = (x, y, wait) => {
    r.clock.advance(wait);
    r.down(1, x, y);
    r.clock.advance(50);
    r.up(1, x, y);
  };
  tap(200, 200, 0);
  tap(210, 205, 150);
  tap(210, 205, 150);
  assert.deepEqual(r.names(), ['tap', 'doubleTap', 'tap']);
  assert.deepEqual(r.log[1][1], { x: 210, y: 205 });

  const slow = recorder();
  for (const wait of [0, GESTURE_DEFAULTS.doubleTapMs + 100]) {
    slow.clock.advance(wait);
    slow.down(1, 10, 10);
    slow.clock.advance(50);
    slow.up(1, 10, 10);
  }
  assert.deepEqual(slow.names(), ['tap', 'tap'], 'too slow');

  const far = recorder();
  far.down(1, 10, 10);
  far.up(1, 10, 10);
  far.clock.advance(100);
  far.down(1, 10 + GESTURE_DEFAULTS.doubleTapSlop + 20, 10);
  far.up(1, 10 + GESTURE_DEFAULTS.doubleTapSlop + 20, 10);
  assert.deepEqual(far.names(), ['tap', 'tap'], 'too far apart');
});

test('gestures: holding still is a long press, and lifting then fires no tap', () => {
  const r = recorder();
  r.down(1, 40, 60);
  r.clock.advance(GESTURE_DEFAULTS.longPressMs - 1);
  assert.deepEqual(r.log, []);
  r.move(1, 43, 62); // small wobble keeps it a press
  r.clock.advance(1);
  assert.deepEqual(r.log, [['longPress', { x: 43, y: 62 }]]);
  r.move(1, 140, 62); // moving after the long press does not start a drag
  r.up(1, 140, 62);
  assert.deepEqual(r.names(), ['longPress', 'longPressEnd']);
  // A tap right after a long press is a plain tap, not the second half of a double tap.
  r.down(1, 140, 62);
  r.up(1, 140, 62);
  assert.equal(r.names().at(-1), 'tap');
});

test('gestures: moving past the slop is a drag (start, moves, end) and never a tap or long press', () => {
  const r = recorder();
  r.down(1, 10, 10);
  r.clock.advance(100);
  r.move(1, 30, 10);
  r.move(1, 60, 40);
  r.clock.advance(1000);
  r.up(1, 70, 50);
  assert.deepEqual(r.log, [
    ['dragStart', { x: 10, y: 10 }],
    ['dragMove', { x: 30, y: 10, sx: 10, sy: 10 }],
    ['dragMove', { x: 60, y: 40, sx: 10, sy: 10 }],
    ['dragEnd', { x: 70, y: 50, sx: 10, sy: 10 }],
  ]);
});

test('gestures: pinch reports the distance ratio around the centre of the two fingers', () => {
  const r = recorder();
  r.down(1, 100, 100);
  r.down(2, 200, 100);
  r.move(1, 50, 100); // distance 100 -> 150, centre 150 -> 125
  r.move(2, 250, 100); // 150 -> 200, centre 125 -> 150
  assert.equal(r.log[0][0], 'pinchStart');
  assert.deepEqual(r.log[0][1], { x: 150, y: 100 });
  const [, a] = r.log[1];
  const [, b] = r.log[2];
  assert.ok(Math.abs(a.scale - 1.5) < 1e-9 && a.dx === -25);
  assert.ok(Math.abs(b.scale - 200 / 150) < 1e-9 && b.dx === 25);
  assert.ok(Math.abs(a.scale * b.scale - 2) < 1e-9, 'steps multiply to the whole pinch');
  // Lifting one finger ends the pinch; the other finger then does nothing, even when it moves and lifts.
  r.up(1, 50, 100);
  r.move(2, 400, 300);
  r.clock.advance(2000);
  r.up(2, 400, 300);
  assert.deepEqual(r.names(), ['pinchStart', 'pinch', 'pinch', 'pinchEnd']);
  // The next touch starts fresh.
  r.down(3, 5, 5);
  r.up(3, 5, 5);
  assert.equal(r.names().at(-1), 'tap');
});

test('gestures: two fingers moving together pan (centre delta, scale 1)', () => {
  const r = recorder();
  r.down(1, 100, 100);
  r.down(2, 100, 200);
  r.move(1, 130, 110);
  r.move(2, 130, 210);
  const pans = r.log.filter(([n]) => n === 'pinch').map(([, p]) => p);
  const dx = pans.reduce((s, p) => s + p.dx, 0);
  const dy = pans.reduce((s, p) => s + p.dy, 0);
  const scale = pans.reduce((s, p) => s * p.scale, 1);
  assert.equal(dx, 30);
  assert.equal(dy, 10);
  assert.ok(Math.abs(scale - 1) < 1e-9, 'one finger moving first stretches, the other undoes it');
  assert.deepEqual({ ...pans.at(-1), scale: undefined }, { x: 130, y: 160, dx: 15, dy: 5, scale: undefined });
});

test('gestures: a second finger turns a drag or press into a pinch; a third finger is ignored', () => {
  const r = recorder();
  r.down(1, 10, 10);
  r.move(1, 50, 10);
  r.down(2, 50, 110);
  assert.deepEqual(r.names(), ['dragStart', 'dragMove', 'dragCancel', 'pinchStart']);
  assert.equal(r.down(3, 0, 0), false, 'third finger');
  r.move(3, 99, 99);
  r.up(3, 99, 99);
  r.up(2, 50, 110);
  r.up(1, 50, 10);
  assert.deepEqual(r.names().slice(4), ['pinchEnd'], 'no tap or drag end afterwards');

  const p = recorder();
  p.down(1, 10, 10);
  p.down(2, 60, 10);
  p.clock.advance(2000);
  p.up(1, 10, 10);
  p.up(2, 60, 10);
  assert.deepEqual(p.names(), ['pinchStart', 'pinchEnd'], 'no long press, no tap');
});

test('gestures: pointercancel and reset drop the gesture without firing it', () => {
  const r = recorder();
  r.down(1, 10, 10);
  r.move(1, 80, 10);
  r.g.cancel({ id: 1 });
  assert.deepEqual(r.names(), ['dragStart', 'dragMove', 'dragCancel']);
  r.down(1, 10, 10);
  r.g.cancel({ id: 1 });
  r.clock.advance(1000);
  assert.equal(r.names().length, 3, 'a cancelled press neither taps nor long-presses');
  r.down(1, 10, 10);
  r.down(2, 20, 20);
  r.g.reset();
  r.clock.advance(1000);
  assert.equal(r.g.active, false);
  r.down(5, 1, 1);
  r.up(5, 1, 1);
  assert.equal(r.names().at(-1), 'tap');
});

test('pinchCamera keeps the world point under the fingers and clamps the zoom', () => {
  const cam = { x: 100, y: 50, zoom: 1 };
  const world = (c, sx, sy) => ({ x: c.x + sx / c.zoom, y: c.y + sy / c.zoom });
  const before = world(cam, 200, 150);
  const next = pinchCamera(cam, { x: 200, y: 150, dx: 0, dy: 0, scale: 2 }, 0.5, 4);
  assert.equal(next.zoom, 2);
  assert.deepEqual(world(next, 200, 150), before);
  // Pan: the point under the old centre follows the fingers.
  const panned = pinchCamera(cam, { x: 230, y: 160, dx: 30, dy: 10, scale: 1 }, 0.5, 4);
  assert.deepEqual(world(panned, 230, 160), world(cam, 200, 150));
  assert.equal(pinchCamera(cam, { x: 0, y: 0, dx: 0, dy: 0, scale: 100 }, 0.5, 4).zoom, 4);
  assert.equal(pinchCamera(cam, { x: 0, y: 0, dx: 0, dy: 0, scale: 0.01 }, 0.5, 4).zoom, 0.5);
});

// ---- Layout helpers ------------------------------------------------------------------

test('layout: phones get the portrait or landscape drawer, tablets and desktops the side panel', () => {
  assert.equal(layoutMode(390, 844), 'portrait'); // iPhone 14
  assert.equal(layoutMode(360, 640), 'portrait');
  assert.equal(layoutMode(844, 390), 'landscape');
  assert.equal(layoutMode(667, 375), 'landscape'); // iPhone SE on its side
  assert.equal(layoutMode(1280, 800), 'desktop');
  assert.equal(layoutMode(768, 1024), 'desktop'); // iPad portrait keeps the sidebar
  assert.equal(layoutMode(1024, 768), 'desktop');
  assert.equal(layoutMode(700, 700), 'portrait', 'square small window');
  assert.ok(isCompact('portrait') && isCompact('landscape') && !isCompact('desktop'));
  assert.equal(TOUCH_TARGET, 44);
});

test('layout: render pixel ratio follows the device up to the cap; low quality goes below 1', () => {
  assert.equal(renderPixelRatio(3, 2), 2);
  assert.equal(renderPixelRatio(1.5, 2), 1.5);
  assert.equal(renderPixelRatio(3, 1), 1);
  assert.equal(renderPixelRatio(3, 2, true), LOW_QUALITY_RATIO);
  assert.equal(renderPixelRatio(0.5, 2, true), 0.5);
  assert.equal(renderPixelRatio(undefined, 2), 1, 'unknown device ratio');
  assert.equal(renderPixelRatio(3, Number.NaN), 2, 'bad cap: the old default');
});

test('layout: HUD text, full and compact, without the sidebar clock', () => {
  const s = { fps: 59.6, simMs: 0.4321 };
  // A normal game: the clock is in the sidebar, frame stats in the debug menu.
  assert.equal(hudText(s), '');
  assert.equal(hudText(s, true), '');
  assert.equal(hudText({ ...s, paused: true }), 'Paused');
  assert.equal(hudText({ ...s, paused: true }, true), 'Paused');
  // Stress tests keep their performance line.
  assert.equal(hudText({ ...s, stress: true, units: 5000, flowFields: 7 }), '60 fps  |  sim 0.43 ms/tick  |  5000 units  |  7 flow fields');
  assert.equal(hudText({ ...s, stress: true, units: 5000, flowFields: 7 }, true), '60 fps  5000 units');
  assert.equal(hudText({ ...s, paused: true, stress: true, units: 1, flowFields: 0 }, true), 'Paused  60 fps  1 units');
  assert.ok(!/\d+:\d\d/.test(hudText({ ...s, paused: true, stress: true })), 'no game clock in the HUD');
});

test('layout: the drawer collapses for placement on phones and restores the player choice', () => {
  const d = new DrawerState();
  assert.equal(d.shownCollapsed(true), false);
  d.setPlacing(true);
  assert.equal(d.shownCollapsed(true), true, 'phone: map free for the footprint');
  assert.equal(d.shownCollapsed(false), false, 'desktop never collapses');
  d.setPlacing(false);
  assert.equal(d.shownCollapsed(true), false, 'back to open');
  d.toggle();
  assert.equal(d.shownCollapsed(true), true, 'player collapsed it');
  d.setPlacing(true);
  d.setPlacing(false);
  assert.equal(d.shownCollapsed(true), true, 'stays collapsed');
  d.toggle();
  d.setPlacing(true);
  d.toggle();
  assert.equal(d.shownCollapsed(true), false, 'the toggle reopens it during placement');
});

test('settings: render resolution cap and low quality', () => {
  const s = createSettings(null);
  assert.equal(s.get('pixelRatioCap'), 2);
  assert.equal(s.get('lowQuality'), false);
  assert.equal(s.set('pixelRatioCap', 10), SCHEMA.pixelRatioCap.max);
  assert.equal(s.set('pixelRatioCap', 0), SCHEMA.pixelRatioCap.min);
  assert.equal(s.set('lowQuality', true), true);
});

test('hotkeys: run() invokes a registered action by name', () => {
  const reg = new HotkeyRegistry(createSettings(null));
  let n = 0;
  reg.registerAction('ping', 'K', () => n++);
  assert.equal(reg.run('ping'), true);
  assert.equal(n, 1);
  assert.equal(reg.run('nope'), false);
});

// ---- TouchControls over the real Input -------------------------------------------------

/** Minimal DOM: elements with attributes, children, listeners and classList. */
function fakeElement(tag = 'div') {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  return {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    hidden: false,
    disabled: false,
    textContent: '',
    title: '',
    className: '',
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on),
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute: (k) => attrs[k] ?? null,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    dispatch(type, e = {}) {
      for (const fn of listeners[type] ?? []) fn(e);
    },
    append(...c) {
      this.children.push(...c);
    },
  };
}

/** Let pending promises (fresh game answers) settle. */
const flush = () => new Promise((r) => setImmediate(r));

function installDom() {
  globalThis.window ??= { addEventListener() {} };
  globalThis.document = { createElement: fakeElement, body: fakeElement('body') };
}

/**
 * A fake engine: actors at fixed points (24 px pick radius), own units for
 * player 0. Records every order.
 */
function fakeGame(actors) {
  const calls = [];
  let selection = [];
  const own = (a) => a.owner === 0 && !a.building;
  const inRect = (a, x0, y0, x1, y1) => a.x >= Math.min(x0, x1) && a.x <= Math.max(x0, x1) && a.y >= Math.min(y0, y1) && a.y <= Math.max(y0, y1);
  const entries = () => Object.entries(actors).map(([id, a]) => [Number(id), a]);
  const rec = (name) => (...args) => calls.push([name, ...args.map((v) => (v instanceof Uint32Array ? Array.from(v) : v))]);
  return {
    calls,
    map_width: () => 100,
    map_height: () => 100,
    pick: (_p, x, y) => entries().find(([, a]) => Math.hypot(a.x - x, a.y - y) < 12)?.[0] ?? NONE,
    actor_json: (id) => JSON.stringify(actors[id] ?? null),
    set_selection: (ids) => (selection = Array.from(ids)),
    selection: () => Uint32Array.from(selection),
    deploy_state: () => 0,
    ability_deploy_state: () => 0,
    has_minelayer: () => false,
    sell_value: () => 0,
    cursor_action: (_p, _ids, x, y) => {
      const hit = entries().find(([, a]) => Math.hypot(a.x - x, a.y - y) < 12);
      return hit && hit[1].owner !== 0 ? ACTION.ATTACK : ACTION.MOVE;
    },
    select_box: (_p, x0, y0, x1, y1) => Uint32Array.from(entries().filter(([, a]) => own(a) && inRect(a, x0, y0, x1, y1)).map(([id]) => id)),
    player_count: () => 2,
    // Selection classes are the types here (engine/src/selection.rs).
    select_by_class: (owners, ids, x0, y0, x1, y1) => {
      const types = Array.from(ids).filter((id) => owners.includes(actors[id].owner)).map((id) => actors[id].type);
      return Uint32Array.from(entries().filter(([, a]) => owners.includes(a.owner) && types.includes(a.type) && inRect(a, x0, y0, x1, y1)).map(([i]) => i));
    },
    placement_preview: (_p, _id, cx, cy) => Int32Array.from([cx, cy, cx >= 0 && cy >= 0 ? 1 : 0]),
    order_smart: rec('order_smart'),
    order_move: rec('order_move'),
    order_attack: rec('order_attack'),
    order_stop: rec('order_stop'),
    place_building: rec('place_building'),
    activate_power: rec('activate_power'),
  };
}

/** Input (zoom 1, camera at 0,0, so view px = world px) + TouchControls + pointer helpers. */
async function setup(actors) {
  installDom();
  const { Input } = await import('../js/input.js');
  const { TouchControls } = await import('../js/touch.js');
  const canvas = fakeElement('canvas');
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  canvas.setPointerCapture = () => {};
  const game = fakeGame(actors);
  const hotkeys = new HotkeyRegistry(createSettings(null));
  const hooks = { onSelectionChanged() {}, onPlaced() {}, onCancelPlace() {}, onPowerTargeting() {}, onMode() {} };
  const rules = { actors: [{ id: 'powr', width: 2, height: 2 }] };
  const input = new Input(canvas, game, rules, 0, hooks, { hotkeys, settings: createSettings(null) });
  input.camera.zoom = 1;
  const clock = fakeClock();
  const field = fakeElement('main');
  const touch = new TouchControls({ canvas, field, input, hotkeys, gestures: { setTimer: clock.setTimer, clearTimer: clock.clearTimer } });
  const ev = (id, x, y, pointerType = 'touch') => ({ pointerId: id, clientX: x, clientY: y, timeStamp: clock.now, pointerType, preventDefault() {} });
  // Each gesture resolves once what it started has finished: clicks ask the
  // game for fresh answers (js/input.js `ask`), which settle asynchronously.
  const p = {
    down: (id, x, y, type) => (canvas.dispatch('pointerdown', ev(id, x, y, type)), flush()),
    move: (id, x, y, type) => (canvas.dispatch('pointermove', ev(id, x, y, type)), flush()),
    up: (id, x, y, type) => (canvas.dispatch('pointerup', ev(id, x, y, type)), flush()),
    async tap(x, y) {
      await this.down(1, x, y);
      clock.advance(40);
      await flush();
      await this.up(1, x, y);
    },
    async longPress(x, y) {
      await this.down(1, x, y);
      clock.advance(GESTURE_DEFAULTS.longPressMs + 10);
      await flush();
      await flush();
      await this.up(1, x, y);
    },
  };
  const bar = (id) => touch.buttons.get(id);
  return { input, touch, game, clock, p, bar, canvas, hotkeys };
}

const ARMY = {
  1: { owner: 0, type: 'e1', x: 100, y: 100 },
  2: { owner: 0, type: 'e1', x: 140, y: 100 },
  3: { owner: 0, type: '1tnk', x: 180, y: 100 },
  4: { owner: 0, type: 'e1', x: 700, y: 500 },
  9: { owner: 1, type: '2tnk', x: 400, y: 300 },
};

test('touch: tap selects, tap on the ground or an enemy gives the order; mouse pointers are ignored', async () => {
  const { input, game, p, clock } = await setup(ARMY);
  assert.equal(document.body.classList.contains('touch'), false);
  await p.tap(100, 100);
  assert.ok(document.body.classList.contains('touch'), 'the first touch shows the touch UI');
  assert.deepEqual(input.selection, [1]);
  clock.advance(1000);
  await flush();
  await p.tap(300, 200);
  assert.deepEqual(game.calls.at(-1), ['order_smart', 0, [1], 300, 200]);
  clock.advance(1000);
  await flush();
  await p.tap(400, 300);
  assert.deepEqual(game.calls.at(-1), ['order_smart', 0, [1], 400, 300], 'attack through the smart order');
  const n = game.calls.length;
  await p.down(7, 500, 500, 'mouse');
  await p.up(7, 500, 500, 'mouse');
  assert.equal(game.calls.length, n, 'mouse goes through js/input.js mouse handlers, not here');
});

test('touch: Add toggle adds and removes taps and boxes; double tap selects the type on screen', async () => {
  const { input, p, bar, clock } = await setup(ARMY);
  await p.tap(100, 100);
  clock.advance(1000);
  await flush();
  bar('queue').dispatch('click');
  await flush();
  assert.equal(bar('queue').getAttribute('aria-pressed'), 'true');
  await p.tap(180, 100);
  assert.deepEqual(input.selection, [1, 3]);
  clock.advance(1000);
  await flush();
  await p.tap(100, 100);
  assert.deepEqual(input.selection, [3], 'tapping a selected unit with Add removes it');
  bar('queue').dispatch('click');
  await flush();
  clock.advance(1000);
  await flush();
  // Double tap on a rifleman: all riflemen on screen (not the tank, and 4 is on screen too).
  await p.tap(140, 100);
  clock.advance(120);
  await flush();
  await p.tap(141, 101);
  assert.deepEqual(input.selection.sort(), [1, 2, 4]);
});

test('touch: drag box-selects (with Add: adds), a second finger cancels the box', async () => {
  const { input, p, clock, bar } = await setup(ARMY);
  await p.down(1, 80, 80);
  await p.move(1, 120, 90);
  assert.ok(input.drag, 'the box is drawn while dragging');
  await p.move(1, 150, 120);
  await p.up(1, 150, 120);
  assert.deepEqual(input.selection, [1, 2]);
  assert.equal(input.drag, null);
  bar('queue').dispatch('click');
  await flush();
  await p.down(1, 690, 490);
  await p.move(1, 720, 520);
  await p.up(1, 720, 520);
  assert.deepEqual(input.selection, [1, 2, 4]);
  // A pinch that starts as a box leaves the selection alone.
  bar('queue').dispatch('click');
  await flush();
  clock.advance(1000);
  await flush();
  await p.down(1, 0, 0);
  await p.move(1, 300, 300);
  await p.down(2, 500, 500);
  assert.equal(input.drag, null);
  await p.up(1, 300, 300);
  await p.up(2, 500, 500);
  assert.deepEqual(input.selection, [1, 2, 4]);
});

test('touch: two fingers pan and pinch-zoom the camera around the fingers', async () => {
  const { input, p } = await setup(ARMY);
  input.camera.x = 200;
  input.camera.y = 200;
  const under = input.toWorld(400, 300);
  await p.down(1, 350, 300);
  await p.down(2, 450, 300);
  await p.move(1, 300, 300);
  await p.move(2, 500, 300);
  assert.ok(Math.abs(input.camera.zoom - 2) < 1e-9);
  const after = input.toWorld(400, 300);
  assert.ok(Math.abs(after.x - under.x) < 1e-6 && Math.abs(after.y - under.y) < 1e-6);
  await p.move(1, 320, 340);
  await p.move(2, 520, 340);
  const panned = input.toWorld(420, 340);
  assert.ok(Math.abs(panned.x - under.x) < 1e-6 && Math.abs(panned.y - under.y) < 1e-6, 'the map follows the fingers');
  await p.up(1, 320, 340);
  await p.up(2, 520, 340);
  assert.deepEqual(input.selection, [], 'no tap fired');
});

test('touch: long press force-attacks, attack-moves, or cancels; Force toggle attacks any actor', async () => {
  const { input, game, p, bar, clock } = await setup(ARMY);
  await p.longPress(400, 400);
  assert.equal(game.calls.length, 0, 'nothing selected: right click, which clears');
  await p.tap(100, 100);
  clock.advance(1000);
  await flush();
  await p.longPress(400, 300);
  assert.deepEqual(game.calls.at(-1), ['order_attack', 0, [1], 9]);
  await p.longPress(180, 100);
  assert.deepEqual(game.calls.at(-1), ['order_attack', 0, [1], 3], 'own unit too: force fire');
  await p.longPress(600, 100);
  assert.deepEqual(game.calls.at(-1), ['order_move', 0, [1], 600, 100, true], 'ground: attack move');
  // Long press cancels a mode instead.
  bar('attackMove').dispatch('click');
  await flush();
  assert.equal(input.attackMove, true, 'the bar runs the attackMove hotkey action');
  const n = game.calls.length;
  await p.longPress(600, 100);
  assert.equal(input.attackMove, false);
  assert.equal(game.calls.length, n);
  // Force: the next tap attacks whatever it hits, then the mode ends.
  bar('force').dispatch('click');
  await flush();
  assert.equal(bar('force').getAttribute('aria-pressed'), 'true');
  clock.advance(1000);
  await flush();
  await p.tap(140, 100);
  assert.deepEqual(game.calls.at(-1), ['order_attack', 0, [1], 2]);
  assert.equal(touch_pressed(bar('force')), false);
  // Cancel: clears the selection when no mode is active.
  bar('cancel').dispatch('click');
  await flush();
  assert.deepEqual(input.selection, []);
  assert.equal(bar('force').disabled, true, 'unit commands need units');
});

const touch_pressed = (b) => b.getAttribute('aria-pressed') === 'true';

test('touch: attack move from the bar, then tap the destination (drag: aim and release)', async () => {
  const { input, game, p, bar, clock } = await setup(ARMY);
  await p.tap(100, 100);
  clock.advance(1000);
  await flush();
  bar('attackMove').dispatch('click');
  await flush();
  await p.down(1, 300, 300);
  await p.move(1, 350, 320);
  await p.up(1, 360, 330);
  assert.deepEqual(game.calls.at(-1), ['order_move', 0, [1], 360, 330, true]);
  assert.equal(input.attackMove, false);
});

test('touch: placement shows the footprint mid-view, tap and drag move it, Place builds', async () => {
  const { input, touch, game, p } = await setup(ARMY);
  document.body.classList.add('touch'); // a touch screen
  input.startPlacing('powr');
  touch.update();
  assert.equal(touch.placeBar.hidden, false);
  assert.equal(touch.bar.hidden, true, 'Place and Cancel replace the action bar');
  assert.deepEqual([input.mouse.x, input.mouse.y, input.mouse.inside, input.mouse.touch], [400, 300, true, true]);
  input.update(0.1);
  assert.equal(input.camera.x, 0, 'no edge scrolling from a finger');
  await p.tap(240, 120);
  assert.deepEqual([input.mouse.x, input.mouse.y], [240, 120]);
  assert.equal(game.calls.length, 0, 'a tap moves the footprint, it does not build');
  // Drag from anywhere moves the footprint by the finger's movement.
  await p.down(1, 600, 500);
  await p.move(1, 630, 520);
  await p.up(1, 648, 524);
  assert.deepEqual([input.mouse.x, input.mouse.y], [288, 144]);
  touch.update();
  assert.equal(touch.placeButton.disabled, false);
  touch.placeButton.dispatch('click');
  await flush();
  assert.deepEqual(game.calls.at(-1), ['place_building', 0, 'powr', 11, 5]);
  assert.equal(input.placing, null);
  touch.update();
  assert.equal(touch.placeBar.hidden, true);
  assert.equal(input.mouse.inside, false, 'the finger no longer stands in for the mouse');
});

test('touch: support power targets by tap; a drag sets the direction', async () => {
  const { input, game, p } = await setup(ARMY);
  input.startPowerTargeting({ key: 'paratroopers', kind: 'ParatroopersPower', name: 'Paratroopers' });
  await p.tap(300, 200);
  assert.deepEqual(game.calls.at(-1), ['activate_power', 0, 'paratroopers', 300, 200, undefined, undefined]);
  assert.equal(input.power, null);
  input.startPowerTargeting({ key: 'paratroopers', kind: 'ParatroopersPower', name: 'Paratroopers' });
  await p.down(1, 300, 200);
  await p.move(1, 340, 200);
  await p.up(1, 400, 260);
  assert.deepEqual(game.calls.at(-1), ['activate_power', 0, 'paratroopers', 300, 200, 400, 260]);
});

test('touch: the Controls page lists every touch gesture', async () => {
  const { touchControls, TOUCH_BAR } = await import('../js/touch.js');
  const rows = touchControls();
  for (const g of ['Tap', 'Double tap', 'Drag', 'Pinch', 'Long press']) assert.ok(rows.some(([k]) => k === g), g);
  for (const b of TOUCH_BAR) assert.ok(b.label && b.title, b.id);
});
