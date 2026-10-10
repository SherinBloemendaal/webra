// OpenRA .oramap import (apps/game/js/oramap): ZIP, MiniYaml and map.bin
// readers against hostile input, conversion to a WebRA map, and a round trip
// the engine validates. Fixtures are synthetic (oramap-fixtures.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { buildMapBin, buildZip, mapYaml, sampleOramap, T } from './oramap-fixtures.mjs';
import { crc32, openZip, ZipError, ZIP_LIMITS } from '../js/oramap/zip.js';
import { MiniYamlError, parseMiniYaml, parseWDist } from '../js/oramap/miniyaml.js';
import { MapBinError, readMapBin } from '../js/oramap/mapbin.js';
import { cleanText, convertOramap, nearestColor, ORA_TO_WEBRA_TERRAIN, OramapError, RESOURCE_TYPES, TILESET_BIOMES } from '../js/oramap/convert.js';
import { importOramap, isOramapFile } from '../js/oramap/index.js';
import { BRIDGES, ORA_TERRAIN_LETTERS, PICK_ANY, TILESETS } from '../js/oramap/tables.js';
import { decodeLayers, TERRAIN } from '../editor/js/mapformat.js';
import { mapFileJson, parseMap as protocolParseMap, PREVIEW_TEAM } from '../js/protocol.js';
import { TEAM_PALETTE } from '../js/renderer.js';

const BASE_RULES = JSON.parse(readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8'));
const enc = new TextEncoder();

/** Deterministic pseudo random bytes (xorshift). */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

// ---- ZIP ---------------------------------------------------------------------------------

test('zip: reads stored and deflated entries and checks their CRC', async () => {
  const text = 'hello '.repeat(1000);
  const zip = openZip(buildZip([
    { name: 'a.txt', data: text, method: 8 },
    { name: 'b.bin', data: new Uint8Array([1, 2, 3]), method: 0 },
    { name: 'dir/', data: new Uint8Array(0), method: 0 },
  ], { comment: 'a comment' }));
  assert.deepEqual(zip.names(), ['a.txt', 'b.bin']);
  assert.equal(await zip.readText('a.txt'), text);
  assert.deepEqual([...(await zip.read('b.bin'))], [1, 2, 3]);
  await assert.rejects(zip.read('missing'), ZipError);
  await assert.rejects(zip.read('dir/'), ZipError);
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
});

test('zip: rejects bad checksums, lying sizes, encryption, unknown methods and bombs', async () => {
  const data = enc.encode('x'.repeat(5000));
  await assert.rejects(openZip(buildZip([{ name: 'a', data, crc: 1 }])).read('a'), /checksum/);
  // Declared smaller than the real output: inflation stops at the declared size.
  await assert.rejects(openZip(buildZip([{ name: 'a', data, size: 100 }])).read('a'), /more than its declared size/);
  await assert.rejects(openZip(buildZip([{ name: 'a', data, size: 6000 }])).read('a'), /wrong size/);
  await assert.rejects(openZip(buildZip([{ name: 'a', data, flags: 1 }])).read('a'), /encrypted/);
  await assert.rejects(openZip(buildZip([{ name: 'a', data, method: 0, size: 10 }])).read('a'), ZipError);
  // A 100 MiB bomb is refused from its header, before anything is inflated.
  const bomb = buildZip([{ name: 'bomb', data: new Uint8Array(64), size: 100 * 1024 * 1024 }]);
  await assert.rejects(openZip(bomb).read('bomb'), /larger than/);
  // High ratio below the size limit.
  const zeros = new Uint8Array(4 * 1024 * 1024);
  const ratio = buildZip([{ name: 'z', data: zeros }]);
  await assert.rejects(openZip(ratio).read('z'), /compression ratio/);
  // ...unless the caller allows it; then the real data comes out.
  assert.equal((await openZip(ratio, { maxRatio: 1e9 }).read('z')).length, zeros.length);
  // Total unpacked limit across entries.
  const two = buildZip([{ name: 'a', data }, { name: 'b', data }]);
  const z = openZip(two, { maxTotalBytes: 6000 });
  await z.read('a');
  await assert.rejects(z.read('b'), /too much data/);
  // Method 12 (bzip2) is not supported.
  const m = buildZip([{ name: 'a', data, method: 0 }]);
  new DataView(m.buffer).setUint16(m.length - 22 - (46 + 1) + 10, 12, true);
  await assert.rejects(openZip(m).read('a'), /compression method/);
});

test('zip: limits entry count and archive size, refuses ZIP64 and garbage', () => {
  const many = buildZip(Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, data: 'x', method: 0 })));
  assert.throws(() => openZip(many, { maxEntries: 10 }), /more than 10 entries/);
  assert.throws(() => openZip(new Uint8Array(100)), ZipError);
  assert.throws(() => openZip(new Uint8Array(ZIP_LIMITS.maxArchiveBytes + 1)), /larger than/);
  const z64 = buildZip([{ name: 'a', data: 'x', method: 0 }]);
  new DataView(z64.buffer).setUint16(z64.length - 22 + 10, 0xffff, true);
  new DataView(z64.buffer).setUint16(z64.length - 22 + 8, 0xffff, true);
  assert.throws(() => openZip(z64), /ZIP64/);
});

