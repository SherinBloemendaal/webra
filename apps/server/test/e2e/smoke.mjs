// End-to-end smoke test against a running local Worker:
//   cd apps/server && npx wrangler d1 migrations apply webra --local
//   npx wrangler dev --port 8799 --local-upstream localhost:8799 --var WEBRA_DEV_ROUTES:1
//   node test/e2e/smoke.mjs http://localhost:8799
// (--local-upstream keeps the request host `localhost`; without it wrangler
// dev presents requests as the production host, and the test-only route,
// local cookies and the passkey rp id `localhost` are not available.)
// Exercises accounts (signup pending approval, an admin made through the
// test-only /api/dev/promote route that exists only under `wrangler dev`,
// approval through the admin API, sign-in), the HTTP API, a
// password-protected lobby with two signed-in humans, an AI and a spectator,
// start, the lockstep relay, hash checks, desync reporting, a spectator
// refused for sending orders, a player reconnecting with its rejoin key
// (order log, sync, resume), leaving, and the stall drop.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeClient, parseServerMessage, PROTOCOL_VERSION } from '@webra/protocol';

const BASE = process.argv[2] || 'http://localhost:8799';
const ORIGIN = new URL(BASE).origin;
const VERSION = '0.2.0+smoke';
const PASSWORD = 'smoke test passphrase';
/** Unique names per run (the local database keeps accounts between runs). */
const RUN = Date.now().toString(36).slice(-6);

/** Session cookies by account (plain HTTP locally: `webra_session`). */
const cookies = new Map();

async function api(path, init = {}, who = null) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-WebRA-CSRF': '1', ...init.headers };
  if (who && cookies.has(who)) headers.Cookie = cookies.get(who);
  const res = await fetch(BASE + path, { ...init, headers });
  if (who) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      if (/^(__Host-)?webra_session=/.test(pair)) {
        if (/Max-Age=0/.test(c)) cookies.delete(who);
        else cookies.set(who, pair);
      }
    }
  }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Sign up `name` (pending approval with the default site settings). */
async function signupAccount(name) {
  const r = await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({ username: name, password: PASSWORD, acceptPrivacy: true }) }, name);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.user;
}

class Client {
  /** `account`: whose session cookie the WebSocket upgrade carries (null: anonymous). */
  constructor(name, account = null) {
    this.name = name;
    this.account = account;
    this.inbox = [];
    this.waiters = [];
    this.closed = false;
  }

  open(id) {
    const url = `${BASE.replace(/^http/, 'ws')}/api/sessions/${id}/ws`;
    const headers = { Origin: ORIGIN };
    if (this.account) headers.Cookie = cookies.get(this.account);
    this.ws = new WebSocket(url, { headers });
    this.ws.addEventListener('message', (e) => {
      const r = parseServerMessage(e.data);
      assert.ok(r.ok, `${this.name} got an invalid server message: ${r.message}`);
      this.inbox.push(r.msg);
      this.flush();
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      if (process.env.DEBUG) console.log(this.name, "closed; inbox:", JSON.stringify(this.inbox).slice(0, 600));
      this.flush();
    });
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(msg) {
    this.ws.send(encodeClient(msg));
  }

  sendRaw(text) {
    this.ws.send(text);
  }

  flush() {
    for (const w of [...this.waiters]) {
      const i = this.inbox.findIndex(w.pred);
      if (i >= 0) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(this.inbox.splice(i, 1)[0]);
      } else if (this.closed) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.reject(new Error(`${this.name}: closed while waiting (${w.what})`));
      }
    }
  }

  /** Wait for (and consume) the first message matching `pred`. */
  next(pred, what = 'message', ms = 5000) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, what };
      this.waiters.push(w);
      this.flush();
      setTimeout(() => reject(new Error(`${this.name}: timeout waiting for ${what}`)), ms).unref();
    });
  }

  type(t, extra = () => true) {
    return this.next((m) => m.t === t && extra(m), t);
  }
}

