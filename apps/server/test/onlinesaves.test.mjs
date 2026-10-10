// Online saves (docs/contracts.md section 4, "Online saves"): players agree
// to save, the server records the save point once every state hash at it
// matches, and a host resumes the save in a new session whose players come
// back by account; every client then catches up and the relay continues
// after the save point. Also the record's retention, purge and export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeReplay,
  framesDigest,
  MEMBER_HEADER,
  ONLINE_SAVE_RETENTION_MS,
  parseServerMessage,
  PROTOCOL_VERSION,
  REPLAY_FORMAT,
  REPLAY_VERSION,
} from '@webra/protocol';
import { Clock, makeEnv, PASSWORD, promote, scheduled, signup } from './accounts-harness.mjs';
import { makeSession } from './fake-do.mjs';
import { loadSaveRecord } from '../src/onlinesaves.js';

const clock = new Clock();
test.after(() => clock.restore());

const hello = (s, extra = {}) => ({ t: 'hello', protocol: PROTOCOL_VERSION, version: s.version, ...extra });
const authOf = (b) => ({ account: { id: b.user.id, username: b.user.username }, refuse: null });

function valid(ws) {
  for (const m of ws.inbox) {
    const r = parseServerMessage(JSON.stringify(m));
    assert.ok(r.ok, `${ws.name} got an invalid ${m.t}: ${r.message}`);
  }
}

