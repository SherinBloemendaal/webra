// The map editor on big maps (synthetic maps, no EA files): the work per
// frame and per edit follows what changed, not the size of the map
// (checked by counting reads, not by the clock), and the quicker paths give
// what the plain ones gave: placement checks, quick fixes, the shape
// preview, the cell layer, installed tiles and the saved map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { initSync, Game } from '../pkg/webra_sim.js';
import { MapDoc } from '../editor/js/doc.js';
import { Controller } from '../editor/js/controller.js';
import { TERRAIN, canOccupy, catalogEntry, createMap, footprintOf, groundFor } from '../editor/js/mapformat.js';
import { Occupancy, actorCells, copyRegion, placeActor, placementProblem } from '../editor/js/edits.js';
import { findFixes } from '../editor/js/fixes.js';
import { symmetricPositions } from '../editor/js/symmetry.js';
import { HELP_TEXT } from '../editor/js/commands.js';
import { idleTask } from '../editor/js/idle.js';
import { InstalledTiles, TileWorker, commonTiles, planTiles } from '../editor/js/tiles.js';
import { Minimap } from '../editor/js/preview.js';
import { cellTiles, terrainSeed } from '../js/art/terrain.js';
import { originalTerrain, theaterFiles } from '../js/content/terrain.js';
import { syntheticTheater } from './content-fixtures.mjs';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const CATALOG = Object.fromEntries(JSON.parse(new Game(1, 'allies', 'soviet', 48).rules_json()).actors.map((a) => [a.id, a]));
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** A small random number source (the tests' maps and queries). */
function random(seed) {
  let s = seed >>> 0;
  return (n) => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) % n);
}

/** placementProblem as it was: every check visits every actor. The quicker one must agree with it. */
function plainProblem(doc, catalog, type, x, y, ignore = null) {
  const info = catalogEntry(catalog, type);
  if (!info) return 'unknown actor';
  const occupied = new Set();
  const units = new Set();
  for (const a of doc.actors) {
    if (ignore?.has(a)) continue;
    const ai = catalogEntry(catalog, a.type);
    if (ai?.kind === 'building') {
      for (const [cx, cy, c] of actorCells(a, catalog)) if (c === 1) occupied.add(doc.idx(cx, cy));
    } else {
      units.add(doc.idx(a.x, a.y));
    }
  }
  for (const [dx, dy, c] of footprintOf(info)) {
    const cx = x + dx;
    const cy = y + dy;
    if (!doc.inside(cx, cy)) return 'outside the map';
    const i = doc.idx(cx, cy);
    const t = doc.terrain[i];
    if (c === 3) continue;
    if (!canOccupy(info, c, t)) return groundFor(info) === TERRAIN.WATER ? 'needs water' : info.kind === 'building' && c === 1 ? 'needs clear ground' : 'needs passable ground';
    if (info.kind === 'building' && c === 1) {
      if (occupied.has(i) || units.has(i)) return 'overlaps another actor';
    } else if (occupied.has(i) || (info.kind !== 'building' && units.has(i))) return 'overlaps another actor';
  }
  return null;
}

/** A generated map with `n` actors strewn over it (some overlapping, some on the wrong ground, some unknown). */
function busyMap(size, n, seed = 3) {
  const doc = new MapDoc(JSON.parse(Game.generated_map_with(seed, size, 4, 'lakes', 'temperate', 'extra')));
  const ids = Object.keys(CATALOG).filter((id) => !CATALOG[id].world?.bridge);
  const rnd = random(seed);
  doc.begin('strew');
  doc.touchObjects();
  for (let k = 0; k < n; k++) {
    const type = k % 97 === 0 ? 'NOSUCH' : ids[rnd(ids.length)];
    doc.actors.push({ type: k % 5 === 0 ? type.toLowerCase() : type, owner: rnd(6) - 1, x: rnd(size + 2) - 1, y: rnd(size + 2) - 1, facing: 0 });
  }
  doc.commit();
  return doc;
}

/** Count the reads of `doc.actors` entries (and iterations over it) from now on. */
function countActorReads(doc) {
  const counter = { reads: 0 };
  const list = doc.actors;
  doc.actors = new Proxy(list, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) counter.reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return counter;
}

