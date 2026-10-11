// Map editor logic without a DOM: document history, editing tools, symmetry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapDoc } from '../editor/js/doc.js';
import { TERRAIN, createMap, validateMap } from '../editor/js/mapformat.js';
import {
  actorAt,
  addSpawns,
  brushCells,
  erase,
  fill,
  fillRect,
  lineCells,
  paintGems,
  paintOre,
  paintTerrain,
  placeActor,
  placementProblem,
  spawnPartners,
} from '../editor/js/edits.js';
import { applyTransform, mirroredOwner, symmetricPositions, transformFacing, transformsFor } from '../editor/js/symmetry.js';

const CATALOG = {
  FACT: { kind: 'building', width: 3, height: 4, footprint: [[0, 0, 1], [1, 0, 1], [2, 0, 1], [0, 1, 1], [1, 1, 1], [2, 1, 1], [0, 2, 1], [1, 2, 1], [2, 2, 1], [0, 3, 2], [1, 3, 2], [2, 3, 2]] },
  SBAG: { kind: 'building', width: 1, height: 1, footprint: [[0, 0, 1]] },
  '1TNK': { kind: 'vehicle', width: 1, height: 1, footprint: null, terrain: [0, 1, 5, 6, 7, 8] },
  // Ships: `terrain` lists what their locomotor enters (engine rules_json; OpenRA naval: Water, lcraft also Beach).
  PT: { kind: 'ship', width: 1, height: 1, footprint: null, terrain: [3] },
  LST: { kind: 'ship', width: 1, height: 1, footprint: null, terrain: [3, 8] },
  SYRD: { kind: 'building', onWater: true, width: 3, height: 3, footprint: [[0, 0, 1], [1, 0, 1], [2, 0, 1], [0, 1, 2], [1, 1, 2], [2, 1, 2], [0, 2, 1], [1, 2, 1], [2, 2, 1]] },
};

const newDoc = (w = 40, h = 32) => new MapDoc(createMap({ width: w, height: h, name: 'T', author: 'A' }));
const t = (doc, x, y) => doc.terrain[doc.idx(x, y)];
const o = (doc, x, y) => doc.ore[doc.idx(x, y)];
const g = (doc, x, y) => doc.gems[doc.idx(x, y)];

// ---- Symmetry -------------------------------------------------------------------------

test('symmetry transforms mirror cells and footprints', () => {
  assert.equal(transformsFor('none').length, 1);
  assert.equal(transformsFor('quad').length, 4);
  const [h, v, r] = [transformsFor('horizontal')[1], transformsFor('vertical')[1], transformsFor('rotate180')[1]];
  assert.deepEqual(applyTransform(h, 2, 5, 40, 32), [37, 5]);
  assert.deepEqual(applyTransform(v, 2, 5, 40, 32), [2, 26]);
  assert.deepEqual(applyTransform(r, 2, 5, 40, 32), [37, 26]);
  // A 3x4 yard at (8, 8) on a 96 map rotates onto (85, 84), like the generator.
  assert.deepEqual(applyTransform(r, 8, 8, 96, 96, 3, 4), [85, 84]);
  // Cells on the axis are not duplicated.
  assert.equal(symmetricPositions('horizontal', 20, 3, 41, 32).length, 1);
  assert.equal(symmetricPositions('quad', 1, 1, 40, 32).length, 4);
});

test('facings mirror with the map', () => {
  const [h, v, r] = [transformsFor('horizontal')[1], transformsFor('vertical')[1], transformsFor('rotate180')[1]];
  assert.equal(transformFacing(h, 256), 768); // east becomes west
  assert.equal(transformFacing(v, 0), 512); // north becomes south
  assert.equal(transformFacing(v, 256), 256); // east stays east
  assert.equal(transformFacing(r, 128), 640);
  assert.equal(transformFacing(h, 0), 0);
});

test('mirrored owners follow the mirrored spawn', () => {
  const spawns = [[8, 8], [85, 84]];
  const r = transformsFor('rotate180')[1];
  assert.equal(mirroredOwner(r, 0, spawns, 96, 96), 1);
  assert.equal(mirroredOwner(r, 1, spawns, 96, 96), 0);
  assert.equal(mirroredOwner(r, -1, spawns, 96, 96), -1);
  assert.equal(mirroredOwner(transformsFor('horizontal')[1], 0, spawns, 96, 96), 0, 'no partner keeps the owner');
});

