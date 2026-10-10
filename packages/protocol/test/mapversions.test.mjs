import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  addField,
  renameRuleFields,
  applyMapFix,
  canonicalMapJson,
  getPath,
  decodeBase64,
  encodeBase64,
  GAME_VERSION,
  MAP_FORMAT_HISTORY,
  MAP_FORMAT_VERSION,
  MAP_MIGRATIONS,
  MAP_UPGRADED_NOTICE,
  MAP_VERSIONS,
  mapFileJson,
  mapHash,
  moveField,
  parseMap,
  renameActors,
  salvageMap,
  setPath,
  validateRules,
  upgradeMap,
  validateMap,
} from '../src/index.js';

import { testVersions, v1Map } from './fixtures/map-test-versions.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ENGINE_RULES = JSON.parse(read('../../../engine/rules.json'));
const FIXTURES = new URL('./fixtures/maps/', import.meta.url);
const sha = (s) => createHash('sha256').update(s).digest('hex');

// ---- The registry and the rules for bumping it (CI) ----------------------------------

/** Fixture pairs: `format<N>-<name>.webra-map.json` and `format<N>-<name>.expected.json`. */
function fixtures() {
  const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.webra-map.json'));
  return names.map((f) => {
    const m = /^format(\d+)-[a-z0-9-]+\.webra-map\.json$/.exec(f);
    assert.ok(m, `fixture ${f} is named format<N>-<name>.webra-map.json`);
    const base = f.replace(/\.webra-map\.json$/, '');
    return { file: f, version: Number(m[1]), text: readFileSync(new URL(f, FIXTURES), 'utf8'), expected: JSON.parse(readFileSync(new URL(`${base}.expected.json`, FIXTURES), 'utf8')) };
  });
}

test('every format version has its history entry, its migration and a fixture (a format bump needs all three)', () => {
  assert.equal(MAP_VERSIONS.current, MAP_FORMAT_VERSION);
  assert.deepEqual(
    MAP_FORMAT_HISTORY.map((h) => h.version),
    Array.from({ length: MAP_FORMAT_VERSION }, (_, i) => i + 1),
    'MAP_FORMAT_HISTORY lists versions 1..current in order',
  );
  for (const h of MAP_FORMAT_HISTORY) {
    assert.equal(typeof h.summary, 'string');
    if (h.version < MAP_FORMAT_VERSION) assert.match(String(h.lastGame), /^\d+\.\d+$/, `format ${h.version} names the last release that wrote it`);
    else assert.equal(h.lastGame, null, 'the current format is still written');
  }
  assert.equal(MAP_MIGRATIONS.length, MAP_FORMAT_VERSION - 1, 'one migration per version step');
  for (let v = 1; v < MAP_FORMAT_VERSION; v++) {
    const steps = MAP_MIGRATIONS.filter((m) => m.from === v);
    assert.equal(steps.length, 1, `exactly one migration from format ${v}`);
    assert.equal(steps[0].to, v + 1);
    assert.equal(typeof steps[0].migrate, 'function');
    assert.equal(typeof steps[0].summary, 'string');
  }
  const all = fixtures();
  for (let v = 1; v <= MAP_FORMAT_VERSION; v++) {
    const mine = all.filter((f) => f.version === v);
    assert.ok(mine.length > 0, `a fixture of format ${v} (test/fixtures/maps/format${v}-*.webra-map.json)`);
    const want = v === MAP_FORMAT_VERSION ? 'current' : 'upgraded';
    assert.ok(
      mine.some((f) => f.expected.status === want),
      `a format ${v} fixture that ends ${want}`,
    );
  }
});

test('the engine reads the same format version, and every version number agrees with the release', () => {
  const mapdata = read('../../../engine/src/mapdata.rs');
  assert.equal(Number(/pub const FORMAT_VERSION: u32 = (\d+);/.exec(mapdata)?.[1]), MAP_FORMAT_VERSION, 'engine/src/mapdata.rs FORMAT_VERSION');
  assert.equal(GAME_VERSION, JSON.parse(read('../../../package.json')).version, 'version.js follows package.json');
  assert.equal(GAME_VERSION, /^version = "([^"]+)"/m.exec(read('../../../engine/Cargo.toml'))?.[1], 'and engine/Cargo.toml');
  const config = JSON.parse(read('../../../release-please-config.json'));
  assert.ok(
    config.packages['.']['extra-files'].some((f) => f.type === 'generic' && f.path === 'packages/protocol/src/version.js'),
    'release-please updates version.js',
  );
  assert.match(read('../src/version.js'), /GAME_VERSION = '[^']+'; \/\/ x-release-please-version/);
});

