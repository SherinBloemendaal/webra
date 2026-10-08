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
  '1TNK': { kind: 'vehicle', width: 1, height: 1, footprint: null },
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
