// Rematch (docs/contracts.md section 4): the host proposes playing again with
// the same settings, every player still in the game accepts, the session goes
// back to its lobby and the members come back with their rejoin keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_OPTIONS, parseClientMessage, parseServerMessage, PROTOCOL_VERSION, REMATCH_COOLDOWN_MS, REMATCH_RETURN_MS, REMATCH_VOTE_MS } from '@webra/protocol';
import { makeSession } from './fake-do.mjs';
import { Room, RoomError } from '../src/room.js';

const throwsRoom = (fn, code) => assert.throws(fn, (err) => err instanceof RoomError && (code === undefined || err.code === code), code);
const T0 = 1_000_000;

/** A started 3 player room (host, guest, AI) with a spectator. */
function started() {
  const room = Room.create({ maxPlayers: 3, seed: 5 });
  const host = room.join('Host', { host: true }).client;
  const guest = room.join('Guest').client;
  const eye = room.join('Eye', { spectate: true }).client;
  room.setSlot(host, { slot: 2, type: 'ai', difficulty: 'hard', faction: 'ukraine' });
  room.setSlot(host, { slot: 0, faction: 'germany', team: 1 });
  room.setOptions(host, { ...DEFAULT_OPTIONS, startingCash: 10000, weather: 'cosmetic' });
  room.setReady(guest, true, null);
  for (const c of [host, guest, eye]) room.setKey(c, 'f'.repeat(64));
  room.start(host, () => 0);
  return { room, host, guest, eye };
}

test('room: only the host proposes, players answer, one decline cancels', () => {
  const { room, host, guest, eye } = started();
  throwsRoom(() => room.proposeRematch(guest, T0), 'not_host');
  throwsRoom(() => room.answerRematch(guest, true, T0), 'bad_state');
  room.proposeRematch(host, T0);
  throwsRoom(() => room.proposeRematch(host, T0), 'bad_state');
  assert.deepEqual(room.rematchStatus(T0 + 1000), { state: 'open', by: host, accepted: [host], waiting: [guest], msLeft: REMATCH_VOTE_MS - 1000 });
  throwsRoom(() => room.answerRematch(eye, true, T0), 'forbidden');
  assert.equal(room.rematchAgreed(), false);
  assert.equal(room.answerRematch(guest, false, T0), 'declined');
  assert.equal(room.rematch, null);
  throwsRoom(() => room.proposeRematch(host, T0 + 1000), 'rate_limited');
  room.proposeRematch(host, T0 + REMATCH_COOLDOWN_MS);
  assert.equal(room.answerRematch(host, false, T0), 'withdrawn', 'the host may withdraw it');
});

test('room: an agreed rematch goes back to the lobby with the same settings; others lose their places', () => {
  const { room, host, guest, eye } = started();
  const before = structuredClone({ slots: room.slots, options: room.options, map: room.map });
  room.proposeRematch(host, T0);
  room.answerRematch(guest, true, T0);
  assert.equal(room.rematchAgreed(), true);
  const back = room.backToLobby([host, guest, eye], T0 + 5);
  assert.deepEqual(back.sort(), [host, guest, eye].sort());
  assert.equal(room.phase, 'lobby');
  assert.equal(room.hostId, host);
  assert.deepEqual(room.options, before.options, 'same options');
  assert.deepEqual(room.slots.map((s) => ({ ...s, ready: undefined })), before.slots.map((s) => ({ ...s, ready: undefined })), 'same slots, factions, colours and teams');
  assert.ok(room.slots.filter((s) => s.type === 'human').every((s) => s.ready === false));
  assert.deepEqual([room.seats, room.seatStates, room.startMsg], [null, null, null]);
  for (const c of [host, guest, eye]) assert.equal(room.isReturning(c), true);
  assert.equal(room.nextReturnDeadline(), T0 + 5 + REMATCH_RETURN_MS);
  // Coming back: in time only (again while the window lasts: a reload during the return).
  room.returned(guest, T0 + 10);
  room.returned(guest, T0 + 11);
  throwsRoom(() => room.returned(eye, T0 + 5 + REMATCH_RETURN_MS), 'forbidden');
  assert.deepEqual(room.expiredReturns(T0 + 5 + REMATCH_RETURN_MS).sort(), [host, guest, eye].sort());
  room.settleReturn(guest);
  assert.equal(room.isReturning(guest), false);
  throwsRoom(() => room.returned(guest, T0 + 12), 'forbidden');
  // A new game can start once everyone is back and ready.
  room.returned(host, T0 + 20);
  room.leave(eye);
  room.setReady(guest, true, null);
  assert.equal(room.startProblem(host), null);
  const start = room.start(host, () => 0);
  assert.equal(start.options.startingCash, 10000);
  assert.equal(start.options.weather, 'cosmetic');
  const raw = JSON.stringify({ t: 'start', ...start });
  assert.ok(parseServerMessage(raw).ok);
});

