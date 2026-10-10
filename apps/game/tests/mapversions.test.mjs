// Map versions in the game client (docs/contracts.md section 2, "Map
// versions"): the map editor opens files of any format version (upgraded,
// or best effort with located problems and quick fixes) and saves the
// current format; the skirmish lobby and the map library upgrade what they
// load and say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initSync, Game } from '../pkg/webra_sim.js';
import { canonicalMapJson, GAME_VERSION, MAP_FORMAT_VERSION, MAP_UPGRADED_NOTICE, upgradeMap } from '../../../packages/protocol/src/index.js';
import { testVersions, v1Map } from '../../../packages/protocol/test/fixtures/map-test-versions.mjs';
import { applyFix, openMapFile } from '../editor/js/upgrade.js';
import { canonicalJson, mapFileText, mapHash } from '../editor/js/mapformat.js';
import { MapDoc } from '../editor/js/doc.js';
import { inspectMapFile } from '../js/lobby-state.js';
import { MapLibrary, MemoryMapBackend } from '../js/maplibrary.js';
import { installDom, uninstallDom } from './dom-fixtures.mjs';

initSync({ module: readFileSync(fileURLToPath(new URL('../pkg/webra_sim_bg.wasm', import.meta.url))) });
const validate = (json) => JSON.parse(Game.validate_map(json));
const fixture = (name) => readFileSync(new URL(`../../../packages/protocol/test/fixtures/maps/${name}`, import.meta.url), 'utf8');
const LEGACY = fixture('format1-legacy.webra-map.json');
const FILE = fixture('format1-file.webra-map.json');
const sha = (s) => createHash('sha256').update(s).digest('hex');

/** The engine check for maps of the test registry (the engine reads format 1 only): shape and hash. */
const fakeValidate = (json) => {
  const map = JSON.parse(json);
  return { ok: Array.isArray(map.spawns), errors: [], modded: false, hash: sha(json) };
};

// ---- The map editor --------------------------------------------------------------------------

test('editor: a current file opens as it is, without a notice', () => {
  const opened = openMapFile(JSON.parse(LEGACY));
  assert.equal(opened.status, 'current');
  assert.equal(opened.notice, null);
  assert.deepEqual(opened.problems, []);
  assert.equal(canonicalJson(opened.map), JSON.parse(fixture('format1-legacy.expected.json')).canonical);
});

test('editor: an older file opens upgraded with the notice to save it', () => {
  const versions = testVersions();
  const opened = openMapFile(v1Map({}, { 40: 9 }), versions);
  assert.equal(opened.status, 'upgraded');
  assert.equal(opened.notice, MAP_UPGRADED_NOTICE);
  assert.equal(opened.notice, 'This map was upgraded from an older version; save it in the editor to keep the upgrade.');
  assert.ok(opened.notes.includes('Renamed 1 actor from oldtree to T01.'));
  const doc = new MapDoc(opened.map);
  assert.equal(doc.actors[0].type, 'T01');
  assert.equal(doc.terrain[40], 2);
  assert.equal(doc.meta.description, 'from the notes field');
});

test('editor: a map that is no longer compatible opens best effort, with located problems and working quick fixes', () => {
  const versions = testVersions();
  const raw = v1Map({ gameVersion: '0.8.1', actors: [{ type: 'GONE', owner: -1, x: 3, y: 9 }, { type: 'E1', owner: -1, x: 4, y: 9 }] }, { 70: 7 });
  const opened = openMapFile(raw, versions);
  assert.equal(opened.status, 'incompatible');
  assert.equal(
    opened.notice,
    'This map was made for WebRA 0.8 (format 1) and is no longer compatible with this version. Open it in the map editor and save it again.',
  );
  const gone = opened.problems.find((p) => p.code === 'actor-removed');
  assert.deepEqual([gone.x, gone.y], [3, 9], 'located, so the list jumps there');
  const terrain = opened.problems.find((p) => p.code === 'terrain-changed');
  assert.deepEqual([terrain.x, terrain.y], [6, 2]);
  // The editor loads it and the fixes apply to the document's map.
  const doc = new MapDoc(opened.map);
  doc.replace(applyFix(doc.toMap(), gone.fixes.find((f) => f.label === 'Remove the actor')), 'fix');
  assert.deepEqual(doc.actors.map((a) => a.type), ['E1']);
  doc.replace(applyFix(doc.toMap(), terrain.fixes.find((f) => f.label === 'Use road')), 'fix');
  assert.equal(doc.terrain[70], 6);
  // Saved, it is a current file again (formatVersion of this release in front).
  const saved = mapFileText(doc.toMap());
  assert.ok(saved.startsWith(`{"formatVersion":${MAP_FORMAT_VERSION},"gameVersion":"${GAME_VERSION}",`));
});

