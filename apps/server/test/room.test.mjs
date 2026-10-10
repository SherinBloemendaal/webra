import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_MODES, DEFAULT_OPTIONS, encodeServer, parseClientMessage, parseServerMessage } from '@webra/protocol';
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

test('map style, biome and weather: host only, carried into the start options, defaults for old rooms', () => {
  const { room, host, guest } = lobby(2);
  assert.deepEqual([room.options.mapStyle, room.options.biome, room.options.weather], ['random', 'random', 'full']);
  const pick = { mapStyle: 'islands', biome: 'snow', weather: 'cosmetic' };
  throwsRoom(() => room.setOptions(guest, { ...room.options, ...pick }), 'not_host');
  room.setOptions(host, { ...room.options, ...pick });
  assert.equal(room.lobbyView().options.biome, 'snow', 'every player sees it in the lobby');
  room.setReady(guest, true, null);
  const start = room.start(host, first);
  assert.deepEqual([start.options.mapStyle, start.options.biome, start.options.weather], ['islands', 'snow', 'cosmetic'], 'all peers agree on them');
  assert.ok(parseServerMessage(encodeServer({ t: 'start', ...start })).ok);

  // A room stored before the options existed reads back with the defaults.
  const { mapStyle: _s, biome: _b, weather: _w, ...old } = DEFAULT_OPTIONS;
  const back = Room.fromJSON({ ...lobby(2).room.toJSON(), options: { ...old, seed: 4 } });
  assert.deepEqual([back.options.mapStyle, back.options.biome, back.options.weather], ['random', 'random', 'full']);
  assert.ok(parseServerMessage(encodeServer({ t: 'lobby', ...back.lobbyView() })).ok);
});

test("OpenRA's other lobby options and handicaps: carried into the start options, defaults for old rooms", () => {
  const { room, host, guest } = lobby(3);
  const pick = { crates: false, shortGame: false, bounty: true, separateTeamSpawns: false, allyBuildRadius: false, timeLimit: 40 };
  throwsRoom(() => room.setOptions(guest, { ...room.options, ...pick }), 'not_host');
  room.setOptions(host, { ...room.options, ...pick });
  // Each player sets its own handicap, the host an AI's; empty slots have none.
  room.setSlot(guest, { slot: 1, handicap: 25 });
  throwsRoom(() => room.setSlot(guest, { slot: 0, handicap: 10 }), 'forbidden');
  room.setSlot(host, { slot: 2, type: 'ai', difficulty: 'easy', handicap: 50 });
  room.setSlot(host, { slot: 2, handicap: 45 });
  throwsRoom(() => room.setSlot(host, { slot: 2, type: 'closed', handicap: 5 }));
  const view = room.lobbyView();
  assert.deepEqual(view.slots.map((s) => s.handicap), [0, 25, 45]);
  assert.ok(parseServerMessage(encodeServer({ t: 'lobby', ...view })).ok);
  room.setReady(guest, true, null);
  const start = room.start(host, first);
  for (const [k, v] of Object.entries(pick)) assert.equal(start.options[k], v, k);
  assert.deepEqual(start.options.players.map((p) => p.handicap), [0, 25, 45]);
  assert.ok(parseServerMessage(encodeServer({ t: 'start', ...start })).ok);

  // A room stored before the options existed reads back with OpenRA's defaults.
  const old = { ...DEFAULT_OPTIONS };
  for (const k of Object.keys(pick)) delete old[k];
  const back = Room.fromJSON({ ...lobby(2).room.toJSON(), options: { ...old, seed: 5 } });
  assert.deepEqual(
    Object.keys(pick).map((k) => back.options[k]),
    [true, true, false, true, true, 0],
  );
  assert.ok(parseServerMessage(encodeServer({ t: 'lobby', ...back.lobbyView() })).ok);
});

