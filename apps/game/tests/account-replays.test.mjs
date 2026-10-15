// Replays kept in the account (js/account/replays.js): the upload trigger of
// a game (GameReplay), the queue with its retries (ReplayUploads), the
// setting `privacy.cloudReplays`, the API calls and what the lists show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountApi, AccountError } from '../js/account/api.js';
import {
  clearQueuedReplays,
  daysLeft,
  forgetReplayLink,
  REPLAY_LINK_KEY,
  replayLink,
  durationText,
  formatBytes,
  GameReplay,
  LEAVE_WAIT_MS,
  MAX_ATTEMPTS,
  MemoryQueue,
  playersText,
  QUEUE_MAX,
  QUEUE_MAX_AGE_MS,
  ReplayUploads,
  replayLine,
  replayResult,
  RETRY_BASE_MS,
  uploadEventText,
  uploadsWanted,
  usageText,
} from '../js/account/replays.js';
import { createRegistry } from '../js/registry.js';
import { createSettings } from '../js/settings.js';
import { validateSettingsDocument, ACCOUNT_REPLAY_MAX_BYTES } from '../protocol/index.js';

const settle = () => new Promise((r) => setTimeout(r, 5));

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    pending,
    setTimeout: (fn, ms) => (pending.set(++n, { fn, ms }), n),
    clearTimeout: (id) => pending.delete(id),
    async fire() {
      const all = [...pending.values()];
      pending.clear();
      for (const t of all) t.fn();
      await settle();
    },
  };
}

/** An API stand-in: answers uploads from `answers` (an error to throw, or a body), records them. */
function fakeApi(answers = []) {
  const calls = [];
  return {
    calls,
    async uploadReplay(text, result) {
      calls.push({ text, result });
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a ?? { replay: { id: 'aaaaaaaaaaaaaaaa' }, evicted: 0 };
    },
  };
}

function uploads(api, o = {}) {
  const events = [];
  const timers = fakeTimers();
  let now = 1_000_000;
  const u = new ReplayUploads({ api, queue: o.queue ?? new MemoryQueue(), timers, now: () => now, onEvent: (e) => events.push(e) });
  return { u, events, timers, advance: (ms) => (now += ms), now: () => now };
}

const active = { id: 'u1', status: 'active' };
const site = { services: { replays: true } };

function recorder(text = '{"replay":1}') {
  const r = { start: { createdAt: 5, title: 'Skirmish' }, encodes: 0, encode: async () => (r.encodes++, { text }) };
  return r;
}

test('the setting: "Save replays to my account" is on by default, synced in the privacy section', () => {
  const registry = createRegistry({ storage: null });
  const settings = createSettings(registry);
  assert.equal(settings.get('cloudReplays'), true);
  settings.set('cloudReplays', false);
  assert.equal(registry.get('privacy', 'cloudReplays'), false);
  const doc = registry.document();
  assert.equal(doc.privacy.cloudReplays, false);
  assert.equal(validateSettingsDocument(doc).privacy.cloudReplays, false, 'the account accepts it');
  assert.throws(() => validateSettingsDocument({ privacy: { cloudReplays: 'yes' } }), (err) => err.field === 'settings.privacy.cloudReplays');
});

test('uploadsWanted: an active account, the setting on, a server that keeps replays', () => {
  assert.equal(uploadsWanted({ user: active, site, enabled: true }), true);
  assert.equal(uploadsWanted({ user: active, site: null, enabled: true }), true, 'not known yet: the server decides');
  assert.equal(uploadsWanted({ user: null, site, enabled: true }), false);
  assert.equal(uploadsWanted({ user: { ...active, status: 'pending_approval' }, site, enabled: true }), false);
  assert.equal(uploadsWanted({ user: active, site, enabled: false }), false);
  assert.equal(uploadsWanted({ user: active, site: { services: { replays: false } }, enabled: true }), false);
});

