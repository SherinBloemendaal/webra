import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lockstep, LockstepError, MIN_PROGRESS_FRAMES } from '../src/lockstep.js';
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
