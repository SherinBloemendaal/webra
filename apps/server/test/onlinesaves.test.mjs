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