test('fixtures: every old file upgrades to exactly its expected map, every current file stays as it is', async () => {
  for (const f of fixtures()) {
    const r = parseMap(f.text, { rules: ENGINE_RULES });
    if (f.expected.status === 'incompatible' || f.expected.status === 'newer') {
      assert.equal(r.ok, false, f.file);
      assert.equal(r.compat.status, f.expected.status, f.file);
      continue;
    }
    assert.ok(r.ok, `${f.file}: ${r.errors.join('; ')}`);
    assert.equal(r.upgrade?.from ?? f.version, f.expected.from, f.file);
    assert.equal(r.upgrade === null ? 'current' : 'upgraded', f.expected.status, f.file);
    assert.equal(r.canonical, f.expected.canonical, `${f.file}: canonical form`);
    assert.equal(await mapHash(r.map), f.expected.hash, `${f.file}: hash`);
    assert.equal(sha(r.canonical), f.expected.hash);
  }
});

test('format 1 baseline: unversioned files keep their identity, and writing the version does not change it', async () => {
  const legacy = JSON.parse(read('./fixtures/maps/format1-legacy.webra-map.json'));
  const file = read('./fixtures/maps/format1-file.webra-map.json').trim();
  assert.equal(legacy.formatVersion, undefined, 'the legacy fixture is a map from before versions');
  const a = validateMap(legacy, { rules: ENGINE_RULES });
  const b = parseMap(file, { rules: ENGINE_RULES });
  assert.ok(a.ok && b.ok);
  assert.equal(a.canonical, b.canonical);
  assert.equal(a.upgrade, null, 'format 1 is the current format: no upgrade, no notice');
  assert.equal(a.writtenBy, null);
  assert.equal(b.writtenBy, '0.9.0');
  assert.ok(!a.canonical.includes('formatVersion') && !a.canonical.includes('gameVersion'), 'format 1 canonical form names neither');
  // The file form: version header first, then exactly the canonical body.
  assert.equal(mapFileJson(a.map, { gameVersion: '0.9.0' }), file);
  assert.ok(mapFileJson(a.map).startsWith(`{"formatVersion":1,"gameVersion":"${GAME_VERSION}","format":2,`));
  assert.equal(JSON.stringify(JSON.parse(file)), file, 'compact JSON');
  // Another release writing the same map: same identity.
  const other = parseMap(mapFileJson(a.map, { gameVersion: '7.1.0-beta.2' }));
  assert.equal(await mapHash(other.map), await mapHash(a.map));
});

test('format version and game version are checked strictly', () => {
  const legacy = JSON.parse(read('./fixtures/maps/format1-legacy.webra-map.json'));
  for (const formatVersion of [0, -1, 1.5, '1', null, 65536]) {
    const r = validateMap({ ...legacy, formatVersion });
    assert.equal(r.ok, false, `formatVersion ${JSON.stringify(formatVersion)}`);
    assert.match(r.errors[0], /formatVersion must be a whole number/);
    assert.equal(r.compat, null);
  }
  for (const gameVersion of ['', 'a b', 'x'.repeat(33), 9]) {
    const r = validateMap({ ...legacy, gameVersion });
    assert.equal(r.ok, false, `gameVersion ${JSON.stringify(gameVersion)}`);
    assert.match(r.errors[0], /gameVersion must be a version/);
  }
  assert.ok(validateMap({ ...legacy, formatVersion: 1, gameVersion: '0.9.0+abcdef12' }).ok);
  assert.ok(validateMap({ ...legacy, gameVersion: null }).ok, 'null counts as absent, as in the engine');
});