test('editor: a newer or damaged file opens best effort; something that is no map does not', () => {
  const legacy = JSON.parse(LEGACY);
  const newer = openMapFile({ ...legacy, formatVersion: MAP_FORMAT_VERSION + 1, gameVersion: '9.1.0', submarines: [] });
  assert.equal(newer.status, 'newer');
  assert.match(newer.notice, /^This map was made with a newer version of WebRA \(9\.1, format \d+; this version reads format \d+\)\. Update the game to play it\.$/);
  assert.ok(newer.problems.some((p) => p.message === 'Unknown field "submarines" was left out.'));
  assert.equal(new MapDoc(newer.map).actors.length, legacy.actors.length);

  const damaged = openMapFile({ ...legacy, terrain: legacy.terrain.slice(0, 40) });
  assert.equal(damaged.status, 'current');
  assert.match(damaged.notice, /could not be read; the editor opened what it could/);
  assert.ok(damaged.problems.some((p) => p.message === 'The terrain layer had 30 cells for a 32 x 32 map; it was cut or filled to fit.'));
  assert.equal(new MapDoc(damaged.map).terrain.length, legacy.width * legacy.height);

  assert.deepEqual(openMapFile([1, 2]), { map: null, status: 'invalid', error: 'The file does not contain a map object.' });
});

test('editor: saving writes the current format and this release; the identity stays the canonical form', async () => {
  const doc = new MapDoc(JSON.parse(LEGACY));
  const text = mapFileText(doc.toMap());
  const map = JSON.parse(text);
  assert.equal(map.formatVersion, MAP_FORMAT_VERSION);
  assert.equal(map.gameVersion, GAME_VERSION);
  assert.equal(await mapHash(map), JSON.parse(fixture('format1-legacy.expected.json')).hash);
  assert.equal(Game.map_hash(text), JSON.parse(fixture('format1-legacy.expected.json')).hash, 'the engine reads the saved file');
  assert.equal(doc.toMap().formatVersion, MAP_FORMAT_VERSION, 'drafts and undo steps name their version');
});

// ---- The skirmish lobby ------------------------------------------------------------------------

