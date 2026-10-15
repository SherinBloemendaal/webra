import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_GRACE_MS, Lockstep, LockstepError, MIN_PROGRESS_FRAMES } from '../src/lockstep.js';
import { TokenBucket } from '../src/ratelimit.js';

const stop = (ids, player = 0) => ({ o: 'stop', player, ids });

test('initial frames cover ticks before the order delay', () => {
  const ls = new Lockstep({ players: [0, 1], delay: 3 });
  assert.deepEqual(ls.initialFrames(), [
    { tick: 0, orders: [] },
    { tick: 1, orders: [] },
    { tick: 2, orders: [] },
  ]);
  assert.equal(ls.next, 3);
});

test('a frame is emitted only when every active player delivered, stamped by the server', () => {
  const ls = new Lockstep({ players: [0, 2], delay: 3 });
  ls.initialFrames();
  // Player 2 claims to be player 0 inside its order: the stamp wins.
  assert.deepEqual(ls.submit(2, 3, [stop([5], 0)]), []);
  const frames = ls.submit(0, 3, []);
  assert.deepEqual(frames, [{ tick: 3, orders: [[2, [{ o: 'stop', player: 2, ids: [5] }]]] }]);
  // Several frames can complete at once.
  ls.submit(0, 4, [stop([1])]);
  ls.submit(0, 5, []);
  assert.deepEqual(ls.submit(2, 4, []).map((f) => f.tick), [4]);
  const out = ls.submit(2, 5, [stop([9], 2)]);
  assert.deepEqual(out, [{ tick: 5, orders: [[2, [stop([9], 2)]]] }]);
});

test('out of order, duplicate, too early and unknown submissions are refused', () => {
  const ls = new Lockstep({ players: [0, 1], delay: 3 });
  ls.initialFrames();
  assert.throws(() => ls.submit(0, 4, []), LockstepError);
  ls.submit(0, 3, []);
  assert.throws(() => ls.submit(0, 3, []), /expected/);
  // Player 0 cannot run more than `delay` ticks past the last frame.
  ls.submit(0, 4, []);
  ls.submit(0, 5, []);
  ls.submit(0, 6, []);
  assert.throws(() => ls.submit(0, 7, []), /too far ahead/);
  assert.throws(() => ls.submit(5, 3, []), /not an active player/);
});

test('dropping a silent player completes waiting frames and discards their orders', () => {
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: 0 });
  ls.initialFrames();
  ls.submit(0, 3, [stop([1])], 5000);
  ls.submit(1, 3, [stop([2], 1)], 5000);
  ls.submit(0, 4, [], 9000);
  assert.deepEqual(ls.silent(16000, 10_000), [1]);
  ls.submit(1, 4, [stop([3], 1)], 9000);
  ls.submit(1, 5, [stop([4], 1)], 9000);
  const frames = ls.drop(1);
  assert.deepEqual(frames, [], 'frame 4 was already complete, frame 5 waits for player 0');
  assert.deepEqual(ls.submit(0, 5, [], 9500), [{ tick: 5, orders: [] }], 'dropped orders are gone');
  assert.equal(ls.isActive(1), false);
  assert.deepEqual(ls.drop(1), []);
  ls.drop(0);
  assert.equal(ls.finished, true);
});

/**
 * Play `ms` of wall time in 100 ms steps. Player 0 is a fast honest client:
 * it always submits as far ahead as the server allows. `slow(t)` says how many
 * ticks player 1 submits at time t. Returns when player 1 is reported silent
 * (the time) or null.
 */
function race(slow, ms = 120_000) {
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: 0 });
  ls.initialFrames();
  for (let t = 0; t <= ms; t += 100) {
    while (ls.expected.get(0) <= ls.next + ls.delay) ls.submit(0, ls.expected.get(0), [], t);
    for (let k = slow(t); k > 0 && ls.expected.get(1) <= ls.next + ls.delay; k--) ls.submit(1, ls.expected.get(1), [], t);
    const silent = ls.silent(t, 10_000);
    assert.ok(!silent.includes(0), 'the fast player is never blamed');
    if (silent.includes(1)) return t;
  }
  return null;
}

