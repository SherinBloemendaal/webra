// The guide progress of a settings document (src/guide.js): the summary the
// admin dashboard shows, the reset epoch, and the admin guide actions, whose
// results always pass validateSettingsDocument.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGuideAction,
  GUIDE_ACTIONS,
  GUIDE_EPOCH_KEYS,
  GUIDE_OUTLINE,
  GUIDE_RESET_AT_MAX,
  guideIndex,
  guideSummary,
  guideValues,
  nextGuideEpoch,
  tourPosition,
  validateSettingsDocument,
} from '../src/index.js';

/** A small outline: chapter b first in the tour, a passive and a parallel step. */
const SMALL = Object.freeze({
  version: '0.19.0',
  tourOrder: ['b', 'a'],
  chapters: [
    {
      id: 'a',
      steps: [
        { id: 'a.one', since: '0.17.0', after: [], parallel: false, passive: false, outside: false },
        { id: 'a.low', since: '0.17.0', after: ['a.one'], parallel: false, passive: true, outside: false },
        { id: 'a.two', since: '0.19.0', after: ['a.low'], parallel: false, passive: false, outside: false },
        { id: 'a.side', since: '0.19.0', after: ['a.one'], parallel: true, passive: false, outside: false },
      ],
    },
    { id: 'b', steps: [{ id: 'b.one', since: '0.17.0', after: [], parallel: false, passive: false, outside: false }, { id: 'b.net', since: '0.17.0', after: ['b.one'], parallel: false, passive: false, outside: true }] },
  ],
});

test('index: steps in guide order, the counted steps in tour order', () => {
  const ix = guideIndex(SMALL);
  assert.deepEqual(ix.stepIds, ['a.one', 'a.low', 'a.two', 'a.side', 'b.one', 'b.net']);
  assert.deepEqual(ix.tourIds, ['b.one', 'a.one', 'a.two', 'a.side']);
  assert.equal(guideIndex(SMALL), ix, 'indexed once');
  // The real guide: 32 steps, 26 of them in the tour.
  assert.deepEqual([guideIndex().stepIds.length, guideIndex().tourIds.length], [32, 26]);
  assert.equal(GUIDE_OUTLINE.chapters[0].steps[0].id, 'base.mcv');
});

test('summary: steps done, the tour state, chapter and step, defaults for what the document leaves out', () => {
  const none = guideSummary(undefined, SMALL);
  assert.deepEqual(none.steps, { done: 0, total: 6 });
  assert.deepEqual(none.tour, { done: 0, total: 4, state: 'running', chapter: 'b', chapterIndex: 0, chapters: 2, step: 'b.one' });
  assert.deepEqual([none.tourInGames, none.quickTipsAsked, none.seen, none.resetAt], [true, false, null, null]);
  // Only true counts; unknown ids do not count.
  const s = guideSummary({ done: { 'b.one': true, 'a.one': true, 'a.side': false, gone: true }, seen: '0.18.0', resetAt: 12 }, SMALL);
  assert.deepEqual(s.steps, { done: 2, total: 6 });
  assert.equal(s.tour.chapter, 'a');
  // a.two waits for a.low, a passive step that does not hold the tour up while open: its turn too.
  assert.equal(s.tour.step, 'a.two');
  assert.deepEqual([s.seen, s.resetAt], ['0.18.0', 12]);
  // The parallel step shows when it is the only open one.
  assert.equal(tourPosition(new Set(['b.one', 'a.one', 'a.two']), SMALL).step, 'a.side');
  assert.deepEqual(tourPosition(new Set(['b.one', 'a.one', 'a.two', 'a.side']), SMALL), { chapter: null, step: null });
  const all = { 'b.one': true, 'a.one': true, 'a.two': true, 'a.side': true };
  assert.equal(guideSummary({ done: all }, SMALL).tour.state, 'finale');
  assert.equal(guideSummary({ done: all, quickTipsAsked: true }, SMALL).tour.state, 'finished');
  assert.equal(guideSummary({ done: all, tourInGames: false }, SMALL).tour.state, 'finished');
  assert.equal(guideSummary({ done: {}, tourInGames: false }, SMALL).tour.state, 'off');
  assert.deepEqual(guideValues({ done: [], resetAt: -3, seen: 4 }), { done: new Set(), tourInGames: true, quickTipsAsked: false, seen: null, resetAt: 0 });
});

