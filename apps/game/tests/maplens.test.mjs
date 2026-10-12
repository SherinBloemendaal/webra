// The map lens (js/maplens): the magnifier over map previews. Coordinate
// mapping from preview pixels to map cells (stretched and letterboxed
// previews, square and non-square maps, clamped edges), the lens placement
// for mouse and touch, the tile cache bounds and the per-frame budget, the
// pointer, wheel and touch behaviour, the software terrain and sprite
// renderer against the shaders' math, and the art choice (installed
// original graphics when chosen, WebRA's otherwise) with synthetic content
// only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import init, { Game } from '../pkg/webra_sim.js';
import { FakeEvent, installDom, uninstallDom } from './dom-fixtures.mjs';
import { decodeTestPng, pixelDocument, syntheticGraphics, syntheticTheater } from './content-fixtures.mjs';
import { MemoryStore } from '../js/content/store.js';
import { ContentSystem } from '../js/content/index.js';
import { ART_ORE, ART_TILES, ART_WATER_ROTATION, ORE_LEVELS, ORE_TILE_BASE, WATER_ALPHA } from '../js/content/terrain.js';
import { createSettings } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';
import { FRAME_FLOATS } from '../js/sprites.js';
import { buildTerrainAtlas, cellTiles, terrainSeed, TILES } from '../js/art/terrain.js';
import { MODE, POSE, packSprite } from '../js/content/sequences.js';
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from '../js/scale.js';
import { CELL_PX, TerrainRaster, frameQuad, hash2, resourceTile, spriteFrame, tintPixels, vnoise } from '../js/maplens/raster.js';
import { HOLD_MS, LENS_START_FACTOR, LruCache, MapLens, TILE_CELLS, TOUCH_GAP, cellAt, contentBox, lensPlacement, spriteList, tilesFor, wheelZoom } from '../js/maplens/lens.js';
import { LensArt, PREVIEW_COLORS, PREVIEW_NEUTRAL, hexColor, teamColors } from '../js/maplens/source.js';
import { createMap, encodeBase64, TERRAIN } from '../editor/js/mapformat.js';

const wasm = await init({ module_or_path: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const realDocument = globalThis.document;
afterEach(() => {
  uninstallDom();
  globalThis.document = realDocument;
});
// The atlas reports which actors lack installed files; quiet here.
console.info = () => {};

const NO_BORDER = { borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px' };

// ---- Coordinates -----------------------------------------------------------------------

test('contentBox: borders and padding come off, object-fit contain letterboxes, fill stretches', () => {
  const rect = { left: 10, top: 20, width: 202, height: 162 };
  const style = { ...NO_BORDER, borderLeftWidth: '1px', borderRightWidth: '1px', borderTopWidth: '1px', borderBottomWidth: '1px' };
  assert.deepEqual(contentBox(rect, { ...style, objectFit: 'fill' }, 64, 64), { x: 11, y: 21, w: 200, h: 160 });
  // A square map in a 200 x 160 box: bars left and right.
  assert.deepEqual(contentBox(rect, { ...style, objectFit: 'contain' }, 64, 64), { x: 31, y: 21, w: 160, h: 160 });
  // A wide map (100 x 50) in the same box: bars above and below.
  assert.deepEqual(contentBox(rect, { ...style, objectFit: 'contain' }, 100, 50), { x: 11, y: 51, w: 200, h: 100 });
  assert.deepEqual(contentBox(rect, { ...style, objectFit: 'cover' }, 100, 50), { x: -49, y: 21, w: 320, h: 160 });
  assert.deepEqual(contentBox(rect, { ...style, objectFit: 'none' }, 100, 50), { x: 61, y: 76, w: 100, h: 50 });
  assert.deepEqual(contentBox(rect, { ...style, objectFit: 'scale-down' }, 100, 50), { x: 61, y: 76, w: 100, h: 50 });
  // Padding counts too (the lobby frame).
  assert.deepEqual(contentBox({ left: 0, top: 0, width: 108, height: 108 }, { ...NO_BORDER, paddingLeft: '4px', paddingRight: '4px', paddingTop: '4px', paddingBottom: '4px' }, 96, 96), { x: 4, y: 4, w: 100, h: 100 });
});

test('cellAt maps preview pixels to cells at several preview and map sizes', () => {
  const cases = [
    // [box, map w, map h, client point, expected cell]
    [{ x: 0, y: 0, w: 64, h: 64 }, 64, 64, [32, 16], [32, 16]], // one pixel per cell
    [{ x: 0, y: 0, w: 260, h: 260 }, 128, 128, [130, 65], [64, 32]], // online preview, 128 map
    [{ x: 100, y: 50, w: 320, h: 320 }, 160, 160, [260, 210], [80, 80]], // offset on the page
    [{ x: 0, y: 0, w: 260, h: 260 }, 96, 48, [130, 130], [48, 24]], // a non-square map stretched into a square (fill)
    [{ x: 0, y: 65, w: 260, h: 130 }, 96, 48, [65, 97.5], [24, 12]], // the same map letterboxed (contain)
    [{ x: 40, y: 0, w: 180, h: 320 }, 45, 80, [85, 160], [11.25, 40]], // a tall map
  ];
  for (const [box, w, h, [x, y], [cx, cy]] of cases) {
    const c = cellAt(box, w, h, x, y);
    assert.ok(Math.abs(c.x - cx) < 1e-9 && Math.abs(c.y - cy) < 1e-9, `${JSON.stringify(box)} ${w}x${h} at ${x},${y}: ${c.x},${c.y}`);
    assert.equal(c.inside, true);
  }
});

test('cellAt clamps to the map edges in the letterbox bars and on the frame', () => {
  const box = { x: 0, y: 65, w: 260, h: 130 }; // a 96 x 48 map letterboxed in 260 x 260
  assert.deepEqual(cellAt(box, 96, 48, 130, 10), { x: 48, y: 0, inside: false }, 'the bar above: the top edge');
  assert.deepEqual(cellAt(box, 96, 48, 130, 250), { x: 48, y: 48, inside: false }, 'the bar below: the bottom edge');
  assert.deepEqual(cellAt(box, 96, 48, -5, -5), { x: 0, y: 0, inside: false });
  assert.deepEqual(cellAt(box, 96, 48, 400, 100), { x: 96, y: (35 / 130) * 48, inside: false });
  assert.deepEqual(cellAt({ x: 0, y: 0, w: 0, h: 0 }, 96, 48, 10, 10), { x: 0, y: 0, inside: false }, 'an empty box maps to the corner');
});

test('lensPlacement: centred on the mouse, above the finger (below near the top), inside the viewport', () => {
  const vp = { width: 400, height: 800 };
  assert.deepEqual(lensPlacement({ x: 200, y: 400 }, 176, vp), { left: 112, top: 312 });
  assert.deepEqual(lensPlacement({ x: 200, y: 400 }, 176, vp, true), { left: 112, top: 400 - TOUCH_GAP - 176 }, 'above the finger, which does not cover it');
  assert.deepEqual(lensPlacement({ x: 200, y: 100 }, 176, vp, true), { left: 112, top: 100 + TOUCH_GAP }, 'no room above: below the finger');
  assert.deepEqual(lensPlacement({ x: 10, y: 400 }, 176, vp, true), { left: 0, top: 400 - TOUCH_GAP - 176 }, 'kept inside on the left');
  assert.deepEqual(lensPlacement({ x: 395, y: 795 }, 176, vp), { left: 224, top: 624 }, 'and on the right and bottom');
  assert.deepEqual(lensPlacement({ x: 50, y: 50 }, 500, { width: 300, height: 300 }), { left: 0, top: 0 }, 'a lens bigger than the screen sits at the corner');
});

test('tilesFor covers the view, clips to the map and starts nearest the centre', () => {
  const t = tilesFor({ x: 20, y: 20 }, 10, 10, 128, 128);
  assert.deepEqual(new Set(t.map(String)), new Set(['1,1', '2,1', '3,1', '1,2', '2,2', '3,2', '1,3', '2,3', '3,3']));
  assert.deepEqual(t[0], [2, 2], 'the tile under the centre first');
  // At the corner of a 20 x 12 map: no tiles off the map.
  const corner = tilesFor({ x: 0, y: 0 }, 10, 10, 20, 12);
  assert.ok(corner.every(([x, y]) => x >= 0 && y >= 0));
  assert.deepEqual(new Set(tilesFor({ x: 20, y: 12 }, 30, 30, 20, 12).map(String)), new Set(['0,0', '1,0', '2,0', '0,1', '1,1', '2,1']), 'a 20 x 12 map has 3 x 2 tiles');
});

test('wheelZoom: the editor wheel rate, within the game zoom limits', () => {
  const limits = { min: MIN_ZOOM, max: MAX_ZOOM };
  assert.ok(wheelZoom(DEFAULT_ZOOM, -100, 0, limits) > DEFAULT_ZOOM, 'wheel up zooms in');
  assert.ok(wheelZoom(DEFAULT_ZOOM, 100, 0, limits) < DEFAULT_ZOOM);
  assert.equal(wheelZoom(DEFAULT_ZOOM, 3, 1, limits), DEFAULT_ZOOM * Math.exp(-0.15), 'line deltas');
  assert.equal(wheelZoom(MAX_ZOOM, -500, 0, limits), MAX_ZOOM);
  assert.equal(wheelZoom(MIN_ZOOM, 500, 0, limits), MIN_ZOOM);
});

test('LruCache keeps at most its size and frees what drops out, least recently used first', () => {
  const freed = [];
  const c = new LruCache(3, (v) => freed.push(v));
  for (const k of ['a', 'b', 'c']) c.set(k, k.toUpperCase());
  c.get('a');
  c.set('d', 'D');
  assert.equal(c.size, 3);
  assert.deepEqual(freed, ['B']);
  assert.equal(c.get('b'), undefined);
  c.set('a', 'A2');
  assert.equal(c.size, 3, 'replacing keeps the size');
  c.clear();
  assert.equal(c.size, 0);
  assert.deepEqual(freed.sort(), ['A2', 'B', 'C', 'D'].sort());
});

// ---- Software renderer ---------------------------------------------------------------

test('hash2 and vnoise stay in 0..1 like the shader functions', () => {
  for (let i = 0; i < 500; i++) {
    const h = hash2(i * 3.7, i * 1.3);
    assert.ok(h >= 0 && h < 1);
    const v = vnoise(i * 0.37, i * 0.11);
    assert.ok(v >= 0 && v <= 1);
  }
  assert.equal(hash2(5, 9), hash2(5, 9), 'deterministic');
});

/** A tile atlas of ATLAS_COLS x rows tiles of `size` pixels, tile k filled by fill(k) => [r, g, b, a]. */
function tileAtlas(size, rows, fill, extraRow = false) {
  const width = 16 * size;
  const height = rows * size + (extraRow ? 1 : 0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let k = 0; k < 16 * rows; k++) {
    const c = fill(k);
    if (!c) continue;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) data.set(c, (((Math.floor(k / 16) * size + y) * width) + (k % 16) * size + x) * 4);
    }
  }
  return { width, height, data };
}

/** Engine terrain bytes for a w x h map of type `type(x, y)`, ore and gems by cell. */
function terrainBytes(w, h, type, ore = () => 0, gems = () => 0) {
  const b = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      b[i] = type(x, y);
      b[i + 1] = ore(x, y);
      b[i + 2] = gems(x, y);
      b[i + 3] = 255;
    }
  }
  return b;
}