// ---- Brushes ----------------------------------------------------------------------------

test('brush shapes and lines', () => {
  assert.equal(brushCells(5, 5, 1).length, 1);
  assert.equal(brushCells(5, 5, 3).length, 9);
  assert.equal(brushCells(5, 5, 5).length, 21);
  assert.ok(brushCells(5, 5, 9).length > 50);
  assert.deepEqual(lineCells(0, 0, 3, 0), [[0, 0], [1, 0], [2, 0], [3, 0]]);
  const diag = lineCells(0, 0, 4, 2);
  assert.deepEqual(diag[0], [0, 0]);
  assert.deepEqual(diag[diag.length - 1], [4, 2]);
  assert.equal(diag.length, 5);
});

// ---- Document history ---------------------------------------------------------------------

test('a stroke is one undo step and redo restores it', () => {
  const doc = newDoc();
  doc.begin('Brush');
  paintTerrain(doc, brushCells(10, 10, 3), TERRAIN.WATER, 'none');
  paintTerrain(doc, brushCells(12, 10, 3), TERRAIN.WATER, 'none');
  doc.commit();
  assert.equal(t(doc, 13, 11), TERRAIN.WATER);
  assert.equal(doc.undoStack.length, 1);
  assert.equal(doc.undo(), 'Brush');
  assert.equal(t(doc, 13, 11), TERRAIN.CLEAR);
  assert.equal(doc.redo(), 'Brush');
  assert.equal(t(doc, 13, 11), TERRAIN.WATER);
  assert.equal(doc.undo(), 'Brush');
  assert.equal(doc.undo(), null);
});

test('empty transactions are not recorded and new edits clear redo', () => {
  const doc = newDoc();
  doc.begin('Nothing');
  paintTerrain(doc, [[1, 1]], TERRAIN.CLEAR, 'none');
  doc.commit();
  assert.equal(doc.canUndo, false);
  doc.begin('A');
  paintTerrain(doc, [[1, 1]], TERRAIN.ROCK, 'none');
  doc.commit();
  doc.undo();
  assert.equal(doc.canRedo, true);
  doc.begin('B');
  paintTerrain(doc, [[2, 2]], TERRAIN.ROCK, 'none');
  doc.commit();
  assert.equal(doc.canRedo, false);
});

test('rollback restores cells and objects', () => {
  const doc = newDoc();
  doc.begin('Drag');
  paintTerrain(doc, [[3, 3]], TERRAIN.TREE, 'none');
  doc.touchObjects();
  doc.spawns[0] = [20, 20];
  doc.rollback();
  assert.equal(t(doc, 3, 3), TERRAIN.CLEAR);
  assert.deepEqual(doc.spawns[0], [8, 8]);
  assert.equal(doc.canUndo, false);
});

test('typing in a property coalesces into one undo step', () => {
  const doc = newDoc();
  for (const name of ['M', 'Ma', 'Map']) {
    doc.begin('Rename', 'meta.name');
    doc.touchMeta();
    doc.meta.name = name;
    doc.commit();
  }
  assert.equal(doc.undoStack.length, 1);
  doc.undo();
  assert.equal(doc.meta.name, 'T');
});

test('replace is undoable and keeps the old size', () => {
  const doc = newDoc(40, 32);
  doc.replace(createMap({ width: 64, height: 48 }), 'New map');
  assert.equal(doc.width, 64);
  doc.undo();
  assert.equal(doc.width, 40);
  assert.equal(doc.terrain.length, 40 * 32);
  doc.redo();
  assert.equal(doc.height, 48);
});

test('toMap round-trips through MapDoc and validates', () => {
  const doc = newDoc();
  doc.begin('x');
  paintOre(doc, brushCells(20, 20, 3), 7, 'none');
  doc.commit();
  const map = doc.toMap();
  assert.equal(validateMap(map).ok, true, validateMap(map).errors.join('; '));
  const again = new MapDoc(map);
  assert.equal(o(again, 20, 20), 7);
  assert.equal(map.rules, null);
});

// ---- Tools ---------------------------------------------------------------------------------

