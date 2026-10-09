// GET /api/content/ra-quickinstall (src/content.js) with a mocked fetch: the
// real OpenRA mirrors are never contacted from tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quickInstall, QUICKINSTALL_BYTES, QUICKINSTALL_MIRRORS, CONTENT_LIMIT, CONTENT_HEADER } from '../src/content.js';
import { checkOrigin, HttpError } from '../src/http.js';
import { FakeQuotaDb as FakeDb } from './fake-quota-db.mjs';

/** A Worker environment for the relay: the quota table and the IP hash secret. */
const makeEnv = () => ({ DB: new FakeDb(), IP_HASH_SALT: 'content-test-salt-0123456789' });

const URL_ = 'https://webra.sherin.dev/api/content/ra-quickinstall';
const ok = (headers = {}) => new Request(URL_, { headers: { [CONTENT_HEADER]: '1', 'Sec-Fetch-Site': 'same-origin', ...headers } });

/** A fake upstream body of `n` bytes, in chunks. */
function body(n) {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= n) return c.close();
      const k = Math.min(1 << 20, n - sent);
      c.enqueue(new Uint8Array(k).fill(7));
      sent += k;
    },
  });
}

function mirrorFetch(behaviour, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const b = behaviour[url] ?? 'ok';
    if (b === 'down') throw new TypeError('network error');
    if (b === 404) return new Response('nope', { status: 404 });
    const size = b === 'small' ? QUICKINSTALL_BYTES - 1 : b === 'liar' ? QUICKINSTALL_BYTES + 5 : QUICKINSTALL_BYTES;
    const declared = b === 'liar' ? QUICKINSTALL_BYTES : size;
    return new Response(body(size), { status: 200, headers: { 'Content-Length': String(declared), 'Content-Type': 'application/octet-stream' } });
  };
}

async function drain(res) {
  const reader = res.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.byteLength;
  }
}

test('streams the package from the first mirror that answers with the right size, uncached', async () => {
  const calls = [];
  const fetchImpl = mirrorFetch({ [QUICKINSTALL_MIRRORS[0]]: 'down', [QUICKINSTALL_MIRRORS[1]]: 'small', [QUICKINSTALL_MIRRORS[2]]: 404 }, calls);
  const res = await quickInstall(ok(), makeEnv(), '1.2.3.4', { fetchImpl });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => c.url), QUICKINSTALL_MIRRORS, 'mirrors in order until one fits');
  for (const c of calls) assert.equal(c.init.cache, 'no-store', 'the upstream fetch bypasses Cloudflare\'s cache');
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(res.headers.get('content-length'), String(QUICKINSTALL_BYTES));
  assert.equal(await drain(res), QUICKINSTALL_BYTES);
});

test('a wrong size is refused; no mirror with the right size is a 502', async () => {
  const fetchImpl = mirrorFetch(Object.fromEntries(QUICKINSTALL_MIRRORS.map((m) => [m, 'small'])));
  await assert.rejects(quickInstall(ok(), makeEnv(), 'ip', { fetchImpl }), (e) => e instanceof HttpError && e.status === 502);
});

test('a mirror that sends more than it declared is cut off', async () => {
  const fetchImpl = mirrorFetch({ [QUICKINSTALL_MIRRORS[0]]: 'liar' });
  const res = await quickInstall(ok(), makeEnv(), 'ip', { fetchImpl });
  await assert.rejects(drain(res), /more than the expected size/);
});

test(`${CONTENT_LIMIT} downloads per hour per IP, then 429 with Retry-After`, async () => {
  const env = makeEnv();
  const fetchImpl = mirrorFetch({});
  const now = 5 * 3600 * 1000 + 1000;
  for (let i = 0; i < CONTENT_LIMIT; i++) {
    const res = await quickInstall(ok(), env, '9.9.9.9', { fetchImpl, now });
    await res.body.cancel();
  }
  const writes = env.DB.writes;
  await assert.rejects(quickInstall(ok(), env, '9.9.9.9', { fetchImpl, now }), (e) => {
    assert.ok(e instanceof HttpError && e.status === 429);
    assert.ok(Number(e.headers['retry-after']) > 0);
    return true;
  });
  assert.equal(env.DB.writes, writes, 'a refused request costs no write');
  // Another IP still may; the stored key is a hash, never the IP.
  const res = await quickInstall(ok(), env, '8.8.8.8', { fetchImpl, now });
  await res.body.cancel();
  for (const key of env.DB.rows.keys()) assert.ok(!key.includes('9.9.9.9') && /^content:[0-9a-f]{64}$/.test(key));
});

test('only the game page may ask: header, same-origin and method checks, before any fetch', async () => {
  const calls = [];
  const fetchImpl = mirrorFetch({}, calls);
  const env = makeEnv();
  for (const req of [
    new Request(URL_),
    ok({ 'Sec-Fetch-Site': 'cross-site' }),
    new Request(URL_, { method: 'POST', headers: { [CONTENT_HEADER]: '1' } }),
  ]) {
    await assert.rejects(quickInstall(req, env, 'ip', { fetchImpl }), (e) => e instanceof HttpError && (e.status === 403 || e.status === 405));
  }
  assert.equal(calls.length, 0);
});

test('the Worker route sits behind the Origin check of every API route', () => {
  // src/index.js imports Durable Object modules (cloudflare:) that Node cannot load: check the wiring in its source.
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const origin = src.indexOf('checkOrigin(request');
  const routeAt = src.indexOf("'/api/content/ra-quickinstall'");
  assert.ok(origin > 0 && routeAt > origin, 'checkOrigin runs before the content route');
  assert.throws(
    () => checkOrigin(new Request(URL_, { headers: { Origin: 'https://evil.example', [CONTENT_HEADER]: '1' } }), { required: false }),
    (e) => e instanceof HttpError && e.status === 403,
  );
});

test('the transfer deadline is cleared when the player cancels the download', async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set();
  globalThis.setTimeout = (fn, ms) => {
    const t = realSet(fn, ms);
    live.add(t);
    return t;
  };
  globalThis.clearTimeout = (t) => {
    live.delete(t);
    realClear(t);
  };
  try {
    const res = await quickInstall(ok(), makeEnv(), '7.7.7.7', { fetchImpl: mirrorFetch({}) });
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(live.size, 0, 'no timer survives a cancelled transfer');
    const liar = await quickInstall(ok(), makeEnv(), '7.7.7.8', { fetchImpl: mirrorFetch({ [QUICKINSTALL_MIRRORS[0]]: 'liar' }) });
    await assert.rejects(drain(liar), /more than the expected size/);
    assert.equal(live.size, 0, 'nor one that was cut off');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test('the relay fails closed without the IP hash secret outside local development', async () => {
  await assert.rejects(quickInstall(ok(), { DB: new FakeDb() }, 'ip', { fetchImpl: mirrorFetch({}) }), (e) => e instanceof HttpError && e.status === 503 && e.code === 'misconfigured');
});
