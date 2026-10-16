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
      // The first queued item of a type is the one OpenRA pauses and resumes.
      else perId.set(it.id, { count: 1, progress: it.progress, done: it.done, paused: !!it.paused, started: !!it.started });
    }
  }
  return { perId, activity, ready };
}

/**
 * What a left click on a card does: place the finished structure, or queue
 * one more (five with shift). Structures queue like units: the first one is
 * built and waits for placement, the ones behind it start once it is placed.
 * Money plays no part: items queue without credits and wait for them.
 *
 * @returns {{place: true} | {place: false, count: number} | null} null when the card is disabled
 */
export function clickAction({ queue, enabled, ready }, shift) {
  if (enabled === false) return null;
  if (isStructureQueue(queue) && ready) return { place: true };
  return { place: false, count: shift ? SHIFT_COUNT : 1 };
}

/**
 * Items of one actor type a production queue holds at most: OpenRA
 * ProductionQueueInfo ItemLimit (engine/src/production.rs ITEM_LIMIT). The
 * whole queue holds at most QUEUE_CAP (WebRA's cap; OpenRA's QueueLimit is 0).
 */
export const ITEM_LIMIT = 999;
export const QUEUE_CAP = 2000;

/**
 * What OpenRA's ProductionQueue.CanQueue says about one more item: 'queued'
 * (QueuedAudio), 'limited' (LimitedAudio: ItemLimit or QUEUE_CAP reached) or
 * 'blocked' (BlockedAudio: its Buildable.BuildLimit is reached). Credits never matter.
 * @param {{ itemRoom?: number | null, limitLeft?: number | null }} o player_json buildable `itemRoom` and `limitLeft` (null: no limit)
 */
export function queueOutcome({ itemRoom = null, limitLeft = null }) {
  if (itemRoom !== null && itemRoom !== undefined && itemRoom <= 0) return 'limited';
  if (limitLeft !== null && limitLeft !== undefined && limitLeft <= 0) return 'blocked';
  return 'queued';
}

/** The "Right click in the build menu" setting (settings.js `buildRightClick`). */
export const RIGHT_CLICK_STYLES = Object.freeze(['openra', 'webra']);

/**
 * What a right click on a card does, by the player's style (`buildRightClick`):
 * `{ kind: 'pause' }`, `{ kind: 'cancel', count }` (the engine cancels the
 * last `count` queued items of the type, the most recently queued first) or
 * null with nothing queued. `many` is the click's count: 1, or 5 with Shift.
 *
 * - 'openra' (OpenRA ProductionPaletteWidget HandleRightClick): the first
 *   queued item of the type is put on hold while it is being built; when it
 *   is on hold, finished or not started (nothing paid yet) `many` are
 *   cancelled. The item on hold stays until it is the last one left.
 * - 'webra' (a stack): the item being built lies at the bottom and every
 *   item queued after it on top; a right click takes from the top, so the
 *   most recently queued items go first, never the one being built while
 *   others are queued. Once only that one is left it goes on hold, then is
 *   cancelled. With nothing paid yet (or on hold, or finished) it is the
 *   same as 'openra'.
 * @param {{ count: number, done: boolean, paused: boolean, started: boolean } | undefined} head perId summary of the card
 * @param {{ style?: string, many?: number }} [o]
 */
export function rightClickAction(head, { style = 'openra', many = 1 } = {}) {
  if (!head || !head.count) return null;
  const building = head.started && !head.paused && !head.done;
  if (!building) return { kind: 'cancel', count: many };
  if (style === 'webra' && head.count > 1) return { kind: 'cancel', count: Math.min(many, head.count - 1) };
  return { kind: 'pause' };
}

/**
 * Whether cancelling `count` items of a card ends placement mode. The engine
 * cancels the last queued items of that type, so the finished structure only
 * goes away when no more than `count` are queued.
 */
export function cancelEndsPlacement({ queue, ready, queued }, count = 1) {
  return isStructureQueue(queue) && !!ready && queued <= count;
}

/**
 * Which queued items the credits do not cover yet, per actor id: walking
 * each queue from its head, what is still to pay for an item and all items
 * ahead of it in its queue (cost minus `paid`; finished ones are paid) is
 * more than `funds`. Production takes the money as it goes, so these wait
 * for credits (OpenRA: production pauses while the money is short). Each
 * queue is counted on its own; the queues draw on the same credits.
 * @param {Array<Array<{id: string, done: boolean, paid?: number}>>} queues player_json().queues
 * @param {number} funds credits (cash and stored ore)
 * @param {(id: string) => number} costOf the actor's cost
 * @returns {Map<string, number>} id -> how many of its queued items are short
 */