/** Two signed-in players in a started game over a real D1. */
async function game(env, accounts) {
  const s = await makeSession({ DB: env.DB, maxPlayers: 3 });
  const host = s.connect('host', '10.0.0.1', authOf(accounts.host));
  await s.send(host, hello(s, { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  const guest = s.connect('guest', '10.0.0.2', authOf(accounts.guest));
  await s.send(guest, hello(s));
  const gw = guest.take('welcome')[0];
  await s.send(host, { t: 'slot', slot: 2, type: 'ai', difficulty: 'easy' });
  await s.send(guest, { t: 'ready', ready: true, mapHash: null });
  await s.send(host, { t: 'start' });
  const start = host.last('start');
  assert.ok(start, 'started');
  const seat = (w) => start.players.find((p) => p.client === w.you).player;
  return { s, host, guest, hw, gw, start, H: { ws: host, seat: seat(hw) }, G: { ws: guest, seat: seat(gw) } };
}

/** Each client runs ticks like net.js: after frame t, orders for t + 3 (some stop orders along the way). */
async function play(s, clients, from, to) {
  for (let t = from; t < to; t++) {
    for (const c of clients) {
      const orders = (t + 3) % 7 === 0 ? [{ o: 'stop', player: c.seat, ids: [t + 3] }] : [];
      await s.send(c.ws, { t: 'orders', tick: t + 3, orders });
    }
  }
}

async function accountsFor(env) {
  const out = {};
  for (const [k, name] of [['host', 'Saver Host'], ['guest', 'Saver Guest'], ['other', 'Outsider']]) {
    out[k] = await signup(env, name);
    promote(env, out[k].user.id);
  }
  return out;
}

/** Play to the agreed save point, report hashes and return the `saved` message. */
async function saveGame(ctx, hashes = { host: 'abcd', guest: 'abcd' }) {
  const { s, host, guest, H, G } = ctx;
  await play(s, [H, G], 0, 10);
  await s.send(guest, { t: 'save', accept: true });
  const open = host.last('save');
  assert.deepEqual([open.state, open.by, open.waiting], ['open', ctx.gw.you, [ctx.hw.you]]);
  await s.send(host, { t: 'save', accept: true });
  const agreed = guest.last('save');
  assert.equal(agreed.state, 'agreed');
  assert.equal(agreed.tick % 25, 0);
  assert.ok(agreed.tick >= 13, 'a tick no player ran yet');
  await play(s, [H, G], 10, agreed.tick + 2);
  await s.send(host, { t: 'hash', tick: 25, hash: hashes.host });
  await s.send(guest, { t: 'hash', tick: 25, hash: hashes.guest });
  for (let t = 50; t <= agreed.tick; t += 25) {
    await s.send(host, { t: 'hash', tick: t, hash: hashes.host });
    await s.send(guest, { t: 'hash', tick: t, hash: hashes.guest });
  }
  return { agreed, result: host.last('save') };
}

test('players agree to save; the server records the save point once every hash matches', async () => {
  const env = makeEnv({ email: false });
  const accounts = await accountsFor(env);
  const ctx = await game(env, accounts);
  const { agreed, result } = await saveGame(ctx);
  assert.equal(result.state, 'saved');
  assert.deepEqual([result.ticks, result.hash], [agreed.tick + 1, 'abcd']);
  assert.deepEqual(ctx.guest.last('save'), result, 'both players are told');
  const rec = await loadSaveRecord(env.DB, result.id);
  assert.equal(rec.ticks, agreed.tick + 1);
  assert.equal(rec.stateHash, 'abcd');
  assert.equal(rec.engine, ctx.s.version);
  assert.equal(rec.mapHash, null);
  assert.deepEqual(rec.members.map((m) => m.userId).sort(), [accounts.host.user.id, accounts.guest.user.id].sort());
  // The record's digest is the digest of the orders before the save point.
  const frames = (await ctx.s.session.log.read()).filter(([t]) => t <= agreed.tick);
  assert.ok(frames.length > 0);
  assert.equal(rec.framesDigest, await framesDigest(frames));
  // Nothing of the orders, options or map is stored on the server.
  assert.deepEqual(Object.keys(env.DB.rows('SELECT * FROM online_saves')[0]).sort(), ['created_at', 'engine', 'frames_digest', 'id', 'map_hash', 'options_digest', 'state_hash', 'ticks', 'title']);
  valid(ctx.host);
  valid(ctx.guest);
});

test('saving: different hashes, a decline, anonymous players and spectators all refuse it', async () => {
  const env = makeEnv({ email: false });
  const accounts = await accountsFor(env);
  {
    const ctx = await game(env, accounts);
    const { result } = await saveGame(ctx, { host: 'abcd', guest: 'ffff' });
    assert.deepEqual([result.state, result.reason], ['cancelled', 'desync']);
    assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM online_saves')[0].n, 0);
  }
  {
    const ctx = await game(env, accounts);
    await ctx.s.send(ctx.host, { t: 'save', accept: true });
    await ctx.s.send(ctx.guest, { t: 'save', accept: false });
    assert.deepEqual([ctx.host.last('save').state, ctx.host.last('save').reason], ['cancelled', 'declined']);
    await ctx.s.send(ctx.host, { t: 'save', accept: true });
    assert.equal(ctx.host.last('error').code, 'rate_limited');
  }
  {
    // Anonymous players cannot be matched when resuming: no online save.
    const s = await makeSession({ DB: env.DB, maxPlayers: 2 });
    const a = s.connect('a');
    await s.send(a, hello(s, { name: 'Anon', hostKey: s.hostKey }));
    const b = s.connect('b');
    await s.send(b, hello(s, { name: 'Anon two' }));
    await s.send(b, { t: 'ready', ready: true, mapHash: null });
    await s.send(a, { t: 'start' });
    await s.send(a, { t: 'save', accept: true });
    assert.match(a.last('error').message, /signed in/);
  }
});

/** The save file a player's client keeps (js/replay.js Recorder.encodeOnlineSave). */
async function saveFile(ctx, saved, agreed, { player = 0, tamper = false } = {}) {
  const frames = structuredClone((await ctx.s.session.log.read()).filter(([t]) => t <= agreed.tick));
  if (tamper) frames[0][1][0][1].push({ o: 'stop', player: frames[0][1][0][0], ids: [999] });
  return encodeReplay({
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    kind: 'save',
    mode: 'online',
    engine: ctx.s.version,
    createdAt: Date.now(),
    title: 'Test',
    options: ctx.start.options,
    map: null,
    mapHash: null,
    player,
    ticks: saved.ticks,
    frames,
    hashes: [[saved.ticks, saved.hash]],
    online: { id: saved.id },
  });
}

/** env.SESSION serving one real session object. */
function wire(env, session) {
  const id = 'e'.repeat(64);
  env.SESSION = {
    idFromString: (v) => ({ toString: () => v }),
    get: () => session,
  };
  return id;
}

test('resuming: the file is checked against the record, the players come back by account, and the game goes on after the save point', async () => {
  const env = makeEnv({ email: false });
  const accounts = await accountsFor(env);
  const ctx = await game(env, accounts);
  const { agreed, result: saved } = await saveGame(ctx);
  const text = await saveFile(ctx, saved, agreed);

  // A new session; the host connects and loads the file.
  const s = await makeSession({ DB: env.DB, maxPlayers: 3 });
  const sid = wire(env, s.session);
  const host = s.connect('host', '10.0.0.1', authOf(accounts.host));
  await s.send(host, hello(s, { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  const resume = (b, w, body = text) => b.req('POST', `/api/sessions/${sid}/resume`, body, { headers: { [MEMBER_HEADER]: `${w.you}.${w.key}` } });
  // Checked strictly before anything changes.
  assert.equal((await resume(accounts.host, hw, await saveFile(ctx, saved, agreed, { tamper: true }))).status, 409, 'tampered orders');
  assert.equal((await resume(accounts.host, hw, text.replace(saved.id, '0'.repeat(16)))).status, 404, 'unknown record');
  assert.equal((await resume(accounts.other, hw, text)).status, 403, "another account cannot use the host's key");
  assert.equal((await resume(accounts.host, hw, '{"format":"x"}')).status, 422);
  const ok = await resume(accounts.host, hw);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const lobby = host.last('lobby');
  assert.equal(lobby.resume.id, saved.id);
  assert.equal(lobby.resume.ticks, saved.ticks);
  assert.deepEqual(lobby.resume.waiting, ['Saver Guest']);
  assert.deepEqual(lobby.slots.map((x) => x.type), ['human', 'open', 'ai']);
  assert.equal(lobby.slots[0].faction, ctx.start.options.players[0].faction, 'the saved factions');
  // The saved settings cannot change.
  await s.send(host, { t: 'options', options: lobby.options });
  assert.equal(host.last('error').code, 'forbidden');
  await s.send(host, { t: 'start' });
  assert.match(host.last('error').message, /Waiting for Saver Guest/);
  // Somebody else can watch, not play.
  const other = s.connect('other', '10.0.0.3', authOf(accounts.other));
  await s.send(other, hello(s));
  assert.equal(other.last('error').code, 'forbidden');
  // The guest comes back by its account and takes its seat.
  const guest = s.connect('guest', '10.0.0.2', authOf(accounts.guest));
  await s.send(guest, hello(s));
  const gw = guest.take('welcome')[0];
  assert.equal(guest.last('lobby').slots[1].client, gw.you);
  assert.deepEqual(guest.last('lobby').resume.waiting, []);
  await s.send(guest, { t: 'ready', ready: true, mapHash: null });
  await s.send(host, { t: 'start' });

  // Everyone gets the saved start, the orders and the saved hash to check.
  const st = guest.last('start');
  assert.deepEqual(st.resume, { ticks: saved.ticks, hash: saved.hash });
  assert.deepEqual(st.options, ctx.start.options, 'exactly the saved options');
  const logged = guest.take('log').flatMap((m) => m.frames);
  assert.deepEqual(logged, (await ctx.s.session.log.read()).filter(([t]) => t <= agreed.tick));
  assert.deepEqual(guest.last('sync'), { t: 'sync', tick: saved.ticks, check: { tick: saved.ticks - 1, hash: saved.hash } });
  // Players have a short time to catch up (the saved orders only).
  const { resumeStartMs } = await import('../src/session.js');
  for (const st2 of s.session.room.seatStates.filter(Boolean)) assert.ok(st2.until <= Date.now() + resumeStartMs(saved.ticks));
  // Orders before everyone caught up are refused; the relay waits.
  await s.send(host, { t: 'orders', tick: saved.ticks + 3, orders: [] });
  assert.equal(host.last('error').code, 'bad_state');
  assert.equal(host.take('frame').length, 0);
  await s.send(host, { t: 'resume' });
  assert.equal(host.take('frame').length, 0, 'still waiting for the guest');
  await s.send(guest, { t: 'resume' });
  const backs = host.take('back');
  assert.deepEqual(backs.map((b) => b.tick), [saved.ticks, saved.ticks]);
  assert.deepEqual(host.take('frame').map((f) => f.tick), [saved.ticks, saved.ticks + 1, saved.ticks + 2]);
  // Lockstep goes on from the save point.
  const seat = (w) => st.players.find((p) => p.client === w.you).player;
  await play(s, [{ ws: host, seat: seat(hw) }, { ws: guest, seat: seat(gw) }], saved.ticks, saved.ticks + 5);
  assert.deepEqual(guest.take('frame').map((f) => f.tick).slice(-2), [saved.ticks + 6, saved.ticks + 7]);
  valid(host);
  valid(guest);
});

test('online save records: export lists them, 90 days and purging remove them, 20 per account', async () => {
  const env = makeEnv({ email: false });
  const accounts = await accountsFor(env);
  const { recordSave } = await import('../src/onlinesaves.js');
  const rec = (n, at) =>
    recordSave(env.DB, { engine: '1', title: `Game ${n}`, ticks: 26, stateHash: 'ab', framesDigest: 'f'.repeat(64), optionsDigest: 'e'.repeat(64), mapHash: null, members: [{ seat: 0, userId: accounts.host.user.id }, { seat: 1, userId: accounts.guest.user.id }] }, at);
  const now = Date.now();
  for (let i = 0; i < 21; i++) await rec(i, now - 1000 + i);
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM online_saves')[0].n, 20, 'the oldest beyond 20 per account went');
  await accounts.host.post('/api/auth/reauth', { password: PASSWORD });
  const exp = await accounts.host.get('/api/account/export');
  assert.equal(exp.status, 200);
  assert.equal(exp.body.onlineSaves.length, 20);
  assert.deepEqual(Object.keys(exp.body.onlineSaves[0]).sort(), ['createdAt', 'engine', 'id', 'seat', 'ticks', 'title']);
  await rec('old', now - ONLINE_SAVE_RETENTION_MS - 1);
  await scheduled(env, now);
  assert.equal(env.DB.rows("SELECT COUNT(*) AS n FROM online_saves WHERE title = 'Game old'")[0].n, 0, '90 days');
  const { purgeStatements } = await import('../src/accounts/routes-admin.js');
  await env.DB.batch(purgeStatements(env.DB, accounts.guest.user.id));
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM online_saves')[0].n, 0, 'a purged player takes its saves along');
  assert.equal(env.DB.rows('SELECT COUNT(*) AS n FROM online_save_members')[0].n, 0);
});

test('resume uploads: the host is checked before the body is read, sizes are bounded early, the orders budget while validating', async () => {
  const env = makeEnv({ email: false });
  const accounts = await accountsFor(env);
  const s = await makeSession({ DB: env.DB, maxPlayers: 2 });
  const sid = wire(env, s.session);
  const host = s.connect('host', '10.0.0.1', authOf(accounts.host));
  await s.send(host, hello(s, { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  const guest = s.connect('guest', '10.0.0.2', authOf(accounts.guest));
  await s.send(guest, hello(s));
  const gw = guest.take('welcome')[0];
  const post = (b, w, body, headers = {}) => b.req('POST', `/api/sessions/${sid}/resume`, body, { headers: { [MEMBER_HEADER]: `${w.you}.${w.key}`, ...headers } });
  // Not the host: refused before the (here malformed) body is looked at.
  const notHost = await post(accounts.guest, gw, '{not json');
  assert.deepEqual([notHost.status, notHost.body.error.code], [403, 'not_host']);
  // A declared size beyond the orders limit plus a map is refused before reading.
  const big = await post(accounts.host, hw, '{}', { 'Content-Length': String(17 * 1024 * 1024 + 300 * 1024) });
  assert.equal(big.status, 413);
  // Orders beyond the order log limit: refused while validating, before any digest.
  const ids = Array.from({ length: 1990 }, () => 4294967295);
  const frameSize = JSON.stringify([[0, [{ o: 'stop', player: 0, ids }]]]).length + 16;
  const count = Math.ceil((16 * 1024 * 1024) / frameSize) + 2;
  const frames = Array.from({ length: count }, (_, i) => [i, [[0, [{ o: 'stop', player: 0, ids }]]]]);
  const options = { ...((await import('@webra/protocol')).DEFAULT_OPTIONS), players: [{ slot: 0, type: 'human', name: 'A', faction: 'germany', color: 0, team: 0 }, { slot: 1, type: 'human', name: 'B', faction: 'russia', color: 1, team: 0 }] };
  const ticks = 25 * Math.ceil((count + 1) / 25) + 1;
  const text = JSON.stringify({ format: REPLAY_FORMAT, version: REPLAY_VERSION, kind: 'save', mode: 'online', engine: s.version, createdAt: 1, title: 'Long', options, map: null, mapHash: null, player: 0, ticks, frames, hashes: [[ticks, 'ab']], online: { id: '0123456789abcdef' } });
  assert.ok(text.length < 17 * 1024 * 1024 + 256 * 1024, 'within the upload cap');
  const long = await post(accounts.host, hw, text);
  assert.deepEqual([long.status, long.body.error.code], [413, 'too_large']);
});

test('a resumed start waits at most a few minutes for its players', async () => {
  const { resumeStartMs, RESUME_START_MAX_MS } = await import('../src/session.js');
  assert.equal(resumeStartMs(1), 60_001);
  assert.equal(resumeStartMs(10_000_000), RESUME_START_MAX_MS);
  assert.ok(RESUME_START_MAX_MS <= 3 * 60_000);
});

test('anything the order log keeps fits a resume: the log and the save check count frames the same way', async () => {
  const { OrderLog } = await import('../src/orderlog.js');
  const { FakeStorage } = await import('./fake-do.mjs');
  const { parseReplay, logEntryBytes, DEFAULT_OPTIONS } = await import('@webra/protocol');
  const orders = (t) => [[0, [{ o: 'stop', player: 0, ids: Array.from({ length: (t % 5) + 1 }, (_, i) => t * 10 + i) }]]];
  // A log whose limit is reached exactly by the first three frames.
  const limit = [1, 2, 3].reduce((n, t) => n + logEntryBytes(t, orders(t)), 0);
  const log = new OrderLog(new FakeStorage(), { maxBytes: limit });
  for (const t of [1, 2, 3]) log.append({ tick: t, orders: orders(t) });
  assert.equal(log.full, false, 'exactly at the limit is kept');
  log.append({ tick: 4, orders: orders(4) });
  assert.equal(log.full, true, 'one more frame is not');
  const options = { ...DEFAULT_OPTIONS, players: [{ slot: 0, type: 'human', name: 'A', faction: 'germany', color: 0, team: 0 }, { slot: 1, type: 'human', name: 'B', faction: 'russia', color: 1, team: 0 }] };
  const file = (frames) => JSON.stringify({ format: REPLAY_FORMAT, version: REPLAY_VERSION, kind: 'replay', mode: 'online', engine: '1', createdAt: 1, title: 'x', options, map: null, mapHash: null, player: 0, ticks: 100, frames, hashes: [] });
  const kept = await log.read();
  assert.equal((await parseReplay(file(kept), { maxFrameBytes: limit })).ok, true, 'what the log kept passes the resume budget');
  const over = await parseReplay(file([...kept, [4, orders(4)]]), { maxFrameBytes: limit });
  assert.deepEqual([over.ok, over.code], [false, 'too_large'], 'and what it refused does not');
});

test('a player too slow for a resumed start is dropped for now, not for good: the game starts, and it rejoins', async () => {
  const env = makeEnv({ email: false });
  const accounts = await accountsFor(env);
  const ctx = await game(env, accounts);
  const { agreed, result: saved } = await saveGame(ctx);
  const text = await saveFile(ctx, saved, agreed);
  const s = await makeSession({ DB: env.DB, maxPlayers: 3 });
  const sid = wire(env, s.session);
  const host = s.connect('host', '10.0.0.1', authOf(accounts.host));
  await s.send(host, hello(s, { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  assert.equal((await accounts.host.req('POST', `/api/sessions/${sid}/resume`, text, { headers: { [MEMBER_HEADER]: `${hw.you}.${hw.key}` } })).status, 200);
  const guest = s.connect('guest', '10.0.0.2', authOf(accounts.guest));
  await s.send(guest, hello(s));
  const gw = guest.take('welcome')[0];
  await s.send(guest, { t: 'ready', ready: true, mapHash: null });
  await s.send(host, { t: 'start' });
  const st = host.last('start');
  const seatOf = (w) => st.players.find((p) => p.client === w.you).player;
  await s.send(host, { t: 'resume' });
  // The guest's device is slow: its catch-up time runs out.
  s.session.room.seatStates[seatOf(gw)].until = Date.now() - 1;
  await s.session.alarm();
  assert.equal(guest.last('error').code, 'dropped');
  assert.ok(guest.closed);
  assert.deepEqual([host.last('left').reason, host.last('left').player], ['dropped', seatOf(gw)]);
  assert.equal(s.session.room.seatState(seatOf(gw)), 'away', 'not gone: it may rejoin');
  assert.ok(s.session.room.seatStates[seatOf(gw)].until >= Date.now() + 100_000, 'with the full reconnect grace');
  // The game starts for the host.
  assert.deepEqual(host.take('frame').map((f) => f.tick), [saved.ticks, saved.ticks + 1, saved.ticks + 2]);
  // The guest reconnects with its key, catches up and plays on.
  const back = s.connect('guest-back', '10.0.0.2', authOf(accounts.guest));
  await s.send(back, hello(s, { rejoin: { client: gw.you, key: gw.key } }));
  assert.ok(back.take('welcome')[0]);
  assert.ok(back.last('start').resume);
  assert.ok(back.last('sync'));
  await s.send(back, { t: 'resume' });
  const b = host.last('back');
  assert.equal(b.client, gw.you);
  assert.ok(b.tick > saved.ticks);
  valid(host);
  valid(back);
});

test('a co-op mission save is pinned by its mission record', async () => {
  const { COOP_MISSIONS } = await import('@webra/protocol');
  const { missionDigest } = await import('../src/onlinesaves.js');
  const m = COOP_MISSIONS[0];
  const a = await missionDigest({ id: m.id, hash: m.hash, options: { difficulty: 'easy' } });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await missionDigest({ id: m.id, hash: m.hash, options: { difficulty: 'easy' } }));
  assert.notEqual(a, await missionDigest({ id: m.id, hash: m.hash, options: { difficulty: 'normal' } }), 'another difficulty is another game');
  await assert.rejects(() => missionDigest({ id: m.id, hash: 'f'.repeat(64), options: {} }));
});