test('a player trickling one tick every 9 s is dropped, slow but steady players are not', () => {
  // N4: lastSeen was refreshed by every submission, so this stalled games forever.
  const dropped = race((t) => (t > 0 && t % 9000 === 0 ? 1 : 0));
  assert.ok(dropped !== null && dropped <= 21_000, `dropped at ${dropped}`);
  // A slow machine (a few ticks per second) holds everyone up but keeps the game going.
  assert.equal(race((t) => (t % 1000 === 0 ? 5 : 0)), null);
  // A long hiccup followed by catching up is fine too.
  assert.equal(race((t) => (t >= 2000 && t < 10_000 ? 0 : 3)), null);
  // Just below the minimum rate is not.
  const per = Math.max(1, Math.floor(MIN_PROGRESS_FRAMES / 10) - 1);
  assert.notEqual(race((t) => (t % 1000 === 0 ? per : 0)), null);
  // A player that delivered ahead is not holding anyone up, however long it stays quiet.
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: 0 });
  ls.initialFrames();
  for (const tick of [3, 4, 5, 6]) ls.submit(1, tick, [], 0);
  ls.submit(0, 3, [], 0);
  assert.deepEqual(ls.silent(30_000, 10_000), [0]);
});

test('two seats taking turns at holding the game up are dropped too', () => {
  // Re-audit of N4: seats 1 and 2 stay one frame apart and swap the holder
  // role every 9 s, so a clock that restarts whenever a player goes ahead never fired.
  const ls = new Lockstep({ players: [0, 1, 2], delay: 3, now: 0 });
  ls.initialFrames();
  // The honest seat runs at about 30 ticks per second, as far ahead as allowed.
  const fill = (p, t) => {
    for (let k = 0; k < 3 && ls.expected.get(p) <= ls.next + ls.delay; k++) ls.submit(p, ls.expected.get(p), [], t);
  };
  ls.submit(2, 3, [], 0);
  ls.submit(2, 4, [], 0);
  ls.submit(1, 3, [], 0);
  let holder = 1;
  let lastSwap = 0;
  const dropped = [];
  let t = 0;
  for (; t <= 600_000 && dropped.length < 2; t += 100) {
    fill(0, t);
    if (t - lastSwap >= 9000) {
      // The holder delivers until it is one frame past the other colluder (or one tick when alone).
      const other = holder === 1 ? 2 : 1;
      const alone = !ls.isActive(other);
      while (ls.expected.get(holder) <= ls.next + ls.delay && (alone || ls.expected.get(holder) <= ls.expected.get(other))) {
        ls.submit(holder, ls.expected.get(holder), [], t);
        if (alone) break;
      }
      if (!alone) holder = other;
      lastSwap = t;
    }
    const silent = ls.silent(t, 10_000);
    assert.ok(!silent.includes(0), 'the honest seat is never blamed');
    for (const p of silent) {
      dropped.push([p, t]);
      ls.drop(p, t);
      if (p === holder) holder = p === 1 ? 2 : 1;
    }
  }
  assert.equal(dropped.length, 2, JSON.stringify(dropped));
  assert.ok(dropped[0][1] <= 30_000 && t <= 60_000, JSON.stringify(dropped));
  // Once the colluders are gone the honest seat plays on at full speed.
  const before = ls.next;
  for (const end = t + 60_000; t <= end; t += 100) {
    fill(0, t);
    assert.deepEqual(ls.silent(t, 10_000), []);
  }
  assert.ok(ls.next - before > 500);
});