test('impassable terrain clears ore and ore skips impassable cells', () => {
  const doc = newDoc();
  doc.begin('x');
  paintOre(doc, [[5, 5], [6, 6]], 9, 'none');
  paintTerrain(doc, [[5, 5]], TERRAIN.ROCK, 'none');
  paintOre(doc, [[5, 5]], 9, 'none');
  doc.commit();
  assert.equal(o(doc, 5, 5), 0);
  assert.equal(o(doc, 6, 6), 9);
  assert.ok(validateMap(doc.toMap()).ok);
});

test('the gem brush paints gems, replaces ore, and is undoable; the map becomes format 2', () => {
  const doc = newDoc();
  doc.begin('ore');
  paintOre(doc, [[5, 5], [6, 5]], 9, 'none');
  doc.commit();
  assert.equal(doc.toMap().format, 1);
  doc.begin('Gem brush');
  paintGems(doc, [[5, 5], [7, 5]], 7, 'horizontal'); // clamped to 3, mirrored
  paintTerrain(doc, [[8, 20]], TERRAIN.WATER, 'none');
  paintGems(doc, [[8, 20]], 2, 'none'); // water: skipped
  doc.commit();
  assert.deepEqual([g(doc, 5, 5), o(doc, 5, 5)], [3, 0], 'gems replaced the ore');
  assert.deepEqual([g(doc, 7, 5), g(doc, 34, 5), g(doc, 8, 20)], [3, 3, 0]);
  const map = doc.toMap();
  assert.equal(map.format, 2);
  assert.ok(validateMap(map).ok, validateMap(map).errors.join('; '));
  assert.equal(g(new MapDoc(map), 7, 5), 3, 'round trip');
  // Ore painted over gems replaces them; impassable terrain drops both.
  doc.begin('ore again');
  paintOre(doc, [[7, 5]], 4, 'none');
  paintTerrain(doc, [[5, 5]], TERRAIN.ROCK, 'none');
  doc.commit();
  assert.deepEqual([o(doc, 7, 5), g(doc, 7, 5), g(doc, 5, 5)], [4, 0, 0]);
  doc.undo();
  assert.deepEqual([o(doc, 7, 5), g(doc, 7, 5), g(doc, 5, 5)], [0, 3, 3]);
  doc.undo();
  assert.deepEqual([g(doc, 5, 5), o(doc, 5, 5)], [0, 9], 'undo restores the ore under the gems');
  assert.equal(doc.toMap().format, 1, 'no gems left: format 1 again');
  // Right drag (density 0) removes gems only.
  doc.redo();
  doc.begin('remove');
  paintGems(doc, [[5, 5], [6, 5]], 0, 'none');
  doc.commit();
  assert.deepEqual([g(doc, 5, 5), o(doc, 6, 5)], [0, 9]);
});

test('symmetric painting paints the mirrored cells', () => {
  const doc = newDoc(40, 32);
  doc.begin('x');
  paintTerrain(doc, [[1, 2]], TERRAIN.WATER, 'quad');
  doc.commit();
  for (const [x, y] of [[1, 2], [38, 2], [1, 29], [38, 29]]) assert.equal(t(doc, x, y), TERRAIN.WATER, `${x},${y}`);
});

test('fill replaces the connected region only', () => {
  const doc = newDoc(40, 32);
  doc.begin('wall');
  for (let y = 0; y < 32; y++) paintTerrain(doc, [[20, y]], TERRAIN.ROCK, 'none');
  doc.commit();
  doc.begin('fill');
  fill(doc, 5, 5, TERRAIN.ROUGH, 'none');
  doc.commit();
  assert.equal(t(doc, 0, 0), TERRAIN.ROUGH);
  assert.equal(t(doc, 19, 31), TERRAIN.ROUGH);
  assert.equal(t(doc, 20, 5), TERRAIN.ROCK);
  assert.equal(t(doc, 21, 5), TERRAIN.CLEAR);
  doc.undo();
  assert.equal(t(doc, 0, 0), TERRAIN.CLEAR);
});