test("bot types: the host picks an AI's OpenRA bot, it names the AI and reaches the engine; old rooms play the Normal AI", () => {
  const { room, host, guest } = lobby(4);
  room.setSlot(host, { slot: 2, type: 'ai', bot: 'turtle', difficulty: 'hard' });
  room.setSlot(host, { slot: 3, type: 'ai' });
  assert.equal(room.slots[2].bot, 'turtle');
  assert.equal(room.slots[3].bot, 'normal', 'a new AI slot plays the Normal AI');
  room.setSlot(host, { slot: 3, bot: 'naval' });
  throwsRoom(() => room.setSlot(guest, { slot: 1, bot: 'rush' }));
  throwsRoom(() => room.setSlot(guest, { slot: 3, bot: 'rush' }), 'forbidden');
  throwsRoom(() => room.setSlot(host, { slot: 1, type: 'open', bot: 'rush' }));
  const view = room.lobbyView();
  assert.deepEqual(view.slots.map((s) => s.bot), [undefined, undefined, 'turtle', 'naval']);
  assert.ok(parseServerMessage(encodeServer({ t: 'lobby', ...view })).ok);
  room.setReady(guest, true, null);
  const start = room.start(host, first);
  assert.deepEqual(start.options.players.map((p) => [p.bot, p.name]).slice(2), [['turtle', 'Turtle AI (hard)'], ['naval', 'Naval AI']]);
  assert.ok(parseServerMessage(encodeServer({ t: 'start', ...start })).ok);
  // A room stored before bot types: its AI slots play the Normal AI.
  const stored = lobby(3);
  stored.room.setSlot(stored.host, { slot: 2, type: 'ai', difficulty: 'easy' });
  const json = stored.room.toJSON();
  delete json.slots[2].bot;
  const back = Room.fromJSON(json);
  assert.equal(back.slots[2].bot, 'normal');
  assert.ok(parseClientMessage(JSON.stringify({ t: 'slot', slot: 2, bot: 'rush' })).ok);
  assert.ok(!parseClientMessage(JSON.stringify({ t: 'slot', slot: 2, bot: 'brutal' })).ok);
});

test('game modes are plain option bundles: the host sends them, guests cannot, nothing new on the wire', () => {
  const { room, host, guest } = lobby(2);
  for (const mode of BUILTIN_MODES.filter((m) => !m.skirmishOnly)) {
    const options = { ...room.options, ...mode.options };
    const parsed = parseClientMessage(JSON.stringify({ t: 'options', options }));
    assert.ok(parsed.ok, `${mode.id}: ${parsed.message}`);
    throwsRoom(() => room.setOptions(guest, parsed.msg.options), 'not_host');
    room.setOptions(host, parsed.msg.options);
    assert.deepEqual(room.lobbyView().options, options, `${mode.id}: every player sees the bundle`);
  }
  // A bundle with a field the protocol does not know is refused before the room sees it.
  const extra = parseClientMessage(JSON.stringify({ t: 'options', options: { ...room.options, mode: 'rush' } }));
  assert.equal(extra.ok, false);
  room.setReady(guest, true, null);
  const start = room.start(host, first);
  for (const [k, v] of Object.entries(BUILTIN_MODES.filter((m) => !m.skirmishOnly).at(-1).options)) assert.equal(start.options[k], v, k);
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

test('a syncing seat that loses its connection keeps only its original grace', () => {
  const { room, host, guest } = lobby(2);
  room.setKey(guest, 'b'.repeat(64));
  room.setReady(guest, true, null);
  room.start(host, first);
  const g = room.seatOf(guest);
  room.suspendSeat(g, null, 1000, 120_000);
  room.beginRejoin(guest, 100_000, 600_000);
  assert.equal(room.seatStates[g].until, 700_000, 'catching up may take long');
  room.suspendSeat(g, null, 101_000, 120_000);
  assert.equal(room.seatStates[g].until, 121_000, 'but a drop ends at the original grace');
  // Resuming ends that absence: the next one starts a fresh grace.
  room.beginRejoin(guest, 110_000, 600_000);
  room.resumeSeat(g);
  room.suspendSeat(g, null, 200_000, 120_000);
  assert.equal(room.seatStates[g].until, 320_000);
  // State-independent refusals come before anything else.
  assert.equal(room.rejoinProblem(guest), null);
  room.rejoins[guest] = 10;
  assert.match(room.rejoinProblem(guest).message, /too often/);
});

// ---- Co-op missions -----------------------------------------------------------------------

test('a co-op mission: its places, people only, every place filled, the start names it', async () => {
  const { COOP_MISSIONS } = await import('@webra/protocol');
  const evac = COOP_MISSIONS.find((m) => m.id === 'evacuation');
  const mission = { id: evac.id, hash: evac.hash, options: { difficulty: 'easy' } };
  const { room, host, guest } = lobby(4);
  room.setSlot(host, { slot: 2, type: 'ai', bot: 'turtle' });
  assert.equal(room.slots[2].bot, 'turtle', 'skirmish lobbies keep their bot types');
  // Validated on the wire like any client message.
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'mission', mission })).msg.mission, mission);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'mission', mission: { ...mission, hash: 'a'.repeat(64) } })).ok, false);
  assert.equal(parseClientMessage(JSON.stringify({ t: 'mission', mission: { ...mission, id: 'allies-01' } })).ok, false);
  throwsRoom(() => room.setMission(guest, mission), 'not_host');
  room.setMission(host, mission);
  assert.deepEqual(
    room.slots.map((s) => s.type),
    ['human', 'human', 'closed', 'closed'],
    'the AI left; the places past the mission close',
  );
  throwsRoom(() => room.setSlot(host, { slot: 1, type: 'ai' }));
  throwsRoom(() => room.setSlot(host, { slot: 1, type: 'ai', bot: 'rush' }), undefined);
  throwsRoom(() => room.setSlot(guest, { slot: 1, bot: 'naval' }), undefined);
  assert.ok(room.slots.every((s) => s.bot === undefined), 'no bot types in a mission lobby');
  throwsRoom(() => room.setSlot(host, { slot: 2, type: 'open' }));
  assert.deepEqual(room.lobbyView().mission, mission);
  assert.deepEqual(parseServerMessage(encodeServer({ t: 'lobby', ...room.lobbyView() })).msg.mission, mission);
  // Every place needs a ready person.
  assert.match(room.startProblem(host), /Not everyone is ready/);
  room.setReady(guest, true, null);
  assert.equal(room.startProblem(host), null);
  const start = room.start(host, first);
  assert.deepEqual(start.mission, mission);
  assert.equal(start.options.cheats, false);
  assert.equal(start.options.players.length, 2);
  assert.deepEqual(parseServerMessage(encodeServer({ t: 'start', ...start })).msg.mission, mission, 'the start message validates');
  // Storage round trip keeps the mission.
  assert.deepEqual(Room.fromJSON(JSON.parse(JSON.stringify(room))).mission, mission);
});