test('three seats rotating the stall are all dropped, the honest seat plays on', () => {
  // Re-audit: each seat stayed under its own 10 s, so k seats taking turns
  // slowed the game to 2.5 / k ticks per second without anyone being dropped.
  const ls = new Lockstep({ players: [0, 1, 2, 3], delay: 3, now: 0 });
  ls.initialFrames();
  const colluders = [1, 2, 3];
  const fill = (p, t) => {
    for (let k = 0; k < 3 && ls.expected.get(p) <= ls.next + ls.delay; k++) ls.submit(p, ls.expected.get(p), [], t);
  };
  let holder = 1;
  let since = 0;
  const dropped = [];
  let t = 0;
  for (; t <= 300_000 && dropped.length < 3; t += 100) {
    fill(0, t);
    const alive = colluders.filter((c) => ls.isActive(c));
    if (!ls.isActive(holder)) holder = alive[0];
    // Every 9 s the holder delivers one frame and the next seat takes over;
    // the others always stay exactly one frame ahead.
    if (t - since >= 9000) {
      while (ls.expected.get(holder) <= ls.next) ls.submit(holder, ls.expected.get(holder), [], t);
      holder = alive[(alive.indexOf(holder) + 1) % alive.length];
      since = t;
    }
    for (const c of alive) {
      while (c !== holder && ls.expected.get(c) <= ls.next) ls.submit(c, ls.expected.get(c), [], t);
    }
    const silent = ls.silent(t, 10_000);
    assert.ok(!silent.includes(0), `the honest seat is never blamed (t=${t})`);
    for (const p of silent) {
      dropped.push([p, t]);
      ls.drop(p, t);
    }
  }
  assert.deepEqual(dropped.map(([p]) => p).sort(), colluders, JSON.stringify(dropped));
  assert.ok(t <= 60_000, `all dropped by ${t}`);
  const before = ls.next;
  for (const end = t + 30_000; t <= end; t += 100) {
    fill(0, t);
    assert.deepEqual(ls.silent(t, 10_000), []);
  }
  assert.ok(ls.next - before > 500);
});

test('an honest seat answering within the grace is never blamed for others stalling', () => {
  // Seat 0 sends tick T + delay one round trip (900 ms) after frame T went
  // out; seat 1 stalls 9.5 s, then releases frames in a burst, so seat 0 is
  // the last to deliver while it catches up.
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: 0 });
  const out = new Map();
  for (const f of ls.initialFrames()) out.set(f.tick, 0);
  const record = (frames, t) => frames.forEach((f) => out.set(f.tick, t));
  let t = 0;
  for (; t <= 120_000; t += 50) {
    for (;;) {
      const tick = ls.expected.get(0);
      const e = out.get(tick - ls.delay);
      if (e === undefined || t < e + 900 || tick > ls.next + ls.delay) break;
      record(ls.submit(0, tick, [], t), t);
    }
    if (ls.isActive(1) && t % 10_000 === 9500) {
      for (let k = 0; k < 20 && ls.expected.get(1) <= ls.next + ls.delay; k++) record(ls.submit(1, ls.expected.get(1), [], t), t);
    }
    const silent = ls.silent(t, 10_000);
    assert.ok(!silent.includes(0), `the honest seat is never blamed (t=${t})`);
    for (const p of silent) record(ls.drop(p, t), t);
  }
  assert.equal(ls.isActive(1), false, 'the staller is dropped');
});

