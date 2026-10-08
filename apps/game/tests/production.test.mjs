// Sidebar production logic (js/production.js): queued structures, counts,
// placement and cancelling. Pure functions, no DOM or wasm needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelEndsPlacement, clickAction, isStructureQueue, placementLost, SHIFT_COUNT, summarizeQueues } from '../js/production.js';

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