test('zip fuzz: truncated, bit-flipped and random archives fail cleanly', async () => {
  const good = sampleOramap();
  const next = rng(7);
  const tryRead = async (bytes) => {
    try {
      const z = openZip(bytes);
      for (const n of z.names()) await z.read(n);
    } catch (err) {
      assert.ok(err instanceof ZipError, `unexpected ${err?.constructor?.name}: ${err?.message}`);
    }
  };
  for (let cut = 0; cut < good.length; cut += Math.max(1, Math.floor(good.length / 150))) await tryRead(good.subarray(0, cut));
  for (let i = 0; i < 300; i++) {
    const b = good.slice();
    for (let k = 0; k < 1 + (next() % 4); k++) b[next() % b.length] ^= 1 << (next() % 8);
    await tryRead(b);
  }
  for (let i = 0; i < 200; i++) {
    const b = new Uint8Array(next() % 400);
    for (let k = 0; k < b.length; k++) b[k] = next() & 255;
    if (b.length >= 22 && i % 2) b.set([0x50, 0x4b, 0x05, 0x06], b.length - 22);
    await tryRead(b);
  }
});

// ---- MiniYaml ----------------------------------------------------------------------------

test('miniyaml: tabs or four spaces, comments, escapes, keys without values', () => {
  const nodes = parseMiniYaml('A: 1\n\tB: two # comment\n\t\tC\n    D: x\\#y\n# only a comment\n\nE:\r\n');
  assert.deepEqual(
    nodes.map((n) => [n.key, n.value, n.nodes.map((c) => [c.key, c.value, c.nodes.map((d) => d.key)])]),
    [
      ['A', '1', [['B', 'two', ['C']], ['D', 'x#y', []]]],
      ['E', '', []],
    ],
  );
  assert.equal(nodes[0].nodes[0].line, 2);
  assert.equal(parseWDist('5c512'), 5632);
  assert.equal(parseWDist('-1c0'), -1024);
  assert.equal(parseWDist('300'), 300);
  assert.equal(parseWDist('5x'), null);
});

test('miniyaml: rejects bad indentation and enforces limits', () => {
  assert.throws(() => parseMiniYaml('A:\n\t\tB: 1'), /indented too far/);
  assert.throws(() => parseMiniYaml('A:\n\t  B: 1'), /mixed/);
  assert.throws(() => parseMiniYaml('A:\n  B: 1'), /multiple of four/);
  assert.throws(() => parseMiniYaml(': x'), /empty key/);
  assert.throws(() => parseMiniYaml('a\n'.repeat(50), 'y', { maxLines: 10 }), /more than 10 lines/);
  assert.throws(() => parseMiniYaml('a\n'.repeat(50), 'y', { maxNodes: 10 }), /more than 10 entries/);
  assert.throws(() => parseMiniYaml('x'.repeat(100), 'y', { maxLineLength: 10 }), /line too long/);
  assert.throws(() => parseMiniYaml('x', 'y', { maxBytes: 0 }), /larger than/);
  let deep = '';
  for (let i = 0; i < 40; i++) deep += `${'\t'.repeat(i)}k${i}:\n`;
  assert.throws(() => parseMiniYaml(deep), /nested too deeply/);
});

test('miniyaml fuzz: random text either parses or throws MiniYamlError', () => {
  const next = rng(11);
  const alphabet = 'ab:\t #\\\n\r@-,1 ';
  for (let i = 0; i < 2000; i++) {
    let s = '';
    const n = next() % 120;
    for (let k = 0; k < n; k++) s += alphabet[next() % alphabet.length];
    try {
      parseMiniYaml(s);
    } catch (err) {
      assert.ok(err instanceof MiniYamlError, err?.message);
    }
  }
});

// ---- map.bin -----------------------------------------------------------------------------

