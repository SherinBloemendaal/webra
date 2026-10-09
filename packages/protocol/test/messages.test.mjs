import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  C2S,
  client,
  DEFAULT_OPTIONS,
  encodeClient,
  encodeServer,
  errorMessage,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_VERSION,
  MAP_STATES,
  MEMBER_HEADER,
  MEMBER_RE,
  ProtocolError,
  CHEAT_ORDER_KINDS,
  DEV_FLAGS,
  isCheatOrder,
  ORDER_KINDS,
  S2C,
  STANCES,
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
  assert.deepEqual(m, { t: 'hello', protocol: PROTOCOL_VERSION, version: '0.2.0+abc123', name: 'Tanya Adams', hostKey: HOST_KEY });
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
  // The debug menu (cheats) option is off by default, required and boolean.
  assert.equal(DEFAULT_OPTIONS.cheats, false);
  assert.equal(ok({ t: 'options', options: { ...DEFAULT_OPTIONS, cheats: true } }).options.cheats, true);
  bad({ t: 'options', options: { ...DEFAULT_OPTIONS, cheats: 1 } }, /cheats/);
  const { cheats: _cheats, ...noCheats } = DEFAULT_OPTIONS;
  bad({ t: 'options', options: noCheats }, /cheats/);
  // Map style, biome and weather (engine mapgen.rs and weather.rs): required, from fixed sets.
  assert.deepEqual([DEFAULT_OPTIONS.mapStyle, DEFAULT_OPTIONS.biome, DEFAULT_OPTIONS.weather], ['random', 'random', 'full']);
  for (const mapStyle of ['random', 'land', 'rivers', 'lakes', 'islands']) {
    assert.equal(ok({ t: 'options', options: { ...DEFAULT_OPTIONS, mapStyle } }).options.mapStyle, mapStyle);
  }
  for (const biome of ['random', 'temperate', 'snow', 'desert']) {
    assert.equal(ok({ t: 'options', options: { ...DEFAULT_OPTIONS, biome } }).options.biome, biome);
  }
  for (const weather of ['full', 'cosmetic', 'off']) {
    assert.equal(ok({ t: 'options', options: { ...DEFAULT_OPTIONS, weather } }).options.weather, weather);
  }
  bad({ t: 'options', options: { ...DEFAULT_OPTIONS, mapStyle: 'volcano' } }, /mapStyle/);
  bad({ t: 'options', options: { ...DEFAULT_OPTIONS, biome: 'swamp' } }, /biome/);
  bad({ t: 'options', options: { ...DEFAULT_OPTIONS, weather: true } }, /weather/);
  for (const key of ['mapStyle', 'biome', 'weather']) {
    const { [key]: _gone, ...without } = DEFAULT_OPTIONS;
    bad({ t: 'options', options: without }, new RegExp(key));
  }

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
  // Team chat (OpenRA OpenTeamChat): a flag, left out for all chat.
  assert.deepEqual(ok({ t: 'chat', text: 'go', team: true }), { t: 'chat', text: 'go', team: true });
  assert.deepEqual(ok({ t: 'chat', text: 'go', team: false }), { t: 'chat', text: 'go' });
  bad({ t: 'chat', text: 'go', team: 'yes' }, /true or false/);
  bad({ t: 'chat', text: 'go', to: 3 }, /unknown field/);
  assert.equal(encodeClient(client.chat('gg', true)), '{"t":"chat","text":"gg","team":true}');
  assert.equal(encodeClient(client.chat('gg')), '{"t":"chat","text":"gg"}');
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
    { o: 'pause_production', player: 1, ty: 3, paused: true },
    { o: 'pause_production', player: 1, ty: 3, paused: false },
    { o: 'place', player: 1, ty: 2, cx: 5, cy: 6 },
    { o: 'rally', player: 1, building: 4, x: 1, y: 1 },
    { o: 'sell', player: 1, building: 4 },
    { o: 'deploy', player: 1, ids: [4] },
    { o: 'land', player: 1, ids: [4], x: 100, y: 200 },
    { o: 'return_to_base', player: 1, ids: [4] },
    { o: 'support_power', player: 1, key: 'AirstrikePower@spyplane', x: 1024, y: 2048 },
    { o: 'support_power', player: 1, key: 'ParatroopersPower@paratroopers', x: 0, y: 0, x2: 4096, y2: 0 },
    { o: 'lay_mines', player: 1, ids: [4], x0: 3, y0: 4, x1: 6, y1: 4 },
    { o: 'teleport', player: 1, ids: [4], x: 1024, y: 2048 },
    { o: 'attack_ground', player: 1, ids: [4, 5], x: -10, y: 2048 },
    { o: 'guard', player: 1, ids: [4], target: 9 },
    { o: 'scatter', player: 1, ids: [4, 5, 6] },
    { o: 'waypoint', player: 1, ids: [4], x: 100, y: 200, attack_move: true },
    ...STANCES.map((stance) => ({ o: 'set_stance', player: 1, ids: [4], stance })),
    // Sidebar buttons (engine/src/repair.rs, beacons.rs).
    { o: 'repair_building', player: 1, building: 4 },
    { o: 'power_down', player: 1, building: 0xffffffff },
    { o: 'place_beacon', player: 1, x: -24, y: 2 ** 31 - 1 },
  ]) {
    assert.deepEqual(ok({ t: 'orders', tick: 1, orders: [o] }).orders[0], o);
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
  bad({ t: 'orders', tick: 3, orders: [{ o: 'support_power', player: 0, key: 'Nuke Power!', x: 0, y: 0 }] }, /power key/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'support_power', player: 0, key: 'x'.repeat(65), x: 0, y: 0 }] }, /power key/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'support_power', player: 0, key: 'GpsPower', x: 0, y: 0, x2: 0.5 }] });
  bad({ t: 'orders', tick: 3, orders: [{ o: 'start_production', player: 0, ty: 1, count: 51 }] });
  bad({ t: 'orders', tick: 3, orders: [{ o: 'lay_mines', player: 0, ids: [1], x0: 0, y0: 0, x1: 63, y1: 63 }] }, /minefield/);
  // Command bar orders (engine/src/commands.rs).
  bad({ t: 'orders', tick: 3, orders: [{ o: 'set_stance', player: 0, ids: [1], stance: 'aggressive' }] }, /unsupported value/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'set_stance', player: 0, ids: [1], stance: 3 }] }, /unsupported value/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'set_stance', player: 0, ids: [1] }] }, /required/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'waypoint', player: 0, ids: [1], x: 0, y: 0 }] }, /required/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'waypoint', player: 0, ids: [1], x: 0, y: 0, attack_move: 1 }] }, /true or false/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'guard', player: 0, ids: [1], target: -1 }] }, /integer/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'guard', player: 0, ids: [1], target: 2 ** 32 }] }, /integer/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'attack_ground', player: 0, ids: [1], x: 2 ** 31, y: 0 }] }, /integer/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'scatter', player: 0, ids: Array(2001).fill(1) }] }, /at most/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'scatter', player: 0, ids: [1], x: 0 }] }, /unknown field/);
  // Sidebar buttons.
  bad({ t: 'orders', tick: 3, orders: [{ o: 'repair_building', player: 0 }] }, /required/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'repair_building', player: 0, building: -1 }] }, /integer/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'power_down', player: 0, building: 1, ids: [1] }] }, /unknown field/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'power_down', player: 0, building: 1.5 }] });
  bad({ t: 'orders', tick: 3, orders: [{ o: 'place_beacon', player: 0, x: 0 }] }, /required/);
  bad({ t: 'orders', tick: 3, orders: [{ o: 'place_beacon', player: 0, x: 0, y: 2 ** 31 }] }, /integer/);
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
    { t: S2C.WELCOME, you: 1, name: 'Host', hostId: 1, session: SESSION, role: 'player', key: 'k'.repeat(43) },
    { t: S2C.WELCOME, you: 3, name: 'Watcher', hostId: 1, session: SESSION, role: 'spectator' },
    {
      t: S2C.LOBBY,
      hostId: 1,
      slots: [
        { type: 'human', client: 1, name: 'Host', account: true, faction: 'germany', color: 0, team: 0, ready: false, mapState: 'installed' },
        { type: 'ai', difficulty: 'easy', faction: 'random', color: 1, team: 2 },
        { type: 'open' },
        { type: 'closed' },
      ],
      options: { ...DEFAULT_OPTIONS },
      map: { id: '0123456789abcdef', hash: 'b'.repeat(64), name: 'Twin', modded: false, players: 4, author: 'Mapper', width: 64, height: 48, bytes: 4321, shared: true },
      spectators: [
        { client: 5, name: 'Watcher', mapState: 'declined' },
        { client: 6, name: 'Signed In', account: true, mapState: 'missing' },
      ],
      maxSpectators: 2,
    },
    { t: S2C.CHAT, from: 1, name: 'Host', text: 'gl hf' },
    { t: S2C.CHAT, from: null, name: 'Server', text: 'Host left' },
    { t: S2C.CHAT, from: 2, name: 'Guest', text: 'rush left', team: true },
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
    { t: S2C.LEFT, player: null, client: 5, name: 'Watcher', reason: 'expired' },
    { t: S2C.LOG, frames: [[4, [[0, [{ o: 'stop', player: 0, ids: [4] }]]]], [90, [[1, []]]]] },
    { t: S2C.SYNC, tick: 120, check: { tick: 100, hash: '00ff00ff00ff00ff' } },
    { t: S2C.SYNC, tick: 3, check: null },
    { t: S2C.BACK, player: 1, client: 2, name: 'Guest', tick: 140 },
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

