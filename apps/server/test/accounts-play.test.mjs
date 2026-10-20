// Online play with accounts (docs/accounts-api.md section 7): session
// creation, map uploads and WebSocket upgrades through the Worker, the
// session Durable Object's hello with accounts, bans dropping players, and
// the content relay gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '@webra/protocol';
import { Browser, Clock, makeEnv, ORIGIN, PASSWORD, promote, setSite, signup } from './accounts-harness.mjs';
import { makeSession, readAuthHeader } from './fake-do.mjs';
import { FakeD1 } from './fake-d1.mjs';
import { upgrades } from '../src/wsrefuse.js';

const clock = new Clock();
test.after(() => clock.restore());

const create = (b) => b.post('/api/sessions', { name: 'Game', public: true, maxPlayers: 2, version: '1.0.0' });
const SID = 'c'.repeat(64);
// Node's Response has no 101: a refused upgrade answers what its server side sent instead.
upgrades.respond = (client, server) => new Response(JSON.stringify({ sent: server.inbox, closed: server.closed, accepted: server.accepted === true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

const upgrade = (b, extra = {}) =>
  b.get(`/api/sessions/${SID}/ws`, { csrf: false, json: false, headers: { Upgrade: 'websocket', 'Sec-Fetch-Site': null, ...extra } });

test('creating sessions needs an active account (setting on), and works anonymously with it off', async () => {
  const env = makeEnv({ email: false });
  const anon = new Browser(env);
  const r1 = await create(anon);
  assert.equal(r1.status, 401);
  assert.equal(r1.body.error.code, 'unauthenticated');
  const pending = await signup(env, 'Pending');
  const r2 = await create(pending);
  assert.equal(r2.status, 403);
  assert.equal(r2.body.error.code, 'account_inactive');
  assert.equal(r2.body.error.status, 'pending_approval');
  promote(env, pending.user.id);
  const r3 = await create(pending);
  assert.equal(r3.status, 201, JSON.stringify(r3.body));
  assert.equal(env.SESSION.inits.length, 1);
  await setSite(env, { onlineRequiresAccount: false });
  assert.equal((await create(anon)).status, 201);
  // IP bans apply either way.
  env.DB.sqlite.prepare("INSERT INTO ip_bans (cidr, ip_v, start_hex, end_hex, reason, created_at) VALUES ('198.51.100.7', 4, 'c6336407', 'c6336407', 'x', 0)").run();
  assert.equal((await create(anon)).body.error.code, 'ip_banned');
});

test('onlineSessionsOpen off: no new sessions (503 sessions_closed with a message), sockets to running ones still work', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Host Player');
  promote(env, b.user.id);
  await b.post('/api/auth/login', { login: 'host player', password: PASSWORD });
  assert.equal((await new Browser(env).get('/api/site', { csrf: false })).body.onlineSessionsOpen, true, 'on by default');
  assert.equal((await create(b)).status, 201);
  await setSite(env, { onlineSessionsOpen: false });
  assert.equal((await new Browser(env).get('/api/site', { csrf: false })).body.onlineSessionsOpen, false, 'the game can tell before it asks');
  const r = await create(b);
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'sessions_closed');
  assert.match(r.body.error.message, /paused.*running go on/s);
  assert.equal(r.res.headers.get('retry-after'), '300');
  assert.equal(env.SESSION.inits.length, 1, 'no session object was made');
  // Joining a session that already exists goes on as before.
  const fetches = env.SESSION.fetches.length;
  assert.equal((await upgrade(b)).status, 200);
  assert.equal(env.SESSION.fetches.length, fetches + 1);
  // An anonymous request is told the same (no sign-in prompt for a paused server).
  assert.equal((await create(new Browser(env))).body.error.code, 'sessions_closed');
  await setSite(env, { onlineSessionsOpen: true });
  assert.equal((await create(b)).status, 201);
});

test('map uploads need an active account and record the uploader', async () => {
  const env = makeEnv({ email: false });
  const w = 48;
  const terrain = Buffer.alloc(w * w).toString('base64');
  const map = { format: 1, name: 'Accounts map', author: 'Tester', width: w, height: w, terrain, ore: terrain, spawns: [[2, 2], [40, 40]] };
  assert.equal((await new Browser(env).post('/api/maps', map)).status, 401);
  const b = await signup(env, 'Mapper');
  promote(env, b.user.id);
  const r = await b.post('/api/maps', map);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(env.DB.rows('SELECT uploader_id FROM maps')[0].uploader_id, b.user.id);
  // Listing and downloading stay public.
  assert.equal((await new Browser(env).get('/api/maps', { csrf: false })).status, 200);
});

test('WebSocket upgrade: the Worker tells the session who connects; clients cannot forge it', async () => {
  const env = makeEnv({ email: false });
  const b = await signup(env, 'Player One');
  promote(env, b.user.id);
  await b.post('/api/auth/login', { login: 'player one', password: PASSWORD });
  const r = await upgrade(b, { 'X-WebRA-Auth': JSON.stringify({ account: { id: 'f'.repeat(32), username: 'Admin' }, refuse: null }) });
  assert.equal(r.status, 200);
  const forwarded = env.SESSION.fetches.at(-1).request;
  assert.equal(forwarded.headers.get('Cookie'), null, 'the session cookie does not reach the object');
  assert.deepEqual(readAuthHeader(forwarded), { account: { id: b.user.id, username: 'Player One' }, refuse: null });
  // Anonymous with accounts required: the Worker answers with its own socket that says why and
  // closes; the session object is never woken (refused sockets hold none of its pending places).
  const count = env.SESSION.fetches.length;
  const anonRefused = await upgrade(new Browser(env));
  assert.equal(anonRefused.status, 200, 'the test stand-in for 101');
  assert.deepEqual(anonRefused.body.sent, [{ t: 'error', code: 'account_required', message: 'Sign in to play online.' }]);
  assert.deepEqual(anonRefused.body.closed, { code: 1008, reason: 'account_required' });
  assert.equal(anonRefused.body.accepted, true);
  assert.equal(env.SESSION.fetches.length, count);
  // Pending account.
  const p = await signup(env, 'Waiting');
  const pendingRefused = await upgrade(p);
  assert.equal(pendingRefused.body.sent[0].code, 'account_inactive');
  assert.equal(env.SESSION.fetches.length, count);
  // Cross-origin upgrades never reach the object.
  const before = env.SESSION.fetches.length;
  assert.equal((await upgrade(b, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await upgrade(b, { Origin: null })).status, 403);
  assert.equal(env.SESSION.fetches.length, before);
  // Anonymous play allowed: no refusal, no account.
  await setSite(env, { onlineRequiresAccount: false });
  await upgrade(new Browser(env));
  assert.deepEqual(readAuthHeader(env.SESSION.fetches.at(-1).request), { account: null, refuse: null });
  // Malformed or missing headers read as refused (only the Worker sets them).
  assert.ok(readAuthHeader(new Request(ORIGIN)).refuse);
  assert.ok(readAuthHeader(new Request(ORIGIN, { headers: { 'X-WebRA-Auth': '{"account":{"id":"x","username":"y"},"refuse":null}' } })).refuse);
});

const hello = (s, extra = {}) => ({ t: 'hello', protocol: PROTOCOL_VERSION, version: s.version, ...extra });
const acct = (n) => ({ id: n.toString(16).padStart(32, '0'), username: `User ${n}` });
const auth = (n) => ({ account: acct(n), refuse: null });

test('session hello: refusals, usernames from accounts, one place per account, account marks', async () => {
  const s = await makeSession({ maxPlayers: 3 });
  const refused = s.connect('refused', undefined, { account: null, refuse: { code: 'account_required', message: 'Sign in to play online.' } });
  await s.send(refused, hello(s, { name: 'Anon' }));
  assert.equal(refused.last('error').code, 'account_required');
  assert.ok(refused.closed);
  const host = s.connect('host', undefined, auth(1));
  await s.send(host, hello(s, { name: 'Pretender', hostKey: s.hostKey }));
  const w = host.last('welcome');
  assert.equal(w.name, 'User 1', 'the username, not the name sent');
  const lobby = host.last('lobby');
  assert.equal(lobby.slots[0].name, 'User 1');
  assert.equal(lobby.slots[0].account, true);
  // The same account again (another tab): refused, as player or spectator.
  for (const spectate of [false, true]) {
    const twin = s.connect('twin', undefined, auth(1));
    await s.send(twin, hello(s, { spectate }));
    assert.equal(twin.last('error').code, 'bad_state');
  }
  // An anonymous connection (when allowed) must name itself and has no mark.
  const anon = s.connect('anon');
  await s.send(anon, hello(s));
  assert.equal(anon.last('error').code, 'invalid');
  const anon2 = s.connect('anon2');
  await s.send(anon2, hello(s, { name: 'Guest' }));
  assert.equal(anon2.last('welcome').name, 'Guest');
  const l2 = anon2.last('lobby');
  assert.equal(l2.slots[1].account, undefined);
  assert.equal(JSON.stringify(l2).includes(acct(1).id), false, 'account ids are never published');
});

test('rejoin keys only work for the same account', async () => {
  const s = await makeSession({ maxPlayers: 2 });
  const host = s.connect('host', undefined, auth(1));
  await s.send(host, hello(s, { hostKey: s.hostKey }));
  const guest = s.connect('guest', undefined, auth(2));
  await s.send(guest, hello(s));
  const gw = guest.last('welcome');
  await s.send(guest, { t: 'ready', ready: true, mapHash: null });
  await s.send(host, { t: 'start' });
  assert.ok(host.last('start'));
  await s.drop(guest);
  const thief = s.connect('thief', undefined, auth(3));
  await s.send(thief, hello(s, { rejoin: { client: gw.you, key: gw.key } }));
  assert.equal(thief.last('error').code, 'forbidden', 'another account with a stolen key');
  const anon = s.connect('anon');
  await s.send(anon, hello(s, { name: 'x', rejoin: { client: gw.you, key: gw.key } }));
  assert.equal(anon.last('error').code, 'forbidden');
  const back = s.connect('back', undefined, auth(2));
  await s.send(back, hello(s, { rejoin: { client: gw.you, key: gw.key } }));
  assert.equal(back.last('welcome').you, gw.you);
  assert.equal(back.last('welcome').name, 'User 2');
});

test('evict: banned accounts and ranges are dropped for good; presence rows follow members', async () => {
  const DB = new FakeD1();
  const s = await makeSession({ maxPlayers: 3, DB });
  const host = s.connect('host', '10.0.0.1', auth(1));
  await s.send(host, hello(s, { hostKey: s.hostKey }));
  const guest = s.connect('guest', '10.0.0.2', auth(2));
  await s.send(guest, hello(s));
  const third = s.connect('third', '192.0.2.9');
  await s.send(third, hello(s, { name: 'Anon' }));
  const presence = () => DB.rows('SELECT client, user_id, ip_hex FROM game_presence ORDER BY client');
  assert.deepEqual(
    presence().map((p) => [p.user_id, p.ip_hex]),
    [
      [acct(1).id, '0a000001'],
      [acct(2).id, '0a000002'],
      [null, 'c0000209'],
    ],
  );
  // Ban account 2: its connection is told and closed, everyone sees it removed.
  assert.equal(await s.session.evict({ userIds: [acct(2).id] }), 1);
  assert.equal(guest.last('error').code, 'banned');
  assert.ok(guest.closed);
  assert.equal(host.last('left').reason, 'removed');
  assert.equal(presence().length, 2);
  // Ban a range: the anonymous member from it goes too.
  assert.equal(await s.session.evict({ range: { v: 4, start: 'c0000200', end: 'c00002ff' } }), 1);
  assert.equal(third.last('error').code, 'ip_banned');
  assert.equal(await s.session.evict({ userIds: ['0'.repeat(32)] }), 0, 'nobody else');
  // In a running game an away seat of a banned account ends (no rejoin).
  const s2 = await makeSession({ maxPlayers: 2, DB });
  const h2 = s2.connect('h2', '10.0.0.5', auth(5));
  await s2.send(h2, hello(s2, { hostKey: s2.hostKey }));
  const g2 = s2.connect('g2', '10.0.0.6', auth(6));
  await s2.send(g2, hello(s2));
  const key = g2.last('welcome');
  await s2.send(g2, { t: 'ready', ready: true, mapHash: null });
  await s2.send(h2, { t: 'start' });
  await s2.drop(g2);
  assert.equal(await s2.session.evict({ userIds: [acct(6).id] }), 1);
  const back = s2.connect('back', '10.0.0.6', auth(6));
  await s2.send(back, hello(s2, { rejoin: { client: key.you, key: key.key } }));
  assert.equal(back.last('error').code, 'forbidden', 'the seat is gone for good');
});

test('content relay: signed in, active, flag or admin, relay switched on', async () => {
  const env = makeEnv({ email: false });
  const relay = (b, headers = {}) => b.get('/api/content/ra-quickinstall', { csrf: false, json: false, headers });
  assert.equal((await relay(new Browser(env))).status, 401);
  const b = await signup(env, 'Installer');
  const pending = await relay(b);
  assert.equal(pending.body.error.code, 'account_inactive');
  promote(env, b.user.id);
  const noFlag = await relay(b);
  assert.equal(noFlag.status, 403);
  assert.equal(noFlag.body.error.code, 'relay_forbidden');
  assert.match(noFlag.body.error.message, /not enabled for your account/);
  env.DB.sqlite.prepare('UPDATE users SET flags = 1 WHERE id = ?').run(b.user.id);
  // Past the account gate, the relay's own checks answer (no X-WebRA-Content header): the mirrors are never contacted.
  const passed = await relay(b);
  assert.equal(passed.status, 403);
  assert.equal(passed.body.error.code, 'forbidden');
  await setSite(env, { contentRelay: false });
  assert.equal((await relay(b)).body.error.code, 'relay_forbidden');
  await setSite(env, { contentRelay: true });
  env.DB.sqlite.prepare("UPDATE users SET flags = 0, role = 'admin' WHERE id = ?").run(b.user.id);
  await b.post('/api/auth/login', { login: 'installer', password: PASSWORD });
  assert.equal((await relay(b)).body.error.code, 'forbidden', 'admins pass the gate');
  assert.equal((await b.post('/api/content/ra-quickinstall', {})).status, 405);
});

test('music relay: the same account gate as the content relay, before any range or fetch', async () => {
  const env = makeEnv({ email: false });
  const music = (b, headers = {}) => b.get('/api/content/ra-scores', { csrf: false, json: false, headers: { Range: 'bytes=0-15', ...headers } });
  assert.equal((await music(new Browser(env))).status, 401);
  const b = await signup(env, 'Listener');
  assert.equal((await music(b)).body.error.code, 'account_inactive');
  promote(env, b.user.id);
  const noFlag = await music(b);
  assert.equal(noFlag.status, 403);
  assert.equal(noFlag.body.error.code, 'relay_forbidden');
  env.DB.sqlite.prepare('UPDATE users SET flags = 1 WHERE id = ?').run(b.user.id);
  // Past the account gate, the relay's own checks answer (no X-WebRA-Content header): the archive is never contacted.
  const passed = await music(b);
  assert.equal(passed.status, 403);
  assert.equal(passed.body.error.code, 'forbidden');
  const badRange = await music(b, { 'X-WebRA-Content': '1', Range: 'bytes=0-1,5-6' });
  assert.equal(badRange.status, 416);
  await setSite(env, { contentRelay: false });
  assert.equal((await music(b)).body.error.code, 'relay_forbidden', 'the site switch turns the music relay off too');
  await setSite(env, { contentRelay: true });
  env.DB.sqlite.prepare("UPDATE users SET status = 'pending_approval' WHERE id = ?").run(b.user.id);
  assert.equal((await music(b, { 'X-WebRA-Content': '1', Range: 'bytes=0-1,5-6' })).body.error.code, 'account_inactive', 'an inactive flagged account never reaches the relay');
  assert.equal((await b.post('/api/content/ra-scores', {})).status, 405);
});