export function shortOfFunds(queues, funds, costOf) {
  const short = new Map();
  for (const items of queues) {
    let due = 0;
    for (const it of items) {
      if (it.done) continue;
      due += Math.max(0, (costOf(it.id) || 0) - (it.paid ?? 0));
      if (due > funds) short.set(it.id, (short.get(it.id) ?? 0) + 1);
    }
  }
  return short;
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

/** Game ticks of progress history used to estimate the remaining build time. */
export const ETA_WINDOW_TICKS = 50;

/**
 * Remaining build time of the item at the head of a queue, estimated from how
 * fast its progress actually moves (player_json() has progress, not ticks), so
 * low power slowing production shows up in the clock. While production stalls
 * (no money) the clock stands still, and the rate is measured afresh once it
 * moves again. Measured in game ticks, so pausing the game does not skew it.
 */
export class BuildEta {
  constructor(windowTicks = ETA_WINDOW_TICKS) {
    this.windowTicks = windowTicks;
    this.samples = []; // { tick, progress }, oldest first
    this.last = null; // last estimate in ticks, kept while production stalls
  }

  reset() {
    this.samples = [];
    this.last = null;
  }

  /**
   * Record the progress (0..1) at game tick `tick`.
   * @returns {number | null} estimated ticks left, or null while unknown
   */
  observe(progress, tick) {
    const prev = this.samples[this.samples.length - 1];
    // A new item started (progress went back) or time went back: start over.
    if (prev && (progress < prev.progress - 1e-6 || tick < prev.tick)) this.reset();
    const head = this.samples[this.samples.length - 1];
    if (head && head.tick === tick) {
      head.progress = progress;
    } else if (head && progress <= head.progress) {
      // Stalled: keep the clock, and measure from here once it moves again.
      this.samples = [{ tick, progress }];
      return this.last;
    } else {
      this.samples.push({ tick, progress });
    }
    while (this.samples.length > 2 && tick - this.samples[1].tick >= this.windowTicks) this.samples.shift();
    if (progress >= 1) {
      this.last = 0;
      return 0;
    }
    const first = this.samples[0];
    const dt = tick - first.tick;
    const dp = progress - first.progress;
    // (The epsilon keeps float noise from rounding a whole tick up.)
    if (dt > 0 && dp > 0) this.last = Math.ceil(((1 - progress) * dt) / dp - 1e-6);
    return this.last;
  }
}

/** Clock text like the 1996 sidebar: "mm:ss", or "h:mm:ss" from an hour on. */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${ss}`;
}

/** Power with a sign for gains ("+100", "-40"). */
export function formatPower(power) {
  return power > 0 ? `+${power}` : String(power);
}

/**
 * The production tooltip of a sidebar cameo (OpenRA ProductionTooltipLogic,
 * mods/common/chrome/tooltips.yaml PRODUCTION_TOOLTIP): the name and its
 * hotkey, what is still missing, cost, build time and power in a column, the
 * description, and how the mouse works on it; with the quick tips on, a line
 * under the name on what it does (js/quicktips.js) instead of the description. Cost turns red when the player
 * cannot afford it, the time red while low power slows production, the power
 * red when building it would overload the grid, like OpenRA.
 * @param {{ name: string, description?: string, cost: number, power?: number, kind?: string, queue: number }} actor rules_json actor
 * @param {{ enabled?: boolean, requires?: string[], exclusive?: string | null, buildTicks?: number } | undefined} item player_json `buildable` entry
 * @param {{ funds?: number, cash?: number, resources?: number, powerGenerated?: number, powerUsed?: number, lowPower?: boolean } | null} state player_json
 * @param {{ hotkey?: string | null, ticksPerSecond?: number, lowPowerModifier?: number, short?: number, rightClickStyle?: string, tip?: string | null }} [o]
 *   short: queued items the credits do not cover yet (`shortOfFunds`); rightClickStyle: the `buildRightClick` setting;
 *   tip: the quick tip (js/quicktips.js `quickTip`), null while the `quickTips` setting is off
 */
export function productionTip(actor, item, state, { hotkey = null, ticksPerSecond = 25, lowPowerModifier = 100, short = 0, rightClickStyle = 'openra', tip = null } = {}) {
  const stats = [];
  const funds = state ? (state.funds ?? (state.cash ?? 0) + (state.resources ?? 0)) : Infinity;
  stats.push({ kind: 'cost', label: 'cost', text: `$${actor.cost}`, bad: funds < actor.cost });
  if (item && Number.isFinite(item.buildTicks)) {
    const slow = !!state?.lowPower && lowPowerModifier > 100;
    const ticks = slow ? (item.buildTicks * lowPowerModifier) / 100 : item.buildTicks;
    stats.push({ kind: 'time', label: 'build time', text: formatClock(ticks / ticksPerSecond), bad: slow });
  }
  const power = actor.power ?? 0;
  if (power !== 0) {
    const spare = (state?.powerGenerated ?? 0) - (state?.powerUsed ?? 0);
    stats.push({ kind: 'power', label: 'power', text: formatPower(power), bad: power < 0 && spare < -power });
  }
  let requires = '';
  if (item && item.enabled === false) {
    if (item.exclusive) requires = item.exclusive;
    else if (item.requires?.length) requires = `Requires ${item.requires.join(', ')}`;
    else if (actor.buildLimit > 0) requires = `Only ${actor.buildLimit} at a time`;
    else requires = 'Unavailable';
  }
  const right = rightClickStyle === 'webra' ? 'Right click: remove the last queued, then hold and cancel the one being built' : 'Right click: hold, then cancel';
  const hint = isStructureQueue(actor.queue)
    ? `Left click: build, then place. ${right}. Shift: ${SHIFT_COUNT} at a time. Middle click: cancel.`
    : `Left click: build. ${right}. Shift: ${SHIFT_COUNT} at a time. Middle click: cancel.`;
  const notes = [];
  if (short > 0) notes.push({ text: `Not enough credits yet for ${short === 1 ? '1 queued item' : `${short} queued items`}: production waits until the money comes in.`, tone: 'warn' });
  notes.push({ text: hint, tone: 'hint' });
  // Never both: the quick tip stands in for OpenRA's description while the setting is on.
  return { title: actor.name, hotkey, requires, tip: tip || '', stats, desc: tip ? '' : actor.description || '', notes };
}
