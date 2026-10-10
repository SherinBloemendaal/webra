// The map editor's art (editor/js/art.js) and its engine preview
// (editor/js/world.js) with synthetic original graphics (no EA bytes): the
// same atlas, poses, terrain tiles and cameos as a game, the Graphics
// choice, the palette pictures and the fallback to WebRA's art.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import init, { Game } from '../pkg/webra_sim.js';
import { MemoryStore } from '../js/content/store.js';
import { ContentSystem } from '../js/content/index.js';
import { createSettings } from '../js/settings.js';
import { createRegistry } from '../js/registry.js';
import { artActors } from '../js/gameart.js';
import { FRAME_FLOATS } from '../js/sprites.js';
import { POSE, packSprite, facingFrame } from '../js/content/sequences.js';
import { EditorArt, PREVIEW_FACING, paintAtlasFrame, slotFrame } from '../editor/js/art.js';
import { OBSERVER, PREVIEW_NEUTRAL, PreviewWorld, SPRITE_FLOATS } from '../editor/js/world.js';
import { createMap, encodeBase64, TERRAIN } from '../editor/js/mapformat.js';
import { decodeTestPng, pixelDocument, syntheticGraphics, syntheticTheater } from './content-fixtures.mjs';

const wasm = await init({ module_or_path: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const ACTORS = artActors(JSON.parse(new Game(7, 'england', 'russia', 64).rules_json()).actors);
const index = (id) => ACTORS.findIndex((a) => a.id === id);
const BLUE = [0.3, 0.55, 0.95];

const realDocument = globalThis.document;
afterEach(() => {
  globalThis.document = realDocument;
});
// Cameo pictures go through ImageData (js/content/cameos.js); Node has none.
globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
};
// The atlas reports which actors lack installed files; quiet here.
console.info = () => {};

/** An EditorArt over a content system holding `files` (synthetic originals), Graphics set to `graphics`. */
async function editorArt(files, graphics = 'original') {
  const store = new MemoryStore();
  await store.putAll([...files].map(([name, bytes]) => ({ name, bytes: bytes.slice().buffer })));
  const settings = createSettings(createRegistry({ storage: null }));
  settings.set('graphics', graphics);
  const content = new ContentSystem({ settings, open: async () => store, decodeImage: decodeTestPng });
  const art = new EditorArt({ settings, content });
  await art.load();
  return { art, settings, content };
}

const allFiles = () => new Map([...syntheticGraphics(), ...syntheticTheater()]);

/** A recording canvas: a pixel array for getImageData / putImageData, calls logged. */
function canvas(w = 48, h = 40) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  const log = [];
  const ctx = new Proxy(
    {
      getImageData: () => ({ data: pixels.slice(), width: w, height: h }),
      putImageData: (img) => pixels.set(img.data),
      clearRect: () => {
        pixels.fill(0);
        log.push('clear');
      },
      drawImage: (...a) => log.push(['drawImage', a.length]),
    },
    { get: (t, k) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: () => true },
  );
  return { width: w, height: h, getContext: () => ctx, pixels, log };
}

test('Graphics follow the game setting: original art builds the pixel-art atlas, WebRA art without it', async () => {
  globalThis.document = pixelDocument();
  const { art, settings } = await editorArt(allFiles());
  assert.equal(art.hasOriginal, true);
  assert.equal(art.originalActive, true);
  let { atlas, original } = art.build(ACTORS, 'temperate');
  assert.equal(atlas.filter, 'nearest', 'the original graphics are pixel art, drawn with poses');
  assert.ok(art.originalBody(index('1TNK')) && art.originalBody(index('POWR')));
  assert.ok(!art.originalBody(index('3TNK')), 'actors without installed files keep WebRA art');
  assert.ok(original.slots.includes(2 * index('E1')));
  let changes = 0;
  art.onChange(() => changes++);
  art.graphics = 'webra';
  assert.equal(settings.get('graphics'), 'webra', 'the choice is the game setting (registry game.graphics)');
  assert.ok(changes >= 1, 'the editor hears about it and rebuilds');
  ({ atlas, original } = art.build(ACTORS, 'temperate'));
  assert.equal(atlas.filter, 'linear');
  assert.equal(original, null);
  assert.equal(art.originalBody(index('1TNK')), false);
});

