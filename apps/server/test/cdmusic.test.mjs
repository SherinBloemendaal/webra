// GET /api/content/ra-scores (src/cdmusic.js) with a mocked fetch: the real
// Internet Archive is never contacted from tests, and the "disc images" are
// counters of bytes, not Red Alert data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  scoresRange,
  parseScoresRange,
  allowedRedirect,
  SCORES_BYTES,
  SCORES_DISCS,
  SCORES_MAX_RANGE,
  SCORES_DAILY_MIB,
  SCORES_IP_LIMIT,
  SCORES_ROUNDS,
} from '../src/cdmusic.js';
import { CONTENT_HEADER } from '../src/content.js';
import { HttpError } from '../src/http.js';
import { FakeQuotaDb } from './fake-quota-db.mjs';

const makeEnv = () => ({ DB: new FakeQuotaDb(), IP_HASH_SALT: 'cdmusic-test-salt-0123456789' });
const ACCOUNT = { id: 'a'.repeat(32) };
const URL_ = 'https://webra.sherin.dev/api/content/ra-scores';
const ask = (range = 'bytes=0-1023', headers = {}) =>
  new Request(URL_, { headers: { [CONTENT_HEADER]: '1', 'Sec-Fetch-Site': 'same-origin', ...(range === null ? {} : { Range: range }), ...headers } });
const NODE = (disc) => disc.url.replace('https://archive.org/download/', 'https://ia601402.us.archive.org/20/items/');

/** A body of `n` bytes in chunks. */
function body(n) {
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= n) return c.close();
      const k = Math.min(1 << 20, n - sent);
      c.enqueue(new Uint8Array(k).fill(3));
      sent += k;
    },
  });
}

/**
 * The archive: the pinned URL redirects to a data node (`location`), which
 * answers the asked range of an image of the disc's size. `behaviour` per
 * disc: 'ok', 'down', 500, 'full' (200 with the whole image), 'other' (an
 * image of another size), 'short' / 'long' (body shorter or longer than
 * declared), 'direct' (no redirect), or { location } for a custom redirect.
 */
