// Radar minimap: the pure drawing and coordinate helpers of js/minimap.js, and
// the engine's minimap API through WebAssembly (run after `npm run build:wasm`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAP_FORMAT_VERSION } from '../js/protocol.js';
import { fileURLToPath } from 'node:url';
import {
  Minimap,
  RADAR,
  TERRAIN_RGB,
  ORE_RGB,
  GEM_RGB,
  REFRESH_MS,
  TRANSITION_MS,
  cameraFrame,
  composeRadar,
  fillStatic,
  fitRect,
  minimapToWorld,
  radarLabel,
  revealAt,
} from '../js/minimap.js';
import { COMBINED_VIEW, OBSERVER_VIEW } from '../js/observer.js';
import { initSync, Game } from '../pkg/webra_sim.js';

const wasmPath = fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url));
initSync({ module: readFileSync(wasmPath) });

const COLORS = [
  [0.3, 0.55, 0.95],
  [0.9, 0.25, 0.2],
];
const px = (out, w, x, y) => Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

test('the picture fits the radar box with the map aspect ratio, centred', () => {
  assert.deepEqual(fitRect(200, 200, 64, 64), { x: 0, y: 0, w: 200, h: 200 });
  assert.deepEqual(fitRect(224, 200, 128, 64), { x: 0, y: 44, w: 224, h: 112 });
  assert.deepEqual(fitRect(224, 110, 64, 64), { x: 57, y: 0, w: 110, h: 110 });
  assert.deepEqual(fitRect(0, 100, 64, 64), { x: 0, y: 0, w: 0, h: 0 });
});

test('radar positions map to world pixels, clamped to the map', () => {
  const rect = { left: 10, top: 20, width: 100, height: 50 };
  assert.deepEqual(minimapToWorld(10, 20, rect, 64, 32), { x: 0, y: 0 });
  assert.deepEqual(minimapToWorld(60, 45, rect, 64, 32), { x: 32 * 24, y: 16 * 24 });
  assert.deepEqual(minimapToWorld(500, -5, rect, 64, 32), { x: 64 * 24, y: 0 });
});

test('the camera frame is the view as fractions of the map, clipped', () => {
  const f = cameraFrame({ x0: 24 * 16, y0: 24 * 8, x1: 24 * 48, y1: 24 * 24 }, 64, 32);
  assert.deepEqual(f, { l: 0.25, t: 0.25, w: 0.5, h: 0.5 });
  const edge = cameraFrame({ x0: -100, y0: -100, x1: 24 * 32, y1: 24 * 64 }, 64, 32);
  assert.deepEqual(edge, { l: 0, t: 0, w: 0.5, h: 1 });
});

test('compose: terrain, ore, gems, shroud, fog and blips in team colours', () => {
  const w = 4;
  const h = 2;
  const terrain = new Uint8Array(w * h * 4);
  terrain[0 * 4] = 3; // water
  terrain[1 * 4 + 1] = 200; // ore
  terrain[2 * 4] = 20; // a terrain type the client does not know yet
  terrain[(4 + 0) * 4 + 2] = 85; // gems
  const fog = new Uint8Array([255, 255, 128, 0, 255, 255, 255, 255]);
  const blips = new Int32Array([1, 1, 2, 1, 1, 3, 1, 5, 5, 255]);
  const out = composeRadar(new Uint8ClampedArray(w * h * 4), terrain, fog, blips, COLORS, w, h);
  assert.deepEqual(px(out, w, 0, 0), [...TERRAIN_RGB[3], 255]);
  assert.deepEqual(px(out, w, 1, 0), [...ORE_RGB, 255]);
  assert.deepEqual(px(out, w, 2, 0), [31, 44, 22, 255], 'fog darkens; unknown terrain falls back to clear');
  assert.deepEqual(px(out, w, 3, 0), [0, 0, 0, 255], 'shroud is black');
  const red = [230, 64, 51, 255];
  assert.deepEqual(px(out, w, 1, 1), red, 'a 2x1 structure of player 1');
  assert.deepEqual(px(out, w, 2, 1), red);
  assert.deepEqual(px(out, w, 3, 1), [170, 170, 170, 255], 'neutral grey, clipped to the map');
  assert.deepEqual(px(out, w, 0, 1), [...GEM_RGB, 255]);
});