test('map.bin: formats 1 and 2, column-major cells, pick-any tile index', () => {
  for (const format of [1, 2]) {
    const bin = readMapBin(buildMapBin(3, 2, (x, y) => [x * 10 + y, x === 2 ? 255 : 7], (x, y) => [x === 1 ? 1 : 0, y + 4], format));
    assert.equal(bin.format, format);
    assert.equal(bin.width, 3);
    assert.equal(bin.height, 2);
    assert.deepEqual([...bin.tileType], [0, 10, 20, 1, 11, 21]);
    // Index 255: (x % 4) + (y % 4) * 4.
    assert.deepEqual([...bin.tileIndex], [7, 7, 2, 7, 7, 6]);
    assert.deepEqual([...bin.resType], [0, 1, 0, 0, 1, 0]);
    assert.deepEqual([...bin.resDensity], [4, 4, 4, 5, 5, 5]);
  }
  // Format 2 without a resource layer.
  const b = buildMapBin(2, 2, () => [1, 0]);
  new DataView(b.buffer).setUint32(13, 0, true);
  assert.deepEqual([...readMapBin(b.subarray(0, 17 + 12)).resType], [0, 0, 0, 0]);
});

test('map.bin: rejects unknown formats, bad sizes and out of range layers', () => {
  assert.throws(() => readMapBin(new Uint8Array([3, 1, 0, 1, 0])), /unknown format/);
  assert.throws(() => readMapBin(new Uint8Array([2, 0, 0, 1, 0])), /invalid size/);
  assert.throws(() => readMapBin(new Uint8Array([2, 0, 8, 1, 0])), /invalid size/);
  assert.throws(() => readMapBin(new Uint8Array([2, 1])), /truncated/);
  const b = buildMapBin(4, 4, () => [1, 0]);
  new DataView(b.buffer).setUint32(13, 0xfffffff0, true);
  assert.throws(() => readMapBin(b), /resource layer out of range/);
  new DataView(b.buffer).setUint32(5, 0, true);
  assert.throws(() => readMapBin(b), MapBinError);
  new DataView(b.buffer).setUint32(5, 17, true);
  new DataView(b.buffer).setUint32(9, 5, true);
  assert.throws(() => readMapBin(b), /height layer/);
});

test('map.bin fuzz: truncated and random data never escape as other errors', () => {
  const good = buildMapBin(40, 40, (x, y) => [x + y, 0], (x) => [x % 3, 1]);
  const next = rng(3);
  const check = (bytes) => {
    try {
      readMapBin(bytes);
    } catch (err) {
      assert.ok(err instanceof MapBinError, err?.message);
    }
  };
  for (let cut = 0; cut <= good.length; cut += 97) check(good.subarray(0, cut));
  for (let i = 0; i < 1000; i++) {
    const b = new Uint8Array(next() % 64);
    for (let k = 0; k < b.length; k++) b[k] = next() & 255;
    if (b.length) b[0] = 1 + (next() % 2);
    check(b);
  }
});

// ---- Tables ------------------------------------------------------------------------------

test('tables: every RA tileset is present and every terrain letter maps onto WebRA', () => {
  assert.deepEqual(Object.keys(TILESETS).sort(), ['DESERT', 'INTERIOR', 'SNOW', 'TEMPERAT']);
  for (const id of Object.keys(TILESETS)) assert.ok(TILESET_BIOMES[id], `biome for ${id}`);
  const letters = new Set(Object.values(ORA_TERRAIN_LETTERS));
  for (const l of letters) assert.ok(ORA_TO_WEBRA_TERRAIN[l] !== undefined, `letter ${l}`);
  for (const [ts, templates] of Object.entries(TILESETS)) {
    assert.ok(Object.keys(templates).length > 100, ts);
    for (const packed of Object.values(templates)) assert.match(packed, /^([a-z.]\d*)+$/);
    assert.ok(PICK_ANY[ts].includes(255), `${ts} clear template`);
  }
  assert.equal(TILESETS.TEMPERAT[T.WATER], 'w');
  assert.equal(TILESETS.TEMPERAT[T.ROCK], 'k');
  assert.equal(TILESETS.TEMPERAT[T.CLEAR], 'c16');
  // Bridge templates of every state lead to their bridge actor (OpenRA LegacyBridgeLayer).
  assert.deepEqual(BRIDGES.TEMPERAT['131'], ['BRIDGE1', 5]);
  assert.deepEqual(BRIDGES.TEMPERAT['132'], ['BRIDGE1', 5]);
  assert.deepEqual(BRIDGES.DESERT['620'], ['BRIDGE3', 4]);
  assert.equal(BRIDGES.DESERT['131'], undefined);
  assert.equal(RESOURCE_TYPES[2].webra, 'gems');
});

// ---- Conversion --------------------------------------------------------------------------

const parse = (bytes) => importOramap(bytes, { baseRules: BASE_RULES, fileName: 'valley.oramap' });

