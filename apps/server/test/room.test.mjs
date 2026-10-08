import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, encodeServer, parseServerMessage } from '@webra/protocol';
import { Room, RoomError } from '../src/room.js';

const first = () => 0;
const throwsRoom = (fn, code) =>
  assert.throws(fn, (err) => err instanceof RoomError && (code === undefined || err.code === code), code);

function lobby(max = 4) {
  const room = Room.create({ maxPlayers: max, seed: 7 });
  const host = room.join('Host', { host: true }).client;
  const guest = room.join('Guest').client;
  return { room, host, guest };
}

test('players join open slots with unique colours; full rooms refuse', () => {
  const room = Room.create({ maxPlayers: 2 });
  const a = room.join('A', { host: true });
  const b = room.join('B');
  assert.deepEqual([a.slot, b.slot], [0, 1]);
  assert.equal(room.hostId, a.client);
  assert.notEqual(room.slots[0].color, room.slots[1].color);
  throwsRoom(() => room.join('C'), 'full');
});

test('the host leaving passes the host role to the next human', () => {
  const { room, host, guest } = lobby();
  assert.equal(room.leave(host), guest);
  assert.equal(room.hostId, guest);
  assert.equal(room.slots[0].type, 'open');
  assert.equal(room.nameOf(host), 'Host', 'names stay known for left messages');
});

test('players edit only their own slot; colours stay unique', () => {
  const { room, host, guest } = lobby();
  room.setSlot(guest, { slot: 1, faction: 'russia', team: 2 });
  assert.equal(room.slots[1].faction, 'russia');
  throwsRoom(() => room.setSlot(guest, { slot: 0, faction: 'france' }), 'forbidden');
  throwsRoom(() => room.setSlot(guest, { slot: 1, color: room.slots[0].color }));
  throwsRoom(() => room.setSlot(guest, { slot: 1, difficulty: 'hard' }));
  throwsRoom(() => room.setSlot(guest, { slot: 2, type: 'ai' }), 'not_host');
  throwsRoom(() => room.setSlot(guest, { slot: 9 }));
  // Moving into an open slot keeps the player's settings.
  room.setSlot(guest, { slot: 3 });
  assert.equal(room.slots[3].client, guest);
  assert.equal(room.slots[3].faction, 'russia');
  assert.equal(room.slots[1].type, 'open');
  // Unknown client.
  throwsRoom(() => room.setSlot(999, { slot: 2 }), 'bad_state');
  void host;
});

test('host manages AI and empty slots, kicking a human in the way', () => {
  const { room, host, guest } = lobby();
  room.setSlot(host, { slot: 2, type: 'ai', difficulty: 'hard', faction: 'ukraine' });
  assert.equal(room.slots[2].type, 'ai');
  assert.equal(room.slots[2].difficulty, 'hard');
  room.setSlot(host, { slot: 2, difficulty: 'easy', team: 1 });
  assert.equal(room.slots[2].difficulty, 'easy');
  room.setSlot(host, { slot: 3, type: 'closed' });
  throwsRoom(() => room.setSlot(host, { slot: 3, type: 'open', faction: 'france' }));
  throwsRoom(() => room.setSlot(host, { slot: 0, type: 'ai' }));
  const { kicked } = room.setSlot(host, { slot: 1, type: 'open' });
  assert.equal(kicked, guest);
  assert.equal(room.slotOf(guest), -1);
});

test('ready needs the lobby map hash; host changes reset ready', () => {
  const { room, host, guest } = lobby();
  room.setReady(guest, true, null);
  assert.equal(room.slots[1].ready, true);
  room.setOptions(host, { ...DEFAULT_OPTIONS, startingCash: 10000 });
  assert.equal(room.slots[1].ready, false);
  throwsRoom(() => room.setOptions(guest, { ...DEFAULT_OPTIONS }), 'not_host');
  const map = { id: '0123456789abcdef', hash: 'a'.repeat(64), name: 'Twin', modded: false, players: 2 };
  room.setMap(host, map);
  throwsRoom(() => room.setReady(guest, true, null), 'not_ready');
  throwsRoom(() => room.setReady(guest, true, 'b'.repeat(64)), 'not_ready');
  room.setReady(guest, true, map.hash);
  assert.equal(room.slots[1].ready, true);
  // A player's own change only resets their own flag.
  room.setReady(host, true, map.hash);
  room.setSlot(guest, { slot: 1, faction: 'france' });
  assert.equal(room.slots[1].ready, false);
  assert.equal(room.slots[0].ready, true);
});

