import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalMapJson,
  DEFAULT_OPTIONS,
  encodeReplay,
  parseMap,
  parseReplay,
  REPLAY_FORMAT,
  REPLAY_HASH_INTERVAL,
  REPLAY_MAX_BYTES,
  REPLAY_VERSION,
  replayOptions,
  sha256Hex,
  validateReplay,
} from '../src/index.js';

const OPTIONS = {
  ...DEFAULT_OPTIONS,
  players: [
    { slot: 0, type: 'human', name: 'Me', faction: 'germany', color: 2, team: 0 },
    { slot: 1, type: 'ai', difficulty: 'hard', faction: 'russia', color: 0, team: 0 },
  ],
};

const base = () => ({
  format: REPLAY_FORMAT,
  version: REPLAY_VERSION,
  kind: 'replay',
  mode: 'skirmish',
  engine: '0.3.0+abcdef12',
  createdAt: 1_760_000_000_000,
  title: 'Skirmish vs Computer',
  options: OPTIONS,
  map: null,
  mapHash: null,
  player: 0,
  ticks: 600,
  frames: [
    [12, [[0, [{ o: 'move', player: 0, ids: [3, 4], x: 1000, y: 2000, attack_move: false }]]]],
    [300, [[0, [{ o: 'stop', player: 0, ids: [3] }]]]],
  ],
  hashes: [
    [250, '0123456789abcdef'],
    [500, 'fedcba9876543210'],
  ],
});

const check = async (r) => parseReplay(typeof r === 'string' ? r : JSON.stringify(r));

test('a valid replay round trips', async () => {
  const r = await check(base());
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.replay, base());
  assert.deepEqual(JSON.parse(encodeReplay(base())), base());
  assert.equal(REPLAY_HASH_INTERVAL % 25, 0);
});

test('saves need their owner and the hash of their last tick', async () => {
  const save = { ...base(), kind: 'save', hashes: [[250, 'aa'], [600, 'bb']] };
  assert.ok((await check(save)).ok);
  assert.match((await check({ ...save, hashes: [[250, 'aa']] })).error, /last tick/);
  assert.match((await check({ ...save, player: 1 })).error, /human player/);
  assert.match((await check({ ...save, player: null })).error, /human player/);
  assert.match((await check({ ...save, mode: 'online' })).error, /skirmish/);
});

test('hostile or broken files are refused with a message', async () => {
  const cases = [
    ['{', /valid JSON/],
    ['[]', /not a WebRA/],
    [JSON.stringify({ ...base(), format: 'other' }), /not a WebRA/],
    [JSON.stringify({ ...base(), version: 2 }), /version 2/],
    [JSON.stringify({ ...base(), extra: 1 }), /unknown field/],
    [JSON.stringify({ ...base(), engine: 'v 1' }), /engine/],
    [JSON.stringify({ ...base(), ticks: -1 }), /ticks/],
    [JSON.stringify({ ...base(), ticks: 1e9 }), /ticks/],
    [JSON.stringify({ ...base(), player: 2 }), /player/],
    [JSON.stringify({ ...base(), frames: [[700, [[0, []]]]] }), /tick/],
    [JSON.stringify({ ...base(), frames: [[5, [[0, []]]], [5, [[0, []]]]] }), /increase/],
    [JSON.stringify({ ...base(), frames: [[5, []]] }), /empty/],
    [JSON.stringify({ ...base(), frames: [[5, [[3, []]]]] }), /player 3/],
    [JSON.stringify({ ...base(), frames: [[5, [[0, [{ o: 'place', player: 0, ty: 5000, cx: 1, cy: 1 }]]]]] }), /ty/],
    [JSON.stringify({ ...base(), frames: [[5, [[0, [{ o: 'stop', player: 0, ids: [], __proto__x: 1 }]]]]] }), /unknown field/],
    [JSON.stringify({ ...base(), hashes: [[0, 'aa']] }), /ticks/],
    [JSON.stringify({ ...base(), hashes: [[250, 'ZZ']] }), /hash/],
    [JSON.stringify({ ...base(), options: { ...OPTIONS, players: [OPTIONS.players[0]] } }), /players/],
    [JSON.stringify({ ...base(), title: '' }), /title/],
    [JSON.stringify({ ...base(), mapHash: 'a'.repeat(64) }), /mapHash/],
    [JSON.stringify({ ...base(), map: '{"format":1}' }), /map/],
  ];
  for (const [raw, re] of cases) {
    const r = await check(raw);
    assert.equal(r.ok, false, raw.slice(0, 80));
    assert.match(r.error, re, raw.slice(0, 80));
  }
  const huge = await check(' '.repeat(REPLAY_MAX_BYTES + 1));
  assert.match(huge.error, /larger than/);
  assert.throws(() => encodeReplay({ ...base(), kind: 'demo' }));
});