test('compose handles thousands of blips quickly', () => {
  const w = 256;
  const h = 256;
  const n = 20000;
  const blips = new Int32Array(n * 5);
  for (let i = 0; i < n; i++) blips.set([(i * 7) % w, (i * 13) % h, 1, 1, i % 2], i * 5);
  const out = new Uint8ClampedArray(w * h * 4);
  const terrain = new Uint8Array(w * h * 4);
  const fog = new Uint8Array(w * h).fill(255);
  const t0 = performance.now();
  for (let k = 0; k < 10; k++) composeRadar(out, terrain, fog, blips, COLORS, w, h);
  const ms = (performance.now() - t0) / 10;
  assert.ok(ms < REFRESH_MS / 5, `one refresh took ${ms.toFixed(1)} ms`);
});

test('static noise is opaque grey', () => {
  let s = 1;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = fillStatic(new Uint8ClampedArray(64 * 4), rand);
  for (let o = 0; o < out.length; o += 4) {
    assert.equal(out[o], out[o + 1]);
    assert.equal(out[o], out[o + 2]);
    assert.equal(out[o + 3], 255);
  }
});

test('the radar opens and closes over the transition time', () => {
  assert.equal(revealAt(true, 0, 0), 0);
  assert.equal(revealAt(true, 0, TRANSITION_MS / 2), 0.5);
  assert.equal(revealAt(true, 0, TRANSITION_MS * 3), 1);
  assert.equal(revealAt(false, 0, TRANSITION_MS / 4), 0.75);
  assert.equal(revealAt(false, -Infinity, 0), 0, 'never online: closed');
  assert.equal(radarLabel(RADAR.ONLINE), '');
  assert.match(radarLabel(RADAR.JAMMED), /jammed/i);
  assert.match(radarLabel(RADAR.LOW_POWER), /power/i);
  assert.match(radarLabel(RADAR.NONE), /no radar/i);
});

// ---- Engine API ------------------------------------------------------------------

/** An all-clear 64x64 map with actors (owner: spawn index). */
function mapWith(actors) {
  const size = 64;
  const zeros = Buffer.alloc(size * size).toString('base64');
  return JSON.stringify({
    formatVersion: MAP_FORMAT_VERSION,
    format: 1,
    name: 'Radar test',
    author: 'Tests',
    description: '',
    width: size,
    height: size,
    terrain: zeros,
    ore: zeros,
    spawns: [
      [4, 4],
      [56, 56],
    ],
    actors: actors.map(([type, owner, x, y]) => ({ type, owner, x, y, facing: 0 })),
    rules: null,
  });
}

const OPTIONS = JSON.stringify({
  seed: 9,
  players: [
    { slot: 0, type: 'human', name: 'A', faction: 'england', color: 0 },
    { slot: 1, type: 'human', name: 'B', faction: 'russia', color: 1 },
  ],
  startingCash: 5000,
  startingUnits: 'mcv',
  techLevel: 'unrestricted',
  gameSpeed: 'normal',
  fog: true,
  explored: false,
});

const blipsOf = (game, player) => {
  const b = Array.from(game.minimap_blips(player));
  assert.equal(b.length % 5, 0);
  return Array.from({ length: b.length / 5 }, (_, i) => b.slice(i * 5, i * 5 + 5));
};

test('engine: no radar without a powered Radar Dome, and no blips then', () => {
  const game = Game.from_map(mapWith([['E1', 1, 30, 30]]), OPTIONS);
  game.tick();
  assert.equal(game.radar_state(0), RADAR.NONE);
  assert.equal(game.minimap_blips(0).length, 0);
  assert.equal(game.minimap_blips(99).length, 0, 'unknown players get nothing');
  assert.equal(game.radar_state(99), RADAR.NONE);
});

