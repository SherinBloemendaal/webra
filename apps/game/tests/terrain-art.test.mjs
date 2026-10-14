// Terrain art (js/art/terrain.js): the tile atlas of every biome and the
// per-cell tile layer the terrain shader reads. Pure pixels, no canvas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ATLAS_COLS, BIOMES, DECALS, SHADOW, T, TILE, TILES, buildTerrainAtlas, cellTiles, palette, terrainSeed } from '../js/art/terrain.js';

const pixel = (atlas, tile, x, y) => {
  const ox = (tile % ATLAS_COLS) * TILE + x;
  const oy = Math.floor(tile / ATLAS_COLS) * TILE + y;
  const o = (oy * atlas.width + ox) * 4;
  return [...atlas.data.slice(o, o + 4)];
};
const lum = (p) => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
const meanLum = (atlas, tile, x0, y0, x1, y1) => {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) sum += lum(pixel(atlas, tile, x, y));
  return sum / n;
};

test('every biome has a complete, deterministic atlas', () => {
  for (const biome of BIOMES) {
    const a = buildTerrainAtlas(biome);
    assert.equal(a.width, ATLAS_COLS * TILE);
    assert.equal(a.height, Math.ceil(TILES.COUNT / ATLAS_COLS) * TILE);
    assert.equal(a.data.length, a.width * a.height * 4);
    assert.deepEqual(buildTerrainAtlas(biome).data, a.data, `${biome} is deterministic`);
    // Every ground, rock, water, ford and tree tile is opaque; decals have see-through parts.
    for (let t = 0; t < TILES.DECAL; t++) {
      for (const [x, y] of [[0, 0], [TILE - 1, TILE - 1], [16, 16]]) assert.equal(pixel(a, t, x, y)[3], 255, `${biome} tile ${t}`);
    }
    for (let k = 0; k < DECALS; k++) assert.equal(pixel(a, TILES.DECAL + k, 0, 0)[3], 0, `${biome} decal ${k} corner`);
  }
  assert.notDeepEqual(buildTerrainAtlas('snow').data, buildTerrainAtlas('desert').data);
  assert.deepEqual(buildTerrainAtlas('lava').data, buildTerrainAtlas('temperate').data, 'unknown biomes fall back');
  assert.ok(lum(palette('snow').ground[0]) > lum(palette('temperate').ground[1]), 'snow is bright');
});

test('rock is a raised plateau lit from the top left', () => {
  const a = buildTerrainAtlas('desert');
  const lone = TILES.ROCK; // no rock neighbours: every edge open
  const top = meanLum(a, lone, 8, 8, 20, 18);
  const southFace = meanLum(a, lone, 6, 24, 22, 30);
  const eastFace = meanLum(a, lone, 27, 6, 31, 18);
  const northRim = meanLum(a, lone, 6, 2, 22, 4);
  assert.ok(southFace < top * 0.85, `south cliff face in shadow: ${southFace} vs top ${top}`);
  assert.ok(eastFace < top * 0.8, `east face darker: ${eastFace}`);
  assert.ok(northRim > top, `lit rim on the north edge: ${northRim}`);
  // Rock on every side: no faces, one continuous top.
  const inner = TILES.ROCK + 15;
  assert.ok(meanLum(a, inner, 6, 24, 22, 30) > southFace * 1.2);
});

test('the cell layer picks tiles, masks, decals, depth and shadow', () => {
  const w = 8;
  const h = 6;
  const types = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 2, 2, 0, 3, 3, 3, 0,
    0, 2, 2, 0, 3, 3, 3, 0,
    0, 0, 0, 0, 3, 3, 3, 0,
    1, 1, 4, 0, 5, 5, 5, 0,
    1, 1, 4, 0, 0, 0, 0, 0,
  ];
  const bytes = new Uint8Array(w * h * 4);
  types.forEach((t, i) => {
    bytes[i * 4] = t;
    bytes[i * 4 + 3] = 255;
  });
  const cells = cellTiles(bytes, w, h, 7);
  const at = (x, y) => cells.slice((y * w + x) * 4, (y * w + x) * 4 + 4);
  // Rock at 1,1: rock east (2) and south (4).
  assert.equal(at(1, 1)[0], TILES.ROCK + 2 + 4);
  // Ground below and right of the rock gets its shadow.
  assert.equal(at(1, 3)[3] & SHADOW.N, SHADOW.N);
  assert.equal(at(3, 1)[3] & SHADOW.W, SHADOW.W);
  assert.equal(at(3, 3)[3], SHADOW.NW);
  assert.equal(at(1, 1)[3], 0, 'rock itself is not shadowed');
  // Water: the middle cell of the lake is deeper than its shore; ford rows count as wet.
  assert.ok(at(5, 2)[2] > at(4, 1)[2], "the middle of the lake is deeper");
  assert.equal(at(4, 1)[0], TILES.WATER + (2 | 4), 'top-left water cell: water east and south');
  assert.equal(at(5, 3)[0], TILES.WATER + 15, 'ford below counts as water');
  assert.equal(at(5, 4)[0], TILES.FORD + (1 | 2 | 8), 'ford: water north, ford east and west');
  assert.ok(at(4, 1)[2] > 0, 'water next to land is shallow but not zero');
  // Ground, rough and trees use their variants; decals only on open ground and rough.
  assert.ok(at(0, 4)[0] >= TILES.ROUGH && at(0, 4)[0] < TILES.ROUGH + 4);
  assert.ok(at(2, 4)[0] >= TILES.TREE && at(2, 4)[0] < TILES.TREE + 4);
  for (let i = 0; i < w * h; i++) {
    if (cells[i * 4 + 1] > 0) assert.ok(types[i] === T.CLEAR || types[i] === T.ROUGH, `decal on terrain ${types[i]}`);
  }
  assert.deepEqual(cellTiles(bytes, w, h, 7), cells, 'deterministic');
});

test('decals are scattered on a few percent of open ground', () => {
  const w = 64;
  const h = 64;
  const bytes = new Uint8Array(w * h * 4);
  const cells = cellTiles(bytes, w, h, 1);
  const decals = Array.from({ length: w * h }, (_, i) => cells[i * 4 + 1]).filter((d) => d > 0);
  assert.ok(decals.length > w * h * 0.04 && decals.length < w * h * 0.12, `${decals.length} decals`);
  assert.ok(new Set(decals).size >= 5, 'several kinds');
  assert.notDeepEqual(cellTiles(bytes, w, h, 2), cells, 'another map, other decals');
});

test('the cell layer of a mixed map is the one it has always been (every type, edges, seeded decals)', () => {
  // Patches of every terrain type with lone cells between them, 97 x 61.
  const w = 97;
  const h = 61;
  const b = new Uint8Array(w * h * 4);
  let s = 7;
  const rnd = (n) => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) % n);
  for (let i = 0; i < w * h; i++) {
    b[i * 4] = rnd(10) < 7 && i > 0 ? b[(i - (rnd(2) ? 1 : w > i ? 1 : w)) * 4] : rnd(11);
    b[i * 4 + 1] = rnd(256);
    b[i * 4 + 3] = 255;
  }
  assert.equal(terrainSeed(b), 4090478341);
  // Hash of the layer as cellTiles made it before it was made quicker (the same bytes since).
  assert.equal(createHash('sha256').update(cellTiles(b, w, h, terrainSeed(b))).digest('hex').slice(0, 16), '20fd7beac2f0cb45');
});
