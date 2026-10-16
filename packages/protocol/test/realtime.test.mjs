// The realtime channel's messages (src/realtime.js, docs/accounts-api.md
// 5.12): every documented shape parses, anything else is refused, the
// encoders validate, and the constants are exported from the package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../src/index.js';
import {
  encodeRealtimeEvent,
  encodeRealtimeHello,
  FRIENDS_POLL_MS,
  FRIENDS_POLL_SLOW_MS,
  parseRealtimeMessage,
  REALTIME_CLOSE,
  REALTIME_KINDS,
  REALTIME_MAX_BYTES,
  REALTIME_PING,
  REALTIME_PONG,
  REALTIME_TOPICS,
  REALTIME_VERSION,
} from '../src/index.js';

const USER = 'a'.repeat(32);
const ok = (msg) => {
  const r = parseRealtimeMessage(JSON.stringify(msg));
  assert.equal(r.ok, true, `${JSON.stringify(msg)}: ${r.error}`);
  return r.msg;
};
const bad = (text, why) => assert.equal(parseRealtimeMessage(typeof text === 'string' ? text : JSON.stringify(text)).ok, false, why);
const event = (o = {}) => ({ t: 'event', v: 1, seq: 3, topic: 'friends', kind: 'request', at: 1_760_000_000_000, data: { username: 'Ivan' }, ...o });

test('constants: exported from the package, one kind list per topic', () => {
  for (const name of ['REALTIME_VERSION', 'REALTIME_TOPICS', 'REALTIME_KINDS', 'REALTIME_CLOSE', 'REALTIME_PING_MS', 'REALTIME_BACKOFF_MAX_MS', 'REALTIME_REFETCH_DEBOUNCE_MS', 'parseRealtimeMessage', 'encodeRealtimeEvent', 'encodeRealtimeHello']) {
    assert.ok(name in protocol, name);
  }
  assert.equal(REALTIME_VERSION, 1);
  assert.deepEqual(REALTIME_TOPICS, ['friends', 'account', 'settings', 'replays', 'admin']);
  assert.deepEqual(Object.keys(REALTIME_KINDS), REALTIME_TOPICS);
  assert.deepEqual(REALTIME_CLOSE, { SIGNED_OUT: 4001, FORBIDDEN: 4003 });
  assert.equal(REALTIME_PING, '{"t":"ping"}');
  assert.deepEqual(JSON.parse(REALTIME_PONG), { t: 'pong' });
  assert.ok(FRIENDS_POLL_SLOW_MS > FRIENDS_POLL_MS);
  assert.ok(Object.isFrozen(REALTIME_KINDS.friends));
});

test('parse: hello, every topic and kind, pong', () => {
  assert.deepEqual(ok({ t: 'hello', v: 1, seq: 0, topics: ['account', 'settings'], userId: USER }), { t: 'hello', v: 1, seq: 0, topics: ['account', 'settings'], userId: USER });
  assert.deepEqual(ok({ t: 'pong' }), { t: 'pong' });
  const data = { friends: { username: 'Ivan', session: 'b'.repeat(64) }, account: { status: 'active' }, settings: { version: 4 }, replays: { id: 'c'.repeat(16) }, admin: { userId: USER } };
  for (const topic of REALTIME_TOPICS) {
    for (const kind of REALTIME_KINDS[topic]) {
      assert.deepEqual(ok(event({ topic, kind, data: data[topic] })).data, data[topic]);
      assert.equal(ok(event({ topic, kind, data: null })).data, null, 'data may be null');
    }
  }
  // Fields the client does not know are dropped (the server may add some without a new version).
  assert.deepEqual(ok({ ...event(), extra: 1, data: { username: 'Ivan', mood: 'happy' } }), event());
  assert.equal(ok(event({ data: {} })).data, null);
});

test('parse: unknown types, topics, kinds, versions, shapes and sizes are refused', () => {
  bad('nope', 'not JSON');
  bad('[1]', 'not an object');
  bad({ t: 'welcome' }, 'unknown type');
  bad({ t: 'ping' }, 'the client message is not a server message');
  bad(event({ v: 2 }), 'a newer version');
  bad(event({ v: undefined }), 'no version');
  bad(event({ topic: 'gossip' }), 'unknown topic');
  bad(event({ kind: 'poke' }), 'unknown kind');
  bad(event({ topic: 'account', kind: 'request' }), 'a kind of another topic');
  bad(event({ seq: 0 }), 'events count from 1');
  bad(event({ seq: 1.5 }));
  bad(event({ at: -1 }));
  bad(event({ data: 'Ivan' }), 'data is an object');
  bad(event({ data: [1] }));
  bad(event({ data: { username: 7 } }), 'a malformed field');
  bad(event({ topic: 'account', kind: 'status', data: { status: 'royal' } }));
  bad(event({ topic: 'replays', kind: 'added', data: { id: 'x' } }));
  bad(event({ topic: 'friends', kind: 'invite', data: { username: 'Ivan', session: 'short' } }));
  bad({ t: 'hello', v: 1, seq: 0, topics: ['gossip'], userId: USER });
  bad({ t: 'hello', v: 1, seq: 0, topics: ['friends', 'friends'], userId: USER });
  bad({ t: 'hello', v: 1, seq: 0, topics: 'friends', userId: USER });
  bad({ t: 'hello', v: 1, seq: -1, topics: [], userId: USER });
  bad({ t: 'hello', v: 1, seq: 0, topics: [], userId: 'x' });
  bad(JSON.stringify(event({ data: { username: 'I'.repeat(60) } })) + ' '.repeat(REALTIME_MAX_BYTES), 'oversize');
  assert.equal(parseRealtimeMessage(null).ok, false);
});

test('encode: validated, round-trips, refuses what parse would refuse', () => {
  const e = { seq: 9, topic: 'settings', kind: 'updated', at: 5, data: { version: 3 } };
  const text = encodeRealtimeEvent(e);
  assert.deepEqual(parseRealtimeMessage(text), { ok: true, msg: { t: 'event', v: 1, ...e } });
  assert.deepEqual(JSON.parse(encodeRealtimeEvent({ seq: 1, topic: 'friends', kind: 'presence', at: 0 })).data, null, 'no data: null');
  assert.throws(() => encodeRealtimeEvent({ seq: 1, topic: 'friends', kind: 'poke', at: 0 }), TypeError);
  assert.throws(() => encodeRealtimeEvent({ seq: 0, topic: 'friends', kind: 'presence', at: 0 }), TypeError);
  assert.throws(() => encodeRealtimeEvent(null), TypeError);
  assert.throws(() => encodeRealtimeEvent({ seq: 1, topic: 'account', kind: 'status', at: 0, data: { status: 'x' } }), TypeError);
  const hello = encodeRealtimeHello({ seq: 2, topics: ['admin'], userId: USER });
  assert.deepEqual(parseRealtimeMessage(hello).msg, { t: 'hello', v: 1, seq: 2, topics: ['admin'], userId: USER });
  assert.throws(() => encodeRealtimeHello({ seq: 2, topics: ['x'], userId: USER }), TypeError);
});

test('site settings: `realtime` is a switch, on by default', () => {
  assert.equal(protocol.DEFAULT_SITE_SETTINGS.realtime, true);
  assert.equal(protocol.mergeSiteSettings(protocol.DEFAULT_SITE_SETTINGS, { realtime: false }).realtime, false);
  assert.throws(() => protocol.mergeSiteSettings(protocol.DEFAULT_SITE_SETTINGS, { realtime: 'off' }));
  assert.equal(protocol.normalizeSiteSettings({}).realtime, true, 'stored settings from before the switch read as on');
});
