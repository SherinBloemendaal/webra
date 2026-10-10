// GET /api/content/ra-quickinstall (src/content.js) with a mocked fetch: the
// real OpenRA mirrors are never contacted from tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  quickInstall,
  QUICKINSTALL_BYTES,
  QUICKINSTALL_MIRRORS,
  CONTENT_ACCOUNT_LIMIT,
  CONTENT_NET_ATTEMPTS,
  CONTENT_NET_LIMIT,
  CONTENT_HEADER,
} from '../src/content.js';
import { peekQuota } from '../src/quota.js';
import { checkOrigin, HttpError } from '../src/http.js';
import { FakeQuotaDb as FakeDb } from './fake-quota-db.mjs';

/** A Worker environment for the relay: the quota table and the IP hash secret. */
const SALT = 'content-test-salt-0123456789';
const makeEnv = () => ({ DB: new FakeDb(), IP_HASH_SALT: SALT });
const ACCOUNT = { id: 'a'.repeat(32) };
const accountN = (i) => ({ id: String(i).padStart(32, '0') });
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

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
  const res = await quickInstall(ok(), makeEnv(), '1.2.3.4', ACCOUNT, { fetchImpl });
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
  await assert.rejects(quickInstall(ok(), makeEnv(), 'ip', ACCOUNT, { fetchImpl }), (e) => e instanceof HttpError && e.status === 502);
});

test('a mirror that sends more than it declared is cut off', async () => {
  const fetchImpl = mirrorFetch({ [QUICKINSTALL_MIRRORS[0]]: 'liar' });
  const res = await quickInstall(ok(), makeEnv(), 'ip', ACCOUNT, { fetchImpl });
  await assert.rejects(drain(res), /more than the expected size/);
});

/** Collects the refunds the relay leaves to waitUntil, so a test can wait for them. */
function lateWork() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending.splice(0)) };
}

/** What a budget has counted in the window of `now`. */
const used = (env, purpose, subject, windowMs, now) => peekQuota(env.DB, SALT, purpose, subject, windowMs, now);

test(`${CONTENT_ACCOUNT_LIMIT} completed downloads per account per UTC day, then 429 with Retry-After and the scope`, async () => {
  const env = makeEnv();
  const fetchImpl = mirrorFetch({});
  const now = Date.UTC(2026, 9, 9, 22, 0, 0);
  for (let i = 0; i < CONTENT_ACCOUNT_LIMIT; i++) {
    // Different networks: only the account's budget fills.
    const res = await quickInstall(ok(), env, `10.0.0.${i}`, ACCOUNT, { fetchImpl, now });
    assert.equal(await drain(res), QUICKINSTALL_BYTES);
  }
  const calls = [];
  const writes = env.DB.writes;
  await assert.rejects(quickInstall(ok(), env, '10.0.1.1', ACCOUNT, { fetchImpl: mirrorFetch({}, calls), now }), (e) => {
    assert.ok(e instanceof HttpError && e.status === 429 && e.code === 'rate_limited');
    assert.equal(e.headers['retry-after'], String(2 * 3600), 'until the next UTC day');
    assert.deepEqual(e.extra, { retryAfter: 2 * 3600, scope: 'account' });
    assert.match(e.message, /This account has used its one-click downloads for today/);
    return true;
  });
  assert.equal(env.DB.writes, writes, 'a used up account costs no write, not even an attempt');
  assert.equal(calls.length, 0, 'and no mirror request');
  // Another account on the same network still may; the next UTC day starts afresh.
  await drain(await quickInstall(ok(), env, '10.0.1.1', accountN(2), { fetchImpl, now }));
  await drain(await quickInstall(ok(), env, '10.0.1.1', ACCOUNT, { fetchImpl, now: now + 2 * HOUR }));
  // Stored keys are hashes, never the account id or the address.
  for (const key of env.DB.rows.keys()) {
    assert.ok(!key.includes(ACCOUNT.id) && !key.includes('10.0.'), key);
    assert.match(key, /^content-(account|net|tries):[0-9a-f]{64}$/);
  }
});

test(`${CONTENT_NET_LIMIT} completed downloads per network per hour: a household shares an IPv4 address, IPv6 counts by /64`, async () => {
  const env = makeEnv();
  const fetchImpl = mirrorFetch({});
  const now = Date.UTC(2026, 9, 9, 5, 15, 0);
  // Twenty players behind one IPv6 /64 with rotating privacy addresses.
  for (let i = 0; i < CONTENT_NET_LIMIT; i++) {
    await drain(await quickInstall(ok(), env, `2001:db8:1:2:${(i + 1).toString(16)}::1`, accountN(i), { fetchImpl, now }));
  }
  await assert.rejects(quickInstall(ok(), env, '2001:db8:1:2:ffff::9', accountN(99), { fetchImpl, now }), (e) => {
    assert.equal(e.status, 429);
    assert.deepEqual(e.extra, { retryAfter: 45 * 60, scope: 'network' });
    assert.match(e.message, /from this network in the last hour/);
    return true;
  });
  // The neighbouring /64 and the next hour are separate.
  await drain(await quickInstall(ok(), env, '2001:db8:1:3::1', accountN(99), { fetchImpl, now }));
  await drain(await quickInstall(ok(), env, '2001:db8:1:2::1', accountN(99), { fetchImpl, now: now + HOUR }));
});

