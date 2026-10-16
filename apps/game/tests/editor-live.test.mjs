// An edit in progress shows live (editor/js/live.js, controller.js, doc.js):
// every drag tool changes the map while the pointer is down, the frame
// draws the changed cells (and their mirror images) before the release,
// the release still makes one undo step, Esc rolls the edit back, and the
// work per frame follows the cells that changed, not the size of the map.
// Synthetic maps only; the picture is checked as the bytes and tiles the
// editor uploads, against a full tiling of the same terrain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { MapDoc } from '../editor/js/doc.js';
import { Controller } from '../editor/js/controller.js';
import { TERRAIN, createMap } from '../editor/js/mapformat.js';
import { copyRegion } from '../editor/js/edits.js';
import { Minimap, terrainImage } from '../editor/js/preview.js';
import { CHUNK, LiveTerrain, docCellBytes } from '../editor/js/live.js';
import { commonTiles } from '../editor/js/tiles.js';
import { symmetricPositions } from '../editor/js/symmetry.js';
import { DEPTH_STEPS, cellTiles, terrainSeed } from '../js/art/terrain.js';
import { FakeEvent, installDom, uninstallDom } from './dom-fixtures.mjs';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const CATALOG = Object.fromEntries(JSON.parse(new Game(1, 'allies', 'soviet', 48).rules_json()).actors.map((a) => [a.id, a]));

const VIEW = (w, h) => ({ camera: { x: 0, y: 0, zoom: 0.3 }, hover: null, viewRect: () => ({ x0: 0, y0: 0, x1: w * 24, y1: h * 24 }) });
const STATE = (set = {}) => ({
  tool: 'brush',
  paint: 'terrain',
  material: TERRAIN.WATER,
  size: 3,
  ore: 8,
  gems: 3,
  symmetry: 'none',
  shapeFill: true,
  autoShore: false,
  actorType: null,
  owner: 0,
  facing: 0,
  layers: { grid: false, actors: true, spawns: true },
  region: null,
  clip: null,
  pasteLayers: { terrain: true, resources: true, actors: true },
  ...set,
});
const HOOKS = { status() {}, hover() {}, selectionChanged() {}, regionChanged() {}, picked() {}, endPaste() {} };

/** The document's terrain as engine terrain bytes (no preview: tree terrain stays tree). */
function docBytes(doc) {
  const b = new Uint8Array(doc.width * doc.height * 4);
  for (let i = 0; i < doc.width * doc.height; i++) docCellBytes(doc, i, b);
  return b;
}

/**
 * The editor with its picture: the document, the controller, and the
 * terrain as last fully uploaded (WebRA's tiles), which the frames patch.
 * `frame()` is what editor.js does once a frame during an edit.
 */
function editor(map, set = {}) {
  const doc = new MapDoc(map);
  const state = STATE(set);
  const ctl = new Controller(doc, VIEW(doc.width, doc.height), CATALOG, state, HOOKS);
  const live = new LiveTerrain();
  const uploads = [];
  const full = () => {
    const bytes = docBytes(doc);
    const seed = terrainSeed(bytes);
    live.reset(bytes, cellTiles(bytes, doc.width, doc.height, seed), doc.width, doc.height, { seed });
    live.setBase(doc, bytes.slice());
  };
  full();
  // A closed transaction rebuilds the whole picture (editor.js onDocChange, previewDirty).
  let changes = 0;
  doc.onChange(() => {
    changes++;
    full();
  });
  const frame = () => {
    ctl.flush();
    if (!doc.inTransaction) return 0;
    const { cells } = doc.takeLive();
    live.mark(doc, cells);
    return live.flush((x, y, w, h) => uploads.push([x, y, w, h]));
  };
  return { doc, state, ctl, live, uploads, frame, changes: () => changes };
}

const at = (x, y) => ({ x, y });
const LEFT = { button: 0 };

/** The picture shows the document (bytes) and its tiles are exactly a full tiling of those bytes. */
function assertPictureIsDoc(e, msg) {
  const { doc, live } = e;
  assert.deepEqual(live.bytes, docBytes(doc), `${msg}: the drawn terrain is the document's`);
  assert.deepEqual(live.cells, cellTiles(live.bytes, doc.width, doc.height, live.seed), `${msg}: the tiles are the full tiling's`);
}

const blank = (w = 64, h = 64, base = TERRAIN.CLEAR) => createMap({ width: w, height: h, base });

// ---- cellTiles of an area -------------------------------------------------------------------------