test('a map from a newer format is refused with the update message, everywhere the same', () => {
  const legacy = JSON.parse(read('./fixtures/maps/format1-legacy.webra-map.json'));
  const r = validateMap({ ...legacy, formatVersion: MAP_FORMAT_VERSION + 1, gameVersion: '12.3.4', futureField: true });
  assert.equal(r.ok, false);
  assert.equal(r.compat.status, 'newer');
  assert.equal(
    r.errors[0],
    `This map was made with a newer version of WebRA (12.3, format ${MAP_FORMAT_VERSION + 1}; this version reads format ${MAP_FORMAT_VERSION}). Update the game to play it.`,
  );
  const bare = upgradeMap({ ...legacy, formatVersion: MAP_FORMAT_VERSION + 1 });
  assert.match(bare.message, /^This map was made with a newer version of WebRA \(format \d+;/);
  assert.equal(bare.map, null);
});

test('replays and saves keep the map as played: no upgrade', () => {
  const v = testVersions();
  const r = validateMap(v1Map(), { versions: v, upgrade: false });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /the map is in format 1; this version plays format 3 only/);
});

// ---- Migrations (a test registry: format 3 with two steps) ------------------------------

test('an upgradable map runs every step in order and becomes the current format', async () => {
  const versions = testVersions();
  const input = v1Map({}, { 40: 9, 41: 9 });
  const before = JSON.stringify(input);
  const up = upgradeMap(input, versions);
  assert.equal(JSON.stringify(input), before, 'the input is not changed');
  assert.equal(up.status, 'upgraded');
  assert.equal(up.ok, true);
  assert.equal(up.from, 1);
  assert.equal(up.to, 3);
  assert.equal(up.message, MAP_UPGRADED_NOTICE);
  assert.deepEqual(up.notes, [
    'Renamed 1 actor from oldtree to T01.',
    'Changed 2 cells of river to rock.',
    'Moved rules.actors.E1.unit.spd to rules.actors.E1.unit.speed.',
    'Moved notes to description.',
    'Changed biome from arctic to snow.',
  ]);
  assert.equal(up.map.formatVersion, 3);
  assert.equal(up.map.actors[0].type, 'T01');
  assert.deepEqual(up.map.rules, { actors: { E1: { unit: { speed: 5 } } } });
  assert.equal(up.map.description, 'from the notes field');
  assert.equal(up.map.notes, undefined);
  assert.equal(up.map.biome, 'snow');
  assert.equal(decodeBase64(up.map.terrain, 't')[40], 2);
  // Deterministic: the same file gives the same map, byte for byte.
  assert.equal(JSON.stringify(upgradeMap(JSON.parse(before), versions).map), JSON.stringify(up.map));

  const r = validateMap(input, { versions });
  assert.ok(r.ok, r.errors.join('; '));
  assert.deepEqual(r.upgrade, { from: 1, to: 3, notes: up.notes, message: MAP_UPGRADED_NOTICE });
  assert.ok(r.canonical.startsWith('{"formatVersion":3,"format":1,"name":"Old"'), 'a format above 1 is part of the identity');
  assert.equal(await mapHash(r.map), sha(r.canonical));
  // Upgrading the upgraded map changes nothing (a file saved after the upgrade).
  const again = parseMap(mapFileJson(r.map), { versions });
  assert.equal(again.upgrade, null);
  assert.equal(again.canonical, r.canonical);
  // A format 2 file only runs the second step.
  const v2 = upgradeMap({ ...up.map, formatVersion: 2, notes: 'x', description: undefined }, versions);
  assert.deepEqual(v2.notes, ['Moved notes to description.']);
});

