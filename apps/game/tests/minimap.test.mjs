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
    cursor_action: () => 1,
    order_smart: (p, ids, x, y) => calls.push(['order', p, Array.from(ids), x, y]),
  };
  const input = {
    suspended: false,
    centerOn: (x, y) => calls.push(['center', x, y]),
    selectedOwnUnits: () => state.units,
    flashOrder: (w, action) => calls.push(['flash', action]),
    viewRect: () => ({ x0: 0, y0: 0, x1: 24 * 16, y1: 24 * 16 }),
  };
  const parent = fakeElement('aside');
  const mm = new Minimap(parent, { game, fog: () => new Uint8Array(0), player: 0, input, colors: COLORS });
  return { mm, calls, parent, input };
}

const pointer = (button, x, y) => ({ button, clientX: x, clientY: y, pointerId: 1, preventDefault() {} });

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
  // Left click and drag: the camera follows.
  mm.canvas.listeners.pointerdown(pointer(0, 64, 64));
  mm.canvas.listeners.pointermove(pointer(0, 32, 96));
  mm.canvas.listeners.pointerup(pointer(0, 32, 96));
  mm.canvas.listeners.pointermove(pointer(0, 0, 0));
  assert.deepEqual(calls, [
    ['center', 32 * 24, 32 * 24],
    ['center', 16 * 24, 48 * 24],
  ]);
  // Right click: a smart order for the selected own units.
  calls.length = 0;
  mm.canvas.listeners.pointerdown(pointer(2, 128, 0));
  // The order goes out at once; the flash shows the answer to what it does.
  assert.deepEqual(calls, [['order', 0, [7, 8], 64 * 24, 0]]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [
    ['order', 0, [7, 8], 64 * 24, 0],
    ['flash', 1],
  ]);
  state.units = [];
  calls.length = 0;
  mm.canvas.listeners.pointerdown(pointer(2, 10, 10));
  assert.equal(calls.length, 0, 'nothing selected: no order');

  // Jammed: static and a label, no input.
  state.radar = RADAR.JAMMED;
  mm.frame(10000);
  assert.equal(mm.label.textContent, 'Radar jammed');
  mm.frame(10000 + TRANSITION_MS + REFRESH_MS);
  assert.ok(mm.root.classList.contains('static'));
  mm.canvas.listeners.pointerdown(pointer(0, 64, 64));
  assert.equal(calls.length, 0);
  delete globalThis.document;
});
