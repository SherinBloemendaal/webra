// The session Durable Object end to end (in memory, see fake-do.mjs):
// rejoin keys, reconnecting into a running game, spectators, the order log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOG_MAX_BYTES, MAX_REJOINS, parseServerMessage, PROTOCOL_VERSION, RECONNECT_GRACE_MS, SEAT_KEY_RE } from '@webra/protocol';
import { makeSession } from './fake-do.mjs';

const hello = (s, name, extra = {}) => ({ t: 'hello', protocol: PROTOCOL_VERSION, version: s.version, name, ...extra });

/** Every message a socket got must pass the protocol's own validation. */
function assertValid(ws) {
  for (const m of ws.inbox) {
    const r = parseServerMessage(JSON.stringify(m));
    assert.ok(r.ok, `${ws.name} got an invalid ${m.t}: ${r.message}`);
  }
}

/** Host and guest in a lobby, optionally a spectator, then the game started. */
async function started({ spectators = 0, start = true } = {}) {
  const s = await makeSession();
  const host = s.connect('host');
  await s.send(host, hello(s, 'Host', { hostKey: s.hostKey }));
  const hw = host.take('welcome')[0];
  const guest = s.connect('guest');
  await s.send(guest, hello(s, 'Guest'));
  const gw = guest.take('welcome')[0];
  const watchers = [];
  if (spectators > 0) await s.send(host, { t: 'spectators', max: spectators });
  for (let i = 0; i < spectators; i++) {
    const w = s.connect(`watcher${i}`);
    await s.send(w, hello(s, `Watcher ${i}`, { spectate: true }));
    watchers.push({ ws: w, welcome: w.take('welcome')[0] });
  }
  await s.send(guest, { t: 'ready', ready: true, mapHash: null });
  if (start) await s.send(host, { t: 'start' });
  const st = host.last('start');
  const seat = (you) => st?.players.find((p) => p.client === you)?.player;
  return { s, host, guest, hw, gw, watchers, hSeat: st && seat(hw.you), gSeat: st && seat(gw.you) };
}

/** Each listed client runs ticks like net.js: after frame T, orders for T + 3. */
async function play(s, clients, from, to, orders = () => []) {
  for (let t = from; t < to; t++) {
    for (const c of clients) await s.send(c.ws, { t: 'orders', tick: t + 3, orders: orders(c, t + 3) });
  }
}

const frameTicks = (ws) => ws.take('frame').map((f) => f.tick);

test('welcome carries a rejoin key; only its hash is stored', async () => {
  const { s, hw, gw, host } = await started({ start: false });
  for (const w of [hw, gw]) {
    assert.match(w.key, SEAT_KEY_RE);
    assert.equal(w.role, 'player');
  }
  assert.notEqual(hw.key, gw.key);
  const stored = JSON.stringify([...s.ctx.storage.data.values()]);
  assert.equal(stored.includes(hw.key), false, 'the key itself is never stored');
  assert.equal(stored.includes(gw.key), false);
  assert.match(s.session.room.keys[gw.you], /^[0-9a-f]{64}$/);
  assertValid(host);
});