test('without installed graphics the Original choice draws WebRA art', async () => {
  globalThis.document = pixelDocument();
  const { art } = await editorArt(new Map(), 'original');
  assert.equal(art.hasOriginal, false);
  assert.equal(art.originalActive, false);
  assert.equal(art.build(ACTORS, 'temperate').atlas.filter, 'linear');
  assert.equal(art.terrain('temperate', new Uint8Array(16 * 16 * 4), 16, 16), null, 'WebRA tiles');
});

test('terrain tiles come from the installed theater (the game path), WebRA tiles for other biomes', async () => {
  globalThis.document = pixelDocument();
  const { art } = await editorArt(allFiles());
  const w = 16;
  const bytes = new Uint8Array(w * w * 4);
  for (let i = 0; i < w * w; i++) {
    bytes[i * 4] = i % 7 === 0 ? TERRAIN.WATER : TERRAIN.CLEAR;
    bytes[i * 4 + 3] = 255;
  }
  const tiles = art.terrain('temperate', bytes, w, w);
  assert.ok(tiles?.atlas && tiles.cells.length === w * w * 4, 'the original temperate tiles');
  assert.equal(art.terrain('snow', bytes, w, w), null, 'no snow theater installed: WebRA tiles');
});

test('palette pictures: installed cameo, else the original sprite, else WebRA cameo art or icon', async () => {
  globalThis.document = pixelDocument();
  const { art } = await editorArt(allFiles());
  art.build(ACTORS, 'temperate');
  // The light tank has an original cameo (1tnkicon.shp).
  const c1 = canvas();
  assert.equal(art.paintPalette(c1, ACTORS[index('1TNK')], index('1TNK'), BLUE), 'content');
  // The power plant has original art but no cameo file: its sprite in the team colour.
  const c2 = canvas();
  assert.equal(art.paintPalette(c2, ACTORS[index('POWR')], index('POWR'), BLUE), 'original');
  assert.ok(c2.pixels.some((v, i) => i % 4 === 3 && v > 0), 'the sprite is painted');
  // No installed art: WebRA's.
  const c3 = canvas();
  assert.ok(['art', 'sprite'].includes(art.paintPalette(c3, ACTORS[index('3TNK')], index('3TNK'), BLUE)));
});

test('slotFrame picks the facing frame the sprite shader draws', async () => {
  globalThis.document = pixelDocument();
  const { art } = await editorArt(allFiles());
  const { atlas } = art.build(ACTORS, 'temperate');
  const t = index('E1');
  const entry = (i) => atlas.frames.subarray(i * FRAME_FLOATS, (i + 1) * FRAME_FLOATS);
  const head = entry(2 * t);
  const desc = entry(head[12] + POSE.IDLE);
  const radians = (PREVIEW_FACING * Math.PI * 2) / 1024;
  const { facing } = facingFrame(radians, { facings: desc[12], classic: (desc[13] & 1) !== 0, rotate: false, interpolatedFacings: desc[14] });
  assert.equal(slotFrame(atlas.frames, 2 * t, POSE.IDLE, radians).index, desc[8] + facing * desc[9]);
  // A WebRA slot is its own frame.
  const plain = index('3TNK');
  assert.equal(slotFrame(atlas.frames, 2 * plain, POSE.IDLE, 0).index, 2 * plain);
});

test('paintAtlasFrame tints team pixels like the sprite shader and keeps the rest', () => {
  // A 2x1 atlas: a grey team pixel and a plain red pixel, one frame over both.
  const pixels = {
    width: 2,
    height: 1,
    color: new Uint8ClampedArray([128, 128, 128, 255, 200, 0, 0, 255]),
    mask: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]),
  };
  const frames = new Float32Array(FRAME_FLOATS);
  frames.set([0, 0, 1, 1]);
  // Scaled up (nearest) into a 20x10 canvas with a margin: the left half shows the team pixel, the right half the red one.
  const c = canvas(20, 10);
  assert.equal(paintAtlasFrame(c.getContext('2d'), 20, 10, pixels, frames, 0, [1, 0, 0]), true);
  const at = (x, y) => [...c.pixels.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
  const k = 0.35 + (128 / 255) * 1.05;
  assert.deepEqual(at(5, 4), [Math.round(Math.min(1, k) * 255), 0, 0, 255]);
  assert.deepEqual(at(14, 4), [200, 0, 0, 255]);
  assert.deepEqual(at(0, 0), [0, 0, 0, 0], 'the margin stays clear');
  const empty = new Float32Array(FRAME_FLOATS);
  assert.equal(paintAtlasFrame(c.getContext('2d'), 20, 10, pixels, empty, 0, [1, 0, 0]), false);
});