test('room: rematches and resumed saves keep the OpenRA lobby options and handicaps', () => {
  const room = Room.create({ maxPlayers: 3, seed: 5 });
  const host = room.join('Host', { host: true, account: 'acc-host' }).client;
  const guest = room.join('Guest', { account: 'acc-guest' }).client;
  room.setSlot(host, { slot: 2, type: 'ai', difficulty: 'hard', faction: 'ukraine', handicap: 10 });
  room.setSlot(host, { slot: 0, handicap: 25 });
  const options = { ...DEFAULT_OPTIONS, crates: false, shortGame: false, bounty: true, timeLimit: 30, separateTeamSpawns: false, allyBuildRadius: false, reusableEngineers: true };
  room.setOptions(host, options);
  room.setReady(guest, true, null);
  const first = room.start(host, () => 0);
  assert.deepEqual(first.options.players.map((p) => p.handicap), [25, 0, 10]);
  // Rematch: the same options and handicaps in the lobby and the next start.
  room.proposeRematch(host, T0);
  room.answerRematch(guest, true, T0);
  room.backToLobby([host, guest], T0);
  for (const k of ['crates', 'shortGame', 'bounty', 'timeLimit', 'separateTeamSpawns', 'allyBuildRadius', 'reusableEngineers']) assert.equal(room.options[k], options[k], k);
  assert.deepEqual(room.slots.map((s) => s.handicap), [25, 0, 10]);
  // Resuming the first game as a save: the saved handicaps and options come back.
  const again = Room.create({ maxPlayers: 3, seed: 6 });
  const h2 = again.join('Host', { host: true, account: 'acc-host' }).client;
  again.loadResume(h2, { id: 'x'.repeat(16), title: 'Saved', createdAt: 1, ticks: 100, hash: 7, options: first.options, seats: ['acc-host', 'acc-guest', null], chunks: 1 });
  again.join('Guest', { account: 'acc-guest' });
  assert.deepEqual(again.slots.map((s) => s.handicap), [25, 0, 10]);
  for (const k of ['crates', 'shortGame', 'bounty', 'timeLimit', 'separateTeamSpawns', 'allyBuildRadius', 'reusableEngineers']) assert.equal(again.options[k], options[k], k);
  assert.ok(parseServerMessage(JSON.stringify({ t: 'start', ...first })).ok);
});

test('room: the lobby always shows the movement model the game will play', () => {
  // Options messages must carry it: one without it is refused before the room sees it.
  const { movement: _m, ...old } = DEFAULT_OPTIONS;
  assert.equal(parseClientMessage(JSON.stringify({ t: 'options', options: old })).ok, false);
  const room = Room.create({ maxPlayers: 3, seed: 5 });
  const host = room.join('Host', { host: true, account: 'acc-host' }).client;
  const guest = room.join('Guest', { account: 'acc-guest' }).client;
  assert.equal(room.options.movement, 'openra');
  room.setOptions(host, { ...DEFAULT_OPTIONS, movement: 'webra' });
  assert.equal(room.options.movement, 'webra');
  room.setReady(guest, true, null);
  const first = room.start(host, () => 0);
  assert.equal(first.options.movement, 'webra');
  // A save from before the option: the lobby shows WebRA's model, which the
  // saved options (without the key) play, and starts with them unchanged.
  const { movement: _n, ...saved } = first.options;
  const again = Room.create({ maxPlayers: 3, seed: 6 });
  const h2 = again.join('Host', { host: true, account: 'acc-host' }).client;
  again.loadResume(h2, { id: 'y'.repeat(16), title: 'Old save', createdAt: 1, ticks: 100, hash: 7, options: saved, seats: ['acc-host', 'acc-guest', null], chunks: 1 });
  assert.equal(again.options.movement, 'webra');
  again.join('Guest', { account: 'acc-guest' });
  const resumed = again.startResume();
  assert.equal('movement' in resumed.options, false);
  // A save made with OpenRA's model shows OpenRA's.
  const third = Room.create({ maxPlayers: 3, seed: 7 });
  const h3 = third.join('Host', { host: true, account: 'acc-host' }).client;
  third.loadResume(h3, { id: 'z'.repeat(16), title: 'New save', createdAt: 1, ticks: 100, hash: 7, options: { ...saved, movement: 'openra' }, seats: ['acc-host', 'acc-guest', null], chunks: 1 });
  assert.equal(third.options.movement, 'openra');
});

