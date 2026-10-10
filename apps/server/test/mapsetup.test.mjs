// The game setup of stored maps (map format version 2, docs/contracts.md
// section 2 "Map setup"): the community list names each map's tags and its
// thumbnail, the thumbnail is a PNG drawn from the map data alone, and lobby
// map descriptions carry the slots and options rooms apply and enforce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { mapThumbnail, parseMap, validMapRef } from '@webra/protocol';
import { FakeD1 } from './fake-d1.mjs';
import { HttpError } from '../src/http.js';
import { getMapThumbnail, listMaps, prepareMap, storeMap } from '../src/maps.js';
import { encodePng } from '../src/png.js';

const fixture = (name) => readFileSync(new URL(`../../../packages/protocol/test/fixtures/maps/${name}`, import.meta.url), 'utf8');

/** Decode the PNGs encodePng writes (RGBA, filter 0): { width, height, rgba }. */
function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([data[8], data[9]], [8, 6], '8-bit RGBA');
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0, 'filter type 0');
    rgba.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, rgba };
}

test('png: what encodePng writes decodes to the same pixels', async () => {
  const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) % 256);
  const png = decodePng(await encodePng(3, 2, rgba));
  assert.deepEqual([png.width, png.height], [3, 2]);
  assert.deepEqual([...png.rgba], [...rgba]);
});

test('the list names tags and thumbnails; the thumbnail is the map data drawn one pixel per cell', async () => {
  const db = new FakeD1();
  const p = await prepareMap(fixture('format2-setup.webra-map.json'));
  const stored = await storeMap(db, p, { listed: true });
  const list = await (await listMaps({ DB: db })).json();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].tags, ['2 players', 'river crossing']);
  assert.equal(list[0].thumbnail, `/api/maps/${stored.id}/thumbnail.png?v=${p.hash.slice(0, 16)}`);
  const res = await getMapThumbnail({ DB: db }, stored.id);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /public/);
  const png = decodePng(new Uint8Array(await res.arrayBuffer()));
  const want = mapThumbnail(parseMap(fixture('format2-setup.webra-map.json')).map);
  assert.deepEqual([png.width, png.height], [want.width, want.height]);
  assert.deepEqual([...png.rgba], [...want.rgba]);
  // Spawn 2's yard in the colour its slot sets (red, colour 1), and the APC of spawn 2 too.
  const at = (x, y) => [...png.rgba.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
  assert.deepEqual(at(26, 26), [230, 64, 51]);
  assert.deepEqual(at(22, 22), [230, 64, 51]);
  await assert.rejects(getMapThumbnail({ DB: db }, 'nope'), (e) => e instanceof HttpError && e.status === 404);
  await assert.rejects(getMapThumbnail({ DB: db }, '0123456789abcdef'), (e) => e instanceof HttpError && e.status === 404);
});

test('stored maps describe their game setup for lobbies, checked like the protocol checks it', async () => {
  const db = new FakeD1();
  const p = await prepareMap(fixture('format2-setup.webra-map.json'));
  const summary = await storeMap(db, p, { listed: false });
  assert.deepEqual(summary.setup.lockedOptions, ['techLevel']);
  assert.deepEqual(summary.setup.options, { crates: false, startingCash: 10000, techLevel: 'medium' });
  assert.equal(summary.setup.players[1].bot, 'turtle');
  const { created: _c, ...ref } = summary;
  assert.deepEqual(validMapRef(ref, 'map', true).setup, summary.setup, 'the lobby message carries it as it is');
  assert.throws(() => validMapRef({ ...ref, setup: { ...summary.setup, lockedOptions: ['fog'] } }, 'map', true), /lockedOptions/);
  assert.throws(() => validMapRef({ ...ref, setup: { ...summary.setup, players: [{}, {}, {}] } }, 'map', true), /players lists 3/);
});