test('tile terrain (installed art): the tile as it is, rotating water at its first colour, ore from its overlay tiles', () => {
  const w = 4;
  const h = 2;
  // Tile 0 plain grey; tile 1 water pixels (alpha WATER_ALPHA + 2); the ore overlays solid gold.
  const atlas = tileAtlas(24, 16, (k) => (k === 0 ? [100, 100, 100, 255] : k === 1 ? [0, 0, 0, WATER_ALPHA + 2] : k >= ORE_TILE_BASE && k < ORE_TILE_BASE + 48 ? [250, 200, 0, 255] : null), true);
  // The rotating colours in the last row.
  for (let k = 0; k < 7; k++) atlas.data.set([10 * k, 20 * k, 30 * k, 255], ((atlas.height - 1) * atlas.width + k) * 4);
  atlas.flags = ART_TILES | ART_ORE | ART_WATER_ROTATION;
  atlas.filter = 'nearest';
  const terrain = terrainBytes(w, h, (x) => (x === 1 ? TERRAIN.WATER : TERRAIN.CLEAR), (x) => (x === 2 ? 255 : 0));
  const cells = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) cells[i * 4] = terrain[i * 4] === TERRAIN.WATER ? 1 : 0;
  const r = new TerrainRaster({ width: w, height: h, terrain, cells, atlas });
  const at = (cx, cy) => r.shade(cx * CELL_PX + 12, cy * CELL_PX + 12, [0, 0, 0]).map((v) => Math.round(v * 255));
  assert.deepEqual(at(0, 0), [100, 100, 100], 'plain tile');
  assert.deepEqual(at(1, 0), [20, 40, 60], 'water shows rotating colour 2 at the first step');
  assert.deepEqual(at(2, 0), [250, 200, 0], 'ore from the overlay tile (opaque here)');
  assert.deepEqual(at(9, 9), [0, 0, 0], 'off the map is black');
  assert.equal(resourceTile(ORE_TILE_BASE, ORE_LEVELS, 4, 1, 2, 0) >= ORE_TILE_BASE + ORE_LEVELS - 1, true, 'full ore takes the densest level');
  // Rows: only the asked rows are written.
  const out = new Uint8ClampedArray(w * 24 * h * 24 * 4);
  r.renderRows(out, 0, 0, w, 24, 0, 3);
  assert.equal(out[(3 * w * 24) * 4 + 3], 0, 'row 3 untouched');
  assert.equal(out[(2 * w * 24) * 4 + 3], 255, 'row 2 drawn');
});

