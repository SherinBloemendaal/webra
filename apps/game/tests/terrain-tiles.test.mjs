// Tile terrain (js/content/terrain.js originalTerrain) picks the same tiles
// as before it was made faster (the seam cache, the early stop of a tile's
// score and tile pixels made once per tile): digests of the cells, the
// atlas and the report taken with the code of commit 20d30ab, on synthetic
// terrain and synthetic theaters (no EA files). No engine build needed.
// Roads got their own fitting later (road templates and verges): the map
// without its road keeps the digests of before (GOLDEN_NO_ROAD, the same
// with the code before and after that change), the map with it has new
// ones (GOLDEN).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { originalTerrain } from '../js/content/terrain.js';
import { syntheticTheater } from './content-fixtures.mjs';

/** Deterministic land and water with coasts, rough, rock and (unless `road` is false) a road: a map's terrain bytes. */
function syntheticTerrain(w, h, road = true) {
  const t = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.hypot(x - w / 2, y - h / 2) + 4 * Math.sin(x / 3) + 3 * Math.cos(y / 4);
      let v = d < w / 3 ? 0 : 3;
      if (v === 0 && (x * 7 + y * 13) % 29 === 0) v = 2;
      if (v === 0 && (x * 5 + y * 3) % 23 === 0) v = 1;
      if (road && v === 0 && Math.abs(x - y) < 1) v = 6;
      t[i] = v;
      t[i + 3] = 255;
    }
  }
  return t;
}

/** The report's fields from before roads were fitted (the road counts came with them). */
const OLD_REPORT = ['tiles', 'overflow', 'trees', 'coast', 'beach', 'smudges'];
const digest = (r, fields = null) =>
  createHash('sha256')
    .update(r.cells)
    .update(r.atlas.data)
    .update(JSON.stringify(r.report, fields))
    .digest('hex')
    .slice(0, 16);

/** Digests per theater: with the road (since roads are fitted), and without it (from before the speed-ups). */
const GOLDEN = { TEMPERAT: '1f1cd10ab8228ebb', SNOW: '97e3938b803a285f', DESERT: '660d36074898c765' };
const GOLDEN_NO_ROAD = { TEMPERAT: '73bd6b92cbd50f4c', SNOW: '6c1564d9080c658d', DESERT: 'ce40b61a8b56d45d' };

for (const [tileset, golden] of Object.entries(GOLDEN)) {
  test(`tile terrain picks the same tiles as before it got faster (${tileset})`, () => {
    const files = syntheticTheater(tileset);
    const w = 72;
    const h = 64;
    const r = originalTerrain((n) => files.get(n) ?? null, tileset, syntheticTerrain(w, h), w, h);
    assert.ok(r, 'the synthetic theater is complete');
    assert.ok(r.report.coast > 100, 'the map has a coast to fit');
    assert.ok(r.report.beach > 0, 'beach tiles were fitted');
    assert.equal(r.report.roadsFitted, r.report.roads, 'every road cell took a road tile');
    assert.equal(digest(r), golden);
    const bare = originalTerrain((n) => files.get(n) ?? null, tileset, syntheticTerrain(w, h, false), w, h);
    assert.equal(digest(bare, OLD_REPORT), GOLDEN_NO_ROAD[tileset], 'without the road: the tiles of before');
  });
}
