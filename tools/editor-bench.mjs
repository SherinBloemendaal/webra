// Headless benchmark of the map editor on a big map: the real document,
// controller, view, engine preview, checks and installed-tile planning
// (apps/game/editor), driven the way the editor page drives them
// (editor.js: the frame, the checks and the draft save after a burst of
// edits). No browser and no GPU: the renderer is a stub that takes the
// uploads, so this times the main thread's own work per frame and per edit.
// What only a browser shows (GPU time, the DOM of the side panels, layout,
// browser storage) is not measured; the editor page's performance capture
// does that.
//
//   npm run build:wasm
//   node tools/editor-bench.mjs [map.oramap | map.webra-map.json] [--original] [--json]
//
// Without a file it generates a 256 x 256 map with coasts, eight spawns and
// about 800 actors (the size of big community maps). `--original` tiles the
// terrain with the original graphics' rules on a synthetic theater (test
// fixtures, no EA files) in a worker, as the editor does with the original
// graphics installed. Times are milliseconds on this machine's main thread.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const ORIGINAL = args.includes('--original');
const JSON_OUT = args.includes('--json');

const root = new URL('../apps/game/', import.meta.url);
const load = (p) => import(new URL(p, root));
const { initSync, Game, base_rules_json } = await load('pkg/webra_sim.js');
const wasm = initSync({ module: readFileSync(fileURLToPath(new URL('pkg/webra_sim_bg.wasm', root))) });
globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) {
    if (typeof data === 'number') [data, width, height] = [new Uint8ClampedArray(data * width * 4), data, width];
    Object.assign(this, { data, width, height });
  }
};
globalThis.window ??= { addEventListener() {}, devicePixelRatio: 1 };

const { importOramap } = await load('js/oramap/index.js');
const { MapDoc } = await load('editor/js/doc.js');
const { openMapFile } = await load('editor/js/upgrade.js');
const { Controller } = await load('editor/js/controller.js');
const { EditorView } = await load('editor/js/view.js');
const { PreviewWorld } = await load('editor/js/world.js');
const { TERRAIN, createMap, mapFileText, parseMap, validateMap } = await load('editor/js/mapformat.js');
const { Occupancy } = await load('editor/js/edits.js');
const { findFixes } = await load('editor/js/fixes.js');
const { terrainImage } = await load('editor/js/preview.js');
const { InstalledTiles, TileWorker } = await load('editor/js/tiles.js');
const { mapThumbnail } = await load('js/protocol.js');
const { syntheticTheater } = await load('tests/content-fixtures.mjs');

const now = () => performance.now();
const timed = (fn) => {
  const t = now();
  fn();
  return now() - t;
};
const round = (v) => Math.round(v * 100) / 100;
const stats = (xs) => {
  const v = xs.slice().sort((a, b) => a - b);
  return { avg: round(v.reduce((a, b) => a + b, 0) / v.length), p95: round(v[Math.min(v.length - 1, Math.floor(v.length * 0.95))]), max: round(v.at(-1)) };
};

const catalog = Object.fromEntries(JSON.parse(new Game(1, 'allies', 'soviet', 48).rules_json()).actors.map((a) => [a.id, a]));

/** A big map like the community maps people bring: 256 x 256, coasts and lakes, 8 spawns, about 800 actors. */
function syntheticMap() {
  const map = JSON.parse(Game.generated_map_with(7, 256, 8, 'lakes', 'temperate', 'extra'));
  const doc = new MapDoc(map);
  const kinds = Object.values(catalog).filter((a) => a.kind === 'building' && !a.world?.bridge && (a.width ?? 1) <= 3);
  const units = Object.values(catalog).filter((a) => a.kind !== 'building' && !Array.isArray(a.terrain));
  let seed = 12345;
  const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
  doc.begin('Actors');
  doc.touchObjects();
  const occupancy = new Occupancy(doc, catalog);
  for (let tries = 0; doc.actors.length < 800 && tries < 20000; tries++) {
    const pool = tries % 3 === 0 ? kinds : units;
    const info = pool[rnd(pool.length)];
    const a = { type: info.id, owner: rnd(9) - 1, x: rnd(256), y: rnd(256), facing: info.kind === 'building' ? 0 : rnd(32) * 32 };
    if (occupancy.problem(a.type, a.x, a.y)) continue;
    doc.actors.push(a);
    occupancy.add(a);
  }
  doc.commit();
  return doc.toMap();
}