test('engine: radar dome shows own actors and never unseen enemies', () => {
  const game = Game.from_map(mapWith([['POWR', 0, 10, 4], ['DOME', 0, 14, 4], ['2TNK', 0, 12, 12], ['3TNK', 1, 40, 40]]), OPTIONS);
  for (let i = 0; i < 3; i++) game.tick();
  assert.equal(game.radar_state(0), RADAR.ONLINE);
  const mine = blipsOf(game, 0);
  assert.ok(mine.some(([x, y, w, h, o]) => x === 14 && y === 4 && w === 2 && o === 0), 'the dome');
  assert.ok(mine.some(([x, y, w, h, o]) => x === 12 && y === 12 && w === 1 && h === 1 && o === 0), 'the tank');
  assert.ok(!mine.some((b) => b[4] === 1), 'the enemy tank is not seen');
  assert.equal(game.radar_state(1), RADAR.NONE);
  // Reading the radar does not change the simulation.
  const hash = game.state_hash();
  game.radar_state(0);
  game.minimap_blips(0);
  assert.equal(game.state_hash(), hash);
});

test('engine: an enemy radar jammer in range takes the dome offline', () => {
  const game = Game.from_map(mapWith([['POWR', 0, 10, 4], ['DOME', 0, 14, 4], ['MRJ', 1, 30, 6]]), OPTIONS);
  for (let i = 0; i < 3; i++) game.tick();
  assert.equal(game.radar_state(0), RADAR.JAMMED);
  assert.equal(game.minimap_blips(0).length, 0);
});

test('engine: low power switches the radar off', () => {
  const game = Game.from_map(mapWith([['DOME', 0, 14, 4]]), OPTIONS);
  for (let i = 0; i < 3; i++) game.tick();
  assert.equal(game.radar_state(0), RADAR.LOW_POWER);
  assert.equal(game.minimap_blips(0).length, 0);
});

test('engine: the spectator views always have their radar online and see what they should', () => {
  // No radar dome anywhere; player 1's tank stands far from player 0.
  const game = Game.from_map(mapWith([['2TNK', 0, 12, 12], ['3TNK', 1, 40, 40]]), OPTIONS);
  for (let i = 0; i < 3; i++) game.tick();
  assert.equal(Game.observer_player(), OBSERVER_VIEW, 'the client and the engine agree on the observer id');
  assert.equal(game.radar_state(0), RADAR.NONE);
  assert.equal(game.radar_state(OBSERVER_VIEW), RADAR.ONLINE);
  assert.equal(game.radar_state(COMBINED_VIEW), RADAR.ONLINE);
  const tanks = (blips) => blips.filter(([, , w, h, o]) => w === 1 && h === 1 && o <= 1).map(([x, y, , , o]) => `${o}@${x},${y}`);
  const hash = game.state_hash();
  // Player 0's radar is offline; the whole map shows both tanks (and the starting MCVs), and all
  // players together too, since each player sees its own units.
  assert.equal(game.minimap_blips(0).length, 0);
  for (const view of [OBSERVER_VIEW, COMBINED_VIEW]) {
    const seen = tanks(blipsOf(game, view));
    assert.ok(seen.includes('0@12,12') && seen.includes('1@40,40'), `view ${view}: ${seen}`);
  }
  assert.equal(game.state_hash(), hash, 'reading the spectator radar does not change the simulation');
});

// ---- The sidebar widget, with a tiny stand-in for the DOM ---------------------------

function fakeElement(tag) {
  const listeners = {};
  const classes = new Set();
  const props = new Map();
  return {
    tag,
    children: [],
    listeners,
    hidden: false,
    textContent: '',
    clientWidth: 200,
    clientHeight: 200,
    set className(v) {
      classes.clear();
      v.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    style: { setProperty: (k, v) => props.set(k, v), getPropertyValue: (k) => props.get(k) ?? '' },
    setAttribute() {},
    append(...c) {
      this.children.push(...c);
    },
    prepend(...c) {
      this.children.unshift(...c);
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    getContext: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 128, height: 128 }),
    setPointerCapture() {},
  };
}

