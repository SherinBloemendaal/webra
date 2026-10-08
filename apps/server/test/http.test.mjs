import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  hashHostKey,
  hashPassword,
  randomInt,
  randomToken,
  timingSafeEqual,
  verifyHostKey,
  verifyPassword,
} from '../src/crypto.js';
import { checkOrigin, HttpError, readJson, readText } from '../src/http.js';
import { prepareMap } from '../src/maps.js';
import { cheatsAllowed, ordersFitRules, validateCreateSession } from '../src/validate.js';
import { DEFAULT_OPTIONS, HOST_KEY_RE, parseClientMessage } from '@webra/protocol';

const ENGINE_RULES = JSON.parse(readFileSync(new URL('../../../engine/rules.json', import.meta.url), 'utf8'));

test('passwords: salted PBKDF2, constant-time verify', async () => {
  const rec = await hashPassword('hunter2', 1000);
  assert.match(rec.salt, /^[0-9a-f]{32}$/);
  assert.match(rec.hash, /^[0-9a-f]{64}$/);
  assert.equal(await verifyPassword('hunter2', rec), true);
  assert.equal(await verifyPassword('hunter3', rec), false);
  const again = await hashPassword('hunter2', 1000);
  assert.notEqual(again.hash, rec.hash, 'salted');
  const full = await hashPassword('x');
  assert.equal(full.iterations, 100_000);
});

test('host keys: random, hashed, verified', async () => {
  const key = randomToken();
  assert.match(key, HOST_KEY_RE);
  const stored = await hashHostKey(key);
  assert.equal(await verifyHostKey(key, stored), true);
  assert.equal(await verifyHostKey(randomToken(), stored), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])), false);
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const v = randomInt(3);
    assert.ok(v >= 0 && v < 3);
    seen.add(v);
  }
  assert.equal(seen.size, 3);
});

const req = (url, init) => new Request(url, init);

test('same-origin checks', () => {
  const url = 'https://webra.sherin.dev/api/sessions';
  checkOrigin(req(url), { required: false });
  checkOrigin(req(url, { method: 'POST', headers: { Origin: 'https://webra.sherin.dev' } }), { required: true });
  for (const headers of [{ Origin: 'https://evil.example' }, {}, { Origin: 'https://webra.sherin.dev', 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.throws(
      () => checkOrigin(req(url, { method: 'POST', headers }), { required: true }),
      (e) => e instanceof HttpError && e.status === 403,
    );
  }
  assert.throws(() => checkOrigin(req(url, { headers: { Origin: 'null' } }), { required: false }), HttpError);
});

test('bodies are size capped and must be JSON', async () => {
  const post = (body, headers = { 'Content-Type': 'application/json' }) => req('https://x/api', { method: 'POST', body, headers });
  assert.deepEqual((await readJson(post('{"a":1}'), 100)).value, { a: 1 });
  await assert.rejects(readJson(post('{"a":1}', { 'Content-Type': 'text/plain' }), 100), (e) => e.status === 415);
  await assert.rejects(readJson(post('x'.repeat(200)), 100), (e) => e.status === 413);
  await assert.rejects(readJson(post('{'), 100), (e) => e.status === 400);
  // A stream without Content-Length is cut off while reading.
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(50));
      c.close();
    },
  });
  const r = new Request('https://x/api', { method: 'POST', body: stream, duplex: 'half' });
  await assert.rejects(readText(r, 100), (e) => e.status === 413);
  await assert.rejects(readText(post(new Uint8Array([0xff, 0xfe])), 100), (e) => e.status === 400);
});