test('replayResult follows the end of the game', () => {
  assert.equal(replayResult({ phase: 'won', over: true, won: true }), 'won');
  assert.equal(replayResult({ phase: 'lost', over: true, won: false }), 'lost');
  assert.equal(replayResult({ phase: 'lost', over: true, won: true }), 'won', 'an ally won after this player was defeated');
  assert.equal(replayResult({ phase: 'lost', over: false, won: false }), 'lost', 'left after the defeat');
  assert.equal(replayResult({ phase: 'playing', over: false, won: false }), 'left');
  assert.equal(replayResult({ phase: 'playing', over: true, won: false }, { spectator: true }), 'spectated');
});

test('the trigger: a game ends, its replay is queued once and uploaded in the background', async () => {
  const api = fakeApi();
  const { u, timers } = uploads(api);
  u.start('u1');
  const rec = recorder();
  const game = new GameReplay({ recorder: rec, uploads: u, account: () => ({ user: active, site }), enabled: () => true });
  assert.equal(await game.ended('won'), true);
  await game.ended('won');
  await game.leaving('left');
  assert.equal(rec.encodes, 1, 'once per game');
  // The upload runs on the queue's timer, never in the game's frame.
  assert.equal(api.calls.length, 0);
  await timers.fire();
  assert.deepEqual(api.calls, [{ text: '{"replay":1}', result: 'won' }]);
});

test('the trigger: nothing is queued signed out, with the setting off or without replays on the server', async () => {
  for (const [account, enabled] of [
    [{ user: null, site }, true],
    [{ user: active, site }, false],
    [{ user: active, site: { services: { replays: false } } }, true],
  ]) {
    const { u } = uploads(fakeApi());
    const rec = recorder();
    const game = new GameReplay({ recorder: rec, uploads: u, account: () => account, enabled: () => enabled });
    assert.equal(await game.ended('won'), false);
    assert.equal(rec.encodes, 0);
    assert.deepEqual(await u.queue.all(), []);
  }
});

test('the trigger: leaving queues the replay but never waits longer than a moment', async () => {
  const { u } = uploads(fakeApi());
  const timers = fakeTimers();
  const stuck = { start: { createdAt: 1, title: 'x' }, encode: () => new Promise(() => {}) };
  const game = new GameReplay({ recorder: stuck, uploads: u, account: () => ({ user: active, site }), enabled: () => true, timers });
  let left = false;
  const p = game.leaving('left').then(() => (left = true));
  await settle();
  assert.equal(left, false);
  assert.equal([...timers.pending.values()][0].ms, LEAVE_WAIT_MS);
  await timers.fire();
  await p;
  assert.equal(left, true);
  // A replay that queues in time ends the wait at once.
  const quick = new GameReplay({ recorder: recorder(), uploads: u, account: () => ({ user: active, site }), enabled: () => true, timers });
  await quick.leaving('left');
  assert.equal((await u.queue.all()).length, 1);
  assert.equal(timers.pending.size, 0, 'the wait was cleared');
});

test('the queue uploads the replays of the signed-in account with their result; others wait for theirs', async () => {
  const api = fakeApi();
  const { u, events, timers } = uploads(api);
  await u.add({ userId: 'u1', key: 'g1', text: 'one', result: 'won' });
  await u.add({ userId: 'u2', key: 'g2', text: 'two', result: 'lost' });
  assert.equal(timers.pending.size, 0, 'nobody signed in: nothing runs');
  u.start('u1');
  await timers.fire();
  assert.deepEqual(api.calls, [{ text: 'one', result: 'won' }]);
  assert.equal(events[0].type, 'uploaded');
  assert.equal(uploadEventText(events[0]), 'Replay saved to your account.');
  assert.deepEqual((await u.queue.all()).map((r) => r.key), ['g2']);
  u.stop();
  u.start('u2');
  await timers.fire();
  assert.equal(api.calls.at(-1).text, 'two');
  assert.deepEqual(await u.queue.all(), []);
});

