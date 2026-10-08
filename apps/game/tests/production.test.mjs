// Sidebar production logic (js/production.js): queued structures, counts,
// placement and cancelling. Pure functions, no DOM or wasm needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BuildEta,
  cancelEndsPlacement,
  clickAction,
  ETA_WINDOW_TICKS,
  formatClock,
  isStructureQueue,
  placementLost,
  SHIFT_COUNT,
  summarizeQueues,
} from '../js/production.js';

const BUILDINGS = 0;
const DEFENSE = 1;
const INFANTRY = 2;
const item = (id, progress = 0, done = false) => ({ id, progress, done });

test('only the Buildings and Defense queues hold structures', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(isStructureQueue), [true, true, false, false, false, false]);
});

test('queue summary counts every queued item and reports the first one', () => {
  const queues = [[item('POWR', 1, true), item('POWR'), item('PROC')], [item('PBOX', 0.5)], [], [], [], []];
  const { perId, activity, ready } = summarizeQueues(queues);
  assert.deepEqual(perId.get('POWR'), { count: 2, progress: 1, done: true });
  assert.deepEqual(perId.get('PROC'), { count: 1, progress: 0, done: false });
  assert.deepEqual(perId.get('PBOX'), { count: 1, progress: 0.5, done: false });
  assert.deepEqual(activity, [3, 1, 0, 0, 0, 0]);
  assert.deepEqual(ready, [true, false, false, false, false, false]);
});

test('left click queues structures (shift queues five) and places a finished one', () => {
  assert.deepEqual(clickAction({ queue: BUILDINGS, enabled: true, ready: false }, false), { place: false, count: 1 });
  assert.deepEqual(clickAction({ queue: BUILDINGS, enabled: true, ready: false }, true), { place: false, count: SHIFT_COUNT });
  assert.deepEqual(clickAction({ queue: DEFENSE, enabled: true, ready: false }, true), { place: false, count: 5 });
  // A ready structure is placed, even with more of it queued behind.
  assert.deepEqual(clickAction({ queue: BUILDINGS, enabled: true, ready: true }, false), { place: true });
  assert.deepEqual(clickAction({ queue: BUILDINGS, enabled: true, ready: true }, true), { place: true });
  // Units never "place".
  assert.deepEqual(clickAction({ queue: INFANTRY, enabled: true, ready: true }, true), { place: false, count: 5 });
});

test('disabled cards (no Construction Yard, missing prerequisites) do not queue', () => {
  assert.equal(clickAction({ queue: BUILDINGS, enabled: false, ready: false }, false), null);
  assert.equal(clickAction({ queue: INFANTRY, enabled: false, ready: false }, true), null);
});

test('right click ends placement only when the finished structure itself is cancelled', () => {
  assert.equal(cancelEndsPlacement({ queue: BUILDINGS, ready: true, queued: 1 }), true);
  // The engine cancels the last queued one first: the ready one stays.
  assert.equal(cancelEndsPlacement({ queue: BUILDINGS, ready: true, queued: 3 }), false);
  assert.equal(cancelEndsPlacement({ queue: BUILDINGS, ready: false, queued: 1 }), false);
  assert.equal(cancelEndsPlacement({ queue: INFANTRY, ready: true, queued: 1 }), false);
});

test('placement mode ends when the engine cancels the finished structure', () => {
  const ready = summarizeQueues([[item('POWR', 1, true)], [], [], [], [], []]).perId;
  const building = summarizeQueues([[item('POWR', 0.2)], [], [], [], [], []]).perId;
  const empty = summarizeQueues([[], [], [], [], [], []]).perId;
  assert.equal(placementLost(ready, 'POWR'), false);
  assert.equal(placementLost(ready, null), false);
  // Construction Yard or prerequisite lost: the item is gone (refunded).
  assert.equal(placementLost(empty, 'POWR'), true);
  assert.equal(placementLost(building, 'POWR'), true);
});

test('game clock text: mm:ss, hours when needed', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(15.9), '00:15');
  assert.equal(formatClock(75), '01:15');
  assert.equal(formatClock(3599), '59:59');
  assert.equal(formatClock(3600 + 61), '1:01:01');
  assert.equal(formatClock(-4), '00:00');
});

test('build time left is estimated from the progress rate', () => {
  const eta = new BuildEta();
  assert.equal(eta.observe(0, 100), null, 'one sample: unknown');
  // 1% per tick: 90 ticks left at 10%.
  assert.equal(eta.observe(0.1, 110), 90);
  assert.equal(eta.observe(0.5, 150), 50);
  assert.equal(eta.observe(1, 200), 0);
});

test('build time follows a slowdown (low power) within the window', () => {
  const eta = new BuildEta();
  for (let t = 0; t <= 50; t += 5) eta.observe(t / 100, t); // 1% per tick
  // Low power: half speed from tick 50 on.
  let left;
  for (let t = 55; t <= 50 + ETA_WINDOW_TICKS + 5; t += 5) left = eta.observe(0.5 + (t - 50) / 200, t);
  const progress = 0.5 + (ETA_WINDOW_TICKS + 5) / 200;
  assert.equal(left, Math.ceil((1 - progress) * 200), 'only the slow samples count once the window passed');
});

test('a stalled build keeps its last estimate; a new item starts over', () => {
  const eta = new BuildEta();
  eta.observe(0, 0);
  assert.equal(eta.observe(0.2, 20), 80);
  // Out of money: progress stops, the clock stays.
  assert.equal(eta.observe(0.2, 30), 80);
  assert.equal(eta.observe(0.2, 90), 80);
  // The next item of the queue: progress went back to the start.
  assert.equal(eta.observe(0.01, 100), null);
  assert.equal(eta.observe(0.11, 110), 89);
  eta.reset();
  assert.equal(eta.observe(0.5, 120), null);
});

test('the same tick observed twice does not count as time passing', () => {
  const eta = new BuildEta();
  eta.observe(0, 10);
  eta.observe(0.1, 20);
  assert.equal(eta.observe(0.1, 20), 90);
  assert.equal(eta.samples.length, 2);
});