test('a dropped player rejoins with its key, catches up and gets its seat back', async () => {
  const { s, host, guest, gw, hSeat, gSeat } = await started();
  const H = { ws: host, seat: hSeat };
  const G = { ws: guest, seat: gSeat };
  assert.deepEqual(frameTicks(host), [0, 1, 2]);
  const stop = (c, tick) => (tick === 5 || tick === 40 ? [{ o: 'stop', player: c.seat, ids: [tick] }] : []);
  await play(s, [H, G], 0, 20, stop);
  assert.deepEqual(frameTicks(host), Array.from({ length: 20 }, (_, i) => i + 3));

  // The guest's connection drops: the host is told and is never held up.
  await s.drop(guest);
  const left = host.take('left')[0];
  assert.deepEqual([left.player, left.reason, left.name], [gSeat, 'disconnected', 'Guest']);
  await play(s, [H], 20, 50, stop);
  const ticks = frameTicks(host);
  assert.equal(ticks.at(-1), 52, 'the game runs on without the missing player');

  // Wrong keys are refused (and count toward the IP lockout).
  const thief = s.connect('thief', '10.9.9.9');
  await s.send(thief, hello(s, 'Thief', { rejoin: { client: gw.you, key: 'x'.repeat(43) } }));
  assert.equal(thief.take('error')[0].code, 'forbidden');
  assert.ok(thief.closed);

  // The guest reloads the page and rejoins.
  const back = s.connect('guest2');
  await s.send(back, hello(s, 'Guest', { rejoin: { client: gw.you, key: gw.key } }));
  assertValid(back);
  const welcome = back.take('welcome')[0];
  assert.deepEqual([welcome.you, welcome.role, 'key' in welcome], [gw.you, 'player', false]);
  const start = back.take('start')[0];
  assert.equal(start.players.length, 2);
  const log = back.take('log').flatMap((m) => m.frames);
  assert.deepEqual(log.map((f) => f[0]), [5, 40], 'only frames with orders are logged');
  assert.deepEqual(log[0][1], [[hSeat, [{ o: 'stop', player: hSeat, ids: [5] }]], [gSeat, [{ o: 'stop', player: gSeat, ids: [5] }]]]);
  const sync = back.take('sync')[0];
  assert.equal(sync.tick, 53);
  assert.equal(s.session.room.seatState(gSeat), 'syncing');

  // Resume brings the seat back; its orders count from a future tick on.
  await s.send(back, { t: 'resume' });
  const b = host.take('back')[0];
  assert.deepEqual([b.player, b.tick], [gSeat, 53 + 3]);
  assert.equal(back.take('back')[0].tick, 56);
  assert.equal(s.session.room.seatState(gSeat), 'active');
  // Frames before 56 do not wait for the guest; from 56 on they do.
  await play(s, [H], 50, 57);
  assert.equal(Math.max(...frameTicks(host)), 55);
  await play(s, [{ ws: back, seat: gSeat }], 53, 58);
  assert.equal(Math.max(...frameTicks(host)), 59);
  assert.equal(Math.max(...frameTicks(back)), 59);
  assertValid(host);
  assertValid(back);
});

test('rejoining keeps the stall budget; leaving and protocol violations are final', async () => {
  const { s, host, guest, hw, gw, hSeat, gSeat } = await started();
  await play(s, [{ ws: host, seat: hSeat }, { ws: guest, seat: gSeat }], 0, 5);
  s.session.lockstep.windows.get(gSeat).debtMs = 7000;
  await s.drop(guest);
  assert.ok(s.session.room.seatStates[gSeat].record.debtMs > 6900);
  const back = s.connect('guest2');
  await s.send(back, hello(s, 'Guest', { rejoin: { client: gw.you, key: gw.key } }));
  await s.send(back, { t: 'resume' });
  assert.ok(s.session.lockstep.windows.get(gSeat).debtMs > 6900, 'debt survives the rejoin');

  // An order from the wrong tick removes the player for good.
  await s.send(back, { t: 'orders', tick: 999, orders: [] });
  assert.ok(back.closed);
  assert.equal(host.last('left').reason, 'removed');
  assert.equal(s.session.room.seatState(gSeat), 'gone');
  const again = s.connect('guest3');
  await s.send(again, hello(s, 'Guest', { rejoin: { client: gw.you, key: gw.key } }));
  assert.equal(again.take('error')[0].code, 'forbidden');

  // The host leaves on purpose: the game is over and the session deleted.
  await s.send(host, { t: 'leave' });
  assert.equal(s.session.room, null);
  assert.equal(s.ctx.storage.data.size, 0);
  void hw;
});

