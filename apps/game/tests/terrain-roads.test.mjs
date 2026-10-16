// Roads, bridges and their shores in the original graphics' tile terrain
// (js/content/terrain.js planTerrain), on a small synthetic tileset made
// here: road templates whose tiles say by their pixels where their road
// runs (straight pieces with their verges, corners, ends, T-joins, a
// crossing), wet shore tiles, a beach and a diagonal bridge template. No EA
// files: every pixel is drawn by this test. Also the map editor's stand-in
// tiles (editor/js/tiles.js InstalledTiles), which a finished plan replaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRY_CENTRE,
  LAND_CENTRE,
  ROAD_PROFILE,
  planTerrain,
  roadDistance,
  roadLevel,
  roadPalette,
  roadTargets,
  templatePools,
} from '../js/content/terrain.js';
import { InstalledTiles, planTiles } from '../editor/js/tiles.js';
import { originalTerrain, theaterFiles } from '../js/content/terrain.js';
import { GROUND, SAND, WATERPX, buildTmpRa, syntheticTheater, tilePx } from './content-fixtures.mjs';

const ROADPX = (x, y) => 60 + ((x * 5 + y) % 4);
const DECKPX = (x, y) => 70 + ((x + y * 3) % 4);
const SIDE = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/** Distance from (px, py) to the segment (ax, ay)-(bx, by). */
function segment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** 4 x 4 ordered dithering thresholds (0 .. 1): a pixel is road where the road level passes its threshold. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const dithered = (level) => tilePx((x, y) => (level((x + 0.5) / 24, (y + 0.5) / 24) > BAYER[(y % 4) * 4 + (x % 4)] ? ROADPX(x, y) : GROUND(x, y)));

/**
 * A road tile drawn like Red Alert's: the road fills the cell along the
 * lines from its middle to the middles of the cells beside it through the
 * sides in `exits` ('NES'...) and fades out at the sides without one
 * (ROAD_PROFILE, dithered).
 */
function roadTile(exits) {
  return dithered((u, v) => roadLevel(Math.min(...[...exits].map((s) => segment(u, v, 0.5, 0.5, 0.5 + SIDE[s][0], 0.5 + SIDE[s][1])))));
}

/** A verge: grass where the road beside it, through side `side`, fades out. */
function vergeTile(side) {
  return dithered((u, v) => roadLevel(0.5 + { N: v, E: 1 - u, S: 1 - v, W: u }[side]));
}

/** Open water with sand along `side` (4 pixels): the water's edge toward a bank. */
function bankTile(side) {
  return tilePx((x, y) => ({ N: y, E: 23 - x, S: 23 - y, W: x }[side] < 4 ? SAND(x, y) : WATERPX(x, y)));
}

/** Sand on top, water below from row `from` (a land cell's beach). */
const beachTile = (from) => tilePx((x, y) => (y >= from ? WATERPX(x, y) : SAND(x, y)));

/**
 * A 3 x 3 diagonal bridge: its deck runs from the bottom edge of the
 * bottom-left cell to the top edge of the top-right cell, over water.
 */
function bridgeTiles() {
  const tiles = [];
  for (let c = 0; c < 9; c++) {
    const ox = (c % 3) * 24;
    const oy = Math.floor(c / 3) * 24;
    tiles.push(
      tilePx((x, y) => {
        // The deck's centre line from (12, 72) to (60, 0) in template pixels, 10 pixels either side.
        const d = segment(ox + x, oy + y, 12, 84, 60, -12);
        return d <= 10 ? DECKPX(x, y) : WATERPX(x, y);
      }),
    );
  }
  return tiles;
}

/** Road templates by name: per tile its exits ('NS'), or `v` + the side its verge has the road on. */
const ROADS = {
  vroad: { width: 3, height: 1, tiles: ['vE', 'NS', 'vW'], road: [1] },
  hroad: { width: 1, height: 3, tiles: ['vS', 'EW', 'vN'], road: [1] },
  ne: 'NE',
  nw: 'NW',
  se: 'SE',
  sw: 'SW',
  endn: 'N',
  ends: 'S',
  ende: 'E',
  endw: 'W',
  teen: 'NEW',
  tees: 'ESW',
  teee: 'NES',
  teew: 'NSW',
  cross: 'NESW',
};