test('WebRA terrain: the shader math for water depth, rock shadows, ore specks and gems', () => {
  const w = 12;
  const h = 12;
  // Open water on the right half, a rock column at x = 2, ore at (4, 8), gems at (5, 8).
  const terrain = terrainBytes(w, h, (x) => (x >= 6 ? TERRAIN.WATER : x === 2 ? TERRAIN.ROCK : TERRAIN.CLEAR), (x, y) => (x === 4 && y === 8 ? 255 : 0), (x, y) => (x === 5 && y === 8 ? 255 : 0));
  const atlas = buildTerrainAtlas('temperate');
  const cells = cellTiles(terrain, w, h, terrainSeed(terrain));
  const r = new TerrainRaster({ width: w, height: h, terrain, cells, atlas });
  const lum = (wx, wy) => r.shade(wx, wy, [0, 0, 0]).reduce((a, b) => a + b, 0);
  // Deeper water is darker: average a cell's worth of pixels near the shore and far out.
  const avg = (cx) => {
    let s = 0;
    for (let y = 0; y < 24; y += 3) for (let x = 0; x < 24; x += 3) s += lum(cx * 24 + x + 0.5, 5 * 24 + y + 0.5);
    return s;
  };
  assert.ok(avg(11) < avg(6), 'water four cells out is darker than at the shore');
  // Rock casts its shadow to the right: the left edge of the cell east of the rock is darker than its middle.
  const shadowCell = 3;
  let edge = 0;
  let middle = 0;
  for (let y = 0; y < 24; y += 2) {
    edge += lum(shadowCell * 24 + 0.5, 3 * 24 + y + 0.5);
    middle += lum(shadowCell * 24 + 16.5, 3 * 24 + y + 0.5);
  }
  assert.ok(edge < middle * 0.85, 'rock shadow');
  // Ore: some pixels are golden specks.
  let gold = 0;
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const [rr, gg, bb] = r.shade(4 * 24 + x + 0.5, 8 * 24 + y + 0.5, [0, 0, 0]);
      if (rr > 0.6 && gg > 0.44 && bb < 0.31 && rr > bb * 2) gold++;
    }
  }
  assert.ok(gold > 24 * 24 * 0.3, `ore specks (${gold})`);
  // Gems: crystals in the gem hues somewhere in the cell.
  let crystal = 0;
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const [rr, gg, bb] = r.shade(5 * 24 + x + 0.5, 8 * 24 + y + 0.5, [0, 0, 0]);
      if (Math.max(rr, bb) > gg * 1.8) crystal++;
    }
  }
  assert.ok(crystal > 10, `gem crystals (${crystal})`);
  assert.equal(TILES.DECAL, 60, 'decals follow the atlas layout the shader uses');
});

/** A frame table of `n` entries; `set(i, values)` fills entry i. */
function frameTable(n) {
  const frames = new Float32Array(n * FRAME_FLOATS);
  return { frames, set: (i, v) => frames.set(v, i * FRAME_FLOATS) };
}

test('spriteFrame: the sprite shader frame choice with the clock stopped', () => {
  const { frames, set } = frameTable(64);
  // Slot 0: plain WebRA frame. Slot 1: WebRA animation head (frames 10..13).
  set(1, [0, 0, 0, 0, 0, 0, 0, 0, 10, 4, 8, 0]);
  // Slot 2: a sequence slot with poses at 20 (idle: 8 facings x 3 frames from 30, loop) and 21 (VANISH, 5 frames from 60), 22 (INDEX walls from 40).
  set(2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 3, 0, 0]);
  set(20, [0, 0, 0, 0, 0, 0, 0, 0, 30, 3, 10, MODE.LOOP, 8, 0, 0, 0]);
  set(21, [0, 0, 0, 0, 0, 0, 0, 0, 60, 2, 25, MODE.VANISH, 1, 0, 0, 0]);
  set(22, [0, 0, 0, 0, 0, 0, 0, 0, 40, 16, 0, MODE.INDEX, 1, 0, 0, 0]);
  const inst = (id, angle = 0) => Float32Array.from([0, 0, angle, id, 0, 1, 1, 0]);
  assert.deepEqual(spriteFrame(frames, inst(0, 1.2), 0), { index: 0, rotation: Math.fround(1.2), hidden: false }, 'WebRA art rotates');
  assert.equal(spriteFrame(frames, inst(1), 0).index, 10, 'an animation shows its first frame');
  // Facing south (OpenRA 512 = pi radians clockwise from north... the shader's openra_angle): 8 facings.
  const south = spriteFrame(frames, inst(packSprite(2, POSE.IDLE, 0), Math.PI), 0);
  assert.equal(south.index, 30 + 4 * 3, 'facing 4 of 8, first frame');
  assert.equal(south.rotation, 0, 'pre-rendered facings do not rotate');
  assert.equal(spriteFrame(frames, inst(packSprite(2, 1, 1)), 0).index, 60 + 1, 'VANISH plays from the age');
  assert.equal(spriteFrame(frames, inst(packSprite(2, 1, 40)), 0).hidden, true, 'a finished VANISH pose is hidden');
  assert.equal(spriteFrame(frames, inst(packSprite(2, 2, 9)), 0).index, 49, 'INDEX: wall piece 9');
});

test('frameQuad and tintPixels follow the sprite shader', () => {
  const { frames, set } = frameTable(1);
  // Atlas 100 x 50: the frame is the 20 x 10 pixel box at (10, 5), 10 x 5 world pixels, centre offset (1, -2).
  set(0, [0.1, 0.1, 0.3, 0.3, 10, 5, 1, -2]);
  const q = frameQuad(frames, 0, 100, 50, 2);
  assert.deepEqual([q.sx, q.sy, q.sw, q.sh], [10, 5, 20, 10]);
  assert.deepEqual([q.dx, q.dy, q.dw, q.dh], [-8, -9, 20, 10], 'scaled by the instance scale');
  assert.ok(q.radius >= Math.hypot(12, 9) - 1e-9);
  assert.equal(frameQuad(new Float32Array(FRAME_FLOATS), 0, 100, 50), null, 'an empty frame draws nothing');
  // A grey team pixel, a plain red pixel, a transparent one.
  const color = Uint8ClampedArray.from([128, 128, 128, 255, 200, 0, 0, 255, 9, 9, 9, 0]);
  const mask = Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  const out = tintPixels(color, mask, [1, 0, 0]);
  const k = 0.35 + (128 / 255) * 1.05;
  assert.deepEqual([...out.slice(0, 4)], [Math.round(Math.min(1, k) * 255), 0, 0, 255]);
  assert.deepEqual([...out.slice(4, 8)], [200, 0, 0, 255]);
  assert.equal(out[11], 0);
  assert.deepEqual([...tintPixels(color, mask, [1, 0, 0], -1).slice(4, 8)], [0, 0, 0, 255], 'shadows are black');
});

