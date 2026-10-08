// In-game notifications (js/notifications.js): merging repeats, the line
// limit, fading, and the text of announcer lines. No DOM needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcementText, FADE_SECONDS, HOLD_SECONDS, MAX_LINES, NotificationQueue } from '../js/notifications.js';
import { EVA } from '../js/audio/catalog.js';

const labels = (q, now) => q.lines(now).map((l) => l.label);

test('announcer lines read like Red Alert: "Unit ready."', () => {
  assert.equal(announcementText('unitReady'), 'Unit ready.');
  assert.equal(announcementText('constructionComplete'), 'Construction complete.');
  assert.equal(announcementText('insufficientFunds'), 'Insufficient funds.');
  assert.equal(announcementText('nope'), null);
  for (const key of Object.keys(EVA)) assert.match(announcementText(key), /^[A-Z].*\.$/, key);
});

test('a repeated line counts up instead of stacking', () => {
  const q = new NotificationQueue();
  q.push('Unit ready.', 0);
  q.push('Unit ready.', 1);
  q.push('Unit ready.', 2);
  assert.deepEqual(labels(q, 2), ['Unit ready. (3)']);
  assert.equal(q.lines(2)[0].count, 3);
});

test('a repeat moves to the newest line and restarts its time', () => {
  const q = new NotificationQueue();
  q.push('Unit ready.', 0);
  q.push('Insufficient funds.', 1);
  q.push('Unit ready.', 3);
  assert.deepEqual(labels(q, 3), ['Insufficient funds.', 'Unit ready. (2)']);
  // The first push was long ago, but the repeat at 3 s keeps it on screen.
  assert.deepEqual(labels(q, 3 + HOLD_SECONDS), ['Unit ready. (2)']);
});

test(`at most ${MAX_LINES} lines, the oldest goes first`, () => {
  const q = new NotificationQueue();
  ['Building.', 'Training.', 'Unit ready.', 'Low power.'].forEach((t, i) => q.push(t, i * 0.1));
  assert.deepEqual(labels(q, 0.5), ['Training.', 'Unit ready.', 'Low power.']);
});

test('lines hold, fade out linearly, then disappear', () => {
  const q = new NotificationQueue();
  q.push('Construction complete.', 10);
  assert.equal(q.lines(10)[0].opacity, 1);
  assert.equal(q.lines(10 + HOLD_SECONDS)[0].opacity, 1);
  const mid = q.lines(10 + HOLD_SECONDS + FADE_SECONDS / 2)[0].opacity;
  assert.ok(Math.abs(mid - 0.5) < 1e-9, `half way through the fade: ${mid}`);
  assert.deepEqual(q.lines(10 + HOLD_SECONDS + FADE_SECONDS), []);
  assert.equal(q.empty, true);
});

test('a line that already faded starts again at one', () => {
  const q = new NotificationQueue({ hold: 1, fade: 1 });
  q.push('Unit lost.', 0);
  q.push('Unit lost.', 5);
  assert.deepEqual(labels(q, 5), ['Unit lost.']);
});

test('ids stay stable while a line counts up, so the view keeps its node', () => {
  const q = new NotificationQueue();
  const a = q.push('Unit ready.', 0);
  const b = q.push('Unit ready.', 0.5);
  assert.equal(a.id, b.id);
  assert.notEqual(q.push('Training.', 0.6).id, a.id);
  q.clear();
  assert.equal(q.empty, true);
});