test('away seats expire after the grace period; rejoins are capped', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { s, host, guest, gw, hSeat, gSeat } = await started();
  await play(s, [{ ws: host, seat: hSeat }, { ws: guest, seat: gSeat }], 0, 5);
  await s.drop(guest);
  // Wall time passes in 1 s steps while the host keeps playing at normal
  // speed (25 ticks a second), so it never holds the game up.
  let next = 5;
  const advance = async (ms) => {
    for (let i = 0; i < ms / 1000; i++) {
      t.mock.timers.tick(1000);
      await play(s, [{ ws: host, seat: hSeat }], next, next + 25);
      next += 25;
      if (i % 30 === 0) await s.session.alarm();
    }
  };
  for (let i = 0; i < MAX_REJOINS; i++) {
    await advance(10_000); // catch-ups are rate limited per session
    const ws = s.connect(`try${i}`);
    await s.send(ws, hello(s, 'Guest', { rejoin: { client: gw.you, key: gw.key } }));
    assert.equal(ws.take('welcome').length, 1, `rejoin ${i}`);
    await s.drop(ws);
  }
  await advance(10_000);
  const late = s.connect('late');
  await s.send(late, hello(s, 'Guest', { rejoin: { client: gw.you, key: gw.key } }));
  assert.match(late.take('error')[0].message, /too often/);
  // The guest stays away past its deadline.
  await advance(RECONNECT_GRACE_MS + 61_000);
  await s.session.alarm();
  const lefts = host.take('left');
  assert.equal(lefts.filter((m) => m.player === hSeat).length, 0, 'the host was never dropped');
  assert.deepEqual(lefts.filter((m) => m.reason === 'expired').map((m) => m.player), [gSeat]);
  assert.equal(s.session.room.seatState(gSeat), 'gone');
});

test('spectators: lobby places, frames, no orders, no stalls, late joining', async () => {
  const { s, host, guest, watchers, hSeat, gSeat } = await started({ spectators: 2, start: false });
  const lobby = host.last('lobby');
  assert.deepEqual(lobby.spectators.map((x) => x.name), ['Watcher 0', 'Watcher 1']);
  assert.equal(lobby.maxSpectators, 2);
  assert.equal(watchers[0].welcome.role, 'spectator');
  assert.match(watchers[0].welcome.key, SEAT_KEY_RE);
  // Full: a third spectator is refused; the host cannot shrink below the count.
  const third = s.connect('third');
  await s.send(third, hello(s, 'Third', { spectate: true }));
  assert.equal(third.take('error')[0].code, 'full');
  await s.send(host, { t: 'spectators', max: 1 });
  assert.equal(host.take('error').at(-1).code, 'invalid');
  // A spectator moves to an open slot and back.
  await s.send(watchers[1].ws, { t: 'spectate', on: false });
  assert.equal(host.last('lobby').slots[2].type, 'human');
  await s.send(watchers[1].ws, { t: 'spectate', on: true });
  assert.equal(host.last('lobby').spectators.length, 2);

  await s.send(host, { t: 'start' });
  const st = watchers[0].ws.take('start')[0];
  assert.equal(st.players.length, 2, 'spectators do not play');
  await play(s, [{ ws: host, seat: hSeat }, { ws: guest, seat: gSeat }], 0, 30);
  assert.equal(frameTicks(watchers[0].ws).at(-1), 32, 'spectators receive every frame');

  // Orders or hashes from a spectator: refused, connection closed, removed.
  await s.send(watchers[0].ws, { t: 'orders', tick: 33, orders: [] });
  assert.equal(watchers[0].ws.take('error')[0].code, 'forbidden');
  assert.ok(watchers[0].ws.closed);
  assert.deepEqual([host.last('left').player, host.last('left').reason], [null, 'removed']);
  await s.send(watchers[1].ws, { t: 'hash', tick: 25, hash: 'aa' });
  assert.ok(watchers[1].ws.closed);
  // Their places are free again: a late spectator catches up from the log.
  const late = s.connect('late');
  await s.send(late, hello(s, 'Late', { spectate: true }));
  assertValid(late);
  assert.equal(late.take('welcome')[0].role, 'spectator');
  assert.equal(late.take('start').length, 1);
  assert.equal(late.take('sync')[0].tick, 33);
  await play(s, [{ ws: host, seat: hSeat }, { ws: guest, seat: gSeat }], 30, 35);
  assert.deepEqual(frameTicks(late), [33, 34, 35, 36, 37]);
  // Players are never asked to wait for spectators: hashes compare among players only.
  await s.send(host, { t: 'hash', tick: 25, hash: 'aa' });
  await s.send(guest, { t: 'hash', tick: 25, hash: 'aa' });
  assert.deepEqual(s.session.lockstep.agreed, { tick: 25, hash: 'aa' });
});

