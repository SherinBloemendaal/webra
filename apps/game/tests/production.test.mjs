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
  rightClickAction,
  queueOutcome,
  ITEM_LIMIT,
  RIGHT_CLICK_STYLES,
  shortOfFunds,
} from '../js/production.js';

const BUILDINGS = 0;
const DEFENSE = 1;
const INFANTRY = 2;
const item = (id, progress = 0, done = false) => ({ id, progress, done });

const PAUSE = { kind: 'pause' };
const cancel = (count) => ({ kind: 'cancel', count });
const head = (count, o = {}) => ({ count, done: false, paused: false, started: true, ...o });

test('right clicks hold the item that is being built and cancel the rest, as in OpenRA', () => {
  assert.equal(rightClickAction(undefined), null, 'nothing queued');
  assert.deepEqual(rightClickAction(head(1)), PAUSE);
  assert.deepEqual(rightClickAction(head(1, { paused: true })), cancel(1), 'a held item is cancelled');
  assert.deepEqual(rightClickAction(head(1, { started: false })), cancel(1), 'nothing paid yet');
  assert.deepEqual(rightClickAction(head(1, { done: true })), cancel(1), 'a finished item');
  // OpenRA HandleRightClick: hold first even with more queued, then cancel the
  // most recently queued (CancelProduction takes the last), Shift five.
  assert.deepEqual(rightClickAction(head(3), { style: 'openra' }), PAUSE);
  assert.deepEqual(rightClickAction(head(3, { paused: true }), { style: 'openra' }), cancel(1));
  assert.deepEqual(rightClickAction(head(3), { style: 'openra', many: SHIFT_COUNT }), PAUSE, 'Shift does not skip the hold');
  assert.deepEqual(rightClickAction(head(8, { paused: true }), { style: 'openra', many: SHIFT_COUNT }), cancel(5));
  assert.deepEqual(rightClickAction(head(8, { started: false }), { many: 5 }), cancel(5), 'openra is the default');
  const [held] = summarizeQueues([[{ id: 'E1', progress: 0.3, done: false, paused: true, started: true }, item('E1')], [], [], [], [], []]).perId.values();
  assert.deepEqual(held, { count: 2, progress: 0.3, done: false, paused: true, started: true }, 'the first queued one counts');
});

test('WebRA style: a stack, the most recently queued go first, the one being built last', () => {
  assert.deepEqual(RIGHT_CLICK_STYLES, ['openra', 'webra']);
  const webra = (h, many = 1) => rightClickAction(h, { style: 'webra', many });
  // 3 -> 2 -> 1, then hold, then cancel.
  assert.deepEqual(webra(head(3)), cancel(1));
  assert.deepEqual(webra(head(2)), cancel(1));
  assert.deepEqual(webra(head(1)), PAUSE);
  assert.deepEqual(webra(head(1, { paused: true })), cancel(1));
  // Shift: five from the top, never the one being built while others wait.
  assert.deepEqual(webra(head(8), 5), cancel(5));
  assert.deepEqual(webra(head(4), 5), cancel(3));
  assert.deepEqual(webra(head(1), 5), PAUSE);
  // Not started (no credits yet), held or finished: cancelled straight away.
  assert.deepEqual(webra(head(3, { started: false })), cancel(1));
  assert.deepEqual(webra(head(1, { started: false }), 5), cancel(5));
  assert.deepEqual(webra(head(2, { done: true })), cancel(1));
  assert.equal(webra(undefined), null);
});

test('a click says Building, Unable to build more or Building in progress (OpenRA CanQueue), never for money', () => {
  assert.equal(queueOutcome({}), 'queued');
  assert.equal(queueOutcome({ itemRoom: 999, limitLeft: null }), 'queued');
  assert.equal(queueOutcome({ itemRoom: 5, limitLeft: 0 }), 'blocked', 'BuildLimit reached');
  assert.equal(queueOutcome({ itemRoom: 0, limitLeft: 3 }), 'limited', 'ItemLimit reached');
  assert.equal(queueOutcome({ itemRoom: 0, limitLeft: 0 }), 'limited', 'OpenRA checks ItemLimit first');
  assert.equal(queueOutcome({ itemRoom: null, limitLeft: null }), 'queued', 'the all tech cheat');
  assert.equal(ITEM_LIMIT, 999, 'engine/src/production.rs ITEM_LIMIT');
});

test('short of funds: the queued items the credits do not cover yet, counted from each head', () => {
  const costs = { E1: 100, E3: 300, POWR: 300, TENT: 500 };
  const costOf = (id) => costs[id];
  const it = (id, paid = 0, done = false) => ({ id, progress: 0, done, paid });
  const queues = [[it('POWR', 300, true), it('TENT')], [], [it('E1', 60), it('E3'), it('E1'), it('E1')], [], [], []];
  // Infantry: 40 + 300 + 100 + 100 still to pay; Buildings: the ready plant is paid, 500 for the barracks.
  assert.deepEqual([...shortOfFunds(queues, 1000, costOf)], []);
  assert.deepEqual([...shortOfFunds(queues, 440, costOf)], [['TENT', 1], ['E1', 1]]);
  assert.deepEqual([...shortOfFunds(queues, 340, costOf)], [['TENT', 1], ['E1', 2]]);
  assert.deepEqual([...shortOfFunds(queues, 0, costOf)], [['TENT', 1], ['E1', 3], ['E3', 1]], 'no money: every unpaid item');
  assert.deepEqual([...shortOfFunds([[it('POWR', 300, true)]], 0, costOf)], [], 'a finished one is paid');
});