test('rectangle fills inclusive corners in any drag direction', () => {
  const doc = newDoc();
  doc.begin('rect');
  fillRect(doc, 6, 4, 3, 2, TERRAIN.TREE, 'none');
  doc.commit();
  assert.equal(t(doc, 3, 2), TERRAIN.TREE);
  assert.equal(t(doc, 6, 4), TERRAIN.TREE);
  assert.equal(t(doc, 7, 4), TERRAIN.CLEAR);
  assert.equal(doc.undoStack[0].cells.idx.length, 12);
});

test('actors respect footprints, terrain and overlaps', () => {
  const doc = newDoc();
  doc.begin('place');
  assert.equal(placeActor(doc, CATALOG, { type: 'FACT', owner: 0, x: 20, y: 10, facing: 0 }, 'none').length, 1);
  assert.equal(placementProblem(doc, CATALOG, 'SBAG', 21, 11), 'overlaps another actor');
  assert.equal(placementProblem(doc, CATALOG, 'SBAG', 21, 13), null, 'bib cells are passable, not occupied');
  assert.equal(placementProblem(doc, CATALOG, 'FACT', 38, 10), 'outside the map');
  paintTerrain(doc, [[5, 5]], TERRAIN.ROUGH, 'none');
  assert.equal(placementProblem(doc, CATALOG, 'SBAG', 5, 5), 'needs clear ground');
  assert.equal(placementProblem(doc, CATALOG, '1TNK', 5, 5), null);
  assert.equal(placementProblem(doc, CATALOG, 'NOPE', 5, 5), 'unknown actor');
  doc.commit();
  assert.equal(actorAt(doc, CATALOG, 22, 13)?.type, 'FACT');
  assert.equal(actorAt(doc, CATALOG, 23, 13), null);
});

test('symmetric actor placement mirrors owner and facing', () => {
  const doc = new MapDoc(createMap({ width: 96, height: 96 }));
  doc.begin('place');
  const added = placeActor(doc, CATALOG, { type: '1TNK', owner: 0, x: 20, y: 20, facing: 128 }, 'rotate180');
  doc.commit();
  assert.equal(added.length, 2);
  assert.deepEqual(added[1], { type: '1TNK', owner: 1, x: 75, y: 75, facing: 640 });
});

test('eraser clears terrain, ore, gems and actors in one step', () => {
  const doc = newDoc();
  doc.begin('setup');
  paintTerrain(doc, [[10, 10]], TERRAIN.ROCK, 'none');
  paintOre(doc, [[11, 10]], 5, 'none');
  paintGems(doc, [[11, 11]], 2, 'none');
  placeActor(doc, CATALOG, { type: '1TNK', owner: -1, x: 12, y: 10, facing: 0 }, 'none');
  doc.commit();
  doc.begin('erase');
  assert.equal(erase(doc, brushCells(11, 10, 3), 'none', CATALOG), 1);
  doc.commit();
  assert.equal(t(doc, 10, 10), TERRAIN.CLEAR);
  assert.equal(o(doc, 11, 10), 0);
  assert.equal(g(doc, 11, 11), 0);
  assert.equal(doc.actors.length, 0);
  doc.undo();
  assert.equal(doc.actors.length, 1);
  assert.equal(t(doc, 10, 10), TERRAIN.ROCK);
});

test('spawns: symmetric add, limit of 8, partners and removal', () => {
  const doc = new MapDoc(createMap({ width: 96, height: 96 }));
  doc.begin('spawns');
  doc.touchObjects();
  doc.spawns.length = 0;
  assert.deepEqual(addSpawns(doc, 8, 8, 'rotate180'), [0, 1]);
  assert.deepEqual(doc.spawns[1], [85, 84]);
  assert.deepEqual(spawnPartners(doc, 0, 'rotate180'), [{ k: 1, t: transformsFor('rotate180')[1] }]);
  addSpawns(doc, 20, 20, 'quad');
  addSpawns(doc, 30, 40, 'quad');
  assert.equal(doc.spawns.length, 8);
  assert.deepEqual(addSpawns(doc, 40, 40, 'none'), []);
  placeActor(doc, CATALOG, { type: '1TNK', owner: 3, x: 50, y: 50, facing: 0 }, 'none');
  placeActor(doc, CATALOG, { type: '1TNK', owner: 5, x: 51, y: 50, facing: 0 }, 'none');
  doc.removeSpawn(3);
  doc.commit();
  assert.equal(doc.spawns.length, 7);
  assert.deepEqual(doc.actors.map((a) => a.owner), [-1, 4]);
});