/** The synthetic tileset: `{ info, sprite, exits }` (`exits` per tile key: what the tile was drawn as). */
function syntheticRoads() {
  const images = [];
  const templates = [];
  const frames = new Map();
  const exits = new Map();
  const add = (name, width, height, role, tiles, road = null) => {
    const img = images.length;
    images.push(name);
    frames.set(name, tiles);
    templates.push([img, width, height, role, tiles.map((t, k) => (t ? k : -1)).filter((k) => k >= 0), ...(road ? [road] : [])]);
  };
  add('clear.syn', 1, 1, 'clear', [tilePx(GROUND)]);
  add('water.syn', 1, 1, 'water', [tilePx(WATERPX)]);
  add('bank.syn', 4, 1, 'shore', ['N', 'E', 'S', 'W'].map(bankTile));
  // Beaches for land cells: sand over water from row 16, and with a little water in the middle too (wet, not dry).
  add('beach.syn', 3, 1, 'shore', [beachTile(16), tilePx((x, y) => (y >= 16 || (y >= 15 && x >= 8 && x < 16) ? WATERPX(x, y) : SAND(x, y))), beachTile(8)]);
  for (const [name, def] of Object.entries(ROADS)) {
    const t = typeof def === 'string' ? { width: 1, height: 1, tiles: [def], road: [0] } : def;
    const tiles = t.tiles.map((d) => (d.startsWith('v') ? vergeTile(d[1]) : roadTile(d)));
    t.tiles.forEach((d, k) => exits.set(`${name}.syn#${k}`, d));
    add(`${name}.syn`, t.width, t.height, 'road', tiles, t.road);
  }
  frames.set('bridge.syn', bridgeTiles());
  const sprite = (name) => (frames.has(name) ? { frames: frames.get(name).map((data) => data && { width: 24, height: 24, data }) } : null);
  return { info: { images, templates }, sprite, exits };
}

/** Terrain bytes from rows: . clear, ~ water, = road, b bridge deck, # rock. */
function terrainFrom(rows) {
  const code = { '.': 0, '#': 2, '~': 3, '=': 6, b: 7 };
  const h = rows.length;
  const w = rows[0].length;
  const out = new Uint8Array(w * h * 4);
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    out[(y * w + x) * 4] = code[ch];
    out[(y * w + x) * 4 + 3] = 255;
  }));
  return { terrain: out, w, h };
}

function setup() {
  const roads = syntheticRoads();
  const pools = templatePools(roads.info, roads.sprite);
  assert.ok(pools, 'the synthetic tileset has ground and water');
  /** What the pick of cell (x, y) was drawn as: road exits ('NS'), 'vE' for a verge, else its role. */
  const drawn = (picks, w, x, y) => {
    const p = picks[y * w + x];
    return roads.exits.get(p.key) ?? p.role;
  };
  const bridge = (x, y) => ({ x, y, width: 3, tiles: new Map(roads.sprite('bridge.syn').frames.map((f, c) => [c, pools.read('bridge.syn', c, f.data)])) });
  return { pools, drawn, bridge };
}

const sorted = (s) => [...s].sort().join('');
const meanOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
/** How much road a pick has along `side` (0 north, 1 east, 2 south, 3 west). */
const reach = (p, side) => meanOf(p.road.edges[side]);
/**
 * How far the road along the seams of road cells differs from the road
 * across them: `{ road }` the largest difference between two road cells,
 * `{ side }` the mean between a road cell and the cell beside it. A hard
 * square (a road tile full to its edges beside grass) shows as about 1.
 */
function seamGaps(picks, terrain, w, h) {
  let road = 0;
  let side = 0;
  let sides = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (const [s, dx, dy] of [
        [1, 1, 0],
        [2, 0, 1],
      ]) {
        if (x + dx >= w || y + dy >= h) continue;
        const a = y * w + x;
        const b = (y + dy) * w + x + dx;
        const ra = terrain[a * 4] === 6;
        const rb = terrain[b * 4] === 6;
        if (!ra && !rb) continue;
        let d = 0;
        for (let k = 0; k < 24; k++) d += Math.abs(picks[a].road.edges[s][k] - picks[b].road.edges[(s + 2) % 4][k]);
        d /= 24;
        if (ra && rb) road = Math.max(road, d);
        else {
          side += d;
          sides++;
        }
      }
    }
  }
  return { road, side: sides ? side / sides : 0 };
}