const VIEW = (w, h, zoom = 0.2) => ({
  camera: { x: 0, y: 0, zoom },
  hover: null,
  viewRect: () => ({ x0: 0, y0: 0, x1: w * 24, y1: h * 24 }),
});
const STATE = () => ({
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
  layers: { grid: true, actors: true, spawns: true },
  region: null,
  clip: null,
  pasteLayers: { terrain: true, resources: true, actors: true },
});

// ---- Placement checks ------------------------------------------------------------------

test('placement checks against an index of who stands where agree with the plain check', () => {
  const doc = busyMap(48, 260);
  const types = [...Object.keys(CATALOG), 'NOSUCH', 'fact', 'e1'];
  const rnd = random(11);
  for (let q = 0; q < 1500; q++) {
    const type = types[rnd(types.length)];
    const x = rnd(52) - 2;
    const y = rnd(52) - 2;
    const ignore = q % 3 === 0 ? new Set(doc.actors.filter(() => rnd(4) === 0)) : null;
    assert.equal(new Occupancy(doc, CATALOG, ignore).problem(type, x, y), plainProblem(doc, CATALOG, type, x, y, ignore), `${type} at ${x},${y}`);
    assert.equal(placementProblem(doc, CATALOG, type, x, y, ignore), plainProblem(doc, CATALOG, type, x, y, ignore));
  }
  // Each actor where it stands, against all the others (one index for all of them).
  const occupancy = new Occupancy(doc, CATALOG);
  for (const a of doc.actors) assert.equal(occupancy.problem(a.type, a.x, a.y, a), plainProblem(doc, CATALOG, a.type, a.x, a.y, new Set([a])));
});

test('actor ids match case-insensitively, also after the catalog gains ids', () => {
  const catalog = { FACT: CATALOG.FACT };
  assert.equal(catalogEntry(catalog, 'fact'), CATALOG.FACT);
  assert.equal(catalogEntry(catalog, 'e1'), undefined);
  catalog.E1 = CATALOG.E1;
  assert.equal(catalogEntry(catalog, 'e1'), CATALOG.E1);
});

test('the frame reads the actors once for refused structures, then not again until the map changes', () => {
  const doc = busyMap(160, 700);
  const view = VIEW(160, 160);
  const ctl = new Controller(doc, view, CATALOG, STATE(), { status() {}, hover() {} });
  const counter = countActorReads(doc);
  const first = ctl.scene();
  const n = doc.actors.length;
  // An index over the actors and one check per structure (each its own footprint): never every actor per structure.
  assert.ok(counter.reads <= 3 * n, `${counter.reads} reads for ${n} actors`);
  counter.reads = 0;
  const again = ctl.scene();
  assert.equal(counter.reads, 0, 'nothing changed: no actor is read again');
  assert.deepEqual(again.rects, first.rects);
  // The red ghosts are the structures the plain check refuses where they stand.
  const refused = doc.actors.filter((a) => catalogEntry(CATALOG, a.type)?.kind === 'building' && plainProblem(doc, CATALOG, a.type, a.x, a.y, new Set([a])));
  assert.deepEqual(ctl.refusedStructures().map(([a]) => a), refused);
  assert.ok(refused.length > 0);
  // A change (here: one actor removed) makes them again.
  doc.begin('remove');
  doc.touchObjects();
  doc.actors = doc.actors.filter((a) => a !== refused[0]);
  doc.commit();
  assert.ok(!ctl.refusedStructures().some(([a]) => a === refused[0]));
});

test('quick fixes check every actor against one index', () => {
  const doc = busyMap(96, 500);
  const counter = countActorReads(doc);
  const fixes = findFixes(doc, CATALOG);
  assert.ok(counter.reads <= 4 * doc.actors.length, `${counter.reads} reads for ${doc.actors.length} actors`);
  // The same problems the plain check finds.
  const plain = new Map();
  doc.actors.forEach((a, i) => {
    if (!CATALOG[a.type] && !catalogEntry(CATALOG, a.type)) return;
    const p = plainProblem(doc, CATALOG, a.type, a.x, a.y, new Set([a]));
    if (p === 'needs clear ground' || p === 'needs passable ground' || p === 'needs water') plain.set(`actor-ground-${i}`, p);
    else if (p === 'overlaps another actor') plain.set(`actor-overlap-${i}`, p);
  });
  const found = fixes.filter((f) => /^actor-(ground|overlap)-/.test(f.key)).map((f) => f.key);
  const offMap = new Set(fixes.filter((f) => f.key.startsWith('actor-out-')).map((f) => f.key.slice('actor-out-'.length)));
  assert.deepEqual(found, [...plain.keys()].filter((k) => !offMap.has(k.split('-').at(-1))));
});