// ---- Symmetry groups, shapes, regions and map turns -------------------------------------

import { modeFits, transformCell, SYMMETRY_MODES } from '../editor/js/symmetry.js';
import { autoShore, clearRegion, copyRegion, ellipseCells, pasteRegion, rectCells, regionFromData, regionToData, thickLineCells, transformRegion } from '../editor/js/edits.js';
import { cropMap, resizeMap, shiftMap, turnMap } from '../editor/js/transform.js';
import { decodeLayers } from '../editor/js/mapformat.js';

test('symmetry groups: quarter turns and diagonals on square maps, mirrors everywhere', () => {
  for (const m of SYMMETRY_MODES) {
    // Every mode is a group: each transform maps the map onto itself and composes inside the mode.
    const ts = transformsFor(m.id, 16, 16);
    const key = (tr) => {
      const pts = [];
      for (const [x, y] of [[1, 2], [5, 0], [15, 9]]) pts.push(transformCell(tr, x, y, 16, 16).join(','));
      return pts.join(';');
    };
    const keys = new Set(ts.map(key));
    assert.equal(keys.size, ts.length, `${m.id}: distinct transforms`);
  }
  assert.deepEqual(transformCell(transformsFor('rotate90', 16, 16)[1], 0, 0, 16, 16), [15, 0], 'a quarter turn clockwise');
  assert.equal(symmetricPositions('rotate90', 2, 3, 16, 16).length, 4);
  assert.equal(symmetricPositions('eight', 2, 3, 16, 16).length, 8);
  assert.equal(symmetricPositions('eight', 2, 2, 16, 16).length, 4, 'on a diagonal: no duplicates');
  assert.equal(modeFits('rotate90', 16, 20), false);
  assert.equal(modeFits('quad', 16, 20), true);
  assert.equal(symmetricPositions('eight', 2, 3, 16, 20).length, 4, 'not square: the mirrors only');
  // Diagonal mirror: north becomes west, east becomes south; a 3x4 box stays 3x4 around the mirrored centre.
  const d = transformsFor('diagonal', 16, 16)[1];
  assert.equal(transformFacing(d, 0), 768);
  assert.equal(transformFacing(d, 256), 512);
  // Centre (3.5, 7) mirrors to (7, 3.5); the 3 x 4 box around it starts at (5.5, 1.5), rounded.
  assert.deepEqual(applyTransform(d, 2, 5, 16, 16, 3, 4), [6, 2]);
});

test('shapes: thick lines, ellipses (ring and filled) and rectangle borders', () => {
  const line = thickLineCells(0, 0, 4, 0, 3);
  assert.ok(line.some(([x, y]) => x === 4 && y === 1) && line.some(([x, y]) => x === -1 && y === 0));
  assert.equal(new Set(line.map((c) => c.join())).size, line.length, 'no duplicates');
  const ring = ellipseCells(0, 0, 8, 4);
  const disc = ellipseCells(0, 0, 8, 4, true);
  assert.ok(ring.length < disc.length);
  assert.ok(disc.some(([x, y]) => x === 4 && y === 2) && !ring.some(([x, y]) => x === 4 && y === 2), 'the ring is hollow');
  for (const [cx, cy] of ring) assert.ok(cx >= 0 && cx <= 8 && cy >= 0 && cy <= 4);
  assert.deepEqual(ellipseCells(3, 3, 3, 3), [[3, 3]]);
  assert.equal(rectCells(0, 0, 3, 2, false).length, 10);
  assert.equal(rectCells(3, 2, 0, 0).length, 12);
});

test('auto shore: land next to painted water becomes beach, rock and roads stay', () => {
  const doc = newDoc(16, 16);
  doc.begin('Lake');
  const cells = [];
  for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) cells.push([x, y]);
  paintTerrain(doc, cells, TERRAIN.WATER, 'none');
  doc.setCell(4, 6, TERRAIN.ROCK);
  const n = autoShore(doc, cells, 'none');
  doc.commit();
  assert.ok(n > 0);
  assert.equal(t(doc, 4, 5), TERRAIN.BEACH);
  assert.equal(t(doc, 4, 6), TERRAIN.ROCK);
  assert.equal(t(doc, 3, 3), TERRAIN.CLEAR, 'only next to the water');
  assert.equal(t(doc, 4, 4), TERRAIN.CLEAR, 'diagonal neighbours are not shore');
  doc.undo();
  assert.equal(t(doc, 4, 5), TERRAIN.CLEAR, 'one undo step');
});