test('cellTiles of an area gives the full tiling\'s tiles there and leaves the rest alone', () => {
  const doc = new MapDoc(JSON.parse(Game.generated_map_with(5, 96, 4, 'lakes', 'temperate', 'extra')));
  const bytes = docBytes(doc);
  const seed = terrainSeed(bytes);
  const full = cellTiles(bytes, 96, 96, seed);
  for (const area of [
    { x0: 0, y0: 0, x1: 15, y1: 15 },
    { x0: 40, y0: 33, x1: 55, y1: 48 },
    { x0: 80, y0: 80, x1: 95, y1: 95 },
    { x0: 90, y0: -3, x1: 120, y1: 4 },
  ]) {
    const out = new Uint8Array(96 * 96 * 4).fill(7);
    cellTiles(bytes, 96, 96, seed, area, out);
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        const i = (y * 96 + x) * 4;
        const inside = x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1;
        assert.deepEqual([...out.subarray(i, i + 4)], inside ? [...full.subarray(i, i + 4)] : [7, 7, 7, 7], `cell ${x}, ${y}`);
      }
    }
  }
  assert.equal(DEPTH_STEPS, 4);
});

// ---- Live drags ------------------------------------------------------------------------------------

test('a drag shows the cells it changed before the release, for every drag tool', () => {
  const drags = [
    { tool: 'brush', set: {}, from: [10, 10], to: [30, 20] },
    { tool: 'line', set: { size: 3, material: TERRAIN.ROAD }, from: [5, 40], to: [50, 8] },
    { tool: 'line', set: { size: 1, material: TERRAIN.ROCK }, from: [8, 50], to: [40, 52] },
    { tool: 'rect', set: { material: TERRAIN.ROCK }, from: [20, 30], to: [34, 44] },
    { tool: 'rect', set: { material: TERRAIN.ROUGH, shapeFill: false }, from: [40, 30], to: [60, 50] },
    { tool: 'ellipse', set: { material: TERRAIN.WATER, autoShore: true }, from: [12, 12], to: [40, 30] },
    { tool: 'brush', set: { paint: 'ore' }, from: [44, 4], to: [60, 10] },
    { tool: 'brush', set: { paint: 'gems' }, from: [44, 14], to: [60, 16] },
    { tool: 'eraser', set: {}, from: [0, 0], to: [63, 63] },
  ];
  for (const d of drags) {
    const e = editor(blank(), { tool: d.tool, ...d.set });
    if (d.tool === 'eraser') {
      // Something to erase first.
      e.doc.begin('rough');
      for (let x = 0; x < 64; x++) e.doc.setCell(x, x, TERRAIN.ROUGH);
      e.doc.commit();
    }
    const before = e.doc.terrain.slice();
    const oreBefore = e.doc.ore.slice();
    const steps = e.doc.undoStack.length;
    e.ctl.down(at(...d.from), LEFT);
    e.ctl.move(at(Math.round((d.from[0] + d.to[0]) / 2), Math.round((d.from[1] + d.to[1]) / 2)));
    e.ctl.move(at(...d.to));
    const chunks = e.frame();
    assert.ok(e.doc.inTransaction, `${d.tool}: still dragging`);
    const changed = [...e.doc.terrain].some((t, i) => t !== before[i]) || [...e.doc.ore].some((o, i) => o !== oreBefore[i]) || e.doc.gems.some((g) => g > 0);
    assert.ok(changed, `${d.tool}: the map changed before the release`);
    assert.ok(chunks > 0, `${d.tool}: chunks went up`);
    assertPictureIsDoc(e, `${d.tool} while dragging`);
    e.ctl.up(at(...d.to), LEFT);
    assert.equal(e.doc.undoStack.length, steps + 1, `${d.tool}: one undo step`);
  }
});