test('convert: terrain, crop, resources, the neutral world, spawns and actors', async () => {
  const { map, report } = await parse(sampleOramap());
  assert.equal(map.format, 2, 'gems make a format 2 map');
  assert.equal(map.width, 44);
  assert.equal(map.height, 44);
  assert.equal(map.name, 'Test Valley');
  assert.equal(map.author, 'Tester');
  const { terrain, ore, gems } = decodeLayers(map);
  const at = (layer, x, y) => layer[(y - 2) * 44 + (x - 2)];
  assert.equal(at(terrain, 22, 22), TERRAIN.WATER);
  assert.equal(at(terrain, 30, 5), TERRAIN.ROCK);
  assert.equal(at(terrain, 5, 5), TERRAIN.CLEAR);
  // Trees and civilian buildings are actors (engine neutral.rs), the ground under them stays.
  assert.equal(at(terrain, 15, 16), TERRAIN.CLEAR);
  assert.equal(at(terrain, 16, 41), TERRAIN.CLEAR);
  // A 3x3 ore field: the centre has 9 neighbours (density 12), a corner 4 (12*4/9 = 5).
  assert.equal(at(ore, 11, 31), 12);
  assert.equal(at(ore, 10, 30), 5);
  // A 2x2 gems field: every cell has 4 neighbours, 3*4/9 = 1.
  assert.equal(at(gems, 36, 30), 1);
  assert.equal(at(ore, 36, 30), 0);
  // mpspawn at 8,8: yard top-left one up and left, minus the crop.
  assert.deepEqual(map.spawns, [[5, 5], [35, 35]]);
  const types = map.actors.map((a) => a.type).sort();
  assert.deepEqual(types, ['C1', 'E1', 'PBOX', 'T01', 'V01']);
  const tree = map.actors.find((a) => a.type === 'T01');
  assert.deepEqual([tree.owner, tree.x, tree.y], [-1, 13, 13], 'neutral, at the crop-shifted location');
  const e1 = map.actors.find((a) => a.type === 'E1');
  assert.deepEqual([e1.owner, e1.x, e1.y], [0, 8, 10]);
  // OpenRA facing 256 (west, counter-clockwise) is WebRA 768 (west, clockwise).
  assert.equal(e1.facing, 768);
  assert.equal(map.rules, null);
  assert.equal(report.modded, false);
  assert.ok(report.validation.ok, report.validation.errors.join('; '));
  assert.ok(report.skipped.some((s) => s.includes('brl3') && s.includes('outside')));
  assert.ok(report.skipped.some((s) => s.includes('waypoint')));
  assert.ok(report.converted.some((s) => s.includes('gems 4 cells')));
  assert.ok(protocolParseMap(JSON.stringify(map)).ok);
});

test('convert: OpenRA Health and Stance inits become the actors\' state where the actor has it', async () => {
  const actors = [
    { type: 'mpspawn', x: 8, y: 8 },
    { type: 'mpspawn', x: 38, y: 38 },
    { type: 'e1', owner: 'Multi0', x: 10, y: 12, health: 40, stance: 'HoldFire' },
    { type: 'pbox', x: 25, y: 10, health: 100, stance: 'Defend' },
    { type: 'v01', x: 15, y: 40, health: 25, stance: 'Defend' },
  ];
  const { map, report } = await parse(sampleOramap({ actors }));
  const byType = Object.fromEntries(map.actors.map((a) => [a.type, a]));
  assert.deepEqual([byType.E1.health, byType.E1.stance], [40, 'hold_fire']);
  assert.equal(byType.PBOX.health, undefined, 'full health is the default');
  assert.equal(byType.PBOX.stance, 'defend');
  assert.deepEqual([byType.V01.health, byType.V01.stance], [25, undefined], 'a civilian building has no stance');
  assert.ok(report.converted.some((l) => l.startsWith('Health, stances and passengers of pre-placed actors')));
});

test('convert: OpenRA lobby slots become the map\'s player slots with their faction and team locks', async () => {
  const multi = [
    ['\t\tFaction: soviet', '\t\tLockFaction: True', '\t\tTeam: 1', '\t\tLockTeam: True'],
    ['\t\tFaction: england', '\t\tTeam: 2'],
    ['\t\tFaction: Random'],
  ];
  const { map, report } = await parse(sampleOramap({ multi }));
  assert.deepEqual(map.players, [
    { faction: 'randomsoviet', team: 1, color: -1, type: 'open', difficulty: 'normal', bot: 'normal', lock: ['faction', 'team'] },
    { faction: 'england', team: 2, color: -1, type: 'open', difficulty: 'normal', bot: 'normal', lock: [] },
  ]);
  assert.ok(report.converted.some((l) => l.startsWith('Player slots')));
  const plain = await parse(sampleOramap());
  assert.deepEqual(plain.map.players, [], 'slots that set nothing are left out');
});