test('roads: their pixels read as road, plain ground as none; the profile fills road cells and fades beside them', () => {
  const road = [{ data: tilePx(ROADPX) }, { data: roadTile('EW') }];
  const ground = [{ data: tilePx(GROUND) }];
  const val = roadPalette(road, ground);
  assert.equal(val[ROADPX(0, 0)], 1);
  assert.equal(val[GROUND(0, 0)], 0);
  assert.ok(val[SAND(0, 0)] > 0 && val[SAND(0, 0)] < 1, 'colours in neither read in between');
  assert.equal(roadPalette([], ground), null);
  assert.equal(roadLevel(0), 1);
  assert.equal(roadLevel(0.4), 1, 'a road fills its cell');
  assert.ok(roadLevel(0.6) > roadLevel(0.7) && roadLevel(0.7) > 0, 'and fades into the verge');
  assert.equal(roadLevel(ROAD_PROFILE.at(-1)[0] + 0.01), 0);
  // The centre line: along a straight road, across a corner only where no cell beside joins it.
  const cells = new Set(['0,0', '0,1', '0,2', '1,3']);
  const at = (x, y) => cells.has(`${x},${y}`);
  assert.equal(roadDistance(0.5, 1.2, at), 0);
  assert.ok(roadDistance(1, 3, at) < 1e-9, 'the diagonal step from (0, 2) to (1, 3)');
  assert.ok(roadDistance(1, 1.5, at) > 0.4, 'no corner cut where (0, 1) joins (0, 0) and (0, 2)');
  assert.equal(roadDistance(5.5, 5.5, at), Infinity);
  // A road cell between road cells to the north and south: road through both edges, fading at the sides.
  const want = roadTargets(0, 1, at);
  assert.ok(want.regions[1] === 1 && want.regions[7] === 1 && want.regions[4] === 1);
  assert.ok(want.edges[0][12] === 1 && want.edges[2][12] === 1);
  assert.ok(want.edges[1][12] < 1 && want.edges[3][12] < 1);
});

test('roads: straight pieces, corners, ends, a T-join and a crossing join up without hard squares; verges line them', () => {
  const { pools, drawn } = setup();
  const { terrain, w, h } = terrainFrom([
    '...........',
    '..=........',
    '..=........',
    '..====.....',
    '.....=.....',
    '..=======..',
    '.....=.....',
    '.....=.....',
    '...........',
  ]);
  const { picks, roads } = planTerrain(terrain, w, h, pools);
  assert.equal(roads.cells, 16);
  assert.equal(roads.fitted, 16, 'every road cell took a road tile');
  assert.ok(roads.templates >= 2, 'straight runs took whole straight templates');
  const at = (x, y) => drawn(picks, w, x, y);
  // A straight run: the whole template, its verges with it.
  assert.deepEqual([1, 2, 3].map((x) => picks[2 * w + x].key), ['vroad.syn#0', 'vroad.syn#1', 'vroad.syn#2']);
  // Corners turn the right way; the crossing has four arms.
  assert.equal(sorted(at(2, 3)), 'EN', 'a corner');
  assert.equal(sorted(at(5, 3)), 'SW', 'the next corner');
  assert.equal(sorted(at(5, 5)), 'ENSW', 'a crossing');
  // The ends round off in their cells (less road at the far side than where the road comes in).
  assert.equal(sorted(at(2, 1)), 'S', 'the road ends at its north end');
  assert.equal(sorted(at(2, 5)), 'E', 'a road end to the west');
  assert.equal(sorted(at(8, 5)), 'W', 'and to the east');
  assert.equal(sorted(at(5, 7)), 'N', 'and to the south');
  for (const [x, y, far] of [
    [2, 1, 0],
    [2, 5, 3],
    [8, 5, 1],
    [5, 7, 2],
  ]) {
    assert.ok(reach(picks[y * w + x], far) < reach(picks[y * w + x], (far + 2) % 4), `the end at ${x},${y} rounds off`);
  }
  // Verges: the clear cells beside the roads have the road's edge on the road's side.
  assert.equal(at(1, 2), 'vE');
  assert.equal(at(3, 2), 'vW');
  assert.equal(at(5, 1), 'clear', 'plain ground away from the roads');
  // No hard edges: road cells join, and the ground beside them meets their verges.
  const gaps = seamGaps(picks, terrain, w, h);
  assert.ok(gaps.road < 0.3 && gaps.side < 0.5, `seams: ${JSON.stringify(gaps)}`);
  for (const p of picks) assert.ok(p, 'every cell has a tile');
  // A T-join keeps its road on three sides and grass on the fourth's verge.
  const t = terrainFrom(['.......', '...=...', '.=====.', '.......']);
  const tee = planTerrain(t.terrain, t.w, t.h, pools);
  for (const side of [0, 1, 3]) assert.ok(reach(tee.picks[2 * t.w + 3], side) > 0.5, `the T-join reaches side ${side}`);
  assert.equal(drawn(tee.picks, t.w, 3, 3), 'vN', 'the verge below the T-join');
  const teeGaps = seamGaps(tee.picks, t.terrain, t.w, t.h);
  assert.ok(teeGaps.road < 0.3 && teeGaps.side < 0.5, `seams: ${JSON.stringify(teeGaps)}`);
  // Without road templates (none installed) road cells stay plain ground rather than a stray tile.
  const bare = templatePools({ images: ['clear.syn', 'water.syn'], templates: [[0, 1, 1, 'clear', [0]], [1, 1, 1, 'water', [0]]] }, syntheticRoads().sprite);
  assert.ok(planTerrain(terrain, w, h, bare).picks.every((p) => p.role === 'clear'));
});