test('a defeated player keeps watching; its orders are dropped, spectators cannot report a defeat', async () => {
  const { s, host, guest, watchers, hSeat, gSeat } = await started({ spectators: 1 });
  const seats = [{ ws: host, seat: hSeat }, { ws: guest, seat: gSeat }];
  await play(s, seats, 0, 10);
  await s.send(guest, { t: 'defeated' });
  assert.equal(guest.take('error').length, 0);
  assert.ok(!guest.closed, 'it stays connected and keeps receiving frames');
  await play(s, seats, 10, 20, (c) => [{ o: 'stop', player: c.seat, ids: [1] }]);
  assert.equal(host.take('error').length + guest.take('error').length, 0);
  const frames = watchers[0].ws.take('frame').filter((f) => f.tick >= 13);
  assert.equal(frames.length, 10);
  for (const f of frames) assert.deepEqual(f.orders.map(([p]) => p), [hSeat], `tick ${f.tick}: only the host's orders`);
  await s.send(watchers[0].ws, { t: 'defeated' });
  assert.equal(watchers[0].ws.take('error')[0].code, 'bad_state');
  assertValid(guest);
});

test('a spectator rejoins with its key; players cannot join a running game', async () => {
  const { s, host, guest, watchers, hSeat, gSeat } = await started({ spectators: 1 });
  await play(s, [{ ws: host, seat: hSeat }, { ws: guest, seat: gSeat }], 0, 4);
  const w = watchers[0];
  await s.drop(w.ws);
  assert.equal(s.session.room.spectators.length, 0);
  const again = s.connect('again');
  await s.send(again, hello(s, 'Watcher 0', { rejoin: { client: w.welcome.you, key: w.welcome.key } }));
  assert.equal(again.take('welcome')[0].role, 'spectator');
  assert.equal(again.take('sync')[0].tick, 7);
  const player = s.connect('player');
  await s.send(player, hello(s, 'Late player'));
  assert.match(player.take('error')[0].message, /spectator/);
});

/** Wall time passes in 1 s steps while the host keeps playing at normal speed. */
function hostClock(t, s, host, hSeat, from) {
  let next = from;
  return async (ms) => {
    for (let i = 0; i < ms / 1000; i++) {
      t.mock.timers.tick(1000);
      await play(s, [{ ws: host, seat: hSeat }], next, next + 25);
      next += 25;
      await s.session.alarm();
    }
  };
}

test('a rejoining seat that drops again only gets what is left of its grace', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  const { s, host, guest, gw, hSeat, gSeat } = await started();
  await play(s, [{ ws: host, seat: hSeat }, { ws: guest, seat: gSeat }], 0, 5);
  await s.drop(guest);
  const advance = hostClock(t, s, host, hSeat, 5);
  await advance(100_000);
  // A long game gives a long resume deadline, longer than the grace left.
  const back = s.connect('back');
  await s.send(back, hello(s, 'Guest', { rejoin: { client: gw.you, key: gw.key } }));
  assert.equal(s.session.room.seatState(gSeat), 'syncing');
  assert.ok(s.session.room.seatStates[gSeat].until > Date.now() + 20_000);
  await advance(1000);
  await s.drop(back);
  assert.equal(s.session.room.seatStates[gSeat].until, 2_000_000 + RECONNECT_GRACE_MS, 'the original grace');
  await advance(17_000);
  assert.equal(s.session.room.seatState(gSeat), 'away');
  await advance(3000);
  assert.equal(s.session.room.seatState(gSeat), 'gone');
  assert.deepEqual(host.take('left').map((m) => m.reason), ['disconnected', 'expired']);
});

