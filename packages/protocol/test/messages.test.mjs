import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  C2S,
  DEFAULT_OPTIONS,
  encodeClient,
  encodeServer,
  errorMessage,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  S2C,
  validateGameOptions,
  validateLobbyOptions,
} from '../src/index.js';

const parse = (m) => parseClientMessage(typeof m === 'string' ? m : JSON.stringify(m));
const ok = (m) => {
  const r = parse(m);
  assert.ok(r.ok, `${JSON.stringify(m).slice(0, 80)}: ${r.message}`);
  return r.msg;
};
const bad = (m, re) => {
  const r = parse(m);
  assert.equal(r.ok, false, `accepted ${JSON.stringify(m).slice(0, 120)}`);
  if (re) assert.match(r.message, re);
  return r;
};
const HOST_KEY = 'A'.repeat(43);

test('hello: valid, normalized and strict', () => {
  const m = ok({ t: 'hello', protocol: PROTOCOL_VERSION, version: '0.2.0+abc123', name: '  Tanya   Adams ', hostKey: HOST_KEY });
  assert.deepEqual(m, { t: 'hello', protocol: 1, version: '0.2.0+abc123', name: 'Tanya Adams', hostKey: HOST_KEY });
  ok({ t: 'hello', protocol: 1, version: '1.0.0', name: 'x', password: 'secret' });
  bad({ t: 'hello', protocol: 1, version: '1.0.0', name: '' }, /empty/);
  bad({ t: 'hello', protocol: 1, version: '1.0.0', name: 'x'.repeat(25) }, /at most 24/);
  bad({ t: 'hello', protocol: 1, version: '1.0.0', name: 'a\u0000b' });
  bad({ t: 'hello', protocol: 1, version: '1.0.0', name: 'evil' + String.fromCharCode(0x202e) + 'gnp' });
  bad({ t: 'hello', protocol: 1, version: '1.0.0', name: 'x', admin: true }, /unknown field/);
  bad({ t: 'hello', protocol: 1, version: '1.0.0 ', name: 'x' }, /version/);
  bad({ t: 'hello', protocol: 1, version: '1.0.0', name: 'x', hostKey: 'short' }, /hostKey/);
  bad({ t: 'hello', protocol: 1, version: '1.0.0', name: 'x', password: '' });
  bad({ t: 'hello', protocol: 1, version: '1.0.0', name: 'x', password: 'p'.repeat(65) });
  bad({ t: 'hello', protocol: '1', version: '1.0.0', name: 'x' }, /protocol/);
  // Lone surrogate (would break UTF-8 consumers).
  bad('{"t":"hello","protocol":1,"version":"1","name":"a\\ud800"}');
  // Names count code points, not UTF-16 units.
  ok({ t: 'hello', protocol: 1, version: '1', name: String.fromCodePoint(0x1f600).repeat(24) });
});

test('garbage, unknown types, prototype keys and oversized messages are rejected', () => {
  for (const raw of ['', 'null', '[]', '42', '"hello"', '{', '{"t":"nope"}', '{"t":"toString"}', '{"t":"__proto__"}']) {
    assert.equal(parseClientMessage(raw).ok, false, raw);
  }
  assert.equal(parseClientMessage(new ArrayBuffer(4)).ok, false);
  const big = JSON.stringify({ t: 'chat', text: 'x'.repeat(MAX_MESSAGE_BYTES) });
  assert.equal(parseClientMessage(big).code, 'too_large');
  bad('{"t":"leave","__proto__":{"x":1}}');
  bad({ t: 'leave', extra: 1 });
  assert.deepEqual(ok({ t: 'leave' }), { t: 'leave' });
  assert.deepEqual(ok({ t: 'start' }), { t: 'start' });
});

