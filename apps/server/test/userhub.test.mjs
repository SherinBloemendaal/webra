// The realtime hub Durable Object (src/userhub.js) under the fake runtime
// (fake-do.mjs): the upgrade with the Worker's verdict, tags and the hello,
// publishing by topic with the origin skip, closing ended sign-in sessions,
// the message limit and the hibernation rules (only `seq` is stored).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSocket, makeHubCtx } from './fake-do.mjs';
import { REALTIME_PING, REALTIME_PONG } from '@webra/protocol';

const { UserHub, readHubAuth, MAX_SOCKETS, MESSAGE_LIMIT } = await import('../src/userhub.js');

const USER = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const SID = '1'.repeat(16);
const SID2 = '2'.repeat(16);

function makeHub() {
  const ctx = makeHubCtx();
  const hub = new UserHub(ctx, {});
  // Node's Response has no 101: the test reads the client side directly.
  hub.upgraded = (client) => ({ status: 101, webSocket: client });
  return { ctx, hub };
}

const verdict = (o = {}) => ({ userId: USER, username: 'Tanya', sid: SID, role: 'user', status: 'active', topics: ['friends', 'account', 'settings', 'replays'], ...o });
const upgrade = (auth, headers = {}) =>
  new Request('https://hub/', { headers: { Upgrade: 'websocket', ...(auth === undefined ? {} : { 'X-WebRA-Auth': typeof auth === 'string' ? auth : JSON.stringify(auth) }), ...headers } });

/** Connect with `o` (verdict fields); returns the server-side socket. */
async function connect(h, o = {}) {
  const res = await h.hub.fetch(upgrade(verdict(o)));
  assert.equal(res.status, 101);
  return h.ctx.sockets.at(-1);
}

test('the constructor registers the ping auto response (answered without waking the object)', () => {
  const { ctx } = makeHub();
  assert.equal(ctx.autoResponse.request, REALTIME_PING);
  assert.equal(ctx.autoResponse.response, REALTIME_PONG);
});

test('upgrade: the verdict is checked, the socket tagged and greeted with seq', async () => {
  const h = makeHub();
  assert.equal((await h.hub.fetch(new Request('https://hub/'))).status, 426, 'not an upgrade');
  assert.equal((await h.hub.fetch(upgrade(undefined))).status, 403, 'no verdict');
  assert.equal((await h.hub.fetch(upgrade('{nope'))).status, 403, 'malformed verdict');
  for (const bad of [{ userId: 'x' }, { sid: 'short' }, { role: 'root' }, { topics: [] }, { topics: ['friends', 'friends'] }, { topics: ['gossip'] }, { username: 7 }]) {
    assert.equal((await h.hub.fetch(upgrade(verdict(bad)))).status, 403, JSON.stringify(bad));
  }
  assert.equal(h.ctx.sockets.length, 0);
  await h.ctx.storage.put('seq', 7);
  const ws = await connect(h);
  assert.deepEqual(ws.tags, [`sid:${SID}`, `user:${USER}`, 'topic:friends', 'topic:account', 'topic:settings', 'topic:replays']);
  assert.deepEqual(ws.inbox, [{ t: 'hello', v: 1, seq: 7, topics: ['friends', 'account', 'settings', 'replays'], userId: USER }]);
  const att = ws.deserializeAttachment();
  assert.equal(att.sid, SID);
  assert.equal(att.userId, USER);
  assert.equal(readHubAuth(upgrade(verdict())).username, 'Tanya');
});

test('upgrade: at most MAX_SOCKETS per object (429)', async () => {
  const h = makeHub();
  for (let i = 0; i < MAX_SOCKETS; i++) await connect(h);
  assert.equal((await h.hub.fetch(upgrade(verdict()))).status, 429);
  h.ctx.sockets[0].close(1000, 'gone');
  assert.equal((await h.hub.fetch(upgrade(verdict()))).status, 101, 'a closed socket frees its place');
});