test('roads: a diagonal bridge with roads at both ends; the planned picks under it are its template', () => {
  const { pools, bridge } = setup();
  // A river with a 3 x 3 diagonal bridge (deck cells b) from (4, 3) to (6, 5); roads leave its ends north and south.
  const { terrain, w, h } = terrainFrom([
    '......=......',
    '......=......',
    '......=......',
    '~~~~~~b~~~~~~',
    '~~~~~b~~~~~~~',
    '~~~~b~~~~~~~~',
    '....=........',
    '....=........',
    '....=........',
  ]);
  const { picks, roads } = planTerrain(terrain, w, h, pools, [bridge(4, 3)]);
  for (let c = 0; c < 9; c++) assert.equal(picks[(3 + Math.floor(c / 3)) * w + 4 + (c % 3)].key, `bridge.syn#${c}`, `bridge tile ${c} in place`);
  assert.equal(roads.fitted, roads.cells);
  // The roads run on into the deck's ends: the road cell by each end has road along its side toward the bridge.
  assert.ok(reach(picks[2 * w + 6], 2) > 0.5, 'north of the deck');
  assert.ok(reach(picks[6 * w + 4], 0) > 0.5, 'south of the deck');
  // Straight on away from the bridge, with verges.
  assert.equal(picks[1 * w + 6].template?.image, 'vroad.syn');
  assert.equal(picks[7 * w + 4].template?.image, 'vroad.syn');
  assert.ok(seamGaps(picks, terrain, w, h).road < 0.3);
});

test('shores: open water beside a bridge bank meets it; ground under a tree stays dry', () => {
  const { pools, bridge } = setup();
  // A bridge whose west middle tile has sand along its west edge: the water west of it takes a bank tile.
  const banked = bridge(3, 1);
  const sandy = pools.read('banked.syn', 3, bankTile('W'));
  banked.tiles.set(3, sandy);
  const { terrain, w, h } = terrainFrom(['~~~~~~~', '~~~~~b~', '~~~~b~~', '~~~b~~~', '~~~~~~~']);
  const { picks, coast } = planTerrain(terrain, w, h, pools, [banked]);
  assert.equal(picks[2 * w + 3], sandy);
  assert.equal(picks[2 * w + 2].key, 'bank.syn#1', `west of it a bank with sand toward the bridge: ${picks[2 * w + 2].key}`);
  assert.ok(coast.banks >= 1);
  assert.equal(picks[0].role, 'water', 'open water away from the bridge');
  // A land cell by the water: the wettest beach that fits, unless something stands on it.
  const beach = terrainFrom(['...', '...', '~~~']);
  const open = planTerrain(beach.terrain, beach.w, beach.h, pools);
  const middle = open.picks[1 * beach.w + 1];
  assert.ok(middle.info.regions[4] > DRY_CENTRE && middle.info.regions[4] <= LAND_CENTRE, `a wet beach fits best: ${middle.key} ${middle.info.regions[4]}`);
  const dry = new Uint8Array(beach.w * beach.h);
  dry[1 * beach.w + 1] = 1;
  const stood = planTerrain(beach.terrain, beach.w, beach.h, pools, [], dry).picks[1 * beach.w + 1];
  assert.ok(stood.info.regions[4] <= DRY_CENTRE, `dry under a tree: ${stood.key} ${stood.info.regions[4]}`);
});