test('regions: copy, turn, mirror, paste with actors, clear, and stamps as data', () => {
  const doc = newDoc(40, 32);
  doc.begin('Setup');
  doc.setCell(2, 2, TERRAIN.ROCK);
  doc.setCell(3, 2, TERRAIN.CLEAR, 5);
  placeActor(doc, CATALOG, { type: 'SBAG', owner: -1, x: 2, y: 3, facing: 0 }, 'none');
  placeActor(doc, CATALOG, { type: '1TNK', owner: 0, x: 4, y: 3, facing: 256 }, 'none');
  doc.commit();
  const clip = copyRegion(doc, CATALOG, 2, 2, 4, 3);
  assert.deepEqual([clip.w, clip.h], [3, 2]);
  assert.equal(clip.terrain[0], TERRAIN.ROCK);
  assert.equal(clip.ore[1], 5);
  assert.equal(clip.actors.length, 2);
  // A quarter turn: 2 x 3, the rock goes to the top right, the tank faces south.
  const turned = transformRegion(clip, CATALOG, 'rotate');
  assert.deepEqual([turned.w, turned.h], [2, 3]);
  assert.equal(turned.terrain[1], TERRAIN.ROCK);
  assert.equal(turned.actors.find((a) => a.type === '1TNK').facing, 512);
  const flipped = transformRegion(clip, CATALOG, 'flipX');
  assert.equal(flipped.terrain[2], TERRAIN.ROCK);
  assert.equal(flipped.actors.find((a) => a.type === '1TNK').dx, 0);
  // Paste with a mirror: both copies, owners mirrored to the other spawn.
  doc.spawns = [[2, 10], [35, 10]];
  doc.begin('Paste');
  const r = pasteRegion(doc, CATALOG, clip, 10, 20, 'horizontal');
  doc.commit();
  assert.equal(r.actors, 4);
  assert.equal(t(doc, 10, 20), TERRAIN.ROCK);
  assert.equal(t(doc, 29, 20), TERRAIN.ROCK, 'the mirrored copy is mirrored');
  const tanks = doc.actors.filter((a) => a.type === '1TNK' && a.y === 21);
  assert.deepEqual(tanks.map((a) => a.owner).sort(), [0, 1]);
  // Pasting again on top: the actors do not fit, the cells are written.
  doc.begin('Again');
  assert.equal(pasteRegion(doc, CATALOG, clip, 10, 20, 'none').skipped, 2);
  doc.commit();
  // Only terrain.
  doc.begin('Terrain only');
  const only = pasteRegion(doc, CATALOG, clip, 0, 28, 'none', { terrain: true, resources: false, actors: false });
  doc.commit();
  assert.equal(only.actors, 0);
  assert.equal(o(doc, 1, 28), 0);
  doc.begin('Cut');
  clearRegion(doc, CATALOG, 2, 2, 4, 3);
  doc.commit();
  assert.equal(t(doc, 2, 2), TERRAIN.CLEAR);
  assert.ok(!doc.actors.some((a) => a.y === 3 && a.x <= 4));
  const back = regionFromData(JSON.parse(JSON.stringify(regionToData(clip))));
  assert.deepEqual([...back.terrain], [...clip.terrain]);
  assert.deepEqual(back.actors, clip.actors);
  assert.throws(() => regionFromData({ ...regionToData(clip), w: 4 }), /damaged/);
});

