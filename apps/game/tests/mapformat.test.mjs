// Map format 1 (docs/contracts.md section 2): base64 layers, canonical JSON,
// sha256 identity, validation and rules overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LIMITS,
  TERRAIN,
  byteLength,
  canonicalJson,
  createMap,
  decodeBase64,
  decodeLayers,
  encodeBase64,
  isModded,
  mapFileName,
  mapHash,
  parseMap,
  reachableFrom,
  sha256Hex,
  validateMap,
} from '../editor/js/mapformat.js';
import { countOverrides, deepMerge, pruneOverrides, validateOverrides } from '../editor/js/overrides.js';
import { buildRulesBase, OUT as RULES_BASE_PATH } from '../editor/tools/sync-rules-base.mjs';

const RULES_BASE = JSON.parse(readFileSync(RULES_BASE_PATH, 'utf8'));

// A minimal catalog in the shape of the engine's rules_json() actors.
const CATALOG = {
  FACT: {
    kind: 'building',
    width: 3,
    height: 4,
    footprint: [
      [0, 0, 1], [1, 0, 1], [2, 0, 1],
      [0, 1, 1], [1, 1, 1], [2, 1, 1],
      [0, 2, 1], [1, 2, 1], [2, 2, 1],
      [0, 3, 2], [1, 3, 2], [2, 3, 2],
    ],
  },
  SBAG: { kind: 'building', width: 1, height: 1, footprint: [[0, 0, 1]] },
  '1TNK': { kind: 'vehicle', width: 1, height: 1, footprint: null },
};

/** A map with editable layers; `edit(terrain, ore)` mutates them before encoding. */
function makeMap(opts = {}, edit) {
  const map = createMap({ width: 48, height: 48, name: 'Test', author: 'Tester', ...opts });
  if (edit) {
    const { terrain, ore } = decodeLayers(map);
    edit(terrain, ore, map.width);
    map.terrain = encodeBase64(terrain);
    map.ore = encodeBase64(ore);
  }
  return map;
}

// ---- Base64 -------------------------------------------------------------------

test('base64 round-trips every byte value and large layers', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(decodeBase64(encodeBase64(all)), all);
  assert.equal(encodeBase64(new Uint8Array(0)), '');
  assert.deepEqual(decodeBase64(''), new Uint8Array(0));
  const big = Uint8Array.from({ length: 256 * 256 }, (_, i) => (i * 7) % 5);
  assert.deepEqual(decodeBase64(encodeBase64(big)), big);
  // Standard alphabet with padding, matching Buffer.
  const sample = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63]);
  assert.equal(encodeBase64(sample), Buffer.from(sample).toString('base64'));
});

test('base64 rejects malformed input', () => {
  for (const bad of ['abc', 'a=bc', '@@@@', 'YQ', null, 12]) {
    assert.throws(() => decodeBase64(bad), /base64/, String(bad));
  }
});

// ---- Canonical JSON and identity ---------------------------------------------------