test('a griefer cannot get an honest seat dropped for one freeze', () => {
  // Re-audit: the age rule dropped whoever held longest in a stalled window.
  // A griefer playing at the edge of the grace (never counted) stalled just
  // under the honest seat's hold time after one freeze of the honest client,
  // and the honest seat was dropped. Now only a seat's own holds count.
  const held = (ls, p, t) => {
    const w = ls.windows.get(p);
    return w.heldMs + (w.at === null ? 0 : Math.max(0, t - Math.max(w.at, w.ready)));
  };
  for (const freeze of [1500, 2500, 5000]) {
    for (let at = 80; at < 107; at += 2) {
      const ls = new Lockstep({ players: [0, 1], delay: 3, now: 0 });
      const out = new Map();
      for (const f of ls.initialFrames()) out.set(f.tick, 0);
      const send = (p, t) => ls.submit(p, ls.expected.get(p), [], t).forEach((f) => out.set(f.tick, t));
      const due = (p) => out.get(ls.expected.get(p) - ls.delay);
      for (let t = 0; t <= 60_000; t += 10) {
        // Honest seat: 300 ms round trip, one freeze of the client at tick `at`.
        for (let e = due(0); e !== undefined && ls.expected.get(0) <= ls.next + ls.delay; e = due(0)) {
          if (t < e + 300 + (ls.expected.get(0) === at ? freeze : 0)) break;
          send(0, t);
        }
        // Griefer: answers at the very end of the grace, and keeps holding as
        // long as its own hold time stays under the honest seat's.
        for (let e = due(1); e !== undefined && ls.expected.get(1) <= ls.next + ls.delay; e = due(1)) {
          if (t < e + HOLD_GRACE_MS - 15) break;
          if (ls.expected.get(1) <= ls.next && held(ls, 1, t) + 75 < held(ls, 0, t)) break;
          send(1, t);
        }
        if (t % 1000 === 0) assert.ok(!ls.silent(t, 10_000).includes(0), `freeze ${freeze} at tick ${at}: honest seat dropped at ${t}`);
      }
    }
  }
});

test('stalling again and again is dropped even under the per-window limit', () => {
  // Seat 1 holds the game up 6 s out of every 10 s, each window under the
  // 10 s limit: its debt grows faster than it drains, and it is dropped.
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: 0 });
  ls.initialFrames();
  let dropped = null;
  for (let t = 0; t <= 120_000 && dropped === null; t += 100) {
    for (let k = 0; k < 3 && ls.expected.get(0) <= ls.next + ls.delay; k++) ls.submit(0, ls.expected.get(0), [], t);
    if (t % 10_000 >= 6000) {
      for (let k = 0; k < 3 && ls.expected.get(1) <= ls.next + ls.delay; k++) ls.submit(1, ls.expected.get(1), [], t);
    }
    const silent = ls.silent(t, 10_000);
    assert.ok(!silent.includes(0));
    if (silent.includes(1)) dropped = t;
  }
  assert.ok(dropped !== null && dropped <= 60_000, `dropped at ${dropped}`);
});

test('drop can unblock a frame', () => {
  const ls = new Lockstep({ players: [0, 1], delay: 3 });
  ls.initialFrames();
  ls.submit(0, 3, [stop([1])]);
  assert.deepEqual(ls.drop(1), [{ tick: 3, orders: [[0, [stop([1])]]] }]);
});

test('state hashes: matching reports pass, the first mismatch is reported once', () => {
  const ls = new Lockstep({ players: [0, 1], delay: 3 });
  ls.initialFrames();
  for (let t = 3; t < 60; t++) {
    ls.submit(0, t, []);
    ls.submit(1, t, []);
  }
  assert.throws(() => ls.hash(0, 26, 'aa'), /bad hash tick/);
  assert.throws(() => ls.hash(0, 75, 'aa'), /not been sent/);
  assert.equal(ls.hash(0, 0, 'aa'), null);
  assert.equal(ls.hash(1, 0, 'aa'), null);
  assert.throws(() => ls.hash(0, 0, 'aa'), /increase/);
  assert.equal(ls.hash(0, 25, 'aa'), null);
  assert.deepEqual(ls.hash(1, 25, 'bb'), { tick: 25, players: [0, 1] }, '1 against 1: nobody knows who is right, tell both');
  assert.equal(ls.hash(0, 50, 'cc'), null, 'reported only once');
  assert.equal(ls.desyncTick, 25);
});

test('token bucket: burst, steady rate, refusals counted', () => {
  const b = new TokenBucket(60, 120, 0);
  let ok = 0;
  for (let i = 0; i < 200; i++) if (b.take(0)) ok++;
  assert.equal(ok, 120);
  assert.equal(b.refused, 80);
  assert.equal(b.take(1000 / 60), true, 'one token per 1/60 s');
  assert.equal(b.take(1000 / 60), false);
  // 25 orders + 1 hash per second for a minute stays well within the limit.
  const g = new TokenBucket(60, 120, 0);
  for (let t = 0; t < 60_000; t += 38) assert.equal(g.take(t), true);
});