test('a refused rejoin never disconnects the member that is still playing', async () => {
  const { s, host, guest, gw, gSeat } = await started();
  s.session.room.rejoins[gw.you] = MAX_REJOINS;
  const other = s.connect('other');
  await s.send(other, hello(s, 'Guest', { rejoin: { client: gw.you, key: gw.key } }));
  assert.match(other.take('error')[0].message, /too often/);
  assert.equal(guest.closed, null);
  assert.equal(s.session.room.seatState(gSeat), 'active');
  assert.deepEqual(host.take('left'), []);
});

test('catch-ups count until the client confirms; the byte budget follows the log size', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 3_000_000 });
  const { s, host, guest, hSeat, gSeat } = await started({ spectators: 0, start: false });
  await s.send(host, { t: 'spectators', max: 4 });
  await s.send(host, { t: 'start' });
  await play(s, [{ ws: host, seat: hSeat }, { ws: guest, seat: gSeat }], 0, 10);
  const watch = async (name) => {
    const ws = s.connect(name);
    await s.send(ws, hello(s, name, { spectate: true }));
    return ws;
  };
  const a = await watch('a');
  const b = await watch('b');
  assert.equal(a.take('sync').length, 1);
  assert.equal(b.take('sync').length, 1);
  // Two catch-ups are unconfirmed: a third waits even though the first two finished sending.
  const c = await watch('c');
  assert.equal(c.take('error')[0].code, 'rate_limited');
  await s.send(a, { t: 'synced' });
  const d = await watch('d');
  assert.equal(d.take('sync').length, 1, 'a confirmation frees a place');
  await s.send(a, { t: 'synced' });
  assert.equal(a.take('error')[0].code, 'bad_state', 'nothing left to confirm');
  // A spectator that never confirms is closed once its catch-up time is over.
  t.mock.timers.tick(61_000);
  await play(s, [{ ws: host, seat: hSeat }, { ws: guest, seat: gSeat }], 10, 12);
  await s.session.alarm();
  assert.ok(b.closed && d.closed);
  assert.equal(a.closed, null);
  // A full-size log uses up the byte budget: two catch-ups a minute, then a pause.
  s.session.log.bytes = LOG_MAX_BYTES;
  s.session.catchUpBytes.tokens = s.session.catchUpBytes.burst;
  const e = await watch('e');
  await s.send(e, { t: 'synced' });
  const f = await watch('f');
  await s.send(f, { t: 'synced' });
  const g = await watch('g');
  assert.equal(g.take('error')[0].code, 'rate_limited');
});

test('team chat reaches the team only; spectators chat among themselves', async () => {
  const { s, host, guest, watchers } = await started({ spectators: 1, start: false });
  const w = watchers[0].ws;
  const room = s.session.room;
  const slotOf = (ws) => room.slots.findIndex((x) => x.type === 'human' && x.name === (ws === host ? 'Host' : 'Guest'));
  await s.send(host, { t: 'slot', slot: slotOf(host), team: 1 });
  await s.send(guest, { t: 'slot', slot: slotOf(guest), team: 2 });
  for (const ws of [host, guest, w]) ws.take('chat');
  await s.send(host, { t: 'chat', text: 'flank right', team: true });
  assert.deepEqual(host.take('chat').map((m) => [m.text, m.team]), [['flank right', true]], 'the sender sees it');
  assert.equal(guest.take('chat').length, 0, 'another team does not');
  assert.equal(w.take('chat').length, 0, 'spectators do not');
  await s.send(guest, { t: 'slot', slot: slotOf(guest), team: 1 });
  await s.send(host, { t: 'chat', text: 'together', team: true });
  assert.equal(guest.take('chat').length, 1, 'a team mate does');
  assert.equal(host.take('chat').length, 1);
  assert.equal(w.take('chat').length, 0);
  await s.send(w, { t: 'chat', text: 'nice', team: true });
  assert.equal(w.take('chat').length, 1);
  assert.equal(host.take('chat').length + guest.take('chat').length, 0, 'spectator team chat stays with the spectators');
  await s.send(host, { t: 'chat', text: 'gl hf' });
  assert.equal(guest.take('chat')[0].team, undefined, 'all chat reaches everyone');
  assert.equal(w.take('chat').length, 1);
  for (const ws of [host, guest, w]) assertValid(ws);
});