test('convert: OpenRA player colours become the nearest free lobby colour, LockColor its lock', async () => {
  const multi = [
    ['\t\tColor: FF1400', '\t\tLockColor: True'],
    ['\t\tColor: E81E0A'],
    ['\t\tColor: 0,140,255'],
    ['\t\tColor: nonsense'],
  ];
  const spawns = [8, 18, 28, 38].map((x) => ({ type: 'mpspawn', x, y: 8 }));
  const { map } = await parse(sampleOramap({ multi, actors: spawns }));
  assert.deepEqual(
    map.players.map((p) => [p.color, p.lock]),
    [
      [1, ['color']],
      [5, []],
      [0, []],
    ],
    'red, then the next nearest free colour (orange), blue; an unreadable colour stays Any and the empty slot is left out',
  );
  assert.equal(nearestColor('E2E6F6'), 7, 'near white');
  assert.equal(nearestColor('#FFD840'), 2, 'gold');
  assert.equal(nearestColor('FF1400', [1, 5]), 2, 'taken colours are skipped');
  assert.equal(nearestColor('12345'), null);
  assert.equal(nearestColor('300,0,0'), null);
  // The palette is the lobby's (js/renderer.js TEAM_PALETTE in 0..255).
  assert.deepEqual(PREVIEW_TEAM, TEAM_PALETTE.map((c) => c.map((v) => Math.round(v * 255))));
});

test('convert: OpenRA Cargo inits become the passengers of transports, checked like the editor checks them', async () => {
  const actors = [
    { type: 'mpspawn', x: 8, y: 8 },
    { type: 'mpspawn', x: 38, y: 38 },
    { type: 'apc', owner: 'Multi0', x: 12, y: 12, cargo: 'e1, E3,medi' },
    { type: 'jeep', owner: 'Multi0', x: 14, y: 12, cargo: 'e1,e1' },
    { type: 'apc', owner: 'Multi0', x: 16, y: 12, cargo: '1tnk,nope' },
    { type: '1tnk', owner: 'Multi0', x: 18, y: 12, cargo: 'e1' },
  ];
  const { map, report } = await parse(sampleOramap({ actors }));
  const at = (x) => map.actors.find((a) => a.x === x - 2);
  assert.deepEqual(at(12).cargo, ['E1', 'E3', 'MEDI']);
  assert.deepEqual(at(14).cargo, ['E1'], 'a jeep carries one');
  assert.equal(at(16).cargo, undefined, 'vehicles and unknown types do not ride in an APC');
  assert.equal(at(18).cargo, undefined, 'a tank carries nobody');
  const skipped = report.skipped.find((l) => l.startsWith('Passengers that do not fit'));
  for (const part of ['JEEP (e1)', 'APC (1tnk, nope)', '1TNK (e1)']) assert.ok(skipped.includes(part), `${part} in ${skipped}`);
  // The engine accepts what the import keeps.
  const v = JSON.parse(Game.validate_map(mapFileJson(map)));
  assert.ok(v.ok, v.errors.join('; '));
});

test('convert: bridge templates become bridge actors over their terrain, roads and rivers keep their types', async () => {
  // BRIDGE1 (template 131, 5x3: .kggk / kggkk / ..k..) at 20,10 over a river row, a road to it.
  const rows = ['.kggk', 'kggkk', '..k..'];
  const tile = (x, y) => {
    const dx = x - 20;
    const dy = y - 10;
    if (dx >= 0 && dx < 5 && dy >= 0 && dy < 3 && rows[dy][dx] !== '.') return [131, dy * 5 + dx];
    if (y === 11) return [113, 7]; // a river tile (temperat template 113 index 7: v)
    if (x === 22 && y < 10) return [173, 1]; // a road piece (template 173 index 1: d)
    return [T.CLEAR, 255];
  };
  const bytes = buildZip([
    { name: 'map.yaml', data: mapYaml({ actors: [{ type: 'mpspawn', x: 8, y: 30 }, { type: 'mpspawn', x: 38, y: 38 }] }) },
    { name: 'map.bin', data: buildMapBin(48, 48, tile) },
  ]);
  const { map, report } = await parse(bytes);
  const bridges = map.actors.filter((a) => a.type === 'BRIDGE1');
  assert.equal(bridges.length, 1, 'one actor for the whole template');
  assert.deepEqual([bridges[0].owner, bridges[0].x, bridges[0].y], [-1, 18, 8]);
  const { terrain } = decodeLayers(map);
  const at = (x, y) => terrain[(y - 2) * 44 + (x - 2)];
  assert.equal(at(22, 10), TERRAIN.BRIDGE);
  assert.equal(at(21, 10), TERRAIN.ROCK);
  assert.equal(at(5, 11), TERRAIN.RIVER);
  assert.equal(at(22, 5), TERRAIN.ROAD);
  assert.ok(report.converted.some((s) => s.includes('Bridges (1)')));
  assert.ok(report.validation.ok, report.validation.errors.join('; '));
});