test('only the Buildings and Defense queues hold structures', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(isStructureQueue), [true, true, false, false, false, false]);
});

test('queue summary counts every queued item and reports the first one', () => {
  const queues = [[item('POWR', 1, true), item('POWR'), item('PROC')], [item('PBOX', 0.5)], [], [], [], []];
  const { perId, activity, ready } = summarizeQueues(queues);
  assert.deepEqual(perId.get('POWR'), { count: 2, progress: 1, done: true, paused: false, started: false });
  assert.deepEqual(perId.get('PROC'), { count: 1, progress: 0, done: false, paused: false, started: false });
  assert.deepEqual(perId.get('PBOX'), { count: 1, progress: 0.5, done: false, paused: false, started: false });
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
  assert.equal(cancelEndsPlacement({ queue: BUILDINGS, ready: true, queued: 3 }, 5), true, 'Shift cancels all three');
  assert.equal(cancelEndsPlacement({ queue: BUILDINGS, ready: true, queued: 6 }, 5), false);
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
  // Money again: the rate is measured from the stall on, not across it.
  assert.equal(eta.observe(0.25, 95), 75);
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

// ---- Sidebar card clicks (js/sidebar.js onCardClick, onCardCancel) ----------------------

/** A Sidebar `this` with one card per entry and a game that records orders. */
async function fakeSidebar(cards, { style = 'openra', latched = false, state = null } = {}) {
  const { Sidebar } = await import('../js/sidebar.js');
  const orders = [];
  const said = [];
  const fake = {
    playerId: 0,
    state: state ?? { funds: 0, queues: [[], [], [], [], [], []] },
    buildable: new Map(cards.map((c) => [c.id, { itemRoom: c.itemRoom ?? 999, limitLeft: null }])),
    cards: new Map(cards.map((c) => [c.id, { id: c.id, actor: { id: c.id, queue: c.queue ?? INFANTRY }, enabled: true, ready: false, queued: c.head?.count ?? 0, head: c.head }])),
    game: {
      start_production: (p, id, n) => orders.push(['start', id, n]),
      cancel_production: (p, id, n) => orders.push(['cancel', id, n]),
      pause_production: (p, id, on) => orders.push(['pause', id, on]),
    },
    callbacks: { shiftLatched: () => latched, rightClickStyle: () => style, onProductionClick: (id, what) => said.push(what), onCancelPlace() {} },
  };
  fake.onCardClick = Sidebar.prototype.onCardClick.bind(fake);
  fake.onCardCancel = Sidebar.prototype.onCardCancel.bind(fake);
  return { fake, orders, said };
}

test('left clicks queue 1 or 5 with no credits at all, every click an order (nothing dropped)', async () => {
  const { fake, orders, said } = await fakeSidebar([{ id: 'E1' }]);
  for (let i = 0; i < 8; i++) fake.onCardClick('E1', i % 2 === 1);
  assert.deepEqual(orders, Array.from({ length: 8 }, (_, i) => ['start', 'E1', i % 2 ? 5 : 1]), 'no funds check, no cap of 30');
  assert.equal(said[0], 'queued', 'Training, with an empty queue');
  // ItemLimit reached: Building in progress, no order.
  const full = await fakeSidebar([{ id: 'E1', itemRoom: 0 }]);
  full.fake.onCardClick('E1', false);
  assert.deepEqual(full.orders, []);
  assert.deepEqual(full.said, ['limited']);
});

test('right and Shift + right clicks send hold or cancel orders by the style', async () => {
  const building = (count) => ({ count, done: false, paused: false, started: true });
  let s = await fakeSidebar([{ id: 'E1', head: building(7) }]);
  s.fake.onCardCancel('E1');
  s.fake.onCardCancel('E1', { shift: true });
  assert.deepEqual(s.orders, [['pause', 'E1', true], ['pause', 'E1', true]], 'OpenRA: hold first');
  s = await fakeSidebar([{ id: 'E1', head: { ...building(7), paused: true } }]);
  s.fake.onCardCancel('E1', { shift: true });
  s.fake.onCardCancel('E1');
  assert.deepEqual(s.orders, [['cancel', 'E1', 5], ['cancel', 'E1', 1]]);
  assert.deepEqual(s.said, ['cancelled', 'cancelled']);
  s = await fakeSidebar([{ id: 'E1', head: building(7) }], { style: 'webra' });
  s.fake.onCardCancel('E1', { shift: true });
  s.fake.onCardCancel('E1');
  assert.deepEqual(s.orders, [['cancel', 'E1', 5], ['cancel', 'E1', 1]], 'WebRA: the most recently queued first');
  // Touch: the long press with Add on is Shift + right click.
  s = await fakeSidebar([{ id: 'E1', head: { ...building(7), started: false } }], { latched: true });
  s.fake.onCardCancel('E1');
  assert.deepEqual(s.orders, [['cancel', 'E1', 5]]);
  // Middle click cancels at once, Shift five; nothing queued, nothing sent.
  s = await fakeSidebar([{ id: 'E1', head: building(7) }, { id: 'E3' }]);
  s.fake.onCardCancel('E1', { direct: true });
  s.fake.onCardCancel('E1', { direct: true, shift: true });
  s.fake.onCardCancel('E3');
  s.fake.onCardCancel('E3', { direct: true });
  assert.deepEqual(s.orders, [['cancel', 'E1', 1], ['cancel', 'E1', 5]]);
});