test('a shape follows its corner, made again once a frame; the release is one undo step with the final shape', () => {
  const e = editor(blank(), { tool: 'rect', material: TERRAIN.ROCK });
  const original = e.doc.toMap();
  // Each remake gives cells back first: all of them (revert) or those that left the shape (revertCells).
  let reverts = 0;
  const revert = e.doc.revert.bind(e.doc);
  const revertCells = e.doc.revertCells.bind(e.doc);
  e.doc.revert = () => (reverts++, revert());
  e.doc.revertCells = (list) => (reverts++, revertCells(list));
  e.ctl.down(at(10, 10), LEFT);
  const made = reverts;
  // Many moves in one frame: the rectangle is made once, at the last corner.
  for (let k = 11; k <= 30; k++) e.ctl.move(at(k, k));
  assert.equal(reverts, made, 'moves only note the corner');
  e.frame();
  assert.equal(reverts, made + 1, 'one remake for the frame');
  assert.equal(e.doc.terrainAt(30, 30), TERRAIN.ROCK);
  assertPictureIsDoc(e, 'grown');
  // Shrinking gives the cells back.
  e.ctl.move(at(14, 12));
  e.frame();
  assert.equal(e.doc.terrainAt(30, 30), TERRAIN.CLEAR);
  assert.equal(e.doc.terrainAt(14, 12), TERRAIN.ROCK);
  assertPictureIsDoc(e, 'shrunk');
  // A frame without a move makes nothing again.
  e.frame();
  assert.equal(reverts, made + 2);
  e.ctl.up(at(14, 12), LEFT);
  assert.equal(e.doc.undoStack.length, 1);
  assert.equal(e.doc.undoStack[0].label, 'Rectangle of terrain');
  e.doc.undo();
  assert.deepEqual(e.doc.toMap(), original, 'the undo step restores the map');
  e.doc.redo();
  for (let y = 10; y <= 12; y++) for (let x = 10; x <= 14; x++) assert.equal(e.doc.terrainAt(x, y), TERRAIN.ROCK);
  assert.equal(e.doc.terrainAt(15, 13), TERRAIN.CLEAR);
});

test('the tool settings changed mid-drag remake the shape', () => {
  const e = editor(blank(), { tool: 'line', material: TERRAIN.ROAD, size: 1 });
  e.ctl.down(at(5, 20), LEFT);
  e.ctl.move(at(40, 20));
  e.frame();
  assert.equal(e.doc.terrainAt(20, 21), TERRAIN.CLEAR);
  e.state.size = 3;
  e.frame();
  assert.equal(e.doc.terrainAt(20, 21), TERRAIN.ROAD, 'the larger brush shows at once');
  assertPictureIsDoc(e, 'resized brush');
  e.ctl.up(at(40, 20), LEFT);
  assert.equal(e.doc.undoStack.length, 1);
});

test('one undo step after the release, for strokes, shapes, placing and moving', () => {
  const e = editor(blank(), {});
  const steps = () => e.doc.undoStack.length;
  const drag = (tool, from, to, set = {}) => {
    Object.assign(e.state, { tool }, set);
    const n = steps();
    e.ctl.down(at(...from), LEFT);
    for (let k = 1; k <= 5; k++) {
      e.ctl.move(at(Math.round(from[0] + ((to[0] - from[0]) * k) / 5), Math.round(from[1] + ((to[1] - from[1]) * k) / 5)));
      e.frame();
      assert.equal(steps(), n, `${tool}: nothing committed while dragging`);
    }
    e.ctl.up(at(...to), LEFT);
    assert.equal(steps(), n + 1, `${tool}: one step`);
  };
  drag('brush', [5, 5], [30, 10]);
  drag('ellipse', [30, 30], [50, 45], { material: TERRAIN.ROUGH });
  drag('actor', [40, 5], [56, 5], { actorType: 'E1', owner: -1 });
  assert.ok(e.doc.actors.length >= 2, 'a placing drag places as it goes');
  e.state.region = { x0: 28, y0: 28, x1: 52, y1: 47 };
  drag('region', [35, 35], [25, 20]);
  assert.equal(e.doc.terrainAt(25, 20), TERRAIN.ROUGH, 'the region moved with its contents');
  for (let k = 0; k < 4; k++) e.doc.undo();
  assert.deepEqual(e.doc.terrain, new MapDoc(blank()).terrain, 'four steps undone: the map as it was');
  assert.equal(e.doc.actors.length, 0);
});

test('a moved region shows at its new place while it is dragged', () => {
  const e = editor(blank(), { tool: 'region' });
  e.doc.begin('rock');
  for (let y = 5; y < 10; y++) for (let x = 5; x < 10; x++) e.doc.setCell(x, y, TERRAIN.ROCK);
  e.doc.commit();
  e.state.region = { x0: 5, y0: 5, x1: 9, y1: 9 };
  e.ctl.down(at(6, 6), LEFT);
  e.ctl.move(at(26, 16));
  e.frame();
  assert.equal(e.doc.terrainAt(25, 15), TERRAIN.ROCK, 'at the new place');
  assert.equal(e.doc.terrainAt(5, 5), TERRAIN.CLEAR, 'gone from the old one');
  assertPictureIsDoc(e, 'moved region');
  e.ctl.up(at(26, 16), LEFT);
  assert.deepEqual(e.state.region, { x0: 25, y0: 15, x1: 29, y1: 19 });
  assert.equal(e.doc.undoStack.length, 2);
});