// ---- The lens on a page ------------------------------------------------------------------

/** A 2D context that records what is drawn; image data has real pixels. */
function fakeContext(canvas) {
  const log = [];
  const ctx = {
    log,
    canvas,
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => log.push(['putImageData', img.width, img.height]),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: canvas.pixels ? canvas.pixels(x, y, w, h) : new Uint8ClampedArray(w * h * 4) }),
    drawImage: (img, ...a) => log.push(['drawImage', img, ...a]),
    setTransform: () => {},
    rotate: () => {},
    fillRect: () => {},
    beginPath: () => {},
    arc: (...a) => log.push(['arc', ...a]),
    fill: () => {},
    stroke: () => {},
    strokeText: () => {},
    fillText: (text) => log.push(['fillText', text]),
  };
  return ctx;
}

/** A page: a fake DOM with canvases, a window with a manual frame clock and timers, and a preview to put a lens on. */
function page({ mapW = 20, mapH = 12, previewRect = { left: 100, top: 100, width: 200, height: 120 }, objectFit = 'fill' } = {}) {
  const doc = installDom();
  const create = doc.createElement.bind(doc);
  const placed = [];
  doc.createElement = (tag) => {
    const el = create(tag);
    if (tag === 'canvas') {
      let ctx = null;
      el.getContext = () => (ctx ??= fakeContext(el));
    }
    if (tag === 'div') {
      const props = {};
      el.style = { setProperty: (k, v) => ((props[k] = v), placed.push([k, v])), props };
    }
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 176, bottom: 176, width: 176, height: 176 });
    return el;
  };
  const frames = [];
  const timers = [];
  const win = {
    innerWidth: 1000,
    innerHeight: 800,
    devicePixelRatio: 1,
    requestAnimationFrame: (fn) => frames.push(fn),
    cancelAnimationFrame: () => {},
    setTimeout: (fn, ms) => timers.push({ fn, ms }) && timers.length,
    clearTimeout: (id) => id && timers[id - 1] && (timers[id - 1].fn = null),
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: (el) => (el.localName === 'canvas' ? { ...NO_BORDER, objectFit } : { fontFamily: 'Impact' }),
  };
  const frame = doc.createElement('div');
  const preview = doc.createElement('canvas');
  preview.width = mapW;
  preview.height = mapH;
  preview.getBoundingClientRect = () => ({ ...previewRect, right: previewRect.left + previewRect.width, bottom: previewRect.top + previewRect.height });
  frame.getBoundingClientRect = preview.getBoundingClientRect;
  frame.append(preview);
  doc.body.append(frame);
  const runFrames = (n = 1) => {
    for (let i = 0; i < n && frames.length; i++) frames.splice(0).forEach((fn) => fn());
  };
  const runTimers = () => timers.splice(0).forEach((t) => t.fn?.());
  return { doc, win, frame, preview, placed, frames, runFrames, runTimers };
}

/** A small synthetic lens map: grey terrain, one sprite at the centre of cell (5, 5), a spawn at (2, 2). */
function syntheticMap(w = 20, h = 12, version = 0) {
  const terrain = terrainBytes(w, h, () => TERRAIN.CLEAR);
  const atlas = tileAtlas(24, 1, () => [90, 90, 90, 255]);
  atlas.flags = ART_TILES;
  atlas.filter = 'nearest';
  const cells = new Uint8Array(w * h * 4);
  const { frames, set } = frameTable(1);
  set(0, [0, 0, 1, 1, 12, 12, 0, 0]);
  const spriteCanvas = { width: 4, height: 4, getContext: () => fakeContext(spriteCanvas) };
  return {
    width: w,
    height: h,
    biome: 'temperate',
    version,
    terrain: new TerrainRaster({ width: w, height: h, terrain, cells, atlas }),
    terrainSource: 'test',
    terrainPixelArt: true,
    sprites: Float32Array.from([5.5 * CELL_PX, 5.5 * CELL_PX, 0, 0, 1, 1, 1, 0]),
    atlas: { frames, width: 4, height: 4, color: spriteCanvas, mask: spriteCanvas, filter: 'nearest' },
    spriteSource: 'test',
    colors: teamColors(),
    spawns: [[2, 2]],
  };
}

const pointer = (type, x, y, extra = {}) => new FakeEvent(type, { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, ...extra });

function lensOn(p, opts = {}) {
  const art = { version: 0, listeners: new Set(), onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); } };
  let clock = 0;
  const lens = new MapLens({ art, doc: p.doc, win: p.win, now: () => clock, ...opts });
  lens.attach(p.frame, p.preview);
  return { lens, art, tick: (ms) => (clock += ms) };
}

test('the lens shows over the preview, is decorative, and hides when the pointer leaves', () => {
  const p = page();
  const { lens } = lensOn(p);
  let loads = 0;
  lens.setSource('a', () => (loads++, syntheticMap()), { width: 20, height: 12 });
  p.frame.dispatchEvent(pointer('pointermove', 150, 130));
  const el = p.doc.body.querySelector('.map-lens');
  assert.ok(el && !el.hidden, 'shown');
  assert.equal(el.getAttribute('aria-hidden'), 'true');
  assert.equal(el.getAttribute('tabindex'), null, 'never focusable');
  // Centred on the pointer (176 px lens), through CSSOM custom properties.
  assert.equal(el.style.props['--map-lens-x'], `${150 - 88}px`);
  assert.equal(el.style.props['--map-lens-y'], `${130 - 88}px`);
  // 200 x 120 preview of a 20 x 12 map at (100, 100): (150, 130) is cell (5, 3).
  assert.deepEqual([lens.centre.x, lens.centre.y], [5, 3]);
  assert.equal(loads, 0, 'the map is read lazily: first the preview pixels');
  p.runFrames(1);
  assert.equal(loads, 0);
  p.runFrames(1);
  assert.equal(loads, 1, 'then the map, once');
  p.frame.dispatchEvent(pointer('pointerleave', 400, 400));
  assert.equal(el.hidden, true, 'hidden on leave');
  p.frame.dispatchEvent(pointer('pointermove', 120, 110));
  p.runFrames(3);
  assert.equal(loads, 1, 'the same source is not read again');
  lens.setSource('b', () => (loads++, syntheticMap()), { width: 20, height: 12 });
  assert.equal(lens.tiles.size, 0, 'a new map drops the tiles');
  p.runFrames(3);
  assert.equal(loads, 2);
  // The screen redraws its preview (a new canvas) under the resting mouse: the lens stays.
  p.frame.dispatchEvent(pointer('pointermove', 150, 130));
  const fresh = p.doc.createElement('canvas');
  fresh.width = 20;
  fresh.height = 12;
  fresh.getBoundingClientRect = p.preview.getBoundingClientRect;
  lens.attach(p.frame, fresh);
  assert.equal(el.hidden, false);
  assert.equal(lens.image, fresh);
  lens.destroy();
  assert.equal(p.doc.body.querySelector('.map-lens'), null);
});