test('lobby: map files of every kind of version are checked, upgraded or refused with the message', () => {
  const legacy = inspectMapFile(LEGACY, validate);
  assert.ok(legacy.ok, legacy.errors.join('; '));
  assert.equal(legacy.json, LEGACY, 'a current file is installed as it is');
  assert.equal(legacy.upgrade, null);
  const file = inspectMapFile(FILE, validate);
  assert.ok(file.ok);
  assert.equal(file.hash, legacy.hash);

  const newer = inspectMapFile(JSON.stringify({ ...JSON.parse(FILE), formatVersion: MAP_FORMAT_VERSION + 1 }), validate);
  assert.equal(newer.ok, false);
  assert.match(newer.errors[0], /^This map was made with a newer version of WebRA \(0\.9, format \d+;.*Update the game to play it\.$/);

  const versions = testVersions();
  const up = inspectMapFile(JSON.stringify(v1Map()), fakeValidate, versions);
  assert.ok(up.ok, up.errors.join('; '));
  assert.deepEqual(up.upgrade, { from: 1, message: MAP_UPGRADED_NOTICE });
  assert.equal(up.json, canonicalMapJson(upgradeMap(v1Map(), versions).map), 'the engine gets the upgraded map');
  assert.ok(up.json.startsWith('{"formatVersion":3,'));
  assert.equal(up.biome, 'snow');

  const gone = inspectMapFile(JSON.stringify(v1Map({ actors: [{ type: 'GONE', owner: -1, x: 3, y: 9 }] })), fakeValidate, versions);
  assert.equal(gone.ok, false);
  assert.match(gone.errors[0], /^This map was made for WebRA 0\.9 \(format 1\) and is no longer compatible/);
  assert.match(gone.errors[1], /GONE was removed in format 2/);

  // Upgraded, but the engine refuses the result: not compatible any more (not "broken").
  const refused = inspectMapFile(JSON.stringify(v1Map()), () => ({ ok: false, errors: ['spawn 1 needs 3x4 clear ground'] }), versions);
  assert.deepEqual(refused.errors.slice(1), ['spawn 1 needs 3x4 clear ground']);
  assert.match(refused.errors[0], /no longer compatible/);
});

test('lobby: an upgraded map file shows the notice with the installed map', async () => {
  const doc = installDom();
  globalThis.requestAnimationFrame = () => 1;
  try {
    const root = doc.createElement('section');
    doc.body.append(root);
    const { Lobby } = await import('../js/lobby.js');
    const lobby = new Lobby(root, {
      colors: [[200, 0, 0], [0, 0, 200]],
      colorNames: [],
      maps: {
        preview: (seed, size) => new Uint8Array(size * size * 4),
        describe: () => 'Land, Temperate',
        spawns: () => [[2, 2], [40, 40]],
        validate: fakeValidate,
        filePreview: () => new Uint8Array(32 * 32 * 4),
        versions: testVersions(),
      },
      onStart: () => {},
      onStress: () => {},
    });
    lobby.offerMapText(JSON.stringify(v1Map()), 'file');
    const notice = root.querySelector('.lobby-map-notice');
    assert.ok(notice, 'the notice is shown');
    assert.equal(notice.textContent, MAP_UPGRADED_NOTICE);
    assert.equal(notice.getAttribute('role'), 'status');
    assert.ok(lobby.mapFile.json.startsWith('{"formatVersion":3,'), 'the game gets the upgraded map');
    lobby.offerMapText(JSON.stringify(v1Map({ actors: [{ type: 'MIX', owner: -1, x: 3, y: 9 }] })), 'file');
    assert.match(lobby.mapErrors[0], /no longer compatible with this version\. Open it in the map editor and save it again\.$/);
  } finally {
    delete globalThis.requestAnimationFrame;
    uninstallDom();
  }
});

// ---- The map library ------------------------------------------------------------------------------

test('map library: entries an older release stored are upgraded on first use; incompatible ones go', async () => {
  const versions = testVersions();
  const backend = new MemoryMapBackend();
  const row = (json, name) => ({ hash: sha(json), name, author: 'x', players: 2, width: 32, height: 32, modded: false, bytes: json.length, source: 'lobby', addedAt: 5, usedAt: 7, json });
  // What the format 1 release stored: its canonical text (format 1 has no formatVersion key).
  const old = JSON.stringify(v1Map());
  const broken = JSON.stringify(v1Map({ name: 'Broken', actors: [{ type: 'GONE', owner: -1, x: 3, y: 9 }] }));
  await backend.put(row(old, 'Old'));
  await backend.put(row(broken, 'Broken'));
  const lib = new MapLibrary(backend, () => 100, versions);
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const list = await lib.list();
    assert.equal(list.length, 1);
    const upgraded = canonicalMapJson(upgradeMap(v1Map(), versions).map);
    assert.equal(list[0].hash, sha(upgraded), 'listed under the hash of the upgraded map');
    assert.deepEqual([list[0].source, list[0].addedAt, list[0].usedAt], ['lobby', 5, 7], 'it keeps its history');
    assert.equal((await lib.get(sha(upgraded))).json, upgraded);
    assert.equal(await lib.get(sha(old)), null, 'the old entry is gone');
    assert.match(warned.join('\n'), /"Broken" is no longer compatible and was removed/);
    assert.deepEqual(await lib.upgradeStored(), { upgraded: 1, dropped: 1 }, 'one pass per page');
    // Adding an old file stores the upgraded map too.
    const added = await lib.add(JSON.stringify(v1Map({ name: 'Fresh' })), { source: 'file' });
    assert.ok((await lib.get(added.hash)).json.startsWith('{"formatVersion":3,'));
    await assert.rejects(lib.add(broken), /no longer compatible/);
  } finally {
    console.warn = warn;
  }
});