/** A map file: 32x32 clear, two spawns, `actors`, `edit(terrain)` applied. */
function mapJson(actors, edit = () => {}) {
  const map = createMap({ width: 32, height: 32, name: 'T', author: 'A' });
  const terrain = new Uint8Array(32 * 32);
  edit(terrain);
  map.terrain = encodeBase64(terrain);
  map.spawns = [[2, 2], [26, 26]];
  map.actors = actors;
  return JSON.stringify(map);
}

test('the preview draws the actors with the game renderer: original poses, wall pieces, neutral team', async () => {
  globalThis.document = pixelDocument();
  const { art } = await editorArt(allFiles());
  art.build(ACTORS, 'temperate');
  const preview = new PreviewWorld({ Game, memory: () => wasm.memory, prepare: (g) => art.applyTo(g) });
  const sb = (x) => ({ type: 'SBAG', owner: -1, x, y: 20, facing: 0 });
  const json = mapJson([{ type: '1TNK', owner: 0, x: 10, y: 10, facing: 256 }, { type: 'POWR', owner: 1, x: 14, y: 4, facing: 0 }, sb(5), sb(6), sb(7)]);
  assert.equal(preview.update(json), true);
  assert.equal(preview.update(json), false, 'the same file is not rebuilt');
  const s = preview.sprites({ x0: 0, y0: 0, x1: 32 * 24, y1: 32 * 24 });
  const ids = [];
  for (let i = 0; i < s.length; i += SPRITE_FLOATS) ids.push([s[i + 3], s[i + 4]]);
  const has = (id, team) => ids.some(([i, t]) => i === id && t === team);
  assert.ok(has(packSprite(2 * index('1TNK'), POSE.IDLE, 0), 0), 'the tank, spawn 1');
  assert.ok(has(packSprite(2 * index('POWR'), POSE.IDLE, 0), 1), 'the power plant, spawn 2');
  // Sandbags: the engine names each piece's connections (1 north, 2 east, 4 south, 8 west) in the age.
  const bag = 2 * index('SBAG');
  for (const mask of [2, 2 | 8, 8]) assert.ok(has(packSprite(bag, POSE.IDLE, mask), PREVIEW_NEUTRAL), `wall piece ${mask}`);
  assert.equal(preview.terrain().length, 32 * 32 * 4);
  // A map the game would refuse (no spawns) still previews; unreadable JSON keeps the last preview.
  assert.equal(preview.update(JSON.stringify({ ...JSON.parse(json), spawns: [] })), true);
  assert.equal(preview.update('{'), false);
  assert.match(preview.error, /invalid map JSON/);
  assert.ok(preview.sprites({ x0: 0, y0: 0, x1: 768, y1: 768 }).length > 0);
  preview.dispose();
  assert.equal(OBSERVER, 255);
});

test('with WebRA art the preview draws plain slots (no poses), tree terrain as tree actors', async () => {
  globalThis.document = pixelDocument();
  const { art } = await editorArt(new Map(), 'webra');
  art.build(ACTORS, 'temperate');
  const preview = new PreviewWorld({ Game, memory: () => wasm.memory, prepare: (g) => art.applyTo(g) });
  preview.update(mapJson([{ type: 'SBAG', owner: -1, x: 5, y: 20, facing: 0 }], (t) => (t[10 * 32 + 10] = TERRAIN.TREE)));
  const s = preview.sprites({ x0: 0, y0: 0, x1: 768, y1: 768 });
  const ids = [];
  for (let i = 0; i < s.length; i += SPRITE_FLOATS) ids.push(s[i + 3]);
  assert.ok(ids.includes(2 * index('SBAG')), 'no pose code on WebRA art');
  const trees = ACTORS.map((a, t) => (a.world?.category === 'Tree' ? 2 * t : -1)).filter((t) => t >= 0);
  assert.ok(ids.some((id) => trees.includes(id)), 'the tree cell is a tree actor, as in a game');
  assert.equal(preview.terrain()[(10 * 32 + 10) * 4], TERRAIN.CLEAR, 'on clear ground');
  preview.dispose();
});
