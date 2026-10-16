// The realtime channel's client (js/account/realtime.js) with a fake socket
// and hand-driven timers: connecting when a topic needs it, the resync on
// every hello, debounced hints, backoff with jitter, the sign-out close,
// hidden tabs, lingering and giving up for a while. Then the parts that use
// it: FriendsStore's two poll intervals, AccountSession (who may connect, an
// account hint refreshes, a settings hint syncs) and the settings sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeClient, REALTIME_LINGER_MS, REALTIME_UNAVAILABLE_MS } from '../js/account/realtime.js';
import { FriendsStore } from '../js/account/friends.js';
import { AccountSession } from '../js/account/session.js';
import { SettingsSync } from '../js/account/sync.js';
import { AccountApi } from '../js/account/api.js';
import { createRegistry } from '../js/registry.js';
import { FRIENDS_POLL_MS, FRIENDS_POLL_SLOW_MS, REALTIME_PING, REALTIME_PING_MS, REALTIME_REFETCH_DEBOUNCE_MS } from '../js/protocol.js';
import { FakeTimers } from './fake-timers.mjs';
import { MockAccountServer } from './account-mock.mjs';
import { memoryStorage } from './dom-fixtures.mjs';

const USER = 'a'.repeat(32);

/** A WebSocket stand-in: every socket made is in `FakeSocket.made`; the test opens, sends to and closes it. */
class FakeSocket {
  static made = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = null;
    FakeSocket.made.push(this);
  }

  send(text) {
    this.sent.push(text);
  }

  close(code, reason) {
    this.closed = { code, reason };
  }

  /** The server says something. */
  receive(msg) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }

  hello(seq = 0, topics = ['friends', 'account', 'settings', 'replays']) {
    this.receive({ t: 'hello', v: 1, seq, topics, userId: USER });
  }

  event(seq, topic, kind, data = null) {
    this.receive({ t: 'event', v: 1, seq, topic, kind, at: 1, data });
  }

  /** The connection ends from the other side. */
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

/** A document with a visibility the test switches. */
class FakeDoc {
  constructor() {
    this.visibilityState = 'visible';
    this.listeners = new Set();
  }

  addEventListener(type, fn) {
    if (type === 'visibilitychange') this.listeners.add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.delete(fn);
  }

  set(state) {
    this.visibilityState = state;
    for (const fn of [...this.listeners]) fn();
  }
}

function makeClient(o = {}) {
  FakeSocket.made = [];
  const timers = new FakeTimers();
  const doc = new FakeDoc();
  const client = new RealtimeClient({ WebSocketImpl: FakeSocket, timers, doc, location: { protocol: 'https:', host: 'webra.sherin.dev' }, random: () => 0.5, now: () => timers.now, ...o });
  return { client, timers, doc, last: () => FakeSocket.made.at(-1) };
}

test('connects only when allowed and some topic is followed; hello resyncs every topic once', () => {
  const { client, timers, last } = makeClient();
  const seen = [];
  const off = client.subscribe('friends', (e) => seen.push(['friends', e.kind]));
  assert.equal(FakeSocket.made.length, 0, 'not allowed yet (nobody signed in)');
  client.allow();
  assert.equal(last().url, 'wss://webra.sherin.dev/api/account/realtime');
  assert.equal(client.state, 'connecting');
  client.subscribe('settings', (e) => seen.push(['settings', e.kind]));
  assert.equal(FakeSocket.made.length, 1, 'one socket per page');
  const states = [];
  client.on('state', (s) => states.push(s));
  last().hello(4);
  assert.equal(client.state, 'open');
  assert.deepEqual(states, ['open']);
  assert.deepEqual(seen, [], 'debounced');
  timers.advance(REALTIME_REFETCH_DEBOUNCE_MS);
  assert.deepEqual(seen, [
    ['friends', 'resync'],
    ['settings', 'resync'],
  ]);
  // Keepalive while open and visible.
  timers.advance(REALTIME_PING_MS);
  assert.deepEqual(last().sent, [REALTIME_PING]);
  off();
});