test('start rules: host only, all ready, enough players and sides, map capacity', () => {
  const { room, host, guest } = lobby(4);
  assert.match(room.startProblem(host), /ready/);
  room.setReady(guest, true, null);
  assert.equal(room.startProblem(guest), 'Only the host can start the game.');
  throwsRoom(() => room.start(guest, first), 'not_host');
  room.setSlot(host, { slot: 0, team: 1 });
  room.setSlot(guest, { slot: 1, team: 1 });
  room.setReady(guest, true, null);
  assert.match(room.startProblem(host), /opposing/);
  room.setSlot(host, { slot: 2, type: 'ai' });
  room.setSlot(host, { slot: 3, type: 'ai' });
  room.setReady(guest, true, null);
  room.setMap(host, { id: '0123456789abcdef', hash: 'a'.repeat(64), name: 'Duel', modded: false, players: 2 });
  room.setReady(guest, true, 'a'.repeat(64));
  assert.match(room.startProblem(host), /room for 2/);
  room.setMap(host, null);
  room.setReady(guest, true, null);
  assert.equal(room.startProblem(host), null);
});

test('start resolves random factions, assigns seats and produces a valid start message', () => {
  const { room, host, guest } = lobby(4);
  room.setSlot(host, { slot: 2, type: 'closed' });
  room.setSlot(host, { slot: 3, type: 'ai', faction: 'randomsoviet', difficulty: 'hard' });
  room.setSlot(guest, { slot: 1, faction: 'england' });
  room.setReady(guest, true, null);
  const start = room.start(host, first);
  assert.equal(room.phase, 'game');
  assert.deepEqual(room.seats, [host, guest, null]);
  assert.equal(start.options.players.length, 3);
  assert.equal(start.options.players[0].faction, 'england', 'random resolved by pick()');
  assert.equal(start.options.players[1].faction, 'england');
  assert.equal(start.options.players[2].faction, 'russia');
  assert.deepEqual(
    start.players.map((p) => [p.player, p.slot, p.client, p.type]),
    [
      [0, 0, host, 'human'],
      [1, 1, guest, 'human'],
      [2, 3, null, 'ai'],
    ],
  );
  assert.equal(room.seatOf(guest), 1);
  const r = parseServerMessage(encodeServer({ t: 'start', ...start }));
  assert.ok(r.ok, r.message);
  throwsRoom(() => room.join('Late'), 'bad_state');
  throwsRoom(() => room.setSlot(host, { slot: 0, team: 1 }), 'bad_state');
});

test('lobby view encodes as a valid lobby message and survives a storage round trip', () => {
  const { room, host } = lobby(3);
  room.setSlot(host, { slot: 2, type: 'ai' });
  const copy = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.deepEqual(copy.lobbyView(), room.lobbyView());
  assert.ok(parseServerMessage(encodeServer({ t: 'lobby', ...copy.lobbyView() })).ok);
});

test('the name table stays bounded', () => {
  const room = Room.create({ maxPlayers: 2 });
  room.join('Host', { host: true });
  for (let i = 0; i < 300; i++) {
    const { client } = room.join(`P${i}`);
    room.leave(client);
  }
  assert.ok(Object.keys(room.names).length <= 65);
});

test('the debug menu option: host only, carried into the start options, off for old rooms', () => {
  const { room, host, guest } = lobby(2);
  assert.equal(room.options.cheats, false, 'off by default');
  throwsRoom(() => room.setOptions(guest, { ...room.options, cheats: true }), 'not_host');
  room.setOptions(host, { ...room.options, cheats: true });
  assert.equal(room.lobbyView().options.cheats, true, 'every player sees it in the lobby');
  room.setReady(guest, true, null);
  const start = room.start(host, first);
  assert.equal(start.options.cheats, true, 'the agreed game options carry it');
  assert.ok(parseServerMessage(encodeServer({ t: 'start', ...start })).ok);

  // A room stored before the option existed reads back with cheats off.
  const { cheats: _c, ...old } = DEFAULT_OPTIONS;
  const stored = { ...lobby(2).room.toJSON(), options: { ...old, seed: 3 } };
  const back = Room.fromJSON(stored);
  assert.equal(back.options.cheats, false);
  assert.equal(back.options.seed, 3);
  assert.ok(parseServerMessage(encodeServer({ t: 'lobby', ...back.lobbyView() })).ok);
});

