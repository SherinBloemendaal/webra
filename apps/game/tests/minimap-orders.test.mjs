// Orders through the radar (OpenRA RadarWidget): a click on the radar is the
// click on that spot of the battlefield, through the real Input, CommandBar,
// TouchControls and Minimap over a fake game and a minimal fake DOM. No
// browser and no WebAssembly. Run with: node --test apps/game/tests/minimap-orders.test.mjs
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ACTION, CURSORS, setCursorArt } from '../js/cursors.js';
import { RADAR, TRANSITION_MS, REFRESH_MS } from '../js/minimap.js';
import { HotkeyRegistry } from '../js/hotkeys.js';
import { createSettings } from '../js/settings.js';
import { withTargetLines } from '../js/targetlines.js';

const NONE = 0xffffffff;
const CELL = 24;
/** The fake map: 64 x 64 cells, water from column 48 on. */
const MAP = 64;
const WATER_X = 48 * CELL;
/** The radar picture: 128 x 128 CSS px, so one radar px is half a cell (12 world px). */
const RADAR_PX = 128;
const PX = (MAP * CELL) / RADAR_PX;

/** Minimal DOM element: attributes, children, listeners, classList and style. */
function fakeElement(tag = 'div') {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  const props = new Map();
  return {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    hidden: false,
    textContent: '',
    innerHTML: '',
    className: '',
    clientWidth: 200,
    clientHeight: 200,
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), getPropertyValue: (k) => props.get(k) ?? '' },
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
    removeAttribute: (k) => delete attrs[k],
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    dispatch(type, e = {}) {
      for (const fn of listeners[type] ?? []) fn(e);
    },
    append(...c) {
      this.children.push(...c);
    },
    prepend(...c) {
      this.children.unshift(...c);
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: RADAR_PX, height: RADAR_PX }),
    setPointerCapture() {},
  };
}

function installDom() {
  globalThis.window ??= { addEventListener() {} };
  globalThis.document = { createElement: fakeElement, getElementById: () => null, addEventListener() {}, body: fakeElement('body') };
}

/** Let pending promises (fresh game answers) settle. */
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/**
 * A fake engine: actors at fixed points (picked by cell), own units for
 * player 0, water from WATER_X on (a blocked move for the land units). Records
 * every order.
 */
function fakeGame(actors) {
  const calls = [];
  let selection = [];
  const entries = () => Object.entries(actors).map(([id, a]) => [Number(id), a]);
  const cell = (v) => Math.floor(v / CELL);
  const at = (x, y) => entries().find(([, a]) => cell(a.x) === cell(x) && cell(a.y) === cell(y));
  const rec = (name) => (...args) => calls.push([name, ...args.map((v) => (v instanceof Uint32Array ? Array.from(v) : v))]);
  return {
    calls,
    map_width: () => MAP,
    map_height: () => MAP,
    radar_state: () => RADAR.ONLINE,
    minimap_blips: () => new Int32Array(0),
    pick: (_p, x, y) => at(x, y)?.[0] ?? NONE,
    actor_json: (id) => JSON.stringify(actors[id] ?? null),
    are_allies: (a, b) => a === b,
    set_selection: (ids) => (selection = Array.from(ids)),
    selection: () => Uint32Array.from(selection),
    deploy_state: () => 0,
    deploy_summary: () => 0,
    command_state: (_p, ids) => {
      const units = Array.from(ids).filter((id) => actors[id]?.owner === 0 && !actors[id].building).length;
      return JSON.stringify({ units, armed: units, guard: 0, scatter: 0, stances: {} });
    },
    has_minelayer: () => false,
    can_attack_ground: () => true,
    can_attack_actor: () => true,
    can_guard: () => false,
    sell_value: (_p, id) => (actors[id]?.building && actors[id].owner === 0 ? 100 : -1),
    cursor_action: (_p, _ids, x, y) => {
      const hit = at(x, y);
      if (hit && hit[1].owner !== 0) return ACTION.ATTACK;
      return x >= WATER_X ? ACTION.MOVE_BLOCKED : ACTION.MOVE;
    },
    order_smart: rec('order_smart'),
    order_move: rec('order_move'),
    order_waypoint: rec('order_waypoint'),
    order_attack: rec('order_attack'),
    order_attack_ground: rec('order_attack_ground'),
    set_rally: rec('set_rally'),
    sell: rec('sell'),
  };
}