function archive(behaviour = {}, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const disc = SCORES_DISCS.find((d) => url === d.url || url === NODE(d));
    if (!disc) return new Response('unexpected host', { status: 599 });
    const b = behaviour[disc.disc] ?? 'ok';
    if (b === 'down') throw new TypeError('network error');
    if (url === disc.url && b !== 'direct') {
      const location = typeof b === 'object' ? b.location : NODE(disc);
      return new Response(null, { status: 302, headers: { Location: location } });
    }
    if (b === 500) return new Response('oops', { status: 500 });
    if (b === 'full') return new Response(body(16), { status: 200, headers: { 'Content-Length': String(disc.isoBytes) } });
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const from = Number(m[1]);
    const to = Number(m[2]);
    const n = to - from + 1;
    const total = b === 'other' ? disc.isoBytes + 2048 : disc.isoBytes;
    const sent = b === 'short' ? n - 1 : b === 'long' ? n + 7 : n;
    return new Response(body(sent), { status: 206, headers: { 'Content-Range': `bytes ${from}-${to}/${total}`, 'Content-Length': String(n) } });
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

test('the pins describe one scores.mix on two discs, inside each image', () => {
  assert.equal(SCORES_DISCS.length, 2);
  for (const d of SCORES_DISCS) {
    assert.match(d.url, /^https:\/\/archive\.org\/download\/command-conquer-red-alert_202309\/[^?#]+\.ISO$/);
    assert.ok(d.scoresOffset > 0 && d.scoresOffset + SCORES_BYTES <= d.isoBytes);
    assert.ok(Object.isFrozen(d));
  }
  assert.ok(Object.isFrozen(SCORES_DISCS));
});

test('streams the asked window of scores.mix from the pinned disc at its pinned offset, uncached', async () => {
  const calls = [];
  const res = await scoresRange(ask('bytes=1000-5095', { Cookie: 'webra_session=secret' }), makeEnv(), '1.2.3.4', ACCOUNT, { fetchImpl: archive({}, calls) });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 1000-5095/${SCORES_BYTES}`);
  assert.equal(res.headers.get('content-length'), '4096');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(await drain(res), 4096);
  const d = SCORES_DISCS[0];
  assert.deepEqual(calls.map((c) => c.url), [d.url, NODE(d)], 'the pinned URL, then its data node');
  for (const c of calls) {
    assert.equal(c.init.redirect, 'manual', 'redirects are checked by hand');
    assert.equal(c.init.cache, 'no-store');
    assert.equal(c.init.method, 'GET');
    assert.deepEqual(Object.keys(c.init.headers), ['Range'], 'nothing of the player (cookies, address) goes upstream');
    assert.equal(c.init.headers.Range, `bytes=${d.scoresOffset + 1000}-${d.scoresOffset + 5095}`);
  }
});

test('an open-ended range ends at the piece limit or the end of scores.mix', async () => {
  assert.deepEqual(parseScoresRange('bytes=0-'), { start: 0, end: SCORES_MAX_RANGE - 1 });
  assert.deepEqual(parseScoresRange(`bytes=${SCORES_BYTES - 10}-`), { start: SCORES_BYTES - 10, end: SCORES_BYTES - 1 });
  assert.deepEqual(parseScoresRange(`bytes=${SCORES_BYTES - 10}-${SCORES_BYTES + 99}`), { start: SCORES_BYTES - 10, end: SCORES_BYTES - 1 });
});

test('only one bounded range inside scores.mix: anything else is 416 before any fetch or quota write', async () => {
  const calls = [];
  const env = makeEnv();
  for (const range of [
    null,
    '',
    'bytes=-500',
    'bytes=0-10,20-30',
    `bytes=0-${SCORES_MAX_RANGE}`,
    `bytes=${SCORES_BYTES}-`,
    'bytes=10-5',
    'bytes=1e3-2000',
    'items=0-10',
    `bytes=0-${'9'.repeat(60)}`,
  ]) {
    await assert.rejects(scoresRange(ask(range), env, 'ip', ACCOUNT, { fetchImpl: archive({}, calls) }), (e) => {
      assert.ok(e instanceof HttpError, String(range));
      assert.equal(e.status, 416, String(range));
      assert.equal(e.headers['content-range'], `bytes */${SCORES_BYTES}`);
      return true;
    });
  }
  assert.equal(calls.length, 0);
  assert.equal(env.DB.writes, 0);
});

test('only the game page may ask, with GET and an account, before any fetch', async () => {
  const calls = [];
  const env = makeEnv();
  const fetchImpl = archive({}, calls);
  await assert.rejects(scoresRange(new Request(URL_, { headers: { Range: 'bytes=0-1' } }), env, 'ip', ACCOUNT, { fetchImpl }), (e) => e.status === 403);
  await assert.rejects(scoresRange(ask('bytes=0-1', { 'Sec-Fetch-Site': 'cross-site' }), env, 'ip', ACCOUNT, { fetchImpl }), (e) => e.status === 403);
  await assert.rejects(scoresRange(new Request(URL_, { method: 'POST', headers: { [CONTENT_HEADER]: '1' } }), env, 'ip', ACCOUNT, { fetchImpl }), (e) => e.status === 405);
  await assert.rejects(scoresRange(ask(), env, 'ip', null, { fetchImpl }), (e) => e.status === 401);
  assert.equal(calls.length, 0);
});

test('redirects: one hop, only to an archive data node with the same item and file', () => {
  const d = SCORES_DISCS[0];
  const file = d.url.split('/').pop();
  const item = 'command-conquer-red-alert_202309';
  // As the archive sends it (escaped, docs/security.md), and with "[", "]", "&" and spaces left literal: the same file.
  assert.equal(allowedRedirect(d.url, `https://dn721505.ca.archive.org/0/items/${item}/${file}`), `https://dn721505.ca.archive.org/0/items/${item}/${file}`);
  assert.equal(allowedRedirect(d.url, NODE(d)), NODE(d));
  for (const literal of ['Command%20&%20Conquer%20Red%20Alert%20[CD1].ISO', 'Command & Conquer Red Alert [CD1].ISO', 'Command%20%26%20Conquer%20Red%20Alert%20%5bCD1%5d.ISO']) {
    assert.equal(allowedRedirect(d.url, `https://ia601402.us.archive.org/20/items/${item}/${literal}`), NODE(d), literal);
  }
  for (const bad of [
    `http://ia601402.us.archive.org/20/items/${item}/${file}`,
    `https://evil.example/20/items/${item}/${file}`,
    `https://ia601402.us.archive.org.evil.example/20/items/${item}/${file}`,
    `https://archive.org.evil.example/0/items/${item}/${file}`,
    `https://web.archive.org/20/items/${item}/${file}`,
    `https://ia601402.us.archive.org:8443/20/items/${item}/${file}`,
    `https://user:pw@ia601402.us.archive.org/20/items/${item}/${file}`,
    `https://ia601402.us.archive.org/20/items/${item}/${file}?x=1`,
    `https://ia601402.us.archive.org/20/items/${item}/${file}#x`,
    `https://ia601402.us.archive.org/20/items/${item}/other.ISO`,
    `https://ia601402.us.archive.org/20/items/another-item/${file}`,
    `https://ia601402.us.archive.org/20/items/${item}/x/../${file}`,
    `https://ia601402.us.archive.org/20/items/${item}/%2e%2e`,
    `https://ia601402.us.archive.org/20/items/%2E%2E/${file}`,
    `https://ia601402.us.archive.org/20/items/${item}/..%2F${file}`,
    `https://ia601402.us.archive.org/20/items/${item}/a%5C${file}`,
    `https://ia601402.us.archive.org/20/items/${item}\\${file}`,
    `https://ia601402.us.archive.org/20/items/${item}/${file}%00`,
    `https://ia601402.us.archive.org/20/items/${item}/%E0%A4%A`,
    `https://IA601402.us.archive.org/20/items/${item}/${file}`,
    `https://ia601402.us.archive.org./20/items/${item}/${file}`,
    `https://ia601402.us.archive.org@evil.example/20/items/${item}/${file}`,
    `/20/items/${item}/${file}`,
    '',
  ]) {
    assert.equal(allowedRedirect(d.url, bad), null, bad);
  }
});

test('a redirect with the file name unescaped is followed to the escaped pinned path on that node', async () => {
  const calls = [];
  const item = 'command-conquer-red-alert_202309';
  const fetchImpl = archive({ allied: { location: `https://ia601402.us.archive.org/20/items/${item}/Command & Conquer Red Alert [CD1].ISO` } }, calls);
  const res = await scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl });
  assert.equal(res.status, 206);
  await drain(res);
  assert.deepEqual(calls.map((c) => c.url), [SCORES_DISCS[0].url, NODE(SCORES_DISCS[0])]);
});

test('a redirect elsewhere is not followed; the other disc is used', async () => {
  const calls = [];
  const fetchImpl = archive({ allied: { location: 'https://evil.example/x.ISO' } }, calls);
  const res = await scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl });
  assert.equal(res.status, 206);
  await drain(res);
  assert.ok(!calls.some((c) => c.url.includes('evil.example')), 'the foreign host is never contacted');
  assert.deepEqual(calls.map((c) => c.url), [SCORES_DISCS[0].url, SCORES_DISCS[1].url, NODE(SCORES_DISCS[1])]);
});