test('map resize, crop, shift and turns keep cells, spawns and actors in step', () => {
  const doc = newDoc(64, 40);
  doc.begin('Setup');
  doc.setCell(0, 0, TERRAIN.ROCK);
  doc.setCell(63, 39, TERRAIN.WATER);
  placeActor(doc, CATALOG, { type: '1TNK', owner: 1, x: 50, y: 20, facing: 0 }, 'none');
  placeActor(doc, CATALOG, { type: 'FACT', owner: 0, x: 10, y: 10, facing: 0 }, 'none');
  doc.commit();
  const map = doc.toMap();
  const cell = (m, x, y) => decodeLayers(m).terrain[y * m.width + x];
  // Grow by 8 to the left and top.
  const grown = resizeMap(map, CATALOG, 72, 48, 8, 8).map;
  assert.equal(cell(grown, 8, 8), TERRAIN.ROCK);
  assert.deepEqual(grown.spawns[0], [map.spawns[0][0] + 8, map.spawns[0][1] + 8]);
  // Crop to the left half: spawn 2 and the tank go, owners renumbered.
  const crop = cropMap(map, CATALOG, 0, 0, 31, 39);
  assert.equal(crop.map.width, 32);
  assert.equal(crop.dropped.spawns, 1);
  assert.equal(crop.dropped.actors, 1);
  assert.equal(crop.map.actors.length, 1);
  assert.equal(crop.map.actors[0].owner, 0);
  assert.throws(() => resizeMap(map, CATALOG, 8, 8, 0, 0), /Width and height/);
  const shifted = shiftMap(map, CATALOG, 1, 0).map;
  assert.equal(cell(shifted, 1, 0), TERRAIN.ROCK);
  assert.equal(cell(shifted, 0, 0), TERRAIN.CLEAR);
  // A quarter turn: 40 x 64, the top-left corner goes to the top right, units face east.
  const turned = turnMap(map, CATALOG, 'rotate90').map;
  assert.deepEqual([turned.width, turned.height], [40, 64]);
  assert.equal(cell(turned, 39, 0), TERRAIN.ROCK);
  assert.equal(turned.actors.find((a) => a.type === '1TNK').facing, 256);
  const fact = turned.actors.find((a) => a.type === 'FACT');
  assert.ok(fact.x >= 0 && fact.x + 3 <= 40 && fact.y + 4 <= 64, 'structures keep their size and stay on the map');
  const back = turnMap(turnMap(turned, CATALOG, 'rotate90').map, CATALOG, 'rotate180').map;
  assert.deepEqual(decodeLayers(back).terrain, decodeLayers(map).terrain, 'four quarter turns are the map again');
  const flipped = turnMap(map, CATALOG, 'flipX').map;
  assert.equal(cell(flipped, 63, 0), TERRAIN.ROCK);
  assert.equal(flipped.actors.find((a) => a.type === '1TNK').x, 13);
  assert.ok(validateMap(turned, { catalog: CATALOG }).errors.every((e) => !/terrain|ore/.test(e)));
});

import { findFixes, nearestYard } from '../editor/js/fixes.js';