test('canonical JSON uses the contract key order and no whitespace', () => {
  const map = makeMap();
  // Shuffle keys and drop the optional ones.
  const shuffled = { rules: undefined, spawns: map.spawns, ore: map.ore, terrain: map.terrain, height: 48, width: 48, author: 'Tester', name: 'Test', format: 1 };
  shuffled.actors = [{ y: 3, facing: 128, x: 2, owner: -1, type: 'SBAG' }];
  const text = canonicalJson(shuffled);
  assert.ok(!/\s/.test(text.replace(/"[^"]*"/g, '""')), 'no whitespace outside strings');
  const keys = Object.keys(JSON.parse(text));
  assert.deepEqual(keys, ['format', 'name', 'author', 'description', 'width', 'height', 'terrain', 'ore', 'spawns', 'actors', 'rules']);
  assert.ok(text.includes('"description":""'));
  assert.ok(text.endsWith('"rules":null}'));
  assert.ok(text.includes('{"type":"SBAG","owner":-1,"x":2,"y":3,"facing":128}'));
});

test('canonical JSON sorts rules keys recursively', () => {
  const map = makeMap();
  map.rules = { weapons: { '25mm': { reload: 10, range: 6000 } }, actors: { E1: { unit: { speed: 70 }, cost: 50 } } };
  const text = canonicalJson(map);
  assert.ok(text.endsWith('"rules":{"actors":{"E1":{"cost":50,"unit":{"speed":70}}},"weapons":{"25mm":{"range":6000,"reload":10}}}}'));
});

test('sha256 matches the standard test vector', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('map hash is the sha256 of the canonical JSON and ignores key order', async () => {
  const map = makeMap();
  const hash = await mapHash(map);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await sha256Hex(canonicalJson(map)));
  const reordered = Object.fromEntries(Object.entries(map).reverse());
  assert.equal(await mapHash(reordered), hash);
  assert.notEqual(await mapHash({ ...map, name: 'Other' }), hash);
});

test('modded means rules is present and not null', () => {
  const map = makeMap();
  assert.equal(isModded(map), false);
  assert.equal(isModded({ ...map, rules: { actors: {} } }), true);
  assert.equal(validateMap({ ...map, rules: { actors: { E1: { cost: 10 } } } }, { rulesBase: RULES_BASE }).modded, true);
});

// ---- Validation -------------------------------------------------------------------

test('a new blank map is valid', () => {
  const r = validateMap(makeMap(), { catalog: CATALOG, rulesBase: RULES_BASE });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.modded, false);
});

test('size, text and format limits', () => {
  const tooSmall = validateMap(makeMap({ width: 31 }));
  assert.ok(tooSmall.errors.some((e) => e.includes('width must be an integer 32..256')));
  assert.ok(validateMap(makeMap({ width: 32, height: 256 })).ok);
  assert.ok(!validateMap({ ...makeMap(), height: 257 }).ok);
  assert.ok(!validateMap({ ...makeMap(), name: '' }).ok);
  assert.ok(!validateMap({ ...makeMap(), name: '   ' }).ok);
  assert.ok(!validateMap({ ...makeMap(), name: 'x'.repeat(65) }).ok);
  assert.ok(validateMap({ ...makeMap(), name: 'x'.repeat(64) }).ok);
  assert.ok(!validateMap({ ...makeMap(), author: 'x'.repeat(65) }).ok);
  assert.ok(!validateMap({ ...makeMap(), description: 'x'.repeat(501) }).ok);
  assert.ok(validateMap({ ...makeMap(), description: 'x'.repeat(500) }).ok);
  assert.ok(!validateMap({ ...makeMap(), format: 2 }).ok);
  assert.ok(validateMap({ ...makeMap(), extra: 1 }).errors.some((e) => e.includes('Unknown field "extra"')));
  assert.ok(!validateMap(null).ok);
});

test('layers must decode to width*height bytes with valid values', () => {
  const map = makeMap();
  assert.ok(validateMap({ ...map, terrain: encodeBase64(new Uint8Array(10)) }).errors.some((e) => e.includes('terrain has 10 bytes')));
  assert.ok(validateMap({ ...map, ore: 'not base64!' }).errors.some((e) => e.includes('ore is not valid base64')));
  const badTerrain = makeMap({}, (t) => (t[5] = 9));
  assert.ok(validateMap(badTerrain).errors.some((e) => e.includes('outside 0..4')));
  const badOre = makeMap({}, (_t, o) => (o[5] = 13));
  assert.ok(validateMap(badOre).errors.some((e) => e.includes('above 12')));
  const oreOnRock = makeMap({}, (t, o) => ((t[5] = TERRAIN.ROCK), (o[5] = 4)));
  const r = validateMap(oreOnRock);
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.includes('impassable')));
});

test('spawn count, bounds and passable ground', () => {
  const map = makeMap();
  assert.ok(!validateMap({ ...map, spawns: [[1, 1]] }).ok);
  const nine = Array.from({ length: 9 }, (_, i) => [i * 5, 1]);
  assert.ok(validateMap({ ...map, spawns: nine }).errors.some((e) => e.includes('2..8 spawns')));
  assert.ok(validateMap({ ...map, spawns: [[1, 1], [48, 2]] }).errors.some((e) => e.includes('outside the map')));
  assert.ok(validateMap({ ...map, spawns: [[1, 1], [2.5, 2]] }).errors.some((e) => e.includes('integers')));
  const onWater = makeMap({}, (t, _o, w) => (t[10 * w + 10] = TERRAIN.WATER));
  onWater.spawns = [[10, 10], [30, 30]];
  const r = validateMap(onWater);
  assert.ok(r.errors.some((e) => e.includes('Spawn 1 at 10,10 is on impassable ground (Water)')));
  assert.deepEqual([r.issues[0].x, r.issues[0].y], [10, 10]);
});