test('reset epoch: now, but always after the current one, within the setting', () => {
  assert.equal(nextGuideEpoch(0, 1000), 1000);
  assert.equal(nextGuideEpoch(undefined, 1000.7), 1000);
  assert.equal(nextGuideEpoch(5000, 1000), 5001, 'a clock behind the last reset still moves on');
  assert.equal(nextGuideEpoch(GUIDE_RESET_AT_MAX, 1), GUIDE_RESET_AT_MAX);
  assert.deepEqual(GUIDE_EPOCH_KEYS, ['done', 'tourInGames', 'quickTipsAsked']);
});

test('actions: reset, restart the tour, complete; other guide settings kept; the result is a valid document', () => {
  const guide = { done: { 'b.one': true, 'a.one': true, 'a.low': true, 'b.net': true, old: true }, tourInGames: false, quickTipsAsked: true, seen: '0.18.0', lastTip: 3, resetAt: 50 };
  const reset = applyGuideAction(guide, 'reset', 100, SMALL);
  assert.deepEqual(reset, { done: {}, tourInGames: true, quickTipsAsked: false, seen: '0.18.0', lastTip: 3, resetAt: 100 });
  const restart = applyGuideAction(guide, 'restartTour', 10, SMALL);
  assert.deepEqual(restart.done, { 'a.low': true, 'b.net': true, old: true }, 'passive and outside steps keep their ticks');
  assert.equal(restart.tourInGames, true);
  assert.equal(restart.quickTipsAsked, true);
  assert.equal(restart.resetAt, 50, 'restarting the tour keeps the epoch: the set merge carries it');
  const complete = applyGuideAction(guide, 'complete', 200, SMALL);
  assert.deepEqual(Object.keys(complete.done).sort(), ['a.low', 'a.one', 'a.side', 'a.two', 'b.net', 'b.one', 'old']);
  assert.equal(complete.quickTipsAsked, true);
  assert.equal(complete.tourInGames, false, 'the switch stays as it was');
  assert.equal(guideSummary(complete, SMALL).tour.state, 'finished');
  assert.deepEqual(applyGuideAction(undefined, 'reset', 7, SMALL), { done: {}, tourInGames: true, quickTipsAsked: false, resetAt: 7 });
  assert.throws(() => applyGuideAction(guide, 'wipe', 1, SMALL), /unknown guide action/);
  assert.deepEqual(GUIDE_ACTIONS, ['complete', 'reset', 'restartTour']);
  // With the real guide every action passes the server's validation.
  for (const action of GUIDE_ACTIONS) {
    const doc = { schema: 1, guide: applyGuideAction({ done: { 'base.mcv': true }, seen: '0.19.0' }, action, 1_760_000_000_000) };
    assert.deepEqual(validateSettingsDocument(doc), doc, action);
  }
});

test('validation: guide.resetAt is a whole number from 0 to the last valid date', () => {
  assert.equal(validateSettingsDocument({ guide: { resetAt: 0 } }).guide.resetAt, 0);
  assert.equal(validateSettingsDocument({ guide: { resetAt: GUIDE_RESET_AT_MAX } }).guide.resetAt, GUIDE_RESET_AT_MAX);
  for (const bad of [-1, 1.5, GUIDE_RESET_AT_MAX + 1, '5', null, true]) assert.throws(() => validateSettingsDocument({ guide: { resetAt: bad } }), (e) => e.field === 'settings.guide.resetAt', String(bad));
});
