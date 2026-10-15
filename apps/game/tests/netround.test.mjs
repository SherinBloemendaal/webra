// Client data modules of the protocol 8 round: connection quality
// (js/netquality.js), invite codes (js/invites.js) and friends
// (js/account/friends.js). No DOM, no network: fake connections, clocks and APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetMeter, NetQuality, SERIES_MAX, SERIES_STEP_MS, STALLS_TIMEOUT_MS } from '../js/netquality.js';
import { clearInviteFromLocation, inviteFromLocation, inviteLink, lookupInvite, INVITE_MESSAGES } from '../js/invites.js';
import { FriendsClient, FriendsStore, PresenceTracker } from '../js/account/friends.js';
import { AccountError } from '../js/account/api.js';
import { ApiError } from '../js/net.js';
import { encodeClient, parseClientMessage, PRESENCE_AWAY_MS, PRESENCE_INTERVAL_MS } from '../js/protocol.js';

/** Timers driven by hand. */
class FakeTimers {
  constructor() {
    this.now = 0;
    this.next = 1;
    this.jobs = new Map();
  }

  setTimeout(fn, ms) {
    const id = this.next++;
    this.jobs.set(id, { fn, at: this.now + ms, every: null });
    return id;
  }

  setInterval(fn, ms) {
    const id = this.next++;
    this.jobs.set(id, { fn, at: this.now + ms, every: ms });
    return id;
  }

  clearTimeout(id) {
    this.jobs.delete(id);
  }

  clearInterval(id) {
    this.jobs.delete(id);
  }

  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, job] = due;
      this.now = job.at;
      if (job.every) job.at += job.every;
      else this.jobs.delete(id);
      job.fn();
    }
    this.now = end;
  }
}

/** A Connection stand-in: records sent messages (validated like net.js does), lets the test deliver server messages. */
class FakeConn {
  constructor() {
    this.sent = [];
    this.handlers = new Map();
  }

