// The game when its files are refused mid-session (js/account/gate.js): the
// probe of /play/, the sign-in prompt instead of a broken load, one prompt at
// a time, and a second try once access is back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlayAccess, PlayAccessLost, PROBE_URL, probePlayAccess } from '../js/account/gate.js';

const answer = (status) => async () => new Response(null, { status });

test('probe: a HEAD of the game page without redirects, credentials of this origin', async () => {
  const calls = [];
  const state = await probePlayAccess({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(state, 'ok');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/play\/?$|\/apps\/game\/$/, 'the game directory (served as /play/)');
  assert.equal(String(PROBE_URL), calls[0].url);
  assert.equal(calls[0].init.method, 'HEAD');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.cache, 'no-store');
});

test('probe: 401 is sign in, 403 forbidden, failures offline, the rest error', async () => {
  assert.equal(await probePlayAccess({ fetchImpl: answer(401) }), 'signin');
  assert.equal(await probePlayAccess({ fetchImpl: answer(403) }), 'forbidden');
  assert.equal(await probePlayAccess({ fetchImpl: answer(304) }), 'ok');
  assert.equal(await probePlayAccess({ fetchImpl: answer(503) }), 'error');
  assert.equal(await probePlayAccess({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), 'offline');
});

test('load: a working load is passed through without a probe', async () => {
  let probes = 0;
  const access = new PlayAccess({ onLost: () => assert.fail('no prompt'), probe: async () => (probes++, 'ok') });
  assert.equal(await access.load(async () => 42), 42);
  assert.equal(probes, 0);
});

test('load: refused files show the prompt once and throw PlayAccessLost', async () => {
  const prompts = [];
  let release;
  const open = new Promise((r) => (release = r));
  const access = new PlayAccess({ onLost: (state) => (prompts.push(state), open), probe: async () => 'signin' });
  const failing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
  const results = await Promise.allSettled([access.load(failing), access.load(failing)]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.ok(r.reason instanceof PlayAccessLost);
    assert.equal(r.reason.state, 'signin');
    assert.match(r.reason.message, /Sign in again/);
    assert.ok(r.reason.cause instanceof TypeError);
  }
  await Promise.resolve();
  assert.deepEqual(prompts, ['signin'], 'one prompt while it is open');
  release();
  await access.prompt;
  await assert.rejects(access.load(failing), PlayAccessLost);
  await access.prompt;
  assert.deepEqual(prompts, ['signin', 'signin'], 'a later refusal prompts again');
});

test('load: a banned or pending account gets the forbidden prompt', async () => {
  const prompts = [];
  const access = new PlayAccess({ onLost: (s) => prompts.push(s), probe: async () => 'forbidden' });
  const err = await access.load(() => Promise.reject(new Error('x'))).catch((e) => e);
  assert.ok(err instanceof PlayAccessLost);
  assert.equal(err.state, 'forbidden');
  await access.prompt;
  assert.deepEqual(prompts, ['forbidden']);
});

test('load: allowed again means one more try; other failures keep their error', async () => {
  let tries = 0;
  const access = new PlayAccess({ onLost: () => assert.fail('no prompt'), probe: async () => 'ok' });
  assert.equal(
    await access.load(async () => {
      tries++;
      if (tries === 1) throw new Error('first');
      return 'loaded';
    }),
    'loaded',
  );
  for (const state of ['offline', 'error']) {
    const a = new PlayAccess({ onLost: () => assert.fail('no prompt'), probe: async () => state });
    await assert.rejects(a.load(() => Promise.reject(new Error('syntax'))), /syntax/);
  }
});

test('load: no answer or a server error tells the player once (onUnreachable) and keeps the error', async () => {
  const told = [];
  let open = null;
  const access = new PlayAccess({ onLost: () => assert.fail('no sign-in prompt'), onUnreachable: (state) => (told.push(state), (open = new Promise((r) => setTimeout(r, 5)))), probe: async () => 'offline' });
  await assert.rejects(access.load(() => Promise.reject(new Error('fetch failed'))), /fetch failed/);
  await assert.rejects(access.load(() => Promise.reject(new Error('fetch failed again'))), /fetch failed again/);
  assert.deepEqual(told, ['offline'], 'one message while it is open');
  await open;
  await access.prompt;
  access.probe = async () => 'error';
  await assert.rejects(access.load(() => Promise.reject(new Error('502'))), /502/);
  assert.deepEqual(told, ['offline', 'error']);
});

test('a failing prompt does not break later loads', async () => {
  const access = new PlayAccess({
    onLost: () => {
      throw new Error('no DOM');
    },
    probe: async () => 'signin',
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(access.load(() => Promise.reject(new Error('x'))), PlayAccessLost);
    await access.prompt;
    assert.equal(access.prompt, null);
  } finally {
    console.warn = warn;
  }
});