test('slot, options, map and ready', () => {
  assert.deepEqual(ok({ t: 'slot', slot: 3, faction: 'random', color: 7, team: 4 }), {
    t: 'slot',
    slot: 3,
    faction: 'random',
    color: 7,
    team: 4,
  });
  ok({ t: 'slot', slot: 1, type: 'ai', difficulty: 'hard' });
  bad({ t: 'slot', slot: 8 });
  bad({ t: 'slot', slot: -1 });
  bad({ t: 'slot', slot: 1.5 });
  bad({ t: 'slot', slot: 0, faction: 'atlantis' });
  bad({ t: 'slot', slot: 0, color: 8 });
  bad({ t: 'slot', slot: 0, team: 5 });
  bad({ t: 'slot', slot: 0, type: 'human' }, /unsupported/);
  bad({ t: 'slot', slot: 0, difficulty: 'brutal' });

  assert.deepEqual(ok({ t: 'options', options: { ...DEFAULT_OPTIONS } }).options, { ...DEFAULT_OPTIONS });
  bad({ t: 'options', options: { ...DEFAULT_OPTIONS, mapSize: 100 } });
  bad({ t: 'options', options: { ...DEFAULT_OPTIONS, fog: 'yes' } });
  bad({ t: 'options', options: { ...DEFAULT_OPTIONS, players: [] } }, /unknown field/);
  const { seed: _seed, ...missing } = DEFAULT_OPTIONS;
  bad({ t: 'options', options: missing }, /seed/);

  const hash = 'a'.repeat(64);
  assert.equal(ok({ t: 'map', map: null }).map, null);
  ok({ t: 'map', map: { id: '0123456789abcdef', hash, name: 'Twin Rivers', modded: true } });
  bad({ t: 'map' }, /required/);
  bad({ t: 'map', map: { id: '0123456789abcdeg', hash, name: 'x', modded: false } });
  bad({ t: 'map', map: { id: '0123456789abcdef', hash: 'A'.repeat(64), name: 'x', modded: false } });
  bad({ t: 'map', map: { id: '0123456789abcdef', hash, name: 'x', modded: false, players: 4 } }, /unknown field/);

  assert.deepEqual(ok({ t: 'ready', ready: true, mapHash: hash }), { t: 'ready', ready: true, mapHash: hash });
  assert.equal(ok({ t: 'ready', ready: false }).mapHash, null);
  bad({ t: 'ready', ready: 1 });
});

test('chat is limited to 200 characters', () => {
  assert.equal(ok({ t: 'chat', text: ' hi\n there ' }).text, 'hi there');
  ok({ t: 'chat', text: 'x'.repeat(200) });
  bad({ t: 'chat', text: 'x'.repeat(201) });
  bad({ t: 'chat', text: '   ' });
});

test('orders and hash', () => {
  const move = { o: 'move', player: 0, ids: [1, 2], x: 10, y: -4, attack_move: false };
  const m = ok({ t: 'orders', tick: 3, orders: [move, { o: 'start_production', player: 0, ty: 12, count: 5 }] });
  assert.deepEqual(m.orders[0], move);
  ok({ t: 'orders', tick: 0, orders: [] });
  for (const o of [
    { o: 'smart', player: 1, ids: [], x: 0, y: 0 },
    { o: 'attack', player: 1, ids: [3], target: 9 },
    { o: 'stop', player: 1, ids: [3] },
    { o: 'cancel_production', player: 1, ty: 0 },
    { o: 'place', player: 1, ty: 2, cx: 5, cy: 6 },
    { o: 'rally', player: 1, building: 4, x: 1, y: 1 },
    { o: 'sell', player: 1, building: 4 },
    { o: 'deploy', player: 1, ids: [4] },
    { o: 'land', player: 1, ids: [4], x: 100, y: 200 },
    { o: 'return_to_base', player: 1, ids: [4] },
  ]) {
    ok({ t: 'orders', tick: 1, orders: [o] });
  }
  bad({ t: 'orders', tick: -1, orders: [] });
  bad({ t: 'orders', tick: 3, orders: {} });
  bad({ t: 'orders', tick: 3, orders: [[1, 2]] }, /order type/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'nuke', player: 0 }] }, /order type/);
  bad({ t: 'orders', tick: 3, orders: [{ ...move, extra: 1 }] }, /unknown field/);
  bad({ t: 'orders', tick: 3, orders: [{ ...move, x: 1.5 }] });
  bad({ t: 'orders', tick: 3, orders: [{ ...move, ids: [-1] }] });
  bad({ t: 'orders', tick: 3, orders: [{ ...move, player: 8 }] });
  bad({ t: 'orders', tick: 3, orders: [{ o: 'stop', player: 0 }] }, /required/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'start_production', player: 0, ty: 1, count: 51 }] });
  bad({ t: 'orders', tick: 3, orders: Array.from({ length: 33 }, () => ({ o: 'stop', player: 0, ids: [] })) }, /at most/);
  bad('{"t":"orders","tick":3,"orders":[{"o":"stop","player":0,"ids":[],"__proto__":{"x":1}}]}');
  assert.deepEqual(ok({ t: 'hash', tick: 50, hash: '00ff00ff00ff00ff' }), { t: 'hash', tick: 50, hash: '00ff00ff00ff00ff' });
  bad({ t: 'hash', tick: 51, hash: '00' }, /multiples/);
  bad({ t: 'hash', tick: 50, hash: 'XYZ' });
});