  on(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  send(msg) {
    const raw = encodeClient(msg);
    assert.ok(parseClientMessage(raw).ok);
    this.sent.push(JSON.parse(raw));
  }

  deliver(msg) {
    this.handlers.get(msg.t)?.(msg);
  }

  pings() {
    return this.sent.filter((m) => m.t === 'ping');
  }
}

function setup() {
  const timers = new FakeTimers();
  let wall = 1_000_000;
  const nq = new NetQuality({ now: () => timers.now, wallNow: () => wall + timers.now, timers });
  const conn = new FakeConn();
  return { timers, nq, conn, wall: () => wall + timers.now };
}

test('meter: median round trip, jitter, late pings (slow or never answered), counted once', () => {
  const m = new NetMeter();
  assert.equal(m.measurement(), null);
  let t = 0;
  for (const rtt of [30, 40, 35, 30, 2000]) {
    m.noteSent(m.sent + 1, t);
    if (rtt === 2000) m.expire(t + 1500);
    m.notePong(m.sent, t, t + rtt);
    t += 2000;
  }
  const r = m.measurement();
  assert.equal(r.rtt, 35, 'the median ignores one outlier');
  assert.equal(r.late, 20, 'one of five late');
  assert.equal(m.late, 1, 'the slow pong was counted once');
  // A ping that never comes back is late after LATE_PING_MS; a repeated or unknown pong is ignored.
  m.noteSent(99, t);
  m.expire(t + 1001);
  assert.equal(m.late, 2);
  assert.equal(m.notePong(99, t + 1, t + 5), null, 'wrong at');
  assert.equal(m.notePong(1234, 0, 5), null);
});

test('NetQuality: pings every 2 s carrying the last measurement; self, players and waiting events', () => {
  const { timers, nq, conn } = setup();
  const selfs = [];
  const playerEvents = [];
  const waits = [];
  nq.on('self', (s) => selfs.push(s));
  nq.on('players', (p) => playerEvents.push(p));
  nq.on('waiting', (w) => waits.push(w));
  nq.attach(conn, { you: 2 });
  assert.equal(conn.pings().length, 1, 'one at once');
  const first = conn.pings()[0];
  assert.equal(first.rtt, undefined, 'no measurement yet');
  timers.advance(40);
  conn.deliver({ t: 'pong', n: first.n, at: first.at });
  assert.equal(selfs.at(-1).rtt, 40);
  assert.equal(selfs.at(-1).quality, 'good');
  assert.equal(selfs.at(-1).bars, 4);
  timers.advance(1960);
  const second = conn.pings()[1];
  assert.deepEqual([second.rtt, second.jitter, second.late], [40, 0, 0]);
  conn.deliver({ t: 'netstat', players: [{ client: 2, rtt: 40, jitter: 0, late: 0 }, { client: 5, rtt: 210, jitter: 60, late: 4 }] });
  const p = playerEvents.at(-1);
  assert.equal(p.get(5).quality, 'poor');
  assert.equal(p.get(5).bars, 1);
  assert.equal(p.get(2).you, true);
  conn.deliver({ t: 'waiting', client: 5, heldMs: 2000, dropInMs: 8000 });
  assert.deepEqual(waits.at(-1), { client: 5, heldMs: 2000, dropInMs: 8000, at: nq.wallNow() });
  conn.deliver({ t: 'waiting', client: null });
  assert.equal(waits.at(-1), null);
  // Own connection going bad: poorSince starts and holds while it stays poor.
  for (let i = 0; i < 12; i++) {
    const ping = conn.pings().at(-1);
    timers.advance(400);
    conn.deliver({ t: 'pong', n: ping.n, at: ping.at });
    timers.advance(1600);
  }
  assert.equal(nq.self.quality, 'poor');
  assert.ok(nq.poorForMs() >= 10_000, String(nq.poorForMs()));
  // Test again: three more pings within a second; detach stops pinging.
  const before = conn.pings().length;
  nq.testAgain();
  timers.advance(600);
  assert.equal(conn.pings().length, before + 3);
  nq.detach();
  timers.advance(10_000);
  assert.equal(conn.pings().length, before + 3);
});

test('statistics: one point per 10 s per player, compacted to keep the whole game; report per player', () => {
  const { timers, nq, conn } = setup();
  nq.attach(conn, { you: 1 });
  nq.beginGame();
  const report = (rtt) => conn.deliver({ t: 'netstat', players: [{ client: 1, rtt, jitter: 2, late: 0 }, { client: 2, rtt: null, jitter: null, late: null }] });
  for (let i = 0; i < 5; i++) {
    report(i === 3 ? 90 : 30);
    timers.advance(2000);
  }
  report(50);
  const r = nq.report().get(1);
  assert.equal(r.series.length, 2, 'the first 10 s and the current point');
  assert.equal(r.series[0].rtt, 42);
  assert.equal(r.series[0].worst, 90);
  assert.equal(r.worst, 90);
  assert.equal(r.worstAt, 6000);
  assert.equal(r.avg, 43);
  assert.equal(nq.report().has(2), false, 'players without a measurement have no series');
  // A long game: never more than SERIES_MAX points, covering everything.
  for (let i = 0; i < 1000; i++) {
    timers.advance(SERIES_STEP_MS);
    report(30);
  }
  const long = nq.report().get(1).series;
  assert.ok(long.length <= SERIES_MAX + 1, String(long.length));
  assert.equal(long[0].t, 0);
  assert.ok(long.at(-1).t >= 1000 * SERIES_STEP_MS - nq.step);
});

test('stall log: requested, answered, timed out', async () => {
  const { timers, nq, conn } = setup();
  nq.attach(conn);
  const p = nq.requestStalls();
  assert.equal(conn.sent.at(-1).t, 'stalls');
  conn.deliver({ t: 'stalls', stalls: [{ tick: 200, client: 2, ms: 1800 }], totals: [{ client: 2, ms: 1800, count: 1 }] });
  assert.deepEqual((await p).stalls, [{ tick: 200, client: 2, ms: 1800 }]);
  const late = nq.requestStalls();
  timers.advance(STALLS_TIMEOUT_MS + 1);
  await assert.rejects(late, /did not answer/);
  const closed = nq.requestStalls();
  nq.detach();
  await assert.rejects(closed, /closed/);
  await assert.rejects(nq.requestStalls(), /Not connected/);
});

test('invites: what a player types or pastes; lookup answers mapped to the dialog messages', async () => {
  const invite = { code: 'K7Q-2MX', session: 'a'.repeat(64), name: 'Friday', players: 4, maxPlayers: 4, spectators: 0, maxSpectators: 2, locked: true };
  const seen = [];
  const lookup = async (code) => (seen.push(code), { invite });
  const r = await lookupInvite('https://webra.sherin.dev/join/k7q2mx', { lookup });
  assert.deepEqual(seen, ['K7Q-2MX']);
  assert.deepEqual([r.ok, r.full, r.canSpectate, r.message], [true, true, true, INVITE_MESSAGES.full]);
  assert.deepEqual(await lookupInvite('nope', { lookup }), { ok: false, reason: 'invalid', message: INVITE_MESSAGES.invalid });
  const failing = (status) => async () => {
    throw new ApiError(status, 'x', 'server says');
  };
  assert.equal((await lookupInvite('K7Q2MX', { lookup: failing(404) })).reason, 'unknown');
  assert.equal((await lookupInvite('K7Q2MX', { lookup: failing(410) })).message, INVITE_MESSAGES.expired);
  assert.equal((await lookupInvite('K7Q2MX', { lookup: failing(429) })).reason, 'rate_limited');
  assert.equal((await lookupInvite('K7Q2MX', { lookup: failing(0) })).message, INVITE_MESSAGES.offline);
  assert.equal(inviteLink('k7q2mx', 'https://webra.sherin.dev'), 'https://webra.sherin.dev/join/K7Q-2MX');
  assert.equal(inviteFromLocation({ href: 'https://x/play/?invite=K7Q-2MX' }), 'K7Q2MX');
  assert.equal(inviteFromLocation({ href: 'https://x/play/' }), null);
  const replaced = [];
  clearInviteFromLocation({ href: 'https://x/play/?invite=K7Q-2MX&a=1#h' }, { state: null, replaceState: (_s, _t, url) => replaced.push(url) });
  assert.deepEqual(replaced, ['/play/?a=1#h']);
});

test('friends: the client calls the documented endpoints; the store polls and refreshes after actions', async () => {
  const calls = [];
  const fakeApi = {
    get: async (path) => (calls.push(['GET', path]), { friends: [], incoming: [] }),
    post: async (path, body) => (calls.push(['POST', path, body]), {}),
    del: async (path) => (calls.push(['DELETE', path]), {}),
  };
  const client = new FriendsClient(fakeApi);
  await client.request('Ivan');
  await client.accept('A b');
  await client.dismissInvite('Kara', { sent: true });
  await client.presence(true, 1234.4);
  assert.deepEqual(calls, [
    ['POST', '/api/account/friends/requests', { username: 'Ivan' }],
    ['POST', '/api/account/friends/requests/A%20b/accept', undefined],
    ['DELETE', '/api/account/friends/invites/Kara?sent=1'],
    ['POST', '/api/account/presence', { away: true, idleMs: 1234 }],
  ]);
  const timers = new FakeTimers();
  const store = new FriendsStore({ client, timers, pollMs: 30_000 });
  const docs = [];
  store.on('change', (d) => docs.push(d));
  store.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(docs.length, 1);
  timers.advance(30_000);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(docs.length, 2, 'polled');
  await store.block('Pest');
  assert.equal(docs.length, 3, 'refreshed after the action');
  store.stop();
  timers.advance(60_000);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(docs.length, 3);
  // Signed out: polling stops.
  const out = new FriendsStore({
    client: { list: async () => Promise.reject(new AccountError(401, 'unauthenticated', 'Sign in first.')) },
    timers,
  });
  const errors = [];
  out.on('error', (e) => errors.push(e.code));
  out.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(errors, ['unauthenticated']);
  assert.equal(out.running, false);
});

test('presence: a heartbeat a minute, away after 10 minutes without input (at once), back on input', async () => {
  const timers = new FakeTimers();
  const beats = [];
  const listeners = new Map();
  const target = { addEventListener: (e, fn) => listeners.set(e, fn), removeEventListener: (e) => listeners.delete(e) };
  const tracker = new PresenceTracker({ client: { presence: async (away, idle) => beats.push([timers.now, away, idle]) }, target, now: () => timers.now, timers });
  tracker.start();
  assert.deepEqual(beats, [[0, false, 0]]);
  timers.advance(PRESENCE_INTERVAL_MS);
  assert.equal(beats.length, 2);
  timers.advance(PRESENCE_AWAY_MS);
  const away = beats.find((b) => b[1]);
  assert.ok(away, 'went away');
  assert.ok(away[0] - PRESENCE_AWAY_MS <= 30_000, 'within half a minute of the threshold');
  assert.ok(away[2] >= PRESENCE_AWAY_MS);
  listeners.get('keydown')();
  assert.deepEqual(beats.at(-1).slice(1), [false, 0], 'back at once');
  tracker.stop();
  assert.equal(listeners.size, 0);
  const n = beats.length;
  timers.advance(10 * PRESENCE_INTERVAL_MS);
  assert.equal(beats.length, n);
});