test('the copy of the region dragged keeps the map\'s actors and terrain (copyRegion stays the clipboard)', () => {
  const e = editor(blank(), { tool: 'region' });
  e.doc.begin('put');
  e.doc.touchObjects();
  e.doc.actors.push({ type: 'E1', owner: -1, x: 6, y: 6, facing: 0 });
  e.doc.setCell(7, 7, TERRAIN.ROUGH);
  e.doc.commit();
  const clip = copyRegion(e.doc, CATALOG, 5, 5, 9, 9);
  e.state.region = { x0: 5, y0: 5, x1: 9, y1: 9 };
  e.ctl.down(at(5, 5), LEFT);
  for (const k of [3, 7, 12]) {
    e.ctl.move(at(5 + k, 5));
    e.frame();
    assert.deepEqual(copyRegion(e.doc, CATALOG, 5 + k, 5, 9 + k, 9), clip, `at +${k}`);
    assert.equal(e.doc.actors.length, 1, 'one actor, not one per frame');
  }
  e.ctl.up(at(17, 5), LEFT);
  assert.deepEqual([e.doc.actors[0].x, e.doc.actors[0].y], [18, 6]);
});

test('Esc during a drag rolls the edit back and the picture is made again from the map', () => {
  for (const tool of ['brush', 'rect', 'line', 'eraser', 'region']) {
    const e = editor(blank(), { tool, material: TERRAIN.WATER });
    e.doc.begin('rough');
    for (let x = 10; x < 20; x++) e.doc.setCell(x, 12, TERRAIN.ROUGH);
    e.doc.commit();
    e.state.region = { x0: 8, y0: 8, x1: 22, y1: 16 };
    const original = e.doc.toMap();
    const steps = e.doc.undoStack.length;
    e.ctl.down(at(12, 12), LEFT);
    e.ctl.move(at(40, 30));
    e.frame();
    assert.notDeepEqual(e.doc.toMap(), original, `${tool}: changed while dragging`);
    const changes = e.changes();
    assert.equal(e.ctl.cancel(), true);
    assert.deepEqual(e.doc.toMap(), original, `${tool}: rolled back`);
    assert.equal(e.changes(), changes + 1, `${tool}: the editor hears of it (the preview is built again)`);
    assertPictureIsDoc(e, `${tool} after Esc`);
    // The release after Esc does nothing.
    e.ctl.up(at(40, 30), LEFT);
    e.frame();
    assert.deepEqual(e.doc.toMap(), original);
    assert.equal(e.doc.undoStack.length, steps, `${tool}: no step`);
  }
});

test('symmetry is mirrored live: the mirror images change and show while dragging', () => {
  for (const symmetry of ['horizontal', 'quad', 'rotate90', 'eight']) {
    for (const tool of ['brush', 'line', 'rect']) {
      const e = editor(blank(80, 80), { tool, symmetry, material: TERRAIN.ROCK, size: 1 });
      e.ctl.down(at(6, 9), LEFT);
      e.ctl.move(at(14, 12));
      e.frame();
      const cells = tool === 'rect' ? [[6, 9], [14, 12], [10, 10]] : [[6, 9], [14, 12]];
      for (const [x, y] of cells) {
        for (const p of symmetricPositions(symmetry, x, y, 80, 80)) {
          assert.equal(e.doc.terrainAt(p.x, p.y), TERRAIN.ROCK, `${tool} ${symmetry}: mirror ${p.x}, ${p.y} of ${x}, ${y}`);
          assert.equal(e.live.bytes[(p.y * 80 + p.x) * 4], TERRAIN.ROCK, `${tool} ${symmetry}: drawn at ${p.x}, ${p.y}`);
        }
      }
      assertPictureIsDoc(e, `${tool} ${symmetry}`);
      e.ctl.up(at(14, 12), LEFT);
      assert.equal(e.doc.undoStack.length, 1);
    }
  }
});