test("a defeated player's team chat goes to the spectators, and it gets theirs", async () => {
  const { s, host, guest, gw, watchers } = await started({ spectators: 1, start: false });
  const w = watchers[0].ws;
  const room = s.session.room;
  const slotOf = (ws) => room.slots.findIndex((x) => x.type === 'human' && x.name === (ws === host ? 'Host' : 'Guest'));
  await s.send(host, { t: 'slot', slot: slotOf(host), team: 1 });
  await s.send(guest, { t: 'slot', slot: slotOf(guest), team: 1 });
  // A bot on the other side.
  const open = room.slots.findIndex((x) => x.type === 'open');
  await s.send(host, { t: 'slot', slot: open, type: 'ai', difficulty: 'easy' });
  await s.send(host, { t: 'slot', slot: open, team: 2 });
  await s.send(guest, { t: 'ready', ready: true, mapHash: null });
  await s.send(host, { t: 'start' });
  const st = host.last('start');
  assert.ok(st, JSON.stringify([host.take('error'), guest.take('error')]));
  const seats = st.players.filter((p) => p.client !== null).map((p) => ({ ws: p.name === 'Host' ? host : guest, seat: p.player }));
  await play(s, seats, 0, 5);
  for (const ws of [host, guest, w]) ws.take('chat');
  await s.send(guest, { t: 'chat', text: 'before', team: true });
  assert.deepEqual(host.take('chat').map((m) => m.spectators), [undefined], 'a living team mate gets team chat');
  assert.equal(w.take('chat').length, 0);
  guest.take('chat');
  // OpenRA: once the engine defeated it, its team chat is the spectators' (UnitOrders, ExtraData uint.MaxValue).
  await s.send(guest, { t: 'defeated' });
  await s.send(guest, { t: 'chat', text: 'watching now', team: true });
  assert.equal(host.take('chat').length, 0, 'the living team mate does not get it');
  assert.deepEqual(w.take('chat').map((m) => [m.text, m.team, m.spectators]), [['watching now', true, true]], 'the spectators do, marked as theirs');
  assert.equal(guest.take('chat').length, 1, 'the sender sees its line');
  await s.send(w, { t: 'chat', text: 'welcome', team: true });
  assert.equal(guest.take('chat').length, 1, 'a defeated player gets the spectators\' team chat');
  assert.equal(w.take('chat').length, 1, 'the sending spectator sees its line');
  assert.equal(host.take('chat').length, 0);
  await s.send(host, { t: 'chat', text: 'alone now', team: true });
  assert.equal(guest.take('chat').length, 0, "and no longer its old team's");
  assert.equal(host.take('chat').length, 1);
  await s.send(host, { t: 'chat', text: 'gg' });
  assert.deepEqual([guest.take('chat').map((m) => m.text), w.take('chat').map((m) => m.text)], [['gg'], ['gg']], 'all chat still reaches everyone');
  for (const ws of [host, guest, w]) assertValid(ws);
  // A rejoin (the page reloads) keeps the defeat: the seat stays on the spectators' side.
  await s.drop(guest);
  const back = s.connect('guest2');
  await s.send(back, hello(s, 'Guest', { rejoin: { client: gw.you, key: gw.key } }));
  assert.equal(back.take('welcome')[0].role, 'player');
  await s.send(host, { t: 'chat', text: 'team only', team: true });
  assert.equal(back.take('chat').length, 0);
  await s.send(w, { t: 'chat', text: 'spectators', team: true });
  assert.deepEqual(back.take('chat').map((m) => m.text), ['spectators']);
  assertValid(back);
});

test('chat has its own rate limit and a flood closes the connection', async () => {
  const { s, host, guest, watchers } = await started({ spectators: 1 });
  const w = watchers[0].ws;
  for (let i = 0; i < 8; i++) await s.send(w, { t: 'chat', text: `spam ${i}` });
  assert.equal(guest.take('chat').length, 5, 'a burst of five, then one a second');
  assert.equal(w.take('error')[0].code, 'rate_limited');
  assert.equal(w.closed, null);
  for (let i = 0; i < 30; i++) await s.send(w, { t: 'chat', text: 'spam' });
  assert.ok(w.closed, 'flooding closes the connection');
  void host;
});

