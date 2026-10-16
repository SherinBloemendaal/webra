// A player's guide progress as the settings document stores it (the guide.*
// section, docs/accounts-api.md 5.8) read against the guide's structure
// (guide-outline.js, generated from the game's help.js GUIDE): how many steps
// are done, where the tour is, and the admin guide actions (complete, reset,
// restart the tour, docs/accounts-api.md 8.11). The game's own progress is
// apps/game/js/guide.js GuideProgress; this module follows the same rules
// (tests compare the two) without any game code, so the server can use it.
//
// The reset epoch (guide.resetAt, Unix milliseconds, 0: never reset): a
// reset of the whole progress (the player's, or an admin's reset or
// complete) sets it to a newer value. Restarting the tour does not: the
// set merge already removes the tour's steps where a device has a base, and
// a newer epoch would drop the passive and outside steps other devices
// ticked meanwhile.
// The settings sync (apps/game/js/account/sync.js) normally merges guide.done
// as a set, so a step done on any device stays done; when two sides have
// different epochs, the side with the newer one gives done, tourInGames and
// quickTipsAsked as they are, so steps a device still has from before the
// reset do not come back.

import { GUIDE_OUTLINE } from './guide-outline.js';

export { GUIDE_OUTLINE };

/** guide.resetAt: Unix milliseconds of the last reset of the guide progress, at most the last valid Date. */
export const GUIDE_RESET_AT_MAX = 8.64e15;

/** The guide settings that the side with the newer reset epoch gives whole in a merge. */
export const GUIDE_EPOCH_KEYS = Object.freeze(['done', 'tourInGames', 'quickTipsAsked']);

/** The admin guide actions (POST /api/admin/users/:id/guide). */
export const GUIDE_ACTIONS = Object.freeze(['complete', 'reset', 'restartTour']);

/**
 * Where the tour is: `running` (the switch is on, a tour step is open),
 * `finale` (every tour step done, the last card with the quick tips question
 * has not shown yet), `finished`, `off` (skipped or switched off before the
 * end).
 */
export const GUIDE_TOUR_STATES = Object.freeze(['running', 'finale', 'finished', 'off']);

/** The admin users list filter on guide progress: no step done, some, every step. */
export const GUIDE_PROGRESS_FILTERS = Object.freeze(['none', 'started', 'done']);

/** Whether the tour counts a step: not one that only happens to the player (passive) or outside a skirmish (outside). */
const counted = (s) => !s.passive && !s.outside;

const indexes = new WeakMap();

/**
 * An outline indexed: `steps` (id -> step with its chapter id), `stepIds` in
 * guide order, `tourChapters` (chapters in tour order) and `tourIds` (the
 * counted steps in tour order).
 */
export function guideIndex(outline = GUIDE_OUTLINE) {
  let ix = indexes.get(outline);
  if (ix) return ix;
  const steps = new Map();
  for (const c of outline.chapters) for (const s of c.steps) steps.set(s.id, { ...s, chapter: c.id });
  const rank = (c) => {
    const i = outline.tourOrder.indexOf(c.id);
    return i < 0 ? outline.tourOrder.length + outline.chapters.indexOf(c) : i;
  };
  const tourChapters = [...outline.chapters].sort((a, b) => rank(a) - rank(b));
  ix = Object.freeze({
    steps,
    stepIds: Object.freeze([...steps.keys()]),
    tourChapters: Object.freeze(tourChapters),
    tourIds: Object.freeze(tourChapters.flatMap((c) => c.steps.filter(counted).map((s) => s.id))),
  });
  indexes.set(outline, ix);
  return ix;
}

/** The step ids marked done in a stored guide.done (only `true` counts). */
function doneSet(done) {
  const out = new Set();
  if (done && typeof done === 'object' && !Array.isArray(done)) for (const [k, v] of Object.entries(done)) if (v === true) out.add(k);
  return out;
}

/**
 * The guide section with the registry's defaults for what it leaves out
 * (apps/game/js/registry.js GROUPS.guide): the tour switch on, the quick tips
 * question not asked, nothing seen, never reset.
 */
export function guideValues(guide) {
  const g = guide && typeof guide === 'object' ? guide : {};
  return {
    done: doneSet(g.done),
    tourInGames: g.tourInGames !== false,
    quickTipsAsked: g.quickTipsAsked === true,
    seen: typeof g.seen === 'string' ? g.seen : null,
    resetAt: Number.isSafeInteger(g.resetAt) && g.resetAt > 0 ? g.resetAt : 0,
  };
}