test('letterboxed preview: the pointer in the bars clamps to the map edge', () => {
  // A 20 x 10 map in a 200 x 200 box with object-fit contain: drawn 200 x 100 at y 150.
  const p = page({ mapW: 20, mapH: 10, previewRect: { left: 100, top: 100, width: 200, height: 200 }, objectFit: 'contain' });
  const { lens } = lensOn(p);
  lens.setSource('m', () => syntheticMap(20, 10), { width: 20, height: 10 });
  p.frame.dispatchEvent(pointer('pointermove', 200, 120));
  assert.deepEqual([lens.centre.x, lens.centre.y], [10, 0], 'top bar: top edge');
  p.frame.dispatchEvent(pointer('pointermove', 200, 200));
  assert.deepEqual([lens.centre.x, lens.centre.y], [10, 5]);
  p.frame.dispatchEvent(pointer('pointermove', 299, 299));
  assert.deepEqual([lens.centre.x, lens.centre.y], [19.9, 10], 'bottom bar: bottom edge');
});

test('tiles are drawn a few rows per frame within the budget, cached, and the cache stays bounded', () => {
  const p = page({ mapW: 64, mapH: 64, previewRect: { left: 0, top: 0, width: 640, height: 640 } });
  const { lens, tick } = lensOn(p, { maxTiles: 6, budgetMs: 5 });
  const map = syntheticMap(64, 64);
  // Every pixel row of terrain "takes" a millisecond on the fake clock.
  const rows = map.terrain.renderRows.bind(map.terrain);
  let rowCalls = 0;
  map.terrain.renderRows = (out, bx, by, cols, px, y0, y1) => {
    rowCalls++;
    tick(1);
    return rows(out, bx, by, cols, px, y0, y1);
  };
  lens.setSource('big', () => map, { width: 64, height: 64 });
  p.frame.dispatchEvent(pointer('pointermove', 320, 320));
  p.runFrames(2);
  assert.ok(rowCalls >= 1 && rowCalls <= 6, `one frame stops at the budget (${rowCalls} row batches)`);
  assert.ok(lens.stats.work <= 5 + 1, 'the frame stayed within the budget');
  // Placeholders: the preview's own pixels stand in for tiles that are not ready.
  const drawn = p.doc.body.querySelector('.map-lens canvas').getContext('2d').log.filter((l) => l[0] === 'drawImage');
  assert.ok(drawn.some((l) => l[1] === p.preview), 'the preview shows where tiles are not ready');
  p.runFrames(200);
  const done = [...lens.tiles.map.values()].filter((t) => t.done);
  assert.ok(done.length >= 1, 'tiles finish');
  // Move over the whole map: the cache never holds more than its size.
  for (let y = 0; y < 640; y += 60) {
    for (let x = 0; x < 640; x += 60) {
      p.frame.dispatchEvent(pointer('pointermove', x, y));
      p.runFrames(80);
      assert.ok(lens.tiles.size <= 6, `cache bounded (${lens.tiles.size})`);
    }
  }
  // A finished tile has its terrain, then its sprites, and keeps no pixel buffer.
  const t = [...lens.tiles.map.values()].find((x) => x.done);
  assert.equal(t.img, null);
  assert.ok(t.ctx.log.some((l) => l[0] === 'putImageData'));
});

test('per move, a lens over cached tiles only copies them (measured)', () => {
  const p = page({ mapW: 128, mapH: 128, previewRect: { left: 0, top: 0, width: 512, height: 512 } });
  const { lens } = lensOn(p, { now: () => performance.now(), budgetMs: 1000 });
  lens.setSource('m', () => syntheticMap(128, 128), { width: 128, height: 128 });
  p.frame.dispatchEvent(pointer('pointermove', 256, 256));
  p.runFrames(10);
  const ctx = p.doc.body.querySelector('.map-lens canvas').getContext('2d');
  ctx.log.length = 0;
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    p.frame.dispatchEvent(pointer('pointermove', 256 + (i % 3), 256));
    p.runFrames(1);
  }
  const perMove = (performance.now() - t0) / 100;
  assert.ok(ctx.log.filter((l) => l[0] === 'drawImage').every((l) => l[1] !== p.preview), 'only cached tiles drawn');
  assert.ok(perMove < 4, `per move ${perMove.toFixed(3)} ms`);
});

test('mouse wheel zooms the lens only while it shows after a pointer move, and leaves the page alone at the limits', () => {
  const p = page();
  const { lens } = lensOn(p);
  lens.setSource('a', () => syntheticMap(), { width: 20, height: 12 });
  const wheel = (dy) => {
    const e = new FakeEvent('wheel', { deltaY: dy, deltaMode: 0, clientX: 150, clientY: 130 });
    p.frame.dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.equal(wheel(-100), false, 'no lens: the page scrolls');
  // A pointerenter without movement (the page scrolled under the pointer) does not arm the wheel.
  p.frame.dispatchEvent(pointer('pointerenter', 150, 130));
  assert.equal(wheel(-100), false);
  p.frame.dispatchEvent(pointer('pointermove', 151, 130));
  assert.equal(lens.zoom(), DEFAULT_ZOOM * LENS_START_FACTOR, 'starts at half the game zoom');
  assert.equal(wheel(-100), true, 'zooms in');
  assert.ok(lens.zoom() > DEFAULT_ZOOM * LENS_START_FACTOR);
  for (let i = 0; i < 100; i++) wheel(-100);
  assert.equal(lens.zoom(), MAX_ZOOM);
  assert.equal(wheel(-100), false, 'at the limit the wheel is the page\'s again');
  assert.equal(wheel(100), true);
  p.frame.dispatchEvent(pointer('pointerleave', 0, 0));
  assert.equal(wheel(100), false, 'hidden again: the page scrolls');
});

test('the zoom follows the game scale', () => {
  const p = page();
  const { lens } = lensOn(p, { gameScale: () => 2 });
  assert.equal(lens.zoom(), DEFAULT_ZOOM * 2 * LENS_START_FACTOR);
});

test('touch: press and hold shows the lens above the finger; a swipe stays a scroll; lifting hides it', () => {
  const p = page({ previewRect: { left: 100, top: 400, width: 200, height: 120 } });
  const { lens } = lensOn(p);
  lens.setSource('a', () => syntheticMap(), { width: 20, height: 12 });
  const touch = (type, x, y) => {
    const e = pointer(type, x, y, { pointerType: 'touch', pointerId: 7 });
    p.frame.dispatchEvent(e);
    return e;
  };
  touch('pointerdown', 150, 450);
  assert.ok(!p.doc.body.querySelector('.map-lens') || p.doc.body.querySelector('.map-lens').hidden, 'not before the hold');
  touch('pointermove', 152, 451);
  p.runTimers();
  const el = p.doc.body.querySelector('.map-lens');
  assert.equal(el.hidden, false, `shown after ${HOLD_MS} ms`);
  assert.equal(el.style.props['--map-lens-y'], `${450 - TOUCH_GAP - 176}px`, 'above the finger');
  assert.ok(el.classList.contains('map-lens-touch'));
  // While it shows, the page does not scroll and no context menu opens.
  const move = new FakeEvent('touchmove', { cancelable: true });
  p.frame.dispatchEvent(move);
  assert.equal(move.defaultPrevented, true);
  const menu = new FakeEvent('contextmenu');
  p.frame.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true);
  touch('pointermove', 180, 470);
  assert.deepEqual([lens.centre.x, lens.centre.y], [8, 7], 'follows the finger');
  touch('pointerup', 180, 470);
  assert.equal(el.hidden, true, 'lifting hides it');
  // A swipe: the finger moves before the hold ends, so it is a scroll.
  touch('pointerdown', 150, 450);
  touch('pointermove', 150, 480);
  p.runTimers();
  assert.equal(el.hidden, true);
  const scroll = new FakeEvent('touchmove', { cancelable: true });
  p.frame.dispatchEvent(scroll);
  assert.equal(scroll.defaultPrevented, false, 'scrolling stays scrolling');
});