test('hints: a burst of one topic is one call with the batch; duplicates and other topics are not mixed in', () => {
  const { client, timers, last } = makeClient();
  const calls = [];
  client.subscribe('friends', (e) => calls.push(e));
  client.allow();
  last().hello(0);
  timers.advance(REALTIME_REFETCH_DEBOUNCE_MS);
  calls.length = 0;
  last().event(1, 'friends', 'request', { username: 'Ivan' });
  last().event(2, 'friends', 'presence', { username: 'Kara' });
  last().event(2, 'friends', 'presence', { username: 'Kara' });
  last().event(3, 'replays', 'added', { id: 'c'.repeat(16) });
  timers.advance(REALTIME_REFETCH_DEBOUNCE_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'presence', 'the last event');
  assert.deepEqual(
    calls[0].batch.map((e) => [e.seq, e.kind]),
    [
      [1, 'request'],
      [2, 'presence'],
    ],
    'the duplicate is dropped',
  );
});

test('reconnects with jittered, doubling backoff; a hello resets it; three failures without one give up for a while', () => {
  const { client, timers, last } = makeClient({ random: () => 1 - 1e-9 });
  client.subscribe('account', () => {});
  client.allow();
  last().hello(0);
  last().drop(1006);
  assert.equal(client.state, 'backoff');
  const delays = [];
  for (let i = 0; i < 2; i++) {
    const before = timers.now;
    const made = FakeSocket.made.length;
    while (FakeSocket.made.length === made) timers.advance(10);
    delays.push(timers.now - before);
    last().drop(1006);
  }
  assert.ok(delays[0] <= 1000 && delays[0] > 900, `first retry within 1 s (${delays[0]})`);
  assert.ok(delays[1] <= 2000 && delays[1] > 1900, `then within 2 s (${delays[1]})`);
  // Two failed connects after the drop; a third without hello: unavailable.
  while (FakeSocket.made.length === 3) timers.advance(10);
  last().drop(1006);
  assert.equal(client.state, 'unavailable');
  const made = FakeSocket.made.length;
  timers.advance(REALTIME_UNAVAILABLE_MS - 1);
  assert.equal(FakeSocket.made.length, made, 'not tried meanwhile');
  timers.advance(1);
  assert.equal(FakeSocket.made.length, made + 1, 'tried again after the pause');
  last().hello(0);
  last().drop(1012);
  const before = timers.now;
  while (FakeSocket.made.length === made + 1) timers.advance(10);
  assert.ok(timers.now - before <= 1000, 'a hello starts the backoff over');
});

test('4001 stops the channel and asks who is signed in; allow() starts it again; a repeat soon after gives up', () => {
  const { client, timers, last } = makeClient();
  const auth = [];
  client.on('auth', (code) => auth.push(code));
  client.subscribe('account', () => {});
  client.allow();
  last().hello(0);
  last().drop(4001);
  assert.equal(client.state, 'stopped');
  assert.deepEqual(auth, [4001]);
  timers.advance(5_000);
  assert.equal(FakeSocket.made.length, 1, 'no reconnect');
  client.allow();
  assert.equal(FakeSocket.made.length, 2);
  last().hello(0);
  last().drop(4001);
  assert.equal(client.state, 'unavailable', 'two sign-out closes within seconds: something is off, poll instead');
});

test('an account/signed_out event acts at once, before the close frame arrives', () => {
  const { client, last } = makeClient();
  const auth = [];
  client.on('auth', (code) => auth.push(code));
  client.subscribe('account', () => {});
  client.allow();
  const ws = last();
  ws.hello(0);
  ws.event(1, 'account', 'signed_out');
  assert.deepEqual(auth, [4001]);
  assert.equal(client.state, 'stopped');
  assert.deepEqual(ws.closed, { code: 1000, reason: 'signed_out' });
  ws.drop(4001);
  assert.deepEqual(auth, [4001], 'the late close frame changes nothing');
});

test('a hidden tab: hints wait, no ping, a reconnect waits for the tab to show', () => {
  const { client, timers, doc, last } = makeClient();
  const calls = [];
  client.subscribe('friends', (e) => calls.push(e.kind));
  client.allow();
  last().hello(0);
  timers.advance(REALTIME_REFETCH_DEBOUNCE_MS);
  calls.length = 0;
  doc.set('hidden');
  last().event(1, 'friends', 'request', { username: 'Ivan' });
  timers.advance(REALTIME_PING_MS * 3);
  assert.deepEqual(calls, [], 'nothing loads while hidden');
  assert.deepEqual(last().sent, [], 'no ping while hidden');
  doc.set('visible');
  assert.deepEqual(calls, ['request'], 'loads as the tab shows');
  doc.set('hidden');
  last().drop(1006);
  const made = FakeSocket.made.length;
  timers.advance(60_000);
  assert.equal(FakeSocket.made.length, made, 'no reconnect while hidden');
  doc.set('visible');
  assert.equal(FakeSocket.made.length, made + 1, 'at once when shown');
});