// ---- The shape preview --------------------------------------------------------------------

/** The preview's cells as they were drawn: a rect per cell at each symmetric position, the first one to reach a cell full strength. */
function plainPreview(doc, cells, symmetry) {
  const shade = new Map();
  for (const [cx, cy] of cells) {
    symmetricPositions(symmetry, cx, cy, doc.width, doc.height).forEach((p, n) => {
      const key = p.y * doc.width + p.x;
      if (!doc.inside(p.x, p.y) || shade.has(key)) return;
      shade.set(key, n === 0 ? 'full' : 'faint');
    });
  }
  return shade;
}

/** The cells the preview's rects cover (runs along rows), with full or faint alpha. */
function coveredCells(doc, rects, alpha) {
  const shade = new Map();
  for (let k = 0; k < rects.length; k += 8) {
    const [x, y, w, h, , , , a] = rects.slice(k, k + 8);
    assert.equal(h, 24);
    for (let cx = x / 24; cx < (x + w) / 24; cx++) {
      const key = (y / 24) * doc.width + cx;
      assert.ok(!shade.has(key), 'rects do not overlap');
      shade.set(key, a === Math.fround(alpha) ? 'full' : 'faint');
    }
  }
  return shade;
}

test('the shape preview covers the cells it covered, is made once per corner change and drawn as runs', () => {
  for (const symmetry of ['none', 'quad', 'rotate90', 'eight', 'diagonal']) {
    const doc = new MapDoc(createMap({ width: 120, height: 120 }));
    const state = { ...STATE(), symmetry, tool: 'rect' };
    const ctl = new Controller(doc, VIEW(120, 120), CATALOG, state, { status() {}, hover() {} });
    for (const [tool, fill, from, to] of [
      ['rect', true, [3, 4], [90, 70]],
      ['rect', false, [10, 10], [118, 40]],
      ['ellipse', true, [-5, 20], [60, 130]],
      ['line', true, [2, 100], [110, 3]],
    ]) {
      Object.assign(state, { tool, shapeFill: fill });
      ctl.down({ x: from[0], y: from[1] }, { button: 0 });
      ctl.move({ x: to[0], y: to[1] });
      const g = ctl.gesture;
      const rects = ctl.shapeRects(g, [1, 1, 1, 0.22]);
      assert.deepEqual(coveredCells(doc, rects, 0.22), plainPreview(doc, ctl.shapeCells(tool, ...from, ...to), symmetry), `${tool} ${symmetry}`);
      assert.equal(ctl.shapeRects(g, [1, 1, 1, 0.22]), rects, 'the same rects while nothing changed');
      if (symmetry === 'none' && tool === 'rect' && fill) assert.equal(rects.length / 8, to[1] - from[1] + 1, 'a run per row');
      // In the scene: the preview's floats follow the other rects.
      const scene = ctl.scene();
      assert.deepEqual(Float32Array.from(scene.rects.slice(-rects.length)), rects);
      ctl.cancel();
    }
  }
});

// ---- Snapshots -------------------------------------------------------------------------------