test('ships and naval yards go on water, the transport also on beaches; ground units not', () => {
  const doc = newDoc();
  doc.begin('coast');
  fillRect(doc, 20, 0, 39, 31, TERRAIN.WATER, 'none');
  fillRect(doc, 19, 0, 19, 31, TERRAIN.BEACH, 'none');
  doc.commit();
  assert.equal(placementProblem(doc, CATALOG, 'PT', 10, 10), 'needs water', 'no gunboat on land');
  assert.equal(placementProblem(doc, CATALOG, 'PT', 19, 10), 'needs water', 'nor on the beach');
  doc.begin('ford');
  fillRect(doc, 30, 20, 30, 20, TERRAIN.FORD, 'none');
  doc.commit();
  assert.equal(placementProblem(doc, CATALOG, 'LST', 30, 20), 'needs water', 'fords are land to ships');
  assert.equal(placementProblem(doc, CATALOG, '1TNK', 30, 20), null, 'tanks wade');
  assert.equal(placementProblem(doc, CATALOG, 'PT', 25, 10), null);
  assert.equal(placementProblem(doc, CATALOG, 'LST', 19, 10), null, 'the transport runs up on the beach');
  assert.equal(placementProblem(doc, CATALOG, 'LST', 10, 10), 'needs water');
  assert.equal(placementProblem(doc, CATALOG, '1TNK', 25, 10), 'needs passable ground', 'no tank in the sea');
  assert.equal(placementProblem(doc, CATALOG, '1TNK', 19, 10), null, 'tanks drive on beaches');
  assert.equal(placementProblem(doc, CATALOG, 'SYRD', 25, 10), null, 'a naval yard on water');
  assert.equal(placementProblem(doc, CATALOG, 'SYRD', 18, 10), 'needs water', 'not over the shore');
  assert.equal(placementProblem(doc, CATALOG, 'SYRD', 5, 10), 'needs water');
  doc.begin('place');
  assert.equal(placeActor(doc, CATALOG, { type: 'PT', owner: 0, x: 10, y: 10, facing: 0 }, 'none').length, 0, 'refused on land');
  assert.equal(placeActor(doc, CATALOG, { type: 'PT', owner: 0, x: 30, y: 10, facing: 0 }, 'none').length, 1);
  doc.commit();
  // A map that already has a ship ashore: a warning, and the fix puts water under it.
  doc.begin('ashore');
  doc.touchObjects();
  doc.actors.push({ type: 'PT', owner: -1, x: 8, y: 20, facing: 0 });
  doc.commit();
  const map = doc.toMap();
  const r = validateMap(map, { catalog: CATALOG });
  assert.ok(r.warnings.some((w) => w.includes('PT') && w.includes('cannot occupy')), r.warnings.join('; '));
  assert.ok(!r.warnings.some((w) => w.includes('30,10')), 'the gunboat at sea is fine');
  const fix = findFixes(doc, CATALOG).find((f) => f.key.startsWith('actor-ground'));
  assert.equal(fix.fixes[0].label, 'Put water under it');
  doc.begin(fix.fixes[0].label);
  fix.fixes[0].apply(doc);
  doc.commit();
  assert.equal(t(doc, 8, 20), TERRAIN.WATER);
  assert.ok(!findFixes(doc, CATALOG).some((f) => f.key.startsWith('actor-ground')));
});

test('quick fixes: spawn ground, overlapping spawns, foreign owners, actors off the ground; each is one undo step', () => {
  const doc = newDoc(48, 40);
  doc.begin('Problems');
  doc.touchObjects();
  doc.spawns = [[4, 4], [5, 5], [30, 20]];
  for (let x = 30; x < 33; x++) doc.setCell(x, 21, TERRAIN.WATER);
  doc.actors.push({ type: '1TNK', owner: 5, x: 20, y: 20, facing: 0 });
  doc.actors.push({ type: 'SBAG', owner: -1, x: 10, y: 30, facing: 0 });
  doc.actors.push({ type: 'NOPE', owner: -1, x: 1, y: 1, facing: 0 });
  doc.commit();
  doc.begin('Water under the sandbag');
  doc.setCell(10, 30, TERRAIN.WATER);
  doc.commit();
  const fixes = findFixes(doc, CATALOG);
  const keys = fixes.map((f) => f.key).sort();
  assert.deepEqual(keys, ['actor-ground-1', 'actor-owner-0', 'actor-type-2', 'spawn-ground-2', 'spawn-overlap-0-1'].sort());
  const apply = (key, n = 0) => {
    const f = findFixes(doc, CATALOG).find((x) => x.key === key);
    doc.begin(f.fixes[n].label);
    f.fixes[n].apply(doc);
    doc.commit();
  };
  apply('spawn-ground-2');
  assert.equal(t(doc, 31, 21), TERRAIN.CLEAR);
  apply('spawn-overlap-0-1');
  const [x1, y1] = doc.spawns[1];
  assert.ok(Math.abs(x1 - 4) >= 4 || Math.abs(y1 - 4) >= 5, 'moved clear of spawn 1');
  apply('actor-owner-0');
  assert.equal(doc.actors[0].owner, -1);
  apply('actor-ground-1');
  assert.equal(t(doc, 10, 30), TERRAIN.CLEAR);
  apply('actor-type-2');
  assert.equal(doc.actors.length, 2);
  assert.deepEqual(findFixes(doc, CATALOG), []);
  assert.ok(validateMap(doc.toMap(), { catalog: CATALOG }).ok, validateMap(doc.toMap(), { catalog: CATALOG }).errors.join('; '));
  doc.undo();
  assert.equal(doc.actors.length, 3, 'one fix, one undo step');
  assert.equal(nearestYard(doc, CATALOG, 0, 0, -1).length, 2);
});