test('the last unsubscribe closes after a linger; stop() closes for good; a message it cannot read means poll for a while', () => {
  const { client, timers, last } = makeClient();
  const off = client.subscribe('friends', () => {});
  client.allow();
  const ws = last();
  ws.hello(0);
  off();
  timers.advance(REALTIME_LINGER_MS - 1);
  assert.equal(ws.closed, null, 'a screen switch does not reconnect');
  const off2 = client.subscribe('replays', () => {});
  timers.advance(REALTIME_LINGER_MS);
  assert.equal(ws.closed, null, 'a new subscriber keeps it');
  off2();
  timers.advance(REALTIME_LINGER_MS);
  assert.deepEqual(ws.closed, { code: 1000, reason: 'unused' });
  assert.equal(client.state, 'idle');

  client.subscribe('account', () => {});
  const ws2 = last();
  assert.notEqual(ws2, ws);
  ws2.receive({ t: 'event', v: 2, seq: 1, topic: 'account', kind: 'status', at: 0, data: null });
  assert.equal(ws2.closed.code, 1003, 'a newer format: closed');
  assert.equal(client.state, 'unavailable');
  client.stop();
  assert.equal(client.state, 'stopped');
  timers.advance(REALTIME_UNAVAILABLE_MS * 2);
  assert.equal(last(), ws2, 'stopped stays closed');
});

test('without WebSocket or a location the channel is unavailable (the screens poll)', () => {
  const c = new RealtimeClient({ WebSocketImpl: undefined, location: null, timers: new FakeTimers(), doc: null });
  c.subscribe('friends', () => {});
  c.allow();
  assert.equal(c.state, 'unavailable');
  const admin = makeClient({ path: '/api/admin/realtime', location: { protocol: 'http:', host: 'localhost:8787' } });
  admin.client.subscribe('admin', () => {});
  admin.client.start();
  assert.equal(admin.last().url, 'ws://localhost:8787/api/admin/realtime');
});

// ---- Users of the channel --------------------------------------------------------------------

test('FriendsStore: polls every 30 s without the channel, every 5 minutes with it, and loads once per burst of hints', async () => {
  const { client: realtime, timers, last } = makeClient();
  let lists = 0;
  const store = new FriendsStore({ client: { list: async () => ({ friends: [], n: ++lists }) }, timers, realtime, doc: null });
  const hints = [];
  store.on('hint', (e) => hints.push(e.kind));
  realtime.allow();
  store.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lists, 1);
  assert.equal(store.interval(), FRIENDS_POLL_MS, 'connecting: the normal poll');
  last().hello(0);
  timers.advance(REALTIME_REFETCH_DEBOUNCE_MS);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lists, 2, 'the resync on hello');
  assert.equal(store.interval(), FRIENDS_POLL_SLOW_MS);
  timers.advance(FRIENDS_POLL_MS * 2);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lists, 2, 'no 30 s poll while hints arrive');
  for (let i = 1; i <= 5; i++) last().event(i, 'friends', 'presence', { username: 'Kara' });
  timers.advance(REALTIME_REFETCH_DEBOUNCE_MS);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lists, 3, 'five hints, one load');
  assert.deepEqual(hints, ['resync', 'presence']);
  timers.advance(FRIENDS_POLL_SLOW_MS);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lists, 4, 'the slow safety poll');
  // The channel drops: back to the 30 s poll from now on.
  last().drop(1006);
  timers.advance(FRIENDS_POLL_MS);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(lists >= 5, 'polled within 30 s of the drop');
  store.stop();
  const n = lists;
  last()?.event?.(99, 'friends', 'request', { username: 'Ivan' });
  timers.advance(FRIENDS_POLL_SLOW_MS * 2);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lists, n, 'stopped: no polls, no hints');
  assert.equal(realtime.subscriberCount(), 0);
});

test('FriendsStore: a hidden tab skips its polls', async () => {
  const timers = new FakeTimers();
  const page = { visibilityState: 'visible' };
  let lists = 0;
  const store = new FriendsStore({ client: { list: async () => ({ n: ++lists }) }, timers, doc: page });
  store.start();
  await new Promise((r) => setTimeout(r, 0));
  page.visibilityState = 'hidden';
  timers.advance(FRIENDS_POLL_MS * 3);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lists, 1);
  page.visibilityState = 'visible';
  timers.advance(FRIENDS_POLL_MS);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lists, 2);
  store.stop();
});