test('a co-op mission waits for its places; picking a map goes back to a skirmish', async () => {
  const { COOP_MISSIONS } = await import('@webra/protocol');
  const m = COOP_MISSIONS[0];
  const room = Room.create({ maxPlayers: 4, seed: 7 });
  const host = room.join('Host', { host: true }).client;
  room.setMission(host, { id: m.id, hash: m.hash, options: {} });
  assert.match(room.startProblem(host), /needs a player in each/);
  // Too many people for the places: some must watch first.
  const big = Room.create({ maxPlayers: 4, seed: 7 });
  const h = big.join('H', { host: true }).client;
  big.join('A');
  big.join('B');
  throwsRoom(() => big.setMission(h, { id: m.id, hash: m.hash, options: {} }));
  room.setMap(host, null);
  assert.equal(room.mission, null);
  assert.equal(room.lobbyView().mission, undefined);
});

// ---- The map's game setup (map format version 2) ------------------------------------------

import { canonicalSlot } from '@webra/protocol';

/** A lobby map with a game setup (as maps.js summaryOf gives it). */
function setupMap(players, options = {}, lockedOptions = []) {
  return { id: '0123456789abcdef', hash: 'b'.repeat(64), name: 'Setup', modded: false, players: 4, setup: { players: players.map(canonicalSlot), options, lockedOptions } };
}