test('spawns must be reachable from each other by ground', () => {
  // A water river splits the map in two.
  const split = makeMap({}, (t, _o, w) => {
    for (let y = 0; y < 48; y++) t[y * w + 24] = TERRAIN.WATER;
  });
  split.spawns = [[4, 4], [40, 40]];
  assert.ok(validateMap(split).errors.some((e) => e.includes('Spawn 2 cannot be reached by ground from spawn 1')));
  // A one-cell rough ford connects them.
  const ford = makeMap({}, (t, _o, w) => {
    for (let y = 0; y < 48; y++) t[y * w + 24] = y === 20 ? TERRAIN.ROUGH : TERRAIN.WATER;
  });
  ford.spawns = [[4, 4], [40, 40]];
  assert.ok(validateMap(ford).ok);
  // Diagonal gaps do not count (4-neighbour, like the engine).
  const { terrain } = decodeLayers(ford);
  const seen = reachableFrom(terrain, 48, 48, 4, 4);
  assert.equal(seen[40 * 48 + 40], 1);
  assert.equal(seen[0 * 48 + 24], 0);
});

test('construction yard fit and overlapping spawns are warnings', () => {
  const map = makeMap({}, (t, _o, w) => (t[11 * w + 11] = TERRAIN.TREE));
  map.spawns = [[10, 10], [12, 12]];
  const r = validateMap(map, { catalog: CATALOG });
  assert.ok(r.ok, r.errors.join('; '));
  assert.ok(r.warnings.some((w) => w.includes('Spawn 1: the construction yard does not fit')));
  assert.ok(r.warnings.some((w) => w.includes('Spawns 1 and 2 overlap')));
});

test('actors: type, owner, facing and footprint checks', () => {
  const map = makeMap();
  const check = (actors) => validateMap({ ...map, actors }, { catalog: CATALOG });
  assert.ok(check([{ type: 'FACT', owner: 0, x: 20, y: 20, facing: 0 }, { type: '1TNK', owner: -1, x: 3, y: 3, facing: 1023 }]).ok);
  assert.ok(check([{ type: 'NOPE', owner: 0, x: 1, y: 1, facing: 0 }]).errors.some((e) => e.includes('unknown actor type')));
  assert.ok(check([{ type: 'SBAG', owner: 2, x: 1, y: 1, facing: 0 }]).errors.some((e) => e.includes('owner must be -1')));
  assert.ok(check([{ type: 'SBAG', owner: -2, x: 1, y: 1, facing: 0 }]).errors.length === 1);
  assert.ok(check([{ type: 'SBAG', owner: 0, x: 1, y: 1, facing: 1024 }]).errors.some((e) => e.includes('facing')));
  assert.ok(check([{ type: 'SBAG', owner: 0, x: 48, y: 1, facing: 0 }]).errors.some((e) => e.includes('outside the map')));
  assert.ok(check([{ type: 'FACT', owner: 0, x: 46, y: 1, facing: 0 }]).errors.some((e) => e.includes('does not fit')));
  assert.ok(check([{ type: 'SBAG', owner: 0, x: 1, y: 1, facing: 0, hp: 5 }]).errors.some((e) => e.includes('unknown field "hp"')));
  assert.ok(!validateMap({ ...map, actors: {} }).ok);
  const onRock = makeMap({}, (t, _o, w) => (t[5 * w + 5] = TERRAIN.ROCK));
  const r = validateMap({ ...onRock, actors: [{ type: 'SBAG', owner: -1, x: 5, y: 5, facing: 0 }] }, { catalog: CATALOG });
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.includes('cannot occupy')));
});

test('the 1 MiB limit applies to the canonical JSON', () => {
  const map = makeMap({ width: 256, height: 256 });
  assert.ok(validateMap(map).ok, 'largest blank map fits');
  const actors = Array.from({ length: 22000 }, (_, i) => ({ type: 'SBAG', owner: -1, x: i % 256, y: (i >> 8) % 256, facing: 0 }));
  const big = { ...map, actors };
  assert.ok(byteLength(canonicalJson(big)) > LIMITS.maxBytes);
  assert.ok(validateMap(big).errors.some((e) => e.includes('the limit is 1024 KiB')));
});