async function openMap() {
  const t = now();
  let map;
  if (!file) map = syntheticMap();
  else if (/\.oramap$/i.test(file)) {
    const res = await importOramap(new Uint8Array(readFileSync(file)), { baseRules: JSON.parse(base_rules_json()), validate: (j) => JSON.parse(Game.validate_map(j)), fileName: file });
    map = res.map;
  } else map = parseMap(readFileSync(file, 'utf8'));
  const opened = openMapFile(map);
  const doc = new MapDoc(opened.map);
  return { doc, ms: now() - t };
}

/** `new Worker(url, { type: 'module' })` with the browser's message API, on worker_threads (tests/tiles-worker-boot.mjs). */
class NodeTileWorker {
  constructor() {
    this.thread = new ThreadWorker(new URL('tests/tiles-worker-boot.mjs', root));
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

const { doc, ms: importMs } = await openMap();
const renderer = { maxTextureSize: 8192, setMapSize() {}, uploadFog() {}, setTerrainAtlas() {}, uploadTerrain() {}, uploadCells() {}, draw() {}, setAtlas() {} };
const canvas = { clientWidth: 1600, clientHeight: 1000, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), classList: { add() {}, remove() {} } };
const state = {
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
  owner: -1,
  facing: 0,
  layers: { grid: true, actors: true, spawns: true, resources: false, passability: false, buildable: false, zones: false, rush: false, reach: false, fog: false },
  region: null,
  clip: null,
  pasteLayers: { terrain: true, resources: true, actors: true },
};
const view = new EditorView(canvas, renderer, {});
const ctl = new Controller(doc, view, catalog, state, { status() {}, hover() {}, selectionChanged() {}, regionChanged() {} });
const preview = new PreviewWorld({ Game, memory: () => wasm.memory });

// Installed tiles (--original): the editor's worker and last-plan-meanwhile scheme (editor/js/tiles.js).
const files = syntheticTheater();
const theater = { key: 'bench', tileset: 'TEMPERAT', files };
const tileWorker = new TileWorker({ WorkerClass: NodeTileWorker });
let planned = null;
const installed = new InstalledTiles({
  plan: (job) => tileWorker.plan(job),
  ready: () => {
    view.terrainDirty = true;
    planned?.();
  },
});
const tilesFor = ORIGINAL ? (bytes) => installed.tiles(theater, bytes, doc.width, doc.height) : () => null;
/** Wait for the tile plan in flight (if any); returns how long it took. */
async function settleTiles() {
  if (!ORIGINAL || !installed.busy) return 0;
  const t = now();
  await new Promise((resolve) => (planned = resolve));
  planned = null;
  return now() - t;
}

// editor.js: the frame, and the checks and the draft after a burst of edits.
let previewDirty = true;
let minimapDirty = true;
let minimapTime = -Infinity;
let checksDue = false;
let draftDue = false;
let clock = 0;
function frame() {
  clock += 1000 / 60;
  if (previewDirty) {
    previewDirty = false;
    preview.update(doc.snapshot().json);
    view.terrainDirty = true;
  }
  if (view.terrainDirty) view.updateTerrain(doc, preview.terrain(), tilesFor);
  const scene = ctl.scene();
  const actors = state.layers.actors ? preview.sprites(view.viewRect()) : new Float32Array(0);
  view.draw({ time: 0 }, actors, scene);
  if (clock - minimapTime > 66) {
    minimapTime = clock;
    if (minimapDirty) {
      terrainImage(doc, catalog);
      minimapDirty = false;
    }
  }
}
doc.onChange((c) => {
  if (c.cells || c.objects || c.resized || c.meta) previewDirty = true;
  if (c.cells || c.objects || c.resized) minimapDirty = true;
  checksDue = true;
  draftDue = true;
});
function checks() {
  const { map, json } = doc.snapshot();
  JSON.parse(Game.validate_map(json));
  validateMap(map, { catalog, rulesBase: null });
  findFixes(doc, catalog);
  mapThumbnail(map);
}
const draft = () => `{"savedAt":${Date.now()},"map":${doc.snapshot().json}}`.length;
async function afterEdits() {
  const out = { checks: 0, draft: 0 };
  if (checksDue) out.checks = round(timed(checks));
  if (draftDue) out.draft = round(timed(draft));
  checksDue = draftDue = false;
  if (ORIGINAL) {
    out.tilesLatency = round(await settleTiles());
    out.tilesFrame = round(timed(frame));
  }
  return out;
}
const tick = () => timed(frame);

const out = { map: file ? file.split('/').pop() : 'synthetic 256x256', size: `${doc.width}x${doc.height}`, actors: doc.actors.length, spawns: doc.spawns.length, original: ORIGINAL };
out[file ? 'import' : 'generate'] = round(importMs);
view.setMap(doc);
view.camera = { x: 0, y: 0, zoom: Math.min(1600 / (doc.width * 24), 1000 / (doc.height * 24)) * 0.95 };
out.firstFrame = round(tick());
out.firstChecks = round(timed(checks));
if (ORIGINAL) {
  out.firstTilesLatency = round(await settleTiles());
  out.firstTilesFrame = round(tick());
}
for (let i = 0; i < 3; i++) tick();
out.idleFit = stats(Array.from({ length: 20 }, tick));
const fit = { ...view.camera };
Object.assign(view.camera, { zoom: 1, x: 2000, y: 2000 });
out.idleZoom1 = stats(Array.from({ length: 20 }, tick));
out.pan = stats(Array.from({ length: 30 }, () => ((view.camera.x += 30), tick())));
Object.assign(view.camera, fit);
out.hover = stats(Array.from({ length: 30 }, (_, i) => timed(() => (ctl.move({ x: 50 + i, y: 60 }), (view.hover = { x: 50 + i, y: 60 }), frame()))));

async function gesture(name, tool, from, to, steps, setup = () => {}) {
  state.tool = tool;
  setup();
  const frames = [timed(() => (ctl.down({ x: from[0], y: from[1] }, { button: 0 }), frame()))];
  for (let k = 1; k <= steps; k++) {
    const x = Math.round(from[0] + ((to[0] - from[0]) * k) / steps);
    const y = Math.round(from[1] + ((to[1] - from[1]) * k) / steps);
    frames.push(timed(() => (ctl.move({ x, y }), (view.hover = { x, y }), frame())));
  }
  // The pointer rests at the end: the preview stays on screen for a few frames.
  for (let k = 0; k < 5; k++) frames.push(tick());
  const commit = timed(() => (ctl.up({ x: to[0], y: to[1] }), frame()));
  out[name] = { drag: stats(frames), commitFrame: round(commit), after: await afterEdits() };
}
await gesture('brush', 'brush', [40, 40], [140, 90], 30);
await gesture('line', 'line', [20, 200], [230, 30], 30, () => (state.size = 3));
await gesture('rect', 'rect', [60, 60], [180, 170], 30);
// With four-way symmetry: a big filled rectangle and a thick line, as maps for several players are made.
await gesture('rectBigQuad', 'rect', [10, 10], [200, 200], 30, () => (state.symmetry = 'quad'));
await gesture('lineQuad', 'line', [30, 220], [220, 40], 30, () => ((state.size = 5), (state.material = TERRAIN.ROAD)));
state.symmetry = 'none';
await gesture('actor', 'actor', [100, 100], [130, 110], 30, () => ((state.actorType = 'E1'), (state.owner = 0)));
for (const k of ['undo', 'redo']) {
  const f = [];
  for (let i = 0; i < 3; i++) f.push(timed(() => (doc[k](), frame())));
  out[k] = { frame: stats(f), after: await afterEdits() };
}
out.save = round(timed(() => (mapFileText(doc.snapshot().map), checks())));
tileWorker.dispose();

if (JSON_OUT) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`${out.map}: ${out.size}, ${out.actors} actors, ${out.spawns} spawns${ORIGINAL ? ', original tiles (synthetic theater, worker)' : ''}`);
  for (const [k, v] of Object.entries(out)) if (!['map', 'size', 'actors', 'spawns', 'original'].includes(k)) console.log(`  ${k.padEnd(18)} ${JSON.stringify(v)}`);
}