const ARMY = {
  1: { owner: 0, type: 'e1', x: 100, y: 100 },
  2: { owner: 0, type: '1tnk', x: 140, y: 100 },
  5: { owner: 0, type: 'weap', building: true, producer: true, x: 300, y: 300 },
  9: { owner: 1, type: '2tnk', x: 40 * CELL, y: 20 * CELL },
};

/**
 * Input, command bar, touch controls and the radar, wired like js/main.js.
 * The radar is online and open at once.
 */
async function setup({ spectator = false } = {}) {
  installDom();
  const { Input } = await import('../js/input.js');
  const { CommandBar } = await import('../js/commandbar.js');
  const { TouchControls } = await import('../js/touch.js');
  const { Minimap } = await import('../js/minimap.js');
  const raw = fakeGame(ARMY);
  // Orders through `ui` show target lines (and get unit replies, js/audio) like on the battlefield.
  const lines = [];
  const game = withTargetLines(raw, (ids) => lines.push(ids));
  const replies = [];
  const view = fakeElement('canvas');
  view.clientWidth = 800;
  view.clientHeight = 600;
  view.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  const hotkeys = new HotkeyRegistry(createSettings(null));
  let commandBar = null;
  const input = new Input(
    view,
    game,
    { actors: [] },
    0,
    {
      onSelectionChanged() {},
      onPowerTargeting() {},
      onMode() {},
      commandMouseDown: (w, e) => commandBar?.mouseDown(w, e) ?? false,
      commandClick: (w, mods) => commandBar?.click(w, mods) ?? false,
      commandCursor: (w, mods) => commandBar?.cursor(w, mods) ?? null,
      cancelCommand: () => commandBar?.cancel() ?? false,
      queuesAttackMove: (shift) => commandBar?.queuesAttackMove(shift) ?? shift,
      onSmartOrder: (action) => replies.push(action),
    },
    { hotkeys, settings: createSettings(null), spectator },
  );
  input.camera.zoom = 1;
  const field = fakeElement('main');
  commandBar = new CommandBar(field, { game, input, player: 0, hotkeys, spectator });
  const touch = new TouchControls({ canvas: view, field: fakeElement('main'), input, hotkeys });
  const radar = fakeElement('div');
  const mm = new Minimap(radar, { game, fog: () => new Uint8Array(MAP * MAP), player: 0, input, colors: [[1, 1, 1]], touch });
  mm.frame(0);
  mm.frame(TRANSITION_MS + REFRESH_MS);
  assert.ok(mm.usable(), 'the radar is online');
  const centers = [];
  const centerOn = input.centerOn.bind(input);
  input.centerOn = (x, y) => {
    centers.push([x, y]);
    centerOn(x, y);
  };
  let id = 1;
  const ev = (x, y, o = {}) => ({ pointerId: o.id ?? id, button: o.button ?? 0, clientX: x, clientY: y, pointerType: o.type ?? 'mouse', shiftKey: !!o.shift, ctrlKey: !!o.ctrl, metaKey: false, altKey: !!o.alt, preventDefault() {} });
  const c = mm.canvas;
  const p = {
    down: async (x, y, o) => (c.dispatch('pointerdown', ev(x, y, o)), flush()),
    move: async (x, y, o) => (c.dispatch('pointermove', ev(x, y, o)), flush()),
    up: async (x, y, o) => (c.dispatch('pointerup', ev(x, y, o)), flush()),
    async click(x, y, o = {}) {
      await this.down(x, y, o);
      await this.up(x, y, o);
      id++;
    },
  };
  const orders = () => raw.calls.filter(([name]) => name !== 'set_selection');
  return { input, commandBar, field, touch, mm, raw, lines, replies, centers, p, orders };
}