test('a download that does not complete is given back; only completed ones count', async () => {
  const env = makeEnv();
  const now = Date.UTC(2026, 9, 9, 7, 0, 0);
  const late = lateWork();
  const ip = '192.0.2.10';
  const account = () => used(env, 'content-account', ACCOUNT.id, DAY, now);
  const network = () => used(env, 'content-net', ip, HOUR, now);
  // No mirror answers: 502, nothing charged.
  const down = mirrorFetch(Object.fromEntries(QUICKINSTALL_MIRRORS.map((m) => [m, 'down'])));
  await assert.rejects(quickInstall(ok(), env, ip, ACCOUNT, { fetchImpl: down, now, waitUntil: late.waitUntil }), (e) => e.status === 502);
  assert.deepEqual([await account(), await network()], [0, 0]);
  // The player cancels halfway: given back once the stream ends.
  const res = await quickInstall(ok(), env, ip, ACCOUNT, { fetchImpl: mirrorFetch({}), now, waitUntil: late.waitUntil });
  assert.deepEqual([await account(), await network()], [1, 1], 'charged while it runs');
  const reader = res.body.getReader();
  await reader.read();
  await reader.cancel();
  await late.settle();
  assert.deepEqual([await account(), await network()], [0, 0]);
  // The mirror breaks off (sends less than the package): given back too.
  const short = mirrorFetch({ [QUICKINSTALL_MIRRORS[0]]: 'small' });
  const cut = async (url, init) => {
    const r = await short(url, init);
    return new Response(r.body, { status: 200, headers: { 'Content-Length': String(QUICKINSTALL_BYTES) } });
  };
  await assert.rejects(drain(await quickInstall(ok(), env, ip, ACCOUNT, { fetchImpl: cut, now, waitUntil: late.waitUntil })), /less than the expected size/);
  await late.settle();
  assert.deepEqual([await account(), await network()], [0, 0]);
  // The client's retry of those failures is the first charge; a completed download stays charged.
  await drain(await quickInstall(ok(), env, ip, ACCOUNT, { fetchImpl: mirrorFetch({}), now, waitUntil: late.waitUntil }));
  await late.settle();
  assert.deepEqual([await account(), await network()], [1, 1]);
  assert.equal(await used(env, 'content-tries', ip, HOUR, now), 4, 'every attempt counts toward the attempts ceiling');
});

test(`${CONTENT_NET_ATTEMPTS} attempts per network per hour, whatever their outcome, before any fetch`, async () => {
  const env = makeEnv();
  const now = Date.UTC(2026, 9, 9, 9, 0, 0);
  const calls = [];
  const down = mirrorFetch(Object.fromEntries(QUICKINSTALL_MIRRORS.map((m) => [m, 404])), calls);
  for (let i = 0; i < CONTENT_NET_ATTEMPTS; i++) {
    await assert.rejects(quickInstall(ok(), env, '198.51.100.7', accountN(i % 3), { fetchImpl: down, now }), (e) => e.status === 502);
  }
  const before = calls.length;
  await assert.rejects(quickInstall(ok(), env, '198.51.100.7', ACCOUNT, { fetchImpl: down, now }), (e) => e.status === 429 && e.extra.scope === 'network');
  assert.equal(calls.length, before, 'no mirror request over the ceiling');
  assert.equal(await used(env, 'content-account', accountN(0).id, DAY, now), 0, 'failed attempts cost no download');
});

test('the relay needs the account requireRelay let through', async () => {
  await assert.rejects(quickInstall(ok(), makeEnv(), 'ip', null, { fetchImpl: mirrorFetch({}) }), (e) => e.status === 401);
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
    await assert.rejects(quickInstall(req, env, 'ip', ACCOUNT, { fetchImpl }), (e) => e instanceof HttpError && (e.status === 403 || e.status === 405));
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
    const res = await quickInstall(ok(), makeEnv(), '7.7.7.7', ACCOUNT, { fetchImpl: mirrorFetch({}) });
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(live.size, 0, 'no timer survives a cancelled transfer');
    const liar = await quickInstall(ok(), makeEnv(), '7.7.7.8', ACCOUNT, { fetchImpl: mirrorFetch({ [QUICKINSTALL_MIRRORS[0]]: 'liar' }) });
    await assert.rejects(drain(liar), /more than the expected size/);
    assert.equal(live.size, 0, 'nor one that was cut off');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test('the relay fails closed without the IP hash secret outside local development', async () => {
  await assert.rejects(quickInstall(ok(), { DB: new FakeDb() }, 'ip', ACCOUNT, { fetchImpl: mirrorFetch({}) }), (e) => e instanceof HttpError && e.status === 503 && e.code === 'misconfigured');
});
