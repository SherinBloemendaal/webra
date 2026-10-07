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
import { validateCreateSession } from '../src/validate.js';
import { HOST_KEY_RE } from '@webra/protocol';

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