test('command bar: where it sits and how tall it is go on the battlefield, so the tour card above it keeps clear', async () => {
  const { commandBar, field } = await setup();
  const touchBar = fakeElement('div');
  touchBar.offsetParent = {};
  touchBar.offsetHeight = 0;
  const getById = document.getElementById;
  document.getElementById = (id) => (id === 'touch-bar' ? touchBar : getById?.call(document, id) ?? null);
  try {
    commandBar.root.offsetHeight = 39;
    commandBar.update();
    assert.equal(field.style.getPropertyValue('--cb-height'), '39px');
    assert.equal(field.style.getPropertyValue('--cb-bottom'), '', 'desktop: the default place (css/commandbar.css)');
    // Touch: the action bar shows and the command bar wraps to two rows.
    touchBar.offsetHeight = 100;
    commandBar.root.offsetHeight = 78;
    commandBar.update();
    assert.equal(field.style.getPropertyValue('--cb-bottom'), 'calc(100px + 14 * var(--ui-px))');
    assert.equal(field.style.getPropertyValue('--cb-height'), '78px');
    // The tour card (css/guide.css .tour) adds both up; the bar's own element keeps nothing of its own.
    const css = readFileSync(new URL('../css/guide.css', import.meta.url), 'utf8');
    assert.match(css, /\.tour \{[^}]*bottom: calc\(var\(--cb-bottom[^;]*var\(--cb-height/);
    commandBar.root.remove ??= () => {}; // the minimal fake DOM's elements have no remove()
    commandBar.destroy();
    assert.equal(field.style.getPropertyValue('--cb-bottom'), '');
    assert.equal(field.style.getPropertyValue('--cb-height'), '');
  } finally {
    document.getElementById = getById;
  }
});

test('radar: a left click with units selected moves them there, like a click on the battlefield', async () => {
  const { input, p, orders, centers, lines, replies } = await setup();
  input.setSelection([1, 2]);
  await p.click(40, 20);
  // 40, 20 radar px are 480, 240 world px.
  assert.deepEqual(orders(), [['order_smart', 0, [1, 2], 40 * PX, 20 * PX]]);
  assert.deepEqual(replies, [ACTION.MOVE], 'the unit reply of a move (js/audio smartOrder)');
  assert.deepEqual(lines, [[1, 2]], 'the ordered units show their target lines');
  assert.equal(input.orderFlash.action, ACTION.MOVE);
  assert.deepEqual(centers, [], 'an order does not move the camera');
});

test('radar: the right and middle buttons only move the camera, also with units selected, and follow a drag', async () => {
  const { input, p, orders, centers, lines, replies } = await setup();
  input.setSelection([1, 2]);
  // Over the enemy tank and over open ground: no attack, no move.
  await p.click(80, 40, { button: 2 });
  await p.click(40, 20, { button: 2, shift: true });
  await p.down(10, 10, { button: 1 });
  await p.move(20, 30, { button: 1 });
  await p.up(20, 30, { button: 1 });
  await p.move(0, 0); // released: no more camera moves
  assert.deepEqual(orders(), []);
  assert.deepEqual(replies, []);
  assert.deepEqual(lines, []);
  assert.equal(input.orderFlash ?? null, null);
  assert.deepEqual(input.selection, [1, 2], 'the selection stays');
  assert.deepEqual(centers, [
    [80 * PX, 40 * PX],
    [40 * PX, 20 * PX],
    [10 * PX, 10 * PX],
    [20 * PX, 30 * PX],
  ]);
  // A right drag follows the pointer, and a left click afterwards still orders.
  centers.length = 0;
  await p.down(30, 30, { button: 2 });
  await p.move(35, 40, { button: 2 });
  await p.up(35, 40, { button: 2 });
  assert.deepEqual(centers, [
    [30 * PX, 30 * PX],
    [35 * PX, 40 * PX],
  ]);
  await p.click(40, 20);
  assert.deepEqual(orders(), [['order_smart', 0, [1, 2], 40 * PX, 20 * PX]]);
});

test('radar: a right click moves the camera with a sidebar mode or attack move on, and keeps it on', async () => {
  const { input, p, orders, centers } = await setup();
  input.setSelection([1]);
  input.attackMove = true;
  await p.click(60, 60, { button: 2 });
  assert.equal(input.attackMove, true, 'attack move is not used up');
  input.attackMove = false;
  input.setMode('repair');
  await p.click(300 / PX, 300 / PX, { button: 2 });
  assert.equal(input.mode, 'repair', 'the mode stays on');
  assert.deepEqual(orders(), []);
  assert.deepEqual(centers, [
    [60 * PX, 60 * PX],
    [300, 300],
  ]);
});

test('radar: the left button is the action button, as on the battlefield', async () => {
  const { input, p, orders, centers, replies } = await setup();
  input.setSelection([1]);
  // Over the enemy tank: the smart order attacks it.
  await p.click(80, 40);
  assert.deepEqual(orders(), [['order_smart', 0, [1], 80 * PX, 40 * PX]]);
  assert.deepEqual(replies, [ACTION.ATTACK]);
  assert.deepEqual(centers, []);
});

test('radar: Shift queues a waypoint, Ctrl force fires, Alt force moves (the command bar)', async () => {
  const { input, p, orders } = await setup();
  input.setSelection([1, 2]);
  await p.click(10, 10, { shift: true });
  await p.click(20, 10, { shift: true });
  await p.click(30, 30, { ctrl: true });
  await p.click(80, 40, { ctrl: true });
  await p.click(50, 50, { alt: true });
  assert.deepEqual(orders(), [
    ['order_waypoint', 0, [1, 2], 10 * PX, 10 * PX, false],
    ['order_waypoint', 0, [1, 2], 20 * PX, 10 * PX, false],
    ['order_attack_ground', 0, [1, 2], 30 * PX, 30 * PX],
    ['order_attack', 0, [1, 2], 9],
    ['order_move', 0, [1, 2], 50 * PX, 50 * PX, false],
  ]);
});

test('radar: attack move and an armed command bar mode act on the radar spot', async () => {
  const { input, commandBar, p, orders } = await setup();
  input.setSelection([1]);
  input.attackMove = true;
  await p.click(60, 60);
  assert.equal(input.attackMove, false, 'used up like on the battlefield');
  await p.click(70, 60, { shift: true }); // not armed any more: a queued waypoint
  commandBar.mode = 'forceMove';
  await p.click(12, 12);
  assert.equal(commandBar.mode, null);
  assert.deepEqual(orders(), [
    ['order_move', 0, [1], 60 * PX, 60 * PX, true],
    ['order_waypoint', 0, [1], 70 * PX, 60 * PX, false],
    ['order_move', 0, [1], 12 * PX, 12 * PX, false],
  ]);
});

test('radar: with nothing selected a click or drag moves the camera and gives no order', async () => {
  const { p, orders, centers } = await setup();
  await p.down(64, 64);
  await p.move(32, 96);
  await p.up(32, 96);
  await p.move(0, 0); // released: no more camera moves
  await p.click(10, 10, { button: 2 });
  assert.deepEqual(orders(), []);
  assert.deepEqual(centers, [
    [64 * PX, 64 * PX],
    [32 * PX, 96 * PX],
    [10 * PX, 10 * PX],
  ]);
});

test('radar: a spot with no order (an own unit there) moves the camera instead of selecting', async () => {
  const { input, p, orders, centers } = await setup();
  input.setSelection([1]);
  await p.click(140 / PX, 100 / PX);
  assert.deepEqual(orders(), []);
  assert.deepEqual(input.selection, [1], 'the radar never selects');
  assert.deepEqual(centers, [[140, 100]]);
});

test('radar: sidebar modes act with the left button; the right button moves the camera', async () => {
  const { input, p, orders, centers } = await setup();
  input.setMode('sell');
  await p.click(300 / PX, 300 / PX, { button: 2 });
  assert.deepEqual(orders(), []);
  assert.deepEqual(centers, [[300, 300]]);
  await p.click(300 / PX, 300 / PX);
  assert.deepEqual(orders(), [['sell', 0, 5]]);
});

test('radar: a selected factory gets its rally point there', async () => {
  const { input, p, orders } = await setup();
  input.setSelection([5]);
  await p.click(20, 30);
  assert.deepEqual(orders(), [['set_rally', 0, 5, 20 * PX, 30 * PX]]);
});

test('radar: spectators and replays give no orders, they move the camera', async () => {
  const { input, p, orders, centers } = await setup({ spectator: true });
  input.setSelection([1]);
  await p.click(40, 20, { button: 2 });
  await p.click(40, 30);
  assert.deepEqual(orders(), []);
  assert.deepEqual(centers, [
    [40 * PX, 20 * PX],
    [40 * PX, 30 * PX],
  ]);
});

test('radar: the cursor shows the order the spot would get (move, blocked move, attack)', async () => {
  const { input, mm, p } = await setup();
  const hover = async (x, y) => {
    await p.move(x, y);
    mm.updateCursor();
    return mm.canvas.style.cursor;
  };
  assert.equal(await hover(10, 10), CURSORS.select, 'nothing selected: the arrow (a click moves the camera)');
  input.setSelection([1, 2]);
  assert.equal(await hover(10, 10), CURSORS.move);
  assert.equal(await hover(WATER_X / PX + 4, 10), CURSORS.moveBlocked, 'water: OpenRA move-blocked');
  assert.equal(await hover(80, 40), CURSORS.attack);
  // With the original cursors installed, the radar shows their "-minimap" variants.
  const art = new Map([
    ['move', { frames: ['url(move.png) 0 0, auto'], fps: 1 }],
    ['move-minimap', { frames: ['url(move-minimap.png) 0 0, auto'], fps: 1 }],
    ['attack', { frames: ['url(attack.png) 0 0, auto'], fps: 1 }],
  ]);
  try {
    setCursorArt(art);
    assert.equal(await hover(10, 10), 'url(move-minimap.png) 0 0, auto');
    assert.equal(await hover(80, 40), 'url(attack.png) 0 0, auto', 'no radar variant: the cursor itself');
  } finally {
    setCursorArt(null);
  }
});

test('radar touch: with units selected a tap gives the order and a drag moves the camera', async () => {
  const { input, touch, p, orders, centers } = await setup();
  input.setSelection([1]);
  const t = { type: 'touch' };
  await p.down(40, 40, t);
  assert.deepEqual(centers, [], 'waits for the tap');
  await p.up(41, 40, t);
  assert.deepEqual(orders(), [['order_smart', 0, [1], 40 * PX, 40 * PX]]);
  // Add (the Shift substitute) queues it.
  touch.queue = true;
  await p.down(20, 20, { ...t, id: 7 });
  await p.up(20, 20, { ...t, id: 7 });
  touch.queue = false;
  assert.deepEqual(orders().at(-1), ['order_waypoint', 0, [1], 20 * PX, 20 * PX, false]);
  const n = orders().length;
  await p.down(10, 10, { ...t, id: 8 });
  await p.move(30, 10, { ...t, id: 8 });
  await p.move(50, 20, { ...t, id: 8 });
  await p.up(50, 20, { ...t, id: 8 });
  assert.equal(orders().length, n, 'a drag gives no order');
  assert.deepEqual(centers, [
    [30 * PX, 10 * PX],
    [50 * PX, 20 * PX],
  ]);
});

test('radar touch: with nothing selected a touch moves the camera at once', async () => {
  const { p, orders, centers } = await setup();
  await p.down(40, 40, { type: 'touch' });
  assert.deepEqual(centers, [[40 * PX, 40 * PX]]);
  await p.move(60, 40, { type: 'touch' });
  await p.up(60, 40, { type: 'touch' });
  assert.deepEqual(centers, [
    [40 * PX, 40 * PX],
    [60 * PX, 40 * PX],
  ]);
  assert.deepEqual(orders(), []);
});