test('a map that cannot be upgraded automatically names its release and lists located problems with quick fixes', () => {
  const versions = testVersions();
  const input = v1Map(
    {
      gameVersion: '0.8.3',
      actors: [
        { type: 'GONE', owner: -1, x: 3, y: 9 },
        { type: 'MIX', owner: -1, x: 4, y: 9 },
        { type: 'MIX', owner: 0, x: 6, y: 9 },
      ],
      rules: { actors: { E1: { oldfield: 1 }, GONE: { cost: 5 } } },
      biome: 'lava',
    },
    { 70: 7 },
  );
  const r = validateMap(input, { versions });
  assert.equal(r.ok, false);
  assert.equal(
    r.errors[0],
    'This map was made for WebRA 0.8 (format 1) and is no longer compatible with this version. Open it in the map editor and save it again.',
  );
  assert.equal(r.compat.status, 'incompatible');
  const byCode = Object.fromEntries(r.compat.problems.map((p) => [p.code, p]));
  assert.deepEqual(Object.keys(byCode).sort(), ['actor-removed', 'actor-split', 'rules-field-removed', 'rules-removed', 'terrain-changed', 'value-removed']);
  assert.equal(byCode['actor-removed'].message, '1 GONE actor: GONE was removed in format 2.');
  assert.deepEqual([byCode['actor-removed'].x, byCode['actor-removed'].y], [3, 9]);
  assert.match(byCode['actor-split'].message, /^2 MIX actors: MIX was replaced by A1 or A2 in format 2; pick one\.$/);
  assert.deepEqual(byCode['actor-split'].at, [[4, 9], [6, 9]]);
  assert.deepEqual(byCode['actor-split'].fixes.map((f) => f.label), ['Replace with A1', 'Replace with A2', 'Remove all 2']);
  assert.deepEqual([byCode['terrain-changed'].x, byCode['terrain-changed'].y], [6, 2]);
  assert.match(byCode['terrain-changed'].message, /^1 cell of bridge: bridges are actors now\. They are clear now; check them\.$/);
  assert.deepEqual(byCode['terrain-changed'].fixes.map((f) => f.label), ['Keep clear', 'Use road']);
  assert.deepEqual(byCode['rules-field-removed'].path, ['rules', 'actors', 'E1', 'oldfield']);
  assert.equal(byCode['value-removed'].version, 3, 'problems name the version step that met them');

  // Without a gameVersion the history names the release; quick fixes make it valid.
  const plain = upgradeMap({ ...input, gameVersion: undefined }, versions);
  assert.match(plain.message, /^This map was made for WebRA 0\.9 \(format 1\)/);
  let map = plain.map;
  for (const code of ['actor-removed', 'actor-split', 'terrain-changed', 'rules-field-removed', 'rules-removed', 'value-removed']) {
    const p = plain.problems.find((x) => x.code === code);
    map = applyMapFix(map, p.fixes[code === 'terrain-changed' ? 1 : 0].action);
  }
  assert.deepEqual(
    map.actors.map((a) => a.type),
    ['A1', 'A1'],
    'GONE removed, both MIX became A1',
  );
  assert.equal(decodeBase64(map.terrain, 't')[70], 6);
  assert.equal(map.rules, undefined, 'dropped overrides leave no empty objects behind');
  assert.equal(map.biome, 'temperate');
  const fixed = validateMap(map, { versions });
  assert.ok(fixed.ok, fixed.errors.join('; '));
  assert.equal(fixed.upgrade, null, 'the repaired map is current');
});

test('an upgraded map that the validator refuses counts as incompatible, not as a broken file', () => {
  // Remapping to terrain 2 under ore: the old map was fine, the new format is not.
  const versions = testVersions();
  const w = 32;
  const ore = new Uint8Array(w * w);
  ore[40] = 5;
  const r = validateMap(v1Map({ ore: encodeBase64(ore) }, { 40: 9 }), { versions });
  assert.equal(r.ok, false);
  assert.equal(r.compat.status, 'incompatible');
  assert.match(r.errors[0], /^This map was made for WebRA 0\.9 \(format 1\) and is no longer compatible/);
  assert.match(r.errors[1], /ore can only lie/);
  // The same mistake in a current map is just an invalid map.
  const current = validateMap({ ...upgradeMap(v1Map({}, { 40: 9 }), versions).map, ore: encodeBase64(ore) }, { versions });
  assert.equal(current.compat, null);
  assert.match(current.errors[0], /ore can only lie/);
});

test('rules overrides follow renamed actors; two overrides of one actor need the author', () => {
  const ctx = { version: 2, notes: [], problems: [], note(t) { this.notes.push(t); }, problem(p) { this.problems.push(p); } };
  const map = { actors: [], rules: { actors: { oldtree: { cost: 1 }, E1: { cost: 2 } } } };
  renameActors(map, { OLDTREE: 'T01' }, ctx);
  assert.deepEqual(Object.keys(map.rules.actors), ['T01', 'E1']);
  assert.deepEqual(ctx.notes, ['Moved the rules override of oldtree to T01.']);
  const clash = { actors: [], rules: { actors: { OLDTREE: { cost: 1 }, t01: { cost: 2 } } } };
  renameActors(clash, { OLDTREE: 'T01' }, ctx);
  assert.equal(ctx.problems[0].code, 'rules-conflict');
  const keepOld = applyMapFix(clash, ctx.problems[0].fixes[0].action);
  assert.deepEqual(keepOld.rules.actors, { t01: { cost: 1 } });
  const keepNew = applyMapFix(clash, ctx.problems[0].fixes[1].action);
  assert.deepEqual(keepNew.rules.actors, { t01: { cost: 2 } });
});