test('encodeClient refuses invalid messages', () => {
  assert.equal(encodeClient({ t: C2S.CHAT, text: 'gg' }), '{"t":"chat","text":"gg"}');
  assert.throws(() => encodeClient({ t: C2S.CHAT, text: '' }), ProtocolError);
  assert.throws(() => encodeClient({ t: 'frame' }), ProtocolError);
});

const SESSION = { id: 'f'.repeat(64), name: 'Friday night', public: true, locked: false, maxPlayers: 4, version: '0.2.0+abc' };
const OPTIONS = {
  ...DEFAULT_OPTIONS,
  players: [
    { slot: 0, type: 'human', name: 'Host', faction: 'germany', color: 0, team: 0 },
    { slot: 1, type: 'ai', difficulty: 'normal', faction: 'russia', color: 1, team: 0 },
  ],
};

test('server messages round trip through encodeServer / parseServerMessage', () => {
  const msgs = [
    { t: S2C.WELCOME, you: 1, hostId: 1, session: SESSION },
    {
      t: S2C.LOBBY,
      hostId: 1,
      slots: [
        { type: 'human', client: 1, name: 'Host', faction: 'germany', color: 0, team: 0, ready: false },
        { type: 'ai', difficulty: 'easy', faction: 'random', color: 1, team: 2 },
        { type: 'open' },
        { type: 'closed' },
      ],
      options: { ...DEFAULT_OPTIONS },
      map: { id: '0123456789abcdef', hash: 'b'.repeat(64), name: 'Twin', modded: false, players: 4 },
    },
    { t: S2C.CHAT, from: 1, name: 'Host', text: 'gl hf' },
    { t: S2C.CHAT, from: null, name: 'Server', text: 'Host left' },
    {
      t: S2C.START,
      seed: OPTIONS.seed,
      options: OPTIONS,
      map: null,
      delay: 3,
      players: [
        { player: 0, slot: 0, client: 1, name: 'Host', type: 'human' },
        { player: 1, slot: 2, client: null, name: 'Computer', type: 'ai' },
      ],
    },
    { t: S2C.FRAME, tick: 7, orders: [[0, [{ o: 'stop', player: 0, ids: [4] }]], [1, []]] },
    { t: S2C.DESYNC, tick: 75 },
    { t: S2C.LEFT, player: 1, client: 2, name: 'Guest', reason: 'dropped' },
    { t: S2C.ERROR, code: 'full', message: 'The session is full.' },
  ];
  for (const m of msgs) {
    const raw = encodeServer(m);
    const r = parseServerMessage(raw);
    assert.ok(r.ok, `${m.t}: ${r.message}`);
    assert.deepEqual(r.msg, m);
  }
});

test('server message validation catches inconsistent data', () => {
  const p = (m) => parseServerMessage(JSON.stringify(m));
  assert.equal(p({ t: 'frame', tick: 1, orders: [[0, []], [0, []]] }).ok, false);
  assert.equal(p({ t: 'lobby', hostId: 1, slots: [{ type: 'open', name: 'x' }, { type: 'closed' }], options: DEFAULT_OPTIONS, map: null }).ok, false);
  assert.equal(
    p({ t: 'start', seed: 99, options: OPTIONS, map: null, delay: 3, players: [] }).ok,
    false,
  );
  assert.equal(parseServerMessage('{"t":"hello"}').ok, false);
});

test('errorMessage truncates and strips non-printable text', () => {
  const r = parseServerMessage(errorMessage('invalid', `bad ${'y'.repeat(500)}\u0007`));
  assert.ok(r.ok);
  assert.equal(r.msg.message.length, 200);
});

test('game options: concrete factions, unique colours, slots in order', () => {
  assert.deepEqual(validateGameOptions(OPTIONS), OPTIONS);
  assert.throws(() => validateGameOptions({ ...OPTIONS, players: [OPTIONS.players[0]] }), /2 to 8/);
  assert.throws(
    () => validateGameOptions({ ...OPTIONS, players: [OPTIONS.players[0], { ...OPTIONS.players[1], color: 0 }] }),
    /used twice/,
  );
  assert.throws(
    () => validateGameOptions({ ...OPTIONS, players: [OPTIONS.players[0], { ...OPTIONS.players[1], faction: 'random' }] }),
    /faction/,
  );
  assert.throws(() => validateGameOptions({ ...OPTIONS, players: [OPTIONS.players[1], OPTIONS.players[0]] }), /index/);
  assert.throws(() => validateLobbyOptions({ ...DEFAULT_OPTIONS, seed: 2 ** 31 }), /seed/);
});