test('the document text is made once per change, read only, and new after every kind of change', () => {
  const doc = new MapDoc(createMap({ width: 40, height: 32 }));
  const a = doc.snapshot();
  assert.equal(doc.snapshot(), a);
  assert.equal(a.json, JSON.stringify(doc.toMap()));
  assert.ok(Object.isFrozen(a.map) && Object.isFrozen(a.map.spawns));
  assert.throws(() => {
    a.map.spawns.push([1, 1]);
  }, TypeError);
  const steps = [
    () => (doc.begin('paint'), doc.setCell(3, 3, TERRAIN.WATER), doc.commit()),
    () => doc.undo(),
    () => doc.redo(),
    () => (doc.begin('meta'), doc.touchMeta(), (doc.meta.name = 'X'), doc.commit()),
    () => (doc.begin('actors'), doc.touchObjects(), doc.actors.push({ type: 'E1', owner: -1, x: 5, y: 5, facing: 0 }), doc.rollback()),
    () => doc.replace(createMap({ width: 50, height: 40 })),
  ];
  let last = a;
  for (const step of steps) {
    step();
    const s = doc.snapshot();
    assert.notEqual(s, last);
    assert.equal(s.json, JSON.stringify(doc.toMap()));
    last = s;
  }
  // Inside a transaction: made afresh (the document is changing).
  doc.begin('open');
  doc.setCell(1, 1, TERRAIN.ROCK);
  assert.notEqual(doc.snapshot(), doc.snapshot());
  assert.equal(doc.snapshot().json, JSON.stringify(doc.toMap()));
  doc.commit();
});

test('a map with rules: the snapshot does not freeze the document\'s own rules', () => {
  const doc = new MapDoc({ ...createMap({ width: 40, height: 32 }), rules: { actors: { E1: { prerequisites: ['tent'] } } } });
  doc.snapshot();
  assert.ok(!Object.isFrozen(doc.rules.actors.E1.prerequisites));
});

// ---- The same results as before -------------------------------------------------------------------

/**
 * Edits through the tools as a player makes them on a generated map, with
 * symmetry, shapes, fills, resources, actors, paste, eraser, a move, undo
 * and redo. Hashes of the result as the editor before these changes made
 * it (its saved terrain, ore, gems, spawns, actors and rules, its quick
 * fixes, and the cell layer of its terrain).
 */
test('edits give the same map, quick fixes and cell layer as before', () => {
  const doc = new MapDoc(JSON.parse(Game.generated_map_with(7, 128, 4, 'lakes', 'temperate', 'extra')));
  const state = { ...STATE(), symmetry: 'quad', autoShore: true };
  const ctl = new Controller(doc, VIEW(128, 128, 0.3), CATALOG, state, { status() {}, hover() {}, selectionChanged() {}, regionChanged() {}, endPaste() {} });
  const drag = (tool, from, to, steps = 6, button = 0, set = {}) => {
    Object.assign(state, { tool }, set);
    ctl.down({ x: from[0], y: from[1] }, { button });
    for (let k = 1; k <= steps; k++) ctl.move({ x: Math.round(from[0] + ((to[0] - from[0]) * k) / steps), y: Math.round(from[1] + ((to[1] - from[1]) * k) / steps) });
    ctl.up({ x: to[0], y: to[1] }, { button });
  };
  drag('brush', [10, 10], [40, 30]);
  drag('line', [5, 60], [60, 5], 8, 0, { size: 5, material: TERRAIN.ROAD });
  drag('rect', [20, 40], [35, 55], 4, 0, { material: TERRAIN.ROCK });
  drag('rect', [42, 40], [52, 58], 4, 0, { shapeFill: false, material: TERRAIN.ROUGH });
  drag('ellipse', [60, 60], [80, 75], 4, 0, { shapeFill: true, material: TERRAIN.WATER });
  drag('fill', [3, 3], [3, 3], 0, 0, { material: TERRAIN.ROUGH, symmetry: 'none' });
  drag('brush', [30, 90], [50, 95], 6, 0, { paint: 'ore', symmetry: 'horizontal' });
  drag('brush', [30, 100], [50, 105], 6, 0, { paint: 'gems' });
  drag('brush', [40, 92], [45, 92], 2, 2, { paint: 'ore' });
  const types = ['1TNK', 'E1', 'POWR', 'SBAG', 'V01', 'HARV', 'GUN'].filter((t) => CATALOG[t]);
  types.forEach((t, k) => drag('actor', [20 + k * 4, 70 + (k % 2) * 3], [20 + k * 4, 70 + (k % 2) * 3], 0, 0, { actorType: t, owner: (k % 3) - 1, facing: k * 128, symmetry: 'quad', paint: 'terrain' }));
  state.clip = copyRegion(doc, CATALOG, 15, 65, 50, 80);
  drag('paste', [90, 20], [90, 20], 0, 0, { symmetry: 'none' });
  drag('eraser', [22, 70], [26, 74], 3, 0, { size: 3 });
  state.symmetry = 'none';
  drag('select', [0, 0], [127, 127], 4);
  const sel = [...ctl.selection].filter((a) => a.type === '1TNK');
  if (sel.length) drag('select', [sel[0].x, sel[0].y], [sel[0].x + 2, sel[0].y + 1], 3);
  doc.undo();
  doc.undo();
  doc.undo();
  doc.redo();
  doc.redo();
  const m = doc.toMap();
  const fixes = findFixes(doc, CATALOG).map((f) => [f.key, f.level, f.message, f.x, f.y, f.fixes.map((x) => x.label)]);
  const types8 = Uint8Array.from(Buffer.from(m.terrain, 'base64'));
  const bytes = new Uint8Array(types8.length * 4);
  types8.forEach((t, i) => ((bytes[i * 4] = t), (bytes[i * 4 + 3] = 255)));
  assert.deepEqual(
    {
      content: sha(JSON.stringify([m.terrain, m.ore, m.gems ?? null, m.spawns, m.actors, m.rules])),
      actors: m.actors.length,
      fixes: sha(JSON.stringify(fixes)),
      nfixes: fixes.length,
      cells: sha(Buffer.from(cellTiles(bytes, m.width, m.height, terrainSeed(bytes)))),
    },
    GOLDEN,
  );
});