test('convert: maps without gems stay format 1', async () => {
  const bytes = buildZip([
    { name: 'map.yaml', data: mapYaml({ actors: [{ type: 'mpspawn', x: 8, y: 8 }, { type: 'mpspawn', x: 38, y: 38 }] }) },
    { name: 'map.bin', data: buildMapBin(48, 48, () => [T.CLEAR, 255], (x, y) => (x === 20 && y === 20 ? [1, 0] : [0, 0])) },
  ]);
  const { map } = await parse(bytes);
  assert.equal(map.format, 1);
  assert.equal(map.gems, undefined);
  assert.equal(decodeLayers(map).ore[18 * 44 + 18], 1, 'a lone ore cell keeps density 1');
});

test('convert: SNOW and DESERT maps keep their biome, INTERIOR is drawn temperate', async () => {
  const spawns = [{ type: 'mpspawn', x: 8, y: 8 }, { type: 'mpspawn', x: 38, y: 38 }];
  const convert = (tileset) =>
    parse(buildZip([
      { name: 'map.yaml', data: mapYaml({ actors: spawns, tileset }) },
      { name: 'map.bin', data: buildMapBin(48, 48, () => [T.CLEAR, 255]) },
    ]));
  for (const [tileset, biome] of [['SNOW', 'snow'], ['DESERT', 'desert']]) {
    const { map, report } = await convert(tileset);
    assert.equal(map.biome, biome, tileset);
    assert.ok(report.converted.some((c) => c.includes(`${biome} biome`)));
    assert.ok(protocolParseMap(JSON.stringify(map)).ok, tileset);
  }
  const { map, report } = await convert('INTERIOR');
  assert.equal(map.biome, undefined, 'temperate: the field is left out');
  assert.ok(report.warnings.some((w) => w.includes('drawn temperate')));
  assert.equal((await convert('TEMPERAT')).map.biome, undefined);
});

test('convert: rules that map onto WebRA become a modded map, the rest is reported', async () => {
  const rules = [
    'E1:',
    '\tValued:',
    '\t\tCost: 50',
    '\tHealth:',
    '\t\tHP: 9000',
    '\tMobile:',
    '\t\tSpeed: 60',
    '\tBuildable:',
    '\t\tPrerequisites: ~disabled',
    '\tRevealsShroud:',
    '\t\tRange: 6c0',
    '\tMadeUp:',
    '\t\tField: 1',
    '\t-Selectable:',
    'Player:',
    '\tPlayerResources:',
    '\t\tDefaultCash: 1',
    'World:',
    '\tLuaScript:',
    '\t\tScripts: x.lua',
    '',
  ].join('\n');
  const weapons = 'Weapons:\n\tM1Carbine:\n\t\tRange: 6c0\n\t\tReloadDelay: 0\n\t\tWarhead@1Dam: SpreadDamage\n\t\t\tDamage: 2000\n\tNotAWeapon:\n\t\tRange: 1c0\n';
  const bytes = sampleOramap({
    rulesRef: 'rules.yaml, ra|rules/campaign-rules.yaml, missing.yaml',
    extraYaml: `${weapons}Sequences: seq.yaml\n`,
    extraFiles: [
      { name: 'rules.yaml', data: rules },
      { name: 'x.lua', data: 'Media.DisplayMessage("hi")' },
      { name: 'seq.yaml', data: 'x:\n' },
    ],
  });
  const { map, report } = await parse(bytes);
  assert.deepEqual(map.rules.actors.E1, { cost: 50, hp: 9000, unit: { speed: 60 }, prerequisites: ['~disabled'], sight: 6144, build_ticks: 30 });
  assert.equal(map.rules.weapons.M1Carbine.range, 6144);
  assert.equal(map.rules.weapons.M1Carbine.warheads[0].damage, 2000);
  assert.equal(map.rules.weapons.M1Carbine.reload, undefined, 'out of range values are not applied');
  assert.equal(report.modded, true);
  const unsupported = report.unsupported.join('\n');
  assert.match(unsupported, /Lua scripts \(x\.lua\) are not run/);
  assert.match(unsupported, /E1\.MadeUp\.Field/);
  assert.match(unsupported, /E1\.-Selectable/);
  assert.match(unsupported, /Player \(not a WebRA actor\)/);
  assert.match(unsupported, /NotAWeapon/);
  assert.match(unsupported, /M1Carbine\.ReloadDelay/);
  assert.match(unsupported, /campaign-rules\.yaml comes from the OpenRA mod/);
  assert.match(unsupported, /sprite sequences/);
  assert.ok(report.warnings.some((w) => w.includes('missing.yaml')));
  assert.ok(protocolParseMap(JSON.stringify(map), { rules: BASE_RULES }).ok);
});