async function main() {
  // ---- Accounts ------------------------------------------------------------------
  const v = await api('/api/version');
  assert.deepEqual(v.body, { version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version, protocol: PROTOCOL_VERSION });
  const site = await api('/api/site');
  assert.equal(site.status, 200);
  assert.equal(site.body.onlineRequiresAccount, true);
  assert.equal(site.body.registration.approvalRequired, true, 'closed beta by default');
  assert.equal(site.body.services.email, false, 'no email binding under wrangler dev');
  assert.equal(site.body.passkey.rpId, 'localhost');
  const ADMIN = `SmokeAdmin${RUN}`;
  const HOST = `Host${RUN}`;
  const GUEST = `Guest${RUN}`;
  const WATCHER = `Watcher${RUN}`;
  const accounts = {};
  for (const name of [ADMIN, HOST, GUEST, WATCHER]) {
    accounts[name] = await signupAccount(name);
    assert.equal(accounts[name].status, 'pending_approval');
  }
  // Pending accounts cannot play.
  const pendingCreate = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'Nope', public: false, maxPlayers: 2, version: VERSION }) }, HOST);
  assert.equal(pendingCreate.status, 403);
  assert.equal(pendingCreate.body.error.code, 'account_inactive');
  // The first admin through the test-only route (it exists only under wrangler dev with the variable).
  const promoted = await api('/api/dev/promote', { method: 'POST', body: JSON.stringify({ username: ADMIN, role: 'admin' }) });
  assert.equal(promoted.status, 200, `start wrangler dev with --var WEBRA_DEV_ROUTES:1 (${JSON.stringify(promoted.body)})`);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: ADMIN, password: PASSWORD }) }, ADMIN)).status, 200);
  const pending = await api(`/api/admin/users?status=pending_approval&q=${RUN}`, {}, ADMIN);
  assert.deepEqual(pending.body.users.map((u) => u.username).sort(), [GUEST, HOST, WATCHER].sort());
  for (const name of [HOST, GUEST, WATCHER]) {
    const r = await api(`/api/admin/users/${accounts[name].id}/approve`, { method: 'POST', body: '{}' }, ADMIN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.status, 'active');
  }
  // Sign in again (the signup sessions still work too) and check the verdict.
  for (const name of [HOST, GUEST, WATCHER]) {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ login: name.toLowerCase(), password: PASSWORD }) }, name);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.canPlayOnline, true);
  }
  const stats = await api('/api/admin/stats', {}, ADMIN);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.services.email, false);
  assert.equal((await api('/api/admin/stats', {}, HOST)).status, 403, 'plain users are not staff');

  // ---- HTTP -------------------------------------------------------------------
  assert.equal((await fetch(BASE + '/api/sessions', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await api('/api/nope')).status, 404);
  assert.equal((await api('/api/sessions', { method: 'POST', body: '{"name":""}' }, HOST)).status, 400);
  assert.equal((await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: 'Anon', public: false, maxPlayers: 2, version: VERSION }) })).status, 401, 'online play needs an account');
  assert.equal((await api('/api/maps/zzzz')).status, 404);
  // Original content relay (src/content.js): only its refusals here, which answer before any
  // upstream request; the mirrors are never contacted from tests (unit tests mock them).
  const content = (init, who = null) => fetch(`${BASE}/api/content/ra-quickinstall`, { ...init, headers: { ...init.headers, ...(who ? { Cookie: cookies.get(who) } : {}) } });
  const anonymous = await content({ headers: { Origin: ORIGIN, 'X-WebRA-Content': '1' } });
  assert.equal(anonymous.status, 401, 'the relay needs an account');
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  const noFlag = await content({ headers: { Origin: ORIGIN, 'X-WebRA-Content': '1' } }, HOST);
  assert.equal(noFlag.status, 403);
  assert.equal((await noFlag.json()).error.code, 'relay_forbidden');
  const noHeader = await content({ headers: { Origin: ORIGIN } }, ADMIN);
  assert.equal(noHeader.status, 403, 'admins pass the account gate; the relay checks its header');
  assert.equal((await content({ headers: { Origin: 'https://evil.example', 'X-WebRA-Content': '1' } }, ADMIN)).status, 403);
  assert.equal((await content({ headers: { 'X-WebRA-Content': '1', 'Sec-Fetch-Site': 'cross-site' } }, ADMIN)).status, 403);
  assert.equal((await content({ method: 'POST', headers: { Origin: ORIGIN, 'X-WebRA-Content': '1', 'X-WebRA-CSRF': '1' } }, ADMIN)).status, 405);

  const w = 48;
  const terrain = Buffer.alloc(w * w).toString('base64');
  const mapJson = { format: 1, name: `Smoke ${Date.now()}`, author: 'Tester', width: w, height: w, terrain, ore: terrain, spawns: [[2, 2], [40, 40], [2, 40]] };
  assert.equal((await api('/api/maps', { method: 'POST', body: JSON.stringify(mapJson) })).status, 401, 'uploads need an account');
  const up = await api('/api/maps', { method: 'POST', body: JSON.stringify(mapJson) }, HOST);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const again = await api('/api/maps', { method: 'POST', body: JSON.stringify({ ...mapJson, description: '' }) }, HOST);
  assert.equal(again.status, 200, 'same canonical map is deduplicated');
  assert.equal(again.body.id, up.body.id);
  const bad = await api('/api/maps', { method: 'POST', body: JSON.stringify({ ...mapJson, rules: { actors: { NOPE: { cost: 1 } } } }) }, HOST);
  assert.equal(bad.status, 422);
  const list = await api('/api/maps');
  assert.ok(list.body.some((m) => m.id === up.body.id && m.players === 3 && m.modded === false));
  const dl = await api(`/api/maps/${up.body.id}`);
  assert.equal(dl.body.name, mapJson.name);

  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'Smoke test', password: 'pw', public: true, maxPlayers: 3, version: VERSION }),
  }, HOST);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, hostKey } = created.body;

  // ---- Lobby --------------------------------------------------------------------
  // Anonymous connections are refused at hello (accounts are required).
  const anon = new Client('anon');
  await anon.open(id);
  anon.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Nobody', password: 'pw' });
  assert.equal((await anon.type('error')).code, 'account_required');

  const host = new Client('host', HOST);
  await host.open(id);
  host.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Fake name', hostKey });
  const welcome = await host.type('welcome');
  assert.equal(welcome.hostId, welcome.you);
  assert.equal(welcome.session.locked, true);
  assert.equal(welcome.name, HOST, 'signed in: the username, not the name sent');
  const firstLobby = await host.type('lobby');
  assert.equal(firstLobby.slots[0].account, true);

  const listed = await api('/api/sessions');
  const entry = listed.body.find((s) => s.id === id);
  assert.ok(entry, 'public lobby is listed');
  assert.equal(entry.host, HOST);
  assert.equal(entry.locked, true);

  const intruder = new Client('intruder', GUEST);
  await intruder.open(id);
  intruder.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Mallory', password: 'nope' });
  assert.equal((await intruder.type('error')).code, 'bad_password');

  const old = new Client('old', GUEST);
  await old.open(id);
  old.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: '0.1.0', name: 'Old', password: 'pw' });
  assert.equal((await old.type('error')).code, 'version_mismatch');

  const guest = new Client('guest', GUEST);
  await guest.open(id);
  guest.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, password: 'pw' });
  const gw = await guest.type('welcome');
  assert.equal(gw.hostId, welcome.you);
  assert.equal(gw.role, 'player');
  assert.match(gw.key, /^[A-Za-z0-9_-]{43}$/, 'every member gets a rejoin key');
  await host.type('lobby', (m) => m.slots[1].type === 'human');

  // A spectator place: the host allows one, a watcher takes it (password rules as for players).
  host.send({ t: 'spectators', max: 1 });
  await host.type('lobby', (m) => m.maxSpectators === 1);
  const watcher = new Client('watcher', WATCHER);
  await watcher.open(id);
  watcher.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Watcher', password: 'nope', spectate: true });
  assert.equal((await watcher.type('error')).code, 'bad_password');
  const watcher2 = new Client('watcher2', WATCHER);
  await watcher2.open(id);
  watcher2.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, password: 'pw', spectate: true });
  const ww = await watcher2.type('welcome');
  assert.equal(ww.role, 'spectator');
  await host.type('lobby', (m) => m.spectators.length === 1 && m.spectators[0].name === WATCHER);
  // The same account cannot take a second place (another tab).
  const twin = new Client('twin', GUEST);
  await twin.open(id);
  twin.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, password: 'pw', spectate: true });
  assert.equal((await twin.type('error')).code, 'bad_state');

  // Non-host cannot change options or start; garbage is answered with errors.
  guest.send({ t: 'start' });
  assert.equal((await guest.type('error')).code, 'not_host');
  guest.sendRaw('{"t":"slot","slot":0,"faction":"atlantis"}');
  assert.equal((await guest.type('error')).code, 'bad_message');
  // Oversized messages close the connection.
  const big = new Client('big', GUEST);
  await big.open(id);
  big.sendRaw('x'.repeat(9000));
  assert.equal((await big.type('error')).code, 'too_large');

  // Host picks the uploaded map (name from D1, not from the client), adds an AI.
  host.send({ t: 'map', map: { id: up.body.id, hash: up.body.hash, name: 'Fake name', modded: true } });
  const withMap = await host.type('lobby', (m) => m.map !== null);
  assert.equal(withMap.map.name, mapJson.name);
  assert.equal(withMap.map.modded, false);
  assert.equal(withMap.map.players, 3);
  host.send({ t: 'slot', slot: 2, type: 'ai', difficulty: 'easy' });
  await host.type('lobby', (m) => m.slots[2].type === 'ai');
  host.send({ t: 'chat', text: 'gl hf' });
  const chat = await guest.type('chat');
  assert.deepEqual([chat.name, chat.text], [HOST, 'gl hf']);

  host.send({ t: 'start' });
  assert.equal((await host.type('error')).code, 'not_ready');
  guest.send({ t: 'ready', ready: true, mapHash: null });
  assert.equal((await guest.type('error')).code, 'not_ready');
  guest.send({ t: 'ready', ready: true, mapHash: up.body.hash });
  await host.type('lobby', (m) => m.slots[1].ready === true);
  host.send({ t: 'start' });
  const [hs, gs, ws] = await Promise.all([host.type('start'), guest.type('start'), watcher2.type('start')]);
  assert.deepEqual(hs, gs);
  assert.deepEqual(hs, ws);
  assert.equal(hs.options.players.length, 3);
  assert.ok(hs.options.players.every((p) => !p.faction.startsWith('random')));
  assert.equal(hs.delay, 3);
  const seatOf = (c, you) => hs.players.find((p) => p.client === you).player;
  const hSeat = seatOf(host, welcome.you);
  const gSeat = seatOf(guest, gw.you);
  assert.equal((await api('/api/sessions')).body.some((s) => s.id === id), false, 'started games are not listed');
  assert.equal(hs.players.length, 3, 'the spectator does not play');

  // ---- Lockstep -------------------------------------------------------------------
  // Each client behaves like net.js: after frame T arrives it runs tick T and
  // sends its orders for T + delay.
  const forged = { o: 'stop', player: hSeat, ids: [1, 2] };
  const frames = [];
  for (let t = 0; t < 57; t++) {
    const hf = await host.type('frame', (f) => f.tick === t);
    const gf = await guest.type('frame', (f) => f.tick === t);
    assert.deepEqual(hf, gf);
    frames.push(hf);
    host.send({ t: 'orders', tick: t + 3, orders: [] });
    guest.send({ t: 'orders', tick: t + 3, orders: t + 3 === 5 ? [forged] : [] });
  }
  // The guest forged the host's seat inside its order; the server stamped its real seat.
  const f5 = frames.find((f) => f.tick === 5);
  assert.deepEqual(f5.orders, [[gSeat, [{ ...forged, player: gSeat }]]]);
  assert.ok(frames.filter((f) => f.tick !== 5).every((f) => f.orders.length === 0));
  await host.type('frame', (f) => f.tick === 57);
  await guest.type('frame', (f) => f.tick === 57);

  // Hash reports: matching at tick 25, a mismatch at tick 50 is reported to everyone.
  host.send({ t: 'hash', tick: 25, hash: 'aaaa' });
  guest.send({ t: 'hash', tick: 25, hash: 'aaaa' });
  host.send({ t: 'hash', tick: 50, hash: 'bbbb' });
  guest.send({ t: 'hash', tick: 50, hash: 'cccc' });
  assert.equal((await host.type('desync')).tick, 50);
  assert.equal((await guest.type('desync')).tick, 50);

  // ---- Spectator -------------------------------------------------------------------
  // The spectator got every frame; orders from it are refused and remove it.
  await watcher2.type('frame', (f) => f.tick === 59);
  watcher2.send({ t: 'orders', tick: 60, orders: [] });
  assert.equal((await watcher2.type('error')).code, 'forbidden');
  const wl = await host.type('left', (m) => m.player === null);
  assert.deepEqual([wl.name, wl.reason], [WATCHER, 'removed']);

  // ---- Reconnect ---------------------------------------------------------------------
  // The guest's connection drops: the host is told and plays on without waiting.
  guest.ws.close();
  const gone = await host.type('left', (m) => m.player === gSeat);
  assert.deepEqual([gone.reason, gone.name], ['disconnected', GUEST]);
  for (let t = 60; t < 70; t++) {
    host.send({ t: 'orders', tick: t, orders: t === 64 ? [{ o: 'stop', player: hSeat, ids: [9] }] : [] });
    await host.type('frame', (f) => f.tick === t);
  }
  // A wrong key is refused.
  const thief = new Client('thief', WATCHER);
  await thief.open(id);
  thief.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, rejoin: { client: gw.you, key: 'A'.repeat(43) } });
  assert.equal((await thief.type('error')).code, 'forbidden');
  // The right key from another account is refused too (keys are bound to their account).
  const keyThief = new Client('key-thief', WATCHER);
  await keyThief.open(id);
  keyThief.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, rejoin: { client: gw.you, key: gw.key } });
  assert.equal((await keyThief.type('error')).code, 'forbidden');
  // The guest comes back with its key: start, the order log, sync, resume.
  const back = new Client('guest-back', GUEST);
  await back.open(id);
  back.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, rejoin: { client: gw.you, key: gw.key } });
  const bw = await back.type('welcome');
  assert.deepEqual([bw.you, bw.role, 'key' in bw], [gw.you, 'player', false]);
  assert.deepEqual(await back.type('start'), hs);
  const logged = [];
  let sync;
  while (!sync) {
    const m = await back.next((x) => x.t === 'log' || x.t === 'sync', 'log or sync');
    if (m.t === 'log') logged.push(...m.frames);
    else sync = m;
  }
  assert.deepEqual(logged.map((f) => f[0]), [5, 64], 'the log holds the frames with orders');
  assert.equal(sync.tick, 70);
  assert.deepEqual(sync.check, { tick: 25, hash: 'aaaa' }, 'the last hash the players agreed on');
  back.send({ t: 'resume' });
  const [hb, bb] = await Promise.all([host.type('back'), back.type('back')]);
  assert.deepEqual([hb.player, hb.tick, bb.tick], [gSeat, 73, 73]);
  for (let t = 70; t < 76; t++) host.send({ t: 'orders', tick: t, orders: [] });
  for (let t = 73; t < 76; t++) back.send({ t: 'orders', tick: t, orders: [] });
  for (let t = 70; t < 76; t++) {
    const [a, b] = await Promise.all([host.type('frame', (f) => f.tick === t), back.type('frame', (f) => f.tick === t)]);
    assert.deepEqual(a, b);
  }

  // Guest leaves for good: host is told and frames continue for the host alone.
  back.send({ t: 'leave' });
  const left = await host.type('left', (m) => m.reason === 'left');
  assert.deepEqual([left.player, left.name], [gSeat, GUEST]);
  host.send({ t: 'orders', tick: 76, orders: [] });
  assert.equal((await host.type('frame', (f) => f.tick === 76)).orders.length, 0);

  // Large frames fill a chunk of the order log, which goes to Durable Object
  // storage compressed; a spectator joining now reads it back from there.
  const bigIds = Array.from({ length: 800 }, (_, i) => 1_000_000 + i);
  for (let t = 77; t < 89; t++) {
    host.send({ t: 'orders', tick: t, orders: [{ o: 'stop', player: hSeat, ids: bigIds }] });
    await host.type('frame', (f) => f.tick === t);
  }
  await new Promise((r) => setTimeout(r, 500));
  const lateWatcher = new Client('late-watcher', WATCHER);
  await lateWatcher.open(id);
  lateWatcher.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, password: 'pw', spectate: true });
  assert.equal((await lateWatcher.type('welcome')).role, 'spectator');
  await lateWatcher.type('start');
  const lateLog = [];
  let lateSync;
  while (!lateSync) {
    const m = await lateWatcher.next((x) => x.t === 'log' || x.t === 'sync', 'log or sync');
    if (m.t === 'log') lateLog.push(...m.frames);
    else lateSync = m;
  }
  assert.equal(lateSync.tick, 89);
  assert.deepEqual(lateLog.map((f) => f[0]), [5, 64, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88]);
  assert.deepEqual(lateLog.at(-1)[1], [[hSeat, [{ o: 'stop', player: hSeat, ids: bigIds }]]]);
  // The spectator confirms its catch-up (it stops counting against the catch-up limit).
  lateWatcher.send({ t: 'synced' });
  lateWatcher.send({ t: 'synced' });
  assert.equal((await lateWatcher.type('error')).code, 'bad_state', 'confirmed once');

  // Silence: the host stops sending and is dropped after about 10 s.
  const dropped = await host.next((m) => m.t === 'error' && m.code === 'dropped', 'drop', 15000);
  assert.equal(dropped.code, 'dropped');
  // The close frame needs a network round trip, much longer against a deployed Worker.
  for (let i = 0; i < 50 && !host.closed; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(host.closed, true);

  // The session is gone afterwards.
  const late = new Client('late');
  await late.open(id).catch(() => {});
  console.log('smoke test passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
