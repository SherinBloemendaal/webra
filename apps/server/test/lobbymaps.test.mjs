// Maps shared in online lobbies (docs/security.md "Map sharing"): the room's
// map states and start rule, the host removing spectators, the session
// object's shareMap / memberMap RPCs with the member credential, the Worker
// routes (account gate, quotas, size limit, hash pinning), unlisted maps
// staying out of the public list, and their retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMBER_HEADER, parseServerMessage, PROTOCOL_VERSION, sha256Hex } from '@webra/protocol';
import { Browser, Clock, makeEnv, PASSWORD, promote, scheduled, setSite, signup } from './accounts-harness.mjs';
import { makeSession } from './fake-do.mjs';
import { Room, RoomError } from '../src/room.js';

const clock = new Clock();
test.after(() => clock.restore());

const throwsRoom = (fn, code) => assert.throws(fn, (err) => err instanceof RoomError && (code === undefined || err.code === code), code);

const W = 48;
const ZERO = Buffer.alloc(W * W).toString('base64');
/** A small valid map; `tag` makes its hash unique. */
const mapFile = (tag = 'one', extra = {}) => ({ format: 1, name: `Shared ${tag}`, author: 'Cartographer', width: W, height: W, terrain: ZERO, ore: ZERO, spawns: [[2, 2], [40, 40]], ...extra });

const MAP = { id: '0123456789abcdef', hash: 'a'.repeat(64), name: 'Twin', modded: false, players: 2, author: 'A', width: 48, height: 48, bytes: 100, shared: true };

// ---- Room ---------------------------------------------------------------------------------------

test('room: every member has a map state; ready installs; start needs everyone to have the map', () => {
  const room = Room.create({ maxPlayers: 3, seed: 2 });
  const host = room.join('Host', { host: true }).client;
  const guest = room.join('Guest').client;
  const eye = room.join('Eye', { spectate: true }).client;
  assert.equal(room.mapStateOf(guest), undefined, 'no map, no state');
  assert.equal('mapState' in room.lobbyView().slots[1], false);
  room.setMap(host, MAP);
  const view = () => room.lobbyView();
  assert.deepEqual([view().slots[0].mapState, view().slots[1].mapState, view().spectators[0].mapState], ['installed', 'missing', 'missing']);
  throwsRoom(() => room.setMapState(guest, 'b'.repeat(64), 'installed'), 'bad_state');
  room.setMapState(guest, MAP.hash, 'declined');
  assert.equal(view().slots[1].mapState, 'declined');
  assert.match(room.startProblem(host), /Guest does not have the map/);
  room.setReady(guest, true, MAP.hash);
  assert.equal(view().slots[1].mapState, 'installed', 'ready with the hash means installed');
  assert.match(room.startProblem(host), /Eye does not have the map/, 'spectators need it too');
  room.setMapState(eye, MAP.hash, 'installed');
  assert.equal(room.startProblem(host), null);
  // Declining again takes the player out of ready.
  room.setMapState(guest, MAP.hash, 'declined');
  assert.equal(room.slots[1].ready, false);
  // A new map starts everyone over (the host has it).
  room.setMap(host, { ...MAP, hash: 'c'.repeat(64) });
  assert.deepEqual([view().slots[0].mapState, view().slots[1].mapState, view().spectators[0].mapState], ['installed', 'missing', 'missing']);
  room.setMap(host, null);
  assert.equal(room.startProblem(host), 'Not everyone is ready.');
  throwsRoom(() => room.setMapState(guest, MAP.hash, 'installed'), 'bad_state');
  // Every lobby message stays valid.
  room.setMap(host, MAP);
  const raw = JSON.stringify({ t: 'lobby', ...room.lobbyView() });
  assert.ok(parseServerMessage(raw).ok, parseServerMessage(raw).message);
});