test('session creation body is validated strictly', () => {
  const good = { name: ' Friday  night ', public: true, maxPlayers: 4, version: '0.2.0+abc' };
  assert.deepEqual(validateCreateSession(good), {
    name: 'Friday night',
    password: null,
    isPublic: true,
    maxPlayers: 4,
    version: '0.2.0+abc',
  });
  assert.equal(validateCreateSession({ ...good, password: 'pw' }).password, 'pw');
  assert.equal(validateCreateSession({ ...good, password: '' }).password, null);
  for (const bad of [
    null,
    [],
    { ...good, extra: 1 },
    { ...good, name: '' },
    { ...good, name: 'x'.repeat(41) },
    { ...good, public: 'yes' },
    { ...good, maxPlayers: 1 },
    { ...good, maxPlayers: 9 },
    { ...good, version: 'a b' },
    { ...good, password: 'p'.repeat(65) },
  ]) {
    assert.throws(() => validateCreateSession(bad), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(bad));
  }
});

test('map uploads are validated against the engine rules and hashed canonically', async () => {
  const w = 32;
  const map = {
    format: 1,
    name: 'Test',
    author: 'Me',
    width: w,
    height: w,
    terrain: Buffer.alloc(w * w).toString('base64'),
    ore: Buffer.alloc(w * w).toString('base64'),
    spawns: [
      [1, 1],
      [20, 20],
    ],
  };
  const p = await prepareMap(JSON.stringify(map));
  assert.match(p.hash, /^[0-9a-f]{64}$/);
  assert.equal(p.modded, false);
  assert.ok(p.canonical.includes('"description":"","width":32'));
  const modded = await prepareMap(JSON.stringify({ ...map, rules: { actors: { '1TNK': { cost: 1 } } } }));
  assert.equal(modded.modded, true);
  await assert.rejects(prepareMap(JSON.stringify({ ...map, rules: { actors: { NOPE: { cost: 1 } } } })), (e) => e.status === 422);
  await assert.rejects(prepareMap('not json'), (e) => e.status === 422);
  // The engine rules file the server bundles is the real one.
  assert.ok(readFileSync(new URL('../../../engine/rules.json', import.meta.url)).length > 1000);
});

test('map uploads accept format 1 and format 2 (gems) maps and refuse bad gem layers', async () => {
  const w = 32;
  const layer = (fill = {}) => {
    const b = Buffer.alloc(w * w);
    for (const [i, v] of Object.entries(fill)) b[Number(i)] = v;
    return b.toString('base64');
  };
  const map = {
    format: 2,
    name: 'Gems',
    author: 'Me',
    width: w,
    height: w,
    terrain: layer(),
    ore: layer({ 300: 6 }),
    gems: layer({ 301: 3, 302: 1 }),
    spawns: [
      [1, 1],
      [20, 20],
    ],
  };
  const p = await prepareMap(JSON.stringify(map));
  assert.ok(p.canonical.includes(`"ore":"${map.ore}","gems":"${map.gems}","spawns"`), p.canonical.slice(0, 200));
  // The format 1 version of the same map (no gems) is a different, still valid map.
  const { gems: _g, ...old } = map;
  const p1 = await prepareMap(JSON.stringify({ ...old, format: 1 }));
  assert.notEqual(p1.hash, p.hash);
  assert.ok(!p1.canonical.includes('"gems"'));
  for (const [bad, re] of [
    [{ ...map, format: 1 }, /format 1 maps have no gems layer/],
    [{ ...old }, /format 2 maps need a gems layer/],
    [{ ...map, gems: layer({ 300: 1 }) }, /both ore and gems/],
    [{ ...map, gems: layer({ 301: 4 }) }, /gem density 4/],
    [{ ...map, terrain: layer({ 301: 3 }) }, /gems can only lie on clear or rough ground/],
  ]) {
    await assert.rejects(prepareMap(JSON.stringify(bad)), (e) => e instanceof HttpError && e.status === 422 && re.test(e.message), re.source);
  }
});