test('map setup: picking the map applies its slots and options; people move out of slots it closes or gives to an AI', () => {
  const { room, host, guest } = lobby(4);
  room.setSlot(guest, { slot: 1, faction: 'france' });
  const map = setupMap(
    [
      { faction: 'england', team: 1, lock: ['faction'] },
      { type: 'ai', difficulty: 'hard', bot: 'naval', faction: 'russia', team: 2, color: 5, lock: ['type', 'color'] },
      { type: 'closed', lock: ['type'] },
    ],
    { startingCash: 10000, crates: false },
    ['startingCash'],
  );
  room.setMap(host, map);
  assert.deepEqual(room.slots.map((s) => s.type), ['human', 'ai', 'closed', 'human']);
  assert.equal(room.slots[3].client, guest, 'the guest moved to the slot the map leaves open');
  assert.equal(room.slots[3].faction, 'france', 'with its settings');
  assert.deepEqual([room.slots[1].difficulty, room.slots[1].bot, room.slots[1].faction, room.slots[1].team, room.slots[1].color], ['hard', 'naval', 'russia', 2, 5]);
  assert.deepEqual([room.slots[0].faction, room.slots[0].team], ['england', 1]);
  assert.equal(new Set(room.slots.filter((s) => 'color' in s).map((s) => s.color)).size, 3, 'colours stay unique');
  assert.deepEqual([room.options.startingCash, room.options.crates], [10000, false]);
});

test('map setup: the server refuses changes to locked slot parts and options', () => {
  const { room, host, guest } = lobby(4);
  room.setMap(host, setupMap([{ faction: 'england', lock: ['faction'] }, { team: 2, lock: ['team'] }, { type: 'ai', lock: ['type'] }], { techLevel: 'low' }, ['techLevel']));
  throwsRoom(() => room.setSlot(host, { slot: 0, faction: 'russia' }), 'forbidden');
  assert.equal(room.slots[0].faction, 'england', 'nothing changed');
  room.setSlot(host, { slot: 0, team: 3 });
  throwsRoom(() => room.setSlot(guest, { slot: 1, team: 0 }), 'forbidden');
  room.setSlot(guest, { slot: 1, faction: 'ukraine' });
  throwsRoom(() => room.setSlot(host, { slot: 2, type: 'open' }), 'forbidden');
  throwsRoom(() => room.setOptions(host, { ...room.options, techLevel: 'high' }), 'forbidden');
  room.setOptions(host, { ...room.options, startingCash: 20000 });
  assert.equal(room.options.startingCash, 20000, 'what the map does not lock stays free');
  // Another map (here a generated one) clears the locks.
  room.setMap(host, null);
  room.setOptions(host, { ...room.options, techLevel: 'high' });
});

test('map setup: a map that leaves no place for the people in the lobby is refused, the lobby unchanged', () => {
  const { room, host, guest } = lobby(2);
  const before = structuredClone(room.slots);
  throwsRoom(() => room.setMap(host, setupMap([{}, { type: 'closed', lock: ['type'] }])));
  assert.deepEqual(room.slots, before);
  assert.equal(room.map, null);
  void guest;
});

test('map setup: people who join or leave the spectators after the map was picked take its slot settings', () => {
  const room = Room.create({ maxPlayers: 4, seed: 7 });
  const host = room.join('Host', { host: true }).client;
  const map = setupMap(
    [
      { faction: 'england', lock: ['faction'] },
      { faction: 'russia', team: 2, color: 4, lock: ['faction', 'team', 'color'] },
      { faction: 'randomsoviet', team: 1, lock: ['team'] },
      { color: 6 },
    ],
    {},
    [],
  );
  room.setMap(host, map);
  const b = room.join('B').client;
  const eye = room.join('Eye', { spectate: true }).client;
  room.spectate(eye, false);
  const d = room.join('D').client;
  assert.deepEqual(
    room.slots.map((s) => [s.client, s.faction, s.team, s.color]),
    [
      [host, 'england', 0, 0],
      [b, 'russia', 2, 4],
      [eye, 'randomsoviet', 1, 1],
      [d, 'random', 0, 6],
    ],
  );
  assert.equal(room.lockedProblem(), null, 'nobody breaks a lock by joining');
  // What the map does not lock stays theirs.
  room.setSlot(eye, { slot: 2, faction: 'ukraine' });
  room.setSlot(d, { slot: 3, team: 1, color: 2 });
  throwsRoom(() => room.setSlot(b, { slot: 1, team: 1 }), 'forbidden');
  for (const c of [b, eye, d]) room.setReady(c, true, map.hash);
  assert.equal(room.startProblem(host), null);
});