test('the lens draws the start markers it is given, else the map spawns in their colours', () => {
  const p = page();
  const { lens } = lensOn(p);
  lens.setSource('a', () => syntheticMap(), { width: 20, height: 12 });
  p.frame.dispatchEvent(pointer('pointermove', 130, 125));
  p.runFrames(4);
  const ctx = p.doc.body.querySelector('.map-lens canvas').getContext('2d');
  assert.ok(ctx.log.some((l) => l[0] === 'fillText' && l[1] === '1'), 'spawn 1 of the map');
  ctx.log.length = 0;
  lens.setMarkers([{ x: 3.5, y: 4, label: '4', color: [1, 0, 0] }]);
  p.runFrames(1);
  assert.ok(ctx.log.some((l) => l[0] === 'fillText' && l[1] === '4'), 'the lobby\'s marker');
  assert.ok(!ctx.log.some((l) => l[0] === 'fillText' && l[1] === '1'));
});

test('a map that cannot be read leaves the preview without a lens; new art rebuilds it', () => {
  const p = page();
  const { lens, art } = lensOn(p);
  const warn = console.warn;
  console.warn = () => {};
  try {
    lens.setSource('bad', () => {
      throw new Error('broken');
    }, { width: 20, height: 12 });
    p.frame.dispatchEvent(pointer('pointermove', 150, 130));
    p.runFrames(3);
    assert.equal(p.doc.body.querySelector('.map-lens').hidden, true);
    p.frame.dispatchEvent(pointer('pointermove', 151, 130));
    assert.equal(p.doc.body.querySelector('.map-lens').hidden, true, 'stays hidden for that map');
  } finally {
    console.warn = warn;
  }
  let loads = 0;
  lens.setSource('good', () => (loads++, syntheticMap(20, 12, art.version)), { width: 20, height: 12 });
  p.frame.dispatchEvent(pointer('pointermove', 152, 130));
  p.runFrames(3);
  assert.equal(loads, 1);
  art.version++;
  for (const fn of art.listeners) fn();
  p.runFrames(3);
  assert.equal(loads, 2, 'installed content changed: the map is read again with the new art');
});

test('spriteList keeps the visible sprites with their frames and team', () => {
  const map = syntheticMap();
  map.sprites = Float32Array.from([10, 20, 0, 0, 3, 1, 1, 0, 30, 40, 0, 0, 2, 1, 0, 0]);
  const list = spriteList(map);
  assert.equal(list.length, 1, 'alpha 0 is left out');
  assert.deepEqual([list[0].x, list[0].y, list[0].team, list[0].index], [10, 20, 3, 0]);
});

// ---- Art from the engine and installed content -------------------------------------------

/** A content system over synthetic original files (no EA bytes), Graphics set to `graphics`. */
async function content(files, graphics) {
  const store = new MemoryStore();
  await store.putAll([...files].map(([name, bytes]) => ({ name, bytes: bytes.slice().buffer })));
  const settings = createSettings(createRegistry({ storage: null }));
  settings.set('graphics', graphics);
  const c = new ContentSystem({ settings, open: async () => store, decodeImage: decodeTestPng });
  await c.load();
  return { content: c, settings };
}

/** A 32 x 24 map file with water, ore, a tank of spawn 1 and a neutral power plant. */
function mapJson() {
  const map = createMap({ width: 32, height: 24, name: 'Lens', author: 'Test' });
  const terrain = new Uint8Array(32 * 24);
  for (let i = 0; i < terrain.length; i++) terrain[i] = i % 32 > 26 ? TERRAIN.WATER : TERRAIN.CLEAR;
  map.terrain = encodeBase64(terrain);
  const ore = new Uint8Array(32 * 24);
  ore[10 * 32 + 10] = 8;
  map.ore = encodeBase64(ore);
  map.spawns = [[2, 2], [20, 16]];
  map.actors = [{ type: '1TNK', owner: 0, x: 12, y: 12, facing: 256 }, { type: 'POWR', owner: -1, x: 4, y: 14, facing: 0 }];
  return JSON.stringify(map);
}

test('LensArt reads a map file as a game starts it: terrain, actors in their team colours, spawns', async () => {
  globalThis.document = pixelDocument();
  const art = new LensArt({ Game, memory: () => wasm.memory, content: null });
  const m = art.fromMap(mapJson(), { colors: [[1, 0, 0]] });
  assert.equal(m.width, 32);
  assert.equal(m.height, 24);
  assert.equal(m.terrainSource, 'webra');
  assert.equal(m.spriteSource, 'webra');
  assert.deepEqual(m.spawns, [[2, 2], [20, 16]]);
  assert.deepEqual(m.colors[0], [1, 0, 0], 'spawn 1 in the colour of the player starting there');
  assert.deepEqual(m.colors[1], PREVIEW_COLORS[1].slice(), 'others in the preview palette');
  assert.deepEqual(m.colors[PREVIEW_NEUTRAL], PREVIEW_COLORS[PREVIEW_NEUTRAL].slice(), 'neutral in the civilian colour');
  const teams = new Set();
  for (let i = 0; i < m.sprites.length; i += 8) teams.add(m.sprites[i + 4]);
  assert.ok(teams.has(0) && teams.has(PREVIEW_NEUTRAL), 'the tank of spawn 1 and the neutral power plant');
  assert.equal(m.terrain.type(30, 5), TERRAIN.WATER);
  assert.ok(m.terrain.terrain[(10 * 32 + 10) * 4 + 1] > 0, 'ore');
  // The atlas is shared by the next map of the same rules and biome.
  const again = art.fromMap(mapJson());
  assert.equal(again.atlas, m.atlas);
  // A game starts: the atlases go, and the lenses are told to drop their maps.
  let told = 0;
  art.onChange(() => told++);
  const version = art.version;
  art.release();
  assert.equal(art.atlases.size, 0);
  assert.equal(art.terrainAtlases.size, 0);
  assert.equal(art.version, version + 1);
  assert.equal(told, 1);
  assert.notEqual(art.fromMap(mapJson()).atlas, m.atlas, 'the next hover builds it again');
});

