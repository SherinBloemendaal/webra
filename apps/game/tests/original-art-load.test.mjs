// Original art through the client's own loading path: synthetic original
// graphics (original-fixtures.mjs) in the content store, read by the
// ContentSystem (js/content/index.js), turned into slots (content/atlas.js)
// and packed by js/sprites.js buildAtlas, as main.js applyArt does. Every
// kind of actor must then be drawn with the original art, and a missing or
// broken file must only cost its own sprites, never the whole atlas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContentSystem, GRAPHICS_SETTING } from '../js/content/index.js';
import { MemoryStore } from '../js/content/store.js';
import { artProblem } from '../js/content/atlas.js';
import { POSE, POSE_COUNT } from '../js/content/sequences.js';
import { buildAtlas, FRAME_FLOATS } from '../js/sprites.js';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { pixelDocument } from './content-fixtures.mjs';
import { syntheticFiles } from './original-fixtures.mjs';
import init, { Game } from '../pkg/webra_sim.js';

await init({ module_or_path: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const RULES = JSON.parse(new Game(7, 'england', 'russia', 64).rules_json());
// What main.js draws with: mission actors may name the art they use.
const ART_ACTORS = RULES.actors.map((a) => (a.art ? { ...a, id: a.art } : a));
const slotOf = (id) => 2 * ART_ACTORS.findIndex((a) => a.id === id);

/** Representative actors of every kind, per biome (bridges and trees are the theater's). */
const REPRESENTATIVE = {
  infantry: ['E1', 'E3', 'E6', 'E7', 'DOG', 'SPY'],
  vehicle: ['1TNK', '2TNK', 'HARV', 'MCV', 'V2RL', 'JEEP'],
  building: ['FACT', 'POWR', 'WEAP', 'MSLO', 'TSLA', 'SBAG', 'V01'],
  ship: ['DD', 'LST', 'SS'],
  helicopter: ['HELI', 'HIND', 'TRAN'],
  plane: ['MIG', 'YAK'],
  husk: ['2TNK.Husk', 'HARV.EmptyHusk'],
  crate: ['CRATE'],
  mine: ['MINV'],
};
const THEATER = {
  temperate: ['BRIDGE1', 'BR1', 'T01'],
  snow: ['BRIDGE1', 'BR1', 'T01'],
  desert: [],
};

async function contentWith(files) {
  const store = new MemoryStore();
  await store.putAll([...files].map(([name, bytes]) => ({ name, bytes: bytes.slice().buffer, size: bytes.length })));
  const registry = createRegistry({ storage: null });
  const settings = createSettings(registry);
  settings.set(GRAPHICS_SETTING, 'original');
  const content = new ContentSystem({ settings, registry, open: async () => store });
  await content.load();
  return content;
}

/** main.js applyArt: the art, then the atlas (null when it does not build, which drops every original sprite). */
function applyArt(content, biome) {
  const art = content.art(ART_ACTORS, biome);
  globalThis.document = pixelDocument();
  try {
    return { art, atlas: buildAtlas(ART_ACTORS, { slots: art.slots, layers: art.layers, filter: art.filter, maxSize: 8192, biome }) };
  } catch (err) {
    return { art, atlas: null, error: err };
  } finally {
    delete globalThis.document;
  }
}

/** The atlas draws slot `k` with a pose table (original or pack art), not a WebRA sprite. */
function posed(atlas, k) {
  return atlas.frames[k * FRAME_FLOATS + 13] === POSE_COUNT;
}

test('a full original content set draws every kind of actor with the original art', async () => {
  const content = await contentWith(syntheticFiles().files);
  assert.ok(content.originalActive);
  for (const biome of ['temperate', 'snow', 'desert']) {
    const { art, atlas, error } = applyArt(content, biome);
    assert.ok(atlas, `${biome}: the atlas builds (${error?.message})`);
    assert.deepEqual(art.report.problems, [], `${biome}: no problems`);
    for (const id of [...Object.values(REPRESENTATIVE).flat(), ...THEATER[biome]]) {
      const k = slotOf(id);
      assert.ok(k >= 0, `${id} is an actor`);
      assert.equal(art.source.get(k), 'original', `${biome}: ${id} uses the original art`);
      assert.ok(posed(atlas, k), `${biome}: ${id} is drawn from its pose table`);
      assert.ok(art.original.slots.includes(k), `${biome}: the engine is told ${id} is original`);
    }
  }
});

test('every pose table of the original art is complete (no pose the atlas cannot read)', async () => {
  const content = await contentWith(syntheticFiles().files);
  for (const biome of ['temperate', 'snow', 'desert']) {
    const { art } = applyArt(content, biome);
    for (const [k, a] of art.slots) assert.equal(artProblem(a), null, `${biome}: slot ${k}`);
  }
});

test('missing files only cost their own sprites', async () => {
  const files = syntheticFiles().files;
  // The rifleman's sprites, a bridge's damaged state, the mouse cursors.
  for (const name of ['e1.shp', 'bridge1h.tem', 'mouse.shp']) assert.ok(files.delete(name), name);
  const content = await contentWith(files);
  const { art, atlas, error } = applyArt(content, 'temperate');
  assert.ok(atlas, `the atlas builds (${error?.message})`);
  assert.notEqual(art.source.get(slotOf('E1')), 'original', 'the rifleman keeps WebRA art');
  assert.ok(art.report.fallback.includes('E1'));
  for (const id of ['E3', '1TNK', 'POWR', 'HELI', 'MIG', 'DD', 'BRIDGE1']) {
    assert.equal(art.source.get(slotOf(id)), 'original', `${id} keeps the original art`);
    assert.ok(posed(atlas, slotOf(id)), id);
  }
  // The bridge without its damaged template shows the healthy one when damaged.
  const bridge = art.slots.get(slotOf('BRIDGE1'));
  assert.equal(bridge.poses[POSE.DAMAGED].frames[0], bridge.poses[POSE.IDLE].frames[0]);
});

test('a broken pose table is refused on its own', () => {
  const still = { frames: [0], length: 1, facings: 1, fps: 1, mode: 0 };
  const good = { images: [{}], poses: new Array(POSE_COUNT).fill(still) };
  assert.equal(artProblem(good), null);
  assert.equal(artProblem(null), null);
  const holes = { images: [{}], poses: new Array(POSE_COUNT).fill(still) };
  holes.poses[POSE.DIE1] = undefined;
  assert.match(artProblem(holes), /pose 18 is missing/);
  assert.match(artProblem({ images: [{}], poses: [still] }), /1 poses instead of/);
  const outside = { images: [{}], poses: new Array(POSE_COUNT).fill({ ...still, frames: [3] }) };
  assert.match(artProblem(outside), /names an image/);
});