// ---- Installed tiles ------------------------------------------------------------------------------

/** Engine terrain bytes of a small coast: water on the left, land with rock and roads on the right. */
function coastBytes(w, h, shift = 0) {
  const b = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      b[i * 4] = x < 12 + shift + ((y * 7) % 5) ? TERRAIN.WATER : (x * 3 + y) % 17 === 0 ? TERRAIN.ROCK : y === 20 ? TERRAIN.ROAD : TERRAIN.CLEAR;
      b[i * 4 + 3] = 255;
    }
  }
  return b;
}

const THEATER = { key: 'test', tileset: 'TEMPERAT', files: syntheticTheater() };

test('installed tiles: nothing until planned, then the plan; changed cells show their type\'s common tile until the next plan', async () => {
  const w = 40;
  const h = 30;
  const jobs = [];
  let readyCalls = 0;
  const tiles = new InstalledTiles({ plan: (job) => (jobs.push(job), Promise.resolve(planTiles(job, job.bytes, job.w, job.h))), ready: () => readyCalls++ });
  const before = coastBytes(w, h);
  assert.equal(tiles.tiles(THEATER, before, w, h), null, 'no plan yet: WebRA tiles meanwhile');
  assert.equal(jobs.length, 1);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(readyCalls, 1);
  const full = originalTerrain((n) => THEATER.files.get(n) ?? null, 'TEMPERAT', before, w, h);
  let got = tiles.tiles(THEATER, before, w, h);
  assert.deepEqual(got.cells, full.cells);
  assert.deepEqual(got.atlas.data, full.atlas.data);
  assert.equal(jobs.length, 1, 'the same terrain: no new plan');
  // Ore only (G) changes no tile and starts no plan.
  const ore = before.slice();
  ore[(5 * w + 30) * 4 + 1] = 200;
  assert.deepEqual(tiles.tiles(THEATER, ore, w, h).cells, full.cells);
  assert.equal(jobs.length, 1);
  // Move the coast: changed cells take their type's common tile at once, a plan starts.
  const after = coastBytes(w, h, 4);
  const atlas = got.atlas;
  got = tiles.tiles(THEATER, after, w, h);
  assert.equal(jobs.length, 2);
  assert.equal(got.atlas, atlas, 'the atlas stays until the next plan');
  const common = commonTiles(Uint8Array.from({ length: w * h }, (_, i) => before[i * 4]), full.cells);
  for (let i = 0; i < w * h; i++) {
    const k = got.cells[i * 4] | (got.cells[i * 4 + 1] << 8);
    if (after[i * 4] === before[i * 4]) assert.equal(k, full.cells[i * 4] | (full.cells[i * 4 + 1] << 8));
    else assert.equal(k, common[after[i * 4]]);
  }
  // A further edit while the plan runs starts nothing new; the plan's result is then patched for it.
  const later = after.slice();
  later[(25 * w + 35) * 4] = TERRAIN.WATER;
  tiles.tiles(THEATER, later, w, h);
  assert.equal(jobs.length, 2);
  await new Promise((r) => setTimeout(r, 0));
  got = tiles.tiles(THEATER, later, w, h);
  assert.equal(jobs.length, 3, 'the next plan for the later edit');
  const planned = originalTerrain((n) => THEATER.files.get(n) ?? null, 'TEMPERAT', after, w, h);
  const i = 25 * w + 35;
  assert.deepEqual([...got.cells.subarray(0, i * 4)], [...planned.cells.subarray(0, i * 4)]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(tiles.tiles(THEATER, later, w, h).cells, originalTerrain((n) => THEATER.files.get(n) ?? null, 'TEMPERAT', later, w, h).cells);
  // Another theater (new art): the old plan is dropped.
  assert.equal(tiles.tiles({ ...THEATER, key: 'other' }, later, w, h), null);
});

test('the tile worker plans exactly what this thread plans, from the theater files only', async () => {
  // originalTerrain reads nothing but theaterFiles.
  const read = new Set();
  const bytes = coastBytes(36, 28);
  originalTerrain((n) => (read.add(n), THEATER.files.get(n) ?? null), 'TEMPERAT', bytes, 36, 28);
  const listed = new Set(theaterFiles('TEMPERAT'));
  for (const n of read) assert.ok(listed.has(n), `${n} is listed`);
  for (const ts of ['SNOW', 'DESERT']) assert.ok(theaterFiles(ts).length > 10);
  assert.deepEqual(theaterFiles('NOPE'), []);

  class NodeTileWorker {
    constructor() {
      this.thread = new ThreadWorker(new URL('./tiles-worker-boot.mjs', import.meta.url));
      this.thread.on('message', (data) => this.onmessage?.({ data }));
      this.thread.on('error', (err) => this.onerror?.({ message: err.message }));
    }
    postMessage(msg, transfer) {
      this.thread.postMessage(msg, transfer);
    }
    terminate() {
      return this.thread.terminate();
    }
  }
  const worker = new TileWorker({ WorkerClass: NodeTileWorker });
  try {
    const job = { ...THEATER, bytes, w: 36, h: 28 };
    const [a, b] = await Promise.all([worker.plan(job), worker.plan({ ...job, bytes: coastBytes(36, 28, 3) })]);
    const here = planTiles(THEATER, bytes, 36, 28);
    assert.deepEqual(a.cells, here.cells);
    assert.deepEqual(a.atlas.data, here.atlas.data);
    assert.equal(a.atlas.flags, here.atlas.flags);
    assert.deepEqual(b.cells, planTiles(THEATER, coastBytes(36, 28, 3), 36, 28).cells);
  } finally {
    worker.dispose();
  }
  // Without workers the plans run here.
  const local = new TileWorker({ WorkerClass: null });
  assert.deepEqual((await local.plan({ ...THEATER, bytes, w: 36, h: 28 })).cells, planTiles(THEATER, bytes, 36, 28).cells);
});

// ---- Work after edits ---------------------------------------------------------------------------------

test('idle tasks run once after a burst of requests, when the browser is idle', () => {
  const timers = [];
  const idles = [];
  const env = {
    setTimeout: (fn, ms) => timers.push({ fn, ms }) - 1,
    clearTimeout: (id) => timers[id] && (timers[id].fn = null),
    requestIdleCallback: (fn, o) => idles.push({ fn, o }) - 1,
    cancelIdleCallback: (id) => idles[id] && (idles[id].fn = null),
  };
  let runs = 0;
  const task = idleTask(() => runs++, { delay: 300, maxWait: 900, env });
  for (let k = 0; k < 5; k++) task.soon();
  assert.equal(timers.filter((t) => t.fn).length, 1, 'one timer for five requests');
  assert.equal(timers.at(-1).ms, 300);
  timers.at(-1).fn();
  assert.equal(runs, 0, 'waits for idle time');
  assert.equal(idles.at(-1).o.timeout, 900);
  assert.ok(task.pending);
  idles.at(-1).fn();
  assert.equal(runs, 1);
  assert.ok(!task.pending);
  task.soon();
  task.flush();
  assert.equal(runs, 2, 'flush runs a requested task now');
  task.flush();
  assert.equal(runs, 2, 'and nothing when none is requested');
  task.soon();
  task.cancel();
  assert.ok(!task.pending);
  // Without requestIdleCallback: straight after the delay.
  const plain = idleTask(() => runs++, { delay: 10, env: { setTimeout: env.setTimeout, clearTimeout: env.clearTimeout } });
  plain.soon();
  timers.at(-1).fn();
  assert.equal(runs, 3);
});

// ---- The minimap -------------------------------------------------------------------------------------

test('the minimap moves the view with any mouse button and follows the drag; no context menu', () => {
  const listeners = {};
  const canvas = {
    width: 200,
    height: 200,
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    setPointerCapture() {},
  };
  const saved = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  try {
    const jumps = [];
    const minimap = new Minimap(canvas, (x, y) => jumps.push([x, y]));
    minimap.doc = { width: 100, height: 100 };
    const fire = (type, e) => {
      let prevented = false;
      for (const fn of listeners[type] ?? []) fn({ preventDefault: () => (prevented = true), ...e });
      return prevented;
    };
    assert.ok(fire('contextmenu', {}), 'no context menu on the minimap');
    assert.ok(fire('mousedown', { button: 1 }), 'no autoscroll for the middle button');
    assert.ok(!fire('mousedown', { button: 2 }));
    for (const button of [0, 2, 1]) {
      jumps.length = 0;
      fire('pointerdown', { button, pointerId: 7, clientX: 50, clientY: 100 });
      assert.deepEqual(jumps, [[25 * 24, 50 * 24]], `button ${button} moves the view there`);
      fire('pointermove', { pointerId: 7, clientX: 100, clientY: 100 });
      assert.deepEqual(jumps.at(-1), [50 * 24, 50 * 24], 'and the drag follows');
      // A second pointer while dragging changes nothing.
      fire('pointerdown', { button: 0, pointerId: 8, clientX: 10, clientY: 10 });
      fire('pointermove', { pointerId: 8, clientX: 10, clientY: 10 });
      assert.equal(jumps.length, 2);
      fire('pointerup', { pointerId: 7 });
      fire('pointermove', { pointerId: 7, clientX: 150, clientY: 150 });
      assert.equal(jumps.length, 2, 'released: the view stays');
    }
    jumps.length = 0;
    fire('pointerdown', { button: 3, pointerId: 9, clientX: 50, clientY: 50 });
    assert.equal(jumps.length, 0, 'the back button does nothing');
    fire('pointerdown', { button: 2, pointerId: 10, clientX: 50, clientY: 50 });
    fire('pointercancel', { pointerId: 10 });
    fire('pointermove', { pointerId: 10, clientX: 150, clientY: 150 });
    assert.equal(jumps.length, 1, 'a cancelled press ends the drag');
  } finally {
    globalThis.document = saved;
  }
  assert.match(HELP_TEXT, /minimap any mouse button \(left, right or middle\) moves the view/);
});

// ---- Placing many actors -------------------------------------------------------------------------------

test('placing with symmetry checks each copy against the copies placed before it', () => {
  const doc = new MapDoc(createMap({ width: 64, height: 64 }));
  doc.begin('place');
  const added = placeActor(doc, CATALOG, { type: 'E1', owner: 0, x: 31, y: 31, facing: 0 }, 'eight');
  doc.commit();
  // The eight copies on a 64 x 64 map: four distinct cells around the centre, each placed once.
  assert.equal(added.length, new Set(symmetricPositions('eight', 31, 31, 64, 64).map((p) => `${p.x},${p.y}`)).size);
  assert.equal(new Set(doc.actors.map((a) => `${a.x},${a.y}`)).size, doc.actors.length, 'no two on one cell');
});

/** Hashes of `edits give the same map...` made with the editor before these changes. */
const GOLDEN = { content: '253ad314fb878a86', actors: 79, fixes: '1db54d35f8cce4b0', nfixes: 47, cells: '83128ac6e6fa71f0' };