test('AccountSession: the channel runs while an account that may use it is signed in and the server offers it', async () => {
  const server = new MockAccountServer();
  const api = new AccountApi({ fetchImpl: server.fetch });
  const realtime = server.realtime.client();
  const session = new AccountSession({ api, realtime });
  const tanya = server.addUser({ username: 'Tanya', password: 'a long passphrase', status: 'pending_approval' });
  server.signIn(tanya);
  await session.refresh();
  assert.equal(realtime.state, 'stopped', 'the server does not offer it');
  server.services.realtime = true;
  await session.refresh();
  assert.equal(realtime.state, 'open', 'a pending account hears its approval');

  // The approval arrives: the session loads the account again.
  tanya.status = 'active';
  const before = server.requests.length;
  server.realtime.emit(tanya.id, { topic: 'account', kind: 'status', data: { status: 'active' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(session.user.status, 'active');
  assert.ok(server.requests.slice(before).some((r) => r.url.endsWith('/api/auth/me')));

  // Signed out elsewhere: the hub closes with 4001, the session finds out and the channel stops.
  server.cookie = null;
  server.realtime.signOut(tanya.id);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(session.user, null);
  assert.equal(realtime.state, 'stopped');

  // Banned accounts never connect.
  const boris = server.addUser({ username: 'Boris', password: 'a long passphrase' });
  boris.ban = { reason: 'x', expiresAt: null };
  server.signIn(boris);
  await session.refresh();
  assert.equal(realtime.state, 'stopped');
});

test('AccountSession: two refreshes at once load once', async () => {
  const server = new MockAccountServer();
  const session = new AccountSession({ api: new AccountApi({ fetchImpl: server.fetch }), realtime: null });
  await Promise.all([session.refresh(), session.refresh()]);
  assert.equal(server.requests.filter((r) => r.url.endsWith('/api/auth/me')).length, 1);
  await session.refresh();
  assert.equal(server.requests.filter((r) => r.url.endsWith('/api/auth/me')).length, 2);
});

test('settings: a hint with a newer version syncs now, the version this device has is ignored', async () => {
  const server = new MockAccountServer();
  const api = new AccountApi({ fetchImpl: server.fetch });
  const tanya = server.addUser({ username: 'Tanya', password: 'a long passphrase' });
  server.signIn(tanya);
  const sync = new SettingsSync({ api, registry: createRegistry({ storage: memoryStorage() }), storage: memoryStorage(), timers: new FakeTimers() });
  await sync.start({ id: tanya.id });
  const version = sync.state.version;
  const flushes = [];
  const real = sync.flush.bind(sync);
  sync.flush = () => (flushes.push(1), real());
  await sync.remoteChanged(version);
  assert.equal(flushes.length, 0, 'the version this device has');
  await sync.remoteChanged(version + 1);
  assert.equal(flushes.length, 1, 'a newer one');
  await sync.remoteChanged(undefined);
  assert.equal(flushes.length, 2, 'unknown (after a reconnect): sync to be sure');
  sync.stop();
  assert.equal(await sync.remoteChanged(version + 5), undefined, 'stopped: nothing');
  assert.equal(flushes.length, 2);
});

test('AccountSession: a settings hint reaches the sync; the catch-up right after loading is skipped', async () => {
  const server = new MockAccountServer();
  server.services.realtime = true;
  const api = new AccountApi({ fetchImpl: server.fetch });
  const realtime = server.realtime.client();
  let now = 1_000_000;
  const session = new AccountSession({ api, realtime, registry: createRegistry({ storage: memoryStorage() }), storage: memoryStorage(), now: () => now });
  const tanya = server.addUser({ username: 'Tanya', password: 'a long passphrase' });
  server.signIn(tanya);
  await session.refresh();
  const seen = [];
  session.sync.remoteChanged = async (v) => seen.push(v);
  server.realtime.emit(tanya.id, { topic: 'settings', kind: 'updated', data: { version: 9 } });
  assert.deepEqual(seen, [9]);
  for (const fn of realtime.subs.get('settings')) fn({ t: 'event', kind: 'resync', topic: 'settings', data: null, batch: [] });
  assert.deepEqual(seen, [9], 'fresh from the load: no second pull');
  now += 60_000;
  for (const fn of realtime.subs.get('settings')) fn({ t: 'event', kind: 'resync', topic: 'settings', data: null, batch: [] });
  assert.deepEqual(seen, [9, undefined], 'a later reconnect catches up');
});