// ---- Rules overrides ---------------------------------------------------------------

test('rules overrides: valid overrides pass', () => {
  const rules = {
    actors: { '1TNK': { cost: 400, unit: { speed: 150 }, turret_turn_speed: 30 }, FACT: { reload_override: 20 } },
    weapons: { '25mm': { range: 6000 } },
  };
  assert.deepEqual(validateOverrides(rules, RULES_BASE), []);
  assert.deepEqual(validateOverrides(null, RULES_BASE), []);
  assert.ok(validateMap({ ...makeMap(), rules }, { rulesBase: RULES_BASE }).ok);
});

test('rules overrides: unknown ids, fields and wrong types are rejected', () => {
  const errs = (rules) => validateOverrides(rules, RULES_BASE);
  assert.match(errs({ actors: { NOPE: { cost: 1 } } })[0], /unknown actor id/);
  assert.match(errs({ weapons: { Laser: { range: 1 } } })[0], /unknown weapon id/);
  assert.match(errs({ actors: { E1: { flying: true } } })[0], /unknown field/);
  assert.match(errs({ actors: { E1: { unit: { warp: 1 } } } })[0], /rules.actors.E1.unit.warp: unknown field/);
  assert.match(errs({ actors: { E1: { cost: '100' } } })[0], /expected a number/);
  assert.match(errs({ actors: { E1: { cost: 1.5 } } })[0], /expected an integer/);
  assert.match(errs({ actors: { E1: { cost: -1 } } })[0], /must not be negative/);
  assert.match(errs({ actors: { E1: { hp: 0 } } })[0], /at least 1/);
  assert.match(errs({ actors: { E1: { id: 'E2' } } })[0], /cannot be overridden/);
  assert.match(errs({ actors: { E1: { unit: 5 } } })[0], /expected an object/);
  assert.match(errs({ weapons: { '25mm': { warheads: [{ damage: 'x' }] } } })[0], /warheads\[0\]\.damage: expected a number/);
  assert.match(errs({ sounds: {} })[0], /unknown section/);
  assert.match(errs([])[0], /expected an object or null/);
  assert.ok(!validateMap({ ...makeMap(), rules: { actors: { NOPE: {} } } }, { rulesBase: RULES_BASE }).ok);
});

test('deep merge recurses into objects and replaces arrays', () => {
  const base = RULES_BASE.actors['1TNK'];
  const merged = deepMerge(base, { cost: 400, unit: { speed: 150 }, weapons: [] });
  assert.equal(merged.cost, 400);
  assert.equal(merged.unit.speed, 150);
  assert.equal(merged.unit.turn_speed, base.unit.turn_speed);
  assert.deepEqual(merged.weapons, []);
  assert.notEqual(base.cost, 400, 'base not mutated');
});

test('prune and count overrides', () => {
  assert.equal(pruneOverrides({ actors: { E1: {} }, weapons: {} }), null);
  assert.deepEqual(pruneOverrides({ actors: { E1: { cost: 5 }, E2: {} } }), { actors: { E1: { cost: 5 } } });
  assert.equal(countOverrides({ actors: { E1: { cost: 5, hp: 3 } }, weapons: { '25mm': { range: 1 } } }), 3);
  assert.equal(countOverrides(null), 0);
});

test('rules-base.json is in sync with engine/rules.json', () => {
  const engineRules = readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8');
  assert.equal(readFileSync(RULES_BASE_PATH, 'utf8'), buildRulesBase(engineRules), 'run node apps/game/editor/tools/sync-rules-base.mjs');
});

// ---- Helpers ------------------------------------------------------------------------

test('parseMap and file names', () => {
  assert.throws(() => parseMap('{'), /Not valid JSON/);
  assert.throws(() => parseMap('[1]'), /map object/);
  assert.equal(parseMap('{"format":1}').format, 1);
  assert.equal(mapFileName('Twin Rivers!'), 'twin-rivers.webra-map.json');
  assert.equal(mapFileName(''), 'map.webra-map.json');
});