test('LensArt: a generated map with the lobby options, and a mission with its actors and colours', async () => {
  globalThis.document = pixelDocument();
  const art = new LensArt({ Game, memory: () => wasm.memory, content: null, atlases: 1 });
  const gen = art.fromGenerated({ seed: 42, size: 64, players: 2, style: 'random', biome: 'snow', tech: 'extra' });
  assert.equal(gen.width, 64);
  assert.equal(gen.biome, 'snow');
  assert.equal(gen.spawns.length, 2);
  assert.ok(gen.sprites.length > 0, 'tech buildings and trees');
  const text = readFileSync(fileURLToPath(new URL('../missions/allies-01.json', import.meta.url)), 'utf8');
  const mission = art.fromMission(text);
  const data = JSON.parse(text);
  assert.equal(mission.width, data.map.width);
  assert.ok(mission.sprites.length > 0, 'the mission\'s actors');
  assert.deepEqual(mission.colors[0], hexColor(JSON.parse(Game.from_mission(text, '{"seed":1}').mission_state()).players[0].color));
  assert.equal(art.atlases.size, 1, 'one atlas kept: memory stays bounded');
  assert.equal(hexColor('nope'), null);
});

test('LensArt draws with the original graphics when installed and chosen, WebRA art otherwise', async () => {
  globalThis.document = pixelDocument();
  const files = new Map([...syntheticGraphics(), ...syntheticTheater()]);
  const { content: originals, settings } = await content(files, 'original');
  const art = new LensArt({ Game, memory: () => wasm.memory, content: originals });
  let changes = 0;
  art.onChange(() => changes++);
  const m = art.fromMap(mapJson());
  assert.equal(m.terrainSource, 'original');
  assert.equal(m.spriteSource, 'installed');
  assert.equal(m.terrainPixelArt, true, 'pixel art, drawn without smoothing');
  assert.ok((m.terrain.flags & ART_TILES) !== 0, 'the tile terrain path of the shader');
  // The player switches Graphics to WebRA: the lenses hear it and draw WebRA's art.
  settings.set('graphics', 'webra');
  assert.ok(changes >= 1);
  const w = art.fromMap(mapJson());
  assert.equal(w.version, art.version);
  assert.notEqual(w.version, m.version, 'older maps are rebuilt');
  assert.equal(w.terrainSource, 'webra');
  assert.equal(w.spriteSource, 'webra');
  // Nothing installed: WebRA art even with Original chosen.
  const { content: none } = await content(new Map(), 'original');
  const plain = new LensArt({ Game, memory: () => wasm.memory, content: none }).fromMap(mapJson());
  assert.equal(plain.terrainSource, 'webra');
  assert.equal(plain.spriteSource, 'webra');
});

test('a 128 x 128 map: reading it and drawing a tile, measured', async (t) => {
  globalThis.document = pixelDocument();
  const art = new LensArt({ Game, memory: () => wasm.memory, content: null });
  let t0 = performance.now();
  const m = art.fromGenerated({ seed: 7, size: 128, players: 4, style: 'random', biome: 'temperate', tech: 'standard' });
  const read = performance.now() - t0;
  const out = new Uint8ClampedArray(TILE_CELLS * CELL_PX * TILE_CELLS * CELL_PX * 4);
  t0 = performance.now();
  for (let k = 0; k < 4; k++) m.terrain.renderRows(out, 8 * k, 64, TILE_CELLS, CELL_PX, 0, TILE_CELLS * CELL_PX);
  const tile = (performance.now() - t0) / 4;
  t0 = performance.now();
  m.terrain.renderRows(out, 0, 0, TILE_CELLS, CELL_PX, 0, 8);
  const batch = performance.now() - t0;
  t.diagnostic(`read ${read.toFixed(1)} ms, tile ${tile.toFixed(2)} ms, 8-row batch ${batch.toFixed(2)} ms`);
  // A batch of rows is what one frame draws at least: it must fit a frame with room to spare.
  assert.ok(batch < 8, `an 8-row batch takes ${batch.toFixed(2)} ms`);
});