test('convert: refuses maps for other mods, unknown tilesets, too few spawns and huge bounds', async () => {
  const pkg = (yaml, w = 48, h = 48) => buildZip([
    { name: 'map.yaml', data: yaml },
    { name: 'map.bin', data: buildMapBin(w, h, () => [T.CLEAR, 255]) },
  ]);
  const spawns = [{ type: 'mpspawn', x: 8, y: 8 }, { type: 'mpspawn', x: 38, y: 38 }];
  await assert.rejects(parse(pkg(mapYaml({ actors: spawns }).replace('RequiresMod: ra', 'RequiresMod: cnc'))), /OpenRA mod "cnc"/);
  await assert.rejects(parse(pkg(mapYaml({ actors: spawns, tileset: 'JUNGLE' }))), /Unknown tileset/);
  await assert.rejects(parse(pkg(mapYaml({ actors: spawns.slice(0, 1) }))), /needs at least 2/);
  await assert.rejects(parse(pkg(mapYaml({ actors: spawns, size: [50, 50] }))), /says 50x50/);
  await assert.rejects(parse(pkg(mapYaml({ actors: spawns, size: [300, 40], bounds: [0, 0, 300, 40] }), 300, 40)), /at most 256/);
  await assert.rejects(parse(buildZip([{ name: 'readme.txt', data: 'x' }])), /map\.yaml is missing/);
  await assert.rejects(parse(new Uint8Array([1, 2, 3])), OramapError);
  try {
    await parse(pkg(mapYaml({ actors: spawns, tileset: 'JUNGLE' })));
  } catch (err) {
    assert.equal(err.report.tileset, 'JUNGLE', 'the partial report travels with the error');
  }
});

test('convert: small maps are padded, blocked spawns move, more than 8 spawns are capped', async () => {
  // 24x24 playable area, rock right on spawn 1's yard and a tree (an actor) on spawn 2's.
  const spawns = [{ type: 'mpspawn', x: 5, y: 5 }, { type: 'mpspawn', x: 18, y: 16 }, { type: 't08', x: 18, y: 16 }];
  const small = buildZip([
    { name: 'map.yaml', data: mapYaml({ actors: spawns, size: [26, 26], bounds: [1, 1, 24, 24] }) },
    { name: 'map.bin', data: buildMapBin(26, 26, (x, y) => (x === 5 && y === 5 ? [T.ROCK, 0] : [T.CLEAR, 255])) },
  ]);
  const { map, report } = await parse(small);
  assert.equal(map.width, 32);
  assert.equal(map.height, 32);
  assert.ok(report.warnings.some((w) => w.includes('rock was added')));
  assert.ok(report.warnings.some((w) => w.includes('Start position 1 was moved')));
  assert.ok(!map.actors.some((a) => a.type === 'T08'), 'the tree on the yard is left out');
  assert.ok(report.skipped.some((w) => w.includes('overlap a start position') && w.includes('T08')), report.skipped.join('; '));
  assert.ok(report.validation.ok, report.validation.errors.join('; '));
  const { terrain } = decodeLayers(map);
  assert.equal(terrain[31 * 32 + 31], TERRAIN.ROCK);

  const nine = Array.from({ length: 9 }, (_, i) => ({ type: 'mpspawn', x: 6 + (i % 3) * 14, y: 6 + Math.floor(i / 3) * 14 }));
  const many = buildZip([
    { name: 'map.yaml', data: mapYaml({ actors: nine, size: [48, 48], bounds: [0, 0, 48, 48] }) },
    { name: 'map.bin', data: buildMapBin(48, 48, () => [T.CLEAR, 255]) },
  ]);
  const r = await parse(many);
  assert.equal(r.map.spawns.length, 8);
  assert.ok(r.report.warnings.some((w) => w.includes('the first 8 were kept')));
});