test('one lying player cannot raise a desync for everyone', () => {
  const ls = new Lockstep({ players: [0, 1, 2], delay: 3 });
  ls.initialFrames();
  for (let t = 0; t < 30; t++) for (const p of [0, 1, 2]) ls.submit(p, t + 3, []);
  assert.equal(ls.hash(0, 25, 'good'), null);
  assert.equal(ls.hash(2, 25, 'lie'), null, 'waits for everyone');
  assert.deepEqual(ls.hash(1, 25, 'good'), { tick: 25, players: [2] }, 'only the outlier is told');
  assert.equal(ls.desyncTick, null, 'the game is not declared out of sync');
});

test('a suspended player is not waited for and rejoins at a future tick', () => {
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: 0 });
  ls.initialFrames();
  ls.submit(0, 3, [], 100);
  const { frames, record } = ls.suspend(1, 200);
  assert.deepEqual(frames.map((f) => f.tick), [3], 'its missing orders no longer hold frame 3');
  assert.ok(record && record.debtMs === 0);
  assert.equal(ls.isActive(1), false);
  assert.throws(() => ls.submit(1, 4, []), /not an active player/);
  for (let t = 4; t <= 7; t++) ls.submit(0, t, [], 300);
  assert.equal(ls.next, 8);
  const at = ls.rejoin(1, record, 400);
  assert.equal(at, 11, 'next + delay');
  assert.throws(() => ls.rejoin(1, record, 400), /already/);
  // Frames 8..10 do not wait for the rejoined player, frame 11 does.
  assert.deepEqual([8, 9, 10].flatMap((t) => ls.submit(0, t, [], 500)).map((f) => f.tick), [8, 9, 10]);
  assert.deepEqual(ls.submit(0, 11, [stop([1])], 500), []);
  assert.throws(() => ls.submit(1, 10, [], 500), /11 expected/);
  assert.deepEqual(ls.submit(1, 11, [stop([2], 0)], 500), [{ tick: 11, orders: [[0, [stop([1])]], [1, [stop([2], 1)]]] }]);
  // Hashes: the rejoined player votes from its join tick on only.
  assert.throws(() => ls.hash(1, 0, 'aa'), /before you rejoined/);
});

test('a rejoin never refills the stall budget', () => {
  // Player 1 holds the game up for 9 s (just under the limit), drops out,
  // rejoins and holds it up again briefly: its debt drops it.
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: 0 });
  ls.initialFrames();
  for (let t = 3; t <= 6; t++) ls.submit(0, t, [], 0);
  assert.deepEqual(ls.silent(10_000, 10_000), [], 'one 9 s freeze is never dropped');
  const { record } = ls.suspend(1, 10_000);
  assert.ok(record.debtMs >= 8_900 && record.debtMs <= 9_000, `debt ${record.debtMs}`);
  // Two seconds away drain 100 ms.
  const at = ls.rejoin(1, record, 12_000);
  for (let t = 7; t < at; t++) ls.submit(0, t, [], 12_000);
  for (let t = at; t <= at + 3; t++) ls.submit(0, t, [], 12_000);
  // Player 1 now holds frame `at` beyond its grace for 1.5 s more.
  assert.deepEqual(ls.silent(13_000, 10_000), []);
  assert.deepEqual(ls.silent(14_600, 10_000), [1]);
  // A fresh seat with the same 1.5 s hold would not have been dropped.
  const fresh = new Lockstep({ players: [0, 1], delay: 3, now: 0 });
  fresh.initialFrames();
  for (let t = 3; t <= 6; t++) fresh.submit(0, t, [], 0);
  assert.deepEqual(fresh.silent(2_600, 10_000), []);
});