test('room: seats that are away still answer; gone seats do not; players who did not come lose their slot', () => {
  const { room, host, guest, eye } = started();
  const gSeat = room.seatOf(guest);
  room.suspendSeat(gSeat, null, T0, 120_000);
  room.proposeRematch(host, T0);
  assert.deepEqual(room.rematchStatus(T0).waiting, [guest], 'an away player can still answer once back');
  room.endSeat(gSeat);
  assert.equal(room.rematchAgreed(), true, 'a player who left for good does not hold it up');
  room.backToLobby([host], T0);
  assert.equal(room.slots[1].type, 'open', "the guest's place opened");
  assert.equal(room.isSpectator(eye), false, 'a spectator who was not there');
  assert.equal(Object.hasOwn(room.keys, guest), false);
  assert.equal(Object.hasOwn(room.keys, eye), false);
  assert.equal(room.memberCount(), 1);
});

// ---- Session object ------------------------------------------------------------------------------

const hello = (s, name, extra = {}) => ({ t: 'hello', protocol: PROTOCOL_VERSION, version: s.version, name, ...extra });

async function game() {
  const s = await makeSession({ maxPlayers: 2 });
  const host = s.connect('host');
  await s.send(host, hello(s, 'Host', { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  const guest = s.connect('guest');
  await s.send(guest, hello(s, 'Guest'));
  const gw = guest.take('welcome')[0];
  await s.send(host, { t: 'spectators', max: 1 });
  const eye = s.connect('eye');
  await s.send(eye, hello(s, 'Eye', { spectate: true }));
  const ew = eye.take('welcome')[0];
  await s.send(host, { t: 'options', options: { ...DEFAULT_OPTIONS, startingCash: 7500, seed: 77 } });
  await s.send(guest, { t: 'ready', ready: true, mapHash: null });
  await s.send(host, { t: 'start' });
  assert.ok(host.last('start'));
  return { s, host, guest, eye, hw, gw, ew };
}

function valid(ws) {
  for (const m of ws.inbox) {
    const r = parseServerMessage(JSON.stringify(m));
    assert.ok(r.ok, `${ws.name} got an invalid ${m.t}: ${r.message}`);
  }
}

test('session: rematch proposed, accepted, back to the lobby; members reload and return with their keys', async () => {
  const { s, host, guest, eye, hw, gw, ew } = await game();
  // Spectators and guests cannot propose; nothing to answer yet.
  await s.send(guest, { t: 'rematch', accept: true });
  assert.equal(guest.last('error').code, 'not_host');
  await s.send(host, { t: 'rematch', accept: true });
  const open = guest.last('rematch');
  assert.deepEqual([open.state, open.by, open.accepted, open.waiting], ['open', hw.you, [hw.you], [gw.you]]);
  assert.ok(eye.last('rematch'), 'spectators are told too');
  await s.send(eye, { t: 'rematch', accept: true });
  assert.equal(eye.last('error').code, 'forbidden');
  await s.send(guest, { t: 'rematch', accept: true });
  const done = host.last('rematch');
  assert.deepEqual([done.state, done.by, done.accepted.sort(), done.waiting], ['lobby', hw.you, [hw.you, gw.you].sort(), []]);
  assert.equal(eye.last('rematch').state, 'lobby');
  assert.equal(s.session.room.phase, 'lobby');
  assert.equal(s.session.lockstep, null);
  for (const ws of [host, guest, eye]) valid(ws);
  // Orders of the old game are refused now.
  await s.send(guest, { t: 'orders', tick: 3, orders: [] });
  assert.equal(guest.last('error').code, 'bad_state');

  // The pages reload: the old connections close, the places wait.
  for (const ws of [host, guest, eye]) await s.drop(ws);
  assert.equal(s.session.room.memberCount(), 3, 'closing the old page does not give up the place');
  const back = {};
  for (const [name, w] of [['host', hw], ['guest', gw], ['eye', ew]]) {
    const ws = s.connect(`${name}-back`);
    await s.send(ws, hello(s, undefined, { rejoin: { client: w.you, key: w.key } }));
    const welcome = ws.take('welcome')[0];
    assert.ok(welcome, `${name} is back`);
    assert.equal(welcome.you, w.you);
    assert.equal('key' in welcome, false, 'the key stays the same');
    back[name] = ws;
  }
  const lobby = back.host.last('lobby');
  assert.equal(lobby.options.startingCash, 7500, 'the same settings');
  assert.equal(lobby.options.seed, 77);
  assert.equal(lobby.hostId, hw.you);
  assert.deepEqual(lobby.spectators.map((x) => x.client), [ew.you]);
  assert.deepEqual(lobby.slots.filter((x) => x.type === 'human').map((x) => [x.client, x.ready]), [[hw.you, false], [gw.you, false]]);
  // A reload during the return comes back again and replaces the older connection; a wrong key is refused.
  const twice = s.connect('twice');
  await s.send(twice, hello(s, undefined, { rejoin: { client: gw.you, key: gw.key } }));
  assert.equal(twice.take('welcome')[0].you, gw.you);
  assert.equal(back.guest.last('error').message, 'You joined from another connection.');
  assert.ok(back.guest.closed);
  back.guest = twice;
  const thief = s.connect('thief');
  await s.send(thief, hello(s, undefined, { rejoin: { client: gw.you, key: 'A'.repeat(43) } }));
  assert.equal(thief.last('error').code, 'forbidden');
  // And the next game starts.
  await s.send(back.guest, { t: 'ready', ready: true, mapHash: null });
  await s.send(back.host, { t: 'start' });
  const start = back.guest.last('start');
  assert.equal(start.options.startingCash, 7500);
  assert.deepEqual(back.eye.last('start'), start);
  for (const ws of Object.values(back)) valid(ws);
});

test('session: a decline cancels for everyone; an unanswered proposal expires; the proposer leaving cancels it', async () => {
  {
    const { s, host, guest } = await game();
    await s.send(host, { t: 'rematch', accept: true });
    await s.send(guest, { t: 'rematch', accept: false });
    const end = host.last('rematch');
    assert.deepEqual([end.state, end.reason], ['cancelled', 'declined']);
    assert.equal(s.session.room.phase, 'game', 'the game goes on');
    await s.send(host, { t: 'rematch', accept: true });
    assert.equal(host.last('error').code, 'rate_limited', 'not again right away');
  }
  {
    const { s, host, guest } = await game();
    await s.send(host, { t: 'rematch', accept: true });
    assert.ok(guest.last('rematch').msLeft <= REMATCH_VOTE_MS);
    // Its deadline passes (the players kept playing meanwhile, so nobody is dropped for silence).
    s.session.room.rematch.until = Date.now() - 1;
    await s.session.alarm();
    assert.deepEqual([guest.last('rematch').state, guest.last('rematch').reason], ['cancelled', 'expired']);
    assert.equal(s.session.room.phase, 'game');
  }
  {
    const { s, host, guest } = await game();
    await s.send(host, { t: 'rematch', accept: true });
    await s.send(host, { t: 'leave' });
    assert.deepEqual([guest.last('rematch').state, guest.last('rematch').reason], ['cancelled', 'left']);
  }
});

test('session: members who do not come back lose their place; an empty lobby closes', async () => {
  const { s, host, guest, eye, hw } = await game();
  await s.send(host, { t: 'rematch', accept: true });
  await s.send(guest, { t: 'rematch', accept: true });
  for (const ws of [host, guest, eye]) await s.drop(ws);
  const ws = s.connect('host-back');
  await s.send(ws, hello(s, undefined, { rejoin: { client: hw.you, key: hw.key } }));
  assert.ok(ws.take('welcome')[0]);
  assert.ok(s.ctx.storage.alarm <= Date.now() + REMATCH_RETURN_MS, 'the alarm checks the returns');
  const real = Date.now;
  Date.now = () => real() + REMATCH_RETURN_MS + 1000;
  try {
    await s.session.alarm();
  } finally {
    Date.now = real;
  }
  const lobby = ws.last('lobby');
  assert.deepEqual(lobby.slots.filter((x) => x.type === 'human').map((x) => x.client), [hw.you]);
  assert.deepEqual(lobby.spectators, []);
  assert.deepEqual(ws.take('left').map((m) => [m.name, m.reason]).sort(), [['Eye', 'expired'], ['Guest', 'expired']]);
  assert.equal(s.session.room.isReturning(hw.you), false, 'the host is back for good');
  // A key cannot bring anyone back after the window: not even the host after a reload.
  await s.drop(ws);
  assert.equal(s.session.room, null, 'the last member left: the session is gone');
});