test('a moved field that is set twice is left to the author; added fields keep a value the map has', () => {
  const ctx = { version: 3, notes: [], problems: [], note(t) { this.notes.push(t); }, problem(p) { this.problems.push(p); } };
  const map = { notes: 'a', description: 'b', biome: 'desert' };
  moveField(map, ['notes'], ['description'], ctx);
  addField(map, ['biome'], 'temperate', ctx);
  assert.equal(map.biome, 'desert');
  assert.equal(ctx.problems[0].code, 'field-conflict');
  assert.deepEqual(applyMapFix(map, ctx.problems[0].fixes[0].action), { description: 'a', biome: 'desert' });
  assert.deepEqual(applyMapFix(map, ctx.problems[0].fixes[1].action), { description: 'b', biome: 'desert' });
  const same = { notes: 'a', description: 'a' };
  moveField(same, ['notes'], ['description'], ctx);
  assert.deepEqual(same, { description: 'a' }, 'equal values are no conflict');
});

test('a gap in the migration chain is a programming error, never blamed on the file', () => {
  const versions = testVersions();
  versions.migrations = versions.migrations.slice(1);
  assert.throws(() => upgradeMap(v1Map(), versions), /no map migration from format 1 to 2/);
});

// ---- Best effort for the map editor ---------------------------------------------------------

test('salvageMap opens what it can of a broken or incompatible map and lists every repair', () => {
  const versions = testVersions();
  const w = 32;
  const r = salvageMap(
    {
      ...v1Map({ actors: [{ type: 'GONE', owner: -1, x: 3, y: 9 }, { type: 'E1', owner: 7, x: 5, y: 5 }, { type: 'E1', x: 99, y: 1 }, 'junk'] }),
      terrain: encodeBase64(new Uint8Array(w * 16).fill(1)),
      ore: 'not base64!',
      spawns: [[2, 2], [40, 40], 'x'],
      extra: 1,
      name: '',
    },
    { versions },
  );
  assert.equal(r.status, 'incompatible');
  assert.equal(r.problems[0].code, 'actor-removed', 'the upgrade problems come first, with their fixes');
  const messages = r.problems.filter((p) => p.code === 'repaired').map((p) => p.message);
  assert.deepEqual(messages, [
    'Unknown field "extra" was left out.',
    'name must be 1 to 64 characters; replaced with "Untitled".',
    'The terrain layer had 512 cells for a 32 x 32 map; it was cut or filled to fit.',
    'The ore layer could not be read; it was rebuilt empty.',
    'Spawn 2 is not a cell of the map; it was left out.',
    'Spawn 3 is not a cell of the map; it was left out.',
    'Actor 2 (E1) had owner 7; it is neutral now.',
    'Actor 3 is malformed or off the map; it was left out.',
    'Actor 4 is malformed or off the map; it was left out.',
  ]);
  assert.equal(r.map.formatVersion, 3);
  assert.equal(decodeBase64(r.map.terrain, 't').length, w * w);
  assert.equal(decodeBase64(r.map.terrain, 't')[w * 15], 1, 'rows that were there keep their cells');
  assert.equal(decodeBase64(r.map.terrain, 't')[w * 16], 0);
  assert.deepEqual(r.map.spawns, [[2, 2]]);
  assert.deepEqual(r.map.actors.map((a) => [a.type, a.owner]), [['GONE', -1], ['E1', -1]]);
  // A newer map: the fields this version knows, and the reason.
  const newer = salvageMap({ ...v1Map(), formatVersion: 9, hovercraft: true }, { versions });
  assert.equal(newer.status, 'newer');
  assert.match(newer.problems[0].message, /newer version of WebRA.*Fields this version does not know are left out\./);
  assert.ok(newer.problems.some((p) => p.message === 'Unknown field "hovercraft" was left out.'));
  assert.equal(salvageMap('nope'), null);
  // A current, valid map comes through unchanged.
  const legacy = JSON.parse(read('./fixtures/maps/format1-legacy.webra-map.json'));
  const ok = salvageMap(legacy);
  assert.deepEqual(ok.problems, []);
  assert.equal(canonicalMapJson(ok.map), validateMap(legacy).canonical);
});