test('editor: stand-in tiles of changed cells give way to the finished plan, and new terrain hints plan again', async () => {
  const files = syntheticTheater();
  const theater = { key: 'k', tileset: 'TEMPERAT', files: new Map(theaterFiles('TEMPERAT').filter((n) => files.has(n)).map((n) => [n, files.get(n)])) };
  let ready = 0;
  const tiles = new InstalledTiles({ plan: async (job) => planTiles(job, job.bytes, job.w, job.h, job.hints), ready: () => ready++ });
  const w = 12;
  const h = 10;
  const bytes = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    bytes[i * 4] = i % w < 3 ? 3 : 0;
    bytes[i * 4 + 3] = 255;
  }
  assert.equal(tiles.tiles(theater, bytes, w, h), null, 'nothing planned yet: WebRA tiles');
  await tiles.idle();
  const first = tiles.tiles(theater, bytes, w, h);
  assert.deepEqual([...first.cells], [...planTiles(theater, bytes, w, h).cells]);
  // A road painted across: stand-ins (the most common tile of their type) while the next plan runs.
  const edited = bytes.slice();
  for (let x = 4; x < w; x++) edited[(5 * w + x) * 4] = 6;
  const during = tiles.tiles(theater, edited, w, h);
  assert.ok(tiles.busy, 'the next plan runs');
  const k = (cells, i) => cells[i * 4] + 256 * cells[i * 4 + 1];
  const standIn = k(during.cells, 5 * w + 4);
  for (let x = 4; x < w; x++) assert.equal(k(during.cells, 5 * w + x), standIn, 'every changed road cell shows the same stand-in');
  await tiles.idle();
  const after = tiles.tiles(theater, edited, w, h);
  assert.equal(tiles.standIn, false);
  assert.deepEqual([...after.cells], [...planTiles(theater, edited, w, h).cells], 'the finished plan, no stand-ins left');
  // A tree placed by the water (a terrain hint, no type changes): the last plan stays until the new one is in.
  const hints = { bridges: [], standing: [5 * w + 3] };
  const kept = tiles.tiles(theater, edited, w, h, hints);
  assert.deepEqual([...kept.cells], [...after.cells]);
  assert.ok(tiles.busy, 'the hints are planned');
  await tiles.idle();
  assert.deepEqual([...tiles.tiles(theater, edited, w, h, hints).cells], [...planTiles(theater, edited, w, h, hints).cells]);
  assert.ok(ready >= 3);
});

test('bridges: the terrain hints place a bridge template from the installed files; dead looks and unknown bridges are safe', () => {
  const files = syntheticTheater();
  // BRIDGE1's templates (content/tables.js ACTOR_ART): 5 x 3 cells, deck tiles where the deck is.
  const deck = (k) => (k === 0 || k === 10 || k === 11 || k > 12 ? null : tilePx(DECKPX));
  files.set('bridge1.tem', buildTmpRa(24, 24, Array.from({ length: 15 }, (_, k) => deck(k))));
  files.set('bridge1d.tem', buildTmpRa(24, 24, Array.from({ length: 15 }, (_, k) => (deck(k) ? tilePx(WATERPX) : null))));
  const w = 16;
  const h = 10;
  const bytes = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const y = Math.floor(i / w);
    bytes[i * 4] = y >= 3 && y <= 6 ? 3 : 0;
    bytes[i * 4 + 3] = 255;
  }
  const read = new Set();
  const getFile = (n) => (read.add(n), files.get(n) ?? null);
  const plain = originalTerrain(getFile, 'TEMPERAT', bytes, w, h);
  const hints = { bridges: [{ type: 'BRIDGE1', x: 5, y: 3, look: 'healthy' }, { type: 'NOPE', x: 1, y: 1 }, { type: 'BRIDGE1', x: 'x', y: 0 }], standing: [-1, 3, 1e9] };
  const bridged = originalTerrain(getFile, 'TEMPERAT', bytes, w, h, hints);
  // The pixels of a cell's tile in the atlas (tile indexes follow the order tiles are first used).
  const tileAt = (r, x, y) => {
    const k = r.cells[(y * w + x) * 4] + 256 * r.cells[(y * w + x) * 4 + 1];
    const row = (Math.floor(k / 16) * 24 + 5) * r.atlas.width + (k % 16) * 24;
    return [...r.atlas.data.slice(row * 4, (row + 24) * 4)].join(',');
  };
  assert.notEqual(tileAt(bridged, 7, 3), tileAt(plain, 7, 3), 'the deck tile lies under the bridge');
  assert.equal(tileAt(bridged, 0, 0), tileAt(plain, 0, 0), 'far from the bridge nothing changes');
  // A destroyed bridge: its own template.
  const dead = originalTerrain(getFile, 'TEMPERAT', bytes, w, h, { bridges: [{ type: 'BRIDGE1', x: 5, y: 3, look: 'destroyed' }] });
  assert.notEqual(tileAt(dead, 7, 3), tileAt(bridged, 7, 3));
  // Everything read is a file the editor's tile worker is given.
  const listed = new Set(theaterFiles('TEMPERAT'));
  for (const n of read) assert.ok(listed.has(n), `${n} is listed`);
  assert.ok(listed.has('bridge1d.tem') && listed.has('br3a.tem'));
});