test('a co-op mission online: the lobby, the start and orders for its own actor types', async () => {
  const { COOP_MISSIONS } = await import('@webra/protocol');
  const m = COOP_MISSIONS.find((x) => x.id === 'exodus');
  const mission = { id: m.id, hash: m.hash, options: { difficulty: 'hard' } };
  const { s, host, guest, hw, gw } = await started({ start: false });
  await s.send(guest, { t: 'mission', mission });
  assert.equal(guest.take('error')[0]?.code, 'not_host');
  await s.send(host, { t: 'mission', mission });
  assert.deepEqual(host.last('lobby').mission, mission);
  await s.send(guest, { t: 'ready', ready: true, mapHash: null });
  await s.send(host, { t: 'start' });
  const st = host.last('start');
  assert.deepEqual(st.mission, mission);
  assert.equal(st.options.players.length, 2);
  const seat = (you) => st.players.find((p) => p.client === you).player;
  // A mission actor type (past the engine's own rules) is a valid order; past the mission's it is not.
  await s.send(host, { t: 'orders', tick: 3, orders: [{ o: 'start_production', player: seat(hw.you), ty: m.actors - 1, count: 1 }] });
  assert.deepEqual(host.take('error'), []);
  await s.send(guest, { t: 'orders', tick: 3, orders: [{ o: 'start_production', player: seat(gw.you), ty: m.actors, count: 1 }] });
  assert.ok(guest.take('error').length > 0 || guest.closed, 'an actor type past the mission rules is refused');
  assertValid(host);
});

test('bulk edit: the host sends one slots message, everyone gets one lobby; a guest is refused', async () => {
  const { s, host, guest } = await started({ start: false });
  const room = s.session.room;
  const slotOf = (name) => room.slots.findIndex((x) => x.type === 'human' && x.name === name);
  const open = room.slots.findIndex((x) => x.type === 'open');
  host.take('lobby');
  guest.take('lobby');
  await s.send(host, { t: 'slots', changes: [{ slot: slotOf('Host'), team: 1 }, { slot: slotOf('Guest'), team: 1 }, { slot: open, type: 'ai', bot: 'rush', team: 2 }] });
  assert.deepEqual([room.slots[slotOf('Host')].team, room.slots[slotOf('Guest')].team, room.slots[open].team, room.slots[open].bot], [1, 1, 2, 'rush']);
  assert.equal(guest.take('lobby').length, 1, 'one lobby update for the whole edit');
  await s.send(guest, { t: 'slots', changes: [{ slot: slotOf('Guest'), team: 2 }] });
  assert.equal(guest.take('error')[0].code, 'not_host');
  assert.equal(room.slots[slotOf('Guest')].team, 1);
  // Removing the guest closes its connection like the slot admin's kick.
  await s.send(host, { t: 'slots', changes: [{ slot: slotOf('Guest'), type: 'open' }] });
  assert.equal(slotOf('Guest'), -1);
  for (const ws of [host, guest]) assertValid(ws);
});

// ---- Realtime presence hints (src/realtime/publish.js) ----------------------------------------

/**
 * A D1 stand-in that knows who is friends with whom (the one read the
 * hints make) and records the directory writes; a hub namespace that
 * records publishes (or throws with `fail`).
 */
function presenceWorld(friends) {
  const writes = [];
  const DB = {
    prepare: (sql) => ({
      // The site settings (no row: the defaults, realtime on).
      first: async () => null,
      bind: (...args) => ({
        run: async () => {
          if (/INSERT INTO sessions/.test(sql)) writes.push(args[0]);
          return { meta: { changes: 1 } };
        },
        first: async () => null,
        all: async () => ({ results: /FROM friendships/.test(sql) ? (friends[args[0]] ?? []).map((id) => ({ id })) : [] }),
      }),
    }),
  };
  const hub = {
    publishes: [],
    fail: false,
    idFromName: (name) => ({ name }),
    get: (id) => ({
      publish: async (e) => {
        if (hub.fail) throw new Error('hub unavailable');
        hub.publishes.push({ to: id.name, kind: e.kind, username: e.data?.username ?? null });
        return 1;
      },
    }),
  };
  return { DB, hub, writes };
}