test('map setup: a joiner never takes a colour the map sets for another slot, and a colour the map sets is swapped in', () => {
  const room = Room.create({ maxPlayers: 3, seed: 7 });
  const host = room.join('Host', { host: true }).client;
  room.setMap(host, setupMap([{}, {}, { color: 1, lock: ['color'] }]));
  const b = room.join('B').client;
  assert.notEqual(room.slots[1].color, 1, 'colour 1 is kept for slot 3');
  // The host holds the colour slot 3 sets: whoever takes slot 3 gets it, the host gets theirs.
  room.setSlot(host, { slot: 0, color: 1 });
  const c = room.join('C').client;
  assert.equal(room.slots[2].client, c);
  assert.equal(room.slots[2].color, 1);
  assert.notEqual(room.slots[0].color, 1);
  assert.equal(new Set(room.slots.map((s) => s.color)).size, 3);
  assert.equal(room.lockedProblem(), null);
  void b;
});

test('map setup: moving to another slot or adding an AI takes the map settings of that slot', () => {
  const room = Room.create({ maxPlayers: 3, seed: 7 });
  const host = room.join('Host', { host: true }).client;
  room.setMap(host, setupMap([{}, { faction: 'russia', team: 2, lock: ['faction'] }, { faction: 'france', team: 3, lock: ['faction', 'team'] }]));
  room.setSlot(host, { slot: 1 });
  assert.deepEqual([room.slots[1].client, room.slots[1].faction, room.slots[1].team], [host, 'russia', 2]);
  // A move that comes with settings the map locks otherwise is refused.
  throwsRoom(() => room.setSlot(host, { slot: 2, faction: 'germany' }), 'forbidden');
  assert.equal(room.slots[1].client, host, 'and changes nothing');
  room.setSlot(host, { slot: 2, type: 'ai' });
  assert.deepEqual([room.slots[2].type, room.slots[2].faction, room.slots[2].team], ['ai', 'france', 3]);
  throwsRoom(() => room.setSlot(host, { slot: 2, type: 'ai', faction: 'germany' }), 'forbidden');
  assert.equal(room.slots[2].faction, 'france', 'a refused change changes nothing');
  assert.equal(room.lockedProblem(), null);
});

test('map setup: a lobby that already breaks a lock can be put right; only new breaks are refused', () => {
  const { room, host, guest } = lobby(3);
  room.setMap(host, setupMap([{}, { faction: 'england', team: 1, lock: ['faction', 'team'] }]));
  // As a lobby from before could hold it (the map's locks broken in slot 2).
  Object.assign(room.slots[1], { faction: 'russia', team: 0 });
  assert.match(room.lockedProblem(), /faction of slot 2/);
  room.setSlot(guest, { slot: 1, color: 5 });
  room.setSlot(host, { slot: 0, faction: 'germany' });
  room.setSlot(guest, { slot: 1, faction: 'england' });
  assert.match(room.lockedProblem(), /slot 2 to team 1/, 'one lock put right, the other still broken');
  throwsRoom(() => room.setSlot(guest, { slot: 1, faction: 'france' }), 'forbidden');
  room.setSlot(guest, { slot: 1, team: 1 });
  assert.equal(room.lockedProblem(), null);
});

test('map setup: after a rematch, people who join take the map slot settings', () => {
  const room = Room.create({ maxPlayers: 3, seed: 7 });
  const host = room.join('Host', { host: true }).client;
  const map = setupMap([{}, { faction: 'russia', team: 2, lock: ['faction', 'team'] }, { faction: 'france', lock: ['faction'] }]);
  room.setMap(host, map);
  const guest = room.join('Guest').client;
  const third = room.join('Third').client;
  for (const c of [guest, third]) room.setReady(c, true, map.hash);
  room.start(host, () => 0);
  room.proposeRematch(host, 1000);
  room.answerRematch(guest, true, 1000);
  room.answerRematch(third, true, 1000);
  room.backToLobby([host, guest], 2000);
  assert.equal(room.slots[2].type, 'open', 'the player who did not come back left a place');
  const late = room.join('Late').client;
  assert.deepEqual([room.slots[2].client, room.slots[2].faction], [late, 'france']);
  assert.equal(room.lockedProblem(), null);
});