test('a second redirect is refused', async () => {
  const calls = [];
  const d = SCORES_DISCS[0];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { Location: NODE(d) } });
  };
  await assert.rejects(scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl, discs: [d] }), (e) => e.status === 502);
  assert.equal(calls.length, 2 * SCORES_ROUNDS, 'one redirect per attempt, never a chain');
});

test('a 502 gives the bytes back to the daily budget (never below zero); the IP request still counts', async () => {
  const env = makeEnv();
  const now = Date.UTC(2026, 9, 9, 5, 0, 0);
  const piece = `bytes=0-${SCORES_MAX_RANGE - 1}`;
  const ok = await scoresRange(ask(piece), env, '10.1.0.1', ACCOUNT, { fetchImpl: archive(), now });
  await ok.body.cancel();
  const counts = () => [...env.DB.rows.entries()].map(([k, v]) => [k.split(':')[0], v.count]).sort();
  assert.deepEqual(counts(), [['scores-bytes', 8], ['scores-ip', 1]]);
  for (let i = 0; i < 5; i++) {
    await assert.rejects(scoresRange(ask(piece), env, '10.1.0.1', ACCOUNT, { fetchImpl: archive({ allied: 'down', soviet: 500 }), now }), (e) => e.status === 502);
  }
  assert.deepEqual(counts(), [['scores-bytes', 8], ['scores-ip', 6]], 'failed requests cost no bytes');
  // The refund only touches the current window and never goes below zero.
  const { refundQuota } = await import('../src/quota.js');
  await refundQuota(env.DB, 'cdmusic-test-salt-0123456789', 'scores-bytes', ACCOUNT.id, 24 * 3600 * 1000, now, 50);
  assert.deepEqual(counts(), [['scores-bytes', 0], ['scores-ip', 6]]);
  await refundQuota(env.DB, 'cdmusic-test-salt-0123456789', 'scores-bytes', ACCOUNT.id, 24 * 3600 * 1000, now + 24 * 3600 * 1000, 1);
  assert.deepEqual(counts(), [['scores-bytes', 0], ['scores-ip', 6]]);
  await assert.rejects(refundQuota(env.DB, 's'.repeat(20), 'x', 'y', 1000, now, 0), RangeError);
});

test('another image (size), a 200 instead of 206, a 500 or a dead host fall through; none is a 502', async () => {
  for (const b of ['other', 'full', 500, 'down']) {
    await assert.rejects(scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl: archive({ allied: b, soviet: b }) }), (e) => e instanceof HttpError && e.status === 502, String(b));
  }
  const res = await scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl: archive({ allied: 'other' }) });
  assert.equal(res.status, 206, 'the soviet disc answers when the allied one is wrong');
  await drain(res);
});

