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
  replaySummary,
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
  // An online save needs the server's record (see the online save tests below).
  assert.match((await check({ ...save, mode: 'online' })).error, /online must be an object/);
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

// ---- Online saves (protocol 6) ------------------------------------------------------------------

const onlineSave = (patch = {}) => ({ ...base(), kind: 'save', mode: 'online', ticks: 501, hashes: [[250, 'aa'], [501, 'bb']], online: { id: '0123456789abcdef' }, ...patch });

test('online saves name the server record and follow a hash tick', async () => {
  const r = await check(onlineSave());
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.replay.online, { id: '0123456789abcdef' });
  assert.deepEqual(JSON.parse(encodeReplay(onlineSave())).online, { id: '0123456789abcdef' });
  assert.match((await check(onlineSave({ online: undefined }))).error, /online must be an object/);
  assert.match((await check(onlineSave({ online: { id: 'xyz' } }))).error, /online.id/);
  assert.match((await check(onlineSave({ online: { id: '0123456789abcdef', url: '/x' } }))).error, /unknown field/);
  assert.match((await check(onlineSave({ ticks: 500, hashes: [[500, 'bb']] }))).error, /hash tick/);
  // Skirmish saves and replays carry no online record.
  assert.match((await check({ ...base(), online: { id: '0123456789abcdef' } })).error, /only online saves/);
  assert.match((await check({ ...onlineSave(), mode: 'skirmish' })).error, /only online saves/);
  // A replay of an online game stays a replay.
  assert.ok((await check({ ...base(), mode: 'online' })).ok);
});

test('frames and options digests depend on the validated content only', async () => {
  const { framesDigest, optionsDigest } = await import('../src/index.js');
  const frames = base().frames;
  const reordered = frames.map(([t, o]) => [t, o.map(([p, list]) => [p, list.map((x) => Object.fromEntries(Object.entries(x).reverse()))])]);
  assert.equal(await framesDigest(reordered), await framesDigest(frames), 'key order does not matter');
  assert.notEqual(await framesDigest(frames.slice(1)), await framesDigest(frames));
  await assert.rejects(framesDigest([[1, [[0, [{ o: 'nope', player: 0 }]]]]]));
  assert.equal(await optionsDigest(OPTIONS), await optionsDigest(structuredClone(OPTIONS)));
  assert.notEqual(await optionsDigest({ ...OPTIONS, seed: OPTIONS.seed + 1 }), await optionsDigest(OPTIONS));
});

test('the frames digest chains frame by frame; files are bounded by bytes and by orders', async () => {
  const { FramesDigest, framesDigest, sha256Hex } = await import('../src/index.js');
  const frames = base().frames;
  // The definition: h0 = SHA-256(''), h = SHA-256(h + JSON([tick, orders])).
  let h = await sha256Hex('');
  for (const f of frames) h = await sha256Hex(h + JSON.stringify(f));
  assert.equal(await framesDigest(frames), h);
  const d = new FramesDigest();
  for (const f of frames) await d.add(f);
  assert.equal(d.value(), h, 'incremental and whole agree');
  await assert.rejects(d.add(frames[0]), /increase/);
  // Size limits for an upload, and an orders budget counted while validating.
  const text = JSON.stringify(onlineSave());
  assert.match((await parseReplay(text, { maxBytes: 100 })).error, /larger/);
  const r = await parseReplay(text, { maxFrameBytes: 60 });
  assert.deepEqual([r.ok, r.code], [false, 'too_large']);
  assert.ok((await parseReplay(text, { maxFrameBytes: 10_000 })).ok);
});

// ---- Campaign missions (src/mission.js) --------------------------------------------------

const missionReplay = () => ({
  ...base(),
  mode: 'mission',
  title: '01: In the Thick of It',
  options: { seed: 7, gameSpeed: 'normal', options: { difficulty: 'hard' } },
  mission: { id: 'allies-01', hash: 'a'.repeat(64) },
});