test('uploads the engine would refuse are rejected by the server too', async () => {
  const { initSync, Game } = await import('../../game/pkg/webra_sim.js');
  initSync({ module: readFileSync(new URL('../../game/pkg/webra_sim_bg.wasm', import.meta.url)) });
  const map = JSON.parse(Game.generated_map(9, 48, 2));
  // Structurally fine, but spawn 2 sits in open water: only the engine knows.
  const terrain = Buffer.from(map.terrain, 'base64');
  const [sx, sy] = map.spawns[1];
  for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 3; dx++) terrain[(sy + dy) * map.width + sx + dx] = 3;
  const ore = Buffer.from(map.ore, 'base64');
  for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 3; dx++) ore[(sy + dy) * map.width + sx + dx] = 0;
  map.terrain = terrain.toString('base64');
  map.ore = ore.toString('base64');
  await assert.rejects(prepareMap(JSON.stringify(map)), (e) => e instanceof HttpError && e.status === 422 && /spawn 2/.test(e.message));
});

test('orders must name actor types the engine knows', () => {
  assert.equal(ordersFitRules([{ o: 'place', player: 0, ty: 3, cx: 1, cy: 1 }, { o: 'stop', player: 0, ids: [] }], 84), true);
  assert.equal(ordersFitRules([{ o: 'place', player: 0, ty: 84, cx: 1, cy: 1 }], 84), false);
  assert.equal(ordersFitRules([{ o: 'start_production', player: 0, ty: 65535, count: 1 }], 84), false);
});

test('command bar orders name no actor type and pass the rules check once the protocol accepts them', () => {
  // Shape (stance names, id lists, coordinates) is checked by the protocol for
  // every orders message before ordersFitRules runs (session.js).
  const orders = [
    { o: 'attack_ground', player: 0, ids: [1, 2], x: 1024, y: 2048 },
    { o: 'guard', player: 0, ids: [1], target: 7 },
    { o: 'scatter', player: 0, ids: [1, 2] },
    { o: 'waypoint', player: 0, ids: [1], x: 0, y: 512, attack_move: false },
    { o: 'set_stance', player: 0, ids: [1], stance: 'defend' },
  ];
  const msg = parseClientMessage(JSON.stringify({ t: 'orders', tick: 4, orders }));
  assert.ok(msg.ok, msg.message);
  assert.equal(ordersFitRules(msg.msg.orders, ENGINE_RULES.actors.length), true);
  assert.equal(ordersFitRules([...msg.msg.orders, { o: 'place', player: 0, ty: ENGINE_RULES.actors.length, cx: 1, cy: 1 }], ENGINE_RULES.actors.length), false);
  const bad = parseClientMessage(JSON.stringify({ t: 'orders', tick: 4, orders: [{ o: 'set_stance', player: 0, ids: [1], stance: 'berserk' }] }));
  assert.equal(bad.ok, false);
});

test('cheat orders are relayed only in games with the cheats option', () => {
  const normal = [{ o: 'stop', player: 0, ids: [1] }, { o: 'place', player: 0, ty: 3, cx: 1, cy: 1 }];
  const cheats = [
    { o: 'dev_flag', player: 0, flag: 'fast_build', on: true },
    { o: 'dev_cash', player: 0 },
    { o: 'dev_kill', player: 0, ids: [5] },
    { o: 'dev_experience', player: 0, ids: [5] },
  ];
  const off = { ...DEFAULT_OPTIONS };
  const on = { ...DEFAULT_OPTIONS, cheats: true };
  assert.equal(cheatsAllowed(normal, off), true);
  assert.equal(cheatsAllowed([], off), true);
  for (const c of cheats) {
    assert.equal(cheatsAllowed([c], off), false, c.o);
    assert.equal(cheatsAllowed([...normal, c], off), false, `${c.o} hidden among normal orders`);
    assert.equal(cheatsAllowed([...normal, c], on), true, c.o);
  }
  // Anything but a literal true keeps cheats off (missing or old stored options).
  for (const options of [undefined, null, {}, { cheats: 'true' }, { cheats: 1 }]) {
    assert.equal(cheatsAllowed(cheats, options), false, JSON.stringify(options));
  }
});