test('publish: seq grows, only the topic hears it, the origin is skipped for settings and replays only', async () => {
  const h = makeHub();
  const a = await connect(h, { sid: SID });
  const b = await connect(h, { sid: SID2 });
  const pending = await connect(h, { sid: '3'.repeat(16), topics: ['account', 'settings'] });
  for (const ws of [a, b, pending]) ws.take('hello');

  assert.equal(await h.hub.publish({ topic: 'friends', kind: 'request', data: { username: 'Ivan' }, origin: SID }), 2, 'friends: the origin hears it too (its other tabs share the sign-in)');
  const [ev] = a.take('event');
  assert.equal(ev.seq, 1);
  assert.equal(ev.topic, 'friends');
  assert.equal(ev.kind, 'request');
  assert.deepEqual(ev.data, { username: 'Ivan' });
  assert.equal(b.take('event').length, 1);
  assert.equal(pending.take('event').length, 0, 'no friends topic: nothing');

  assert.equal(await h.hub.publish({ topic: 'settings', kind: 'updated', data: { version: 4 }, origin: SID }), 2);
  assert.equal(a.take('event').length, 0, 'the device that saved is skipped');
  assert.equal(b.take('event')[0].seq, 2);
  assert.deepEqual(pending.take('event')[0].data, { version: 4 });

  assert.equal(await h.hub.publish({ topic: 'replays', kind: 'added', data: { id: 'c'.repeat(16) }, origin: SID2 }), 1);
  assert.equal(b.take('event').length, 0);
  assert.equal(a.take('event')[0].kind, 'added');
  assert.equal(await h.ctx.storage.get('seq'), 3);
  assert.deepEqual([...h.ctx.storage.data.keys()], ['seq'], 'the only stored state');

  await assert.rejects(h.hub.publish({ topic: 'gossip', kind: 'x' }), TypeError);
  await assert.rejects(h.hub.publish({ topic: 'friends', kind: 'poke' }), TypeError);
  // Only the documented fields leave the hub: anything else in `data` is dropped.
  await h.hub.publish({ topic: 'friends', kind: 'request', data: { username: 'Ivan', email: 'ivan@example.com' } });
  assert.deepEqual(a.take('event')[0].data, { username: 'Ivan' });
});

test('publish: nobody listening stores nothing; a throwing socket does not stop the others', async () => {
  const h = makeHub();
  assert.equal(await h.hub.publish({ topic: 'friends', kind: 'presence' }), 0);
  assert.equal(await h.ctx.storage.get('seq'), undefined, 'no write for an account without open pages');
  const broken = new FakeSocket('broken');
  broken.send = () => {
    throw new Error('gone');
  };
  h.ctx.acceptWebSocket(broken, ['sid:' + SID, 'topic:friends']);
  broken.serializeAttachment({ sid: SID });
  const ok = await connect(h, { sid: SID2 });
  ok.take('hello');
  assert.equal(await h.hub.publish({ topic: 'friends', kind: 'presence', data: { username: 'Ivan' } }), 1);
  assert.equal(ok.take('event').length, 1);
});

test('closeSessions: the named sign-in sessions, all, all but one, or one account on the shared admin object', async () => {
  const h = makeHub();
  const a = await connect(h, { sid: SID });
  const b = await connect(h, { sid: SID2 });
  const c = await connect(h, { sid: '3'.repeat(16) });
  assert.equal(await h.hub.closeSessions({ sids: [SID2] }), 1);
  assert.deepEqual(b.closed, { code: 4001, reason: 'signed_out' });
  assert.equal(a.closed, null);
  assert.equal(await h.hub.closeSessions({ except: SID }), 1, 'everything but the session that changed the password');
  assert.deepEqual(c.closed, { code: 4001, reason: 'signed_out' });
  assert.equal(a.closed, null);
  assert.equal(await h.hub.closeSessions({ sids: null }), 1);
  assert.equal(a.closed.code, 4001);
  await assert.rejects(h.hub.closeSessions({ sids: ['nope'] }), TypeError);

  const admin = makeHub();
  const mine = await connect(admin, { topics: ['admin'], role: 'admin' });
  const theirs = await connect(admin, { userId: OTHER, sid: SID2, topics: ['admin'], role: 'moderator' });
  assert.equal(await admin.hub.closeSessions({ userId: OTHER }), 1);
  assert.equal(theirs.closed.code, 4001);
  assert.equal(mine.closed, null, "another admin's dashboard stays");
  assert.equal(await admin.hub.count(), 1);
});

test('client messages: a stray ping is answered, more than MESSAGE_LIMIT a minute close with 1008, size is capped', async () => {
  const h = makeHub();
  const ws = await connect(h);
  ws.take('hello');
  await h.hub.webSocketMessage(ws, '{ "t": "ping" }');
  assert.deepEqual(ws.take('pong'), [{ t: 'pong' }]);
  for (let i = 1; i < MESSAGE_LIMIT; i++) await h.hub.webSocketMessage(ws, '{"t":"future"}');
  assert.equal(ws.closed, null, 'unknown types are ignored');
  assert.equal(ws.deserializeAttachment().messages, MESSAGE_LIMIT, 'counted in the attachment (survives hibernation)');
  await h.hub.webSocketMessage(ws, '{"t":"future"}');
  assert.deepEqual(ws.closed, { code: 1008, reason: 'rate_limited' });

  const big = await connect(h);
  await h.hub.webSocketMessage(big, 'x'.repeat(5000));
  assert.equal(big.closed.code, 1009);
});