test('room: the host removes spectators, nobody else does', () => {
  const room = Room.create({ maxPlayers: 2 });
  const host = room.join('Host', { host: true }).client;
  const guest = room.join('Guest').client;
  const eye = room.join('Eye', { spectate: true }).client;
  throwsRoom(() => room.kickSpectator(guest, eye), 'not_host');
  throwsRoom(() => room.kickSpectator(host, guest), 'not_found');
  throwsRoom(() => room.kickSpectator(host, host));
  room.setKey(eye, 'f'.repeat(64));
  assert.equal(room.kickSpectator(host, eye), eye);
  assert.equal(room.isSpectator(eye), false);
  assert.equal(Object.hasOwn(room.keys, eye), false, 'its rejoin key is gone');
});

// ---- Session object ----------------------------------------------------------------------------------

const hello = (s, name, extra = {}) => ({ t: 'hello', protocol: PROTOCOL_VERSION, version: s.version, name, ...extra });

/** A lobby with a host, a guest and a spectator, over a real (SQLite) D1. */
async function lobbyWithDb(env) {
  const s = await makeSession({ DB: env.DB, maxPlayers: 3 });
  const host = s.connect('host');
  await s.send(host, hello(s, 'Host', { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  const guest = s.connect('guest');
  await s.send(guest, hello(s, 'Guest'));
  const gw = guest.take('welcome')[0];
  const eye = s.connect('eye');
  await s.send(eye, hello(s, 'Eye', { spectate: true }));
  const ew = eye.take('welcome')[0];
  return { s, host, guest, eye, hw, gw, ew };
}

const member = (w) => ({ client: w.you, key: w.key });

async function prepared(text) {
  const { prepareMap } = await import('../src/maps.js');
  return prepareMap(typeof text === 'string' ? text : JSON.stringify(text));
}

test('session: the host shares a map; members download it by hash; strangers and old maps are refused', async () => {
  const env = makeEnv({ email: false });
  const { s, host, guest, eye, hw, gw, ew } = await lobbyWithDb(env);
  const p = await prepared(mapFile('session'));
  // Only the host shares, with its own key.
  assert.deepEqual(await s.session.shareMap({ member: member(gw), prepared: p, ip: '1.1.1.1' }), { ok: false, status: 403, code: 'not_host', message: 'Only the host can change the map.' });
  const wrong = await s.session.shareMap({ member: { client: hw.you, key: gw.key }, prepared: p, ip: '1.1.1.2' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.code, 'forbidden');
  const shared = await s.session.shareMap({ member: member(hw), prepared: p, ip: '1.1.1.3' });
  assert.equal(shared.ok, true);
  assert.equal(shared.hash, p.hash);
  // Stored unlisted, with the uploader (none here: anonymous members).
  const [row] = env.DB.rows('SELECT listed, used_at, hash FROM maps');
  assert.deepEqual([row.listed, row.hash], [0, p.hash]);
  assert.ok(row.used_at > 0);
  // The lobby announces it with its details, for everyone, with the map states.
  const lobby = guest.last('lobby');
  assert.deepEqual(lobby.map, { id: shared.id, hash: p.hash, name: 'Shared session', modded: false, players: 2, author: 'Cartographer', width: W, height: W, bytes: p.canonical.length, shared: true });
  assert.deepEqual(lobby.slots.filter((x) => x.type === 'human').map((x) => x.mapState), ['installed', 'missing']);
  assert.equal(lobby.spectators[0].mapState, 'missing');
  for (const ws of [host, guest, eye]) for (const m of ws.inbox) assert.ok(parseServerMessage(JSON.stringify(m)).ok, `${ws.name}: ${m.t}`);
  // Members (players and spectators) download it, pinned by hash.
  for (const w of [gw, ew, hw]) {
    const r = await s.session.memberMap({ member: member(w), hash: p.hash, ip: '2.2.2.2' });
    assert.deepEqual(r, { ok: true, text: p.canonical });
  }
  assert.equal((await s.session.memberMap({ member: member(gw), hash: 'b'.repeat(64), ip: '2.2.2.2' })).status, 409, 'another hash');
  assert.equal((await s.session.memberMap({ member: { client: gw.you, key: 'A'.repeat(43) }, hash: p.hash, ip: '3.3.3.3' })).status, 403, 'a wrong key');
  assert.equal((await s.session.memberMap({ member: { client: 999, key: gw.key }, hash: p.hash, ip: '3.3.3.4' })).status, 403, 'an unknown client');
  // Five wrong keys from one address lock it out for a while.
  for (let i = 0; i < 5; i++) await s.session.memberMap({ member: { client: gw.you, key: 'B'.repeat(43) }, hash: p.hash, ip: '4.4.4.4' });
  assert.equal((await s.session.memberMap({ member: member(gw), hash: p.hash, ip: '4.4.4.4' })).status, 429);
  // A member who left loses access (its key is gone).
  await s.send(eye, { t: 'leave' });
  assert.equal((await s.session.memberMap({ member: member(ew), hash: p.hash, ip: '2.2.2.2' })).status, 403);
  // Members report what they did; the host sees it.
  await s.send(guest, { t: 'mapstate', hash: p.hash, state: 'declined' });
  assert.equal(host.last('lobby').slots[1].mapState, 'declined');
  await s.send(guest, { t: 'mapstate', hash: 'e'.repeat(64), state: 'installed' });
  assert.equal(guest.last('error').code, 'bad_state', 'a stale hash is refused');
  await s.send(guest, { t: 'ready', ready: true, mapHash: p.hash });
  assert.equal(host.last('lobby').slots[1].mapState, 'installed');
  // A generated map again: nothing to download.
  await s.send(host, { t: 'map', map: null });
  assert.equal((await s.session.memberMap({ member: member(gw), hash: p.hash, ip: '2.2.2.2' })).status, 404);
});

test('session: unlisted maps cannot be picked by id; the game start waits for every member to have the map', async () => {
  const env = makeEnv({ email: false });
  const { s, host, guest, eye, hw, gw, ew } = await lobbyWithDb(env);
  const p = await prepared(mapFile('start'));
  const shared = await s.session.shareMap({ member: member(hw), prepared: p, ip: '1.1.1.1' });
  // Picking it by id (as a community map) is refused: a stranger who learned the id gets nothing.
  await s.send(host, { t: 'map', map: { id: shared.id, hash: p.hash, name: 'x', modded: false } });
  assert.equal(host.last('error').code, 'not_found');
  await s.send(guest, { t: 'ready', ready: true, mapHash: p.hash });
  await s.send(host, { t: 'start' });
  assert.match(host.last('error').message, /Eye does not have the map/);
  await s.send(eye, { t: 'mapstate', hash: p.hash, state: 'installed' });
  await s.send(host, { t: 'start' });
  const start = host.last('start');
  assert.ok(start, 'started');
  assert.deepEqual(start.map, guest.last('start').map);
  assert.equal(start.map.shared, true);
  // In the game, members (also the spectator) still get the game's map, e.g. after a reload.
  assert.equal((await s.session.memberMap({ member: member(ew), hash: p.hash, ip: '2.2.2.2' })).ok, true);
  assert.equal((await s.session.memberMap({ member: member(gw), hash: p.hash, ip: '2.2.2.2' })).ok, true);
  // Sharing in a running game is refused.
  assert.equal((await s.session.shareMap({ member: member(hw), prepared: p, ip: '1.1.1.1' })).status, 409);
});

test('session: sharing a map is refused while the lobby resumes a save (no stray rows, no 500)', async () => {
  const env = makeEnv({ email: false });
  const { s, hw } = await lobbyWithDb(env);
  s.session.room.resume = { id: '0123456789abcdef', title: 'x', createdAt: 0, ticks: 26, hash: 'ab', options: { players: [] }, seats: [], chunks: 0 };
  const r = await s.session.shareMap({ member: member(hw), prepared: await prepared(mapFile('resume')), ip: '1.1.1.1' });
  assert.deepEqual([r.status, r.code], [409, 'forbidden']);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM maps')[0].n, 0, 'nothing stored');
});

test('session: the host removes a spectator who declined the map', async () => {
  const env = makeEnv({ email: false });
  const { s, host, guest, eye, hw, ew } = await lobbyWithDb(env);
  const p = await prepared(mapFile('kick'));
  await s.session.shareMap({ member: member(hw), prepared: p, ip: '1.1.1.1' });
  await s.send(eye, { t: 'mapstate', hash: p.hash, state: 'declined' });
  await s.send(guest, { t: 'kick', client: ew.you });
  assert.equal(guest.last('error').code, 'not_host');
  await s.send(host, { t: 'kick', client: ew.you });
  assert.equal(eye.last('error').code, 'kicked');
  assert.ok(eye.closed);
  assert.deepEqual(host.last('lobby').spectators, []);
  assert.equal(host.last('left').reason, 'kicked');
});

// ---- Worker routes -------------------------------------------------------------------------------------

/** env.SESSION serving one real session object (its RPCs run for real). */
function wireSession(env, session) {
  const id = 'd'.repeat(64);
  env.SESSION = {
    idFromString: (v) => {
      if (!/^[0-9a-f]{64}$/.test(v)) throw new Error('bad id');
      return { toString: () => v };
    },
    get: (doId) => (doId.toString() === id ? session : { shareMap: async () => ({ ok: false, status: 404, code: 'not_found', message: 'No such session.' }), memberMap: async () => ({ ok: false, status: 404, code: 'not_found', message: 'No such session.' }) }),
  };
  return id;
}

test('routes: share and download through the session, gated by account, member key, quotas and size', async () => {
  const env = makeEnv({ email: false });
  const hostB = await signup(env, 'Map Host');
  promote(env, hostB.user.id);
  const guestB = await signup(env, 'Map Guest');
  promote(env, guestB.user.id);
  const s = await makeSession({ DB: env.DB, maxPlayers: 2 });
  const account = (b) => ({ account: { id: b.user.id, username: b.user.username }, refuse: null });
  const host = s.connect('host', '10.0.0.1', account(hostB));
  await s.send(host, hello(s, undefined, { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  const guest = s.connect('guest', '10.0.0.2', account(guestB));
  await s.send(guest, hello(s, undefined));
  const gw = guest.take('welcome')[0];
  const sid = wireSession(env, s.session);
  const cred = (w) => ({ [MEMBER_HEADER]: `${w.you}.${w.key}` });
  const text = JSON.stringify(mapFile('route'));
  const hash = await sha256Hex((await prepared(text)).canonical);

  // Sharing: the host's key and account, JSON, CSRF.
  const share = (b, w, body = text, headers = {}) => b.req('POST', `/api/sessions/${sid}/map`, body, { headers: { ...cred(w), ...headers } });
  assert.equal((await share(new Browser(env), hw)).status, 401, 'anonymous with accounts required');
  assert.equal((await share(guestB, gw)).body.error.code, 'not_host');
  assert.equal((await share(guestB, hw)).status, 403, "another account cannot use the host's key");
  assert.equal((await hostB.req('POST', `/api/sessions/${sid}/map`, text)).status, 403, 'no member header');
  assert.equal((await share(hostB, hw, text, { [MEMBER_HEADER]: `${hw.you}.short` })).status, 403);
  assert.equal((await share(hostB, hw, text, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await share(hostB, hw, text, { 'X-WebRA-CSRF': null })).status, 403, 'CSRF header');
  assert.equal((await share(hostB, hw, JSON.stringify(mapFile('bad', { spawns: [[2, 2]] })))).status, 422, 'validated like any upload');
  assert.equal((await share(hostB, hw, 'x'.repeat(1024 * 1024 + 1))).status, 413);
  const ok = await share(hostB, hw);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.hash, hash);
  assert.equal(env.DB.rows('SELECT uploader_id FROM maps WHERE hash = ?', hash)[0].uploader_id, hostB.user.id);
  assert.equal((await share(hostB, hw)).status, 200, 'the same map again');

  // Not public: not listed, not served by id.
  const list = await new Browser(env).get('/api/maps', { csrf: false });
  assert.equal(list.body.some((m) => m.hash === hash), false);
  assert.equal((await new Browser(env).get(`/api/maps/${ok.body.id}`, { csrf: false })).status, 404);

  // Downloading: members only, pinned by hash, never cached.
  const get = (b, w, h = hash, headers = {}) => b.get(`/api/sessions/${sid}/map?hash=${h}`, { csrf: false, headers: { ...cred(w), ...headers } });
  const dl = await get(guestB, gw);
  assert.equal(dl.status, 200);
  assert.equal(await sha256Hex(JSON.stringify(dl.body)), hash);
  assert.equal(dl.res.headers.get('cache-control'), 'private, no-store');
  assert.equal((await get(new Browser(env), gw)).status, 401, 'needs an account');
  assert.equal((await get(hostB, gw)).status, 403, "the guest's key with the host's account");
  assert.equal((await get(guestB, gw, 'F'.repeat(64))).status, 400);
  assert.equal((await get(guestB, gw, 'f'.repeat(64))).status, 409);
  assert.equal((await guestB.get(`/api/sessions/${sid}/map?hash=${hash}`, { csrf: false })).status, 403, 'no member header');
  assert.equal((await get(guestB, gw, hash, { Origin: 'https://evil.example' })).status, 403, 'cross-origin');
  assert.equal((await get(guestB, gw)).status, 200);
  assert.equal((await guestB.get(`/api/sessions/${'0'.repeat(64)}/map?hash=${hash}`, { csrf: false, headers: cred(gw) })).status, 404);
  assert.equal((await guestB.req('PUT', `/api/sessions/${sid}/map`, text, { headers: cred(gw) })).status, 405);

  // Quotas: map uploads share the upload quota; downloads have their own per network.
  const { SESSION_MAP_GET_LIMIT, UPLOAD_LIMIT } = await import('../src/maps.js');
  for (let i = 0; i < UPLOAD_LIMIT; i++) await share(hostB, hw);
  assert.equal((await share(hostB, hw)).status, 429);
  for (let i = 0; i < SESSION_MAP_GET_LIMIT; i++) await get(guestB, gw);
  assert.equal((await get(guestB, gw)).status, 429);
});

test('routes: publishing a shared map lists it; anonymous sharing works when the site allows it', async () => {
  const env = makeEnv({ email: false });
  const s = await makeSession({ DB: env.DB, maxPlayers: 2 });
  await setSite(env, { onlineRequiresAccount: false });
  const host = s.connect('host', '10.0.0.1');
  await s.send(host, hello(s, 'Anon', { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  const sid = wireSession(env, s.session);
  const text = JSON.stringify(mapFile('publish'));
  const anon = new Browser(env);
  const r = await anon.req('POST', `/api/sessions/${sid}/map`, text, { headers: { [MEMBER_HEADER]: `${hw.you}.${hw.key}` } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(env.DB.rows('SELECT uploader_id, listed FROM maps')[0].listed, 0);
  const author = await signup(env, 'Publisher');
  promote(env, author.user.id);
  const pub = await author.post('/api/maps', JSON.parse(text));
  assert.equal(pub.status, 200, 'the same content already exists');
  assert.equal(pub.body.id, r.body.id);
  assert.deepEqual(env.DB.rows('SELECT listed, uploader_id FROM maps')[0], { listed: 1, uploader_id: author.user.id });
  assert.ok((await anon.get('/api/maps', { csrf: false })).body.some((m) => m.id === r.body.id), 'now in the community list');
  // A listed map stays listed when it is shared again.
  await anon.req('POST', `/api/sessions/${sid}/map`, text, { headers: { [MEMBER_HEADER]: `${hw.you}.${hw.key}` } });
  assert.equal(env.DB.rows('SELECT listed FROM maps')[0].listed, 1);
});

test('the public session list names a shared map without its id, hash or author', async () => {
  const { directoryMap, listSessions, upsertSession } = await import('../src/directory.js');
  assert.deepEqual(directoryMap(MAP), { name: 'Twin', modded: false, shared: true });
  assert.deepEqual(directoryMap({ ...MAP, shared: false }), { id: MAP.id, name: 'Twin', hash: MAP.hash, modded: false });
  const env = makeEnv({ email: false });
  await upsertSession(env.DB, { id: 'e'.repeat(64), name: 'Lobby', host: 'H', public: true, locked: false, players: 1, maxPlayers: 2, map: MAP, version: '1', state: 'lobby' }, Date.now());
  const [row] = await listSessions(env.DB, Date.now());
  assert.deepEqual(row.map, { name: 'Twin', modded: false, shared: true });
});

test('retention: unlisted maps unused for 30 days go; purged accounts take their shared maps along', async () => {
  const env = makeEnv({ email: false });
  const { storeMap, UNLISTED_RETENTION_MS } = await import('../src/maps.js');
  const user = await signup(env, 'Sharer');
  const now = Date.now();
  const old = await storeMap(env.DB, await prepared(mapFile('old')), { listed: false, now: now - UNLISTED_RETENTION_MS - 1000 });
  const fresh = await storeMap(env.DB, await prepared(mapFile('fresh')), { listed: false, uploaderId: user.user.id, now });
  const pub = await storeMap(env.DB, await prepared(mapFile('public')), { listed: true, uploaderId: user.user.id, now: now - UNLISTED_RETENTION_MS - 1000 });
  await scheduled(env, now);
  const ids = () => env.DB.rows('SELECT id FROM maps ORDER BY id').map((r) => r.id);
  assert.deepEqual(ids(), [fresh.id, pub.id].sort(), 'the old shared map is gone, the public one stays');
  // The data export lists both kinds.
  await user.post('/api/auth/reauth', { password: PASSWORD });
  const exp = await user.get('/api/account/export');
  assert.equal(exp.status, 200);
  assert.deepEqual(exp.body.maps.map((m) => m.published).sort(), [false, true]);
  // Purging the account deletes its shared maps no session used for a day; published maps stay without the uploader.
  const { purgeStatements, SHARED_MAP_IN_USE_MS } = await import('../src/accounts/routes-admin.js');
  await env.DB.batch(purgeStatements(env.DB, user.user.id, now + SHARED_MAP_IN_USE_MS + 1));
  assert.deepEqual(ids(), [pub.id]);
  assert.equal(env.DB.rows('SELECT uploader_id FROM maps')[0].uploader_id, null);
});

test('a shared map is stored once, under its first signed-in sharer; purging that account keeps it while a session uses it', async () => {
  const env = makeEnv({ email: false });
  const { storeMap, UNLISTED_RETENTION_MS } = await import('../src/maps.js');
  const { purgeStatements } = await import('../src/accounts/routes-admin.js');
  const first = await signup(env, 'First Sharer');
  const p = await prepared(mapFile('both'));
  const now = Date.now();
  // An anonymous host shares it, then a signed-in one shares the same content: one row, owned by the account.
  await storeMap(env.DB, p, { listed: false, uploaderId: null, now: now - 1000 });
  await storeMap(env.DB, p, { listed: false, uploaderId: first.user.id, now });
  assert.deepEqual(env.DB.rows('SELECT uploader_id, listed FROM maps'), [{ uploader_id: first.user.id, listed: 0 }]);
  // The anonymous host's lobby keeps using it; purging the account does not take it away.
  await env.DB.batch(purgeStatements(env.DB, first.user.id, now + 60_000));
  assert.deepEqual(env.DB.rows('SELECT uploader_id FROM maps'), [{ uploader_id: null }], 'kept, without the uploader');
  // Once nobody uses it, the 30 day retention removes it.
  await scheduled(env, now + UNLISTED_RETENTION_MS + 1);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM maps')[0].n, 0);
});