test('agreed hashes: the majority hash is kept for rejoin checks', () => {
  const ls = new Lockstep({ players: [0, 1, 2], delay: 3, now: 0 });
  ls.initialFrames();
  for (let t = 3; t <= 26; t++) for (const p of [0, 1, 2]) ls.submit(p, t, [], 0);
  assert.equal(ls.agreed, null);
  ls.hash(0, 25, 'aa');
  ls.hash(1, 25, 'aa');
  assert.equal(ls.agreed, null, 'not before every player reported');
  assert.deepEqual(ls.hash(2, 25, 'bb'), { tick: 25, players: [2] });
  assert.deepEqual(ls.agreed, { tick: 25, hash: 'aa' });
});

test('a defeated seat keeps playing in step, but its orders never reach a frame', () => {
  const ls = new Lockstep({ players: [0, 1], delay: 3 });
  ls.initialFrames();
  // Already waiting for a later frame when the defeat is reported: dropped too.
  ls.submit(1, 3, [stop([7], 1)]);
  assert.equal(ls.defeat(1), true);
  assert.equal(ls.defeat(1), false, 'reported once');
  assert.deepEqual(ls.submit(0, 3, [stop([1])]), [{ tick: 3, orders: [[0, [stop([1])]]] }]);
  // It still has to deliver every tick (it watches the game), only empty.
  assert.deepEqual(ls.submit(0, 4, []), []);
  assert.deepEqual(ls.submit(1, 4, [stop([8], 1)]), [{ tick: 4, orders: [] }]);
  // Kept across a lost connection and a rejoin.
  ls.suspend(1);
  const at = ls.rejoin(1, null);
  for (let t = 5; t < at; t++) ls.submit(0, t, []);
  ls.submit(0, at, []);
  assert.deepEqual(ls.submit(1, at, [stop([9], 1)]), [{ tick: at, orders: [] }]);
  assert.throws(() => ls.defeat(5), LockstepError, 'only seats of the game');
});

test('a surrender is relayed to every peer like any order, stamped with the sender, then the seat is defeated', () => {
  // The game menu's Surrender (engine/src/gamerules.rs): an order of the frame, so every peer applies it on the same tick.
  const ls = new Lockstep({ players: [0, 1, 2], delay: 3 });
  ls.initialFrames();
  ls.submit(0, 3, []);
  ls.submit(2, 3, []);
  // Player 1 names player 0 inside its order: the stamp wins, only the sender gives up.
  assert.deepEqual(ls.submit(1, 3, [{ o: 'surrender', player: 0 }]), [{ tick: 3, orders: [[1, [{ o: 'surrender', player: 1 }]]] }]);
  // Its engine defeated it on tick 3: the client reports it and its seat sends only empty orders from then on.
  assert.equal(ls.defeat(1), true);
  ls.submit(0, 4, []);
  ls.submit(2, 4, []);
  assert.deepEqual(ls.submit(1, 4, [{ o: 'surrender', player: 1 }]), [{ tick: 4, orders: [] }]);
});

// ---- Protocol 8: the start gate, the stall log, the waiting player -----------------------------

import { LOAD_TIMEOUT_MS } from '@webra/protocol';

test('start gate: no frame past the start frames until every seat loaded; the wait costs nobody anything', () => {
  const t0 = 1_000_000;
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: t0, loading: [0, 1] });
  assert.deepEqual(ls.initialFrames().map((f) => f.tick), [0, 1, 2]);
  assert.equal(ls.starting, true);
  // Seat 0 loaded fast and runs ahead to its limit; seat 1 is still loading.
  assert.deepEqual(ls.loaded(0, t0 + 1000), []);
  ls.submit(0, 3, [], t0 + 1000);
  ls.submit(1, 3, [], t0 + 1000);
  assert.equal(ls.next, 3, 'frame 3 waits for the gate even with every order in');
  assert.deepEqual(ls.silent(t0 + 30_000, 10_000), [], 'a long load is no stall');
  assert.equal(ls.waiting(t0 + 30_000, 10_000), null);
  for (const w of ls.windows.values()) assert.deepEqual([w.heldMs, w.debtMs], [0, 0]);
  // The last seat loads: the frames go out and the stall clocks start now.
  const t1 = t0 + 40_000;
  assert.deepEqual(ls.loaded(1, t1).map((f) => f.tick), [3]);
  assert.equal(ls.starting, false);
  assert.deepEqual(ls.loaded(1, t1), [], 'a repeat is ignored');
  assert.equal(ls.stalls.length, 0);
  for (const w of ls.windows.values()) assert.equal(w.debtMs, 0);
  assert.deepEqual(ls.silent(t1 + 500, 10_000), []);
});