test('the queue retries what can pass (offline, 5xx, 429) with a growing pause, then gives up', async () => {
  const offline = () => new AccountError(0, 'offline', 'The WebRA server cannot be reached.');
  const api = fakeApi([offline(), new AccountError(500, 'internal', 'Internal error.'), new AccountError(429, 'rate_limited', 'Too many.', { retryAfter: 120 })]);
  const { u, events, timers, advance } = uploads(api);
  u.start('u1');
  await u.add({ userId: 'u1', key: 'g', text: 't', result: 'won' });
  await timers.fire();
  assert.equal(api.calls.length, 1);
  assert.equal([...timers.pending.values()][0].ms, RETRY_BASE_MS);
  advance(RETRY_BASE_MS);
  await timers.fire();
  assert.equal([...timers.pending.values()][0].ms, RETRY_BASE_MS * 2, 'doubled');
  advance(RETRY_BASE_MS * 2);
  await timers.fire();
  assert.equal([...timers.pending.values()][0].ms, 120_000, 'Retry-After');
  advance(120_000);
  await timers.fire();
  assert.equal(api.calls.length, 4);
  assert.equal(events.at(-1).type, 'uploaded');

  const failing = fakeApi(Array.from({ length: MAX_ATTEMPTS }, offline));
  const f = uploads(failing);
  f.u.start('u1');
  await f.u.add({ userId: 'u1', key: 'g', text: 't' });
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await f.timers.fire();
    f.advance(60 * 60 * 1000);
  }
  assert.equal(failing.calls.length, MAX_ATTEMPTS);
  assert.equal(f.events.at(-1).type, 'failed');
  assert.deepEqual(await f.u.queue.all(), []);
});

test('the queue drops refused replays (reported once), keeps them while signed out, and stops on a server without replays', async () => {
  const api = fakeApi([new AccountError(422, 'invalid', 'Invalid replay: bad.'), new AccountError(401, 'unauthenticated', 'Sign in first.'), new AccountError(503, 'unavailable', 'Replays cannot be kept in accounts on this server.')]);
  const { u, events, timers } = uploads(api);
  u.start('u1');
  await u.add({ userId: 'u1', key: 'bad', text: 'x' });
  await timers.fire();
  assert.equal(events[0].type, 'failed');
  assert.equal(uploadEventText(events[0]), 'The replay could not be saved to your account: Invalid replay: bad.');
  await u.add({ userId: 'u1', key: 'later', text: 'y' });
  await timers.fire();
  assert.equal(u.userId, null, 'signed out on the server: wait for the next sign-in');
  assert.deepEqual((await u.queue.all()).map((r) => r.key), ['later']);
  u.start('u1');
  await timers.fire();
  assert.equal(events.at(-1).type, 'unavailable');
  assert.deepEqual(await u.queue.all(), []);
});

test('the queue: too large replays are not queued; old ones and too many are dropped; switching off clears', async () => {
  const { u, events, advance } = uploads(fakeApi());
  assert.equal(await u.add({ userId: 'u1', key: 'big', text: 'x'.repeat(ACCOUNT_REPLAY_MAX_BYTES + 1) }), false);
  assert.equal(uploadEventText(events[0]), 'This replay is too large to keep in your account. Download it from the game menu instead.');
  for (let i = 0; i < QUEUE_MAX + 2; i++) {
    await u.add({ userId: 'u1', key: `g${i}`, text: 't' });
    advance(1);
  }
  const keys = (await u.queue.all()).map((r) => r.key);
  assert.equal(keys.length, QUEUE_MAX);
  assert.equal(keys.includes('g0') || keys.includes('g1'), false, 'the oldest went');
  await u.add({ userId: 'u2', key: 'other', text: 't' });
  await u.clear('u1');
  assert.deepEqual((await u.queue.all()).map((r) => r.key), ['other']);
  advance(QUEUE_MAX_AGE_MS + 1);
  await u.prune();
  assert.deepEqual(await u.queue.all(), []);
});

test('api: uploads send the file as it is with the result, downloads return the text and the file name', async () => {
  const requests = [];
  const api = new AccountApi({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (init.method === 'POST') return new Response(JSON.stringify({ replay: { id: 'b'.repeat(16) }, evicted: 0 }), { status: 201 });
      if (url.endsWith('/replays')) return new Response(JSON.stringify({ replays: [] }), { status: 200 });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('{"format":"webra-replay"}', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="webra-replay-x.json"' } });
    },
  });
  const file = '{"format":"webra-replay","title":"x"}';
  assert.equal((await api.uploadReplay(file, 'lost')).replay.id, 'b'.repeat(16));
  assert.equal(requests[0].url, '/api/account/replays?result=lost');
  assert.equal(requests[0].init.body, file, 'not wrapped in another JSON document');
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json');
  assert.equal(requests[0].init.headers['X-WebRA-CSRF'], '1');
  await api.replays();
  assert.equal(requests[1].init.headers['X-WebRA-CSRF'], '1', 'account reads carry the header');
  assert.deepEqual(await api.downloadReplay('c'.repeat(16)), { text: '{"format":"webra-replay"}', name: 'webra-replay-x.json' });
  assert.equal(requests[2].url, `/api/account/replays/${'c'.repeat(16)}`);
  await api.deleteReplay('c'.repeat(16));
  assert.equal(requests[3].init.method, 'DELETE');
});