test('convert: a folder inside the package, unknown templates and hostile text', async () => {
  const yaml = mapYaml({
    title: '\u202eEvil\u0007 Title'.padEnd(120, '!'),
    actors: [{ type: 'mpspawn', x: 8, y: 8 }, { type: 'mpspawn', x: 38, y: 38 }],
  });
  const bytes = buildZip([
    { name: 'mymap/map.yaml', data: yaml },
    { name: 'mymap/map.bin', data: buildMapBin(48, 48, (x) => (x === 40 ? [9999, 0] : [T.CLEAR, 255])) },
  ]);
  const { map, report } = await parse(bytes);
  assert.equal(Array.from(map.name).length, 64);
  assert.ok(!/[\u202e\u0007]/.test(map.name));
  assert.ok(report.warnings.some((w) => w.includes('tile templates the TEMPERAT tileset does not have')));
  assert.equal(cleanText('  a\n\tb  ', 10), 'a b');
});

test('isOramapFile: by extension or ZIP signature', () => {
  assert.ok(isOramapFile('x.ORAMAP'));
  assert.ok(isOramapFile('x.bin', new Uint8Array([0x50, 0x4b, 3, 4])));
  assert.ok(!isOramapFile('x.json', enc.encode('{"format":1}')));
});

test('convert fuzz: random map.yaml and map.bin content never crashes the converter', () => {
  const next = rng(23);
  const parsedYaml = parseMiniYaml(mapYaml({ actors: [{ type: 'mpspawn', x: 8, y: 8 }, { type: 'mpspawn', x: 38, y: 38 }] }));
  for (let i = 0; i < 300; i++) {
    const w = 1 + (next() % 60);
    const h = 1 + (next() % 60);
    const bin = readMapBin(buildMapBin(w, h, () => [next() % 400, next() & 255], () => [next() % 4, next() & 255]));
    const yaml = parsedYaml.map((n) => {
      if (n.key === 'MapSize' && i % 3) return { ...n, value: `${w},${h}` };
      if (n.key === 'Bounds' && i % 2) return { ...n, value: `${(next() % 80) - 10},${next() % 50},${next() % 300},${next() % 70}` };
      return n;
    });
    try {
      const { map } = convertOramap({ yaml, bin }, { baseRules: BASE_RULES });
      assert.ok(protocolParseMap(JSON.stringify(map)).ok);
    } catch (err) {
      assert.ok(err instanceof OramapError, err?.stack);
    }
  }
});

// ---- Engine round trip -------------------------------------------------------------------

const { initSync, Game } = await import('../pkg/webra_sim.js');
initSync({ module: readFileSync(new URL('../pkg/webra_sim_bg.wasm', import.meta.url)) });
const engineValidate = (json) => JSON.parse(Game.validate_map(json));

test('round trip: the engine validates, hashes and starts a converted map', async () => {
  const { map, json, report } = await importOramap(sampleOramap(), { baseRules: BASE_RULES, validate: engineValidate });
  assert.ok(report.validation.ok, report.validation.errors.join('; '));
  const v = engineValidate(json);
  assert.ok(v.ok, v.errors.join('; '));
  assert.equal(v.modded, false);
  // The canonical form survives a save and reload with the same identity.
  assert.equal(Game.map_hash(Game.map_canonical(json)), v.hash);
  const options = JSON.stringify({
    seed: 1,
    players: [
      { slot: 0, type: 'human', faction: 'england' },
      { slot: 1, type: 'human', faction: 'russia' },
    ],
    startingUnits: 'mcv',
    techLevel: 'unrestricted',
    fog: true,
    explored: false,
  });
  const game = Game.from_map(json, options);
  for (let i = 0; i < 20; i++) game.tick();
  assert.equal(game.player_count(), 2, 'the neutral owner of the pillbox is not a player');
  assert.equal(map.format, 2);
});

test('round trip: rules the engine refuses are dropped one by one and reported', async () => {
  // Sight beyond the engine's largest vision radius (40 cells) is refused by the engine only.
  const rules = 'E1:\n\tValued:\n\t\tCost: 75\n\tRevealsShroud:\n\t\tRange: 50c0\n';
  const bytes = sampleOramap({ rulesRef: 'rules.yaml', extraFiles: [{ name: 'rules.yaml', data: rules }] });
  const { map, json, report } = await importOramap(bytes, { baseRules: BASE_RULES, validate: engineValidate });
  assert.equal(map.rules.actors.E1.cost, 75);
  assert.equal(map.rules.actors.E1.sight, undefined);
  assert.ok(report.rules.rejected.some((r) => r.startsWith('E1 sight')), report.rules.rejected.join('; '));
  assert.equal(report.modded, true);
  const v = engineValidate(json);
  assert.ok(v.ok && v.modded, v.errors.join('; '));
});
