// Protocol 8 in the session Durable Object (in memory, see fake-do.mjs): the
// start gate, ping / pong, netstat, waiting, the stall log, invite codes,
// blocks and the directory summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DROP_AFTER_MS, INVITE_TTL_MS, LOAD_TIMEOUT_MS, NETSTAT_INTERVAL_MS, parseServerMessage, PROTOCOL_VERSION } from '@webra/protocol';
import { makeSession } from './fake-do.mjs';
import { FakeD1 } from './fake-d1.mjs';

const hello = (s, name, extra = {}) => ({ t: 'hello', protocol: PROTOCOL_VERSION, version: s.version, name, ...extra });

function assertValid(ws) {
  for (const m of ws.inbox) {
    const r = parseServerMessage(JSON.stringify(m));
    assert.ok(r.ok, `${ws.name} got an invalid ${m.t}: ${r.message}`);
  }
}

/** Host and guest (and spectators) in a lobby; the game started unless `start: false`. */
async function room(t, { spectators = 0, start = true, autoLoaded = false, DB, isPublic = false, auth = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const s = await makeSession({ autoLoaded, ...(DB ? { DB } : {}), isPublic });
  const host = s.connect('host', '10.0.0.1', auth.host);
  await s.send(host, hello(s, 'Host', { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  const guest = s.connect('guest', '10.0.0.2', auth.guest);
  await s.send(guest, hello(s, 'Guest'));
  const gw = guest.take('welcome')[0];
  if (spectators > 0) await s.send(host, { t: 'spectators', max: spectators });
  const watchers = [];
  for (let i = 0; i < spectators; i++) {
    const w = s.connect(`watcher${i}`);
    await s.send(w, hello(s, `Watcher ${i}`, { spectate: true }));
    watchers.push({ ws: w, welcome: w.take('welcome')[0] });
  }
  await s.send(guest, { t: 'ready', ready: true, mapHash: null });
  if (start) await s.send(host, { t: 'start' });
  const st = host.last('start');
  const seat = (you) => st?.players.find((p) => p.client === you)?.player;
  return { s, host, guest, hw, gw, watchers, hSeat: st && seat(hw.you), gSeat: st && seat(gw.you) };
}

const advance = (t, ms) => t.mock.timers.tick(ms);
const frameTicks = (ws) => ws.take('frame').map((f) => f.tick);
const orders = (s, ws, from, to) => (async () => {
  for (let k = from; k < to; k++) await s.send(ws, { t: 'orders', tick: k, orders: [] });
})();

// ---- The start gate ------------------------------------------------------------------------------

test('start gate: frames wait until every player loaded; spectators and repeats change nothing', async (t) => {
  const { s, host, guest, watchers } = await room(t, { spectators: 1 });
  assert.deepEqual(frameTicks(host), [0, 1, 2], 'the empty start frames go out at once');
  // The host loads, runs its start frames and sends orders up to its limit.
  await s.send(host, { t: 'loaded' });
  await orders(s, host, 3, 6);
  await orders(s, guest, 3, 6);
  assert.deepEqual(frameTicks(host), [], 'nothing past the start until the guest loaded');
  await s.send(watchers[0].ws, { t: 'loaded' });
  assert.deepEqual(frameTicks(host), [], 'a spectator is no part of the gate');
  // A long load is no stall: the alarm neither drops nor reports anybody.
  advance(t, 30_000);
  await s.session.alarm();
  assert.equal(guest.closed, null);
  assert.deepEqual(host.take('waiting'), []);
  assert.deepEqual([...s.session.lockstep.windows.values()].map((w) => w.debtMs), [0, 0]);
  await s.send(guest, { t: 'loaded' });
  assert.deepEqual(frameTicks(host), [3, 4, 5]);
  await s.send(guest, { t: 'loaded' });
  assert.deepEqual(guest.take('error'), [], 'a repeat is ignored');
  assert.equal(s.session.lockstep.stalls.length, 0);
  assertValid(host);
  assertValid(watchers[0].ws);
});

test('start gate: loaded in the lobby is refused', async (t) => {
  const { s, host } = await room(t, { start: false });
  await s.send(host, { t: 'loaded' });
  assert.equal(host.take('error')[0].code, 'bad_state');
});

test('start gate: a player that does not load within LOAD_TIMEOUT_MS is dropped (it can rejoin); the others begin', async (t) => {
  const { s, host, guest, gSeat } = await room(t);
  host.take('frame');
  await s.send(host, { t: 'loaded' });
  await orders(s, host, 3, 6);
  advance(t, LOAD_TIMEOUT_MS);
  await s.session.alarm();
  assert.equal(guest.closed, null, 'not before the deadline');
  advance(t, 1001);
  await s.session.alarm();
  const err = guest.take('error')[0];
  assert.equal(err.code, 'dropped');
  assert.match(err.message, /did not finish loading in time\. You can rejoin\./);
  assert.ok(guest.closed);
  assert.equal(host.take('left')[0].reason, 'dropped');
  assert.equal(s.session.room.seatState(gSeat), 'away', 'the seat waits for a rejoin');
  assert.deepEqual(frameTicks(host), [3, 4, 5], 'the host plays on');
});

// ---- Ping, pong, netstat --------------------------------------------------------------------------

test('ping: pong at once with n and at; netstat to the whole room, players only, at most every 2 s', async (t) => {
  const { s, host, guest, watchers, hw, gw } = await room(t, { spectators: 1, start: false });
  const w = watchers[0].ws;
  await s.send(host, { t: 'ping', n: 1, at: 777 });
  assert.deepEqual(host.take('pong'), [{ t: 'pong', n: 1, at: 777 }]);
  assert.deepEqual(guest.take('pong'), [], 'only the sender gets its pong');
  const first = w.take('netstat');
  assert.equal(first.length, 1, 'the first ping starts the cadence');
  assert.deepEqual(first[0].players.map((p) => p.client).sort(), [hw.you, gw.you].sort(), 'spectators get it but are not listed');
  host.take('netstat');
  guest.take('netstat');
  // Within the interval: pongs, no netstat.
  advance(t, 500);
  await s.send(guest, { t: 'ping', n: 1, at: 10, rtt: 34, jitter: 4, late: 0 });
  assert.equal(guest.take('pong').length, 1);
  assert.deepEqual(host.take('netstat'), []);
  advance(t, NETSTAT_INTERVAL_MS);
  await s.send(host, { t: 'ping', n: 2, at: 2777, rtt: 21, jitter: 2, late: 0.5 });
  const ns = host.take('netstat');
  assert.equal(ns.length, 1);
  const byClient = Object.fromEntries(ns[0].players.map((p) => [p.client, p]));
  assert.deepEqual(byClient[gw.you], { client: gw.you, rtt: 34, jitter: 4, late: 0 });
  assert.deepEqual(byClient[hw.you], { client: hw.you, rtt: 21, jitter: 2, late: 0.5 });
  // A player that stopped pinging is marked silent.
  advance(t, 6000);
  await s.send(host, { t: 'ping', n: 3, at: 9000, rtt: 22, jitter: 2, late: 0 });
  const quiet = host.take('netstat')[0].players.find((p) => p.client === gw.you);
  assert.equal(quiet.silent, 8000, 'since its last ping');
  assert.equal(quiet.rtt, 34, 'its last measurement stays');
  assertValid(host);
  assertValid(w);
});

test('ping: before hello it is refused; the measurement survives hibernation in the attachment', async (t) => {
  const { s, host } = await room(t, { start: false });
  const early = s.connect('early');
  await s.send(early, { t: 'ping', n: 1, at: 1 });
  assert.equal(early.take('error')[0].code, 'bad_state');
  await s.send(host, { t: 'ping', n: 1, at: 1, rtt: 40, jitter: 5, late: 0 });
  assert.deepEqual({ ...host.deserializeAttachment().net, at: 0 }, { rtt: 40, jitter: 5, late: 0, at: 0 });
});

test('ping budget: its own small bucket beside the rate limit; a flood closes the connection', async (t) => {
  const { s, host } = await room(t, { start: false });
  for (let i = 0; i < 8; i++) await s.send(host, { t: 'ping', n: i, at: i });
  assert.equal(host.take('pong').length, 6, 'a burst of six, the rest unanswered');
  assert.equal(host.closed, null);
  advance(t, 1000);
  await s.send(host, { t: 'ping', n: 9, at: 9 });
  assert.equal(host.take('pong').length, 1, 'two a second come back');
  // Chat is not touched by pings.
  await s.send(host, { t: 'chat', text: 'hi' });
  assert.equal(host.take('chat').length, 1);
  for (let i = 0; i < 300 && !host.closed; i++) {
    advance(t, 20);
    await s.send(host, { t: 'ping', n: i, at: i });
  }
  assert.ok(host.closed, 'a ping flood ends the connection');
});

// ---- Waiting and the stall log ------------------------------------------------------------------

test('waiting: the alarm names the player the game waits for; its orders end the wait at once', async (t) => {
  const { s, host, guest, gw, watchers } = await room(t, { spectators: 1, autoLoaded: true });
  const w = watchers[0].ws;
  await orders(s, host, 3, 6);
  await orders(s, guest, 3, 5);
  advance(t, 500);
  await s.session.alarm();
  assert.deepEqual(host.take('waiting'), [], 'within the grace nobody waits');
  advance(t, 1500);
  await s.session.alarm();
  const msg = host.take('waiting');
  assert.equal(msg.length, 1);
  assert.equal(msg[0].client, gw.you);
  assert.equal(msg[0].heldMs, 2000);
  assert.ok(msg[0].dropInMs > 0 && msg[0].dropInMs < DROP_AFTER_MS);
  assert.equal(w.take('waiting').length, 1, 'spectators see it too');
  advance(t, 1000);
  await s.session.alarm();
  const again = host.take('waiting')[0];
  assert.equal(again.heldMs, 3000, 'repeated every alarm with the times moving on');
  assert.ok(again.dropInMs < msg[0].dropInMs);
  await s.send(guest, { t: 'orders', tick: 5, orders: [] });
  assert.deepEqual(host.take('waiting'), [{ t: 'waiting', client: null }]);
  await s.session.alarm();
  assert.deepEqual(host.take('waiting'), [], 'said once');
  // The stall log names the client and the frame.
  await s.send(host, { t: 'stalls' });
  const log = host.take('stalls')[0];
  assert.deepEqual(log.stalls, [{ tick: 5, client: gw.you, ms: 3000 }]);
  assert.deepEqual(log.totals, [{ client: gw.you, ms: 3000, count: 1 }]);
  assertValid(host);
  assertValid(w);
});

test('stall log: empty in the lobby; asked for at most every few seconds', async (t) => {
  const { s, host } = await room(t, { start: false });
  await s.send(host, { t: 'stalls' });
  assert.deepEqual(host.take('stalls'), [{ t: 'stalls', stalls: [], totals: [] }]);
  await s.send(host, { t: 'stalls' });
  await s.send(host, { t: 'stalls' });
  assert.equal(host.take('stalls').length, 1);
  assert.equal(host.take('error')[0].code, 'rate_limited');
  advance(t, 5000);
  await s.send(host, { t: 'stalls' });
  assert.equal(host.take('stalls').length, 1);
});

test('a player dropped for stalling ends the wait for everyone', async (t) => {
  const { s, host, guest } = await room(t, { autoLoaded: true });
  await orders(s, host, 3, 6);
  advance(t, 3000);
  await s.session.alarm();
  assert.equal(host.take('waiting').length, 1);
  for (let i = 0; i < 12 && !guest.closed; i++) {
    advance(t, 1000);
    await s.session.alarm();
  }
  assert.ok(guest.closed);
  assert.equal(host.take('waiting').at(-1).client, null);
  assert.equal(s.session.lockstep.stalls.length, 1, 'the wait that ended in the drop is logged');
});

// ---- Invite codes, blocks, directory ----------------------------------------------------------------

function addUser(db, id, username) {
  db.sqlite
    .prepare(
      "INSERT INTO users (id, username, username_key, display_name, avatar_color, status, user_handle, created_at) VALUES (?, ?, ?, ?, '#c8402a', 'active', ?, 0)",
    )
    .run(id, username, username.toLowerCase(), username, `h-${id}`);
}

test('invite codes: the host makes one, members see it, a new one replaces it, the start ends it', async (t) => {
  const DB = new FakeD1();
  const { s, host, guest, hw, gw } = await room(t, { start: false, DB });
  const member = (w) => ({ client: w.you, key: w.key });
  const notHost = await s.session.newInvite({ member: member(gw), ip: '10.0.0.2' });
  assert.equal(notHost.code, 'not_host');
  const r = await s.session.newInvite({ member: member(hw), ip: '10.0.0.1' });
  assert.equal(r.ok, true);
  assert.match(r.code, /^[2-9A-HJKMNP-Z]{6}$/);
  assert.equal(r.expiresAt, Date.now() + INVITE_TTL_MS);
  assert.deepEqual(guest.last('lobby').invite, { code: r.code, expiresAt: r.expiresAt });
  const dir = DB.rows('SELECT public, state, summary_json FROM sessions');
  assert.deepEqual([dir[0].public, dir[0].state], [0, 'lobby'], 'a private session has an unlisted row for the lookup');
  const summary = JSON.parse(dir[0].summary_json);
  assert.deepEqual(summary.players.map((p) => p.name), ['Host', 'Guest']);
  assert.equal(summary.mode, 'weatherwar', 'the default options are the Weather war mode');
  // A new code: the old one has ended.
  advance(t, 1000);
  const r2 = await s.session.newInvite({ member: member(hw), ip: '10.0.0.1' });
  assert.notEqual(r2.code, r.code);
  const rows = Object.fromEntries(DB.rows('SELECT code, expires_at FROM invite_codes').map((x) => [x.code, x.expires_at]));
  assert.equal(rows[r.code], Date.now());
  assert.equal(rows[r2.code], Date.now() + INVITE_TTL_MS);
  // A wrong key is refused.
  const thief = await s.session.newInvite({ member: { client: hw.you, key: 'x'.repeat(43) }, ip: '10.9.9.9' });
  assert.equal(thief.code, 'forbidden');
  // The start ends the code.
  await s.send(host, { t: 'start' });
  assert.ok(DB.rows('SELECT expires_at FROM invite_codes WHERE code = ?', r2.code)[0].expires_at <= Date.now());
  assert.equal(s.session.meta.invite, null);
  const late = await s.session.newInvite({ member: member(hw), ip: '10.0.0.1' });
  assert.equal(late.code, 'bad_state');
  assertValid(guest);
});

test('blocks: a player blocked by a present member cannot join; others can', async (t) => {
  const DB = new FakeD1();
  const ids = { host: 'a'.repeat(32), guest: 'b'.repeat(32), pest: 'c'.repeat(32), friend: 'd'.repeat(32) };
  for (const [k, id] of Object.entries(ids)) addUser(DB, id, k);
  DB.sqlite.prepare('INSERT INTO user_blocks (user_id, blocked_id, created_at) VALUES (?, ?, 0)').run(ids.host, ids.pest);
  const acc = (k) => ({ account: { id: ids[k], username: k }, refuse: null });
  const { s } = await room(t, { start: false, DB, auth: { host: acc('host'), guest: acc('guest') } });
  const pest = s.connect('pest', '10.0.0.7', acc('pest'));
  await s.send(pest, hello(s, 'pest', { spectate: true }));
  const err = pest.take('error')[0];
  assert.equal(err.code, 'forbidden');
  assert.equal(err.message, 'You cannot join this session.', 'who blocked it is not said');
  assert.ok(pest.closed);
  const friend = s.connect('friend', '10.0.0.8', acc('friend'));
  await s.send(host0(s), { t: 'spectators', max: 2 });
  await s.send(friend, hello(s, 'friend', { spectate: true }));
  assert.equal(friend.take('welcome').length, 1);
});

/** The host's socket of a session from `room`. */
function host0(s) {
  return s.ctx.getWebSockets().find((w) => w.name === 'host');
}

test('directory: a public session lists its summary; options alone are written at most every 10 s', async (t) => {
  const DB = new FakeD1();
  const { s, host } = await room(t, { start: false, DB, isPublic: true });
  const row = () => DB.rows('SELECT public, players, summary_json, updated_at FROM sessions')[0];
  assert.equal(row().public, 1);
  const before = row().updated_at;
  const opts = { ...s.session.room.options, startingCash: 10000 };
  advance(t, 1000);
  await s.send(host, { t: 'options', options: opts });
  assert.equal(row().updated_at, before, 'a summary change waits');
  assert.ok((await s.ctx.storage.getAlarm()) <= before + 10_000, 'the alarm writes it later');
  advance(t, 9000);
  await s.session.alarm();
  assert.equal(JSON.parse(row().summary_json).options.startingCash, 10000);
  // The game starts: the state and the start time are written at once.
  await s.send(s.ctx.getWebSockets().find((w) => w.name === 'guest'), { t: 'ready', ready: true, mapHash: null });
  await s.send(host, { t: 'start' });
  const started = JSON.parse(row().summary_json);
  assert.equal(started.startedAt, Date.now());
  assert.equal(DB.rows('SELECT state FROM sessions')[0].state, 'game');
});