test('what the lists show', () => {
  assert.equal(formatBytes(340 * 1024), '340 KB');
  assert.equal(formatBytes(3.4 * 1024 * 1024), '3.4 MB');
  assert.equal(formatBytes(100 * 1024 * 1024), '100 MB');
  assert.equal(daysLeft(10 * 86400000, 0), 10);
  assert.equal(daysLeft(1, 0), 1);
  assert.equal(daysLeft(0, 5), 0);
  assert.equal(durationText(25 * 61), '1:01');
  assert.equal(durationText(25 * 3661), '1:01:01');
  assert.equal(playersText([{ type: 'human', name: 'Tanya' }, { type: 'human', name: 'Boris' }, { type: 'ai', name: null }]), 'Tanya, Boris and 1 AI');
  assert.equal(playersText([]), '');
  assert.equal(usageText({ count: 3, bytes: 1024 * 1024 }, { count: 100, bytes: 100 * 1024 * 1024 }), '3 of 100 replays, 1.0 MB of 100 MB');
  const line = replayLine({ playedAt: 0, ticks: 1500, mode: 'online', mapName: 'Tiny', players: [{ type: 'human', name: 'Tanya' }], result: 'won', size: 2048, expiresAt: 3 * 86400000 }, 0);
  assert.match(line, /1:00\. Online on Tiny with Tanya\. Won, 2 KB, 3 days left$/);
});