test('the lens stylesheet: theme tokens, --ui-px, no animation, linked by the game and the editor', () => {
  const css = readFileSync(fileURLToPath(new URL('../css/maplens.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /var\(--ui-px\)/);
  assert.match(css, /var\(--ui-accent\)/);
  assert.match(css, /pointer-events:\s*none/);
  assert.doesNotMatch(css, /transition|animation/);
  for (const page of ['../index.html', '../editor/index.html']) {
    assert.match(readFileSync(fileURLToPath(new URL(page, import.meta.url)), 'utf8'), /href="css\/maplens\.css"/);
  }
});

// ---- Where the lens is: skirmish lobby, online lobby, campaign -----------------------------

/** A lens stand-in that records what the screens ask of it. */
function recordingLens() {
  const calls = [];
  return {
    calls,
    attach: (target, image) => calls.push(['attach', target, image]),
    detach: () => calls.push(['detach']),
    setSource: (key, load, size) => calls.push(['source', key, load, size]),
    clearSource: () => calls.push(['clear']),
    setMarkers: (m) => calls.push(['markers', m]),
    hide: () => {},
    last: (kind) => calls.filter((c) => c[0] === kind).at(-1),
  };
}

/** A LensArt stand-in: what a loader asks for. */
const askedArt = { fromGenerated: (o) => ['generated', o], fromMap: (json, o) => ['map', json, o], fromMission: (text) => ['mission', text] };

test('skirmish lobby: the lens sits on the preview and reads the same map (generated with its tech buildings, or the map file)', async () => {
  const doc = installDom();
  globalThis.requestAnimationFrame = () => 1;
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  try {
    const root = doc.createElement('section');
    doc.body.append(root);
    const { Lobby } = await import('../js/lobby.js');
    const lens = recordingLens();
    const COLORS = PREVIEW_COLORS.slice(0, 8).map((c) => c.slice());
    const lobby = new Lobby(root, {
      colors: COLORS,
      colorNames: [],
      maps: {
        preview: (seed, size) => new Uint8Array(size * size * 4),
        spawns: () => [[2, 2], [50, 50]],
        validate: () => ({ ok: true, errors: [], modded: false, hash: 'h' }),
        filePreview: () => new Uint8Array(0),
      },
      lens: () => lens,
      onStart: () => {},
      onStress: () => {},
    });
    lobby.canvas.getContext = () => ({ putImageData() {}, clearRect() {} });
    lobby.ctx = lobby.canvas.getContext();
    const attach = lens.last('attach');
    assert.equal(attach[1].classList.contains('lobby-preview'), true, 'the frame gets the pointer (the markers lie over the canvas)');
    assert.equal(attach[2], lobby.canvas);
    lobby.drawPreview();
    const [, key, load, size] = lens.last('source');
    const { seed, mapSize, mapStyle, biome } = lobby.state;
    assert.equal(key.startsWith('gen:'), true);
    assert.deepEqual(size, { width: mapSize, height: mapSize });
    const [kind, asked] = load(askedArt);
    assert.equal(kind, 'generated');
    assert.deepEqual({ ...asked, colors: undefined }, { seed, size: mapSize, players: 2, style: mapStyle, biome, tech: 'standard', colors: undefined });
    assert.deepEqual(asked.colors[0], COLORS[lobby.state.players[0].color], 'spawn 1 in its player\'s colour');
    const markers = lens.last('markers')[1];
    assert.deepEqual(markers.map((m) => [m.x, m.y, m.label]), [[3.5, 4, '1'], [51.5, 52, '2']], 'the lobby\'s numbered starts at the construction yard centres');
    // The tech buildings change the map a game gets: the lens follows.
    lobby.techSelect.value = 'extra';
    lobby.techSelect.dispatchEvent(new FakeEvent('change'));
    lobby.drawPreview();
    assert.notEqual(lens.last('source')[1], key);
    assert.equal(lens.last('source')[2](askedArt)[1].tech, 'extra');
    // A failed preview: no lens.
    lobby.maps.preview = () => new Uint8Array(3);
    const err = console.error;
    console.error = () => {};
    try {
      lobby.drawPreview();
    } finally {
      console.error = err;
    }
    assert.equal(lens.calls.at(-2)[0], 'clear');
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test('online lobby: the lens reads the generated map, an installed shared map or the co-op mission; none for a map not installed', async () => {
  installDom();
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  const { OnlineUI } = await import('../js/online.js');
  const lens = recordingLens();
  // The fake DOM's canvases draw nothing: the preview itself reports that.
  const error = console.error;
  console.error = () => {};
  try {
    const ui = Object.create(OnlineUI.prototype);
    Object.assign(ui, {
      lens,
      ctx: { Game: { map_preview_styled: (seed, size) => new Uint8Array(size * size * 4), map_file_preview: () => new Uint8Array(4 * 4 * 4) } },
      installed: new Map(),
      missionPreviews: new Map(),
      mapStatus: { text: '', ok: true },
      mapNotice: null,
      mapOffer: null,
      mapBox: globalThis.document.createElement('section'),
      state: { you: 2, hostId: 1, slots: [{ type: 'human' }, { type: 'ai' }, { type: 'open' }], options: { seed: 9, mapSize: 64, mapStyle: 'rivers', biome: 'desert', techBuildings: 'oilrush' }, map: null, mission: null, spectators: [] },
    });
    ui.renderMap();
    const canvas = ui.mapBox.querySelector('canvas');
    assert.equal(lens.last('attach')[1], canvas);
    let [, key, load, size] = lens.last('source');
    assert.equal(key, 'gen:9/64/2/rivers/desert/oilrush');
    assert.deepEqual(size, { width: 64, height: 64 });
    assert.deepEqual(load(askedArt), ['generated', { seed: 9, size: 64, players: 2, style: 'rivers', biome: 'desert', tech: 'oilrush' }]);
    // A shared map this player has not installed: no preview, no lens.
    ui.state.map = { hash: 'abc', name: 'M', author: 'A', players: 2, width: 4, height: 4, bytes: 10, shared: true };
    const before = lens.calls.length;
    ui.renderMap();
    assert.deepEqual(lens.calls.slice(before).map((c) => c[0]), ['clear', 'attach'], 'cleared, then on the new preview');
    ui.installed.set('abc', '{"width":4,"height":4}');
    ui.renderMap();
    [, key, load, size] = lens.last('source');
    assert.equal(key, 'map:abc');
    assert.deepEqual(load(askedArt), ['map', '{"width":4,"height":4}', undefined]);
    // A co-op mission: its text, once it is here.
    ui.drawMissionPreview(canvas, { hash: 'mh', id: 'evacuation' });
    assert.equal(lens.calls.at(-1)[0], 'clear', 'not loaded yet');
    ui.missionPreviews.set('mh', { rgba: new Uint8Array(4 * 2 * 4), width: 4, text: 'TEXT' });
    ui.drawMissionPreview(canvas, { hash: 'mh', id: 'evacuation' });
    [, key, load, size] = lens.last('source');
    assert.equal(key, 'mission:mh');
    assert.deepEqual(size, { width: 4, height: 2 });
    assert.deepEqual(load(askedArt), ['mission', 'TEXT']);
  } finally {
    console.error = error;
  }
});

test('campaign: the lens reads the chosen mission once its file is here, and lets go when the screen closes', async () => {
  const doc = installDom();
  globalThis.ImageData ??= class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  const { CampaignMenu } = await import('../js/campaign/menu.js');
  const { CampaignProgress } = await import('../js/campaign/progress.js');
  const lens = recordingLens();
  const root = doc.createElement('section');
  doc.body.append(root);
  const entry = { id: 'm1', sha256: 'sha', title: 'One', faction: 'allies', briefing: '', options: {} };
  const INDEX = { campaigns: [{ id: 'c', title: 'C', missions: [{ ...entry, chapter: 1 }] }] };
  const menu = new CampaignMenu(root, {
    index: async () => INDEX,
    missionText: async () => 'MISSION',
    preview: () => ({ rgba: new Uint8Array(6 * 3 * 4), width: 6, height: 3 }),
    progress: new CampaignProgress(createRegistry({ storage: null })),
    onPlay: () => {},
    lens: () => lens,
  });
  // Canvases of the fake DOM draw nothing.
  const create = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const e = create(tag);
    if (tag === 'canvas') e.getContext = () => ({ putImageData() {} });
    return e;
  };
  await menu.open();
  await new Promise((r) => setTimeout(r, 0));
  const canvas = root.querySelector('.campaign-preview');
  assert.equal(lens.last('attach')[1], canvas);
  const [, key, load, size] = lens.last('source');
  assert.equal(key, 'mission:m1:sha');
  assert.deepEqual(size, { width: 6, height: 3 });
  assert.deepEqual(load(askedArt), ['mission', 'MISSION']);
  menu.close();
  assert.deepEqual(lens.calls.slice(-2).map((c) => c[0]), ['detach', 'clear']);
});