test('the live update tiles and uploads only the chunks around the changed cells', () => {
  const size = 256;
  const e = editor(blank(size, size), { tool: 'brush', size: 1, material: TERRAIN.WATER, symmetry: 'quad' });
  e.ctl.down(at(40, 40), LEFT);
  e.frame();
  e.live.stats = { tiled: 0, uploaded: 0, chunks: 0 };
  e.uploads.length = 0;
  const before = e.live.cells.slice();
  e.ctl.move(at(44, 41));
  e.frame();
  // Five cells at each of four mirror images: the chunks within DEPTH_STEPS of them, no more.
  const changed = [];
  for (const [x, y] of [[41, 40], [42, 40], [42, 41], [43, 41], [44, 41]]) for (const p of symmetricPositions('quad', x, y, size, size)) changed.push(p);
  const near = new Set();
  for (const p of changed) {
    for (let y = p.y - DEPTH_STEPS; y <= p.y + DEPTH_STEPS; y++) {
      for (let x = p.x - DEPTH_STEPS; x <= p.x + DEPTH_STEPS; x++) near.add(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`);
    }
  }
  assert.ok(e.live.stats.tiled <= near.size * CHUNK * CHUNK, `${e.live.stats.tiled} cells tiled`);
  assert.ok(e.live.stats.tiled <= (size * size) / 32, 'a small part of the map');
  assert.equal(e.uploads.length, e.live.stats.chunks);
  for (const [x, y, w, h] of e.uploads) {
    assert.ok(w <= CHUNK && h <= CHUNK && x % CHUNK === 0 && y % CHUNK === 0, 'chunk uploads');
    assert.ok(near.has(`${x / CHUNK},${y / CHUNK}`), `chunk ${x}, ${y} is near a changed cell`);
  }
  // Outside the uploaded chunks nothing changed.
  const up = new Set(e.uploads.map(([x, y]) => `${x / CHUNK},${y / CHUNK}`));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (up.has(`${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`)) continue;
      const i = (y * size + x) * 4;
      assert.equal(e.live.cells[i], before[i]);
    }
  }
  assertPictureIsDoc(e, 'big map');
  // A frame with nothing new does nothing; repainting the same cells uploads nothing.
  e.live.stats = { tiled: 0, uploaded: 0, chunks: 0 };
  e.frame();
  e.ctl.move(at(43, 41));
  e.frame();
  assert.deepEqual(e.live.stats, { tiled: 0, uploaded: 0, chunks: 0 });
  // Ore changes no tile: the chunk goes up without tiling.
  e.ctl.up(at(43, 41), LEFT);
  Object.assign(e.state, { paint: 'ore', symmetry: 'none' });
  e.ctl.down(at(100, 100), LEFT);
  e.live.stats = { tiled: 0, uploaded: 0, chunks: 0 };
  e.frame();
  assert.deepEqual(e.live.stats, { tiled: 0, uploaded: CHUNK * CHUNK, chunks: 1 });
  assertPictureIsDoc(e, 'ore');
  e.ctl.up(at(100, 100), LEFT);
});

test('installed tiles: a changed cell shows its type\'s common tile, a cell changed back its own tile', () => {
  const doc = new MapDoc(blank(48, 48));
  doc.begin('coast');
  for (let y = 0; y < 48; y++) for (let x = 0; x < 12 + (y % 3); x++) doc.setCell(x, y, TERRAIN.WATER);
  doc.commit();
  const bytes = docBytes(doc);
  // A plan's tiles: any numbers that differ per cell and type.
  const planned = new Uint8Array(48 * 48 * 4);
  for (let i = 0; i < 48 * 48; i++) {
    planned[i * 4] = (bytes[i * 4] * 10 + (i % 3)) & 255;
    planned[i * 4 + 1] = 1;
    planned[i * 4 + 3] = 255;
  }
  const live = new LiveTerrain();
  live.reset(bytes, planned, 48, 48, { installed: true });
  live.setBase(doc, bytes.slice());
  assert.notEqual(live.cells, planned, 'the plan is not patched in place');
  const types = Uint8Array.from({ length: 48 * 48 }, (_, i) => bytes[i * 4]);
  const common = commonTiles(types, planned);
  doc.begin('paint');
  doc.setCell(30, 30, TERRAIN.WATER);
  doc.setCell(5, 5, TERRAIN.CLEAR);
  live.mark(doc, doc.takeLive().cells);
  const tileAt = (x, y) => live.cells[(y * 48 + x) * 4] | (live.cells[(y * 48 + x) * 4 + 1] << 8);
  assert.equal(tileAt(30, 30), common[TERRAIN.WATER]);
  assert.equal(tileAt(5, 5), common[TERRAIN.CLEAR]);
  assert.equal(live.stats.tiled, 0, 'installed tiles are not tiled here');
  doc.revert();
  live.mark(doc, doc.takeLive().cells);
  const own = (x, y) => planned[(y * 48 + x) * 4] | (planned[(y * 48 + x) * 4 + 1] << 8);
  assert.equal(tileAt(30, 30), own(30, 30));
  assert.equal(tileAt(5, 5), own(5, 5));
  const uploads = [];
  live.flush((...r) => uploads.push(r));
  assert.equal(uploads.length, 2, 'the two cells\' chunks');
  doc.rollback();
});

test('trees: a changed tree cell asks for the preview; once built, the preview\'s bytes are drawn', () => {
  const e = editor(blank(), { tool: 'brush', size: 1, material: TERRAIN.TREE });
  e.ctl.down(at(10, 10), LEFT);
  const { cells } = e.doc.takeLive();
  assert.equal(e.live.mark(e.doc, cells), true, 'a tree comes: the preview is wanted');
  assert.equal(e.live.bytes[(10 * 64 + 10) * 4], TERRAIN.TREE, 'the tree tile meanwhile');
  // The preview built now: tree terrain is clear ground under a tree actor there.
  const preview = docBytes(e.doc);
  preview[(10 * 64 + 10) * 4] = TERRAIN.CLEAR;
  e.live.setBase(e.doc, preview);
  e.live.remark(e.doc);
  assert.equal(e.live.bytes[(10 * 64 + 10) * 4], TERRAIN.CLEAR, 'the preview\'s ground under its tree');
  // Plain ground needs no preview.
  e.state.material = TERRAIN.ROUGH;
  e.ctl.move(at(12, 10));
  assert.equal(e.live.mark(e.doc, e.doc.takeLive().cells), false);
  e.ctl.up(at(12, 10), LEFT);
});

test('placing, moving and erasing actors report object changes for the live preview', () => {
  const e = editor(blank(), { tool: 'actor', actorType: 'E1', owner: -1 });
  e.ctl.down(at(5, 5), LEFT);
  assert.equal(e.doc.takeLive().objects, true, 'placed');
  e.ctl.move(at(9, 5));
  assert.equal(e.doc.takeLive().objects, true, 'placed again');
  e.ctl.up(at(9, 5), LEFT);
  assert.equal(e.doc.takeLive().objects, false, 'nothing pending after the commit');
  Object.assign(e.state, { tool: 'select' });
  e.ctl.down(at(5, 5), LEFT);
  e.doc.takeLive();
  e.ctl.move(at(7, 8));
  assert.equal(e.doc.takeLive().objects, true, 'moved');
  e.ctl.up(at(7, 8), LEFT);
  assert.deepEqual([e.doc.actors[0].x, e.doc.actors[0].y], [7, 8]);
});

test('an undo while dragging cancels the drag and undoes the step before it; redo never holds half a shape', () => {
  const e = editor(blank(), { tool: 'brush', material: TERRAIN.ROUGH });
  const blankMap = e.doc.toMap();
  e.ctl.down(at(30, 30), LEFT);
  e.ctl.up(at(30, 30), LEFT);
  const painted = e.doc.toMap();
  Object.assign(e.state, { tool: 'rect', material: TERRAIN.ROCK });
  e.ctl.down(at(4, 4), LEFT);
  e.ctl.move(at(10, 10));
  e.frame();
  assert.equal(e.doc.undo(), 'Paint terrain', 'the step before the drag is undone');
  assert.deepEqual(e.doc.toMap(), blankMap, 'the half rectangle rolled back, the stroke undone');
  assert.equal(e.doc.redoStack.length, 1);
  // The drag is over: its moves and release change nothing.
  e.ctl.move(at(20, 20));
  e.frame();
  e.ctl.up(at(20, 20), LEFT);
  assert.equal(e.ctl.gesture, null);
  assert.deepEqual(e.doc.toMap(), blankMap);
  assert.equal(e.doc.redo(), 'Paint terrain', 'redo brings the stroke back, not a half rectangle');
  assert.deepEqual(e.doc.toMap(), painted);
  assert.equal(e.doc.redoStack.length, 0);
  // Redo while dragging rolls the drag back too.
  e.doc.undo();
  e.ctl.down(at(4, 4), LEFT);
  e.ctl.move(at(10, 10));
  e.frame();
  e.doc.redo();
  assert.deepEqual(e.doc.toMap(), painted);
});

test('a dragged big filled shape changes only its edge when its corner moves, and stays one exact undo step', () => {
  for (const symmetry of ['none', 'quad']) {
    const e = editor(JSON.parse(Game.generated_map_with(3, 128, 4, 'lakes', 'temperate', 'extra')), { tool: 'rect', material: TERRAIN.ROCK, symmetry });
    const original = e.doc.toMap();
    e.ctl.down(at(0, 0), LEFT);
    e.ctl.move(at(120, 120));
    e.frame();
    let writes = 0;
    const setCell = e.doc.setCell.bind(e.doc);
    e.doc.setCell = (...a) => (writes++, setCell(...a));
    e.ctl.move(at(122, 121));
    e.frame();
    // One new column and row at each mirror image, not the area again.
    assert.ok(writes <= 4 * (123 + 122), `${symmetry}: ${writes} cells painted`);
    e.ctl.move(at(119, 118));
    e.frame();
    e.doc.setCell = setCell;
    assertPictureIsDoc(e, `${symmetry}: shrunk`);
    // The same map as the shape painted at once.
    const once = new MapDoc(original);
    const ctl = new Controller(once, VIEW(128, 128), CATALOG, { ...e.state }, HOOKS);
    once.begin('once');
    ctl.paintCells(ctl.shapeCells('rect', 0, 0, 119, 118), false);
    once.commit();
    assert.deepEqual(e.doc.terrain, once.terrain, `${symmetry}: the shape as painted at once`);
    e.ctl.up(at(119, 118), LEFT);
    assert.deepEqual(e.doc.terrain, once.terrain);
    assert.equal(e.doc.undoStack.length, 1);
    e.doc.undo();
    assert.deepEqual(e.doc.toMap(), original, `${symmetry}: one undo step restores the map`);
  }
});

test('a dragged shape painting ore or with beaches along water comes out as painted at once', () => {
  for (const set of [{ paint: 'ore', ore: 5 }, { paint: 'terrain', material: TERRAIN.WATER, autoShore: true }, { paint: 'gems', symmetry: 'rotate180' }]) {
    const e = editor(JSON.parse(Game.generated_map_with(4, 64, 2, 'lakes', 'temperate', 'extra')), { tool: 'ellipse', ...set });
    const original = e.doc.toMap();
    e.ctl.down(at(5, 5), LEFT);
    for (const [x, y] of [[40, 30], [50, 44], [20, 18], [33, 33]]) {
      e.ctl.move(at(x, y));
      e.frame();
    }
    e.ctl.up(at(33, 33), LEFT);
    const once = new MapDoc(original);
    const ctl = new Controller(once, VIEW(64, 64), CATALOG, { ...e.state }, HOOKS);
    once.begin('once');
    ctl.paintCells(ctl.shapeCells('ellipse', 5, 5, 33, 33), false);
    once.commit();
    assert.deepEqual([e.doc.terrain, e.doc.ore, e.doc.gems], [once.terrain, once.ore, once.gems], JSON.stringify(set));
  }
});

test('live preview builds: full ones after a commit rerun the checks, live ones only draw, at most every interval', async () => {
  const { LivePreview, LIVE_PREVIEW_MS, LIVE_PREVIEW_SHARE } = await import('../editor/js/live.js');
  let builds = 0;
  let checks = 0;
  let cost = 2;
  let clock = 0;
  const p = new LivePreview({ build: () => (builds++, (clock += cost)), onFull: () => checks++, clock: () => clock });
  p.full();
  assert.deepEqual([builds, checks], [1, 1]);
  assert.equal(p.live(0), false, 'nothing wanted');
  p.want();
  assert.equal(p.live(1000), true);
  assert.equal(p.live(1001), false);
  p.want();
  assert.equal(p.live(1000 + LIVE_PREVIEW_MS - 1), false, 'not yet');
  assert.equal(p.live(1000 + LIVE_PREVIEW_MS), true);
  assert.deepEqual([builds, checks], [3, 1], 'live builds rerun no checks');
  // A slow build spaces the next ones out.
  cost = 40;
  p.want();
  p.live(5000);
  p.want();
  assert.equal(p.live(5000 + 40 * LIVE_PREVIEW_SHARE - 1), false);
  assert.equal(p.live(5000 + 40 * LIVE_PREVIEW_SHARE), true);
  // editor.js: the checks are marked out of date by full builds only.
  const src = readFileSync(new URL('../editor/editor.js', import.meta.url), 'utf8');
  const build = /function buildPreview\(\) \{([\s\S]*?)\n\}/.exec(src)[1];
  assert.doesNotMatch(build, /analysisDirty|fairness/);
  assert.match(src, /onFull: \(\) => \{\n    analysisDirty = true;/);
});

// ---- Pointer capture -------------------------------------------------------------------------------

test('the canvas captures the tool\'s pointer: no stuck stroke when it leaves or loses the capture', async () => {
  uninstallDom();
  installDom({ windowEvents: true });
  try {
    const { EditorView } = await import('../editor/js/view.js');
    const canvas = document.createElement('canvas');
    const captured = [];
    canvas.setPointerCapture = (id) => captured.push(id);
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 240, height: 240 });
    const calls = [];
    const view = new EditorView(canvas, {}, {
      down: (c) => calls.push(['down', c.x, c.y]),
      move: (c) => calls.push(['move', c.x, c.y]),
      up: (c) => calls.push(['up', c.x, c.y]),
      leave: () => calls.push(['leave']),
      cancel: () => calls.push(['cancel']),
    });
    document.body.append(canvas);
    const fire = (type, init) => canvas.dispatchEvent(new FakeEvent(type, { pointerType: 'mouse', pointerId: 1, button: 0, ...init }));
    fire('pointerdown', { clientX: 30, clientY: 30 });
    assert.deepEqual(captured, [1]);
    // Off the canvas (captured, the moves still come): the cells off the canvas.
    fire('pointermove', { clientX: 500, clientY: 30 });
    // The capture is lost without a release: the stroke ends where the pointer was.
    fire('lostpointercapture', {});
    fire('pointerup', { clientX: 500, clientY: 30 });
    assert.deepEqual(calls, [
      ['down', 1, 1],
      ['move', 20, 1],
      ['up', 20, 1],
    ]);
    // The system cancels the pointer: the edit is cancelled, not committed half done.
    calls.length = 0;
    fire('pointerdown', { clientX: 30, clientY: 30, pointerId: 2 });
    fire('pointercancel', { clientX: 60, clientY: 30, pointerId: 2 });
    fire('pointerup', { clientX: 60, clientY: 30, pointerId: 2 });
    assert.deepEqual(calls, [['down', 1, 1], ['cancel']]);
    // A second press while one is down (another pointer) is not a new gesture; its release ends nothing.
    calls.length = 0;
    fire('pointerdown', { clientX: 30, clientY: 30, pointerId: 5 });
    fire('pointerdown', { clientX: 60, clientY: 30, pointerId: 6 });
    fire('pointerup', { clientX: 60, clientY: 30, pointerId: 6 });
    fire('pointerup', { clientX: 90, clientY: 30, pointerId: 5 });
    assert.deepEqual(calls, [
      ['down', 1, 1],
      ['up', 3, 1],
    ]);
    // Touch: a second finger cancels the tool's gesture and pinches.
    calls.length = 0;
    fire('pointerdown', { clientX: 30, clientY: 30, pointerId: 7, pointerType: 'touch' });
    fire('pointerdown', { clientX: 90, clientY: 30, pointerId: 8, pointerType: 'touch' });
    assert.deepEqual(calls, [['down', 1, 1], ['cancel']]);
    assert.ok(view.pinch);
  } finally {
    uninstallDom();
  }
});

// ---- The minimap ---------------------------------------------------------------------------------------

test('the minimap redraws only the cells an edit in progress changed; actors keep their colour', () => {
  globalThis.ImageData ??= class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  };
  const doc = new MapDoc(blank(32, 32));
  doc.begin('unit');
  doc.touchObjects();
  doc.actors.push({ type: 'POWR', owner: 0, x: 20, y: 20, facing: 0 });
  doc.commit();
  const puts = [];
  const mini = Object.assign(Object.create(Minimap.prototype), {
    dirty: false,
    covered: new Uint8Array(32 * 32),
    base: { getContext: () => ({ putImageData: (...a) => puts.push(a.slice(1)) }) },
  });
  mini.image = terrainImage(doc, CATALOG, mini.covered);
  const powr = [...mini.image.data.subarray((20 * 32 + 20) * 4, (20 * 32 + 20) * 4 + 3)];
  doc.begin('paint');
  doc.setCell(3, 4, TERRAIN.WATER);
  doc.setCell(6, 9, TERRAIN.WATER);
  doc.setCell(20, 20, TERRAIN.ROUGH);
  mini.patch(doc, doc.takeLive().cells);
  assert.deepEqual(puts, [[0, 0, 3, 4, 4, 6]], 'the box around the changed cells');
  const full = terrainImage(doc, CATALOG);
  assert.deepEqual(mini.image.data, full.data, 'the same picture as drawn afresh');
  assert.deepEqual([...mini.image.data.subarray((20 * 32 + 20) * 4, (20 * 32 + 20) * 4 + 3)], powr, 'the structure keeps its colour');
  // Invalidated (objects changed): the next draw makes it afresh, patches wait for it.
  mini.dirty = true;
  mini.patch(doc, [0]);
  assert.equal(puts.length, 1);
  doc.rollback();
});

