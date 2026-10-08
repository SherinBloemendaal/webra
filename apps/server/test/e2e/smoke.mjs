// End-to-end smoke test against a running local Worker:
//   cd apps/server && npx wrangler d1 migrations apply webra --local
//   npx wrangler dev --port 8799
//   node test/e2e/smoke.mjs http://127.0.0.1:8799
// Exercises the HTTP API, a password-protected lobby with two humans, an AI
// and a spectator, start, the lockstep relay, hash checks, desync reporting,
// a spectator refused for sending orders, a player reconnecting with its
// rejoin key (order log, sync, resume), leaving, and the stall drop.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeClient, parseServerMessage, PROTOCOL_VERSION } from '@webra/protocol';

const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const ORIGIN = new URL(BASE).origin;
const VERSION = '0.2.0+smoke';

async function api(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...init.headers } });
  const body = await res.json();
  return { status: res.status, body };
}

class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.waiters = [];
    this.closed = false;
  }

  open(id) {
    const url = `${BASE.replace(/^http/, 'ws')}/api/sessions/${id}/ws`;
    this.ws = new WebSocket(url, { headers: { Origin: ORIGIN } });
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
  // ---- HTTP -------------------------------------------------------------------
  const v = await api('/api/version');
  assert.deepEqual(v.body, { version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version, protocol: PROTOCOL_VERSION });
  assert.equal((await fetch(BASE + '/api/sessions', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await api('/api/nope')).status, 404);
  assert.equal((await api('/api/sessions', { method: 'POST', body: '{"name":""}' })).status, 400);
  assert.equal((await api('/api/maps/zzzz')).status, 404);

  const w = 48;
  const terrain = Buffer.alloc(w * w).toString('base64');
  const mapJson = { format: 1, name: `Smoke ${Date.now()}`, author: 'Tester', width: w, height: w, terrain, ore: terrain, spawns: [[2, 2], [40, 40], [2, 40]] };
  const up = await api('/api/maps', { method: 'POST', body: JSON.stringify(mapJson) });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const again = await api('/api/maps', { method: 'POST', body: JSON.stringify({ ...mapJson, description: '' }) });
  assert.equal(again.status, 200, 'same canonical map is deduplicated');
  assert.equal(again.body.id, up.body.id);
  const bad = await api('/api/maps', { method: 'POST', body: JSON.stringify({ ...mapJson, rules: { actors: { NOPE: { cost: 1 } } } }) });
  assert.equal(bad.status, 422);
  const list = await api('/api/maps');
  assert.ok(list.body.some((m) => m.id === up.body.id && m.players === 3 && m.modded === false));
  const dl = await api(`/api/maps/${up.body.id}`);
  assert.equal(dl.body.name, mapJson.name);

  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: 'Smoke test', password: 'pw', public: true, maxPlayers: 3, version: VERSION }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, hostKey } = created.body;

  // ---- Lobby --------------------------------------------------------------------
  const host = new Client('host');
  await host.open(id);
  host.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Host', hostKey });
  const welcome = await host.type('welcome');
  assert.equal(welcome.hostId, welcome.you);
  assert.equal(welcome.session.locked, true);
  await host.type('lobby');

  const listed = await api('/api/sessions');
  const entry = listed.body.find((s) => s.id === id);
  assert.ok(entry, 'public lobby is listed');
  assert.equal(entry.host, 'Host');
  assert.equal(entry.locked, true);

  const intruder = new Client('intruder');
  await intruder.open(id);
  intruder.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Mallory', password: 'nope' });
  assert.equal((await intruder.type('error')).code, 'bad_password');

  const old = new Client('old');
  await old.open(id);
  old.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: '0.1.0', name: 'Old', password: 'pw' });
  assert.equal((await old.type('error')).code, 'version_mismatch');

  const guest = new Client('guest');
  await guest.open(id);
  guest.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Guest', password: 'pw' });
  const gw = await guest.type('welcome');
  assert.equal(gw.hostId, welcome.you);
  assert.equal(gw.role, 'player');
  assert.match(gw.key, /^[A-Za-z0-9_-]{43}$/, 'every member gets a rejoin key');
  await host.type('lobby', (m) => m.slots[1].type === 'human');

  // A spectator place: the host allows one, a watcher takes it (password rules as for players).
  host.send({ t: 'spectators', max: 1 });
  await host.type('lobby', (m) => m.maxSpectators === 1);
  const watcher = new Client('watcher');
  await watcher.open(id);
  watcher.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Watcher', password: 'nope', spectate: true });
  assert.equal((await watcher.type('error')).code, 'bad_password');
  const watcher2 = new Client('watcher2');
  await watcher2.open(id);
  watcher2.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Watcher', password: 'pw', spectate: true });
  const ww = await watcher2.type('welcome');
  assert.equal(ww.role, 'spectator');
  await host.type('lobby', (m) => m.spectators.length === 1 && m.spectators[0].name === 'Watcher');

  // Non-host cannot change options or start; garbage is answered with errors.
  guest.send({ t: 'start' });
  assert.equal((await guest.type('error')).code, 'not_host');
  guest.sendRaw('{"t":"slot","slot":0,"faction":"atlantis"}');
  assert.equal((await guest.type('error')).code, 'bad_message');
  // Oversized messages close the connection.
  const big = new Client('big');
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
  assert.deepEqual([chat.name, chat.text], ['Host', 'gl hf']);

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
  assert.deepEqual([wl.name, wl.reason], ['Watcher', 'removed']);

  // ---- Reconnect ---------------------------------------------------------------------
  // The guest's connection drops: the host is told and plays on without waiting.
  guest.ws.close();
  const gone = await host.type('left', (m) => m.player === gSeat);
  assert.deepEqual([gone.reason, gone.name], ['disconnected', 'Guest']);
  for (let t = 60; t < 70; t++) {
    host.send({ t: 'orders', tick: t, orders: t === 64 ? [{ o: 'stop', player: hSeat, ids: [9] }] : [] });
    await host.type('frame', (f) => f.tick === t);
  }
  // A wrong key is refused.
  const thief = new Client('thief');
  await thief.open(id);
  thief.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Guest', rejoin: { client: gw.you, key: 'A'.repeat(43) } });
  assert.equal((await thief.type('error')).code, 'forbidden');
  // The guest comes back with its key: start, the order log, sync, resume.
  const back = new Client('guest-back');
  await back.open(id);
  back.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Guest', rejoin: { client: gw.you, key: gw.key } });
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
  assert.deepEqual([left.player, left.name], [gSeat, 'Guest']);
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
  const lateWatcher = new Client('late-watcher');
  await lateWatcher.open(id);
  lateWatcher.send({ t: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, name: 'Late', password: 'pw', spectate: true });
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