/**
 * Where the tour is for a set of done steps, as GuideProgress tourChapter and
 * tourStep see it outside a game: the first chapter in tour order with a
 * counted step open, and its first open step whose turn it is (one the steps
 * before it allow; a parallel step when no other is open). Nulls when the
 * tour is done.
 */
export function tourPosition(done, outline = GUIDE_OUTLINE) {
  const ix = guideIndex(outline);
  const passed = (id) => {
    if (done.has(id)) return true;
    const s = ix.steps.get(id);
    return !!s && !counted(s) && reachable(id);
  };
  const reachable = (id) => (ix.steps.get(id)?.after ?? []).every(passed);
  const chapter = ix.tourChapters.find((c) => c.steps.some((s) => counted(s) && !done.has(s.id))) ?? null;
  if (!chapter) return { chapter: null, step: null };
  const open = chapter.steps.filter((s) => counted(s) && !done.has(s.id) && reachable(s.id));
  const step = open.find((s) => !s.parallel) ?? open[0] ?? null;
  return { chapter: chapter.id, step: step?.id ?? null };
}

/**
 * A player's guide progress from the guide section of their settings
 * document: steps done of the whole guide and of the tour, the tour's state,
 * chapter (its place in the tour order too) and step, the quick tips
 * question, the newest content seen and the last reset.
 */
export function guideSummary(guide, outline = GUIDE_OUTLINE) {
  const ix = guideIndex(outline);
  const v = guideValues(guide);
  const stepsDone = ix.stepIds.filter((id) => v.done.has(id)).length;
  const tourDone = ix.tourIds.filter((id) => v.done.has(id)).length;
  const complete = tourDone === ix.tourIds.length;
  const state = complete ? (v.tourInGames && !v.quickTipsAsked ? 'finale' : 'finished') : v.tourInGames ? 'running' : 'off';
  const { chapter, step } = tourPosition(v.done, outline);
  return {
    steps: { done: stepsDone, total: ix.stepIds.length },
    tour: {
      done: tourDone,
      total: ix.tourIds.length,
      state,
      chapter,
      chapterIndex: chapter ? ix.tourChapters.findIndex((c) => c.id === chapter) : null,
      chapters: ix.tourChapters.length,
      step,
    },
    tourInGames: v.tourInGames,
    quickTipsAsked: v.quickTipsAsked,
    seen: v.seen,
    resetAt: v.resetAt || null,
    version: outline.version,
  };
}

/** A new reset epoch: now, but always after the current one (clocks of devices and the server differ). */
export function nextGuideEpoch(current, now) {
  const base = Number.isSafeInteger(current) && current > 0 ? current : 0;
  return Math.min(GUIDE_RESET_AT_MAX, Math.max(Math.floor(now), base + 1));
}

/**
 * The guide section after an action, other guide settings kept:
 * - `reset`: no step done, the tour switch on, the quick tips question to ask
 *   again (the player starts over as a new player; guide.seen stays, so no
 *   step shows as "New" that the player has already seen);
 * - `restartTour`: the tour's steps start over (passive and outside steps keep
 *   their ticks), the switch on: Take the tour again of the Guide page. The
 *   epoch stays: the sync's set merge removes the tour's steps on the other
 *   devices and keeps the steps they ticked meanwhile;
 * - `complete`: every step done and the quick tips question counted as asked,
 *   so no tour card shows at all; the switch stays as it is (finishing the
 *   tour never changes it either, so tour steps a later version adds show
 *   while it is on).
 * `reset` and `complete` set a newer reset epoch (`now`).
 */
export function applyGuideAction(guide, action, now, outline = GUIDE_OUTLINE) {
  const ix = guideIndex(outline);
  const g = guide && typeof guide === 'object' ? { ...guide } : {};
  const resetAt = nextGuideEpoch(g.resetAt, now);
  const kept = {};
  for (const id of doneSet(g.done)) kept[id] = true;
  switch (action) {
    case 'reset':
      return { ...g, done: {}, tourInGames: true, quickTipsAsked: false, resetAt };
    case 'restartTour': {
      for (const id of ix.tourIds) delete kept[id];
      return { ...g, done: kept, tourInGames: true };
    }
    case 'complete': {
      for (const id of ix.stepIds) kept[id] = true;
      return { ...g, done: kept, quickTipsAsked: true, resetAt };
    }
    default:
      throw new Error(`unknown guide action ${action}`);
  }
}