test('the game\'s Replays button lists the account\'s replays: Watch loads and checks the file, other versions say so', async () => {
  const { installDom, uninstallDom, click, settle, textOf } = await import('./dom-fixtures.mjs');
  const { MockAccountServer } = await import('./account-mock.mjs');
  const { DEFAULT_OPTIONS, REPLAY_FORMAT, REPLAY_VERSION } = await import('../protocol/index.js');
  const doc = installDom();
  try {
    const { mountRecordEntries } = await import('../js/records.js');
    const server = new MockAccountServer();
    const user = server.addUser({ username: 'Tanya', password: 'a long passphrase' });
    server.signIn(user);
    const file = (engine) =>
      JSON.stringify({
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION,
        kind: 'replay',
        mode: 'skirmish',
        engine,
        createdAt: 1,
        title: 'Skirmish',
        options: { ...DEFAULT_OPTIONS, players: [{ slot: 0, type: 'human', name: 'Tanya', faction: 'england', color: 0, team: 0 }, { slot: 1, type: 'ai', difficulty: 'easy', faction: 'russia', color: 1, team: 0 }] },
        map: null,
        mapHash: null,
        player: 0,
        ticks: 100,
        frames: [],
        hashes: [],
      });
    server.addReplay(user.id, { title: 'Older version', engine: '0.13.0' }, file('0.13.0'));
    server.addReplay(user.id, { title: 'This version', engine: '0.14.0' }, file('0.14.0'));
    const watched = [];
    const root = doc.createElement('div');
    doc.body.append(root);
    mountRecordEntries(root, {
      version: '0.14.0',
      canPlay: () => true,
      showError: (m) => assert.fail(m),
      onLoadSave() {},
      onWatchReplay: (r) => watched.push(r),
      store: { list: async () => [] },
      accountReplays: { available: () => true, api: new AccountApi({ fetchImpl: server.fetch }) },
    });
    click([...root.querySelectorAll('button')].find((b) => b.textContent === 'Replays'));
    await settle(20);
    const dialog = doc.body.querySelector('dialog');
    assert.match(textOf(dialog), /2 of 100 replays/);
    const rows = [...dialog.querySelectorAll('.records-row')];
    assert.deepEqual(rows.map((r) => r.querySelector('strong').textContent), ['This version', 'Older version']);
    assert.equal(textOf(rows[0]).includes('Made with WebRA'), false);
    assert.match(textOf(rows[1]), /Made with WebRA 0\.13\.0/);
    click([...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Watch'));
    await settle(20);
    // Another version: only the header, so the viewer explains the version (js/replay.js engineMismatch).
    assert.equal(watched[0].engine, '0.13.0');
    assert.equal(watched[0].frames, undefined);
    click([...root.querySelectorAll('button')].find((b) => b.textContent === 'Replays'));
    await settle(20);
    const again = doc.body.querySelector('dialog');
    click([...again.querySelectorAll('.records-row')[0].querySelectorAll('button')].find((b) => b.textContent === 'Watch'));
    await settle(20);
    assert.equal(watched[1].engine, '0.14.0');
    assert.deepEqual(watched[1].frames, [], 'checked in full');
  } finally {
    uninstallDom();
  }
});

test('a late refusal for the previous account never stops the next account\'s uploads', async () => {
  let reject;
  const api = {
    calls: [],
    uploadReplay(text) {
      this.calls.push(text);
      if (text === 'a') return new Promise((_, rj) => (reject = rj));
      return Promise.resolve({ replay: { id: 'b'.repeat(16) }, evicted: 0 });
    },
  };
  const { u, timers } = uploads(api);
  await u.add({ userId: 'A', key: 'a', text: 'a' });
  await u.add({ userId: 'B', key: 'b', text: 'b' });
  u.start('A');
  await timers.fire();
  assert.deepEqual(api.calls, ['a'], 'A\'s upload is under way');
  // A signs out, B signs in; then A's request comes back unauthenticated.
  u.stop();
  u.start('B');
  reject(new AccountError(401, 'unauthenticated', 'Sign in first.'));
  await settle();
  assert.equal(u.userId, 'B', 'B keeps uploading');
  await timers.fire();
  assert.deepEqual(api.calls, ['a', 'b']);
  assert.deepEqual((await u.queue.all()).map((r) => r.key), ['a'], 'A\'s replay waits for A');
});

test('a replay the server already has (sent just before a reload) is dropped without a toast', () => {
  assert.equal(uploadEventText({ type: 'uploaded', duplicate: true, replay: {} }), null);
  assert.equal(uploadEventText({ type: 'uploaded', duplicate: false, evicted: 2, replay: {} }), 'Replay saved to your account (the oldest 2 were removed to make room).');
});

test('signing out drops that account\'s waiting replays; a session that ends by itself keeps them', async () => {
  const { AccountSession } = await import('../js/account/session.js');
  const queue = new MemoryQueue();
  await queue.put({ key: 'mine', userId: 'u1', text: 't', queuedAt: 0 });
  await queue.put({ key: 'theirs', userId: 'u2', text: 't', queuedAt: 0 });
  const session = new AccountSession({ api: { logout: async () => ({}) } });
  session.user = { id: 'u1', status: 'active' };
  session.onSignOut((id) => clearQueuedReplays(id, queue));
  await session.setUser(null);
  assert.equal((await queue.all()).length, 2, 'no sign-out: the session ended, the replays wait');
  session.user = { id: 'u1', status: 'active' };
  await session.signOut();
  assert.deepEqual((await queue.all()).map((r) => r.key), ['theirs']);
  assert.equal(session.user, null);
});

test('a replay link survives the sign-in: kept for the tab until it opens', () => {
  const m = new Map();
  const store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const id = 'abcdef0123456789';
  assert.equal(replayLink(`#replay=${id}`, store), id);
  assert.equal(store.getItem(REPLAY_LINK_KEY), id);
  assert.equal(replayLink('', store), id, 'after the sign-in the address has no fragment any more');
  forgetReplayLink(store);
  assert.equal(replayLink('', store), null);
  assert.equal(replayLink('#replay=../etc', store), null);
  assert.equal(replayLink(`#replay=${id}`, null), id, 'blocked storage: this page only');
});
