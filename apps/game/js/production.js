// Production queue logic of the sidebar (no DOM, so it is unit tested in
// apps/game/tests/production.test.mjs). The engine decides what is built
// (engine/src/production.rs); this only turns player_json() into card state
// and clicks into orders.

/** Buildings and Defense hold structures, which are placed on the map when finished. */
export const isStructureQueue = (q) => q === 0 || q === 1;

/** Items a shift click (or Shift + numpad) queues. */
export const SHIFT_COUNT = 5;

/**
 * Per actor id: how many are queued and the state of the first one (its
 * progress, and whether it is finished and waiting for placement). Per queue:
 * the number of items and whether one is ready.
 *
 * @param {Array<Array<{id: string, progress: number, done: boolean}>>} queues player_json().queues
 */
export function summarizeQueues(queues) {
  const perId = new Map();
  const activity = queues.map((items) => items.length);
  const ready = queues.map((items) => items.some((it) => it.done));
  for (const items of queues) {
    for (const it of items) {
      const s = perId.get(it.id);
      if (s) s.count += 1;
      else perId.set(it.id, { count: 1, progress: it.progress, done: it.done });
    }
  }
  return { perId, activity, ready };
}

/**
 * What a left click on a card does: place the finished structure, or queue
 * one more (five with shift). Structures queue like units: the first one is
 * built and waits for placement, the ones behind it start once it is placed.
 *
 * @returns {{place: true} | {place: false, count: number} | null} null when the card is disabled
 */
export function clickAction({ queue, enabled, ready }, shift) {
  if (enabled === false) return null;
  if (isStructureQueue(queue) && ready) return { place: true };
  return { place: false, count: shift ? SHIFT_COUNT : 1 };
}

/**
 * Whether a right click on a card ends placement mode. The engine cancels the
 * last queued item of that type, so the finished structure only goes away
 * when it is the only one queued.
 */
export function cancelEndsPlacement({ queue, ready, queued }) {
  return isStructureQueue(queue) && !!ready && queued <= 1;
}

/**
 * Whether placement mode for `placingId` has nothing left to place: the
 * finished structure was cancelled (its prerequisites or the Construction
 * Yard were lost, or it was cancelled elsewhere).
 */
export function placementLost(perId, placingId) {
  if (!placingId) return false;
  const s = perId.get(placingId);
  return !s || !s.done;
}