test('a transient 500 on both discs is retried in the next round', async () => {
  let failures = 2;
  const ok = archive();
  const fetchImpl = async (url, init) => {
    if (url !== SCORES_DISCS[0].url && url !== SCORES_DISCS[1].url && failures > 0) {
      failures--;
      return new Response('oops', { status: 500 });
    }
    return ok(url, init);
  };
  const res = await scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl });
  assert.equal(res.status, 206);
  await drain(res);
});

test('a body longer or shorter than the window is cut off with an error', async () => {
  const long = await scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl: archive({ allied: 'long' }) });
  await assert.rejects(drain(long), /more than the expected size/);
  const short = await scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl: archive({ allied: 'short' }) });
  await assert.rejects(drain(short), /less than the expected size/);
});

test(`${SCORES_DAILY_MIB} MiB per account per day, counted by size; another account still may`, async () => {
  const env = makeEnv();
  const fetchImpl = archive();
  const now = Date.UTC(2026, 9, 9, 1, 0, 0);
  const piece = `bytes=0-${SCORES_MAX_RANGE - 1}`;
  const pieces = SCORES_DAILY_MIB / (SCORES_MAX_RANGE / (1024 * 1024));
  for (let i = 0; i < pieces; i++) {
    const res = await scoresRange(ask(piece), env, `10.0.0.${i % 200}`, ACCOUNT, { fetchImpl, now });
    await res.body.cancel();
  }
  const writes = env.DB.writes;
  await assert.rejects(scoresRange(ask('bytes=0-0'), env, '10.0.1.1', ACCOUNT, { fetchImpl, now }), (e) => {
    assert.ok(e instanceof HttpError && e.status === 429);
    assert.ok(Number(e.headers['retry-after']) > 0);
    return true;
  });
  assert.equal(env.DB.writes, writes + 1, 'only the IP counter is written for a refused request');
  const other = await scoresRange(ask(piece), env, '10.0.1.2', { id: 'b'.repeat(32) }, { fetchImpl, now });
  await other.body.cancel();
  // The next UTC day starts afresh.
  const tomorrow = await scoresRange(ask(piece), env, '10.0.1.3', ACCOUNT, { fetchImpl, now: now + 24 * 3600 * 1000 });
  await tomorrow.body.cancel();
  for (const key of env.DB.rows.keys()) assert.ok(!key.includes(ACCOUNT.id) && !key.includes('10.0.') && /^scores-(ip|bytes):[0-9a-f]{64}$/.test(key), key);
});

test(`${SCORES_IP_LIMIT} requests per IP per hour, before any fetch`, async () => {
  const env = makeEnv();
  const calls = [];
  const fetchImpl = archive({}, calls);
  const now = Date.UTC(2026, 9, 9, 3, 0, 0);
  for (let i = 0; i < SCORES_IP_LIMIT; i++) {
    const res = await scoresRange(ask('bytes=0-0'), env, '9.9.9.9', { id: String(i).padStart(32, '0') }, { fetchImpl, now });
    await res.body.cancel();
  }
  const before = calls.length;
  await assert.rejects(scoresRange(ask('bytes=0-0'), env, '9.9.9.9', ACCOUNT, { fetchImpl, now }), (e) => e.status === 429);
  assert.equal(calls.length, before, 'no upstream fetch when over the budget');
});

test('no timer outlives a cancelled or cut off transfer', async () => {
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
    const res = await scoresRange(ask(`bytes=0-${SCORES_MAX_RANGE - 1}`), makeEnv(), 'ip', ACCOUNT, { fetchImpl: archive() });
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(live.size, 0, 'cancelled');
    const long = await scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl: archive({ allied: 'long' }) });
    await assert.rejects(drain(long), /more than/);
    assert.equal(live.size, 0, 'cut off');
    await assert.rejects(scoresRange(ask(), makeEnv(), 'ip', ACCOUNT, { fetchImpl: archive({ allied: 'other', soviet: 500 }) }), (e) => e.status === 502);
    assert.equal(live.size, 0, 'refused answers');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

test('the relay fails closed without the IP hash secret outside local development', async () => {
  await assert.rejects(scoresRange(ask(), { DB: new FakeQuotaDb() }, 'ip', ACCOUNT, { fetchImpl: archive() }), (e) => e instanceof HttpError && e.status === 503 && e.code === 'misconfigured');
});

test('the Worker route checks the account gate (requireRelay) before the relay', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const origin = src.indexOf('checkOrigin(request');
  const at = src.indexOf("'/api/content/ra-scores'");
  assert.ok(origin > 0 && at > origin, 'checkOrigin runs before the route');
  const block = src.slice(at, src.indexOf('}', at));
  assert.ok(block.indexOf('requireRelay(ctx)') > 0 && block.indexOf('requireRelay(ctx)') < block.indexOf('scoresRange('), 'requireRelay before scoresRange');
});