function widget(state) {
  globalThis.document = { createElement: fakeElement };
  const calls = [];
  const game = {
    map_width: () => 64,
    map_height: () => 64,
    radar_state: () => state.radar,
    minimap_blips: () => new Int32Array(0),
  };
  // Orders are the battlefield's (js/input.js radarClick; tests/minimap-orders.test.mjs runs the real one).
  const input = {
    suspended: false,
    centerOn: (x, y) => calls.push(['center', x, y]),
    radarClick: async (w) => {
      if (!state.units.length) return false;
      calls.push(['order', w.x, w.y]);
      return true;
    },
    radarMayOrder: () => state.units.length > 0,
    radarCursor: () => 'move',
    heldMods: () => ({ ctrl: false, alt: false, shift: false }),
    viewRect: () => ({ x0: 0, y0: 0, x1: 24 * 16, y1: 24 * 16 }),
  };
  const parent = fakeElement('aside');
  const mm = new Minimap(parent, { game, fog: () => new Uint8Array(0), player: 0, input, colors: COLORS });
  return { mm, calls, parent, input };
}

const pointer = (button, x, y) => ({ button, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', preventDefault() {} });
const settle = () => new Promise((r) => setImmediate(r));

test('widget: offline radar ignores clicks; online it moves the camera and orders units', async () => {
  const state = { radar: RADAR.NONE, units: [7, 8] };
  const { mm, calls, parent } = widget(state);
  assert.equal(parent.children[0], mm.root, 'at the top of the sidebar');
  mm.frame(0);
  assert.ok(mm.root.classList.contains('off'));
  assert.equal(mm.label.textContent, 'No radar');
  mm.canvas.listeners.pointerdown(pointer(0, 64, 64));
  assert.equal(calls.length, 0, 'no radar: not interactive');

  state.radar = RADAR.ONLINE;
  mm.frame(1000);
  assert.ok(mm.root.classList.contains('static'), 'opening');
  mm.frame(1000 + TRANSITION_MS + REFRESH_MS);
  assert.ok(!mm.root.classList.contains('static') && !mm.root.classList.contains('off'));
  assert.equal(mm.camera.style.getPropertyValue('--cam-w'), '25.00%');
  // Units selected: a left click is an order, the camera stays.
  mm.canvas.listeners.pointerdown(pointer(0, 128, 0));
  await settle();
  mm.canvas.listeners.pointerup(pointer(0, 128, 0));
  assert.deepEqual(calls, [['order', 64 * 24, 0]]);
  // A right click (or middle) only moves the camera, never an order, and follows a drag.
  calls.length = 0;
  mm.canvas.listeners.pointerdown(pointer(2, 64, 64));
  await settle();
  mm.canvas.listeners.pointermove(pointer(2, 32, 96));
  mm.canvas.listeners.pointerup(pointer(2, 32, 96));
  mm.canvas.listeners.pointerdown(pointer(1, 0, 128));
  await settle();
  mm.canvas.listeners.pointerup(pointer(1, 0, 128));
  assert.deepEqual(calls, [
    ['center', 32 * 24, 32 * 24],
    ['center', 16 * 24, 48 * 24],
    ['center', 0, 64 * 24],
  ]);
  // Other buttons (back, forward) do nothing.
  calls.length = 0;
  mm.canvas.listeners.pointerdown(pointer(3, 64, 64));
  await settle();
  mm.canvas.listeners.pointerup(pointer(3, 64, 64));
  assert.deepEqual(calls, []);
  calls.length = 0;
  // The cursor over the radar is the battlefield's for that spot.
  mm.canvas.listeners.pointermove(pointer(0, 10, 10));
  mm.frame(1000 + TRANSITION_MS + REFRESH_MS + 16);
  assert.equal(mm.canvas.style.cursor, 'move');
  // Nothing selected: left click and drag move the camera, which follows.
  state.units = [];
  calls.length = 0;
  mm.canvas.listeners.pointerdown(pointer(0, 64, 64));
  await settle();
  mm.canvas.listeners.pointermove(pointer(0, 32, 96));
  mm.canvas.listeners.pointerup(pointer(0, 32, 96));
  mm.canvas.listeners.pointermove(pointer(0, 0, 0));
  assert.deepEqual(calls, [
    ['center', 32 * 24, 32 * 24],
    ['center', 16 * 24, 48 * 24],
  ]);

  // Jammed: static and a label, no input.
  calls.length = 0;
  state.radar = RADAR.JAMMED;
  mm.frame(10000);
  assert.equal(mm.label.textContent, 'Radar jammed');
  mm.frame(10000 + TRANSITION_MS + REFRESH_MS);
  assert.ok(mm.root.classList.contains('static'));
  mm.canvas.listeners.pointerdown(pointer(0, 64, 64));
  assert.equal(calls.length, 0);
  delete globalThis.document;
});

test('widget: setView switches the player the radar asks the game for; the observer view asks with the observer id', () => {
  globalThis.document = { createElement: fakeElement };
  const asked = [];
  const game = {
    map_width: () => 64,
    map_height: () => 64,
    radar_state: (p) => (asked.push(['radar_state', p]), p === 1 ? RADAR.NONE : RADAR.ONLINE),
    minimap_blips: (p) => (asked.push(['minimap_blips', p]), new Int32Array(0)),
  };
  const fog = (p) => (asked.push(['fog', p]), new Uint8Array(64 * 64).fill(255));
  const input = { suspended: false, viewRect: () => ({ x0: 0, y0: 0, x1: 240, y1: 240 }), heldMods: () => ({}), radarCursor: () => '' };
  const mm = new Minimap(fakeElement('aside'), { game, fog, player: 0, input, colors: COLORS });
  // The fake canvas has no 2D context: give the picture somewhere to go.
  mm.image = { data: new Uint8ClampedArray(64 * 64 * 4) };
  mm.ctx = { putImageData() {} };
  mm.frame(0);
  assert.deepEqual(asked, [['radar_state', 0], ['minimap_blips', 0], ['fog', 0]]);
  // Watching player 1, who has no radar: asked at once, offline.
  asked.length = 0;
  mm.setView(1);
  mm.frame(10);
  assert.deepEqual(asked, [['radar_state', 1]], 'no blips or fog while that radar is offline');
  assert.equal(mm.label.textContent, 'No radar');
  // The whole map and all players together: the engine's pseudo players.
  asked.length = 0;
  mm.setView(OBSERVER_VIEW);
  mm.frame(20);
  assert.deepEqual(asked, [['radar_state', OBSERVER_VIEW], ['minimap_blips', OBSERVER_VIEW], ['fog', OBSERVER_VIEW]]);
  asked.length = 0;
  mm.setView(COMBINED_VIEW);
  mm.frame(30);
  assert.deepEqual(asked, [['radar_state', COMBINED_VIEW], ['minimap_blips', COMBINED_VIEW], ['fog', COMBINED_VIEW]]);
  // The same view again changes nothing: the next refresh comes on its own clock.
  asked.length = 0;
  mm.setView(COMBINED_VIEW);
  mm.frame(40);
  assert.deepEqual(asked, []);
  delete globalThis.document;
});

test('widget: a radar made without a place waits for mount, then moves with it (one radar, never a hidden one)', () => {
  globalThis.document = { createElement: fakeElement };
  let asked = 0;
  const game = { map_width: () => 64, map_height: () => 64, radar_state: () => (asked++, RADAR.ONLINE), minimap_blips: () => new Int32Array(0) };
  const input = { suspended: false, viewRect: () => ({ x0: 0, y0: 0, x1: 240, y1: 240 }), heldMods: () => ({}), radarCursor: () => '' };
  const mm = new Minimap(null, { game, fog: () => null, player: OBSERVER_VIEW, input, colors: COLORS });
  mm.frame(0);
  assert.equal(asked, 0, 'not on the page: not refreshed');
  const sidebar = fakeElement('div');
  mm.mount(sidebar);
  assert.equal(sidebar.children[0], mm.root);
  mm.frame(1);
  assert.equal(asked, 1);
  // A defeated player starts watching: the same radar moves to the observer panel's slot.
  const slot = fakeElement('div');
  mm.press = { id: 1 };
  mm.mount(slot);
  assert.equal(slot.children[0], mm.root);
  assert.equal(mm.press, null, 'a press on the old place is let go');
  delete globalThis.document;
});