test('cheat orders: strict shapes, recognised as cheats', () => {
  const cheats = [
    ...DEV_FLAGS.map((flag) => ({ o: 'dev_flag', player: 0, flag, on: true })),
    { o: 'dev_cash', player: 1 },
    { o: 'dev_kill', player: 0, ids: [1, 4194305] },
    { o: 'dev_experience', player: 1, ids: [7] },
  ];
  for (const o of cheats) {
    assert.deepEqual(ok({ t: 'orders', tick: 4, orders: [o] }).orders[0], o);
    assert.equal(isCheatOrder(o), true, o.o);
  }
  assert.deepEqual(CHEAT_ORDER_KINDS, ['dev_flag', 'dev_cash', 'dev_kill', 'dev_experience']);
  assert.ok(CHEAT_ORDER_KINDS.every((k) => ORDER_KINDS.includes(k)));
  for (const k of ORDER_KINDS) assert.equal(isCheatOrder({ o: k }), CHEAT_ORDER_KINDS.includes(k), k);
  assert.equal(isCheatOrder(null), false);
  bad({ t: 'orders', tick: 4, orders: [{ o: 'dev_flag', player: 0, flag: 'god_mode', on: true }] }, /flag/);
  bad({ t: 'orders', tick: 4, orders: [{ o: 'dev_flag', player: 0, flag: 'fast_build', on: 'yes' }] }, /on/);
  bad({ t: 'orders', tick: 4, orders: [{ o: 'dev_flag', player: 0, flag: 'fast_build' }] }, /required/);
  bad({ t: 'orders', tick: 4, orders: [{ o: 'dev_cash', player: 0, amount: 1e6 }] }, /unknown field/);
  bad({ t: 'orders', tick: 4, orders: [{ o: 'dev_kill', player: 0, ids: Array.from({ length: 2001 }, () => 1) }] });
  bad({ t: 'orders', tick: 4, orders: [{ o: 'dev_experience', player: 0, ids: Array.from({ length: 2001 }, () => 1) }] });
  bad({ t: 'orders', tick: 4, orders: [{ o: 'dev_experience', player: 0, ids: [1], levels: 4 }] }, /unknown field/);
  bad({ t: 'orders', tick: 4, orders: [{ o: 'dev_experience', player: 0 }] }, /required/);
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

test('protocol 3: rejoin, spectators and resume messages are strict', () => {
  const hello = { t: 'hello', protocol: PROTOCOL_VERSION, version: '0.3.0', name: 'Tanya' };
  // Version 4 added the map style, biome and weather lobby options on top;
  // version 5 accounts (optional hello name, welcome name, account marks);
  // version 6 map sharing (map details, map states) and rematches.
  assert.equal(PROTOCOL_VERSION, 6);
  assert.deepEqual(ok({ ...hello, spectate: true }), { ...hello, spectate: true });
  assert.deepEqual(ok({ ...hello, spectate: false }), hello, 'spectate: false is the default and dropped');
  bad({ ...hello, spectate: 'yes' }, /spectate/);
  const rejoin = { client: 7, key: 'K'.repeat(43) };
  assert.deepEqual(ok({ ...hello, rejoin }), { ...hello, rejoin });
  bad({ ...hello, rejoin: { ...rejoin, key: 'short' } }, /rejoin.key/);
  bad({ ...hello, rejoin: { ...rejoin, client: 0 } }, /rejoin.client/);
  bad({ ...hello, rejoin: { ...rejoin, seat: 1 } }, /unknown field/);
  bad({ ...hello, rejoin, hostKey: HOST_KEY }, /cannot be combined/);
  bad({ ...hello, rejoin, spectate: true }, /cannot be combined/);
  assert.deepEqual(ok({ t: 'spectators', max: 0 }), { t: 'spectators', max: 0 });
  ok({ t: 'spectators', max: 8 });
  bad({ t: 'spectators', max: 9 });
  bad({ t: 'spectators', max: 2, extra: 1 }, /unknown field/);
  assert.deepEqual(ok({ t: 'spectate', on: true }), { t: 'spectate', on: true });
  bad({ t: 'spectate' });
  bad({ t: 'spectate', on: 1 });
  assert.deepEqual(ok({ t: 'resume' }), { t: 'resume' });
  bad({ t: 'resume', tick: 5 }, /unknown field/);
  assert.deepEqual(ok({ t: 'synced' }), { t: 'synced' });
  bad({ t: 'synced', tick: 5 }, /unknown field/);
  assert.deepEqual(ok({ t: 'defeated' }), { t: 'defeated' });
  bad({ t: 'defeated', player: 1 }, /unknown field/);
});

test('server messages for rejoin and spectators reject inconsistent data', () => {
  const p = (m) => parseServerMessage(JSON.stringify(m));
  const lobby = {
    t: 'lobby',
    hostId: 1,
    slots: [{ type: 'human', client: 1, name: 'Host', faction: 'germany', color: 0, team: 0, ready: false }, { type: 'open' }],
    options: DEFAULT_OPTIONS,
    map: null,
    spectators: [],
    maxSpectators: 2,
  };
  assert.equal(p(lobby).ok, true);
  assert.equal(p({ ...lobby, spectators: [{ client: 2, name: 'A' }, { client: 3, name: 'B' }, { client: 4, name: 'C' }] }).ok, false, 'over the limit');
  assert.equal(p({ ...lobby, spectators: [{ client: 2, name: 'A' }, { client: 2, name: 'B' }] }).ok, false, 'twice');
  assert.equal(p({ ...lobby, spectators: [{ client: 1, name: 'Host' }] }).ok, false, 'spectator holding a slot');
  assert.equal(p({ ...lobby, maxSpectators: 9 }).ok, false);
  const { spectators: _s, ...old } = lobby;
  assert.equal(p(old).ok, false, 'protocol 2 lobby messages are refused');
  assert.equal(p({ t: 'welcome', you: 1, name: 'Host', hostId: 1, session: SESSION, role: 'admin' }).ok, false);
  assert.equal(p({ t: 'welcome', you: 1, name: 'Host', hostId: 1, session: SESSION, role: 'player', key: 'x' }).ok, false);
  assert.equal(p({ t: 'welcome', you: 1, hostId: 1, session: SESSION, role: 'player' }).ok, false, 'protocol 5 welcome carries the name');
  assert.equal(p({ t: 'log', frames: [] }).ok, false, 'empty log message');
  assert.equal(p({ t: 'log', frames: [[5, []], [5, []]] }).ok, false, 'ticks must increase');
  assert.equal(p({ t: 'log', frames: [[5, [[0, [{ o: 'nuke', player: 0 }]]]]] }).ok, false, 'orders are validated');
  assert.equal(p({ t: 'sync', tick: 100, check: { tick: 100, hash: 'aa' } }).ok, false, 'check before the sync tick');
  assert.equal(p({ t: 'sync', tick: 100, check: { tick: 30, hash: 'aa' } }).ok, false, 'check on a hash tick');
  assert.equal(p({ t: 'back', player: 8, client: 2, name: 'G', tick: 3 }).ok, false);
  assert.equal(p({ t: 'left', player: 1, client: 2, name: 'G', reason: 'banned' }).ok, false);
});

test('protocol 5: accounts in hello, welcome and the lobby', () => {
  const base = { t: 'hello', protocol: PROTOCOL_VERSION, version: '0.3.0' };
  assert.deepEqual(ok(base), base, 'a signed-in connection may leave the name out');
  assert.equal(ok({ ...base, name: ' Tanya ' }).name, 'Tanya');
  bad({ ...base, name: '' }, /empty/);
  const p = (m) => parseServerMessage(JSON.stringify(m));
  const slot = { type: 'human', client: 1, name: 'Host', faction: 'germany', color: 0, team: 0, ready: false };
  const lobby = { t: 'lobby', hostId: 1, slots: [slot, { type: 'open' }], options: DEFAULT_OPTIONS, map: null, spectators: [], maxSpectators: 2 };
  assert.equal(p({ ...lobby, slots: [{ ...slot, account: true }, { type: 'open' }] }).msg.slots[0].account, true);
  assert.equal('account' in p({ ...lobby, slots: [{ ...slot, account: false }, { type: 'open' }] }).msg.slots[0], false, 'false is dropped');
  assert.equal(p({ ...lobby, slots: [{ ...slot, account: 'yes' }, { type: 'open' }] }).ok, false);
  assert.equal(p({ ...lobby, slots: [slot, { type: 'ai', difficulty: 'easy', faction: 'random', color: 1, team: 0, account: true }] }).ok, false, 'AI slots have no account');
  assert.equal(p({ ...lobby, slots: [slot, { type: 'open', account: true }] }).ok, false);
  assert.equal(p({ ...lobby, spectators: [{ client: 2, name: 'W', account: true }] }).msg.spectators[0].account, true);
  for (const code of ['account_required', 'account_inactive', 'banned', 'ip_banned']) {
    assert.equal(p({ t: 'error', code, message: 'no' }).ok, true);
  }
});

// ---- Protocol 6: map sharing and rematches -----------------------------------------------------

const MAP_INFO = { id: '0123456789abcdef', hash: 'c'.repeat(64), name: 'Lake', modded: false, players: 2, author: 'Me', width: 64, height: 64, bytes: 900, shared: true };
const LOBBY6 = (patch = {}) => ({
  t: 'lobby',
  hostId: 1,
  slots: [
    { type: 'human', client: 1, name: 'Host', faction: 'random', color: 0, team: 0, ready: false, mapState: 'installed' },
    { type: 'human', client: 2, name: 'Guest', faction: 'random', color: 1, team: 0, ready: false, mapState: 'missing' },
  ],
  options: { ...DEFAULT_OPTIONS },
  map: MAP_INFO,
  spectators: [{ client: 3, name: 'Eye', mapState: 'declined' }],
  maxSpectators: 2,
  ...patch,
});

test('protocol 6: lobby maps carry their details and every member a map state', () => {
  const p = (m) => parseServerMessage(JSON.stringify(m));
  assert.ok(p(LOBBY6()).ok, p(LOBBY6()).message);
  assert.deepEqual(p(LOBBY6()).msg.map, MAP_INFO);
  // A map's details are all required, with sane bounds.
  for (const k of ['author', 'width', 'height', 'bytes', 'shared', 'players']) {
    const map = { ...MAP_INFO };
    delete map[k];
    assert.equal(p(LOBBY6({ map })).ok, false, `without ${k}`);
  }
  assert.equal(p(LOBBY6({ map: { ...MAP_INFO, bytes: 2 * 1024 * 1024 } })).ok, false, 'larger than a map file can be');
  assert.equal(p(LOBBY6({ map: { ...MAP_INFO, width: 8 } })).ok, false);
  assert.equal(p(LOBBY6({ map: { ...MAP_INFO, author: 'a‮b' } })).ok, false, 'no bidi tricks in the author');
  assert.equal(p(LOBBY6({ map: { ...MAP_INFO, url: 'https://evil.example/map' } })).ok, false, 'no other fields (no URLs)');
  // Map states: on every member with a map, on none without one, never on AI slots.
  const noState = LOBBY6();
  delete noState.spectators[0].mapState;
  assert.equal(p(noState).ok, false, 'a member without a state while there is a map');
  const generated = LOBBY6({ map: null });
  assert.equal(p(generated).ok, false, 'states without a map');
  for (const sl of generated.slots) delete sl.mapState;
  for (const sp of generated.spectators) delete sp.mapState;
  assert.ok(p(generated).ok, p(generated).message);
  const ai = LOBBY6();
  ai.slots[1] = { type: 'ai', difficulty: 'easy', faction: 'random', color: 1, team: 0, mapState: 'installed' };
  assert.equal(p(ai).ok, false);
  const odd = LOBBY6();
  odd.slots[1].mapState = 'downloading';
  assert.equal(p(odd).ok, false);
  // The start message describes its map the same way.
  const start = {
    t: 'start',
    seed: OPTIONS.seed,
    options: OPTIONS,
    map: MAP_INFO,
    delay: 3,
    players: [
      { player: 0, slot: 0, client: 1, name: 'Host', type: 'human' },
      { player: 1, slot: 2, client: null, name: 'Computer', type: 'ai' },
    ],
  };
  assert.ok(p(start).ok, p(start).message);
  assert.equal(p({ ...start, map: { id: MAP_INFO.id, hash: MAP_INFO.hash, name: 'Lake', modded: false, players: 2 } }).ok, false, 'protocol 5 map refs are refused');
});

test('protocol 6: the host names community maps with the request fields only', () => {
  const ref = { id: MAP_INFO.id, hash: MAP_INFO.hash, name: 'Lake', modded: false };
  assert.deepEqual(ok({ t: 'map', map: ref }), { t: 'map', map: ref });
  bad({ t: 'map', map: { ...ref, shared: true } }, /unknown field/);
  bad({ t: 'map', map: { ...ref, author: 'x' } }, /unknown field/);
});

test('protocol 6: mapstate, kick and rematch client messages are strict', () => {
  const hash = 'd'.repeat(64);
  assert.deepEqual(ok({ t: 'mapstate', hash, state: 'installed' }), { t: 'mapstate', hash, state: 'installed' });
  assert.deepEqual(ok({ t: 'mapstate', hash, state: 'declined' }), { t: 'mapstate', hash, state: 'declined' });
  bad({ t: 'mapstate', hash, state: 'missing' }, /unsupported/);
  bad({ t: 'mapstate', hash: 'D'.repeat(64), state: 'installed' }, /hash/);
  bad({ t: 'mapstate', state: 'installed' }, /hash/);
  bad({ t: 'mapstate', hash, state: 'installed', url: '/x' }, /unknown field/);
  assert.deepEqual(ok({ t: 'kick', client: 4 }), { t: 'kick', client: 4 });
  bad({ t: 'kick', client: 0 });
  bad({ t: 'kick', client: '4' });
  assert.deepEqual(ok({ t: 'rematch', accept: true }), { t: 'rematch', accept: true });
  assert.deepEqual(ok({ t: 'rematch', accept: false }), { t: 'rematch', accept: false });
  bad({ t: 'rematch' }, /accept/);
  bad({ t: 'rematch', accept: 'yes' }, /accept/);
  bad({ t: 'rematch', accept: true, options: {} }, /unknown field/);
});

test('protocol 6: rematch server messages are strict', () => {
  const p = (m) => parseServerMessage(JSON.stringify(m));
  const open = { t: 'rematch', state: 'open', by: 1, accepted: [1], waiting: [2, 3], msLeft: 90_000 };
  assert.deepEqual(p(open).msg, open);
  const cancelled = { t: 'rematch', state: 'cancelled', by: null, accepted: [], waiting: [], reason: 'declined' };
  assert.deepEqual(p(cancelled).msg, cancelled);
  const lobby = { t: 'rematch', state: 'lobby', by: 1, accepted: [1, 2], waiting: [] };
  assert.deepEqual(p(lobby).msg, lobby);
  assert.equal(p({ ...open, msLeft: undefined }).ok, false, 'an open proposal says how long it runs');
  assert.equal(p({ ...lobby, msLeft: 5 }).ok, false);
  assert.equal(p({ ...cancelled, reason: 'bored' }).ok, false);
  assert.equal(p({ ...open, reason: 'declined' }).ok, false);
  assert.equal(p({ ...open, accepted: [1, 1] }).ok, false);
  assert.equal(p({ ...open, waiting: [1] }).ok, false, 'accepted and waiting at once');
  assert.equal(p({ ...open, accepted: [1, 2, 3, 4, 5, 6, 7, 8, 9] }).ok, false);
  assert.equal(p({ ...open, state: 'maybe' }).ok, false);
});

test('protocol 6: the member credential header format', () => {
  assert.equal(MEMBER_HEADER, 'X-WebRA-Member');
  assert.ok(MEMBER_RE.test(`12.${'A'.repeat(43)}`));
  for (const v of [`0.${'A'.repeat(43)}`, `12.${'A'.repeat(42)}`, `12:${'A'.repeat(43)}`, `-1.${'A'.repeat(43)}`, `12.${'A'.repeat(43)} `, `12345678901.${'A'.repeat(43)}`]) {
    assert.equal(MEMBER_RE.test(v), false, v);
  }
  assert.deepEqual(MAP_STATES, ['installed', 'missing', 'declined']);
});

test('protocol 6: save messages, resumed starts and resume lobbies are strict', () => {
  assert.deepEqual(ok({ t: 'save', accept: true }), { t: 'save', accept: true });
  bad({ t: 'save' }, /accept/);
  bad({ t: 'save', accept: true, tick: 50 }, /unknown field/);
  const p = (m) => parseServerMessage(JSON.stringify(m));
  const open = { t: 'save', state: 'open', by: 2, accepted: [2], waiting: [1], msLeft: 30000 };
  assert.deepEqual(p(open).msg, open);
  assert.equal(p({ ...open, tick: 50 }).ok, false);
  assert.deepEqual(p({ t: 'save', state: 'agreed', tick: 75 }).msg, { t: 'save', state: 'agreed', tick: 75 });
  assert.equal(p({ t: 'save', state: 'agreed', tick: 74 }).ok, false, 'a hash tick');
  const saved = { t: 'save', state: 'saved', id: '0123456789abcdef', ticks: 76, hash: 'abcd' };
  assert.deepEqual(p(saved).msg, saved);
  assert.equal(p({ ...saved, ticks: 75 }).ok, false);
  assert.equal(p({ ...saved, id: 'x' }).ok, false);
  assert.deepEqual(p({ t: 'save', state: 'cancelled', reason: 'desync' }).msg, { t: 'save', state: 'cancelled', reason: 'desync' });
  assert.equal(p({ t: 'save', state: 'cancelled', reason: 'bored' }).ok, false);
  // A resumed start says where the game goes on.
  const start = {
    t: 'start',
    seed: OPTIONS.seed,
    options: OPTIONS,
    map: null,
    delay: 3,
    players: [
      { player: 0, slot: 0, client: 1, name: 'Host', type: 'human' },
      { player: 1, slot: 2, client: null, name: 'Computer', type: 'ai' },
    ],
  };
  assert.deepEqual(p({ ...start, resume: { ticks: 501, hash: 'ab' } }).msg.resume, { ticks: 501, hash: 'ab' });
  assert.equal(p({ ...start, resume: { ticks: 500, hash: 'ab' } }).ok, false);
  assert.equal(p({ ...start, resume: { ticks: 501 } }).ok, false);
  // A lobby that resumes a save.
  const lobby = {
    t: 'lobby',
    hostId: 1,
    slots: [{ type: 'human', client: 1, name: 'Host', faction: 'germany', color: 0, team: 0, ready: false }, { type: 'open' }],
    options: { ...DEFAULT_OPTIONS },
    map: null,
    spectators: [],
    maxSpectators: 2,
    resume: { id: '0123456789abcdef', title: 'Friday', createdAt: 5, ticks: 501, waiting: ['Guest'] },
  };
  assert.deepEqual(p(lobby).msg.resume, lobby.resume);
  assert.equal(p({ ...lobby, resume: { ...lobby.resume, waiting: ['a‮b'] } }).ok, false);
  assert.equal(p({ ...lobby, resume: { ...lobby.resume, frames: [] } }).ok, false);
});