const account = (n) => ({ id: String(n).repeat(32).slice(0, 32), username: `Player${n}` });

test('presence hints: joining, leaving and starting tell the friends of signed-in members only, once per change', async () => {
  const A = account(1);
  const B = account(2);
  const friendOfA = '9'.repeat(32);
  const friendOfB = '8'.repeat(32);
  const { DB, hub } = presenceWorld({ [A.id]: [friendOfA], [B.id]: [friendOfB] });
  const s = await makeSession({ DB, env: { USER_HUB: hub } });
  const host = s.connect('host', '10.0.0.1', { account: A, refuse: null });
  await s.send(host, hello(s, A.username, { hostKey: s.hostKey }));
  assert.deepEqual(hub.publishes, [{ to: `user:${friendOfA}`, kind: 'presence', username: null }], 'the host is in a lobby now (no name: the hint only says "look again")');
  hub.publishes.length = 0;

  // An anonymous guest changes the room but names nobody new: the host's friends see the count change.
  const anon = s.connect('anon');
  await s.send(anon, hello(s, 'Guest'));
  assert.deepEqual(hub.publishes.map((p) => p.to), [`user:${friendOfA}`], 'no hint for an anonymous member itself');
  hub.publishes.length = 0;

  const guest = s.connect('guest', '10.0.0.3', { account: B, refuse: null });
  await s.send(guest, hello(s, B.username));
  assert.deepEqual(hub.publishes.map((p) => p.to).sort(), [`user:${friendOfA}`, `user:${friendOfB}`].sort());
  hub.publishes.length = 0;

  // A heartbeat with nothing changed tells nobody, also after the object woke up (state from storage).
  await s.session.syncDirectory(true);
  s.session.presence = null;
  s.session.lastDirectoryCore = null;
  await s.session.syncDirectory(true);
  assert.deepEqual(hub.publishes, []);

  // Leaving: the friends of the one who left hear it too.
  await s.send(guest, { t: 'leave' });
  assert.deepEqual(hub.publishes.map((p) => p.to).sort(), [`user:${friendOfA}`, `user:${friendOfB}`].sort());
  hub.publishes.length = 0;

  // The game starts: lobby -> game.
  await s.send(anon, { t: 'ready', ready: true, mapHash: null });
  await s.send(host, { t: 'start' });
  assert.ok(hub.publishes.some((p) => p.to === `user:${friendOfA}`), 'in a game now');
  hub.publishes.length = 0;

  // The session ends: everyone who was in it.
  await s.session.destroy();
  assert.deepEqual(hub.publishes.map((p) => p.to), [`user:${friendOfA}`]);
});

test('presence hints: a failing hub is logged and the directory is written anyway; no binding, no hints', async () => {
  const A = account(1);
  const { DB, hub, writes } = presenceWorld({ [A.id]: ['9'.repeat(32)] });
  hub.fail = true;
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const s = await makeSession({ DB, env: { USER_HUB: hub } });
    const host = s.connect('host', '10.0.0.1', { account: A, refuse: null });
    await s.send(host, hello(s, A.username, { hostKey: s.hostKey }));
    assert.equal(host.take('welcome').length, 1, 'the join went through');
  } finally {
    console.error = realError;
  }
  assert.ok(writes.length > 0, 'the directory row was written');
  assert.ok(errors.some((e) => /realtime publish failed/.test(e)), errors.join('\n'));

  const plain = await makeSession({ DB });
  const h = plain.connect('host', '10.0.0.1', { account: A, refuse: null });
  await plain.send(h, hello(plain, A.username, { hostKey: plain.hostKey }));
  assert.equal(h.take('welcome').length, 1);
});