test('mission replays and saves name their mission file and options', async () => {
  const r = await check(missionReplay());
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.replay, missionReplay());
  const save = { ...missionReplay(), kind: 'save', hashes: [[250, 'aa'], [600, 'bb']] };
  assert.ok((await check(save)).ok);
});

test('mission records are checked strictly', async () => {
  const bad = [
    { ...missionReplay(), mission: undefined },
    { ...missionReplay(), mission: { id: 'Allies 01', hash: 'a'.repeat(64) } },
    { ...missionReplay(), mission: { id: 'allies-01', hash: 'xyz' } },
    { ...missionReplay(), mission: { id: 'allies-01', hash: 'a'.repeat(64), extra: 1 } },
    { ...missionReplay(), player: 1 },
    { ...missionReplay(), options: OPTIONS },
    { ...missionReplay(), options: { seed: 7, gameSpeed: 'warp', options: {} } },
    { ...missionReplay(), options: { seed: 7, gameSpeed: 'normal', options: { difficulty: 'very hard' } } },
    { ...missionReplay(), options: { seed: 7, gameSpeed: 'normal', options: Object.fromEntries([...Array(9)].map((_, i) => [`k${i}`, 'v'])) } },
    { ...missionReplay(), frames: [[12, [[1, [{ o: 'stop', player: 1, ids: [3] }]]]]] },
    { ...base(), mission: { id: 'allies-01', hash: 'a'.repeat(64) } },
  ];
  for (const r of bad) assert.equal((await check(r)).ok, false, JSON.stringify(r).slice(0, 200));
});

test('online co-op missions carry their mission and options', async () => {
  const { COOP_MISSIONS } = await import('../src/index.js');
  const m = COOP_MISSIONS.find((x) => x.id === 'evacuation');
  const coop = {
    ...base(),
    mode: 'online',
    options: { ...OPTIONS, players: OPTIONS.players.map((p) => ({ ...p, type: 'human', name: `P${p.slot}`, difficulty: undefined })).map(({ difficulty: _d, ...p }) => p) },
    mission: { id: 'evacuation', hash: m.hash, options: { difficulty: 'easy' } },
  };
  const r = await check(coop);
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.replay.mission, { id: 'evacuation', hash: m.hash, options: { difficulty: 'easy' } });
  for (const bad of [
    { ...coop, mission: { ...coop.mission, hash: 'b'.repeat(64) } },
    { ...coop, mission: { ...coop.mission, id: 'allies-01' } },
    { ...coop, mission: { ...coop.mission, options: { difficulty: 'tough' } } },
    { ...coop, options: OPTIONS },
  ]) {
    assert.equal((await check(bad)).ok, false, JSON.stringify(bad.mission));
  }
});

test('replaySummary: what an account replay list shows', async () => {
  const plain = replaySummary((await check(base())).replay);
  assert.deepEqual(plain, {
    mode: 'skirmish',
    title: 'Skirmish vs Computer',
    engine: '0.3.0+abcdef12',
    playedAt: 1_760_000_000_000,
    ticks: 600,
    mapName: 'Generated map',
    players: [
      { name: 'Me', type: 'human', faction: 'germany', team: 0 },
      { name: null, type: 'ai', faction: 'russia', team: 0 },
    ],
  });
  const w = 32;
  const terrain = Buffer.alloc(w * w).toString('base64');
  const map = canonicalMapJson(parseMap(JSON.stringify({ format: 1, name: 'Tiny', author: 'T', width: w, height: w, terrain, ore: terrain, spawns: [[2, 2], [20, 20]] })).map);
  assert.equal(replaySummary((await check({ ...base(), map, mapHash: await sha256Hex(map) })).replay).mapName, 'Tiny');
  const mission = replaySummary((await check(missionReplay())).replay);
  assert.equal(mission.mapName, missionReplay().mission.id);
  assert.deepEqual(mission.players, [], 'a campaign mission lists no players');
});