// ---- Reserved keys (no prototype pollution) ------------------------------------------------

test('reserved keys never reach a migration, a path or a quick fix', () => {
  const versions = testVersions();
  const polluted = () => ({}).polluted !== undefined || Object.prototype.polluted !== undefined;
  // In the file: refused before any migration runs, wherever it is.
  for (const raw of [
    '{"format":1,"__proto__":{"polluted":1}}',
    JSON.stringify(v1Map()).replace('"spd":5', '"spd":5,"__proto__":{"polluted":1}'),
    JSON.stringify(v1Map({ rules: { actors: { constructor: { cost: 1 } } } })),
    JSON.stringify(v1Map({ notes: undefined, prototype: 1 })),
  ]) {
    const r = upgradeMap(JSON.parse(raw), versions);
    assert.equal(r.status, 'invalid', raw.slice(0, 60));
    assert.match(r.errors[0], /^the map contains the reserved key (__proto__|constructor|prototype)$/);
    assert.equal(validateMap(JSON.parse(raw), { versions }).ok, false);
  }
  assert.equal(polluted(), false);
  // Rules ids and fields: refused by the validator too.
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => validateRules(JSON.parse(`{"actors":{"${key}":{"cost":1}}}`)), /invalid id/);
    assert.throws(() => validateRules(JSON.parse(`{"actors":{"E1":{"${key}":1}}}`)), /invalid field name/);
  }
  // Paths: reserved segments throw, descending needs own properties.
  const obj = {};
  for (const path of [['__proto__', 'polluted'], ['constructor', 'prototype', 'polluted'], ['a', 'prototype'], [], 'a', [1]]) {
    assert.throws(() => setPath(obj, path, 1), /invalid map field path/, JSON.stringify(path));
    assert.throws(() => getPath(obj, path), /invalid map field path/);
  }
  assert.equal(getPath({}, ['toString']), undefined, 'inherited properties are not fields');
  setPath(obj, ['toString', 'x'], 1);
  assert.deepEqual(Object.keys(obj), ['toString'], 'an inherited name becomes an own object, nothing else changes');
  // Quick fixes are checked like input.
  const map = v1Map();
  for (const action of [
    { kind: 'setField', path: ['__proto__', 'polluted'], value: 1 },
    { kind: 'moveField', from: ['notes'], to: ['constructor', 'prototype', 'polluted'] },
    { kind: 'setField', path: ['rules'], value: JSON.parse('{"__proto__":{"polluted":1}}') },
    { kind: 'removeActors', match: 'all' },
    { kind: 'setActorType', match: [{ type: 'E1', x: 1, y: 1 }], type: '<b>' },
    { kind: 'setTerrain', cells: [[1, 1]], value: 'x' },
    { kind: 'eval' },
    null,
  ]) {
    assert.throws(() => applyMapFix(map, action), /invalid map fix|invalid map field path|unknown map fix/, JSON.stringify(action));
  }
  assert.equal(polluted(), false);
  // Best effort drops reserved rule keys instead of handing them to the editor.
  const salvaged = salvageMap(JSON.parse(JSON.stringify(v1Map()).replace('"spd":5', '"spd":5,"__proto__":{"polluted":1}')), { versions });
  assert.equal(salvaged.map.rules, null);
  assert.ok(salvaged.problems.some((p) => p.message === 'rules use the reserved key __proto__; the overrides were left out.'));
  assert.equal(polluted(), false);
});

test('ids from the file are cut short and stripped of control characters in messages', () => {
  const long = `X${'Y'.repeat(60)}\u0007`;
  const ctx = { version: 2, notes: [], problems: [], note(t) { this.notes.push(t); }, problem(p) { this.problems.push(p); } };
  const map = { actors: [], rules: { actors: { [long]: { cost: 1 }, E1: { gone: 1 } } } };
  renameActors(map, { [long]: null }, ctx);
  renameRuleFields(map, 'actors', [[['gone'], null]], ctx);
  for (const p of ctx.problems) {
    assert.ok(p.message.length < 200, p.message);
    assert.doesNotMatch(p.message, /[\x00-\x1f]/);
  }
  assert.match(ctx.problems[0].message, /^rules\.actors\.XY{39}: XY{39} was removed in format 2/);
});