test('start gate: a seat that never loads is reported after LOAD_TIMEOUT_MS; dropping it starts the others', () => {
  const t0 = 2_000_000;
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: t0, loading: [0, 1] });
  ls.initialFrames();
  ls.loaded(0, t0 + 2000);
  ls.submit(0, 3, [], t0 + 2000);
  assert.deepEqual(ls.silent(t0 + LOAD_TIMEOUT_MS, 10_000), []);
  assert.deepEqual(ls.silent(t0 + LOAD_TIMEOUT_MS + 1, 10_000), [1]);
  const { frames } = ls.suspend(1, t0 + LOAD_TIMEOUT_MS + 1);
  assert.deepEqual(frames.map((f) => f.tick), [3]);
  assert.equal(ls.starting, false);
  assert.equal(ls.stalls.length, 0, 'the load wait is not a stall');
});

test('stall log: waits beyond the grace are logged per seat with the frame they held; waiting names the seat', () => {
  const t0 = 3_000_000;
  const ls = new Lockstep({ players: [0, 1], delay: 3, now: t0 });
  ls.initialFrames();
  // Both deliver frame 3 at once: nothing logged.
  ls.submit(0, 3, [], t0 + 100);
  ls.submit(1, 3, [], t0 + 100);
  // Seat 0 delivers 4; seat 1 could have since frame 3 went out (t0 + 100) but takes 2.5 s.
  ls.submit(0, 4, [], t0 + 150);
  assert.equal(ls.waiting(t0 + 800, 10_000), null, 'within the grace nobody waits');
  const w = ls.waiting(t0 + 1500, 10_000);
  assert.equal(w.seat, 1);
  assert.equal(w.heldMs, 1400);
  // Its window counted 500 ms beyond the grace: 9.5 s left.
  assert.equal(w.dropInMs, 9500);
  ls.submit(1, 4, [], t0 + 2600);
  assert.deepEqual(ls.stalls, [{ tick: 4, seat: 1, ms: 2500 }]);
  assert.deepEqual(ls.totals.get(1), { ms: 2500, count: 1 });
  assert.equal(ls.waiting(t0 + 2600, 10_000), null, 'the frames behind a stall are not stalls of their own');
  // A wait that ends with the seat leaving is logged too (frame 5 waits since frame 4 went out).
  ls.submit(0, 5, [], t0 + 2700);
  ls.suspend(1, t0 + 5000);
  assert.deepEqual(ls.stalls.at(-1), { tick: 5, seat: 1, ms: 2400 });
  assert.equal(ls.totals.get(1).count, 2);
});

test('stall log keeps the newest STALL_LOG_MAX entries; totals keep counting', async () => {
  const { STALL_LOG_MAX } = await import('@webra/protocol');
  const ls = new Lockstep({ players: [0], delay: 1, now: 0 });
  ls.initialFrames();
  let now = 0;
  for (let t = 1; t <= STALL_LOG_MAX + 5; t++) {
    now += 1500;
    ls.submit(0, t, [], now);
  }
  assert.equal(ls.stalls.length, STALL_LOG_MAX);
  assert.equal(ls.totals.get(0).count, STALL_LOG_MAX + 5);
  assert.equal(ls.stalls.at(-1).tick, STALL_LOG_MAX + 5);
});