test('spectators: places set by the host, switching in the lobby, joining a running game', () => {
  const { room, host, guest } = lobby(3);
  assert.equal(room.maxSpectators, 2);
  const w = room.join('Watcher', { spectate: true });
  assert.deepEqual([w.slot, w.role], [-1, 'spectator']);
  assert.equal(room.isSpectator(w.client), true);
  throwsRoom(() => room.setMaxSpectators(guest, 4), 'not_host');
  throwsRoom(() => room.setMaxSpectators(host, 0));
  room.setMaxSpectators(host, 1);
  throwsRoom(() => room.join('Second', { spectate: true }), 'full');
  // A player moves to the spectators only while a place is free.
  throwsRoom(() => room.spectate(guest, true), 'full');
  room.spectate(w.client, false);
  assert.equal(room.slots[2].client, w.client);
  room.spectate(guest, true);
  assert.equal(room.slots[1].type, 'open');
  assert.equal(room.memberCount(), 3);
  // A spectating host keeps the host role and can start.
  room.setMaxSpectators(host, 2);
  room.spectate(host, true);
  assert.equal(room.isHost(host), true);
  room.setSlot(host, { slot: 1, type: 'ai' });
  room.setReady(w.client, true, null);
  const start = room.start(host, () => 0);
  assert.equal(start.players.length, 2, 'spectators do not play');
  // In game: spectators join (while places are free); players cannot.
  throwsRoom(() => room.join('Late'), 'bad_state');
  throwsRoom(() => room.join('Late', { spectate: true }), 'full');
  room.leave(guest);
  assert.equal(room.join('Late', { spectate: true }).role, 'spectator');
  const view = room.lobbyView();
  assert.equal(parseServerMessage(encodeServer({ t: 'lobby', ...view })).ok, true);
});

test('seat lifecycle: away, rejoin, resume, expiry and the rejoin cap', () => {
  const { room, host, guest } = lobby(2);
  room.setKey(host, 'a'.repeat(64));
  room.setKey(guest, 'b'.repeat(64));
  room.setReady(guest, true, null);
  room.start(host, first);
  const g = room.seatOf(guest);
  assert.deepEqual(room.liveSeats(), [0, 1]);
  throwsRoom(() => room.beginRejoin(guest, 0, 1000), 'bad_state');
  const record = { frame: 3, heldMs: 0, debtMs: 4000, drainedAt: 0 };
  assert.equal(room.suspendSeat(g, record, 1000, 5000), true);
  assert.equal(room.seatState(g), 'away');
  assert.deepEqual(room.expiredSeats(5999), []);
  assert.deepEqual(room.expiredSeats(6000), [g]);
  assert.equal(room.beginRejoin(guest, 2000, 3000), g);
  assert.equal(room.seatState(g), 'syncing');
  throwsRoom(() => room.beginRejoin(guest, 2000, 3000), 'bad_state');
  assert.deepEqual(room.expiredSeats(5000), [g], 'syncing has its own deadline');
  // Losing the connection while syncing keeps that deadline.
  room.suspendSeat(g, null, 4000, 60_000);
  assert.equal(room.seatStates[g].until, 5000);
  room.beginRejoin(guest, 4500, 3000);
  assert.deepEqual(room.resumeSeat(g), record);
  assert.equal(room.seatState(g), 'active');
  throwsRoom(() => room.resumeSeat(g), 'bad_state');
  // The cap.
  for (let i = 0; i < 20 && (room.rejoins[guest] ?? 0) < 10; i++) {
    room.suspendSeat(g, null, 0, 1000);
    room.beginRejoin(guest, 0, 1000);
    room.resumeSeat(g);
  }
  room.suspendSeat(g, null, 0, 1000);
  throwsRoom(() => room.beginRejoin(guest, 0, 1000), 'forbidden');
  room.endSeat(g);
  assert.equal(room.seatState(g), 'gone');
  assert.deepEqual(room.liveSeats(), [room.seatOf(host)]);
  // Rejoin state survives storage.
  const back = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())));
  assert.equal(back.seatState(g), 'gone');
  assert.deepEqual(back.startMsg, room.startMsg);
  // Old rooms without the new fields read back with defaults.
  const { spectators: _a, maxSpectators: _b, keys: _c, rejoins: _d, startMsg: _e, seatStates: _f, ...old } = room.toJSON();
  const legacy = Room.fromJSON(old);
  assert.deepEqual([legacy.spectators, legacy.maxSpectators, legacy.keys, legacy.seatStates], [[], 2, {}, null]);
});

test('leaving a lobby or being kicked forgets the rejoin key', () => {
  const { room, host, guest } = lobby();
  room.setKey(guest, 'b'.repeat(64));
  room.leave(guest);
  assert.equal(Object.hasOwn(room.keys, guest), false);
  void host;
});