test('maps are stored canonical and hash checked', async () => {
  const w = 32;
  const terrain = Buffer.alloc(w * w).toString('base64');
  const r = parseMap(JSON.stringify({ format: 1, name: 'Tiny', author: 'T', width: w, height: w, terrain, ore: terrain, spawns: [[2, 2], [20, 20]] }));
  assert.ok(r.ok);
  const map = canonicalMapJson(r.map);
  const mapHash = await sha256Hex(map);
  assert.ok((await check({ ...base(), map, mapHash })).ok);
  assert.match((await check({ ...base(), map, mapHash: 'f'.repeat(64) })).error, /does not match/);
  assert.match((await check({ ...base(), map: ` ${map}` })).error, /canonical|JSON/);
  const three = { ...OPTIONS, players: [...OPTIONS.players, { slot: 2, type: 'ai', difficulty: 'easy', faction: 'france', color: 4, team: 0 }] };
  assert.match((await check({ ...base(), map, mapHash, options: three })).error, /room for 2/);
});

test('replayOptions drops closed slots and renumbers like the engine', () => {
  const skirmish = {
    ...DEFAULT_OPTIONS,
    map: null,
    players: [
      { slot: 0, type: 'human', name: 'Me', faction: 'germany', color: 2, team: 0 },
      { slot: 1, type: 'closed' },
      { slot: 2, type: 'ai', difficulty: 'easy', faction: 'russia', color: 0, team: 1 },
    ],
  };
  const out = replayOptions(skirmish);
  assert.deepEqual(out.players.map((p) => [p.slot, p.type, p.color]), [[0, 'human', 2], [1, 'ai', 0]]);
  assert.equal('map' in out, false);
  assert.deepEqual(validateReplay({ ...base(), options: out }).options, out);
  assert.throws(() => replayOptions({ ...skirmish, players: [skirmish.players[0]] }));
});

test('files of another engine build are judged by their header only when the reader names its build', async () => {
  const old = base();
  old.options = { ...OPTIONS };
  delete old.options.mapStyle; // written before the option existed
  // Strict without a build to compare: the settings do not follow this build's rules.
  assert.equal((await check(old)).ok, false);
  const r = await parseReplay(JSON.stringify(old), { version: '0.6.0+12345678' });
  assert.deepEqual(r, {
    ok: true,
    foreign: true,
    replay: { format: REPLAY_FORMAT, version: REPLAY_VERSION, kind: 'replay', mode: 'skirmish', engine: '0.3.0+abcdef12', createdAt: old.createdAt, title: old.title },
  });
  // The same build: validated in full, so the missing option is an error.
  const same = await parseReplay(JSON.stringify(old), { version: '0.3.0+abcdef12' });
  assert.equal(same.ok, false);
  assert.match(same.error, /mapStyle/);
  // A broken header is still refused, whatever the build.
  assert.equal((await parseReplay(JSON.stringify({ ...old, engine: 'not a version!' }), { version: 'x' })).ok, false);
  assert.equal((await parseReplay(JSON.stringify({ ...old, kind: 'movie' }), { version: '0.6.0+12345678' })).ok, false);
});
